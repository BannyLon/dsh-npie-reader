/**
 * 灵感速记浮层的「能不能画出来」冒烟（0.72.0）。
 *
 * ★ 为什么要有这一条：`quick-capture.test.mjs` 测的全是纯函数，它看不见
 *   「组件体里某个 `const` 在声明之前就被读了」这类错误（`const` 有暂时性死区，
 *   表现是整个浮层白屏、按 `L` 什么也不出现）。本仓库 0.47.0 就是这样发出去的
 *   —— 131 条源码判据全绿，用户只看到「什么鬼，打不开啊」。
 *
 * ⇒ 真的把组件渲染一次（esbuild 打包 + `react-dom/server`）。`renderToString`
 *   会执行组件体里的每一行（所有 `useState` 初值与所有派生 `const`）。
 *
 * ★ 它**不**覆盖 `useEffect` 里的草稿恢复：SSR 不跑 effect。那部分行为由
 *   `quick-capture.test.mjs` 用纯函数覆盖（`readDraft` / `writeDraft`），
 *   接线本身（effect 里有没有调 `readDraft`）只能真机看 —— 别在这里假装测了。
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
//   会从 /tmp 往上找 `node_modules`，找不到（实测 ERR_MODULE_NOT_FOUND）。
// ★ 目录名带 pid：同一套件的两个进程同毫秒启动会共用目录。
const outDir = join(root, '.build', `quick-${process.pid}`);
const outFile = join(outDir, 'QuickCapture.mjs');

let QuickCapture = null;
let React = null;

before(() => {
  mkdirSync(outDir, { recursive: true });
  buildSync({
    entryPoints: [join(root, 'src/client/QuickCapture.jsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile: outFile,
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    logLevel: 'silent',
  });
  React = require('react');
});

after(() => {
  // 沙箱的删除层偶尔会拦（0.47.0 就拦过）；清不掉不影响判据。
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function mount(props) {
  if (QuickCapture === null) {
    const mod = await import(pathToFileURL(outFile).href);
    QuickCapture = mod.QuickCapture;
  }
  assert.equal(typeof QuickCapture, 'function', 'QuickCapture 没导出');
  const { renderToString } = require('react-dom/server');
  return renderToString(React.createElement(QuickCapture, props));
}

describe('0.72.0：灵感速记浮层渲染冒烟', () => {
  it('关着时不占位（返回空，不是一层看不见的遮罩）', async () => {
    assert.equal(await mount({ open: false }), '');
  });

  it('★ 打开能画出来，且只有一个输入框（速记不是第二张日记表单）', async () => {
    const html = await mount({ open: true, onClose() {}, notify() {} });
    assert.match(html, /记一条/);
    assert.match(html, /记下来/);
    // 输入框只有一个：多一个 select / input 就是把「少一个决策」还回去了。
    assert.equal((html.match(/<textarea/g) ?? []).length, 1);
    assert.equal((html.match(/<input/g) ?? []).length, 0);
    assert.equal((html.match(/<select/g) ?? []).length, 0);
  });

  it('没有阅读上下文时不显示「会记到」那一行', async () => {
    const html = await mount({ open: true, onClose() {}, notify() {}, context: null });
    assert.doesNotMatch(html, /会记到/);
  });

  it('★ 书里按 L：把书名与章写进「会记到」，书名号不套两遍', async () => {
    const html = await mount({
      open: true,
      onClose() {},
      notify() {},
      context: { bookId: 'p477', bookTitle: '某本书', chapter: { n: 2, title: '第二章' }, page: 31 },
    });
    assert.match(html, /会记到/);
    assert.match(html, /《某本书》/);
    assert.match(html, /第二章/);
  });

  it('书源标题本来就带书名号时不再补一对（`《《…》》`）', async () => {
    const html = await mount({
      open: true,
      onClose() {},
      notify() {},
      context: { bookId: 'p1', bookTitle: '《译文名著文库》 076' },
    });
    assert.doesNotMatch(html, /《《/);
    assert.match(html, /《译文名著文库》 076/);
  });

  it('文章里按 L：标题套「」而不是书名号（套了就是在说它是一本书）', async () => {
    const html = await mount({
      open: true,
      onClose() {},
      notify() {},
      context: { articleKey: 'a1', articleTitle: '一篇关于缓存的文章' },
    });
    assert.match(html, /「一篇关于缓存的文章」/);
    assert.doesNotMatch(html, /《一篇关于缓存的文章》/);
  });

  it('恢复提示行在 SSR 下不出现（effect 不跑）—— 这不是缺陷，是这条测试的边界', async () => {
    const html = await mount({ open: true, onClose() {}, notify() {} });
    assert.doesNotMatch(html, /已恢复/);
  });

  /*
   * ★ 这里**不**断言「带进来的选区出现在框里」：`react-dom/server` 渲染受控
   *   `<textarea>` 时不写 `children`，`value` 在服务端就是一个属性、不进 HTML
   *   （实测输出是 `<textarea …></textarea>`，空的）。真去断言只会得到一条
   *   「看起来在测、其实恒假」的用例。
   *   那条决策（草稿优先于种子）改由纯函数 `initialBody()` 在
   *   `quick-capture.test.mjs` 里判，接线用源码顺序断言守（同上）。
   */

  it('没在打 `#` 时不画候选行（它不能变成常驻的第二排控件）', async () => {
    const html = await mount({ open: true, onClose() {}, notify() {} });
    assert.doesNotMatch(html, /npr-quick-tags/);
  });
});
