/**
 * Google 翻译（免费端点）—— 字幕中文层的默认引擎（0.84.0）。
 *
 * ── 为什么默认用 Google，而不是先调模型 ────────────────────────────────
 *
 * 字幕翻译是**量大、重复、对智力要求低**的活：一集 120 段，模型要 6 批、一两分钟、
 * 而且每翻一集都花钱；Google 的免费端点几百毫秒就能给完，同一集重翻也不心疼。
 * 模型翻译这条腿**保留**（术语多、口播绕的集子明显更好），由设置项选，默认 auto：
 * 先 Google，不通再自动落到模型，并把「这次实际用的哪个」告诉界面。
 *
 * ── 为什么「不通」是常态路径，不是异常 ────────────────────────────────
 *
 * `translate.googleapis.com` 在国内网络下是**整个域名不通**（本机 2026-11-18 实测：
 * 直连与系统代理都是 `http=000`，一个字节都没回来）。也就是说对相当一部分用户，
 * 这条路从一开始就走不通 —— 如果把它写成「失败就报错」，那些人每次翻译都会看到
 * 一条红色报错，然后手动去设置里换成模型。
 * 所以：`reachable: false` 是**返回值**，不是异常；service 收到之后静默改走模型，
 * 界面上用一行小字说「Google 翻译不可达，这次用模型翻的」。
 *
 * ★ 这个模块同样不 import fetch：解析规则要被假响应真跑一遍（见测试）。
 */

/**
 * gtx 端点（返回同一种形状）。
 *
 * ★ 两个域名都给：它们在不同的 CDN 后面，实测中一个被封时另一个偶尔还能通。
 *   顺序固定，不随机 —— 随机化会让「同一台机器时而能值时而不能」这种故障
 *   变得无法复现。
 */
export const GOOGLE_ENDPOINTS = Object.freeze([
  'https://translate.googleapis.com/translate_a/single',
  'https://translate.google.com/translate_a/single',
]);

/** 一次请求最多带多少字符：gtx 在 2000 字符以上会被截断（返回只翻了一半）。 */
export const GOOGLE_BATCH_CHARS = 1200;

/** 单段超过这个长度就单独发（避免一段把整批撑爆）。 */
const SINGLE_ITEM_CHARS = 1800;

/**
 * 解析 gtx 的响应。
 *
 * 形状：`[[["译文","原文",null,null,10],["第二句","src",…]],null,"en",…]`
 * —— 只取每段的第 0 项并以 `\n` 连接。
 *
 * ★ 不取第 1 项（原文回显）：Google 会做「空白归一化」，回显的原文与输入不完全一致，
 *   照它对齐会错位；译文按句拼回来是稳定的。
 */
export function parseGoogleTranslate(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return '';
  const parts = [];
  for (const chunk of payload[0]) {
    if (Array.isArray(chunk) && typeof chunk[0] === 'string') parts.push(chunk[0]);
  }
  return parts.join('\n');
}

/** 把若干段拼成不超过预算的一批。 */
export function groupForGoogle(texts, budget = GOOGLE_BATCH_CHARS) {
  const groups = [];
  let current = [];
  let size = 0;
  for (let index = 0; index < texts.length; index += 1) {
    const text = String(texts[index] ?? '');
    if (text === '') continue;
    if (text.length > SINGLE_ITEM_CHARS) {
      groups.push({ indexes: [index], text });
      continue;
    }
    const extra = current.length === 0 ? text.length : text.length + 1;
    if (current.length > 0 && size + extra > budget) {
      groups.push({ indexes: current.map((item) => item.index), text: current.map((item) => item.text).join('\n') });
      current = [];
      size = 0;
    }
    current.push({ index, text });
    size += extra;
  }
  if (current.length > 0) {
    groups.push({ indexes: current.map((item) => item.index), text: current.map((item) => item.text).join('\n') });
  }
  return groups;
}

/**
 * 翻一批字幕。
 *
 * @param {string[]} texts 每段原文
 * @param {object} [options]
 * @param {string} [options.from] 源语言，`auto` = 让 Google 猜
 * @param {string} [options.to] 目标语言
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.concurrency]
 * @returns {Promise<{texts: string[], failed: number[], reachable: boolean, error: string, requests: number}>}
 */
export async function translateWithGoogle(texts, options = {}) {
  const list = Array.isArray(texts) ? texts.map((text) => String(text ?? '')) : [];
  const {
    from = 'auto',
    to = 'zh-CN',
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = 12_000,
    concurrency = 4,
  } = options;
  const out = list.map(() => '');
  const failed = [];
  let reachable = true;
  /** 有没有**任何一段**真的换回了非空译文。用来区分「端点通但内容不对」与「真通」。 */
  let answered = false;
  let error = '';
  let requests = 0;

  if (typeof fetchImpl !== 'function') {
    return { texts: out, failed: list.map((text, index) => (text === '' ? -1 : index)).filter((index) => index >= 0), reachable: false, error: '环境里没有 fetch', requests: 0 };
  }

  const groups = groupForGoogle(list);
  let cursor = 0;
  let stopped = false;

  /**
   * 发一次请求。
   *
   * ★ 用 POST + `application/x-www-form-urlencoded`：GET 把整批中文塞进 query 后，
   *   一段 300 字的字幕就能把 URL 顶到 2 KB 以上，某些中转会在那一层截断，
   *   症状是「最后几段永远是空的」。
   * ★ 不用 `URLSearchParams` 拼 query 而是放 body —— 同一套编码规则，但不受长度限制。
   */
  const request = async (text) => {
    let lastError = '';
    for (const endpoint of GOOGLE_ENDPOINTS) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
            // 不带 UA 时 Google 会回一个空数组（不是 403），从状态码看不出问题。
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36',
          },
          body: new URLSearchParams({ client: 'gtx', sl: from, tl: to, dt: 't', q: text }).toString(),
          signal: signal ?? AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });
        requests += 1;
        if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
        const raw = await response.text();
        if (raw.trim() === '') { lastError = '空响应'; continue; }
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          lastError = '响应不是 JSON（多半被网络劫持/代理改写）';
          continue;
        }
        const translated = parseGoogleTranslate(payload);
        if (translated === '') { lastError = '响应里没有译文'; continue; }
        answered = true;
        return translated;
      } catch (issue) {
        // 网络层失败（GETADDRINFO / 超时 / TLS）—— 这是「域名不通」的形态。
        lastError = issue?.message ?? String(issue);
      }
    }
    throw new Error(lastError || '未知错误');
  };

  const worker = async () => {
    for (;;) {
      if (stopped) return;
      if (signal?.aborted) return;
      const at = cursor;
      cursor += 1;
      if (at >= groups.length) return;
      const group = groups[at];
      try {
        const translated = await request(group.text);
        const pieces = translated.split('\n');
        if (group.indexes.length === 1) {
          out[group.indexes[0]] = translated.trim();
          continue;
        }
        /**
         * ★ 行数对不上就**不硬塞**：Google 偶尔把两行合成一行（它认为那是同一句），
         *   这时按行号分配会把译文整段错位 —— 界面上全是中文，看不出错。
         *   改成逐段重发，宁可多几次请求，也不要一份看起来正常、实际错位的译文。
         */
        if (pieces.length === group.indexes.length) {
          group.indexes.forEach((index, offset) => { out[index] = pieces[offset].trim(); });
        } else {
          for (const index of group.indexes) {
            try {
              out[index] = (await request(list[index])).trim();
            } catch {
              failed.push(index);
            }
          }
        }
      } catch (issue) {
        // 第一次就整批失败 ⇒ 判为「这条网络到不了 Google」。立刻收工，别让界面
        // 干等 4 个并发 × N 批的超时（20 段就是 20 条 12s 超时 = 4 分钟）。
        if (requests === 0 || /GETADDRINFO|ENOTFOUND|EAI_AGAIN|aborted|timeout|fetch failed|网络|socket/i.test(String(issue?.message ?? ''))) {
          reachable = false;
          error = issue?.message ?? String(issue);
          stopped = true;
          for (const index of group.indexes) failed.push(index);
          return;
        }
        for (const index of group.indexes) failed.push(index);
        error = issue?.message ?? String(issue);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, groups.length)) }, worker));
  /**
   * ★ 「端点答了、但一个中文字都没换回来」也要算不可用。
   *
   *   实测过的两种形态：不带 UA 时 Google 回一个**空数组**（状态码 200），以及
   *   某些网络劫持把响应换成一段 HTML。这两种都不是「翻译成空串」，而是**这条
   *   路此刻给不出东西** —— 判成可用的话，service 会写一句「Google 漏了 N 段，
   *   已用模型补齐」，而真相是 Google 根本没在工作。
   */
  if (!answered) reachable = false;
  return { texts: out, failed: [...new Set(failed)].sort((a, b) => a - b), reachable, error, requests };
}

/**
 * 探一次活：给设置页一个「这台机器能不能用 Google 翻译」的明确结论。
 *
 * ★ 探的是**同一个端点、同一套请求方式**。换一个更简单的 URL 去探，得到的
 *   「通」并不代表翻译能用（比如 DNS 通但 gtx 被拦）。
 */
export async function probeGoogleTranslate({ fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const result = await translateWithGoogle(['hello'], { fetchImpl, timeoutMs, concurrency: 1 });
  return {
    ok: result.reachable && result.texts[0] !== '',
    text: result.texts[0] ?? '',
    error: result.error,
  };
}
