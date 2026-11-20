/**
 * Agent 工具的运行期行为。
 *
 * ★ 这个文件存在的理由：在此之前，8 个工具的 `execute()` **没有任何测试跑过它** ——
 *   测试只断言「注册了这些名字」。而名字对、代码跑不到，是完全可能的：
 *   一个没定义的常量、一个写错的方法名、一段模板拼装，在 `tsc`/打包/名字断言下
 *   全是绿的，只有真跑一次才现形。
 *
 * 所以这里每条用例都真的 `execute()` + `render()`，断言的是**模型最终看到的文本**。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { rssDocument } from './helpers/fake-ctx.mjs';
import { bootService, disposeHarness, runTool } from './helpers/tool-harness.mjs';

after(disposeHarness);

const DAY = 86_400_000;
const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toUTCString();

describe('工具契约', () => {
  it('每个注册的工具都有可执行的 execute 与可渲染的 output', async () => {
    const { tools } = await bootService({});
    // ★ 写死总数是有意的：它和 `service.test.mjs` 里的 `TOOL_NAMES` 一起当**契约快照**。
    //   0.20.0 加了五个 `book_*` 而这两处都没跟着改 ⇒ 全量测试红了两条，
    //   但当时只跑了子集、没人看见。工具数量变化必须是一次显式改动。
    //   0.27.0 加了 `book_annotations`（读用户自己的划线）：14 → 15。
    //   2026-10-26 加了日记三件套（`diary_today` / `diary_append` / `diary_search`）：15 → 18。
    //   2026-10-27 补了 `diary_update` / `diary_delete`（能改能删是用户明确要的）：
    //   18 → 20。
    //   2026-11-06 C 档加了五个 `paper_*`（列库 / 全文找词 / 导入 / 读摘要 / 找相关）：
    //   20 → 25。与 `service.test.mjs` 的 `TOOL_NAMES` 快照**同一次**改，别只改一处。
    assert.equal(tools.size, 25);
    for (const [name, tool] of tools) {
      assert.equal(typeof tool.execute, 'function', `${name} 缺 execute`);
      assert.equal(typeof tool.output?.render, 'function', `${name} 缺 output.render`);
      assert.equal(typeof tool.description, 'string', `${name} 缺 description`);
    }
  });

  it('参数表里声明的每个字段都有 description（模型靠它决定怎么填）', async () => {
    const { tools } = await bootService({});
    for (const [name, tool] of tools) {
      const schema = tool.parameters ?? {};
      const properties = schema.properties ?? schema;
      for (const [field, definition] of Object.entries(properties)) {
        if (field === 'type' || field === 'required') continue;
        assert.equal(typeof definition?.description, 'string', `${name}.${field} 缺 description`);
      }
    }
  });
});

describe('rss_list_articles', () => {
  it('时间窗与「无发布时间被排除」都出现在输出里', async () => {
    const { service, tools } = await bootService({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [
            { title: 'fresh item', pubDate: hoursAgo(5) },
            { title: 'stale item', pubDate: new Date(Date.now() - 40 * DAY).toUTCString() },
            { title: 'undated item', pubDate: '' },
          ],
        }),
      }],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const out = await runTool(tools, 'rss_list_articles', { since: '3d' });
    assert.match(out, /时间窗 ≥ \d{4}-\d{2}-\d{2}/);
    // ★ 只说「命中 1 条」而不说「另有 1 条没有发布时间被排除」，模型会把缺失
    //   读成「就这么多」，于是给出建立在缺失数据上的结论。
    assert.match(out, /另有 1 条没有发布时间，已排除/);
    assert.match(out, /fresh item/);
    assert.doesNotMatch(out, /stale item/);
    assert.doesNotMatch(out, /undated item/);
  });

  it('不设窗口时不出现窗口说明（免得每行输出都挂着空括号）', async () => {
    const { service, tools } = await bootService({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'Only one' }] }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const out = await runTool(tools, 'rss_list_articles', {});
    assert.match(out, /Only one/);
    assert.doesNotMatch(out, /时间窗/);
    assert.doesNotMatch(out, /没有发布时间/);
  });

  it('limit 超过上限时封顶而不是抛错', async () => {
    const items = Array.from({ length: 150 }, (_, index) => ({ title: `T${index}` }));
    const { service, tools } = await bootService({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const out = await runTool(tools, 'rss_list_articles', { limit: 999 });
    assert.equal(out.split('\n').length - 1, 150, '150 条都该拿到（上限是 200）');
  });
});

describe('rss_search_articles', () => {
  const deepBody = `<p>${'filler '.repeat(40)}DeepSeek-V3 的架构评估</p>`;

  it('命中正文时给出「← 正文：」与命中片段，并报扫描量', async () => {
    const { service, tools } = await bootService({
      fetchPlan: [{
        body: rssDocument({
          title: 'Feed A',
          items: [{ title: 'Weekly roundup', description: '<p>完全无关</p>' }, { title: 'Model release', description: deepBody }],
        }),
      }],
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const out = await runTool(tools, 'rss_search_articles', { query: 'DeepSeek-V3' });
    assert.match(out, /← 正文：/);
    assert.match(out, /DeepSeek-V3/);
    assert.match(out, /扫描 \d+ 条，读了 \d+ 篇正文/);
  });

  it('channels 接受逗号分隔的字符串（模型常这么传），且真的限定范围', async () => {
    const { service, tools } = await bootService({
      fetchPlan: [
        { body: rssDocument({ title: 'Feed A', items: [{ title: 'Alpha about deepseek' }] }) },
        { body: rssDocument({ title: 'Feed B', items: [{ title: 'Beta about deepseek' }] }) },
      ],
    });
    await service.ready;
    const a = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });

    const scoped = await runTool(tools, 'rss_search_articles', { query: 'deepseek', channels: a.id });
    assert.match(scoped, /Alpha/);
    assert.doesNotMatch(scoped, /Beta/);

    const both = await runTool(tools, 'rss_search_articles', { query: 'deepseek' });
    assert.match(both, /Alpha/);
    assert.match(both, /Beta/);
  });

  it('反向对照：数组形态的 channels 同样要认（只认字符串会静默搜全库）', async () => {
    const { service, tools } = await bootService({
      fetchPlan: [
        { body: rssDocument({ title: 'Feed A', items: [{ title: 'Alpha about deepseek' }] }) },
        { body: rssDocument({ title: 'Feed B', items: [{ title: 'Beta about deepseek' }] }) },
      ],
    });
    await service.ready;
    const a = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });

    const out = await runTool(tools, 'rss_search_articles', { query: 'deepseek', channels: [a.id] });
    assert.match(out, /Alpha/);
    assert.doesNotMatch(out, /Beta/);
  });

  it('一条都没命中时给出可行动的下一步，并保留时间窗说明', async () => {
    const { service, tools } = await bootService({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'Something' }] }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const out = await runTool(tools, 'rss_search_articles', { query: '完全不存在的词', since: '3d' });
    assert.match(out, /Nothing matches/);
    assert.match(out, /时间窗/);
  });
});

describe('rss_digest', () => {
  it('分组标题带频道名与 key、每组条数与未读，超出部分要说明还有多少', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ title: `T${index}`, pubDate: hoursAgo(index + 1) }));
    const { service, tools } = await bootService({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const out = await runTool(tools, 'rss_digest', { perChannel: 5 });
    assert.match(out, /Digest over 1 channel\(s\), 12 entries/);
    assert.match(out, /## 全部订阅 \(all\) — 12 条 \/ 未读 12/);
    assert.match(out, /还有 7 条/);
    assert.match(out, /rss_read_article/);
  });

  it('多个频道按传入顺序分组；认不出的 key 就是 0 条而不是「全部」', async () => {
    const { service, tools } = await bootService({
      fetchPlan: [
        { body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }) },
        { body: rssDocument({ title: 'Feed B', items: [{ title: 'B1' }] }) },
      ],
    });
    await service.ready;
    const a = await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });

    const out = await runTool(tools, 'rss_digest', { channels: `${a.id}, feed:nope` });
    assert.match(out, /## Feed A \(feed:[0-9a-f]+\) — 1 条/);
    // 认不出的 key：名字回显成 key 本身，但**条数必须是 0** —— 这是这条用例的重点。
    assert.match(out, /## feed:nope \(feed:nope\) — 0 条 \/ 未读 0/);
    // 反向对照：A 的内容在，B 的不在 —— 说明「限定两份源」真的生效了。
    assert.match(out, /A1/);
    assert.doesNotMatch(out, /B1/);
  });

  it('窗口内一条都没有时给出可行动提示，而不是一片空白', async () => {
    const { service, tools } = await bootService({ fetchPlan: [{ body: rssDocument({ title: 'Feed A', items: [{ title: 'A1' }] }) }] });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const out = await runTool(tools, 'rss_digest', { until: '2020-01-01' });
    assert.match(out, /No entries in this window/);
    assert.match(out, /时间窗/);
  });

  it('★ 守卫：传 30 个频道时必须报出被丢弃的 10 个', async () => {
    // 一次最多处理 20 个频道。以前这里算出了 `truncatedChannels: true`，但
    // `windowNote()` 只读 `result.truncated` —— 于是输出里只有
    // "Digest over 20 channel(s)"，模型完全看不出还有 10 个频道根本没看。
    // 反向对照：把 `droppedChannels` 改回布尔 `truncatedChannels`，本用例必红。
    const { service, tools } = await bootService({});
    await service.ready;
    service.store.data.subscriptions = Array.from({ length: 30 }, (_, index) => ({
      id: `feed:ch${index}`,
      url: `https://c${index}.example/feed.xml`,
      name: `源${index}`,
      addedAt: 1,
      entries: [{ key: `k${index}`, title: `T${index}`, channelName: `源${index}`, publishedAt: hoursAgo(1) }],
    }));
    const keys = service.store.data.subscriptions.map((sub) => sub.id);

    const out = await runTool(tools, 'rss_digest', { channels: keys.join(',') });
    assert.match(out, /Digest over 20 channel\(s\)/, '实际处理的频道数');
    assert.match(out, /另有 10 个频道本次没有处理/, '被丢掉的 10 个必须说出来');

    // 反向对照：没到上限时不许出现这句话 —— 否则就是把「一个都没丢」也说成丢了。
    const two = await runTool(tools, 'rss_digest', { channels: keys.slice(0, 2).join(',') });
    assert.doesNotMatch(two, /没有处理/);
  });
});

describe('rss_refresh', () => {
  it('★ 守卫：全部源抓失败时，输出里必须出现**失败计数**', async () => {
    // 修之前：`refreshSubscription` 失败时 `return 0`，调用方 `outcome.feeds += 1`，
    // 于是三个源全连不上时输出是 `Feeds refreshed: 2, new/updated entries: 0` ——
    // 模型读成「刷过了，这几天没新东西」。而真相是一个源都没连上。
    // 反向对照：把 `outcome.failed` 改回 `feeds += 1`，本用例必红。
    const { service, tools } = await bootService({
      fetchFallback: () => ({ throw: new Error('ECONNREFUSED 127.0.0.1:443') }),
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });
    await service.addSubscription({ url: 'https://b.example/feed.xml' });

    const out = await runTool(tools, 'rss_refresh', {});
    assert.match(out, /0 ok \/ 2 failed/, '成功数/失败数必须同屏');
    assert.match(out, /Failures: /, '失败原因也要带上');
    assert.match(out, /ECONNREFUSED/);
  });

  it('反向对照：源都通但确实没有新条目时，failed 必须是 0', async () => {
    // 与上一条配对：只测「全挂」会漏掉「failed 恒等于 feeds」这种把成功也说成失败的写法。
    const { service, tools } = await bootService({
      fetchFallback: () => ({ body: rssDocument({ title: 'Feed A', items: [] }) }),
    });
    await service.ready;
    await service.addSubscription({ url: 'https://a.example/feed.xml' });

    const out = await runTool(tools, 'rss_refresh', {});
    assert.match(out, /1 ok \/ 0 failed/);
    assert.doesNotMatch(out, /Failures: /);
  });

  it('一个源都没有时给出可行动的下一步', async () => {
    const { service, tools } = await bootService({});
    await service.ready;
    const out = await runTool(tools, 'rss_refresh', {});
    assert.match(out, /0 ok \/ 0 failed/);
    assert.match(out, /rss_add_subscription/);
  });
});

describe('触顶原因必须分类说清楚', () => {
  /**
   * ★ 这一组测的是 `windowNote()` 的渲染契约，所以**替掉 service 的那一步**：
   *   `truncatedScan` / `truncatedBodies` / `droppedChannels` 三个标记由 service 算出，
   *   而「输出里说不说」是 tools.js 的责任。P1-2 的缺陷正好在后者 ——
   *   标记算对了，`windowNote` 却只读一个 `truncated` 布尔。
   */
  it('★ 守卫：扫描到顶与正文预算到顶要给出**不同**的补救建议', async () => {
    const { service, tools } = await bootService({});
    await service.ready;
    service.searchArticlesDetailed = async () => ({
      results: [], scanned: 5_000, bodiesRead: 800, undatedExcluded: 0,
      window: '不限', truncatedScan: true, truncatedBodies: true,
    });

    const out = await runTool(tools, 'rss_search_articles', { query: 'x' });
    assert.match(out, /已达条目扫描上限/);
    assert.match(out, /已达正文预算上限/);

    // 反向对照：两个标记都关掉时，这两句都不该出现。
    service.searchArticlesDetailed = async () => ({
      results: [], scanned: 5, bodiesRead: 1, undatedExcluded: 0,
      window: '不限', truncatedScan: false, truncatedBodies: false,
    });
    const clean = await runTool(tools, 'rss_search_articles', { query: 'x' });
    assert.doesNotMatch(clean, /上限/);
  });

  it('★ 守卫：两个标记**分开**读（只读一个时另一类会静默消失）', async () => {
    const { service, tools } = await bootService({});
    await service.ready;

    service.searchArticlesDetailed = async () => ({
      results: [], scanned: 5_000, bodiesRead: 1, undatedExcluded: 0,
      window: '不限', truncatedScan: true, truncatedBodies: false,
    });
    const scanOnly = await runTool(tools, 'rss_search_articles', { query: 'x' });
    assert.match(scanOnly, /已达条目扫描上限/);
    assert.doesNotMatch(scanOnly, /正文预算上限/);

    service.searchArticlesDetailed = async () => ({
      results: [], scanned: 5, bodiesRead: 800, undatedExcluded: 0,
      window: '不限', truncatedScan: false, truncatedBodies: true,
    });
    const bodiesOnly = await runTool(tools, 'rss_search_articles', { query: 'x' });
    assert.match(bodiesOnly, /已达正文预算上限/);
    assert.doesNotMatch(bodiesOnly, /条目扫描上限/);
  });
});
