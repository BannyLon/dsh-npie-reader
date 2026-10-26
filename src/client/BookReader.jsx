/**
 * 电子书阅读器：pdf.js 渲染**原版版式**（不重排、不转文本）。
 *
 * 七个刻意的设计：
 *
 * 1. **只渲染当前页**。一次渲染整本会让打开一本 30 MB 的书卡住十几秒，而用户
 *    99% 的时间只在看一页。
 * 2. **缩放是「基准 × 倍数」**。基准由**适宽 / 整页适应窗口**两态决定，倍数由
 *    「−/+」调。直接给绝对 scale 的话，同一本书在不同宽度的面板里默认大小完全
 *    不同；用户会觉得「有时候大有时候小」却找不到原因。
 * 3. **自适应是真的自适应**。尺寸靠 `ResizeObserver` 量（窗口缩放、拖分隔条、
 *    开关伴读面板都会重算），而不是在渲染那一帧读一次 —— 后者在窗口变化时
 *    页面**不会跟着变**，看起来就是「不生效」。
 * 4. **窗口拖动时先改 CSS、停手再重画位图**。每帧重画一页会让拖动明显发涩；
 *    先只改画布的显示尺寸，视觉上立刻跟手（略糊），停手 160ms 后补一次清晰渲染。
 * 5. **不支持的格式说清楚是什么格式、在哪儿能找到它**，而不是给一个通用的
 *    「打不开」。书架里有 31 本非 PDF（epub / mobi / docx…），它们不是坏了，
 *    只是本插件还没有对应的渲染器。
 * 6. **新的一页先在离屏画布上画好、成功了再整体贴上来**。给 canvas 赋宽度会
 *    立刻丢位图，而「准备渲染」到「渲染完成」之间可能隔着一次网盘取字节 ——
 *    直接画可见画布的话，那段空窗期就是一片白。
 * 7. **文档由会话级缓存持有，不随本组件卸载而销毁**。宿主用 `key={book.id}`
 *    挂本组件，换书等于卸载重挂；跟着组件销毁的话，点回刚看过的书又要重新
 *    「正在取书…」。
 *
 * ★ 本文件里**一个 `tabIndex` 都不能有**：`.npr-book-toolbar` 是窗口拖动行，
 *   宿主对拖动区做的是「先求并、再把 no-drag 矩形**求差**」，任何祖先带上
 *   `tabindex` 都会把整块拖动区减掉（详见 test/window-drag.test.mjs）。
 *   键盘快捷键走 window 级监听，不需要容器可聚焦。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FIND_LIMIT_MAX, findOccurrences, normalizeNeedle, pageIndexText, snippetOf } from '../book-find.js';
import { formatBytes, progressPercent, stateOf } from '../library.js';
import { BookCompanion } from './BookCompanion.jsx';
import { AnnotationPanel } from './AnnotationPanel.jsx';
import { BookDigestPanel } from './BookDigestPanel.jsx';
import { BookFindPanel } from './BookFindPanel.jsx';
import { DigestCard } from './DigestCard.jsx';
import { Icon } from './icons.jsx';
import { forgetBook, loadPdfjs, openCachedBook } from './pdfjs.js';
import {
  fetchAnnotations, fetchChapterDigest, fetchDigestStatus, fetchOcrPage, ocrBookPage,
  postAnnotation, postDigestGenerate,
  postDigestPages, postDigestSegment, postDigestStop, resetDigest, saveBookState,
} from './library-api.js';
import {
  anchorOfRange, annotationsOnPage, coveringAnnotation, normalizeAnnotations,
  rangeOfAnchor, rectsOfRange, textNodesOf,
} from './annotations.js';
import { extractBookPages, planDigestRun, resolveOutline } from './book-digest.js';
import {
  BOOK_BRIGHTNESS, BOOK_TINTS, nextBookTint, normalizeBookBrightness, normalizeBookTint,
} from '../reading-settings.js';
import { layerScaleRatio, quoteBarLeft, quoteBarPlacement, selectionQuote, textLayerMetrics } from './book-text.js';
import { insidePanel, peekNext, peekOnLeave } from './book-peek.js';
import {
  FIT_PAGE, FIT_WIDTH, NO_COMMAND, WHEEL_FLIP_COOLDOWN_MS, WHEEL_FLIP_DELTA,
  ZOOM_MAX, ZOOM_MIN, contentBox, createFabHover, displayScale, extractPageText, fabStack, readerCommand,
  stepZoom, wheelIntent,
} from './book-view.js';

/**
 * 尺寸/缩放变化后隔多久重画位图。
 *
 * 太短 ⇒ 拖动窗口时每帧都在重画（发涩）；太长 ⇒ 停手之后有一段明显的模糊期。
 * 160ms 在真机上刚好落在「拖动结束到视觉注意到糊」之间。
 */
const REDRAW_DEBOUNCE_MS = 160;

/**
 * 送去 OCR 的那张位图按多少 DPI 渲染。
 *
 * ★ 不能用屏幕上那张画布：它是「适应宽度」画出来的，900px 宽的面板里只有 ~110 DPI，
 *   实测这个分辨率下笔画密的字会掉（「繁」「藏」这类）。200 DPI 是实测的平衡点：
 *   1653×2339 的一页 JPEG 约 300–900 KB，Vision 0.6–0.8 秒认完，中文几乎无误。
 */
const OCR_RENDER_DPI = 200;

/**
 * 自动识别前等多久（毫秒）。
 *
 * ★ 700 ms 是「翻页停下来了」与「不用等太久」的折中。按住翻页键会连翻十几页，
 *   不延迟的话每一页都要渲染一张 200 DPI 位图、起一个 `osascript` 子进程 ——
 *   而用户其实只想看最后一页。
 */
const OCR_AUTO_DELAY_MS = 700;


/** 页码输入的合法范围与它对应的提示。 */
function clampPage(value, numPages) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.round(value), 1), numPages);
}

/**
 * 懒建离屏画布。
 *
 * 整个组件生命周期复用**一块**：每页新建会让 GC 频繁回收 2×DPR 下几 MB 的位图，
 * 而翻页本来就是连续操作，复用没有代价。
 */
function offscreenOf(ref) {
  if (ref.current === null) ref.current = document.createElement('canvas');
  return ref.current;
}

/**
 * 模型列表的**会话级缓存**。
 *
 * ★ 为什么必须缓存：宿主那个 `listAiModels` 是**逐个 provider** 去问的（每个 8 秒
 *   超时，可能真的发一次网络请求 —— 模型发现）。目录面板每打开一次就问一遍，等于
 *   用户每翻一次目录都要等一次网络。
 *
 * ★ 为什么放在模块级而不是组件 state：`BookReader` 由 `LibraryApp` 用 `key={book.id}`
 *   挂着，换一本书就卸载重挂 —— 放在组件里等于「每本书都重新问一次」。
 *
 * ★ 为什么**失败不缓存**：模型列表读不到多半是某个 provider 的 key 没配好，用户
 *   修好之后应该能立刻重试成功。缓存失败结果会让他只能重启窗口，而界面上没有任何
 *   东西提示这一点。
 */
let modelCatalogCache = null;

/** 取模型列表；成功结果缓存，失败结果下一次重试。**永不 reject**（错误进 `error` 字段）。 */
function loadModelCatalog(api) {
  if (modelCatalogCache !== null) return Promise.resolve(modelCatalogCache);
  return api.listAiModels().then(
    (value) => { modelCatalogCache = value ?? { providers: [], current: null }; return modelCatalogCache; },
    (error) => ({ providers: [], current: null, error: String(error?.message ?? error) }),
  );
}

export function BookReader({
  book, reading, states, onPageChange, onFinished, notify,
  api, SessionProvider, renderSlot, onManagePrompts, onScannedChange,
  /**
   * 沉浸态变化时通知外层（`LibraryApp`）。外层据此把书架那一列（`.npr-sidebar`）
   * 一起藏起来 —— 用户对沉浸的定义是「左边两列都不显示，只显示阅读页」，
   * 而左边第二列在**本组件的祖先**里，只有外层改得动。
   */
  onImmersiveChange,
}) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [doc, setDoc] = useState(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  /** 缩放基准：`FIT_WIDTH` 适宽 / `FIT_PAGE` 整页适应窗口。 */
  const [mode, setMode] = useState(FIT_WIDTH);
  /** 手动倍数（相对当前基准，1 = 基准本身）。 */
  const [zoom, setZoom] = useState(1);
  /**
   * 沉浸式阅读：**只留书页** —— 元信息行藏掉、右下角那颗浮动按钮隐到全透明
   * （鼠标回到那个角就恢复），舞台内边距收到最小。
   *
   * ★ **不持久化**（与 `tint` 相反）：用户点一次沉浸是为了「现在专心读完这一章」，
   *   不是「以后每次打开书都别让我看到按钮」。持久化下去，下次打开一本新书会得到
   *   一个没有可见入口的界面 —— 而那个界面上唯一能退出沉浸的东西恰好是被隐掉的
   *   那颗按钮。
   * ★ 隐到 0 而不是压到 0.1（0.20.6 的做法）：用户对这一档的要求是「只显示这部分
   *   内容」，留一层半透明残影就还是「显示了别的东西」。敢隐到 0 是因为出口不止一个：
   *   Esc / I 键，以及**进去时主动弹的那句提示**（见 `toggleImmersive`）。
   */
  const [immersive, setImmersive] = useState(false);
  /**
   * 沉浸态：指针靠近面板顶边时胶囊滑出（0.25.4）。
   * ★ 不能只写 CSS `:hover`：热区 `.npr-book-toolbar` 是宿主的窗口拖动条
   *   （`-webkit-app-region: drag`），Chromium 当标题栏命中 ⇒ 页面收不到鼠标事件，
   *   `:hover` 永不成立，胶囊滑出去就回不来（用户报的真机故障）。
   */
  const [peek, setPeek] = useState(false);
  /** 书页配色（`paper` / `sepia` / `mint` / `night`）。**持久化**，它是一项阅读偏好。 */
  const [tint, setTint] = useState('paper');
  /** 书页亮度（1 = 不调）。与配色分开：色温和明度是两件事，见 `reading-settings.js`。 */
  const [brightness, setBrightness] = useState(1);
  /**
   * 右下角那颗浮动按钮：`true` = 那一列翻页/缩放正摊开着。
   *
   * ★ **悬停即展开**（0.24.3，用户：「鼠标移到图标上就弹出，不要点击」）。
   *   0.23.0 曾改成纯点击，理由是「按钮与第一格之间有空隙，`:hover` 掉在空隙里整列就
   *   回收」—— 那个观察是对的，**结论错了**：空隙问题是「没有宽限期」造成的，
   *   不是「hover 展开在这个几何里不成立」。现在离开整棵子树后先等
   *   `FAB_HOVER_GRACE` 再收，指针越过空隙或落到某一格上都会把定时器取消。
   * ★ 点击**仍然保留**（触屏与键盘没有 hover）：点一下是「钉住 / 收起」的显式开关，
   *   键盘用户 Tab 到按钮后回车也能开。
   * ★ 仍然**不持久化**：下次打开书默认收起，否则第一眼就是一列盖在书页上。
   */
  const [fabOpen, setFabOpen] = useState(false);
  const fabRef = useRef(null);
  /** 配色面板（从浮动按钮的列表里点「配色」打开）。 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 舞台可用内容区，由 `ResizeObserver` 维护。 */
  const [box, setBox] = useState(null);
  /**
   * 整个阅读面板（`.npr-book`）的尺寸。
   *
   * ★ 与 `box` 分开量：`box` 是**舞台**的内容盒（缩放的依据），`frame` 是**面板**外框
   *   （浮动按钮的定位基准）。开着划线面板时两者差 306px，拿舞台宽度去算浮动列表
   *   能折几列会**少算一整栏** —— 结果是一列到底、底部溢出，而溢出的按钮点不到。
   */
  const [frame, setFrame] = useState(null);
  /** 当前页在 scale=1 下的尺寸（来自 pdf.js viewport），用于算缩放与「先改 CSS」。 */
  const [base, setBase] = useState(null);
  const [pageDraft, setPageDraft] = useState('1');
  /** 重试计数器：打开文档的 effect 依赖它，否则点「重试」时依赖没变、effect 不会重跑，
   *  界面会一直停在错误态（看起来像「重试按钮坏了」）。 */
  const [attempt, setAttempt] = useState(0);
  const [companion, setCompanion] = useState(false);
  /** 目录面板。★ 与伴读**互斥占同一格**，不开第三列（正文宽度是用户读字用的）。 */
  const [digestOpen, setDigestOpen] = useState(false);
  const [digestMeta, setDigestMeta] = useState(null);
  const [digestOutline, setDigestOutline] = useState([]);
  /** 抽取任务：`{ running, done, total, phase, error }`。null = 没在跑。 */
  const [digestJob, setDigestJob] = useState(null);
  const digestAbort = useRef(null);
  /** 用 ref 而不是读 `digestJob.running` 做守卫：读 state 会让 `startDigest` 的依赖
   *  每次进度变化都重建，而它在 `useEffect` 里被引用 ⇒ 抽取会被自己打断。 */
  const digestRunning = useRef(false);
  /**
   * 逐章生成解读：`true` 时轮询 `status`。
   *
   * ★ 这个布尔**不是**客户端自己说了算：点「生成」时乐观置 true，但每一轮
   *   轮询都以宿主回的 `generating` 为准。否则关掉面板再打开（或换本书再换回来）
   *   会出现「宿主在跑、界面以为没跑」—— 进度条永远停在 0。
   */
  const [digestGenerating, setDigestGenerating] = useState(false);
  /** 已取回的解读：`n → { status: 'loading'|'ready'|'error', digest?, error? }`。按需取，不预载全书。 */
  const [digestChapters, setDigestChapters] = useState({});
  /** 当前展开要点的章号（0 = 都没展开）。同一时刻只展开一章 —— 浮层只有一张。 */
  const [expandedN, setExpandedN] = useState(0);
  /**
   * 勾选要解读的章号；**`null` = 还没动过手**，此时按「所有待生成的章」算（见 `planDigestRun`）。
   *
   * ★ 为什么用 `null` 表示默认，而不是在 effect 里初始化成一份数组：
   *   `meta` 是轮询刷新的，初始化式 effect 会在每次状态变化后把用户手动改过的勾选
   *   悄悄重置回「全选」。`null` 是**派生**的（渲染时现算），永远不会和 `meta` 打架。
   * ★ 一批生成结束时会被显式置回 `null`：否则跑完之后那几章变成 `done`，而勾选里
   *   还留着它们，用户再点一次按钮就会把刚生成的解读**重跑一遍**（再花一次钱）。
   */
  const [selectedN, setSelectedN] = useState(null);
  /** 这一次用哪个模型（`null` = 设置还没读到；`''` = 跟随 Harness 默认模型）。 */
  const [digestModel, setDigestModel] = useState(null);
  /** `listAiModels` 的结果；`null` = 还在读。 */
  const [modelCatalog, setModelCatalog] = useState(null);
  /** 当前页抽出来的文字（给伴读当上下文）；`page` 是它属于哪一页，防止跨页错配。 */
  const [pageTextState, setPageTextState] = useState(null);
  /**
   * 本地 OCR 认出来的那一页文字（扫描版专用）。
   *
   * ★ 与 `pageTextState` **分开存**：那一份是「PDF 自己的文字层」，这一份是「我们
   *   自己认出来的」，两者的可信度不同（前者逐字精确、后者可能有个别错字）。
   *   合成一个状态的话，「这一页到底有没有文字层」就再也答不出来了 ——
   *   而那正是「要不要显示『识别这一页』」的判据。
   * ★ 带 `page`：翻页时旧结果必须立刻失效，否则伴读会拿上一页的识别结果回答这一页。
   */
  const [ocrState, setOcrState] = useState({ page: 0, text: '' });
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState('');
  /**
   * ★ 光有 `ocrBusy` 挡不住**同一帧内的第二次点击**：React 的 `setState` 要到下一帧
   *   才刷新闭包里的 `ocrBusy`，两次点击在同一帧里都能读到 `false` ⇒ 会并行起两个
   *   200 DPI 渲染 + 两次 osascript（每个都要 0.7 秒、几百 KB 的 payload）。
   *   必须再加一个 ref 做同步闸门。
   */
  const ocrBusyRef = useRef(false);
  /**
   * 已经**自动**试过的页（`Set<number>`）。
   *
   * ★ 为什么需要它：自动识别失败后（纯图片页、组件缺失），`ocrNeeded` 仍然是 true，
   *   于是那个 effect 会一直重跑 —— 每翻回来一次就再起一个子进程、再糊一次错误。
   *   记一笔之后，同一页只自动试一次；想再试由用户点按钮（那一次会显示错误）。
   */
  const ocrAutoTriedRef = useRef(new Set());
  /**
   * 「这一页有没有文字、要不要识别」这一组派生量。
   *
   * ★ 它们**必须定义在这里**（OCR 状态的旁边），不能留在组件末尾：自动识别那个
   *   `useEffect` 要把 `ocrNeeded` 放进依赖数组，而依赖数组是在**渲染到那一行时**
   *   求值的。留在下面的话，`useEffect(...)` 先执行、`const ocrNeeded` 还没初始化
   *   ⇒ `Cannot access 'ocrNeeded' before initialization`，整个阅读页白屏。
   *   （而且下面还有一个 `status === 'unsupported'` 的提前 return，hook 不能放到它后面。）
   */
  const textLoaded = pageTextState !== null && pageTextState.page === page;
  /**
   * 伴读该看到的那一页文字：**优先用 PDF 自己的文字层**，没有才用 OCR 认出来的。
   *
   * ★ 顺序不能反。文字层是逐字精确的（连标点、脚注编号都对），OCR 一定有个别错字；
   *   只有在文字层为空（扫描版）时 OCR 才是唯一来源。
   * ★ OCR 结果必须**同一页**才算（`ocrState.page === page`）：翻页后旧结果立刻失效，
   *   否则伴读会拿第 60 页的识别结果去回答第 61 页 —— 那是最难被发现的一类错。
   */
  const pageText = textLoaded ? pageTextState.text : '';
  const ocrText = ocrState.page === page ? ocrState.text : '';
  const contextText = pageText.trim() !== '' ? pageText : ocrText;
  /** 扫描页且还没识别：这才是「该给用户一个『识别这一页』按钮」的时刻。 */
  const ocrNeeded = textLoaded && pageText.trim() === '' && ocrText.trim() === '';
  /**
   * 这一页的文字是**本机识别**出来的（不是 PDF 自带的文字层）。
   *
   * ★ 单独一路传给伴读面板，只为了让它把那句话说准。不区分的话，识别成功之后
   *   面板显示的是「已带上这一页的文字」—— 与文字层的情况**一字不差**，而这两件事
   *   的可靠性差一个量级（OCR 一定有错字，而错字恰恰是「AI 引用了错原文」的源头）。
   *   用户需要知道自己在看哪一种。
   */
  const ocrUsed = pageText.trim() === '' && ocrText.trim() !== '';
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  /** 面板根节点：只用来量 `frame`（浮动按钮的定位基准，见上面 `frame` 的注释）。 */
  const bookRef = useRef(null);
  /** 文字层。它有字，但每个字都是透明的 —— 看得见的是下面的画布位图。 */
  const textLayerRef = useRef(null);
  /** 画布上这一页是用哪个 scale 画出来的（拖窗口时给文字层算临时缩放）。 */
  const renderedScaleRef = useRef(0);
  /** 当前页的 TextLayer 句柄：换页/卸载时要 `cancel()`，否则它的异步续块会写进新容器。 */
  const textLayerTaskRef = useRef(null);
  /** 已装载的 pdf.js 模块 —— 文字层要用它的 `TextLayer` 构造器。 */
  const pdfjsRef = useRef(null);
  /**
   * 划词气泡：`{ text, top, bottom, centerX, layerHeight }`，`null` = 不显示。
   * ★ 与「传给伴读的引文」是**两份** state，不能合并：气泡会随着点别处消失，
   *   而伴读那一份必须留着 —— 否则用户点完「问伴读」再点一下页面，模型看到的
   *   上下文就被抽走了。
   */
  const [quote, setQuote] = useState(null);
  /**
   * 气泡出现时量好的**字符偏移**。
   *
   * ★ 为什么不在点「划线」那一刻现算：点按钮时 `mousedown` 会让浏览器把选区收掉，
   *   等 `onClick` 里再 `getSelection()` 常常已经拿不到 range ⇒ 每条都报「这段选不中」。
   *   所以偏移跟着气泡一起算、一起失效（见下面 `selectionchange` 那段）。
   */
  const quoteAnchorRef = useRef(null);
  const [companionQuote, setCompanionQuote] = useState('');
  /**
   * 这本书的全部划线 / 笔记（服务端是唯一真相，这里只存它回过来的那一份）。
   *
   * ★ `annotations` 与 `markRects` 是**两份** state：
   *   - `annotations` 是数据（页码 + 字符偏移 + 摘录 + 笔记 + 颜色）；
   *   - `markRects` 是**这一页、这个缩放下的像素矩形**，渲染用。
   *   合并的话，每滚一次/缩一次都要重算整本的数据，而且矩形的失效条件（缩放、
   *   换页、文字层重排）与数据的失效条件（写了笔记、删了划线）完全不同。
   */
  const [annotations, setAnnotations] = useState([]);
  const [markRects, setMarkRects] = useState([]);
  const [marksOpen, setMarksOpen] = useState(false);
  /** 打开面板时要立刻进入编辑的那一条（「划了线顺便写一句」用）。 */
  const [markFocusId, setMarkFocusId] = useState('');

  /**
   * 书内搜索（0.26.0）。
   *
   * ★ PDF 没有「全书正文」可取 —— 正文是 pdf.js 逐页铺出来的文字层。所以检索的
   *   第一步是**给每一页建一次索引**：`getTextContent()` → `pageIndexText()`。
   *   结果按页缓存在 `findTexts` 里（一本 500 页的书首次约几秒，之后改词再搜是毫秒级）。
   *   缓存**不跨组件**：`LibraryApp` 用 `key={book.id}` 挂本组件，换书就是重挂，
   *   缓存跟着走 —— 这比往磁盘写一份「正文副本」更诚实（那份副本迟早与书对不上）。
   * ★ `findActive === -1` 是默认值：搜到了但还没跳。见 `BookEbook` 里同名 state 的说明。
   * ★ `findRects` 与 `markRects` 同理：数据（页号 + 页内偏移）与像素矩形分开，
   *   矩形的失效条件是「换页 / 缩放 / 文字层重排」。
   */
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  /**
   * `textlessPages` 是 `textless` 的**明细**：只知道「有 187 页没搜」不够，
   * 要补就得知道是哪 187 页。两者同时留着是因为前者进文案、后者进 OCR。
   */
  const [findState, setFindState] = useState({
    status: 'idle', error: '', done: 0, total: 0, textless: 0, textlessPages: [], truncated: false,
  });
  const [findHits, setFindHits] = useState([]);
  const [findActive, setFindActive] = useState(-1);
  const [findRects, setFindRects] = useState([]);
  /** 页 → 检索文本（`''` = 这一页没有文字层，扫描页）。`undefined` = 还没建索引。 */
  const findTexts = useRef(new Map());
  /**
   * 哪些页的文字**是识别出来的**（`findTexts` 里那一份来自 OCR，不是文字层）。
   *
   * ★ 必须分开记：OCR 一定有错字，而命中列表里那句摘录是用户判断「是不是我要找的」
   *   的唯一依据 —— 不标出来，他会以为书上是这么写的。
   */
  const findOcrVia = useRef(new Set());
  /**
   * 批量识别（补救扫描页）的状态。
   *
   * ★ `note` 是**结果说明**（认出几页 / 几页没认出），不是错误：一条都没认出时
   *   它不是「失败」而是「这些页确实没有字」—— 纯图片页就长这样。
   */
  const [findOcr, setFindOcr] = useState({ running: false, done: 0, total: 0, note: '' });
  const findOcrCancel = useRef(false);
  /**
   * 识别完之后**让它 +1**，把检索那个 effect 重新跑一遍。
   *
   * ★ 不这么做就得在这里手写一遍「重搜」，而那等于第二条检索链路 ——
   *   两个循环迟早会在「上限 / 截断 / 进度节流」上分叉。
   */
  const [findRerun, setFindRerun] = useState(0);
  /** 检索令牌：新查询 / 关面板 / 换书都会让它变，旧循环看到不一致就停。 */
  const findRun = useRef(0);
  /** 当前生效的检索词（小写）。渲染命中矩形的时候要用，而那时 `findQuery` 可能已经变了。 */
  const findNeedle = useRef('');
  /** 上次滚动到的位置（`page:findActive`），同一个位置只滚一次。 */
  const findScrollKey = useRef('');

  /**
   * 点「搜索」：与其它侧栏互斥地打开；再点一次收起。
   *
   * ★★ **必须定义在键盘 effect 之前**（0.26.0 实测踩到）：`useCallback` 的依赖
   *   数组是在**渲染期**求值的，而键盘那个 `useEffect` 的依赖里写着 `toggleFind`。
   *   定义在后面 ⇒ `Cannot access 'toggleFind' before initialization`，一打开
   *   阅读器就白屏 —— 与文件里「两个回调必须定义在键盘 effect 之前」同一类。
   * ★ 这里**直接关目录**（`setDigestOpen(false)` + `setExpandedN(0)`）而不是调
   *   `closeDigest()`：那个回调同样定义在键盘 effect 之后，原因同上。
   */
  const toggleFind = useCallback(() => {
    if (findOpen) { setFindOpen(false); return; }
    setDigestOpen(false);
    setExpandedN(0);
    setMarksOpen(false);
    setMarkFocusId('');
    setCompanion(false);
    setFindOpen(true);
  }, [findOpen]);
  /**
   * 文字层的版本号：每次一页的文字层**渲染完成**就 +1。
   *
   * ★ 高亮靠 Range 量矩形，而 Range 必须先有真实的文本节点。文字层是异步渲的，
   *   `page` / `zoom` 变化时（那一刻容器还是空的）就去量，只会得到 0 个矩形 ——
   *   症状是「翻到下一页，划线不见了，再翻回来又出现」。所以必须等这一页的
   *   文字层真的渲完再算，而「渲完了」这件事只能由那个 effect 自己上报。
   */
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  /** 渲染任务与文档的存活句柄：换页/换书/卸载时必须显式取消，否则会叠影。 */
  const renderRef = useRef(null);
  const docRef = useRef(null);
  /**
   * 离屏画布：新一页先画在它上面，成功了再整体贴到可见画布。
   *
   * ★ 为什么不能直接画在可见画布上：pdf.js 要求画布尺寸与 viewport 一致，
   *   所以「开始渲染」那一步必须先 `canvas.width = …` —— 而给 canvas 赋宽度会
   *   **立刻丢弃当前位图**。从那一刻到渲染完成之间（首次访问某页还要先去网盘取
   *   那几段字节，可能几百毫秒到几秒）画布是全白的，用户滚动一下就会看到
   *   「什么都没有的页面」。走离屏之后，这段等待期里可见画布上仍然是上一页。
   */
  const offscreenRef = useRef(null);
  /** 画布上**当前真正画出来的是哪一页**（换页要立刻画，改尺寸可以等）。 */
  const renderedPageRef = useRef(0);
  /** 已经上报过进度的页码：缩放变化会重画同一页，不该反复写盘。 */
  const reportedPageRef = useRef(0);
  /** 画完这一页之后把滚动位置放到哪儿（`top` / `bottom`）。 */
  const pendingScrollRef = useRef(null);
  const wheelAccRef = useRef(0);
  const wheelAtRef = useRef(0);

  const current = stateOf(states, book.id);
  const percent = progressPercent(current);
  const supported = book.renderable === true;

  // ---- 打开文档 --------------------------------------------------------
  /**
   * ★★ 两件曾经把整个阅读器打崩的事，都在这段里 ★★
   *
   * 一、**清理路径不许抛错。** 旧写法在 cleanup 里对文档代理调 `destroy()`，
   *     而 pdf.js 6.4.299 的 `PDFDocumentProxy` **没有** `destroy`（详见
   *     `pdfjs.js` 开头那段）。cleanup 是 React 提交阶段跑的，那里同步抛出的
   *     `TypeError: loaded.destroy is not a function` 会被 Error Boundary 接住 ⇒
   *     换一次书，整个阅读器就变成「阅读器页面加载失败」。现在销毁走缓存提供的
   *     `task.destroy()`，并且那一层**全程吞错**。
   *
   * 二、**文档不随组件卸载而销毁。** `LibraryApp` 用 `key={selected.id}` 挂阅读器，
   *     换书就是卸载重挂；旧写法一卸载就丢文档，于是每点一次同一本书都要重新
   *     「正在取书…」。现在文档由 `pdfjs.js` 的会话级缓存持有（LRU 3 本），
   *     点回刚看过的书是**立即**出现的。
   */
  useEffect(() => {
    if (!supported) { setStatus('unsupported'); return undefined; }
    let cancelled = false;
    setStatus('loading');
    setError('');
    setDoc(null);
    setNumPages(0);
    setBase(null);
    setZoom(1);
    setMode(FIT_WIDTH);
    setPageTextState(null);
    renderedPageRef.current = 0;
    reportedPageRef.current = 0;
    setQuote(null);
    setCompanionQuote('');
    setMarksOpen(false);
    setMarkFocusId('');
    setMarkRects([]);
    // 换书 / 重试 = 上一本的索引与命中一处都不能留（页号与偏移都指向另一本书）。
    findRun.current += 1;
    findTexts.current.clear();
    findOcrVia.current.clear();
    // 换书时把还在跑的批量识别停掉：页码是**按书**的，让它接着跑会把 A 书的
    // 识别结果写进 B 书的页号上（宿主的 ocr.json 就是按 bookId + page 存的）。
    findOcrCancel.current = true;
    setFindOcr({ running: false, done: 0, total: 0, note: '' });
    findNeedle.current = '';
    findScrollKey.current = '';
    setFindOpen(false);
    setFindQuery('');
    setFindHits([]);
    setFindActive(-1);
    setFindRects([]);
    setFindState({
      status: 'idle', error: '', done: 0, total: 0, textless: 0, textlessPages: [], truncated: false,
    });

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        pdfjsRef.current = pdfjs;
        const { doc: loaded } = await openCachedBook(pdfjs, {
          bookId: book.id,
          length: book.size,
          onError: (cause) => {
            if (cancelled) return;
            setError(cause?.message ?? '取书失败');
            setStatus('error');
          },
        });
        if (cancelled) return;
        docRef.current = loaded;
        setDoc(loaded);
        setNumPages(loaded.numPages);
        // 回到上次读到的那一页。页码可能超出（换过文件版本），夹一下。
        const resume = clampPage(current.page || 1, loaded.numPages);
        setPage(resume);
        setPageDraft(String(resume));
        setStatus('ready');
      } catch (cause) {
        if (cancelled) return;
        setError(cause?.message ?? String(cause));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      // 只取消**这一帧的渲染任务**与本次的上报；文档留给缓存复用。
      renderRef.current?.cancel?.();
      renderRef.current = null;
      docRef.current = null;
    };
    // `current.page` 只在**换书**时读一次（它是恢复点，不是受控值）—— 放进依赖会让
    // 翻页反过来重开文档。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, supported, attempt]);

  // ---- 量舞台（自适应）-------------------------------------------------
  /**
   * ★ 量尺寸这件事**必须由 `ResizeObserver` 驱动**，不能在渲染那一帧读一次：
   *   渲染 effect 的依赖里没有「窗口尺寸」，窗口一变页面就不会重算 —— 那正是
   *   「自适应不生效」的真身。首帧也读不到（布局还没跑），所以这里先量一次、
   *   再交给观察器兜住后续所有变化（窗口缩放、拖分隔条、开关伴读面板）。
   *
   * ★ 取值用 `clientWidth/clientHeight` 减 padding（见 book-view.contentBox）：
   *   舞台是滚动容器，`getBoundingClientRect()` 会把滚动条算进宽度。
   *   CSS 里另有 `scrollbar-gutter: stable`，让滚动条的出现不会改变可用宽度
   *   （否则「适应宽度」会在有无滚动条之间来回微调，看起来像抖动）。
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = () => {
      if (stage.clientWidth === 0 && stage.clientHeight === 0) return;
      const style = getComputedStyle(stage);
      const next = contentBox({
        clientWidth: stage.clientWidth,
        clientHeight: stage.clientHeight,
        paddingLeft: parseFloat(style.paddingLeft) || 0,
        paddingRight: parseFloat(style.paddingRight) || 0,
        paddingTop: parseFloat(style.paddingTop) || 0,
        paddingBottom: parseFloat(style.paddingBottom) || 0,
      });
      // 只在**真的变了**的时候写 state：ResizeObserver 在拖动时会连发，
      // 每帧都造一个新对象会让下游 effect 每帧重跑一次。
      setBox((previous) => (
        previous !== null && previous.width === next.width && previous.height === next.height ? previous : next
      ));
      /**
       * 面板外框：浮动按钮的定位基准是**它**，不是舞台。
       * ★ 用 `getBoundingClientRect()` 而不是 `clientWidth/Height`：`.npr-book`
       *   不是滚动容器（滚的是里面的舞台），没有滚动条要排除；而 `rect` 的
       *   小数部分正是 FAB 那个 `right/bottom: 14px` 的同一个坐标系。
       */
      const panel = bookRef.current;
      if (panel !== null) {
        const rect = panel.getBoundingClientRect();
        /**
         * 面板顶到**舞台顶**的距离：拖动条 + 胶囊那一行 + 元信息行的总高。
         *
         * ★ 浮动列必须知道这个数：它从右下角往上排，排到上面就会**压住胶囊**。
         *   只看面板高度的话，420px 高的面板里最上面那格正好顶到胶囊底边
         *   （实测 44 vs 89，压了 45px）。压住之后那几格是**盖在胶囊上面**的
         *   （FAB 的 `z-index: 40` 高于胶囊的 30），于是被盖住的胶囊按钮点不到。
         */
        const stageTop = stage.getBoundingClientRect().top;
        const topInset = Math.max(0, Math.round(stageTop - rect.top));
        setFrame((previous) => (
          previous !== null && Math.abs(previous.width - rect.width) < 0.5
            && Math.abs(previous.height - rect.height) < 0.5
            && previous.top === topInset
            ? previous
            : { width: rect.width, height: rect.height, top: topInset }
        ));
      }
    };
    measure();
    if (typeof globalThis.ResizeObserver !== 'function') return undefined;
    const observer = new globalThis.ResizeObserver(measure);
    observer.observe(stage);
    if (bookRef.current !== null) observer.observe(bookRef.current);
    return () => observer.disconnect();
  }, []);

  // ---- 先改 CSS：让缩放/尺寸变化立刻跟手 --------------------------------
  /**
   * 只写画布的**显示尺寸**，不动位图。纯 CSS 操作，一帧内完成，
   * 所以拖窗口时页面是「跟着动、略糊」，而不是「卡住 → 松手后跳一下」。
   * 清晰的那一帧由下面那个去抖的 effect 补。
   *
   * ★ 文字层必须**跟着同一比例缩放**：它的 span 是按上一次渲染的 scale 绝对定位的，
   *   只改画布不改它，这 160ms 里选区与字形就整体错开 —— 而拖窗口正是用户最容易
   *   去拖选的时刻。缩放比例由 `layerScaleRatio` 算，重画完成后复位。
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base || !box) return;
    const next = displayScale({ mode, box, base, zoom });
    if (!(next > 0)) return;
    canvas.style.width = `${Math.floor(base.width * next)}px`;
    canvas.style.height = `${Math.floor(base.height * next)}px`;
    const layer = textLayerRef.current;
    if (layer !== null) {
      const ratio = layerScaleRatio(renderedScaleRef.current, next);
      layer.style.transform = ratio === null ? '' : `scale(${ratio})`;
    }
  }, [box, mode, zoom, base]);

  // ---- 渲染当前页 ------------------------------------------------------
  useEffect(() => {
    if (doc === null || status !== 'ready' || box === null) return undefined;
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    let cancelled = false;
    // 换页必须立刻画（等 160ms 会像「按了没反应」）；只是尺寸变了就等停手再画。
    const immediate = page !== renderedPageRef.current;
    /**
     * ★ 换页时**立刻**把上一页的文字层收掉。
     *
     *   位图要等 160ms（尺寸变化）或一次取字节（新页）才换，但文字层是 DOM ——
     *   留着它意味着「看着上一页的字、选到的也是上一页的字」，而滚动条已经到新页
     *   的位置了。宁可这一小段时间选不中，也不能让选中的内容属于另一页。
     */
    if (immediate && textLayerRef.current !== null) {
      textLayerTaskRef.current?.cancel?.();
      textLayerTaskRef.current = null;
      textLayerRef.current.textContent = '';
      setQuote(null);
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const pdfPage = await doc.getPage(page);
          if (cancelled) return;
          const raw = pdfPage.getViewport({ scale: 1 });
          const nextBase = { width: raw.width, height: raw.height };
          setBase(nextBase);
          const nextScale = displayScale({ mode, box, base: nextBase, zoom });
          if (!(nextScale > 0)) return;
          const viewport = pdfPage.getViewport({ scale: nextScale });
          const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
          const pixelWidth = Math.max(1, Math.floor(viewport.width * dpr));
          const pixelHeight = Math.max(1, Math.floor(viewport.height * dpr));
          // ★ 先画到离屏画布：给 canvas 赋宽度会**立刻丢弃当前位图**，而这里到
          //   `renderTask.promise` 之间可能隔着一次网盘取字节（几百毫秒起）。
          //   直接画可见画布的话，这段空窗期就是一片白，用户滚动一下就会看到
          //   「什么都没有的页面」。走离屏后可见画布在这段时间里仍是上一页。
          const offscreen = offscreenOf(offscreenRef);
          offscreen.width = pixelWidth;
          offscreen.height = pixelHeight;
          const context = offscreen.getContext('2d', { alpha: false });
          // 上一帧还没画完就换页时会叠影（老任务继续往同一张画布上画）。
          renderRef.current?.cancel?.();
          const renderTask = pdfPage.render({
            canvasContext: context,
            canvas: offscreen,
            viewport,
            transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
          });
          renderRef.current = renderTask;
          await renderTask.promise;
          if (cancelled) return;
          // 提交：改尺寸与贴图在**同一帧**内完成，中间不会露出空白。
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.getContext('2d', { alpha: false }).drawImage(offscreen, 0, 0);
          renderedPageRef.current = page;
          // 往上翻要落到上一页的**底部**，往下翻回到顶部 —— 连续阅读靠这一下。
          const pendingScroll = pendingScrollRef.current;
          pendingScrollRef.current = null;
          const stage = stageRef.current;
          if (pendingScroll !== null && stage !== null) {
            stage.scrollTop = pendingScroll === 'bottom' ? stage.scrollHeight : 0;
          }
          if (reportedPageRef.current !== page) {
            reportedPageRef.current = page;
            onPageChange?.(page, doc.numPages);
          }

          // ---- 文字层 ----------------------------------------------------
          /**
           * ★ 这一段就是「PDF 明明是文字版，却选不中一个字」的答案。
           *
           *   位图里没有可选文本。能选、能复制、能 ⌘F 的，是叠在它上面那一层
           *   **透明的 DOM span**（pdf.js 的 `TextLayer` 按每个文字项的坐标逐个摆放）。
           *   在此之前插件只做了前半段（画位图），所以 `getTextContent()` 明明能抽到
           *   整页文字（伴读一直在用），页面上却一个字都选不中 —— 两条通路互不相通。
           *
           * ★ `--total-scale-factor` 必须等于**画布 CSS 尺寸所用的那个 scale**：
           *   位图 = `viewport.width × dpr` 像素、显示 = `viewport.width` CSS 像素，
           *   文字层按 CSS 像素绝对定位。混用会让选区整体偏移，2× 屏上偏得最明显
           *   （「想选这个字，选到了左边那个」）。
           *
           * ★ 文字层失败**不把整页判成错误**：它只是少了一个可选文本层，
           *   位图照样看得见。报成「这本书打不开」是把小事说成大事。
           */
          renderedScaleRef.current = nextScale;
          const layerEl = textLayerRef.current;
          const metrics = textLayerMetrics(viewport);
          const TextLayerCtor = pdfjsRef.current?.TextLayer;
          if (layerEl !== null && metrics !== null && typeof TextLayerCtor === 'function') {
            layerEl.style.transform = '';
            layerEl.style.setProperty('--total-scale-factor', String(metrics.scale));
            layerEl.style.width = `${metrics.width}px`;
            layerEl.style.height = `${metrics.height}px`;
            textLayerTaskRef.current?.cancel?.();
            layerEl.textContent = '';
            try {
              const textContent = await pdfPage.getTextContent();
              if (cancelled) return;
              const task = new TextLayerCtor({ textContentSource: textContent, container: layerEl, viewport });
              textLayerTaskRef.current = task;
              await task.render();
              // 渲染完成后才有资格下结论：这时候容器里就是这一页**全部**的可见文字。
              if (!cancelled) {
                // 划线要按真实文本节点量矩形 —— 通知那一支 effect「这一页的文字层好了」。
                setTextLayerVersion(value => value + 1);
              }
            } catch (cause) {
              if (!cancelled && cause?.name !== 'AbortException') setQuote(null);
            }
          }
        } catch (cause) {
          // `RenderingCancelledException` 是主动取消，不是错误。
          if (!cancelled && cause?.name !== 'RenderingCancelledException') {
            setError(cause?.message ?? String(cause));
            setStatus('error');
          }
        }
      })();
    }, immediate ? 0 : REDRAW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      renderRef.current?.cancel?.();
      // 上一轮的文字层也要收掉：它的续块会把 span 追加进已经被新一页清空的容器。
      textLayerTaskRef.current?.cancel?.();
      textLayerTaskRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, mode, zoom, box, status]);

  const go = useCallback((next, { toBottom = false } = {}) => {
    if (numPages === 0) return;
    const target = clampPage(next, numPages);
    if (target === page) return;
    pendingScrollRef.current = toBottom ? 'bottom' : 'top';
    // ★ 翻页的同时把滚轮累计器清零：触控板的惯性在翻页之后还会继续喂事件，
    //   不清零的话一次轻扫会顺着惯性连翻好几页。
    wheelAccRef.current = 0;
    wheelAtRef.current = Date.now();
    setPage(target);
    setPageDraft(String(target));
  }, [numPages, page]);

  /**
   * 轮转书页配色（原色 → 护眼 → 夜间）并记住它。
   *
   * ★ 写盘失败**不打断**：这一次的观感已经变了，失败的只是「记住」这件事。
   *   为了记不住而回滚颜色，用户看到的是「点了没反应」。
   *
   * ★ 这两个回调**必须定义在键盘 effect 之前**。键盘那个 `useEffect` 的依赖数组里
   *   写着它们，而依赖数组是在**渲染期**求值的 —— 定义在下面（哪怕函数体用到它们
   *   的地方也只是在事件回调里）会直接触发 TDZ：
   *   `Cannot access 'toggleImmersive' before initialization`，整个阅读器白屏。
   *   教训：`useCallback` 的声明位置对 Hooks 来说是「普通 const」，不是提升过的函数声明。
   */
  const cycleTint = useCallback(() => {
    const next = nextBookTint(tint);
    setTint(next);
    api?.saveSettings?.({ bookTint: next }).catch(() => {});
  }, [tint, api]);

  /**
   * 直接选某一档配色（配色面板里的色块）。
   *
   * ★ 与 `cycleTint` 分开：轮转是「键盘 N 按一下」，色块是「我就要这一档」。
   *   两者共用同一个设置项，但语义不同 —— 合并会让面板上的色块点起来像轮转。
   */
  const applyTint = useCallback((next) => {
    setTint(next);
    api?.saveSettings?.({ bookTint: next }).catch(() => {});
  }, [api]);

  /**
   * 亮度。
   *
   * ★ 拖动时**频繁**触发，所以状态即时更新、写盘交给 `persistBrightness`
   *   （在 `pointerup` / `blur` 时调一次）：滑杆还没松手就往设置文件里写几十次，
   *   在慢盘上会让拖动一顿一顿的。
   */
  const applyBrightness = useCallback((value) => {
    setBrightness(normalizeBookBrightness(value));
  }, []);

  const persistBrightness = useCallback(() => {
    api?.saveSettings?.({ bookBrightness: normalizeBookBrightness(brightness) }).catch(() => {});
  }, [api, brightness]);

  /** 开合右下角那颗浮动按钮（点开的态对触屏/键盘必需：hover 在它们上面不存在）。 */
  const toggleFab = useCallback(() => {
    setFabOpen((value) => !value);
    setPaletteOpen(false);
  }, []);

  /**
   * 悬停意图：进入 → 立刻展开；离开 → 等 `FAB_HOVER_GRACE` 再收（0.24.3）。
   *
   * ★ 逻辑本身在 `createFabHover`（纯函数、可用假定时器真跑）：三个坑都写在那里 ——
   *   越过空隙被误收、宽限期内回来要取消、连续离开只该安排一次。
   * ★ 定时器只在**离开整棵子树**时启动：`pointerenter` / `pointerleave` 在祖先上
   *   只在「进入 / 离开子树」时触发，从按钮移到某一格、或从一格移到另一格都不会误收。
   * ★ 用 ref 持有状态机（不是每次渲染新建）：换实例会把正在等的定时器丢掉。
   */
  const fabHover = useRef(null);
  if (fabHover.current === null) {
    fabHover.current = createFabHover({
      onOpen: () => setFabOpen(true),
      onClose: () => setFabOpen(false),
    });
  }
  const onFabEnter = useCallback(() => fabHover.current.enter(), []);
  const onFabLeave = useCallback(() => fabHover.current.leave(), []);
  useEffect(() => () => fabHover.current?.cancel(), []);

  /**
   * 沉浸 = **只改布局**，绝不改窗口大小（0.24.2）。
   *
   * ★ 用户原话：「点沉浸只是左边两列缩掉，只显示阅读的这一列，但是在点击沉浸的时候
   *   窗口大小不动，如果要全屏是用户自己选择点击。」
   *   0.22.0 起这里会 `requestFullscreen()` 把整本书顶成全屏 —— 那**是另一件事**：
   *   全屏是用户对**窗口**的决定（macOS 会换一个 Space、有动画、退出还要再按一次），
   *   不该由「我想安静读一页」顺手替他做。
   * ★ 代价要说清楚：宿主自己那一列（新会话 / 技能 / 插件 / 阅读器…）在插件的挂载点
   *   之外，**插件改不到它的 CSS** —— 不进全屏就收不掉它。所以现在的沉浸只收
   *   插件自己的两列（书架列 + 分隔条）+ 元信息行 + 工具栏，正文占满插件这一格。
   *   要连宿主那一列一起收掉，用户自己按绿灯 / ⌃⌘F（这条写进了按钮 title）。
   * ★ 想恢复「自动全屏」的话，别只把 `requestFullscreen` 加回来：那样 Esc 会被
   *   全屏接管、沉浸态要靠 `fullscreenchange` 同步回来，两个状态机缠在一起 ——
   *   0.22.0~0.24.1 那套就是这么复杂起来的。
   */
  const toggleImmersive = useCallback(() => {
    const next = !immersive;
    setImmersive(next);
    if (next) {
      setMarksOpen(false);
      setDigestOpen(false);
      setCompanion(false);
      setPaletteOpen(false);
      setFabOpen(false);
      /**
       * ★ 0.24.6：这句提示改成「怎么把工具条找回来 + 全屏怎么按」。
       *   0.24.2 那句是「只留书页，Esc 退出 · 要全屏按 ⌃⌘F」—— 但当时 ⌃⌘F
       *   **根本没人处理**（`readerCommand` 遇到任何修饰键就返回 `NO_COMMAND`），
       *   所以那句提示是在承诺一件做不到的事。现在两条都是真的：
       *   · 工具条不再消失，鼠标移到顶部就滑出来（不用记 Esc）；
       *   · ⌃⌘F / F11 由下面的键盘处理真的调 `requestFullscreen`。
       */
      notify?.('已进入沉浸式阅读：Esc 退出 · 顶部工具条鼠标移上去会出现 · ⌃⌘F 全屏');
    }
  }, [immersive, notify]);

  /**
   * 真正的全屏：⌃⌘F（macOS 的系统全屏键）与 F11。
   *
   * ★ 为什么必须由插件自己绑：`readerCommand` 的第一行是「任何修饰键 ⇒ `NO_COMMAND`」，
   *   所以 ⌃⌘F 既没有人处理、也没有人 `preventDefault` —— 按下去**完全没反应**，
   *   而 0.24.2 的提示语已经写着「要全屏按 ⌃⌘F」。用户报的就是这一条。
   * ★ 与沉浸**解耦**：沉浸只改布局（用户 0.24.2 的原话「点沉浸时窗口大小不动」），
   *   全屏是用户对窗口的主动决定。这里不碰 `immersive`，也不挂 `fullscreenchange`
   *   去反向同步它 —— 那正是 0.22.0 那版把两个状态机缠在一起的地方。
   * ★ 失败必须说出来：`requestFullscreen` 在没有用户手势、或被宿主策略拒绝时会返回
   *   rejected Promise。静默 catch 掉就等于又造一次「按了没反应」。
   */
  const toggleFullscreen = useCallback(async () => {
    const doc = globalThis.document;
    if (typeof doc?.documentElement?.requestFullscreen !== 'function') {
      notify?.('这个环境不支持全屏', true);
      return;
    }
    try {
      if (doc.fullscreenElement) await doc.exitFullscreen();
      else await doc.documentElement.requestFullscreen();
    } catch (error) {
      notify?.(`全屏没成功：${error?.message ?? String(error)}`, true);
    }
  }, [notify]);

  /**
   * ★ 0.24.2：这里原来有一段「沉浸 ⇒ `requestFullscreen()`」，已删除。
   *
   *   用户的原话：「在点击沉浸的时候窗口大小不动，如果要全屏是用户自己选择点击。」
   *   ⇒ 沉浸只改**布局**；全屏是用户对**窗口**的决定，由他自己按绿灯 / ⌃⌘F。
   *
   *   ★ 顺带删掉的还有 `fullscreenchange` 监听。它当初的存在理由是「全屏被 Esc /
   *     F11 / 系统手势撤掉时要同步沉浸态」—— 既然不再驱动全屏，这个同步就没有对象了；
   *     留着反而有害：用户自己按 ⌃⌘F 进出全屏时，会被顺手退出沉浸。
   *   ★ 副作用（要说清）：宿主自己那一列在挂载点之外，插件改不到它的 CSS ⇒
   *     不进全屏就收不掉它。沉浸态收的是**插件自己的**两列（书架列 + 分隔条）、
   *     元信息行与工具栏，正文占满插件这一格。按钮 title 里写了「要全屏按 ⌃⌘F」。
   */

  /** 把沉浸态同步给外层（书架列要跟着藏）。`onImmersiveChange` 由外层传稳定的 setter。 */
  useEffect(() => {
    onImmersiveChange?.(immersive);
  }, [immersive, onImmersiveChange]);

  /**
   * 沉浸态的「胶囊滑出」判据（0.25.4）：指针离面板顶边 ≤56px 就滑出、>72px 才收。
   * 滞回写在 `book-peek.js`（有单测），这里只把指针坐标换算成距离。
   */
  const onPeekPointerMove = (event) => {
    if (!immersive) return;
    /* 指针在面板上不滑出、已滑出的立刻收 —— 否则胶囊会盖住面板右上角的关闭按钮
       （0.25.7，电子书那边同一处；判据在 `book-peek.js` 的 `insidePanel`）。 */
    if (insidePanel(event.target)) {
      if (peek) setPeek(false);
      return;
    }
    const top = event.currentTarget.getBoundingClientRect().top;
    const next = peekNext(peek, event.clientY - top);
    if (next !== peek) setPeek(next);
  };
  const onPeekPointerLeave = (event) => {
    if (!immersive) return;
    const top = event.currentTarget.getBoundingClientRect().top;
    const next = peekOnLeave(event.clientY - top);
    if (next !== peek) setPeek(next);
  };

  /**
   * 点空白处收起右下角那一列。
   *
   * ★ 用 **capture** 阶段监听：书页上的 `pointerdown` 可能被选区逻辑 `preventDefault`，
   *   冒泡阶段的事件就收不到了，列表会赖着不走。
   * ★ 不用 `click`：拖选文字时也会 `click`，正在选字的人都还没打算关它。
   */
  useEffect(() => {
    if (!fabOpen) return undefined;
    const doc = globalThis.document;
    if (!doc?.addEventListener) return undefined;
    const onDown = (event) => {
      const node = fabRef.current;
      const target = event.target;
      if (node && target && typeof target.nodeType === 'number' && node.contains(target)) return;
      setFabOpen(false);
    };
    doc.addEventListener('pointerdown', onDown, true);
    return () => doc.removeEventListener('pointerdown', onDown, true);
  }, [fabOpen]);

  // ---- 键盘：← → ↑ ↓ 翻页，+/- 缩放，W/P 换基准，A 开伴读 ------------------
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      /**
       * ★ 全屏必须抢在 `readerCommand` **之前**：那个函数第一行是「任何修饰键 ⇒
       *   `NO_COMMAND`」，⌃⌘F 会被它直接放过 —— 既没人处理，也没人 `preventDefault`，
       *   于是「按了没反应」。这正是用户报的那条。
       * ★ 只认精确组合（ctrl **且** meta **且** f）：单独的 ⌘F / ⌃F 在 macOS 上
       *   各有别的含义（查找 / 光标前移），不能被这里吃掉。
       */
      if (event.key === 'F11' || (event.ctrlKey && event.metaKey && (event.key === 'f' || event.key === 'F'))) {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }
      /**
       * ⌘F / ⌃F = **书内搜索**（0.26.0）。
       *
       * ★ 抢在 `readerCommand` 之前，理由与上面那条全屏相同：那个函数第一行是
       *   「任何修饰键 ⇒ 不认识的键」，⌘F 到那里会被原样放过 —— 按了没反应。
       * ★ 收回浏览器自带的查找是对的：正文只在当前页的文字层里，原生查找只能找
       *   这一页。用户按 ⌘F 的意图是「整本书里在哪儿」（见文件头第 1 条），
       *   让原生查找抢走等于给了一个能力小一号却看不出区别的入口。
       */
      if (!event.altKey && (event.metaKey || event.ctrlKey) && !event.shiftKey
        && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        toggleFind();
        return;
      }
      /**
       * ★ Esc 不交给 `readerCommand`：那个函数的契约是「不认识的键就不吞」，
       *   而 Esc 只有在**已经处在沉浸态**时才属于本组件。反过来写成「Esc 一律退出沉浸」，
       *   会让读屏 / 输入法用 Esc 关自己的弹层时顺带把阅读器也切回来。
       * ★ 一次 Esc 只退一层：右下角那一列摊开时，用户的意图几乎总是「把这一列收起来」，
       *   而不是「顺手把沉浸也退掉」—— 后者会让书页突然跳回带工具栏的样子。
       */
      if (event.key === 'Escape') {
        // ★ 输入法组字中的 Esc 是「取消这次组字」，不是「关面板」。
        if (event.isComposing === true) return;
        if (findOpen) { setFindOpen(false); return; }
        if (fabOpen) { setFabOpen(false); return; }
        if (immersive) setImmersive(false);
        return;
      }
      const command = readerCommand({
        key: event.key,
        tagName: event.target?.tagName ?? '',
        contentEditable: event.target?.isContentEditable === true,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
      });
      if (command === NO_COMMAND) return;
      event.preventDefault();
      if (command === 'next') go(page + 1);
      else if (command === 'prev') go(page - 1, { toBottom: true });
      else if (command === 'first') go(1);
      else if (command === 'last') go(numPages);
      else if (command === 'zoomIn') setZoom((value) => stepZoom(value, 1));
      else if (command === 'zoomOut') setZoom((value) => stepZoom(value, -1));
      else if (command === 'fitWidth') { setMode(FIT_WIDTH); setZoom(1); }
      else if (command === 'fitPage') { setMode(FIT_PAGE); setZoom(1); }
      else if (command === 'companion') setCompanion((value) => !value);
      else if (command === 'immersive') toggleImmersive();
      else if (command === 'tint') cycleTint();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [status, go, numPages, immersive, fabOpen, findOpen, toggleFind, toggleImmersive, cycleTint, toggleFullscreen]);

  // ---- 滚轮：翻页；Ctrl/⌘ + 滚轮：缩放 ------------------------------------
  /**
   * 用原生监听而不是 React 的 `onWheel`：React 的合成 wheel 监听挂在根节点上且
   * 是**被动**的，`preventDefault()` 在里面无效（页面会一边翻页一边滚）。
   *
   * ★ 翻页判定交给 `wheelIntent`（见 book-view）：页面还滚得动时先滚，
   *   滚到边界之后那一下才翻页 —— 否则适宽模式下一滚就跳页，页面的下半部分
   *   永远看不到。累计 + 冷却那两道是为了触控板惯性：一次轻扫会连发几十个
   *   事件，逐个翻页会一次翻掉二十页。
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || status !== 'ready') return undefined;
    const onWheel = (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom((value) => stepZoom(value, event.deltaY < 0 ? 1 : -1));
        return;
      }
      // ★ 这一页还没真正画到画布上时，整段滚轮都不吃（连滚动也不接管）：
      //   否则触控板的惯性会在「上一页刚翻走、新页还在取字节」的空窗里继续翻，
      //   一路翻出好几张空白 —— 那正是「乱滚动 + 什么都没有的页面」。
      if (renderedPageRef.current !== page) { wheelAccRef.current = 0; return; }
      const intent = wheelIntent({
        deltaY: event.deltaY,
        scrollTop: stage.scrollTop,
        scrollHeight: stage.scrollHeight,
        clientHeight: stage.clientHeight,
      });
      if (intent === 'scroll') { wheelAccRef.current = 0; return; }
      wheelAccRef.current += Math.abs(event.deltaY);
      if (wheelAccRef.current < WHEEL_FLIP_DELTA) return;
      const now = Date.now();
      if (now - wheelAtRef.current < WHEEL_FLIP_COOLDOWN_MS) return;
      wheelAccRef.current = 0;
      wheelAtRef.current = now;
      event.preventDefault();
      if (intent === 'next') go(page + 1);
      else go(page - 1, { toBottom: true });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [status, go]);

  // ---- 抽取当前页的文字（伴读的阅读上下文）--------------------------------
  /**
   * 只在**伴读打开时**抽：`getTextContent()` 要把整页的文字项取回来，
   * 不为看一眼的页面白付这份开销。
   */
  useEffect(() => {
    if (!companion || doc === null || status !== 'ready') return undefined;
    let cancelled = false;
    (async () => {
      let text = '';
      try {
        const pdfPage = await doc.getPage(page);
        const content = await pdfPage.getTextContent();
        text = extractPageText(content.items);
      } catch {
        // 取不到就当这一页没有文字层 —— 伴读那边会**如实说明**，不静默降级。
        text = '';
      }
      if (!cancelled) setPageTextState({ page, text });
    })();
    return () => { cancelled = true; };
  }, [companion, doc, page, status]);

  // ---- 书内搜索：全书索引 + 当前页命中矩形 ---------------------------------
  /**
   * 建索引 + 检索：**按页顺序**跑一遍，边跑边报进度。
   *
   * ★ 为什么不能只搜当前页（很多阅读器就是这么做的）：那叫「当前页查找」。
   *   用户问的是「这本书里在哪儿讲过 X」，答案可能在 300 页之后。
   * ★ 为什么要缓存整本的页文本：PDF 的正文只存在于 pdf.js 的文字层里，没有
   *   「一次取回整本」的接口。缓存之后，改一个词再搜是**毫秒级**（只有第一次
   *   要认真跑 500 次 `getTextContent()`）。
   * ★ 扫描页（没有文字层）**不静默跳过**：它们计入 `textless`，在面板底部说出来。
   *   不说的话，「共 3 处」会被读成「全书只有 3 处」—— 而实际上有 200 页根本没搜。
   * ★ 到 `FIND_LIMIT_MAX` 就停并置 `truncated`：同上，截断必须说出口。
   * ★ 进度节流 200ms：每页都 setState 会让整棵阅读器（含画布）每秒重渲染几十次，
   *   翻页和滚动会明显发涩，而用户其实只需要看到「在动」。
   */
  useEffect(() => {
    if (!findOpen || doc === null || status !== 'ready') return undefined;
    const needle = normalizeNeedle(findQuery);
    findNeedle.current = needle;
    if (needle === '') {
      findRun.current += 1;
      setFindHits([]);
      setFindActive(-1);
      setFindState({
        status: 'idle', error: '', done: 0, total: 0, textless: 0, textlessPages: [], truncated: false,
      });
      return undefined;
    }
    const token = findRun.current + 1;
    findRun.current = token;
    findScrollKey.current = '';
    setFindHits([]);
    setFindActive(-1);
    let cancelled = false;
    const timer = setTimeout(async () => {
      const hits = [];
      /**
       * 没有文字层的页（扫描页）。
       *
       * ★ 收**页码**而不只是计数：面板要按这个名单去补 OCR。只留一个数字的话，
       *   「另有 187 页没搜」就永远是一句没有出口的说明。
       */
      const textlessPages = [];
      let lastFlush = 0;
      setFindState({
        status: 'searching', error: '', done: 0, total: numPages, textless: 0, textlessPages: [], truncated: false,
      });
      for (let current = 1; current <= numPages; current += 1) {
        if (cancelled || findRun.current !== token) return;
        let text = findTexts.current.get(current);
        if (text === undefined) {
          try {
            const pdfPage = await doc.getPage(current);
            const content = await pdfPage.getTextContent();
            text = pageIndexText(content.items);
          } catch {
            // 取不到就当这一页没有文字层。它确实不参与检索 —— 但要记账（见上）。
            text = '';
          }
          findTexts.current.set(current, text);
        }
        if (text === '') textlessPages.push(current);
        else {
          // 这一页的文字是识别来的还是文字层里取的：命中列表要标出来，
          // 因为 OCR 一定有错字，而摘录是用户判断「是不是我要找的」的唯一依据。
          const via = findOcrVia.current.has(current) ? 'ocr' : 'text';
          for (const hit of findOccurrences(text, needle, { limit: FIND_LIMIT_MAX - hits.length })) {
            hits.push({
              index: hits.length,
              page: current,
              start: hit.start,
              end: hit.end,
              via,
              snippet: snippetOf(text, hit.start, hit.end),
            });
            if (hits.length >= FIND_LIMIT_MAX) break;
          }
        }
        const now = Date.now();
        if (now - lastFlush > 200 || current === numPages || hits.length >= FIND_LIMIT_MAX) {
          lastFlush = now;
          setFindHits(hits.slice());
          setFindState({
            status: 'searching', error: '', done: current, total: numPages,
            textless: textlessPages.length, textlessPages: textlessPages.slice(),
            truncated: hits.length >= FIND_LIMIT_MAX,
          });
        }
        if (hits.length >= FIND_LIMIT_MAX) break;
      }
      if (cancelled || findRun.current !== token) return;
      setFindHits(hits.slice());
      setFindState({
        status: 'done', error: '', done: numPages, total: numPages,
        textless: textlessPages.length, textlessPages: textlessPages.slice(),
        truncated: hits.length >= FIND_LIMIT_MAX,
      });
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [findOpen, findQuery, doc, status, numPages, findRerun]);

  /** 跳到第 `index` 处命中：换页（如需）+ 把它标成「当前」。 */
  const jumpToFind = useCallback((index) => {
    const hit = findHits[index];
    if (hit === undefined) return;
    setFindActive(index);
    if (hit.page !== page) go(hit.page);
  }, [findHits, page, go]);

  /** 上一处 / 下一处，**首尾相接**（理由见 `BookEbook` 的同名回调）。 */
  const stepFind = useCallback((delta) => {
    if (findHits.length === 0) return;
    const base = findActive < 0 ? (delta > 0 ? -1 : 0) : findActive;
    jumpToFind((base + delta + findHits.length) % findHits.length);
  }, [findHits, findActive, jumpToFind]);

  /**
   * 补救扫描页：对那些**没有文字层**的页逐页做本机 OCR，认完重新检索。
   *
   * ★ 为什么必须是用户主动点，而不是搜完自动跑：一本 400 页的扫描书要 3–5 分钟
   *   （实测 0.5–0.8 秒/页）。自动跑意味着「搜一个词，风扇转五分钟」，
   *   而用户可能只是想确认一个词在不在这本书里。
   * ★ 为什么复用 `OCR_RENDER_DPI` 与那层白底：与伴读那条 OCR 路径**同一次渲染**。
   *   两处各写一套参数的话，症状会是「伴读认得出来、搜索认不出来」（或者反过来），
   *   而两次都用了 OCR，用户完全无法判断为什么。
   * ★ 单页失败**不中断整批**：纯图片页、分辨率太低、Vision 偶发超时 —— 混在同一批里
   *   很正常。把它们计入 `failed` 如实报出来，比整批作废有用。
   * ★ 认出来的结果同时写进 `findTexts`（本次检索立即生效）**和宿主**（`ocr.json`，
   *   下次打开这本书、伴读那一侧也直接可用）—— 这是同一个动作的两个后果，都该留。
   * ★ 结束后 `setFindRerun` 让检索 effect 重跑，而不是在这里手写第二遍检索循环：
   *   两套循环迟早会在「上限 / 截断 / 进度节流」上分叉（见上面 effect 的注释）。
   */
  const runFindOcr = useCallback(async () => {
    if (findOcr.running || doc === null) return;
    const targets = findState.textlessPages.slice();
    if (targets.length === 0) return;
    findOcrCancel.current = false;
    setFindOcr({ running: true, done: 0, total: targets.length, note: '' });
    let recovered = 0;
    let failed = 0;
    for (let index = 0; index < targets.length; index += 1) {
      if (findOcrCancel.current) break;
      const target = targets[index];
      try {
        const pdfPage = await doc.getPage(target);
        const viewport = pdfPage.getViewport({ scale: OCR_RENDER_DPI / 72 });
        const canvas = globalThis.document?.createElement?.('canvas');
        if (canvas === null || canvas === undefined) throw new Error('这个环境拿不到画布，识别不了');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('这个环境拿不到 2D 画布，识别不了');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({ canvasContext: context, viewport }).promise;
        const image = canvas.toDataURL('image/jpeg', 0.85);
        // 位图用完立刻缩到 0：200 DPI 的一页约 15 MB，几百页攒在 GC 队列里会顶到上限。
        canvas.width = 0;
        canvas.height = 0;
        const result = await ocrBookPage(book.id, target, image);
        const text = typeof result.text === 'string' ? result.text : '';
        if (text.trim() === '') { failed += 1; continue; }
        findTexts.current.set(target, text);
        findOcrVia.current.add(target);
        recovered += 1;
      } catch {
        failed += 1;
      }
      setFindOcr({ running: true, done: index + 1, total: targets.length, note: '' });
    }
    const stopped = findOcrCancel.current;
    findOcrCancel.current = false;
    // ★ 取消时**不说「认出 N 页」**：那句话会被读成「这一批已经跑完了」，
    //   而剩下的页根本没试。停下来就只说停下来。
    const note = stopped
      ? '已停止识别，剩下的页没有试'
      : `认出 ${recovered} 页${failed > 0 ? ` · ${failed} 页没认出字` : ''}`;
    setFindOcr({ running: false, done: 0, total: targets.length, note });
    if (!stopped && recovered > 0) setFindRerun(value => value + 1);
  }, [findOcr.running, doc, book.id, findState.textlessPages]);

  /** 停下来：循环在下一页开头看到这个标记就退出（不在 await 中途强杀）。 */
  const stopFindOcr = useCallback(() => {
    findOcrCancel.current = true;
  }, []);

  /**
   * 这一页的命中 → 像素矩形。
   *
   * ★ 偏移**重新在文字层里找一遍**，不用索引里存的那份：索引是 `pageIndexText()`
   *   拼出来的文本，而文字层是 pdf.js 铺的 span 序列，两者在「游程之间补不补空格」
   *   这类细节上可能差一两个字符。按**出现顺序**与索引里的命中一一对应（同一页上
   *   两边数出来的一般一样），差一两个时以文字层为准（能画出来的才叫高亮）。
   * ★ 文字层为空 ⇒ **清空矩形并返回**，不能保留上一页的：扫描页的文字层永远是空的，
   *   不清的话上一页的命中色块会留在新页面上（与 `markRects` 那里同一个坑）。
   */
  useEffect(() => {
    if (!findOpen || findNeedle.current === '' || status !== 'ready') {
      setFindRects(previous => (previous.length === 0 ? previous : []));
      return;
    }
    const layer = textLayerRef.current;
    if (layer === null) return;
    const nodes = textNodesOf(layer);
    if (nodes.length === 0) {
      setFindRects(previous => (previous.length === 0 ? previous : []));
      return;
    }
    const layerText = nodes.map(node => node.data ?? '').join('');
    const occurrences = findOccurrences(layerText, findNeedle.current, { limit: 200 });
    const pageHits = findHits.filter(hit => hit.page === page);
    const next = [];
    for (let i = 0; i < occurrences.length; i += 1) {
      const range = rangeOfAnchor(layer, nodes, occurrences[i].start, occurrences[i].end);
      if (range === null) continue;
      const rects = rectsOfRange(range, layer);
      if (rects.length === 0) continue;
      const hit = pageHits[i];
      next.push({
        key: hit === undefined ? `p${page}-${i}` : `h${hit.index}`,
        active: hit !== undefined && hit.index === findActive,
        rects,
      });
    }
    setFindRects(previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    // 当前那一处滚到视野中间（同一位置只滚一次，否则拖滚动条会被拽回去）。
    const active = next.find(item => item.active);
    const stage = stageRef.current;
    if (active === undefined || stage === null) return;
    const key = `${page}:${findActive}`;
    if (findScrollKey.current === key) return;
    findScrollKey.current = key;
    const rect = active.rects[0];
    const frame = layer.getBoundingClientRect();
    const box = stage.getBoundingClientRect();
    const offset = frame.top - box.top + rect.top;
    stage.scrollTop = Math.max(0, stage.scrollTop + offset - stage.clientHeight / 2 + rect.height / 2);
  }, [findOpen, findHits, findActive, page, status, textLayerVersion]);

  // ---- 扫描页的本地 OCR ---------------------------------------------------
  /**
   * 这一页没有文字层时，先问宿主「以前识别过吗」。
   *
   * ★ 只在 `pageTextState` 已经就位、且**确实为空**时才问：文字层有字时问它是
   *   白跑一趟（一次本机 HTTP + 一次 JSON 读盘），而每翻一页都要跑一次。
   * ★ 失败一律当「没有」：路由没接上（501）、这本书从没识别过（空串）都走这里。
   *   把错误弹给用户没有意义 —— 他还没做任何操作。
   */
  useEffect(() => {
    if (pageTextState === null || pageTextState.page !== page) return undefined;
    if (pageTextState.text.trim() !== '') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const text = await fetchOcrPage(book.id, page);
        if (!cancelled && text.trim() !== '') setOcrState({ page, text });
      } catch {
        // 见上：当「没识别过」。
      }
    })();
    return () => { cancelled = true; };
  }, [book.id, page, pageTextState]);

  /**
   * 对**当前这一页**做本地 OCR。
   *
   * ★ 为什么要自己渲染一张 200 DPI 的位图，而不是拿屏幕上那张画布：屏幕上那张是
   *   「适应宽度」画出来的，在 900px 宽的面板里只有 ~110 DPI —— 实测这个分辨率下
   *   正文会掉字（尤其是笔画密的字）。200 DPI 是实测质量与体积的平衡点：
   *   1653×2339 的一页 JPEG 约 300–900 KB，Vision 0.6–0.8 秒认完。
   * ★ 为什么要 `fillRect` 一层白底：扫描页的 JPEG 解码后可能带透明通道（罕见），
   *   叠到黑底上再 OCR 会一个字都认不出来，而界面上看起来完全正常。
   * ★ 失败必须说出来（`ocrError`）：静默失败的话，用户点完按钮什么都没变，
   *   会以为这个功能是假的 —— 而那正是 0.24.6 刚修完的那类毛病。
   *
   * ★ `quiet` 是给**自动识别**用的（见下面那个 effect）：自动跑的时候既不弹 toast、
   *   也不在面板里留红色错误 —— 用户根本没点过任何东西，突然出现一段报错只会像
   *   「这个插件坏了」。手动点的那一次仍然如实报错，因为那时是用户主动要一个结果。
   */
  const runOcr = useCallback(async (options) => {
    const quiet = options?.quiet === true;
    if (ocrBusyRef.current || doc === null) return;
    ocrBusyRef.current = true;
    setOcrBusy(true);
    if (!quiet) setOcrError('');
    try {
      const pdfPage = await doc.getPage(page);
      const viewport = pdfPage.getViewport({ scale: OCR_RENDER_DPI / 72 });
      const canvas = globalThis.document?.createElement?.('canvas');
      if (canvas === null || canvas === undefined) throw new Error('这个环境拿不到画布，识别不了');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('这个环境拿不到 2D 画布，识别不了');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvasContext: context, viewport }).promise;
      const image = canvas.toDataURL('image/jpeg', 0.85);
      const result = await ocrBookPage(book.id, page, image);
      const text = typeof result.text === 'string' ? result.text : '';
      if (text.trim() === '') {
        if (!quiet) setOcrError('这一页没认出字（可能是纯图片页，或者分辨率太低）');
        return;
      }
      setOcrState({ page, text });
      if (!quiet) notify?.(`第 ${page} 页认出 ${result.chars ?? 0} 个字（${result.ms ?? 0} ms，本地识别）`);
    } catch (error) {
      if (!quiet) setOcrError(error?.message ?? String(error));
    } finally {
      ocrBusyRef.current = false;
      setOcrBusy(false);
    }
  }, [book.id, doc, notify, page]);

  /**
   * 扫描页**自动**识别：打开伴读、停在这一页一会儿，文字就自己补上了。
   *
   * ★ 为什么要自动：一本 387 页的扫描书，让用户「翻一页点一次」是不现实的 ——
   *   那正是「按需」被读成「麻烦」的原因。识别是**本机、免费、0.5–0.8 秒**的，
   *   既然不要钱，就不该要一次点击。
   * ★ 为什么要延迟 700 ms：翻页键按住不放会连翻十几页。不延迟的话每一页都会起一个
   *   `osascript` 子进程、渲染一张 200 DPI 的位图 —— 用户只会在最后一页停下来。
   *   延迟之后，中途经过的页一个都不会真的跑。
   * ★ 为什么只在**伴读面板打开**时跑：OCR 的唯一用途是把这一页喂给伴读。面板没开时
   *   跑等于白花电，而用户翻书时最不缺的就是「后台在干活」。
   * ★ 为什么每页只自动试一次（`ocrAutoTriedRef`）：失败之后 `ocrNeeded` 仍然是 true，
   *   不记一笔的话这个 effect 会反复重试 —— 每翻回来一次就再糊一次错误。
   *   想再试就点按钮，那一次会如实报错。
   */
  /**
   * 换书时清掉「已自动试过」的记录。
   *
   * ★ 页号是**按书**的：第 60 页在 A 书里试过、失败，不该让 B 书的第 60 页也跟着
   *   被跳过。不清的话，症状是「换一本扫描书之后，某些页永远不自动识别」——
   *   而用户完全看不出规律。
   */
  useEffect(() => {
    ocrAutoTriedRef.current.clear();
  }, [book.id]);

  useEffect(() => {
    if (!companion || !ocrNeeded || doc === null) return undefined;
    if (ocrAutoTriedRef.current.has(page)) return undefined;
    const timer = setTimeout(() => {
      ocrAutoTriedRef.current.add(page);
      void runOcr({ quiet: true });
    }, OCR_AUTO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [companion, doc, ocrNeeded, page, runOcr]);

  // ---- 本书目录（抽取 → 分段）---------------------------------------------
  /**
   * 换书时重读这本书的目录状态。
   *
   * ★ 读失败**不当错误报**：`meta: null` 就是「还没抽取」，而宿主没接上解读路由时
   *   也是同一句话 —— 面板上会显示「还没有抽取这本书的目录」，用户点一下就知道
   *   到底能不能用。这里弹一个红色错误条反而会让人以为书坏了。
   */
  useEffect(() => {
    let cancelled = false;
    setDigestMeta(null);
    setDigestOutline([]);
    setDigestJob(null);
    setDigestGenerating(false);
    setDigestChapters({});
    setExpandedN(0);
    setSelectedN(null);
    digestRunning.current = false;
    (async () => {
      try {
        const body = await fetchDigestStatus(book.id);
        if (cancelled) return;
        setDigestMeta(body.meta ?? null);
        setDigestOutline(Array.isArray(body.outline) ? body.outline : []);
        // ★ 以宿主为准：换本书再换回来时，这本书可能正在后台生成。
        setDigestGenerating(body.generating === true);
      } catch {
        // 见上：这不是错误。
      }
    })();
    return () => { cancelled = true; };
  }, [book.id]);

  /**
   * 生成期间轮询状态。
   *
   * ★ 2.5 秒一次，而不是 1 秒：一章通常要十几到几十秒，1 秒一次的收益只是
   *   「进度条更顺滑」，代价是整本生成期间多出几百次请求。而这个接口只回
   *   meta（几百字节），本来很便宜 —— 但便宜不等于该浪费。
   * ★ 轮询**只读 status**，不预载各章解读正文：那是几十 KB，而用户可能一章都没展开。
   */
  useEffect(() => {
    if (!digestGenerating) return undefined;
    let cancelled = false;
    const tick = async () => {
      const body = await fetchDigestStatus(book.id).catch(() => null);
      if (cancelled || body === null) return;
      setDigestMeta(body.meta ?? null);
      if (Array.isArray(body.outline) && body.outline.length > 0) setDigestOutline(body.outline);
      if (body.generating !== true) {
        setDigestGenerating(false);
        // ★ 一批跑完就把勾选交回「默认」（所有待生成的章）。不重置的话，刚跑完的那几章
        //   在勾选里还留着，而它们的状态已经变成 `done` —— 用户再点一次按钮，
        //   就会把刚生成好的解读重跑一遍，再花一次钱。
        setSelectedN(null);
        const chapters = Array.isArray(body.meta?.chapters) ? body.meta.chapters : [];
        const failed = chapters.filter(chapter => chapter.status === 'failed').length;
        notify?.(failed > 0
          ? `解读生成完了，${failed} 章失败（可以再点一次重试）`
          : '解读生成完了');
      }
    };
    const timer = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [digestGenerating, book.id, notify]);

  /**
   * 读一次「解读用哪个模型」这个设置（`digestModel`）。
   *
   * ★ 只在挂载时读一次：它是个**全局设置**，与书无关。每次换书重读会让面板里刚选
   *   的模型被设置文件里的旧值覆盖回去（用户看到「我明明选了免费的，它自己跳回去了」）。
   */
  const settingsRead = useRef(false);
  useEffect(() => {
    if (settingsRead.current || typeof api?.getSettings !== 'function') return undefined;
    settingsRead.current = true;
    let cancelled = false;
    api.getSettings().then((body) => {
      if (cancelled) return;
      setDigestModel(body?.settings?.digestModel ?? '');
      // 书页配色同一趟读回来：它也是全局偏好，且同样「只在挂载时读一次」——
      // 换书重读会把用户刚在浮动条里切到的配色覆盖回去。
      setTint(normalizeBookTint(body?.settings?.bookTint));
      setBrightness(normalizeBookBrightness(body?.settings?.bookBrightness));
    }).catch(() => {
      // 读不到设置 ⇒ 按「跟随默认」处理（与宿主 `digestModel()` 的兜底同一个取值）。
      if (!cancelled) setDigestModel('');
    });
    return () => { cancelled = true; };
  }, [api]);

  /**
   * 目录面板打开时才去读模型列表。
   *
   * ★ 为什么不是一挂载就读：`listAiModels` 会逐个 provider 问（可能发真网络请求）。
   *   绝大多数用户打开阅读器是为了看书，不是为了解读 —— 不该让他为这个等一次网络。
   */
  useEffect(() => {
    if (!digestOpen || modelCatalog !== null || typeof api?.listAiModels !== 'function') return undefined;
    let cancelled = false;
    loadModelCatalog(api).then((value) => { if (!cancelled) setModelCatalog(value); });
    return () => { cancelled = true; };
  }, [digestOpen, modelCatalog, api]);

  // 卸载时中止抽取：否则循环会继续跑在已经消失的组件上，每批还会继续 POST。
  useEffect(() => () => { digestAbort.current?.abort(); }, []);

  /**
   * 抽取整本书并切章。
   *
   * ★ 抽取**不花钱**（纯本地 CPU），所以点一下就开始，不需要预检确认。
   *   花钱的是 P2 的「逐章生成」，那一步才需要把调用次数摆给用户看。
   *
   * ★ 断点续抽：从 `meta.task.cursor` 之后开始。用户抽到 180 页时关掉面板，
   *   回来点一下就是从 181 页接着走 —— 这是「每 20 页落一次盘」换来的。
   */
  const startDigest = useCallback(async () => {
    if (doc === null || status !== 'ready' || digestRunning.current) return;
    digestRunning.current = true;
    const controller = new AbortController();
    digestAbort.current = controller;
    const total = numPages || 1;
    setDigestJob({ running: true, done: 0, total, phase: 'extract' });
    try {
      const outlineEntries = await resolveOutline(doc);
      const existing = await fetchDigestStatus(book.id).catch(() => null);
      const cursor = Number(existing?.meta?.task?.cursor ?? 0);
      if (cursor < total) {
        await extractBookPages({
          doc,
          fromPage: cursor + 1,
          toPage: total,
          signal: controller.signal,
          onBatch: (batch) => postDigestPages(book.id, batch),
          onProgress: ({ done }) => setDigestJob({
            running: true, done: cursor + done, total, phase: 'extract',
          }),
        });
      }
      setDigestJob({ running: true, done: total, total, phase: 'segment' });
      const result = await postDigestSegment(book.id, { pageCount: total, outline: outlineEntries });
      setDigestOutline(Array.isArray(result.chapters) ? result.chapters : []);
      const after = await fetchDigestStatus(book.id).catch(() => null);
      setDigestMeta(after?.meta ?? null);
      setDigestJob(null);
      /**
       * ★ 把「实测是扫描版」记进书状态，书架那一行才能标出来 —— 否则用户下次还得
       *   再点一次「抽取目录」才知道这本书抽不出字。
       * ★ 抽出文字时**必须清掉**标记：同一本书换了文件（`reset` + 重抽）之后，
       *   留着旧标记等于给他一句已经过期的假话。
       * 写失败不影响本次抽取（标记是锦上添花），所以只吞掉。
       */
      saveBookState(book.id, { scanned: result.mode === 'scanned' }).catch(() => {});
      // 同时告诉书架那一侧：不用等下次刷新，左栏那一行当场就挂上标记。
      onScannedChange?.(book.id, result.mode === 'scanned');
      const count = Array.isArray(result.chapters) ? result.chapters.length : 0;
      notify?.(result.mode === 'scanned'
        ? '这本书是扫描版，没有可抽取的文字'
        : `已抽出 ${count} 章`);
    } catch (error) {
      if (error?.name === 'AbortError') {
        setDigestJob(null);
        return;
      }
      setDigestJob({ running: false, error: error?.message ?? '抽取失败' });
    } finally {
      digestRunning.current = false;
      digestAbort.current = null;
    }
  }, [doc, status, numPages, book.id, notify]);

  /** 「重新抽取」：书换过文件、或上次抽坏了。先删这本书的产物再走一遍。 */
  const rebuildDigest = useCallback(async () => {
    if (digestRunning.current) return;
    try {
      await resetDigest(book.id);
    } catch {
      // 删不掉也继续：`appendPages` 是追加式的，重抽会覆盖同名章节文件。
    }
    setDigestOutline([]);
    setDigestMeta(null);
    await startDigest();
  }, [book.id, startDigest]);

  /** 这一次要跑哪几章：用户没动过手时 = 「所有待生成的章」（与按钮上的数字同源）。 */
  const digestPlan = useMemo(() => planDigestRun(digestMeta), [digestMeta]);
  const selected = selectedN ?? digestPlan.todoN;

  /**
   * 勾 / 取消勾某一章。
   *
   * ★ 以**当前渲染出来的 `selected`** 为基准做加减，而不是在 updater 里再算一遍
   *   默认集合 —— 默认集合是 `planDigestRun(meta)` 派生的，两处各算一遍就会出现
   *   「勾上一个，另一个跟着跳」这种对不上的勾选（同一判据写两处的老问题）。
   */
  const toggleSelect = useCallback((n) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n); else next.add(n);
    setSelectedN([...next]);
  }, [selected]);

  const selectAll = useCallback(() => setSelectedN([...digestPlan.todoN]), [digestPlan]);
  const selectNone = useCallback(() => setSelectedN([]), []);

  /**
   * 换模型。写回设置（`digestModel`），下次打开面板还是它。
   *
   * ★ 写盘失败**不打断**：这一次生成用的仍是刚选的模型（它随请求发出去），
   *   失败的只是「记住」这件事 —— 为它弹一个红字报错，会让用户以为生成没开始。
   */
  const changeModel = useCallback((value) => {
    setDigestModel(value);
    api?.saveSettings?.({ digestModel: value }).catch(() => {});
  }, [api]);

  /**
   * 开始逐章生成解读。
   *
   * ★ 请求**立刻返回**（生成跑在宿主后台），所以这里只需要把 `generating`
   *   置 true 让轮询接上。真正的进度全靠 `status`。
   *
   * ★ 把**勾选的章**和**这一次的模型**一起发过去：不给的话宿主会按「所有没解读的章」
   *   跑整本（一本书几十次调用），而且会用它自己那份设置 —— 用户在面板里换的模型
   *   就被静默忽略了。
   * ★ `digestModel === null`（设置还没读到）时**不传** `model`，让宿主用它自己那份
   *   设置。传 `''` 会把「还没读到」变成「明确跟随默认」，静默丢掉用户设过的模型。
   */
  const startGenerate = useCallback(async () => {
    if (selected.length === 0) return;
    try {
      await postDigestGenerate(book.id, {
        bookTitle: book.title,
        chapters: [...selected],
        ...(digestModel === null ? {} : { model: digestModel }),
      });
      setDigestGenerating(true);
    } catch (error) {
      notify?.(error?.message ?? '没能开始生成解读');
    }
  }, [book.id, book.title, notify, selected, digestModel]);

  const stopGenerate = useCallback(async () => {
    try {
      await postDigestStop(book.id);
    } catch {
      // 停止请求失败也照样停轮询：宿主那边最多把当前这一章跑完，不会一直跑下去。
    }
    setDigestGenerating(false);
    notify?.('已停止生成；已经生成好的章节保留');
  }, [book.id, notify]);

  /**
   * 展开 / 收起某一章的要点。第一次展开才去取正文。
   *
   * ★ 展开与「跳到那一页」是**两个热区**（见 `BookDigestPanel` 的注释）：
   *   这个函数只负责展开，从不改变当前页。
   */
  const toggleChapter = useCallback(async (n) => {
    if (expandedN === n) {
      setExpandedN(0);
      return;
    }
    setExpandedN(n);
    if (digestChapters[n]?.status === 'ready') return;
    setDigestChapters(prev => ({ ...prev, [n]: { status: 'loading' } }));
    try {
      const body = await fetchChapterDigest(book.id, n);
      setDigestChapters(prev => ({ ...prev, [n]: { status: 'ready', digest: body.digest } }));
    } catch (error) {
      setDigestChapters(prev => ({
        ...prev,
        [n]: { status: 'error', error: error?.message ?? '读不出这一章的解读' },
      }));
    }
  }, [book.id, expandedN, digestChapters]);

  /**
   * 收起目录面板 —— 连带把「这一章的要点」浮层一起收掉。
   *
   * ★ 不连带的后果：目录关了、浮层还在，而浮层上唯一的指认（章号 + 标题）来自目录，
   *   用户会看到一个飘在页面上、不知道从哪来的卡片，也没有入口再关它（箭头在目录里）。
   */
  const closeDigest = useCallback(() => {
    setDigestOpen(false);
    setExpandedN(0);
  }, []);

  // ---- 划词：选中文字层里的字 → 气泡 ------------------------------------
  /**
   * 监听 `selectionchange` 并算出气泡该不该出现。
   *
   * ★ 挂在 `document` 上而不是书页上：拖选时鼠标可能已经滑出书页（选区仍属于
   *   文字层），`mouseup` 落在哪并不可靠。
   * ★ 只在 `ready` 时挂：加载中文字层是空的，挂着也只会得到一串 `null`。
   * ★ `setQuote` 里做一次相等判断：拖选时这个事件每帧都来，每次都造新对象会让
   *   整个书页（含画布）跟着重渲染 —— 拖选会明显发涩。
   */
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const read = () => {
      const selection = globalThis.getSelection?.();
      const next = selectionQuote(selection, textLayerRef.current);
      /**
       * 气泡和锚点必须**同时**更新：
       *   - 有气泡 ⇒ 顺手把字符偏移量出来（点按钮时选区已经没了，见 ref 上的说明）；
       *   - 没有气泡 ⇒ 锚点也必须清掉，否则「先选一段、再点空白」之后点划线的还是上一段。
       */
      quoteAnchorRef.current = next === null || selection === null || selection === undefined
        ? null
        : anchorOfRange(selection.rangeCount > 0 ? selection.getRangeAt(0) : null, textNodesOf(textLayerRef.current));
      setQuote((previous) => {
        if (next === null) return previous === null ? previous : null;
        if (previous !== null
          && previous.text === next.text
          && Math.abs(previous.top - next.top) < 1
          && Math.abs(previous.bottom - next.bottom) < 1) return previous;
        return next;
      });
    };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [status]);

  /** 换页 / 换书之后，上一页量好的偏移必须作废 —— 它指的是另一页的字符位置。 */
  useEffect(() => {
    quoteAnchorRef.current = null;
  }, [page, book.id]);

  /**
   * 「问伴读」：把这一句交给伴读的上下文，并把面板打开。
   *
   * ★ 不清空 `companionQuote`：气泡会随点别处消失，但伴读里的那一句必须留着 ——
   *   否则用户点完这个按钮、随手点一下页面，模型看到的上下文就被抽走了。
   *   它只在**换书**与**换页**时由 `BookCompanion` 的上下文键自然切换。
   */
  const askAboutQuote = useCallback(() => {
    if (quote === null) return;
    setCompanionQuote(quote.text);
    setCompanion(true);
    closeDigest();
    setFindOpen(false);
    setQuote(null);
  }, [quote, closeDigest]);

  /** 「复制」：把选中的原文放进剪贴板。 */
  const copyQuote = useCallback(async () => {
    if (quote === null) return;
    const text = quote.text;
    setQuote(null);
    try {
      await navigator.clipboard.writeText(text);
      notify?.('已复制选中的文字');
    } catch {
      // Electron 在极端情况下会拒（窗口失焦、权限被撤）；如实说，不假装成功。
      notify?.('复制失败：剪贴板不可用，请重试');
    }
  }, [quote, notify]);

  // ---- 划线 / 笔记 -------------------------------------------------------
  //
  // 三条边界，决定了下面这几段的形状：
  //   ① 数据在宿主（`annotations/<bookId>.json`），界面只持有服务端回过来的那份；
  //   ② 高亮层是**纯装饰**（`pointer-events: none`）：它一旦能接收点击，就没法
  //      在已经划过线的文字上拖选下一条；
  //   ③ 矩形的失效条件（缩放 / 换页 / 文字层重排）与数据的失效条件完全不同，
  //      所以量矩形单独一段，且以「文字层版本号」为触发条件。

  /** 打开一本书时取这本书的划线。失败**不打断阅读**，但要说一句。 */
  useEffect(() => {
    let cancelled = false;
    setAnnotations([]);
    fetchAnnotations(book.id).then(
      (items) => { if (!cancelled) setAnnotations(normalizeAnnotations(items)); },
      // eslint-disable-next-line no-console
      () => { if (!cancelled) notify?.('划线没读出来（不影响继续阅读）'); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  /**
   * 这一页的划线 → 像素矩形。
   *
   * ★ 依赖 `textLayerVersion`：文字层是异步渲的，`page`/`zoom` 刚变时容器里还没有
   *   文本节点，那一刻量出来是 0 个矩形。只依赖 `page` 的话症状是「翻过去线没了」。
   * ★ 量不出矩形**不当错误**：那多半是换过文件、文字层变了（偏移对不上）。条目
   *   仍然留在面板里 —— 让用户看到「我划过这一句」，比让它凭空消失好。
   */
  useEffect(() => {
    if (status !== 'ready') {
      setMarkRects(previous => (previous.length === 0 ? previous : []));
      return;
    }
    const layer = textLayerRef.current;
    if (layer === null) return;
    const nodes = textNodesOf(layer);
    /**
     * ★ 文字层是空的 ⇒ **把矩形清掉**，不能 `return`。
     *
     * 翻页时文字层先被清空（见上面那段 `textLayerRef.current.textContent = ''`），
     * 对**有文字的页**这只造成一瞬闪烁 —— 渲完 `textLayerVersion++` 会重算。
     * 但**扫描页 / 纯图片页的文字层永远是空的** ⇒ 永远不重算 ⇒ 上一页那些
     * 绝对定位的 `.npr-book-mark` 色块**留在新页面上**，位置还是上一页的。
     * 而这正是本项目主打的那个场景（扫描版 + 本机 OCR）。
     *
     * 原来写的是 `if (nodes.length === 0) return;` —— 那一行让「量不出矩形」与
     * 「这一页没有文字」变成同一件事，前者该保留旧值（见函数头注释），后者必须清空。
     */
    if (nodes.length === 0) {
      setMarkRects(previous => (previous.length === 0 ? previous : []));
      return;
    }
    const next = [];
    for (const item of annotationsOnPage(annotations, page)) {
      const range = rangeOfAnchor(layer, nodes, item.start, item.end);
      if (range === null) continue;
      const rects = rectsOfRange(range, layer);
      if (rects.length > 0) next.push({ id: item.id, tone: item.tone, rects });
    }
    setMarkRects((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
  }, [annotations, page, status, textLayerVersion]);

  /** 划一条。`openNote` 为真时顺手把面板打开并落在这一条的编辑框上。 */
  const createMark = useCallback(async ({ openNote = false } = {}) => {
    const layer = textLayerRef.current;
    const nodes = layer === null ? [] : textNodesOf(layer);
    const selection = globalThis.getSelection?.();
    // 优先用气泡出现时量好的偏移；万一没有（例如键盘选中后直接按了按钮），
    // 再退回现算一次 —— 两条路都失败才说「选不中」。
    const anchor = quoteAnchorRef.current ?? anchorOfRange(
      selection !== null && selection !== undefined && selection.rangeCount > 0 ? selection.getRangeAt(0) : null,
      nodes,
    );
    if (quote === null || anchor === null) {
      notify?.('这段选不中（不在文字层里），划不了线');
      return;
    }
    const text = quote.text;
    const covering = coveringAnnotation(annotations, { page, ...anchor });
    quoteAnchorRef.current = null;
    setQuote(null);
    selection?.removeAllRanges?.();
    if (covering !== null) {
      // 重复划线不是错误：把它高亮出来、让用户直接补笔记，比弹一句红字有用。
      setFindOpen(false);
      setMarksOpen(true);
      setMarkFocusId(openNote ? covering.id : '');
      notify?.('这一段已经划过了');
      return;
    }
    try {
      const result = await postAnnotation(book.id, {
        op: 'add',
        item: { page, start: anchor.start, end: anchor.end, quote: text },
      });
      setAnnotations(normalizeAnnotations(result.items));
      if (openNote && result.item !== undefined) {
        closeDigest();
        setCompanion(false);
        setFindOpen(false);
        setMarksOpen(true);
        setMarkFocusId(result.item.id);
        notify?.('已划线 —— 写一句为什么值得留');
      } else {
        notify?.('已划线');
      }
    } catch (error) {
      notify?.(error?.message ?? '划线没保存成功');
    }
  }, [annotations, book.id, closeDigest, notify, page, quote]);

  const updateMark = useCallback(async (id, patch) => {
    try {
      const result = await postAnnotation(book.id, { op: 'update', id, ...patch });
      setAnnotations(normalizeAnnotations(result.items));
    } catch (error) {
      notify?.(error?.message ?? '笔记没保存成功');
    }
  }, [book.id, notify]);

  const removeMark = useCallback(async (id) => {
    try {
      const result = await postAnnotation(book.id, { op: 'remove', id });
      setAnnotations(normalizeAnnotations(result.items));
      setMarkFocusId('');
      notify?.('已删除这条划线');
    } catch (error) {
      notify?.(error?.message ?? '删除失败');
    }
  }, [book.id, notify]);

  /** 开 / 关划线面板。与目录、伴读、要点浮层互斥（中间永远只留一栏）。 */
  const toggleMarks = useCallback(() => {
    setMarkFocusId('');
    if (marksOpen) {
      setMarksOpen(false);
      return;
    }
    // 互斥在**打开**这一侧做：关闭别的面板不会产生副作用，打开两个才会。
    closeDigest();
    setCompanion(false);
    setExpandedN(0);
    setFindOpen(false);
    setMarksOpen(true);
  }, [marksOpen, closeDigest]);

  const header = useMemo(() => {
    const parts = [book.ext.toUpperCase() || '文件', formatBytes(book.size)];
    if (book.series) parts.push(book.series);
    if (book.year > 0) parts.push(`${book.year} 年`);
    return parts.filter(Boolean).join(' · ');
  }, [book.ext, book.size, book.series, book.year]);

  if (status === 'unsupported') {
    return (
      <div className="npr-book-empty" role="status">
        <Icon name="file-check" size={24} />
        <h2>这种格式暂不支持阅读</h2>
        <p>
          内置阅读器认 PDF（原版式）与 EPUB / MOBI / AZW3 / TXT（重排）。
          这一本 {book.ext.toUpperCase() || '这种文件'} 不在其中 —— 它没有坏，
          只是本插件还没有对应它的渲染器。
        </p>
        {book.panPath !== '' && (
          <div className="npr-book-path">
            <span>网盘位置（可直接去网盘客户端打开）</span>
            <code>{book.panPath}</code>
          </div>
        )}
      </div>
    );
  }

  /**
   * 正在看要点的那一章（`null` = 没展开）。
   *
   * ★ 从 `outline` 里现查，而不是把 `expandedN` 直接交给浮层：重新抽取之后章号可能
   *   整体变了，旧章号查不到就自动收起 —— 比让浮层显示一个「第 12 章」而书里只剩
   *   8 章要好。
   */
  const expandedChapter = expandedN === 0
    ? null
    : (digestOutline.find(chapter => chapter.n === expandedN) ?? null);

  /**
   * 气泡放上方还是下方。
   * ★ 判据在 `quoteBarPlacement` 里（选区上方是否还有位置），不在这里 —— 那是几何，
   *   要能被单测和真 Chrome 脚本共用同一份。
   */
  const quotePlacement = quote === null ? null : quoteBarPlacement(quote);

  /**
   * 右下角那一列 7 格的圆心偏移（相对浮动按钮的圆心）。
   *
   * ★ 高度与顶部预留都来自**面板**（`frame`），不是窗口、也不是舞台：按钮钉在面板的
   *   右下角，`frame.height` 定可用高度，`frame.top`（拖动条 + 胶囊 + 元信息）是
   *   不许侵入的那一带。只按高度算的话，420px 高的面板里最上面那格会盖住胶囊。
   * ★ 还没量到尺寸时 `fabStack` 按默认间隙算，不要用 0 —— 0 会让 7 格全叠在
   *   按钮身上，首帧看起来像界面坏了。
   */
  const stack = fabStack({ count: 7, height: frame?.height ?? 0, top: frame?.top ?? 0 });
  /**
   * 每一格的位置写进 **CSS 变量**，不直接写 `transform`。
   *
   * ★ 收起态要把 7 格收回到按钮圆心里（`translate(0, 0) scale(.5)`），展开态才用
   *   这两个变量。直接写 `transform` 的话，收起态那个「归位」值就没地方放了 ——
   *   而「从按钮里长出来」的动画正是靠这条属性过渡出来的。
   * ★ `--npr-fab-i` 是序号，CSS 用它算逐格延迟（贴着按钮的那格先出来）。
   */
  const slotStyle = (index) => ({
    '--npr-fab-x': `${stack[index].x}px`,
    '--npr-fab-y': `${stack[index].y}px`,
    '--npr-fab-size': `${stack[index].size}px`,
    '--npr-fab-i': index,
  });

  return (
    <div ref={bookRef} className={`npr-book${immersive ? ' is-immersive' : ''}${immersive && peek ? ' is-peek' : ''}${immersive && (digestOpen || marksOpen || findOpen) ? ' has-side' : ''}`}
      data-tint={tint} style={{ '--npr-book-brightness': brightness }}
      onPointerMove={onPeekPointerMove} onPointerLeave={onPeekPointerLeave}>
      {/* ---- 顶部：一条 10px 的拖动条 + 一颗**居中的工具胶囊** ----------------
          ★ 谁在顶部、谁在右下角（用户 2026-10-23 第三轮定的分工）：
            · **顶部胶囊** = 与「这本书」有关的**开关类**动作：标记读完 / 伴读 / 划线 /
              目录 / 配色 / 沉浸。它们不改变页面尺寸，点开只是多一栏或换一层色，
              放在顶上（读的时候不常点，也不该占着右下角那块「鼠标常去」的地方）。
            · **右下角扇出** = 与「当前这一页」有关的**调档类**动作：页码 / 上下页 /
              适宽 / 适应窗口 / 放大 / 缩小。这些是连续微调，贴在书页右下角比跑到
              顶上找更顺手。
          ★ 胶囊留在**正常流**里、不再浮着：它下面紧接着是元信息行，浮起来就会压住
            那一行小字，而那一行带 `pointer-events: none` —— 压住的地方连划选都点不到。
          ★ 拖动条仍然要在（10px、透明）：窗口拖动是宿主的机制，需要一条带
            `data-window-drag` 的元素，且必须**有面积**（0 高度拿不到命中测试）。 */}
      <div className="npr-book-toolbar" data-window-drag />

      <div className="npr-book-chrome">
        <div className="npr-book-pill" role="toolbar" aria-label="本书工具">
          <span className="npr-book-pill-title" title={book.title}>{book.title}</span>
          <button type="button" className={`npr-book-pill-item${current.state === 'read' ? ' is-on' : ''}`}
            title="标记读完" aria-pressed={current.state === 'read'} onClick={() => onFinished?.()}>
            <Icon name="circle-check" size={14} />
            <span>{current.state === 'read' ? '已读完' : '标记读完'}</span>
          </button>
          <button type="button" className={`npr-book-pill-item${companion ? ' is-on' : ''}`}
            title="AI 伴读（A）：带着当前这一页追问" aria-pressed={companion}
            onClick={() => { setCompanion((value) => !value); closeDigest(); setMarksOpen(false); setFindOpen(false); }}>
            <Icon name="wand-sparkles" size={14} />
            <span>伴读</span>
          </button>
          <button type="button" className={`npr-book-pill-item${marksOpen ? ' is-on' : ''}`}
            title={annotations.length > 0 ? `划线 / 笔记：${annotations.length} 条` : '划线 / 笔记（还没有划线）'}
            aria-pressed={marksOpen} onClick={toggleMarks}>
            <Icon name="highlighter" size={14} />
            <span>{annotations.length > 0 ? `划线 ${annotations.length}` : '划线'}</span>
          </button>
          <button type="button" className={`npr-book-pill-item${findOpen ? ' is-on' : ''}`}
            title="书内搜索（⌘F）：在整本正文里找，回车 / ↓ 上下条跳转" aria-pressed={findOpen}
            onClick={toggleFind}>
            <Icon name="search" size={14} />
            <span>搜索</span>
          </button>
          <button type="button" className={`npr-book-pill-item${digestOpen ? ' is-on' : ''}`}
            title={digestOutline.length > 0 ? '本书目录' : '抽取本书目录（只在本机做，不花钱）'}
            aria-pressed={digestOpen}
            onClick={() => { if (digestOpen) closeDigest(); else { setDigestOpen(true); setCompanion(false); setMarksOpen(false); setFindOpen(false); } }}>
            <Icon name="bookmark" size={14} />
            <span>
              {digestJob?.running === true
                ? `抽取 ${Math.round((digestJob.done / Math.max(1, digestJob.total)) * 100)}%`
                : digestOutline.length > 0 ? `目录 ${digestOutline.length}` : '目录'}
            </span>
          </button>
          {/* 配色是这一组里**唯一带面板**的：面板挂在按钮的父节点上（`position: relative`），
              从它下面展开 —— 挂到胶囊上会从整颗胶囊的中间掉下来，看起来不像「这个按钮的」。 */}
          <span className="npr-book-pill-tint">
            <button type="button" className={`npr-book-pill-item${paletteOpen ? ' is-on' : ''}`}
              title={`书页配色：${BOOK_TINTS[tint]}（按 N 轮转）`} aria-pressed={paletteOpen}
              onClick={() => setPaletteOpen((value) => !value)}>
              {/* ★ 图标写成外层三元、两个各自的字面量：`test/icons.test.mjs` 会把
                  `name={…}` 里的每个字符串都当图标名核对。 */}
              {tint === 'night' ? <Icon name="moon" size={14} /> : <Icon name="sun" size={14} />}
              <span>配色 · {BOOK_TINTS[tint]}</span>
            </button>
            {paletteOpen && (
              <div className="npr-book-palette" role="dialog" aria-label="书页配色">
                <div className="npr-book-palette-dim">
                  <Icon name="sun" size={13} />
                  <input type="range" aria-label="书页亮度"
                    min={BOOK_BRIGHTNESS.min} max={BOOK_BRIGHTNESS.max} step={BOOK_BRIGHTNESS.step}
                    value={brightness}
                    onChange={(event) => applyBrightness(event.target.value)}
                    onPointerUp={persistBrightness}
                    onBlur={persistBrightness} />
                  <span>{Math.round(brightness * 100)}%</span>
                </div>
                <p className="npr-book-palette-label">颜色</p>
                <div className="npr-book-swatches" role="radiogroup" aria-label="书页颜色">
                  {Object.keys(BOOK_TINTS).map((key) => (
                    <button key={key} type="button" className="npr-book-swatch" data-tint={key} role="radio"
                      aria-checked={tint === key} aria-label={BOOK_TINTS[key]} title={BOOK_TINTS[key]}
                      onClick={() => applyTint(key)}>
                      {key === 'night' && <Icon name="moon" size={12} />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </span>
          <button type="button" className={`npr-book-pill-item${immersive ? ' is-on' : ''}`}
            title={immersive ? '退出沉浸式阅读（Esc）' : '沉浸式阅读（I）：收掉工具栏与书架列，窗口大小不变；顶部工具条鼠标移上去会滑出，全屏按 ⌃⌘F'}
            aria-pressed={immersive} onClick={toggleImmersive}>
            <Icon name="maximize" size={14} />
            <span>沉浸</span>
          </button>
        </div>
      </div>

      {/* 元信息行：**不显示书名**（用户 2026-10-23 第五轮明确要求）。
          ★ 书名已经在顶部胶囊里（`.npr-book-pill-title`），书架列里也有一份 ——
            这一行再重复一次，读者视线每翻一页都要先扫过一串重复的字。
          ★ 留下的全是「此刻的状态」：格式与大小、读到几成、上次停在哪页、当前档位。 */}
      <div className="npr-book-meta">
        <span>{header}</span>
        {percent !== null && <span>读到 {percent}%</span>}
        {current.state === 'reading' && current.page > 0 && <span>上次读到第 {current.page} 页</span>}
        <span>{mode === FIT_PAGE ? '整页适应窗口' : '适应宽度'} · {Math.round(zoom * 100)}%</span>
        <span className="npr-book-keys">← → ↑ ↓ 翻页 · ⌘F 搜索 · I 沉浸 · N 配色</span>
      </div>


      {/*
        ★ 两块面板分居两侧，各按自己的用途定位置（0.19.0）：
          · **目录在左** —— 导航类。电子书阅读器的通行摆法：视线从左上往下扫目录、
            再落到右边的正文。
          · **伴读在右** —— 对话类。与订阅那半边的伴读同侧，用户不必为同一件事
            在两个方向上来回找。
          两者互斥（工具栏按钮互相关闭对方），所以中间永远只有正文一栏。
        ★ 顺序靠 **DOM**（目录写在 stage 前面、伴读写在 stage 后面），不靠 CSS
          `order` —— 读屏软件与 Tab 顺序跟着 DOM 走，用 `order` 把视觉挪走而 DOM
          不变，键盘用户会先跳进右边的正文、再 Tab 回左边的目录。
          窄容器下要「书页在上、面板在下」，那时才用 `order`（见 refinements.css
          的 @container 块）。
      */}
      <div className="npr-book-main">
        {findOpen && (
          <BookFindPanel
            query={findQuery}
            onQuery={setFindQuery}
            status={findState.status}
            error={findState.error}
            hits={findHits.map(hit => ({
              key: `h${hit.index}`,
              where: `第 ${hit.page} 页`,
              snippet: hit.snippet,
              // 只有识别来的命中才带这个标记：文字层里的命中是**书上真有的字**，
              // 加个标记反而让人以为它可疑。
              ...(hit.via === 'ocr' ? { via: 'ocr' } : {}),
            }))}
            activeIndex={findActive}
            progress={findState.total > 0 ? { done: findState.done, total: findState.total } : null}
            unit="page"
            /**
             * 扫描页的补救出口。
             *
             * ★ 只在**这一轮检索已经跑完**时给（`status === 'done'`）：搜索中途
             *   `textlessPages` 还在长，那时按下去识别的是「目前看到的那些」，
             *   跑完一重搜又冒出一批新的 —— 用户会以为按钮没效果。
             */
            ocr={findOcr.running
              ? { running: true, done: findOcr.done, total: findOcr.total, note: '' }
              : (findState.status === 'done' && findState.textlessPages.length > 0
                ? {
                  running: false, done: 0, total: findState.textlessPages.length, note: findOcr.note,
                }
                : null)}
            onOcr={() => { void runFindOcr(); }}
            onOcrStop={stopFindOcr}
            notes={[
              ...(findState.textless > 0
                ? [`另有 ${findState.textless} 页没有文字层（扫描页），这次没有检索它们`]
                : []),
              ...(findHits.some(hit => hit.via === 'ocr')
                ? ['带「识别」标记的命中来自本机文字识别（可能有错字），跳到那一页时标不出具体位置']
                : []),
              ...(findState.truncated ? [`命中到 ${FIND_LIMIT_MAX} 处就停下了 —— 后面还有没有，这次没查完`] : []),
            ]}
            onPick={jumpToFind}
            onStep={stepFind}
            onClose={() => setFindOpen(false)}
          />
        )}
        {marksOpen && (
          <AnnotationPanel
            items={annotations}
            title={book.title}
            bookId={book.id}
            focusId={markFocusId}
            onJump={(target) => go(target)}
            onUpdate={(id, patch) => { void updateMark(id, patch); }}
            onRemove={(id) => { void removeMark(id); }}
            onClose={() => { setMarksOpen(false); setMarkFocusId(''); }}
          />
        )}
        {digestOpen && (
          <BookDigestPanel
            book={book}
            meta={digestMeta}
            outline={digestOutline}
            job={digestJob}
            currentPage={page}
            generating={digestGenerating}
            expandedN={expandedN}
            selected={selected}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
            modelValue={digestModel ?? ''}
            modelCatalog={digestModel === null ? null : modelCatalog}
            onModelChange={changeModel}
            onStart={startDigest}
            onRebuild={rebuildDigest}
            onJump={(target) => go(target)}
            onClose={closeDigest}
            onGenerate={startGenerate}
            onStop={stopGenerate}
            onToggleChapter={toggleChapter}
            onNotify={notify}
          />
        )}

        {/* 阅读区 = 舞台 + 右下角那颗浮动按钮，**共用同一个定位基准**（0.24.3）。
            ★ 用户原话：「悬浮按钮要始终显示在电子书阅读的区域。」
              以前按钮是 `.npr-book` 的直接子节点 ⇒ 它钉在**整个面板**的右下角：
              一开伴读（右侧多一栏）它就跑到伴读面板的角上，看着像伴读的按钮。
            ★ 也不能把它放进 `.npr-book-stage`：舞台是 `overflow: auto` 的滚动容器，
              绝对定位的子节点会跟着内容一起滚走 —— 往下翻两页按钮就没了。
            ⇒ 中间加这一层：不滚动、不参与布局的宽高（`flex: 1` 撑满），只当定位基准。 */}
        <div className="npr-book-view">
          <div ref={stageRef} className="npr-book-stage">
            {status === 'loading' && <div className="npr-book-hint" role="status">正在取书…（只取需要的几段，不会整本下载）</div>}
            {status === 'error' && (
              <div className="npr-book-error" role="alert">
                <Icon name="info" size={22} />
                <h2>这本书暂时打不开</h2>
                <p>{error}</p>
                <button type="button" onClick={() => {
                  // 缓存里可能留着一份「解析成功了但用起来就出错」的文档；不清掉的话
                  // 重试会原样命中同一份，永远失败。
                  forgetBook(book.id);
                  setStatus('loading');
                  setAttempt((value) => value + 1);
                }}>重试</button>
              </div>
            )}
            {/* 书页：画布 + 透明文字层 + 划词气泡，三者共用同一块定位基准。
                ★ 文字层（`.npr-book-text`）里是真的文字，但每个字都透明 —— 看得见的
                  仍是下面的画布位图。它存在的**唯一目的**就是让这一页可被选中、复制、
                  ⌘F 找到、以及划词追问：位图里没有任何可选的文本节点。
                ★ 不给文字层 `aria-hidden`：它是这一页唯一的文字来源，藏掉之后读屏用户
                  会得到一块空白。画布反过来要藏（它是同一段内容的视觉副本）。
                ★ 画布始终在树上：pdf.js 需要一个稳定的目标节点，卸载重挂会让正在跑的
                  渲染任务指向一个已经脱离文档的画布（症状是空白页）。 */}
            <div className={`npr-book-sheet${status === 'ready' ? '' : ' is-hidden'}`}>
              <canvas ref={canvasRef} className="npr-book-canvas" aria-hidden="true" />
              {/* 纸色覆盖层（0.24.3）。★ 用户报的：「护眼颜色选择为什么改变不了电子书
                  内容的背景」—— 因为 PDF 是**位图**，白纸是画在像素里的，改 CSS 底色
                  对它毫无作用。只能压一层乘算的颜色：白纸 × 米黄 = 米黄，黑字 × 米黄
                  ≈ 黑字（`mix-blend-mode: multiply`，见 refinements.css）。
                  ★ 位置必须在**画布之上、文字层与划线层之下**：那两层要保持原色，
                    否则选中的高亮、划线的色块也会被一起染成纸色。 */}
              <div className="npr-book-tint" aria-hidden="true" />
              <div ref={textLayerRef} className="npr-book-text" />
              {/* 高亮层：**纯装饰**。`pointer-events: none` 是硬要求 ——
                  它一旦能接点击，划过线的文字就没法再拖选（而拖选是划下一条的入口）。
                  编辑一律走左边的面板。 */}
              {markRects.length > 0 && (
                <div className="npr-book-marks" aria-hidden="true">
                  {markRects.map(mark => mark.rects.map((rect, index) => (
                    <span key={`${mark.id}-${index}`} className="npr-book-mark" data-tone={mark.tone}
                      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
                  )))}
                </div>
              )}
              {/* 搜索命中层（0.26.0）：**另一层**，不是往划线层里塞。
                  两层语义不同（搜索是临时的、划线是存下来的），叠在一起时
                  当前命中必须压在最上面 —— 所以它是 z-index 3，见 CSS。 */}
              {findRects.length > 0 && (
                <div className="npr-book-finds" aria-hidden="true">
                  {findRects.map(item => item.rects.map((rect, index) => (
                    <span key={`${item.key}-${index}`} className={`npr-book-find${item.active ? ' is-current' : ''}`}
                      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
                  )))}
                </div>
              )}
              {/* ★ 0.25.9：这里原本有一条「这一页没有文字层（扫描图片），选不中文字」的
                  常驻说明（0.20.5 加的），现在**删掉**了。用户原话：「这个提示不要了」。
                  理由不是「它错」，而是它**已经没有信息量**了：
                  ① 扫描页现在会自动本机 OCR（0.24.8），伴读面板里会写「已识别 N 字 ·
                     已交给伴读」，文字从哪儿来、能不能看，那里说得更准；
                  ② 这一页是不是扫描页，**看一眼就知道**（整页是图片）—— 再用一条
                     压在书页下沿的胶囊重复一遍，只是每翻一页闪一次噪音；
                  ③ 它是 `pointer-events: none` 的绝对定位浮层，翻页瞬间闪一下还容易被
                     误读成「出错了」。
                  ⇒ 随之删掉的还有 `textless` 状态与 `.npr-book-notice` 样式（类名一旦
                    「定义但没人用」，`scripts/check-classes.mjs` 会红）。 */}
              {quote !== null && quotePlacement !== null && (
                <div className="npr-book-quotebar" role="toolbar" aria-label="选中的文字"
                  style={quotePlacement.side === 'above'
                    ? { left: quoteBarLeft(quote.centerX), bottom: quotePlacement.value }
                    : { left: quoteBarLeft(quote.centerX), top: quotePlacement.value }}>
                  <span className="npr-book-quotebar-text" title={quote.text}>{quote.text}</span>
                  {/* 划线是这颗气泡的**主操作**（最常点），所以放前面。
                      「笔记」= 划线 + 立刻写一句：写完的那份摘录留在左边的面板里。
                      ★ `onMouseDown` 阻止默认行为：不阻止的话按下去浏览器就把选区收掉了，
                        虽然我们已经把偏移存进 ref，但**保住选区**能让「点错了再点一次」仍然有效。 */}
                  <button type="button" className="is-primary"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { void createMark({ openNote: false }); }}>划线</button>
                  <button type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { void createMark({ openNote: true }); }}>笔记</button>
                  <button type="button" onClick={askAboutQuote}>问伴读</button>
                  <button type="button" onClick={() => { void copyQuote(); }}>复制</button>
                </div>
              )}
            </div>
          </div>
          {/* ---- 右下角：一颗圆按钮，**悬停即向上摊开一列**（0.24.3 改回悬停）-----
              ★ 形态照用户给的那张图：每格是「圆形图标 + 左侧文字标签」，7 格竖直排成一条
                微微向内弯的带子，最下面那格紧贴按钮。0.22.0 那版是绕按钮 90° 扇开的一串
                圆片：没有文字、看不出是干什么的，7 个圆还挤在书页右下角（用户原话「丑爆了」）。
              ★ **悬停展开**（用户：「鼠标移到图标上就弹出，不要点击」）。0.23.0 曾把它
                改成纯点击，理由是「按钮与第一格之间有空隙，`:hover` 掉在空隙里整列就回收」
                —— 那个观察是对的，结论错了：**空隙问题是「没有宽限期」造成的**，
                不是「hover 展开在这个几何里不成立」。现在离开整棵子树后先等
                `FAB_HOVER_GRACE` 再收，指针越过空隙（几毫秒）或落到某一格上都会取消它。
              ★ 点击仍然保留（触屏与键盘没有 hover）：点一下是「钉住 / 收起」的显式开关。
              ★ 位置用 **CSS 变量**（`--npr-fab-x/y`）：收起态要把 7 格收回按钮圆心
                （`translate(0,0) scale(.5)`），展开态才用这两个变量 —— 写死 `transform`
                的话收起态没地方放「归位」那个值，动画也就没了。
              ★ 延迟按序号递增（`--npr-fab-i`）：贴着按钮的那格先出来，整列像被抽出来。 */}
          <div ref={fabRef} className={`npr-book-fab${fabOpen ? ' is-open' : ''}`}
            onPointerEnter={onFabEnter} onPointerLeave={onFabLeave}>
            <button type="button" className="npr-book-fab-button"
              aria-expanded={fabOpen} aria-haspopup="true" aria-controls="npr-book-fab-list"
              aria-label={fabOpen ? '收起翻页与缩放' : '展开翻页与缩放'}
              title={fabOpen ? '收起（Esc）' : '翻页 / 缩放'}
              onClick={toggleFab}>
              <Icon name="settings" size={18} />
            </button>
            {/* `--npr-fab-span` 是那根竖直导轨的长度：从按钮圆心一直到最上面那格的圆心。
                它由同一份 `fabStack` 的结果算出，所以矮面板里直径一缩、导轨跟着缩。 */}
            <div id="npr-book-fab-list" className="npr-book-fab-list" role="group" aria-label="翻页与缩放"
              style={{ '--npr-fab-span': `${Math.abs(stack[0].y)}px` }}>
              {/* 从上到下。**页码在最上面**：它是整组里唯一要手输的一格，放在离按钮最远处，
                  不会在连点翻页时被误触（误触一个数字框，接下来的方向键就跑去改页码了）。 */}
              <label className="npr-book-fab-slot is-page" style={slotStyle(0)}
                title={`跳到第几页（共 ${numPages || '—'} 页）`}>
                <input className="npr-book-page" type="text" inputMode="numeric" aria-label="页码" value={pageDraft}
                  onChange={(event) => setPageDraft(event.target.value.replace(/[^\d]/g, ''))}
                  onBlur={() => go(Number(pageDraft))}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); go(Number(pageDraft)); event.currentTarget.blur(); } }} />
                <span className="npr-book-fab-label">页码</span>
              </label>
              <button type="button" className="npr-book-fab-slot" style={slotStyle(1)}
                title="上一页（←）" aria-label="上一页" disabled={page <= 1}
                onClick={() => go(page - 1, { toBottom: true })}>
                <Icon name="chevron-left" size={16} />
                <span className="npr-book-fab-label">上一页</span>
              </button>
              <button type="button" className="npr-book-fab-slot" style={slotStyle(2)}
                title="下一页（→）" aria-label="下一页"
                disabled={numPages === 0 || page >= numPages} onClick={() => go(page + 1)}>
                <Icon name="chevron-right" size={16} />
                <span className="npr-book-fab-label">下一页</span>
              </button>
              <button type="button" className={`npr-book-fab-slot${mode === FIT_WIDTH ? ' is-on' : ''}`}
                style={slotStyle(3)}
                title="适应宽度（W）：按面板宽度铺满，长页可以上下滚" aria-label="适应宽度" aria-pressed={mode === FIT_WIDTH}
                onClick={() => { setMode(FIT_WIDTH); setZoom(1); }}>
                <Icon name="fit-width" size={16} />
                <span className="npr-book-fab-label">适宽</span>
              </button>
              <button type="button" className={`npr-book-fab-slot${mode === FIT_PAGE ? ' is-on' : ''}`}
                style={slotStyle(4)}
                title="适应窗口（P）：整页缩进面板里，一屏看完" aria-label="适应窗口" aria-pressed={mode === FIT_PAGE}
                onClick={() => { setMode(FIT_PAGE); setZoom(1); }}>
                <Icon name="fit-page" size={16} />
                <span className="npr-book-fab-label">适应窗口</span>
              </button>
              <button type="button" className="npr-book-fab-slot" style={slotStyle(5)}
                title="放大（+）" aria-label="放大" disabled={zoom >= ZOOM_MAX - 1e-6}
                onClick={() => setZoom((value) => stepZoom(value, 1))}>
                <Icon name="plus" size={16} />
                <span className="npr-book-fab-label">放大</span>
              </button>
              <button type="button" className="npr-book-fab-slot" style={slotStyle(6)}
                title="缩小（-）" aria-label="缩小" disabled={zoom <= ZOOM_MIN + 1e-6}
                onClick={() => setZoom((value) => stepZoom(value, -1))}>
                <Icon name="minus" size={16} />
                <span className="npr-book-fab-label">缩小</span>
              </button>
            </div>
          </div>
        </div>

        {/* 伴读在**书页右边**：它是对话类，与订阅那半边的伴读同侧。
            DOM 写在 stage 之后，横排时天然在右；竖排时由 @container 里的 `order`
            把它压到书页下面（与目录那一格同款处理）。 */}
        {companion && (
          <BookCompanion
            api={api}
            context={{
              bookId: book.id,
              title: book.title,
              page,
              pages: numPages,
              loaded: textLoaded,
              text: contextText,
              // 用户刚划的那一句（空串 = 没划）。进上下文键，所以划一次只重绑一次。
              quote: companionQuote,
            }}
            onOcr={runOcr}
            ocrNeeded={ocrNeeded}
            ocrUsed={ocrUsed}
            ocrBusy={ocrBusy}
            ocrError={ocrError}
            ocrText={ocrText}
            onClose={() => setCompanion(false)}
            onManagePrompts={onManagePrompts}
            SessionProvider={SessionProvider}
            renderSlot={renderSlot}
          />
        )}

        {/* 这一章的要点：**浮在阅读区上**的一张卡，不占布局宽度。
            ★ 不做成第三列：那会改变舞台宽度 ⇒ `ResizeObserver` 触发 ⇒ 整页重画一次位图，
              翻页手感当场变差（而用户只是想在旁边看一眼要点）。 */}
        {expandedChapter !== null && (
          <DigestCard
            chapter={expandedChapter}
            entry={digestChapters[expandedN]}
            onClose={() => setExpandedN(0)}
            onJump={(target) => go(target)}
          />
        )}
      </div>
    </div>
  );
}
