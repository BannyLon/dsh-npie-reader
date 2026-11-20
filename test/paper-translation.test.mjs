/**
 * 逐页按需 + 整本一次翻完：同一份缓存、同一条链路（0.71.0）。
 *
 * 这里用假的 pdf.js 页与假的 HTTP 真跑一遍客户端模块，重点钉住四条会「静默花钱」
 * 的行为：重复翻同一页、重开插件后又翻一遍、分段规则变了还用旧译文、整本模式
 * 把逐页已经翻过的页再翻一遍。任何一条漏了，界面上都看不出错，只会多调模型。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  __resetPaperTranslationForTests, cancelPageTranslation, dismissWholeBookJob,
  ensurePageTranslation, estimateWholeBook, formatDuration, hasPageTranslation,
  loadBookTranslations, pageTaskSnapshot, PAGE_PARAGRAPH_LIMIT, startWholeBookTranslation,
  stopWholeBookTranslation, translatedPageCount, WHOLE_BOOK_MAX_PAGES, wholeBookJob,
} from '../src/client/paper-translation.js';

/** 每本书一份「磁盘」；HTTP 桩只认这几个路径。 */
function fakeHttp(initial = {}) {
  const disk = new Map(Object.entries(initial));
  const modelCalls = [];
  const gates = new Map();
  let writeFails = false;
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const body = init.body === undefined ? {} : JSON.parse(init.body);
    const reply = (payload) => ({ ok: true, json: async () => payload });
    if (path.endsWith('/page-translation/paper-1') && (init.method ?? 'GET') === 'GET') {
      return reply({ ok: true, pages: Object.fromEntries(disk) });
    }
    if (path.endsWith('/page-translation/paper-1') && init.method === 'POST') {
      if (body.op === 'put') {
        // 真实宿主里这一步会 400（段落 id 被旧校验全丢）或 500（磁盘）。
        if (writeFails) throw new Error('这一页没有段落');
        disk.set(String(body.page), { paragraphs: body.paragraphs, translations: body.translations });
      }
      if (body.op === 'clear') {
        if (writeFails) throw new Error('缓存文件删不掉');
        const removed = disk.size; disk.clear(); return reply({ ok: true, removed });
      }
      return reply({ ok: true, page: body.page });
    }
    if (path.endsWith('/translate-page')) {
      modelCalls.push(body.paragraphs.map(item => item.id));
      const gate = gates.get(body.paragraphs[0]?.id ?? '');
      if (gate !== undefined) await gate;
      return reply({ ok: true, translations: body.paragraphs.map(item => ({ id: item.id, text: `译文 ${item.id}` })) });
    }
    return reply({ ok: false, error: `没想到的路径 ${path}` });
  };
  return {
    disk,
    modelCalls,
    gate: (id, promise) => gates.set(id, promise),
    failWrites: (value = true) => { writeFails = value; },
    restore: () => { globalThis.fetch = previous; },
  };
}

/** 一页两个段落；`tag` 用来模拟分段 / 原文变化。
 *  `slowMs`：给取字加一点真实耗时 —— 假 fetch 是瞬时的，三页能在 1ms 内跑完，
 *  实测速率 `Math.round(elapsed / done)` 就会舍入成 0，测「有没有算出速率」的
 *  守卫会**偶发**变红（全量并行时压力不同，单跑又绿）。 */
function fakeDoc(pageCount = 3, tag = '', { slowMs = 0 } = {}) {
  return {
    numPages: pageCount,
    getPage: async (page) => ({
      getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, 1, 0, 0] }),
      getTextContent: async () => {
        if (slowMs > 0) await new Promise(resolve => setTimeout(resolve, slowMs));
        return {
          styles: {},
          items: [
            { str: `Attention is all you need.${tag}`, fontName: 'f1', width: 180, height: 12, transform: [12, 0, 0, 12, 40, 80] },
            { str: 'The transformer is simple.', fontName: 'f1', width: 180, height: 12, transform: [12, 0, 0, 12, 40, 110] },
          ],
        };
      },
    }),
    // 假的 PDFDocumentProxy 不需要别的方法；整本模式只调 getPage。
    _page: pageCount,
  };
}

const pdfPageOf = async (doc, page = 1) => await doc.getPage(page);

async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等待任务状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('逐页按需：缓存、落盘、去重', () => {
  it('同一页只调一次模型，译文落到磁盘', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDoc();
      const first = await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      assert.equal(first.cached, false);
      assert.equal(first.translations.get('0:text:0'), '译文 0:text:0');
      assert.equal(http.modelCalls.length, 1);
      assert.equal(http.disk.has('1'), true);
      const second = await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      assert.equal(second.cached, true);
      assert.equal(http.modelCalls.length, 1, '内存缓存没命中，重复计费了');
      assert.equal(hasPageTranslation('paper-1', 1), true);
      assert.equal(translatedPageCount('paper-1'), 1);
    } finally { http.restore(); }
  });

  it('★ 写盘失败必须能传回调用方（persisted=false），不许哑失败', async () => {
    // 0.71.0–0.71.2 的形态：宿主对每一页都回 400（段落 id 带冒号被落盘校验全丢），
    // 客户端 `void enqueueWrite(...)` + 空 catch 把它咽了。结果是「界面有中文、
    // 磁盘一个文件都没有、每次重开都重翻」，而用户无从判断是缓存问题。
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    http.failWrites(true);
    try {
      const doc = fakeDoc();
      const result = await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      assert.equal(result.translations.size > 0, true, '译文自己没拿到，测的不是写盘这一层');
      assert.equal(result.persisted, false, '写盘失败了却报成功');
      assert.equal(http.disk.has('1'), false);
      // 软失败的另一半：这一页在**本次会话**里照样是中文，不该因为存不下就报错。
      const again = await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      assert.equal(again.cached, true);
      assert.equal(http.modelCalls.length, 1);
    } finally { http.restore(); }
  });

  it('重开插件（清空模块内存、保留磁盘）⇒ 直接读缓存，零模型调用', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDoc();
      await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      // 等写盘队列跑完（写是 fire-and-forget 的软失败路径）。
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(http.disk.has('1'), true);
      __resetPaperTranslationForTests();
      const after = await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      assert.equal(after.cached, true);
      assert.equal(http.modelCalls.length, 1, '重开后又调了一次模型');
      assert.equal(translatedPageCount('paper-1'), 1);
    } finally { http.restore(); }
  });

  it('原文 / 分段变了 ⇒ 这一页作废重翻，不拿旧译文盖错框', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const before = await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(fakeDoc()), page: 1 });
      assert.equal(before.cached, false);
      const changed = await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(fakeDoc(3, ' Second edition.')), page: 1 });
      assert.equal(changed.cached, false);
      assert.equal(http.modelCalls.length, 2);
    } finally { http.restore(); }
  });

  it('同页并行的两次请求合并成一次模型调用', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDoc();
      const pdfPage = await pdfPageOf(doc);
      const [a, b] = await Promise.all([
        ensurePageTranslation({ bookId: 'paper-1', pdfPage, page: 1 }),
        ensurePageTranslation({ bookId: 'paper-1', pdfPage, page: 1 }),
      ]);
      assert.equal(a.cached, false);
      assert.equal(b.cached, false);
      assert.equal(http.modelCalls.length, 1);
    } finally { http.restore(); }
  });
});

describe('整本一次翻完：跳过已译、可停、可清', () => {
  it('逐页已翻过的页整本模式直接跳过，其余逐页翻完', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDoc(3);
      await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc, 2), page: 2 });
      startWholeBookTranslation({ bookId: 'paper-1', doc, numPages: 3 });
      await waitFor(() => wholeBookJob('paper-1').state !== 'running');
      const job = wholeBookJob('paper-1');
      assert.equal(job.state, 'done', `任务没正常结束：${JSON.stringify(job)}`);
      assert.equal(job.done, 3);
      assert.equal(job.skipped, 1);
      // 一共 3 次模型调用：先逐页翻第 2 页 1 次，整本再翻第 1、3 页各 1 次。
      // ★ 按段落 id 去重看：每段所属页只出现一次，第 2 页不能出现第二次。
      assert.equal(http.modelCalls.length, 3);
      const pages = http.modelCalls.map(ids => ids[0].split(':')[0]);
      assert.deepEqual([...new Set(pages)].sort(), ['0', '1', '2']);
      assert.equal(pages.length, new Set(pages).size, '某一页被翻译了两次');
      assert.equal(translatedPageCount('paper-1'), 3);
      assert.equal(wholeBookJob('paper-1').total, 3);
    } finally { http.restore(); }
  });

  it('★ 超过单次上限：快照标 capped，文案不说「整本完成」（0.84.7）', async () => {
    // 这本书 2345 页，上限 2000。旧行为：跑完 2000 页后弹「整本翻译完成」，
    // 用户以为剩下 345 页也译了。现在必须把「只翻了前 N 页」标出来。
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      startWholeBookTranslation({ bookId: 'big', doc: fakeDoc(1), numPages: 2345, notify: () => {} });
      // startWholeBookTranslation 里的 setJob 是**同步**的，IIFE 还没跑起来，先读快照
      const job = wholeBookJob('big');
      assert.equal(job.total, WHOLE_BOOK_MAX_PAGES, '这次只跑上限页数');
      assert.equal(job.pages, 2345, '真实页数必须留着，否则界面不知道还剩多少');
      assert.equal(job.capped, true, '截断必须标记，否则界面会写「整本」');
      // 别真跑 2000 页：立刻停掉并等它落到终态，别漏给下一个用例
      assert.equal(stopWholeBookTranslation('big'), true);
      await waitFor(() => wholeBookJob('big').state !== 'running');
      // 文案侧：行为测试抓不到「notify 里写死整本完成」，用源码判据补一刀
      const source = readFileSync(new URL('../src/client/paper-translation.js', import.meta.url), 'utf8');
      assert.match(source, /已翻完前 \$\{total\} 页/, 'notify 缺少截断文案');
      assert.match(source, /const capped = requested > total/, '没有记录是否被截断');
    } finally { http.restore(); }
  });

  it('单飞：已经在跑时再点一次不会开第二个任务', async () => {
    __resetPaperTranslationForTests();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const http = fakeHttp();
    http.gate('0:text:0', gate);
    try {
      const doc = fakeDoc(4);
      startWholeBookTranslation({ bookId: 'paper-1', doc, numPages: 4 });
      await waitFor(() => http.modelCalls.length === 1);
      startWholeBookTranslation({ bookId: 'paper-1', doc, numPages: 4 });
      assert.equal(wholeBookJob('paper-1').state, 'running');
      await waitFor(() => stopWholeBookTranslation('paper-1') === true);
      release();
      await waitFor(() => wholeBookJob('paper-1').state === 'stopped');
      assert.equal(wholeBookJob('paper-1').done >= 1, true);
      assert.equal(stopWholeBookTranslation('paper-1'), false, '没在跑时应该返回 false');
    } finally { http.restore(); }
  });

  it('清除译文：磁盘、内存索引、任务状态一起归零', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDoc(2);
      await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(http.disk.size, 1);
      const { clearWholeBookTranslations } = await import('../src/client/paper-translation.js');
      await clearWholeBookTranslations('paper-1');
      assert.equal(http.disk.size, 0);
      assert.equal(hasPageTranslation('paper-1', 1), false);
      assert.equal(translatedPageCount('paper-1'), 0);
      assert.equal(wholeBookJob('paper-1').state, 'idle');
      await loadBookTranslations('paper-1');
      assert.equal(translatedPageCount('paper-1'), 0, '清完又从磁盘读回来了');
    } finally { http.restore(); }
  });

  it('★ 清不掉时不许报「已清空」：内存不动、返回 false', async () => {
    // 与「写盘失败」同一类缺陷：删不掉却回一句成功，界面当场变回英文，
    // 下次打开又读回旧译文 —— 用户看到的是「清了又回来」。
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDoc();
      await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      assert.equal(hasPageTranslation('paper-1', 1), true);
      http.failWrites(true);
      const { clearWholeBookTranslations } = await import('../src/client/paper-translation.js');
      const cleared = await clearWholeBookTranslations('paper-1');
      assert.equal(cleared, false, '删不掉却报成功');
      assert.equal(hasPageTranslation('paper-1', 1), true, '内存被清了 —— 界面会假装清掉，重开又回来');
      assert.equal(http.disk.size, 1);
    } finally { http.restore(); }
  });

  it('书还没打开（numPages=0）时不建任务，并给一句人话提示', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    let message = '';
    try {
      startWholeBookTranslation({ bookId: 'paper-1', doc: fakeDoc(0), numPages: 0, notify: text => { message = text; } });
      assert.equal(wholeBookJob('paper-1').state, 'idle');
      assert.match(message, /还没打开/);
      assert.equal(http.modelCalls.length, 0);
    } finally { http.restore(); }
  });
});

/**
 * 0.78.0：「翻译这一页」要能灰掉、要能看到进度、整本失败后要能收起来。
 *
 * ★ 这一组钉的是**用户报过的三个现象**，不是内部实现：
 *   ① 点了「翻译这一页」，按钮还是亮的、再点也没反应（任务态根本没共享）；
 *   ② 「正在翻译这一页…」只有一句字，没有任何「它在动」的证据；
 *   ③ 整本失败后那条红字没有按钮，永久贴在书页上。
 * ★ 每条都配反向对照：把实现改回去必须变红。
 */

/** 一页 `count` 段的一页 PDF：`count` 用来制造「超过宿主 40 段上限」的页。 */
function fakeDenseDoc(count, pageCount = 1) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      str: `Attention is all you need and the transformer is simple enough for a benchmark number ${i}.`,
      fontName: 'f1', width: 480, height: 10, transform: [10, 0, 0, 10, 40, 80 + i * 24],
    });
  }
  return {
    numPages: pageCount,
    getPage: async () => ({
      getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, 1, 0, 0] }),
      getTextContent: async () => ({ styles: {}, items }),
    }),
  };
}

describe('段落超过宿主上限时自动分批（2026-11-13 那次失败的根因）', () => {
  it('★ 60 段 ⇒ 分两批、每批不超过 40 段，且译文全量合并', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDenseDoc(60);
      const result = await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      assert.equal(http.modelCalls.length, 2, '没有分批 —— 宿主会整页回 400（截图里那句「paragraphs 要是 1–40 条的数组」）');
      for (const batch of http.modelCalls) {
        assert.ok(batch.length <= PAGE_PARAGRAPH_LIMIT, `有一批 ${batch.length} 段，超过宿主上限`);
      }
      assert.equal(http.modelCalls[0].length + http.modelCalls[1].length, 60, '两批加起来不是 60 段：有段落被丢了');
      assert.equal(result.translations.size, 60, '分批之后译文没合并全，后半页会留在英文');
    } finally { http.restore(); }
  });

  it('反向对照：40 段以内**仍然只发一次**（分批不能变成常态）', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDenseDoc(12);
      await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      assert.equal(http.modelCalls.length, 1, '常规页被拆成了多批 —— 同一页的术语会前后不一致，还多花请求');
    } finally { http.restore(); }
  });
});

describe('单页翻译的任务态（供按钮灰掉与进度条使用）', () => {
  it('★ 翻译中 running，完成后回 idle；失败也要回 idle', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    const key = 'paper-1:1';
    try {
      const doc = fakeDenseDoc(12);
      assert.equal(pageTaskSnapshot(key).state, 'idle', '没开始就被判成在跑');

      let release;
      http.gate('0:text:0', new Promise((resolve) => { release = resolve; }));
      const pending = ensurePageTranslation({ bookId: 'paper-1', pdfPage: await pdfPageOf(doc), page: 1 });
      // 先等到「模型那一步」：状态一进来就是 running（step=extract，取字是毫秒级），
      // 只等 running 会在 extract 那一瞬间通过，测不到阶段推进。
      await waitFor(() => pageTaskSnapshot(key).step === 'translate');
      assert.equal(pageTaskSnapshot(key).state, 'running', '在翻的时候不是 running ⇒ 按钮不会灰');
      assert.ok(pageTaskSnapshot(key).startedAt > 0, '没有开始时间 ⇒ 秒数读不出来');

      release();
      await pending;
      assert.equal(pageTaskSnapshot(key).state, 'idle', '完成之后还挂着 running ⇒ 按钮永远灰着');
    } finally { http.restore(); }
  });

  it('★ 失败后必须回 idle（否则一次网络抖动把这一页锁死）', async () => {
    __resetPaperTranslationForTests();
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith('/page-translation/paper-1')) return { ok: true, json: async () => ({ ok: true, pages: {} }) };
      if (path.endsWith('/translate-page')) throw new Error('模型 502');
      return { ok: true, json: async () => ({ ok: true }) };
    };
    try {
      const doc = fakeDenseDoc(6);
      await assert.rejects(async () => {
        await ensurePageTranslation({ bookId: 'paper-1', pdfPage: await doc.getPage(1), page: 1 });
      });
      assert.equal(pageTaskSnapshot('paper-1:1').state, 'idle', '失败之后任务态没清 ⇒ 「翻译这一页」永远灰着');
    } finally { globalThis.fetch = previous; }
  });
});

describe('整本翻译：时长估算与「收起」', () => {
  it('★ 没跑过的书给区间估算，跑过的书用实测并标出来', () => {
    const guess = estimateWholeBook({ total: 37, cached: 1 });
    assert.equal(guess.pages, 36, '本次要翻的页数没减掉已有译文');
    assert.equal(guess.measured, false);
    assert.ok(guess.minMs < guess.maxMs, '区间退化成单点 —— 一个数字会被当成承诺');

    const measured = estimateWholeBook({ total: 37, cached: 1, msPerPage: 20_000 });
    assert.equal(measured.measured, true);
    assert.equal(measured.minMs, Math.round(20_000 * 36 * 0.8));

    // 反向对照：全译完时不能还报一个时长（那会让人以为还要等）。
    assert.equal(estimateWholeBook({ total: 10, cached: 10 }).pages, 0);
    assert.equal(formatDuration(0), '不到 1 分钟');
  });

  it('★ 失败之后能收起；收起保留已译页数与实测速率，且不删缓存', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDoc(3, '', { slowMs: 8 });
      startWholeBookTranslation({ bookId: 'paper-1', doc, numPages: 3, notify: () => {} });
      await waitFor(() => ['done', 'failed', 'stopped'].includes(wholeBookJob('paper-1').state));
      const before = wholeBookJob('paper-1');
      assert.ok(before.msPerPage > 0, '三页都新翻却没算出实测速率：ETA 永远是猜的');

      assert.equal(dismissWholeBookJob('paper-1'), true);
      const after = wholeBookJob('paper-1');
      assert.equal(after.state, 'idle', '收起之后进度胶囊还会挂着 —— 用户报的就是这条红字一直在');
      assert.equal(after.done, before.done, '收起把「已译 N 页」也清了');
      assert.equal(after.msPerPage, before.msPerPage, '收起丢了实测速率，下次估算又退回猜');
      assert.equal(translatedPageCount('paper-1'), 3, '收起把译文缓存也删了');
    } finally { http.restore(); }
  });

  it('反向对照：正在跑的时候不许收起（那会变成「界面停了，后台还在烧模型」）', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDoc(3);
      let release;
      http.gate('0:text:0', new Promise((resolve) => { release = resolve; }));
      startWholeBookTranslation({ bookId: 'paper-1', doc, numPages: 3, notify: () => {} });
      await waitFor(() => wholeBookJob('paper-1').state === 'running');
      assert.equal(dismissWholeBookJob('paper-1'), false, '跑着的时候被收起了');
      assert.equal(wholeBookJob('paper-1').state, 'running');
      stopWholeBookTranslation('paper-1');
      release();
      await waitFor(() => wholeBookJob('paper-1').state === 'stopped');
    } finally { http.restore(); }
  });
});

/**
 * 0.78.0 第二批：能停、能看见前半页、不会为了等两批而干等。
 *
 * ★ 用户实测截图：「正在翻译这一页 · 第 1/2 批 · 168 秒」。两批**串行**时前
 *   80 秒屏幕上一个字都不变，看上去像卡死；而且中途没有任何办法脱身。
 * ★ 这三条各自能坏得很安静：暂停不掐请求 ⇒ 界面停了、模型继续烧钱；
 *   分批变回串行 ⇒ 只是慢，功能完全正常；onPartial 不调 ⇒ 半页中文要等全量。
 */

/** 一个「模型还在生成」的 fetch：只有 abort 才会结束。 */
function stallingFetch({ hang = true } = {}) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/page-translation/paper-1')) {
      return { ok: true, json: async () => ({ ok: true, pages: {} }) };
    }
    if (path.endsWith('/translate-page')) {
      const body = JSON.parse(init.body ?? '{}');
      calls.push({ paragraphs: body.paragraphs, signal: init.signal });
      if (!hang) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            translations: body.paragraphs.map(item => ({ id: item.id, text: `译文 ${item.id}` })),
          }),
        };
      }
      return await new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

/** 给一个 Promise 加死线：守卫变坏时宁可 2 秒见红，也不要整个测试挂死。 */
function withDeadline(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/**
 * 第一批直接 500，第二批挂住等 abort。
 * ★ 顺序靠**调用序号**而不是内容：两个 worker 是同一条循环起的，谁先发出并不保证，
 *   但「先发的那个失败、后发的那个挂住」正好能测「失败会不会连累兄弟批」。
 */
function failingFetch() {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/page-translation/paper-1')) {
      return { ok: true, json: async () => ({ ok: true, pages: {} }) };
    }
    if (path.endsWith('/translate-page')) {
      const body = JSON.parse(init.body ?? '{}');
      const index = calls.length;
      calls.push({ paragraphs: body.paragraphs, signal: init.signal });
      if (index === 0) throw new Error('模型这会儿不可用');
      return await new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

/** 第一批立刻回、第二批挂住：用来测「半页回来之后用户按暂停」。 */
function halfFetch() {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/page-translation/paper-1')) {
      return { ok: true, json: async () => ({ ok: true, pages: {} }) };
    }
    if (path.endsWith('/translate-page')) {
      const body = JSON.parse(init.body ?? '{}');
      const index = calls.length;
      calls.push({ paragraphs: body.paragraphs, signal: init.signal });
      if (index === 0) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            translations: body.paragraphs.map(item => ({ id: item.id, text: `译文 ${item.id}` })),
          }),
        };
      }
      return await new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

describe('单页翻译可以暂停（真的掐断请求）', () => {
  it('★ 暂停 ⇒ 请求被 abort、Promise 以 PAUSED 结束、任务态回 idle', async () => {
    __resetPaperTranslationForTests();
    const http = stallingFetch();
    try {
      const doc = fakeDenseDoc(6);
      const pending = ensurePageTranslation({ bookId: 'paper-1', pdfPage: await doc.getPage(1), page: 1 });
      await waitFor(() => http.calls.length === 1);
      assert.equal(http.calls[0].signal.aborted, false, '一上来就被 abort 了');

      const key = 'paper-1:1';
      assert.equal(cancelPageTranslation(key), true, '暂停没有找到在飞的请求（等于只关了界面）');
      await assert.rejects(pending, (error) => error?.code === 'PAUSED', '暂停后的错误没有标成 PAUSED，界面会报成红字失败');
      assert.equal(http.calls[0].signal.aborted, true, '底层 fetch 的 signal 没有 abort —— 模型会继续跑到 3 分钟超时');
      assert.equal(pageTaskSnapshot(key).state, 'idle', '暂停后任务态没清，这一页永远灰着');
    } finally { http.restore(); }
  });

  it('反向对照：没在翻的时候暂停返回 false（不能凭空造一个「已暂停」）', () => {
    __resetPaperTranslationForTests();
    assert.equal(cancelPageTranslation('paper-1:99'), false);
  });
});

describe('分批并发 + 渐进回填（一页 168 秒的解法）', () => {
  it('★ 60 段的两批**同时在飞**，不是一批等一批', async () => {
    __resetPaperTranslationForTests();
    const http = stallingFetch();
    try {
      const doc = fakeDenseDoc(60);
      const pending = ensurePageTranslation({ bookId: 'paper-1', pdfPage: await doc.getPage(1), page: 1 });
      await waitFor(() => http.calls.length === 2);
      // 两批都还没返回（都是 hang 住的 Promise），说明它们确实是并发的。
      assert.equal(http.calls.length, 2, '只发出了第二批的第一个请求 —— 串行会多等一整个批次');
      cancelPageTranslation('paper-1:1');
      await pending.catch(() => {});
    } finally { http.restore(); }
  });

  it('★ 每回来一批就回调一次，界面能先铺半页', async () => {
    __resetPaperTranslationForTests();
    const http = fakeHttp();
    try {
      const doc = fakeDenseDoc(60);
      const seen = [];
      await ensurePageTranslation({
        bookId: 'paper-1', pdfPage: await doc.getPage(1), page: 1,
        onPartial: ({ translations }) => seen.push(translations.size),
      });
      assert.ok(seen.length >= 1, 'onPartial 一次都没调 —— 用户要一直等到两批全回才看到一个字');
      assert.equal(seen[seen.length - 1], 60, '最后一批回填时不是全部 60 段');
      // 反向对照：中间那几次必须**小于**全量，否则「渐进」是假的。
      assert.ok(seen[0] < 60, '第一次回调就是 60 段 —— 说明还是等全量才铺');
    } finally { http.restore(); }
  });

  it('★ 一批失败要把兄弟批掐掉（不能让它在后台继续跑满一分钟）', async () => {
    __resetPaperTranslationForTests();
    const http = failingFetch();
    try {
      const doc = fakeDenseDoc(60);
      const pending = ensurePageTranslation({ bookId: 'paper-1', pdfPage: await doc.getPage(1), page: 1 });
      // ★ 先挂上处理器再等：这一条会在 `waitFor` 期间就失败，
      //   那一刻还没人 await 它 ⇒ node:test 会把它记成 unhandledRejection。
      const settled = pending.then(value => ({ value }), error => ({ error }));
      // 第一批发出去就 500；第二批发出去后挂住，靠「被 abort」才能结束。
      await waitFor(() => http.calls.length === 2);
      const { error } = await withDeadline(settled, 2000,
        '兄弟批没被掐断 —— 整页翻译永远等不到结束（界面就是一直转圈）');
      assert.match(String(error?.message ?? ''), /模型这会儿不可用/, '真实错误被吞掉了，界面只会看到「已暂停」');
      const hanging = http.calls[1];
      assert.equal(hanging.signal.aborted, true,
        '兄弟批没有被掐断 —— 界面已经报错了，模型那边还在跑，钱照付');
      // 反向对照：失败的那一批自己是正常返回的 500，不该被记成 abort。
      assert.equal(http.calls[0].signal.aborted, false);
    } finally { http.restore(); }
  });

  it('★ 暂停落在两批之间：不许把半页当成「整页成功」交上去', async () => {
    __resetPaperTranslationForTests();
    const http = halfFetch();
    try {
      const doc = fakeDenseDoc(60);
      const seen = [];
      const pending = ensurePageTranslation({
        bookId: 'paper-1', pdfPage: await doc.getPage(1), page: 1,
        onPartial: ({ translations }) => seen.push(translations.size),
      });
      // 第一批已经回来并且铺上去了；第二批还挂着。这时候用户按暂停。
      await waitFor(() => seen.length >= 1);
      cancelPageTranslation('paper-1:1');
      await assert.rejects(pending, (error) => error?.code === 'PAUSED',
        '半页被当成成功交上去了 —— 一页会存成「只有前半段是中文」的译文');
    } finally { http.restore(); }
  });

  it('★ 暂停早于发请求：也要报「已暂停」，不能报成「模型没返回译文」', async () => {
    __resetPaperTranslationForTests();
    const http = stallingFetch({ hang: false });
    try {
      const doc = fakeDenseDoc(60);
      const pending = ensurePageTranslation({ bookId: 'paper-1', pdfPage: await doc.getPage(1), page: 1 });
      const settled = pending.then(value => ({ value }), error => ({ error }));
      // ★ 不等任何一批：进函数就暂停。这时两个 worker 会在循环顶上直接 return，
      //   `collected` 是空的 —— 没有那条 `signal?.aborted` 兜底，这里会被当成
      //   「翻译成功但零段」，接着抛「模型没有返回对得上段落的译文」，
      //   用户按了暂停却看到一句像故障的红字。
      cancelPageTranslation('paper-1:1');
      const { error } = await settled;
      assert.equal(error?.code, 'PAUSED', '暂停被报成了翻译失败');
      assert.equal(http.calls.length, 0, '都暂停了还在往宿主发请求');
    } finally { http.restore(); }
  });
});
