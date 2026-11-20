/**
 * 灵感速记浮层的两件「事后」逻辑：**未写完的草稿** 与 **保存后的回执**。
 *
 * ★ 为什么单独一个文件、而且全是纯函数：这两件事都在浮层里，但判据都不是「画得对不对」
 *   —— 草稿要判过期、要判坏数据、要判「空的不算草稿」；回执要判数字口径；
 *   撤销要先核对文件里那一条还是不是原来那条。塞进 `QuickCapture.jsx` 里就只能靠
 *   人眼在 JSX 里找，而这里每一件都曾经在别处出过错（见下）。
 *
 * ★ 用户 2026-11-10 提的原话是「对比乔木闪记，我这边的灵感记录差在哪」——
 *   对照下来缺口全在「写完那一刻」：Jot 的回执永远带「撤销 / 补充 / 打开」，
 *   而这里保存成功后只剩一句死文本，关掉浮层连没写完的半句也一起没了。
 */

/**
 * 草稿落在 `localStorage` 的哪个键。
 *
 * ★ 只用**一个**键（不是按上下文各存一份）：速记草稿是「刚才那半句」，
 *   同时存在两份时下一次按 `L` 就得先选一份，那是把「少一个决策」又还回去了。
 */
export const DRAFT_KEY = 'npr.quick.draft';

/**
 * 草稿的保质期。
 *
 * ★ 24 小时：一天的边界与日记的「今天」同一个概念。放更久的话，用户下周按 `L`
 *   会看到一句自己完全不记得的话 —— 那不是「帮你记住」，是「往浮层里塞垃圾」。
 */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** `localStorage` 在隐私模式 / 非浏览器环境里可能直接抛，取不到就当没有。 */
export function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** 两天是不是同一个本地日期。 */
function sameDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/**
 * 草稿的落盘形状。
 *
 * ★ `source` / `meta` / `where` **必须跟正文一起存**：草稿是「在《某书》里没写完的那句」，
 *   只存正文的话，第二天在另一本书里恢复出来，保存时就会挂到**错的书**上 ——
 *   而作者是用户本人，事后无从分辨。恢复时连同来源一起恢复，才不会串味。
 */
export function makeDraft({ body, at = Date.now(), source = '', meta = null, where = '' }) {
  return {
    body: typeof body === 'string' ? body : '',
    at: Number.isFinite(at) ? at : Date.now(),
    source: typeof source === 'string' ? source : '',
    meta: meta && typeof meta === 'object' ? meta : null,
    where: typeof where === 'string' ? where : '',
  };
}

/**
 * 读草稿。没有 / 空 / 过期 / 坏数据一律 `null`。
 *
 * ★ 坏数据（JSON 断了、`body` 不是字符串、`at` 不是数字）宁可当没有：
 *   抛错会让「按 L 打不开浮层」变成一个只在脏存储上出现的 bug。
 * ★ 但**不在这里顺手删**它：读函数有写副作用时，任何「读一下看看」的调用点
 *   都会悄悄吞掉用户的半句话。清理由 `clearDraft` 单独做。
 * ★ 未来时间不判过期（时钟回拨时的 `at` 会大于 `now`）：判过期只比 `now - at`。
 */
export function readDraft(storage = safeStorage(), now = Date.now()) {
  if (!storage) return null;
  let raw;
  try { raw = storage.getItem(DRAFT_KEY); } catch { return null; }
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.body !== 'string' || parsed.body.trim() === '') return null;
  if (!Number.isFinite(parsed.at)) return null;
  if (now - parsed.at > DRAFT_TTL_MS) return null;
  return makeDraft(parsed);
}

/**
 * 写草稿。正文是空的就把已有的删掉。
 *
 * ★ 「空的不算草稿」必须在写入侧也守一次（不只是读侧）：用户把字全删了再关掉浮层，
 *   下一次按 `L` 不该看到「已恢复 09:12 未写完的内容 · 清空」而底下空空如也。
 */
export function writeDraft(storage, draft, now = Date.now()) {
  if (!storage) return false;
  const body = typeof draft?.body === 'string' ? draft.body : '';
  if (body.trim() === '') return clearDraft(storage);
  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(makeDraft({ ...draft, body, at: now })));
    return true;
  } catch {
    // 配额满了（长文）也不该让「保存灵感」失败 —— 草稿是附加保障，不是主链路。
    return false;
  }
}

/** 删掉草稿。返回「原来有没有」。 */
export function clearDraft(storage = safeStorage()) {
  if (!storage) return false;
  try {
    const had = storage.getItem(DRAFT_KEY) != null;
    storage.removeItem(DRAFT_KEY);
    return had;
  } catch { return false; }
}

/**
 * 草稿是什么时候写的 —— 给恢复提示行用。
 *
 * ★ 同一小时里说 `09:12` 就够；隔了夜必须说「昨天」，否则「09:12 未写完」
 *   会被当成今早的（TTL 是 24 小时，跨天是常态而不是边界情况）。
 * ★ 分钟必须补零：`9:5` 会让人以为是两个数字而不是时间。
 */
export function draftWhen(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const when = new Date(at);
  const current = new Date(now);
  if (Number.isNaN(when.getTime())) return '';
  const clock = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
  if (sameDay(when, current)) return clock;
  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
  if (sameDay(when, yesterday)) return `昨天 ${clock}`;
  return `${when.getMonth() + 1} 月 ${when.getDate()} 日 ${clock}`;
}

/**
 * 保存成功后的那行回执。
 *
 * ★ `count` 用的是宿主返回的 `listedCount`（日记页顶栏会显示的那个数），**不是** `index + 1`：
 *   `index` 是公开侧**全部**条目的序号，而灵感模块的列表不含「读后感」。
 *   今天写过一篇读后感时，两个数字差 1 —— 回执说「第 3 条」而界面显示 2 条，
 *   就是一句可被当场证伪的话。
 * ★ 来源那一截沿用浮层里「挂在…上」的说法（用户已经见过这句），不另起一套措辞。
 */
export function receiptText({ count, where } = {}) {
  const parts = ['已记下'];
  if (Number.isInteger(count) && count > 0) parts.push(`今天第 ${count} 条`);
  if (typeof where === 'string' && where !== '') parts.push(`挂在${where}上`);
  return parts.join(' · ');
}

/**
 * 点「撤销」之前，先确认文件里那一格还是不是我们刚写的那条。
 *
 * 返回 `'match'`（可以删）/ `'gone'`（已经没了）/ `'changed'`（被改过或被别的删除挤了位）。
 *
 * ★ 为什么不直接按序号删：`index` 只在**那一刻**成立。回执的 8 秒里用户完全可能
 *   打开日记删掉上面一条 —— 之后同一个序号指向的是另一条记录，照删就是
 *   「撤销一句灵感，删掉一篇读后感」。
 * ★ 匹配口径用 `scope + index` **两个字段**（`readDayFull` 给每条都打了这两个），
 *   不用合并后的数组下标：公开与私密是两个文件、各有自己的序号，按下标找必然错位。
 * ★ 正文比较走 `trim()`：宿主写入时不去空格，但用户可能只是补了个回车就想撤销；
 *   尾随空白的差异不该被当成「他改过，别删」。
 */
export function compareSaved(entries, { scope = 'public', index, body } = {}) {
  if (!Array.isArray(entries)) return 'gone';
  const target = entries.find((entry) => entry && entry.scope === scope && entry.index === index);
  if (!target) return 'gone';
  const saved = typeof target.body === 'string' ? target.body : '';
  const mine = typeof body === 'string' ? body : '';
  return saved.trim() === mine.trim() ? 'match' : 'changed';
}

/**
 * 按 `L` 时把选中的那段带进浮层（0.72.0 P1）。
 *
 * 格式是 Markdown 引用块，末尾空一行 —— 用户接着往下写自己的想法，视觉上就分成
 * 「引来的」与「我写的」两段。
 *
 * ★ 与「摘录到灵感」**分工**，不是同一个功能的两个入口：
 *   按钮 = 不编辑、直接存一段引文（`source` 里带「摘录」）；
 *   `L` = 带进来继续写（`source` 仍是书名 / 文章名，正文里自己分区）。
 *   所以这里**不**给 `source` 加「摘录」—— 那会把「我读完的想法」标成「摘录」。
 * ★ 必须截断：一次全选可以选中整章。截到 `limit` 字并补 `…`，否则浮层一打开
 *   就是几千字的引用，用户光滚到末尾写自己的想法就要滚半天。
 * ★ 顺带一个安全收益：每行加了 `> ` 前缀之后，引文里原本的 `## 12:00 灵感`
 *   不再出现在行首 —— 宿主的 `parseDay` 按行首 `## HH:MM` 切条目，不加前缀时
 *   复制进来的一段带标题的原文会被切成两条日记。
 */
export function seedBlock(text, limit = 500) {
  const body = String(text ?? '').trim();
  if (body === '') return '';
  const cut = body.length > limit ? `${body.slice(0, limit)}…` : body;
  const quoted = cut
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.trim()}`))
    .join('\n');
  return `${quoted}\n\n`;
}

/**
 * 光标前正在输入的 `#标签`，以及能补全它的候选（0.72.0 P1）。
 *
 * 返回 `{ start, query, tags }`；不在标签里 / 没有候选时返回 `null`。
 *
 * ★ `#` 前面必须是**行首或空白**：否则 `C#`、URL 里的 `#anchor`、以及
 *   `a#b` 都会弹出候选，而那种地方用户根本不是在写标签。
 * ★ 前缀里出现空白就放弃：`#今天 天气` 不是一个标签，弹出来只会挡住正文。
 * ★ 前缀上限 40 字符：超过还在打，说明这不是标签而是在写一句话。
 * ★ 候选排除与 `query` 完全相等的那一个 —— 已经打全了还提示「补全成它自己」，
 *   按 Tab 只会多一个空格。
 * ★ `query` 可能是空串（刚敲下 `#`）：那时给最近用过的几个，这正是最有用的时候。
 */
export function tagSuggestions(text, caret, tags, { limit = 6, maxQuery = 40 } = {}) {
  if (typeof text !== 'string' || !Number.isInteger(caret)) return null;
  const at = Math.min(Math.max(caret, 0), text.length);
  let start = -1;
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '#') { start = index; break; }
    if (/\s/.test(char)) return null;
    if (at - 1 - index > maxQuery) return null;
  }
  if (start < 0) return null;
  // `#` 前面必须是行首或空白（见上）。
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  const query = text.slice(start + 1, at);
  if (query.includes('#')) return null;
  const list = (Array.isArray(tags) ? tags : [])
    .map((item) => (typeof item === 'string' ? item : item?.tag))
    .filter((tag) => typeof tag === 'string' && tag !== '')
    .filter((tag) => tag !== query && tag.toLowerCase().startsWith(query.toLowerCase()))
    .slice(0, limit);
  return list.length > 0 ? { start, query, tags: list } : null;
}

/**
 * 把候选补进去，返回新正文与**新光标位置**。
 *
 * ★ 必须自己算光标：替换发生在文字中间，浏览器不会替你把 caret 挪到插入内容之后，
 *   用户接着打字就会打在 `#标签` 前面 —— 症状是「补全之后字跑到井号前头去了」。
 * ★ 只在**文末**补一个空格（`#tag` 结尾 → `#tag `）：后面已经跟着文字或标点时补空格
 *   会得到 `#标签 ，`，那比不补更难看；而文末补空格还能顺手让候选立刻收起。
 */
export function applyTag(text, caret, start, tag) {
  const source = typeof text === 'string' ? text : '';
  const at = Math.min(Math.max(Number.isInteger(caret) ? caret : source.length, 0), source.length);
  const from = Math.min(Math.max(Number.isInteger(start) ? start : at, 0), at);
  const head = source.slice(0, from);
  const tail = source.slice(at);
  const space = tail === '' ? ' ' : '';
  const inserted = `#${tag}${space}`;
  return { text: `${head}${inserted}${tail}`, caret: head.length + inserted.length };
}

/**
 * 浮层打开时输入框里该是什么（0.72.0 P1）。
 *
 * **草稿优先于种子**，且只认非空草稿。
 *
 * ★ 抽成函数而不是在组件里写一行三元：这是浮层里唯一一处「两份用户意图打架」的
 *   决策，写成三元就没人能单测它 —— 而它错了很难看出来（打开时框里有字，用户以为
 *   那就是他要写的）。
 * ★ 为什么草稿优先：草稿是**用户自己打的字**，种子是原文。丢前者比丢后者严重。
 * ★ 为什么空草稿不算：`readDraft` 已经把空的挡掉了，这里再守一次是因为
 *   草稿对象可能来自别的写入路径（例如上一版留下的 `body: '  '`）。
 */
export function initialBody(saved, seed) {
  const draft = typeof saved?.body === 'string' ? saved.body : '';
  if (draft.trim() !== '') return draft;
  return typeof seed === 'string' ? seed : '';
}

/**
 * 贴图（0.73.0）：这张能不能收。
 *
 * ★ 为什么在客户端先判一次：8 MB 的图从剪贴板到宿主要走一遍 HTTP。类型与大小
 *   本地就知道，先判掉能省掉一次**必然失败**的往返 —— 也就省掉用户对着
 *   「图片正在保存…」等两秒、最后只看到一句「不支持」。
 * ★ 但这里**不是**安全边界：`file.type` 是浏览器说的。宿主照样按 magic bytes
 *   再判一次（`src/host/diary-assets.js`）。两处文案对齐，改一处要一起改 ——
 *   否则同一个失败会给出两句不同的话。
 * ★ 8 MB 这个数与宿主那份必须一致：客户端放行、宿主拒绝，用户看到的就是
 *   「明明说可以，贴进去却说太大」。
 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 认识的类型。SVG **不在**里面：它是 XML，能带脚本，而速记不是看图工具。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * @param {{ type?: string, size?: number }} file 剪贴板里那个 `File` 的两项
 * @returns `{ ok: true }` 或 `{ ok: false, message }`（`message` 直接给用户看）
 */
export function acceptImage({ type = '', size = 0 } = {}) {
  const mime = String(type ?? '').toLowerCase();
  if (!IMAGE_TYPES.has(mime)) {
    return { ok: false, message: `只收 PNG / JPEG / GIF / WebP —— 这张是 ${mime || '未知类型'}` };
  }
  if (!Number.isFinite(size) || size <= 0) return { ok: false, message: '这张图是空的' };
  if (size > IMAGE_MAX_BYTES) {
    return { ok: false, message: `这张图有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 8 MB —— 先缩一下再贴` };
  }
  return { ok: true };
}

/**
 * 把一张图插进正文，返回新正文与**新光标位置**。
 *
 * ★ 图必须**独占一行**（`\n` 前后补齐）。Markdown 的行内图片要是一个独立段落
 *   才会按图片排版；跟在一句话后面时，`markdownToHtml` 仍会输出 `<img>`，但它被
 *   包在 `<p>` 里、紧贴着文字 —— 视觉上就是「图片挤在字中间」。
 * ★ 光标落在**整段之后**（补完那个换行）：用户贴完图接着打字，字应该在图的下面，
 *   而不是跑进 url 的括号里。
 * ★ `url` 为空时原样返回：宁可不插，也不要插一条 `![]()` —— 那是渲染不出来的
 *   空图，而界面上看起来「已经贴好了」。
 */
export function imageMarkdown(text, caret, url) {
  const source = typeof text === 'string' ? text : '';
  const at = Math.min(Math.max(Number.isInteger(caret) ? caret : source.length, 0), source.length);
  if (typeof url !== 'string' || url.trim() === '') return { text: source, caret: at };
  const head = source.slice(0, at);
  const tail = source.slice(at);
  const lead = head === '' || head.endsWith('\n') ? '' : '\n';
  const trail = tail === '' || tail.startsWith('\n') ? '' : '\n';
  const inserted = `${lead}![](${url.trim()})${trail}`;
  return { text: `${head}${inserted}${tail}`, caret: head.length + inserted.length };
}
