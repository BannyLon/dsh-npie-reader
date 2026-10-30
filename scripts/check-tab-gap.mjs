/**
 * 三处「工具栏 → 切换控件」的**纵向间距**：必须都是 8px（上下各 8）。
 *
 * ---- 为什么需要这道判据 ----------------------------------------------------
 *
 * `check-tabs.mjs` 量了切换控件自己的几何（高度 / 圆角 / 字号 / 字重 / 内边距 /
 * 宽度 / 底色关系），**一条 margin 都没查**。于是三处的上边距各写各的：
 *   · RSS 一级筛选条 `.npr-filters-primary`  margin-top 0
 *   · 书架分页 `.npr-libtabs`                  margin-top 0
 *   · 日记三模块 `.npr-diary-modes`            margin-top 6（0.44.5 为「与工具栏断开」加的）
 * 画出来是 8 / 8 / 11 —— 用户 2026-10-30 拿三张截图直接指出「这三个的上下间距没有统一」。
 * 判据全绿、人眼一眼不齐，说明「量了控件、没量控件之间」。
 *
 * ---- 量的口径 --------------------------------------------------------------
 *
 * 上间距 = 切换控件上沿 − 工具栏**内容区**下沿。
 *   ★ 不能用工具栏**盒底**：盒底含 5px 内边距，量出来会少 5px，看着像「上 3 / 下 8」。
 *   ★ 工具栏本身没有底色（画出来的只有里面的图标），所以「内容区下沿」就是那排控件的
 *     排版边界 —— 这是唯一一个既能定义、又与眼睛对得上的基准。
 * 下间距 = 下一块的上沿 − 切换控件下沿（含它自己的 margin-bottom）。
 *
 * ---- 为什么是「相等 + 绝对值」两条 ------------------------------------------
 *
 * 只查相等：三处一起被改成 0 或 30 也算通过。
 * 只查绝对值：三处各自漂成 8 / 8 / 11 时，只要有一处等于 8 就不会报「不齐」。
 * 两条都要，缺一条都会给出假绿。
 *
 * 用法：node scripts/check-tab-gap.mjs
 * 退出码：0 = 三处 × 三个宽度全部 8 / 8；1 = 有不齐或不是 8。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const panelSrc = readFileSync(join(ROOT, 'src/client/ReaderPage.jsx'), 'utf8');
const panelMatch = /const PANEL_CSS = `([\s\S]*?)\n`;/.exec(panelSrc);
if (!panelMatch) throw new Error('没从 ReaderPage.jsx 里抽出 PANEL_CSS —— 骨架缺失时量出来的是假几何，拒绝继续');
const PANEL_CSS = panelMatch[1];
const REFINEMENTS = readFileSync(join(ROOT, 'src/client/refinements.css'), 'utf8');

/** 字体栈照抄真机（PingFang）：文案宽度会影响是否换行，但上边距与文案无关。 */
const FONT = `font-family: -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 13px; line-height: 1.5;`;

const THEME = `
:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f5f5f7;--dsw-alias-label-primary:#1b1b1f;
  --dsw-alias-label-secondary:#6b6b73;--dsw-alias-label-tertiary:#8e8e96;--dsw-alias-border-l1:#e3e3e8;
  --dsw-alias-border-l2:#cfcfd6;--dsw-alias-interactive-bg-hover:#f1f1f4;--dsw-alias-bg-layer-3:#fff;
  --dsw-alias-brand-primary:#2f9e6e;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#2f9e6e}
html,body{margin:0;padding:0;background:#fff}
.npr-root{${FONT}}`;

const ICON = '<span class="probe-icon"></span>';
const SW = (on) => `<div class="npr-viewswitch" role="group" aria-label="主视图">${
  ['订阅', '书', '日记'].map((n, i) => `<button type="button" aria-pressed="${i === on}" aria-label="${n}">${ICON}</button>`).join('')
}</div>`;

/** 三处真结构，逐字照抄 JSX（属性名、aria 状态、文案）。 */
const PANELS = {
  rss: {
    label: 'RSS 侧栏',
    toolbar: `<div class="npr-sidebar-toolbar" data-window-drag>${SW(0)}
      <button type="button" class="npr-channel" aria-haspopup="dialog"><span class="npr-channel-mark all">${ICON}</span><span class="npr-channel-label">我的订阅</span></button>
      <button type="button" class="npr-icon" aria-label="添加订阅源">${ICON}</button>
      <button type="button" class="npr-icon" aria-label="搜索">${ICON}</button>
      <button type="button" class="npr-icon" aria-label="刷新">${ICON}</button>
      <button type="button" class="npr-icon npr-settings-button" aria-label="插件设置">${ICON}</button>
    </div>`,
    tabs: `<div class="npr-filters npr-filters-primary" role="group" aria-label="阅读状态">
      <button type="button" aria-pressed="true">全部</button><button type="button" aria-pressed="false">未读</button>
      <button type="button" aria-pressed="false">收藏</button><button type="button" aria-pressed="false">已隐藏 1</button>
    </div>`,
    next: `<div class="npr-status" role="status">1 个订阅源，最近一次检查在 3 小时前</div>`,
  },
  library: {
    label: '书架侧栏',
    toolbar: `<div class="npr-sidebar-toolbar" data-window-drag>${SW(1)}
      <button type="button" class="npr-icon npr-lib-refresh" aria-label="重新读取书单">${ICON}</button>
      <button type="button" class="npr-icon npr-settings-button" aria-label="插件设置">${ICON}</button>
    </div>`,
    tabs: `<div class="npr-libtabs" role="group" aria-label="书架分页">
      <button type="button" aria-pressed="true">阅读</button><button type="button" aria-pressed="false">书架</button>
    </div>`,
    next: `<div class="npr-lib-controls"><div class="npr-lib-row"><input class="npr-lib-search" placeholder="搜索书名 / 丛书…" /></div></div>`,
  },
  diary: {
    label: '日记侧栏',
    toolbar: `<div class="npr-sidebar-toolbar" data-window-drag>${SW(2)}
      <button type="button" class="npr-icon" aria-label="搜索日记">${ICON}</button>
      <button type="button" class="npr-icon" aria-label="打开日记文件夹">${ICON}</button>
      <button type="button" class="npr-icon" aria-label="导出全部日记">${ICON}</button>
    </div>`,
    tabs: `<div class="npr-diary-modes" role="group" aria-label="日记功能">
      <button type="button" aria-pressed="true">灵感速记</button><button type="button" aria-pressed="false">私密日记</button>
      <button type="button" aria-pressed="false">读后感</button>
    </div>`,
    next: `<div class="npr-status" role="status">日记共 4 天</div>`,
  },
};

const PROBE = `
<script>
(() => {
  const measure = () => {
    const out = {};
    for (const aside of document.querySelectorAll('[data-panel]')) {
      const id = aside.getAttribute('data-panel');
      const bar = aside.querySelector('.npr-sidebar-toolbar');
      const tabs = aside.querySelector('.npr-libtabs, .npr-filters-primary, .npr-diary-modes');
      const next = tabs.nextElementSibling;
      const b = bar.getBoundingClientRect();
      const t = tabs.getBoundingClientRect();
      const n = next ? next.getBoundingClientRect() : null;
      const padBottom = parseFloat(getComputedStyle(bar).paddingBottom);
      out[id] = {
        gapAbove: +(t.top - (b.bottom - padBottom)).toFixed(2),
        gapBelow: n ? +(n.top - t.bottom).toFixed(2) : null,
        marginTop: parseFloat(getComputedStyle(tabs).marginTop),
        marginBottom: parseFloat(getComputedStyle(tabs).marginBottom),
      };
    }
    document.title = 'D:' + JSON.stringify(out);
  };
  if (document.readyState === 'complete') measure();
  else window.addEventListener('load', measure);
})();
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'npr-tabgap-'));
let seq = 0;

function render(width, extraCss = '') {
  const body = Object.entries(PANELS)
    .map(([key, p]) => `<aside class="npr-sidebar" data-panel="${key}">${p.toolbar}${p.tabs}${p.next}</aside>`)
    .join('\n');
  const file = join(dir, `gap-${width}-${seq++}.html`);
  writeFileSync(file, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${THEME}</style>
<style>${PANEL_CSS}</style>
<style>${REFINEMENTS}</style>
${extraCss ? `<style>${extraCss}</style>` : ''}
<style>
.npr-sidebar{width:${width}px;box-sizing:border-box;padding:10px 0;border-bottom:1px solid #eee}
.probe-icon{display:inline-block;width:13px;height:13px;border-radius:3px;background:#c9c9ce}
.npr-root .npr-channel{display:inline-flex;align-items:center;gap:6px;max-width:110px}
.npr-root .npr-channel-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head><body><div class="npr-root" style="width:${width}px">${body}</div>${PROBE}</body></html>`);
  return file;
}

function run(file) {
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=3000', '--dump-dom', file,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  const match = dom.match(/<title>D:([\s\S]*?)<\/title>/);
  if (!match) throw new Error('探针没有回传（document.title 里没有 D: 前缀）');
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

const uniq = (values) => [...new Set(values.map(String))];

/** 一组判据。抽成函数是为了让**反向对照**用同一份逻辑。 */
function gapFailures(d) {
  const fails = [];
  const above = Object.entries(d).map(([k, v]) => [PANELS[k].label, v.gapAbove]);
  const below = Object.entries(d).map(([k, v]) => [PANELS[k].label, v.gapBelow]);
  const fmt = (pairs) => pairs.map(([k, n]) => `${k}=${n}`).join(' / ');
  if (uniq(above.map(([, n]) => n)).length !== 1) fails.push(`上间距不一致：${fmt(above)}`);
  if (uniq(below.map(([, n]) => n)).length !== 1) fails.push(`下间距不一致：${fmt(below)}`);
  /** 绝对值也钉住：只查「相等」时，三处一起被改成 0 或 30 也算通过。 */
  const top = uniq(above.map(([, n]) => n));
  const bottom = uniq(below.map(([, n]) => n));
  if (top.length === 1 && Number(top[0]) !== 8) fails.push(`上间距应为 8px，实际 ${top[0]}（${fmt(above)}）`);
  if (bottom.length === 1 && Number(bottom[0]) !== 8) fails.push(`下间距应为 8px，实际 ${bottom[0]}（${fmt(below)}）`);
  return fails;
}

let bad = 0;
function check(ok, message) {
  if (!ok) bad += 1;
  console.log(`${ok ? '  ok  ' : '  ✗   '} ${message}`);
}

/** 256 = 侧栏下限（0.45.2 之后拖不动更窄）；300 = 默认；360 = 拖宽。 */
for (const width of [256, 300, 360]) {
  const d = run(render(width));
  const fails = gapFailures(d);
  const row = Object.entries(d).map(([k, v]) => `${PANELS[k].label} ${v.gapAbove}/${v.gapBelow}`).join(' · ');
  check(fails.length === 0, `${width}px  ${row}`);
  for (const f of fails) check(false, `${width}px  ${f}`);
}

/**
 * 反向对照：每一条都必须**变红且理由对得上**。
 * ★ 变异一律走 extraCss（head 里更靠后、同特异度即胜），**不写盘**：
 *   改源码再还原的写法在 SIGTERM 下会把变异体留在盘上（本项目踩过）。
 */
const MUTANTS = [
  {
    name: '日记三模块退回 6px（用户截图里那条多出来的空）',
    css: '.npr-root .npr-diary-modes { margin-top: 6px; }',
    expect: /上间距不一致.*日记侧栏=11/,
  },
  {
    name: 'RSS 一级筛选条退回 0',
    css: '.npr-root .npr-filters-primary { margin-top: 0; }',
    expect: /上间距不一致.*RSS 侧栏=5/,
  },
  {
    name: '书架分页退回 0',
    css: '.npr-root .npr-libtabs { margin-top: 0; }',
    expect: /上间距不一致.*书架侧栏=5/,
  },
  {
    name: '变量改 0（三处仍相等，只是整体变小）',
    css: '.npr-root { --npr-tab-gap-top: 0px; }',
    expect: /上间距应为 8px，实际 5/,
  },
  {
    name: '变量改 10（三处仍相等，只是整体变大）',
    css: '.npr-root { --npr-tab-gap-top: 10px; }',
    expect: /上间距应为 8px，实际 15/,
  },
];

for (const m of MUTANTS) {
  const fails = gapFailures(run(render(300, m.css)));
  const hit = fails.some((f) => m.expect.test(f));
  check(hit, `★ 反向对照：${m.name}${hit ? '' : ` —— 判据没咬住（实际：${fails.join(' | ') || '无'}）`}`);
}

console.log(bad === 0 ? '\nALL OK' : `\n${bad} 条不合格`);
process.exit(bad === 0 ? 0 : 1);
