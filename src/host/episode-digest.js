/**
 * 「这期讲了什么」—— AI 导读的提示词、输入组装、输出解析（0.84.0）。
 *
 * ── 为什么导读要带时间戳 ──────────────────────────────────────────────
 *
 * 播客不是文章：想核对一句结论，只能回去听。一份没有时间戳的摘要听起来很顺，
 * 但它把「你怎么知道的」这条线剪断了 —— 用户只能从头拖进度条找。
 * 所以这里要求模型**每个要点都挂一个时间**，并且那个时间必须是**输入里真的
 * 出现过的段落起点**（见 `snapToParagraph`）。这条约束是整份导读可信度的地基：
 * 允许它自己编时间，就会出现「说 12:30 讲了 A，跳过去却在聊 B」。
 *
 * ── 为什么输出 JSON 而不是 Markdown ──────────────────────────────────
 *
 * 与 `digest-prompt.js` 同一条理由：要点要渲染成真 `<ul>`，时间戳要渲染成一个
 * **能点的按钮**。Markdown 里那只是一段文字，得再解析一遍，而解析器一旦认错
 * 就把整段当正文显示（点不了）。
 *
 * ★ 纯函数，不碰磁盘、不碰 ctx —— 模型只负责中间那一段，其余每一步都能被断言钉住。
 */

/**
 * 一次喂给模型的正文字符上限。超了按段落等距抽样（见 `buildEpisodeDigestInput`）。
 *
 * ★ 0.85.0 从 30,000 收到 12,000。起因是 `agnes-ai/agnes-3.0-flash` 那次 400：
 *   宿主默认请求的 `max_tokens` 超过模型上限 65536，模型把整次请求打回来了。
 *   插件**改不了宿主的 max_tokens**（`ctx.llm.stream` 不给插件这个参数），能做的
 *   是把输入压短、把报错说准。3 万字中文约 3–4 万 token，加上输出预留，最容易
 *   顶到小模型的窗口；1.2 万字仍有等距抽样保证后半段不失明，代价是覆盖更稀。
 */
export const EPISODE_DIGEST_MAX_CHARS = 12_000;

/** 少于一集这么多字就不值得生成导读（多半是识别失败或纯音乐）。 */
export const EPISODE_DIGEST_MIN_CHARS = 800;

/** `mm:ss` 或 `h:mm:ss` → 秒。认不出来给 undefined（不要给 0，0 表示「开头」）。 */
export function parseStamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  const parts = text.split(':');
  if (parts.length > 3) return undefined;
  let seconds = 0;
  for (const part of parts) {
    const number = Number(part);
    if (!Number.isFinite(number) || number < 0) return undefined;
    seconds = seconds * 60 + number;
  }
  return Math.round(seconds);
}

/** `192` → `03:12`。与界面上的时间戳用的是同一个口径（`formatClock` 的简化版）。 */
export function stampText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${two(minutes)}:${two(secs)}`;
}

/**
 * 组装喂进去的字幕。
 *
 * ★ 每行前面带 `[mm:ss]`：模型据此拿到真实时间轴，不需要（也不许）自己算。
 * ★ 超长时**等距抽样**而不是掐掉尾巴：一期三小时的节目，掐掉尾巴等于让导读对
 *   后两小时完全失明，而用户最想知道的恰恰是「后半段讲了什么」。抽掉的行用 `…`
 *   顶上，让模型知道这里跳过了一段（否则它会把前后两段当成连续的）。
 */
export function buildEpisodeDigestInput({ title = '', channel = '', paragraphs = [], maxChars = EPISODE_DIGEST_MAX_CHARS } = {}) {
  const list = (Array.isArray(paragraphs) ? paragraphs : [])
    .map((item) => ({ start: Math.max(0, Number(item?.start) || 0), text: String(item?.text ?? '').replace(/\s+/g, ' ').trim() }))
    .filter((item) => item.text !== '');
  const lines = list.map((item) => `[${stampText(item.start)}] ${item.text}`);
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  let body;
  let sampled = false;
  if (total <= maxChars) {
    body = lines.join('\n');
  } else {
    sampled = true;
    const keep = Math.max(1, Math.floor((lines.length * maxChars) / total));
    const step = lines.length / keep;
    const picked = [];
    for (let index = 0; index < keep; index += 1) {
      const at = Math.min(lines.length - 1, Math.round(index * step));
      picked.push(lines[at]);
      if ((index + 1) * step - Math.floor((index + 1) * step) === 0) picked.push('…');
    }
    body = picked.join('\n');
  }
  const head = [title, channel].map((part) => String(part ?? '').trim()).filter((part) => part !== '').join(' · ');
  return { head, body, sampled, lines: lines.length, chars: body.length };
}

/** 提示词。单独导出，测试可以直接断言那几条硬约束还在。 */
export function buildEpisodeDigestPrompt() {
  return [
    '你在一份播客字幕上做导读。字幕每一行以 [分:秒] 开头，那是这句话在音频里的位置。',
    '',
    '输出一个 JSON 对象，不要解释、不要代码块，字段如下：',
    '{',
    '  "title": "这一期的主题，一句话，不超过 24 字",',
    '  "summary": "3–5 句：这一期在讨论什么、结论是什么。像在跟朋友转述，不要写「本期节目」。",',
    '  "chapters": [',
    '    {"at": "12:30", "title": "这一段在聊什么，不超过 16 字", "points": ["具体论点或信息，1–3 条，每条一句话"]}',
    '  ],',
    '  "people": ["出现的人名或身份，如「张三（某公司 CTO）」，没有就给空数组"],',
    '  "quotes": [{"at": "24:10", "text": "一句值得记下来的原话，照抄字幕，不超过 60 字"}]',
    '}',
    '',
    '硬约束：',
    '- 时间戳一律照抄输入里出现过的 [分:秒]，绝不自己估算、绝不写输入里没有的时间。',
    '- chapters 按时间从早到晚，4–8 段；一期只有十几分钟时可以只给 2–3 段。',
    '- quotes 最多 3 条，必须逐字照抄某一行（可以截取半句），不要改写。',
    '- 只用字幕里出现的信息。没提到的人、没说的结论、没给的数字，一律不要补。',
    '- 中文输出。专有名词（人名、公司、产品、代号）保留原文写法。',
  ].join('\n');
}

/** 把 `at` 落到「真正的段落起点」上：取不晚于它的最后一段。 */
export function snapToParagraph(at, paragraphs) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  if (list.length === 0) return undefined;
  const value = Math.max(0, Number(at) || 0);
  let best;
  for (const paragraph of list) {
    const start = Math.max(0, Number(paragraph?.start) || 0);
    if (start <= value + 0.5) best = start;
    else break;
  }
  return best ?? Math.max(0, Number(list[0]?.start) || 0);
}

/**
 * 解析模型输出。
 *
 * ★ 容错顺序：直接 `JSON.parse` → 剥代码块 → 取第一个 `{…}`。这三种都要试，
 *   因为「不要代码块」这条要求模型偶尔会无视，而一次无视就整份导读作废。
 * ★ 时间戳**必须**过 `snapToParagraph`：模型把 12:30 写成 12:28 是常态（它在
 *   心算），而 12:28 在字幕里可能落在上一段 —— 点下去会跳到上一句，用户会以为
 *   导读在胡说。吸附到段落起点后，跳转永远落在「时间戳最接近的那一段」。
 * ★ 认不出时间的章节**降级保留**（`at: 0`，界面上不显示时间按钮），而不是整份
 *   丢掉：内容仍然是有效的导读，只是不能点。
 *
 * @returns {{title:string, summary:string, chapters:Array, people:string[], quotes:Array, droppedChapters:number}}
 */
export function parseEpisodeDigest(raw, { paragraphs = [], duration = 0 } = {}) {
  const text = String(raw ?? '').trim();
  if (text === '') throw new Error('模型没有返回内容');
  let payload;
  const attempts = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  if (fenced) attempts.push(fenced.trim());
  const braced = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (braced) attempts.push(braced);
  for (const attempt of attempts) {
    try {
      payload = JSON.parse(attempt);
      break;
    } catch {
      payload = undefined;
    }
  }
  if (payload === undefined || typeof payload !== 'object' || payload === null) {
    throw new Error('模型返回的不是 JSON');
  }

  const limit = Number(duration) > 0 ? Number(duration) + 10 : Number.POSITIVE_INFINITY;
  let droppedChapters = 0;
  const chapters = [];
  for (const item of Array.isArray(payload.chapters) ? payload.chapters : []) {
    const title = String(item?.title ?? '').trim();
    const points = (Array.isArray(item?.points) ? item.points : [])
      .map((point) => String(point ?? '').trim())
      .filter((point) => point !== '')
      .slice(0, 4);
    if (title === '' && points.length === 0) { droppedChapters += 1; continue; }
    const parsed = parseStamp(item?.at);
    const snapped = parsed === undefined || parsed > limit ? undefined : snapToParagraph(parsed, paragraphs);
    chapters.push({ at: snapped === undefined ? 0 : snapped, title, points });
  }
  chapters.sort((a, b) => a.at - b.at);

  const quotes = [];
  for (const item of Array.isArray(payload.quotes) ? payload.quotes : []) {
    const quote = String(item?.text ?? '').trim();
    if (quote === '') continue;
    const parsed = parseStamp(item?.at);
    const snapped = parsed === undefined || parsed > limit ? undefined : snapToParagraph(parsed, paragraphs);
    quotes.push({ at: snapped === undefined ? 0 : snapped, text: quote });
    if (quotes.length >= 3) break;
  }

  return {
    title: String(payload.title ?? '').trim().slice(0, 60),
    summary: String(payload.summary ?? '').trim().slice(0, 1200),
    chapters,
    people: (Array.isArray(payload.people) ? payload.people : [])
      .map((person) => String(person ?? '').trim())
      .filter((person) => person !== '')
      .slice(0, 12),
    quotes,
    droppedChapters,
  };
}

/** 导读有没有实质内容（空壳不许落盘，否则界面会一直显示一张空卡）。 */
export function isEmptyDigest(digest) {
  if (!digest || typeof digest !== 'object') return true;
  return String(digest.summary ?? '').trim() === '' && (digest.chapters ?? []).length === 0;
}
