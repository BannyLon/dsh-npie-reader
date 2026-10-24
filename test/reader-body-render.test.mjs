/**
 * 译文正文渲染：`readerBodyHtml` 的**真跑**守卫（0.13.0）。
 *
 * ★ 为什么必须有这个文件
 * ----------------------
 * 这个函数只有三个分支，但**走错哪一个都不会报错**，只会让译文「看起来有点怪」：
 *
 *   ① 新译文（`version.html`）被**再 sanitize 一次** ⇒ `sanitizeHtml` 对已转义的
 *      `&` 会再转一层（实测 `&amp;quot;` → `&amp;amp;quot;`），译文里出现可见的
 *      `&amp;` 字面量。这正是它不幂等、必须避开的原因。
 *   ② 旧译文（只有 markdown）没走 Markdown 渲染 ⇒ 整篇变成一行纯文本。
 *   ③ `active` 缺省时误判成译文 ⇒ 原文视图被换成译文。
 *
 * 这三条都靠肉眼在界面上看不出来（「有点怪」不等于「坏了」），所以这里**真跑**：
 * 内存里 esbuild 打包 → `node:vm` 加载 → 拿真函数，配**真源码的 sanitize/markdown**
 * 算期望值。
 *
 * ★ 反向对照改的是**真源码**（esbuild `onLoad` 替换，锚点没命中就抛错）：
 *   同一套判据扫两遍 —— 正面必须全过，反面必须变红。
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
import { sanitizeHtml } from '../src/host/sanitize.js';
import { markdownToHtml } from '../src/host/markdown.js';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const READER_PAGE = join(pluginRoot, 'src/client/ReaderPage.jsx');
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

// ---- 1. 反向对照用：在 esbuild 读源码时把真源码换掉 --------------------------

/** ★ 替换没命中就抛错，不许静默继续 —— 否则「没变红」会被误读成「装置抓不到」。 */
function mutateReaderPage(from, to) {
  return {
    name: 'mutate-reader-page',
    setup(build) {
      build.onLoad({ filter: /ReaderPage\.jsx$/ }, (args) => {
        const before = readFileSync(args.path, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'jsx' };
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

async function loadReaderBodyHtml(options = {}) {
  const code = await bundleFromReader(['readerBodyHtml'], options);
  const module = { exports: {} };
  const context = createContext({ ...fakeGlobals(), module, exports: module.exports, require: makeRequire() });
  runInContext(code, context, { filename: 'readerpage.cjs' });
  const { readerBodyHtml } = module.exports;
  assert.equal(typeof readerBodyHtml, 'function', 'readerBodyHtml 没导出 —— 装置失效');
  return readerBodyHtml;
}

// ---- 3. 同一套判据，正反两用 ------------------------------------------------

const BASE = 'https://example.com/post';
const RAW = '<p>Hello <a href="/a">world</a></p><p>AT&amp;T</p>';
/** 保结构译文：**生成时已经 sanitize 过**，所以里面本该是单层转义。 */
const TRANSLATED = '<p>你好 <a href="/a">世界</a></p><p>美国电话电报公司</p>';
const OLD_MARKDOWN = '# 中文标题\n\n这是正文，带一个 [链接](/a)。';

/**
 * 返回「问题清单」，空数组 = 全过。
 *
 * ★ 不用 `assert` 而是收集问题：这样同一套判据能扫**真源码**和**变异源码**两遍，
 *   反向对照才不是自证（与 `reader-status-notice.test.mjs` 的 `menuWiringProblems` 同款）。
 */
function bodyProblems(fn) {
  const problems = [];
  const expect = (cond, message) => { if (!cond) problems.push(message); };
  const doubleEscaped = (html) => (html.match(/&amp;amp;/g) || []).length;

  // ① 原文分支：必须 sanitize 一次
  const original = fn({ active: 'original', articleHtml: RAW, baseUrl: BASE });
  expect(original === sanitizeHtml(RAW, { baseUrl: BASE }), '原文分支没有按 sanitize(articleHtml) 返回');

  // ② active 缺省也要当原文（渲染早期 active 还没算出来）
  const undef = fn({ articleHtml: RAW, baseUrl: BASE });
  expect(undef === sanitizeHtml(RAW, { baseUrl: BASE }), 'active 缺省时没按原文处理');

  // ③ 新译文分支：**原样返回**，不许再 sanitize
  const structured = fn({ active: 'translation', articleHtml: RAW, version: { html: TRANSLATED }, baseUrl: BASE });
  expect(structured === TRANSLATED, '新译文分支没有原样返回 version.html');

  // ④ 关键：再 sanitize 一次就会多一层 `&` —— 这条断言专门钉住「没有多转义」
  const withEntity = '<p>他说 &amp;quot;好&amp;quot;</p>';
  const kept = fn({ active: 'translation', articleHtml: RAW, version: { html: withEntity }, baseUrl: BASE });
  expect(doubleEscaped(kept) === doubleEscaped(withEntity),
    `新译文被重复 sanitize 了：&amp;amp; 从 ${doubleEscaped(withEntity)} 变成 ${doubleEscaped(kept)}`);

  // ⑤ 旧译文分支：走 Markdown 渲染，并 sanitize 一次
  const legacy = fn({ active: 'translation', articleHtml: RAW, version: { markdown: OLD_MARKDOWN }, baseUrl: BASE });
  expect(legacy === sanitizeHtml(markdownToHtml(OLD_MARKDOWN), { baseUrl: BASE }), '旧译文分支没走 Markdown 渲染');
  // 相对路径 `/a` 必须被解析成绝对 URL —— 这条同时证明 baseUrl 真的传进去了。
  expect(legacy.includes('https://example.com/a'), '旧译文里的链接没渲染出来（或 baseUrl 没传进去）');

  // ⑥ 两个字段都在时，**保结构译文优先**
  const both = fn({ active: 'translation', articleHtml: RAW, version: { html: TRANSLATED, markdown: OLD_MARKDOWN }, baseUrl: BASE });
  expect(both === TRANSLATED, '两个字段都在时没有优先用保结构译文');

  // ⑦ 没有内容时返回空串（渲染处靠它决定显示「还没有内容」）
  expect(fn({ active: 'translation', articleHtml: RAW, version: {}, baseUrl: BASE }) === '', '没有内容时没返回空串');
  expect(fn({ active: 'translation', articleHtml: RAW, version: { markdown: '   ' }, baseUrl: BASE }) === '', '空白 markdown 没当空处理');
  expect(fn() === '', '完全没有参数时没返回空串');

  // ⑧ 改写也走同一套（它只有 markdown）
  const rewrite = fn({ active: 'rewrite', articleHtml: RAW, version: { markdown: OLD_MARKDOWN }, baseUrl: BASE });
  expect(rewrite === sanitizeHtml(markdownToHtml(OLD_MARKDOWN), { baseUrl: BASE }), '改写分支没走 Markdown 渲染');

  return problems;
}

describe('readerBodyHtml 真跑', () => {
  it('三条分支各自只 sanitize 一次，链接与实体都原样保住', async () => {
    const fn = await loadReaderBodyHtml();
    assert.deepEqual(bodyProblems(fn), []);
  });
});

describe('反向对照：改坏真源码后，同一套判据必须变红', () => {
  const mutants = [
    {
      label: '新译文分支被摘掉（会掉进 Markdown 渲染）',
      from: 'if (version?.html) return version.html;',
      to: 'if (false) return version.html;',
    },
    {
      label: '新译文被重复 sanitize（会多出一层 &amp;）',
      from: 'if (version?.html) return version.html;',
      to: 'if (version?.html) return sanitizeHtml(version.html, { baseUrl });',
    },
    {
      label: 'active 缺省不再按原文处理',
      from: "if (active === undefined || active === 'original')",
      to: "if (active === 'original')",
    },
    {
      label: '两个字段都在时错误地优先 markdown',
      from: 'if (version?.html) return version.html;',
      to: 'if (version?.html && !version?.markdown) return version.html;',
    },
  ];

  for (const mutant of mutants) {
    it(mutant.label, async () => {
      const fn = await loadReaderBodyHtml({ plugins: [mutateReaderPage(mutant.from, mutant.to)] });
      const problems = bodyProblems(fn);
      assert.ok(problems.length > 0, '变异体没被任何断言抓到 —— 这套判据是摆设');
    });
  }
});
