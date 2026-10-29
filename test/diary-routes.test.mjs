/**
 * 日记路由（`src/host/diary-routes.js`）。
 *
 * ★ 用**真的** `createDiaryStore`（临时 `DSH_HOME`）+ 假 req/res：这一层的价值全在
 *   「HTTP 形态 → 存储层 → 磁盘」这条链上。把 store 也换成假的，就等于只测了
 *   `if (rest === '/days')` 这类字符串分派 —— 而那部分恰恰是最不容易错的。
 *
 * ★ 必须有牙的四条：
 *   1. **信任栅栏**：宿主派发插件路由**不经过**它自己的鉴权拦截器，所以这里是
 *      「读/删用户日记」的全部防线。要有反向对照（同一请求换成回环就通）。
 *   2. **日期白名单**：日期从 URL 来，必须挡住 `../`。
 *   3. **状态码分得开**：415 / 413 / 404 / 400 各自对应用户不同的下一步。
 *   4. **缺依赖退化成 501**，不能让整个前缀 500。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DIARY_API_PREFIX } from '../src/diary-format.js';
import { createDiaryStore, MAX_ENTRY_CHARS } from '../src/host/diary-store.js';
import { createDiarySecret } from '../src/host/diary-secret.js';
import { makeDiaryRoutes } from '../src/host/diary-routes.js';

const API = DIARY_API_PREFIX;

function fakeReq({ url, method = 'GET', headers = {}, body, json } = {}) {
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:52431', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
  // ★ `json` 是一个便利入口：它同时补上 content-type 与序列化后的 body。
  //   分开传时最容易犯的错是「content-type 传成了顶层选项」，于是所有写请求都
  //   收到 415，看起来像路由坏了 —— 本文件第一版就栽在这上面。
  let payload = body;
  if (json !== undefined) {
    req.headers['content-type'] = 'application/json; charset=utf-8';
    payload = JSON.stringify(json);
  }
  req[Symbol.asyncIterator] = async function* iterate() {
    if (payload !== undefined) yield Buffer.from(payload);
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
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

let home = '';
let api = null;
/**
 * 接上**全部**依赖的第二个实例（含 0.31 才有的 `/tags` `/timeline` `/secret`
 * 与 `readFull`）。`api` 保持「只接老依赖」的形态 —— 它自己就是「缺依赖必须
 * 退化成 501」那条断言的夹具，两件事不能共用一个实例。
 */
let apiFull = null;
let fullStore = null;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'npie-diary-routes-'));
  process.env.DSH_HOME = home;
  const store = createDiaryStore({ log: () => {} });
  api = makeDiaryRoutes({
    read: date => store.read(date),
    append: entry => store.append(entry),
    removeEntry: entry => store.removeEntry(entry),
    listMonth: month => store.listMonth(month),
    search: options => store.search(options),
    exportAll: () => store.exportAll(),
    stats: () => store.stats(),
    log: () => {},
  });
  // ★ 注入密钥：私密那半边的路由用例不该去碰真实的系统钥匙串。
  fullStore = createDiaryStore({
    log: () => {},
    secret: createDiarySecret({ key: Buffer.alloc(32, 3), keyPath: join(home, 'routes.key') }),
  });
  apiFull = makeDiaryRoutes({
    read: date => fullStore.read(date),
    readFull: date => fullStore.readFull(date),
    append: entry => fullStore.append(entry),
    removeEntry: entry => fullStore.removeEntry(entry),
    listMonth: month => fullStore.listMonth(month),
    search: options => fullStore.search(options),
    tags: options => fullStore.tags(options),
    timeline: options => fullStore.timeline(options),
    byBook: bookId => fullStore.byBook(bookId),
    // 0.47：「这本书 / 这篇文章的全部灵感」—— 时间轴的一次收窄，走的是同一个 store。
    bySource: options => fullStore.bySource(options),
    exportAll: options => fullStore.exportAll(options),
    stats: () => fullStore.stats(),
    secretStatus: () => fullStore.secret.status(),
    reveal: async () => ({ root: fullStore.root() }),
    log: () => {},
  });
});

after(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

async function call(path, options = {}) {
  const res = fakeRes();
  await api.handler(fakeReq({ url: `${API}${path}`, ...options }), res);
  return res;
}

/** 同上，但走**接齐了依赖**的那个实例。 */
async function callFull(path, options = {}) {
  const res = fakeRes();
  await apiFull.handler(fakeReq({ url: `${API}${path}`, ...options }), res);
  return res;
}

/** 展开到 `call()` 的选项里 = 一次「带 content-type 的 JSON 请求」。 */
const jsonBody = value => ({ json: value });

describe('路由形态', () => {
  it('是 prefix 路由，挂在 DIARY_API_PREFIX 上（与书架那条并列，不共用）', () => {
    assert.equal(api.kind, 'prefix');
    assert.equal(api.path, '/api/dsh-npie-reader/diary');
    assert.notEqual(api.path, '/api/dsh-npie-reader/library');
  });
});

describe('信任栅栏', () => {
  it('★ 非回环 socket 一律 403', async () => {
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}/stats` }), res);
    assert.equal(res.status, 200, '前置条件：这条请求本来是通过的');

    const bad = fakeRes();
    await api.handler({
      ...fakeReq({ url: `${API}/stats` }),
      socket: { remoteAddress: '192.168.1.9' },
    }, bad);
    assert.equal(bad.status, 403);
    assert.equal(bad.json.ok, false);
  });

  it('★ Host 不是回环（DNS rebinding 的形态）一律 403', async () => {
    const res = await call('/stats', { headers: { host: 'evil.example.com:52431' } });
    assert.equal(res.status, 403);
  });

  it('★ 显式 cross-site 一律 403', async () => {
    const res = await call('/stats', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.status, 403);
  });

  it('★ 栅栏在**所有**路由之前（不是只保护读的那几条）', async () => {
    for (const [path, method] of [['/days?month=2026-10', 'GET'], ['/day/2026-10-26', 'GET'], ['/export', 'GET'], ['/search?q=x', 'GET']]) {
      const res = await call(path, { method, headers: { host: 'evil.example.com' } });
      assert.equal(res.status, 403, `${method} ${path} 没有被栅栏挡住`);
    }
    const append = await call('/day/2026-10-26/append', {
      method: 'POST',
      headers: { host: 'evil.example.com' },
      json: { body: '不该写进去' },
    });
    assert.equal(append.status, 403, '写入口必须同样被挡住');
    // 而且真的没写进去
    const day = await call('/day/2026-10-26');
    assert.equal(day.json.entries.length, 0);
  });
});

describe('GET /days', () => {
  it('月份非法 ⇒ 400 + BAD_MONTH', async () => {
    const res = await call('/days?month=2026-13');
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BAD_MONTH');
  });

  it('缺 month 参数 ⇒ 400（不是「默认本月」）', async () => {
    const res = await call('/days');
    assert.equal(res.status, 400);
  });

  it('正常 ⇒ 200 且带 days 与 total', async () => {
    await call('/day/2026-10-26/append', { method: 'POST', ...jsonBody({ body: '甲' }) });
    const res = await call('/days?month=2026-10');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.days['2026-10-26'], 1);
    assert.equal(res.json.total, 1);
  });

  it('方法不对 ⇒ 405', async () => {
    const res = await call('/days?month=2026-10', { method: 'POST' });
    assert.equal(res.status, 405);
  });
});

describe('GET /day/:date', () => {
  it('那天没写 ⇒ 200 + exists:false（不是 404）', async () => {
    const res = await call('/day/2026-01-01');
    assert.equal(res.status, 200);
    assert.equal(res.json.exists, false);
    assert.deepEqual(res.json.entries, []);
  });

  it('日期非法 ⇒ 400 + BAD_DATE', async () => {
    for (const date of ['2026-13-45', '2026-1-1', '2026-02-30', 'abc']) {
      const res = await call(`/day/${date}`);
      assert.equal(res.status, 400, date);
      assert.equal(res.json.code, 'BAD_DATE');
    }
  });

  it('★ 路径穿越打不进来（编码过的也不行）', async () => {
    for (const path of ['/day/..%2F..%2Fetc%2Fpasswd', '/day/..%2F..%2Fdata.json', '/day/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
      const res = await call(path);
      assert.notEqual(res.status, 200, `${path} 居然被当成正常请求`);
      assert.equal(res.json.ok, false);
    }
  });
});

describe('POST /day/:date/append', () => {
  it('不是 JSON ⇒ 415', async () => {
    const res = await call('/day/2026-10-27/append', { method: 'POST', body: '纯文本' });
    assert.equal(res.status, 415);
  });

  it('空正文 ⇒ 400 + EMPTY_ENTRY', async () => {
    const res = await call('/day/2026-10-27/append', { method: 'POST', ...jsonBody({ body: '   ' }) });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'EMPTY_ENTRY');
  });

  it('超长 ⇒ 413 + ENTRY_TOO_LARGE（不是 400「请求有问题」）', async () => {
    const res = await call('/day/2026-10-27/append', {
      method: 'POST',
      ...jsonBody({ body: 'x'.repeat(MAX_ENTRY_CHARS + 10) }),
    });
    assert.equal(res.status, 413);
    assert.equal(res.json.code, 'ENTRY_TOO_LARGE');
  });

  it('正常 ⇒ 200 且回 index / chars / path', async () => {
    const res = await call('/day/2026-10-28/append', {
      method: 'POST',
      ...jsonBody({ time: '09:31', kind: '读后感', source: '《被讨厌的勇气》', body: '今天想明白一件事。' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.index, 0);
    assert.ok(res.json.chars > 0);
    assert.match(res.json.path, /2026-10-28\.md$/);

    const day = await call('/day/2026-10-28');
    assert.equal(day.json.entries.length, 1);
    assert.equal(day.json.entries[0].kind, '读后感');
    assert.equal(day.json.entries[0].source, '《被讨厌的勇气》');
  });

  it('连点两次 ⇒ 两条，序号递增', async () => {
    const first = await call('/day/2026-10-29/append', { method: 'POST', ...jsonBody({ body: '甲' }) });
    const second = await call('/day/2026-10-29/append', { method: 'POST', ...jsonBody({ body: '乙' }) });
    assert.equal(first.json.index, 0);
    assert.equal(second.json.index, 1);
    const day = await call('/day/2026-10-29');
    assert.deepEqual(day.json.entries.map(entry => entry.body), ['甲', '乙']);
  });

  it('GET 这个方法 ⇒ 405（写入口不能顺手用 GET 触发）', async () => {
    const res = await call('/day/2026-10-29/append');
    assert.equal(res.status, 405);
  });
});

describe('DELETE /day/:date/entry/:index', () => {
  it('删掉一条 ⇒ 200，再删同一条 ⇒ 404 + ENTRY_NOT_FOUND', async () => {
    await call('/day/2026-11-01/append', { method: 'POST', ...jsonBody({ body: '甲' }) });
    await call('/day/2026-11-01/append', { method: 'POST', ...jsonBody({ body: '乙' }) });

    const first = await call('/day/2026-11-01/entry/0', { method: 'DELETE' });
    assert.equal(first.status, 200);
    assert.equal(first.json.entries, 1);

    const again = await call('/day/2026-11-01/entry/0', { method: 'DELETE' });
    assert.equal(again.status, 200, '第二次删的是「现在」的第 0 条，本来就有');

    const empty = await call('/day/2026-11-01/entry/0', { method: 'DELETE' });
    assert.equal(empty.status, 404);
    assert.equal(empty.json.code, 'ENTRY_NOT_FOUND');
  });

  it('序号非法 ⇒ 400（不是 404，也不是 500）', async () => {
    for (const index of ['abc', '-1', '1.5']) {
      const res = await call(`/day/2026-11-01/entry/${index}`, { method: 'DELETE' });
      assert.equal(res.status, 400, index);
    }
  });

  it('GET 这个方法 ⇒ 405（删除只能用 DELETE）', async () => {
    const res = await call('/day/2026-11-01/entry/0');
    assert.equal(res.status, 405);
  });
});

describe('GET /search', () => {
  it('正常命中', async () => {
    await call('/day/2026-12-01/append', { method: 'POST', ...jsonBody({ body: '关于孤独的一段想法' }) });
    const res = await call(`/search?q=${encodeURIComponent('孤独')}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.hits.length, 1);
    assert.equal(res.json.hits[0].date, '2026-12-01');
  });

  it('空查询 ⇒ 200 + 空结果（搜索框每敲一个字都会发，清空时不该是红字）', async () => {
    const res = await call('/search?q=');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.hits, []);
  });

  it('缺 q 参数也一样（不是 400）', async () => {
    const res = await call('/search');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.hits, []);
  });
});

describe('GET /export 与 /stats', () => {
  it('/export 给出全部文件，只读', async () => {
    const res = await call('/export');
    assert.equal(res.status, 200);
    assert.ok(res.json.total >= 1);
    assert.equal(Array.isArray(res.json.files), true);
    assert.equal(res.json.files.every(file => typeof file.text === 'string'), true);
  });

  it('/stats 给出天数与目录', async () => {
    const res = await call('/stats');
    assert.equal(res.status, 200);
    assert.ok(res.json.days >= 1);
    assert.match(res.json.root, /storages\/dsh-npie-reader\/diary$/);
  });
});

describe('POST /reveal', () => {
  it('没接上 ⇒ 501（不是 500，也不能让别的路由跟着坏）', async () => {
    const res = await call('/reveal', { method: 'POST' });
    assert.equal(res.status, 501);
    // 而且别的路由照常
    assert.equal((await call('/stats')).status, 200);
  });

  it('接上了 ⇒ 调用一次并回 200', async () => {
    let called = 0;
    const withReveal = makeDiaryRoutes({
      read: async () => ({}),
      append: async () => ({}),
      removeEntry: async () => ({}),
      listMonth: async () => ({}),
      search: async () => ({}),
      exportAll: async () => ({}),
      stats: async () => ({}),
      reveal: async () => { called += 1; },
    });
    const res = fakeRes();
    await withReveal.handler(fakeReq({ url: `${API}/reveal`, method: 'POST' }), res);
    assert.equal(res.status, 200);
    assert.equal(called, 1);
  });
});

describe('退化与兜底', () => {
  it('★ 依赖缺失 ⇒ 501，而不是让整个 handler 抛错', async () => {
    const bare = makeDiaryRoutes({});
    for (const path of ['/stats', '/export', '/day/2026-10-26', '/days?month=2026-10']) {
      const res = fakeRes();
      await bare.handler(fakeReq({ url: `${API}${path}` }), res);
      assert.equal(res.status, 501, path);
    }
  });

  it('不认识的路径 ⇒ 404', async () => {
    const res = await call('/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.ok, false);
  });

  it('前缀本身（没有子路径）⇒ 404，不抛错', async () => {
    const res = await call('');
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// 0.31 新增：标签 / 时间轴 / 密钥状态 / 导出含私密 / 按 scope 删
//
// ★ 这一组守的是**边界**，不是功能：`includePrivate: true` 只允许出现在这一层
//   （用户在界面上看自己的日记），工具侧永远不传 —— 所以断言要钉住「路由层确实
//   把私密打开了」和「/export 默认确实没打开」这两个相反的方向。
// ---------------------------------------------------------------------------

describe('GET /tags 与 /timeline', () => {
  it('没接上 ⇒ 501（不能因为少一个按钮让整个前缀挂掉）', async () => {
    assert.equal((await call('/tags')).status, 501);
    assert.equal((await call('/timeline')).status, 501);
  });

  it('接上了 ⇒ 200，且**包含私密标签**（界面是用户本人看的）', async () => {
    await fullStore.append({ date: '2026-08-01', body: '公开这条 #公开标签' });
    await fullStore.append({ date: '2026-08-01', body: '私密这条 #私密标签', vis: 'private' });

    const tags = await callFull('/tags');
    assert.equal(tags.status, 200);
    const names = tags.json.tags.map(item => item.tag);
    assert.ok(names.includes('公开标签'), names.join(','));
    assert.ok(names.includes('私密标签'), `路由层没把私密打开：${names.join(',')}`);
  });

  it('时间轴按天倒序给预览，私密条目带 scope', async () => {
    const res = await callFull('/timeline?limit=10');
    assert.equal(res.status, 200);
    const day = res.json.days.find(item => item.date === '2026-08-01');
    assert.ok(day, '这一天没出现在时间轴里');
    assert.deepEqual(day.entries.map(item => item.scope), ['public', 'private']);
    assert.ok(day.entries[1].preview.includes('私密这条'));
  });

  it('limit 传垃圾值 ⇒ 退回默认，不报错', async () => {
    const res = await callFull('/timeline?limit=abc');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.days));
  });

  it('方法不对 ⇒ 405', async () => {
    assert.equal((await callFull('/tags', { method: 'POST' })).status, 405);
    assert.equal((await callFull('/timeline', { method: 'POST' })).status, 405);
  });
});

describe('GET /secret', () => {
  it('没接上 ⇒ 501', async () => {
    assert.equal((await call('/secret')).status, 501);
  });

  it('接上了 ⇒ 200 且报出密钥模式（界面必须能说「防拷走、不防本机进程」）', async () => {
    const res = await callFull('/secret');
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, 'injected');
    assert.ok(typeof res.json.keyPath === 'string');
  });
});

describe('GET /export 的私密开关', () => {
  it('★ 默认**不含**私密，并如实报「有几天没导出」', async () => {
    const res = await callFull('/export');
    assert.equal(res.status, 200);
    assert.equal(res.json.files.some(file => file.name.includes('2026-08-01.private')), false);
    assert.ok(res.json.skippedPrivate >= 1);
  });

  it('?private=1 才包含，且是解密后的 Markdown', async () => {
    const res = await callFull('/export?private=1');
    assert.equal(res.status, 200);
    const file = res.json.files.find(item => item.name === '2026-08-01.private.md');
    assert.ok(file, res.json.files.map(item => item.name).join(','));
    assert.ok(file.text.includes('私密这条'));
    assert.equal(res.json.skippedPrivate, 0);
  });
});

describe('GET /book/:bookId（读后感工作台）', () => {
  it('没接上 ⇒ 501（老版本插件不会因此整块 500）', async () => {
    assert.equal((await call('/book/l29fc96838f2d0e5d')).status, 501);
  });

  it('接上了 ⇒ 200，只回这本书的读后感', async () => {
    await fullStore.append({ date: '2026-08-10', kind: '读后感', body: '这本书的读后感', meta: { book: 'l29fc96838f2d0e5d' } });
    await fullStore.append({ date: '2026-08-10', kind: '读后感', body: '另一本书', meta: { book: 'labcdef012345678' } });

    const res = await callFull('/book/l29fc96838f2d0e5d');
    assert.equal(res.status, 200);
    assert.equal(res.json.bookId, 'l29fc96838f2d0e5d');
    assert.deepEqual(res.json.entries.map(entry => entry.body), ['这本书的读后感']);
  });

  it('★ 非法 id ⇒ 400 + BAD_BOOK（不是 500，也不是空列表）', async () => {
    const res = await callFull('/book/a%20b');
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BAD_BOOK');
  });

  it('方法不对 ⇒ 405', async () => {
    assert.equal((await callFull('/book/l29fc96838f2d0e5d', { method: 'POST' })).status, 405);
  });
});

/**
 * 0.47：`GET /source?book=` / `?article=` —— 灵感的聚合成了一次**收窄**。
 *
 * ★ 为什么是查询参数而不是路径段：文章 key 是 `feed:<hash>`，走路径要再编码一层，
 *   编错了只在**部分数据**上出现（「有些文章的聚合打不开」）。
 */
describe('GET /source（这本书 / 这篇文章的全部灵感）', () => {
  const BOOK = 'lbook_source_1';
  const OTHER = 'lbook_source_2';
  const ARTICLE = 'feed:294';

  // ★ 用**远一点**的日期 + 独立 book id：这个文件里的 `fullStore` 是共用的，
  //   落在 2026-08 会改到「这一天 / 这个月 / 那年今日」那几条断言的结果。
  before(async () => {
    await fullStore.append({
      date: '2025-06-01', time: '09:00', kind: '灵感', body: '书里的第一条',
      source: '《九三年》 · 第 3 章', meta: { book: BOOK, chapter: 3 },
    });
    await fullStore.append({
      date: '2025-06-03', time: '21:00', kind: '灵感', body: '书里的第二条',
      source: '《九三年》 · 第 9 章', meta: { book: BOOK, chapter: 9 },
    });
    await fullStore.append({
      date: '2025-06-02', time: '08:00', kind: '灵感', body: '另一本书的',
      source: '《悲惨世界》', meta: { book: OTHER },
    });
    await fullStore.append({
      date: '2025-06-02', time: '22:00', kind: '灵感', body: '文章下的',
      source: '第 294 期', meta: { article: ARTICLE },
    });
    // ★ 两件**不该**混进来：整篇读后感属于读后感工作台；私密那半边有它自己的闸门。
    await fullStore.append({ date: '2025-06-03', time: '23:00', kind: '读后感', body: '一整篇读后感', meta: { book: BOOK } });
    await fullStore.append({
      date: '2025-06-04', time: '10:00', kind: '灵感', body: '私密里的',
      vis: 'private', meta: { book: BOOK },
    });
  });

  it('没接上 ⇒ 501（老版本插件不会因此整块 500）', async () => {
    assert.equal((await call(`/source?book=${BOOK}`)).status, 501);
  });

  it('按书 ⇒ 200，跨天、日期倒序、同一天按时刻升序', async () => {
    const res = await callFull(`/source?book=${BOOK}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.total, 2);
    assert.deepEqual(res.json.days.map(day => day.date), ['2025-06-03', '2025-06-01']);
    assert.deepEqual(res.json.days.map(day => day.entries.map(e => e.preview)), [['书里的第二条'], ['书里的第一条']]);
    // 形状与时间轴的 `days` **完全一致**：客户端拿它直接替换 `timeline.days`。
    const first = res.json.days[0].entries[0];
    assert.deepEqual(Object.keys(first).sort(),
      ['article', 'book', 'chapter', 'index', 'kind', 'mood', 'page', 'preview', 'scope', 'source', 'tags', 'time']);
    assert.equal(first.chapter, 9, '章节没带出来 —— 卡片上的「第 9 章」就没了');
    assert.equal(first.date, undefined, '条目里不该有 date（上层 day 已经有）');
  });

  it('★ 读后感与私密都不进来（两件都是别处的门）', async () => {
    const res = await callFull(`/source?book=${BOOK}`);
    const bodies = res.json.days.flatMap(day => day.entries.map(e => e.preview));
    assert.equal(bodies.includes('一整篇读后感'), false, '读后感混进了「这本书的灵感」');
    assert.equal(bodies.includes('私密里的'), false, '私密那半边被并进来了 —— 绕过了它的闸门');
    assert.equal(bodies.includes('另一本书的'), false, '别的书的灵感混进来了');
  });

  it('★ 按文章：key 里那个冒号不用手动编码（所以走查询参数）', async () => {
    const res = await callFull(`/source?article=${encodeURIComponent(ARTICLE)}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.total, 1);
    assert.equal(res.json.days[0].entries[0].preview, '文章下的');
    assert.equal(res.json.days[0].entries[0].article, ARTICLE);
  });

  it('两个都给 / 都不给 ⇒ 400 BAD_SOURCE（不是「两个都筛一遍」）', async () => {
    for (const path of ['/source', '/source?book=&article=', `/source?book=${BOOK}&article=${encodeURIComponent(ARTICLE)}`]) {
      const res = await callFull(path);
      assert.equal(res.status, 400, path);
      assert.equal(res.json.code, 'BAD_SOURCE', path);
    }
  });

  it('book id 非法 ⇒ 400 BAD_BOOK（不是 500）', async () => {
    const res = await callFull('/source?book=a%20b');
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BAD_BOOK');
  });

  it('方法不对 ⇒ 405', async () => {
    assert.equal((await callFull(`/source?book=${BOOK}`, { method: 'POST' })).status, 405);
  });
});

describe('GET /day 与 DELETE 的 scope', () => {
  it('GET /day 走 readFull：合并两边、每条带 scope 与独立序号', async () => {
    const res = await callFull('/day/2026-08-01');
    assert.equal(res.status, 200);
    assert.equal(res.json.publicCount, 1);
    assert.equal(res.json.privateCount, 1);
    assert.deepEqual(res.json.entries.map(item => `${item.scope}/${item.index}`), ['public/0', 'private/0']);
  });

  it('★ 删私密必须带 scope=private；不带就只删公开那半边', async () => {
    await fullStore.append({ date: '2026-08-02', body: '公开留着' });
    await fullStore.append({ date: '2026-08-02', body: '私密留着', vis: 'private' });

    // 不带 scope ⇒ 删的是公开的 0 号
    assert.equal((await callFull('/day/2026-08-02/entry/0', { method: 'DELETE' })).status, 200);
    let day = await callFull('/day/2026-08-02');
    assert.deepEqual(day.json.entries.map(item => item.body), ['私密留着']);

    // 带 scope ⇒ 才动私密那半边
    const res = await callFull('/day/2026-08-02/entry/0?scope=private', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.json.scope, 'private');
    day = await callFull('/day/2026-08-02');
    assert.deepEqual(day.json.entries, []);
  });

  it('★ 解不开的私密日记 ⇒ 500 + 人话，不是 200 + 空条目', async () => {
    // 谎报「那天没写」会让用户以为日记丢了，而再写一条就把密文覆盖掉。
    const broken = createDiaryStore({
      log: () => {},
      secret: createDiarySecret({ key: Buffer.alloc(32, 8), keyPath: join(home, 'broken.key') }),
    });
    const brokenApi = makeDiaryRoutes({
      read: date => broken.read(date),
      readFull: date => broken.readFull(date),
      append: entry => broken.append(entry),
      removeEntry: entry => broken.removeEntry(entry),
      listMonth: month => broken.listMonth(month),
      search: options => broken.search(options),
      exportAll: options => broken.exportAll(options),
      stats: () => broken.stats(),
    });
    const res = fakeRes();
    await brokenApi.handler(fakeReq({ url: `${API}/day/2026-08-01` }), res);
    assert.notEqual(res.status, 200);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'DECRYPT_FAILED');
    assert.match(res.json.error, /解不开|密钥/);
  });
});

/**
 * 侧栏那两块卡片（0.43）：`GET /dashboard`。
 *
 * ★ 这一组里最要紧的一条是**闸门兜底**：store 手里有钥匙（`fullStore` 注入了密钥），
 *   所以 decrypt **会成功**。若只靠「解不开就不给」，锁上闸门后照样会把心情分布、
 *   字数、摘要一起发出去 —— 而界面看起来只是「显示得挺正常」。
 *   所以断言必须构造「钥匙可用 + 闸门锁着」这个组合。
 */
describe('GET /dashboard', () => {
  const DASH = '/dashboard?date=2026-08-02&today=2026-08-02&month=2026-08';

  async function callDash(path, options = {}, { allow = true } = {}) {
    // ★ 必须把 `ready` 要求的那几条也接上：只接 `dashboard` 会让 handler 在门口
    //   就回 501「日记存储没有接上」，四条断言会一起变红，而看起来像路由没写。
    const api2 = makeDiaryRoutes({
      read: date => fullStore.read(date),
      readFull: date => fullStore.readFull(date),
      append: entry => fullStore.append(entry),
      removeEntry: entry => fullStore.removeEntry(entry),
      listMonth: month => fullStore.listMonth(month),
      dashboard: opts => fullStore.dashboard(opts),
      search: options2 => fullStore.search(options2),
      exportAll: options2 => fullStore.exportAll(options2),
      stats: () => fullStore.stats(),
      gate: { allow: () => allow },
      log: () => {},
    });
    const res = fakeRes();
    await api2.handler(fakeReq({ url: `${API}${path}`, ...options }), res);
    return res;
  }

  before(async () => {
    await fullStore.append({ date: '2026-08-02', time: '08:00', body: '开心的一天', vis: 'private', meta: { mood: '🙂' } });
    await fullStore.append({ date: '2026-08-02', time: '09:00', body: '还行吧', vis: 'private', meta: { mood: '😐' } });
    await fullStore.append({ date: '2025-08-02', time: '21:00', body: '去年的今天', vis: 'private' });
  });

  it('没接上 dashboard ⇒ 501（不能让整个前缀挂掉）', async () => {
    assert.equal((await call('/dashboard?date=2026-08-02')).status, 501);
    assert.equal((await callFull('/dashboard?date=2026-08-02')).status, 501);
  });

  it('日期或月份非法 ⇒ 400', async () => {
    assert.equal((await callDash('/dashboard?date=2026-13-01')).status, 400);
    assert.equal((await callDash('/dashboard?date=2026-08-02&month=2026-8')).status, 400);
    assert.equal((await callDash('/dashboard')).status, 400);
  });

  it('方法不对 ⇒ 405', async () => {
    assert.equal((await callDash(DASH, { method: 'POST' })).status, 405);
  });

  it('闸门开着 ⇒ 200，情绪分布与那年今日都在', async () => {
    const res = await callDash(DASH);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.locked, false);
    assert.deepEqual(res.json.moods, [{ score: 4, count: 1 }, { score: 3, count: 1 }]);
    assert.equal(typeof res.json.chars, 'number');
    assert.deepEqual(res.json.onThisDay.map(cell => [cell.date, cell.years]), [['2025-08-02', 1]]);
    assert.equal(res.json.onThisDay[0].preview, '去年的今天');
  });

  it('★ 闸门锁着 ⇒ 只给天数与连续天数，正文/字数/情绪一律摘掉', async () => {
    // ★ 反向对照写在同一个用例里：同一个 store、同一个请求，只翻 `allow` 这一位。
    const open = await callDash(DASH);
    assert.equal(open.json.locked, false);
    assert.notEqual(open.json.chars, null, '闸门开着时字数该是个数');

    const shut = await callDash(DASH, {}, { allow: false });
    assert.equal(shut.status, 200);
    assert.equal(shut.json.locked, true);
    assert.equal(shut.json.chars, null, '锁着时给 0 或给真值都是漏 —— 必须是 null（不知道）');
    assert.deepEqual(shut.json.moods, []);
    assert.deepEqual(shut.json.moodEntries, {});
    assert.deepEqual(shut.json.onThisDay, [{ date: '2025-08-02', years: 1, locked: true }],
      '锁着时「那年今日」只该剩日期与年份差，摘要必须摘掉');
    assert.equal(shut.json.days, open.json.days, '天数不涉内容，锁着也要给');
    assert.equal(shut.json.streak, open.json.streak, '连续天数不涉内容，锁着也要给');
  });
});
