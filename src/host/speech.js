/**
 * 云端朗读的**合成器**（宿主半区）。
 *
 * 为什么合成必须在宿主做，而不是在渲染进程直接 `fetch('https://api.siliconflow.cn/…')`：
 *
 *   1. **API Key 不该进渲染进程**。它是计费凭证，一旦出现在浏览器侧，就同时出现在
 *      DevTools 的 Network 面板、任何一次 `console.log(localStorage)`、以及
 *      页面里任何一个第三方脚本的作用域里。
 *   2. **跨域**。`api.siliconflow.cn` 不会为 `dsh-app://app` 这个自定义协议开 CORS，
 *      渲染进程直接发会被预检挡掉（而且报的是「网络错误」，看不出是 CORS）。
 *   3. **缓存要落盘**。同一篇文章重听、暂停后继续、切换语速再切回来，都会重复请求；
 *      按「音色 + 语速 + 文本」做内容寻址缓存，第二次起零成本。
 *
 * ★ 这个模块**不认识 HTTP**：它只做「给我文本，给你 mp3 字节」。路由、鉴权栅栏、
 *   body 解析都在 `speech-routes.js`。这样 `test/speech.test.mjs` 能用注入的假
 *   fetch 把「401 怎么报」「命中缓存还发不发请求」真的跑出来，而不是读源码猜。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SILICON_ENDPOINT, SILICON_MODEL, SPEECH_CHUNK_MAX,
  normalizeSiliconVoice, normalizeSpeechSpeed, siliconVoiceParam, speechBytes,
} from '../speech.js';

/** 合成请求的超时。云端 TTS 一段 300 字通常 1–3 秒，60 秒是「明显卡死」的界线。 */
const SYNTH_TIMEOUT_MS = 60_000;

/** 缓存目录的体积上限。一篇 3000 字的文章约 0.8–1.5 MB，128 MB 约合 100 篇。 */
export const SPEECH_CACHE_MAX_BYTES = 128 * 1024 * 1024;

/** 缓存文件保留天数：再久没听过的，重合成一次也不心疼。 */
const SPEECH_CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * 带机器可读 `code` 的错误。
 *
 * ★ 为什么不是 `throw new Error('…')`：路由层要按错误类型给不同的 HTTP 状态码
 *   （没填 Key 是 400、Key 无效是 401、余额不足是 402）。靠匹配中文字符串来决定
 *   状态码，改一个字的文案就会静默变成 500。
 */
export class SpeechError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
    this.status = status;
  }
}

/** 缓存文件名：模型 + 音色 + 语速 + 文本的 sha1。 */
function cacheKeyOf({ model, voice, speed, text }) {
  return createHash('sha1').update(`${model}\u0000${voice}\u0000${speed}\u0000${text}`, 'utf8').digest('hex');
}

/** 云端返回的状态码 → 用户看得懂的话 + 机器可读的 code。 */
function describeHttpError(status, bodyText) {
  const detail = String(bodyText ?? '').trim().slice(0, 200);
  if (status === 401) return new SpeechError('API Key 无效或已过期。到硅基流动控制台重新复制一个，填进插件设置。', 'BAD_KEY', 401);
  if (status === 402) return new SpeechError('硅基流动账户余额不足，充值后再试。', 'NO_BALANCE', 402);
  if (status === 403) return new SpeechError('这个 Key 没有语音合成权限（多半是还没实名认证）。', 'FORBIDDEN', 403);
  if (status === 429) return new SpeechError('请求太频繁了，等几秒再点。', 'RATE_LIMITED', 429);
  if (status >= 500) return new SpeechError(`硅基流动服务端出错（HTTP ${status}），稍后重试。`, 'UPSTREAM', 502);
  return new SpeechError(`合成失败（HTTP ${status}）${detail ? `：${detail}` : ''}`, 'UPSTREAM', 502);
}

/**
 * 建一个合成器。
 *
 * @param {{
 *   getApiKey: () => string,
 *   cacheDir: string,
 *   log?: (message: string) => void,
 *   fetchImpl?: typeof fetch,
 * }} deps
 *   `getApiKey` 是**函数**而不是字符串：用户在设置页填完 Key 之后必须立刻生效，
 *   传值的话要重启插件才行（而设置页会显示「已保存」，于是这是个静默的假象）。
 */
export function createSpeechSynth({ getApiKey, cacheDir, log = () => {}, fetchImpl = globalThis.fetch }) {
  /** 同一段文本正在合成时，第二个请求挂到同一个 Promise 上，不重复计费。 */
  const inflight = new Map();

  async function cachePath(key) {
    return join(cacheDir, `${key}.mp3`);
  }

  async function readCache(key) {
    try {
      const bytes = await readFile(await cachePath(key));
      // 0 字节的缓存文件是「上次写到一半进程被杀」的残骸，当成没有
      return bytes.length > 0 ? bytes : null;
    } catch {
      return null;
    }
  }

  async function writeCache(key, bytes) {
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(await cachePath(key), bytes);
    } catch (error) {
      // ★ 缓存写失败**不能**让这次朗读失败：音频已经拿到了，用户要的是声音，
      //   不是「缓存目录可写」这个性质。
      log(`[朗读] 写缓存失败（不影响本次播放）：${error?.message ?? error}`);
    }
  }

  /**
   * 合成一段文本。
   *
   * @param {{ text: string, voice?: string, speed?: number }} request
   * @returns {Promise<{ bytes: Buffer, mime: string, cached: boolean, bytesBilled: number }>}
   */
  async function synthesize(request) {
    const text = String(request?.text ?? '').trim();
    if (text === '') throw new SpeechError('这段没有可朗读的文本', 'EMPTY_TEXT', 400);
    if (text.length > SPEECH_CHUNK_MAX) {
      // ★ 拒掉而不是截断：截断后用户听到的是「念到一半没了」，且没有任何提示，
      //   他会以为是文章本身不完整。
      throw new SpeechError(`一次最多合成 ${SPEECH_CHUNK_MAX} 字，这段有 ${text.length} 字`, 'TEXT_TOO_LONG', 400);
    }
    const apiKey = String(getApiKey() ?? '').trim();
    if (apiKey === '') {
      throw new SpeechError('还没填硅基流动的 API Key。到「设置 → 朗读」里填一个。', 'NO_KEY', 400);
    }
    const voice = normalizeSiliconVoice(request?.voice);
    const speed = normalizeSpeechSpeed(request?.speed);
    const key = cacheKeyOf({ model: SILICON_MODEL, voice, speed, text });

    const cached = await readCache(key);
    if (cached !== null) return { bytes: cached, mime: 'audio/mpeg', cached: true, bytesBilled: 0 };

    const pending = inflight.get(key);
    if (pending !== undefined) {
      const bytes = await pending;
      return { bytes, mime: 'audio/mpeg', cached: true, bytesBilled: 0 };
    }

    const job = (async () => {
      let response;
      try {
        response = await fetchImpl(SILICON_ENDPOINT, {
          method: 'POST',
          signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            model: SILICON_MODEL,
            input: text,
            // 官方要求形如 `模型:音色`，只写 `claire` 会被当成「不存在的模型」
            voice: siliconVoiceParam(voice),
            response_format: 'mp3',
            speed,
          }),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw new SpeechError(`合成超时（${SYNTH_TIMEOUT_MS / 1000} 秒没有响应）`, 'TIMEOUT', 504);
        }
        throw new SpeechError(`连不上 api.siliconflow.cn：${error?.message ?? error}`, 'NETWORK', 502);
      }
      if (!response.ok) {
        let bodyText = '';
        try { bodyText = await response.text(); } catch { bodyText = ''; }
        throw describeHttpError(response.status, bodyText);
      }
      const buffer = await response.arrayBuffer();
      const bytes = Buffer.from(buffer);
      if (bytes.length === 0) {
        // 200 + 空 body 是「上游静默失败」的典型形态。当成错误报出来，别写进缓存
        // —— 否则这个 0 字节会被缓存 90 天，那篇文章再也读不出声。
        throw new SpeechError('云端返回了空音频', 'EMPTY_AUDIO', 502);
      }
      await writeCache(key, bytes);
      return bytes;
    })();

    inflight.set(key, job);
    try {
      const bytes = await job;
      return { bytes, mime: 'audio/mpeg', cached: false, bytesBilled: speechBytes(text) };
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * 清掉过期的缓存文件。
   *
   * ★ 只按时间清、不做 LRU：这个目录里全是**可再生产物**，清掉只是下次重新合成
   *   一次（花几厘钱）。而按访问时间做 LRU 需要在每次播放时回写 mtime，
   *   那是为几厘钱引入一条会写盘的读路径。
   */
  async function pruneCache(now = Date.now()) {
    let removed = 0;
    let entries;
    try {
      entries = await readdir(cacheDir);
    } catch {
      return { removed, bytes: 0 };
    }
    for (const name of entries) {
      if (!name.endsWith('.mp3')) continue;
      const path = join(cacheDir, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs < SPEECH_CACHE_MAX_AGE_MS) continue;
        await unlink(path);
        removed += 1;
      } catch {
        // 文件刚好被别的进程删掉、或者权限不足 —— 都不是需要报出来的事
      }
    }
    return { removed, bytes: 0 };
  }

  /** 缓存占了多少字节（设置页显示用）。 */
  async function cacheUsage() {
    let total = 0;
    let count = 0;
    let entries;
    try {
      entries = await readdir(cacheDir);
    } catch {
      return { count, bytes: total };
    }
    for (const name of entries) {
      if (!name.endsWith('.mp3')) continue;
      try {
        const info = await stat(join(cacheDir, name));
        total += info.size;
        count += 1;
      } catch { /* 同上 */ }
    }
    return { count, bytes: total };
  }

  return { synthesize, pruneCache, cacheUsage, cacheDir };
}
