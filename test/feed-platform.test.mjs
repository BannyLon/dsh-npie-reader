/**
 * 平台链接识别（0.84.0）。
 *
 * 这些判据全部是纯函数：认哪些域名、怎么从 HTML 里挖 id/标题、Apple 目录挑哪一条。
 * 它们值得被钉住，是因为**认错的代价在界面上看不出来** —— 贴一个小宇宙链接被当成
 * 网页去抓，报的是「这个地址不是订阅源」，用户会以为「这个节目不能订阅」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySubscriptionUrl,
  findRssHref,
  itunesLookupUrl,
  itunesSearchUrl,
  looksLikeFeedUrl,
  matchItunesByTitle,
  normalizeTitle,
  pickItunesFeed,
  platformAudioSupport,
  readXiaoyuzhouPage,
  readYoutubeChannelId,
  youtubeFeedUrl,
} from '../src/feed-platform.js';

test('classifySubscriptionUrl 认平台', () => {
  assert.equal(classifySubscriptionUrl('https://podcasts.apple.com/cn/podcast/x/id1514031081').kind, 'apple');
  assert.equal(classifySubscriptionUrl('https://podcasts.apple.com/cn/podcast/x/id1514031081').id, '1514031081');
  assert.equal(classifySubscriptionUrl('https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7').kind, 'xiaoyuzhou');
  assert.equal(classifySubscriptionUrl('https://www.xiaoyuzhoufm.com/podcast/5e4ee557418a84a0466737b7').id, '5e4ee557418a84a0466737b7');
  assert.equal(classifySubscriptionUrl('https://www.youtube.com/@lexfridman').kind, 'youtube');
  assert.equal(classifySubscriptionUrl('https://www.youtube.com/@lexfridman').handle, '@lexfridman');
  assert.equal(classifySubscriptionUrl('https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA').id, 'UCSHZKyawb77ixDdsGog4iWA');
  assert.equal(classifySubscriptionUrl('https://youtu.be/dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ');
  assert.equal(classifySubscriptionUrl('https://feeds.feedburner.com/ruanyifeng').kind, 'feed');
  assert.equal(classifySubscriptionUrl('https://www.ruanyifeng.com/blog/').kind, 'page');
  // 空串 / 非 URL 一律落到 page，让上层走「当网页试」而不是抛错。
  assert.equal(classifySubscriptionUrl('').kind, 'page');
  assert.equal(classifySubscriptionUrl('not a url').kind, 'page');
});

test('looksLikeFeedUrl 认形状，且容忍尾部斜杠', () => {
  assert.equal(looksLikeFeedUrl('https://feed.xyzfm.space/cv4bkgpuglwp'), true);
  assert.equal(looksLikeFeedUrl('https://example.com/rss'), true);
  assert.equal(looksLikeFeedUrl('https://example.com/feed/'), true);
  assert.equal(looksLikeFeedUrl('https://example.com/podcast.xml'), true);
  // ★ 反向对照：尾部带斜杠的 .xml 也必须认（真实站点会这么写）。不认的后果是
  //   去抓 HTML、再报「这个地址不是订阅源」—— 而它本来就是 feed。
  assert.equal(looksLikeFeedUrl('https://a.example/feed.xml/'), true);
  assert.equal(looksLikeFeedUrl('https://example.com/blog/post-1'), false);
});

test('findRssHref 从 <link rel="alternate"> 里挑 RSS，且优先 RSS 而非 Atom', () => {
  const html = `
    <html><head>
      <link rel="stylesheet" href="/app.css">
      <link rel="alternate" type="application/atom+xml" href="/atom.xml">
      <link rel="alternate" type="application/rss+xml" href="/rss.xml" title="RSS">
    </head></html>`;
  assert.equal(findRssHref(html, 'https://example.com/blog/'), 'https://example.com/rss.xml');
  // 没有 RSS 时退回 Atom；相对地址按 baseUrl 解析。
  assert.equal(findRssHref('<link rel="alternate" type="application/atom+xml" href="../feed.atom">', 'https://example.com/a/b'), 'https://example.com/feed.atom');
  // 没有就是空串，不抛。
  assert.equal(findRssHref('<html></html>', 'https://example.com'), '');
});

test('readXiaoyuzhouPage 从 __NEXT_DATA__ 读标题，标题不带站点后缀', () => {
  const html = `<html><head><title>忽左忽右 | 小宇宙</title></head><body>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"podcast":{"pid":"5e4e","title":"忽左忽右","author":"JustPod"}}}}</script>
  </body></html>`;
  const page = readXiaoyuzhouPage(html);
  assert.equal(page.title, '忽左忽右');
  assert.equal(page.author, 'JustPod');
  // 没有 NEXT_DATA 时退回 <title> 并切掉「| 小宇宙」。
  assert.equal(readXiaoyuzhouPage('<title>某某节目 | 小宇宙 - 听见更广阔的世界</title>').title, '某某节目');
  // 坏 JSON 不抛，退到 <title>。
  assert.equal(readXiaoyuzhouPage('<title>甲</title><script id="__NEXT_DATA__">{oops</script>').title, '甲');
});

test('readYoutubeChannelId 三种来源都能认', () => {
  const canonical = '<link rel="canonical" href="https://www.youtube.com/channel/UCSHZKyawb77ixDdsGog4iWA">';
  assert.equal(readYoutubeChannelId(canonical), 'UCSHZKyawb77ixDdsGog4iWA');
  assert.equal(readYoutubeChannelId('var x = {"channelId":"UCabcdefghijklmnopqrstuv"};'), 'UCabcdefghijklmnopqrstuv');
  assert.equal(readYoutubeChannelId('src="https://www.youtube.com/embed/x?channel_id=UCzyxwvutsrqponmlkjihgfe"'), 'UCzyxwvutsrqponmlkjihgfe');
  // ★ 反向对照：一个不含频道 id 的页面必须给空串，而不是把 `UC` 之后的任意串当 id。
  assert.equal(readYoutubeChannelId('<html><body>no channel here</body></html>'), '');
  assert.equal(youtubeFeedUrl('UCSHZKyawb77ixDdsGog4iWA'), 'https://www.youtube.com/feeds/videos.xml?channel_id=UCSHZKyawb77ixDdsGog4iWA');
});

test('pickItunesFeed 只收 https，且跳过没有 feedUrl 的条目', () => {
  assert.equal(pickItunesFeed({ results: [{ collectionName: 'x' }] }), null);
  const hit = pickItunesFeed({ results: [
    { collectionName: '旧站', feedUrl: 'http://old.example/rss' },
    { collectionName: '忽左忽右', feedUrl: 'https://feed.xyzfm.space/cv4bkgpuglwp', collectionId: 1493503146 },
  ] });
  assert.equal(hit.feedUrl, 'https://feed.xyzfm.space/cv4bkgpuglwp');
  assert.equal(hit.title, '忽左忽右');
  assert.equal(hit.appleId, '1493503146');
});

test('matchItunesByTitle 先要同名，没有同名才退回第一条', () => {
  const payload = { results: [
    { collectionName: '忽左忽右 中国版', feedUrl: 'https://a.example/rss' },
    { collectionName: '忽左忽右', feedUrl: 'https://b.example/rss' },
  ] };
  assert.equal(matchItunesByTitle(payload, '忽左忽右').feedUrl, 'https://b.example/rss');
  // 标题带括号补充说明时也要能命中（「忽左忽右（视频版）」）。
  assert.equal(matchItunesByTitle(payload, '忽左忽右（视频版）').feedUrl, 'https://b.example/rss');
  assert.equal(matchItunesByTitle({ results: [{ collectionName: '全然不同', feedUrl: 'https://c.example/rss' }] }, '忽左忽右').feedUrl, 'https://c.example/rss');
  assert.equal(normalizeTitle('忽左忽右（视频版）'), '忽左忽右');
});

test('目录查询地址拼得对（id 与 term 都要编码）', () => {
  assert.equal(itunesLookupUrl('1514031081'), 'https://itunes.apple.com/lookup?id=1514031081&entity=podcast');
  assert.match(itunesLookupUrl('1514031081', 'cn'), /&country=cn$/);
  assert.match(itunesSearchUrl('忽左忽右'), /term=%E5%BF%BD%E5%B7%A6%E5%BF%BD%E5%8F%B3/);
  assert.match(itunesSearchUrl('忽左忽右'), /country=cn/);
});

test('YouTube 订阅源里没有音频，要提前说清', () => {
  assert.equal(platformAudioSupport('youtube').ok, false);
  assert.match(platformAudioSupport('youtube').reason, /没有音频/);
  assert.equal(platformAudioSupport('apple').ok, true);
});
