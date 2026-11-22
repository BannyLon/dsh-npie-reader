/**
 * 历史文章补全 —— 从站点自己的目录里把 feed 没给的旧文章找回来。
 *
 * 为什么必须有这一层：RSS 没有分页。不少静态站 / 播客站把 feed 生成成
 * 「只含最新 N 条」（`lex.qiaomu.ai` 就是，它自己的 `llms.txt` 里写着
 * 「RSS 全文订阅（最新 20 篇）」，而站上有 506 期）。**换订阅地址变不出旧条目** ——
 * 服务端就那一个静态文件，`?limit=all` 之类的参数会被 nginx 直接忽略。
 * 唯一的路是去读站点自己列的目录。
 *
 * 三条判据，按「能拿到多少信息」排序：
 *   1. 归档页 HTML —— 有日期，最完整；
 *   2. `sitemap.xml` —— 有 `lastmod`，机器可读、几乎每个站都有；
 *   3. `llms.txt` —— 有标题与摘要，但**没有日期**，只能当兜底。
 *
 * ★ 闸门：解析结果必须 ≥ `MIN_ENTRIES` 条才算「找到了」。一个 SPA 的 404 页面
 *   也会返回 200 和一屏导航链接；把导航当成 506 篇文章灌进用户书架，比
 *   「什么都没找到」糟得多 —— 前者要用户自己一条条收拾，而条目**没有单条删除**。
 *
 * 本模块**不碰网络**：抓取函数由调用方注入，所以解析逻辑可以拿固定 HTML 直接测。
 */

/** 少于这个条数就认为「这不是归档页」。 */
const MIN_ENTRIES = 5;
/** 单个源最多补这么多条。`maxEntries` 的硬上限也用它。 */
const MAX_ENTRIES = 1000;
/** 从锚点往前/往后找日期时最多看多少字符 —— 无界窗口会把上一条的日期算给下一条。 */
const DATE_WINDOW = 400;

/**
 * 明显不是文章的路径段。命中就跳过。
 *
 * 刻意**不**用「黑名单站点」那种做法：这里只排除通用导航词，宁可多收一条
 * 导航链接，也不要把某个站的文章目录名（比如 `/posts/`）误杀。
 */
const SKIP_SEGMENTS = /^\/(?:$|about|about-us|contact|privacy|policy|terms|disclaimer|search|tags?|categor(?:y|ies)|archive|archives|page|pages|feed|feeds|rss|atom|sitemap|login|signin|signup|register|subscribe|donate|support|en|tw|ja|ko)(?:[/?#]|$)/i;

/** 静态资源与订阅文件：出现在链接里也绝不可能是「一篇文章」。 */
const ASSET_EXT = /\.(?:xml|json|txt|css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|mp3|m4a|mp4|webm|woff2?|ttf)(?:[?#]|$)/i;

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** 补全条目的上限（`service.js` 拿它设 `sub.maxEntries`）。 */
export const BACKFILL_LIMITS = { minEntries: MIN_ENTRIES, maxEntries: MAX_ENTRIES };

/** `https://a.b/c` → `https://a.b`；不是合法 URL 就回空串（调用方据此早退）。 */
export function originOf(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return '';
  }
}

/**
 * 追踪参数：同一篇文章从不同渠道进来会带不同后缀，媒体名与广告 ID 都属于这类。
 *
 * ★ 为什么必须剥掉：旧实现把整个 `search` 原样拼进 key，于是同一条
 *   `…/post/abc?utm_source=twitter` 与 `…/post/abc?utm_source=weibo` 是两个键 ——
 *   订阅里就出现两条一模一样的文章。这是「偶尔重复条目」的根因。
 * ★ 只列**确定无语义**的参数。`?page=`、`?id=`、`?p=` 这类会影响内容，不能碰。
 */
const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|spm|scm|share_token|share_source|ref_src|ref_url|vero_id|oly_enc_id|oly_anon_id)$/i;

/**
 * 去重用的 URL 归一：去 hash、去尾斜杠、主机小写、剥追踪参数、`http` 与 `https` 视为同一篇。
 *
 * ★ 只用于**比较**，绝不用于写入。`/ep/a/` 与 `/ep/a` 是同一个页面，但把
 *   归一后的值写进条目会让「打开原文」跳到可能不存在的地址。
 * ★ 协议统一成 https 而不是把 http 的也改成 https 去抓：只是让 `http://x/a` 与
 *   `https://x/a` 撞成同一个键，实际抓取仍用条目里的原始地址。
 * ★ 路径**大小写敏感**，不能 lowercase：`/Post/ABC` 与 `/post/abc` 在部分站点是两个页面。
 */
export function normalizeEntryUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    const web = url.protocol === 'http:' || url.protocol === 'https:';
    if (web) {
      url.protocol = 'https:';
      url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    const path = url.pathname.replace(/\/+$/, '');
    const query = url.searchParams.toString();
    const origin = web ? `https://${url.hostname}${url.port === '' ? '' : `:${url.port}`}` : url.origin.toLowerCase();
    return `${origin}${path}${query === '' ? '' : `?${query}`}`;
  } catch {
    return String(value ?? '').trim();
  }
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex) => safeCodePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d+);/g, (whole, dec) => safeCodePoint(Number(dec), whole))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'");
}

function safeCodePoint(code, fallback) {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : fallback;
  } catch {
    return fallback;
  }
}

/** HTML 片段 → 一行纯文本。 */
function textOf(html) {
  return decodeEntities(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attrOf(attrs, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(String(attrs ?? ''));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}

function isoDate(year, month, day) {
  if (!(year >= 1900 && year <= 2100)) return undefined;
  if (!(month >= 1 && month <= 12)) return undefined;
  if (!(day >= 1 && day <= 31)) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
}

/**
 * 从一段文本里找日期。`yearHint` 用于「只有 MM.DD」的站点（归档页按年份分段时
 * 每条只写 `09.16`，年份在分段标题上）。
 *
 * 顺序不能换：先找带年份的完整日期，再退到 `MM.DD`。反过来的话
 * `2026-09-16` 会被读成 `2026-09` 加一个孤零零的 `16`。
 */
export function findDate(text, yearHint) {
  const raw = String(text ?? '');

  for (const match of raw.matchAll(/\b((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const iso = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) return iso;
  }

  for (const match of raw.matchAll(/\b((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    const iso = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) return iso;
  }

  for (const match of raw.matchAll(/\b([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d{2})\b/g)) {
    const month = MONTHS[match[1].toLowerCase()];
    if (!month) continue;
    const iso = isoDate(Number(match[3]), month, Number(match[2]));
    if (iso) return iso;
  }

  // ★ 只有 `MM.DD` 时**必须遍历全部匹配**，不能取第一个就返回。
  //   实测：`维塔利克·布特林：以太坊 2.0` 里先命中 `2.0`（月 2、日 0，非法），
  //   第一个就返回的话整条日期会丢 —— 而真日期 `09.16` 就在同一段文字后面。
  //   同时优先「两位日」的匹配，避免把 `1.5` 这种版本号读成 1 月 5 日。
  if (!yearHint) return undefined;
  let fallback;
  for (const match of raw.matchAll(/\b(\d{1,2})[./-](\d{1,2})\b/g)) {
    const iso = isoDate(yearHint, Number(match[1]), Number(match[2]));
    if (!iso) continue;
    if (match[2].length === 2) return iso;
    fallback ??= iso;
  }
  return fallback;
}

/** 结构里的年份线索（分段 id / data-year / 标题里的年份）。只认结构，不认正文。 */
function yearInMarkup(chunk) {
  const id = /\bid\s*=\s*["'][^"']*?((?:19|20)\d{2})\b/i.exec(chunk);
  if (id) return Number(id[1]);
  const data = /\bdata-year\s*=\s*["']?((?:19|20)\d{2})\b/i.exec(chunk);
  if (data) return Number(data[1]);
  const heading = /<h[1-6]\b[^>]*>[^<]*?((?:19|20)\d{2})\b/i.exec(chunk);
  if (heading) return Number(heading[1]);
  return undefined;
}

function acceptUrl(url, origin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.origin !== origin) return false;
  if (ASSET_EXT.test(parsed.pathname)) return false;
  if (SKIP_SEGMENTS.test(parsed.pathname)) return false;
  return true;
}

/**
 * 标题优先级：`<b>/<strong>/<h2>/<h3>` 里的文字 → 整个锚点文字。
 *
 * 归档页常把「期号 + 中英标题 + 日期」全塞进同一个 `<a>`（lex 就是这样）。
 * 直接取整个锚点会得到「502 精神病学… Psychiatry… 09.16 精读」，所以先找
 * 结构里那个**被强调的**标题；找不到再退回全文。
 */
function titleOf(inner, attrs) {
  const strong = /<(b|strong|h2|h3|h4)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(inner);
  const candidate = (strong ? textOf(strong[2]) : '') || textOf(inner) || decodeEntities(attrOf(attrs, 'title') ?? '');
  return candidate.slice(0, 300).trim();
}

/**
 * 解析归档页 HTML。返回的条目**按页面出现顺序**，排序交给调用方。
 *
 * @param {string} html - 归档页全文
 * @param {string} pageUrl - 归档页自己的地址（用于解析相对链接与同源判定）
 */
export function parseArchiveHtml(html, pageUrl) {
  const origin = originOf(pageUrl);
  if (!origin) return [];
  const source = String(html ?? '');
  const entries = [];
  const seen = new Set();
  let yearHint;

  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let cursor = 0;
  let match;
  while ((match = anchor.exec(source)) !== null) {
    const between = source.slice(cursor, match.index);
    cursor = anchor.lastIndex;
    const structuralYear = yearInMarkup(between);
    if (structuralYear) yearHint = structuralYear;

    const href = attrOf(match[1], 'href');
    if (!href) continue;
    let url;
    try {
      url = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    if (!acceptUrl(url, origin)) continue;

    const title = titleOf(match[2], match[1]);
    if (title.length < 2) continue;

    // 日期可能在同一锚点里（lex），也可能在紧跟其后的兄弟节点里。
    // 往后看的窗口**必须**在下一个 `<li>` / `<a>` 处截断，否则会读到下一条的日期。
    const tail = source.slice(anchor.lastIndex, anchor.lastIndex + DATE_WINDOW).split(/<\/li>|<li\b|<a\b/i)[0];
    const publishedAt = findDate(textOf(match[2]), yearHint) ?? findDate(textOf(tail), yearHint);

    const key = normalizeEntryUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ url, title, publishedAt });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

/** URL 末段当标题：`andrew-scull` → `andrew scull`。只在没有更好来源时用。 */
function titleFromUrl(url) {
  try {
    const segment = new URL(url).pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    return decodeURIComponent(segment).replace(/[-_]+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * 解析 `sitemap.xml`。只取 `<url>` 记录；`<sitemapindex>` 里的子地图不递归
 * （递归会把抓取量放大一个数量级，而单层已经覆盖绝大多数站）。
 */
export function parseSitemap(xml, pageUrl) {
  const origin = originOf(pageUrl);
  if (!origin) return [];
  const entries = [];
  const seen = new Set();
  for (const block of String(xml ?? '').matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(block[1]);
    if (!loc) continue;
    const url = decodeEntities(loc[1]).trim();
    if (!acceptUrl(url, origin)) continue;
    const key = normalizeEntryUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const lastmod = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(block[1]);
    const parsed = lastmod ? new Date(decodeEntities(lastmod[1]).trim()) : undefined;
    entries.push({
      url,
      title: titleFromUrl(url) || url,
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined,
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

/**
 * 解析 `llms.txt` 里的 Markdown 列表：`- [标题](地址)：摘要`。
 *
 * 站点给的地址常常是**纯文本版本**（`/ep/x/index.md`）。落库时必须去掉
 * `index.md`，否则「打开原文」会跳到一份 Markdown 源码。
 */
export function parseLlmsTxt(text, pageUrl) {
  const origin = originOf(pageUrl);
  if (!origin) return [];
  const entries = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*[-*]\s*\[([^\]]+)\]\(\s*(https?:\/\/[^)\s]+)\s*\)\s*(?:[：:—–-]\s*)?(.*)$/.exec(line);
    if (!match) continue;
    const rawUrl = match[2].replace(/\/index\.md$/i, '/');
    if (!acceptUrl(rawUrl, origin)) continue;
    const key = normalizeEntryUrl(rawUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = textOf(match[3] ?? '');
    entries.push({
      url: rawUrl,
      title: decodeEntities(match[1]).trim().slice(0, 300),
      publishedAt: undefined,
      summary: summary ? summary.slice(0, 200) : undefined,
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

function sortByDateDesc(left, right) {
  const a = left.publishedAt ? Date.parse(left.publishedAt) : 0;
  const b = right.publishedAt ? Date.parse(right.publishedAt) : 0;
  return b - a;
}

function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = normalizeEntryUrl(entry.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

const ARCHIVE_PATHS = ['/archive/', '/archives/', '/archive', '/archives'];
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml'];
const LLMS_PATHS = ['/llms.txt'];

/**
 * 依次试归档页 → sitemap → llms.txt，返回第一个「够格」的结果。
 *
 * @param {string} feedUrl - 订阅地址；只取它的 origin
 * @param {{fetchText: (url: string) => Promise<string>}} deps - 抓取函数由调用方注入
 * @returns {Promise<{ok: boolean, kind?: string, source?: string, entries: object[], reason?: string, tried: object[]}>}
 */
export async function discoverArchive(feedUrl, { fetchText } = {}) {
  const origin = originOf(feedUrl);
  const tried = [];
  if (!origin) return { ok: false, entries: [], reason: '订阅地址不是合法的 http(s) 链接', tried };
  if (typeof fetchText !== 'function') return { ok: false, entries: [], reason: '没有可用的抓取函数', tried };

  const attempt = async (url) => {
    try {
      const text = await fetchText(url);
      return { text, error: undefined };
    } catch (error) {
      return { text: '', error: String(error?.message ?? error) };
    }
  };

  let best;
  for (const path of ARCHIVE_PATHS) {
    const url = `${origin}${path}`;
    const { text, error } = await attempt(url);
    if (error) {
      tried.push({ url, error });
      continue;
    }
    const entries = parseArchiveHtml(text, url);
    tried.push({ url, count: entries.length });
    if (entries.length >= MIN_ENTRIES) {
      best = { kind: 'archive', source: url, entries };
      break;
    }
  }

  if (!best) {
    for (const path of SITEMAP_PATHS) {
      const url = `${origin}${path}`;
      const { text, error } = await attempt(url);
      if (error) {
        tried.push({ url, error });
        continue;
      }
      const entries = parseSitemap(text, url);
      tried.push({ url, count: entries.length });
      if (entries.length >= MIN_ENTRIES) {
        best = { kind: 'sitemap', source: url, entries };
        break;
      }
    }
  }

  if (!best) {
    for (const path of LLMS_PATHS) {
      const url = `${origin}${path}`;
      const { text, error } = await attempt(url);
      if (error) {
        tried.push({ url, error });
        continue;
      }
      const entries = parseLlmsTxt(text, url);
      tried.push({ url, count: entries.length });
      if (entries.length >= MIN_ENTRIES) {
        best = { kind: 'llms', source: url, entries };
        break;
      }
    }
  }

  if (!best) {
    return { ok: false, entries: [], reason: '站点上没有找到可用的归档页、sitemap 或 llms.txt', tried };
  }

  // 摘要只有 llms.txt 有。归档页已经拿到日期与标题，缺的正是摘要 ——
  // 补一步（失败不算错，摘要缺失不影响阅读）。
  if (best.kind !== 'llms') {
    for (const path of LLMS_PATHS) {
      const url = `${origin}${path}`;
      const { text, error } = await attempt(url);
      if (error) break;
      const summaries = new Map(parseLlmsTxt(text, url).map((entry) => [normalizeEntryUrl(entry.url), entry.summary]));
      if (summaries.size === 0) break;
      for (const entry of best.entries) {
        const summary = summaries.get(normalizeEntryUrl(entry.url));
        if (summary) entry.summary = summary;
      }
      break;
    }
  }

  const entries = dedupe(best.entries).sort(sortByDateDesc).slice(0, MAX_ENTRIES);
  return { ok: true, kind: best.kind, source: best.source, entries, tried };
}
