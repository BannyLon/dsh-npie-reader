/**
 * 文章大纲（TOC）的两条纯逻辑，从 `ReaderPage.jsx` 里抽出来。
 *
 * ★ 为什么抽出来：这两条是「大纲对不对」的全部内容 —— 哪些标题算、层级怎么排、
 *   读到哪一节算「当前」。留在组件里就只能靠读源码断言，而**读源码答不了
 *   「这段代码跑起来对不对」**（本项目在这上面栽过：收窄的分支永不执行、断言全绿）。
 *   抽成纯函数之后，测试是真的在跑它们。
 *
 * ★ 为什么标题从 DOM 取、不从 HTML 字符串正则匹配：`sanitizeHtml` 会丢掉它不认识的
 *   标签与属性，正则数出来的标题可能根本不在页面上；译文 / 改写两条路径的标签结构
 *   也不一样。DOM 是唯一的真相 —— 所以这里收的是**节点**，不是字符串。
 */

/** 目录里一行最多留多少个字。侧栏 232px、12.5px 字号，44 字大概两行。 */
export const OUTLINE_TEXT_LIMIT = 44;

/** 「当前读到哪一节」的判定线：标题进入视口顶部往下这么多像素就算读到了。 */
export const OUTLINE_ACTIVE_OFFSET = 96;

/**
 * 把一批标题节点压成目录项。
 *
 * @param {Array<{tagName?: string, textContent?: string}>} nodes 正文里的标题节点
 * @param {{maxText?: number, levels?: number[]}} [options]
 * @returns {Array<{key: string, full: string, text: string, level: number}>}
 *
 * ★ 空标题**不进目录**：有的源用 `<h2><a id="x"></a></h2>` 当锚点，正文里什么都没有。
 *   收进目录的话，用户点一行、页面纹丝不动 —— 那比没有这一行更糟。
 * ★ `full` 与 `text` 两个都要：`text` 是截断后显示在窄栏里的，`full` 给 `title`
 *   悬停看全。只留一个的话，要么目录被撑爆，要么截断后再也看不到原文。
 */
export function outlineOf(nodes, options = {}) {
  const maxText = Number.isFinite(options.maxText) ? options.maxText : OUTLINE_TEXT_LIMIT;
  const levels = Array.isArray(options.levels) ? options.levels : [1, 2, 3, 4];
  const items = [];
  const list = nodes ?? [];
  for (let at = 0; at < list.length; at += 1) {
    const node = list[at];
    const level = Number(String(node?.tagName ?? '').slice(1));
    if (!levels.includes(level)) continue;
    const full = String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (full === '') continue;
    items.push({
      key: String(items.length),
      // ★ 必须带回**输入数组里的下标**：空标题会被过滤掉，所以「目录第 2 项」
      //   不等于「第 2 个标题节点」。调用方要按这个下标把锚点打回**同一个**节点，
      //   拿目录下标去索引节点会静默错位（点第 3 节跳到第 4 节，而且不报错）。
      at,
      full,
      level,
      text: full.length > maxText ? `${full.slice(0, maxText)}…` : full,
    });
  }
  return items;
}

/**
 * 当前读到第几节。
 *
 * @param {number[]} tops 每个标题**相对滚动容器顶部**的距离（已滚过去的为负数）
 * @param {number} [offset] 判定线，默认 {@link OUTLINE_ACTIVE_OFFSET}
 * @returns {number} 命中的下标；一个都没到判定线时给 0
 *
 * ★ 取「最后一个已经越过判定线的」而不是「离判定线最近的那个」：后者在两条标题
 *   相距很近时会来回跳（滚动一像素换一节），而人眼认为「我在读第二节」应该稳定。
 * ★ 空数组返回 0：调用方用它当 `outlineActive`，`-1` 会让「没有当前项」和
 *   「还没算出来」混在一起 —— 界面上两种情况长得一样，但后者会闪一下。
 */
export function activeIndex(tops, offset = OUTLINE_ACTIVE_OFFSET) {
  if (!Array.isArray(tops) || tops.length === 0) return 0;
  let current = 0;
  for (let index = 0; index < tops.length; index += 1) {
    const top = tops[index];
    if (Number.isFinite(top) && top <= offset) current = index;
  }
  return current;
}

/**
 * 点目录一行时，滚动容器该滚到多少。
 *
 * @param {number} scrollTop 当前滚动位置
 * @param {number} nodeTop 目标标题的视口坐标（`getBoundingClientRect().top`）
 * @param {number} containerTop 滚动容器的视口坐标
 * @param {number} [gap] 目标标题停在容器顶下多少像素（留一点呼吸，别贴着边）
 * @returns {number}
 *
 * ★ 为什么不直接用 `scrollIntoView`：它会把**外层所有**可滚动祖先一起滚（宿主的
 *   页面容器也在其中），滚完左侧列表也跟着跳，用户会以为点错了。自己算只动这一格。
 * ★ 结果是**绝对值**而不是增量：`scrollTop + (nodeTop - containerTop) - gap`。
 *   写成增量再交给 `scrollBy` 也行，但 `scrollTo` 的绝对值更容易断言 ——
 *   测试可以直接说「从 0 滚到 1420」，而不是「滚了 1420」。
 * ★ 必须 `Math.max(0, …)`：目标在当前位置上方时差值为负，滚到负数浏览器会夹到 0，
 *   但**返回值**先夹住，测试才量得到「夹了」这件事。
 */
export function scrollTarget(scrollTop, nodeTop, containerTop, gap = 16) {
  const delta = Number(nodeTop) - Number(containerTop);
  const raw = Number(scrollTop) + delta - gap;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.round(raw));
}
