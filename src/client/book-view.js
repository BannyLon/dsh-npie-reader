/**
 * 书架阅读器的**判据**：缩放基准、滚轮翻页、键盘命令。
 *
 * 全部是纯函数 —— 不碰 DOM、不碰 React。理由不是「干净」，是**可测**：
 * 这三件事都是「看起来对、实际错得很隐蔽」的类型，只有在真机上才发现：
 *   - 缩放算错 ⇒ 页面缩在中间或撑出边界，而代码读起来完全正常；
 *   - 滚轮规则写错 ⇒ 触控板惯性一次翻掉二十页（每次 deltaY 都触发一次翻页）；
 *   - 键盘守卫漏一条 ⇒ 用户搜索框里打不出「w」「p」，或者方向键在聊天输入框里翻书。
 * 抽出来之后，每条规则都能用真实取值喂进去，并配一个**反向对照**（喂已知会坏的
 * 输入，证明判据会变红），而不是把当前实现抄一遍。
 */

/** 缩放基准：适宽（按宽度铺满）/ 整页适应窗口（整页可见）。 */
export const FIT_WIDTH = 'width';
export const FIT_PAGE = 'page';

/** 手动缩放倍数（**相对当前基准**，1 = 基准本身）。 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.2;

/** 绝对缩放的下限 / 上限：下限防 0 尺寸面板把页面算成 0，上限防小页被放大成巨幅位图。 */
export const SCALE_MIN = 0.1;
export const SCALE_MAX = 8;

/** 滚轮翻页：累计到这么多像素才认一次翻页。触控板的惯性会连发几十个事件。 */
export const WHEEL_FLIP_DELTA = 24;
/** 两次滚轮翻页之间的最小间隔（毫秒）。 */
export const WHEEL_FLIP_COOLDOWN_MS = 220;

/** 键盘不拦的元素：这些标签自己要用方向键/空格。 */
const PASSTHROUGH_TAGS = new Set(['input', 'textarea', 'select', 'button', 'summary', 'option']);

/** 判据不认识这个键。 */
export const NO_COMMAND = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 舞台的**可用内容区**。
 *
 * ★ 为什么用 `clientWidth/clientHeight` 而不是 `getBoundingClientRect()` 再减边框：
 *   舞台是滚动容器，`getBoundingClientRect()` 的宽度**包含滚动条**，用它算出来的
 *   可用宽度会比真实可用宽度大一整条滚动条（约 6px）—— 表现是「适应宽度」之后
 *   右边永远差几个像素、出现一条水平滚动条。`clientWidth/clientHeight` 是
 *   **内容盒**（已排除滚动条、含 padding），减掉 padding 才是真正能放东西的尺寸。
 *
 * ★ 尺寸本身的来源不是这里，而是 `ResizeObserver`（见 BookReader）：本函数只做算术。
 *   把「什么时候量」和「怎么算」分开，是因为踩过的坑是**测量时机**（首帧读到布局前
 *   的值 ⇒ 宽度只有实际的一半），不是算法错。
 *
 * @param input.clientWidth - 舞台的 `clientWidth`。
 * @param input.clientHeight - 舞台的 `clientHeight`。
 * @param input.padding* - 计算后的 padding（`parseFloat(getComputedStyle(...).paddingLeft)`）。
 * @returns `{ width, height }`，各自不小于 1。
 */
export function contentBox({
  clientWidth = 0, clientHeight = 0,
  paddingLeft = 0, paddingRight = 0, paddingTop = 0, paddingBottom = 0,
} = {}) {
  return {
    width: Math.max(1, Math.floor(clientWidth - paddingLeft - paddingRight)),
    height: Math.max(1, Math.floor(clientHeight - paddingTop - paddingBottom)),
  };
}

/**
 * 基准缩放（不含手动倍数）。返回 0 表示「还量不出/还没拿到页面尺寸」，调用方应当跳过渲染。
 *
 * @param input.mode - `FIT_WIDTH` | `FIT_PAGE`。
 * @param input.box - 舞台可用内容区 `{ width, height }`。
 * @param input.base - 当前页在 scale=1 下的尺寸 `{ width, height }`（来自 pdf.js viewport）。
 */
export function fitScale({ mode = FIT_WIDTH, box, base } = {}) {
  if (!box || !base) return 0;
  if (!(box.width > 0) || !(box.height > 0)) return 0;
  if (!(base.width > 0) || !(base.height > 0)) return 0;
  const byWidth = box.width / base.width;
  if (mode === FIT_PAGE) return clamp(Math.min(byWidth, box.height / base.height), SCALE_MIN, SCALE_MAX);
  return clamp(byWidth, SCALE_MIN, SCALE_MAX);
}

/** 最终缩放 = 基准 × 手动倍数。0 表示还画不了。 */
export function displayScale({ mode = FIT_WIDTH, box, base, zoom = 1 } = {}) {
  const fit = fitScale({ mode, box, base });
  if (fit === 0) return 0;
  return clamp(fit * zoom, SCALE_MIN, SCALE_MAX);
}

/**
 * 把任意输入夹成合法的手动倍数（界面上的「+/-」与设置回读都走它）。
 *
 * ★ 非有限值（`NaN` / `±Infinity`）退回 **1**，不是 0、也不是上限：0 会让页面
 *   直接消失，上限会让它突然变成 300%。这类值只可能来自 bug，恢复到「100%」
 *   是唯一用户看得懂的结果。
 */
export function clampZoom(value) {
  if (!Number.isFinite(value)) return 1;
  return clamp(Number(value.toFixed(2)), ZOOM_MIN, ZOOM_MAX);
}

/** 按步进调一次手动倍数。 */
export function stepZoom(value, direction) {
  return clampZoom(clampZoom(value) + ZOOM_STEP * direction);
}

/** 展开列表里每一格的直径（与 refinements.css 的 `.npr-book-fab-slot` 对齐）。 */
export const FAB_SLOT_SIZE = 38;
/** 相邻两格的默认间隙。 */
export const FAB_SLOT_GAP = 8;
/** 浮动按钮距面板右下角的留白（与 CSS 里 `right/bottom: 14px` 对齐）。 */
export const FAB_MARGIN = 14;
/** 浮动按钮的直径。 */
export const FAB_BUTTON_SIZE = 44;
/**
 * 列表最上面那一格相对按钮圆心的横向偏移。
 *
 * ★ 为什么留这一点偏移：整列笔直地贴着右边会让 7 颗圆排成一根"糖葫芦"，和书页的
 *   排版几乎没有关系；最上面那格往里让一点，整列就微微朝书的中间"拢"过去，
 *   像从按钮里长出来的一小段弧。`0` 会退回完全垂直的一列（判据里有反向对照）。
 */
export const FAB_BEND = 14;

/**
 * 悬停展开的**宽限期**（毫秒）：指针离开整棵子树后，等这么久才收列（0.24.3）。
 *
 * ★ 这个数只解决一件事：从按钮移到第一格要**经过一段空隙**，那一瞬间指针既不在
 *   按钮上、也不在格子上（格子还没铺到那儿）⇒ 如果立刻收，列会在鼠标到达前消失
 *   （用户 0.23.0 报的「根本没办法选择点击」就是这个）。
 * ★ 为什么是 220：横穿 8px 空隙（甚至斜着走 20px）在正常手速下 30–80ms；
 *   而「用户真的想离开」这个判断晚 220ms 毫无感觉（macOS 菜单也是几百毫秒量级）。
 *   取太小（<100）慢速移动仍会闪断；取太大（>400）会让人觉得列"赖着不走"。
 * ★ 导出成一个常量：组件与判据脚本必须用**同一个数**，否则判据量的是另一个世界
 *   （本项目记过「同一判据两处各写一遍 ⇒ 两个数字对不上」）。
 */
export const FAB_HOVER_GRACE = 220;

/**
 * 悬停展开的**状态机**（0.24.3）：进入立刻开，离开等 `grace` 再关。
 *
 * ★ 为什么抽成纯函数：这段逻辑的三个坑（越过空隙被误收、宽限期内回来要取消、
 *   连续离开只该安排一次）在真实浏览器里靠手试不出来，而组件里那四行又没法在
 *   没有 DOM 的单测里跑。抽出来以后 `test/book-view.test.mjs` 用**假定时器**真跑。
 * ★ `onOpen` 每次进入都调（不是只在「从未开过」时调）：React 对同值 setState 会
 *   自行跳过重渲染，多调一次没有代价，却省掉了「要不要记上一个状态」的分支 ——
 *   那正是最容易写反的地方。
 * ★ `setTimer` / `clearTimer` 可注入，只给测试用；生产走全局。
 */
export function createFabHover({
  grace = FAB_HOVER_GRACE,
  onOpen = () => {},
  onClose = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /* ★ 哨兵用 null，不用 0：`setTimer` 是可注入的，谁也没规定它不返回 0
     （假定时器从 0 编号就是合法的）。用 `if (timer)` 判断的话，那一份定时器
     永远取消不掉 —— 用户会在离开 220ms 后被一个「已经作废」的 close 收掉列。
     `test/book-view.test.mjs` 有一条专门喂 0 的用例钉这个。 */
  let timer = null;
  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  return {
    /** 指针进入整棵子树（按钮或任意一格）。 */
    enter() {
      cancel();
      onOpen();
    },
    /** 指针离开整棵子树（含从按钮走到空隙里那一下）。 */
    leave() {
      cancel();
      timer = setTimer(() => {
        timer = null;
        onClose();
      }, grace);
    },
    /** 卸载时清定时器：组件没了还在 `setState` 会警告，测试也会因此假绿。 */
    cancel,
  };
}

/**
 * 展开列表各格的**圆心偏移**（相对浮动按钮的圆心，屏幕坐标系：y 向下为正）。
 *
 * ★ 形态是**竖直一列**（用户 2026-10-23 第四轮指定：照 iPad 上那颗浮钮的样子），
 *   不是绕按钮转一圈的圆弧。圆弧在这里有两个硬伤：
 *     ① 7 格 90° 等分要 `R≈150` 才不叠，而 `R=150` 的弧横跨 150px —— 面板一窄就出界；
 *     ② 弧上每格离按钮的距离都一样，看不出先后，读起来像一堆散落的圆片。
 *   竖排把 7 格排成一条**有序**的带子，纵向空间本来就是面板最富裕的方向。
 * ★ 每格都带**文字标签**（标签在格的左侧，见 CSS）：光有图标的话，用户得先把鼠标
 *   移上去看 tooltip 才知道哪个是「适应窗口」。
 * ★ 预算按**面板高度 − 顶部预留**算，不是只按面板高度：
 *   列从右下角往上排，不考虑胶囊那一行的话，420px 高的面板里最上面那格会压住胶囊
 *   （实测最上格顶 44 / 胶囊底 89），而它 `z-index` 更高 —— 被盖住的胶囊按钮点不到。
 * ★ 高度不够时**先压间隙、再缩直径**，兜底 26px：7 格 × (38 + 8) = 322px，
 *   矮面板会顶上去。压间隙能省 42px，还不够才动直径。
 * ★ 拿不到高度（首帧、`ResizeObserver` 还没回调）时按默认间隙算：返回全 0 会让
 *   7 格叠在按钮身上，看起来像界面坏了。
 *
 * @param input.count - 一共几格。
 * @param input.height - 面板（或全屏后视口）的高度。
 * @param input.top - 面板顶到舞台顶的距离（拖动条 + 胶囊 + 元信息行）。列不许进这一带。
 * @param input.slot / input.gap / input.bend - 覆盖默认尺寸（判据与单测用）。
 * @returns `[{ x, y, size, index }]`，**index 0 = 列表最上面**、最后一格紧贴按钮。
 */
export function fabStack({
  count = 7, height = 0, top = 0, slot = FAB_SLOT_SIZE, gap = FAB_SLOT_GAP, bend = FAB_BEND,
} = {}) {
  const total = Math.max(1, Math.floor(count));
  const base = Number.isFinite(slot) && slot > 0 ? slot : FAB_SLOT_SIZE;
  const preferredGap = Number.isFinite(gap) && gap >= 0 ? gap : FAB_SLOT_GAP;
  const bendPx = Number.isFinite(bend) && bend >= 0 ? bend : FAB_BEND;
  const topInset = Number.isFinite(top) && top > 0 ? top : 0;

  /**
   * 一列 `total` 格占的"长度"：`n × (直径 + 间隙)`。
   *
   * ★ 为什么不是 `n×直径 + (n-1)×间隙`：这个量要和「按钮圆心到顶部预留线」的距离
   *   放在一起比。最上面那一格的**顶边** = 圆心 − (按钮半径 + 间隙 + 直径/2)
   *   − (n−1)(直径+间隙) − 直径/2，整理之后正好是 `n(直径+间隙) + 按钮半径`。
   *   所以预算里也扣掉一个按钮半径，两边才对齐。
   */
  const spanOf = (size, space) => total * (size + space);

  /**
   * 可用预算（px）：面板高 − 底部留白 − 按钮直径 − 顶部预留。
   * `= (按钮圆心到面板顶) − (顶部预留) − 按钮半径`。
   */
  const budget = Number.isFinite(height) && height > 0
    ? height - FAB_MARGIN - FAB_BUTTON_SIZE - topInset
    : 0;

  let size = base;
  let space = preferredGap;
  if (budget > 0 && spanOf(size, space) > budget) {
    // ① 先只压间隙：38px 是图标（16px）加内边距的下限，直径不动。
    space = Math.max(0, budget / total - size);
  }
  if (budget > 0 && spanOf(size, space) > budget) {
    // ② 间隙压到 0 还装不下 ⇒ 连格子一起缩（矮面板），兜底 26px。
    size = Math.max(26, Math.min(base, budget / total));
    space = 0;
  }

  // 最靠按钮那一格（index = total - 1）的圆心：按钮半径 + 间隙 + 半格。
  const nearest = FAB_BUTTON_SIZE / 2 + space + size / 2;
  const step = size + space;

  return Array.from({ length: total }, (_, index) => {
    const up = total - 1 - index;          // 0 = 紧贴按钮，越大越往上
    const t = total > 1 ? up / (total - 1) : 0;
    return {
      // 四舍五入到 0.1px：整数化之后布局稳定，也免得 SSR/CSR 之间出现浮点差。
      x: Math.round(-bendPx * t * t * 10) / 10 + 0,
      // `+ 0` 把 `-0` 归一成 `0`：`translate(0px -0px)` 合法但读日志时很刺眼。
      y: Math.round(-(nearest + step * up) * 10) / 10 + 0,
      /**
       * 这一格实际该多大。
       * ★ **必须回传给 CSS**：矮面板里直径会被缩到 26px，而 CSS 若仍按 38px 画，
       *   相邻圆心距就小于格宽 ⇒ 6 个圆当场叠成一串。尺寸与位置必须是同一次计算的结果。
       */
      size: Math.round(size * 10) / 10,
      index,
    };
  });
}

/**
 * 滚轮这一下该干什么。
 *
 * ★ 规则不是「滚轮一律翻页」：适宽模式下页面通常比舞台高，那样写会让用户
 *   **永远看不到页面的下半部分**（一滚就跳页）。所以按滚动位置分流：
 *     - 页面滚得动：滚到边界之后那一下才翻页（连续阅读的手感）；
 *     - 页面滚不动（整页适应窗口，或这页本来就矮）：上下都是翻页。
 *   两种模式下用户都能得到「滚轮 = 翻页」，但没有任何内容被跳过。
 *
 * @param input.deltaY - 滚轮增量（> 0 向下）。
 * @returns `'next'` | `'prev'` | `'scroll'`（交给浏览器自己滚）。
 */
export function wheelIntent({ deltaY = 0, scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  if (!(deltaY > 0) && !(deltaY < 0)) return 'scroll';
  const overflow = scrollHeight - clientHeight;
  if (overflow > 1) {
    if (deltaY > 0) return scrollTop + clientHeight >= scrollHeight - 1 ? 'next' : 'scroll';
    return scrollTop <= 0 ? 'prev' : 'scroll';
  }
  return deltaY > 0 ? 'next' : 'prev';
}

/**
 * 键盘命令映射。
 *
 * 顺序很重要，三条守卫按序短路：**修饰键 → 元素类型 → 内容可编辑**。
 * 少任何一条都会出现「输入框里打不了字」或「聊天框里按方向键把书翻走了」这类
 * 只在真机上暴露的故障，而代码看起来只是加了个键盘快捷键。
 *
 * @param input.key - `KeyboardEvent.key`。
 * @param input.tagName - `event.target.tagName`。
 * @param input.contentEditable - `event.target.isContentEditable === true`
 *   （Harness 的原生输入框不一定是 textarea，只判标签会漏）。
 * @returns 命令名，或 `NO_COMMAND`（不认识 / 不该拦）。
 *
 * ★ 刻意**没有**单字母的「标记读完」。`w`/`p`/`a` 换的是**可见且可逆**的界面
 *   状态（缩放方式、伴读面板），按错了立刻看得出来；而「读完」是**持久化的状态
 *   变更**，误触之后书架上就多了一本假的「已读完」，用户不会想到是自己按到了
 *   某个字母。持久化操作必须由一次明确的点击发起。
 */
export function readerCommand({
  key = '', tagName = '', contentEditable = false,
  metaKey = false, ctrlKey = false, altKey = false,
} = {}) {
  if (metaKey || ctrlKey || altKey) return NO_COMMAND;
  if (contentEditable === true) return NO_COMMAND;
  if (PASSTHROUGH_TAGS.has(String(tagName).toLowerCase())) return NO_COMMAND;
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Spacebar':
      return 'next';
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
      return 'prev';
    case 'Home': return 'first';
    case 'End': return 'last';
    case '+': case '=': return 'zoomIn';
    case '-': case '_': return 'zoomOut';
    case 'w': case 'W': return 'fitWidth';
    case 'p': case 'P': return 'fitPage';
    case 'a': case 'A': return 'companion';
    /**
     * `i` / `n` 换的同样是**可见且可逆**的界面状态：
     * `i` 收起/展开顶部那条，`n` 在「原色 → 护眼 → 夜间」之间轮转。
     * 与 `w`/`p`/`a` 同一档，所以可以给单字母；「读完」不行（见函数头）。
     * ★ `Escape` 刻意不在这里：它的语义是「退出当前模态」，由组件层处理
     *   （`readerCommand` 返回 `NO_COMMAND` 的老契约不变，测试也钉着这一点）。
     */
    case 'i': case 'I': return 'immersive';
    case 'n': case 'N': return 'tint';
    default: return NO_COMMAND;
  }
}

/**
 * 把 pdf.js 的文本项拼成一段可读文字（给 AI 伴读当阅读上下文）。
 *
 * ★ 用空格连接、再把连续空白压成一个：pdf.js 的每个 item 是一段**排版游程**，
 *   不是词 —— 直接 `join('')` 会把相邻游程粘成一个不存在的词
 *   （实测「推荐序二」+「在工作中体会生命的精彩」会变成一串没有断点的字）。
 *   代价是中文页面上每个游程之间多一个空格，比粘连好得多，模型也吃得下。
 *
 * 扫描版（没有文本层）返回空串 —— 调用方必须把「这一页没有文字」如实说出来，
 * 而不是把空上下文当成「模型没看到」。
 */
export function extractPageText(items, { limit = 20000 } = {}) {
  const joined = (Array.isArray(items) ? items : [])
    .map((item) => (typeof item?.str === 'string' ? item.str : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return joined.length > limit ? joined.slice(0, limit) : joined;
}

/**
 * 把 pdf.js 的文本项拼成**按行切好的数组**（给分段算法用）。
 *
 * ★ 为什么不能直接用 `extractPageText`：那个函数把整页压成**一行**（它服务的是
 *   「把这一页交给伴读」，模型不需要行结构）。而分段判据全部依赖「行」——
 *   目录页的识别靠「行均长 < 34 且行尾无句读」，正文反查靠「标题是不是页首两行」。
 *   压成一行之后这两条判据全都失效。
 *
 * ★ 为什么同一行的游程**直接拼**、不像上面那样用空格 join：pdf.js 的 item 是
 *   **排版游程**，同一行内相邻游程在原文里本来就是挨着的。用空格 join 会在每个
 *   中文游程之间插一个空格（「推荐序二 在 工作中 体会」），行均长被撑大、
 *   反查时的 `startsWith` 也会全部失配。
 *
 *   但英文不能直接拼 —— 英文的游程常常是「词」而不是「字」，直接拼会得到
 *   `Thebookexplains`。所以只在「前后都是 ASCII 字母数字」的边界补一个空格。
 *   中文不匹配这个边界，因此不受影响。
 */
export function extractPageLines(items, { maxLines = 400, maxChars = 20000 } = {}) {
  let out = '';
  let prevWord = false;
  for (const item of Array.isArray(items) ? items : []) {
    const str = typeof item?.str === 'string' ? item.str : '';
    if (str !== '') {
      const startsWord = /^[A-Za-z0-9]/.test(str);
      if (prevWord && startsWord) out += ' ';
      out += str;
      prevWord = /[A-Za-z0-9]$/.test(str);
    }
    if (item?.hasEOL === true) {
      out += '\n';
      prevWord = false;
    }
  }
  const lines = [];
  let chars = 0;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (line === '') continue;
    if (lines.length >= maxLines || chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
  }
  return lines;
}
