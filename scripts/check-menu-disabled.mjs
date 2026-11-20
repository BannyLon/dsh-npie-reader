/**
 * 「更多操作」菜单项的**禁用态**真机核对。
 *
 * ★ 它回答的问题不是「读代码能读出来」的
 * ----------------------------------------
 * 「更多操作 → 重新生成译文」在生成期间是 `disabled` 的（`selected?.generating` 非空）。
 * 但**光有 `disabled` 属性不等于用户看得出**：本插件里 `.npr-menu button` 曾经
 * **一条 `:disabled` 规则都没有**（全插件唯一漏掉的一处 —— 别的禁用按钮都有
 * `opacity` + `cursor` 规则），于是那个条目是：
 *
 *   - `opacity` 仍是 1（跟可点的条目长得一模一样）；
 *   - `cursor` 仍是 `pointer`（鼠标变手型，像是在邀请你点）；
 *   - `:hover` 照样给底色高亮（**最误导的一条**）。
 *
 * ⇒ 用户重开菜单看到的是「看着能点、点了没反应」。
 *   `disabled` 属性在 DOM 上是对的，**错的是没有把它画出来** ——
 *   这类问题只能量 computed style，读 JSX 读不出来。
 *
 * ★ 反向对照（自证测量有牙）
 * --------------------------
 * 同一个夹具再跑一遍，但把 `:disabled` 规则从 CSS 里**摘掉**：
 * 如果量出来的 `opacity` / `cursor` 不跟着变，说明这个测量跟那条规则无关，
 * 那么「修好之后全绿」也是假绿。
 *
 * 运行：node scripts/check-menu-disabled.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 Chrome 不可用（**不静默跳过**）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** ★ 找不到 Chrome 就报错退出，绝不静默跳过（静默跳过的检查等于没有）。 */
const CHROME_CANDIDATES = [
  process.env.NPIE_CHROME,
  join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome。设 NPIE_CHROME=<可执行文件> 再跑。候选：');
  for (const p of CHROME_CANDIDATES) console.error(`  ${p}`);
  process.exit(2);
}

// ---- 1. 从真实源码里取 CSS（与 scripts/check-theme-contrast.mjs 同一套切法）----

const readerSrc = readFileSync(join(pluginRoot, 'src/client/ReaderPage.jsx'), 'utf8');
const cssStart = readerSrc.indexOf('const PANEL_CSS = `');
const cssEnd = readerSrc.indexOf('`;', cssStart);
if (cssStart < 0 || cssEnd < 0) throw new Error('抽 PANEL_CSS 失败（找不到边界）');
const PANEL_CSS = readerSrc.slice(cssStart + 'const PANEL_CSS = `'.length, cssEnd);
const REFINEMENTS = readFileSync(join(pluginRoot, 'src/client/refinements.css'), 'utf8');
if (!PANEL_CSS.includes('.npr-menu button')) throw new Error('抽 PANEL_CSS 失败（边界切错了）');

/** 反向对照用：把禁用态那条规则整条摘掉。 */
const DISABLED_RULE = '.npr-menu button:disabled{opacity:.45;cursor:default}';

/**
 * 夹具：真 DOM 结构（`.npr-root > .npr-menu > button`），真 CSS。
 * `--npr-*` 只补菜单用到的那几个 —— `opacity` / `cursor` 不吃变量，补它们只为别让
 * 整块样式因为未定义的 `var()` 变成空值（那样量出来的东西跟真实页面不是一回事）。
 */
function fixture(css) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
.npr-root{--npr-surface:#fff;--npr-border-strong:#d5d8dc;--npr-elevation:0 8px 24px rgba(0,0,0,.12);--npr-fg:#0f1115;--npr-hover:#f1f2f4;--npr-border:#e6e8ea;--npr-muted:#61666b}
${css}
</style></head><body>
<div class="npr-root" data-reading-theme="auto">
  <div class="npr-menu" role="menu">
    <button type="button" id="on">重新生成译文</button>
    <button type="button" id="off" disabled>重新生成译文</button>
  </div>
</div>
</body></html>`;
}

// ---- 2. 在真 Chrome 里量 ---------------------------------------------------

const PROBE = `
const cs = (id) => getComputedStyle(document.getElementById(id));
const out = {
  on:  { opacity: cs('on').opacity,  cursor: cs('on').cursor },
  off: { opacity: cs('off').opacity, cursor: cs('off').cursor },
  hoverSelectors: [],
  disabledSelectorMatched: document.querySelectorAll('.npr-menu button:disabled').length,
};
for (const sheet of document.styleSheets) {
  let rules;
  try { rules = sheet.cssRules; } catch (e) { continue; }
  for (const rule of rules) {
    const sel = rule.selectorText || '';
    if (sel.indexOf('.npr-menu button:hover') !== -1) out.hoverSelectors.push(sel);
  }
}
const pre = document.createElement('pre');
pre.id = 'probe-out';
pre.textContent = JSON.stringify(out);
document.body.appendChild(pre);
`;

function measure(css) {
  const dir = mkdtempSync(join(tmpdir(), 'npr-menu-'));
  const htmlPath = join(dir, 'probe.html');
  writeFileSync(htmlPath, `${fixture(css)}\n<script>\n${PROBE}\n<\/script>\n`, 'utf8');
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

// ---- 3. 断言 ---------------------------------------------------------------

const failures = [];
const ok = (cond, message) => { if (cond) console.log(`  OK   ${message}`); else { failures.push(message); console.log(` FAIL  ${message}`); } };

const full = measure(PANEL_CSS + REFINEMENTS);

console.log('夹具里匹配到 `.npr-menu button:disabled` 的元素数：', full.disabledSelectorMatched);
ok(full.disabledSelectorMatched === 1, '夹具里正好有一个禁用条目（选择器确实命中真 DOM）');

console.log(`\n可点条目：opacity=${full.on.opacity} cursor=${full.on.cursor}`);
console.log(`禁用条目：opacity=${full.off.opacity} cursor=${full.off.cursor}\n`);

ok(Number(full.off.opacity) < 1, `禁用条目被降了透明度（实测 opacity=${full.off.opacity}）—— 与可点条目一眼能区分`);
ok(full.off.cursor !== 'pointer', `禁用条目的鼠标不是手型（实测 cursor=${full.off.cursor}）`);
ok(Number(full.on.opacity) === 1 && full.on.cursor === 'pointer', '对照：**可点**条目没有被误伤（opacity=1、cursor=pointer）');
ok(full.off.opacity !== full.on.opacity, '两者**看起来不一样** —— 这才叫「画出来了」');

ok(full.hoverSelectors.length > 0, '样式表里能找到 `.npr-menu button:hover` 规则（否则下面的守卫是空跑）');
for (const sel of full.hoverSelectors) {
  ok(sel.includes(':not(:disabled)'), `hover 规则带 :not(:disabled)（实测选择器：${sel}）—— 否则禁用项还会被高亮`);
}

// ---- 4. 反向对照：摘掉规则之后，量出来的值必须跟着变 ------------------------

console.log('\n反向对照：把 `:disabled` 规则整条摘掉再量一次');
const stripped = (PANEL_CSS + REFINEMENTS).replace(DISABLED_RULE, '');
if (stripped === PANEL_CSS + REFINEMENTS) {
  throw new Error(`反向对照没生效（锚点没命中）：${DISABLED_RULE}\n★ 不静默继续 —— 否则「没变红」会被误读成「装置抓不到」`);
}
const bare = measure(stripped);
console.log(`  摘掉后禁用条目：opacity=${bare.off.opacity} cursor=${bare.off.cursor}`);
ok(Number(bare.off.opacity) === 1, '摘掉规则后禁用条目的 opacity 变回 1 —— 证明上面量到的 <1 确实来自这条规则');
ok(bare.off.cursor === 'pointer', '摘掉规则后 cursor 变回 pointer —— 证明「不是手型」确实来自这条规则');

// ---- 5. 结论 ---------------------------------------------------------------

console.log('');
if (failures.length > 0) {
  console.error(`dsh-npie-reader 菜单禁用态：${failures.length} 项未通过`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('dsh-npie-reader 菜单禁用态：全部通过（真 Chrome 量 computed style + 反向对照）');
