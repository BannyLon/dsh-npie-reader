/**
 * 导出技能包这条路由（`/digest/:id/skill`）。
 *
 * ★ 这一层只做一件事：把 HTTP 请求**收敛成宿主能信的形状**。所以断言全在
 *   「传下去的是什么」上 —— `synthesize` 是不是真布尔、没带 `profile` 时是不是
 *   `auto`、`model` 没带时是不是**根本不存在**。这些地方错一个都不会报错：
 *   把 `synthesize: "false"` 当真值，用户点「不综合」反而花了钱；
 *   把「没带 model」写成 `model: ''`，下游会拿空串去校验并报「模型格式不对」。
 *
 * ★ 为什么用假 `exportSkill` 而不是真 service：真 service 那条路已经被
 *   `book-tools.test.mjs` 用真文件系统跑过了。这里要钉的是**路由自己的分派**，
 *   假函数能直接把收到的参数摊开来看，比事后从产物倒推清楚得多。
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
const BOOK = 'l-skill-route';

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
const calls = [];

const baseHandlers = () => ({
  listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
  bookById: () => undefined,
  readBytes: async () => Buffer.alloc(0),
  getStates: () => ({}),
  setState: () => ({}),
  reload: async () => {},
  vendorRoot: '/nonexistent',
});

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'npie-skill-routes-'));
  store = createDigestStore({ rootDir: root });
  const routes = makeLibraryRoutes({
    ...baseHandlers(),
    digestStore: store,
    exportSkill: async (request) => {
      calls.push(request);
      if (request.bookId === 'l-boom') throw new Error('这本书还没有抽取目录，先点「抽取目录」');
      return {
        ok: true,
        slug: 'book-lskillroute',
        dir: '/tmp/skills/book-lskillroute',
        bytes: 1234,
        profile: 'technical',
        profileReason: '每千字 30 处代码特征（阈值 6）',
        synthesized: request.synthesize,
        synthesisError: '',
        stats: { chapters: 3, digested: 2, skipped: 0, failed: 0, terms: 1, bytes: 1234 },
        files: ['SKILL.md', 'chapters/ch01.md'],
      };
    },
    skillStatus: async ({ bookId }) => (bookId === BOOK ? null : { slug: 'old', dir: '/tmp/skills/old' }),
  });
  api = routes[0];
});

after(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function call(path, { method = 'GET', body } = {}) {
  const res = fakeRes();
  await api.handler(fakeReq({
    url: `${API}${path}`,
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), res);
  return res;
}

describe('GET /digest/:id/skill：只读上一次导出', () => {
  it('没导出过 ⇒ ok:true + skill:null（不是 404）', async () => {
    // 「还没导出」是正常状态。回 404 会让客户端把「没导出过」画成「出错了」。
    const res = await call(`/digest/${BOOK}/skill`);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.skill, null);
  });

  it('导出过 ⇒ 带回 slug 与目录', async () => {
    const res = await call('/digest/l-other/skill');
    assert.equal(res.status, 200);
    assert.equal(res.json.skill.slug, 'old');
    assert.match(res.json.skill.dir, /skills\/old$/);
  });
});

describe('POST /digest/:id/skill：收敛请求', () => {
  it('★★ 没带 profile ⇒ auto；没带 model ⇒ 键根本不存在', async () => {
    // `model: ''` 会让下游拿空串去校验并报「模型格式不对」—— 用户明明什么都没填。
    calls.length = 0;
    const res = await call(`/digest/${BOOK}/skill`, { method: 'POST', body: {} });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profile, 'auto');
    assert.equal(calls[0].synthesize, false);
    assert.ok(!('model' in calls[0]), `不该出现 model 键：${JSON.stringify(calls[0])}`);
  });

  it('★★ synthesize 只认真布尔：字符串 "yes" / 数字 1 一律当 false', async () => {
    // 把 `synthesize: "false"` 当真值 ⇒ 用户点「不综合」反而多花一次模型调用。
    calls.length = 0;
    await call(`/digest/${BOOK}/skill`, { method: 'POST', body: { synthesize: 'yes' } });
    await call(`/digest/${BOOK}/skill`, { method: 'POST', body: { synthesize: 1 } });
    await call(`/digest/${BOOK}/skill`, { method: 'POST', body: { synthesize: true } });
    assert.deepEqual(calls.map(call => call.synthesize), [false, false, true]);
  });

  it('profile / model 透传并封顶长度', async () => {
    calls.length = 0;
    await call(`/digest/${BOOK}/skill`, {
      method: 'POST',
      body: { profile: 'fiction', model: 'p/m', synthesize: true },
    });
    assert.equal(calls[0].profile, 'fiction');
    assert.equal(calls[0].model, 'p/m');

    await call(`/digest/${BOOK}/skill`, { method: 'POST', body: { profile: 'x'.repeat(200), model: 'y'.repeat(500) } });
    assert.equal(calls[1].profile.length, 40);
    assert.equal(calls[1].model.length, 200);
  });

  it('bookId 来自路径，原样带下去', async () => {
    calls.length = 0;
    await call('/digest/l-abc_123/skill', { method: 'POST', body: {} });
    assert.equal(calls[0].bookId, 'l-abc_123');
  });

  it('宿主抛错 ⇒ 400 + 原文案（界面要能直接显示）', async () => {
    const res = await call('/digest/l-boom/skill', { method: 'POST', body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /还没有抽取目录/);
  });

  it('返回体带 dir / stats / files，界面靠这些显示结果', async () => {
    const res = await call(`/digest/${BOOK}/skill`, { method: 'POST', body: { synthesize: true } });
    assert.equal(res.json.ok, true);
    assert.match(res.json.dir, /book-lskillroute$/);
    assert.equal(res.json.stats.digested, 2);
    assert.deepEqual(res.json.files, ['SKILL.md', 'chapters/ch01.md']);
    assert.equal(res.json.synthesized, true);
    assert.match(res.json.profileReason, /代码特征/);
  });

  it('PUT ⇒ 405（导出只能 POST）', async () => {
    const res = await call(`/digest/${BOOK}/skill`, { method: 'PUT', body: {} });
    assert.equal(res.status, 405);
  });

  it('bookId 含路径字符 ⇒ 根本不匹配这条路由', async () => {
    // 这是路径穿越的第一道闸：`..` 不该走进 `exportSkill`。
    calls.length = 0;
    const res = await call('/digest/../skill', { method: 'POST', body: {} });
    assert.notEqual(res.status, 200);
    assert.equal(calls.length, 0);
  });
});

describe('闸：没有导出入口时只影响这一条', () => {
  it('★★ 缺 exportSkill ⇒ skill 回 501，但 status 照常可用', async () => {
    // 只挂了 digestStore 的夹具不该因为「没有导出入口」而让整个前缀 501 ——
    // 抽目录、看状态、生成解读都得照常工作。
    const routes = makeLibraryRoutes({ ...baseHandlers(), digestStore: store });
    const resSkill = fakeRes();
    await routes[0].handler(fakeReq({ url: `${API}/digest/${BOOK}/skill`, method: 'POST', headers: { 'content-type': 'application/json' } }), resSkill);
    assert.equal(resSkill.status, 501);
    assert.match(resSkill.json.error, /导出技能包没有接上/);

    const resStatus = fakeRes();
    await routes[0].handler(fakeReq({ url: `${API}/digest/${BOOK}/status` }), resStatus);
    assert.equal(resStatus.status, 200, 'status 被导出的闸连累了');
  });
});
