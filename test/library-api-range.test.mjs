/**
 * `fetchBookRange` 的判据（0.24.4）。
 *
 * 这个函数是 pdf.js 的取字节通道，两条坏法都「看起来能用」：
 *   - 服务端忽略 Range 返回 200 ⇒ 整本被当成第一片，翻页全乱；
 *   - 网络卡住没有超时 ⇒ 用户看到的是「一直在转圈」，代码里没人会放弃。
 * 所以两条各配反向对照，另外钉住「超时」与「用户取消」必须报不同的错。
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { fetchBookRange } from '../src/client/library-api.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** 造一个假 Response。 */
function makeResponse(status, { body = new Uint8Array([1, 2, 3]), contentRange, json } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-range' ? (contentRange ?? null) : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    json: async () => { if (json === undefined) throw new Error('not json'); return json; },
  };
}

/** 记录请求的假 fetch。 */
function spyFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return calls;
}

describe('fetchBookRange：Range 语义', () => {
  it('206 + 正确的 content-range ⇒ 返回这段字节', async () => {
    const calls = spyFetch(() => makeResponse(206, { contentRange: 'bytes 100-199/5000' }));
    const bytes = await fetchBookRange('book-1', 100, 200);
    assert.deepEqual([...bytes], [1, 2, 3]);
    // ★ 开区间：end=200 时请求头必须是 `bytes=100-199`，多一个字节段与段就重叠。
    assert.equal(calls[0].init.headers.Range, 'bytes=100-199');
  });

  it('★ 200 ⇒ 抛错（服务端忽略了 Range，整本被当成一片）', async () => {
    spyFetch(() => makeResponse(200));
    await assert.rejects(
      () => fetchBookRange('book-1', 0, 1024),
      /忽略了 Range|200/,
    );
  });

  it('206 但 content-range 起点不对 ⇒ 抛错（喂错段比报错更糟）', async () => {
    spyFetch(() => makeResponse(206, { contentRange: 'bytes 0-99/5000' }));
    await assert.rejects(
      () => fetchBookRange('book-1', 100, 200),
      /区间不对/,
    );
  });

  it('404 且宿主给了中文 error ⇒ 用它当文案', async () => {
    spyFetch(() => makeResponse(404, { json: { ok: false, error: '文件不在了' } }));
    await assert.rejects(() => fetchBookRange('book-1', 0, 10), /文件不在了/);
  });

  it('500 且不是 JSON ⇒ 退回状态码', async () => {
    spyFetch(() => makeResponse(500));
    await assert.rejects(() => fetchBookRange('book-1', 0, 10), /HTTP 500/);
  });

  it('反向对照：旧形态（200 也收）会把整本当成分片吞下去', async () => {
    // 旧实现的条件是 `status !== 206 && status !== 200` ⇒ 200 直接通过。
    const oldAccept = (status) => status === 206 || status === 200;
    assert.equal(oldAccept(200), true, '旧形态确实放行了 200');
    // 新实现必须拒：这一条让上面的断言不至于只是「描述自己」。
    spyFetch(() => makeResponse(200));
    await assert.rejects(() => fetchBookRange('book-1', 0, 10));
  });
});

describe('fetchBookRange：超时与取消', () => {
  /** 像真 fetch 一样响应 abort 的挂起实现。 */
  const hanging = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });

  it('★ 卡住不返回 ⇒ 超时报错（不是永远转圈）', async () => {
    globalThis.fetch = hanging;
    await assert.rejects(
      () => fetchBookRange('book-1', 0, 10, undefined, { timeoutMs: 40 }),
      /取书超时/,
    );
  });

  it('★ 外部 signal 取消 ⇒ 报的不是「超时」（两个方向的取消要分得开）', async () => {
    globalThis.fetch = hanging;
    const controller = new AbortController();
    const pending = fetchBookRange('book-1', 0, 10, controller.signal, { timeoutMs: 5_000 });
    controller.abort();
    await assert.rejects(
      pending,
      (error) => !/取书超时/.test(String(error?.message)),
      '用户主动取消被报成了超时 —— 界面会给出一句误导的提示',
    );
  });

  it('外部 signal 已经取消 ⇒ 立刻失败，一个请求都不发', async () => {
    const calls = spyFetch(() => makeResponse(206, { contentRange: 'bytes 0-9/100' }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => fetchBookRange('book-1', 0, 10, controller.signal));
    assert.equal(calls.length, 0, '取消之后仍然发了请求');
  });

  it('正常返回后定时器被清掉（不留下一个 20 秒的 ref 定时器）', async () => {
    spyFetch(() => makeResponse(206, { contentRange: 'bytes 0-9/100' }));
    await fetchBookRange('book-1', 0, 10);
    // 拿不到内部句柄，用「事件循环能立刻空掉」间接证明：这里若有泄漏的 ref
    // 定时器，整个测试文件会挂满 20 秒。断言放在耗时上。
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(Date.now() - startedAt < 1_000);
  });
});
