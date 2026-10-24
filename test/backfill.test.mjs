/**
 * 补全历史：归档页 / sitemap / llms.txt 的解析，以及 `backfillSubscription`
 * 的落盘行为。
 *
 * 本文件盯住三个**会静默出错**的地方：
 *  1. 「`2.0` 被当成日期」—— 标题里带版本号的条目会丢掉真实发布日期；
 *  2. 「补了 506 条、刷新一次变回 200 条」—— `mergeEntries` 的默认上限；
 *  3. 「导航链接被当成文章灌进来」—— 归档页解析的假阳性。
 * 三条都不会报错，只会让用户看见一个错的列表。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createFakeContext, rssDocument } from './helpers/fake-ctx.mjs';
import { loadHostBundle } from './helpers/host-bundle.mjs';
import {
  discoverArchive, findDate, parseArchiveHtml, parseLlmsTxt, parseSitemap,
} from '../src/host/archive.js';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 沙箱放在 `test/.build/`（已 gitignore），**不用 `os.tmpdir()`**。
 *
 * ★ 本机的沙箱策略会拦 `/private/var/folders/...` 下的递归删除：`after()` 里那句
 *   `rm(sandbox, { recursive: true })` 一旦被拦，收尾钩子就永远不返回，`node --test`
 *   卡在这个文件上（实测：日志停在最后一个 suite 之后，进程被 SIGKILL，exit 137）。
 *   工作区内的目录不受这条限制，删得掉。
 */
await mkdir(join(pluginRoot, 'test', '.build'), { recursive: true });
const sandbox = await mkdtemp(join(pluginRoot, 'test', '.build', 'sandbox-backfill-'));
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
  // ★ 清理是**尽力而为**：本机的 safe-delete 策略会拦「一次删整棵树」（bulk delete guard），
  //   而 `rm(..., { maxRetries: 5 })` 撞上它会反复重试、把收尾钩子拖死
  //   （实测：`node --test` 卡在这个文件上，进程被 SIGKILL，exit 137）。
  //   所以：不重试 + 吞掉错误。删不掉也不影响断言，目录在 `test/.build/` 下且已 gitignore。
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

const SITE = 'https://site.test';

/** 造一份按年份分段、每条只写 `MM.DD` 的归档页（与 lex.qiaomu.ai 同形）。 */
function archiveHtml(count, { extra = '' } = {}) {
  const items = [];
  for (let index = 1; index <= count; index += 1) {
    const year = 2018 + Math.floor(index / 60);
    const month = String((index % 12) + 1).padStart(2, '0');
    const day = String((index % 28) + 1).padStart(2, '0');
    items.push({ year, html: `<li><a href="/ep/${index}/"><span class="ar-n">${index}</span><span class="ar-t"><b>标题 ${index}</b><i>Title ${index}</i></span><span class="ar-d">${month}.${day}<span class="ar-zh">精读</span></span></a></li>` });
  }
  const byYear = new Map();
  for (const item of items) {
    if (!byYear.has(item.year)) byYear.set(item.year, []);
    byYear.get(item.year).push(item.html);
  }
  const sections = [...byYear.entries()]
    .map(([year, list]) => `<section class="ar-year" id="y${year}"><h2>${year}</h2><ol>${list.join('')}</ol></section>`)
    .join('\n');
  return `<html><body><nav><a href="/">首页</a><a href="/about/">关于</a><a href="/tags/ai/">AI</a><a href="/feed.xml">RSS</a></nav>${sections}${extra}</body></html>`;
}

function llmsText(count) {
  const lines = ['# 站点', '', '## 文章'];
  for (let index = 1; index <= count; index += 1) {
    lines.push(`- [#${index} 标题 ${index}](${SITE}/ep/${index}/index.md)：第 ${index} 篇的摘要。`);
  }
  return lines.join('\n');
}

function sitemapXml(count) {
  const urls = [];
  for (let index = 1; index <= count; index += 1) {
    urls.push(`<url><loc>${SITE}/ep/${index}/</loc><lastmod>2025-03-${String((index % 28) + 1).padStart(2, '0')}</lastmod></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${urls.join('')}</urlset>`;
}

function boot(fetchFallback) {
  const home = join(sandbox, `home-${liveServices.size + Math.random().toString(16).slice(2)}`);
  process.env.DSH_HOME = home;
  const fake = createFakeContext({ fetchFallback });
  globalThis.fetch = fake.state.fetch;
  const service = new RssService(fake.ctx, {});
  liveServices.add(service);
  return { ...fake, service };
}

// ---------------------------------------------------------------------------
// 纯解析
// ---------------------------------------------------------------------------

describe('parseArchiveHtml', () => {
  it('把 506 条全部解析出来，且每条都有发布日期', () => {
    const entries = parseArchiveHtml(archiveHtml(506), `${SITE}/archive/`);
    assert.equal(entries.length, 506);
    assert.equal(entries.filter((entry) => entry.publishedAt).length, 506);
    assert.equal(entries[0].url, `${SITE}/ep/1/`);
    assert.equal(entries[505].url, `${SITE}/ep/506/`);
  });

  it('标题取 <b> 里的文字，不是「期号 + 中英标题 + 日期」整段', () => {
    const entries = parseArchiveHtml(archiveHtml(2), `${SITE}/archive/`);
    assert.equal(entries[0].title, '标题 1');
    assert.doesNotMatch(entries[0].title, /\d{2}\.\d{2}/);
  });

  it('导航链接、订阅文件、静态资源、外链一律不收', () => {
    const html = `${archiveHtml(6)}<a href="https://other.test/ep/9/">外站</a><a href="/poster.png">图</a>`;
    const entries = parseArchiveHtml(html, `${SITE}/archive/`);
    const urls = entries.map((entry) => entry.url);
    assert.equal(entries.length, 6);
    for (const bad of ['/about/', '/tags/ai/', '/feed.xml', '/poster.png']) {
      assert.equal(urls.some((url) => url.includes(bad)), false, `${bad} 不该被当成文章`);
    }
    assert.equal(urls.some((url) => url.startsWith('https://other.test')), false);
  });

  it('同一个地址在页面里出现两次只留一条', () => {
    const html = archiveHtml(6, { extra: `<li><a href="/ep/3/"><b>重复</b></a></li>` });
    assert.equal(parseArchiveHtml(html, `${SITE}/archive/`).length, 6);
  });

  it('非 http(s) 的页面地址直接返回空数组（不抛）', () => {
    assert.deepEqual(parseArchiveHtml(archiveHtml(6), 'not-a-url'), []);
  });
});

describe('findDate', () => {
  it('标题里的 `2.0` 不会吃掉后面真正的 `09.16`', () => {
    // 这是实测踩到的坑：只取第一个匹配会得到「月 2 日 0」⇒ 非法 ⇒ 整条日期丢失。
    assert.equal(findDate('维塔利克·布特林：以太坊 2.0 09.16 精读', 2021), '2021-09-16T00:00:00.000Z');
  });

  it('完整日期优先于 MM.DD', () => {
    assert.equal(findDate('2026-09-16 09.16', 2021), '2026-09-16T00:00:00.000Z');
  });

  it('没有年份线索时，只有 MM.DD 就不猜', () => {
    assert.equal(findDate('09.16 精读', undefined), undefined);
  });

  it('非法月份/日期不返回', () => {
    assert.equal(findDate('2026-13-40', undefined), undefined);
  });
});

describe('parseSitemap', () => {
  it('读 loc + lastmod，标题从 URL 末段来', () => {
    const entries = parseSitemap(sitemapXml(10), `${SITE}/sitemap.xml`);
    assert.equal(entries.length, 10);
    assert.equal(entries[0].url, `${SITE}/ep/1/`);
    assert.match(entries[0].publishedAt, /^2025-03-02T/);
  });

  it('sitemap 里的订阅文件与静态资源不算文章', () => {
    const xml = `<urlset>
      <url><loc>${SITE}/feed.xml</loc></url>
      <url><loc>${SITE}/logo.png</loc></url>
      <url><loc>${SITE}/ep/a/</loc></url>
    </urlset>`;
    assert.deepEqual(parseSitemap(xml, `${SITE}/sitemap.xml`).map((entry) => entry.url), [`${SITE}/ep/a/`]);
  });
});

describe('parseLlmsTxt', () => {
  it('去掉 index.md，保留摘要', () => {
    const entries = parseLlmsTxt(llmsText(3), `${SITE}/llms.txt`);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].url, `${SITE}/ep/1/`);
    assert.equal(entries[0].summary, '第 1 篇的摘要。');
    assert.equal(entries[0].publishedAt, undefined);
  });
});

describe('discoverArchive', () => {
  const fetchFrom = (map) => async (url) => {
    if (!(url in map)) throw new Error(`HTTP 404 for ${url}`);
    return map[url];
  };

  it('优先用归档页，并用 llms.txt 补摘要', async () => {
    const result = await discoverArchive(`${SITE}/feed.xml`, {
      fetchText: fetchFrom({
        [`${SITE}/archive/`]: archiveHtml(20),
        [`${SITE}/llms.txt`]: llmsText(20),
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'archive');
    assert.equal(result.entries.length, 20);
    assert.equal(result.entries.filter((entry) => entry.summary).length, 20);
  });

  it('归档页 404 时退到 sitemap', async () => {
    const result = await discoverArchive(`${SITE}/feed.xml`, {
      fetchText: fetchFrom({ [`${SITE}/sitemap.xml`]: sitemapXml(12) }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'sitemap');
    assert.equal(result.entries.length, 12);
  });

  it('只有 llms.txt 时也能用（没有日期）', async () => {
    const result = await discoverArchive(`${SITE}/feed.xml`, {
      fetchText: fetchFrom({ [`${SITE}/llms.txt`]: llmsText(9) }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'llms');
    assert.equal(result.entries.length, 9);
  });

  it('只解析出 3 条（不足闸门）时不认，返回失败而不是灌进书架', async () => {
    const result = await discoverArchive(`${SITE}/feed.xml`, {
      fetchText: fetchFrom({ [`${SITE}/archive/`]: archiveHtml(3) }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.entries.length, 0);
    assert.match(result.reason, /归档页|sitemap|llms/);
    assert.equal(result.tried.length, 7, '四个归档路径 + 两个 sitemap 路径 + llms.txt 都要试过');
  });

  it('站点全 404 时给出原因和尝试过的地址', async () => {
    const result = await discoverArchive(`${SITE}/feed.xml`, { fetchText: fetchFrom({}) });
    assert.equal(result.ok, false);
    assert.equal(result.entries.length, 0);
    assert.equal(result.tried.every((item) => item.error), true);
  });
});

// ---------------------------------------------------------------------------
// 服务层：预览 → 落盘 → 刷新不被截断
// ---------------------------------------------------------------------------

describe('RssService.backfillSubscription', () => {
  const FEED_ITEMS = 20;

  const feedItems = () => Array.from({ length: FEED_ITEMS }, (_, offset) => {
    const index = 506 - offset;
    return {
      title: `Feed ${index}`,
      link: `${SITE}/ep/${index}/`,
      guid: `${SITE}/ep/${index}/`,
      pubDate: 'Wed, 24 Sep 2025 08:00:00 GMT',
    };
  });

  const routes = () => ({
    [`${SITE}/feed.xml`]: { body: rssDocument({ title: '站点', items: feedItems() }), contentType: 'application/rss+xml' },
    [`${SITE}/archive/`]: { body: archiveHtml(506), contentType: 'text/html' },
    [`${SITE}/llms.txt`]: { body: llmsText(506), contentType: 'text/plain' },
  });

  const bootWithSite = () => {
    const table = routes();
    return boot((url) => table[url] ?? { status: 404, body: 'not found' });
  };

  it('预览不写盘：只报数，条目数不变', async () => {
    const { service } = bootWithSite();
    await service.ready;
    const sub = await service.addSubscription({ url: `${SITE}/feed.xml` });
    assert.equal(sub.entryCount, FEED_ITEMS);

    const preview = await service.backfillSubscription({ id: sub.id });
    assert.equal(preview.applied, false);
    assert.equal(preview.found, 506);
    assert.equal(preview.added, 506 - FEED_ITEMS);
    assert.equal(preview.sample.length, 5);
    assert.equal(service.store.subscriptionById(sub.id).entries.length, FEED_ITEMS);
    // 预览阶段**不能**打「查过了」的标记：否则用户取消一次，入口就再也不会出现了。
    assert.equal(service.store.subscriptionById(sub.id).backfillCheckedAt, undefined);
  });

  it('落盘后是 506 条，而且**刷新之后仍然是 506 条**', async () => {
    const { service } = bootWithSite();
    await service.ready;
    const sub = await service.addSubscription({ url: `${SITE}/feed.xml` });

    const applied = await service.backfillSubscription({ id: sub.id, apply: true });
    assert.equal(applied.added, 506 - FEED_ITEMS);
    assert.equal(applied.total, 506);

    // ★ 这条是核心回归：`refreshSubscription` 若按默认 200 条裁，
    //   补进来的 306 条历史会在**下一次刷新**时静默消失。
    const target = service.store.subscriptionById(sub.id);
    await service.refreshSubscription(target);
    assert.equal(target.entries.length, 506, '刷新不能把补全的历史裁回 200 条');
  });

  it('已有的条目原样保留（正文、标题都不被归档页覆盖）', async () => {
    const { service } = bootWithSite();
    await service.ready;
    const sub = await service.addSubscription({ url: `${SITE}/feed.xml` });
    await service.backfillSubscription({ id: sub.id, apply: true });

    const kept = service.store.subscriptionById(sub.id).entries.find((entry) => entry.url === `${SITE}/ep/506/`);
    assert.equal(kept.title, 'Feed 506');
    assert.equal(kept.backfilled, undefined);
    assert.ok(kept.html.length > 0, 'feed 自带的正文不能被清空');
  });

  it('补进来的条目没有正文，但带摘要（打开时才去原文页抓）', async () => {
    const { service } = bootWithSite();
    await service.ready;
    const sub = await service.addSubscription({ url: `${SITE}/feed.xml` });
    await service.backfillSubscription({ id: sub.id, apply: true });

    const older = service.store.subscriptionById(sub.id).entries.find((entry) => entry.url === `${SITE}/ep/1/`);
    assert.equal(older.backfilled, true);
    assert.equal(older.html, '');
    assert.equal(older.bodyDropped, true);
    assert.equal(older.summary, '第 1 篇的摘要。');
    assert.equal(older.publishedAt.startsWith('2018-'), true);
  });

  it('再点一次「补全」不会重复添加，并记下「查过了」让入口收起', async () => {
    const { service } = bootWithSite();
    await service.ready;
    const sub = await service.addSubscription({ url: `${SITE}/feed.xml` });
    const applied = await service.backfillSubscription({ id: sub.id, apply: true });
    assert.equal(typeof applied.added, 'number');

    const again = await service.backfillSubscription({ id: sub.id, apply: true });
    assert.equal(again.added, 0);
    assert.equal(again.total, 506);

    // 列表接口要把这两个时间戳暴露给界面：界面据此决定「补全历史」这个入口还显不显示。
    const listed = (await service.listSubscriptions()).subscriptions.find((item) => item.id === sub.id);
    assert.equal(typeof listed.backfilledAt, 'number');
    assert.equal(typeof listed.backfillCheckedAt, 'number');
  });

  it('没有归档页的源返回 ok:false 与原因，而不是空成功', async () => {
    const { service } = boot((url) => (url === `${SITE}/feed.xml`
      ? { body: rssDocument({ items: [{ title: 'A' }] }), contentType: 'application/rss+xml' }
      : { status: 404, body: '' }));
    await service.ready;
    const sub = await service.addSubscription({ url: `${SITE}/feed.xml` });
    const result = await service.backfillSubscription({ id: sub.id });
    assert.equal(result.ok, false);
    assert.match(result.reason, /归档页|sitemap|llms/);
    assert.equal(service.store.subscriptionById(sub.id).entries.length, 1);
    // 站点对每个候选都明确回了 404 ⇒ 这是**查清了**，界面上的入口该收起。
    assert.equal(result.definitive, true);
    assert.equal(typeof service.store.subscriptionById(sub.id).backfillCheckedAt, 'number');
  });

  it('网络故障（超时/断网）不算查清，入口必须留着', async () => {
    const { service } = boot((url) => (url === `${SITE}/feed.xml`
      ? { body: rssDocument({ items: [{ title: 'A' }] }), contentType: 'application/rss+xml' }
      : { throw: new Error('The operation was aborted due to timeout') }));
    await service.ready;
    const sub = await service.addSubscription({ url: `${SITE}/feed.xml` });
    const result = await service.backfillSubscription({ id: sub.id });
    assert.equal(result.ok, false);
    assert.equal(result.definitive, false);
    assert.equal(service.store.subscriptionById(sub.id).backfillCheckedAt, undefined, '网络抖一次不该让功能永远消失');
  });

  it('未知订阅 id 直接报错', async () => {
    const { service } = bootWithSite();
    await service.ready;
    await assert.rejects(() => service.backfillSubscription({ id: 'feed:nope' }), /找不到这个订阅源/);
  });

  it('没补全过的源仍然按 200 条上限裁剪（默认行为不变）', async () => {
    const items = Array.from({ length: 260 }, (_, index) => ({
      title: `P${index}`,
      link: `${SITE}/p/${index}/`,
      guid: `${SITE}/p/${index}/`,
    }));
    const { service } = boot((url) => (url === `${SITE}/big.xml`
      ? { body: rssDocument({ items }), contentType: 'application/rss+xml' }
      : { status: 404, body: '' }));
    await service.ready;
    const sub = await service.addSubscription({ url: `${SITE}/big.xml` });
    assert.equal(sub.entryCount, 200, '未补全的源必须维持原有的 200 条上限');
  });
});
