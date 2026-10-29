/**
 * 日记页「首屏能不能渲染出来」的冒烟（0.47.1）。
 *
 * ★ 为什么必须有这一条：`diary-ui.test.mjs` 读的是**源码字符串**，它永远看不见
 *   「某个变量在声明之前就被读了」。0.47.0 就是这样发出去的 —— `linkKey` 从
 *   `useState` 改成 `sourceScope` 的派升值，但那行还留在 `sourceScope` 声明的
 *   上面 138 行处；`const` 有暂时性死区，于是整个日记页白屏，报
 *   `Cannot access 'sourceScope' before initialization`。
 *   131 条源码判据全绿，用户一打开只看到「什么鬼，打不开啊」。
 *
 * ★ 同一份改动里还有第二处同样的洞：`recentDays` 读 `timelineDays`，而后者写在
 *   它下面 14 行。**两处都是「搬了一行、忘了顺序」**，而这类错误在源码判据里
 *   一点痕迹都没有。
 *
 * ⇒ 这里真的把组件渲染一次（esbuild 打包 + `react-dom/server`）。只看一件事：
 *   **它能不能渲染出来**。渲染出来的结构对不对，由别的判据管。
 *   `renderToString` 会执行组件体里的每一行（所有 `useState` 初值与所有派生
 *   `const`），所以上面那类顺序错误当场就抛。
 *
 * ★ 它**不**覆盖事件处理函数里的顺序错误（那些函数要真的点了才执行）。所以
 *   「把 derive 出来的东西放在声明它依赖的状态之前」这条纪律仍然归人。
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
// ★ 产物必须留在仓库里：放到 `os.tmpdir()` 的话，产物里那句 `import 'react'`
//   会从 /tmp 往上找 `node_modules`，找不到（实测 ERR_MODULE_NOT_FOUND）。
// ★ 目录名带 pid：同一套件的两个进程同毫秒启动会共用目录（以前踩过，见 0.44）。
const outDir = join(root, '.build', `render-${process.pid}`);
const outFile = join(outDir, 'DiaryApp.mjs');

let DiaryApp = null;

before(() => {
  mkdirSync(outDir, { recursive: true });
  buildSync({
    entryPoints: [join(root, 'src/client/DiaryApp.jsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile: outFile,
    // ★ 只外置 React 本身：其余模块（sanitize / markdown / icons / 子组件）
    //   全都打进来，这样测的是这一份源码，不是 `dist/` 里上一次构建的残留。
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    logLevel: 'silent',
  });

  // 最小 DOM 垫片：`ensureStyles()` 里只有 `createElement` + `head.appendChild`。
  const node = () => ({ dataset: {}, style: {}, textContent: '', setAttribute() {}, appendChild() {} });
  globalThis.document = { createElement: node, head: node(), querySelector: () => null };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.window = globalThis;
});

after(() => {
  // 沙箱的删除层偶尔会拦（0.47.0 就拦过）；清不掉不影响判据，别让它把测试搞红。
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** `useLayoutEffect` 在 SSR 下必然刷一条警告 —— 它与本判据无关，别让输出变脏。 */
function renderQuiet(element) {
  const { renderToString } = require('react-dom/server');
  const original = console.error;
  console.error = (...args) => {
    if (String(args[0] ?? '').includes('useLayoutEffect does nothing on the server')) return;
    original(...args);
  };
  try {
    return renderToString(element);
  } finally {
    console.error = original;
  }
}

describe('0.47.1：日记页首屏渲染冒烟', () => {
  it('★ 能渲染出来（不是白屏）', async () => {
    if (DiaryApp === null) {
      // 产物在仓库内，从 `.build/render-<pid>/` 往上就能解析到 `react`。
      const mod = await import(pathToFileURL(outFile).href);
      DiaryApp = mod.DiaryApp;
    }
    assert.equal(typeof DiaryApp, 'function', 'DiaryApp 没导出');

    const React = require('react');
    // ★ 每个方法都返回 `async () => ({})`：首屏不该依赖任何一次请求就画得出来，
    //   而 `useEffect` 在 SSR 下根本不执行 —— 给个万能桩就够了。
    const api = new Proxy({}, { get: () => async () => ({}) });
    const props = {
      onExit() {},
      notify() {},
      api,
      SessionProvider: ({ children }) => children ?? null,
      renderSlot: () => null,
    };

    // 抛出来的是什么就报什么：`Cannot access 'x' before initialization` 这类
    // 消息本身就是结论，别包一层把它盖掉。
    const html = renderQuiet(React.createElement(DiaryApp, props));

    // 长度下限防的是「渲染成功但一片空」：真正的首屏有侧栏三段 + 正文骨架。
    assert.ok(html.length > 3000, `只渲染出 ${html.length} 个字符 —— 基本等于白屏`);
    // 两边骨架都在：只画出侧栏或只画出正文，都是「打不开」的另一种样子。
    for (const cls of ['npr-diary-panel', 'npr-diary-main', 'npr-diary-modes']) {
      assert.ok(html.includes(cls), `首屏缺了 ${cls} —— 这一页只剩半截`);
    }
  });
});
