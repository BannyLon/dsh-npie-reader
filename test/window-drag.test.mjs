/**
 * 桌面端「窗口拖动区」的契约。
 *
 * 症状一（第一次踩）：**打开阅读器面板后，窗口拖不动了。**
 * 宿主的 base.css 只给打了 `data-window-drag` 的行开拖动，而插件的面板铺满主区域
 * 却一个标记都没打 ⇒ 默认的 `none` 把窗口顶部那一条拖动几何整块挡住。
 * 修法：两条顶部工具栏自己打标记。
 *
 * 症状二（第二次踩，标记打了却仍然拖不动）：**祖先带 tabindex 就把拖动区减没了。**
 * 桌面端 base.css（从 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`
 * 里读出来的，不是猜的）与拖动有关的规则一共四条：
 *
 *   html[data-platform=darwin] [data-window-drag]{-webkit-app-region:drag}
 *   html[data-platform=darwin] [data-window-drag-recall]{-webkit-app-region:no-drag}
 *   html[data-platform=darwin] body>:not(#root){-webkit-app-region:no-drag}
 *   html[data-platform=darwin] :is(button,a,input,select,textarea,summary,
 *     [contenteditable=true],[tabindex],[role=dialog],[role=alertdialog],[role=menu],
 *     [role=listbox],[role=tooltip],[role=button],[role=link],[role=tab],
 *     [role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],
 *     [role=checkbox],[role=radio],[role=switch],[role=slider],[role=combobox],
 *     [role=textbox]){-webkit-app-region:no-drag}
 *
 * ★★ 关键语义：Chromium 先把 drag 矩形求并、再把 no-drag 矩形**求差** ——
 *    不是「命中最内层的那条」。于是**任何祖先**只要命中最后那条选择器，
 *    它的整块矩形就会把子元素的 drag 区域**整块减掉**。
 *    插件的 `.npr-root` 原本带 `tabIndex={0}` ⇒ 整块面板成为 no-drag 矩形
 *    ⇒ 两条工具栏的 `data-window-drag` 全部作废。
 *    而源码里标记一个不少、grep 全绿、打包与类型检查全过 —— 典型的假绿。
 *    所以本文件的断言不能只查「标记在不在」，必须查「祖先干不干净」。
 *
 * ★ 反向陷阱：宿主还有一个 `data-window-drag-recall`，它的规则是 `no-drag`
 *   —— **语义完全相反**（用于在 drag 子树里重新排除）。两个名字只差一个 `-recall`，
 *   打错就等于把拖动区主动关掉。所以这里把它也钉住。
 *
 * ★ 断言必须跑在**去注释后的源码**上：本文件的注释里就抄着宿主规则原文
 *   （含 `[tabindex]` 与 `-recall` 字样），直接扫原文会让 `doesNotMatch` 变红，
 *   报的是「文档写得太详细」而不是代码有错 —— 实测踩过。
 *   剥离用共用模块 `scripts/strip-comments.mjs`（它自己有单测，因为**多剥一点就会
 *   让这里的断言静默变瞎**）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as esbuild from 'esbuild';
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../scripts/strip-comments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'src', 'client');

const reader = readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8');
// 书架那半边在**另外两个文件**里（`ReaderPage` 只负责按模式二选一渲染）。
// 它们各自渲染一条拖动行，所以也必须过同一套判据 —— 只扫 ReaderPage 会让
// 「书架里新加的祖先带了 tabindex」完全测不到。
const library = readFileSync(join(clientDir, 'LibraryApp.jsx'), 'utf8');
const bookReader = readFileSync(join(clientDir, 'BookReader.jsx'), 'utf8');
// 日记（第三个 tab）是**第三个半边**：它自己渲染一整块 `npr-workarea`，
// 两条拖动行也都在它自己的文件里。不加进来，日记页「窗口拖不动」这条
// 历史故障（0.9.8 / 0.28.3 各踩一次）在新增的第三个 tab 上会**完全没有守卫**。
const diary = readFileSync(join(clientDir, 'DiaryApp.jsx'), 'utf8');

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

/** 去掉注释后的源码（CSS 注释与 JSX 花括号里的注释一并覆盖）。 */
const code = stripComments(reader);
const libraryCode = stripComments(library);
const bookCode = stripComments(bookReader);
const diaryCode = stripComments(diary);

/**
 * 宿主 `:is(...)` no-drag 选择器里的**元素名**与**属性**。
 * 诚实性由下面的「与真机 app.asar 交叉核对」保证，免得这份清单被手抄成一句空话。
 */
const NO_DRAG_TAGS = ['button', 'a', 'input', 'select', 'textarea', 'summary'];
const NO_DRAG_ATTRS = [
  'contenteditable',
  'tabindex',
  'role=dialog',
  'role=alertdialog',
  'role=menu',
  'role=listbox',
  'role=tooltip',
  'role=button',
  'role=link',
  'role=tab',
  'role=menuitem',
  'role=menuitemcheckbox',
  'role=menuitemradio',
  'role=option',
  'role=checkbox',
  'role=radio',
  'role=switch',
  'role=slider',
  'role=combobox',
  'role=textbox',
];

/**
 * 压在窗口顶部的拖动行，以及它们**必须干净**的祖先链（由内向外）。
 *
 * ★ 每条都带上是**哪个文件**里的那个 class：订阅那半边两条在 `ReaderPage.jsx`，
 *   书架那半边两条分别落在 `LibraryApp.jsx` 与 `BookReader.jsx`，日记那半边两条
 *   都在 `DiaryApp.jsx`。`openTagOf` 按源码文本定位，所以同名 class 出现在两个
 *   文件里时必须指名道姓，否则断言会去查另一个文件里的同名元素 —— 那是一条
 *   「查了但查错了地方」的假绿。
 *
 * ★ `npr-root` 只有一个（在 `ReaderPage.jsx`），三个半边共用它，所以它永远指向 `code`。
 */
const DRAG_ROWS = [
  {
    row: 'npr-sidebar-toolbar（订阅）',
    source: code,
    ancestors: [['npr-sidebar', code], ['npr-layout', code], ['npr-workarea', code], ['npr-root', code]],
  },
  {
    row: 'npr-reader-toolbar（订阅）',
    source: code,
    ancestors: [['npr-reader', code], ['npr-layout', code], ['npr-workarea', code], ['npr-root', code]],
  },
  {
    // ★ 0.28.3 补：订阅页**没选中文章**时压在窗口顶部的那条。它和上面那条是
    //   二选一渲染的（`!activeArticle ? 欢迎页 : 工具栏`），所以两条要各查一次 ——
    //   只查 `.npr-reader-toolbar` 会让「欢迎页拖不动」这个状态完全测不到，
    //   而那正是用户报的那个状态。
    row: 'npr-book-toolbar（订阅欢迎页）',
    source: code,
    ancestors: [['npr-reader', code], ['npr-layout', code], ['npr-workarea', code], ['npr-root', code]],
  },
  {
    row: 'npr-sidebar-toolbar（书架）',
    source: libraryCode,
    ancestors: [['npr-sidebar', libraryCode], ['npr-layout', libraryCode], ['npr-workarea', libraryCode], ['npr-root', code]],
  },
  {
    row: 'npr-book-toolbar（书架阅读器）',
    source: bookCode,
    ancestors: [
      ['npr-book', bookCode],
      ['npr-reader', libraryCode],
      ['npr-layout', libraryCode],
      ['npr-workarea', libraryCode],
      ['npr-root', code],
    ],
  },
  {
    // ★ 0.9.8 补：书架页**没选中书**时的欢迎页也压在窗口顶部，而上面那条
    //   `.npr-book-toolbar` 是跟着 BookReader 一起出现的 —— 于是「书架页 + 一本都
    //   没点开」这个状态下，面板右侧整块一个拖动区都没有（用户 2026-10-10 报的
    //   「这个状态下这一侧不能拖动」）。
    //   ★ 同名 class 现在出现在**两个文件**里，所以 `source` 必须指名 LibraryApp：
    //   `openTagOf` 是按源码文本定位的，指错了就会去查另一个文件里的同名元素，
    //   那是一条「查了但查错了地方」的假绿。
    row: 'npr-book-toolbar（书架欢迎页）',
    source: libraryCode,
    ancestors: [
      ['npr-reader', libraryCode],
      ['npr-layout', libraryCode],
      ['npr-workarea', libraryCode],
      ['npr-root', code],
    ],
  },
  {
    // 日记（第三个 tab）。它自己渲染一整块 `npr-workarea`，两条拖动行都在自己文件里，
    // 所以 `source` 全部指向 `diaryCode`；只有 `npr-root` 仍然是 ReaderPage 那一份。
    // ★ 左侧这一条不是「可有可无的装饰」：日记页左栏顶部的日历上方就是窗口顶部那条线，
    //   少了它，在日记页按住左上角空白处拖不动窗口。
    row: 'npr-sidebar-toolbar（日记）',
    source: diaryCode,
    ancestors: [['npr-sidebar', diaryCode], ['npr-layout', diaryCode], ['npr-workarea', diaryCode], ['npr-root', code]],
  },
  {
    // 日记右侧是**单一分支**（不像订阅/书架那样「选中 / 未选中」二选一渲染），
    // 所以一条就够。`.npr-reader` 在这里的写法是 `className="npr-reader npr-diary-reader"`,
    // `openTagOf` 的多类名回退分支会正确取到那个 `<section>`。
    row: 'npr-book-toolbar（日记）',
    source: diaryCode,
    ancestors: [['npr-reader', diaryCode], ['npr-layout', diaryCode], ['npr-workarea', diaryCode], ['npr-root', code]],
  },
];

/**
 * 把一段 JSX 开标签文本判成「会不会命中宿主 no-drag 选择器」。
 * 命中即返回原因串，干净则返回 null。
 *
 * 刻意做成**纯函数**：下面的反向对照要用同一份判据去喂「已知会坏的样本」，
 * 证明它会变红 —— 否则这条守卫只是把当前实现抄了一遍。
 */
function noDragReason(tagText) {
  const tag = /^<\s*([a-zA-Z][\w-]*)/.exec(tagText)?.[1]?.toLowerCase();
  if (tag && NO_DRAG_TAGS.includes(tag)) return `元素名 <${tag}>`;
  if (new RegExp(`(^|[\\s{"'])contenteditable(\\s*[=:]|\\s|>|$)`, 'i').test(tagText)) return '属性 contenteditable';
  if (new RegExp(`(^|[\\s{"'])tabindex(\\s*[=:]|\\s|>|$)`, 'i').test(tagText)) return '属性 tabindex';
  const role = /role\s*=\s*["']?([\w-]+)/i.exec(tagText)?.[1]?.toLowerCase();
  if (role && NO_DRAG_ATTRS.includes(`role=${role}`)) return `role="${role}"`;
  return null;
}

/**
 * 取出某个 class 所在的**开标签**全文。
 *
 * 不能用「最近的 `>`」收尾：`.npr-root` 这种开标签跨好几行、里面还有
 * `style={{ ... }}`，随手一截就会截在属性中间 —— 那么「标签里有没有 tabindex」
 * 这条断言就可能因为**截断**而假绿。所以这里按 `{} [] ()` 深度 + 引号状态扫，
 * 只认深度 0 的 `>`。
 */
function openTagOf(source, className) {
  let anchor = source.indexOf(`className="${className}"`);
  if (anchor === -1) anchor = source.indexOf(`${className}\${`); // 模板串形式：className={`${x}${y}`}
  if (anchor === -1) anchor = source.indexOf(`"${className} `); // 多类名形式：className="a b"
  assert.ok(anchor !== -1, `找不到 class="${className}" —— 断言自己失效了，先修断言`);
  const start = source.lastIndexOf('<', anchor);
  assert.ok(start !== -1, `class="${className}" 前面找不到开标签的 <`);
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return assert.fail(`class="${className}" 的开标签没有闭合`);
}

describe('窗口拖动区', () => {
  test('八条顶部工具栏都打了 data-window-drag（订阅三条 + 书架三条 + 日记两条）', () => {
    // 这两行分别是「频道 + 添加/搜索/刷新」和「版本 / 原文 + 工具图标」，都压在窗口顶部。
    assert.match(code, /className="npr-sidebar-toolbar" data-window-drag/);
    assert.match(code, /className="npr-reader-toolbar" data-window-drag/);
    // ★ 0.28.3 补：订阅页**没选中文章**时（欢迎页）右侧整块没有拖动区 ——
    //   `.npr-reader-toolbar` 是跟着选中文章一起出现的。用户 2026-10-26 报的
    //   「在 rss 阅读界面不能鼠标移动窗口」就是它。与书架欢迎页同一条 44px 的线。
    assert.match(code, /className="npr-book-toolbar" data-window-drag/);
    // 书架那半边：侧栏工具栏 + 阅读区顶部。阅读区顶部**有两条来源**，缺一不可：
    //   选中书时 BookReader 渲染它，没选中书时 LibraryApp 补一条（0.9.8）。
    //   只查 BookReader 那份会让「一本都没点开」的状态完全测不到 —— 那正是
    //   用户报「这一侧不能拖动」的那个状态。
    assert.match(libraryCode, /className="npr-sidebar-toolbar" data-window-drag/);
    assert.match(libraryCode, /className="npr-book-toolbar" data-window-drag/);
    assert.match(bookCode, /className="npr-book-toolbar" data-window-drag/);
    // 日记（第三个 tab）：左栏顶部与右侧顶部各一条。日记右侧是单一分支，
    //   所以这里两条就覆盖了全部状态（不像书架那样还要多一条欢迎页）。
    assert.match(diaryCode, /className="npr-sidebar-toolbar" data-window-drag/);
    assert.match(diaryCode, /className="npr-book-toolbar" data-window-drag/);
  });

  test('CSS 里也显式声明了 drag（不单靠宿主那条全局规则）', () => {
    // 宿主那条规则是唯一的来源；这里再写一遍是为了宿主改版时插件不会**静默**失去拖动。
    // ★ 三条行都要点名：`npr-book-toolbar` 曾经漏在外面（只靠宿主规则仍能拖，所以没有任何
    //   报错），而「三行里两行有、一行没有」读代码的人会以为那是故意的。
    assert.match(code, /\.npr-root \.npr-sidebar-toolbar,\.npr-root \.npr-reader-toolbar,\.npr-root \.npr-book-toolbar\{-webkit-app-region:drag\}/);
  });

  test('反向对照：控件仍然是 no-drag，否则点按钮会变成拖窗口', () => {
    // drag 是加在**行**上的，行里的按钮必须被排除，否则「点刷新」会拖走整个窗口。
    assert.match(code, /\.npr-root button,\.npr-root input,\.npr-root select,\.npr-root textarea\{-webkit-app-region:no-drag\}/);
  });

  test('反向对照：绝不能误用 data-window-drag-recall（那个是 no-drag）', () => {
    for (const [name, source] of [['ReaderPage', code], ['LibraryApp', libraryCode], ['BookReader', bookCode], ['DiaryApp', diaryCode]]) {
      assert.doesNotMatch(source, /data-window-drag-recall/, `${name} 里出现了 data-window-drag-recall`);
    }
  });

  test('反向对照：浮层背景不能打成拖动区（点背景要能关掉，不能拖窗口）', () => {
    const dialogs = readFileSync(join(clientDir, 'dialogs.jsx'), 'utf8');
    assert.doesNotMatch(dialogs, /data-window-drag/);
    assert.doesNotMatch(code, /npr-dialog-backdrop"[^>]*data-window-drag/);
  });
});

describe('拖动区的祖先必须干净（no-drag 矩形会被做差减掉）', () => {
  test('八条拖动行的整条祖先链都不命中宿主 no-drag 选择器', () => {
    const violations = [];
    for (const { row, source, ancestors } of DRAG_ROWS) {
      // 先确认这条行**真的在**这个文件里（否则「祖先干净」是在查一个不存在的元素）。
      assert.match(source, new RegExp(`className="${row.replace(/（.*$/, '')}" data-window-drag`), `${row} 不在预期的文件里`);
      for (const [name, sourceOfAncestor] of ancestors) {
        const reason = noDragReason(openTagOf(sourceOfAncestor, name));
        if (reason) violations.push(`${row} 的祖先 .${name} 命中 ${reason} —— 拖动区会被整块减掉`);
      }
    }
    assert.deepEqual(violations, [], `祖先链上有 no-drag 匹配项：\n${violations.join('\n')}`);
  });

  test('根节点与两个阅读区都不得带 tabindex（本次真机故障就是它）', () => {
    // 这三个是历史 / 潜在故障点：`.npr-root` 与 `.npr-reader` 都曾经带 tabIndex={0}；
    // 书架那半边是新加的，`npr-book` 是它的最内层祖先。
    assert.doesNotMatch(openTagOf(code, 'npr-root'), /tabindex/i, '.npr-root 带了 tabindex');
    assert.doesNotMatch(openTagOf(code, 'npr-reader'), /tabindex/i, '.npr-reader 带了 tabindex');
    assert.doesNotMatch(openTagOf(libraryCode, 'npr-reader'), /tabindex/i, '书架 .npr-reader 带了 tabindex');
    assert.doesNotMatch(openTagOf(bookCode, 'npr-book'), /tabindex/i, '.npr-book 带了 tabindex');
  });

  test('★ 书架与日记的文件里**一个** tabindex 都没有（新加的祖先最容易顺手带上）', () => {
    // 键盘操作在书架/日记里走 window 级监听（方向键翻页、j/k 翻页），任何容器都不需要
    // tabindex。一旦有人给列表加个 `tabIndex={0}` 想让它「可聚焦」，拖动区会整块失效，
    // 而源码里 data-window-drag 一个不少 —— 正是那种只在真机上看得出来的假绿。
    for (const [name, source] of [['LibraryApp', libraryCode], ['BookReader', bookCode], ['DiaryApp', diaryCode]]) {
      assert.equal([...source.matchAll(/tabIndex=/g)].length, 0, `${name} 里出现了 tabIndex`);
    }
  });

  test('订阅半边全文件只剩一处 tabindex，且必须在伴读分隔条上（不是拖动行的祖先）', () => {
    // 键盘快捷键走 window 级监听，任何容器都不需要靠 tabindex 拿焦点。
    // 唯一的例外是 `.npr-companion-divider`：它要用方向键调宽度，必须可聚焦。
    const hits = [...code.matchAll(/tabIndex=/g)];
    assert.equal(hits.length, 1, `tabIndex 出现了 ${hits.length} 次；除伴读分隔条外不该再有（祖先带 tabindex 会把拖动区减掉）`);
    const divider = openTagOf(code, 'npr-companion-divider');
    assert.match(divider, /tabIndex=\{0\}/, '唯一那处 tabIndex 不在伴读分隔条上');
    // 分隔条本身被宿主判成 no-drag 是**无害**的：它是一条 6px 竖条，不与任何拖动行重叠。
    assert.doesNotMatch(divider, /data-window-drag/, '分隔条既想当拖动行又想当键盘可聚焦控件，语义冲突');
  });

  test('★ 日记那两条的祖先确实是**日记自己的** DOM（多类名 / 模板串都定位对了）', () => {
    // 为什么单列一条：日记那半边有两个容易「查错地方」的坑，而查错之后断言**依然是绿的**
    // （它查到的是一段干净但无关的标签）：
    //   ① `.npr-reader` 在这里写成 `className="npr-reader npr-diary-reader"`，
    //      只有 `openTagOf` 的第三个回退分支（`"npr-reader `）能命中；
    //   ② `.npr-workarea` 是模板串 `className={`npr-workarea${...}`}`，
    //      只有第二个回退分支（`npr-workarea${`）能命中。
    // 两条都靠「取到的标签里含有**只有日记才有**的那个类名」来自证。
    assert.match(openTagOf(diaryCode, 'npr-reader'), /npr-diary-reader/, '.npr-reader 定位到的不是日记那个 section');
    assert.match(openTagOf(diaryCode, 'npr-workarea'), /npr-workarea/, 'npr-workarea 没定位到');
    // 日记的祖先链是**自己文件里的**那一份，不是订阅/书架的同名元素。
    assert.match(openTagOf(diaryCode, 'npr-sidebar'), /^<aside/, '日记的 .npr-sidebar 不是 <aside>');
    // 反向对照：同一个类名在 ReaderPage 里是另一份标签，两者不能混。
    assert.doesNotMatch(openTagOf(code, 'npr-reader'), /npr-diary-reader/, 'ReaderPage 的 .npr-reader 混进了日记的类名');
  });

  test('★ 反向对照：书架那半边的祖先链真的被判据看过（喂一个已知会坏的样本）', () => {
    // 「书架两个文件里没有 tabindex」这条断言在**当前**代码上恒真 —— 如果判据本身写错了
    // （比如扫了空串、或者 `openTagOf` 定位到了别处），它也是绿的。所以这里人为造一个
    // 带 tabindex 的书架 DOM 片段，证明同一套判据会变红。
    const broken = stripComments('<div className="npr-book" tabIndex={0}><div className="npr-book-toolbar" data-window-drag>');
    assert.equal(noDragReason(openTagOf(broken, 'npr-book')), '属性 tabindex');
    assert.match(broken, /className="npr-book-toolbar" data-window-drag/);
  });

  test('反向对照：判据本身会变红（喂已知会坏的样本）', () => {
    // 没有这条，「祖先干净」就可能是个恒真式 —— 把 bug 认证成正确行为。
    assert.equal(noDragReason('<div className="npr-root" tabIndex={0}>'), '属性 tabindex');
    assert.equal(noDragReason('<section className="npr-reader" tabIndex={0}>'), '属性 tabindex');
    assert.equal(noDragReason('<div role="menu">'), 'role="menu"');
    assert.equal(noDragReason('<div contentEditable="true">'), '属性 contenteditable');
    assert.equal(noDragReason('<button type="button">'), '元素名 <button>');
    assert.equal(noDragReason('<div className="npr-reader-toolbar" data-window-drag>'), null);
    assert.equal(noDragReason('<aside className="npr-sidebar">'), null);
    assert.equal(noDragReason('<div className="npr-book-toolbar" data-window-drag>'), null);
    assert.equal(noDragReason('<div role="separator">'), null);
  });
});

describe('no-drag 判据清单与真机 app.asar 交叉核对', () => {
  test('宿主规则里的 no-drag 匹配项与本地清单一致', (t) => {
    if (!existsSync(ASAR)) {
      t.skip(`找不到 ${ASAR}（非本机 / 未安装桌面端），跳过交叉核对`);
      return;
    }
    const text = readFileSync(ASAR, 'latin1');
    const at = text.indexOf('html[data-platform=darwin] :is(');
    assert.ok(at !== -1, '宿主 base.css 里找不到 darwin no-drag 规则 —— 规则被改写了，需要重新推导本文件的前提');
    const open = text.indexOf('(', at);
    const close = text.indexOf(')', open);
    assert.ok(open !== -1 && close > open, 'no-drag 选择器正文取不出来');
    // 属性选择器统一去掉方括号；`[contenteditable=true]` 这类带取值的归一成属性名
    // （★ 别一律砍掉 `=` 后面的部分：那会把 `[role=menu]` 砍成 `role`，清单永远对不上）。
    const hostSet = new Set(
      text.slice(open + 1, close).split(',')
        .map((part) => part.trim().toLowerCase().replace(/^\[|\]$/g, ''))
        .map((token) => (token.startsWith('contenteditable') ? 'contenteditable' : token))
        .filter(Boolean),
    );
    // 宿主把 no-drag 打在「可聚焦 / 可点」的元素上；tabindex 与 role=menu 是本次故障的关键两条。
    for (const required of ['tabindex', 'button', 'select', 'role=menu', 'role=dialog']) {
      assert.ok(hostSet.has(required), `宿主规则里没有 ${required} 了 —— 本文件的故障模型需要重新推导`);
    }
    // 本地清单里的每一条都必须能在真机规则里找到，防止清单长出宿主并不存在的判据。
    for (const attr of [...NO_DRAG_ATTRS, ...NO_DRAG_TAGS]) {
      assert.ok(hostSet.has(attr), `本地清单里的 "${attr}" 在宿主规则里不存在 —— 清单漂了`);
    }
  });
});

// ---- 4. 真渲染：书架页「一本都没点开」时那条拖动行真的在树里 ------------------
/**
 * ★ 为什么源码字符串断言不够（本项目第 N 次）：`{!selected && <div … />}`
 *   写在源码里只说明**写了**，答不了「`selected` 是 `undefined` 时这个 `&&`
 *   真的成立吗」「这个 div 真的进了元素树吗」。条件写反成 `{selected && …}`、
 *   或者被外面某个提前 `return` 挡住，字符串断言一律全绿 —— 那正是给死代码发合格证。
 *   ⇒ 所以这里**真渲染**，装置与 `library-bookrow-render.test.mjs` 同源：
 *   esbuild 在内存里打一份产物（不落盘）、`node:vm` 里加载、`react-dom/server` 真渲染。
 *
 * ★ 用 SSR 而不是像 `BookRow` 那样直接调函数体：`LibraryApp` 里全是 hooks，
 *   直接调会报 "Invalid hook call"。SSR 下 `useState` 取初值、`useEffect` 不跑
 *   ⇒ `books` 为空 ⇒ `selected` 是 `undefined` ⇒ 正好是要测的那个状态。
 *   （`fetchBooks` 之类都在 effect 里，所以不会真的发请求。）
 */
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

/** 与 build.mjs 同配置地打一份 `LibraryApp`（`write:false`，不落盘）；`mutate` 可改真源码。 */
async function bundleLibraryApp(mutate) {
  const plugins = mutate ? [{
    name: 'mutate-library-app',
    setup(build) {
      build.onLoad({ filter: /LibraryApp\.jsx$/ }, (args) => {
        const before = readFileSync(args.path, 'utf8');
        const contents = before.replace(mutate.from, mutate.to);
        // 替换没命中就**抛错**，不许静默继续 —— 否则对照是假绿。
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${mutate.from}`);
        return { contents, loader: 'jsx' };
      });
    },
  }] : [];
  const result = await esbuild.build({
    stdin: {
      contents: `export { LibraryApp } from ${JSON.stringify(join(clientDir, 'LibraryApp.jsx'))};`,
      loader: 'js',
      resolveDir: join(here, '..'),
    },
    plugins,
    bundle: true,
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

/** 假 `require`：react 给**真的**，宿主包给万能 Proxy。 */
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

/** 渲染 `LibraryApp` 并返回 HTML。`books` 空 ⇒ 未选中任何书（就是用户那个状态）。 */
async function renderLibraryApp(mutate) {
  const code = await bundleLibraryApp(mutate);
  const module = { exports: {} };
  const noop = () => {};
  const context = createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: 'node' },
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    window: { addEventListener: noop, removeEventListener: noop, localStorage: { getItem: () => null } },
    module, exports: module.exports, require: makeRequire(),
  });
  runInContext(code, context, { filename: 'library-app.cjs' });
  const { LibraryApp } = module.exports;
  assert.equal(typeof LibraryApp, 'function', 'LibraryApp 没导出 —— 装置失效');
  return renderToStaticMarkup(React.createElement(LibraryApp, {
    reading: { bookshelf: true },
    onExit: noop,
    notify: noop,
    api: {},
    SessionProvider: undefined,
    renderSlot: undefined,
  }));
}

/** 那条拖动行在 HTML 里的样子（空元素；`data-*` 的取值形式交给 `[^>]*` 兜住）。 */
const DRAG_ROW_RE = /<div class="npr-book-toolbar"[^>]*data-window-drag[^>]*><\/div>/;

describe('书架页未选中书时，阅读区那条拖动行真的渲染得出来（0.9.8）', () => {
  test('一本都没点开时，元素树里就有 `.npr-book-toolbar[data-window-drag]`', async () => {
    const html = await renderLibraryApp();
    // 先自证测的是哪个状态，再判拖动行 —— 顺序反了的话，下面那条失败时分不清
    // 是「拖动行没渲染」还是「根本渲染了别的分支」。
    assert.match(html, /class="npr-welcome"/, '渲染出来的不是欢迎页 —— 测的不是「一本都没点开」这个状态');
    assert.doesNotMatch(html, /class="npr-book"/, '渲染出了 BookReader —— 测的不是「一本都没点开」这个状态');
    assert.match(html, DRAG_ROW_RE,
      '未选中书时阅读区没有拖动行 —— 面板右侧那一整块又变成拖不动了（用户 2026-10-10 报的症状）');
  });

  test('★ 反向对照：把条件反成 `selected` 必须渲染不出来（证明这条断言有牙）', async () => {
    const html = await renderLibraryApp({
      from: '{!selected && <div className="npr-book-toolbar" data-window-drag />}',
      to: '{selected && <div className="npr-book-toolbar" data-window-drag />}',
    });
    assert.doesNotMatch(html, DRAG_ROW_RE,
      '条件反了居然还渲染出拖动行 —— 说明这条断言根本没在看那个条件（假绿）');
  });
});

/**
 * 与 build.mjs 同配置地打一份 `ReaderPage`；`mutate` 可改真源码。
 *
 * ★ `.css` 必须给 `empty` loader：`ReaderPage.jsx` 顶部 `import './refinements.css'`，
 *   不配这一项 esbuild 会以「Cannot import ... without an output path」**直接失败**
 *   （不是警告）—— 而报错长在 esbuild 内部，读起来跟本测试毫无关系。
 */
async function bundleReaderPage(mutate) {
  const plugins = mutate ? [{
    name: 'mutate-reader-page',
    setup(build) {
      build.onLoad({ filter: /ReaderPage\.jsx$/ }, (args) => {
        const before = readFileSync(args.path, 'utf8');
        const contents = before.replace(mutate.from, mutate.to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${mutate.from}`);
        return { contents, loader: 'jsx' };
      });
    },
  }] : [];
  const result = await esbuild.build({
    stdin: {
      contents: `export { ReaderPage } from ${JSON.stringify(join(clientDir, 'ReaderPage.jsx'))};`,
      loader: 'js',
      resolveDir: join(here, '..'),
    },
    plugins,
    bundle: true,
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
    platform: 'browser',
    loader: { '.css': 'empty' },
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

/** 渲染 `ReaderPage` 并返回 HTML。SSR 下 effect 不跑、`selected` 为空 ⇒ 正好是欢迎页。 */
async function renderReaderPage(mutate) {
  const code = await bundleReaderPage(mutate);
  const module = { exports: {} };
  const noop = () => {};
  const context = createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: 'node' },
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    window: {
      addEventListener: noop,
      removeEventListener: noop,
      localStorage: { getItem: () => null },
      matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    },
    document: { addEventListener: noop, removeEventListener: noop, documentElement: { dataset: {} } },
    module,
    exports: module.exports,
    require: makeRequire(),
  });
  runInContext(code, context, { filename: 'reader-page.cjs' });
  const { ReaderPage } = module.exports;
  assert.equal(typeof ReaderPage, 'function', 'ReaderPage 没导出 —— 装置失效');
  return renderToStaticMarkup(React.createElement(ReaderPage, { api: {}, SessionProvider: undefined, renderSlot: undefined }));
}

describe('订阅页没选中文章时，阅读区那条拖动行真的渲染得出来（0.28.3）', () => {
  test('欢迎页里就有 `.npr-book-toolbar[data-window-drag]`', async () => {
    const html = await renderReaderPage();
    // 先自证测的是哪个状态：反过来的话，下面那条失败时分不清是「拖动行没渲染」
    // 还是「根本渲染了文章工具栏那一支」。
    assert.match(html, /class="npr-welcome"/, '渲染出来的不是欢迎页 —— 测的不是「没选中文章」这个状态');
    assert.doesNotMatch(html, /class="npr-reader-toolbar"/, '渲染出了文章工具栏 —— 测的不是「没选中文章」这个状态');
    assert.match(html, DRAG_ROW_RE,
      '欢迎页没有拖动行 —— 面板右侧那一整块又变成拖不动了（用户 2026-10-26 报的症状）');
  });

  test('★ 反向对照：把那条拖动行删掉必须渲染不出来（证明这条断言有牙）', async () => {
    const html = await renderReaderPage({
      from: '<div className="npr-book-toolbar" data-window-drag />',
      to: '',
    });
    assert.match(html, /class="npr-welcome"/, '变异后连欢迎页都没了 —— 对照样本本身失效');
    assert.doesNotMatch(html, DRAG_ROW_RE,
      '拖动行删掉了居然还在 —— 说明这条断言根本没在看那个位置（假绿）');
  });
});
