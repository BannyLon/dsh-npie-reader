/**
 * 「订阅 / 书 / 论文 / 记录」主视图开关。
 *
 * ★ 第四颗叫**「记录」而不是「日记」**（0.88.0，用户 2026-11-22）：那个视图里
 *   装着三块 —— 灵感速记 / 私密日记 / 读后感，其中一块就叫「日记」。主视图也叫
 *   「日记」的话，同一屏上有两个「日记」，用户点进「日记」看到的是三块并列，
 *   而第二块又写着「日记」，分不清是「进去」还是「就在这儿」。
 *   图标的 `mode` 值仍是 `'diary'`（内部标识，改了要动一堆地方），只改**称呼**。
 *
 * ★ 为什么做成**分段控件**而不是四个普通图标按钮：这一栏里本来就有一排图标按钮
 *   （加订阅、搜索、刷新），它们的语义是「对当前内容做一个动作」。视图切换是**另一个
 *   维度**（它换掉整个视图，不是对内容做动作）。视觉同级会被读成语义同级 ——
 *   用户会以为它是「刷新」那类的一次性动作，点完还等着回到原处。
 *   所以这里给它一个连体的、带选中底的形状，和图标按钮明确区分开。
 *
 * ★ `aria-label` 是**「主视图」而不是「阅读模式」**（2026-10-26 改）：记录不是阅读。
 *   读屏用户听到「阅读模式」再摸到第四个「记录」，会以为那是一种阅读方式。
 *
 * ★ 每个半区各自放一个（订阅页、书架页、论文页、记录页都要能切走），否则进了任何
 *   一半就回不去。
 */
import { Icon } from './icons.jsx';

/**
 * @param props.mode - `'feeds' | 'library' | 'paper' | 'diary'`。
 * @param props.onChange - 切换回调，参数是目标模式。
 * @param props.showLibrary - 是否显示「书」（设置里关掉书那一半时只剩订阅）。
 * @param props.showDiary - 是否显示「记录」。记录是纯本地的，没有「关掉」的设置项，
 *   默认恒为 true；留这个口子只是为了让测试夹具能少画一个按钮。
 * @param props.showPapers - 是否显示「论文」。论文是纯本地的，与记录同理恒为 true。
 *
 * ★ 这个按钮叫**「书」而不是「书架」**：书那一半的侧栏里已经有「阅读 / 书架」两个
 *   分页，图标按钮再叫「书架」就重名了 —— 用户会以为它们是同一层控件，点错之后
 *   才发现整个视图被换掉了。外层这个切的是**半个面板**，内层那个切的是书单的视图。
 *
 * ★ 「论文」排在「书」与「记录」之间：左边两个是**内容源**（订阅流、电子书、论文），
 *   最右是**产出**（自己写的东西）。把论文放到记录右边，会让「写」被夹在两个「读」
 *   中间，跟侧栏里「灵感 / 读后感」的顺序也反过来。
 */
export function ViewSwitch({ mode, onChange, showLibrary = true, showDiary = true, showPapers = true }) {
  return (
    <div className="npr-viewswitch" role="group" aria-label="主视图">
      <button type="button" aria-pressed={mode === 'feeds'} title="订阅" aria-label="订阅"
        onClick={() => onChange('feeds')}><Icon name="rss" size={15} /></button>
      {showLibrary && (
        <button type="button" aria-pressed={mode === 'library'} title="书 · 阅读 / 书架" aria-label="书"
          onClick={() => onChange('library')}><Icon name="book-open" size={15} /></button>
      )}
      {showPapers && (
        <button type="button" aria-pressed={mode === 'paper'} title="论文" aria-label="论文"
          onClick={() => onChange('paper')}><Icon name="file-text" size={15} /></button>
      )}
      {showDiary && (
        <button type="button" aria-pressed={mode === 'diary'} title="记录" aria-label="记录"
          onClick={() => onChange('diary')}><Icon name="calendar" size={15} /></button>
      )}
    </div>
  );
}
