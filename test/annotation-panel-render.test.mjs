/**
 * 划线面板头部「导出」的**真渲染**（react-dom/server）。
 *
 * 盯三件事，都是「坏了不报错」的类型：
 *
 *  1. **0 条时必须真的不可点**，而且禁用态要能从 DOM 上读出来。本项目记过
 *     「只加 `disabled` 属性、不给 `:disabled` 样式 ⇒ 看着能点、点了没反应」，
 *     所以这里既断属性、也断源码里那条规则还在。
 *  2. **按钮在头部那一组里**。跑到别处（比如塞进 tabs 或列表底部）时，
 *     用户找不到它，而 DOM 上它仍然存在 —— 纯 DOM 断「存在」是不够的。
 *  3. **复制失败要说话**（`setCopyState('failed')`）。剪贴板被拒时静默的话，
 *     用户会去别处粘贴，粘出来是上一次的内容 —— 比报错糟得多。
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = join(pluginRoot, 'src/client/AnnotationPanel.jsx');
const CSS = join(pluginRoot, 'src/client/refinements.css');

function mutatePanel(label, from, to) {
  return {
    name: `mutate-annotation-panel-${label}`,
    setup(build) {
      build.onLoad({ filter: /AnnotationPanel\.jsx$/ }, () => {
        const before = readFileSync(PANEL, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'jsx' };
      });
    },
  };
}

let pending;
function loadPanel({ key = 'plain', plugins = [] } = {}) {
  pending ??= new Map();
  if (!pending.has(key)) {
    const outFile = join(pluginRoot, 'test', '.build', `annotation-panel-${key}-${process.pid}.cjs`);
    pending.set(key, (async () => {
      mkdirSync(dirname(outFile), { recursive: true });
      await esbuild.build({
        stdin: {
          contents: [
            "import React from 'react';",
            "import { renderToStaticMarkup } from 'react-dom/server';",
            `import { AnnotationPanel } from ${JSON.stringify(PANEL)};`,
            'export { React, renderToStaticMarkup, AnnotationPanel };',
          ].join('\n'),
          resolveDir: pluginRoot,
          loader: 'js',
        },
        bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
        outfile: outFile, plugins, logLevel: 'silent',
      });
      const mod = await import(`${outFile}?v=${Date.now()}`);
      return { React: mod.React, renderToStaticMarkup: mod.renderToStaticMarkup, AnnotationPanel: mod.AnnotationPanel };
    })());
  }
  return pending.get(key);
}

const noop = () => {};

const MARKS = [
  { id: 'a1', page: 3, start: 0, end: 6, quote: '磨坊主妇', note: '视角切换', tone: 'yellow', createdAt: 1, updatedAt: 1 },
  { id: 'a2', page: 9, start: 4, end: 12, quote: '水轮停了', note: '', tone: 'blue', createdAt: 2, updatedAt: 2 },
];

const props = (over = {}) => ({
  items: MARKS, title: '磨坊', bookId: 'b1', focusId: '',
  onJump: noop, onUpdate: noop, onRemove: noop, onClose: noop, ...over,
});

const count = (html, needle) => html.split(needle).length - 1;

describe('划线面板：导出按钮', () => {
  it('有划线时按钮存在、可点，并写清这次会带走多少条', async () => {
    const { React, renderToStaticMarkup, AnnotationPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(AnnotationPanel, props()));
    assert.ok(html.includes('npr-marks-export'), html.slice(0, 300));
    assert.ok(html.includes('导出'));
    assert.equal(count(html, 'disabled=""'), 0, '有划线时不该禁用');
    assert.match(html, /复制全部 2 条划线为 Markdown/, 'title 没说清导出范围');
  });

  it('★ 0 条时禁用（不是「点了没反应」）', async () => {
    const { React, renderToStaticMarkup, AnnotationPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(AnnotationPanel, props({ items: [] })));
    assert.ok(html.includes('npr-marks-export'));
    assert.equal(count(html, 'disabled=""'), 1, html);
    assert.match(html, /还没有划线可导出/);
  });

  it('按钮在头部那一组里（不在 tabs / 列表里）', async () => {
    const { React, renderToStaticMarkup, AnnotationPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(AnnotationPanel, props()));
    const head = html.slice(html.indexOf('npr-marks-head-actions'), html.indexOf('npr-marks-tabs'));
    assert.ok(head.includes('npr-marks-export'), `导出按钮不在头部：${head}`);
    // 收起按钮必须与它同组：拆开的后果是「两个按钮一左一右，点错一个」
    assert.ok(head.includes('npr-icon'));
  });

  it('统计行仍然照实报（导出按钮的加入没有挤掉它）', async () => {
    const { React, renderToStaticMarkup, AnnotationPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(AnnotationPanel, props()));
    assert.match(html, /2 条 · 1 条笔记 · 分布在 2 页/);
  });

  it('★ 反向对照：把禁用判据改成恒 false ⇒ 0 条时断言必须红', async () => {
    const { React, renderToStaticMarkup, AnnotationPanel } = await loadPanel({
      key: 'no-disable',
      plugins: [mutatePanel('no-disable', 'disabled={stats.total === 0}', 'disabled={false}')],
    });
    const html = renderToStaticMarkup(React.createElement(AnnotationPanel, props({ items: [] })));
    assert.equal(count(html, 'disabled=""'), 0, '反向对照失效：改坏了却仍然禁用');
  });

  it('★ 反向对照：按钮搬出头部 ⇒ 「在头部那一组」这条必须红', async () => {
    const { React, renderToStaticMarkup, AnnotationPanel } = await loadPanel({
      key: 'moved',
      plugins: [mutatePanel('moved', '<div className="npr-marks-head-actions">', '<div className="npr-marks-actions-elsewhere">')],
    });
    const html = renderToStaticMarkup(React.createElement(AnnotationPanel, props()));
    assert.equal(html.includes('npr-marks-head-actions'), false, '反向对照失效：类名还在');
  });
});

describe('划线面板：导出的源码契约', () => {
  const src = readFileSync(PANEL, 'utf8');

  it('失败分支真的会说话（不是 try 里只写成功路径）', () => {
    assert.ok(src.includes("setCopyState('failed')"), '复制失败时静默了');
    assert.ok(src.includes("setCopyState('done')"));
  });

  it('导出的 Markdown 走共用模块，不在这里另拼一份', () => {
    assert.match(src, /import \{ annotationsMarkdown \} from '\.\.\/annotation-format\.js'/);
    // 反向对照：自己拼标题就意味着两份实现，迟早与工具侧漂移。
    assert.equal(/`# 《\$\{/.test(src), false, '面板里另拼了一份 Markdown 头');
  });

  it('倒计时会被清掉（否则组件卸载后再 setState）', () => {
    assert.match(src, /clearTimeout\(copyTimer\.current\)/);
  });

  it('CSS 里有 :disabled 灰化规则与头部动作组', () => {
    const css = readFileSync(CSS, 'utf8');
    assert.match(css, /\.npr-marks-head-actions\s*\{/);
    assert.match(css, /\.npr-marks-export:disabled\s*\{/);
  });
});
