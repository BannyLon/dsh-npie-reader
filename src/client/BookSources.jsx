/**
 * 设置页里的「电子书书架」：**三步**把「书从哪来」这件事走完。
 *
 * 为什么是三步，而不是按数据类型分成四张卡：
 *   旧版把「本地目录 / 百度云盘 / 生成书单 / 书单索引」四张卡平铺，用户看不出先后 ——
 *   五张一样重的卡片里，没人知道该从哪张开始、做完一步下一步是什么。
 *   现在按**用户要按的顺序**编号：① 配源 → ② 生成书单 → ③ 载入到书架。
 *
 * ★ 一条书源 = 一份书单。这是第二步「每个目录一份」与第三步「可一次载入多份」的前提。
 *   合并成一大份之后，「这本书来自哪个源」在生成那一刻就丢了，第三步也就无从选起。
 *
 * ★ 网盘凭证**只走宿主**：这里输入的 SecretKey 用完就清空，页面状态里从来不存它；
 *   宿主回传的 `pan` 里也只有**掩码后的 AppKey**。设置文件里也绝不出现凭证
 *   （见 `pan-auth.js` 顶部）。这三条一起保证「凭证不落到会被整体读出来渲染的地方」。
 *
 * ★ 第二步生成完**不自动载入**。载不载是用户的决定（第三步会问），自动载入会让他发现
 *   「我只是想生成一份备用，结果书架整个换掉了」。
 */

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './icons.jsx';
import {
  fetchSources, listPanDirs, loadLists, panLogout, requestPanAuthorize, savePanApp, saveSources,
  scanSources, submitPanCode,
} from './library-api.js';

/** 第一步里网盘应用的准备说明。**必须完整**：百度开放平台没有「零申请」的调用方式。 */
const SETUP_STEPS = [
  <>用百度账号打开<strong>百度网盘开放平台</strong>的应用列表（pan.baidu.com/union/console/applist）。</>,
  <>完成<strong>开发者实名认证</strong>（个人开发者即可）。</>,
  <>「创建应用」→ 类型选「软件」，接入范围勾选「<strong>网盘</strong>」。</>,
  <>把授权回调地址设为 <code>oob</code>（我们用授权码模式，码会直接显示在页面上）。</>,
  <>拿到 <strong>AppKey</strong> 与 <strong>SecretKey</strong>，填到下面。</>,
];

/** 网盘状态的四种说法。分成四句而不是「已连接 / 未连接」：每种要用户做的事都不一样。 */
function panSummary(pan) {
  if (pan === null) return { tone: 'is-bad', text: '网盘向导没有接上（宿主那一侧未挂载）' };
  if (!pan.configured) return { tone: 'is-todo', text: '还没配置应用 —— 需要先注册一个百度开放平台应用' };
  if (pan.authorized) return { tone: 'is-ok', text: `已授权 · 应用 ${pan.appKeyPreview}` };
  if (pan.expired) return { tone: 'is-todo', text: `授权已过期 · 应用 ${pan.appKeyPreview}（可以重新走一次授权）` };
  return { tone: 'is-todo', text: `已填应用 ${pan.appKeyPreview}，但还没授权` };
}

/** 路径末段，用来显示书单文件名。 */
function baseName(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : String(path ?? '');
}

/** 「什么时候生成的」。只说人话，不做本地化格式化 —— 两端口径必须一致。 */
function whenText(stamp) {
  const value = Number(stamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const days = Math.floor((Date.now() - value) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 步骤标题。编号徽章是把「顺序」画出来的那一笔 —— 没有它，三段还是一样重。 */
function Step({ n, title, meta, children }) {
  return <div className="npr-src-step">
    <div className="npr-src-step-head">
      <span className="npr-src-step-n" aria-hidden="true">{n}</span>
      <h4>{title}</h4>
      {meta !== '' && <span className="npr-src-step-meta">{meta}</span>}
    </div>
    {children}
  </div>;
}

export function BookSources({ settings, onSettingChange, libraryState, libraryBusy, onReload, onIndexChanged, notify }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [localDraft, setLocalDraft] = useState('');
  const [scan, setScan] = useState(null);
  /** 正在改名的那条源 id。同一时刻只允许一条 —— 两行同时进编辑态时谁都说不清在改哪个。 */
  const [renamingId, setRenamingId] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  /** AppKey / SecretKey 的草稿。提交成功立刻清空 —— 秘密不在页面上多留一秒。 */
  const [appDraft, setAppDraft] = useState({ appKey: '', secretKey: '' });
  const [codeDraft, setCodeDraft] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [picker, setPicker] = useState(null);

  const tell = useCallback((text, isError = false) => {
    setMessage(text);
    if (isError) notify?.(text, true);
  }, [notify]);

  const load = useCallback(async () => {
    try {
      setState(await fetchSources());
    } catch (error) {
      tell(`读取书源失败：${error?.message ?? String(error)}`, true);
    }
  }, [tell]);

  useEffect(() => { void load(); }, [load]);

  const sources = state?.sources ?? [];
  const lists = state?.lists ?? [];
  const localSources = sources.filter((source) => source.kind === 'local');
  const panSources = sources.filter((source) => source.kind === 'pan');
  const pan = state?.pan ?? null;
  const external = state?.external ?? null;

  /** 所有写操作都走这里：换列表 → 落盘 → 用宿主**规范化后**的结果回填（不是乐观更新）。 */
  const write = useCallback(async (next, label) => {
    setBusy('sources');
    try {
      setState(await saveSources(next));
      tell(label);
      return true;
    } catch (error) {
      tell(`保存书源失败：${error?.message ?? String(error)}`, true);
      return false;
    } finally { setBusy(''); }
  }, [tell]);

  /** 只挑出可写字段（`id` 由宿主按 kind+path 现算，回传它没有意义）。 */
  const asDraft = (list) => list.map((source) => ({ kind: source.kind, path: source.path, name: source.name }));

  const addLocal = async () => {
    const path = localDraft.trim();
    if (path === '') { tell('先填一个目录路径', true); return; }
    if (localSources.some((source) => source.path === path)) { tell('这个目录已经在列表里了'); return; }
    if (await write([...asDraft(sources), { kind: 'local', path }], `已添加本地目录：${path}`)) setLocalDraft('');
  };

  const removeSource = async (target) => {
    const label = target.kind === 'local' ? '本地目录' : '网盘目录';
    await write(
      asDraft(sources.filter((source) => !(source.kind === target.kind && source.path === target.path))),
      `已移除${label}：${target.path}`,
    );
  };

  /** 改书单名。名字只影响显示（第二步那三行）与第三步的选择列表，不动 id、不动文件。 */
  const saveName = async (id) => {
    const name = nameDraft.trim();
    const row = lists.find((entry) => entry.id === id);
    setRenamingId('');
    if (row === undefined || name === '' || name === row.name) return;
    await write(
      asDraft(sources.map((source) => (source.id === id ? { ...source, name } : source))),
      `书单已改名为「${name}」`,
    );
  };

  const runScan = async (id) => {
    setBusy(`scan:${id ?? 'all'}`);
    setScan(null);
    try {
      const result = await scanSources(id);
      setState(result);
      setScan(result);
      // `scanned` = 这一轮**实际生成**的那几份；`state.lists` 是全量。单行生成时后者会
      // 高估份数，所以提示语必须读前者。
      const done = result.scanned ?? [];
      tell(id ? `「${done[0]?.name ?? '书单'}」已生成：${done[0]?.count ?? 0} 本` : `已生成 ${done.length} 份书单，共 ${result.total} 本`);
      await onIndexChanged?.();
    } catch (error) {
      tell(`生成书单失败：${error?.message ?? String(error)}`, true);
    } finally { setBusy(''); }
  };

  /** 勾选一份书单。ids 是**全量**，不是增量 —— 增量在快速连点时会丢事件。 */
  const toggleLoaded = async (id, on) => {
    const next = on ? [...(state?.loadedListIds ?? []), id] : (state?.loadedListIds ?? []).filter((entry) => entry !== id);
    setBusy('load');
    try {
      setState(await loadLists(next));
      await onIndexChanged?.();
    } catch (error) {
      tell(`切换载入失败：${error?.message ?? String(error)}`, true);
    } finally { setBusy(''); }
  };

  const saveApp = async () => {
    setBusy('pan');
    try {
      const result = await savePanApp(appDraft.appKey, appDraft.secretKey);
      setState((previous) => ({ ...previous, pan: result.pan }));
      setAppDraft({ appKey: '', secretKey: '' });
      tell('应用凭证已保存（只存在插件数据目录里，不会打进设置文件）');
    } catch (error) {
      tell(`保存应用失败：${error?.message ?? String(error)}`, true);
    } finally { setBusy(''); }
  };

  const openAuthorize = async () => {
    setBusy('pan');
    try {
      const result = await requestPanAuthorize();
      setAuthUrl(result.url ?? '');
      if (result.clientOk === false) {
        // 错的 AppKey 在授权页上只显示「与百度连接失败」，用户会以为是网络问题反复点。
        tell(`AppKey 自检没通过：${result.reason}`, true);
      } else {
        window.open(result.url, '_blank', 'noopener,noreferrer');
        tell('已在浏览器打开授权页。授权完成后，把页面上那串授权码复制回来。');
      }
    } catch (error) {
      tell(`打开授权页失败：${error?.message ?? String(error)}`, true);
    } finally { setBusy(''); }
  };

  const completeAuth = async () => {
    setBusy('pan');
    try {
      const result = await submitPanCode(codeDraft.trim());
      setState((previous) => ({ ...previous, pan: result.pan }));
      setCodeDraft('');
      tell('网盘授权完成 —— 现在可以浏览网盘目录、把它加进书源了');
    } catch (error) {
      tell(`授权失败：${error?.message ?? String(error)}`, true);
    } finally { setBusy(''); }
  };

  const dropAuth = async () => {
    setBusy('pan');
    try {
      const result = await panLogout();
      setState((previous) => ({ ...previous, pan: result.pan }));
      tell('已解除网盘授权（AppKey 保留，重新走一次授权就能再用）');
    } catch (error) {
      tell(`解除授权失败：${error?.message ?? String(error)}`, true);
    } finally { setBusy(''); }
  };

  const openPicker = async (path) => {
    setPicker({ path, dirs: [], files: 0, loading: true, error: '' });
    try {
      const result = await listPanDirs(path);
      setPicker({ path: result.path, dirs: result.dirs ?? [], files: result.files ?? 0, loading: false, error: '' });
    } catch (error) {
      setPicker({ path, dirs: [], files: 0, loading: false, error: error?.message ?? String(error) });
    }
  };

  const addPickerDir = async () => {
    if (picker === null) return;
    if (panSources.some((source) => source.path === picker.path)) { tell('这个网盘目录已经在列表里了'); return; }
    const next = [...asDraft(sources), { kind: 'pan', path: picker.path }];
    if (await write(next, `已添加网盘目录：${picker.path}`)) setPicker(null);
  };

  const summary = panSummary(pan);
  const idle = busy === '';
  const generated = lists.filter((row) => row.generatedAt > 0).length;
  const loadedRows = lists.filter((row) => row.loaded);
  // 合计把外部书单也算进来 —— 否则第三步的「共 N 本」会和书架页上的总数对不上，
  // 而那种对不上会被当成 bug 报回来。
  const loadedBooks = loadedRows.reduce((sum, row) => sum + row.count, 0) + (external?.used ? external.count : 0);

  /** 一条目录行：名字在上、路径在下，右侧是状态与操作。 */
  const dirRow = (source) => {
    const meta = lists.find((row) => row.id === source.id);
    return <li key={source.id} className="npr-src-row">
      <span className="npr-src-row-main">
        <span className="npr-src-row-name">{source.name}</span>
        <code className="npr-src-row-path">{source.path}</code>
      </span>
      <span className="npr-src-row-meta">{meta?.generatedAt > 0 ? `${meta.count} 本` : ''}</span>
      <button type="button" className="npr-icon" title="移除" aria-label={`移除 ${source.path}`}
        disabled={!idle} onClick={() => void removeSource(source)}><Icon name="x" size={14} /></button>
    </li>;
  };

  return <div className="npr-src">

    {/* ══ 第一步：电子书源 ══════════════════════════════════════════ */}
    <Step n={1} title="电子书源" meta={sources.length === 0 ? '还没配' : `${sources.length} 个目录`}>
      <div className="npr-src-card">
        <p className="npr-src-sub">本地目录</p>
        {localSources.length > 0 && <ul className="npr-src-rows">{localSources.map(dirRow)}</ul>}
        {localSources.length === 0 && <p className="npr-src-empty">还没有本地目录。电子书在这台机器上就加一个目录。</p>}
        <div className="npr-src-add">
          <input aria-label="本地电子书目录" placeholder="/Users/你/电子书 或 ~/Documents/书籍"
            value={localDraft} onChange={(event) => setLocalDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void addLocal(); }} />
          <button type="button" disabled={!idle} onClick={() => void addLocal()}><Icon name="plus" size={15} />添加目录</button>
        </div>
        <p className="npr-src-hint">
          填绝对路径（<code>~</code> 会展开成主目录）。隐藏目录与符号链接会被跳过；递归最多 8 层，一次最多 20000 本。
        </p>

        <div className="npr-src-sep" />

        <div className="npr-src-subhead">
          <p className="npr-src-sub">百度网盘</p>
          <span className={`npr-src-chip ${summary.tone}`} role="status">{summary.text}</span>
          {pan?.authorized === true && <button type="button" className="npr-src-mini" disabled={!idle}
            onClick={() => void dropAuth()}>解除授权</button>}
        </div>

        {pan !== null && !pan.configured && <>
          <ol className="npr-src-steps">
            {SETUP_STEPS.map((step, index) => <li key={index}>{step}</li>)}
          </ol>
          <div className="npr-src-grid">
            <label>
              <span>AppKey（API Key）</span>
              <input aria-label="百度网盘 AppKey" autoComplete="off" value={appDraft.appKey}
                onChange={(event) => setAppDraft({ ...appDraft, appKey: event.target.value })} />
            </label>
            <label>
              <span>SecretKey</span>
              <input type="password" aria-label="百度网盘 SecretKey" autoComplete="off" value={appDraft.secretKey}
                onChange={(event) => setAppDraft({ ...appDraft, secretKey: event.target.value })} />
            </label>
          </div>
          <div className="npr-src-actions">
            <button type="button" className="is-primary"
              disabled={!idle || appDraft.appKey.trim() === '' || appDraft.secretKey.trim() === ''}
              onClick={() => void saveApp()}>{busy === 'pan' ? '保存中…' : '保存应用'}</button>
          </div>
          <p className="npr-src-hint">
            SecretKey 只写进插件数据目录下的 <code>pan-app.json</code>（权限 600），不进设置文件、也不会回显。
            插件替不了这一步：百度开放平台必须自己注册应用。
          </p>
        </>}

        {pan !== null && pan.configured && !pan.authorized && <>
          <div className="npr-src-actions">
            <button type="button" className="is-primary" disabled={!idle} onClick={() => void openAuthorize()}>打开授权页</button>
            {authUrl !== '' && <button type="button" className="npr-icon" title="复制授权地址"
              aria-label="复制授权地址"
              onClick={() => void navigator.clipboard.writeText(authUrl).then(() => tell('授权地址已复制')).catch((error) => tell(`复制失败：${error.message}`, true))}>
              <Icon name="copy" size={15} /></button>}
          </div>
          {authUrl !== '' && <p className="npr-src-hint">授权地址：<code>{authUrl}</code></p>}
          <div className="npr-src-add">
            <input aria-label="授权码" placeholder="粘贴授权页上显示的那串授权码" value={codeDraft}
              onChange={(event) => setCodeDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void completeAuth(); }} />
            <button type="button" disabled={!idle || codeDraft.trim() === ''}
              onClick={() => void completeAuth()}>{busy === 'pan' ? '兑换中…' : '完成授权'}</button>
          </div>
          <p className="npr-src-hint">
            授权码只能用一次。拿到的 token 存在插件数据目录里，30 天后会用 refresh_token 自动续期。
            {pan.expired ? ' 之前授权过、现在过期了，重新走一遍即可。' : ''}
          </p>
        </>}

        {pan?.authorized === true && <>
          {panSources.length > 0 && <ul className="npr-src-rows">{panSources.map(dirRow)}</ul>}
          {panSources.length === 0 && <p className="npr-src-empty">还没有网盘目录。选一个装电子书的目录加进来。</p>}
          <div className="npr-src-actions">
            <button type="button" disabled={!idle} onClick={() => void openPicker('/')}><Icon name="folder" size={15} />浏览网盘目录</button>
          </div>

          {picker !== null && <div className="npr-src-picker">
            <div className="npr-src-picker-head">
              <code>{picker.path}</code>
              <button type="button" disabled={!idle || picker.loading} onClick={() => void addPickerDir()}>用这个目录</button>
            </div>
            {picker.loading && <p className="npr-src-hint" role="status">正在列目录…</p>}
            {picker.error !== '' && <p className="npr-src-hint is-bad" role="alert">{picker.error}</p>}
            {!picker.loading && picker.error === '' && <>
              <ul className="npr-src-picker-list">
                {picker.path !== '/' && <li>
                  <button type="button" onClick={() => void openPicker(picker.path.replace(/\/[^/]+$/, '') || '/')}>
                    <Icon name="chevron-left" size={14} />上一层
                  </button>
                </li>}
                {picker.dirs.map((dir) => <li key={dir.path}>
                  <button type="button" onClick={() => void openPicker(dir.path)}>
                    <Icon name="folder" size={14} />{dir.name}<Icon name="chevron-right" size={14} />
                  </button>
                </li>)}
                {picker.dirs.length === 0 && <li className="npr-src-picker-none">这里没有子目录</li>}
              </ul>
              <p className="npr-src-hint">这个目录下还有 {picker.files} 个文件（扫描时会递归取到它们）。</p>
            </>}
          </div>}
        </>}
      </div>
    </Step>

    {/* ══ 第二步：生成书单 ══════════════════════════════════════════ */}
    <Step n={2} title="生成书单" meta={lists.length === 0 ? '先配一个目录' : `${generated} / ${lists.length} 份已生成`}>
      <div className="npr-src-card">
        {lists.length === 0 && <p className="npr-src-empty">上面加一个本地目录或网盘目录之后，这里会出现对应的书单。</p>}
        {lists.length > 0 && <ul className="npr-src-rows">
          {lists.map((row) => <li key={row.id} className="npr-src-row">
            <span className="npr-src-row-main">
              {renamingId === row.id
                ? <input className="npr-src-rename" aria-label="书单名称" autoFocus value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={() => void saveName(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveName(row.id);
                    if (event.key === 'Escape') setRenamingId('');
                  }} />
                : <button type="button" className="npr-src-row-name is-editable" title="点一下改名"
                  disabled={!idle}
                  onClick={() => { setRenamingId(row.id); setNameDraft(row.name); }}>{row.name}</button>}
              {/* ★ 这里必须显示**书源目录**，不能显示 `row.path` ——
                  `row.path` 是数据目录下的 `<id>.json`，摆到界面上就是一串哈希文件名，
                  用户既看不出这是哪，也认不出是什么。改过名之后目录名就是唯一的来源线索。
                  `legacy` 那条没有 root，回落到 path（指向旧合并书单，末段仍有意义）。 */}
              <code className="npr-src-row-path" title={row.root || row.path}>{baseName(row.root || row.path)}</code>
            </span>
            <span className={`npr-src-row-meta${row.generatedAt > 0 ? '' : ' is-todo'}`}>
              {row.generatedAt > 0 ? `${row.count} 本 · ${whenText(row.generatedAt)}` : '还没生成'}
            </span>
            <button type="button" className="npr-src-mini" disabled={!idle}
              onClick={() => void runScan(row.id)}>
              {busy === `scan:${row.id}` ? '扫描中…' : (row.generatedAt > 0 ? '重新生成' : '生成')}
            </button>
          </li>)}
        </ul>}
        {lists.length > 1 && <div className="npr-src-actions">
          <button type="button" className="is-primary" disabled={!idle} onClick={() => void runScan()}>
            <Icon name="refresh-cw" size={15} />{busy === 'scan:all' ? '正在扫描…' : `生成全部（${lists.length} 份）`}
          </button>
        </div>}
        {lists.length === 1 && <div className="npr-src-actions">
          <button type="button" className="is-primary" disabled={!idle} onClick={() => void runScan()}>
            <Icon name="refresh-cw" size={15} />{busy === 'scan:all' ? '正在扫描…' : '生成书单'}
          </button>
        </div>}

        {/* ★ 单个源失败不阻断整批，但**必须逐个说出来**是哪个坏了、为什么 ——
            只说「部分失败」等于没说，用户不知道去修哪个。 */}
        {scan?.errors?.length > 0 && <ul className="npr-src-errors">
          {scan.errors.map((error, index) => <li key={index}><code>{error.name || error.root}</code>：{error.message}</li>)}
        </ul>}

        <p className="npr-src-hint">
          扫出来的书单里，书名是<b>文件名清洗版</b>，没有丛书名和年份 —— 那是「整理过的书单」才算得出来的。
          书单一律写在<strong>插件自己的数据目录</strong>里（<code>{baseName(state?.output?.dir ?? 'lists')}/</code>），
          绝不覆盖你在下面指定的那份外部书单。
          网盘源是<strong>逐层列目录</strong>递归扫的（网盘的递归参数实测不生效），几千本要一两分钟 ——
          按钮停在「正在扫描…」不是卡住。
          {state?.legacy !== null && state?.legacy !== undefined
            ? ' 另外还检测到一份旧版合并书单，仍在载入中；重新生成任意一份之后可以删掉它。'
            : ''}
        </p>
      </div>
    </Step>

    {/* ══ 第三步：载入到书架 ════════════════════════════════════════ */}
    <Step n={3} title="载入到书架" meta={loadedRows.length === 0 && !external?.used ? '还没载入' : `已载入 ${loadedRows.length} 份 · 共 ${loadedBooks} 本`}>
      <div className="npr-src-card">
        {lists.length > 0 && <ul className="npr-src-rows">
          {lists.map((row) => <li key={row.id}>
            <label className="npr-src-row is-pick">
              <input type="checkbox" checked={row.loaded === true} disabled={!idle || row.generatedAt === 0}
                onChange={(event) => void toggleLoaded(row.id, event.target.checked)} />
              <span className="npr-src-row-main"><span className="npr-src-row-name">{row.name}</span></span>
              <span className={`npr-src-row-meta${row.generatedAt > 0 ? '' : ' is-todo'}`}>
                {row.generatedAt > 0 ? `${row.count} 本` : '还没生成'}
              </span>
            </label>
          </li>)}
        </ul>}
        {lists.length === 0 && <p className="npr-src-empty">还没有可载入的书单 —— 先在上面配源、生成一份。</p>}

        <div className="npr-src-sep" />

        <p className="npr-src-sub">外部书单</p>
        <div className="npr-src-add">
          <input aria-label="外部书单路径" placeholder="留空 = 不用。也可以填一份你自己整理好的 books.json"
            value={settings?.libraryPath ?? ''}
            onChange={(event) => onSettingChange?.({ libraryPath: event.target.value })} />
          <button type="button" disabled={libraryBusy === true} onClick={() => void onReload?.()}>
            {libraryBusy === true ? '读取中…' : '应用并重新载入'}
          </button>
        </div>
        {external?.used === true && external.error !== '' && (
          <p className="npr-src-hint is-bad" role="alert">这份书单读不了：{external.error}</p>
        )}
        {external?.used === true && external.error === '' && external.missing === true && (
          <p className="npr-src-hint is-bad" role="alert">
            这个路径下没有书单文件：<code>{external.resolved}</code>。改成一个存在的路径，或清空这一栏。
          </p>
        )}
        {external?.used === true && external.error === '' && external.missing !== true && (
          <p className="npr-src-hint">
            已载入 <strong>{external.count}</strong> 本 · <code>{external.resolved}</code>。
            插件<strong>只读</strong>这份书单，不重扫、也不改它 —— 阅读进度记在插件自己的数据目录里。
            上面勾选的书单<strong>不走这个文件</strong>（存在插件数据目录的 <code>lists/</code> 里）；
            哪天不想再用这份外部书单，先<strong>清空这一栏并重新载入</strong>，之后删掉原文件夹对插件毫无影响。
          </p>
        )}
        {external?.used !== true && (
          <p className="npr-src-hint">
            留空就只用上面勾选的书单。这里可以指向一份你<strong>已有且整理过</strong>的书单
            （那份带着丛书名、年份这些扫盘算不出来的字段）；两边都载入时按书合并，重复的只留一条。
          </p>
        )}
        {/* ★ 四种状态各说各的话。「读失败」与「文件不存在」必须分开：
            前者要用户去看文件，后者要用户去看路径 —— 说成同一句等于什么也没说。 */}
        {libraryState === null && <p className="npr-src-hint" role="status">正在读取书架…</p>}
        {libraryState?.error !== undefined && <p className="npr-src-hint is-bad" role="alert">读取书架失败：{libraryState.error}</p>}
        {libraryState !== null && libraryState?.error === undefined && (
          <p className={`npr-src-hint${libraryState.total > 0 ? '' : ' is-todo'}`} role="status">
            书架现在有 <strong>{libraryState.total}</strong> 本书
            {(libraryState.sources ?? []).filter((entry) => entry.error !== '').map((entry) => (
              <span key={entry.id}> · <code>{entry.name}</code> 读不了：{entry.error}</span>
            ))}
            {libraryState.total === 0 ? '。上面配好源、生成并勾选一份书单，书架就有书了。' : '。'}
          </p>
        )}
      </div>
    </Step>

    <p className="npr-src-note" role="status">{message}</p>
  </div>;
}
