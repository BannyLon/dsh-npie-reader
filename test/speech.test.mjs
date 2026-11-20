/**
 * 云端朗读（0.55.0）。
 *
 * 这个功能有三处「不真跑就答不了」的地方，所以本文件全部用**注入的假 fetch /
 * 假 audio / 假 req-res** 跑真代码：
 *
 *   1. **没配 Key 时一个请求都不许发**。只断言「抛了错」是不够的 —— 抛错也可能是
 *      「先发了请求、拿到 401 再抛」，那等于把一个空凭证送到公网上。
 *   2. **命中缓存不许再发请求**。这是这个功能唯一省钱的机制；失效了不会报错，
 *      只会每个月多花几十块。
 *   3. **200 + 空 body 不许写进缓存**。写进去的话，那 0 字节会命中 90 天的缓存，
 *      那篇文章从此再也读不出声 —— 而且没有任何报错。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  CLOUD_PREFIX, LOCAL_PREFIX, SILICON_MODEL, SILICON_PRICE_PER_KB, SILICON_VOICES, SILICON_VOICE_DEFAULT,
  SPEECH_API_PREFIX, SPEECH_CHUNK_MAX, estimateSpeechCost, isSiliconVoice, maskApiKey,
  normalizeSiliconVoice, normalizeSpeechSpeed, parseSpeechVoice, siliconVoiceParam,
  speechBytes, speechVoiceValue,
} from '../src/speech.js';
import { SpeechError, createSpeechSynth } from '../src/host/speech.js';
import { makeSpeechRoutes } from '../src/host/speech-routes.js';
import { createCloudPlayer } from '../src/client/speech-engine.js';
import { READING_DEFAULTS } from '../src/reading-settings.js';
import { LIVE_WRITTEN_SETTINGS } from '../src/client/settings-patch.js';
import { publicSettings } from '../src/host/service.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const dirs = [];
after(async () => {
  for (const dir of dirs) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* 沙箱可能拦删除 */ }
  }
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'npie-speech-'));
  dirs.push(dir);
  return dir;
}

/** 假 fetch：记录每一次调用，按 `plan` 依次返回。 */
function fakeFetch(plan) {
  const calls = [];
  const queue = [...plan];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = queue.shift();
    if (next === undefined) throw new Error(`fetch 桩：没有为第 ${calls.length} 次调用准备响应`);
    if (next.throw) throw next.throw;
    const bytes = Buffer.from(next.body ?? 'ID3fake-mp3-bytes');
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      headers: { get: () => null },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      async text() { return bytes.toString('utf8'); },
    };
  };
  return { impl, calls };
}

function makeSynth({ apiKey = 'sk-test-1234', plan = [{}], dir } = {}) {
  const { impl, calls } = fakeFetch(plan);
  const synth = createSpeechSynth({
    getApiKey: () => apiKey,
    cacheDir: dir,
    fetchImpl: impl,
  });
  return { synth, calls };
}

// ---------------------------------------------------------------------------
// 一、共用判据
// ---------------------------------------------------------------------------

describe('0.55：音色值的编码', () => {
  it('引擎前缀能往返', () => {
    for (const engine of ['system', 'siliconflow']) {
      const value = speechVoiceValue(engine, 'claire');
      assert.equal(parseSpeechVoice(value).engine, engine);
      assert.equal(parseSpeechVoice(value).voice, 'claire');
    }
    assert.equal(speechVoiceValue('system', 'Tingting'), `${LOCAL_PREFIX}Tingting`);
    assert.equal(speechVoiceValue('siliconflow', 'alex'), `${CLOUD_PREFIX}alex`);
  });

  it('★ 0.54.0 存下的裸名字必须兼容成本机语音', () => {
    // 不兼容的话，升级后用户上次选的音色静默失效，界面上看不出任何异常
    assert.deepEqual(parseSpeechVoice('Tingting'), { engine: 'system', voice: 'Tingting' });
    assert.deepEqual(parseSpeechVoice(''), { engine: 'system', voice: '' });
  });

  it('★ 云端音色 id 非法时落到默认，且空值不会变成「没有引擎」', () => {
    assert.deepEqual(parseSpeechVoice(`${CLOUD_PREFIX}不存在的音色`), {
      engine: 'siliconflow', voice: SILICON_VOICE_DEFAULT,
    });
    assert.equal(normalizeSiliconVoice('nope'), SILICON_VOICE_DEFAULT);
    assert.equal(normalizeSiliconVoice('alex'), 'alex');
    assert.ok(isSiliconVoice(SILICON_VOICE_DEFAULT));
  });

  it('voice 参数是「模型:音色」形态，不是裸音色名', () => {
    // 官方只写 `claire` 会被当成「不存在的模型」，回 4xx
    assert.equal(siliconVoiceParam('claire'), `${SILICON_MODEL}:claire`);
    assert.match(siliconVoiceParam('claire'), /^[^:]+\/[^:]+:[a-z]+$/);
    assert.equal(siliconVoiceParam('不存在'), `${SILICON_MODEL}:${SILICON_VOICE_DEFAULT}`);
  });
});

describe('0.55：计费口径', () => {
  it('★ 按 UTF-8 字节算，一个汉字 3 字节（不是按字符）', () => {
    assert.equal(speechBytes('汉'), 3);
    assert.equal(speechBytes('abc'), 3);
    assert.equal(speechBytes('汉a'), 4);
    // 3000 个汉字 = 9000 字节
    assert.equal(speechBytes('汉'.repeat(3000)), 9000);
  });

  it('★ 估算单价与常量同源：3000 字约 0.45 元', () => {
    const cost = estimateSpeechCost('汉'.repeat(3000));
    assert.ok(Math.abs(cost - 0.45) < 1e-9, `实际 ${cost}`);
    assert.ok(Math.abs(cost - (9000 / 1000) * SILICON_PRICE_PER_KB) < 1e-9);
    // 反向对照：如果哪天有人按「字符数 × 单价」算，这条会立刻红
    assert.notEqual(estimateSpeechCost('汉'.repeat(3000)), 3000 / 1000 * SILICON_PRICE_PER_KB);
  });

  it('语速夹到 [0.25, 4]，非数字回 1', () => {
    assert.equal(normalizeSpeechSpeed(0.1), 0.25);
    assert.equal(normalizeSpeechSpeed(9), 4);
    assert.equal(normalizeSpeechSpeed('x'), 1);
    assert.equal(normalizeSpeechSpeed(1.25), 1.25);
  });
});

describe('0.55：掩码', () => {
  it('只露头尾，且短 Key 整体遮住', () => {
    const masked = maskApiKey('sk-abcdefghijklmn');
    assert.ok(!masked.includes('efghijkl'), `掩码里泄露了中间部分：${masked}`);
    assert.match(masked, /^sk-a.*mn$/);
    assert.equal(maskApiKey(''), '');
    assert.equal(maskApiKey('short'), '••••');
  });
});

// ---------------------------------------------------------------------------
// 二、宿主合成器
// ---------------------------------------------------------------------------

describe('0.55：合成器', () => {
  it('★ 没配 Key 时一个请求都不许发', async () => {
    const dir = await tempDir();
    const { synth, calls } = makeSynth({ apiKey: '   ', dir });
    await assert.rejects(() => synth.synthesize({ text: '你好' }), (error) => {
      assert.equal(error.code, 'NO_KEY');
      assert.equal(error.status, 400);
      return true;
    });
    // 这一条才是重点：抛错也可能是「先发了请求再抛」
    assert.equal(calls.length, 0, '没配 Key 却已经把请求发出去了');
  });

  it('★ 超长文本直接拒，且不发请求（不静默截断）', async () => {
    const dir = await tempDir();
    const { synth, calls } = makeSynth({ dir });
    await assert.rejects(() => synth.synthesize({ text: '字'.repeat(SPEECH_CHUNK_MAX + 1) }), (error) => {
      assert.equal(error.code, 'TEXT_TOO_LONG');
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it('空文本直接拒', async () => {
    const dir = await tempDir();
    const { synth } = makeSynth({ dir });
    await assert.rejects(() => synth.synthesize({ text: '   ' }), (error) => error.code === 'EMPTY_TEXT');
  });

  it('发出去的请求形状正确（端点 / 头 / body）', async () => {
    const dir = await tempDir();
    const { synth, calls } = makeSynth({ apiKey: 'sk-abc', dir, plan: [{ status: 200 }] });
    await synth.synthesize({ text: '你好世界', voice: 'alex', speed: 1.3 });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.match(call.url, /api\.siliconflow\.cn\/v1\/audio\/speech$/);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.authorization, 'Bearer sk-abc');
    assert.equal(call.body.model, SILICON_MODEL);
    assert.equal(call.body.input, '你好世界');
    assert.equal(call.body.voice, `${SILICON_MODEL}:alex`);
    assert.equal(call.body.response_format, 'mp3');
    assert.equal(call.body.speed, 1.3);
  });

  it('★ 命中缓存时不再发请求（这是唯一省钱的地方）', async () => {
    const dir = await tempDir();
    const { synth, calls } = makeSynth({ dir, plan: [{ status: 200 }, { status: 200 }] });
    const first = await synth.synthesize({ text: '同一段文本', voice: 'claire', speed: 1 });
    assert.equal(first.cached, false);
    assert.equal(first.bytesBilled, speechBytes('同一段文本'));
    const second = await synth.synthesize({ text: '同一段文本', voice: 'claire', speed: 1 });
    assert.equal(second.cached, true);
    assert.equal(second.bytesBilled, 0);
    assert.equal(calls.length, 1, '第二次仍然发了请求 —— 缓存没生效');
    // 反向对照：换了语速就是另一份产物，必须重新合成
    await synth.synthesize({ text: '同一段文本', voice: 'claire', speed: 1.3 });
    assert.equal(calls.length, 2);
  });

  it('★ 200 + 空 body 报错且**不写缓存**（否则那篇文章从此读不出声）', async () => {
    const dir = await tempDir();
    const { synth } = makeSynth({ dir, plan: [{ status: 200, body: '' }] });
    await assert.rejects(() => synth.synthesize({ text: '这段会失败' }), (error) => {
      assert.equal(error.code, 'EMPTY_AUDIO');
      return true;
    });
    assert.deepEqual(await readdir(dir).catch(() => []), [], '空音频被写进了缓存');
  });

  it('状态码映射成不同的 code 与 HTTP 状态', async () => {
    const cases = [
      [401, 'BAD_KEY', 401],
      [402, 'NO_BALANCE', 402],
      [403, 'FORBIDDEN', 403],
      [429, 'RATE_LIMITED', 429],
      [500, 'UPSTREAM', 502],
      [418, 'UPSTREAM', 502],
    ];
    for (const [status, code, expected] of cases) {
      const dir = await tempDir();
      const { synth } = makeSynth({ dir, plan: [{ status, body: 'upstream said no' }] });
      await assert.rejects(() => synth.synthesize({ text: '文本' }), (error) => {
        assert.equal(error.code, code, `HTTP ${status} 应该映射成 ${code}`);
        assert.equal(error.status, expected);
        assert.ok(error instanceof SpeechError);
        return true;
      });
    }
  });

  it('★ 同一段文本并发请求只发一次（不重复计费）', async () => {
    const dir = await tempDir();
    const { synth, calls } = makeSynth({ dir, plan: [{ status: 200 }] });
    const [a, b] = await Promise.all([
      synth.synthesize({ text: '并发同一段', voice: 'anna', speed: 1 }),
      synth.synthesize({ text: '并发同一段', voice: 'anna', speed: 1 }),
    ]);
    assert.equal(calls.length, 1, '同一段文本被合成了两次');
    assert.equal(a.bytes.length, b.bytes.length);
  });

  it('网络错误 / 超时各有一句人话', async () => {
    const dir = await tempDir();
    const { synth } = makeSynth({ dir, plan: [{ throw: Object.assign(new Error('boom'), { name: 'TimeoutError' }) }] });
    await assert.rejects(() => synth.synthesize({ text: '文本' }), (error) => error.code === 'TIMEOUT');

    const dir2 = await tempDir();
    const { synth: synth2 } = makeSynth({ dir: dir2, plan: [{ throw: new Error('ECONNREFUSED') }] });
    await assert.rejects(() => synth2.synthesize({ text: '文本' }), (error) => {
      assert.equal(error.code, 'NETWORK');
      assert.match(error.message, /api\.siliconflow\.cn/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// 三、路由
// ---------------------------------------------------------------------------

const TRUSTED = { host: '127.0.0.1:52431', remote: '127.0.0.1' };

function fakeReq({ url = `${SPEECH_API_PREFIX}/config`, method = 'GET', headers = {}, body } = {}) {
  const req = {
    url,
    method,
    headers: { host: TRUSTED.host, ...headers },
    socket: { remoteAddress: TRUSTED.remote },
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
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.from(chunk)); this.ended = true; return this; },
    get body() { return Buffer.concat(this.chunks); },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

function makeRoutes({ apiKey = '', synth } = {}) {
  let key = apiKey;
  const saved = [];
  const dir = synth ?? null;
  const routes = makeSpeechRoutes({
    synth: dir ?? createSpeechSynth({ getApiKey: () => key, cacheDir: '/nonexistent-npie-test' }),
    getApiKey: () => key,
    setApiKey: async (next) => { key = next; saved.push(next); },
  });
  return { handler: routes[0].handler, route: routes[0], saved, keyOf: () => key };
}

describe('0.55：朗读路由', () => {
  it('挂在独立前缀下', () => {
    assert.equal(SPEECH_API_PREFIX, '/api/dsh-npie-reader/speech');
  });

  it('★ 不可信请求一律 403（三条子判据各来一次反向对照）', async () => {
    const { handler } = makeRoutes({ apiKey: 'sk-secret-value' });
    const cases = [
      ['非回环 socket', fakeReq({ headers: {} })],
      ['Host 不是回环', fakeReq({ headers: { host: 'evil.example.com' } })],
      ['跨站标记', fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } })],
      ['Origin 与 Host 不同', fakeReq({ headers: { origin: 'http://evil.example.com' } })],
    ];
    cases[0][1].socket.remoteAddress = '10.0.0.5';
    for (const [label, req] of cases) {
      const res = fakeRes();
      await handler(req, res);
      assert.equal(res.status, 403, `${label} 应该被挡下`);
    }
    // 反向对照：同一份代码，可信请求必须 200 —— 否则上面四条可能只是「全都 403」
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert.equal(res.status, 200);
  });

  it('★ GET /config 只回掩码，绝不回 Key 原文', async () => {
    const raw = 'sk-super-secret-abcdef123456';
    const { handler } = makeRoutes({ apiKey: raw });
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.configured, true);
    assert.ok(!res.body.toString('utf8').includes(raw), '响应体里出现了 Key 原文');
    assert.equal(res.json.masked, maskApiKey(raw));
    assert.equal(res.json.voices.length, SILICON_VOICES.length);
  });

  it('没配 Key 时 configured 为 false，且仍给出音色清单', async () => {
    const { handler } = makeRoutes({ apiKey: '' });
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert.equal(res.json.configured, false);
    assert.equal(res.json.masked, '');
    assert.ok(res.json.voices.length > 0);
  });

  it('★ POST /config 存的是 trim 后的值（控制台复制常带换行）', async () => {
    const { handler, saved, keyOf } = makeRoutes();
    const res = fakeRes();
    await handler(fakeReq({
      method: 'POST',
      body: JSON.stringify({ apiKey: '  sk-abc123\n' }),
    }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(saved, ['sk-abc123']);
    assert.equal(keyOf(), 'sk-abc123');
  });

  it('★ POST /config 拒掉非法字符（全角/中文混进来必然 401）', async () => {
    const { handler, saved } = makeRoutes();
    const res = fakeRes();
    await handler(fakeReq({ method: 'POST', body: JSON.stringify({ apiKey: 'sk-中文' }) }), res);
    assert.equal(res.status, 400);
    assert.deepEqual(saved, [], '非法值被写进去了');
  });

  it('POST /config 缺字段 / 非 JSON 都是 400，不是 500', async () => {
    const { handler } = makeRoutes();
    for (const body of [JSON.stringify({}), 'not json at all']) {
      const res = fakeRes();
      await handler(fakeReq({ method: 'POST', body }), res);
      assert.equal(res.status, 400, `body=${body}`);
    }
  });

  it('POST /synth 回 audio/mpeg 与字节', async () => {
    const dir = await tempDir();
    const { synth } = makeSynth({ dir, plan: [{ status: 200, body: 'MP3DATA' }] });
    const { handler } = makeRoutes({ apiKey: 'sk-ok', synth });
    const res = fakeRes();
    await handler(fakeReq({
      url: `${SPEECH_API_PREFIX}/synth`,
      method: 'POST',
      body: JSON.stringify({ text: '你好', voice: 'alex', speed: 1 }),
    }), res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.equal(res.headers['x-speech-cached'], '0');
    assert.equal(res.body.toString('utf8'), 'MP3DATA');
  });

  it('★ /synth 的失败带上机器可读的 code 与正确的状态码', async () => {
    const { handler } = makeRoutes({ apiKey: '' });
    const res = fakeRes();
    await handler(fakeReq({
      url: `${SPEECH_API_PREFIX}/synth`,
      method: 'POST',
      body: JSON.stringify({ text: '你好' }),
    }), res);
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'NO_KEY');
  });

  it('未知子路径 404，错误方法 405', async () => {
    const { handler } = makeRoutes();
    const notFound = fakeRes();
    await handler(fakeReq({ url: `${SPEECH_API_PREFIX}/nope` }), notFound);
    assert.equal(notFound.status, 404);

    const wrongMethod = fakeRes();
    await handler(fakeReq({ method: 'DELETE' }), wrongMethod);
    assert.equal(wrongMethod.status, 405);
  });
});

// ---------------------------------------------------------------------------
// 四、交给界面的设置必须剔掉密钥
// ---------------------------------------------------------------------------

describe('0.55：密钥不出宿主进程', () => {
  it('★ publicSettings 剔掉 speechApiKey，但**别的字段一个不少**', () => {
    const raw = 'sk-leak-me-please-1234';
    const out = publicSettings({ ...READING_DEFAULTS, speechApiKey: raw });
    assert.equal(out.speechApiKey, undefined);
    assert.ok(!JSON.stringify(out).includes(raw));
    // 反向对照：不能为了删密钥把整份设置删空。
    // ★ 口径按「剔掉的正好是所有 *ApiKey 字段」，不写死 -1：0.84.0 又加了
    //   asrApiKey（云端识别的 Key，同一条纪律），删两个才对。写死 -1 会在
    //   新增密钥字段时假红，而真漏删（某个 Key 出了宿主）反而没人管。
    assert.equal(out.fontSize, READING_DEFAULTS.fontSize);
    assert.equal(out.readingTheme, READING_DEFAULTS.readingTheme);
    const secretKeys = Object.keys(READING_DEFAULTS).filter((key) => key.endsWith('ApiKey'));
    assert.ok(secretKeys.length >= 1, '前置条件：默认值里至少有一个密钥字段');
    assert.ok(secretKeys.includes('speechApiKey') && secretKeys.includes('asrApiKey'));
    for (const key of secretKeys) assert.equal(out[key], undefined, `${key} 不该出宿主进程`);
    assert.equal(Object.keys(out).length, Object.keys(READING_DEFAULTS).length - secretKeys.length);
  });

  it('★ speechApiKey 登记在 LIVE_WRITTEN_SETTINGS 里（否则点一次保存就清空）', () => {
    assert.ok(
      LIVE_WRITTEN_SETTINGS.includes('speechApiKey'),
      '设置弹窗那份旧快照（没有 Key）会把它覆盖成空串，而界面显示「设置已保存」',
    );
  });
});

// ---------------------------------------------------------------------------
// 五、客户端播放引擎
// ---------------------------------------------------------------------------

function fakeAudio() {
  const listeners = new Map();
  return {
    src: '',
    playCount: 0,
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() {},
    pause() {},
    async play() { this.playCount += 1; },
    addEventListener(name, fn) { listeners.set(name, fn); },
    emit(name) { listeners.get(name)?.(); },
  };
}

/** 让微任务队列跑干净。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makePlayer({ failAt = -1, audio = fakeAudio() } = {}) {
  const fetched = [];
  const revoked = [];
  const states = [];
  const errors = [];
  let counter = 0;
  globalThis.URL.createObjectURL = () => { counter += 1; return `blob:fake-${counter}`; };
  globalThis.URL.revokeObjectURL = (url) => { revoked.push(url); };
  const player = createCloudPlayer({
    fetchAudio: async (text) => {
      const index = fetched.length;
      fetched.push(text);
      if (index === failAt) throw new Error(`第 ${index} 块合成失败`);
      return { text, index };
    },
    createAudio: () => audio,
    onState: (state) => { states.push(state); },
    onError: (error) => { errors.push(error.message); },
  });
  return { player, audio, fetched, revoked, states, errors };
}

describe('0.55：播放引擎', () => {
  it('按顺序播，并**预取下一块**', async () => {
    const { player, audio, fetched } = makePlayer();
    player.play(['一', '二', '三'], { voice: 'claire', speed: 1 });
    await tick();
    // 第一块 + 预取的第二块
    assert.deepEqual(fetched, ['一', '二']);
    assert.equal(audio.src, 'blob:fake-1');
    audio.emit('ended');
    await tick();
    assert.equal(audio.src, 'blob:fake-2');
    assert.ok(fetched.includes('三'), '第二块播的时候第三块应该已经在取了');
  });

  it('★ 一块失败就停在那里，不跳过去继续念', async () => {
    const { player, audio, fetched, errors, states } = makePlayer({ failAt: 1 });
    player.play(['一', '二', '三'], { voice: 'claire', speed: 1 });
    await tick();
    audio.emit('ended');
    await tick();
    await tick();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /第 1 块合成失败/);
    assert.equal(states[states.length - 1], 'idle');
    // 失败之后不许再往后取：跳过去继续念 = 用户听到的中间少了一段且毫无提示
    const before = fetched.length;
    audio.emit('ended');
    await tick();
    assert.equal(fetched.length, before, '失败之后还在继续取后面的块');
    assert.equal(player.active, false);
  });

  it('★ stop 之后预取的那块不许再出声', async () => {
    const { player, audio } = makePlayer();
    player.play(['一', '二'], { voice: 'claire', speed: 1 });
    await tick();
    const playedBefore = audio.playCount;
    player.stop();
    assert.equal(player.active, false);
    audio.emit('ended');
    await tick();
    assert.equal(audio.playCount, playedBefore, 'stop 之后仍然播了下一块');
    assert.equal(audio.src, '', 'stop 之后没有把 src 摘掉');
  });

  it('stop 会释放已经建好的 blob URL（不然每播一篇泄一批）', async () => {
    const { player, revoked } = makePlayer();
    player.play(['一'], { voice: 'claire', speed: 1 });
    await tick();
    assert.equal(revoked.length, 0);
    player.stop();
    assert.ok(revoked.length >= 1, 'stop 之后 blob URL 没有释放');
  });

  it('播放被拦（autoplay）时说出来，而不是静默无声', async () => {
    const audio = fakeAudio();
    audio.play = async () => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); };
    const { player, errors } = makePlayer({ audio });
    player.play(['一'], { voice: 'claire', speed: 1 });
    await tick();
    await tick();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /NotAllowedError/);
  });

  it('空块列表不启动', () => {
    const { player, audio } = makePlayer();
    player.play([], { voice: 'claire', speed: 1 });
    assert.equal(player.active, false);
    assert.equal(audio.playCount, 0);
  });
});

// ---------------------------------------------------------------------------
// 六、组件接线（纯函数表达不了的部分）
// ---------------------------------------------------------------------------

describe('0.55：界面接线', () => {
  it('阅读页的下拉里同时有云端与本机两组', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/client/ReaderPage.jsx', import.meta.url), 'utf8');
    assert.match(source, /voiceGroups\.remote/, '没有云端那一组');
    assert.match(source, /voiceGroups\.local/, '没有本机那一组');
    assert.match(source, /<optgroup label="云端/, '两组没有分开显示 —— 用户没法判断自己在花谁的钱');
    assert.match(source, /<optgroup label="本机语音/, '两组没有分开显示');
  });

  it('★ 没配 Key 时不列出云端音色（而不是列出来点了报错）', async () => {
    /* 0.76.1 起这段逻辑搬到 `article-speech.js` 的 `speechVoiceGroups`（设置页与
       阅读页共用一份）。这里守「实现里那条件还在」，**真正的行为判据**在
       `test/speech-prefs.test.mjs`：用假 voices / 假 cloud 真跑，断言 remote 为空。
       两条一起才是完整判据 —— 只留静态那条的话，把条件写反也能骗过它。 */
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/client/article-speech.js', import.meta.url), 'utf8');
    const block = /export function speechVoiceGroups\(([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    assert.ok(block.length > 0, '没找到 speechVoiceGroups 的实现（改名了？这条断言会静默失效）');
    assert.match(block, /cloud\?\.configured === true \? \(cloud\.voices \?\? SILICON_VOICES\) : \[\]/);
  });

  it('★ 设置页有「朗读」这一屏，且能写 Key', async () => {
    const { readFile } = await import('node:fs/promises');
    const page = await readFile(new URL('../src/client/SettingsPage.jsx', import.meta.url), 'utf8');
    assert.match(page, /key: 'speech', label: '朗读'/, '设置页没有朗读这一屏');
    assert.match(page, /<SpeechSettings/);
    const card = await readFile(new URL('../src/client/SpeechSettings.jsx', import.meta.url), 'utf8');
    assert.match(card, /method: 'POST'/, '没有写入 Key 的请求');
    assert.match(card, /npr-settings-changed/, '保存后没有通知阅读页重读配置 —— 用户会以为没保存成功');
    assert.match(card, /type="password"/, 'Key 输入框没有遮起来');
  });

  it('★ 宿主把朗读路由挂上了（不是只写了文件）', async () => {
    const { readFile } = await import('node:fs/promises');
    const service = await readFile(new URL('../src/host/service.js', import.meta.url), 'utf8');
    assert.match(service, /makeSpeechRoutes\(/);
    assert.match(service, /scope\.webServer\.register\(route\)/);
    assert.match(service, /speechCacheDir\(\)/);
  });
});
