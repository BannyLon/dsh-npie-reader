/**
 * 书架 HTTP 面（`src/host/library-routes.js`）。
 *
 * ★ 这个文件测的是「一条链路上**唯一**会真的去读用户网盘文件、真的会改阅读进度」的接口，
 *   所以每一条分支都要有一个用例，尤其是**错误分支**：`404 / 400 / 405 / 415 / 416 / 500`
 *   在界面上是六句不同的话，合并成一句「加载失败」会让用户完全无法自查。
 *
 * ★ 两条最容易写成假绿的地方，本文件各有一条专门的断言：
 *   1. **封顶探测**：`content-length` 报的必须是**真实**文件大小（客户端靠它算 Range 偏移），
 *      而**发出去的字节**是封顶的。只断言其中一个，等于给「两者不一致」发合格证。
 *   2. **信任栅栏**：宿主派发插件路由**不经过**鉴权拦截器，所以这里漏一条就是全漏。
 *      用例必须证明「403 是因为栅栏，不是因为别的分支恰好也回 403」。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BOOKS_PAGE_LIMIT, LIBRARY_API_PREFIX, PDFJS_VENDOR_PREFIX } from '../src/library.js';
import { makeLibraryRoutes, vendorRelativePath } from '../src/host/library-routes.js';
import { createAnnotationStore } from '../src/host/annotation-store.js';

const API = LIBRARY_API_PREFIX;
const VENDOR = PDFJS_VENDOR_PREFIX;

/** 探测请求的封顶字节数（与实现同源，改动时这里会一起变红）。 */
const PROBE_LIMIT = 256 * 1024;
const SMALL = 4096;
const BIG = 1_000_000;

// ---------------------------------------------------------------------------
// 假 req / 假 res
// ---------------------------------------------------------------------------

/** 造一条「可信」的请求；`headers` 可覆盖，用于栅栏的反向对照。 */
function fakeReq({ url = `${API}/books`, method = 'GET', headers = {}, body } = {}) {
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:52431', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
  /**
   * `readBody` 用 `for await (const chunk of req)` 读，而**真实的 `IncomingMessage`
   * 永远是异步可迭代的** —— 不带 body 的 POST 也能迭代，只是立刻结束。
   *
   * ★ 所以这里一律挂上迭代器（`body` 缺省 = 零字节），而不是「有 body 才挂」：
   *   后者会让「路由新加了一次 `readBody`」表现为 `req is not async iterable` 的
   *   内部错误，而不是「这个请求没有 body」这个**事实**。实测踩过：`POST /sources/scan`
   *   改成读 body 之后，不带 body 的用例全变成 400，报告出来的却是一句与业务
   *   毫不相干的 TypeError。
   */
  req[Symbol.asyncIterator] = async function* iterate() {
    if (body !== undefined) yield Buffer.from(body);
  };
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    chunks: [],
    flushCount: 0,
    ended: false,
    destroyed: false,
    writableEnded: false,
    handlers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    flushHeaders() { this.flushCount += 1; },
    write(chunk, done) {
      this.chunks.push(Buffer.from(chunk));
      if (typeof done === 'function') done();
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      this.ended = true;
      this.writableEnded = true;
      return this;
    },
    destroy() { this.destroyed = true; return this; },
    on(event, handler) { this.handlers[event] = handler; return this; },
    /** 测试里手动模拟「客户端断开」。 */
    emitClose() { this.handlers.close?.(); },
    get body() { return Buffer.concat(this.chunks); },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

// ---------------------------------------------------------------------------
// 假书库
// ---------------------------------------------------------------------------

function book(id, { ext = 'pdf', size = SMALL, fsId = 1 } = {}) {
  return { id, title: `书 ${id}`, ext, size, fsId, filename: `${id}.${ext}` };
}

const DEFAULT_BOOKS = [book('b1'), book('b2', { ext: 'epub' }), book('b3', { fsId: 0 }), book('b4', { size: 0 })];

/**
 * 造一套路由 + 可断言的调用记录。所有依赖都是假的，**不联网**。
 *
 * ★★ `bookById` / `setState` 刻意写成 **async** —— 与真实调用方一致
 *    （`service.js` 传的是 `id => this.bookById(id)`，那个方法要 `await` 书单载入）。
 *    这里写成同步会让「路由漏了 `await`」这一类 bug **完全测不出来**：
 *    漏 await 时 `book` 是一个 Promise，`book === undefined` 为假、`book.fsId` 是
 *    `undefined` ⇒ 每一本书都回 400「没有网盘 fs_id」，而单元测试全绿。
 *    实测踩过：真机上点开任何一本书都报「取不到字节」，而这里 43 个用例全过。
 *    ⇒ 夹具的**签名**也是契约的一部分，不只是返回值。
 */
function harness(overrides = {}) {
  const calls = { listBooks: 0, reload: 0, setState: [], readBytes: [], errors: [] };
  const states = { b1: { state: 'reading', page: 3, pages: 100, at: 1 } };
  const handlers = {
    listBooks: async () => {
      calls.listBooks += 1;
      return { path: '/x/books.json', books: DEFAULT_BOOKS, skipped: 0, missing: false, error: '', bytes: 1234 };
    },
    bookById: async (id) => DEFAULT_BOOKS.find((entry) => entry.id === id),
    readBytes: async (target, start, end) => {
      calls.readBytes.push({ id: target.id, start, end });
      return Buffer.alloc(end - start + 1, 0x41);
    },
    getStates: () => states,
    setState: async (id, patch) => {
      calls.setState.push({ id, patch });
      states[id] = { state: 'reading', page: 1, pages: 10, at: 2, ...patch };
      return states[id];
    },
    reload: async () => { calls.reload += 1; },
    vendorRoot: '/nonexistent-vendor-root',
    log: (message) => calls.errors.push(message),
    ...overrides,
  };
  const routes = makeLibraryRoutes(handlers);
  return { routes, api: routes[0], vendor: routes[1], calls, states, handlers };
}

// ---------------------------------------------------------------------------
// 路由形状
// ---------------------------------------------------------------------------

describe('路由形状', () => {
  it('两条 prefix 路由，路径取自共用常量（宿主注册与客户端拼 URL 不会漂）', () => {
    const { routes } = harness();
    assert.equal(routes.length, 2);
    assert.deepEqual(routes.map((route) => route.kind), ['prefix', 'prefix']);
    assert.deepEqual(routes.map((route) => route.path), [API, VENDOR]);
    for (const route of routes) assert.equal(typeof route.handler, 'function');
  });
});

// ---------------------------------------------------------------------------
// 信任栅栏（两条路由都要过）
// ---------------------------------------------------------------------------

describe('信任栅栏', () => {
  it('两条路由对不可信请求都回 403，且**不碰**任何业务依赖', async () => {
    const { api, vendor, calls } = harness();
    for (const route of [api, vendor]) {
      const res = fakeRes();
      // Host 是攻击者域名（DNS rebinding 形态）—— socket 仍然是回环的。
      await route.handler(fakeReq({ url: `${route.path}/books`, headers: { host: 'evil.com' } }), res);
      assert.equal(res.status, 403, `${route.path} 没挡住`);
      assert.deepEqual(res.json, { ok: false, error: 'forbidden' });
    }
    // ★ 关键：栅栏必须在**任何**业务逻辑之前。若先查书单再鉴权，这里会看到 listBooks 被调用。
    assert.equal(calls.listBooks, 0);
    assert.deepEqual(calls.readBytes, []);
  });

  it('非回环 socket 也回 403（其余判据全部摆成通过）', async () => {
    const { api } = harness();
    const res = fakeRes();
    const req = fakeReq();
    req.socket.remoteAddress = '192.168.1.5';
    await api.handler(req, res);
    assert.equal(res.status, 403);
  });

  it('★ 反向对照：同样的请求，只把 Host 改回回环就通过 —— 证明 403 确实来自栅栏', async () => {
    const { api } = harness();
    const bad = fakeRes();
    await api.handler(fakeReq({ headers: { host: 'evil.com' } }), bad);
    const good = fakeRes();
    await api.handler(fakeReq(), good);
    assert.equal(bad.status, 403);
    assert.equal(good.status, 200);
  });
});

// ---------------------------------------------------------------------------
// /books
// ---------------------------------------------------------------------------

describe('GET /books', () => {
  it('返回全量书单与来源信息', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq(), res);
    assert.equal(res.status, 200);
    const body = res.json;
    assert.equal(body.ok, true);
    assert.equal(body.total, DEFAULT_BOOKS.length);
    assert.equal(body.truncated, false);
    assert.deepEqual(body.books.map((entry) => entry.id), ['b1', 'b2', 'b3', 'b4']);
    assert.equal(body.source.path, '/x/books.json');
    assert.equal(body.source.missing, false);
    assert.equal(body.source.bytes, 1234);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('★ 索引损坏时回 500 与**真实错误**，绝不回一个空书架', async () => {
    // 「文件写坏了」与「书全没了」在界面上必须是两件事：回空书架会让用户以为书丢了。
    const { api } = harness({
      listBooks: async () => ({ path: '/x/books.json', books: [], skipped: 0, missing: false, error: '索引不是合法 JSON：Unexpected token', bytes: 3 }),
    });
    const res = fakeRes();
    await api.handler(fakeReq(), res);
    assert.equal(res.status, 500);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /不是合法 JSON/);
    assert.equal(res.json.books, undefined);
  });

  it('索引文件不存在时照常 200（missing=true），由界面说「还没配书单」', async () => {
    const { api } = harness({
      listBooks: async () => ({ path: '/x/books.json', books: [], skipped: 0, missing: true, error: '', bytes: 0 }),
    });
    const res = fakeRes();
    await api.handler(fakeReq(), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.source.missing, true);
    assert.deepEqual(res.json.books, []);
  });

  it('超过 BOOKS_PAGE_LIMIT 时截断并标出来（安全阀，不是分页）', async () => {
    const many = Array.from({ length: BOOKS_PAGE_LIMIT + 7 }, (_, index) => book(`b${index}`));
    const { api } = harness({ listBooks: async () => ({ path: '/x', books: many, skipped: 0, missing: false, error: '', bytes: 1 }) });
    const res = fakeRes();
    await api.handler(fakeReq(), res);
    assert.equal(res.status, 200);
    // 两个数字必须一起断言：只断言其中一个，会让「截断了但没说」逃过去。
    assert.equal(res.json.books.length, BOOKS_PAGE_LIMIT);
    assert.equal(res.json.total, BOOKS_PAGE_LIMIT + 7);
    assert.equal(res.json.truncated, true);
  });

  it('方法不是 GET 回 405', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ method: 'DELETE' }), res);
    assert.equal(res.status, 405);
  });
});

// ---------------------------------------------------------------------------
// /reload
// ---------------------------------------------------------------------------

describe('POST /reload', () => {
  it('先 reload 再回新书单', async () => {
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/reload`, method: 'POST' }), res);
    assert.equal(calls.reload, 1);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.books.length, DEFAULT_BOOKS.length);
  });

  it('GET 回 405（避免预取/爬虫误触发重扫）', async () => {
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/reload` }), res);
    assert.equal(res.status, 405);
    assert.equal(calls.reload, 0);
  });
});

// ---------------------------------------------------------------------------
// /state
// ---------------------------------------------------------------------------

describe('/state', () => {
  it('GET 回状态表', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/state` }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.states, { b1: { state: 'reading', page: 3, pages: 100, at: 1 } });
  });

  it('POST 合法 body 时写入并把规范化后的状态回给客户端', async () => {
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({
      url: `${API}/state`,
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ id: 'b2', state: 'reading', page: 7, pages: 20 }),
    }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.setState, [{ id: 'b2', patch: { id: 'b2', state: 'reading', page: 7, pages: 20 } }]);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.id, 'b2');
    assert.equal(res.json.state.page, 7);
  });

  it('缺 JSON content-type 回 415（而不是当成空 body 静默写入）', async () => {
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/state`, method: 'POST', body: JSON.stringify({ id: 'b2' }) }), res);
    assert.equal(res.status, 415);
    assert.deepEqual(calls.setState, []);
  });

  it('id 非法回 400，且不调 setState', async () => {
    const { api, calls } = harness();
    for (const id of ['', 'a/b', 'a b', 'x'.repeat(65)]) {
      const res = fakeRes();
      await api.handler(fakeReq({
        url: `${API}/state`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, state: 'read' }),
      }), res);
      assert.equal(res.status, 400, `id=${JSON.stringify(id)}`);
      assert.equal(res.json.error, '无效的书 id');
    }
    assert.deepEqual(calls.setState, []);
  });

  it('body 不是合法 JSON / 不是对象时回 400', async () => {
    const { api } = harness();
    for (const body of ['{', '[1,2]', '"text"', 'null']) {
      const res = fakeRes();
      await api.handler(fakeReq({
        url: `${API}/state`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }), res);
      assert.equal(res.status, 400, `body=${body}`);
      assert.equal(res.json.ok, false);
    }
  });

  it('body 超过上限回 400（不是把内存撑爆）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({
      url: `${API}/state`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'b1', pad: 'x'.repeat(70 * 1024) }),
    }), res);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'body too large');
  });

  it('setState 抛错时回 400 并带上**它自己的话**（不是一句「失败」）', async () => {
    // 这是「服务端拒绝的理由要能到达用户」的那条路：比如 state 不是合法枚举。
    const { api } = harness({
      setState: () => { throw new Error('state 必须是 unread|reading|read|dropped 之一'); },
    });
    const res = fakeRes();
    await api.handler(fakeReq({
      url: `${API}/state`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'b1', state: 'finished' }),
    }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /unread\|reading\|read\|dropped/);
  });

  it('PUT / DELETE 回 405', async () => {
    const { api } = harness();
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = fakeRes();
      await api.handler(fakeReq({ url: `${API}/state`, method }), res);
      assert.equal(res.status, 405, method);
    }
  });
});

// ---------------------------------------------------------------------------
// /book/:id/raw
// ---------------------------------------------------------------------------

describe('GET /book/:id/raw', () => {
  it('没有这本书回 404', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/nope/raw` }), res);
    assert.equal(res.status, 404);
  });

  it('没有 fs_id 的书回 400，并说清为什么（不是笼统的「失败」）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b3/raw` }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /fs_id/);
  });

  it('体积为 0 的书回 400', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b4/raw` }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /体积/);
  });

  it('小文件 + 无 Range：200，整段发出，content-length 等于文件大小', async () => {
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw` }), res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String(SMALL));
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['content-range'], undefined);
    assert.equal(res.body.length, SMALL);
    assert.deepEqual(calls.readBytes, [{ id: 'b1', start: 0, end: SMALL - 1 }]);
  });

  it('★ 大文件 + 无 Range（pdf.js 的探测）：头报**真实**大小，body 却是封顶的', async () => {
    // ★ 两个数字必须一起断言。只断言 content-length 会让「其实发了整本」逃过去；
    //   只断言 body 长度会让「客户端算出错误的 Range 偏移」逃过去。
    const { api, calls } = harness({
      bookById: () => book('big', { size: BIG }),
    });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/big/raw` }), res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String(BIG), 'content-length 必须是真实文件大小');
    assert.equal(res.body.length, PROBE_LIMIT, 'body 必须是封顶的');
    assert.ok(res.body.length < BIG);
    assert.equal(res.destroyed, true, '封顶之后必须主动断开，否则客户端会以为「文件就读到这儿」');
    assert.deepEqual(calls.readBytes, [{ id: 'big', start: 0, end: PROBE_LIMIT - 1 }]);
  });

  it('恰好卡在 RANGE_MIN_SIZE 之下时**绝不封顶**（客户端会把整个响应当完整数据读走）', async () => {
    const size = 2 * PROBE_LIMIT;   // == RANGE_MIN_SIZE，条件要求 size > 它才封顶
    const { api, calls } = harness({ bookById: () => book('edge', { size }) });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/edge/raw` }), res);
    assert.equal(res.headers['content-length'], String(size));
    assert.equal(res.body.length, size);
    assert.equal(res.destroyed, false);
    assert.deepEqual(calls.readBytes, [{ id: 'edge', start: 0, end: size - 1 }]);
  });

  it('带 Range：206 + content-range + 精确的 content-length', async () => {
    const { api, calls } = harness({ bookById: () => book('big', { size: BIG }) });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/big/raw`, headers: { range: 'bytes=100-199' } }), res);
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], `bytes 100-199/${BIG}`);
    assert.equal(res.headers['content-length'], '100');
    assert.equal(res.body.length, 100);
    assert.deepEqual(calls.readBytes, [{ id: 'big', start: 100, end: 199 }]);
  });

  it('带 Range 时**不做**探测封顶（客户端明确要多少就给多少）', async () => {
    const { api, calls } = harness({ bookById: () => book('big', { size: BIG }) });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/big/raw`, headers: { range: `bytes=0-${BIG - 1}` } }), res);
    assert.equal(res.status, 206);
    assert.equal(res.body.length, BIG);
    assert.equal(res.destroyed, false);
    assert.deepEqual(calls.readBytes, [{ id: 'big', start: 0, end: BIG - 1 }]);
  });

  it('Range 起点越界回 416 + `bytes */size`，且**一个字节都不取**', async () => {
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw`, headers: { range: `bytes=${SMALL}-` } }), res);
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], `bytes */${SMALL}`);
    assert.equal(res.body.length, 0);
    assert.deepEqual(calls.readBytes, []);
  });

  it('多段 Range 也回 416（不偷偷只取第一段）', async () => {
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw`, headers: { range: 'bytes=0-9,20-29' } }), res);
    assert.equal(res.status, 416);
    assert.deepEqual(calls.readBytes, []);
  });

  it('HEAD 只发头，不发 body，也不去网盘取字节', async () => {
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw`, method: 'HEAD' }), res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-length'], String(SMALL));
    assert.equal(res.body.length, 0);
    assert.equal(res.ended, true);
    assert.deepEqual(calls.readBytes, []);
  });

  it('★ 响应头在取字节**之前**就 flush（探测请求只等头，压在第一次 write 之后会让它干等）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw` }), res);
    assert.equal(res.flushCount, 1);
  });

  it('取字节失败时不抛错（头已发出，改不了状态码），只记日志并结束响应', async () => {
    const { api, calls } = harness({
      readBytes: async () => { throw new Error('网盘返回 HTTP 500'); },
    });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw` }), res);
    assert.equal(res.ended, true);
    assert.equal(res.body.length, 0);
    assert.equal(calls.errors.length, 1);
    assert.match(calls.errors[0], /网盘返回 HTTP 500/);
  });

  it('★ 客户端中途断开时不再往 socket 写（结果直接丢掉）', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { api } = harness({
      readBytes: async () => { await gate; return Buffer.alloc(SMALL, 0x41); },
    });
    // ★ 必须等到路由**真的**注册了 `close` 监听再模拟断开。以前这里直接
    //   `emitClose()`，在夹具的 `bookById` 还是同步时侥幸能过；`bookById` 改成
    //   async（与真调用方一致）之后，`api.handler()` 会在第一个 await 处让出，
    //   `emitClose()` 打在还没注册监听的对象上 ⇒ 静默变成 no-op ⇒ 用例以
    //   「断开后仍然写了 4096 字节」的形式变红。同步点用 `flushHeaders`：
    //   它就排在 `res.on('close')` 的前一行。
    let headersFlushed;
    const flushed = new Promise((resolve) => { headersFlushed = resolve; });
    const res = fakeRes();
    res.flushHeaders = () => headersFlushed();

    const pending = api.handler(fakeReq({ url: `${API}/book/b1/raw` }), res);
    await flushed;
    assert.equal(typeof res.handlers.close, 'function', '断开前必须已经注册了 close 监听');
    res.emitClose();
    release();
    await pending;
    assert.equal(res.body.length, 0, '断开之后不该再写字节');
    assert.equal(res.destroyed, false);
  });

  it('方法不是 GET / HEAD 回 405', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw`, method: 'POST' }), res);
    assert.equal(res.status, 405);
  });

  it('id 形态不合法（含斜杠 / 过长）时落到 404，不会去查书库', async () => {
    const { api } = harness();
    for (const url of [`${API}/book/a%2Fb/raw`, `${API}/book/${'x'.repeat(65)}/raw`, `${API}/book//raw`]) {
      const res = fakeRes();
      await api.handler(fakeReq({ url }), res);
      assert.equal(res.status, 404, url);
    }
  });

  it('未知子路径回 404', async () => {
    const { api } = harness();
    for (const suffix of ['', '/nope', '/book', '/book/b1', '/book/b1/pages']) {
      const res = fakeRes();
      await api.handler(fakeReq({ url: `${API}${suffix}` }), res);
      assert.equal(res.status, 404, suffix);
    }
  });
});

// ---------------------------------------------------------------------------
// vendor 静态资源
// ---------------------------------------------------------------------------

// ★ 这个临时目录必须在**模块顶层**建：`describe` 的回调不是 async，里面写 `await`
//   会变成语法错误（`Unexpected reserved word`），而报错位置离原因很远。
//
// ★ 目录结构刻意做成「vendor 目录**外面**放一份机密文件」：穿越测试要断言的不是
//   「回了 404」，而是「**那份文件一个字节都没漏出去**」—— 前者可能因为别的原因恰好
//   也是 404（比如路由没匹配上），后者才是真正的安全属性。
const SANDBOX = await mkdtemp(join(tmpdir(), 'npie-vendor-'));
const VENDOR_ROOT = join(SANDBOX, 'pdfjs');
const OUTSIDE = join(SANDBOX, 'outside');
const SECRET_MARKER = 'TOP-SECRET-MARKER-DO-NOT-LEAK';

await mkdir(join(VENDOR_ROOT, 'cmaps'), { recursive: true });
await mkdir(join(VENDOR_ROOT, 'wasm'), { recursive: true });
await mkdir(OUTSIDE, { recursive: true });
await writeFile(join(VENDOR_ROOT, 'pdf.mjs'), 'export const x = 1;\n');
await writeFile(join(VENDOR_ROOT, 'cmaps', 'a.bcmap'), Buffer.from([1, 2, 3]));
await writeFile(join(VENDOR_ROOT, 'wasm', 'x.wasm'), Buffer.from([0, 97, 115, 109]));
await writeFile(join(OUTSIDE, 'secret.txt'), SECRET_MARKER);
// ★ 清理失败是**沙箱限制**（某些安全策略会对 rm 回 EPERM），不是被测代码的问题：
//   吞掉它，否则整个文件会挂一个与业务无关的 hook 失败。
after(() => rm(SANDBOX, { recursive: true, force: true }).catch(() => {}));

describe('vendor 静态资源', () => {
  const root = VENDOR_ROOT;

  it('按扩展名给 content-type，并带 nosniff', async () => {
    const { vendor } = harness({ vendorRoot: root });
    const cases = [
      ['/pdf.mjs', 'text/javascript; charset=utf-8'],
      ['/cmaps/a.bcmap', 'application/octet-stream'],
    ];
    for (const [suffix, type] of cases) {
      const res = fakeRes();
      await vendor.handler(fakeReq({ url: `${VENDOR}${suffix}` }), res);
      assert.equal(res.status, 200, suffix);
      assert.equal(res.headers['content-type'], type, suffix);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['content-length'], String(res.body.length));
    }
  });

  it('不存在的文件 / 目录都回 404（不列目录）', async () => {
    const { vendor } = harness({ vendorRoot: root });
    for (const suffix of ['/nope.mjs', '/cmaps', '/wasm']) {
      const res = fakeRes();
      await vendor.handler(fakeReq({ url: `${VENDOR}${suffix}` }), res);
      assert.equal(res.status, 404, suffix);
    }
  });

  it('前缀本身（没有文件名）回 404', async () => {
    const { vendor } = harness({ vendorRoot: root });
    for (const suffix of ['', '/']) {
      const res = fakeRes();
      await vendor.handler(fakeReq({ url: `${VENDOR}${suffix}` }), res);
      assert.equal(res.status, 404, suffix);
    }
  });

  it('★ 目录穿越：百分号编码的 `..` 必须在**路由层**就被挡住，且机密文件一个字节都不漏', async () => {
    // URL 解析器会把**字面**的 `..` 归一掉（于是根本进不到 handler），所以真正要测的是
    // 编码形态 —— 那是能穿过 URL 解析、直达 decodeURIComponent 的那一种。
    const { vendor } = harness({ vendorRoot: root });
    const attacks = [
      '/%2e%2e%2foutside%2fsecret.txt',
      '/%2e%2e/outside/secret.txt',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/cmaps/%2e%2e%2f%2e%2e%2foutside%2fsecret.txt',
      '/%2e%2e%5coutside%5csecret.txt',
      '/..%5c..%5coutside%5csecret.txt',
      '/%00pdf.mjs',
      '/a%5cb',
      '/%2fetc%2fpasswd',
    ];
    for (const suffix of attacks) {
      const res = fakeRes();
      await vendor.handler(fakeReq({ url: `${VENDOR}${suffix}` }), res);
      assert.equal(res.status, 404, suffix);
      // ★ 真正的安全属性：无论回什么状态码，机密内容都不能出现在响应体里。
      assert.equal(res.body.includes(SECRET_MARKER), false, `${suffix} 泄露了目录外的文件`);
    }
  });

  it('★ 反向对照：把机密文件**放进** vendor 目录后同一段路径能取到 —— 证明上一条不是「路由整个坏了」', async () => {
    // 没有这条，「所有穿越请求都 404」可能只是因为 vendor 路由压根没工作。
    await writeFile(join(root, 'inside.txt'), SECRET_MARKER);
    const { vendor } = harness({ vendorRoot: root });
    const res = fakeRes();
    await vendor.handler(fakeReq({ url: `${VENDOR}/inside.txt` }), res);
    assert.equal(res.status, 200);
    assert.equal(res.body.includes(SECRET_MARKER), true);
  });

  it('vendorRelativePath 单元级：合法路径原样通过，越界一律 undefined', () => {
    assert.equal(vendorRelativePath(`${VENDOR}/pdf.mjs`), 'pdf.mjs');
    assert.equal(vendorRelativePath(`${VENDOR}/cmaps/a.bcmap`), 'cmaps/a.bcmap');
    assert.equal(vendorRelativePath(`${VENDOR}//pdf.mjs`), 'pdf.mjs');

    for (const pathname of [
      `${VENDOR}/../secret`,
      `${VENDOR}/%2e%2e%2fsecret`,
      `${VENDOR}/a/../../secret`,
      `${VENDOR}/a\\b`,
      `${VENDOR}/%5c`,
      `${VENDOR}/%00`,
      `${VENDOR}/%E0%A4%A`,       // 坏编码
      `${VENDOR}`,
      `${VENDOR}/`,
      '/other/pdf.mjs',
    ]) {
      assert.equal(vendorRelativePath(pathname), undefined, pathname);
    }
  });

  it('★ 反向对照：把前缀换成不匹配的串，合法路径也应当被判越界（证明判据真的在看前缀）', () => {
    assert.equal(vendorRelativePath(`${VENDOR}/pdf.mjs`, '/wrong'), undefined);
  });
});

// ---------------------------------------------------------------------------
// 书源配置 + 网盘授权向导（`/sources`、`/sources/scan`、`/pan/*`）
// ---------------------------------------------------------------------------

/**
 * 书源那几条路由的夹具。
 *
 * ★ 与上面的 `harness` **分开写**，而且默认值是「书源依赖一个都不给」——
 *   因为这里要断言的第一件事就是**接线漏了会怎样**。真实的 `harness` 只喂了读书
 *   那条链路的依赖，正好就是那个形态。
 */
function sourceHarness(overrides = {}) {
  const calls = { setSources: [], setLoadedLists: [], scans: 0, scanIds: [], saveApp: [], token: [], logout: 0, dirs: [], verified: 0 };
  const SOURCE_ID = 's4117ec5863472f9c';
  /**
   * `getSources()` 的真实契约是**整份 payload**（见 `service.libraryPayload`）：
   * 书源（用户配置）+ 书单清单（扫描产出）+ 载入选择 + 外部书单 + 落点。
   * 夹具必须照抄这个形状 —— 0.7.x 那是「一个裸数组」，路由当时只把它原样转发。
   */
  const payload = () => ({
    sources: [{ id: SOURCE_ID, kind: 'local', path: '/books', name: 'books' }],
    lists: [{
      id: SOURCE_ID,
      name: 'books',
      kind: 'local',
      root: '/books',
      path: `/Users/x/.dsh/storages/dsh-npie-reader/lists/${SOURCE_ID}.json`,
      count: 2,
      generatedAt: 1_700_000_000_000,
      loaded: true,
    }],
    loadedListIds: [SOURCE_ID],
    external: { configured: '', resolved: '', used: false, count: 0, missing: false, error: '' },
    output: {
      dir: '/Users/x/.dsh/storages/dsh-npie-reader/lists',
      indexPath: '/Users/x/.dsh/storages/dsh-npie-reader/lists.json',
    },
    legacy: null,
  });
  const handlers = {
    getSources: async () => payload(),
    setSources: async (list) => { calls.setSources.push(list); },
    setLoadedLists: async (ids) => { calls.setLoadedLists.push(ids); },
    scanSources: async (options = {}) => {
      calls.scans += 1;
      calls.scanIds.push(options.id);
      return {
        total: 2,
        lists: [{ id: SOURCE_ID, name: 'books', count: 2, generatedAt: 1_700_000_000_000 }],
        errors: [{ root: '/缺', message: '目录不存在' }],
        stats: { local: 2 },
      };
    },
    panAuth: {
      status: async () => ({
        configured: true,
        appKeyPreview: 'KEY123…3456',
        authorized: true,
        expired: false,
        hasRefreshToken: true,
        expiresAt: 1_700_000_000_000,
        authorizeUrl: 'https://openapi.baidu.com/oauth/2.0/authorize?client_id=KEY123456',
      }),
      saveApp: async (appKey, secretKey) => { calls.saveApp.push({ appKey, secretKey }); },
      verifyApp: async () => { calls.verified += 1; return { ok: true }; },
      authorizeUrl: async () => 'https://openapi.baidu.com/oauth/2.0/authorize?client_id=KEY123456',
      completeAuthorization: async (code) => { calls.token.push(code); return { authorized: true }; },
      logout: async () => { calls.logout += 1; return { authorized: false, configured: true }; },
    },
    listPanDirs: async (path) => {
      calls.dirs.push(path);
      return [
        { name: '子目录', path: '/E书/子目录', isDir: true },
        { name: '甲.pdf', path: '/E书/甲.pdf', isDir: false },
      ];
    },
    ...overrides,
  };
  const routes = makeLibraryRoutes(handlers);
  return { api: routes[0], handlers, calls };
}

/** 带 JSON body 的请求 —— 真实客户端总是这么发的。 */
function jsonReq({ url, method = 'POST', body, headers = {} }) {
  return fakeReq({
    url,
    method,
    body: JSON.stringify(body ?? {}),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('书源路由：接线漏了必须退化成 404，而不是把 GET /books 一起打歪', () => {
  it('★ 书源依赖一个都不给时，七条新路由全部 404（且**不抛异常**）', async () => {
    // 用上面那个 `harness`：它只有读书那条链路的依赖，正是「接线漏了」的形态。
    const { api, calls } = harness();
    const targets = [
      [`${API}/sources`, 'GET'],
      [`${API}/sources`, 'POST'],
      [`${API}/sources/scan`, 'POST'],
      [`${API}/lists/load`, 'POST'],
      [`${API}/pan/app`, 'POST'],
      [`${API}/pan/token`, 'POST'],
      [`${API}/pan/logout`, 'POST'],
      [`${API}/pan/dirs?path=/E书`, 'GET'],
    ];
    for (const [url, method] of targets) {
      const res = fakeRes();
      await api.handler(fakeReq({ url, method }), res);
      assert.equal(res.status, 404, `${method} ${url} 应当退化成 404`);
      assert.deepEqual(res.json, { ok: false, error: 'not found' });
    }
    // 反向对照：一个 404 都不许碰到读书那条链路的依赖。
    assert.equal(calls.listBooks, 0);
  });

  it('★ 缺 `setLoadedLists` 一条也要退化成 404 —— 判据是「四条全在」，不是「有几条在」', async () => {
    // `sourcesReady` 里少一条却仍然挂路由的话，第三步的勾选会走到一个 `undefined`
    // 上，症状是「勾了没反应」而不是 404，最难查。
    const { api } = sourceHarness({ setLoadedLists: undefined });
    for (const [url, method] of [[`${API}/sources`, 'GET'], [`${API}/lists/load`, 'POST']]) {
      const res = fakeRes();
      await api.handler(fakeReq({ url, method }), res);
      assert.equal(res.status, 404, `${method} ${url}`);
    }
  });

  it('★ 退化的意义在这里：缺书源依赖时 `GET /books` 依然 200', async () => {
    // 一旦改成「缺依赖就抛」，整个 handler 会挂掉、连带把书架打歪 ——
    // 界面上表现为书架一直转圈，而真正的问题在书源那一侧，谁也看不出来。
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/books` }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  it('反向对照：依赖给齐了，同样这几条就不再是 404', async () => {
    const { api } = sourceHarness();
    for (const [url, method] of [
      [`${API}/sources`, 'GET'],
      [`${API}/sources/scan`, 'POST'],
      [`${API}/lists/load`, 'POST'],
      [`${API}/pan/logout`, 'POST'],
      [`${API}/pan/dirs?path=/E书`, 'GET'],
    ]) {
      const res = fakeRes();
      await api.handler(fakeReq({ url, method }), res);
      assert.equal(res.status, 200, `${method} ${url} 应当是 200`);
    }
  });

  it('书源依赖齐了、但网盘那两根线没接 → `/pan/*` 回 501 并说清缺什么', async () => {
    const { api } = sourceHarness({ panAuth: undefined });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/pan/app`, method: 'POST' }), res);
    assert.equal(res.status, 501);
    assert.match(res.json.error, /panAuth/);
    // 反向对照：书源那两条**不受影响**（两条退化判据是分开的）。
    const ok = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources`, method: 'GET' }), ok);
    assert.equal(ok.status, 200);
  });
});

describe('书源路由的信任栅栏（新路由同样一条都不能漏）', () => {
  it('★ 九条新路由对不可信请求全回 403，且**不碰**任何业务依赖', async () => {
    const { api, calls } = sourceHarness();
    const targets = [
      [`${API}/sources`, 'GET'],
      [`${API}/sources`, 'POST'],
      [`${API}/sources/scan`, 'POST'],
      [`${API}/lists/load`, 'POST'],
      [`${API}/pan/app`, 'POST'],
      [`${API}/pan/authorize`, 'POST'],
      [`${API}/pan/token`, 'POST'],
      [`${API}/pan/logout`, 'POST'],
      [`${API}/pan/dirs?path=/E书`, 'GET'],
    ];
    for (const [url, method] of targets) {
      const res = fakeRes();
      // Host 是攻击者域名（DNS rebinding 形态），socket 仍然是回环的。
      await api.handler(jsonReq({ url, method, headers: { host: 'evil.com' } }), res);
      assert.equal(res.status, 403, `${method} ${url} 没挡住`);
      assert.deepEqual(res.json, { ok: false, error: 'forbidden' });
    }
    // ★ 关键：栅栏必须在**任何**业务逻辑之前 —— 这里漏一条就是全漏。
    assert.deepEqual(calls.setSources, []);
    assert.deepEqual(calls.setLoadedLists, []);
    assert.equal(calls.scans, 0);
    assert.deepEqual(calls.saveApp, []);
    assert.equal(calls.logout, 0);
    assert.deepEqual(calls.dirs, []);
  });

  it('★ 反向对照：同样请求只把 Host 改回回环就通过 —— 403 确实来自栅栏', async () => {
    const { api, calls } = sourceHarness();
    const bad = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources`, method: 'GET', headers: { host: 'evil.com' } }), bad);
    const good = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources`, method: 'GET' }), good);
    assert.equal(bad.status, 403);
    assert.equal(good.status, 200);
    // 被挡的那次连一次写盘都不该发生。
    assert.deepEqual(calls.setSources, []);
  });
});

describe('GET /sources', () => {
  it('返回书源 + 书单清单 + 载入选择 + 落点 + 网盘状态（界面打开这一页要的就是这些）', async () => {
    const { api } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources`, method: 'GET' }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.sources, [{ id: 's4117ec5863472f9c', kind: 'local', path: '/books', name: 'books' }]);
    // 每份书单的计数与「勾没勾」都在这里 —— 界面不需要再各请求一次。
    assert.deepEqual(
      res.json.lists.map((row) => [row.id, row.count, row.loaded]),
      [['s4117ec5863472f9c', 2, true]],
    );
    assert.deepEqual(res.json.loadedListIds, ['s4117ec5863472f9c']);
    // 落点必须报出来：用户要能看见「点一下生成」会把书单写到哪儿。
    assert.equal(res.json.output.dir, '/Users/x/.dsh/storages/dsh-npie-reader/lists');
    assert.equal(res.json.output.indexPath, '/Users/x/.dsh/storages/dsh-npie-reader/lists.json');
    assert.equal(res.json.external.used, false);
    assert.equal(res.json.legacy, null);
    assert.equal(res.json.pan.authorized, true);
  });

  it('★ 不把网盘**秘密**发出去：响应里没有 token / secretKey 字段', async () => {
    // 路由层只是转发 `panAuth.status()`，而那个契约由 `pan-auth.test.mjs` 守着。
    // 这里再拦一道，是因为「顺手把上游对象整个展开」很容易把凭证带出来。
    const { api } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources`, method: 'GET' }), res);
    const text = JSON.stringify(res.json);
    for (const key of ['access_token', 'refresh_token', 'secretKey']) {
      assert.equal(text.includes(key), false, `响应里出现了 ${key}`);
    }
    /**
     * ★ 这里**不**断言「响应里没有 AppKey」，因为那是错的判据：
     *   `authorizeUrl` 里的 `client_id=<AppKey>` 是必须带上的（用户要拿这条地址去浏览器
     *   点授权），而 AppKey 本就是公开的一半 —— 秘密的是 SecretKey。
     *   要守的是**展示用**的那个字段必须是掩码形态。
     */
    assert.equal(res.json.pan.appKeyPreview, 'KEY123…3456');
    assert.equal(/^[A-Za-z0-9]{6,64}$/.test(res.json.pan.appKeyPreview), false, 'appKeyPreview 是明文 AppKey');
  });

  it('方法不对 → 405（不是 404 —— 让排障的人知道路由在，只是方法用错）', async () => {
    const { api } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources`, method: 'DELETE' }), res);
    assert.equal(res.status, 405);
  });
});

describe('POST /sources', () => {
  it('转发 body.sources，并回填**宿主规范化后**的结果（客户端不做乐观更新）', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/sources`, body: { sources: [{ kind: 'pan', path: '/E书' }] } }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.setSources, [[{ kind: 'pan', path: '/E书' }]]);
    // 回填的是 `getSources()` 的当前值，不是把入参原样吐回去。
    assert.deepEqual(res.json.sources, [{ id: 's4117ec5863472f9c', kind: 'local', path: '/books', name: 'books' }]);
    assert.equal(res.json.ok, true);
  });

  it('body 里有坏行是**业务层**的事：路由照样 200（丢坏行的判据在 `validateSettings`）', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    const dirty = [{ kind: 'bogus', path: '/x' }, { kind: 'local', path: '/books' }];
    await api.handler(jsonReq({ url: `${API}/sources`, body: { sources: dirty } }), res);
    assert.equal(res.status, 200);
    // 路由**不**自行过滤 —— 过滤只在一个地方实现（`normalizeBookSources`），
    // 路由再抄一遍就会和设置页的判据漂开。
    assert.deepEqual(calls.setSources, [dirty]);
  });

  it('★ body 不是 JSON 对象 → 400（而不是把 undefined 当书源存下去）', async () => {
    const { api, calls } = sourceHarness();
    for (const raw of ['[1,2]', 'null', '"x"', '不是 json']) {
      const res = fakeRes();
      await api.handler(fakeReq({
        url: `${API}/sources`,
        method: 'POST',
        body: raw,
        headers: { 'content-type': 'application/json' },
      }), res);
      assert.equal(res.status, 400, raw);
      assert.equal(res.json.ok, false);
    }
    assert.deepEqual(calls.setSources, []);
  });

  it('★ `setSources` 抛错 → 400 且把原因带上（写盘失败要能看见）', async () => {
    const { api } = sourceHarness({ setSources: async () => { throw new Error('书源必须是数组'); } });
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/sources`, body: { sources: 'x' } }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /书源必须是数组/);
  });
});

describe('POST /sources/scan', () => {
  it('★ 单个源失败**不让整次扫描失败**：200 + 结果 + 逐条 errors', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources/scan`, method: 'POST' }), res);
    assert.equal(res.status, 200, '一个源坏了不该把整次扫描判成失败');
    assert.equal(calls.scans, 1);
    assert.equal(res.json.total, 2);
    // ★ `scanned` 是**这一轮实际生成**的那几份；`lists` 是 payload 给的全量状态（带 loaded）。
    //   两者形状不同、含义不同，所以名字也必须不同 —— 同名时后者会静默盖掉前者。
    assert.deepEqual(res.json.scanned, [{ id: 's4117ec5863472f9c', name: 'books', count: 2, generatedAt: 1_700_000_000_000 }]);
    assert.deepEqual(res.json.errors, [{ root: '/缺', message: '目录不存在' }]);
    assert.deepEqual(res.json.stats, { local: 2 });
    // 扫描完顺手回填整份 payload（含新计数与载入选择），省客户端一次往返。
    assert.equal(res.json.output.indexPath, '/Users/x/.dsh/storages/dsh-npie-reader/lists.json');
    assert.deepEqual(res.json.lists.map((row) => row.loaded), [true]);
    assert.deepEqual(res.json.loadedListIds, ['s4117ec5863472f9c']);
    // 不传 `id` = 生成全部。
    assert.deepEqual(calls.scanIds, [undefined]);
  });

  it('★ 传 `id` 时透传下去 —— 第二步每行一个「生成」按钮靠它', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/sources/scan`, body: { id: 's4117ec5863472f9c' } }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.scanIds, ['s4117ec5863472f9c']);
  });

  it('整次扫描抛错（例如一个源都没配）→ 400 且带原因', async () => {
    const { api } = sourceHarness({ scanSources: async () => { throw new Error('还没有配任何书源'); } });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources/scan`, method: 'POST' }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /还没有配任何书源/);
  });

  it('方法不对 → 405', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/sources/scan`, method: 'GET' }), res);
    assert.equal(res.status, 405);
    assert.equal(calls.scans, 0, '方法不对时不许真去扫盘');
  });
});

describe('POST /lists/load', () => {
  it('转发 body.ids 并回填 payload —— 第三步「一次载入多份」只有这一条路', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/lists/load`, body: { ids: ['s4117ec5863472f9c', 'sdeadbeefdeadbeef'] } }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.setLoadedLists, [['s4117ec5863472f9c', 'sdeadbeefdeadbeef']]);
    assert.deepEqual(res.json.loadedListIds, ['s4117ec5863472f9c']);
    assert.equal(res.json.ok, true);
  });

  it('★ 空数组是**合法**入参（第三步「一份都不载入」）—— 与「漏传字段」不是一回事', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/lists/load`, body: { ids: [] } }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.setLoadedLists, [[]]);
  });

  it('漏传 `ids` ⇒ 宿主侧收到 undefined（由 `normalizeLibraryListIds` 决定怎么兜）', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/lists/load`, body: {} }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.setLoadedLists, [undefined]);
  });

  it('★ `setLoadedLists` 抛错 → 400 且带原因', async () => {
    const { api } = sourceHarness({ setLoadedLists: async () => { throw new Error('已载入书单必须是数组'); } });
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/lists/load`, body: { ids: 'x' } }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /已载入书单必须是数组/);
  });

  it('方法不对 → 405', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/lists/load`, method: 'GET' }), res);
    assert.equal(res.status, 405);
    assert.deepEqual(calls.setLoadedLists, []);
  });
});

describe('网盘向导：/pan/app · /pan/authorize · /pan/token · /pan/logout', () => {
  it('POST /pan/app 存凭证并回新的网盘状态', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/pan/app`, body: { appKey: 'KEY123456', secretKey: 'SECRET123456' } }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.saveApp, [{ appKey: 'KEY123456', secretKey: 'SECRET123456' }]);
    assert.equal(res.json.pan.authorized, true);
    // ★ 回的是 `status()`，所以凭证不会被带回去。
    assert.equal(JSON.stringify(res.json).includes('SECRET123456'), false);
  });

  it('凭证形态不对 → 400（用户手抄错一位要在这里看见）', async () => {
    const { api } = sourceHarness({ panAuth: {
      ...sourceHarness().handlers?.panAuth,
      saveApp: async () => { throw new Error('AppKey 形态不对'); },
    } });
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/pan/app`, body: { appKey: 'x' } }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /形态不对/);
  });

  it('★ POST /pan/authorize 先自检再给地址（错的 AppKey 不该让用户白点一圈）', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/pan/authorize`, method: 'POST' }), res);
    assert.equal(res.status, 200);
    assert.equal(calls.verified, 1);
    assert.equal(res.json.clientOk, true);
    assert.match(res.json.url, /oauth\/2\.0\/authorize/);
  });

  it('自检不过也要把地址给出来 + 一句原因（用户可能只是想再试一次）', async () => {
    const { api } = sourceHarness({
      panAuth: {
        ...sourceHarness().handlers?.panAuth,
        verifyApp: async () => ({ ok: false, reason: '百度不认识这个 AppKey' }),
      },
    });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/pan/authorize`, method: 'POST' }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.clientOk, false);
    assert.match(res.json.reason, /不认识这个 AppKey/);
    assert.match(res.json.url, /authorize/);
  });

  it('POST /pan/token 转发授权码并回状态', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/pan/token`, body: { code: 'THE-CODE' } }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.token, ['THE-CODE']);
    assert.equal(res.json.pan.authorized, true);
  });

  it('授权码被拒 → 400 且带百度那句话（不是笼统的「失败」）', async () => {
    const { api } = sourceHarness({
      panAuth: {
        ...sourceHarness().handlers?.panAuth,
        completeAuthorization: async () => { throw new Error('换取 token 失败：invalid_grant - 授权码已过期'); },
      },
    });
    const res = fakeRes();
    await api.handler(jsonReq({ url: `${API}/pan/token`, body: { code: 'OLD' } }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /授权码已过期/);
  });

  it('POST /pan/logout 解除授权', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/pan/logout`, method: 'POST' }), res);
    assert.equal(res.status, 200);
    assert.equal(calls.logout, 1);
    assert.equal(res.json.pan.authorized, false);
    assert.equal(res.json.pan.configured, true, '解除授权要保留 AppKey');
  });

  it('这四条都只认 POST', async () => {
    const { api, calls } = sourceHarness();
    for (const path of ['/pan/app', '/pan/authorize', '/pan/token', '/pan/logout']) {
      const res = fakeRes();
      await api.handler(fakeReq({ url: `${API}${path}`, method: 'GET' }), res);
      assert.equal(res.status, 405, path);
    }
    assert.deepEqual(calls.saveApp, []);
    assert.equal(calls.verified, 0);
    assert.deepEqual(calls.token, []);
    assert.equal(calls.logout, 0);
  });
});

describe('GET /pan/dirs', () => {
  it('只回目录（文件计数单独给），供目录选择器用', async () => {
    const { api, calls } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/pan/dirs?path=/E书`, method: 'GET' }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.dirs, ['/E书']);
    assert.deepEqual(res.json.dirs, [{ name: '子目录', path: '/E书/子目录' }]);
    assert.equal(res.json.files, 1, '文件不算目录，但要报个数（用户好知道这层是空的还是全是书）');
    assert.equal(res.json.path, '/E书');
  });

  it('★ 缺 path 参数 → 400（而不是默默去列根目录）', async () => {
    const { api, calls } = sourceHarness();
    for (const url of [`${API}/pan/dirs`, `${API}/pan/dirs?path=`, `${API}/pan/dirs?path=%20%20`]) {
      const res = fakeRes();
      await api.handler(fakeReq({ url, method: 'GET' }), res);
      assert.equal(res.status, 400, url);
      assert.match(res.json.error, /需要 path 参数/);
    }
    assert.deepEqual(calls.dirs, []);
  });

  it('列目录失败（未授权 / 路径不存在）→ 400 且带原因', async () => {
    const { api } = sourceHarness({ listPanDirs: async () => { throw new Error('还没有百度网盘授权'); } });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/pan/dirs?path=/E书`, method: 'GET' }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /还没有百度网盘授权/);
  });

  it('方法不对 → 405', async () => {
    const { api } = sourceHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/pan/dirs?path=/E书`, method: 'POST' }), res);
    assert.equal(res.status, 405);
  });
});

// ---------------------------------------------------------------------------
// 取字节前的先决检查（`verifyReadable`）
// ---------------------------------------------------------------------------

describe('取字节前的先决检查 verifyReadable', () => {
  it('★ 报头出去之前就拒：按错误码回 403 / 404 / 400', async () => {
    // 报头一旦 writeHead + flushHeaders 出去就**改不了状态码**。而本地书那三种失败
    // 都是可预期、用户能自救的，所以必须在写头之前把它们变成正经的 4xx ——
    // 否则客户端拿到的是「206 + content-length: N + 零字节、连接被截断」这种坏响应
    // （真 socket 上实测为 undici `TypeError: terminated`）。
    const cases = [
      ['LOCAL_OUTSIDE_ROOT', 403],
      ['NO_LOCAL_ROOT', 403],
      ['LOCAL_MISSING', 404],
      ['LOCAL_NOT_FILE', 400],
      ['LOCAL_OPEN_FAILED', 400],
      // 网盘凭证类 ⇒ 401：请求本身没问题，缺的是授权，而用户能自救的那条路是
      // 「去设置页重新授权」。`REFRESH_CONSUMED`（refresh_token 被用掉了）也归这里 ——
      // 上游完全正常，同样是「要重新授权」，别报成 502 让用户以为是百度挂了。
      ['NO_TOKEN', 401],
      ['NO_APP', 401],
      ['NO_REFRESH', 401],
      ['REFRESH_CONSUMED', 401],
      // 真·上游失败才是 502。
      ['REFRESH_FAILED', 502],
      ['', 400],
    ];
    for (const [code, status] of cases) {
      const error = Object.assign(new Error(`失败：${code || '无码'}`), code === '' ? {} : { code });
      const { api } = harness({ verifyReadable: async () => { throw error; } });
      const res = fakeRes();
      await api.handler(fakeReq({ url: `${API}/book/b1/raw` }), res);
      assert.equal(res.status, status, `${code || '（无码）'} 应当是 ${status}`);
      // ★ 必须是**完整**的响应体，不是「发了头就断」。
      assert.equal(res.body.length > 0, true, `${code || '（无码）'} 的响应体是空的`);
      assert.equal(res.json.ok, false);
      assert.match(res.json.error, /失败：/);
    }
  });

  it('★ 反向对照：预检通过时一切照旧（206 + 真字节），且预检只跑一次', async () => {
    const seen = [];
    const { api, calls } = harness({ verifyReadable: async (book) => { seen.push(book.id); } });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw`, headers: { range: 'bytes=0-4' } }), res);
    assert.equal(res.status, 206);
    assert.deepEqual(seen, ['b1']);
    assert.equal(res.body.length, 5);
    assert.deepEqual(calls.readBytes, [{ id: 'b1', start: 0, end: 4 }]);
  });

  it('★ 预检失败之后**一次都不该去读字节**', async () => {
    const { api, calls } = harness({
      verifyReadable: async () => { throw Object.assign(new Error('没了'), { code: 'LOCAL_MISSING' }); },
    });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw` }), res);
    assert.equal(res.status, 404);
    assert.deepEqual(calls.readBytes, [], '预检已经把这次请求判死了，不该再打开文件');
  });

  it('不接 verifyReadable 时退化成旧行为 —— 别的调用方不该被迫实现它', async () => {
    // 这个参数是**可选**的：接上才有预检。少了它不能变成「所有书都读不了」。
    const { api, calls } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/b1/raw`, headers: { range: 'bytes=0-4' } }), res);
    assert.equal(res.status, 206);
    assert.equal(calls.readBytes.length, 1);
  });

  it('预检只对**这条**请求生效，别的路由不受影响', async () => {
    const { api } = harness({ verifyReadable: async () => { throw new Error('不该被调用'); } });
    for (const url of [`${API}/books`, `${API}/state`]) {
      const res = fakeRes();
      await api.handler(fakeReq({ url, method: 'GET' }), res);
      assert.equal(res.status, 200, `${url} 被预检误伤了`);
    }
  });
});

// ---------------------------------------------------------------------------
// 划线 / 笔记（0.21.0）
//
// 这两条路由是**唯一**会写用户手写内容的地方，所以错误分支要逐条覆盖：
// 400（输入不合法）/ 415（没有 JSON body）/ 405（方法不对）/ 501（没接上）。
// 全都并成一句「保存失败」的话，用户没法判断该改哪儿。
// ---------------------------------------------------------------------------

describe('划线 / 笔记', () => {
  const roots = [];
  after(async () => {
    // 清理失败是沙箱限制（EPERM），不该让测试变红 —— 见 annotation-store.test.mjs 同款说明。
    for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function marksHarness() {
    const root = await mkdtemp(join(tmpdir(), `npr-ann-route-${process.pid}-`));
    roots.push(root);
    const annotationStore = createAnnotationStore({ rootDir: root });
    return { ...harness({ annotationStore }), annotationStore };
  }

  const POST = (bookId, body) => fakeReq({
    url: `${API}/annotations/${bookId}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const DRAFT = { page: 3, start: 10, end: 20, quote: '一段话' };

  it('GET 空书 ⇒ 200 + 空数组（「还没划线」不是错误）', async () => {
    const { api } = await marksHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/annotations/b1` }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, items: [] });
  });

  it('POST add ⇒ 200，返回整份列表 + 新条目', async () => {
    const { api } = await marksHarness();
    const res = fakeRes();
    await api.handler(POST('b1', { op: 'add', item: DRAFT }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.items.length, 1);
    assert.equal(res.json.item.page, 3);
    assert.equal(res.json.duplicate, false);
  });

  it('POST add 重复 ⇒ duplicate: true（不是 400）', async () => {
    const { api } = await marksHarness();
    await api.handler(POST('b1', { op: 'add', item: DRAFT }), fakeRes());
    const res = fakeRes();
    await api.handler(POST('b1', { op: 'add', item: DRAFT }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.duplicate, true);
    assert.equal(res.json.items.length, 1);
  });

  it('POST add 输入不合法 ⇒ 400（校验类错误，用户能自救）', async () => {
    const { api } = await marksHarness();
    const res = fakeRes();
    await api.handler(POST('b1', { op: 'add', item: { ...DRAFT, page: 0 } }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /页码/);
  });

  it('POST update / remove 走通', async () => {
    const { api, annotationStore } = await marksHarness();
    const added = fakeRes();
    await api.handler(POST('b1', { op: 'add', item: DRAFT }), added);
    const id = added.json.item.id;

    const updated = fakeRes();
    await api.handler(POST('b1', { op: 'update', id, note: '一句笔记', tone: 'green' }), updated);
    assert.equal(updated.status, 200);
    assert.equal(updated.json.item.note, '一句笔记');
    assert.equal(updated.json.item.tone, 'green');

    const removed = fakeRes();
    await api.handler(POST('b1', { op: 'remove', id }), removed);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.removed, true);
    assert.deepEqual(await annotationStore.list('b1'), []);
  });

  it('未知 op ⇒ 400 且说清是哪个 op（不是静默成功）', async () => {
    const { api } = await marksHarness();
    const res = fakeRes();
    await api.handler(POST('b1', { op: 'wipe' }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /wipe/);
  });

  it('没有 JSON body ⇒ 415；方法不对 ⇒ 405', async () => {
    const { api } = await marksHarness();
    const noType = fakeRes();
    await api.handler(fakeReq({
      url: `${API}/annotations/b1`, method: 'POST', body: JSON.stringify({ op: 'add' }),
    }), noType);
    assert.equal(noType.status, 415);

    const wrongMethod = fakeRes();
    await api.handler(fakeReq({ url: `${API}/annotations/b1`, method: 'PUT' }), wrongMethod);
    assert.equal(wrongMethod.status, 405);
  });

  it('夹具里没有 annotationStore ⇒ 501（不是 200 然后什么也没发生）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/annotations/b1` }), res);
    assert.equal(res.status, 501);
  });

  it('非法 bookId（路径穿越形态）⇒ 400', async () => {
    const { api } = await marksHarness();
    const res = fakeRes();
    // 路由正则本身挡住了 `/`，所以这条会落到「不匹配任何路由」的分支（404/400 一类）。
    await api.handler(fakeReq({ url: `${API}/annotations/..%2Fetc` }), res);
    assert.ok(res.status >= 400, `穿越形态没有被挡住（${res.status}）`);
    assert.notEqual(res.body.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 本地 OCR（`GET/POST /ocr`）
// ---------------------------------------------------------------------------

/**
 * 扫描页的 OCR 出口。
 *
 * ★ 这里全部用假依赖，**不起 `osascript`**：真机那条由 `test/ocr.test.mjs` 的
 *   「调用形状」用例钉住（参数顺序、超时、临时文件扩展名），两边不重复。
 * ★ 本组最想守住的一条是「**图片不合规时绝不能真的去识别**」：一次识别要 0.6–0.8 秒
 *   并且要起一个子进程，如果校验放在识别之后，一个写错请求体的客户端会把宿主的
 *   子进程队列塞满 —— 而界面上只会看到「一直在转」。
 */
describe('本地 OCR 路由', () => {
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const PNG_B64 = PNG_BYTES.toString('base64');
  const GIF_B64 = Buffer.from('GIF89a..................').toString('base64');

  function ocrHarness({ supported = true, recognize, cached = {} } = {}) {
    const ocrCalls = { read: [], readAll: [], put: [], recognize: [] };
    const digestStore = {
      readOcrPage: async (bookId, page) => {
        ocrCalls.read.push({ bookId, page });
        return cached[`${bookId}:${page}`] ?? '';
      },
      /**
       * 整本读回：夹具里按 `bookId:page` 前缀筛出来，形状与真实 store 一致
       * （`{ 页码: 纯文本 }`，且**只含真有字的页**）。
       */
      readOcrPages: async (bookId) => {
        ocrCalls.readAll.push({ bookId });
        const out = {};
        for (const [key, text] of Object.entries(cached)) {
          const [owner, page] = key.split(':');
          if (owner !== bookId) continue;
          if (String(text).trim() === '') continue;
          out[Number(page)] = text;
        }
        return out;
      },
      putOcrPage: async (bookId, page, payload) => {
        ocrCalls.put.push({ bookId, page, payload });
        return { written: payload.text.trim() !== '', pages: 1 };
      },
    };
    const ocrRunner = {
      supported,
      unavailableReason: supported ? '' : '这台机器不是 macOS，本地 OCR 用不了',
      recognize: async (buffer) => {
        ocrCalls.recognize.push(buffer);
        return recognize ? recognize(buffer) : { text: '识别出来的正文', lines: 2, ms: 640 };
      },
    };
    return { ...harness({ digestStore, ocrRunner }), ocrCalls };
  }

  const POST = (body, { type = 'application/json' } = {}) => fakeReq({
    url: `${API}/ocr`,
    method: 'POST',
    headers: { 'content-type': type },
    body: JSON.stringify(body),
  });

  it('夹具里没有 ocrRunner ⇒ GET 与 POST 都回 501（不是 200 然后什么也没发生）', async () => {
    const { api } = harness();
    for (const req of [fakeReq({ url: `${API}/ocr?bookId=b1&page=60` }), POST({ bookId: 'b1', page: 60, image: PNG_B64 })]) {
      const res = fakeRes();
      await api.handler(req, res);
      assert.equal(res.status, 501);
      assert.match(res.json.error, /没有接上/);
    }
  });

  it('GET 读缓存：命中就返回文本，未命中返回空串 + cached:false', async () => {
    const { api, ocrCalls } = ocrHarness({ cached: { 'b1:60': '第六十页的正文' } });

    const hit = fakeRes();
    await api.handler(fakeReq({ url: `${API}/ocr?bookId=b1&page=60` }), hit);
    assert.equal(hit.status, 200);
    assert.deepEqual(hit.json, { ok: true, page: 60, text: '第六十页的正文', cached: true });

    const miss = fakeRes();
    await api.handler(fakeReq({ url: `${API}/ocr?bookId=b1&page=61` }), miss);
    assert.deepEqual(miss.json, { ok: true, page: 61, text: '', cached: false });

    // ★ page 必须真的变成 number：客户端拼的是字符串，`"60"` 传到 store 会查不到。
    assert.deepEqual(ocrCalls.read, [{ bookId: 'b1', page: 60 }, { bookId: 'b1', page: 61 }]);
    assert.equal(ocrCalls.recognize.length, 0, 'GET 绝不能触发识别');
  });

  it('GET 参数非法 ⇒ 400（书 id 与页码分开报）', async () => {
    const { api, ocrCalls } = ocrHarness();
    const cases = [
      [`${API}/ocr?bookId=..%2Fetc&page=1`, /无效的书 id/],
      [`${API}/ocr?bookId=b1&page=0`, /正整数/],
      [`${API}/ocr?bookId=b1&page=-3`, /正整数/],
      [`${API}/ocr?bookId=b1&page=1.5`, /正整数/],
      [`${API}/ocr?bookId=b1&page=abc`, /正整数/],
      [`${API}/ocr?bookId=b1`, /正整数/],
    ];
    for (const [url, pattern] of cases) {
      const res = fakeRes();
      await api.handler(fakeReq({ url }), res);
      assert.equal(res.status, 400, `${url} 应该是 400，实际 ${res.status}`);
      assert.match(res.json.error, pattern);
    }
    assert.equal(ocrCalls.read.length, 0, '参数非法时不该去读盘');
  });

  it('POST 非 JSON body ⇒ 415；方法不对 ⇒ 405', async () => {
    const { api, ocrCalls } = ocrHarness();
    const noType = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 1, image: PNG_B64 }, { type: 'text/plain' }), noType);
    assert.equal(noType.status, 415);

    const wrongMethod = fakeRes();
    await api.handler(fakeReq({ url: `${API}/ocr`, method: 'PUT' }), wrongMethod);
    assert.equal(wrongMethod.status, 405);
    assert.equal(ocrCalls.recognize.length, 0);
  });

  it('★ 平台不支持 ⇒ 501 且把原因说出来（不藏成「未知错误」）', async () => {
    const { api, ocrCalls } = ocrHarness({ supported: false });
    const res = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 1, image: PNG_B64 }), res);
    assert.equal(res.status, 501);
    assert.match(res.json.error, /不是 macOS/);
    assert.equal(ocrCalls.recognize.length, 0);
  });

  it('★ 图片不合规（坏 base64 / 非位图）⇒ 400 或 415，且**一次识别都不许跑**', async () => {
    const { api, ocrCalls } = ocrHarness();

    const badBase64 = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 1, image: '@@@@' }), badBase64);
    assert.equal(badBase64.status, 400);
    assert.match(badBase64.json.error, /不是合法的 base64/);

    const missing = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 1 }), missing);
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /缺少图片数据/);

    // 合法 base64，但不是 PNG / JPEG —— 必须在**解码之后、识别之前**挡住。
    const notImage = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 1, image: GIF_B64 }), notImage);
    assert.equal(notImage.status, 415);
    assert.match(notImage.json.error, /PNG \/ JPEG/);

    assert.equal(ocrCalls.recognize.length, 0, '不合规的图被送去识别了 —— 校验顺序错了');
    assert.equal(ocrCalls.put.length, 0);
  });

  it('POST 正常路径：识别 → 落盘 → 回报字数与耗时', async () => {
    const { api, ocrCalls } = ocrHarness();
    const res = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 60, image: `data:image/png;base64,${PNG_B64}` }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      ok: true, page: 60, text: '识别出来的正文', lines: 2, ms: 640, chars: 7, saved: true,
    });
    // data URL 前缀必须被剥掉，送去识别的字节要与原图一致。
    assert.equal(ocrCalls.recognize.length, 1);
    assert.deepEqual(ocrCalls.recognize[0], PNG_BYTES);
    // 落盘拿到的是文本与耗时，不是整张图（`ocr.json` 里不该出现几百 KB 的 base64）。
    assert.deepEqual(ocrCalls.put, [{ bookId: 'b1', page: 60, payload: { text: '识别出来的正文', ms: 640 } }]);
  });

  it('识别结果为空 ⇒ saved:false（空文本不落盘，下次点还能重试）', async () => {
    const { api } = ocrHarness({ recognize: async () => ({ text: '   ', lines: 0, ms: 300 }) });
    const res = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 60, image: PNG_B64 }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.saved, false);
    assert.equal(res.json.chars, 0);
  });

  it('识别抛错 ⇒ 500，并把原因带出来（超时 / 没跑起来是两句不同的话）', async () => {
    const { api } = ocrHarness({
      recognize: async () => { throw new Error('本地 OCR 超时（60 秒）'); },
    });
    const res = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 60, image: PNG_B64 }), res);
    assert.equal(res.status, 500);
    assert.match(res.json.error, /超时/);
  });

  it('POST 的 bookId / page 也要校验（body 来的，一样不能信）', async () => {
    const { api, ocrCalls } = ocrHarness();
    const badId = fakeRes();
    await api.handler(POST({ bookId: 'a/b', page: 1, image: PNG_B64 }), badId);
    assert.equal(badId.status, 400);

    const badPage = fakeRes();
    await api.handler(POST({ bookId: 'b1', page: 0, image: PNG_B64 }), badPage);
    assert.equal(badPage.status, 400);

    assert.equal(ocrCalls.recognize.length, 0);
  });

  // ---- 整本读回（`GET /ocr/pages`，0.27.1）--------------------------------
  /**
   * 书内搜索给整本建索引时要它：扫描书上百页，一页一次 GET 等于上百次请求
   * **以及上百次读同一份 JSON**。这条路由存在的理由只有这一个。
   */
  it('GET /ocr/pages 一次回整本，只含认出字的页', async () => {
    const { api, ocrCalls } = ocrHarness({
      cached: { 'b1:7': '她和一个男人有来往吗？', 'b1:8': '   ', 'b2:1': '别的书的正文' },
    });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/ocr/pages?bookId=b1` }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, pages: { 7: '她和一个男人有来往吗？' }, count: 1 });
    // 页号必须是 number 的键（客户端拿它当 Map 的 key 去比页码）
    assert.deepEqual(Object.keys(res.json.pages), ['7']);
    // 只读了一次盘，且没有触发任何识别
    assert.deepEqual(ocrCalls.readAll, [{ bookId: 'b1' }]);
    assert.equal(ocrCalls.recognize.length, 0);
    assert.equal(ocrCalls.read.length, 0, '整本读回不该退化成逐页读');
  });

  it('GET /ocr/pages：书 id 非法 ⇒ 400；没有识别过 ⇒ 空对象', async () => {
    const { api } = ocrHarness();
    const bad = fakeRes();
    await api.handler(fakeReq({ url: `${API}/ocr/pages?bookId=..%2Fetc` }), bad);
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /无效的书 id/);

    const empty = fakeRes();
    await api.handler(fakeReq({ url: `${API}/ocr/pages?bookId=b1` }), empty);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { ok: true, pages: {}, count: 0 });
  });

  it('GET /ocr/pages：没有 ocrRunner ⇒ 501（与逐页那条同一个口径）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/ocr/pages?bookId=b1` }), res);
    assert.equal(res.status, 501);
    assert.match(res.json.error, /没有接上/);
  });
});

// ---------------------------------------------------------------------------
// 书内搜索（0.26.0）
// ---------------------------------------------------------------------------

/**
 * 这条路由的判据在 `src/book-find.js`（与 `book_search` 同一套），所以这里只验
 * **路由层**该负责的三件事：参数校验、依赖缺失时的 501、以及命中形状能否原样
 * 被渲染端消费（`n / block / start / end / snippet`）。
 */
describe('GET /book/:id/ebook/find', () => {
  const EBOOK = {
    sections: [
      { title: '第一章 磨坊', blocks: [{ k: 'p', x: '磨坊主妇站在磨坊门口。' }] },
      { title: '第二章', blocks: [{ k: 'p', x: '水轮坏了。' }] },
    ],
  };
  const findHarness = (overrides = {}) => harness({ ebookOf: async () => EBOOK, ...overrides });
  const url = (query) => `${API}/book/b2/ebook/find?q=${encodeURIComponent(query)}`;

  it('命中 ⇒ 200，形状是渲染端要的那一份（节号 / 块号 / 块内偏移 / 片段）', async () => {
    const { api } = findHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: url('磨坊') }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.total, 2);
    assert.equal(res.json.hits[0].n, 1);
    assert.equal(res.json.hits[0].block, 0);
    const text = EBOOK.sections[0].blocks[0].x;
    assert.equal(text.slice(res.json.hits[0].start, res.json.hits[0].end), '磨坊');
    assert.ok(res.json.hits[0].snippet.includes('磨坊'));
  });

  it('空 q ⇒ 400（不是「回全部命中」）', async () => {
    const { api } = findHarness();
    for (const q of ['', '   ']) {
      const res = fakeRes();
      await api.handler(fakeReq({ url: url(q) }), res);
      assert.equal(res.status, 400);
      assert.match(res.json.error, /q 不能为空/);
    }
  });

  it('超长 q ⇒ 400 并说清上限（不静默截断成前半句）', async () => {
    const { api } = findHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: url('x'.repeat(200)) }), res);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /最多 100 个字/);
  });

  it('limit 只在合理区间内生效，到顶要明说 truncated', async () => {
    const { api } = findHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${url('磨坊')}&limit=1` }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 1);
    assert.equal(res.json.truncated, true);
  });

  it('书不在书单里 ⇒ 404；缺 ebookOf ⇒ 501（不是把 /books 一起打歪）', async () => {
    const { api } = findHarness();
    const missing = fakeRes();
    await api.handler(fakeReq({ url: `${API}/book/nope/ebook/find?q=x` }), missing);
    assert.equal(missing.status, 404);

    const { api: bare } = harness();
    const notWired = fakeRes();
    await bare.handler(fakeReq({ url: url('磨坊') }), notWired);
    assert.notEqual(notWired.status, 200);
    assert.equal(notWired.json.ok, false);
  });

  it('POST ⇒ 405（检索不写盘，只该有 GET）', async () => {
    const { api } = findHarness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: url('磨坊'), method: 'POST', body: '{}' }), res);
    assert.equal(res.status, 405);
  });
});

// ---------------------------------------------------------------------------
// /cache 与 /cache/clean（缓存占用 / 清理，2026-10-25）
// ---------------------------------------------------------------------------

describe('缓存端点', () => {
  it('没接上 `cacheUsage` ⇒ 501（而不是回一个空对象让界面显示「0 B」）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/cache` }), res);
    assert.equal(res.status, 501);
    assert.equal(res.json.ok, false);
  });

  it('接了 ⇒ 200，三类体积原样透出（界面靠它们分行显示）', async () => {
    const usage = {
      totalText: '94 MB',
      limitText: '512 MB',
      digests: { text: '5.3 MB', books: 3 },
      panCache: { text: '89 MB' },
      backups: { text: '40 MB', count: 7 },
    };
    const { api } = harness({ cacheUsage: async () => usage });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/cache` }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.digests, usage.digests);
    assert.equal(res.json.panCache.text, '89 MB');
  });

  it('★ `cacheUsage` 抛 DISK_FULL ⇒ **507**（请求没错，是磁盘满了；400 会让用户去改请求）', async () => {
    const { api } = harness({
      cacheUsage: async () => {
        const error = new Error('磁盘空间不够了：保存数据的时候被系统拒绝了。');
        error.code = 'DISK_FULL';
        throw error;
      },
    });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/cache` }), res);
    assert.equal(res.status, 507);
    assert.match(res.json.error, /磁盘空间不够了/);
    assert.equal(res.json.code, 'DISK_FULL', 'code 没透出来，客户端只能靠文案判断');
  });

  it('★ GET /cache/clean ⇒ 405：清理会删文件，GET 必须是只读的', async () => {
    let cleaned = 0;
    const { api } = harness({ cleanCache: async () => { cleaned += 1; return {}; } });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/cache/clean` }), res);
    assert.equal(res.status, 405);
    assert.equal(cleaned, 0, 'GET 居然真的触发了清理');
  });

  it('POST /cache/clean ⇒ 200，且返回清理后的占用（界面不用再发一次 GET）', async () => {
    let cleaned = 0;
    const { api } = harness({
      cleanCache: async () => {
        cleaned += 1;
        return { freed: 1024, freedText: '1.0 KB', usage: { totalText: '0 B' } };
      },
    });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/cache/clean`, method: 'POST' }), res);
    assert.equal(res.status, 200);
    assert.equal(cleaned, 1);
    assert.equal(res.json.freedText, '1.0 KB');
    assert.equal(res.json.usage.totalText, '0 B');
  });

  it('缺 `cleanCache` ⇒ 501（按钮点了没反应是最糟的假象）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/cache/clean`, method: 'POST' }), res);
    assert.equal(res.status, 501);
  });
});

// ---------------------------------------------------------------------------
// 划词翻译（POST /translate）
// ---------------------------------------------------------------------------

/**
 * ★ 这条路的失败**全都会被用户当成同一句话**：「点了翻译没反应」。
 *
 *   所以在用例层必须把三种失败分开断言：
 *     · 501 —— 这个版本没接上（缺依赖），不是请求错；
 *     · 415 —— 客户端忘了带 JSON 头（客户端 bug，一下就看得出来）；
 *     · 502 —— 模型侧失败（限流 / 超时 / 未配置），请求本身没错。
 *   合并成 500 的话，用户拿到的错误话术与真实原因无关，无从自查。
 */
describe('划词翻译', () => {
  const post = (body, headers = { 'content-type': 'application/json' }) => fakeReq({
    url: `${API}/translate`, method: 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('把选中的原文交给宿主，回译文（不落盘、不带书 id —— 这一步与「翻一节」无关）', async () => {
    const seen = [];
    const { api } = harness({
      translatePassage: async (payload) => { seen.push(payload); return { text: '注意力就是你所需要的一切' }; },
    });
    const res = fakeRes();
    await api.handler(post({ text: 'Attention is all you need', context: 'Attention Is All You Need' }), res);

    assert.equal(res.status, 200);
    assert.equal(res.json.text, '注意力就是你所需要的一切');
    // ★ 原文必须**原样**过去：模型侧要按原文匹配回填（分段一错就会英文残留）。
    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, 'Attention is all you need');
    assert.equal(seen[0].context, 'Attention Is All You Need');
  });

  it('模型返回空串 ⇒ 仍然是 200 + 空文本（由客户端判成「没返回译文」，不在这里编造）', async () => {
    const { api } = harness({ translatePassage: async () => ({ text: '' }) });
    const res = fakeRes();
    await api.handler(post({ text: 'x' }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.text, '');
  });

  it('缺 `translatePassage` ⇒ 501（不是 500：这个版本就没接这条能力）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(post({ text: 'x' }), res);
    assert.equal(res.status, 501);
  });

  it('不带 JSON 头 ⇒ 415（客户端 bug 要一眼看得出）', async () => {
    const { api } = harness({ translatePassage: async () => ({ text: 'y' }) });
    const res = fakeRes();
    await api.handler(post({ text: 'x' }, { 'content-type': 'text/plain' }), res);
    assert.equal(res.status, 415);
  });

  it('GET ⇒ 405', async () => {
    const { api } = harness({ translatePassage: async () => ({ text: 'y' }) });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/translate`, method: 'GET' }), res);
    assert.equal(res.status, 405);
  });

  it('模型侧抛错 ⇒ 502，并把原始 message 带回去（用户要能看到「未配置模型」这种话）', async () => {
    const { api } = harness({
      translatePassage: async () => {
        const error = new Error('dsh 里还没有选择模型');
        error.code = 'NO_MODEL';
        throw error;
      },
    });
    const res = fakeRes();
    await api.handler(post({ text: 'x' }), res);
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'dsh 里还没有选择模型');
    assert.equal(res.json.code, 'NO_MODEL');
  });
});

// ---------------------------------------------------------------------------
// 页级按需翻译（POST /translate-page，D 档）
// ---------------------------------------------------------------------------

/**
 * ★ 与 `/translate` 分开测：那边翻一小段、回 `{text}`；这边翻一页十几段、
 *   回 `[{id,text}]`。合并成一条路由的话，「某一段漏翻」在前端无从判断。
 * ★ 失败姿势全是「点了翻译没反应」，所以状态码必须能区分原因。
 */
describe('页级按需翻译', () => {
  const paragraphs = [
    { id: 'p1', text: 'Attention is all you need.' },
    { id: 'p2', text: 'The transformer is simple.' },
  ];
  const post = (body, headers = { 'content-type': 'application/json' }) => fakeReq({
    url: `${API}/translate-page`, method: 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('整页段落原样交给宿主，回按 id 的译文', async () => {
    const seen = [];
    const { api } = harness({
      translatePageParagraphs: async (payload) => {
        seen.push(payload);
        return payload.paragraphs.map((item) => ({ id: item.id, text: `译文 ${item.id}` }));
      },
    });
    const res = fakeRes();
    await api.handler(post({ paragraphs }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.translations, [
      { id: 'p1', text: '译文 p1' },
      { id: 'p2', text: '译文 p2' },
    ]);
    // ★ id 必须原样过去：排版层靠它把译文放回对应的段落框。
    assert.deepEqual(seen[0].paragraphs, paragraphs);
  });

  it('模型一条都没翻出来 ⇒ 200 + 空数组（由客户端判「没翻成」，不是 HTTP 错误）', async () => {
    const { api } = harness({ translatePageParagraphs: async () => [] });
    const res = fakeRes();
    await api.handler(post({ paragraphs }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.translations, []);
  });

  it('缺 `translatePageParagraphs` ⇒ 501（这个版本没接上，不是请求错）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(post({ paragraphs }), res);
    assert.equal(res.status, 501);
  });

  it('paragraphs 不是 1–40 条数组 ⇒ 400（挡住把整本书塞进来）', async () => {
    const { api } = harness({ translatePageParagraphs: async () => [] });
    for (const body of [{}, { paragraphs: [] }, { paragraphs: 'x' }, { paragraphs: new Array(41).fill({ id: 'a', text: 'x' }) }]) {
      const res = fakeRes();
      await api.handler(post(body), res);
      assert.equal(res.status, 400, `不该放行：${JSON.stringify(body).slice(0, 60)}`);
    }
    // 正对照：40 条是允许的，别把上限写成 < 40。
    const ok = fakeRes();
    await api.handler(post({ paragraphs: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, text: 'x' })) }), ok);
    assert.equal(ok.status, 200);
  });

  it('不带 JSON 头 ⇒ 415；GET ⇒ 405', async () => {
    const { api } = harness({ translatePageParagraphs: async () => [] });
    const bad = fakeRes();
    await api.handler(post({ paragraphs }, { 'content-type': 'text/plain' }), bad);
    assert.equal(bad.status, 415);
    const wrongMethod = fakeRes();
    await api.handler(fakeReq({ url: `${API}/translate-page`, method: 'GET' }), wrongMethod);
    assert.equal(wrongMethod.status, 405);
  });

  it('模型侧抛错 ⇒ 502，并把 code 带回去（未配置模型 / 限流要看得出区别）', async () => {
    const { api } = harness({
      translatePageParagraphs: async () => {
        const error = new Error('dsh 里还没有选择模型');
        error.code = 'NO_MODEL';
        throw error;
      },
    });
    const res = fakeRes();
    await api.handler(post({ paragraphs }), res);
    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'NO_MODEL');
  });
});

// ---------------------------------------------------------------------------
// 页译文落盘缓存（0.71.0）：逐页按需与整本一次翻完共用
// ---------------------------------------------------------------------------

describe('GET/POST /page-translation/:id', () => {
  const PAGE = {
    paragraphs: [{ id: 'p1', text: 'Attention is all you need.' }],
    translations: [{ id: 'p1', text: '注意力就是你所需要的一切。' }],
  };
  /** 内存版 store：只验路由接线与状态码，真正的文件行为在 page-translation-store.test.mjs。 */
  function fakeStore() {
    const data = new Map();
    return {
      data,
      list: async (id) => Object.fromEntries(data.get(id) ?? []),
      putPage: async (id, page, input) => {
        if (!Number.isInteger(Number(page)) || Number(page) < 1) {
          const error = new Error('页码不合法');
          error.code = 'BAD_PAGE_TRANSLATION';
          throw error;
        }
        const rows = data.get(id) ?? new Map();
        rows.set(String(page), { page: Number(page), ...input });
        data.set(id, rows);
        return { page: Number(page) };
      },
      clearBook: async (id) => {
        const rows = data.get(id) ?? new Map();
        data.delete(id);
        return { removed: rows.size };
      },
    };
  }
  const url = `${API}/page-translation/paper-1`;
  const req = (method, body, headers = { 'content-type': 'application/json' }) => fakeReq({
    url, method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });

  it('缺 store ⇒ 501，且不影响别的路由（测试夹具常态）', async () => {
    const { api } = harness();
    const res = fakeRes();
    await api.handler(req('GET'), res);
    assert.equal(res.status, 501);
    const books = fakeRes();
    await api.handler(fakeReq({ url: `${API}/books` }), books);
    assert.equal(books.status, 200);
  });

  it('写单页 → 整本读回；清空 → 空', async () => {
    const { api } = harness({ pageTranslationStore: fakeStore() });
    const put = fakeRes();
    await api.handler(req('POST', { op: 'put', page: 3, ...PAGE }), put);
    assert.equal(put.status, 200);
    assert.equal(put.json.page, 3);
    const get = fakeRes();
    await api.handler(req('GET'), get);
    assert.equal(get.json.pages['3'].translations[0].text, '注意力就是你所需要的一切。');
    const clear = fakeRes();
    await api.handler(req('POST', { op: 'clear' }), clear);
    assert.equal(clear.json.removed, 1);
    const after = fakeRes();
    await api.handler(req('GET'), after);
    assert.deepEqual(after.json.pages, {});
  });

  it('只认 put / clear 两个 op；别的 op、坏页码、非 JSON、PUT 都要挡住', async () => {
    const { api } = harness({ pageTranslationStore: fakeStore() });
    for (const [method, body, headers] of [
      ['POST', { op: 'overwrite-all', pages: {} }],
      ['POST', { op: 'put', page: 0, ...PAGE }],
      ['POST', { op: 'put', page: 1, ...PAGE }, { 'content-type': 'text/plain' }],
      ['PUT', { op: 'clear' }],
    ]) {
      const res = fakeRes();
      await api.handler(req(method, body, headers), res);
      assert.ok(res.status >= 400, `不该放行：${method} ${JSON.stringify(body).slice(0, 50)}`);
    }
  });

  it('bookId 走路径白名单，带斜杠的 id 落到 404 而不是拼进磁盘路径', async () => {
    const { api } = harness({ pageTranslationStore: fakeStore() });
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/page-translation/..%2Fevil` }), res);
    assert.equal(res.status, 404);
  });
});
