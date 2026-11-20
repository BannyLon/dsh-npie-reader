/**
 * 「删掉这一天」确认框的 SSR 冒烟（0.75.0）。
 *
 * ★ 为什么单独一条：这个框只在 `wipe.open` 为真时渲染，而它挂在 `DiaryApp.jsx`
 *   这个 3800 行的组件里 —— 任何**结构判据**都只能看源码，看不见「组件体里某个
 *   `const` 在声明之前被读」这类错误（`const` 有暂时性死区，表现是整个对话框白屏）。
 *   本仓库 0.47.0 就这样发出去过一次：131 条源码判据全绿，用户只看到「打不开」。
 *   ⇒ 抽成受 props 驱动的组件（`WipeDayDialog.jsx`），在这里**真的渲染一次**。
 *
 * ★ 它证明的是「能画出来 + 画出来的东西对」：条数、每条摘要、读后感提醒、
 *   私密措辞、飞行中两个按钮都禁用。它**不**证明点击之后会发生什么 ——
 *   那条路由由 `diary-day-wipe.test.mjs` 用真文件系统与真 http 分派覆盖。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// ★ 产物必须留在仓库内：放到 `os.tmpdir()` 时产物里那句 `import 'react'`
//   会从 /tmp 往上找 `node_modules`，找不到。目录名带 pid 防同毫秒共用。
const outDir = join(root, '.build', `wipe-${process.pid}`);
const outFile = join(outDir, 'WipeDayDialog.mjs');

let WipeDayDialog = null;
let React = null;
let renderToStaticMarkup = null;

before(() => {
  mkdirSync(outDir, { recursive: true });
  buildSync({
    entryPoints: [join(root, 'src/client/WipeDayDialog.jsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile: outFile,
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    logLevel: 'silent',
  });
  React = require('react');
  renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup;
});

after(() => {
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* 沙箱会拦，不影响判据 */ }
});

const entries = [
  { time: '09:52', kind: '灵感', body: '真需求 = 高频 × 刚需 × 普适。' },
  { time: '10:29', kind: '灵感', body: '今天是个晴天' },
  { time: '18:54', kind: '灵感', body: '![](/api/dsh-npie-reader/diary/assets/0a11d2bc065f32e1.png)' },
];

async function render(props) {
  if (WipeDayDialog === null) {
    const mod = await import(pathToFileURL(outFile).href);
    WipeDayDialog = mod.WipeDayDialog;
  }
  assert.equal(typeof WipeDayDialog, 'function', 'WipeDayDialog 没导出');
  return renderToStaticMarkup(React.createElement(WipeDayDialog, {
    date: '2026-11-11', side: 'public', entries, chars: 152,
    reflections: 0, busy: false, error: '',
    onCancel() {}, onConfirm() {},
    ...props,
  }));
}

describe('删掉这一天的确认框（0.75.0）', () => {
  it('★ 标题说清是哪一天、删哪一半；合计说清几条几字', async () => {
    const html = await render({});
    assert.match(html, /删掉 2026-11-11 这一天的全部记录？/);
    assert.match(html, /3 条 · 152 字/);
  });

  it('★ 逐条列出（时间 + 类型 + 摘要），不是只报一个总数', async () => {
    const html = await render({});
    for (const entry of entries.slice(0, 2)) {
      assert.ok(html.includes(entry.time), `少了时间 ${entry.time}`);
      assert.ok(html.includes(entry.body), `少了摘要：${entry.body}`);
    }
    // 只有一张图的那条：`plainSnippet` 要把它变成「［图片］」，不能是一行空白。
    assert.ok(html.includes('［图片］'), '只有图片的一条在清单里成了空白 —— 认不出是哪条');
  });

  it('★ 读后感会被标出来（它和灵感在同一个文件里，删这天必然连它一起走）', async () => {
    const html = await render({ reflections: 1 });
    assert.match(html, /其中 1 篇读后感/);
    // 反向对照：0 篇时不该冒这一句，否则每次都在喊同一句话。
    assert.doesNotMatch(await render({ reflections: 0 }), /篇读后感/);
  });

  it('★ 私密那半边措辞不同（不然用户会以为在删公开记录）', async () => {
    const html = await render({ side: 'private' });
    assert.match(html, /这一天的全部私密记录/);
  });

  it('★ 说清文件去哪了 —— 可逆性必须写在按钮旁边', async () => {
    const html = await render({});
    assert.match(html, /diary\/_trash\//);
  });

  it('★ 飞行中：两个按钮都禁用、文案换成「正在删…」', async () => {
    const html = await render({ busy: true });
    assert.match(html, /正在删…/);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    assert.ok(buttons.length >= 2, '按钮不见了');
    for (const tag of buttons) assert.match(tag, /disabled/, `飞行中仍有可点的按钮：${tag}`);
  });

  it('★ 失败时错误留在框里（关掉再报错等于「点了没反应」）', async () => {
    const html = await render({ error: '这一天已经没有日记了' });
    assert.match(html, /role="alert"/);
    assert.ok(html.includes('这一天已经没有日记了'));
  });

  it('★ 空清单：确认按钮禁用（不让人对着空清单点删除）', async () => {
    const html = await render({ entries: [] });
    const go = /<button[^>]*npr-wipe-go[^>]*>/.exec(html);
    assert.ok(go !== null, '确认按钮不见了');
    assert.match(go[0], /disabled/);
    assert.match(html, /删掉这 0 条/);
  });
});
