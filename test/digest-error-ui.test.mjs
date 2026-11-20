/**
 * 导读的两条用户可见链路（0.84.4 深度复核补）：
 *
 * 1. 错误态不能一律「再试一次」。宿主已经把额度耗尽 / 输出上限分出来了
 *    （ai.js 的 describeFailure 把码写在文案的 `（CODE）` 位置），前端若不认，
 *    用户就会反复点同一个按钮、反复看到同一段英文 —— 截图里已经发生过一次。
 * 2. 点导读时间戳必须切到字幕 tab。三选一之后字幕面板是 display:none，
 *    对隐藏元素 scrollIntoView 什么也不会发生；只 seek 等于把「跳回原话」
 *    的功能砍掉一半。这条用源码判据 + 反向对照钉住（组件太大不宜整体渲染）。
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
import { renderToStaticMarkup } from 'react-dom/server';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST = join(pluginRoot, 'src/client/EpisodeDigest.jsx');
const READER = join(pluginRoot, 'src/client/ReaderPage.jsx');

/** 与 build.mjs 同配置在内存里打一份，React 走 external，避免两份实例。 */
async function loadDigest() {
  const result = await esbuild.build({
    entryPoints: [DIGEST],
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
  const context = createContext({
    console, setTimeout, clearTimeout, queueMicrotask, URL, AbortController,
    module, exports: module.exports,
    require: (name) => (name === 'react' ? React : name === 'react/jsx-runtime' ? JsxRuntime : {}),
  });
  runInContext(result.outputFiles[0].text, context, { filename: 'episode-digest.cjs' });
  assert.equal(typeof module.exports.EpisodeDigest, 'function', 'EpisodeDigest 没导出');
  assert.equal(typeof module.exports.digestFailureCode, 'function', 'digestFailureCode 没导出');
  return module.exports;
}

/** 宿主 describeFailure 的真实格式。 */
const failureMessage = (label, code, tail = '') =>
  `dsh-npie-reader: ${label}（${code}） · opencode/agnes-3.0-flash；${tail}。原始错误：400: whatever`;

function renderError(mod, message) {
  return renderToStaticMarkup(React.createElement(mod.EpisodeDigest, {
    state: { status: 'error', error: message },
  }));
}

describe('digestFailureCode', () => {
  it('从宿主文案里读出三种码', async () => {
    const { digestFailureCode } = await loadDigest();
    assert.equal(digestFailureCode(failureMessage('这个通道的免费额度用完了', 'FREE_QUOTA')), 'FREE_QUOTA');
    assert.equal(digestFailureCode(failureMessage('模型不接受这次请求的输出长度', 'OUTPUT_LIMIT')), 'OUTPUT_LIMIT');
    assert.equal(digestFailureCode(failureMessage('请求被模型服务拒绝', 'INVALID_REQUEST')), 'INVALID_REQUEST');
  });

  it('认不出就返回空串，不把「不知道」伪装成「知道」', async () => {
    const { digestFailureCode } = await loadDigest();
    assert.equal(digestFailureCode('Free usage limit reached, retry after 60s'), '');
    assert.equal(digestFailureCode(''), '');
    assert.equal(digestFailureCode(undefined), '');
  });
});

describe('导读错误态：按钮文案随失败类型变', () => {
  it('额度耗尽：不叫「再试一次」，明确说换通道/填 Key', async () => {
    const mod = await loadDigest();
    const html = renderError(mod, failureMessage('这个通道的免费额度用完了', 'FREE_QUOTA'));
    assert.match(html, /换好通道后再试/, '按钮没说下一步做什么');
    assert.match(html, /换模型躲不开/, '没有点破「换模型没用」');
    assert.doesNotMatch(html, />再试一次</, '又诱导用户重复点同一个按钮');
  });

  it('输出上限：指向换模型，且不说「文章太长」', async () => {
    const mod = await loadDigest();
    const html = renderError(mod, failureMessage('模型不接受这次请求的输出长度', 'OUTPUT_LIMIT'));
    assert.match(html, /换模型后再试/);
    assert.match(html, /输出长度上限/);
    assert.match(html, /不是文章太长/, '没点破旧文案「多半是文章太长」是误判');
  });

  it('未归类的错误落回通用「再试一次」，且不显示专属提示', async () => {
    const mod = await loadDigest();
    const html = renderError(mod, 'Free usage limit reached, retry after 60s');
    assert.match(html, />再试一次</);
    assert.doesNotMatch(html, /npr-dig-hint/);
  });
});

describe('导读时间戳：跳回原话必须切到字幕页', () => {
  const source = readFileSync(READER, 'utf8');
  const match = /const jumpToTime = useCallback\(\(seconds\) => \{([\s\S]*?)\n  \}, \[audioController\]\);/.exec(source);

  it('jumpToTime 同时做「切 tab / seek / 更新 focus」三件事', () => {
    assert.ok(match, '没找到 jumpToTime 函数体（锚点漂移）');
    const body = match[1];
    assert.match(body, /setReadTab\('transcript'\)/, '没切到字幕 tab：字幕面板 display:none，滚动等于没做');
    assert.match(body, /audioController\?\.seek\?\./, '没有 seek 到目标秒数');
    assert.match(body, /setFocus\(/, '没有更新高亮令牌');
  });

  it('反向对照：把切 tab 那行删掉后，判据必须变红', () => {
    assert.ok(match, '没找到 jumpToTime 函数体');
    const broken = match[1].replace(/\s*setReadTab\('transcript'\);/, '');
    assert.notEqual(broken, match[1], '变异没生效（锚点没命中）');
    assert.doesNotMatch(broken, /setReadTab\('transcript'\)/);
  });
});
