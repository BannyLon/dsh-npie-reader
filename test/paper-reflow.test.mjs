/**
 * D 档：页级按需翻译的**离线**那一半。
 *
 * ★ 不联网、不调模型、不碰 DOM：模型那一侧由 `library-routes.test.mjs` 的
 *   `/translate-page` 用例覆盖，这里只钉住「分段 → 按 id 对齐 → 重排 → 坐标换算」
 *   这条纯计算链路。单页探针跑的是真 PDF + 真浏览器，那是**质量**验证；
 *   这个文件跑的是**回归**验证，两者不能互相替代。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { layoutPage, overlayBlocksOf, pageParagraphs, translationsOf, worthTranslating } from '../src/client/paper-reflow/index.js';
import { parsePageTranslations } from '../src/host/ai.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 模型返回的 JSON → 按 id 对齐
// ---------------------------------------------------------------------------

describe('模型返回的逐段译文', () => {
  const ids = ['p1', 'p2', 'p3'];

  it('正常数组：按 id 原样带回，顺序不重要', () => {
    const out = parsePageTranslations('[{"id":"p2","text":"第二段"},{"id":"p1","text":"第一段"}]', ids);
    assert.deepEqual(out, [
      { id: 'p2', text: '第二段' },
      { id: 'p1', text: '第一段' },
    ]);
  });

  it('★ 围栏 + 前后废话仍要能解析（模型很爱写「好的，这是译文」）', () => {
    const raw = '好的，这是译文：\n```json\n[{"id":"p1","text":"注意力就是你所需要的一切"}]\n```\n希望有帮助。';
    assert.deepEqual(parsePageTranslations(raw, ids), [
      { id: 'p1', text: '注意力就是你所需要的一切' },
    ]);
  });

  it('★ 编造 id / 重复 id / 空译文一律丢掉 —— 错配比漏翻严重得多', () => {
    const raw = JSON.stringify([
      { id: 'p1', text: '第一段' },
      { id: 'p1', text: '重复的那条' },
      { id: '编的', text: '不属于这一页' },
      { id: 'p2', text: '   ' },
      { id: 'p3', text: '第三段' },
    ]);
    assert.deepEqual(parsePageTranslations(raw, ids), [
      { id: 'p1', text: '第一段' },
      { id: 'p3', text: '第三段' },
    ]);
  });

  it('解析不出来 ⇒ 空数组（调用方据此报错，不拿原文冒充译文）', () => {
    assert.deepEqual(parsePageTranslations('抱歉，我无法翻译这一页。', ids), []);
    assert.deepEqual(parsePageTranslations('[{id: p1}]', ids), []);
    assert.deepEqual(parsePageTranslations('{"id":"p1","text":"不是数组"}', ids), []);
    assert.deepEqual(parsePageTranslations('[]', ids), []);
    // 正对照：确认上面的 ids 本身不是空集，否则「过滤」可能是假绿。
    assert.ok(ids.length > 0);
  });
});

// ---------------------------------------------------------------------------
// IR + 译文 → Map → 排版 → 渲染块
// ---------------------------------------------------------------------------

describe('重排链路（纯数据）', () => {
  const ir = { index: 0, width: 612, height: 792, paragraphs: [{ id: 'a' }, { id: 'b' }], obstacles: [] };

  it('translationsOf 只认这一页真实存在的段落 id', () => {
    const map = translationsOf(ir, [
      { id: 'a', text: '甲' },
      { id: 'a', text: '重复的甲' },
      { id: '幽灵段', text: '别铺到我身上' },
      { id: 'b', text: '  ' },
    ]);
    assert.equal(map.size, 1);
    assert.equal(map.get('a'), '甲');
    // 正对照：一条都没对上时是空 Map（调用方会判成「没翻成」）。
    assert.equal(translationsOf(ir, [{ id: '别的', text: 'x' }]).size, 0);
  });

  it('★ 坐标换算：box 乘 scale，unit 相对 sourceBox 且基线要抬一个字身', () => {
    const layout = {
      id: 'a', fits: true, scale: 0.9,
      sourceBox: { x: 50, y: 100, w: 200, h: 40 },
      units: [{ text: '中', x: 60, y: 120, fontSize: 10, width: 10, font: 'cjkBold' }],
    };
    const [block] = overlayBlocksOf({ paragraphs: [layout] }, 2);
    assert.deepEqual(block.box, { left: 100, top: 200, width: 400, height: 80 });
    assert.deepEqual(block.units[0], {
      text: '中',
      left: 20,                 // (60 - 50) * 2
      top: 24,                  // (120 - 100 - 10*0.8) * 2
      fontSize: 20,
      bold: true,
      italic: false,
    });
    assert.equal(block.fits, true);
  });

  it('scale 不合法时退化为 1，而不是把整层缩成 0（防白屏）', () => {
    const layout = { id: 'a', fits: false, scale: 1, sourceBox: { x: 0, y: 0, w: 10, h: 10 }, units: [] };
    const [block] = overlayBlocksOf({ paragraphs: [layout] }, 0);
    assert.deepEqual(block.box, { left: 0, top: 0, width: 10, height: 10 });
    assert.equal(block.fits, false);
    assert.deepEqual(overlayBlocksOf(null, 1), []);
  });
});

// ---------------------------------------------------------------------------
// 用假 pdf.js 页真跑一遍「取字 → 分段 → 排版」
// ---------------------------------------------------------------------------

/** 三行同栏文字，最后一行短（探针里「段尾短行」的形状）。 */
function fakePdfPage() {
  const lines = [
    ['Attention is all you need', 50, 700, 180],
    ['and the transformer architecture', 50, 684, 210],
    ['is simple.', 50, 668, 60],
  ];
  return {
    getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({
      styles: { f1: { fontFamily: 'sans-serif', ascent: 0.75, descent: -0.2 } },
      items: lines.map(([str, x, y, width]) => ({
        str, width, height: 10, fontName: 'f1', hasEOL: false,
        transform: [10, 0, 0, 10, x, y],
      })),
    }),
  };
}

/** 固定字宽的假字体度量，让排版算法在 Node 里也能跑（不依赖 canvas）。 */
function fakeFonts() {
  const font = {
    encodeText: (text) => text,
    widthOfTextAtSize: (text, size) => Array.from(text).length * size * 0.5,
    heightAtSize: (size) => size,
  };
  return Object.fromEntries(
    ['regular', 'bold', 'italic', 'boldItalic', 'cjk', 'cjkBold'].map((key) => [key, font]),
  );
}

describe('★ 端到端：假 PDF 页真的能走完分段与排版', () => {
  it('pageParagraphs 给出段落，layoutPage + overlayBlocksOf 给出可渲染的块', async () => {
    const { ir, paragraphs } = await pageParagraphs(fakePdfPage(), 0);
    assert.equal(ir.width, 612);
    assert.equal(ir.height, 792);
    assert.ok(paragraphs.length > 0, '一段都没分出来 —— 分段算法或假数据不对');
    assert.ok(paragraphs.every((item) => item.id !== '' && item.text.length >= 2));
    // 正对照：原文确实进了段落，不是空跑。
    assert.ok(paragraphs.some((item) => item.text.includes('Attention')));

    const translations = translationsOf(ir, paragraphs.map((item) => ({ id: item.id, text: `译文：${item.id}` })));
    assert.ok(translations.size > 0, '按 id 对齐失败 —— 译文会整页错配');
    const blocks = overlayBlocksOf(layoutPage(ir, translations, fakeFonts()), 1.5);
    assert.ok(blocks.length > 0, '排版没产出任何块');
    for (const block of blocks) {
      assert.ok(Number.isFinite(block.box.left) && Number.isFinite(block.box.top));
      assert.ok(block.box.width > 0 && block.box.height > 0, '白底块尺寸非法');
      assert.ok(block.units.length > 0, '这一块没有可铺的字');
      for (const unit of block.units) {
        assert.ok(Number.isFinite(unit.left) && Number.isFinite(unit.top) && unit.fontSize > 0);
      }
    }
  });

  it('★ 字体度量缺失（ascent=descent=0）不能让整页退化成「每行零高一段」', async () => {
    /**
     * 真实案例（2026-11-14）：`p18vdokd` 第 2 页 85 个 text item 里有 **70 个**
     * `text.styles[fontName].ascent === 0 && descent === 0` —— 那是 pdf.js
     * 「这个字体我没解析出度量」的信号（非嵌入的标准 14 字体：Times-Italic 等）。
     *
     * 旧代码把它们当有效值收下，于是：
     *  ① 字高 0 ⇒ `regionsFromRuns` 用 `height > 0` 过滤，这些字**进不了区域检测**；
     *  ② 全部落进 fallback 的逐行分组 ⇒ 一页 57 段，每段框高 0；
     *  ③ 排版 `fits` 必然 false ⇒ 一个白底块都铺不出来 ⇒ 用户看到「翻译完还是英文」；
     *  ④ 57 段要分两批请求 ⇒ 一页跑满 180 秒超时。
     * 三件事是同一个根因，所以判据盯的是「字高」，不是最终画面。
     */
    const page = {
      getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
      getTextContent: async () => ({
        // 无度量字体 + 一段有度量的（真实页面两种都有）
        styles: { f0: { fontFamily: 'serif', ascent: 0, descent: 0 }, f1: { fontFamily: 'serif', ascent: 0.75, descent: -0.2 } },
        items: [
          ['First body line without metrics', 50, 700, 240, 'f0'],
          ['second line of the same paragraph', 50, 684, 250, 'f0'],
          ['third line, still the same paragraph', 50, 668, 260, 'f0'],
          ['A heading with proper metrics', 50, 640, 200, 'f1'],
        ].map(([str, x, y, width, fontName]) => ({
          str, width, height: 10, fontName, hasEOL: false, transform: [10, 0, 0, 10, x, y],
        })),
      }),
    };

    const { collectPage } = await import('../src/client/paper-reflow/adapter.mjs');
    const { buildPageIR } = await import('../src/client/paper-reflow/region-build.mjs');
    const payload = await collectPage(page, 0);
    const zero = payload.chars.filter((c) => !(c.box.h > 0));
    assert.equal(zero.length, 0, `还有 ${zero.length} 个字高为 0 —— 它们既进不了区域检测，也排不进任何段框`);

    const ir = buildPageIR(payload);
    assert.ok(ir.paragraphs.length > 0, '一段都没分出来');
    const flat = ir.paragraphs.filter((p) => !(p.box.h > 0));
    assert.equal(flat.length, 0, `有 ${flat.length} 段框高 0 —— 排版一律 fits=false，译文一个字都画不出来`);
    // 反向对照：三行同一段必须合并成一段，不能「一行一段」（一行装不下中文，只会留英文）。
    assert.ok(ir.paragraphs.length < 4, `分成了 ${ir.paragraphs.length} 段 —— 逐行成段会让请求体暴涨、排版全部放不下`);
  });

  it('一段都不给译文 ⇒ 一个块都不铺（不能拿白底盖掉整页原文）', async () => {
    const { ir } = await pageParagraphs(fakePdfPage(), 0);
    const blocks = overlayBlocksOf(layoutPage(ir, new Map(), fakeFonts()), 1);
    assert.deepEqual(blocks, []);
  });
});

// ---------------------------------------------------------------------------
// 许可合规（MIT 移植部分）
// ---------------------------------------------------------------------------

describe('移植代码的许可', () => {
  it('MOTIF-LICENSE.txt 必须在，且写明 MIT 与原版权人', () => {
    const path = join(root, 'src/client/paper-reflow/MOTIF-LICENSE.txt');
    assert.ok(existsSync(path), '移植了 motif 的实现却没带许可证');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /MIT License/);
    assert.match(text, /Copyright \(c\) 2026 poco-ai/);
  });

  it('七个移植模块都在（少一个会在构建时才炸）', () => {
    for (const name of ['types', 'reading-order', 'layout', 'fonts', 'regions', 'region-build', 'adapter']) {
      assert.ok(existsSync(join(root, `src/client/paper-reflow/${name}.mjs`)), `缺 ${name}.mjs`);
    }
  });
});

// ---------------------------------------------------------------------------
// 接线守卫（源码级）
// ---------------------------------------------------------------------------

/**
 * ★ 这一档穿过**五层**：阅读器按钮 → 译文层组件 → 客户端 API → 路由 → 模型。
 *   任何一层漏接，用户的感受都是同一句「点了翻译本页没反应」，而且不报错。
 *   上一轮「划词翻译没看到」已经栽过一次，所以这里逐层读源码钉住。
 */
describe('D 档五层接线（源码级）', () => {
  const source = (path) => readFileSync(join(root, path), 'utf8');

  it('阅读器：逐页与整本两颗开关都常驻顶部胶囊，译文层真的挂上了', () => {
    const reader = source('src/client/BookReader.jsx');
    assert.ok(reader.includes("from './PaperTranslateLayer.jsx'") && reader.includes('PaperTranslateLayer'),
      '没导入译文层');
    assert.ok(reader.includes('翻译本页') && reader.includes('翻译全本')
      && reader.includes('startWholeBookTranslation'), '下拉里缺逐页 / 整本入口');
    // ★ 用户 2026-11-06「合二为一」：只留一颗胶囊 + 一个下拉，两条途径都在菜单里。
    assert.ok(reader.includes('aria-haspopup="menu"') && reader.includes('npr-book-translate-menu'),
      '没有合成一颗下拉按钮');
    assert.ok(reader.includes('attachMenuDismiss(document'), '点外面关菜单没走共用判据');
    assert.ok(source('src/client/refinements.css').includes('.npr-book-translate-menu {'),
      '下拉菜单没有 CSS');
    // ★ 用户 2026-11-07「还有有中英查看的按钮」：语言切换必须在工具栏一次点到，
    //   不能再藏进下拉（上一版就是这样，对照原文要开菜单、点一项，来回好几遍）。
    assert.ok(reader.includes('中/英'), '胶囊里没有中英查看按钮');
    assert.ok(reader.includes('setTranslateOn(value => !value)'), '中英按钮没接到开关');
    // ★ 「翻译过的要有记录」：菜单要说出本机已存几页。
    assert.ok(reader.includes('npr-book-translate-note') && reader.includes('translatedPageCount('),
      '下拉里没说清本机存了几页译文');
    assert.ok(source('src/client/refinements.css').includes('.npr-book-translate-note {'),
      '「已存 N 页」没有 CSS');
    assert.ok(reader.includes('loadBookTranslations(book.id)'),
      '打开书时没预载缓存 —— 菜单报不出已存页数，首翻也多一跳');
    // ★ 性能契约：阅读器只订阅状态字符串，逐页进度交给独立小组件订阅。
    assert.ok(reader.includes('useWholeBookState(') && !reader.includes('useWholeBookJob('),
      'BookReader 订阅了逐页进度 —— 整本跑几十页会把整棵阅读器重渲染几十次');
    assert.ok(reader.includes('<PaperWholeBookJobBar'), '进度条没挂上');
    assert.ok(reader.includes('setPageView({ pdfPage, scale: nextScale, page })'),
      '渲染时没把当前页交给译文层 —— 它会拿不到 pdf.js 页对象');
    assert.ok(reader.includes('active={translateOn}'), '译文层没挂到 JSX 上');
    // 正对照：覆盖层样式确实在，否则组件渲染出来是一堆没有定位的 span。
    assert.ok(source('src/client/refinements.css').includes('.npr-book-translation {'),
      '覆盖层没有 CSS');
    assert.ok(source('src/client/refinements.css').includes('.npr-book-whole-job {'),
      '整本进度条没有 CSS');
  });

  it('译文层：共用缓存入口 + 只订阅当前页；缩放只重排不重新调模型', () => {
    const layer = source('src/client/PaperTranslateLayer.jsx');
    assert.ok(layer.includes('ensurePageTranslation('), '没走共用的按页翻译入口');
    assert.ok(layer.includes('subscribePageTranslation'), '没订阅这一页的译文更新');
    assert.ok(layer.includes('[entry, pageView?.scale]'), 'blocks 没随 scale 重排');
    // ★ 反例：effect 依赖里若带上 scale，缩放一次就会重新调一次模型。
    assert.ok(!layer.includes('pageView.scale]'), 'effect 依赖里混进了 scale');
    // ★ 依赖表**以这四个开头的顺序**不能动（bookId 掉了就漏掉后台译好的页）。
    //   0.78.0 又追加了 attempt / retry（暂停之后要能重试），所以只钉开头、
    //   不钉结尾 —— 钉整串的话每加一个勾子就得改一次这条守卫。
    const deps = /\[active, key, version, bookId[^\]]*\]/.exec(layer);
    assert.ok(deps !== null, 'effect 依赖被改了，可能漏掉后台译好的页');
    assert.ok(/attempt/.test(deps[0]) && /retry/.test(deps[0]),
      '暂停 / 重试的勾子掉出了依赖表：按了暂停这一页就再也点不动');
  });

  it('★ 胶囊钉在阅读区中心：定位基准是 stage 的兄弟，不是滚动容器里的书页', () => {
    // 用户 2026-11-14：「改成钉在阅读区中心（不随页面滚动）」。
    // 上一版胶囊画在书页里（`.npr-book-translation` → sheet → `.npr-book-stage`），
    // 而 stage 是 `overflow: auto` —— 页面一滚它就走，页面比窗口高时滚出视野。
    const reader = source('src/client/BookReader.jsx');
    const layer = source('src/client/PaperTranslateLayer.jsx');
    const css = source('src/client/refinements.css');
    const indentOf = (line) => line.length - line.trimStart().length;

    // ① 落脚层存在，并且与 stage **同层**（同一缩进 = `.npr-book-view` 的直接子节点）。
    //    只断「字符串存在」不够：贴进 stage 里它照样存在，而那样就又跟着滚了。
    const lines = reader.split('\n');
    const pinsLine = lines.find(line => line.includes('className="npr-book-pins"'));
    const stageLine = lines.find(line => line.includes('className="npr-book-stage"'));
    assert.ok(pinsLine !== undefined, '没有 `.npr-book-pins` 落脚层 —— 胶囊只能画在书页里，一滚就跟着走');
    assert.ok(stageLine !== undefined, '找不到 stage —— 说明阅读区结构变了，这条守卫失去基准');
    assert.equal(indentOf(pinsLine), indentOf(stageLine),
      '落脚层和 stage 不在同一层：放进滚动容器里，胶囊必然跟着书页滚走');

    // ② 这块画布真的交给了译文层；③ 译文层真的用了 portal（不是「新建了一个窗口变量」）。
    assert.ok(reader.includes('pinHost={pinHost}'), '落脚层没交给译文层');
    assert.ok(layer.includes('createPortal(capsule, pinHost)'), '胶囊没走 portal');
    // ④ 拿不到落脚点时退回原画法：服务端渲染不支持 portal，首帧 ref 还是 null。
    assert.ok(layer.includes('pinHost === null ? capsule'), '缺 fallback：SSR / 首帧会把这条提示直接丢掉');

    // ⑤ CSS：这一层不参与布局、不吃点击；胶囊在那层里居中。
    const pins = /\.npr-book-pins\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.ok(/position:\s*absolute/.test(pins) && /inset:\s*0/.test(pins), '落脚层没铺满阅读区');
    assert.ok(/pointer-events:\s*none/.test(pins),
      '落脚层会吃掉书页的拖选与链接点击（它铺满整个阅读区）');
    const capsuleCss = /\.npr-book-translation-status\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.ok(/left:\s*50%/.test(capsuleCss) && /top:\s*50%/.test(capsuleCss), '胶囊不在正中');
    assert.ok(/pointer-events:\s*auto/.test(capsuleCss),
      '胶囊自己没把 pointer-events 打开 —— 暂停 / 关闭两颗按钮点不动');
  });

  it('共用缓存：两种模式走同一条链路，落盘且有上限与在途去重', () => {
    const mod = source('src/client/paper-translation.js');
    for (const needle of [
      'export function ensurePageTranslation(', 'export function loadBookTranslations(',
      'export function startWholeBookTranslation(', 'export function stopWholeBookTranslation(',
      'putPageTranslation(', 'clearPageTranslations(', 'CACHE_LIMIT', 'INFLIGHT',
      'sameParagraphs(', 'WHOLE_BOOK_MAX_PAGES',
    ]) {
      assert.ok(mod.includes(needle), `共用缓存缺 ${needle}`);
    }
    // ★ 整本模式必须调 ensure，而不是自己再写一遍「取字 + 调模型」。
    assert.ok(mod.includes('await ensurePageTranslation({ bookId, pdfPage, page })'),
      '整本模式绕开了共用入口 —— 逐页翻过的页会被重复计费');
    assert.ok(mod.includes('hasPageTranslation(bookId, page)'), '整本模式没跳过已译的页');
  });

  it('落盘三层：store / 路由 / service 与客户端 API 都对得上', () => {
    const store = source('src/host/page-translation-store.js');
    assert.ok(store.includes('export function createPageTranslationStore('), '缺宿主存储');
    assert.ok(store.includes('isBookId(bookId)'), 'bookId 没过白名单 —— 路径穿越');
    const routes = source('src/host/library-routes.js');
    assert.ok(routes.includes('/page-translation/'), '路由没注册');
    assert.ok(routes.includes('pageTranslationStore.putPage'), '路由没写单页');
    const service = source('src/host/service.js');
    assert.ok(service.includes('pageTranslationStore: this.pageTranslationStore'), 'service 没注入 store');
    const api = source('src/client/library-api.js');
    assert.ok(api.includes('/page-translation/'), '客户端 API 没接缓存路由');
  });

  it('宿主三层：模型函数 / service 方法 / 路由都在，且用 dsh 配置的模型', () => {
    const ai = source('src/host/ai.js');
    assert.ok(ai.includes('export async function translatePageParagraphs'), '模型侧没接');
    assert.ok(ai.includes('complete(\n    ctx,'), '没走 complete（重试 / 超时闸门会丢）');
    const service = source('src/host/service.js');
    assert.ok(service.includes('async translatePageParagraphs(payload = {})'), 'service 方法缺失');
    assert.ok(service.includes('{ model: this.aiModel() }'), '没用 dsh 里配置的模型');
    assert.ok(service.includes('translatePageParagraphs: payload => this.translatePageParagraphs(payload)'),
      '没注册进路由 deps —— 路由会一直回 501');
    const routes = source('src/host/library-routes.js');
    assert.ok(routes.includes("rest === '/translate-page'"), '路由没注册');
    assert.ok(source('src/client/library-api.js').includes("jsonPost('/translate-page'"),
      '客户端 API 打错了路径');
  });
});

// ---------------------------------------------------------------------------
// 0.71.2：用户真机截图纠偏 —— 块不再重叠、放不下就不画
// ---------------------------------------------------------------------------

/** 造一页：`items` 是 [文字, x, y, 宽度, 字号]，返回 pdf.js 形状的假页。 */
function pageOf(items) {
  return {
    getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({
      styles: { f1: { fontFamily: 'sans-serif', ascent: 0.75, descent: -0.2 } },
      items: items.map(([str, x, y, width, size = 10]) => ({
        str, width, height: size, fontName: 'f1', hasEOL: false,
        transform: [size, 0, 0, size, x, y],
      })),
    }),
  };
}

async function irOf(items) {
  const { collectPage } = await import('../src/client/paper-reflow/adapter.mjs');
  const { buildPageIR } = await import('../src/client/paper-reflow/region-build.mjs');
  return buildPageIR(await collectPage(pageOf(items), 0));
}

describe('0.71.2 段落切分与渲染契约（真机截图纠偏）', () => {
  const source = (path) => readFileSync(join(root, path), 'utf8');

  it('★ 块只画 fits：放不下的段保留原文，不能溢到下一段', () => {
    const layout = {
      id: 'a', fits: false, scale: 0.1,
      sourceBox: { x: 0, y: 0, w: 10, h: 10 },
      units: [{ text: '挤', x: 1, y: 5, fontSize: 3, width: 3, font: 'cjk' }],
    };
    const [block] = overlayBlocksOf({ paragraphs: [layout] }, 1);
    assert.equal(block.fits, false, 'fits 字段被吞了 —— 组件就没法跳过它');
    // 逐字坐标契约仍在（行宽 / 行距 / 首行缩进都由 motif 算好，渲染层只摆字）。
    assert.equal(block.units[0].text, '挤');
    assert.ok(Number.isFinite(block.units[0].left) && Number.isFinite(block.units[0].top));
    // 组件必须真的过滤，而不是「打印一条 is-tight 就照样铺」。
    assert.ok(source('src/client/PaperTranslateLayer.jsx').includes('blocks.filter((block) => block.fits)'),
      '译文层没有按 fits 过滤 —— 放不下的段会盖住原文并溢出');
    assert.ok(!source('src/client/PaperTranslateLayer.jsx').includes('npr-book-translation-flow'),
      '又在框内交给浏览器流式排版了 —— 那样 fits 判据失效');
  });

  it('★ 纸色 / 字色跟 data-tint 走，逐字 span 不许重新断行', () => {
    const css = source('src/client/refinements.css');
    for (const tint of ['sepia', 'mint', 'night']) {
      assert.ok(css.includes(`.npr-book[data-tint="${tint}"] { --npr-translation-paper:`),
        `${tint} 档没定义译文层底色`);
    }
    assert.ok(css.includes('background: var(--npr-translation-paper)'), '遮罩没用纸色变量');
    assert.ok(css.includes('.npr-book-translation-block > span'), '逐字 span 没有 CSS');
    // `white-space: pre` 是硬要求：浏览器一旦重新断行，motif 算好的行宽就不再成立。
    assert.ok(/\.npr-book-translation-block > span \{[^}]*white-space: pre/.test(css),
      '逐字 span 允许浏览器换行 —— 版面会重新排队');
    assert.ok(!css.includes('npr-book-translation-flow'), '流式排版的旧样式还在');
  });

  it('★ 居中标题：两行并成一段，并标记 center（否则标题被切成两段）', async () => {
    // 两行都居中于 x=306：左边界不同、中心相同 —— 这是「居中块」的形状。
    const ir = await irOf([
      ['DeepSeek-VL: Towards Real-World', 156, 700, 300, 16],
      ['Vision-Language Understanding', 216, 682, 180, 16],
    ]);
    assert.equal(ir.paragraphs.length, 1, `标题被切成了 ${ir.paragraphs.length} 段`);
    assert.equal(ir.paragraphs[0].center, true, '没认出居中块 —— 重排会变成左对齐');
    assert.match(ir.paragraphs[0].source, /Towards Real-World Vision-Language Understanding/);
  });

  it('★ 两端对齐的正文不能被判成居中（左边界齐平）', async () => {
    const ir = await irOf([
      ['alpha beta gamma delta epsilon', 72, 700, 400, 11],
      ['zeta eta theta iota kappa', 72, 686, 400, 11],
      ['lambda mu nu', 72, 672, 400, 11],
    ]);
    assert.equal(ir.paragraphs.length, 1);
    assert.equal(ir.paragraphs[0].center, false,
      '正文被判成居中 ⇒ 逐行居中后左边缘会变成锯齿轮廓');
  });

  it('★ 上标归行：作者区不再以 "1† 1‡" 开头', async () => {
    const ir = await irOf([
      ['Haoyu Lu', 200, 700, 60, 10],
      ['1', 261, 697, 3.5, 7],          // 上标：字号小、基线略高
      ['Wen Liu', 270, 700, 50, 10],
      ['1', 321, 697, 3.5, 7],
    ]);
    const p = ir.paragraphs.find((item) => item.source.includes('Haoyu'));
    assert.ok(p, '作者行没成段');
    assert.ok(p.source.startsWith('Haoyu'), `上标被排在段首了：${p.source}`);
    assert.equal(p.source, 'Haoyu Lu1 Wen Liu1', '上标没紧跟它所属的姓名');
  });

  it('★ 首行缩进的正文不能被判成居中（左边缘会变成锯齿轮廓）', async () => {
    // 首行缩进 17pt ⇒ 左边界「参差」；各行中心又几乎相同 —— 只看这两条就会误判。
    // 真正的分别：缩进段落每行都贴右边界，居中块只有最宽那一行贴。
    const ir = await irOf([
      ['Indented first line of the paragraph', 88, 700, 436, 11],
      ['second line reaches the right margin', 71, 686, 453, 11],
      ['third line also reaches the margin', 71, 672, 453, 11],
    ]);
    assert.equal(ir.paragraphs.length, 1);
    assert.equal(ir.paragraphs[0].center, false, '缩进正文被判成居中了');
  });

  it('★ center 段落逐行居中：每行中心落在段框中心', async () => {
    const { layoutParagraph } = await import('../src/client/paper-reflow/layout.mjs');
    const p = {
      id: 'a', pageIndex: 0, box: { x: 100, y: 100, w: 200, h: 60 },
      style: { size: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } },
      firstLineIndent: 0, center: true, formulas: [], styles: {},
    };
    const layout = layoutParagraph(p, '居中标题', { width: 612, height: 792, paragraphs: [p], obstacles: [] }, fakeFonts(), 1, []);
    const left = Math.min(...layout.units.map((u) => u.x));
    const right = Math.max(...layout.units.map((u) => u.x + u.width));
    assert.ok(Math.abs((left + right) / 2 - 200) < 0.01, `没居中：中心在 ${((left + right) / 2).toFixed(1)}`);
  });

  it('★ 段框互斥：任意两段的原文框不许重叠（重叠就是两块中文叠着）', async () => {
    const ir = await irOf([
      ['First paragraph line one', 72, 700, 400, 11],
      ['and its second line', 72, 686, 200, 11],
      ['Second paragraph starts here', 72, 668, 400, 11],
      ['page footnote text', 72, 640, 150, 9],
    ]);
    for (let i = 0; i < ir.paragraphs.length; i += 1) {
      for (let j = i + 1; j < ir.paragraphs.length; j += 1) {
        const a = ir.paragraphs[i].box;
        const b = ir.paragraphs[j].box;
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        assert.ok(!(w > 0.5 && h > 0.5), `段框重叠：${ir.paragraphs[i].id} / ${ir.paragraphs[j].id}`);
      }
    }
  });

  it('★ 不值得翻的段不进模型：已是中文 / 图内小字', () => {
    assert.equal(worthTranslating({ source: '面向真实世界的视觉-语言理解', style: { size: 11 } }), false,
      '中文段落被送去翻译了 —— 白花钱，还会在图例框里重排一遍');
    assert.equal(worthTranslating({ source: 'Prompt', style: { size: 4.9 } }), false,
      '4.9pt 的图例小字被送去翻译了 —— 框只有 5pt 高，字会被裁掉');
    assert.equal(worthTranslating({ source: 'Attention is all you need', style: { size: 11 } }), true);
    // 正对照：正常正文不能被误杀，否则整页都不翻。
    assert.equal(worthTranslating({ source: 'We present DeepSeek-VL, an open-source model', style: { size: 10 } }), true);
  });
});

// ---------------------------------------------------------------------------
// 公式 / 链接掩码（0.71.1 起，判据来自 agentero motif 的 host/translation/mask.ts）
// ---------------------------------------------------------------------------

describe('公式 / 链接掩码接进模型链路', () => {
  const source = (path) => readFileSync(join(root, path), 'utf8');

  it('★ 掩码三层：发出去前掩、回来还原、占位符对不上就丢这一段的译文', () => {
    const ai = source('src/host/ai.js');
    assert.ok(ai.includes("from './translation-mask.js'"), '没引入掩码模块');
    assert.ok(ai.includes('maskInlineTokens(item.text)'), '发给模型前没掩码');
    assert.ok(ai.includes('restoreInlineTokens(item.text'), '模型回来后没还原');
    assert.ok(ai.includes('restored.missing > 0 || restored.invalid'), '占位符丢了没丢弃该段译文');
    assert.ok(ai.includes('⟦数字⟧'), '提示词没要求模型原样保留占位符');
    const mask = source('src/host/translation-mask.js');
    assert.ok(mask.includes('MOTIF-LICENSE.txt'), 'MIT 移植没标注许可位置');
    assert.ok(existsSync(join(root, 'src/client/paper-reflow/MOTIF-LICENSE.txt')), '许可全文不在');
  });
});
