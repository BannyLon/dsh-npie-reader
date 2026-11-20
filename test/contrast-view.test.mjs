/**
 * 双语对照（`buildContrastHtml`）的**真跑**守卫（0.57.0）。
 *
 * ★ 为什么必须有这个文件
 * ----------------------
 * 这个功能只有一条判据：「译文块跟对了原文块」。它坏掉的样子**全部是静默的**：
 *
 *   ① 块对错了位 ⇒ 一段中文跟在另一段英文后面，读起来通顺，**只有对照着读才发现**；
 *   ② `<li>` 被整体复制 ⇒ 有序列表编号变成 1,2,3,4，用户以为原文有 4 条；
 *   ③ 图片跟着复制 ⇒ 同一张图出现两遍，看起来像排版事故；
 *   ④ `id` 跟着复制 ⇒ 目录跳转命中第一份，高亮位置与正文错开；
 *   ⑤ 结构对不上却硬对齐 ⇒ 整篇中文塞进错误的段落里。
 *
 * 这五条都**不会抛错**，所以这里对每一条都单独钉一个用例，并且用 `units`
 * （复制了几个块）钉住**数量** —— 只断言「html 里有类名」证明不了交错了几段。
 *
 * ★ 夹具为什么手写而不是抓真文章：判据要能被反证。手写夹具里每个块的角色
 *   （段落 / 列表项 / 单元格 / 代码 / 图片）都是唯一且可数的，断言因此可以说
 *   「恰好 6 个单元」，而不是「看起来差不多」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { buildContrastHtml, CONTRAST_CLASS, contrastReadable } from '../src/client/contrast-view.js';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readerSource = readFileSync(join(pluginRoot, 'src/client/ReaderPage.jsx'), 'utf8');

/** 数一个字符串里出现了几次某个标签（够用：夹具里没有自闭合与嵌套同名）。 */
function count(html, tag) {
  return (html.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length;
}

/** 出现几次对照类名。 */
function contrastBlocks(html) {
  return (html.match(new RegExp(`class="${CONTRAST_CLASS}"`, 'g')) ?? []).length;
}

describe('buildContrastHtml：逐段交错', () => {
  const source = '<article><h2 id="intro">Intro</h2><p>Hello <strong>world</strong>.</p></article>';
  const chinese = '<article><h2 id="intro">引言</h2><p>你好 <strong>世界</strong>。</p></article>';

  it('每个块后面紧跟它的译文，顺序与原文一致', () => {
    const { html, mode, units } = buildContrastHtml({ articleHtml: source, translatedHtml: chinese });
    assert.equal(mode, 'interleaved');
    assert.equal(units, 2, '应该只复制 h2 与 p 两块');
    assert.equal(
      html,
      '<article><h2 id="intro">Intro</h2><h2 class="npr-ct-zh">引言</h2>'
      + '<p>Hello <strong>world</strong>.</p><p class="npr-ct-zh">你好 <strong>世界</strong>。</p></article>',
      '交错后的 HTML 与期望逐字节不符',
    );
  });

  it('原块一个字符都不动（原文仍是原文）', () => {
    const { html } = buildContrastHtml({ articleHtml: source, translatedHtml: chinese });
    assert.ok(html.includes('<p>Hello <strong>world</strong>.</p>'), '原文块被改写了');
    assert.ok(html.includes('<h2 id="intro">Intro</h2>'), '原文标题（含 id）被改写了');
  });

  it('复制块**不给 id**：两个同名锚点会让目录跳转与高亮错位', () => {
    const { html } = buildContrastHtml({ articleHtml: source, translatedHtml: chinese });
    assert.equal(html.match(/id="intro"/g)?.length, 1, 'id 被复制了一份');
  });

  it('原有 class 保留，对照类名追加在后面', () => {
    const { html } = buildContrastHtml({
      articleHtml: '<p class="lede">A</p>',
      translatedHtml: '<p class="lede">甲</p>',
    });
    assert.ok(html.includes('<p class="lede npr-ct-zh">甲</p>'), `实际：${html}`);
  });
});

describe('buildContrastHtml：容器不复制', () => {
  const source = '<ul><li>One</li><li>Two</li></ul><table><tr><td>Cell</td></tr></table>';
  const chinese = '<ul><li>一</li><li>二</li></ul><table><tr><td>单元格</td></tr></table>';

  it('列表项不复制 `<li>`：一个项目符号只留一个', () => {
    const { html } = buildContrastHtml({ articleHtml: source, translatedHtml: chinese });
    assert.equal(count(html, 'li'), 2, `<li> 被复制了，条目数会翻倍：${html}`);
    assert.ok(html.includes('<li>One<div class="npr-ct-zh">一</div></li>'), `译文没插进 li 内部：${html}`);
  });

  it('表格单元格同样插在内部，不复制 `<td>`', () => {
    const { html } = buildContrastHtml({ articleHtml: source, translatedHtml: chinese });
    assert.equal(count(html, 'td'), 1, `<td> 被复制了：${html}`);
    assert.ok(html.includes('<td>Cell<div class="npr-ct-zh">单元格</div></td>'), `实际：${html}`);
  });

  it('嵌套块只复制最内层：`<blockquote><p>` 不会整块复制一遍', () => {
    const { html, units } = buildContrastHtml({
      articleHtml: '<blockquote><p>A</p></blockquote>',
      translatedHtml: '<blockquote><p>甲</p></blockquote>',
    });
    assert.equal(units, 1, '应该只复制 p');
    assert.equal(count(html, 'blockquote'), 1, 'blockquote 被整块复制了');
    assert.ok(html.includes('<blockquote><p>A</p><p class="npr-ct-zh">甲</p></blockquote>'), `实际：${html}`);
  });
});

describe('buildContrastHtml：不该重复的东西', () => {
  it('图片不跟着复制（同一张图出现两遍就是排版事故）', () => {
    const { html } = buildContrastHtml({
      articleHtml: '<p><img src="a.png">Caption</p>',
      translatedHtml: '<p><img src="a.png">题注</p>',
    });
    assert.equal(html.match(/<img\b/g)?.length, 1, `图片被复制了：${html}`);
    assert.ok(html.includes('题注'), '译文丢了');
  });

  it('整段只有一张图时不产生空译文块', () => {
    const { html, units } = buildContrastHtml({
      articleHtml: '<p><img src="a.png"></p>',
      translatedHtml: '<p><img src="a.png"></p>',
    });
    assert.equal(units, 0, '空块不该复制');
    assert.equal(contrastBlocks(html), 0);
  });

  it('代码块不复制、也不进译文（代码翻了就废了）', () => {
    const { html, units } = buildContrastHtml({
      articleHtml: '<pre><code>let a = 1;</code></pre><p>A</p>',
      translatedHtml: '<pre><code>let a = 1;</code></pre><p>甲</p>',
    });
    assert.equal(units, 1, 'pre 被当成单元了');
    assert.equal(html.match(/let a = 1;/g)?.length, 1, '代码出现两遍');
    assert.equal(contrastBlocks(html), 1);
  });
});

describe('buildContrastHtml：对不上就不对齐', () => {
  const source = '<p>One</p><p>Two</p>';

  it('结构不一致 ⇒ 整篇上下对照，且原文、译文都完整保留', () => {
    const translated = '<p>只有一段</p>';
    const { html, mode, units } = buildContrastHtml({ articleHtml: source, translatedHtml: translated });
    assert.equal(mode, 'stacked', '结构不同却宣称交错成功');
    assert.equal(units, 0);
    assert.ok(html.startsWith(source), '原文没有原样放在最前');
    assert.ok(html.includes(translated), '译文丢了');
    assert.ok(html.includes('npr-ct-split'), '缺少分隔线');
  });

  it('标签相同但父级结构不同（漏了一层包裹）也算对不上', () => {
    const { mode } = buildContrastHtml({
      articleHtml: '<div><p>A</p></div>',
      translatedHtml: '<p>A</p>',
    });
    assert.equal(mode, 'stacked');
  });

  it('没有译文 ⇒ 原样返回，不假装对照', () => {
    const { html, mode } = buildContrastHtml({ articleHtml: source, translatedHtml: '   ' });
    assert.equal(mode, 'none');
    assert.equal(html, source);
  });

  it('没有原文 ⇒ 空串（调用方不该渲染）', () => {
    const { html, mode } = buildContrastHtml({ articleHtml: '', translatedHtml: '<p>甲</p>' });
    assert.equal(mode, 'none');
    assert.equal(html, '');
  });
});

describe('接线：ReaderPage 真的用上了对照', () => {
  it('「对照」的可用性只认译文（它没有 versions.contrast）', () => {
    assert.equal(contrastReadable({ translation: { available: true } }), true);
    assert.equal(contrastReadable({ translation: { available: false } }), false);
    assert.equal(contrastReadable({}), false);
    assert.equal(contrastReadable(undefined), false);
    // 反向：如果哪天按 `versions.contrast` 去判断，这里就会 false —— 而它明明能读。
    assert.equal(contrastReadable({ contrast: { available: true } }), false,
      '有人把判据改成读 versions.contrast 了 —— 那会让对照永远显示「缺失」');
  });

  it('下拉里的可用性没有再直接查 `versions[kind]`（否则对照会标成缺失）', () => {
    assert.match(
      readerSource,
      /kind === 'contrast' \? translationReady : versions\?\.\[kind\]\?\.available/,
      '对照项的可用性没走 translationReady',
    );
  });

  it('版本下拉的顺序里含对照，且排在译文之后', () => {
    assert.match(
      readerSource,
      /const VERSION_ORDER = \['original', 'translation', 'contrast', 'rewrite'\]/,
      'VERSION_ORDER 里没有对照，或顺序变了',
    );
  });

  it('正文计算走了 `buildContrastHtml`（不是别的分支）', () => {
    assert.match(readerSource, /buildContrastHtml\(\{/, '正文没有调用 buildContrastHtml');
    assert.match(readerSource, /if \(active === 'contrast'\) return contrast\?\.html \?\? ''/, '对照分支没接进 bodyHtml');
  });

  it('「重新生成」在对照视图下落回译文（对照没有自己的产物）', () => {
    assert.match(
      readerSource,
      /generate\(active === 'contrast' \? 'translation' : active, true\)/,
      '对照视图会把 contrast 当成一个可生成的 kind 发给宿主',
    );
  });

  it('没有译文时下拉里不出现对照（不给一条点了就空白的死路）', () => {
    assert.match(
      readerSource,
      /VERSION_ORDER\.filter\(\(kind\) => kind !== 'contrast' \|\| translationReady\)/,
      '对照项没按译文是否就绪过滤',
    );
  });
});
