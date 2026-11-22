/**
 * 阅读周报的**真渲染**（`react-dom/server`），不是读源码猜。
 *
 * 盯四件事，每一件都是「坏了也不会报错」的类型：
 *
 *  1. **左栏那 8 个周里，当前周只有一个 `is-current`**。判据写成「至少有一个」的话，
 *     「每个都标成当前」也能过 —— 而那种界面看起来像一列全是深色的按钮，
 *     用户不知道自己现在在看哪一周。
 *  2. **每张卡片都要落到名字上**。只有「读了 12 篇」没有标题，这一页就退化成
 *     一个数字板。所以断言里必须出现文章标题、书名、日期。
 *  3. **两条 `data-window-drag` 必须在**（左栏工具栏 + 正文头部）。少了它，
 *     在周报页按住空白处拖不动窗口 —— 这个仓库里已经发生过两次同款事故
 *     （0.9.8 / 0.28.3），所以列为结构判据。
 *  4. **「不含私密日记」必须写在页脚**。周报是一张会被截图的东西，
 *     「你这周写了几天私密日记」本身就是信息；不说清边界，用户会以为它全算了。
 *
 * ★ 反向对照改的是**真源码**（esbuild `onLoad` 替换，锚点没命中就抛错）：
 *   同一套断言再跑一遍必须变红，否则这个装置只是在给死代码发合格证。
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(pluginRoot, 'src/client/WeeklyReport.jsx');

/** 反向对照：在 esbuild 读 `WeeklyReport.jsx` 时换掉一段源码。替换没生效就抛错。 */
function mutateView(label, from, to) {
  return {
    name: `mutate-weekly-${label}`,
    setup(build) {
      build.onLoad({ filter: /WeeklyReport\.jsx$/ }, () => {
        const before = readFileSync(VIEW, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'jsx' };
      });
    },
  };
}

const cache = new Map();
function loadView({ key = 'plain', plugins = [] } = {}) {
  if (!cache.has(key)) {
    const outFile = join(pluginRoot, 'test', '.build', `weekly-view-${key}-${process.pid}.cjs`);
    mkdirSync(dirname(outFile), { recursive: true });
    cache.set(key, (async () => {
      await esbuild.build({
        stdin: {
          contents: [
            `import React from 'react';`,
            `import { renderToStaticMarkup } from 'react-dom/server';`,
            `import { WeeklyView } from ${JSON.stringify(VIEW)};`,
            `export { React, renderToStaticMarkup, WeeklyView };`,
          ].join('\n'),
          resolveDir: pluginRoot,
          loader: 'js',
          sourcefile: 'weekly-view-entry.mjs',
        },
        plugins,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        jsx: 'automatic',
        outfile: outFile,
        logLevel: 'warning',
      });
      return import(`${pathToFileURL(outFile).href}?v=${Date.now()}`);
    })());
  }
  return cache.get(key);
}

const noop = () => {};

/** 一份「什么都有一点」的周报，用来钉住卡片里的名字。 */
function fixtureReport(overrides = {}) {
  return {
    range: {
      key: '2026-W47', fromKey: '2026-11-16', toKey: '2026-11-22',
      days: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'],
      label: '11 月 16 日 – 11 月 22 日', shortLabel: '11/16 – 11/22',
    },
    reading: {
      articles: 12,
      saved: 3,
      topFeeds: [{ name: '示例源', count: 7 }, { name: '另一个源', count: 5 }],
      titles: [
        { key: 'https://a.example/1', at: 1, title: '第一篇标题', feed: '示例源', feedId: 'feed:a' },
        { key: 'https://a.example/2', at: 2, title: '第二篇标题', feed: '示例源', feedId: 'feed:a' },
      ],
      savedTitles: [],
    },
    books: {
      finished: [{ id: 'b1', title: '读完的那本书', at: 3 }],
      progressed: [{ id: 'b2', title: '在推进的书', at: 4, page: 30, pages: 100 }],
      highlightCount: 5,
      highlights: [{ id: 'b1', title: '读完的那本书', count: 5 }],
    },
    papers: { added: [], finished: [], read: [] },
    writing: {
      entries: 9,
      chars: 1234,
      days: 5,
      dayKeys: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'],
      streak: 5,
      byKind: { 灵感: 7, 读后感: 2 },
      moods: [{ score: 4, count: 6, label: '还不错' }],
      reflections: [{ bookId: 'b1', title: '读完的那本书', date: '2026-11-19', preview: '这本书讲的是信任' }],
    },
    empty: false,
    scanned: { annotationsReadable: true },
    ...overrides,
  };
}

function fixtureData(overrides = {}) {
  return {
    week: '2026-W47',
    report: fixtureReport(),
    recent: [
      { key: '2026-W47', label: '11/16 – 11/22', range: '', headline: '读了 12 篇 · 写完 1 本', empty: false },
      { key: '2026-W46', label: '11/9 – 11/15', range: '', headline: '这一周没有记录', empty: true },
      { key: '2026-W45', label: '11/2 – 11/8', range: '', headline: '读了 3 篇', empty: false },
    ],
    ...overrides,
  };
}

async function render(props = {}) {
  const mod = await loadView();
  return mod.renderToStaticMarkup(mod.React.createElement(mod.WeeklyView, {
    data: fixtureData(), error: '', loading: false,
    onRefresh: noop, onPick: noop, onExit: noop, onExitTo: noop,
    onOpenArticle: noop, onOpenBook: noop,
    ...props,
  }));
}

/**
 * 数「class 里真的含这个类名」的元素个数。
 *
 * ★ 必须按**空格分词后整词相等**来比，不能写成 `\b${name}\b`：`-` 是非单词字符，
 *   `npr-weekly-item` 会在 `npr-weekly-item-label` 里命中一次 `\b` 边界 ——
 *   于是 3 个周项被数成 9 个。第一版就是这么红的。
 */
function countClass(html, name) {
  const tokens = /class="([^"]*)"/g;
  let count = 0;
  let match;
  while ((match = tokens.exec(html)) !== null) {
    if (match[1].split(/\s+/).includes(name)) count += 1;
  }
  return count;
}

describe('0.88.0：周报画面', () => {
  it('★ 左栏列出每一周，当前周只有一个 is-current', async () => {
    const html = await render();
    assert.equal(countClass(html, 'npr-weekly-item'), 3, '周列表项数不对');
    assert.equal(countClass(html, 'is-current'), 1, '「当前周」的标记不该出现不止一次');
    assert.ok(html.includes('11/16 – 11/22'), '周标签没画出来');
    assert.ok(html.includes('这一周没有记录'), '侧栏摘要没画出来');
  });

  it('★ 两张拖动区都在（少一个就拖不动窗口）', async () => {
    const html = await render();
    assert.equal(html.split('data-window-drag').length - 1, 2, '左栏工具栏与正文头部各要一条');
  });

  it('每张卡片都落到具体名字上', async () => {
    const html = await render();
    for (const needle of ['第一篇标题', '第二篇标题', '示例源', '读完的那本书', '在推进的书', '读到 30/100 页']) {
      assert.ok(html.includes(needle), `缺了「${needle}」—— 卡片退化成数字板`);
    }
    for (const title of ['读', '书', '写', '划']) {
      assert.ok(html.includes(`<h3>${title}</h3>`), `没有「${title}」这张卡`);
    }
  });

  it('写作卡片给天数 / 字数 / 连写 / 心情 / 读后感', async () => {
    const html = await render();
    assert.ok(html.includes('1234'), '字数没画');
    assert.ok(html.includes('连写'), '连写没画');
    assert.ok(html.includes('还不错'), '心情那一句没画');
    assert.ok(html.includes('11-19'), '读后感的日期没画');
  });

  it('★ 页脚写明「不含私密日记」', async () => {
    const html = await render();
    assert.ok(html.includes('不含私密日记'), '边界没写出来');
    assert.ok(html.includes('数据都在本机'));
  });

  it('空周：说人话，并给一句下一步', async () => {
    const empty = fixtureReport({
      reading: { articles: 0, saved: 0, topFeeds: [], titles: [], savedTitles: [] },
      books: { finished: [], progressed: [], highlightCount: 0, highlights: [] },
      papers: { added: [], finished: [], read: [] },
      writing: { entries: 0, chars: 0, days: 0, dayKeys: [], streak: 0, byKind: {}, moods: [], reflections: [] },
      empty: true,
    });
    const html = await render({ data: fixtureData({ report: empty }) });
    assert.ok(html.includes('这一周很安静'), '概览没落到「安静」');
    assert.ok(html.includes('这一周没有标记已读的文章'));
    assert.ok(html.includes('这一周没有翻书'));
    assert.ok(html.includes('这一周没有写日记'));
    assert.ok(html.includes('下周这里就会有内容'), '空周没给下一步');
    // 反向对照：空周不该冒出「读了 0 篇」这种确定却无意义的数字。
    assert.ok(!html.includes('读了 0 篇'), '空周拼出了「读了 0 篇」');
  });

  it('★ 划线目录读不到时说「数量未知」，不说「0 处」', async () => {
    const report = fixtureReport({
      books: { finished: [], progressed: [], highlightCount: 0, highlights: [] },
      scanned: { annotationsReadable: false },
    });
    const html = await render({ data: fixtureData({ report }) });
    assert.ok(html.includes('数量未知'), '丢掉了「不知道」与「0」的区别');
    assert.ok(!html.includes('这一周没有划线'), '读不到还宣称「没有划线」');
    // 反向对照：读得到、但真的没划时，说「没有划线」。
    const known = await render({ data: fixtureData({ report: fixtureReport({ books: { finished: [], progressed: [], highlightCount: 0, highlights: [] } }) }) });
    assert.ok(known.includes('这一周没有划线'));
  });

  it('加载中且还没有数据：给一句「正在汇总」，不是空白页', async () => {
    const html = await render({ data: null, loading: true });
    assert.ok(html.includes('正在汇总这一周'));
  });

  it('出错：把原因说出来，并给「重新加载」', async () => {
    const html = await render({ data: null, loading: false, error: '请求超时（60 秒）' });
    assert.ok(html.includes('请求超时'));
    assert.ok(html.includes('重新加载'));
    assert.equal(countClass(html, 'npr-weekly-error'), 1);
  });

  it('「上一周」在最新一周时禁用，「下一周」在最早一周时禁用', async () => {
    // 当前指向最新（index 0）：上一周可点、下一周禁用。
    const latest = await render();
    const olderDisabled = latest.includes('aria-label="上一周" disabled');
    const newerDisabled = latest.includes('aria-label="下一周" disabled');
    assert.equal(newerDisabled, true, '最新一周上「下一周」应该是禁用的');
    assert.equal(olderDisabled, false, '最新一周上「上一周」应该可点');

    // 指向最早（index 2）：反过来。
    const last = fixtureData({ report: fixtureReport({ range: { ...fixtureReport().range, key: '2026-W45' } }) });
    const earliest = await render({ data: last });
    assert.equal(earliest.includes('aria-label="上一周" disabled'), true, '最早一周上「上一周」应该禁用');
    assert.equal(earliest.includes('aria-label="下一周" disabled'), false, '最早一周上「下一周」应该可点');
  });
});

describe('0.88.0：周报画面的反向对照', () => {
  it('把页脚那句边界删掉 ⇒ 断言变红', async () => {
    const mod = await loadView({
      key: 'no-privacy-note',
      plugins: [mutateView('privacy', '\n            数据都在本机 · 不含私密日记\n', '\n')],
    });
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.WeeklyView, {
      data: fixtureData(), error: '', loading: false, onRefresh: noop, onPick: noop, onExit: noop, onExitTo: noop,
    }));
    assert.ok(!html.includes('不含私密日记'), '变异后这句话还在 —— 说明变异锚点错了');
  });

  it('把正文头部那条 data-window-drag 删掉 ⇒ 只剩一条', async () => {
    const mod = await loadView({
      key: 'no-drag',
      plugins: [mutateView('drag', 'className="npr-weekly-head" data-window-drag', 'className="npr-weekly-head"')],
    });
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.WeeklyView, {
      data: fixtureData(), error: '', loading: false, onRefresh: noop, onPick: noop, onExit: noop, onExitTo: noop,
    }));
    assert.equal(html.split('data-window-drag').length - 1, 1, '拖动区没被删掉 —— 变异没生效');
  });

  it('把「数量未知」的分支删掉 ⇒ 读不到时会误报「没有划线」', async () => {
    const mod = await loadView({
      key: 'no-unknown',
      plugins: [mutateView('unknown', "'划线目录这次没读到，数量未知'", "'这一周没有划线'")],
    });
    const report = fixtureReport({
      books: { finished: [], progressed: [], highlightCount: 0, highlights: [] },
      scanned: { annotationsReadable: false },
    });
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.WeeklyView, {
      data: fixtureData({ report }), error: '', loading: false, onRefresh: noop, onPick: noop, onExit: noop, onExitTo: noop,
    }));
    assert.ok(!html.includes('数量未知'), '变异没生效');
    assert.ok(html.includes('这一周没有划线'), '这条正是要证明「删掉分支就会误报」');
  });
});
