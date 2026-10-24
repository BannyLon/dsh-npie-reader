import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { groupNamesOf } from './groups.js';

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

/** 补全来源的人话名字（与宿主 `discoverArchive` 的 `kind` 对齐）。 */
const SOURCE_LABEL = { archive: '站点归档页', sitemap: 'sitemap.xml', llms: 'llms.txt' };

/** 条数到这么多，就认为这个 feed 不是「只挂最新 N 条」那类源，不再提供补全入口。 */
const BACKFILL_HINT_MAX = 100;

/**
 * 补全历史的确认弹窗。单独抽出来是为了能被**真渲染**一遍 —— 它只在
 * 「探测成功」之后才出现，主组件的常规渲染路径碰不到它。
 */
export function BackfillDialog({ state, busy, onCancel, onConfirm }) {
  const preview = state.preview;
  return <div className="npr-subscription-editor-backdrop" onClick={onCancel}><div className="npr-subscription-editor" role="dialog" aria-modal="true" aria-label="补全历史文章" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
    <div><strong>补全历史文章</strong><button type="button" aria-label="关闭补全历史" onClick={onCancel}><Icon name="x" size={16} /></button></div>
    <p>在 {SOURCE_LABEL[preview.kind] ?? '站点目录'}（{host(preview.source)}）里找到 <strong>{preview.found}</strong> 篇，其中 <strong>{preview.added}</strong> 篇还没有收录。</p>
    <ul className="npr-backfill-sample">{preview.sample.map(item => <li key={item.url}><span>{item.title}</span><small>{item.publishedAt ? item.publishedAt.slice(0, 10) : '日期未知'}</small></li>)}</ul>
    <p className="npr-subscription-editor-hint">只补「还没有的」文章，已有的正文、摘要、阅读状态和收藏都不动。正文不会预先下载，打开时再抓。</p>
    <div className="npr-subscription-editor-actions"><button type="button" onClick={onCancel}>取消</button><button type="button" disabled={busy} onClick={onConfirm}>{busy ? '正在写入…' : `补全 ${preview.added} 篇`}</button></div>
  </div></div>;
}

/**
 * 图标按钮 + 悬停提示。
 *
 * ★ 为什么不用原生 `title`：浏览器要悬停一秒多才出、样式也不受控，而这三个
 *   图标（三层方块 / 铅笔 / 复制）本身没有文字 —— 不解释就等于没有。
 * ★ 为什么提示用 `position: fixed`：订阅列表是 `overflow-y: auto` 的滚动容器，
 *   绝对定位的提示会被容器边缘裁掉（贴边的行只剩半个气泡）。
 * ★ `busy` 与 `disabled` 分开：`disabled` 是「现在不能点」，`busy` 是「这个按钮
 *   正在干活」。后者要换图标（转圈）并改掉 `aria-label`，否则用户看不出区别。
 */
export function IconButton({ icon, label, detail, onClick, disabled = false, busy = false }) {
  const [tip, setTip] = useState(null);
  const inert = disabled || busy;
  // ★ 一变成灰/转圈就把气泡收掉：禁用后的按钮在 Chromium 里**不再收到 `mouseleave`**，
  //   气泡会永久钉在屏幕上；而操作结束后 `inert` 变回 false，那个残留的坐标又会
  //   把气泡凭空弹回来 —— 两个都是纯渲染态造成的鬼影，只能在这里主动清。
  useEffect(() => { if (inert) setTip(null); }, [inert]);
  const show = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // 夹在视口内：最右边那个图标居中放气泡会顶出窗口，贴边时文字被切掉一半。
    const width = typeof window === 'undefined' ? 0 : window.innerWidth;
    const half = 120;
    const x = width ? Math.min(Math.max(rect.left + rect.width / 2, half), width - half) : rect.left + rect.width / 2;
    setTip({ x, y: rect.top - 8 });
  };
  const hide = () => setTip(null);
  return <>
    <button
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={inert}
      onClick={onClick}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <Icon name={busy ? 'refresh-cw' : icon} size={15} className={busy ? 'npr-icon-spin' : undefined} />
    </button>
    {tip && <span className="npr-tip" role="tooltip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>{label}{detail && <em>{detail}</em>}</span>}
  </>;
}

/**
 * 「补全历史」什么时候才值得出现。
 *
 * 判据是**条数**：feed 已经给了 100 条以上的源，不属于「只挂最新 20 条」那一类，
 * 摆个按钮只会让每一行都多一个看不懂的图标。另外两种不该出现的状态：
 * 补全过的（`backfilledAt`）、以及**已经查过且确认没有更多**的（`backfillCheckedAt`）。
 * 查过但失败的**不记**这个标记 —— 网络抖一次不该让功能永远消失。
 */
export function canBackfill(sub) {
  if (sub.backfilledAt || sub.backfillCheckedAt) return false;
  return (sub.entryCount ?? 0) < BACKFILL_HINT_MAX;
}

/**
 * 订阅列表的一行。
 *
 * ★ 抽成独立组件是为了能被**真渲染成两种状态做对照**：「补全中」这个界面变化
 *   只发生在这一行里，而它正是用户报「点了没反应」的地方 —— 留在主组件内部的话，
 *   静态渲染碰不到那个分支，测试就只能断言源码里有没有那串字符。
 */
export function SubscriptionRow({ sub, busy, backfilling = false, selected, onToggle, onBackfill, onEdit, onCopy }) {
  return <div className="npr-subscription-row" data-backfilling={backfilling ? 'true' : undefined}>
    <input type="checkbox" aria-label={`选择 ${sub.name}`} disabled={busy} checked={selected} onChange={event => onToggle(event.target.checked)} />
    <div className="npr-subscription-avatar" aria-hidden="true">{sub.name.trim().slice(0, 1) || 'R'}</div>
    <div className="npr-subscription-copy">
      <strong>{sub.name}</strong>
      <span title={sub.url}>{host(sub.url)}{sub.group && <> · {sub.group}</>}{sub.backfilledAt && <> · 已补全历史</>}</span>
      {/* ★ 「点了没反应」的正面解法：进度写在**被点的那个动作旁边**，而不是只把按钮变灰。
          探测要依次试 7 个候选地址，实测十几秒 —— 只变灰仍然会被读成「卡住了」。 */}
      {backfilling && <small className="npr-subscription-progress" role="status">正在读取站点目录，可能要十几秒…</small>}
      {sub.lastError && <small role="status">获取失败：{sub.lastError}</small>}
    </div>
    <div className="npr-subscription-actions">
      {canBackfill(sub) && <IconButton
        icon="layers-3"
        label={backfilling ? '正在读取站点目录…' : '补全历史文章'}
        detail={backfilling ? '依次尝试归档页 / sitemap.xml / llms.txt' : `这个源只给了 ${sub.entryCount} 篇，去站点归档页找更早的`}
        disabled={busy}
        busy={backfilling}
        onClick={onBackfill}
      />}
      <IconButton icon="pencil" label="编辑订阅" detail="改名字、分组或订阅地址" disabled={busy} onClick={onEdit} />
      <IconButton icon="copy" label="复制订阅地址" detail="把这个源的 RSS 地址复制到剪贴板" onClick={onCopy} />
    </div>
  </div>;
}

export function SubscriptionManager({ api, subscriptions, onChange, notify }) {
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selected, setSelected] = useState([]);
  const [group, setGroup] = useState('');
  const [editing, setEditing] = useState(null);
  const [editingGroup, setEditingGroup] = useState(null);
  const [busy, setBusy] = useState(false);
  /** 正在补全的那个订阅 id。`null` = 没有补全在进行。 */
  const [backfillingId, setBackfillingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [backfill, setBackfill] = useState(null);
  /**
   * 单次执行的闸门。
   * ★ `disabled` 挡不住**同一帧里的第二次点击** —— state 要等下一次渲染才生效，
   *   而这个动作一跑就是十几秒。真被点两下，宿主会并发跑两遍目录探测（7 次请求 ×2）。
   */
  const backfillLock = useRef(false);
  const errorCount = subscriptions.filter(sub => sub.lastError).length;
  useEffect(() => { if (!errorCount) setErrorsOnly(false); }, [errorCount]);
  const visible = subscriptions.filter((sub) => (!errorsOnly || sub.lastError) && `${sub.name} ${sub.group ?? ''} ${sub.url}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups = groupNamesOf(subscriptions);
  const execute = async (operation) => {
    setBusy(true);
    try { await operation(); } catch (error) { notify(`操作失败：${error?.message ?? String(error)}`, true); }
    finally {
      try { const result = await api.listSubscriptions(); onChange(result.subscriptions); }
      catch (error) { notify(`重新读取订阅失败：${error?.message ?? String(error)}`, true); }
      setBusy(false);
    }
  };
  const batch = async (operation) => {
    const failed = [];
    for (const id of selected) {
      try { await operation(id); } catch (error) { failed.push(`${id}: ${error?.message ?? String(error)}`); }
    }
    setSelected([]);
    if (failed.length) throw new Error(failed.join('; '));
    notify('批量操作完成');
  };
  const toggleSelected = (id, checked) => setSelected(current => checked ? [...current, id] : current.filter(item => item !== id));
  const copyUrl = (sub) => navigator.clipboard.writeText(sub.url).then(() => notify('地址已复制')).catch(error => notify(`复制失败：${error.message}`, true));
  // 补全历史分两步：先只探测（apply 不传），把「找到多少、新增多少」摆给用户看，
  // 确认后才落盘。归档页解析是启发式的，而条目**没有单条删除** —— 写错了只能整源重订。
  const startBackfill = async (sub) => {
    if (backfillLock.current) return;
    backfillLock.current = true;
    setBusy(true);
    setBackfillingId(sub.id);
    try {
      const result = await api.backfillSubscription({ id: sub.id });
      if (!result.ok) {
        notify(result.reason ?? '没有找到可补的历史文章', true);
        // 站点明确回了 404（不是超时）⇒ 宿主已记下「查过了」，重读让入口收起。
        if (result.definitive) {
          const fresh = await api.listSubscriptions();
          onChange(fresh.subscriptions);
        }
        return;
      }
      if (!result.added) {
        notify(`「${sub.name}」没有更多历史文章（站点目录 ${result.found} 篇，已全部收录）`);
        // 宿主已经把「查过、没更多」记下来了，重读一次让这个按钮当场消失 ——
        // 否则用户会对着一个刚说过「没有更多」的按钮再点一次。
        const fresh = await api.listSubscriptions();
        onChange(fresh.subscriptions);
        return;
      }
      setBackfill({ sub, preview: result });
    } catch (error) { notify(`补全失败：${error?.message ?? String(error)}`, true); }
    finally { backfillLock.current = false; setBackfillingId(null); setBusy(false); }
  };
  const confirmBackfill = async () => {
    const target = backfill;
    if (!target) return;
    await execute(async () => {
      const result = await api.backfillSubscription({ id: target.sub.id, apply: true });
      setBackfill(null);
      notify(`已补全 ${result.added} 篇，「${target.sub.name}」现在共 ${result.total} 篇`);
    });
  };
  return <section className="npr-subscriptions" aria-label="管理订阅">
    <div className="npr-subscriptions-toolbar">
      <label className="npr-subscriptions-search"><Icon name="search" size={16} /><input aria-label="搜索订阅" placeholder="搜索名称、分组或地址" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {errorCount > 0 && <div className="npr-segmented" role="group" aria-label="订阅状态"><button type="button" aria-pressed={!errorsOnly} onClick={() => setErrorsOnly(false)}>全部</button><button type="button" aria-pressed={errorsOnly} title="筛选获取失败的订阅源" onClick={() => setErrorsOnly(true)}>异常 {errorCount}</button></div>}
    </div>
    <div className="npr-subscriptions-selection"><button type="button" disabled={busy || !visible.length} onClick={() => setSelected(visible.map(sub => sub.id))}>选择当前结果</button><span>{visible.length} 个结果</span></div>
    {selected.length > 0 && <div className="npr-subscriptions-batch" aria-label="批量操作">
      <strong>已选 {selected.length} 项</strong>
      <label><Icon name="folder" size={15} /><input aria-label="批量移动分组" placeholder="目标分组，留空为未分组" value={group} onChange={event => setGroup(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void execute(() => batch(id => api.updateSubscription({ id, group })))}>移动分组</button>
      <button type="button" disabled={busy} onClick={() => void execute(() => batch(id => api.refresh(id)))}><Icon name="refresh-cw" size={14} />刷新</button>
      <button type="button" disabled={busy} className="danger" onClick={() => setConfirmDelete(true)}><Icon name="trash-2" size={14} />退订</button>
      <button type="button" className="icon" aria-label="取消选择" onClick={() => { setSelected([]); setConfirmDelete(false); }}><Icon name="x" size={16} /></button>
    </div>}
    {confirmDelete && <div className="npr-subscriptions-confirm" role="alert">确认退订这 {selected.length} 个订阅源？<button type="button" className="danger" onClick={() => { setConfirmDelete(false); void execute(() => batch(id => api.removeSubscription(id))); }}>确认退订</button><button type="button" onClick={() => setConfirmDelete(false)}>取消</button></div>}
    <div className="npr-subscriptions-list">
      {visible.map(sub => <SubscriptionRow
        key={sub.id}
        sub={sub}
        busy={busy}
        backfilling={backfillingId === sub.id}
        selected={selected.includes(sub.id)}
        onToggle={checked => toggleSelected(sub.id, checked)}
        onBackfill={() => void startBackfill(sub)}
        onEdit={() => setEditing({ id: sub.id, name: sub.name, group: sub.group ?? '', url: sub.url })}
        onCopy={() => void copyUrl(sub)}
      />)}
      {!visible.length && <div className="npr-subscriptions-empty">{errorsOnly ? '没有获取失败的订阅源' : '没有匹配的订阅源'}</div>}
    </div>
    {groups.length > 0 && <div className="npr-group-manager"><div className="npr-group-heading"><strong>订阅分组</strong><span>{groups.length} 个分组</span></div>
      {groups.map(name => <div className="npr-group-row" key={name}><Icon name="folder" size={15} /><span>{name}</span><small>{subscriptions.filter(sub => sub.group === name).length} 个订阅源</small><button type="button" aria-label={`编辑分组 ${name}`} onClick={() => setEditingGroup({ oldName: name, name })}><Icon name="pencil" size={15} /></button></div>)}
    </div>}
    {backfill && <BackfillDialog state={backfill} busy={busy} onCancel={() => setBackfill(null)} onConfirm={() => void confirmBackfill()} />}
    {editing && <div className="npr-subscription-editor-backdrop" onClick={() => setEditing(null)}><form className="npr-subscription-editor" role="dialog" aria-modal="true" aria-label="编辑订阅" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); } }} onSubmit={event => { event.preventDefault(); if (!busy && editing.name.trim() && /^https?:\/\//i.test(editing.url.trim())) void execute(async () => { await api.updateSubscription(editing); setEditing(null); notify('订阅已更新'); }); }}>
      <div><strong>编辑订阅</strong><button type="button" aria-label="关闭编辑" onClick={() => setEditing(null)}><Icon name="x" size={16} /></button></div>
      <label>名称<input autoFocus aria-label="订阅名称" value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
      <label>订阅地址<input aria-label="订阅地址" value={editing.url} onChange={event => setEditing({ ...editing, url: event.target.value })} /></label>
      <label>分组<input aria-label="订阅分组" list="npr-existing-groups" value={editing.group} onChange={event => setEditing({ ...editing, group: event.target.value })} /><datalist id="npr-existing-groups">{groups.map(name => <option key={name} value={name} />)}</datalist></label>
      <p className="npr-subscription-editor-hint">换地址会清空这个源已有的文章并立刻重新抓取；分组与阅读记录保留。第三方代理失效时用这里原地换源，不必退订重订。</p>
      <div className="npr-subscription-editor-actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={busy || !editing.name.trim() || !/^https?:\/\//i.test(editing.url.trim())}>保存更改</button></div>
    </form></div>}
    {editingGroup && <div className="npr-subscription-editor-backdrop" onClick={() => setEditingGroup(null)}><form className="npr-subscription-editor" role="dialog" aria-modal="true" aria-label="编辑订阅分组" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setEditingGroup(null); } }} onSubmit={event => { event.preventDefault(); if (busy) return; void execute(async () => { const targets = subscriptions.filter(sub => sub.group === editingGroup.oldName); for (const sub of targets) await api.updateSubscription({ id: sub.id, group: editingGroup.name.trim() }); setEditingGroup(null); notify('分组已更新'); }); }}>
      <div><strong>编辑分组</strong><button type="button" aria-label="关闭分组编辑" onClick={() => setEditingGroup(null)}><Icon name="x" size={16} /></button></div>
      <p>修改分组名会移动该分组中的全部订阅源。留空可取消分组，订阅源会保留。</p>
      <label>分组名称<input autoFocus aria-label="分组名称" value={editingGroup.name} onChange={event => setEditingGroup({ ...editingGroup, name: event.target.value })} /></label>
      <div className="npr-subscription-editor-actions"><button type="button" onClick={() => setEditingGroup(null)}>取消</button><button type="submit" disabled={busy || editingGroup.name.trim() === editingGroup.oldName}>保存分组</button></div>
    </form></div>}
  </section>;
}
