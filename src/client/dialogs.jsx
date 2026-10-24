import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';

import { httpFeedUrls } from './feed-urls.js';

function Modal({ label, onClose, children, wide = false }) {
  return (
    <div className="npr-modal-backdrop" onClick={onClose}>
      <div className={`npr-modal${wide ? ' is-wide' : ''}`} role="dialog" aria-label={label} onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** 已有分组的候选清单。单独导出是为了能被**真渲染**一遍（它只在展开时才挂载）。 */
export function GroupMenu({ groups, value, onPick, id }) {
  return <div id={id} className="npr-groupfield-menu" role="group" aria-label="已有分组">
    {groups.map((name) => <button key={name} type="button" className={name === value ? 'is-active' : undefined} aria-pressed={name === value} onClick={() => onPick(name)}>{name}</button>)}
  </div>;
}

/**
 * 分组框：自由输入 + **常驻可见**的下拉按钮。
 *
 * ★ 为什么不用 `<input list>` + `<datalist>`（编辑订阅那处用的就是它）：实测
 *   Chromium **只在输入框获得焦点时才画那个小箭头**，未聚焦时它和普通文本框
 *   一模一样 —— 而「不知道这里能不能点」正是这次要解决的问题。分组又必须能自由输入
 *   （它是自由文本字段），所以做成「输入框 + 一个一直看得见的箭头」。
 * ★ 菜单**向上**弹：这个字段在弹窗里靠底部，向下弹会被 `.npr-modal` 的
 *   `overflow: auto` 裁掉。
 * ★ 关掉菜单的三条路：选了一项、再点一次箭头、点框外或按 Esc。Esc 要
 *   `stopPropagation` —— 设置页在 `window` 上挂了 Esc = 关闭整页，不拦住的话
 *   关一个下拉会把整个设置页一起关掉。
 */
export function GroupField({ value, onChange, groups = [], menuId = 'npr-addfeed-groups' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="npr-groupfield" ref={box}>
    <input
      aria-label="订阅分组"
      placeholder={groups.length > 0 ? '分组（可选，可下拉选或直接输入）' : '分组（可选，输入一个就是新建）'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
    <button
      type="button"
      className="npr-groupfield-toggle"
      aria-label={groups.length > 0 ? '从已有分组里选' : '还没有已有分组'}
      aria-expanded={open}
      disabled={groups.length === 0}
      onClick={() => setOpen((current) => !current)}
    >
      <Icon name="chevron-down" size={15} />
    </button>
    {open && groups.length > 0 && <GroupMenu id={menuId} groups={groups} value={value} onPick={(name) => { onChange(name); setOpen(false); }} />}
  </div>;
}

/**
 * 添加订阅。支持一次粘贴多个地址（每行一个）。
 * 名称与分组只在单个地址时可用 —— 多个地址时由服务端各自取 feed 自己的标题。
 *
 * `groups` = 已经存在的分组名（由调用方用 `groupNamesOf()` 算出来）。
 * 分组框是 `GroupField`：**既能从已有分组里选，也能直接打一个新名字** ——
 * 不用 `<select>`，那会把「新建分组」这条路堵死。
 */
export function AddFeedDialog({ api, onClose, onDone, notify, groups = [] }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { urls, ignored } = httpFeedUrls(text);
  const single = urls.length === 1;
  const submit = async () => {
    if (urls.length === 0 || busy) return;
    setBusy(true);
    setMessage('');
    const failed = [];
    for (const url of urls) {
      try {
        await api.addSubscription({
          url,
          name: single ? name.trim() || undefined : undefined,
          group: group.trim() || undefined,
        });
      } catch (error) {
        failed.push(`${url}（${error?.message ?? String(error)}）`);
      }
    }
    setBusy(false);
    if (failed.length > 0) {
      setMessage(`有 ${failed.length} 个没能订阅：${failed.join('；')}`);
      return;
    }
    await onDone();
    onClose();
  };
  return (
    <Modal label="添加订阅" onClose={onClose} wide={urls.length > 1}>
      <h2>添加订阅</h2>
      <p className="npr-addfeed-hint">粘贴任意 RSS / Atom 地址，一次一个或一行一个。订阅源不需要在这个插件的目录里。</p>
      <textarea className="npr-addfeed-urls" aria-label="订阅地址" placeholder={'https://example.com/feed.xml\nhttps://another.example/atom.xml'} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      <input aria-label="订阅名称" placeholder={single ? '名称（可选，默认读取源标题）' : '名称（多个地址时由各源自己决定）'} disabled={!single} value={name} onChange={(event) => setName(event.target.value)} />
      <GroupField value={group} onChange={setGroup} groups={groups} />
      {groups.length > 0 && <p className="npr-addfeed-hint">已有 {groups.length} 个分组，点右边的箭头选；也可以直接输入一个新的名字。</p>}
      <div className="npr-addfeed-status" role="status">
        {message || (urls.length > 0 ? `将订阅 ${urls.length} 个地址${ignored > 0 ? `（已忽略 ${ignored} 条不是 http(s) 地址）` : ''}` : '')}
      </div>
      <div className="npr-modal-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" disabled={busy || urls.length === 0} onClick={() => void submit()}>
          {busy ? '订阅中…' : urls.length > 1 ? `订阅 ${urls.length} 个` : '订阅'}
        </button>
      </div>
    </Modal>
  );
}
