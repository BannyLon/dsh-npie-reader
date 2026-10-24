/**
 * 「保存设置」提交什么。
 *
 * 这个模块之所以单独存在（而不是写在 `SettingsPage.jsx` 里），是为了能被**真跑**着测：
 * 组件是 JSX，node 的测试进程 import 不了它，于是那条判据只能退化成「源码里有没有
 * 出现某个字符串」—— 而字符串断言答不了「这份 patch 到底会不会把别人刚写的数据盖掉」。
 * 这正是 2026-10-23 那个缺陷（加本地目录 → 点保存 → 目录消失）的形状。
 *
 * ★ 缺陷本体：宿主的 `saveSettings` 是
 *     `Object.assign(store.data.settings, validateSettings(patch))`
 *   —— **整份 patch 覆盖**，而 `validateSettings` 认可 `bookSources` / `libraryListIds`。
 *   设置弹窗里那份 `settings` 是**打开弹窗那一刻的快照**；书源与「载入哪几份」却是在
 *   弹窗开着的时候由 BookSources 通过 `POST /sources`、`POST /lists/load` **即时写盘**的。
 *   把快照整份提交回去 = 用旧值覆盖刚写进去的新值，而界面上只会看到「保存成功」。
 *
 * ★ 为什么是「排除」而不是「白名单」：设置项会持续增加（阅读外观、模型、书架开关…）。
 *   白名单会在每次新增设置项时**静默丢掉**那一项，症状是「改了没保存住」，而且除了
 *   注释之外没有任何地方看得出原因。排除法只要求「新增一个**即时写入**的字段时记得
 *   加进来」—— 那种字段本来就该和它自己的写入路由一起改，是本模块的正当职责。
 */

/**
 * 由**别的写入者**负责落盘的设置项。
 *
 * - `bookSources`：书源。写者是 `POST /sources`（BookSources 的增删、改名、扫描）
 * - `libraryListIds`：载入哪几份插件生成的书单。写者是 `POST /lists/load`（第三步的勾选）
 */
export const LIVE_WRITTEN_SETTINGS = Object.freeze(['bookSources', 'libraryListIds']);

/**
 * 交给宿主 `saveSettings` 的 patch：整份 settings 去掉别人在写的字段。
 *
 * @param settings - 设置弹窗里那份（可能是旧）快照。
 * @returns 只含本页拥有字段的新对象 —— 不修改入参。
 */
export function pageOwnedPatch(settings) {
  if (settings === null || typeof settings !== 'object') return {};
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !LIVE_WRITTEN_SETTINGS.includes(key)),
  );
}
