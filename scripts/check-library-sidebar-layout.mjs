#!/usr/bin/env node
/**
 * 书架侧栏的**真几何**核对：两件事。
 *
 * ① 搜索系统到底是不是「`搜索框 │ 分类` / `结果行 │ 排序`」那个 **2×2 网格**
 *    （0.9.5 的改动）；
 * ② 「弃读」行两枚动作胶囊之间到底有没有 6px（0.9.4 的改动）——
 *    `gap: 2px` + 补的 `margin-left: 4px`，只看 computed `gap` 会把它读成 2px。
 *
 * ★ 为什么源码断言不够：源码里 `npr-lib-controls` 排在 `npr-filters` 后面，只说明
 *   **文档顺序**对，不说明**画出来的位置**对。CSS 至少有三种办法让顺序与位置分叉，
 *   而且全都不报错：
 *     - `order`（flex / grid 子项排序）；
 *     - `flex-direction: column-reverse` / `row-reverse`；
 *     - 把元素 `position: absolute` 挪到别处。
 *   本项目为「文本层算术断言失明」踩过一次（`order: .5` 被静默丢弃那条）。
 *   ⇒ 这里用真 Chrome 量 `getBoundingClientRect()`，量的是**像素**。
 *
 * ★ 量的是「可见位置」，不是「DOM 下标」：拿 `children` 的下标去比较，会在
 *   `order` 生效时给出与眼睛相反的答案（恒真假绿）。
 * ★ 「谁和谁同一行」一律比**中线**（`(top+bottom)/2`），不比顶边：网格里
 *   `align-items: center` 会把 19px 的文字和 28px 的控件各自居中 —— 比顶边会差 4.4px，
 *   判据就与眼睛相反了。
 *
 * ★ 顺带出「0.9.4 三行 / 0.9.5 两行 / 0.9.4 弃读行」的对照图，并在出图后
 *   **自证 PNG 宽高**与量测用的视口一致 —— 本项目踩过「交付图被另一次调用静默
 *   换成更矮的裁切」。
 *
 * ★ 这里**没有**「工具栏里不许有搜索框」那条判据：那是**结构**事实，源码字符串断言
 *   就能答，而且 `test/library-app.test.mjs` 已经配了反向对照。几何脚本只守
 *   「源码答不了」的那一半 —— 每加一条没有反向对照的判据，就多一条没人信的空话。
 *
 * 运行：node scripts/check-library-sidebar-layout.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 Chrome 不可用（**不静默跳过**）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Chrome 候选路径。找不到就**报错退出**，绝不「跳过」。 */
const CHROME_CANDIDATES = [
  process.env.NPIE_CHROME,
  '/Users/habhy/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome。设 NPIE_CHROME=<可执行文件> 再跑。候选：');
  for (const p of CHROME_CANDIDATES) console.error(`  ${p}`);
  process.exit(2);
}

// ---- 1. CSS 与宿主令牌从**真源码**里取 -------------------------------------
const readerSrc = readFileSync(join(pluginRoot, 'src/client/ReaderPage.jsx'), 'utf8');
const cssStart = readerSrc.indexOf('const PANEL_CSS = `');
const cssEnd = readerSrc.indexOf('`;', cssStart);
if (cssStart < 0 || cssEnd < cssStart) throw new Error('抽 PANEL_CSS 失败（边界切错了）');
const PANEL_CSS = readerSrc.slice(cssStart + 'const PANEL_CSS = `'.length, cssEnd);
const REFINEMENTS = readFileSync(join(pluginRoot, 'src/client/refinements.css'), 'utf8');
for (const anchor of ['.npr-sidebar{', '.npr-sidebar-toolbar{']) {
  if (!PANEL_CSS.includes(anchor)) throw new Error(`PANEL_CSS 里没有 ${anchor} —— 抽错了`);
}
for (const anchor of [
  '.npr-lib-controls {',
  '.npr-lib-row {',
  '.npr-lib-row > .npr-lib-search, .npr-lib-row > .npr-status { flex: 1 1 0;',
  '.npr-lib-row > .npr-lib-dir, .npr-lib-row > .npr-lib-sort { flex: 0 0 auto; }',
  '.npr-lib-controls .npr-status { padding: 0; }',
]) {
  if (!REFINEMENTS.includes(anchor)) throw new Error(`refinements.css 里没有 ${anchor} —— 抽错了`);
}
/**
 * ★ 「改动前」那两列必须**真的是改动前的**：旧结构如果还留在真样式表里，
 *   那 `#grid` / `#before` 与 `#after` 的差别就不止这一次改动
 *   （本项目踩过：HEAD 已含修复 ⇒ 两张一模一样的对照图）。
 */
for (const gone of [
  '.npr-lib-searchbar {',                       // 0.9.4 的三行壳
  '.npr-lib-selects {',                         // 0.9.4 的「分类 + 排序」壳
  '.npr-lib-controls.is-single',                // 0.9.5 的阅读页单列（两行独立后不需要了）
  'grid-template-areas: "search dir"',          // 0.9.5 的具名区域网格
]) {
  if (REFINEMENTS.includes(gone)) {
    throw new Error(`refinements.css 里还有 ${gone} —— 旧结构没删干净，对照列不成立`);
  }
}

/** 宿主令牌（浅色）。全部 `--npr-*` 都由它们派生，缺一个就会毒化成空值。 */
const HOST = `:root, body {
  --dsw-alias-bg-base: #ffffff; --dsw-alias-bg-layer-1: #f7f8f9;
  --dsw-alias-bg-layer-2: #f1f2f4; --dsw-alias-bg-layer-3: #ffffff;
  --dsw-alias-bg-mask-1: rgba(15,17,21,.4);
  --dsw-alias-label-primary: #0f1115; --dsw-alias-label-secondary: #61666b;
  --dsw-alias-label-tertiary: #81858c;
  --dsw-alias-border-l1: #e6e8ea; --dsw-alias-border-l2: #d5d8dc;
  --dsw-alias-interactive-bg-hover: #f1f2f4; --dsw-alias-brand-primary: #3d58e0;
  --dsw-alias-state-error-primary: #d92d20;
  --dsw-focus-ring-width: 1px; --dsw-focus-ring-color: #3d58e0;
}`;

// ---- 2. 夹具：两套侧栏（三行旧结构 / 两行新网格）+ 一条「弃读」行 ------------
/**
 * ★ 两套都用**真实的类名**搭，不自己写颜色 / 间距：那样量到的是「我以为的取值」，
 *   而不是组件真的取了什么。旧结构那几条 0.9.4 的声明用 `#before` 作用域补回来
 *   （见 `BEFORE_CSS`，逐字抄自 0.9.4），所以 `#before` 与 `#after` 的差别
 *   **只有**这一次改动本身。
 *
 * ★ 第三列是一条**真的**「弃读」行（两个动作），用来量判据 ⑩ 的两枚胶囊间距。
 *   它**必须放在侧栏之外**：侧栏宽是固定的（`.col .npr-sidebar{width:320px}`），
 *   但侧栏里的 `.npr-list` 被 `overflow:hidden` 裁着 —— 把行塞进列表就既量不准
 *   也看不见。代价是页面变宽，所以视口是 1040（三列 320px，两列侧栏一个像素没动）。
 */
const VIEWSWITCH = '<div class="npr-viewswitch">'
  + '<button type="button" aria-pressed="false">R</button>'
  + '<button type="button" aria-pressed="true">B</button>'
  // ★ 2026-10-26 加了第三个（日记）。夹具必须跟着长：这一条量的正是「工具栏还剩多少
  //   宽度给频道名」，少画一个按钮就等于按一个更宽松的世界去判「放得下」。
  + '<button type="button" aria-pressed="false">D</button></div>';
const TABS = '<div class="npr-libtabs" role="group">'
  + '<button type="button" aria-pressed="false">阅读</button>'
  + '<button type="button" aria-pressed="true">书架</button></div>';
const FILTERS = '<div class="npr-filters" role="group">'
  + '<button type="button" aria-pressed="true">全部</button>'
  + '<button type="button" aria-pressed="false">已加入阅读（3）</button></div>';
const TOOLBAR = (scope) => `<div class="npr-sidebar-toolbar" data-window-drag id="${scope}-toolbar">
    ${VIEWSWITCH}
    <button type="button" class="npr-icon npr-lib-refresh" id="${scope}-refresh">⟳</button>
    <button type="button" class="npr-icon npr-settings-button" id="${scope}-gear">⚙</button>
  </div>`;

/**
 * ★★ 三套夹具都用**最坏情况**的取值，不是某一次碰巧看到的样子 —— 判据要按**上限**立：
 *   · 分类：实测 8 个真实分类里最长的标签（`系列丛书全套（1419）`）；
 *   · 来源 + 分类：0.20.4 起下拉里装的是「源名 · 分类」，最坏情况是
 *     `网盘 · E书拾取 · 系列丛书全套（1419）`（源名是用户起的，长度不可控）；
 *   · 排序：`SORTS` 里最长的选项（`最近在读`）；
 *   · 结果行：两侧都取满 4 位数（`2634 / 2634 本 · 已在阅读 2634`）——
 *     `added` 理论上可以等于总数，取上限才叫「保证单行」。
 */
const DIR_LONGEST = '系列丛书全套（1419）';
/**
 * 0.20.4 起「分类」下拉变成「来源 ▸ 分类」，选项文字前面多了一段源名
 * （见 `bookScopes` 与 `LibraryApp.jsx` 里那个 `<optgroup>`）。
 * ★ 这一项**必须**进夹具：不加宽度上限时它会把搜索框挤到 90px 以下，
 *   而那正是判据 ⑭ 要量的东西 —— 夹具里不出现它，判据就量不到真实风险。
 */
const SOURCE_LONGEST = `网盘 · E书拾取 · ${DIR_LONGEST}`;
/**
 * 来源/分类下拉的宽度上限，与 `refinements.css` 里 `.npr-lib-dir select{max-width:168px}`
 * 是**同一条判据的两半**：改一处必须改两处，否则判据 ⑭ 会当场红（这是有意的）。
 */
const DIR_MAX = 176;
const SORT_LONGEST = '最近在读';
const STATUS_LONGEST = '2634 / 2634 本 · 已在阅读 2634';

/** 0.9.4：**三行** —— 搜索框独占一行，分类 + 排序一行，结果一行。 */
const BEFORE = `<aside class="npr-sidebar" id="before">
  ${TOOLBAR('before')}
  ${TABS}
  ${FILTERS}
  <div class="npr-lib-searchbar" id="before-searchbar">
    <input class="npr-lib-search" id="before-search" type="search" placeholder="搜索书名 / 丛书…">
    <div class="npr-lib-selects">
      <label><span class="npr-visually-hidden">分类</span><select id="before-dir"><option>${DIR_LONGEST}</option></select></label>
      <label><span class="npr-visually-hidden">排序</span><select id="before-sort"><option>${SORT_LONGEST}</option></select></label>
    </div>
  </div>
  <div class="npr-status" id="before-status">${STATUS_LONGEST}</div>
  <div class="npr-list" id="before-list"></div>
</aside>`;

/**
 * 0.9.5：**两行网格** —— `搜索框 │ 分类` / `结果行 │ 排序`，但两行**共用列**
 * （`grid-template-columns: 1fr 1fr`）。★ 这一列是 0.9.6 的「改动前」：
 * 右列必须同时容下分类与排序 ⇒ 右列宽 = 分类要的宽 ⇒ 结果行只剩一半，
 * 于是它的文字**折成两行**（用户实测截图看到的就是这个）。
 */
const GRID095 = `<aside class="npr-sidebar" id="grid">
  ${TOOLBAR('grid')}
  ${TABS}
  ${FILTERS}
  <div class="npr-lib-controls" id="grid-controls">
    <input class="npr-lib-search" id="grid-search" type="search" placeholder="搜索书名 / 丛书…">
    <label class="npr-lib-dir"><span class="npr-visually-hidden">分类</span><select id="grid-dir"><option>${DIR_LONGEST}</option></select></label>
    <div class="npr-status" id="grid-status">${STATUS_LONGEST}</div>
    <label class="npr-lib-sort"><span class="npr-visually-hidden">排序</span><select id="grid-sort"><option>${SORT_LONGEST}</option></select></label>
  </div>
  <div class="npr-list" id="grid-list"></div>
</aside>`;

/**
 * 0.9.6：**两行独立** —— 每行 =「一个可伸缩项 + 一个按内容定宽的下拉」。
 * DOM 顺序 = 视觉顺序（搜索框 → 分类 → 结果 → 排序）。
 */
const AFTER = `<aside class="npr-sidebar" id="after">
  ${TOOLBAR('after')}
  ${TABS}
  ${FILTERS}
  <div class="npr-lib-controls" id="after-controls">
    <div class="npr-lib-row" id="after-row1">
      <input class="npr-lib-search" id="after-search" type="search" placeholder="搜索书名 / 丛书…">
      <label class="npr-lib-dir"><span class="npr-visually-hidden">来源与分类</span><select id="after-dir">
        <option value="">全部来源</option>
        <optgroup label="网盘 · E书拾取（1421）">
          <option value="s-pan-all">网盘 · E书拾取 · 全部（1421）</option>
          <option value="s-pan-dir" selected>${SOURCE_LONGEST}</option>
        </optgroup>
      </select></label>
    </div>
    <div class="npr-lib-row" id="after-row2">
      <div class="npr-status" id="after-status">${STATUS_LONGEST}</div>
      <label class="npr-lib-sort"><span class="npr-visually-hidden">排序</span><select id="after-sort"><option>${SORT_LONGEST}</option></select></label>
    </div>
  </div>
  <div class="npr-list" id="after-list"></div>
</aside>`;

/**
 * 一条「弃读」行，按 `LibraryApp.jsx` 里**真实的 DOM 形状**搭：主按钮里套两个 `span`，
 * 动作位是**两个独立胶囊**（`+ 阅读` / `移出`，顺序与 `bookRowView` 给的一致）。
 *
 * ★ `scope` 只改 id：两行**其余部分逐字相同** —— 反向对照才只差那条 CSS，
 *   否则对照证明的是别的东西（本项目踩过「反向对照写的不是判据的原式」）。
 * ★ `npr-bookrow-inert` / `npr-bookrow-dim` 都带上：0.9.4 的弃读行两样都有，
 *   少带一个量到的就不是真行。
 * ★ 0.20.4 起行内还有一枚**来源徽章**（`npr-bookrow-source is-pan`）：它也是真行的一部分，
 *   而且这是出图里唯一能看到它长什么样、会不会把元信息行撑坏的地方
 *   （判据 ⑪ 量的是两枚胶囊的水平间距，加一个 meta 子项不影响它）。
 */
const droppedRow = (scope) => `<div class="npr-bookrow npr-bookrow-inert npr-bookrow-dim" id="row-${scope}">
    <button type="button" class="npr-bookrow-main" disabled>
      <span class="npr-bookrow-title">长安的荔枝</span>
      <span class="npr-bookrow-meta"><span class="npr-bookrow-source is-pan">网盘 · E书拾取</span><span class="npr-bookrow-badge npr-badge-dropped">弃读</span><span>EPUB</span><span>1.2 MB</span><span>要再读，点右边的「+ 阅读」</span></span>
    </button>
    <button type="button" class="npr-bookrow-action" id="cap-${scope}-1">+ 阅读</button>
    <button type="button" class="npr-bookrow-action" id="cap-${scope}-2">移出</button>
  </div>`;
const ROWS = `<div class="rowsbox" id="rows-normal">${droppedRow('normal')}</div>
  <div class="rowsbox" id="rows-nogap">${droppedRow('nogap')}</div>`;

/**
 * 0.9.4 的三条声明（逐字抄自 0.9.4 的 `refinements.css`），只在 `#before` 作用域里补回来。
 * ★ `.npr-lib-search` 那条两版相同，所以不在这里重复 —— 补回来的越少，两列的差别
 *   越只可能是被测的那一次改动。
 */
const BEFORE_CSS = `
/* —— 0.9.4 的三行结构（逐字抄自 0.9.4 的 refinements.css）—— */
#before .npr-lib-searchbar { display: flex; flex-direction: column; gap: 6px; padding: 6px 10px 8px; flex-shrink: 0; }
#before .npr-lib-selects { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 6px; flex-shrink: 0; }
#before .npr-lib-selects label { min-width: 0; display: block; }
#before .npr-lib-selects select { width: 100%; min-width: 0; height: 28px; padding: 0 6px; border: 1px solid var(--npr-border); border-radius: 7px; background: var(--npr-bg); color: var(--npr-fg); font: inherit; font-size: 11px; }
#before .npr-lib-search { width: 100%; }
/* —— 0.9.5 的两行网格（逐字抄自 0.9.5 的 refinements.css）——
   ★ 只补**0.9.6 改掉的那几条**：网格本身 + 两处「width: 100%」（0.9.6 把下拉改成
   按内容定宽、把输入框改成靠「flex-basis: 0」定宽）。补回来的越少，「#grid」与
   「#after」的差别越只可能是被测的那一次改动。
   ★ 这段注释在**模板串内部**，所以一个反引号都不能有 —— 写完就踩了（第四次）。 */
#grid .npr-lib-controls { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); grid-template-areas: "search dir" "status sort"; gap: 6px 8px; align-items: center; }
#grid .npr-lib-controls .npr-lib-search { grid-area: search; }
#grid .npr-lib-controls .npr-lib-dir { grid-area: dir; }
#grid .npr-lib-controls .npr-lib-sort { grid-area: sort; }
#grid .npr-lib-controls .npr-status { grid-area: status; }
#grid .npr-lib-search { width: 100%; }
#grid .npr-lib-dir select, #grid .npr-lib-sort select { width: 100%; }`;

/**
 * 反向对照：把那条 `margin-left` **抵消掉**。
 * ★ id 的特异性（1,0,0）压得过 `.npr-root .npr-bookrow-action + .npr-bookrow-action`
 *   那串类（0,3,0），所以这一条一定生效 —— 但脚本会**量出来核对**，不靠推理。
 * ★ 只抵消这一条：行与按钮的其余样式逐字相同。
 */
const NOROWGAP_CSS = `
#rows-nogap .npr-bookrow-action + .npr-bookrow-action { margin-left: 0; }`;

const LABEL_CSS = `
body { font: 12px -apple-system, "Helvetica Neue", sans-serif; color: #0f1115; }
.page { display: flex; gap: 16px; padding: 16px; align-items: flex-start; }
.col { width: 320px; }
.col > h1 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
.col .npr-sidebar { width: 320px; height: 240px; overflow: hidden; }
.rowsbox { width: 320px; }
.legend { margin: 6px 0 0; font-size: 11px; color: #61666b; }`;

const PAGE = `<!doctype html><meta charset="utf-8">
<style id="host">${HOST}</style>
<style id="panel">${PANEL_CSS}</style>
<style id="refinements">${REFINEMENTS}</style>
<style id="before">${BEFORE_CSS}</style>
<style id="norowgap">${NOROWGAP_CSS}</style>
<style id="label">${LABEL_CSS}</style>
<div class="npr-root">
  <div class="page">
    <div class="col"><h1>0.9.5（改动前）两行 · 共用列</h1>${GRID095}
      <p class="legend" id="legend-grid">—</p></div>
    <div class="col"><h1>0.9.6（改动后）两行 · 各自独立</h1>${AFTER}
      <p class="legend" id="legend-after">—</p></div>
    <div class="col"><h1>0.9.4（历史）三行</h1>${BEFORE}
      <p class="legend" id="legend-before">—</p></div>
    <div class="col"><h1>0.9.4「弃读」行的两个动作</h1>${ROWS}
      <p class="legend" id="legend-rowgap">—</p></div>
  </div>
</div>`;

// ---- 3. 探针：在真 Chrome 里量像素 ----------------------------------------
const PROBE = `
const rect = (sel) => {
  const el = document.querySelector(sel);
  if (el === null) return null;
  const b = el.getBoundingClientRect();
  return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
};
const cs = (sel) => {
  const el = document.querySelector(sel);
  return el === null ? null : getComputedStyle(el);
};
/**
 * ★ 行数只能靠 Range 数**行盒**：拿 clientHeight / lineHeight 去算，在行高不是整数
 *   （这里 19.2 / 12 = 1.6）时会四舍五入错一位，而本条判据要的正是「1 行还是 2 行」。
 * ★ 要选到**持有文本的那个元素**（状态行自己就是），否则数出来的是子元素的盒数。
 */
const lines = (sel) => {
  const el = document.querySelector(sel);
  if (el === null) return null;
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getClientRects().length;
};
/**
 * ★ 一个元素「按内容需要多宽」——把**同款克隆**挂到**同一个父节点**下（这样
 *   「.npr-lib-dir select」这类祖先选择器照样命中），再用 position:fixed 移出流，
 *   量它的 max-content 宽度。判据「下拉没有被压得显示不下自己的文字」靠它。
 * ★ 克隆必须 removeAttribute('id')：两个同 id 元素会让后面的 querySelector 抓错。
 * ★ 这段注释在**模板串内部**，所以一个反引号都不能有（本项目为此栽过四次）。
 */
const naturalWidth = (sel) => {
  const src = document.querySelector(sel);
  if (src === null) return null;
  const clone = src.cloneNode(true);
  clone.removeAttribute('id');
  clone.style.cssText = 'position:fixed;left:-9999px;top:0;width:max-content';
  src.parentNode.appendChild(clone);
  const w = clone.getBoundingClientRect().width;
  clone.remove();
  return w;
};
/**
 * 反向对照（判据 ⑭）：把来源/分类下拉的宽度上限**临时去掉**，在**同一份 DOM、
 * 同一帧**里再量一次那一行。
 * ★ 为什么不另起一列夹具：两列的差别就不止那条 max-width 了，对照证明的会是别的东西
 *   （本项目踩过「两张一模一样的对照图」）。
 * ★ 量完立刻恢复：后面的判据还要量「带上限」时的值。
 * ★ 这段注释在模板串内部，所以一个反引号都不能有（本项目为此栽过四次）。
 */
const uncapped = (() => {
  const el = document.querySelector('#after-dir');
  if (el === null) return { select: 0, search: 0 };
  el.style.maxWidth = 'none';
  const select = el.getBoundingClientRect().width;
  const search = document.querySelector('#after-search').getBoundingClientRect().width;
  el.style.maxWidth = '';
  return { select, search };
})();
const out = {
  viewport: { width: window.innerWidth, height: window.innerHeight },
  before: {
    toolbar: rect('#before-toolbar'),
    filters: rect('#before .npr-filters'),
    searchbar: rect('#before-searchbar'),
    search: rect('#before-search'),
    dirSelect: rect('#before-dir'),
    sortSelect: rect('#before-sort'),
    status: rect('#before-status'),
    list: rect('#before-list'),
    statusLines: lines('#before-status'),
  },
  /**
   * ★ 0.9.6 的「改动前」：0.9.5 那个两行**共用列**的网格。
   *   这一列是**反向对照**用的 —— 新判据「结果行必须单行」喂给它必须失败（那边折两行）。
   */
  grid: {
    controls: rect('#grid-controls'),
    search: rect('#grid-search'),
    dirSelect: rect('#grid-dir'),
    sortSelect: rect('#grid-sort'),
    status: rect('#grid-status'),
    statusLines: lines('#grid-status'),
    dirNatural: naturalWidth('#grid-dir'),
    sortNatural: naturalWidth('#grid-sort'),
  },
  after: {
    sidebar: rect('#after'),
    toolbar: rect('#after-toolbar'),
    tabs: rect('#after .npr-libtabs'),
    filters: rect('#after .npr-filters'),
    lastChip: rect('#after .npr-filters button:last-child'),
    controls: rect('#after-controls'),
    row1: rect('#after-row1'),
    row2: rect('#after-row2'),
    search: rect('#after-search'),
    dirSelect: rect('#after-dir'),
    sortSelect: rect('#after-sort'),
    status: rect('#after-status'),
    refresh: rect('#after-refresh'),
    gear: rect('#after-gear'),
    list: rect('#after-list'),
    statusLines: lines('#after-status'),
    dirNatural: naturalWidth('#after-dir'),
    /** 去掉 max-width 之后的同一行（判据 ⑭ 的反向对照）。 */
    uncapped,
    sortNatural: naturalWidth('#after-sort'),
    searchCss: (() => { const c = cs('#after-search'); return { height: c.height, width: c.width, flex: c.flex, minWidth: c.minWidth, order: c.order }; })(),
    controlsCss: (() => { const c = cs('#after-controls'); return { display: c.display, direction: c.flexDirection, gap: c.gap, padding: c.padding }; })(),
    rowCss: (() => { const c = cs('#after-row2'); return { display: c.display, alignItems: c.alignItems, gap: c.gap }; })(),
    sortFlex: (() => { const c = cs('#after-sort'); return { flex: c.flex, width: c.width }; })(),
  },
  /**
   * 判据 ⑩：「弃读」行两枚胶囊的间距。
   * ★ 量 getBoundingClientRect() 的**外缘**（含 1px 边框），也就是眼睛看到的缝。
   * ★ rows-nogap 那一组除了那条 margin-left 被抵消，**逐字相同** —— 反向对照。
   * ★ 这段注释在**模板串内部**，所以一个反引号都不能有：反引号会提前闭合模板串，
   *   闭合之后剩下的**可能仍然语法合法**（本项目吃过一次「用例全绿、App 起不来」）。
   *   要引名字就用「」。
   */
  rows: {
    row: rect('#row-normal'),
    main: rect('#row-normal .npr-bookrow-main'),
    cap1: rect('#cap-normal-1'),
    cap2: rect('#cap-normal-2'),
    capGapCss: (() => { const c = cs('#cap-normal-2'); return { marginLeft: c.marginLeft }; })(),
    offMain: rect('#row-nogap .npr-bookrow-main'),
    offCap1: rect('#cap-nogap-1'),
    offCap2: rect('#cap-nogap-2'),
    offCapGapCss: (() => { const c = cs('#cap-nogap-2'); return { marginLeft: c.marginLeft }; })(),
  },
};
/**
 * ★ 把量到的数字写进图里的说明行，并把那个 pre 挪出画面：
 *   对照图要能**自证**（数字在图上），而不是靠报告里口述。
 *   pre 不能删 —— 它是 --dump-dom 的取数通道 —— 所以用 position:fixed + visibility
 *   挪走。★ 只写 left:-9999px 是**不够**的：pre 不换行，内容宽度上万像素，
 *   从 -9999 出发照样横穿整个视口，上一版出图顶部就糊了一条 JSON。
 *   ★ 这段注释在**模板串内部**，所以一个反引号都不能有：反引号会提前闭合模板串，
 *     而闭合之后剩下的还是**语法合法**的代码（本项目为此吃过一次「用例全绿、
 *     App 起不来」）。要引名字就用「」。
 */
const fmt = (n) => Math.round(n);
document.getElementById('legend-grid').textContent =
  '共用列：结果行 ' + fmt(out.grid.status.width) + 'px → 文字折 ' + out.grid.statusLines + ' 行'
  + ' · 排序 ' + fmt(out.grid.sortSelect.width) + 'px（被分类列撑住，压不下去）';
document.getElementById('legend-after').textContent =
  '独立：结果行 ' + fmt(out.after.status.width) + 'px → 文字 ' + out.after.statusLines + ' 行'
  + ' · 排序 ' + fmt(out.after.sortSelect.width) + 'px（按内容定宽）'
  + ' · 来源/分类下拉 ' + fmt(out.after.dirSelect.width) + 'px（被上限截断，搜索框仍 ' + fmt(out.after.search.width) + 'px）';
document.getElementById('legend-before').textContent =
  '三行：搜索框 top=' + fmt(out.before.search.top)
  + ' · 分类 top=' + fmt(out.before.dirSelect.top)
  + ' · 结果 top=' + fmt(out.before.status.top) + '（三者各不相同）';
document.getElementById('legend-rowgap').textContent =
  '两枚胶囊间距 ' + fmt(out.rows.cap2.left - out.rows.cap1.right) + 'px'
  + ' · 正文↔首枚 ' + fmt(out.rows.cap1.left - out.rows.main.right) + 'px'
  + ' · 去掉 margin-left 后 ' + fmt(out.rows.offCap2.left - out.rows.offCap1.right) + 'px';
const pre = document.createElement('pre');
pre.id = 'probe-out';
pre.style.cssText = 'position:fixed;left:0;top:0;margin:0;visibility:hidden';
pre.textContent = JSON.stringify(out);
document.body.appendChild(pre);
`;

/**
 * ★★ 防「模板串被反引号提前闭合」——**这道守卫必须罩住每一个装着 CSS / HTML 的模板串**。
 *   0.9.6 之前它只罩着探针脚本，于是同一类错在 `BEFORE_CSS` 的注释里又踩了一次
 *   （本项目第四次）。闭合点之后的残骸**有时语法合法**（吃过一次「用例全绿、
 *   App 起不来」），所以不能只指望 Node 的解析器。
 *   判据：每个模板串里都点名一个**靠近尾部**的哨兵 —— 提前闭合就必然把它丢掉。
 */
const TEMPLATE_SENTINELS = [
  ['BEFORE_CSS', BEFORE_CSS, '#grid .npr-lib-dir select, #grid .npr-lib-sort select { width: 100%; }'],
  ['NOROWGAP_CSS', NOROWGAP_CSS, '#rows-nogap .npr-bookrow-action + .npr-bookrow-action { margin-left: 0; }'],
  ['LABEL_CSS', LABEL_CSS, '.legend { margin: 6px 0 0; font-size: 11px; color: #61666b; }'],
  ['REFINEMENTS', REFINEMENTS, '.npr-lib-dir select, .npr-lib-sort select {'],
  ['BEFORE', BEFORE, 'id="before-list"'],
  ['GRID095', GRID095, 'id="grid-list"'],
  ['AFTER', AFTER, 'id="after-list"'],
  ['ROWS', ROWS, 'id="rows-nogap"'],
];
for (const [name, text, sentinel] of TEMPLATE_SENTINELS) {
  if (!text.includes(sentinel)) {
    throw new Error(`${name} 里找不到尾部哨兵「${sentinel}」—— 模板串多半被反引号提前闭合了`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'npr-sidebar-layout-'));
/**
 * ★ 量测与截图用**同一份 HTML**。两份一旦分叉（哪怕只差一行说明文字），
 *   图就不是「被量的那一张」—— 那就是「探针测的不是被测那一步」。
 */
const html = `${PAGE}\n<script>\n${PROBE}\n<\/script>\n`;

/**
 * ★ 防「模板串被反引号提前闭合」—— 这种错**有时语法合法**：闭合点之后的残骸如果
 *   恰好是一个表达式，Node 照样加载成功、断言全绿，而注入页面的脚本已经缺了一截
 *   （本项目吃过一次：注释里的反引号 ⇒ 提前闭合 ⇒ 语法合法的减法链 ⇒ 用例全绿、
 *   App 起不来）。⇒ 对**拼好的**脚本做两道核对：能编译 + 关键哨兵都在。
 *   写判据 ⑩ 时又踩了一次，只是那次运气好、报的是 SyntaxError。
 */
const scriptOpen = '<script>';
const scriptBody = html.slice(html.lastIndexOf(scriptOpen) + scriptOpen.length, html.lastIndexOf('</script>'));
try {
  new Function(scriptBody);
} catch (err) {
  throw new Error(`注入的探针脚本编译不过：${err.message}`);
}
for (const sentinel of ["pre.id = 'probe-out'", 'JSON.stringify(out)', 'appendChild(pre)']) {
  if (!scriptBody.includes(sentinel)) {
    throw new Error(`探针脚本里找不到「${sentinel}」—— 模板串多半被反引号提前闭合了`);
  }
}

const htmlPath = join(dir, 'page.html');
writeFileSync(htmlPath, html, 'utf8');

function run(args) {
  const res = spawnSync(CHROME, ['--no-sandbox', '--disable-gpu', '--headless', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`chrome 启动失败：${res.error.message}`);
  return res.stdout;
}

/**
 * ★ 视口尺寸同时决定「量测的宽度」与「出图的宽度」，两次运行必须给同一组参数
 *   （含 `--hide-scrollbars`：少了它，两次的可用宽度会差一条滚动条）。
 * ★ 宽度 1360 是**算出来的**：四列 320px + 三条 16px 间隙 + 左右各 16px 内边距
 *   = 1360，不多不少。窄了 `.col` 会被 flex 压扁（`flex-shrink` 默认 1），
 *   侧栏宽度一变，所有几何判据量的就不是 320px 的侧栏了。
 */
const VIEWPORT = { width: 1360, height: 350 };
const VIEWPORT_ARGS = ['--hide-scrollbars', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`];

const dom = run(['--virtual-time-budget=2000', ...VIEWPORT_ARGS, '--dump-dom', `file://${htmlPath}`]);
const matched = /<pre id="probe-out"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
if (!matched) throw new Error(`没拿到探针结果（脚本抛了？）\n${dom.slice(-1500)}`);
const decoded = matched[1]
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
const out = JSON.parse(decoded);

// ---- 4. 判定 --------------------------------------------------------------
const failures = [];
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name} —— ${detail}`);
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `（${detail}）`}`);
};
/** 「同一行」一律比中线：`align-items: center` 会把 19px 的文字与 28px 的控件各自居中。 */
const cy = (r) => (r.top + r.bottom) / 2;

const A = out.after;
const B = out.before;

console.log(`视口 ${out.viewport.width}×${out.viewport.height}（截图与量测用同一个宽度）`);
const dump = (label, obj, keys) => {
  console.log(`--- ${label} ---`);
  for (const key of keys) {
    const r = obj[key];
    if (r === null || r === undefined || !('top' in r)) continue;
    console.log(`  ${key.padEnd(10)} top=${r.top.toFixed(1)} bottom=${r.bottom.toFixed(1)} `
      + `left=${r.left.toFixed(1)} right=${r.right.toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)}`);
  }
};
dump('0.9.6（改动后）两行 · 各自独立', A,
  ['controls', 'row1', 'row2', 'search', 'dirSelect', 'sortSelect', 'status', 'list']);
console.log(`  结果行文字 ${A.statusLines} 行 · 来源/分类下拉 ${A.dirSelect.width.toFixed(1)}px`
  + `（上限 ${DIR_MAX}，不设上限时需 ${A.uncapped.select.toFixed(1)}px、搜索框只剩 ${A.uncapped.search.toFixed(1)}px）`
  + ` · 排序需要 ${A.sortNatural.toFixed(1)}px（实得 ${A.sortSelect.width.toFixed(1)}）`);
console.log(`  searchCss   ${JSON.stringify(A.searchCss)}`);
console.log(`  controlsCss ${JSON.stringify(A.controlsCss)}`);
console.log(`  rowCss      ${JSON.stringify(A.rowCss)}`);
dump('0.9.5（改动前，只作对照）两行 · 共用列', out.grid,
  ['controls', 'search', 'dirSelect', 'sortSelect', 'status']);
console.log(`  结果行文字 ${out.grid.statusLines} 行 · 分类需要 ${out.grid.dirNatural.toFixed(1)}px`);
dump('0.9.4（历史，只作对照）三行', B, ['search', 'dirSelect', 'sortSelect', 'status']);
console.log(`  结果行文字 ${B.statusLines} 行`);
console.log('--- 判据：搜索系统的两行布局 ---');

check('① 搜索系统在筛选条**下面**', A.controls.top >= A.filters.bottom,
  `controls.top=${A.controls.top.toFixed(1)} < filters.bottom=${A.filters.bottom.toFixed(1)}`);
check('② ★ 分类与搜索框**同一行**（中线相等），且分类在它右边',
  near(cy(A.search), cy(A.dirSelect), 0.6) && A.dirSelect.left >= A.search.right,
  `搜索框中线=${cy(A.search).toFixed(1)} 分类中线=${cy(A.dirSelect).toFixed(1)}`
  + ` · 分类 left=${A.dirSelect.left.toFixed(1)} vs 搜索框 right=${A.search.right.toFixed(1)}`);
/**
 * ★ 判据 ③ 必须**分辨得出这次改动**：本轮把排序从「分类那一行」挪到了「结果那一行」。
 *   若只写「排序在搜索框下面」，0.9.4 的三行结构同样成立（那边排序在第三行，离搜索框更远）——
 *   判据全绿却量不到任何东西，反向对照会当场戳穿（实测过：那条对照永远失败）。
 *   所以这里钉的是**排序已经离开分类那一行**（`!near` 中线），这一条才是改动的实质。
 */
check('③ ★ 排序**离开了分类那一行**（降下去了，不再与搜索框同行）',
  !near(cy(A.sortSelect), cy(A.dirSelect), 0.6) && A.sortSelect.top >= A.search.bottom,
  `排序中线=${cy(A.sortSelect).toFixed(1)} 分类中线=${cy(A.dirSelect).toFixed(1)}`
  + `（还挤在同一行）· 排序 top=${A.sortSelect.top.toFixed(1)} vs 搜索框 bottom=${A.search.bottom.toFixed(1)}`);
check('④ ★ 结果行与排序**同一行**（中线相等），且结果在排序左边',
  near(cy(A.status), cy(A.sortSelect), 0.6) && A.status.right <= A.sortSelect.left,
  `结果中线=${cy(A.status).toFixed(1)} 排序中线=${cy(A.sortSelect).toFixed(1)}`
  + ` · 结果 right=${A.status.right.toFixed(1)} vs 排序 left=${A.sortSelect.left.toFixed(1)}`);
/**
 * ★ 判据 ⑤ 在 0.9.6 被**收窄**了（不是重排编号）：「两列左右都对齐」是 0.9.5 那个
 *   共享列网格的推论；两行拆开之后，左项贴左缘、右项贴右缘这两条**仍然**成立，
 *   「右列左缘也对齐」则**按设计**不再成立（排序按内容定宽，必然比分类窄）。
 */
check('⑤ ★ 两条行都是「左项贴左缘、右项贴右缘」',
  near(A.search.left, A.status.left) && near(A.dirSelect.right, A.sortSelect.right)
  && near(A.dirSelect.right, A.row1.right) && near(A.sortSelect.right, A.row2.right),
  `左项 left [${A.search.left.toFixed(1)} / ${A.status.left.toFixed(1)}]`
  + ` · 右项 right [${A.dirSelect.right.toFixed(1)} / ${A.sortSelect.right.toFixed(1)}]`
  + ` · 行右缘 [${A.row1.right.toFixed(1)} / ${A.row2.right.toFixed(1)}]`);
/**
 * ★★ 判据 ⑥ 是**这一轮改动的实质**（用户原话：「排序下拉列表的宽度缩小一些」）：
 *   排序必须**按自己的内容定宽**，而不是被分类那一列撑宽。
 *   0.9.5 的共享列网格里它是整列宽；0.9.6 起是它自己内容那么宽。
 *   ★ 两个方向都钉：既不许比内容**窄**（会截断文字），也不许比内容**宽**
 *     （多出来的像素本该给结果行 —— 这正是上一版的问题）。
 */
check('⑥ ★ 排序**按内容定宽**（不再被分类那一列撑宽，也不比它需要的更窄）',
  near(A.sortSelect.width, A.sortNatural, 1),
  `排序=${A.sortSelect.width.toFixed(1)}（内容需要 ${A.sortNatural.toFixed(1)}）`
  + ` vs 0.9.5 共用列时的 ${out.grid.sortSelect.width.toFixed(1)}`);
check('⑦ 搜索框高度 = 28px（没被压扁）', near(A.search.height, 28),
  `实测 ${A.search.height.toFixed(1)}px，computed height=${A.searchCss.height}`);
/**
 * ★ 判据 ⑧ 在 2026-10-23 换了**主体**：右端那个按钮从「刷新」变成了「设置」。
 *   用户的原话是「就是这个设置的图标位置调整」，落点截图是工具栏最右端；
 *   于是刷新不再吃 `margin-left: auto`，它回到 ViewSwitch 右边跟着排。
 *
 * ★ 为什么必须两条一起判：两个 `auto` 同时存在时 flex 会**平分**空档 ——
 *   结果是齿轮不贴边、刷新也不贴边，两个都悬在中间。只判「齿轮靠右」在那种
 *   状态下仍然会绿（它确实比刷新更靠右），所以还要钉住「刷新不贴右端」。
 */
check('⑧ 设置齿轮贴工具栏最右端，刷新按钮回到左侧（两个 auto 会平分空档）',
  near(A.gear.right, A.sidebar.right - 8, 1) && A.refresh.right < A.gear.left - 2,
  `gear.right=${A.gear.right.toFixed(1)} sidebar.right-8=${(A.sidebar.right - 8).toFixed(1)} `
  + `refresh.right=${A.refresh.right.toFixed(1)} gear.left=${A.gear.left.toFixed(1)}`);

/**
 * ★ 间距量的是**画出来的边**，不是容器的盒边：`.npr-filters` 自带 8px 下内边距，
 *   用 `filters.bottom` 当「上面那条的底」会把这 8px 算进「块内」——
 *   判据就与眼睛看到的相反（实测过：盒边算出来 2px，画出来的边是 10px）。
 */
if (A.lastChip === null) throw new Error('量不到 chip 条里最后一个按钮 —— 判据 ⑨ 会静默失效');
const gapOuter = A.search.top - A.lastChip.bottom;
const gapInner = A.sortSelect.top - A.search.bottom;
check('⑨ 块外间距 > 块内间距（「这四件是一套」唯一的视觉依据）', gapOuter > gapInner,
  `块外=${gapOuter.toFixed(1)}（chip 底 ${A.lastChip.bottom.toFixed(1)} → 搜索框顶 ${A.search.top.toFixed(1)}）`
  + ` 块内=${gapInner.toFixed(1)}（搜索框底 → 第二行顶）`);

check('⑩ 从上到下顺序：工具栏 → 分页 → 筛选条 → 搜索系统 → 列表',
  A.toolbar.bottom <= A.tabs.top && A.tabs.bottom <= A.filters.top && A.controls.top >= A.filters.bottom
  && A.list.top >= A.controls.bottom,
  `toolbar.b=${A.toolbar.bottom.toFixed(1)} tabs=[${A.tabs.top.toFixed(1)},${A.tabs.bottom.toFixed(1)}] `
  + `filters=[${A.filters.top.toFixed(1)},${A.filters.bottom.toFixed(1)}] `
  + `controls=[${A.controls.top.toFixed(1)},${A.controls.bottom.toFixed(1)}] list.t=${A.list.top.toFixed(1)}`);

/**
 * ★★ 判据 ⑬ 是**用户这次报的那一件事**：结果行的文字必须**单行**。
 *   ★ 行数只认 `Range` 数出来的**行盒数**，不拿 `clientHeight / lineHeight` 去算
 *     （这里行高 19.2、字号 12 ⇒ 1.6，四舍五入会算错一位，而本条要的正是 1 还是 2）。
 *   ★ 夹具用的是**上限文字**（`2634 / 2634 本 · 已在阅读 2634`）：按上限立判据，
 *     才配叫「保证单行」。
 * ★ 判据 ⑭ 守的是这次改动的**代价**：像素是从分类那一列挪过来的，别把分类压得
 *   显示不下自己的文字。`dirNatural` 是同款克隆的 max-content 宽度。
 */
check('⑬ ★★ 结果行文字**单行**（用户这次报的就是它折成了两行）',
  A.statusLines === 1,
  `实测 ${A.statusLines} 行（结果行宽 ${A.status.width.toFixed(1)}px）`);
/**
 * ★ 判据 ⑭ 在 2026-10-23 换了**主体**：它原来守的是「分类没有被压得显示不下
 *   （实得 ≥ 按内容需要的宽度）」。0.20.4 起那个下拉装的是「来源 ▸ 分类」，
 *   最坏情况的文字（用户自己起的源名 + 分类 + 计数）比 320px 侧栏能给的一半还宽 ——
 *   继续要求「显示得下」等于要求这一行不做搜索框了。
 *   所以改成守**这一行不被撑破**：下拉被 168px 上限锁住、搜索框仍留住 ≥110px。
 *   ★ 反向对照不是另写一条「没有上限时应该更窄」，而是把**同一条原式**喂给
 *     「临时去掉上限」的同一份 DOM —— 那边搜索框会被挤到 110px 以下。
 */
check('⑭ ★ 来源/分类下拉有宽度上限（搜索框没被挤没）',
  near(A.dirSelect.width, DIR_MAX, 1) && A.search.width >= 110,
  `下拉实得 ${A.dirSelect.width.toFixed(1)}px（上限 ${DIR_MAX}）· 搜索框 ${A.search.width.toFixed(1)}px`);
check('★ 反向对照：判据 ⑭ 的原式喂给「去掉 max-width」的同一行必须失败（搜索框被长书单名挤没）',
  !(near(A.uncapped.select, DIR_MAX, 1) && A.uncapped.search >= 110),
  `去掉上限后 下拉=${A.uncapped.select.toFixed(1)}px 搜索框=${A.uncapped.search.toFixed(1)}px`
  + '（居然也过了？那判据 ⑭ 量不到这次改动）');

/**
 * ★ 反向对照（几何级）：把**同一套判据的原式**喂给旧结构，必须失败。
 *   不是另写一条「旧结构应该分三行」—— 那只是在描述旧实现，证明不了判据有牙。
 *   · ② ③ ④ 是 0.9.5 的核心主张（分类升到搜索框那一行、排序离开分类那一行、
 *     降到结果那一行）⇒ 喂给 0.9.4 的三行结构；
 *   · ⑥ ⑬ 是 0.9.6 的核心主张（排序按内容定宽、结果行单行）⇒ 喂给 0.9.5 的
 *     共用列网格（那边排序被撑到整列宽、结果行折两行）。
 */
check('★ 反向对照：判据 ⑥ 的原式喂给 0.9.5 的共用列网格必须失败（那边排序被撑到整列宽）',
  !(near(out.grid.sortSelect.width, out.grid.sortNatural, 1)),
  `0.9.5 排序=${out.grid.sortSelect.width.toFixed(1)} · 内容只需要 ${out.grid.sortNatural.toFixed(1)}`
  + '（居然也「按内容定宽」？那判据 ⑥ 量不到这次改动）');
check('★ 反向对照：判据 ⑬ 的原式喂给 0.9.5 的共用列网格必须失败（那边结果行折两行）',
  !(out.grid.statusLines === 1),
  `0.9.5 结果行文字 ${out.grid.statusLines} 行（居然也单行？那判据 ⑬ 量不到这次改动）`);
check('★ 反向对照：判据 ② 的原式喂给 0.9.4 三行结构必须失败',
  !(near(cy(B.search), cy(B.dirSelect), 0.6) && B.dirSelect.left >= B.search.right),
  `旧结构 搜索框中线=${cy(B.search).toFixed(1)} 分类中线=${cy(B.dirSelect).toFixed(1)}（居然也过了）`);
check('★ 反向对照：判据 ④ 的原式喂给 0.9.4 三行结构必须失败',
  !(near(cy(B.status), cy(B.sortSelect), 0.6) && B.status.right <= B.sortSelect.left),
  `旧结构 结果中线=${cy(B.status).toFixed(1)} 排序中线=${cy(B.sortSelect).toFixed(1)}（居然也过了）`);
check('★ 反向对照：判据 ③ 的原式喂给 0.9.4 三行结构必须失败（那边排序与分类同行）',
  !(!near(cy(B.sortSelect), cy(B.dirSelect), 0.6) && B.sortSelect.top >= B.search.bottom),
  `旧结构 排序中线=${cy(B.sortSelect).toFixed(1)} 分类中线=${cy(B.dirSelect).toFixed(1)}`
  + '（居然也「离开了分类那一行」？那判据 ③ 量不到这次改动）');

console.log('--- 判据 ⑪：「弃读」行两枚胶囊（0.9.4）---');
const R = out.rows;
for (const key of ['row', 'main', 'cap1', 'cap2', 'offMain', 'offCap1', 'offCap2']) {
  const r = R[key];
  console.log(`  ${key.padEnd(9)} left=${r.left.toFixed(1)} right=${r.right.toFixed(1)} `
    + `top=${r.top.toFixed(1)} h=${r.height.toFixed(1)}`);
}
console.log(`  marginLeft 正常=${R.capGapCss.marginLeft} / 对照=${R.offCapGapCss.marginLeft}`);

/**
 * ★ 判据量的是**画出来的缝**（外缘到外缘），不是 `gap` 的 computed 值：
 *   `gap: 2px` + `margin-left: 4px` 是**两个来源的和**，只看 `gap` 会把 6px 读成 2px。
 * ★ 两个来源必须**都**断言到：若有人把 `gap` 直接改成 6px、顺手删掉那条 `margin-left`，
 *   只断言「两枚之间 = 6px」会全绿 —— 可它同时把「正文↔首枚」从 2px 撑成 6px，
 *   破坏了行内本来的节奏。所以这一条把两处间距一起钉住。
 * ★ 反向对照用的是**同一组判据的原式**（`near(…,2)` 与 `near(…,6)` 的合取取反），
 *   不是另写一条「没有 margin-left 时应该更窄」—— 后者只是在描述旧实现。
 */
const bodyGap = R.cap1.left - R.main.right;
const capGap = R.cap2.left - R.cap1.right;
const offBodyGap = R.offCap1.left - R.offMain.right;
const offCapGap = R.offCap2.left - R.offCap1.right;
check('⑪ 「弃读」行：正文↔首枚 = 2px，两枚之间 = 6px（2 + 4），且互不重叠',
  near(bodyGap, 2, 0.6) && near(capGap, 6, 0.6)
  && R.main.right <= R.cap1.left && R.cap1.right <= R.cap2.left,
  `正文↔首枚=${bodyGap.toFixed(1)}（期望 2）· 两枚之间=${capGap.toFixed(1)}（期望 6）`
  + ` · computed margin-left=${R.capGapCss.marginLeft}`);
check('★ 反向对照：判据 ⑪ 的原式喂给「抵消掉 margin-left」的同款行必须失败',
  !(near(offBodyGap, 2, 0.6) && near(offCapGap, 6, 0.6)),
  `去掉后：正文↔首枚=${offBodyGap.toFixed(1)} · 两枚之间=${offCapGap.toFixed(1)}`
  + `（两枚之间居然还是 6px？那这条 margin-left 根本没在起作用）`);

// ---- 5. 出对照图，并自证 PNG 宽高 -----------------------------------------
const pngPath = join(pluginRoot, 'test', '.build', 'library-sidebar-before-after.png');
run([...VIEWPORT_ARGS, '--force-device-scale-factor=2', '--virtual-time-budget=2000',
  `--screenshot=${pngPath}`, `file://${htmlPath}`]);

const png = readFileSync(pngPath);
if (png.slice(1, 4).toString('latin1') !== 'PNG') throw new Error('出的不是 PNG');
const pngW = png.readUInt32BE(16);
const pngH = png.readUInt32BE(20);
check(`⑫ 对照图宽高 = 量测视口 × 2（DPR=2）：期望 ${VIEWPORT.width * 2}×${VIEWPORT.height * 2}`,
  pngW === VIEWPORT.width * 2 && pngH === VIEWPORT.height * 2,
  `实测 ${pngW}×${pngH}`);
console.log(`  对照图：${pngPath}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} 条判据失败：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('\n全部断言通过。');
