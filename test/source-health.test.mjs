/**
 * 源新鲜度的单测。
 *
 * 夹具用的是用户机器上真实出现的两条订阅（2026-10-08 实测）：
 *   - `数字生命卡兹克`：抓取是成功的（今天刚抓过），但最新一篇停在 9/18 —— 源侧的代理 9/21 就死了；
 *   - `AI炼金术 — Podcast`：`lastError = 'fetch failed'`，一条都没有。
 * 第一条就是「滞后一个月」那个抱怨的机器状态，也是本模块存在的理由。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGING_DAYS, STALE_DAYS, daysSince, freshness, staleFeeds, staleNotice } from '../src/client/source-health.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'src', 'client');

/** 固定「现在」= 2026-10-08 12:00 (GMT+8)，避免用例随时间漂移。 */
const NOW = Date.UTC(2026, 9, 8, 4, 0, 0);
const day = (n) => NOW - n * 86_400_000;

const CHANNELS = [
  { key: 'feeds:all', kind: 'aggregate', name: '我的订阅', total: 20, newestEntryAt: day(20), lastFetchedAt: day(0) },
  { key: 'group:微信公众号', kind: 'aggregate', name: '微信公众号', total: 20, newestEntryAt: day(20), lastFetchedAt: day(0) },
  { key: 'group:播客', kind: 'aggregate', name: '播客', total: 0, lastFetchedAt: undefined },
  { key: 'feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', kind: 'feed', name: '数字生命卡兹克', total: 20, newestEntryAt: day(20), lastFetchedAt: day(0) },
  { key: 'feed:ec6edabf20d008a77877aa03e9b828fd', kind: 'feed', name: 'AI炼金术 — Podcast', total: 0, lastError: 'fetch failed' },
  { key: 'feed:fresh0000000000000000000000000000000000', kind: 'feed', name: '新鲜源', total: 3, newestEntryAt: day(0), lastFetchedAt: day(0) },
];

describe('daysSince', () => {
  test('算天数差并向下取整', () => {
    assert.equal(daysSince(day(0), NOW), 0);
    assert.equal(daysSince(day(1), NOW), 1);
    assert.equal(daysSince(day(20), NOW), 20);
    assert.equal(daysSince(NOW - 90 * 60_000, NOW), 0, '一个半小时前仍是 0 天');
  });

  test('缺失或非法一律 undefined，绝不返回 0', () => {
    // 反向对照：返回 0 会被 freshness 读成「今天刚更新」——
    // 一个从没抓到过的源会被说成「今天有更新」，那是最坏的一种谎。
    for (const bad of [undefined, null, 0, -1, Number.NaN, Infinity, 'not-a-date', '']) {
      assert.equal(daysSince(bad, NOW), undefined, `${String(bad)} 必须返回 undefined`);
    }
  });

  test('ISO 字符串按同一语义解析（不是「非法值」）', () => {
    // 这一条是从上面那个「非法值」列表里**移出来**的，不是删掉：
    // 宿主侧 `publishedAt` 存的就是 ISO 字符串，只认 number 会让它静默落进「未知」分支，
    // 于是每个源都显示「还没抓到过内容」—— 实测宿主真的这么传过一次。
    assert.equal(daysSince('2026-09-18', NOW), 20);
    assert.equal(daysSince('2026-10-08T04:00:00.000Z', NOW), 0);
    // 反向对照：仍然不认识的值必须还是 undefined，别把「解析失败」也当成 0 天。
    assert.equal(daysSince('2026-13-45', NOW), undefined);
  });
});

describe('freshness', () => {
  test('陈旧源：抓取成功但最新一篇很老 ⇒ stale', () => {
    // 这就是用户看到的那一条：刷新没坏，是源死了。
    assert.deepEqual(freshness(CHANNELS[3], NOW), { level: 'stale', days: 20, label: '已 20 天未更新' });
  });

  test('判据优先看文章日期，而不是抓取时间', () => {
    // 反向对照：把同一份数据的 lastFetchedAt 换到「刚刚」，结论必须不变 ——
    // 否则这条判定只是在看「插件有没有去抓」，回答不了用户的「文章为什么不新」。
    const refetched = { ...CHANNELS[3], lastFetchedAt: day(0) };
    assert.equal(freshness(refetched, NOW).level, 'stale');
    const neverRefetched = { ...CHANNELS[3], lastFetchedAt: day(30) };
    assert.equal(freshness(neverRefetched, NOW).level, 'stale');
  });

  test('没有任何文章时才退回看抓取时间', () => {
    const empty = { key: 'feed:x', kind: 'feed', name: '空源', total: 0, lastFetchedAt: day(0) };
    assert.deepEqual(freshness(empty, NOW), { level: 'fresh', days: 0, label: '今天有更新' });
    const neverFetched = { key: 'feed:y', kind: 'feed', name: '没抓过', total: 0 };
    assert.equal(freshness(neverFetched, NOW).level, 'unknown');
    assert.equal(freshness(neverFetched, NOW).label, '还没抓到过内容');
  });

  test('取不到内容的源直接报失败原因', () => {
    const state = freshness(CHANNELS[4], NOW);
    assert.equal(state.level, 'unknown');
    assert.equal(state.label, '获取失败：fetch failed');
  });

  test('新鲜与将旧的边界', () => {
    assert.equal(freshness({ newestEntryAt: day(1) }, NOW).label, '最新一篇 1 天前');
    assert.equal(freshness({ newestEntryAt: day(AGING_DAYS - 1) }, NOW).level, 'fresh');
    assert.equal(freshness({ newestEntryAt: day(AGING_DAYS) }, NOW).level, 'aging');
    assert.equal(freshness({ newestEntryAt: day(STALE_DAYS - 1) }, NOW).level, 'aging');
    assert.equal(freshness({ newestEntryAt: day(STALE_DAYS) }, NOW).level, 'stale');
    // 反向对照：新鲜源必须落在 fresh，否则「陈旧」这个词就没有区分度。
    assert.equal(freshness(CHANNELS[5], NOW).level, 'fresh');
  });
});

describe('staleFeeds', () => {
  test('只数 feed 频道，且只数陈旧的', () => {
    const names = staleFeeds(CHANNELS, NOW).map((channel) => channel.name);
    assert.deepEqual(names, ['数字生命卡兹克']);
    // 反向对照：AI炼金术一条都没有（unknown）不算陈旧，新鲜源也不算。
    assert.ok(!names.includes('AI炼金术 — Podcast'));
    assert.ok(!names.includes('新鲜源'));
  });
});

describe('staleNotice', () => {
  test('停在陈旧源上时点名说清楚', () => {
    const notice = staleNotice('feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', CHANNELS, NOW);
    assert.equal(notice.level, 'stale');
    assert.match(notice.title, /数字生命卡兹克/);
    assert.match(notice.title, /已 20 天未更新/);
  });

  test('聚合频道里列出陈旧的成员', () => {
    const notice = staleNotice('feeds:all', CHANNELS, NOW);
    assert.equal(notice.title, `1 个订阅源超过 ${STALE_DAYS} 天没有更新`);
    assert.equal(notice.detail, '数字生命卡兹克');
  });

  test('新鲜频道与未知频道都不提示', () => {
    // 反向对照：这两条挡住「任何频道都弹提示」的退化写法。
    assert.equal(staleNotice('feed:fresh0000000000000000000000000000000000', CHANNELS, NOW), null);
    assert.equal(staleNotice('feed:不存在', CHANNELS, NOW), null);
    const healthy = CHANNELS.filter((channel) => channel.kind !== 'feed' || channel.name === '新鲜源');
    assert.equal(staleNotice('feeds:all', healthy, NOW), null);
  });

  test('★ key 不随天数变 —— 用户点掉之后不该第二天又冒出来', () => {
    // 这是「不再提示」能被记住的前提。拿 title 当标识就会踩这个坑：
    // 它里面写着「已 20 天未更新」，明天变成「已 21 天未更新」，签名一变
    // 提示就复活了，而用户觉得自己明明关掉过。
    const today = staleNotice('feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', CHANNELS, NOW);
    const tomorrow = staleNotice('feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', CHANNELS, NOW + 86_400_000);
    assert.equal(today.key, tomorrow.key, '同一批源，key 必须一样');
    assert.notEqual(today.title, tomorrow.title, '标题确实会随天数变（正是它不能当标识的原因）');
  });

  test('★ key 跟着源集合走 —— 又多了一个陈旧源就该重新提示', () => {
    const before = staleNotice('feeds:all', CHANNELS, NOW);
    const extra = { key: 'feed:another000000000000000000000000000000', kind: 'feed', name: '也停了', total: 5, newestEntryAt: day(30) };
    const after = staleNotice('feeds:all', CHANNELS.concat([extra]), NOW);
    assert.notEqual(before.key, after.key, '源集合变了 ⇒ 是另一条提示，key 必须变');
    assert.match(after.detail, /也停了/);
  });

  test('★ 两种来源各自成键，不会互相顶掉', () => {
    const feed = staleNotice('feed:13ee7a4c9e3142acf43ae6dcf5a2d75e', CHANNELS, NOW);
    const group = staleNotice('feeds:all', CHANNELS, NOW);
    assert.match(feed.key, /^feed:/);
    assert.match(group.key, /^group:/);
    assert.notEqual(feed.key, group.key);
  });
});

describe('接线', () => {
  test('ReaderPage 把新鲜度用起来了', () => {
    const readerPage = readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8');
    assert.match(readerPage, /from '\.\/source-health\.js'/, 'ReaderPage 必须从 source-health.js 取值');
    assert.match(readerPage, /staleNotice\(/, '陈旧提示必须真的渲染出来');
    const picker = readFileSync(join(clientDir, 'ChannelPicker.jsx'), 'utf8');
    assert.match(picker, /freshness\(/, '频道列表里每个源要显示新鲜度');
  });

  test('★ 「不再提示」记的是 key，且提示本身已经从多行卡片压成一行', () => {
    const readerPage = readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8');
    assert.match(readerPage, /npr\.staleNotice/, '「不再提示」必须落到 localStorage，否则刷新就复活');
    assert.match(readerPage, /sourceNotice\.key/, '记的必须是稳定的 key —— 拿 title 记会每天复活一次');
    // 反向对照：旧的多行卡片结构（红框 + 标题行 + 明细行 + 按钮行）必须从**这里**消失。
    // 那一块压在列表顶上，视觉权重比文章标题还高，用户读文章先被它拦一道。
    assert.ok(!readerPage.includes('npr-notice-body'), 'ReaderPage 的陈旧提示必须是单行结构');
    const css = readFileSync(join(clientDir, 'refinements.css'), 'utf8');
    /**
     * ★ 这里**不能**断言「CSS 里整体没有 `.npr-notice-body`」。
     *
     * 它是**共用**类名：书架那条「没找到书单文件」的多行提示（LibraryApp）还在用它。
     * 0.7.1 就是把这条断言当成依据、连 CSS 一起删掉的 —— 结果书架那条提示的三行内容
     * 叠成一坨（`.npr-notice` 是弹性行，没有 `.npr-notice-body` 这个网格容器就没有行距）。
     * 所以判据要拆成两条：ReaderPage 不用它 **+** CSS 必须留着它（因为确实有人在用）。
     */
    assert.ok(css.includes('.npr-notice-body'), 'CSS 必须保留 .npr-notice-body（书架那条提示在用）');
    const libraryApp = readFileSync(join(clientDir, 'LibraryApp.jsx'), 'utf8');
    // 上面的「必须保留」是靠这条撑住的：反过来说，谁把书架的用法删了，这条会先红，
    // 提示他顺手把 CSS 也删掉 —— 而不是留下一段没人用的死样式。
    assert.ok(libraryApp.includes('npr-notice-body'), '书架那条多行提示是 .npr-notice-body 的唯一使用者');
    // 新结构的关键类都在。
    for (const name of ['npr-notice-text', 'npr-notice-close']) {
      assert.ok(readerPage.includes(name), `ReaderPage 缺少 ${name}`);
      assert.ok(css.includes(`.${name}`), `CSS 缺少 .${name}`);
    }
  });
});
