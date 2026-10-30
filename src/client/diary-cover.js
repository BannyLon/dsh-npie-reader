/**
 * 开场说明页什么时候出现。
 *
 * ★ 它是一次**开场**，不是一种空状态：灵感模块本来默认就选中今天，随时能写，
 *   所以没有「没内容 ⇒ 显示欢迎页」这种判据可用 —— 那会把「今天还没写」当成
 *   「还没开始用」，而这两件事差得很远（用户 2026-10-29 要的是每次点进来先看见
 *   一块封面，按一下开始写）。
 *
 * ★ 0.56.2 起**灵感与私密各有一张**（用户 2026-10-30：「私密日记的说明页和灵感
 *   开场页操作一样，就是鼠标点一下消失，出现解锁页面」）。读后感没有 —— 它的
 *   「说明页」是那个欢迎页，条件完全不同（没选书就显示），由组件自己判。
 *
 * ★ 判据只有三条，都是「不该拦」的例外：
 *   ① 不是有开场页的模块（读后感 / 未知模块）；
 *   ② 这一张已经进过了 —— `entered` 是**按模块**记的，从灵感切到私密，
 *      私密那张照样要出；反过来切回去，灵感那张不该再弹一次；
 *   ③ 从外部带着**灵感**的意图进来 —— 用户在阅读页按一下记一条，是「我已经在写了」，
 *      这时给他一块「点一下开始」等于让他多点一次。
 *
 * ★ ③ 只对灵感成立，**不套到私密上**：私密那半边没有「已经在写了」的外部入口
 *   （`ReaderPage` 只发 `reflection` 意图），而这张说明页本身就是那道门的门牌 ——
 *   从哪儿进来都该先看见它，再按一下去面对口令卡。抄成对称的一行会让这条判据
 *   看起来更整齐，但那是为了整齐而编一条不存在的例外。
 *
 * ★ 抽成纯函数而不是写在 JSX 的三元里：三条判据里任何一条写反，界面上都只是
 *   「封面不出现」或「封面挡着编辑器」，看起来都像正常 —— 单测钉得住，肉眼钉不住。
 *
 * @param {object} options
 * @param {string} options.module  当前模块（`inspiration` / `private` / `reflection`）。
 * @param {boolean} options.entered 这个模块在本次挂载里是否已经按过开场页。
 * @param {{module?: string}|null|undefined} options.intent 外部带进来的意图。
 * @returns {boolean}
 */
export function coverVisible({ module, entered, intent }) {
  if (module !== 'inspiration' && module !== 'private') return false;
  if (entered) return false;
  if (module === 'inspiration' && intent?.module === 'inspiration') return false;
  return true;
}

/** 封面退场动画的时长（毫秒）—— CSS 的 transition 与这里必须是同一个数。 */
export const COVER_EXIT_MS = 260;
