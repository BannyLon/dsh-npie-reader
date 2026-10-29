/**
 * 列表行的右键菜单（0.45.4）：**放哪儿**、**放哪几项**。
 *
 * ★ 两件事都抽成纯函数，因为它们是这功能里唯一「错了也看不出来」的部分：
 *   · 位置算错 ⇒ 菜单贴着窗口右缘被裁掉一半，而它自己不会报错；
 *   · 项目算错 ⇒ 「已隐藏」列表里弹出一个「隐藏这篇文章」，点下去页面不变（它本来就隐藏着）。
 *   剩下的（渲染、事件）都在 `ReaderPage.jsx` 里，那是看得见的部分。
 */

/**
 * 菜单外框尺寸。**写死在这里而不是量 DOM**：菜单要在第一次出现时就摆对位置，
 * 而那时它还没渲染出来，量不到。宽度与 CSS 的 `min-width` 对齐（改一处要改两处，
 * 判据 `test/row-menu.test.mjs` 会读 CSS 核对）。
 */
export const ROW_MENU_WIDTH = 196;
/** 三个菜单项各 32px + 上下内边距 5×2。多一项就要跟着改，所以判据里核的是项数。 */
export const ROW_MENU_HEIGHT = 106;

/**
 * 把菜单摆进视口内。
 *
 * ★ 为什么不是「向下弹出、越界就向上翻」：右键的位置是用户的鼠标，他可能点在
 *   列表最底下一行。翻转要在「菜单高度」和「鼠标上方空间」之间比较，结果是一个
 *   跳来跳去的菜单（同一行右键两次，第一次向下、第二次向上）。**夹取**只会把菜单
 *   推回界内，位置相对鼠标的变化是连续的 —— 看起来不会「跳」。
 * ★ `margin` 也要夹住：窗口窄到 `width + 2*margin > viewportWidth` 时，
 *   `max` 会算出负数，菜单会跑到左边看不见的地方。所以下界取 `margin`、上界取
 *   `max(margin, viewport - size - margin)`。
 */
export function placeRowMenu({
  x, y,
  width = ROW_MENU_WIDTH,
  height = ROW_MENU_HEIGHT,
  viewportWidth,
  viewportHeight,
  margin = 8,
}) {
  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const maxTop = Math.max(margin, viewportHeight - height - margin);
  return {
    left: Math.round(Math.min(Math.max(x, margin), maxLeft)),
    top: Math.round(Math.min(Math.max(y, margin), maxTop)),
  };
}

/**
 * 菜单三项（顺序即显示顺序）。
 *
 * ★ 第三项是**同一个位置的两态**，不是两条并列项 —— 与阅读区「更多操作」里那条
 *   完全同一个理由：在「已隐藏」筛选下列表里全是已隐藏的文章，再给一条「隐藏这篇文章」
 *   就是一句点了没反应的假话。判据 `test/row-menu.test.mjs` 钉住「有且只有一条状态项」。
 * ★ 前两项永远是「对人」与「对文件」：打印给你看，Markdown 给你改。
 * ★ `icon` 也放在这里（而不是在 JSX 里写成三元表达式）：`test/icons.test.mjs` 会扫
 *   `name={…}` 里的字符串字面量当图标名 —— 三元里的 `'print'` / `'markdown'` 会被
 *   当成图标名去查，查不到就红。图标名是**数据**，放在这张表里既避开了那个扫描，
 *   也让「菜单项 → 图标」只有一处定义。
 */
export function rowMenuItems(entry) {
  return [
    { kind: 'print', label: '打印 / 存为 PDF', icon: 'file-check' },
    { kind: 'markdown', label: '导出 Markdown', icon: 'download' },
    entry?.hidden === true
      ? { kind: 'unhide', label: '恢复这篇文章', icon: 'eye-off' }
      : { kind: 'hide', label: '隐藏这篇文章', icon: 'eye-off' },
  ];
}
