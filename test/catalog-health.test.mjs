/**
 * 目录体检快照的读法单测。
 *
 * 夹具用的是 2026-10-08 全量体检（1415 个源）里**真实存在的条目**：
 *   - `透明创业实验` —— 用户订阅的那一个，`items[0]`，最新一篇 2025-11-21（320 天）；
 *   - `阮一峰的网络日志` —— 目录里的地址是 `http://feeds.feedburner.com/ruanyifeng`，
 *     实测抓不到（FeedBurner 已停），而插件自己的精选列表用的是 `ruanyifeng.com/blog/atom.xml`。
 *     **同一个人，两个地址，一个死一个活** —— 这正是「目录质量」问题的形状。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HEALTH_EXPIRY_DAYS, PRUNE_CATALOG_DAYS, STALE_CATALOG_DAYS, catalogHealthOf, healthIndex, healthNotice, isSnapshotExpired, oldestCheckedAt, snapshotAgeDays } from '../src/client/catalog-health.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'src', 'client');

/** 固定「现在」= 2026-10-08 12:00 (GMT+8)，与 source-health.test.mjs 同一把尺子。 */
const NOW = Date.UTC(2026, 9, 8, 4, 0, 0);
const day = (n) => NOW - n * 86_400_000;

const SNAPSHOT = {
  generatedAt: new Date(day(0)).toISOString(),
  checked: 4,
  total: 1415,
  items: [
    // 真实：320 天没更新（时间戳取自真机 data.json 里的 publishedAt）
    { name: '透明创业实验', url: 'https://blog.t9t.io/atom.xml', category: '独立博客', ok: true, newestAt: Date.parse('2025-11-21T08:04:26.711Z') },
    // 真实：FeedBurner 地址，抓不到
    { name: '阮一峰的网络日志', url: 'http://feeds.feedburner.com/ruanyifeng', category: '独立博客', ok: false, error: 'fetch failed' },
    // 真实：抓得到、8 天前更新
    { name: '张鑫旭', url: 'https://www.zhangxinxu.com/wordpress/feed/', category: '独立博客', ok: true, newestAt: Date.parse('2026-09-30T00:00:00.000Z') },
    // 真实形态：抓得到但一条带日期的条目都没有
    { name: '没有日期的源', url: 'https://nodate.example/feed', category: '独立博客', ok: true, entries: 3 },
  ],
};

describe('healthIndex / catalogHealthOf', () => {
  test('按 url 建索引，三个等级各自的结论', () => {
    const index = healthIndex(SNAPSHOT);
    assert.equal(index.size, 4);

    const stale = catalogHealthOf('https://blog.t9t.io/atom.xml', index, NOW);
    assert.equal(stale.level, 'stale');
    assert.equal(stale.days, 320, '真机上的那个 320 天');
    assert.equal(stale.label, '已 320 天未更新');

    const dead = catalogHealthOf('http://feeds.feedburner.com/ruanyifeng', index, NOW);
    assert.equal(dead.level, 'unreachable');
    assert.equal(dead.label, '上次体检没抓到');

    const fresh = catalogHealthOf('https://www.zhangxinxu.com/wordpress/feed/', index, NOW);
    assert.equal(fresh.level, 'fresh');
    assert.equal(fresh.days, 8);
    assert.equal(fresh.label, '最新一篇 8 天前');
  });

  test('没被体检过的 url ⇒ unknown，且不给任何标签', () => {
    const index = healthIndex(SNAPSHOT);
    const state = catalogHealthOf('https://never-checked.example/feed', index, NOW);
    assert.equal(state.level, 'unknown');
    assert.equal(state.label, '', '没有数据就一个字都不说');
    // 反向对照：unknown 绝不能被当成 healthy —— 否则「没体检」会被渲染成「这源没问题」。
    assert.notEqual(state.level, 'fresh');
  });

  test('抓到了但读不出日期 ⇒ unknown，不是「今天有更新」也不是「已停更」', () => {
    const index = healthIndex(SNAPSHOT);
    const state = catalogHealthOf('https://nodate.example/feed', index, NOW);
    assert.equal(state.level, 'unknown');
    // 反向对照：把「没日期」当成 0 天，就会给一个可能已死的源发「今天有更新」的合格证。
    assert.notEqual(state.level, 'fresh');
  });

  test('90 天是边界，89 天不算停更', () => {
    const index = healthIndex({ items: [
      { url: 'https://a.example/f', ok: true, newestAt: day(STALE_CATALOG_DAYS) },
      { url: 'https://b.example/f', ok: true, newestAt: day(STALE_CATALOG_DAYS - 1) },
    ] });
    assert.equal(catalogHealthOf('https://a.example/f', index, NOW).level, 'stale');
    assert.equal(catalogHealthOf('https://b.example/f', index, NOW).level, 'fresh');
  });

  test('newestAt 为 0 时是 unknown —— 0 是 1970 年，不是「刚刚」', () => {
    const index = healthIndex({ items: [{ url: 'https://zero.example/f', ok: true, newestAt: 0 }] });
    const state = catalogHealthOf('https://zero.example/f', index, NOW);
    assert.equal(state.level, 'unknown');
    assert.equal(state.label, '');
  });
});

describe('snapshotAgeDays / isSnapshotExpired', () => {
  test('刚生成的快照不算过期，31 天前的算', () => {
    assert.equal(snapshotAgeDays(SNAPSHOT, NOW), 0);
    assert.equal(isSnapshotExpired(SNAPSHOT, NOW), false);
    const old = { ...SNAPSHOT, generatedAt: new Date(day(HEALTH_EXPIRY_DAYS + 1)).toISOString() };
    assert.equal(snapshotAgeDays(old, NOW), HEALTH_EXPIRY_DAYS + 1);
    assert.equal(isSnapshotExpired(old, NOW), true);
  });

  test('没有 generatedAt ⇒ 视为过期（不能把一份无日期的快照当成事实）', () => {
    // 反向对照：这里返回 false 的话，一份「不知道什么时候测的」结果会被当成现状展示，
    // 而它可能来自几个月前 —— 那正是这次要治的病。
    assert.equal(isSnapshotExpired({ items: SNAPSHOT.items }, NOW), true);
    assert.equal(snapshotAgeDays({ items: [] }, NOW), undefined);
  });
});

describe('healthNotice', () => {
  test('统计数与文案都带日期', () => {
    const notice = healthNotice(SNAPSHOT, NOW);
    assert.equal(notice.checked, 4);
    assert.equal(notice.usable, 1);
    assert.equal(notice.stale, 1);
    assert.equal(notice.unreachable, 1);
    assert.equal(notice.expired, false);
    assert.match(notice.text, /2026-10-08/);
    assert.doesNotMatch(notice.text, /已过期/);

    // ★ 集合基数：四类相加必须等于总数。少算一类就会在这里露出来
    // （最容易漏的是「抓到了但没日期」那一类，它既不是 fresh 也不是 stale 也不是 unreachable）。
    const unknown = SNAPSHOT.items.filter((item) => catalogHealthOf(item.url, healthIndex(SNAPSHOT), NOW).level === 'unknown').length;
    assert.equal(notice.usable + notice.stale + notice.unreachable + unknown, SNAPSHOT.items.length);
  });

  test('快照过期时文案必须自己说出来', () => {
    const old = { ...SNAPSHOT, generatedAt: new Date(day(HEALTH_EXPIRY_DAYS + 5)).toISOString() };
    const notice = healthNotice(old, NOW);
    assert.equal(notice.expired, true);
    assert.match(notice.text, /已过期/);
    assert.match(notice.text, /35 天前/);
  });

  test('没有快照就一个字都不说', () => {
    assert.equal(healthNotice(undefined, NOW), null);
    assert.equal(healthNotice({ items: [] }, NOW), null);
    // 反向对照：只有 items 没有 generatedAt 时仍要给出说明（且标过期），
    // 不能因为「缺日期」就整条不显示 —— 那等于悄悄把体检结果藏起来。
    assert.notEqual(healthNotice({ items: SNAPSHOT.items }, NOW), null);
  });
});

describe('两条线：90 天标陈旧 / 365 天直接删', () => {
  test('删除线比标签线宽，且落在 90 与 365 上', () => {
    assert.equal(STALE_CATALOG_DAYS, 90);
    assert.equal(PRUNE_CATALOG_DAYS, 365);
    // 反向对照：删除线比标签线还严的话，界面上根本没机会标「已停更」就被删了 ——
    // 用户会看到源莫名其妙消失，而不是先看到一个警告。
    assert.ok(PRUNE_CATALOG_DAYS > STALE_CATALOG_DAYS);
  });

  test('刚好 365 天算「该删」，364 天不算', () => {
    const index = healthIndex({ items: [
      { url: 'https://on.example/f', ok: true, newestAt: day(PRUNE_CATALOG_DAYS) },
      { url: 'https://under.example/f', ok: true, newestAt: day(PRUNE_CATALOG_DAYS - 1) },
    ] });
    assert.equal(catalogHealthOf('https://on.example/f', index, NOW).days, PRUNE_CATALOG_DAYS);
    assert.equal(catalogHealthOf('https://under.example/f', index, NOW).days, PRUNE_CATALOG_DAYS - 1);
  });
});

describe('oldestCheckedAt / 分类别体检后的快照年龄', () => {
  test('取最旧的那一次测量，不是最近一次', () => {
    // 体检是分类别跑的（`--only Newsletter`），`generatedAt` 只代表「最近一次动过」。
    const snapshot = {
      generatedAt: new Date(day(1)).toISOString(),
      checkedAt: { 独立博客: new Date(day(40)).toISOString(), Newsletter: new Date(day(1)).toISOString() },
      items: [],
    };
    assert.equal(oldestCheckedAt(snapshot), new Date(day(40)).toISOString());
    // ★ 这条是重点：只重测了一类，不能让整份快照（含 40 天前测的那一半）被读成「刚测过」。
    assert.equal(snapshotAgeDays(snapshot, NOW), 40);
    assert.equal(isSnapshotExpired(snapshot, NOW), true, '有一半数据过期了，整份就得说过期');
    assert.match(healthNotice({ ...snapshot, items: SNAPSHOT.items }, NOW).text, /已过期/);
  });

  test('没有 checkedAt 的老快照退回 generatedAt —— 缺字段不等于永久过期', () => {
    assert.equal(oldestCheckedAt(SNAPSHOT), SNAPSHOT.generatedAt);
    assert.equal(oldestCheckedAt({}), undefined);
    assert.equal(oldestCheckedAt({ checkedAt: { x: 'not-a-date' } }), undefined);
  });
});

describe('接线', () => {
  test('探索页真的用了体检快照', () => {
    const source = readFileSync(join(clientDir, 'Discover.jsx'), 'utf8');
    assert.match(source, /from '\.\.\/data\/catalog-health\.json'/);
    assert.match(source, /catalogHealthOf\(/);
    assert.match(source, /healthNotice\(/);
    // 反向对照：光 import 不用，或者把等级逻辑在 JSX 里再写一遍，都会让单测覆盖的
    // 那个模块变成摆设 —— 跑起来的是另一份实现。
    assert.doesNotMatch(source, /90 \* 86_400_000|STALE_CATALOG_DAYS\s*=/);
  });

  test('体检脚本与界面共用同一套判定口径', () => {
    // 实测踩过：脚本用原始毫秒差（`now - newestAt >= 90 * 86400000`），界面用 `daysSince`
    // （先向下取整到天），同一份数据脚本说 266、页脚说 272 —— 两个数字，用户没法判断信谁。
    const script = readFileSync(join(here, '..', 'scripts', 'catalog-health.mjs'), 'utf8');
    assert.match(script, /from '\.\.\/src\/client\/source-health\.js'/);
    assert.match(script, /from '\.\.\/src\/client\/catalog-health\.js'/);
    assert.match(script, /daysSince\(/);
    // 反向对照：脚本里再出现一次裸的毫秒算术，就说明有人把两套口径又写回去了。
    assert.doesNotMatch(script, /86_400_000/);
  });

  test('体检与裁剪都覆盖**两类**目录，且两条删除线各归各位', () => {
    // 2026-10-09 之前 Newsletter 不在体检范围内，代价是「AI Valley 停更 670 天」
    // 这种事在界面上一个字都没说。这个测试钉的就是「别再漏掉一类」。
    const healthScript = readFileSync(join(here, '..', 'scripts', 'catalog-health.mjs'), 'utf8');
    assert.match(healthScript, /independent-blogs\.json/, '体检脚本漏了独立博客');
    assert.match(healthScript, /newsletter-feeds\.json/, '体检脚本漏了 Newsletter');

    const pruneScript = readFileSync(join(here, '..', 'scripts', 'prune-catalog.mjs'), 'utf8');
    assert.match(pruneScript, /independent-blogs\.json/);
    assert.match(pruneScript, /newsletter-feeds\.json/);
    // ★ 删除线必须从模块里引，不能在脚本里再写一个字面量：
    //   两处数字迟早会漂移，而漂移的结果是「目录里的线」和「记录下来的理由」对不上。
    assert.match(pruneScript, /PRUNE_CATALOG_DAYS/, 'Newsletter 的删除线要引常数，不要写死数字');
    assert.doesNotMatch(pruneScript, /staleDays:\s*\d/, '删除线只许来自常数（STALE_CATALOG_DAYS / PRUNE_CATALOG_DAYS）');

    // 裁剪会**删数据**，而 Newsletter 没有 upstream 可以重新同步 ⇒ 必须先归档。
    assert.match(pruneScript, /retired/, '裁剪 Newsletter 前必须归档，否则删掉就永久丢失');
  });

  test('「一条都没删」时不许改写 pruned 记录', () => {
    // 原样重写会把独立博客那条「1342 → 404」改成「404 → 404」：
    // 既毁掉「上一轮删了什么」的历史，也会让 `pruned.from > pruned.to` 这条断言判红。
    const pruneScript = readFileSync(join(here, '..', 'scripts', 'prune-catalog.mjs'), 'utf8');
    assert.match(pruneScript, /remove\.size === 0/);
    assert.match(pruneScript, /pruned 记录都不动/);
  });
});
