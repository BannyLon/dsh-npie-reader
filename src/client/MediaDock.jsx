import { useEffect, useRef, useState } from 'react';
import { BRAND_TITLE } from './brand.js';
import { Icon } from './icons.jsx';
import { createAudioController } from './audio-controller.js';
import { RATE_CHOICES, readProgress, resumeAt, saveProgress } from './media-progress.js';
import { formatClock } from '../transcript.js';
import { LIBRARY_API_PREFIX } from '../library.js';

/**
 * 单集音频的播放条（P0）。
 *
 * 以前这里只有一个裸 `<audio controls>`：能出声，但**没有断点、没有倍速、
 * 没有可被字幕面板驱动的接口**。P0 把它换成「元素 + 控制面」：
 *
 *   - 元素由 React 渲染（`<audio>` 不挂原生控件），所有按钮是我们自己的；
 *   - 控制面是 `audio-controller.js` 的 `createAudioController`，通过
 *     `onController` 交给阅读页，字幕面板据此订阅时间、点段落跳转；
 *   - 断点与倍速记在 `localStorage`（`media-progress.js`），不写 `data.json`。
 *
 * ★ 为什么 `<audio>` 不挂原生 `controls`：原生控件里没有倍速，也没有「±15 秒」，
 *   而这两件是听长节目的基本操作。两套控件并排（原生 + 自定义）更糟：用户会
 *   在两个播放键之间犹豫。
 * ★ 为什么进度**每 5 秒**才写一次：`timeupdate` 一秒四次，每次都写 localStorage
 *   是同步 I/O，在长节目里能听见卡顿。5 秒的代价是「崩溃时最多丢 5 秒」。
 */

/** 落盘节流（毫秒）。 */
const SAVE_EVERY_MS = 5_000;

/**
 * 客户端半区的构建版本（构建时由 `build.mjs` 注入）。
 *
 * ★ `typeof` 的写法与宿主侧同理：单测直接 import 源码时没有 define，
 *   裸引用会抛 `ReferenceError`。
 * ★ 它唯一的用途是**和宿主比对**。宿主在主进程里，必须退出 dsh 才换新；
 *   面板刷新就换。两者不一致时，界面说的和实际行为会完全不同步 ——
 *   这正是「明明修了却还是拖不动」的来源。
 */
const CLIENT_BUILD = typeof __NPIE_READER_VERSION__ === 'string' ? __NPIE_READER_VERSION__ : 'dev';

/**
 * 元素当前的可跳区间，压成 `[起, 止]`；空区间给 `null`。
 *
 * ★ 空区间是「拖不动」的**物理原因**：没有行程，赋值会被静默忽略。它和
 *   「赋值被拒」在界面上一样，但修法完全不同，所以诊断里必须分开打印。
 */
function seekableRange(element) {
  try {
    const s = element.seekable;
    if (s.length === 0) return null;
    return [Number(s.start(0).toFixed(1)), Number(s.end(s.length - 1).toFixed(1))];
  } catch {
    return 'err';
  }
}

/**
 * 浏览器报告的「可跳区间」是不是**没有行程**（0.85.7）。
 *
 * ★ `[0, 0]` 与空区间是同一件事的两种写法：`currentTime = t` 会被夹到 0。
 *   真机诊断拿到的正是 `seekable=[0,0]` —— 有区间对象、长度为 0。
 */
function seekableIsEmpty(element) {
  try {
    const s = element.seekable;
    if (s.length === 0) return true;
    return Number(s.end(s.length - 1)) - Number(s.start(0)) < 1;
  } catch {
    return true;
  }
}

/** 已缓冲到的区间，诊断用（`buffered` 空而 `seekable` 也空 ⇒ 数据根本没进来）。 */
function bufferedRange(element) {
  try {
    const b = element.buffered;
    if (b.length === 0) return null;
    return [Number(b.start(0).toFixed(1)), Number(b.end(b.length - 1).toFixed(1))];
  } catch {
    return 'err';
  }
}

/** 拿一个可用的 storage；隐私模式下取用 `localStorage` 本身就可能抛错。 */
function storageOrNull() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 这一集到底多长 —— **以「可跳范围」为准**（0.85.2）。
 *
 * ★ 为什么不信 `element.duration`：它有两个坏脾气。
 *   ① `preload="metadata"`/`none` 且只取到文件头时，某些封装（moov 在尾部）会先给出
 *      一个**基于码率估算**的时长，等取到尾部才更正；
 *   ② 它可以是 `Infinity`（分片流）。
 *   `seekable.end(0)` 是浏览器「我允许你把播放头放到哪儿」的答案，进度条的分母
 *   用这个值时，用户拖到的任何位置**一定**落在可跳范围内 —— 不会出现「拖到 3 小时
 *   被弹回 1 小时」这种看起来像坏了的现象。
 * ★ 顺序不能反：`duration` 只是 `seekable` 缺席时的兜底（比如元数据刚到的那一刻）。
 */
function readTotal(element) {
  try {
    const seekable = element.seekable;
    if (seekable && seekable.length > 0) {
      const end = Number(seekable.end(seekable.length - 1));
      if (Number.isFinite(end) && end > 0) return end;
    }
  } catch {
    // 某些内核在 `seekable` 上取不到值；退到 duration。
  }
  const duration = Number(element.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

export function MediaDock({ episode, onController }) {
  const audioRef = useRef(null);
  const controllerRef = useRef(null);
  const onControllerRef = useRef(onController);
  const lastSaved = useRef(0);
  /** 上一次落盘的位置（秒）。兜底定时器据此判断「位置真变了才写」。 */
  const lastSavedTime = useRef(0);
  /** 断点恢复只做一次（`loadedmetadata` / `durationchange` / `canplay` 都可能触发）。 */
  const restored = useRef(false);
  /**
   * 第几次跳转。
   *
   * ★ 跳转的「成功与否」是 700ms 后异步判定的，而用户会连点（-15 再 +15、拖完再点）。
   *   没有这个序号时，第一次的判定会拿**旧目标**去比**新位置**，必然算出差值 ——
   *   于是「一切正常」被报成「这个源不支持跳转」。序号对不上就作废这次判定。
   */
  const seekSeq = useRef(0);
  /** 上一次 `#t=` 重载的时刻（2 秒内不重复，连点 ±15 时不至于每次都重新取流）。 */
  const lastFragment = useRef(0);
  /** 重载后要不要接着播。 */
  const fragmentPlay = useRef(false);
  /** 拖动中的目标值（秒）。用 ref 而不是只靠 state：收尾可能被两个监听器同时触发。 */
  const scrubRef = useRef(null);
  /** 用户自己拖过 ⇒ 不要再拿「上次听到哪儿」去覆盖他的选择。 */
  const userSeeked = useRef(false);
  /**
   * 直连上游失败、退回中转后要不要接着播（0.85.8）。
   *
   * ★ 场景：用户点了播放 → 上游被 CSP / 防盗链挡下 → 元素 `error`。此时如果只把
   *   `src` 换掉，界面就停在「暂停」状态等用户再点一次 —— 而他刚才已经点过了。
   *   记住这次意图，等中转那边的 `canplay` 一到就替他按下播放。
   */
  const pendingPlay = useRef(false);
  const [error, setError] = useState('');
  const [rate, setRate] = useState(1);
  const [time, setTime] = useState(0);
  const [total, setTotal] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** 缓冲中（点了播放但还没真正出声）。这一格是「点了没反应」的解药。 */
  const [buffering, setBuffering] = useState(false);
  /**
   * 拖动中的临时位置。
   *
   * ★ 必须与 `time` 分开：`time` 由 `timeupdate` 驱动（每 0.15 秒一次），
   *   拖动时它还在往回写，滑块就会「拉着你往回动」。`null` = 没在拖。
   */
  const [scrubbing, setScrubbing] = useState(null);
  /**
   * 已经退到「换源重载」这条路上（`null` = 还没试过）。
   *
   * ★ 有些宿主环境里 `element.currentTime = t` 会**静默失效**：不抛错、不派发
   *   `seeked`、`seekable` 也可能是非空区间 —— 代码每一行都对，就是跳不过去。
   *   这种时候唯一的出路是**不用 seek**：把 `src` 改成带媒体片段 `#t=秒`
   *   再 `load()`，让浏览器从该位置开始取流（实测有效）。
   * ★ 它不报错、只把预期说清楚：每次跳转会重新加载，会停顿一两秒。用户能接受
   *   「慢一点但真的跳过去了」，不能接受「点了没反应」。
   */
  const [seekFallback, setSeekFallback] = useState(false);
  /**
   * 宿主侧自检结果：`/library/audio-info` 的答复（0.85.4）。
   *
   * `null` = 还没探测到（探测中 / 请求失败）。其余形状：
   *   `{ build: '0.85.4', seekable: true }`   → 宿主是新的，且这条流能定位
   *   `{ build: null, missing: true }`        → **这条路由不存在** ⇒ 宿主还是旧代码
   *   `{ build: '0.85.4', seekable: false }`  → 宿主是新的，但上游确实不支持分段
   *
   * ★ 为什么要这一格：这三种情况在界面上的表现**完全一样**（拖不动、±15 无反应）。
   *   没有它就只能猜，而我已经猜错过两次。有了它，界面能直接说出是哪一种。
   */
  const [hostState, setHostState] = useState(null);
  /**
   * 上次跳转失败时浏览器内部的真实读数（0.85.6）。
   *
   * ★ 这一格是**临时诊断**，不是功能：`duration` / `seekable` / `readyState`
   *   在真机上到底是什么，只有浏览器自己知道。我在本地用同样的上游、同样的
   *   中转、同样的 Chrome 量到的是 `3987.6 / [0,3988]`，和真机对不上 —— 那就
   *   说明两边有某个我没复刻到的东西。与其继续猜，不如让真机把它印出来。
   * ★ 修好之后这一行会自动消失（只有失败时才填）。
   */
  const [diag, setDiag] = useState(null);
  /**
   * 浏览器**自己**发一次 Range 请求看到的东西（0.85.6）。
   *
   * ★ 为什么非要有它：`audio-info` 报的是**中转层**的输出（status 206、头齐全），
   *   那是宿主内部的视角。而 `<audio>` 看到的是**宿主外层之后**的响应 ——
   *   两者可以不同（状态码被归一成 200、头被中间层过滤、body 被重新切过）。
   *   现场的症状（能播、时长是估算值、不可 seek）恰好符合「206 被变成 200」：
   *   200 没有分段语义，`seekable` 就是空区间，`duration` 只能靠码率外推。
   * ★ `bytes=0-1` 只有两个字节，代价可以忽略；`no-store` 保证读到的是这一刻。
   */
  const [probe, setProbe] = useState(null);
  /**
   * 媒体源走**上游原地址**还是**宿主中转**（0.85.8）。
   *
   * ★ 结论先写在前面：**默认直连上游**。理由是实测出来的，不是猜的：
   *   ① 用户在浏览器里直接放上游地址，拖进度条丝滑 —— 上游 `Range` 支持完好。
   *   ② 走宿主中转时，宿主外层那条「把 renderer 请求转给本机服务」的转发层会
   *      **扣掉 `content-length`**（本仓库 `library-routes.js` 顶部的 pdf.js 注释
   *      记着同一件事，`WITHHELD_RESPONSE_HEADERS`）。收到的 206 没有长度 ⇒
   *      Chromium 判 `seekable = [0,0]` ⇒ `currentTime` 赋值被夹回 0 ⇒ 拖不动、
   *      ±15 无效。**这条路上永远修不好**：头是转发层扣的，不在我们的代码里。
   *   ③ 0.85.7 试过「让客户端拿宿主端口直连」，结果更糟：宿主端口只接受转发层
   *      带过来的请求（直连回 401），界面变成「音频源打不开」。
   *
   * ★ 中转**仍然保留**，作为兜底：上游若被 CSP/防盗链挡住、或某些托管商的 302
   *   链在浏览器里不可播，`<audio>` 一报错就自动换回中转。用户至少能听，
   *   只是那种情况下跳转仍受转发层限制。
   */
  const [viaProxy, setViaProxy] = useState(false);
  /**
   * 换源重载时用的媒体片段秒数（`#t=秒`，`null` = 不加片段）。
   *
   * ★ 必须走 state，**不能**直接写 `element.src`（0.85.7）。`src` 是 React 的
   *   受控属性：DOM 上被改过之后，只要这个组件重新渲染，React 就会拿 props 里的
   *   值把 `src` 写回去 —— 于是「重载到 391.5 秒」立刻退回 0 秒。现场那句
   *   「要靠重新加载才能定位」出现了、位置却没动，就是这一下被抹掉的。
   */
  const [fragment, setFragment] = useState(null);
  const shown = scrubbing === null ? time : scrubbing;
  /**
   * 宿主与客户端**不是同一版**（0.85.4）。
   *
   * ★ `missing` 单独判：拿不到答复（404）时 `build` 是 `null`，但结论同样是
   *   「对面没重载」。只看 `build !== CLIENT_BUILD` 会漏掉这一种 —— 而它恰恰
   *   是最常见的一种。
   * ★ `build === 'dev'` 不算过期：源码直跑时两边都是 `dev`。
   */
  const hostStale = hostState !== null && (
    hostState.missing === true
    || (typeof hostState.build === 'string' && hostState.build !== CLIENT_BUILD)
  );
  /** 供 `setTimeout` 里的判定读（闭包会捕获旧值，读到的是过期的事实）。 */
  const hostStaleRef = useRef(false);
  hostStaleRef.current = hostStale;
  /**
   * 总时长的**兜底值**：feed 里的 `<itunes:duration>`。
   *
   * ★ 两条来源都要：`total` 是 `<audio>` 自己的 `duration`（最准，但要在 metadata
   *   到达之后才有）；`episode.duration` 是订阅解析时存下的 `<itunes:duration>`。
   *   实测好几家播客（小宇宙 `media.xyzcdn.net` 就是）解析出来的条目**没有
   *   `duration` 字段** —— 这时候只剩 `<audio>` 一条路，而它以前要等用户点播放
   *   才来（`preload="none"`）⇒ 分母是 0 ⇒ 滑块无处可去。
   *
   * ★ 0 是**有意义的状态**，不是「没有时长」：界面要据此区分「正在读时长」
   *   与「这一集真的没有时长」，不能都画成一根拉满的空轨道。
   */
  const feedDuration = Number(episode?.duration);
  const shownTotal = total > 0 ? total : (Number.isFinite(feedDuration) && feedDuration > 0 ? feedDuration : 0);
  const percent = shownTotal > 0 ? Math.max(0, Math.min(100, (shown / shownTotal) * 100)) : 0;

  const key = typeof episode?.key === 'string' ? episode.key : '';
  /**
   * 两条源：**上游原地址**（默认）与**宿主中转**（兜底）。
   *
   * ★ 上游原地址就是「用原地址打开」按钮用的那一条 —— 用户已经实测过：在浏览器里
   *   拖动丝滑。它由托管商（`media.xyzcdn.net` 这类）提供，`Range` / `content-length`
   *   都齐全，Chromium 能算出 `seekable = [0, 时长]`，所以拖进度、±15、断点续听
   *   三件事**同时**成立。
   *
   * ★ 中转那条为什么只能在兜底：地址里带 `&v=<构建版本>`（0.85.5）是为了破掉浏览器
   *   手里那份坏缓存 —— 音频响应带 `cache-control: max-age=3600`，旧版写错的头能在
   *   浏览器里活一小时，换代码、重启宿主全都没用。但缓存不是根因，真正的问题还在
   *   转发层扣 `content-length`（见上面 `viaProxy` 的注释）。
   */
  const upstream = typeof episode?.audio === 'string' ? episode.audio : '';
  const proxySource = key === '' ? '' : `${LIBRARY_API_PREFIX}/audio?key=${encodeURIComponent(key)}&v=${encodeURIComponent(CLIENT_BUILD)}`;
  /**
   * 只有一种情形**不许**用上游：地址不是 http(s)（`file:` / `data:` 之类），
   * 或压根没有 `audio` 字段。这时直接用中转，别让 `<audio>` 拿一个假地址发呆。
   */
  const upstreamUsable = /^(https?:)?\/\//i.test(upstream);
  const baseSource = viaProxy || !upstreamUsable ? proxySource : upstream;
  /**
   * 真正交给 `<audio>` 的地址：兜底重载时带 `#t=秒`。
   *
   * ★ `#t=` 是**媒体片段**，浏览器解析出 metadata 后直接定位到该秒数，不需要
   *   服务器支持分段。它是「`currentTime` 赋值被吃掉」这条死路的唯一出口。
   */
  const source = baseSource === '' || fragment === null ? baseSource : `${baseSource}#t=${fragment}`;

  // 父组件每次渲染都会传一个新的内联函数，用 ref 接住，避免把 effect 变成每次重建。
  useEffect(() => {
    onControllerRef.current = onController;
  }, [onController]);

  /**
   * 造控制器。依赖只有 `key`：换一集才重建（换了 src 就是另一个播放器）。
   *
   * ★ 卸载时**立刻补写一次进度**：用户点别的文章时，最后 5 秒内的位置还没落盘，
   *   不补这一次，「切走再回来」会退回 5 秒前 —— 正是「断点续听」最容易被判定
   *   为失效的场景。
   */
  useEffect(() => {
    const element = audioRef.current;
    if (!element || key === '') return undefined;
    // 换集时把上一集的观感清干净：残留的「音频源打不开」会挂在新一集上面，
    // 让用户以为新这一集也坏了。
    setError('');
    setBuffering(false);
    setPlaying(false);
    setTime(0);
    setTotal(0);
    setScrubbing(null);
    setSeekFallback(false);
    setDiag(null);
    // 换集把「兜底走中转」这件事也清掉：上一集可能因为防盗链退回了中转，
    // 新一集的上游地址没准是好的，不能带着上一集的结论起播。
    setViaProxy(false);
    // `#t=` 的片段是**上一集**的定位，留下来会让新一集从上一集的位置起播。
    setFragment(null);
    lastFragment.current = 0;
    scrubRef.current = null;
    userSeeked.current = false;
    restored.current = false;
    lastSavedTime.current = 0;
    /**
     * ★ 挂载就把「上次听到哪儿」读到界面上（0.85.0）。
     *
     * 只负责**显示**：定位要等总时长（`resumeAt` 要用它判断「是不是已经快听完」），
     * 那一步在 `restore()` 里做。这里先读，是为了让进度条一出现就带位置，
     * 而不是先闪一下 00:00 再跳过去。
     */
    const preview = readProgress(storageOrNull(), key);
    if (preview.t > 0) setTime(preview.t);
    setRate(preview.rate);
    // 倍速也要在挂载时应用：只改 `<select>` 的值而元素还是 1× 时，
    // 界面写着 1.25×、耳朵听到 1×，用户只会认为「倍速坏了」。
    element.playbackRate = preview.rate;

    const controller = createAudioController(element);
    controllerRef.current = controller;
    onControllerRef.current?.(controller);

    /**
     * 分母同步（0.85.2）。
     *
     * ★ 必须**每次**事件都同步，不能只写在 `restore()` 里：`restore()` 是一次性的
     *   （`restored` 一锁就不再跑），而总时长是**会变的** —— 文件头先给出一个
     *   估算值，等取到尾部（moov）才更正。只写一次的话，进度条的分母永远停在
     *   那个估算值上（现场：真实 1:06:27 的一集显示成 6:27:27），用户拖到的位置
     *   与实际播放位置完全脱节，看起来就是「拖了没用」。
     * ★ `setTotal` 传同值时 React 会 bailout，不会引发无谓重渲染，所以绑
     *   `progress`（一秒几次）没有代价。
     */
    const syncTotal = () => {
      const value = readTotal(element);
      if (value > 0) setTotal(value);
    };

    /**
     * 断点恢复（0.85.1）。
     *
     * ★ 为什么绑多个事件而不是只绑 `loadedmetadata`：这是「听过的位置回不去」
     *   最容易复发的地方。`preload="metadata"` 之下 `loadedmetadata` 正常会来，
     *   但元素如果被浏览器换过源、或者宿主把它从文档里挪过位置，这个事件可能
     *   只派发一次且早于我们挂上监听 —— 那就永远不恢复。`durationchange` 与
     *   `canplay` 是便宜的保险，`restored` 保证只做一次。
     * ★ 恢复走 `controller.seek()` 而不是直接写 `element.currentTime`：
     *   路径只有一条，「为什么字幕没跟着跳」这类问题才不会两边各有一套答案。
     */
    const restore = () => {
      syncTotal();
      if (restored.current || userSeeked.current) return;
      const total = readTotal(element);
      if (total <= 0) return;
      restored.current = true;
      const saved = readProgress(storageOrNull(), key);
      element.playbackRate = saved.rate;
      setRate(saved.rate);
      const at = resumeAt(saved, total);
      if (at > 0) {
        controller.seek(at, { play: false });
        return;
      }
      // 不该恢复（开头 3 秒内 / 已到结尾 / 没有记录）⇒ 把预读显示的位置纠正回真实值，
      // 否则进度条会停在「上次听到 59:50」，实际却从 0 开始播。
      setTime(Number(element.currentTime) || 0);
    };
    for (const name of ['loadedmetadata', 'durationchange', 'canplay', 'progress']) {
      element.addEventListener(name, restore);
    }
    // 源已经就绪（缓存命中时 `metadata` 可能在我们挂监听之前就到了）。
    if (element.readyState >= 1) restore();

    const unsubscribe = controller.subscribe((current) => {
      // 元数据没到时 `currentTime` 恒为 0：别用这个 0 盖掉刚预读出来的位置。
      if (element.readyState === 0 && current === 0 && preview.t > 0) return;
      setTime(current);
      const now = Date.now();
      if (now - lastSaved.current >= SAVE_EVERY_MS) {
        lastSaved.current = now;
        lastSavedTime.current = current;
        saveProgress(storageOrNull(), key, { t: current, rate: element.playbackRate });
      }
    });

    /**
     * ★ 兜底落盘（0.85.1）。
     *
     * `timeupdate` 只在**播放中**来；暂停、缓冲、面板被系统挂起时都不来。而
     * 「关掉这一集」最常见的动作恰好是「先暂停，再点别处」。只靠 `timeupdate`
     * 与卸载时的 cleanup，会把最后一段位置丢掉。
     * 每 4 秒对一次表、位置变了才写 —— 代价可忽略，换来「暂停了也不会忘」。
     */
    const tick = window.setInterval(() => {
      const t = Number(element.currentTime) || 0;
      if (t <= 0) return;
      if (Math.abs(t - lastSavedTime.current) < 1) return;
      lastSavedTime.current = t;
      saveProgress(storageOrNull(), key, { t, rate: element.playbackRate });
    }, 4_000);

    return () => {
      window.clearInterval(tick);
      unsubscribe();
      for (const name of ['loadedmetadata', 'durationchange', 'canplay', 'progress']) {
        element.removeEventListener(name, restore);
      }
      controller.dispose();
      controllerRef.current = null;
      onControllerRef.current?.(null);
      saveProgress(storageOrNull(), key, { t: Number(element.currentTime) || 0, rate: element.playbackRate });
    };
  }, [key]);

  /**
   * 问宿主一句：你到底是不是新代码、这条流到底能不能定位（0.85.4）。
   *
   * ★ 只在换集时问一次。它回答的是「环境」问题，不是「这一秒」的问题。
   * ★ 失败**不上报为错误**：播放本身不依赖它。它只影响要不要多显示一句话。
   * ★ 用 `AbortController` 而不是 `alive` 一个标记：换集时把上一次的请求也掐掉，
   *   否则上一集的答复可能晚到，把新一集的状态写脏。
   */
  useEffect(() => {
    if (key === '') {
      setHostState(null);
      return undefined;
    }
    let alive = true;
    const controller = new AbortController();
    setHostState(null);
    // `cache: 'no-store'`：这是一次「现在到底能不能跳」的体检，读到昨天那份缓存
    // 等于问错了人 —— 而它给出的结论会直接决定界面显示哪句提示。
    fetch(`${LIBRARY_API_PREFIX}/audio-info?key=${encodeURIComponent(key)}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!alive) return null;
        /**
         * ★ 只有**没有 `code` 的错误答复**才算「宿主是旧版」（0.85.8）。
         *
         * 以前这里写的是「非 2xx ⇒ missing」。于是宿主正常回一句
         * `404 { code: 'NO_AUDIO' }`（这一集确实没有音频、或 key 对不上）时，界面
         * 会理直气壮地说「宿主组件还是旧版（没有自检接口）」—— 用户重启十次也
         * 消不掉。旧宿主真的没有这条路由时，404 是 HTML/空体，JSON 解析不出来。
         */
        const info = await response.json().catch(() => null);
        if (!response.ok) {
          const hasCode = info !== null && typeof info.code === 'string' && info.code !== '';
          if (hasCode) {
            return { build: typeof info.build === 'string' ? info.build : null, seekable: false, missing: false, note: info.code };
          }
          return { build: null, seekable: false, missing: true };
        }
        return info;
      })
      .then((info) => {
        if (!alive || info === null) return;
        if (info.missing === true) {
          setHostState(info);
          return;
        }
        setHostState({
          build: typeof info.build === 'string' ? info.build : null,
          seekable: info.seekable === true,
          missing: false,
        });
      })
      .catch(() => {
        // 探测失败（宿主端口不通、面板 CSP）：保持 `null`，界面不据此下结论。
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [key]);

  /**
   * 用浏览器自己的网络栈发一次两字节的 Range 请求，把**实际收到的响应**记下来。
   *
   * ★ 与上一条自检的分工：上一条问宿主「你打算回什么」，这一条问浏览器
   *   「你实际收到了什么」。中间隔着宿主 webserver、压缩中间件、可能的代理 ——
   *   能出问题的地方正好都在那一段里。
   * ★ 只在诊断用，不参与播放决定：`<audio>` 该播还是播，别让一次探测影响主路径。
   */
  useEffect(() => {
    if (source === '') {
      setProbe(null);
      return undefined;
    }
    let alive = true;
    const controller = new AbortController();
    setProbe(null);
    fetch(source, {
      headers: { Range: 'bytes=0-1' },
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => {
        if (!alive) return null;
        const snapshot = {
          status: response.status,
          cr: response.headers.get('content-range'),
          cl: response.headers.get('content-length'),
          ce: response.headers.get('content-encoding'),
          ar: response.headers.get('accept-ranges'),
        };
        response.body?.cancel?.().catch(() => {});
        return snapshot;
      })
      .then((snapshot) => {
        if (alive && snapshot !== null) setProbe(snapshot);
      })
      .catch(() => {
        // 探测失败不影响播放；保持 `null`，诊断里显示「未应答」。
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [source]);

  /**
   * 跳到某个位置 —— 界面上**所有**跳转动作的唯一入口（0.85.1）。
   *
   * ★ 为什么按钮不直接 `controllerRef.current?.nudge()`：控制器是在 effect 里
   *   创建的，而按钮第一帧就能点。`?.` 会把「控制器还没装上」变成**静默无操作**：
   *   用户按 ±15，界面一声不响。这里在控制器缺席时退回直接写 `element.currentTime`
   *   —— 两条路都能动，而且只有一个地方需要维护。
   * ★ 目标先夹进 `seekable` 再赋值：`±15s` 是「当前位置 + 15」，在结尾处必然越界，
   *   越界赋值会被浏览器夹到 `seekable.end`，看起来像「按了 +15 却没到」。
   * ★ 500ms 后**真的校验一次**，没过就换源重载（见 `fragmentSeek`）。这一步是
   *   「点了没反应」的最后一道保险：`currentTime` 赋值在某些环境里静默失效，
   *   而 `#t=` 媒体片段不需要 seek 能力。
   */
  const seekTo = (seconds, options) => {
    const element = audioRef.current;
    if (!element) return 0;
    const requested = Number(seconds);
    let target = Number.isFinite(requested) ? Math.max(0, requested) : 0;
    const ceiling = readTotal(element);
    if (ceiling > 0 && target > ceiling - 0.25) target = Math.max(ceiling - 0.25, 0);
    const wantPlay = options?.play !== false && !element.paused;
    const controller = controllerRef.current;
    // 用户一旦自己定位过，断点恢复就不该再把他拉回旧位置（包括 metadata 晚到的情形）。
    userSeeked.current = true;
    /**
     * ★ 浏览器说「没有可跳区间」时，赋值 `currentTime` 会被**静默夹回 0**
     *   （0.85.7）。这时候再等 500ms 校验只是让用户多等半秒才看到结论，
     *   所以直接走后一条路：换源到 `#t=秒` 重载。元数据未到时不能这么判
     *   —— 那时 `seekable` 本来就空，赋值会进 `pendingSeek`，是正常路径。
     */
    if (
      element.readyState >= 1
      && !element.seeking
      && seekableIsEmpty(element)
      && !hostStaleRef.current
    ) {
      if (fragmentSeek(target, options?.play !== false && !element.paused)) return target;
    }
    if (controller) {
      controller.seek(target, options);
    } else {
      try {
        element.currentTime = target;
      } catch {
        // 元数据还没到：赋值会抛 `InvalidStateError`，交给 `restore()` 补。
      }
      setTime(target);
    }
    const seq = seekSeq.current + 1;
    seekSeq.current = seq;
    window.setTimeout(() => {
      // 这期间又跳了一次 / 换了集：这次判定作废（否则拿旧目标比新位置，必报假失败）。
      if (seq !== seekSeq.current) return;
      const current = audioRef.current;
      if (!current) return;
      // 元数据还没到：赋值进了 `pendingSeek`，这一刻看到 0 是正常的。
      if (current.readyState < 1) return;
      // 还在跳（远端缓冲要时间）：不能判失败。
      if (current.seeking) return;
      if (Math.abs(Number(current.currentTime) - target) <= 3) {
        // 这次真的跳过去了 ⇒ 上一轮的诊断结论作废，别让它一直挂在界面上。
        setDiag(null);
        return;
      }
      /**
       * ★ 记下浏览器内部读数（0.85.6）。这一行只在**跳转失败**时出现，
       *   内容是 `duration` / `seekable` / `readyState` 与请求的目标值。
       *   它回答的正是「到底是没有行程，还是有行程但赋值被忽略」——
       *   这两件事在界面上看起来一模一样，修法却完全不同。
       */
      setDiag({
        dur: Number.isFinite(current.duration) ? Number(current.duration.toFixed(1)) : String(current.duration),
        seekable: seekableRange(current),
        buf: bufferedRange(current),
        rs: current.readyState,
        target: Number(target.toFixed(1)),
        at: Number(current.currentTime.toFixed(1)),
        viaProxy,
      });
      /**
       * ★ 宿主是旧版 ⇒ **不要**换源重载（0.85.4）。
       *
       *   旧宿主不透传/补齐 `content-range`，`#t=` 一样定位不了（浏览器不知道
       *   目标秒数在文件里的字节偏移），只会白付一次重载的停顿，还附一句
       *   「要靠重新加载才能定位」的假承诺。真正该说的是「宿主没更新」。
       */
      if (hostStaleRef.current) return;
      // 赋值确实没生效 ⇒ 不用 seek，换源重载到该位置。
      fragmentSeek(target, wantPlay);
    }, 500);
    return target;
  };

  /**
   * 不用 seek 的跳转：把 `src` 换成带媒体片段 `#t=秒` 的地址再 `load()`。
   *
   * ★ 为什么需要它：在某些宿主环境里 `element.currentTime = t` 是**静默失效**的
   *   （不抛错、不派发 `seeked`，`seekable` 甚至是非空区间）。此时任何「先赋值
   *   再等事件」的写法都不会有反应 —— 唯一的出路是让浏览器**从头按片段取流**。
   *   实测 `#t=1800` 对远端 m4a 有效：`currentTime` 直接从 1800 起播。
   * ★ 代价是重新加载（可能顿一两秒），所以只在赋值被证明无效时才走这条路。
   * ★ 2 秒内不重复重载：用户连点 ±15 时，第二次改回赋值（缓冲还在，通常就成了）。
   */
  const fragmentSeek = (seconds, wantPlay) => {
    const now = Date.now();
    if (now - lastFragment.current < 2_000) return false;
    if (baseSource === '') return false;
    const at = Number(Math.max(0, seconds).toFixed(1));
    lastFragment.current = now;
    fragmentPlay.current = wantPlay;
    setSeekFallback(true);
    setTime(at);
    userSeeked.current = true;
    setFragment(at);
    return true;
  };

  /** `#t=` 地址一进 state 就重载一次，并（需要时）继续播放。 */
  useEffect(() => {
    if (fragment === null) return undefined;
    const element = audioRef.current;
    if (!element) return undefined;
    element.load();
    if (!fragmentPlay.current) return undefined;
    const resume = () => {
      element.removeEventListener('loadedmetadata', resume);
      Promise.resolve(element.play()).catch(() => {});
    };
    element.addEventListener('loadedmetadata', resume);
    return () => element.removeEventListener('loadedmetadata', resume);
  }, [fragment]);

  /**
   * 系统媒体面板（macOS 控制中心 / 耳机线控）。
   *
   * ★ 保留这一段是上一版就有的行为，P0 把跳转改走控制器，并补上 `seekto`：
   *   控制中心拖进度条派发的是 `seekto`，不接它的话「拖动没反应」，而播放、
   *   暂停都是好的 —— 这种半好半坏最容易被当成系统 bug。
   */
  useEffect(() => {
    if (!episode || !navigator.mediaSession) return undefined;
    const session = navigator.mediaSession;
    if (typeof MediaMetadata !== 'undefined') {
      session.metadata = new MediaMetadata({
        title: episode.titleZh || episode.title,
        artist: episode.author || episode.channelName || BRAND_TITLE,
      });
    }
    const handlers = {
      play: () => { void (controllerRef.current?.play() ?? audioRef.current?.play()); },
      pause: () => {
        if (controllerRef.current) controllerRef.current.pause();
        else audioRef.current?.pause();
      },
      // ★ 走 `seekTo`：系统面板与界面按钮必须是同一条路径，否则「按键盘上的
      //   快进键能跳、点界面上的 +15 不跳」这种差异会被当成界面坏了。
      seekbackward: () => {
        const el = audioRef.current;
        if (el) seekTo(Number(el.currentTime) - 15, { play: !el.paused });
      },
      seekforward: () => {
        const el = audioRef.current;
        if (el) seekTo(Number(el.currentTime) + 15, { play: !el.paused });
      },
      seekto: (details) => {
        if (typeof details?.seekTime !== 'number') return;
        seekTo(details.seekTime, { play: !audioRef.current?.paused });
      },
    };
    for (const [name, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(name, handler);
      } catch {
        // 某些动作在当前平台不支持，注册失败不影响其它动作。
      }
    }
    return () => {
      session.metadata = null;
      for (const name of Object.keys(handlers)) {
        try {
          session.setActionHandler(name, null);
        } catch {
          // 同上。
        }
      }
    };
  }, [episode?.key, episode?.title, episode?.titleZh, episode?.author, episode?.channelName]);

  if (!episode) return null;

  /**
   * 断点恢复住在上面那个 effect 的 `restore()` 里（0.85.1）。
   *
   * 这里曾经有一份 `onLoadedMetadata`，它也读进度、也写 `element.currentTime`。
   * 于是同一件事有两条路径：React 的合成事件与 `audio-controller` 的原生监听，
   * 谁先谁后取决于 React 版本 —— 「恢复到了旧位置」「恢复被自己覆盖」这类问题
   * 就是从这里长出来的。现在只有一条：`restore()`。
   */

  const changeRate = (value) => {
    const next = Number(value);
    if (!RATE_CHOICES.includes(next)) return;
    setRate(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
      saveProgress(storageOrNull(), key, { t: Number(audioRef.current.currentTime) || 0, rate: next });
    }
  };

  const toggle = () => {
    const element = audioRef.current;
    if (!element) return;
    if (element.paused) {
      setError('');
      // 元素里还没有字节时先 `load()` 把请求发出去，再 `play()`。不先 load 的话，
      // 某些版本里 play() 要等下一轮微任务才发请求，用户点了之后一两百毫秒
      // 毫无反应 —— 正是「点了没反应」的观感来源。
      if (element.readyState === 0) element.load();
      setBuffering(true);
      if (controllerRef.current) {
        const started = controllerRef.current.play();
        if (started && typeof started.catch === 'function') {
          started.catch(() => {
            setBuffering(false);
            setError('浏览器拦下了自动播放，再点一次播放键即可');
          });
        }
      } else {
        // 控制器还没装上的极短窗口：直接播，别让「播放键不响」也变成一个谜。
        Promise.resolve(element.play()).catch(() => {
          setBuffering(false);
          setError('浏览器拦下了自动播放，再点一次播放键即可');
        });
      }
    } else if (controllerRef.current) {
      controllerRef.current.pause();
    } else {
      element.pause();
    }
  };

  /** `<audio>` 的失败原因分几类，文案要分开说 —— 「暂不可用」什么都解释不了。 */
  const reportError = (event) => {
    const code = event?.currentTarget?.error?.code ?? audioRef.current?.error?.code;
    setBuffering(false);
    setPlaying(false);
    if (code === 1) return; // MEDIA_ERR_ABORTED：用户自己切走的，不是错误
    /**
     * ★ 直连上游失败 ⇒ **先退回中转**，别急着报错（0.85.8）。
     *
     * 上游可能被面板 CSP 的 `media-src` 挡下、被托管商按 referer 防盗链，或者
     * 那个 302 链在这个内嵌内核里不可播。这些都是「换一条源就能听」的情形，
     * 而中转在同源路径上、已经跟这些事打了半年交道。只在兜底也失败时才说话。
     */
    if (!viaProxy && upstreamUsable) {
      setError('');
      pendingPlay.current = true;
      setViaProxy(true);
      return;
    }
    if (code === 2) return setError('音频下载中断了，重试一下');
    if (code === 3) return setError('音频解码失败，这一集的源文件可能坏了');
    return setError('这一集的音频源打不开（托管方可能改了地址）');
  };

  /**
   * 拖完（或点一下轨道）才真的跳。
   *
   * ★ 拖动过程里只更新 `scrubbing`：每个 `input` 事件都 seek 的话，长节目里
   *   「边拖边解码」会卡，而卡住的滑块会让人以为拖不动。松手一跳，干脆。
   * ★ `play` 跟随当前状态：播着拖就继续播，暂停拖就还是暂停 —— 这是播放器的通行约定。
   */
  const commitScrub = () => {
    const value = scrubRef.current;
    if (value === null) return;
    /**
     * ★ 先清状态再 seek（0.85.0）：拖动状态是纯粹的 UI 状态，任何一层的异常
     *   都不该让它卡住 —— 之前 `seek` 里裸赋值可能抛 `InvalidStateError`，
     *   `setScrubbing(null)` 就再也执行不到，滑块永远停在拖到的位置。
     */
    scrubRef.current = null;
    userSeeked.current = true;
    setScrubbing(null);
    seekTo(value, { play: !audioRef.current?.paused });
  };

  /**
   * 松手兜底（0.85.0）。
   *
   * 指针捕获在多数情况下够用，但它依赖 `pointerup` 真的派发：触控板拖到窗口外
   * 松开、系统弹窗抢走焦点、某些 Electron 版本直接丢事件 —— 这些都真实存在。
   * 监听 window 上的同一次抬手，是「拖动一定收得了尾」的最后一道保险。
   * 靠 `scrubRef` 判重：两处都触发也只 seek 一次。
   */
  useEffect(() => {
    if (scrubbing === null) return undefined;
    const commit = () => commitScrub();
    const cancel = () => { scrubRef.current = null; setScrubbing(null); };
    window.addEventListener('pointerup', commit);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', commit);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [scrubbing]);

  /**
   * 切后台 / 关窗口前立刻落一次进度（0.85.0）。
   *
   * 原来只有「每 5 秒」和「组件卸载」两个时机。桌面端关窗口、面板被销毁时，
   * React 的 cleanup 不保证跑（渲染进程可能直接被销毁），最后一次写盘就丢了
   * 最多 5 秒。用户感知不到这 5 秒，但「听了一小时、回来从 58:20 开始」会让人
   * 觉得「它根本没记住」。
   */
  useEffect(() => {
    const flush = () => {
      const element = audioRef.current;
      if (!element || key === '') return;
      saveProgress(storageOrNull(), key, { t: Number(element.currentTime) || 0, rate: element.playbackRate });
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [key]);

  return (
    <div className="npr-audio">
      {/*
        ★ `preload="metadata"`：进这一集就把时长读出来，进度条一出现就带分母。
        
        但它**不是**「拖不动」的根因 —— 真正的根因在宿主中转层（0.85.3）：上游
        `media.xyzcdn.net` 对 `Range` 请求回 `206` 却**不给 `content-range`**，
        中转原样透传，Chromium 于是既不知道整条资源多大、也不知道这段字节在文件
        里的位置，`duration` 变成 `NaN`、`seekable` 变成空区间。三件事一起坏：
        进度条没分母（拖不动）、±15 被夹到 0（点了没反应）、断点恢复拿不到总时长
        （听过的位置回不去）。修法在 `src/host/audio-proxy.js`，这里只负责尽快
        把时长读进界面。
      */}
      <audio
        ref={audioRef}
        preload="metadata"
        src={source}
        onPlay={() => { setPlaying(true); setBuffering(false); }}
        onPause={() => {
          setPlaying(false);
          setBuffering(false);
          // 暂停是最接近「离开这一集」的动作，立刻落一次盘。
          const element = audioRef.current;
          if (element && key !== '') {
            saveProgress(storageOrNull(), key, { t: Number(element.currentTime) || 0, rate: element.playbackRate });
          }
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => { setBuffering(false); setError(''); }}
        onCanPlay={() => {
          setBuffering(false);
          // 退回中转后替用户把刚才那一下「播放」补上（见 `pendingPlay`）。
          if (!pendingPlay.current) return;
          pendingPlay.current = false;
          Promise.resolve(audioRef.current?.play?.()).catch(() => undefined);
        }}
        onError={reportError}
      />
      {/*
        进度条单独占一行（在控制区上方）。
        ★ 塞进控制区同一行时，420px 下要么把总时长挤掉、要么整条折到第二行、
          两端的时间戳被拆开 —— 播放器「看起来不整」主要就是这个。参照片段的
          播客界面（SubCast）也是「轨道在上、控制在下」，只是它做得更宽。
        ★ 用原生 `input[type=range]` 而不是自绘 div：键盘方向键、读屏、
          点轨道跳转这三件白拿；自绘要各写一遍，而且大概率漏掉键盘。
      */}
      <div className="npr-audio-track">
        {/*
          ★ 显式捕获指针（0.85.0）：原生 range 的拖动**不**做 pointer capture，
            而一小时的节目要横拖很远，指针几乎必然离开这条十几像素高的轨道。
            松开时 `pointerup` 就派发到指针下的别的元素上，`commitScrub` 收不到 ——
            用户看到的就是「拖了不跳」。捕获之后后续事件一定回到这里。
          ★ `onChange` 里同步写 `scrubRef`：`onPointerUp` 与下面的 window 兜底
            可能在同一帧里都触发，靠 ref 判断「已经提交过」才不会跳两次。
        */}
        <input
          type="range"
          className="npr-audio-range"
          min={0}
          max={shownTotal}
          step={0.5}
          value={Math.min(shown, shownTotal)}
          disabled={shownTotal <= 0}
          aria-label={shownTotal > 0 ? '播放进度' : '播放进度（正在读取时长）'}
          style={{ '--npr-progress': `${percent}%` }}
          onChange={(event) => {
            const next = Number(event.target.value);
            scrubRef.current = next;
            setScrubbing(next);
          }}
          onPointerDown={(event) => {
            try {
              event.currentTarget.setPointerCapture?.(event.pointerId);
            } catch {
              // 老内核没有指针捕获：window 兜底仍然接得住。
            }
          }}
          onPointerUp={commitScrub}
          onPointerCancel={() => { scrubRef.current = null; setScrubbing(null); }}
          onKeyUp={commitScrub}
          onBlur={commitScrub}
        />
      </div>
      <div className="npr-audio-bar" role="group" aria-label="音频播放">
        {/*
          ★ 0.85.0：`−15` / `+15` 只写了数字，用户看不出单位 —— 是 15 秒、15% 还是
            15 分钟？后台播放器里这是个高频按钮，含义必须在**看得见的地方**说清，
            不能只放在 `title` 里（触屏和键盘用户根本读不到）。加 `s` 一个字符，
            按钮只宽 4px，但歧义没了。
        */}
        <button type="button" className="npr-audio-btn npr-audio-skip" title="后退 15 秒" aria-label="后退 15 秒"
          onClick={() => {
            const element = audioRef.current;
            if (element) seekTo(Number(element.currentTime) - 15, { play: !element.paused });
          }}>−15s</button>
        <button type="button" className={`npr-audio-btn npr-audio-play${buffering ? ' is-buffering' : ''}`}
          title={buffering ? '正在缓冲…' : playing ? '暂停' : '播放'}
          aria-label={buffering ? '正在缓冲' : playing ? '暂停' : '播放'} onClick={toggle}>
          <Icon name={buffering ? 'refresh-cw' : playing ? 'pause' : 'play'} size={17} />
        </button>
        <button type="button" className="npr-audio-btn npr-audio-skip" title="前进 15 秒" aria-label="前进 15 秒"
          onClick={() => {
            const element = audioRef.current;
            if (element) seekTo(Number(element.currentTime) + 15, { play: !element.paused });
          }}>+15s</button>
        {/*
          ★ 时长未知时显示 `--:--` 而不是 `00:00`（0.85.1）。`00:00` 是一个**具体
            的位置**，会让用户以为「这一集长度是 0」；`--:--` 说的是「还没读到」。
            两者对应完全不同的等待预期。
        */}
        <span className="npr-audio-time" aria-label="播放进度">
          {formatClock(shown)} / {shownTotal > 0 ? formatClock(shownTotal) : '--:--'}
        </span>
        {/*
          ★ 右端整组（`.npr-audio-end`）包成**一个** flex 项：分成多个项时，面板一窄
            就只有最后一个被挤到第二行，孤零零挂在左边（420px 实测）。包成一项之后，
            要么整组留在第一行右侧，要么整组一起换行。
          ★ 语言三态开关**不在这里**（0.81.0）：它属于字幕，和「倍速/原文」挤在同一行
            只会让用户以为它控制音量。统一收进字幕面板头部。
        */}
        <span className="npr-audio-end">
          <label className="npr-audio-rate">
            <select value={rate} aria-label="播放倍速" onChange={(event) => changeRate(event.target.value)}>
              {RATE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>{choice === 1 ? '1×' : `${choice}×`}</option>
              ))}
            </select>
          </label>
          {/* ★ 0.84.2 撤掉右端「字幕」按钮：文章 / 字幕 / 导读选项卡就在播放条正下方，
              再用一颗按钮指向同一个面板是两条入口指一个地方。两处逻辑（这里和 tab）
              同时留着，迟早会因为其中一处忘了更新而给出不同文案。 */}
          {episode.url && (
            <a className="npr-audio-src" href={episode.url} target="_blank" rel="noopener noreferrer">原文</a>
          )}
        </span>
      </div>
      {/*
        ★ 三句话，对应三种**在界面上长得一模一样**的原因（0.85.4）。
        
        它们以前是一句话（「这一集的音频源不支持跳转」），因为当时只找得到一个
        原因。后来发现拖不动可能是：① 上游缺 `content-range`；② 宿主没重载、
        补头代码根本没跑；③ 客户端逻辑错了。①③ 都能靠代码修，② 只能靠重启 ——
        但三者对用户来说都是「拖不动」，所以必须在提示里分开。
      */}
      {/*
        ★ 这两条只在**走中转**时才说得通（0.85.8）：直连上游时进度跳转根本不经过
          宿主，宿主新旧、上游支不支持分段都不影响拖动。以前无论走哪条路都显示，
          于是「宿主旧版」这句能一直挂在界面上，用户重启多少次都消不掉。
      */}
      {viaProxy && hostStale && !error && (
        <div className="npr-audio-hint" role="status">
          {hostState?.missing === true
            ? '宿主组件还是旧版（没有自检接口）。进度跳转由宿主侧负责，退出 dsh 重开才会生效。'
            : `宿主组件 v${hostState?.build ?? '?'} 与客户端 v${CLIENT_BUILD} 不是同一版。退出 dsh 重开后两边一致，跳转才会生效。`}
        </div>
      )}
      {viaProxy && !hostStale && hostState?.seekable === false && !error && (
        <div className="npr-audio-hint" role="status">
          这个音频源没有开放分段读取，进度条只能按顺序播放。
        </div>
      )}
      {seekFallback && !error && !hostStale && (
        <div className="npr-audio-hint" role="status">
          这一集要靠重新加载才能定位，每次跳转会停顿一两秒。
        </div>
      )}
      {/*
        ★ 诊断行（0.85.6）。只在跳转失败时出现，读完就可以删。
        
        为什么要把内部读数印在屏幕上：同一句「拖不动」至少对应三种物理原因 ——
        没有可跳区间、有区间但赋值被忽略、分母本身就是错的。它们只差几个数字，
        却要改完全不同的地方。靠猜已经猜错过三轮，直接把读数摊开最快。
      */}
      {diag && !error && (
        <div className="npr-audio-diag" role="status">
          <span>诊断</span>
          <code>dur={String(diag.dur)}</code>
          <code>seekable={diag.seekable === null ? '空' : JSON.stringify(diag.seekable)}</code>
          <code>buffered={diag.buf === null ? '空' : JSON.stringify(diag.buf)}</code>
          <code>readyState={diag.rs}</code>
          <code>目标 {diag.target} → 实际 {diag.at}</code>
          <code>宿主 {hostState?.build ?? '未应答'}</code>
          {/* 这一格说明「音频是从哪条路取的」：直连上游 / 退回中转。 */}
          <code>源 {viaProxy ? '中转' : '直连'}</code>
          <code>
            响应 {probe === null
              ? '未应答'
              : `${probe.status} cr=${probe.cr ?? '无'} cl=${probe.cl ?? '无'}${probe.ce === null ? '' : ` enc=${probe.ce}`}`}
          </code>
        </div>
      )}
      {error && (
        <div className="npr-audio-error" role="alert">
          {error}
          <button type="button" className="npr-btn" onClick={() => { setError(''); setBuffering(true); audioRef.current?.load(); }}>重试</button>
          {/* 逃生通道：中转层万一出问题，直接让用户拿原地址去浏览器里听。
              这不是主路径，但比「只有一个重试按钮」强 —— 至少能确认是源坏了还是我们坏了。 */}
          {episode.audio && (
            <a className="npr-btn" href={episode.audio} target="_blank" rel="noopener noreferrer">用原地址打开</a>
          )}
        </div>
      )}
    </div>
  );
}
