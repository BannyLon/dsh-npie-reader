/**
 * 抓一个外部地址的文本，带 **SSRF 守卫**与逐跳重定向校验。
 *
 * 为什么单独成模块：这段逻辑有两个必须在真代码里跑一遍的地方 ——
 *   「重定向到私网要拒」和「被守卫拒掉时一个请求都不许发出去」。
 *   留在 `service.js` 里就只能读代码猜，抽出来以后 `test/net-guard.test.mjs`
 *   用**注入的假 fetch** 把两种坏法都真的跑出来。
 *
 * 与 `fetchText`（抓 feed）分开的原因见 `service.js` 里那段注释：feed 地址是用户
 * 自己填的，wewe-rss 这类服务本来就在 `localhost:4000`，不能拦。
 *
 * ★ 字幕文件（`fetchTranscriptText`）复用同一份主体，只换白名单与两句文案。
 *   为什么不是另写一份循环：重定向逐跳校验、超时预算贯穿全程、超限文案按实际上限
 *   算 —— 这三条各自都能写错，而写错的表现是「某类地址静默放行」。两处各写一份
 *   等于给自己留两个洞。
 */

import { checkPublicUrl } from './net-guard.js';

/** `text/html; charset=gbk` → `gbk`。 */
function charsetOf(contentType) {
  const match = /charset=([\w-]+)/i.exec(String(contentType ?? ''));
  return match?.[1];
}

/**
 * 抓文本的主体。
 *
 * @param {string} url
 * @param {{
 *   timeoutMs?: number, maxBytes?: number, maxRedirects?: number,
 *   fetchImpl?: typeof fetch,
 *   checkUrl?: (url: string) => Promise<{ ok: boolean, reason?: string }>,
 *   accept?: RegExp, acceptHeader?: string,
 *   rejectMessage?: (contentType: string) => string,
 *   sizeLabel?: string,
 * }} [options]
 * @returns {Promise<string>}
 */
async function fetchGuardedText(url, options = {}) {
  const {
    timeoutMs = 20_000,
    maxBytes = 5 * 1024 * 1024,
    maxRedirects = 5,
    fetchImpl = globalThis.fetch,
    checkUrl = (target) => checkPublicUrl(target),
    accept = /text\/html|application\/xhtml\+xml/i,
    acceptHeader = 'text/html,application/xhtml+xml',
    rejectMessage = (contentType) => `not an HTML page: ${contentType}`,
    sizeLabel = 'page',
  } = options;

  // 一个 signal 贯穿所有跳：超时是「整次抓取」的预算，不是「每一跳」的。
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  let response;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // ★ 校验必须在 fetch **之前**：被拒时一个请求都不许发出去（否则「拦住了」只是
    //   事后报错，内网服务已经被打过一次了）。测试里用「fetch 调用计数为 0」钉这条。
    const verdict = await checkUrl(current);
    if (!verdict?.ok) throw new Error(`拒绝抓取 ${current}：${verdict?.reason ?? '地址未通过校验'}`);
    response = await fetchImpl(current, {
      signal,
      redirect: 'manual',
      headers: { accept: acceptHeader },
    });
    const location = response.headers?.get?.('location');
    if (response.status >= 300 && response.status < 400 && location) {
      // 相对地址要按当前地址解析（`Location: /next` 是常态）。
      current = new URL(location, current).href;
      continue;
    }
    break;
  }

  if (response === undefined) throw new Error(`redirect loop: ${url}`);
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`重定向次数超过 ${maxRedirects}：${url}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${current}`);
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!accept.test(contentType)) {
    throw new Error(rejectMessage(contentType));
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    // 文案按**实际的**上限算，不写死 5 MB —— 上限是入参，写死就会在别人传别的值时
    // 说一句确定的假话。小于 1 MB 时按字节说，免得四舍五入成「0 MB」。
    const limit = maxBytes >= 1024 * 1024
      ? `${Math.round(maxBytes / 1024 / 1024)} MB`
      : `${maxBytes} bytes`;
    throw new Error(`${sizeLabel} larger than ${limit}: ${current}`);
  }
  return new TextDecoder(charsetOf(contentType) ?? 'utf-8', { fatal: false }).decode(buffer);
}

/**
 * 抓一页 HTML。
 *
 * @param {string} url - 起始地址（通常来自 feed 条目的 `<link>`）。
 * @param {{
 *   timeoutMs?: number, maxBytes?: number, maxRedirects?: number,
 *   fetchImpl?: typeof fetch,
 *   checkUrl?: (url: string) => Promise<{ ok: boolean, reason?: string }>,
 * }} [options]
 *   `fetchImpl` / `checkUrl` 可注入，只给测试用。
 * @returns {Promise<string>} 解码后的 HTML。
 * @throws 守卫拒绝、非 HTML、超限、重定向过多、HTTP 非 2xx、超时 —— 一律抛错，
 *   由调用方（`hydrateBody`）退化成「这次不换正文」。
 */
export async function fetchPage(url, options = {}) {
  return await fetchGuardedText(url, options);
}

/**
 * 抓一份字幕文件。
 *
 * ★ 白名单按 Podcasting 2.0 实际会出现的类型收：`text/vtt`、`application/x-subrip`、
 *   `application/json`，再加 `text/plain` 与 `application/octet-stream` —— 后者不是
 *   随便放宽，而是不少播客的 CDN（S3 / Cloudflare R2）对 `.vtt` 一律回
 *   `application/octet-stream`。拦掉它等于「这些节目的字幕永远取不到」，而格式由
 *   `parseTranscript` 按**内容**再判一次，投毒风险在那一层收口。
 * ★ 大小上限给 8 MB（`TRANSCRIPT_LIMITS.maxBytes`）：两小时英文 VTT 约 180 KB。
 *
 * @param {string} url
 * @param {Parameters<typeof fetchGuardedText>[1]} [options]
 * @returns {Promise<string>}
 */
export async function fetchTranscriptText(url, options = {}) {
  const { maxBytes = 8 * 1024 * 1024, ...rest } = options;
  return await fetchGuardedText(url, {
    ...rest,
    maxBytes,
    accept: /text\/vtt|text\/plain|text\/srt|application\/json|application\/x-subrip|application\/srt|application\/octet-stream/i,
    acceptHeader: 'text/vtt,application/x-subrip,application/json,text/plain;q=0.8,*/*;q=0.5',
    rejectMessage: (contentType) => `不是字幕文件（content-type: ${contentType || '空'}）`,
    sizeLabel: 'transcript',
  });
}
