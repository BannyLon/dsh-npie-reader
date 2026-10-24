/**
 * 划线删除的**二次确认**守卫：真 Chrome + 真 React 组件 + 真点击。
 *
 * ★ 它回答的问题
 * ---------------
 * 划线只存在本地 `data.json` 里，没有回收站、没有历史版本 —— 删掉就是没了。
 * 这个守卫要钉住的是：**第一次点击不许删**。三件事都只有真跑才答得上来：
 *
 *   1. 第一次点删除，`onRemove` 到底有没有被调用（源码里看起来是「先设状态」，
 *      但状态设错、或者条件写反，照样渲染成「看起来有确认」）；
 *   2. 点 A 的删除，B 是不是也一起变成确认态（一个 id 管全表 vs 每行各管自己）；
 *   3. 确认态会不会**自己过期** —— 不过期的话，用户点错了就永远停在那儿。
 *
 * ★ 反向对照
 * ----------
 * 把 onClick 改回「直接 onRemove」，第一条断言必须变红。改坏还绿，说明这条
 * 守卫量的是别的东西。
 *
 * 运行：node scripts/check-mark-delete.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 Chrome 不可用（**不静默跳过**）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const panelPath = join(pluginRoot, 'src/client/AnnotationPanel.jsx');

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

const ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AnnotationPanel } from ${JSON.stringify(panelPath)};
window.__npr = { React, createRoot, flushSync, AnnotationPanel };
`;

/** @param {{ mutateNoConfirm?: boolean }} mutations 反向对照用。 */
async function bundle(mutations = {}) {
  const mutate = {
    name: 'npr-mutate-mark',
    setup(build) {
      build.onLoad({ filter: /AnnotationPanel\.jsx$/ }, () => {
        let src = readFileSync(panelPath, 'utf8');
        if (mutations.mutateNoConfirm) {
          const before = src;
          // 把「第一次点击只设确认态」改回「第一次点击直接删」。
          src = src.replace(
            "onClick={() => setConfirmingId(item.id)}>",
            "onClick={() => onRemove(item.id)}>",
          );
          if (src === before) throw new Error('变异锚点没命中：删除按钮的 onClick');
        }
        return { contents: src, loader: 'jsx' };
      });
    },
  };
  const result = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: pluginRoot, loader: 'js', sourcefile: 'mark-delete-entry.mjs' },
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

const PROBE = `
(async () => {
  const { React, createRoot, flushSync, AnnotationPanel } = window.__npr;
  const h = React.createElement;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const out = {};
  const removed = [];

  const items = [
    { id: 'a1', page: 3, quote: '第一句划线', tone: 'yellow', note: '' },
    { id: 'a2', page: 7, quote: '第二句划线', tone: 'blue', note: '写点什么' },
  ];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(h(AnnotationPanel, {
    items, focusId: '', onJump: () => {}, onUpdate: () => {},
    onRemove: (id) => { removed.push(id); }, onClose: () => {},
  })));
  await tick(); await tick();

  const cards = () => document.querySelectorAll('.npr-mark-card');
  const delBtn = (index) => cards()[index].querySelector('.npr-mark-action[title^="删除"], .npr-mark-action.is-confirming');
  const confirmBtns = () => document.querySelectorAll('.npr-mark-action.is-confirming');

  // 1) 初始态：两张卡各一个垃圾桶，没有一个是确认态
  out.initial = {
    cards: cards().length,
    confirmButtons: confirmBtns().length,
    trashIcons: document.querySelectorAll('.npr-mark-action[title="删除这条划线"]').length,
  };

  // 2) 点第一张的删除：只应进入确认态，不许真删
  delBtn(0).click();
  await tick();
  out.afterFirstClick = {
    confirmButtons: confirmBtns().length,
    confirmText: confirmBtns()[0]?.textContent?.trim() ?? '',
    removedCount: removed.length,
    // 第二张必须还是垃圾桶（一个 id 管全表的话这里会变成 2）
    otherStillTrash: document.querySelectorAll('.npr-mark-action[title="删除这条划线"]').length,
  };

  // 3) 再点一次：这时候才该真的删
  // ★ 存**快照**（[...removed]）而不是引用：下面第 4 步会 removed.length = 0 清空它，
  //   存引用的话序列化出来是末态，这一条断言就永远读到空数组（看起来像「没删」）。
  if (confirmBtns().length > 0) confirmBtns()[0].click();
  await tick();
  out.afterSecondClick = { removed: [...removed], stillConfirm: confirmBtns().length };

  // 4) 确认态自己过期：点开一张，等 4.5 秒，应该自己复位
  removed.length = 0;
  delBtn(1).click();
  await tick();
  const confirmRightAfter = confirmBtns().length;
  await new Promise((r) => setTimeout(r, 4500));
  out.expiry = { confirmRightAfter, confirmAfterWait: confirmBtns().length, removedCount: removed.length };

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

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>mark delete</title></head>
<body><script src="./bundle.js"></script><script>${PROBE}<\/script></body></html>`;

function run(bundleCode) {
  const dir = mkdtempSync(join(tmpdir(), 'npr-mark-'));
  writeFileSync(join(dir, 'bundle.js'), bundleCode, 'utf8');
  writeFileSync(join(dir, 'probe.html'), HTML, 'utf8');
  const res = spawnSync(CHROME, [
    '--no-sandbox', '--disable-gpu', '--headless', '--virtual-time-budget=9000',
    '--dump-dom', `file://${join(dir, 'probe.html')}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`chrome 启动失败：${res.error.message}`);
  const m = /<pre id="probe-out">([\s\S]*?)<\/pre>/.exec(res.stdout);
  if (!m) throw new Error(`没拿到探针结果（脚本抛了？）\n${res.stdout.slice(-2000)}`);
  const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  const parsed = JSON.parse(decoded);
  if (parsed.error) throw new Error(`探针里抛了：\n${parsed.error}`);
  return parsed;
}

const failures = [];
const ok = (cond, message) => { if (cond) console.log(`  OK   ${message}`); else { failures.push(message); console.log(` FAIL  ${message}`); } };

console.log('夹具：真 Chrome + 真 AnnotationPanel + 真 click\n');
const s = run(await bundle());

console.log('初始态');
console.log(`  ${JSON.stringify(s.initial)}`);
ok(s.initial.cards === 2, '两张划线卡片都渲染出来了');
ok(s.initial.trashIcons === 2, '两张卡各有一个垃圾桶按钮');
ok(s.initial.confirmButtons === 0, '一进来没有任何「确认删除」');

console.log('\n第一次点击');
console.log(`  ${JSON.stringify(s.afterFirstClick)}`);
ok(s.afterFirstClick.removedCount === 0, '★ 第一次点击**没有**调用 onRemove —— 这就是二次确认的全部意义');
ok(s.afterFirstClick.confirmButtons === 1, '第一张卡进入了确认态');
ok(s.afterFirstClick.confirmText === '确认删除', `确认态显示的是「确认删除」（实测：「${s.afterFirstClick.confirmText}」）`);
ok(s.afterFirstClick.otherStillTrash === 1, '★ 第二张卡仍是垃圾桶 —— 确认态只属于被点的那一行');

console.log('\n第二次点击');
console.log(`  ${JSON.stringify(s.afterSecondClick)}`);
ok(s.afterSecondClick.removed.length === 1, '第二次点击才真的删，且只删一条');
ok(s.afterSecondClick.removed[0] === 'a1', '删的是被点的那一条（id 对得上）');

console.log('\n确认态自动过期');
console.log(`  ${JSON.stringify(s.expiry)}`);
ok(s.expiry.confirmRightAfter === 1, '点开之后确实进了确认态（否则下一条是空跑）');
ok(s.expiry.confirmAfterWait === 0, '4.5 秒后自己复位了 —— 不会永远停在「确认删除」上');
ok(s.expiry.removedCount === 0, '过期期间什么都没被删');

console.log('\n反向对照 — 把「第一次点击只设确认」改回「直接删」');
const mutated = run(await bundle({ mutateNoConfirm: true }));
console.log(`  ${JSON.stringify(mutated.afterFirstClick)}`);
ok(mutated.afterFirstClick.removedCount >= 1,
  '★ 改坏后第一次点击就删掉了 —— 证明上面那条「removedCount===0」真的来自二次确认');

console.log('');
if (failures.length > 0) {
  console.error(`dsh-npie-reader 划线删除确认：${failures.length} 项未通过`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('dsh-npie-reader 划线删除确认：全部通过（真 Chrome 点击 + 反向对照）');
