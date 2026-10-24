/**
 * 「翻页 → 落盘」的去抖器。
 *
 * ★ 为什么单独一个模块，而不是留在 `LibraryApp.jsx` 里几行 `setTimeout`：
 *   这段逻辑有一半是**卸载路径**，而卸载路径恰恰是 React 里最难测的那一半 ——
 *   它由一次 `cancel` 和一次「立即补写」组成。前者好写，后者一漏就**静默丢进度**：
 *   用户翻到第 120 页，1.2 秒内切回订阅页，那一页再也不会写进盘里，
 *   而界面上一句提示都没有（他以为进度是自动存的）。
 *   抽成普通对象之后，`test/page-progress.test.mjs` 可以用假计时器把
 *   「翻页 → 计时器还没到点 → 卸载」这条路**真的走一遍**。
 *
 * ★ 待写内容按**书 id** 分开记（`Map`），不是「只有一个槽」：
 *   一个槽时，1.2 秒内从 A 书翻到 B 书会把 A 那一次顶掉 —— 又一条静默丢进度的路。
 *   分开记之后仍然只有一个计时器（去抖的本意没变），但 A 和 B 各写各的。
 *
 * ★ 依赖全部可注入（`schedule` / `cancel` / `save` / `onError`）：
 *   测试不需要真的等 1.2 秒，也不需要真的写盘。
 *
 * 本模块不碰 DOM、不碰 React，所以既能被组件用，也能被测试直接跑。
 */

/**
 * @param {object} options
 * @param {(entry: {id: string, page: number, pages: number}) => unknown} options.save
 *   真正落盘。允许返回 promise（失败会走 `onError`，**不会**变成 unhandledRejection），
 *   也允许是同步函数。
 * @param {number} options.delayMs 去抖窗口。
 * @param {typeof setTimeout} [options.schedule]
 * @param {typeof clearTimeout} [options.cancel]
 * @param {(error: unknown) => void} [options.onError]
 */
export function createPageProgress({
  save,
  delayMs,
  schedule = setTimeout,
  cancel = clearTimeout,
  onError = () => {},
}) {
  /** 去抖计时器的句柄（`undefined` = 当前没有排队的计时器）。 */
  let timer;
  /** 还没落盘的那些翻页，按书 id 分开。★ 这个 Map 就是整个模块存在的理由。 */
  const pending = new Map();

  function write(entry) {
    try {
      // ★ 必须 `Promise.resolve(...).catch(...)`，不能写成 `save(entry).catch(...)`：
      //   `save` 允许是同步函数（测试里就是），返回 `undefined` 时
      //   `undefined.catch` 会当场 TypeError —— 一次成功的写盘变成一次报错。
      Promise.resolve(save(entry)).catch(onError);
    } catch (error) {
      // 同步抛出的也要接住：这条路径在**卸载**时执行，抛出去没人接。
      onError(error);
    }
  }

  /** 把当前攒着的全部写完（每本书各写一次）。 */
  function drain() {
    const batch = [...pending.values()];
    pending.clear();
    for (const entry of batch) write(entry);
  }

  return {
    /**
     * 记下一次翻页。同一本书连续翻页只保留**最后一次**（这正是去抖的意思）；
     * 不同的书各自留一份。
     */
    note(entry) {
      pending.set(entry.id, entry);
      cancel(timer);
      timer = schedule(() => {
        timer = undefined;
        drain();
      }, delayMs);
    },

    /**
     * 立刻把还没落盘的那些写完。
     *
     * ★ **卸载时必须调它。** 只 `cancel(timer)` 会让 `pending` 里那些永远不写
     *   —— 而组件的注释、用户的心智模型都写着「进度是自动存的」。
     * ★ 幂等：没有待写内容时是空操作，所以「卸载时无条件调一次」是安全的。
     */
    flush() {
      cancel(timer);
      timer = undefined;
      drain();
    },

    /** 有没有还没落盘的那一次。界面与测试都用它判断「正在攒着」。 */
    get hasPending() {
      return pending.size > 0;
    },
  };
}
