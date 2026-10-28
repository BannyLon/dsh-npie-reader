/**
 * 摘录 → 日记：**端到端**（0.44.9）。
 *
 * 用户报「摘录选中段落到日记没有成功」，所以这一条不再只断言「客户端传了什么」，
 * 而是把 `excerptEntry` 的产物**原样喂给真的日记路由**（真 `createDiaryStore`、
 * 真临时 `DSH_HOME`、真写盘），再把这一天的内容读回来。
 *
 * 这一层能抓到的错法（纯客户端断言全都抓不到）：
 *   ① 载荷里少了路由要的字段 ⇒ 400 / 415；
 *   ② `meta.article` 的 key 里带 `-->` 或换行 ⇒ 元数据行被写坏；
 *   ③ `kind` / `source` 里带换行 ⇒ 那一行标题断成两行，后半截变成正文；
 *   ④ 日期算错 ⇒ 写到了昨天 / 明天，界面上「今天 0 条」而文件里其实有。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DIARY_API_PREFIX, dateKey } from '../src/diary-format.js';
import { createDiaryStore } from '../src/host/diary-store.js';
import { createDiarySecret } from '../src/host/diary-secret.js';
import { makeDiaryRoutes } from '../src/host/diary-routes.js';
import { excerptEntry } from '../src/client/excerpt.js';

const API = DIARY_API_PREFIX;
const sandbox = await mkdtemp(join(tmpdir(), 'npie-excerpt-'));
process.env.DSH_HOME = sandbox;
// 私密侧要密钥；这里只写公开日记，但 store 构造时可能碰 home，一并隔离。
process.env.HOME = sandbox;

let route;
let store;

before(async () => {
  store = createDiaryStore({
    secret: createDiarySecret({ home: sandbox }),
    log: () => {},
  });
  route = makeDiaryRoutes({
    read: (key) => store.read(key),
    readFull: (key) => store.readFull(key),
    append: (input) => store.append(input),
    updateEntry: (input) => store.updateEntry(input),
    removeEntry: (input) => store.removeEntry(input),
    listMonth: (month) => store.listMonth(month),
    dashboard: (input) => store.dashboard(input),
    search: (input) => store.search(input),
    tags: (input) => store.tags(input),
    timeline: (input) => store.timeline(input),
    byBook: (id) => store.byBook(id),
    exportAll: (input) => store.exportAll(input),
    stats: () => store.stats(),
    secretStatus: () => store.secretStatus(),
    log: () => {},
  });
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

/** 与 `test/diary-routes.test.mjs` 同一套假 req/res（回环地址 = 可信）。 */
function fakeReq({ url, method = 'GET', headers = {}, json } = {}) {
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:52431', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
  let payload;
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
    get body() {
      const text = Buffer.concat(this.chunks).toString('utf8');
      try { return JSON.parse(text); } catch { return text; }
    },
  };
}

async function call(path, { method = 'GET', json } = {}) {
  const res = fakeRes();
  await route.handler(fakeReq({ url: `${API}${path}`, method, json }), res);
  return { status: res.status, body: res.body };
}

describe('0.44.9：摘录 → 日记 —— 端到端', () => {
  it('★ excerptEntry 的产物原样 POST 进去，这一天能读回来', async () => {
    const today = dateKey();
    const payload = excerptEntry({
      quote: '  这是被选中、准备摘进日记的一段原文。\n',
      title: '一篇关于 AI 的长文',
      channelName: '某 Newsletter',
      articleKey: 'feed:https://a.example/feed.xml#post-1',
      date: today,
    });
    assert.ok(payload, 'excerptEntry 给了 null —— 客户端会直接提示「先选中一段」');

    const written = await call(`/day/${today}/append`, { method: 'POST', json: payload });
    assert.equal(written.status, 200, `路由拒绝了摘录载荷：${JSON.stringify(written.body)}`);

    const day = await call(`/day/${today}`);
    assert.equal(day.status, 200);
    const entry = (day.body.entries ?? []).find((item) => item.body.includes('这是被选中'));
    assert.ok(entry, '写进去了但读不回来 —— 日期或文件路径对不上');
    // ★ 断言「宿主认这个 kind」而不是「客户端传了什么」：`ENTRY_KINDS` 白名单会把
    //   认不出的 kind **静默**改成「灵感」，只查载荷永远发现不了（0.44.9 第一版
    //   传的是 `摘录`，用户看到的日记里根本没有这两个字）。
    assert.equal(entry.kind, '灵感', 'kind 被宿主改写了 —— 载荷里的类型不在 ENTRY_KINDS 里');
    assert.equal(entry.body, '这是被选中、准备摘进日记的一段原文。', '两端空白没被去掉');
    assert.equal(entry.source, '摘录 · 一篇关于 AI 的长文 · 某 Newsletter');
    assert.equal(entry.meta?.article, 'feed:https://a.example/feed.xml#post-1',
      'meta.article 没落到文件里 —— 日记里回不到那篇文章');
  });

  it('★ 元数据行不会写坏文件（key 带 `-->` 时整条照样能读）', async () => {
    const today = dateKey();
    const payload = excerptEntry({
      quote: '带危险 key 的一段',
      title: '标题',
      articleKey: 'a-->b',
      date: today,
    });
    const written = await call(`/day/${today}/append`, { method: 'POST', json: payload });
    assert.equal(written.status, 200);
    const day = await call(`/day/${today}`);
    const entry = (day.body.entries ?? []).find((item) => item.body.includes('带危险 key'));
    assert.ok(entry, '元数据行被写坏，这一条在读取时丢了');
    assert.equal(entry.meta?.article, undefined, '`-->` 的 key 不该被保留');
  });

  it('★ 标题里有换行也不会把标题行断成两行', async () => {
    const today = dateKey();
    const payload = excerptEntry({ quote: 'x', title: '第一行\n第二行', date: today });
    const written = await call(`/day/${today}/append`, { method: 'POST', json: payload });
    assert.equal(written.status, 200);
    const day = await call(`/day/${today}`);
    const entry = (day.body.entries ?? []).find((item) => item.body === 'x');
    assert.ok(entry, '标题里的换行把这一条写坏了');
  });
});
