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

/**
 * 面板的类名。指针落在它们里面时**不滑出**（见下面的 `insidePanel`）。
 *
 * `npr-book-digest` = 目录 / 解读（同一套外壳，两个入口），`npr-marks` = 划线，
 * `npr-companion` = 伴读。三个都不在 `npr-book-chrome` 里，是 `npr-book-main` 的子元素。
 */
export const PEEK_PANEL_CLASSES = ['npr-book-digest', 'npr-marks', 'npr-companion'];

/**
 * 指针是不是落在**某个面板**上。
 *
 * ★ 为什么要挡（0.25.7 的真机故障）：沉浸态下胶囊用 `absolute; left:0; right:0`
 *   铺满窗口宽度滑出，而面板也从窗口顶边开始 —— 用户点面板右上角那个「收起」时，
 *   鼠标必然先划过面板顶部那一行；`pointermove` 一到，胶囊就滑出来盖在按钮上，
 *   按钮就点不到了。用户原话：「目录的框就会关闭了，因为鼠标一移动上去，就会划出
 *   菜单，菜单就会遮挡掉目录框的关闭按钮」。
 * ★ 判据放在**指针进面板**这一侧，而不是给胶囊加层级：抬高层级只是把「按钮被盖住」
 *   换成「胶囊被面板切掉一截」—— 按钮看得见了，胶囊却点不到，问题只是搬了个家。
 * ★ 走父链而不是 `closest()`：这条判据决定「关闭按钮点不点得到」，必须在纯函数里
 *   测得到，而 `closest` 要真 DOM。父链遍历喂假节点就能测，代价只是一个深度上限。
 *
 * @param node 事件的 `target`（可以是 `null` —— 事件被合成时它可能是空的）
 * @param classes 面板类名，测试里会换一份
 */
export function insidePanel(node, classes = PEEK_PANEL_CLASSES) {
  let current = node ?? null;
  // 20 层够到面板根：块 → 列表 → 面板，实际不超过 8 层；上限只是防假节点自引用成死循环。
  for (let depth = 0; current !== null && depth < 20; depth += 1) {
    const raw = current.className;
    // SVG 元素的 `className` 是 `SVGAnimatedString`，直接拼字符串会得到
    // `[object SVGAnimatedString]` —— 面板里有图标，图标里就是 `<svg>`。
    const name = typeof raw === 'string' ? raw : String(raw?.baseVal ?? '');
    if (classes.some((item) => name.split(/\s+/).includes(item))) return true;
    current = current.parentElement ?? null;
  }
  return false;
}
