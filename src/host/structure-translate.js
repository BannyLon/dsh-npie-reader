/**
 * 保结构翻译：**只翻译文本节点，标记一个都不动**。
 *
 * ★ 为什么需要它（2026-10-14 用户报「翻译后链接没了、排版全变了」的根因）：
 *
 *   旧路径是「HTML → Markdown → 模型 → Markdown → 渲染」的有损往返：
 *     - `htmlToText({ links })` 把 `<a href=X>文字</a>` 压成 `[文字]({{L0}})`，
 *       模型经常**把方括号丢掉**只输出文字 ⇒ `restoreLinks` 无占位符可换 ⇒
 *       链接**静默消失**。真机 38 篇实测：原文 909 个 `<a>`，译文只剩 427 个。
 *     - 译文渲染走 `markdownToHtml`，它只输出**裸标签**（`p/h1/a/img/…`），
 *       没有 class、没有尺寸、没有布局容器 ⇒ 原文的 `<div class>` / `<figure>` /
 *       带尺寸的缩略图**没有对应表达能力** ⇒ 排版必然与原文不同。
 *
 *   新路径把「翻译」和「标记」彻底分开：
 *     ① 收集文本节点（只记位置，不动 HTML）；
 *     ② 只把**纯文本清单**发给模型（标签一个都不进模型）；
 *     ③ 按编号把译文**写回原 HTML 的同一位置**，只改文本节点；
 *     ④ 界面渲染的仍是**原 HTML**，只是里面的字变成了中文。
 *
 *   ⇒ 链接 / 图片 / class / 布局全部原样保留，因为**它们从没离开过磁盘上的那份 HTML**。
 *
 * ★ 一条 = 一个文本节点，**不用任何段内分隔符**。
 *   曾经试过「一个块拼成一条、段间插不可见控制字符」的写法，真机一量就否掉了：
 *   AINews 那种整篇都是行内链接的文章，68 个块里 57 个是多段块，一共要模型
 *   精确保留 **287 个不可见字符** —— 漏一个整块就不翻。可靠性不能押在这上面。
 *   现在「同段」这层信息改用**空行**传递：模型看得见，但它**不需要保留** ——
 *   解析只认行首的 `[编号]`，空行丢了也不影响对齐。
 *
 * ★ 安全底线：**解析不出来就保留原文**。
 *   宁可这一句不翻，也绝不能把译文塞进错误的标签里 —— 那会产出结构错乱的页面，
 *   而且比「没翻译」难发现得多。
 */

import { parseTree, TAG_RE } from './fulltext.js';
import { decodeHtmlEntities } from './sanitize.js';

/**
 * 「同一段」的边界，只用于**给模型看的空行分组**，不参与回填定位。
 *
 * 取最近的块级祖先：`<li><p>a</p></li>` 的组是 `<p>` 而不是 `<li>`。
 */
const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'td', 'th', 'dd', 'dt', 'caption', 'figcaption',
  'blockquote', 'summary', 'details',
  'div', 'section', 'article', 'aside', 'main', 'figure',
]);

/**
 * 这些子树里的文本**一律不翻**。
 *
 * `pre` / `code`：代码翻了就废了。`textarea`：表单默认值。
 * `script` / `style`：sanitize 之后通常已经没有了，留着是第二道闸门。
 */
const OPAQUE_TAGS = new Set(['pre', 'code', 'kbd', 'samp', 'script', 'style', 'textarea']);

/** 只含空白或零宽字符（`\s` 匹配不到零宽字符，必须显式列出）。 */
const BLANK_RE = /^[\s\u200b\u200c\u200d\ufeff]*$/;

/** 纯标点 / 纯符号的片段不值得翻，翻出来只会是噪音（也容易被模型改写坏）。 */
const PUNCT_ONLY_RE = /^[\s\u200b\u200c\u200d\ufeff\p{P}\p{S}]+$/u;

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把 HTML 拆成「文本节点清单」（**只读**，不改 HTML）。
 *
 * @param {string} html - 已 sanitize 的 HTML。
 * @returns {Array<{id: number, text: string, start: number, end: number, group: number}>}
 *   `start` / `end` 是**去掉首尾空白后**的核心文本在原 HTML 里的位置 ——
 *   回填只替换这一段，首尾空白留在原地，于是 `<p>Hello <strong>x</strong></p>`
 *   里的那个空格不会被吃掉。`group` 相同的几条来自同一段话。
 */
export function collectSegments(html) {
  const source = String(html ?? '');
  if (source === '') return [];
  const elements = parseTree(source);

  TAG_RE.lastIndex = 0;
  const spans = [];
  let match;
  while ((match = TAG_RE.exec(source)) !== null) spans.push([match.index, TAG_RE.lastIndex]);

  /** 包含 `[start, end)` 的**最深**元素 —— 也就是这段文本的直接父节点。 */
  const ownerAt = (start, end) => {
    let best = -1;
    let bestDepth = -1;
    for (const element of elements) {
      if (element.start > start || element.end < end) continue;
      if (element.depth > bestDepth) {
        bestDepth = element.depth;
        best = element.index;
      }
    }
    return best;
  };

  const found = [];
  const take = (start, end) => {
    const raw = source.slice(start, end);
    if (BLANK_RE.test(raw)) return;
    const owner = ownerAt(start, end);
    if (owner < 0) return;
    let node = owner;
    let block = owner;
    while (node >= 0) {
      const tag = elements[node].tag;
      if (OPAQUE_TAGS.has(tag)) return;
      if (BLOCK_TAGS.has(tag)) {
        block = node;
        break;
      }
      node = elements[node].parent;
    }
    const leading = /^[\s\u200b\u200c\u200d\ufeff]*/.exec(raw)[0].length;
    const trailing = /[\s\u200b\u200c\u200d\ufeff]*$/.exec(raw)[0].length;
    const coreStart = start + leading;
    const coreEnd = end - trailing;
    /**
     * ★ 必须**解码实体**再送模型。
     *
     * HTML 源码里的 `AT&amp;T` / `don&#x27;t` 是**转义过的字面量**：不解码的话模型
     * 看到的就是一串 `&amp;` `&#x27;`（既影响理解，也可能被它原样抄回来），
     * 回填时 `escapeHtml` 再转一次 ⇒ 变成 `&amp;amp;`，**页面上出现可见的 `&amp;`**。
     * 解码 + 回填转义是一对，缺一半就多一层。
     */
    const text = decodeHtmlEntities(source.slice(coreStart, coreEnd)).replace(/\s+/g, ' ');
    if (text === '' || PUNCT_ONLY_RE.test(text)) return;
    found.push({ block, start: coreStart, end: coreEnd, text });
  };

  let cursor = 0;
  for (const [from, to] of spans) {
    if (from > cursor) take(cursor, from);
    if (to > cursor) cursor = to;
  }
  if (cursor < source.length) take(cursor, source.length);

  const groupOf = new Map();
  return found.map((item, index) => {
    if (!groupOf.has(item.block)) groupOf.set(item.block, groupOf.size + 1);
    return {
      id: index + 1,
      text: item.text,
      start: item.start,
      end: item.end,
      group: groupOf.get(item.block),
    };
  });
}

/**
 * 组装送给模型的清单。
 *
 * 格式：一行一条、行首 `[编号]`；**同一段（`group` 相同）的几条连在一起，段与段之间空一行**。
 * 空行是给模型看的上下文提示 —— 它丢了也不影响回填，因为解析只认 `[编号]`。
 */
export function buildTranslatePrompt(segments) {
  const lines = [];
  let lastGroup = -1;
  for (const segment of segments) {
    if (lastGroup !== -1 && segment.group !== lastGroup) lines.push('');
    lastGroup = segment.group;
    lines.push(`[${segment.id}] ${segment.text}`);
  }
  return lines.join('\n');
}

/**
 * 解析模型返回的清单。
 *
 * ★ 宽容三件事，但**不宽容错位**：
 *   - 编号前后有空格、用了全角括号 —— 都认；
 *   - 某一条被翻成了多行 —— 按「下一条的 `[编号]`」切边界，不依赖行数；
 *   - 少了某几条 —— 少的那几条**不进 Map**，调用方会保留原文。
 *
 * 编号重复时取**第一条**：后出现的多半是模型把内容拆成了两段，取第一条更接近原句。
 *
 * @returns {Map<number, string>}
 */
export function parseTranslateReply(reply) {
  const text = String(reply ?? '');
  const marks = [];
  const re = /[[［]\s*(\d{1,6})\s*[\]］]/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    marks.push({ id: Number(match[1]), at: match.index, after: re.lastIndex });
  }
  const out = new Map();
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const content = text.slice(marks[i].after, end).trim();
    if (content === '') continue;
    if (!out.has(marks[i].id)) out.set(marks[i].id, content);
  }
  return out;
}

/**
 * 把译文写回原 HTML —— **只替换文本节点，标签一个都不动**。
 *
 * 从后往前改，这样前面的偏移量不会因为后面的替换而失效。
 *
 * 两条保命规则：
 *   ① 译文里的 `<` `>` `&` 一律转义（否则译文里一个 `<` 就能凭空造出标签）；
 *   ② 空译文直接跳过 ⇒ 那一句保留原文（模型返回空通常意味着它没看懂，不是要删掉）。
 *
 * @param {string} html - 原（已 sanitize 的）HTML。
 * @param {ReturnType<typeof collectSegments>} segments
 * @param {Map<number, string>} translations
 * @returns {string}
 */
export function applyTranslations(html, segments, translations) {
  const source = String(html ?? '');
  if (source === '' || !Array.isArray(segments) || !(translations instanceof Map)) return source;

  const edits = [];
  for (const segment of segments) {
    const translated = translations.get(segment.id);
    if (typeof translated !== 'string') continue;
    const piece = translated.trim();
    if (piece === '') continue;
    edits.push({ start: segment.start, end: segment.end, text: escapeHtml(piece) });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * 这次翻译的**覆盖率**：送出去的片段里有多少条真的被翻到了。
 *
 * 用途是「别把失败说成成功」：模型只回了一半时，界面该说「部分翻译」而不是
 * 「已生成」。`applyTranslations` 会把没翻的片段原样留着，所以覆盖率是唯一能
 * 说明「这次到底翻了多少」的数。
 */
export function translationCoverage(segments, translations) {
  const total = Array.isArray(segments) ? segments.length : 0;
  if (total === 0) return { total: 0, done: 0, ratio: 1 };
  let done = 0;
  for (const segment of segments) {
    const value = translations?.get?.(segment.id);
    if (typeof value === 'string' && value.trim() !== '') done += 1;
  }
  return { total, done, ratio: done / total };
}
