/**
 * 解读的三条路由（`/digest/:id/pages|segment|status`）。
 *
 * ★ 这里用**真的** `createDigestStore`（临时目录）+ 假 req/res：这三条路由的价值
 *   全在「落盘 → 读回 → 分段 → 再落盘」这条链上，把 store 也换成假的就等于
 *   只测了字符串分派。而链上任何一环断了（比如 `segment` 没写 `outline.json`），
 *   界面上都是「点了没反应」。
 *
 * ★ 三条必须有的断言：信任栅栏（宿主派发插件路由不过鉴权）、bookId 校验
 *   （它从 HTTP 路径来）、以及「没抽过页就分段」要回 409 而不是编出空章节。
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
const BOOK = 'l-digest';

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
    write(chunk, done) { this.chunks.push(Buffer.from(chunk)); if (typeof done === 'function') done(); return true; },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      this.ended = true;
      return this;
    },
    destroy() { return this; },
    on() { return this; },
    get body() { return Buffer.concat(this.chunks); },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

let root = '';
let store = null;
let api = null;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'npie-digest-routes-'));
  store = createDigestStore({ rootDir: root });
  const routes = makeLibraryRoutes({
    listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
    bookById: () => undefined,
    readBytes: async () => Buffer.alloc(0),
    getStates: () => ({}),
    setState: () => ({}),
    reload: async () => {},
    vendorRoot: '/nonexistent',
    digestStore: store,
  });
  api = routes[0];
});

after(async () => {
  // 同 digest-store.test：清理失败 ≠ 断言失败。
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function call(path, { method = 'GET', body, headers } = {}) {
  const res = fakeRes();
  await api.handler(fakeReq({
    url: `${API}${path}`,
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), res);
  return res;
}

/** 造一本「有目录页」的假书：目录页 + 3 章正文。 */
function samplePages() {
  const toc = ['目录', 'CONTENTS', '第一章 起步', '第二章 进阶', '第三章 实战'];
  const body = (title) => [title, ...Array.from({ length: 12 }, () => '正文内容写得比较长，用来模拟排版宽度，末尾加句号。')];
  return [
    { page: 1, lines: toc },
    { page: 2, lines: body('第一章 起步') },
    { page: 3, lines: body('第二章 进阶') },
    { page: 4, lines: body('第三章 实战') },
  ];
}

describe('信任栅栏', () => {
  it('★ 非本机来源一律 403，且不落盘', async () => {
    const res = await call(`/digest/${BOOK}/pages`, {
      method: 'POST',
      body: { pages: [{ page: 1, lines: ['x'] }] },
      headers: { host: 'evil.example.com' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await store.readPages(BOOK), []);
  });
});

describe('POST /digest/:id/pages', () => {
  it('落盘一批页并推进游标', async () => {
    const pages = samplePages();
    const res = await call(`/digest/${BOOK}/pages`, { method: 'POST', body: { pages: pages.slice(0, 2) } });
    assert.equal(res.status, 200);
    assert.equal(res.json.received, 2);
    assert.equal(res.json.cursor, 2);

    const rest = await call(`/digest/${BOOK}/pages`, { method: 'POST', body: { pages: pages.slice(2) } });
    assert.equal(rest.json.cursor, 4);
    assert.equal((await store.readPages(BOOK)).length, 4);
  });

  it('★ 空数组回 400（不是静默成功 —— 那会让抽取循环以为一直在推进）', async () => {
    const res = await call(`/digest/${BOOK}/pages`, { method: 'POST', body: { pages: [] } });
    assert.equal(res.status, 400);
  });

  it('坏页被过滤掉，好的照收', async () => {
    const res = await call(`/digest/${BOOK}/pages`, {
      method: 'POST',
      body: { pages: [{ page: 0, lines: [] }, { page: 'x' }, { page: 9, lines: ['ok', 42] }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.received, 1);
  });

  it('GET 这条路由回 405', async () => {
    assert.equal((await call(`/digest/${BOOK}/pages`)).status, 405);
  });
});

describe('POST /digest/:id/segment', () => {
  it('★ 分段后 outline.json 与 meta 都要落地，章节状态是 pending 不是 done', async () => {
    const res = await call(`/digest/${BOOK}/segment`, {
      method: 'POST',
      body: { pageCount: 4, outline: [] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, 'toc');
    assert.equal(res.json.chapters.length, 3);

    const outline = await store.readOutline(BOOK);
    assert.equal(outline.length, 3);
    const meta = await store.readMeta(BOOK);
    assert.equal(meta.mode, 'toc');
    // ★ 刚抽完不等于已解读 —— 生成是 P2 的事。
    assert.deepEqual(meta.chapters.map(c => c.status), ['pending', 'pending', 'pending']);
    assert.equal(meta.task.state, 'idle');
  });

  it('按章切好了原文，第一章能读出来', async () => {
    const text = await store.readChapterText(BOOK, 1);
    assert.ok(typeof text === 'string' && text.includes('第一章 起步'), String(text).slice(0, 40));
  });

  it('★ 没抽过页就分段回 409（不许编出空章节）', async () => {
    const res = await call('/digest/l-empty/segment', { method: 'POST', body: { pageCount: 10 } });
    assert.equal(res.status, 409);
  });

  it('扫描版（全是空页）分段后 mode=scanned 且章节为空', async () => {
    await call('/digest/l-scan/pages', { method: 'POST', body: { pages: [{ page: 1, lines: [] }, { page: 2, lines: [] }] } });
    const res = await call('/digest/l-scan/segment', { method: 'POST', body: { pageCount: 2 } });
    assert.equal(res.json.mode, 'scanned');
    assert.deepEqual(res.json.chapters, []);
  });
});

describe('GET /digest/:id/status', () => {
  it('返回 meta 与 outline；没解读过时两者都是 null', async () => {
    const res = await call(`/digest/${BOOK}/status`);
    assert.equal(res.status, 200);
    assert.equal(res.json.meta.bookId, BOOK);
    assert.equal(res.json.outline.length, 3);

    const empty = await call('/digest/l-nothing/status');
    assert.equal(empty.json.meta, null);
    assert.equal(empty.json.outline, null);
  });
});

describe('bookId 校验：从 HTTP 路径来的那一段', () => {
  it('★ 含穿越片段的路径根本匹配不上正则，落到 404', async () => {
    for (const bad of ['..%2F..%2Fetc', 'a.b', '%2e%2e']) {
      const res = await call(`/digest/${bad}/status`);
      assert.equal(res.status, 404, `${bad} 没有被挡住`);
    }
  });
});

describe('依赖缺失时的退化', () => {
  it('★ 没接 digestStore 时回 501，而不是让整个 handler 挂掉', async () => {
    // 理由同书源那几条：一旦这里抛异常，`GET /books` 也会一起打歪，
    // 界面上表现为「书架一直转圈」，而真正的问题在解读这一侧。
    const routes = makeLibraryRoutes({
      listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
      bookById: () => undefined,
      readBytes: async () => Buffer.alloc(0),
      getStates: () => ({}),
      setState: () => ({}),
      reload: async () => {},
      vendorRoot: '/nonexistent',
    });
    const res = fakeRes();
    await routes[0].handler(fakeReq({ url: `${API}/digest/${BOOK}/status` }), res);
    assert.equal(res.status, 501);
  });
});
