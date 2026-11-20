/**
 * 单集音频的中转（`GET /library/audio?key=…`）。
 *
 * ★ 为什么不让客户端直接 `<audio src="https://cdn…">`（0.81.0 之前就是这样）：
 *
 *   ① **开播要等很久**。播客托管普遍是「短链 302 到 CDN」，而 302 那一跳的响应
 *      带 `content-length: 0`、没有 `accept-ranges`。Chromium 看到「不支持范围请求」
 *      就把这条流当成不可 seek 的顺序下载：必须缓冲到能解出第一个音频帧才开播，
 *      一集 106 MB 的节目实测十几秒还在 `00:00 / 00:00`。curl 单独下载同一地址
 *      是正常的（1.1 MB/s），所以这件事看起来像「网络慢」，实际是**协议协商失败**。
 *      中转层强制带 `Range: bytes=0-` 发出去、再把上游的 `206` 与 `accept-ranges`
 *      原样交给客户端，Chromium 立刻按段取，几百 KB 就能开播。
 *
 *   ② **渲染半区是宿主里的一个面板**。外链媒体要过宿主的 CSP/权限，一旦 `media-src`
 *      不在白名单，`<audio>` 直接 `error`，界面只能说「音频暂不可用」而用户在浏览器
 *      里打开同一个地址却好好的。改成同源相对路径就没有这一层。
 *
 * ★ 这里**不改写字节**：只做「校验 → 转发 → 透传响应头 → 管道」。上游支持 Range
 *   就透传 206，不支持就退回 200，两种都能播（只是后者不能拖）。
 *
 * ★★ 0.85.3 修的是一处「上游合法、客户端致命」的残缺：**`206` 但没有
 *   `content-range`**。实测 `media.xyzcdn.net`（小宇宙，Tengine + OSS）对
 *   `Range: bytes=0-` 回 `206` + `content-length: 64551564`，**不回
 *   `content-range`**。HTTP 规范里 206 必须带这个头，而 Chromium 的媒体栈正是
 *   靠它做两件事：
 *
 *     ① 把 `content-length` 换算成「整条资源有多大」；
 *     ② 把这一段的起点放回文件里的绝对偏移。
 *
 *   两个都算不出来时，元素会认为自己在读一条**没有长度的流**：`duration` 停在
 *   `Infinity`（界面显示 `00:00`）、`seekable` 是空区间。后果不是「播不了」——
 *   音频照常出声 —— 而是：
 *
 *     · 进度条的分母恒为 0 ⇒ 滑块没有行程，**拖不动**；
 *     · `±15 秒` 的目标被夹到 0 ⇒ **按了没反应**；
 *     · 断点恢复要用总时长判断「是不是快听完了」，总时长是 0 ⇒ 直接 return，
 *       **听过的位置永远回不去**（用户看到的三个毛病，其实是这一个）。
 *
 *   所以中转层不再「上游给什么就转什么」，而是**自己补齐这三个头**：总长度靠
 *   「从 0 开始的响应长度」推出来（并缓存），每段的 `content-range` 由我们算。
 *   上游给的值永远优先；只有它缺了才补，所以不会把本来正确的源改坏。
 */

/** 最多跟几跳重定向。播客短链一般一跳（302 → CDN），三跳足够。 */
const MAX_REDIRECTS = 3;

/**
 * 原样回给客户端的响应头。
 *
 * ★ `content-range` / `accept-ranges` 是这里的**主角**：没有它们，客户端就不知道
 *   这条流可以分段取 —— 那正是「等很久」的根因，所以绝不能省。
 */
const PASS_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

/**
 * 「这条音频一共多少字节」的记忆（按请求时的原始地址）。
 *
 * ★ 为什么要缓存：客户端拖到 40 分钟时只会发 `Range: bytes=26000000-`，光看这一
 *   个请求推不出总长（上游又不给 `content-range`）。第一次 `bytes=0-` 的响应长度
 *   就是总长，记下来后面都能用；换集不换地址的情形（重听）也直接命中。
 * ★ 上限 64 条：一集 8 字节，留一份够用又不至于长跑不清理。
 */
const TOTAL_CACHE = new Map();
const TOTAL_CACHE_MAX = 64;

/** 带状态码与错误码的失败。路由层据此选 HTTP 状态，界面据此说人话。 */
export class AudioError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AudioError';
    this.status = status;
    this.code = code;
  }
}

/**
 * 解析客户端的 `Range`。
 *
 * 只认最常见的两种：`bytes=N-` 与 `bytes=N-M`。`bytes=-N`（末尾 N 字节）也算
 * 合法，但它的起点依赖总长，正是我们**还不知道**的东西 —— 交给上游自己去算，
 * 我们只负责把它的答复补成合规的形状。
 */
function parseRange(range) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range ?? '').trim());
  if (!match) return null;
  const start = match[1] === '' ? null : Number(match[1]);
  const end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return null;
  if (start !== null && !Number.isFinite(start)) return null;
  if (end !== null && !Number.isFinite(end)) return null;
  return { start, end };
}

/** 从 `content-range: bytes 0-17/1000` 里取「这一段有多少字节」。取不到给 0。 */
function spanOfContentRange(value) {
  const match = /bytes\s+(\d+)-(\d+)\//.exec(String(value ?? ''));
  if (!match) return 0;
  const span = Number(match[2]) - Number(match[1]) + 1;
  return Number.isFinite(span) && span > 0 ? span : 0;
}

/** 从 `content-range: bytes 0-17/1000` 里取总长。取不到给 0。 */
function totalOfContentRange(value) {
  const match = /\/(\d+)\s*$/.exec(String(value ?? ''));
  if (!match) return 0;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/** 记下总长（LRU 简化版：满了先丢最早的一条）。 */
function rememberTotal(url, total) {
  if (!(total > 0)) return;
  if (TOTAL_CACHE.size >= TOTAL_CACHE_MAX) {
    const oldest = TOTAL_CACHE.keys().next();
    if (!oldest.done) TOTAL_CACHE.delete(oldest.value);
  }
  TOTAL_CACHE.set(url, total);
}

/**
 * 问一次上游「这条音频有多大」。
 *
 * ★ 只在**第一次就收到非零起点**的 Range 时才走这条路（正常播放总是从 0 开始，
 *   所以这条分支实际上很少触发，多半是「上次拖到一半，重开面板继续」）。
 * ★ 用 `bytes=0-` 而不是 `bytes=0-0`：后者只回 1 字节，`content-length` 也是 1，
 *   推不出总长。拿到响应头就立刻 `cancel()`，那 64 MB 一个字节都不会下载。
 */
async function probeTotal(url, { guard, signal, log }) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await guard(current);
    if (!verdict?.ok) return 0;
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) dsh-npie-reader',
          accept: 'audio/*,application/octet-stream,*/*;q=0.5',
          range: 'bytes=0-',
        },
      });
    } catch {
      return 0;
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return 0;
      current = new URL(location, current).href;
      continue;
    }
    const fromRange = totalOfContentRange(response.headers.get('content-range'));
    if (fromRange > 0) return fromRange;
    const length = Number(response.headers.get('content-length'));
    // ★ 只有「从 0 开始的完整响应」才能拿长度当总长：上游若忽略了 Range 而回了
    //   200，`content-length` 同样是总长；回了 206 + 从 0 开始也一样。
    if (Number.isFinite(length) && length > 0) return length;
    return 0;
  }
  log?.('[音频] 探测总长时重定向过多，放弃');
  return 0;
}

/**
 * 打开一条音频流。
 *
 * @returns `{ status, headers, body, finalUrl }`；`body` 是 web ReadableStream。
 *          `headers` 里的 `content-range` / `content-length` / `accept-ranges`
 *          已经**补齐到合规**（上游缺的由我们算出来）。
 */
export async function openAudioStream(rawUrl, { range = '', signal, checkUrl, log = () => {} } = {}) {
  const guard = checkUrl ?? (await import('./net-guard.js')).checkPublicUrl;
  const wanted = parseRange(range);
  /**
   * 是不是「末尾 N 字节」这种写法（`bytes=-500`）。
   *
   * ★ 它没有起点：上游会按总长自己算。所以**不能**用「响应长度」反推总长
   *   ——那会把「最后 500 字节」当成「整个文件就 500 字节」。
   */
  const suffixOnly = wanted !== null && wanted.start === null;
  /** 这一段的起点。客户端没给 Range（或给了 `bytes=-N`）时按 0 处理。 */
  const start = wanted?.start ?? 0;
  let url = String(rawUrl ?? '');

  // 起点 > 0 而总长还不知道：先问一次，否则没法算 `content-range`。
  let total = TOTAL_CACHE.get(url) ?? 0;
  if (start > 0 && total <= 0) {
    total = await probeTotal(url, { guard, signal, log });
    rememberTotal(url, total);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await guard(url);
    if (!verdict?.ok) {
      throw new AudioError(`音频地址不可用：${verdict?.reason ?? '校验失败'}`, 403, 'AUDIO_BLOCKED');
    }
    let response;
    try {
      response = await fetch(url, {
        // ★ `manual` 而不是 `follow`：每一跳都要自己过一遍 SSRF 校验。
        //   `follow` 会把「302 到 127.0.0.1」这件事交给 undici 悄悄做掉。
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) dsh-npie-reader',
          accept: 'audio/*,application/octet-stream,*/*;q=0.5',
          // ★ 客户端没带 Range 也主动要第一段：这一句就是「能不能拖」的分水岭。
          range: range || 'bytes=0-',
        },
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new AudioError('音频请求被取消', 499, 'AUDIO_ABORTED');
      throw new AudioError(`取音频失败：${error?.message ?? error}`, 502, 'AUDIO_FETCH');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      // 上一跳的 body 必须丢掉，否则连接不会被复用。
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new AudioError('音频地址重定向但没有目标', 502, 'AUDIO_REDIRECT');
      const next = new URL(location, url).href;
      log(`[音频] 第 ${hop + 1} 跳：${url.slice(0, 60)}… → ${next.slice(0, 60)}…`);
      url = next;
      continue;
    }

    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      throw new AudioError(`音频源返回 ${response.status}`, 502, 'AUDIO_STATUS');
    }

    const headers = {};
    for (const name of PASS_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    if (!headers['content-type']) headers['content-type'] = 'audio/mpeg';

    const length = Number(headers['content-length']);

    // ① 上游自己给了总长：以它为准（换了版本、重新上传过时只有它是对的）。
    const declared = totalOfContentRange(headers['content-range']);
    if (declared > 0) total = declared;
    // ② 上游没给 `content-range`（本文件顶部那段注释的主角）：
    //    从 0 开始的 206 响应，`content-length` 就是总长。
    else if (!suffixOnly && response.status === 206 && start === 0 && Number.isFinite(length) && length > 0) {
      total = length;
    }
    // ③ 上游忽略了 Range 回了 200：`content-length` 也是总长，但它**不能拖**
    //    （下一段会说明为什么此时不能硬补 `accept-ranges`）。
    else if (!suffixOnly && response.status === 200 && Number.isFinite(length) && length > 0) {
      total = length;
    }
    rememberTotal(rawUrl, total);
    rememberTotal(url, total);

    if (response.status === 206 && !suffixOnly && total > 0 && !headers['content-range']) {
      /**
       * ★ 这一行就是 0.85.3 的核心修复。
       *
       * 206 却没有 `content-range` 时，Chromium 既不知道资源多大、也不知道这段
       * 字节在文件里的位置 —— 它把这当成「长度未知的流」：`duration = Infinity`、
       * `seekable` 为空。播放不受影响，所以症状只出现在**进度条、±15 秒、断点**
       * 这三件事上，看起来像三个 bug。
       *
       * 终点优先用上游的 `content-length`（那是这一段真实有多少字节），取不到才
       * 退到「到文件末尾」。两者都夹在总长之内，绝不给出越界的头。
       */
      const span = Number.isFinite(length) && length > 0 ? length : total - start;
      const end = Math.min(start + span - 1, total - 1);
      headers['content-range'] = `bytes ${start}-${Math.max(end, start)}/${total}`;
    }
    /**
     * ★ `206` 必须**同时**带 `content-length`（0.85.7）。
     *
     * `content-range` 说的是「这一段在整条资源里的位置与总长」，`content-length`
     * 说的是「这次连接要传多少字节」。两者缺一不可：部分 CDN 对 `bytes=0-1`
     * 这种极短片段干脆省掉 `content-length` 改走 chunked，中转层原样透传，于是
     * 客户端拿到的是一条**没有长度**的 206。
     *
     * Chromium 的媒体栈对「206 但长度未知」的流会退化成 `seekable = [0, 0]`：
     * 播放照常出声，而 `element.currentTime = t` 会被夹回 0 —— 这正是用户看到的
     * 「进度条拖不动、±15 秒没反应、听过的位置记不住」。真机诊断读数：
     *   `dur=4580.2  seekable=[0,0]  响应 206  cr=bytes 0-1/74146460  cl=无`
     *
     * 长度不用问上游：`bytes a-b/total` 本身就写着 b - a + 1。自己算出来补上，
     * 比依赖某家 CDN 的脾气可靠。
     */
    if (response.status === 206 && !headers['content-length']) {
      const span = spanOfContentRange(headers['content-range']);
      if (span > 0) headers['content-length'] = String(span);
    }
    /**
     * ★ 补一个 `accept-ranges: bytes`。
     *
     * 实测（2026-11-17，`cdn.fireside.fm`）：它对带 `Range` 的请求确实回 `206` +
     * `content-range`，但**不回 `Accept-Ranges` 头**。而 Chromium 判定「这条流能不能
     * 拖」时两条路都认（206 或这个头），只是回退到「无该头就按不可 seek 处理」的实现
     * 也不罕见 —— 我们既然透传了 Range，就该把这句话明确说出去，别赌客户端的脾气。
     *
     * ★ 只在**真的能分段**时才说（206）或上游明确说了时（它有这个头）。上游回了
     *   200 就说明它忽略了 Range：此时硬写 `accept-ranges` 是撒谎，Chromium 会据此
     *   发一堆拿不到 206 的请求，拖动反而更卡。
     */
    if (response.status === 206 && !headers['accept-ranges']) headers['accept-ranges'] = 'bytes';
    if (response.status === 200) delete headers['accept-ranges'];

    return { status: response.status, headers, body: response.body, finalUrl: url };
  }
  throw new AudioError('音频地址重定向次数过多', 502, 'AUDIO_REDIRECT');
}

/** 仅供判据使用：清掉总长缓存，让「第一次就拖到中间」的场景可以重演。 */
export function resetTotalCache() {
  TOTAL_CACHE.clear();
}
