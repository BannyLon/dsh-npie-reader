/**
 * 书内搜索面板的**真渲染**（react-dom/server），不是读源码猜。
 *
 * 盯四件事，每一件都是「坏了也不会报错」的类型：
 *
 *  1. **「共 N 处」旁边的诚实说明必须真的在**。扫描页没搜、命中到上限被截断 ——
 *     这两件事让那个数字变成**不完整的数字**。不说出来，用户会把它读成
 *     「全书只有 N 处」，那是一句确定的假话。
 *  2. **判据要能自证**。面板里明写「与 `book_search` 同一套（不区分大小写、按子串）」。
 *     用户怀疑「AI 说第 7 章有，我搜不到」时，这句话是唯一的解释入口。
 *  3. **当前那一处必须画得出来**（`is-current`）。一页十几处命中，只差一点透明度
 *     的话，按回车之后看不出跳到哪了 —— 症状是「跳转像没生效」。
 *  4. **空输入 ≠ 没有命中**。前者提示「输入一个词」，后者说「没有找到『xx』」。
 *     合并成一句话，用户会以为「还没打字就搜过了」。
 *
 * ★ 用 `renderToStaticMarkup` 而不是真浏览器：这个面板是**纯展示**（数据、状态、
 *   回调全由父组件给），交互（回车翻命中、Esc 收起）的判据在纯函数和父组件里，
 *   这里要盯的是「文字与类名有没有出现在它该出现的位置」。
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
const PANEL = join(pluginRoot, 'src/client/BookFindPanel.jsx');

/**
 * 反向对照用：在 esbuild 读 `BookFindPanel.jsx` 时把源码换掉。
 * ★ 替换没生效就**抛错**：否则对照是「什么都没改，然后断言照旧通过」的假绿。
 */
function mutatePanel(label, from, to) {
  return {
    name: `mutate-find-panel-${label}`,
    setup(build) {
      build.onLoad({ filter: /BookFindPanel\.jsx$/ }, () => {
        const before = readFileSync(PANEL, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'jsx' };
      });
    },
  };
}

let pending;
/**
 * 打一份（可选地被改坏的）产物并加载。
 *
 * ★ `key` 必须**每个变异各不相同**：缓存键共用的话，第二次及之后的对照会拿到
 *   第一次那份产物 —— 断言照样通过，但测的是上一处改动，整组对照是假的。
 */
function loadPanel({ key = 'plain', plugins = [] } = {}) {
  pending ??= new Map();
  if (!pending.has(key)) {
    const outFile = join(pluginRoot, 'test', '.build', `find-panel-${key}-${process.pid}.cjs`);
    pending.set(key, (async () => {
      mkdirSync(dirname(outFile), { recursive: true });
      await esbuild.build({
        stdin: {
          contents: [
            `import React from 'react';`,
            `import { renderToStaticMarkup } from 'react-dom/server';`,
            `import { BookFindPanel } from ${JSON.stringify(PANEL)};`,
            `export { React, renderToStaticMarkup, BookFindPanel };`,
          ].join('\n'),
          resolveDir: pluginRoot,
          loader: 'js',
          sourcefile: 'find-panel-entry.mjs',
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
  return pending.get(key);
}

const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
const noop = () => {};

const HITS = [
  { key: 'h0', where: '第 3 页', sub: '第一章 磨坊', snippet: '磨坊主妇站在磨坊门口。' },
  { key: 'h1', where: '第 12 页', snippet: '水轮带动磨坊。' },
];

function render(props = {}) {
  return renderToStaticMarkup(React.createElement(BookFindPanel, {
    query: '', onQuery: noop, status: 'idle', error: '', hits: [], activeIndex: -1,
    progress: null, notes: [], unit: 'page', onPick: noop, onStep: noop, onClose: noop,
    ...props,
  }));
}

/** 类名出现的次数（用来数「画了几个命中」）。
 *  ★ 数 `class="…"` 整串，不数裸类名：`npr-find-step` 是 `npr-find-steps` 的前缀、
 *    `npr-find-note` 是 `npr-find-notes` 的前缀 —— 数裸名会凭空多出一次，
 *    而那正好是「断言看着合理、其实数错了一个」的经典假绿。 */
const count = (html, needle) => html.split(needle).length - 1;

/**
 * 去掉标签后的纯文字。
 * ★ 片段里命中的词被 `<mark>` 切成了三段（`<span>水轮带动</span><mark>磨坊</mark>`），
 *   这时**连续字符串是不存在的** —— 直接 `includes('水轮带动磨坊。')` 会假红。
 *   要判「用户看见的字」就必须先脱标签。
 */
const textOf = (html) => html.replace(/<[^>]*>/g, '');

describe('空输入：还没搜，不是「没有命中」', () => {
  it('提示「输入一个词」，而不是「没有找到』', () => {
    const html = render();
    assert.ok(html.includes('输入一个词就会在整本正文里找'), html.slice(0, 300));
    assert.equal(html.includes('没有找到'), false, '空输入被误报成「没有命中」');
  });

  it('★ 判据自证：写明与 book_search 同一套（不区分大小写、按子串、不分词）', () => {
    const html = render();
    assert.ok(html.includes('book_search'), '用户看不见判据来自哪里');
    assert.ok(html.includes('不区分大小写'));
    assert.ok(html.includes('子串'));
    assert.ok(html.includes('不分词'));
  });

  it('没有命中时上下条是禁用的（不是「点了没反应」）', () => {
    const html = render();
    // 两个按钮 + 都带 disabled：禁止态必须能从 DOM 上读出来。
    assert.equal(count(html, 'class="npr-find-step"'), 2);
    assert.equal(count(html, 'disabled=""'), 2, html);
  });
});

describe('有命中：数得清、跳得过去、当前那一处看得出来', () => {
  const done = () => render({ query: '磨坊', status: 'done', hits: HITS, activeIndex: 0 });

  it('「共 2 处 · 第 1 处」——数字与位置都写出来', () => {
    const html = done();
    assert.ok(html.includes('共 2 处'), html.slice(0, 400));
    assert.ok(html.includes('第 1 处'));
  });

  it('每条命中都带「在哪」（页号 / 章节）与片段', () => {
    const html = done();
    const text = textOf(html);
    assert.ok(text.includes('第 3 页'));
    assert.ok(text.includes('第一章 磨坊'));
    assert.ok(text.includes('水轮带动磨坊。'), text);
  });

  it('★ 片段里的搜索词被标出来（`npr-find-hit` 的 <mark>）', () => {
    const html = done();
    assert.ok(count(html, 'npr-find-hit') >= 2, '命中的词没有在片段里标出来');
    assert.ok(html.includes('<mark'));
  });

  it('★ 当前那一处有 `is-current`，别处没有 —— 否则「跳过去了」看不出来', () => {
    const html = done();
    assert.equal(count(html, 'npr-find-item is-current'), 1, html);
  });

  it('activeIndex=-1（搜到了还没跳）⇒ 一条都不是当前', () => {
    const html = render({ query: '磨坊', status: 'done', hits: HITS, activeIndex: -1 });
    assert.equal(count(html, 'npr-find-item is-current'), 0);
  });

  it('命中不止一处时上下条按钮不再禁用', () => {
    assert.equal(count(done(), 'disabled=""'), 0);
  });
});

describe('没有命中：说清楚搜的是哪个词', () => {
  it('标题说「没有命中」、列表说「没有找到『磨坊』」并建议换词', () => {
    const html = render({ query: '磨坊', status: 'done', hits: [] });
    assert.ok(html.includes('没有找到「磨坊」'), html.slice(0, 400));
    assert.ok(html.includes('换一个更短'));
    // ★ 标题栏不能写「共 0 处」：那是一个数字，而这件事该用一句话说。
    assert.ok(textOf(html).includes('没有命中'), '标题栏没有说「没有命中」');
    assert.equal(html.includes('共 0 处'), false);
  });
});

describe('诚实说明：不完整的数字必须解释', () => {
  it('★ 扫描页的数量写出来（「另有 N 页没有文字层」）', () => {
    const html = render({
      query: '磨坊', status: 'done', hits: HITS,
      notes: ['另有 187 页没有文字层（扫描页），这次没有检索它们'],
    });
    assert.ok(html.includes('另有 187 页没有文字层'), html.slice(0, 500));
    assert.ok(html.includes('npr-find-notes'));
  });

  it('★ 截断写出来（命中到上限就停了）', () => {
    const html = render({
      query: '磨坊', status: 'done', hits: HITS,
      notes: ['命中到 300 处就停下了 —— 后面还有没有，这次没查完'],
    });
    assert.ok(html.includes('300 处就停下了'));
  });

  it('两条说明可以同时出现（扫描页 + 截断是两件事）', () => {
    const html = render({
      query: '磨坊', status: 'done', hits: HITS,
      notes: ['另有 3 页没有文字层（扫描页），这次没有检索它们', '命中到 300 处就停下了 —— 后面还有没有，这次没查完'],
    });
    assert.equal(count(html, 'class="npr-find-note"'), 2);
  });

  it('没有说明时不留一个空的 footer（否则底部多一条分隔线）', () => {
    assert.equal(render({ query: '磨坊', status: 'done', hits: HITS }).includes('npr-find-notes'), false);
  });
});

describe('检索中 / 出错', () => {
  it('检索中显示进度「已扫 N / M 页」', () => {
    const html = render({ query: '磨坊', status: 'searching', progress: { done: 12, total: 300 }, hits: HITS });
    assert.ok(html.includes('已扫 12 / 300 页'), html.slice(0, 400));
    assert.ok(html.includes('已找到 2 处'));
  });

  it('电子书用「节」而不是「页」（同一个面板，两种单位）', () => {
    const html = render({ query: '磨坊', status: 'searching', unit: 'section', progress: { done: 3, total: 18 } });
    assert.ok(html.includes('已扫 3 / 18 节'));
  });

  it('出错时显示错误句，且**不留**空态提示（两句话会互相打脸）', () => {
    const html = render({ query: '磨坊', status: 'error', error: '检索失败：宿主没接上' });
    assert.ok(html.includes('检索失败：宿主没接上'));
    assert.equal(html.includes('输入一个词'), false);
    assert.equal(html.includes('没有找到'), false);
  });

  it('出错但没有具体消息时，兜底说一句（不显示空白条）', () => {
    assert.ok(render({ query: '磨坊', status: 'error' }).includes('检索失败'));
  });
});

describe('反向对照：把真源码改坏，断言必须变红', () => {
  const cases = [
    {
      label: '去掉「不完整数字」的说明块',
      from: "{notes.length > 0 && (",
      to: "{false && (",
      check(html) {
        assert.equal(html.includes('另有 187 页没有文字层'), false, '说明块被摘掉后仍在');
      },
    },
    {
      label: '去掉当前命中的高亮类',
      from: "index === current ? ' is-current' : ''",
      to: "''",
      check(html) {
        assert.equal(count(html, 'npr-find-item is-current'), 0);
      },
    },
    {
      label: '把「没有命中」改成空态那句话（两种状态混成一句）',
      from: '没有找到「{needle}」',
      to: '输入一个词就会在整本正文里找',
      // ★ 这一条必须喂**零命中**的 props：在有命中的渲染里那句根本不出现，
      //   拿它当判据等于什么都没查（假绿）。
      props: { query: '磨坊', status: 'done', hits: [], activeIndex: -1 },
      check(html) {
        assert.equal(html.includes('没有找到「磨坊」'), false);
      },
    },
  ];

  for (const [index, item] of cases.entries()) {
    it(item.label, async () => {
      const mutated = await loadPanel({
        key: `mut-${index}`,
        plugins: [mutatePanel(`m${index}`, item.from, item.to)],
      });
      const html = mutated.renderToStaticMarkup(mutated.React.createElement(mutated.BookFindPanel, {
        query: '磨坊', onQuery: noop, status: 'done', error: '', hits: HITS, activeIndex: 0,
        progress: null, notes: ['另有 187 页没有文字层（扫描页），这次没有检索它们'],
        unit: 'page', onPick: noop, onStep: noop, onClose: noop,
        ...(item.props ?? {}),
      }));
      item.check(html);
    });
  }
});
