/**
 * 跨源检索的宿主侧聚合（0.88.0）。
 *
 * 纯函数那半边（投影 / 截断 / 挂链）在 `search-all.test.mjs`。这一份盯的是
 * **四路真的被调了、失败真的被降级了**：
 *
 *  - 少调一路（比如忘了论文），界面只是「论文 0 条」—— 用户会以为论文库里没有；
 *  - 一路抛错不接住，整次搜索 500 —— 用户失去另外三路本来能给他的结果；
 *  - 反查挂到隐藏条目上，什么都没发生（但白扫了一遍日记）。
 *
 * ★ 每一路都用**桩**替换：这里要验的是编排，不是四套检索本身
 *   （它们各自有测试）。用真数据反而会把「编排错了」淹没在「检索结果不一样」里。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { loadHostBundle } from './helpers/host-bundle.mjs';

const sandbox = await mkdtemp(join(tmpdir(), 'npie-searchall-'));
process.env.DSH_HOME = sandbox;
process.env.HOME = sandbox;

const { RssService } = await loadHostBundle();
const realFetch = globalThis.fetch;
const liveServices = new Set();

after(async () => {
  globalThis.fetch = realFetch;
  for (const service of liveServices) {
    if (service?.store?.saveTimer !== undefined) {
      clearTimeout(service.store.saveTimer);
      service.store.saveTimer = undefined;
    }
  }
  liveServices.clear();
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

let counter = 0;
function boot() {
  process.env.DSH_HOME = join(sandbox, `home-${counter}`);
  counter += 1;
  const fake = createFakeContext({});
  globalThis.fetch = fake.state.fetch;
  const service = new RssService(fake.ctx, { pageGuard: async () => ({ ok: true }) });
  liveServices.add(service);
  return service;
}

/** 四路都造一条命中，并把它们的调用记下来。 */
function stubSources(service, overrides = {}) {
  const calls = { articles: 0, books: 0, papers: 0, diary: 0, links: null };
  service.searchArticlesDetailed = async () => {
    calls.articles += 1;
    return {
      results: [
        { key: 'https://a/1', titleZh: '甲文', channelName: '示例源', snippet: '…甲…', publishedAt: '2026-11-18T00:00:00.000Z' },
        { key: 'https://a/2', title: '乙文', channelName: '示例源', snippet: '', publishedAt: '' },
        { key: 'https://a/3', title: '丙文', channelName: '另一个源', snippet: '' },
      ],
      scanned: 12, truncatedScan: false, truncatedBodies: false,
    };
  };
  service.searchBookDigests = async () => {
    calls.books += 1;
    return { hits: [{ bookId: 'b1', bookTitle: '信任的代价', n: 3, chapterTitle: '转折', where: '摘要', snippet: '…赌局…' }], scanned: 4 };
  };
  service.papersSearch = async () => {
    calls.papers += 1;
    return { matched: 1, hits: [{ paper: { id: 'p1', title: 'Sparse Routing', year: 2024 }, snippet: '…routing…' }] };
  };
  const originalSearch = service.diary.search.bind(service.diary);
  service.diary.search = async (input) => {
    calls.diary += 1;
    if (overrides.diaryThrows) throw new Error('日记目录读不到');
    return { hits: [{ date: '2026-11-17', index: 1, kind: '读后感', source: '《信任的代价》', snippet: '…我想到…' }], scanned: 3, truncated: false };
  };
  const originalLinks = service.diary.linkCounts.bind(service.diary);
  service.diary.linkCounts = async (input) => {
    calls.links = input;
    if (overrides.linksThrow) throw new Error('反查坏了');
    return { articles: { 'https://a/1': 2 }, books: { b1: 1 }, scanned: 30, truncated: false };
  };
  if (overrides.articlesThrow) {
    service.searchArticlesDetailed = async () => { calls.articles += 1; throw new Error('订阅数据坏了'); };
  }
  return { calls, restore: () => { service.diary.search = originalSearch; service.diary.linkCounts = originalLinks; } };
}

describe('0.88.0：跨源检索聚合', () => {
  it('★ 四路都被调了，结果分四组回来', async () => {
    const service = boot();
    const { calls } = stubSources(service);
    const result = await service.searchAll({ query: '信任' });

    assert.deepEqual(calls.articles, 1);
    assert.deepEqual(calls.books, 1);
    assert.deepEqual(calls.papers, 1);
    assert.deepEqual(calls.diary, 1);
    assert.deepEqual(result.groups.map((group) => group.kind), ['article', 'book', 'paper', 'diary']);
    assert.equal(result.total, 3 + 1 + 1 + 1);
    assert.equal(result.empty, false);
    assert.equal(result.query, '信任');
  });

  it('★ 双链只对**显示出来的**条目反查，且按各自的键传下去', async () => {
    const service = boot();
    const { calls } = stubSources(service);
    const result = await service.searchAll({ query: '信任', limit: 2 });

    // 文章 3 条命中、limit 2 ⇒ 只反查前 2 条。
    assert.deepEqual(calls.links.articleKeys, ['https://a/1', 'https://a/2']);
    assert.deepEqual(calls.links.bookIds, ['b1']);
    const articles = result.groups.find((group) => group.kind === 'article');
    assert.equal(articles.hits[0].links?.notes, 2);
    assert.equal(articles.hits[1].links, undefined);
    assert.equal(articles.hidden, 1, '折叠的条数要报出来');
  });

  it('★ 一路失败 ⇒ 那一组空 + 备注原因，其它三路照常', async () => {
    const service = boot();
    stubSources(service, { diaryThrows: true });
    const result = await service.searchAll({ query: '信任' });
    const diary = result.groups.find((group) => group.kind === 'diary');
    assert.equal(diary.hits.length, 0);
    assert.ok(diary.note.includes('日记目录读不到'), '失败原因没带回来');
    // 反向对照：其它组不能跟着变空。
    assert.equal(result.groups.find((group) => group.kind === 'article').hits.length, 3);
    assert.equal(result.total, 5, '总数只该少掉日记那一条');
  });

  it('反查失败不影响检索结果本身', async () => {
    const service = boot();
    stubSources(service, { linksThrow: true });
    const result = await service.searchAll({ query: '信任' });
    assert.equal(result.empty, false);
    assert.equal(result.total, 6);
    const articles = result.groups.find((group) => group.kind === 'article');
    assert.equal(articles.hits.every((hit) => hit.links === undefined), true);
  });

  it('★ 空查询 ⇒ 一条源都不调（不白扫一遍全部日记）', async () => {
    const service = boot();
    const { calls } = stubSources(service);
    const result = await service.searchAll({ query: '   ' });
    assert.equal(calls.articles + calls.books + calls.papers + calls.diary, 0);
    assert.equal(result.empty, true);
    assert.equal(result.query, '');
  });

  it('limit 夹在 1..10（默认 5）', async () => {
    const service = boot();
    const { calls } = stubSources(service);
    await service.searchAll({ query: '信任', limit: 999 });
    // 999 被夹到 10 ⇒ 三条文章全在，且反查拿到三条 key。
    assert.equal(calls.links.articleKeys.length, 3);

    const again = boot();
    const second = stubSources(again);
    await again.searchAll({ query: '信任', limit: 0 });
    assert.equal(second.calls.links.articleKeys.length, 3, 'limit 0 应退回默认 5，而不是 0 条');
  });

  it('扫描量如实报出来（界面用它说「结果可能不全」）', async () => {
    const service = boot();
    stubSources(service);
    const result = await service.searchAll({ query: '信任' });
    assert.equal(result.scanned.articles, 12);
    assert.equal(result.scanned.books, 4);
    assert.equal(result.scanned.diary, 3);
  });
});
