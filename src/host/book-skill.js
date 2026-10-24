/**
 * 「把一本书变成一个 skill」——**纯函数**：输入是已经落盘的解读产物，输出是一整套文件。
 *
 * ★ 这个文件不碰磁盘、不碰 `ctx`、不调模型。理由与 `segment.js` / `digest-prompt.js`
 *   一样：这里最容易坏的地方是「拼出来的东西对不对」，而它**没法靠看一遍发现**
 *   （SKILL.md 少一章索引、术语表漏掉半本书，肉眼看都像正常的文档）。
 *   抽成纯函数之后，每一条都能被断言钉住，而且**同一份输入永远产出同一份输出**。
 *
 * ── 为什么「导出」不重新调用模型 ────────────────────────────────────────────
 *
 *   用户已经为 N 章解读付过钱了。导出只是把落盘的 `{summary, points, terms}`
 *   重新组织成 agent 能按需加载的形状 —— 再调一次模型只会**多花一次钱**，
 *   还引入新的幻觉面（同一个模型重写一遍，谁知道它会漏掉哪一章）。
 *
 *   所以：`SKILL.md` / `chapters/*.md` / `glossary.md` 全部**确定性拼装**。
 *   唯一需要模型的是**跨章综合**（`patterns.md` / `cheatsheet.md` 里那种
 *   「作者的手法」「故事逻辑」），那是可选的一步、由调用方显式开启、
 *   并且**在产物里写明这一份是综合出来的还是原样摘的** —— 见 `synthesized`。
 *
 * ── 为什么对齐 book-to-skill 的产物形状 ─────────────────────────────────────
 *
 *   它的核心不是「摘要」，是 **"Structure, not a summary"** 与 **按需加载**：
 *   一个始终在上下文里的索引（`SKILL.md`），加上一批「问到才读」的章节文件。
 *   这套形状的好处是**查询成本与答案成正比**，而不是每次都把整本书塞进去。
 *   我们的解读产物本来就是「一章一个文件」，天然就是那个形状 —— 只是缺索引层
 *   与横向汇总（术语表）。
 */

/** 书型。`auto` 只出现在入参，产物里一定是这三者之一。 */
export const SKILL_PROFILES = Object.freeze(['technical', 'fiction', 'nonfiction']);

export const PROFILE_LABEL = Object.freeze({
  technical: '技术书 / 工具书',
  fiction: '小说 / 叙事',
  nonfiction: '非虚构 / 论述',
});

/**
 * 每个书型的横向两页（`patterns.md` / `cheatsheet.md`）分别该装什么。
 *
 * ★ 文件名**固定**，内容按书型换。理由是 `SKILL.md` 里要引用这两个文件名 ——
 *   文件名跟着书型变，索引层就得跟着分支，而分支正是「索引指向一个不存在的文件」
 *   这种坏法的来源。
 * ★ 用户 2026-10-23 的原话：「小说可以沉淀作者的写作风格，故事逻辑等等」。
 *   所以 fiction 那一栏不是「没有」，而是**换了一套该问的问题**：
 *   叙述视角、句式节奏、母题、人物关系、时间线 —— 这些恰恰是纯逐章摘要里
 *   看不出来、必须跨章才成立的东西。
 */
export const PROFILE_SLOTS = Object.freeze({
  technical: {
    patterns: '跨章的技术、模式与反模式',
    cheatsheet: '决策表与速查规则',
    patternsHints: ['反复出现的方法/架构', '作者推荐的写法与反对的写法', '被多处引用的权衡'],
    cheatsheetHints: ['选型决策表', '参数与默认值', '常见坑'],
  },
  fiction: {
    patterns: '作者的写法与叙事手法',
    cheatsheet: '人物、地点与时间线速查',
    patternsHints: ['叙述视角与人称', '句式节奏与意象密度', '反复出现的母题与物件', '伏笔与回收'],
    cheatsheetHints: ['人物及其关系', '地点', '事件时间线'],
  },
  nonfiction: {
    patterns: '论点结构与论证手法',
    cheatsheet: '关键概念与结论速查',
    patternsHints: ['全书的核心主张', '各章如何支撑主张', '作者承认的反例与边界'],
    cheatsheetHints: ['关键概念一句话定义', '可引用的结论', '数据与出处'],
  },
});

/**
 * 代码特征。命中**每千字**的次数超过 `CODE_DENSITY` 就判技术书。
 *
 * ★ 用「每千字次数」而不是「有没有出现过」：一本小说里出现一次 `function`
 *   是可能的（人物在讨论电脑），而技术书里它是**成片**出现的。
 */
const CODE_HINTS = [
  /\bdef\s+[A-Za-z_]\w*\s*\(/g,
  /\bfunction\s+[A-Za-z_$]?\w*\s*\(/g,
  /=>/g,
  /\b(?:const|let|var)\s+[A-Za-z_$]\w*\s*=/g,
  /\bSELECT\b[\s\S]{0,60}\bFROM\b/gi,
  /\bimport\s+[\w{*]/g,
  /^\s{2,}(?:if|for|while|return)\b/gm,
];

/** 对话特征：成对引号。中文小说用「」，英文小说用 “”。 */
const DIALOGUE_HINTS = [/「/g, /」/g, /“/g, /”/g, /"/g];

/** 判技术书的阈值：每千字 ≥ 6 处代码特征。 */
export const CODE_DENSITY = 6;
/** 判小说的阈值：每千字 ≥ 8 个引号（约 4 对对话）。 */
export const DIALOGUE_DENSITY = 8;

/**
 * 按正文猜书型。
 *
 * ★ 这只是**默认值**，不是判决：`SKILL.md` 里会把「凭什么这么判」原样写出来
 *   （`reason`），用户看到「按对话密度判定」才知道该不该改。
 *   悄悄猜错、又不说明依据，用户只会觉得这个 skill 内容跑偏了却说不出为什么。
 *
 * @param chapters - `[{ title, text }]`，取前若干章即可（整本读一遍没必要）。
 * @returns {{profile: string, reason: string, codeDensity: number, dialogueDensity: number}}
 */
export function detectProfile(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  // 只看前 5 章、每章最多 6000 字：足够定性，又不至于为了分类把整本书读一遍。
  const sample = list.slice(0, 5).map(chapter => String(chapter?.text ?? '').slice(0, 6000));
  const text = sample.join('\n');
  const chars = text.replace(/\s+/g, '').length;
  if (chars === 0) {
    return {
      profile: 'nonfiction',
      reason: '没有可用的正文样本，按「非虚构」导出（可在调用时显式指定 profile）',
      codeDensity: 0,
      dialogueDensity: 0,
    };
  }
  let code = 0;
  for (const pattern of CODE_HINTS) {
    code += (text.match(pattern) ?? []).length;
  }
  let dialogue = 0;
  for (const pattern of DIALOGUE_HINTS) {
    dialogue += (text.match(pattern) ?? []).length;
  }
  const per1000 = value => Math.round((value / chars) * 1000 * 10) / 10;
  const codeDensity = per1000(code);
  const dialogueDensity = per1000(dialogue);

  if (codeDensity >= CODE_DENSITY) {
    return {
      profile: 'technical',
      reason: `每千字 ${codeDensity} 处代码特征（阈值 ${CODE_DENSITY}）`,
      codeDensity,
      dialogueDensity,
    };
  }
  if (dialogueDensity >= DIALOGUE_DENSITY) {
    return {
      profile: 'fiction',
      reason: `每千字 ${dialogueDensity} 个引号（阈值 ${DIALOGUE_DENSITY}）`,
      codeDensity,
      dialogueDensity,
    };
  }
  return {
    profile: 'nonfiction',
    reason: `代码 ${codeDensity} / 引号 ${dialogueDensity}（均低于阈值 ${CODE_DENSITY} / ${DIALOGUE_DENSITY}）`,
    codeDensity,
    dialogueDensity,
  };
}

/**
 * 目录名。**只允许 ASCII 小写、数字、连字符**。
 *
 * ★ 中文标题不做音译、不做拼音：拼错了比不拼更糟（用户会按拼音去找，然后找不到）。
 *   中文标题一律回退成 `book-<bookId>` —— id 是稳定的、唯一的、不会撞。
 * ★ 这不是美观问题：这个字符串会变成**磁盘上的目录名**，也出现在 `SKILL.md` 的
 *   frontmatter 里。带空格或引号的标题会直接把 frontmatter 与路径搞坏。
 */
export function skillSlug({ title, bookId }) {
  const ascii = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // 至少要有 3 个字母才当 slug 用（`1-2`、`-` 这种没意义）。
  if (ascii.replace(/-/g, '').length >= 3) return ascii;
  return `book-${String(bookId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
}

/**
 * 目录名的**唯一实现**：写（导出）与读（状态查询）都必须走这里。
 *
 * ★ 这条规则原来写了两遍 —— 导出用 `book.title ?? meta.bookTitle`，状态查询只用
 *   `meta.bookTitle`。书还在书架上时两者一样，所以平时看不出问题；一旦用户重新
 *   生成过书单、书名变了，导出会写到 A 目录、状态查询去 B 目录找 ⇒ **导出成功、
 *   徽章永远不出现，而两边都不报错**。
 * ★ 兜底优先级：`book` 上的实时数据 > `meta` 里的快照 > 调用方直接给的 `bookId`。
 *   之所以还留 `bookId` 这一档，是因为状态查询在「书已经不在书架上」时只能拿到 id。
 */
export function skillSlugFor({ book, meta, bookId } = {}) {
  return skillSlug({
    title: book?.title ?? meta?.bookTitle ?? '',
    bookId: book?.id ?? meta?.bookId ?? bookId,
  });
}

/** 一句话：把 summary 压成索引行里能放下的一行。 */
function firstSentence(text, limit = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  // 中文句号、问号、叹号、英文句号都算断句点。
  const match = /^[^。！？.!?]{1,200}[。！？.!?]/.exec(flat);
  const sentence = match === null ? flat : match[0];
  const trimmed = sentence.length > limit ? `${sentence.slice(0, limit)}…` : sentence;
  return trimmed;
}

/** YAML frontmatter 里的字符串：双引号包起来，内部双引号与反斜杠转义。 */
function yamlString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 页码区间的人话。 */
function pagesOf(chapter) {
  const start = chapter?.startPage;
  const end = chapter?.endPage;
  if (!Number.isInteger(start)) return '';
  if (!Number.isInteger(end) || end === start) return `p.${start}`;
  return `p.${start}–${end}`;
}

/**
 * 术语表：把每章 `terms` 合并、去重、按拼音排序，并保留「在哪几章出现过」。
 *
 * ★ **必须带章号**。术语表脱离章号就只是一份词表 —— 而用户/agent 拿到一个词之后
 *   第一件想做的事就是「回去看它在原文里怎么说的」。没有章号，这一步就断了，
 *   于是术语表变成一个好看但没用的附录。
 * ★ 同一个词在不同章的解释**不合并成一句**：两章的意思可能不同（同一个词在
 *   第 2 章是「磨坊主妇的称呼」、在第 15 章是地名），强行合并会造出一个
 *   谁都不对的解释。做法是：主条目取**章号最小**的那条解释，其余作为「另见」列出。
 *
 * ★ 「主条」按**章号**取，不按输入顺序取。真实调用方（`buildSkillPackage`）是按
 *   outline 升序传进来的，两种取法在正常路径上一致 —— 但只要有人换个顺序调用，
 *   同一个词就会换一条主解释，而导出的文件内容随之变化。纯函数的输出不该依赖
 *   调用方的迭代顺序：读术语表的人期望看到的是「这个词最早出现在哪一章」。
 */
export function buildGlossary(digests) {
  /** term → { note, chapters: number[], also: string[], primary: number } */
  const byTerm = new Map();
  for (const entry of digests) {
    for (const term of entry.terms ?? []) {
      const name = String(term?.term ?? '').trim();
      if (name === '') continue;
      const note = String(term?.note ?? '').trim();
      const found = byTerm.get(name);
      if (found === undefined) {
        byTerm.set(name, { note, chapters: [entry.n], also: [], primary: entry.n });
        continue;
      }
      if (!found.chapters.includes(entry.n)) found.chapters.push(entry.n);
      if (entry.n < found.primary) {
        // 更早的章也出现了这个词 ⇒ 它的解释才是主条，旧主条降级成「另见」。
        found.primary = entry.n;
        if (note !== '' && note !== found.note) {
          const previous = found.note;
          found.note = note;
          if (previous !== '') found.also.unshift(previous);
        }
      } else if (note !== '' && note !== found.note && !found.also.includes(note)) {
        found.also.push(note);
      }
      // 被提升为主条的解释不能同时留在「另见」里（否则同一个解释出现两次）。
      const stale = found.also.indexOf(found.note);
      if (stale >= 0) found.also.splice(stale, 1);
    }
  }
  return [...byTerm.entries()]
    .map(([term, info]) => ({
      term,
      note: info.note,
      chapters: [...info.chapters].sort((a, b) => a - b),
      also: info.also,
    }))
    .sort((a, b) => a.term.localeCompare(b.term, 'zh-Hans-CN'));
}

/** 一章的 markdown。 */
function renderChapter(chapter, digest, bookTitle) {
  const lines = [`# 第 ${chapter.n} 章 · ${chapter.title || '（无标题）'}`, ''];
  const meta = [
    `《${bookTitle}》`,
    pagesOf(chapter),
    digest?.model ? `解读模型 ${digest.model}` : '',
  ].filter(part => part !== '');
  if (meta.length > 0) lines.push(`> ${meta.join(' · ')}`, '');

  if (digest === null || digest === undefined) {
    lines.push('这一章还没有解读（未生成、或正文不足 200 字被略过）。', '');
    return lines.join('\n');
  }
  if (digest.summary) {
    lines.push('## 这一章讲了什么', '', digest.summary, '');
  }
  const points = Array.isArray(digest.points) ? digest.points : [];
  if (points.length > 0) {
    lines.push('## 要点', '', ...points.map(point => `- ${point}`), '');
  }
  const terms = Array.isArray(digest.terms) ? digest.terms : [];
  if (terms.length > 0) {
    lines.push('## 术语', '', ...terms.map(term => `- **${term.term}**：${term.note}`), '');
  }
  if (digest.format === 'text') {
    // ★ 这个标记要留着：模型不肯吐 JSON 时解读是「一整段」，它没有要点结构。
    //   agent 读到这里要知道「这一章没有要点可引用」，而不是以为要点被丢了。
    lines.push('> 注：这一章的解读没有结构化要点（模型当时返回的是整段文字）。', '');
  }
  return lines.join('\n');
}

/**
 * 横向两页（`patterns.md` / `cheatsheet.md`）。
 *
 * ★ 没做跨章综合时**不能空着，也不能假装有**。做法是：原样摘出各章要点、按章排列，
 *   并在开头明说「这是摘录不是综合」。空文件会让 agent 以为「这本书没有可提炼的东西」；
 *   假装有则是让模型把逐章要点当成了跨章结论。
 */
function renderLateral({ slot, profile, outline, digests, synthesized }) {
  const spec = PROFILE_SLOTS[profile] ?? PROFILE_SLOTS.nonfiction;
  const title = slot === 'patterns' ? spec.patterns : spec.cheatsheet;
  const hints = slot === 'patterns' ? spec.patternsHints : spec.cheatsheetHints;
  const lines = [`# ${title}`, ''];

  if (synthesized) {
    lines.push(String(synthesized[slot] ?? '').trim(), '');
    return lines.join('\n');
  }

  lines.push(
    '> 这次导出**没有**做跨章综合（那需要一次额外的模型调用）。下面是各章要点的**原样摘录**，',
    '> 按章排列 —— 它是「线索」，不是「结论」。要看跨章结论，重新导出时打开「跨章综合」。',
    '',
  );
  if (slot === 'patterns') {
    lines.push('值得跨章回答的问题：', ...hints.map(hint => `- ${hint}`), '');
  }
  for (const chapter of outline) {
    const digest = digests.get(chapter.n);
    const points = Array.isArray(digest?.points) ? digest.points : [];
    if (points.length === 0) continue;
    lines.push(`## 第 ${chapter.n} 章 · ${chapter.title || '（无标题）'}`, '', ...points.map(point => `- ${point}`), '');
  }
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * 拼出整套文件。
 *
 * @param input.book - `{ id, title, author? }`
 * @param input.meta - `digests/<id>/meta.json`
 * @param input.outline - `[{ n, title, startPage, endPage, section? }]`
 * @param input.digests - `Map<number, {summary, points, terms, model?, format?}>`
 * @param input.profile - `'technical' | 'fiction' | 'nonfiction'`
 * @param input.profileReason - 判定依据（写进 SKILL.md，让用户能质疑）
 * @param input.synthesized - `{ patterns?, cheatsheet? }` 或 `null`
 * @param input.generatedAt - ISO 时间串
 * @returns `{ slug, files: Map<string, string>, stats }` —— `files` 的 key 是**相对路径**
 */
export function buildSkillPackage({
  book, meta, outline, digests, profile, profileReason = '', synthesized = null, generatedAt,
}) {
  const bookTitle = String(book?.title ?? meta?.bookTitle ?? '（未命名）');
  const chapters = Array.isArray(outline) ? outline : [];
  const digestMap = digests instanceof Map ? digests : new Map();
  const chosenProfile = SKILL_PROFILES.includes(profile) ? profile : 'nonfiction';
  const spec = PROFILE_SLOTS[chosenProfile];
  // ★ 目录名只认 `skillSlugFor` 一处（见上面那个函数的注释）。这里**不能**传
  //   `bookId` —— 本函数没有这个参数，写了就是 ReferenceError，而它会让整个
  //   suite 中止、汇总行却仍是 `# fail 0`。
  const slug = skillSlugFor({ book, meta });

  const done = chapters.filter(chapter => digestMap.has(chapter.n)).length;
  const skipped = (meta?.chapters ?? []).filter(chapter => chapter.status === 'skipped').length;
  const failed = (meta?.chapters ?? []).filter(chapter => chapter.status === 'failed').length;

  const files = new Map();

  // ---- SKILL.md：始终在上下文里的那一层（入口 + 索引）--------------------
  const description = (() => {
    const first = chapters
      .map(chapter => digestMap.get(chapter.n)?.summary)
      .find(summary => typeof summary === 'string' && summary.trim() !== '');
    return first === undefined
      ? `《${bookTitle}》的逐章解读汇编：${chapters.length} 章。`
      : `《${bookTitle}》的逐章解读汇编（${chapters.length} 章）：${firstSentence(first, 80)}`;
  })();
  const indexRows = chapters.map((chapter) => {
    const digest = digestMap.get(chapter.n);
    const line = digest === undefined
      ? '（未解读）'
      : firstSentence(digest.summary, 52) || (digest.points?.[0] ?? '');
    const name = String(chapter.title ?? '').replace(/\|/g, '\\|');
    return `| ${String(chapter.n).padStart(2, '0')} | ${name} | ${pagesOf(chapter)} | ${line.replace(/\|/g, '\\|')} |`;
  });

  const skill = [
    '---',
    `name: ${yamlString(slug)}`,
    `description: ${yamlString(description)}`,
    '---',
    '',
    `# 《${bookTitle}》`,
    '',
    '> 这份 skill 是**逐章解读的汇编**，不是原文副本，也没有为导出再调一次模型。',
    `> 生成于 ${generatedAt ?? '（未知时间）'} · ${chapters.length} 章（已解读 ${done}`
      + `${skipped > 0 ? ` · 略过 ${skipped}` : ''}${failed > 0 ? ` · 失败 ${failed}` : ''}）`
      + ` · 书型：${PROFILE_LABEL[chosenProfile]}`,
    // ★ 只在这一行「有没有」上做条件，**不要**在末尾统一过滤空行。
    //   统一 `.filter(line => line !== '')` 会把每一处段落间隔一起删掉 ——
    //   产出的 markdown 挤成一片（标题紧贴列表、引用块粘住表格），
    //   agent 还能读，但用户点开一看就像生成坏了。空行是版式，不是噪声。
    ...(profileReason ? [`> 书型依据：${profileReason}`] : []),
    '',
    '## 怎么用',
    '',
    '- 问「第 N 章讲了什么」→ 读 `chapters/chNN.md`（**问到才读**，别一次全读进来）',
    `- 问某个词 / 人名 / 概念 → 先查 \`glossary.md\`（每条都带章号，能顺着回去）`,
    `- 问「全书结构」「作者的写法」→ 看 \`patterns.md\`（${spec.patterns}）`,
    `- 要一张速查表 → 看 \`cheatsheet.md\`（${spec.cheatsheet}）`,
    '- 要原文原话 → 这个包里**没有原文**，只有解读；原文在插件里按章存着（`text/chNN.txt`）',
    '',
    '## 章节索引',
    '',
    '| # | 章节 | 页 | 一句话 |',
    '| --- | --- | --- | --- |',
    ...indexRows,
    '',
  ].join('\n');
  files.set('SKILL.md', `${skill}\n`);

  // ---- chapters/chNN.md -------------------------------------------------
  for (const chapter of chapters) {
    files.set(
      `chapters/ch${String(chapter.n).padStart(2, '0')}.md`,
      `${renderChapter(chapter, digestMap.get(chapter.n), bookTitle)}\n`,
    );
  }

  // ---- glossary.md ------------------------------------------------------
  const glossary = buildGlossary(
    chapters
      .filter(chapter => digestMap.has(chapter.n))
      .map(chapter => ({ n: chapter.n, terms: digestMap.get(chapter.n).terms ?? [] })),
  );
  const glossaryLines = [
    '# 术语与人名',
    '',
    '> 每条都带章号：`（第 3、7 章）`。同一个词在不同章解释不同时，主条取第一次出现的那条，',
    '> 其余列在「另见」下面 —— 强行合并会造出一个谁都不对的解释。',
    '',
  ];
  if (glossary.length === 0) {
    glossaryLines.push('（这本书的解读里没有单独标注的术语。）', '');
  } else {
    for (const entry of glossary) {
      // ★ 紧凑写法 `（第 1、3 章）`，不是 `（第 1 章、第 3 章）` —— 上面那段说明
      //   与 `skill.json` 的约定都写成前者。术语表是要被**扫**的，不是被读的：
      //   多出来的「章」字在 50 条术语里就是 50 个噪声词。
      const where = entry.chapters.length === 1
        ? `第 ${entry.chapters[0]} 章`
        : `第 ${entry.chapters.join('、')} 章`;
      glossaryLines.push(`- **${entry.term}**：${entry.note || '（没有解释）'}（${where}）`);
      for (const also of entry.also) glossaryLines.push(`  - 另见：${also}`);
    }
    glossaryLines.push('');
  }
  files.set('glossary.md', `${glossaryLines.join('\n')}\n`);

  // ---- patterns.md / cheatsheet.md -------------------------------------
  files.set('patterns.md', `${renderLateral({
    slot: 'patterns', profile: chosenProfile, outline: chapters, digests: digestMap, synthesized,
  })}\n`);
  files.set('cheatsheet.md', `${renderLateral({
    slot: 'cheatsheet', profile: chosenProfile, outline: chapters, digests: digestMap, synthesized,
  })}\n`);

  // ---- skill.json：机器可读的元数据 -------------------------------------
  const stats = {
    chapters: chapters.length,
    digested: done,
    skipped,
    failed,
    terms: glossary.length,
    bytes: 0,
  };
  files.set('skill.json', `${JSON.stringify({
    slug,
    bookId: book?.id ?? meta?.bookId ?? '',
    title: bookTitle,
    author: book?.author ?? meta?.author ?? '',
    profile: chosenProfile,
    profileReason,
    generatedAt: generatedAt ?? null,
    synthesized: synthesized !== null,
    stats: { ...stats, bytes: undefined },
    chapters: chapters.map((chapter) => ({
      n: chapter.n,
      title: chapter.title ?? '',
      startPage: chapter.startPage ?? null,
      endPage: chapter.endPage ?? null,
      file: `chapters/ch${String(chapter.n).padStart(2, '0')}.md`,
      digested: digestMap.has(chapter.n),
    })),
  }, null, 2)}\n`);

  let bytes = 0;
  for (const content of files.values()) bytes += Buffer.byteLength(content, 'utf8');
  stats.bytes = bytes;

  return { slug, files, stats };
}

/**
 * 跨章综合的提示词（**可选**的一步，调用方显式开启）。
 *
 * ★ 与逐章解读用的是**两套不同的要求**：逐章问「这一章讲了什么」，这里问
 *   「整本书作为一件作品/一门技术，它的结构是什么」。用同一套提示词会得到
 *   一份「各章摘要再压缩一遍」，那正是用户嫌「和伴读没区别」的东西。
 * ★ 输入是**已经提炼过的要点**，不是原文 —— 这样它做的是「在已有结论上做归纳」，
 *   而不是「再读一遍整本书」（省钱，也不容易和逐章解读打架）。
 */
export function buildSynthesisPrompt({ bookTitle, profile, chapters }) {
  const spec = PROFILE_SLOTS[profile] ?? PROFILE_SLOTS.nonfiction;
  const list = (Array.isArray(chapters) ? chapters : [])
    .map((chapter) => {
      const points = (chapter.points ?? []).map(point => `  - ${point}`).join('\n');
      return `第 ${chapter.n} 章 · ${chapter.title || '（无标题）'}\n  摘要：${chapter.summary || '（无）'}\n${points}`;
    })
    .join('\n');
  return [
    `你在为一本${PROFILE_LABEL[profile] ?? '书'}《${bookTitle}》做**跨章**归纳。`,
    '下面每一章都已经有摘要与要点（别人做的逐章提炼），**不要重复它们**。',
    '你要回答的是「把它们放在一起看，才看得出来的东西」。',
    '',
    '要求：',
    '1. 只依据下面的材料。材料不足就写「材料不足」，不要补。',
    '2. 每条结论后面用 `（第 N 章）` 标出依据来自哪几章；标不出来的结论不要写。',
    '3. 不要复述各章摘要，不要按章排列 —— 按**主题**组织。',
    '4. 用简体中文。只输出 JSON，不要代码围栏。',
    '',
    '输出字段：',
    '{',
    `  "patterns": "「${spec.patterns}」：4–8 条，每条一段，带章号依据",`,
    `  "cheatsheet": "「${spec.cheatsheet}」：一张紧凑的清单或小表，带章号依据"`,
    '}',
    '',
    `patterns 该回答的问题：${spec.patternsHints.join('；')}`,
    `cheatsheet 该回答的问题：${spec.cheatsheetHints.join('；')}`,
    '',
    '---- 各章摘要与要点 ----',
    list,
    '---- 结束 ----',
  ].join('\n');
}

/** 解析跨章综合的输出。解析不出来就返回 `null` —— 让调用方退回「原样摘录」，不编。 */
export function parseSynthesis(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const start = text.indexOf('{');
  if (start < 0) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const patterns = typeof parsed.patterns === 'string' ? parsed.patterns.trim() : '';
        const cheatsheet = typeof parsed.cheatsheet === 'string' ? parsed.cheatsheet.trim() : '';
        if (patterns === '' && cheatsheet === '') return null;
        return { patterns, cheatsheet };
      }
    } catch {
      // 继续往前缩。
    }
    if (end === start + 1) break;
  }
  return null;
}
