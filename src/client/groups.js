/**
 * 订阅分组名清单 —— 去重、按中文排序。
 *
 * ★ 单独一个模块，是因为**三个地方要给出同一份清单**：设置页的分组管理、
 *   「添加订阅」弹窗里的分组下拉、阅读页「添加订阅」弹窗。同一个判据各写一遍，
 *   去重方式或排序迟早会分叉 —— 用户看到的是「下拉里有这个分组、分组管理里却没有」
 *   这种没法解释的差异。
 *
 * ★ 入参只要求元素带 `.group` 字段，所以宿主 `listChannels()` 返回的频道对象也能直接喂
 *   （只有 `kind:'feed'` 的频道带这个字段，分组频道与「全部」频道都没有）——
 *   阅读页那侧因此不用为了一份分组名再拉一次订阅列表。
 *
 * @param {{group?: string}[]} items
 * @returns {string[]}
 */
export function groupNamesOf(items) {
  return [...new Set((items ?? []).map((item) => item?.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
