/**
 * `openAudioStream` —— 客户端看到的响应头是不是**合规**的（0.85.3）。
 *
 * 这里守的是一个很窄但致命的事实：**上游可以回 `206` 却不给 `content-range`**。
 * 实测 `media.xyzcdn.net`（小宇宙，Tengine + OSS）就是这样：
 *
 *     HTTP/2 206
 *     content-type: audio/mp4
 *     content-length: 64551564
 *     accept-ranges: bytes
 *     （没有 content-range）
 *
 * HTTP 规范里 206 必须带 `content-range`，Chromium 的媒体栈正是靠它算出
 * 「整条资源多大」与「这段字节在文件里的位置」。缺了它，元素会进入「长度未知的
 * 流」：`duration` 是 `NaN`/`Infinity`、`seekable` 是空区间。**播放照常出声**，
 * 所以故障只出现在进度条、±15 秒、断点恢复这三件事上 —— 用户看到的是三个 bug。
 *
 * 判据用**假 fetch**，不打外网：要断的正是「上游缺头时我们补没补」，
 * 而这恰好是真实上游的行为，不是编出来的。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openAudioStream, resetTotalCache } from '../src/host/audio-proxy.js';

/** 不看地址的放行者：测试只关心头，不关心 SSRF。 */
const openGuard = async () => ({ ok: true });

/** 造一个假上游响应。`body` 给 null 表示没有 body（HEAD 之类）。 */
function fakeResponse(status, headers = {}, body = null) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    body,
  };
}

/** 用一串预设响应替换 `fetch`，并记录每次请求带的 Range。 */
function stubFetch(queue) {
  const calls = [];
  globalThis.fetch = async (_url, init = {}) => {
    calls.push(init.headers?.range ?? '');
    const next = queue.shift();
    if (!next) throw new Error('假 fetch 的预设响应用完了');
    return next;
  };
  return calls;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetTotalCache();
  globalThis.fetch = realFetch;
});

describe('openAudioStream 补齐分段头', () => {
  it('★ 上游 206 不给 content-range ⇒ 中转必须自己算出来（根因所在）', async () => {
    stubFetch([fakeResponse(206, {
      'content-type': 'audio/mp4',
      'content-length': '1000',
      'accept-ranges': 'bytes',
    })]);
    const out = await openAudioStream('https://cdn.test/ep.m4a', { range: 'bytes=0-', checkUrl: openGuard });
    assert.equal(out.status, 206);
    assert.equal(
      out.headers['content-range'],
      'bytes 0-999/1000',
      '206 没有 content-range，Chromium 就会把 duration 算成 NaN、seekable 变空',
    );
    assert.equal(out.headers['accept-ranges'], 'bytes');
    assert.equal(out.headers['content-length'], '1000', '跨度必须与 content-length 一致');
  });

  it('★ 拖到中间（起点 > 0）且没有总长记忆 ⇒ 先探一次总长，再补 content-range', async () => {
    const calls = stubFetch([
      // 第一次是探测（bytes=0-），只用来读长度
      fakeResponse(206, { 'content-type': 'audio/mp4', 'content-length': '4000' }),
      // 第二次是真正的 `bytes=3000-`
      fakeResponse(206, { 'content-type': 'audio/mp4', 'content-length': '1000' }),
    ]);
    const out = await openAudioStream('https://cdn.test/mid.m4a', { range: 'bytes=3000-', checkUrl: openGuard });
    assert.equal(calls[0], 'bytes=0-', '第一次必须是「从 0 开始」的探测，否则推不出总长');
    assert.equal(calls[1], 'bytes=3000-', '真正的 Range 要原样转给上游');
    assert.equal(out.headers['content-range'], 'bytes 3000-3999/4000');
    assert.equal(out.status, 206);
  });

  it('上游自己给了 content-range ⇒ 原样用，不覆盖（换了版本时只有它是对的）', async () => {
    stubFetch([fakeResponse(206, {
      'content-type': 'audio/mpeg',
      'content-length': '18',
      'content-range': 'bytes 0-17/9999',
      'accept-ranges': 'bytes',
    })]);
    const out = await openAudioStream('https://cdn.test/ok.mp3', { range: 'bytes=0-', checkUrl: openGuard });
    assert.equal(out.headers['content-range'], 'bytes 0-17/9999');
  });

  it('上游只给 content-range、不给 accept-ranges ⇒ 补齐（fireside 就是这样）', async () => {
    stubFetch([fakeResponse(206, {
      'content-type': 'audio/mpeg',
      'content-length': '1',
      'content-range': 'bytes 0-0/1000',
    })]);
    const out = await openAudioStream('https://cdn.test/f.mp3', { range: 'bytes=0-', checkUrl: openGuard });
    assert.equal(out.headers['accept-ranges'], 'bytes');
  });

  it('反向对照：上游忽略 Range 回 200 ⇒ 不许谎报 accept-ranges，也不许编 content-range', async () => {
    stubFetch([
      // 第一次：探测总长（起点 > 0 时才有这一步）
      fakeResponse(200, { 'content-type': 'audio/mpeg', 'content-length': '5000' }),
      // 第二次：真正的 `bytes=1000-`，上游照样回 200
      fakeResponse(200, { 'content-type': 'audio/mpeg', 'content-length': '5000' }),
    ]);
    const out = await openAudioStream('https://cdn.test/nogr.mp3', { range: 'bytes=1000-', checkUrl: openGuard });
    assert.equal(out.status, 200);
    assert.equal(out.headers['accept-ranges'], undefined, '上游不支持分段时硬写这个头，客户端会发出一堆拿不到 206 的请求');
    assert.equal(out.headers['content-range'], undefined);
  });

  it('`bytes=-500`（末尾 N 字节）不能用响应长度当总长', async () => {
    // 上游按总长算，回了最后 500 字节
    stubFetch([fakeResponse(206, {
      'content-type': 'audio/mpeg',
      'content-length': '500',
      'accept-ranges': 'bytes',
    })]);
    const out = await openAudioStream('https://cdn.test/tail.mp3', { range: 'bytes=-500', checkUrl: openGuard });
    assert.equal(
      out.headers['content-range'],
      undefined,
      '把「最后 500 字节」当成「文件共 500 字节」，会让进度条分母变成 500 秒级 —— 必须留给上游',
    );
  });

  it('4xx/5xx 仍然是错误，不是「没头的正常流」', async () => {
    stubFetch([fakeResponse(404, { 'content-type': 'text/plain' })]);
    await assert.rejects(
      () => openAudioStream('https://cdn.test/404.mp3', { range: '', checkUrl: openGuard }),
      (error) => error.code === 'AUDIO_STATUS' && error.status === 502,
    );
  });

  /**
   * ★ 真机诊断读到的组合（0.85.7）：
   *
   *     dur=4580.2   seekable=[0,0]   readyState=4
   *     响应 206      cr=bytes 0-1/74146460   cl=无
   *
   * `content-range` 有、`content-length` 没有 —— 上游对极短片段走了 chunked。
   * Chromium 的媒体栈据此把这条流当成「长度未知」：播放照常，但 `seekable`
   * 退化成 `[0,0]`，`currentTime = t` 被夹回 0。所以补上它是必须的。
   */
  it('★ 206 有 content-range 但缺 content-length ⇒ 必须按区间补上', async () => {
    stubFetch([fakeResponse(206, {
      'content-type': 'audio/mp4',
      'content-range': 'bytes 0-1/74146460',
      'accept-ranges': 'bytes',
    })]);
    const out = await openAudioStream('https://cdn.test/short.m4a', { range: 'bytes=0-1', checkUrl: openGuard });
    assert.equal(out.status, 206);
    assert.equal(out.headers['content-range'], 'bytes 0-1/74146460');
    assert.equal(
      out.headers['content-length'],
      '2',
      '没有 content-length 的 206 会让 Chromium 判 seekable=[0,0]，进度条与 ±15 秒一起失效',
    );
  });

  it('反向对照：上游给了 content-length ⇒ 原样保留，不改写', async () => {
    stubFetch([
      // 起点 > 0 ⇒ 先探一次总长（`bytes=0-`），这条响应只用来读长度。
      fakeResponse(206, { 'content-type': 'audio/mp4', 'content-length': '1000', 'content-range': 'bytes 0-999/1000' }),
      fakeResponse(206, {
        'content-type': 'audio/mp4',
        'content-range': 'bytes 100-199/1000',
        'content-length': '100',
      }),
    ]);
    const out = await openAudioStream('https://cdn.test/ok-range.m4a', { range: 'bytes=100-199', checkUrl: openGuard });
    assert.equal(out.headers['content-length'], '100');
  });
});
