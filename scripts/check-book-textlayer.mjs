#!/usr/bin/env node
/**
 * 书页**透明文字层**与字形的对齐校验（真 Chrome、真 PDF、真项目 CSS）。
 *
 * 为什么要这么重：文字层「写上了」和「对得上」是两件事，而错位只长成三种样子，
 * 全都**单测全绿、构建正常**，只有真机截图才看得出：
 *   ① 容器尺寸与画布的 CSS 尺寸取整不一致 ⇒ 选区整体错半个字；
 *   ② `--font-height` 忘了乘缩放因子 ⇒ 2× 屏上字号只有一半，选一个字的框盖住半个字；
 *   ③ 定位基准挂了滚动容器 ⇒ 页面一滚，选区与字形错开。
 *
 * 判据（每条都配一次**反向对照**：把 `--total-scale-factor` 故意减半，必须变红）：
 *   ① 文字层矩形与画布矩形逐项重合（≤ 0.5px）；
 *   ② 每个有字的 span 都落在画布内（±3px）；
 *   ③ 每个 span 的计算字号 ≈ `--font-height × scale`；
 *   ④ **独立基准**：画布位图的墨迹行带 vs span 行带，偏差必须近似常量
 *      （离散度 ≤ 6px）。这一条不依赖 pdf.js 自己的说法，是唯一能抓「整体偏移」的。
 *   ⑤ 选中一整行能得到文字，且选区矩形与该行 span 的并集盒子重合。
 *
 * 用法：
 *   node scripts/check-book-textlayer.mjs --pdf /path/to/book.pdf [--page 5] [--shot out.png]
 *
 * ★ 为什么必须显式给 --pdf：仓库里没有可提交的 PDF 夹具，而**编一个** PDF 会让这条
 *   判据测的是「我们编的那份文件」（可能没有多字 span、没有旋转、没有 ToUnicode），
 *   反而给出一条虚假的安心。给不出真书就**报错退出**，不静默跳过。
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

const PDF = flag('pdf', process.env.NPIE_PDF ?? '');
const PAGE = Number(flag('page', '5'));
const SHOT = flag('shot', '');
if (PDF === '') {
  console.error('✗ 缺少 --pdf（或环境变量 NPIE_PDF）。\n'
    + '  这条判据必须跑在**真书**上：见文件头「为什么必须显式给 --pdf」。');
  process.exit(2);
}

/* ---- 真项目 CSS：PANEL_CSS（在 ReaderPage.jsx 里）+ refinements.css ---------- */
const reader = readFileSync(join(root, 'src/client/ReaderPage.jsx'), 'utf8');
const panelAt = reader.indexOf('const PANEL_CSS = `');
const PANEL = reader.slice(panelAt + 'const PANEL_CSS = `'.length, reader.indexOf('`;', panelAt));
const REFINEMENTS = readFileSync(join(root, 'src/client/refinements.css'), 'utf8');

/** 宿主令牌：插件里由宿主注入，这里只给一套浅色值。 */
const HOST_TOKENS = `:root,body{
  --dsw-alias-bg-base:#ffffff;--dsw-alias-bg-layer-1:#f7f8f9;--dsw-alias-bg-layer-2:#f1f2f4;
  --dsw-alias-bg-layer-3:#ffffff;--dsw-alias-bg-mask-1:rgba(15,17,21,.4);
  --dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;--dsw-alias-label-tertiary:#81858c;
  --dsw-alias-border-l1:#e6e8ea;--dsw-alias-border-l2:#d5d8dc;
  --dsw-alias-interactive-bg-hover:#f1f2f4;--dsw-alias-brand-primary:#3d58e0;
  --dsw-alias-state-error-primary:#d92d20;--dsw-alias-state-warn-primary:#b54708;
  --dsw-focus-ring-width:1px;--dsw-focus-ring-color:#3d58e0;}`;

const html = `<!doctype html><meta charset="utf-8">
<style>${HOST_TOKENS}</style><style>${PANEL}</style><style>${REFINEMENTS}</style>
<style>body{margin:0;background:#fff}.npr-root{height:900px;display:flex;flex-direction:column}</style>
<div class="npr-root"><div class="npr-book" style="flex:1;min-height:0">
  <div class="npr-book-main" style="flex:1;min-height:0;display:flex;min-width:0">
    <div class="npr-book-stage" id="stage">
      <div class="npr-book-sheet" id="sheet">
        <canvas class="npr-book-canvas" id="c"></canvas>
        <div class="npr-book-text" id="tl"></div>
      </div>
    </div>
  </div>
</div></div>
<script type="module">
window.__probe = async (distort) => {
  const out = { dpr: devicePixelRatio, distort };
  const pdfjs = await import('/pdfjs/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
  const task = pdfjs.getDocument({ url: '/book.pdf', cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/' });
  const doc = await task.promise;
  const page = await doc.getPage(${PAGE});
  const raw = page.getViewport({ scale: 1 });
  const stage = document.getElementById('stage');
  const scale = (stage.clientWidth - 32) / raw.width;   // 与 BookReader 的适宽口径一致
  out.scale = +scale.toFixed(4);
  const viewport = page.getViewport({ scale });
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const canvas = document.getElementById('c');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = Math.floor(viewport.width) + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';
  await page.render({ canvasContext: canvas.getContext('2d'), viewport,
    transform: dpr === 1 ? null : [dpr,0,0,dpr,0,0] }).promise;

  const tl = document.getElementById('tl');
  // 反向对照：故意把缩放因子减半（= 忘了乘缩放的等价形态）。
  tl.style.setProperty('--total-scale-factor', String(distort ? scale * 0.5 : scale));
  const layer = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: tl, viewport });
  await layer.render();

  const cr = canvas.getBoundingClientRect(), tr = tl.getBoundingClientRect();
  out.rect = {
    dw: +(tr.width - cr.width).toFixed(2), dh: +(tr.height - cr.height).toFixed(2),
    dx: +(tr.left - cr.left).toFixed(2), dy: +(tr.top - cr.top).toFixed(2),
  };
  const spans = [...tl.querySelectorAll('span')].filter(s => s.textContent.trim() !== '');
  out.spans = spans.length;
  out.multiChar = spans.filter(s => s.textContent.length > 1).length;

  let fontBad = 0, outside = 0;
  for (const sp of spans) {
    const cs = getComputedStyle(sp);
    const fh = parseFloat(cs.getPropertyValue('--font-height'));
    const fs = parseFloat(cs.fontSize);
    if (!(Math.abs(fs - fh * scale) <= Math.max(0.6, fh * scale * 0.06))) fontBad++;
    const r = sp.getBoundingClientRect();
    if (r.width > 0 && (r.left < cr.left - 3 || r.right > cr.right + 3
      || r.top < cr.top - 3 || r.bottom > cr.bottom + 3)) outside++;
  }
  out.fontBad = fontBad; out.outside = outside;

  /* ---- 独立基准：画布位图的墨迹行带 ---- */
  const W = canvas.width, H = canvas.height;
  const img = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const rowInk = new Float64Array(H);
  for (let y = 0; y < H; y += 1) {
    let n = 0;
    for (let x = 0; x < W; x += 2) { const i = (y * W + x) * 4; if (img[i] < 150 && img[i+1] < 150 && img[i+2] < 150) n++; }
    rowInk[y] = n;
  }
  const maxInk = Math.max(...rowInk);
  const bands = [];
  let from = -1;
  for (let y = 0; y < H; y += 1) {
    const on = rowInk[y] > Math.max(2, maxInk * 0.03);
    if (on && from < 0) from = y;
    else if (!on && from >= 0) { if (y - from >= 3) bands.push([from / dpr, (y - 1) / dpr]); from = -1; }
  }
  if (from >= 0) bands.push([from / dpr, (H - 1) / dpr]);

  const lines = new Map();
  for (const sp of spans) {
    const r = sp.getBoundingClientRect();
    if (r.width === 0) continue;
    const key = Math.round((r.top - cr.top) / 2) * 2;
    const cur = lines.get(key) ?? { top: Infinity, bottom: -Infinity };
    cur.top = Math.min(cur.top, r.top - cr.top);
    cur.bottom = Math.max(cur.bottom, r.bottom - cr.top);
    lines.set(key, cur);
  }
  const bias = [];
  for (const ln of lines.values()) {
    let best = null, bestD = Infinity;
    for (const band of bands) {
      const d = Math.abs((band[0] + band[1]) / 2 - (ln.top + ln.bottom) / 2);
      if (d < bestD) { bestD = d; best = band; }
    }
    if (best !== null && bestD <= 6) bias.push(+(ln.top - best[0]).toFixed(1));
  }
  out.bands = bands.length; out.lines = lines.size; out.matched = bias.length;
  out.biasSpread = bias.length === 0 ? null : +(Math.max(...bias) - Math.min(...bias)).toFixed(1);

  /* ---- 选一整行 ---- */
  const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0]);
  const target = sorted[Math.min(2, sorted.length - 1)]?.[1];
  if (target) {
    const band = spans.map(sp => ({ sp, r: sp.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.top - cr.top >= target.top - 1 && r.bottom - cr.top <= target.bottom + 1)
      .sort((a, b) => a.r.left - b.r.left);
    const sel = getSelection(); sel.removeAllRanges();
    if (band.length > 1) {
      const range = document.createRange();
      range.setStart(band[0].sp.firstChild, 0);
      range.setEnd(band[band.length - 1].sp.firstChild, band[band.length - 1].sp.textContent.length);
      sel.addRange(range);
      out.selected = sel.toString().replace(/\s+/g, ' ').trim();
      out.lineText = band.map(b => b.sp.textContent).join('').replace(/\s+/g, ' ').trim();
      const rr = range.getBoundingClientRect();
      const u = { l: Math.min(...band.map(b => b.r.left)), r: Math.max(...band.map(b => b.r.right)),
        t: Math.min(...band.map(b => b.r.top)), b: Math.max(...band.map(b => b.r.bottom)) };
      out.selVsUnion = { dl: +(rr.left - u.l).toFixed(1), dr: +(rr.right - u.r).toFixed(1),
        dt: +(rr.top - u.t).toFixed(1), db: +(rr.bottom - u.b).toFixed(1) };
    }
  }
  await task.destroy();
  return out;
};
</script>`;

/* ---- 起服务 + CDP ------------------------------------------------------- */
const TYPES = {
  '.mjs': 'text/javascript', '.js': 'text/javascript', '.pdf': 'application/pdf', '.html': 'text/html',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  try {
    let body, type;
    if (url === '/book.pdf') { body = readFileSync(PDF); type = 'application/pdf'; }
    else if (url === '/') { body = html; type = 'text/html'; }
    else {
      body = readFileSync(join(root, 'vendor/pdfjs', url.replace('/pdfjs/', '')));
      type = TYPES[extname(url)] ?? 'application/octet-stream';
    }
    res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'npie-tl-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
{ stdio: ['ignore', 'pipe', 'pipe'] });

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
  const id = ++nextId;
  waiting.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');

/** 跑一次探测。`distort` = 反向对照（缩放因子减半）。 */
async function measure(dpr, { distort = false, shot = '' } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 980, deviceScaleFactor: dpr, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await new Promise(done => setTimeout(done, 600));
  const response = await send('Runtime.evaluate', {
    expression: `window.__probe(${distort})`, awaitPromise: true, returnByValue: true, timeout: 90000,
  });
  const value = response.result?.result?.value;
  if (value === undefined) throw new Error(JSON.stringify(response.result?.exceptionDetails ?? response));
  if (shot !== '') {
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (image.result?.data) writeFileSync(shot, Buffer.from(image.result.data, 'base64'));
  }
  return value;
}

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `\n    ${detail}`}`);
};

try {
  for (const dpr of [1, 2]) {
    console.log(`\n—— devicePixelRatio ${dpr} ——`);
    const r = await measure(dpr, { shot: dpr === 2 ? SHOT : '' });
    check('① 文字层与画布矩形重合（≤0.5px）',
      Math.abs(r.rect.dw) <= 0.5 && Math.abs(r.rect.dh) <= 0.5
      && Math.abs(r.rect.dx) <= 0.5 && Math.abs(r.rect.dy) <= 0.5,
      `Δw ${r.rect.dw} Δh ${r.rect.dh} Δx ${r.rect.dx} Δy ${r.rect.dy}（scale ${r.scale}）`);
    check(`② span 全部落在画布内（${r.spans} 个，其中多字 ${r.multiChar} 个）`, r.outside === 0,
      `越界 ${r.outside} 个`);
    check('③ 每个 span 的字号 ≈ --font-height × scale', r.fontBad === 0, `不符 ${r.fontBad} 个`);
    check(`④ 墨迹行带 ${r.bands} / span 行带 ${r.lines}（匹配 ${r.matched}），偏差离散度 ≤ 6px`,
      r.matched > 0 && r.biasSpread !== null && r.biasSpread <= 6,
      `离散度 ${r.biasSpread}px —— 常量偏差是字体度量，**漂移**才是错位`);
    check('⑤ 选中一整行能取到文字，且选区 = 该行 span 并集',
      typeof r.selected === 'string' && r.selected !== ''
      && Math.abs(r.selVsUnion.dl) <= 1 && Math.abs(r.selVsUnion.dr) <= 1
      && Math.abs(r.selVsUnion.dt) <= 3 && Math.abs(r.selVsUnion.db) <= 3,
      `选中「${(r.selected ?? '').slice(0, 30)}」 Δ ${JSON.stringify(r.selVsUnion)}`);

    /* 反向对照：缩放因子减半之后，③④ 必须变红 —— 否则这两条判据只是抄了一遍实现。 */
    const bad = await measure(dpr, { distort: true });
    check('★ 反向对照：缩放因子减半后 ③ 必须变红', bad.fontBad > 0,
      `不符 ${bad.fontBad} 个（若为 0，说明 ③ 根本不看缩放因子）`);
    check('★ 反向对照：缩放因子减半后 ④ 必须变红',
      bad.biasSpread === null || bad.biasSpread > 6,
      `离散度 ${bad.biasSpread}px`);
  }
} finally {
  ws.close();
  chrome.kill();
  server.close();
}

console.log(`\n${failed === 0 ? '全部断言通过' : `${failed} 条断言失败`}`);
process.exitCode = failed === 0 ? 0 : 1;
