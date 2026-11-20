/**
 * 论文列表行的**真渲染 + 真点击**守卫（2026-11-13）。
 *
 * ★ 为什么要有这个文件
 * --------------------
 * 这一轮把行从「一个 `<button>` 装下全部」改成「`div` 里两个 `button`」，
 * 并让「读完」那一行多出一颗「重新阅读」。这类改动的失效形态全部是**静默**的：
 *   - `<button>` 里嵌 `<button>`：浏览器把 DOM 拆开，各版本拆法不同 —— 点「重新阅读」
 *     可能连带选中速读卡，也可能那颗按钮根本不在主按钮外；
 *   - 按钮画出来了但 `onClick` 没接上 —— 源码字符串断言照样全绿（本项目为
 *     「字符串断言给死代码发合格证」吃过一次亏）；
 *   - 回收站里的条目也挂上「重新阅读」—— 点一下把待删除的论文重新打开。
 * ⇒ 这里**真跑组件**：与 `build.mjs` 同配置在内存里打一份产物（不落盘），
 *   在 `node:vm` 里加载，直接调用 `PaperRow` 的函数体拿到元素树，再**真的调用**
 *   `onClick`，看哪个回调收到了什么。
 *
 * ★ 不装 jsdom：React 元素就是普通对象树，遍历它就能拿到真实的 props。
 * ★ 反向对照不另写假组件，而是用 esbuild 的 `onLoad` 插件**改真源码**：
 *   改完断言不变红，就说明这套装置抓不到这类错。
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
const PAPERS_APP = join(pluginRoot, 'src/client/PapersApp.jsx');
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

/** 反向对照：读 `PapersApp.jsx` 时把源码换掉。替换没命中就抛错 —— 假绿比红更糟。 */
function mutatePapersApp(from, to) {
  return {
    name: 'mutate-papers-app',
    setup(build) {
      build.onLoad({ filter: /PapersApp\.jsx$/ }, (args) => {
        const before = readFileSync(args.path, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'jsx' };
      });
    },
  };
}

async function bundlePaperRow({ plugins = [] } = {}) {
  const result = await esbuild.build({
    stdin: {
      contents: `export { PaperRow } from ${JSON.stringify(PAPERS_APP)};`,
      loader: 'js',
      resolveDir: pluginRoot,
    },
    plugins,
    bundle: true,
    // react 要**真的**（下面要真的调用组件函数）；宿主包在插件自己的 node_modules
    // 里不存在，一律外置 + 桩掉。
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

/** 假 `require`：react 给真的，别的给万能 Proxy（模块作用域只会做绑定，不会真调）。 */
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

/** 够用的假 DOM：`PaperRow` 不碰 DOM，但同文件里的兄弟模块在模块作用域可能会碰。 */
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
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
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

async function loadPaperRow(options) {
  const code = await bundlePaperRow(options);
  const module = { exports: {} };
  const context = createContext({ ...fakeGlobals(), module, exports: module.exports, require: makeRequire() });
  runInContext(code, context, { filename: 'paperrow.cjs' });
  const { PaperRow } = module.exports;
  assert.equal(typeof PaperRow, 'function', 'PaperRow 没导出 —— 装置失效');
  return PaperRow;
}

/** 收集元素树里所有给定标签的节点。 */
function collect(node, tag, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) collect(child, tag, out); return out; }
  if ('type' in node && 'props' in node) {
    if (node.type === tag) out.push(node);
    collect(node.props.children, tag, out);
  }
  return out;
}

const byClass = (tree, tag, part) => collect(tree, tag)
  .filter((n) => typeof n.props.className === 'string' && n.props.className.includes(part));

const PAPER_DONE = {
  id: 'p1', title: 'T', status: 'done', tags: [], file: { name: 'a.pdf', bytes: 10 },
  lastPage: 0, pages: 33, year: 2026, venue: 'arXiv 2610.1',
};
const PAPER_READING = { ...PAPER_DONE, status: 'reading' };
const STATES_DONE = { p1: { state: 'read', page: 33, pages: 33 } };
const STATES_READING = { p1: { state: 'reading', page: 3, pages: 33 } };

/**
 * 造会记账的 props，渲染，并按需点第 N 个按钮。
 *
 * ★ 桩**照抄真实调用方**的写法（`PapersApp` 里是 `(item) => setSelectedId(item.id)`）：
 *   传字符串进来时 `item?.id` 是 `undefined` ⇒ 断言当场变红。改之前这里写的是
 *   `(id) => calls.push(['select', id])`，把「传 id」当成了契约，于是真机上
 *   `setSelectedId(undefined)` 的那一版照样全绿 —— 判据与实现两套口径。
 */
function render(props, clickIndex) {
  const calls = [];
  const tree = props.__row({
    paper: props.paper, states: props.states, active: false, trash: props.trash === true,
    onSelect: (item) => calls.push(['select', item?.id]),
    onRestart: (paper) => calls.push(['restart', paper?.id]),
  });
  const buttons = collect(tree, 'button');
  if (typeof clickIndex === 'number') {
    const target = buttons[clickIndex];
    assert.ok(target, `没有第 ${clickIndex + 1} 个按钮可点`);
    assert.equal(typeof target.props.onClick, 'function', `第 ${clickIndex + 1} 个按钮没有 onClick —— 点了不会有任何事`);
    target.props.onClick();
  }
  return { tree, buttons, calls };
}

const textOf = (node) => {
  const flat = (value) => {
    if (value === null || value === undefined || value === false) return '';
    if (Array.isArray(value)) return value.map(flat).join('');
    if (typeof value === 'object' && 'props' in value) return flat(value.props.children);
    return String(value);
  };
  return flat(node.props.children);
};

describe('★ 论文行：真渲染 + 真点击', () => {
  it('读完那一行：主按钮 + 「重新阅读」，两颗都在同一层（没有按钮套按钮）', async () => {
    const PaperRow = await loadPaperRow();
    const { tree, buttons } = render({ __row: PaperRow, paper: PAPER_DONE, states: STATES_DONE });

    assert.equal(buttons.length, 2, `读完的行应有 2 颗按钮（主按钮 + 重新阅读），实际 ${buttons.length}`);
    const main = byClass(tree, 'button', 'npr-paper-row-main')[0];
    const action = byClass(tree, 'button', 'npr-paper-row-action')[0];
    assert.ok(main, '找不到主按钮（选中速读卡那一块）');
    assert.ok(action, '找不到「重新阅读」按钮');
    assert.equal(textOf(action), '重新阅读');

    // ★ 嵌套判据：主按钮的子树里不许再出现 button。嵌了之后浏览器会拆 DOM，
    //   `disabled` / `onClick` 的行为各版本不同，点了可能连带选中速读卡。
    assert.equal(collect(main, 'button').length, 1, '主按钮里还嵌着按钮 —— DOM 会被浏览器拆开');
    // 反向对照：主按钮自己也在 buttons 里（说明 collect 确实走得到，不是空集）。
    assert.ok(buttons.includes(main));
  });

  it('★ 点「重新阅读」→ onRestart；点在读那一行的主按钮 → onSelect；两者互不串台', async () => {
    const PaperRow = await loadPaperRow();
    const onAction = render({ __row: PaperRow, paper: PAPER_DONE, states: STATES_DONE }, 1);
    assert.deepEqual(onAction.calls, [['restart', 'p1']], '「重新阅读」没调到 onRestart（或顺带选中了速读卡）');

    /* ★ 用**在读**那一条点主按钮：读完的那一条主按钮是 `disabled` 的，
       在真机上点它不会有任何事 —— 拿它来验「点得开」等于验了个假。 */
    const onMain = render({ __row: PaperRow, paper: PAPER_READING, states: STATES_READING }, 0);
    assert.deepEqual(onMain.calls, [['select', 'p1']], '点主按钮没选中速读卡');
  });

  it('★ 读完的行：主按钮 `disabled` + 整行 `is-dim`；在读的行两者都没有', async () => {
    /* 用户 2026-11-13：「读完的论文不能点击论文条，灰掉，只有点击重新阅读才恢复正常」。
       ★ 这一条必须断在**真渲染出来的 props / className 上**：`paperRowView` 返回
         `openable: false` 只说明判据对，组件忘了把它接到 `disabled` 上照样能点。 */
    const PaperRow = await loadPaperRow();

    const done = render({ __row: PaperRow, paper: PAPER_DONE, states: STATES_DONE });
    const doneMain = byClass(done.tree, 'button', 'npr-paper-row-main')[0];
    assert.equal(doneMain.props.disabled, true, '读完那一行的主按钮没 disabled —— 整行还是能点');
    assert.match(String(done.tree.props.className), /is-dim/, '读完那一行没有 is-dim（不压暗就看不出区别）');

    const reading = render({ __row: PaperRow, paper: PAPER_READING, states: STATES_READING });
    const readingMain = byClass(reading.tree, 'button', 'npr-paper-row-main')[0];
    assert.ok(!readingMain.props.disabled, '在读那一行被 disabled 了 —— 用户报的正是这个');
    assert.ok(!/is-dim/.test(String(reading.tree.props.className)), '在读那一行被压暗了');

    /* 回收站里读完的条目：不压暗、不锁 —— 那边要选中才能恢复。 */
    const trash = render({ __row: PaperRow, paper: PAPER_DONE, states: STATES_DONE, trash: true });
    const trashMain = byClass(trash.tree, 'button', 'npr-paper-row-main')[0];
    assert.ok(!trashMain.props.disabled, '回收站里的行被锁死了 —— 选不中就没法「恢复」');
    assert.ok(!/is-dim/.test(String(trash.tree.props.className)));
  });

  it('★ 主按钮交给 onSelect 的是**整个 paper**，不是 id', async () => {
    /* ★ 这一条是用户报「在读的也点不动」之后补的。
       改之前 `PaperRow` 里写的是 `onSelect(paper.id)`，而调用方是
       `(item) => setSelectedId(item.id)` ⇒ `undefined`，点一下什么都不发生。
       症状看着像「按钮坏了」，其实是**两边对参数的理解不一致**；
       而前面那条 `assert.deepEqual([['select', 'p1']])` 当时是把错的契约钉住了。 */
    const PaperRow = await loadPaperRow();
    let got;
    const tree = PaperRow({
      paper: PAPER_READING, states: STATES_READING, active: false, trash: false,
      onSelect: (item) => { got = item; }, onRestart: () => {},
    });
    byClass(tree, 'button', 'npr-paper-row-main')[0].props.onClick();

    assert.equal(typeof got, 'object', `onSelect 收到的是 ${typeof got}，调用方拿它取不到 id`);
    assert.equal(got?.id, 'p1');
    // `openReader` 要读 `file` 判断有没有全文 —— 只给 id 的实现拿不到它。
    assert.equal(got?.file?.name, 'a.pdf', 'onSelect 收到的对象里没有 file，调用方无法判断有没有全文');
    assert.equal(got?.status, 'reading');
  });

  it('在读那一行：只有主按钮，没有「重新阅读」；徽章是「在读 · 3/33 页」', async () => {
    const PaperRow = await loadPaperRow();
    const { tree, buttons } = render({ __row: PaperRow, paper: PAPER_READING, states: STATES_READING });
    assert.equal(buttons.length, 1, '在读的行不该有第二颗按钮');
    const badge = byClass(tree, 'span', 'npr-paper-badge')[0];
    assert.equal(textOf(badge), '在读 · 3/33 页');
    assert.match(badge.props.className, /is-reading/);
  });

  it('读完那一行的徽章写「读完」，且不再写页码', async () => {
    const PaperRow = await loadPaperRow();
    const { tree } = render({ __row: PaperRow, paper: PAPER_DONE, states: STATES_DONE });
    const badge = byClass(tree, 'span', 'npr-paper-badge')[0];
    assert.equal(textOf(badge), '读完');
    assert.match(badge.props.className, /is-done/);
  });

  it('★ 回收站里的读完行：没有「重新阅读」（那里只该有恢复 / 彻底删除）', async () => {
    const PaperRow = await loadPaperRow();
    const { buttons } = render({ __row: PaperRow, paper: PAPER_DONE, states: STATES_DONE, trash: true });
    assert.equal(buttons.length, 1, '回收站里出现了第二颗按钮');
    assert.equal(byClass({ props: { children: buttons } }, 'button', 'npr-paper-row-action').length, 0);
  });

  it('反向对照：把 `onSelect(paper)` 改回 `onSelect(paper.id)`，契约断言必须变红', async () => {
    /* ★ 守卫本身也要有反向对照：改成传 id 之后，若这里仍然拿到对象，
       就说明上面那条断言抓不到这类错（例如它断的是别的东西）。 */
    const PaperRow = await loadPaperRow({
      plugins: [mutatePapersApp('onClick={() => onSelect(paper)}', 'onClick={() => onSelect(paper.id)}')],
    });
    let got;
    const tree = PaperRow({
      paper: PAPER_READING, states: STATES_READING, active: false, trash: false,
      onSelect: (item) => { got = item; }, onRestart: () => {},
    });
    byClass(tree, 'button', 'npr-paper-row-main')[0].props.onClick();
    assert.equal(got, 'p1', '变异之后拿到的仍是对象 ⇒ 这条装置抓不到「只传 id」');
    assert.equal(typeof got, 'string');
  });

  it('反向对照：把 `disabled={!view.openable}` 去掉，上面那条「读完不能点」必须变红', async () => {
    /* ★ 判据对、接线错，是这一轮真踩过的形态（`onSelect(paper.id)` 那次）。
       所以「有没有接到 `disabled` 上」也要有反向对照。 */
    const PaperRow = await loadPaperRow({
      plugins: [mutatePapersApp('disabled={!view.openable}', 'disabled={false}')],
    });
    const done = render({ __row: PaperRow, paper: PAPER_DONE, states: STATES_DONE });
    const main = byClass(done.tree, 'button', 'npr-paper-row-main')[0];
    assert.equal(main.props.disabled, false, '变异之后读完的行仍然 disabled ⇒ 这条装置抓不到「忘了接线」');
  });

  it('反向对照：把「重新阅读」整段去掉，本文件的断言必须变红', async () => {
    const PaperRow = await loadPaperRow({
      plugins: [mutatePapersApp('{view.action !== null && (', '{false && (')],
    });
    const { buttons } = render({ __row: PaperRow, paper: PAPER_DONE, states: STATES_DONE });
    assert.equal(buttons.length, 1, '变异之后仍然有两颗按钮 ⇒ 这套装置抓不到「按钮消失」');
  });

  it('★ 「彻底删除」先弹确认框，不直接删（0.84.7）', () => {
    // 这条走**源码口径**：删除动作在 `PapersApp` 的详情面板里，渲染它要整棵论文库
    // + 路由，成本远高于这条判据的价值。但它守的是「有没有接线」而不是「长得对不对」，
    // 接错线时字符串一定能看出来（`doDelete` 会重新出现在按钮的 onClick 上）。
    const source = readFileSync(PAPERS_APP, 'utf8');
    assert.match(source, /onClick=\{\(\) => setConfirmDelete\(true\)\}>彻底删除<\/button>/,
      '回收站的「彻底删除」没有走确认，点一下就删');
    assert.doesNotMatch(source, /onClick=\{\(\) => void doDelete\(selected\)\}>彻底删除<\/button>/,
      '「彻底删除」仍然直接执行 doDelete');
    assert.match(source, /confirmDelete && selected/, '缺少确认框的渲染条件');
    assert.match(source, /不能撤销/, '确认框没有说明「不能撤销」');
    // 反向对照：把确认改回直接删，上面第一条必须变红（证明它不是恒真式）
    const reverted = source.replace(
      'onClick={() => setConfirmDelete(true)}>彻底删除</button>',
      'onClick={() => void doDelete(selected)}>彻底删除</button>',
    );
    assert.notEqual(reverted, source, '反向对照的替换没命中 —— 锚点已经漂了');
    assert.doesNotMatch(reverted, /setConfirmDelete\(true\)\)\}>彻底删除/, '反向对照失败：改回直接删后判据仍通过');
  });
});
