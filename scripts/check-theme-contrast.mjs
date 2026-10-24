/**
 * 阅读主题的**真渲染**核对：六种纸色 × 宿主明暗两态，在真 Chrome 里量 computed style。
 *
 * 它回答的问题都不是「读代码能读出来」的：
 *   ① 修好之后，同一纸色在**宿主明/暗两种状态**下算出来的字色是否**逐字节相同**
 *      —— 这才是「两轴正交」的定义。只要还有一处挂在 --dsw-* 上，这里就会分叉。
 *   ② 每一档字色对纸底的 WCAG 对比度是否 ≥4.5（11–13px 的小字）。
 *   ③ 伴读容器里那两张宿主原生对话卡片有没有底色（P0-2 的症状是「透明」）。
 *   ④ 顺带**自证**：把 Chrome 算出来的颜色与 `test/theme-contrast.test.mjs` 里那套
 *      纯 Node 的 color-mix 实现逐通道比对。两处一旦分叉，说明「单元测试里的数字」
 *      不再代表真机 —— 那比没有单元测试更糟（假绿）。
 *
 * 运行：node scripts/check-theme-contrast.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 Chrome 不可用（**不静默跳过**）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Chrome 候选路径。
 * ★ 找不到就**报错退出**，绝不「跳过」：一个会静默跳过的检查等于没有这个检查
 *   （`scripts/check-host-contract.mjs` 里那 4 组静默跳过就是教训）。
 */
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

// ---- 1. 从真实源码里取 CSS 与调色板 ---------------------------------------
const readerSrc = readFileSync(join(pluginRoot, 'src/client/ReaderPage.jsx'), 'utf8');
const cssStart = readerSrc.indexOf('const PANEL_CSS = `');
const cssEnd = readerSrc.indexOf('`;', cssStart);
const PANEL_CSS = readerSrc.slice(cssStart + 'const PANEL_CSS = `'.length, cssEnd);
const REFINEMENTS = readFileSync(join(pluginRoot, 'src/client/refinements.css'), 'utf8');
if (!PANEL_CSS.includes('.npr-summary')) throw new Error('抽 PANEL_CSS 失败（边界切错了）');

const paletteAt = readerSrc.indexOf('const THEME_COLORS = {');
const paletteBlock = readerSrc.slice(paletteAt, readerSrc.indexOf('};', paletteAt));
const PALETTE = {};
for (const m of paletteBlock.matchAll(/(\w+)\s*:\s*\[\s*'(#[0-9a-fA-F]{3,8})'\s*,\s*'(#[0-9a-fA-F]{3,8})'\s*\]/g)) {
  PALETTE[m[1]] = { bg: m[2], fg: m[3] };
}
const THEMES = Object.keys(PALETTE);
const THEMED_SELECTOR = '.npr-root[data-reading-theme]:not([data-reading-theme=auto]){';

// ---- 2. 宿主令牌：明 / 暗两套 ---------------------------------------------
// 浅色那套是从真机 app.asar 里抄出来的；深色那套按同一组语义角色配。
// 这套数字只影响「宿主态」这一维，而本检查要证明的正是**结果与它无关**。
const HOST = {
  light: {
    base: '#ffffff', layer1: '#f7f8f9', layer2: '#f1f2f4', layer3: '#ffffff',
    labelPrimary: '#0f1115', labelSecondary: '#61666b', labelTertiary: '#81858c',
    border1: '#e6e8ea', border2: '#d5d8dc', hover: '#f1f2f4', brand: '#3d58e0',
  },
  dark: {
    base: '#1b1c1e', layer1: '#232426', layer2: '#2a2b2e', layer3: '#232426',
    labelPrimary: '#ecedef', labelSecondary: '#a4a8ad', labelTertiary: '#7c8085',
    border1: '#34363a', border2: '#43464a', hover: '#26272a', brand: '#7d92ff',
  },
};
const hostCss = (t) => `:root, body {
  --dsw-alias-bg-base: ${t.base}; --dsw-alias-bg-layer-1: ${t.layer1};
  --dsw-alias-bg-layer-2: ${t.layer2}; --dsw-alias-bg-layer-3: ${t.layer3};
  --dsw-alias-bg-mask-1: rgba(15,17,21,.4);
  --dsw-alias-label-primary: ${t.labelPrimary}; --dsw-alias-label-secondary: ${t.labelSecondary};
  --dsw-alias-label-tertiary: ${t.labelTertiary};
  --dsw-alias-border-l1: ${t.border1}; --dsw-alias-border-l2: ${t.border2};
  --dsw-alias-interactive-bg-hover: ${t.hover}; --dsw-alias-brand-primary: ${t.brand};
  --dsw-alias-state-error-primary: #d92d20;
  --dsw-elevation-panel: 0 8px 24px rgba(0,0,0,.12); --dsw-shadow-lv3: 0 8px 24px rgba(0,0,0,.12);
  --dsw-focus-ring-width: 1px; --dsw-focus-ring-color: ${t.brand};
}`;

/**
 * 夹具：每个「纸色 × 宿主态」一个 .npr-root。
 *
 * ★ 三档必须走**真实的类**（.npr-title / .npr-summary / .npr-date），不能自己写
 *   `color: var(--npr-muted)`：那样量到的是「我以为的取色」，而不是组件真的取了什么。
 */
const cell = (theme, host, { bg, fg }) => `
<div class="npr-root" id="root-${theme}-${host}" data-reading-theme="${theme}"
     style="--npr-bg:${bg};--npr-bg-2:${bg};--npr-fg:${fg}">
  <h3 class="npr-title" id="t-${theme}-${host}">标题</h3>
  <p class="npr-summary" id="m-${theme}-${host}">摘要文字，用 --npr-muted</p>
  <span class="npr-date" id="f-${theme}-${host}">10月9日</span>
  <div class="npr-companion"><div class="host-chat-card" id="c-${theme}-${host}">伴读卡片</div></div>
</div>`;

const fixture = (hostName) => `<!doctype html><meta charset="utf-8">
<style id="host">${hostCss(HOST[hostName])}
html, body { margin: 0; background: ${HOST[hostName].base}; color: ${HOST[hostName].labelPrimary};
  font: 14px -apple-system, "Helvetica Neue", sans-serif; }</style>
<style id="panel">${PANEL_CSS}</style>
<style id="refinements">${REFINEMENTS}</style>
<style id="hostchat">.host-chat-card { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); padding: 8px; }</style>
${THEMES.map((theme) => cell(theme, hostName, PALETTE[theme])).join('\n')}`;

// ---- 3. 在真 Chrome 里量 ---------------------------------------------------
const PROBE = `
const out = { rows: {}, companion: {} };
for (const theme of THEMES) {
  const root = document.getElementById('root-' + theme + '-' + HOSTNAME);
  const cs = getComputedStyle(root);
  out.rows[theme] = {
    bg: cs.backgroundColor,
    title: getComputedStyle(document.getElementById('t-' + theme + '-' + HOSTNAME)).color,
    summary: getComputedStyle(document.getElementById('m-' + theme + '-' + HOSTNAME)).color,
    date: getComputedStyle(document.getElementById('f-' + theme + '-' + HOSTNAME)).color,
    muted: cs.getPropertyValue('--npr-muted').trim(),
    faint: cs.getPropertyValue('--npr-faint').trim(),
    chatBg: cs.getPropertyValue('--npr-chat-bg').trim(),
  };
  const card = getComputedStyle(document.getElementById('c-' + theme + '-' + HOSTNAME));
  out.companion[theme] = { bg: card.backgroundColor, color: card.color, border: card.borderTopColor };
}
const pre = document.createElement('pre');
pre.id = 'probe-out';
pre.textContent = JSON.stringify(out);
document.body.appendChild(pre);
`;

function measure(hostName) {
  const dir = mkdtempSync(join(tmpdir(), `npr-theme-${hostName}-`));
  const htmlPath = join(dir, 'probe.html');
  writeFileSync(htmlPath, `${fixture(hostName)}\n<script>
const THEMES = ${JSON.stringify(THEMES)};
const HOSTNAME = ${JSON.stringify(hostName)};
${PROBE}
<\/script>\n`, 'utf8');
  const res = spawnSync(CHROME, [
    '--no-sandbox', '--disable-gpu', '--headless', '--virtual-time-budget=2000',
    '--dump-dom', `file://${htmlPath}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`chrome 启动失败：${res.error.message}`);
  const m = /<pre id="probe-out">([\s\S]*?)<\/pre>/.exec(res.stdout);
  if (!m) throw new Error(`没拿到探针结果（脚本抛了？）\n${res.stdout.slice(-1500)}`);
  const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  return JSON.parse(decoded);
}

// ---- 4. 颜色数学（与 test/theme-contrast.test.mjs 同源）--------------------
/**
 * 把 computed style 里的颜色串解析成 0–255 的三个通道。
 *
 * ★ 必须同时认三种形态 —— 只认 `rgb()` 会**静默算错**，不是抛错（本项目实测过）：
 *   - `rgb(r, g, b)` / `rgba(r, g, b, a)`：整数通道，`slice(0, 3)` 丢掉 alpha。
 *   - `color(srgb r g b)`：真实属性（如 `color:`）在需要保留精度时给这个，
 *     **通道是 0–1 的浮点**。用 `match(/\d+/g)` 去抠 `0.265412` 会拆成
 *     `'0'` 与 `'265412'` 两段 ⇒ 得到 `[0, 265412, 0]` 这种垃圾。
 *   - `#rrggbb`：自定义属性经 var() 替换之后的形态。
 */
const rgbOf = (css) => {
  const text = String(css).trim();
  // 先认 `color(srgb …)`：它与 `rgb()` 的唯一差别是「通道是 0–1」，但顺序反了就会抠坏。
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text);
  if (srgb) return [1, 2, 3].map((i) => Math.round(Number(srgb[i]) * 255));
  if (/^#[0-9a-fA-F]{3,8}$/.test(text)) return parseHex(text);
  return text.match(/\d+/g).slice(0, 3).map(Number);
};
const parseHex = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const luminance = ([r, g, b]) => {
  const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const mixSrgb = (a, b, p) => a.map((c, i) => c * p + b[i] * (1 - p));

/** 从 PANEL_CSS 的派生规则里取某个 token 的比例 —— 与单元测试解析的是同一处。 */
function ratioOf(token) {
  const at = PANEL_CSS.indexOf(THEMED_SELECTOR);
  if (at === -1) throw new Error('PANEL_CSS 里没有主题派生规则');
  const rule = PANEL_CSS.slice(at, PANEL_CSS.indexOf('}', at));
  const m = new RegExp(`--npr-${token}:color-mix\\(in srgb,var\\(--npr-fg\\) (\\d+)%`).exec(rule);
  if (!m) throw new Error(`找不到 --npr-${token} 的派生比例`);
  return Number(m[1]) / 100;
}

// ---- 5. 判定 ---------------------------------------------------------------
const fail = [];
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) fail.push(name);
};

console.log(`Chrome: ${CHROME}`);
console.log(`纸色 ${THEMES.length} 种 × 宿主 2 态\n`);

/**
 * ⓪ 解析器自检。
 *
 * ★ 放在最前面，因为 ② 与 ④ 都建立在 `rgbOf` 上，而它坏掉时**不会抛错**：
 *   实测（0.8.8 第一次跑）它把 `color(srgb 0.265412 0.268706 0.278588)` 抠成
 *   `[0, 265412, 0]` ⇒ 亮度爆表 ⇒ ② 的「次要 / 更次要」用**垃圾数字通过**
 *   （打印出 `10452021.16` 这种对比度），而 ④ 报一堆 `Δ=NaN`。
 *   假绿比没有断言更糟，所以先自证解析器本身。
 */
console.log('=== ⓪ 颜色串解析器自检（② 与 ④ 都靠它）===');
{
  const naive = (css) => css.match(/\d+/g).slice(0, 3).map(Number);
  const srgbText = 'color(srgb 0.265412 0.268706 0.278588)';
  const same = (name, actual, want) => check(`解析器 ${name}`,
    JSON.stringify(actual) === JSON.stringify(want), JSON.stringify(actual));
  same('rgb()', rgbOf('rgb(32, 33, 36)'), [32, 33, 36]);
  same('rgba() 丢掉 alpha', rgbOf('rgba(0, 0, 0, 0)'), [0, 0, 0]);
  same('color(srgb) 按 0–1 换算', rgbOf(srgbText), [68, 69, 71]);
  same('hex', rgbOf('#f5efdf'), [245, 239, 223]);
  // 反向对照：朴素的「抠数字」实现必须在这条上露馅 —— 否则上面那条没牙。
  check('反向对照：朴素抠数字确实会算错', JSON.stringify(naive(srgbText)) !== JSON.stringify([68, 69, 71]),
    JSON.stringify(naive(srgbText)));
}
console.log('');

const light = measure('light');
const dark = measure('dark');

console.log('=== ① 同一纸色在宿主明/暗两态下必须算出同一组颜色 ===');
for (const theme of THEMES) {
  for (const key of ['bg', 'title', 'summary', 'date', 'muted', 'faint', 'chatBg']) {
    const same = light.rows[theme][key] === dark.rows[theme][key];
    check(`${theme}.${key}`, same, same ? light.rows[theme][key] : `light=${light.rows[theme][key]} dark=${dark.rows[theme][key]}`);
  }
}

console.log('\n=== ② 每一档对纸底的 WCAG 对比度 ≥4.5 ===');
const worst = { value: Infinity };
for (const [hostName, measured] of [['light', light], ['dark', dark]]) {
  for (const theme of THEMES) {
    const row = measured.rows[theme];
    const bg = rgbOf(row.bg);
    for (const [label, key] of [['正文', 'title'], ['次要', 'summary'], ['更次要', 'date']]) {
      const value = contrast(rgbOf(row[key]), bg);
      if (value < worst.value) Object.assign(worst, { value, theme, host: hostName, label });
      check(`${hostName}/${theme} ${label}`, value >= 4.5, value.toFixed(2));
    }
  }
}
console.log(`\n最差组合：${worst.host}/${worst.theme} ${worst.label} = ${worst.value.toFixed(2)}`);

console.log('\n=== ③ 伴读容器：宿主原生对话卡片必须有底色（P0-2 的症状是「透明」）===');
for (const theme of THEMES) {
  const card = light.companion[theme];
  check(`${theme} 卡片有底色`, card.bg !== 'rgba(0, 0, 0, 0)', `bg=${card.bg}`);
  const value = contrast(rgbOf(card.color), rgbOf(card.bg));
  check(`${theme} 卡片文字对比度`, value >= 4.5, `${value.toFixed(2)}`);
}

console.log('\n=== ④ 自证：纯 Node 的 color-mix 实现 vs Chrome 实测 ===');
/**
 * ★ 量的是**元素上真实生效的颜色**（`.npr-summary` / `.npr-date` 的 computed `color`），
 *   而**不是**自定义属性 `--npr-muted` / `--npr-faint` 本身。
 *
 *   为什么（0.8.8 第一次跑就栽在这）：按 CSS 规范，**自定义属性的 computed value
 *   不做 `color-mix()` 求值** —— `getComputedStyle().getPropertyValue('--npr-muted')`
 *   返回的是「var() 替换之后的 token 流」，实测就是字符串
 *   `color-mix(in srgb,#202124 84%,#ffffff)`。
 *   （`var()` 替换是会做的，所以 `--npr-chat-bg` 那种纯 var() 链读得到 `#ffffff`；
 *   只有 `color-mix()` 这种函数值原样留着。）
 *   ⇒ 拿它去比通道，比的是「`#202124` 的十六进制数字」与「84 这个百分比」，
 *   得到的 Δ 只能是 NaN。① 段里的 summary / date 之所以一直是对的，正因为它们是真实属性。
 */
for (const theme of THEMES) {
  const bg = parseHex(PALETTE[theme].bg);
  const fg = parseHex(PALETTE[theme].fg);
  for (const [token, key] of [['muted', 'summary'], ['faint', 'date']]) {
    const expected = mixSrgb(fg, bg, ratioOf(token));
    const actual = rgbOf(light.rows[theme][key]);
    const delta = Math.max(...expected.map((v, i) => Math.abs(v - actual[i])));
    check(`${theme} --npr-${token}`, delta <= 1,
      `node=${expected.map((v) => Math.round(v))} chrome=${actual} Δ=${delta.toFixed(2)}`);
  }
}

console.log('\n---- 结论 ----');
if (fail.length === 0) {
  console.log('全部断言通过');
} else {
  console.log(`${fail.length} 条断言失败：`);
  for (const name of fail) console.log(`  - ${name}`);
}
process.exit(fail.length === 0 ? 0 : 1);
