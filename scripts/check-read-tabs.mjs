/**
 * 阅读页三选一 + 播客朗读禁用态（0.84.1）真机判据。
 *
 * ---------------------------------------------------------------------------
 * 它回答的不是「读代码能读出来」的问题
 * ---------------------------------------------------------------------------
 * ② 带音频的播客 RSS 上，「朗读这篇文章」必须**灰掉**。只写 `disabled` 属性不够：
 *    本插件的 `.npr-icon` 有一条 `:hover` 高亮，禁用按钮照样会变色、鼠标照样是手型，
 *    用户看到的是「看着能点、点了没反应」。所以要在真 Chrome 里量 computed style。
 *
 * ③ 阅读页原来是「文章 + 一长页字幕和导读」，用户要的是 `文章 / 字幕 / 导读`
 *    三选一互斥、**播放器常驻**。这里量三态下每块的真实 display 与高度：
 *    - 正文该藏的藏、该留的留；
 *    - 字幕与导读**恰好一块**可见（多一块 = 又堆成一长页，少一块 = 空白页）；
 *    - 播放条三态都在、都可见 —— 它一旦被卸掉，`<audio>` 的位置就归零了。
 *
 * ④ 0.84.2 视觉重做（用户给的参考图）：播放条**在上**、下划线文字 tab **在下**。
 *    旧版是灰胶囊 + 白滑块夹在标题与播放条中间，看着像第二组播放控件。这里量：
 *    - DOM 与几何顺序：播放器底边在选项卡顶边之上；
 *    - 选中项**只有一条 2px 下划线**，未选中项没有（用伪元素的 computed 取色）；
 *    - 没有胶囊底座（无圆角、无底色、无内边距、无 box-shadow）；
 *    - 播放条上不再有冗余的「字幕」按钮（入口只有 tab 一处）。
 *
 * ★ 反向对照（自证测量有牙，缺了就退化成恒真式）
 *   R1 摘掉两条「放行」规则 → 字幕/导读两块都不可见；
 *   R2 摘掉「默认全藏」规则 → 两块都可见；
 *   R3 摘掉 `:disabled` 两条规则 → 禁用态的 opacity / cursor 回到可点态；
 *   R4 把下划线规则换成透明 → 选中项伪元素不再上色（证明取色确实来自那条规则）；
 *   R5 把共用的 h1 规则拆回单选择器 → 收听头字号回退到浏览器默认（证明标题一致
 *      确实来自那条共用规则，而不是两个选择器碰巧写成了同一个值）；
 *   R6 把收听头旧样式写回去 → 元信息行字号与文章态不同（证明「间距也一致」
 *      不是因为夹具里两态恰好用了同一颗节点）。
 *   四处任一没变红，说明量到的东西跟那条规则无关。
 *
 * 运行：node scripts/check-read-tabs.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 Chrome 不可用（**不静默跳过**）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// ---- 1. 从真实源码里取 CSS 与 JSX ------------------------------------------

const readerSrc = readFileSync(join(root, 'src/client/ReaderPage.jsx'), 'utf8');
const cssStart = readerSrc.indexOf('const PANEL_CSS = `');
const cssEnd = readerSrc.indexOf('`;', cssStart);
if (cssStart < 0 || cssEnd < 0) throw new Error('抽 PANEL_CSS 失败（找不到边界）');
const PANEL_CSS = readerSrc.slice(cssStart + 'const PANEL_CSS = `'.length, cssEnd);
const REFINEMENTS = readFileSync(join(root, 'src/client/refinements.css'), 'utf8');
const CSS = PANEL_CSS + '\n' + REFINEMENTS;
if (!CSS.includes('[data-listen="true"]')) throw new Error('抽 CSS 失败：找不到收听视图的显隐规则');

/** 反向对照用的三条锚点 —— 必须逐字命中，命中不了就报错，不许静默继续。 */
const RULE_HIDE_ALL = '.npr-article[data-read-tab] .npr-readpanel { display: none; }';
const RULE_SHOW_DIGEST = '.npr-article[data-read-tab="digest"] .npr-readpanel[data-read-panel="digest"] { display: block; }';
const RULE_SHOW_TRANSCRIPT = '.npr-article[data-read-tab="transcript"] .npr-readpanel[data-read-panel="transcript"] { display: block; }';
const RULE_DISABLED = '.npr-root .npr-icon:disabled{opacity:.38;cursor:not-allowed}';
const RULE_DISABLED_HOVER = '.npr-root .npr-icon:disabled:hover{background:transparent;color:var(--npr-muted)}';
const RULE_UNDERLINE = '.npr-root .npr-readtabs button[aria-pressed=true]::after { background: var(--npr-accent-strong); }';
for (const rule of [RULE_HIDE_ALL, RULE_SHOW_DIGEST, RULE_SHOW_TRANSCRIPT, RULE_DISABLED, RULE_DISABLED_HOVER, RULE_UNDERLINE]) {
  if (!CSS.includes(rule)) throw new Error(`CSS 锚点没命中，判据前提不成立：${rule}`);
}

// ---- 2. 夹具：严格按真实 DOM 的条件渲染来造 --------------------------------
//
// ★ article 态真实实现里**没有** listen-body（只有 listenMode 时才渲染）；
//   transcript / digest 态则正文元素仍在 DOM 里、由 `data-listen="true"` 的 CSS 隐掉。
//   夹具照抄这个形状，否则「量到的可见性」跟真实页面不是一回事。

const TABS = [
  { id: 'article', listen: 'false', pressed: ['true', 'false', 'false'] },
  { id: 'transcript', listen: 'true', pressed: ['false', 'true', 'false'] },
  { id: 'digest', listen: 'true', pressed: ['false', 'false', 'true'] },
];

function tree(tab) {
  const keep = (inner, extra = '') => `<div ${extra} data-listen-keep="true">${inner}</div>`;
  const buttons = ['文章', '字幕', '导读'].map((label, i) =>
    `<button type="button" aria-pressed="${tab.pressed[i]}">${label}</button>`).join('');
  // article 态没有 listen-head / listen-body —— 与 ReaderPage.jsx 的条件渲染一致。
  // ★ 0.84.3：收听头里必须有真 <h1>。旧夹具只放了一行占位文字，所以
  //   「切 tab 标题变小 21px vs 24px」这种真 bug 判据完全量不到。
  const head = tab.id === 'article' ? ''
    : keep('<div class="npr-listen-meta">节目名</div><h1>这一集的标题</h1>', 'class="npr-listen-head"');
  const body = tab.id === 'article' ? '' : keep(
    '<div class="npr-readpanel" data-read-panel="digest">导读正文</div>' +
    '<div class="npr-readpanel" data-read-panel="transcript">字幕正文</div>',
    'class="npr-listen-body"');
  // ★ 0.84.6：顺序必须与 ReaderPage.jsx 一致 —— 头（或 listen-head）→ 元信息 →
  //   h1 → 播放条 → tab。以前夹具把播放条写在两个头之前，量「标题到播放条」
  //   的间距会得到完全错误的数。收听态的 article-head / h1 仍留在 DOM 里，
  //   由 data-listen=true 的 CSS 隐藏 —— 和真实页面一样。
  return `<article class="npr-article" id="tab-${tab.id}" data-listen="${tab.listen}" data-read-tab="${tab.id}">
  ${head}
  <div class="npr-article-head">元信息行</div>
  <h1>这一集的标题</h1>
  ${keep('<div id="dock-' + tab.id + '">播放器</div>', 'class="npr-dock-slot"')}
  <div class="npr-readtabs" data-listen-keep="true" role="group" aria-label="阅读内容">${buttons}</div>
  <div class="npr-prose">文章正文，占一段高度</div>
  ${body}
</article>`;
}

function fixture(css) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
/* ★ 变量必须写在 CSS **之后**：PANEL_CSS 开头那条 .npr-root{--npr-accent:
   var(--npc-brand,var(--dsw-alias-brand-primary));…} 会把宿主令牌链覆盖上来；
   夹具里没有宿主令牌 ⇒ 写在前面就被冲成空值，下划线量到 transparent，
   判据会「看似测了颜色」实际恒绿。这里后写 = 给这套令牌一个确定值。 */
.npr-root{--npr-fg:#0f1115;--npr-bg:#fff;--npr-bg-2:#f6f7f8;--npr-muted:#61666b;--npr-faint:#8a9096;--npr-hover:#f1f2f4;--npr-border:#e6e8ea;--npr-accent:#3b7ddd;--npr-accent-strong:#2f6bc4;--npr-tab-h:26px;--npr-tab-r:6px;--npr-tab-font:13px;--npr-tab-pad:2px;--npr-tab-track:color-mix(in srgb,var(--npr-fg) 8%,var(--npr-bg));--npr-tab-thumb:var(--npr-bg);--npr-readtabs-gap:22px;--npr-readtabs-gap-top:12px;--npr-readtabs-gap-bottom:12px;--npr-readtabs-h:32px}
</style></head><body>
<div class="npr-root" data-reading-theme="auto">
  <div class="npr-actions">
    <button type="button" class="npr-icon" id="speech-on">朗读</button>
    <button type="button" class="npr-icon" id="speech-off" disabled>朗读</button>
  </div>
  ${TABS.map(tree).join('\n')}
</div>
</body></html>`;
}

// ---- 3. 在真 Chrome 里量 ---------------------------------------------------

const PROBE = `
const vis = (el) => {
  if (!el) return { exists: false, visible: false, display: 'absent', height: 0 };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { exists: true, display: cs.display,
    visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0,
    height: Math.round(r.height) };
};
const out = { tabs: {}, speech: {} };
for (const id of ['article', 'transcript', 'digest']) {
  const root = document.getElementById('tab-' + id);
  const readtabs = root.querySelector('.npr-readtabs');
  const btns = [...readtabs.querySelectorAll('button')];
  const panels = [...root.querySelectorAll('.npr-readpanel')].map((p) => ({
    name: p.getAttribute('data-read-panel'), ...vis(p),
  }));
  const dockEl = root.querySelector('.npr-dock-slot');
  const strip = btns.length ? getComputedStyle(readtabs) : null;
  out.tabs[id] = {
    pressed: btns.map((b) => b.getAttribute('aria-pressed')),
    pressedTrue: btns.filter((b) => b.getAttribute('aria-pressed') === 'true').length,
    labels: btns.map((b) => b.textContent.trim()),
    readtabs: vis(readtabs),
    dock: vis(dockEl),
    prose: vis(root.querySelector('.npr-prose')),
    // 0.84.3 量标题的 computed 排版；0.84.6 把 margin、元信息行和两段落差也量进来。
    // 文章态取 article 的直接子元素，收听态取 listen-head 里那颗（另一颗被 CSS 隐藏）。
    title: (() => {
      const el = id === 'article' ? root.querySelector(':scope > h1') : root.querySelector('.npr-listen-head h1');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing,
        fontWeight: cs.fontWeight, fontFamily: cs.fontFamily,
        marginTop: cs.marginTop, marginBottom: cs.marginBottom };
    })(),
    meta: (() => {
      const el = id === 'article' ? root.querySelector(':scope > .npr-article-head') : root.querySelector('.npr-listen-meta');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, color: cs.color, columnGap: cs.columnGap,
        marginBottom: cs.marginBottom, lineHeight: cs.lineHeight };
    })(),
    geometry: (() => {
      const titleEl = id === 'article' ? root.querySelector(':scope > h1') : root.querySelector('.npr-listen-head h1');
      const metaEl = id === 'article' ? root.querySelector(':scope > .npr-article-head') : root.querySelector('.npr-listen-meta');
      if (!titleEl || !metaEl || !dockEl) return null;
      const rr = root.getBoundingClientRect();
      const tr = titleEl.getBoundingClientRect();
      const mr = metaEl.getBoundingClientRect();
      const dr = dockEl.getBoundingClientRect();
      return {
        metaToTitle: Math.round(tr.top - mr.bottom),
        titleToDock: Math.round(dr.top - tr.bottom),
        // 0.84.6：连左边缘一起比 —— 顶部「全部一致」不只是纵向。
        metaLeft: Math.round(mr.left - rr.left),
        titleLeft: Math.round(tr.left - rr.left),
        dockLeft: Math.round(dr.left - rr.left),
      };
    })(),
    panels,
    visiblePanels: panels.filter((p) => p.visible).map((p) => p.name),
    // 0.84.2 视觉口径：播放条在上、tab 在下；tab 无胶囊底座；下划线只在选中项。
    order: { dockBottom: Math.round(dockEl.getBoundingClientRect().bottom),
      tabsTop: Math.round(readtabs.getBoundingClientRect().top) },
    strip: strip ? { background: strip.backgroundColor, borderRadius: strip.borderRadius } : null,
    buttons: btns.map((b) => {
      const cs = getComputedStyle(b);
      const after = getComputedStyle(b, '::after');
      return { label: b.textContent.trim(), pressed: b.getAttribute('aria-pressed'),
        radius: cs.borderTopLeftRadius, paddingLeft: cs.paddingLeft,
        shadow: cs.boxShadow, afterColor: after.backgroundColor,
        afterHeight: Math.round(Number.parseFloat(after.height) || 0),
        afterBottom: after.bottom };
    }),
  };
}
for (const id of ['speech-on', 'speech-off']) {
  const el = document.getElementById(id);
  const cs = getComputedStyle(el);
  out.speech[id] = { disabled: el.disabled, opacity: cs.opacity, cursor: cs.cursor };
}
const pre = document.createElement('pre');
pre.id = 'probe-out';
pre.textContent = JSON.stringify(out);
document.body.appendChild(pre);
`;

function measure(css) {
  const dir = mkdtempSync(join(tmpdir(), 'npr-readtabs-'));
  const htmlPath = join(dir, `probe-${process.pid}.html`);
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

// ---- 4. 断言 ---------------------------------------------------------------

const failures = [];
const ok = (cond, message) => {
  if (cond) console.log(`  OK   ${message}`);
  else { failures.push(message); console.log(` FAIL  ${message}`); }
};

// 4.1 源码：单一状态源 + 两块面板常驻 + 朗读禁用（静态口径）
console.log('源码口径');
ok(/const \[readTab, setReadTab\] = useState\('article'\)/.test(readerSrc)
  && /const listenMode = readTab !== 'article'/.test(readerSrc),
  'data-listen 与 data-read-tab 从同一个 readTab 派生（不是两份状态）');
ok(!/setListenMode/.test(readerSrc), '旧的 setListenMode 已清干净（否则两态会漂出空白页）');
ok(/data-read-tab=\{audioUrl \? readTab : 'article'\}/.test(readerSrc),
  'article 上写了 data-read-tab');
for (const [id, label] of [['article', '文章'], ['transcript', '字幕'], ['digest', '导读']]) {
  ok(readerSrc.includes(`{ id: '${id}', label: '${label}' }`), `READ_TABS 有 ${id} / ${label}`);
}
ok((readerSrc.match(/<div className="npr-readpanel" data-read-panel="/g) ?? []).length === 2,
  '导读与字幕两块面板都在 JSX 里常驻（不是条件渲染二选一）');
ok(/disabled=\{Boolean\(audioUrl\)\}/.test(readerSrc), '朗读按钮按 audioUrl 禁用');
ok(/if \(audioUrl\) \{ notify\('这一集自带音频/.test(readerSrc),
  'toggleSpeech 里也有防御性守卫（防别的入口误触发）');
ok(/<div className="npr-readtabs" data-listen-keep="true"/.test(readerSrc),
  '选项卡带 data-listen-keep（收听态 CSS 会隐掉没有 keep 的直接子元素）');
ok(/\{audioUrl && \(\s*<div className="npr-dock-slot" data-listen-keep="true">/.test(readerSrc),
  '播放条的渲染条件只有 audioUrl，不含 listenMode ⇒ 三个 tab 下都是同一个节点');
ok(/aria-pressed=\{readTab === tab\.id\}/.test(readerSrc),
  '三个按钮的 aria-pressed 由同一个 readTab 计算 ⇒ 天然互斥');
// 0.84.2：播放条在上、tab 在下；冗余的「字幕」按钮从 MediaDock 里彻底撤掉。
const dockAt = readerSrc.indexOf('<div className="npr-dock-slot"');
const tabsAt = readerSrc.indexOf('<div className="npr-readtabs"');
ok(dockAt >= 0 && tabsAt > dockAt, '源码 DOM 顺序：播放条在选项卡之前');
const dockSrc = readFileSync(join(root, 'src/client/MediaDock.jsx'), 'utf8');
ok(!/\bonOpenTranscript\b/.test(dockSrc) && !/\bexpandable\b/.test(dockSrc),
  'MediaDock 的 onOpenTranscript / expandable 两个 prop 已清干净（撤功能连接口一起删）');
ok(!dockSrc.includes('在整页里看字幕'), '播放条上不再有冗余的「字幕」按钮');

// 4.2 产物：新结构真的进了构建（ASCII 串，不会被 esbuild 的 \\uXXXX 转义骗到）
console.log('\n产物口径');
const clientPath = join(root, 'lib/client.js');
if (!existsSync(clientPath)) {
  ok(false, 'lib/client.js 不存在 —— 先跑 npm run build');
} else {
  const built = readFileSync(clientPath, 'utf8');
  for (const token of ['npr-readtabs', 'data-read-tab', 'data-read-panel', 'npr-readpanel']) {
    ok(built.includes(token), `lib/client.js 里有 ${token}`);
  }
  ok(!built.includes('在整页里看字幕'), '产物里没有旧的「字幕」按钮文案（源码与产物双扫）');
  ok(!built.includes('npr-readtabs button[aria-pressed=true] { background'),
    '产物里没有胶囊底座规则（旧 CSS 的静态反面口径）');
}

// 4.3 真 Chrome：三态显隐、互斥、播放器常驻、朗读禁用态
console.log('\n真 Chrome 量 computed style');
const full = measure(CSS);
for (const tab of TABS) {
  const t = full.tabs[tab.id];
  const label = { article: '文章', transcript: '字幕', digest: '导读' }[tab.id];
  console.log(`  [${label}] prose=${t.prose.display} dock=${t.dock.display} 可见面板=${t.visiblePanels.join(',') || '(无)'}`);
  ok(t.labels.join('/') === '文章/字幕/导读', `${label} 态：三个 tab 的文字是 文章 / 字幕 / 导读`);
  ok(t.pressedTrue === 1, `${label} 态：恰好一个 aria-pressed=true（互斥，实测 ${t.pressedTrue} 个）`);
  ok(t.readtabs.visible, `${label} 态：选项卡条仍然可见（否则切不回来）`);
  ok(t.dock.visible, `${label} 态：播放器常驻且可见（<audio> 不能被卸掉）`);
  ok(t.order.dockBottom <= t.order.tabsTop,
    `${label} 态：播放条在选项卡上方（dock 底 ${t.order.dockBottom} ≤ tabs 顶 ${t.order.tabsTop}）`);
  ok(t.strip.background === 'rgba(0, 0, 0, 0)' && Number.parseFloat(t.strip.borderRadius) === 0,
    `${label} 态：tab 条没有胶囊底座（background=${t.strip.background} radius=${t.strip.borderRadius}）`);
  const pressed = t.buttons.filter((b) => b.pressed === 'true');
  const plain = t.buttons.filter((b) => b.pressed !== 'true');
  ok(pressed.length === 1 && pressed[0].afterHeight === 2
    && pressed[0].afterColor !== 'rgba(0, 0, 0, 0)' && pressed[0].afterBottom === '-1px',
    `${label} 态：选中项有一条 2px 下划线且压住分隔线（${pressed[0]?.afterHeight}px / ${pressed[0]?.afterColor} / ${pressed[0]?.afterBottom}）`);
  ok(plain.length === 2 && plain.every((b) => b.afterColor === 'rgba(0, 0, 0, 0)'),
    `${label} 态：未选中项没有下划线（避免三个都亮 = 分不清选了谁）`);
  ok(t.buttons.every((b) => Number.parseFloat(b.radius) === 0 && b.paddingLeft === '1px'
    && b.shadow === 'none'),
    `${label} 态：文字 tab 没有圆角/内垫片/投影（不是胶囊按钮）`);
  if (tab.id === 'article') {
    ok(t.prose.visible, '文章态：正文可见');
    ok(t.visiblePanels.length === 0, '文章态：字幕与导读都不占位');
  } else {
    ok(!t.prose.visible, `${label} 态：正文让位（display=${t.prose.display}）`);
    const want = tab.id === 'digest' ? 'digest' : 'transcript';
    ok(t.visiblePanels.length === 1 && t.visiblePanels[0] === want,
      `${label} 态：恰好可见 ${want} 一块（实测 ${t.visiblePanels.join(',') || '(无)'}）`);
  }
}
console.log(`  朗读按钮 on/off：opacity ${full.speech['speech-on'].opacity}/${full.speech['speech-off'].opacity} · cursor ${full.speech['speech-on'].cursor}/${full.speech['speech-off'].cursor}`);
ok(full.speech['speech-off'].disabled === true, '播客态朗读按钮真的 disabled');
ok(Number(full.speech['speech-off'].opacity) < 0.5, '禁用态被降了透明度（看得出是灰的）');
ok(full.speech['speech-off'].cursor === 'not-allowed', '禁用态鼠标不是手型');
ok(Number(full.speech['speech-on'].opacity) === 1 && full.speech['speech-on'].cursor === 'pointer',
  '对照：普通文章的朗读按钮没有被误伤');

// 0.84.3 量标题；0.84.6 起用户要求「顶部全部一致」，连元信息行和两段落差一起比。
console.log('\n顶部区域一致性（文章态 vs 字幕/导读态）');
const groups = [
  ['标题排版', 'title', ['fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'fontFamily', 'marginTop', 'marginBottom']],
  ['元信息行', 'meta', ['fontSize', 'color', 'columnGap', 'marginBottom', 'lineHeight']],
  ['间距', 'geometry', ['metaToTitle', 'titleToDock', 'metaLeft', 'titleLeft', 'dockLeft']],
];
for (const [name, field, keys] of groups) {
  for (const key of keys) {
    const a = full.tabs.article[field]?.[key];
    for (const id of ['transcript', 'digest']) {
      const b = full.tabs[id][field]?.[key];
      ok(a !== undefined && a !== null && a === b,
        `${name} ${key}：文章=${a} / ${id}=${b}（必须逐项相等）`);
    }
  }
}

// ---- 5. 六条反向对照 -------------------------------------------------------

console.log('\n反向对照 R1：摘掉两条「放行」规则 ⇒ 两块面板都应不可见');
const r1 = CSS.replace(RULE_SHOW_DIGEST, '').replace(RULE_SHOW_TRANSCRIPT, '');
const m1 = measure(r1);
for (const id of ['transcript', 'digest']) {
  ok(m1.tabs[id].visiblePanels.length === 0,
    `R1 ${id} 态可见面板数=${m1.tabs[id].visiblePanels.length}（应为 0，证明「可见」确实来自放行规则）`);
}

console.log('\n反向对照 R2：摘掉「默认全藏」规则 ⇒ 两块面板会同时可见');
const r2 = CSS.replace(RULE_HIDE_ALL, '');
const m2 = measure(r2);
for (const id of ['transcript', 'digest']) {
  ok(m2.tabs[id].visiblePanels.length === 2,
    `R2 ${id} 态可见面板数=${m2.tabs[id].visiblePanels.length}（应为 2，证明互斥不是恒真式）`);
}

console.log('\n反向对照 R3：摘掉 :disabled 两条规则 ⇒ 禁用态看起来跟可点态一样');
const r3 = CSS.replace(RULE_DISABLED, '').replace(RULE_DISABLED_HOVER, '');
const m3 = measure(r3);
ok(Number(m3.speech['speech-off'].opacity) === 1,
  `R3 禁用态 opacity=${m3.speech['speech-off'].opacity}（应回到 1）`);
ok(m3.speech['speech-off'].cursor === 'pointer',
  `R3 禁用态 cursor=${m3.speech['speech-off'].cursor}（应回到 pointer）`);

console.log('\n反向对照 R4：把下划线改成透明 ⇒ 选中项不再有可见下划线');
const r4 = CSS.replace(RULE_UNDERLINE,
  '.npr-root .npr-readtabs button[aria-pressed=true]::after { background: transparent; }');
const m4 = measure(r4);
for (const id of ['article', 'transcript', 'digest']) {
  const p = m4.tabs[id].buttons.find((b) => b.pressed === 'true');
  ok(p.afterColor === 'rgba(0, 0, 0, 0)',
    `R4 ${id} 态选中项下划线=${p.afterColor}（应透明，证明取色确实来自那条规则）`);
}

console.log('\n反向对照 R5：把共用规则拆回两个选择器 ⇒ 收听头字号应回退到默认');
const SHARED_H1 = '.npr-article > h1,.npr-listen-head h1{';
if (!CSS.includes(SHARED_H1)) throw new Error('R5 锚点没命中：找不到共用的 h1 规则');
const r5 = CSS.replace(SHARED_H1, '.npr-article > h1{');
const m5 = measure(r5);
ok(m5.tabs.transcript.title.fontSize !== m5.tabs.article.title.fontSize,
  `R5 收听头字号=${m5.tabs.transcript.title.fontSize} / 文章=${m5.tabs.article.title.fontSize}（必须不同，证明「一致」来自那条共用规则）`);

console.log('\n反向对照 R6：把收听头旧样式写回去 ⇒ 元信息行应与文章态不同');
const HEAD_ANCHOR = '.npr-listen-head { display: block; margin: 0; }';
if (!CSS.includes(HEAD_ANCHOR)) throw new Error('R6 锚点没命中：找不到收听头规则');
const r6 = CSS.replace(HEAD_ANCHOR,
  HEAD_ANCHOR + '\n.npr-listen-meta { font-size: 11.5px; margin-bottom: 0; }');
const m6 = measure(r6);
ok(m6.tabs.transcript.meta.fontSize !== m6.tabs.article.meta.fontSize,
  `R6 元信息行字号=${m6.tabs.transcript.meta.fontSize} / 文章=${m6.tabs.article.meta.fontSize}（必须不同，证明这一项也有牙）`);

// ---- 5.5 头部内容一致（0.84.7）---------------------------------------------
//
// 上面那 14 项量的是**几何**：字号、间距、左边缘、行高。全绿只能证明
// 「两块头长得一样」，证明不了「写进去的内容一样」。上一轮就是这样漏的：
// 切到字幕 / 导读后作者、版本 chip、「仅摘要」整块消失，标题还丢了原文链接，
// 而几何判据一项都没红 —— 用户看到的是「同一篇文章换了个头」。
console.log('\n头部内容：两态字段集合必须相同（只允许收听态多一个「N 段字幕」）');
const readerSource = readFileSync(join(root, 'src/client/ReaderPage.jsx'), 'utf8');
const listenStart = readerSource.indexOf('className="npr-listen-head"');
const articleStart = readerSource.indexOf('className="npr-article-head"');
const articleEnd = readerSource.indexOf('{audioUrl && (', articleStart);
if (listenStart < 0 || articleStart < 0 || articleEnd < 0) {
  throw new Error('头部内容判据锚点没命中：ReaderPage.jsx 的三段结构变了，先更新本判据');
}
const listenBlock = readerSource.slice(listenStart, articleStart);
const articleBlock = readerSource.slice(articleStart, articleEnd);
const HEAD_FIELDS = [
  'activeArticle.article.author',
  'npr-mode-chip',
  'activeArticle.article.bodyMissing',
  'activeArticle.article.url',
];
for (const field of HEAD_FIELDS) {
  ok(listenBlock.includes(field), `收听头必须含 ${field}（否则切 tab 后这一项消失）`);
  ok(articleBlock.includes(field), `文章头必须含 ${field}`);
}
// 反向对照：从收听头删掉作者后，判据必须能看出来（证明它不是恒真式）
const brokenListen = listenBlock.replace(
  /activeArticle\.article\.author && <span>\{activeArticle\.article\.author\}<\/span>/,
  '',
);
ok(brokenListen !== listenBlock && !brokenListen.includes('activeArticle.article.author'),
  '反向对照：删掉收听头的作者后，上面「必须含 author」确实会红（判据有牙）');

// ---- 6. 结论 ---------------------------------------------------------------

console.log('');
if (failures.length > 0) {
  console.error(`dsh-npie-reader 阅读页选项卡 / 朗读禁用：${failures.length} 项未通过`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('dsh-npie-reader 阅读页选项卡 / 朗读禁用：全部通过（真 Chrome + 六条反向对照）');
