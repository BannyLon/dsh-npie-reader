/**
 * 阅读周报的宿主侧集成（0.88.0）。
 *
 * `weekly.test.mjs` 已经把「边界与计数」用固定数据钉死了（24 条）。这一份测的是
 * 另一件事：**四份存储真的被接上了**。
 *
 * ★ 为什么必须单独测：`weeklyReport()` 里任何一路取错（把 `favorites` 当 `read`、
 *   忘了把 `sub.entries[].key` 建成回填表、划线窗口传成 0..0）都会让周报静默变成
 *   「这一周没有记录」—— 纯函数全绿、路由 200、界面还很正常地显示一句人话。
 *   所以这里每一条断言都要求**真数据能穿过来**，并配一条「别的周没有」的反向对照。
 *
 * ★ 时间不硬编码周键：`read{}` / `diary.append()` 写的都是「现在」，
 *   所以本周键用 `weekKeyOf(new Date())` 现算。硬写 `2026-W47` 的测试会在下周全红。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createFakeContext, rssDocument } from './helpers/fake-ctx.mjs';
import { loadHostBundle } from './helpers/host-bundle.mjs';
import { weekKeyOf } from '../src/host/weekly.js';

const sandbox = await mkdtemp(join(tmpdir(), 'npie-weekly-'));
process.env.DSH_HOME = sandbox;
process.env.HOME = sandbox;

const { RssService } = await loadHostBundle();

const realFetch = globalThis.fetch;
const liveServices = new Set();

after(async () => {
  globalThis.fetch = realFetch;
  for (const service of liveServices) {
    const store = service?.store;
    if (store?.saveTimer !== undefined) {
      clearTimeout(store.saveTimer);
      store.saveTimer = undefined;
    }
  }
  liveServices.clear();
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

let counter = 0;
function boot() {
  process.env.DSH_HOME = join(sandbox, `home-${counter}`);
  counter += 1;
  const feed = rssDocument({
    title: '示例源',
    items: [
      { title: '本周读到的第一篇', link: 'https://a.example/post/1', guid: 'g1' },
      { title: '本周读到的第二篇', link: 'https://a.example/post/2', guid: 'g2' },
    ],
  });
  // 同一个 feed 可能被取多次（加订阅 + 刷新），所以用 fallback 而不是队列。
  const fake = createFakeContext({ fetchFallback: () => ({ body: feed, status: 200 }) });
  globalThis.fetch = fake.state.fetch;
  const service = new RssService(fake.ctx, { pageGuard: async () => ({ ok: true }) });
  liveServices.add(service);
  return { service, fake };
}

describe('0.88.0：周报把四份存储接上了', () => {
  it('★ 已读 / 日记 / 划线都进得来，别的周是空的', async () => {
    const { service } = boot();
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    assert.ok(sub.entries.length >= 2, '夹具没造出条目，后面的断言就没有意义');

    await service.setRead({ keys: [sub.entries[0].key], read: true });
    await service.diary.append({ body: '今天想清楚一件事：先做窄的', kind: '灵感', mood: 4 });
    await service.annotationStore.add('b00001', { page: 3, start: 10, end: 24, quote: '一句原文', note: '' });

    const thisWeek = weekKeyOf(new Date());
    const { report } = await service.weeklyReport({ week: thisWeek, weeks: 2 });

    assert.equal(report.reading.articles, 1, '已读没进来');
    assert.equal(report.reading.titles[0]?.title, '本周读到的第一篇', '标题没有按 key 回填');
    assert.equal(report.reading.titles[0]?.feed, '示例源', '来源名没有回填');
    assert.ok(report.writing.entries >= 1, '日记没进来');
    assert.equal(report.writing.byKind['灵感'], 1);
    assert.equal(report.books.highlightCount, 1, '划线没进来');
    assert.equal(report.books.highlights[0]?.id, 'b00001');
    assert.equal(report.empty, false);

    // 反向对照：换一个很早的周，同样的数据一条都不该出现。
    const { report: old } = await service.weeklyReport({ week: '2020-W10', weeks: 1 });
    assert.equal(old.reading.articles, 0, '别的周也读到了本周的已读');
    assert.equal(old.writing.entries, 0, '别的周也读到了今天的日记');
    assert.equal(old.books.highlightCount, 0, '别的周也读到了刚落下的划线');
    assert.equal(old.empty, true);
  });

  it('★ 侧栏要的最近几周：一次给 4 周、按时间倒序、第一项就是当前周', async () => {
    const { service } = boot();
    const thisWeek = weekKeyOf(new Date());
    const { week, recent } = await service.weeklyReport({ week: thisWeek, weeks: 4 });
    assert.equal(week, thisWeek);
    assert.equal(recent.length, 4);
    assert.equal(recent[0].key, thisWeek);
    // 倒序：字符串比较即可，因为周键补了零（这就是补零的用处）。
    assert.deepEqual(recent.map((item) => item.key), [...recent.map((item) => item.key)].sort().reverse());
    // 每一行都要有一句话摘要，不能是空串（侧栏那一行就是靠它）。
    for (const item of recent) assert.ok(item.headline.length > 0, `${item.key} 没有摘要`);
  });

  it('★ 越界的周键报 BAD_WEEK（路由据此回 400，不是 500）', async () => {
    const { service } = boot();
    await assert.rejects(() => service.weeklyReport({ week: '2026-W99' }), (error) => {
      assert.equal(error.code, 'BAD_WEEK');
      return true;
    });
  });

  it('划线目录读不到时，周报说「不知道」而不是「0 处」', async () => {
    const { service } = boot();
    // 把目录指到一个不可能存在的位置：`recent()` 会吞掉除 ENOENT 之外的错误并回 null。
    service.annotationStore = {
      recent: async () => null,
    };
    const { report } = await service.weeklyReport({ week: weekKeyOf(new Date()), weeks: 1 });
    assert.equal(report.scanned.annotationsReadable, false);
    assert.equal(report.books.highlightCount, 0, '数量仍是 0（确实没数到），但界面靠 annotationsReadable 区分');
  });

  it('书单读不出来时周报仍然可用（书名退化成 id）', async () => {
    const { service } = boot();
    // ★ 先等一次 ready 再改 `store.data`：`ready` 那一步会 `load()` 重读 `data.json`，
    //   在此之前写进 `store.data` 的东西会被整块覆盖 —— 症状是「明明塞了状态，周报里
    //   一条都没有」，而代码看上去毫无问题（本用例第一版就是这么红的）。
    await service.listChannels();
    service.store.data.library.states = { b00099: { state: 'read', page: 10, pages: 10, at: Date.now(), finishedAt: Date.now() } };
    const { report } = await service.weeklyReport({ week: weekKeyOf(new Date()), weeks: 1 });
    assert.equal(report.books.finished.length, 1);
    assert.equal(report.books.finished[0].title, 'b00099', '书名没有兜底成 id');
  });
});
