/**
 * 解读的三条路由（`/digest/:id/pages|segment|status`）。
 *
 * ★ 这里用**真的** `createDigestStore`（临时目录）+ 假 req/res：这三条路由的价值
 *   全在「落盘 → 读回 → 分段 → 再落盘」这条链上，把 store 也换成假的就等于
 *   只测了字符串分派。而链上任何一环断了（比如 `segment` 没写 `outline.json`），
 *   界面上都是「点了没反应」。
 *
 * ★ 三条必须有的断言：信任栅栏（宿主派发插件路由不过鉴权）、bookId 校验
 *   （它从 HTTP 路径来）、以及「没抽过页就分段」要回 409 而不是编出空章节。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LIBRARY_API_PREFIX } from '../src/library.js';
import { makeLibraryRoutes } from '../src/host/library-routes.js';
import { createDigestStore } from '../src/host/digest-store.js';

const API = LIBRARY_API_PREFIX;
const BOOK = 'l-digest';

function fakeReq({ url, method = 'GET', headers = {}, body } = {}) {
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:52431', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
  req[Symbol.asyncIterator] = async function* iterate() {
    if (body !== undefined) yield Buffer.from(body);
  };
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk, done) { this.chunks.push(Buffer.from(chunk)); if (typeof done === 'function') done(); return true; },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      this.ended = true;
      return this;
    },
    destroy() { return this; },
    on() { return this; },
    get body() { return Buffer.concat(this.chunks); },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

let root = '';
let store = null;
let api = null;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'npie-digest-routes-'));
  store = createDigestStore({ rootDir: root });
  const routes = makeLibraryRoutes({
    listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
    bookById: () => undefined,
    readBytes: async () => Buffer.alloc(0),
    getStates: () => ({}),
    setState: () => ({}),
    reload: async () => {},
    vendorRoot: '/nonexistent',
    digestStore: store,
  });
  api = routes[0];
});

after(async () => {
  // 同 digest-store.test：清理失败 ≠ 断言失败。
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function call(path, { method = 'GET', body, headers } = {}) {
  const res = fakeRes();
  await api.handler(fakeReq({
    url: `${API}${path}`,
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), res);
  return res;
}

/** 造一本「有目录页」的假书：目录页 + 3 章正文。 */
function samplePages() {
  const toc = ['目录', 'CONTENTS', '第一章 起步', '第二章 进阶', '第三章 实战'];
  const body = (title) => [title, ...Array.from({ length: 12 }, () => '正文内容写得比较长，用来模拟排版宽度，末尾加句号。')];
  return [
    { page: 1, lines: toc },
    { page: 2, lines: body('第一章 起步') },
    { page: 3, lines: body('第二章 进阶') },
    { page: 4, lines: body('第三章 实战') },
  ];
}

describe('信任栅栏', () => {
  it('★ 非本机来源一律 403，且不落盘', async () => {
    const res = await call(`/digest/${BOOK}/pages`, {
      method: 'POST',
      body: { pages: [{ page: 1, lines: ['x'] }] },
      headers: { host: 'evil.example.com' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await store.readPages(BOOK), []);
  });
});

describe('POST /digest/:id/pages', () => {
  it('落盘一批页并推进游标', async () => {
    const pages = samplePages();
    const res = await call(`/digest/${BOOK}/pages`, { method: 'POST', body: { pages: pages.slice(0, 2) } });
    assert.equal(res.status, 200);
    assert.equal(res.json.received, 2);
    assert.equal(res.json.cursor, 2);

    const rest = await call(`/digest/${BOOK}/pages`, { method: 'POST', body: { pages: pages.slice(2) } });
    assert.equal(rest.json.cursor, 4);
    assert.equal((await store.readPages(BOOK)).length, 4);
  });

  it('★ 空数组回 400（不是静默成功 —— 那会让抽取循环以为一直在推进）', async () => {
    const res = await call(`/digest/${BOOK}/pages`, { method: 'POST', body: { pages: [] } });
    assert.equal(res.status, 400);
  });

  it('坏页被过滤掉，好的照收', async () => {
    const res = await call(`/digest/${BOOK}/pages`, {
      method: 'POST',
      body: { pages: [{ page: 0, lines: [] }, { page: 'x' }, { page: 9, lines: ['ok', 42] }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.received, 1);
  });

  it('GET 这条路由回 405', async () => {
    assert.equal((await call(`/digest/${BOOK}/pages`)).status, 405);
  });
});

describe('POST /digest/:id/segment', () => {
  it('★ 分段后 outline.json 与 meta 都要落地，章节状态是 pending 不是 done', async () => {
    const res = await call(`/digest/${BOOK}/segment`, {
      method: 'POST',
      body: { pageCount: 4, outline: [] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, 'toc');
    assert.equal(res.json.chapters.length, 3);

    const outline = await store.readOutline(BOOK);
    assert.equal(outline.length, 3);
    const meta = await store.readMeta(BOOK);
    assert.equal(meta.mode, 'toc');
    // ★ 刚抽完不等于已解读 —— 生成是 P2 的事。
    assert.deepEqual(meta.chapters.map(c => c.status), ['pending', 'pending', 'pending']);
    assert.equal(meta.task.state, 'idle');
  });

  it('按章切好了原文，第一章能读出来', async () => {
    const text = await store.readChapterText(BOOK, 1);
    assert.ok(typeof text === 'string' && text.includes('第一章 起步'), String(text).slice(0, 40));
  });

  it('★ 没抽过页就分段回 409（不许编出空章节）', async () => {
    const res = await call('/digest/l-empty/segment', { method: 'POST', body: { pageCount: 10 } });
    assert.equal(res.status, 409);
  });

  it('扫描版（全是空页）分段后 mode=scanned 且章节为空', async () => {
    await call('/digest/l-scan/pages', { method: 'POST', body: { pages: [{ page: 1, lines: [] }, { page: 2, lines: [] }] } });
    const res = await call('/digest/l-scan/segment', { method: 'POST', body: { pageCount: 2 } });
    assert.equal(res.json.mode, 'scanned');
    assert.deepEqual(res.json.chapters, []);
  });
});

/**
 * 0.28.0：识别文本进分段。
 *
 * ★ 这条链的每一环都是「静默失败」的：叠加没接上 ⇒ 还是 scanned（用户以为识别白做了）；
 *   叠加接上了但 `writeChapterTexts` 仍用未叠加的页 ⇒ 目录有了、原文是空的
 *   （点开一章看到白纸）；`meta.extract.ocrPages` 没记 ⇒ 没人知道这些章有错字风险。
 *   所以一条用例把三件事一起断言。
 */
describe('★ 扫描书：识别文本进分段（0.28.0）', () => {
  const SCANNED = 'l-scan-ocr';

  it('空页 + ocr.json ⇒ 分得出章节，原文是识别的那份，meta 记下页数', async () => {
    await call(`/digest/${SCANNED}/pages`, {
      method: 'POST',
      body: { pages: [1, 2, 3, 4].map(page => ({ page, lines: [] })) },
    });
    const titles = ['第一章 起步：从零开始', '第二章 进阶：结构与节奏', '第三章 实战：把书写出来'];
    await store.putOcrPage(SCANNED, 1, {
      // 真实目录页远不止三条：这里刻意多加三条反查不到的（附录/后记），
      // 顺带守住「目录里的分组标题反查不到不算失败」那条老规矩。
      text: ['目录', ...titles, '附录 A 术语表', '附录 B 延伸阅读', '后记'].join('\n'),
    });
    for (const page of [2, 3, 4]) {
      const title = titles[page - 2];
      await store.putOcrPage(SCANNED, page, {
        text: [title, ...Array.from({ length: 8 }, () => '这是识别出来的一行正文，长度足够，末尾有句号。')].join('\n'),
      });
    }

    const res = await call(`/digest/${SCANNED}/segment`, { method: 'POST', body: { pageCount: 4 } });
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, 'toc', '识别文本没有进分段（还是被当成扫描书）');
    assert.equal(res.json.chapters.length, 3);

    const meta = await store.readMeta(SCANNED);
    assert.equal(meta.extract.ocrPages, 4);
    assert.equal(meta.extract.ocrKnown, 4);

    // ★ 章节原文也必须用叠加后的页：只把 OCR 喂给分段、原文仍切空页，
    //   症状是「目录有 3 章，点进去全是空白」。
    const text = await store.readChapterText(SCANNED, 1);
    assert.ok(typeof text === 'string' && text.includes('这是识别出来的一行正文'), String(text).slice(0, 60));
  });

  it('★ 反向对照：只认了一页（1/6）仍然判扫描版 —— 一页不许编出整本目录', async () => {
    const book = 'l-scan-ocr-few';
    await call(`/digest/${book}/pages`, {
      method: 'POST',
      body: { pages: [1, 2, 3, 4, 5, 6].map(page => ({ page, lines: [] })) },
    });
    await store.putOcrPage(book, 1, {
      text: ['目录', '第一章 起步', '第二章 进阶', '第三章 实战'].join('\n'),
    });
    const res = await call(`/digest/${book}/segment`, { method: 'POST', body: { pageCount: 6 } });
    assert.equal(res.json.mode, 'scanned');
    assert.deepEqual(res.json.chapters, []);
    // 但「认过一页」这件事必须留痕：界面与工具靠它说「只识别了 1 / 6 页」。
    const meta = await store.readMeta(book);
    assert.equal(meta.extract.ocrKnown, 1);
  });

  it('★ 有文字层的页不被识别文本覆盖（同一本书里两种页共存）', async () => {
    const book = 'l-scan-ocr-mixed';
    await call(`/digest/${book}/pages`, {
      method: 'POST',
      body: {
        pages: [
          { page: 1, lines: ['目录', '第一章 起步', '第二章 进阶', '第三章 实战'] },
          { page: 2, lines: ['第一章 起步', ...Array.from({ length: 8 }, () => '文字层里的正文，最后一个字是句号。')] },
          { page: 3, lines: [] },
          { page: 4, lines: ['第三章 实战', ...Array.from({ length: 8 }, () => '文字层里的正文，最后一个字是句号。')] },
        ],
      },
    });
    await store.putOcrPage(book, 2, { text: '第一章 起步\n识别版正文（不该被采用，长度也故意写得很长很长很长很长）' });
    await store.putOcrPage(book, 3, {
      text: ['第二章 进阶', ...Array.from({ length: 8 }, () => '这是识别出来的正文，长度足够，末尾有句号。')].join('\n'),
    });
    const res = await call(`/digest/${book}/segment`, { method: 'POST', body: { pageCount: 4 } });
    assert.equal(res.json.mode, 'toc');
    const meta = await store.readMeta(book);
    assert.equal(meta.extract.ocrPages, 1, '有文字层的页也被识别文本覆盖了');

    const ch1 = await store.readChapterText(book, 1);
    assert.ok(ch1.includes('文字层里的正文'), '文字层优先这一条被破坏');
    assert.equal(ch1.includes('识别版正文'), false);
    const ch2 = await store.readChapterText(book, 2);
    assert.ok(ch2.includes('这是识别出来的正文'), '扫描页没有用上识别文本');
  });
});

/**
 * 「重新抽取」不能顺手把识别结果删掉（0.28.0）。
 *
 * ★ 路由这一层的默认值就是用户点一下「重新抽取」得到的后果，所以它必须在
 *   路由上被钉住，而不是只测 store（store 默认还是全删，那个语义不能改）。
 */
describe('POST /digest/:id/reset 与 ocr.json', () => {
  it('★ 默认保住识别结果（重新抽取 = 重做分段，不是扔掉 90 秒）', async () => {
    const book = 'l-reset-keep';
    await call(`/digest/${book}/pages`, { method: 'POST', body: { pages: [{ page: 1, lines: [] }] } });
    await store.putOcrPage(book, 1, { text: '认出的一页字' });

    const res = await call(`/digest/${book}/reset`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.json.keptOcr, true);
    assert.equal(res.json.ocrPages, 1);
    assert.deepEqual(await store.readPages(book), []);
    assert.equal((await store.readOcrPages(book))[1], '认出的一页字');
  });

  it('反向对照：`?wipe=1` 才是真的清干净（书换过文件时用）', async () => {
    const book = 'l-reset-wipe';
    await call(`/digest/${book}/pages`, { method: 'POST', body: { pages: [{ page: 1, lines: [] }] } });
    await store.putOcrPage(book, 1, { text: '上一本文件的字' });

    const res = await call(`/digest/${book}/reset?wipe=1`, { method: 'POST' });
    assert.equal(res.json.keptOcr, false);
    assert.deepEqual(await store.readOcrPages(book), {});
  });
});

describe('GET /digest/:id/status', () => {
  it('返回 meta 与 outline；没解读过时两者都是 null', async () => {
    const res = await call(`/digest/${BOOK}/status`);
    assert.equal(res.status, 200);
    assert.equal(res.json.meta.bookId, BOOK);
    assert.equal(res.json.outline.length, 3);

    const empty = await call('/digest/l-nothing/status');
    assert.equal(empty.json.meta, null);
    assert.equal(empty.json.outline, null);
  });
});

describe('bookId 校验：从 HTTP 路径来的那一段', () => {
  it('★ 含穿越片段的路径根本匹配不上正则，落到 404', async () => {
    for (const bad of ['..%2F..%2Fetc', 'a.b', '%2e%2e']) {
      const res = await call(`/digest/${bad}/status`);
      assert.equal(res.status, 404, `${bad} 没有被挡住`);
    }
  });
});

describe('依赖缺失时的退化', () => {
  it('★ 没接 digestStore 时回 501，而不是让整个 handler 挂掉', async () => {
    // 理由同书源那几条：一旦这里抛异常，`GET /books` 也会一起打歪，
    // 界面上表现为「书架一直转圈」，而真正的问题在解读这一侧。
    const routes = makeLibraryRoutes({
      listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
      bookById: () => undefined,
      readBytes: async () => Buffer.alloc(0),
      getStates: () => ({}),
      setState: () => ({}),
      reload: async () => {},
      vendorRoot: '/nonexistent',
    });
    const res = fakeRes();
    await routes[0].handler(fakeReq({ url: `${API}/digest/${BOOK}/status` }), res);
    assert.equal(res.status, 501);
  });
});
