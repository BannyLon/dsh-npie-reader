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
import { stripComments } from '../scripts/strip-comments.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToString } = require('react-dom/server');

/** 测试入口：只把 `BookReader` 端出来，别的模块体不参与（省得拉整个 client）。 */
const ENTRY = `
export { BookReader } from './src/client/BookReader.jsx';
`;

/**
 * 重排电子书（0.25.0）走的是**另一个组件**，所以它需要自己那一次真渲染 ——
 * 白屏风险跟 PDF 那一侧是同一个来源（hook 顺序 / TDZ），而不是同一条代码路径。
 */
const ENTRY_EBOOK = `
export { BookEbook } from './src/client/BookEbook.jsx';
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

/**
 * 重排电子书（0.25.0）：**同一个白屏风险，另一条代码路径**。
 *
 * `BookEbook` 是一个独立组件（没有往 `BookReader` 里加分支，理由见 CHANGELOG 第五节），
 * 所以 PDF 那一次真渲染**证明不了**它。这个组件挂了不少 hook：打开书取索引、
 * 取当前节、键盘监听、预取下一节、上报进度……任何一个 callback 声明到 effect 后面，
 * 用户看到的就是「一打开 EPUB 整页白屏」。
 *
 * ★ 只验**渲染体**（`renderToString` 不跑 effect）：这是刻意的 —— 白屏来自渲染期的
 *   TDZ / hook 顺序，不是来自异步取数；异步链路由 `test/ebook.test.mjs` 的三条路由用例覆盖。
 */
describe('BookEbook 真渲染（重排电子书的渲染期契约）', () => {
  it('能渲染出加载态，且不抛（打不开书时不是白屏）', async () => {
    const { BookEbook } = await runBundle(await bundle(ENTRY_EBOOK));
    assert.equal(typeof BookEbook, 'function', '出口里没有 BookEbook');
    let html = '';
    assert.doesNotThrow(() => {
      html = renderToString(React.createElement(BookEbook, {
        ...makeProps(),
        book: { id: 'b-epub', title: '测试 EPUB', ext: '.epub', size: 2048 },
        onImmersiveChange: () => {},
      }));
    }, '渲染 BookEbook 抛错了 —— 这正是一打开电子书就白屏的那条路');
    // 根节点是 `.npr-book`（与 PDF 共用外壳），书页那一层是 `.npr-ebook-stage`。
    assert.match(html, /npr-book/, '渲染结果里没有阅读器根节点');
    assert.match(html, /npr-ebook-stage/, '渲染结果里没有重排书页容器');
    // 反向对照：加载态必须**说人话**，不是一块空白。
    assert.match(html, /正在整理这本书/, '加载态没有提示文案');
  });

  /**
   * 版式契约（0.25.1）。这三条都是「改回去就会立刻变丑」的具体形状：
   *   ① 节标题在页眉里 → 正文里**不许**再画一条同名标题（上一版连着出现两遍）；
   *   ② 导航信息进页脚 → 顶部**不许**再有那条 5 段小字的元信息带；
   *   ③ 页眉页脚是纸的两端 → 两个容器都得在。
   * 只断言「不该出现的没出现」，不锁具体像素：样式值会调，结构不该退回去。
   */
  it('版式契约：节标题只在页眉，正文不重复；顶部没有元信息行', () => {
    const src = readFileSync(join(pluginRoot, 'src/client/BookEbook.jsx'), 'utf8');
    assert.match(src, /className="npr-ebook-head"/, '页眉不见了');
    assert.match(src, /className="npr-ebook-foot"/, '页脚不见了');
    assert.doesNotMatch(src, /npr-ebook-title/, '正文里又在重复画节标题了');
    assert.doesNotMatch(src, /npr-book-meta/, '顶部那条元信息行又回来了');
  });

  /**
   * 书眉的**几何**契约（0.25.3）：这一行在任何能正常阅读的页上都得占住 34px。
   *
   * 上一版把整行挂在「有没有上级部 / 卷」上（顶层页不渲染这条横带），省下 34px 正文，
   * 代价是纸面上边沿在两种页之间来回跳 —— 翻页时整张纸会抖一下。而这一条横带本身就是
   * 纸色，空着看不出来，所以「照样占位、只是不写字」才是对的那一边。
   */
  it('书眉在任何页都占位：渲染条件里不许出现 chapterTitle', () => {
    const src = stripComments(readFileSync(join(pluginRoot, 'src/client/BookEbook.jsx'), 'utf8'));
    const at = src.indexOf('<header className="npr-ebook-head">');
    assert.ok(at > 0, '找不到页眉 —— 结构改了，这条守卫要跟着改');
    // 页眉是 `{条件 && (<header …>)}`，所以往上找最近的 `{` 就是这条表达式容器。
    const cond = src.slice(src.lastIndexOf('{', at), at);
    assert.doesNotMatch(
      cond,
      /chapterTitle/,
      '页眉又按「有没有上级章节」整行跳过 —— 纸面上沿会在顶层页和小节页之间跳 34px',
    );
    assert.match(cond, /status !== 'error'/, '页眉的渲染条件读出来是空的，守卫失效了');
  });

  /**
   * 菜单条的分工（0.25.2 用户原话）：
   *   「菜单条为什么会有解读这个按钮，打开又和目录差不多，建议去掉，解读还走目录，
   *     另外划线/笔记还是要有。」
   *
   * 三条契约，每一条都对应一个「改回去就立刻复发」的形状：
   *   ① 顶部胶囊里**没有**第二个打开章节列表的入口（解读按钮）；
   *   ② 解读的入口在**目录面板**里（`onOpenDigest`）；
   *   ③ 每个正文块都带 `data-block` —— 划线锚点靠它认「选区落在第几块」，缺一个
   *      就是「拖选了却划不出线」，而且**不会报错**。
   */
  it('菜单条：解读从目录进，划线在胶囊里；每个块都带划线锚点', () => {
    // ★ 先剥注释再数：注释里也会写 `data-block={index}`（解释这条约束的那段），
    //   不剥就会数出 8 个，然后误以为某个块重复标了锚点。
    const src = stripComments(readFileSync(join(pluginRoot, 'src/client/BookEbook.jsx'), 'utf8'));
    assert.doesNotMatch(src, /aria-pressed=\{digestOpen\}/, '顶部胶囊里又出现了解读按钮');
    assert.match(src, /<AnnotationPanel/, '划线面板没挂上');
    assert.match(src, /onOpenDigest=/, '目录面板里没有解读入口了');
    /**
     * 胶囊必须待在 `.npr-book-main` **外面**（0.25.3 用户截图：「一展开目录或划线或
     * 伴读，菜单条就会出框」）。放进 main 里的后果是跟阅读列一起被挤窄 ——
     * 而它的宽度只该跟窗口变。
     */
    const chromeAt = src.indexOf('className="npr-book-chrome"');
    const mainAt = src.indexOf('className="npr-book-main"');
    assert.ok(chromeAt > 0, '顶部没有 chrome 行：胶囊又缩进书页里了');
    assert.ok(mainAt > chromeAt, '胶囊回到 main 里了 —— 一开面板就会被挤出纸面');
    assert.doesNotMatch(src, /npr-ebook-actions/, '胶囊又变回「页眉里那排裸按钮」了');
    const blocks = src.match(/className="npr-ebook-(?:h1|h2|h3|li|quote|pre|p)"/g) ?? [];
    assert.ok(blocks.length >= 7, `只找到 ${blocks.length} 个块元素，renderBlocks 被拆坏了？`);
    assert.equal(
      (src.match(/data-block=\{index\}/g) ?? []).length, blocks.length,
      '有块元素缺 data-block —— 拖选了会划不出线，而且不报错',
    );
  });
});

/**
 * 沉浸态：胶囊滑出来这件事**不能只写在 CSS 里**（0.25.4 的真机故障）。
 *
 * 用户原话：「顶部的菜单条一旦隐藏就出不来了，为什么」。
 * 根因是热区选错了：`.npr-book-toolbar` 在宿主里是 `-webkit-app-region: drag` 的
 * 窗口拖动条，Chromium 当标题栏命中 ⇒ 页面收不到鼠标事件 ⇒ `:hover` 永不成立。
 * 探针页没有这条声明，所以「真指针悬停」在门禁里是**绿的** —— 一条假绿。
 *
 * 现在的出口是纯函数 `book-peek.js`（有 6 条单测）+ 两个阅读器各自的 `is-peek`。
 * 这里守的是**接线**：谁把这段删掉、只留 CSS，就必须红。
 */
describe('沉浸态胶囊滑出：两个阅读器都走了 is-peek', () => {
  const files = ['BookReader.jsx', 'BookEbook.jsx'];

  for (const file of files) {
    it(`${file}：指针移动 → peekNext → is-peek 三件套都在`, () => {
      const src = stripComments(readFileSync(join(pluginRoot, 'src/client', file), 'utf8'));
      assert.match(src, /from '\.\/book-peek\.js'/, '没引进 peekNext —— 就滑不回来了');
      assert.match(src, /onPointerMove=\{onPeekPointerMove\}/, '根节点没挂指针监听');
      assert.match(src, /onPointerLeave=\{onPeekPointerLeave\}/, '指针离开面板时不会复位');
      assert.match(src, /peekNext\(peek, event\.clientY - top\)/, '没用算出来的距离去判');
      assert.match(src, /is-peek/, '没有 is-peek 这个类，CSS 那三条 hover 在真机上不成立');
    });
  }

  it('refinements.css：is-peek 与 hover 在同一组里（别只留 hover）', () => {
    const css = readFileSync(join(pluginRoot, 'src/client/refinements.css'), 'utf8');
    const block = css.match(/\.npr-book\.is-immersive\.is-peek \.npr-book-chrome[\s\S]{0,400}?\{/);
    assert.ok(block, 'CSS 里没有 is-peek 的显形规则');
    const group = css.slice(css.indexOf('.npr-book.is-immersive.is-peek'));
    assert.match(group.slice(0, 600), /\.npr-book-toolbar:hover ~ \.npr-book-chrome/,
      'hover 兜底那条被删了 —— 没有 app-region 的环境（探针 / 普通浏览器）会失去滑出');
  });
});
