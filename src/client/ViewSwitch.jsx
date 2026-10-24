/**
 * 「订阅 / 书」模式开关。
 *
 * ★ 为什么做成**分段控件**而不是两个普通图标按钮：这一栏里本来就有一排图标按钮
 *   （加订阅、搜索、刷新），它们的语义是「对当前内容做一个动作」。模式切换是**另一个
 *   维度**（它换掉整个视图，不是对内容做动作）。视觉同级会被读成语义同级 ——
 *   用户会以为它是「刷新」那类的一次性动作，点完还等着回到原处。
 *   所以这里给它一个连体的、带选中底的形状，和图标按钮明确区分开。
 *
 * 两个半区共用：订阅那一半的工具栏和书那一半的工具栏各放一个（否则从书那一半回不去）。
 */
import { Icon } from './icons.jsx';

/**
 * @param props.mode - `'feeds' | 'library'`。
 * @param props.onChange - 切换回调。
 * @param props.showLibrary - 是否显示「书」（设置里关掉书那一半时只剩订阅）。
 *
 * ★ 这个按钮叫**「书」而不是「书架」**：书那一半的侧栏里已经有「阅读 / 书架」两个
 *   分页，图标按钮再叫「书架」就重名了 —— 用户会以为它们是同一层控件，点错之后
 *   才发现整个视图被换掉了。外层这个切的是**半个面板**，内层那个切的是书单的视图。
 */
export function ViewSwitch({ mode, onChange, showLibrary = true }) {
  return (
    <div className="npr-viewswitch" role="group" aria-label="阅读模式">
      <button type="button" aria-pressed={mode === 'feeds'} title="订阅" aria-label="订阅"
        onClick={() => onChange('feeds')}><Icon name="rss" size={15} /></button>
      {showLibrary && (
        <button type="button" aria-pressed={mode === 'library'} title="书 · 阅读 / 书架" aria-label="书"
          onClick={() => onChange('library')}><Icon name="book-open" size={15} /></button>
      )}
    </div>
  );
}
