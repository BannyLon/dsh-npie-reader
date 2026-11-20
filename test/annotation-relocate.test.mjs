/**
 * A7 · 划线锚点按 `quote` 重定位（报告 §3-A7）。
 *
 * 补的是「注释承诺了、实现没有」那一类债：字段在、注释在、行为不在。
 * 所以这里的判据**不靠 grep 源码里有没有这些字**，而是真跑：
 *   ① 插入一页 ⇒ 划线跟到新页号，且新区间逐字（去空白）等于摘录；
 *   ② 摘录在全书出现 3 次 ⇒ 报歧义，**不许随便挑一处**；
 *   ③ 失配项不参与渲染、界面要如实说话；
 *   ④ 投影只在内存里，磁盘上的坐标一个字节都不改。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import * as esbuild from 'esbuild';
import {
  BLOCK_SEP, MISMATCH, pageTextOfBlocks, relocateAnnotations, withoutMismatch,
} from '../src/annotation-relocate.js';
import { createAnnotationStore } from '../src/host/annotation-store.js';
import { RssService } from '../src/host/service.js';
import { normalizeAnnotation, normalizeAnnotations } from '../src/client/annotations.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELOC = join(root, 'src', 'annotation-relocate.js');
const QUOTE = '磨坊主妇把门闩上';

const base = (over = {}) => ({
  id: 'a1', page: 3, start: 4, end: 4 + QUOTE.length, quote: QUOTE,
  note: '', tone: 'yellow', createdAt: 1, updatedAt: 1, ...over,
});

const compact = text => String(text ?? '').replace(/\s/gu, '');
const pagesOfBlocks = list => list.map((blocks, index) => ({ page: index + 1, text: pageTextOfBlocks(blocks) }));

/** 旧正文：摘录在第 3 节。新正文：在第 3 节前插入一整页 ⇒ 摘录挪到第 4 节。 */
const OLD_BLOCKS = [
  [{ x: '第一章 起风了' }],
  [{ x: '河水流过村口' }],
  [{ x: `前缀文字${QUOTE}后缀文字` }],
];
const NEW_BLOCKS = [
  [{ x: '第一章 起风了' }],
  [{ x: '河水流过村口' }],
  [{ x: '新插入的一整页，讲的是别的事情，和磨坊无关' }],
  [{ x: `前缀文字${QUOTE}后缀文字` }],
];

// ---------------------------------------------------------------- 纯函数

describe('A7 · 重定位：锚点仍准时一个字段都不动', () => {
  it('原区间逐字等于摘录 ⇒ 原样返回（只多一个空的 mismatch）', () => {
    const item = base();
    const result = relocateAnnotations([item], pagesOfBlocks(OLD_BLOCKS));
    assert.equal(result.items[0].page, 3);
    assert.equal(result.items[0].start, item.start);
    assert.equal(result.items[0].end, item.end);
    assert.equal(result.items[0].mismatch, MISMATCH.NONE);
    assert.deepEqual(result.relocated, []);
    assert.deepEqual(result.mismatched, []);
  });

  it('选区存盘时压过空白 ⇒ 不把「甲  乙」误判成失配', () => {
    const text = '甲  乙 丙';
    const item = base({ page: 1, start: 0, end: 4, quote: '甲 乙' });
    const result = relocateAnnotations([item], [{ page: 1, text }]);
    assert.equal(result.items[0].mismatch, MISMATCH.NONE);
    assert.equal(result.items[0].page, 1);
    assert.equal(result.items[0].start, 0, '不该被重定位到别处');
  });

  it('纯函数不改动入参', () => {
    const item = base({ page: 99 });
    const pages = pagesOfBlocks(NEW_BLOCKS);
    const snapshot = JSON.stringify({ item, pages });
    relocateAnnotations([item], pages);
    assert.equal(JSON.stringify({ item, pages }), snapshot);
  });
});

describe('A7 · 重定位：报告的两条硬判据', () => {
  it('★ 第 3 节前插入一页 ⇒ 跟到第 4 页，且高亮文字逐字等于摘录', () => {
    const item = base();
    const result = relocateAnnotations([item], pagesOfBlocks(NEW_BLOCKS));
    const moved = result.items[0];
    assert.equal(moved.mismatch, MISMATCH.NONE, '不该被标成失配');
    assert.equal(moved.page, 4, `页码没跟上：${moved.page}`);
    const text = pageTextOfBlocks(NEW_BLOCKS[3]);
    assert.equal(compact(text.slice(moved.start, moved.end)), compact(QUOTE), '画到的不是原来那句话');
    assert.equal(text.slice(moved.start, moved.end), QUOTE, '新区间应精确覆盖摘录');
    assert.deepEqual(result.relocated, [{ id: 'a1', from: 3, to: 4 }]);
  });

  it('★ 摘录在全书出现 3 次 ⇒ 报歧义，不挑第一个凑数', () => {
    const pages = [
      { page: 1, text: `${QUOTE}甲` },
      { page: 2, text: `乙${QUOTE}` },
      { page: 3, text: `丙${QUOTE}丁` },
    ];
    const item = base({ page: 9 });
    const result = relocateAnnotations([item], pages);
    assert.equal(result.items[0].mismatch, MISMATCH.AMBIGUOUS);
    assert.equal(result.items[0].page, 9, '歧义时不许改页码');
    assert.equal(result.items[0].start, item.start, '歧义时不许改起点');
    assert.deepEqual(result.relocated, []);
    assert.equal(result.mismatched[0].mismatch, MISMATCH.AMBIGUOUS);
  });

  it('全书都找不到 ⇒ 标 missing，不是静默丢掉这一条', () => {
    const result = relocateAnnotations([base()], [{ page: 1, text: '完全无关的一段文字' }]);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].mismatch, MISMATCH.MISSING);
    assert.deepEqual(result.mismatched, [{ id: 'a1', mismatch: MISMATCH.MISSING }]);
  });

  it('跨块摘录（含换行）⇒ 重定位后新区间覆盖 BLOCK_SEP，拼回去不丢字', () => {
    const blocks = [{ x: '前半句' }, { x: '后半句' }];
    const text = pageTextOfBlocks(blocks);
    assert.equal(text, `前半句${BLOCK_SEP}后半句`);
    const quote = '前半句 后半句';
    const result = relocateAnnotations([base({ page: 9, quote })], [{ page: 1, text }]);
    assert.equal(result.items[0].mismatch, MISMATCH.NONE);
    assert.equal(result.items[0].page, 1);
    assert.equal(compact(text.slice(result.items[0].start, result.items[0].end)), compact(quote));
    assert.ok(text.slice(result.items[0].start, result.items[0].end).includes(BLOCK_SEP));
  });
});

describe('A7 · 边界：不能把别的书型误判成失配', () => {
  it('pageTexts 为空（PDF / 解析缓存还没建）⇒ 一条都不动、一条都不标', () => {
    const item = base({ page: 999 });
    const result = relocateAnnotations([item], []);
    assert.equal(result.items[0].page, 999);
    assert.equal(result.items[0].mismatch, undefined);
    assert.deepEqual(result.mismatched, []);
  });

  it('页号非法的条目（页码 0 / NaN）不参与查找，也不崩', () => {
    const result = relocateAnnotations([base({ page: 9 })], [
      { page: 0, text: QUOTE }, { page: NaN, text: QUOTE }, { page: 7, text: QUOTE },
    ]);
    assert.equal(result.items[0].page, 7);
    assert.equal(result.items[0].mismatch, MISMATCH.NONE);
  });

  it('空摘录 ⇒ missing，不会因 indexOf("") 命中 0 而画一个零长高亮', () => {
    const result = relocateAnnotations([base({ quote: '   ' })], [{ page: 1, text: '随便什么' }]);
    assert.equal(result.items[0].mismatch, MISMATCH.MISSING);
  });

  it('withoutMismatch 只摘掉有标记的，正常条目一条不少', () => {
    const items = [base(), { ...base({ id: 'a2' }), mismatch: MISMATCH.MISSING },
      { ...base({ id: 'a3' }), mismatch: MISMATCH.AMBIGUOUS }, { ...base({ id: 'a4' }), mismatch: '' }];
    assert.deepEqual(withoutMismatch(items).map(item => item.id), ['a1', 'a4']);
  });

  it('★ 反向对照：把歧义分支改成「只有 0 处才拦」⇒ 3 处时判据必须能抓到', async () => {
    const source = readFileSync(RELOC, 'utf8');
    const mutated = source.replace('if (hits.length !== 1) {', 'if (hits.length === 0) {');
    assert.notEqual(mutated, source, '变异锚点没命中，这条对照已经失效');
    const alt = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(mutated)}`);
    const result = alt.relocateAnnotations([base({ page: 9 })], [
      { page: 1, text: QUOTE }, { page: 2, text: QUOTE }, { page: 3, text: QUOTE },
    ]);
    assert.equal(result.items[0].mismatch, MISMATCH.NONE, '变异版没报错 = 原判据不是这行守的');
    assert.equal(result.items[0].page, 1, '变异版应当错误地挑了第一处');
  });
});

// ---------------------------------------------------------------- 磁盘层

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    // 非递归删除：BULK 守卫会拦递归 rm，这里逐个删自己写的文件再删空目录。
    const sub = join(dir, 'annotations');
    for (const name of await readdir(sub).catch(() => [])) {
      await rm(join(sub, name), { force: true }).catch(() => {});
    }
    await rm(sub, { force: true }).catch(() => {});
    await rm(dir, { force: true }).catch(() => {});
  }
});

async function makeStore({ relocate } = {}) {
  const dir = await mkdtemp(join(tmpdir(), `npr-reloc-${process.pid}-`));
  tempRoots.push(dir);
  const logs = [];
  const store = createAnnotationStore({ rootDir: dir, log: message => logs.push(message), relocate });
  return { dir, store, logs };
}

describe('A7 · annotation-store：投影只改返回值，不写盘', () => {
  it('★ list 返回重定位后的坐标，磁盘 JSON 里的坐标与字段一个都没变', async () => {
    const pages = pagesOfBlocks(NEW_BLOCKS);
    const calls = [];
    const { dir, store } = await makeStore({
      relocate: (bookId, items) => {
        calls.push(bookId);
        return relocateAnnotations(items, pages);
      },
    });
    const added = await store.add('b-abc_123', { page: 3, start: 4, end: 4 + QUOTE.length, quote: QUOTE });
    const diskBefore = await readFile(join(dir, 'annotations', 'b-abc_123.json'), 'utf8');

    const listed = await store.list('b-abc_123');
    assert.equal(listed[0].page, 4, 'list 没做投影');
    assert.equal(listed[0].mismatch, MISMATCH.NONE);
    assert.equal(calls.length, 2, 'add 与 list 都要经 present，少一道门就会漏');
    assert.equal(await readFile(join(dir, 'annotations', 'b-abc_123.json'), 'utf8'), diskBefore,
      'GET 请求写了盘 = 投影被固化');
    const onDisk = JSON.parse(diskBefore).items[0];
    assert.equal(onDisk.page, 3, '磁盘坐标被改了');
    assert.equal(onDisk.mismatch, undefined, 'mismatch 不该落盘');
    assert.equal(added.items[0].page, 4, 'add 的返回值也要投影');
  });

  it('add / update / remove 三条写路径的返回值都经投影', async () => {
    const pages = pagesOfBlocks(NEW_BLOCKS);
    const { store } = await makeStore({ relocate: (id, items) => relocateAnnotations(items, pages) });
    const added = await store.add('b-abc_123', { page: 3, start: 4, end: 4 + QUOTE.length, quote: QUOTE });
    assert.equal(added.items[0].page, 4);
    const updated = await store.update('b-abc_123', added.item.id, { note: '记一句' });
    assert.equal(updated.items[0].page, 4);
    const second = await store.add('b-abc_123', { page: 1, start: 0, end: 2, quote: '第一章', note: '' });
    assert.equal(second.items.find(item => item.id === added.item.id).page, 4);
    const removed = await store.remove('b-abc_123', second.item.id);
    assert.equal(removed.items[0].page, 4);
  });

  it('counts 不触发重定位（书架上数笔记不该把每本书的正文都读一遍）', async () => {
    let calls = 0;
    const { store } = await makeStore({ relocate: (id, items) => { calls += 1; return relocateAnnotations(items, []); } });
    await store.add('b-abc_123', { page: 3, start: 4, end: 4 + QUOTE.length, quote: QUOTE });
    const before = calls;
    const counts = await store.counts();
    assert.equal(counts['b-abc_123'], 1);
    assert.equal(calls, before, 'counts 走了 present');
  });

  it('没注入 relocate（PDF / 老夹具）⇒ 原样返回，一条不标失配', async () => {
    const { store } = await makeStore();
    await store.add('b-abc_123', { page: 3, start: 4, end: 4 + QUOTE.length, quote: QUOTE });
    const listed = await store.list('b-abc_123');
    assert.equal(listed[0].page, 3);
    assert.equal(listed[0].mismatch, undefined);
  });

  it('重定位抛错 ⇒ 按原坐标返回并记一句日志，不静默吞、不让划线读不出来', async () => {
    const { store, logs } = await makeStore({ relocate: () => { throw new Error('缓存坏了'); } });
    await store.add('b-abc_123', { page: 3, start: 4, end: 4 + QUOTE.length, quote: QUOTE });
    const listed = await store.list('b-abc_123');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].page, 3);
    assert.ok(logs.some(line => line.includes('缓存坏了')), '失败不能一声不吭');
  });

  it('失配标记不进磁盘：normalizeAnnotation 仍然丢掉不认识的字段', async () => {
    const { dir, store } = await makeStore({
      relocate: (id, items) => relocateAnnotations(items, [{ page: 1, text: '完全无关' }]),
    });
    await store.add('b-abc_123', { page: 3, start: 4, end: 4 + QUOTE.length, quote: QUOTE });
    const listed = await store.list('b-abc_123');
    assert.equal(listed[0].mismatch, MISMATCH.MISSING);
    const onDisk = JSON.parse(await readFile(join(dir, 'annotations', 'b-abc_123.json'), 'utf8'));
    assert.equal(onDisk.items[0].mismatch, undefined);
  });
});

// ---------------------------------------------------------------- 客户端

describe('A7 · 客户端：失配要能穿过 normalize 并在面板上说出来', () => {
  it('normalizeAnnotation 保留合法的 mismatch，老数据仍 deepEqual 原对象', () => {
    assert.deepEqual(normalizeAnnotation(base()), base());
    assert.equal(normalizeAnnotation({ ...base(), mismatch: MISMATCH.AMBIGUOUS }).mismatch, MISMATCH.AMBIGUOUS);
    assert.equal(normalizeAnnotation({ ...base(), mismatch: MISMATCH.MISSING }).mismatch, MISMATCH.MISSING);
    assert.equal(normalizeAnnotation({ ...base(), mismatch: 'garbage' }).mismatch, undefined);
  });

  it('normalizeAnnotations 整份列表也带着标记', () => {
    const list = normalizeAnnotations([base(), { ...base({ id: 'a2', page: 1 }), mismatch: MISMATCH.MISSING }]);
    assert.equal(list.find(item => item.id === 'a2').mismatch, MISMATCH.MISSING);
  });

  it('★ 真渲染：失配卡片有提示，正常卡片没有', async () => {
    const outFile = join(root, 'test', '.build', `annotation-relocate-panel-${process.pid}.cjs`);
    await mkdir(dirname(outFile), { recursive: true });
    await esbuild.build({
      stdin: {
        contents: [
          "import React from 'react';",
          "import { renderToStaticMarkup } from 'react-dom/server';",
          `import { AnnotationPanel } from ${JSON.stringify(join(root, 'src', 'client', 'AnnotationPanel.jsx'))};`,
          'export { React, renderToStaticMarkup, AnnotationPanel };',
        ].join('\n'),
        resolveDir: root, loader: 'js',
      },
      bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
      outfile: outFile, logLevel: 'silent',
    });
    const mod = await import(`${pathToFileURL(outFile).href}?v=${Date.now()}`);
    const props = items => ({
      items, title: '磨坊', bookId: 'b1', focusId: '',
      onJump: () => {}, onUpdate: () => {}, onRemove: () => {}, onClose: () => {},
    });
    const render = items => mod.renderToStaticMarkup(mod.React.createElement(mod.AnnotationPanel, props(items)));
    const normal = render([base()]);
    assert.ok(!normal.includes('npr-mark-mismatch'), '正常卡片不该出现失配提示');
    const ambiguous = render([{ ...base(), mismatch: MISMATCH.AMBIGUOUS }]);
    assert.ok(ambiguous.includes('npr-mark-mismatch'));
    assert.ok(ambiguous.includes('定不了是哪一处'), '歧义要说清是「定不了位」');
    const missing = render([{ ...base(), mismatch: MISMATCH.MISSING }]);
    assert.ok(missing.includes('找不到这段原文'));
    assert.ok(missing.includes('笔记还在'), '要告诉用户笔记没丢');
  });
});

// ---------------------------------------------------------------- 跨文件契约

describe('A7 · 接线守卫：少接一道门就零症状通过', () => {
  const read = path => readFileSync(join(root, path), 'utf8');

  it('渲染与重复判定都用 withoutMismatch（失配项不画、也不拦重新划线）', () => {
    const source = read('src/client/BookEbook.jsx');
    assert.match(source, /withoutMismatch\(annotationsOnPage\(/);
    assert.match(source, /coveringAnnotation\(withoutMismatch\(annotations\)/);
  });

  it('面板样式真的存在（不是只有一个没有 CSS 的类名）', () => {
    assert.match(read('src/client/refinements.css'), /\.npr-mark-mismatch\s*\{/);
  });

  it('宿主四条出口都经 present，counts 例外', () => {
    const source = read('src/host/annotation-store.js');
    assert.equal(source.split('await present(bookId').length - 1, 5);
    const counts = source.slice(source.indexOf('async function counts()'));
    assert.ok(!counts.includes('present('), 'counts 不该触发重定位');
  });

  it('service 注入了 relocate，且重定位**只读缓存**不整本重解析', () => {
    const source = read('src/host/service.js');
    assert.match(source, /relocate: \(bookId, items\) => this\.relocateBookAnnotations\(bookId, items\)/);
    const method = source.slice(source.indexOf('async relocateBookAnnotations('),
      source.indexOf('async translateEbookSection('));
    assert.ok(method.includes('this.ebookStore.read('), '没读解析缓存');
    assert.ok(!method.includes('this.ebookOf('), '为了读几条划线去整本下载/解析');
    assert.ok(method.includes('isEbookExtension('), 'PDF 与电子书坐标系不能混算');
    assert.ok(method.includes('pageTextOfBlocks('));
    // P2：缓存判据与 ebookOf 必须同一口径 —— 一边按 mtime 判、一边只按体积判，
    // 「文件改过但体积没变」时这里会读到旧正文，把划线重定位到错误的段落。
    assert.ok(method.includes('this.ebookFingerprint('), '没算指纹 ⇒ 本地书改过内容也读旧缓存');
    assert.ok(method.includes('mtimeMs'), '算了指纹却没传给 read，等于没算');
  });

  it('BLOCK_SEP 只有一份定义，ebook-marks 从共用层取', () => {
    const marks = read('src/client/ebook-marks.js');
    assert.match(marks, /import \{ BLOCK_SEP, pageTextOfBlocks \} from '\.\.\/annotation-relocate\.js'/);
    assert.ok(!/export const BLOCK_SEP\s*=/.test(marks), '又出现了第二份定义');
  });
});

// ---------------------------------------------------------------- 真实 service 接线

describe('A7 · service.relocateBookAnnotations 真跑（不是只断源码里有这行）', () => {
  const method = RssService.prototype.relocateBookAnnotations;
  const fake = ({ book, cached, warn = () => {} } = {}) => {
    const calls = { read: 0 };
    return {
      calls,
      bookById: async () => book ?? { id: 'b-abc_123', ext: 'epub', size: 4096 },
      // P2 起缓存判据多了 mtime：这个 fake 扮演网盘书，指纹为 null（只看体积）。
      ebookFingerprint: async () => null,
      ebookStore: {
        read: async () => { calls.read += 1; return cached === undefined
          ? { sections: NEW_BLOCKS.map(blocks => ({ blocks })) } : cached; },
      },
      ctx: { logger: { warn } },
    };
  };
  const run = (self, items = [base()]) => method.call(self, 'b-abc_123', items);

  it('★ 缓存里是插入一页后的新正文 ⇒ 划线真的跟到第 4 页', async () => {
    const result = await run(fake());
    assert.equal(result.items[0].page, 4);
    assert.equal(result.items[0].mismatch, MISMATCH.NONE);
    assert.equal(pageTextOfBlocks(NEW_BLOCKS[3]).slice(result.items[0].start, result.items[0].end), QUOTE);
  });

  it('PDF ⇒ 完全不碰 ebook 缓存，也不重定位（两套坐标系不能混算）', async () => {
    const self = fake({ book: { id: 'b-abc_123', ext: 'pdf', size: 4096 } });
    const result = await run(self);
    assert.equal(result.items[0].page, 3);
    assert.equal(result.items[0].mismatch, undefined);
    assert.equal(self.calls.read, 0, 'PDF 也去读电子书缓存');
  });

  it('缓存还没建 ⇒ 原样返回，不为了几条划线整本重解析', async () => {
    const self = fake({ cached: null });
    const result = await run(self);
    assert.equal(result.items[0].page, 3);
    assert.equal(self.calls.read, 1);
  });

  it('书不在书单里 / bookById 抛错 ⇒ 按原坐标返回并记一句，不让划线读不出来', async () => {
    const warnings = [];
    const missing = fake({ warn: message => warnings.push(message) });
    missing.bookById = async () => undefined; // 书单里确实没有这本，不是「用默认书兜底」
    assert.equal((await run(missing)).items[0].page, 3);
    const broken = fake({ warn: message => warnings.push(message) });
    broken.bookById = async () => { throw new Error('书单坏了'); };
    assert.equal((await run(broken)).items[0].page, 3);
    assert.ok(warnings.some(line => line.includes('书单坏了')));
  });
});
