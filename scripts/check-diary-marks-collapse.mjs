/**
 * 读后感工作台：划线侧栏「可收起 + 正文自适应」（0.44.7）。
 *
 * ★ 用户 2026-10-28 的原话：「读后感这部分，划线侧边栏应该可以收缩起来，
 *   写读后感的区域自适应。」
 *
 * 这道守卫要钉住的是**三件容易各自漂移的事**：
 *   ① 收起后正文真的变宽 —— 而且宽出来的量**等于**划线栏让出去的量；
 *      写成「flow 变宽了」是不够的：让出 266px 但正文只吃掉 100px 也是「变宽了」。
 *   ② 收起态不是「消失」：窄轨必须真的在、必须点得到、竖排文字不许被 34px 切掉。
 *   ③ 收起态**不渲染**列表。用 CSS `display:none` 藏起来也算「看不到」，但
 *      几百条划线还留在 DOM 里 —— 拖拽事件、`Range` 量测、读屏软件都摸得到。
 *      这一条只能在源码里钉（见 D 组），量不出来。
 *
 * ★ 为什么这里也量「挤压态」（473px，AI 面板开着）：
 *   展开时 473 − 300 = 173 < 正文下限 320 ⇒ 正文先吃满 320、划线栏被压到 153。
 *   这正是 0.44.1 那个「写读后感这一列全错位」的场景 —— 收起划线栏是它最直接的
 *   解法（320 → 439）。如果只在宽窗口下量，这道解法看起来就是「多此一举」。
 *
 * ★ 与 `check-tabs.mjs` 一样**进库**、不依赖预览帧：PANEL_CSS 从 `ReaderPage.jsx`
 *   现抽、`refinements.css` 直读源码，宿主主题变量用近似值兜住（只影响颜色）。
 *
 * 用法：
 *   node scripts/check-diary-marks-collapse.mjs            # 跑判据
 *   node scripts/check-diary-marks-collapse.mjs --shot x.html  # 导出一份夹具给人眼复核
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const REFINEMENTS = readFileSync(join(ROOT, 'src/client/refinements.css'), 'utf8');
const DIARY = readFileSync(join(ROOT, 'src/client/DiaryApp.jsx'), 'utf8');

const panelSrc = readFileSync(join(ROOT, 'src/client/ReaderPage.jsx'), 'utf8');
const panelMatch = /const PANEL_CSS = `([\s\S]*?)\n`;/.exec(panelSrc);
if (!panelMatch) throw new Error('没从 ReaderPage.jsx 里抽出 PANEL_CSS —— 骨架缺失时量出来的是假几何，拒绝继续');
const PANEL_CSS = panelMatch[1];

/** 字体栈与 `check-tabs.mjs` 同源：字宽会改变竖排标签的盒子，字体不同就是量另一个界面。 */
const FONT = `font-family: -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 13px; line-height: 1.5;`;
const THEME = `
:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f5f5f7;--dsw-alias-label-primary:#1b1b1f;
  --dsw-alias-label-secondary:#6b6b73;--dsw-alias-label-tertiary:#8e8e96;--dsw-alias-border-l1:#e3e3e8;
  --dsw-alias-border-l2:#cfcfd6;--dsw-alias-interactive-bg-hover:#f1f1f4;--dsw-alias-bg-layer-3:#fff;
  --dsw-alias-brand-primary:#2f9e6e;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#2f9e6e}
html,body{margin:0;padding:0;background:#fff}
.npr-root{${FONT}}`;

/** 深色主题：只给 `--shot` 出图用（用户是在深色界面里提的需求）。判据全部跑在浅色上。 */
const THEME_DARK = `
:root{--dsw-alias-bg-base:#1c1c1e;--dsw-alias-bg-layer-1:#232325;--dsw-alias-label-primary:#f2f2f4;
  --dsw-alias-label-secondary:#a0a0a6;--dsw-alias-label-tertiary:#7a7a80;--dsw-alias-border-l1:#2e2e31;
  --dsw-alias-border-l2:#3c3c40;--dsw-alias-interactive-bg-hover:#2c2c2f;--dsw-alias-bg-layer-3:#262628;
  --dsw-alias-brand-primary:#5ec99a;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#5ec99a}
html,body{margin:0;padding:0;background:#1c1c1e}
.npr-root{${FONT}}`;

/** 收起态的宽度 —— 与 `refinements.css` 里 `flex: 0 0 34px` 同一个数，改一处这条就红。 */
const RAIL_W = 34;
/** 展开态划线栏的基准宽（`flex: 0 1 300px`）。 */
const MARKS_BASIS = 300;
/** 宽窗口下的正文区宽度：1182 − 268（导航） − 52（各种边框与分隔）。 */
const WIDE = 862;
/** AI 面板开着时的正文区宽度（真机实测，见 `.build/preview/measure-narrow.mjs`）。 */
const TIGHT = 473;

const ICON = (d) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const HEADER = `
  <header class="npr-diary-marks-head">
    <strong>划线</strong>
    <span>12 条</span>
    <button type="button" class="npr-diary-marks-toggle" aria-label="收起划线面板" aria-expanded="true">${ICON('<path d="m9 18 6-6-6-6"/>')}</button>
  </header>
  <div class="npr-diary-mark">
    <p class="npr-diary-mark-quote">阅读一本书，就是在跟一个更有经验的头脑对话。</p>
    <div class="npr-diary-mark-foot"><span>第 128 页</span><button type="button" class="npr-diary-action">引用</button></div>
  </div>
  <div class="npr-diary-mark">
    <p class="npr-diary-mark-quote">不求甚解地读完一本，不如慢慢地读半本。</p>
    <p class="npr-diary-mark-note">这句要抄进读后感。</p>
    <div class="npr-diary-mark-foot"><span>第 201 页</span><button type="button" class="npr-diary-action">引用</button></div>
  </div>`;

const RAIL = `
  <button type="button" class="npr-diary-marks-rail" aria-label="展开划线面板" aria-expanded="false">
    ${ICON('<path d="m15 18-6-6 6-6"/>')}
    <span class="npr-diary-marks-rail-label">划线·12</span>
  </button>`;

/** 正文列里放一张真的写作卡：`.npr-write` 的 `overflow` / `min-width` 会影响 flow 的宽度。 */
const FLOW = `
  <div class="npr-write" data-variant="reflection">
    <textarea class="npr-write-input" readonly>阅读一本书，就是在跟一个更有经验的头脑对话。</textarea>
    <div class="npr-write-foot"><span>25 字</span><button type="button" class="npr-diary-action">记下来</button></div>
  </div>`;

/**
 * 四种组合：宽/窄 × 展开/收起。
 * ★ 宽度用**内联 style** 写在 `.npr-diary-main` 上（而不是 `.npr-root`）：真机上
 *   划线栏分到多少宽，取决于 `.npr-diary-main` 有多宽，外层容器宽度是另一回事。
 */
const CASES = [
  { key: 'wideOpen', width: WIDE, open: true },
  { key: 'wideShut', width: WIDE, open: false },
  { key: 'tightOpen', width: TIGHT, open: true },
  { key: 'tightShut', width: TIGHT, open: false },
];

const PROBE = `
<script>
(() => {
  const measure = () => {
    const num = (v) => Math.round(v * 100) / 100;
    const box = (el) => { const b = el.getBoundingClientRect(); return { w: num(b.width), h: num(b.height) }; };
    const out = {};
    for (const root of document.querySelectorAll('[data-case]')) {
      const key = root.dataset.case;
      const main = root.querySelector('.npr-diary-main');
      const flow = root.querySelector('.npr-diary-flow');
      const marks = root.querySelector('.npr-diary-marks');
      const rail = root.querySelector('.npr-diary-marks-rail');
      const toggle = root.querySelector('.npr-diary-marks-toggle');
      const label = root.querySelector('.npr-diary-marks-rail-label');
      const head = root.querySelector('.npr-diary-marks-head');
      const marksCs = getComputedStyle(marks);
      out[key] = {
        main: { ...box(main), scroll: main.scrollWidth, client: main.clientWidth },
        flow: { ...box(flow), scroll: flow.scrollWidth, client: flow.clientWidth,
                 minWidth: getComputedStyle(flow).minWidth },
        marks: { ...box(marks), flex: marksCs.flexGrow + ' ' + marksCs.flexShrink + ' ' + marksCs.flexBasis,
                  padding: marksCs.padding, align: marksCs.alignItems,
                  scroll: marks.scrollWidth, client: marks.clientWidth },
        rail: rail ? { ...box(rail), scroll: rail.scrollWidth, client: rail.clientWidth } : null,
        toggle: toggle ? box(toggle) : null,
        head: head ? { ...box(head), scroll: head.scrollWidth, client: head.clientWidth } : null,
        label: label ? { ...box(label), mode: getComputedStyle(label).writingMode } : null,
        /* 收起态还把列表渲染在 DOM 里时，这个数会 > 0 —— 见判据 B6。 */
        cards: root.querySelectorAll('.npr-diary-mark').length,
      };
    }
    document.title = 'D:' + JSON.stringify(out);
  };
  if (document.readyState === 'complete') measure();
  else window.addEventListener('load', measure);
})();
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'npr-crash-'));

function render(extraCss, theme = THEME) {
  const body = CASES.map(({ key, width, open }) => `
    <div class="npr-root" data-case="${key}">
      <div class="npr-diary-main" style="width:${width}px;min-height:520px">
        <div class="npr-diary-flow">${FLOW}</div>
        <aside class="npr-diary-marks${open ? '' : ' is-collapsed'}">${open ? HEADER : RAIL}</aside>
      </div>
    </div>`).join('\n');
  const file = join(dir, `marks-${process.pid}.html`);
  writeFileSync(file, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${theme}</style>
<style>${PANEL_CSS}</style>
<style>${REFINEMENTS}</style>
${extraCss ? `<style>${extraCss}</style>` : ''}
<style>body{display:flex;flex-direction:column;gap:18px;padding:10px 0}</style>
</head><body>
${body}
${PROBE}</body></html>`);
  return file;
}

function run(file) {
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=3000',
    '--dump-dom', file,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  const match = dom.match(/<title>D:([\s\S]*?)<\/title>/);
  if (!match) throw new Error('探针没有回传（document.title 里没有 D: 前缀）');
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

/**
 * 判据。抽成函数是为了让**反向对照**用同一个函数：变异版必须在这里吐失败项。
 * @param {object} d 四种组合的实测
 */
function failuresOf(d) {
  const fails = [];

  // ── A. 展开态：划线栏拿满基准宽，正文让位 ────────────────────────────────
  const wo = d.wideOpen;
  if (!near(wo.marks.w, MARKS_BASIS)) {
    fails.push(`展开态划线栏宽 ${wo.marks.w}px，应为 ${MARKS_BASIS}px —— 收起/展开的差值就是它，基准漂了整条判据都不成立`);
  }
  if (!near(wo.flow.w + wo.marks.w, wo.main.w)) {
    fails.push(`展开态 flow(${wo.flow.w}) + marks(${wo.marks.w}) ≠ main(${wo.main.w}) —— 两栏不是严格并排`);
  }
  if (!wo.toggle) fails.push('展开态没有收起按钮（npr-diary-marks-toggle）—— 用户没法把它收起来');
  else {
    if (!near(wo.toggle.w, 22) || !near(wo.toggle.h, 22)) {
      fails.push(`收起按钮 ${wo.toggle.w}×${wo.toggle.h}，应为 22×22（32px 会把标题行从 18px 撑厚）`);
    }
  }
  if (wo.head && wo.head.scroll > wo.head.client + 1) {
    fails.push(`标题栏溢出 ${wo.head.scroll - wo.head.client}px —— 「划线 12 条」与收起按钮在 300px 里挤不下`);
  }

  // ── B. 收起态：窄轨、正文吃满、列表不渲染 ────────────────────────────────
  const ws = d.wideShut;
  if (!near(ws.marks.w, RAIL_W, 0.6)) {
    fails.push(`收起态划线栏宽 ${ws.marks.w}px，应为 ${RAIL_W}px`);
  }
  /* 挤压态（473px 下划线栏被压到 153px）时标题行也要装得下：
     「划线 12 条」+ 那颗按钮在 153px 里挤不下的话，按钮会被切掉一半。 */
  if (d.tightOpen.head && d.tightOpen.head.scroll > d.tightOpen.head.client + 1) {
    fails.push(`挤压态标题栏溢出 ${d.tightOpen.head.scroll - d.tightOpen.head.client}px —— 收起按钮被挤出面板`);
  }

  /* 挤压态（473px 下划线栏被压到 153px）时标题行也要装得下：
     「划线 12 条」+ 那颗按钮在 153px 里挤不下的话，按钮会被切掉一半。 */
  if (d.tightOpen.head && d.tightOpen.head.scroll > d.tightOpen.head.client + 1) {
    fails.push(`挤压态标题栏溢出 ${d.tightOpen.head.scroll - d.tightOpen.head.client}px —— 收起按钮被挤出面板`);
  }

  /**
   * ★ 这条才是用户的诉求本体：「写读后感的区域自适应」= 让出去的宽度**全部**
   *   落到正文上。只断言「flow 变宽了」是假绿 —— 让 266px 只吃 100px 也叫变宽。
   */
  const freed = wo.marks.w - ws.marks.w;
  const gained = ws.flow.w - wo.flow.w;
  if (!near(gained, freed, 1.5)) {
    fails.push(`正文只吃下 ${gained.toFixed(1)}px，而划线栏让出了 ${freed.toFixed(1)}px —— 「自适应」没落到正文上`);
  }
  if (!ws.rail) fails.push('收起态没有窄轨（npr-diary-marks-rail）—— 这一页没有第二个入口，收起来就再也打不开');
  else {
    if (!near(ws.rail.w, 26)) fails.push(`窄轨按钮宽 ${ws.rail.w}px，应为 26px`);
    if (ws.rail.scroll > ws.rail.client + 1) {
      fails.push(`窄轨内容溢出 ${ws.rail.scroll - ws.rail.client}px —— 竖排标签被 ${RAIL_W}px 切掉了`);
    }
    if (ws.rail.w <= 0 || ws.rail.h <= 0) fails.push(`窄轨没渲染出来（${ws.rail.w}×${ws.rail.h}）`);
    /*
     * ★ 竖排标签的盒子必须落在**按钮内容盒**里。只看 `scrollWidth` 不够：
     *   按钮的 `overflow` 是 `visible`，浏览器对非滚动容器的 scrollWidth 取值
     *   并不统一（Chrome 会把溢出的后代算进去，但这只是实现细节）。
     *   直接比「标签宽 vs 按钮内容宽」是确定的 —— 而且它量的正是「字有没有被切」。
     */
    if (ws.label && ws.label.w > ws.rail.client + 1) {
      fails.push(`竖排标签宽 ${ws.label.w}px > 窄轨内容宽 ${ws.rail.client}px —— 文字被切了`);
    }
  }
  if (!ws.label) fails.push('收起态没有竖排标签 —— 一条只有箭头的窄轨，用户不知道它是「划线」');
  else {
    if (!/vertical/.test(ws.label.mode)) fails.push(`窄排标签的 writing-mode 是 ${ws.label.mode}，不是竖排`);
    if (ws.label.h <= ws.label.w) fails.push(`竖排标签 ${ws.label.w}×${ws.label.h} 没有高过宽 —— 它不是竖排`);
  }
  /* 收起态不许留下列表：DOM 里留着，读屏与拖拽都还能摸到它。 */
  if (ws.cards !== 0) fails.push(`收起态还渲染了 ${ws.cards} 条划线 —— 应当整块不渲染，而不是藏起来`);
  /* 收起态也不该还有「划线」标题行：它和窄轨同时出现，就是两份标题。 */
  if (ws.head) fails.push('收起态还留着标题行 —— 与窄轨里的「划线 12」重复');

  // ── C. 挤压态（AI 面板开着）：正文下限不许破，收起要能救回来 ─────────────
  const to = d.tightOpen;
  if (to.flow.w < 320) {
    fails.push(`挤压态展开时正文只剩 ${to.flow.w}px，低于 320px 下限 —— 0.44.1 那个「一个字一行」会复现`);
  }
  const ts = d.tightShut;
  if (ts.flow.w < 430) {
    fails.push(`挤压态收起后正文只有 ${ts.flow.w}px —— 收起划线栏正是为了让它变宽（预期 ≈439）`);
  }
  if (!near(ts.flow.w + ts.marks.w, ts.main.w)) {
    fails.push(`挤压态收起后 flow(${ts.flow.w}) + marks(${ts.marks.w}) ≠ main(${ts.main.w})`);
  }

  // ── D. 不许横向溢出（四条都查） ──────────────────────────────────────────
  for (const { key } of CASES) {
    const m = d[key].main;
    if (m.scroll > m.client + 1) fails.push(`${key} 横向溢出 ${m.scroll - m.client}px —— 收起只是把「挤」变成「横滚」`);
  }

  return fails;
}

/** 源码级：JSX 与 CSS 里那几处「只能靠读代码发现」的东西。 */
function sourceFailures(jsx, css) {
  const fails = [];
  if (!/npr-diary-marks-toggle/.test(jsx)) fails.push('JSX 里没有收起按钮');
  if (!/npr-diary-marks-rail/.test(jsx)) fails.push('JSX 里没有展开窄轨');
  if (!/setMarksPanel\(false\)/.test(jsx)) fails.push('收起按钮没接上状态');
  if (!/setMarksPanel\(true\)/.test(jsx)) fails.push('窄轨没接上状态');
  if (!/aria-expanded="true"/.test(jsx) || !/aria-expanded="false"/.test(jsx)) {
    fails.push('收起/展开两态缺 aria-expanded —— 读屏软件读不出「现在是开还是关」');
  }
  if (!/localStorage\.getItem\('npr\.diaryMarksOpen'\) !== '0'/.test(jsx)) {
    fails.push("默认态不是「展开」（应为 localStorage.getItem('npr.diaryMarksOpen') !== '0'）—— 收起是主动动作，不该是初始值");
  }
  if (!/localStorage\.setItem\('npr\.diaryMarksOpen'/.test(jsx)) {
    fails.push('收起状态没有写回 localStorage —— 每次重开都复位，等于没记住');
  }
  /*
   * ★ 「收起态不渲染列表」的源码级判据：列表的 `.map` 必须出现在
   *   `marksPanelOpen ?` **之后**（即位于真值分支里）。位置反过来 ——
   *   把三元改成 `marksPanelOpen ? null : (...)` 之类的写法 —— 也能过 D1~D3，
   *   但列表就跑到了假分支里。这里用**下标**比，不用正则花活。
   */
  const gateIdx = jsx.indexOf('marksPanelOpen ? (');
  const mapIdx = jsx.indexOf('annotations.items.map((item) => (');
  if (gateIdx < 0) fails.push('找不到 `marksPanelOpen ? (` 这个开关');
  else if (mapIdx < 0) fails.push('找不到划线的 .map');
  else if (mapIdx < gateIdx) fails.push('划线列表写在开关**之前** —— 收起时它照样渲染');
  if (!/\.npr-root \.npr-diary-marks\.is-collapsed \{[^}]*flex: 0 0 34px/.test(css)) {
    fails.push('CSS 里没有「收起态不许再被压缩」的那条（flex: 0 0 34px）—— AI 面板一开会把窄轨压成一条缝');
  }
  /*
   * ★ `text-orientation: upright` 不能少：默认的 `mixed` 会把「12」整体旋转 90°，
   *   竖排里看起来像一个「已」字。这条**量不出来**（旋转不改变盒子尺寸，
   *   所有几何判据都还是绿的），只能在这里钉。
   */
  /* ★ 必须落在**规则体**里：只搜 `text-orientation: upright` 会被上面那段注释蒙过去 —
     删掉声明、留下注释，判据照样是绿的（第一版就是这么假绿的）。 */
  if (!/\.npr-diary-marks-rail-label \{[^}]*text-orientation: upright/.test(css)) {
    fails.push('竖排标签没写 text-orientation: upright —— 数字会被转 90°，看起来像另一个字');
  }
  if (!/\.npr-diary-marks \{[^}]*flex: 0 1 300px/.test(css)) {
    fails.push('展开态的 `flex: 0 1 300px` 不见了 —— 划线栏会重新变成「一个像素都不让」');
  }
  return fails;
}

const shotIdx = process.argv.indexOf('--shot');
if (shotIdx !== -1) {
  const target = process.argv[shotIdx + 1];
  if (!target) throw new Error('--shot 后面要跟一个输出路径');
  writeFileSync(target, readFileSync(render('', process.argv.includes('--dark') ? THEME_DARK : THEME)));
  console.log(`已写出夹具 → ${target}`);
  process.exit(0);
}

let bad = 0;
const fail = (msg) => { bad += 1; console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

const measured = run(render(''));
const fails = failuresOf(measured);
if (fails.length === 0) {
  const wo = measured.wideOpen; const ws = measured.wideShut;
  ok(`宽窗（${WIDE}px）：展开 flow=${wo.flow.w} / 收起 flow=${ws.flow.w}（+${(ws.flow.w - wo.flow.w).toFixed(1)}，划线栏 ${wo.marks.w} → ${ws.marks.w}）`);
  const to = measured.tightOpen; const ts = measured.tightShut;
  ok(`挤压（${TIGHT}px）：展开 flow=${to.flow.w} / 收起 flow=${ts.flow.w}，四条都无横向溢出`);
  ok('收起态窄轨 26px 在场、竖排标签成立、列表不渲染、标题不重复');
} else for (const f of fails) fail(f);

const srcFails = sourceFailures(DIARY, REFINEMENTS);
if (srcFails.length === 0) ok('源码：两态接线 / aria-expanded / 默认展开 / localStorage / 列表在真值分支内 / 竖排直立 / 两条 CSS');
else for (const f of srcFails) fail(f);

/**
 * 反向对照：喂变异 CSS，**同一个 failuresOf** 必须吐出对得上的那条。
 * 只判「有失败」不够 —— 要判「失败的是我以为的那一条」，否则可能只是别的断言顺手红了。
 */
function mutant(label, css, expect) {
  const f = failuresOf(run(render(css)));
  const hit = f.find((m) => m.includes(expect));
  if (hit) ok(`★ 反向对照：${label} → ${hit.slice(0, 46)}…`);
  else fail(`★ 反向对照失效：${label} 之后判据没认出来（实际失败：${f.join(' | ') || '无'}）`);
}

mutant('把收起态宽度改回 300px',
  '.npr-root .npr-diary-marks.is-collapsed { flex: 0 1 300px }', '收起态划线栏宽');
mutant('把窄轨按钮撑到 40px',
  '.npr-root .npr-diary-marks-rail { width: 40px }', '窄轨按钮宽');
mutant('把竖排标签的字号放大到 30px（超过轨的内容宽）',
  '.npr-diary-marks-rail-label { font-size: 30px }', '竖排标签宽');
mutant('把竖排标签改成横排',
  '.npr-diary-marks-rail-label { writing-mode: horizontal-tb }', '不是竖排');
mutant('取消正文列下限（挤压态会被压死）',
  '.npr-diary-flow { min-width: 0 }', '低于 320px 下限');

/* 源码级反向对照：这一条量不出来（旋转不改盒子），只能拿变异源码去喂 sourceFailures。 */
{
  const f = sourceFailures(DIARY, REFINEMENTS.split('text-orientation: upright').join(''));
  const hit = f.find((m) => m.includes('text-orientation'));
  if (hit) ok(`★ 反向对照：去掉 text-orientation: upright → ${hit.slice(0, 40)}…`);
  else fail(`★ 反向对照失效：去掉 text-orientation: upright，源码判据没认出来（实际：${f.join(' | ') || '无'}）`);
}

if (bad === 0) console.log('\nALL OK');
else { console.log(`\n${bad} 项失败`); process.exitCode = 1; }
