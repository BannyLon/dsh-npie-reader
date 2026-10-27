/**
 * 「订阅 / 书 / 日记」主视图开关。
 *
 * ★ 为什么做成**分段控件**而不是三个普通图标按钮：这一栏里本来就有一排图标按钮
 *   （加订阅、搜索、刷新），它们的语义是「对当前内容做一个动作」。视图切换是**另一个
 *   维度**（它换掉整个视图，不是对内容做动作）。视觉同级会被读成语义同级 ——
 *   用户会以为它是「刷新」那类的一次性动作，点完还等着回到原处。
 *   所以这里给它一个连体的、带选中底的形状，和图标按钮明确区分开。
 *
 * ★ `aria-label` 是**「主视图」而不是「阅读模式」**（2026-10-26 改）：日记不是阅读。
 *   读屏用户听到「阅读模式」再摸到第三个「日记」，会以为那是一种阅读方式。
 *
 * ★ 三个半区各自放一个（订阅页、书架页、日记页都要能切走），否则进了任何一半就回不去。
 */
import { Icon } from './icons.jsx';

/**
 * @param props.mode - `'feeds' | 'library' | 'diary'`。
 * @param props.onChange - 切换回调，参数是目标模式。
 * @param props.showLibrary - 是否显示「书」（设置里关掉书那一半时只剩订阅）。
 * @param props.showDiary - 是否显示「日记」。日记是纯本地的，没有「关掉」的设置项，
 *   默认恒为 true；留这个口子只是为了让测试夹具能少画一个按钮。
 *
 * ★ 这个按钮叫**「书」而不是「书架」**：书那一半的侧栏里已经有「阅读 / 书架」两个
 *   分页，图标按钮再叫「书架」就重名了 —— 用户会以为它们是同一层控件，点错之后
 *   才发现整个视图被换掉了。外层这个切的是**半个面板**，内层那个切的是书单的视图。
 */
export function ViewSwitch({ mode, onChange, showLibrary = true, showDiary = true }) {
  return (
    <div className="npr-viewswitch" role="group" aria-label="主视图">
      <button type="button" aria-pressed={mode === 'feeds'} title="订阅" aria-label="订阅"
        onClick={() => onChange('feeds')}><Icon name="rss" size={15} /></button>
      {showLibrary && (
        <button type="button" aria-pressed={mode === 'library'} title="书 · 阅读 / 书架" aria-label="书"
          onClick={() => onChange('library')}><Icon name="book-open" size={15} /></button>
      )}
      {showDiary && (
        <button type="button" aria-pressed={mode === 'diary'} title="日记" aria-label="日记"
          onClick={() => onChange('diary')}><Icon name="calendar" size={15} /></button>
      )}
    </div>
  );
}
