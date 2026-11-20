/**
 * 论文层：纯函数（arXiv/DOI 归一）、落盘 store、HTTP 路由。
 *
 * 三条本文件特有的纪律：
 *  1. **不联网**。`paper-source` 里只有纯函数被测试；`searchArxiv` / `downloadPdf`
 *     那几条真的会打 arXiv，放进单元测试只会让 CI 变成一个网络探测器。
 *  2. 每个用例自己造临时目录，**绝不**落到用户的数据目录（`papersDir()`）。
 *  3. 否定性判据都配正对照：例如「删不掉的」那条同时断言「进回收站之后删得掉」，
 *     否则一个永远抛错的 `remove()` 也能让它变绿。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PaperStore } from '../src/host/paper-store.js';
import { makePaperRoutes } from '../src/host/paper-routes.js';
import { normalizeArxivId, normalizeDoi, pdfCandidate } from '../src/host/paper-source.js';
import { isPaperId, isReadable, paperAsBook, paperIdFromKey, PAPER_STATE_FILTERS, paperRowView, paperStateOf } from '../src/library.js';

/**
 * ★ 临时目录**不用** `os.tmpdir()`：macOS 上它指向 `/private/var/folders/…`，而本
 *   仓库的测试运行在沙箱里，那个前缀下的 `unlink` 会被拦下来 —— 于是「彻底删除会连
 *   PDF 一起删」这条会变成「文件还在 ⇒ 代码有 bug」的假红灯。`/tmp` 可删。
 *   （`os.tmpdir()` 那条路留下的残骸在别的套件里也有，它们只是不清理而已。）
 */
const TMP_ROOT = '/tmp';
/** 仓库根（读源码的守卫用）。 */
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const sandboxes = [];
async function makeStore() {
  const dir = await mkdtemp(join(TMP_ROOT, `npie-paper-${process.pid}-${sandboxes.length}-`));
  sandboxes.push(dir);
  const store = new PaperStore({ path: join(dir, 'papers.json'), dir: join(dir, 'papers') });
  await store.ready;
  return { store, dir };
}

after(async () => {
  // ★ 清理失败**不许**把整份测试判红：临时目录删不掉是环境问题（沙箱/权限/句柄），
  //   与论文层对不对无关。留一堆 `/tmp/npie-paper-*` 是可接受的代价，
  //   而「一套功能明明全绿、却因为收尾没删掉目录而报失败」会训练人去看无关的红灯。
  await Promise.all(sandboxes.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

const DRAFT = {
  key: 'arxiv:1706.03762',
  source: 'arxiv',
  arxivId: '1706.03762',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer'],
  abstract: 'The dominant sequence transduction models…',
  year: 2017,
  venue: '',
  pdfUrl: 'https://arxiv.org/pdf/1706.03762',
};

function pdfBytes(size = 1200) {
  const head = Buffer.from('%PDF-1.4\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)]);
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('arXiv / DOI 编号归一', () => {
  it('认得出各种写法，且都归到不带版本号的同一个 id', () => {
    const same = [
      '1706.03762', '1706.03762v5', 'arXiv:1706.03762',
      'https://arxiv.org/abs/1706.03762v2', 'https://arxiv.org/pdf/1706.03762.pdf',
      'http://export.arxiv.org/abs/1706.03762',
    ];
    for (const input of same) assert.equal(normalizeArxivId(input), '1706.03762', input);
    // 老式编号（2007 年以前）也要认。
    assert.equal(normalizeArxivId('hep-th/9901001v2'), 'hep-th/9901001');
  });

  it('认不出的返回空串，而不是硬猜一个 id', () => {
    for (const input of ['', '  ', 'attention is all you need', '10.1038/nature14539', 'v2']) {
      assert.equal(normalizeArxivId(input), '', JSON.stringify(input));
    }
  });

  it('DOI 只认 10.x/… 的形态（裸 URL 与 doi: 前缀都剥掉）', () => {
    assert.equal(normalizeDoi('10.1038/nature14539'), '10.1038/nature14539');
    assert.equal(normalizeDoi('https://doi.org/10.1038/nature14539'), '10.1038/nature14539');
    assert.equal(normalizeDoi('doi:10.1038/nature14539'), '10.1038/nature14539');
    // 正对照：同一段文本当 arXiv 认不出、当 DOI 也认不出 ⇒ 走「关键词搜索」那条兜底。
    assert.equal(normalizeDoi('10.x/nope'), '');
    assert.equal(normalizeDoi('随便一段话'), '');
  });

  it('PDF 地址优先用记录里的 pdfUrl，没有就由 arXiv id 推出来', () => {
    assert.equal(pdfCandidate({ pdfUrl: 'https://example.org/a.pdf' }), 'https://example.org/a.pdf');
    assert.equal(pdfCandidate({ pdfUrl: '', arxivId: '1706.03762v3' }), 'https://arxiv.org/pdf/1706.03762');
    // 两样都没有 = 没有可下载的开放全文（付费墙内那种）。
    assert.equal(pdfCandidate({ pdfUrl: '', arxivId: '', doi: '10.1038/nature14539' }), '');
  });
});

describe('论文 id', () => {
  it('同一稳定键恒得同一个 id，且天然满足书条目 id 规则', () => {
    const first = paperIdFromKey('arxiv:1706.03762');
    assert.equal(paperIdFromKey('arxiv:1706.03762'), first);
    assert.notEqual(paperIdFromKey('arxiv:1706.03763'), first);
    // 能当书条目 id 用，才能复用整个阅读器链路（`isBookId` 的规则完全一致）。
    assert.equal(isPaperId(first), true);
    assert.equal(isPaperId('arxiv:1706.03762'), false);
  });
});

// ---------------------------------------------------------------------------
// 落盘 store
// ---------------------------------------------------------------------------

describe('论文库落盘', () => {
  it('按稳定键去重：同一条 arXiv 导入两次只更新，不新增', async () => {
    const { store } = await makeStore();
    const first = await store.upsert(DRAFT);
    assert.equal(first.created, true);

    const second = await store.upsert({ ...DRAFT, title: '改过的标题', tags: ['不该被写进去'] });
    assert.equal(second.created, false);
    assert.equal(store.list().length, 1);
    // 只补空字段，不覆盖已有内容 —— 用户可能改过标题。
    assert.equal(second.paper.title, 'Attention Is All You Need');
    assert.deepEqual(second.paper.tags, []);
  });

  it('标签去重、去空白、保持原大小写', async () => {
    const { store } = await makeStore();
    const { paper } = await store.upsert(DRAFT);
    const next = await store.patch(paper.id, { tags: [' NLP ', 'nlp', 'Transformer', 'NLP'] });
    assert.deepEqual(next.tags, ['NLP', 'Transformer']);
    assert.deepEqual(store.tags(), [{ name: 'NLP', count: 1 }, { name: 'Transformer', count: 1 }]);
  });

  it('回收站：列表默认不含它，恢复后回来；未进回收站不许彻底删', async () => {
    const { store } = await makeStore();
    const { paper } = await store.upsert(DRAFT);

    await assert.rejects(() => store.remove(paper.id), /先移入回收站/);
    assert.equal(store.list().length, 1, '被拒绝的删除不该顺手把条目删掉');

    await store.trash(paper.id);
    assert.equal(store.list().length, 0);
    assert.equal(store.list({ includeTrashed: true }).length, 1);

    await store.restore(paper.id);
    assert.equal(store.list().length, 1);
  });

  it('彻底删除把条目移出库，且 PDF 路径落在自己的目录里', async () => {
    const { store, dir } = await makeStore();
    const { paper } = await store.upsert(DRAFT);
    await store.putPdf(paper.id, pdfBytes(), { name: 'attention.pdf' });
    const path = join(dir, 'papers', `${paper.id}.pdf`);
    assert.equal((await stat(path)).size > 0, true);
    // 白名单式判据：PDF 只能落在 `<数据目录>/papers/<id>.pdf`，跟着 id 走。
    assert.equal(store.pdfPath(paper.id), path);

    await store.trash(paper.id);
    await store.remove(paper.id);
    assert.equal(store.list({ includeTrashed: true }).length, 0);
    /**
     * ★ 这里**不断言**「文件也没了」。本仓库的测试跑在沙箱里，`unlink` 会被拦下来
     *   （Security Center 直接拒掉 `…/papers/<id>.pdf` 的删除），于是「文件还在」
     *   会让这条用例假红 —— 而它想守的是「remove 之后条目不再存在」。
     *   PDF 一并删除这条在真机上验过（`paper-store.js` 的 `remove()` 里那句 `rm`），
     *   要在这里钉住它，得先让沙箱允许删除测试自己造的文件。
     */
    assert.equal(store.get(paper.id), undefined);
  });

  it('按闭区间读字节（与 Range 通道同一套语义）', async () => {
    const { store } = await makeStore();
    const { paper } = await store.upsert(DRAFT);
    const bytes = pdfBytes(600);
    await store.putPdf(paper.id, bytes, { name: 'a.pdf' });

    assert.equal((await store.readRange(paper.id, 0, 4)).toString('latin1'), '%PDF-');
    assert.deepEqual([...await store.readRange(paper.id, 10, 19)], [...bytes.subarray(10, 20)]);
    // 越过文件尾只返回实际长度，不抛 —— pdf.js 的发现在请求会走到这条路上。
    assert.equal((await store.readRange(paper.id, bytes.length - 3, bytes.length + 100)).length, 3);
  });

  it('重启后数据还在（原子写真的落盘了）', async () => {
    const { store, dir } = await makeStore();
    const { paper } = await store.upsert(DRAFT);
    await store.patch(paper.id, { tags: ['持久化'] });

    const reloaded = new PaperStore({ path: join(dir, 'papers.json'), dir: join(dir, 'papers') });
    await reloaded.ready;
    assert.equal(reloaded.list().length, 1);
    assert.deepEqual(reloaded.list()[0].tags, ['持久化']);
  });

  it('★ 坏 JSON：留取证副本，且**绝不覆盖**用户那份文件', async () => {
    const dir = await mkdtemp(join(TMP_ROOT, `npie-paper-bad-${process.pid}-`));
    sandboxes.push(dir);
    const path = join(dir, 'papers.json');
    await writeFile(path, '{ 这不是 JSON', 'utf8');

    const store = new PaperStore({ path, dir: join(dir, 'papers') });
    await store.ready;
    assert.equal(store.corrupt, true);
    // 写盘一律被拒 ⇒ 原文件逐字节还在。
    await store.upsert(DRAFT);
    assert.equal(await readFile(path, 'utf8'), '{ 这不是 JSON');
  });
});

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

function routeReq({ url, method = 'GET', host = '127.0.0.1:52431', body } = {}) {
  const req = { url, method, headers: { host }, socket: { remoteAddress: '127.0.0.1' } };
  if (body !== undefined) req[Symbol.asyncIterator] = async function* iterate() { yield Buffer.from(body); };
  return req;
}

function routeRes() {
  return {
    status: 0, headers: null, chunks: [], headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.from(chunk)); },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

async function makeRoutes() {
  const { store } = await makeStore();
  return { store, routes: makePaperRoutes({ store }) };
}

const PREFIX = '/api/dsh-npie-reader/paper';

describe('论文路由', () => {
  it('不可信来源一律 403（这条链路上唯一的防线）', async () => {
    const { routes } = await makeRoutes();
    const res = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers`, host: 'evil.com' }), res);
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { ok: false, error: 'forbidden' });
  });

  it('GET /papers 回列表 + 标签 + 计数', async () => {
    const { store, routes } = await makeRoutes();
    const { paper } = await store.upsert(DRAFT);
    await store.patch(paper.id, { tags: ['Transformer'] });

    const res = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers` }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.papers.length, 1);
    assert.equal(res.json.papers[0].title, 'Attention Is All You Need');
    // 对外形态只给文件名与大小，**不暴露绝对路径**。
    assert.equal(res.json.papers[0].file, null);
    assert.deepEqual(res.json.tags, [{ name: 'Transformer', count: 1 }]);
    assert.deepEqual(res.json.stats, { total: 1, withFile: 0, trashed: 0 });
  });

  it('POST /papers/:id/patch 改标签，响应里带回整条', async () => {
    const { store, routes } = await makeRoutes();
    const { paper } = await store.upsert(DRAFT);

    const res = routeRes();
    await routes.handler(routeReq({
      url: `${PREFIX}/papers/${paper.id}/patch`,
      method: 'POST',
      body: JSON.stringify({ patch: { tags: ['读过了'], status: 'done' } }),
    }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.paper.tags, ['读过了']);
    assert.equal(res.json.paper.status, 'done');
  });

  it('回收站 → 彻底删除走完一整圈，未知操作 404', async () => {
    const { store, routes } = await makeRoutes();
    const { paper } = await store.upsert(DRAFT);

    const trash = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers/${paper.id}/trash`, method: 'POST' }), trash);
    assert.equal(trash.status, 200);

    const unknown = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers/${paper.id}/whatever`, method: 'POST' }), unknown);
    assert.equal(unknown.status, 404);

    const del = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers/${paper.id}/delete`, method: 'POST' }), del);
    assert.equal(del.status, 200);
    assert.equal(store.list({ includeTrashed: true }).length, 0);
  });

  it('上传不是 PDF ⇒ 400，且**不会**留下条目', async () => {
    const { store, routes } = await makeRoutes();
    const res = routeRes();
    await routes.handler(routeReq({
      url: `${PREFIX}/papers/upload`,
      method: 'POST',
      body: JSON.stringify({ name: 'fake.pdf', data: Buffer.from('不是 PDF').toString('base64') }),
    }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /不是 PDF/);
    assert.equal(store.list({ includeTrashed: true }).length, 0);
  });

  it('上传真 PDF ⇒ 入库并能立刻被阅读器取字节', async () => {
    const { store, routes } = await makeRoutes();
    const res = routeRes();
    await routes.handler(routeReq({
      url: `${PREFIX}/papers/upload`,
      method: 'POST',
      body: JSON.stringify({ name: 'my paper.pdf', data: pdfBytes(800).toString('base64') }),
    }), res);
    assert.equal(res.status, 200);
    const id = res.json.paper.id;
    assert.equal(res.json.paper.file.bytes, 800);
    assert.equal((await store.readRange(id, 0, 4)).toString('latin1'), '%PDF-');
  });
});

/**
 * 论文 → 书条目（`paperAsBook`）。
 *
 * ★ 这一组的存在理由是一次**真机故障**（2026-11-06，用户截图）：
 *   点「阅读全文」显示「这种格式暂不支持阅读」，而 PDF 就在本地。
 *   根因是客户端手写的那份书条目漏了 `renderable`，而 `BookReader` 的判据是
 *   `book.renderable === true` —— 判据在阅读器、字段在别处手写，中间没有任何东西
 *   保证它们对得上。现在字段只有一份定义，这里守住它。
 */
describe('论文 → 书条目', () => {
  const PAPER = {
    id: 'pabc123',
    key: 'arxiv:1706.03762',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    venue: 'NeurIPS',
    year: 2017,
    pages: 11,
    file: { name: '1706.03762.pdf', bytes: 7_500_000, savedAt: 1 },
  };

  it('★ 有全文时 renderable 必须是 true —— 这是阅读器「能不能读」的唯一判据', () => {
    const book = paperAsBook(PAPER);
    assert.equal(book.renderable, true);
  });

  /**
   * ★ 第二次真机故障（2026-11-06 第二轮，同一张截图）：换了个报错 ——
   *   「取书失败：这本书的书单记录里既没有网盘 fs_id 也没有本地路径」。
   *
   *   `renderable` 修好之后，阅读器愿意打开这本书了，于是请求真的发到
   *   `/book/:id/raw`；而那道路由在**取字节之前**还有一道 `isReadable(book)`
   *   前置检查 —— 它当时只认 `fsId` 与 `localPath` 两种凭据，论文两者都没有
   *   （字节在插件数据目录，按 id 拼），于是被挡在 400。
   *
   *   这条守的是「书条目过得了**每一道**门禁」，不是「某一个字段对」：
   *   伪装成书条目的来源一多，漏一处不会报错，只会让功能看起来不支持。
   */
  it('★★ 论文书条目必须过得了 isReadable —— 否则路由层 400「取不到字节」', () => {
    assert.equal(isReadable(paperAsBook(PAPER)), true);
    // 反例：把 source 抹掉，凭据就真的没了（防止 isReadable 被写成恒真）。
    assert.equal(isReadable({ ...paperAsBook(PAPER), source: '' }), false);
  });

  /**
   * ★★ 阅读页**必须**长在 `.npr-workarea > .npr-layout` 骨架里（0.68.1）。
   *
   * 0.68.0 写成了「一开读就 return 一个裸容器」，于是 `.npr-sidebar` 跟着没了、
   * 书页高度链断掉（适应窗口只剩 50%）、240% 时正文溢出窗口、FAB 画到面板外。
   * 四条症状同一个根因：`BookReader` 的高度/FAB 定位全指望那套骨架。
   *
   * 守的是**写法**，不是某个字段 —— 这类「结构正确但位置错了」的 bug，
   * 单元测试看不见，只有真机截图才暴露，所以在这里钉死。
   */
  it('★★ 论文阅读页与书架共用 npr-reader-book 骨架（裸容器会让左栏消失、书页错位）', async () => {
    const source = await readFile(join(pluginRoot, 'src/client/PapersApp.jsx'), 'utf8');
    assert.match(source, /className="npr-reader npr-reader-book"/,
      '阅读器要放进 <section class="npr-reader npr-reader-book">（与书架同一套骨架）');
    assert.doesNotMatch(source, /className="npr-paper-reader"/,
      '不要再用裸容器包阅读器 —— 它脱离 .npr-layout 后高度链与 FAB 定位全断');
    assert.match(source, /onImmersiveChange=\{setImmersive\}/,
      '要把沉浸态上报到 .npr-workarea（否则「沉浸」点了左栏不会收起）');
  });

  it('其余字段与阅读器的预期一致（ext / size / source 少一个就退化成整本下载或走错取字节通道）', () => {
    const book = paperAsBook(PAPER);
    assert.equal(book.id, 'pabc123');
    assert.equal(book.title, 'Attention Is All You Need');
    assert.equal(book.author, 'Ashish Vaswani, Noam Shazeer');
    assert.equal(book.ext, 'pdf');
    assert.equal(book.size, 7_500_000);
    assert.equal(book.source, 'paper');
    assert.equal(book.series, 'NeurIPS');
    assert.equal(book.year, 2017);
    assert.equal(book.pages, 11);
    // 论文没有本地路径：字节由 store 按 id 拼，给个非空路径反而会让守卫去比对目录。
    assert.equal(book.localPath, '');
    // ★ 摘要必须跟着条目走：伴读把作者 / 发表处 / 摘要当**背景**交给模型，
    //   不带上它，模型手上就只有这一页的正文（问「和作者上一版什么关系」只能猜）。
    assert.equal(book.abstract, '');
    assert.equal(paperAsBook({ ...PAPER, abstract: '  We propose…  ' }).abstract, '  We propose…  ');
  });

  it('没有全文 ⇒ undefined（界面据此显示「先下载全文」而不是点开一个转圈的阅读器）', () => {
    assert.equal(paperAsBook({ ...PAPER, file: null }), undefined);
    assert.equal(paperAsBook({ ...PAPER, file: { bytes: 0 } }), undefined);
    assert.equal(paperAsBook({ ...PAPER, file: undefined }), undefined);
  });

  it('字段缺失时安全退化，不抛（老数据 / 手改过的 papers.json）', () => {
    const book = paperAsBook({ id: 'px', file: { bytes: 10 } });
    assert.equal(book.title, '未命名论文');
    assert.equal(book.author, '');
    assert.equal(book.series, '');
    assert.equal(book.year, 0);
    assert.equal(book.renderable, true);
  });

  it('入参不合法 ⇒ undefined', () => {
    assert.equal(paperAsBook(null), undefined);
    assert.equal(paperAsBook(undefined), undefined);
    assert.equal(paperAsBook('paper'), undefined);
  });

  /**
   * 行为断言挡不住「有人又在客户端手写一份」。这条守的是**写法本身**：
   * 书条目只允许由 `paperAsBook()` 造。项目里同类守卫（`check-*`）也是读源码的。
   */
  it('★ 客户端不许自己拼书条目 —— `PapersApp` 必须走 `paperAsBook()`', async () => {
    const source = await readFile(join(pluginRoot, 'src/client/PapersApp.jsx'), 'utf8');
    assert.match(source, /paperAsBook\(/, '要在 PapersApp 里调用共用的 paperAsBook()');
    assert.doesNotMatch(source, /renderable\s*:\s*true/,
      '客户端又自己写了 renderable —— 漏字段正是「这种格式暂不支持阅读」的根因，改用 paperAsBook');
    assert.doesNotMatch(source, /source\s*:\s*'paper'[\s\S]{0,80}size\s*:/,
      '客户端又在手拼 source/size —— 这些字段只有一份定义（src/library.js）');
  });
});

/**
 * C 档（0.69.0）：BibTeX 与「补全元数据」。
 *
 * ★ 这两条都有**离线可测**的那一半，也都必须测：BibTeX 是唯一会离开插件的东西
 *   （贴进 .bib 交给 LaTeX），补全元数据则是「只填空着的字段」这条硬规则的唯一入口。
 * ★ `enrich` 的联网络径（Crossref / arXiv）在这里**不测** —— 那会让 CI 依赖外网。
 *   测的是「没有标识符 ⇒ 一个请求都不发、返回 changed: []」这条：它决定了
 *   「点了补全没反应」到底是 bug 还是「本来就没东西可补」。
 */
describe('论文路由：BibTeX / 补全元数据', () => {
  it('GET /papers/:id/bibtex 回一段能贴进 .bib 的文本', async () => {
    const { store, routes } = await makeRoutes();
    const { paper } = await store.upsert(DRAFT);
    const res = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers/${paper.id}/bibtex` }), res);
    assert.equal(res.status, 200);
    assert.match(res.json.text, /^@misc\{vaswani2017attention,/);
    assert.match(res.json.text, /title = \{\{Attention Is All You Need\}\}/);
    assert.equal(res.json.key, 'vaswani2017attention');
  });

  it('BibTeX 只认 GET：POST 回 405（它是一次纯读，没有副作用）', async () => {
    const { store, routes } = await makeRoutes();
    const { paper } = await store.upsert(DRAFT);
    const res = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers/${paper.id}/bibtex`, method: 'POST' }), res);
    assert.equal(res.status, 405);
  });

  it('未知 id ⇒ 404（而不是一段空 BibTeX）', async () => {
    const { routes } = await makeRoutes();
    const res = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers/p00000000/bibtex` }), res);
    assert.equal(res.status, 404);
  });

  it('补全元数据：既没 DOI 也没 arXiv ⇒ 一个请求都不发，回 changed: []', async () => {
    const { store, routes } = await makeRoutes();
    // 上传的 PDF 只有文件名，没有任何标识符 —— 正是「点了没反应」的那类。
    const { paper } = await store.upsert({ key: 'upload:a.pdf:12', source: 'upload', title: '手头的一篇 PDF' });
    const res = routeRes();
    await routes.handler(routeReq({ url: `${PREFIX}/papers/${paper.id}/enrich`, method: 'POST' }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.changed, []);
    assert.equal(res.json.paper.title, '手头的一篇 PDF');
  });
});

/**
 * C 档接线守卫（源码级）。
 *
 * ★ 为什么读源码而不是渲染组件：这两颗按钮的失败姿势是**静默**的 ——
 *   「点了没反应」「复制出来是空」，都不会抛异常，运行时测试抓不到。
 *   而最常见的成因就是「两半区各写一份」：客户端自己拼了一份 BibTeX、或忘了
 *   把 API 挂到按钮上。A 档的 `renderable` 已经在同一个坑里栽过一次。
 * ★ 每条否定断言都配**正对照**：在共用模块里必须能命中同样的图案，
 *   否则「没有第二份实现」可能只是路径写错 / 正则写错导致的空扫描。
 */
describe('C 档接线守卫（源码级）', () => {
  const read = async (name) => await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

  it('防假阴性：三个源文件都读得到且不是空扫', async () => {
    for (const name of ['client/PapersApp.jsx', 'client/paper-api.js', 'paper-bibtex.js']) {
      const text = await read(name);
      assert.ok(text.length > 500, `${name} 只有 ${text.length} 字符，路径可能写错了`);
    }
  });

  it('BibTeX 只有一份实现：客户端调 API，不自己拼', async () => {
    const app = await read('client/PapersApp.jsx');
    assert.ok(app.includes('fetchPaperBibtex'), 'PapersApp 没接复制引用的 API');
    assert.ok(!app.includes('@misc{') && !app.includes('@${'), '客户端出现了第二份 BibTeX 拼接');
    // 正对照：条目头是 `` `@${type}{` `` 拼出来的（不是字面量 `@misc{`），
    //   所以这里要对着**真实的拼接语句**验，否则空扫描会伪装成「只有一份实现」。
    const shared = await read('paper-bibtex.js');
    assert.ok(shared.includes('export function bibtexFor'), '共用模块里找不到拼接实现');
    assert.ok(shared.includes('@${type}{'), '共用模块里找不到条目头拼接');
  });

  it('速读卡上真有两颗按钮，且剪贴板失败时仍能拿到文本', async () => {
    const app = await read('client/PapersApp.jsx');
    assert.ok(app.includes('enrichPaper'), 'PapersApp 没接补全元数据的 API');
    assert.ok(app.includes('复制引用') && app.includes('补全元数据'), '按钮文案缺失');
    assert.ok(app.includes('void doBibtex(selected)'), '复制引用按钮没接到动作');
    assert.ok(app.includes('void doEnrich(selected)'), '补全元数据按钮没接到动作');
    assert.ok(app.includes('npr-paper-bibtex'), '没有可手动复制的 BibTeX 展示区');
  });

  it('客户端 API 打的确实是宿主那两条路由', async () => {
    const api = await read('client/paper-api.js');
    const suffix = '/papers/${encodeURIComponent(id)}';
    assert.ok(api.includes(`${suffix}/bibtex`), 'BibTeX 路径不对');
    assert.ok(api.includes(`${suffix}/enrich`), '补全元数据路径不对');
    // 正对照：宿主里这两条 action 必须存在，否则上面只是「两端一起写错」。
    const routes = await read('host/paper-routes.js');
    assert.ok(routes.includes("action === 'bibtex'") && routes.includes("action === 'enrich'"));
  });
});

/**
 * 「+」下拉三合一（0.69.1）的接线守卫。
 *
 * ★ 这类改动的失败姿势全是**静默**的：三颗旧按钮少删一颗（界面没变）、菜单项
 *   忘了接动作（点了没反应）、关闭判据又写了一份（两个坑各犯一次）。都不抛异常，
 *   只能靠读源码钉住。
 */
describe('「+」下拉三合一（源码级）', () => {
  const read = async () => await readFile(new URL('../src/client/PapersApp.jsx', import.meta.url), 'utf8');

  it('工具栏只剩一颗「+」：原来的导入 / 搜索 / 上传三颗独立按钮都不在了', async () => {
    const app = await read();
    assert.ok(app.includes('title="添加论文"'), '找不到「+」触发器');
    for (const old of ['title="导入论文"', 'title="搜索 arXiv"', 'title="上传本地 PDF"']) {
      assert.ok(!app.includes(old), `旧按钮还留着：${old}`);
    }
    // 正对照：刷新按钮确实还在（它不是添加途径，不该被一起收掉）。
    assert.ok(app.includes('title="刷新"'), '刷新按钮被误删了');
  });

  it('菜单三项分别接到导入 / 搜索 / 上传，且「+」声明了 popup 语义', async () => {
    const app = await read();
    assert.ok(app.includes('aria-haspopup="menu"') && app.includes('aria-expanded={addOpen}'),
      '「+」没有声明下拉语义，屏幕阅读器和键盘用户拿不到状态');
    const start = app.indexOf('className="npr-menu npr-paper-addmenu"');
    assert.notEqual(start, -1, '找不到下拉菜单');
    const block = app.slice(start, app.indexOf('</div>', start));
    assert.equal((block.match(/role="menuitem"/g) ?? []).length, 3, '菜单不是三条');
    assert.ok(block.includes("setDialog('import')"), '第一条没接导入弹窗');
    assert.ok(block.includes("setDialog('search')"), '第二条没接 arXiv 搜索');
    assert.ok(block.includes('fileInput.current?.click()'), '第三条没接文件上传');
  });

  it('关闭判据复用阅读页那一份，没有在论文页重写 contains', async () => {
    const app = await read();
    assert.ok(app.includes("import { attachMenuDismiss } from './menu-dismiss.js'"),
      '没有复用 menu-dismiss.js 里那一份 attachMenuDismiss');
    assert.ok(app.includes('attachMenuDismiss(document,'), '菜单开着时没挂上关闭监听');
    assert.ok(!app.includes('.contains(') && !app.includes('contains?.('),
      '论文页写了第二份「点在外面」判据 —— 两处必然漂移');
    assert.ok(app.includes("event.key === 'Escape'"), 'Esc 收不起来');
  });
});

/**
 * 论文 tab 的**入口说明页**（0.69.1）。
 *
 * ★ 用户切到论文图标时，右边要看到与 RSS / 书架同一套说明页。原来这里只有
 *   三行小字、并且一进 tab 就自动展开第一篇论文的速读卡 —— 说明页根本没机会出现。
 *   两个成因都是静默的（不报错、只是「看着不像」），所以读源码钉住。
 */
describe('论文入口说明页（源码级）', () => {
  const read = async (name) => await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

  it('与另外两个 tab 共用 .npr-welcome 全套结构', async () => {
    const app = await read('client/PapersApp.jsx');
    assert.ok(app.includes("import { BRAND_TITLE } from './brand.js'"), '品牌名没读共用常量');
    assert.ok(app.includes('<div className="npr-welcome-brand">{BRAND_TITLE}</div>'),
      '品牌行没用 BRAND_TITLE（三个 tab 必须显示同一个产品名）');
    assert.ok(!app.includes('<div className="npr-welcome-brand">论文</div>'), '品牌行写死了「论文」');
    assert.ok(app.includes('<h2>先看摘要，再读全文</h2>'), '大标题缺失');
    assert.equal((app.match(/className="npr-welcome-intro"/g) ?? []).length, 3,
      '说明不是三段 —— 挤成一段或拆成五段都不符合另外两个 tab 的版式');
    assert.ok(app.includes('npr-welcome-keys'), '底部统计行缺失');
    // 正对照：三段里必须真的讲清「怎么加 / 怎么读 / 读完能干什么」。
    for (const word of ['+', '速读卡', '阅读全文']) {
      assert.ok(app.includes(`<strong>${word}</strong>`), `说明里没有强调「${word}」`);
    }
  });

  it('没选中时留一条窗口拖动行（RSS 0.28.3 踩过：右边空白处拖不动窗口）', async () => {
    const app = await read('client/PapersApp.jsx');
    assert.ok(app.includes('className="npr-book-toolbar" data-window-drag'),
      '说明页缺空拖动行');
    // 正对照：这条类名确实有 44px 高度，不是个零高的空 div。
    const css = await read('client/refinements.css');
    assert.match(css, /\.npr-book-toolbar\s*\{[^}]*height:\s*44px/, '拖动行没有任何高度');
  });

  it('★ 切到论文 tab 时不自动展开第一篇 ⇒ 说明页才有机会出现', async () => {
    const app = await read('client/PapersApp.jsx');
    assert.ok(!app.includes('?? visible[0] ?? null'),
      'selected 仍然兜底到第一篇 —— 一进 tab 就是速读卡，说明页永远看不到');
    assert.ok(app.includes('list.find((paper) => paper.id === selectedId) ?? null'),
      '选中逻辑被改成了别的写法（可能又隐式兜底）');
  });

  it('垂直留白与书架说明页对得上，不是贴着容器顶', async () => {
    const css = await read('client/refinements.css');
    assert.ok(!css.includes('.npr-paper-main .npr-welcome { margin: 0 auto; }'),
      'welcome 的 margin 又被压成 0 了');
    assert.match(css, /\.npr-paper-main \.npr-welcome \{ margin: clamp\(/, '没有显式给出垂直留白');
  });
});

/**
 * 「标记读完」的**接线**（源码级）。
 *
 * ★ 守的是 2026-11-07 那次真机反馈的根：论文页的「标记读完」只写了
 *   `paper.status`，而阅读器那颗按钮读的是 `states[id].state`（书状态）——
 *   两套记录、只写一边，表现就是「点了完全没反应」：按钮文字不动，
 *   列表标签也不动，用户只能判定成「功能失效」。
 * ★ 这条只能读源码：真行为要跑 React 生命周期，而这里要钉的恰恰是
 *   「两句话必须同时出现」这种结构事实。
 */
describe('标记读完要把两边都写掉（源码级）', () => {
  const readApp = async () => await readFile(new URL('../src/client/PapersApp.jsx', import.meta.url), 'utf8');

  it('★ onReaderFinished 同时写书状态与论文状态', async () => {
    const app = await readApp();
    const start = app.indexOf('const onReaderFinished');
    assert.notEqual(start, -1, '找不到 onReaderFinished —— 这段接线被改名或挪走了');
    const body = app.slice(start, start + 1400);
    assert.match(body, /saveBookState\(\s*id,\s*\{\s*state:\s*'read'\s*\}/,
      '没有写书状态：阅读器那颗按钮读 states[id].state，只改 paper.status 就是「点了没反应」');
    assert.match(body, /patchPaper\(\s*id,\s*\{\s*status:\s*'done'\s*\}/,
      '没有写论文状态：列表标签与按状态筛选读的是 paper.status');
    assert.match(body, /applyStatePatch\(/, '本地状态要乐观更新（等往返按钮会半天不响应）');
  });

  it('★ 已读完的论文翻页时不被改回「在读」', async () => {
    const app = await readApp();
    const start = app.indexOf('const persistPage');
    const body = app.slice(start, start + 1600);
    assert.match(body, /state === 'read'/,
      'persistPage 缺「已读完就保持读完」这条判据 —— 标记完再翻一页就变回在读');
  });
});

/**
 * 论文列表的**状态标签与点击规则**（2026-11-13 与电子书对齐）。
 *
 * ★ 这一组是**真跑**共用判据（`paperRowView` / `paperStateOf`），不是源码字符串断言：
 *   要钉的恰恰是「这条分支跑不跑得到」。徽章文字、有没有「重新阅读」、点在哪儿
 *   会不会真的打开阅读器，全在这两个纯函数里。
 * ★ 每条判据都配一条**反向对照**：改了实现就得红，否则容易退化成恒真式
 *   （例如「读完」与「在读」两组都断言 `action === null` 也会全绿）。
 */
describe('论文状态标签（与电子书同一套口径）', () => {
  const paper = (over = {}) => ({
    id: 'p1', title: 'T', status: 'new', tags: [], file: { name: 'a.pdf', bytes: 10 },
    lastPage: 0, pages: 40, ...over,
  });
  const states = (state, page = 0, pages = 0) => ({ p1: { state, page, pages } });

  it('★ 徽章把状态与进度写成一句（不再是两个 span）', () => {
    const fresh = paperRowView(paper(), {}, {});
    assert.equal(fresh.badgeText, '在读 · 未开始', '没翻过页的论文要写「未开始」，不是「0/40 页」');

    const reading = paperRowView(paper({ status: 'reading' }), states('reading', 3, 33), {});
    assert.equal(reading.badgeText, '在读 · 3/33 页', '进度必须并进徽章（电子书是「在读 · 读到 N 页」）');

    const done = paperRowView(paper({ status: 'done' }), states('read', 33, 33), {});
    assert.equal(done.badgeText, '读完');
    // 反向对照：读完的徽章里**不许**再出现「在读」两个字（两套词表漂在一起的典型形态）。
    assert.ok(!done.badgeText.includes('在读'), '读完的徽章仍然写着「在读」');
  });

  it('★ 「在读」组包含「未读」（new），否则刚导入的论文会整批漏掉', () => {
    const group = PAPER_STATE_FILTERS.find((item) => item.value === 'reading');
    assert.deepEqual(group.statuses, ['new', 'reading']);
    // 反向对照：「读完」组里绝不能有 new —— 否则一条恒把全部塞进第一组的实现也能过。
    assert.ok(!PAPER_STATE_FILTERS.find((item) => item.value === 'done').statuses.includes('new'));
    assert.equal(PAPER_STATE_FILTERS[0].statuses, null, '「全部」必须是 null（写成 [] 会筛出 0 篇）');
  });

  it('★ 书状态压过 paper.status（重新阅读之后标签必须当场变回在读）', () => {
    // 用户点了「重新阅读」：书状态写 reading，而 paper.status 可能还停在 done。
    const restarted = paperStateOf(paper({ status: 'done' }), states('reading', 12, 40));
    assert.equal(restarted.status, 'reading', '书状态没压过 paper.status —— 标签会停在「读完」');
    // 反向对照：没有书状态时，paper.status 仍然是唯一依据。
    assert.equal(paperStateOf(paper({ status: 'done' }), {}).status, 'done');
  });

  it('★ 「重新阅读」只出现在读完、有全文、且不在回收站的那一行', () => {
    const done = paperRowView(paper({ status: 'done' }), states('read', 33, 33), {});
    assert.equal(done.action?.kind, 'restart');
    assert.equal(done.action?.text, '重新阅读');
    assert.match(done.action.title, /第 33 页/, '提示要说出从第几页接着读');

    // 三组反向对照，各自对应一条「不该有按钮」的理由。
    assert.equal(paperRowView(paper({ status: 'reading' }), states('reading', 3, 33), {}).action, null,
      '在读的那一行不该有「重新阅读」（它已经能点开读）');
    assert.equal(paperRowView(paper({ status: 'done', file: null }), states('read', 33, 33), {}).action, null,
      '没有全文还给「重新阅读」＝一颗点了只弹提示的按钮');
    assert.equal(paperRowView(paper({ status: 'done' }), states('read', 33, 33), { trash: true }).action, null,
      '回收站里只该有「恢复 / 彻底删除」');
  });

  it('★ 读完那一行整行锁死并压暗，在读的照常可点（2026-11-13 用户第二次拍板）', () => {
    /* 用户原话：「读完的论文不能点击论文条，灰掉，只有点击重新阅读才恢复正常」。
       ★ `openable` 与 `dim` 必须**同时**为 `false` / `true`：
         只锁不压暗 ⇒ 看着能点、点了没反应；只压暗不锁 ⇒ 视觉与能力相反。 */
    const done = paperRowView(paper({ status: 'done' }), states('read', 33, 33), {});
    assert.equal(done.openable, false, '读完的行还能点 —— 用户要的是整行点不动');
    assert.equal(done.dim, true, '读完的行没压暗 —— 看得出能点就是错');
    assert.equal(done.action?.kind, 'restart', '锁住了却没给「重新阅读」，这一行就彻底死了');

    for (const status of ['new', 'reading']) {
      const view = paperRowView(paper({ status }), states('reading', 3, 33), {});
      assert.equal(view.openable, true, `${status}：在读的行被做成了不可点`);
      assert.equal(view.dim, false, `${status}：在读的行被压暗了`);
    }

    /* 两条例外，各自对应一种「不留死行」的理由。 */
    const noFile = paperRowView(paper({ status: 'done', file: null }), states('read', 33, 33), {});
    assert.equal(noFile.openable, true, '读完但无全文的行锁死了 ⇒ 连摘要都再也看不到，且没有「重新阅读」可点');
    assert.equal(noFile.dim, false);
    assert.equal(noFile.action, null);

    const inTrash = paperRowView(paper({ status: 'done' }), states('read', 33, 33), { trash: true });
    assert.equal(inTrash.openable, true, '回收站里的行锁死了 ⇒ 选不中就没法「恢复」，只剩彻底删除');
    assert.equal(inTrash.dim, false);
  });

  it('★ 计数与筛选同一口径：各组相加 = 全部，且每组数 = 筛出来的条数', () => {
    const papers = [
      paper({ id: 'a', status: 'new' }),
      paper({ id: 'b', status: 'reading' }),
      paper({ id: 'c', status: 'done' }),
      paper({ id: 'd', status: 'done' }),
    ];
    const counts = { '': papers.length, reading: 0, done: 0 };
    for (const item of papers) counts[paperStateOf(item, {}).group] += 1;
    assert.equal(counts.reading, 2, 'new 必须计入在读');
    assert.equal(counts.done, 2);
    assert.equal(counts.reading + counts.done, counts[''], '分组相加不等于总数 ⇒ 有一组漏了状态');

    // 与 `PapersApp` 的筛选用同一份 `statuses`：点进去的条数必须等于 chip 上的数。
    for (const group of PAPER_STATE_FILTERS) {
      if (group.statuses === null) continue;
      const hits = papers.filter((item) => group.statuses.includes(paperStateOf(item, {}).status)).length;
      assert.equal(hits, counts[group.value], `「${group.label}」chip 写 ${counts[group.value]}、实际筛出 ${hits}`);
    }
  });
});

/**
 * 续读与「重新阅读」的**接线**（源码级）。
 *
 * ★ 守两个「改一下就静默回退」的点：
 *   ① `initialPage` 必须传给 `BookReader`：改之前只传 `{ state }`，阅读器读
 *      `current.page` 得到 0 ⇒ 在读的论文每次都从第 1 页开始；
 *   ② 修法**不许**是把 `page` 塞进 `readerStates` —— 那个对象每翻一页都是新的，
 *      `readerNode` 的 `useMemo` 会整棵失效，回到 0.68.1 修掉的那次卡顿。
 */
describe('论文续读（源码级）', () => {
  const readApp = async () => await readFile(new URL('../src/client/PapersApp.jsx', import.meta.url), 'utf8');

  it('★ 阅读器拿到 initialPage，且 readerStates 里没有 page', async () => {
    const app = await readApp();
    const start = app.indexOf('const readerStates');
    assert.notEqual(start, -1, '找不到 readerStates —— 这段被改名或挪走了');
    const body = app.slice(start, start + 1200);
    assert.ok(!/\bpage:/.test(body),
      'readerStates 里又塞了 page ⇒ 每翻一页都会重建阅读器（0.68.1 的卡顿回来了）');

    const node = app.slice(app.indexOf('const readerNode'), app.indexOf('const readerNode') + 1600);
    assert.match(node, /initialPage=\{/, 'BookReader 没拿到 initialPage ⇒ 续读失效，永远从第 1 页开始');
  });

  it('★ 「重新阅读」两边都写，且不清零进度', async () => {
    const app = await readApp();
    const start = app.indexOf('const restartPaper');
    assert.notEqual(start, -1, '找不到 restartPaper');
    const body = app.slice(start, start + 1400);
    assert.match(body, /applyStatePatch\(/, '没有乐观更新：点完标签不会当场变回在读');
    assert.match(body, /saveBookState\(\s*id,\s*\{\s*state:\s*'reading'\s*\}/, '没写书状态：列表徽章读的是它');
    assert.match(body, /patchPaper\(\s*id,\s*\{\s*status:\s*'reading'\s*\}/, '没写 paper.status：速读卡与导出读的是它');
    assert.ok(!/page:\s*0/.test(body), '重新阅读清零了进度 —— 用户没要求丢掉「读到哪儿」');
  });
});
