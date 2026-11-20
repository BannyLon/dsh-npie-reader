/**
 * 日记的格式层：日期 ↔ 文件名、一天的 .md ↔ 条目数组。
 *
 * 浏览器半区与宿主半区**共用这一份**（与 `library.js`、`reading-settings.js` 同一定位）。
 * 两边各写一份解析的后果不是「重复」，而是**对同一段文字给出不同结果** —— 界面上
 * 数出 3 条、宿主导出 2 条，而两边都"对"。
 *
 * 一天一个文件，内部按 `## HH:MM 类型 · 来源` 分条。
 * ★ 为什么不一天多个文件：用户原来的 Obsidian 库里被 `-HHmm` 后缀折磨过
 *   （19 篇时间戳文件 + 3 篇 `-1` 冲突副本），一天一篇才看得完当天所有想法。
 * ★ 为什么类型和来源写在标题行而不是正文里：标题行是**人可读**的（在纯文本编辑器里
 *   一眼就看懂），也是**机可读**的（一个正则），还不用往正文里塞 HTML 注释。
 */

/** 日记的 HTTP 前缀（与 `LIBRARY_API_PREFIX` 并列，不复用它 —— 正文读写不该挤在书架那条分派里）。 */
export const DIARY_API_PREFIX = '/api/dsh-npie-reader/diary';

/** 一天里一条记录的开头。`kind` 与 `source` 用 ` · ` 分隔。 */
const ENTRY_LINE = /^## (\d{2}:\d{2})(?:\s+(.*))?$/;
const SEP = ' · ';

/**
 * 条目的类型。**由「你在哪个模块里写」决定，不由用户手选**（0.31.0 改）。
 *
 * ★ 0.30.0 曾把它做成记录框上的一排按钮（灵感 / 读后感 / 书摘），这是错的：
 *   用户要的是**三个功能模块**（灵感速记坞 / 私密日记本 / 读后感工作台），
 *   「书摘」根本不在他的设计里 —— 金句摘录属于读后感模板的一部分，不是一种条目类型。
 *   类型现在只服务**解析与渲染**（标题行上那一小段），不再是界面上的选择题。
 */
export const ENTRY_KINDS = Object.freeze(['灵感', '日记', '读后感']);
/**
 * 老数据里可能出现的类型。**只解析、不再新建**：用户 0.30 写过的「书摘」条目
 * 必须原样读出来、原样写回去（`entryHeading` 认它），否则一次「删掉别的条目」
 * 的重写就会把那些条目的类型静默改成「灵感」。
 */
export const LEGACY_KINDS = Object.freeze(['书摘']);
const KIND_SET = new Set([...ENTRY_KINDS, ...LEGACY_KINDS]);

/**
 * 三个功能模块。界面按它组织，`kind` / `vis` 由模块决定。
 *
 * ★ 一个模块 = 一种写入形态：灵感是**极简**（打开即写）、私密是**加密**、
 *   读后感是**结构化**（模板 + 划线引用）。把它们做成「同一张表单的三个类型按钮」
 *   会让三件不同的事长成同一个样子，而用户要的正是三种不同的入口。
 */
export const DIARY_MODULES = Object.freeze([
  { value: 'inspiration', label: '灵感速记', kind: '灵感', vis: 'public' },
  { value: 'private', label: '私密日记', kind: '日记', vis: 'private' },
  { value: 'reflection', label: '读后感', kind: '读后感', vis: 'public' },
]);

/**
 * 读后感的结构化模板（用户原文：「一句话总结、核心收获、行动指南、金句摘录」）。
 *
 * ★ 只是**预填的 Markdown 骨架**，不是表单字段：日记最终是纯文本文件，
 *   把它拆成四个 input 再拼回去，用户在 Obsidian 里手改过的痕迹就全没了。
 */
export const REFLECTION_TEMPLATE = [
  '## 一句话总结',
  '',
  '## 核心收获',
  '',
  '## 行动指南',
  '',
  '## 金句摘录',
  '',
].join('\n');

/**
 * 五档心情。
 *
 * ★ `tone`（1..5）只服务**界面**：CSS 按它取那一档的颜色（`[data-tone="4"]`），
 *   `score` 只服务**数据**（`moodScore()` 算一天的平均分、日历上的情绪点）。
 *   现在两个数恰好同值，但它们**是两个契约** —— 调配色不该动统计口径，
 *   改统计口径也不该连带换掉五个色块。
 *
 * ★ 用户 2026-10-27 的反馈是「emoji 很不明显、不够清楚」。三个原因叠在一起，
 *   只换 emoji 治不了：
 *     ① CSS 里 `filter: grayscale(.55)` + `opacity: .7` 把它们**默认灰掉了**；
 *     ② 26px 的方块里塞 14px 的字，macOS 上渲染出来只有指甲盖大；
 *     ③ 只有 emoji、没有文字，`😕` 和 `😐` 在 14px 下几乎分不开。
 *   所以这里顺手把「有点烦」从 `😕` 换成轮廓差异更大的 `😣`（皱眉闭眼），
 *   真正的修法在 `refinements.css`：放大、给中文标签、选中时按 tone 染色。
 *   参考的是 Daylio 那套「五档 + 颜色 + 文字标签」（它是情绪追踪这个品类的标杆），
 *   以及 StoryPad（GitHub 上星数最高的开源日记本）把情绪当**独立一栏**而不是
 *   挤在角落的做法。
 */
export const MOODS = Object.freeze([
  { emoji: '😄', label: '很好', score: 5, tone: 5 },
  { emoji: '🙂', label: '还行', score: 4, tone: 4 },
  { emoji: '😐', label: '一般', score: 3, tone: 3 },
  { emoji: '😣', label: '有点烦', score: 2, tone: 2 },
  { emoji: '😔', label: '低落', score: 1, tone: 1 },
]);
const MOOD_SCORE = new Map(MOODS.map((mood) => [mood.emoji, mood.score]));
/**
 * 0.31.0 之前「有点烦」写的是 `😕`。
 * ★ 换 emoji 不能把老数据弄丢：那些条目仍然存在、仍然能显示，只是 `moodScore()`
 *   认不出它 ⇒ 日历上的情绪点会缺一格，而用户看不出是「那天没记情绪」还是
 *   「那天记的情绪版本更老」。所以旧值必须留着映射。
 */
const MOOD_ALIAS = new Map([['😕', '😣']]);

/** 把老版本存下的心情值换成当前这一版的 emoji（认不出就原样返回）。 */
export function normalizeMood(emoji) {
  return MOOD_ALIAS.get(emoji) ?? emoji;
}

/**
 * 条目元数据的承载形式：标题行下一行的 **HTML 注释**。
 *
 *   ## 14:32 书摘 · 《深度工作》第 3 章
 *   <!-- npr {"mood":"🙂","book":"b7f3","chapter":3,"page":128} -->
 *
 * ★ 为什么不是写进标题行：标题行是**人可读**的（在纯文本编辑器里一眼看懂），
 *   塞 `book: b7f3` 进去就成了机器码；而 ` · ` 分隔的字段一旦多起来，
 *   任何一段自由文本里的 ` · ` 都会把解析搞错。
 * ★ 为什么不是 YAML frontmatter：frontmatter 只有文件级一份，而**一天有多条**。
 * ★ 为什么是 HTML 注释：Markdown 合法、Obsidian / GitHub / 任何渲染器都看不见，
 *   但纯文本里看得见（用户想手改也改得动）。删掉它只会降级成「没关联 / 没情绪」，
 *   解析不会抛错 —— 用户手改 Markdown 是这个功能必须容忍的事。
 */
export const META_OPEN = '<!-- npr ';
const META_LINE = /^<!--\s*npr\s+(\{.*\})\s*-->\s*$/;

/**
 * 便签墙的六种纸色（0.64.0）。
 *
 * ★ 落盘的是**色名**，不是 `#rrggbb`：颜色得跟着主题走（深浅两套底色），
 *   存一个十六进制值等于把「写这一条时用的那套主题」焊进文件里 ——
 *   换到深色主题下，那批便签会变成六块自发光的东西。
 * ★ 顺序即色板的顺序（写字卡上那排圆点的从左到右），不要随手重排：
 *   老条目的 `tone` 是色名，改了顺序不会错色，但会让「默认第一色」从黄变成别的。
 */
export const NOTE_TONES = Object.freeze(['amber', 'rose', 'sky', 'mint', 'lilac', 'cream']);

/** 元数据里允许出现的字段。**白名单**：多一个字段也不会被写回去，避免把脏数据带进文件。 */
const META_FIELDS = Object.freeze(['mood', 'book', 'chapter', 'page', 'article', 'tone', 'vis']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时区的 `YYYY-MM-DD`。★ 不能用 `toISOString()` —— 那是 UTC，晚上 8 点后会变成明天。 */
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地时区的 `HH:MM`。 */
export function timeKey(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function dayFileName(key) {
  return `${key}.md`;
}

/**
 * `YYYY-MM-DD` 且真的是一个存在的日期。
 * ★ `2026-13-45` 也要被拒：只查正则的话它会通过，然后落成一个永远打不开的文件名。
 */
export function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime()) && dateKey(parsed) === value;
}

/** `YYYY-MM` 且月份合法。 */
export function isValidMonthKey(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** 一天的文件头。`status` 只服务「能不能发公众号」，与 Obsidian 无关。 */
export function buildFrontmatter(key) {
  return `---\ndate: ${key}\ntype: daily\nstatus: 草稿\n---\n`;
}

/**
 * 切出 frontmatter 与正文。
 * 切不开就**整段当正文**，不抛错 —— 用户手工把 `---` 删掉一半是常事，
 * 那种情况下丢掉他的正文比丢掉一个 frontmatter 严重得多。
 */
export function splitFrontmatter(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source.startsWith('---\n')) return { front: '', body: source };
  const end = source.indexOf('\n---\n', 3);
  if (end < 0) return { front: '', body: source };
  return { front: source.slice(0, end + 5), body: source.slice(end + 5) };
}

/** 标题行：`## 09:31 灵感 · 引自《示例书名》第 3 章`。 */
export function entryHeading(entry) {
  const kind = KIND_SET.has(entry.kind) ? entry.kind : '灵感';
  const source = typeof entry.source === 'string' ? entry.source.trim() : '';
  return `## ${entry.time} ${kind}${source ? SEP + source : ''}`;
}

/**
 * 把任意输入洗成一个**只含白名单字段**的元数据对象。
 *
 * ★ 校验一律「丢弃」而不是「抛错」：元数据是可选的附注，一个坏字段不该让整条
 *   日记读不出来。用户手改 Markdown 时写坏一个引号是常事。
 */
export function normalizeMeta(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const meta = {};
  /*
   * ★ 判据必须是 `moodScore()` 而不是 `MOOD_SCORE.has()`：0.32.0 把「有点烦」的
   *   emoji 从 `😕` 换成 `😣`，直接查表会让**所有老条目在读取时静默丢掉心情** ——
   *   文件里那行元数据还在，但界面上的表情没了、日历上那天的点也退回灰色。
   *   `moodScore()` 走 `MOOD_ALIAS`，认得出旧值；写回时统一换成当前这一版的 emoji，
   *   所以同一份数据两次读出来是同一个值（不会「这次 😕、下次 😣」）。
   */
  const mood = moodScore(source.mood);
  if (mood !== null) meta.mood = normalizeMood(source.mood);
  if (typeof source.book === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(source.book)) meta.book = source.book;
  /*
   * `article`：读 RSS 时按 L 记的灵感挂在哪一篇上（订阅源里的 `key`）。
   *
   * ★ 与 `book` 不同，这里的 key 不是 `[A-Za-z0-9_-]` —— 它可能带 URL 片段（`:` `/` `#`）。
   *   但它同样要能安全地放进那行 JSON 注释里：只禁两样 —— 会提前结束注释的 `-->`，
   *   和换行（会让整行注释断成两行，后半截变成正文）。其余交给 `JSON.stringify` 转义。
   * ★ 为什么不复用 `book`：一本书和一个订阅源是两种东西，混进同一个字段之后
   *   「按书反查」就会捞到文章。宁可多一个字段。
   */
  if (typeof source.article === 'string'
    && source.article.length >= 1 && source.article.length <= 200
    && !source.article.includes('-->')
    && !/[\r\n]/.test(source.article)) meta.article = source.article;
  for (const field of ['chapter', 'page']) {
    const value = Number(source[field]);
    if (Number.isInteger(value) && value >= 0) meta[field] = value;
  }
  /*
   * `tone`：这一条便签用哪张纸（见 `NOTE_TONES`）。
   * ★ 不在表里的值**丢弃**而不是改写：用户拿别的编辑器手改 Markdown，
   *   写个 `"tone": "红色"` 是他的自由。丢掉这一格只会退回「按位置自动配色」，
   *   而抛错会让整条日记读不出来 —— 一个颜色不该有这种权力。
   */
  if (NOTE_TONES.includes(source.tone)) meta.tone = source.tone;
  if (source.vis === 'private') meta.vis = 'private';
  return meta;
}

/** 元数据 → 那一行注释；没有内容时返回空串（**不写空行**，普通灵感就保持原样）。 */
export function metaLine(input) {
  const meta = normalizeMeta(input);
  const keys = Object.keys(meta);
  if (keys.length === 0) return '';
  // 字段顺序固定：同一份数据两次写出来必须逐字节相同（否则「追加」会看起来改了历史）。
  const ordered = {};
  for (const field of META_FIELDS) if (meta[field] !== undefined) ordered[field] = meta[field];
  return `${META_OPEN}${JSON.stringify(ordered)} -->`;
}

/** 一行文本是不是元数据行；是则返回解析结果（解析失败也认它是元数据行，只是返回 `{}`）。 */
export function parseMetaLine(line) {
  const hit = META_LINE.exec(typeof line === 'string' ? line : '');
  if (!hit) return null;
  try {
    return normalizeMeta(JSON.parse(hit[1]));
  } catch {
    // 认这一行是元数据、但内容是坏的 ⇒ 返回空对象把它**吃掉**，不让它混进正文。
    // 若返回 null，它会以一行看不懂的注释出现在正文里，用户会以为日记被写坏了。
    return {};
  }
}

/**
 * 正文里的 `#标签`。
 *
 * ★ 边界取**宽松**的一档（行首 / 空白 / 中文标点都算）：Obsidian 只认「行首或空格」，
 *   而中文写作里 `。#灵感` 不带空格是常态 —— 严格照抄 Obsidian 会让用户以为打了标签
 *   却没生效，而**这个失败是看不见的**（正文里明明有 `#灵感`，筛选时找不到）。
 *   代价是极少数 `#` 开头但 Obsidian 不认的片段我们认了，比漏认安全。
 * ★ 纯数字不算标签（`#1` 更像编号 / issue 号）；`## 标题` 不算（第二个字符是 `#`）。
 */
const TAG_RE = (() => {
  // 用字符串拼正则而不是字面量：这里要放进的标点太多（`[`、`]`、反引号），
  // 写成字面量时人眼根本分不清哪个方括号是语法、哪个是字符。
  const boundary = '\\s，。、；：！？,.;:!?（(【\\[「『《>';
  const tagChar = '[^\\s#，。、；：！？,.;:!?（）()【】\\[\\]「」『』《》"\'`]';
  // ★ 末尾那个 `(?!…)` 不是装饰：没有它，`{1,24}` 会**截断**超长的连写片段
  //   （25 个字 ⇒ 静默变成 24 个字的标签）。截断出来的标签在正文里根本不存在，
  //   点进去搜不到 —— 比「不认这个标签」坏得多。有了它，超长片段整个不算标签。
  return new RegExp(`(?:^|[${boundary}])#(${tagChar}{1,24})(?!${tagChar})`, 'gu');
})();

/**
 * 把 Markdown 的**链接目标**剥掉，只留人读的部分（0.73.1）。
 *
 * 图片 `![说明](地址)` 留说明（没有说明给「［图片］」），链接 `[文字](地址)` 留文字。
 *
 * ★ 为什么这不是「预览层的美化」，而必须放进**共用**模块：宿主与客户端各自需要它，
 *   而两边各写一份正则，必然有一天漂移成两种行为 —— 界面上写着「［图片］」，
 *   `diary_search` 却因为地址里含 `assets` 把每条贴过图的灵感都搜出来。
 *   同一件事只能有一份实现（与 `paperAsBook()` 那条规则同源）。
 *
 * ★ 收尾括号允许缺失：宿主给的预览是**正文前 60 字**，而一条图片地址本身就有
 *   六十来字 —— 截断之后剩一个没有右括号的 `![](`，按「必须成对」写就会原样
 *   漏出半截网址。漏出来比不剥还难看。
 */
export function stripInlineTargets(input) {
  let text = String(input ?? '');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)?/g, (_, alt) => (String(alt).trim() === '' ? '［图片］' : alt));
  text = text.replace(/\[([^\]]+)\]\([^)]*\)?/g, '$1');
  return text;
}

/** 一段正文里的标签（去重、保持出现顺序）。 */
export function parseTags(body) {
  const text = typeof body === 'string' ? body : '';
  const out = [];
  const seen = new Set();
  for (const hit of text.matchAll(TAG_RE)) {
    const tag = hit[1].replace(/[。，、；：！？,.;:!?]+$/, '');
    if (tag === '' || /^\d+$/.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * 条目的 `source` 拆成「挂在哪儿」。
 *
 * 格式是 `《书名》 · 第 3 章`（书）或 `文章标题`（RSS 文章）。返回值：
 * `{ isBook, title, label }` —— `title` 不带外层书名号，`label` 是给人看的那串。
 *
 * ★ **必须容忍书名里自带书名号**。书源里的标题本来就长这样：
 *   `《译文名著文库》 076[法]雨果-九三年（叶尊译，上海译文出版社2011）`。
 *   0.38 之前写进 `source` 时又套了一层 ⇒ 存成
 *   `《《译文名著文库》 076[...]》 · 第三卷`，当时按「第一个 `》` 前的内容」取键，
 *   得到畸形的 `《《译文名著文库》`；侧栏显示成 `《《译文名著文库》》`，点进去的
 *   筛选条也是这串。用户 2026-10-27 的截图就是它。
 * ★ 解法是**剥到没有外层书名号为止**，再决定要不要显示书名号：
 *   剥完的结果里若已经含 `《`，说明书名本身带书名号，原样显示；否则补一对。
 *   ⇒ 老数据一条都不用迁移，新写入也不会再出现双套（见 `QuickCapture`）。
 * ★ 空串返回 `null`：没有来源的灵感不进任何分组，也不该被硬塞一个「未分类」。
 */
export function parseSource(source) {
  const text = String(source ?? '').trim();
  if (text === '') return null;
  // 只有书名号开头才当成书；文章标题里可能出现 ` · `（「A · B」是常见写法），
  // 对文章做切分会把它截断成一个搜不到的标题。
  if (!text.startsWith('《')) return { isBook: false, title: text, label: text };
  const head = text.split(/\s+·\s+/)[0].trim();
  let body = head;
  while (body.length > 2 && body.startsWith('《') && body.endsWith('》')) {
    body = body.slice(1, -1).trim();
  }
  if (!body || /^[《》\s]*$/.test(body)) return null;
  return { isBook: true, title: body, label: body.includes('《') ? body : `《${body}》` };
}

/**
 * 反向：把「书名 + 章」拼成 `source`（`《深度工作》 · 第 3 章`）。
 *
 * ★ 必须和 `parseSource()` 同处一个文件：一个是「拼」，一个是「拆」，
 *   两边的剥壳规则一旦分家，写进去的和读出来的就会对不上
 *   （0.38 的双书名号 `《《…》》` 就是两边各拼了一次造成的）。
 * ★ 书名本身带书名号时**不再套一层**：书源里的标题本来就长这样
 *   `《译文名著文库》 076[法]雨果-九三年`，再套就成了两层。
 * ★ 没选章就只给书名，不拼一个空的 `· `。
 */
export function sourceLabel(title, chapterTitle) {
  const name = String(title ?? '').trim();
  if (name === '') return '';
  const quoted = name.includes('《') ? name : `《${name}》`;
  const chapter = String(chapterTitle ?? '').trim();
  return chapter === '' ? quoted : `${quoted} · ${chapter}`;
}

/**
 * 一条灵感**何时**记的（`今天 16:37` / `昨天 16:37` / `10-27 16:37`）。
 *
 * ★ 为什么不能只给时刻（用户 2026-10-29 的原话）：
 *   「书展开的灵感条目是以时间开头的，时间开头有什么用，不应该是日期+时间吗？」
 *   —— 侧栏「按书本 / 按文章」里，同一本书的灵感到来自不同天，`16:37` 只能回答
 *   「几点」，回答不了「哪天」。而日期栏在展开区里是**不出现**的（那里没有「天」这一层）。
 * ★ 为什么不用 `10 月 27 日 16:37`：268px 的侧栏里那串要占掉一整行，而条目正文
 *   只剩两行可看。`10-27` 与正文里的日期写法一致（时间轴、日历都是这个格式），
 *   省下来的宽度留给正文。
 * ★ 今天 / 昨天仍写成词：这两天占绝大多数，写词比写数字快一眼。
 */
export function stampLabel(date, time, today = '') {
  const key = String(date ?? '').trim();
  const clock = String(time ?? '').trim();
  let head = key;
  if (key !== '' && key === today) head = '今天';
  else {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    // 不是 `YYYY-MM-DD` 就原样用（老数据 / 手改过的文件名不该被这里吞掉）。
    if (parts !== null) head = `${parts[2]}-${parts[3]}`;
  }
  if (clock === '') return head;
  return head === '' ? clock : `${head} ${clock}`;
}

/** 情绪 → 分数；不认识的返回 null（曲线要能区分「没有情绪」和「情绪最低」）。 */export function moodScore(emoji) {
  if (typeof emoji !== 'string' || emoji === '') return null;
  return MOOD_SCORE.get(emoji) ?? MOOD_SCORE.get(normalizeMood(emoji)) ?? null;
}

/**
 * 一天的 .md → 条目数组。
 *
 * `body` 保留**行内换行与缩进**（只裁掉首尾空行）：日记里的列表、引用、代码块
 * 全靠这些空白，`trim()` 一刀切会让它们全部塌成一段。
 */
export function parseDay(text) {
  const { front, body } = splitFrontmatter(typeof text === 'string' ? text : '');
  const entries = [];
  let current = null;
  /** 刚读到标题行、还没读到任何正文行 —— 元数据只可能出现在这个位置。 */
  let atHead = false;
  const flush = () => {
    if (current === null) return;
    current.body = current.body.replace(/^\n+/, '').replace(/\s+$/, '');
    entries.push(current);
    current = null;
  };
  for (const line of body.split('\n')) {
    const hit = ENTRY_LINE.exec(line);
    if (hit) {
      flush();
      const rest = (hit[2] ?? '').trim();
      const at = rest.indexOf(SEP);
      const kindRaw = at < 0 ? rest : rest.slice(0, at);
      current = {
        time: hit[1],
        kind: KIND_SET.has(kindRaw) ? kindRaw : '灵感',
        source: at < 0 ? '' : rest.slice(at + SEP.length).trim(),
        meta: {},
        body: '',
      };
      atHead = true;
      continue;
    }
    if (current !== null) {
      // 元数据行只在「标题行之后、正文第一行之前」被认；写在正文中间的注释
      // 属于用户自己写的内容，绝不能悄悄吃掉。
      if (atHead) {
        if (line.trim() === '') continue; // 标题与元数据之间的空行不算正文
        const meta = parseMetaLine(line);
        if (meta !== null) { current.meta = meta; atHead = false; continue; }
        atHead = false;
      }
      current.body += `${line}\n`;
    }
  }
  flush();
  return { front, entries };
}

/** 一条日记写进 .md 时的完整块（标题行 + 可选元数据行 + 正文）。 */
export function entryBlock(entry) {
  const meta = metaLine(entry?.meta);
  const head = meta === '' ? entryHeading(entry) : `${entryHeading(entry)}\n${meta}`;
  return `${head}\n\n${(entry.body ?? '').trim()}\n`;
}

/** 把一天写成 .md 全文。 */
export function buildDay(key, entries) {
  const blocks = entries.map((entry) => entryBlock(entry));
  return `${buildFrontmatter(key)}\n${blocks.join('\n')}`.replace(/\n{3,}/g, '\n\n');
}

/**
 * 追加一条，返回新全文。
 *
 * ★ 不复用 `buildDay(parseDay(text))` 再整体写回：那会把用户手工改过的
 *   frontmatter、条目之间的空行、正文里刻意留的空格全部规范化 —— 一次「追加」
 *   顺手改掉了他上一次编辑，而界面上看不出任何变化。
 * ⇒ 只做字符串拼接，**旧内容逐字节保留**。
 */
export function appendEntryText(text, entry) {
  const base = typeof text === 'string' && text.trim() !== '' ? text.replace(/\s+$/, '\n') : `${buildFrontmatter(entry.date ?? '')}\n`;
  const block = entryBlock(entry);
  const head = base.endsWith('\n\n') ? base : `${base}\n`;
  return `${head}${block}`;
}

/** 按序号取出一条，越界返回 null。 */
export function entryAt(text, index) {
  const { entries } = parseDay(text);
  return Number.isInteger(index) && index >= 0 && index < entries.length ? entries[index] : null;
}

/**
 * 按序号删掉一条，返回新全文。
 *
 * 重写时只重排「条目块」，frontmatter 与块之间的空行沿用 `buildDay` 的规范形 ——
 * 删除本来就是一次结构性编辑，用户对那一块的格式不会再有别的期待。
 * 但它**只在这一个文件内**生效，不会连带碰到别的日期。
 */
export function removeEntryText(text, index) {
  const { entries } = parseDay(text);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) return null;
  const kept = entries.filter((_, at) => at !== index);
  const key = (splitFrontmatter(text).front.match(/^date:\s*(\S+)/m) ?? [])[1] ?? '';
  return { key, entries: kept, text: buildDay(key, kept) };
}

/**
 * 按序号改写一条，返回新全文。
 *
 * ★ 只改**这一条**：时间、类型、来源、元数据都沿用原来的，除非 `patch` 里显式给了。
 *   「改写正文」不该顺手把 09:30 变成现在的时刻 —— 那会让时间轴上的位置说谎。
 * ★ 与 `removeEntryText` 一样走 `buildDay` 重排：改写本来就是一次结构性编辑。
 * ★ `patch.body` 允许为空串以外的一切；空串视为「不合法」由调用方（store）拦，
 *   否则一次误调用就会把一条日记悄悄清空 —— 删除有 `removeEntry`，不该用改写代替。
 */
export function updateEntryText(text, index, patch = {}) {
  const { entries } = parseDay(text);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) return null;
  const before = entries[index];
  const next = {
    ...before,
    ...(typeof patch.body === 'string' ? { body: patch.body } : {}),
    ...(typeof patch.time === 'string' && patch.time !== '' ? { time: patch.time } : {}),
    ...(typeof patch.kind === 'string' && patch.kind !== '' ? { kind: patch.kind } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : {}),
    ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
  };
  const entries2 = entries.map((entry, at) => (at === index ? next : entry));
  const key = (splitFrontmatter(text).front.match(/^date:\s*(\S+)/m) ?? [])[1] ?? '';
  return { key, before, entry: next, entries: entries2, text: buildDay(key, entries2) };
}

/** 一天的总字数。★ 口径：**去掉所有空白后的字符数**，与界面上显示的那个数字同源。 */export function dayCharCount(entries) {
  return entries.reduce((sum, entry) => sum + (entry.body ?? '').replace(/\s/g, '').length, 0);
}

/**
 * 一个月的月历网格（6 行 × 7 列，周日开头）。
 * 返回的每一格都带 `key`（`YYYY-MM-DD`），**不在本月的格子也有** —— 界面上把它画淡，
 * 用户点它就该能跳过去，而不是点了没反应。
 */
export function monthGrid(year, month0, todayKey = dateKey()) {
  const first = new Date(year, month0, 1);
  const offset = first.getDay();
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(year, month0, 1 - offset + i);
    const key = dateKey(date);
    cells.push({ key, day: date.getDate(), inMonth: date.getMonth() === month0, today: key === todayKey });
  }
  return cells;
}

/** 月份加减（跨年）。 */
export function shiftMonth(year, month0, delta) {
  const date = new Date(year, month0 + delta, 1);
  return { year: date.getFullYear(), month0: date.getMonth() };
}

/** `2026-10` → `{ year: 2026, month0: 9 }`。非法返回 null。 */
export function parseMonthKey(value) {
  if (!isValidMonthKey(value)) return null;
  return { year: Number(value.slice(0, 4)), month0: Number(value.slice(5, 7)) - 1 };
}

export function monthKeyOf(year, month0) {
  return `${year}-${pad2(month0 + 1)}`;
}
