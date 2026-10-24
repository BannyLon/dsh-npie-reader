/**
 * AI 伴读的**接线契约**：槽位设施怎么从阅读器页面一路传到伴读面板，
 * 以及伴读发给宿主的那几个字段名必须与宿主收的**完全一致**。
 *
 * ★ 先说清楚这个文件**证明不了什么**：它只读源码文本，所以它证明不了
 *   「伴读真的能连上」。真正的行为验证只有真机点一下。这里钉住的是两类
 *   **只在真机上暴露、而且症状离原因很远**的接线错误：
 *
 *   1. 三件槽位设施（`api` / `SessionProvider` / `renderSlot`）是**逐层手传**的
 *      （ReaderPage → LibraryApp → BookReader → BookCompanion）。中间少传一个，
 *      表现是「点『伴读』之后整块面板炸掉」，而源码里每一层看着都对。
 *   2. 客户端发给 `setBookContext` 的字段名与宿主收的名字是**两份手写的字面量**。
 *      改一边不改另一边不会报错 —— 宿主会把缺的字段当 `undefined`，而它已经
 *      被改成「缺字段就抛错」，所以这里错开的结果是「伴读一直同步失败」。
 *      这条与 `service.test.mjs` 里 `REMOTE_METHODS` 的作用是同一种：
 *      **跨半区契约**，只有交叉比对能提前抓到。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host');

const readerPage = readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8');
const libraryApp = readFileSync(join(clientDir, 'LibraryApp.jsx'), 'utf8');
const bookReader = readFileSync(join(clientDir, 'BookReader.jsx'), 'utf8');
const bookCompanion = readFileSync(join(clientDir, 'BookCompanion.jsx'), 'utf8');
const service = readFileSync(join(hostDir, 'service.js'), 'utf8');

/**
 * 取出 `<Component ...>` 的**开标签全文**（跨行、跳过 `{} [] ()` 与引号内的 `>`）。
 *
 * 与 `window-drag.test.mjs` 里的 `openTagOf` 同一套算法，只是按组件名定位。
 * 随手用「最近的 `>`」收尾会在属性里有 `=>` 或 `>` 时截断，那样「这个 prop 传了没有」
 * 就可能因为**截断**而假绿。
 */
function openTagOf(source, component) {
  const anchor = source.indexOf(`<${component}`);
  assert.notEqual(anchor, -1, `找不到 <${component} —— 断言自己失效了，先修断言`);
  let depth = 0;
  let quote = null;
  for (let i = anchor + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(anchor, i + 1);
  }
  return assert.fail(`<${component} 的开标签没有闭合`);
}

/** 一个开标签里显式传了哪些 props。 */
function propsOf(tagText) {
  return new Set([...tagText.matchAll(/(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*=/g)].map((match) => match[1]));
}

/** 从 `from` 起，取出第一个 `(` … 配对的 `)` 之间的正文。 */
function callBody(source, from) {
  const open = source.indexOf('(', from);
  assert.notEqual(open, -1, `从位置 ${from} 往后找不到 "("`);
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return assert.fail('括号没有配对');
}

describe('槽位设施逐层传到伴读面板', () => {
  const SLOT_PROPS = ['api', 'SessionProvider', 'renderSlot'];

  test('ReaderPage → LibraryApp', () => {
    const props = propsOf(openTagOf(readerPage, 'LibraryApp'));
    for (const name of SLOT_PROPS) assert.ok(props.has(name), `ReaderPage 渲染 LibraryApp 时漏了 ${name}`);
  });

  test('LibraryApp → BookReader', () => {
    const props = propsOf(openTagOf(libraryApp, 'BookReader'));
    for (const name of SLOT_PROPS) assert.ok(props.has(name), `LibraryApp 渲染 BookReader 时漏了 ${name}`);
  });

  test('BookReader → BookCompanion', () => {
    const props = propsOf(openTagOf(bookReader, 'BookCompanion'));
    for (const name of SLOT_PROPS) assert.ok(props.has(name), `BookReader 渲染 BookCompanion 时漏了 ${name}`);
  });

  test('★ 每一层都真的用上了这些 props（不只是原样转手）', () => {
    // 「传了但没接」同样是坏的：LibraryApp 的签名里没有 `api`，`<BookReader api={api}>`
    // 会因为外层没传而变成 `undefined` —— 报错信息完全指不到这里。
    assert.match(libraryApp, /export function LibraryApp\(\{[^}]*\bapi\b[^}]*\}\)/);
    assert.match(bookReader, /export function BookReader\(\{[\s\S]*?\bapi\b[\s\S]*?\}\)/);
    assert.match(bookCompanion, /export function BookCompanion\(\{[^}]*\bapi\b[^}]*\}\)/);
    // 伴读面板本身必须真的把槽位渲染出来，否则传进来的三个 props 全是摆设。
    assert.match(bookCompanion, /renderSlot\('npie-reader\.chat'/);
    assert.match(bookCompanion, /<SessionProvider session=\{chat\.reference\}>/);
  });

  test('★ 伴读用的插槽是插件自己注册过的那个名字', () => {
    // 插槽名写错 ⇒ 面板空白（不报错）。注册点在 index.jsx，两处必须是同一个字面量。
    const index = readFileSync(join(clientDir, 'index.jsx'), 'utf8');
    const used = [...bookCompanion.matchAll(/renderSlot\('([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(used)], ['npie-reader.chat']);
    for (const name of used) {
      assert.ok(index.includes(`'${name}'`), `index.jsx 里没有注册插槽 ${name}`);
      // 还要在**插槽注册表**里出现，而不只是别的字符串里出现。
      assert.ok(index.includes(`slots.register({ name: '${name}' }`), `插槽 ${name} 没有注册点`);
    }
  });
});

describe('setBookContext 的字段名跨半区一致', () => {
  /** 客户端发给宿主的那几个键。 */
  const clientKeys = () => {
    const at = bookCompanion.indexOf('api.setBookContext(');
    assert.notEqual(at, -1, 'BookCompanion 里找不到 api.setBookContext 调用');
    return [...callBody(bookCompanion, at).matchAll(/(?:^|[\s{,{])([A-Za-z_$][\w$]*)\s*:/g)]
      .map((match) => match[1]).sort();
  };

  /** 宿主从 request 上解构出来的那几个键。 */
  const hostKeys = () => {
    const at = service.indexOf('async setBookContext(');
    assert.notEqual(at, -1, 'service.js 里找不到 setBookContext');
    // 方法体第一条 `const { … } = request ?? {}` 就是那处解构。
    // ★ 别用 `callBody`：它取的是**形参**（`request`），拿到的会是空列表 ——
    //   那种假绿正是「两侧一致」这条断言最容易变成恒真式的方式。
    const start = service.indexOf('const {', at);
    assert.notEqual(start, -1, 'setBookContext 里找不到解构语句');
    const end = service.indexOf('}', start);
    assert.ok(end > start, '解构语句没有闭合');
    return service.slice(start + 'const {'.length, end)
      .split(',')
      .map((part) => part.trim().split(/[=:]/)[0].trim())
      .filter(Boolean)
      .sort();
  };

  test('客户端发的键与宿主收的键完全一致', () => {
    assert.deepEqual(clientKeys(), hostKeys());
  });

  test('★ 反向对照：判据真的在读两侧（改一个字段名就会红）', () => {
    // 没有这条，「两侧一致」可能只是两个空数组的巧合（比如两个正则都没命中）。
    // ★ 0.20.5 起多了 `quote`（用户划选的那一句）。它**必须**在这张名单里：
    //   名单是这条断言的自检锚点，漏写等于把「两侧一致」悄悄放宽成「任意两个列表相等」。
    assert.deepEqual(clientKeys(), ['bookId', 'page', 'pages', 'quote', 'sessionId', 'text', 'title']);
    assert.deepEqual(hostKeys(), ['bookId', 'page', 'pages', 'quote', 'sessionId', 'text', 'title']);
    const renamed = bookCompanion.replace('pages: context.pages,', 'pageCount: context.pages,');
    assert.notEqual(renamed, bookCompanion, '变异没生效 —— 这条反向对照是空操作');
    const at = renamed.indexOf('api.setBookContext(');
    const mutated = [...callBody(renamed, at).matchAll(/(?:^|[\s{,{])([A-Za-z_$][\w$]*)\s*:/g)]
      .map((match) => match[1]).sort();
    assert.notDeepEqual(mutated, hostKeys());
  });
});

describe('窗口拖动区：伴读面板不新增祖先', () => {
  test('伴读是 `.npr-book-main` 的子节点，不在 `.npr-book-toolbar` 的祖先链上', () => {
    // 拖动行是 `.npr-book-toolbar`。只要新加的容器是它的**兄弟**而不是祖先，
    // 就不会把拖动区做差减掉（`window-drag.test.mjs` 里那条判据管的是祖先）。
    assert.match(bookReader, /<div className="npr-book-main">/);
    const main = openTagOf(bookReader, 'div className="npr-book-main"');
    assert.doesNotMatch(main, /tabindex/i);
  });
});

describe('伴读样式与文章伴读同款（2026-10-09 用户要求）', () => {
  const refinements = readFileSync(join(clientDir, 'refinements.css'), 'utf8');
  const settingsPage = readFileSync(join(clientDir, 'SettingsPage.jsx'), 'utf8');
  const promptManager = readFileSync(join(clientDir, 'PromptManager.jsx'), 'utf8');
  const askArticle = readFileSync(join(clientDir, 'AskArticle.jsx'), 'utf8');

  test('空态开场挂在宿主对话的 hero 阶段上（与 AskArticle 同一判据）', () => {
    // 宿主对话异步挂载，一次性查询会扑空 —— 必须是 MutationObserver。
    for (const source of [askArticle, bookCompanion]) {
      assert.match(source, /data-content-phase/, '缺少空态阶段检测');
      assert.match(source, /MutationObserver/, '必须观察宿主对话的挂载');
      assert.match(source, /npr-companion-opening/, '缺少空态开场');
    }
    // 文案按场景分开：文章「与文章对坐片刻」、书「与这本书对坐片刻」。
    assert.match(askArticle, /与文章对坐片刻/);
    assert.match(bookCompanion, /与这本书对坐片刻/);
  });

  test('快捷提问挂在输入框座位上方（portal 到 data-composer-seat），不再是面板顶部一排', () => {
    assert.match(bookCompanion, /data-composer-seat/);
    assert.match(bookCompanion, /createPortal/);
    // 旧的顶部 chips 连 JSX 带 CSS 一起退场 —— 留着就是「同一件事两套 UI」。
    assert.doesNotMatch(bookCompanion, /npr-book-companion-acts/);
    assert.doesNotMatch(refinements, /npr-book-companion-acts/);
  });

  test('★ 取书期间（未 synced）开场页也在场 —— 开场页条件不挂 synced（2026-10-09 用户截图回归）', () => {
    // 开场页那一段 JSX 的渲染条件里不允许出现 `synced`：取书中 `loaded=false`
    // ⇒ `synced` 必为 false，挂了它开场页整段消失，面板只剩空白。
    const at = bookCompanion.indexOf('npr-companion-opening');
    assert.notEqual(at, -1, '缺少空态开场');
    // 取开场页前最后一段 `{... && (` 条件，断言其中没有 synced。
    const condStart = bookCompanion.slice(0, at).lastIndexOf('{emptyConversation');
    assert.ok(condStart !== -1, '找不到开场页渲染条件');
    const cond = bookCompanion.slice(condStart, at);
    assert.match(cond, /emptyConversation/);
    assert.doesNotMatch(cond, /synced/, '开场页渲染条件挂了 synced：取书期间会整段消失');
  });

  test('★ 电子书伴读读的是 book 作用域的提示词（与文章那套互不影响）', () => {
    assert.match(bookCompanion, /readQuickPrompts\('book'\)/);
    assert.match(bookCompanion, /npr-prompts-changed/, '设置页改了要即时刷新');
    // 文章伴读继续走默认作用域 + 选段改写；两边各读各的 storage。
    assert.match(askArticle, /readQuickPrompts\(\)/);
    assert.match(askArticle, /scopedQuickPrompts\(/);
    assert.doesNotMatch(bookCompanion, /scopedQuickPrompts/);
  });

  test('伴读里的「+」能打开设置页的快捷提示词：链路逐层在场', () => {
    assert.match(bookCompanion, /onManagePrompts/);
    assert.match(bookReader, /onManagePrompts=\{onManagePrompts\}/);
    assert.match(bookReader, /export function BookReader\(\{[\s\S]*?\bonManagePrompts\b[\s\S]*?\}\)/);
    // LibraryApp 持有入口并渲染 SettingsPage（与 ReaderPage 的 settingsEntry 同一模式）。
    assert.match(libraryApp, /settingsEntry/);
    assert.match(libraryApp, /<SettingsPage/);
    assert.match(libraryApp, /initialTab=\{settingsEntry\.tab\}/);
  });

  test('设置页「快捷提示词」分成两张卡：文章一套、电子书一套', () => {
    const at = settingsPage.indexOf("tab === 'prompts'");
    assert.notEqual(at, -1, '设置页找不到 prompts 页签');
    const section = settingsPage.slice(at, settingsPage.indexOf('</section>', at));
    assert.match(section, /scope="article"/);
    assert.match(section, /scope="book"/);
    // PromptManager 真的消费 scope（写死作用域的话这两个 prop 就是摆设）。
    assert.match(promptManager, /readQuickPrompts\(scope\)/);
    assert.match(promptManager, /saveQuickPrompts\([^)]*scope\)/);
  });
});
