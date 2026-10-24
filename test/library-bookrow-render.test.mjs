/**
 * 「弃读」那一行的**真渲染 + 真点击**守卫（0.9.4）。
 *
 * ★ 为什么必须有这个文件
 * ----------------------
 * 0.9.4 给「弃读」那一行加了第二个按钮（「+ 阅读」），并把它从「点行就能重新读」
 * 改成「点行没动作、恢复只能点按钮」。这次改动落在两处**互相看不见**的地方：
 *   - `src/library.js` 的 `bookRowView`：决定这一行有哪些动作、各叫什么；
 *   - `src/client/LibraryApp.jsx` 的 `runners`：决定每个动作点下去调用谁。
 * 两者之间只有**一个字符串**（`kind`）连着。`kind` 写错、或者 `runners` 少一个键，
 * 症状是**点了什么都不发生** —— 不抛异常、不报错、别的用例全绿。
 *
 * 在此之前 `LibraryApp.jsx` 只被**源码字符串断言**覆盖（`library-app.test.mjs`）：
 * 那些断言能证明「源码里写了 `runners[action.kind]`」，但**答不了**
 * 「`runners` 里到底有没有这个键」「这个按钮点下去真的调到那个回调了吗」——
 * 本项目为「字符串断言给死代码发合格证」吃过一次亏。
 *
 * ⇒ 这里**真跑组件**：用与 `build.mjs` 同配置的 esbuild 在内存里打一份产物
 *   （`write: false`，不落盘），在 `node:vm` 里加载，直接调用 `BookRow` 的函数体
 *   拿到元素树，再**真的调用**按钮上的 `onClick`，看哪个回调被调到了。
 *
 * ★ 不装 jsdom、不用 renderer：`BookRow` 的返回值是一棵**普通对象树**，
 *   遍历它就能拿到真实的 `props.onClick` 函数 —— 不需要真 DOM。
 *   所以这个文件跑得和别的单测一样快，却能覆盖「跑起来对不对」。
 *
 * ★ 反向对照走 esbuild 的 `onLoad` 插件**改真源码**（不是另写一段假组件）：
 *   改完之后如果断言没有变红，说明这套装置抓不到这类错，对照本身就是假的。
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
const LIBRARY_APP = join(pluginRoot, 'src/client/LibraryApp.jsx');
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

// ---- 1. 与 build.mjs 同配置地在内存里打一份产物（不落盘） --------------------

/**
 * 反向对照用：在 esbuild 读 `LibraryApp.jsx` 的时候把源码换掉。
 * ★ 替换没生效就**抛错**，不许静默继续 —— 否则对照是假绿。
 */
function mutateLibraryApp(from, to) {
  return {
    name: 'mutate-library-app',
    setup(build) {
      build.onLoad({ filter: /LibraryApp\.jsx$/ }, (args) => {
        const before = readFileSync(args.path, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) {
          throw new Error(`变异没有生效（锚点没命中）：${from}`);
        }
        return { contents, loader: 'jsx' };
      });
    },
  };
}

async function bundleBookRow({ plugins = [] } = {}) {
  const result = await esbuild.build({
    stdin: {
      contents: `export { BookRow } from ${JSON.stringify(LIBRARY_APP)};`,
      loader: 'js',
      resolveDir: pluginRoot,
    },
    plugins,
    bundle: true,
    // 宿主包在插件自己的 node_modules 里不存在，必须外置 + 桩掉；
    // react 要**真的**，因为下面要真的调用组件函数。
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

// ---- 2. 在假环境里真加载这份产物 --------------------------------------------

/**
 * 假 `require`：react 给**真的**，宿主包给万能 Proxy。
 * 产物在**模块作用域**只会做绑定，不会真的去调宿主 UI —— 那些组件不在本次被测路径上。
 */
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

/** 够用的假 DOM —— `BookRow` 本身不碰 DOM，但同文件里的兄弟模块在模块作用域可能会碰。 */
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

async function loadBookRow(options) {
  const code = await bundleBookRow(options);
  const module = { exports: {} };
  const context = createContext({ ...fakeGlobals(), module, exports: module.exports, require: makeRequire() });
  runInContext(code, context, { filename: 'bookrow.cjs' });
  const { BookRow } = module.exports;
  assert.equal(typeof BookRow, 'object', 'BookRow 没导出（或不再是 memo 包装）');
  assert.equal(typeof BookRow.type, 'function', 'memo 里面的函数拿不到 —— 装置失效');
  return BookRow.type;
}

// ---- 3. 遍历元素树（React 元素就是普通对象，不需要 DOM） --------------------

/** 收集整棵元素树里所有 `type` 为给定标签的节点。 */
function collect(node, tag, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, tag, out);
    return out;
  }
  if ('type' in node && 'props' in node) {
    if (node.type === tag) out.push(node);
    collect(node.props.children, tag, out);
  }
  return out;
}

/** 动作胶囊：`<button className="npr-bookrow-action…">`。 */
const actionButtons = (tree) => collect(tree, 'button')
  .filter((n) => typeof n.props.className === 'string' && n.props.className.includes('npr-bookrow-action'));

/** 主按钮（书名那一大块）。 */
const mainButton = (tree) => collect(tree, 'button')
  .find((n) => typeof n.props.className === 'string' && n.props.className.includes('npr-bookrow-main'));

/** 状态标签（`span`，不是按钮）。 */
const statusSpan = (tree) => collect(tree, 'span')
  .find((n) => n.props.className === 'npr-bookrow-status');

/**
 * 造一套会记账的 props，然后**真的渲染 + 真的点**。
 * ★ 四个回调分别记不同的事件名：这样「按钮上写什么」与「点下去做什么」一旦错位，
 *   记账里当场看得出来（而不是只能看出「有东西被调了」）。
 */
function renderAndClick(props, clickIndex) {
  const calls = [];
  const spies = {
    onOpen: (id) => calls.push(['open', id]),
    onToggle: (id, value) => calls.push(['toggle', id, value]),
    onDrop: (id) => calls.push(['drop', id]),
    onRestart: (id) => calls.push(['restart', id]),
  };
  const tree = props.__render({ ...props.bookProps, ...spies });
  const actions = actionButtons(tree);
  const result = { tree, actions, calls, texts: actions.map((n) => n.props.children) };
  if (typeof clickIndex === 'number') {
    const target = actions[clickIndex];
    assert.ok(target, `没有第 ${clickIndex + 1} 个动作按钮可点`);
    assert.equal(typeof target.props.onClick, 'function',
      `第 ${clickIndex + 1} 个动作按钮没有 onClick —— 点下去不会发生任何事`);
    target.props.onClick();
  }
  return result;
}

const BOOK = {
  id: 'b-pan-1', title: '长安的荔枝', ext: 'epub', size: 1234567,
  year: 2022, renderable: true, series: '',
};

/** 阅读页上的「弃读」那一行 —— 本次改动的靶子。 */
const DROPPED = { added: true, stateName: 'dropped', page: 37, pages: 210, selected: false, onReadingPage: true };

describe('★ 0.9.4「弃读」那一行：真渲染 + 真点击', () => {
  it('渲染出**两个**动作按钮，文案与顺序是「+ 阅读」「移出」', async () => {
    const render = await loadBookRow();
    const { actions, texts } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } });
    assert.equal(actions.length, 2,
      `弃读那一行渲染了 ${actions.length} 个动作按钮 —— 0.9.4 起必须是 2 个（「+ 阅读」+「移出」）`);
    assert.deepEqual(texts, ['+ 阅读', '移出']);
  });

  it('★ 点第一个按钮（「+ 阅读」）调到 `onRestart`，不是「移出」也不是「弃读」', async () => {
    const render = await loadBookRow();
    const { calls } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } }, 0);
    assert.deepEqual(calls, [['restart', BOOK.id]],
      '「+ 阅读」点下去没有调到 onRestart —— 用户点了按钮却什么都没发生');
  });

  it('★ 点第二个按钮（「移出」）调到 `onToggle(id, false)`，不是 `onRestart`', async () => {
    const render = await loadBookRow();
    const { calls } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } }, 1);
    assert.deepEqual(calls, [['toggle', BOOK.id, false]],
      '「移出」点下去没有调到 onToggle(id, false) —— 按钮名与行为对不上');
  });

  it('两个按钮点下去**不是**同一件事（各点一次，记账必须不同）', async () => {
    const render = await loadBookRow();
    const first = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } }, 0);
    const second = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } }, 1);
    assert.notDeepEqual(first.calls, second.calls,
      '两个按钮点下去做的是同一件事 —— 其中一个必然是装饰');
  });

  it('主按钮（书名）被禁用 —— 点行不许有任何动作', async () => {
    const render = await loadBookRow();
    const { tree } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } });
    const main = mainButton(tree);
    assert.ok(main, '找不到主按钮');
    assert.equal(main.props.disabled, true,
      '弃读那一行的主按钮没被禁用 —— 点书名又会把书重新翻开（用户明确要求不许）');
  });

  it('主按钮的 title 与元信息行里都有「要再读」的说明（禁用态必须当场说明原因）', async () => {
    const render = await loadBookRow();
    const { tree } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } });
    const main = mainButton(tree);
    assert.match(String(main.props.title ?? ''), /\+ 阅读/, '主按钮没有 title 说明该怎么恢复');
    const spans = collect(main, 'span').map((n) => n.props.children);
    assert.ok(spans.some((t) => typeof t === 'string' && t.includes('+ 阅读')),
      '元信息行里没有可见的恢复提示 —— disabled 元素读屏器跳过、tooltip 也不弹，等于没人看得到');
  });
});

describe('同一套装置覆盖另外两格（防止「为了修弃读把别的格子弄坏」）', () => {
  it('书架页已加入：**零个**动作按钮，那一位是状态标签「已开始阅读」', async () => {
    const render = await loadBookRow();
    const { actions, tree } = renderAndClick({
      __render: render,
      bookProps: { book: BOOK, added: true, stateName: 'reading', page: 0, pages: 0, selected: false, onReadingPage: false },
    });
    assert.equal(actions.length, 0, '书架页那一行不该有动作按钮 —— 书架只是展示');
    const status = statusSpan(tree);
    assert.ok(status, '书架页已加入时那一格不是状态标签');
    assert.equal(status.props.children, '已开始阅读');
  });

  it('读完：一个「重新阅读」，主按钮同样禁用', async () => {
    const render = await loadBookRow();
    const { actions, texts, tree } = renderAndClick({
      __render: render,
      bookProps: { book: BOOK, added: true, stateName: 'read', page: 210, pages: 210, selected: false, onReadingPage: true },
    });
    assert.deepEqual(texts, ['重新阅读']);
    assert.equal(actions.length, 1);
    assert.equal(mainButton(tree).props.disabled, true);
  });

  it('在读：一个「弃读」，主按钮**可以**点（点行就是取书阅读）', async () => {
    const render = await loadBookRow();
    const { texts, tree } = renderAndClick({
      __render: render,
      bookProps: { book: BOOK, added: true, stateName: 'reading', page: 12, pages: 210, selected: false, onReadingPage: true },
    });
    assert.deepEqual(texts, ['弃读']);
    assert.equal(mainButton(tree).props.disabled, false);
  });
});

/**
 * ★「扫描版·无文字层」这个标记必须**只在实测过且确实是扫描**时出现。
 *
 * 它不是元数据，是**结论**：抽取目录时发现整本没有文字层。所以两条反向对照都要有 ——
 *   - 没标记（没探过）⇒ 不许显示（否则 2634 本全挂一个假标签）；
 *   - 有标记 ⇒ 必须与「暂不支持阅读」分开（那本读不了，这本**读得了**）。
 */
describe('★ 书架行上的「扫描版」标记', () => {
  const scanSpan = (tree) => collect(tree, 'span')
    .find((n) => n.props.className === 'npr-bookrow-scan');

  it('实测是扫描版时，元信息行里出现「扫描版·无文字层」', async () => {
    const render = await loadBookRow();
    const { tree } = renderAndClick({
      __render: render,
      bookProps: { book: BOOK, added: true, stateName: 'reading', page: 3, pages: 197, selected: false, onReadingPage: true, scanned: true },
    });
    const span = scanSpan(tree);
    assert.ok(span, '扫描版没有标记 —— 用户下次还得再点一次「抽取目录」才知道');
    assert.equal(span.props.children, '扫描版·无文字层');
    assert.match(String(span.props.title), /阅读本身不受影响/,
      'title 没说清「书还是能读的」—— 会被读成「这本书打不开」');
  });

  it('反向对照：没探过（scanned 缺失 / false）时一个字都不出现', async () => {
    const render = await loadBookRow();
    for (const scanned of [undefined, false]) {
      const { tree } = renderAndClick({
        __render: render,
        bookProps: { book: BOOK, added: true, stateName: 'reading', page: 3, pages: 197, selected: false, onReadingPage: true, scanned },
      });
      assert.equal(scanSpan(tree), undefined, `scanned=${String(scanned)} 时仍然渲染了扫描版标记`);
    }
  });

  it('★ 扫描版 ≠ 暂不支持阅读：两者是**两个**元素，不许合并成一句', async () => {
    const render = await loadBookRow();
    const { tree } = renderAndClick({
      __render: render,
      bookProps: {
        book: { ...BOOK, renderable: false }, added: true, stateName: 'reading', page: 0, pages: 0, selected: false, onReadingPage: true, scanned: true,
      },
    });
    assert.ok(scanSpan(tree), '扫描版标记没了');
    const warn = collect(tree, 'span').find((n) => n.props.className === 'npr-bookrow-warn');
    assert.ok(warn, '「暂不支持阅读」没了 —— 两个结论被合并成一个元素');
    assert.notEqual(scanSpan(tree).props.className, warn.props.className,
      '两者共用同一个类名 —— 视觉同级会让用户读成同一件事（打不开 vs 只是没目录）');
  });
});

describe('★ 反向对照：这套装置真的能抓到「按钮接错线」', () => {
  it('把 `runners[action.kind]` 改成 `runners.drop` 之后，「移出」必须变成弃读', async () => {
    const render = await loadBookRow({
      plugins: [mutateLibraryApp('onClick={runners[action.kind]}', 'onClick={runners.drop}')],
    });
    const { calls } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } }, 1);
    assert.notDeepEqual(calls, [['toggle', BOOK.id, false]],
      '「移出」接错线之后仍然判为正确 —— 那上面那条断言是假绿');
    assert.deepEqual(calls, [['drop', BOOK.id]],
      '接错线之后的症状不是「变成弃读」—— 说明变异根本没进到被测路径里');
  });

  it('把 `view.actions.map(` 改成 `slice(0, 1).map(` 之后，动作按钮必须只剩一个', async () => {
    const render = await loadBookRow({
      plugins: [mutateLibraryApp('view.actions.map((action) => (', 'view.actions.slice(0, 1).map((action) => (')],
    });
    const { actions } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...DROPPED } });
    assert.notEqual(actions.length, 2,
      '少渲染一个按钮居然没被判红 —— 那「弃读那一行有两个按钮」随时会静默失效');
    assert.equal(actions.length, 1);
  });
});

/**
 * ★ 0.20.4：行内来源徽章 —— 用户原话是「我分不清楚哪个是本地目录下的电子书，
 *   哪个是百度网盘的电子书」。
 *
 * ★ 这里量的是**真渲染出来的元素树**，不是源码字符串。两种失效形态只有这一层能答：
 *   ① 徽章渲染了但文案是空串（等于没写）；② 调用方没传这个 prop 时冒出一个**空胶囊**
 *   （有底色、没有字，看起来像样式坏了）—— 后者正是「默认值写成空串」在守的东西。
 */
describe('★ 0.20.4 来源徽章：真渲染', () => {
  const READING = { added: true, stateName: 'reading', page: 10, pages: 210, selected: false, onReadingPage: true };

  /** 来源徽章：`span.npr-bookrow-source`（类名里还带 `is-local` / `is-pan` / `is-other`）。 */
  const sourceSpan = (tree) => collect(tree, 'span')
    .find((n) => typeof n.props.className === 'string' && n.props.className.includes('npr-bookrow-source'));

  it('传了来源 ⇒ 渲染一枚徽章，文案与 title 就是传进来的那两个串', async () => {
    const render = await loadBookRow();
    const { tree } = renderAndClick({
      __render: render,
      bookProps: {
        book: BOOK, ...READING,
        sourceLabel: '网盘 · E书拾取', sourceKind: 'pan', sourceTip: '/我的资源/长安的荔枝.epub',
      },
    });
    const badge = sourceSpan(tree);
    assert.ok(badge, '来源徽章没渲染 —— 用户还是分不清这本书来自哪个源');
    assert.equal(badge.props.children, '网盘 · E书拾取');
    assert.equal(badge.props.title, '/我的资源/长安的荔枝.epub',
      'title 不是这本书自己的路径 —— 两个同名书单时就再也分不出来了');
  });

  it('本地 / 网盘 / 其它各自一个类（「本地那本不用联网」要能一眼看出来）', async () => {
    const render = await loadBookRow();
    const clsOf = (kind) => sourceSpan(renderAndClick({
      __render: render,
      bookProps: { book: BOOK, ...READING, sourceLabel: '某个源', sourceKind: kind, sourceTip: '' },
    }).tree).props.className;
    assert.match(clsOf('local'), /is-local/);
    assert.match(clsOf('pan'), /is-pan/);
    // `external` / `legacy` 刻意共用同一档（理由见 SOURCE_CLASS 的说明）。
    assert.match(clsOf('external'), /is-other/);
    assert.notEqual(clsOf('local'), clsOf('pan'), '本地与网盘用了同一个类 —— 徽章区分不了来源');
  });

  it('★ 不传来源 ⇒ 一个徽章也不许渲染（默认值是空串，不是 undefined）', async () => {
    const render = await loadBookRow();
    const { tree } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...READING } });
    assert.equal(sourceSpan(tree), undefined,
      '没传来源也渲染了徽章 —— 2634 行每行多一个空胶囊，看起来像样式坏了');
  });

  it('★ 反向对照：把默认值去掉之后，不传来源必须冒出空胶囊', async () => {
    const render = await loadBookRow({
      plugins: [mutateLibraryApp(
        "  sourceLabel = '', sourceKind = '', sourceTip = '',",
        '  sourceLabel, sourceKind, sourceTip,',
      )],
    });
    const { tree } = renderAndClick({ __render: render, bookProps: { book: BOOK, ...READING } });
    const badge = sourceSpan(tree);
    assert.ok(badge, '去掉默认值之后仍然没有徽章 —— 那上面那条断言是假绿（`undefined !== \'\'` 没被触发）');
    assert.equal(badge.props.children, undefined, '空胶囊的文案居然不是 undefined —— 对照没落在真形态上');
  });
});
