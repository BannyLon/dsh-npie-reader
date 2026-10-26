/**
 * 搜索面板的「扫描页补救」：认出那些没有文字层的页，然后重搜。
 *
 * 这块的风险全在**静默**上：
 *  - 按钮点了但没重搜 ⇒ 界面什么都不变，用户以为功能是假的；
 *  - OCR 的命中没标出来 ⇒ 用户拿一句错字去核对原文，然后怀疑搜索坏了；
 *  - 认了 0 页却不说 ⇒ 「还是搜不到」和「这些页确实没有字」长得一模一样。
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = join(pluginRoot, 'src/client/BookFindPanel.jsx');
const READER = join(pluginRoot, 'src/client/BookReader.jsx');

let pending;
function loadPanel() {
  pending ??= (async () => {
    const outFile = join(pluginRoot, 'test', '.build', `find-ocr-${process.pid}.cjs`);
    mkdirSync(dirname(outFile), { recursive: true });
    await esbuild.build({
      stdin: {
        contents: [
          "import React from 'react';",
          "import { renderToStaticMarkup } from 'react-dom/server';",
          `import { BookFindPanel } from ${JSON.stringify(PANEL)};`,
          'export { React, renderToStaticMarkup, BookFindPanel };',
        ].join('\n'),
        resolveDir: pluginRoot,
        loader: 'js',
      },
      bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
      outfile: outFile, logLevel: 'silent',
    });
    const mod = await import(`${outFile}?v=${Date.now()}`);
    return { React: mod.React, renderToStaticMarkup: mod.renderToStaticMarkup, BookFindPanel: mod.BookFindPanel };
  })();
  return pending;
}

const noop = () => {};
const HITS = [
  { key: 'h0', where: '第 12 页', snippet: '磨坊主妇站在门口。' },
  { key: 'h1', where: '第 88 页', snippet: '水轮带动磨坊。', via: 'ocr' },
];

const props = (over = {}) => ({
  query: '磨坊', onQuery: noop, status: 'done', error: '', hits: HITS, activeIndex: 0,
  progress: null, notes: [], unit: 'page', onPick: noop, onStep: noop, onClose: noop, ...over,
});

const count = (html, needle) => html.split(needle).length - 1;

describe('扫描页补救：按钮', () => {
  it('有扫描页时出现按钮，并写明页数与耗时（不写「可能要一会儿」）', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel,
      props({ ocr: { running: false, done: 0, total: 40, note: '' }, onOcr: noop })));
    assert.ok(html.includes('识别这 40 页再搜一次'), html);
    // 40 × 0.8 = 32 秒
    assert.match(html, /约 32 秒/);
    assert.match(html, /不联网、不花钱/);
  });

  it('页数多时按分钟估（400 页 ≈ 5 分钟）', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel,
      props({ ocr: { running: false, done: 0, total: 400, note: '' }, onOcr: noop })));
    assert.match(html, /约 5 分钟/);
  });

  it('★ 运行中只剩「停止」，不留「再搜一次」', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel,
      props({ status: 'searching', ocr: { running: true, done: 7, total: 40, note: '' }, onOcr: noop, onOcrStop: noop })));
    assert.match(html, /正在识别文字 7 \/ 40 页/);
    assert.ok(html.includes('停止'));
    assert.equal(html.includes('再搜一次'), false, '运行中还留着会再起一个循环的按钮');
  });

  it('★ 认完的结果要报出来（0 页也要说，否则和「搜不到」分不开）', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const done = renderToStaticMarkup(React.createElement(BookFindPanel,
      props({ ocr: { running: false, done: 0, total: 12, note: '认出 9 页 · 3 页没认出字' }, onOcr: noop })));
    assert.match(done, /认出 9 页 · 3 页没认出字/);

    const none = renderToStaticMarkup(React.createElement(BookFindPanel,
      props({ ocr: { running: false, done: 0, total: 12, note: '认出 0 页' }, onOcr: noop })));
    assert.match(none, /认出 0 页/);
  });

  it('没有扫描页（ocr=null）⇒ 这一块完全不出现', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel, props()));
    assert.equal(html.includes('npr-find-ocr'), false, html.slice(0, 300));
  });
});

describe('扫描页补救：识别来的命中要标出来', () => {
  it('via=ocr 的那条带「识别」，文字层那条不带', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel, props()));
    assert.equal(count(html, 'npr-find-via'), 1, html);
    assert.ok(html.includes('识别'));
    // 两条命中只标一条：标两条等于说「全都是识别出来的」，那是另一句假话。
    assert.equal(count(html, 'npr-find-item'), 2);
  });

  it('★ 反向对照：把标出来的判据删掉 ⇒ 两条都变「未标记」', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    // 直接把 hits 里的 via 去掉，模拟「上游忘了传」：徽章必须消失，
    // 说明这条断言真的在看 via，而不是碰巧扫到了别处的字。
    const stripped = HITS.map(({ key, where, snippet }) => ({ key, where, snippet }));
    const html = renderToStaticMarkup(React.createElement(BookFindPanel, props({ hits: stripped })));
    assert.equal(count(html, 'npr-find-via'), 0);
  });
});

describe('扫描页补救：BookReader 的接线契约', () => {
  const src = readFileSync(READER, 'utf8');

  it('★ 识别完必须触发重搜（findRerun 在检索 effect 的依赖里）', () => {
    assert.match(src, /setFindRerun\(value => value \+ 1\)/, '识别完没有触发重搜');
    // 依赖数组漏了它，重搜就不会发生，而 OCR 白跑了一遍 —— 界面上毫无变化。
    assert.match(src, /\}, \[findOpen, findQuery, doc, status, numPages, findRerun\]\);/,
      'findRerun 没进检索 effect 的依赖');
  });

  it('★ 识别结果要同时写进本次索引与「来自识别」的名单', () => {
    assert.match(src, /findTexts\.current\.set\(target, text\)/);
    assert.match(src, /findOcrVia\.current\.add\(target\)/);
  });

  it('换书时清掉识别名单并停掉批量（页码是按书的）', () => {
    assert.match(src, /findOcrVia\.current\.clear\(\)/);
    assert.match(src, /findOcrCancel\.current = true/);
  });

  it('单页失败不中断整批（循环里 catch 掉继续）', () => {
    // 结构判据：循环体内有 try / catch，且 catch 只记账不 return。
    const loop = src.slice(src.indexOf('const runFindOcr'));
    const body = loop.slice(0, loop.indexOf('const stopFindOcr'));
    assert.match(body, /catch \{[\s\S]{0,80}failed \+= 1;/);
    assert.equal(/catch \{[\s\S]{0,40}return;/.test(body), false, '一页失败就整批作废了');
  });

  it('取消后不说「认出 N 页」（那句话会被读成「这一批跑完了」）', () => {
    assert.match(src, /已停止识别，剩下的页没有试/);
  });
});
