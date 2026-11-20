#!/usr/bin/env node
/**
 * 收听视图的几何守卫（0.81.0）：**字幕不与正文同页**。
 *
 * 用户的原话是「字幕不要和文章在一个页面上」。这句话落到实现上是三件事，
 * 每件都能量出来，所以这里不靠肉眼：
 *
 *   ① 切到收听之后，标题、正文、正文里的提示条、文章页的入口条 **必须是
 *      `display:none`** —— 只把正文挤窄不算「不同页」；
 *   ② 播放条（`.npr-dock-slot`）与字幕区（`.npr-listen-body`）**必须还在**，
 *      而且有高度 —— 它们被 `data-listen-keep` 标着，是「留下」的白名单；
 *   ③ 字幕列表在独立页里要**吃掉剩余高度**（`max-height ≥ 320px`）：
 *      嵌在正文里时它是 `46vh`，整页只剩字幕时还这么小就等于把下半屏空着。
 *
 * ★ 两条反向对照，缺一条这套装置就是恒真的：
 *   A. `data-listen="false"` 时正文必须**可见** —— 证明显隐由数据驱动，
 *      不是「有条 CSS 把所有文章都藏了」；
 *   B. 把 CSS 里那条规则删掉后正文必须**可见** —— 证明判据读的确实是这份
 *      `refinements.css`，而不是别的什么让它碰巧变红/变绿。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CSS = readFileSync(join(ROOT, 'src/client/refinements.css'), 'utf8');

/** CSS 变量只是配色；这里量的是 display 与高度，缺变量不影响判定。 */
const FALLBACK = `:root{--npr-bg:#fff;--npr-bg-2:#fafafa;--npr-fg:#1a1a1a;--npr-muted:#666;--npr-faint:#999;--npr-border:#e5e5e5;--npr-hover:#f2f2f2;--npr-accent:#5b6bd6;--npr-accent-strong:#4553c0;}`;

const LINES = Array.from({ length: 6 }, (_, index) => `
  <button type="button" class="npr-tr-line${index === 1 ? ' is-current' : ''}" data-t="${index * 8}" data-tr-index="${index}">
    <span class="npr-tr-stamp">00:${String(index * 8).padStart(2, '0')}</span>
    <span class="npr-tr-text">第 ${index + 1} 段字幕，用来量「列表有没有吃掉剩余高度」。</span>
  </button>`).join('');

function fixture({ listen }) {
  return `
<article class="npr-article" data-listen="${listen}">
  <header class="npr-listen-head" data-listen-keep="true">
    <div class="npr-listen-meta"><span>Build Your SaaS</span><span>2026-04-18</span></div>
    <h1>What is Transistor's secret weapon?</h1>
  </header>
  <div class="npr-article-head"><span>Build Your SaaS</span><span>04/18/2026</span></div>
  <h1 data-probe="title">文章标题</h1>
  <div class="npr-dock-slot" data-listen-keep="true">
    <div class="npr-audio">
      <audio></audio>
      <div class="npr-audio-track">
        <input type="range" class="npr-audio-range" min="0" max="2470" step="0.5" value="42"
          aria-label="播放进度" style="--npr-progress: 1.7%">
      </div>
      <div class="npr-audio-bar" role="group">
        <button type="button" class="npr-audio-btn npr-audio-skip">−15</button>
        <button type="button" class="npr-audio-btn npr-audio-play" aria-label="播放">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 5l11 7-11 7z"/></svg>
        </button>
        <button type="button" class="npr-audio-btn npr-audio-skip">+15</button>
        <span class="npr-audio-time">00:42 / 41:09</span>
        <span class="npr-audio-end">
          <label class="npr-audio-rate"><select aria-label="播放倍速"><option>1×</option></select></label>
          <a class="npr-audio-src" href="#">原文</a>
        </span>
      </div>
    </div>
  </div>
  <button type="button" class="npr-listen-entry" data-probe="entry">
    <span class="npr-listen-entry-text"><strong>看图不如听一遍</strong><small>120 段字幕</small></span>
  </button>
  <div class="npr-prose" data-probe="prose"><p>这是正文。切到收听视图后它必须整块消失，而不是被挤到下面。</p></div>
  ${listen === 'true' ? `<div class="npr-listen-body" data-listen-keep="true">
    <section class="npr-tr is-standalone">
      <div class="npr-tr-head">
        <div class="npr-tr-toggle is-static"><span class="npr-tr-title">字幕</span><span class="npr-tr-meta">6 段 · 41:09 · 订阅源提供</span></div>
        <button type="button" class="npr-tr-zh" data-lang="both">双语</button>
      </div>
      <div class="npr-tr-list">${LINES}</div>
    </section>
  </div>` : ''}
</article>`;
}

const PROBE = `<script>
(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display }; };
  const measure = () => {
    const out = {};
    for (const root of document.querySelectorAll('.npr-article[data-listen]')) {
      const key = root.getAttribute('data-listen');
      const list = root.querySelector('.npr-tr-list');
      out[key] = {
        head: box(root.querySelector('.npr-article-head')),
        title: box(root.querySelector('[data-probe="title"]')),
        prose: box(root.querySelector('[data-probe="prose"]')),
        entry: box(root.querySelector('[data-probe="entry"]')),
        dock: box(root.querySelector('.npr-dock-slot')),
        body: box(root.querySelector('.npr-listen-body')),
        list: box(list),
        listMax: list ? getComputedStyle(list).maxHeight : '',
        keep: [...root.querySelectorAll('[data-listen-keep]')].map(box),
      };
    }
    document.title = 'D:' + JSON.stringify(out);
  };
  if (document.readyState === 'complete') measure();
  else window.addEventListener('load', measure);
})();
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'npr-listen-view-'));

function render({ css = CSS }) {
  const file = join(dir, `listen-${process.pid}.html`);
  // ★ 两棵树同时挂：`data-listen="true"` 验「正文消失」，`"false"` 是反向对照 A
  //   （同一个夹具、同一份 CSS，只有这个属性不同 ⇒ 差异只能来自它）。
  const body = fixture({ listen: 'true' }) + fixture({ listen: 'false' });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${FALLBACK}</style><style>${css}</style>
<style>body{width:760px;margin:0;padding:0}</style>
</head><body>${body}${PROBE}</body></html>`;
  writeFileSync(file, html);
  return { file, html };
}

/** `--shot <file>`：把夹具导出，方便配 Chrome `--screenshot` 用人眼复核。 */
const shotIndex = process.argv.indexOf('--shot');
if (shotIndex !== -1 && process.argv[shotIndex + 1]) {
  writeFileSync(process.argv[shotIndex + 1], render({}).html);
  console.log(`已导出夹具：${process.argv[shotIndex + 1]}`);
}

function run(file) {
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=760,1000', '--virtual-time-budget=3000', '--dump-dom', file,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  const match = dom.match(/<title>D:([\s\S]*?)<\/title>/);
  if (!match) throw new Error('探针没有回传（document.title 里没有 D: 前缀）');
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

/** 判据函数。反向对照复用同一个函数，所以「变异后变红」是可信的。 */
function failuresOf(data) {
  const fails = [];
  const on = data.true;
  const off = data.false;
  if (!on || !off) return ['探针只回传了部分用例：' + JSON.stringify(Object.keys(data))];

  const hidden = ['head', 'title', 'prose', 'entry'];
  for (const name of hidden) {
    if (!on[name]) { fails.push(`收听视图里 ${name} 没量到`); continue; }
    if (on[name].display !== 'none') fails.push(`收听视图里 ${name} 仍然 display:${on[name].display}（应当整块消失，而不是被挤下去）`);
  }
  for (const name of ['dock', 'body']) {
    if (!on[name] || on[name].display === 'none' || on[name].h === 0) {
      fails.push(`收听视图里 ${name} 不见了（它是 data-listen-keep 白名单，必须留着）`);
    }
  }
  if (on.keep.length !== 3) fails.push(`data-listen-keep 量到 ${on.keep.length} 个，应为 3 个`);
  for (const [index, item] of on.keep.entries()) {
    if (!item || item.display === 'none' || item.h === 0) fails.push(`白名单第 ${index + 1} 块被藏了`);
  }
  const maxHeight = Number.parseFloat(on.listMax);
  if (!Number.isFinite(maxHeight) || maxHeight < 320) {
    fails.push(`独立页字幕列表 max-height=${on.listMax}，应 ≥320px（否则下半屏空着）`);
  }
  // 反向对照 A：data-listen="false" 时正文必须回来。
  if (off.prose?.display === 'none') fails.push('data-listen="false" 时正文仍被藏 —— 显隐不是由数据驱动的');
  if (off.title?.display === 'none') fails.push('data-listen="false" 时标题仍被藏');
  return fails;
}

const baseline = failuresOf(run(render({}).file));

// 反向对照 B：把那条规则删掉，正文必须重新出现 ⇒ 判据读的确实是这份 CSS。
const stripped = CSS.replace(/\.npr-article\[data-listen="true"\]\s*>\s*\*:not\(\[data-listen-keep\]\)\s*\{[^}]*\}/, '');
if (stripped === CSS) {
  console.log('反向对照（删掉隐藏规则）：FAIL（在 refinements.css 里找不到那条规则，说明判据锚点过期了）');
}
const mutated = failuresOf(run(render({ css: stripped }).file));
const caught = mutated.some((line) => /仍然 display|被藏/.test(line));
console.log(`反向对照（删掉隐藏规则）：${caught ? 'OK（判据抓到了）' : 'FAIL（判据是假的）'}`);
if (!caught) for (const line of mutated) console.log(`  - ${line}`);

if (baseline.length === 0 && caught) {
  console.log('结论：通过（收听视图里正文整块消失、播放条与字幕仍在、列表吃满高度）');
  process.exit(0);
}
for (const line of baseline) console.log(`FAIL ${line}`);
console.log('结论：不通过');
process.exit(1);
