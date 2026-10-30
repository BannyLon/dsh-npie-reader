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

  /**
   * 0.48：落到**读后感**那一块也真的渲染一次。
   *
   * ★ 「思想留白 · 拾遗」这一小块是这一版改动最密的地方：索引 → 写过 / 待写 → 筛选后的
   *   数组 → 卡片标记，四层派生。任何一层写在它的依赖之前，`const` 的暂时性死区
   *   会当场抛；而源码判据（`diary-ui.test.mjs`）看不出来 —— 0.47.0 的白屏就是
   *   这么发出去的。
   * ★ 顺带钉一条「别抢跑」：书单还没回来（`books.items` 是空的）时**不画**筛选条。
   *   三个数都是 0 的筛选条比没有它更糟 —— 用户会以为自己的书全丢了。
   */
  it('★ 读后感模块也不白屏，标题是「思想留白 · 拾遗」', async () => {
    if (DiaryApp === null) {
      const mod = await import(pathToFileURL(outFile).href);
      DiaryApp = mod.DiaryApp;
    }
    const React = require('react');
    const api = new Proxy({}, { get: () => async () => ({}) });
    const html = renderQuiet(React.createElement(DiaryApp, {
      onExit() {},
      notify() {},
      api,
      intent: { module: 'reflection' },
      SessionProvider: ({ children }) => children ?? null,
      renderSlot: () => null,
    }));
    assert.ok(html.includes('思想留白 · 拾遗'), '读后感侧栏没渲染出「思想留白 · 拾遗」');
    assert.ok(!html.includes('npr-diary-shelffilter'), '书单还没回来就把筛选条画出来了');
  });

  /**
   * 0.56.0：顶栏**说明页没有、工作页有**。
   *
   * ★ 为什么这条必须**真渲染**：`diary-bare-head.test.mjs` 判的是 `headVisible()`
   *   的真值表与源码接线，它证明不了「那一段 JSX 真的被渲染 / 没被渲染」——
   *   `{showHead && ...}` 写成 `{showHead || ...}`、或者顶栏被挪到 `showHead`
   *   判据之外，字符串断言都可能照样绿。这里渲染三次，直接看 DOM 里有没有
   *   `npr-diary-head`。
   * ★ 三态必须一起验：只验「读后感说明页没有顶栏」的话，把顶栏全局删掉也能过 ——
   *   而灵感那一条是要留的（用户 2026-10-30 第二次：「这个页面保持和之前
   *   一致，就是顶部有标题栏」）。
   *
   * ★ 0.56.2 起**私密这一格渲染出来的是说明页**（它现在也有一张，进来先看见）。
   *   私密的**工作页**（按过说明页之后那一屏）在一次挂载里拿不到 —— 它必须先过
   *   说明页。所以「私密工作页有顶栏」这条由纯函数真值表
   *   （`['private', false, false, true]`）钉住，这里不再假装能渲染到它。
   */
  it('★ 灵感工作页有顶栏；两屏说明页没有（三态一起验，防止「全局删掉」蒙混）', async () => {
    if (DiaryApp === null) {
      const mod = await import(pathToFileURL(outFile).href);
      DiaryApp = mod.DiaryApp;
    }
    const React = require('react');
    const api = new Proxy({}, { get: () => async () => ({}) });
    const render = (module) => renderQuiet(React.createElement(DiaryApp, {
      onExit() {},
      notify() {},
      api,
      intent: { module },
      SessionProvider: ({ children }) => children ?? null,
      renderSlot: () => null,
    }));

    // 工作页：顶栏在（灵海报这一天的事实）。
    const insp = render('inspiration');
    assert.ok(insp.length > 3000, `inspiration 只渲染出 ${insp.length} 个字符 —— 基本等于白屏`);
    assert.ok(insp.includes('npr-diary-head'), '灵感工作页的顶栏不见了 —— 用户要的是「说明页不要」，不是「全删」');
    assert.ok(insp.includes('npr-diary-h1'), '灵感工作页少了 h1');
    assert.ok(!insp.includes('data-bare'), '灵感工作页还打着 data-bare —— CSS 会把顶栏那条线让掉');

    // 私密：进来先看见说明页 —— 那一屏没有顶栏。
    const priv = render('private');
    assert.ok(priv.length > 3000, `private 只渲染出 ${priv.length} 个字符 —— 基本等于白屏`);
    assert.ok(!priv.includes('npr-diary-head'), '私密说明页上还挂着顶栏');
    assert.ok(priv.includes('data-bare'), '私密说明页没打 data-bare —— CSS 不会把那条底边让掉');

    // 说明页（读后感还没选书）：没有顶栏，但拖动行不能跟着消失
    // —— `data-window-drag` 在它身上，删了顶部就拖不动窗口。
    const html = render('reflection');
    assert.ok(html.length > 3000, `reflection 只渲染出 ${html.length} 个字符 —— 基本等于白屏`);
    assert.ok(!html.includes('npr-diary-head'), '读后感说明页还挂着顶栏（h1 + 副标题）');
    assert.ok(!html.includes('npr-diary-h1'), '读后感说明页还挂着 h1');
    assert.ok(html.includes('npr-book-toolbar'), '拖动行被删了 —— 这一页顶部拖不动窗口');
    assert.ok(html.includes('data-bare'), '没打 data-bare —— CSS 不会把那条底边让掉');
  });

  /**
   * 0.56.2：**两张说明页都真的渲染出来**，而且那一屏的顶栏真的空着。
   *
   * ★ 为什么必须真渲染：用户这次的原话是「为什么私密日记没有说明页」。
   *   源码判据只能证明「分派写在了 `showCover` 里面」；`{showCover && …}` 写成
   *   `{showCover || …}`、或者 `PrivateCover` 被挂到 `!showCover` 那一支上，
   *   字符串断言全都照样绿。这里直接看 DOM 里有没有 `.npr-diary-startpage`、
   *   里面那句标题是哪一张的。
   *
   * ★ 三态一起验：
   *     不带 intent（默认灵感）      → 灵感那张「寸心拾遗 · 思想原点」
   *     带私密意图（0.56.2 的入口）  → 私密那张「私密日记 · 只在本机」
   *     带灵感意图（已经在写了）      → 一张都没有
   *   只验其中一格的话，把两张写成同一张也能过。
   */
  it('★ 灵感 / 私密两张说明页都真的渲染出来，且那一屏没有顶栏', async () => {
    if (DiaryApp === null) {
      const mod = await import(pathToFileURL(outFile).href);
      DiaryApp = mod.DiaryApp;
    }
    const React = require('react');
    const api = new Proxy({}, { get: () => async () => ({}) });
    const render = (intent) => renderQuiet(React.createElement(DiaryApp, {
      onExit() {},
      notify() {},
      api,
      intent,
      SessionProvider: ({ children }) => children ?? null,
      renderSlot: () => null,
    }));

    // ① 默认落在灵感：开场页在，顶栏空着。
    const insp = render(undefined);
    assert.ok(insp.includes('npr-diary-startpage'), '灵感开场页没渲染出来');
    assert.ok(insp.includes('寸心拾遗 · 思想原点'), '灵感开场页的标题不见了');
    assert.ok(!insp.includes('npr-diary-head'), '灵感开场页上还挂着顶栏');
    assert.ok(insp.includes('data-bare'), '灵感开场页没打 data-bare');

    // ② 私密：**它自己那一张**，不是灵感那张的复制。
    const priv = render({ module: 'private' });
    assert.ok(priv.includes('npr-diary-startpage'), '私密说明页没渲染出来 —— 用户这次要的就是它');
    assert.ok(priv.includes('私密日记 · 只在本机'), '私密说明页的标题不见了');
    assert.ok(!priv.includes('寸心拾遗'), '私密那一屏渲染成了灵感那张');
    assert.ok(!priv.includes('npr-diary-head'), '私密说明页上还挂着顶栏');
    assert.ok(priv.includes('data-bare'), '私密说明页没打 data-bare —— 顶上会多一条没来由的横线');
    // 锁着的时候不能报「0 条 · 0 字」：那些数不是零，是取不到。
    assert.ok(!priv.includes('0 条'), '私密说明页报了个条数 —— 上锁时宿主根本不给正文');

    // ③ 带着灵感意图进来 = 已经在写了：不该再拦一下。
    const writing = render({ module: 'inspiration' });
    assert.ok(!writing.includes('npr-diary-startpage'), '带灵感意图进来还弹开场页 —— 用户已经在写了');
  });
});
