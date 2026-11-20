/**
 * 「更多操作」下拉：**点外面关掉**的真跑守卫（0.10.3）。
 *
 * ★ 为什么必须有这个文件
 * ----------------------
 * 这个功能只有两个判据（「点的地方在菜单里吗」「在触发器里吗」），但**两个都写错就静默失效**：
 *
 *   ① 不排除**触发器** ⇒ pointerdown 先关、紧接着 ⋯ 按钮的 `onClick` 又把它翻回来
 *      ⇒ 菜单**永远关不掉**（症状：「点了 ⋯ 没反应」，不报错）；
 *   ② 不排除**菜单本身** ⇒ 菜单在 **pointerdown 阶段**就被卸载，随后的 click 落在
 *      已经消失的按钮上 ⇒ **点任何一条菜单项都什么都不做**（比①更严重）。
 *
 * 这两个坑都靠「源码里写了 `contains`」这种字符串断言看不出来 —— 本项目为
 * 「字符串断言给死代码发合格证」吃过亏（见 `client-runtime.test.mjs` 的注释）。
 *
 * ⇒ 这里**真跑**：内存里 esbuild 打包 → `node:vm` 加载 → 拿真函数，
 *   配一个**手写 DOM 桩**（`contains` 真走树、`removeEventListener` 按捕获标志匹配），
 *   真的挂监听、真的派发 `pointerdown`、真的卸载。
 *
 * ★ 三条反向对照改的是**真源码**（esbuild `onLoad` 替换，锚点没命中就抛错）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const READER_PAGE = join(pluginRoot, 'src/client/ReaderPage.jsx');
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

// ---- 1. 反向对照用：在 esbuild 读源码时把真源码换掉 --------------------------

/**
 * ★ 替换没命中就抛错，不许静默继续 —— 否则「没变红」会被误读成「装置抓不到」。
 *
 * 0.71.0：判据本体搬到 `src/client/menu-dismiss.js`，本文件仍从 ReaderPage
 * （它转发导出该函数）打 bundle，但**变异必须打在真正实现它的那个模块上** ——
 * 打在 ReaderPage.jsx 上会静默不命中，三条反向对照就全成了假绿。
 */
function mutateMenuDismiss(from, to) {
  return {
    name: 'mutate-menu-dismiss',
    setup(build) {
      build.onLoad({ filter: /menu-dismiss\.js$/ }, (args) => {
        const before = readFileSync(args.path, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'js' };
      });
    },
  };
}

// ---- 2. 与 build.mjs 同配置地在内存里打一份产物（不落盘） --------------------

async function bundleFromReader(names, { plugins = [] } = {}) {
  const result = await esbuild.build({
    stdin: {
      contents: `export { ${names.join(', ')} } from ${JSON.stringify(READER_PAGE)};`,
      loader: 'js',
      resolveDir: pluginRoot,
    },
    plugins,
    bundle: true,
    loader: { '.css': 'text' },
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
    platform: 'browser',
    format: 'cjs',
    target: 'chrome120',
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: { __NPIE_READER_VERSION__: JSON.stringify(PLUGIN_VERSION) },
    sourcemap: false,
    logLevel: 'silent',
    legalComments: 'none',
    write: false,
  });
  return result.outputFiles[0].text;
}

/** 假 `require`：react 给真的，宿主包给万能 Proxy（与兄弟测试文件同款）。 */
function makeRequire() {
  const stub = (label) => new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === '__esModule') return true;
      if (prop === Symbol.toStringTag) return 'Module';
      return stub(`${label}.${String(prop)}`);
    },
    apply: () => stub(`${label}()`),
    construct: () => stub(`new ${label}()`),
  });
  return (name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return JsxRuntime;
    return stub(name);
  };
}

function fakeGlobals() {
  const noop = () => {};
  const el = () => ({
    style: { setProperty: noop, removeProperty: noop },
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, removeAttribute: noop, appendChild: noop, removeChild: noop,
    remove: noop, addEventListener: noop, removeEventListener: noop, focus: noop,
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    querySelector: () => null, querySelectorAll: () => [],
  });
  return {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    getComputedStyle: () => ({ getPropertyValue: () => '', width: '0px', height: '0px' }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 },
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    document: { ...el(), head: el(), body: el(), documentElement: el(), createElement: () => el(), createElementNS: () => el() },
    window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), localStorage: { getItem: () => null } },
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  };
}

async function loadAttach(options) {
  const code = await bundleFromReader(['attachMenuDismiss'], options);
  const module = { exports: {} };
  const context = createContext({ ...fakeGlobals(), module, exports: module.exports, require: makeRequire() });
  runInContext(code, context, { filename: 'readerpage.cjs' });
  const { attachMenuDismiss } = module.exports;
  assert.equal(typeof attachMenuDismiss, 'function', 'attachMenuDismiss 没导出 —— 装置失效');
  return attachMenuDismiss;
}

// ---- 3. 手写 DOM 桩 ---------------------------------------------------------

/** 最小元素桩：`contains` **真走树**，不是硬编码返回 true/false。 */
function element(parent = null) {
  const node = {
    parentNode: parent,
    children: [],
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    contains(other) {
      for (let n = other; n; n = n.parentNode) if (n === node) return true;
      return false;
    },
  };
  return node;
}

/**
 * 最小 document 桩。
 * ★ `removeEventListener` **按捕获标志匹配**才算摘掉 —— 这正是要测的那条：
 *   用捕获阶段挂上、却用冒泡阶段摘，监听器会留在 document 上（菜单每开一次多一个）。
 */
function fakeDocument() {
  const listeners = [];
  const captureOf = (options) => (typeof options === 'object' && options !== null ? Boolean(options.capture) : Boolean(options));
  return {
    listeners,
    addEventListener(type, fn, options) { listeners.push({ type, fn, capture: captureOf(options) }); },
    removeEventListener(type, fn, options) {
      const capture = captureOf(options);
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    /** 派发一次 pointerdown，返回被调到的监听器个数。 */
    pointerDown(target) {
      let calls = 0;
      for (const l of [...listeners]) if (l.type === 'pointerdown') { l.fn({ type: 'pointerdown', target }); calls += 1; }
      return calls;
    },
  };
}

/** 真 DOM 结构：`.npr-actions` 里同时装着 ⋯ 按钮和菜单。 */
function buildTree() {
  const root = element();
  const actions = element(root);
  const trigger = element(actions);
  const menu = element(actions);
  const item = element(menu);
  const outside = element(root);
  return { root, actions, trigger, menu, item, outside };
}

/** 挂上之后派发一次 pointerdown，返回 close 被调了几次。 */
function press(attach, target) {
  const doc = fakeDocument();
  let closes = 0;
  const detach = attach(doc, { menu: null, trigger: null, close: () => { closes += 1; } });
  doc.pointerDown(target);
  detach();
  return closes;
}

// ---- 4. 用例 -----------------------------------------------------------------

describe('★ 0.10.3「更多操作」：点外面关掉（真跑挂载 / 派发 / 卸载）', () => {
  it('点菜单外面 → 关一次', async () => {
    const attach = await loadAttach();
    const t = buildTree();
    assert.equal(press(attach, t.outside), 1, '点空白处没关 —— 这正是用户报的问题');
  });

  it('★ 点菜单里的条目 → **不关**（否则菜单在 pointerdown 阶段就被卸掉，click 落空）', async () => {
    const attach = await loadAttach();
    const t = buildTree();
    const doc = fakeDocument();
    let closes = 0;
    const detach = attach(doc, { menu: t.menu, trigger: t.trigger, close: () => { closes += 1; } });
    doc.pointerDown(t.item);
    detach();
    assert.equal(closes, 0,
      '点菜单项时把菜单关了 —— 菜单会在 pointerdown 阶段卸载，紧接着的 click 落在已消失的按钮上，菜单项点了什么都不做');
  });

  it('★ 点 ⋯ 触发器 → **不关**（否则 onClick 又翻回来，菜单永远关不掉）', async () => {
    const attach = await loadAttach();
    const t = buildTree();
    const doc = fakeDocument();
    let closes = 0;
    const detach = attach(doc, { menu: t.menu, trigger: t.trigger, close: () => { closes += 1; } });
    doc.pointerDown(t.trigger);
    detach();
    assert.equal(closes, 0,
      '点 ⋯ 按钮本身时也关了 —— pointerdown 关一次、onClick 再翻回来，菜单永远关不掉（「点了 ⋯ 没反应」）');
  });

  it('点 ⋯ 按钮里更深一层的元素（图标 svg）也**不关** —— `contains` 必须走树，不是比引用', async () => {
    const attach = await loadAttach();
    const t = buildTree();
    const icon = element(t.trigger);
    const doc = fakeDocument();
    let closes = 0;
    const detach = attach(doc, { menu: t.menu, trigger: t.trigger, close: () => { closes += 1; } });
    doc.pointerDown(icon);
    detach();
    assert.equal(closes, 0, '点在 ⋯ 里的 svg 上被判成「外面」—— 用户点图标（而不是按钮边缘）时菜单会闪一下');
  });

  it('挂在 document 上、且用**捕获阶段**（宿主 UI 的 stopPropagation 不该让我们关不掉）', async () => {
    const attach = await loadAttach();
    const t = buildTree();
    const doc = fakeDocument();
    const detach = attach(doc, { menu: t.menu, trigger: t.trigger, close: () => {} });
    assert.equal(doc.listeners.length, 1, '没有在 document 上挂监听');
    assert.equal(doc.listeners[0].type, 'pointerdown');
    assert.equal(doc.listeners[0].capture, true, '用的是冒泡阶段 —— 宿主任何一处 stopPropagation 都会让菜单关不掉');
    detach();
  });

  it('★ 卸载函数把监听器摘干净（移除时的捕获标志必须与添加时一致）', async () => {
    const attach = await loadAttach();
    const t = buildTree();
    const doc = fakeDocument();
    const detach = attach(doc, { menu: t.menu, trigger: t.trigger, close: () => {} });
    detach();
    assert.equal(doc.listeners.length, 0,
      '卸载后监听器还在 document 上 —— 菜单每开一次多留一个，且旧的还指着过期的 ref');
  });

  it('没传 menu / trigger 时不炸，且一律判「外面」', async () => {
    const attach = await loadAttach();
    const t = buildTree();
    assert.equal(press(attach, t.menu), 1, 'menu 为 null 时应当一律关闭');
  });
});

describe('接线：ReaderPage 真的把它挂上了（★ 存在性断言，不是可达性证明）', () => {
  /**
   * ★ 边界说清楚：这组只能抓「effect 被删了 / ref 接错元素 / 条件写反」，
   *   **抓不到**「effect 在真 React 生命周期里没跑到」。真正的行为保证在上一组真跑用例里。
   */
  const source = readFileSync(READER_PAGE, 'utf8');

  it('effect 只在菜单开着时挂监听，并把两个 ref 与 `setMenuOpen(false)` 传进去', () => {
    assert.match(source, /if \(!menuOpen\) return undefined;/,
      'effect 没有「菜单关着就不挂」的短路 —— 关着的时候会在 document 上白留一个监听');
    assert.match(source, /attachMenuDismiss\(document,\s*\{[\s\S]{0,200}?menu: menuRef\.current,[\s\S]{0,120}?trigger: menuButtonRef\.current,[\s\S]{0,120}?close: \(\) => setMenuOpen\(false\)/,
      '没有把 attachMenuDismiss 接上（或 ref / close 传错）—— 判据再对也不会生效');
  });

  it('两个 ref 各自挂在**正确的元素**上：`menuRef` → 菜单、`menuButtonRef` → ⋯ 按钮', () => {
    // ★ 只锚「ref 挂在哪个元素上」，不锚 role 的取值：这条判据守的是接线
    //   （`menuRef` 指向菜单容器），role 是 `menu` 还是 `group` 与它无关。
    //   0.84.7 把这个菜单降级成 `group`（子项没有 menuitem / 方向键），
    //   如果这里继续写死 `role="menu"`，一次语义修正就会红成「接线坏了」。
    assert.match(source, /className="npr-menu"[^>]*ref=\{menuRef\}/,
      'menuRef 没挂在菜单上 —— 「点菜单项不关」那条判据会失效（点任何一条都没反应）');
    assert.match(source, /aria-label="更多操作"[\s\S]{0,200}?ref=\{menuButtonRef\}/,
      'menuButtonRef 没挂在 ⋯ 按钮上 —— 菜单会永远关不掉');
  });

  it('⋯ 按钮声明了 `aria-haspopup="menu"`（它是菜单触发器，读屏器要知道）', () => {
    assert.match(source, /aria-haspopup="menu" aria-expanded=\{menuOpen\}/);
  });
});

describe('★ 反向对照：这套装置真的能抓到两个「静默失效」', () => {
  it('删掉**触发器**那条排除之后，「点 ⋯ 不关」必须变红', async () => {
    const attach = await loadAttach({
      plugins: [mutateMenuDismiss('if (trigger?.contains?.(target)) return;', 'if (false) return;')],
    });
    const t = buildTree();
    const doc = fakeDocument();
    let closes = 0;
    const detach = attach(doc, { menu: t.menu, trigger: t.trigger, close: () => { closes += 1; } });
    doc.pointerDown(t.trigger);
    detach();
    assert.equal(closes, 1, '去掉触发器排除之后仍然不关 —— 那上面那条断言是假绿（且抓不到「菜单永远关不掉」）');
  });

  it('删掉**菜单**那条排除之后，「点菜单项不关」必须变红', async () => {
    const attach = await loadAttach({
      plugins: [mutateMenuDismiss('if (menu?.contains?.(target)) return;', 'if (false) return;')],
    });
    const t = buildTree();
    const doc = fakeDocument();
    let closes = 0;
    const detach = attach(doc, { menu: t.menu, trigger: t.trigger, close: () => { closes += 1; } });
    doc.pointerDown(t.item);
    detach();
    assert.equal(closes, 1, '去掉菜单排除之后仍然不关 —— 抓不到「点任何菜单项都没反应」这个更严重的形态');
  });

  it('卸载时漏掉捕获标志之后，「摘干净」必须变红', async () => {
    const attach = await loadAttach({
      plugins: [mutateMenuDismiss(
        "doc.removeEventListener('pointerdown', onPointerDown, true);",
        "doc.removeEventListener('pointerdown', onPointerDown);",
      )],
    });
    const t = buildTree();
    const doc = fakeDocument();
    const detach = attach(doc, { menu: t.menu, trigger: t.trigger, close: () => {} });
    detach();
    assert.equal(doc.listeners.length, 1, '漏掉捕获标志却仍被判「摘干净」—— 那这条断言抓不到监听器泄漏');
  });

  /**
   * 0.69.1 论文页「+」下拉用的是**另一种合法接法**：触发器与菜单包在同一个
   * `.npr-paper-add` 容器里，`menu` / `trigger` 传的是**同一个节点**。
   * 不能只在源码里读一遍「看起来对」—— 静默失效的两种形态和上面一模一样，
   * 必须用真 DOM 桩跑一遍 pointerdown。
   */
  it('论文「+」下拉：menu/trigger 同一个容器 → 点按钮与菜单项都不关、点外面关', async () => {
    const attach = await loadAttach();
    const root = element();
    const container = element(root);   // .npr-paper-add：按钮与菜单都在这里面
    const plus = element(container);
    const menu = element(container);
    const item = element(menu);
    const outside = element(root);
    const doc = fakeDocument();
    let closes = 0;
    const detach = attach(doc, { menu: container, trigger: container, close: () => { closes += 1; } });

    doc.pointerDown(plus);
    doc.pointerDown(item);
    assert.equal(closes, 0,
      '点「+」或点菜单项时收起了 —— 前者会让菜单永远关不掉，后者会让菜单项点了没反应');

    doc.pointerDown(outside);
    assert.equal(closes, 1, '点外面没收起 —— 「+」菜单会一直挂着');
    detach();
    assert.equal(doc.listeners.length, 0, '卸载后监听器还留在 document 上');
  });
});
