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
    // ★ 只断言「findRerun 在这条依赖数组里」，不钉死整个数组：0.27.1 加了
    //   `findScanProbe`（扫描书要先建索引）与 `loadFindOcrIndex`（读回已识别的页）。
    //   写成字面量的话，每加一条正经依赖都得回来改这句 —— 那是假耦合。
    assert.match(src, /\n  \}, \[[^\]]*findRerun[^\]]*\]\);/,
      'findRerun 没进检索 effect 的依赖');
  });

  it('★ 索引要读回宿主的 ocr.json（否则「认过一次」只在当次会话有效）', () => {
    // 没有这一条，关掉书再打开，111 页又变回「没有文字层」—— 用户得再等 90 秒，
    // 而界面上没有任何东西解释为什么。
    assert.match(src, /fetchOcrPages/);
    assert.match(src, /const ocrIndex = await loadFindOcrIndex\(\);/);
    assert.match(src, /const remembered = ocrIndex\[current\];/);
    // 读回来的页必须**同时**写进索引与「来自识别」名单：只写索引的话，
    // 命中摘录会被当成书上真有的字，而它其实是识别结果（可能有错字）。
    assert.match(src, /findTexts\.current\.set\(current, text\);/);
    assert.match(src, /findOcrVia\.current\.add\(current\);/);
  });

  it('★ 扫描书要在用户输入之前就建索引（否则「要认字」永远晚一步）', () => {
    // 探测只是触发器，结论仍由整本索引给出。
    assert.match(src, /probePages\(numPages\)/);
    assert.match(src, /const indexOnly = needle === '' && findScanProbe === 'scanned';/);
    assert.match(src, /setFindScanProbe\(sawText \? 'text' : 'scanned'\)/);
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

/**
 * 整本都没有文字层（0.27.1）。
 *
 * 这一组的判据全部是**话**：一本 111 页全是图的 PDF，用户在搜索框里输入任何词
 * 都会得到「没有找到」——而那句话会把他推向「换个词再试」，那是一件永远不会
 * 成功的事。所以这里守的是：界面必须说「不是词的问题」，并把「认字」摆成
 * **主行动**，而不是列表底下一颗小按钮。
 */
describe('扫描书：0 命中不能说「换个词」', () => {
  const scannedProps = (over = {}) => props({
    query: '磨坊', hits: [], activeIndex: -1, status: 'done',
    scanned: true, progress: { done: 111, total: 111 },
    ocr: { running: false, done: 0, total: 111, note: '' }, onOcr: noop, ...over,
  });

  it('★ 0 命中时明说「不是这个词的问题」', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel, scannedProps()));
    assert.match(html, /不是这个词的问题/);
    assert.equal(html.includes('换一个更短或更常见的词'), false, '扫描书上建议换词 = 把人往死路上推');
  });

  it('★ 还没输入就说「整本 111 页都是图片」+ 主按钮（不等用户踩空）', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel,
      scannedProps({ query: '' })));
    assert.match(html, /没有文字层（扫描版）/);
    assert.match(html, /整本 111 页都是图片/);
    assert.match(html, /识别整本 111 页，之后就能搜/);
    // 「会记住」必须写出来：它真的记（识别结果落盘、下次索引读回来）。
    assert.match(html, /认完会存下来/);
    // 主行动要看得出来：`is-primary` 挂着的是**整块 + 按钮**。
    assert.match(html, /npr-find-ocr is-primary/);
  });

  it('反向对照：普通书（scanned=false）仍走「换一个更短的词」那条文案', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel,
      props({ query: '磨坊', hits: [], activeIndex: -1, status: 'done' })));
    assert.match(html, /换一个更短或更常见的词/);
    assert.equal(html.includes('不是这个词的问题'), false);
  });

  it('★ 部分扫描（有些页有字，另有 N 页没有）⇒ 两件事一起说', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel,
      props({
        query: '磨坊', hits: [], activeIndex: -1, status: 'done',
        progress: { done: 111, total: 111 },
        ocr: { running: false, done: 0, total: 40, note: '' }, onOcr: noop,
      })));
    // 说「能搜的那部分里没有」，再说清楚为什么 —— 只说前半句等于暗示「全书都没有」。
    assert.match(html, /能搜的那部分里没有它/);
    assert.match(html, /另有 40 页没有文字层/);
    assert.equal(html.includes('换一个更短或更常见的词'), false);
  });

  it('反向对照：普通书不给主按钮（那只是补几页，不是改这本书的可用性）', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel,
      props({ ocr: { running: false, done: 0, total: 40, note: '' }, onOcr: noop })));
    assert.equal(html.includes('is-primary'), false);
    assert.match(html, /识别这 40 页再搜一次/);
  });

  it('★ 索引是自己跑的（用户还没输入）时不许说「没有命中」', async () => {
    const { React, renderToStaticMarkup, BookFindPanel } = await loadPanel();
    const html = renderToStaticMarkup(React.createElement(BookFindPanel,
      scannedProps({ query: '', indexOnly: true })));
    assert.equal(html.includes('没有命中'), false, '一处都没找过就说「没有命中」是编结论');
    assert.match(html, /已扫过整本 111 页/);
  });
});

/**
 * 识别整本之后的重抽（0.28.0）。
 *
 * ★ 这一步存在的理由：识别文本 0.28.0 起会进分段，所以「认完整本」之后这本书
 *   **第一次**有了可分的正文。不自动做的话，用户看到的是「认出 111 页」，然后
 *   目录面板仍然是「这本书是扫描版」—— 中间那一步（去目录面板点「抽取目录」）
 *   没有任何人告诉他。这一步纯本地、不花钱，与「抽取目录」是同一件事。
 * ★ 风险同样在静默上：中途停下也重抽 ⇒ 一份缺章少页的目录被当成书的真实结构；
 *   每次都重抽 ⇒ 已生成的解读被标回「未解读」。
 */
describe('识别整本之后的自动重抽（0.28.0）', () => {
  const src = readFileSync(READER, 'utf8');

  it('★ 三个前提同时成立才触发（停下 / 一页没认出 / 本来就有文字层，都不许）', () => {
    const line = src.split('\n').find(item => item.includes('setOcrResegment(value => value + 1)'));
    assert.ok(line !== undefined, '没有触发重抽的信号');
    for (const guard of ['!stopped', 'recovered > 0', "findScanProbe === 'scanned'"]) {
      assert.ok(line.includes(guard), `缺少前提 ${guard}：${line.trim()}`);
    }
  });

  it('★ 重抽只走 startDigest（不另写一条「只分段」的链路）', () => {
    // 另写一条的后果：抽取游标、扫描版标记、书架那一行状态三处会各说各话。
    assert.match(src, /\n    void startDigest\(\);\n/, '信号没有落到 startDigest 上');
    assert.match(src, /\}, \[ocrResegment, startDigest\]\);/);
    // 反向对照：`postDigestSegment` 在整个阅读器里只能出现一次（就是 startDigest 里那次）。
    assert.equal(count(src, 'postDigestSegment('), 1, '出现了第二条分段调用链路');
  });

  it('同一个信号不许跑两遍（startDigest 的引用一变，effect 就会重跑）', () => {
    assert.match(src, /ocrResegmentDone\.current === ocrResegment/);
    assert.match(src, /ocrResegmentDone\.current = ocrResegment/);
  });
});
