/**
 * 阅读器**真的渲染一次**（react-dom/server），用来抓「渲染期才炸」的 hook 错误。
 *
 * ★ 为什么必须补这一个文件
 * ------------------------
 * 0.20.6 发出去之后，用户一打开阅读器就是整页的
 * 「阅读器页面加载失败 / Cannot access 'toggleImmersive' before initialization」。
 *
 * 根因：`cycleTint` / `toggleImmersive` 两个 `useCallback` 写在键盘那个 `useEffect`
 * **下面**，而那个 effect 的依赖数组里点着它们的名字。依赖数组是**渲染期**求值的
 * 普通表达式 —— 于是渲染到那一行时这两个 `const` 还在 TDZ 里，直接抛
 * `ReferenceError`。Error Boundary 接住 ⇒ 用户看到的是「加载失败」。
 *
 * 当时全仓 700+ 用例全绿，原因很具体：
 *   - 浏览器半区的守卫（`test/client-runtime.test.mjs`）用的是**桩 React**，
 *     它只验证「模块体能不能跑完」，组件函数**一次都没被调用**；
 *   - 其余断言（`book-render` / `book-text` / `window-drag`）全是**读源码字符串**，
 *     而「回调声明在 effect 之后」这件事在字符串层面完全合法。
 *
 * ⇒ 这类错误的定论只能来自**真渲染**：把 `BookReader` 真的当组件调一次，
 *   让 React 去走完渲染体（包括每个 effect 的依赖数组求值）。
 *
 * 本文件**不写盘**：esbuild `write: false` 在内存里打一份测试专用入口
 * （只导出 `BookReader`），再用真 `react` / `react-dom/server` 渲染。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToString } = require('react-dom/server');

/** 测试入口：只把 `BookReader` 端出来，别的模块体不参与（省得拉整个 client）。 */
const ENTRY = `
export { BookReader } from './src/client/BookReader.jsx';
`;

const BANNER = `window.__ModuleLoader__.load({
	id: "dsh-npie-reader-test",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;
const FOOTER = `
		return module.exports;
	}
});
`;

/**
 * 把一段入口打成客户端产物（与 `build.mjs` 同一套 external / jsx 配置）。
 *
 * ★ `bundle: true` 但只让 `react*` 保持外部：真 react 由 Node 侧提供，
 *   于是渲染出来的是**真 React 的渲染体**，不是桩。
 */
async function bundle(entry) {
  const result = await esbuild.build({
    stdin: { contents: entry, loader: 'jsx', resolveDir: pluginRoot },
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'chrome120',
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: { __NPIE_READER_VERSION__: JSON.stringify('0.0.0-test') },
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
    sourcemap: false,
    logLevel: 'silent',
    legalComments: 'none',
    write: false,
    banner: { js: BANNER },
    footer: { js: FOOTER },
  });
  return result.outputFiles[0].text;
}

/** 渲染期用得到的浏览器全局（只有 `document.createElement` 这类，够渲染体走完就好）。 */
function fakeGlobals() {
  const noop = () => {};
  const el = () => ({
    style: { setProperty: noop, removeProperty: noop },
    dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, removeAttribute: noop,
    appendChild: noop, removeChild: noop, remove: noop,
    addEventListener: noop, removeEventListener: noop, focus: noop,
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    querySelector: () => null, querySelectorAll: () => [],
  });
  return {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    getComputedStyle: () => ({ getPropertyValue: () => '', width: '0px', height: '0px' }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 },
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    document: {
      ...el(), head: el(), body: el(), documentElement: el(),
      createElement: () => el(), createElementNS: () => el(), createTextNode: () => el(),
    },
  };
}

/** 执行产物，返回 `factory` 拿到的导出；顶层 / factory 两段错误分开报。 */
function runBundle(code) {
  const sandbox = fakeGlobals();
  let captured = null;
  sandbox.window = { __ModuleLoader__: { load(def) { captured = def; } } };
  sandbox.window.window = sandbox.window;
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);
  runInContext(code, ctx, { filename: 'client-test-bundle.js' });
  assert.notEqual(captured, null, '产物没有注册 ModuleLoader');
  return captured.factory((name) => require(name));
}

/** 一次渲染要用到的最小 props（多给无害，少给会直接抛）。 */
function makeProps() {
  const Passthrough = ({ children }) => children ?? null;
  return {
    book: { id: 'b1', title: '测试书', ext: '.pdf', size: 1024 },
    reading: null,
    states: {},
    onPageChange: () => {},
    onFinished: () => {},
    notify: () => {},
    api: { saveSettings: async () => {}, getSettings: async () => ({}), listAiModels: async () => ({ providers: [] }) },
    SessionProvider: Passthrough,
    renderSlot: () => null,
    onManagePrompts: () => {},
    onScannedChange: () => {},
  };
}

describe('BookReader 真渲染（渲染期 hook 契约）', () => {
  it('能渲染出内容，且不抛 ReferenceError', async () => {
    const { BookReader } = await runBundle(await bundle(ENTRY));
    assert.equal(typeof BookReader, 'function', '出口里没有 BookReader');
    let html = '';
    assert.doesNotThrow(() => {
      html = renderToString(React.createElement(BookReader, makeProps()));
    }, '渲染 BookReader 抛错了 —— 这正是一打开阅读器就白屏的那条路');
    assert.ok(html.length > 0, '渲染结果为空');
    // 初始态必须是「正在取书…」这类可读文案，不是空白壳子。
    assert.match(html, /npr-book/, '渲染结果里没有阅读器根节点');
  });

  /**
   * 反向对照：同样的形状（`useCallback` 定义在 effect **之后**、名字进依赖数组）
   * 必须让这条判据**变红**。否则它只是把当前实现抄了一遍。
   */
  it('反向对照：回调定义在依赖数组之后 ⇒ 渲染必须抛错', async () => {
    const BROKEN = `
import { useCallback, useEffect, useState } from 'react';

export function Broken() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const onKey = () => toggle();
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [toggle]);
  const toggle = useCallback(() => setOn((v) => !v), []);
  return <div data-on={String(on)}>x</div>;
}
`;
    const { Broken } = await runBundle(await bundle(BROKEN));
    assert.throws(
      () => renderToString(React.createElement(Broken)),
      /before initialization/,
      '反向对照没炸 —— 说明这条判据抓不到这类顺序错误',
    );
  });
});
