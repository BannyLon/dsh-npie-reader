#!/usr/bin/env node
/**
 * 「控制器所有权」真机守卫：父组件**不许**在 effect 里清掉子组件刚发布的控制器。
 *
 * ---- 这条守卫守的是 2026-11-17 的一个真 bug --------------------------------
 *
 * 症状：字幕面板不跟着音频高亮，点段落也不跳；但播放条本身完全正常（能播、能拖、
 * 倍速好使）。看起来像「字幕没订阅到时间」，实际是**控制器被清成了 null**。
 *
 * 根因不是逻辑写错，是**执行顺序**：React 在 commit 阶段先跑子组件的 effect，
 * 再跑父组件的 effect。阅读页那一版把「换集时清空控制器」写在父组件的
 * `useEffect(..., [loadTranscript])` 里，而播放条在自己的 effect 里 `onController(controller)`。
 * 于是每次都是：
 *
 *   ① MediaDock 发布 controller
 *   ② TranscriptPanel 订阅（此时还是上一帧的 null，什么也没订上）
 *   ③ ReaderPage 把它 set 成 null        ← 亲手抹掉
 *
 * ③ 之后 MediaDock 的 effect **不会重跑**（依赖只有 key），所以 controller 永久是
 * null —— 直到用户切集。这一类 bug 静态读代码很难发现：每一行单独看都对。
 *
 * ---- 为什么用真 React 在真 Chrome 里跑 --------------------------------------
 *
 * 这个 bug 的全部内容就是「React 的执行顺序」，用假的顺序模型去测等于把结论
 * 抄一遍当判据（自证）。这里直接挂载两个真实组件树：一份是**坏写法**（父 effect
 * 里清空），一份是**修法**（清理交给发布者的 cleanup）。判据是：
 *
 *   · 坏写法**必须**复现出 controller === '' 且高亮 -1  ← 证明这套装置量得到
 *   · 修法**必须**保住 controller 且高亮等于注入的 5 秒 ← 证明修法真成立
 *
 * 两条缺一不可。只有第一条，说明修法没被验证；只有第二条，说明装置可能量不到 bug
 * （比如 React 改了顺序，案例就成了恒真式）。
 *
 * 用法：
 *   node scripts/check-audio-binding.mjs            # 跑判据
 *   node scripts/check-audio-binding.mjs --shot f.html   # 导出夹具给人看
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const react = readFileSync(join(root, 'node_modules/react/umd/react.production.min.js'), 'utf8');
const reactDom = readFileSync(join(root, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');

/**
 * 夹具里的组件树。
 *
 * `resetInParent` 是唯一变量：
 *   · true  → 坏写法（父组件 effect 里 `setController(null)`）
 *   · false → 修法（父组件不碰；清理由 Dock 的 cleanup 发布 null）
 *
 * 注入的假控制器 `subscribe` 会**当场**回调 5 秒 —— 与 `audio-controller.js`
 * 「订阅立刻给一次当前值」的契约一致。所以 `data-active` 变成 '5' 就意味着
 * 「面板真的订上了」。
 */
const APP = `
const { useState, useEffect, useRef } = React;

function Dock({ id, onController }) {
  useEffect(() => {
    const controller = {
      id,
      subscribe(listener) { listener(5); return () => {}; },
    };
    onController(controller);
    // 修法的全部内容：清理由**发布者**做，而且它的 cleanup 一定排在新子组件的
    // effect 之前 —— 不会被谁覆盖。
    return () => onController(null);
  }, [id]);
  return null;
}

function Panel({ controller }) {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (!controller) { setActive(-1); return undefined; }
    return controller.subscribe((time) => setActive(time));
  }, [controller]);
  return React.createElement('span', { className: 'active' }, String(active));
}

function App({ resetInParent }) {
  const [key, setKey] = useState('a');
  const [controller, setController] = useState(null);
  useEffect(() => {
    if (resetInParent) setController(null);
    // 故意不放 setKey 的依赖之外的东西：还原真实阅读页「换集」那一次提交。
  }, [key, resetInParent]);
  useEffect(() => { window.__setKey = setKey; }, []);
  return React.createElement('div', {
    'data-controller': controller ? controller.id : '',
  }, React.createElement(Dock, { id: key, onController: setController }),
     React.createElement(Panel, { controller }));
}

const results = {};
for (const [name, resetInParent] of [['buggy', true], ['fixed', false]]) {
  const host = document.createElement('div');
  host.id = 'root-' + name;
  document.body.appendChild(host);
  const rootApi = ReactDOM.createRoot(host);
  rootApi.render(React.createElement(App, { resetInParent }));
}

const read = (name) => {
  const host = document.getElementById('root-' + name);
  return {
    controller: host.firstElementChild ? host.firstElementChild.getAttribute('data-controller') : '',
    active: host.querySelector('.active') ? host.querySelector('.active').textContent : '',
  };
};

const steps = [];
const step = (fn) => steps.push(fn);

step(() => { for (const n of ['buggy', 'fixed']) results[n + 'Mount'] = read(n); });
step(() => { window.__setKey('b'); });
step(() => { for (const n of ['buggy', 'fixed']) results[n + 'Switch'] = read(n); });
step(() => { document.title = 'D:' + JSON.stringify(results); });

let index = 0;
const tick = () => {
  if (index >= steps.length) return;
  const fn = steps[index];
  index += 1;
  setTimeout(() => { fn(); tick(); }, 60);
};
setTimeout(tick, 80);
`;

const dir = mkdtempSync(join(tmpdir(), 'npr-audio-binding-'));

function fixture() {
  const file = join(dir, `binding-${process.pid}.html`);
  writeFileSync(file, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>binding</title></head>
<body><script>${react}</script><script>${reactDom}</script><script>${APP}</script></body></html>`);
  return file;
}

function run(file) {
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=4000',
    '--dump-dom', file,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  const match = dom.match(/<title>D:([\s\S]*?)<\/title>/);
  if (!match) throw new Error('探针没有回传（document.title 里没有 D: 前缀）');
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

/** 判据。抽成函数，修法失效时这里必须吐失败项。 */
export function failuresOf(data) {
  const fails = [];

  // ── ① 坏写法必须复现 bug：控制器被清成空、高亮 -1 ────────────────────────
  const buggy = data.buggyMount;
  if (!buggy) fails.push('没拿到坏写法的读数');
  else {
    if (buggy.controller !== '') {
      fails.push(`坏写法竟然保住了控制器（"${buggy.controller}"）—— 说明这套装置量不到「父组件清空」这类 bug，判据是假的`);
    }
    if (buggy.active !== '-1') {
      fails.push(`坏写法的高亮是 ${buggy.active}，应停在 -1（控制器为 null 时不该有高亮）`);
    }
  }

  // ── ② 修法必须真的订上：控制器在、高亮 = 注入的 5 秒 ─────────────────────
  const fixed = data.fixedMount;
  if (!fixed) fails.push('没拿到修法的读数');
  else {
    if (fixed.controller !== 'a') fails.push(`修法首帧控制器是 "${fixed.controller}"，应为 "a"`);
    if (fixed.active !== '5') {
      fails.push(`修法首帧高亮是 ${fixed.active}，应为 5 —— 面板没订上控制器`);
    }
  }

  // ── ③ 切集之后仍然成立（清理不能把新控制器也带走）──────────────────────
  const switched = data.fixedSwitch;
  if (!switched) fails.push('没拿到切集后的读数');
  else {
    if (switched.controller !== 'b') fails.push(`切集后控制器是 "${switched.controller}"，应为 "b"`);
    if (switched.active !== '5') fails.push(`切集后高亮是 ${switched.active}，应为 5`);
  }
  return fails;
}

const shotIndex = process.argv.indexOf('--shot');
if (shotIndex !== -1) {
  const target = process.argv[shotIndex + 1];
  if (!target) throw new Error('--shot 需要一个输出路径');
  const file = fixture();
  writeFileSync(target, readFileSync(file, 'utf8'));
  console.log(`已导出夹具：${target}`);
} else {
  const data = run(fixture());
  const fails = failuresOf(data);
  console.log('实测：', JSON.stringify(data));
  if (fails.length === 0) {
    console.log('控制器所有权：OK（坏写法复现了 null，修法保住了控制器并在切集后仍有效）');
    process.exit(0);
  }
  for (const line of fails) console.log(`  - ${line}`);
  console.log('控制器所有权：FAIL');
  process.exit(1);
}
