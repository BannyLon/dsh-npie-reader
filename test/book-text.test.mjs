/**
 * PDF 文字层与划词追问的**判据**（0.20.5）。
 *
 * 背景：修之前，PDF 明明有文字层却**一个字都选不中** —— 阅读区里只有一个
 * `<canvas>`，位图里没有可选文本节点。修法是叠一层 pdf.js 的 `TextLayer`
 * （透明 span 按 PDF 坐标绝对定位）。
 *
 * ★ 为什么这些断言值得存在：文字层「写上了」不等于「对得上」。它有三种**全绿但没用**
 *   的坏形态，而它们都只在真机上看得出：
 *     ① 容器尺寸与画布差 1px 的取整 ⇒ 选区整体错半个字；
 *     ② `--font-height` 忘了乘缩放 ⇒ 2× 屏上字号只有一半，选一个字的框盖住半个字；
 *     ③ 选区坐标用了视口基准 ⇒ 页面一滚，气泡留在原地。
 *   下面每一条都对着其中一种。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';
import {
  QUOTE_BAR_EDGE, QUOTE_BAR_HALF, QUOTE_BAR_HEIGHT, QUOTE_LIMIT, layerScaleRatio, quoteBarLeft,
  quoteBarPlacement, selectionQuote, textLayerCharCount, textLayerMetrics,
} from '../src/client/book-text.js';

const here = dirname(fileURLToPath(import.meta.url));
const css = stripComments(readFileSync(join(here, '..', 'src', 'client', 'refinements.css'), 'utf8'));
const bookReader = stripComments(readFileSync(join(here, '..', 'src', 'client', 'BookReader.jsx'), 'utf8'));

describe('textLayerMetrics：容器尺寸必须与画布的 CSS 尺寸**逐像素**一致', () => {
  it('按画布的口径取整（floor，不是 round）', () => {
    // BookReader 给画布设的就是 `Math.floor(viewport.width)`。两处取整方式不同就会
    // 差 1px —— 在逐字 span 上正好够把一个字的选区错到邻居身上。
    const metrics = textLayerMetrics({ scale: 1.2235, width: 728.29, height: 1030.35 });
    assert.deepEqual(metrics, { scale: 1.2235, width: 728, height: 1030 });
  });

  it('★ 反向对照：把 floor 换成 round 会得到不同的数（说明这条判据真的在看取整）', () => {
    const viewport = { scale: 1, width: 100.7, height: 200.4 };
    const naive = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
    const real = textLayerMetrics(viewport);
    assert.notEqual(real.width, naive.width, 'floor 与 round 在这里恰好同值 —— 换一个数才有分辨力');
    assert.equal(real.width, 100);
  });

  it('scale 非法 / 尺寸为 0 时返回 null（宁可不出文字层，也不出一个错位的）', () => {
    for (const bad of [
      null, undefined,
      { scale: 0, width: 100, height: 100 },
      { scale: -1, width: 100, height: 100 },
      { scale: Number.NaN, width: 100, height: 100 },
      { scale: 1, width: 0, height: 100 },
      { scale: 1, width: 100, height: 0 },
      { scale: 1, width: 0.4, height: 100 },
    ]) {
      assert.equal(textLayerMetrics(bad), null, JSON.stringify(bad));
    }
  });
});

describe('layerScaleRatio：拖窗口那 160ms 的临时缩放', () => {
  it('比例没变时返回 null（不要写一个恒等 transform，它会禁用子像素平滑）', () => {
    assert.equal(layerScaleRatio(1.2, 1.2), null);
    assert.equal(layerScaleRatio(1.2, 1.2 + 1e-9), null);
  });

  it('真的变了才给比例', () => {
    assert.equal(layerScaleRatio(1.2, 2.4), 2);
    assert.equal(layerScaleRatio(2, 1), 0.5);
  });

  it('任一侧非法 ⇒ null（不能拿 NaN 去写 style.transform）', () => {
    assert.equal(layerScaleRatio(0, 2), null);
    assert.equal(layerScaleRatio(1, Number.NaN), null);
    assert.equal(layerScaleRatio(undefined, 2), null);
  });
});

/** 选区替身：只实现 `selectionQuote` 用到的那一小块。 */
function fakeSelection({ text, range, collapsed = false, rangeCount = 1 }) {
  return {
    isCollapsed: collapsed,
    rangeCount,
    getRangeAt: () => range,
    toString: () => text,
  };
}

/** 文字层替身：`contains` + `getBoundingClientRect`。 */
function fakeLayer({ left = 40, top = 200, width = 600, height = 800, contains = () => true } = {}) {
  return {
    contains,
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
  };
}

function fakeRange({ start, end, rect = { left: 100, top: 260, width: 120, height: 18 } }) {
  return {
    startContainer: start,
    endContainer: end,
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
  };
}

describe('selectionQuote：坐标必须**相对文字层**，不是相对视口', () => {
  const node = { nodeName: 'SPAN' };
  const layer = fakeLayer({ left: 40, top: 200, width: 600, height: 800 });

  it('正常选区：文案与相对坐标', () => {
    const quote = selectionQuote(
      fakeSelection({ text: '在工作中体会生命的精彩', range: fakeRange({ start: node, end: node }) }),
      layer,
    );
    assert.equal(quote.text, '在工作中体会生命的精彩');
    // 选区盒子（视口）top=260、left=100；文字层在 (40,200) ⇒ 相对 60 / 60。
    assert.equal(quote.top, 60);
    assert.equal(quote.bottom, 78);
    assert.equal(quote.centerX, 60 + 60);
    assert.equal(quote.layerHeight, 800);
  });

  it('★ 反向对照：用视口坐标那一版会大出 200px（页面一滚气泡就留在原地）', () => {
    const range = fakeRange({ start: node, end: node });
    const real = selectionQuote(fakeSelection({ text: '选段', range }), layer);
    const naiveTop = range.getBoundingClientRect().top; // 直接拿视口坐标
    assert.notEqual(real.top, naiveTop);
    assert.equal(naiveTop - real.top, 200, '差值应当正好是文字层的 top');
  });

  it('塌缩 / 无选区 / 越界 / 空白 / 超长 / 量不到矩形 ⇒ 都不弹气泡', () => {
    const range = fakeRange({ start: node, end: node });
    const cases = [
      ['塌缩（只点了一下）', fakeSelection({ text: '', range, collapsed: true }), layer],
      ['rangeCount 为 0', fakeSelection({ text: 'x', range, rangeCount: 0 }), layer],
      ['起点不在文字层内', fakeSelection({ text: 'x', range }), fakeLayer({ contains: () => false })],
      ['选中的是空白', fakeSelection({ text: '   \n\t ', range }), layer],
      ['整页全选（超过上限）', fakeSelection({ text: '字'.repeat(QUOTE_LIMIT + 1), range }), layer],
      ['量不到矩形（宽 0）', fakeSelection({ text: 'x', range: fakeRange({ start: node, end: node, rect: { left: 0, top: 0, width: 0, height: 0 } }) }), layer],
    ];
    for (const [name, selection, target] of cases) {
      assert.equal(selectionQuote(selection, target), null, name);
    }
    assert.equal(selectionQuote(null, layer), null);
    assert.equal(selectionQuote(fakeSelection({ text: 'x', range }), null), null);
  });

  it('★ 反向对照：去掉越界判据之后，「从书页拖到侧栏」会被当成书里的选段', () => {
    // 这条守的是**真的会发生**的操作：从书页一路拖到右边伴读的文字上。
    // 文字层用「只认得自己那两个节点」的替身 —— 两端都答「在」就等于没有这条判据。
    const ownLayer = fakeLayer({ contains: (target) => target === node });
    const range = fakeRange({ start: node, end: { nodeName: 'P' } });
    const selection = fakeSelection({ text: '跨了两块区域的文字', range });
    assert.equal(selectionQuote(selection, ownLayer), null);
    // 同一份输入，把 contains 换成恒真（= 没有这条判据）就会返回东西 ——
    // 证明上面那条不是恒真式。
    const naive = fakeLayer({ contains: () => true });
    assert.notEqual(selectionQuote(selection, naive), null);
  });

  it('空白压成单空格，但**保留换行**（逐字 span 拼起来本来就没有分隔符）', () => {
    const quote = selectionQuote(
      fakeSelection({ text: '第一行\n\n第二行   末尾', range: fakeRange({ start: node, end: node }) }),
      layer,
    );
    assert.equal(quote.text, '第一行\n第二行 末尾');
  });
});

describe('quoteBarPlacement：上方没位置就放下方', () => {
  const base = { top: 400, bottom: 420, centerX: 200, layerHeight: 900 };

  it('上方够放 ⇒ 放在上方（用 bottom 定位，相对文字层底）', () => {
    assert.deepEqual(quoteBarPlacement(base), { side: 'above', value: 900 - 400 + 6 });
  });

  it('贴着页面顶部 ⇒ 放到下方（否则气泡会被顶出书页、落到工具栏上）', () => {
    assert.deepEqual(quoteBarPlacement({ ...base, top: 10, bottom: 30 }), { side: 'below', value: 36 });
  });

  it('刚好够放的那一行仍然算「上方」（边界不许抖动）', () => {
    const top = QUOTE_BAR_HEIGHT + 4;
    assert.equal(quoteBarPlacement({ ...base, top, bottom: top + 20 }).side, 'above');
    assert.equal(quoteBarPlacement({ ...base, top: top - 1, bottom: top + 19 }).side, 'below');
  });

  it('null 进 null 出', () => {
    assert.equal(quoteBarPlacement(null), null);
  });
});

describe('textLayerCharCount：数的是**字**，不是 span', () => {
  it('空白不算', () => {
    assert.equal(textLayerCharCount({ textContent: ' 中 文 \n 字 ' }), 3);
  });

  it('★ 扫描页的形态：一堆空 span ⇒ 0（数 span 的话会得到几十，扫描页就被当成文字版）', () => {
    // pdf.js 会给页边距、图注占位、伪空格也生成 span。
    assert.equal(textLayerCharCount({ textContent: '   ' + '\n'.repeat(40) }), 0);
    assert.equal(textLayerCharCount({ textContent: '' }), 0);
    assert.equal(textLayerCharCount(null), 0);
  });
});

/* --------------------------------------------------------------------------
 * 样式与源码契约：上面测的是「算得对」，这里守的是「真的接上了」。
 * 算得再对，忘了把 `--total-scale-factor` 写进容器，文字层就是一团错位的字。
 * ------------------------------------------------------------------------ */

describe('文字层的样式契约（refinements.css）', () => {
  it('容器是绝对定位、`inset:0` 铺满书页块', () => {
    assert.match(css, /\.npr-book-text\s*\{[^}]*position:\s*absolute/);
    assert.match(css, /\.npr-book-text\s*\{[^}]*inset:\s*0/);
  });

  it('★ pdf.js 用 `round(down, …)` 算容器宽高 —— 这两个变量缺了那条声明整条失效', () => {
    assert.match(css, /--scale-round-x:\s*1px/);
    assert.match(css, /--scale-round-y:\s*1px/);
  });

  it('★ 字号必须乘缩放因子（`--font-height` 的单位是 PDF 单位，没乘缩放）', () => {
    assert.match(css,
      /font-size:\s*calc\(\s*var\(\s*--font-height\s*\)\s*\*\s*var\(\s*--total-scale-factor\s*\)\s*\)/,
      '少乘 --total-scale-factor ⇒ 2× 屏上字号只有一半，选一个字的框会把半个字框进去');
  });

  it('★ `--scale-x` / `--rotate` 必须在这里被消费（vendor 只写不读）', () => {
    // vendor 的 pdf.mjs 里只有 `setProperty("--scale-x", …)`；消费它们的 CSS 在官方
    // viewer 里，而 vendor 目录没有那份 CSS。不在这里消费，多字 span 的宽度与旋转文字都会歪。
    assert.match(css, /transform:\s*scaleX\(\s*var\(\s*--scale-x/);
    assert.match(css, /rotate\(\s*var\(\s*--rotate/);
  });

  it('★ 反向对照：把「乘缩放」写成只取 --font-height，上面那条必须变红', () => {
    const mutated = css.replace(
      /font-size:\s*calc\(\s*var\(\s*--font-height\s*\)\s*\*\s*var\(\s*--total-scale-factor\s*\)\s*\)/,
      'font-size: var(--font-height)',
    );
    assert.notEqual(mutated, css, '变异没生效 —— 这条反向对照是空操作');
    assert.doesNotMatch(mutated,
      /font-size:\s*calc\(\s*var\(\s*--font-height\s*\)\s*\*\s*var\(\s*--total-scale-factor\s*\)\s*\)/);
  });
});

describe('文字层的源码契约（BookReader.jsx）', () => {
  it('构造 TextLayer 之前先写好 `--total-scale-factor` 与容器宽高', () => {
    const at = bookReader.indexOf('new TextLayerCtor');
    assert.notEqual(at, -1, 'BookReader 里找不到 TextLayer 的构造 —— 文字层被拿掉了？');
    const before = bookReader.slice(Math.max(0, at - 1200), at);
    assert.match(before, /--total-scale-factor/, '没设 --total-scale-factor');
    assert.match(before, /textLayerMetrics/, '没走共用的尺寸判据（取整口径会与画布不一致）');
    assert.match(before, /\.style\.width/, '没给容器设宽度');
  });

  it('★ 换页/卸载必须 cancel 旧任务：它的续块会往新一页的容器里追加 span', () => {
    const at = bookReader.indexOf('new TextLayerCtor');
    const tail = bookReader.slice(at, at + 900);
    assert.match(tail, /textLayerTaskRef\.current\s*=\s*task/);
    assert.match(bookReader, /textLayerTaskRef\.current\?\.cancel\?\.\(\)/,
      'cleanup 里没有 cancel —— 快速翻页会把两页的字叠在同一个容器里');
  });

  it('★ 文字层失败不许把整页判成 error（位图还在，说得出口的只是「选不中」）', () => {
    const at = bookReader.indexOf('new TextLayerCtor');
    const block = bookReader.slice(at, bookReader.indexOf('} catch', at) + 200);
    assert.doesNotMatch(block, /setStatus\('error'\)/,
      '文字层失败时把 status 设成 error —— 用户会看到「这本书打不开」，而其实只是选不中');
  });

  it('★ 反向对照：判据真的在读那段代码（把构造换成别的写法就会红）', () => {
    const mutated = bookReader.replace('new TextLayerCtor({', 'new SomethingElse({');
    assert.notEqual(mutated, bookReader, '变异没生效');
    assert.equal(mutated.indexOf('new TextLayerCtor'), -1);
  });

  it('★ loadPdfjs 必须把**整个模块**交出来（收窄成白名单会静默丢掉 TextLayer）', () => {
    // 这条守的是一种**完全静默**的失效：`loadPdfjs` 若改成只挑几样导出
    //（`return { getDocument, GlobalWorkerOptions }`），`TextLayer` 就是 undefined；
    // 而 BookReader 那边的守卫是 `typeof TextLayerCtor === 'function'` —— 它会
    // **安安静静地跳过**文字层。界面照样能翻页、能看，只是一个字都选不中，
    // 也就是这一轮本来要修的那个症状原样复发，且没有任何报错。
    const pdfjs = stripComments(readFileSync(join(here, '..', 'src', 'client', 'pdfjs.js'), 'utf8'));
    assert.match(pdfjs, /return module;/);
    assert.doesNotMatch(pdfjs, /return\s*\{\s*getDocument/,
      '把模块收窄成 { getDocument, … } 之后 TextLayer 就没了 —— 文字层会静默不渲染');
  });
});

/**
 * 气泡的横向位置（0.25.8）。
 *
 * 起因：给电子书气泡加「问伴读」之后，气泡撑到 `max-width: 320px`，而选区在段首
 * （最常被划的那一句）时 `left = 中心` 减去半宽是负数 —— 气泡被包含块裁掉左端，
 * 而 flex 里第一个被牺牲的是那段摘录（按钮都是 `flex: 0 0 auto`）。
 * 截图证据：气泡上只剩「划线 笔记 问伴读 复制」，认不出划的是哪一句。
 */
describe('quoteBarLeft：气泡横向夹在页面内', () => {
  it('居中的选区原样使用它的中心', () => {
    assert.equal(
      quoteBarLeft(300),
      `clamp(${QUOTE_BAR_HALF + QUOTE_BAR_EDGE}px, 300px, calc(100% - ${QUOTE_BAR_HALF + QUOTE_BAR_EDGE}px))`,
    );
  });

  it('★ 下界是「半宽 + 边距」，不是「边距」（漏掉半宽就等于没夹）', () => {
    const hit = quoteBarLeft(10, { half: 120, edge: 6 }).match(/^clamp\((\d+)px/);
    assert.ok(hit, '读不出下界');
    assert.equal(Number(hit[1]), 126, '下界漏了半宽 —— 气泡照样会被裁掉左端');
  });

  it('上界与下界对称', () => {
    const bound = QUOTE_BAR_HALF + QUOTE_BAR_EDGE;
    const out = quoteBarLeft(500);
    assert.ok(out.startsWith(`clamp(${bound}px, `), `下界不对：${out}`);
    assert.ok(out.endsWith(`calc(100% - ${bound}px))`), `上界不对：${out}`);
  });

  it('读不出中心时退回 50%（宁可居中，也别写 NaN 进 CSS）', () => {
    assert.equal(quoteBarLeft(Number.NaN), '50%');
    assert.equal(quoteBarLeft(undefined), '50%');
    assert.equal(quoteBarLeft(null), '50%');
  });

  it('★ 半宽与 CSS 的 max-width 必须同源：320 / 2 = 160', () => {
    // 两处不同步时，气泡要么被裁（JS 半宽偏小）、要么离页边空一条（偏大）。
    assert.match(css, /\.npr-book-quotebar \{[^}]*max-width: min\(320px, 92%\)/, '气泡 max-width 变了');
    assert.equal(QUOTE_BAR_HALF * 2, 320, 'QUOTE_BAR_HALF 与 CSS 的 320 对不上了');
  });

  it('两个阅读器都走这个判据（别再直接写 left: quote.centerX）', () => {
    const bookEbook = stripComments(readFileSync(join(here, '..', 'src', 'client', 'BookEbook.jsx'), 'utf8'));
    for (const [name, src] of [['BookReader', bookReader], ['BookEbook', bookEbook]]) {
      assert.match(src, /left: quoteBarLeft\(quote\.centerX\)/, `${name} 没夹 —— 段首那句的气泡会被裁`);
      assert.doesNotMatch(src, /left: quote\.centerX/, `${name} 还留着未夹的原始坐标`);
    }
  });
});
