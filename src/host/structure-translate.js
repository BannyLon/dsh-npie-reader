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
 *
 * @param {Array<{id: number, text: string, group: number}>} segments
 * @param {object} [options]
 * @param {Array<{text: string}>} [options.context]
 *   上一批片段的原文，**只给模型理解上下文，不是要它翻的内容**。
 *   渲染成不带编号的纯文本，并在前后各写一句「不要翻译它」——
 *   不给编号是关键：解析只认 `[数字]`，没有编号它就**无从**为上文产出条目。
 */
export function buildTranslatePrompt(segments, options = {}) {
  const lines = [];
  const context = Array.isArray(options.context) ? options.context : [];
  if (context.length > 0) {
    /*
     * ★ 这段话必须写死，而且必须放在**最前面**。
     *
     *   实测过的失败形态：只写「以下是上文」时，模型会把它当成待翻清单的一部分，
     *   于是输出的编号整体错位（它给上文也编了号，后面每一条都往后挪）——
     *   而错位是**静默**的：`[7]` 的译文会被写进第 7 段的标签里，页面结构不错乱，
     *   只是每一句都换成了别处的译文，比「没翻译」难发现得多。
     *   所以这里同时做两件事：① 明确说「不要翻译、不要输出编号」；
     *   ② 编排层只接受**属于本批**的编号（见 `mergeTranslations` 的 id 过滤）。
     */
    lines.push('【上文】下面是**上一批**片段的原文，只供你理解上下文与统一术语。');
    lines.push('不要翻译它，也不要为它输出任何编号。');
    for (const item of context) {
      const text = String(item?.text ?? '').trim();
      if (text !== '') lines.push(text);
    }
    lines.push('【正文】以上是上文。下面才是要翻译的片段，从本批的第一条开始编号。');
    lines.push('');
  }
  let lastGroup = -1;
  for (const segment of segments) {
    if (lastGroup !== -1 && segment.group !== lastGroup) lines.push('');
    lastGroup = segment.group;
    lines.push(`[${segment.id}] ${segment.text}`);
  }
  return lines.join('\n');
}

/**
 * 一批最多带多少字符的原文。
 *
 * ★ 这个数不是拍脑袋，是两条约束的交点：
 *   ① **上限**：一批 12,000 字符的英文原文 ≈ 3,500 token，译回中文再 ≈ 6,000 token，
 *      加上系统提示词总共一万出头 —— 64k 上下文的模型也留足余量。
 *      超过这个量，模型开始**漏条目**（它宁可少翻也不肯把输出写太长），
 *      而漏掉的那几条会保留原文 ⇒ 用户看到中英混排。
 *   ② **下限**：太小则调用次数暴涨（200k 字符的极端文章会变成二十几次调用，
 *      每次都带一遍系统提示词，既慢又贵）。
 *   12,000 是实测 200k 字符文章 = 17 批、常见 3 万字文章 = 3 批的规模，两头都合适。
 */
export const TRANSLATE_CHUNK_CHARS = 12000;

/** 一批最多几条。防止「一万个短句」把输出顶爆（字符预算管不住条数）。 */
export const TRANSLATE_CHUNK_SEGMENTS = 120;

/** 单批的硬上限倍数：宁可切得难看，也不许一个块无限长。 */
const CHUNK_HARD_FACTOR = 2;

/** 每批带上文几条（默认 3 条，够模型接住代词与术语）。 */
export const TRANSLATE_CONTEXT_SEGMENTS = 3;

/**
 * 上文最多带多少字符。
 *
 * ★ 这条上限是**必须**的，不是优化。第一版只按「条数」带上文（3 条），
 *   结果实测一篇 17.5 万字符的长文：每批正文 12,024 字符、上文 12,072 字符 ——
 *   上文和正文一样长，等于预算凭空翻倍，分批的意义少了一半。
 *   原因很简单：**一条就可能是整段**（4000 字），按条数限不住字符数。
 */
export const TRANSLATE_CONTEXT_CHARS = 1500;

/**
 * 一批最多切几块 —— 安全阀，不是业务上限。
 *
 * 正文入库上限是 200,000 字符（`feeds.js` 的 `MAX_BODY_CHARS`），按 12,000 一批
 * 最多 17 批。留到 40 是为了「万一有人把上限调大」时不至于悄悄发出上百次调用。
 */
export const TRANSLATE_MAX_CHUNKS = 40;

/**
 * 把片段清单切成若干批。
 *
 * 三条规则，按优先级：
 *   ① **一段话不许从中间断开**（同 `group` 的几条尽量留在同一批）——
 *      否则模型看到的是半句话，译文要么断头断尾、要么自己脑补；
 *   ② 到了字符/条数预算就**在段边界**收口；一段话本身超预算时，到硬上限（2 倍）才断；
 *   ③ 每批带上**上一批的最后几条**作为上下文。
 *
 * @param {Array<{id: number, text: string, group: number}>} segments
 * @param {object} [options]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxSegments]
 * @param {number} [options.contextSegments]
 * @param {number} [options.maxChunks]
 * @returns {Array<{segments: Array, context: Array}>}
 */
export function planTranslationChunks(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length === 0) return [];
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : TRANSLATE_CHUNK_CHARS;
  const maxSegments = Number.isFinite(options.maxSegments) && options.maxSegments > 0 ? options.maxSegments : TRANSLATE_CHUNK_SEGMENTS;
  const contextSegments = Number.isFinite(options.contextSegments) && options.contextSegments >= 0
    ? options.contextSegments : TRANSLATE_CONTEXT_SEGMENTS;
  const contextChars = Number.isFinite(options.contextChars) && options.contextChars >= 0
    ? options.contextChars : TRANSLATE_CONTEXT_CHARS;
  const maxChunks = Number.isFinite(options.maxChunks) && options.maxChunks > 0 ? options.maxChunks : TRANSLATE_MAX_CHUNKS;

  /** 每条的固定开销：`[编号] ` 前缀 + 换行。不加上它，字符预算会系统性偏小。 */
  const overheadOf = (segment) => String(segment.text ?? '').length + 12;

  const chunks = [];
  let current = [];
  let size = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
    size = 0;
  };

  for (const segment of list) {
    const sameGroup = current.length > 0 && current[current.length - 1].group === segment.group;
    const overBudget = size >= maxChars || current.length >= maxSegments;
    // ① 到预算了，而且下一条是**新的一段** ⇒ 正好在段边界收口。
    if (overBudget && !sameGroup) flush();
    // ② 同一段本身超预算：到硬上限就得断，否则一段话能顶满一整篇。
    else if (sameGroup && size >= maxChars * CHUNK_HARD_FACTOR) flush();
    current.push(segment);
    size += overheadOf(segment);
  }
  flush();

  return chunks.map((group, index) => {
    const previous = index === 0 ? [] : chunks[index - 1];
    /*
     * ★ 上文从上一批的**末尾往前**取，条数与字符数**两道**上限同时生效。
     *   只限条数是不够的：一条可能就是整段（4000 字），3 条能顶一整批的预算。
     *   超了字符上限时**保留靠后的那些**（离本批最近的上下文才有用）。
     */
    const tail = [];
    let budget = contextChars;
    if (contextSegments > 0 && previous !== undefined) {
      for (let i = previous.length - 1; i >= 0 && tail.length < contextSegments; i -= 1) {
        const text = String(previous[i].text ?? '');
        if (budget <= 0) break;
        tail.unshift({ text: text.length > budget ? text.slice(-budget) : text });
        budget -= Math.min(text.length, budget);
      }
    }
    return {
      segments: group,
      // 上文只带 text：编号会诱导模型去翻它，而回填只需要文字。
      context: tail,
    };
  }).slice(0, maxChunks);
}

/**
 * 把一批的译文合并进总表。
 *
 * ★ **先到先得**，后来的同号译文一律不覆盖。
 *   理由：上文段落里如果被模型擅自翻译并复用了某个编号，覆盖会把**已经翻对的**
 *   那一条换成重复内容。先到先得让这种污染只能发生在「本来就还没有」的位置上。
 *
 * @param {Map<number, string>} target
 * @param {Map<number, string>} incoming
 * @param {Set<number>} [allowed] 只接受这些编号（属于本批的）。省略则不设限。
 * @returns {number} 本次新增了几条
 */
export function mergeTranslations(target, incoming, allowed) {
  if (!(target instanceof Map) || !(incoming instanceof Map)) return 0;
  let added = 0;
  for (const [id, text] of incoming) {
    if (allowed instanceof Set && !allowed.has(id)) continue;
    if (target.has(id)) continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    target.set(id, text);
    added += 1;
  }
  return added;
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
