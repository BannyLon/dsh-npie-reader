/**
 * 逐章解读的三条路由：`generate` / `stop` / `chapter/:n`。
 *
 * ★ 与 `digest-routes.test.mjs` 分开，是因为这两个文件要的夹具不同：
 *   那一组只喂 `digestStore`（测抽取链路），这一组还要喂 `startDigests` /
 *   `stopDigests` / `isGenerating`。混在一起就得在一个 `before` 里塞两套依赖，
 *   而「缺依赖时退化」这条恰恰要靠「没喂」才测得出来。
 *
 * ★ 三条必须有的断言：
 *   ① `generate` **立刻返回**（它不能挂着等整本书生成完）；
 *   ② 缺生成入口时 `/generate` 是 501，而 `/status` 仍然 200（不能整块打歪）；
 *   ③ `chapter/:n` 的 `n` 走路径参数 ⇒ 非法值要被挡住，不能拼出奇怪的文件名。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LIBRARY_API_PREFIX } from '../src/library.js';
import { makeLibraryRoutes } from '../src/host/library-routes.js';
import { createDigestStore } from '../src/host/digest-store.js';

const API = LIBRARY_API_PREFIX;
const BOOK = 'l-generate';

function fakeReq({ url, method = 'GET', headers = {}, body } = {}) {
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:52431', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
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
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk, done) { this.chunks.push(Buffer.from(chunk)); if (typeof done === 'function') done(); return this; },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      this.ended = true;
      return this;
    },
    destroy() { return this; },
    on() { return this; },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

const baseHandlers = () => ({
  listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
  bookById: () => undefined,
  readBytes: async () => Buffer.alloc(0),
  getStates: () => ({}),
  setState: () => ({}),
  reload: async () => {},
  vendorRoot: '/nonexistent',
});

let root = '';
let store = null;
let api = null;
let bare = null;
/** 每次 `startDigests` / `stopDigests` 收到的入参。 */
const calls = { start: [], stop: [] };
let generating = false;
let startShouldThrow = null;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'npie-digest-gen-'));
  store = createDigestStore({ rootDir: root });

  api = makeLibraryRoutes({
    ...baseHandlers(),
    digestStore: store,
    startDigests: async (request) => {
      calls.start.push(request);
      if (startShouldThrow !== null) throw new Error(startShouldThrow);
      generating = true;
      return { started: true };
    },
    stopDigests: async (bookId) => {
      calls.stop.push(bookId);
      generating = false;
      return { stopped: true };
    },
    isGenerating: () => generating,
  })[0];

  // 只喂 digestStore 的夹具：模拟「抽取链路接了、生成链路没接」。
  bare = makeLibraryRoutes({ ...baseHandlers(), digestStore: store })[0];
});

after(async () => {
  // 同 digest-store.test：清理失败 ≠ 断言失败。
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function call(path, { method = 'GET', body } = {}) {
  const res = fakeRes();
  await api.handler(fakeReq({
    url: `${API}${path}`,
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), res);
  return res;
}

async function callBare(path, { method = 'GET' } = {}) {
  const res = fakeRes();
  await bare.handler(fakeReq({
    url: `${API}${path}`,
    method,
    headers: { 'content-type': 'application/json' },
  }), res);
  return res;
}

describe('POST /digest/:id/generate', () => {
  it('把 bookId / 书名 / force 原样交给生成入口', async () => {
    calls.start.length = 0;
    const res = await call(`/digest/${BOOK}/generate`, {
      method: 'POST',
      body: { bookTitle: '某本书', force: true },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, started: true });
    assert.deepEqual(calls.start, [{ bookId: BOOK, bookTitle: '某本书', force: true }]);
  });

  it('不给 body 时按「不带书名、不强制」处理，不炸', async () => {
    calls.start.length = 0;
    const res = await call(`/digest/${BOOK}/generate`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.start, [{ bookId: BOOK, bookTitle: '', force: false }]);
  });

  it('★ force 只认严格的 true —— 字符串 "true" 不算', async () => {
    // 否则「从 URL query 抄过来的字符串」会让每一次生成都重跑整本。
    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, { method: 'POST', body: { force: 'true' } });
    assert.equal(calls.start[0].force, false);
  });

  it('书名超长被截断（它要进 meta.json，不该被灌进一兆）', async () => {
    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, { method: 'POST', body: { bookTitle: 'x'.repeat(1000) } });
    assert.equal(calls.start[0].bookTitle.length, 300);
  });

  it('生成入口抛错 ⇒ 400 且把原因带回去（界面要显示它）', async () => {
    startShouldThrow = '这本书还没有抽取目录';
    try {
      const res = await call(`/digest/${BOOK}/generate`, { method: 'POST' });
      assert.equal(res.status, 400);
      assert.match(res.json.error, /还没有抽取目录/);
    } finally {
      startShouldThrow = null;
    }
  });

  it('GET 打 generate ⇒ 405（不是静默当成状态查询）', async () => {
    const res = await call(`/digest/${BOOK}/generate`);
    assert.equal(res.status, 405);
  });
});

describe('POST /digest/:id/generate：勾选的章节与模型（0.19.0）', () => {
  it('★ 带了 chapters ⇒ 原样交给生成入口', async () => {
    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, { method: 'POST', body: { chapters: [1, 3, 7] } });
    assert.deepEqual(calls.start[0].chapters, [1, 3, 7]);
  });

  it('★★ 没带 chapters ⇒ 入参里**根本没有**这个键（不是 undefined、不是 []）', async () => {
    // 「没带」= 老行为（跑所有没解读的章）；「带了空数组」= 调用方 bug，宿主会报错。
    // 两者在线上必须能区分，靠的就是「键在不在」。
    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, { method: 'POST', body: { bookTitle: 'x' } });
    assert.equal('chapters' in calls.start[0], false, '没带 chapters 却造出了一个键');
  });

  it('★ 空数组要原样传下去（由宿主报错，而不是路由悄悄改成「全部」）', async () => {
    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, { method: 'POST', body: { chapters: [] } });
    assert.deepEqual(calls.start[0].chapters, []);
  });

  it('★ 章号里的垃圾值被丢掉（0 / 负数 / 字符串 / 小数都不该拼出奇怪的文件名）', async () => {
    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, {
      method: 'POST',
      body: { chapters: [0, -1, '3', 1.5, 2, 99999, null] },
    });
    assert.deepEqual(calls.start[0].chapters, [2]);
  });

  it('带模型 ⇒ 原样交给生成入口；不带 ⇒ 没有这个键', async () => {
    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, { method: 'POST', body: { model: 'free-provider/free-model' } });
    assert.equal(calls.start[0].model, 'free-provider/free-model');

    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, { method: 'POST', body: {} });
    assert.equal('model' in calls.start[0], false);
  });

  it('模型取值超长被截断（它要进 meta.json 与请求体，不该被灌进一兆）', async () => {
    calls.start.length = 0;
    await call(`/digest/${BOOK}/generate`, { method: 'POST', body: { model: `p/${'x'.repeat(1000)}` } });
    assert.equal(calls.start[0].model.length, 200);
  });
});

describe('POST /digest/:id/stop', () => {
  it('把 bookId 交给停止入口', async () => {
    calls.stop.length = 0;
    const res = await call(`/digest/${BOOK}/stop`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, stopped: true });
    assert.deepEqual(calls.stop, [BOOK]);
  });

  it('GET 打 stop ⇒ 405（停止是动作，不是查询）', async () => {
    const res = await call(`/digest/${BOOK}/stop`);
    assert.equal(res.status, 405);
  });
});

describe('GET /digest/:id/status', () => {
  it('★ 带上宿主侧真实的 generating（面板重开后靠它恢复「停止」按钮）', async () => {
    generating = true;
    const running = await call(`/digest/${BOOK}/status`);
    assert.equal(running.json.generating, true);

    generating = false;
    const idle = await call(`/digest/${BOOK}/status`);
    assert.equal(idle.json.generating, false);
  });

  it('没抽过目录时 meta/outline 都是 null/undefined，但状态码仍是 200', async () => {
    const res = await call('/digest/l-never-extracted/status');
    assert.equal(res.status, 200);
    assert.equal(res.json.meta, null);
  });
});

describe('GET /digest/:id/chapter/:n', () => {
  it('取回某一章的解读', async () => {
    await store.writeDigest(BOOK, 3, {
      summary: '这一章讲落地。', points: ['先跑通'], terms: [], title: '实战',
    });
    const res = await call(`/digest/${BOOK}/chapter/3`);
    assert.equal(res.status, 200);
    assert.equal(res.json.digest.summary, '这一章讲落地。');
    assert.equal(res.json.digest.n, 3);
  });

  it('还没生成 ⇒ 404（不是 200 + 空对象）', async () => {
    const res = await call(`/digest/${BOOK}/chapter/77`);
    assert.equal(res.status, 404);
    assert.match(res.json.error, /还没有生成/);
  });

  it('章节号非法 ⇒ 路由不匹配（404），不会拼出 ch0 / ch-1 这种文件名', async () => {
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await call(`/digest/${BOOK}/chapter/${bad}`);
      assert.equal(res.status, 404, `chapter/${bad} 应当 404，实际 ${res.status}`);
    }
  });

  it('POST 打 chapter ⇒ 405', async () => {
    const res = await call(`/digest/${BOOK}/chapter/3`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('★ 解读正文不并进 status —— 那是每两秒轮询一次的接口', async () => {
    const res = await call(`/digest/${BOOK}/status`);
    assert.equal(JSON.stringify(res.json).includes('这一章讲落地'), false);
  });
});

describe('退化：只接了 digestStore、没接生成入口', () => {
  it('★ /generate 是 501，而不是「started: true」然后什么也不发生', async () => {
    const res = await callBare(`/digest/${BOOK}/generate`, { method: 'POST' });
    assert.equal(res.status, 501);
    assert.match(res.json.error, /缺少生成入口/);
  });

  it('/status 仍然 200 —— 退化只影响生成，不该把整个解读链路打歪', async () => {
    const res = await callBare(`/digest/${BOOK}/status`);
    assert.equal(res.status, 200);
    assert.equal(res.json.generating, false);
  });

  it('/chapter 仍然能读（已经生成的解读不该因为没接生成入口就读不出来）', async () => {
    const res = await callBare(`/digest/${BOOK}/chapter/3`);
    assert.equal(res.status, 200);
  });
});
