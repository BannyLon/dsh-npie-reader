/**
 * 本机 Qwen3-ASR（走 Ollama）——「约 1 GB、音频不出本机」那条路（0.84.0）。
 *
 * ── 为什么是 Ollama，而不是再下一个引擎 ────────────────────────────────
 *
 * Qwen3-ASR-0.6B 的 GGUF 需要 **transcribe.cpp**（不是 whisper.cpp，也不是
 * llama.cpp），再让插件自己管第二个二进制没有必要 —— 而 Ollama 从 0.4x 起就带
 * `qwen3a` 音频投影支持，`qwen3-asr:0.6b` 正好 **1.0 GB**，本机 `ollama pull`
 * 一条命令就有。用户机器上本来就有 Ollama 时，这条路是零额外安装。
 *
 * ── 与 whisper 路线的三个硬差别（必须写进界面，不能瞒） ────────────────
 *
 * 1. **窗口 30–60 秒**：模型卡上写明「准确率在 60 秒内平稳，2 分钟开始退化」。
 *    所以这里按 30 秒切，一集 54 分钟 ≈ 108 片。
 * 2. **不返回时间戳**：Ollama 只给文本。所以段落时间由**切片起点 + 按字数比例**
 *    在片内分配（见 `splitSliceText`）。粒度是 30 秒一片 —— 点句子会跳到那一片
 *    的起点，做不到 whisper 那种逐句精度。这一点在界面上要写清楚。
 * 3. **返回文本前面带语言标记**（`language Chinese`），要去掉，否则第一句字幕里
 *    会混进一个英文词。
 *
 * ★ 切 30 秒片用 ffmpeg `-ss/-t -c copy`：WAV 是 PCM，按字节偏移切就是精确的，
 *   不需要重新编码（一集切 108 片只要一两秒）。
 */

import { basename, join } from 'node:path';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';

import { AsrError, runCapture } from './asr.js';

/** Ollama 的默认地址；设置项可改（有些人把它挂到局域网另一台机器上）。 */
export const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434';

/**
 * 推荐的模型名与体积。`sizeMb` 是下载体积，用于界面提前说「还要下多少」。
 *
 * ★ 名字带命名空间是**实测结果**，不是偏好：官方 registry 里 `qwen3-asr:0.6b`
 *   直接回 `file does not exist`（2026-11-18 本机实测），能拉下来的是社区打包的
 *   `frozenlab/qwen3-asr:0.6b`（1.0 GB，Q8_0 权重 + clip 投影）。
 * ★ 但**不写死**：`probeOllama` 认任何名字里带 `qwen3-asr` 的模型，所以用户自己
 *   拉了别的打包（或将来官方上架）也能直接用，插件只把 `name` 当「推荐值」。
 */
export const OLLAMA_ASR_MODEL = Object.freeze({
  name: 'frozenlab/qwen3-asr:0.6b',
  label: 'Qwen3-ASR 0.6B（本机，约 1.0 GB）',
  sizeMb: 1024,
});

/**
 * 拉取时按顺序试的名字。
 *
 * ★ 先试官方短名：它现在不存在，但**一条命令的成本**换「将来官方上架后自动用上
 *   正版权重」是值的；失败立刻退到社区包，用户只多等半秒。
 */
export const OLLAMA_ASR_PULL_NAMES = Object.freeze(['qwen3-asr:0.6b', OLLAMA_ASR_MODEL.name]);

/** 一片多少秒。模型卡：60 秒内准确率平稳，超过 2 分钟明显退化。取 30 秒留余量。 */
export const OLLAMA_SLICE_SECONDS = 30;

/** 探活：Ollama 起没起、模型在不在。 */
export async function probeOllama({ baseUrl = OLLAMA_DEFAULT_BASE, model = OLLAMA_ASR_MODEL.name, fetchImpl = globalThis.fetch, timeoutMs = 3_000 } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  try {
    const response = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { running: false, hasModel: false, models: [], error: `HTTP ${response.status}` };
    const payload = await response.json();
    const names = (Array.isArray(payload?.models) ? payload.models : [])
      .map((item) => String(item?.name ?? item?.model ?? ''))
      .filter((name) => name !== '');
    // 只认 ASR 模型：qwen3.5 / qwen3-embedding 都在同一个 tags 列表里，名字都带 qwen3。
    const asr = names.filter((name) => /qwen3-asr/i.test(name));
    const wanted = asr.find((name) => name === model) ?? asr[0];
    return {
      running: true,
      hasModel: wanted !== undefined,
      model: wanted ?? '',
      models: names,
      error: '',
    };
  } catch (error) {
    return { running: false, hasModel: false, models: [], error: error?.message ?? String(error) };
  }
}

/**
 * 拉模型（流式进度）。
 *
 * ★ 用 `/api/pull` 而不是让用户自己去终端 `ollama pull`：这一步的失败率很高
 *   （1 GB、国内 registry 时不常快），写在插件里才能把「下到 63% 断了」变成
 *   一个可以重试的进度条。
 */
export async function pullOllamaModel({ baseUrl = OLLAMA_DEFAULT_BASE, model = OLLAMA_ASR_MODEL.name, onProgress, fetchImpl = globalThis.fetch, signal }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const response = await fetchImpl(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal: signal ?? AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok) throw new AsrError(`拉取模型失败：HTTP ${response.status}`, 502, 'ASR_PULL');
  const reader = response.body?.getReader();
  if (!reader) throw new AsrError('拉取模型失败：响应流为空', 502, 'ASR_PULL');
  const decoder = new TextDecoder();
  let buffer = '';
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (text === '') continue;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      if (event?.error) throw new AsrError(`拉取模型失败：${event.error}`, 502, 'ASR_PULL');
      if (Number.isFinite(event?.total) && event.total > 0 && Number.isFinite(event?.completed)) {
        last = Math.min(1, event.completed / event.total);
        onProgress?.(last);
      }
    }
  }
  onProgress?.(1);
  return last;
}

/** 从整段 WAV 切一片（`-c copy`，PCM 下即字节级精确）。 */
export async function cutWavSlice({ ffmpeg, wav, startSec, seconds, outDir }) {
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, `q-${Math.round(startSec)}.wav`);
  await runCapture(ffmpeg, [
    '-nostdin', '-loglevel', 'error',
    '-ss', String(Math.max(0, Math.round(startSec))),
    '-t', String(Math.max(1, Math.round(seconds))),
    '-i', wav,
    '-c', 'copy', '-y', out,
  ], { timeoutMs: 120_000 });
  const info = await stat(out).catch(() => null);
  if (info === null || info.size < 2000) throw new AsrError('切片失败（这一片没有音频）', 422, 'ASR_EMPTY_AUDIO');
  return out;
}

/** 去掉模型输出前面的语言标记与噪音。 */
export function cleanQwenText(raw) {
  let text = String(raw ?? '').trim();
  /**
   * 实测输出（2026-11-18，frozenlab/qwen3-asr:0.6b）：
   *   `language Chinese<asr_text>今天我们来聊聊人工智能的未来。`
   * —— 语言标记与正文之间是 `<asr_text>` 这个 literal 分隔符，不是换行。
   * 只按 `language Xxx\n` 剥的话，第一句字幕里会混进 `language Chinese<asr_text>`。
   * 所以先按分隔符切，再退回两种宽松写法。
   */
  const marked = /^language\s*[:：]?\s*[A-Za-z\u4e00-\u9fa5-]{2,20}\s*<asr_text>/i.exec(text);
  if (marked) {
    text = text.slice(marked[0].length);
  } else {
    text = text
      .replace(/^language\s*[:：]?\s*[A-Za-z\u4e00-\u9fa5-]{2,20}\s*\n?/i, '')
      .replace(/^<asr_text>/i, '');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 片内按句子切分并分配时间。
 *
 * ★ 没有真实时间戳时，**按字数比例**分配是唯一不骗人的做法：它保证「靠前的句子
 *   时间靠前」，误差被限制在片长（30 秒）之内。如果整片给一段，点句跳转只能在
 *   片头落点，30 秒的片子里几乎等于「点了就重听这一片」。
 * ★ 只按中英文句末标点切，不按逗号：口播里逗号太密，切出来会是两三个字的碎片，
 *   时间戳反而更不准。
 */
export function splitSliceText(text, { start, end, maxCues = 40 }) {
  const clean = String(text ?? '').trim();
  if (clean === '') return [];
  const sentences = clean
    .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z""])/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const pieces = sentences.length > 0 ? sentences : [clean];
  const totalChars = pieces.reduce((sum, piece) => sum + [...piece].length, 0) || 1;
  const span = Math.max(1, end - start);
  const out = [];
  let cursor = start;
  for (const piece of pieces.slice(0, maxCues)) {
    const share = ([...piece].length / totalChars) * span;
    const from = cursor;
    const to = Math.min(end, from + Math.max(0.6, share));
    out.push({ start: Math.round(from * 10) / 10, end: Math.round(to * 10) / 10, text: piece });
    cursor = to;
  }
  return out;
}

/**
 * 识别一片。
 *
 * ★ `images` 字段传 base64 的 WAV：Ollama 的音频接口复用了视觉接口的字段名
 *   （模型带 audio projector）。这不是「误用」—— 官方模型卡给的示例就是这样。
 * ★ `content` 必须是空串：给了提示词，有些版本会把提示词当问题去回答。
 */
export async function transcribeSliceOllama({
  baseUrl = OLLAMA_DEFAULT_BASE,
  model = OLLAMA_ASR_MODEL.name,
  wavPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
  signal,
}) {
  const buffer = await readFile(wavPath);
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0 },
      messages: [{ role: 'user', content: '', images: [buffer.toString('base64')] }],
    }),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new AsrError(`本机识别失败（Ollama HTTP ${response.status}）：${raw.slice(0, 200)}`, 502, 'ASR_OLLAMA');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AsrError('Ollama 返回的不是 JSON（版本可能太旧，不认音频输入）', 502, 'ASR_OLLAMA');
  }
  if (payload?.error) throw new AsrError(`本机识别失败：${payload.error}`, 502, 'ASR_OLLAMA');
  return cleanQwenText(payload?.message?.content ?? payload?.response ?? '');
}

/** 临时切片文件名（识别完就删，一集 108 片 × 960 KB ≈ 100 MB）。 */
export function slicePathIn(dir, startSec) {
  return join(dir, `q-${Math.round(startSec)}.wav`);
}

export async function dropSlice(path) {
  await unlink(path).catch(() => undefined);
}

/** 给日志用：`/a/b/c.wav` → `c.wav`。 */
export const sliceName = (path) => basename(String(path ?? ''));
