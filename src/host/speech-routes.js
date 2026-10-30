/**
 * 朗读的 HTTP 面（宿主半区）。
 *
 * 三条路由，都挂在 `SPEECH_API_PREFIX` 下：
 *
 *   GET  /config   有没有配 Key（**只回掩码**）、可选音色、模型与单价
 *   POST /config   写入 / 清空 API Key
 *   POST /synth    合成一段文本 → `audio/mpeg` 字节
 *
 * ★ 每条路由都过 `isTrustedLocalRequest` 栅栏。理由与 `library-routes.js` 相同：
 *   宿主派发插件路由**不经过**它自己的鉴权拦截器（先精确路由、再鉴权），所以这里
 *   漏一条就等于把「用用户的 Key 去花钱」敞开给任何能访问本机端口的东西。
 *   这条通道的敏感度比书架更高 —— 书架泄露的是数据，这里泄露的是**计费凭证**。
 *
 * ★ `/config` 的 GET **绝不回完整 Key**，只回 `maskApiKey()` 之后的形态。设置页需要
 *   回答的是「填了没有」，不是「填的是什么」。
 *
 * ★ 为什么 `/synth` 回二进制而不是 JSON 里塞 base64：base64 会膨胀 33%，而这段
 *   字节马上要进 `<audio>` 播放 —— 膨胀的每一字节都要过一遍 IPC 与一次解码。
 */

import { isTrustedLocalRequest } from './trust.js';
import {
  SILICON_MODEL, SILICON_PRICE_PER_KB, SILICON_VOICE_DEFAULT, SILICON_VOICES, SPEECH_API_PREFIX, SPEECH_CHUNK_MAX,
  maskApiKey,
} from '../speech.js';

// 前缀的真值在共用模块里（浏览器半区也要用）。这里转出去，方便调用点就近 import。
export { SPEECH_API_PREFIX };

/** `/synth` 的 body 上限。1000 个汉字 ≈ 3 KB，留足 JSON 转义与空格。 */
const SYNTH_BODY_LIMIT = 16 * 1024;

/** `/config` 的 body 上限。一个 Key 是几十字节，1 KB 已经过分宽裕。 */
const CONFIG_BODY_LIMIT = 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

function forbidden(res) {
  sendJson(res, 403, { ok: false, error: 'forbidden' });
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed;
}

/**
 * @param {{
 *   synth: ReturnType<import('./speech.js').createSpeechSynth>,
 *   getApiKey: () => string,
 *   setApiKey: (key: string) => Promise<void>,
 *   log?: (message: string) => void,
 * }} deps
 */
export function makeSpeechRoutes({ synth, getApiKey, setApiKey, log = () => {} }) {
  /** 配置状态。GET 与 POST 共用一份，避免两处各写一遍「什么算已配置」。 */
  function configPayload() {
    const key = String(getApiKey() ?? '');
    return {
      ok: true,
      // ★ 「已配置」的判据是**去掉空白后非空**，与合成器里那条判据同源
      configured: key.trim() !== '',
      masked: maskApiKey(key.trim()),
      model: SILICON_MODEL,
      voiceDefault: SILICON_VOICE_DEFAULT,
      pricePerKb: SILICON_PRICE_PER_KB,
      chunkMax: SPEECH_CHUNK_MAX,
      voices: SILICON_VOICES,
    };
  }

  return [{
    kind: 'prefix',
    path: SPEECH_API_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) return forbidden(res);
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const rest = pathname.slice(SPEECH_API_PREFIX.length);
      const method = req.method ?? 'GET';

      if (rest === '/config') {
        if (method === 'GET') return sendJson(res, 200, configPayload());
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        let body;
        try {
          body = await readBody(req, CONFIG_BODY_LIMIT);
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求内容不是合法的 JSON' });
        }
        if (!Object.hasOwn(body, 'apiKey') || typeof body.apiKey !== 'string') {
          return sendJson(res, 400, { ok: false, error: '缺少 apiKey 字段' });
        }
        /**
         * ★ Key 里的空白**先剔掉**再存：从控制台复制时常带一个换行，存进去之后
         *   拼进 `Bearer ` 头会变成 `Bearer sk-xxx\n`，服务端回 401 —— 而界面上
         *   显示「已配置」，用户会认为「这个 Key 是坏的」。
         */
        const next = body.apiKey.trim();
        if (next.length > 200) return sendJson(res, 400, { ok: false, error: 'API Key 太长（最多 200 字符）' });
        // 只允许可见 ASCII：中文/全角字符混进来必然 401，早点拦住说得清
        if (next !== '' && !/^[\x21-\x7e]+$/.test(next)) {
          return sendJson(res, 400, { ok: false, error: 'API Key 里有非法字符（应当是一串英文字母与数字）' });
        }
        try {
          await setApiKey(next);
        } catch (error) {
          log(`[朗读] 保存 API Key 失败：${error?.message ?? error}`);
          return sendJson(res, 500, { ok: false, error: '保存失败，设置文件可能不可写' });
        }
        return sendJson(res, 200, configPayload());
      }

      if (rest === '/synth') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        let body;
        try {
          body = await readBody(req, SYNTH_BODY_LIMIT);
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求内容不是合法的 JSON' });
        }
        try {
          const result = await synth.synthesize(body);
          res.writeHead(200, {
            'content-type': result.mime,
            'content-length': String(result.bytes.length),
            // 内容寻址的产物：同一段文本同一音色永远得到同一份字节，可以放心长缓存。
            // 但用 `private` 而不是 `public` —— 它是用户付过钱的产物，不该进共享缓存。
            'cache-control': 'private, max-age=86400',
            'x-speech-cached': result.cached ? '1' : '0',
            'x-speech-billed-bytes': String(result.bytesBilled),
            'referrer-policy': 'no-referrer',
          });
          return res.end(result.bytes);
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 500;
          if (status >= 500) log(`[朗读] 合成失败：${error?.message ?? error}`);
          return sendJson(res, status, { ok: false, code: error?.code ?? 'UNKNOWN', error: error?.message ?? String(error) });
        }
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    },
  }];
}
