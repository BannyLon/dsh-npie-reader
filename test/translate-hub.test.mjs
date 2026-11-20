/**
 * 翻译助手任务台（`src/client/translate-hub.js`）的判据测试。
 *
 * 这一组测的不是「能不能跑」，而是四条**容易被顺手改坏**的判据：
 *   1. 停止之后条目**不许**消失（`stopped` 是用户要接着处理的状态）；
 *   2. 在跑的条目**不许**被移除（否则任务变成看不见也停不掉的孤儿）；
 *   3. 一拍请求失败**不许**清空（网络抖一下不等于任务没了）；
 *   4. 译完要自己退场 —— 但只有 `done`，`stopped` / `failed` 不退。
 *
 * 另有一组「接线」断言读源码文本：0.60.0 把整本翻译从工具条搬进了浮层，
 * 这些删除性的改动最容易在下一次重构里被无声地加回来。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  __resetForTests, adopt, dismiss, getEntries, start, stop, subscribe,
} from '../src/client/translate-hub.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'src', 'client');
const readClient = (name) => readFileSync(join(clientDir, name), 'utf8');

const BOOK = { id: 'book-a', title: 'Wuthering Heights' };

function snapshotOf(overrides = {}) {
  return {
    state: 'running', total: 4, translated: 0, failed: 0, percent: 0, eta: '', current: null, ...overrides,
  };
}

/** 一次请求 = 一条记录；`handler` 按 `{ action }` 决定回什么，抛 `Error` 即模拟网络失败。 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    let action = '';
    if (typeof init.body === 'string' && init.body !== '') {
      try { action = JSON.parse(init.body).action ?? ''; } catch { action = ''; }
    }
    calls.push({ path, action });
    const result = handler({ path, action });
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

/** 让被 mock 的定时器回调里那些 `await` 真正跑完。`setImmediate` 没被 mock，可以借道。 */
async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

let restoreFetch = null;
beforeEach(() => { restoreFetch = globalThis.fetch; __resetForTests(); });
afterEach(() => {
  __resetForTests();
  if (restoreFetch !== null) globalThis.fetch = restoreFetch;
  restoreFetch = null;
});

describe('开始 / 停止', () => {
  it('start 之后条目进表，状态是 running', async () => {
    stubFetch(({ action }) => snapshotOf({ state: action === 'stop' ? 'stopped' : 'running' }));
    await start(BOOK);
    const entries = getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].bookId, 'book-a');
    assert.equal(entries[0].title, 'Wuthering Heights');
    assert.equal(entries[0].job.state, 'running');
    assert.equal(entries[0].busy, false);
  });

  it('start 失败：条目留下，但带上错误，且不假装在跑', async () => {
    stubFetch(() => new Error('boom'));
    const job = await start(BOOK);
    assert.equal(job, null);
    const entry = getEntries()[0];
    assert.equal(entry.job, null);
    assert.equal(entry.busy, false);
    assert.match(entry.error, /boom/);
  });

  it('停止之后条目**不许**消失', async () => {
    stubFetch(({ action }) => snapshotOf({ state: action === 'stop' ? 'stopped' : 'running', translated: 2, percent: 0.5 }));
    await start(BOOK);
    await stop('book-a');
    const entries = getEntries();
    assert.equal(entries.length, 1, 'stopped 是用户要接着处理的状态，不能从表里抹掉');
    assert.equal(entries[0].job.state, 'stopped');
  });

  it('停止中：宿主还回 running 也不许把界面摇回去', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    // 宿主处理停止是两步的：收到请求时它还在收尾当前批次，所以仍回答 running。
    stubFetch(() => snapshotOf({ state: 'running', translated: 2, percent: 0.5 }));
    await start(BOOK);
    await stop('book-a');
    let entry = getEntries()[0];
    assert.equal(entry.stopping, true, '请求已受理但宿主还没收尾，界面该停在「正在停止」');
    t.mock.timers.tick(1_500);
    await flush();
    entry = getEntries()[0];
    assert.equal(entry.stopping, true, '一拍 running 不该把「继续」按钮摇回「正在翻译」');

    // 宿主终于收尾：这一刻才允许回到 stopped。
    stubFetch(() => snapshotOf({ state: 'stopped', translated: 2, percent: 0.5 }));
    t.mock.timers.tick(1_500);
    await flush();
    entry = getEntries()[0];
    assert.equal(entry.job.state, 'stopped');
    assert.equal(entry.stopping, false, '拿到非 running 的结论就该解除「正在停止」');
  });
});

describe('移除的边界', () => {
  it('在跑的书不许被移除（否则看不见也停不掉）', async () => {
    stubFetch(() => snapshotOf());
    await start(BOOK);
    assert.equal(dismiss('book-a'), false);
    assert.equal(getEntries().length, 1);
  });

  it('停下之后可以移除', async () => {
    stubFetch(({ action }) => snapshotOf({ state: action === 'stop' ? 'stopped' : 'running' }));
    await start(BOOK);
    await stop('book-a');
    assert.equal(dismiss('book-a'), true);
    assert.equal(getEntries().length, 0);
  });
});

describe('轮询', () => {
  it('一拍失败不清空：任务还在跑，条目必须留着', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let failing = false;
    stubFetch(() => (failing ? new Error('network') : snapshotOf({ translated: 1, percent: 0.25 })));
    await start(BOOK);
    failing = true;
    t.mock.timers.tick(1500);
    await flush();
    const entries = getEntries();
    assert.equal(entries.length, 1, '一次网络抖动不该把任务从界面上抹掉');
    assert.equal(entries[0].job.state, 'running');
    assert.equal(entries[0].job.translated, 1);
  });

  it('轮询把宿主的新快照写进来', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let round = 0;
    stubFetch(() => {
      round += 1;
      return snapshotOf({ translated: round, percent: round / 4 });
    });
    await start(BOOK);
    t.mock.timers.tick(1500);
    await flush();
    await flush();
    const entry = getEntries()[0];
    assert.ok(entry.job.translated >= 1, `期望拿到推进后的快照，实际 ${entry.job.translated}`);
  });

  it('快照没变就不通知（1.5 秒一次的重复渲染是白烧的）', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    stubFetch(() => snapshotOf({ translated: 1, percent: 0.25 }));
    await start(BOOK);
    await flush();
    let hits = 0;
    const off = subscribe(() => { hits += 1; });
    t.mock.timers.tick(1500);
    await flush();
    t.mock.timers.tick(1500);
    await flush();
    off();
    assert.equal(hits, 0, '两次轮询拿到的快照一样，不该触发订阅');
  });
});

describe('译完自动退场', () => {
  it('done 留一会儿再走，stopped 一直留在表里', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let state = 'running';
    stubFetch(({ action }) => {
      if (action === 'stop') state = 'stopped';
      return snapshotOf({ state, translated: state === 'done' ? 4 : 1, percent: state === 'done' ? 1 : 0.25 });
    });
    await start(BOOK);
    state = 'done';
    t.mock.timers.tick(1500);
    await flush();
    assert.equal(getEntries().length, 1, '刚译完要把「译完了」露一眼，不能立刻消失');
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(getEntries().length, 0, '留够了时间就该自己收走，别在角落里长住');
  });
});

describe('adopt：界面重载后自愈', () => {
  it('宿主还在跑就补登记', async () => {
    stubFetch(() => snapshotOf({ translated: 2, percent: 0.5 }));
    await adopt(BOOK);
    assert.equal(getEntries().length, 1);
    assert.equal(getEntries()[0].job.state, 'running');
  });

  it('idle / done 不登记（把一本早就译完的书拉回角标是噪音）', async () => {
    stubFetch(() => snapshotOf({ state: 'idle', translated: 0, percent: 0 }));
    await adopt(BOOK);
    assert.equal(getEntries().length, 0);
    stubFetch(() => snapshotOf({ state: 'done', translated: 4, percent: 1 }));
    await adopt({ id: 'book-b', title: 'B' });
    assert.equal(getEntries().length, 0);
  });

  it('已经在表里就不再问一次', async () => {
    const calls = stubFetch(() => snapshotOf());
    await start(BOOK);
    const before = calls.length;
    await adopt(BOOK);
    assert.equal(calls.length, before);
  });
});

describe('接线：整本翻译只在「澄境阅读助手」里（0.60.0）', () => {
  const ebook = readClient('BookEbook.jsx');
  const library = readClient('LibraryApp.jsx');
  const assistant = readClient('ReadingAssistant.jsx');

  it('阅读器不再直连预翻接口，也不再画正文进度条', () => {
    assert.ok(!ebook.includes('postEbookPrefetch'), '工具条那颗「整本」按钮必须真的搬走，不能只是隐藏');
    assert.ok(!ebook.includes('npr-ebook-job'), '正文顶部那条进度条必须真的删掉');
    assert.ok(ebook.includes('useTranslateJobs'), '阅读器只从任务台读 jobRunning，用于「翻完换译文」');
  });

  it('助手挂在 LibraryApp 上，入口在左栏顶部', () => {
    assert.ok(library.includes('<ReadingAssistantPanel'), '窗口必须挂在书架这一层，跨书跨页面才活着');
    assert.ok(library.includes('<ReadingAssistantTrigger'), '入口按钮在左栏工具栏里');
    assert.ok(library.includes('disabled={!onReadingTab}'), '只在「在读」页签可用，其它页签变灰');
    assert.ok(assistant.includes('useTranslateJobs'));
  });

  it('窗口里有列表、有进度、有「翻译全本」', () => {
    assert.ok(assistant.includes('npr-ra-window'), '窗口形态（不是阅读页里的浮层）');
    assert.ok(assistant.includes('npr-ra-row'), '一本书一行');
    assert.ok(assistant.includes('翻译全本'), '每行后面那颗按钮');
    assert.ok(!assistant.includes('npr-tx-'), '第一版的右下角浮层必须删干净，不能两套并存');
  });
});

describe('0.61.0：封面 + 每本百分比/剩余 + 多本并行 + 只列英文书', () => {
  const assistant = readClient('ReadingAssistant.jsx');
  const readSrc = (rel) => readFileSync(join(here, '..', rel), 'utf8');
  const css = readSrc('src/client/refinements.css');
  const host = readSrc('src/host/ebook/prefetch.js');

  it('★ 每行有封面（复用书架那颗 BookCover，不另画一个）', () => {
    assert.ok(/import \{ BookCover \} from '\.\/BookCover\.jsx'/.test(assistant), '封面必须复用书架的组件，同一本书两处才长得一样');
    assert.ok(assistant.includes('npr-ra-cover'));
    assert.ok(css.includes('.npr-ra-cover'), '封面列要有自己的宽度，不能让封面撑满窗口');
  });

  it('★ 每行写「正在翻译 · 17% · 还剩约 …」：百分比与 ETA 都来自宿主快照', () => {
    assert.ok(assistant.includes('正在翻译 · '), '文案形状照参考实现（正在做什么 · 百分之几 · 还剩多久）');
    assert.ok(assistant.includes('job.eta'), '剩余时间用宿主算好的那句话，不在客户端自己估');
    assert.ok(assistant.includes('percentOf(job)'), '百分比同样来自快照');
  });

  it('★ 只列需要翻译的电子书：没有可翻节、或正文是中文的都不进列表', () => {
    assert.ok(assistant.includes("=== 0) continue"), '一节可翻的都没有（整本代码 / 图片）也要剔掉');
    assert.ok(assistant.includes('中文书不占这一屏'), '剔掉之后要说明「为什么这里没有它们」');
  });

  it('★ 多本并行：界面不再互相禁用，也不再写「同一时刻只翻一本」', () => {
    // ★ 只剥掉块注释再断言：文件头**要**留着「这条规定已被推翻」的来历，
    //   否则下一个人只看到删除痕迹、不知道当初为什么有它。要看的是**渲染出来的字**。
    const code = assistant.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!code.includes('同一时刻只翻一本'), '这条说明跟着 0.59.0 的规定一起作废');
    assert.ok(!code.includes('blockedBy'), '别的书在跑时不再禁用这一本');
    assert.ok(code.includes('全部停止'), '同时跑多本时，一颗「停止」按不住');
  });

  it('★ 宿主侧：多本并行有上限，超了明确报错（不偷偷排队）', () => {
    assert.ok(host.includes('DEFAULT_MAX_CONCURRENT'), '上限是一个具名常量，不是散落的魔法数');
    assert.ok(!host.includes('runningBookId'), '「任一本 running 就拒绝新的」这条判据必须真的删掉');
    assert.ok(host.includes('error.limit = limit'), '报错要带上限，界面才能说清「最多几本」');
  });
});

/**
 * 0.62.0：语种判据从「有几节可翻」改成「整本正文的汉字占比」。
 *
 * 用户原话（附截图）：「《译文名著文库》076…、《译文名著文库》103…、KuaYueHongGou
 * 这三本都是中文。不需要翻译的啊。你判断写的不对；……你要判断这本书如果是中文书籍，
 * 那么对照页是灰掉的不可用。」
 *
 * 这一组的核心是一条**回归**：0.61.0 用 `total === 0` 反推语种，而中文段落里夹一串
 * 英文人名会让那一段被判成「该翻」，纯中文书因此有几节可翻 —— 三本书就这么混了进来。
 */
describe('0.62.0：语种按整本正文判，不看「有几节可翻」', () => {
  const readSrc = (rel) => readFileSync(join(here, '..', rel), 'utf8');
  const assistant = readClient('ReadingAssistant.jsx');
  const ebook = readClient('BookEbook.jsx');
  const host = readSrc('src/host/ebook/prefetch.js');
  const routes = readSrc('src/host/library-routes.js');

  /** 造一本「正文按给定比例混排」的书 —— 只喂 `bookScript`，不经过解析。 */
  const bookOf = (zhCount, enCount) => ({
    sections: [{
      blocks: [
        { k: 'p', x: '汉'.repeat(zhCount) },
        { k: 'p', x: 'a'.repeat(enCount) },
      ],
    }],
  });

  it('★ 中文段落里夹英文人名，整本仍然是中文书（0.61.0 的回归）', async () => {
    const { bookScript } = await import('../src/ebook-translate.js');
    // 一节 300 个汉字 + 一串英文人名/术语 —— 逐块判就是在这里出错的。
    const result = bookScript(bookOf(300, 90));
    assert.equal(result.script, 'zh', '整本 0.77：汉字占多数就是中文书，几个混排段落翻不了案');
    assert.ok(result.ratio > 0.7 && result.ratio < 0.8);
  });

  it('★ 英文书里夹中文脚注，仍然是外文书（不误伤）', async () => {
    const { bookScript } = await import('../src/ebook-translate.js');
    assert.equal(bookScript(bookOf(40, 960)).script, 'latin', '4% 的汉字不足以说它是中文书');
  });

  it('★ 中英双语排版（一段英文一段中文）不判成中文书', async () => {
    const { bookScript } = await import('../src/ebook-translate.js');
    // 这种书恰恰**最需要**对照，判成中文会把按钮灰掉，等于把功能关在门外。
    assert.equal(bookScript(bookOf(500, 500)).script, 'latin', '约 0.5 是双语版，不是中文书');
  });

  it('★ 字母太少不表态（一本只有封面的书不该被说成中文）', async () => {
    const { bookScript } = await import('../src/ebook-translate.js');
    const result = bookScript({ sections: [{ blocks: [{ k: 'p', x: '版权信息' }] }] });
    assert.equal(result.script, 'unknown');
    assert.equal(bookScript({ sections: [] }).script, 'unknown', '空书同样是 unknown，不是 zh');
  });

  it('★ 宿主：中文书在 start 这一层就拒掉，不只是界面上不列', () => {
    assert.ok(host.includes('EBOOK_PREFETCH_CHINESE'), '要有一个可被界面识别的错误码');
    assert.ok(host.includes("plan.script === 'zh'"), '判据是整本语种，不是 total');
    assert.ok(host.includes('error.code'), '错误要带 code，客户端才能不把它当网络故障');
  });

  it('★ 助手：按 script 剔掉中文书，探测失败仍保留', () => {
    assert.ok(assistant.includes("status.script === 'zh'"), '过滤判据换成整本语种');
    assert.ok(assistant.includes('chinese'), '被剔掉的要计数，空态才能说「在读的 N 本都是中文」');
    // ★ `total === 0` 那条**留着**：它说的是「整本都是代码 / 图片」，是另一个问题。
    //   两条判据并存才对 —— 这里防的是下一个人以为「有了 script 就把旧的删了」。
    assert.ok(assistant.includes('=== 0) continue'), '「一节可翻的都没有」这条判据要保留，它与语种不同义');
  });

  it('★ 阅读器：中文书的「对照」按钮要灰掉', () => {
    assert.ok(ebook.includes("index?.script === 'zh'"), '阅读器的判据来自宿主的目录响应');
    assert.ok(ebook.includes('disabled={chineseBook}'), '灰掉，而不是点了再说「这一节不需要对照」');
    assert.ok(ebook.includes('这本书的正文是中文，不需要中英对照'), '灰按钮要有一句话说得清为什么');
  });

  it('★ 目录响应把 script 带出去（阅读器拿不到正文，只能靠它）', () => {
    assert.ok(routes.includes('script: ebook.script'), '/book/:id/ebook 的响应里必须有 script');
  });
});
