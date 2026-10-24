/**
 * `src/client/pdfjs.js` 的**会话级文档缓存**。
 *
 * 为什么要有这个文件：缓存存在的两个理由都是真机上暴露的故障 ——
 *   ① 换书时 `BookReader` 是卸载重挂，没有缓存就每点一次都重新「正在取书…」；
 *   ② 销毁入口写错（对文档代理调 `destroy()`）会让整个阅读器变成
 *      「阅读器页面加载失败：loaded.destroy is not a function」。
 *
 * ★ 夹具刻意让**文档代理上没有 `destroy`**（真 pdf.js 6.4.299 就是这样，见
 *   test/pdfjs-vendor.test.mjs 里那条真跑断言）。这不是省事：如果夹具给代理也
 *   配一个 destroy，那么「实现错写成 doc.destroy()」的版本**照样全绿**。
 *   下面另有一条自检专门钉住这个前提。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  INITIAL_CHUNK_BYTES, cachedBookCount, forgetBook, openCachedBook, releaseBooks,
} from '../src/client/pdfjs.js';

/**
 * 取字节的桩：只提供一个合法 206，并记录每一次请求。
 *
 * ★ 必须返回**真 `Response`**，不能手写 `{ status, arrayBuffer }`。真 fetch 的响应
 *   **一定**带 `headers`；假对象省掉它，就等于允许实现「读 `response.headers`」
 *   在测试里活下来 —— 0.24.4 给 `fetchBookRange` 加 `content-range` 校验时，这个
 *   桩当场炸了 9 条用例（`Cannot read properties of undefined (reading 'get')`），
 *   而线上是好的。夹具比真货宽松，是「测试通过但线上崩」的经典来源。
 *
 * ★ 顺手让 body 长度与 `content-range` 自洽（按请求的区间切）。这里不模拟书的
 *   真实长度（桩不知道），只保证「起点/终点/长度」三者不互相矛盾。
 */
function stubFetch({ failing = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const range = init?.headers?.Range ?? null;
    calls.push({ url, range });
    if (failing) throw new Error('网络断了');
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    const begin = match ? Number(match[1]) : 0;
    const end = match ? Number(match[2]) : 0;
    const body = new Uint8Array(Math.max(end - begin + 1, 1)).fill(7);
    return new Response(body, {
      status: 206,
      headers: { 'content-range': `bytes ${begin}-${end}/${end + 1}` },
    });
  };
  return calls;
}

/**
 * 假的 pdf.js 模块。形状照真货：`PDFDataRangeTransport(length, initialData, progressiveDone)`，
 * `getDocument(options)` 同步返回带 `promise` / `destroy` 的 loading task。
 */
function fakePdfjs(record) {
  class FakeTransport {
    constructor(length, initialData, progressiveDone) {
      this.length = length;
      this.initialData = initialData;
      this.progressiveDone = progressiveDone;
    }
    requestDataRange() {}
    onDataRange() {}
    abort() {}
  }
  return {
    PDFDataRangeTransport: FakeTransport,
    getDocument(options) {
      record.opened.push(options);
      // ★ 刻意**没有** destroy —— 与真 pdf.js 6.4.299 的 PDFDocumentProxy 一致。
      const doc = { numPages: 3, loadingTask: null };
      const task = {
        promise: Promise.resolve(doc),
        destroy() { record.destroyed += 1; return Promise.resolve(); },
      };
      doc.loadingTask = task;
      record.tasks.push(task);
      return task;
    },
  };
}

let record;
let pdfjs;

beforeEach(() => {
  releaseBooks();
  record = { opened: [], destroyed: 0, tasks: [] };
  pdfjs = fakePdfjs(record);
});

afterEach(() => {
  releaseBooks();
  delete globalThis.fetch;
});

describe('夹具与真 pdf.js 同形', () => {
  it('★ 文档代理上**没有** destroy（否则「实现错写成 doc.destroy()」会假绿）', async () => {
    stubFetch();
    const { doc } = await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 });
    assert.equal(typeof doc.destroy, 'undefined', 'PDFDocumentProxy 在 6.4.299 上没有 destroy');
    assert.equal(typeof doc.loadingTask.destroy, 'function', '销毁入口在 loadingTask 上');
  });
});

describe('复用', () => {
  it('★ 第二次打开同一本书是命中缓存：不再取字节、不再解析', async () => {
    const calls = stubFetch();
    const first = await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 });
    const second = await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 });

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.doc, first.doc, '必须是同一个文档对象（否则页码/渲染状态会分叉）');
    assert.equal(calls.length, 1, `只该取一次字节，实际 ${calls.length} 次`);
    assert.equal(record.opened.length, 1, '只该 getDocument 一次');
    assert.equal(record.destroyed, 0, '还在用，不该销毁');
  });

  it('首块大小就是 INITIAL_CHUNK_BYTES（书比它小时按书的长度取）', async () => {
    const calls = stubFetch();
    await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 });
    assert.equal(calls[0].range, `bytes=0-${4095}`, '短书不该去要超过本身的区间');

    const big = stubFetch();
    await openCachedBook(pdfjs, { bookId: 'bk-2', length: 8 << 20 });
    assert.equal(big[0].range, `bytes=0-${INITIAL_CHUNK_BYTES - 1}`, '大书只取首块，不整本拖');
  });

  it('字节数变了（同名但文件被换过）视为另一本，不会错误复用', async () => {
    stubFetch();
    await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 });
    const other = await openCachedBook(pdfjs, { bookId: 'bk-1', length: 8192 });
    assert.equal(other.cached, false);
    assert.equal(record.opened.length, 2, '长度进缓存键，必须重新解析');
  });

  it('★ 同时点两下同一本只开一次（并发去重）', async () => {
    const calls = stubFetch();
    const [a, b] = await Promise.all([
      openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 }),
      openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 }),
    ]);
    assert.equal(a.doc, b.doc);
    assert.equal(calls.length, 1, '并发不该取两遍字节');
    assert.equal(record.opened.length, 1);
  });
});

describe('淘汰与释放', () => {
  it('★ 超编淘汰时销毁的是 loadingTask（代理上根本没有 destroy）', async () => {
    stubFetch();
    for (let index = 0; index < 5; index += 1) {
      await openCachedBook(pdfjs, { bookId: `bk-${index}`, length: 4096 });
    }
    assert.equal(cachedBookCount(), 3, '缓存上限是 3 本');
    // 反向对照：如果销毁写成了 `doc.destroy()`，代理上没有这个方法（`destroyEntry`
    // 会把它吞掉），计数器就停在 0 —— 这条会立刻变红。
    assert.equal(record.destroyed, 2, '5 本进 3 位缓存 ⇒ 淘汰 2 本');
  });

  it('forgetBook 立刻释放 —— 「重试」要靠它拿干净的一份', async () => {
    stubFetch();
    await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 });
    forgetBook('bk-1');
    assert.equal(cachedBookCount(), 0);
    assert.equal(record.destroyed, 1);

    const again = await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 });
    assert.equal(again.cached, false, '忘掉之后必须真的重开（否则坏文档会永远打不开）');
  });

  it('forgetBook 不碰别的书', async () => {
    stubFetch();
    await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096 });
    await openCachedBook(pdfjs, { bookId: 'bk-2', length: 4096 });
    forgetBook('bk-1');
    assert.equal(cachedBookCount(), 1);
    const kept = await openCachedBook(pdfjs, { bookId: 'bk-2', length: 4096 });
    assert.equal(kept.cached, true, '另一本不该被牵连');
  });
});

describe('错误通道', () => {
  it('★ 复用时错误回调换成**最后一次**调用方（不该再往已卸载的组件写状态）', async () => {
    const calls = stubFetch();
    const firstErrors = [];
    await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096, onError: (error) => firstErrors.push(error.message) });
    const secondErrors = [];
    await openCachedBook(pdfjs, { bookId: 'bk-1', length: 4096, onError: (error) => secondErrors.push(error.message) });

    // 造一次后续取数失败，走传输层的重试耗尽那条路。
    calls.length = 0;
    stubFetch({ failing: true });
    const transport = record.opened[0].range;
    assert.notEqual(transport, undefined, 'transport 没被传给 getDocument，夹具失效了');
    transport.requestDataRange(0, 10);
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    assert.deepEqual(secondErrors, ['网络断了'], '当前调用方必须收到');
    assert.deepEqual(firstErrors, [], '旧组件的回调不该再被调用');
  });
});
