/**
 * 「寸心拾遗 · 思想原点」这张封面什么时候出现。
 *
 * ★ 它是一次**开场**，不是一种空状态：灵感模块本来默认就选中今天，随时能写，
 *   所以没有「没内容 ⇒ 显示欢迎页」这种判据可用 —— 那会把「今天还没写」当成
 *   「还没开始用」，而这两件事差得很远（用户 2026-10-29 要的是每次点进来先看见
 *   一块封面，按一下开始写）。
 *
 * ★ 所以判据只有三条，都是「不该拦」的例外：
 *   ① 不在灵感模块 —— 私密与读后感各有自己的开场（上锁卡 / 选书卡），不能再叠一层；
 *   ② 已经进过了 —— 同一次挂载里只放一次，切模块来回不该反复弹；
 *   ③ 从外部带着意图进来 —— 用户在阅读页按 L 记一条，是「我已经在写了」，
 *      这时给他一块「点一下开始」等于让他多点一次。
 *
 * ★ 抽成纯函数而不是写在 JSX 的三元里：三条判据里任何一条写反，界面上都只是
 *   「封面不出现」或「封面挡着编辑器」，看起来都像正常 —— 单测钉得住，肉眼钉不住。
 *
 * @param {object} options
 * @param {string} options.module  当前模块（`inspiration` / `private` / `reflection`）。
 * @param {boolean} options.entered 本次挂载里是否已经按过封面。
 * @param {{module?: string}|null|undefined} options.intent 外部带进来的意图。
 * @returns {boolean}
 */
export function coverVisible({ module, entered, intent }) {
  if (module !== 'inspiration') return false;
  if (entered) return false;
  if (intent?.module === 'inspiration') return false;
  return true;
}

/** 封面退场动画的时长（毫秒）—— CSS 的 transition 与这里必须是同一个数。 */
export const COVER_EXIT_MS = 260;
