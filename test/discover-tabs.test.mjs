/**
 * 探索订阅筛选条上的「订阅分组」选项卡（0.15.0）。
 *
 * ★ 为什么要有这个文件
 * --------------------
 * 这条需求的核心不是"把组名画出来"，而是**「放不下怎么办」**：
 * 放不下时要用「···」代替，且点了能选到被藏起来的分组。
 * 这件事只有两个判据，且两个都容易写错而**不报错**：
 *
 *   ① 切分点算错 ⇒ 标签被「···」吞掉但 `···` 又没留位置 → 那一行右侧被裁掉一截，
 *      最后一个标签永远点不到（看着像样式问题，其实是算术问题）；
 *   ② 切分点算对了但没给「···」自己留宽度 ⇒ 它被挤出可视区，
 *      用户完全不知道还有分组没显示。
 *
 * 这两条读源码读不出来 —— `groupTabCutoff` 是纯函数，直接拿数字钉住最省事。
 *
 * ★ 反向对照：把"给 ··· 让位"那段循环删掉，最后两条断言必须变红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DISCOVER = join(pluginRoot, 'src/client/Discover.jsx');
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

/** 反向对照用：替换没命中就抛错，不许静默继续。 */
function mutateDiscover(from, to) {
  return {
    name: 'mutate-discover',
    setup(build) {
      build.onLoad({ filter: /Discover\.jsx$/ }, (args) => {
        const before = readFileSync(args.path, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'jsx' };
      });
    },
  };
}

async function load({ plugins = [] } = {}) {
  const result = await esbuild.build({
    stdin: {
      contents: `export { DiscoverRow, groupTabCutoff, mergeCategoryRows, sameName, feedUrlKey, topicOptions } from ${JSON.stringify(DISCOVER)};`,
      loader: 'js',
      resolveDir: pluginRoot,
    },
    plugins,
    bundle: true,
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server', '@deepseek-ai/*'],
    platform: 'browser',
    format: 'cjs',
    target: 'chrome120',
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: { __NPIE_READER_VERSION__: JSON.stringify(PLUGIN_VERSION) },
    sourcemap: false,
    logLevel: 'silent',
    legalComments: 'none',
    write: false,
  });
  const code = result.outputFiles[0].text;
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', code)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}

describe('groupTabCutoff：放得下几个分组标签', () => {
  it('全部放得下时返回全部（不出现「···」）', async () => {
    const { groupTabCutoff } = await load();
    assert.equal(groupTabCutoff([70, 90, 60], 400), 3);
  });

  it('一个都放不下时返回 0（只剩「···」，仍有入口）', async () => {
    const { groupTabCutoff } = await load();
    assert.equal(groupTabCutoff([70, 90], 10), 0);
  });

  it('被切掉时必须给「···」自己留位置：贪心塞满之后还要往回让', async () => {
    const { groupTabCutoff } = await load();
    // 3 × (70+6) = 228 恰好塞得下 ⇒ 不需要「···」
    assert.equal(groupTabCutoff([70, 70, 70], 228), 3, '刚好全部放下');
    // 3 个 100px 标签 + 可用 220：贪心能塞下 2 个（212），但剩下的 8px 不够「···」，
    // 必须退回 1 个（106 + 52 = 158 ≤ 220），否则「···」被挤出可视区。
    assert.equal(groupTabCutoff([100, 100, 100], 220), 1);
  });

  it('剩余宽度不够「···」时继续回退，不会把 ··· 挤出可视区', async () => {
    const { groupTabCutoff } = await load();
    // 4 个 100px，可用 300：贪心 2 个，留「···」后仍是 2 个（212 + 52 = 264 ≤ 300）
    assert.equal(groupTabCutoff([100, 100, 100, 100], 300, { moreWidth: 46, gap: 6 }), 2);
  });

  it('空数组 / 非法宽度直接返回 0，不抛异常', async () => {
    const { groupTabCutoff } = await load();
    assert.equal(groupTabCutoff([], 300), 0);
    assert.equal(groupTabCutoff([70], Number.NaN), 0);
    assert.equal(groupTabCutoff([70], -5), 0);
    assert.equal(groupTabCutoff(undefined, 300), 0);
  });

  it('反向对照：去掉「给 ··· 让位」那段，上面的边界断言必须变红', async () => {
    const { groupTabCutoff } = await load({
      plugins: [mutateDiscover(
        '  while (fit > 0 && used + moreWidth + gap > available) {',
        '  while (false) {',
      )],
    });
    // 变异后不再为「···」腾位置 ⇒ 220 宽会"塞下"2 个，真实界面里 ··· 被挤出屏幕
    assert.equal(groupTabCutoff([100, 100, 100], 220), 2);
  });
});

describe('sameName：同名分组与分类是「同一个东西」', () => {
  it('忽略大小写与首尾空格', async () => {
    const { sameName } = await load();
    assert.equal(sameName('Newsletter', 'Newsletter'), true);
    assert.equal(sameName('newsletter', 'Newsletter'), true);
    assert.equal(sameName(' Newsletter ', 'Newsletter'), true);
  });

  it('不同名、空名字都不算同名（空字符串不能和空分类匹配上）', async () => {
    const { sameName } = await load();
    assert.equal(sameName('AI 动态', 'Newsletter'), false);
    assert.equal(sameName('', ''), false);
    assert.equal(sameName(undefined, 'Newsletter'), false);
  });
});

describe('feedUrlKey：同一个源不能被结尾斜杠拆成两条', () => {
  it('去掉结尾斜杠并忽略大小写', async () => {
    const { feedUrlKey } = await load();
    assert.equal(feedUrlKey('https://aivalley.ai/feed/'), feedUrlKey('https://aivalley.ai/feed'));
    assert.equal(feedUrlKey('https://AIVALLEY.ai/feed'), feedUrlKey('https://aivalley.ai/feed/'));
    assert.notEqual(feedUrlKey('https://a.com/a'), feedUrlKey('https://a.com/b'));
    assert.equal(feedUrlKey(undefined), '');
  });
});

describe('mergeCategoryRows：同名分组并进分类选项卡，我的分组排在最前面', () => {
  // 取自 2026-10-20 的真实形状：目录 9 条里 3 条已订阅（存下来多了结尾斜杠），
  // 另有 1 条 `AI Valley` 只在分组里、不在目录里，还有 1 条目录里尚未订阅的。
  const CATALOG = [
    { name: 'The Rundown AI', url: 'https://www.therundown.ai/feed', category: 'Newsletter' },
    { name: 'The Keyword', url: 'https://blog.google/rss', category: 'Newsletter' },
    { name: 'The Batch', url: 'https://charonhub.deeplearning.ai/feed', category: 'Newsletter' },
    { name: 'Latent Space', url: 'https://www.latent.space/feed', category: 'Newsletter' },
  ];
  const SUBS = [
    { id: 's1', name: 'The Rundown AI', url: 'https://www.therundown.ai/feed/', group: 'Newsletter' },
    { id: 's2', name: 'The Keyword', url: 'https://blog.google/rss/', group: 'Newsletter' },
    { id: 's3', name: 'The Batch', url: 'https://charonhub.deeplearning.ai/feed/', group: 'Newsletter' },
    { id: 's4', name: 'AI Valley', url: 'https://aivalley.ai/feed/', group: 'Newsletter' },
    { id: 's5', name: 'AIHOT 日报', url: 'https://aihot.news/feed/daily.xml', group: 'AI 动态' },
  ];
  const GROUP_NAMES = ['Newsletter', 'AI 动态'];
  const call = (mergeCategoryRows, overrides = {}) => mergeCategoryRows({
    category: 'Newsletter', matched: CATALOG, subscribed: SUBS, groupNames: GROUP_NAMES, ...overrides,
  });

  it('我的分组整段排在前面，目录里没订阅的接在后面，且不出现重复行', async () => {
    const { mergeCategoryRows } = await load();
    const rows = call(mergeCategoryRows);
    // 前 4 条 = 我分组里的 4 个源（含目录里没有的 AI Valley），顺序就是分组里的顺序。
    // ★ 这一条是 2026-10-20 返工的核心：早先按目录顺序排，用户看到的是一屏「目录条目」，
    //   结论是「你把我的 Newsletter 分组直接删了」——东西没少，排序把它们变成了另一个东西。
    assert.deepEqual(rows.map((row) => row.name), ['The Rundown AI', 'The Keyword', 'The Batch', 'AI Valley', 'Latent Space']);
    // 结尾斜杠不同也要认出是同一批源 —— 否则 3 个已订阅的目录源会重复出现
    assert.equal(rows.length, 5);
  });

  it('来自分组的行带 subscription，所以显示「阅读 / 已订阅」而不是「订阅」', async () => {
    const { mergeCategoryRows } = await load();
    const rows = call(mergeCategoryRows);
    assert.equal(rows[3].subscription.id, 's4');
    assert.equal(rows[3].custom, true);
    assert.equal(rows[3].temporary, true);
    // 目录里尚未订阅的那条保持原样（仍然可以点「订阅」）
    assert.equal(rows[4].subscription, undefined);
  });

  it('「全部」、没有同名分组的分类、空分组名 —— 原样返回目录行', async () => {
    const { mergeCategoryRows } = await load();
    assert.deepEqual(call(mergeCategoryRows, { category: '全部' }), CATALOG);
    assert.deepEqual(call(mergeCategoryRows, { category: '独立博客' }), CATALOG);
    assert.deepEqual(call(mergeCategoryRows, { groupNames: [] }), CATALOG);
  });

  it('大小写不同的分组名照样并进来（用户手打的组名不可控）', async () => {
    const { mergeCategoryRows } = await load();
    // 只把小写的 Newsletter 换掉，`AI 动态` 那条留着 —— 它不该被并进 Newsletter
    const subs = SUBS.map((sub) => (sub.group === 'Newsletter' ? { ...sub, group: 'newsletter' } : sub));
    assert.deepEqual(call(mergeCategoryRows, { subscribed: subs }).map((row) => row.name),
      ['The Rundown AI', 'The Keyword', 'The Batch', 'AI Valley', 'Latent Space']);
  });

  it('搜索词仍然作用于我的分组（目录行由调用方先筛过）', async () => {
    const { mergeCategoryRows } = await load();
    const valleyOnly = CATALOG.filter((row) => /valley/i.test(row.name));
    assert.deepEqual(
      call(mergeCategoryRows, { needle: 'valley', matched: valleyOnly }).map((row) => row.name),
      ['AI Valley'],
    );
    assert.deepEqual(call(mergeCategoryRows, { needle: '不存在的词', matched: [] }), []);
  });

  it('反向对照：去掉按 url 排除目录重复行，已订阅的目录源会变成两行', async () => {
    const { mergeCategoryRows } = await load({
      plugins: [mutateDiscover('  return [...mine, ...rows.filter((row) => !mineKeys.has(feedUrlKey(row.url)))];', '  return [...mine, ...rows];')],
    });
    const rows = call(mergeCategoryRows);
    assert.equal(rows.length, 8, '不排除 ⇒ 我的 4 条 + 目录 4 条，其中 3 条重复');
    assert.deepEqual(rows.map((row) => row.name).slice(0, 4), ['The Rundown AI', 'The Keyword', 'The Batch', 'AI Valley']);
  });
});

describe('topicOptions：「全部主题」下拉不能是标签全集', () => {
  // 真实情况：404 个博客 386 个不同标签，289 个只有 1 个源在用，
  // 直接 sort() 之后开头是 .NET / .net / ACG / C4droid 这种冷门词。
  const blog = (tags, category = '独立博客') => ({ name: `blog-${tags.join('-')}`, url: `https://e.test/${tags.join('')}`, category, tags });
  const ENTRIES = [
    blog(['编程', '技术']),
    blog(['编程', '技术']),
    blog(['编程']),
    blog(['.NET']),
    blog(['.net']),
    blog(['Galgame']),
    blog(['技术', 'ACG']),
    { name: 'The Rundown AI', url: 'https://www.therundown.ai/feed', category: 'Newsletter' },
  ];

  it('只留至少 3 个源在用的标签，长尾单源标签不再出现', async () => {
    const { topicOptions } = await load();
    const tags = topicOptions(ENTRIES, '全部');
    assert.deepEqual(tags, ['编程', '技术']);
    assert.ok(!tags.includes('Galgame'), '只有 1 个源在用的标签必须被滤掉');
    assert.ok(!tags.includes('.NET') && !tags.includes('.net'), '2 个源（归一后）也不够 3 个');
  });

  it('按使用次数降序，而不是按字符码排序', async () => {
    const { topicOptions } = await load();
    // 编程 3 个源、技术 3 个源 → 同频按中文排序，但都比任何单源标签靠前
    const one = [blog(['编程']), blog(['编程']), blog(['编程']), blog(['技术']), blog(['技术']), blog(['技术']), blog(['ACG'])];
    assert.deepEqual(topicOptions(one, '全部'), ['编程', '技术']);
  });

  it('大小写不同的标签算同一个（.NET 与 .net 不占两行）', async () => {
    const { topicOptions } = await load();
    const many = [blog(['.NET']), blog(['.net']), blog(['.Net'])];
    const tags = topicOptions(many, '全部');
    assert.equal(tags.length, 1, '三种写法应合成一项');
    assert.equal(tags[0].toLocaleLowerCase(), '.net');
  });

  it('跟着当前分类走：Newsletter 分类不会列出博客的技术标签', async () => {
    const { topicOptions } = await load();
    assert.deepEqual(topicOptions(ENTRIES, 'Newsletter'), [], '这 9 条 Newsletter 本身没有 tags');
    assert.deepEqual(topicOptions(ENTRIES, '全部').length, 2);
  });

  it('入参非法不抛异常', async () => {
    const { topicOptions } = await load();
    assert.deepEqual(topicOptions(undefined), []);
    assert.deepEqual(topicOptions([{ tags: null }, {}]), []);
    assert.deepEqual(topicOptions([blog(['   '])]), []);
  });

  it('反向对照：去掉「≥3 个源」的阈值，单源标签会全部冒出来', async () => {
    const { topicOptions } = await load({
      plugins: [mutateDiscover('    .filter((item) => item.count >= minSources)', '    .filter(() => true)')],
    });
    const tags = topicOptions(ENTRIES, '全部');
    assert.ok(tags.includes('Galgame'), '阈值没了 ⇒ 只有一个源的标签也会出现');
    assert.equal(tags.length, 5, '编程 / 技术 / .net / ACG / Galgame 全在');
  });
});

describe('DiscoverRow：分组已经挪到筛选条，行内不再挂标签', () => {
  const entry = { name: 'The Rundown AI', url: 'https://www.therundown.ai/feed', category: 'Newsletter', note: '每日' };
  const state = { level: 'fresh', label: '最新一篇 3 天前' };
  const render = (DiscoverRow, overrides = {}) => renderToStaticMarkup(React.createElement(DiscoverRow, {
    entry, subscription: undefined, state, busy: '', onAdd: () => {}, onDrop: () => {}, onRead: () => {}, ...overrides,
  }));

  it('已订阅的行仍然是「阅读 + 已订阅」，且没有行内分组标签', async () => {
    const { DiscoverRow } = await load();
    const html = render(DiscoverRow, { subscription: { id: 's1', url: entry.url, group: 'Newsletter' } });
    assert.match(html, /已订阅/);
    assert.doesNotMatch(html, /npr-discover-group-chip/, '旧的行内标签必须已经删掉，不能两种形态并存');
  });

  it('未订阅的行仍然是「订阅」按钮', async () => {
    const { DiscoverRow } = await load();
    assert.match(render(DiscoverRow), /npr-discover-add/);
  });
});
