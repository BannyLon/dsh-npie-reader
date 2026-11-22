/**
 * 论文阅读：第四个主视图。
 *
 * 为什么论文**不**做成「书架里的第二种文件」——那是最初的想法，但它会退化成一个
 * 带图标的书单第二页。论文和书的差别是**结构可预期**：人会先看标题/作者/venue/摘要
 * 决定要不要读，而不是从头读到尾。所以这一页的第一屏是**速读卡**（详情栏），
 * 列表只负责「有哪些、读到哪、打了什么标签」。
 *
 * ★ 阅读器**一行都不用改**：论文 PDF 落盘之后就是一个普通 PDF 书条目
 *   （宿主 `paperBook()` 给它造 `{ id, ext: 'pdf', size, source: 'paper' }`），
 *   `BookReader` 那边拿到的和书架里的一本书完全同形 —— 目录、找词、划词、划线、
 *   逐章解读、读后感归档全部原样复用。
 * ★ 进度也复用书架那条路（`saveBookState`）：`BookReader` 靠 `states[bookId].page`
 *   恢复位置，另开一套论文进度会让「同一份 PDF」在两条路上记两个位置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
/**
 * ★ 与阅读页 ⋯ 菜单共用同一份「点外面关掉菜单」的判据。
 *
 * 有两个**写错就静默失效**的坑（不排除触发器 ⇒ 永远关不掉；不排除菜单本身 ⇒
 * 点任何一项都没反应），已有真跑断言钉着。这里如果自己再写一遍 `contains`，
 * 等于同一件事两套判定，必然漂移。
 *
 * ★ 判据住在零依赖的 menu-dismiss.js：ReaderPage 本来就 import 本组件，从它
 *   那儿反向取函数会绕出循环依赖；独立模块两边都能直接引用，不必靠
 *   「函数声明在实例化阶段绑定」这类时序约定兜底。
 */
import { attachMenuDismiss } from './menu-dismiss.js';
import { Icon } from './icons.jsx';
import { Modal } from './dialogs.jsx';
import { BRAND_TITLE } from './brand.js';
import { ViewSwitch } from './ViewSwitch.jsx';
import { BookReader } from './BookReader.jsx';
import { fetchStates, saveBookState } from './library-api.js';
import {
  deletePaper, downloadPaperPdf, enrichPaper, fetchPaperBibtex, fetchPapers, importPaper,
  patchPaper, restorePaper, searchPapers, trashPaper, uploadPaper,
} from './paper-api.js';
import { PromptManager } from './PromptManager.jsx';
import {
  PAPER_STATE_FILTERS, applyStatePatch, paperAsBook, paperRowView, paperStateOf, stateOf,
} from '../library.js';
import { SIDEBAR_WIDTH, clampSidebarWidth, readSidebarWidth, saveSidebarWidth } from './sidebar-width.js';

/**
 * 作者列表：前 6 位 + 「等 N 人」。整段铺开会把速读卡挤满。
 */
function authorLine(authors = []) {
  if (authors.length === 0) return '作者未知';
  if (authors.length <= 6) return authors.join('、');
  return `${authors.slice(0, 6).join('、')} 等 ${authors.length} 人`;
}

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 列表行第二行「来源」那一格：期刊优先，其次 arXiv 编号，最后才退到来源名。
 *
 * ★ alphaXiv 上有**没有 arXiv 编号**的论文（0.90.0 才开始收）。旧的那一行只认
 *   `arxivId`，这类论文于是显示成「2026 · —」，看起来像元数据没抓到；写出来源名
 *   至少能解释「为什么它没有编号」。
 */
function paperOriginLabel(paper) {
  if (paper.arxivId) return `arXiv ${paper.arxivId}`;
  return paper.source === 'alphaxiv' ? 'alphaXiv' : '';
}

/**
 * 一条论文列表行。
 *
 * ★ 结构是「`div` 里两个 `button`」，不是「一个 `button` 装下所有东西」：
 *   「读完」那一行右侧多了一颗「重新阅读」，而 `<button>` 里放 `<button>` 是非法
 *   HTML —— 浏览器会把它拆开，且各版本拆法不同（书架 `BookRow` 踩过同一个坑）。
 * ★ 按钮与标签在**主按钮外面**，否则点「重新阅读」会连带选中速读卡。
 * ★ 徽章文案、有没有动作、动作叫什么，全部走 `paperRowView`（共用判据）：
 *   写在这里就只能靠源码字符串断言，而字符串断言答不了「这条分支跑不跑得到」。
 */
export function PaperRow({ paper, states, active, trash, onSelect, onRestart }) {
  /* ★ `trash` 必须传下去：回收站里的条目只该有「恢复 / 彻底删除」，一颗「重新阅读」
     在那儿既不该出现、点了也只会把一篇待删除的论文重新打开。 */
  const view = paperRowView(paper, states, { trash });
  return (
    <div className={`npr-paper-row${active ? ' is-active' : ''}${view.dim ? ' is-dim' : ''}`}>
      {/* ★ 读完那一行**整行不可点**（用户 2026-11-13：「不能点击论文条，灰掉，
          只有点击重新阅读才恢复正常」）：`disabled` 同时挡住了鼠标、键盘、
          以及 `active` 之外的任何选中 —— 真正的入口只剩右边那颗「重新阅读」。
          `disabled` 的按钮拿不到焦点，所以不再需要 `aria-disabled`。 */}
      <button type="button" className="npr-paper-row-main" aria-pressed={active}
        disabled={!view.openable}
        /* ★ 传的是**整个 paper**，不是 `paper.id`。调用方要拿它去 `openReader`
           （判断有没有全文、`status` 要不要写），只给一个 id 就什么都做不了 ——
           2026-11-13 这里传的是 id，于是点「在读」的行 `setSelectedId(undefined)`，
           症状正是用户报的「读完的还能点（那颗重新阅读），在读的却点不动」。
           两侧的契约由此固定：`onSelect(paper)` / `onRestart(paper)`。 */
        onClick={() => onSelect(paper)}>
        <span className="npr-paper-row-title">{paper.title}</span>
        <span className="npr-paper-row-meta">
          {[paper.year || '', paper.venue || paperOriginLabel(paper)].filter(Boolean).join(' · ') || '—'}
        </span>
        <span className="npr-paper-row-foot">
          {/* ★ 状态与进度是**一句**（「在读 · 1/33 页」），与电子书同一个写法；
              拆成两段时读者要在两个位置拼同一句话。 */}
          <span className={`npr-paper-badge ${view.badgeClass}`}>{view.badgeText}</span>
          {paper.file === null && <span className="npr-paper-nofile">无全文</span>}
          {paper.tags.slice(0, 2).map((tag) => <span key={tag} className="npr-paper-tag">{tag}</span>)}
        </span>
      </button>
      {view.action !== null && (
        <button type="button" className="npr-paper-row-action"
          aria-label={view.action.label} title={view.action.title}
          onClick={() => onRestart(paper)}>{view.action.text}</button>
      )}
    </div>
  );
}

/** 导入 / 检索对话框。 */
function PaperDialog({ mode, onClose, onImport, onSearch, notify }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState('');
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  const runImport = async (value) => {
    if (busy !== '') return;
    const text = String(value ?? input).trim();
    if (text === '') return;
    setBusy('正在导入…');
    setError('');
    try {
      const result = await onImport(text);
      if (result?.downloadError) notify?.(`已收录，但全文没下来：${result.downloadError}`);
      onClose();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy('');
    }
  };

  const runSearch = async () => {
    if (busy !== '') return;
    const text = input.trim();
    if (text === '') return;
    setBusy('正在查 arXiv…');
    setError('');
    try {
      setResults(await onSearch(text));
      setSearched(true);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="npr-paper-modal" role="dialog" aria-modal="true" aria-label={mode === 'search' ? '搜索论文' : '导入论文'}>
      <div className="npr-paper-modal-card">
        <div className="npr-paper-modal-head">
          <strong>{mode === 'search' ? '搜索 arXiv' : '导入论文'}</strong>
          <button type="button" className="npr-icon" aria-label="关闭" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
        <p className="npr-paper-modal-hint">
          {mode === 'search'
            ? '关键词、arXiv 编号、alphaXiv 链接都行。搜到之后点「导入」才会入库。'
            : 'arXiv 编号 / 链接、alphaXiv 页面链接、DOI，或者论文标题。默认会把开放获取的全文一起下载下来。'}
        </p>
        <div className="npr-paper-modal-input">
          <input
            autoFocus value={input} onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void (mode === 'search' ? runSearch() : runImport()); }}
            placeholder={mode === 'search' ? 'sparse routing for long documents' : '2401.00001 / 10.0000/example.0002'}
          />
          <button type="button" className="npr-paper-primary" disabled={busy !== ''} onClick={() => void (mode === 'search' ? runSearch() : runImport())}>
            {busy !== '' ? busy : (mode === 'search' ? '搜索' : '导入')}
          </button>
        </div>
        {error !== '' && <p className="npr-paper-error">{error}</p>}
        {mode === 'search' && searched && results.length === 0 && busy === '' && (
          /* ★ 别只说「没搜到」：只在 alphaXiv 上发表（没有 arXiv 编号）的论文
             永远不会出现在这里，而用户手里那条链接正好能导进来。这句话就是
             他下一步要做的动作。 */
          <p className="npr-paper-modal-hint">
            没搜到。只发在 alphaXiv 上（没有 arXiv 编号）的论文不在这里 —— 把它的页面链接贴进「导入」就行。
          </p>
        )}
        {results.length > 0 && (
          <>
            <ul className="npr-paper-results">
              {results.map((item) => (
                <li key={item.key}>
                  <div className="npr-paper-result-main">
                    <span className="npr-paper-result-title">{item.title}</span>
                    <span className="npr-paper-result-meta">
                      {[item.year || '', authorLine(item.authors)].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  {/* ★ 按 id → DOI → 页面地址 的顺序交给导入：alphaXiv 上「没有 arXiv
                      编号」的论文只有页面地址认得出来，而导它的标题会重新搜一遍
                      arXiv，结果还是 0 条。 */}
                  <button type="button" className="npr-paper-ghost" onClick={() => void runImport(item.arxivId || item.doi || item.url || item.title)}>导入</button>
                </li>
              ))}
            </ul>
            {/*
             * 粘了一整句标题（≥3 个词）却只看到「相关的」那一屏时，最可能的处境是
             * 「这篇不在 arXiv 上」—— 而不会有人从一屏差不多的论文里猜出这一点。
             * ★ 只在标题长度像标题时才多说这一句：搜 `harness` 这种单位、词本来
             *   就该有一堆结果，这时候提醒反而是噪音。
             */}
            {input.trim().split(/\s+/).filter(Boolean).length >= 3 && (
              <p className="npr-paper-modal-hint">
                没有要的那篇？只发在 alphaXiv 上（没有 arXiv 编号）的论文搜不到 —— 把它的页面链接贴进「导入」就行。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function PapersApp({ reading, onExit, notify, api, SessionProvider, renderSlot, intent, onIntentDone, onOpenSettings }) {
  // 0.71.0：四个视图共用一份宽度与一个 key。论文页原来写死 340 且分隔条只是装饰。
  const [listWidth, setListWidth] = useState(readSidebarWidth);
  /**
   * 「彻底删除」的二次确认（0.84.7）。
   *
   * ★ 它删的是**文件和元数据一起**（`deletePaper` 连 PDF 一起删），而且回收站里
   *   不保留副本 —— 一次误点就没有了。同项目的「清空某一天」都走确认框，
   *   这一项反而直接执行，标准不一致。
   */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [papers, setPapers] = useState([]);
  const [trashed, setTrashed] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [states, setStates] = useState({});
  /**
   * `states` 的最新镜像（与书架页同一套做法）。
   *
   * ★ 为什么需要：`persistPage()` 是 `BookReader` 每翻一页都会调的回调，它必须
   *   「零依赖」才能让 `readerNode` 的 `useMemo` 真正生效（见下面那段长注释）。
   *   而它要做的事里有一件需要读当前状态：**已经标记读完的论文，不因为又翻了一页
   *   就被改回「在读」**。把 `states` 塞进依赖会让每翻一页都重建阅读器；
   *   从 ref 读就没有这个问题，且与 `LibraryApp` 的判据完全一致。
   */
  const statesRef = useRef(states);
  useEffect(() => { statesRef.current = states; }, [states]);
  /**
   * 当前筛的是哪一组状态。
   *
   * ★ 取值必须是 `PAPER_STATE_FILTERS` 里真实存在的 `value`（「全部」是**空串**，
   *   与电子书那一组一致）。写成 `'all'` 时取不到分组，`visible` 会退回「全部」——
   *   界面上 chip 显示在读、列表却是全部，而且看不出是谁造成的。
   */
  const [filter, setFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [localQuery, setLocalQuery] = useState('');
  const [trashView, setTrashView] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  /**
   * 跨源检索点「论文」结果（0.88.0）：选中那一篇。
   *
   * ★ 只选中、**不直接进阅读器**：用户可能是想确认「是这一篇吗」，也可能是想读。
   *   直接把人推进 PDF 阅读器，他还要先退出来才能看摘要 —— 多一次反向操作。
   * ★ 带上 `intent.at` 做依赖：同一篇论文连点两次也要重新选中（值相同时
   *   effect 不跑，症状是「第二次点了没反应」）。
   */
  useEffect(() => {
    if (typeof intent?.paperId !== 'string' || intent.paperId === '') return;
    setSelectedId(intent.paperId);
    onIntentDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.paperId, intent?.at]);
  const [dialog, setDialog] = useState('');
  /**
   * 伴读那颗「+」打开的快捷提示词面板。
   *
   * ★ 论文页**必须自己搭这层壳**：书架那边把同一颗按钮接到设置页的 prompts 页签
   *   （`LibraryApp` 有 `setSettingsEntry`），而论文页没有设置页 —— 于是
   *   `onManagePrompts` 一路传下来都是 `undefined`，按钮在、`onClick` 是空的，
   *   点下去什么都不会发生。这正是用户 2026-11-12 报的那张图。
   * ★ 值为 `null` 表示关着；用对象是为了带 `add`（从「+」进来直接展开新增表单）。
   */
  const [promptsOpen, setPromptsOpen] = useState(null);
  const [tagDraft, setTagDraft] = useState('');
  const [busyId, setBusyId] = useState('');
  /** 速读卡上「复制引用 / 补全元数据」各自的在途状态。与 `busyId`（下载全文）分开：
   *  两个动作互不阻挡，也不会让「下载中…」出现在引用按钮上。 */
  const [metaBusy, setMetaBusy] = useState('');
  /** 摊在速读卡里的 BibTeX。带 `id`：切到另一篇论文时不该还显示上一篇的引用。 */
  const [bibtex, setBibtex] = useState(null);
  /** 「+」下拉：三种添加途径（导入 / 搜 arXiv / 上传）收在这一颗按钮后面。 */
  const [addOpen, setAddOpen] = useState(false);
  /** 触发器 + 菜单共用一个容器 ref：点容器内任何地方都不算「点在外面」。 */
  const addRef = useRef(null);
  const [readingId, setReadingId] = useState('');
  /**
   * 这次打开要落在第几页（`{ id, page }`），**打开那一刻算一次就不动了**。
   *
   * ★ 为什么是 state 而不是每次渲染现算：现算出来的是「当前进度」，而阅读器
   *   只在开局读一次 `initialPage` —— 传一个一直在变的值没有意义，还会让下面
   *   `readerNode` 的 `useMemo` 每次翻页都失效。冻结成快照之后，它只在
   *   `openReader` / `restartPaper` 里写，翻页与状态更新都碰不到它。
   * ★ `page === 0` 表示「从头读」，此时 `initialPage` 传 `null`，阅读器走自己的兜底。
   */
  const [resumeAt, setResumeAt] = useState(null);
  /**
   * 沉浸态。由 `BookReader` 上报（用户点顶部胶囊最后那颗「沉浸」）。
   *
   * ★ 它**必须落在 `.npr-workarea` 上**，不能落在 `.npr-layout` 里：要收起来的是
   *   `.npr-sidebar` 与 `.npr-resize`，而它们是 `.npr-layout` 的**直接子级**。
   *   与书架那边（LibraryApp 的 `is-book-immersive`）同一套类名、同一条 CSS。
   */
  const [immersive, setImmersive] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef(null);
  const saveTimer = useRef(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const load = useCallback(async () => {
    setError('');
    try {
      const body = await fetchPapers({ trash: true });
      setPapers(Array.isArray(body.papers) ? body.papers : []);
      setTrashed(Array.isArray(body.trashed) ? body.trashed : []);
      setTags(Array.isArray(body.tags) ? body.tags : []);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void fetchStates().then(setStates).catch(() => {});
  }, []);

  /**
   * 「+」下拉只在开着的时候挂监听（关着时不该在 document 上留东西）。
   * ★ `menu` / `trigger` 都传 `addRef.current`：它把按钮与菜单一起包住，于是
   *   点按钮（负责开合）和点菜单项（自己 `setAddOpen(false)`）都不会被判成
   *   「点在外面」。这正是 `attachMenuDismiss` 要求排除的两处。
   */
  useEffect(() => {
    if (!addOpen) return undefined;
    const off = attachMenuDismiss(document, {
      menu: addRef.current,
      trigger: addRef.current,
      close: () => setAddOpen(false),
    });
    const onKey = (event) => { if (event.key === 'Escape') setAddOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => {
      off();
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);

  const list = trashView ? trashed : papers;

  /**
   * 当前筛的是哪一组。
   *
   * ★ 取不到时**退回「全部」**而不是「不过滤」：`filter` 是在别处也可能被写坏的
   *   一个字符串，若让它落到「不过滤」，界面会出现「chip 显示在读、列表却是全部」
   *   这种自相矛盾 —— 与 `filterBooks` 末尾那个 `??` 兜底同一条理由。
   */
  const visible = useMemo(() => {
    const word = localQuery.trim().toLowerCase();
    const group = PAPER_STATE_FILTERS.find((item) => item.value === filter) ?? PAPER_STATE_FILTERS[0];
    return list.filter((paper) => {
      if (tagFilter !== '' && !paper.tags.includes(tagFilter)) return false;
      /* ★ 分组筛（`statuses` 是一组，不是一个值）：新导入、一次没打开过的论文
            `status === 'new'`，它必须出现在「在读」下面 —— 改之前这里写的是
            精确相等，那一格会整批漏掉（电子书 0.8.9 踩过同一个坑）。 */
      if (!trashView && group.statuses !== null) {
        if (!group.statuses.includes(paperStateOf(paper, states).status)) return false;
      }
      if (word === '') return true;
      const haystack = [paper.title, paper.venue, paper.arxivId, paper.doi, ...(paper.authors ?? []), ...paper.tags]
        .join(' ').toLowerCase();
      return haystack.includes(word);
    });
  }, [list, tagFilter, filter, localQuery, states, trashView]);

  /**
   * 读数行上的分组计数（2026-11-13）。
   *
   * ★ 口径必须与筛选项**同一份**：两边都用 `paperStateOf().group`，`group` 的取值
   *   就是 `PAPER_STATE_FILTERS` 的 `value`。各数一遍时的症状是「状态行写在读 3、
   *   点进去只有 2 篇」—— 那比不显示数字更糟。
   * ★ 「全部」不单独计数：它就是 `papers.length`，再数一遍等于让读者做加法。
   */
  const stateCounts = useMemo(() => {
    const counts = { reading: 0, done: 0 };
    for (const paper of papers) counts[paperStateOf(paper, states).group] += 1;
    return counts;
  }, [papers, states]);

  /**
   * ★ 没手动选中时**不要**自动挑 `visible[0]`（0.69.1 改）。
   *
   * 论文 tab 与 RSS / 电子书保持一致：右边先是一张说明页，点列表里的一篇才换成
   * 速读卡。原来一进 tab 就自动展开第一篇，那张「这是谁、怎么用」的入口页根本
   * 没机会出现 —— 用户切到论文图标看到的是某篇论文的摘要，不是这个模块的说明。
   */
  const selected = useMemo(
    () => list.find((paper) => paper.id === selectedId) ?? null,
    [list, selectedId],
  );

  /**
   * 说明页底部那行统计。与书架同一条原则：**来源**（怎么加进来的）和**状态**
   * （有没有全文 / 读到哪）正交，不要列「总数」—— 各来源相加就是总数，再列一遍
   * 等于让读者自己做加法，还会把这一行撑到换行。
   */
  const welcomeStats = useMemo(() => {
    const bySource = (value) => papers.filter((paper) => paper.source === value).length;
    return {
      arxiv: bySource('arxiv'),
      alphaxiv: bySource('alphaxiv'),
      doi: bySource('doi'),
      local: papers.length - bySource('arxiv') - bySource('alphaxiv') - bySource('doi'),
      withFile: papers.filter((paper) => paper.file !== null).length,
      /**
       * 「已在读」必须与「在读」筛**同一口径**（= 未开始 + 在读）。
       * ★ 改之前这里数的是 `status === 'reading'`，而筛选项已经把 `new` 并进在读组
       *   了 ⇒ 状态行会比点进去看到的少几篇。凡「读数 + 入口」成对出现的地方，
       *   口径只有一份（电子书 `listHint` 那条注释说的是同一件事）。
       */
      reading: papers.filter((paper) => paperStateOf(paper, states).group === 'reading').length,
    };
  }, [papers, states]);

  /**
   * 正在读的那一篇。
   *
   * ★ 不能在这里 `setReadingId('')`（渲染期改状态 → React 会警告，且可能在
   *   同一次渲染里反复触发）。论文被删掉时由下面那个 effect 收尾。
   */
  const readingPaper = readingId === ''
    ? null
    : (papers.find((item) => item.id === readingId) ?? trashed.find((item) => item.id === readingId) ?? null);

  useEffect(() => {
    if (readingId !== '' && readingPaper === null) setReadingId('');
  }, [readingId, readingPaper]);

  useEffect(() => { setTagDraft(selected ? selected.tags.join(', ') : ''); }, [selected?.id]);

  const patchLocal = useCallback((paper) => {
    setPapers((previous) => previous.map((item) => (item.id === paper.id ? paper : item)));
  }, []);

  // ---- 动作 ---------------------------------------------------------------

  const openReader = useCallback(async (paper) => {
    if (paper.file === null) {
      notifyRef.current?.('这篇还没有全文，先「下载全文」或上传 PDF');
      return;
    }
    /**
     * ★ 续读点必须**在打开这一瞬间冻结**（2026-11-13）。
     *
     * 改之前 `readerStates` 只传 `{ state }`，而 `BookReader` 起页读的是
     * `current.page`（`stateOf` 补出 0）⇒「在读」的论文每次打开都从第 1 页开始，
     * 左栏徽章却写着「在读 · 3/33 页」—— 用户看到的就是「续读没生效」。
     * ★ **不能**为了修这个把 `page` 塞回 `readerStates`：那个对象每翻一页都是新的，
     *   `readerNode` 的 `useMemo` 会整棵失效，阅读器每翻一页重建一次 —— 那正是
     *   0.68.1 修掉的那次卡顿（见下面「必须不随翻页重渲染」）。
     *   `initialPage` 是阅读器只在开局读一次的入参，正好就是「冻结的一次性值」。
     */
    setResumeAt({ id: paper.id, page: stateOf(statesRef.current, paper.id).page || 0 });
    setReadingId(paper.id);
    if (paper.status === 'new') {
      void patchPaper(paper.id, { status: 'reading' }).then(patchLocal).catch(() => {});
    }
  }, [patchLocal]);

  /**
   * 「重新阅读」：把一篇**已读完**的论文放回「在读」并打开。
   *
   * ★ 与 `openReader` 分开，理由与书架的 `restartBook` 一模一样：`openReader`
   *   对已完成的那篇不写状态（只是看一眼），而「重新阅读」是用户明确说「再读一遍」
   *   ⇒ 必须改状态。混成一个函数时两者迟早互相覆盖。
   * ★ **两边都要写**（书状态 + `paper.status`）：列表徽章与筛选读的是
   *   `paperStateOf()`，它让书状态压过 `paper.status`；而速读卡、导出读的是
   *   `paper.status`。少写一边的表现是「点了重新阅读，标签还写着读完」。
   * ★ 进度**不清零**：状态回到在读，`page` 原样保留，打开后停在原来那一页
   *   —— 与书架那条路是同一条承诺（`applyStatePatch` 还会保住 `finishedAt`）。
   */
  const restartPaper = useCallback((paper) => {
    if (paper.file === null) {
      notifyRef.current?.('这篇还没有全文，先「下载全文」或上传 PDF');
      return;
    }
    const id = paper.id;
    const next = applyStatePatch(stateOf(statesRef.current, id), { state: 'reading' });
    // 同步 ref：紧接着翻页时 `persistPage` 会读它来决定「要不要改回在读」。
    statesRef.current = { ...statesRef.current, [id]: next };
    setStates((previous) => ({ ...previous, [id]: next }));
    void saveBookState(id, { state: 'reading' })
      .catch((cause) => notifyRef.current?.(`没能放回「在读」：${cause?.message ?? cause}`));
    void patchPaper(id, { status: 'reading' })
      .then(patchLocal)
      .catch((cause) => notifyRef.current?.(`论文状态没能更新：${cause?.message ?? cause}`));
    setResumeAt({ id, page: next.page || 0 });
    setReadingId(id);
    /* ★ 顺手选中这一条：读完那一行是 `disabled` 的，点它选不中；而它此刻已经在读了
       —— 侧栏高亮不跟过去的话，左边停在上一条、右边却翻开这一篇，看着像点错了。 */
    setSelectedId(id);
  }, [patchLocal]);

  /**
   * 翻页进度：**去抖 1.2 秒**后写一次。
   *
   * ★ 必须去抖：pdf.js 在快速滚轮下会连着报十几页，每一页发一次 POST 等于
   *   把「本机 HTTP + 全量重写 data.json」跑十几遍，而中间那些值用户根本不会看。
   * ★ 卸载时补写（`return () => flush()`）：用户翻到第 30 页立刻切走视图时，
   *   那一次进度不能丢 —— 丢的表现是「下次打开还停在上一处」。
   */
  const persistPage = useCallback((id, page, pages) => {
    /**
     * ★ 已经标记读完的论文，**不因为又翻了一页就改回「在读」** —— 那是用户显式
     *   的判断，与书架那条路（`LibraryApp` 的 `createPageProgress`）同一条规则。
     *   少这一条的表现：点完「标记读完」再往后翻，胶囊那颗按钮自己变回
     *   「标记读完」，用户看到的就是「标记读完失效」。
     */
    const patch = { page, pages, ...(stateOf(statesRef.current, id).state === 'read' ? {} : { state: 'reading' }) };
    setStates((previous) => ({
      ...previous,
      [id]: applyStatePatch(stateOf(previous, id), patch),
    }));
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveBookState(id, patch).catch((cause) => {
        notifyRef.current?.(`阅读进度没能保存：${cause?.message ?? cause}`);
      });
    }, 1200);
  }, []);

  useEffect(() => () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
  }, []);

  const addTag = async (paper, raw) => {
    const tag = raw.trim();
    if (tag === '') return;
    if (paper.tags.includes(tag)) { setTagDraft(paper.tags.join(', ')); return; }
    try {
      patchLocal(await patchPaper(paper.id, { tags: [...paper.tags, tag] }));
      void load();
      setTagDraft('');
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    }
  };

  const removeTag = async (paper, tag) => {
    try {
      patchLocal(await patchPaper(paper.id, { tags: paper.tags.filter((item) => item !== tag) }));
      void load();
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    }
  };

  const doDownload = async (paper) => {
    setBusyId(paper.id);
    try {
      const body = await downloadPaperPdf(paper.id);
      patchLocal(body.paper);
      notifyRef.current?.('全文已下载');
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    } finally {
      setBusyId('');
    }
  };

  /**
   * 复制 BibTeX（C 档）。
   *
   * ★ **不把「复制成功」当成唯一出口**：桌面端的 `navigator.clipboard` 在未聚焦 /
   *   权限被收走时是会拒的，只写 `try/catch + toast` 的话用户就拿不到这段引用，
   *   等于这个能力白做。所以无论成功与否都把文本摊在速读卡里，成功时额外自动
   *   复制一次，失败时提示「手动选中下面这段」。
   * ★ 拼接规则只有 `src/paper-bibtex.js` 一份，客户端绝不自己拼（双层花括号、
   *   转义、引用键，手写一遍一定漂）。
   */
  const doBibtex = async (paper) => {
    setMetaBusy('bibtex');
    try {
      const body = await fetchPaperBibtex(paper.id);
      setBibtex({ id: paper.id, text: body.text, key: body.key });
      try {
        await navigator.clipboard.writeText(body.text);
        notifyRef.current?.(`已复制引用（${body.key}）`);
      } catch {
        notifyRef.current?.('自动复制没成功，请手动选中下面这段引用');
      }
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    } finally {
      setMetaBusy('');
    }
  };

  /** 补全元数据：只填空着的字段，查不到不是错误（付费墙 / 没有标识符都长这样）。 */
  const doEnrich = async (paper) => {
    setMetaBusy('enrich');
    try {
      const body = await enrichPaper(paper.id);
      patchLocal(body.paper);
      void load();
      const labels = {
        title: '标题', venue: '期刊/会议', abstract: '摘要', doi: 'DOI',
        arxivId: 'arXiv 编号', url: '来源页', pdfUrl: '全文地址', year: '年份', authors: '作者',
      };
      const changed = (body.changed ?? []).map((field) => labels[field] ?? field);
      notifyRef.current?.(changed.length > 0
        ? `已补全：${changed.join('、')}`
        : '没有查到可补的字段（这篇可能没有 DOI / arXiv 编号，或数据源暂时没响应）');
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    } finally {
      setMetaBusy('');
    }
  };

  const doTrash = async (paper) => {
    try {
      await trashPaper(paper.id);
      setPapers((previous) => previous.filter((item) => item.id !== paper.id));
      void load();
      notifyRef.current?.('已移入回收站');
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    }
  };

  const doRestore = async (paper) => {
    try {
      await restorePaper(paper.id);
      void load();
      notifyRef.current?.('已恢复到论文库');
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    }
  };

  const doDelete = async (paper) => {
    try {
      await deletePaper(paper.id);
      void load();
      notifyRef.current?.('已彻底删除（含 PDF）');
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    }
  };

  const doUpload = async (file) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) {
      notifyRef.current?.('只支持 PDF');
      return;
    }
    setImporting(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读不到这个文件'));
        reader.readAsDataURL(file);
      });
      const body = await uploadPaper(file.name, dataUrl);
      await load();
      setSelectedId(body.paper.id);
      notifyRef.current?.('已导入');
    } catch (cause) {
      notifyRef.current?.(cause?.message ?? String(cause));
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  // ---- 阅读器 -------------------------------------------------------------

  /**
   * ★★ 阅读器**必须**长在 `.npr-workarea > .npr-layout` 这套骨架里 ★★（0.68.1 修）
   *
   * 0.68.0 的做法是「一旦开读就 `return` 一个裸 `<div class="npr-paper-reader">`」，
   * 脱离了骨架。后果是一整串布局崩塌，全都在真机上肉眼可见（用户 2026-11-06 第二轮截图）：
   *
   *   ① **左栏没了**：`.npr-sidebar` 是阅读区的**祖先兄弟**，`return` 掉骨架就连它
   *      一起没了 —— 用户原话「为什么侧边栏还没有了」。
   *   ② **书页缩成一小张**：「适应窗口」按 `.npr-book-view` 的高度算比例，而那条高度
   *      链是 `.npr-layout` 的 grid → `.npr-reader-book{flex}` → `.npr-book{flex:1}`
   *      → `.npr-book-main` → 舞台。裸 `div` 里 `height:100%` 直接落空，算出来是
   *      「可用高度≈0」，于是整页只剩 50%（用户截图里那页小纸片）。
   *   ③ **整页错位 / 撑到屏幕外**：`.npr-book-stage` 的宽高也来自同一条链，240% 时
   *      没有可滚动的容器约束它，正文就一路溢出到窗口右侧。
   *   ④ **FAB 跑到右上角**：`.npr-book-view` 是绝对定位的基准，它被压成零高之后，
   *      7 格扇出画到了面板外面，正好压在顶部工具栏上。
   *
   * ⇒ 结论：论文的阅读页与书架**共用同一套容器**（`<section class="npr-reader
   *   npr-reader-book">`），只换里面的组件。别再为了「全屏阅读」另起一棵树 ——
   *   要全屏就打开沉浸态（`.is-book-immersive` 会把左栏收起来），那条路是现成的。
   */
  const readingBook = useMemo(
    () => (readingPaper === null ? undefined : paperAsBook(readingPaper)),
    [readingPaper],
  );

  /**
   * ★★ 阅读器那一支必须**不随翻页重渲染**（0.68.1 性能）★★
   *
   * 症状（用户 2026-11-06 第三轮）：「进到阅读页非常卡，切换阅读条目更卡」。
   *
   * 根因不是 PDF 解析，是**每翻一页都把整棵阅读器重跑一遍**：`persistPage()` 会把
   * `states` 换成一个新对象（为了左栏那行「在读 8/37 页」能实时更新）⇒ `PapersApp`
   * 重渲染 ⇒ `<BookReader>`（2900 行、50 多个 hook、每次要拼出 FAB 七格 / 划线层 /
   * 文字层宿主节点）跟着整块重跑。滚轮连翻十几页就是十几遍。
   *
   * 三件事一起做才有效：
   *   ① `book` 用 `useMemo` 稳住 —— `paperAsBook()` 每调一次都是新对象；
   *   ② `states` 只传**状态名**：阅读器只读 `current.state`（标记读完那颗按钮）与
   *      换书时的 `current.page`，页面进度它自己就是唯一的产生方，不需要回灌；
   *   ③ 回调与整个 `<section>` 元素一起 `useMemo` —— 元素引用不变时 React 会
   *      **跳过整棵子树**，这才是省下来的那一大块。
   *
   * ★ 别把 `states` 直接传下去求省事：那一个对象每翻一页都是新的，①②③ 全白做。
   * ★ 左栏那行页码仍然实时（它读的是 `states`，与阅读器无关）。
   */
  const readerStateName = readingBook === undefined ? '' : stateOf(states, readingBook.id).state;
  const readerStates = useMemo(
    () => (readingBook === undefined ? {} : { [readingBook.id]: { state: readerStateName } }),
    [readingBook, readerStateName],
  );
  const onReaderPage = useCallback((page, pages) => {
    if (readingBook !== undefined) persistPage(readingBook.id, page, pages);
  }, [readingBook, persistPage]);
  /**
   * 「标记读完」。**这件事要写三处，少一处就“看起来没反应”**：
   *
   *   ① 阅读器那颗按钮读的是 `states[id].state`（书状态）。只改论文自己的
   *      `status` 的话按钮文字原地不动 —— 用户点完看到的就是「功能失效」；
   *   ② 论文列表的标签与「读完」筛选走 `paperStateOf()`，它**优先用 book state**
   *      （`state.state !== 'unread'` 时压过 `paper.status`），所以 states 不写，
   *      列表也还是「在读」；
   *   ③ `paper.status` 是论文自己的记录（速读卡、导出、按状态筛选用），书架那边
   *      没有这一层，不能省。
   *
   * ★ 乐观更新在前、落盘在后：等往返会让按钮半天不响应（与书架同一取舍）。
   * ★ 依赖里**不能**出现 `notify`（每渲染都可能是新引用），否则下面 `readerNode`
   *   的 `useMemo` 失效、每翻一页都要重建阅读器 —— 提示统一走 `notifyRef`。
   */
  const onReaderFinished = useCallback(() => {
    if (readingBook === undefined) return;
    const id = readingBook.id;
    const next = applyStatePatch(stateOf(statesRef.current, id), { state: 'read' });
    // 同步 ref：标记读完后立刻翻页时，`persistPage` 会读它来决定「要不要改回在读」。
    statesRef.current = { ...statesRef.current, [id]: next };
    setStates(previous => ({ ...previous, [id]: next }));
    void saveBookState(id, { state: 'read' }).catch((cause) => {
      notifyRef.current?.(`标记读完没能存下来：${cause?.message ?? cause}`);
    });
    void patchPaper(id, { status: 'done' })
      .then(patchLocal)
      .catch((cause) => notifyRef.current?.(`论文状态没能更新：${cause?.message ?? cause}`));
  }, [readingBook, patchLocal]);
  /**
   * 伴读里的「+」：打开论文快捷提示词面板，并**直接展开新增表单**。
   *
   * ★ 图标是「+」，点开只看到一张已有清单等于没兑现这个图标 —— 用户是来加一条的。
   * ★ 必须是 `useCallback` 且依赖为空 —— 它进了下面 `readerNode` 的 useMemo 依赖，
   *   每次渲染都给一个新函数会让阅读器整棵重建（每翻一页回到第一页）。
   */
  const onManagePrompts = useCallback(() => setPromptsOpen({ add: true }), []);
  const readerNode = useMemo(() => {
    if (readingBook === undefined) return null;
    return (
      <section className="npr-reader npr-reader-book">
        <BookReader
          key={readingBook.id}
          book={readingBook}
          reading={reading}
          states={readerStates}
          /* ★ 续读点：只在**这一次打开**时算一次（见 `resumeAt` 的说明）。
             传 `null` 时阅读器按自己的兜底（第 1 页）走。 */
          initialPage={resumeAt !== null && resumeAt.id === readingBook.id && resumeAt.page > 0 ? resumeAt.page : null}
          notify={notify}
          onPageChange={onReaderPage}
          onImmersiveChange={setImmersive}
          onFinished={onReaderFinished}
          api={api}
          SessionProvider={SessionProvider}
          renderSlot={renderSlot}
          onManagePrompts={onManagePrompts}
        />
      </section>
    );
  }, [readingBook, reading, readerStates, resumeAt, notify, onReaderPage, onReaderFinished, api, SessionProvider, renderSlot, onManagePrompts]);

  /**
   * 退出阅读时把沉浸态复位。
   *
   * ★ 不复位的后果：在沉浸态下按「回到速读卡」，`.is-book-immersive` 还挂在
   *   `.npr-workarea` 上 ⇒ 左栏继续是 `display: none`，速读卡旁边一片空白，
   *   用户会以为「侧边栏彻底没了」（这正是这一轮要修的那个现象）。
   * ★ 同理，`BookReader` 卸载时不会替我们上报 `false`。
   */
  useEffect(() => {
    if (readingId === '') setImmersive(false);
  }, [readingId]);

  // ---- 主视图 -------------------------------------------------------------

  /** 与另外三个视图同一套拖动：共用夹取、共用 key、双击复位到共用基准。 */
  const startDrag = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    let width = listWidth;
    const move = (moveEvent) => {
      width = clampSidebarWidth(listWidth + moveEvent.clientX - startX);
      setListWidth(width);
    };
    const up = () => {
      saveSidebarWidth(width);
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  };

  /**
   * 速读卡上那颗主按钮：**读完的那一篇不再叫「阅读全文」**。
   *
   * ★ 用户 2026-11-13 定的规则（与电子书同一条）：「读完的书不能点击」—— 不是把行
   *   藏起来，而是**不能一句话就重新翻开**：想再读必须点一次「重新阅读」，它才把
   *   状态写回在读并保留页码。改之前读完的论文和正在读的长得一模一样，点一下就翻开，
   *   状态还停在「读完」。
   * ★ 「继续阅读」只在有进度时出现：一篇从没翻过的论文写「继续」是没有对象的。
   * ★ 回收站里没有这颗按钮（那一支只画「恢复 / 彻底删除」），所以这里恒非回收站 ——
   *   判断仍然写全，免得哪天回收站那一支改成共用同一个头部。
   */
  const selectedView = selected === null ? null : paperRowView(selected, states, { trash: trashView });
  /* ★ 判据用 `selectedView.action`，**不再自己重写一遍 `group === 'done'`**：
     两侧各判一次时必然出现「行上写着读完、锁死了，速读卡却给了一颗能翻开的按钮」。
     现在「有没有重新阅读」只有一个来源。
     ★ 读完但没有本地全文的那一篇：`action` 是 `null`，按钮落到「已读完」并 disabled
       （`disabled={selected.file === null}`）—— 比给它一颗点了只弹提示的「重新阅读」诚实。 */
  const readAction = selectedView === null || trashView
    ? null
    : selectedView.action !== null
      ? {
        text: selectedView.action.text,
        icon: 'refresh-cw',
        title: selectedView.action.title,
        run: () => restartPaper(selected),
      }
      : {
        text: selectedView.group === 'done' ? '已读完' : (selectedView.page > 0 ? '继续阅读' : '阅读全文'),
        icon: 'book-open',
        title: selectedView.group === 'done'
          ? '这篇没有本地全文 —— 已读完，也没有可再打开的正文'
          : (selectedView.page > 0 ? `接着上次停下的第 ${selectedView.page} 页读` : ''),
        run: () => void openReader(selected),
      };

  return (
    <div className={`npr-workarea${immersive ? ' is-book-immersive' : ''}`}><div className="npr-layout" style={{ '--npr-list-width': `${listWidth}px` }}>
      <aside className="npr-sidebar">
        <div className="npr-sidebar-toolbar" data-window-drag>
          {/* ★ 这里必须把**目标模式**转出去（同 LibraryApp 那条注释）：只判 `=== 'feeds'`
              会让「从论文点日记」变成点了没反应。 */}
          <ViewSwitch mode="paper" onChange={(next) => { if (next !== 'paper') onExit?.(next); }} showLibrary showDiary />
          {/* ★ 「返回摘要页」**不在这行**（0.71.5，用户 2026-11-07）：它原来夹在
              日历 / + / 刷新之间，灰扑扑一颗，用户的原话是「能不能把返回这个按钮
              放在侧边栏的左右边，变个颜色突出一下，鼠标移上去有提示，返回到摘要页」。
              一行里三颗图标本来就是同级动作，硬塞第四颗只会让「返回」更难找 ——
              它现在独立成工具栏下面**一条整宽的返回条**（见下面 `.npr-paper-back`）。 */}
          {/* 三种「添加论文」途径收在一颗「+」后面。原来这三颗并排，用户得先猜
              「+ 和放大镜哪个是搜、哪个是导入」—— 它们其实是同一件事的三个入口。
              ★ 刷新不是添加途径，保持独立。 */}
          <div className="npr-paper-add" ref={addRef}>
            <button type="button" className={`npr-icon${addOpen ? ' is-on' : ''}`}
              title="添加论文" aria-label="添加论文" aria-haspopup="menu" aria-expanded={addOpen}
              onClick={() => setAddOpen((open) => !open)}><Icon name="plus" /></button>
            {addOpen && (
              <div className="npr-menu npr-paper-addmenu" role="menu" aria-label="添加论文">
                <button type="button" role="menuitem" onClick={() => { setAddOpen(false); setDialog('import'); }}>
                  <Icon name="file-text" size={15} />
                  <span className="npr-paper-additem"><b>按编号 / DOI 导入</b><small>arXiv 编号、DOI、链接或论文标题</small></span>
                </button>
                <button type="button" role="menuitem" onClick={() => { setAddOpen(false); setDialog('search'); }}>
                  <Icon name="search" size={15} />
                  <span className="npr-paper-additem"><b>搜索 arXiv</b><small>按关键词找，挑一条再入库</small></span>
                </button>
                <button type="button" role="menuitem" onClick={() => { setAddOpen(false); fileInput.current?.click(); }}>
                  <Icon name="upload" size={15} />
                  <span className="npr-paper-additem"><b>上传本地 PDF</b><small>已经下载到电脑里的论文</small></span>
                </button>
              </div>
            )}
          </div>
          <button type="button" className={`npr-icon${loading ? ' is-loading' : ''}`} title="刷新" aria-label="刷新" onClick={() => void load()}><Icon name="refresh-cw" /></button>
          {/*
            插件设置（0.88.0）。用户 2026-11-22：「论文阅读，侧边栏右上角增加进入设置的入口」。
            ★ 位置与订阅页**同一颗、同一处**（`.npr-settings-button` 自带 `margin-left:auto`
              把它推到最右）：设置管的是整个插件，不是这一页的列表 —— 在订阅页它在工具栏
              最右端，在论文页没有理由换个位置（同一件事两个位置，用户每换一页就要重找）。
            ★ 不自己渲染设置页：`SettingsPage` 挂在 `ReaderPage` 的**三元之外**（顶层），
              所以这里只需要一个「打开」的回调；在论文页打开、关闭后仍然停在论文页。
          */}
          <button type="button" className="npr-icon npr-settings-button" title="插件设置" aria-label="插件设置"
            onClick={() => onOpenSettings?.()}><Icon name="settings" size={17} /></button>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden
            onChange={(event) => void doUpload(event.target.files?.[0])} />
        </div>

        {/* 返回摘要页（0.71.5）。
            ★ 整宽一条、贴着侧栏左右边，用强调色 —— 阅读时它是这一栏里唯一
              「离开当前这篇」的动作，混在图标行里认不出来。
            ★ 只在阅读时有：平时这一条不占位（侧栏顶部保持紧凑）。
            ★ 提示语按用户原话写「返回到摘要页」；`title` 与 `aria-label` 同一句，
              读屏与鼠标悬停看到的是同一件事。 */}
        {readingBook !== undefined && (
          <button type="button" className="npr-paper-back"
            title="返回到摘要页" aria-label="返回到摘要页"
            onClick={() => setReadingId('')}>
            <Icon name="chevron-left" size={14} />
            <span>返回摘要页</span>
          </button>
        )}

        {/* 状态筛（2026-11-13 与电子书对齐）。
            ★ 三格来自 `PAPER_STATE_FILTERS`，与 `visible` 的判据**同一份** ——
              界面写「在读」而判据只认 `reading` 时，刚导入、没打开过的论文会整批
              从这一格漏掉（改之前的写法正是这样）。
            ★ 计数**不进 chip**：这一条是 `.npr-filters-primary`（一级），按钮是
              等分 `flex: 1 1 0` + `nowrap`，多一位数字就与邻格互相压字
              （「回收站」三个字已经占满单格的内容宽）。电子书那边也是把读数写在
              状态行里、不写进 chip —— 这里照同一套，见下面那行 `.npr-status`。
            ★ 「回收站」留在同一行、同一档外观，但它是**另一个维度**（删没删，
              不是读得怎么样）：它不带状态分组，点它时上面三格全部取消按下态。
              挪成独立按钮会让筛选行多出第四种视觉，反而更像第四个状态。 */}
        <div className="npr-filters npr-filters-primary" role="group" aria-label="阅读状态">
          {PAPER_STATE_FILTERS.map(({ value, label }) => (
            <button key={value} type="button" aria-pressed={!trashView && filter === value}
              onClick={() => { setTrashView(false); setFilter(value); }}>{label}</button>
          ))}
          <button type="button" aria-pressed={trashView} onClick={() => setTrashView((value) => !value)}>回收站{trashed.length > 0 ? ` ${trashed.length}` : ''}</button>
        </div>

        {/* 读数行。与电子书的 `listHint` 同一个位置、同一句法：「筛出 / 总数 · 在读 N · 读完 N」。
            ★ 口径与 chip 同一份（`stateCounts` 用 `paperStateOf().group` 数出来），
              两处各写一遍必然漂移 —— 那时 chip 写 3、点进去只有 2 篇。
            ★ 回收站那一支换成回收站自己的读数：在回收站里报「在读 2 · 读完 1」
              说的是库里那些论文，与眼前这一列无关。 */}
        <div className="npr-status" role="status" aria-live="polite">
          {loading
            ? '正在读论文库…'
            : trashView
              ? `回收站 ${visible.length} / ${trashed.length} 篇`
              : `${visible.length} / ${papers.length} 篇 · 在读 ${stateCounts.reading} · 读完 ${stateCounts.done}`}
        </div>

        <div className="npr-paper-search">
          <input value={localQuery} onChange={(event) => setLocalQuery(event.target.value)}
            placeholder="筛标题 / 作者 / 标签" aria-label="筛选论文" />
        </div>

        {tags.length > 0 && (
          <div className="npr-paper-tagbar" role="group" aria-label="标签">
            <button type="button" aria-pressed={tagFilter === ''} onClick={() => setTagFilter('')}>全部标签</button>
            {tags.slice(0, 12).map((tag) => (
              <button key={tag.name} type="button" aria-pressed={tagFilter === tag.name}
                onClick={() => setTagFilter(tagFilter === tag.name ? '' : tag.name)}>{tag.name} {tag.count}</button>
            ))}
          </div>
        )}

        <div className="npr-paper-list">
          {/* ★ 加载中的那句搬到上面那行 `.npr-status` 了：同一个状态说两遍，
              读者会以为是两条不同的提示。 */}
          {!loading && error !== '' && <p className="npr-paper-error">{error}</p>}
          {!loading && error === '' && visible.length === 0 && (
            <p className="npr-paper-empty">
              {trashView
                ? '回收站是空的。'
                : papers.length === 0
                  ? '还没有论文。点上面的「+」，按编号 / DOI 导入、搜 arXiv、上传本地 PDF 都行。'
                  : '没有符合当前筛选的论文。'}
            </p>
          )}
          {visible.map((paper) => (
            <PaperRow key={paper.id} paper={paper} states={states} active={selected?.id === paper.id}
              trash={trashView}
              /* ★ 正在读的时候点另一行 = 直接换一篇读。
                 只改 `selectedId` 的话左栏看着能点、右侧却纹丝不动（阅读区还占着），
                 用户会以为「点坏了」。不在读的时候仍然是普通的选中。
                 ★ 换篇走 `openReader` 而不是裸 `setReadingId`：续读点是按篇冻结的
                   （`resumeAt`），裸切会把上一篇的页码带过去、或者让新的一篇从头开始。
                   顺带把「没有全文」那一篇挡在门外 —— 切过去只会得到一块空白。 */
              /* ★ 回收站里点一行只选中：那一列的操作是「恢复 / 彻底删除」，
                 顺手打开一篇待删除的论文是反的。 */
              onSelect={(item) => { setSelectedId(item.id); if (!trashView && readingBook !== undefined) void openReader(item); }}
              onRestart={restartPaper} />
          ))}
        </div>
        {importing && <p className="npr-paper-empty">正在上传…</p>}
      </aside>

      <div className="npr-resize" role="separator" aria-orientation="vertical" onPointerDown={startDrag}
        onDoubleClick={() => { setListWidth(saveSidebarWidth(SIDEBAR_WIDTH)); }} />

      {readerNode !== null ? (
        /* 与书架**同一套骨架**（`.npr-reader.npr-reader-book`）：高度链、舞台滚动、
           FAB 的定位基准全在这套类名上。整棵子树在 `readerNode` 里 `useMemo` 住，
           翻页不会让它重渲染（理由见那段「必须不随翻页重渲染」）。 */
        readerNode
      ) : (
      <section className="npr-paper-main">
        {selected === null ? (
          <>
            {/* ★ 没选中时右侧也要有一条窗口拖动行（与 RSS 欢迎页同一条类名/高度）：
                选中论文时顶部是速读卡，而说明页这一屏除了文字全是空白，没有它，
                用户在右边大面积空白处按住鼠标拖不动窗口（RSS 0.28.3 踩过）。 */}
            <div className="npr-book-toolbar" data-window-drag />
            {/*
              ★ 与书架欢迎页**同一套** `.npr-welcome*`：品牌行 / 大标题 / 三段 /
                底部统计行。三段按顺序只说一件事：「怎么加进来 → 怎么开始读 →
                打开后能干什么」，不写 pdf.js、宿主、磁盘这类内部词。
              ★ 标题读 `BRAND_TITLE` 而不是写死「论文」：三个 tab 的说明页必须
                是同一个产品的三句话，改名时只改 `brand.js` 一处。
            */}
            <div className="npr-welcome">
              <div className="npr-welcome-brand">{BRAND_TITLE}</div>
              <h2>先看摘要，再读全文</h2>
              <p className="npr-welcome-intro">
                左边是论文库。点上面的「<strong>+</strong>」：按 arXiv 编号或 DOI 导入、
                搜 arXiv 挑一条，也可以直接上传电脑里的 PDF。开放获取的会自动补全文。
              </p>
              <p className="npr-welcome-intro">
                点列表里的一篇，右边就是<strong>速读卡</strong>：标题、作者、发表在哪、
                摘要和标签。想细读，点「<strong>阅读全文</strong>」。
              </p>
              <p className="npr-welcome-intro">
                PDF 按原样显示，能翻页、找词、点参考文献跳转、划词翻译和划线；
                还能复制引用、补全元数据。论文存在本机，断网也能读。
              </p>
              {/*
                来源项按**有没有**出现（书架的 `sourceStats` 也是这么做的）：一篇论文
                都没有时，孤零零列三行「0 篇」不如不列。状态项始终在 —— 它们与来源
                正交，换不出重复。
              */}
              {!loading && (
                <div className="npr-welcome-keys">
                  {[
                    ...(welcomeStats.arxiv > 0 ? [['arXiv', `${welcomeStats.arxiv} 篇`]] : []),
                    ...(welcomeStats.alphaxiv > 0 ? [['alphaXiv', `${welcomeStats.alphaxiv} 篇`]] : []),
                    ...(welcomeStats.doi > 0 ? [['DOI', `${welcomeStats.doi} 篇`]] : []),
                    ...(welcomeStats.local > 0 ? [['本地', `${welcomeStats.local} 篇`]] : []),
                    ['有全文', `${welcomeStats.withFile} 篇`],
                    ['已在读', `${welcomeStats.reading} 篇`],
                  ].map(([key, label]) => (
                    <span key={key}><kbd>{key}</kbd><span>{label}</span></span>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <article className="npr-paper-card">
            <header>
              <h1>{selected.title}</h1>
              <p className="npr-paper-authors">{authorLine(selected.authors)}</p>
              <p className="npr-paper-venue">
                {[
                  selected.year || '',
                  selected.venue || '',
                  selected.arxivId ? `arXiv:${selected.arxivId}` : '',
                  // alphaXiv 上「没有 arXiv 编号」的那类：不写出来源，这一行只剩年份。
                  !selected.arxivId && selected.source === 'alphaxiv' ? 'alphaXiv' : '',
                  selected.doi ? `DOI ${selected.doi}` : '',
                ].filter(Boolean).join(' · ') || '来源信息待补'}
              </p>
              <div className="npr-paper-actions">
                {trashView ? (
                  <>
                    <button type="button" className="npr-paper-primary" onClick={() => void doRestore(selected)}>恢复</button>
                    <button type="button" className="npr-paper-ghost" onClick={() => setConfirmDelete(true)}>彻底删除</button>
                  </>
                ) : (
                  <>
                    {/* ★ 主按钮的文字与动作都来自 `readAction`（同一处判定）：
                        「阅读全文」/「继续阅读」/「重新阅读」三种，绝不允许
                        「写着阅读全文、点下去只是又打开一遍」这种两套说法。 */}
                    <button type="button" className="npr-paper-primary" disabled={selected.file === null}
                      title={readAction?.title || undefined}
                      onClick={() => readAction?.run()}>
                      <Icon name={readAction?.icon ?? 'book-open'} size={15} /> {readAction?.text ?? '阅读全文'}
                    </button>
                    {selected.file === null && (
                      <button type="button" className="npr-paper-ghost" disabled={busyId === selected.id}
                        onClick={() => void doDownload(selected)}>
                        <Icon name="download" size={15} /> {busyId === selected.id ? '下载中…' : '下载全文'}
                      </button>
                    )}
                    {selected.url !== '' && (
                      <a className="npr-paper-ghost" href={selected.url} target="_blank" rel="noreferrer noopener">
                        <Icon name="arrow-up-right" size={15} /> 来源页
                      </a>
                    )}
                    {/* C 档：引用与元数据补全。两颗都在「非回收站」这一支里 ——
                        回收站里的条目只该有「恢复 / 彻底删除」。 */}
                    <button type="button" className="npr-paper-ghost" disabled={metaBusy === 'bibtex'}
                      onClick={() => void doBibtex(selected)}>
                      <Icon name="copy" size={15} /> {metaBusy === 'bibtex' ? '生成中…' : '复制引用'}
                    </button>
                    <button type="button" className="npr-paper-ghost" disabled={metaBusy === 'enrich'}
                      onClick={() => void doEnrich(selected)}>
                      <Icon name="refresh-cw" size={15} /> {metaBusy === 'enrich' ? '查询中…' : '补全元数据'}
                    </button>
                    <button type="button" className="npr-paper-ghost" onClick={() => void doTrash(selected)}>
                      <Icon name="trash-2" size={15} /> 移入回收站
                    </button>
                  </>
                )}
              </div>
            </header>

            {bibtex !== null && bibtex.id === selected.id && (
              <section className="npr-paper-bibtex">
                <div className="npr-paper-bibtex-head">
                  <h2>引用 · {bibtex.key}</h2>
                  <button type="button" onClick={() => setBibtex(null)}>收起</button>
                </div>
                {/* 等宽 + 可选中：剪贴板被拒时，这里是唯一能把引用拿走的出口。 */}
                <pre>{bibtex.text}</pre>
              </section>
            )}

            {selected.file === null && !trashView && (
              <p className="npr-paper-notice">
                这篇还没有全文。开放获取的可以直接下载；出版社付费墙内的请自己下载 PDF 后点工具栏的「上传」。
              </p>
            )}
            {selected.file !== null && (
              <p className="npr-paper-notice is-ok">
                全文已在本地（{selected.file.name} · {formatBytes(selected.file.bytes)}），可以直接阅读。
              </p>
            )}

            {selected.abstract !== '' && (
              <section className="npr-paper-abstract">
                <h2>摘要</h2>
                <p>{selected.abstract}</p>
              </section>
            )}

            <section className="npr-paper-tags">
              <h2>标签</h2>
              <div className="npr-paper-taglist">
                {selected.tags.map((tag) => (
                  <span key={tag} className="npr-paper-tag is-editable">
                    {tag}
                    <button type="button" aria-label={`删除标签 ${tag}`} onClick={() => void removeTag(selected, tag)}>×</button>
                  </span>
                ))}
                <input value={tagDraft} placeholder="加标签，回车"
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    void addTag(selected, tagDraft);
                  }} />
              </div>
            </section>

            {selected.categories.length > 0 && (
              <section className="npr-paper-tags">
                <h2>arXiv 分类</h2>
                <div className="npr-paper-taglist">
                  {selected.categories.map((category) => <span key={category} className="npr-paper-cat">{category}</span>)}
                </div>
              </section>
            )}
          </article>
        )}
      </section>
      )}
    </div>

      {/*
        * 伴读「+」打开的快捷提示词面板（0.77.1）。
        *
        * ★ 为什么不复用设置页那张卡：论文页根本没有设置页（`LibraryApp` 才有
        *   `setSettingsEntry`），把用户往一个不存在的页面送就是这颗按钮一直
        *   「点了没反应」的成因。这里就地开一层，改完立刻能用。
        * ★ 外壳复用导入/搜索论文那套 `npr-paper-modal`：同一页里两个浮层长得
        *   不一样，用户会以为是两个不同的东西。
        * ★ `key` 带 `add`：从「+」进来要直接是新增表单，从别处进来是清单。
        *   不给 key 的话 `startAdding` 只在首次挂载生效，第二次点「+」就只剩清单。
        */}
      {promptsOpen !== null && (
        <div className="npr-paper-modal" role="dialog" aria-modal="true" aria-label="论文快捷提示词"
          onClick={() => setPromptsOpen(null)}>
          <div className="npr-paper-modal-card npr-prompts-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="npr-paper-modal-head">
              <strong>论文快捷提示词</strong>
              <button type="button" className="npr-icon" aria-label="关闭" onClick={() => setPromptsOpen(null)}><Icon name="x" size={15} /></button>
            </div>
            <p className="npr-paper-modal-hint">显示在论文伴读的输入框上方，点击后直接发送。改完立刻生效，不用退出这篇论文。</p>
            <PromptManager key={promptsOpen.add ? 'add' : 'list'} notify={notify}
              scope="paper" startAdding={promptsOpen.add} />
          </div>
        </div>
      )}

      {dialog !== '' && (
        <PaperDialog
          mode={dialog}
          notify={notify}
          onClose={() => setDialog('')}
          onSearch={(query) => searchPapers(query)}
          onImport={async (input) => {
            const body = await importPaper(input);
            await load();
            setSelectedId(body.paper.id);
            return body;
          }}
        />
      )}

      {/* 彻底删除的确认（0.84.7）：逐字说出「PDF 一起删、不能撤销」，
          按钮用危险色，而不是一个和普通按钮同款、点一下就没了的东西。 */}
      {confirmDelete && selected && (
        <Modal label="彻底删除论文" onClose={() => setConfirmDelete(false)}>
          <h2>彻底删除《{selected.title}》？</h2>
          <p>这会同时删掉本机保存的 PDF，且 <strong>不能撤销</strong> —— 回收站里不会留副本。</p>
          <div className="npr-modal-actions">
            <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
            <button type="button" className="npr-wipe-go"
              onClick={() => { setConfirmDelete(false); void doDelete(selected); }}>彻底删除</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
