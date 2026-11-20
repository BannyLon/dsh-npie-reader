import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { activeParagraphIndex, formatClock, transcriptSourceLabel } from '../transcript.js';
import { translatedCount } from './transcript-translation.js';

/**
 * 「点这一段 → 跳到它的起点」。
 *
 * ★ 抽成导出的纯函数不是为了好看：它是「字幕」与「音频」之间**唯一**的接口，
 *   而 `start` 写成 `end`、忘了 `play`、越界不判，这几种错在界面上都表现为
 *   「点了没反应 / 跳到了下一句」—— 不抛错、不停播。组件里内联写的话，
 *   不装 DOM 就跑不到它（组件一调就进 hooks），这条链路会变成只靠运气。
 *
 * @param {{ seek: (seconds: number, options?: { play?: boolean }) => unknown } | null} controller
 * @param {Array<{ start: number }>} paragraphs
 * @param {number} index
 * @returns {number | undefined} 实际跳到的秒数（没跳就是 undefined）
 */
export function jumpToParagraph(controller, paragraphs, index) {
  const paragraph = Array.isArray(paragraphs) ? paragraphs[index] : undefined;
  if (!paragraph) return undefined;
  if (controller === null || controller === undefined || typeof controller.seek !== 'function') return undefined;
  controller.seek(paragraph.start, { play: true });
  return paragraph.start;
}

/**
 * 单集字幕面板（P0）。
 *
 * 它做三件事，每件都对应一个用户动作：
 *   ① 把字幕显示成**段落**（不是一条条 cue），让「读」这件事成立；
 *   ② 点某一段 → 音频跳到那一段（`data-t` 是段落起点，秒）；
 *   ③ 播放时高亮当前段，并给一个「回到正在播的一段」的入口。
 *
 * ★ 字幕**只作为阅读内容呈现**，不替代正文：正文是文章作者的排版，字幕是他说的话。
 *   两者混在一起会让「这篇文章写了什么」变得没法回答。
 * ★ 自动跟随（0.86.1，两次推翻前面的判断：0.83.0 的「不跟随」、0.85.9 的「舒适区」）。
 *   0.83.0 怕「跟随会打断往回看」，于是只给按钮 —— 真机上等于不可读（209 段）。
 *   0.85.9 改成「离开上下各 40px 的舒适区才滚 + 居中」，当前段于是**长年停在
 *   列表底部**：一眼看过去「正在说的那句在最下面」，下面已经没有内容，观感像卡住。
 *   现在的规则是**贴顶**——正在说的那句永远在列表第一行，往下全是还没听到的：
 *     ① 目标位置 = 当前段顶对齐列表顶；已经贴顶（±2px）就不写 `scrollTop`，防抖；
 *     ② 滚的是**列表自己的 `scrollTop` + 必要时页面最小距离**，不把正文拽走；
 *     ③ 用户滚轮 / 触摸滚动过列表 ⇒ 暂停跟随，点任意一段或「回到正在播的一段」恢复。
 *   ★ 末段附近 `scrollHeight - clientHeight` 到顶之后贴不上去，这是物理限制：
 *     用户要的是「正在说的尽量靠上」，最后几段只能靠底，不做特殊处理。
 * ★ 列表高度不再写死 `46vh` / `100vh - 330px`（0.85.9）：那两档都假设「字幕上方
 *   固定占 330px」，而收听视图里标题 + 播放条 + tab 实测占 500px 以上 ⇒ 盒子比
 *   窗口还高，当前段必然被折到底部看不见。改成**量出来**：窗口高度减去「列表相对
 *   面板顶部的偏移」，窗口一变大变小就重算。
 * ★ 面板不认识 HTTP：数据从 `ReaderPage` 进来，动作通过 `onFetch` 出去。
 *   这样判据可以在内存里喂假数据把「点了哪一段、跳到第几秒」真的跑出来。
 */
/**
 * 语言三态的**唯一**顺序（0.81.0）：原文 → 双语 → 中文 → 原文。
 *
 * ★ 三个状态做成**一个**按钮循环，而不是两个开关（原来播放条一个「双语」、
 *   面板一个「显示原文/显示中文」）：两个开关的取值组合有四种，其中两种是
 *   「同一个意思」（比如双语=true 且 显示原文=true），用户得自己推演它们的
 *   关系。一个按钮三态没有组合问题 —— 按一下就往下走一格。
 */
const LANG_MODES = [
  ['source', '原文', '只显示订阅源给的原文'],
  ['both', '双语', '中文在上、原文小字在下'],
  ['zh', '中文', '只显示中文译文'],
];
const LANG_LABEL = Object.fromEntries(LANG_MODES.map(([id, label]) => [id, label]));
export const nextLang = (mode) => LANG_MODES[(LANG_MODES.findIndex(([id]) => id === mode) + 1) % LANG_MODES.length][0];

export function TranscriptPanel({
  transcript, status = 'idle', error = '', onFetch, controller,
  translation = { status: 'idle', translations: [], total: 0, done: false, error: '' }, onTranslate,
  langMode = 'source', onCycleLang,
  /**
   * 本机识别（0.82.0）。形状与 `ReaderPage` 里那份 state 一致：
   * `{ status, progress, done, total, segments, error, model, sizeMb, stage }`。
   * `status` 取值：`idle` / `preparing` / `running` / `error` / `cancelled`。
   */
  asr = { status: 'idle' },
  onTranscribe, onCancelTranscribe,
  /** 独立收听页里用：不折叠、列表撑满整屏（`ReaderPage` 的收听视图）。 */
  standalone = false,
  /**
   * 「滚到第几秒」的令牌：`{ at, token }`（0.84.0，AI 导读点时间戳时用）。
   *
   * ★ 为什么要 `token` 而不是只传 `at`：同一个时间戳连点两次时，props 没变，
   *   下面那个 effect 不会重跑 —— 用户会觉得「点了没反应」（其实第一次已经滚过去了，
   *   但他可能又手动滚开了）。
   */
  focus = null,
}) {
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(true);
  /** 独立页里始终展开：那一页除了字幕没有别的内容，收起等于把页面清空。 */
  const expanded = standalone || open;
  const listRef = useRef(null);
  /** 面板外框：量「列表顶部相对面板顶部占多少」，用来算列表该有多高。 */
  const panelRef = useRef(null);
  /**
   * 列表的可见高度（px）。`null` = 还没量到，先用 CSS 里那档兜底值。
   *
   * ★ 只在 `expanded` 且真的渲染了列表时才量：折叠态没有 `.npr-tr-list`，
   *   `getBoundingClientRect()` 全是 0，量出来会把高度写成负的。
   */
  const [listHeight, setListHeight] = useState(null);
  /**
   * 列表末尾的留白高度（px，0.86.1）。
   *
   * ★ 为什么必须有这块留白：贴顶的代价是「最后一段滚不到顶端」——`scrollTop` 到
   *   `scrollHeight - clientHeight` 就停了，靠近结尾的那几段只能停在半空。现场
   *   截图里当前段停在底部，有一半就是因为它后面已经没有内容可滚。补一块
   *   「一屏减一段」的占位，任意一段都还有地方把它顶到第一行。
   * ★ 用**占位元素**而不是 `padding-bottom`：`.npr-tr-list` 是
   *   `max-height` + `overflow:auto` 的滚动容器，`box-sizing: border-box` 下
   *   padding 会从内容区里扣掉 —— 一屏的留白会把可视区压得只剩一行。
   */
  const [listTail, setListTail] = useState(0);
  /**
   * 是否自动跟随当前段（0.85.9）。
   *
   * ★ 用 ref 而不是 state：跟随开关**不参与渲染**，写成 state 会在每次暂停/恢复
   *   时多一次无意义的重渲染，而重渲染会让列表滚动位置闪一下。
   * ★ 面板头部那个「回到正在播的一段」按钮读的是 `followHint`（state），它只负责
   *   「要不要显示按钮」，与判定无关。
   */
  const followRef = useRef(true);
  const [followPaused, setFollowPaused] = useState(false);
  /**
   * 「请让跟随 effect 立刻再跑一次」的计数器（0.86.2）。
   *
   * ★ 为什么需要它：跟随 effect 依赖 `[active, expanded, listHeight]`。用户滚开
   *   之后点「继续跟随」时，音频并没有换段 ⇒ `active` 没变 ⇒ effect 不重跑 ⇒
   *   开关虽然打开了，列表却停在原地，看起来就是「按钮没反应」。
   */
  const [followEpoch, setFollowEpoch] = useState(0);
  const paragraphs = Array.isArray(transcript?.paragraphs) ? transcript.paragraphs : [];
  const zhTexts = Array.isArray(translation.translations) ? translation.translations : [];
  const zhReady = translatedCount(zhTexts);

  /**
   * 识别进度按「片」画，不画百分比（0.83.0）。
   *
   * ★ 一集 54 分钟 = 11 片。用户真正想知道的是「还剩几片」；百分比在小数点后动，
   *   盯着看反而觉得没进展。片数超过 40 时按比例合并，避免刻度细到看不清。
   * ★ 只在 running 且片数已知时才算：解码阶段还不知道片数，那时该显示「来回走」的条。
   */
  const tickCount = asr.status === 'running' && asr.total > 0 ? Math.min(40, asr.total) : 0;
  const tickDone = tickCount > 0
    ? Math.min(tickCount, Math.round(((asr.done ?? 0) / asr.total) * tickCount))
    : 0;

  /**
   * 订阅播放时间。
   *
   * ★ 依赖里放 `transcript` 而不是 `paragraphs`：`paragraphs` 每次渲染都是新数组
   *   （来自 props 解构），放进去会让订阅每帧重建一次 —— 高亮会闪。
   * ★ 控制器还没建好（音频没加载）时把高亮清掉，而不是留着上一集的位置。
   */
  useEffect(() => {
    if (!controller) {
      setActive(-1);
      return undefined;
    }
    return controller.subscribe((time) => {
      setActive(activeParagraphIndex(paragraphs, time));
    });
  }, [controller, transcript]);

  const jumpTo = (index) => {
    // 点某一段 = 明确表示「我关心这一段」，把跟随重新打开（他刚才是主动滚开过）。
    // 这里用 `enableFollow` 而不是 `resumeFollow`：`resumeFollow` 会立刻滚回
    // 「当前正在播的那段」，于是点第 30 段时列表会先跳回第 7 段再跳过去 ——
    // 多一次没必要的位移。
    enableFollow();
    jumpToParagraph(controller, paragraphs, index);
  };

  /** 打开跟随开关（不触发滚动）。 */
  function enableFollow() {
    followRef.current = true;
    setFollowPaused(false);
  }

  /**
   * 恢复自动跟随，并**立刻**滚一次（也用于「回到正在播的一段」按钮）。
   *
   * ★ `epoch` 是给下面那个跟随 effect 的「请再跑一遍」信号：只把 `followRef`
   *   置回 true 不够 —— 它不在 effect 依赖里，音频没换段 effect 就不会重跑，
   *   用户按了按钮却看到列表纹丝不动，只会认为按钮是坏的。
   */
  function resumeFollow() {
    enableFollow();
    setFollowEpoch((n) => n + 1);
  }

  /**
   * 量出列表该有多高（0.85.9）。
   *
   * ★ 为什么不能用 CSS 一档写死：可用高度 = 窗口高度 − 「列表上方那一截」。而那一截
   *   在两种形态下差很多（嵌在正文里 ≈ 40px，收听视图里标题 + 播放条 + tab 实测
   *   500px 以上），任何固定值都会在其中一种里错。
   * ★ 用 `列表顶 − 面板顶` 而不是 `列表顶` 的视口坐标：后者随页面滚动变化，
   *   用户往下滚一点盒子的高度就变了 —— 那会让列表在滚动中不停改高度，很跳。
   * ★ `ResizeObserver` 盯面板：切语言（双语/中文）会把行高改掉，面板宽度变化会
   *   让行折成不同行数，两种都不触发 `resize`，只触发它。
   */
  useLayoutEffect(() => {
    if (!expanded) {
      setListHeight(null);
      setListTail(0);
      return undefined;
    }
    const panel = panelRef.current;
    const list = listRef.current;
    if (!panel || !list) return undefined;
    let last = 0;
    let lastTail = -1;
    const measure = () => {
      // `?.()`：判据桩里没有 `getBoundingClientRect`，别让「量不到」变成抛错。
      const strip = list.getBoundingClientRect?.();
      const frame = panel.getBoundingClientRect?.();
      if (!strip || !frame) return;
      const head = strip.top - frame.top;
      if (!(head >= 0)) return;
      // 32 = 列表下沿到窗口底部留的空隙（正好放得下圆角与一行呼吸）。
      const available = Math.round(window.innerHeight - head - 32);
      // 上下都夹一下：太矮读不了三行，太高又会超出窗口（正是这次的现场）。
      const next = Math.max(180, Math.min(available, Math.round(window.innerHeight * 0.94)));
      /**
       * 末尾留白 = 可视高度 − 最后一段的高度（0.86.1）。这样最后一段刚好还能贴顶，
       * 多留一分都是浪费（滚到底会看到一块没用的空白）。
       * 量不到段高时（判据桩 / 还在首帧）退回 80% 一屏，宁可多一点。
       */
      const lastLine = list.querySelector?.(`[data-tr-index="${Math.max(0, paragraphs.length - 1)}"]`);
      const lineH = Number(lastLine?.offsetHeight)
        || Number(lastLine?.getBoundingClientRect?.().height)
        || Math.round(next * 0.2);
      const tail = Math.max(0, next - lineH);
      if (Math.abs(next - last) >= 6) {
        last = next;
        setListHeight(next);
      }
      if (Math.abs(tail - lastTail) >= 6) {
        lastTail = tail;
        setListTail(tail);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(panel);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [expanded, standalone, paragraphs.length, langMode]);

  /**
   * 当前段自动跟着走，并且**一直贴到列表顶部**（0.86.1）。
   *
   * ★ 为什么是贴顶而不是居中：听觉是往下走的，正在说的那句上方全是他已经听完的
   *   内容。居中会让上文白占半屏，而底部那一半（马上要说的）被挤到看不见 ——
   *   现场截图就是「高亮段在底部，下面已经没内容」，观感像字幕卡住。
   * ★ 「已经在顶部」用 ±2px 判断，不每次无条件写 `scrollTop`：连续 effect 里重复
   *   赋值会让滚动条反复细微抖动，读长文很刺眼。
   * ★ `scrollTop` 直接写（不要 smooth）：smooth 在一秒内被连续调用会互相打断，
   *   最后停在哪儿取决于时序 —— 这正是「有时候跟、有时候不跟」。
   * ★ 第二步（页面）用 `block: 'nearest'`：它只走最小距离，不会把标题和播放条顶走。
   */
  useEffect(() => {
    if (!expanded || active < 0 || !followRef.current) return;
    const list = listRef.current;
    const line = list?.querySelector?.(`[data-tr-index="${active}"]`);
    if (!list || !line) return;
    const lineBox = line.getBoundingClientRect?.();
    const listBox = list.getBoundingClientRect?.();
    if (!lineBox || !listBox || lineBox.height === 0) return; // 不在 DOM 里（折叠 / 被隐藏）
    if (Math.abs(lineBox.top - listBox.top) > 2) {
      const offset = lineBox.top - listBox.top + list.scrollTop;
      list.scrollTop = Math.max(0, Math.min(offset, list.scrollHeight - list.clientHeight));
    }
    // 页面这一层只要「能看见」，且只在真的出界时才动。
    const after = line.getBoundingClientRect();
    if (after.top < 8 || after.bottom > window.innerHeight - 8) {
      line.scrollIntoView?.({ block: 'nearest' });
    }
  }, [active, expanded, listHeight, followEpoch]);

  /**
   * 用户自己滚动过列表 ⇒ 暂停跟随（0.85.9，判据在 0.86.2 改过一次）。
   *
   * ★ 只认 `wheel` / `touchmove` / `keydown`，不用 `scroll`：`scroll` 事件分不清
   *   「我们滚的」与「用户滚的」，拿它做判据一定自己把自己的跟随关掉。
   * ★ **但光有 `wheel` 也不够**（0.86.2 现场）：指针恰好停在列表上、用户其实在滚
   *   整个页面时，`wheel` 照样冒泡到这里 ⇒ 跟随被悄悄关掉，界面只剩按钮从
   *   「回到正在播的一段」变成「继续跟随」，没有任何东西告诉用户「不再跟随了」。
   *   真机上表现为「听了几分钟字幕不动」。判据改成**这次手势有没有真的改变
   *   `scrollTop`**：滚页面不会改它，滚列表才会。
   */
  useEffect(() => {
    if (!expanded) return undefined;
    const list = listRef.current;
    if (!list) return undefined;
    const pause = () => {
      followRef.current = false;
      setFollowPaused(true);
    };
    /**
     * 手势之后看位置有没有变。120ms 覆盖惯性滚动的第一帧，又短到不会把「用户
     * 滚完再点播放」这种正常操作误判成一次滚动。
     */
    let probe = 0;
    const watchGesture = () => {
      if (probe) return;
      const before = list.scrollTop;
      probe = setTimeout(() => {
        probe = 0;
        if (Math.abs(list.scrollTop - before) > 3) pause();
      }, 120);
    };
    const onKey = (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) pause();
    };
    list.addEventListener('wheel', watchGesture, { passive: true });
    list.addEventListener('touchmove', watchGesture, { passive: true });
    list.addEventListener('keydown', onKey);
    return () => {
      if (probe) clearTimeout(probe);
      list.removeEventListener('wheel', watchGesture);
      list.removeEventListener('touchmove', watchGesture);
      list.removeEventListener('keydown', onKey);
    };
  }, [expanded, status, paragraphs.length]);

  /**
   * 按播放 / 拖进度条 ⇒ 恢复跟随（0.86.2）。
   *
   * ★ 这两个动作都是「我现在要听这一处」的明确表示。暂停跟随是给「往回看两句」
   *   用的，看完接着听的时候如果没有出口，用户就会陷在「字幕不动、按钮写着
   *   『继续跟随』却不知道那是什么意思」的状态里 —— 现场就是这样。
   * ★ 直接听 `play` / `seeked` 而不是自己做防抖：`seeked` 只有位置真的落地才派发，
   *   比「值变了」更准（`currentTime` 赋值在 `seekable=[0,0]` 时会被夹回去而不报错）。
   * ★ `controller.element` 只是 `<audio>`：判据桩里的假控制器没有它，用可选链兜底。
   */
  useEffect(() => {
    const element = controller?.element;
    if (!element || typeof element.addEventListener !== 'function') return undefined;
    const follow = () => resumeFollow();
    element.addEventListener('play', follow);
    element.addEventListener('seeked', follow);
    return () => {
      element.removeEventListener('play', follow);
      element.removeEventListener('seeked', follow);
    };
  }, [controller]);

  /**
   * 导读点时间戳 → 把字幕滚到对应的那一段（0.84.0）。
   *
   * ★ 用 `activeParagraphIndex`（与高亮同一份判据）而不是自己找「最近的 start」：
   *   两份判据算出来的段号会差一段，而表现是「高亮在第 12 段、滚动停在 11 段」。
   * ★ `block: 'center'`：跳过去之后那一段应该在屏幕中间，上下都还能看到邻居。
   *   `nearest` 会把它贴在边缘，用户失去上下文。
   */
  useEffect(() => {
    if (!focus || !focus.token) return;
    if (paragraphs.length === 0) return;
    const index = activeParagraphIndex(paragraphs, focus.at);
    if (index < 0) return;
    const line = listRef.current?.querySelector?.(`[data-tr-index="${index}"]`);
    line?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [focus, transcript]);

  const scrollToActive = () => {
    if (active < 0) return;
    // 这个按钮同时是「恢复自动跟随」的入口：用户手动滚开之后，按一下就继续跟。
    resumeFollow();
    const list = listRef.current;
    const line = list?.querySelector?.(`[data-tr-index="${active}"]`);
    if (!list || !line) return;
    // 与自动跟随同一口径（贴顶，0.86.1）：按钮做完之后的位置要和「跟着走」时一样，
    // 否则用户点完会看到一次额外的位移。
    const offset = line.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTop = Math.max(0, Math.min(offset, list.scrollHeight - list.clientHeight));
    line.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  const lastEnd = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1].end : 0;
  const sourceLabel = transcriptSourceLabel(transcript?.source?.kind);

  return (
    <section className={`npr-tr${standalone ? ' is-standalone' : ''}`} aria-label="单集字幕" ref={panelRef}>
      <div className="npr-tr-head">
        {standalone ? (
          <div className="npr-tr-toggle is-static">
            <span className="npr-tr-title">字幕</span>
            {status === 'ready' && (
              <span className="npr-tr-meta">{paragraphs.length} 段 · {formatClock(lastEnd)} · {sourceLabel}</span>
            )}
          </div>
        ) : (
          <button type="button" className="npr-tr-toggle" title={open ? '收起字幕' : '展开字幕'}
            aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="npr-tr-title">字幕</span>
            {status === 'ready' && (
              <span className="npr-tr-meta">{paragraphs.length} 段 · {formatClock(lastEnd)} · {sourceLabel}</span>
            )}
          </button>
        )}
        {status === 'ready' && expanded && (
          translation.status === 'loading' ? (
            <span className="npr-tr-progress" role="status">翻译中 {zhReady}/{translation.total || paragraphs.length}</span>
          ) : zhReady > 0 ? (
            <>
              <button type="button" className="npr-tr-zh" data-lang={langMode}
                title={`当前：${LANG_LABEL[langMode] ?? '原文'}。点击切换为「${LANG_LABEL[nextLang(langMode)]}」`}
                onClick={() => onCycleLang?.()}>
                {langMode === 'source' ? '原文' : langMode === 'both' ? '双语' : '中文'}
              </button>
              {/**
                * ★ 0.84.9：模型漏译是**允许**的（提示词就这么写的），以前留空段却
                *   照样报「完成」，用户只看到中英混排、不知道还能补。现在缺口会被
                *   回传（`unfilled` / `translatedCount < total`），这里如实说一句，
                *   并指明出路是「再点一次中文」—— 宿主会从缺口续译，不会重翻全场。
                *   字数控制在一行：窄面板下 `.npr-tr-meta` 会省略，说太细反而被截。
                */}
              {translation.status === 'ready' && zhReady < (translation.total || paragraphs.length) && (
                <span className="npr-tr-meta" title="模型这一批漏译了几段；点「中文」会从缺口续译">
                  {`还有 ${(translation.total || paragraphs.length) - zhReady} 段没译`}
                </span>
              )}
            </>
          ) : (
            <button type="button" className="npr-tr-zh" title="用当前翻译模型把这一集字幕译成中文（会调用模型）"
              onClick={() => onTranslate?.()}>译成中文</button>
          )
        )}
        {status === 'ready' && expanded && active >= 0 && (
          <button type="button" className={`npr-tr-now${followPaused ? ' is-paused' : ''}`}
            title={followPaused ? '自动跟随已暂停（你刚滚过列表）。点这里重新跟上' : '把正在播的一段滚回视野'}
            onClick={scrollToActive}>
            {followPaused ? '继续跟随' : '回到正在播的一段'}
          </button>
        )}
        <button type="button" className="npr-tr-refresh" title="重新从订阅源获取字幕" onClick={() => onFetch?.()}>
          重新获取
        </button>
      </div>

      {status === 'loading' && (
        <p className="npr-tr-hint" role="status">正在获取字幕…</p>
      )}

      {status === 'empty' && (
        <div className="npr-tr-empty">
          <p>这期没有字幕。</p>
          {/*
            ★ 空态不再只是「一句解释 + 一个重新获取」：订阅源没有字幕是**多数情况**
              （中文播客全部没有 `podcast:transcript`），只解释不给出路，等于告诉用户
              「这期你就没法跟着读」。所以这里直接给「本机识别」这条通路。
            ★ 三种状态（准备中 / 识别中 / 可开始）只换说明与按钮，不换容器高度：
              否则点一下按钮，面板会跳一下。
          */}
          {asr.status === 'preparing' && (
            <>
              <p className="npr-tr-hint" role="status">
                {asr.stage === 'model'
                  ? `正在下载识别模型（${Math.round((asr.progress ?? 0) * 100)}%）· 可以先去听，下完自动接着识别`
                  : '正在下载识别引擎（约 18 MB）…'}
              </p>
              <div className="npr-tr-bar" role="progressbar" aria-valuenow={Math.round((asr.progress ?? 0) * 100)}
                aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.min(100, Math.max(0, (asr.progress ?? 0) * 100))}%` }} />
              </div>
            </>
          )}

          {asr.status === 'running' && asr.total > 0 && (
            <>
              <p className="npr-tr-hint" role="status">
                {asr.engine === 'cloud' ? '云端识别中' : asr.engine === 'qwen' ? '本机 Qwen3-ASR 识别中' : '本机识别中'}
                {' · '}第 {asr.done ?? 0}/{asr.total} 片 · 已出 {asr.segments ?? 0} 段
              </p>
              {/* 分片刻度：一格 = 一片（片数多时按比例合并）。已认完的亮起，
                  正在跑的那一格呼吸 —— 「还剩几片」比「43.7%」直观得多。 */}
              <div className="npr-tr-ticks" role="progressbar" aria-valuenow={asr.done ?? 0}
                aria-valuemin={0} aria-valuemax={asr.total} aria-valuetext={`已完成 ${asr.done ?? 0} / ${asr.total} 片`}>
                {Array.from({ length: tickCount }, (unused, index) => (
                  <span key={index} className={index < tickDone ? 'is-done' : index === tickDone ? 'is-active' : ''} />
                ))}
              </div>
              {/* 已识别出的句子直接显示：进度百分比说不了「识别得对不对」，文字可以。 */}
              {Array.isArray(asr.preview) && asr.preview.length > 0 && (
                <p className="npr-tr-preview">{asr.preview.slice(-3).join(' ')}</p>
              )}
              <button type="button" className="npr-btn" onClick={() => onCancelTranscribe?.()}>停止</button>
            </>
          )}

          {/*
            ★ 「在跑但还没有片数」是**解码阶段**（整段 mp3 → 16 kHz WAV，54 分钟音频要 30 秒左右）。
              这时写「第 0/? 片」是假的 —— 片数要解码完才知道。给一条来回走的进度条 + 一句
              「正在解码」，用户才知道这几十秒是在干活而不是卡住。
          */}
          {asr.status === 'running' && !(asr.total > 0) && (
            <>
              <p className="npr-tr-hint" role="status">正在解码音频（这一集要几十秒），随后开始逐片识别…</p>
              <div className="npr-tr-bar is-busy" role="progressbar" aria-valuetext="正在解码">
                <span />
              </div>
              <button type="button" className="npr-btn" onClick={() => onCancelTranscribe?.()}>停止</button>
            </>
          )}

          {asr.status === 'error' && (
            <p className="npr-tr-hint" role="alert">识别没完成：{asr.error}</p>
          )}

          {asr.status !== 'preparing' && asr.status !== 'running' && (
            <>
              {/*
                ★ 三条路的说明必须不同（0.84.0）：「音频不出本机」这句话对云端识别
                  是**反的**。写成一句通用的话，用户会以为自己选的 Groq 也在本机跑。
              */}
              <p className="npr-tr-hint">
                {asr.engine === 'cloud'
                  ? '订阅源里没有字幕。可以交给云端识别 —— 注意：这一集会「上传音频」到你选的服务商。'
                  : asr.engine === 'qwen'
                    ? `订阅源里没有字幕。可以用本机的 Qwen3-ASR 识别一遍 —— 音频不出本机，第一次要下载模型${asr.sizeMb ? `（约 ${(asr.sizeMb / 1024).toFixed(1)} GB）` : ''}。`
                    : `订阅源里没有字幕。可以在这台电脑上识别一遍 —— 音频不出本机，第一次要下载识别模型${asr.sizeMb ? `（约 ${asr.sizeMb} MB）` : ''}，之后不用再下。`}
              </p>
              {/* 宿主已经把「缺哪一件」算好了（`asrStatus().reason`）：直接说出来，
                  比让用户点一次吃一次 409 强。 */}
              {asr.reason ? (
                <p className="npr-tr-hint" role="alert">{asr.reason}。</p>
              ) : null}
              {/* ★ 缺 ffmpeg 时**不给按钮**：模型下完也识别不了（解码那一步就断了），
                  让用户点一次吃一次 409 只是浪费一次下载。直接把缺的那件说出来。
                  whisper 与 qwen 都要 ffmpeg（一个解码整段、一个切 30 秒片）。 */}
              {Array.isArray(asr.missing) && asr.missing.includes('ffmpeg') ? (
                <p className="npr-tr-hint" role="alert">
                  这台机器还缺 ffmpeg（解码音频要用它）：在终端执行 <code>brew install ffmpeg</code>，装好再回来点。
                </p>
              ) : (
                <button type="button" className="npr-btn npr-btn-primary" onClick={() => onTranscribe?.()}>
                  {asr.status === 'error' || asr.status === 'cancelled'
                    ? '再试一次'
                    : asr.engine === 'cloud' ? '云端识别' : '识别这一集'}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="npr-tr-empty" role="alert">
          <p>字幕没能取回来：{error}</p>
          <button type="button" className="npr-btn" onClick={() => onFetch?.()}>再试一次</button>
        </div>
      )}

      {translation.status === 'error' && (
        <p className="npr-tr-hint" role="alert">
          翻译没完成：{translation.error}
          <button type="button" className="npr-btn" onClick={() => onTranslate?.()}>继续翻</button>
        </p>
      )}

      {status === 'ready' && expanded && (
        /**
         * ★ `maxHeight` 由上面量出来（0.85.9）；`listHeight === null` 时退回 CSS 那档
         *   兜底值 —— 首帧还没量到，不能给一个空的高度让盒子塌掉。
         */
        <div className="npr-tr-list" ref={listRef}
          style={listHeight === null ? undefined : { maxHeight: `${listHeight}px` }}>
          {paragraphs.map((paragraph, index) => {
            const zh = typeof zhTexts[index] === 'string' ? zhTexts[index] : '';
            // 三态在**每段**上落地。`zh === ''`（还没翻到这一段 / 源站这一句是英文
            // 却没译出来）时退回原文，而不是留一个空行 —— 空行看起来像「这段没录上」。
            const showZhOnly = langMode === 'zh' && zh !== '';
            const showBoth = langMode === 'both' && zh !== '';
            return (
              <button
                key={`${paragraph.start}-${index}`}
                type="button"
                className={`npr-tr-line${index === active ? ' is-current' : ''}${showBoth ? ' is-both' : ''}`}
                data-t={paragraph.start}
                data-tr-index={index}
                aria-current={index === active ? 'true' : undefined}
                title="跳到这一段"
                onClick={() => jumpTo(index)}
              >
                <span className="npr-tr-stamp">{formatClock(paragraph.start)}</span>
                <span className="npr-tr-text">
                  {showZhOnly ? (
                    <span className="npr-tr-zh-text">{zh}</span>
                  ) : showBoth ? (
                    <>
                      <span className="npr-tr-zh-text">{zh}</span>
                      <span className="npr-tr-en-text">{paragraph.text}</span>
                    </>
                  ) : paragraph.text}
                </span>
              </button>
            );
          })}
          {/**
           * 末尾留白（0.86.1）：让最后几段也能被顶到第一行。
           * `aria-hidden` + `role="presentation"`：它不是内容，读屏不该念它。
           */}
          {listTail > 0 && (
            <div className="npr-tr-tail" aria-hidden="true" style={{ height: `${listTail}px` }} />
          )}
        </div>
      )}
    </section>
  );
}
