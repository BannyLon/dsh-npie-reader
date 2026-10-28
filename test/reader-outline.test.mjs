/**
 * 文章大纲（TOC，0.44）。
 *
 * 这一层分两半，缺一不可：
 *   ① **真跑** `article-outline.js` 的两个纯函数 —— 哪些标题算、层级怎么排、
 *      读到哪一节算「当前」。这是「大纲对不对」的全部内容。
 *   ② **源码级** 守住三件不能靠纯函数表达的事：锚点用 data 属性、跳转不用
 *      `scrollIntoView`、没标题时按钮禁用并说明原因。
 *
 * ★ 为什么 ② 不能省：这三条都是「做了但做错」比「没做」更糟的那种 ——
 *   锚点错位会让点第 3 节跳到第 4 节（不报错）、`scrollIntoView` 会把宿主页面
 *   一起滚（看着像点错）、可点的空按钮就是「看起来像功能」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { activeIndex, outlineOf, scrollTarget, OUTLINE_ACTIVE_OFFSET, OUTLINE_TEXT_LIMIT } from '../src/client/article-outline.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const readerSource = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));

/** 造一个「像 DOM 节点」的最小对象：只有 tagName 与 textContent 会被读。 */
const heading = (tagName, textContent) => ({ tagName, textContent });

describe('0.44：文章大纲 —— 哪些标题进目录', () => {
  it('h1–h4 都收，层级原样带出来', () => {
    const items = outlineOf([
      heading('H1', '大标题'),
      heading('H2', '第一节'),
      heading('H3', '小节'),
      heading('H4', '更细'),
    ]);
    assert.deepEqual(items.map((item) => item.level), [1, 2, 3, 4], '层级被压平了 —— 缩进就没了');
    assert.deepEqual(items.map((item) => item.text), ['大标题', '第一节', '小节', '更细']);
  });

  it('★ h5 / h6 不收（默认只到 h4）', () => {
    const items = outlineOf([heading('H2', '正文节'), heading('H5', '脚注级'), heading('H6', '更小')]);
    assert.deepEqual(items.map((item) => item.text), ['正文节'],
      'h5/h6 进了目录 —— 它们在正文里通常是脚注或标签，混进大纲会让层级看起来坏掉');
  });

  it('★ 空标题必须过滤（只有锚点的 h2）', () => {
    // 真实形态：`<h2><a id="sec-1"></a></h2>` —— 有的源拿它当锚点，正文里一个字都没有
    const items = outlineOf([heading('H2', ''), heading('H2', '   '), heading('H2', '真正的标题')]);
    assert.deepEqual(items.map((item) => item.text), ['真正的标题'],
      '空标题进了目录 —— 用户点一行、页面纹丝不动，比没有这一行更糟');
  });

  it('★ `at` 是输入下标，不是目录下标（中间夹空标题时两者不相等）', () => {
    const nodes = [heading('H2', ''), heading('H2', '第一'), heading('H2', ''), heading('H2', '第二')];
    const items = outlineOf(nodes);
    assert.deepEqual(items.map((item) => item.at), [1, 3],
      'at 没跟着原始下标走 —— 调用方按它把锚点打回节点，错位之后点第 1 节会跳到第 2 节，而且不报错');
    assert.deepEqual(items.map((item) => item.key), ['0', '1'], 'key 应该是目录内的连续序号');
  });

  it('空白折叠成一个空格（标题里常有换行与缩进）', () => {
    const items = outlineOf([heading('H2', '  第一节\n\n  背景  ')]);
    assert.equal(items[0].text, '第一节 背景');
    assert.equal(items[0].full, '第一节 背景', 'full 也要折叠 —— 否则 tooltip 里是一堆换行');
  });

  it('★ 长标题截断到 44 字，但 full 保留原句', () => {
    const long = '一'.repeat(60);
    const items = outlineOf([heading('H2', long)]);
    assert.equal(items[0].text.length, OUTLINE_TEXT_LIMIT + 1, '截断长度不对（末尾还有一个省略号）');
    assert.equal(items[0].text.endsWith('…'), true);
    assert.equal(items[0].full, long, 'full 被一起截断了 —— 悬停也看不到原句了');
  });

  it('刚好的 44 字不加省略号（边界）', () => {
    const exact = '二'.repeat(OUTLINE_TEXT_LIMIT);
    assert.equal(outlineOf([heading('H2', exact)])[0].text, exact);
    assert.equal(outlineOf([heading('H2', `${exact}三`)])[0].text, `${exact}…`);
  });

  it('非标题节点（tagName 不是 hN）不收', () => {
    const items = outlineOf([{ tagName: 'P', textContent: '段落' }, { tagName: undefined, textContent: '没有标签' }]);
    assert.equal(items.length, 0, '把段落当标题收进来了');
  });

  it('空输入给空数组，不抛', () => {
    assert.deepEqual(outlineOf([]), []);
    assert.deepEqual(outlineOf(undefined), []);
  });
});

describe('0.44：文章大纲 —— 当前读到哪一节', () => {
  it('全都在判定线以下 ⇒ 第 0 节', () => {
    assert.equal(activeIndex([200, 400, 600]), 0);
  });

  it('第 3 个越过判定线 ⇒ 下标 2', () => {
    assert.equal(activeIndex([-300, -100, 40, 500]), 2);
  });

  it('★ 取「最后一个越过的」，不是「离判定线最近的」', () => {
    // 两条标题相距很近：10 与 20 都越过判定线，应该停在 20 那一节（下标 1）
    assert.equal(activeIndex([10, 20, 900]), 1,
      '取成了最近的那个 —— 两条标题挨着时滚动一像素换一节，目录会来回跳');
  });

  it('负数（已经滚过去的标题）也算越过', () => {
    assert.equal(activeIndex([-900, -500, -20, 300]), 2);
  });

  it('Infinity（节点没找到）不参与判定', () => {
    assert.equal(activeIndex([-50, Infinity, Infinity]), 0,
      '找不到的节点被当成了「越过了」—— 目录会跳到最后一节');
  });

  it('空数组给 0（不是 -1）', () => {
    assert.equal(activeIndex([]), 0, '-1 会让「没有当前项」和「还没算出来」混在一起，界面会闪');
    assert.equal(activeIndex(undefined), 0);
  });

  it('判定线可覆盖', () => {
    assert.equal(activeIndex([50, 150], 100), 0);
    assert.equal(activeIndex([50, 150], 200), 1);
    assert.equal(OUTLINE_ACTIVE_OFFSET, 96, '默认判定线变了 —— 与组件里的量测基准对不上');
  });
});

describe('0.44：文章大纲 —— 点一行该滚到多少', () => {
  it('从顶部点第二个标题：容器顶 28、标题视口 1200 ⇒ 1156', () => {
    assert.equal(scrollTarget(0, 1200, 28), 1156);
  });

  it('已经滚下去时用绝对值算，不是再叠一次增量', () => {
    // 同一个目标，从 500 的位置点它，结果必须还是 1156（而不是 500+1156）
    assert.equal(scrollTarget(500, 700, 28), 1156,
      '算成了增量 —— 第二次点同一行会越滚越远');
  });

  it('目标在当前位置下方很近时，仍然落在合理位置', () => {
    assert.equal(scrollTarget(800, 100, 28), 856);
  });

  it('★ 目标在当前位置上方、差值为负时夹到 0', () => {
    assert.equal(scrollTarget(10, 30, 28), 0, '负的滚动位置没夹住 —— 浏览器会夹，但返回值骗人');
  });

  it('非数字输入给 0，不抛', () => {
    assert.equal(scrollTarget(undefined, undefined, undefined), 0);
    assert.equal(scrollTarget(NaN, 100, 0), 0);
  });

  it('gap 可覆盖', () => {
    assert.equal(scrollTarget(0, 1200, 28, 0), 1172);
  });
});

describe('0.44：文章大纲 —— 组件里那三件纯函数表达不了的事', () => {
  it('★ 锚点用 data-outline，不用 id', () => {
    assert.match(readerSource, /dataset\.outline = item\.key/,
      '锚点没打在节点上 —— 目录点了不会有任何反应');
    assert.match(readerSource, /\[data-outline="\$\{item\.key\}"\]/,
      '查询锚点的方式与打锚点的方式不一致');
    assert.doesNotMatch(readerSource, /node\.id = `npr-h-/, '又用回 id 了（会被类名检查误判、也可能撞名）');
  });

  it('★ 按 at 打锚点，不按目录下标', () => {
    assert.match(readerSource, /next\.forEach\(\(item\) => \{ nodes\[item\.at\]\.dataset\.outline = item\.key; \}\)/,
      '用目录下标去索引节点 —— 中间夹空标题时会静默错位');
  });

  it('★ 跳转用 scrollTo 自己算，不用 scrollIntoView', () => {
    assert.match(readerSource, /const top = scrollTarget\(scroller\.scrollTop, node\.getBoundingClientRect\(\)\.top, scroller\.getBoundingClientRect\(\)\.top\)/,
      '没走 scrollTarget 那个纯函数 —— 差值算法散在组件里就测不到了');
    assert.match(readerSource, /scroller\.scrollTo\(\{ top, behavior: 'smooth' \}\)/,
      '没找到用算好的目标去滚');
    assert.doesNotMatch(readerSource, /\.scrollIntoView\(/,
      '用回 scrollIntoView 了 —— 它会把外层所有可滚动祖先一起滚，滚完左侧列表也跟着跳');
  });

  it('★ 没有小标题时按钮禁用，并说清为什么', () => {
    assert.match(readerSource, /disabled=\{outline\.length === 0\}/,
      '没有标题时按钮仍可点 —— 点了什么都不发生，就是「看起来像功能」');
    assert.match(readerSource, /这篇没有小标题，没有大纲/,
      '禁用但没说原因（只看 title 也不够，但至少要有）');
  });

  it('★ 切版本 / 换文章时重新扫（依赖 bodyHtml）', () => {
    assert.match(readerSource, /\}, \[bodyHtml\]\);/, '提取 effect 没挂在 bodyHtml 上 —— 切版本后目录还是上一版的');
    assert.match(readerSource, /setOutlineOpen\(false\)/, '换文章后目录还开着 —— 看的是上一版的目录');
  });

  it('滚动监听解绑干净（否则切文章后监听越积越多）', () => {
    assert.match(readerSource, /scroller\.removeEventListener\('scroll', onScroll\)/);
    assert.match(readerSource, /cancelAnimationFrame\(frame\)/);
  });
});
