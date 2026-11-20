/**
 * `GET /audio` —— 单集音频中转（0.80.2）。
 *
 * 这条路由存在的唯一理由是「让 `<audio>` 在同源里拿到**可分段**的流」。
 * 所以判据的重心不是「200 有字节」，而是：
 *
 *   ① `206` 与 `content-range` / `accept-ranges` 必须原样出现在客户端看到的
 *      响应里 —— 少了它们，Chromium 会退回全量顺序下载，也就是用户抱怨的
 *      「点播放要等很久」「00:00 / 00:00」；
 *   ② 客户端的 `Range` 必须**原样转给上游**（不是自己切一遍：上游切得比我们准）；
 *   ③ 上游 4xx/5xx 与「这一集没有音频」是三件不同的事，状态码不能合并。
 *
 * ★ 反向对照嵌在「必须透传 accept-ranges」那条里：把上游头里的 accept-ranges
 *   拿掉，只有 `content-range` 时也要补出来 —— 实测 `cdn.fireside.fm` 就是
 *   只回 `206` + `content-range`、不回 `accept-ranges` 的。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { LIBRARY_API_PREFIX } from '../src/library.js';
import { makeLibraryRoutes } from '../src/host/library-routes.js';
import { AudioError } from '../src/host/audio-proxy.js';

const API = LIBRARY_API_PREFIX;

function fakeReq({ url = `${API}/audio`, method = 'GET', headers = {} } = {}) {
  return {
    url,
    method,
    headers: { host: '127.0.0.1:52431', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

/**
 * 假响应 = 真的 `Writable`。
 *
 * ★ 不能用「只记 chunks 的普通对象」：这条路由是 `stream.pipe(res)`，pipe 要求
 *   目标有完整的 Writable 语义（`write` 返回背压、`end` 触发 `finish`）。普通对象
 *   会让 pipe 立即抛，测出来的失败与真实原因无关。
 */
class FakeRes extends Writable {
  constructor() {
    super();
    this.status = 0;
    this.headers = {};
    this.chunks = [];
    this.flushed = false;
  }

  writeHead(status, headers) {
    this.status = status;
    /**
     * ★ 第二参数缺席时**保留**已 `setHeader` 过的头（0.85.4）。
     *
     * 真实的 `node:http` 就是这个语义：`res.setHeader('x', '1')` 之后
     * `res.writeHead(206)` 仍会把这个头发出去。第一版夹具写成
     * `this.headers = headers ?? {}`，于是「先 setHeader 再 writeHead」这条
     * 分支测出来版本头凭空消失 —— 那是夹具在骗人，不是实现有 bug。
     * 这种地方必须让夹具跟真实语义一致，否则要么假红、要么把真 bug 掩盖掉。
     */
    if (headers) this.headers = { ...this.headers, ...headers };
  }

  flushHeaders() {
    this.flushed = true;
  }

  _write(chunk, _encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }

  get bytes() {
    return Buffer.concat(this.chunks);
  }

  get json() {
    return JSON.parse(this.bytes.toString('utf8'));
  }
}

async function call(api, req) {
  const res = new FakeRes();
  await api.handler(req, res);
  // pipe 是异步收尾的：不等 finish 会读到半个 body。
  if (!res.writableEnded) await once(res, 'finish');
  return res;
}

/** 上游音频流：`Response(...).body` 就是 web ReadableStream，正是路由要的形状。 */
function audioBody(text = 'ID3-audio-bytes') {
  return new Response(text).body;
}

function harness(options = {}) {
  const audioOf = 'audioOf' in options
    ? options.audioOf
    : async () => 'https://cdn.example.com/ep.mp3';
  const openAudio = 'openAudio' in options
    ? options.openAudio
    : async () => ({
      status: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': '18',
        'content-range': 'bytes 0-17/1000',
        'accept-ranges': 'bytes',
      },
      body: audioBody(),
      finalUrl: 'https://cdn.example.com/ep.mp3',
    });
  const calls = { open: [], keys: [], logs: [] };
  const routes = makeLibraryRoutes({
    audioOf: typeof audioOf === 'function'
      ? async (key) => { calls.keys.push(key); return await audioOf(key); }
      : audioOf,
    openAudio: typeof openAudio === 'function'
      ? async (url, opts) => { calls.open.push({ url, opts }); return await openAudio(url, opts); }
      : openAudio,
    log: (message) => calls.logs.push(message),
  });
  return { api: routes[0], calls };
}

describe('GET /audio', () => {
  it('★ 透传 206 与分段头（少了 accept-ranges，客户端就退化成全量下载）', async () => {
    const { api } = harness();
    const res = await call(api, fakeReq({ url: `${API}/audio?key=${encodeURIComponent('feed:abc')}` }));
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.equal(res.headers['content-range'], 'bytes 0-17/1000');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.bytes.toString('utf8'), 'ID3-audio-bytes');
    assert.equal(res.flushed, true, '头要先 flush：客户端等的是响应头，不是第一个字节');
  });

  it('★ 客户端的 Range 原样转给上游（自己切一遍只会更不准）', async () => {
    const { api, calls } = harness();
    await call(api, fakeReq({
      url: `${API}/audio?key=k`,
      headers: { range: 'bytes=1048576-' },
    }));
    assert.equal(calls.open.length, 1);
    assert.equal(calls.open[0].opts.range, 'bytes=1048576-');
  });

  it('缺 key 回 400，且**一次上游请求都不发**', async () => {
    const { api, calls } = harness();
    const res = await call(api, fakeReq({ url: `${API}/audio` }));
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BAD_KEY');
    assert.deepEqual(calls.open, []);
  });

  it('没有音频回 404 + NO_AUDIO（和「上游挂了」不是一回事）', async () => {
    const { api } = harness({ audioOf: async () => '' });
    const res = await call(api, fakeReq({ url: `${API}/audio?key=k` }));
    assert.equal(res.status, 404);
    assert.equal(res.json.code, 'NO_AUDIO');
  });

  it('没接 openAudio 时回 501（这是「这个版本没这能力」，不是 500）', async () => {
    const { api } = harness({ openAudio: undefined });
    const res = await call(api, fakeReq({ url: `${API}/audio?key=k` }));
    assert.equal(res.status, 501);
    assert.equal(res.json.code, 'NO_AUDIO_PROXY');
  });

  it('上游拒绝时把 status 与 code 一起交给界面（403 是「被安全策略挡了」，不是「不存在」）', async () => {
    const { api } = harness({
      openAudio: async () => { throw new AudioError('音频地址不可用：指向本机', 403, 'AUDIO_BLOCKED'); },
    });
    const res = await call(api, fakeReq({ url: `${API}/audio?key=k` }));
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'AUDIO_BLOCKED');
    assert.match(res.json.error, /本机/);
  });

  it('上游 5xx 归到 502（我们自己的通道是通的，是源站坏了）', async () => {
    const { api } = harness({
      openAudio: async () => { throw new AudioError('音频源返回 500', 502, 'AUDIO_STATUS'); },
    });
    const res = await call(api, fakeReq({ url: `${API}/audio?key=k` }));
    assert.equal(res.status, 502);
    assert.equal(res.json.code, 'AUDIO_STATUS');
  });

  it('HEAD 只回头不回 body（探测型请求不该拖一整集下来）', async () => {
    const { api } = harness();
    const res = await call(api, fakeReq({ url: `${API}/audio?key=k`, method: 'HEAD' }));
    assert.equal(res.status, 206);
    assert.equal(res.bytes.length, 0);
  });

  it('反向对照：上游只给 content-range、不给 accept-ranges 时，中转必须自己补齐', async () => {
    const { openAudioStream } = await import('../src/host/audio-proxy.js');
    const upstream = new Response('x', {
      status: 206,
      headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-0/1000' },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => upstream;
    try {
      const opened = await openAudioStream('https://cdn.example.com/ep.mp3', {
        checkUrl: async () => ({ ok: true }),
      });
      assert.equal(opened.headers['accept-ranges'], 'bytes', '缺了这句，客户端会按不可 seek 处理');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('反向对照：上游 302 时不把地址直接交给客户端，而是自己跟完再回 206', async () => {
    const { openAudioStream } = await import('../src/host/audio-proxy.js');
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(url);
      if (seen.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/real.mp3' } });
      }
      return new Response('y', {
        status: 206,
        headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-0/10' },
      });
    };
    try {
      const opened = await openAudioStream('https://short.example.com/ep', {
        checkUrl: async () => ({ ok: true }),
      });
      assert.equal(seen.length, 2, '应当跟一跳');
      assert.equal(opened.finalUrl, 'https://cdn.example.com/real.mp3');
      assert.equal(opened.status, 206);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('GET /audio-info（宿主自检）', () => {
  it('★ 自报版本 + 只探 2 个字节就得出「能不能定位」', async () => {
    const { api, calls } = harness();
    const res = await call(api, fakeReq({ url: `${API}/audio-info?key=${encodeURIComponent('feed:abc')}` }));
    assert.equal(res.status, 200);
    const info = res.json;
    assert.equal(info.ok, true);
    assert.equal(typeof info.build, 'string');
    assert.notEqual(info.build, '', '空版本号等于自报失败');
    assert.equal(info.seekable, true, '有 content-range + total 才算能定位');
    assert.equal(info.total, 1000);
    // ★ 只许探两字节：`bytes=0-` 是 64 MB，每集探一次等于把整集下两遍。
    assert.equal(calls.open[0].opts.range, 'bytes=0-1');
  });

  it('★ 上游缺 content-range ⇒ seekable:false（这条就是「拖不动」的检测器）', async () => {
    const { api } = harness({
      openAudio: async () => ({
        status: 206,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '64551564' },
        body: audioBody(),
      }),
    });
    const res = await call(api, fakeReq({ url: `${API}/audio-info?key=k` }));
    assert.equal(res.json.seekable, false, '没有 content-range，浏览器算不出总长，不能说「能跳」');
    assert.equal(res.json.total, null, '拿不到总长就必须是 null，不能拿 content-length 冒充');
  });

  it('★ 没有音频 / 缺 key 时如实回错（别让自检本身变成谎报）', async () => {
    const { api } = harness({ audioOf: async () => '' });
    const noAudio = await call(api, fakeReq({ url: `${API}/audio-info?key=k` }));
    assert.equal(noAudio.status, 404);
    assert.equal(noAudio.json.ok, false);
    const noKey = await call(api, fakeReq({ url: `${API}/audio-info` }));
    assert.equal(noKey.status, 400);
  });

  it('★ `/audio` 的响应必须带版本头（界面靠它区分「新宿主」与「两小时前加载的旧模块」）', async () => {
    const { api } = harness();
    const res = await call(api, fakeReq({ url: `${API}/audio?key=k` }));
    assert.equal(typeof res.headers['x-npr-host-build'], 'string');
    assert.notEqual(res.headers['x-npr-host-build'], '');
  });

  it('★ 走 `setHeader` 分支（真实宿主）时版本头同样在', async () => {
    const { api } = harness();
    class HeaderRes extends FakeRes {
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      }
    }
    const res = new HeaderRes();
    await api.handler(fakeReq({ url: `${API}/audio?key=k` }), res);
    if (!res.writableEnded) await once(res, 'finish');
    assert.notEqual(res.headers['x-npr-host-build'], undefined);
  });
});

describe('音频中转与「安全」的边界', () => {
  it('跳转到内网地址时被挡住（每一跳都要校验，不能交给 fetch 的 follow 去做）', async () => {
    const { openAudioStream } = await import('../src/host/audio-proxy.js');
    const realFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      // 第一跳是外面那个看起来正常的短链，它 302 到本机 —— 这正是要挡的形态。
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/ep.mp3' } });
    };
    try {
      await assert.rejects(
        () => openAudioStream('https://short.example.com/ep', {
          checkUrl: async (url) => (url.includes('127.0.0.1')
            ? { ok: false, reason: '指向本机或内网地址（127.0.0.1）' }
            : { ok: true }),
        }),
        (error) => error.status === 403 && error.code === 'AUDIO_BLOCKED',
      );
      assert.equal(fetched.length, 1, '第一跳发了；跳过去的内网地址必须**一个请求都不发**');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('abort 时给出 499 而不是「未知错误」（用户换集是正常操作，不该记成故障）', async () => {
    const { openAudioStream } = await import('../src/host/audio-proxy.js');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
    try {
      await assert.rejects(
        () => openAudioStream('https://cdn.example.com/ep.mp3', { checkUrl: async () => ({ ok: true }) }),
        (error) => error.status === 499 && error.code === 'AUDIO_ABORTED',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/** `Readable` 只在断言里用到一次，保留导入以免 lint 认为它多余。 */
void Readable;
