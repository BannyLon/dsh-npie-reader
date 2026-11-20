/**
 * PDF 页内链接：把 `page.getAnnotations()` 里的 `Link` 注解变成**能点的热区**。
 *
 * 为什么自己要写这一层：内置的 pdf.js 6.4.299 **没有** `AnnotationLayer` 的默认
 * `LinkService`（`SimpleLinkService` / `LinkTarget` 都不在这份构建里）。官方 Viewer
 * 里那条 `annotation_layer_builder.js` 也没有随包发布 —— 所以「点参考文献跳到第 9 页」
 * 「点 DOI 打开浏览器」这两件事，要么自己接，要么整个阅读器里所有蓝色字都是死的。
 *
 * 这一层只做**纯几何 + 白名单**，不碰 DOM、不碰 pdf.js 的内部对象（除了一个
 * `convertToViewportRectangle` 的方法调用）：坐标换算和 URL 过滤是最容易被真机
 * 打脸的两处，写成纯函数才能被单测按住。
 *
 * 三条边界（都有代价，是权衡过的）：
 *
 * 1. **只认 http / https / mailto。** PDF 里的 `url` 是**文档作者写的内容**，不是
 *    我们生成的内容 —— 一份恶意 PDF 完全可以放 `javascript:` 或 `file:///etc/passwd`。
 *    pdf.js 自己也带 `unsafeUrl` 的过滤，但我们不共享那份判定，宁可显式白名单。
 * 2. **热区不覆盖文字层。** 链接层 `pointer-events: none`、只有 `<a>` 自己 `auto`：
 *    链接矩形通常只有短短几个字（参考文献编号、DOI），代价是「从链接正中起手拖选」
 *    会选中链接而不是文字 —— 和 Adobe / 浏览器 PDF 插件的表现一致。
 * 3. **坐标一律取 CSS 像素**，与画布显示尺寸同一套（`viewport` 的 scale 就是画布
 *    CSS 尺寸所用的那个 scale）。混用 `dpr` 会让热区整体偏移，2× 屏上偏得最明显。
 */

/** 单页最多渲染多少个链接热区。挡的是畸形 PDF（一页几千个 Link 注解）。 */
export const MAX_LINKS_PER_PAGE = 400;

/** 能安全交给浏览器打开的协议。`javascript:` / `data:` / `file:` 一律拦下。 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * 过滤一个 URL。
 *
 * @returns {string} 可用的绝对地址；空串 = 这条链接不该被渲染。
 */
export function safeLinkUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return '';
  // 控制字符会被浏览器用于绕过协议判断（`java\nscript:`），先整段拒掉。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return '';
  let url;
  try {
    // 相对地址在这里没有意义（PDF 没有「当前页面 URL」），有 base 也只是拼出一个假的。
    url = new URL(text, 'https://invalid.local/');
  } catch {
    return '';
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return '';
  // `https://invalid.local/x` 说明原文是相对地址 —— 丢掉，别打开一个不存在的站。
  if (url.host === 'invalid.local') return '';
  return url.href;
}

/** 一条 `Link` 注解是不是我们需要的那种（有坐标、且有可去的地方）。 */
export function isLinkAnnotation(annotation) {
  if (annotation === null || typeof annotation !== 'object') return false;
  if (annotation.subtype !== 'Link') return false;
  const rect = annotation.rect;
  return Array.isArray(rect) && rect.length === 4 && rect.every(value => Number.isFinite(Number(value)));
}

/**
 * `rect`（PDF 用户单位，左下原点）→ 视口内 CSS 像素矩形（左上原点）。
 *
 * ★ 必须走 `viewport.convertToViewportRectangle`，不要手写 `y' = H - y`：
 *   旋转页（`/Rotate 90`）和 CropBox 偏移都在这一个方法里，自己算必错。
 * ★ 结果要归一成 min/max：pdf.js 对翻转过的轴会给出「大到小」的序列。
 */
function boxOfRect(rect, viewport) {
  let corners;
  try {
    corners = viewport.convertToViewportRectangle(rect);
  } catch {
    return null;
  }
  if (!Array.isArray(corners) || corners.length !== 4) return null;
  const x0 = Number(corners[0]);
  const y0 = Number(corners[1]);
  const x1 = Number(corners[2]);
  const y1 = Number(corners[3]);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  // 零宽/零高的热区点不到；亚像素的也不给（那是「看上去能点、其实点不到」的典型）。
  if (width < 1 || height < 1) return null;
  return { left, top, width, height };
}

/**
 * 一页的注解 → 热区列表。
 *
 * @param {Array<object>} annotations `page.getAnnotations()` 的结果
 * @param {{ convertToViewportRectangle: (rect: number[]) => number[] }} viewport
 * @returns {Array<{ key: string, left: number, top: number, width: number, height: number, url: string, dest: unknown, hint: string }>}
 *   `url` 与 `dest` 至少一个非空；`dest` 原样透传，由调用方用文档对象解析成页码。
 */
export function linkBoxesOf(annotations, viewport) {
  if (!Array.isArray(annotations) || viewport === null || typeof viewport !== 'object') return [];
  if (typeof viewport.convertToViewportRectangle !== 'function') return [];
  const out = [];
  for (const annotation of annotations) {
    if (out.length >= MAX_LINKS_PER_PAGE) break;
    if (!isLinkAnnotation(annotation)) continue;
    const box = boxOfRect(annotation.rect, viewport);
    if (box === null) continue;
    const url = safeLinkUrl(annotation.url ?? annotation.unsafeUrl);
    const dest = annotation.dest ?? null;
    // 既没有外链、也没有内部目的地：这种 Link 点了什么都不会发生（PDF 里很常见，
    // 是注释框的遗留物）。渲染成热区只会挡住文字层。
    if (url === '' && dest === null) continue;
    out.push({
      // 同一页上同一个 URL 可能出现多次（页脚重复的 DOI），所以键里带坐标。
      key: `${Math.round(box.left)}-${Math.round(box.top)}-${Math.round(box.width)}x${Math.round(box.height)}`,
      ...box,
      url,
      dest,
      hint: url !== '' ? url : '跳转',
    });
  }
  return out;
}

/**
 * 解析内部目的地 → 页码（从 1 开始）。
 *
 * `dest` 有两种形态：
 *   · 字符串：命名目的地，要先 `doc.getDestination(name)` 换成数组；
 *   · 数组：`[ref | pageIndex, { name: 'XYZ' }, ...]`，第一位是 `PDFRef`（取
 *     `doc.getPageIndex(ref)`）或**已经是 0 起的页码**（少数生成器这么写）。
 *
 * ★ 解析不出来返 `0`，**不要**猜一个 1 —— 跳到第一页比什么都不做更让人困惑。
 *
 * @param {object} doc `PDFDocumentProxy`
 * @param {unknown} dest
 * @param {Map<string, number>} [cache] 命名目的地缓存（一次导出里同一个名字会被点很多次）
 * @returns {Promise<number>} 0 = 解析不出来
 */
export async function resolveDestPage(doc, dest, cache = new Map()) {
  if (doc === null || doc === undefined) return 0;
  let target = dest;
  try {
    if (typeof target === 'string') {
      const name = target;
      if (cache.has(name)) return cache.get(name);
      target = await doc.getDestination(name);
      if (!Array.isArray(target)) return 0;
      // 命名目的地只解析一次就够：同一份文档里名字不会指向两个页码。
      // 但页码解析是异步的，先解析完再写缓存（见下）。
      const page = await pageOfDest(doc, target);
      if (page > 0) cache.set(name, page);
      return page;
    }
    if (Array.isArray(target)) return await pageOfDest(doc, target);
  } catch {
    return 0;
  }
  return 0;
}

async function pageOfDest(doc, dest) {
  const first = dest[0];
  if (first === null || first === undefined) return 0;
  if (typeof first === 'number') {
    // 0 起页码：`doc.getPage` 是 1 起，所以 +1；越界由调用方 `clampPage` 兜。
    return Number.isInteger(first) ? first + 1 : 0;
  }
  if (typeof first === 'object' && typeof first.num === 'number') {
    const index = await doc.getPageIndex(first);
    return Number.isInteger(index) ? index + 1 : 0;
  }
  return 0;
}

export { SAFE_PROTOCOLS };
