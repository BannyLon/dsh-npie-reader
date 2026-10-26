/**
 * 书架列表的**分批挂载**（2026-10-25）。
 *
 * ★ 问题
 * ------
 * 真机 2634 本书时，书架是 `visible.map(...)` **一次全画**：每行约 8 个 DOM 节点，
 * 合计两万多个。首屏要等它们全部建好才能滚，输入框每敲一个字还要把这一整批
 * 重新过一遍（`useDeferredValue` 只把「什么时候算」降了优先级，没减少「要算多少」）。
 *
 * ★ 为什么不是「真正的虚拟滚动（只画可视区）」
 * --------------------------------------------
 * 虚拟滚动要求行高可预测。书架行的标题是 `-webkit-line-clamp: 2`、元信息是
 * `flex-wrap: wrap` ⇒ **一行可能是 1 行标题，也可能是 2 行**，行高在 40–60px 之间浮动。
 * 用固定行高去算位置，误差会随行数累积：滚到第 2000 行时已经偏出几百像素，
 * 症状是「滚到底看到空白」或「滚动位置自己跳」—— 那比"慢"难查得多。
 * 要做得对，得逐行量高并维护一张偏移表，那是另一个量级的改动。
 *
 * ★ 所以选了**分批挂载**：先画一批，用户滚到附近再追加下一批。
 *   好处是零高度假设 ⇒ 不可能出现错位或跳动；代价是滚到最底部时 DOM 会涨到全量，
 *   但那时用户**确实在看**这些行。
 *
 * ★ 判据都抽在这里，是因为它们必须能被**真跑**：
 *   「第 2000 本到底渲染了没有」不能靠读源码字符串下结论。
 */

/** 一批挂多少行。120 行 ≈ 7000 个节点，首屏与输入都还轻快。 */
export const SHELF_BATCH = 120;

/**
 * 当前该渲染前多少本。
 *
 * @param {{total?: number, shown?: number, batch?: number}} [input]
 * @returns {number} 0 表示一本都不渲染（空列表）
 */
export function shelfRenderCount({ total, shown, batch = SHELF_BATCH } = {}) {
  const count = Number(total);
  if (!Number.isFinite(count) || count <= 0) return 0;
  const step = Number.isFinite(batch) && batch > 0 ? batch : SHELF_BATCH;
  // `shown` 没给（第一次渲染）就是一批；给了就照它，但**不许超过总数**。
  const wanted = Number.isFinite(shown) && shown > 0 ? shown : step;
  return Math.min(wanted, count);
}

/**
 * 再挂一批之后该渲染到多少。
 *
 * ★ 必须**夹在总数以内**：不夹的话每滚一下 `shown` 就加 120，滚到列表底部之后
 *   它还在涨，`slice` 会一直返回全量 —— 看起来没坏，但那个数字再也回不来了
 *   （筛选条件一变就变成「一次全画」，正是这次要修的东西）。
 *
 * @param {{total?: number, shown?: number, batch?: number}} [input]
 * @returns {number}
 */
export function shelfNextCount({ total, shown, batch = SHELF_BATCH } = {}) {
  const count = Number(total);
  if (!Number.isFinite(count) || count <= 0) return 0;
  const step = Number.isFinite(batch) && batch > 0 ? batch : SHELF_BATCH;
  return Math.min(shelfRenderCount({ total, shown, batch: step }) + step, count);
}
