/**
 * 平台链接 → 真正的订阅源（0.84.0）。
 *
 * 用户贴的是「播客主页」，而订阅需要的是 XML。这一步就是把前者翻译成后者。
 *
 * ── 四条路，按可验证程度排 ────────────────────────────────────────────
 *
 * 1. **Apple Podcasts**：`itunes.apple.com/lookup?id=<collectionId>` 直接给
 *    `feedUrl`。本机实测（2026-11-18）：忽左忽右 → `https://feed.xyzfm.space/cv4bkgpuglwp`。
 *    这是最可靠的一条，因为 feedUrl 是 Apple 目录自己的字段，不是我们猜的。
 *
 * 2. **小宇宙**：页面**没有** `rel="alternate" type="application/rss+xml"`（它不公开
 *    RSS）。但 `__NEXT_DATA__` 里有播客名 —— 拿名字去 Apple 目录搜，就能反查到
 *    同一个 feed（小宇宙自建的节目也基本都在 Apple 上）。这是唯一稳定的路；
 *    搜不到就**明确说清**搜不到，而不是让用户对着「不是有效的 feed」发呆。
 *
 * 3. **YouTube**：频道页里挖 `channelId` → `feeds/videos.xml?channel_id=…`。
 *    ★ 这条在本机**无法验证**（这台机器访问 youtube.com 直接超时），所以代码里
 *      把每一次失败都翻成人话（贴带 id 的地址 / 检查网络），而不是抛 ENOTFOUND。
 *
 * 4. **任意网页**：读 `<link rel="alternate" type="application/rss+xml">`。这条覆盖
 *    博客、Newsletter、以及绝大多数自建播客站。
 *
 * ★ 这个模块**不直接 import fetch**：抓取由调用方注入（`fetchText` / `fetchJson`）。
 *   理由与 `page-fetch.js` 相同 —— 解析规则要用假响应真跑一遍，而一旦把网络写死
 *   在里面，就只能靠「在真实网站上试」来验证，那不可重复。
 */

import {
  classifySubscriptionUrl,
  findRssHref,
  itunesLookupUrl,
  itunesSearchUrl,
  matchItunesByTitle,
  pickItunesFeed,
  readXiaoyuzhouPage,
  readYoutubeChannelId,
  youtubeFeedUrl,
} from '../feed-platform.js';

/** 带 `code` 的失败：界面据此决定「换个链接」还是「检查网络」，文案已经写成人话。 */
export class FeedResolveError extends Error {
  constructor(message, code = 'FEED_RESOLVE') {
    super(message);
    this.name = 'FeedResolveError';
    this.code = code;
  }
}

/** Apple 目录的两个区：先国内（小宇宙那类中文节目在国内区），再美国区兜底。 */
const ITUNES_COUNTRIES = Object.freeze(['cn', 'us']);

/**
 * @param {object} options
 * @param {string} options.url 用户贴进来的地址
 * @param {(url: string, timeoutMs?: number) => Promise<string>} options.fetchText
 * @param {(url: string, timeoutMs?: number) => Promise<any>} options.fetchJson
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{feedUrl: string, platform: string, title: string, via: string, note: string}>}
 */
export async function resolveFeedUrl({ url, fetchText, fetchJson, log = () => {} }) {
  const raw = String(url ?? '').trim();
  if (raw === '') throw new FeedResolveError('订阅地址不能为空');
  const target = classifySubscriptionUrl(raw);
  log(`[订阅] 识别为 ${target.kind}：${raw}`);

  if (target.kind === 'feed') {
    return { feedUrl: raw, platform: 'feed', title: '', via: 'feed', note: '' };
  }

  if (target.kind === 'apple') {
    if (target.id === '') {
      throw new FeedResolveError(
        '这个 Apple Podcasts 地址里没有节目编号。请打开节目主页（形如 podcasts.apple.com/cn/podcast/xxx/id1514031081），再复制地址栏。',
        'APPLE_NO_ID',
      );
    }
    const failures = [];
    for (const country of ['', ...ITUNES_COUNTRIES]) {
      const payload = await safeJson(fetchJson, itunesLookupUrl(target.id, country));
      if (payload === null) { failures.push(country || '默认区'); continue; }
      const hit = pickItunesFeed(payload);
      if (hit) {
        return {
          feedUrl: hit.feedUrl,
          platform: 'apple',
          title: hit.title,
          via: 'apple',
          note: hit.title === '' ? '' : `Apple 目录：${hit.title}`,
        };
      }
    }
    if (failures.length === 3) {
      throw new FeedResolveError(
        'Apple 目录（itunes.apple.com）连不上，查不出这个节目的订阅源。请检查网络，或者直接贴节目的 RSS 地址。',
        'APPLE_UNREACHABLE',
      );
    }
    throw new FeedResolveError(
      `Apple 目录里查不到 id ${target.id} 的订阅源。可能这个节目只在国内区上架，或者链接里的编号是单集的。`,
      'APPLE_NO_FEED',
    );
  }

  if (target.kind === 'xiaoyuzhou') {
    if (target.id === '') {
      throw new FeedResolveError('这个 小宇宙 地址里没有节目编号，请贴节目主页（www.xiaoyuzhoufm.com/podcast/…）。', 'XYZ_NO_ID');
    }
    const html = await readPage(fetchText, raw, 20_000, '小宇宙');
    const { title } = readXiaoyuzhouPage(html);
    // 少数自建站会把 RSS 挂在自己的页面里，先试这条路：它能拿到**原站**的 feed，
    // 比绕道 Apple 目录更准（Apple 那边可能是别人转收录的）。
    const own = findRssHref(html, raw);
    if (own !== '') {
      return { feedUrl: own, platform: 'xiaoyuzhou', title, via: 'xiaoyuzhou-rss', note: '页面里的 RSS' };
    }
    if (title === '') {
      throw new FeedResolveError(
        '没能从 小宇宙 页面里读到节目名（页面结构可能变了，或者这一集已下架）。请改用节目的 RSS 地址订阅。',
        'XYZ_NO_TITLE',
      );
    }
    for (const country of ITUNES_COUNTRIES) {
      const payload = await safeJson(fetchJson, itunesSearchUrl(title, { country, limit: 8 }));
      const hit = matchItunesByTitle(payload, title);
      if (hit) {
        return {
          feedUrl: hit.feedUrl,
          platform: 'xiaoyuzhou',
          title: hit.title || title,
          via: `xiaoyuzhou→${country.toUpperCase()}`,
          note: `小宇宙 不公开 RSS，已按节目名「${title}」在 Apple 目录找到同名节目`,
        };
      }
    }
    throw new FeedResolveError(
      `小宇宙 不公开 RSS。已读到节目名「${title}」，但在 Apple 目录里没找到同名节目 —— `
      + '可以在 Apple Podcasts 里搜这个节目，把它的链接贴进来（那条链接能直接反查出订阅源）。',
      'XYZ_NOT_IN_APPLE',
    );
  }

  if (target.kind === 'youtube') {
    if (target.id !== '') {
      return { feedUrl: youtubeFeedUrl(target.id), platform: 'youtube', title: '', via: 'youtube-id', note: '' };
    }
    if (target.videoId !== '' && target.handle === '') {
      throw new FeedResolveError(
        '这是单个视频的链接。订阅要贴频道地址：youtube.com/@频道名 或 youtube.com/channel/UC…。',
        'YT_SINGLE_VIDEO',
      );
    }
    if (target.handle === '') {
      throw new FeedResolveError('这个 YouTube 地址里认不出频道。请贴频道主页地址（youtube.com/@频道名）。', 'YT_NO_HANDLE');
    }
    const html = await readPage(fetchText, raw, 25_000, target.handle);
    const channelId = readYoutubeChannelId(html);
    if (channelId === '') {
      throw new FeedResolveError(
        `没能从 ${target.handle} 的页面里认出频道 id。通常是页面被登录墙/地区限制拦了 —— `
        + '可以贴带 id 的地址（youtube.com/channel/UC…），那个不用读页面就能订阅。',
        'YT_NO_CHANNEL',
      );
    }
    return { feedUrl: youtubeFeedUrl(channelId), platform: 'youtube', title: '', via: 'youtube-page', note: '' };
  }

  // page：任意网页，找它自己声明的 RSS。
  const html = await readPage(fetchText, raw, 20_000, raw);
  const rss = findRssHref(html, raw);
  if (rss !== '') {
    return { feedUrl: rss, platform: 'page', title: '', via: 'page-rss', note: '页面里的 RSS' };
  }
  throw new FeedResolveError(
    '这个地址既不是订阅源，页面里也没有 RSS 链接。请找找站点上「RSS / 订阅」的链接，或者直接贴 feed 地址。',
    'PAGE_NO_RSS',
  );
}

/** 目录接口偶尔回 403/超时：吞掉当前区继续试下一个，不让一次抖动终结整条路。 */
async function safeJson(fetchJson, url) {
  try {
    return await fetchJson(url, 12_000);
  } catch {
    return null;
  }
}

/**
 * 读一个平台页面，把网络错误翻成人话。
 *
 * ★ 这一步不是「包装一下更好看」：`fetch` 失败只给 `TypeError: fetch failed`，
 *   它在界面上等于什么都没说 —— 用户不知道是自己贴错了、站点挂了、还是这个
 *   域名根本连不上。YouTube 那条路在本机实测就是这种形态（连接被立刻拒掉），
 *   而「YouTube 打不开」和「页面上找不到 channelId」需要用户做的事完全不同。
 */
async function readPage(fetchText, url, timeoutMs, label) {
  try {
    return await fetchText(url, timeoutMs);
  } catch (error) {
    const detail = String(error?.message ?? error);
    throw new FeedResolveError(
      `打不开 ${label} 的页面（${detail}）。可能是这个网络访问不了该站点，也可能是站点拒绝了请求；`
      + '可以换个网络再试，或直接贴这个节目的 RSS 地址。',
      'PAGE_UNREACHABLE',
    );
  }
}
