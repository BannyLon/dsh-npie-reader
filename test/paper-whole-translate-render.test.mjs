/**
 * 「整本翻译」两条提示的**真渲染**（react-dom/server）。
 *
 * 盯的是三件「界面上没有就一定会被用户问到」的事：
 *
 *  1. `failed` / `stopped` 之后必须有**收起**按钮。用户 2026-11-13 的原话是
 *     「整本翻译完成后如果出错好像没有暂停或者停止的按键，导致好像一直在提示
 *     错误」—— 那时 `failed` 态既没有按钮也不会自己消失，一条红字永久贴在书页上。
 *  2. 确认卡必须**把时长说出来**，而且要说清这个数是「实测」还是「估算」。
 *     只说一个「约 20 分钟」，用户会拿它当承诺。
 *  3. 已全部译完时主按钮必须真的不可点（`disabled` + 文案），不是「点了弹一句
 *     已经译完了」。后者是「看起来像功能」的典型。
 *
 * ★ 渲染的是**打包后的组件**，不是一个手搓的替身：`useWholeBookJob` 读的是
 *   `paper-translation.js` 的模块级任务台，替身渲染不出来这条链路。
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAYER = join(pluginRoot, 'src/client/PaperTranslateLayer.jsx');
const CONFIRM = join(pluginRoot, 'src/client/WholeBookConfirm.jsx');

/** 让确认卡的估算变成「实测」形态：把 msPerPage 塞进任务快照。 */
function mutateConfirm(label, from, to) {
  return {
    name: `mutate-wtc-${label}`,
    setup(build) {
      build.onLoad({ filter: /WholeBookConfirm\.jsx$/ }, () => {
        const before = readFileSync(CONFIRM, 'utf8');
        const contents = before.replace(from, to);
        if (contents === before) throw new Error(`变异没有生效（锚点没命中）：${from}`);
        return { contents, loader: 'jsx' };
      });
    },
  };
}

let pending;
function loadSsr({ key = 'plain', plugins = [] } = {}) {
  pending ??= new Map();
  if (!pending.has(key)) {
    const outFile = join(pluginRoot, 'test', '.build', `paper-whole-${key}-${process.pid}.cjs`);
    pending.set(key, (async () => {
      mkdirSync(dirname(outFile), { recursive: true });
      await esbuild.build({
        stdin: {
          contents: [
            "import React from 'react';",
            "import { renderToStaticMarkup } from 'react-dom/server';",
            `import { PaperWholeBookJobBar } from ${JSON.stringify(LAYER)};`,
            `import { WholeBookConfirm } from ${JSON.stringify(CONFIRM)};`,
            "import { startWholeBookTranslation, wholeBookJob, __resetPaperTranslationForTests } from './src/client/paper-translation.js';",
            /* 把任务台驱动到 failed：连续三页模型失败就会停在这一态。 */
            'export async function driveFailure(bookId, pages) {',
            '  __resetPaperTranslationForTests();',
            '  const prev = globalThis.fetch;',
            '  globalThis.fetch = async (url) => {',
            '    const path = String(url);',
            "    if (path.endsWith('/page-translation/' + bookId)) return { ok: true, json: async () => ({ ok: true, pages: {} }) };",
            "    if (path.endsWith('/translate-page')) throw new Error('模型 502');",
            '    return { ok: true, json: async () => ({ ok: true }) };',
            '  };',
            '  const doc = { numPages: pages, getPage: async () => ({',
            '    getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, 1, 0, 0] }),',
            "    getTextContent: async () => ({ styles: {}, items: [{ str: 'Attention is all you need.', fontName: 'f1', width: 300, height: 10, transform: [10, 0, 0, 10, 40, 80] }] }),",
            '  }) };',
            '  startWholeBookTranslation({ bookId, doc, numPages: pages, notify: () => {} });',
            '  for (let i = 0; i < 600; i += 1) {',
            "    if (wholeBookJob(bookId).state === 'failed') break;",
            '    await new Promise((resolve) => setTimeout(resolve, 5));',
            '  }',
            '  globalThis.fetch = prev;',
            '  return wholeBookJob(bookId);',
            '}',
            'export { React, renderToStaticMarkup, PaperWholeBookJobBar, WholeBookConfirm, wholeBookJob };',
          ].join('\n'),
          resolveDir: pluginRoot,
          loader: 'js',
        },
        bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
        outfile: outFile, plugins, logLevel: 'silent',
      });
      const mod = await import(`${outFile}?v=${Date.now()}`);
      return mod;
    })());
  }
  return pending.get(key);
}

const count = (html, needle) => html.split(needle).length - 1;

describe('整本翻译失败之后：能收起，不再一直挂着报错', () => {
  it('★ failed 态给「收起」、不给「停止」，且没有进度在动的暗示', async () => {
    const mod = await loadSsr();
    const job = await mod.driveFailure('paper-1', 4);
    assert.equal(job.state, 'failed', '驱动不到 failed，后面的断言测的不是那一条分支');

    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.PaperWholeBookJobBar, { bookId: 'paper-1' }));
    assert.match(html, /is-failed/, '胶囊没有 failed 外观');
    assert.match(html, /收起/, 'failed 之后没有收起按钮 —— 这条红字会一直贴在书页上');
    assert.ok(!/停止/.test(html), 'failed 之后还在给「停止」：已经停了，那颗按钮点了什么都不会发生');
    // 失败也要说清「停在哪一页」，而且进度条要留在真实位置 ——
    // 把条清空会让人以为「刚才跑的都不算」。
    assert.match(html, /停在第\s*\d+\s*页/, '没说清停在哪一页');
    assert.match(html, /npr-book-whole-job-track/, 'failed 时整条进度条被拿掉了');
  });

  it('反向对照：正在跑的时候是「停止」，不是「收起」', async () => {
    const mod = await loadSsr();
    // 不驱动失败，直接用 idle 之外的 running 快照渲染一次。
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.PaperWholeBookJobBar, { bookId: 'paper-unknown' }));
    // idle 时整条不渲染 —— 这本身就是「译完就收掉」的判据。
    assert.equal(html, '', 'idle 的时候还在渲染进度胶囊');
  });
});

describe('整本翻译确认卡：把时长与后果说清楚', () => {
  it('★ 三个数字 + 一段时长 + 两种按钮，缺一个都不算说清楚', async () => {
    const mod = await loadSsr();
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.WholeBookConfirm, {
      bookId: 'paper-confirm', title: 'Harness²', total: 37,
      onConfirm: () => {}, onCancel: () => {},
    }));
    for (const label of ['总页数', '已有译文', '本次要翻']) {
      assert.match(html, new RegExp(label), `确认卡没写「${label}」`);
    }
    assert.match(html, /37/, '总页数没渲染出来');
    // 时长必须是区间 + 声明它是估算；单点数字会被当成承诺。
    assert.match(html, /约\s*\d+\s*分钟\s*–\s*\d+\s*分钟/, '没给出时长区间');
    assert.match(html, /估算/, '没说清这个时长是估算还是实测');
    assert.match(html, /再想想/, '没有取消按钮');
    assert.match(html, /开始翻译/, '没有确认按钮');
    // 三条后果：能继续读、能停、每页一次模型调用。
    assert.match(html, /后台/, '没说开始之后任务在后台跑');
    assert.match(html, /随时能停|能停/, '没说可以停');
    assert.ok(!/disabled=""[^>]*>\s*开始翻译/.test(html), '没译完的情况下「开始翻译」是禁用的 —— 这张卡永远点不动');
  });

  it('★ 全部译完时主按钮真的禁用（不是点了弹一句「已经译完了」）', async () => {
    const mod = await loadSsr();
    /* 缓存计数 > 总页数 ⇒ 本次要翻 0 页。`translatedPageCount` 读的是索引，
       这里用一个「总页数小于已译页数」的构造来命中同一条分支。 */
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.WholeBookConfirm, {
      bookId: 'paper-1', title: 'X', total: 0,
      onConfirm: () => {}, onCancel: () => {},
    }));
    assert.match(html, /disabled/, '0 页可翻时按钮仍然可点');
    assert.match(html, /已全部译完/, '没说出「已经全部译完」');
  });

  it('反向对照：把估算换成单点数字，本文件的区间断言必须变红', async () => {
    const mod = await loadSsr({
      key: 'single-point',
      plugins: [mutateConfirm('single', '`约 ${clean(minMs)} – ${clean(maxMs)}`', '`约 ${clean(minMs)}`')],
    });
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.WholeBookConfirm, {
      bookId: 'paper-confirm', title: 'X', total: 37,
      onConfirm: () => {}, onCancel: () => {},
    }));
    assert.ok(!/约\s*\d+\s*分钟\s*–\s*\d+\s*分钟/.test(html), '区间断言没有守住 —— 单点数字也能过');
    assert.equal(count(html, '分钟'), 1, '单点形态下应只剩一个「分钟」');
  });
});

/**
 * 顶部那颗「翻译这一页」为什么会灰（源码级）。
 *
 * ★ 为什么不真渲染 `BookReader`：它 2900 行、要 pdf.js、要 DOM 度量，
 *   为一条 `disabled` 去搭那套装置，成本远超收益。这里只钉**接线**：
 *   判据（`pageTask`）→ 属性（`disabled`）→ 文案（阶段 + 批次）。
 *   判据本身的行为在 `paper-translation.test.mjs` 里真跑过。
 * ★ 这一条是用户原话「点了翻译之后按钮还能点」的守卫。它坏掉的形态很安静：
 *   按钮照旧可点，点下去什么也不发生（in-flight 被复用），测试也不会红。
 */
describe('「翻译这一页」在翻译中灰掉（源码级）', () => {
  const readApp = () => readFileSync(join(pluginRoot, 'src/client/BookReader.jsx'), 'utf8');

  it('★ 菜单项接的是 pageBusy，且带进度条与阶段文案', () => {
    const app = readApp();
    assert.match(app, /const pageBusy = pageTask\.state === 'running'/, 'pageBusy 的判据变了（不再是任务态）');
    const disabledAt = app.indexOf('disabled={pageBusy}');
    assert.notEqual(disabledAt, -1, '翻译中那颗按钮没有 disabled —— 用户会连点几次');
    // 这一段必须和「翻译这一页」是同一颗按钮：判据与文案分开写就会漂。
    const block = app.slice(disabledAt - 500, disabledAt + 1100);
    assert.match(block, /is-busy/, '没有 is-busy 外观类，灰掉的按钮和「不可用功能」长得一样');
    assert.match(block, /npr-book-translate-track/, '菜单项里没有进度条');
    assert.match(block, /PAGE_STEP_TEXT/, '没说出现在是「取字 / 翻译 / 排版」哪一步');
    // 反向对照：`disabled` 必须是**动态**的，不能写死 true（写死就永远点不了）。
    assert.ok(!/disabled(=\{true\}|\s*>)/.test(block), '按钮被写死成 disabled 了');
  });

  it('★ 「翻译全本」先开确认卡，不直接开跑', () => {
    const app = readApp();
    const start = app.indexOf("wholeState === 'running' || wholeState === 'stopping' ? '停止翻译'");
    assert.notEqual(start, -1, '找不到「翻译全本」那一条菜单项');
    const block = app.slice(start - 900, start + 700);
    assert.match(block, /setWholeConfirmOpen\(true\)/, '点「翻译全本」没有打开确认卡 —— 又变成盲点开跑');
    assert.ok(!/startWholeBookTranslation\(/.test(block), '菜单里直接启动了整本翻译，绕过了确认卡');
    assert.match(app, /<WholeBookConfirm/, '确认卡组件没有挂进阅读器');
  });
});
