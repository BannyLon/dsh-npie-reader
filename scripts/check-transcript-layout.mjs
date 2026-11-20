#!/usr/bin/env node
/**
 * 单集播放条与字幕面板的**真浏览器布局守卫**（P0）。
 *
 * ★ 为什么必须有这个文件：`PANEL_CSS` 给裸 `button` 兜了 `width: 100%`（那条是给
 *   「整行按钮」用的）。播放条里的「−15 / 播放 / +15」一旦没写 `width: auto`，
 *   样式表**不会报错**，界面上是三行巨大的横条 —— 静态断言、类名核查、单测全绿。
 *   这个坑在本仓库真实发生过（工具栏的整理按钮），所以这里用真 Chrome 量宽度。
 *
 * ★ 判据全部是**可解释的量**，不是「看起来对」：
 *   ① 播放条三个按钮的宽度都远小于整行（并彼此接近，说明是同一套尺寸）；
 *   ② 整条控制区在 720px 下只占一行（`height` 不超过按钮高度两倍）；
 *   ③ 字幕行占满列表宽（它是可点的**整行**，不是一小段文字上的链接）；
 *   ④ 当前段的左轨真的画出来了（inset 阴影或 `::before` 都算，宽度 ≥2px 且上了色）；
 *   ⑤ 时间戳列没被压扁（压扁时正文会贴左边缘，读起来像掉字）；
 *   ⑥ 「字幕」标题是一行（折行后中文会竖排成「字 / 幕」，像一个错位的图标）；
 *   ⑦ 「倍速 + 原文」在同一行（拆开时「原文」会单独掉到第二行最左边）。
 *
 * ★ 反向对照：四条，每条都复刻一类真实缺陷 ——
 *   按钮拉成整行宽 ⇒ ①红；标题被挤成竖排 ⇒ ⑥红；右端整组用**旧写法**拆开 ⇒ ⑦红；
 *   当前段的左轨与阴影全删 ⇒ ④红（高亮只剩底色，扫读时找不到「播到哪」）。
 *   任何一条没变红，都说明那条判据量不到这类错，是假判据。
 *
 * 用法：
 *   node scripts/check-transcript-layout.mjs                 # 跑判据
 *   node scripts/check-transcript-layout.mjs --shot x.html   # 导出夹具给人眼复核
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const panelSrc = readFileSync(join(ROOT, 'src/client/ReaderPage.jsx'), 'utf8');
const PANEL_CSS = /const PANEL_CSS = `([\s\S]*?)\n`;/.exec(panelSrc)[1];
const REFINEMENTS = readFileSync(join(ROOT, 'src/client/refinements.css'), 'utf8');

/** 与 `preview-speech.mjs` 同一套近似主题：只影响颜色，不影响任何尺寸判据。 */
const THEME = `
:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f5f5f7;--dsw-alias-label-primary:#1b1b1f;
  --dsw-alias-label-secondary:#6b6b73;--dsw-alias-label-tertiary:#8e8e96;--dsw-alias-border-l1:#e3e3e8;
  --dsw-alias-border-l2:#cfcfd6;--dsw-alias-interactive-bg-hover:#f1f1f4;--dsw-alias-bg-layer-3:#fff;
  --dsw-alias-brand-primary:#d97706;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#d97706}
html,body{margin:0;padding:0;background:#fff}
.npr-root{font-family:-apple-system,"SF Pro Text","PingFang SC",sans-serif;font-size:13px;
  line-height:1.5;color:#1b1b1f;padding:20px;box-sizing:border-box}
`;

const PARAGRAPHS = [
  '欢迎收听这一期。今天我们聊的是「字幕到底该怎么读」这个问题，以及它为什么会变成一个产品问题。',
  '先说结论：字幕不是正文。它没有段落层次，也没有作者排版，只有一条条按呼吸切开的时间片段。',
  '所以我们做的第一件事是把这些片段重新并成段落，让「读」这件事成立，而不是让人对着 1500 行短句。',
  '第二件事是让每一段都能点：点一下，音频跳到那一段的起点。这需要时间轴，而不是行号。',
  '第三件事最容易被忽略：当前段要高亮，而且要高亮的那一段始终看得见。',
  '最后说说还没做的部分：本版本不做语音识别，只读订阅源自己提供的字幕文件。',
];

const PROBE = `<script>
(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) }; };
  const measure = () => {
    const out = { cases: {} };
    for (const root of document.querySelectorAll('.npr-root[data-case]')) {
      const key = root.getAttribute('data-case');
      const btns = [...root.querySelectorAll('.npr-audio-btn')].map(box);
      const bar = box(root.querySelector('.npr-audio-bar'));
      const list = box(root.querySelector('.npr-tr-list'));
      const lines = [...root.querySelectorAll('.npr-tr-line')];
      const current = root.querySelector('.npr-tr-line.is-current');
      const title = root.querySelector('.npr-tr-title');
      const rate = root.querySelector('.npr-audio-rate');
      const src = root.querySelector('.npr-audio-src');
      const range = root.querySelector('.npr-audio-range');
      const play = root.querySelector('.npr-audio-play');
      const zh = root.querySelector('.npr-audio-zh');
      out.cases[key] = {
        bar,
        btns,
        list,
        line: lines.length ? box(lines[0]) : null,
        lineH: lines.length ? box(lines[0]).h : 0,
        currentShadow: current ? getComputedStyle(current).boxShadow : '',
        // 左轨既可能是 inset 阴影，也可能是 ::before 伪元素（0.83.0 改成伪元素，
        // 为的是能做圆角与渐隐）。判据要的是「那条线真的画出来了」，
        // 而不是「用了哪个属性」—— 所以两种都采，谁在都算数。
        currentRail: current ? (() => {
          const rail = getComputedStyle(current, '::before');
          const width = Number.parseFloat(rail.width) || 0;
          const paint = rail.backgroundImage !== 'none' ? rail.backgroundImage : rail.backgroundColor;
          return { width, display: rail.display, paint };
        })() : null,
        stamp: root.querySelector('.npr-tr-stamp') ? box(root.querySelector('.npr-tr-stamp')) : null,
        title: title ? box(title) : null,
        rate: rate ? box(rate) : null,
        src: src ? box(src) : null,
        range: range ? box(range) : null,
        play: play ? box(play) : null,
        zh: zh ? box(zh) : null,
      };
    }
    document.title = 'D:' + JSON.stringify(out);
  };
  if (document.readyState === 'complete') measure();
  else window.addEventListener('load', measure);
})();
</script>`;

function fixture({ width, extraCss = '' }) {
  const lines = PARAGRAPHS.map((text, index) => `
      <button type="button" class="npr-tr-line${index === 1 ? ' is-current' : ''}" data-t="${index * 42}" data-tr-index="${index}">
        <span class="npr-tr-stamp">${String(Math.floor(index * 42 / 60)).padStart(2, '0')}:${String(index * 42 % 60).padStart(2, '0')}</span>
        <span class="npr-tr-text">${text}</span>
      </button>`).join('');
  return `
<div class="npr-root" data-case="w${width}" style="width:${width}px">
  <div class="npr-article">
    <h1>第 12 期 · 字幕不是正文</h1>
    <div class="npr-audio">
      <audio></audio>
      <div class="npr-audio-track">
        <input type="range" class="npr-audio-range" min="0" max="3723" step="0.5" value="42"
          aria-label="播放进度" style="--npr-progress: 1.1%">
      </div>
      <div class="npr-audio-bar" role="group">
        <button type="button" class="npr-audio-btn npr-audio-skip">−15</button>
        <button type="button" class="npr-audio-btn npr-audio-play" aria-label="暂停">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 4v16"/><path d="M15 4v16"/></svg>
        </button>
        <button type="button" class="npr-audio-btn npr-audio-skip">+15</button>
        <span class="npr-audio-time">00:42 / 1:02:03</span>
        <span class="npr-audio-end">
          <label class="npr-audio-rate"><select aria-label="播放倍速"><option>1×</option></select></label>
          <button type="button" class="npr-audio-zh" aria-pressed="true">双语</button>
          <a class="npr-audio-src" href="#">原文</a>
        </span>
      </div>
    </div>
    <section class="npr-tr">
      <div class="npr-tr-head">
        <button type="button" class="npr-tr-toggle" aria-expanded="true">
          <span class="npr-tr-title">字幕</span>
          <span class="npr-tr-meta">6 段 · 1:02:03 · 订阅源提供</span>
        </button>
        <button type="button" class="npr-tr-now">回到正在播的一段</button>
        <button type="button" class="npr-tr-refresh">重新获取</button>
      </div>
      <div class="npr-tr-list">${lines}</div>
    </section>
  </div>
</div>
<style>${extraCss}</style>`;
}

const dir = mkdtempSync(join(tmpdir(), 'npr-tr-layout-'));

function render(extraCss = '') {
  const body = [720, 420].map((width) => fixture({ width, extraCss })).join('\n');
  const file = join(dir, `tr-${process.pid}.html`);
  writeFileSync(file, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${THEME}</style><style>${PANEL_CSS}</style><style>${REFINEMENTS}</style>
<style>body{display:flex;flex-direction:column;gap:16px;padding:0}</style>
</head><body>${body}${PROBE}</body></html>`);
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

/**
 * 判据。抽成函数是为了让**反向对照**用同一个函数 —— 变异版必须在这里吐失败项。
 * @param {object} data - 两种宽度下的实测
 */
function failuresOf(data) {
  const fails = [];
  for (const [key, d] of Object.entries(data.cases)) {
    const width = Number(key.slice(1));
    // ── ① 三个按钮都不该占满整行 ────────────────────────────────────────────
    if (d.btns.length !== 3) fails.push(`${key}: 播放条按钮数 ${d.btns.length}，应为 3`);
    for (const [index, btn] of d.btns.entries()) {
      if (btn.w >= width * 0.5) {
        fails.push(`${key}: 第 ${index + 1} 个按钮宽 ${btn.w}px（容器 ${width}px）—— 很可能吃到了裸 button 的 width:100%`);
      }
    }
    // ── ② 720px 下控制区只占一行 ────────────────────────────────────────────
    if (width === 720) {
      const tallest = Math.max(...d.btns.map((btn) => btn.h));
      if (d.bar.h > tallest * 2) fails.push(`${key}: 控制区高 ${d.bar.h}px，按钮高 ${tallest}px —— 被折成了多行`);
    }
    // ── ③ 字幕行是**整行**可点，不是一小段文字 ──────────────────────────────
    if (d.line === null) {
      fails.push(`${key}: 没有渲染出字幕行`);
    } else if (Math.abs(d.line.w - d.list.w) > 16) {
      fails.push(`${key}: 字幕行宽 ${d.line.w}px ≠ 列表宽 ${d.list.w}px（差 ${d.list.w - d.line.w}px）`);
    }
    // ── ④ 当前段的高亮必须看得见 ────────────────────────────────────────────
    // 两种实现都接受：inset 阴影，或 `::before` 画出来的左轨。都有「宽度 > 0 且真的上了色」
    // 两条硬指标 —— 只断「伪元素存在」的话，`display:none` 也能骗过去。
    {
      const hasInset = d.currentShadow.includes('inset');
      const rail = d.currentRail;
      // ★ 渐变也算画出来了：左轨用了 `linear-gradient(accent, accent 72%, transparent)`，
      //   末端那个 transparent 是设计的一部分（渐隐收口）。只查「颜色不是透明」会把
      //   渐变整条误判成没上色 —— 这正是本判据第一版在 420px 上自己先红的原因。
      const paint = rail?.paint ?? '';
      const gradient = /gradient\(/.test(paint);
      const railPainted = Boolean(rail) && rail.display !== 'none' && rail.width >= 2
        && paint !== '' && paint !== 'none'
        && (gradient || !/^(transparent|rgba?\(\s*0,\s*0,\s*0,\s*0\s*\))$/.test(paint));
      if (!hasInset && !railPainted) {
        fails.push(`${key}: 当前段既没有 inset 细线（box-shadow=${d.currentShadow}），也没有画出来的左轨（::before 宽 ${rail?.width ?? 0}px，${rail?.paint ?? '缺失'}）`);
      }
    }
    // ── ⑤ 时间戳列不能被压成 0（压扁时正文会贴到左边缘，读起来像掉字）────────
    if (d.stamp === null || d.stamp.w < 30) {
      fails.push(`${key}: 时间戳列宽 ${d.stamp?.w ?? '缺失'}px，应为固定 46px 左右`);
    }
    // ── ⑥ 「字幕」两个字必须在同一行 ────────────────────────────────────────
    // 12.5px 字号的行盒约 19px；一旦标题被挤到折行，中文会竖着排成「字 / 幕」，
    // 看上去像一个错位的图标而不是标题 —— 高度是最直接的量。
    if (d.title === null) fails.push(`${key}: 找不到 .npr-tr-title`);
    else if (d.title.h > 26) fails.push(`${key}: 标题高 ${d.title.h}px（单行应 ≤ 26px）—— 被折成了竖排`);
    // ── ⑦ 右端「倍速 + 原文」不能被拆成两行 ─────────────────────────────────
    // 拆开时「原文」会单独掉到第二行最左边，像一个掉队的标签。
    // ★ 比的是**竖直中心**，不是 `top`：两者字号不同（倍速含一个 22px 高的下拉框、
    //   原文是 11.5px 文字），同一行里 `top` 本来就差 5px。按 `top` 判会把「对齐了」
    //   判成「换行了」—— 判据把量纲选错，等于自己造了一个假失败。
    const centerY = (b) => b.top + b.h / 2;
    if (d.rate === null || d.src === null) {
      fails.push(`${key}: 播放条右端缺项（倍速 ${d.rate ? '有' : '无'} / 原文 ${d.src ? '有' : '无'}）`);
    } else if (Math.abs(centerY(d.src) - centerY(d.rate)) > 8) {
      fails.push(`${key}: 「原文」与「倍速」的竖直中心差 ${Math.round(Math.abs(centerY(d.src) - centerY(d.rate)))}px —— 右端整组被拆成了两行`);
    } else if (d.src.left < d.rate.left) {
      fails.push(`${key}: 「原文」(left ${d.src.left}) 跑到了「倍速」(left ${d.rate.left}) 左边`);
    }
    // ── ⑧ 进度条必须自己占满一行 ────────────────────────────────────────────
    // 它是「拖到哪」的唯一入口：宽度不够就拖不准（1px 对应几秒）。塞回控制区
    // 那一行时宽度会掉到 300px 以下，而 420px 面板下更窄。
    if (d.range === null) {
      fails.push(`${key}: 没有渲染进度条（.npr-audio-range）`);
    } else if (d.range.w < width * 0.88) {
      fails.push(`${key}: 进度条宽 ${d.range.w}px（面板 ${width}px）—— 没占满一行，拖不准`);
    }
    // ── ⑨ 播放按钮是**圆**，不是长条 ────────────────────────────────────────
    if (d.play === null) {
      fails.push(`${key}: 找不到播放按钮（.npr-audio-play）`);
    } else if (Math.abs(d.play.w - d.play.h) > 2 || d.play.w < 34) {
      fails.push(`${key}: 播放按钮 ${d.play.w}×${d.play.h}px —— 应是一个 ≥34px 的圆`);
    }
  }
  return fails;
}

const shotIndex = process.argv.indexOf('--shot');
if (shotIndex !== -1) {
  const target = process.argv[shotIndex + 1];
  if (!target) throw new Error('--shot 需要一个输出路径');
  writeFileSync(target, readFileSync(render()));
  console.log(`已导出夹具：${target}`);
  process.exit(0);
}

const baseline = failuresOf(run(render()));
console.log(`基线：${baseline.length === 0 ? 'OK' : 'FAIL'}`);
for (const line of baseline) console.log(`  - ${line}`);

/**
 * 反向对照：每条判据都要配一条「把实现改坏」的变异，改完必须变红。
 *
 * ★ 为什么不是随手改坏一处就算数：判据和实现出自同一双手，只跑基线等于自证。
 *   ⑦ 的变异特别写成了**旧实现的样子**（`display:contents` 拆掉分组 + 倍速自己吃
 *   `margin-left:auto`），而不是随便删个属性 —— 只有复刻那个真实缺陷，才能证明
 *   这条判据真的挡得住它。
 */
const MUTATIONS = [
  { name: '按钮被拉成整行宽', css: '.npr-audio-btn{width:100%!important}', expect: 'width:100%' },
  { name: '当前段没有细线', css: '.npr-tr-line.is-current{box-shadow:none!important}.npr-tr-line.is-current::before{display:none!important}', expect: '没有画出来的左轨' },
  { name: '标题被挤成竖排', css: '.npr-tr-title{flex:1 1 0;min-width:0;white-space:normal}', expect: '竖排' },
  // ⑦ 的变异：右端**组内**允许换行（`flex-wrap:wrap`）后被挤窄 —— 现实里很常见
  // （有人想「窄了就换行」），代价是「原文」单独掉到第二行左侧。整组一起换行是
  // 可以接受的，组内拆开不行，这条判据守的正是后者。
  { name: '右端整组内部被拆开', css: '.npr-audio-end{flex-wrap:wrap;width:110px}', expect: '被拆成了两行' },
  // ⑧ 的变异：把进度条塞回控制区那一行（本轮之前的形态）。它不会消失，只是变得很短。
  { name: '进度条被塞回控制区一行', css: '.npr-audio-track{display:contents}.npr-audio-range{width:120px!important}', expect: '拖不准' },
];

let missed = 0;
for (const mutation of MUTATIONS) {
  const caught = failuresOf(run(render(mutation.css))).some((line) => line.includes(mutation.expect));
  console.log(`反向对照（${mutation.name}）：${caught ? 'OK（判据抓到了）' : 'FAIL（判据是假的）'}`);
  if (!caught) missed += 1;
}

const failed = baseline.length > 0 || missed > 0;
console.log(failed ? '\n结论：不通过' : '\n结论：通过');
process.exit(failed ? 1 : 0);
