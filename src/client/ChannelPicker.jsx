import { useEffect, useMemo, useState } from 'react';
import { Icon } from './icons.jsx';
import { freshness } from './source-health.js';

const SECTION_ORDER = ['聚合', '订阅分组', '我的订阅源'];

/** Split host channels into the sections the picker shows. */
export function groupChannels(channels) {
  const sections = { 聚合: [], 订阅分组: [], 我的订阅源: [] };
  const feedCount = channels.filter((item) => item.kind === 'feed').length;
  for (const channel of channels) {
    if (channel.key === 'all' || channel.key === 'feeds:all') {
      const subtitle = channel.key === 'feeds:all'
        ? `${feedCount} 个个人订阅源`
        : `${channel.unread} 篇未读`;
      sections.聚合.push({ ...channel, subtitle });
    } else if (channel.key.startsWith('group:')) {
      sections.订阅分组.push({ ...channel, subtitle: `${channels.filter((item) => item.group === channel.name).length} 个订阅源` });
    } else {
      // 每个源直接说「最新一篇多久以前 / 已 N 天未更新」。第三方代理会悄悄停更，
      // 只列名字的话用户无法区分「源死了」和「插件没去抓」。
      const state = freshness(channel);
      sections.我的订阅源.push({
        ...channel,
        subtitle: state.label,
        level: state.level,
        stale: state.level === 'stale',
        error: Boolean(channel.lastError),
      });
    }
  }
  return sections;
}

export function ChannelMark({ channel, size = 22 }) {
  const key = channel.key ?? '';
  /* 图标名先算进一个常量，**不**内联进 JSX 属性。
     ★ 试过内联（0.44.4）：`icons.test.mjs` 会把属性表达式里**每一个**单引号串
       都当成图标名去核对，于是 `=== 'feed'`、`=== 'all'`、`startsWith('group:')`
       这三个**比较值**全被抓成「不存在的图标」。为了一处可查，换来三条假红 ——
       那是把判据搞脏，不是把代码改好。所以这里保持常量形式，
       并由 `icons.test.mjs` 的 `BARE_SITES` 白名单登记这一处。 */
  const name = channel.kind === 'feed' ? 'rss'
    : key === 'all' ? 'layers-3'
      : key.startsWith('group:') ? 'folder'
        : 'book-open';
  const variant = key === 'all' ? ' all' : '';
  return <span className={`npr-channel-mark${variant}`} style={{ width: size, height: size, flex: `0 0 ${size}px` }} aria-hidden="true">
    <Icon name={name} size={Math.max(16, Math.round(size * 0.72))} strokeWidth={1.8} />
  </span>;
}

export function ChannelPicker({ channels, current, anchor, onSelect, onManage, onClose }) {
  const [query, setQuery] = useState('');
  /*
   * ★ Esc 关掉这个浮层，用**原生 `document` 监听**而不是 React 的 `onKeyDown`。
   *   阅读页在 `window` 上挂了 Esc（退出专注、清空搜索），合成事件拦不住原生监听；
   *   不拦的话按 Esc 会变成「浮层还在、底下的搜索框被清空了」—— 用户会以为
   *   生效的是另一个操作。挂 document（比 window 先跑）再 stopPropagation 才能截住。
   */
  useEffect(() => {
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  const sections = useMemo(() => groupChannels(channels), [channels]);
  const searching = query.trim() !== '';
  const flat = useMemo(() => SECTION_ORDER.flatMap((title) => sections[title]), [sections]);
  const visible = searching
    ? flat.filter((channel) => `${channel.name} ${channel.subtitle ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    : [];
  const row = (channel) => (
    <div className={`npr-channel-option-wrap${channel.stale ? ' is-stale' : ''}`} key={channel.key}>
      <button type="button" className="npr-channel-option" aria-current={channel.key === current} title={channel.url}
        onClick={() => { onSelect(channel.key); onClose(); }}>
        <ChannelMark channel={channel} size={26} />
        <span className="npr-channel-copy">
          <span className="npr-channel-name">{channel.name}</span>
          {channel.subtitle && <span className="npr-channel-subtitle">{channel.subtitle}</span>}
        </span>
        {channel.key === current && <span className="npr-channel-check"><Icon name="circle-check" size={16} /></span>}
      </button>
    </div>
  );
  return (
    <div className="npr-channel-backdrop" onClick={onClose}>
      <div className="npr-channel-picker" style={anchor ? { left: anchor.left, top: anchor.top } : undefined} role="dialog" aria-label="选择频道" onClick={(event) => event.stopPropagation()}>
        <div className="npr-channel-heading"><div><strong>切换频道</strong><small>选择想读的内容</small></div><button type="button" className="npr-icon" aria-label="关闭频道列表" onClick={onClose}><Icon name="x" /></button></div>
        <div className="npr-channel-top"><Icon name="search" size={16} /><input type="search" aria-label="搜索频道" placeholder="搜索频道、分组或订阅源…" value={query}
          onChange={(event) => setQuery(event.target.value)} autoFocus /></div>
        <div className="npr-channel-options">
          {searching
            ? (visible.length ? visible.map(row) : <div className="npr-channel-empty">没有匹配的频道</div>)
            : SECTION_ORDER.map((title) => sections[title].length === 0 ? null : (
              <div key={title}>
                <div className="npr-channel-section">{title}</div>
                {sections[title].map((channel) => row(channel))}
              </div>
            ))}
        </div>
        <div className="npr-channel-footer"><button type="button" className="npr-channel-manage" onClick={onManage}>
          <Icon name="settings" size={16} />管理订阅<Icon name="chevron-right" size={13} />
        </button><button type="button" className="npr-channel-close" onClick={onClose}>完成</button></div>
      </div>
    </div>
  );
}
