/**
 * 频道路由决策的单测。
 *
 * 用例里的频道清单不是编的，是用户机器上真实出现过的形状：
 *   - `feed:ec6edabf…`（AI炼金术 — Podcast）真的取不到东西，`lastError = 'fetch failed'`、0 篇；
 *   - `feed:02555d20…` 真的作为 `npr.channel` 留在过 localStorage 里，而它的订阅后来被删了。
 * 这两个 id 就是用户报「打开侧边栏一篇文章都不显示」时机器上的真实状态。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { channelAfterAdd, channelFailure, countFeeds, emptyListMessage, isAggregateChannel, resolveChannel } from '../src/client/channel-route.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'src', 'client');

/** 用户机器上 `listChannels` 的真实返回（2 个订阅：一个正常、一个 fetch failed）。 */
const REAL_CHANNELS = [
  { key: 'all', kind: 'aggregate', name: '全部订阅', unread: 17, total: 20 },
  { key: 'feeds:all', kind: 'aggregate', name: '我的订阅', unread: 17, total: 20 },
  { key: 'group:微信公众号', kind: 'aggregate', name: '微信公众号', unread: 17, total: 20 },
  { key: 'group:播客', kind: 'aggregate', name: '播客', unread: 0, total: 0 },
  { key: 'feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', kind: 'feed', name: '数字生命卡兹克', group: '微信公众号', unread: 17, total: 20 },
  { key: 'feed:ec6edabf20d008a77877aa03e9b828fd', kind: 'feed', name: 'AI炼金术 — Podcast', group: '播客', unread: 0, total: 0, lastError: 'fetch failed' },
];

describe('isAggregateChannel / countFeeds', () => {
  test('聚合频道只有 all 与 feeds:all', () => {
    assert.equal(isAggregateChannel('all'), true);
    assert.equal(isAggregateChannel('feeds:all'), true);
    // 反向对照：分组与具体源都不是聚合频道，否则「新增订阅后切回我的订阅」永不触发。
    assert.equal(isAggregateChannel('group:播客'), false);
    assert.equal(isAggregateChannel('feed:ec6edabf20d008a77877aa03e9b828fd'), false);
  });

  test('countFeeds 只数真实订阅源，不数聚合与分组', () => {
    assert.equal(countFeeds(REAL_CHANNELS), 2);
    // 反向对照：4 个非 feed 频道必须一个都不算，否则「还没有订阅」这句永远不会出现。
    assert.equal(countFeeds(REAL_CHANNELS.filter((item) => item.kind !== 'feed')), 0);
    assert.equal(countFeeds([]), 0);
    assert.equal(countFeeds(undefined), 0);
  });
});

describe('channelAfterAdd', () => {
  test('停在具体源或分组上时切回「我的订阅」', () => {
    // 用户实际卡住的那个频道。
    assert.equal(channelAfterAdd('feed:ec6edabf20d008a77877aa03e9b828fd'), 'feeds:all');
    assert.equal(channelAfterAdd('feed:13ee7a4c9e3142acf43ae6dcf5a2d75e'), 'feeds:all');
    assert.equal(channelAfterAdd('group:播客'), 'feeds:all');
  });

  test('已经在聚合频道上时不动视图', () => {
    // 反向对照：如果这两个也返回 feeds:all，说明函数只会无脑返回一个常量，
    // 「不打断当前视图」这半条承诺就是假的。
    assert.equal(channelAfterAdd('feeds:all'), undefined);
    assert.equal(channelAfterAdd('all'), undefined);
  });
});

describe('resolveChannel', () => {
  test('频道还在清单里就不动', () => {
    assert.equal(resolveChannel('feeds:all', REAL_CHANNELS), undefined);
    assert.equal(resolveChannel('feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', REAL_CHANNELS), undefined);
    // 有失败、但仍在清单里的源不能算失效 —— 用户要看得到失败原因，不是被悄悄换走。
    assert.equal(resolveChannel('feed:ec6edabf20d008a77877aa03e9b828fd', REAL_CHANNELS), undefined);
  });

  test('频道已从清单里消失就回落', () => {
    // 这个 id 真的在用户 localStorage 的 npr.channel 里留过，而它的订阅已经被删了。
    assert.equal(resolveChannel('feed:02555d207f68420556155452155dec54', REAL_CHANNELS), 'feeds:all');
    assert.equal(resolveChannel('feed:feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', REAL_CHANNELS), 'feeds:all');
  });

  test('清单还没到就别乱动', () => {
    // 反向对照：这一条区分了「清单为空 = 还没读到」与「清单里没有 = 真的失效」。
    // 少了它，界面首帧就会把用户存的频道扔掉。
    assert.equal(resolveChannel('feed:02555d207f68420556155452155dec54', []), undefined);
    assert.equal(resolveChannel('feed:02555d207f68420556155452155dec54', undefined), undefined);
  });
});

describe('channelFailure', () => {
  test('带 lastError 的源给出名称与原因', () => {
    assert.deepEqual(channelFailure('feed:ec6edabf20d008a77877aa03e9b828fd', REAL_CHANNELS),
      { name: 'AI炼金术 — Podcast', error: 'fetch failed' });
  });

  test('正常的源、聚合频道、未知频道都不算失败', () => {
    // 反向对照：这条挡住「把所有空频道都报成失败」。
    assert.equal(channelFailure('feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', REAL_CHANNELS), null);
    assert.equal(channelFailure('feeds:all', REAL_CHANNELS), null);
    assert.equal(channelFailure('feed:unknown', REAL_CHANNELS), null);
    assert.equal(channelFailure('feed:ec6edabf20d008a77877aa03e9b828fd', undefined), null);
  });
});

describe('emptyListMessage', () => {
  const base = { filter: 'all', refreshing: false, channel: 'feeds:all', channels: REAL_CHANNELS };

  test('筛选态优先', () => {
    assert.equal(emptyListMessage({ ...base, filter: 'favorites' }), '还没有收藏的文章');
    assert.equal(emptyListMessage({ ...base, filter: 'unread' }), '没有未读文章');
    // 反向对照：收藏/未读的空文案必须与默认文案不同，否则用户分不清「没有」和「没订阅」。
    assert.notEqual(emptyListMessage({ ...base, filter: 'favorites' }), emptyListMessage(base));
  });

  test('刷新中说刷新中', () => {
    assert.equal(emptyListMessage({ ...base, refreshing: true }), '正在获取这个频道的文章…');
  });

  test('一个订阅都没有时给出入口', () => {
    assert.equal(emptyListMessage({ ...base, channels: REAL_CHANNELS.filter((item) => item.kind !== 'feed') }),
      '还没有订阅。点上方 + 探索订阅源。');
  });

  test('源获取失败时说出原因，而不是「暂无文章」', () => {
    // 这就是用户看到的那个空列表：频道 = 那个 fetch failed 的播客源。
    const message = emptyListMessage({ ...base, channel: 'feed:ec6edabf20d008a77877aa03e9b828fd' });
    assert.equal(message, '「AI炼金术 — Podcast」获取失败：fetch failed');
    // 反向对照：换成正常的源必须退回默认文案 —— 否则这句失败提示是恒真的、没有信息量。
    assert.equal(emptyListMessage({ ...base, channel: 'feed:13ee7a4c9e3142acf43ae6dcf5a2d75e' }),
      '这个频道暂无文章，稍后会自动尝试更新。');
    assert.notEqual(message, emptyListMessage(base));
  });
});

/**
 * 接线守卫：纯函数再对，只要 `ReaderPage` 没接上去就等于没写。
 *
 * 注意它的边界 —— 源码字符串断言答不了「这段代码跑不跑得到」，所以这里只挡
 * 「接线被删掉 / 被改回旧写法」，决策本身由上面的真跑用例负责。
 */
describe('接线', () => {
  const readerPage = readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8');
  const discover = readFileSync(join(clientDir, 'Discover.jsx'), 'utf8');

  test('ReaderPage 用了这三个决策', () => {
    assert.match(readerPage, /from '\.\/channel-route\.js'/, 'ReaderPage 必须从 channel-route.js 取决策');
    for (const name of ['channelAfterAdd', 'resolveChannel', 'emptyListMessage']) {
      assert.match(readerPage, new RegExp(`\\b${name}\\(`), `${name} 必须被调用`);
    }
  });

  test('频道失效时会回落', () => {
    assert.match(readerPage, /resolveChannel\(channel, channels\)/,
      '必须把当前频道与宿主清单交给 resolveChannel');
    assert.match(readerPage, /setChannel\(fallback\)/, '回落要真的落到 state 上');
  });

  test('空列表里有通往「我的订阅」的出口', () => {
    assert.match(readerPage, /selectChannel\('feeds:all'\)/,
      '空状态必须给一个能离开当前频道的按钮，否则用户只能去探索对话框里绕');
  });

  test('订阅成功后把结果交给 ReaderPage', () => {
    assert.match(discover, /await onAdded\(result\)/, 'Discover 必须把新订阅传回上层，否则上层无法判断该切哪个频道');
    assert.match(readerPage, /onAdded=\{onSubscriptionAdded\}/, 'Discover 的 onAdded 必须接上处理函数');
  });
});
