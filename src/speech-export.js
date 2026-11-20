/**
 * 按节导出 MP3 的共用层纯函数（零 Node 依赖，浏览器半区也能跑）。
 *
 * ★ 为什么是 Uint8Array 而不是 Buffer：拼接发生在**浏览器半区** —— 音频块是
 *   `/speech/synth` 回的 Blob，宿主缓存就在那台机器上，逐块请求能直接命中、
 *   不再计费；把字节搬回宿主再拼反而多一次 IPC。
 *
 * ★ 拼接算法参考 shuting（MIT，Copyright (c) 2026 Zanbin Xu）的
 *   `src/core/mp3.ts`，只搬「剥 ID3 + 按比特位找同步头 + 原样相接」这条判据，
 *   没搬它的整本一键导出（见 planSpeechExport 的上限）。
 *
 * ── 「无损」的确切含义 ────────────────────────────────────────────────
 *   不重新编码，不插静音，不改采样率：每块只去掉首尾元数据，剩下的 MPEG
 *   帧按原顺序字节相接，等价于 ffmpeg 的 concat demuxer。所以判据不是
 *   「听起来差不多」，而是「拼接结果字节数 === 各块纯帧字节数之和」。
 */

import { SILICON_PRICE_PER_KB, estimateSpeechCost, speechBytes } from './speech.js';

/**
 * 单次导出的字节上限：36 KB ≈ 12000 汉字 ≈ 1.8 元 / 约 50 分钟语音。
 *
 * ★ 这是「按章不按本」的硬门，不是性能优化。shuting 用免费 edge-tts 可以
 *   一键整本；这里按 UTF-8 字节计费，19 万汉字要 28.5 元、633 次请求、
 *   串行 10–30 分钟 —— 一个「导出全书」按钮等于替用户花钱还关不掉。
 *   超过上限时明确拒绝，让用户换一节或分段导出。
 */
export const EXPORT_MAX_BYTES = 36 * 1024;

/** 时长估算用的中文朗读速度（字/分钟）。只用于事前告知，不是音频元数据。 */
export const CHARS_PER_MINUTE = 240;

/** 句子标点不算小数点 / IP / 版本号：ASCII 句末要求「前非数字 + 后空白或行尾」。 */
export function safeFileName(title, page) {
  const base = String(title ?? '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 40) || '电子书';
  const n = Number.isInteger(page) && page > 0 ? page : 1;
  return `${base}-第${n}节.mp3`;
}

/**
 * 导出前的**唯一**计划入口：把「能不能导、最多花多少、大概多久、存成什么名」
 * 一次算清。调用方必须把 `error` 原话交给用户，不许 `catch(() => {})` 吞掉。
 *
 * @returns {{ ok: boolean, error: string, bytes: number, chars: number,
 *   cost: number, minutes: number, filename: string }}
 */
export function planSpeechExport(text, {
  title = '', page = 1, cloudConfigured = false,
  maxBytes = EXPORT_MAX_BYTES, pricePerKb = SILICON_PRICE_PER_KB,
} = {}) {
  const source = String(text ?? '');
  const bytes = speechBytes(source);
  const chars = [...source.replace(/\s/g, '')].length;
  const empty = {
    ok: false, bytes, chars, cost: 0, minutes: 0, filename: safeFileName(title, page),
  };
  if (source.trim() === '') return { ...empty, error: '这一节没有可导出的正文' };
  if (!cloudConfigured) {
    return { ...empty, error: '导出音频要用云端朗读。先到「设置 → 朗读」填一个硅基流动的 API Key。' };
  }
  if (bytes > maxBytes) {
    const kb = Math.round(bytes / 1024);
    const limitKb = Math.round(maxBytes / 1024);
    return {
      ...empty,
      error: `这一节有 ${kb} KB 正文，超过单次导出的 ${limitKb} KB 上限。`
        + '请只导出当前这一节，别一次导出整本书（按字节计费，整本要几十块钱和几百次请求）。',
    };
  }
  const cost = pricePerKb === SILICON_PRICE_PER_KB
    ? estimateSpeechCost(source)
    : (bytes / 1000) * pricePerKb;
  return {
    ok: true, error: '', bytes, chars, cost,
    minutes: Math.max(1, Math.ceil(chars / CHARS_PER_MINUTE)),
    filename: safeFileName(title, page),
  };
}

/** 事前告知的那句话。已缓存段落不重复计费，所以写「最多」而不是「将扣」。 */
export function exportQuote(plan) {
  const money = plan.cost < 0.01 ? '不到 1 分钱' : `约 ¥${plan.cost.toFixed(2)}`;
  return `导出这一节：最多 ${money}、约 ${plan.minutes} 分钟的语音，${plan.chars} 字。`
    + '已听过的段落会命中本机缓存，不重复收费。';
}

/* ── MP3 拼接 ────────────────────────────────────────────────────────── */

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

/**
 * 找 MPEG 帧同步头。
 *
 * ★ 必须按**比特位**判：帧头是 11 个 1，第二个字节只有高 3 位参与同步；
 *   只判 `buf[i+1] === 0xff` 会漏掉合法帧，只判 0xff 又会把 ID3 里的
 *   任意字节当同步点。再校验版本/层/码率/采样率，排除伪同步。
 */
export function findFrameSync(buf, offset = 0) {
  const bytes = asBytes(buf);
  for (let i = Math.max(0, offset); i + 2 < bytes.length; i += 1) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 0x03;
    const layer = (bytes[i + 1] >> 1) & 0x03;
    const bitrate = (bytes[i + 2] >> 4) & 0x0f;
    const sampleRate = (bytes[i + 2] >> 2) & 0x03;
    if (version === 1 || layer === 0) continue;
    if (bitrate === 0 || bitrate === 0x0f || sampleRate === 3) continue;
    return i;
  }
  return -1;
}

/** ID3v2 头长度（同步安全整数：每字节只用低 7 位），没有则 0。 */
export function skipId3v2(buf) {
  const bytes = asBytes(buf);
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14)
    | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0;
  return Math.min(bytes.length, 10 + size + footer);
}

/** 剁掉尾部 128 字节 ID3v1（以 TAG 开头）。 */
export function trimId3v1(buf) {
  const bytes = asBytes(buf);
  if (bytes.length >= 128) {
    const at = bytes.length - 128;
    if (bytes[at] === 0x54 && bytes[at + 1] === 0x41 && bytes[at + 2] === 0x47) {
      return bytes.subarray(0, at);
    }
  }
  return bytes;
}

/** 取一块 MP3 的纯音频帧（首尾元数据剥掉，中间的 Xing/Info 帧保留）。 */
export function extractAudioFrames(buf) {
  const bytes = asBytes(buf);
  const start = findFrameSync(bytes, skipId3v2(bytes));
  if (start < 0) return new Uint8Array(0);
  return trimId3v1(bytes.subarray(start));
}

/**
 * 无损拼接。全部块都没解析出帧时退化为原样相接 —— 至少不丢数据。
 *
 * @param {Array<Uint8Array|ArrayBuffer>} parts
 * @returns {Uint8Array}
 */
export function concatMp3(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const frames = list.map(extractAudioFrames);
  const kept = frames.filter(part => part.length > 0);
  const source = kept.length > 0 ? kept : list.map(asBytes);
  const total = source.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of source) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * 粗扫帧数与首个同步位置，供拼接结果自检。
 * ★ 近似值：按同步头而不是逐帧长度跳，帧数据里恰好出现 0xff 时会多算；
 *   只用来判「有没有把标签夹进音频流」，不拿来当时长。
 */
export function scanMp3(buf) {
  const bytes = asBytes(buf);
  const firstSyncAt = findFrameSync(bytes, skipId3v2(bytes));
  if (firstSyncAt < 0) return { frames: 0, firstSyncAt };
  let pos = firstSyncAt;
  let frames = 0;
  while (pos + 2 < bytes.length) {
    const next = findFrameSync(bytes, pos + 1);
    if (next < 0) break;
    frames += 1;
    pos = next;
  }
  return { frames, firstSyncAt };
}
