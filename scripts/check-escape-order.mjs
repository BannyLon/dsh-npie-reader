/**
 * Esc 的**事件顺序**守卫：真 Chrome + 真 React 组件 + 真 KeyboardEvent。
 *
 * ★ 为什么不能用 renderToStaticMarkup 或读源码
 * ---------------------------------------------
 * Esc 在这个项目里有**三层**，全挂在不同位置、不同阶段：
 *
 *   1. `GroupField` 的下拉菜单  → `document`，**捕获**阶段
 *   2. `Modal` / `ChannelPicker` / `OpmlImport` → `document`，冒泡阶段
 *   3. 设置页 / 阅读页           → `window`，冒泡阶段
 *
 * 三层都挂冒泡的话，**先注册的先跑** —— 而菜单是「展开时才注册」的，永远排最后，
 * 于是按 Esc 会先把整个对话框关掉，用户想关的只是那个下拉。
 * 这类问题在 JSX 里长得完全一样（都是一句 `addEventListener('keydown', …)`），
 * 只有真的派发一个事件、看谁先跑，才知道对不对。
 *
 * 另外两条只有真跑才答得上的：
 *   - React 合成事件的 `stopPropagation` 能不能拦住**原生** `window` 监听？
 *   - `document` 上的冒泡监听是不是真的先于 `window`？
 *
 * ★ 反向对照（自证守卫有牙）
 * --------------------------
 * 同一套夹具，把两处关键写法**改坏**再跑：
 *   - `Modal` 的 `document` 改成 `window`  ⇒ 必须出现「Esc 穿到外层」；
 *   - `GroupField` 的捕获改成冒泡       ⇒ 必须出现「关菜单连对话框一起关」。
 * 改坏之后还是全绿，说明守卫量的是别的东西。
 *
 * 运行：node scripts/check-escape-order.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 Chrome 不可用（**不静默跳过**）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dialogsPath = join(pluginRoot, 'src/client/dialogs.jsx');
const pickerPath = join(pluginRoot, 'src/client/ChannelPicker.jsx');
const opmlPath = join(pluginRoot, 'src/client/OpmlImport.jsx');

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

// ---- 1. 打一份浏览器可执行的组件产物（内存里，不落盘到 lib/） ----------------

const ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AddFeedDialog, GroupField } from ${JSON.stringify(dialogsPath)};
import { ChannelPicker } from ${JSON.stringify(pickerPath)};
import { OpmlImport } from ${JSON.stringify(opmlPath)};
window.__npr = { React, createRoot, flushSync, AddFeedDialog, GroupField, ChannelPicker, OpmlImport };
`;

/**
 * @param {{ mutateModal?: boolean, mutateGroupField?: boolean }} mutations
 *   反向对照用：把关键写法改坏，看断言会不会变红。
 */
async function bundle(mutations = {}) {
  const mutate = {
    name: 'npr-mutate',
    setup(build) {
      build.onLoad({ filter: /dialogs\.jsx$/ }, () => {
        let src = readFileSync(dialogsPath, 'utf8');
        if (mutations.mutateModal) {
          const before = src;
          src = src.replace(
            "document.addEventListener('keydown', escape);",
            "window.addEventListener('keydown', escape);",
          );
          if (src === before) throw new Error('变异锚点没命中：Modal 的 document 监听');
        }
        if (mutations.mutateGroupField) {
          const before = src;
          src = src.replace(
            "document.addEventListener('keydown', escape, true);",
            "document.addEventListener('keydown', escape);",
          );
          if (src === before) throw new Error('变异锚点没命中：GroupField 的捕获阶段');
        }
        return { contents: src, loader: 'jsx' };
      });
    },
  };
  const result = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: pluginRoot, loader: 'js', sourcefile: 'escape-order-entry.mjs' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'warning',
    plugins: [mutate],
  });
  return result.outputFiles[0].text;
}

// ---- 2. 探针：真渲染、真派发、逐场景记结果 ---------------------------------

const PROBE = `
(async () => {
  const { React, createRoot, flushSync, AddFeedDialog, ChannelPicker, OpmlImport } = window.__npr;
  const h = React.createElement;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const out = { scenarios: {} };

  // 外层监听：模拟「设置页 / 阅读页在 window 上挂 Esc」。
  // ★ 必须**先**注册（组件是后挂载的）—— 这 reproduces 真实顺序：
  //   页面先挂 window 监听，对话框打开后才挂自己的。
  let windowCalls = 0;
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') windowCalls += 1; });

  const mount = async (element) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    flushSync(() => root.render(element));
    await tick(); await tick();
    return { unmount: () => { flushSync(() => root.unmount()); host.remove(); } };
  };
  const esc = (target) => {
    (target || document.body).dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
  };

  // 场景 1：对话框 + 外层 window 监听（最基础的一条）
  // ★ onClose 要**真的卸载**，不能只加个计数：否则「关掉了」这句话没有证据 ——
  //   回调跑了但对话框还挂在 DOM 上，正是「看起来关了其实没关」的那种假绿。
  // ★ 本段在模板串里，注释中**不许出现反引号**（会提前闭合模板串，而产物仍然
  //   语法合法 —— 0.6.0 就是这么整块崩掉的）。
  let close1 = 0;
  let m1;
  m1 = await mount(h(AddFeedDialog, {
    api: {}, groups: [],
    onClose: () => { close1 += 1; m1.unmount(); },
    onDone: async () => {},
  }));
  windowCalls = 0;
  esc(document.querySelector('.npr-modal textarea'));
  await tick();
  out.scenarios.modal = {
    closeCalls: close1,
    windowCalls,
    modalGone: document.querySelector('.npr-modal') === null,
  };
  m1.unmount();
  await tick();

  // 场景 2：下拉菜单展开时按 Esc —— 三层顺序的核心
  let close2 = 0;
  const m2 = await mount(h(AddFeedDialog, {
    api: {}, groups: ['技术', '随笔'], onClose: () => { close2 += 1; }, onDone: async () => {},
  }));
  const arrow = document.querySelector('.npr-groupfield button');
  arrow.click();
  await tick();
  const menuBefore = document.querySelector('.npr-groupfield-menu') !== null;
  windowCalls = 0;
  esc(document.querySelector('.npr-groupfield input'));
  await tick();
  out.scenarios.groupMenu = {
    menuBefore,
    menuAfter: document.querySelector('.npr-groupfield-menu') !== null,
    modalAfter: document.querySelector('.npr-modal') !== null,
    closeCalls: close2,
    windowCalls,
  };
  m2.unmount();
  await tick();

  // 场景 3：频道选择浮层 + 外层 window 监听（模拟阅读页）
  let close3 = 0;
  const m3 = await mount(h(ChannelPicker, {
    channels: [{ key: 'all', name: '全部', unread: 3, kind: 'all' }],
    current: 'all', anchor: null, onSelect: () => {}, onManage: () => {}, onClose: () => { close3 += 1; },
  }));
  windowCalls = 0;
  esc(document.querySelector('.npr-channel-picker input'));
  await tick();
  out.scenarios.picker = { closeCalls: close3, windowCalls };
  m3.unmount();
  await tick();

  // 场景 4/5：内联表单 —— 焦点在内要吃掉 Esc，焦点在外不许吃
  let cancel4 = 0;
  const m4 = await mount(h(OpmlImport, {
    api: {}, onDone: async () => {}, onCancel: () => { cancel4 += 1; },
  }));
  const inner = document.querySelector('.npr-opml-import input');
  inner.focus();
  windowCalls = 0;
  esc(inner);
  await tick();
  out.scenarios.opmlInside = { cancelCalls: cancel4, windowCalls };

  cancel4 = 0;
  windowCalls = 0;
  esc(document.body);
  await tick();
  out.scenarios.opmlOutside = { cancelCalls: cancel4, windowCalls };
  m4.unmount();

  const pre = document.createElement('pre');
  pre.id = 'probe-out';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})().catch((error) => {
  const pre = document.createElement('pre');
  pre.id = 'probe-out';
  pre.textContent = JSON.stringify({ error: String(error && error.stack || error) });
  document.body.appendChild(pre);
});
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>escape order</title></head>
<body><script src="./bundle.js"></script><script>${PROBE}<\/script></body></html>`;

function run(bundleCode) {
  const dir = mkdtempSync(join(tmpdir(), 'npr-esc-'));
  writeFileSync(join(dir, 'bundle.js'), bundleCode, 'utf8');
  writeFileSync(join(dir, 'probe.html'), HTML, 'utf8');
  const res = spawnSync(CHROME, [
    '--no-sandbox', '--disable-gpu', '--headless', '--virtual-time-budget=5000',
    '--dump-dom', `file://${join(dir, 'probe.html')}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`chrome 启动失败：${res.error.message}`);
  const m = /<pre id="probe-out">([\s\S]*?)<\/pre>/.exec(res.stdout);
  if (!m) throw new Error(`没拿到探针结果（脚本抛了？）\n${res.stdout.slice(-2000)}`);
  const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  const parsed = JSON.parse(decoded);
  if (parsed.error) throw new Error(`探针里抛了：\n${parsed.error}`);
  return parsed.scenarios;
}

// ---- 3. 断言 ---------------------------------------------------------------

const failures = [];
const ok = (cond, message) => { if (cond) console.log(`  OK   ${message}`); else { failures.push(message); console.log(` FAIL  ${message}`); } };

console.log('夹具：真 Chrome + 真 React 组件 + 真 KeyboardEvent\n');

const s = run(await bundle());

console.log('场景 1 — 对话框 + 外层 window 监听');
console.log(`  ${JSON.stringify(s.modal)}`);
ok(s.modal.closeCalls === 1, '按一次 Esc，对话框的 onClose 被调用一次');
ok(s.modal.modalGone === true, '对话框真的从 DOM 上消失了（不是只调了回调）');
ok(s.modal.windowCalls === 0, '★ Esc 没有穿到外层 window —— 否则设置页会跟着一起关');

console.log('\n场景 2 — 下拉菜单展开时按 Esc（三层顺序）');
console.log(`  ${JSON.stringify(s.groupMenu)}`);
ok(s.groupMenu.menuBefore === true, '夹具里菜单确实展开了（否则下一条是空跑）');
ok(s.groupMenu.menuAfter === false, '菜单被 Esc 关掉');
ok(s.groupMenu.modalAfter === true, '★ 对话框**还开着** —— 捕获阶段先于冒泡，菜单没连坐');
ok(s.groupMenu.closeCalls === 0, '对话框的 onClose 一次都没被调用');
ok(s.groupMenu.windowCalls === 0, '外层 window 也没收到');

console.log('\n场景 3 — 频道选择浮层 + 外层 window 监听');
console.log(`  ${JSON.stringify(s.picker)}`);
ok(s.picker.closeCalls === 1, '浮层被 Esc 关掉');
ok(s.picker.windowCalls === 0, '★ Esc 没有穿到外层 window —— 否则底下搜索框会被清空');

console.log('\n场景 4 — 内联表单，焦点在表单内');
console.log(`  ${JSON.stringify(s.opmlInside)}`);
ok(s.opmlInside.cancelCalls === 1, 'onCancel 被调用一次（收起表单）');
ok(s.opmlInside.windowCalls === 0, '★ Esc 没有穿到外层 window —— 否则已勾选的 OPML 条目会随设置页一起丢');

console.log('\n场景 5 — 内联表单，焦点在表单外');
console.log(`  ${JSON.stringify(s.opmlOutside)}`);
ok(s.opmlOutside.cancelCalls === 0, '焦点不在表单里时，不抢这个 Esc');
ok(s.opmlOutside.windowCalls === 1, '对照：这个 Esc 照常到达外层 window（证明上一条不是「什么都不响应」）');

// ---- 4. 反向对照：把关键写法改坏，断言必须变红 ------------------------------

console.log('\n反向对照 A — 把 Modal 的 document 监听改成 window');
const mutatedModal = run(await bundle({ mutateModal: true }));
console.log(`  ${JSON.stringify(mutatedModal.modal)}`);
ok(mutatedModal.modal.windowCalls >= 1,
  '★ 改坏后 Esc 穿到了外层（windowCalls>=1）—— 证明「挂 document 而不是 window」是这条判据的真正原因');

console.log('\n反向对照 B — 把 GroupField 的捕获阶段改回冒泡');
const mutatedMenu = run(await bundle({ mutateGroupField: true }));
console.log(`  ${JSON.stringify(mutatedMenu.groupMenu)}`);
ok(mutatedMenu.groupMenu.modalAfter === false || mutatedMenu.groupMenu.closeCalls >= 1,
  '★ 改坏后关菜单会把对话框一起关掉 —— 证明「捕获阶段」是这条判据的真正原因');

// ---- 5. 结论 ---------------------------------------------------------------

console.log('');
if (failures.length > 0) {
  console.error(`dsh-npie-reader Esc 顺序：${failures.length} 项未通过`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('dsh-npie-reader Esc 顺序：全部通过（真 Chrome 派发事件 + 两条反向对照）');
