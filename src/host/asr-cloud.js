/**
 * 云端语音识别（0.84.0）：本机跑不动 / 想省时间 / 想要更准的时候走这条。
 *
 * ── 为什么是「一套代码 + 三个预设」，不是四份实现 ────────────────────
 *
 * Groq、硅基流动、OpenAI 的转写接口都是 **OpenAI 兼容**的
 * `POST {base}/audio/transcriptions`（multipart，`response_format=verbose_json`
 * 会带回分段与时间戳）。差异只有 base、model 名、和体积上限 —— 那是**配置**，
 * 不是代码。写成四份的话，改一处超时/重试就得改四遍，而漏一处只会表现为
 * 「某一家偶尔卡住」。
 *
 * 豆包（火山引擎）是**私有协议**（openspeech v3 异步 submit/query），所以单独
 * 一条适配器。★ 它在本机没有凭证、无法实测 —— 代码照官方协议写，失败时把
 * 服务端回的状态码与消息原样带出来（而不是吞成「识别失败」），这样用户/我们能
 * 一眼看出是凭证错、额度错、还是音频格式不支持。
 *
 * ── 为什么要先切片再上传 ──────────────────────────────────────────────
 *
 * 一集 54 分钟的播客按 48 kbps 单声道 mp3 算 ≈ 19 MB，勉强卡在 25 MB 线下；
 * 两小时的集子必然超。所以统一按 10 分钟切（≈3.6 MB/片），既稳定在线下，也让
 * 每一片都有独立的进度与失败重试点。时间戳 = 片内偏移 + 片起点（片起点是精确的
 * 整数，不需要回头读音频时长）。
 */

import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { AsrError, runCapture } from './asr.js';

/**
 * 云端识别服务目录。
 *
 * `kind`：`openai` = OpenAI 兼容转写；`doubao` = 火山 openspeech v3。
 * `hint`：设置页里那一行小字，写清「key 从哪来」「模型名是什么」。
 */
export const CLOUD_ASR_PROVIDERS = Object.freeze([
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai',
    base: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    hint: '有免费额度，速度快；key 在 console.groq.com 拿',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    kind: 'openai',
    base: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    models: ['FunAudioLLM/SenseVoiceSmall', 'FunAudioLLM/SenseVoiceLarge'],
    hint: '国内直连，中文口播识别好；key 在 cloud.siliconflow.cn 拿',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    base: 'https://api.openai.com/v1',
    model: 'whisper-1',
    models: ['whisper-1', 'gpt-4o-transcribe'],
    hint: 'whisper-1 带分段与时间戳；gpt-4o-transcribe 更准但只回整段文本',
  },
  {
    id: 'doubao',
    name: '豆包（火山引擎）',
    kind: 'doubao',
    base: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel',
    model: 'bigmodel',
    models: ['bigmodel'],
    hint: '要 App ID + Access Token（控制台「语音技术」里开通）；音频由火山自己下载，需公网可访问',
  },
  {
    id: 'custom',
    name: '自建 / 其它兼容 OpenAI 的服务',
    kind: 'openai',
    base: '',
    model: 'whisper-1',
    models: [],
    hint: '填 base 地址（到 /v1 为止）与模型名；本地 whisper.cpp server 也算',
  },
]);

/** 每片多少秒。10 分钟 ≈ 3.6 MB（48 kbps 单声道），稳在 25 MB 门槛下。 */
export const CLOUD_SLICE_SECONDS = 10 * 60;

export function cloudProviderOf(id) {
  return CLOUD_ASR_PROVIDERS.find((item) => item.id === id) ?? undefined;
}

/**
 * 从远端地址切出 mp3 分片。
 *
 * ★ `-f segment` 由 ffmpeg 自己按时长切，比「算好 offset 再逐片 ffmpeg」少 N 次
 *   网络定位；`-reset_timestamps 1` 让每片从 0 开始（有些服务按绝对时间算分段，
 *   不从 0 开始时会返回一堆起点为负数的时间戳）。
 * ★ 48 kbps 单声道：语音识别不需要更高。128 kbps 的一小时音频是 55 MB，
 *   直接被 25 MB 门槛拒掉，而降到 48 kbps 后识别质量没有可见差别。
 */
export async function sliceAudioForUpload({ ffmpeg, url, dir, secondsPer = CLOUD_SLICE_SECONDS, signal }) {
  if (ffmpeg === '') throw new AsrError('云端识别也要 ffmpeg（切片用）：brew install ffmpeg', 501, 'ASR_NO_FFMPEG');
  await mkdir(dir, { recursive: true });
  const pattern = join(dir, 'part-%03d.mp3');
  await runCapture(ffmpeg, [
    '-nostdin', '-loglevel', 'error',
    '-i', url,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k',
    '-f', 'segment', '-segment_time', String(secondsPer), '-reset_timestamps', '1',
    '-y', pattern,
  ], { signal, timeoutMs: 30 * 60 * 1000 });
  const names = (await readdir(dir)).filter((name) => /^part-\d+\.mp3$/.test(name)).sort();
  return names.map((name, index) => ({ path: join(dir, name), offsetSec: index * secondsPer }));
}

/** 清掉切片（10 分钟一片，两小时的集子有 12 片 × 3.6 MB）。 */
export async function dropSlices(parts) {
  for (const part of Array.isArray(parts) ? parts : []) {
    await unlink(part.path).catch(() => undefined);
  }
}

/**
 * OpenAI 兼容的转写。返回**全局**时间轴的分段。
 *
 * ★ `verbose_json` 是唯一能拿到 `segments` 的格式；`json` 只回整段文本，
 *   `text` 更方便但没有时间轴 —— 没有时间轴，字幕就没法点句跳转。
 *   所以默认只要 `verbose_json`，拿不到分段时退化成「整片一段」并在返回里标
 *   `degraded: true`（界面据此说「这一家只回了整段文本」）。
 */
export async function transcribeOpenAiCompatible({
  base, apiKey, model, filePath, offsetSec = 0, language = '', fetchImpl = globalThis.fetch, timeoutMs = 180_000, signal,
}) {
  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  if (language !== '') form.append('language', language);

  const response = await fetchImpl(`${String(base).replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new AsrError(`云端识别失败（HTTP ${response.status}）：${summarizeError(raw)}`, 502, 'ASR_CLOUD');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AsrError('云端识别返回的不是 JSON（服务地址可能填错了）', 502, 'ASR_CLOUD');
  }
  const segments = [];
  const list = Array.isArray(payload?.segments) ? payload.segments : [];
  for (const item of list) {
    const text = String(item?.text ?? '').trim();
    if (text === '') continue;
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!Number.isFinite(start)) continue;
    segments.push({ start: offsetSec + Math.max(0, start), end: offsetSec + (Number.isFinite(end) ? end : start + 2), text });
  }
  if (segments.length === 0) {
    const whole = String(payload?.text ?? '').trim();
    if (whole === '') throw new AsrError('云端识别返回了空文本（音频可能是纯音乐/静音）', 422, 'ASR_EMPTY');
    // 没有分段：整片给一段，起点是片偏移。界面还能跳，只是粒度粗。
    segments.push({ start: offsetSec, end: offsetSec + CLOUD_SLICE_SECONDS, text: whole });
    return { segments, degraded: true };
  }
  return { segments, degraded: false };
}

/**
 * 豆包（火山 openspeech v3）：submit → 轮询 query。
 *
 * ★ 它**直接吃音频 URL**，不接收上传的文件 —— 所以这条路上不需要切片，也不需要
 *   ffmpeg。对 54 分钟的集子反而更快（一次提交）。
 * ★ 需要 `X-Api-App-Key`（App ID）、`X-Api-Access-Key`（Access Token）、
 *   `X-Api-Resource-Id`。用户在设置里把 App ID 与 Token 用 `:` 连起来填一个字段，
 *   这里拆开 —— 少一个输入框，也少一次填错的机会。
 */
export async function transcribeDoubao({
  base, appKey, accessKey, audioUrl, fetchImpl = globalThis.fetch, timeoutMs = 600_000, pollMs = 2_000, signal,
}) {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}`;
  const headers = {
    'content-type': 'application/json',
    'x-api-app-key': appKey,
    'x-api-access-key': accessKey,
    'x-api-resource-id': 'volc.bigasr.auc',
    'x-api-request-id': requestId,
  };
  const submit = await fetchImpl(`${base}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user: { uid: 'dsh-npie-reader' }, audio: { url: audioUrl, format: 'mp3' }, request: { model_name: 'bigmodel' } }),
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  const submitText = await submit.text();
  const status = submit.headers.get('x-api-status-code') ?? '';
  if (!submit.ok || (status !== '' && status !== '20000000')) {
    throw new AsrError(`豆包提交失败（HTTP ${submit.status}${status ? ` / ${status}` : ''}）：${summarizeError(submitText)}`, 502, 'ASR_CLOUD');
  }
  const taskId = submit.headers.get('x-api-task-id')
    ?? (() => { try { return JSON.parse(submitText)?.audio_info?.task_id ?? ''; } catch { return ''; } })();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new AsrError('已停止', 499, 'ASR_CANCELLED');
    if (Date.now() > deadline) throw new AsrError('豆包识别超时（音频可能过长或队列拥堵）', 504, 'ASR_TIMEOUT');
    const query = await fetchImpl(`${base}/query`, {
      method: 'POST',
      headers: { ...headers, 'x-api-task-id': taskId },
      body: JSON.stringify({ task_id: taskId }),
      signal: signal ?? AbortSignal.timeout(60_000),
    });
    const text = await query.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const code = query.headers.get('x-api-status-code') ?? '';
    if (query.ok && (code === '20000000' || payload?.result)) {
      const segments = readDoubaoUtterances(payload);
      if (segments.length > 0) return { segments, degraded: false };
      const whole = String(payload?.result?.text ?? payload?.text ?? '').trim();
      if (whole !== '') return { segments: [{ start: 0, end: 0, text: whole }], degraded: true };
      throw new AsrError('豆包返回了空结果（音频可能是纯音乐/静音）', 422, 'ASR_EMPTY');
    }
    // 20000001/20000002 是「处理中」。其它状态码直接报出来，别让用户等到超时。
    if (code !== '' && code !== '20000001' && code !== '20000002') {
      throw new AsrError(`豆包识别失败（${code}）：${summarizeError(text)}`, 502, 'ASR_CLOUD');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** 豆包的分段字段叫 `utterances`，毫秒。 */
function readDoubaoUtterances(payload) {
  const list = payload?.result?.utterances ?? payload?.utterances ?? [];
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = String(item?.text ?? '').trim();
    if (text === '') continue;
    const start = Number(item?.start_time);
    const end = Number(item?.end_time);
    if (!Number.isFinite(start)) continue;
    out.push({
      start: Math.max(0, start / 1000),
      end: Math.max(0, (Number.isFinite(end) ? end : start + 2000) / 1000),
      text,
    });
  }
  return out;
}

/** 服务端的错误体常常是一大段 JSON；截前 300 字，留给界面一行显示。 */
function summarizeError(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '（服务端没有返回内容）';
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof message === 'string' && message !== '') return message.slice(0, 300);
  } catch {
    // 不是 JSON，原样截断。
  }
  return text.slice(0, 300);
}
