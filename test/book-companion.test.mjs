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
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OCR_TIMEOUT_MS } from '../src/host/ocr.js';

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
    // ★ 0.20.5 起多了 `quote`（用户划选的那一句）；0.76.0 起多了 `kind` 与 `meta`
    //   （论文的身份）。它们**必须**在这张名单里：名单是这条断言的自检锚点，
    //   漏写等于把「两侧一致」悄悄放宽成「任意两个列表相等」。
    const KEYS = ['bookId', 'kind', 'meta', 'page', 'pages', 'quote', 'sessionId', 'text', 'title'];
    assert.deepEqual(clientKeys(), KEYS);
    assert.deepEqual(hostKeys(), KEYS);
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

  test('★ 伴读读的是自己那一套提示词：书用 book、论文用 paper（与文章那套互不影响）', () => {
    // 作用域不能再写死 'book'：论文与书共用同一个组件，写死就等于「论文拿到书的提问」。
    assert.match(bookCompanion, /readQuickPrompts\(kind\)/);
    assert.match(bookCompanion, /context\?\.kind === 'paper' \? 'paper' : 'book'/,
      'kind 的折算点被改掉了 —— 论文会退回书的措辞与提问');
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

  /**
   * ★ 0.77.1 补：**每一处 `<BookReader>` 都必须传 `onManagePrompts`**。
   *
   * 上面那条只查了 `LibraryApp`，于是论文页（`PapersApp`）漏传了整整一个版本：
   * 按钮在、`onClick` 是 `undefined`，点下去什么都不会发生 —— 用户原话
   * 「这个增加提示词的"+"图标失效。不起作用」。
   *
   * 为什么写成「扫目录 + 逐个数」：这是**跨调用点的一致性**，手写名单必然漏，
   * 而漏掉的那个恰恰是新加的那一页。`hits.length >= 2` 是防假阴性的自检 ——
   * 正则写崩导致 0 命中时，空数组比空数组永远相等，这条判据会静默变成恒真。
   */
  test('★ 每一处 <BookReader 都传了 onManagePrompts（论文页曾漏传 ⇒ 按钮点了没反应）', () => {
    const hits = [];
    for (const name of readdirSync(clientDir)) {
      if (!name.endsWith('.jsx')) continue;
      const text = readFileSync(join(clientDir, name), 'utf8');
      for (const match of text.matchAll(/<BookReader\b[\s\S]*?\/>/g)) hits.push({ name, body: match[0] });
    }
    assert.ok(hits.length >= 2,
      `只找到 ${hits.length} 处 <BookReader，扫描没生效（这条判据是空转的）`);
    const missing = hits.filter(hit => !/onManagePrompts=/.test(hit.body)).map(hit => hit.name);
    assert.deepEqual(missing, [],
      `这些调用点渲染了伴读却没传 onManagePrompts：${missing.join('、')} —— 那颗「+」会是死的`);
    // 反向对照：把 PapersApp 里那一行删掉，上面的 missing 必须变成 ['PapersApp.jsx']。
    const papersApp = readFileSync(join(clientDir, 'PapersApp.jsx'), 'utf8');
    assert.match(papersApp, /onManagePrompts=\{onManagePrompts\}/);
  });

  test('设置页「快捷提示词」分成三张卡：文章、电子书、论文各一套', () => {
    const at = settingsPage.indexOf("tab === 'prompts'");
    assert.notEqual(at, -1, '设置页找不到 prompts 页签');
    const section = settingsPage.slice(at, settingsPage.indexOf('</section>', at));
    assert.match(section, /scope="article"/);
    assert.match(section, /scope="book"/);
    // ★ 少了这张卡，论文伴读的提示词就**没有任何编辑入口** —— 面板上的「+」
    //   只会把用户送到设置页，而那里根本没有他刚点的那一套。
    assert.match(section, /scope="paper"/);
    // PromptManager 真的消费 scope（写死作用域的话这几个 prop 就是摆设）。
    assert.match(promptManager, /readQuickPrompts\(scope\)/);
    assert.match(promptManager, /saveQuickPrompts\([^)]*scope\)/);
    assert.match(promptManager, /paper:\s*\{/, 'PromptManager 缺 paper 的标题与说明');
  });
});

/**
 * 论文与电子书共用同一个伴读组件（`BookCompanion`），分叉点只有三个：
 * 措辞、提示词作用域、交给模型的上下文身份。这里钉的是**第三个**的接线，
 * 因为它是唯一会让模型「答得像在读书」的地方，而且断线时界面上毫无异常。
 */
describe('论文伴读：同一个组件，按 kind 分叉', () => {
  const library = readFileSync(join(clientDir, '..', 'library.js'), 'utf8');

  test('判据是 `book.source`，不是 `format` / `ext`', () => {
    // ★ 自建 PDF 电子书同样是 `format: 'pdf'`。用 format 分会把《干法》当成论文，
    //   于是模型对着散文讲「这一页承担什么论证」—— 而界面上一切正常。
    assert.match(bookReader, /kind: book\.source === 'paper' \? 'paper' : 'book'/);
    assert.doesNotMatch(bookReader, /kind: book\.(format|ext)[^\n]*paper/,
      '用 format/ext 判论文：自建 PDF 电子书会被误判成论文');
  });

  test('论文的 meta 只在 source === "paper" 时给，书那半边是 null', () => {
    assert.match(bookReader, /meta: book\.source === 'paper'/);
    // 反向对照：没有这条，「meta 只在论文下给」就退化成「随便给个对象也行」。
    assert.doesNotMatch(bookReader, /meta: \{[^}]*authors [^}]*\}/,
      'meta 无条件构造：书也会被当成论文带上作者字段');
  });

  test('`paperAsBook()` 把摘要带上（否则伴读只有这一页正文）', () => {
    assert.match(library, /abstract: typeof paper\.abstract === 'string' \? paper\.abstract : ''/);
  });

  test('空态措辞分叉：论文写「这篇论文」，书写「这本书」', () => {
    assert.match(bookCompanion, /与这篇论文对坐片刻/);
    assert.match(bookCompanion, /与这本书对坐片刻/);
    assert.match(bookCompanion, /isPaper \? '与这篇论文对坐片刻' : '与这本书对坐片刻'/,
      '两个文案都必须真的挂在 isPaper 上，否则其中一条是死文案');
  });

  /**
   * ★ 0.77.1 补：空态**正文**（h2 + 副句）也要分叉。
   *
   * 0.77.0 只换了上面那行小字（「与这本书对坐片刻」→「与这篇论文对坐片刻」），
   * 底下「好奇，从这一页开始」原样留给了论文。用户当场就看出来了：
   * 「好奇，从这一页开始，不适合论文阅读吧」。
   * 这不是措辞洁癖 —— 电子书是**从兴趣往下读**，论文是**带着怀疑去验**；
   * 同一句开场白放在两个场景里，其中一个必然是错的。
   *
   * 只断言「两个句子都在文件里」是不够的（那可能只是两段没接线的死文案），
   * 所以这里切出 `isPaper ? (` 到自己那个 `) : (` 之间的**论文分支**，
   * 断言书的开场白不在里面。
   */
  test('★ 空态正文也分叉：论文分支里不许留「好奇，从这一页开始」', () => {
    const start = bookCompanion.indexOf('{isPaper ? (');
    assert.notEqual(start, -1, '空态没有按 isPaper 分叉');
    const end = bookCompanion.indexOf(') : (', start);
    assert.notEqual(end, -1, '论文分支没有对应的 else 分支（分叉只做了一半）');
    const paperArm = bookCompanion.slice(start, end);
    assert.match(paperArm, /读论文，从一句追问开始/, '论文空态缺自己的开场白');
    assert.match(paperArm, /哪句话只是作者的声称/, '论文空态的副句还是书的措辞');
    assert.doesNotMatch(paperArm, /好奇，从这一页开始/, '论文分支里还留着书的开场白');
    assert.doesNotMatch(paperArm, /一个细节，一处疑问/, '论文分支里还留着书的副句');
    // 反向对照：书那半边必须**还在**（删掉书的文案同样不是「分叉」）。
    assert.match(bookCompanion, /好奇，从这一页开始/);
    assert.match(bookCompanion, /一个细节，一处疑问，或一句不同意的话/);
  });
});

/**
 * 扫描页的本地 OCR：接线与「谁优先」。
 *
 * ★ 这一组仍然是**源码文本**断言，所以它证明不了「点一下真的能认出字」。
 *   它能证明的是两类**只在真机上才暴露**的错：
 *     1. 传了 `onOcr` 却没传 `ocrNeeded` ⇒ 按钮永远不出现，功能等于没做，
 *        而源码里每一行看着都对；
 *     2. 把「文字层优先」写反 ⇒ 扫描页正常，但**有文字层的页面**会被一张
 *        更差的 OCR 结果顶掉（用户只会觉得「AI 引用的原文总是错几个字」）。
 *   第 2 类下面有一条**反向对照**：把优先级对调之后，同一条判据必须不成立。
 */
describe('扫描页 OCR：接线与优先级', () => {
  const libraryApi = readFileSync(join(clientDir, 'library-api.js'), 'utf8');

  test('BookReader → BookCompanion 的 5 个 OCR props 都显式传了', () => {
    const props = propsOf(openTagOf(bookReader, 'BookCompanion'));
    for (const name of ['onOcr', 'ocrNeeded', 'ocrUsed', 'ocrBusy', 'ocrError']) {
      assert.ok(props.has(name), `漏了 ${name} —— 面板里那一块会静默不工作`);
    }
    // 面板这一侧必须真的声明了它们（只传不接 = 白传）。
    assert.match(bookCompanion, /onOcr,\s*ocrNeeded = false,\s*ocrUsed = false,\s*ocrBusy = false,\s*ocrError = ''/);
  });

  test('★ 文字层优先：有文字层时绝不用 OCR 顶掉它', () => {
    const line = bookReader.match(/const contextText = ([^;]+);/);
    assert.notEqual(line, null, '找不到 contextText 的赋值 —— 断言失去对象');
    assert.match(line[1], /pageText\.trim\(\) !== ''\s*\?\s*pageText\s*:\s*ocrText/);

    // ★ 反向对照必须落在**真源码**上：把那一行换成对调版，同一条判据必须不成立。
    //   （早先这里写成对一个手写字面量 `swapped` 做 doesNotMatch —— 那是在断言
    //    我自己刚写的那一行，与源码无关，永远是绿的。）
    const mutated = bookReader.replace(
      /const contextText = [^;]+;/,
      "const contextText = ocrText.trim() !== '' ? ocrText : pageText;",
    );
    assert.notEqual(mutated, bookReader, '变异没生效 —— 正则没命中，这条对照是空转');
    const mutatedLine = mutated.match(/const contextText = ([^;]+);/)[1];
    assert.doesNotMatch(mutatedLine, /pageText\.trim\(\) !== ''\s*\?\s*pageText\s*:\s*ocrText/);
  });

  test('★ ocrNeeded 必须同时要求「文字层为空」与「还没识别过」', () => {
    const line = bookReader.match(/const ocrNeeded = ([^;]+);/);
    assert.notEqual(line, null, '找不到 ocrNeeded 的赋值');
    assert.match(line[1], /textLoaded/);
    assert.match(line[1], /pageText\.trim\(\) === ''/);
    assert.match(line[1], /ocrText\.trim\(\) === ''/);
    // 少了 `ocrText` 那一半：识别成功之后按钮还挂着，用户会以为没生效，反复点。
    assert.doesNotMatch(line[1].replace(/ocrText\.trim\(\) === ''/, ''), /ocrText/);
  });

  test('按钮只在 ocrNeeded 时渲染，且忙碌态同时给出 disabled 与「正在…」文案', () => {
    assert.match(bookCompanion, /\{ocrNeeded && typeof onOcr === 'function' && \(/);
    assert.match(bookCompanion, /disabled=\{ocrBusy\}/);
    // 「置灰必须配文案」：只有 disabled 没有「正在识别」，用户会以为按钮坏了。
    assert.match(bookCompanion, /ocrBusy \? '正在识别这一页…'/);
    // 失败要落在面板里（`role="alert"`），不能只弹一个会消失的提示。
    assert.match(bookCompanion, /className="npr-companion-ocr-error" role="alert"/);
  });

  test('runOcr 真的按 200 DPI 重渲染，并把 data URL 交给 ocrBookPage', () => {
    const at = bookReader.indexOf('const runOcr = useCallback(');
    assert.notEqual(at, -1, '找不到 runOcr');
    const body = callBody(bookReader, at);

    // DPI：必须走常量，而且常量不是 72（= 1:1，屏幕上那张画布只有 ~110 DPI）。
    assert.match(bookReader, /const OCR_RENDER_DPI = (\d+);/);
    const dpi = Number(bookReader.match(/const OCR_RENDER_DPI = (\d+);/)[1]);
    assert.ok(dpi >= 150, `OCR 渲染 DPI 只有 ${dpi}，正文会掉字（实测 200 是平衡点）`);
    assert.match(body, /scale: OCR_RENDER_DPI \/ 72/);

    // 必须自己填白底再渲染：透明通道叠到黑底上会一个字都认不出来。
    assert.match(body, /fillStyle = '#ffffff'/);
    assert.match(body, /fillRect\(0, 0, canvas\.width, canvas\.height\)/);
    // 送出去的必须是 data URL（宿主只认这个，见 decodeImagePayload）。
    assert.match(body, /toDataURL\('image\/jpeg'/);
    assert.match(body, /await ocrBookPage\(book\.id, page, image\)/);
  });

  test('OCR 结果只在**同一页**时才算数（翻页后立刻失效）', () => {
    assert.match(bookReader, /const ocrText = ocrState\.page === page \? ocrState\.text : '';/);
    // 反向对照：如果哪天写成「不看 page」，这条就不成立 —— 那个 bug 会让伴读
    // 拿第 60 页的识别结果回答第 61 页，而且看起来完全正常。
    assert.doesNotMatch(bookReader, /const ocrText = ocrState\.text;/);
  });

  test('客户端两个 API 都指向 /ocr，且 POST 的超时比宿主长', () => {
    assert.match(libraryApi, /fetchOcrPage[\s\S]*?`\/ocr\?bookId=\$\{encodeURIComponent\(bookId\)\}&page=\$\{Number\(page\)\}`/);
    assert.match(libraryApi, /ocrBookPage[\s\S]*?jsonRequest\('\/ocr',[\s\S]*?timeoutMs: 120_000/);

    // ★ 这条必须是**跨半区**比对（从客户端源码里把数字抠出来，与宿主常量比），
    //   写成 `assert.ok(120_000 > 60_000)` 等于在断言两个我自己刚打的字面量。
    const clientTimeout = Number(libraryApi.match(/ocrBookPage[\s\S]*?timeoutMs: ([\d_]+)/)[1].replace(/_/g, ''));
    assert.ok(
      clientTimeout > OCR_TIMEOUT_MS,
      `客户端 ${clientTimeout} ms 不比宿主 ${OCR_TIMEOUT_MS} ms 长 —— 冷启动（约 30 秒）时客户端会先断开，`
      + '表现是「第一次点识别永远失败、第二次却好了」',
    );
  });
});

/**
 * 扫描页**自动**识别（0.24.8）。
 *
 * ★ 为什么改自动：用户原话「这太麻烦了吧」——一本 387 页的扫描书让用户
 *   「翻一页点一次」是不现实的。识别是本机、免费、0.5–0.8 秒的，既然不要钱，
 *   就不该要一次点击。
 * ★ 这一组最想守住的是**hook 顺序**：`ocrNeeded` 必须声明在自动识别那个
 *   `useEffect` **之前**。依赖数组是渲染期求值的普通表达式，声明在后面就是
 *   `Cannot access 'ocrNeeded' before initialization` ⇒ 整个阅读页白屏。
 *   0.20.6 已经因为同一类问题出过一次事故（`toggleImmersive`）。
 *   `test/book-hooks-render.test.mjs` 会真渲染一次来兜住它，这里再加一条**源码顺序**
 *   断言 —— 真渲染报错时只有一句「加载失败」，看不出是哪一行。
 */
describe('扫描页 OCR：自动识别', () => {
  const autoEffectAt = bookReader.indexOf('void runOcr({ quiet: true })');

  test('★ hook 顺序：`ocrNeeded` 必须声明在自动识别的 effect 之前（否则白屏）', () => {
    assert.notEqual(autoEffectAt, -1, '找不到自动识别的 effect —— 断言失去对象');
    const neededAt = bookReader.indexOf('const ocrNeeded =');
    assert.notEqual(neededAt, -1, '找不到 ocrNeeded 的声明');
    assert.ok(
      neededAt < autoEffectAt,
      '`const ocrNeeded` 声明在 effect 之后 —— 依赖数组会在渲染期读到 TDZ，整个阅读页会白屏',
    );
  });

  test('自动识别有三道闸：伴读开着、有页要认、每页只试一次', () => {
    const at = bookReader.lastIndexOf('useEffect(', autoEffectAt);
    assert.notEqual(at, -1, '找不到自动识别的 useEffect');
    const body = callBody(bookReader, at);
    assert.match(body, /if \(!companion \|\| !ocrNeeded \|\| doc === null\) return undefined;/);
    assert.match(body, /ocrAutoTriedRef\.current\.has\(page\)/);
    assert.match(body, /ocrAutoTriedRef\.current\.add\(page\)/);
    // 延迟必须走常量，且不能是 0（翻页键按住不放会连翻十几页，每页都起子进程）。
    const delay = bookReader.match(/const OCR_AUTO_DELAY_MS = (\d+);/);
    assert.notEqual(delay, null, '找不到 OCR_AUTO_DELAY_MS');
    assert.ok(Number(delay[1]) >= 300, `延迟只有 ${delay[1]} ms，翻页途中会一路跑 OCR`);
    assert.match(body, /setTimeout\([\s\S]*OCR_AUTO_DELAY_MS\)/);
    // 清理定时器：翻到下一页时，上一页那个还没触发的必须被取消。
    assert.match(body, /clearTimeout\(timer\)/);
  });

  test('★ 自动跑的时候不许弹 toast、不许留红色错误（用户根本没点过）', () => {
    const at = bookReader.indexOf('const runOcr = useCallback(');
    const body = callBody(bookReader, at);
    // 「集合基数 + 集合内性质」写进同一条：每出现一次 setOcrError，就必须是 quiet 守卫过的。
    const all = [...body.matchAll(/setOcrError\(/g)].length;
    const guarded = [...body.matchAll(/if \(!quiet\) setOcrError\(/g)].length;
    assert.ok(all >= 3, `只找到 ${all} 处 setOcrError，runOcr 的结构可能已经变了`);
    assert.equal(guarded, all, `${all} 处 setOcrError 里只有 ${guarded} 处被 !quiet 守卫 —— 自动识别会糊用户一脸错误`);
    // notify 同理（成功时那条 toast 在自动路径上也不该出现）。
    assert.match(body, /if \(!quiet\) notify\?\./);
    assert.doesNotMatch(body, /^\s*notify\?\./m);
  });

  test('面板上的按钮走的是**手动**版（不带 quiet），失败时仍然如实报错', () => {
    const tag = openTagOf(bookReader, 'BookCompanion');
    assert.match(tag, /onOcr=\{runOcr\}/);
    assert.doesNotMatch(tag, /onOcr=\{\(\) => runOcr\(\{ quiet: true \}\)\}/);
  });
});
