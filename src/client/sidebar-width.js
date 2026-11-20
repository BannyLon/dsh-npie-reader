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
 * 基准是 RSS 原来的 300px「再增加一些」⇒ 340px：与论文那列原来量好的宽度一致，
 * 书架从 320 只加 20，日记从 268 一次放宽到能放下两行标题。
 * 下限仍是 256（`PANEL_CSS` 里的 `--npr-sidebar-min`，依据见那段注释）。
 */
export const SIDEBAR_MIN_WIDTH = 256;
export const SIDEBAR_WIDTH = 340;
export const SIDEBAR_MAX_WIDTH = 520;

/** 共用的持久化 key。旧的三份 key 只在「第一次迁移」时读一次。 */
export const SIDEBAR_WIDTH_KEY = 'npr.sidebarWidth';
/** 迁移只认 RSS 那一份：它是用户指定的基准，另外两份各是各的历史。 */
const LEGACY_KEY = 'npr.listWidth';

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
 * ★ 迁移规则：新 key 没有时，读 RSS 的旧值，但**不低于新基准 340** —— 用户若把
 *   RSS 拖到过 400，就保留 400；若还是原来的 300，就整体抬到 340。这样「以 RSS
 *   为准再增一些」和「别把用户拖宽过的界面缩回去」两条同时成立。
 * ★ 拖到过 220 的老值会被 `clampSidebarWidth` 抬回下限，窄屏换行那两个老毛病不复发。
 */
export function readSidebarWidth() {
  const store = storage();
  if (store === null) return SIDEBAR_WIDTH;
  try {
    const raw = store.getItem(SIDEBAR_WIDTH_KEY);
    if (raw !== null && raw !== '') return clampSidebarWidth(raw);
    const legacy = Number(store.getItem(LEGACY_KEY));
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
    storage()?.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // 写不进去也别让拖动崩掉：本次会话内宽度仍然生效。
  }
  return width;
}
