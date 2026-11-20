/**
 * 两个「外挂引擎」的纯逻辑：Google 翻译的批量与降级、Qwen3-ASR 的输出清洗与时间分配。
 *
 * 这两段代码的共同风险是**静默错位**：翻译按行号分配、字幕按字数分时间 —— 一旦
 * 算错，界面上全是正常的中文句子，只有逐句对照原文才看得出来。所以每一条都要
 * 有反向对照（坏输入必须落到「不猜」的那一支）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GOOGLE_ENDPOINTS,
  groupForGoogle,
  parseGoogleTranslate,
  probeGoogleTranslate,
  translateWithGoogle,
} from '../src/host/google-translate.js';
import {
  cleanQwenText,
  probeOllama,
  splitSliceText,
} from '../src/host/asr-ollama.js';

/** 造一个「按端点与 q 参数给不同响应」的假 fetch。 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, body: options.body });
    return handler(url, options, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const okJson = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
const gtx = (...texts) => okJson([texts.map((text) => [text, '', null, null, 10])]);

test('parseGoogleTranslate 只取译文，按句拼回多行', () => {
  // gtx 的真实形状是**两层**：payload[0] 才是块数组，块里第 0 项是译文。
  assert.equal(
    parseGoogleTranslate([[['第一句', 'a', null, null, 10], ['第二句', 'b', null, null, 10]]]).replace(/\n/g, '|'),
    '第一句|第二句',
  );
  // ★ 反向对照：只给一层（少包一层数组）时必须给空串 —— 这正是老版本按「一层」
  //   解析会踩的坑：拿到的是块数组元素本身，拼出来是一堆原文碎片。
  assert.equal(parseGoogleTranslate([['第一句', 'a'], ['第二句', 'b']]), '');
  assert.equal(parseGoogleTranslate(null), '');
  assert.equal(parseGoogleTranslate([null]), '');
});

test('groupForGoogle 按预算切批，超长段单独成批', () => {
  const groups = groupForGoogle(['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)], 25);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].indexes, [0, 1]);
  assert.deepEqual(groups[1].indexes, [2]);

  // 超长（> SINGLE_ITEM_CHARS = 1800）的那段不跟别人拼（拼了会被截断），
  // 而且**下标不能丢** —— 丢了就意味着这段译文会被写到别的段落上。
  const long = groupForGoogle(['x'.repeat(1900), 'y'], 1200);
  assert.deepEqual(long[0].indexes, [0]);
  assert.deepEqual(long[1].indexes, [1]);
});

test('Google 可达：一批两段只发一次请求，译文按段落位', async () => {
  const fetchImpl = fakeFetch(() => gtx('你好', '世界'));
  const result = await translateWithGoogle(['hello', 'world'], { fetchImpl });
  // 两段拼成一次请求、回来两行 ⇒ 按行号一一落位（不是拼成一条给第一段）。
  assert.deepEqual(result.texts, ['你好', '世界']);
  assert.equal(result.requests, 1);
  assert.equal(result.reachable, true);
});

test('Google 不可达：不抛错、不空转，把 reachable 交回去', async () => {
  const fetchImpl = fakeFetch(() => { throw new TypeError('fetch failed'); });
  const result = await translateWithGoogle(['a', 'b', 'c'], { fetchImpl, timeoutMs: 50 });
  assert.equal(result.reachable, false);
  assert.equal(result.requests, 0, '一个请求都没成功，就不该继续发剩下的');
  assert.deepEqual(result.texts, ['', '', '']);
  assert.ok(result.failed.length === 3);
});

test('第一个端点 500、第二个端点正常：要自动换端点', async () => {
  const fetchImpl = fakeFetch((url) => (url === GOOGLE_ENDPOINTS[0]
    ? { ok: false, status: 500, text: async () => '' }
    : gtx('译文')));
  const result = await translateWithGoogle(['hello'], { fetchImpl });
  assert.equal(result.reachable, true);
  assert.equal(result.texts[0], '译文');
});

test('返回行数对不上时不硬塞，改为逐段重发', async () => {
  // 第一次把两行合成一行（Google 偶尔会这样）；后面逐段请求各回一行。
  const fetchImpl = fakeFetch((url, options, count) => {
    const q = String(options?.body ?? '');
    if (count === 1) return gtx('合并成一行');
    if (q.includes('alpha')) return gtx('甲');
    if (q.includes('beta')) return gtx('乙');
    return gtx('?');
  });
  const result = await translateWithGoogle(['alpha', 'beta'], { fetchImpl, concurrency: 1 });
  assert.deepEqual(result.texts, ['甲', '乙']);
});

test('空响应也算不可用（不是「翻译成空串」）', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, text: async () => '' }));
  const result = await translateWithGoogle(['a'], { fetchImpl });
  assert.equal(result.reachable, false);
  assert.equal(result.texts[0], '');
});

test('probeGoogleTranslate 给设置页一个明确结论（不抛）', async () => {
  const blocked = await probeGoogleTranslate({ fetchImpl: fakeFetch(() => { throw new TypeError('fetch failed'); }) });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.error.length > 0);
  const good = await probeGoogleTranslate({ fetchImpl: fakeFetch(() => gtx('你好')) });
  assert.equal(good.ok, true);
  assert.equal(good.text, '你好');
});

test('cleanQwenText 去掉 language 标记与 <asr_text> 分隔符', () => {
  // 实测输出（2026-11-18）。
  assert.equal(cleanQwenText('language Chinese<asr_text>今天我们来聊聊。'), '今天我们来聊聊。');
  assert.equal(cleanQwenText('language Chinese\n今天我们来聊聊。'), '今天我们来聊聊。');
  assert.equal(cleanQwenText('Language: English\nHello there.'), 'Hello there.');
  assert.equal(cleanQwenText('<asr_text>直接就是正文'), '直接就是正文');
  // ★ 反向对照：正文里本来就有 `language` 这个词时，不许把它当标记切掉。
  assert.equal(cleanQwenText('我们在聊 language model 的规模'), '我们在聊 language model 的规模');
});

test('splitSliceText 按句切，时间单调不减且不出片', () => {
  const cues = splitSliceText('第一句。第二句！第三句？', { start: 30, end: 60 });
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 30);
  assert.equal(cues[cues.length - 1].end, 60);
  for (let index = 1; index < cues.length; index += 1) {
    assert.ok(cues[index].start >= cues[index - 1].start - 1e-9, '时间不能倒退');
  }
  for (const cue of cues) {
    assert.ok(cue.start >= 30 && cue.end <= 60, `越界：${cue.start}-${cue.end}`);
    assert.ok(cue.text.length > 0);
  }
});

test('splitSliceText 对没有标点的整段也要给一条（不许丢内容）', () => {
  const cues = splitSliceText('一整句没有标点的话', { start: 0, end: 30 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, '一整句没有标点的话');
  assert.equal(splitSliceText('   ', { start: 0, end: 30 }).length, 0);
});

test('probeOllama 只认 qwen3-asr，不把 qwen3.5 当成识别模型', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: [{ name: 'qwen3.5:9b' }, { name: 'qwen3-embedding:0.6b' }] }),
  });
  const without = await probeOllama({ fetchImpl });
  assert.equal(without.running, true);
  assert.equal(without.hasModel, false);

  const withAsr = await probeOllama({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'qwen3.5:9b' }, { name: 'frozenlab/qwen3-asr:0.6b' }] }),
    }),
  });
  assert.equal(withAsr.hasModel, true);
  assert.equal(withAsr.model, 'frozenlab/qwen3-asr:0.6b');
});

test('Ollama 没起来时说 running=false（而不是抛）', async () => {
  const result = await probeOllama({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(result.running, false);
  assert.equal(result.hasModel, false);
  assert.ok(result.error.length > 0);
});
