/**
 * 探索页「信息源目录」的合成规则。
 *
 * 用户的原话是「信息源这部分是可以自定义的，不是写死的」+「如果我要把我的公众号『嗯哌』
 * 添加进去该如何操作」。这两句要求的是同一件事：内置目录降级成**只读默认值**，
 * 用户加的排在最前、分类名自由，而内置目录还能跟着插件升级更新。
 *
 * 这里钉的就是这条边界的几个不变量：
 *   ① 同一个 url 绝不出两行（否则一行能删一行不能，用户没法理解）；
 *   ② 隐藏是「按 url 记」的，隐藏一条内置项不碰用户自己加的同址条目；
 *   ③ 分类集合是**算出来的**，不是写死的。
 *
 * ★ 2026-10-08 起内置目录只剩 Newsletter / 独立博客 两类 ——
 *   「精选作者 / 微信公众号 / 播客」整类撤掉（数据来源没法对用户交代清楚），
 *   撤掉的清单与恢复办法见仓库根的 `retired/README.md`。本文件里那几条断言
 *   相应地变成了**反向对照**：那三个分类名现在必须落到「你自己添加的」兜底分支上。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_CATEGORIES,
  DEFAULT_CUSTOM_CATEGORY,
  catalogCategories,
  countCustom,
  mergeCatalog,
  provenanceOf,
} from '../src/client/catalog-merge.js';
// 「裁剪之后不该还剩停更一年以上的源」那条断言要用**和脚本同一条线**，
// 不能在这里再写一个 365 —— 两套数字迟早会漂移。
import { PRUNE_CATALOG_DAYS } from '../src/client/catalog-health.js';
import { daysSince } from '../src/client/source-health.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const discover = readFileSync(join(root, 'src', 'client', 'Discover.jsx'), 'utf8');
const hostService = readFileSync(join(root, 'src', 'host', 'service.js'), 'utf8');

const builtin = [
  { name: 'MIT Technology Review (AI)', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', category: 'Newsletter' },
  { name: '阮一峰的网络日志', url: 'https://www.ruanyifeng.com/blog/atom.xml', category: '独立博客' },
  { name: '酷 壳 – CoolShell', url: 'https://coolshell.cn/feed', category: '独立博客' },
];

describe('mergeCatalog', () => {
  test('自定义条目排在最前，且带上 custom 标记', () => {
    const merged = mergeCatalog({
      builtin,
      sources: [{ id: 'cat:1', name: '嗯哌', url: 'https://npie.example/feed.xml', category: '我的源' }],
      hidden: [],
    });
    assert.equal(merged[0].name, '嗯哌');
    assert.equal(merged[0].custom, true);
    // 内置条目**不能**被误标成 custom —— 界面上 custom 决定「移除」还是「隐藏」，
    // 标错了用户就会以为自己能删掉一条插件自带、其实下次升级又回来的条目。
    assert.ok(merged.slice(1).every((entry) => entry.custom === undefined));
  });

  test('集合基数：结果 = 自定义条数 + 未被隐藏且不重复的内置条数', () => {
    const merged = mergeCatalog({ builtin, sources: [{ url: 'https://a.example/f' }], hidden: [] });
    assert.equal(merged.length, 1 + builtin.length);
    assert.equal(merged.filter((entry) => entry.custom).length, 1);
  });

  test('反向对照：同址的内置条目被剔除，绝不出现两行同一个地址', () => {
    const merged = mergeCatalog({
      builtin,
      sources: [{ id: 'cat:r', name: '阮一峰（我自己加的）', url: 'https://www.ruanyifeng.com/blog/atom.xml' }],
      hidden: [],
    });
    const hits = merged.filter((entry) => entry.url === 'https://www.ruanyifeng.com/blog/atom.xml');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].custom, true);
    assert.equal(merged.length, builtin.length);
  });

  test('反向对照：被隐藏的内置条目消失，其余内置条目原样保留', () => {
    const merged = mergeCatalog({ builtin, sources: [], hidden: ['https://coolshell.cn/feed'] });
    assert.equal(merged.length, builtin.length - 1);
    assert.ok(!merged.some((entry) => entry.name === '酷 壳 – CoolShell'));
    assert.ok(merged.some((entry) => entry.name === '阮一峰的网络日志'));
  });

  test('隐藏是「按 url 记」的，不会误伤用户自己加的同址条目', () => {
    // 隐藏只作用于内置目录：用户自己加的那条必须是他的，能删。
    const url = 'https://www.ruanyifeng.com/blog/atom.xml';
    const merged = mergeCatalog({ builtin, sources: [{ id: 'cat:r', url }], hidden: [url] });
    assert.equal(merged[0].url, url);
    assert.equal(merged[0].custom, true);
    // 同址的内置条目被剔（去重与隐藏命中的是**同一条**），另外两条没被隐藏的内置项留着。
    assert.equal(merged.length, 1 + (builtin.length - 1));
    assert.equal(merged.filter((entry) => entry.url === url).length, 1);
  });

  test('脏数据不炸：缺 url 的条目被丢掉，空入参返回空数组', () => {
    const merged = mergeCatalog({ builtin: [null, {}, { name: 'x' }, ...builtin], sources: [null, {}], hidden: undefined });
    assert.equal(merged.length, builtin.length);
    assert.deepEqual(mergeCatalog(), []);
    assert.deepEqual(mergeCatalog({}), []);
  });
});

describe('catalogCategories', () => {
  test('全部在最前，内置各类保持固定顺序', () => {
    const categories = catalogCategories(builtin);
    assert.equal(categories[0], '全部');
    // ★ 上限必须是 `1 + BUILTIN_CATEGORIES.length`，不能写死数字：
    //   写死的话，加一个内置分类就会静默地只检查前几个，后面的排到哪都没人管。
    assert.deepEqual(categories.slice(1, 1 + BUILTIN_CATEGORIES.length), BUILTIN_CATEGORIES);
  });

  test('用户自建的分类会长出来（这是「不是写死的」的那一半）', () => {
    const categories = catalogCategories([...builtin, { url: 'https://x.example/f', category: '行业观察' }]);
    assert.ok(categories.includes('行业观察'));
    assert.equal(categories.at(-1), '行业观察');
  });

  test('反向对照：内置类一条都没有时，按钮仍保留全部内置类', () => {
    // 顺序靠常量定，不靠数据里有没有出现 —— 否则用户隐藏掉所有独立博客，那个按钮会跟着消失，
    // 他再想按这个分类找源都没有现成的分类名可点。
    assert.deepEqual(catalogCategories([]), ['全部', ...BUILTIN_CATEGORIES]);
  });

  test('空白分类被忽略，重复分类不重复出现', () => {
    const categories = catalogCategories([{ category: '  ' }, { category: '' }, { category: '行业观察' }, { category: '行业观察' }]);
    assert.deepEqual(categories, ['全部', ...BUILTIN_CATEGORIES, '行业观察']);
  });
});

describe('provenanceOf', () => {
  test('剩下的两类各有一句来源说明，且都说清了「谁在中间」', () => {
    // 用户的抱怨原话：只说了独立博客来自 Tim Qian 目录，另外几类一个字都没说。
    // 所以这里不只断言「非空」，而是断言**关键来源**确实被点名了。
    assert.match(provenanceOf('独立博客'), /timqian\/chinese-independent-blogs/);
    assert.match(provenanceOf('Newsletter'), /逐条实测/);
    assert.match(provenanceOf('Newsletter'), /没有收录/);
  });

  test('反向对照：撤掉的三个分类不许再有自己的文案，必须落到兜底分支', () => {
    // 这三个分类 2026-10-08 整类撤掉。若哪天有人把 PROVENANCE 条目加回来却忘了加数据，
    // 界面上就会出现一个「点开是空的、文案却言之凿凿」的分类 —— 这条断言挡的就是它。
    for (const retired of ['精选作者', '微信公众号', '播客']) {
      assert.equal(provenanceOf(retired), '你自己添加的信息源。', `${retired} 已经撤掉了，不该还有专属来源说明`);
      assert.ok(!BUILTIN_CATEGORIES.includes(retired), `${retired} 不该还在 BUILTIN_CATEGORIES 里`);
    }
  });

  test('独立博客带上锁定的 revision 前 8 位（可追溯到具体版本）', () => {
    const revision = '4fbded82114fc10f16770d53f287e3af951678cd';
    const text = provenanceOf('独立博客', { revision });
    assert.match(text, /revision 4fbded82/);
    assert.doesNotMatch(text, new RegExp(revision));
  });

  test('独立博客裁剪过就必须说出来 —— revision 不等于「源目录全量」', () => {
    // 只说 revision，用户会以为拿到的是源目录完整清单；目录从 1342 掉到 404 却一个字不解释，
    // 看起来就像「插件莫名删了我的源」。
    const text = provenanceOf('独立博客', { revision: '4fbded82114fc10f16770d53f287e3af951678cd', pruned: { from: 1342, to: 404, rule: '探不通或 ≥ 90 天未更新' } });
    assert.match(text, /938 条经实测剔除/);
    assert.match(text, /现留 404 条/);
  });

  test('反向对照：没裁剪过（没有 pruned）时不许凭空冒出删除说明', () => {
    const text = provenanceOf('独立博客', { revision: '4fbded82114fc10f16770d53f287e3af951678cd' });
    assert.doesNotMatch(text, /剔除|现留/);
  });

  test('反向对照：pruned 只有一半字段时也不炸、不输出半句话', () => {
    assert.doesNotMatch(provenanceOf('独立博客', { pruned: { from: 100 } }), /剔除|现留/);
    assert.doesNotMatch(provenanceOf('独立博客', { pruned: {} }), /剔除|现留/);
  });

  test('裁剪说明只挂在独立博客上，不污染 Newsletter', () => {
    const pruned = { from: 1342, to: 404, rule: 'x' };
    assert.doesNotMatch(provenanceOf('Newsletter', { pruned }), /剔除|现留/);
  });

  test('反向对照：用户自建的分类返回「你自己添加的」，不套用任何内置文案', () => {
    const text = provenanceOf('行业观察');
    assert.equal(text, '你自己添加的信息源。');
    assert.doesNotMatch(text, /timqian|RSSHub|第三方代理/);
  });
});

describe('countCustom', () => {
  test('只数 custom === true 的，自定义标记为假值也不算', () => {
    assert.equal(countCustom([{ custom: true }, { custom: false }, {}, { custom: 'yes' }]), 1);
    assert.equal(countCustom([]), 0);
  });
});

describe('Discover 接线（防止模块写好了界面没用上）', () => {
  test('目录经 mergeCatalog 合成，用的是用户自己那份 sources/hidden', () => {
    assert.match(discover, /mergeCatalog\(\{ builtin: builtinCatalog, sources: own\.sources, hidden: own\.hidden \}\)/);
  });

  test('分类按钮来自 catalogCategories，不是写死的数组', () => {
    assert.match(discover, /catalogCategories\(merged\)/);
    // 反向对照：写死的样子长这样。出现就等于「自定义分类」这条需求被回退了。
    assert.doesNotMatch(discover, /\[\s*'全部'\s*,\s*'/);
  });

  test('内置目录只剩两类，且不再 import 已撤下的数据文件', () => {
    assert.match(discover, /const builtinCatalog = \[/);
    assert.match(discover, /newsletterCatalog\.items/);
    assert.match(discover, /blogCatalog\.items\.map/);
    // 反向对照：撤下的那份数据文件已经不在 src/data 下了，谁再 import 谁就炸。
    assert.doesNotMatch(discover, /podcast-feeds\.json/);
  });

  test('「添加信息源」入口已撤：按钮与内联表单都不许再出现', () => {
    assert.doesNotMatch(discover, /npr-discover-addsource/);
    assert.doesNotMatch(discover, /npr-discover-addform/);
    assert.doesNotMatch(discover, /npr-discover-catpick/);
    assert.doesNotMatch(discover, /api\.addCatalogSource\(/);
    // 反向对照：撤掉之后**必须**还留着「粘贴目录外地址」这条路，否则用户没有任何
    // 办法订阅自己的源了 —— 那是把「删一个按钮」做成了「删一个能力」。
    assert.match(discover, /category: '临时地址', custom: true, temporary: true/);
  });

  test('目录读写走 Remote，且读失败不会连累订阅列表', () => {
    assert.match(discover, /api\.listCatalog\(\)/);
    assert.match(discover, /api\.removeCatalogSource\(/);
    assert.match(discover, /api\.setCatalogHidden\(/);
  });

  test('反向对照：粘贴目录外地址造的那条「临时地址」必须带 temporary', () => {
    // 不带的话它会渲染出「移除」按钮，点下去是 removeCatalogSource(undefined) —— 一个点了就报错的假入口。
    assert.match(discover, /category: '临时地址', custom: true, temporary: true/);
    assert.match(discover, /\{!entry\.temporary && \(/);
  });

  test('裁剪记录被真的传给了 provenanceOf', () => {
    assert.match(discover, /provenanceOf\(category, \{ revision: blogCatalog\.revision, pruned: blogCatalog\.pruned \}\)/);
  });

  test('「转 RSS 服务」配置搬到了设置页，能力没丢', () => {
    // 它原来藏在被撤掉的「添加信息源」表单里。撤表单时如果一并删掉，
    // service-probe.js / setCatalogService / probeCatalogService 就全成了死代码。
    const settings = readFileSync(join(root, 'src', 'client', 'SettingsPage.jsx'), 'utf8');
    assert.match(settings, /api\.setCatalogService\(/);
    assert.match(settings, /api\.probeCatalogService\(/);
    assert.match(settings, /npr-service-row/);
    assert.doesNotMatch(discover, /probeCatalogService/);
  });
});

describe('默认分类是跨半区的契约', () => {
  test('宿主 addCatalogSource 的默认分类与客户端常量一致', () => {
    // ★ 这个默认值在**两个半区各写了一份**（客户端常量 + 宿主字面量）。
    //   两边漂开的话，「加进来落在哪个分类」会跟着调用方不同而不同，
    //   而且不会有任何报错 —— 只会看到同一个源在两个地方分到两个组。
    assert.ok(
      hostService.includes(`|| '${DEFAULT_CUSTOM_CATEGORY}'`),
      `宿主 service.js 的默认分类必须逐字等于 "${DEFAULT_CUSTOM_CATEGORY}"`,
    );
  });
});

describe('目录数据文件的自我一致性', () => {
  const blogs = JSON.parse(readFileSync(join(root, 'src', 'data', 'independent-blogs.json'), 'utf8'));
  const health = JSON.parse(readFileSync(join(root, 'src', 'data', 'catalog-health.json'), 'utf8'));
  const newsletters = JSON.parse(readFileSync(join(root, 'src', 'data', 'newsletter-feeds.json'), 'utf8'));

  test('Newsletter 目录：条目数与地址形态正确、地址不重复', () => {
    // 9 = 2026-10-08 从公众号清单实测的 9 条 − 2026-10-09 停更超一年被裁掉的 2 条
    //     （AI Valley / Grace Leung）+ 同日用户补的 TLDR AI / Daily Dose of DS。
    // （同日 The Neuron 因「正文永远抓不到」被摘除，见下一条。）
    // 数量写死是**故意**的：每条都得逐条真实请求测过才允许进目录，
    // 跟着文件自动变的话，「随手加一条从没测过的地址」就没人拦。
    assert.equal(newsletters.items.length, 9, '内置 Newsletter 源是 9 个（每条都逐条实测过）');
    const urls = newsletters.items.map((entry) => entry.url);
    assert.equal(new Set(urls).size, urls.length, '同一个地址两行会让「隐藏」看起来失灵');
    for (const entry of newsletters.items) {
      assert.match(entry.url, /^https:\/\//, `${entry.name} 的地址必须是 https`);
      assert.ok(entry.name && entry.frequency, `${entry.name} 缺名字或频率`);
    }
  });

  test('「地址和官网长得不一样」的那几条被钉死（防止被顺手改成官网路径）', () => {
    // 这几条**照官网猜必错**：官网路径要么 404、要么 403，而真 feed 在别处。
    // 把它们写死在这里，是因为「清理无用地址」这类改动看着很安全 ——
    // 把 `tldr.tech/api/rss/ai` 改成更顺眼的 `tldr.tech/ai/rss`，测试全绿、界面上多一个 404 源。
    // 每一条的实测结论见 README「Newsletter 内置目录」。
    const byName = new Map(newsletters.items.map((entry) => [entry.name, entry.url]));
    assert.equal(byName.get('The Batch @ DeepLearning.AI'), 'https://charonhub.deeplearning.ai/feed');
    assert.equal(byName.get('MIT Technology Review（AI 主题）'), 'https://www.technologyreview.com/topic/artificial-intelligence/feed');
    assert.equal(byName.get('Towards AI（TAI）'), 'https://newsletter.towardsai.net/feed');
    assert.equal(byName.get('TLDR AI'), 'https://tldr.tech/api/rss/ai', '官网 /ai/rss 是 404，真源在 API 路径');
    assert.equal(
      byName.get('Daily Dose of DS'),
      'https://blog.dailydoseofds.com/feed',
      '订阅页在 *.substack.com 子域（本机取不到），能取到的是自定义域',
    );
  });

  test('反向对照：没收录的源必须有可解释的原因，且不能同时出现在可订阅列表里', () => {
    // 「没收录」有四种互不相同的原因，混成一句「抓不到」会把「被墙」说成「这家不出 RSS」，
    // 或者把「feed 好端端、只是正文抓不到」说成同一个意思。
    const allowed = new Set(['network', 'partial', 'blocked', 'no-feed']);
    const live = new Set(newsletters.items.map((entry) => entry.url));
    assert.ok(newsletters.unavailable.length > 0);
    for (const entry of newsletters.unavailable) {
      assert.ok(allowed.has(entry.reason), `${entry.name} 的 reason「${entry.reason}」不在允许集合里`);
      assert.ok(entry.detail, `${entry.name} 缺 detail`);
      assert.ok(!live.has(entry.url), `${entry.name} 同时出现在 items 与 unavailable 里`);
    }
  });

  test('The Neuron 摘除后不许再从 items 溜回来（它只能待在 unavailable 里）', () => {
    // 摘除是 2026-10-09 用户看过实测结论后拍板的，不是「抓不到就删掉」：
    // feed 是好的，坏的是文章页（Cloudflare 托管挑战）⇒ 点开永远是空正文 / 仅摘要。
    const inItems = newsletters.items.some((entry) => entry.name === 'The Neuron');
    assert.equal(inItems, false, 'The Neuron 不该在 items 里 —— 它的正文永远抓不到');
    const parked = newsletters.unavailable.find((entry) => entry.name === 'The Neuron');
    assert.ok(parked, '摘除不等于删记录，得留在 unavailable 里说明为什么');
    assert.equal(parked.reason, 'partial', '它是「feed 好、正文抓不到」，不是「被墙」也不是「没开 feed」');
  });

  test('停更超一年被裁掉的两条不许悄悄溜回来，且必须留在 retired/ 里', () => {
    // 2026-10-09：Newsletter 接上体检后按 365 天删除线裁掉 AI Valley（670 天）与
    // Grace Leung（727 天）。两条的 feed 都是好的 —— 被删的原因是**停更**，不是抓不到，
    // 所以它们该在 `retired/` 而不是 `unavailable`（后者记的是「当初没收录」）。
    const archived = JSON.parse(readFileSync(join(root, 'retired', 'newsletter-feeds-retired.json'), 'utf8'));
    const archivedUrls = new Set((archived.removed ?? []).map((entry) => entry.url));
    for (const url of ['https://aivalley.ai/feed/', 'https://www.graceleung.com/feed']) {
      assert.ok(archivedUrls.has(url), `${url} 被删了却没归档 —— Newsletter 没有 upstream，删掉就是永久丢失`);
      assert.ok(!newsletters.items.some((entry) => entry.url === url), `${url} 不该还在 items 里`);
      assert.ok(!newsletters.unavailable.some((entry) => entry.url === url), `${url} 是被裁掉的，不是「没收录」`);
    }
    // 归档必须带**名字和理由**：快照按 url 对齐、刻意不存 name，名字只能来自裁它的那一刻。
    for (const entry of archived.removed) {
      assert.ok(entry.name, `${entry.url} 的归档缺 name`);
      assert.match(entry.reason, /天/, `${entry.url} 的归档没说清楚为什么删`);
    }
  });

  test('Newsletter 也进了体检快照：每条都有新鲜度，不许停在「没体检过」', () => {
    const index = new Map(health.items.map((item) => [item.url, item]));
    for (const entry of newsletters.items) {
      const item = index.get(entry.url);
      assert.ok(item, `${entry.name} 不在体检快照里 —— 界面上会永远没有「最新一篇 N 天前」`);
      assert.equal(item.category, 'Newsletter', `${entry.name} 在快照里的类别不对，界面上会按另一类统计`);
    }
  });

  test('裁剪之后不该还剩「停更一年以上」的 Newsletter 源', () => {
    // 这条是给「删除线」本身上的锁：删完之后还剩下超过 365 天的，说明裁剪没跑或者线写错了。
    const at = Date.parse(newsletters.pruned.at);
    assert.ok(Number.isFinite(at), 'newsletters.pruned.at 不是一个时间');
    for (const item of health.items.filter((row) => row.category === 'Newsletter')) {
      if (!item.newestAt) continue;
      const days = daysSince(item.newestAt, at);
      assert.ok(days < PRUNE_CATALOG_DAYS, `${item.url} 已 ${days} 天未更新，早该被裁掉`);
    }
  });

  test('pruned.to 与真实条目数一致（否则界面上那句「现留 N 条」就是假话）', () => {
    assert.equal(blogs.pruned.to, blogs.items.length);
    assert.ok(blogs.pruned.from > blogs.pruned.to);
    // Newsletter 现在也走裁剪（删除线 365 天），同一个不变量要一起钉住。
    assert.equal(newsletters.pruned.to, newsletters.items.length);
    assert.ok(newsletters.pruned.from > newsletters.pruned.to);
  });

  test('体检快照与目录同口径：每条快照都还在目录里，顶层计数等于条目数', () => {
    // 快照覆盖**两类**内置目录（2026-10-09 起 Newsletter 也进来了）。
    const live = new Set([...blogs.items, ...newsletters.items].map((entry) => entry.url));
    assert.ok(health.items.every((item) => live.has(item.url)), '快照里不该留下已删源的记录');
    assert.equal(health.items.length, health.checked);
    assert.equal(health.items.length, health.total);
    // 撤掉的类别不许在快照里留下孤儿记录（2026-10-08 撤掉播客时清过一遍）。
    assert.ok(!health.items.some((item) => item.category === '播客'), '播客已经整类撤掉，快照里不该还有它的条目');
  });

  test('撤下的数据被保留在 retired/，没有直接丢掉', () => {
    // 这个项目**没有版本控制**（不在任何 git 仓库里），直接删掉就找不回来了。
    // 所以撤下的清单与数据文件必须落在 retired/ 下，并且带一份说明。
    assert.ok(existsSync(join(root, 'retired', 'README.md')), 'retired/README.md 不见了 —— 撤下的清单就没人知道去哪找');
    assert.ok(existsSync(join(root, 'retired', 'podcast-feeds.json')), 'retired/podcast-feeds.json 不见了');
    assert.ok(existsSync(join(root, 'retired', 'newsletter-feeds-retired.json')), 'retired/newsletter-feeds-retired.json 不见了 —— 裁掉的 Newsletter 源就没处找了');
    assert.ok(!existsSync(join(root, 'src', 'data', 'podcast-feeds.json')), '撤下的数据文件不该还留在 src/data 下');
  });
});
