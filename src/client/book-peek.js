/**
 * 沉浸态顶部胶囊「要不要滑出来」—— 一条纯函数，两个组件共用。
 *
 * ★ 为什么不能只靠 CSS `:hover`（0.25.4 的真机故障）：
 *   热区本来是 `.npr-book-toolbar` —— 那条 10px 的**窗口拖动条**。可它在宿主里是被
 *   `-webkit-app-region: drag` 标成拖动区的，Chromium 把它当窗口标题栏命中
 *   （`HTCAPTION`）⇒ **页面收不到任何鼠标事件**，`:hover` 永远不成立。
 *   于是胶囊滑出去就再也滑不回来（用户原话：「顶部的菜单条一旦隐藏就出不来了」）。
 *   探针页里没有这条声明，所以门禁里用真指针派发事件是**绿的** —— 那是一条假绿。
 *
 * ★ 现在的判据改成「指针离面板顶边多近」，用 `pointermove` 自己算：拖动条那 10px
 *   仍然收不到事件，但指针要去到那块，必然先经过它下面 —— 只要在 **56px** 以内就滑出。
 *   收起来要等指针落到 **72px** 以下（滞回），否则在边界上会一开一合地抖。
 */
export const PEEK_SHOW = 56;
export const PEEK_HIDE = 72;

/**
 * @param {boolean} current 现在是不是滑出状态
 * @param {number} distance 指针离面板顶边多少像素（`e.clientY - rootRect.top`）
 * @returns {boolean} 下一帧要不要滑出
 */
export function peekNext(current, distance) {
  if (!Number.isFinite(distance)) return current;
  if (distance <= PEEK_SHOW) return true;
  if (distance > PEEK_HIDE) return false;
  return current;
}

/**
 * 指针离开面板时怎么办。
 *
 * ★ 不能一律收起：指针往**上**走出面板，很可能是走进了顶部那 10px 拖动条
 *   （在宿主里它连鼠标事件都不给，于是我们收到的是 `pointerleave`）—— 而用户
 *   正是在「伸手去点胶囊」。这时候把它收掉，等于伸手的瞬间工具条消失。
 *   所以只有「从正文那一侧离开」才收；从顶部走掉就留着。
 *
 * @param {number} distance 离开那一刻指针离面板顶边的距离
 */
export function peekOnLeave(distance) {
  if (!Number.isFinite(distance)) return false;
  return distance <= PEEK_SHOW;
}
