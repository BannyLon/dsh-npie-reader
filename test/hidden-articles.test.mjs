/**
 * 文章级「隐藏」（0.44.9）。
 *
 * 这个动作的每一条错法都**不报错**，所以必须逐条钉：
 *   ① 只记在客户端 ⇒ 刷新一次全回来（看着像「按钮没生效」）；
 *   ② 过滤放在分页**之后** ⇒ 一页少几条、`hasMore` 却按摘之前算 ⇒ 「加载更早」提前消失；
 *   ③ `hiddenCount` 报全局数 ⇒ 「已隐藏 3」点进去只有 1 条；
 *   ④ 不裁剪 ⇒ 只增不减，和 `read` 一样会无限长；
 *   ⑤ 老数据里 `hidden` 是数组 ⇒ `obj[key] = …` 挂到数组上，既不报错也不生效。
 *
 * 前四条走真实现（store / service），第五条走真 `load()`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createFakeContext, rssDocument } from './helpers/fake-ctx.mjs';
import { loadHostBundle } from './helpers/host-bundle.mjs';
import { stripComments } from '../scripts/strip-comments.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(join(tmpdir(), 'npie-hidden-'));
process.env.DSH_HOME = sandbox;
// 与 `service.test.mjs` 同一条纪律：`~/.baidu-pan-*` 的迁移走 `os.homedir()`，
// 不受 `DSH_HOME` 约束 —— 不隔离就会去读用户真实 home。
process.env.HOME = sandbox;

const { RssService, RssStore, MAX_HIDDEN_IDS, defaultData } = await loadHostBundle();

const live = new Set();
after(async () => {
  // 只清计时器、不 flush：去抖计时器会在 `rm -rf` 途中醒来，把目录又建出来（ENOTEMPTY）。
  for (const item of live) {
    const store = item.store ?? item;
    if (store?.saveTimer !== undefined) { clearTimeout(store.saveTimer); store.saveTimer = undefined; }
  }
  live.clear();
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

const silent = { warn() {}, info() {}, error() {} };

let homeCounter = 0;
function newStore() {
  homeCounter += 1;
  process.env.DSH_HOME = join(sandbox, `store-${homeCounter}`);
  const store = new RssStore(silent);
  live.add(store);
  return store;
}

function boot(options = {}) {
  homeCounter += 1;
  process.env.DSH_HOME = join(sandbox, `home-${homeCounter}`);
  const fake = createFakeContext(options);
  globalThis.fetch = fake.state.fetch;
  const service = new RssService(fake.ctx, { pageGuard: async () => ({ ok: true }) });
  live.add(service);
  return { ...fake, service };
}

/** 五条同源文章（标题 A…E），日期递增 ⇒ 列表按新到旧是 E D C B A。 */
const fiveItems = () => ({
  fetchPlan: [{
    body: rssDocument({
      title: 'Feed A',
      items: [
        { title: 'Alpha', pubDate: 'Mon, 22 Sep 2025 08:00:00 GMT' },
        { title: 'Bravo', pubDate: 'Tue, 23 Sep 2025 08:00:00 GMT' },
        { title: 'Charlie', pubDate: 'Wed, 24 Sep 2025 08:00:00 GMT' },
        { title: 'Delta', pubDate: 'Thu, 25 Sep 2025 08:00:00 GMT' },
        { title: 'Echo', pubDate: 'Fri, 26 Sep 2025 08:00:00 GMT' },
      ],
    }),
  }],
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

describe('0.44.9：隐藏 —— 数据层', () => {
  it('默认数据里就有 hidden（老版本读上来也不会是 undefined）', () => {
    assert.deepEqual(defaultData().hidden, {});
  });

  it('隐藏 / 恢复 / 判据三件事自洽', () => {
    const store = newStore();
    assert.equal(store.isHidden('k1'), false);
    assert.equal(store.hideArticle('k1'), true, '第一次隐藏应当报告「变了」');
    assert.equal(store.isHidden('k1'), true);
    assert.equal(store.hiddenCount(), 1);
    assert.equal(store.unhideArticle('k1'), true);
    assert.equal(store.isHidden('k1'), false);
    assert.equal(store.hiddenCount(), 0);
  });

  it('★ 重复隐藏是幂等的（不刷新时间戳）', () => {
    const store = newStore();
    store.hideArticle('k1');
    const stamp = store.data.hidden.k1;
    assert.equal(store.hideArticle('k1'), false, '第二次隐藏不该再报「变了」');
    assert.equal(store.data.hidden.k1, stamp, '时间戳被刷新了 —— 淘汰顺序会跟着变');
  });

  it('恢复一篇没隐藏过的不报错、也不留垃圾', () => {
    const store = newStore();
    assert.equal(store.unhideArticle('nope'), false);
    assert.deepEqual(store.data.hidden, {});
  });

  it('空 key 一律不动（`undefined` 会变成一个叫 "undefined" 的键）', () => {
    const store = newStore();
    for (const bad of ['', undefined, null, 42]) {
      assert.equal(store.hideArticle(bad), false, `hideArticle(${String(bad)}) 不该生效`);
    }
    assert.deepEqual(store.data.hidden, {});
  });

  it('★ 超过上限按「隐藏时刻」淘汰最老的', () => {
    const store = newStore();
    for (let index = 0; index <= MAX_HIDDEN_IDS; index += 1) {
      store.hideArticle(`k${index}`);
      // 时间戳同毫秒会让排序退化成「插入顺序」，这里显式岔开
      store.data.hidden[`k${index}`] = index;
    }
    store.trimHidden();
    assert.equal(store.hiddenCount(), MAX_HIDDEN_IDS, `没裁到 ${MAX_HIDDEN_IDS} —— 这个对象会只增不减`);
    assert.equal(store.isHidden('k0'), false, '最老的没被淘汰');
    assert.equal(store.isHidden(`k${MAX_HIDDEN_IDS}`), true, '刚写的反而被删了');
  });

  it('★ 老数据里 hidden 是数组 ⇒ 归一成对象（否则隐藏静默失效）', async () => {
    const dir = join(sandbox, 'legacy-array');
    await mkdir(join(dir, 'storages', 'dsh-npie-reader'), { recursive: true });
    await writeFile(join(dir, 'storages', 'dsh-npie-reader', 'data.json'),
      JSON.stringify({ ...defaultData(), hidden: ['stale-key'] }), 'utf8');
    process.env.DSH_HOME = dir;
    const store = new RssStore(silent);
    live.add(store);
    await store.load();
    assert.equal(Array.isArray(store.data.hidden), false, '数组没被归一 —— 往数组上挂键既不报错也不生效');
    assert.equal(store.hideArticle('k1'), true);
    assert.equal(store.isHidden('k1'), true, '隐藏写进去了但读不出来 —— 归一没生效');
  });
});

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

describe('0.44.9：隐藏 —— 列表与检索', () => {
  it('★ 隐藏的文章从「全部」里消失，且能出现在「已隐藏」里', async () => {
    const { service } = boot(fiveItems());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const target = sub.entries.find((entry) => entry.title === 'Charlie');

    await service.setHidden({ key: target.key, hidden: true });

    const all = await service.listEntries({ channel: 'all' });
    assert.equal(all.entries.length, 4, '隐藏的那篇还在「全部」里（计数没减）');
    assert.ok(!all.entries.some((entry) => entry.key === target.key), '隐藏的那篇还在「全部」里');

    const hiddenList = await service.listEntries({ channel: 'all', filter: 'hidden' });
    assert.deepEqual(hiddenList.entries.map((entry) => entry.title), ['Charlie']);
    assert.equal(hiddenList.entries[0].hidden, true, '「已隐藏」里的条目必须自带 hidden 标记（菜单要靠它变「恢复」）');
  });

  it('★ hiddenCount 按当前频道数，不是全局数', async () => {
    const { service } = boot({
      fetchPlan: [
        { body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }, { title: 'A2' }] }) },
        { body: rssDocument({ title: 'Feed B', items: [{ title: 'B1' }, { title: 'B2' }] }) },
      ],
    });
    await service.ready;
    const first = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });
    const a1 = first.entries.find((entry) => entry.title === 'A1');
    await service.setHidden({ key: a1.key, hidden: true });

    const { channels } = await service.listChannels();
    const feedA = channels.find((channel) => channel.name === 'Feed A');
    assert.equal((await service.listEntries({ channel: feedA.key })).hiddenCount, 1, 'A 源里藏了 1 篇');
    const all = await service.listEntries({ channel: 'all' });
    assert.equal(all.hiddenCount, 1, '「全部」里也只藏了 1 篇 —— 报全局数会变成 1 但含义不同');
    // 换成 B 源：一篇都没藏，入口必须消失
    const feedB = channels.find((channel) => channel.name === 'Feed B');
    assert.equal((await service.listEntries({ channel: feedB.key })).hiddenCount, 0,
      'B 源里一篇都没藏，却报了 1 —— 界面上会出现「已隐藏 1」，点进去是空的');
  });

  it('★ 过滤发生在分页之前（hasMore 与条目数同源）', async () => {
    const { service } = boot(fiveItems());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    // 藏掉最新的两篇（Echo / Delta）—— 分页若在过滤之前，第一页会只剩 1 条
    for (const title of ['Echo', 'Delta']) {
      await service.setHidden({ key: sub.entries.find((entry) => entry.title === title).key, hidden: true });
    }
    const page = await service.listEntries({ channel: 'all', limit: 2 });
    assert.equal(page.entries.length, 2, '分页按摘之前的总数算 —— 一页只剩 1 条');
    assert.deepEqual(page.entries.map((entry) => entry.title), ['Charlie', 'Bravo']);
    assert.equal(page.hasMore, true);

    const rest = await service.listEntries({ channel: 'all', limit: 2, cursor: page.nextCursor });
    assert.deepEqual(rest.entries.map((entry) => entry.title), ['Alpha']);
    assert.equal(rest.hasMore, false, '「加载更早」还在，但下一页是空的');
  });

  it('★ 搜索也跳过隐藏的文章（否则「不想再看到」只是列表上的遮羞布）', async () => {
    const { service } = boot(fiveItems());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.setHidden({ key: sub.entries.find((entry) => entry.title === 'Charlie').key, hidden: true });

    const hit = await service.searchArticles({ query: 'Charlie' });
    assert.equal(hit.length, 0, '隐藏过的文章还能被搜出来');
    // 反向对照：没藏的那篇必须搜得到，否则「搜不到」可能只是搜索本身坏了
    assert.equal((await service.searchArticles({ query: 'Bravo' })).length, 1);
  });

  it('setHidden 回报**实际**状态，而不是把入参回显出去', async () => {
    const { service } = boot(fiveItems());
    await service.ready;
    const sub = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    const key = sub.entries[0].key;

    const hidden = await service.setHidden({ key, hidden: true });
    assert.equal(hidden.hidden, true);
    const again = await service.setHidden({ key, hidden: true });
    assert.equal(again.hidden, true);
    assert.equal(again.changed, false, '重复隐藏报告了「变了」');

    const restored = await service.setHidden({ key, hidden: false });
    assert.equal(restored.hidden, false);
    assert.equal((await service.listEntries({ channel: 'all' })).entries.length, 5);
  });

  it('setHidden 缺 key 时明确报错（而不是悄悄成功）', async () => {
    const { service } = boot(fiveItems());
    await service.ready;
    await assert.rejects(() => service.setHidden({}), /缺少文章标识/);
  });
});

// ---------------------------------------------------------------------------
// 客户端接线
// ---------------------------------------------------------------------------

describe('0.44.9：隐藏 —— 客户端接线', () => {
  const clientDir = join(pluginRoot, 'src', 'client');
  const reader = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));
  const index = stripComments(readFileSync(join(clientDir, 'index.jsx'), 'utf8'));

  it('客户端半区声明了 setHidden', () => {
    assert.match(index, /method\('setHidden'\)/, 'TYPERT 描述符里没有它 —— 运行期会「点了没反应」');
    assert.match(index, /setHidden: \(key, hidden\) => call\('setHidden', \{ key, hidden \}\)/);
  });

  it('★ 菜单是两态（隐藏 / 恢复），不是一个位置只放「隐藏」', () => {
    assert.match(reader, /activeArticle\.article\.hidden \?/, '菜单没按 hidden 分支');
    assert.match(reader, /隐藏这篇文章/);
    assert.match(reader, /恢复这篇文章/);
  });

  it('★ 撤销走提示条上的按钮，而且按钮点了会先关掉提示', () => {
    assert.match(reader, /label: '撤销'/, '隐藏之后没有给撤销');
    assert.match(reader, /toast\.action/, '提示条没渲染 action');
    assert.match(reader, /const action = toast\.action; setToast\(undefined\)/,
      '点了撤销提示还挂着 —— 用户会以为没生效');
  });

  it('★ 带按钮的提示活得比普通提示久', () => {
    assert.match(reader, /action \? 8000 : 2400/,
      '撤销按钮和普通提示一个时长 —— 2400ms 之内找不到鼠标，撤销等于没给');
  });

  it('隐藏后从列表里摘掉，并同步 hiddenCount', () => {
    assert.match(reader, /entries: previous\.entries\.filter\(\(entry\) => entry\.key !== key\)/);
    assert.match(reader, /hiddenCount: \(previous\.hiddenCount \?\? 0\) \+ 1/);
  });

  it('★ 追加页也要带上 hiddenCount', () => {
    assert.match(reader, /hiddenCount: data\.hiddenCount/, '加载更早之后「已隐藏 N」入口会消失');
  });

  it('「已隐藏」筛选在有东西藏着时才出现（并在该档常驻）', () => {
    assert.match(reader, /page\.hiddenCount > 0 \|\| filter === 'hidden'/,
      '只按计数判断 ⇒ 恢复最后一篇后当前筛选连同选中态一起消失');
  });

  it('空态文案认识 hidden 这一档', () => {
    const route = stripComments(readFileSync(join(clientDir, 'channel-route.js'), 'utf8'));
    assert.match(route, /filter === 'hidden'/, '「已隐藏」空了之后会掉进「这个频道暂无文章」—— 那句话在这里是假话');
  });
});
