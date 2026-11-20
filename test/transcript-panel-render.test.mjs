/**
 * 字幕面板：接缝（`jumpToParagraph`）+ 结构守卫。
 *
 * ★ 为什么不调组件函数来模拟点击：组件第一行就是 `useState`，脱离 React 渲染器直接
 *   调用会抛 `Cannot read properties of null (reading 'useState')`。所以把接缝
 *   抽成导出的纯函数，判据直接打在它身上 —— 它跑的**就是**按钮点下去执行的那段代码，
 *   不是它的复制品。
 * ★ 这条接缝错得极其安静：`start` 写成 `end` 只是「跳到了下一句的开头」，
 *   不抛错、不中断播放、按钮也照常有反馈。所以下面每条用例都断言**具体秒数**，
 *   另配两条把实现改坏的反向对照，证明这些秒数不是巧合。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = join(pluginRoot, 'src/client/TranscriptPanel.jsx');
const PANEL_SOURCE = readFileSync(PANEL, 'utf8');

/** 与 `build.mjs` 同配置地在内存里打一份产物（不落盘），`mutate` 用来改真源码。 */
async function loadPanel({ mutate } = {}) {
  const plugins = [];
  if (mutate !== undefined) {
    plugins.push({
      name: 'mutate-transcript-panel',
      setup(build) {
        build.onLoad({ filter: /TranscriptPanel\.jsx$/ }, (args) => {
          const before = readFileSync(args.path, 'utf8');
          const contents = before.replace(mutate.from, mutate.to);
          if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${mutate.from}`);
          return { contents, loader: 'jsx' };
        });
      },
    });
  }
  const result = await esbuild.build({
    entryPoints: [PANEL],
    plugins,
    bundle: true,
    external: ['react', 'react/jsx-runtime'],
    platform: 'browser',
    format: 'cjs',
    target: 'chrome120',
    jsx: 'automatic',
    jsxImportSource: 'react',
    write: false,
    logLevel: 'silent',
    legalComments: 'none',
  });
  const module = { exports: {} };
  const noop = () => {};
  const element = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, removeAttribute: noop, appendChild: noop, removeChild: noop, remove: noop,
    addEventListener: noop, removeEventListener: noop, focus: noop, scrollIntoView: noop,
    querySelector: () => null, querySelectorAll: () => [],
  });
  const context = createContext({
    console, setTimeout, clearTimeout, queueMicrotask, URL, AbortController,
    module, exports: module.exports,
    require: (name) => (name === 'react' ? React : name === 'react/jsx-runtime' ? JsxRuntime : {}),
    document: { ...element(), head: element(), body: element(), createElement: element },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: 'node' },
  });
  runInContext(result.outputFiles[0].text, context, { filename: 'transcript-panel.cjs' });
  assert.equal(typeof module.exports.TranscriptPanel, 'function', 'TranscriptPanel 没导出');
  return module.exports;
}

const PARAGRAPHS = [
  { start: 0, end: 5, text: '开场白' },
  { start: 12, end: 18, text: '第二段' },
];

function recordingController() {
  const calls = [];
  return {
    calls,
    seek(seconds, options) { calls.push({ seconds, options }); return seconds; },
  };
}

describe('jumpToParagraph', () => {
  it('跳到段落**起点**并开始播放', async () => {
    const { jumpToParagraph } = await loadPanel();
    const controller = recordingController();
    const seconds = jumpToParagraph(controller, PARAGRAPHS, 1);
    assert.equal(seconds, 12);
    /**
     * ★ 这里**不能**用 `deepEqual` 比整个调用对象：记录下来的对象是在 vm 里造出来的
     *   （跨 realm），原型不是本 realm 的 `Object.prototype`，`deepStrictEqual` 会
     *   报「结构相同但引用不等」。逐字段断言既避开这个问题，也把口径说清楚了。
     */
    assert.equal(controller.calls.length, 1);
    assert.equal(controller.calls[0].seconds, 12);
    assert.equal(controller.calls[0].options.play, true);
  });

  it('第一段跳 0 秒（0 是合法目标，不能当成「没跳」）', async () => {
    const { jumpToParagraph } = await loadPanel();
    const controller = recordingController();
    assert.equal(jumpToParagraph(controller, PARAGRAPHS, 0), 0);
    assert.equal(controller.calls.length, 1);
    assert.equal(controller.calls[0].seconds, 0);
    assert.equal(controller.calls[0].options.play, true);
  });

  it('越界、空列表、没有控制器都不抛错，也不产生跳转', async () => {
    const { jumpToParagraph } = await loadPanel();
    const controller = recordingController();
    assert.equal(jumpToParagraph(controller, PARAGRAPHS, 9), undefined);
    assert.equal(jumpToParagraph(controller, [], 0), undefined);
    assert.equal(jumpToParagraph(null, PARAGRAPHS, 0), undefined);
    assert.equal(jumpToParagraph({}, PARAGRAPHS, 0), undefined);
    assert.deepEqual(controller.calls, []);
  });

  it('反向对照：把 start 改成 end，跳转目标必须跟着变成 18', async () => {
    const { jumpToParagraph } = await loadPanel({
      mutate: { from: 'controller.seek(paragraph.start, { play: true })', to: 'controller.seek(paragraph.end, { play: true })' },
    });
    const controller = recordingController();
    jumpToParagraph(controller, PARAGRAPHS, 1);
    // 断言的是**真正发给播放器**的秒数，不是函数返回值：返回值写的是 `paragraph.start`，
    // 只断返回值的话，把 seek 的目标改坏也照样绿。
    assert.equal(controller.calls.length, 1);
    assert.equal(controller.calls[0].seconds, 18, '变异没生效的话这里会是 12，说明判据没绑在这句上');
  });

  it('反向对照：去掉 play，跳转仍能发生但不会开始播放', async () => {
    const { jumpToParagraph } = await loadPanel({
      mutate: { from: 'controller.seek(paragraph.start, { play: true })', to: 'controller.seek(paragraph.start)' },
    });
    const controller = recordingController();
    jumpToParagraph(controller, PARAGRAPHS, 1);
    assert.equal(controller.calls.length, 1);
    assert.equal(controller.calls[0].seconds, 12);
    assert.equal(controller.calls[0].options, undefined);
  });
});

describe('面板结构（静态）', () => {
  it('可点行带着 data-t 与当前段的类名，不靠下标寻址', () => {
    // ★ 这一条是**结构守卫**，不是行为判据：它只保证「渲染出来的行带着秒数」这件事
    //   没有被改名/搬走。真正的行为由上面 `jumpToParagraph` 那组钉住。
    assert.ok(PANEL_SOURCE.includes('data-t={paragraph.start}'), '可点行必须带秒数');
    assert.ok(PANEL_SOURCE.includes('npr-tr-line${index === active'), '当前段靠类名标出来');
    assert.ok(PANEL_SOURCE.includes('onClick={() => jumpTo(index)}'), '行的点击必须走到 jumpTo');
  });

  it('三种空状态各说各的话（不能都退成一句话）', () => {
    assert.match(PANEL_SOURCE, /正在获取字幕/);
    assert.match(PANEL_SOURCE, /这期没有字幕/);
    assert.match(PANEL_SOURCE, /再试一次/);
  });
});
