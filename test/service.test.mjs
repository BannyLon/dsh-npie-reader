/**
 * RssService：Remote 导出清单、频道 key 回环、条目查询、订阅/OPML 往返、
 * 设置、文章与版本、刷新、AI 生成守卫。
 *
 * 两条本文件特有的纪律：
 *  1. `DSH_HOME` 指向临时目录，绝不让 store 落到用户真实数据目录。
 *  2. 频道 key 那条用例同时断言「集合基数」与「集合内逐元素性质」——
 *     只断言其中一个，写错前缀的 bug 会从缝里溜过去（entriesOf 对错误 key
 *     是**静默返回空数组**，不报错）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createFakeContext, rssDocument } from './helpers/fake-ctx.mjs';
import { loadHostBundle } from './helpers/host-bundle.mjs';
import { effectiveModelLabel } from '../src/ai-model.js';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(join(tmpdir(), 'npie-service-'));
process.env.DSH_HOME = sandbox;
/**
 * ★ `HOME` 也必须一起指到沙箱里。
 *
 * `RssService` 启动时会跑一次「把 `~/.baidu-pan-*.json` 迁移进插件数据目录」
 * （`migrateLegacyPanCredentials`，见 store.js）。那条路走的是 **`os.homedir()`**，
 * 不受 `DSH_HOME` 约束 —— 不隔离的话测试会去读**用户真实 home**：
 * 一边把真凭证复制进沙箱（污染「插件数据目录是空的」这类断言），
 * 一边可能拿着真 token 去请求百度。
 */
process.env.HOME = sandbox;

const { RssService, registeredRemoteMethods, apply: mountPlugin, remoteMethods: readRemoteMethods } = await loadHostBundle();

const realFetch = globalThis.fetch;

/**
 * 本文件启动过的 service。
 *
 * ★ 为什么要在 teardown 里先清计时器：`RssStore.touch()` 排的是 **500ms 去抖**落盘，
 *   而 teardown 是立刻 `rm -rf` 沙箱。计时器在 `rm` 遍历目录的过程中醒来 ⇒
 *   `mkdir` + `writeFile` 往正在被删的目录里塞文件 ⇒ **ENOTEMPTY** 让整个文件的
 *   收尾钩子失败（实测偶发，跑几次红一次）。这不是测试用例的问题，是收尾纪律的问题。
 *   只清计时器、**不 flush**：flush 是又写一遍，只会让竞态更容易发生。
 */
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
  // `maxRetries` 针对的正是 ENOTEMPTY / EBUSY：即使还有别的写入者，也给它几次机会。
  // ★ 但本机的 safe-delete 策略会拦「一次删整棵树」（bulk delete guard）：撞上它时
  //   `maxRetries` 只会把收尾钩子拖死，最终以 EPERM 让整个文件变红。清理失败不该
  //   等于断言失败 —— 所以不重试、吞掉错误。
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

/** Fresh service over a fake Cordis ctx; `fetch` is installed globally because
 *  service.js uses the platform fetch, not a ctx service.
 *
 *  ★ Every boot gets its own DSH_HOME. Sharing one would let an earlier test's
 *  flushed `data.json` leak into the next service's `load()` — which shows up as
 *  a bogus "该订阅已存在" instead of an obvious isolation failure. */
let homeCounter = 0;
function boot(options = {}) {
  process.env.DSH_HOME = join(sandbox, `home-${homeCounter}`);
  homeCounter += 1;
  const fake = createFakeContext(options);
  globalThis.fetch = fake.state.fetch;
  /* ★ 地址守卫默认**放行**：这一批用例里的域名全是 `blog.example.org` 这种假名字，
     真守卫会去查 DNS、查不到就拒 ⇒「抓不抓、抓到什么」这些真正要测的东西全被挡在
     门外。守卫本身在 `test/net-guard.test.mjs`（27 条）；「service 真的把守卫接上了」
     由本文件「守卫拒绝时退回摘要」那一条钉住 —— 传一个一律拒绝的 pageGuard。 */
  const pageGuard = options.pageGuard ?? (async () => ({ ok: true }));
  const service = new RssService(fake.ctx, { pageGuard });
  liveServices.add(service);
  return { ...fake, service };
}

const REMOTE_METHODS = [
  'addCatalogSource', 'addSubscription', 'aiModelInfo', 'backfillSubscription', 'fetchFullText', 'generateVersion', 'getArticle',
  'getSettings', 'getVersionContent', 'listAiModels', 'listCatalog', 'listChannels', 'listEntries',
  'listSubscriptions', 'opmlExport', 'opmlImport', 'opmlPreview', 'prepareChat', 'probeCatalogService',
  'refresh', 'removeCatalogSource', 'removeSubscription', 'saveSettings', 'searchArticles', 'setBookContext',
  'setCatalogHidden', 'setCatalogService', 'setFavorite', 'setRead', 'setReadingContext', 'updateSubscription',
];

// ★ 这张表是**契约快照**，不是「大概有哪些」：多一个少一个都必须在这里改一次，
//   否则新工具会静默上线而没人注意。0.20.0 加了五个 `book_*`（读电子书），
//   0.20.1 才发现这里还停在 9 个 —— 说明当时的全量测试没有真跑完。
const TOOL_NAMES = [
  'book_annotations', 'book_chapter', 'book_export_skill', 'book_list', 'book_outline', 'book_search',
  'rss_add_subscription', 'rss_digest', 'rss_generate_version', 'rss_list_articles', 'rss_list_channels',
  'rss_read_article', 'rss_refresh', 'rss_remove_subscription', 'rss_search_articles',
];

// ---------------------------------------------------------------------------
// Remote manifest — host half vs client half
// ---------------------------------------------------------------------------

describe('Remote manifest', () => {
  it('exports exactly the documented method set', () => {
    assert.deepEqual(registeredRemoteMethods.map((entry) => entry.name).sort(), REMOTE_METHODS);
  });

  it('every exported name is a real prototype method', () => {
    for (const { name } of registeredRemoteMethods) {
      assert.equal(typeof RssService.prototype[name], 'function', `${name} must exist on RssService.prototype`);
    }
  });

  it('the client half declares exactly the same method set as the host exports', async () => {
    // 跨半区契约：客户端 $mount 的 descriptor 若漏了/多了一个方法，
    // 表现是运行期「某个按钮点了没反应」，而不是启动报错 —— 只有这里能提前抓到。
    const source = await readFile(join(pluginRoot, 'src/client/index.jsx'), 'utf8');
    const start = source.indexOf('descriptors: [');
    assert.notEqual(start, -1, 'client index.jsx must declare a descriptors list');
    const block = source.slice(start, source.indexOf('\n};', start));
    const declared = [...block.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(declared, REMOTE_METHODS);
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('construction', () => {
  it('declares its hard dependencies and registers the agent tools', async () => {
    const { service, state } = boot();
    await service.ready;

    assert.deepEqual(RssService.inject, ['tools', 'llm', 'agentDefaultModel']);
    assert.deepEqual(state.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  });

  it('contributes an empty reading context until one is set for the session', async () => {
    const { service, state } = boot();
    await service.ready;

    // 两条条件注入，顺序即源码顺序：阅读上下文 + 书架路由。
    // ★ `webServer` 只以**条件注入**出现，绝不进 `RssService.inject`：硬门禁上少一个
    //   服务会让 fiber 永久 pending，而这个插件挂的正是整个 web GUI —— 后果是整个界面起不来。
    assert.deepEqual(state.injects, [['systemPrompt'], ['webServer']]);
    assert.deepEqual(RssService.inject, ['tools', 'llm', 'agentDefaultModel']);
    assert.equal(state.systemPromptContributions.length, 1);
    const contribution = state.systemPromptContributions[0];
    assert.equal(contribution.name, 'npie-reader:reading');
    assert.equal(contribution.order, 9500);
    assert.equal(contribution.interpolate, false);
    assert.equal(contribution.text({ agent: { session: { id: 'nobody' } } }), '');
    assert.equal(contribution.text({}), '');
  });
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

describe('channels', () => {
  const feed = () => ({
    fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'Post One' }, { title: 'Post Two' }] }) }],
  });

  it('a feed channel key round-trips back to that subscription and its entries', async () => {
    const { service } = boot(feed());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const { channels } = await service.listChannels();
    const feedChannels = channels.filter((channel) => channel.kind === 'feed');
    const ids = new Set((await service.listSubscriptions()).subscriptions.map((item) => item.id));

    // 集合基数 + 逐元素性质写在同一条用例里：只断言基数会漏掉「key 多一层前缀」
    // 这种形状错误，而 entriesOf 对错误 key 是静默返回空数组。
    assert.equal(feedChannels.length, 1);
    for (const channel of feedChannels) {
      assert.ok(ids.has(channel.key), `channel key ${channel.key} must be a subscription id`);
      assert.equal(channel.key, sub.id);
      assert.ok(!channel.key.startsWith('feed:feed:'), 'the key must carry exactly one prefix');
      assert.equal(service.entriesOf(channel.key).length, channel.total);
      assert.equal(channel.total, 2);
      assert.equal(channel.unread, 2);
    }
    assert.equal(service.entriesOf(sub.id).length, 2, 'the id the client holds must resolve');
    // 反向对照：剥掉一层前缀的裸 hash **不能**解析。查表用的是完整 id，
    // 谁把 `channel.slice('feed:'.length)` 加回去，这条立刻判红。
    assert.deepEqual(service.entriesOf(sub.id.slice('feed:'.length)), []);
  });

  it('keeps the aggregate and group channels consistent with their members', async () => {
    const { service } = boot({
      fetchPlan: [
        { body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }) },
        { body: rssDocument({ title: 'Feed B', items: [{ title: 'B1' }, { title: 'B2' }] }) },
      ],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml', group: '科技' });
    await service.addSubscription({ url: 'https://b.example/feed.xml', group: '科技' });

    const { channels } = await service.listChannels();
    const all = channels.find((channel) => channel.key === 'all');
    const mine = channels.find((channel) => channel.key === 'feeds:all');
    const group = channels.find((channel) => channel.key === 'group:科技');

    assert.equal(all.unread, 3);
    assert.equal(mine.unread, 3);
    assert.equal(group.unread, 3);
    assert.equal(service.entriesOf('all').length, 3);
    assert.equal(service.entriesOf('group:科技').length, 3);
    assert.equal(service.entriesOf('group:不存在').length, 0);
    assert.equal(service.entriesOf('nonsense').length, 0);

    // 聚合频道的 `total` 必须是真实条数，不能是占位的 0：客户端拿它判断
    // 「这个频道已经有文章了，别再自动刷」。反向对照 —— 把这三处写回 `total: 0`
    // （旧写法），客户端那条守卫就恒不成立，加一个订阅会顺带重抓全部源。
    assert.equal(all.total, 3);
    assert.equal(mine.total, 3);
    assert.equal(group.total, 3);

    // Entries carry the channel name for display.
    assert.deepEqual([...new Set(service.entriesOf('all').map((entry) => entry.channelName))].sort(), ['Feed A', 'Feed B']);
  });

  it('stops counting an entry as unread once it is read', async () => {
    const { service } = boot(feed());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.setRead({ keys: [sub.entries[0].key], read: true });

    const { channels } = await service.listChannels();
    assert.equal(channels.find((channel) => channel.key === sub.id).unread, 1);
    assert.equal(channels.find((channel) => channel.key === 'all').unread, 1);
  });
});

// ---------------------------------------------------------------------------
// 源新鲜度：第三方源会悄悄停更，界面必须说得出「多久没更新」
// ---------------------------------------------------------------------------

describe('源新鲜度字段', () => {
  it('feed 频道带上最近抓取时间与该源最新一篇的时间', async () => {
    const { service } = boot({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [
            { title: 'Old', pubDate: 'Mon, 01 Sep 2025 00:00:00 GMT' },
            { title: 'New', pubDate: 'Wed, 01 Oct 2025 00:00:00 GMT' },
          ],
        }),
      }],
    });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const { channels } = await service.listChannels();
    const channel = channels.find((item) => item.key === sub.id);

    assert.equal(channel.newestEntryAt, Date.parse('Wed, 01 Oct 2025 00:00:00 GMT'), '取的是最新那一篇，不是第一篇');
    assert.ok(channel.lastFetchedAt > 0);
    // 反向对照：聚合频道的值必须等于成员里的最新值，不能是 0 或 undefined。
    const all = channels.find((item) => item.key === 'feeds:all');
    assert.equal(all.newestEntryAt, channel.newestEntryAt);
    assert.equal(all.lastFetchedAt, channel.lastFetchedAt);
  });

  it('一条都没抓到的源不撒谎说「今天有更新」', async () => {
    const { service } = boot({ fetchPlan: [{ throw: new Error('fetch failed') }] });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://dead.example/feed.xml' });
    const { channels } = await service.listChannels();
    const channel = channels.find((item) => item.key === sub.id);

    // 必须是 undefined，不能是 0：0 是合法时间戳（1970 年），客户端会算成两万天。
    assert.equal(channel.newestEntryAt, undefined);
    assert.equal(channel.lastFetchedAt, undefined);
    assert.equal(channel.lastError, 'fetch failed');
    assert.equal(channels.find((item) => item.key === 'feeds:all').newestEntryAt, undefined);
  });
});

// ---------------------------------------------------------------------------
// 原地换源：第三方代理失效时的正路
// ---------------------------------------------------------------------------

describe('updateSubscription 换地址', () => {
  it('清空旧条目、立刻重抓，并保留 id / 分组 / 名称', async () => {
    const { service } = boot({
      fetchPlan: [
        { body: rssDocument({ title: '旧源', items: [{ title: 'Old A' }] }) },
        { body: rssDocument({ title: '新源', items: [{ title: 'New A' }, { title: 'New B' }] }) },
      ],
    });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://old.example/feed.xml', name: '我起的名字', group: '科技' });
    assert.equal(sub.entries.length, 1);

    const updated = await service.updateSubscription({ id: sub.id, name: '我起的名字', group: '科技', url: 'https://new.example/feed.xml' });
    // id 不能换：阅读记录 / 收藏 / 客户端当前频道都挂在它上面。
    assert.equal(updated.id, sub.id);
    assert.equal(updated.url, 'https://new.example/feed.xml');
    assert.equal(updated.name, '我起的名字');
    assert.equal(updated.group, '科技');
    assert.equal(updated.status, 'ok');
    assert.equal(updated.lastError, undefined);
    assert.deepEqual(updated.entries.map((entry) => entry.title), ['New A', 'New B']);
    assert.equal(service.entriesOf(sub.id).length, 2, '换源后频道 key 必须立刻解析到新内容');
  });

  it('换到一个抓不到的新地址时留下失败原因，而不是静默变空', async () => {
    const { service } = boot({
      fetchPlan: [
        { body: rssDocument({ title: '旧源', items: [{ title: 'Old A' }] }) },
        { throw: new Error('fetch failed') },
      ],
    });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://old.example/feed.xml' });
    const updated = await service.updateSubscription({ id: sub.id, url: 'https://dead.example/feed.xml' });

    assert.equal(updated.status, 'error');
    assert.equal(updated.lastError, 'fetch failed');
    assert.equal(updated.entries.length, 0);
  });

  it('拒绝非法地址与撞车的地址，且不留半改状态', async () => {
    const { service } = boot({
      fetchPlan: [
        { body: rssDocument({ title: 'A', items: [{ title: 'A1' }] }) },
        { body: rssDocument({ title: 'B', items: [{ title: 'B1' }] }) },
      ],
    });
    await service.ready;
    const a = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const b = await service.addSubscription({ url: 'https://b.example/feed.xml' });

    await assert.rejects(() => service.updateSubscription({ id: a.id, url: 'ftp://a.example/feed.xml' }), /http\(s\) URL/);
    await assert.rejects(() => service.updateSubscription({ id: a.id, url: 'https://b.example/feed.xml' }), /该订阅已存在/);

    // 反向对照：被拒绝的请求不能改到任何东西 —— 校验必须发生在写入之前。
    assert.equal(service.store.subscriptionById(a.id).url, 'https://a.example/feed.xml');
    assert.equal(service.entriesOf(a.id).length, 1);
    assert.equal(service.entriesOf(b.id).length, 1);
  });

  it('地址没变时不重抓', async () => {
    const { service, state } = boot({
      fetchPlan: [{ body: rssDocument({ title: 'A', items: [{ title: 'A1' }] }) }],
    });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const before = state.fetchCalls.length;
    await service.updateSubscription({ id: sub.id, url: sub.url, group: '新分组' });

    // 反向对照：同地址不该触发 fetch，否则每次改名 / 改分组都白抓一遍。
    assert.equal(state.fetchCalls.length, before);
    assert.equal(service.store.subscriptionById(sub.id).group, '新分组');
  });
});

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

describe('listEntries', () => {
  const threeItems = () => ({
    fetchPlan: [{
      body: rssDocument({
        title: 'Feed A',
        items: [
          { title: 'Alpha', pubDate: 'Wed, 24 Sep 2025 08:00:00 GMT' },
          { title: 'Beta', pubDate: 'Thu, 25 Sep 2025 08:00:00 GMT' },
          { title: 'Gamma', pubDate: 'Fri, 26 Sep 2025 08:00:00 GMT' },
        ],
      }),
    }],
  });

  it('sorts newest first and pages with a cursor', async () => {
    const { service } = boot(threeItems());
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const first = await service.listEntries({ channel: 'all', limit: 2 });
    assert.deepEqual(first.entries.map((entry) => entry.title), ['Gamma', 'Beta']);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, 'off:2');

    const second = await service.listEntries({ channel: 'all', limit: 2, cursor: first.nextCursor });
    assert.deepEqual(second.entries.map((entry) => entry.title), ['Alpha']);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, undefined, 'no cursor must be offered when there is nothing left');
  });

  it('clamps the page size instead of trusting the caller', async () => {
    const { service } = boot(threeItems());
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    assert.equal((await service.listEntries({ limit: 0 })).entries.length, 1);
    assert.equal((await service.listEntries({ limit: 1000 })).entries.length, 3);
    assert.equal((await service.listEntries({ limit: -5 })).entries.length, 1);
  });

  it('filters by read state, favourites, and a search needle', async () => {
    const { service } = boot(threeItems());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.setRead({ keys: [sub.entries[0].key], read: true });
    await service.setFavorite({ key: sub.entries[1].key, favorite: true });

    const unread = await service.listEntries({ filter: 'unread' });
    assert.equal(unread.entries.length, 2);
    assert.ok(unread.entries.every((entry) => entry.read === false));

    const favorites = await service.listEntries({ filter: 'favorite' });
    assert.equal(favorites.entries.length, 1);
    assert.equal(favorites.entries[0].favorite, true);

    const searched = await service.listEntries({ search: 'gam' });
    assert.deepEqual(searched.entries.map((entry) => entry.title), ['Gamma']);

    // A blank needle must not filter everything out.
    assert.equal((await service.listEntries({ search: '   ' })).entries.length, 3);
  });

  it('hides thumbnails when the reader turned images off', async () => {
    const { service } = boot({
      fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'With image', description: '<p>x</p><img src="https://a.example/i.png">' }] }) }],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    assert.equal((await service.listEntries({})).entries[0].image, 'https://a.example/i.png');
    await service.saveSettings({ patch: { showImages: false } });
    assert.equal((await service.listEntries({})).entries[0].image, undefined);
  });
});

describe('searchArticles', () => {
  it('returns nothing for a blank query and respects the limit', async () => {
    const { service } = boot({
      fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'Alpha' }, { title: 'Alphabet' }, { title: 'Beta' }] }) }],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    assert.deepEqual(await service.searchArticles({ query: '  ' }), []);
    assert.equal((await service.searchArticles({ query: 'alpha' })).length, 2);
    assert.equal((await service.searchArticles({ query: 'alpha', limit: 1 })).length, 1);
    assert.equal((await service.searchArticles({ query: 'nothing' })).length, 0);
  });

  it('★ 命中正文，而不只是标题', async () => {
    // 检索词埋在正文第 280 个字符之后：摘要只截前 180 字符，所以它既不在标题里、
    // 也不在摘要里 —— 旧实现（只匹配标题）在这条用例上返回 0 条。
    const body = `<p>${'filler '.repeat(40)}DeepSeek-V3 的架构评估</p>`;
    const { service } = boot({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [{ title: 'Weekly roundup', description: '<p>完全无关的内容</p>' }, { title: 'Model release', description: body }],
        }),
      }],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const hits = await service.searchArticles({ query: 'DeepSeek-V3' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].matchedIn, 'body');
    assert.match(hits[0].snippet, /DeepSeek-V3/);
    assert.doesNotMatch(hits[0].title, /DeepSeek/);
    assert.doesNotMatch(hits[0].summary ?? '', /DeepSeek/);
  });

  it('channels 限定范围；不传就是全部；给了不存在的 key 就是空', async () => {
    const { service } = boot({
      fetchPlan: [
        { body: rssDocument({ title: 'Feed A', items: [{ title: 'Alpha about deepseek' }] }) },
        { body: rssDocument({ title: 'Feed B', items: [{ title: 'Beta about deepseek' }] }) },
      ],
    });
    await service.ready;
    const a = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });

    assert.equal((await service.searchArticles({ query: 'deepseek' })).length, 2);
    const scoped = await service.searchArticles({ query: 'deepseek', channels: [a.id] });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].title, 'Alpha about deepseek');
    // 反向对照：不存在的频道 key 必须回空。静默「退回全部」会让用户以为限定生效了，
    // 结果拿到的却是别的源的内容 —— 看起来完全正常，只是范围错了。
    assert.deepEqual(await service.searchArticles({ query: 'deepseek', channels: ['feed:nope'] }), []);
  });

  it('时间窗排除窗口外的条目，并把「没有发布时间」的条数报出来', async () => {
    const day = 86_400_000;
    const { service } = boot({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [
            { title: 'recent deepseek', pubDate: new Date(Date.now() - day).toUTCString() },
            { title: 'old deepseek', pubDate: new Date(Date.now() - 30 * day).toUTCString() },
            { title: 'undated deepseek', pubDate: '' },
          ],
        }),
      }],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const detail = await service.searchArticlesDetailed({ query: 'deepseek', since: '7d' });
    assert.equal(detail.results.length, 1);
    assert.equal(detail.results[0].title, 'recent deepseek');
    // ★ 这两个数字必须一起出来：只说「命中 1 条」，模型会把「另有 1 条没有时间被排除」
    //   读成「就这么多」，于是给出建立在缺失数据上的结论。
    assert.equal(detail.undatedExcluded, 1);
    assert.match(detail.window, /^≥ \d{4}-\d{2}-\d{2}$/);
    // Remote 面（数组形态）同样要应用时间窗。
    assert.equal((await service.searchArticles({ query: 'deepseek', since: '7d' })).length, 1);
  });

  it('按需读过的正文缓存也要能搜到 —— 正文有两个来源', async () => {
    const { service } = boot({
      fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'Plain title' }] }) }],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const [entry] = (await service.listEntries({})).entries;

    assert.equal((await service.searchArticles({ query: 'uniquephrase' })).length, 0);
    service.store.putArticle({ key: entry.key, html: '<p>a uniquephrase lives here</p>', title: entry.title });
    const hits = await service.searchArticles({ query: 'uniquephrase' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].matchedIn, 'body');
  });
});

describe('listEntries 时间窗', () => {
  it('按窗口过滤，并报出被排除的无时间条目数', async () => {
    const day = 86_400_000;
    const { service } = boot({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [
            { title: 'fresh', pubDate: new Date(Date.now() - day).toUTCString() },
            { title: 'stale', pubDate: new Date(Date.now() - 40 * day).toUTCString() },
            { title: 'undated', pubDate: '' },
          ],
        }),
      }],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const page = await service.listEntries({ since: '3d' });
    assert.deepEqual(page.entries.map((entry) => entry.title), ['fresh']);
    assert.equal(page.undatedExcluded, 1);
    assert.equal(page.matched, 1);
    assert.match(page.window, /^≥ \d{4}-\d{2}-\d{2}$/);

    // 反向对照：不设窗口时不该出现这几个字段，也不该排除任何条目。
    const all = await service.listEntries({});
    assert.equal(all.entries.length, 3);
    assert.equal(all.undatedExcluded, undefined);
    assert.equal(all.window, undefined);
  });

  it('★ 上限提到 300：窗口一长，50 条装不下就会把「没要够」读成「就这么多」', async () => {
    const items = Array.from({ length: 120 }, (_, index) => ({ title: `T${index}` }));
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    assert.equal((await service.listEntries({ limit: 500 })).entries.length, 120);
    assert.equal((await service.listEntries({ limit: 10 })).entries.length, 10);
  });
});

describe('digest', () => {
  it('按频道分组，给出每组条数与未读；不传 channels 就是全部', async () => {
    const { service } = boot({
      fetchPlan: [
        { body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }, { title: 'A2' }] }) },
        { body: rssDocument({ title: 'Feed B', items: [{ title: 'B1' }] }) },
      ],
    });
    await service.ready;
    const a = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });
    const [first] = (await service.listEntries({ channel: a.id })).entries;
    await service.setRead({ keys: [first.key], read: true });

    const all = await service.digest({});
    assert.equal(all.groups.length, 1);
    assert.equal(all.groups[0].key, 'all');
    assert.equal(all.groups[0].name, '全部订阅');
    assert.equal(all.total, 3);

    const two = await service.digest({ channels: [a.id, 'feed:nope'] });
    assert.equal(two.channels, 2);
    assert.equal(two.groups[0].name, 'Feed A');
    assert.equal(two.groups[0].total, 2);
    assert.equal(two.groups[0].unread, 1);
    // 反向对照：不存在的频道 key 就是 0 条，不能静默退回「全部」。
    assert.equal(two.groups[1].total, 0);
    assert.deepEqual(two.groups[1].entries, []);
  });

  it('perChannel 封顶；时间窗过滤 + 无时间条目计数', async () => {
    const day = 86_400_000;
    const items = [
      { title: 'ancient', pubDate: new Date(Date.now() - 60 * day).toUTCString() },
      ...Array.from({ length: 11 }, (_, index) => ({ title: `T${index}`, pubDate: new Date(Date.now() - (index + 1) * 3_600_000).toUTCString() })),
    ];
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const wide = await service.digest({ perChannel: 100 });
    assert.equal(wide.perChannel, 30, 'perChannel 必须封顶');
    assert.equal(wide.groups[0].total, 12);
    assert.equal(wide.groups[0].entries.length, 12);

    const windowed = await service.digest({ since: '3d' });
    assert.equal(windowed.groups[0].total, 11, '60 天前那条要被窗口排除');
    assert.match(windowed.window, /^≥ \d{4}-\d{2}-\d{2}$/);
  });

  it('反向对照：窗口内一条都没有时，分组仍然存在（好让模型看出「这几份源没说话」）', async () => {
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }) }] });
    await service.ready;
    const a = await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const result = await service.digest({ channels: [a.id], until: '2020-01-01' });
    assert.equal(result.total, 0);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].total, 0);
    assert.equal(result.groups[0].name, 'Feed A');
  });
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

describe('addSubscription', () => {
  it('rejects anything that is not an http(s) url', async () => {
    const { service } = boot();
    await service.ready;
    await assert.rejects(() => service.addSubscription({ url: 'ftp://a.example/feed' }), /http\(s\) URL/);
    await assert.rejects(() => service.addSubscription({ url: 'file:///etc/passwd' }), /http\(s\) URL/);
    await assert.rejects(() => service.addSubscription({}), /http\(s\) URL/);
  });

  it('refuses a duplicate, comparing urls without their trailing slash', async () => {
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A' }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await assert.rejects(() => service.addSubscription({ url: 'https://a.example/feed.xml/' }), /已存在/);
  });

  it('keeps an unreachable feed and records why it failed', async () => {
    const { service } = boot({ fetchPlan: [{ throw: new Error('network down') }] });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://dead.example/feed.xml' });

    assert.equal(sub.status, 'error');
    assert.equal(sub.lastError, 'network down');
    assert.deepEqual(sub.entries, []);
    assert.equal(sub.name, 'https://dead.example/feed.xml', 'falls back to the url when the feed never parsed');
    assert.equal((await service.listSubscriptions()).subscriptions.length, 1);
  });

  it('turns an HTTP error status into a recorded failure, not a thrown one', async () => {
    const { service } = boot({ fetchPlan: [{ status: 503 }] });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://busy.example/feed.xml' });
    assert.equal(sub.status, 'error');
    assert.match(sub.lastError, /HTTP 503/);
  });

  it('prefers an explicit name over the feed title', async () => {
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A' }) }] });
    await service.ready;
    const named = await service.addSubscription({ url: 'https://a.example/feed.xml', name: '  我的源  ' });
    assert.equal(named.name, '我的源');
    assert.equal(named.entries[0]?.channelName ?? '我的源', '我的源');
  });
});

describe('updateSubscription / removeSubscription', () => {
  it('renames the subscription and every entry it already cached', async () => {
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }) }] });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    assert.equal(sub.entries[0].channelName, 'Feed A');

    const updated = await service.updateSubscription({ id: sub.id, name: '新名字', group: '科技' });
    assert.equal(updated.name, '新名字');
    assert.equal(updated.group, '科技');
    assert.equal(updated.entries[0].channelName, '新名字', 'cached entries must follow the rename');
    assert.equal((await service.listChannels()).channels.some((channel) => channel.key === 'group:科技'), true);
  });

  it('clears the group when given a blank one and rejects an unknown id', async () => {
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A' }) }] });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml', group: '科技' });
    const updated = await service.updateSubscription({ id: sub.id, group: '   ' });
    assert.equal(updated.group, undefined);
    await assert.rejects(() => service.updateSubscription({ id: 'feed:nope', name: 'x' }), /no subscription/);
  });

  it('removes by id or by url and reports whether anything happened', async () => {
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A' }) }] });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });

    assert.equal(await service.removeSubscription({ id: 'feed:nope' }), false);
    assert.equal(await service.removeSubscription({ id: sub.id }), true);
    assert.equal(await service.removeSubscription({ id: sub.id }), false);

    const again = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    assert.equal(await service.removeSubscription({ id: 'https://a.example/feed.xml' }), true);
    assert.equal(await service.removeSubscription({ id: again.id }), false);
  });
});

// ---------------------------------------------------------------------------
// 探索目录：用户可自定义、可隐藏
// ---------------------------------------------------------------------------

describe('探索目录（自定义信息源）', () => {
  it('新装的插件目录是空的，不是 undefined', async () => {
    // 界面第一件事就是 `api.listCatalog().then(setOwn)`。回 undefined 会让
    // `own.sources` 直接抛 TypeError，整个探索页白屏 —— 所以这里钉的是**形状**。
    const { service } = boot();
    assert.deepEqual(await service.listCatalog(), { sources: [], hidden: [], service: { base: '' } });
  });

  it('加上一条自己的源：id 由地址派生、分类缺省为「我的源」', async () => {
    const { service } = boot();
    const entry = await service.addCatalogSource({ name: '嗯哌', url: 'https://npie.example/feed.xml' });
    assert.match(entry.id, /^cat:/);
    assert.equal(entry.name, '嗯哌');
    assert.equal(entry.category, '我的源');
    assert.equal(typeof entry.addedAt, 'number');

    const { sources } = await service.listCatalog();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, 'https://npie.example/feed.xml');
  });

  it('同一个地址再加一次是**更新那一条**，不是多出一行', async () => {
    const { service } = boot();
    const first = await service.addCatalogSource({ name: '嗯哌', url: 'https://npie.example/feed.xml', category: '公众号' });
    const second = await service.addCatalogSource({ name: '嗯哌（改名）', url: 'https://npie.example/feed.xml', category: '行业观察' });

    assert.equal(second.id, first.id);
    // 集合基数与元素性质一起断言：只断言「有一条」会漏掉「多出一条旧的」。
    const { sources } = await service.listCatalog();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].name, '嗯哌（改名）');
    assert.equal(sources[0].category, '行业观察');
    assert.equal(sources[0].addedAt, first.addedAt);
  });

  it('地址两边的空白被裁掉，所以「粘贴时多带一个空格」不会变成两条', async () => {
    const { service } = boot();
    const first = await service.addCatalogSource({ name: 'A', url: 'https://npie.example/feed.xml' });
    const second = await service.addCatalogSource({ name: 'B', url: '  https://npie.example/feed.xml  ' });
    assert.equal(second.id, first.id);
    assert.equal((await service.listCatalog()).sources.length, 1);
    assert.equal(second.url, 'https://npie.example/feed.xml');
  });

  it('反向对照：非法地址与空名称被拒，且**不留半条记录**', async () => {
    const { service } = boot();
    await assert.rejects(() => service.addCatalogSource({ name: '嗯哌', url: 'npie.example/feed.xml' }), /http\(s\) URL/);
    await assert.rejects(() => service.addCatalogSource({ name: '嗯哌', url: 'file:///etc/hosts' }), /http\(s\) URL/);
    await assert.rejects(() => service.addCatalogSource({ name: '   ', url: 'https://npie.example/feed.xml' }), /起个名字/);
    await assert.rejects(() => service.addCatalogSource(), /http\(s\) URL/);
    // 校验在写入之前 ⇒ 目录必须一个字节都没动。
    assert.deepEqual((await service.listCatalog()).sources, []);
  });

  it('删除按 id；删不存在的返回 false 而不是抛错', async () => {
    const { service } = boot();
    const entry = await service.addCatalogSource({ name: '嗯哌', url: 'https://npie.example/feed.xml' });
    assert.equal(await service.removeCatalogSource('cat:nope'), false);
    assert.equal(await service.removeCatalogSource({ id: entry.id }), true);
    assert.equal(await service.removeCatalogSource({ id: entry.id }), false);
    assert.equal(await service.removeCatalogSource(''), false);
    assert.deepEqual((await service.listCatalog()).sources, []);
  });

  it('隐藏内置项按 url 记，重复隐藏不会堆出重复条目；取消隐藏能拿回来', async () => {
    const { service } = boot();
    const url = 'https://rss.t5t6.com/weread/MP_WXS_3988614169.xml';
    await service.setCatalogHidden({ url, hidden: true });
    await service.setCatalogHidden({ url, hidden: true });
    assert.deepEqual((await service.listCatalog()).hidden, [url]);

    const restored = await service.setCatalogHidden({ url, hidden: false });
    assert.deepEqual(restored.hidden, []);
    // 取消隐藏一个本来就没隐藏的 url 不算错。
    assert.deepEqual((await service.setCatalogHidden({ url, hidden: false })).hidden, []);
  });

  it('反向对照：隐藏不给 url 就报错，不能静默把空串塞进列表', async () => {
    const { service } = boot();
    await assert.rejects(() => service.setCatalogHidden({ hidden: true }), /缺少 url/);
    await assert.rejects(() => service.setCatalogHidden({ url: '   ', hidden: true }), /缺少 url/);
    assert.deepEqual((await service.listCatalog()).hidden, []);
  });

  it('自定义源与隐藏列表互不干扰，且都能跨重启读回来', async () => {
    const { service } = boot();
    const entry = await service.addCatalogSource({ name: '嗯哌', url: 'https://npie.example/feed.xml' });
    const url = 'https://weekly.tw93.fun/rss.xml';
    await service.setCatalogHidden({ url, hidden: true });

    // 同一个 DSH_HOME 再起一个 service：落盘 → 重新 load 的往返。
    const again = new RssService(createFakeContext({}).ctx, {});
    liveServices.add(again);
    const reloaded = await again.listCatalog();
    assert.deepEqual(reloaded.hidden, [url]);
    assert.equal(reloaded.sources.length, 1);
    assert.equal(reloaded.sources[0].id, entry.id);
    assert.equal(reloaded.sources[0].name, '嗯哌');
  });
});

// ---------------------------------------------------------------------------
// 「公众号 → RSS」服务：记住地址 + 探活
// ---------------------------------------------------------------------------

describe('转 RSS 服务', () => {
  it('保存地址时归一：去掉尾部斜杠与查询串', async () => {
    const { service } = boot();
    const saved = await service.setCatalogService({ base: 'http://localhost:4000/' });
    assert.equal(saved.service.base, 'http://localhost:4000');
    const again = await service.setCatalogService({ base: '  http://localhost:4000/feeds?x=1#y  ' });
    assert.equal(again.service.base, 'http://localhost:4000/feeds');
  });

  it('空串是合法的「清空」，不是错误', async () => {
    // 不允许空串，用户就没有办法把配错的地址删掉。
    const { service } = boot();
    await service.setCatalogService({ base: 'http://localhost:4000' });
    const cleared = await service.setCatalogService({ base: '' });
    assert.equal(cleared.service.base, '');
    assert.equal((await service.listCatalog()).service.base, '');
  });

  it('反向对照：非 http(s) 与带账号密码的地址被拒，且不留半改状态', async () => {
    const { service } = boot();
    await service.setCatalogService({ base: 'http://localhost:4000' });
    // ★ 「忘了写 http://」是最常见的输入错误，而 `new URL('localhost:4000')` **不抛错**
    //   （它把 `localhost:` 当协议名）⇒ 只有协议白名单能拦住它。这里专门钉住这一条。
    await assert.rejects(() => service.setCatalogService({ base: 'localhost:4000' }), /必须以 http:\/\/ 或 https:\/\//);
    await assert.rejects(() => service.setCatalogService({ base: 'file:///etc/hosts' }), /必须以 http:\/\/ 或 https:\/\//);
    await assert.rejects(() => service.setCatalogService({ base: '不是地址' }), /http\(s\):\/\/主机:端口/);
    await assert.rejects(() => service.setCatalogService({ base: 'http://user:pw@localhost:4000' }), /不能带账号密码/);
    // 四次都该被拦在写入之前 —— 原来那个好地址必须原封不动。
    assert.equal((await service.listCatalog()).service.base, 'http://localhost:4000');
  });

  it('探活：服务没起来时如实报「连不上」，而不是抛错', async () => {
    const { service } = boot({ fetchPlan: [{ throw: new Error('fetch failed') }] });
    const result = await service.probeCatalogService({ base: 'http://localhost:4000' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'unreachable');
    assert.match(result.error, /fetch failed/);
  });

  it('探活：SPA 后台返回 HTML 算**正常**，不许报成配置错误', async () => {
    // wewe-rss 的后台就是个网页。把「不是 feed」当错误，会把好配置说成坏的，
    // 用户就会去瞎改一个本来对的地址。
    const { service } = boot({ fetchPlan: [{ body: '<!doctype html><html><head><title>WeWe RSS</title></head></html>', contentType: 'text/html' }] });
    const result = await service.probeCatalogService({ base: 'http://localhost:4000' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.kind, 'html');
    assert.equal(result.title, 'WeWe RSS');
    assert.equal(result.finalUrl, 'http://localhost:4000');
  });

  it('探活：地址本身就是 feed 时认出来并带上标题', async () => {
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: '嗯哌' }) }] });
    const result = await service.probeCatalogService({ base: 'http://localhost:4000/feeds/npie.atom' });
    assert.equal(result.kind, 'feed');
    assert.equal(result.title, '嗯哌');
  });

  it('探活：返回 JSON 与「都不是」也能分开说清', async () => {
    const { service } = boot({ fetchPlan: [{ body: '{"ok":true}', contentType: 'application/json' }, { body: 'plain text', contentType: 'text/plain' }] });
    assert.equal((await service.probeCatalogService({ base: 'http://localhost:4000' })).kind, 'json');
    assert.equal((await service.probeCatalogService({ base: 'http://localhost:4000' })).kind, 'other');
  });

  it('探活：HTTP 错误码不算「通了」，但也不抛', async () => {
    const { service } = boot({ fetchPlan: [{ status: 404, body: 'nope' }] });
    const result = await service.probeCatalogService({ base: 'http://localhost:4000' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(result.kind, 'other');
  });

  it('探活不带地址时用**已保存**的那个', async () => {
    const { service, state } = boot({ fetchPlan: [{ body: '<html></html>', contentType: 'text/html' }] });
    await service.setCatalogService({ base: 'http://localhost:4100' });
    await service.probeCatalogService();
    assert.equal(state.fetchCalls.at(-1).url, 'http://localhost:4100');
  });

  it('反向对照：一个地址都没配过又没传参 ⇒ 报错，不能拿空串去 fetch', async () => {
    const { service, state } = boot();
    await assert.rejects(() => service.probeCatalogService(), /先填一个服务地址/);
    assert.equal(state.fetchCalls.length, 0);
  });

  it('服务地址跨重启保留', async () => {
    const { service } = boot();
    await service.setCatalogService({ base: 'http://localhost:4000' });
    const again = new RssService(createFakeContext({}).ctx, {});
    liveServices.add(again);
    assert.equal((await again.listCatalog()).service.base, 'http://localhost:4000');
  });
});

// ---------------------------------------------------------------------------
// OPML
// ---------------------------------------------------------------------------

describe('OPML', () => {
  it('round-trips an export back through preview and import', async () => {
    const { service } = boot({
      fetchPlan: [
        { body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }) },
        { body: rssDocument({ title: 'Feed B' }) },
      ],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml', group: '科技' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });

    const { xml } = await service.opmlExport();
    const preview = await service.opmlPreview({ xml });
    assert.equal(preview.entries.length, 2);
    assert.ok(preview.entries.every((entry) => entry.duplicate === true), 'both are already subscribed');

    // Wipe, then re-import only the grouped one.
    for (const sub of (await service.listSubscriptions()).subscriptions) {
      await service.removeSubscription({ id: sub.id });
    }
    const grouped = preview.entries.find((entry) => entry.group === '科技');
    assert.ok(grouped, 'the group name must survive the export/import round trip');

    const outcome = await service.opmlImport({ xml, urls: [grouped.url] });
    assert.deepEqual(outcome, { added: 1, skipped: 0 });

    const after = await service.listSubscriptions();
    assert.equal(after.subscriptions.length, 1);
    assert.equal(after.subscriptions[0].url, grouped.url);
    assert.equal(after.subscriptions[0].group, '科技');
  });

  it('counts duplicates as skipped rather than re-adding them', async () => {
    const { service } = boot({ fetchPlan: [{ body: rssDocument({ title: 'Feed A' }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const { xml } = await service.opmlExport();

    assert.deepEqual(await service.opmlImport({ xml }), { added: 0, skipped: 1 });
  });

  it('rejects an OPML that carries no subscriptions', async () => {
    const { service } = boot();
    await service.ready;
    await assert.rejects(() => service.opmlPreview({ xml: '<opml version="2.0"><body></body></opml>' }), /未找到有效的 OPML/);
  });

  it('refuses to fetch an OPML over a non-http scheme or with credentials', async () => {
    const { service } = boot();
    await service.ready;
    await assert.rejects(() => service.opmlPreview({ url: 'file:///tmp/subscriptions.opml' }), /HTTP\(S\) OPML/);
    await assert.rejects(() => service.opmlPreview({ url: 'https://user:pass@a.example/x.opml' }), /HTTP\(S\) OPML/);
  });

  it('rejects a non-string entry in the import selection', async () => {
    const { service } = boot();
    await service.ready;
    await assert.rejects(() => service.opmlImport({ xml: '<opml/>', urls: [42] }), /无效的订阅选择/);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('serves the reading defaults merged with what was saved', async () => {
    const { service } = boot();
    await service.ready;
    const { settings } = await service.getSettings();
    assert.equal(settings.fontSize, 19);
    assert.equal(settings.readingTheme, 'auto');
    assert.equal(settings.aiAssist, true);

    const saved = await service.saveSettings({ patch: { fontSize: 22 } });
    assert.equal(saved.settings.fontSize, 22);
    assert.equal(saved.settings.lineHeight, 1.9, 'an untouched key must keep its default');
  });

  it('rejects an invalid patch without applying any part of it', async () => {
    const { service } = boot();
    await service.ready;
    await assert.rejects(() => service.saveSettings({ patch: { fontSize: 22, readingTheme: 'neon' } }), /无效阅读主题/);
    assert.equal((await service.getSettings()).settings.fontSize, 19, 'the valid half must not have been applied');
  });

  /**
   * ★ 阅读页那两处字样（自动翻译的状态条、「生成」按钮）显示的就是这里报回来的名字。
   *
   * 判据落在「**设置里指定了模型时，报的是它**」—— 无条件说「Harness 默认模型」
   * 在用户把翻译压到便宜模型上之后会一直说错，而且说的是确定的话。
   */
  it('★ aiModelInfo：设置里指定了模型就报它，留空才报 Harness 默认模型', async () => {
    const { service } = boot({ modelSelection: { provider: 'ling', model: 'Ling-3.1-flash' } });
    await service.ready;
    // 没写过 `aiModel` ⇒ 跟随 Harness 默认模型，名字从宿主那边问到。
    assert.deepEqual(await service.aiModelInfo(), {
      value: '', source: 'default', model: { provider: 'ling', model: 'Ling-3.1-flash' },
    });
    await service.saveSettings({ patch: { aiModel: 'agnes-ai/agnes-2.5-flash' } });
    const info = await service.aiModelInfo();
    assert.equal(info.source, 'settings');
    assert.deepEqual(info.model, { provider: 'agnes-ai', model: 'agnes-2.5-flash' });
    assert.equal(effectiveModelLabel(info), 'agnes-ai · agnes-2.5-flash');
  });

  it('★ aiModelInfo 是只读的：不发网络请求、不写盘', async () => {
    // 对比 `listAiModels`：那个会遍历**所有** provider 逐个 `listModels`（可能真的
    // 去问远端、8s 超时）。阅读页每次打开都要这个名字，那条路太重。
    const { service, state } = boot();
    await service.ready;
    const calls = state.fetchCalls.length;
    await service.aiModelInfo();
    assert.equal(state.fetchCalls.length, calls, '不该发网络请求');
  });
});

// ---------------------------------------------------------------------------
// Articles, versions, companion chat
// ---------------------------------------------------------------------------

describe('articles', () => {
  const withBody = () => ({
    fetchPlan: [{
      body: rssDocument({ title: 'Feed A', items: [{ title: 'Alpha', description: '<p>Body text</p>' }] }),
    }],
  });

  it('resolves an article body out of the feed cache', async () => {
    const { service } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    const article = await service.getArticle({ key });
    assert.equal(article.article.title, 'Alpha');
    assert.match(article.html, /Body text/);
    assert.equal(article.truncated, false);
    assert.equal(article.versions.original.available, true);
    assert.equal(article.versions.translation.available, false);
    assert.equal(article.versions.translation.status, 'missing');
  });

  it('rejects an unknown article key', async () => {
    const { service } = boot();
    await service.ready;
    await assert.rejects(() => service.getArticle({ key: 'feed:missing' }), /unknown article/);
  });

  it('hands the reading tools plain text for the original version', async () => {
    const { service } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const versions = await service.getVersionContent({ key: sub.entries[0].key });

    assert.equal(versions.original.available, true);
    assert.match(versions.original.content, /Body text/);
    assert.equal(versions.translation.available, false);
    assert.equal(versions.translation.content, '');
  });

  it('builds a companion prompt that quotes the article and the question', async () => {
    const { service } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    const chat = await service.prepareChat({ key, question: '作者的核心论点是什么？' });
    assert.equal(chat.version, 'original');
    assert.match(chat.prompt, /作者的核心论点是什么？/);
    assert.match(chat.prompt, /Body text/);
    assert.match(chat.prompt, /引用材料/);
  });

  it('falls back to whatever version actually has content', async () => {
    const { service } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const chat = await service.prepareChat({ key: sub.entries[0].key, version: 'rewrite' });
    assert.equal(chat.version, 'original', 'an empty rewrite must not win over a readable original');
  });

  it('validates the version, the question length and the key', async () => {
    const { service } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    await assert.rejects(() => service.prepareChat({ key, version: 'podcast' }), /无效版本/);
    await assert.rejects(() => service.prepareChat({ key, question: 'x'.repeat(2001) }), /过长/);
    await assert.rejects(() => service.prepareChat({ key: 'feed:missing' }), /找不到文章/);
  });

  it('stores a per-session reading context and exposes it to the system prompt', async () => {
    const { service, state } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    const result = await service.setReadingContext({ sessionId: 'session-1', key, question: '' });
    assert.deepEqual(result, { ok: true, version: 'original' });

    const text = state.systemPromptContributions[0].text({ agent: { session: { id: 'session-1' } } });
    assert.match(text, /<reading_context>/);
    assert.match(text, /Body text/);
    assert.equal(state.systemPromptContributions[0].text({ agent: { session: { id: 'other' } } }), '');
  });

  it('rejects an empty or over-long session id', async () => {
    const { service } = boot();
    await service.ready;
    await assert.rejects(() => service.setReadingContext({ sessionId: '', key: 'feed:x' }), /无效会话/);
    await assert.rejects(() => service.setReadingContext({ sessionId: 'x'.repeat(161), key: 'feed:x' }), /无效会话/);
  });
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

describe('refresh', () => {
  /** 每个 URL 固定返回同一份文档 —— addSubscription 与 refresh 会各取一次，
   *  所以按 URL 兜底而不是把调用次数写进计划表。 */
  const byUrl = (documents) => (url) => {
    const body = documents[url];
    return body === undefined ? { throw: new Error(`unexpected url ${url}`) } : { body };
  };

  it('reports how many feeds and entries came back', async () => {
    const { service } = boot({
      fetchFallback: byUrl({
        'https://a.example/feed.xml': rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }),
        'https://b.example/feed.xml': rssDocument({ title: 'Feed B', items: [{ title: 'B1' }, { title: 'B2' }] }),
      }),
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });

    const outcome = await service.refresh({});
    assert.equal(outcome.feeds, 2);
    assert.equal(outcome.entries, 3);
    assert.equal(outcome.error, undefined);
    assert.ok((await service.listSubscriptions()).subscriptions.every((sub) => sub.lastError === undefined));
  });

  it('records a failure per feed without failing the whole refresh', async () => {
    const { service } = boot({
      fetchFallback: (url) => (url.includes('a.example')
        ? { body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }) }
        : { throw: new Error('boom') }),
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });

    const outcome = await service.refresh({});
    assert.equal(outcome.feeds, 2, 'a dead feed still counts as attempted');
    assert.equal(outcome.ok, 1, '成功数');
    assert.equal(outcome.failed, 1, '失败数 —— 混合场景下两个数必须分别正确');
    assert.equal(outcome.entries, 1);
    assert.deepEqual(outcome.failures.map((item) => item.error), ['boom']);

    const subs = (await service.listSubscriptions()).subscriptions;
    assert.equal(subs.length, 2, 'a failed refresh must not drop the subscription');
    assert.deepEqual(subs.map((sub) => sub.lastError).filter(Boolean), ['boom']);
  });

  it('clears a previous error once the feed comes back', async () => {
    let alive = false;
    const { service } = boot({
      fetchFallback: () => (alive
        ? { body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }) }
        : { throw: new Error('boom') }),
    });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    assert.equal((await service.listSubscriptions()).subscriptions[0].lastError, 'boom');

    alive = true;
    assert.equal((await service.refresh({ channel: sub.id })).entries, 1);
    assert.equal((await service.listSubscriptions()).subscriptions[0].lastError, undefined);
  });

  it('scopes the refresh to one channel', async () => {
    const { service } = boot({
      fetchFallback: byUrl({
        'https://a.example/feed.xml': rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }),
        'https://b.example/feed.xml': rssDocument({ title: 'Feed B', items: [{ title: 'B1' }] }),
      }),
    });
    await service.ready;
    const a = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml', group: '科技' });

    assert.deepEqual(
      await service.refresh({ channel: 'feed:nope' }),
      { feeds: 0, ok: 0, failed: 0, entries: 0, failures: [] },
    );
    assert.equal((await service.refresh({ channel: 'group:科技' })).feeds, 1);
    assert.equal((await service.refresh({ channel: a.id })).feeds, 1);
  });

  it('全部源都抓失败时，outcome 必须把失败数**说出来**（而不是装作刷新成功）', async () => {
    // ★ 这条是「工具不许说假话」的根：`refreshSubscription` 以前失败时 `return 0`，
    //   调用方把它当「抓到了 0 条新条目」，于是三个源全挂时输出仍是
    //   `Feeds refreshed: 3, new/updated entries: 0` —— 模型读成「刷过了，没新东西」。
    //   反向对照：把 `outcome.failed` 改回 `outcome.feeds += 1` 那一版，这里必红。
    const { service } = boot({ fetchFallback: () => ({ throw: new Error('connection refused') }) });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });
    await service.addSubscription({ url: 'https://c.example/feed.xml' });

    const outcome = await service.refresh({});
    assert.equal(outcome.feeds, 3, '三个源都尝试过');
    assert.equal(outcome.ok, 0, '一个都没成功');
    assert.equal(outcome.failed, 3, '失败数必须与成功数分开计');
    assert.equal(outcome.entries, 0);
    assert.equal(outcome.failures.length, 3, '每个失败都要能指名道姓');
    for (const failure of outcome.failures) {
      assert.ok(failure.url.startsWith('https://'), `失败项要带上源地址：${JSON.stringify(failure)}`);
      assert.match(failure.error, /connection refused/);
    }
  });

  it('反向对照：源抓得通但确实没有新条目时，failed 必须是 0', async () => {
    // 上一条证明「全挂 ⇒ failed=3」，这一条证明「全通 ⇒ failed=0」。
    // 两条一起才排除「failed 恒等于 feeds」这种把成功也说成失败的写法。
    const { service } = boot({
      fetchFallback: () => ({ body: rssDocument({ title: 'Feed A', items: [] }) }),
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const outcome = await service.refresh({});
    assert.equal(outcome.ok, 1);
    assert.equal(outcome.failed, 0);
    assert.equal(outcome.entries, 0, '连得上但没有新条目 —— 与「连不上」必须可区分');
  });
});

// ---------------------------------------------------------------------------
// AI versions
// ---------------------------------------------------------------------------

describe('generateVersion', () => {
  // ★ 0.13.0 起译文走**保结构翻译**：模型收到的是一份编号清单，返回的也是编号清单。
  const withBody = (llmChunks = [{ type: 'text-delta', text: '[1] 正文' }, { type: 'finish', reason: { kind: 'ok' } }]) => ({
    fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'Alpha', description: '<p>Body text</p>' }] }) }],
    llmChunks,
  });

  it('generates a translation with the harness model and caches it', async () => {
    const { service, state } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    const generated = await service.generateVersion({ key, kind: 'translation' });
    assert.equal(generated.source, 'local');
    // ★ 保结构译文的标题取自**译文 HTML 里的 `<h1>`**（不再是从 Markdown 的 `# ` 抽）；
    //   这篇正文没有 h1，于是退回订阅源标题 —— 与旧路径的 fallback 行为一致。
    assert.equal(generated.title, 'Alpha');
    // ★ `html` 是成品（结构与原文相同，只有文字变中文）；`markdown` 是纯文本快照，
    //   给伴读 / Agent 工具 / 「这个版本有没有内容」的判断用。
    assert.equal(generated.html, '<p>正文</p>');
    assert.equal(generated.markdown, '正文');
    assert.deepEqual(generated.coverage, { total: 1, done: 1, ratio: 1 });
    assert.equal(state.llmCalls.length, 1);
    assert.equal(state.llmCalls[0].provider, 'test-provider');
    assert.equal(state.llmCalls[0].model, 'test-model');
    assert.match(state.llmCalls[0].messages[1].content[0].text, /Body text/, 'the article must reach the model');

    const cached = await service.generateVersion({ key, kind: 'translation' });
    assert.equal(state.llmCalls.length, 1, 'a second call must serve the cache');
    assert.equal(cached.available, true);
    assert.equal(typeof cached.generatedAt, 'string');

    const article = await service.getArticle({ key });
    assert.equal(article.versions.translation.available, true);
    assert.equal(article.versions.translation.markdown, '正文');
    assert.equal(article.versions.translation.html, '<p>正文</p>');
  });

  it('★ 链接与标签在译文里原样保留 —— 这是 0.13.0 的核心承诺', async () => {
    // 旧路径（HTML → Markdown → 模型 → Markdown → 渲染）在这里必输：模型经常把
    // `[文字]({{L0}})` 的方括号丢掉，`restoreLinks` 于是无占位符可换，链接静默消失
    // （真机 38 篇实测：原文 909 个 <a>，译文只剩 427 个）。
    const { service } = boot({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [{ title: 'Alpha', description: '<p>Read <a href="https://example.com/a">the guide</a> now.</p>' }],
        }),
      }],
      llmChunks: [{ type: 'text-delta', text: '[1] 阅读\n[2] 这份指南\n[3] 现在。' }, { type: 'finish', reason: { kind: 'ok' } }],
    });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const generated = await service.generateVersion({ key: sub.entries[0].key, kind: 'translation' });

    assert.ok(generated.html.includes('<a href="https://example.com/a">'), '链接标签必须原样在译文里');
    assert.ok(generated.html.includes('这份指南'), '链接文字要换成中文');
    assert.ok(generated.html.includes('<p>') && generated.html.includes('</p>'), '段落标签必须还在');
    assert.equal((generated.html.match(/<a\s/g) ?? []).length, 1);
  });

  it('★ 标题取自译文 HTML 的 <h1>', async () => {
    const { service } = boot({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [{ title: 'Alpha', description: '<h1>Gemini 4 Argon is here</h1><p>Body text</p>' }],
        }),
      }],
      llmChunks: [{ type: 'text-delta', text: '[1] Gemini 4 Argon 来了\n[2] 正文' }, { type: 'finish', reason: { kind: 'ok' } }],
    });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const generated = await service.generateVersion({ key: sub.entries[0].key, kind: 'translation' });

    assert.equal(generated.title, 'Gemini 4 Argon 来了');
    assert.ok(generated.html.includes('<h1>Gemini 4 Argon 来了</h1>'), 'h1 要留着并换成中文');
  });

  it('★ 模型漏答的片段保留原文，覆盖率如实报出来', async () => {
    // 部分失败绝不能包装成「已生成」—— 界面靠这个数决定要不要提示「部分翻译」。
    const { service } = boot({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [{ title: 'Alpha', description: '<p>First part</p><p>Second part</p>' }],
        }),
      }],
      llmChunks: [{ type: 'text-delta', text: '[1] 第一部分' }, { type: 'finish', reason: { kind: 'ok' } }],
    });
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const generated = await service.generateVersion({ key: sub.entries[0].key, kind: 'translation' });

    assert.ok(generated.html.includes('第一部分'));
    assert.ok(generated.html.includes('Second part'), '没答的那一段必须保留原文，不能变空');
    assert.deepEqual(generated.coverage, { total: 2, done: 1, ratio: 0.5 });
  });

  it('★ force 丢掉缓存重新生成 —— 这是存量文章唯一的修复入口', async () => {
    // 在这之前译文一旦缓存就没有重新生成的入口：UI 上那个「用 X 生成」按钮只在
    // 版本**缺失**时渲染，而 host 侧缓存命中直接 return。于是改进了正文结构或
    // 插图判据之后，已经生成过的文章永远看不到效果。
    const { service, state } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    await service.generateVersion({ key, kind: 'translation' });
    assert.equal(state.llmCalls.length, 1);

    await service.generateVersion({ key, kind: 'translation' });
    assert.equal(state.llmCalls.length, 1, '不带 force 时必须仍然走缓存（别把每次打开都变成一次模型调用）');

    const forced = await service.generateVersion({ key, kind: 'translation', force: true });
    assert.equal(state.llmCalls.length, 2, '★ 带 force 必须真的再调一次模型');
    assert.equal(forced.title, 'Alpha');
    assert.equal(forced.html, '<p>正文</p>');
    assert.equal(forced.markdown, '正文');
    assert.equal(typeof forced.generatedAt, 'string');
  });

  it('strips a fenced code block wrapper from the model output', async () => {
    const { service } = boot(withBody([{ type: 'text-delta', text: '```markdown\n# 标题\n\n正文\n```' }, { type: 'finish', reason: { kind: 'ok' } }]));
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const generated = await service.generateVersion({ key: sub.entries[0].key, kind: 'rewrite' });
    assert.equal(generated.title, '标题');
    assert.equal(generated.markdown, '正文');
  });

  it('runs one generation at a time for the same article and kind', async () => {
    const { service, state } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    const [first, second] = await Promise.all([
      service.generateVersion({ key, kind: 'translation' }),
      service.generateVersion({ key, kind: 'translation' }),
    ]);
    assert.equal(state.llmCalls.length, 1, 'the in-flight generation must be shared, not duplicated');
    assert.deepEqual(first, second);
  });

  it('refuses an unknown kind, an empty model output and a missing model', async () => {
    const { service } = boot(withBody([]));
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    await assert.rejects(() => service.generateVersion({ key, kind: 'podcast' }), /translation or rewrite/);
    await assert.rejects(() => service.generateVersion({ key, kind: 'translation' }), /no output/);
    await assert.rejects(() => service.generateVersion({ key: 'feed:missing', kind: 'translation' }), /unknown article/);
  });

  it('honours the aiAssist toggle', async () => {
    const { service, state } = boot(withBody());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.saveSettings({ patch: { aiAssist: false } });

    await assert.rejects(() => service.generateVersion({ key: sub.entries[0].key, kind: 'translation' }), /已在设置中关闭/);
    assert.equal(state.llmCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 插件入口与 Gateway 视角（0.1.1：Host 半区零宿主内部包依赖）
// ---------------------------------------------------------------------------

describe('plugin entry and the Gateway binding', () => {
  it('registers rss through ctx.reflect.provide and exposes a valid typertRemote binding', async () => {
    process.env.DSH_HOME = join(sandbox, 'home-entry');
    const fake = createFakeContext();
    globalThis.fetch = fake.state.fetch;

    const disposer = mountPlugin(fake.ctx, {});
    try {
      assert.equal(typeof disposer, 'function', 'apply() must return the disposer');

      const provided = fake.state.provided.find((entry) => entry.name === 'rss');
      assert.ok(provided, 'apply() must register the rss service through ctx.reflect.provide');

      const service = provided.value;
      // Gateway 的发现与校验读的就是这个可见字段
      // （dsh-api-gateway/lib/index.js:713 发现，:1452 校验）。
      const binding = service.typertRemote;
      assert.ok(binding !== null && typeof binding === 'object', 'the service must expose a visible typertRemote binding');
      assert.equal(binding.service, service, 'binding.service must be the service instance itself');
      assert.equal(binding.serviceKey, 'rss');
      assert.equal(binding.namespace, 'rss');
      assert.ok(Object.isFrozen(binding), 'the binding must be frozen');

      // Gateway 用 remoteMethods() 列举端点；清单必须与客户端声明的那份一致。
      assert.deepEqual(
        readRemoteMethods(service).map((marker) => marker.exportName ?? marker.method).sort(),
        REMOTE_METHODS,
      );

      await service.ready;
    } finally {
      disposer();
    }
    assert.equal(fake.ctx.get('rss'), undefined, 'the disposer must unregister the service');
  });
});

describe('原文全文抓取', () => {
  const longParagraph = () => `<p>${'word '.repeat(90).trim()}</p>`;
  const articlePage = () => `<!doctype html><html><body><nav><a href="/">Home page</a></nav>`
    + `<article>${longParagraph()}${longParagraph()}${longParagraph()}</article>`
    + `<footer><a href="/p">Privacy policy and terms</a></footer></body></html>`;
  /** 页面上找不到可信正文容器（只有一小段字）——抽取必须失败而不是硬凑。 */
  const emptyPage = () => '<!doctype html><html><body><article><p>too short</p></article></body></html>';
  const feedWith = (description) => rssDocument({
    title: 'Blog',
    items: [{ title: 'Post', link: 'https://blog.example.org/post', guid: 'g1', description }],
  });
  const summaryFeed = () => feedWith('<p>Short summary only.</p>');
  const mediumFeed = () => feedWith(`<p>${'word '.repeat(200).trim()}</p>`);
  const fullFeed = () => feedWith(`<p>${'word '.repeat(300).trim()}</p>`);

  /** 按 URL 分派：`/post` 给页面，其余（feed 地址）给订阅源文档。 */
  const route = (pageBody, feed = summaryFeed) => (url) => (/blog\.example\.org\/post$/.test(url)
    ? { body: typeof pageBody === 'function' ? pageBody() : pageBody, contentType: 'text/html' }
    : { body: feed(), contentType: 'application/xml' });

  async function subscribe(service) {
    await service.addSubscription({ url: 'https://blog.example.org/feed.xml', name: 'Blog' });
    const { channels } = await service.listChannels();
    const feedChannel = channels.find((channel) => channel.kind === 'feed');
    const { entries } = await service.listEntries({ channel: feedChannel.key, limit: 10 });
    return entries;
  }

  it('fetches the original page when the feed only carries a summary', async () => {
    const { service, state } = boot({ fetchFallback: route(articlePage) });
    const entries = await subscribe(service);
    // feed 给的是「一段短摘要」，不是没有正文：hasBody 为真，但内容很短。
    assert.match(entries[0].summary, /Short summary only/);
    const article = await service.getArticle({ key: entries[0].key });
    assert.ok(article.html.includes('word word'), '正文必须来自原文页');
    assert.equal(article.article.bodyMissing, false);
    assert.ok(!article.html.includes('Privacy policy'), '页脚不该混进正文');
    assert.ok(state.fetchCalls.some((call) => /blog\.example\.org\/post$/.test(call.url)), '必须真的抓了原文页');
  });

  it('falls back to the summary and flags it when the page yields nothing', async () => {
    const { service } = boot({ fetchFallback: route(emptyPage) });
    const entries = await subscribe(service);
    const article = await service.getArticle({ key: entries[0].key });
    assert.equal(article.article.bodyMissing, true, '界面要能说明这篇只有摘要');
    assert.ok(article.html.includes('Short summary only.'), '摘要要当正文显示，不能给一片空白');
  });

  it('does not touch the page when the feed already carries a full body', async () => {
    const { service, state } = boot({ fetchFallback: route(articlePage, fullFeed) });
    const entries = await subscribe(service);
    assert.equal(entries[0].hasBody, true, 'feed 已经给了全文');
    const before = state.fetchCalls.length;
    await service.getArticle({ key: entries[0].key });
    assert.equal(state.fetchCalls.length, before, '已经给全文的源不该再抓一次');
  });

  it('honours the fullText=false setting', async () => {
    const { service, state } = boot({ fetchFallback: route(articlePage) });
    const entries = await subscribe(service);
    await service.saveSettings({ patch: { fullText: false } });
    const before = state.fetchCalls.length;
    const article = await service.getArticle({ key: entries[0].key });
    assert.equal(state.fetchCalls.length, before, '关掉之后不该再抓原文页');
    assert.equal(article.article.bodyMissing, true);
  });

  it('lets fetchFullText force a fetch even with the setting off', async () => {
    const { service } = boot({ fetchFallback: route(articlePage) });
    const entries = await subscribe(service);
    await service.saveSettings({ patch: { fullText: false } });
    await service.getArticle({ key: entries[0].key });
    const forced = await service.fetchFullText({ key: entries[0].key });
    assert.ok(forced.chars > 200, `forced chars = ${forced.chars}`);
    assert.equal(forced.strategy, 'article');
    assert.equal((await service.getArticle({ key: entries[0].key })).article.bodyMissing, false);
  });

  it('keeps the feed body when the page yields less than the feed', async () => {
    // 反向对照组：「抽取结果不比 feed 多就不换」这道闸门必须真的挡住
    // 「抓到一页导航」的情形，否则正文会被一页链接覆盖掉。
    // 这里让页面比 feed 短：feed 200 词，页面 1 段 90 词。
    const thinPage = () => `<html><body><article>${longParagraph()}</article></body></html>`;
    const { service } = boot({ fetchFallback: route(thinPage, mediumFeed) });
    const entries = await subscribe(service);
    const article = await service.getArticle({ key: entries[0].key });
    assert.equal((article.html.match(/<p>/g) ?? []).length, 1, '保留的应是 feed 那一份正文');
    assert.equal(article.article.bodyMissing, false);
  });

  /**
   * ★ 0.24.4 的接线判据：service 真的把 `pageGuard` 用上了。
   *
   * 没有这一条的话，`fetchPage(..., { checkUrl: this.pageGuard })` 里那个参数
   * 可能压根没传（或被后来的重构悄悄去掉），而上面那一整批用例仍然全绿 ——
   * 因为它们注入的守卫本来就是「全部放行」。这里注入一个**一律拒绝**的守卫，
   * 要求：正文退回摘要、且**一个请求都没发出去**（守卫在 fetch 之前）。
   */
  it('★ 守卫拒绝时退回摘要，且一个请求都不发（SSRF 接线判据）', async () => {
    const { service, state } = boot({
      fetchFallback: route(articlePage),
      pageGuard: async () => ({ ok: false, reason: '指向本机或内网地址' }),
    });
    const entries = await subscribe(service);
    const before = state.fetchCalls.length;
    const article = await service.getArticle({ key: entries[0].key });
    assert.ok(article.html.includes('Short summary only.'), '守卫拒绝后应退回 feed 给的摘要');
    assert.equal(article.article.bodyMissing, true, '界面要能说明这篇只有摘要');
    const pageCalls = state.fetchCalls.slice(before).filter((call) => /blog\.example\.org\/post$/.test(call.url));
    assert.deepEqual(pageCalls, [], '守卫拒绝之后仍然去抓了原文页 —— 内网服务已经被打过一次了');
  });

  it('守卫放行时同一个地址仍然能抓到（对照：上一条不是因为地址写错才绿的）', async () => {
    const { service, state } = boot({ fetchFallback: route(articlePage) });
    const entries = await subscribe(service);
    const article = await service.getArticle({ key: entries[0].key });
    assert.ok(article.html.includes('word word'), '放行时必须真的抓到原文页');
    assert.ok(state.fetchCalls.some((call) => /blog\.example\.org\/post$/.test(call.url)));
  });
});

// ---------------------------------------------------------------------------
// 书架（电子书）
// ---------------------------------------------------------------------------

/** 造一份临时书单（+ 可选的外部进度），返回 `{ dir, indexPath }`。 */
async function makeLibraryFixture({ books, external } = {}) {
  const dir = await mkdtemp(join(sandbox, 'lib-'));
  const indexPath = join(dir, 'books.json');
  const rows = books ?? [
    { id: 'b1', filename: '忧郁的热带.pdf', abspath: '', pan_path: '/p/a.pdf', fs_id: 11, ext: 'pdf', size: 4096, top_dir: '欧洲文学', series: '文化生活译丛', year: 2000, title: '忧郁的热带' },
    { id: 'b2', filename: 'x.epub', abspath: '', pan_path: '/p/b.epub', fs_id: 22, ext: 'epub', size: 2048, top_dir: '亚洲文学', series: '', year: 2010, title: 'X' },
  ];
  await writeFile(indexPath, JSON.stringify(rows));
  if (external !== undefined) await writeFile(join(dir, 'reading.json'), JSON.stringify(external));
  return { dir, indexPath };
}

/** 把 service 的书单路径指到临时索引上（**绝不**碰用户真实那份）。 */
async function pointAt(service, indexPath) {
  await service.saveSettings({ patch: { libraryPath: indexPath } });
  return indexPath;
}

/** 极简 req/res，只够走通书架路由。 */
function routeReq({ url, method = 'GET', host = '127.0.0.1:52431', headers = {}, body } = {}) {
  const req = { url, method, headers: { host, ...headers }, socket: { remoteAddress: '127.0.0.1' } };
  if (body !== undefined) req[Symbol.asyncIterator] = async function* iterate() { yield Buffer.from(body); };
  return req;
}

function routeRes() {
  return {
    status: 0, headers: null, chunks: [], ended: false, writableEnded: false, destroyed: false, handlers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    flushHeaders() {},
    write(chunk, done) { this.chunks.push(Buffer.from(chunk)); if (typeof done === 'function') done(); return true; },
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.from(chunk)); this.ended = true; this.writableEnded = true; },
    destroy() { this.destroyed = true; },
    on(event, handler) { this.handlers[event] = handler; },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
    /** ★ 给断言消息用：**不解析**、截断。取书成功时 body 是二进制，`json` 会抛错 ——
     *  而断言消息是**无条件求值**的，于是「用例通过」也会在消息里炸一次。 */
    get text() { return Buffer.concat(this.chunks).toString('utf8').slice(0, 200); },
  };
}

describe('书架：书单载入与查询', () => {
  it('载入索引、按 id 查书，未知 id 回 undefined', async () => {
    const { indexPath } = await makeLibraryFixture();
    const { service } = boot();
    await pointAt(service, indexPath);

    const library = await service.loadLibrary();
    assert.equal(library.error, '');
    assert.equal(library.books.length, 2);

    assert.equal((await service.bookById('b1')).title, '忧郁的热带');
    assert.equal((await service.bookById('b2')).ext, 'epub');
    assert.equal(await service.bookById('nope'), undefined);
  });

  it('设置项指向不存在的文件时 missing=true（配置问题，不是数据坏了）', async () => {
    const { service } = boot();
    await pointAt(service, join(sandbox, 'no-such-books.json'));
    const library = await service.loadLibrary();
    assert.equal(library.missing, true);
    assert.equal(library.error, '');
    assert.deepEqual(library.books, []);
  });

  it('★ 外部历史进度只导入**一次**（否则用户在插件里读的进度会被旧值反复盖回去）', async () => {
    const { indexPath } = await makeLibraryFixture({
      external: { b1: { state: 'reading', page: 125, pages: 350, at: 1000 } },
    });
    const { service, state } = boot();
    await pointAt(service, indexPath);

    await service.loadLibrary();
    assert.equal(service.store.data.library.states.b1.page, 125);
    assert.equal(service.store.data.library.importedFrom, indexPath);

    // 用户在插件里往后读。
    service.setBookState('b1', { page: 200 });
    assert.equal(service.store.data.library.states.b1.page, 200);

    // 再载入一次：外部那份**旧**进度不许把它盖回去。
    await service.loadLibrary();
    assert.equal(service.store.data.library.states.b1.page, 200);
    assert.equal(state.logs.filter(([, message]) => String(message).includes('只读导入')).length, 1);
  });

  it('★ 只读：导入进度不会在索引目录里写出任何文件', async () => {
    const { dir, indexPath } = await makeLibraryFixture();
    const { service } = boot();
    await pointAt(service, indexPath);
    await service.loadLibrary();
    service.setBookState('b1', { page: 3 });
    // 索引目录里除了我们自己放的那一份，不该多出任何东西。
    assert.deepEqual((await readdir(dir)).sort(), ['books.json']);
  });
});

describe('书架：阅读状态的写入校验', () => {
  it('写入合法状态并归一（at 由服务端补上）', async () => {
    const { indexPath } = await makeLibraryFixture();
    const { service } = boot();
    await pointAt(service, indexPath);
    const next = service.setBookState('b1', { state: 'reading', page: 12, pages: 350 });
    assert.equal(next.state, 'reading');
    assert.equal(next.page, 12);
    assert.equal(next.pages, 350);
    assert.ok(next.at > 0);
    assert.deepEqual(service.store.data.library.states.b1, next);
  });

  it('★ 不认识的状态**抛错**，不静默存成「未读」', async () => {
    // `normalizeState` 会把 `finished` 退回 `unread` —— 那是**读旧数据**的兜底。
    // 拿它处理用户刚提交的请求，就会「界面报成功、实际存成未读」。
    const { indexPath } = await makeLibraryFixture();
    const { service } = boot();
    await pointAt(service, indexPath);
    for (const state of ['finished', 'READING', '', 42, null]) {
      assert.throws(() => service.setBookState('b1', { state }), /无效的阅读状态/, String(state));
    }
    assert.equal(service.store.data.library.states.b1, undefined);
  });

  it('page / pages 必须是非负整数', async () => {
    const { indexPath } = await makeLibraryFixture();
    const { service } = boot();
    await pointAt(service, indexPath);
    for (const field of ['page', 'pages']) {
      for (const value of [-1, 1.5, '12', Number.NaN]) {
        assert.throws(() => service.setBookState('b1', { [field]: value }), /必须是非负整数/, `${field}=${String(value)}`);
      }
    }
    // 反向对照：0 与正整数都合法（0 页 = 刚打开还没翻）。
    assert.equal(service.setBookState('b1', { page: 0 }).page, 0);
    assert.equal(service.setBookState('b1', { page: 7 }).page, 7);
  });

  it('局部更新：只传 page 时保留原来的 state 与 pages', async () => {
    const { indexPath } = await makeLibraryFixture();
    const { service } = boot();
    await pointAt(service, indexPath);
    service.setBookState('b1', { state: 'reading', pages: 350 });
    const next = service.setBookState('b1', { page: 40 });
    assert.equal(next.state, 'reading');
    assert.equal(next.pages, 350);
    assert.equal(next.page, 40);
  });
});

describe('电子书伴读上下文 setBookContext', () => {
  it('写进与文章伴读同一个落点，注入里能读到书名、页码与这一页的文字', async () => {
    const { service, state } = boot();
    await service.ready;
    const result = await service.setBookContext({
      sessionId: 'book-session', bookId: 'b1', title: '干法', page: 12, pages: 225, text: '推荐序二 在工作中体会生命的精彩',
    });
    assert.deepEqual(result, { ok: true, hasText: true, hasQuote: false });

    // 注入通道是**同一个**贡献点（`npie-reader:reading`）—— 两条阅读路径在模型眼里是一件事。
    assert.equal(state.systemPromptContributions.length, 1);
    const text = state.systemPromptContributions[0].text({ agent: { session: { id: 'book-session' } } });
    assert.match(text, /<reading_context>/);
    assert.match(text, /《干法》第 12 页（共 225 页）/);
    assert.match(text, /推荐序二/);
    assert.equal(state.systemPromptContributions[0].text({ agent: { session: { id: 'other' } } }), '');
  });

  it('★ 扫描版（没有文字）也必须有上下文，且明说看不到这一页', async () => {
    // 这条与 reading-scope 的纯函数用例成对：那边钉措辞，这边钉「真的写进去了」。
    const { service, state } = boot();
    await service.ready;
    const result = await service.setBookContext({ sessionId: 's', bookId: 'b1', title: '扫描版书', page: 3, pages: 10, text: '' });
    assert.deepEqual(result, { ok: true, hasText: false, hasQuote: false });
    const text = state.systemPromptContributions[0].text({ agent: { session: { id: 's' } } });
    assert.match(text, /没有可提取的文字/);
    assert.match(text, /《扫描版书》第 3 页/);
  });

  it('★ 划选的那一句真的写进上下文，并被标成本轮的处理对象', async () => {
    // ★ 这条判据的来源是一处**只做了一半**的实现：`quote` 进了客户端的上下文键
    //   （所以每次划选都会触发一次重绑），却没进 `setBookContext` 的载荷 ——
    //   界面上按钮点了、状态显示「已同步」，模型从头到尾没收到那一句。
    //   只测「绑定发生了」是测不出这个的，必须测**宿主侧读到的文本**。
    const { service, state } = boot();
    await service.ready;
    const result = await service.setBookContext({
      sessionId: 'q1', bookId: 'b1', title: '干法', page: 12, pages: 225,
      text: '推荐序二 在工作中体会生命的精彩 还有别的段落',
      quote: '在工作中体会生命的精彩',
    });
    assert.deepEqual(result, { ok: true, hasText: true, hasQuote: true });
    const text = state.systemPromptContributions[0].text({ agent: { session: { id: 'q1' } } });
    assert.match(text, /在工作中体会生命的精彩/);
    assert.match(text, /本轮的处理对象是用户划选的那一段/,
      '没写明「这一句才是处理对象」⇒ 模型会去概括整页，用户问一句话却得到全书摘要');
  });

  it('★ 反向对照：不划选时不许出现「划选」那段作用域说明', async () => {
    // 只有上面那条正向断言的话，把作用域说明写成无条件常量也能过 —— 断言就没有分辨力了。
    const { service, state } = boot();
    await service.ready;
    await service.setBookContext({ sessionId: 'q2', bookId: 'b1', title: '干法', page: 12, pages: 225, text: '正文' });
    const text = state.systemPromptContributions[0].text({ agent: { session: { id: 'q2' } } });
    assert.doesNotMatch(text, /本轮的处理对象是用户划选的那一段/);
    assert.match(text, /用户没有划选/);
  });

  it('★ 与文章伴读共用同一个键：同一会话后写的覆盖先写的，别的会话不受影响', async () => {
    const { service, state } = boot();
    await service.ready;
    await service.setBookContext({ sessionId: 'shared', bookId: 'b1', title: '书', page: 1, pages: 9, text: '页一' });
    await service.setBookContext({ sessionId: 'keep', bookId: 'b2', title: '另一本', page: 2, pages: 9, text: '页二' });
    await service.setBookContext({ sessionId: 'shared', bookId: 'b1', title: '书', page: 5, pages: 9, text: '页五' });

    const contribution = state.systemPromptContributions[0];
    const shared = contribution.text({ agent: { session: { id: 'shared' } } });
    assert.match(shared, /第 5 页/);
    assert.doesNotMatch(shared, /页一/);
    // 集合基数与集合内性质一起断言：只看基数会漏掉「串会话」，只看内容会漏掉「多写了一条」。
    assert.equal(Object.keys(service.store.data.companionContexts).length, 2);
    assert.match(contribution.text({ agent: { session: { id: 'keep' } } }), /页二/);
    assert.equal(service.store.data.companionContexts.shared.key, 'book:b1');
  });

  it('★ 非法输入一律抛错，且一个字都不写进去', async () => {
    const { service } = boot();
    await service.ready;
    const good = { sessionId: 's', bookId: 'b1', title: '书', page: 1, pages: 9, text: 'x' };
    const bad = [
      [{ ...good, sessionId: '' }, /无效会话/],
      [{ ...good, sessionId: 'x'.repeat(161) }, /无效会话/],
      [{ ...good, sessionId: 42 }, /无效会话/],
      [{ ...good, bookId: '' }, /无效的书 id/],
      [{ ...good, bookId: '../etc/passwd' }, /无效的书 id/],
      [{ ...good, title: 'x'.repeat(301) }, /书名过长/],
      [{ ...good, page: -1 }, /page 必须是非负整数/],
      [{ ...good, page: 1.5 }, /page 必须是非负整数/],
      [{ ...good, pages: '225' }, /pages 必须是非负整数/],
      [{ ...good, pages: -1 }, /pages 必须是非负整数/],
      [{ ...good, pages: 1.5 }, /pages 必须是非负整数/],
      // ★ 上界必须真的落在 `pages` 上：原来第三个判据写成了 `page > 1_000_000`
      //   （上一行刚校验过 `page`，这里等于什么也没查），于是 `pages` 无上界 ——
      //   这个值会直接进「第 3/999999999 页」这句提示词里。
      [{ ...good, pages: 1_000_001 }, /pages 必须是非负整数/],
      [{ ...good, text: null }, /页文本必须是字符串/],
      // ★ 引文类型不对时必须抛错：兜成空串会让模型以为用户**没划选**，
      //   于是去概括整页 —— 而用户看到的只是「按钮点过了，答非所问」。
      [{ ...good, quote: 1 }, /划选引文必须是字符串/],
      [{ ...good, quote: 'x'.repeat(4001) }, /划选引文过长/],
      // ★ 字段名写错 / 漏传时必须抛错，不能被兜成 0 与空串 ——
      //   那样模型看到的是「第 0 页，这一页没有文字」这样**看起来很确定**的假话。
      [{ ...good, page: undefined }, /page 必须是非负整数/],
      [{ ...good, pages: undefined }, /pages 必须是非负整数/],
      [{ ...good, text: undefined }, /页文本必须是字符串/],
    ];
    for (const [request, expected] of bad) {
      await assert.rejects(() => service.setBookContext(request), expected, JSON.stringify(request).slice(0, 60));
    }
    // 反向对照：0 页与超长正文都合法（0 页 = 刚打开；正文长度由 reading-scope 截断）。
    assert.equal((await service.setBookContext({ ...good, page: 0 })).ok, true);
    // 反向对照：上界本身（1_000_000）必须放行 —— 否则守卫就成了「多删一个合法值」。
    assert.equal((await service.setBookContext({ ...good, pages: 1_000_000 })).ok, true);
    assert.equal((await service.setBookContext({ ...good, text: '字'.repeat(50_000) })).hasText, true);
    assert.equal(Object.keys(service.store.data.companionContexts).length, 1);
  });

  it('★ 上下文数量有上限，且留下的必须是**最新**的 200 条', async () => {
    const { service } = boot();
    await service.ready;
    // 冻住时钟：`Date.now()` 只有毫秒精度，连写 205 条时它们**一定**落在同一毫秒里。
    // 不冻的话这条用例就变成「看机器快不快」—— 实测在高负载下偶发变红，
    // 而它暴露的正是「时间相同时该按插入顺序兜底」这个真问题（见 putCompanionContext）。
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      for (let index = 0; index < 205; index += 1) {
        await service.setBookContext({ sessionId: `s${index}`, bookId: 'b1', title: '书', page: 1, pages: 9, text: 'x' });
      }
    } finally {
      Date.now = realNow;
    }
    const contexts = service.store.data.companionContexts;
    // 集合基数与集合内性质一起断言：只看基数会漏掉「裁错了头」。
    assert.equal(Object.keys(contexts).length, 200);
    assert.notEqual(contexts.s204, undefined, '最新写的那条被裁掉了');
    assert.equal(contexts.s0, undefined, '最旧的那条反而被留下了');
  });

  it('★ 落盘走 500ms 去抖（翻页会频繁调用，不能每次全量重写 data.json）', async () => {
    const { service } = boot();
    await service.ready;
    await service.setBookContext({ sessionId: 's', bookId: 'b1', title: '书', page: 1, pages: 9, text: 'x' });
    // `touch()` 排了计时器 ⇒ 说明这条路径**没有**走 `flush()` 的立即全量写。
    assert.notEqual(service.store.saveTimer, undefined);
    clearTimeout(service.store.saveTimer);
    service.store.saveTimer = undefined;
    // 而内存里**立刻**可读 —— 注入读的就是它，不等落盘。
    assert.match(service.store.data.companionContexts.s.text, /<reading_context>/);
  });
});

describe('书架：HTTP 路由真的挂上了', () => {
  it('注册了两条 prefix 路由，路径取自共用常量', async () => {
    const { service, state } = boot();
    await service.ready;
    assert.deepEqual(state.webRoutes.map((entry) => entry.route.path), [
      '/api/dsh-npie-reader/library',
      '/vendor/npie-reader/pdfjs',
    ]);
    assert.deepEqual(state.webRoutes.map((entry) => entry.route.kind), ['prefix', 'prefix']);
  });

  it('★ 路由对不可信请求回 403（这条链路上唯一的防线）', async () => {
    const { service, state } = boot();
    await service.ready;
    const [api] = state.webRoutes.map((entry) => entry.route);
    const res = routeRes();
    await api.handler(routeReq({ url: '/api/dsh-npie-reader/library/books', host: 'evil.com' }), res);
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { ok: false, error: 'forbidden' });
  });

  it('★ 端到端：可信请求经过路由拿到真实书单（不是桩）', async () => {
    const { indexPath } = await makeLibraryFixture();
    const { service, state } = boot();
    await pointAt(service, indexPath);
    const [api] = state.webRoutes.map((entry) => entry.route);

    const res = routeRes();
    await api.handler(routeReq({ url: '/api/dsh-npie-reader/library/books' }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.books.map((book) => book.id), ['b1', 'b2']);
    assert.equal(res.json.source.path, indexPath);
  });

  it('★ 端到端：POST /state 写进去、GET /state 读回来（走真 store）', async () => {
    const { indexPath } = await makeLibraryFixture();
    const { service, state } = boot();
    await pointAt(service, indexPath);
    const [api] = state.webRoutes.map((entry) => entry.route);

    const write = routeRes();
    await api.handler(routeReq({
      url: '/api/dsh-npie-reader/library/state',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'b1', state: 'reading', page: 33, pages: 100 }),
    }), write);
    assert.equal(write.status, 200);
    assert.equal(write.json.state.page, 33);

    const read = routeRes();
    await api.handler(routeReq({ url: '/api/dsh-npie-reader/library/state' }), read);
    assert.equal(read.status, 200);
    assert.equal(read.json.states.b1.page, 33);
    // 两处读的是**同一份**数据（路由 → service → store），不是各存一份。
    assert.equal(service.store.data.library.states.b1.page, 33);
  });

  it('★ 端到端：/book/:id/raw 走通 Range，且**不联网**（pan 被替身接管）', async () => {
    const { indexPath } = await makeLibraryFixture();
    const { service, state } = boot();
    await pointAt(service, indexPath);
    // 真 pan 会去连百度网盘；这里换成替身，证明的是「路由 → pan.readRange」这段接线。
    const asked = [];
    service.pan = {
      // ★ `verifyReadable` 会在取字节**之前**先确认凭证（`ensureToken`），所以替身
      //   必须提供它 —— 真实实现（pan.js 的 `createPanReader`）永远是导出的。
      //   缺了它会抛 TypeError，被路由翻成一句 400，而这条用例想测的
      //   「路由 → pan.readRange」接线就被这一步挡在门外了。
      ensureToken: async () => 'stub-token',
      readRange: async (fsId, start, end) => { asked.push({ fsId, start, end }); return Buffer.alloc(end - start + 1, 0x42); },
    };
    const [api] = state.webRoutes.map((entry) => entry.route);

    const res = routeRes();
    await api.handler(routeReq({ url: '/api/dsh-npie-reader/library/book/b1/raw', headers: { range: 'bytes=10-19' } }), res);
    assert.equal(res.status, 206, `路由回了 ${res.status}：${res.text}`);
    assert.equal(res.headers['content-range'], 'bytes 10-19/4096');
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.deepEqual(asked, [{ fsId: 11, start: 10, end: 19 }]);
  });

  it('反向对照：不可渲染的 epub 仍能取到字节（渲染与否是客户端的事，路由不该拦）', async () => {
    const { indexPath } = await makeLibraryFixture();
    const { service, state } = boot();
    await pointAt(service, indexPath);
    service.pan = { ensureToken: async () => 'stub-token', readRange: async (fsId, start, end) => Buffer.alloc(end - start + 1) };
    const [api] = state.webRoutes.map((entry) => entry.route);
    const res = routeRes();
    await api.handler(routeReq({ url: '/api/dsh-npie-reader/library/book/b2/raw', headers: { range: 'bytes=0-3' } }), res);
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-type'], 'application/epub+zip');
  });

  it('★ 网盘书在取字节**之前**先确认凭证 —— 否则失败只能零字节收尾（真机就是 `Failed to fetch`）', async () => {
    /**
     * 这条钉的是**顺序**，不是结果：报头为了压探测延迟在取字节前就发出去了，
     * 一旦取字节失败就改不了状态码、只能零字节收尾，浏览器读成「响应被截断」。
     * 所以「凭证能不能拿到」必须在这之前确认掉。
     *
     * 真机症状：书架列得出来、一点开只有 `Failed to fetch`（0.7.2 起的凭证缺口）。
     */
    const { indexPath } = await makeLibraryFixture();
    const { service, state } = boot();
    await pointAt(service, indexPath);
    let ensured = 0;
    service.pan = {
      ensureToken: async () => {
        ensured += 1;
        throw Object.assign(new Error('还没有百度网盘授权。请在插件设置的「电子书书架 → 百度云盘」里走一次授权。'), { code: 'NO_TOKEN' });
      },
      readRange: async () => { throw new Error('不该走到取字节这一步'); },
    };
    const [api] = state.webRoutes.map((entry) => entry.route);

    const res = routeRes();
    await api.handler(routeReq({ url: '/api/dsh-npie-reader/library/book/b1/raw', headers: { range: 'bytes=0-4' } }), res);

    assert.equal(ensured, 1, '取字节之前没有确认凭证');
    // ★ 401 而不是 400：请求本身没问题，缺的是授权，自救动作是「去设置页授权」。
    assert.equal(res.status, 401, `凭证缺失时回了 ${res.status}（期望 401）`);
    assert.equal(res.json?.code, 'NO_TOKEN');
    assert.match(res.json?.error ?? '', /百度网盘授权/, '没有给出能自救的那句话');
  });
});

// ---------------------------------------------------------------------------
// 书源（service 层）：取字节分派 + 生成书单的三条边界
// ---------------------------------------------------------------------------

const { bookListsDir, bookListsIndexPath, libraryIndexPath, pluginDataDir } = await import('../src/host/store.js');
const { listFilePath, readListsIndex } = await import('../src/host/book-lists.js');
const {
  readLibraryIndex: readListFile,
  resolveLibraryPath,
} = await import('../src/host/library.js');
const { sourceListId } = await import('../src/library.js');

/** 造一个待扫描的本地书源目录。 */
async function seedLocalSource(name, files) {
  const dir = join(sandbox, name);
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(join(dir, file), `PDF:${file}`);
  return dir;
}

/**
 * 「把这一条源的书单勾上」——0.8.0 起**生成 ≠ 载入**，不勾就永远读不到。
 *
 * 每一步只点一次「勾选」的语义与界面一致：`setLoadedLists` 收的是**全量** id。
 */
function loadAll(service, ids = service.bookSources().map((source) => source.id)) {
  return service.setLoadedLists(ids);
}

/** 读一份生成出来的书单的全部条目（走宿主那一份读取器，不另写解析）。 */
async function booksOf(id) {
  return (await readListFile(listFilePath(id))).books;
}

describe('书源：设置项的读写', () => {
  it('bookSources() 永远返回数组 —— 老数据里没这个字段时界面不该拿到 undefined', async () => {
    const { service } = boot();
    assert.deepEqual(service.bookSources(), []);
    // 反向对照：字段被写坏成非数组时也要回数组（界面直接 `.map()` 它）。
    service.store.data.settings.bookSources = 'x';
    assert.deepEqual(service.bookSources(), []);
    service.store.data.settings.bookSources = undefined;
    assert.deepEqual(service.bookSources(), []);
  });

  it('★ setBookSources 走共用判据（trim / 丢坏行 / 去重，并补上 id 与书单名），非数组抛错且**不改原配置**', async () => {
    const { service } = boot();
    // 返回值是 Promise（清盘要 await），但**参数守卫是同步抛的** —— 见 service.js 的说明。
    const saved = await service.setBookSources([
      { kind: 'local', path: '  /books  ' },
      { kind: 'bogus', path: '/x' },
      { kind: 'local', path: '/books' },
    ]);
    // id（书单文件名）与 name（书单名）由宿主现算 —— 前端只提交 `kind / path / name?`。
    assert.deepEqual(saved, [
      { id: sourceListId('local', '/books'), kind: 'local', path: '/books', name: 'books' },
    ]);
    assert.deepEqual(service.bookSources(), saved);

    // 反向对照：非数组要**同步**抛，而不是静默清空用户配好的书源 ——
    // 静默清空的后果是「设置页里书源突然全没了」，而用户会以为自己没保存。
    assert.throws(() => service.setBookSources('x'), /书源必须是数组/);
    assert.deepEqual(service.bookSources(), saved, '抛错之后原配置必须还在');
  });

  it('★ 书源是**设置**而不是内存态：落盘之后新起的 service 能读回来', async () => {
    process.env.DSH_HOME = join(sandbox, 'home-persist');
    const first = new RssService(createFakeContext().ctx, {});
    liveServices.add(first);
    await first.ready;
    await first.setBookSources([{ kind: 'pan', path: '/E书' }, { kind: 'local', path: '/库' }]);
    await first.store.flush();

    const second = new RssService(createFakeContext().ctx, {});
    liveServices.add(second);
    await second.ready;
    assert.deepEqual(second.bookSources(), [
      { id: sourceListId('pan', '/E书'), kind: 'pan', path: '/E书', name: '网盘 · E书' },
      { id: sourceListId('local', '/库'), kind: 'local', path: '/库', name: '库' },
    ]);
    // 反向对照：`sourceListId` 是**纯函数**（只由 kind+path 决定），所以两边的 id 必须一样。
    assert.equal(second.bookSources()[0].id, first.bookSources()[0].id);
  });

  it('★ 删掉一条书源要**连带**清掉它的书单文件、载入勾选与清单条目', async () => {
    // 不连带的后果有三层，每一层用户都看不出来：书单文件变成永远读不到的垃圾、
    // 「已载入」里留着一个点不开的空条目、清单里留一条永远不会有新计数的孤儿。
    const { service } = boot();
    await service.ready;
    await service.setBookSources([
      { kind: 'local', path: await seedLocalSource('src-del-a', ['甲.pdf']) },
      { kind: 'local', path: await seedLocalSource('src-del-b', ['乙.pdf']) },
    ]);
    const [keep, drop] = service.bookSources();
    await service.scanBookSources();
    loadAll(service);
    assert.equal((await readListsIndex()).length, 2);

    // ← 必须 await：删文件与修剪清单是异步的，不等的话下面读到的是**动手前**的状态。
    await service.setBookSources([keep]);

    // `readListsIndex()` 每次都新建数组 ⇒ 这里必须 `deepEqual`，`equal` 比的是引用。
    assert.deepEqual((await readListsIndex()).map((row) => row.id), [keep.id], '被删那条的清单条目必须一起摘掉');
    assert.equal(service.loadedListIds().includes(drop.id), false, '被删那条的勾选必须一起摘掉');
    assert.equal(service.loadedListIds().includes(keep.id), true, '留着那条的勾选不许丢');
    // 文件真的删了（`readListFile` 会回 missing）。
    assert.equal((await readListFile(listFilePath(drop.id))).missing, true);
    assert.equal((await readListFile(listFilePath(keep.id))).missing, false);
    // 反向对照：删完之后书架规模也跟着变小，而不是靠「读不到」蒙混过去。
    assert.equal((await service.libraryIndex()).books.length, 1);
  });
});

describe('书源：readBookBytes 的分派', () => {
  it('★ source=local 走本地通道、有 fsId 走网盘、两条凭据都没有则抛', async () => {
    const { service } = boot();
    const localCalls = [];
    service.local = {
      read: async (path, start, end) => { localCalls.push({ path, start, end }); return Buffer.from('LOCAL'); },
    };
    const panCalls = [];
    service.pan = {
      readRange: async (fsId, start, end) => { panCalls.push({ fsId, start, end }); return Buffer.from('PAN'); },
    };

    assert.equal((await service.readBookBytes({ source: 'local', localPath: '/库/甲.pdf' }, 0, 4)).toString(), 'LOCAL');
    assert.equal((await service.readBookBytes({ source: 'pan', fsId: 7 }, 0, 2)).toString(), 'PAN');
    assert.deepEqual(localCalls, [{ path: '/库/甲.pdf', start: 0, end: 4 }]);
    assert.deepEqual(panCalls, [{ fsId: 7, start: 0, end: 2 }]);

    // 反向对照：`source` 说是 local 就必须走本地 —— 不许因为「顺手有个 fsId」改走网盘。
    // （一本同时在网盘和本地的书，`normalizeBook` 把 source 定为 'pan'，所以这里
    //   只有显式声称 source='local' 的记录才会带着 fsId 进来。）
    await service.readBookBytes({ source: 'local', localPath: '/库/甲.pdf', fsId: 7 }, 0, 1);
    assert.equal(panCalls.length, 1, 'source=local 的那次不该碰网盘');

    // 两条凭据都没有 ⇒ 抛一句明确的话，而不是返回空 buffer（空 buffer 会被 pdf.js
    // 当成「文件就是这么短」，报一句与真实原因无关的解析错误）。
    await assert.rejects(
      () => service.readBookBytes({ source: '', fsId: 0 }, 0, 1),
      /取不到字节/,
    );
  });
});

describe('书源：生成书单的三条边界', () => {
  it('★ 一个源都没配 → 抛错，**绝不写一份空书单**', async () => {
    const { service } = boot();
    await service.ready;
    await assert.rejects(() => service.scanBookSources(), /还没有配置任何书源/);
    /**
     * 反向对照：真去写了一份空书单的话，用户的书架会整片消失 —— 而这是**不可逆**的
     * （下一份书单还没生成，旧的那份已经被覆盖）。
     *
     * ★ 判据写成「数据目录里有没有那两个东西」，而不是「某个具体文件读得到吗」：
     *   后者在目录本身不存在时也会以 ENOENT 通过，看着是绿的，其实什么也没证明；
     *   而且失败时的消息里会带上**实际的目录列表**，省一轮往返。
     */
    const dataDir = pluginDataDir();
    const leftovers = await readdir(dataDir).catch(() => []);
    assert.deepEqual(
      leftovers.filter((name) => name === 'lists.json' || name === 'lists'),
      [],
      `没配源却写下了清单/目录（${dataDir}）：${leftovers.join(' ')}`,
    );
  });

  it('★ 生成的书单只写**插件数据目录**，绝不覆盖 libraryPath 指向的那份', async () => {
    const { service } = boot();
    await service.ready;
    // 用户自己整理了很久的那份书单（作者那份 2634 本就在这种位置）。
    const userIndex = join(sandbox, 'user-books.json');
    await writeFile(userIndex, JSON.stringify([{ id: 'keepme', title: '别动我' }]));
    service.store.data.settings.libraryPath = userIndex;

    await service.setBookSources([{ kind: 'local', path: await seedLocalSource('src-a', ['甲.pdf', '乙.pdf']) }]);
    const result = await service.scanBookSources();

    // ★ 落点由**书源 id** 决定，不再是「一个固定的 books.json」。
    const id = service.bookSources()[0].id;
    assert.deepEqual(result.lists.map((row) => row.id), [id]);
    assert.equal(listFilePath(id).startsWith(bookListsDir()), true);
    assert.equal(result.stats.total, 2);
    // ★ 用户那份一个字节都没动 —— 覆盖它是不可逆的。
    assert.deepEqual(JSON.parse(await readFile(userIndex, 'utf8')), [{ id: 'keepme', title: '别动我' }]);
    // 反向对照：插件数据目录里那份确实写进去了（证明上面的「没动」不是因为整个都没写）。
    assert.equal((await booksOf(id)).length, 2);
    // 清单是**扫描产出的事实**：只有 id / 本数 / 生成时间，没有名字与路径。
    assert.deepEqual(
      (await readListsIndex()).map((row) => Object.keys(row).sort()),
      [['count', 'generatedAt', 'id']],
    );
    // `lastScan` 报出来供界面显示「上次生成于…」。
    assert.equal(service.lastScan.stats.total, 2);
  });

  it('★ 生成完**不自动切换** libraryPath，也**不自动勾选**载入（两个都是用户的决定）', async () => {
    const { service } = boot();
    await service.ready;
    service.store.data.settings.libraryPath = '/用户的/老书单.json';
    await service.setBookSources([{ kind: 'local', path: await seedLocalSource('src-b', ['丙.pdf']) }]);
    await service.scanBookSources();
    // 自动切会让用户发现「我只是想生成一份备用，结果书架整个换掉了」。
    assert.equal(service.store.data.settings.libraryPath, '/用户的/老书单.json');
    /**
     * ★ 生成**不**顺带勾上载入 —— 这与 0.7.x 不同（那时只有一份，生成完就是它）。
     *   自动勾的后果是「我只想先把网盘那份备着，结果书架里混进了 1400 本我还没挑过的书」，
     *   而用户根本不知道去哪取消。
     */
    assert.deepEqual(service.loadedListIds(), []);
    assert.equal((await service.libraryIndex()).books.length, 0);
    // 反向对照：没配 libraryPath 时它也必须保持**没被碰过**（而不是被悄悄写成插件目录）。
    const { service: fresh } = boot();
    await fresh.ready;
    await fresh.setBookSources([{ kind: 'local', path: await seedLocalSource('src-c', ['丁.pdf']) }]);
    await fresh.scanBookSources();
    // 判据是「它没有变成插件数据目录里的某份」——`settings.libraryPath` 在这条链路上
    // 从来没被写过，所以它在 store 里可以是 undefined。
    assert.equal(fresh.store.data.settings.libraryPath ?? '', '');
  });

  it('★ 重扫保住老 id、只给新文件发新 id —— 进度是按 id 记的', async () => {
    const { service } = boot();
    await service.ready;
    const dir = await seedLocalSource('src-d', ['老一.pdf', '老二.pdf']);
    await service.setBookSources([{ kind: 'local', path: dir }]);
    const id = service.bookSources()[0].id;

    await service.scanBookSources();
    const before = new Map((await booksOf(id)).map((book) => [book.filename, book.id]));

    await writeFile(join(dir, '新来的.pdf'), 'PDF:新来的');
    await service.scanBookSources();
    const after = new Map((await booksOf(id)).map((book) => [book.filename, book.id]));

    for (const [name, bookId] of before) {
      assert.equal(after.get(name), bookId, `${name} 的 id 变了 ⇒ 用户点一次「生成书单」就清空进度`);
    }
    assert.equal(after.has('新来的.pdf'), true);
    assert.equal(before.has('新来的.pdf'), false);
    // 反向对照：**旧条目真的被替换掉**（书单文件是整份覆盖，不是追加）。
    assert.equal(after.size, 3);
    assert.equal((await readListsIndex()).find((row) => row.id === id).count, 3);
  });

  it('★ 只生成一条源时**不动**其余源的书单与清单条目', async () => {
    // 第二步是「每一行一个生成按钮」，所以「只扫一条」是常态而不是边角。
    // 不隔离的后果：点一下甲，乙的计数被清成 0，第四步的文件却还在 —— 界面与磁盘对不上。
    const { service } = boot();
    await service.ready;
    await service.setBookSources([
      { kind: 'local', path: await seedLocalSource('src-one-a', ['甲.pdf']) },
      { kind: 'local', path: await seedLocalSource('src-one-b', ['乙.pdf', '丙.pdf']) },
    ]);
    const [first, second] = service.bookSources();
    await service.scanBookSources();
    await writeFile(join(second.path, '丁.pdf'), 'PDF:丁');

    const result = await service.scanBookSources({ id: second.id });

    assert.deepEqual(result.lists.map((row) => row.id), [second.id]);
    assert.equal(result.stats.total, 3);
    const index = await readListsIndex();
    assert.deepEqual(index.map((row) => [row.id, row.count]), [[first.id, 1], [second.id, 3]]);
    // 反向对照：被跳过的那份文件内容**没被重写过**（重写会让它的 generatedAt 变化）。
    const stamp = index.find((row) => row.id === first.id).generatedAt;
    assert.equal((await booksOf(first.id)).length, 1);
    assert.equal(stamp > 0, true);
    // 不存在的 id 要明确报错，而不是静默「生成 0 份」。
    await assert.rejects(() => service.scanBookSources({ id: 'sdeadbeefdeadbeef' }), /没有这条书源/);
  });

  it('★ 单个源坏掉不中断整次生成：好源的结果照常 + 一句「哪个源坏了」', async () => {
    const { service } = boot();
    await service.ready;
    const good = await seedLocalSource('src-e', ['好源的一本.pdf']);
    await service.setBookSources([
      { kind: 'local', path: join(sandbox, '不存在的源') },
      { kind: 'local', path: good },
    ]);
    const result = await service.scanBookSources();
    assert.equal(result.stats.total, 1, '坏源不该把好源的结果也吞掉');
    assert.equal(result.lists.length, 1, '坏源不该产出一份空书单（那会让它的计数显示为 0 本）');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /目录不存在/);
    // 反向对照：报错里要带上**是哪个源**坏了（否则用户得逐个试）。
    assert.match(result.errors[0].root, /不存在的源/);
    assert.equal(result.errors[0].id, service.bookSources()[0].id);
    assert.equal(typeof result.errors[0].name, 'string');
    // ★ 坏掉的那份**不进清单** —— 进了的话第三步会出现一行「0 本、生成于 1970 年」，
    //   而用户根本无从判断那是「目录被挪走了」还是「那个目录本来就是空的」。
    assert.deepEqual((await readListsIndex()).map((row) => row.id), [service.bookSources()[1].id]);
  });

  it('★ 根目录整个读不到时**不覆盖**上一份书单（外置盘没挂上是最常见的触发方式）', async () => {
    // 覆盖的后果不是难看，是**不可逆**：外置盘没挂上时点一下「生成」，那份 1400 本的
    // 书单就变成 0 本 —— 而在用户眼里「重新生成一下」是最安全的操作。
    const { service } = boot();
    await service.ready;
    const dir = await seedLocalSource('src-vanish', ['甲.pdf', '乙.pdf']);
    await service.setBookSources([{ kind: 'local', path: dir }]);
    const id = service.bookSources()[0].id;
    await service.scanBookSources();
    assert.equal((await booksOf(id)).length, 2);

    // 外置盘拔了 / 目录改名了。
    await rm(dir, { recursive: true, force: true });
    const result = await service.scanBookSources();
    assert.equal(result.lists.length, 0, '一本都没扫到且有错 ⇒ 不该产出新书单');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /目录不存在/);
    // ★ 上一份**完好无损**。
    assert.equal((await booksOf(id)).length, 2);
    assert.deepEqual((await readListsIndex()).map((row) => [row.id, row.count]), [[id, 2]]);

    // 反向对照：盘回来之后再生成，照常更新（守卫不该把正常路径也一起锁死）。
    await seedLocalSource('src-vanish', ['甲.pdf', '乙.pdf', '丙.pdf']);
    const again = await service.scanBookSources();
    assert.deepEqual(again.lists.map((row) => row.count), [3]);
    assert.equal((await booksOf(id)).length, 3);
  });

  it('★ 生成之后书库缓存立刻失效：勾上载入的那一次就要看到新那份', async () => {
    const { service } = boot();
    await service.ready;
    await service.setBookSources([{ kind: 'local', path: await seedLocalSource('src-f', ['缓存一本.pdf']) }]);
    await service.scanBookSources();
    // 不 invalidate 的话会读到上一份（或空），而要等 mtime 分辨率翻过去才自愈 ——
    // 表现是「点了生成、勾了载入，书架还是空的，过一会儿自己好了」。
    loadAll(service);
    const library = await service.libraryIndex();
    assert.equal(library.books.length, 1);
    assert.equal(library.books[0].filename, '缓存一本.pdf');
    // 反向对照：`bookById` 也要立刻看得到（它走的是内存里的那份 map）。
    assert.equal((await service.bookById(library.books[0].id))?.filename, '缓存一本.pdf');
    // 逐份状态要报得出来 —— 「读到了 0 本」与「这一份读不到」对用户是两件事。
    assert.deepEqual(
      library.sources.map((entry) => [entry.count, entry.missing, entry.error]),
      [[1, false, '']],
    );
  });

  it('★ 勾上**还没生成过**的那份不会报错：它只是 missing，界面据此说「还没生成」', async () => {
    // 用户完全可能先勾、再生成（顺序由他定）。这时直接抛错会让他卡在一个
    // 什么也做不了的页面上，而正确的行为是「这一份暂时没有内容」。
    const { service } = boot();
    await service.ready;
    await service.setBookSources([{ kind: 'local', path: await seedLocalSource('src-g', ['甲.pdf']) }]);
    const id = service.bookSources()[0].id;
    loadAll(service);
    const library = await service.libraryIndex();
    assert.equal(library.books.length, 0);
    assert.equal(library.missing, true);
    assert.equal(library.error, '');
    assert.deepEqual(library.sources.map((entry) => [entry.id, entry.missing]), [[id, true]]);
  });
});

// ---------------------------------------------------------------------------
// 回归：重新载入书单之后，新出现的书必须点得开
// ---------------------------------------------------------------------------

describe('书单缓存与 id 映射的一致性', () => {
  it('★ 重新载入之后，新出现的书必须点得开（`bookMap` 要跟着索引一起失效）', async () => {
    /**
     * 真实序列（路由那一侧）是：
     *   `POST /reload`          → `library.invalidate()` + `loadLibrary()`  ← 读文件，reloaded=true
     *   同一请求里接着 `bookList` → `listBooks()` → `loadLibrary()`          ← 缓存命中，reloaded=false
     *   `GET /book/:id/raw`     → `bookById()` → `libraryIndex()`            ← 同上，reloaded=false
     *
     * `reloaded` 是**一次性**标记（`createLibrary.load()` 只在真读文件的那一次给 true）：
     * 谁先调用谁把它消费掉。所以「按 id 取书」这条路**不能依赖那个标记**才不会漏 ——
     * 现在靠 `loadLibrary()` 在真读文件时清 `bookMap`。
     *
     * 修之前的表现：点一次「重新载入书单」，列表更新了、新书显示出来了，
     * 但点开那本新书报「没有这本书」，而且一直坏到下次「生成书单」为止。
     */
    const { service } = boot();
    await service.ready;
    const dir = await seedLocalSource('src-reload', ['先来的.pdf']);
    await service.setBookSources([{ kind: 'local', path: dir }]);
    await service.scanBookSources();
    loadAll(service);
    await service.libraryIndex(); // 先把 bookMap 建起来（老的那一份）

    // 用户在自己的工具里加了一本，然后点「重新载入」。
    await writeFile(join(dir, '手动加的.pdf'), 'PDF:manual');
    const index = listFilePath(service.bookSources()[0].id);
    const payload = JSON.parse(await readFile(index, 'utf8'));
    payload.books.push({
      id: 'manualone',
      filename: '手动加的.pdf',
      ext: 'pdf',
      size: 10,
      abspath: join(dir, '手动加的.pdf'),
      top_dir: '',
      title: '手动加的',
    });
    await writeFile(index, JSON.stringify(payload));

    service.library.invalidate();
    await service.loadLibrary(); // ← 等价于 `POST /reload` 里那一次
    await service.loadLibrary(); // ← 等价于随后那个 `bookList` 把标记消费掉

    assert.equal(
      (await service.bookById('manualone'))?.filename,
      '手动加的.pdf',
      '重载之后新书点不开 —— bookMap 没跟着索引一起失效',
    );
    // 反向对照：老书也还在（不许为了修新书把老的弄丢）。
    const all = await service.libraryIndex();
    assert.equal(all.books.length, 2);
  });

  it('反向对照：不重载时 bookMap 保持复用（不是每次都重建）', async () => {
    const { service } = boot();
    await service.ready;
    await service.setBookSources([{ kind: 'local', path: await seedLocalSource('src-cache', ['甲.pdf']) }]);
    await service.scanBookSources();
    loadAll(service);
    await service.libraryIndex();
    const first = service.bookMap;
    await service.libraryIndex();
    assert.equal(service.bookMap, first, '没有重载却重建了 map（每次读都重建会让大书单变慢）');
  });

  it('★ 载入集合变了要**立刻**生效，不能等 mtime 分辨率翻过去', async () => {
    // 用户一秒内连点两下「勾上 / 取消」时，两次写盘的 mtime 可能落在同一毫秒 ——
    // 靠 mtime 判缓存的话第二次点了没反应，而用户只会以为插件卡了。
    const { service } = boot();
    await service.ready;
    await service.setBookSources([
      { kind: 'local', path: await seedLocalSource('src-load-a', ['甲.pdf']) },
      { kind: 'local', path: await seedLocalSource('src-load-b', ['乙.pdf']) },
    ]);
    const [first, second] = service.bookSources();
    await service.scanBookSources();

    service.setLoadedLists([first.id]);
    assert.deepEqual((await service.libraryIndex()).books.map((book) => book.filename), ['甲.pdf']);
    service.setLoadedLists([first.id, second.id]);
    // ★ 两边都 `.sort()`：这条用例问的是「第二份点下去生效了没有」，顺序由
    //   `mergeSources` 的中文排序决定（`zh-Hans-CN`，甲 jiǎ 在乙 yǐ 前）。
    //   只对一边 `.sort()` 会把它重新排成 UTF-16 码点序（乙 U+4E59 在甲 U+7532 前），
    //   于是断言变成在否定实现本身；两边都排则把 ICU 版本的差异挡在外面。
    assert.deepEqual(
      (await service.libraryIndex()).books.map((book) => book.filename).sort(),
      ['甲.pdf', '乙.pdf'].slice().sort(),
    );
    service.setLoadedLists([]);
    assert.deepEqual((await service.libraryIndex()).books, []);
    // 反向对照：`loadedListIds` 是**设置**（会落盘），不只是内存态。
    assert.deepEqual(service.store.data.settings.libraryListIds, []);
    service.setLoadedLists(['sdeadbeefdeadbeef']);
    assert.deepEqual(service.loadedListIds(), ['sdeadbeefdeadbeef'], '未知 id 不该被静默丢掉');
  });

  it('★ `libraryPayload()` 把「配置」与「清单」join 一次：名字来自设置，本数来自扫描', async () => {
    // 放两处 join 的后果是「设置里改了名字、列表上还是旧的」—— 而用户会去重启插件。
    const { service } = boot();
    await service.ready;
    await service.setBookSources([{ kind: 'local', path: await seedLocalSource('src-payload', ['甲.pdf']) }]);
    const id = service.bookSources()[0].id;
    await service.scanBookSources();

    const payload = await service.libraryPayload();
    assert.deepEqual(Object.keys(payload).sort(), [
      'external', 'legacy', 'lists', 'loadedListIds', 'output', 'sources',
    ]);
    assert.deepEqual(
      payload.lists.map((row) => [row.id, row.name, row.kind, row.count, row.loaded]),
      [[id, 'src-payload', 'local', 1, false]],
    );
    assert.equal(payload.lists[0].path, listFilePath(id));
    assert.equal(payload.lists[0].root, join(sandbox, 'src-payload'));
    assert.equal(payload.output.dir, bookListsDir());
    assert.equal(payload.output.indexPath, bookListsIndexPath());
    assert.equal(payload.external.used, false);
    assert.equal(payload.legacy, null, '没有旧版合并书单时必须是 null，不是空壳对象');

    // ★ 改名之后**同一个 id**、新的名字 —— 这条正是「id 与名字解耦」的意义。
    await service.setBookSources([{ id, kind: 'local', path: join(sandbox, 'src-payload'), name: '我的电子书' }]);
    const renamed = await service.libraryPayload();
    assert.deepEqual(
      renamed.lists.map((row) => [row.id, row.name, row.count]),
      [[id, '我的电子书', 1]],
    );
    // 反向对照：改名**不动**书单文件，本数照旧。
    assert.equal((await booksOf(id)).length, 1);
  });

  it('★ 外部书单：配了就读、清空就**不读**（空串不是「回落到插件自己那份」）', async () => {
    const { service } = boot();
    await service.ready;
    await service.setBookSources([{ kind: 'local', path: await seedLocalSource('src-ext', ['甲.pdf']) }]);
    await service.scanBookSources();
    loadAll(service);

    const external = join(sandbox, '外部的书单.json');
    await writeFile(external, JSON.stringify([{ id: 'extbook1', filename: '外来的.pdf', ext: 'pdf', size: 5, abspath: join(sandbox, '外来的.pdf'), title: '外来的' }]));
    service.store.data.settings.libraryPath = external;

    // 0.8.0 起「外部书单」**不再自动载入**：它是用户显式配的一条额外来源，
    // 但仍然走同一次合并（否则会绕开去重，同一本书出现两次）。
    const library = await service.libraryIndex();
    assert.equal(library.books.length, 2);
    assert.equal(library.external?.id, 'external');
    assert.equal(library.external.count, 1);
    assert.deepEqual(library.sources.map((entry) => entry.external), [false, true]);

    // 清空 ⇒ 不再读它，且**不**回落到插件数据目录里的任何一份。
    service.store.data.settings.libraryPath = '';
    assert.equal(resolveLibraryPath(''), '');
    service.library.invalidate();
    const after = await service.libraryIndex();
    assert.deepEqual(after.books.map((book) => book.filename), ['甲.pdf']);
    assert.equal(after.external, null);

    // 反向对照：外部那份文件**一个字节都没被写**（它对我们是只读的）。
    assert.equal(JSON.parse(await readFile(external, 'utf8'))[0].id, 'extbook1');
  });
});

// ---------------------------------------------------------------------------
// 损坏的 data.json —— P0-1 的端到端守卫
// ---------------------------------------------------------------------------

describe('损坏的 data.json', () => {
  /** 起一个 service，但 `DSH_HOME` 里已经躺着一份坏 JSON。 */
  async function bootCorrupt(corrupt) {
    const home = join(sandbox, `home-corrupt-${homeCounter}`);
    homeCounter += 1;
    process.env.DSH_HOME = home;
    const dataPath = join(home, 'storages', 'dsh-npie-reader', 'data.json');
    await mkdir(dirname(dataPath), { recursive: true });
    await writeFile(dataPath, corrupt, 'utf8');
    const fake = createFakeContext({});
    globalThis.fetch = fake.state.fetch;
    const service = new RssService(fake.ctx, {});
    liveServices.add(service);
    return { ...fake, service, dataPath };
  }

  it('★ 守卫：不产生 unhandledRejection，服务照常起，且原文件逐字节不变', async () => {
    // 修之前是**双重灾难**：
    //  ① `service.js:124` 的 `this.ready = this.store.load().then(...)` 没有 `.catch()`
    //     ⇒ 一个没人接手的 rejected promise ⇒ `unhandledRejection` ⇒ Node ≥15 默认
    //     **终止进程**。而它发生在启动后几毫秒，那时还没有任何请求去 `await this.ready`
    //     （33 个调用点全在工具/路由里）—— 所以「await 一下就好了」救不了。
    //  ② 就算进程活下来：`load()` 在给 `this.data` 赋值**之前**就抛了，`this.data`
    //     还是 `defaults()`；而卸载时的 `dispose() → flush()` 把那份默认值写回去，
    //     用户所有订阅/收藏/已读/译文/书架进度全丢，唯一能抢救的原始文件也没了。
    //
    // ★ 反向对照（两条都要红）：
    //   - 删掉 service.js 里 `load()` 后面的 `.catch(...)` ⇒ 本用例在 `seen` 上必红；
    //   - 删掉 store.js `flush()` 里的 `if (this.corrupt) return;` ⇒ 末尾那条必红。
    const corrupt = '{"subscriptions": [ truncated';
    const { service, dataPath, state } = await bootCorrupt(corrupt);
    const before = await readFile(dataPath);

    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await service.ready;
      // 再等一拍：unhandledRejection 是在微任务队列排空之后才判定的，
      // 只 `await service.ready` 不足以证明「没有未处理的 rejection」。
      await new Promise((resolve) => { setTimeout(resolve, 30); });

      assert.deepEqual(seen, [], `不允许出现未处理的 rejection：${seen.map(String).join(' | ')}`);
      assert.match(service.dataError, /refusing to overwrite/);
      assert.equal(service.store.corrupt, true, '必须留下 corrupt 标记');

      // 服务照常可用 —— 不该因为一份坏文件就让整个面板起不来。
      const payload = await service.listChannels();
      assert.deepEqual(payload.channels.map((channel) => channel.key), ['all', 'feeds:all']);

      // ★ 但**必须说出来**。内存里是空的，不说的话界面显示「一个订阅都没有」、
      //   模型告诉用户「你还没订阅任何源」—— 而真相是「数据读不出来，还能抢救」。
      assert.match(payload.dataError, /refusing to overwrite/);

      const listChannelsTool = state.tools.find((tool) => tool.name === 'rss_list_channels');
      const out = listChannelsTool.output.render({}, await listChannelsTool.execute({}))
        .map((part) => part.text).join('');
      assert.match(out, /数据文件读不出来/);
      assert.match(out, /拒绝覆盖/);

      // 卸载路径：`dispose()` 走 `flush()`，必须被闸门拦住。
      await service.store.dispose();
      assert.deepEqual(await readFile(dataPath), before, 'dispose() 之后原文件必须逐字节不变');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('读不出来只影响「读」，不影响「写别的文件」：网盘凭证迁移照常跑', async () => {
    // 迁移写的是 `pan-app.json`，不是 `data.json` —— 两件事互不相干，
    // 不该因为数据文件坏了就顺带把凭证迁移也停掉。
    const { service } = await bootCorrupt('{"broken":');
    await service.ready;
    assert.ok(service.panAuth, '服务其余部分必须照常装配');
    assert.equal(service.store.corrupt, true);
    assert.equal(service.store.quarantinedTo !== undefined, true, '应当留下取证副本');
  });
});
