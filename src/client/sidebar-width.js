/**
 * 四个视图共用的左侧边栏宽度（0.71.0）。
 *
 * 以前是四份手写常量 + 三份 localStorage key：
 *   RSS 300 / `npr.listWidth`，书架 320 / `npr.libListWidth`，
 *   日记 268 / `npr.diaryListWidth`，论文固定 340（连拖都不能拖）。
 * 切一次视图就跳一次宽度，拖动也只改自己那半边 —— 用户 2026-11-06 要求统一。
 *
 * ⇒ 现在**一个默认值、一个下限、一个 key**：任何一处拖动，四个视图下次挂载都读到
 *   同一个数；论文那一半也接上了拖动（以前那根分隔条只是装饰）。
 *
 * ★ 0.88.0 又抬了一次（340 / 256 → 380 / 288）。用户 2026-11-22 的原话是
 *   「插件左侧边栏固定宽度再宽一些，不然订阅 rss 阅读的侧边栏出框了」。
 *   RSS 那一行的工具栏装了八项（四颗视图图标 + 频道名按钮 + 添加 + 搜索 + 刷新 +
 *   设置齿轮），340 下单是排得下，但标题列只剩两个字宽 —— 用户看到的是
 *   「Cognitive Revolution 中文精…」这种一路省略号，读不出是哪一篇。
 *   ★ 下限跟着抬到 288 是同一个理由的另一半：256 那个数是 0.45.2 按**书架**那一行
 *     量出来的（四颗图标 + 三档 chip 不换行），而 RSS 这一行比它长得多。
 *   ★ 抬默认值对**已经拖过**的用户无效（他们的值已经写进 `npr.sidebarWidth`），
 *     所以配一次**基准版本**迁移（见 `readSidebarWidth`）：只抬一次，抬完之后
 *     用户再拖窄就是他自己的选择，不会被反复顶回去。
 *
 * 下限仍是 `PANEL_CSS` 里的 `--npr-sidebar-min`（两处必须同步，有测试钉着）。
 */
export const SIDEBAR_MIN_WIDTH = 288;
export const SIDEBAR_WIDTH = 380;
export const SIDEBAR_MAX_WIDTH = 520;

/**
 * 基准版本号。**每次「要求更宽」时 +1**，并在 `readSidebarWidth` 里比对：
 * 存下来的版本号小于它 ⇒ 这一次挂载把宽度抬到当前基准（只抬一次）。
 * ★ 不用日期或宽度值当版本：宽度会被用户拖动改写，拿它当版本就分不清
 *   「还没对齐」和「用户自己拖窄了」。
 */
export const SIDEBAR_BASELINE = 1;

/** 共用的持久化 key。旧的三份 key 只在「第一次迁移」时读一次。 */
export const SIDEBAR_WIDTH_KEY = 'npr.sidebarWidth';
/** 迁移只认 RSS 那一份：它是用户指定的基准，另外两份各是各的历史。 */
const LEGACY_KEY = 'npr.listWidth';
/** 用户上一次对齐到哪一版基准。缺这个 key = 从没对齐过。 */
const BASELINE_KEY = 'npr.sidebarWidth.baseline';

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function clampSidebarWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH;
  return Math.round(Math.min(Math.max(n, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
}

/**
 * 首屏宽度。
 *
 * 三条规则，按顺序：
 *   ① **有值就用自己的**，但要过一遍「基准版本」：版本落后 ⇒ 抬到当前基准并记版本。
 *      `max(现值, SIDEBAR_WIDTH)` 而不是直接赋 SIDEBAR_WIDTH —— 用户拖到过 460 的，
 *      不该被「抬宽」这个动作缩回 380。
 *   ② 新 key 没有时读 RSS 的旧 key，同样抬到基准（与 ① 同一条理由）。
 *   ③ 什么都没有 ⇒ 默认值。
 *
 * ★ 拖到过 220 的老值会被 `clampSidebarWidth` 抬回下限，窄屏换行那两个老毛病不复发。
 */
export function readSidebarWidth() {
  const store = storage();
  if (store === null) return SIDEBAR_WIDTH;
  try {
    const raw = store.getItem(SIDEBAR_WIDTH_KEY);
    if (raw !== null && raw !== '') {
      const current = clampSidebarWidth(raw);
      const aligned = Number(store.getItem(BASELINE_KEY) ?? 0);
      if (Number.isFinite(aligned) && aligned >= SIDEBAR_BASELINE) return current;
      // 版本落后：抬一次，并把版本号写下去 —— 否则每次挂载都会把用户拖窄的动作顶回来。
      const lifted = clampSidebarWidth(Math.max(current, SIDEBAR_WIDTH));
      store.setItem(SIDEBAR_WIDTH_KEY, String(lifted));
      store.setItem(BASELINE_KEY, String(SIDEBAR_BASELINE));
      return lifted;
    }
    const legacy = Number(store.getItem(LEGACY_KEY));
    store.setItem(BASELINE_KEY, String(SIDEBAR_BASELINE));
    if (Number.isFinite(legacy) && legacy > 0) {
      return clampSidebarWidth(Math.max(legacy, SIDEBAR_WIDTH));
    }
  } catch {
    // localStorage 在隐私模式 / 测试环境里可能直接抛；宽度用默认值即可。
  }
  return SIDEBAR_WIDTH;
}

/** 拖动结束或双击复位时写。返回夹取后的值，调用方可以直接 setState。 */
export function saveSidebarWidth(value) {
  const width = clampSidebarWidth(value);
  try {
    const store = storage();
    store?.setItem(SIDEBAR_WIDTH_KEY, String(width));
    // 用户亲手定的宽度就是「已对齐」：不写版本号的话，下一次挂载会把它抬回基准。
    store?.setItem(BASELINE_KEY, String(SIDEBAR_BASELINE));
  } catch {
    // 写不进去也别让拖动崩掉：本次会话内宽度仍然生效。
  }
  return width;
}
