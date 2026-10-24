/**
 * 「把一本书变成一个 skill」的**纯函数层**：书型判定、目录名、术语表、整套文件的拼装。
 *
 * ★ 为什么这些断言值得写：这一层坏掉的样子**全都不报错**。
 *   SKILL.md 少一行索引 ⇒ agent 永远不会去读那一章，而文件明明在包里；
 *   术语表把两章的解释合并成一句 ⇒ 造出一个谁都不对的解释；
 *   目录名带了空格或 `/` ⇒ 写盘时才发现（或者在更糟的地方发现）。
 *   这些都是「看起来像正常文档」的坏，靠读一遍发现不了。
 *
 * ★ 这个文件**只 import 源码**，不走 `loadHostBundle()`：`book-skill.js` 是纯函数，
 *   没有 `ctx`、没有磁盘、没有模型。绕过打包能保证断言跑的就是 `src/` 里那一份，
 *   而不是某次构建的产物（本项目有过「断言读产物、产物是旧的」的教训）。
 *
 * ★ 每个「判据」都配一条**反向对照**：把判据依赖的那个信号抽掉，结论必须翻面。
 *   只断言「代码密集 ⇒ 判技术书」是不够的 —— 一个恒返回 `'technical'` 的实现也能过。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  CODE_DENSITY,
  DIALOGUE_DENSITY,
  PROFILE_LABEL,
  PROFILE_SLOTS,
  SKILL_PROFILES,
  buildGlossary,
  buildSkillPackage,
  buildSynthesisPrompt,
  detectProfile,
  parseSynthesis,
  skillSlug,
  skillSlugFor,
} from '../src/host/book-skill.js';
import { createDigestStore } from '../src/host/digest-store.js';

// ── 正文样本 ───────────────────────────────────────────────────────────────
//
// 三个样本的字数都在 300–400 之间，密度算出来离阈值很远（不是「刚好过线」），
// 这样断言不会因为样本被改短一个字就翻面。

/** 代码密集：约 400 字里 12 处代码特征 ⇒ 每千字约 30 处（阈值 6）。 */
const CODE_TEXT = [
  'function parseConfig(path) {',
  '  const raw = readFileSync(path);',
  '  const lines = raw.split("\\n");',
  '  const out = lines.map(line => line.trim()).filter(line => line !== "");',
  '  if (out.length === 0) {',
  '    return {};',
  '  }',
  '  return out.reduce((acc, line) => {',
  '    const [key, value] = line.split("=");',
  '    acc[key] = value;',
  '    return acc;',
  '  }, {});',
  '}',
  'const config = parseConfig("/etc/app.conf");',
].join('\n');

/** 对话密集：约 330 字里 24 个引号 ⇒ 每千字约 70 个（阈值 8）。 */
const FICTION_TEXT = [
  '「你昨晚上哪儿去了？」磨坊主妇问。',
  '「哪儿也没去。」他答。',
  '「别骗我。」她说，「我听见门响了。」',
  '「那是风。」',
  '「风不会把门闩推上。」',
  '「你听错了。」',
  '「我耳朵还没坏。」',
  '「那就随你怎么想吧。」',
  '「你站住。」',
  '「我还有活要干。」',
  '「活可以明天干。」',
  '「明天有明天的活。」',
].join('\n');

/** 什么都没有：约 360 字，0 处代码、0 个引号。 */
const PLAIN_TEXT = [
  '十八世纪的磨坊依靠水力驱动，磨盘之间的间隙决定了面粉的粗细。',
  '磨坊主通常兼任当地的度量衡仲裁者，因为只有他掌握着那套石制砝码。',
  '水渠的维护是全村的事，每年春季要清淤一次，费用按各家田亩分摊。',
  '到了蒸汽机普及之后，这套秩序在两代人之间就瓦解了。',
  '档案里留下的账本显示，最后一任磨坊主在破产前仍在按旧例分摊清淤费。',
].join('\n');

// ── 书的夹具 ───────────────────────────────────────────────────────────────

const OUTLINE = [
  { n: 1, title: '第一章 起', startPage: 1, endPage: 12 },
  { n: 2, title: '第二章 承', startPage: 13, endPage: 24 },
  { n: 3, title: '第三章 转', startPage: 25, endPage: 36 },
  { n: 4, title: '第四章 合', startPage: 37, endPage: 37 },
];

const BOOK = { id: 'l-skill', title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann' };

/** 只有第 1、3 章解读过 —— 刻意留两个洞，用来测「未解读的章」怎么进包。 */
function digestMap() {
  return new Map([
    [1, {
      summary: '作者先划清一致性、可用性、分区容忍三者的边界。',
      points: ['先分清问题属于哪一类', '再决定用哪种工具'],
      terms: [{ term: '一致性', note: '本章指多副本之间的可见顺序' }],
      model: 'deepseek/deepseek-chat',
      format: 'json',
    }],
    [3, {
      summary: '复制策略决定了故障时谁能继续写。',
      points: ['单主最简单但写侧有单点', '多主要处理写冲突'],
      terms: [{ term: '一致性', note: '这里指线性一致' }, { term: '复制', note: '多副本之间同步数据' }],
      model: 'deepseek/deepseek-chat',
      format: 'text',
    }],
  ]);
}

const META = {
  bookId: 'l-skill',
  bookTitle: BOOK.title,
  mode: 'toc',
  pageCount: 40,
  chapters: [
    { n: 1, status: 'done' },
    { n: 2, status: 'skipped' },
    { n: 3, status: 'done' },
    { n: 4, status: 'failed' },
  ],
};

const build = (overrides = {}) => buildSkillPackage({
  book: BOOK,
  meta: META,
  outline: OUTLINE,
  digests: digestMap(),
  profile: 'technical',
  profileReason: '由调用方显式指定',
  synthesized: null,
  generatedAt: '2026-10-23T10:00:00.000Z',
  ...overrides,
});

// ── 书型判定 ───────────────────────────────────────────────────────────────

describe('detectProfile：按密度判书型，并把依据说出来', () => {
  it('代码密集 ⇒ technical', () => {
    const result = detectProfile([{ title: 'a', text: CODE_TEXT }]);
    assert.equal(result.profile, 'technical');
    assert.ok(result.codeDensity >= CODE_DENSITY, `代码密度 ${result.codeDensity} 没到阈值`);
    assert.match(result.reason, /代码特征/);
  });

  it('对话密集 ⇒ fiction', () => {
    const result = detectProfile([{ title: 'a', text: FICTION_TEXT }]);
    assert.equal(result.profile, 'fiction');
    assert.ok(result.dialogueDensity >= DIALOGUE_DENSITY);
    assert.match(result.reason, /引号/);
  });

  it('两者都不密 ⇒ nonfiction', () => {
    const result = detectProfile([{ title: 'a', text: PLAIN_TEXT }]);
    assert.equal(result.profile, 'nonfiction');
    assert.ok(result.codeDensity < CODE_DENSITY);
    assert.ok(result.dialogueDensity < DIALOGUE_DENSITY);
  });

  it('没有正文 ⇒ nonfiction，而且**说明**这是兜底（不是判出来的）', () => {
    for (const input of [[], [{ title: 'a', text: '' }], [{ title: 'a' }], null, undefined]) {
      const result = detectProfile(input);
      assert.equal(result.profile, 'nonfiction', `输入 ${JSON.stringify(input)} 应兜底`);
      // ★ 悄悄兜底会让用户以为「判定过了」。reason 必须自己承认没样本。
      assert.match(result.reason, /没有可用的正文样本/);
    }
  });

  it('★★ 反向对照：把小说的引号全部删掉 ⇒ 不再判 fiction', () => {
    // 证明判据是**引号密度**，不是「这段文字读起来像小说」。
    const stripped = FICTION_TEXT.replace(/[「」“”"]/g, '');
    assert.equal(detectProfile([{ text: stripped }]).profile, 'nonfiction');
    // 而原文判 fiction —— 两边的差别只有引号。
    assert.equal(detectProfile([{ text: FICTION_TEXT }]).profile, 'fiction');
  });

  it('★★ 反向对照：给平铺直叙的文本掺进代码 ⇒ 变成 technical', () => {
    assert.equal(detectProfile([{ text: PLAIN_TEXT }]).profile, 'nonfiction');
    assert.equal(detectProfile([{ text: `${PLAIN_TEXT}\n${CODE_TEXT}` }]).profile, 'technical');
  });

  it('★ 两者都超阈值时判 technical（代码优先）', () => {
    // 技术书里引用一段对话是常见的（示例输出、错误信息里带引号）。
    // 若判成小说，导出会去问「叙述视角」—— 对一本讲复制策略的书毫无意义。
    const both = `${CODE_TEXT}\n${FICTION_TEXT}`;
    assert.equal(detectProfile([{ text: both }]).profile, 'technical');
  });

  it('★ 只看前 5 章、每章前 6000 字：第 6 章之后的内容不参与判定', () => {
    const five = Array.from({ length: 5 }, () => ({ text: PLAIN_TEXT }));
    assert.equal(detectProfile([...five, { text: CODE_TEXT }]).profile, 'nonfiction');
    // 把代码章放到第 1 章就判得出来 —— 说明「没看第 6 章」是取样规则，不是漏读。
    assert.equal(detectProfile([{ text: CODE_TEXT }, ...five]).profile, 'technical');
  });
});

// ── 目录名 ─────────────────────────────────────────────────────────────────

describe('skillSlug：目录名只能是 [a-z0-9-]', () => {
  it('英文标题直接转写', () => {
    assert.equal(skillSlug({ title: 'Designing Data-Intensive Applications', bookId: 'l-1' }),
      'designing-data-intensive-applications');
  });

  it('★ 中文标题不做拼音，回退成 book-<id>', () => {
    // 拼错了比不拼更糟：用户会按拼音去找，然后找不到。
    assert.equal(skillSlug({ title: '猎人笔记', bookId: 'l-abc123' }), 'book-labc123');
  });

  it('大写、空格、标点、emoji 一律收敛成连字符', () => {
    assert.equal(skillSlug({ title: '  Clean   Code!! (2nd ed.)  ', bookId: 'x' }), 'clean-code-2nd-ed');
    assert.equal(skillSlug({ title: '📕📗📘', bookId: 'x' }), 'book-x');
  });

  it('超长标题截断到 48 个字符以内', () => {
    const slug = skillSlug({ title: 'a'.repeat(200), bookId: 'x' });
    assert.ok(slug.length <= 48, `slug 长度 ${slug.length}`);
    assert.match(slug, /^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  it('★★ 与 digest-store 的闸必须一致：任何标题产出的 slug 都得能落盘', async () => {
    // 这是一条**跨模块**断言，也是这一组里最要紧的一条：
    //   `skillSlug` 决定目录名，`skillDirOf` 决定「这个名字准不准写」。
    //   两边规则一旦漂移（比如 skillSlug 允许大写），导出会在**写盘那一刻**抛
    //   TypeError，而报错信息只会说「非法 skill 名」，根本看不出是命名规则的问题。
    const root = await mkdtemp(join(tmpdir(), 'npie-slug-'));
    const store = createDigestStore({ rootDir: root });
    const nasty = [
      { title: 'Designing Data-Intensive Applications', bookId: 'l-1' },
      { title: '猎人笔记', bookId: 'l-2' },
      { title: '../../etc/passwd', bookId: 'l-3' },
      { title: 'a/b\\c:d*e?f"g<h>i|j', bookId: 'l-4' },
      { title: '   ', bookId: 'l-5' },
      { title: 'Ünïcödé Ärger', bookId: 'l-6' },
      { title: 'x'.repeat(500), bookId: 'l-7' },
      { title: undefined, bookId: 'l-8' },
      { title: 'A', bookId: 'l-9' },
    ];
    for (const input of nasty) {
      const slug = skillSlug(input);
      assert.match(slug, /^[a-z0-9][a-z0-9-]{0,63}$/, `slug 不合规：${JSON.stringify(slug)}`);
      const dir = store.skillDirOf(slug); // 不许抛
      assert.ok(dir.startsWith(store.skillsDir), `slug ${slug} 跑出了 skills 目录：${dir}`);
      assert.ok(!dir.includes('..'), `slug ${slug} 造成了路径穿越：${dir}`);
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
});

// ── 「这本书该用哪个目录名」 ────────────────────────────────────────────────

describe('skillSlugFor：写（导出）与读（状态查询）必须落在同一个目录名上', () => {
  it('书架上的书名优先于抽取时记下的书名', () => {
    // 导出那一刻书还在书架上 ⇒ 用书架上的名字。这条钉的是**优先级**：
    // 反过来的话，同一本书在两种上下文里会算出两个目录名。
    assert.equal(
      skillSlugFor({ book: { id: 'l-1', title: 'Clean Code' }, meta: { bookTitle: '干净代码' } }),
      'clean-code',
    );
  });

  it('书不在书架上时退回抽取时记下的书名（不是回退成 book-<id>）', () => {
    // ★ 这条是「书移出书架、导出包还在」那条路。退回 `book-<id>` 会让状态查询
    //   算出一个**不同**的目录名，于是徽章永远不出现，而两边都不报错。
    assert.equal(skillSlugFor({ book: null, meta: { bookTitle: 'Clean Code' } }), 'clean-code');
    assert.equal(skillSlugFor({ meta: { bookTitle: 'Clean Code' }, bookId: 'l-9' }), 'clean-code');
  });

  it('两边都没有书名 ⇒ 才用 book-<id>（此时 id 也必须来自其中一处）', () => {
    assert.equal(skillSlugFor({ book: { id: 'l-abc' } }), 'book-labc');
    assert.equal(skillSlugFor({ meta: { bookId: 'l-def' } }), 'book-ldef');
    assert.equal(skillSlugFor({ bookId: 'l-ghi' }), 'book-lghi');
  });

  it('★ 反向对照：同一个输入调用两次结果相同（不存在「谁先调用谁定名」）', () => {
    const input = { book: { id: 'l-1', title: 'Designing Data-Intensive Applications' } };
    assert.equal(skillSlugFor(input), skillSlugFor(input));
  });
});

// ── 术语表 ─────────────────────────────────────────────────────────────────

describe('buildGlossary：合并、去重、带章号、同词异释不合并', () => {
  it('同一个词跨章 ⇒ 一条，章号合并并升序', () => {
    const glossary = buildGlossary([
      { n: 3, terms: [{ term: '一致性', note: '线性一致' }] },
      { n: 1, terms: [{ term: '一致性', note: '可见顺序' }] },
      { n: 1, terms: [{ term: '分区', note: '网络断开' }] },
    ]);
    const entry = glossary.find(item => item.term === '一致性');
    assert.deepEqual(entry.chapters, [1, 3], '章号必须升序去重');
    assert.equal(entry.note, '可见顺序', '主条取**第一次出现**的解释（按输入顺序）');
  });

  it('★★ 同一个词在不同章解释不同 ⇒ 主条 + 另见，绝不合并成一句', () => {
    const [entry] = buildGlossary([
      { n: 2, terms: [{ term: '磨坊', note: '磨坊主妇的称呼' }] },
      { n: 15, terms: [{ term: '磨坊', note: '河湾处的地名' }] },
    ]);
    assert.equal(entry.note, '磨坊主妇的称呼');
    assert.deepEqual(entry.also, ['河湾处的地名']);
    // 反向：合并成「磨坊主妇的称呼；河湾处的地名」对任何一处引用都是错的。
    assert.ok(!entry.note.includes('地名'), '主条不该被第二种解释污染');
  });

  it('解释相同不重复堆「另见」', () => {
    const [entry] = buildGlossary([
      { n: 1, terms: [{ term: 'x', note: '同一个解释' }] },
      { n: 2, terms: [{ term: 'x', note: '同一个解释' }] },
    ]);
    assert.deepEqual(entry.also, []);
    assert.deepEqual(entry.chapters, [1, 2]);
  });

  it('空词 / 空 note 不产生垃圾条目', () => {
    const glossary = buildGlossary([
      { n: 1, terms: [{ term: '', note: 'x' }, { term: '   ', note: 'y' }, { term: 'ok', note: '' }] },
      { n: 2, terms: undefined },
      { n: 3 },
    ]);
    assert.deepEqual(glossary.map(item => item.term), ['ok']);
  });
});

// ── 整套文件 ───────────────────────────────────────────────────────────────

describe('buildSkillPackage：索引层 + 按需加载的章 + 横向两页', () => {
  let built = null;
  before(() => { built = build(); });

  it('文件集合的**基数**：1 + 章数 + 4（glossary/patterns/cheatsheet/skill.json）', () => {
    assert.equal(built.files.size, 1 + OUTLINE.length + 4);
  });

  it('★★ 两两性质：索引里每一行都指向一个**真的存在**的文件，且一个不少', () => {
    // 「基数对」与「每一行都对」必须写在同一条里：
    //   只断基数，一个把第 3 章索引指到 ch04.md 的实现照样过；
    //   只断「每个文件都在索引里」，一个多写了两行索引的实现照样过。
    const skill = built.files.get('SKILL.md');
    const rows = skill.split('\n').filter(line => /^\| \d{2} \|/.test(line));
    assert.equal(rows.length, OUTLINE.length, '索引行数与章节数不一致');
    for (const row of rows) {
      const n = Number(row.slice(2, 4));
      const target = `chapters/ch${String(n).padStart(2, '0')}.md`;
      assert.ok(built.files.has(target), `索引指向了不存在的文件：${target}`);
      const title = OUTLINE.find(chapter => chapter.n === n).title;
      assert.ok(row.includes(title), `第 ${n} 行的标题不对：${row}`);
    }
    // 反向：包里不能有索引没提到的章文件（那种文件谁都不会去读）。
    const chapterFiles = [...built.files.keys()].filter(key => key.startsWith('chapters/'));
    assert.equal(chapterFiles.length, OUTLINE.length);
  });

  it('未解读的章也有一份文件，并且**明说**没解读', () => {
    // 空着或者缺文件会让 agent 以为「这本书没有这一章」。
    const text = built.files.get('chapters/ch02.md');
    assert.match(text, /还没有解读/);
    assert.ok(built.files.has('chapters/ch04.md'));
    assert.match(built.files.get('chapters/ch04.md'), /还没有解读/);
    // 索引行也要标出来，别让 agent 以为读进去会有内容。
    assert.match(built.files.get('SKILL.md'), /\| 02 \|.*（未解读）/);
  });

  it('解读过的章：摘要 / 要点 / 术语都在，页码区间写对', () => {
    const text = built.files.get('chapters/ch01.md');
    assert.match(text, /^# 第 1 章 · 第一章 起/);
    assert.match(text, /## 这一章讲了什么/);
    assert.match(text, /先分清问题属于哪一类/);
    assert.match(text, /\*\*一致性\*\*：本章指多副本之间的可见顺序/);
    assert.match(text, /p\.1–12/);
    // 单页章不写成 p.37–37。
    assert.match(built.files.get('chapters/ch04.md'), /p\.37/);
    assert.ok(!built.files.get('chapters/ch04.md').includes('p.37–37'));
  });

  it('★ 没有结构化要点的章要留下标记（否则看起来像要点被丢了）', () => {
    assert.match(built.files.get('chapters/ch03.md'), /没有结构化要点/);
    assert.ok(!built.files.get('chapters/ch01.md').includes('没有结构化要点'));
  });

  it('★★ 没做跨章综合时，两页横向文件明说自己是「原样摘录」', () => {
    // 假装有综合 = 让 agent 把逐章要点当成跨章结论；
    // 空文件 = 让 agent 以为这本书没有可提炼的东西。两者都不行。
    for (const name of ['patterns.md', 'cheatsheet.md']) {
      const text = built.files.get(name);
      assert.match(text, /没有\*\*做跨章综合/, `${name} 没有说明自己没做综合`);
      assert.match(text, /原样摘录/, `${name} 没有说明自己是摘录`);
    }
    // 摘录确实把已解读章的要点带进来了。
    assert.match(built.files.get('patterns.md'), /先分清问题属于哪一类/);
    assert.match(built.files.get('patterns.md'), /单主最简单但写侧有单点/);
  });

  it('★★ 做了综合时，横向两页就是综合结果，且不再自称摘录', () => {
    const withSynth = build({
      synthesized: { patterns: '全书围绕「代价」展开（第 1、3 章）。', cheatsheet: '选型：先问写冲突（第 3 章）。' },
    });
    assert.match(withSynth.files.get('patterns.md'), /全书围绕「代价」展开/);
    assert.ok(!withSynth.files.get('patterns.md').includes('原样摘录'));
    assert.match(withSynth.files.get('cheatsheet.md'), /先问写冲突/);
    // skill.json 必须记下「这一份是综合过的」，否则看包的人分不出两种来源。
    assert.equal(JSON.parse(withSynth.files.get('skill.json')).synthesized, true);
    assert.equal(JSON.parse(built.files.get('skill.json')).synthesized, false);
  });

  it('★ 书型真的换内容：同一个输入换 profile，横向两页的标题必须变', () => {
    const fiction = build({ profile: 'fiction' });
    assert.match(fiction.files.get('patterns.md'), new RegExp(`^# ${PROFILE_SLOTS.fiction.patterns}`));
    assert.match(built.files.get('patterns.md'), new RegExp(`^# ${PROFILE_SLOTS.technical.patterns}`));
    // 反向对照：如果标题是写死的，上面两条不可能同时成立。
    assert.notEqual(PROFILE_SLOTS.fiction.patterns, PROFILE_SLOTS.technical.patterns);
    // 小说的「该问什么」要真的进到文件里（这是用户要的「沉淀写作风格」）。
    // ★ 只有 patterns.md 会列问题清单；cheatsheet.md 的摘录就是各章要点本身，
    //   `cheatsheetHints` 只进跨章综合的提示词 —— 所以这里断标题，不断清单。
    assert.match(fiction.files.get('patterns.md'), /叙述视角与人称/);
    assert.match(fiction.files.get('cheatsheet.md'), new RegExp(`^# ${PROFILE_SLOTS.fiction.cheatsheet}`));
    assert.ok(!built.files.get('patterns.md').includes('叙述视角与人称'), '技术书不该问叙述视角');
  });

  it('未知 profile 兜底成 nonfiction，而不是崩', () => {
    const weird = build({ profile: 'poetry' });
    assert.match(weird.files.get('SKILL.md'), new RegExp(PROFILE_LABEL.nonfiction));
    assert.equal(JSON.parse(weird.files.get('skill.json')).profile, 'nonfiction');
  });

  it('skill.json 是合法 JSON，章号 / 文件 / 状态对得上', () => {
    const record = JSON.parse(built.files.get('skill.json'));
    assert.equal(record.slug, built.slug);
    assert.equal(record.bookId, BOOK.id);
    assert.equal(record.title, BOOK.title);
    assert.equal(record.author, BOOK.author);
    assert.equal(record.generatedAt, '2026-10-23T10:00:00.000Z');
    assert.equal(record.chapters.length, OUTLINE.length);
    for (const chapter of record.chapters) {
      assert.ok(built.files.has(chapter.file), `skill.json 指向不存在的 ${chapter.file}`);
      assert.equal(chapter.digested, digestMap().has(chapter.n));
    }
    // ★ 必须留一条反向对照：digested 不是恒 true / 恒 false。
    assert.deepEqual(record.chapters.map(chapter => chapter.digested), [true, false, true, false]);
  });

  it('stats 与真实字节数一致（不虚报）', () => {
    let sum = 0;
    for (const content of built.files.values()) sum += Buffer.byteLength(content, 'utf8');
    assert.equal(built.stats.bytes, sum);
    assert.ok(built.stats.bytes > 0);
    assert.equal(built.stats.chapters, OUTLINE.length);
    assert.equal(built.stats.digested, 2);
    assert.equal(built.stats.skipped, 1);
    assert.equal(built.stats.failed, 1);
    // 术语：一致性（两章）+ 复制 = 2 条。
    assert.equal(built.stats.terms, 2);
  });

  it('SKILL.md 的 frontmatter：name 是 slug，description 带书名与一句话', () => {
    const skill = built.files.get('SKILL.md');
    assert.match(skill, /^---\n/);
    assert.match(skill, new RegExp(`^name: "${built.slug}"$`, 'm'));
    const description = /^description: "(.*)"$/m.exec(skill);
    assert.ok(description !== null, 'description 行没找到');
    assert.ok(description[1].includes(BOOK.title));
    assert.ok(description[1].includes('一致性'), 'description 应该取第一段有内容的摘要');
  });

  it('★ 书名里带双引号 / 反斜杠时 frontmatter 不被撑破', () => {
    // 不转义的话 `description: "He said "hi""` 直接把 YAML 弄坏，
    // 而 skill 加载器只会报「frontmatter 解析失败」，看不出是书名的问题。
    const nasty = build({ book: { id: 'l-q', title: 'He said "hi" \\ bye' } });
    const skill = nasty.files.get('SKILL.md');
    const line = /^description: (".*")$/m.exec(skill)[1];
    assert.equal(JSON.parse(line), `《He said "hi" \\ bye》的逐章解读汇编（${OUTLINE.length} 章）：作者先划清一致性、可用性、分区容忍三者的边界。`);
  });

  it('★ SKILL.md 保留段落空行（别挤成一片）', () => {
    const skill = built.files.get('SKILL.md');
    assert.ok(skill.includes('\n\n## 怎么用'), '标题前没有空行');
    assert.ok(skill.includes('\n\n## 章节索引'), '索引标题前没有空行');
    assert.ok(skill.includes('\n\n| # | 章节 | 页 | 一句话 |'), '表格前没有空行');
    // 空行数量是个下限，不是精确值 —— 但「一处都没有」必须能红。
    assert.ok((skill.match(/\n\n/g) ?? []).length >= 6);
  });

  it('没有 profileReason 时不留一行空的「书型依据」', () => {
    const noReason = build({ profileReason: '' });
    assert.ok(!noReason.files.get('SKILL.md').includes('书型依据'));
    assert.ok(built.files.get('SKILL.md').includes('书型依据'));
  });

  it('glossary.md 的每一条都带章号，同词异释列「另见」', () => {
    const text = built.files.get('glossary.md');
    assert.match(text, /\*\*一致性\*\*：本章指多副本之间的可见顺序（第 1、3 章）/);
    assert.match(text, /另见：这里指线性一致/);
    assert.match(text, /\*\*复制\*\*：多副本之间同步数据（第 3 章）/);
  });

  it('一章都没有解读时也能导出（只会有索引与「未解读」）', () => {
    const empty = build({ digests: new Map() });
    assert.equal(empty.stats.digested, 0);
    assert.match(empty.files.get('chapters/ch01.md'), /还没有解读/);
    assert.match(empty.files.get('glossary.md'), /没有单独标注的术语/);
    // ★ 这种情况下 description 不能是空的（YAML 里空 description 会被当成没写）。
    assert.match(empty.files.get('SKILL.md'), /^description: "《.*》的逐章解读汇编：4 章。"$/m);
  });

  it('目录为空时不崩，只产出骨架', () => {
    const blank = build({ outline: [], digests: new Map() });
    assert.equal(blank.files.size, 1 + 0 + 4);
    assert.match(blank.files.get('SKILL.md'), /章节索引/);
  });
});

// ── 跨章综合的提示词与解析 ─────────────────────────────────────────────────

describe('buildSynthesisPrompt / parseSynthesis', () => {
  const chapters = [
    { n: 1, title: '第一章 起', summary: '划清三个概念的边界。', points: ['先分类', '再选工具'] },
    { n: 3, title: '第三章 转', summary: '复制策略决定故障时的可写性。', points: ['单主有单点', '多主要解冲突'] },
  ];

  it('每一章都进提示词，且要求「不要重复」「按主题组织」', () => {
    const prompt = buildSynthesisPrompt({ bookTitle: '某书', profile: 'technical', chapters });
    for (const chapter of chapters) {
      assert.ok(prompt.includes(chapter.title), `缺第 ${chapter.n} 章`);
      assert.ok(prompt.includes(chapter.summary));
    }
    assert.match(prompt, /不要重复/);
    assert.match(prompt, /按\*\*主题\*\*组织/);
    // 带章号依据是这份提示词的核心要求，漏了它综合结果就没法回溯。
    assert.match(prompt, /（第 N 章）/);
  });

  it('★ 书型换问题：technical 问选型，fiction 问视角', () => {
    const technical = buildSynthesisPrompt({ bookTitle: '某书', profile: 'technical', chapters });
    const fiction = buildSynthesisPrompt({ bookTitle: '某书', profile: 'fiction', chapters });
    assert.match(technical, /选型决策表/);
    assert.match(fiction, /叙述视角与人称/);
    assert.ok(!fiction.includes('选型决策表'));
  });

  it('解析：纯 JSON', () => {
    assert.deepEqual(parseSynthesis('{"patterns":"P","cheatsheet":"C"}'), { patterns: 'P', cheatsheet: 'C' });
  });

  it('解析：外面裹了代码围栏 / 前后有废话也能取出来', () => {
    assert.deepEqual(parseSynthesis('好的，结果如下：\n```json\n{"patterns":"P","cheatsheet":"C"}\n```\n希望有用。'),
      { patterns: 'P', cheatsheet: 'C' });
  });

  it('解析不出来就 null —— 让调用方退回摘录，而不是编', () => {
    for (const raw of ['', 'no json here', '{"patterns":', null, undefined, 42, '[]']) {
      assert.equal(parseSynthesis(raw), null, `输入 ${JSON.stringify(raw)} 应返回 null`);
    }
  });

  it('两段都空 ⇒ null（不能产出两个空文件还说是综合的）', () => {
    assert.equal(parseSynthesis('{}'), null);
    assert.equal(parseSynthesis('{"patterns":"  ","cheatsheet":""}'), null);
  });

  it('只有一段有内容 ⇒ 另一段给空串，不算失败', () => {
    assert.deepEqual(parseSynthesis('{"patterns":"只有这一段"}'), { patterns: '只有这一段', cheatsheet: '' });
  });

  it('★ 类型不对不算数（数字不是正文）', () => {
    assert.equal(parseSynthesis('{"patterns":123,"cheatsheet":456}'), null);
    assert.equal(parseSynthesis('{"patterns":["a"],"cheatsheet":{"b":1}}'), null);
  });
});

// ── 书型表本身的完整性 ─────────────────────────────────────────────────────

describe('书型表：三个书型都不能缺槽位', () => {
  it('每个书型都有标题与两组问题，且互不相同', () => {
    assert.deepEqual([...SKILL_PROFILES], ['technical', 'fiction', 'nonfiction']);
    for (const profile of SKILL_PROFILES) {
      const spec = PROFILE_SLOTS[profile];
      assert.ok(spec !== undefined, `${profile} 缺配置`);
      assert.ok(spec.patterns.length > 0 && spec.cheatsheet.length > 0);
      assert.ok(spec.patternsHints.length >= 3, `${profile} 的 patternsHints 太少`);
      assert.ok(spec.cheatsheetHints.length >= 3, `${profile} 的 cheatsheetHints 太少`);
      assert.ok(PROFILE_LABEL[profile].length > 0);
    }
    // 三个书型的 patterns 标题必须两两不同：否则「按书型换问题」是假的。
    const titles = SKILL_PROFILES.map(profile => PROFILE_SLOTS[profile].patterns);
    assert.equal(new Set(titles).size, titles.length);
  });
});
