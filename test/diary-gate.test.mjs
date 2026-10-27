/**
 * 私密日记的**口令闸门**（`src/host/diary-gate.js` + 路由里那几条红线）。
 *
 * 为什么这一组必须是「有牙」的测试，而不是三个 happy path：
 *
 *   用户 2026-10-27 的原话是「私密日记点击就能查看还有什么私密，一定是只能本人查看啊」。
 *   上一版（0.33）的做法是**界面遮罩**：正文照样由宿主解密、照样进 DOM，只是 CSS
 *   藏在一条「点击显示」的按钮后面。那种东西用测试是检查不出来的 —— 它是「看起来
 *   私密」。真正能守住这句话的只有一件事：**锁着的时候，正文根本不出宿主**。
 *
 * 所以这里的四条判据都打在**宿主边界**上：
 *   ① `/day` 在锁着时返回的私密条目 body 必须是空串（不是遮罩、不是脱敏，是空）；
 *   ② `/export?private=1` 在锁着时 403（导出落点是下载目录里的明文）；
 *   ③ `DELETE ...?scope=private` 在锁着时 403（读不到也删得掉，是最坏的一种）；
 *   ④ 解锁之后同一个请求能拿到正文 —— 缺了这条，上面的 ①②③ 可以用「永远返回空」
 *      全部通过，而用户会以为自己的日记丢了。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DIARY_API_PREFIX } from '../src/diary-format.js';
import { createDiaryGate } from '../src/host/diary-gate.js';
import { createDiaryStore } from '../src/host/diary-store.js';
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
    chunks: [],
    writeHead(status) { this.status = status; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.from(chunk)); return this; },
    destroy() { return this; },
    on() { return this; },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

let home = '';
let store = null;
let api = null;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'npie-diary-gate-'));
  process.env.DSH_HOME = home;
  store = createDiaryStore({
    log: () => {},
    // 密钥注入：这一组不该去碰真实的系统钥匙串。
    secret: createDiarySecret({ key: Buffer.alloc(32, 7), keyPath: join(home, 'gate-test.key') }),
  });
  api = makeDiaryRoutes({
    read: (date) => store.read(date),
    readFull: (date) => store.readFull(date),
    append: (entry) => store.append(entry),
    removeEntry: (entry) => store.removeEntry(entry),
    listMonth: (month) => store.listMonth(month),
    search: (options) => store.search(options),
    tags: (options) => store.tags(options),
    timeline: (options) => store.timeline(options),
    byBook: (bookId) => store.byBook(bookId),
    exportAll: (options) => store.exportAll(options),
    stats: () => store.stats(),
    secretStatus: () => store.secret.status(),
    gate: store.gate,
    reveal: async () => ({ root: store.root() }),
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

const DAY = '2026-10-27';

describe('闸门本身（不经过 HTTP）', () => {
  it('没设过口令时 set=false，而且**不允许**读', async () => {
    const gate = createDiaryGate({ root: store.root() });
    assert.deepEqual(await gate.peek(), { set: false, unlocked: false });
    assert.equal(gate.allow(), false, '没设口令却放行了 —— 那等于没有闸门');
  });

  it('设好之后立刻是「已解锁」，锁上之后再 allow() 就不给了', async () => {
    const gate = createDiaryGate({ root: store.root() });
    const result = await gate.setup('open sesame');
    assert.equal(result.set, true);
    assert.equal(gate.allow(), true);
    gate.lock();
    assert.equal(gate.allow(), false);
    assert.equal((await gate.peek()).set, true, '上锁不该把「设过口令」这件事也忘掉');
  });

  it('口令错了就是 false，对了才是 true', async () => {
    const gate = createDiaryGate({ root: store.root() });
    assert.equal(await gate.unlock('not-it'), false);
    assert.equal(gate.allow(), false, '错口令之后放行了');
    assert.equal(await gate.unlock('open sesame'), true);
    assert.equal(gate.allow(), true);
  });

  it('弱口令与重复设置都被拒绝（错误码分得开）', async () => {
    const gate = createDiaryGate({ root: store.root() });
    await assert.rejects(() => gate.setup('123'), (error) => error.code === 'GATE_WEAK');
    await assert.rejects(() => gate.setup('another one'), (error) => error.code === 'GATE_EXISTS');
  });
});

describe('锁着时，私密正文不出宿主', () => {
  it('先写一条私密、一条公开（写入不受锁影响：写不需要看见旧内容）', async () => {
    const pub = await call(`/day/${DAY}/append`, { method: 'POST', json: { body: '公开的一条 #灵感', kind: '灵感' } });
    assert.equal(pub.status, 200);
    const priv = await call(`/day/${DAY}/append`, { method: 'POST', json: { body: '这句话只有我能看', kind: '日记', vis: 'private' } });
    assert.equal(priv.status, 200);
    store.gate.lock();
  });

  it('★ GET /day 的私密条目 body 是空串，公开那条原样在', async () => {
    const res = await call(`/day/${DAY}`);
    assert.equal(res.status, 200);
    const body = res.json;
    const priv = body.entries.filter((entry) => entry.scope === 'private');
    const pub = body.entries.filter((entry) => entry.scope === 'public');
    assert.equal(priv.length, 1, '私密条目连条数都没了 —— 日历与计数会跟着失去意义');
    assert.equal(priv[0].body, '', '锁着时私密正文还在响应里');
    assert.equal(priv[0].locked, true, '没有标记「这条在锁里」');
    assert.equal(pub[0].body, '公开的一条 #灵感');
    assert.equal(body.locked, true);
    // 反向对照：正文那句话不能以任何形式出现在响应里（防止「只清了 body，source 还带着」）。
    assert.ok(!JSON.stringify(body).includes('只有我能看'), '响应里还能找到私密原文');
  });

  it('★ 搜索、标签、时间轴都不再包含私密', async () => {
    const search = await call(`/search?q=${encodeURIComponent('只有我能看')}`);
    assert.equal(search.json.hits.length, 0, '锁着时还能搜到私密正文');
    const tags = await call('/tags');
    assert.ok(!JSON.stringify(tags.json).includes('只有我能看'));
    const timeline = await call('/timeline');
    assert.ok(!JSON.stringify(timeline.json).includes('只有我能看'));
  });

  it('★ 导出含私密 ⇒ 403；删私密 ⇒ 403', async () => {
    const exported = await call('/export?private=1');
    assert.equal(exported.status, 403);
    assert.equal(exported.json.code, 'GATE_LOCKED');
    const removed = await call(`/day/${DAY}/entry/0?scope=private`, { method: 'DELETE' });
    assert.equal(removed.status, 403, '锁着时还能删私密条目');
  });

  it('★ 反向对照：解锁之后同一个 /day 必须能看到正文', async () => {
    const unlocked = await call('/gate/unlock', { method: 'POST', json: { passphrase: 'open sesame' } });
    assert.equal(unlocked.status, 200);
    const res = await call(`/day/${DAY}`);
    const priv = res.json.entries.find((entry) => entry.scope === 'private');
    assert.equal(priv.body, '这句话只有我能看');
    assert.equal(res.json.locked, undefined);
  });
});

describe('口令路由', () => {
  it('GET /gate 报状态，锁上之后 unlocked 是 false', async () => {
    await call('/gate/lock', { method: 'POST' });
    const res = await call('/gate');
    assert.equal(res.status, 200);
    assert.equal(res.json.set, true);
    assert.equal(res.json.unlocked, false);
  });

  it('错口令 401（不是 400 —— 这不是「请求格式不对」）', async () => {
    const res = await call('/gate/unlock', { method: 'POST', json: { passphrase: 'nope-nope' } });
    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'GATE_WRONG');
  });

  it('没接闸门的老实例仍然照旧返回私密（可选依赖，不是静默降级）', async () => {
    // 这条是给「只接老依赖」的宿主留的：闸门缺失时路由不该 500，也不该假装锁着
    // —— 那种机器上本来就没有口令这层。
    const legacy = makeDiaryRoutes({
      read: (date) => store.read(date),
      append: (entry) => store.append(entry),
      removeEntry: (entry) => store.removeEntry(entry),
      listMonth: (month) => store.listMonth(month),
      search: (options) => store.search(options),
      exportAll: (options) => store.exportAll(options),
      stats: () => store.stats(),
      log: () => {},
    });
    const res = fakeRes();
    await legacy.handler(fakeReq({ url: `${API}/gate` }), res);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, set: false, unlocked: true, available: false });
  });
});
