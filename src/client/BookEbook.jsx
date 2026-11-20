/**
 * 重排电子书阅读器：EPUB / MOBI / AZW3 / AZW / TXT。
 *
 * 六个刻意的设计：
 *
 * 1. **正文由宿主解析，这里只画**。ZIP 解压、PalmDOC 解 LZ77、TXT 嗅探编码全在
 *    `src/host/ebook/` 里做，且落盘缓存（`~/.dsh/storages/dsh-npie-reader/ebooks/`）。
 *    浏览器侧再解一遍的后果是每开一本书都要重算一次，更要紧的是「抽章解读」在宿主
 *    侧跑的是另一套解析 —— 同一个文件在阅读器里和在解读里节数不同，最难查的一类错。
 * 2. **块模型 → React 元素，不用 `dangerouslySetInnerHTML`**。书是外部文件，
 *    里面可以有任何东西；块模型只留「标题 / 段落 / 引用 / 列表 / 代码」这一层语义，
 *    XSS 面为零。代价是丢掉粗体、字号、缩进这些**排版**信息 —— 而 EPUB 本来就是
 *    「可重排」格式，它的原版式由阅读设备决定，不存在可还原的「原版式」。
 * 3. **一节 = 一「页」= 目录的一条**。目录条目、阅读进度、解读的页号全都用同一个数
 *    （节号），少一层 ±1 转换就少一处偏移 bug。翻页是换节，节内滚动交给浏览器。
 *    ★ 粒度由**正文的标题**决定，不是 EPUB 的 XHTML 文件：一个文件装一整卷的书
 *    会在宿主侧被 `splitByHeadings` 按小标题切开（见 `src/host/ebook/split.js`），
 *    否则「一次翻一整卷 1.5 万字」既不像纸质书，目录点小节也只能回到卷首。
 * 4. **字号 / 行距 / 版心宽度 / 字体 / 纸色全部复用「阅读外观」那套设置**
 *    （`reading-settings.js`）。电子书正文是**真文字**，和 RSS 正文是同一类东西；
 *    给它单开一套设置只会让用户在两个地方调同一件事。
 * 5. **解不开的格式如实说**（DRM、HUFF/CDIC、缺章节），并给出下一步能做什么
 *    （去 calibre 转 EPUB）。通用的「打不开」会让用户以为书坏了。
 * 6. **一个 `tabIndex` 都不许有**：`.npr-book-toolbar` 是窗口拖动行，宿主对拖动区
 *    做的是「先求并、再把 no-drag 矩形求差」，任何祖先带 `tabindex` 都会把整块
 *    拖动区减掉。键盘快捷键走 window 级监听。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FIND_LIMIT_MAX } from '../book-find.js';
import { blockSegments, mapOfEntries } from '../ebook-translate.js';
import { formatBytes, isEbookExtension, stateOf } from '../library.js';
import { AnnotationPanel } from './AnnotationPanel.jsx';
import { BookCompanion } from './BookCompanion.jsx';
import { BookDigestPanel } from './BookDigestPanel.jsx';
import { BookEbookToc } from './BookEbookToc.jsx';
import { BookFindPanel } from './BookFindPanel.jsx';
import { DigestCard } from './DigestCard.jsx';
import {
  annotationsOnPage, coveringAnnotation, normalizeAnnotations,
} from './annotations.js';
import { quoteBarLeft, quoteBarPlacement, selectionQuote } from './book-text.js';
import { insidePanel, peekNext, peekOnLeave } from './book-peek.js';
import {
  anchorOfSelection, blockSpans, marksForBlock, splitByOverlays,
} from './ebook-marks.js';
import { withoutMismatch } from '../annotation-relocate.js';
import { useEbookExport } from './ebook-export.js';
import { outlineEntries, runningHead } from './ebook-outline.js';
import { Icon } from './icons.jsx';
import {
  fetchAnnotations, fetchEbookFind, fetchEbookIndex, fetchEbookSection,
  fetchEbookTranslation, fetchEbookTranslationIndex, postAnnotation, postDigestEbook,
  postEbookTranslation, saveBookState,
} from './library-api.js';
import { fabStack } from './book-view.js';
import {
  EBOOK_READ_MODES, EBOOK_READ_MODE_ORDER, fontStack, normalizeEbookReadMode,
} from '../reading-settings.js';
import { useBookDigest } from './use-digest.js';
import { nextSleepMinutes, nextSpeechRate, sleepLabel, useEbookSpeech } from './ebook-speech.js';
import { useTranslateJobs } from './translate-hub.js';

/**
 * 纸色档位 → `[背景, 前景]`。
 *
 * ★ 与 `ReaderPage` 里那份**必须一致**：同一个用户在文章里选「纸张」、打开一本
 *   EPUB 却看到另一种米黄，会以为设置没生效。两份字面量的来源是同一组设计值，
 *   所以这里照抄而不是「引用」—— `THEMES` 里 `auto` 是 `null`（跟随宿主），
 *   而书页需要一个具体值才能画出来。
 */
const THEME_COLORS = {
  light: ['#ffffff', '#202124'],
  paper: ['#f5efdf', '#40382e'],
  sage: ['#e8eee3', '#29382c'],
  mist: ['#e7edf2', '#293741'],
  dark: ['#252525', '#dedede'],
  black: ['#090909', '#cccccc'],
};

/** 纸色的轮转顺序（「配色」按钮与 N 键共用）。`auto` 不参与轮转。 */
const TINT_ORDER = ['light', 'paper', 'sage', 'mist', 'dark', 'black'];
const TINT_LABEL = { auto: '跟随外观', light: '白色', paper: '纸张', sage: '护眼', mist: '雾蓝', dark: '深色', black: '纯黑' };

/** 字号档位（与 `reading-settings.js` 的校验区间同一对边界）。 */
const FONT_MIN = 14;
const FONT_MAX = 32;

/** 一次取多少节做「预取」。1 = 只取当前节，翻页时才取下一节。 */
const PREFETCH = 1;

/**
 * 块 → React 元素。
 *
 * ★ 连续的 `li` 要**合进同一个 `<ul>`**：逐块渲染 `<li>` 在浏览器里也能显示，
 *   但读屏软件会念成一串孤立条目，而段落顺序的语义也就丢了。
 * ★ 每个块用自己的下标做 key：正文是只读的、不会重排，下标完全够用，而
 *   拼字符串 key（`${i}-${block.x}`）会让超长段落每次都算一遍哈希。
 * ★ 每个块都带 `data-block={index}`，**划线锚点靠它**认出「这个选区落在第几块」
 *   （见 `ebook-marks.js`）。删掉它等于把划线功能整个废掉，而且不会报错 ——
 *   只会表现为「拖选了却划不出线」。
 *
 * @param {'bilingual'|'translation'} mode 只有这两种会传进来（`original` 时
 *   `zhMap` 恒为 `null`，等于老行为）。两者的差别只有一句：
 *   **`translation` 用译文替换正文，`bilingual` 把译文接在正文下面。**
 *
 * ★ 导出只为测试：`test/book-hooks-render.test.mjs` 拿它**真渲**三种读法
 *   （纯函数、无副作用）。它不是对外 API，别从别处 import。
 */
export function renderBlocks(blocks, marksByIndex, findsByBlock, zhMap, mode = 'bilingual') {
  const out = [];
  /** 全中文模式：有译文的块整块换成译文，没有的块保留原文（见下面 `inZh`）。 */
  const zhOnly = mode === 'translation';
  /** 正在收集的连续 `li`；遇到非列表块就整组封成一个 `<ul>`。 */
  let items = [];
  let listKey = 0;
  const flushList = () => {
    if (items.length === 0) return;
    out.push(<ul key={`ul-${listKey}`} className="npr-ebook-ul">{items}</ul>);
    items = [];
  };
  /**
   * 一段文字 → 带高亮（划线 + 书内搜索命中）的碎片。
   *
   * ★ 两层都没有时**原样返回字符串**：包一层 `<span>` 在视觉上没区别，但会让
   *   整页多出几百个节点、还会影响 `word-break` 的断行机会。
   * ★ 两层都有时**并成一次切割**（`splitByOverlays`），不嵌套 `<mark>` ——
   *   理由写在那边的函数头上：嵌套会让断行与 `line-clamp` 跟着变。
   */
  const fill = (index, text) => {
    const marks = marksByIndex?.get(index);
    const finds = findsByBlock?.get(index);
    const hasMarks = Array.isArray(marks) && marks.length > 0;
    const hasFinds = Array.isArray(finds) && finds.length > 0;
    if (!hasMarks && !hasFinds) return text;
    return splitByOverlays(text, hasMarks ? marks : [], hasFinds ? finds : []).map((slice) => {
      const piece = text.slice(slice.from, slice.to);
      if (slice.tone === null && slice.find !== true) {
        return <span key={`t${slice.from}`}>{piece}</span>;
      }
      return (
        <mark key={`m${slice.from}`} className={`npr-ebook-mark${slice.find === true ? ' npr-ebook-find' : ''}`}
          data-tone={slice.tone === null ? undefined : slice.tone}
          data-current={slice.find === true ? (slice.current === true ? 'true' : 'false') : undefined}>
          {piece}
        </mark>
      );
    });
  };
  (Array.isArray(blocks) ? blocks : []).forEach((block, index) => {
    const text = String(block?.x ?? '');
    if (text === '') return;
    const kind = String(block?.k ?? 'p');
    /**
     * 这一块的译文（对照 / 全中文都用它）。
     *
     * ★ 键是**块下标**，与 `blocks` 的下标同源 —— 跳过空块不会让后面的译文前移一格
     *   （见 `src/ebook-translate.js` 文件头）。
     * ★ 译文是纯文本，不是 HTML：来源是模型返回的一段字，这里只当文本渲染，
     *   所以书里那套「XSS 面为零」的边界在对照模式下同样成立。
     */
    const zhText = (() => {
      const value = zhMap?.get?.(index);
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
    })();
    /**
     * ★ 全中文模式：**有译文就用译文当正文**。
     *
     * 为什么不是「没有译文就留空」：一本 36 节只译了 30 节的书，缺的那 6 节
     * 会变成**整页空白** —— 用户会以为书坏了，而丢掉的恰恰是整段内容。
     * 退回原文时读者至少还能读，且界面顶部会写清「本节 N 段、译出 M 段」。
     *
     * ★ 这里**不套 `fill()`**：划线 / 搜索命中的偏移都是按**原文**算的，
     * 拿去切译文会把高亮落在完全不相干的字上（而且看起来很正常）。
     * 译文段落上的划线因此不可用 —— 要划线就切回「对照」，见工具条那颗按钮的说明。
     */
    const inZh = zhOnly && zhText !== '' && kind !== 'pre';
    const content = inZh ? zhText : fill(index, text);
    /** 对照模式才在原文下面接一段；全中文模式下译文就是正文本身。 */
    const zhNode = (!zhOnly && zhText !== '' && kind !== 'pre')
      ? <span className="npr-ebook-zh">{zhText}</span>
      : null;
    if (kind === 'li') {
      if (items.length === 0) listKey = index;
      /* ★ 译文放在 `<li>` **内部**：复制一个 `<li>` 会让有序列表变成 1,2,3,4。 */
      items.push(<li key={`li-${index}`} className="npr-ebook-li" data-block={index}>{content}{zhNode}</li>);
      return;
    }
    flushList();
    /*
     * 标题的译名是一个**独立的段落**，不是另一个 `<h1>`：两个 h1 会让目录 / 读屏
     * 都以为这一章有两个标题。样式上用 `npr-ebook-zh-head` 把字号拉回标题感。
     * ★ 全中文模式下标题直接换掉（`content` 已是译名），所以仍然只有一个 h1。
     */
    if (kind === 'h1') { out.push(<h1 key={index} className="npr-ebook-h1" data-block={index}>{content}</h1>); }
    else if (kind === 'h2') { out.push(<h2 key={index} className="npr-ebook-h2" data-block={index}>{content}</h2>); }
    else if (kind === 'h3') { out.push(<h3 key={index} className="npr-ebook-h3" data-block={index}>{content}</h3>); }
    else if (kind === 'q') { out.push(<blockquote key={index} className="npr-ebook-quote" data-block={index}>{content}</blockquote>); }
    else if (kind === 'pre') { out.push(<pre key={index} className="npr-ebook-pre" data-block={index}>{content}</pre>); }
    else out.push(<p key={index} className="npr-ebook-p" data-block={index}>{content}</p>);
    /*
     * `pre` 不贴译文：代码块本来就不该翻（`blockSegments` 也不送它），
     * 这里再挡一次是为了让「旧缓存里混进一条 pre 译文」也不会渲染出来。
     */
    if (!zhOnly && zhText !== '' && kind !== 'pre') {
      out.push(
        <p key={`zh-${index}`} className={`npr-ebook-zh npr-ebook-zh-block${/^h[1-6]$/.test(kind) ? ' npr-ebook-zh-head' : ''}`}
          data-zh={index} lang="zh-CN">{zhText}</p>,
      );
    }
  });
  flushList();
  return out;
}

/** 块 → 纯文本（伴读的上下文用它）。 */
function blocksToText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(block => String(block?.x ?? '').trim())
    .filter(text => text !== '')
    .join('\n');
}

/** 夹到合法节号。 */
function clampSection(value, total) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(Math.max(Math.round(number), 1), Math.max(1, total));
}

export function BookEbook({
  book, states, onPageChange, onFinished, notify,
  api, SessionProvider, renderSlot, onManagePrompts, onImmersiveChange,
  /** 与 `BookReader` 同义：报「当前在第几节」，落到灵感速记的 `meta.chapter`。 */
  onChapter,
  /** 与 `BookReader` 同义：打开时先落到第几节（`null` = 按上次读到的）。 */
  initialPage,
}) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  /** `{ format, title, author, warnings, toc, sections }`，正文不在里面。 */
  const [index, setIndex] = useState(null);
  const [page, setPage] = useState(1);
  /** 当前节：`{ n, title, blocks, chars }`。`n` 与 `page` 不一致 = 还在取。 */
  const [section, setSection] = useState(null);
  const [sectionError, setSectionError] = useState('');
  const [pageDraft, setPageDraft] = useState('1');
  const [attempt, setAttempt] = useState(0);
  /**
   * 对照模式（0.57.0）：`on` 是开关，`status` 是这一节的状态。
   *
   * ★ `n` 是**这份译文属于第几节**，缺了它就会有一帧错位：
   *   翻到第 4 节时 `section` 先变成第 4 节、而 `zhState` 还停在第 3 节
   *   （effect 在渲染**之后**才跑），那一帧会用第 3 节的译文 map 去套第 4 节的
   *   块下标 —— 块数相近时两次都「看起来正常」，只是每一段都文不对题。
   *   渲染前用 `zhState.n === page` 挡一道，这一帧就退回「无译文」。
   * ★ `status` 有五种，且**每一种都要画出来**：
   *   `idle` 未开启 · `loading` 正在翻 · `ready` 有译文 · `skip` 这一节不需要对照 ·
   *   `error` 失败（带原因与重试）。
   *   只画「ready」的后果是：翻一节要等几十秒，而这段时间页面上什么都没有，
   *   用户会以为按钮没生效，于是反复点 —— 每次都触发一次请求（服务端有单飞，
   *   但这仍然是最糟的体感）。
   * ★ `map` 的键是**块下标**，见 `src/ebook-translate.js` 文件头。
   */
  /**
   * 读哪种语言（0.65.0）：`original` / `bilingual` / `translation`。
   *
   * ★ 这是**用户意图**，不一定等于当下真正生效的读法 —— 中文书会被强制回 `original`
   *   （见下面 `readMode`）。把两件事分开存，是为了「用户上次选了译文、这次打开
   *   一本中文书、之后又打开英文书」时，那个选择还在，而不是被中文书悄悄改掉。
   * ★ 它是全局偏好（落在宿主设置 `ebookReadMode` 里），与字号、纸色同一层。
   */
  const [modeWanted, setModeWanted] = useState('original');
  /** 「原文 / 对照 / 译文」那颗菜单有没有展开。 */
  const [modeOpen, setModeOpen] = useState(false);
  const [zhState, setZhState] = useState({ n: null, status: 'idle', error: '', map: null, coverage: null });
  /** 重试计数：只为了让「重试」按钮能重新触发同一个 effect。 */
  const [zhAttempt, setZhAttempt] = useState(0);
  /** 这本书已译过几节（工具栏与提示行的副信息）。`null` = 还没问过。 */
  const [zhDone, setZhDone] = useState(null);
  /*
   * ★ 这里**故意没有** `job` / `jobBusy` / `jobError` 三个 state（0.60.0 搬走了）。
   *   整本翻译的状态活在 `translate-hub.js` 里：它跨书、跨页面，是模块级单例。
   *   在阅读器里再存一份的后果是两份会漂开 —— 尤其是「用户停在第 3 节读书、
   *   任务在后台翻完」这种情况，两份状态谁是对的没有判据。
   *   阅读器只从任务台**读** `jobRunning`，见下面那段 effect。
   */

  const [tocOpen, setTocOpen] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [marksOpen, setMarksOpen] = useState(false);
  const [companion, setCompanion] = useState(false);
  /**
   * 书内搜索（0.26.0）：`{ status, error, truncated, scans }` + 命中列表 + 当前第几处。
   *
   * ★ `findActive === -1` 是**合法且默认**的状态 —— 「搜到了但还没跳」。此时这一节上
   *   所有命中都已经高亮（浅色），只是没有哪一处是「当前」（深色）。把它当成
   *   `0` 会在用户还没按回车时就把页面跳到第一处，打到一半的词都会带着页面乱翻。
   */
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findState, setFindState] = useState({ status: 'idle', error: '', truncated: false });
  const [findHits, setFindHits] = useState([]);
  const [findActive, setFindActive] = useState(-1);
  const [immersive, setImmersive] = useState(false);
  /** 沉浸态：指针靠近面板顶边时胶囊滑出（见 `book-peek.js` —— 光靠 `:hover` 不行，
      顶部那条热区是窗口拖动条，页面收不到鼠标事件）。 */
  const [peek, setPeek] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  /** 这本书的全部划线 / 笔记。服务端（宿主）是唯一真相，这里只存它回来的那份。 */
  const [annotations, setAnnotations] = useState([]);
  /** 打开面板时要立刻进入编辑的那一条（「划了线顺便写一句」用）。 */
  const [markFocusId, setMarkFocusId] = useState('');
  /**
   * 划词气泡：`{ text, top, bottom, centerX, layerHeight }`，`null` = 不显示。
   *
   * ★ 与 PDF 那边同一个形状、同一个 `quoteBarPlacement` 判据 —— 两处各写一套
   *   摆放规则，必然一处往上、一处往下，用户换个格式读就觉得「气泡乱跑」。
   */
  const [quote, setQuote] = useState(null);
  /**
   * 用户刚划的那一句，交给伴读当引文（空串 = 没划）。
   *
   * ★ 与 `quote` 是**两份** state，不能合并：气泡会随着点别处消失，而伴读那一份
   *   必须留着 —— 否则用户点完「问伴读」再点一下页面，模型看到的上下文就被抽走了。
   *   它进 `BookCompanion` 的 `contextKey`，所以划一次只重绑一次。
   * ★ 这一格 0.25.2 搬气泡时只在 `context` 里写了个 `quote: ''` 占位，
   *   气泡上也漏了「问伴读」那一颗 —— 用户 0.25.8 报的就是它（「为什么 EPUB 划线时
   *   没有伴读这个选项」）。接线本来就在，缺的只是入口。
   */
  const [companionQuote, setCompanionQuote] = useState('');

  /** 阅读外观：`{ fontSize, lineHeight, textWidth, family, theme }`。 */
  const [look, setLook] = useState({
    fontSize: 19, lineHeight: 1.9, textWidth: 36, family: '', theme: 'auto',
  });
  /** 面板尺寸（浮动按钮列要按可用高度收放）。 */
  const [frame, setFrame] = useState({ width: 0, height: 0, top: 0 });

  const bookRef = useRef(null);
  const stageRef = useRef(null);
  const articleRef = useRef(null);
  const fabHoverTimer = useRef(0);
  /** 已经上报过进度的节号：同一节反复重绘不该反复写盘。 */
  const reportedRef = useRef(0);
  /** 每节的块缓存：翻回去时不该再走一次 HTTP。 */
  const cache = useRef(new Map());
  /**
   * 选区量好的字符偏移。
   *
   * ★ 必须在 `selectionchange` 那一刻量好存下来：点气泡上的按钮时 `mousedown`
   *   会让浏览器把选区收掉，那一刻再去读 `getSelection()` 只剩一个塌缩的 Range。
   */
  const quoteAnchorRef = useRef(null);

  const current = stateOf(states, book.id);
  const total = Array.isArray(index?.sections) ? index.sections.length : 0;
  /**
   * 这本书是不是中文书（0.62.0）。
   *
   * ★ 判据来自宿主：解析整本时按**字符量**算汉字占比，≥ 0.7 记 `zh`
   *   （见 `bookScript`）。为什么不在这里现算：阅读器手里只有目录，正文是一节一节
   *   取回来的；而「打开一本书就该知道对照能不能用」，不该等用户翻三节才够样本。
   * ★ `script` 缺失（老宿主 / 老缓存）→ 不当中文书，按钮照旧可点。
   *   「不知道」不该被读成「不能翻」。
   */
  const chineseBook = index?.script === 'zh';
  /**
   * 真正生效的读法（0.65.0）。
   *
   * ★ 中文书一律 `original`：这本书没有「译文」可言，选「对照」或「译文」只会得到
   *   一句「这一节没有需要翻译的英文」—— 那不是选项，是一个已知结论。
   * ★ 但**不改** `modeWanted`：用户上次给英文书选的读法要留着，否则打开一本中文书
   *   就把他刚设的「全中文」清掉了，回到英文书还得再设一次。
   */
  const readMode = chineseBook ? 'original' : modeWanted;
  /** 要不要译文（`bilingual` 与 `translation` 都要，只是摆放位置不同）。 */
  const zhOn = readMode !== 'original';
  /** 全中文：译文替换正文。 */
  const zhOnly = readMode === 'translation';
  /**
   * 页脚百分比 = **当前翻到的页** / 总页数。
   *
   * ★ 不能用 `progressPercent(current)`（0.25.1 修）：那读的是**落盘状态**里的
   *   `page` / `pages`，而落盘要等 1.2 秒去抖才发生 —— 于是「第 3 页 / 共 103 页」
   *   旁边挂着 43%（上一本书留下的 3 / 7）。数字与位置自相矛盾，读者只会以为
   *   进度条坏了。落盘那份状态是给书架徽章用的，这里要的是**此刻**的位置。
   */
  const percent = total > 0 ? Math.min(100, Math.round((page / total) * 100)) : 0;
  const digest = useBookDigest({ book, api, notify });
  /**
   * ★ 只取**函数**，不取整个 `digest` 对象：那个对象每次渲染都是新的，
   *   把它放进 effect 依赖里会让键盘监听每渲染一次就重挂一次。
   */
  const {
    closeCard, needModels: loadDigestModels, runDigest, rebuildDigest,
    toggleSelect, selectAll, selectNone, changeModel,
    startGenerate, stopGenerate, toggleChapter,
  } = digest;

  // ---- 打开书：取目录与分节索引 ------------------------------------------
  useEffect(() => {
    if (!isEbookExtension(book.ext)) {
      setStatus('error');
      setError(`这本书是 ${String(book.ext || '未知').toUpperCase()} 格式，重排阅读不支持它`);
      return undefined;
    }
    let cancelled = false;
    setStatus('loading');
    setError('');
    setIndex(null);
    setSection(null);
    setSectionError('');
    cache.current.clear();
    reportedRef.current = 0;
    // 换书 = 上一本的命中一处都不该留在界面上（节号与偏移都指向另一本书）。
    setFindOpen(false);
    setFindQuery('');
    setFindHits([]);
    setFindActive(-1);
    setFindState({ status: 'idle', error: '', truncated: false });
    (async () => {
      try {
        const body = await fetchEbookIndex(book.id);
        if (cancelled) return;
        const sections = Array.isArray(body.sections) ? body.sections : [];
        setIndex({ ...body, sections });
        // 回到上次读到的那一节。节号可能超出（换过文件版本），夹一下。
        // 带了 `initialPage`（从日记「挂在书上」点进来）就用它。
        const wanted = Number.isInteger(initialPage) && initialPage > 0 ? initialPage : (current.page || 1);
        const resume = clampSection(wanted, sections.length);
        setPage(resume);
        setPageDraft(String(resume));
        setStatus('ready');
      } catch (cause) {
        if (cancelled) return;
        setError(cause?.message ?? String(cause));
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
    // `current.page` 只在**换书**时读一次（它是恢复点，不是受控值）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, book.ext, attempt]);

  // ---- 取正文：当前节（顺带预取下一节）-----------------------------------
  useEffect(() => {
    if (status !== 'ready' || total === 0) return undefined;
    let cancelled = false;
    const cached = cache.current.get(page);
    if (cached !== undefined) {
      setSection(cached);
      setSectionError('');
      return undefined;
    }
    setSectionError('');
    (async () => {
      try {
        const body = await fetchEbookSection(book.id, page);
        if (cancelled) return;
        const loaded = { n: body.n, title: body.title, blocks: body.blocks ?? [], chars: body.chars ?? 0 };
        cache.current.set(body.n, loaded);
        setSection(loaded);
      } catch (cause) {
        if (cancelled) return;
        setSection(null);
        setSectionError(cause?.message ?? String(cause));
      }
    })();
    // 预取下一节：连续往下读时省掉一次往返的空白期。失败**不管** —— 那是纯优化。
    if (PREFETCH > 0 && page < total && !cache.current.has(page + 1)) {
      fetchEbookSection(book.id, page + 1).then((body) => {
        if (cancelled) return;
        cache.current.set(body.n, {
          n: body.n, title: body.title, blocks: body.blocks ?? [], chars: body.chars ?? 0,
        });
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [status, page, total, book.id]);

  // ---- 换节：滚回顶部 + 上报进度 ----------------------------------------
  useEffect(() => {
    if (section === null || section.n !== page) return;
    const stage = stageRef.current;
    if (stage !== null) stage.scrollTop = 0;
    if (reportedRef.current !== page) {
      reportedRef.current = page;
      onPageChange?.(page, total);
    }
  }, [section, page, total, onPageChange]);

  /**
   * 对照模式：换到哪一节就译哪一节。
   *
   * 顺序刻意是「先问缓存、再决定翻不翻」：
   *   ① 缓存命中 ⇒ 立刻画（毫秒级），翻回上一页是**零成本**的；
   *   ② 这一节压根没有可翻的块（纯中文 / 只有代码）⇒ `skip`，**一个请求都不发**；
   *   ③ 其余才发那个几十秒的 POST。
   *
   * ★ `alive` 是必须的：用户翻页比模型快得多，迟到的结果若照常 `setState`，
   *   第 3 节的译文会被画进第 5 节 —— 而且看起来完全正常，只是文不对题。
   * ★ 依赖里带 `zhAttempt`：它只被「重试」按钮 +1，作用就是让同一个节号能重新跑一遍。
   */
  useEffect(() => {
    if (!zhOn || status !== 'ready' || section === null || section.n !== page) return undefined;
    setZhState({ n: page, status: 'loading', error: '', map: null, coverage: null });
    let alive = true;
    (async () => {
      try {
        const cached = await fetchEbookTranslation(book.id, page);
        if (!alive) return;
        if (cached.available === true) {
          setZhState({
            n: page,
            status: 'ready',
            error: '',
            map: mapOfEntries(cached.entries),
            coverage: cached.coverage ?? null,
          });
          setZhDone((prev) => (prev === null ? prev : (prev.includes(page) ? prev : [...prev, page].sort((a, b) => a - b))));
          return;
        }
        // 没有可翻的块：说「这一节不需要对照」，不发请求。
        if (blockSegments(section.blocks).length === 0) {
          setZhState({ n: page, status: 'skip', error: '', map: null, coverage: null });
          return;
        }
        const fresh = await postEbookTranslation(book.id, page);
        if (!alive) return;
        setZhState({
          n: page,
          status: 'ready',
          error: '',
          map: mapOfEntries(fresh.entries),
          coverage: fresh.coverage ?? null,
        });
        setZhDone((prev) => (prev === null ? prev : (prev.includes(page) ? prev : [...prev, page].sort((a, b) => a - b))));
      } catch (error) {
        if (!alive) return;
        // 服务端明确说「没有可翻的英文」⇒ 不是错误，是这一节不需要对照。
        if (error?.code === 'EBOOK_NO_TEXT') {
          setZhState({ n: page, status: 'skip', error: '', map: null, coverage: null });
          return;
        }
        setZhState({ n: page, status: 'error', error: String(error?.message ?? error), map: null, coverage: null });
      }
    })();
    return () => { alive = false; };
  }, [zhOn, page, section, status, book.id, zhAttempt]);

  /** 打开对照时问一次「这本书已译了几节」——只用于提示行的副信息，失败就静默。 */
  useEffect(() => {
    if (!zhOn || zhDone !== null) return undefined;
    let cancelled = false;
    fetchEbookTranslationIndex(book.id).then(
      (body) => { if (!cancelled) setZhDone(Array.isArray(body.sections) ? body.sections : []); },
      () => { if (!cancelled) setZhDone([]); },
    );
    return () => { cancelled = true; };
  }, [zhOn, zhDone, book.id]);

  // ---- 整本预翻（0.60.0）：状态搬进「翻译助手」了 ------------------------
  //
  // ★ 0.59.0 这里有三条 effect 和一个 `job` state：初始快照、轮询、收尾。
  //   0.60.0 全部搬去了 `translate-hub.js`（模块级任务台）与
  //   `TranslateAssistant.jsx`（右下角浮层）。理由是**任务的生命周期比这本书长**：
  //   翻一本要几十分钟，人会换书、会切到订阅页，而挂在阅读组件上的状态一换书就断线，
  //   任务还在宿主里跑，界面上却什么都看不见。
  //   阅读器这边只剩**一个**职责：任务停下来的那一刻，这一节的译文该换新的了。
  const jobEntry = useTranslateJobs().find((entry) => entry.bookId === String(book.id)) ?? null;
  const jobRunning = jobEntry?.job?.state === 'running';

  /**
   * 任务停下来的那一拍收尾：让当前这一节重新取一次译文。
   *
   * ★ 必须做：整本翻的过程中，用户很可能就停在第 3 节上读。翻完那一刻第 3 节
   *   已经有缓存了，但 `zhState` 还停在「正在翻译这一节…」—— 不刷新的话，
   *   他得手动翻走再翻回来才能看到译文，而这正是这个功能想省掉的动作。
   * ★ `done` / `stopped` / `failed` 都触发：三种都意味着「磁盘上可能多了几节」。
   */
  const jobWasRunning = useRef(false);
  useEffect(() => {
    if (jobRunning) { jobWasRunning.current = true; return; }
    if (!jobWasRunning.current) return;
    jobWasRunning.current = false;
    setZhDone(null);
    setZhAttempt((value) => value + 1);
  }, [jobRunning]);

  // ---- 划线 / 笔记 -------------------------------------------------------
  //
  // 与 PDF 那边**同一份数据、同一个面板**（`annotations/<bookId>.json`、
  // `AnnotationPanel`），差的只是锚点怎么量：PDF 数文字层的文本节点，电子书数
  // 「第几块 + 块内第几个字」（见 `ebook-marks.js` 开头）。
  //
  // ★ 高亮**直接画在文字里**（`<mark>`），不像 PDF 那样另铺一层绝对定位的矩形：
  //   重排文本的坐标随字号 / 版心 / 窗口宽度全都在变，量矩形等于每次改字号都要
  //   重算一遍，而 `<mark>` 是行内元素，浏览器自己会跟着重排。

  /** 打开一本书时取这本书的划线。失败**不打断阅读**，但要说一句。 */
  useEffect(() => {
    let cancelled = false;
    setAnnotations([]);
    fetchAnnotations(book.id).then(
      (items) => { if (!cancelled) setAnnotations(normalizeAnnotations(items)); },
      () => { if (!cancelled) notify?.('划线没读出来（不影响继续阅读）'); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  /** 当前这一页的块在页内坐标系里的区间（划线的落点全靠它）。 */
  const spans = useMemo(() => (section === null ? [] : blockSpans(section.blocks)), [section]);

  /** 这一页的划线 → 每块的块内偏移（渲染时按它切碎片）。 */
  const marksByIndex = useMemo(() => {
    const map = new Map();
    // ★ 失配的划线**不参与切字**：坐标已经不可信，照旧画出来就是「线画到别的字上」。
    const onPage = withoutMismatch(annotationsOnPage(annotations, page));
    if (onPage.length === 0 || spans.length === 0) return map;
    for (const span of spans) {
      const marks = marksForBlock(onPage, span, span.end - span.start);
      if (marks.length > 0) map.set(span.index, marks);
    }
    return map;
  }, [annotations, page, spans]);

  /**
   * 选区 → 气泡。
   *
   * ★ 挂在 `document` 上：拖选时鼠标可能已经滑出正文（选区仍属于正文），
   *   `mouseup` 落在哪并不可靠 —— 这与 PDF 那边的结论一致。
   * ★ 只在 `ready` 且这一页已经渲染出来时挂：`section.n !== page` 时 article 里
   *   是上一页的内容，这时的偏移属于上一页，存下来就是错位。
   */
  useEffect(() => {
    if (status !== 'ready' || section === null || section.n !== page) return undefined;
    const read = () => {
      const article = articleRef.current;
      const selection = globalThis.getSelection?.();
      const next = selectionQuote(selection, article);
      const range = selection !== null && selection !== undefined && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null;
      quoteAnchorRef.current = next === null ? null : anchorOfSelection(range, article, spans);
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
  }, [status, section, page, spans]);

  /** 换页 / 换书之后，上一页量好的偏移必须作废 —— 它指的是另一页的字符位置。 */
  useEffect(() => {
    quoteAnchorRef.current = null;
  }, [page, book.id]);

  /** 划一条。`openNote` 为真时顺手把面板打开并落在这一条的编辑框上。 */
  const createMark = useCallback(async ({ openNote = false } = {}) => {
    const article = articleRef.current;
    const selection = globalThis.getSelection?.();
    const anchor = quoteAnchorRef.current ?? anchorOfSelection(
      selection !== null && selection !== undefined && selection.rangeCount > 0 ? selection.getRangeAt(0) : null,
      article,
      spans,
    );
    if (quote === null || anchor === null) {
      notify?.('这段选不中，划不了线');
      return;
    }
    const text = quote.text;
    // 失配项不该拦着用户「重新划一次」：它此刻并没有画在正文上。
    const covering = coveringAnnotation(withoutMismatch(annotations), { page, ...anchor });
    quoteAnchorRef.current = null;
    setQuote(null);
    selection?.removeAllRanges?.();
    if (covering !== null) {
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
        setTocOpen(false);
        setDigestOpen(false);
        setCompanion(false);
        setMarksOpen(true);
        setMarkFocusId(result.item.id);
        notify?.('已划线 —— 写一句为什么值得留');
      } else {
        notify?.('已划线');
      }
    } catch (cause) {
      notify?.(cause?.message ?? '划线没保存成功');
    }
  }, [annotations, book.id, notify, page, quote, spans]);

  const updateMark = useCallback(async (id, patch) => {
    try {
      const result = await postAnnotation(book.id, { op: 'update', id, ...patch });
      setAnnotations(normalizeAnnotations(result.items));
    } catch (cause) {
      notify?.(cause?.message ?? '笔记没保存成功');
    }
  }, [book.id, notify]);

  const removeMark = useCallback(async (id) => {
    try {
      const result = await postAnnotation(book.id, { op: 'remove', id });
      setAnnotations(normalizeAnnotations(result.items));
      setMarkFocusId('');
      notify?.('已删除这条划线');
    } catch (cause) {
      notify?.(cause?.message ?? '删除失败');
    }
  }, [book.id, notify]);

  // ---- 阅读外观：挂载时读一次（全局偏好，与书无关）------------------------
  const lookRead = useRef(false);
  useEffect(() => {
    if (lookRead.current || typeof api?.getSettings !== 'function') return undefined;
    lookRead.current = true;
    let cancelled = false;
    api.getSettings().then((body) => {
      if (cancelled) return;
      const settings = body?.settings ?? {};
      setLook({
        fontSize: Number.isFinite(settings.fontSize) ? settings.fontSize : 19,
        lineHeight: Number.isFinite(settings.lineHeight) ? settings.lineHeight : 1.9,
        textWidth: Number.isFinite(settings.textWidth) ? settings.textWidth : 36,
        family: fontStack(settings),
        theme: typeof settings.readingTheme === 'string' ? settings.readingTheme : 'auto',
      });
      /*
       * 读法（0.65.0）与外观一起读回来。★ 走 `normalizeEbookReadMode` 而不是信任
       * 那个字段：老设置文件里没有它，手改坏了也可能写成 `'zh'` 之类 ——
       * 落到 `original` 是唯一「不会自己开始花钱」的兜底。
       */
      setModeWanted(normalizeEbookReadMode(settings.ebookReadMode));
    }).catch(() => {
      // 读不到设置 ⇒ 用默认值继续读。为了一个外观设置卡住整本书不值得。
    });
    return () => { cancelled = true; };
  }, [api]);

  // ---- 量面板（浮动按钮列的高度预算）-------------------------------------
  useEffect(() => {
    const panel = bookRef.current;
    const stage = stageRef.current;
    if (panel === null || stage === null) return undefined;
    const measure = () => {
      const rect = panel.getBoundingClientRect();
      const topInset = Math.max(0, Math.round(stage.getBoundingClientRect().top - rect.top));
      setFrame((previous) => (
        Math.abs(previous.height - rect.height) < 0.5 && previous.top === topInset
          ? previous
          : { width: rect.width, height: rect.height, top: topInset }
      ));
    };
    measure();
    if (typeof globalThis.ResizeObserver !== 'function') return undefined;
    const observer = new globalThis.ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  /**
   * 收起所有侧栏（目录 / 解读 / 划线 / 书内搜索）。
   *
   * ★ 四选一，不是一列并排：正文只有一栏宽度，两个面板一起开会把纸面挤到
   *   三百多像素 —— 那时正文每行不到 12 个字，读不下去。
   */
  const closePanels = useCallback(() => {
    setTocOpen(false);
    setDigestOpen(false);
    setMarksOpen(false);
    setMarkFocusId('');
    setFindOpen(false);
    closeCard();
  }, [closeCard]);

  /** 开 / 关划线面板。与目录、解读、搜索、伴读互斥（中间永远只留一栏）。 */
  const toggleMarks = useCallback(() => {
    setMarkFocusId('');
    if (marksOpen) {
      setMarksOpen(false);
      return;
    }
    setTocOpen(false);
    setDigestOpen(false);
    setFindOpen(false);
    closeCard();
    setCompanion(false);
    setMarksOpen(true);
  }, [marksOpen, closeCard]);

  /**
   * 书内搜索：**输入即搜**，220ms 去抖。
   *
   * ★ 为什么在宿主侧搜（而不是把每一节取回来在浏览器里找）：正文本来就只在宿主
   *   那里解析过一次并落盘缓存，取一百多节回来既慢又会让「读的是哪一份正文」
   *   出现两份可能。判据在 `src/book-find.js`（与 `book_search` 同一套）。
   * ★ 去抖 220ms：这个数落在「打字停顿」与「不觉得卡」之间。输入法组字期间
   *   每敲一下都发一次请求，用户拿到的是一串互相覆盖的结果。
   * ★ 取消用 `cancelled` 而不是 AbortController：请求本身很短（本机 HTTP），
   *   被丢弃的那一次结果不会写进界面就够了；真 abort 只会多一条错误分支。
   * ★ 搜完**不自动跳**（`findActive` 保持 -1）：见上面那段 state 注释 ——
   *   边打字边翻页是最难受的一种交互。
   */
  useEffect(() => {
    if (!findOpen || status !== 'ready') return undefined;
    const needle = findQuery.trim();
    if (needle === '') {
      setFindHits([]);
      setFindActive(-1);
      setFindState({ status: 'idle', error: '', truncated: false });
      return undefined;
    }
    let cancelled = false;
    setFindState({ status: 'searching', error: '', truncated: false });
    const timer = setTimeout(async () => {
      try {
        const body = await fetchEbookFind(book.id, needle);
        if (cancelled) return;
        const list = (Array.isArray(body.hits) ? body.hits : []).map((hit, index) => ({
          key: `s${hit.n}-b${hit.block}-${hit.start}-${index}`,
          index,
          n: Number(hit.n),
          block: Number(hit.block),
          start: Number(hit.start),
          end: Number(hit.end),
          sectionTitle: String(hit.sectionTitle ?? ''),
          snippet: String(hit.snippet ?? ''),
        }));
        setFindHits(list);
        setFindActive(-1);
        setFindState({ status: 'done', error: '', truncated: body.truncated === true });
      } catch (error) {
        if (cancelled) return;
        setFindHits([]);
        setFindActive(-1);
        setFindState({ status: 'error', error: error?.message ?? '检索失败', truncated: false });
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [findOpen, findQuery, book.id, status]);

  /**
   * 当前这一节里**每一块**的命中（块内偏移）。
   *
   * ★ `current` 由 `findActive` 决定；`findActive === -1` 时全部是 `false` ——
   *   这时整节命中都已经可见，只是没有「当前」那一个。
   */
  const findsByBlock = useMemo(() => {
    const map = new Map();
    if (!findOpen) return map;
    for (const hit of findHits) {
      if (hit.n !== page) continue;
      const list = map.get(hit.block) ?? [];
      list.push({ start: hit.start, end: hit.end, current: hit.index === findActive });
      map.set(hit.block, list);
    }
    return map;
  }, [findOpen, findHits, page, findActive]);

  const go = useCallback((next) => {
    const target = clampSection(next, total);
    setPage((previous) => {
      if (previous === target) return previous;
      setPageDraft(String(target));
      return target;
    });
  }, [total]);

  /** 跳到第 `index` 处命中：换节（如需）+ 把它标成「当前」。 */
  const jumpToFind = useCallback((index) => {
    const hit = findHits[index];
    if (hit === undefined) return;
    setFindActive(index);
    if (hit.n !== page) go(hit.n);
  }, [findHits, page, go]);

  /**
   * 上一处 / 下一处，**首尾相接**。
   *
   * ★ 不夹在两端：用户按到第 47 处之后还想再按一下（期望回到第 1 处），夹住会
   *   让按键「突然没反应」。反之 `findActive === -1` 时「下一处」正好落到第一处。
   */
  const stepFind = useCallback((delta) => {
    if (findHits.length === 0) return;
    const base = findActive < 0 ? (delta > 0 ? -1 : 0) : findActive;
    const next = (base + delta + findHits.length) % findHits.length;
    jumpToFind(next);
  }, [findHits, findActive, jumpToFind]);

  /** 点「搜索」：与其它侧栏互斥地打开；再点一次收起。 */
  const toggleFind = useCallback(() => {
    if (findOpen) { setFindOpen(false); return; }
    setTocOpen(false);
    setDigestOpen(false);
    setMarksOpen(false);
    setMarkFocusId('');
    setCompanion(false);
    closeCard();
    setFindOpen(true);
  }, [findOpen, closeCard]);

  /**
   * 把「当前这一处」滚到视野中间。
   *
   * ★ 用 `getBoundingClientRect` 的差算 `scrollTop`，不用 `scrollIntoView()`：
   *   后者会把**所有**可滚祖先一起滚（包括宿主的页面容器），读一本电子书顺手
   *   把整个面板滚走了。
   * ★ 依赖里带 `section`：换节时正文是异步取回来的，取回来之前 `querySelector`
   *   找不到任何一个 `data-block` —— 那时滚不了，等它到位再滚。
   */
  useEffect(() => {
    if (!findOpen) return;
    const active = findHits[findActive];
    if (active === undefined || active.n !== page) return;
    if (section === null || section.n !== page) return;
    const article = articleRef.current;
    const stage = stageRef.current;
    if (article === null || stage === null) return;
    const block = article.querySelector(`[data-block="${active.block}"]`);
    if (block === null) return;
    const target = block.querySelector('.npr-ebook-find[data-current="true"]') ?? block;
    const box = target.getBoundingClientRect();
    const frame = stage.getBoundingClientRect();
    const delta = box.top - frame.top - stage.clientHeight / 2 + box.height / 2;
    stage.scrollTop = Math.max(0, stage.scrollTop + delta);
  }, [findOpen, findActive, findHits, page, section]);

  const toggleImmersive = useCallback(() => {
    setImmersive((value) => {
      const next = !value;
      if (next) notify?.('已进入沉浸式阅读：鼠标移到顶边滑出工具条，Esc 或 I 退出');
      return next;
    });
  }, [notify]);

  useEffect(() => { onImmersiveChange?.(immersive); }, [immersive, onImmersiveChange]);

  /**
   * 沉浸态的「胶囊滑出」判据（0.25.4）。
   * 指针离面板顶边 ≤56px 就滑出、>72px 才收 —— 滞回写在 `book-peek.js` 里，这里只把
   * 指针坐标换算成距离。**不能只靠 CSS `:hover`**：热区 `.npr-book-toolbar` 在宿主里
   * 是 `-webkit-app-region: drag` 的窗口拖动条，Chromium 把它当标题栏命中，
   * 页面根本收不到鼠标事件 —— 用户报的「一旦隐藏就出不来了」就是它。
   */
  const onPeekPointerMove = (event) => {
    if (!immersive) return;
    /*
      ★ 指针在面板上（目录 / 划线 / 解读 / 伴读）时**不滑出**，已经在外面滑出的也要立刻收。
        用户要关目录，鼠标必须划过面板顶部那行 —— 而胶囊滑出正好铺在那儿，
        关闭按钮就被盖住了（用户 0.25.7 的原话：「菜单就会遮挡掉目录框的关闭按钮」）。
        注意这里不是「return 就完事」：`peek` 可能已经是 true（指针刚从正文顶部进来），
        不收的话胶囊还挂在那儿，按钮照样点不到。
    */
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

  /** 改字号。写回设置（全局偏好），失败不打断本次阅读。 */
  const stepFont = useCallback((delta) => {
    setLook((previous) => {
      const next = Math.min(FONT_MAX, Math.max(FONT_MIN, previous.fontSize + delta));
      if (next === previous.fontSize) return previous;
      api?.saveSettings?.({ fontSize: next }).catch(() => {});
      return { ...previous, fontSize: next };
    });
  }, [api]);

  /** 换纸色（写 `readingTheme`）。`auto` 在轮转里被当成 `light` 的起点。 */
  const applyTheme = useCallback((value) => {
    setLook(previous => ({ ...previous, theme: value }));
    api?.saveSettings?.({ readingTheme: value }).catch(() => {});
  }, [api]);

  const cycleTheme = useCallback(() => {
    setLook((previous) => {
      const at = TINT_ORDER.indexOf(previous.theme);
      const next = TINT_ORDER[(at + 1) % TINT_ORDER.length];
      api?.saveSettings?.({ readingTheme: next }).catch(() => {});
      return { ...previous, theme: next };
    });
  }, [api]);

  /**
   * 换读法（0.65.0）：原文 / 对照 / 译文。
   *
   * ★ 关掉译文时**立刻清掉 `zhState`**：留着的话，下次切回对照会先闪一下上一节
   *   的译文再换成本节的 —— 看起来像串页（0.57.0 起的老规矩）。
   * ★ 选区也一起收掉：全中文下划不了线（偏移锚在原文上），而气泡里少了「划线」
   *   那颗按钮，留着它只会让人以为按钮被吞了。
   * ★ 落盘失败**不提示**：读法写不进去只会导致「下次打开回到原文」，
   *   而眼下这一次切换仍然是对的 —— 为它弹一条错误提示不值得。
   */
  const chooseReadMode = useCallback((next) => {
    setModeOpen(false);
    setModeWanted(next);
    if (next === 'original') {
      setZhState({ n: null, status: 'idle', error: '', map: null, coverage: null });
      setQuote(null);
    }
    api?.saveSettings?.({ ebookReadMode: next }).catch(() => {});
  }, [api]);

  // ---- 键盘 --------------------------------------------------------------
  /**
   * ★ 挂在 window 上、不依赖焦点（容器不许带 `tabIndex`，见文件头）。
   * ★ 输入框里按方向键不能翻页：页码框里改数字是常规操作，被抢走方向键就改不了。
   */
  useEffect(() => {
    if (status !== 'ready') return undefined;
    const onKey = (event) => {
      /**
       * ⌘F / ⌃F = 书内搜索（0.26.0）。
       *
       * ★ 抢在「有修饰键就 return」之前：那一条是为了不让 ⌘← 之类的系统快捷键
       *   翻页，而 ⌘F 本身就该由阅读器接管 —— 浏览器自带的查找只能找**当前这一节**
       *   （正文是按节渲染的），拿它当「书内搜索」是一句谎话。
       */
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
        && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        toggleFind();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]') !== null) return;
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        go(page - 1);
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        go(page + 1);
        return;
      }
      if (event.key === 'Escape') {
        // ★ 输入法组字中的 Esc 是「取消这次组字」，不是「关面板」。
        if (event.isComposing === true) return;
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (findOpen) { setFindOpen(false); return; }
        if (tocOpen || digestOpen || marksOpen) { closePanels(); return; }
        if (immersive) { setImmersive(false); return; }
        if (fabOpen) setFabOpen(false);
        return;
      }
      if (event.key === 'i' || event.key === 'I') { toggleImmersive(); return; }
      if (event.key === 'n' || event.key === 'N') cycleTheme();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, page, go, paletteOpen, findOpen, tocOpen, digestOpen, marksOpen, immersive, fabOpen, closePanels, toggleFind, toggleImmersive, cycleTheme]);

  // ---- 抽取 + 分段（电子书一步到位）--------------------------------------
  /**
   * 宿主一步做完「解析 → 落页 → 分段」，没有页数进度可报 —— 报一次 0/1 让面板
   * 显示「正在整理章节」即可。
   */
  const extractWork = useCallback(async ({ onProgress }) => {
    onProgress({ done: 0, total: 1, phase: 'extract' });
    return await postDigestEbook(book.id);
  }, [book.id]);

  const startDigest = useCallback(async () => {
    const result = await runDigest(extractWork);
    if (result === null) return;
    const count = Array.isArray(result.chapters) ? result.chapters.length : 0;
    notify?.(count > 0 ? `已切出 ${count} 章` : '这本书没有可切分的章节，将按节解读');
    // 电子书永远不是扫描版：把可能残留的旧标记清掉（同一本书换过文件时会发生）。
    saveBookState(book.id, { scanned: false }).catch(() => {});
  }, [runDigest, extractWork, notify, book.id]);

  /**
   * 「重新抽取」。★ 名字不能叫 `rebuildDigest`：那正好是 hook 里那个函数的名字，
   *   同名 const 会让函数体里的那个引用指向自己（TDZ / 无限递归）。
   */
  const restartDigest = useCallback(async () => {
    await rebuildDigest(extractWork);
  }, [rebuildDigest, extractWork]);

  // ---- 浮动按钮：悬停展开（与 PDF 阅读器同一个交互模型）------------------
  const openFab = useCallback(() => {
    clearTimeout(fabHoverTimer.current);
    setFabOpen(true);
  }, []);
  const closeFab = useCallback(() => {
    clearTimeout(fabHoverTimer.current);
    fabHoverTimer.current = setTimeout(() => setFabOpen(false), 180);
  }, []);
  useEffect(() => () => clearTimeout(fabHoverTimer.current), []);

  const stack = useMemo(
    () => fabStack({ count: 9, height: frame.height, top: frame.top }),
    [frame.height, frame.top],
  );
  const slotStyle = (index) => ({
    '--npr-fab-x': `${stack[index].x}px`,
    '--npr-fab-y': `${stack[index].y}px`,
    '--npr-fab-size': `${stack[index].size}px`,
    '--npr-fab-i': index,
  });

  /**
   * 页眉右边那一行：**当页所属的上级章节（部 / 卷）**，不是当页标题。
   *
   * ★ 为什么不显示当页标题（0.25.1 第二次改）：当页标题就画在正文第一行的 `<h1>` 里。
   *   上一版页眉写「九三年 · 译本序」、正文第一行也是「译本序」，同一句字在屏幕顶部
   *   连着出现两遍 —— 截图一眼就看得出「low」。而「我在哪一卷」这个信息正文里没有，
   *   页眉正好补上。判据在 `./ebook-outline.js`（与目录面板共用一份）。
   */
  const pageTitle = useMemo(() => {
    const fromSection = section?.title ?? '';
    if (fromSection !== '') return fromSection;
    const row = Array.isArray(index?.sections) ? index.sections[page - 1] : null;
    return row?.title ?? '';
  }, [section, index, page]);

  const chapterTitle = useMemo(() => {
    if (index === null) return '';
    return runningHead(outlineEntries(index), page, pageTitle);
  }, [index, page, pageTitle]);

  /**
   * 把「当前在第几节」报给外层（灵感速记的 `meta.chapter`）。
   *
   * ★ 电子书里 **`page` 就是节号** —— 它就是目录节点，不需要再拿目录去反查
   *   （PDF 那边要，见 `chapterAt`）。标题可能为空（这本书没有可用的目录），
   *   但节号一定对，所以照样上报。
   */
  useEffect(() => {
    onChapter?.(index === null ? null : { n: page, title: chapterTitle });
  }, [index, page, chapterTitle, onChapter]);

  /**
   * 「问伴读」：把这一句交给伴读的上下文，并把面板打开。
   *
   * ★ 与 PDF 同一个口子（`BookCompanion` 的 `context.quote`），行为也对齐：
   *   关掉左侧那三块（目录 / 解读 / 划线）—— 中间永远只留一栏；
   *   但**不立刻清空** `companionQuote`，用户随手点一下正文，伴读里的那一句还在。
   * ★ 先 `closePanels()` 再开伴读：反过来的话，伴读刚开就被关掉的那一块挤走一秒，
   *   视觉上是「面板闪了一下」。
   */
  const askAboutQuote = useCallback(() => {
    if (quote === null) return;
    setCompanionQuote(quote.text);
    closePanels();
    setCompanion(true);
    setQuote(null);
  }, [quote, closePanels]);

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

  /** 气泡摆在选区上方还是下方（与 PDF 同一个判据，见 `book-text.js`）。 */
  const quotePlacement = useMemo(() => quoteBarPlacement(quote), [quote]);

  const header = useMemo(() => {
    const parts = [
      String(index?.format ?? book.ext ?? '').toUpperCase() || '电子书',
      formatBytes(book.size),
      total > 0 ? `${total} 页` : '',
    ];
    if (book.series) parts.push(book.series);
    return parts.filter(Boolean).join(' · ');
  }, [index, book.ext, book.size, book.series, total]);

  const sectionText = useMemo(() => (section === null ? '' : blocksToText(section.blocks)), [section]);

  /**
   * 「听本节」：复用文章阅读页那套 TTS 引擎、音色、语速与计费估算，只把正文换成
   * 电子书这一节的纯文本（0.75.x）。**不新造合成器、不新开一套设置**。
   * ★ 读位（page）与听位（listenPage）分开：翻页不写听位，开听不写读位。
   * ★ 放在这里而不是组件开头：正文 `sectionText` 到这一行才算得出来；它仍在
   *   下面 `status === 'error'` 的提前 return **之前**，hook 顺序不会变。
   */
  const ebookSpeech = useEbookSpeech({
    bookId: book.id, page, text: sectionText, total, notify,
  });
  /** 导出也只认当前这一节：没有「全书」入口，字数上限在共用层的计划里把着。 */
  const ebookExport = useEbookExport({
    bookId: book.id, page, text: sectionText, title: book.title, notify,
  });

  const expandedChapter = digest.expandedN === 0
    ? null
    : (digest.outline.find(chapter => chapter.n === digest.expandedN) ?? null);

  const themeColors = THEME_COLORS[look.theme] ?? null;
  const rootStyle = {
    '--npr-font-size': `${look.fontSize}px`,
    '--npr-line-height': look.lineHeight,
    /*
     * 纸面宽度 = 字号 × 每行字数 + 左右内边距。
     * ★ `+ 96` 是**两侧内边距 + 一点余量**（CSS 里 clamp 到 26–68px）：
     *   19px × 36 字 = 684，加 96 得 780，减掉两侧各 68 ⇒ 正文 644px ≈ 34 字/行。
     *   上一版是 `+ 120`：纸面 804px、内边距 52px，正文 700px ≈ 37 字/行 ——
     *   中文一行超过 36 字，眼睛回到行首时容易串行。
     */
    '--npr-ebook-width': `${look.fontSize * look.textWidth + 96}px`,
    ...(look.family ? { '--npr-font-family': look.family } : {}),
    ...(themeColors ? { '--npr-bg': themeColors[0], '--npr-fg': themeColors[1] } : {}),
  };

  // ---- 打不开的书：说清楚是什么格式、能做什么 ----------------------------
  if (status === 'error') {
    return (
      <div className="npr-book-empty" role="alert">
        <Icon name="file-check" size={24} />
        <h2>这本书暂时打不开</h2>
        <p>{error}</p>
        <div className="npr-book-empty-actions">
          <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>
        </div>
        {book.panPath !== '' && (
          <div className="npr-book-path">
            <span>网盘位置（可直接去网盘客户端打开）</span>
            <code>{book.panPath}</code>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={bookRef} className={`npr-book npr-ebook${immersive ? ' is-immersive' : ''}${immersive && peek ? ' is-peek' : ''}${immersive && (tocOpen || marksOpen || digestOpen || findOpen) ? ' has-side' : ''}`}
      style={rootStyle} data-theme={look.theme}
      onPointerMove={onPeekPointerMove} onPointerLeave={onPeekPointerLeave}>
      <div className="npr-book-toolbar" data-window-drag />

      {/*
        ★ 顶部胶囊**与 PDF 阅读器用同一套元素与类名**（`.npr-book-chrome` +
          `.npr-book-pill` + `.npr-book-pill-item`）—— 外观因此天然一致，这里
          **一行「电子书版胶囊」样式都不写**。它也是「样式一致」这条要求最省事
          的实现方式：抄结构，不抄样式。
        ★ 它为什么必须待在 `.npr-book-main` **外面**（0.25.3 修）：上一版把胶囊
          放进书页那个 sticky 页眉里，而页眉挂在滚动容器里 —— 一开目录 / 划线 /
          伴读，阅读列变窄、胶囊跟着挤，最后那颗「沉浸」被裁到纸面外面（用户
          截图里的「出框」）。胶囊属于**窗口**，不属于书页：宽度只该跟窗口变。
        ★ 窄窗口下先砍按钮文字、只留图标（见 refinements.css 的 @media）：六个
          动作 + 书名在 600px 以内放不下，而图标本身认得出来。
      */}
      <div className="npr-book-chrome">
        <div className="npr-book-pill" role="toolbar" aria-label="本书工具">
          <span className="npr-book-pill-title" title={book.title}>{book.title}</span>
          <button type="button" className={`npr-book-pill-item${current.state === 'read' ? ' is-on' : ''}`}
            title="标记读完" aria-pressed={current.state === 'read'} onClick={() => onFinished?.()}>
            <Icon name="circle-check" size={14} />
            <span>{current.state === 'read' ? '已读完' : '标记读完'}</span>
          </button>
          <button type="button" className={`npr-book-pill-item${companion ? ' is-on' : ''}`}
            title="AI 伴读：带着当前这一页追问" aria-pressed={companion}
            onClick={() => {
              if (companion) { setCompanion(false); return; }
              closePanels();
              setCompanion(true);
            }}>
            <Icon name="wand-sparkles" size={14} />
            <span>伴读</span>
          </button>
          {/*
            ★ 读法（0.65.0）：一颗按钮 + 一张三选一的小菜单 —— 原文 / 对照 / 译文。
              用户原话：「针对翻译过的书籍，在阅读的时候是不是应该可以自主选择，
              全中文阅读；全英文阅读，对照阅读。」

            ★ 为什么是三选一、而不是继续沿用「对照开 / 关」那颗开关：开关只能表达两态，
              而这里本来就是三态 ——「全中文」不是「对照关掉」的同义词：关掉对照是
              **只读原文**，全中文是**只读译文**。用一颗开关表达三件事，用户就只能
              靠「开了对照再逐段自己忽略原文」来模拟全中文，那不是功能，是负担。

            ★ 为什么做成菜单而不是三格并排的分段控件：胶囊里已经有 7 项 + 书名，
              再加三格等于又长出一截（0.59.0 那条「百分比把整排撑开」的教训）。
              菜单只占**一颗按钮的宽度**，而按钮上的字（原文 / 对照 / 译文）本身
              就是当前状态 —— 不点开也知道自己在读哪一种。宽度稳定，状态可见。

            ★ 中文书**变灰且不可点**（0.62.0，用户原话「你要判断这本书如果是中文书籍，
              那么对照页是灰掉的不可用」）：这本书没有「译文」可言，三个选项都只会
              得到一句已知结论。判据是整本的（`chineseBook`），不是这一节有没有
              可翻的块 —— 书里夹着一节英文引文时，「对照」仍然该能用。
          */}
          <span className="npr-book-pill-tint">
            <button type="button" className={`npr-book-pill-item${zhOn ? ' is-on' : ''}`}
              disabled={chineseBook}
              title={chineseBook
                ? '这本书的正文是中文，不需要中英对照'
                : `读法：${EBOOK_READ_MODES[readMode].label} —— 点开可选原文 / 对照 / 译文`}
              aria-haspopup="dialog" aria-expanded={modeOpen}
              onClick={() => setModeOpen(value => !value)}>
              <Icon name="languages" size={14} />
              <span>{EBOOK_READ_MODES[readMode].label}</span>
            </button>
            {modeOpen && (
              <div className="npr-book-palette is-mode" role="dialog" aria-label="读法">
                <p className="npr-book-palette-label">这本书怎么读</p>
                <div role="radiogroup" aria-label="读法">
                  {EBOOK_READ_MODE_ORDER.map((key) => (
                    <button key={key} type="button" className="npr-book-mode-item" role="radio"
                      aria-checked={readMode === key}
                      onClick={() => chooseReadMode(key)}>
                      <span className="npr-book-mode-dot" aria-hidden="true" />
                      <span className="npr-book-mode-text">
                        <span className="npr-book-mode-name">{EBOOK_READ_MODES[key].label}</span>
                        <span className="npr-book-mode-desc">{EBOOK_READ_MODES[key].hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="npr-book-palette-foot">
                  译文按节缓存，翻回读过的节是秒开。要一次译完整本，用左栏顶部的「澄境阅读助手」。
                </p>
              </div>
            )}
          </span>
          {/*
            ★ 这里**故意没有**「整本」入口（0.60.0 起）。
              它搬去了右下角的「翻译助手」（`TranslateAssistant.jsx`）。理由是
              工具条属于「对这一段做什么」，而整本翻译是一个**要跑几十分钟、
              期间你会去干别的事**的后台任务：它的进度不该占用一排按钮的宽度
              （百分比一变按钮就变宽，整排跟着挪），也不该在换书 / 切页面时消失。
            ★ 「对照」留在工具条：它是高频、即时、只影响当前这一节的动作 ——
              和一本书的备料是两件事，不合并（合并会让想看一节的人被迫先选「要不要翻整本」）。
          */}
          <button type="button" className={`npr-book-pill-item${marksOpen ? ' is-on' : ''}`}
            title={annotations.length > 0 ? `划线 / 笔记：${annotations.length} 条` : '划线 / 笔记（还没有划线）：在正文里拖选一段字'}
            aria-pressed={marksOpen} onClick={toggleMarks}>
            <Icon name="highlighter" size={14} />
            <span>{annotations.length > 0 ? `划线 ${annotations.length}` : '划线'}</span>
          </button>
          {/* ★ 顶部**故意没有**「写读后感」入口 —— 理由与 `BookReader` 里那条注释
              逐字相同（用户 2026-10-28：入口写在「读完」列表下，不写在工具条里）。
              唯一入口在阅读页「读完」那一行（`bookRowView` 的 read 分支）。 */}
          <button type="button" className={`npr-book-pill-item${findOpen ? ' is-on' : ''}`}
            title="书内搜索（⌘F）：在整本正文里找，回车 / ↓ 上下条跳转" aria-pressed={findOpen}
            onClick={toggleFind}>
            <Icon name="search" size={14} />
            <span>搜索</span>
          </button>
          <button type="button" className={`npr-book-pill-item${tocOpen ? ' is-on' : ''}`}
            title={total > 0 ? `目录（${total} 页）` : '目录'} aria-pressed={tocOpen}
            onClick={() => {
              if (tocOpen) { setTocOpen(false); return; }
              setDigestOpen(false);
              setMarksOpen(false);
              setMarkFocusId('');
              setFindOpen(false);
              setCompanion(false);
              closeCard();
              setTocOpen(true);
            }}>
            <Icon name="bookmark" size={14} />
            <span>目录</span>
          </button>
          {/* ★ 「解读」不再占一个按钮（0.25.2，用户原话：「菜单条为什么会有解读这个按钮，
              打开又和目录差不多，建议去掉，解读还走目录」）。它打开的是一张**章节列表**，
              而那正是目录已经有的东西 —— 两个入口通向同一屏，第一眼就分不清差别。
              现在入口只剩目录面板底部的「逐章解读」：先看目录（免费、书自带），
              想花钱要解读时再往下走一步。 */}
          <span className="npr-book-pill-tint">
            <button type="button" className={`npr-book-pill-item${paletteOpen ? ' is-on' : ''}`}
              title={`书页配色：${TINT_LABEL[look.theme] ?? look.theme}（按 N 轮转）`} aria-pressed={paletteOpen}
              onClick={() => setPaletteOpen(value => !value)}>
              {look.theme === 'dark' || look.theme === 'black'
                ? <Icon name="moon" size={14} />
                : <Icon name="sun" size={14} />}
              <span>配色</span>
            </button>
            {paletteOpen && (
              <div className="npr-book-palette" role="dialog" aria-label="书页配色">
                <div className="npr-book-palette-dim">
                  <Icon name="type" size={13} />
                  <input type="range" aria-label="字号"
                    min={FONT_MIN} max={FONT_MAX} step={1} value={look.fontSize}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setLook(previous => ({ ...previous, fontSize: next }));
                    }}
                    onPointerUp={() => api?.saveSettings?.({ fontSize: look.fontSize }).catch(() => {})}
                    onBlur={() => api?.saveSettings?.({ fontSize: look.fontSize }).catch(() => {})} />
                  <span>{look.fontSize}px</span>
                </div>
                <p className="npr-book-palette-label">纸色</p>
                <div className="npr-book-swatches" role="radiogroup" aria-label="书页纸色">
                  {TINT_ORDER.map((key) => (
                    <button key={key} type="button" className="npr-book-swatch" data-tint={key} role="radio"
                      aria-checked={look.theme === key} aria-label={TINT_LABEL[key]} title={TINT_LABEL[key]}
                      onClick={() => applyTheme(key)} />
                  ))}
                </div>
                <p className="npr-book-palette-label">行距与版心沿用「阅读外观」里的设置</p>
                {/* 格式 / 大小 / 页数：从顶部那条元信息行搬到这儿 —— 想知道的时候找得到，
                    不想知道的时候看不见。 */}
                <p className="npr-book-palette-foot">{header}</p>
              </div>
            )}
          </span>
          <button type="button" className={`npr-book-pill-item${immersive ? ' is-on' : ''}`}
            title={immersive ? '退出沉浸式阅读（Esc）' : '沉浸式阅读（I）：收掉书眉与书脚，窗口大小不变；顶部工具条把鼠标移到面板顶边会滑出'}
            aria-pressed={immersive} onClick={toggleImmersive}>
            <Icon name="maximize" size={14} />
            <span>沉浸</span>
          </button>
        </div>
      </div>

      <div className="npr-book-main">
        {/*
          ★ 三块面板都在**左边**、彼此互斥（DOM 顺序 = 视觉顺序 = 读屏与 Tab 顺序，
            不用 CSS `order` 挪）。划线面板与目录同级：都是「导航 / 回看」类，
            而伴读是对话类，留在右边与订阅那半边同侧。
        */}
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
        {tocOpen && (
          <BookEbookToc
            index={index}
            page={page}
            total={total}
            digestCount={digest.outline.length}
            digestRunning={digest.job?.running === true}
            onJump={go}
            onClose={() => setTocOpen(false)}
            onOpenDigest={() => {
              setTocOpen(false);
              setMarksOpen(false);
              setCompanion(false);
              setDigestOpen(true);
              loadDigestModels();
            }}
          />
        )}
        {digestOpen && (
          <BookDigestPanel
            book={book}
            meta={digest.meta}
            outline={digest.outline}
            job={digest.job}
            currentPage={page}
            generating={digest.generating}
            expandedN={digest.expandedN}
            selected={digest.selected}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
            modelValue={digest.model ?? ''}
            modelCatalog={digest.model === null ? null : digest.modelCatalog}
            onModelChange={changeModel}
            onStart={startDigest}
            onRebuild={restartDigest}
            onJump={go}
            onClose={() => { setDigestOpen(false); closeCard(); }}
            onGenerate={startGenerate}
            onStop={stopGenerate}
            onToggleChapter={toggleChapter}
            onNotify={notify}
          />
        )}

        {findOpen && (
          <BookFindPanel
            query={findQuery}
            onQuery={setFindQuery}
            status={findState.status}
            error={findState.error}
            hits={findHits.map(hit => ({
              key: hit.key,
              where: `第 ${hit.n} 页`,
              sub: hit.sectionTitle,
              snippet: hit.snippet,
            }))}
            activeIndex={findActive}
            unit="section"
            notes={findState.truncated
              ? [`命中到 ${FIND_LIMIT_MAX} 处就停下了 —— 后面还有没有，这次没查完`]
              : []}
            onPick={jumpToFind}
            onStep={stepFind}
            onClose={() => setFindOpen(false)}
          />
        )}

        <div className="npr-book-view">
          <div ref={stageRef} className="npr-book-stage npr-ebook-stage">
            {/*
              ★ 页眉只剩**书眉**一行字：所属的部 / 卷（0.25.3）。书名与六个动作都搬回
                顶部胶囊了（见上面的说明）—— 一个「我在哪一卷」,一个「我在读哪本、
                能对它做什么」，本来就不是同一层信息，挤在同一行才会一开面板就出框。
              ★ 没有上级章节的页（部 / 卷扉页、译本序这类顶层页）**这一行照样占位、只是不写字**：
                整行不渲染会让纸面上边沿在两种页之间来回跳 34px，翻页时看着像抖了一下；
                而这一条横带本身就是纸色（`background: var(--npr-bg)`），空着看不出来。
                跟「白扔一行正文」比，翻页时纸不动更要紧。
              ★ `sticky` 留在滚动容器里：滚动时正文从它下面穿过去，读者一直知道自己在哪一卷。
              ★ `aria-hidden` 不给：它是阅读位置声明，读屏用户同样需要它。
            */}
            {status !== 'error' && (
              <header className="npr-ebook-head">
                {chapterTitle !== '' && (
                  <span className="npr-ebook-head-chapter" title={chapterTitle}>{chapterTitle}</span>
                )}
              </header>
            )}
            {status === 'loading' && (
              <div className="npr-book-hint" role="status">正在整理这本书…（首次打开要解压全文，之后是秒开）</div>
            )}
            {status === 'ready' && section === null && sectionError === '' && (
              <div className="npr-book-hint" role="status">正在取第 {page} 节…</div>
            )}
            {/*
              ★ 抓到的真缺陷（0.25.1）：`section.n !== page` 时旧代码**什么都不渲染** ——
                既没有正文，也没有「正在取…」。快速翻节、或预取回来的旧节顶上来时，
                用户看到的就是一片空白（探针截图里那一版白屏就是这么来的）。
                现在补一条兜底提示，宁可能看见「正在取」，不能看见空气。
            */}
            {status === 'ready' && section !== null && section.n !== page && sectionError === '' && (
              <div className="npr-book-hint" role="status">正在取第 {page} 节…</div>
            )}
            {sectionError !== '' && (
              <div className="npr-book-error" role="alert">
                <Icon name="info" size={22} />
                <h2>这一节取不出来</h2>
                <p>{sectionError}</p>
                <button type="button" onClick={() => { cache.current.delete(page); setPage(page); }}>重试</button>
              </div>
            )}
            {status === 'ready' && section !== null && section.n === page && (
              /* ★ `key={page}`：换节时让这块 DOM 重建，入场动画才会真的重放。
                 不换 key 时 React 复用同一个 <article>，只有文字在变、动画不重跑。
                 ★ `ref={articleRef}`：划词的选区范围、偏移换算都以它为界（见
                 `ebook-marks.js`），也是气泡的定位基准（`position: relative`）。 */
              <article key={page} ref={articleRef} className="npr-ebook-sheet"
                data-read-mode={readMode} lang={zhOnly ? 'zh-CN' : undefined}>
                {/*
                  ★ 这里原来是「整本翻译」的正文进度条（0.59.0），0.60.0 起没了。
                    它画在正文第一屏最上方 —— 而整本翻译是**几十分钟的后台任务**，
                    那几十分钟里用户很可能就在读这一屏。把任务进度钉在正在读的那段
                    文字上面，等于逼他每次翻回本节都先看一遍别人的进度。
                    现在它只在右下角的「翻译助手」里出现，收起时是一个小圆点。
                */}
                {/*
                  译文状态条。★ 四种状态都要说出口，尤其是 `loading`：
                    一节要等几十秒，页面上若什么都不显示，用户会以为按钮坏了。
                  ★ `zhState.n === page` 是**那一帧的护栏**：切节时 section 已经变了、
                    而 effect 还没跑，此时 zhState 仍是上一节的。少了这个判断，
                    上一节的译文会被套到这一节的块下标上 —— 每段都「有译文」，
                    只是全都错位，而且看起来完全正常。
                  ★ 全中文模式下这句话得多半句（0.65.0）：这时页面上显示的是**原文**，
                    不写「先显示原文」，用户会以为「译文」这个选项没生效。
                */}
                {zhOn && zhState.n === page && (zhState.status === 'loading' || zhState.status === 'skip' || zhState.status === 'error'
                  || (zhState.status === 'ready' && zhState.coverage !== null
                    && zhState.coverage.done < zhState.coverage.total)) && (
                  <div className={`npr-ebook-zh-note${zhState.status === 'error' ? ' is-error' : ''}`}
                    role={zhState.status === 'error' ? 'alert' : 'status'}>
                    {zhState.status === 'loading' && (
                      <span>
                        正在翻译这一节…{zhOnly ? '（先显示原文）' : ''}
                        {Array.isArray(zhDone) && zhDone.length > 0 ? `（这本书已译 ${zhDone.length} 节）` : ''}
                      </span>
                    )}
                    {zhState.status === 'skip' && <span>这一节没有需要翻译的英文（中文正文或只有代码）</span>}
                    {zhState.status === 'error' && (
                      <>
                        <span>这一节没翻成：{zhState.error}</span>
                        <button type="button" onClick={() => setZhAttempt((value) => value + 1)}>重试</button>
                      </>
                    )}
                    {zhState.status === 'ready' && zhState.coverage !== null
                      && zhState.coverage.done < zhState.coverage.total && (
                      <span>
                        本节 {zhState.coverage.total} 段，译出 {zhState.coverage.done} 段 ——
                        {zhOnly ? '缺的那几段先显示原文' : '缺的那几段保留原文'}
                      </span>
                    )}
                  </div>
                )}
                {/*
                  ★ 全中文 + 搜索命中（0.65.0）：命中的偏移是**原文**里的，
                    译文那几段不画高亮 —— 不说一句，用户会觉得「搜到了却没跳对」。
                */}
                {zhOnly && findOpen && findHits.some((hit) => hit.n === page) && (
                  <div className="npr-ebook-zh-note" role="status">
                    全中文模式不显示搜索高亮（命中在原文里）—— 切到「对照」能看见它标在哪。
                  </div>
                )}
                {/*
                  ★ 译文 map 只在「这份译文属于当前这一节」时传下去（`zhState.n === page`）。
                    切节那一帧宁可暂时不显示译文，也不要显示上一节的 —— 后者每一段
                    都错位，而用户没有任何线索能看出来。
                */}
                {renderBlocks(section.blocks, marksByIndex, findsByBlock, zhState.n === page ? zhState.map : null, readMode)}
                {/* 划词气泡。★ 放在 `article` 里面而不是外面：正文是可滚动的，
                    放外面就得自己算滚动偏移 —— 滚两屏之后气泡会留在原地。 */}
                {quote !== null && quotePlacement !== null && (
                  <div className="npr-book-quotebar" role="toolbar" aria-label="选中的文字"
                    style={quotePlacement.side === 'above'
                      ? { left: quoteBarLeft(quote.centerX), bottom: quotePlacement.value }
                      : { left: quoteBarLeft(quote.centerX), top: quotePlacement.value }}>
                    <span className="npr-book-quotebar-text" title={quote.text}>{quote.text}</span>
                    {/*
                      「划线」是主操作（最常点）。`onMouseDown` 阻止默认：不阻止的话
                      按下去浏览器就把选区收掉，想「点错了再点一次」就没得点了。

                      ★ 全中文模式下这两颗**灰掉**（0.65.0）。不是偷懒：划线的
                        `start / end` 是**原文里的字符偏移**（`anchorOfSelection`
                        在 DOM 上量出来，而那一屏显示的是译文），存下去之后
                        回到对照模式会把高亮画在原文完全不相干的字上 ——
                        而且看起来很正常，比画不出来更难发现。
                      ★ 「复制」「问伴读」照旧可用：它们只吃选中的那段文字，
                        与偏移无关。
                    */}
                    <button type="button" className="is-primary" disabled={zhOnly}
                      title={zhOnly ? '划线锚在原文上，全中文模式下划不了 —— 切到「对照」再划' : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => { void createMark({ openNote: false }); }}>划线</button>
                    <button type="button" disabled={zhOnly}
                      title={zhOnly ? '笔记挂在划线上，全中文模式下写不了 —— 切到「对照」再写' : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => { void createMark({ openNote: true }); }}>笔记</button>
                    {/* 「问伴读」与 PDF 那颗同名同位（划线 / 笔记之后、复制之前）：
                        两边的气泡按钮顺序不同的话，用户换个格式读就会点错。 */}
                    <button type="button" onClick={askAboutQuote}>问伴读</button>
                    <button type="button" onClick={() => { void copyQuote(); }}>复制</button>
                  </div>
                )}
                <div className="npr-ebook-nav">
                  <button type="button" disabled={page <= 1} onClick={() => go(page - 1)}>
                    <Icon name="chevron-left" size={14} />
                    <span>上一页</span>
                  </button>
                  <button type="button" disabled={page >= total} onClick={() => go(page + 1)}>
                    <span>下一页</span>
                    <Icon name="chevron-right" size={14} />
                  </button>
                </div>
              </article>
            )}
          </div>

          {/*
            ★ 页脚（0.25.1）：进度、位置、一条贴底的细进度条。
              旧版把这些塞进正文上方的元信息行（「EPUB · 412 KB · 7 节 · 19px · 行距 1.9 ·
              ←→ 翻页…」），那是一条**给开发者看的**信息带 —— 读者的眼睛在字上，
              要的只是「我读到哪了」。格式 / 大小 / 字号 / 快捷键都退到配色面板与 tooltip 里。
          */}
          {status === 'ready' && (
            <footer className="npr-ebook-foot">
              <span className="npr-ebook-foot-pos">
                {total > 0 ? `第 ${page} 页 / 共 ${total} 页` : `第 ${page} 页`}
              </span>
              <span className="npr-ebook-foot-pct">{`${percent}%`}</span>
              <span className="npr-ebook-foot-bar" aria-hidden="true">
                <i style={{ width: `${percent}%` }} />
              </span>
            </footer>
          )}

          <div className={`npr-book-fab${fabOpen ? ' is-open' : ''}`}
            onPointerEnter={openFab} onPointerLeave={closeFab}>
            <button type="button" className="npr-book-fab-button"
              aria-expanded={fabOpen} aria-haspopup="true" aria-controls="npr-ebook-fab-list"
              aria-label={fabOpen ? '收起翻页、字号、朗读与导出' : '展开翻页、字号、朗读与导出'}
              title={fabOpen ? '收起（Esc）' : '翻页 / 字号 / 朗读 / 导出 / 定时（← → 翻页 · I 沉浸 · N 配色）'}
              onClick={() => setFabOpen(value => !value)}>
              {/* 「Aa」比齿轮更像阅读器：它说的是「字」，不是「系统设置」。 */}
              <span className="npr-ebook-fab-aa" aria-hidden="true">Aa</span>
            </button>
            <div id="npr-ebook-fab-list" className="npr-book-fab-list" role="group" aria-label="翻页、字号、朗读、语速、导出与定时"
              style={{
                '--npr-fab-span': `${Math.abs(stack[0].y)}px`,
                // 槽位数 − 2：展开动画的延迟基数（规则在 refinements.css，两页共用）。
                // 9 槽 ⇒ 7。写死 6 的话最上面那格的延迟会差 20ms，肉眼无感但守卫会红。
                '--npr-fab-last': stack.length - 2,
              }}>
              <label className="npr-book-fab-slot is-page" style={slotStyle(0)} title={`跳到第几页（共 ${total || '—'} 页）`}>
                <input className="npr-book-page" type="text" inputMode="numeric" aria-label="页码" value={pageDraft}
                  onChange={(event) => setPageDraft(event.target.value.replace(/[^\d]/g, ''))}
                  onBlur={() => go(Number(pageDraft))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); go(Number(pageDraft)); event.currentTarget.blur(); }
                  }} />
                <span className="npr-book-fab-label">页码</span>
              </label>
              <button type="button" className="npr-book-fab-slot" style={slotStyle(1)}
                title="上一页（←）" aria-label="上一页" disabled={page <= 1} onClick={() => go(page - 1)}>
                <Icon name="chevron-left" size={16} />
                <span className="npr-book-fab-label">上一页</span>
              </button>
              <button type="button" className="npr-book-fab-slot" style={slotStyle(2)}
                title="下一页（→）" aria-label="下一页" disabled={total === 0 || page >= total} onClick={() => go(page + 1)}>
                <Icon name="chevron-right" size={16} />
                <span className="npr-book-fab-label">下一页</span>
              </button>
              <button type="button" className="npr-book-fab-slot" style={slotStyle(3)}
                title="字号调小（-）" aria-label="字号调小" disabled={look.fontSize <= FONT_MIN} onClick={() => stepFont(-1)}>
                <Icon name="minus" size={16} />
                <span className="npr-book-fab-label">字小</span>
              </button>
              <button type="button" className="npr-book-fab-slot" style={slotStyle(4)}
                title="字号调大（+）" aria-label="字号调大" disabled={look.fontSize >= FONT_MAX} onClick={() => stepFont(1)}>
                <Icon name="plus" size={16} />
                <span className="npr-book-fab-label">字大</span>
              </button>
              {/* 「听本节」放在 FAB 而不是顶部胶囊：胶囊已有 7 项 + 书名，
                  再加一颗窄窗口下会把书名挤没（见 0.59.0 那条整排撑开的教训）。 */}
              <button type="button"
                className={`npr-book-fab-slot${ebookSpeech.phase === 'playing' ? ' is-on' : ''}`}
                style={slotStyle(5)}
                title={ebookSpeech.hint}
                aria-label={ebookSpeech.phase === 'playing' ? '暂停朗读' : '朗读这一节'}
                aria-pressed={ebookSpeech.phase === 'playing'}
                onClick={ebookSpeech.toggle}>
                {/* ★ 写成两颗静态 Icon，不写 `name={cond ? 'pause' : 'play'}`：
                    图标守卫会扫 `name={...}` 里的**所有**字符串字面量，条件里的
                    `'playing'` 会被当成一个不存在的图标名（icons.test.mjs:77-95）。
                    静态 name 还能顺带被「每个 <Icon name=… /> 都存在」那条判据核到。 */}
                {ebookSpeech.phase === 'playing'
                  ? <Icon name="pause" size={16} />
                  : <Icon name="play" size={16} />}
                <span className="npr-book-fab-label">
                  {ebookSpeech.phase === 'playing' ? '暂停' : '听本节'}
                </span>
              </button>
              {/* 「语速」：点一下换档 慢 → 正常 → 快 → 很快 → 慢。
                  ★ 为什么电子书页非要自己有一颗：设置页的「朗读」只有 API Key 与
                    念准多音字，音色和语速的控件原本**只在文章阅读页的 ⋯ 菜单**里。
                    书架里没有文章可开时，用户在电子书里根本改不了语速 —— 这是硬断点。
                  ★ 与「定时」同一种交互：点一下换一档，不弹下拉、不弹输入框。
                    躺着听的时候点两层才能换档，等于没做。
                  ★ 只做语速、不做音色下拉：语速是「听着听着想调」的高频动作，
                    音色是改一次就不动的低频动作，两者不该共用一个入口。 */}
              <button type="button"
                className={`npr-book-fab-slot${ebookSpeech.speechRate !== 1 ? ' is-on' : ''}`}
                style={slotStyle(6)}
                title={`朗读语速「${ebookSpeech.rateText}」· 点一下换档（慢 / 正常 / 快 / 很快）`
                  + (ebookSpeech.phase === 'playing' ? ' · 正在朗读，改语速会先停下' : '')}
                aria-label={`朗读语速 ${ebookSpeech.rateText}，点一下换下一档`}
                onClick={() => ebookSpeech.changeRate(nextSpeechRate(ebookSpeech.speechRate))}>
                <Icon name="gauge" size={16} />
                <span className="npr-book-fab-label">语速 · {ebookSpeech.rateText}</span>
              </button>
              {/* 「导出本节」两段式：第一次只报价不发请求，第二次才真合成。
                  ★ Icon 用静态 name（图标守卫会扫 name={...} 里所有字面量）。 */}
              <button type="button"
                className={`npr-book-fab-slot${ebookExport.phase === 'working' ? ' is-on' : ''}`}
                style={slotStyle(7)}
                title={ebookExport.hint}
                aria-label="导出本节音频"
                aria-pressed={ebookExport.phase === 'working'}
                onClick={ebookExport.toggle}>
                <Icon name="download" size={16} />
                <span className="npr-book-fab-label">{ebookExport.label}</span>
              </button>
              {/* 「定时」：点一下换档 0 → 15 → 30 → 60 → 0。
                  ★ 不弹对话框、不让填数字 —— 睡前关灯之后填不了输入框。
                  ★ 档位与文案都从 ebook-speech.js 取，测试核的是同一份。 */}
              <button type="button"
                className={`npr-book-fab-slot${ebookSpeech.sleepMinutes > 0 ? ' is-on' : ''}`}
                style={slotStyle(8)}
                title={ebookSpeech.sleepMinutes > 0
                  ? `已设 ${ebookSpeech.sleepMinutes} 分钟后停止朗读，点一下换档（15 / 30 / 60 / 取消）`
                  : '定时关闭：点一下设 15 分钟，再点换 30 / 60 / 取消'}
                aria-label={ebookSpeech.sleepMinutes > 0
                  ? `定时关闭已设 ${ebookSpeech.sleepMinutes} 分钟` : '设置定时关闭'}
                aria-pressed={ebookSpeech.sleepMinutes > 0}
                onClick={() => ebookSpeech.sleep(nextSleepMinutes(ebookSpeech.sleepMinutes))}>
                <Icon name="clock" size={16} />
                <span className="npr-book-fab-label">{sleepLabel(ebookSpeech.sleepMinutes)}</span>
              </button>
            </div>
          </div>
        </div>

        {companion && (
          <BookCompanion
            api={api}
            context={{
              bookId: book.id,
              title: book.title,
              page,
              pages: total,
              loaded: section !== null && section.n === page,
              text: sectionText,
              quote: companionQuote,
            }}
            onClose={() => setCompanion(false)}
            onManagePrompts={onManagePrompts}
            SessionProvider={SessionProvider}
            renderSlot={renderSlot}
          />
        )}

        {expandedChapter !== null && (
          <DigestCard
            chapter={expandedChapter}
            entry={digest.chapters[digest.expandedN]}
            onClose={digest.closeCard}
            onJump={go}
          />
        )}
      </div>
    </div>
  );
}
