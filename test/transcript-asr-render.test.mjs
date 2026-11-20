/**
 * 字幕面板的「没字幕 → 本机识别」这一段，用**真渲染**（`react-dom/server`）跑。
 *
 * ★ 为什么不能只做结构守卫（在源码里 grep 文案）：这一段的三种状态是**互斥分支**，
 *   分支写反、`asr` 缺字段、`missing` 拼错，界面都会照常渲染出一个空容器 ——
 *   「元素在、点了没用」正是这类缺陷的典型样子。渲染成 HTML 之后，判据可以直接问
 *   「这一段里到底有没有那个按钮」。
 * ★ 每条正向判据都配一条**反向对照**：把 ffmpeg 分支删掉，按钮必须重新出现，
 *   否则说明这条用例根本没绑在那个分支上（恒真）。
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
import * as Server from 'react-dom/server';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = join(pluginRoot, 'src/client/TranscriptPanel.jsx');

/** 与 `build.mjs` 同配置在内存里打包；`mutate` 改的是真源码的锚点。 */
async function loadPanel({ mutate } = {}) {
  const plugins = [];
  if (mutate !== undefined) {
    plugins.push({
      name: 'mutate-panel',
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
    external: ['react', 'react/jsx-runtime', 'react-dom/server'],
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
    require: (name) => {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return JsxRuntime;
      if (name === 'react-dom/server') return Server;
      return {};
    },
    document: { ...element(), head: element(), body: element(), createElement: element },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { userAgent: 'node' },
  });
  runInContext(result.outputFiles[0].text, context, { filename: 'transcript-panel.cjs' });
  assert.equal(typeof module.exports.TranscriptPanel, 'function', 'TranscriptPanel 没导出');
  return module.exports;
}

const TRANSLATION_IDLE = { status: 'idle', translations: [], total: 0, done: false, error: '' };

/** 渲染「没字幕」这一态。`asr` 只写本用例关心的字段，其余取默认。 */
async function renderEmpty(asr, options = {}) {
  const { TranscriptPanel } = await loadPanel(options);
  const html = Server.renderToStaticMarkup(React.createElement(TranscriptPanel, {
    transcript: null,
    status: 'empty',
    error: '',
    translation: TRANSLATION_IDLE,
    langMode: 'source',
    asr: { status: 'idle', ...asr },
    onTranscribe: () => {},
    onCancelTranscribe: () => {},
    onFetch: () => {},
    onTranslate: () => {},
    onCycleLang: () => {},
    standalone: true,
  }));
  return html;
}

describe('没字幕时的识别入口（0.84.0 起三档引擎）', () => {
  it('本机 Whisper 就绪：给按钮，并说出要下多大模型', async () => {
    const html = await renderEmpty({ status: 'idle', missing: [], sizeMb: 181 });
    assert.match(html, />识别这一集<\/button>/);
    // 体积必须落到画面上：不写的话用户不知道点下去要下多少。
    assert.match(html, /181 MB/);
    assert.doesNotMatch(html, /brew install ffmpeg/);
  });

  /**
   * ★ 三档引擎的说明**必须是三句不同的话**（0.84.0）。
   *   写成一句通用的「音频不出本机」，选了云端识别的用户会以为自己那一路也在本机跑 ——
   *   而它会把整集音频上传。这不是文案问题，是把用户的东西送出去。
   */
  it('本机 Qwen3-ASR：说 GB 不说 MB，并点名 Qwen3-ASR', async () => {
    const html = await renderEmpty({ status: 'idle', missing: [], sizeMb: 1024, engine: 'qwen' });
    assert.match(html, />识别这一集<\/button>/);
    assert.match(html, /Qwen3-ASR/);
    // 1.0 GB 不能写成「1024 MB」—— 用户在 Ollama 那个下载条上看到的是 GB。
    assert.match(html, /1\.0 GB/);
    assert.doesNotMatch(html, /1024 MB/);
    assert.match(html, /音频不出本机/);
  });

  it('云端识别：按钮叫「云端识别」，并且**明确说会上传音频**', async () => {
    const html = await renderEmpty({ status: 'idle', missing: [], engine: 'cloud' });
    assert.match(html, />云端识别<\/button>/);
    assert.match(html, /上传音频/);
    // ★ 反向：云端那条路绝不能出现「音频不出本机」—— 那是本机两条路的承诺。
    assert.doesNotMatch(html, /音频不出本机/);
  });

  it('缺 ffmpeg：说清缺什么、怎么装，并且**不给按钮**', async () => {
    const html = await renderEmpty({ status: 'idle', missing: ['ffmpeg'] });
    assert.match(html, /brew install ffmpeg/);
    // ★ 反向对照的一半：缺 ffmpeg 时不该出现识别按钮 —— 点了只会吃 409，
    //   还得先下模型。这条断言若恒绿（按钮永远不存在），下一条会抓住。
    assert.doesNotMatch(html, />识别这一集</);
    assert.doesNotMatch(html, />云端识别</);
  });

  it('反向对照：把 ffmpeg 分支删掉，按钮必须重新出现', async () => {
    // 用整段替换：把 `missing.includes('ffmpeg') ? (...) :` 的判定改成恒假。
    const html = await renderEmpty({ status: 'idle', missing: ['ffmpeg'] }, {
      mutate: { from: "asr.missing.includes('ffmpeg') ?", to: "false ?" },
    });
    assert.match(html, />识别这一集<\/button>/, '变异后按钮没出现，说明 ffmpeg 那条用例是恒真的');
    assert.doesNotMatch(html, /brew install ffmpeg/);
  });

  it('下载中：有进度条与百分比，没有可点的识别按钮', async () => {
    const html = await renderEmpty({ status: 'preparing', stage: 'model', progress: 0.42 });
    assert.match(html, /role="progressbar"/);
    assert.match(html, /42%/);
    assert.match(html, /正在下载识别模型/);
    assert.doesNotMatch(html, />识别这一集</);
  });

  it('识别中：片数、已出段数、最近几句、停止按钮都在', async () => {
    const html = await renderEmpty({
      status: 'running', done: 2, total: 11, segments: 35, preview: ['第一句', '第二句'],
    });
    assert.match(html, /2\/11/);
    assert.match(html, /35 段/);
    // ★ 预览文本是关键反馈：只有百分比时，用户分不清「在跑」与「跑飞了」。
    assert.match(html, /第二句/);
    assert.match(html, /停止/);
    assert.doesNotMatch(html, />识别这一集</);
  });

  it('识别中的文案分得出是哪一档引擎（云端 / Qwen / Whisper）', async () => {
    // ★ 跑起来之后「用了哪个引擎」只能靠这句话看出来：三条路的耗时与隐私含义差很远，
    //   写同一句「识别中」，用户没法判断自己选的那条是不是真的生效了。
    const cloud = await renderEmpty({ status: 'running', done: 1, total: 3, engine: 'cloud' });
    assert.match(cloud, /云端识别中/);
    const qwen = await renderEmpty({ status: 'running', done: 1, total: 3, engine: 'qwen' });
    assert.match(qwen, /Qwen3-ASR 识别中/);
    const whisper = await renderEmpty({ status: 'running', done: 1, total: 3 });
    assert.match(whisper, /本机识别中/);
  });

  it('识别中画「片」不画百分比：11 片给 11 格，已完成 2 格变实心', async () => {
    // ★ 这条判据的存在理由：进度条换成刻度后，「几格」就是「还剩几片」的唯一表达。
    //   只断「有个进度条」的话，退回百分比条照样绿 —— 所以数格子。
    const html = await renderEmpty({ status: 'running', done: 2, total: 11, segments: 35 });
    assert.match(html, /class="npr-tr-ticks"/);
    const ticks = [...html.matchAll(/<span class="(is-done|is-active|)"><\/span>/g)].map((match) => match[1]);
    assert.equal(ticks.length, 11, '一格一片：total 11 就该有 11 格');
    assert.equal(ticks.filter((state) => state === 'is-done').length, 2, 'done 2 就该亮 2 格');
    assert.equal(ticks.filter((state) => state === 'is-active').length, 1, '跑着的那一格要有呼吸态');
    // 反向口径：百分比条不该再出现（它是被换掉的那个实现）。
    assert.doesNotMatch(html, /class="npr-tr-bar"/);
  });

  it('解码阶段（还没有片数）：说「正在解码」而不是「第 0/? 片」', async () => {
    const html = await renderEmpty({ status: 'running', done: 0, total: 0, segments: 0 });
    assert.match(html, /正在解码音频/);
    // ★ 反向对照：写死「第 0/? 片」就是一句假话 —— 片数要解码完才知道。
    assert.doesNotMatch(html, /第 0\//);
    assert.doesNotMatch(html, /\/\?/);
    assert.match(html, /停止/);
  });

  it('失败后给「再试一次」并把原因说出来', async () => {
    const html = await renderEmpty({ status: 'error', error: '下载没成功' });
    assert.match(html, /识别没完成：下载没成功/);
    assert.match(html, /再试一次/);
  });

  it('取消后也能重来（不是卡在「识别中」）', async () => {
    const html = await renderEmpty({ status: 'cancelled' });
    assert.match(html, /再试一次/);
    assert.doesNotMatch(html, /识别中/);
  });
});
