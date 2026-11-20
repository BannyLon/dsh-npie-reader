/**
 * 重排电子书的**划线锚点**：页内字符偏移 ↔ 块内偏移。
 *
 * ★ 为什么 PDF 那套 `annotations.js` 不能直接用在电子书上：
 *   PDF 的偏移基准是**文字层容器的 `textContent`** —— 那是一个由 pdf.js 铺出来的
 *   扁平 span 序列，`TreeWalker` 从容器第一字数到最后一字就行。电子书这边正文是
 *   **React 元素**（`h1` / `p` / `li` / `blockquote` / `pre`），块与块之间在 DOM 里
 *   并不相邻，跨块数文本节点会把两个块之间的**元素边界**也数进去 —— 量出来的偏移
 *   比真实字符位置多，症状是「线画到了下一段开头几个字」。
 * ★ 所以这里定义自己的坐标系：**所有非空块用 `\n` 串起来**（与 `blocksToText`
 *   完全同一个基准，那个函数是伴读取的正文），落盘仍然是 `{ page, start, end, quote }`
 *   —— 与 PDF 共用同一个 store（`annotations/<bookId>.json`）与同一个面板。
 * ★ 空块不占坐标：`renderBlocks` 直接跳过空文本，它在 DOM 里不存在。
 */

/**
 * 块与块之间的分隔符。**改这个值等于让所有已存的划线错位**。
 *
 * ★ 定义在共用层 `annotation-relocate.js`：宿主的重定位与这里的渲染必须读同一个值，
 *   两边各写一份时改了一处不会报错，只会让「找回来的划线」画到另一个坐标上。
 */
import { BLOCK_SEP, pageTextOfBlocks } from '../annotation-relocate.js';
export { BLOCK_SEP };

/**
 * 每个非空块在页内坐标系里的区间：`[{ index, start, end }]`。
 * `index` 是它在 `blocks` 里的原始下标（DOM 上写的就是这个值）。
 */
export function blockSpans(blocks) {
  const spans = [];
  let offset = 0;
  (Array.isArray(blocks) ? blocks : []).forEach((block, index) => {
    const text = String(block?.x ?? '');
    if (text === '') return;
    if (spans.length > 0) offset += BLOCK_SEP.length;
    spans.push({ index, start: offset, end: offset + text.length });
    offset += text.length;
  });
  return spans;
}

/** 页内坐标系下的全文（只用来核对长度，不参与渲染）。 */
export function pageText(blocks) {
  return pageTextOfBlocks(blocks);
}

/** 端点所在的块元素（`[data-block]`），不在文章里就返回 `null`。 */
export function blockElementOf(node, article) {
  if (!node || !article) return null;
  const element = node.nodeType === 1 ? node : node.parentElement;
  if (!element || typeof element.closest !== 'function') return null;
  const block = element.closest('[data-block]');
  if (block === null || typeof article.contains !== 'function' || !article.contains(block)) return null;
  return block;
}

/** 块元素对应哪一段坐标。 */
export function spanOfElement(spans, element) {
  if (!element || !element.dataset) return null;
  const index = Number(element.dataset.block);
  return (Array.isArray(spans) ? spans : []).find(span => span.index === index) ?? null;
}

/**
 * 块内某个位置之前的字符数。
 *
 * ★ 用 `Range` + `toString()` 而不是自己走文本节点：块里可能只有一段文本（简单），
 *   也可能因为上一次划线的高亮被切成「文字 / `<mark>` / 文字」（复杂）。用一个
 *   Range 从块首量到端点，两种结构得到同一个数字 —— 这正是「划了线之后还能在
 *   线上再划一条」需要的性质。
 * ★ 量出超过块长的结果直接判失败：那说明端点不在这个块里（浏览器把选区规范化到
 *   了块外），按它存下来的偏移一定会错位。
 */
export function offsetInBlock(blockElement, node, offset) {
  if (!blockElement || !node) return -1;
  const doc = blockElement.ownerDocument ?? null;
  if (doc === null || typeof doc.createRange !== 'function') return -1;
  const range = doc.createRange();
  try {
    range.selectNodeContents(blockElement);
    range.setEnd(node, Number(offset) || 0);
  } catch {
    return -1;
  }
  const length = String(range.toString() ?? '').length;
  const total = String(blockElement.textContent ?? '').length;
  if (length < 0 || length > total) return -1;
  return length;
}

/**
 * 选区 → 页内字符偏移。
 *
 * 两个端点必须落在**同一页正文里的块**上，否则返回 `null`（跨页选择本来就不该
 * 变成一条划线：存下来只有一个 `page` 字段）。
 */
export function anchorOfSelection(range, article, spans) {
  if (!range || !article) return null;
  if (range.collapsed === true) return null;
  const startBlock = blockElementOf(range.startContainer, article);
  const endBlock = blockElementOf(range.endContainer, article);
  if (startBlock === null || endBlock === null) return null;
  const startSpan = spanOfElement(spans, startBlock);
  const endSpan = spanOfElement(spans, endBlock);
  if (startSpan === null || endSpan === null) return null;
  const startIn = offsetInBlock(startBlock, range.startContainer, range.startOffset);
  const endIn = offsetInBlock(endBlock, range.endContainer, range.endOffset);
  if (startIn < 0 || endIn < 0) return null;
  const start = startSpan.start + startIn;
  const end = endSpan.start + endIn;
  if (end <= start) return null;
  return { start, end };
}

/**
 * 一段坐标落在某个块上的部分，换算成**块内偏移**（0..length）。
 *
 * 返回按起点排好序的 `[{ id, tone, start, end }]`；没有交集就返回 `[]`。
 */
export function marksForBlock(items, span, length) {
  const out = [];
  if (!span) return out;
  for (const item of Array.isArray(items) ? items : []) {
    if (!Number.isInteger(item?.start) || !Number.isInteger(item?.end)) continue;
    if (item.start >= span.end || item.end <= span.start) continue;
    const start = Math.max(item.start, span.start) - span.start;
    const end = Math.min(item.end, span.end) - span.start;
    if (end <= start) continue;
    out.push({
      id: String(item.id ?? ''),
      tone: String(item.tone ?? ''),
      start: Math.min(start, length),
      end: Math.min(end, length),
    });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * 一段文字按**划线 + 搜索命中**两层一起切成碎片。
 *
 * ★ 为什么不能先按划线切、再在碎片里按命中切：命中可能**横跨两片划线的边界**
 *   （用户先划了半句，再划后半句，然后搜一个跨过中间那个点的词）。两层各切一次，
 *   跨界的命中就会只剩半截高亮 —— 看起来像「搜到了但标错位置」。
 *   所以两层的边界**并成同一次切割**，每个碎片同时带着「属于哪条划线」和
 *   「是不是命中」两个属性。
 * ★ 一个碎片同时命中划线和高亮时**不嵌套 `<mark>`**：行内盒子多一层，
 *   断行机会与 `-webkit-line-clamp` 都会跟着变，而且嵌套的 `mix-blend-mode`
 *   在深色纸上会叠出第三种颜色。这里给同一个元素挂两个类，颜色由 CSS 裁决。
 * ★ `current`（当前这一处）只对**命中**有意义：同一片段上若同时有普通命中和当前
 *   命中（重叠的两次搜索不可能出现，但数据坏了会），取当前那一个。
 *
 * @param marks `[{ id, tone, start, end }]`（块内偏移）
 * @param finds `[{ start, end, current }]`（块内偏移，来自书内搜索）
 */
export function splitByOverlays(text, marks, finds) {
  const source = String(text ?? '');
  const clamp = (value) => Math.max(0, Math.min(source.length, Number(value)));
  const marksList = (Array.isArray(marks) ? marks : [])
    .map(mark => ({
      id: String(mark?.id ?? ''),
      tone: String(mark?.tone ?? ''),
      start: clamp(mark?.start),
      end: clamp(mark?.end),
    }))
    .filter(mark => Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.end > mark.start);
  const findsList = (Array.isArray(finds) ? finds : [])
    .map(find => ({
      start: clamp(find?.start),
      end: clamp(find?.end),
      current: find?.current === true,
    }))
    .filter(find => Number.isInteger(find.start) && Number.isInteger(find.end) && find.end > find.start);
  if (marksList.length === 0 && findsList.length === 0) {
    return [{ from: 0, to: source.length, tone: null, id: '', find: false, current: false }];
  }
  const points = new Set([0, source.length]);
  for (const item of marksList) { points.add(item.start); points.add(item.end); }
  for (const item of findsList) { points.add(item.start); points.add(item.end); }
  const sorted = [...points].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (to <= from) continue;
    const mark = marksList.find(item => item.start <= from && item.end >= to) ?? null;
    const hits = findsList.filter(item => item.start <= from && item.end >= to);
    const find = hits.length > 0;
    const current = hits.some(item => item.current);
    const tone = mark === null ? null : mark.tone;
    const id = mark === null ? '' : mark.id;
    const last = out[out.length - 1];
    if (last !== undefined && last.tone === tone && last.id === id
      && last.find === find && last.current === current) {
      last.to = to;
      continue;
    }
    out.push({ from, to, tone, id, find, current });
  }
  return out;
}

/**
 * 一段文字按划线切成碎片：`[{ from, to, tone, id }]`。
 *
 * ★ 相邻同色碎片要合并：一次划线经常横跨两段（被 `<mark>` 切过之后尤其明显），
 *   不合并就会在同一个色块里画出几条接缝 —— 浏览器给每段 `<mark>` 各画一次圆角。
 * ★ 重叠时取**先出现的那条**（`list.find`）：两条线交叉本来就少见，而把字画丢
 *   比颜色判错严重得多 —— 碎片是按区间切出来的，取谁都不会丢字。
 * ★ 没有划线时返回**一整片**（`tone: null`），调用方据此决定要不要包 `<mark>`。
 */
export function splitByMarks(text, marks) {
  const source = String(text ?? '');
  const list = (Array.isArray(marks) ? marks : [])
    .map(mark => ({
      id: String(mark?.id ?? ''),
      tone: String(mark?.tone ?? ''),
      start: Math.max(0, Number(mark?.start)),
      end: Math.min(source.length, Number(mark?.end)),
    }))
    .filter(mark => Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.end > mark.start);
  if (list.length === 0) return [{ from: 0, to: source.length, tone: null, id: '' }];

  const points = new Set([0, source.length]);
  for (const mark of list) {
    points.add(mark.start);
    points.add(mark.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (to <= from) continue;
    const hit = list.find(mark => mark.start <= from && mark.end >= to) ?? null;
    const tone = hit === null ? null : hit.tone;
    const id = hit === null ? '' : hit.id;
    const last = out[out.length - 1];
    if (last !== undefined && last.tone === tone && last.id === id) {
      last.to = to;
      continue;
    }
    out.push({ from, to, tone, id });
  }
  return out;
}
