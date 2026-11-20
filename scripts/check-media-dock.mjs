#!/usr/bin/env node
/**
 * 播放条真机守卫：**「时长未知 ⇒ 拖不动」这一整类回归**。
 *
 * ---- 这条守卫守的是 2026-11-19 的现场 --------------------------------------
 *
 * 用户的反馈是三件事：「不记录听的进度」「进度条不能拖动跳转」「±15s 不作用」。
 * 静态读代码与 `test/media-dock.test.mjs`（假元素）全都通过 —— 因为它们测的是
 * 「调 `seek()` 会不会写 `currentTime`」，而真实故障发生在**更前面一步**：
 *
 *   `<audio preload="none">` 之下，用户不点播放就一个字节都不取 ⇒ `duration` 是
 *   `NaN` ⇒ 进度条分母是 0 ⇒ `max=0` ⇒ **滑块物理上没有行程**，±15 的目标被夹到
 *   `[0, 0]`。播放、暂停、倍速全都好，只有「跟位置有关」的操作全哑。
 *
 * 真机实测（真 Chrome + 真 `MediaDock` + 真 Range 中转）：
 *   · `preload="none"`    → `{max:0, text:"00:00 / 00:00"}`，重挂后 `{max:0, t:0}`
 *   · `preload="metadata"`→ `{max:3987.6, text:"00:00 / 1:06:27"}`，重挂后精确恢复
 *
 * ---- 判据怎么才算有牙 ------------------------------------------------------
 *
 * 两条都要：
 *   ① 修法（`metadata`）：挂载即有总时长、断点位置立刻显示、拖动真的改
 *      `currentTime`、重挂之后位置还在；
 *   ② 反向对照（把源码里 `preload="metadata"` 改回 `"none"`，**必须**读到
 *      `max === 0`）。
 *
 * 只有 ①：判据可能是恒真式（比如 Chromium 以后不等 preload 也预取）。
 * 只有 ②：说明修法没被验证。
 *
 * ---- 为什么不依赖外网 ------------------------------------------------------
 *
 * 门禁要能离线跑。音频用现场生成的 120 秒 WAV（静音 PCM，Chromium 原生支持，
 * 头里就有总时长），由一个支持 `Range` 的本地服务发出 —— 那正是宿主中转层
 * （`/library/audio`）在客户端眼里的样子。
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
const DIR = mkdtempSync(join(tmpdir(), `npr-media-dock-${process.pid}-`));

/** 音频时长（秒）。要大于 `resumeAt` 的「剩不到 5 秒就从头」阈值。 */
const MEDIA_SECONDS = 120;
/** 预置的断点位置（秒）。> 3 才会被 `resumeAt` 恢复。 */
const SAVED_AT = 42;

function makeWav(seconds, sampleRate = 8_000) {
  const frames = seconds * sampleRate;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // 单声道
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  // 静音（全 0）：要的是「时长与分段」，不是声音。
  return buffer;
}

const WAV = makeWav(MEDIA_SECONDS);

/**
 * 打包真实的 `MediaDock`。
 *
 * `mutate` 有两种，各造一条**反向/边界对照**：
 *
 *   · `'total'`      —— 删掉唯一那句「把时长写进分母」。等价于旧版
 *                      `preload="none"` 之下的实际效果（`duration` 拿不到），
 *                      必须让 `max` 变 0，证明判据不是恒真式。
 *   · `'controller'` —— 不把控制器写进 ref，模拟「控制器没装上」。
 *                      旧版按钮是 `controllerRef.current?.nudge(±15)`，此时**静默
 *                      无操作**；而播放键走的是 `element.paused`，照样能播 ——
 *                      这正是「能听，但按 ±15 没反应」的形态。新版 `seekTo()` 在
 *                      控制器缺席时直接写 `element.currentTime`，必须仍然生效。
 *
 * ★ 为什么不用「把 `preload` 改回 `none`」做 `total` 的对照（第一版这么做，实测
 *   **不红**）：本地 WAV 只有 1.9 MB，Chromium 无论 preload 是什么都会先把头取回来
 *   解析出 `duration` —— 于是对照版也读到 `max=120`。真实故障要 64 MB 的远端 m4a
 *   才稳定复现（现场就是那个），门禁不能依赖外网。
 * ★ 变异在**内存里**做，不落盘：门禁被打断不会在源码目录留下变异体。
 */
const MUTATIONS = {
  total: {
    from: 'if (value > 0) setTotal(value);',
    to: '',
    what: '把时长写进分母',
  },
  controller: {
    from: 'controllerRef.current = controller;',
    to: '',
    what: '把控制器写进 ref',
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
          build.onLoad({ filter: /MediaDock\.jsx$/ }, async (args) => {
            let source = await import('node:fs/promises').then((fs) => fs.readFile(args.path, 'utf8'));
            if (rule) {
              if (!source.includes(rule.from)) {
                throw new Error(`变异体 ${mutation} 没打上：源码里找不到「${rule.what}」那一行（\`${rule.from}\`）`);
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

/** 页面：挂载 → 读锚点 → 点 +15s → 拖到 90s → 卸载重挂 → 回传。 */
const PAGE = (bundleName) => `<!doctype html><html><head><meta charset="utf-8"><title>dock</title></head>
<body><div id="host"></div>
<script src="/${bundleName}"></script>
<script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const host = document.getElementById('host');
const q = (sel) => host.querySelector(sel);
const audio = () => host.querySelector('audio');
const range = () => host.querySelector('.npr-audio-range');
const text = () => (q('.npr-audio-time') || {}).textContent || '';
const read = (tag) => log.push(tag + ' ' + JSON.stringify({
  text: text().replace(/\\s+/g, ' ').trim(),
  max: range() ? Number(range().max) : null,
  value: range() ? Number(range().value) : null,
  disabled: range() ? Boolean(range().disabled) : null,
  t: audio() ? Number(audio().currentTime.toFixed(2)) : null,
  dur: audio() && Number.isFinite(audio().duration) ? Number(audio().duration.toFixed(1)) : String(audio() && audio().duration),
  rate: audio() ? audio().playbackRate : null,
  src: audio() ? audio().src : null,
  err: (host.querySelector('.npr-audio-error') || {}).textContent || '',
}));

const scrubTo = async (seconds) => {
  const input = range();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  setter.call(input, String(seconds));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(120);
  input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
};

(async () => {
  const key = window.__probeKey;
  localStorage.setItem('npr.audio.' + key, JSON.stringify({ t: ${SAVED_AT}, rate: 1.25 }));
  window.__mount(host);
  await sleep(1800);
  read('MOUNT');

  q('.npr-audio-play').click();
  await sleep(2500);
  read('PLAY');

  const skip = host.querySelectorAll('.npr-audio-skip');
  skip[1].click();
  await sleep(900);
  read('NUDGE_PLUS');
  skip[0].click();
  await sleep(900);
  read('NUDGE_MINUS');

  await scrubTo(90);
  await sleep(1500);
  read('SCRUB');

  // 卸载重挂（模拟关掉这一集又打开）
  const paused = audio();
  if (paused && !paused.paused) paused.pause();
  await sleep(400);
  host.innerHTML = '';
  await sleep(300);
  window.__mount(host);
  await sleep(1800);
  read('REMOUNT');

  /*
   * 直连上游（0.85.8）：episode.audio 存在时**必须**拿它当 src，而不是绕中转。
   * 这一段的 404 对照在下面「坏地址」那一轮。
   */
  host.innerHTML = '';
  await sleep(300);
  window.__mountWith(host, window.__directUrl);
  await sleep(1800);
  read('DIRECT_MOUNT');
  q('.npr-audio-play').click();
  await sleep(1200);
  await scrubTo(60);
  await sleep(1500);
  read('DIRECT_SCRUB');

  /** 直连打不开 ⇒ 自动退回中转，并且**不许**把「音频源打不开」摆到界面上。 */
  host.innerHTML = '';
  await sleep(300);
  window.__mountWith(host, new URL('/media-missing.wav', location.href).href);
  await sleep(2600);
  read('FALLBACK');

  log.push('DONE');
  await fetch('/report', { method: 'POST', body: JSON.stringify(log) });
})();
</script></body></html>`;

/** 写入口：故意用项目里的真组件，不复制一份「看起来一样」的实现。 */
writeFileSync(join(DIR, 'entry.jsx'), `
import { createRoot } from 'react-dom/client';
import { MediaDock } from ${JSON.stringify(join(root, 'src/client/MediaDock.jsx'))};

const episode = {
  key: 'feed:probe-media-dock',
  titleZh: '门禁用的一集',
  url: 'https://example.com/ep',
};
window.__probeKey = episode.key;
window.__directUrl = new URL('/media-direct.wav', location.href).href;
window.__mount = (host) => {
  createRoot(host).render(<MediaDock episode={episode} onController={() => {}} />);
};
/** 带 audio 字段的挂载：用来验证「直连上游优先」与「打不开就退回中转」。 */
window.__mountWith = (host, audioUrl) => {
  createRoot(host).render(<MediaDock episode={{ ...episode, audio: audioUrl }} onController={() => {}} />);
};
`);

function serveAudio(req, res) {
  const total = WAV.length;
  const raw = String(req.headers.range ?? '');
  const match = /^bytes=(\\d*)-(\\d*)$/.exec(raw.trim());
  if (match === null) {
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(total),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    return res.end(WAV);
  }
  const start = match[1] === '' ? total - Number(match[2]) : Number(match[1]);
  const end = match[1] === '' || match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
  if (!(start >= 0 && start <= end && end < total)) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    return res.end();
  }
  res.writeHead(206, {
    'content-type': 'audio/wav',
    'content-length': String(end - start + 1),
    'content-range': `bytes ${start}-${end}/${total}`,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  res.end(WAV.subarray(start, end + 1));
}

/** 跑一个变体：起服务 → 起 Chrome → 等回传。 */
async function run(bundleName) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE(bundleName));
      }
      if (url.pathname === `/${bundleName}`) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(readFileSync(join(DIR, bundleName)));
      }
      if (url.pathname.startsWith('/api/dsh-npie-reader/library/audio')) return serveAudio(req, res);
      // 「直连上游」那一轮用的地址：同样是支持 Range 的 WAV，只是不在中转路径上。
      if (url.pathname === '/media-direct.wav') return serveAudio(req, res);
      if (url.pathname === '/report') {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        return req.on('end', () => {
          const log = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200); res.end('ok');
          clearTimeout(timer);
          child.kill('SIGKILL');
          server.close();
          resolve(log);
        });
      }
      res.writeHead(404); res.end();
    });
    let child;
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* 已经退了 */ }
      try { server.close(); } catch { /* 同上 */ }
      reject(new Error(`探针超时（${bundleName}）：页面没有回传报告`));
    }, 90_000);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      child = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
        `--user-data-dir=${join(DIR, `profile-${bundleName}`)}`,
        `http://127.0.0.1:${port}/`,
      ], { stdio: 'ignore' });
      child.on('error', (error) => reject(error));
    });
  });
}

/** 把日志行折成 `{ MOUNT: {...}, ... }`。 */
function parse(log) {
  const out = {};
  for (const line of log) {
    const at = line.indexOf(' ');
    if (at <= 0) continue;
    const tag = line.slice(0, at);
    if (tag === 'DONE') continue;
    out[tag] = JSON.parse(line.slice(at + 1));
  }
  return out;
}

/**
 * 判据。抽成纯函数：真机那一半（浏览器）挂了要报错，这一半要能单独对着数字讲理。
 *
 * @param fixed   正常构建的读数
 * @param broken  拆掉「时长进分母」的读数（必须复现 max=0）
 * @param orphan  拆掉「控制器进 ref」的读数（±15 与拖动必须仍然生效）
 */
export function failuresOf(fixed, broken, orphan) {
  const fails = [];
  const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

  if (!fixed.MOUNT) fails.push('修法：没拿到挂载读数');
  else {
    // ① 挂载即有总时长 —— 这是「能不能拖」的分母。
    if (!(fixed.MOUNT.max > 100)) fails.push(`修法：挂载时 max 是 ${fixed.MOUNT.max}，应约等于 ${MEDIA_SECONDS}（时长没读到 ⇒ 进度条不可拖）`);
    if (fixed.MOUNT.disabled === true) fails.push('修法：挂载时进度条被禁用（时长字段没提前拿到）');
    // ② 断点位置立刻显示，不用先点播放。
    if (!near(fixed.MOUNT.value, SAVED_AT, 2)) fails.push(`修法：挂载时显示位置是 ${fixed.MOUNT.value}，应约等于 ${SAVED_AT}（上次听到哪儿没读出来）`);
    if (!fixed.MOUNT.text.includes('/')) fails.push(`修法：时间文本是 "${fixed.MOUNT.text}"，缺少「/ 总时长」`);
    if (!fixed.MOUNT.text.includes('--') && /00:00\s*\/\s*00:00/.test(fixed.MOUNT.text)) {
      fails.push(`修法：时间文本是 "${fixed.MOUNT.text}"，分母仍是 00:00`);
    }
    // ③ 倍速也要在挂载时应用（只改下拉框的值 = 界面骗人）。
    if (fixed.MOUNT.rate !== 1.25) fails.push(`修法：挂载时 playbackRate 是 ${fixed.MOUNT.rate}，应为 1.25（存下来的倍速没应用到元素）`);
  }

  // ④ ±15s 在聆听状态下必须真的改位置。
  if (!fixed.PLAY || !fixed.NUDGE_PLUS || !fixed.NUDGE_MINUS) fails.push('修法：没拿到播放 / 快进 / 快退读数');
  else {
    const played = Number(fixed.PLAY.t);
    if (!near(fixed.NUDGE_PLUS.t, played + 15, 3)) {
      fails.push(`修法：+15s 之后位置是 ${fixed.NUDGE_PLUS.t}，应约等于 ${(played + 15).toFixed(1)}`);
    }
    if (!near(fixed.NUDGE_MINUS.t, played, 3)) {
      fails.push(`修法：-15s 之后位置是 ${fixed.NUDGE_MINUS.t}，应约等于 ${played.toFixed(1)}`);
    }
    if (fixed.NUDGE_PLUS.text === fixed.PLAY.text) fails.push('修法：+15s 之后时间文本没变（界面没跟上）');
  }

  // ⑤ 拖动进度条必须真的跳。
  if (!fixed.SCRUB) fails.push('修法：没拿到拖动读数');
  else if (!near(fixed.SCRUB.t, 90, 4)) {
    fails.push(`修法：拖到 90s 之后 currentTime 是 ${fixed.SCRUB.t}（拖动没有真正跳转）`);
  }

  // ⑥ 重挂之后位置还在，而且不用点播放就能拖。
  if (!fixed.REMOUNT) fails.push('修法：没拿到重挂读数');
  else {
    if (!near(fixed.REMOUNT.value, 90, 6)) {
      fails.push(`修法：重挂后显示位置是 ${fixed.REMOUNT.value}，应约等于 90（断点没续上）`);
    }
    if (!near(fixed.REMOUNT.t, 90, 6)) {
      fails.push(`修法：重挂后元素位置是 ${fixed.REMOUNT.t}，应约等于 90`);
    }
    if (!(fixed.REMOUNT.max > 100)) fails.push(`修法：重挂后 max 是 ${fixed.REMOUNT.max}，应约等于 ${MEDIA_SECONDS}`);
  }

  // ⑥b 直连上游优先（0.85.8）：`episode.audio` 存在时 src 就得是它。
  //     这条守的是「拖不动」的真正出口 —— 中转那条路上，转发层会扣 content-length，
  //     Chromium 永远算不出 seekable 区间，代码怎么写都拖不动。
  if (!fixed.DIRECT_MOUNT || !fixed.DIRECT_SCRUB) {
    fails.push('直连：没拿到「带 audio 的挂载 / 拖动」读数');
  } else {
    if (!String(fixed.DIRECT_MOUNT.src || '').includes('/media-direct.wav')) {
      fails.push(`直连：src 指向了 ${fixed.DIRECT_MOUNT.src}，应指向 episode.audio（/media-direct.wav）—— 又绕回中转了`);
    }
    if (!(fixed.DIRECT_MOUNT.max > 100)) {
      fails.push(`直连：挂载时 max 是 ${fixed.DIRECT_MOUNT.max}，应约等于 ${MEDIA_SECONDS}`);
    }
    if (!near(fixed.DIRECT_SCRUB.t, 60, 4)) {
      fails.push(`直连：拖到 60s 之后 currentTime 是 ${fixed.DIRECT_SCRUB.t}（直连也拖不动）`);
    }
    if (fixed.DIRECT_SCRUB.err !== '') {
      fails.push(`直连：界面报了错「${fixed.DIRECT_SCRUB.err}」`);
    }
  }
  // ⑥c 直连打不开时必须**自动退回中转**：src 换回中转路径，且不显示错误。
  if (!fixed.FALLBACK) fails.push('兜底：没拿到「坏地址」读数');
  else {
    if (!String(fixed.FALLBACK.src || '').includes('/library/audio')) {
      fails.push(`兜底：坏地址之后的 src 是 ${fixed.FALLBACK.src}，应退回中转（/library/audio）`);
    }
    if (fixed.FALLBACK.err !== '') {
      fails.push(`兜底：直连失败后把错误摆到了界面上（「${fixed.FALLBACK.err}」），应静默退回中转`);
    }
    if (!(fixed.FALLBACK.max > 100)) {
      fails.push(`兜底：退回中转后 max 是 ${fixed.FALLBACK.max}，应约等于 ${MEDIA_SECONDS}`);
    }
  }

  // ⑦ 反向对照：把「时长写进分母」这一步拆掉，必须**复现**原缺陷（max=0）。
  if (!broken.MOUNT) fails.push('对照：没拿到反向读数');
  else if (broken.MOUNT.max !== 0) {
    fails.push(`对照：拆掉 setTotal 之后 max 仍是 ${broken.MOUNT.max} —— 说明这套装置量不到「时长没进分母」这个根因，判据是假的`);
  }

  // ⑧ 边界对照：控制器没装上时，±15 与拖动**仍然**必须生效。
  //    旧版是 `controllerRef.current?.nudge(±15)`：控制器缺席 ⇒ 静默无操作，而播放键
  //    走 `element.paused` 照样能播 —— 正是「能听，但按 ±15 没反应」的形态。
  if (!orphan || !orphan.PLAY || !orphan.NUDGE_PLUS) {
    fails.push('边界：没拿到「控制器缺席」的读数');
  } else {
    const played = Number(orphan.PLAY.t);
    if (!near(orphan.NUDGE_PLUS.t, played + 15, 3)) {
      fails.push(`边界：控制器缺席时 +15s 之后位置是 ${orphan.NUDGE_PLUS.t}，应约等于 ${(played + 15).toFixed(1)}（退回了「静默无操作」）`);
    }
    if (!orphan.SCRUB || !near(orphan.SCRUB.t, 90, 4)) {
      fails.push(`边界：控制器缺席时拖到 90s 之后 currentTime 是 ${orphan.SCRUB?.t}（拖动只能靠控制器，退化了）`);
    }
  }
  return fails;
}

const fixedBundle = await bundle('fixed', null);
const brokenBundle = await bundle('broken', 'total');
const orphanBundle = await bundle('orphan', 'controller');

const fixed = parse(await run(fixedBundle));
const broken = parse(await run(brokenBundle));
const orphan = parse(await run(orphanBundle));
const fails = failuresOf(fixed, broken, orphan);

console.log('修法：', JSON.stringify(fixed));
console.log('对照：', JSON.stringify(broken));
console.log('边界：', JSON.stringify(orphan));
if (fails.length === 0) {
  console.log(`播放条真机：OK（挂载即可拖 · 断点 ${SAVED_AT}s 立刻显示 · ±15s 生效 · 拖到 90s 生效 · 重挂后仍在；对照：拆掉 setTotal 后 max=0；边界：控制器缺席时 ±15 与拖动仍生效）`);
  process.exit(0);
}
for (const line of fails) console.log(`  - ${line}`);
console.log('播放条真机：FAIL');
process.exit(1);
