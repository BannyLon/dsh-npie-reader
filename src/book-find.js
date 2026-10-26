/**
 * 书内搜索的**判据**：正文全文检索，逐处命中，给上下条跳转用。
 *
 * ★ 与 `book_search`（`service.searchBookDigests`）**同一套判据**
 * -------------------------------------------------------------
 * 查询串 `trim` → 小写，正文小写后 `indexOf` 子串匹配，**不分词、不转正则**。
 * 理由那边写得很清楚，这里照抄一遍，因为它是这个文件存在的全部原因：中文没有
 * 词边界，一分词，「磨坊主妇」和「磨坊」就变成两种结果，而它们本该是包含关系。
 * ★ 两处**必须**用同一套判据：否则会出现「AI 说第 7 章有，自己在书里搜不到」——
 *   用户无法判断是谁错了，而这两句话本来该是同一个人说的。
 *
 * ★ 与那边的唯一差别：**一处都不漏**
 * ---------------------------------
 * `book_search` 每章只回第一处命中（它是「哪几章值得细看」的定位器，一章报一次就够，
 * 报多了只会把 50 条的预算烧在同一章上）。书内搜索要能上下条翻，所以每一处都回。
 *
 * ★ 为什么不复用 `extractPageText`（`book-view.js`）
 * -------------------------------------------------
 * 那个函数把整页压成**一行**、用空格 join 每个 pdf.js 游程，还给 20,000 字上限。
 * 三件事对检索都是错的：空格 join 会把「磨坊 主妇」拆开（同一行内本无空格，中文
 * 永远也搜不到跨游程的词）；压成一行会让片段显示成一长串；上限会让后半本**静默
 * 不参与检索**——「搜不到」和「根本没搜」必须能区分。所以这里另给 `pageIndexText()`，
 * 只保留 `extractPageLines` 那套「同游程直拼、仅 ASCII 词边界补空格」的判据。
 *
 * ★ 偏移必须映射回原文
 * ------------------
 * 小写化**不保证等长**（`İ`.toLowerCase() 是两个码点）。若拿小写串的下标直接当原文
 * 下标，命中位置会从那个字符开始整体前移，症状是「高亮从中间开始、越往后偏得越多」。
 * `lowerWithMap()` 在长度不一致时给一张「小写下标 → 原文下标」的表；长度一致（几乎
 * 所有情况）时走快路径，不建表。
 */

/** 一次最多回多少处命中。到顶就**明说截断**，不假装全搜完了。 */
export const FIND_LIMIT_MAX = 300;

/**
 * 查询串的字符上限。
 *
 * ★ 不在这里 `slice`：静默截断会让「搜一长句」变成「搜前半句」，用户拿到一堆
 *   看起来莫名其妙的命中。超限由调用方**明确拒绝**（路由回 400、输入框限长）。
 */
export const FIND_QUERY_MAX = 100;

/**
 * 逐码点小写。
 *
 * ★ 不用 `text.toLowerCase()`：整串小写会做上下文相关变换（希腊语词尾 Σ），
 *   而后面对照的原文下标是按码点算的。逐码点小写虽然不是语言学上最正确的写法，
 *   但它**长度与映射永远对得上** —— 这个文件要的是后一件事。
 */
function lowerOf(text) {
  let out = '';
  for (const ch of text) out += ch.toLowerCase();
  return out;
}

/** 查询串归一：去首尾空白 + 小写。空串表示「不搜」。 */
export function normalizeNeedle(query) {
  return lowerOf(String(query ?? '').trim());
}

/**
 * 小写串 + 下标映射。
 *
 * `map === null` 表示长度一致，小写下标就是原文下标（99.9% 的情况）。
 */
function lowerWithMap(text) {
  const lower = lowerOf(text);
  if (lower.length === text.length) return { lower, map: null };
  const chars = [];
  const map = [];
  let index = 0;
  for (const ch of text) {
    const piece = ch.toLowerCase();
    for (let k = 0; k < piece.length; k += 1) map.push(index);
    chars.push(piece);
    index += ch.length;
  }
  return { lower: chars.join(''), map };
}

/**
 * 一段文字里的全部命中：`[{ start, end }]`，按出现顺序、**互不重叠**。
 *
 * ★ 不重叠的推进量是 `needle.length` 而不是 `+1`：搜「aa」时 `aaaa` 应当是两处，
 *   而不是三处（后者会把重合的窗口也报成命中）——「第 3/4 处」跳过去却和上一处
 *   是同一片字，用户会以为跳转坏了。
 * ★ 空查询返回 `[]` 而不是「全部」：那是「还没输入」，不是「匹配一切」。
 */
export function findOccurrences(text, needle, { limit = FIND_LIMIT_MAX } = {}) {
  const source = String(text ?? '');
  const query = normalizeNeedle(needle);
  const cap = Math.max(1, Math.min(Number(limit) || FIND_LIMIT_MAX, FIND_LIMIT_MAX));
  if (query === '' || source === '') return [];
  const { lower, map } = lowerWithMap(source);
  const out = [];
  let at = lower.indexOf(query);
  while (at >= 0 && out.length < cap) {
    const tail = at + query.length - 1;
    const start = map === null ? at : map[at];
    const end = map === null ? at + query.length : (map[tail] ?? start) + 1;
    if (end > start) out.push({ start, end });
    at = lower.indexOf(query, at + Math.max(1, query.length));
  }
  return out;
}

/**
 * 命中处的上下文片段。
 *
 * ★ 空白压成单个空格（PDF 的换行、电子书的段内空行）：片段要在一行里显示，
 *   保留原始换行只会让列表里出现一排参差不齐的空白。
 * ★ 两端被截断时补 `…`：不补的话，用户会把片段的第一句当成整段的开头。
 */
export function snippetOf(text, start, end, { before = 24, after = 48 } = {}) {
  const source = String(text ?? '');
  const from = Math.max(0, Math.min(Number(start) || 0, source.length) - before);
  const to = Math.min(source.length, Math.max(Number(end) || 0, Number(start) || 0) + after);
  const body = source.slice(from, to).replace(/\s+/g, ' ').trim();
  if (body === '') return '';
  return `${from > 0 ? '…' : ''}${body}${to < source.length ? '…' : ''}`;
}

/**
 * pdf.js 的文字项 → **单页检索文本**（无上限）。
 *
 * 拼接判据与 `extractPageLines` 完全一致：同一行的相邻游程**直接拼**，只在「前后
 * 都是 ASCII 字母数字」的边界补一个空格（英文游程常常是「词」而不是「字」）。
 * 中文不匹配这个边界，所以不会在字与字之间插空格 —— 这一条正是「跨游程的中文词
 * 也能搜到」的前提。
 *
 * ★ 不做长度上限：上限会让一本书的后半段在**没人知道**的情况下不参与检索。
 *   真需要限流就在调用方按页分片，而不是在这里悄悄砍掉正文。
 */
export function pageIndexText(items) {
  let out = '';
  let prevWord = false;
  for (const item of Array.isArray(items) ? items : []) {
    const str = typeof item?.str === 'string' ? item.str : '';
    if (str !== '') {
      const startsWord = /^[A-Za-z0-9]/.test(str);
      if (prevWord && startsWord) out += ' ';
      out += str;
      prevWord = /[A-Za-z0-9]$/.test(str);
    }
    if (item?.hasEOL === true) {
      out += '\n';
      prevWord = false;
    }
  }
  return out;
}

/**
 * 「这本书到底有没有文字层」的抽样页。
 *
 * ★ 为什么要抽样，而不是打开面板就给整本建索引：网盘上的书每翻一页都是一次
 *   Range 请求，500 页的书打开搜索面板就要等 500 次往返 —— 而**多数书第一页就有字**，
 *   那 500 次全是白花的。先抽几页，全都没有文字层才继续走索引。
 * ★ 抽样**两端都要取**：封面、版权页、扉页本来就常常没有文字（或只有一张图），
 *   只抽前几页会把「封面是扫描件」误判成「整本没有文字层」。所以固定取首尾 + 中间均分。
 * ★ 这里只是**触发器**，不是判据：真正的结论由整本索引给出（`textless === 总页数`）。
 *   抽样错了顶多多花一次索引，不会让界面上说错话 —— 这两件事必须分开，
 *   否则「抽样 6 页都没字」就会变成一句关于全书的断言。
 */
export function probePages(total, count = 6) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  if (n === 0) return [];
  const want = Math.max(2, Math.min(Math.floor(Number(count) || 6), n));
  const out = [];
  for (let i = 0; i < want; i += 1) {
    const page = 1 + Math.round((i * (n - 1)) / (want - 1));
    if (!out.includes(page)) out.push(page);
  }
  return out;
}

/**
 * 搜一组**已拼好的文本片段**（各片段的字符下标记在 `{ start, end }` 里）。
 *
 * 这里给的是「书内搜索」的通用形状，PDF 与电子书两条路都收成它：
 * 一个对象 = 一处命中 + 它所在的编号（页号 / 节号）+ 片段。
 */
export function collectHits(pieces, needle, { limit = FIND_LIMIT_MAX, locate } = {}) {
  const hits = [];
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    if (hits.length >= limit) break;
    for (const hit of findOccurrences(piece.text, needle, { limit: limit - hits.length })) {
      const where = typeof locate === 'function' ? locate(piece) : {};
      hits.push({
        ...where,
        ...hit,
        snippet: snippetOf(piece.text, hit.start, hit.end),
      });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
