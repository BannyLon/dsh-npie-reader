/**
 * 浏览器半区的**执行**守卫，外加模板串完整性守卫。
 *
 * ★ 为什么必须有这个文件
 * ----------------------
 * 在它之前，659 个用例里**没有任何一个真的执行过客户端半区**：
 *   - 宿主半区有 `check-host-contract.mjs` 真的 `import()` 它；
 *   - 浏览器半区却只被「查产物里的字符串」覆盖（`test/build.test.mjs`）。
 *
 * 0.6.0 第一版正是死在这一点上：`src/client/ReaderPage.jsx` 的 `PANEL_CSS`
 * 模板串注释里出现了**未转义的反引号**，模板串提前闭合，后面那段被解析成
 * 「模板串 .npr **减去** book **减去** toolbar」这样一个**语法合法**的减法表达式。
 * 于是 esbuild 打包成功、字符串断言全绿、构建守卫也过（它不是语法错误），
 * 真机上插件一加载就 `ReferenceError: book is not defined` ⇒ **整个 DSH 桌面端起不来**
 * （启动页：`dsh-npie-reader: import failed: book is not defined`）。
 *
 * ⇒ 教训有两条，这个文件把两条都钉住：
 *   1. **字符串断言答不了「这段代码跑不跑得到 / 跑起来对不对」** —— 必须真跑；
 *   2. 同一个坑 0.5.0 踩过一次，那次是**语法错误**（构建会红），这次的形态是
 *      **语法合法的错表达式**，所以「构建能过」这道守卫**结构上**抓不到它。
 *
 * 注意本文件**不写 `lib/client.js`**：`build.test.mjs` 已经在跑真构建，
 * 两个测试文件并行再各自写同一个文件会互相读到半截产物。这里用 esbuild 的
 * `write: false` 在内存里打一份**同配置**的产物，既新鲜又不动盘。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'dsh-npie-reader';
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

// ---- 与 build.mjs 同配置地打一份客户端产物（不落盘） ------------------------

const CLIENT_BANNER = `window.__ModuleLoader__.load({
	id: "${PLUGIN_ID}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;
const CLIENT_FOOTER = `
		return module.exports;
	}
});
`;

/** 用与 build.mjs 相同的配置打包一段内存里的入口，返回产物文本。 */
async function bundleClient(entry, { stdin } = {}) {
  const result = await esbuild.build({
    ...(stdin
      ? { stdin: { contents: entry, loader: 'jsx', resolveDir: pluginRoot } }
      : { entryPoints: [entry] }),
    loader: { '.css': 'text' },
    // ★ `bundle: false` 时 esbuild 会拒绝 `external`（"Cannot use external without bundle"），
    //   所以这一段只在真打包时才给。反向对照用的那段坏代码是自包含的，不需要打包。
    bundle: !stdin,
    ...(stdin ? {} : { external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'] }),
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
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
  });
  return result.outputFiles[0].text;
}

// ---- 在假浏览器环境里真跑产物 ----------------------------------------------

/**
 * 假 `require`：任何包都返回一个万能 Proxy。
 * 产物在**模块作用域**只会做 `__toESM(require(...))` 这类绑定，不会真的调用组件，
 * 所以不需要真的 react。
 */
function stubRequire(name) {
  const make = (label) => new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === '__esModule') return true;
      if (prop === Symbol.toStringTag) return 'Module';
      return make(`${label}.${String(prop)}`);
    },
    apply: () => make(`${label}()`),
    construct: () => make(`new ${label}()`),
  });
  return make(name);
}

/** 造一个够用的假 window/document/localStorage。 */
function fakeBrowserGlobals() {
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
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    getComputedStyle: () => ({ getPropertyValue: () => '', width: '0px', height: '0px' }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 },
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    document: {
      ...el(),
      head: el(), body: el(),
      documentElement: el(),
      createElement: () => el(),
      createElementNS: () => el(),
      createTextNode: () => el(),
    },
  };
}

/**
 * 执行客户端产物：先跑顶层（捕获 ModuleLoader 注册），再调 `factory(require)`。
 *
 * 两步分开是为了让失败点可辨：**顶层抛**说明注册就坏了；**factory 抛**说明模块体坏了
 * （0.6.0 那次正是后者）。
 */
function runClientBundle(code) {
  const sandbox = fakeBrowserGlobals();
  let captured = null;
  sandbox.window = {
    __ModuleLoader__: { load(def) { captured = def; } },
  };
  sandbox.window.window = sandbox.window;
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);

  const topLevelError = (() => {
    try { runInContext(code, ctx, { filename: 'client-bundle.js' }); return null; }
    catch (error) { return error; }
  })();

  let exports = null;
  let factoryError = null;
  if (topLevelError === null && captured !== null) {
    try { exports = captured.factory(stubRequire); }
    catch (error) { factoryError = error; }
  }

  return { captured, topLevelError, factoryError, exports };
}

/** 假 ctx：只记下被注册的东西，不模拟真实插槽语义。 */
function fakeCtx() {
  const registered = [];
  const injections = [];
  let mounted = null;

  const makeChild = () => ({
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    remote: { rss: null, $mount: async (d) => { mounted = d; } },
    inject(names, cb) { injections.push(names); const child = makeChild(); cb(child); return () => {}; },
    slots: {
      inject(name, cb) { injections.push([name]); cb(); return () => {}; },
      register(def, component) { registered.push({ def, component }); return () => {}; },
    },
  });

  const root = makeChild();
  return { ctx: root, registered, injections, getMounted: () => mounted };
}

// ---- 模板串完整性：CSS 注释必须成对 ----------------------------------------

function skipQuoted(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

/** 从 `start`（一个反引号）找到配对的闭合反引号，跳过转义与 `${}` 嵌套。 */
function findTemplateEnd(source, start) {
  let i = start + 1;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (depth === 0) {
      if (ch === '`') return i;
      if (ch === '$' && source[i + 1] === '{') { depth = 1; i += 2; continue; }
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === "'" || ch === '"') { i = skipQuoted(source, i, ch); continue; }
    else if (ch === '`') { i = findTemplateEnd(source, i) + 1; continue; }
    i += 1;
  }
  return source.length;
}

/**
 * 找出源码里所有模板串。
 *
 * ★ 这里**不能**用正则找 `` = ` `` 到下一个反引号 —— 那样恰好会漏掉本文件要抓的
 *   那种情况（模板串在注释里的反引号处提前闭合，正则反而「正好」取到被截断的那一段，
 *   于是看不出问题）。所以要按 JS 的词法真的走一遍：跳过行注释 / 块注释 / 单双引号串。
 */
export function templateSpans(source) {
  const spans = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') { i = skipQuoted(source, i, ch); continue; }
    if (ch === '`') {
      const end = findTemplateEnd(source, i);
      spans.push({ start: i, end, text: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

/**
 * 报出「CSS 注释不成对」的模板串。
 *
 * ★ 判据为什么成立：本项目的 CSS 写在模板串里，注释用 CSS 语法 —— 以斜杠加星号开头、
 *   以星号加斜杠结尾。一旦模板串在注释中间被反引号提前闭合，**第一个片段就会
 *   「有开头、没有结尾」**，而那个结尾标记会留在后面被当成代码。
 *   所以「注释不成对」正是提前闭合的指纹。
 *
 * ★ 本段注释本身**绝不能出现那个两字符的结束标记**，否则会把本块注释提前闭合
 *   （写这个文件时又踩了一次）；也**不要**用零宽空格之类的不可见字符去绕 ——
 *   源码里藏不可见字符比报错更难查。直接换个说法。
 */
export function unbalancedCssComments(source) {
  const bad = [];
  for (const span of templateSpans(source)) {
    const opens = (span.text.match(/\/\*/g) ?? []).length;
    const closes = (span.text.match(/\*\//g) ?? []).length;
    // ★ 只报 `opens > closes`（**有开头、没结尾**）。
    //
    //   镜像的那一半（`closes > opens`，有结尾没开头）**刻意不报** —— 它是合法写法，
    //   本仓库就有反例：`src/range.js` 里 416 用的 `Content-Range`
    //   就是 `bytes *` + 斜杠 + `${size}`，天生带一个结束标记而没有开头。
    //   按 `opens !== closes` 报，会得到一条**假阳性**；而假阳性的代价是
    //   「下一次真出问题时没人信这条守卫」，比漏报更糟。
    //
    //   漏掉镜像那一半会不会漏掉真 bug？会漏掉「反引号出现在 `/*` **之前**」的形态 ——
    //   但那种形态逃不过同一个文件里的**执行**守卫（factory 一跑就抛）。两道一起才是完整的。
    if (opens > closes) bad.push({ ...span, opens, closes });
  }
  return bad;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const clientSources = walk(join(pluginRoot, 'src')).filter((f) => /\.(js|jsx)$/.test(f));

// ---- 用例 ------------------------------------------------------------------

const bundleText = await bundleClient(join(pluginRoot, 'src/client/index.jsx'));

describe('浏览器半区：产物真的能跑起来', () => {
  it('顶层执行不抛错，并把自己注册进 window.__ModuleLoader__', () => {
    const run = runClientBundle(bundleText);
    assert.equal(run.topLevelError, null, `顶层执行抛错：${run.topLevelError?.message}`);
    assert.notEqual(run.captured, null, '产物没有调用 window.__ModuleLoader__.load()');
    assert.equal(run.captured.id, PLUGIN_ID, 'ModuleLoader 的 id 与包名不一致');
    assert.equal(typeof run.captured.factory, 'function');
  });

  it('★ factory(require) 执行成功 —— 0.6.0 的启动崩溃就死在这一步', () => {
    const run = runClientBundle(bundleText);
    assert.equal(
      run.factoryError, null,
      `客户端模块体执行抛错：${run.factoryError?.name}: ${run.factoryError?.message}`,
    );
    for (const name of ['apply', 'inject', 'PANEL_ID']) {
      assert.ok(name in run.exports, `客户端产物没有导出 ${name}`);
    }
    // ★ 展开一下再比：产物是在 vm 的**另一个 realm** 里跑的，它造的数组与宿主里的
    //   `Array` 不是同一个构造器，`deepStrictEqual` 会报
    //   「Values have same structure but are not reference-equal」。
    assert.deepEqual([...run.exports.inject], ['slots', 'layout', 'remote']);
    assert.equal(run.exports.PANEL_ID, 'npie-reader');
  });

  it('apply(ctx) 把阅读器面板与侧栏入口都注册上了', async () => {
    const run = runClientBundle(bundleText);
    assert.equal(run.factoryError, null, `factory 先抛了：${run.factoryError?.message}`);
    const fake = fakeCtx();
    await run.exports.apply(fake.ctx);

    const names = fake.registered.map((r) => r.def.name);
    assert.ok(names.includes('main'), `没注册 main 插槽（注册了 ${names.join(', ')}）`);
    assert.ok(names.includes('sidebar.panellist'), `没注册侧栏入口（注册了 ${names.join(', ')}）`);
    const main = fake.registered.find((r) => r.def.name === 'main');
    assert.equal(main.def.key, 'npie-reader');
    assert.equal(typeof main.component, 'function');
    const side = fake.registered.find((r) => r.def.name === 'sidebar.panellist');
    assert.equal(side.def.id, 'npie-reader');
    assert.equal(side.def.order, 15);
    // Remote 命名空间也必须真的挂上去，否则界面上每个调用都会报「阅读服务未就绪」。
    assert.ok(fake.getMounted() !== null, 'ctx.remote.$mount 没有被调用');
    assert.ok(fake.getMounted().descriptors.length > 20);
  });
});

describe('模板串完整性：CSS 注释必须成对', () => {
  it('src/ 下每个模板串里的 CSS 注释都是成对的', () => {
    const offenders = [];
    for (const file of clientSources) {
      const source = readFileSync(file, 'utf8');
      for (const bad of unbalancedCssComments(source)) {
        const line = source.slice(0, bad.start).split('\n').length;
        offenders.push(`${file.replace(pluginRoot + '/', '')}:${line}（/* × ${bad.opens}，*/ × ${bad.closes}）`);
      }
    }
    assert.deepEqual(
      offenders, [],
      `模板串在注释中间被提前闭合了（反引号没转义？）—— 这会让注释后半段变成代码：\n${offenders.join('\n')}`,
    );
  });

  it('反向对照：0.6.0 真机上炸掉的那段必须被判为「有开头没结尾」', () => {
    // 逐字复刻当时的写法：模板串注释里用反引号点了 .npr-book-toolbar 的名。
    const broken = [
      'const PANEL_CSS = `',
      '/* 点名：`.npr-book-toolbar` 是书架那半边的。 */',
      '.npr-root{color:red}',
      '`;',
      'export default PANEL_CSS;',
    ].join('\n');
    const bad = unbalancedCssComments(broken);
    assert.equal(bad.length, 1, '这个检查没有抓到提前闭合的模板串 —— 那它就是假绿');
    assert.equal(bad[0].opens, 1, '被截断的那一段应当「有 /* 没有 */」');
    assert.equal(bad[0].closes, 0);
    assert.match(bad[0].text, /点名/, '报出来的应当是注释那一小段，而不是整个文件');

    // 对照一：把反引号去掉（正确的写法）必须变绿。
    const fixed = [
      'const PANEL_CSS = `',
      '/* 点名：.npr-book-toolbar 是书架那半边的。 */',
      '.npr-root{color:red}',
      '`;',
      'export default PANEL_CSS;',
    ].join('\n');
    assert.deepEqual(unbalancedCssComments(fixed), []);

    // 对照二（**假阳性对照**）：合法写法不能被误报。
    // `src/range.js` 里 416 的 Content-Range 就是这样 —— 天生一个结束标记、没有开头。
    const legit = 'export const unsatisfied = (n) => `bytes */${n}`;';
    assert.deepEqual(
      unbalancedCssComments(legit), [],
      '把合法写法误报成 bug ⇒ 下一次真出问题时没人信这条守卫',
    );
  });
});

describe('反向对照：这套执行装置真的能抓到「语法合法但运行期炸」的代码', () => {
  it('同一段坏代码经同一装置必须抛 ReferenceError: book is not defined', async () => {
    // ★ 关键点：esbuild **打得出来**（它是合法 JS），所以「构建能过」这道守卫
    //   结构上抓不到它 —— 只有真跑才能。
    const brokenText = await bundleClient([
      'const PANEL_CSS = `',
      '/* 点名：`.npr-book-toolbar` 是书架那半边的。 */',
      '.npr-root{color:red}',
      '`;',
      'export default PANEL_CSS;',
    ].join('\n'), { stdin: true });

    const run = runClientBundle(brokenText);
    assert.equal(run.topLevelError, null, '顶层不该抛（注册是好的）');
    assert.notEqual(run.factoryError, null, '坏代码居然没抛 —— 这套装置是假绿');
    assert.equal(run.factoryError.name, 'ReferenceError');
    assert.match(run.factoryError.message, /book is not defined/);

    // 同时确认：这段坏代码**构建是成功的**（产物非空）—— 这正是它危险的地方。
    assert.ok(brokenText.includes('__ModuleLoader__'));
  });
});
