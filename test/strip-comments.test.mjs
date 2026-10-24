/**
 * 注释剥离器的单测。
 *
 * ★ 为什么这份单测必须存在：这个模块是**守卫的守卫**。
 *   它一旦多剥（吃掉真代码）或漏剥（留下注释），上层的契约检查就会给出
 *   「看着有结论、其实判据已经瞎了」的结果 —— 而且是静默的。
 *   所以这里两面都钉：**该剥的剥干净**，**不该动的一个字不动**。
 *
 * ★ 样本全部取自本仓库真实代码（不是编的），因为真实的坑恰恰是
 *   `'…,* / *;q=0.9'` 与 `/^https?:\/\/…/i` 这种「看着不像坑」的写法。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../scripts/strip-comments.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 剥完之后再压缩空白，方便断言「还剩什么」。 */
const shrunk = (text) => stripComments(text).replace(/\s+/g, ' ').trim();

describe('stripComments', () => {
  test('行注释与块注释都剥掉', () => {
    assert.equal(shrunk('const a = 1; // 说明\nconst b = 2;'), 'const a = 1; const b = 2;');
    assert.equal(shrunk('/* 一段\n   多行注释 */\nconst a = 1;'), 'const a = 1;');
    // 剥掉的位置留空格，所以 `{}` 中间会空出来一格（压缩后就是 `{ }`）。
    assert.equal(shrunk('{/* JSX 里的注释 */}'), '{ }');
    assert.equal(shrunk('{/* JSX 里的注释 */}').replace(/\s+/g, ''), '{}');
  });

  test('★ 换行必须保留 —— 否则报出来的行号全是错的', () => {
    const source = 'const a = 1;\n// 一\n// 二\n// 三\nconst b = 2;';
    const out = stripComments(source);
    assert.equal(out.split('\n').length, source.split('\n').length);
    assert.equal(out.split('\n')[4], 'const b = 2;');
  });

  test('长度不变（等长空格替换）⇒ 列号也还对得上', () => {
    const source = 'const a = 1; // x\n/* y */';
    assert.equal(stripComments(source).length, source.length);
  });

  test('反向对照：字符串里的 `//` 不是注释', () => {
    // 本仓库真实样本：JSX 属性、JS 字符串、模板串里都出现过 URL。
    assert.equal(shrunk('<input placeholder="https://example.org/subscriptions.opml" />'), '<input placeholder="https://example.org/subscriptions.opml" />');
    assert.equal(shrunk("const u = 'https://a.example/feed.xml';"), "const u = 'https://a.example/feed.xml';");
    assert.equal(shrunk('const u = `https://${host}/feed`;'), 'const u = `https://${host}/feed`;');
  });

  test('反向对照：正则字面量里的转义斜杠不被误判（本仓库 feed-urls.js 的真实写法）', () => {
    const source = 'const urls = all.filter((url) => /^https?:\\/\\//i.test(url));';
    assert.equal(shrunk(source), source);
    // 字符组里的 `/` 也不该提前收尾
    assert.equal(shrunk('const r = /[/]x/;'), 'const r = /[/]x/;');
  });

  test('反向对照：字符串里的「斜杠星号」不被当成块注释（本仓库 service.js 的真实写法）', () => {
    // ★ 这是全局剥块注释会**静默吃掉大段真代码**的那个反例。
    const source = "const h = { accept: 'application/rss+xml;q=0.9,*/*;q=0.5' };\nconst after = 1;";
    assert.equal(shrunk(source), "const h = { accept: 'application/rss+xml;q=0.9,*/*;q=0.5' }; const after = 1;");
    assert.match(shrunk(source), /const after = 1;/);
  });

  test('★ 模板串里的 CSS 注释要剥掉（本项目把 CSS 写在反引号里）', () => {
    const source = 'const CSS = `\n/* 拖动：html[data-platform=darwin] [data-window-drag-recall]{no-drag} */\n.a{color:red}\n`;';
    const out = stripComments(source);
    assert.doesNotMatch(out, /data-window-drag-recall/);
    assert.match(out, /\.a\{color:red\}/);
  });

  test('反向对照：模板串里的 `//` 不当注释（那多半是 URL，不是 CSS 注释语法）', () => {
    const source = 'const t = `\n见 https://example.com/a\n`;';
    assert.match(stripComments(source), /https:\/\/example\.com\/a/);
  });

  test('未闭合的块注释吃到文件尾，不抛错', () => {
    assert.equal(shrunk('const a = 1; /* 没关'), 'const a = 1;');
  });

  test('★ 真样本回归：把客户端源码剥一遍，注释里的锚点必须消失、真代码里的必须还在', () => {
    const reader = readFileSync(join(pluginRoot, 'src', 'client', 'ReaderPage.jsx'), 'utf8');
    const out = stripComments(reader);
    // 注释里抄的宿主规则原文 ⇒ 必须消失（这正是 check-host-contract 判红的根因）。
    assert.doesNotMatch(out, /data-window-drag-recall/, '注释里的 -recall 没被剥掉');
    assert.doesNotMatch(out, /data-platform/, '注释里的 data-platform 没被剥掉');
    assert.doesNotMatch(out, /\[tabindex\]/, '注释里抄的宿主选择器 [tabindex] 没被剥掉');
    // ★ 注意用 `[tabindex]`（宿主选择器的形态）而不是 /tabindex/i：
    //   真代码里那处 `tabIndex={0}` 是**应该留下**的，用不区分大小写的裸词会把它一起判红。
    assert.match(out, /tabIndex=\{0\}/, '真代码里的 tabIndex 被误剥了');
    // 真代码 ⇒ 必须一个不少。
    assert.match(out, /data-window-drag/, '真代码里的拖动标记被误剥了');
    assert.match(out, /npr-sidebar-toolbar/, '真代码里的类名被误剥了');
    assert.equal((out.match(/tabIndex=/g) ?? []).length, 1, '唯一那处 tabIndex 被误剥或漏剥');
    assert.match(out, /npr-companion-divider/, '真代码里的分隔条类名被误剥了');
  });

  test('★ 真样本回归：JSX 与 CSS 的正文结构在剥注释后仍然完整', () => {
    const dialogs = readFileSync(join(pluginRoot, 'src', 'client', 'dialogs.jsx'), 'utf8');
    const out = stripComments(dialogs);
    // dialogs.jsx 里有一个含 `\n` 与 URL 的字符串字面量，剥注释不该动它。
    assert.match(out, /https:\/\/example\.com\/feed\.xml/, '字符串里的 URL 被误剥');
    assert.match(out, /npr-addfeed-urls/, '真代码里的类名被误剥');
  });
});
