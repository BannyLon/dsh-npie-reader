/**
 * RssStore：持久化路径、原子写、上限裁剪、损坏数据拒绝覆盖。
 *
 * ★ 安全前提：`dataFilePath()` 解析的是 `DSH_HOME`，默认落在用户真实的 `~/.dsh`。
 *   本文件在**构造任何 store 之前**把 `DSH_HOME` 指向临时目录，并断言解析结果
 *   确实在 `tmpdir()` 下 —— 万一将来有人改坏了这条链路，测试会当场判红，
 *   而不是把用户真实的订阅数据覆盖掉。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { loadHostBundle } from './helpers/host-bundle.mjs';
/**
 * 这几个**直接从源码导入**，不走 `loadHostBundle()` —— 后者只导出宿主入口
 * re-export 过的那一批，而路径函数与迁移函数不在里面。
 * 与 `library-e2e-http.test.mjs` / `book-lists.test.mjs` 是同一个惯例。
 * （混用没有副作用：两边算的是同一个 `DSH_HOME` 环境变量。）
 */
import {
  legacyPanAppPath, legacyPanTokenPath, migrateLegacyPanCredentials, panAppPath, panTokenPath,
} from '../src/host/store.js';

const sandbox = await mkdtemp(join(tmpdir(), 'npie-store-'));
process.env.DSH_HOME = sandbox;

const { MAX_ARTICLE_BODIES, RssStore, dataFilePath, defaultData } = await loadHostBundle();

const silentLogger = { warn() {}, info() {}, error() {} };

/**
 * 本文件创建过的所有 store。
 *
 * ★ 为什么必须记着它们：`touch()` 只是排一个 **500ms 去抖**的落盘计时器，而沙箱是
 * **下一个 beforeEach** 才 `rm -rf storages` 的。于是「用例 A 改了数据 → 用例 B 的
 * beforeEach 删掉目录 → 用例 A 的计时器才醒来、把 A 的数据写回去」——目录又长出来了，
 * 读到脏数据的是**用例 C**，而症状离原因隔了两条用例。
 * 实测症状：`catalog.sources` 里躺着上一条用例的条目 ⇒ `catalogSourceById` 找不到刚加的那条。
 *
 * 只清计时器、**不 flush**：flush 会把内存里的 defaults 覆盖到盘上，那会打死
 * 「拒绝覆盖损坏文件」和「flush 写出完整文档」这两条专门检查文件内容的用例。
 */
const liveStores = new Set();

function newStore() {
  const store = new RssStore(silentLogger);
  liveStores.add(store);
  return store;
}

afterEach(() => {
  for (const store of liveStores) {
    if (store.saveTimer !== undefined) {
      clearTimeout(store.saveTimer);
      store.saveTimer = undefined;
    }
  }
  liveStores.clear();
});

async function resetSandbox() {
  await rm(join(sandbox, 'storages'), { recursive: true, force: true });
}

after(() => rm(sandbox, { recursive: true, force: true }));

describe('dataFilePath', () => {
  it('lives under DSH_HOME/storages, not under the real user home', () => {
    const path = dataFilePath();
    assert.ok(path.startsWith(sandbox), `expected a sandbox path, got ${path}`);
    assert.equal(path, join(sandbox, 'storages', 'dsh-npie-reader', 'data.json'));
  });
});

describe('defaultData', () => {
  it('is a fresh object each call (no shared mutable state between stores)', () => {
    assert.notEqual(defaultData(), defaultData());
    assert.deepEqual(Object.keys(defaultData()).sort(), [
      'ai', 'articles', 'catalog', 'companionContexts', 'favorites', 'library', 'read', 'recent', 'settings', 'subscriptions', 'version',
    ]);
    // `library` 是**本插件自己的**书架进度（`{ states, importedFrom }`）。
    // 用户那份 ebook-sorter/data/reading.json 是只读导入源，绝不回写 —— 见 store.js 的注释。
    assert.deepEqual(defaultData().library, { states: {}, importedFrom: '' });
  });
});

describe('load', () => {
  beforeEach(resetSandbox);

  it('falls back to defaults when no file exists yet', async () => {
    const store = newStore();
    await store.load();
    assert.deepEqual(store.data.subscriptions, []);
    assert.equal(store.data.settings.aiAssist, true);
  });

  it('merges a partial document over the defaults', async () => {
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ settings: { aiAssist: false }, read: { 'feed:x': 1 } }), 'utf8');

    const store = newStore();
    await store.load();
    assert.equal(store.data.settings.aiAssist, false);
    assert.equal(store.data.settings.showImages, true, 'missing settings keys must keep their default');
    assert.deepEqual(store.data.read, { 'feed:x': 1 });
    assert.deepEqual(store.data.subscriptions, [], 'missing top-level keys must keep their default');
  });

  it('refuses to overwrite a corrupt file instead of silently resetting it', async () => {
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    const corrupt = '{"subscriptions": [ truncated';
    await writeFile(path, corrupt, 'utf8');

    const store = newStore();
    await assert.rejects(() => store.load(), /refusing to overwrite/);
    assert.equal(await readFile(path, 'utf8'), corrupt, 'the on-disk file must be left untouched');
  });

  it('★ 守卫：load() 抛错之后 dispose() 也必须让原文件**逐字节不变**', async () => {
    // 这是 P0-1 的核心断言，也是「拒绝覆盖」这句承诺唯一能被验证的地方。
    // 修之前：`load()` 在给 `this.data` 赋值**之前**就抛了，所以 `this.data` 还是
    // 构造函数里的 `defaults()`；而 `dispose()`（插件卸载时由 `ctx.effect` 的清理
    // 钩子调用）无条件走 `flush()` ⇒ 把那份默认值写回去 ⇒ 用户 89 字节的原始数据
    // 变成 278 字节的默认值，且唯一还能抢救的原始文件被抹掉。
    //
    // ★ 反向对照：把 `flush()` 开头那条 `if (this.corrupt) return;` 删掉，本用例必红。
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    const corrupt = '{"subscriptions": [ truncated';
    await writeFile(path, corrupt, 'utf8');
    const before = await readFile(path);

    const store = newStore();
    await assert.rejects(() => store.load(), /refusing to overwrite/);
    assert.equal(store.corrupt, true, '必须留下 corrupt 标记，否则后续写入拦不住');

    await store.dispose();
    assert.deepEqual(await readFile(path), before, 'dispose() 之后原文件必须逐字节不变');

    // 去抖那条路（touch → flush）走的是另一个入口，同样必须被拦住 ——
    // 闸门放在 flush() 里就是为了这个：三个入口共用一道判定，不可能漏掉一个。
    store.markRead(['feed:x'], true);
    await store.flush();
    assert.deepEqual(await readFile(path), before, 'flush() 也必须拒绝写');
  });

  it('读不出来时留一份取证副本，且**原文件仍在原地**', async () => {
    // ★ 为什么是「复制」不是「改名挪走」：改名会让 `data.json` 消失，下一次启动
    //   变成 ENOENT ⇒ 走「全新用户」分支 ⇒ 之后一切照常写入，用户再也看不到出过事。
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    const corrupt = '{"subscriptions": [ truncated';
    await writeFile(path, corrupt, 'utf8');

    const store = newStore();
    await assert.rejects(() => store.load(), /refusing to overwrite/);
    assert.ok(store.quarantinedTo, '应当留下一份取证副本的路径');
    assert.equal(await readFile(store.quarantinedTo, 'utf8'), corrupt, '副本内容必须与原文件一致');
    assert.equal(await readFile(path, 'utf8'), corrupt, '原文件仍在原地');
    assert.match(store.corruptReason, /JSON|Unexpected|position/i, '要记下坏在哪');

    // 幂等：坏文件会一直坏着（我们拒绝覆盖），再读一次不该再复制一份。
    const second = newStore();
    await assert.rejects(() => second.load(), /refusing to overwrite/);
    assert.equal(second.quarantinedTo, undefined, '已经有过副本就不再复制，免得每次启动都灌垃圾');
    const siblings = (await readdir(dirname(path))).filter((name) => name.startsWith('data.json.corrupt-'));
    assert.equal(siblings.length, 1, `只该有一份取证副本，实得 ${JSON.stringify(siblings)}`);
  });

  it('★ 守卫：reset() 是唯一允许覆盖的路径，覆盖前必须先备份', async () => {
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    const original = JSON.stringify({ subscriptions: [{ id: 'feed:a', url: 'https://a.example/f', name: 'A' }] });
    await writeFile(path, original, 'utf8');

    const store = newStore();
    await store.load();
    const backup = await store.reset();

    assert.ok(backup, 'reset() 必须返回备份路径');
    assert.equal(await readFile(backup, 'utf8'), original, '备份必须逐字节等于被覆盖前的内容');
    const now = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(now.subscriptions, [], 'reset 之后盘上是默认值');
  });

  it('★ 守卫：坏文件也挡不住 reset()（用户明确要求重来时必须真的重来）', async () => {
    // 不这样处理的话 `reset()` 会被 flush() 的闸门静默吃掉，变成一个点了没反应的按钮。
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"subscriptions": [ truncated', 'utf8');

    const store = newStore();
    await assert.rejects(() => store.load(), /refusing to overwrite/);
    assert.equal(store.corrupt, true);

    await store.reset();
    assert.equal(store.corrupt, false, 'reset 必须清掉 corrupt 标记');
    const now = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(now.subscriptions, [], 'reset 之后盘上是默认值');
  });

  it('归一「只写了一半」的 catalog：老数据没有它、或者只有 sources', async () => {
    // 顶层 `{...defaults(), ...parsed}` 是整块覆盖：老版本数据里根本没有 catalog 时能靠默认值兜住，
    // 但 `{ catalog: { sources: [...] } }` 会让 `hidden` 变成 undefined ——
    // 紧接着 `hideCatalogUrl` 里的 `.includes` 就抛 TypeError，而症状离原因很远（表现为「隐藏按钮点了报错」）。
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ catalog: { sources: [{ id: 'cat:1', url: 'https://a.example/f' }] } }), 'utf8');

    const store = newStore();
    await store.load();
    assert.deepEqual(store.data.catalog.hidden, []);
    // `service` 是后加的字段：老数据里没有它，不单独归一就会是 undefined ⇒ `.base` 直接抛。
    assert.deepEqual(store.data.catalog.service, { base: '' });
    assert.equal(store.data.catalog.sources.length, 1);
    // 归一之后隐藏 / 取消隐藏都必须能跑，不抛。
    store.hideCatalogUrl('https://a.example/f');
    store.unhideCatalogUrl('https://a.example/f');
    assert.deepEqual(store.data.catalog.hidden, []);
  });

  it('反向对照：catalog 字段类型不对时回落到空数组，而不是把脏值原样带进内存', async () => {
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ catalog: { sources: 'oops', hidden: { a: 1 } } }), 'utf8');

    const store = newStore();
    await store.load();
    assert.deepEqual(store.listCatalog(), { sources: [], hidden: [], service: { base: '' } });
  });

  it('反向对照：service.base 不是字符串时回落到空串', async () => {
    const path = dataFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ catalog: { service: { base: 42 } } }), 'utf8');

    const store = newStore();
    await store.load();
    assert.deepEqual(store.data.catalog.service, { base: '' });
  });
});

describe('flush', () => {
  beforeEach(resetSandbox);

  it('writes the whole document and leaves no temp file behind', async () => {
    const store = newStore();
    await store.load();
    store.data.read['feed:a'] = 42;
    await store.flush();

    const path = dataFilePath();
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), store.data);

    const leftovers = (await readdir(dirname(path))).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the atomic temp file must be renamed away, not left on disk');
  });

  it('serializes concurrent flushes instead of interleaving them', async () => {
    const store = newStore();
    await store.load();
    store.data.read['feed:a'] = 1;
    const first = store.flush();
    store.data.read['feed:b'] = 2;
    const second = store.flush();
    await Promise.all([first, second]);

    // The last flush must have seen the last mutation — an interleaved write
    // would have persisted the older snapshot.
    assert.deepEqual(Object.keys(JSON.parse(await readFile(dataFilePath(), 'utf8')).read).sort(), ['feed:a', 'feed:b']);
  });
});

describe('touch / dispose', () => {
  beforeEach(resetSandbox);

  it('debounces to a single pending timer and dispose() flushes it out', async () => {
    const store = newStore();
    await store.load();

    store.touch();
    const pending = store.saveTimer;
    assert.notEqual(pending, undefined, 'the first touch must arm the timer');
    store.touch();
    assert.equal(store.saveTimer, pending, 'a second touch must reuse the armed timer, not arm another');

    store.data.read['feed:a'] = 1;
    await store.dispose();
    assert.equal(store.saveTimer, undefined, 'dispose must clear the pending timer');
    assert.ok(existsSync(dataFilePath()), 'dispose must have flushed');
    assert.deepEqual(JSON.parse(await readFile(dataFilePath(), 'utf8')).read, { 'feed:a': 1 });
  });
});

describe('read state', () => {
  beforeEach(resetSandbox);

  it('marks and unmarks, and caps the read map at 5000 newest ids', async () => {
    const store = newStore();
    await store.load();

    store.markRead(['feed:a', 'feed:b'], true);
    assert.deepEqual(Object.keys(store.data.read).sort(), ['feed:a', 'feed:b']);
    store.markRead(['feed:a'], false);
    assert.deepEqual(Object.keys(store.data.read), ['feed:b']);

    // 5001 ids, each with a distinct timestamp, so the trim has a total order.
    for (let i = 0; i <= 5000; i += 1) {
      store.data.read[`k${i}`] = i + 1;
    }
    store.trimRead();
    const kept = Object.keys(store.data.read);
    assert.equal(kept.length, 5000);
    // Eviction is by *oldest timestamp*, and `feed:b` carries a real Date.now()
    // (~1.7e12) — i.e. it is the newest entry here, not the oldest. The ids with
    // values 1 and 2 are the ones that go.
    assert.ok(!kept.includes('k0'), 'the oldest id must be evicted');
    assert.ok(!kept.includes('k1'), 'the second oldest id must be evicted');
    assert.ok(kept.includes('k5000'), 'the newest id must survive');
    assert.ok(kept.includes('feed:b'), 'a real timestamp outranks every synthetic id');
  });
});

describe('article cache', () => {
  beforeEach(resetSandbox);

  it('caps the body cache but never evicts a favourite', async () => {
    const store = newStore();
    await store.load();

    store.data.articles = {};
    store.data.recent = [];
    store.data.favorites = {};
    for (let i = 0; i < MAX_ARTICLE_BODIES + 5; i += 1) {
      store.data.articles[`k${i}`] = { key: `k${i}`, html: '<p>x</p>', fetchedAt: i };
    }
    // k0 / k1 are the oldest five; only these two are pinned by a favourite.
    store.data.favorites.k0 = { savedAt: 0 };
    store.data.favorites.k1 = { savedAt: 0 };

    store.trimArticles();

    assert.ok(store.data.articles.k0, 'a pinned old article must survive the trim');
    assert.ok(store.data.articles.k1, 'a pinned old article must survive the trim');
    assert.equal(store.data.articles.k2, undefined, 'an unpinned old article must be evicted');
    assert.equal(store.data.articles.k4, undefined, 'an unpinned old article must be evicted');
    assert.ok(store.data.articles[`k${MAX_ARTICLE_BODIES + 4}`], 'the newest article must survive');
    assert.ok(Object.keys(store.data.articles).length <= MAX_ARTICLE_BODIES + 2);
  });

  it('leaves a cache below the cap completely alone', async () => {
    const store = newStore();
    await store.load();
    for (let i = 0; i < MAX_ARTICLE_BODIES; i += 1) {
      store.data.articles[`k${i}`] = { key: `k${i}`, html: '', fetchedAt: i };
    }
    store.trimArticles();
    assert.equal(Object.keys(store.data.articles).length, MAX_ARTICLE_BODIES);
  });

  it('keeps the recent list unique and moves a re-fetched article to the end', async () => {
    const store = newStore();
    await store.load();
    store.putArticle({ key: 'feed:a', html: 'a' });
    store.putArticle({ key: 'feed:b', html: 'b' });
    store.putArticle({ key: 'feed:a', html: 'a2' });

    assert.deepEqual(store.data.recent, ['feed:b', 'feed:a']);
    assert.equal(store.data.articles['feed:a'].html, 'a2');
    assert.equal(typeof store.data.articles['feed:a'].fetchedAt, 'number');
  });
});

describe('subscriptions', () => {
  beforeEach(resetSandbox);

  it('matches by url ignoring trailing slashes, and reports removal honestly', async () => {
    const store = newStore();
    await store.load();
    store.addSubscription({ id: 'feed:1', url: 'https://example.org/feed.xml', name: 'A', entries: [] });

    assert.equal(store.findSubscriptionByUrl('https://example.org/feed.xml/')?.id, 'feed:1');
    assert.equal(store.findSubscriptionByUrl('https://example.org/other.xml'), undefined);
    assert.equal(store.subscriptionById('feed:1')?.name, 'A');

    assert.equal(store.removeSubscription('feed:nope'), false);
    assert.equal(store.removeSubscription('feed:1'), true);
    assert.deepEqual(store.data.subscriptions, []);
  });

  it('finds a feed entry by article key across every subscription', async () => {
    const store = newStore();
    await store.load();
    store.addSubscription({ id: 'feed:1', url: 'https://a.example/f', name: 'A', entries: [{ key: 'feed:h1', title: 'One' }] });
    store.addSubscription({ id: 'feed:2', url: 'https://b.example/f', name: 'B', entries: [{ key: 'feed:h2', title: 'Two' }] });

    assert.equal(store.findFeedEntry('feed:h2')?.title, 'Two');
    assert.equal(store.findFeedEntry('feed:missing'), undefined);
  });
});

describe('catalog', () => {
  beforeEach(resetSandbox);

  it('加 / 删 / 按 id 查，删除要如实报告「有没有删到东西」', async () => {
    const store = newStore();
    await store.load();
    store.addCatalogSource({ id: 'cat:1', name: '嗯哌', url: 'https://npie.example/feed.xml', category: '我的源' });

    assert.equal(store.catalogSourceById('cat:1')?.name, '嗯哌');
    assert.equal(store.catalogSourceById('cat:nope'), undefined);
    assert.equal(store.removeCatalogSource('cat:nope'), false);
    assert.equal(store.removeCatalogSource('cat:1'), true);
    assert.deepEqual(store.listCatalog().sources, []);
  });

  it('隐藏按 url 去重；取消隐藏一个没隐藏过的 url 不算错', async () => {
    const store = newStore();
    await store.load();
    store.hideCatalogUrl('https://a.example/f');
    store.hideCatalogUrl('https://a.example/f');
    store.hideCatalogUrl('https://b.example/f');
    assert.deepEqual(store.listCatalog().hidden, ['https://a.example/f', 'https://b.example/f']);

    store.unhideCatalogUrl('https://a.example/f');
    store.unhideCatalogUrl('https://never.example/f');
    assert.deepEqual(store.listCatalog().hidden, ['https://b.example/f']);
  });

  it('setCatalogService 整体替换（不是 merge），传空串即清空', async () => {
    const store = newStore();
    await store.load();
    store.setCatalogService('http://localhost:4000');
    assert.equal(store.data.catalog.service.base, 'http://localhost:4000');
    store.setCatalogService('');
    assert.deepEqual(store.data.catalog.service, { base: '' });
    // 传非字符串当作清空，不能把 42 原样存进去。
    store.setCatalogService(42);
    assert.deepEqual(store.data.catalog.service, { base: '' });
  });

  it('反向对照：listCatalog 回的是活引用，改内存不该绕开 touch 的落盘', async () => {
    // listCatalog 直接回内部数组（不拷贝）—— 这是有意的：调用方只读。
    // 这里钉住的是「别把它当拷贝用」这件事一旦被改动就会被发现：
    // 断言返回的对象**就是**内部那份，改它等于改 store。
    const store = newStore();
    await store.load();
    const view = store.listCatalog();
    assert.equal(view.sources, store.data.catalog.sources);
    assert.equal(view.hidden, store.data.catalog.hidden);
  });
});

/**
 * ★ 这条函数存在的唯一理由。0.7.2 把网盘凭证改成「插件自己管、**不再回落**读旧位置」，
 *   理由正当（回落等于让别人装的插件读这台机器上的凭证），但**漏了老用户这一侧的搬运**。
 *   真机症状：升级后所有网盘书一次性打不开，而界面只报一句 `Failed to fetch` ——
 *   凭证文件其实就在这台机器上，用户完全看不出该做什么。
 *
 * 用例里的旧位置用 `legacy` 参数注入临时目录，**不碰用户真实的 `~`**。
 */
describe('migrateLegacyPanCredentials', () => {
  const CRED = join(sandbox, '旧位置');
  const legacy = { app: join(CRED, 'app.json'), token: join(CRED, 'token.json') };

  beforeEach(async () => {
    await resetSandbox();
    await rm(CRED, { recursive: true, force: true });
    await mkdir(CRED, { recursive: true });
  });

  it('★ 旧位置有、目标没有 ⇒ 搬过去（600 权限），且**源文件保留**', async () => {
    await writeFile(legacy.app, JSON.stringify({ appKey: 'k1', secretKey: 's1' }));
    await writeFile(legacy.token, JSON.stringify({ access_token: 't1', expires_at: Date.now() + 1e9 }));

    const moved = await migrateLegacyPanCredentials({ legacy });

    assert.deepEqual(moved, ['应用凭证', '授权 token']);
    assert.deepEqual(JSON.parse(await readFile(panAppPath(), 'utf8')), { appKey: 'k1', secretKey: 's1' });
    assert.equal(JSON.parse(await readFile(panTokenPath(), 'utf8')).access_token, 't1');
    assert.equal((await stat(panAppPath())).mode & 0o777, 0o600, '凭据文件必须是 600');
    assert.equal((await stat(panTokenPath())).mode & 0o777, 0o600);
    // ★ 反向对照：源文件**必须还在**。「搬」不是「挪」—— 用户可能还在用那个项目，
    //   删掉源文件等于顺手毁掉别人的数据。
    assert.equal(existsSync(legacy.app), true);
    assert.equal(existsSync(legacy.token), true);
  });

  it('★ 反向对照：目标已经有一份时**绝不覆盖**（那会盖掉用户刚授权的凭证）', async () => {
    // 目标目录要自己建：`beforeEach` 把整个 storages 清了，而这条用例是唯一一条
    // **主动往插件数据目录里写东西**的（其余几条都靠迁移函数自己建目录）。
    await mkdir(dirname(panAppPath()), { recursive: true });
    await writeFile(panAppPath(), JSON.stringify({ appKey: '插件里新授权的', secretKey: 'new' }));
    await writeFile(legacy.app, JSON.stringify({ appKey: '旧的', secretKey: 'old' }));
    await writeFile(legacy.token, JSON.stringify({ access_token: 't1' }));

    const moved = await migrateLegacyPanCredentials({ legacy });

    // 只搬了 token 那一份；app 因为目标已存在而跳过。
    assert.deepEqual(moved, ['授权 token']);
    assert.equal(JSON.parse(await readFile(panAppPath(), 'utf8')).appKey, '插件里新授权的');
  });

  it('两边都没有 ⇒ 什么都不做、不报错、也不凭空建出文件来', async () => {
    const moved = await migrateLegacyPanCredentials({ legacy });
    assert.deepEqual(moved, []);
    assert.equal(existsSync(panAppPath()), false);
    assert.equal(existsSync(panTokenPath()), false);
  });

  it('只有一半（配过应用但没授权过）时也只搬那一半', async () => {
    await writeFile(legacy.app, JSON.stringify({ appKey: 'k1', secretKey: 's1' }));
    const moved = await migrateLegacyPanCredentials({ legacy });
    assert.deepEqual(moved, ['应用凭证']);
    assert.equal(existsSync(panTokenPath()), false);
  });

  it('幂等：第二次调用什么都不搬', async () => {
    await writeFile(legacy.app, JSON.stringify({ appKey: 'k1', secretKey: 's1' }));
    assert.deepEqual(await migrateLegacyPanCredentials({ legacy }), ['应用凭证']);
    assert.deepEqual(await migrateLegacyPanCredentials({ legacy }), []);
  });

  it('默认旧位置就是 home 下的 `.baidu-pan-{app,token}.json`（钉住这个契约）', () => {
    assert.equal(dirname(legacyPanAppPath()), homedir());
    assert.equal(dirname(legacyPanTokenPath()), homedir());
    assert.equal(legacyPanAppPath().endsWith('.baidu-pan-app.json'), true);
    assert.equal(legacyPanTokenPath().endsWith('.baidu-pan-token.json'), true);
    // 反向对照：绝不许和插件自己那份同名同目录（那样 copyFile 会自撞自）。
    assert.notEqual(legacyPanAppPath(), panAppPath());
    assert.notEqual(legacyPanTokenPath(), panTokenPath());
  });
});
