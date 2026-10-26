/**
 * 「正在重新生成」进度条的**真渲染**守卫（0.10.1）。
 *
 * ★ 为什么必须有这个文件
 * ----------------------
 * 0.10.0 给「更多操作」加了「重新生成译文」，让存量文章能丢掉缓存重跑。
 * 但那次只加了**入口**，忘了加**进度反馈**：
 *
 *   - `generate(kind, force)` 确实把 `selected.generating` 置上了；
 *   - 可正文区里唯一显示「生成中…」的地方在 `npr-missing` 那个分支里，
 *     而那个分支**只在 `bodyHtml` 为空（版本缺失）时**才渲染。
 *
 * ⇒ 手动重新生成一篇**已有**译文时，整个生成期间界面一动不动：旧译文照旧挂着，
 *   没有任何「正在进行」的迹象。真机实测：一篇 21k 字符的译文要跑约 4 分钟
 *   （点下去 17:25 → 写盘 17:29），用户盯着一动不动的界面，结论只能是
 *   「点了没用 / 还是老样子」—— **修复本身是好的，却因为没反馈被判成没生效。**
 *
 * ★ 为什么不写成源码字符串断言
 * ----------------------------
 * 本项目为「字符串断言给死代码发合格证」吃过亏（见 `client-runtime.test.mjs` 的注释）。
 * 「源码里写了 `<RegeneratingNotice …>`」答不了「它到底渲染出什么」。
 * 所以这里**真渲染**：用与 `build.mjs` 同配置的 esbuild 在内存里打一份产物
 * （`write: false`，不落盘），在 `node:vm` 里加载，直接调用组件的函数体拿到元素树。
 *
 * ★ 反向对照改的是**真源码**（esbuild `onLoad` 插件替换），不是另写一段假组件 ——
 *   改完若断言没变红，说明这套装置抓不到这类错，对照本身就是假的。
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
 * ★ 替换没命中就**抛错**，不许静默继续 —— 否则变异根本没生效，
 *   而「断言没变红」会被误读成「装置抓不到」。
 */
function mutateReaderPage(from, to) {
  return {
    name: 'mutate-reader-page',
    setup(build) {
      build.onLoad({ filter: /ReaderPage\.jsx$/ }, (args) => {
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

// ---- 2. 与 build.mjs 同配置地在内存里打一份产物（不落盘） --------------------

/** 从真源码打一份**只导出指定名字**的内存产物。 */
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

// ---- 3. 在假环境里真加载这份产物 --------------------------------------------

/** 假 `require`：react 给真的，宿主包给万能 Proxy。 */
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

/** 够用的假 DOM —— 被测路径不碰真 DOM，但同文件里的兄弟模块在模块作用域可能会碰。 */
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

async function loadFromReader(names, options) {
  const code = await bundleFromReader(names, options);
  const module = { exports: {} };
  const context = createContext({ ...fakeGlobals(), module, exports: module.exports, require: makeRequire() });
  runInContext(code, context, { filename: 'readerpage.cjs' });
  return module.exports;
}

async function loadNotice(options) {
  const { RegeneratingNotice } = await loadFromReader(['RegeneratingNotice'], options);
  assert.equal(typeof RegeneratingNotice, 'function', 'RegeneratingNotice 没导出 —— 装置失效');
  return RegeneratingNotice;
}

async function loadMenuLabel(options) {
  const { regenerateMenuLabel } = await loadFromReader(['regenerateMenuLabel'], options);
  assert.equal(typeof regenerateMenuLabel, 'function', 'regenerateMenuLabel 没导出 —— 装置失效');
  return regenerateMenuLabel;
}

async function loadReaderTitle(options) {
  const { readerTitle } = await loadFromReader(['readerTitle'], options);
  assert.equal(typeof readerTitle, 'function', 'readerTitle 没导出 —— 装置失效');
  return readerTitle;
}

// ---- 4. 遍历元素树（React 元素就是普通对象，不需要 DOM） --------------------

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

/** 状态条的可见文案（`<span>` 里的字符串）。
 *  ★ 必须**扁平化**：JSX 里写了 `{VERSION_LABELS[kind]}` 这类插值之后，
 *    `children` 是**数组**（`['正在重新生成', '译文', '…']`）而不是一个字符串。
 *    直接 `typeof c === 'string'` 过滤会把整条文案丢掉，读成空串。 */
function noticeText(tree) {
  return collect(tree, 'span')
    .flatMap((n) => (Array.isArray(n.props.children) ? n.props.children : [n.props.children]))
    .filter((c) => typeof c === 'string')
    .join('');
}

// ---- 5. 用例 -----------------------------------------------------------------

describe('★ 0.10.1「正在重新生成」进度条：真渲染', () => {
  it('正在重新生成译文时，渲染出一条 role=status 的状态条，文案里带「重新生成译文」', async () => {
    const Notice = await loadNotice();
    const tree = Notice({ kind: 'translation', hasBody: true });
    assert.ok(tree, '重新生成期间什么都没渲染 —— 用户还是看不出在动（这正是 0.10.0 的病）');
    assert.equal(tree.type, 'div');
    assert.equal(tree.props.role, 'status',
      '状态条没有 role=status —— 读屏器不会播报「正在生成」');
    assert.match(noticeText(tree), /重新生成译文/,
      '文案里没有「重新生成译文」—— 用户不知道在生成哪一版');
    assert.match(noticeText(tree), /几分钟/,
      '文案没有交代大概要多久 —— 一篇 21k 字符的译文实测要 4 分钟，不说用户会以为卡死');
  });

  it('状态条用的是 `npr-translating` 类 —— 转圈动画挂在 `.npr-translating svg` 上', async () => {
    const Notice = await loadNotice();
    const tree = Notice({ kind: 'translation', hasBody: true });
    assert.match(String(tree.props.className ?? ''), /npr-translating/,
      '类名不是 npr-translating —— 那条 npr-spin 转圈动画就没了，静态的一行字还是看不出在动');
  });

  it('标签跟着版本走：改写走「重新生成改写」，不写死「译文」', async () => {
    const Notice = await loadNotice();
    const text = noticeText(Notice({ kind: 'rewrite', hasBody: true }));
    assert.match(text, /重新生成改写/);
    assert.doesNotMatch(text, /重新生成译文/, '改写时也写成「译文」—— 说明标签是写死的');
  });

  it('★ 与 `npr-missing` 那条**互斥**：没有正文时不出这条（否则两条同时挂着）', async () => {
    const Notice = await loadNotice();
    assert.equal(Notice({ kind: 'translation', hasBody: false }), null,
      '没有正文时也渲染了这条 —— 它会和「这个版本还没有内容 / 生成中…」那条同时出现');
  });

  it('没在生成时什么都不渲染（默认参数下不许自己冒出来）', async () => {
    const Notice = await loadNotice();
    assert.equal(Notice({ kind: undefined, hasBody: true }), null);
    assert.equal(Notice({}), null, '不传参也渲染了东西');
  });
});

describe('★ 0.10.2「更多操作」里的重新生成条目：文案', () => {
  it('不在生成时：说清能重新生成**当前这一版**', async () => {
    const label = await loadMenuLabel();
    assert.equal(label({ active: 'translation' }), '重新生成译文');
    assert.equal(label({ active: 'rewrite' }), '重新生成改写');
  });

  it('★ 在生成时：文案跟着 `generating` 走，不是当前视图那一版', async () => {
    const label = await loadMenuLabel();
    // 在「原文」视图里重新生成「译文」—— 两者不是同一版，文案必须说「译文」。
    assert.equal(label({ active: 'original', generating: 'translation' }), '正在重新生成译文…');
    assert.equal(label({ active: 'translation', generating: 'rewrite' }), '正在重新生成改写…');
  });

  it('生成中与不在生成中，文案必须不同 —— 否则置灰了也没人知道为什么', async () => {
    const label = await loadMenuLabel();
    assert.notEqual(label({ active: 'translation', generating: 'translation' }), label({ active: 'translation' }));
  });

  it('接线：菜单项文案走 `regenerateMenuLabel`，`disabled` 跟着 `selected?.generating`', () => {
    const source = readFileSync(READER_PAGE, 'utf8');
    assert.match(source, /\{regenerateMenuLabel\(\{ active, generating: selected\?\.generating \}\)\}/,
      '菜单项没有走 regenerateMenuLabel —— 文案不会跟着生成状态变');
    assert.match(source, /disabled=\{Boolean\(selected\?\.generating\)\}/,
      '菜单项的 disabled 没接 selected?.generating —— 点了不会置灰');
  });
});

describe('★ 反向对照：文案装置真的能抓到「写死成当前视图那一版」', () => {
  it('把标签来源从 `generating` 换成 `active` 之后，必须给出错文案', async () => {
    const label = await loadMenuLabel({
      plugins: [mutateReaderPage(
        'if (generating) return `正在重新生成${VERSION_LABELS[generating]}…`;',
        'if (generating) return `正在重新生成${VERSION_LABELS[active]}…`;',
      )],
    });
    assert.notEqual(label({ active: 'original', generating: 'translation' }), '正在重新生成译文…',
      '把标签来源换掉之后仍然给出正确文案 —— 那条断言是假绿');
    assert.equal(label({ active: 'original', generating: 'translation' }), '正在重新生成原文…');
  });
});

describe('接线：ReaderPage 里真的把它挂上了（★ 存在性断言，不是可达性证明）', () => {
  /**
   * ★ 说清楚这条断言的边界：
   *   它能抓「这行被删了 / prop 接错了」，**抓不到**「它永远跑不到」。
   *   真正的行为保证在上一组真渲染用例里。项目为「字符串断言给死代码发合格证」
   *   吃过亏，所以这里只把它当**接线检查**用，不当行为证据。
   */
  const source = readFileSync(READER_PAGE, 'utf8');

  it('挂载点存在，且 kind 接 `selected?.generating`、hasBody 接正文有无', () => {
    assert.match(source, /<RegeneratingNotice\s+kind=\{selected\?\.generating\}\s+hasBody=\{Boolean\(bodyHtml\)\}\s*\/>/,
      'ReaderPage 里没把 RegeneratingNotice 挂上（或 prop 接错了）—— 组件写得再对也不会出现');
  });

  it('挂载点在正文区、`npr-missing` 那条之前', () => {
    const at = source.indexOf('<RegeneratingNotice');
    const missing = source.indexOf('className="npr-missing"');
    assert.ok(at > 0 && missing > 0, '找不到挂载点或 npr-missing 分支');
    assert.ok(at < missing, '挂载点跑到 npr-missing 后面去了 —— 两条提示的先后关系变了');
  });
});

describe('★ 反向对照：这套装置真的能抓到「进度条失效」', () => {
  it('把条件里的 `!hasBody` 去掉（互斥失效）之后，第 4 条断言必须变红', async () => {
    const Notice = await loadNotice({
      plugins: [mutateReaderPage('if (!kind || !hasBody) return null;', 'if (!kind) return null;')],
    });
    assert.notEqual(Notice({ kind: 'translation', hasBody: false }), null,
      '去掉互斥之后仍然判为「不渲染」—— 那上面那条互斥断言是假绿');
  });

  it('把组件改成恒返回 null（死代码）之后，第 1 条断言必须变红', async () => {
    const Notice = await loadNotice({
      plugins: [mutateReaderPage('if (!kind || !hasBody) return null;', 'if (true) return null;')],
    });
    assert.equal(Notice({ kind: 'translation', hasBody: true }), null,
      '组件恒返回 null 居然还能渲染出东西 —— 装置在骗人');
  });

  it('把 `npr-translating` 换成别的类之后，动画断言必须变红', async () => {
    const Notice = await loadNotice({
      plugins: [mutateReaderPage('className="npr-translating"', 'className="npr-notice-x"')],
    });
    const tree = Notice({ kind: 'translation', hasBody: true });
    assert.doesNotMatch(String(tree.props.className ?? ''), /npr-translating/,
      '换了类名却仍匹配 npr-translating —— 那条断言抓不到「动画丢了」');
  });
});

describe('★ 阅读区标题行：译文 / 改写用它们自己的中文标题', () => {
  // 2026-10-13：译文视图里标题出现**两次** —— 上面一行是订阅源的英文原标题，
  // 下面又一行是模型输出里的中文 H1。现在正文那个 H1 在生成时被去掉
  // （`withoutLeadingTitle`），标题行改读 `versions[kind].title`。
  // 不这么接的话，去掉 H1 就等于把中文标题整个丢了。
  const ZH = '生产环境中 LLM 推理的 6 种并行策略';

  it('译文视图显示译文的标题', async () => {
    const readerTitle = await loadReaderTitle();
    assert.equal(
      readerTitle({ active: 'translation', versions: { translation: { title: ZH } }, article: { title: '6 Parallelism Strategies' } }),
      ZH,
    );
  });

  it('原文视图显示文章自己的标题（订阅源自带中文时优先用它）', async () => {
    const readerTitle = await loadReaderTitle();
    assert.equal(readerTitle({ active: 'original', versions: { translation: { title: ZH } }, article: { title: 'English' } }), 'English');
    assert.equal(readerTitle({ active: 'original', article: { title: 'English', titleZh: '中文标题' } }), '中文标题');
  });

  it('版本没有标题时回退到文章标题，绝不显示空白', async () => {
    const readerTitle = await loadReaderTitle();
    for (const versions of [undefined, {}, { translation: {} }, { translation: { title: '   ' } }, { translation: { title: 42 } }]) {
      assert.equal(readerTitle({ active: 'translation', versions, article: { title: 'English' } }), 'English', JSON.stringify(versions));
    }
  });

  it('没有文章时返回空串，不炸', async () => {
    const readerTitle = await loadReaderTitle();
    assert.equal(readerTitle({ active: 'original' }), '');
  });
});

describe('★ 反向对照：标题行真的走 readerTitle', () => {
  it('把「非原文才用版本标题」这个判断去掉之后，译文视图那条断言必须变红', async () => {
    const readerTitle = await loadReaderTitle({
      plugins: [mutateReaderPage("if (active !== undefined && active !== 'original') {", 'if (false) {')],
    });
    assert.equal(
      readerTitle({ active: 'translation', versions: { translation: { title: '中文标题' } }, article: { title: 'English' } }),
      'English',
      '去掉判断之后仍然返回版本标题 —— 那上面那条断言是假绿',
    );
  });
});

describe('接线：<h1> 用的是 readerTitle 算出来的 title（★ 存在性断言，不是可达性证明）', () => {
  const source = readFileSync(READER_PAGE, 'utf8');

  it('标题行的文字来自 readerTitle', () => {
    assert.match(source, /const title = readerTitle\(\{ active, versions, article: activeArticle\?\.article \}\);/,
      'ReaderPage 里没接 readerTitle —— 译文视图会退回英文原标题');
    assert.match(source, /<h1>[\s\S]{0,300}?\{title\}[\s\S]{0,120}?<\/h1>/,
      '<h1> 里没渲染 title —— 算了却没用');
    assert.doesNotMatch(source, /<h1>[\s\S]{0,300}?titleZh \?\? activeArticle\.article\.title/,
      '<h1> 又直接读了 article.title —— 标题会绕过 readerTitle，译文标题丢失');
  });
});

// ---- 6. 0.12.2：菜单里两条「只对原文有意义」的条目 --------------------------

async function loadBusyMenuLabel(options) {
  const { busyMenuLabel } = await loadFromReader(['busyMenuLabel'], options);
  assert.equal(typeof busyMenuLabel, 'function', 'busyMenuLabel 没导出 —— 装置失效');
  return busyMenuLabel;
}

async function loadMenuVisibility(options) {
  const { menuItemVisibility } = await loadFromReader(['menuItemVisibility'], options);
  assert.equal(typeof menuItemVisibility, 'function', 'menuItemVisibility 没导出 —— 装置失效');
  return menuItemVisibility;
}

describe('★ 0.12.2「抓取原文全文 / 重新加载文章」：忙碌态文案（真跑）', () => {
  it('不在跑时用原文案；在跑时加「正在…」', async () => {
    const label = await loadBusyMenuLabel();
    assert.equal(label('抓取原文全文', false), '抓取原文全文');
    assert.equal(label('抓取原文全文', true), '正在抓取原文全文…');
    assert.equal(label('重新加载文章', false), '重新加载文章');
    assert.equal(label('重新加载文章', true), '正在重新加载文章…');
  });

  it('★ 两态文案必须不同 —— 菜单点一下就关，置灰只能靠重开菜单看见，文案是唯一的解释', async () => {
    const label = await loadBusyMenuLabel();
    for (const text of ['抓取原文全文', '重新加载文章']) {
      assert.notEqual(label(text, true), label(text, false), `${text} 的两态文案一样 —— 置灰了也没人知道为什么`);
      assert.match(label(text, true), /^正在.+…$/, `${text} 的忙碌文案形状不对：${label(text, true)}`);
    }
  });

  it('不把忙碌文案写死成某一条 —— 两条各说各的', async () => {
    const label = await loadBusyMenuLabel();
    assert.notEqual(label('抓取原文全文', true), label('重新加载文章', true));
  });
});

describe('★ 0.12.2 可见性策略：只有「原文」下才出现那两条（真跑）', () => {
  it('原文视图：两条都在，「重新生成」不在', async () => {
    const visibility = await loadMenuVisibility();
    const v = visibility({ active: 'original' });
    assert.equal(v.fetchFullText, true);
    assert.equal(v.reloadArticle, true);
    assert.equal(v.regenerate, false);
  });

  it('★ 译文 / 改写视图：两条都**不**在，「重新生成」在', async () => {
    const visibility = await loadMenuVisibility();
    for (const active of ['translation', 'rewrite']) {
      const v = visibility({ active });
      assert.equal(v.fetchFullText, false, `${active}：还显示着「抓取原文全文」`);
      assert.equal(v.reloadArticle, false, `${active}：还显示着「重新加载文章」`);
      assert.equal(v.regenerate, true, `${active}：把「重新生成」也藏了 —— 这个视图就只剩死路了`);
    }
  });

  it('★ 版本还没解析出来（`undefined` / 未知取值）时也算非原文，不冒「点了不知道会发生什么」的条目', async () => {
    const visibility = await loadMenuVisibility();
    for (const active of [undefined, null, '', 'ORIGINAL', '原文', 'unknown']) {
      const v = visibility({ active });
      assert.equal(v.fetchFullText, false, `${JSON.stringify(active)} 下冒出了「抓取原文全文」`);
      assert.equal(v.reloadArticle, false, `${JSON.stringify(active)} 下冒出了「重新加载文章」`);
    }
    const bare = visibility();
    assert.equal(bare.fetchFullText, false, '不传参就炸了 / 或把两条都放出来了');
    assert.equal(bare.reloadArticle, false);
  });

  it('★ 三条**互补**：任何版本下都恰好有一支可用（不会两条都藏，也不会同时冒出来）', async () => {
    const visibility = await loadMenuVisibility();
    for (const active of ['original', 'translation', 'rewrite', undefined, 'x']) {
      const v = visibility({ active });
      assert.equal(v.fetchFullText, v.reloadArticle, `${active}：两条原文专属条目的可见性不一致`);
      assert.notEqual(v.fetchFullText, v.regenerate, `${active}：原文专属与「重新生成」同时可见 / 同时不可见`);
    }
  });
});

// ---- 7. 接线 + 反向对照（同一条判据函数，喂变异源码必须变红）----------------

/**
 * 用**同一套判据**扫一段源码，返回所有问题（空数组 = 全绿）。
 * 抽成函数是为了让反向对照能用**完全相同的判据**去扫变异源码 ——
 * 另写一份「反向判据」等于自证。
 */
function menuWiringProblems(src) {
  const problems = [];
  const expect = (cond, message) => { if (!cond) problems.push(message); };
  expect(/const menuItems = menuItemVisibility\(\{ active \}\);/.test(src), 'ReaderPage 没调 menuItemVisibility');
  expect(/\{menuItems\.fetchFullText && \(/.test(src), '「抓取原文全文」没读 menuItems.fetchFullText');
  expect(/\{menuItems\.regenerate && \(/.test(src), '「重新生成」没读 menuItems.regenerate');
  expect(/\{menuItems\.reloadArticle && \(/.test(src), '「重新加载文章」没读 menuItems.reloadArticle');
  expect(/disabled=\{fetchingFullText\}/.test(src), '「抓取原文全文」的 disabled 没接 fetchingFullText');
  expect(/disabled=\{reloadingArticle\}/.test(src), '「重新加载文章」的 disabled 没接 reloadingArticle');
  expect(/busyMenuLabel\('抓取原文全文', fetchingFullText\)/.test(src), '「抓取原文全文」没走 busyMenuLabel');
  expect(/busyMenuLabel\('重新加载文章', reloadingArticle\)/.test(src), '「重新加载文章」没走 busyMenuLabel');
  expect(!/disabled=\{[^}]*fetchingFullText[^}]*reloadingArticle/.test(src),
    '两条的 disabled 并成了一个条件 —— 一条在跑会把另一条也锁上（用户明确要求各管各的）');
  expect(/finally \{\s*fetchingFullTextRef\.current = false;/.test(src), 'fetchFullText 没有 finally 复位');
  expect(/finally \{\s*reloadingArticleRef\.current = false;/.test(src), 'reloadArticle 没有 finally 复位');
  return problems;
}

describe('接线：ReaderPage 真的按这套策略渲染（★ 存在性断言，不是可达性证明）', () => {
  const source = readFileSync(READER_PAGE, 'utf8');

  it('三条的渲染条件都读 menuItems，disabled 各自接对了忙碌态，且都有 finally 复位', () => {
    assert.deepEqual(menuWiringProblems(source), []);
  });
});

describe('★ 反向对照：上面那套接线判据真的有牙', () => {
  const source = readFileSync(READER_PAGE, 'utf8');
  const mutate = (from, to) => {
    const next = source.replace(from, to);
    assert.notEqual(next, source, `变异没生效（锚点没命中）：${from}`);
    return next;
  };

  it('把「抓取原文全文」的条件换成「重新生成」那一支（版本条件反了）⇒ 判据必须变红', () => {
    const broken = mutate('{menuItems.fetchFullText && (', '{menuItems.regenerate && (');
    assert.ok(menuWiringProblems(broken).length > 0,
      '版本条件反了却仍然全绿 —— 那套判据抓不到「该藏的没藏」');
  });

  it('把「抓取原文全文」的 disabled 摘掉 ⇒ 判据必须变红', () => {
    const broken = mutate('disabled={fetchingFullText}', 'disabled={false}');
    assert.ok(menuWiringProblems(broken).length > 0, '摘掉 disabled 却仍然全绿 —— 抓不到「点了不置灰」');
  });

  it('把两条的 disabled 并成一个条件 ⇒ 「各自独立」那条必须变红', () => {
    const broken = mutate('disabled={reloadingArticle}', 'disabled={fetchingFullText || reloadingArticle}');
    assert.ok(menuWiringProblems(broken).length > 0, '两条被并成一个条件却仍然全绿');
  });

  it('把 busyMenuLabel 换成写死的文案 ⇒ 判据必须变红', () => {
    const broken = mutate("busyMenuLabel('抓取原文全文', fetchingFullText)", "'抓取原文全文'");
    assert.ok(menuWiringProblems(broken).length > 0, '文案写死却仍然全绿 —— 抓不到「置灰了但不说为什么」');
  });

  it('去掉 finally 复位 ⇒ 判据必须变红（否则抓取失败一次，这条就永久灰着）', () => {
    const broken = mutate('fetchingFullTextRef.current = false;', 'void 0;');
    assert.ok(menuWiringProblems(broken).length > 0, '去掉复位却仍然全绿 —— 抓不到「抛错后永久灰着」');
  });
});

describe('★ 反向对照：可见性策略的装置真的能抓到「条件反了」', () => {
  it('把 `active === \'original\'` 改成 `!==` ⇒ 原文视图那条断言必须变红', async () => {
    const visibility = await loadMenuVisibility({
      plugins: [mutateReaderPage("const original = active === 'original';", "const original = active !== 'original';")],
    });
    const v = visibility({ active: 'original' });
    assert.notEqual(v.fetchFullText, true, '条件反了却仍判「原文可见」—— 那条断言是假绿');
    assert.equal(v.fetchFullText, false);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-25：「这次只翻了一部分」必须说出来
// ---------------------------------------------------------------------------

/**
 * ★ 背景（审查发现）
 * ----------------
 * 保结构翻译逐段编号回填，模型漏掉的段落**保留英文原文**（这是对的安全底线）。
 * 宿主其实算出了覆盖率（`coverage`）并一路传到客户端 —— 然后**没有任何地方显示**。
 * 于是正文中英混排时，用户只会得出「翻译质量真差」，不会知道「只翻了 60%，再点一次就全了」。
 *
 * ★ 这一组全部**真渲染**，与上面的进度条同一套装置。
 */
async function loadPartialNotice(options) {
  const mod = await loadFromReader(['PartialTranslationNotice', 'partialTranslationHint'], options);
  assert.equal(typeof mod.PartialTranslationNotice, 'function', 'PartialTranslationNotice 没导出 —— 装置失效');
  assert.equal(typeof mod.partialTranslationHint, 'function', 'partialTranslationHint 没导出 —— 装置失效');
  return mod;
}

describe('★ 译文只翻了一部分：真渲染', () => {
  it('只翻了 6/10 ⇒ 渲染一条 role=status，文案带百分比与段数', async () => {
    const { PartialTranslationNotice } = await loadPartialNotice();
    const tree = PartialTranslationNotice({ active: 'translation', coverage: { total: 10, done: 6, ratio: 0.6 } });
    assert.ok(tree, '只翻了一半却什么都没渲染 —— 用户只会以为「翻译质量差」');
    assert.equal(tree.props.role, 'status', '没有 role=status —— 读屏器不会播报');
    const text = noticeText(tree);
    assert.match(text, /60%/, `文案里没有百分比：${text}`);
    assert.match(text, /6\/10/, '文案里没有「翻了几段 / 共几段」');
    assert.match(text, /重新生成译文/, '没有告诉用户该怎么办 —— 只说「没翻全」等于把问题丢回给他');
  });

  it('类名是 npr-translation-partial（否则没有任何样式，只是一行裸字）', async () => {
    const { PartialTranslationNotice } = await loadPartialNotice();
    const tree = PartialTranslationNotice({ active: 'translation', coverage: { total: 10, done: 3 } });
    assert.match(String(tree.props.className ?? ''), /npr-translation-partial/);
    // ★ 不许复用进度条那个类名：`.npr-translating svg` 上挂着转圈动画，
    //   用在「已经完成但没做全」的状态上，会让它看起来还在进行。
    assert.doesNotMatch(String(tree.props.className ?? ''), /npr-translating/);
  });

  it('★ 全覆盖 ⇒ 不渲染（正文本身就是证据，再挂一条是噪音）', async () => {
    const { PartialTranslationNotice } = await loadPartialNotice();
    assert.equal(PartialTranslationNotice({ active: 'translation', coverage: { total: 10, done: 10 } }), null);
  });

  it('★ 原文 / 改写视图 ⇒ 不渲染（在别的版本里提译文的事纯属干扰）', async () => {
    const { PartialTranslationNotice } = await loadPartialNotice();
    const partial = { total: 10, done: 4 };
    assert.equal(PartialTranslationNotice({ active: 'original', coverage: partial }), null);
    assert.equal(PartialTranslationNotice({ active: 'rewrite', coverage: partial }), null);
    assert.equal(PartialTranslationNotice({ coverage: partial }), null, 'active 缺失时也渲染了');
  });

  it('★ 存量译文没有 coverage ⇒ 不渲染（没有数据就闭嘴，不许拿 0 去吓人）', async () => {
    const { PartialTranslationNotice } = await loadPartialNotice();
    assert.equal(PartialTranslationNotice({ active: 'translation' }), null);
    assert.equal(PartialTranslationNotice({ active: 'translation', coverage: undefined }), null);
    assert.equal(PartialTranslationNotice({ active: 'translation', coverage: {} }), null);
    assert.equal(PartialTranslationNotice({ active: 'translation', coverage: { total: 0, done: 0 } }), null);
  });

  it('★ 一段都没翻成功时，文案要说清「正文仍是原文」并给出动作（不是干巴巴的 0%）', async () => {
    const { PartialTranslationNotice } = await loadPartialNotice();
    const text = noticeText(PartialTranslationNotice({ active: 'translation', coverage: { total: 8, done: 0 } }));
    assert.match(text, /一段都没翻成功/);
    assert.match(text, /仍是原文/);
    assert.match(text, /重新生成译文/);
    assert.doesNotMatch(text, /0%/, '说「0%」而不解释，用户会以为是翻译质量差');
  });
});

describe('★ 反向对照：覆盖率装置真的能抓到「全覆盖也报警」', () => {
  it('把 `done >= total` 改成 `done > total` ⇒ 全覆盖时也会渲染，断言必须能分辨', async () => {
    const { PartialTranslationNotice } = await loadPartialNotice({
      plugins: [mutateReaderPage('if (done >= total) return \'\';', 'if (done > total) return \'\';')],
    });
    const tree = PartialTranslationNotice({ active: 'translation', coverage: { total: 10, done: 10 } });
    assert.ok(tree, '条件改坏之后仍然不渲染 —— 那条「全覆盖不渲染」的断言是假绿');
    assert.match(noticeText(tree), /100%/, '坏实现的文案里应该是 100%');
  });
});

describe('接线：PartialTranslationNotice 真的挂上了（★ 存在性断言，不是可达性证明）', () => {
  it('挂载点接的是 `versions?.translation?.coverage`，不是 `active` 那一版', () => {
    const source = readFileSync(READER_PAGE, 'utf8');
    assert.match(
      source,
      /<PartialTranslationNotice\s+active=\{active\}\s+coverage=\{versions\?\.translation\?\.coverage\}\s*\/>/,
      'ReaderPage 里没挂 PartialTranslationNotice（或 coverage 接错了）—— 组件写得再对也不会出现',
    );
  });
});
