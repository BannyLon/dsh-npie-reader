/**
 * 电子书「导出本节音频」——与 React 解耦的状态机 + 一层薄 hook。
 *
 * ★ 为什么按节不按本：见 `speech-export.js` 的 EXPORT_MAX_BYTES。这里的按钮
 *   永远只拿**当前这一节**的文本，没有「全书」这个入口，也不接受节数组。
 * ★ 为什么两段式（先报价、再确认）：云端合成按 UTF-8 字节计费。点一下就悄悄
 *   花掉几毛到几块、还跑几百次请求，是「按钮替用户做决定」。第一次点只算账、
 *   一个字节都不发；第二次点才真合成。
 * ★ 为什么失败后保留已合成的块：宿主缓存是内容寻址的，重跑同一段会命中缓存、
 *   不重复收费；但把整节从头再来一遍仍会白白多几百次请求。保留下来接着跑。
 *
 * ── 取消 / 下载 ────────────────────────────────────────────────────────
 *   `download()` 只在**全部块都成功之后**调用一次。取消、失败、卸载都走到
 *   return，绝不写出半个 mp3 —— 半个文件在播放器里就是「导出成功了但听不完」。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SPEECH_API_PREFIX, SPEECH_CLOUD_CHUNK, SILICON_PRICE_PER_KB, SILICON_VOICE_DEFAULT,
  parseSpeechVoice, normalizeSpeechSpeed,
} from '../speech.js';
import {
  planSpeechExport, exportQuote, concatMp3,
} from '../speech-export.js';
import { speechChunksForReading } from './article-speech.js';
import { isPronunciationEnabled } from '../speech-pronunciation.js';
import { SPEECH_VOICE_KEY, SPEECH_RATE_KEY } from './ebook-speech.js';

/**
 * 取一块音频，顺带把宿主的计费头带回来。
 *
 * ★ 不能用 `fetchCloudAudio`：它只回 Blob，把 `x-speech-billed-bytes` 丢了 ——
 *   那样导出完成后只能报「最多花多少」，报不出「实际花了多少」。
 * ★ 错误文案照样用宿主给的人话（余额不足 / Key 无效），不在这里包一层。
 */
export async function fetchExportChunk(prefix, text, { voice, speed, signal }) {
  const response = await fetch(`${prefix}/synth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, voice, speed }),
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    let message = `合成失败（HTTP ${response.status}）`;
    try {
      const body = await response.json();
      if (typeof body?.error === 'string' && body.error !== '') message = body.error;
    } catch { /* 不是 JSON，用状态码那句 */ }
    throw new Error(message);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    cached: response.headers?.get?.('x-speech-cached') === '1',
    billedBytes: Number(response.headers?.get?.('x-speech-billed-bytes')) || 0,
  };
}

/** 把拼好的字节写成一个文件。env 可注入，测试不用碰真 DOM。 */
export function downloadBytes(filename, bytes, env = {}) {
  const doc = env.document ?? globalThis.document;
  const urlApi = env.url ?? globalThis.URL;
  const BlobCtor = env.Blob ?? globalThis.Blob;
  if (!doc || !urlApi || typeof BlobCtor === 'undefined') throw new Error('当前环境不支持导出文件');
  const href = urlApi.createObjectURL(new BlobCtor([bytes], { type: 'audio/mpeg' }));
  const link = doc.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  const schedule = env.schedule ?? ((fn) => { setTimeout(fn, 0); });
  schedule(() => urlApi.revokeObjectURL(href));
  return href;
}

/** 按钮上的那句话。纯函数，UI 与测试共用一份口径。 */
export function exportHint({ phase, done = 0, total = 0 }) {
  if (phase === 'working') return `正在导出 ${done}/${total} 块 · 点一下取消`;
  if (phase === 'failed') return `导出中断，已合成 ${done}/${total} 块 · 点一下接着来`;
  // 报价已经在第一次点击时通过 notify 说全了（约 ¥X、约 N 分钟、缓存不重复收费）。
  if (phase === 'confirming') return '报价已显示 · 再点一次开始合成，现在一个字节都还没发';
  return '导出这一节为 MP3（先用云端朗读合成，点一下看报价）';
}

export function exportLabel(phase) {
  if (phase === 'working') return '取消导出';
  if (phase === 'failed') return '接着导出';
  if (phase === 'confirming') return '确认导出';
  return '导出本节';
}

/**
 * 状态机。所有外部能力都注入，测试可以真跑「取消 / 失败续跑 / 只下载一次」。
 *
 * @param options.planOf   () => plan，plan 里还要带 text / voice / speed
 * @param options.chunkOf  (text) => string[]
 * @param options.fetchChunk (text, {voice,speed,signal}) => Promise<{bytes,...}>
 */
export function createEbookExport({
  planOf, chunkOf, fetchChunk, download, notify = () => {},
  onState = () => {}, concurrency = 2,
}) {
  let phase = 'idle';
  let plan = null;
  let chunks = [];
  let done = [];
  let controller = null;
  let billedBytes = 0;
  let failure = null;
  let cancelledByUser = false;
  let disposed = false;

  const count = () => done.reduce((sum, item) => sum + (item === undefined ? 0 : 1), 0);
  const emit = (next) => { phase = next; onState(next, { done: count(), total: chunks.length }); };

  /** 第一次点击：只算账、只报价，一个请求都不发。 */
  function prepare() {
    if (disposed) return false;
    plan = planOf();
    if (!plan.ok) { notify(plan.error, true); emit('idle'); return false; }
    chunks = chunkOf(plan.text);
    if (chunks.length === 0) { notify('这一节没有可导出的正文', true); emit('idle'); return false; }
    done = new Array(chunks.length);
    billedBytes = 0;
    failure = null;
    emit('confirming');
    notify(`${exportQuote(plan)} 再点一次开始合成。`);
    return true;
  }

  /** 第二次点击（或失败后续跑）：并发合成，最后只下载一次。 */
  async function run() {
    if (disposed || phase === 'working') return;
    controller = new AbortController();
    failure = null;
    cancelledByUser = false;
    emit('working');
    let cursor = 0;

    const worker = async () => {
      while (!controller.signal.aborted && failure === null) {
        const index = cursor++;
        if (index >= chunks.length) return;
        if (done[index] !== undefined) continue; // 续跑：跳过已合成的块
        try {
          const result = await fetchChunk(chunks[index], {
            voice: plan.voice, speed: plan.speed, signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          done[index] = result.bytes ?? result;
          billedBytes += Number(result.billedBytes) || 0;
          emit('working');
        } catch (error) {
          if (controller.signal.aborted) return;
          failure = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        }
      }
    };

    const size = Math.max(1, Math.min(concurrency, chunks.length));
    await Promise.all(Array.from({ length: size }, () => worker()));
    if (disposed || cancelledByUser) return;

    if (failure !== null) {
      emit('failed');
      notify(`导出停在第 ${count()}/${chunks.length} 块：${failure.message}。`
        + '已经合成的块留着，再点一次接着来（命中的缓存不重复收费）。', true);
      return;
    }

    // ★ 全部成功才落盘；取消、失败、卸载都到不了这一行。
    const merged = concatMp3(done);
    if (merged.length === 0) {
      emit('idle');
      notify('没拿到音频字节，这次没有生成文件', true);
      return;
    }
    try {
      download(merged, plan.filename);
    } catch (error) {
      emit('idle');
      notify(`文件没存下来：${error?.message ?? String(error)}`, true);
      return;
    }
    const spent = billedBytes > 0
      ? `本次实际计费约 ¥${((billedBytes / 1000) * SILICON_PRICE_PER_KB).toFixed(2)}`
      : '全部命中本机缓存、没有产生新的费用';
    notify(`已导出 ${plan.filename}（${chunks.length} 块）· ${spent}`);
    plan = null;
    chunks = [];
    done = [];
    emit('idle');
  }

  function cancel() {
    if (phase !== 'working') return;
    cancelledByUser = true;
    controller?.abort();
    emit('idle');
    notify(`导出已取消，没有生成文件。已经合成的 ${count()} 块留着，再点一次可以从头继续。`);
  }

  function toggle() {
    if (disposed) return;
    if (phase === 'working') { cancel(); return; }
    if (phase === 'confirming' || phase === 'failed') { void run(); return; }
    prepare();
  }

  /** 翻页 / 换书 / 卸载：旧节的音频不许落到新节的文件名里。 */
  function dispose() {
    disposed = true;
    controller?.abort();
  }

  return {
    toggle, cancel, prepare, dispose,
    get phase() { return phase; },
    get progress() { return { done: count(), total: chunks.length }; },
    get billedBytes() { return billedBytes; },
  };
}

/**
 * React 薄封装。云端可用性、音色、语速都在点击那一刻现读，不锁进闭包。
 */
export function useEbookExport({ bookId, page, text, title, notify = () => {} }) {
  const storage = typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  const [phase, setPhase] = useState('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [cloudOk, setCloudOk] = useState(false);
  const latest = useRef({ page, text, title, cloudOk });
  latest.current = { page, text, title, cloudOk };
  const controllerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${SPEECH_API_PREFIX}/config`, { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : null))
        .then(body => { if (!cancelled) setCloudOk(body?.configured === true); })
        .catch(() => { if (!cancelled) setCloudOk(false); });
    };
    load();
    globalThis.addEventListener?.('npr-settings-changed', load);
    return () => { cancelled = true; globalThis.removeEventListener?.('npr-settings-changed', load); };
  }, []);

  const ensure = useCallback(() => {
    if (controllerRef.current !== null) return controllerRef.current;
    controllerRef.current = createEbookExport({
      planOf: () => {
        const now = latest.current;
        const parsed = parseSpeechVoice(storage?.getItem?.(SPEECH_VOICE_KEY) ?? '');
        const voice = parsed.engine === 'siliconflow' ? parsed.voice : SILICON_VOICE_DEFAULT;
        return {
          ...planSpeechExport(now.text, {
            title: now.title, page: now.page, cloudConfigured: now.cloudOk,
          }),
          text: now.text,
          voice,
          speed: normalizeSpeechSpeed(Number(storage?.getItem?.(SPEECH_RATE_KEY)) || 1),
        };
      },
      chunkOf: value => speechChunksForReading(
        value, SPEECH_CLOUD_CHUNK, isPronunciationEnabled(storage),
      ),
      fetchChunk: (chunk, options) => fetchExportChunk(SPEECH_API_PREFIX, chunk, options),
      download: downloadBytes,
      notify,
      onState: (next, info) => { setPhase(next); setProgress(info); },
    });
    return controllerRef.current;
  }, [notify, storage]);

  const toggle = useCallback(() => ensure().toggle(), [ensure]);

  // ★ 换书 / 翻页：旧的导出任务必须停，且控制器要重建（里面存着旧节的 plan）。
  useEffect(() => () => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    setPhase('idle');
    setProgress({ done: 0, total: 0 });
  }, [bookId, page]);

  const hint = exportHint({ phase, ...progress });
  return { phase, progress, hint, label: exportLabel(phase), toggle };
}
