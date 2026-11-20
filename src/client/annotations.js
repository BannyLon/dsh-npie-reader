/**
 * 划线 / 笔记：**锚点换算**与**纯数据判据**。
 *
 * 为什么单独一个文件（和 `book-text.js` 同一个理由）：这里的东西要么是纯函数
 * （能被单测直接喂数字），要么是「只碰 DOM 节点、不碰组件状态」的小工具。
 * 塞进 `BookReader` 就只能靠真机点，而锚点算错的表现是「线画到了邻居那行」，
 * 那种错在截图上很难看出来。
 *
 * ── 锚点为什么是「页内字符偏移」而不是坐标 ───────────────────────────────
 *
 *   · 坐标随缩放 / 适宽 / 窗口宽度变化 ⇒ 存下来的一刷新就错位；
 *   · PDF 原生注释要写回用户的文件，本项目不干；
 *   · 偏移 + 摘录原文：渲染时用 Range 重算矩形，缩放自然跟着走；文字层变了
 *     （换过文件、重抽过）还能用原文兜底找回，找不回就如实标成「失配」。
 *
 * ★ 偏移的基准是**文字层容器的 `textContent`**（含 pdf.js 插入的换行/伪空格），
 *   不是「去掉空白后的正文」。两套基准混用会在跨行选区的终点上差几个字符。
 */
import { TONE_LABELS, TONE_ORDER as TONE_ORDER_FROM_FORMAT } from '../annotation-format.js';
import { MISMATCH } from '../annotation-relocate.js';

/**
 * 标记色板。
 *
 * ★ 顺序即界面上色点的顺序，也是 `N` 之类轮转的依据。
 * ★ 名字是**语义**而不是颜色（`yellow` 不是「黄」而是「重点」）：将来调色值
 *   不该连带改一遍数据文件 —— 已经写进用户磁盘的那几百条划线上写着 `yellow`。
 * ★ **值从 `annotation-format.js` 取，不在这里再写一遍**：导出的 Markdown 也要
 *   写这四个标签。两边各写一份时，改了一处、另一处不改不会有任何报错，
 *   只会让「界面上叫重点、导出稿里叫黄」悄悄地发生。
 */
export const ANNOTATION_TONES = TONE_LABELS;

export const TONE_ORDER = TONE_ORDER_FROM_FORMAT;

/** 与宿主侧 `annotation-store.js` 的两个上限保持一致（两边都有测试盯着）。 */
export const NOTE_LIMIT = 4000;
export const QUOTE_LIMIT = 4000;

export function isTone(value) {
  return Object.hasOwn(ANNOTATION_TONES, value);
}

/** 色点轮转（没有选中任何色点时给第一个）。 */
export function nextTone(tone) {
  const index = TONE_ORDER.indexOf(tone);
  if (index === -1 || index === TONE_ORDER.length - 1) return TONE_ORDER[0];
  return TONE_ORDER[index + 1];
}

/**
 * 把一条来自磁盘 / 网络的数据收成可渲染的形状。**不认识的东西返回 `null`**。
 *
 * ★ 客户端也要校验一遍，不能「宿主校验过就直接用」：
 *   - 文件是用户的，可以被手改；
 *   - 宿主版本可能比界面旧（插件热更新期间两份代码并存）。
 *   渲染一个 `page: "abc"` 的条目会让页码跳转变 NaN，整个阅读器停在第一页。
 */
export function normalizeAnnotation(value) {
  if (value === null || typeof value !== 'object') return null;
  const page = Number(value.page);
  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isInteger(page) || page < 1) return null;
  if (!Number.isInteger(start) || start < 0) return null;
  if (!Number.isInteger(end) || end <= start) return null;
  const quote = typeof value.quote === 'string' ? value.quote : '';
  if (quote.trim() === '') return null;
  const id = typeof value.id === 'string' ? value.id : '';
  if (id === '') return null;
  const out = {
    id,
    page,
    start,
    end,
    quote,
    note: typeof value.note === 'string' ? value.note : '',
    tone: isTone(value.tone) ? value.tone : TONE_ORDER[0],
    createdAt: Number(value.createdAt) || 0,
    updatedAt: Number(value.updatedAt) || 0,
  };
  /**
   * `mismatch` 是宿主在**读取时**算出来的投影标记，不落盘、不该被这里抹掉：
   * 抹掉就等于界面把「这句原文已经找不到了」画成一条正常划线。只在值合法时
   * 才带上 —— 老数据没有这个字段时 `deepEqual(归一化结果, 原对象)` 仍然成立。
   */
  if (value.mismatch === MISMATCH.MISSING || value.mismatch === MISMATCH.AMBIGUOUS) {
    out.mismatch = value.mismatch;
  }
  return out;
}

/** 规范化一整份列表并按「页码 → 起点」排序（渲染顺序就是阅读顺序）。 */
export function normalizeAnnotations(list) {
  const out = [];
  for (const value of Array.isArray(list) ? list : []) {
    const item = normalizeAnnotation(value);
    if (item !== null) out.push(item);
  }
  return out.sort(compareAnnotations);
}

export function compareAnnotations(a, b) {
  if (a.page !== b.page) return a.page - b.page;
  if (a.start !== b.start) return a.start - b.start;
  return (a.createdAt ?? 0) - (b.createdAt ?? 0);
}

/** 这一页上的划线。 */
export function annotationsOnPage(items, page) {
  return (Array.isArray(items) ? items : []).filter(item => item.page === page);
}

/** 两段区间是否重叠（含端点相接不算重叠 —— 紧挨着的两次划线是两条，不是一条）。 */
export function overlaps(a, b) {
  return a.page === b.page && a.start < b.end && b.start < a.end;
}

/**
 * 同一页上**已经覆盖了**这段区域的划线（拖选边界差一两个字符时命中）。
 *
 * 返回第一条命中的条目；没有就 `null`。用「完全包含」而不是「有任何交集」：
 * 用户先划了一句、又把更大的段落划一次，那是两次不同的意图，不该被当成重复。
 */
export function coveringAnnotation(items, draft) {
  for (const item of Array.isArray(items) ? items : []) {
    if (item.page !== draft.page) continue;
    if (item.start <= draft.start && item.end >= draft.end) return item;
  }
  return null;
}

/** 面板头部的三个数字。`notes` 是「写了字的」，`total` 是全部划线。 */
export function summariseAnnotations(items) {
  const list = Array.isArray(items) ? items : [];
  const notes = list.filter(item => item.note.trim() !== '').length;
  const pages = new Set(list.map(item => item.page));
  return { total: list.length, notes, pages: pages.size };
}

/**
 * 把 `[start, end)` 这段字符区间切到各个文本节点上。
 *
 * @param lengths - 每个文本节点的字符数（按文档顺序）。
 * @returns `[{ index, from, to }]`；区间完全落在节点之外时返回 `[]`。
 *
 * ★ 必须逐节点切：pdf.js 的文字层是**一行一个 span、有时一个字一个 span**，
 *   直接把整段的 `Range` 建在「第一个节点 → 最后一个节点」上，中间那些
 *   **行尾换行**也会被囊括进去 —— 于是高亮会多出一块横跨整行的矩形。
 */
export function slicesOf(lengths, start, end) {
  const out = [];
  if (!Array.isArray(lengths) || lengths.length === 0) return out;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return out;
  let offset = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = Number(lengths[index]) || 0;
    const nodeStart = offset;
    const nodeEnd = offset + length;
    offset = nodeEnd;
    if (nodeEnd <= start) continue;
    if (nodeStart >= end) break;
    const from = Math.max(start, nodeStart) - nodeStart;
    const to = Math.min(end, nodeEnd) - nodeStart;
    // 空 span（pdf.js 会给页边距/图注占位生成零长节点）切出来是 `{from:0,to:0}`：
    // 拿它去 `setStart/setEnd` 会得到一个塌缩的 Range ⇒ 高亮画不出来，整段消失。
    if (to <= from) continue;
    out.push({ index, from, to });
  }
  return out;
}

/** 文字层里所有的文本节点（文档顺序）。 */
export function textNodesOf(layer) {
  if (!layer) return [];
  const doc = layer.ownerDocument ?? null;
  if (doc === null || typeof doc.createTreeWalker !== 'function') return [];
  const walker = doc.createTreeWalker(layer, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node);
  return nodes;
}

/**
 * 选区 → 页内字符偏移。
 *
 * 返回 `null` 的三种情况与 `selectionQuote` 一致（不在文字层里 / 塌缩 / 量不到），
 * 只是这里还要求两端都能**定位到文本节点**：定位不到就没法存偏移，存了也画不出来。
 */
export function anchorOfRange(range, nodes) {
  if (!range || !Array.isArray(nodes) || nodes.length === 0) return null;
  if (range.collapsed === true) return null;
  const indexOf = (node, offset) => {
    let base = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const text = nodes[i];
      if (text === node) return base + offset;
      // 选区端点落在**元素**上（`span > text` 之外的情形）：pdf.js 偶发把
      // `startContainer` 设成 span 本身，此时按 `offset` 数子节点 —— 用该 span
      // 的首字符位置近似。差一个字符，但比整条划线画不出来要好。
      if (typeof text.parentNode === 'object' && text.parentNode === node) return base;
      base += String(text.nodeValue ?? '').length;
    }
    return -1;
  };
  const start = indexOf(range.startContainer, range.startOffset);
  const end = indexOf(range.endContainer, range.endOffset);
  if (start < 0 || end < 0 || end <= start) return null;
  return { start, end };
}

/** 页内偏移 → `Range`（跨节点时逐节点切，见 `slicesOf`）。 */
export function rangeOfAnchor(layer, nodes, start, end) {
  const lengths = nodes.map(node => String(node.nodeValue ?? '').length);
  const slices = slicesOf(lengths, start, end);
  if (slices.length === 0) return null;
  const doc = layer?.ownerDocument ?? null;
  if (doc === null || typeof doc.createRange !== 'function') return null;
  const first = slices[0];
  const last = slices[slices.length - 1];
  const range = doc.createRange();
  try {
    range.setStart(nodes[first.index], first.from);
    range.setEnd(nodes[last.index], last.to);
  } catch {
    return null;
  }
  return range;
}

/**
 * Range → 相对文字层的矩形列表。
 *
 * ★ 合并**同一行**的碎片：pdf.js 逐字 span，`getClientRects()` 会给出几十个
 *   首尾相接的小矩形。不合并的话，每个字一条 `div`，一页几十条划线就是几千个
 *   节点 —— 翻页时肉眼可见地卡。判据是「垂直区间重叠 ⇒ 同一行」。
 * ★ 丢掉宽度 ≤ 0 的碎块（行尾空格、零宽字符），它们画出来是不可见的边框。
 */
export function rectsOfRange(range, layer) {
  if (!range || !layer) return [];
  const box = typeof layer.getBoundingClientRect === 'function' ? layer.getBoundingClientRect() : null;
  if (box === null) return [];
  const rects = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];
  const lines = [];
  for (const rect of rects) {
    if (!(rect.width > 0) || !(rect.height > 0)) continue;
    const top = rect.top - box.top;
    const left = rect.left - box.left;
    const last = lines[lines.length - 1];
    if (last !== undefined
      && Math.abs(last.top - top) < rect.height * 0.5
      && Math.abs(last.height - rect.height) < rect.height * 0.5
      && left - (last.left + last.width) < 4) {
      const right = Math.max(last.left + last.width, left + rect.width);
      last.left = Math.min(last.left, left);
      last.width = right - last.left;
      last.top = Math.min(last.top, top);
      last.height = Math.max(last.height, rect.height);
      continue;
    }
    lines.push({ left, top, width: rect.width, height: rect.height });
  }
  return lines;
}
