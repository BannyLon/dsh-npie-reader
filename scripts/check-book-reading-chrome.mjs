#!/usr/bin/env node
/**
 * 阅读器「顶部胶囊 + 右下角浮动列」的**真机几何**校验（真 Chrome、真项目 CSS）。
 *
 * 分工是用户 2026-10-23 定的（我理解错了两次，所以这里先量分工本身）：
 *   · **顶部胶囊**（6 项）= 与「这本书」有关的**开关类**动作：
 *     标记读完 / 伴读 / 划线 / 目录 / 配色 / 沉浸。
 *     ★ 0.24.1：「导出技能」被**移出**这一排（用户：「把导出放在菜单条毫无意义」）——
 *       它是一次**产出动作**，不是视图开关，现在住在目录面板「生成解读」右边。
 *   · **右下角浮动列**（7 格）= 与「当前这一页」有关的**调档类**动作：
 *     页码 / 上一页 / 下一页 / 适应宽度 / 适应窗口 / 放大 / 缩小。
 *
 * 为什么必须单独一个脚本：这类改动有七种坏法**构建全绿、单测全绿**，只有真机量得出来：
 *   ① 顶部那条没收干净 —— 44px 的胶囊还在，书页照样被顶下去；
 *      反过来，拖动条被收成 0 高度就拿不到命中测试，窗口拖不动；
 *   ② 元信息行还浮在书页上（`pointer-events: none` 的那一层），压住的地方连划选都点不到；
 *   ③ 胶囊没居中、或跑到下面去了；
 *   ④ 分工做反了 —— 开关类被塞进浮动列、调档类被塞回顶部；
 *   ⑤ 浮动列**几何错了**：格与格叠在一起、整列顶出面板、尺寸与位置用了两套数
 *      （矮面板里直径缩了但圆心距没缩 ⇒ 6 个圆糊成一串）；
 *   ⑥ **鼠标一离开按钮就收起**：hover 展开在这个几何里根本不成立 —— 按钮与第一格之间
 *      必定有空隙，`:hover` 掉在空隙里的那一刻整列开始回收，目标格在鼠标到达前就已经
 *      `visibility: hidden`，点上去落空（用户原话「根本没办法选择点击」）；
 *   ⑦ 沉浸态只藏了工具栏，没藏**书架那一列**（用户要的是「左边两列都不显示」）。
 *
 * 判据（每条都配一次反向对照：注入坏规则之后必须变红）：
 *   ⓪ 分工：源文本里顶部恰好 6 个 `npr-book-pill-item`、浮动列恰好 7 个 `npr-book-fab-slot`，
 *      两边互不串味；hover 展开的那条 CSS 已经**不存在**；
 *   ① 顶部只剩一条 10px 拖动条，铺满宽度、透明；
 *   ② 元信息行在正常流里（底边不越过舞台顶边）、只有一行、**不含书名**；
 *   ③ 胶囊在顶部、水平居中、装得下、宽处带文字；
 *   ④ 胶囊恰好 6 项，且不含任何调档类；
 *   ⑤ FAB 贴右下角（14px）、落在面板内、真的浮着、在右半区；
 *   ⑥ 收起态：7 格全 `visibility: hidden` + `opacity: 0` + `pointer-events: none`，
 *      并且**收回到按钮圆心**、缩到 0.6 倍（这是动画起点）；
 *   ⑦ 展开态：7 格不透明、可见、可点、回到 `--npr-fab-size` 原尺寸；
 *   ⑧ **竖直一列**：全部在按钮正上方，相邻圆心距 = 直径 + 间隙（等距，不是乱排）；
 *   ⑨ 逐格偏移与 `fabStack` 的理论位置一致（≤ 1.2px）—— 位置由生产代码说了算；
 *   ⑩ 最下面那格紧贴按钮、最上面那格不顶出面板（含 240px 极矮面板）；
 *   ⑪ 任意两格都不叠（含跨格）—— 缩过直径时也成立（尺寸与位置同源）；
 *   ⑫ 每一格都带**文字标签**，标签在圆**左侧**、不越出面板、不压住圆本身；
 *   ⑬ 顺序对：最上面是页码、最下面是缩小（与「离按钮越近越常用」一致）；
 *   ⑭ **鼠标移到按钮上就展开**（不用点）；指针穿过「按钮 ↔ 第一格」那道空隙时列不许收
 *      （宽限期 220ms）；真的移开之后才收；点击入口仍保留给触屏与键盘。
 *      ★ 0.23.0 曾因为「空隙里 `:hover` 会掉」把悬停整个删掉 —— 那是**观察对、结论错**：
 *        缺的是宽限期，不是悬停不成立。
 *   ⑮ 窄面板（420×420）：胶囊切成图标版、六项都在，浮动列仍全在面板内、仍不叠；
 *   ⑯ 极矮面板（200×200）：直径由 `fabStack` 自动收缩，整列仍装得下；
 *   ⑰ 沉浸态：胶囊与元信息都不占位、FAB 透明，鼠标回到角落能恢复；
 *   ⑱ 沉浸态：**书架那一列与它的分隔条都不占位**（`.npr-workarea.is-book-immersive`）；
 *   ⑲ 书页配色四档：画布滤镜 + 夜间浮动格/标签/胶囊跟着变暗；
 *   ⑳ 亮度真的落到舞台的 `filter` 上，且不碰 FAB；
 *   ㉑ 配色面板从配色那颗按钮**正下方**展开、右缘对齐、宽 208、画在元信息行之上；
 *   ㉒ 划线面板宽 306、不横向溢出、不把正文压没；
 *   ㉓ **阅读区定位**：开着伴读（右侧多一栏）时，浮动按钮仍贴**书页区**右下角 14px、
 *      整颗与展开的 7 格都不越进伴读那一栏（它钉的是阅读区，不是整个面板）；
 *   ㉔ **纸色覆盖层**：护眼/薄荷要把 PDF 自己的白纸一起染色 —— 覆盖层与画布完全重合、
 *      不吃点击、走 `mix-blend-mode: multiply`；原色与夜间两档不叠（白纸 / 黑纸本来就是对色）。
 *
 * 用法：node scripts/check-book-reading-chrome.mjs [--shot out.png] [--shot-width 1200]
 * 退出码：0 全绿 / 1 有判据失败 / 2 Chrome 不可用（**不静默跳过**）。
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import {
  fabStack, FAB_SLOT_SIZE, FAB_SLOT_GAP, FAB_MARGIN, FAB_BUTTON_SIZE, FAB_BEND,
} from '../src/client/book-view.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SHOT = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : '';
/** 截图用的面板宽度（判据固定在 1200 / 420 / 200，截图时用这个覆盖，方便看宽面板的形态）。 */
const SHOT_WIDTH = args.includes('--shot-width') ? Number(args[args.indexOf('--shot-width') + 1]) : 1200;

const CHROME_CANDIDATES = [
  process.env.NPIE_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Users/habhy/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome。设 NPIE_CHROME=<可执行文件> 再跑。候选：');
  for (const p of CHROME_CANDIDATES) console.error(`  ${p}`);
  process.exit(2);
}

/* ---- 真项目 CSS --------------------------------------------------------- */
const readerSrc = readFileSync(join(root, 'src/client/ReaderPage.jsx'), 'utf8');
const cssStart = readerSrc.indexOf('const PANEL_CSS = `');
const panelEnd = readerSrc.indexOf('`;', cssStart);
if (cssStart < 0 || panelEnd < cssStart) throw new Error('抽 PANEL_CSS 失败（边界切错了）');
const PANEL_CSS = readerSrc.slice(cssStart + 'const PANEL_CSS = `'.length, panelEnd);
const REFINEMENTS = readFileSync(join(root, 'src/client/refinements.css'), 'utf8');
/** ★ 阅读器那两块的**结构**在 BookReader.jsx 里，不在 ReaderPage.jsx 里（容易记混）。 */
const bookSrc = readFileSync(join(root, 'src/client/BookReader.jsx'), 'utf8');

/**
 * ── 悬停运行时：把**生产代码的** `createFabHover` 打进夹具页 -------------------
 *
 * ★ 为什么不在夹具里另写一份「pointerenter → 加类」：那是自问自答 —— 测的是我抄的
 *   那份逻辑，而这份脚本存在的全部意义是证伪生产代码。
 * ★ 用 esbuild 打成 IIFE（`NPIE_HOVER`）再内联：`book-view.js` 是纯 ESM，页面里没有
 *   模块加载器；打包是唯一「逐字同源」的做法（不是从源码文本里抠函数体 ——
 *   抠函数体对格式化、注释里的括号都不稳）。
 * ★ 夹具里只做三件事：把 `enter` / `leave` 接到 `pointerenter` / `pointerleave` 上、
 *   开合时切 `is-open` 类、暴露 `__fabHover(grace)` 让反向对照能改宽限期。
 *   **判断什么时候开、什么时候关，全部在生产代码里。**
 */
const hoverBundle = await esbuild.build({
  stdin: {
    contents: `export { createFabHover, FAB_HOVER_GRACE } from ${JSON.stringify(join(root, 'src/client/book-view.js'))};`,
    resolveDir: root,
    loader: 'js',
    sourcefile: 'hover-entry.js',
  },
  bundle: true,
  format: 'iife',
  globalName: 'NPIE_HOVER',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});
const HOVER_JS = hoverBundle.outputFiles[0].text;
if (!HOVER_JS.includes('createFabHover')) throw new Error('悬停运行时打包失败 —— 夹具里会没有悬停逻辑');
const HOVER_RUNTIME = `<script>${HOVER_JS}</script>
<script>
(function () {
  var fab = document.getElementById('fab');
  if (!fab || !window.NPIE_HOVER) return;
  var hover = null;
  var open = function () { fab.classList.add('is-open'); };
  var close = function () { fab.classList.remove('is-open'); };
  /* 监听器只挂一次，内部转发给「当前那个」状态机 —— 这样反向对照换宽限期时
     不必反复 add/remove（漏摘一次就会多一份定时器）。 */
  fab.addEventListener('pointerenter', function () { if (hover) hover.enter(); });
  fab.addEventListener('pointerleave', function () { if (hover) hover.leave(); });
  /* grace 省略 ⇒ 用生产代码的 FAB_HOVER_GRACE。 */
  window.__fabHover = function (grace) {
    if (hover) hover.cancel();
    hover = window.NPIE_HOVER.createFabHover({ grace: grace, onOpen: open, onClose: close });
  };
  /* 反向对照用：把监听器摘掉（= 0.23.0 的「只认点击」）。 */
  window.__fabUnbind = function () {
    if (hover) hover.cancel();
    hover = null;
    fab.classList.remove('is-open');
  };
  /* 只读快照：宽限期只有 220ms，量它不能走 __probe（那边有两个 settle，加起来 600ms）。 */
  window.__fabSnapshot = function () {
    var list = [].slice.call(document.querySelectorAll('.npr-book-fab-slot'));
    return {
      open: fab.classList.contains('is-open'),
      slots: list.map(function (el) {
        var cs = getComputedStyle(el);
        return { visibility: cs.visibility, opacity: Number(cs.opacity) };
      }),
    };
  };
  window.__fabHover();
})();
</script>`;

/**
 * 关键规则必须真的在样式表里 —— 抽错了的话后面所有判据都在量一个不存在的东西。
 * ★ 锚点写的是**带声明值**的整串：只匹配选择器的话，`height: 44px` 那条旧规则
 *   也能命中（它同样以 `.npr-book-toolbar` 开头），于是「拖动条只剩 10px」这条
 *   判据会拿旧规则当证据、永远为真。
 * ★ 最后几条锚的是**动画机制**：位置走 CSS 变量（`--npr-fab-x/y`）、直径走
 *   `--npr-fab-size`、逐格延迟走 `--npr-fab-i`。少了这些，7 格会「瞬移」到位置上 ——
 *   几何判据全绿，但没有动画。
 * ★ 0.23.0 起**刻意不再**锚 `.npr-book-fab:hover .npr-book-fab-slot`：hover 展开
 *   就是这一轮要删掉的东西。反过来，下面有一条判据专门证明它已经不在了。
 */
for (const anchor of [
  '.npr-book > .npr-book-toolbar { height: 10px;',
  '.npr-book-chrome { position: relative; z-index: 30; display: flex; justify-content: center;',
  '.npr-book-fab { position: absolute; z-index: 40;',
  '.npr-book-fab-list { position: absolute; right: 22px; bottom: 22px;',
  '.npr-book-fab-slot { position: absolute; left: 0; top: 0;',
  'transform: translate(0, 0) scale(.6);',
  '.npr-book-fab.is-open .npr-book-fab-slot {',
  'transform: translate(var(--npr-fab-x, 0px), var(--npr-fab-y, 0px)) scale(1);',
  'width: var(--npr-fab-size, 38px);',
  'transition-delay: calc((6 - var(--npr-fab-i, 0)) * 20ms);',
  '.npr-book-fab-label { position: absolute; right: calc(100% + 8px);',
  '.npr-workarea.is-book-immersive .npr-sidebar,',
  '.npr-book-palette { position: absolute; z-index: 50; top: calc(100% + 8px); right: 0;',
  '.npr-book-stage { filter: brightness(',
  /* 0.24.3：浮动按钮的定位基准换成阅读区那一层；纸色覆盖层负责把 PDF 的白纸染色。 */
  '.npr-book-view { position: relative;',
  '.npr-book-tint { position: absolute; inset: 0; pointer-events: none; mix-blend-mode: multiply;',
]) {
  if (!REFINEMENTS.includes(anchor)) throw new Error(`refinements.css 里没有 ${anchor} —— 抽错了或规则已被改掉`);
}

/** 宿主令牌（浅色）。缺一个都会让 `--npr-*` 派生链毒化成空值。 */
const HOST_TOKENS = `:root,body{
  --dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#f7f8f9;--dsw-alias-bg-layer-2:#f1f2f4;
  --dsw-alias-bg-layer-3:#ffffff;--dsw-alias-bg-mask-1:rgba(15,17,21,.4);
  --dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;--dsw-alias-label-tertiary:#81858c;
  --dsw-alias-border-l1:#e6e8ea;--dsw-alias-border-l2:#d5d8dc;
  --dsw-alias-interactive-bg-hover:#f1f2f4;--dsw-alias-brand-primary:#3d58e0;
  --dsw-alias-state-error-primary:#d92d20;--dsw-alias-state-warn-primary:#b54708;
  --dsw-focus-ring-width:1px;--dsw-focus-ring-color:#3d58e0;}`;

/**
 * ── 分工：从**源文本**里核，不从夹具里核 ────────────────────────────────
 * ★ 夹具是我自己按理解写的，拿它核分工等于自问自答：我把 13 项全塞进扇出时，
 *   夹具也会跟着塞 13 项，然后「恰好 13 格」全绿 —— 正是上一版发生过的事。
 *   唯一能证伪的写法是数 `BookReader.jsx` 里那两个块各出现了几次类名。
 * ★ 切片用「文本锚点」而不是行号：行号一改就错位，文本锚点改坏了会找不到（直接抛错）。
 */
const CHROME_START = bookSrc.indexOf('<div className="npr-book-chrome">');
const META_START = bookSrc.indexOf('<div className="npr-book-meta">', CHROME_START);
/** 扇出那个 div 的 className 是模板串，所以只能锚到 `npr-book-fab${` 这个片段。 */
const FAB_START = bookSrc.indexOf('npr-book-fab${');
/**
 * 扇出块的收尾。
 * ★ 0.24.3 起浮动按钮搬进了 `.npr-book-view`（阅读区），它后面紧跟的是伴读面板那段
 *   注释 —— 原来锚的「两块面板」现在在它**前面**了（`indexOf` 会返回 -1，脚本直接抛错）。
 */
const FAB_END = bookSrc.indexOf('伴读在**书页右边**', FAB_START);
for (const [name, value] of [['CHROME_START', CHROME_START], ['META_START', META_START],
  ['FAB_START', FAB_START], ['FAB_END', FAB_END]]) {
  if (value < 0) throw new Error(`切片锚点 ${name} 找不到 —— BookReader.jsx 的结构被改了，先修这个脚本再量`);
}
const CHROME_SRC = bookSrc.slice(CHROME_START, META_START);
const FAB_SRC = bookSrc.slice(FAB_START, FAB_END);
const countIn = (text, needle) => text.split(needle).length - 1;

/**
 * 顶部胶囊（开关类）应该有 6 项；右下角扇出（调档类）应该有 7 格。
 *
 * ★ 0.24.0 曾从 6 变 7（加了「导出」那一格），**0.24.1 又回到 6**：用户否决了
 *   那个位置 ——「把导出放在菜单条毫无意义」。入口搬到目录面板里「生成解读」右边
 *   （那颗 `book-to-skill`）。这条计数正是「分工有没有做反」的判据：胶囊里只留
 *   与「这本书」有关的**视图开关**，产出动作不进这一排。
 */
const PILL_COUNT = 6;
const SLOT_COUNT = 7;

/** 去掉注释的 CSS：断言「某类名已清干净」时必须忽略注释（注释里写过的名字不算规则）。 */
const CSS_NO_COMMENT = REFINEMENTS.replace(/\/\*[\s\S]*?\*\//g, '');
const cssCount = (needle) => CSS_NO_COMMENT.split(needle).length - 1;

/** 判据里用的面板尺寸。窄矮那组是「窗口不是全屏」的代表；极窄那组专测半径收缩。 */
const WIDE = { width: 1200, height: 820 };
const NARROW = { width: 420, height: 420 };
const TINY = { width: 200, height: 200 };

/**
 * 夹具。类名与结构逐字来自 `BookReader.jsx` —— 自己另起一套选择器量到的是
 * 「我以为的结构」，那正是这类几何判据最容易假绿的地方。
 * 画布给的是「比舞台高很多」的尺寸：适宽模式下书页本来就比容器高。
 * ★ 7 格的 DOM 顺序是**倒着**的（页码在最前、上一页在最后），与 JSX 里
 *   `slotStyle(6) … slotStyle(0)` 一一对应 —— probe 会按这个顺序把 `--npr-fab-i`
 *   写成 6…0，顺序写反了「第 0 格在正左」那条判据就会红。
 */
const html = `<!doctype html><meta charset="utf-8">
<style>${HOST_TOKENS}</style><style>${PANEL_CSS}</style><style>${REFINEMENTS}</style>
<style id="neutralize"></style>
<style>body{margin:0;background:#fff}</style>
<div class="npr-root" id="root" style="width:${WIDE.width}px;height:${WIDE.height}px">
  <!-- ★ 外层照 LibraryApp 的真实结构搭：沉浸态要藏的是**书架那一列**（.npr-sidebar）
       与它的分隔条，两者是 .npr-layout 的直接子级。少了这层，判据 ⑱ 无处可量。 -->
  <div class="npr-workarea" id="workarea" style="height:100%">
   <div class="npr-layout" id="layout" style="--npr-list-width:300px">
    <aside class="npr-sidebar" id="sidebar" style="padding:8px">书架（3 本）</aside>
    <div class="npr-resize" id="resize"></div>
    <section class="npr-reader npr-reader-book" id="reader" style="height:100%">
    <div class="npr-book" id="book" data-tint="paper" style="--npr-book-brightness:1">
      <div class="npr-book-toolbar" id="tb" data-window-drag></div>
      <div class="npr-book-chrome" id="chrome">
        <div class="npr-book-pill" id="pill" role="toolbar" aria-label="本书工具">
          <span class="npr-book-pill-title" id="pillTitle" title="猎人笔记">猎人笔记</span>
          <button type="button" class="npr-book-pill-item" id="pillDone" aria-pressed="false" title="标记读完">
            <svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor"/></svg><span>标记读完</span>
          </button>
          <button type="button" class="npr-book-pill-item" id="pillCompanion" aria-pressed="false" title="AI 伴读">
            <svg width="14" height="14" aria-hidden="true"><path d="M2 7h10" stroke="currentColor"/></svg><span>伴读</span>
          </button>
          <button type="button" class="npr-book-pill-item" id="pillMarks" aria-pressed="false" title="划线 / 笔记：4 条">
            <svg width="14" height="14" aria-hidden="true"><path d="M2 11h10" stroke="currentColor"/></svg><span>划线 4</span>
          </button>
          <button type="button" class="npr-book-pill-item" id="pillDigest" aria-pressed="false" title="本书目录">
            <svg width="14" height="14" aria-hidden="true"><path d="M4 3v9" stroke="currentColor"/></svg><span>目录 29</span>
          </button>
          <span class="npr-book-pill-tint" id="pillTint">
            <button type="button" class="npr-book-pill-item" id="pillTintBtn" aria-pressed="false" title="书页配色：原色">
              <svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="3" fill="currentColor"/></svg><span>配色 · 原色</span>
            </button>
            <div class="npr-book-palette" id="palette" style="display:none" role="dialog" aria-label="书页配色">
              <div class="npr-book-palette-dim">
                <svg width="13" height="13" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor"/></svg>
                <input type="range" aria-label="书页亮度" min="0.7" max="1.3" step="0.05" value="1" />
                <span>100%</span>
              </div>
              <p class="npr-book-palette-label">颜色</p>
              <div class="npr-book-swatches" role="radiogroup" aria-label="书页颜色">
                <button type="button" class="npr-book-swatch" data-tint="paper" role="radio" aria-checked="true" aria-label="原色"></button>
                <button type="button" class="npr-book-swatch" data-tint="sepia" role="radio" aria-checked="false" aria-label="护眼"></button>
                <button type="button" class="npr-book-swatch" data-tint="mint" role="radio" aria-checked="false" aria-label="薄荷"></button>
                <button type="button" class="npr-book-swatch" data-tint="night" role="radio" aria-checked="false" aria-label="夜间"></button>
              </div>
            </div>
          </span>
          <button type="button" class="npr-book-pill-item" id="pillImmerse" aria-pressed="false" title="沉浸式阅读（I）：只留书页">
            <svg width="14" height="14" aria-hidden="true"><path d="M2 6V2h4" stroke="currentColor"/></svg><span>沉浸</span>
          </button>
        </div>
      </div>
      <!-- ★ 元信息行里**没有书名**（0.23.0）：书名在胶囊里、书架里各有一份，
           这一行重复它只是让读者每翻一页都先扫过一串重复的字。 -->
      <div class="npr-book-meta" id="meta">
        <span id="metaText">PDF · 1.9 MB</span>
        <span>读到 51%</span>
        <span>上次读到第 279 页</span>
        <span>适应宽度 · 100%</span>
        <span class="npr-book-keys">← → ↑ ↓ 翻页 · I 沉浸 · N 配色</span>
      </div>
      <div class="npr-book-main" id="main">
        <aside class="npr-marks" id="marks" style="display:none" aria-label="划线与笔记">
          <header class="npr-marks-head">
            <div><h2>划线</h2><p>4 条 · 2 条笔记 · 分布在 3 页</p></div>
            <button type="button" class="npr-icon" aria-label="收起划线面板">x</button>
          </header>
          <div class="npr-marks-tabs" role="tablist">
            <button type="button" role="tab" aria-selected="true" class="npr-marks-tab is-on">全部划线<span class="npr-marks-tab-count">4</span></button>
            <button type="button" role="tab" aria-selected="false" class="npr-marks-tab">笔记<span class="npr-marks-tab-count">2</span></button>
          </div>
          <div class="npr-marks-list">
            <article class="npr-mark-card" data-tone="yellow">
              <button type="button" class="npr-mark-quote">因为，将生活归入幻想和梦想的例子，将生活献身于艺术不如将生活与艺术相连的例子，是极罕见的。</button>
              <div class="npr-mark-foot">
                <span class="npr-mark-page">第 12 页</span>
                <div class="npr-mark-tones" role="group" aria-label="标记颜色">
                  <button type="button" class="npr-mark-tone" data-tone="yellow" aria-pressed="true"></button>
                  <button type="button" class="npr-mark-tone" data-tone="green" aria-pressed="false"></button>
                  <button type="button" class="npr-mark-tone" data-tone="blue" aria-pressed="false"></button>
                  <button type="button" class="npr-mark-tone" data-tone="pink" aria-pressed="false"></button>
                </div>
                <button type="button" class="npr-mark-action" aria-label="写笔记">p</button>
                <button type="button" class="npr-mark-action" aria-label="删除">t</button>
              </div>
              <p class="npr-mark-note">这里在说「生活」与「艺术」的关系，和我一直想的那句「先活好再写」是同一件事。</p>
            </article>
            <article class="npr-mark-card is-editing" data-tone="green">
              <button type="button" class="npr-mark-quote">4 个小孩在开始写浪漫故事这一复杂的家庭游戏时年仅 6–10 岁。</button>
              <div class="npr-mark-foot">
                <span class="npr-mark-page">第 31 页</span>
                <div class="npr-mark-tones" role="group" aria-label="标记颜色">
                  <button type="button" class="npr-mark-tone" data-tone="yellow" aria-pressed="false"></button>
                  <button type="button" class="npr-mark-tone" data-tone="green" aria-pressed="true"></button>
                  <button type="button" class="npr-mark-tone" data-tone="blue" aria-pressed="false"></button>
                  <button type="button" class="npr-mark-tone" data-tone="pink" aria-pressed="false"></button>
                </div>
                <button type="button" class="npr-mark-action" aria-label="写笔记">p</button>
                <button type="button" class="npr-mark-action" aria-label="删除">t</button>
              </div>
              <div class="npr-mark-editor">
                <textarea rows="3" placeholder="写一句你的想法…">四姊妹小时候的游戏，后来变成了她们一生的写作。</textarea>
                <div class="npr-mark-editor-foot">
                  <button type="button" class="npr-marks-primary">保存笔记</button>
                  <span>22 字 · 保存</span>
                </div>
              </div>
            </article>
          </div>
        </aside>
        <div class="npr-book-view" id="view">
          <div class="npr-book-stage" id="stage">
            <div class="npr-book-sheet" id="sheet">
              <canvas class="npr-book-canvas" id="c" width="900" height="1400" style="width:900px;height:1400px"></canvas>
              <div class="npr-book-tint" id="tint" aria-hidden="true"></div>
            </div>
          </div>
        <div class="npr-book-fab" id="fab">
          <button type="button" class="npr-book-fab-button" id="fabBtn" aria-expanded="false" aria-haspopup="true" aria-controls="npr-book-fab-list" aria-label="展开翻页与缩放">
            <svg width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor"/></svg>
          </button>
          <div id="npr-book-fab-list" class="npr-book-fab-list" role="group" aria-label="翻页与缩放">
            <!-- DOM 顺序 = 视觉顺序：最上面是页码，最下面（紧贴按钮）是缩小。 -->
            <label class="npr-book-fab-slot is-page" id="slotPage" title="跳到第几页">
              <input class="npr-book-page" type="text" inputmode="numeric" aria-label="页码" value="279" />
              <span class="npr-book-fab-label">页码</span>
            </label>
            <button type="button" class="npr-book-fab-slot" id="slotPrev" title="上一页（←）" aria-label="上一页">
              <svg width="16" height="16" aria-hidden="true"><path d="M10 4L6 8l4 4" fill="none" stroke="currentColor"/></svg>
              <span class="npr-book-fab-label">上一页</span>
            </button>
            <button type="button" class="npr-book-fab-slot" id="slotNext" title="下一页（→）" aria-label="下一页">
              <svg width="16" height="16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor"/></svg>
              <span class="npr-book-fab-label">下一页</span>
            </button>
            <button type="button" class="npr-book-fab-slot is-on" id="slotFitWidth" title="适应宽度（W）" aria-label="适应宽度">
              <svg width="16" height="16" aria-hidden="true"><path d="M2 8h12" stroke="currentColor"/></svg>
              <span class="npr-book-fab-label">适宽</span>
            </button>
            <button type="button" class="npr-book-fab-slot" id="slotFitPage" title="适应窗口（P）" aria-label="适应窗口">
              <svg width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor"/></svg>
              <span class="npr-book-fab-label">适应窗口</span>
            </button>
            <button type="button" class="npr-book-fab-slot" id="slotPlus" title="放大（+）" aria-label="放大">
              <svg width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor"/></svg>
              <span class="npr-book-fab-label">放大</span>
            </button>
            <button type="button" class="npr-book-fab-slot" id="slotMinus" title="缩小（-）" aria-label="缩小">
              <svg width="16" height="16" aria-hidden="true"><path d="M3 8h10" stroke="currentColor"/></svg>
              <span class="npr-book-fab-label">缩小</span>
            </button>
          </div>
        </div>
        </div>
        <!-- 伴读面板（0.24.3 起要它才量得出「浮动按钮钉在阅读区还是整面板」）：
             横排时它占右侧 348px，浮动按钮若还钉在 .npr-book 上就会跑到它的角上。 -->
        <aside class="npr-book-companion" id="companion" style="display:none" aria-label="AI 伴读">
          <header class="npr-companion-header"><strong>AI 伴读</strong></header>
          <p class="npr-book-companion-hint">带着当前这一页追问。</p>
        </aside>
      </div>
    </div>
    </section>
   </div>
  </div>
</div>
${HOVER_RUNTIME}
<script>
/**
 * ★ 每一格的位置由**生产代码里的 fabStack** 算（Node 侧算好当参数传进来），
 *   夹具自己不另写一份：另写一份的话，改坏了生产代码这份脚本还是绿的 ——
 *   那就是自问自答，而这套判据存在的全部意义就是证伪生产代码。
 */
window.__probe = function (o) {
  o = o || {};
  var width = o.width == null ? 1200 : o.width;
  var height = o.height == null ? 820 : o.height;
  var root = document.getElementById('root');
  root.style.width = width + 'px';
  root.style.height = height + 'px';
  document.getElementById('marks').style.display = o.marks ? 'flex' : 'none';
  document.getElementById('palette').style.display = o.palette ? 'grid' : 'none';
  /* 伴读：右侧多一栏。这是判据 ㉓ 的**唯一**变量 —— 按钮要么跟着书页区收窄，
     要么留在整面板的角上（0.23.0 及之前的行为）。 */
  document.getElementById('companion').style.display = o.companion ? 'flex' : 'none';

  var book = document.getElementById('book');
  book.classList.toggle('is-immersive', !!o.immersive);
  book.dataset.tint = o.tint || 'paper';
  book.style.setProperty('--npr-book-brightness', String(o.brightness == null ? 1 : o.brightness));

  /* is-open 挂在**按钮容器**上（.npr-book-fab）。挂错对象的话展开态永远不生效，
     而所有「展开后」的判据都在量一个收起的列 —— 看上去还是绿的，只是量错了东西。
     ★ open **省略时不动**这个类（0.24.3）：悬停那组判据要量的是「类由真实指针
       事件决定」，每次 probe 都强制 toggle 的话，量到的永远是我刚写进去的那个值。 */
  var fab = document.getElementById('fab');
  if (o.open === true || o.open === false) fab.classList.toggle('is-open', o.open);

  /* 每格的位置与直径写进 CSS 变量，DOM 顺序与 JSX 完全一致（第 0 个是最上面的页码）。
     dataset.stackIndex 回填给 Node 侧，判据按它比理论位置 —— 不靠猜顺序。
     ★ 直径也要写：矮面板里 fabStack 会把它缩到 26px，只写位置的话 CSS 仍按 38px 画，
       相邻圆心距就小于格宽 ⇒ 判据 ⑪ 会红，但红的是**夹具漏写变量**而不是生产代码。 */
  var stack = o.stack || [];
  var slots = [].slice.call(document.querySelectorAll('.npr-book-fab-slot'));
  slots.forEach(function (el, index) {
    var p = stack[index] || { x: 0, y: 0, size: 38 };
    el.dataset.stackIndex = String(index);
    el.style.setProperty('--npr-fab-x', p.x + 'px');
    el.style.setProperty('--npr-fab-y', p.y + 'px');
    el.style.setProperty('--npr-fab-size', p.size + 'px');
    el.style.setProperty('--npr-fab-i', String(index));
  });
  var listEl = document.getElementById('npr-book-fab-list');
  if (listEl && stack[0]) listEl.style.setProperty('--npr-fab-span', Math.abs(stack[0].y) + 'px');

  /* 沉浸：除了书本身，还要给**外层** .npr-workarea 加类 —— 书架那一列在祖先里，
     阅读器改不到它的显隐（生产代码里是 LibraryApp 做的同一件事）。 */
  document.getElementById('workarea').classList.toggle('is-book-immersive', !!o.immersive);

  /* 反向对照：只改 CSS，不动结构 —— 另写一份坏 HTML 不算对照，那只是又写了一遍
     我以为的样子。每组坏规则都要能把**对应那一条**判据弄红。 */
  var rules = [];
  if (o.neutralize) rules.push('.npr-book > .npr-book-toolbar{height:44px !important}');
  /* ★ top 用 64px 是**刻意落到舞台内部**：这个 bug 的形态就是「元信息浮在书页上」。
     用 6px 的话它落在胶囊与舞台之间那条缝里、并不压住书页，判据 ② 照样绿 ——
     反向对照就成了「证明一个不存在的坏处不会发生」。 */
  if (o.breakMeta) rules.push('.npr-book > .npr-book-meta{position:absolute !important;top:64px !important;left:8px !important}');
  if (o.breakChrome) rules.push('.npr-book-chrome{position:absolute !important;left:0 !important;right:0 !important;top:auto !important;bottom:16px !important;z-index:5 !important}');
  if (o.breakFab) rules.push('.npr-book-fab{right:auto !important;left:8px !important;bottom:auto !important;top:8px !important}');
  /* 把胶囊那一行退回 static：配色面板的 z-index 就被关在 pill 的栈上下文里
     （pill 有 backdrop-filter，它自己会创建栈上下文），于是后面的元信息行把它盖住。 */
  if (o.breakZ) rules.push('.npr-book-chrome{position:static !important;z-index:auto !important}');
  if (o.breakStack) rules.push('.npr-book-fab-slot{--npr-fab-x:0px !important;--npr-fab-y:0px !important}');
  /* 把 x 偏移推成 -160：整列歪出面板左边，判据 ⑫「标签与圆都不越界」必须红。 */
  if (o.breakSideways) rules.push('.npr-book-fab-slot{--npr-fab-x:-400px !important}');
  if (o.overshoot) rules.push('.npr-book-fab-slot{--npr-fab-x:-190px !important;--npr-fab-y:0px !important}');
  if (o.forceOpen) rules.push('.npr-book-fab-slot{opacity:1 !important;visibility:visible !important;pointer-events:auto !important}');
  /* 标签藏掉：判据 ⑫「每一格都有文字标签」必须红。 */
  if (o.breakLabel) rules.push('.npr-book-fab-label{display:none !important}');
  /* 直径写死 38px（生产代码在矮面板里会缩到 26）：判据 ⑯「缩过之后仍不叠」必须红。 */
  if (o.breakSize) rules.push('.npr-book-fab-slot{--npr-fab-size:38px !important}');
  /* 把书架那一列的隐藏规则注掉：判据 ⑱「沉浸时书架不占位」必须红。 */
  if (o.keepShelf) rules.push('.npr-workarea.is-book-immersive .npr-sidebar{display:flex !important}');
  /* ★ 判据 ㉓ 的反向对照：让 .npr-book-view 退回 static ⇒ 浮动按钮的定位基准回到
     .npr-book-main（右缘 = 整个面板右缘）⇒ 开着伴读时它落到伴读的角上。
     这正是 0.23.0 及之前的形态，用一条 CSS 就能复现，不必另写一份坏 HTML。 */
  if (o.breakFabAnchor) rules.push('.npr-book-view{position:static !important}');
  /* ★ 判据 ㉔ 的反向对照：把纸色覆盖层改成透明（PDF 页恢复成白纸）。
     ★ 不能用 display:none：元素一旦 display:none，getComputedStyle 仍返回**声明值**
       rgb(247,236,214) —— 判据读不到「透明」，对照会假绿（实测过）。
       改成 background:transparent 才是真的「覆盖层不起作用」。 */
  if (o.breakTint) rules.push('.npr-book-tint{background:transparent !important}');
  document.getElementById('neutralize').textContent = rules.join(' ');
  /* 强制回流，否则刚写的样式还没参与布局就去量了。 */
  void book.offsetHeight;

  var rectOf = function (el) {
    var r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
  };
  var cssOf = function (el) { return getComputedStyle(el); };
  var midOf = function (r) { return { cx: (r.l + r.r) / 2, cy: (r.t + r.b) / 2 }; };
  /**
   * 元素底色的亮度（0–255）。
   * ★ 两种格式都要认：color-mix 算出来的颜色在 Chrome 里是 color(srgb 0.94 …)
   *   （分量 0–1），而写死的 #16181c 是 rgb(22, 24, 28)（分量 0–255）。
   * ★ 正则里不能写转义的 d：这段代码在模板串里，反斜杠会被模板串吞掉，
   *   正则退化成 [d.] ⇒ 一个数字都匹配不到。
   */
  var lumaOf = function (el) {
    var n = (getComputedStyle(el).backgroundColor.match(/[0-9.]+/g) || []).map(Number);
    if (n.length < 3) return -1;
    var ch = n.slice(0, 3);
    var scale = ch.every(function (v) { return v <= 1.001; }) ? 255 : 1;
    return Math.round((0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]) * scale);
  };

  var tb = document.getElementById('tb');
  var chrome = document.getElementById('chrome');
  var pill = document.getElementById('pill');
  var meta = document.getElementById('meta');
  var stage = document.getElementById('stage');
  var canvasEl = document.getElementById('c');
  var fabBtn = document.getElementById('fabBtn');
  var marksEl = document.getElementById('marks');
  var tintWrap = document.getElementById('pillTint');
  var tintEl = document.getElementById('tint');
  var companionEl = document.getElementById('companion');

  var out = {
    width: width, height: height,
    book: rectOf(book),
    tb: rectOf(tb), tbHeight: cssOf(tb).height, tbPosition: cssOf(tb).position, tbBg: cssOf(tb).backgroundColor,
    chrome: rectOf(chrome), chromeDisplay: cssOf(chrome).display,
    pill: rectOf(pill), pillScrollWidth: pill.scrollWidth, pillClientWidth: pill.clientWidth,
    pillLuma: lumaOf(pill),
    meta: rectOf(meta), metaDisplay: cssOf(meta).display,
    main: rectOf(document.getElementById('main')),
    stage: rectOf(stage),
    stagePadTop: parseFloat(cssOf(stage).paddingTop),
    canvas: rectOf(canvasEl),
    /** 纸色覆盖层：底色、混合方式、几何（必须与画布完全重合）。 */
    tint: rectOf(tintEl),
    tintBg: cssOf(tintEl).backgroundColor,
    tintBlend: cssOf(tintEl).mixBlendMode,
    tintPe: cssOf(tintEl).pointerEvents,
    /** 阅读区定位基准 + 伴读面板（判据 ㉓ 的两端）。 */
    view: rectOf(document.getElementById('view')),
    companion: rectOf(companionEl),
    companionDisplay: cssOf(companionEl).display,
    fab: rectOf(fab),
    fabBtn: rectOf(fabBtn),
    fabBtnCenter: midOf(rectOf(fabBtn)),
    fabPosition: cssOf(fab).position,
    fabZ: cssOf(fab).zIndex,
    fabOpacity: Number(cssOf(fab).opacity),
    fabFilter: cssOf(fab).filter,
    stageLuma: lumaOf(stage),
    stageFilter: cssOf(stage).filter,
    canvasFilter: cssOf(canvasEl).filter,
    pillTint: rectOf(tintWrap),
    paletteBox: rectOf(document.getElementById('palette')),
    marks: rectOf(marksEl),
    marksScrollWidth: marksEl.scrollWidth,
    marksClientWidth: marksEl.clientWidth,
    /** 每个开关的宽度，以及它的文字层还在不在（窄面板里切成图标版，文字层会消失）。 */
    pillItems: [].slice.call(document.querySelectorAll('.npr-book-pill-item')).map(function (el) {
      var r = el.getBoundingClientRect();
      var span = el.querySelector('span');
      return { w: r.width, h: r.height, l: r.left, t: r.top, r: r.right, b: r.bottom,
        spanShown: span ? span.getBoundingClientRect().width > 0 : false };
    }),
    /**
     * 7 格的实测矩形 + 状态。
     * ★ 收起态带 scale(.6)，所以 w 会是 23 左右而不是 38 —— 判据 ⑥ 拿这一点当
     *   「从按钮里长出来」的证据。
     * ★ 标签的矩形也一起量：它挂在槽位里（right: calc(100% + 8px)），展开态必须
     *   出现在圆的**左侧**且不越出面板 —— 这是用户那张参照图的核心形态。
     */
    slots: slots.map(function (el) {
      var r = rectOf(el);
      var cs = cssOf(el);
      var c = midOf(r);
      var label = el.querySelector('.npr-book-fab-label');
      var lr = label ? rectOf(label) : null;
      var lcs = label ? cssOf(label) : null;
      return { id: el.id, stack: Number(el.dataset.stackIndex),
        l: r.l, t: r.t, r: r.r, b: r.b, w: r.w, h: r.h, cx: c.cx, cy: c.cy,
        opacity: Number(cs.opacity), visibility: cs.visibility, pe: cs.pointerEvents,
        bgLuma: lumaOf(el),
        label: lr, labelText: label ? (label.textContent || '').trim() : '',
        labelOpacity: lcs ? Number(lcs.opacity) : 0,
        labelBgLuma: label ? lumaOf(label) : -1 };
    }),
    /** 外层那两列（沉浸态要藏的就是它们）。 */
    sidebar: rectOf(document.getElementById('sidebar')),
    sidebarDisplay: cssOf(document.getElementById('sidebar')).display,
    resizeDisplay: cssOf(document.getElementById('resize')).display,
    reader: rectOf(document.getElementById('reader')),
    workarea: rectOf(document.getElementById('workarea')),
    fabList: listEl ? rectOf(listEl) : null,
    stackVars: slots.map(function (el) { return cssOf(el).getPropertyValue('--npr-fab-y').trim(); }),
    /** 元信息行的**文字内容**：判据 ② 用它证明书名已经不在这一行里。 */
    metaText: (meta.textContent || '').replace(/\s+/g, ' ').trim(),
  };

  /**
   * 配色面板的**绘制层级**：面板中心与底部那行色块各取一点，看命中的是谁。
   * ★ 为什么不能用「面板的 z-index 是 50」来判：.npr-book-pill 有
   *   backdrop-filter，它会创建栈上下文，面板的 z-index 只在这个上下文**内部**排序 ——
   *   整个胶囊相对后面的元信息行仍然只是一个普通流元素，于是元信息行把它盖住。
   *   这件事只有「命中了谁」量得出来。
   * ★ 元信息行没有 pointer-events: none（只有旧版浮层才有），所以 elementFromPoint
   *   会如实命中它，不会因为穿透而假绿。
   */
  var pal = document.getElementById('palette');
  if (pal.style.display !== 'none') {
    var pr = pal.getBoundingClientRect();
    var owned = function (node) { return !!node && (node === pal || pal.contains(node)); };
    var px = pr.left + pr.width / 2;
    out.paletteHit = {
      mid: owned(document.elementFromPoint(px, pr.top + pr.height / 2)),
      low: owned(document.elementFromPoint(px, pr.bottom - 14)),
      /** 坏态下命中到的元素的类名，方便失败时一眼看出被谁盖了。 */
      lowWho: (function () {
        var n = document.elementFromPoint(px, pr.bottom - 14);
        return n ? (n.className || n.tagName) : 'null';
      })(),
    };
  } else {
    out.paletteHit = { mid: null, low: null, lowWho: 'none' };
  }
  /* 截图按**面板外框**裁：宽面板的 root 比视口窄不了多少、窄面板更是只有 480 ——
     不裁的话右边会拖一条 body 的白底，看起来像「面板没铺满」。 */
  window.scrollTo(0, 0);
  return out;
};
</script>`;

/* ---- 起本地服务 + Chrome ------------------------------------------------ */
const server = createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'npie-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--window-size=1240,900', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error(`Chrome 没报出调试端口：${buffer}`)), 20000);
  chrome.stderr.on('data', (chunk) => {
    buffer += chunk;
    const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
});

const origin = wsUrl.replace('ws://', 'http://').split('/devtools/')[0];
const target = await (await fetch(`${origin}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const waiting = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');

/**
 * 过渡要跑完再量。展开总时长 = 逐格延迟 6×18ms + transform .26s = 368ms；
 * 收起 = 6×14ms + .26s = 344ms。给 480ms 留足余量。
 * ★ 不等的话读到的是**起点值**（opacity 还在 0、位置还在圆心）——
 *   几何判据会以「起点」为证据，反向对照则永远假绿（它证明的将是「什么都没变」）。
 */
const settle = (ms = 480) => new Promise((done) => setTimeout(done, ms));

/**
 * 调一次探针。
 * ★ 列的位置**必须在这里现算**（用生产代码的 `fabStack`），并且按面板高度而不是窗口：
 *   判据 ⑯ 要量的正是「同一份算法在矮面板里会收缩直径」。
 * ★★ **必须调用两次**（写一次、等过渡跑完、再读一次）。这套 CSS 的展开/收起是
 *   `transition` + 逐格 `transition-delay`（最长 0.28s + 6×20ms ≈ 0.4s），只调一次的话
 *   量到的是**过渡起点**：7 格全在按钮圆心（偏移 0、尺寸还是收起态的 22.8px）。
 *   0.22.0 那版没踩这个坑只是因为所有展开态都走 `hoverFab`（它自带 `settle`），
 *   这一版把「点开」改成状态驱动，直接 `probe` 就露出来了。
 */
const FAB_TRANSITION_MS = 420;

async function probe(options = {}) {
  const size = {
    width: options.width ?? WIDE.width,
    height: options.height ?? WIDE.height,
  };
  const evaluate = async (payload) => {
    const response = await send('Runtime.evaluate', {
      expression: `window.__probe(${JSON.stringify(payload)})`,
      returnByValue: true,
    });
    const value = response.result?.result?.value;
    if (value === undefined) throw new Error(JSON.stringify(response.result?.exceptionDetails ?? response));
    return value;
  };
  /**
   * ★ 第一步只是**量顶部预留**（拖动条 + 胶囊 + 元信息行占了多高），不写列的位置。
   *   列不许侵入这一带 —— 420px 高的面板里，最上面那格正好会压到胶囊上，
   *   而 FAB 的 `z-index: 40` 高于胶囊的 30，被盖住的胶囊按钮点不到。
   *   `fabStack` 需要这个数，但它只能在 DOM 里量出来，所以先跑一次空列。
   * ★ 量两次、中间等一下：改 `width/height` 会让 `@container` 规则重新求值
   *   （窄面板里元信息行只剩一项、胶囊切成图标版），同一帧里读到的还是**上一套**
   *   布局 —— 实测 420×420 时第一次读到 70，稳定后是 89，差 19px 正好是一行元信息。
   *   差这一行，最上面那格就会压住胶囊 15px。
   */
  await evaluate({ ...size, ...options, stack: [] });
  await settle(140);
  const measured = await evaluate({ ...size, ...options, stack: [] });
  /**
   * ★ 高度用**实测的面板高度**（`book.h`），不是传进来的 `size.height`。
   *   两者不等：夹具的 `#root` 高 420，而 `.npr-book` 只有 382（面板顶部还有
   *   `data-titlebar` 那一截）。拿 420 去算预算，会多给 38px 的余量 ——
   *   实测最上面那格正好因此压住胶囊 15px。
   *   生产代码用的就是 `frame.height`（面板 rect 的高），这里必须同口径。
   */
  const panelHeight = measured.book.h;
  const topInset = Math.max(0, Math.round(measured.stage.t - measured.book.t));
  const stack = options.stack ?? fabStack({ count: SLOT_COUNT, height: panelHeight, top: topInset });
  const written = await evaluate({ ...size, ...options, stack });
  await settle(FAB_TRANSITION_MS);
  const value = await evaluate({ ...size, ...options, stack });
  return { ...value, stack, topInset, slotsWritten: written.slots.length };
}

/**
 * 把鼠标移到浮动按钮中心，等过渡结束，再读一次。
 * ★ 必须把当前状态原样带进去：`probe` 每次都会重写 class / data-tint / 尺寸，
 *   不带参数读一次坐标就等于**顺手退出了沉浸态 / 恢复了默认宽度**。
 */
async function hoverFab(options = {}) {
  const box = await probe({ ...options });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round((box.fabBtn.l + box.fabBtn.r) / 2),
    y: Math.round((box.fabBtn.t + box.fabBtn.b) / 2),
  });
  await settle();
  return probe({ ...options });
}
/** 把鼠标挪到左上角：取消 hover（量「移开之后」用）。 */
async function unhover() {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
  await settle();
}

/**
 * 把指针移到一个点（**只移动，不按键**）。
 * ★ 悬停那组判据必须用真指针事件：`CSS.forcePseudoState` 只能给元素强加 `:hover`，
 *   而这里的开合由 `pointerenter` / `pointerleave` 驱动，强制伪类根本触发不到。
 */
async function moveTo(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) });
}

/** 单次求值（**不 settle**）：宽限期只有几百毫秒，`probe()` 里那两个 settle 会把它跑完。 */
async function evaluateRaw(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true });
  const value = response.result?.result?.value;
  if (value === undefined) throw new Error(JSON.stringify(response.result?.exceptionDetails ?? response));
  return value;
}

/** 当前那一列的开合与逐格可见性（页面里的 `__fabSnapshot`，只读、不动状态）。 */
const fabSnapshot = () => evaluateRaw('window.__fabSnapshot()');
/** 把宽限期换掉（`0` = 立刻收，用来做反向对照；不传 = 恢复生产值）。 */
const setHoverGrace = (grace) => evaluateRaw(`(window.__fabHover(${grace === undefined ? '' : grace}), true)`);

/* ---- 几何小工具：全部对「实测中心」算，不对左上角算 --------------------- */
/** 按 stack 序（0 = 最上面）。 */
const byStack = (p) => [...p.slots].sort((a, b) => a.stack - b.stack);
/** 每格相对按钮圆心的偏移。 */
const offsetsOf = (p) => p.slots.map((s) => ({ dx: s.cx - p.fabBtnCenter.cx, dy: s.cy - p.fabBtnCenter.cy }));
/** 逐格：实测中心 vs「按钮中心 + fabStack 理论偏移」的最大偏差（px）。 */
const stackErrorOf = (p) => Math.max(...p.slots.map((s) => {
  const e = p.stack[s.stack] ?? { x: 0, y: 0 };
  return Math.hypot(s.cx - (p.fabBtnCenter.cx + e.x), s.cy - (p.fabBtnCenter.cy + e.y));
}));
/** 相邻两格（按 stack 序）的圆心距。 */
const gapsOf = (p) => {
  const list = byStack(p);
  return list.slice(1).map((s, i) => Math.hypot(s.cx - list[i].cx, s.cy - list[i].cy));
};
/** 任意两格的最小圆心距（比「相邻」更严：跨格也不许叠）。 */
const minPairGap = (p) => {
  let min = Infinity;
  for (let i = 0; i < p.slots.length; i += 1) {
    for (let j = i + 1; j < p.slots.length; j += 1) {
      min = Math.min(min, Math.hypot(p.slots[i].cx - p.slots[j].cx, p.slots[i].cy - p.slots[j].cy));
    }
  }
  return min;
};
/** 越出面板多少（正数 = 越界）。**圆与标签都算**：标签伸到面板外面同样看不见。 */
const outsideBy = (p) => Math.max(...p.slots.map((s) => Math.max(
  p.book.l - s.l, p.book.t - s.t, s.r - p.book.r, s.b - p.book.b,
  s.label ? p.book.l - s.label.l : -Infinity,
  s.label ? s.label.r - p.book.r : -Infinity)));
/** 只看标签的越界量（判据 ⑫ 单独用一条，好定位是圆出界还是标签出界）。 */
const labelOutsideBy = (p) => Math.max(...p.slots.map((s) => (s.label
  ? Math.max(p.book.l - s.label.l, s.label.r - p.book.r)
  : -Infinity)));

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `\n    ${detail}`}`);
};
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));

try {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await settle(500);

  console.log('—— 分工：谁在顶部、谁在右下角 ——');
  const pillInChrome = countIn(CHROME_SRC, 'npr-book-pill-item');
  const slotInChrome = countIn(CHROME_SRC, 'npr-book-fab-slot');
  const slotInFab = countIn(FAB_SRC, 'npr-book-fab-slot');
  const pillInFab = countIn(FAB_SRC, 'npr-book-pill-item');
  check(`⓪ 顶部胶囊恰好 ${PILL_COUNT} 项（标记读完 / 伴读 / 划线 / 目录 / 配色 / 沉浸）`,
    pillInChrome === PILL_COUNT,
    `BookReader.jsx 的 .npr-book-chrome 块里 npr-book-pill-item 出现 ${pillInChrome} 次`);
  check(`⓪ 右下角恰好 ${SLOT_COUNT} 格（页码 / 上下页 / 适宽 / 适应窗口 / 放大 / 缩小）`,
    slotInFab === SLOT_COUNT,
    `BookReader.jsx 的 .npr-book-fab 块里 npr-book-fab-slot 出现 ${slotInFab} 次`);
  check('⓪ 顶部没有混进调档类（浮动列那 7 格一个都不在胶囊里）',
    slotInChrome === 0, `顶部块里 npr-book-fab-slot 出现 ${slotInChrome} 次`);
  check(`⓪ 右下角没有混进开关类（${PILL_COUNT} 个开关一个都不在浮动列里）`,
    pillInFab === 0, `浮动块里 npr-book-pill-item 出现 ${pillInFab} 次`);
  /* ★ 0.24.3 措辞：悬停**回来了**，但走的是 JS（pointerenter / pointerleave + 宽限期），
     一行 `:hover` 规则都不写。所以这条判据守的是「CSS 里没有 hover 规则」，
     不是「悬停被删了」—— 后者是 0.23.0 的形态，已经被判据 ⑭ 反过来钉住了。 */
  check('⓪ ★ 开合只认 `.is-open`：CSS 里 `.npr-book-fab:hover .npr-book-fab-slot` 0 处',
    cssCount('.npr-book-fab:hover .npr-book-fab-slot') === 0,
    `命中 ${cssCount('.npr-book-fab:hover .npr-book-fab-slot')} 处（已剔除注释）—— 靠 CSS hover 展开必然在空隙里闪断`);
  check('⓪ 格数由 fabStack 的 count 决定（不是散落在别处的魔法数）',
    countIn(bookSrc, 'fabStack({ count: 7') === 1 && countIn(bookSrc, 'FAB_ITEM_COUNT') === 0,
    `fabStack({ count: 7 出现 ${countIn(bookSrc, 'fabStack({ count: 7')} 次，FAB_ITEM_COUNT 残留 ${countIn(bookSrc, 'FAB_ITEM_COUNT')} 处`);
  check('⓪ 旧圆弧实现已清零（fabArc / fabRadius / FAB_RADIUS 在源码里各 0 处）',
    countIn(bookSrc, 'fabArc') === 0 && countIn(bookSrc, 'fabRadius') === 0
      && countIn(bookSrc, 'FAB_RADIUS') === 0,
    `fabArc=${countIn(bookSrc, 'fabArc')} fabRadius=${countIn(bookSrc, 'fabRadius')} FAB_RADIUS=${countIn(bookSrc, 'FAB_RADIUS')}`);
  check('⓪ 展开只有一个入口：`.is-open`（不再有 is-pinned）',
    countIn(bookSrc, 'is-pinned') === 0 && countIn(bookSrc, 'is-open') >= 1,
    `is-pinned=${countIn(bookSrc, 'is-pinned')} is-open=${countIn(bookSrc, 'is-open')}`);

  console.log('\n—— 顶部（1200×820）——');
  await unhover();
  const wide = await probe({});
  check('① 顶部只剩一条 10px 拖动条（不再占 44px 一行）',
    parseFloat(wide.tbHeight) <= 12 && wide.tbPosition === 'static',
    `高=${wide.tbHeight} position=${wide.tbPosition}`);
  check('① 拖动条**铺满宽度**（窗口拖动区不能缩成一小块）',
    wide.tb.w >= wide.book.w - 1,
    `拖动条 ${fmt(wide.tb.w)} / 面板 ${fmt(wide.book.w)}`);
  check('① 拖动条透明（一条看不见的拖动区，不是一条灰带）',
    /rgba\(0, 0, 0, 0\)|transparent/.test(wide.tbBg),
    `background=${wide.tbBg}`);
  check('② 元信息行在正常流里：底边不越过舞台顶边',
    wide.meta.b <= wide.stage.t + 1,
    `元信息底=${fmt(wide.meta.b)} 舞台顶=${fmt(wide.stage.t)}`);
  check('② 元信息行只有一行（不该折成两行占掉书页高度）',
    wide.meta.h <= 30, `高=${fmt(wide.meta.h)}`);
  check('② ★ 元信息行里**没有书名**（用户：「这里的标注说明就不要显示文件名称了」）',
    !wide.metaText.includes('猎人笔记'),
    `这一行的文字：${wide.metaText}`);
  check('② 元信息行仍有内容（去掉书名不等于把整行删空）',
    wide.metaText.length >= 8 && wide.metaText.includes('PDF'),
    `这一行的文字：${wide.metaText}`);
  check('③ 胶囊在**顶部**（不是跑到下面去了）',
    wide.pill.t >= wide.book.t - 0.5 && wide.pill.t < wide.book.t + 60,
    `胶囊顶=${fmt(wide.pill.t)} 面板顶=${fmt(wide.book.t)}`);
  check('③ 胶囊**水平居中**（左右留白对得上，误差 ≤ 2px）',
    Math.abs((wide.pill.l - wide.book.l) - (wide.book.r - wide.pill.r)) <= 2,
    `左留白=${fmt(wide.pill.l - wide.book.l)} 右留白=${fmt(wide.book.r - wide.pill.r)}`);
  check('③ 胶囊装得下（不越出面板左右）',
    wide.pill.l >= wide.book.l - 0.5 && wide.pill.r <= wide.book.r + 0.5,
    `胶囊 ${fmt(wide.pill.l)}–${fmt(wide.pill.r)} / 面板 ${fmt(wide.book.l)}–${fmt(wide.book.r)}`);
  check('③ 胶囊内容不被裁（scrollWidth ≤ clientWidth）',
    wide.pillScrollWidth <= wide.pillClientWidth + 1,
    `内容=${wide.pillScrollWidth} 外框=${wide.pillClientWidth}`);
  check(`④ 胶囊里恰好 ${PILL_COUNT} 个开关（DOM 实测，不是数源码）`,
    wide.pillItems.length === PILL_COUNT, `实测 ${wide.pillItems.length} 个`);
  check('④ 宽面板里每个开关都带文字（不是只剩图标）',
    wide.pillItems.every((item) => item.spanShown),
    `带文字 ${wide.pillItems.filter((item) => item.spanShown).length} / ${wide.pillItems.length}`);
  check('④ 每个开关都够宽（点得中，标签不被压没）',
    wide.pillItems.every((item) => item.w >= 40),
    `最窄=${fmt(Math.min(...wide.pillItems.map((item) => item.w)))}`);
  check('④ 胶囊高度 36px 上下（一颗胶囊，不是一坨）',
    wide.pill.h >= 30 && wide.pill.h <= 40, `高=${fmt(wide.pill.h)}`);

  console.log('\n—— 右下角浮动按钮（1200×820）——');
  const closed = await probe({});
  check('⑤ FAB 贴右下角（距右/下各 14px）',
    Math.abs((closed.book.r - closed.fab.r) - FAB_MARGIN) <= 1.5
      && Math.abs((closed.book.b - closed.fab.b) - FAB_MARGIN) <= 1.5,
    `右边距=${fmt(closed.book.r - closed.fab.r)} 底边距=${fmt(closed.book.b - closed.fab.b)}`);
  check('⑤ FAB 完全落在面板内（不越界）',
    closed.fab.l >= closed.book.l && closed.fab.t >= closed.book.t && closed.fab.r <= closed.book.r + 0.5,
    `FAB ${fmt(closed.fab.l)}–${fmt(closed.fab.r)} / 面板 ${fmt(closed.book.l)}–${fmt(closed.book.r)}`);
  check('⑤ FAB 真的浮着（absolute + z-index > 0）',
    closed.fabPosition === 'absolute' && Number(closed.fabZ) > 0,
    `position=${closed.fabPosition} z=${closed.fabZ}`);
  check('⑤ FAB 在右半区，不压正文中心',
    closed.fab.l >= closed.book.l + closed.book.w * 0.6,
    `FAB 左=${fmt(closed.fab.l)} 面板 60% 线=${fmt(closed.book.l + closed.book.w * 0.6)}`);
  check('⑤ 按钮是 44px 的圆（与 FAB_BUTTON_SIZE 的几何基准一致）',
    Math.abs(closed.fabBtn.w - FAB_BUTTON_SIZE) <= 1 && Math.abs(closed.fabBtn.h - FAB_BUTTON_SIZE) <= 1,
    `${fmt(closed.fabBtn.w)}×${fmt(closed.fabBtn.h)}`);
  check('⑥ 收起态：7 格全部 `visibility: hidden`',
    closed.slots.every((s) => s.visibility === 'hidden'),
    `visible 的格数=${closed.slots.filter((s) => s.visibility !== 'hidden').length}`);
  check('⑥ 收起态：7 格全部透明（opacity 0）',
    closed.slots.every((s) => s.opacity <= 0.02),
    `最大 opacity=${Math.max(...closed.slots.map((s) => s.opacity))}`);
  check('⑥ 收起态：7 格**不吃点击**（否则看不见的圆片挡住划选）',
    closed.slots.every((s) => s.pe === 'none'),
    `pointer-events 不是 none 的格数=${closed.slots.filter((s) => s.pe !== 'none').length}`);
  check('⑥ 收起态：7 格都**收回到按钮圆心**（偏移 ≤ 1.2px —— 这是动画起点）',
    Math.max(...offsetsOf(closed).map((o) => Math.hypot(o.dx, o.dy))) <= 1.2,
    `最大偏移=${fmt(Math.max(...offsetsOf(closed).map((o) => Math.hypot(o.dx, o.dy))))}`);
  check('⑥ 收起态：7 格都缩到 0.6 倍（「从按钮里长出来」）',
    closed.slots.every((s) => s.w <= FAB_SLOT_SIZE * 0.6 + 1),
    `最大宽=${fmt(Math.max(...closed.slots.map((s) => s.w)))}（展开态应为 ${FAB_SLOT_SIZE}）`);
  check('⑥ 收起态：7 个文字标签也不可见（不能有 7 个标签浮在书页上）',
    closed.slots.every((s) => s.label === null || s.labelOpacity <= 0.02),
    `可见标签数=${closed.slots.filter((s) => s.label && s.labelOpacity > 0.02).length}`);

  const open = await probe({ open: true });
  check('⑦ 点开之后 7 格展开：不透明且可见',
    open.slots.every((s) => s.opacity >= 0.98 && s.visibility === 'visible'),
    `最小 opacity=${fmt(Math.min(...open.slots.map((s) => s.opacity)))}`);
  check('⑦ 点开之后 7 格可接收点击',
    open.slots.every((s) => s.pe === 'auto'),
    `不是 auto 的格数=${open.slots.filter((s) => s.pe !== 'auto').length}`);
  check(`⑦ 展开后 7 格回到 ${FAB_SLOT_SIZE}px 原尺寸（不是把收起态的小圆片留在那儿）`,
    open.slots.every((s) => Math.abs(s.w - FAB_SLOT_SIZE) <= 1.5 && Math.abs(s.h - FAB_SLOT_SIZE) <= 1.5),
    `宽=${open.slots.map((s) => fmt(s.w)).join('/')}`);

  const offs = offsetsOf(open);
  check('⑧ **全部在按钮正上方**（没有一格跑到按钮左右或下方）',
    offs.every((o) => o.dy < -1),
    `dy=${offs.map((o) => fmt(o.dy)).join('/')}`);
  check(`⑧ 整列几乎垂直：横向只让出 ${FAB_BEND}px 的弧度`,
    offs.every((o) => o.dx <= 0.5 && o.dx >= -FAB_BEND - 1),
    `dx=${offs.map((o) => fmt(o.dx)).join('/')}（上限 ${-FAB_BEND}）`);
  const gaps = gapsOf(open);
  check(`⑧ 相邻两格**等距**：圆心距 = 直径 + 间隙（各段互差 ≤ 1px）`,
    Math.max(...gaps) - Math.min(...gaps) <= 1,
    `各段=${gaps.map(fmt).join(' / ')}`);
  check(`⑧ 相邻圆心距 ≥ 直径 ${FAB_SLOT_SIZE}px（不叠）`,
    Math.min(...gaps) >= FAB_SLOT_SIZE - 1,
    `最小相邻距=${fmt(Math.min(...gaps))}`);
  check('⑨ 逐格偏移与 fabStack 理论位置一致（≤ 1.2px —— 位置由生产代码说了算）',
    stackErrorOf(open) <= 1.2, `最大偏差=${fmt(stackErrorOf(open))}px`);

  const list = byStack(open);
  const bottom = list[list.length - 1];
  check('⑩ 最下面那格紧贴按钮：圆心距 = 按钮半径 + 间隙 + 半格',
    Math.abs((open.fabBtnCenter.cy - bottom.cy)
      - (FAB_BUTTON_SIZE / 2 + FAB_SLOT_GAP + FAB_SLOT_SIZE / 2)) <= 1.5,
    `实测 ${fmt(open.fabBtnCenter.cy - bottom.cy)} 期望 ${fmt(FAB_BUTTON_SIZE / 2 + FAB_SLOT_GAP + FAB_SLOT_SIZE / 2)}`);
  check('⑩ 最上面那格不顶出面板顶（也不压住顶部胶囊）',
    list[0].t >= open.book.t + 2 && list[0].t >= open.chrome.b - 1,
    `最上格顶=${fmt(list[0].t)} 面板顶=${fmt(open.book.t)} 胶囊底=${fmt(open.chrome.b)}`);
  check('⑪ 任意两格都不叠（含跨格，最小圆心距 ≥ 直径）',
    minPairGap(open) >= FAB_SLOT_SIZE - 1, `最小=${fmt(minPairGap(open))}`);
  check('⑫ 7 格全部落在面板内（越界部分不接收点击）',
    outsideBy(open) <= 0.5, `越界 ${fmt(Math.max(0, outsideBy(open)))}px`);

  const labelled = open.slots.filter((s) => s.label !== null);
  check('⑫ ★ 每一格都有**文字标签**（光有图标，用户得先悬停看 tooltip 才知道是哪个）',
    labelled.length === SLOT_COUNT && open.slots.every((s) => s.labelText.length > 0),
    `带标签 ${labelled.length} / ${SLOT_COUNT}，文字：${open.slots.map((s) => s.labelText || '—').join(' / ')}`);
  check('⑫ 标签在圆的**左侧**（照那张参照图的形态，不是压在圆里）',
    open.slots.every((s) => s.label && s.label.r <= s.l + 0.5),
    open.slots.map((s) => (s.label ? `${fmt(s.label.r)}<${fmt(s.l)}` : 'no-label')).join(' | '));
  check('⑫ 标签与圆**垂直居中对齐**（误差 ≤ 1.5px）',
    open.slots.every((s) => s.label && Math.abs((s.label.t + s.label.b) / 2 - s.cy) <= 1.5),
    open.slots.map((s) => (s.label ? fmt((s.label.t + s.label.b) / 2 - s.cy) : '—')).join(' / '));
  check('⑫ 标签不越出面板左右（伸到面板外面等于看不见）',
    labelOutsideBy(open) <= 0.5, `标签越界 ${fmt(Math.max(0, labelOutsideBy(open)))}px`);
  check('⑫ 标签展开态不透明（不是只有圆出现、标签还藏着）',
    labelled.every((s) => s.labelOpacity >= 0.98),
    `最小 label opacity=${labelled.length === 0 ? '—' : fmt(Math.min(...labelled.map((s) => s.labelOpacity)))}`);
  check('⑬ 顺序对：最上面是页码、最下面是缩小',
    list[0].labelText === '页码' && bottom.labelText === '缩小',
    `最上=${list[0].labelText} 最下=${bottom.labelText}`);
  check('⑬ 上下页相邻，且「上一页」在「下一页」上面（与书的翻页方向一致）',
    Math.abs(list[1].labelText.indexOf('上一页')) === 0 && list[2].labelText === '下一页',
    `第 1/2 格=${list[1].labelText} / ${list[2].labelText}`);

  console.log('\n—— ★ 交互：悬停即展开、越过空隙不闪断、移开才收（0.24.3）——');
  /* 用户原话：「鼠标移到图标上就弹出，不要点击」。
     ★ 页面里挂的是**生产代码的** `createFabHover`（见文件头 `HOVER_RUNTIME`），
       所以这里量的是产品逻辑，不是我在夹具里另抄的一份。
     ★ 三件事分开量，缺一条就漏一种坏法：
         ① 悬停按钮 → 展开（诉求本身）；
         ② 从按钮移向第一格要**经过空隙**，那一刻列不许收（0.23.0 正是因此删掉悬停的）；
         ③ 真的移开之后，宽限期到了要收（否则它永远赖在书页上）。
       ★ ②③ 必须用**短等待**量：宽限期 220ms，而 `probe()` 自带的两个 settle 加起来
         600ms —— 拿它去量只会看到「已经收了」，判据会恒真。 */
  await setHoverGrace();
  await probe({ open: false });
  await unhover();
  const box = await probe({});
  const lowestSlot = byStack(box)[SLOT_COUNT - 1];
  await moveTo(box.fabBtnCenter.cx, box.fabBtnCenter.cy);
  await settle(520);
  const hovered = await fabSnapshot();
  check('⑭ ★ 鼠标**移到按钮上**就展开（不用点）',
    hovered.open && hovered.slots.every((s) => s.visibility === 'visible' && s.opacity >= 0.98),
    `is-open=${hovered.open} 可见格数=${hovered.slots.filter((s) => s.visibility === 'visible').length}`);
  /* ② 空隙：按钮顶边与最下面那格底边之间那几像素 —— 指针在那儿既不在按钮上、
     也不在格子上，正是 0.23.0 收列的那个瞬间。 */
  const gapY = (lowestSlot.b + box.fabBtn.t) / 2;
  await moveTo(box.fabBtnCenter.cx, gapY);
  await settle(90);
  const inGap = await fabSnapshot();
  check('⑭ ★★ 指针停在**按钮与第一格之间的空隙**里，列不许收（这就是宽限期）',
    inGap.open,
    `空隙 y=${fmt(gapY)}（按钮顶 ${fmt(box.fabBtn.t)} / 最下格底 ${fmt(lowestSlot.b)}）is-open=${inGap.open}`);
  /* ③ 走到最上面那格：进入子树 ⇒ 宽限期定时器取消。 */
  const topSlot = byStack(box)[0];
  await moveTo(topSlot.cx, topSlot.cy);
  await settle(140);
  const onTopSlot = await fabSnapshot();
  check('⑭ 走到最上面那一格上，列仍然展开（能点它）',
    onTopSlot.open && onTopSlot.slots.every((s) => s.visibility === 'visible'),
    `is-open=${onTopSlot.open}`);
  /* ④ 真的移开：先量「宽限期还没到」，再量「到了」。
     ★ 前半条正是「宽限期存在」的判据 —— 把宽限期改成 0 它就红。 */
  await moveTo(3, 3);
  await settle(90);
  const justLeft = await fabSnapshot();
  check('⑭ ★ 移开 90ms 后仍在展开（宽限期真的存在，不是瞬间收）',
    justLeft.open, `is-open=${justLeft.open}`);
  await settle(420);
  const leftLong = await fabSnapshot();
  check('⑭ 移开超过宽限期之后收起（不能永远赖在书页上）',
    !leftLong.open && leftLong.slots.every((s) => s.visibility === 'hidden'),
    `is-open=${leftLong.open} 可见格数=${leftLong.slots.filter((s) => s.visibility === 'visible').length}`);
  /* 点击入口仍然在（触屏 / 键盘没有 hover）：类驱动的那一态照旧可量。 */
  const openedByClick = await probe({ open: true });
  check('⑭ 点开这一态仍然成立：7 格可见且可点（触屏与键盘走这条）',
    openedByClick.slots.every((s) => s.visibility === 'visible' && s.pe === 'auto'),
    `可见 ${openedByClick.slots.filter((s) => s.visibility === 'visible').length} / ${SLOT_COUNT}`);
  await probe({ open: false });
  await unhover();

  console.log('\n—— 窄面板（420×420，用户说的「不是全屏」）——');
  const narrow = await probe({ width: NARROW.width, height: NARROW.height, open: true });
  check('⑮ 窄面板里 FAB 贴角改成 10px（容器查询生效）',
    Math.abs((narrow.book.r - narrow.fab.r) - 10) <= 1.5,
    `右边距=${fmt(narrow.book.r - narrow.fab.r)}`);
  check('⑮ 窄面板里 7 格仍全部落在面板内',
    outsideBy(narrow) <= 0.5, `越界 ${fmt(Math.max(0, outsideBy(narrow)))}px`);
  /* ★ 比较基准用**这一组实际算出来的直径**（`stack[0].size`），不是默认 38：
     420×420 这一档里 `fabStack` 已经把直径缩到 36.3，拿 38 去比会永远红一条。 */
  check('⑮ 窄面板里相邻两格仍不叠',
    Math.min(...gapsOf(narrow)) >= narrow.stack[0].size - 1,
    `最小相邻距=${fmt(Math.min(...gapsOf(narrow)))} 直径=${fmt(narrow.stack[0].size)}`);
  check('⑮ 窄面板里标签仍不越界（420 宽够放 4 个字的标签）',
    labelOutsideBy(narrow) <= 0.5, `标签越界 ${fmt(Math.max(0, labelOutsideBy(narrow)))}px`);
  check('⑮ 窄面板里最上面那格仍不压住胶囊',
    Math.min(...narrow.slots.map((s) => s.t)) >= narrow.chrome.b - 1,
    `最上格顶=${fmt(Math.min(...narrow.slots.map((s) => s.t)))} 胶囊底=${fmt(narrow.chrome.b)}`
    + `（topInset=${narrow.topInset} book=${fmt(narrow.book.t)}–${fmt(narrow.book.b)}`
    + ` stage.t=${fmt(narrow.stage.t)} list=${narrow.fabList ? fmt(narrow.fabList.t) : '—'}`
    + ` vars=${narrow.stackVars.join(',')}）`);
  check('⑮ 窄面板里胶囊切成图标版（文字层收起，给书页让位）',
    narrow.pillItems.length === PILL_COUNT && narrow.pillItems.every((item) => !item.spanShown),
    `带文字的开关数=${narrow.pillItems.filter((item) => item.spanShown).length} / ${narrow.pillItems.length}`);
  check('⑮ 切成图标版后六项都在、且都装得进面板',
    narrow.pillItems.length === PILL_COUNT && narrow.pill.l >= narrow.book.l - 0.5
      && narrow.pill.r <= narrow.book.r + 0.5,
    `胶囊 ${fmt(narrow.pill.l)}–${fmt(narrow.pill.r)} / 面板 ${fmt(narrow.book.l)}–${fmt(narrow.book.r)}`);
  await unhover();

  console.log('\n—— 极矮面板（高度不够时自动收缩）——');
  const shortOpen = await probe({ width: 420, height: 240, open: true });
  check('⑯ 240 高：直径/间隙被 fabStack 压缩（不再按 38 + 8 排）',
    shortOpen.stack[0].size < FAB_SLOT_SIZE || gapsOf(shortOpen)[0] < FAB_SLOT_SIZE + FAB_SLOT_GAP - 1,
    `直径=${fmt(shortOpen.stack[0].size)} 间距=${fmt(gapsOf(shortOpen)[0])}`);
  /* ★ 240px 高**不可能**装下完整一列：7 × 26（直径下限）加按钮与顶部预留之后远超 240。
     所以这里只钉「收缩生效」与「不叠」——「装得下」由 420 那一组（判据 ⑮）负责。
     写「必须装得下」会得到一条永远红的假判据（旧版在 200px 宽上踩过同一个坑）。 */
  check('⑯ 240 高：压缩之后相邻两格仍不叠',
    minPairGap(shortOpen) >= shortOpen.stack[0].size - 1,
    `最小间距=${fmt(minPairGap(shortOpen))} 直径=${fmt(shortOpen.stack[0].size)}`);
  const tinyOpen = await probe({ width: 200, height: 200, open: true });
  /* ★ 200×200 时不查「装得下」：7 个 26px 的圆（下限）+ 按钮 + 留白需要 244px 高，
     200px 在物理上放不下。写了就是一条永远红的假判据（旧版在 200px 宽上也踩过这个）。
     这里只钉住「确实收缩了」—— 否则上一条判据在任何尺寸下都能过。 */
  check('⑯ 200×200：收缩机制真的生效（直径压到下限 26px）',
    tinyOpen.stack[0].size <= 26.5, `直径=${fmt(tinyOpen.stack[0].size)}`);
  check('⑯ 200×200：收缩后相邻圆心距 ≥ 收缩后的直径（尺寸与位置同源）',
    minPairGap(tinyOpen) >= tinyOpen.stack[0].size - 1,
    `间距=${fmt(minPairGap(tinyOpen))} 直径=${fmt(tinyOpen.stack[0].size)}`);
  await unhover();

  console.log('\n—— 沉浸式阅读（只留书页 + 书架列收掉）——');
  const deepOpen = await hoverFab({ immersive: true, open: true });
  await unhover();
  const deep = await probe({ immersive: true });
  check('⑰ 沉浸态：顶部胶囊不占位（display: none）',
    deep.chromeDisplay === 'none', `display=${deep.chromeDisplay}`);
  check('⑰ 沉浸态：元信息行不占位', deep.metaDisplay === 'none', `display=${deep.metaDisplay}`);
  check('⑰ 沉浸态：FAB 隐到全透明（只留书页）',
    deep.fabOpacity <= 0.02, `opacity=${deep.fabOpacity}`);
  check('⑰ 沉浸态：书页可用高度变大（同样的面板里多出一截正文）',
    (deep.stage.h - deep.stagePadTop) > (wide.stage.h - wide.stagePadTop),
    `沉浸可用高=${fmt(deep.stage.h - deep.stagePadTop)} 常规=${fmt(wide.stage.h - wide.stagePadTop)}`);
  check('⑰ 沉浸态里鼠标回到右下角，FAB 恢复不透明（唯一可见的出口）',
    deepOpen.fabOpacity >= 0.98, `opacity=${deepOpen.fabOpacity}`);
  check('⑰ 沉浸态里列仍能展开（不能因为「只留书页」把翻页也锁死）',
    deepOpen.slots.every((s) => s.opacity >= 0.98) && outsideBy(deepOpen) <= 0.5,
    `最小 opacity=${fmt(Math.min(...deepOpen.slots.map((s) => s.opacity)))}`);
  check('⑱ ★ 沉浸态：**书架那一列**不占位（用户要「左边两列都不显示」）',
    deep.sidebarDisplay === 'none' && deep.sidebar.w === 0,
    `display=${deep.sidebarDisplay} 宽=${fmt(deep.sidebar.w)}`);
  check('⑱ 沉浸态：分隔条也不占位（不然书页右边留着一条 1px 的空杠）',
    deep.resizeDisplay === 'none', `display=${deep.resizeDisplay}`);
  check('⑱ 沉浸态：阅读区吃满整个工作区宽',
    Math.abs(deep.reader.w - deep.workarea.w) <= 1.5,
    `阅读区=${fmt(deep.reader.w)} 工作区=${fmt(deep.workarea.w)}`);
  check('⑱ 常规态对照：书架列是占位的（否则上一条判据在「一直都没有列」时也会绿）',
    wide.sidebarDisplay !== 'none' && wide.sidebar.w > 100,
    `display=${wide.sidebarDisplay} 宽=${fmt(wide.sidebar.w)}`);

  console.log('\n—— 书页配色 · 亮度 ——');
  const paper = await probe({ tint: 'paper' });
  const sepia = await probe({ tint: 'sepia' });
  const mint = await probe({ tint: 'mint' });
  const night = await probe({ tint: 'night' });
  check('⑲ 原色：画布无滤镜', paper.canvasFilter === 'none', `filter=${paper.canvasFilter}`);
  check('⑲ 护眼：画布走 sepia 系滤镜', sepia.canvasFilter.includes('sepia'), `filter=${sepia.canvasFilter}`);
  /* 薄荷是**白天**的护眼档：只偏色相、不反相。反相会让彩色插图变负片。 */
  check('⑲ 薄荷：画布偏色相但不反相',
    /hue-rotate/.test(mint.canvasFilter) && !/invert/.test(mint.canvasFilter),
    `filter=${mint.canvasFilter}`);
  check('⑲ 薄荷：舞台底色偏绿，且比原色暗一点（不刺眼）',
    mint.stageLuma > 200 && mint.stageLuma < paper.stageLuma,
    `薄荷亮度=${mint.stageLuma} 原色亮度=${paper.stageLuma}`);
  check('⑲ 夜间：画布反相 + 色相回正',
    /invert/.test(night.canvasFilter) && /hue-rotate/.test(night.canvasFilter),
    `filter=${night.canvasFilter}`);
  check('⑲ 夜间：舞台底色明显变暗（不出现「黑纸白边」）',
    night.stageLuma < 60 && paper.stageLuma > 200,
    `夜间亮度=${night.stageLuma} 原色亮度=${paper.stageLuma}`);
  check('⑲ 夜间：胶囊底色也跟着变暗（黑纸上一块白板就是手电筒）',
    night.pillLuma >= 0 && night.pillLuma < 90 && paper.pillLuma > 200,
    `胶囊底亮度：夜间=${night.pillLuma} 原色=${paper.pillLuma}`);
  check('⑲ 夜间：扇出的格底也跟着变暗（黑纸上 7 块白圆片更刺眼）',
    night.slots[0].bgLuma >= 0 && night.slots[0].bgLuma < 80 && paper.slots[0].bgLuma > 200,
    `扇出格底亮度：夜间=${night.slots[0].bgLuma} 原色=${paper.slots[0].bgLuma}`);

  check('⑳ 亮度 100%：舞台滤镜是 brightness(1)',
    /brightness\(1\)/.test(paper.stageFilter), `filter=${paper.stageFilter}`);
  const dim = await probe({ tint: 'paper', brightness: 0.7 });
  check('⑳ 亮度 70%：真的落到舞台的 filter 上（书页与四周底色一起变暗）',
    /brightness\(0\.7\)/.test(dim.stageFilter), `filter=${dim.stageFilter}`);
  check('⑳ 亮度只作用在舞台：FAB 自己没被滤镜碰到（它是控件，不是书页）',
    dim.fabFilter === 'none', `FAB filter=${dim.fabFilter}`);

  console.log('\n—— 配色面板 ——');
  const palette = await probe({ palette: true });
  check('㉑ 配色面板从**配色那颗按钮的正下方**展开（不是从整颗胶囊中间掉下来）',
    palette.paletteBox.t >= palette.pillTint.b + 4,
    `面板顶=${fmt(palette.paletteBox.t)} 配色按钮底=${fmt(palette.pillTint.b)}`);
  check('㉑ 配色面板右缘与配色按钮右缘对齐（≤ 1.5px）',
    Math.abs(palette.paletteBox.r - palette.pillTint.r) <= 1.5,
    `面板右=${fmt(palette.paletteBox.r)} 按钮右=${fmt(palette.pillTint.r)}`);
  check('㉑ 四个色块一行放得下（宽 208）',
    Math.abs(palette.paletteBox.w - 208) < 1.5, `面板宽=${fmt(palette.paletteBox.w)}`);
  check('㉑ 配色面板不越出面板左右',
    palette.paletteBox.l >= palette.book.l - 0.5 && palette.paletteBox.r <= palette.book.r + 0.5,
    `面板 ${fmt(palette.paletteBox.l)}–${fmt(palette.paletteBox.r)} / 书页 ${fmt(palette.book.l)}–${fmt(palette.book.r)}`);
  /* ★ 这一条是看截图才发现的真 bug：几何全对，但面板被**元信息行盖住**，
     只有最上面那半截滑块露出来，「颜色」与四个色块根本看不见。 */
  check('㉑ 配色面板画在元信息行**之上**（中心与底部色块行都命中面板自己，不是被 meta 盖住）',
    palette.paletteHit.mid === true && palette.paletteHit.low === true,
    `中心命中面板=${palette.paletteHit.mid} 色块行命中面板=${palette.paletteHit.low}（实际命中：${palette.paletteHit.lowWho}）`);

  console.log('\n—— 划线 / 笔记面板 ——');
  const bare = await probe({});
  const marksProbe = await probe({ marks: true });
  check('㉒ 面板宽 306（与目录那一栏同宽）', Math.abs(marksProbe.marks.w - 306) < 1.5,
    `宽=${marksProbe.marks.w}`);
  check('㉒ 面板内容不横向溢出（卡片右边不被裁）',
    marksProbe.marksScrollWidth <= marksProbe.marksClientWidth + 1,
    `内容=${marksProbe.marksScrollWidth} 外框=${marksProbe.marksClientWidth}`);
  check('㉒ 打开面板后正文仍有位置（舞台不被压没）',
    marksProbe.stage.w > 400 && marksProbe.stage.w < bare.stage.w,
    `舞台：开面板=${marksProbe.stage.w} 不开=${bare.stage.w}`);

  console.log('\n—— ㉓ 阅读区定位：开着伴读时按钮仍贴在书页区 ——');
  /* ★ 用户原话：「悬浮按钮要始终显示在电子书阅读的区域。」
     0.23.0 及之前它是 `.npr-book` 的直接子节点 ⇒ 钉在**整个面板**右下角，
     一开伴读就跑到伴读那一栏的角上（看着像伴读的按钮）。 */
  const withCompanion = await probe({ companion: true, open: true });
  check('㉓ 伴读确实占了右侧一栏（否则下一条在「伴读没开」时也会绿）',
    withCompanion.companion.w > 200 && withCompanion.stage.w < withCompanion.book.w - 200,
    `伴读宽=${fmt(withCompanion.companion.w)} 书页区宽=${fmt(withCompanion.stage.w)} 面板宽=${fmt(withCompanion.book.w)}`);
  check('㉓ ★ 按钮贴在**书页区**右下角（距书页区右/下各 14px）',
    Math.abs((withCompanion.stage.r - withCompanion.fab.r) - FAB_MARGIN) <= 1.5
    && Math.abs((withCompanion.stage.b - withCompanion.fab.b) - FAB_MARGIN) <= 1.5,
    `距书页区右=${fmt(withCompanion.stage.r - withCompanion.fab.r)} 下=${fmt(withCompanion.stage.b - withCompanion.fab.b)}`
    + `｜距面板右=${fmt(withCompanion.book.r - withCompanion.fab.r)}（若等于 14 说明它还在面板角上）`);
  check('㉓ 按钮整颗在书页区内（不压在伴读那一栏上）',
    withCompanion.fab.r <= withCompanion.stage.r + 0.5 && withCompanion.fab.l >= withCompanion.stage.l - 0.5,
    `按钮=${fmt(withCompanion.fab.l)}–${fmt(withCompanion.fab.r)} 书页区=${fmt(withCompanion.stage.l)}–${fmt(withCompanion.stage.r)}`);
  check('㉓ 展开的 7 格也不越出书页区（整列跟着收窄）',
    outsideBy(withCompanion) <= 0.5, `越界 ${fmt(Math.max(0, outsideBy(withCompanion)))}px`);
  await probe({ companion: false });

  console.log('\n—— ㉔ 纸色覆盖层：护眼要把 PDF 的纸一起染上 ——');
  /* ★ 用户原话：「护眼颜色选择为什么改变不了电子书内容的背景，也要同步改变。」
     PDF 的白纸是**像素**，`filter` 只能整体偏色（sepia(.3) 很淡，白纸看着还是白的）；
     真正让「纸」变色的是这一层乘算覆盖。 */
  const channels = (css) => (css.match(/[0-9.]+/g) || []).map(Number);
  const isTransparent = (css) => css === 'transparent' || (css.startsWith('rgba') && channels(css)[3] === 0);
  check('㉔ 原色档：覆盖层透明（原色就是白纸）',
    isTransparent(paper.tintBg), `bg=${paper.tintBg}`);
  check('㉔ 覆盖层与画布**完全重合**（差半像素就会露一圈白边）',
    Math.abs(paper.tint.w - paper.canvas.w) <= 0.5 && Math.abs(paper.tint.h - paper.canvas.h) <= 0.5
    && Math.abs(paper.tint.l - paper.canvas.l) <= 0.5 && Math.abs(paper.tint.t - paper.canvas.t) <= 0.5,
    `覆盖层 ${fmt(paper.tint.w)}×${fmt(paper.tint.h)} @${fmt(paper.tint.l)},${fmt(paper.tint.t)}｜`
    + `画布 ${fmt(paper.canvas.w)}×${fmt(paper.canvas.h)} @${fmt(paper.canvas.l)},${fmt(paper.canvas.t)}`);
  check('㉔ 覆盖层不吃点击（否则书页上没法拖选）',
    paper.tintPe === 'none', `pointer-events=${paper.tintPe}`);
  check('㉔ 混合方式是 multiply（普通半透明覆盖会把黑字一起提亮）',
    paper.tintBlend === 'multiply', `mix-blend-mode=${paper.tintBlend}`);
  const sepiaCh = channels(sepia.tintBg);
  check('㉔ ★ 护眼档：覆盖层是**不透明的暖色**（r > g > b，白纸会变成米黄）',
    sepiaCh.length >= 3 && (sepiaCh.length < 4 || sepiaCh[3] >= 0.99)
    && sepiaCh[0] > sepiaCh[1] && sepiaCh[1] > sepiaCh[2],
    `bg=${sepia.tintBg}`);
  const mintCh = channels(mint.tintBg);
  check('㉔ 薄荷档：覆盖层偏绿（g 最大），且不是暖色',
    mintCh.length >= 3 && mintCh[1] > mintCh[0] && mintCh[1] > mintCh[2],
    `bg=${mint.tintBg}`);
  check('㉔ 夜间档：不叠覆盖层（黑纸再乘深色会压成死黑，白字反而不清）',
    isTransparent(night.tintBg), `bg=${night.tintBg}`);

  console.log('\n—— 反向对照（每组都必须变红）——');
  const brokenTb = await probe({ neutralize: true });
  check('★ ① 把拖动条改回 44px：判据 ① 必须红',
    parseFloat(brokenTb.tbHeight) > 12, `高=${brokenTb.tbHeight}`);
  const brokenMeta = await probe({ breakMeta: true });
  check('★ ② 把元信息行改回浮动：判据 ② 必须红（它压在书页上）',
    brokenMeta.meta.b > brokenMeta.stage.t + 1,
    `元信息底=${fmt(brokenMeta.meta.b)} 舞台顶=${fmt(brokenMeta.stage.t)}`);
  const brokenChrome = await probe({ breakChrome: true });
  check('★ ③ 把胶囊挪到面板底部：判据 ③「在顶部」必须红',
    brokenChrome.pill.t >= brokenChrome.book.t + 60,
    `胶囊顶=${fmt(brokenChrome.pill.t)} 面板顶=${fmt(brokenChrome.book.t)}`);
  const brokenFab = await probe({ breakFab: true });
  check('★ ⑤ 把 FAB 挪到左上角：判据 ⑤ 必须红',
    Math.abs((brokenFab.book.r - brokenFab.fab.r) - FAB_MARGIN) > 1.5,
    `右边距=${fmt(brokenFab.book.r - brokenFab.fab.r)}`);
  /* ★ 先写坏规则、等过渡跑完、再读一次。不等的话读到的是**起点值**
     （opacity 还在 0、位置还在圆心），于是反向对照会假绿 ——
     它证明的将是「什么都没变」。同类判据通用陷阱，见文件头。 */
  await probe({ forceOpen: true });
  await settle();
  const stillOpen = await probe({ forceOpen: true });
  check('★ ⑥ 强制列常显：判据 ⑥「收起态」必须红',
    stillOpen.slots.some((s) => s.visibility === 'visible' && s.opacity >= 0.98),
    `可见的格数=${stillOpen.slots.filter((s) => s.visibility === 'visible').length}`);
  await unhover();
  const brokenStack = await probe({ breakStack: true, open: true });
  check('★ ⑨ 把 7 格的偏移清零（全叠在按钮上）：判据 ⑧⑨ 必须红',
    stackErrorOf(brokenStack) > 4 || Math.max(...offsetsOf(brokenStack).map((o) => Math.hypot(o.dx, o.dy))) < 4,
    `逐格偏差=${fmt(stackErrorOf(brokenStack))}px 最大偏移=${fmt(Math.max(...offsetsOf(brokenStack).map((o) => Math.hypot(o.dx, o.dy))))}`);
  const brokenSide = await probe({ width: NARROW.width, height: NARROW.height, breakSideways: true, open: true });
  check('★ ⑫ 把整列推到面板左边之外：判据 ⑫「不越界」必须红',
    outsideBy(brokenSide) > 1, `越界 ${fmt(outsideBy(brokenSide))}px`);
  const brokenLabel = await probe({ breakLabel: true, open: true });
  check('★ ⑫ 把文字标签藏掉：判据 ⑫「每一格都有标签」必须红',
    brokenLabel.slots.every((s) => s.label === null || s.label.w === 0),
    `有标签的格数=${brokenLabel.slots.filter((s) => s.label && s.label.w > 0).length}`);
  /* ★ ⑭ 的两条对照：一条打「宽限期」，一条打「悬停入口」。
     ★ 为什么必须两条：宽限期没了，悬停照样能展开（①仍绿），只有「空隙里不闪断」会红；
     入口没了，宽限期再长也白搭。一条对照只能证明其中一半。
     ★ 空隙坐标必须在**展开态**量：收起时 7 格全叠在按钮位置上（transform 回到
       translate(0,0)），最下格的底边根本没有「空隙」可言 —— 算出来的点落在按钮内部，
       指针一次都没离开，判据就会以为「宽限期 0 也能撑住」。实测红过这一次。 */
  await setHoverGrace(0);
  await probe({ open: false });
  await unhover();
  const gapBox = await probe({});
  await moveTo(gapBox.fabBtnCenter.cx, gapBox.fabBtnCenter.cy);
  await settle(260);
  const gapOpen = await probe({});
  const gapLow = byStack(gapOpen)[SLOT_COUNT - 1];
  await moveTo(gapOpen.fabBtnCenter.cx, (gapLow.b + gapOpen.fabBtn.t) / 2);
  await settle(90);
  const gapNoGrace = await fabSnapshot();
  check('★ ⑭ 把宽限期改成 0：判据 ⑭「空隙里不许收」必须红',
    !gapNoGrace.open,
    `宽限期 0 时空隙里 is-open=${gapNoGrace.open}（这就是 0.23.0 收列的那一瞬间）`);
  await setHoverGrace();
  /* 摘掉悬停监听 = 0.23.0 的「只认点击」：悬停不该再展开。 */
  await evaluateRaw('(window.__fabUnbind(), true)');
  await probe({ open: false });
  await unhover();
  const unbindBox = await probe({});
  await moveTo(unbindBox.fabBtnCenter.cx, unbindBox.fabBtnCenter.cy);
  await settle(420);
  const unbound = await fabSnapshot();
  check('★ ⑭ 摘掉悬停监听（只认点击）：判据 ⑭「悬停即展开」必须红',
    !unbound.open, `is-open=${unbound.open}`);
  await moveTo(3, 3);
  await setHoverGrace();
  /* ★ ㉓ 的对照：让 `.npr-book-view` 退回 static ⇒ 定位基准回到 `.npr-book-main`，
     按钮落回整个面板的角上（= 0.23.0 的形态）。 */
  const brokenAnchor = await probe({ companion: true, open: true, breakFabAnchor: true });
  check('★ ㉓ 让阅读区那层退回 static：判据 ㉓「贴书页区」必须红',
    Math.abs((brokenAnchor.stage.r - brokenAnchor.fab.r) - FAB_MARGIN) > 100,
    `距书页区右=${fmt(brokenAnchor.stage.r - brokenAnchor.fab.r)}（应当≈伴读宽）`);
  await probe({ companion: false });
  /* ★ ㉔ 的对照：把覆盖层底色改成透明 —— 纸又变回白的。 */
  const brokenTint = await probe({ tint: 'sepia', breakTint: true });
  const brokenCh = (brokenTint.tintBg.match(/[0-9.]+/g) || []).map(Number);
  check('★ ㉔ 把覆盖层底色改成透明：判据 ㉔「护眼是暖色」必须红',
    brokenCh.length === 0 || (brokenCh.length >= 4 && brokenCh[3] === 0),
    `bg=${brokenTint.tintBg}`);
  await unhover();
  const brokenSize = await probe({ width: 420, height: 240, breakSize: true, open: true });
  check('★ ⑯ 把直径写死 38px（不跟随收缩）：判据 ⑯「不叠」必须红',
    minPairGap(brokenSize) < 38 - 0.5,
    `最小间距=${fmt(minPairGap(brokenSize))} 直径=${fmt(brokenSize.stack[0].size)}`);
  const brokenFit = await probe({ width: TINY.width, height: TINY.height, overshoot: true, open: true });
  check('★ ⑫ 极窄面板里强行用 190px 偏移：判据 ⑫「装得下」必须红',
    outsideBy(brokenFit) > 1, `越界 ${fmt(outsideBy(brokenFit))}px`);
  const brokenShelf = await probe({ immersive: true, keepShelf: true });
  check('★ ⑱ 把书架列的隐藏规则注掉：判据 ⑱ 必须红',
    brokenShelf.sidebarDisplay !== 'none' && brokenShelf.sidebar.w > 100,
    `沉浸态下书架列 display=${brokenShelf.sidebarDisplay} 宽=${fmt(brokenShelf.sidebar.w)}`);
  const brokenZ = await probe({ palette: true, breakZ: true });
  check('★ ㉑ 胶囊那一行退回 static：判据 ㉑「面板画在元信息行之上」必须红',
    brokenZ.paletteHit.mid === false || brokenZ.paletteHit.low === false,
    `中心命中面板=${brokenZ.paletteHit.mid} 色块行命中面板=${brokenZ.paletteHit.low}（实际命中：${brokenZ.paletteHit.lowWho}）`);
  await unhover();

  if (SHOT !== '') {
    /** 裁到面板外框（或指定元素）+ 2 倍采样：交付图上不该出现夹具视口留下的白边。 */
    const capture = async (box, suffix, clipTo) => {
      const pad = 6;
      const frame = clipTo === 'workarea' ? box.workarea : box.book;
      const image = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: Math.max(0, frame.l - pad),
          y: Math.max(0, frame.t - pad),
          width: frame.w + pad * 2,
          height: frame.h + pad * 2,
          scale: 2,
        },
      });
      if (!image.result?.data) return;
      const file = SHOT.replace(/\.png$/, `${suffix}.png`);
      writeFileSync(file, Buffer.from(image.result.data, 'base64'));
      console.log(`\n截图：${file}`);
    };
    /* 宽面板的四种配色 + 四种状态 + 窄面板的展开态。
       ★ `-fab` 那张是「点开后向上摊开的一列」，每格都是「圆图标 + 左侧文字标签」。
       ★ `-companion`（0.24.3）是「按钮钉在阅读区」的正脸：右侧开着 348px 的伴读栏，
         按钮仍贴**书页区**右下角 —— 0.23.0 及之前它会跑到伴读的角上。
       ★ 悬停那张**单独跑**（见下面）：它要的不是「类加上去会展开」，而是
         「指针移上去就展开」，所以必须真的把指针放到按钮上再截。 */
    const shots = [
      [{ tint: 'paper' }, '-paper'],
      [{ tint: 'sepia' }, '-sepia'],
      [{ tint: 'mint' }, '-mint'],
      /* 夜间这张用展开态：一张图同时看「黑纸不刺眼」与「夜间那 7 个标签也变暗」。 */
      [{ tint: 'night', open: true }, '-night'],
      [{ tint: 'paper', open: true }, '-fab'],
      [{ tint: 'paper', open: true, companion: true }, '-companion'],
      [{ tint: 'paper', palette: true }, '-palette'],
      [{ tint: 'paper', marks: true }, '-marks'],
      /* ★ 沉浸这张裁到**工作区**而不是书页：要一眼看出「书架那一列不见了」，
         裁到 `.npr-book` 的话正好把它裁在外面，图上看不出任何变化。 */
      [{ tint: 'paper', immersive: true }, '-immersive-workspace'],
      [{ tint: 'paper', open: true, width: 480, height: 640 }, '-narrow'],
    ];
    for (const [extra, suffix] of shots) {
      const box = await probe({ width: SHOT_WIDTH, ...extra });
      await settle(340);
      await capture(box, suffix, extra.immersive ? 'workarea' : undefined);
    }
    /* ★ 悬停展开的证据图：指针落在按钮上（没有写 is-open），列自己展开。
       这一张与 `-fab` 的区别就是**谁把类加上去的** —— 图上看不出差别，但
       它证明的是用户诉求本身（「鼠标移到图标上就弹出，不要点击」）。 */
    await unhover();
    await probe({ open: false });
    const hoverBox = await probe({ width: SHOT_WIDTH });
    await moveTo(hoverBox.fabBtnCenter.cx, hoverBox.fabBtnCenter.cy);
    await settle(560);
    await capture(hoverBox, '-fab-hover');
    await unhover();
  }
} finally {
  try { ws.close(); } catch { /* 已断开 */ }
  chrome.kill('SIGKILL');
  server.close();
}

if (failed > 0) { console.error(`\n${failed} 条判据失败`); process.exit(1); }
console.log('\n全部通过');
