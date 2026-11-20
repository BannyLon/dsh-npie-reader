#!/usr/bin/env node
/**
 * 字幕自动跟随 + 高度自适应：**真 Chrome + 真 `TranscriptPanel`**。
 *
 * ---- 守的是 2026-11-19 的现场 ---------------------------------------------
 *
 * 用户听一集 54 分钟、209 段：当前段一直在高亮，但它**沉到列表下面去了**，
 * 得反复点「回到正在播的一段」。截图里列表盒子从窗口中部一直延伸到底部之外，
 * 高亮的那一段在视口里根本看不到。
 *
 * 两个原因是叠在一起的：
 *   ① 列表**不自动滚**（0.83.0 当时的取舍：怕跟走之后用户往回看要拽回来）；
 *   ② 列表高度写死 `46vh` / `calc(100vh - 330px)`，而收听视图里字幕上方
 *      （标题 + 播放条 + tab）实测 500px 以上 ⇒ 盒子比窗口还高。
 *
 * ---- 判据（缺一不可）------------------------------------------------------
 *
 *   修法：推进时间后，当前段必须完整落在「列表可视区 ∩ 窗口」里，**并且贴在列表
 *         顶部**（`curTop − listTop` ≈ 列表自身的 8px padding），列表高度必须等于
 *         「窗口高度 − 列表上方那一截 − 32」，并且随窗口高度变化。
 *   误暂停：指针停在列表上滚**页面**（`wheel` 冒泡过来但 `scrollTop` 没变）之后，
 *         跟随必须还开着 —— 0.86.2 的现场就是这里被悄悄关掉，用户以为「不跟随」。
 *   对照：拆掉自动滚动 ⇒ 当前段必须**滚出**可视区（证明判据有牙）。
 *   对照：拆掉量出来的高度 ⇒ 列表必须**超出**窗口预算（证明「写死高度」真的会坏）。
 *   对照：把贴顶改回 0.85.9 的居中 ⇒ 当前段必须**不在**顶部（证明「贴顶」不是恒真式）。
 *
 * 探针页故意在字幕上方放一块 520px 的假头部：复刻收听视图的排版，否则
 * 「盒子比窗口高」这件事在探针里根本不会发生。
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIR = mkdtempSync(join(tmpdir(), `npr-tr-follow-${process.pid}-`));

/**
 * 样式必须是真的。
 *
 * ★ 第一版把 CSS loader 设成 `empty`，量出来 `listH=500 / scrollHeight=500` ——
 *   没有 `.npr-tr-line` 的 `display:grid`，40 段按 inline-block 横向排，列表既不高
 *   也不滚，「跟不跟随」根本无从谈起。判据看着在跑，其实量的是浏览器默认样式。
 */
const readerSrc = readFileSync(join(root, 'src/client/ReaderPage.jsx'), 'utf8');
const cssStart = readerSrc.indexOf('const PANEL_CSS = `');
const cssEnd = cssStart < 0 ? -1 : readerSrc.indexOf('`;', cssStart);
if (cssStart < 0 || cssEnd < cssStart) throw new Error('抽 PANEL_CSS 失败（ReaderPage 里的边界变了）');
const PANEL_CSS = readerSrc.slice(cssStart + 'const PANEL_CSS = `'.length, cssEnd);
if (!PANEL_CSS.includes('.npr-root')) throw new Error('PANEL_CSS 里没有 .npr-root —— 抽错了');
const REFINEMENTS = readFileSync(join(root, 'src/client/refinements.css'), 'utf8');
if (!REFINEMENTS.includes('.npr-tr-list')) throw new Error('refinements.css 里没有 .npr-tr-list —— 抽错了');

/** 近似主题变量：只影响颜色，不影响任何尺寸判据。 */
const THEME = `
:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f5f5f7;--dsw-alias-label-primary:#1b1b1f;
  --dsw-alias-label-secondary:#6b6b73;--dsw-alias-label-tertiary:#8e8e96;--dsw-alias-border-l1:#e3e3e8;
  --dsw-alias-border-l2:#cfcfd6;--dsw-alias-interactive-bg-hover:#f1f1f4;--dsw-alias-bg-layer-3:#fff;
  --dsw-alias-brand-primary:#d97706;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#d97706}
html,body{margin:0;padding:0;background:#fff}
`;

/** 段数与段长：要足够多，让「滚到中段」这件事一定有位移。 */
const PARAGRAPHS = 40;
const STEP = 20;
/** 字幕上方那一截的高度（复刻收听视图：标题 + 播放条 + tab）。 */
const HEAD_PX = 520;

/**
 * 变异：把新行为改回旧行为，判据必须变红。
 *
 * · `nofollow` —— 整段提前返回（等价于 0.83.0 的「不跟随」）。
 * · `noheight` —— 不写行内 `maxHeight`（等价于只靠 CSS 里那档死值）。
 * · `centered` —— 复刻 0.85.9 的「居中」，用来证明「贴顶」这条判据不是恒真式。
 */
const MUTATIONS = {
  nofollow: {
    from: 'if (!expanded || active < 0 || !followRef.current) return;',
    to: 'if (!expanded || active < 0 || true) return;',
    what: '自动跟随（整段提前返回）',
  },
  noheight: {
    from: 'style={listHeight === null ? undefined : { maxHeight: `${listHeight}px` }}',
    to: 'style={undefined}',
    what: '量出来的列表高度',
  },
  centered: {
    from: 'const offset = lineBox.top - listBox.top + list.scrollTop;',
    to: 'const offset = lineBox.top - listBox.top + list.scrollTop - (list.clientHeight - lineBox.height) / 2;',
    what: '贴顶（居中才能复现 0.85.9 的「停在底部」）',
  },
};

async function bundle(name, mutation) {
  const outfile = join(DIR, `${name}.js`);
  const rule = mutation ? MUTATIONS[mutation] : null;
  await esbuild.build({
    entryPoints: [join(DIR, 'entry.jsx')],
    bundle: true,
    format: 'iife',
    outfile,
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [join(root, 'node_modules')],
    loader: { '.css': 'empty' },
    logLevel: 'error',
    plugins: [
      {
        name: 'mutate',
        setup(build) {
          build.onLoad({ filter: /TranscriptPanel\.jsx$/ }, async (args) => {
            let source = await import('node:fs/promises').then((fs) => fs.readFile(args.path, 'utf8'));
            if (rule) {
              if (!source.includes(rule.from)) {
                throw new Error(`变异体 ${mutation} 没打上：源码里找不到「${rule.what}」（\`${rule.from}\`）`);
              }
              source = source.replace(rule.from, rule.to);
            }
            return { contents: source, loader: 'jsx' };
          });
        },
      },
    ],
  });
  return `${name}.js`;
}

/** 页面：挂载 → 推到第 8 段 → 量 → 推到第 26 段 → 量 → 改窗口？→ 回传。 */
const PAGE = (bundleName, headPx) => `<!doctype html><html><head><meta charset="utf-8">
<style>${THEME}</style>
<style id="panel">${PANEL_CSS}</style>
<style id="refinements">${REFINEMENTS}</style>
<style>
  .fake-head{height:${headPx}px;background:#fafafa;border-bottom:1px solid #ddd;box-sizing:border-box;padding:16px}
  .wrap{padding:16px}
</style></head>
<body>
<div class="fake-head">标题 / 播放条 / tab</div>
<div class="wrap"><div class="npr-root" id="host"></div></div>
<script src="/${bundleName}"></script>
<script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = document.getElementById('host');

/** 当前段是否**完整**落在「列表可视区 ∩ 窗口」里。 */
const snapshot = () => {
  const list = host.querySelector('.npr-tr-list');
  const line = host.querySelector('.npr-tr-line.is-current');
  if (!list || !line) return { missing: true };
  const l = list.getBoundingClientRect();
  const c = line.getBoundingClientRect();
  const panel = host.querySelector('.npr-tr').getBoundingClientRect();
  const top = Math.max(l.top, 0);
  const bottom = Math.min(l.bottom, window.innerHeight);
  return {
    innerH: window.innerHeight,
    /** 列表顶相对面板顶：组件算高度时用的就是这一截（不是窗口里的绝对位置）。 */
    headOffset: Math.round(l.top - panel.top),
    listH: Math.round(l.height),
    listTop: Math.round(l.top),
    scrollTop: Math.round(list.scrollTop),
    scrollHeight: Math.round(list.scrollHeight),
    clientH: Math.round(list.clientHeight),
    curTop: Math.round(c.top),
    curBottom: Math.round(c.bottom),
    /** 当前段顶离列表顶多少：贴顶应约等于列表自身的 padding（8px）。 */
    gapTop: Math.round(c.top - l.top),
    /** 完整可见 = 段在列表内 AND 段在视口内。 */
    visible: c.top >= top - 1 && c.bottom <= bottom + 1,
  };
};

(async () => {
  const out = {};
  window.__mount(host);
  await sleep(500);
  out.mount = snapshot();
  // 推到第 8 段附近（8 × 20 = 160s）
  window.__play(160);
  await sleep(600);
  out.a = snapshot();
  // 推到第 26 段附近（26 × 20 = 520s）
  window.__play(520);
  await sleep(600);
  out.b = snapshot();
  // ① 指针停在列表上滚**页面**（wheel 来了，但列表自己的 scrollTop 没变）
  //    ⇒ 不许暂停跟随，推进时间后必须仍然贴顶。0.86.2 的现场就是这里被误关。
  const list = host.querySelector('.npr-tr-list');
  list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 480 }));
  await sleep(250);
  window.__play(700);
  await sleep(600);
  out.ghost = snapshot();
  // ② 真的滚了列表（wheel + scrollTop 变化）⇒ 暂停跟随，位置不许再被拽走。
  list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 200 }));
  list.scrollTop = 0;
  await sleep(250);
  const before = Math.round(list.scrollTop);
  window.__play(620);
  await sleep(500);
  out.paused = { before, after: Math.round(list.scrollTop) };
  // 点「继续跟随」⇒ 恢复（并且要**立刻**滚，不能等下一段）
  const now = host.querySelector('.npr-tr-now');
  out.pausedLabel = now ? now.textContent : '';
  if (now) now.click();
  await sleep(500);
  out.resumed = snapshot();
  out.nowLabel = now ? now.textContent : '';
  // ③ 第二个出口：暂停之后用户按播放键 ⇒ 必须恢复跟随（0.86.2 现场的唯一出路）。
  list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 200 }));
  list.scrollTop = 0;
  await sleep(250);
  window.__pressPlay();
  await sleep(200);
  window.__play(700);
  await sleep(600);
  out.byPlay = snapshot();
  out.byPlayLabel = host.querySelector('.npr-tr-now')?.textContent ?? '';
  await fetch('/report', { method: 'POST', body: JSON.stringify(out) });
})();
</script></body></html>`;

writeFileSync(join(DIR, 'entry.jsx'), `
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { TranscriptPanel } from ${JSON.stringify(join(root, 'src/client/TranscriptPanel.jsx'))};

const STEP = ${STEP};
const paragraphs = Array.from({ length: ${PARAGRAPHS} }, (_, i) => ({
  start: i * STEP,
  end: (i + 1) * STEP,
  text: '第 ' + (i + 1) + ' 段的字幕文本，长度差不多就好，用来验证滚动与高亮是同一段。',
}));

/* 假控制器：只提供「订阅」「seek」，外加一个能被派发事件的 audio 元素桩。
   ★ 桩必须是真的 HTMLAudioElement（createElement('audio')）：组件用
   controller.element.addEventListener('play'…) 恢复跟随，用普通对象测不出来。 */
const listeners = new Set();
const audioStub = document.createElement('audio');
const controller = {
  element: audioStub,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  seek(seconds) { return seconds; },
};
window.__play = (seconds) => { for (const fn of listeners) fn(seconds); };
/** 模拟用户按播放键（真机上这会派发 play 事件）。 */
window.__pressPlay = () => { audioStub.dispatchEvent(new Event('play')); };
window.__mount = (host) => {
  createRoot(host).render(
    <TranscriptPanel
      transcript={{ paragraphs }}
      status="ready"
      controller={controller}
      translation={{ status: 'idle', translations: [], total: 0, done: false, error: '' }}
      langMode="source"
      standalone
      asr={{ status: 'idle' }}
    />,
  );
};
`);

async function run(bundleName, headPx) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE(bundleName, headPx));
      }
      if (url.pathname === `/${bundleName}`) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(readFileSync(join(DIR, bundleName)));
      }
      if (url.pathname === '/report') {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        return req.on('end', () => {
          res.writeHead(200); res.end('ok');
          clearTimeout(timer);
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
          server.close();
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        });
      }
      res.writeHead(404); res.end();
    });
    let child;
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* 同上 */ }
      try { server.close(); } catch { /* 同上 */ }
      reject(new Error(`探针超时（${bundleName}）：页面没有回传报告`));
    }, 90_000);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      child = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
        '--window-size=1100,900',
        `--user-data-dir=${join(DIR, `profile-${bundleName}-${headPx}`)}`,
        `http://127.0.0.1:${port}/`,
      ], { stdio: 'ignore' });
      child.on('error', reject);
    });
  });
}

/** 判据。抽成纯函数，便于对着数字讲理。 */
export function failuresOf(fixed, noFollow, noHeight, noCenter) {
  const fails = [];
  /** 列表理论高度：窗口高度 − 列表上方那一截（相对面板）− 32（组件里的同一口径）。 */
  const budget = (snap) => Number(snap.innerH) - Number(snap.headOffset) - 32;
  /** 贴顶：段顶离列表顶不超过这个像素（列表自身 8px padding + 4px 容差）。 */
  const TOP_BAND = 12;

  if (!fixed.a || !fixed.b) return ['修法：没拿到推进时间后的读数'];
  if (fixed.a.missing || fixed.b.missing) return ['修法：找不到 .npr-tr-list 或当前段'];

  // ① 当前段必须在可视区里（两次都成立）。
  for (const tag of ['a', 'b']) {
    if (!fixed[tag].visible) {
      fails.push(`修法：推到 ${tag === 'a' ? '第 8' : '第 26'} 段后当前段不在可视区（curTop=${fixed[tag].curTop} curBottom=${fixed[tag].curBottom} listTop=${fixed[tag].listTop} innerH=${fixed[tag].innerH}）`);
    }
  }
  // ①′ 而且要**贴在列表顶部**（0.86.1 用户明确要求：正在说的那句永远在第一行）。
  for (const tag of ['a', 'b']) {
    if (!(Number(fixed[tag].gapTop) <= TOP_BAND)) {
      fails.push(`修法：推到 ${tag === 'a' ? '第 8' : '第 26'} 段后当前段没有贴顶（段顶距列表顶 ${fixed[tag].gapTop}px，应 ≤ ${TOP_BAND}px）`);
    }
  }
  // ①″ 滚**页面**（wheel 冒泡到列表，但列表自己的 scrollTop 没变）不许关掉跟随。
  //    0.86.2 现场：指针停在列表上滚页面 ⇒ 跟随被悄悄关掉 ⇒「听着听着字幕不动了」。
  if (!fixed.ghost || fixed.ghost.missing) {
    fails.push('误暂停：没拿到「只在页面上滚动」之后的读数');
  } else {
    if (!fixed.ghost.visible) {
      fails.push(`误暂停：滚页面之后推进到第 35 段，当前段不在可视区（curTop=${fixed.ghost.curTop}）`);
    }
    if (!(Number(fixed.ghost.gapTop) <= TOP_BAND)) {
      fails.push(`误暂停：指针停在列表上滚页面之后，当前段没有贴顶（gapTop=${fixed.ghost.gapTop}）—— 跟随被误判成「用户滚了列表」`);
    }
  }
  // ② 真的滚了（不是「内容太少不用滚」）。
  if (!(fixed.b.scrollTop > 0)) {
    fails.push(`修法：推到第 26 段后 scrollTop 仍是 ${fixed.b.scrollTop}（列表根本没滚）`);
  }
  // ③ 列表高度必须按窗口算出来（不是 CSS 里那档死值）。
  if (Math.abs(fixed.b.listH - budget(fixed.b)) > 8) {
    fails.push(`修法：列表高 ${fixed.b.listH}px，按「窗口 ${fixed.b.innerH} − 上方 ${fixed.b.headOffset} − 32」应约 ${budget(fixed.b)}px`);
  }
  if (!(fixed.b.listH >= 180)) fails.push(`修法：列表高 ${fixed.b.listH}px 太矮，读不了几行`);

  // ④ 滚轮打断跟随：位置不许再被拽走；点「继续跟随」之后必须**立刻**恢复（含贴顶）。
  if (!fixed.paused || fixed.paused.before !== fixed.paused.after) {
    fails.push(`跟随开关：用户滚开之后位置还是被改了（${fixed.paused?.before} → ${fixed.paused?.after}）`);
  }
  if (!fixed.resumed?.visible) fails.push('跟随开关：点「继续跟随」之后当前段仍不在可视区');
  else if (Number(fixed.resumed.gapTop) > TOP_BAND) {
    fails.push(`跟随开关：点「继续跟随」之后当前段没有贴顶（gapTop=${fixed.resumed.gapTop}）—— 开关打开了但没立刻滚`);
  }
  if (!String(fixed.pausedLabel || '').includes('继续跟随')) {
    fails.push(`跟随开关：滚开之后按钮文案是「${fixed.pausedLabel}」，应变成「继续跟随」（否则用户不知道能恢复）`);
  }
  if (!String(fixed.nowLabel || '').includes('回到正在播的一段')) {
    fails.push(`跟随开关：点过之后按钮文案是「${fixed.nowLabel}」，应回到「回到正在播的一段」`);
  }
  // ④′ 第二个出口：暂停之后按播放键 ⇒ 必须恢复跟随（否则用户只能靠那个不显眼的按钮）。
  if (!fixed.byPlay || fixed.byPlay.missing) {
    fails.push('按播放恢复：没拿到「暂停后按播放」的读数');
  } else if (Number(fixed.byPlay.gapTop) > TOP_BAND) {
    fails.push(`按播放恢复：暂停后按播放键、推进到第 35 段，当前段没有贴顶（gapTop=${fixed.byPlay.gapTop}）—— 播放没有把跟随重新打开`);
  }

  // ⑤ 反向对照：拆掉自动滚动 ⇒ 第 26 段必须滚出可视区。
  if (!noFollow?.b || noFollow.b.missing) fails.push('对照：没拿到「不自动滚」的读数');
  else if (noFollow.b.visible) {
    fails.push('对照：拆掉自动滚动之后当前段仍然可见 —— 这套装置量不到「不跟随」，判据是假的');
  }

  // ⑥ 反向对照：不写行内高度 ⇒ 列表必须回到 CSS 那档死值（与「按窗口算」明显不同）。
  if (!noHeight?.b || noHeight.b.missing) fails.push('对照：没拿到「只靠 CSS 高度」的读数');
  else if (Math.abs(noHeight.b.listH - fixed.b.listH) <= 40) {
    fails.push(`对照：拆掉量出来的高度之后列表高 ${noHeight.b.listH}px，与按窗口算的 ${fixed.b.listH}px 几乎一样 —— 说明行内高度没起作用（或 CSS 死值恰好同尺寸）`);
  }

  // ⑦ 反向对照：把贴顶改回 0.85.9 的居中 ⇒ 当前段必须明显离开顶部。
  //    没有这一条，「贴顶」判据可能只是碰巧过：居中在短列表里也可能接近顶部。
  if (!noCenter?.b || noCenter.b.missing) fails.push('对照：没拿到「居中」的读数');
  else if (Number(noCenter.b.gapTop) <= TOP_BAND * 3) {
    fails.push(`对照：改回居中之后段顶距列表顶只有 ${noCenter.b.gapTop}px，仍然贴着顶部 —— 「贴顶」判据量不出区别`);
  }
  return fails;
}

const fixedBundle = await bundle('fixed', null);
const noFollowBundle = await bundle('nofollow', 'nofollow');
const noHeightBundle = await bundle('noheight', 'noheight');
const noCenterBundle = await bundle('centered', 'centered');

const fixed = await run(fixedBundle, HEAD_PX);
const noFollow = await run(noFollowBundle, HEAD_PX);
const noHeight = await run(noHeightBundle, HEAD_PX);
const noCenter = await run(noCenterBundle, HEAD_PX);
const fails = failuresOf(fixed, noFollow, noHeight, noCenter);
console.log('修法：', JSON.stringify(fixed));
console.log('对照（不跟随）：', JSON.stringify(noFollow));
console.log('对照（写死高度）：', JSON.stringify(noHeight));
console.log('对照（居中）：', JSON.stringify(noCenter));
if (fails.length === 0) {
  console.log('字幕自动跟随：OK（当前段贴顶 · 滚轮可暂停/可恢复 · 列表高度按窗口算）');
  process.exit(0);
}
for (const line of fails) console.log(`  - ${line}`);
console.log('字幕自动跟随：FAIL');
process.exit(1);
