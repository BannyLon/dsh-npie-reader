/**
 * `resolveFeedUrl`：把平台链接翻译成真 feed（0.84.0）。
 *
 * 全部用注入的假 fetch 跑 —— 这条链路的失败形态（目录查不到、页面被拦、只给了
 * 单集链接）在真网络上是偶发的，没法靠「手动试一次」覆盖，而它们的**文案**正是
 * 用户唯一能得到的线索。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FeedResolveError, resolveFeedUrl } from '../src/host/feed-resolve.js';

const XZ_PAGE = `<html><head><title>忽左忽右 | 小宇宙</title></head><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"podcast":{"title":"忽左忽右","author":"JustPod"}}}}</script>
</body></html>`;

function fakeNetwork({ pages = {}, json = {} } = {}) {
  return {
    fetchText: async (url) => {
      if (Object.hasOwn(pages, url)) {
        const value = pages[url];
        if (value instanceof Error) throw value;
        return value;
      }
      throw new Error(`没有为 ${url} 准备页面`);
    },
    fetchJson: async (url) => {
      for (const [needle, value] of Object.entries(json)) {
        if (url.includes(needle)) {
          if (value instanceof Error) throw value;
          return value;
        }
      }
      throw new Error(`没有为 ${url} 准备 JSON`);
    },
  };
}

test('直接是 feed：原样返回，不发任何请求', async () => {
  const net = fakeNetwork();
  const hit = await resolveFeedUrl({ url: 'https://feed.xyzfm.space/cv4bkgpuglwp', ...net });
  assert.equal(hit.feedUrl, 'https://feed.xyzfm.space/cv4bkgpuglwp');
  assert.equal(hit.platform, 'feed');
});

test('Apple 链接 → lookup 拿到 feedUrl', async () => {
  const net = fakeNetwork({
    json: { 'itunes.apple.com/lookup': { results: [{ collectionName: '忽左忽右', feedUrl: 'https://feed.xyzfm.space/cv4bkgpuglwp', collectionId: 1493503146 }] } },
  });
  const hit = await resolveFeedUrl({ url: 'https://podcasts.apple.com/cn/podcast/x/id1493503146', ...net });
  assert.equal(hit.feedUrl, 'https://feed.xyzfm.space/cv4bkgpuglwp');
  assert.equal(hit.via, 'apple');
  assert.equal(hit.title, '忽左忽右');
});

test('Apple：地址里没有 id 时说清「要节目主页」', async () => {
  await assert.rejects(
    () => resolveFeedUrl({ url: 'https://podcasts.apple.com/cn/podcast/忽左忽右', ...fakeNetwork() }),
    (error) => error instanceof FeedResolveError && error.code === 'APPLE_NO_ID' && /节目编号/.test(error.message),
  );
});

test('Apple：三个区都连不上时，报「目录连不上」而不是「查不到这个节目」', async () => {
  const net = fakeNetwork({ json: { 'itunes.apple.com': new Error('fetch failed') } });
  await assert.rejects(
    () => resolveFeedUrl({ url: 'https://podcasts.apple.com/cn/podcast/x/id1514031081', ...net }),
    (error) => error.code === 'APPLE_UNREACHABLE' && /连不上/.test(error.message),
  );
});

test('小宇宙 → 页面标题 → Apple 目录反查同一个 feed', async () => {
  const net = fakeNetwork({
    pages: { 'https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7': XZ_PAGE },
    json: { 'itunes.apple.com/search': { results: [{ collectionName: '忽左忽右', feedUrl: 'https://feed.xyzfm.space/cv4bkgpuglwp' }] } },
  });
  const hit = await resolveFeedUrl({ url: 'https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7', ...net });
  assert.equal(hit.feedUrl, 'https://feed.xyzfm.space/cv4bkgpuglwp');
  assert.equal(hit.via, 'xiaoyuzhou→CN');
  assert.match(hit.note, /不公开 RSS/);
});

test('小宇宙：页面自己带 RSS 时优先用它（不绕 Apple 目录）', async () => {
  const page = `${XZ_PAGE}<link rel="alternate" type="application/rss+xml" href="https://xz.example/own.xml">`;
  const net = fakeNetwork({
    pages: { 'https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7': page },
    json: { 'itunes.apple.com/search': { results: [{ collectionName: '忽左忽右', feedUrl: 'https://apple.example/rss' }] } },
  });
  const hit = await resolveFeedUrl({ url: 'https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7', ...net });
  assert.equal(hit.feedUrl, 'https://xz.example/own.xml');
  assert.equal(hit.via, 'xiaoyuzhou-rss');
});

test('小宇宙：Apple 里找不到同名节目时，告诉用户「去 Apple 搜一下再贴链接」', async () => {
  const net = fakeNetwork({
    pages: { 'https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7': XZ_PAGE },
    json: { 'itunes.apple.com/search': { results: [] } },
  });
  await assert.rejects(
    () => resolveFeedUrl({ url: 'https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7', ...net }),
    (error) => error.code === 'XYZ_NOT_IN_APPLE' && /忽左忽右/.test(error.message) && /Apple Podcasts/.test(error.message),
  );
});

test('YouTube 频道页 → channelId → 官方 XML', async () => {
  const net = fakeNetwork({
    pages: { 'https://www.youtube.com/@lexfridman': '<link rel="canonical" href="https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA">' },
  });
  const hit = await resolveFeedUrl({ url: 'https://www.youtube.com/@lexfridman', ...net });
  assert.equal(hit.feedUrl, 'https://www.youtube.com/feeds/videos.xml?channel_id=UCSHZKyawb77ixDdsGog4iWA');
  assert.equal(hit.platform, 'youtube');
});

test('YouTube：单个视频的链接不能当订阅，直接说清要贴频道', async () => {
  await assert.rejects(
    () => resolveFeedUrl({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', ...fakeNetwork() }),
    (error) => error.code === 'YT_SINGLE_VIDEO',
  );
});

test('YouTube：页面被拦时给「换网络 / 贴带 id 的地址」，而不是 fetch failed', async () => {
  const net = fakeNetwork({ pages: { 'https://www.youtube.com/@lexfridman': new TypeError('fetch failed') } });
  await assert.rejects(
    () => resolveFeedUrl({ url: 'https://www.youtube.com/@lexfridman', ...net }),
    (error) => error.code === 'PAGE_UNREACHABLE' && /youtube\.com\/channel\/UC/.test(error.message) === false
      && /打不开/.test(error.message) && /fetch failed/.test(error.message),
  );
});

test('任意网页 → 页面里的 RSS；没有就报「没有 RSS 链接」', async () => {
  const withRss = fakeNetwork({ pages: { 'https://blog.example/': '<link rel="alternate" type="application/rss+xml" href="/feed.xml">' } });
  const hit = await resolveFeedUrl({ url: 'https://blog.example/', ...withRss });
  assert.equal(hit.feedUrl, 'https://blog.example/feed.xml');
  assert.equal(hit.via, 'page-rss');

  const withoutRss = fakeNetwork({ pages: { 'https://blog.example/': '<html></html>' } });
  await assert.rejects(
    () => resolveFeedUrl({ url: 'https://blog.example/', ...withoutRss }),
    (error) => error.code === 'PAGE_NO_RSS' && /RSS/.test(error.message),
  );
});
