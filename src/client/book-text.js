/**
 * PDF 文字层（TextLayer）与「划词追问」的**几何与摘句判据**。
 *
 * ★ 为什么要单独一个文件：这两件事的正确性都不在「代码写没写」上，而在
 *   「量出来的数字对不对」上。放在组件里就只能靠真 Chrome 截图看，写成纯函数
 *   才能既被单测覆盖、又被几何脚本调用同一套判据。
 *
 * ★ 为什么文字层必须自己算 scale：`<canvas>` 的位图尺寸是 `viewport.width × dpr`，
 *   而 CSS 尺寸是 `viewport.width`。文字层是**按 CSS 像素绝对定位**的 span，它要覆盖
 *   的是后者。两者混用会让选区整体偏移 `(dpr − 1) × 坐标` —— 屏幕越清晰偏得越多，
 *   在 2× 屏上表现为「选到左边的字」。
 */

/**
 * 文字层容器需要的尺寸与缩放变量。
 *
 * - `scale` 给 CSS 变量 `--total-scale-factor`（pdf.js 的 `setLayerDimensions()`
 *   用它把 PDF 页面尺寸换算成容器宽高）；
 * - `width` / `height` 是**画布的 CSS 尺寸**，两者必须一致，否则选区与字形错位。
 *
 * 取整用 `Math.floor` 而不是 `round`：`BookReader` 给画布设的宽度就是
 * `Math.floor(viewport.width)`。两处取整方式不同就会差 1px —— 那 1px 在
 * 逐字 span 上正好够把一个字的选区错到邻居身上。
 */
export function textLayerMetrics(viewport) {
  const scale = Number(viewport?.scale);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = Math.floor(Number(viewport.width));
  const height = Math.floor(Number(viewport.height));
  if (!(width > 0) || !(height > 0)) return null;
  return { scale, width, height };
}

/**
 * 拖窗口期间给文字层用的**临时**整体缩放。
 *
 * ★ 为什么需要它：画布在尺寸变化的那一帧只改 CSS（位图稍后重画，见
 *   `BookReader` 里「先改 CSS」那段），而文字层的 span 是按**上一次渲染的 scale**
 *   定位的。若不给它同倍缩放，拖窗口的那 160ms 里选区与字形是错开的 ——
 *   正好是用户最容易去拖选的时刻。
 *
 * 返回 `null` 表示「不需要动」（比例无效或已经是 1）。
 */
export function layerScaleRatio(renderedScale, nextScale) {
  const from = Number(renderedScale);
  const to = Number(nextScale);
  if (!Number.isFinite(from) || from <= 0) return null;
  if (!Number.isFinite(to) || to <= 0) return null;
  const ratio = to / from;
  return Math.abs(ratio - 1) < 1e-4 ? null : ratio;
}

/** 划词追问最多带多少字。超过就不弹气泡：那多半是整页全选，不是「这一句」。 */
export const QUOTE_LIMIT = 1200;

/**
 * 从当前选区里取出**属于文字层的**那一段文字，以及它在文字层里的位置。
 *
 * 返回 `null` 的五种情况都是「不该弹气泡」，而不是错误：
 *   1. 没有选区 / 选区塌缩（只是点了一下）；
 *   2. 选区两端不都在文字层内（例如从书页拖到侧栏的伴读文字上）；
 *   3. 选中的是空白（扫描页的空 span、或者页边距）；
 *   4. 超过 `QUOTE_LIMIT`（整页全选）；
 *   5. 量不到矩形（选区在离屏节点上）。
 *
 * ★ 坐标全部**相对文字层**，不是相对视口：书页在滚动容器里，用视口坐标定位会
 *   在滚动后把气泡留在原地。相对坐标写进 `position: absolute` 就自然跟着页面走。
 */
export function selectionQuote(selection, layer, { limit = QUOTE_LIMIT } = {}) {
  if (!selection || !layer) return null;
  if (selection.isCollapsed === true) return null;
  if (!Number.isInteger(selection.rangeCount) || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range) return null;
  for (const node of [range.startContainer, range.endContainer]) {
    if (!node || typeof layer.contains !== 'function' || !layer.contains(node)) return null;
  }
  // 空白压成单个空格，但**保留换行**：OCR 版逐字一个 span，同一行内的字拼起来
  // 本来就没有分隔符；跨行的那一次换行是原文的换行，压掉会把两行粘成一句
  // （复制出来的文本也就跟着错了）。
  const text = String(selection.toString() ?? '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (text === '') return null;
  if (text.length > limit) return null;
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  const box = typeof layer.getBoundingClientRect === 'function' ? layer.getBoundingClientRect() : null;
  if (!rect || !box) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    text,
    /** 选区首行的上沿、末行的下沿（相对文字层）。 */
    top: rect.top - box.top,
    bottom: rect.bottom - box.top,
    /** 选区水平中心（相对文字层）：气泡以它居中。 */
    centerX: rect.left - box.left + rect.width / 2,
    /** 文字层的总高：气泡要据此决定「放上方还是下方」。 */
    layerHeight: box.height,
  };
}

/** 气泡高度（含与选区的间隙）。上下两边都要留这么多，否则会压住选中的字。 */
export const QUOTE_BAR_HEIGHT = 34;

/**
 * 气泡该放在选区上方还是下方，以及它的 `top` / `bottom` 用哪个。
 *
 * ★ 判据是**上方有没有位置**，不是「选区在页面上半还是下半」：
 *   页面顶部那一行选中时，上方只剩页边距，`translate(-50%, -100%)` 会把气泡
 *   顶出书页、落到工具栏上 —— 看起来就是「气泡跑到别的控件上去了」。
 *
 * 返回 `{ side, value }`：`side === 'above'` 时用 `bottom: value`（相对文字层底），
 * `side === 'below'` 时用 `top: value`。
 */
export function quoteBarPlacement(quote, { barHeight = QUOTE_BAR_HEIGHT } = {}) {
  if (!quote) return null;
  if (!(quote.top >= barHeight + 4)) return { side: 'below', value: quote.bottom + 6 };
  return { side: 'above', value: Math.max(0, quote.layerHeight - quote.top + 6) };
}

/**
 * 文字层里的**可见文字**长度（用来判断「这一页有没有文字层」）。
 *
 * ★ 不能直接数 span：pdf.js 会给页边距、图注占位、伪空格也生成 span，
 *   扫描页上照样有一堆空 span。只数真正有字的才能区分「扫描版」与「文字版」。
 */
export function textLayerCharCount(layer) {
  if (!layer || typeof layer.textContent !== 'string') return 0;
  return layer.textContent.replace(/\s+/g, '').length;
}
