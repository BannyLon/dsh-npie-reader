/**
 * 「用户贴进来的是哪个平台的什么链接」—— 纯函数，两端共用。
 *
 * ── 为什么必须先分类再抓 ──────────────────────────────────────────────
 *
 * 订阅框里用户会贴三种完全不同的东西：直接是 feed 地址、是平台的**播客主页**、
 * 是平台的**单集页**。后两者都不是 XML，拿它们当 feed 抓回来的是 HTML ——
 * `parseFeed` 会报「contains no channel/entry records」，而用户看到的是一句
 * 看不懂的英文报错，然后以为「这个节目不支持订阅」。
 *
 * 实测（2026-11-18）：
 *   · Apple Podcasts 主页不带 feed 地址，但 `itunes.apple.com/lookup?id=<id>`
 *     能拿到 `feedUrl`（忽左忽右 → `https://feed.xyzfm.space/cv4bkgpuglwp`）。
 *   · 小宇宙播客页不带任何 `rel="alternate" type="application/rss+xml"`
 *     （它不公开自己的 RSS），但页面 `__NEXT_DATA__` 里有播客标题 ——
 *     拿标题去 Apple 目录里搜，就能反查到同一个 feed。这是唯一稳定的路。
 *   · YouTube 频道页需要从 HTML 里挖 `channelId`，feed 是
 *     `feeds/videos.xml?channel_id=…`。
 *
 * ★ 这个文件**不联网**：所有网络动作在 `host/feed-resolve.js`。分开的理由和
 *   `segment.js` 一样 —— 解析规则（认哪些域名、怎么从 HTML 里取 id）值得被断言
 *   钉住，而它一旦和 fetch 混在一起，就只能靠「在真实网站上试一下」来验证。
 */

/** 平台 id → 界面上给用户看的名字。 */
export const PLATFORM_LABELS = Object.freeze({
  feed: 'RSS',
  apple: 'Apple Podcasts',
  xiaoyuzhou: '小宇宙',
  youtube: 'YouTube',
  page: '网页',
});

/** 小宇宙的播客/单集 id 形如 `5e4ee557418a84a0466737b7`（24 位十六进制）。 */
const XIAOYUZHOU_ID = /([0-9a-f]{24})/i;
/** Apple 的 collectionId 是纯数字（`id1514031081`）。 */
const APPLE_ID = /\/id(\d{4,})/i;
/** YouTube 频道 id 恒为 `UC` + 22 位。 */
const YT_CHANNEL_ID = /^UC[\w-]{22}$/;

/** 取主机名；非法 URL 给空串（调用方据此走「当网页试」）。 */
function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 判断一个地址是不是「本身就是 feed」。
 *
 * ★ 只看路径/主机名的**形状**，不做内容嗅探：`.xml` / `/rss` / `/feed` /
 *   `feed.` 前缀覆盖了绝大多数播客托管（feed.xyzfm.space、feeds.simplecast.com、
 *   anchor.fm/s/xxx/podcast/rss）。形状不像 feed 的照样会去抓一次 —— 分类的作用
 *   是**决定先试哪条路**，不是拒绝。
 */
export function looksLikeFeedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  // ★ 去掉尾部斜杠再判扩展名：`https://a.example/feed.xml/` 是真实存在的写法
  //   （有些站点会把 feed 地址重定向成带斜杠的形式）。不处理的话它会被判成「网页」，
  //   于是去抓 HTML、再报「这个地址不是订阅源」—— 而它本来就是 feed。
  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  if (host.startsWith('feed.') || host.startsWith('feeds.')) return true;
  if (/\.(xml|rss|atom)$/.test(path)) return true;
  if (/\/(rss|feed|atom)(\/|$)/.test(path)) return true;
  if (/[?&](format|feed)=rss/.test(url.search.toLowerCase())) return true;
  // 喜马拉雅 / 荔枝这类专辑页把 rss 挂在 `album/<id>.xml` 上，已被 `.xml` 命中。
  return false;
}

/**
 * 分类。返回 `{ kind, id, handle, videoId }`，`id` 取不到时是空串。
 *
 * @param {string} raw
 * @returns {{kind: 'feed'|'apple'|'xiaoyuzhou'|'youtube'|'page', id: string, handle: string, videoId: string}}
 */
export function classifySubscriptionUrl(raw) {
  const text = String(raw ?? '').trim();
  const none = { kind: 'page', id: '', handle: '', videoId: '' };
  if (text === '') return none;
  const host = hostOf(text);
  if (host === '') return none;

  if (host === 'podcasts.apple.com' || host === 'itunes.apple.com') {
    const match = APPLE_ID.exec(new URL(text).pathname);
    return { kind: 'apple', id: match?.[1] ?? '', handle: '', videoId: '' };
  }

  if (host === 'xiaoyuzhoufm.com' || host.endsWith('.xiaoyuzhoufm.com')) {
    const match = XIAOYUZHOU_ID.exec(new URL(text).pathname);
    return { kind: 'xiaoyuzhou', id: match?.[1] ?? '', handle: '', videoId: '' };
  }

  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    const url = new URL(text);
    const path = url.pathname;
    const channel = /^\/channel\/(UC[\w-]{22})/.exec(path);
    if (channel) return { kind: 'youtube', id: channel[1], handle: '', videoId: '' };
    const handle = /^\/(@[\w.-]+)/.exec(path);
    if (handle) return { kind: 'youtube', id: '', handle: handle[1], videoId: '' };
    const named = /^\/(?:c|user)\/([\w.-]+)/.exec(path);
    if (named) return { kind: 'youtube', id: '', handle: named[1], videoId: '' };
    // 单集链接：能认出是视频，但**不能**订阅（一个视频不是一个频道）。
    const query = url.searchParams.get('v');
    if (query) return { kind: 'youtube', id: '', handle: '', videoId: query };
    if (host === 'youtu.be' && path.length > 1) {
      return { kind: 'youtube', id: '', handle: '', videoId: path.slice(1) };
    }
    return { kind: 'youtube', id: '', handle: '', videoId: '' };
  }

  if (looksLikeFeedUrl(text)) return { kind: 'feed', id: '', handle: '', videoId: '' };
  return { kind: 'page', id: '', handle: '', videoId: '' };
}

/** Apple 目录查询地址（`entity=podcast` 才会把 `feedUrl` 带回来）。 */
export function itunesLookupUrl(id, country = '') {
  const base = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=podcast`;
  return country === '' ? base : `${base}&country=${encodeURIComponent(country)}`;
}

/** Apple 目录按名字搜播客（小宇宙反查要走这条）。 */
export function itunesSearchUrl(term, { country = 'cn', limit = 8 } = {}) {
  return `https://itunes.apple.com/search?term=${encodeURIComponent(String(term ?? '').slice(0, 120))}`
    + `&entity=podcast&limit=${Math.max(1, Math.min(50, limit))}&country=${encodeURIComponent(country)}`;
}

/**
 * 从 Apple 的响应里挑出 feed。
 *
 * ★ 必须检查 `feedUrl` 是 https：lookup 偶尔回 http（喜马拉雅那类老托管），
 *   而宿主抓 feed 与后续抓音频都只走 https —— 直接返回 http 地址会在**下一步**
 *   失败，报错却指向订阅，不像现在这样能一句说清。
 */
export function pickItunesFeed(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  for (const item of results) {
    const feed = typeof item?.feedUrl === 'string' ? item.feedUrl.trim() : '';
    if (!/^https:\/\//i.test(feed)) continue;
    return {
      feedUrl: feed,
      title: typeof item.collectionName === 'string' ? item.collectionName : '',
      appleId: String(item.collectionId ?? ''),
      artist: typeof item.artistName === 'string' ? item.artistName : '',
    };
  }
  return null;
}

/** 按名字在 Apple 的搜索结果里找**同名**的那一条（小宇宙反查的收口）。 */
export function matchItunesByTitle(payload, title) {
  const wanted = normalizeTitle(title);
  if (wanted === '') return pickItunesFeed(payload);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const same = results.filter((item) => normalizeTitle(item?.collectionName) === wanted);
  return pickItunesFeed({ results: same }) ?? pickItunesFeed(payload);
}

/** 去掉空白与中英文括号里的补充说明（「忽左忽右」vs「忽左忽右 中国版」不相等）。 */
export function normalizeTitle(value) {
  return String(value ?? '')
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・:：\-—_]+/g, '')
    .toLowerCase()
    .trim();
}

/**
 * 从 HTML 里找 feed 地址（站点的 `<link rel="alternate">`）。
 *
 * ★ 用正则而不是 DOM 解析：这段 HTML 来自任意站点，几十万字符，而我们只要
 *   那一个 `href`。用 `fast-xml`/jsdom 解析整页只为拿一个属性是几十倍的代价，
 *   而且遇到畸形 HTML 会抛 —— 这里「找不到」是正常结果，不该抛。
 */
export function findRssHref(html, baseUrl = '') {
  const source = String(html ?? '');
  const links = [...source.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]);
  const candidates = [];
  for (const tag of links) {
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    if (href === '') continue;
    if (!/alternate/i.test(rel)) continue;
    if (!/application\/(rss|atom)\+xml/i.test(type)) continue;
    candidates.push({ href, rss: /rss/i.test(type), title: /\btitle\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '' });
  }
  if (candidates.length === 0) return '';
  // RSS 优先于 Atom：播客托管给的 Atom 常常只有摘要（没有 enclosure）。
  candidates.sort((a, b) => Number(b.rss) - Number(a.rss));
  try {
    return new URL(candidates[0].href, baseUrl || undefined).href;
  } catch {
    return '';
  }
}

/**
 * 小宇宙页面 → `{ title, author }`。
 *
 * ★ 两处来源，缺一不可：`__NEXT_DATA__`（Next.js 的整页数据，含
 *   `props.pageProps.podcast`）与 `<title>`（兜底）。只读 `<title>` 的话会拿到
 *   「忽左忽右 | 小宇宙 - 听见更广阔的世界」这种带站点后缀的串，拿去 Apple 搜
 *   会搜不到；只读 NEXT_DATA 的话，小宇宙改前端结构就整条路断掉。
 */
export function readXiaoyuzhouPage(html) {
  const source = String(html ?? '');
  const raw = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(source)?.[1] ?? '';
  let podcast;
  if (raw !== '') {
    try {
      podcast = findPodcastNode(JSON.parse(raw), 0);
    } catch {
      podcast = undefined;
    }
  }
  const title = cleanTitle(podcast?.title) || cleanTitle(readHtmlTitle(source));
  return { title, author: cleanTitle(podcast?.author) };
}

/** 在 NEXT_DATA 里找第一个带 `title` 的 podcast 节点（播客页与单集页结构不同）。 */
function findPodcastNode(node, depth) {
  if (depth > 8 || node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findPodcastNode(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'podcast' && value && typeof value === 'object' && typeof value.title === 'string' && value.title !== '') {
      return value;
    }
  }
  for (const value of Object.values(node)) {
    const hit = findPodcastNode(value, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function readHtmlTitle(html) {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))?.[1] ?? '';
  return raw.split(/\s*[|｜]\s*/)[0];
}

function cleanTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * YouTube 频道页 → 频道 id。
 *
 * ★ 候选顺序照「越靠前越权威」排：`<link rel="canonical" href=".../channel/UC…">`
 *   是页面自己声明的身份；`"channelId":"UC…"` 是播放器初始化数据；`channel_id=`
 *   出现在嵌入式播放器参数里。三条都试，是因为 YouTube 一直在改页面结构，而
 *   只要有一条还在，功能就不会整块失效。
 */
export function readYoutubeChannelId(html) {
  const source = String(html ?? '');
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/channel\/(UC[\w-]{22})/i,
    /"channelId"\s*:\s*"(UC[\w-]{22})"/,
    /"externalId"\s*:\s*"(UC[\w-]{22})"/,
    /channel_id=(UC[\w-]{22})/,
    /\/channel\/(UC[\w-]{22})/,
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(source)?.[1];
    if (hit && YT_CHANNEL_ID.test(hit)) return hit;
  }
  return '';
}

/** YouTube 频道 id → 官方 XML feed（含标题、发布时间、封面，但没有音频）。 */
export function youtubeFeedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

/**
 * 这个平台解析出来的订阅源，**音频能不能拿到**。
 *
 * ★ 界面要据此提前说清楚：YouTube 的 XML 只有视频元数据，没有 `enclosure`。
 *   订阅它能看标题、能点开视频，但「本机识别」无从谈起（要先下载音轨）。
 *   等用户点了识别才报「这集没有音频」是不诚实的 —— 那时他已经等了两分钟。
 */
export function platformAudioSupport(kind) {
  if (kind === 'youtube') return { ok: false, reason: 'YouTube 的订阅源里没有音频文件，只能列标题；识别需要先把音轨下下来' };
  return { ok: true, reason: '' };
}

export const FEED_PLATFORM_HINT = '直接贴 RSS，或 Apple Podcasts / 小宇宙 / YouTube 的频道链接，会自动找出真正的订阅源';
