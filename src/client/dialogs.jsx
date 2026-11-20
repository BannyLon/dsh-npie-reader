import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';

import { httpFeedUrls } from './feed-urls.js';
import { classifySubscriptionUrl } from '../feed-platform.js';

/**
 * 通用模态外壳。
 *
 * ★ Esc 关掉自己，用**原生 `document` 监听**，不用 React 的 `onKeyDown`：
 *   React 的合成事件挂在根容器上，`stopPropagation` 只拦得住 React 树上的传播，
 *   拦不住别处 `addEventListener` 的原生监听 —— 而设置页正是在 `window` 上挂了
 *   「Esc = 关闭整页」。用合成事件的话，用户按 Esc 想关掉「添加订阅」，会连整个
 *   设置页一起关掉（连同别的输入框里填了一半的内容）。
 * ★ 挂 `document`（冒泡）而不是 `window`：document 比 window 先收到事件，
 *   这一层先处理并 `stopPropagation`，设置页就收不到了。
 * ★ 顺序上还有第三层：`GroupField` 的下拉菜单挂的是**捕获阶段**监听，捕获先于
 *   冒泡 ⇒ 菜单展开时按 Esc 只关菜单，不会连对话框一起关掉。
 */
export function Modal({ label, onClose, children, wide = false }) {
  useEffect(() => {
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
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
    /*
     * ★ 这个 Esc 必须挂**捕获阶段**，因为它比外面两层都内层：
     *   设置页在 `window` 上挂了「Esc = 关闭整页」，`Modal` 又在 `document` 冒泡上
     *   挂了「Esc = 关闭对话框」。三层都挂冒泡的话，先注册的先跑 —— 菜单是展开时
     *   才注册的，永远排在最后，于是按 Esc 会先把整个对话框关掉，用户想关的只是
     *   这个下拉。捕获阶段先于冒泡，菜单才能抢在两层之前处理。
     * ★ `preventDefault` 只是让「这个 Esc 已经被消费了」这件事对后面的监听可见；
     *   真正挡住外层的是 `stopPropagation`。
     */
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape, true); };
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
  /**
   * 平台链接的解析结果（0.84.0）。
   *
   * ★ 三态：`null` 还没解析 / `{busy:true}` 正在解析 / 结果对象（含 `error`）。
   *   不能只用 null 与非 null 两态：解析要联网（小宇宙那条路要 1–3 秒），
   *   没有「正在解析」这一态时，用户会以为「什么都没发生」然后再点一次订阅。
   */
  const [resolved, setResolved] = useState(null);
  const { urls, ignored } = httpFeedUrls(text);
  const single = urls.length === 1;
  const singleUrl = single ? urls[0] : '';
  const platformKind = singleUrl === '' ? 'page' : classifySubscriptionUrl(singleUrl).kind;

  /**
   * 只对**平台链接**预解析（直接是 feed 的地址没必要多一次请求）。
   *
   * ★ 500 ms 去抖：粘地址时内容是一个字符一个字符变化的（尤其是手打），
   *   不去抖就是每敲一格发一次请求，小宇宙那边会被打成 429。
   * ★ 结果里有 `error` 也**照样显示**：那是「这个链接订不了，因为……」，
   *   比等他点「订阅」再看到同样的错更早、更省事。
   */
  useEffect(() => {
    setResolved(null);
    if (singleUrl === '' || platformKind === 'feed' || platformKind === 'page') return undefined;
    if (typeof api?.resolveSubscription !== 'function') return undefined;
    let cancelled = false;
    setResolved({ busy: true });
    const timer = setTimeout(() => {
      void api.resolveSubscription(singleUrl).then((result) => {
        if (!cancelled) setResolved(result ?? null);
      }).catch((error) => {
        if (!cancelled) setResolved({ error: error?.message ?? String(error) });
      });
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [singleUrl, platformKind, api]);

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
      <p className="npr-addfeed-hint">
        粘贴 RSS / Atom 地址，或者 <strong>Apple Podcasts、小宇宙、YouTube 的节目链接</strong> —— 会自动找出它真正的订阅源。
      </p>
      <textarea className="npr-addfeed-urls" aria-label="订阅地址" placeholder={'https://example.com/feed.xml\nhttps://www.xiaoyuzhoufm.com/podcast/…\nhttps://podcasts.apple.com/cn/podcast/…/id1514031081'} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      <input aria-label="订阅名称" placeholder={single ? '名称（可选，默认读取源标题）' : '名称（多个地址时由各源自己决定）'} disabled={!single} value={name} onChange={(event) => setName(event.target.value)} />
      <GroupField value={group} onChange={setGroup} groups={groups} />
      {groups.length > 0 && <p className="npr-addfeed-hint">已有 {groups.length} 个分组，点右边的箭头选；也可以直接输入一个新的名字。</p>}
      <div className="npr-addfeed-status" role="status">
        {/* 解析结果：说清「会订到哪个 feed、来自哪个平台」。不显示的话，订阅成功后
            用户在自己的订阅列表里会看到一个陌生的 feed 域名，不知道那是什么。 */}
        {resolved && (
          <span className={`npr-addfeed-resolve${resolved.error ? ' is-error' : ''}`}>
            {resolved.busy
              ? '正在找出这个链接的订阅源…'
              : resolved.error
                ? `这个链接订不了：${resolved.error}`
                : `会订阅到 ${resolved.feedUrl}${resolved.title ? `（${resolved.title}）` : ''}`}
          </span>
        )}
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
