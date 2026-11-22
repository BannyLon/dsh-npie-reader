/**
 * 跨源检索面板的**真渲染**（0.88.0）。
 *
 * 盯四件事：
 *  1. **四组标题与计数都在** —— 少画一组，用户就以为那一类没结果；
 *  2. **双链徽标只挂在有链接的条目上**。每条都写「写过 0 条」的话，这一页会变成
 *     一个没有信息的表；
 *  3. **某一组失败的原因显示在那一组上**（不是合并成一句「搜索失败」）；
 *  4. **高亮只有一个**。键盘上下移动时如果多个条目同时 `is-active`，用户不知道
 *     回车会打开哪一条。
 *
 * ★ 反向对照改的是**真源码**（esbuild `onLoad` 替换，锚点没命中就抛错）。
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(pluginRoot, 'src/client/SearchPalette.jsx');

function mutate(label, from, to) {
  return {
    name: `mutate-palette-${label}`,
    setup(build) {
      build.onLoad({ filter: /SearchPalette\.jsx$/ }, () => {
        const before = readFileSync(SOURCE, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'jsx' };
      });
    },
  };
}

const cache = new Map();
function load({ key = 'plain', plugins = [] } = {}) {
  if (!cache.has(key)) {
    const outFile = join(pluginRoot, 'test', '.build', `palette-${key}-${process.pid}.cjs`);
    mkdirSync(dirname(outFile), { recursive: true });
    cache.set(key, (async () => {
      await esbuild.build({
        stdin: {
          contents: [
            `import React from 'react';`,
            `import { renderToStaticMarkup } from 'react-dom/server';`,
            `import { PaletteView } from ${JSON.stringify(SOURCE)};`,
            `export { React, renderToStaticMarkup, PaletteView };`,
          ].join('\n'),
          resolveDir: pluginRoot,
          loader: 'js',
          sourcefile: 'palette-entry.mjs',
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

/**
 * 数「class 里真的含这个类名」的元素个数。
 * ★ 按空格分词后整词比较，不能用 `\b`：`-` 是非单词字符，`npr-palette-hit` 会在
 *   `npr-palette-hit-title` 里命中边界（周报那份测试踩过同一个坑）。
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

function fixture() {
  return {
    query: '信任',
    total: 3,
    groups: [
      {
        kind: 'article', label: '订阅', total: 2, hidden: 1,
        hits: [
          {
            id: 'article:k1', title: '信任是怎么被定价的', sub: '示例源', snippet: '…赌局里两个人互相押注…',
            jump: { kind: 'article', key: 'k1' }, links: { notes: 2 },
          },
          {
            id: 'article:k2', title: '第二篇', sub: '示例源', snippet: '',
            jump: { kind: 'article', key: 'k2' },
          },
        ],
      },
      {
        kind: 'book', label: '书', total: 1, hidden: 0,
        hits: [{
          id: 'book:b1:3', title: '信任的代价', sub: '第 3 章 · 转折 · 摘要命中', snippet: '…代价…',
          jump: { kind: 'book', bookId: 'b1', chapter: 3 }, links: { notes: 1 },
        }],
      },
      { kind: 'paper', label: '论文', total: 0, hidden: 0, hits: [] },
      {
        kind: 'diary', label: '日记', total: 0, hidden: 0, hits: [],
        note: '这次没搜到（日记目录读不到）',
      },
    ],
  };
}

async function render(props = {}) {
  const mod = await load();
  return mod.renderToStaticMarkup(mod.React.createElement(mod.PaletteView, {
    query: '信任', data: fixture(), busy: false, error: '', active: 0,
    placeholder: '搜订阅、书、论文、日记…',
    onQuery: noop, onKeyDown: noop, onPick: noop, onClose: noop,
    ...props,
  }));
}

describe('0.88.0：跨源检索面板', () => {
  it('★ 四组里**有结果的都画出来**，计数与「还有 N 条」都对', async () => {
    const html = await render();
    for (const label of ['订阅', '书', '日记']) {
      assert.ok(html.includes(`<h3>${label}</h3>`), `没有「${label}」这一组`);
    }
    assert.ok(html.includes('2 条 · 另有 1 条未显示'), '截断没报数');
    assert.ok(html.includes('共 3 条'), '总数没画');
  });

  it('标题 / 副标题 / 摘要三级都在（少了摘要就只剩一行标题）', async () => {
    const html = await render();
    for (const needle of ['信任是怎么被定价的', '示例源', '赌局里两个人互相押注', '第 3 章 · 转折 · 摘要命中']) {
      assert.ok(html.includes(needle), `缺了「${needle}」`);
    }
  });

  it('★ 双链徽标只挂在有链接的条目上', async () => {
    const html = await render();
    assert.equal(countClass(html, 'npr-palette-hit-link'), 2, '两个有链接的条目各一个徽标');
    assert.ok(html.includes('写过 2 条'));
    assert.ok(html.includes('写过 1 条'));
    // 反向对照：k2 一条笔记都没有，它那一行不能出现徽标文案。
    // ★ 只截到「它自己那个 </button>」为止：往后切会把下一组（书，有 1 条笔记）
    //   的徽标算进来 —— 第一版就是这么误判成「挂了徽标」的。
    const start = html.indexOf('第二篇');
    const segment = html.slice(start, html.indexOf('</button>', start));
    assert.ok(start > 0, '前置条件：第二篇应该在结果里');
    assert.ok(!segment.includes('写过'), '没有链接的条目也挂了徽标');
  });

  it('★ 某一组失败的原因留在那一组上', async () => {
    const html = await render();
    assert.ok(html.includes('这次没搜到（日记目录读不到）'));
    // 反向对照：不能把它画成全局错误横幅（那是另一条路径，会把三组正常结果一起盖住）。
    assert.equal(countClass(html, 'npr-palette-error'), 0);
  });

  it('高亮只有一个', async () => {
    const html = await render();
    assert.equal(countClass(html, 'is-active'), 1);
    // 反向对照：active 传 1 时，高亮应该落到第二个命中（不是第一个）。
    const second = await render({ active: 1 });
    const activeIndex = second.indexOf('is-active');
    assert.ok(activeIndex > second.indexOf('第二篇') - 400, '高亮没跟着 active 走');
    assert.equal(countClass(second, 'is-active'), 1);
  });

  it('空查询给一句「找什么」，空结果给「四处都没有」', async () => {
    const idle = await render({ query: '', data: null });
    assert.ok(idle.includes('四处一起找'));

    const none = await render({
      query: '不存在的词',
      data: { query: '不存在的词', total: 0, groups: [{ kind: 'article', label: '订阅', total: 0, hidden: 0, hits: [] }] },
    });
    assert.ok(none.includes('四处都没有'));
    assert.ok(none.includes('短词更容易命中'), '没给出下一步');
  });

  it('搜索中显示进度；出错显示错误', async () => {
    const busy = await render({ busy: true, data: null });
    assert.ok(busy.includes('搜索中'));
    const failed = await render({ data: null, error: '阅读服务未就绪，请稍后重试' });
    assert.ok(failed.includes('阅读服务未就绪'));
    assert.equal(countClass(failed, 'npr-palette-error'), 1);
  });

  it('Esc 按钮在（不只靠键盘）', async () => {
    const html = await render();
    assert.ok(html.includes('npr-palette-esc'));
    assert.ok(html.includes('关闭（Esc）'));
  });
});

describe('0.88.0：跨源面板的反向对照', () => {
  it('把双链徽标整块删掉 ⇒ 断言变红', async () => {
    const mod = await load({
      key: 'no-links',
      plugins: [mutate('links', '{hit.links?.notes > 0 ? (', '{false ? (')],
    });
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.PaletteView, {
      query: '信任', data: fixture(), busy: false, error: '', active: 0,
      onQuery: noop, onKeyDown: noop, onPick: noop, onClose: noop,
    }));
    assert.equal(countClass(html, 'npr-palette-hit-link'), 0, '变异没生效');
  });

  it('把分组备注删掉 ⇒ 失败原因不再显示', async () => {
    const mod = await load({
      key: 'no-note',
      plugins: [mutate('note', '{group.note ? <p className="npr-palette-note">{group.note}</p> : null}', '')],
    });
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.PaletteView, {
      query: '信任', data: fixture(), busy: false, error: '', active: 0,
      onQuery: noop, onKeyDown: noop, onPick: noop, onClose: noop,
    }));
    assert.ok(!html.includes('日记目录读不到'), '变异没生效');
  });
});
