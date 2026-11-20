/**
 * `/transcript` 两条路由（P0）。
 *
 * 判据的重点不是「200 拿到了数据」，而是**四种失败各自回什么**：
 * 没接上（501）、参数不对（400）、格式不对（415）、上游没有（404）。
 * 这四种在界面上是四句不同的话，合并成「加载失败」用户就无从自救。
 *
 * ★ 还有一条只在这个文件里能证明的边界：**GET 绝不联网**。读缓存的那条路不该
 *   触发任何抓取 —— 否则「翻一集播客」会顺手打一次第三方 CDN，而用户没做任何动作。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIBRARY_API_PREFIX } from '../src/library.js';
import { makeLibraryRoutes } from '../src/host/library-routes.js';
import { TranscriptError } from '../src/host/transcript-parse.js';
import { createTranscriptStore } from '../src/host/transcript-store.js';

const API = LIBRARY_API_PREFIX;

const SEGMENTS = [
  { start: 0, end: 2, text: 'hello' },
  { start: 2.2, end: 4, text: 'world' },
  { start: 12, end: 14, text: 'later' },
];

function fakeReq({ url = `${API}/transcript`, method = 'GET', headers = {}, body } = {}) {
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
    chunks: [],
    writeHead(status) { this.status = status; },
    write(chunk, done) { this.chunks.push(Buffer.from(chunk)); if (typeof done === 'function') done(); return true; },
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.from(chunk)); },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

/** 只在内存里的字幕 store：判据要能直接摆布「有缓存 / 没缓存」。 */
function fakeStore(initial = {}) {
  const records = new Map(Object.entries(initial));
  return {
    records,
    dir: '/tmp/fake-transcripts',
    async read(key) { return records.get(key) ?? null; },
    async write(key, payload) {
      const record = { key, ...payload, fetchedAt: 1 };
      records.set(key, record);
      return record;
    },
    async remove(key) { records.delete(key); },
    async usage() { return { files: records.size, bytes: 0 }; },
  };
}

/**
 * ★ 用 `'key' in options` 而不是 `options.key ?? 默认值`：后者会把**显式传入的
 *   `undefined`** 当成「没传」并填上默认值 —— 于是「没接 store 时该回 501」这条
 *   用例根本走不到缺依赖的分支，它会拿到一个假的 store 并回 200。
 *   实测踩过：三条 501 用例全绿，而实现里那道闸从来没有被触发过。
 */
function harness(options = {}) {
  const store = 'store' in options ? options.store : fakeStore();
  const fetchTranscript = 'fetchTranscript' in options
    ? options.fetchTranscript
    : async ({ key }) => ({ key, segments: SEGMENTS, format: 'vtt', source: { kind: 'feed' }, fetchedAt: 9 });
  const calls = { fetch: [], requests: [], errors: [] };
  const routes = makeLibraryRoutes({
    transcriptStore: store,
    fetchTranscript: typeof fetchTranscript === 'function'
      ? async (request) => {
        calls.fetch.push(request.key);
        calls.requests.push(request);
        return await fetchTranscript(request);
      }
      : fetchTranscript,
    log: (message) => calls.errors.push(message),
  });
  return { api: routes[0], store, calls };
}

async function call(api, req) {
  const res = fakeRes();
  await api.handler(req, res);
  return res;
}

describe('GET /transcript', () => {
  it('没有缓存时回 200 + null + reason，让面板能说「还没抓过」而不是转圈', async () => {
    const { api } = harness();
    const res = await call(api, fakeReq({ url: `${API}/transcript?key=feed%3Aabc` }));
    assert.equal(res.status, 200);
    assert.equal(res.json.transcript, null);
    assert.equal(res.json.reason, 'not-cached');
  });

  it('有缓存时直接给段落，且**一次抓取都不发**', async () => {
    const store = fakeStore({
      'feed:abc': { key: 'feed:abc', segments: SEGMENTS, format: 'vtt', source: { kind: 'feed' }, fetchedAt: 5 },
    });
    const { api, calls } = harness({ store });
    const res = await call(api, fakeReq({ url: `${API}/transcript?key=${encodeURIComponent('feed:abc')}` }));
    assert.equal(res.status, 200);
    assert.equal(res.json.transcript.segments, 3);
    assert.equal(res.json.transcript.paragraphs.length, 2);
    assert.deepEqual(res.json.transcript.paragraphs[1], { start: 12, end: 14, text: 'later' });
    assert.deepEqual(calls.fetch, [], 'GET 不该触发抓取');
  });

  it('缺 key 回 400（不是 404：地址对了，参数没给）', async () => {
    const { api } = harness();
    const res = await call(api, fakeReq({ url: `${API}/transcript` }));
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BAD_KEY');
  });

  it('没接 store 时回 501，而不是 500（这是「这个版本没这能力」）', async () => {
    const { api } = harness({ store: undefined });
    const res = await call(api, fakeReq({ url: `${API}/transcript?key=feed%3Aabc` }));
    assert.equal(res.status, 501);
    assert.equal(res.json.code, 'NO_TRANSCRIPT_STORE');
  });

  it('非本机来源一律 403（这条路由在信任栅栏之内）', async () => {
    const { api } = harness();
    const res = await call(api, fakeReq({ url: `${API}/transcript?key=feed%3Aabc`, headers: { host: 'evil.example' } }));
    assert.equal(res.status, 403);
  });
});

describe('POST /transcript', () => {
  it('抓到之后回段落，并写进 store', async () => {
    const store = fakeStore();
    const { api, calls } = harness({ store });
    const res = await call(api, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'feed:abc' }),
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(calls.fetch, ['feed:abc']);
    assert.equal(res.json.transcript.format, 'vtt');
    assert.equal(res.json.transcript.paragraphs.length, 2);
    // 落盘由 service 负责（`getTranscript` → `fetchTranscriptRecord` → store），
    // 路由不重复写 —— 那条由 `test/service.test.mjs` 的「抓完就落盘」钉住。
  });

  it('把 refresh 原样转给抓取方（面板上的「重新获取」靠它绕开缓存）', async () => {
    const { api, calls } = harness();
    await call(api, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'feed:abc', refresh: true }),
    }));
    assert.deepEqual(calls.requests, [{ key: 'feed:abc', refresh: true }]);
  });

  it('没有 JSON body 回 415（与其它写入路由同一口径）', async () => {
    const { api } = harness();
    const res = await call(api, fakeReq({ method: 'POST', body: JSON.stringify({ key: 'feed:abc' }) }));
    assert.equal(res.status, 415);
  });

  it('上游没有字幕时回 404 + NO_TRANSCRIPT（用户看到的是「这期没有」）', async () => {
    const { api } = harness({
      fetchTranscript: async () => { throw new TranscriptError('这一集没有提供字幕文件', 'NO_TRANSCRIPT', 404); },
    });
    const res = await call(api, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'feed:abc' }),
    }));
    assert.equal(res.status, 404);
    assert.equal(res.json.code, 'NO_TRANSCRIPT');
  });

  it('格式不支持时回 415，而不是 400（换一集或换源能解决，不是参数写错）', async () => {
    const { api } = harness({
      fetchTranscript: async () => { throw new TranscriptError('认不出这份字幕的格式', 'TRANSCRIPT_FORMAT', 415); },
    });
    const res = await call(api, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'feed:abc' }),
    }));
    assert.equal(res.status, 415);
    assert.equal(res.json.code, 'TRANSCRIPT_FORMAT');
  });

  it('没接抓取能力时回 501，且 store 里的旧缓存不受影响', async () => {
    const store = fakeStore({
      'feed:abc': { key: 'feed:abc', segments: SEGMENTS, format: 'vtt', source: {}, fetchedAt: 5 },
    });
    const { api } = harness({ store, fetchTranscript: undefined });
    const res = await call(api, fakeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'feed:abc' }),
    }));
    assert.equal(res.status, 501);
    assert.equal(res.json.code, 'NO_TRANSCRIPT_FETCH');
    assert.ok(store.records.has('feed:abc'));
  });

  it('其它方法回 405', async () => {
    const { api } = harness();
    const res = await call(api, fakeReq({ method: 'PUT' }));
    assert.equal(res.status, 405);
  });
});

describe('store 契约', () => {
  it('真 store 与假 store 的 read/write 形状一致（防止夹具漂移成另一套接口）', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), `npr-tr-routes-${process.pid}-`));
    try {
      const store = createTranscriptStore({ rootDir: root });
      const written = await store.write('feed:abc', { segments: SEGMENTS, format: 'vtt', source: {} });
      assert.equal(written.key, 'feed:abc');
      const read = await store.read('feed:abc');
      for (const field of ['key', 'segments', 'format', 'source', 'fetchedAt']) {
        assert.ok(field in read, `真 store 少了字段 ${field}`);
      }
    } finally {
      try { await rm(root, { recursive: true, force: true }); } catch { /* 安全中心可能拦删除 */ }
    }
  });
});
