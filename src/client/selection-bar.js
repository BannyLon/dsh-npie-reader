/**
 * 选中文本后那条小工具条（「摘录到灵感」/「问 AI」）的定位计算。
 *
 * 抽成纯函数的原因：这条逻辑有四个边界（上方放不下 / 下方也放不下 / 选区贴左右边 /
 * range 无效），全埋在组件里就只能靠肉眼在真机上碰运气。纯函数能直接喂矩形断言。
 *
 * 输入 rect 用 `Range.getBoundingClientRect()` 的形状（top/bottom/left/width/height），
 * viewport 用 window 的形状（innerWidth/innerHeight）。两者都可注入，node 里能跑。
 */

/** 工具条高度：padding 3*2 + 按钮 4*2 + 12.5px 文字行高，向上取整留余量。 */
export const BAR_HEIGHT = 40;
/** 工具条半宽：两颗按钮 + 图标约 178px，取 90 作为夹取用的半宽。 */
export const BAR_HALF_WIDTH = 90;
/** 与窗口边缘的最小间距。 */
export const VIEWPORT_EDGE = 8;

/**
 * @param {{top:number,bottom:number,left:number,width:number,height:number}|null} rect
 * @param {{innerWidth?:number,innerHeight?:number}} viewport
 * @returns {{top:number,left:number}|null} rect 无效时返回 null（调用方据此不显示工具条）
 */
export function selectionBarPlacement(rect, viewport = {}) {
  if (!rect) return null;
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  // 空 range（选区被折叠 / 只选中了空白）拿到的矩形是 0×0，浮出来会是个孤儿条。
  if (width === 0 && height === 0) return null;

  const winWidth = Number(viewport.innerWidth) || 0;
  const winHeight = Number(viewport.innerHeight) || 0;

  // 纵向：优先浮在选区上方；上方贴边就翻到下方；下方也放不下（窗口很矮）就贴底部。
  const above = rect.top - BAR_HEIGHT;
  const below = rect.bottom + VIEWPORT_EDGE;
  let top;
  if (above >= VIEWPORT_EDGE) {
    top = above;
  } else if (winHeight === 0 || below + BAR_HEIGHT <= winHeight - VIEWPORT_EDGE) {
    top = below;
  } else {
    top = Math.max(VIEWPORT_EDGE, winHeight - BAR_HEIGHT - VIEWPORT_EDGE);
  }

  // 横向：以选区中心为轴，夹进窗口。窗口比工具条还窄时按半窗口夹，避免 left 变成负数。
  const center = rect.left + width / 2;
  const half = winWidth > 0 ? Math.min(BAR_HALF_WIDTH, winWidth / 2) : BAR_HALF_WIDTH;
  const left = winWidth > 0 ? Math.min(Math.max(center, half), winWidth - half) : center;

  return { top, left };
}
