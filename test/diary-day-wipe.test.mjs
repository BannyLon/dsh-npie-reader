/**
 * 删掉某一天的**全部记录**（0.75.0）。
 *
 * 用户 2026-11-11：「我需要一个删除某天的全部记录」。
 *
 * ★ 这一层的价值有两件，都不在「函数被调用过」上：
 *   1. **整天删除是一次移动，不是 N 次读-改-写** —— 判据要看 `_trash/` 里那份
 *      与删除前**逐字节相同**。若哪天有人把它改成「读出来、写一份到 trash、再删原文件」，
 *      字节可能被序列化规范化掉（空行、尾随换行），恢复回来的就不再是原来那天。
 *   2. **只动一半** —— 公开与私密是两个文件，`scope` 传错一次就是删错文件。
 *      所以每条都要有反向对照：删公开时私密必须还在，删私密时公开必须还在。
 *
 * ★ 用真的文件系统（临时 `DSH_HOME`），不 mock `node:fs`：`rename` 与
 *   `mkdir -p` 的行为正是这层的全部内容。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DIARY_API_PREFIX } from '../src/diary-format.js';
import {
  createDiaryStore, diaryFilePath, diaryPrivateFilePath, diaryRoot,
} from '../src/host/diary-store.js';
import { createDiarySecret } from '../src/host/diary-secret.js';
import { makeDiaryRoutes } from '../src/host/diary-routes.js';

let home = '';
let store = null;

before(async () => {
  home = await mkdtemp(join(tmpdir(), `npie-wipe-${process.pid}-`));
  // ★ 必须在造 store **之前**：`pluginDataDir()` 每次现读 `$DSH_HOME`。
  process.env.DSH_HOME = home;
  store = createDiaryStore({
    log: () => {},
    // 私密那半边注入固定密钥：不碰真实钥匙串，也不因为钥匙串锁着而跳过用例。
    secret: createDiarySecret({ key: Buffer.alloc(32, 9), keyPath: join(home, 'secret.key') }),
  });
});

after(async () => {
  // 清理失败 ≠ 断言失败（沙箱有时会拦删除）。
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

const exists = async (path) => {
  try { await stat(path); return true; } catch { return false; }
};

/** 造一天的三条公开记录。返回日期。 */
async function seedPublic(date) {
  await store.append({ date, time: '09:52', kind: '灵感', body: '真需求 = 高频 × 刚需 × 普适。' });
  await store.append({ date, time: '10:29', kind: '灵感', body: '今天是个晴天' });
  await store.append({ date, time: '17:49', kind: '灵感', body: '你好啊' });
  return date;
}

describe('store.removeDay：整天删除', () => {
  it('★ 原文件消失、`_trash/` 里那份与删除前**逐字节相同**', async () => {
    const date = await seedPublic('2026-11-01');
    const before = await readFile(diaryFilePath(date), 'utf8');
    const result = await store.removeDay({ date });

    assert.equal(await exists(diaryFilePath(date)), false, '原文件还在 —— 那不是删除，是复制');
    const trashed = join(diaryRoot(), result.trashed);
    assert.equal(await exists(trashed), true, '`_trash/` 里没有备份 —— 这个动作不可逆了');
    assert.equal(await readFile(trashed, 'utf8'), before,
      '备份与原文不逐字节相同：说明它被重新序列化过，恢复回来的不是原来那一天');
  });

  it('★ 回执要说清「删了几条、多少字、去哪了」', async () => {
    const date = await seedPublic('2026-11-02');
    const result = await store.removeDay({ date });
    assert.equal(result.date, date);
    assert.equal(result.scope, 'public');
    assert.equal(result.entries, 3);
    assert.ok(result.chars > 0, `字数应该大于 0：${result.chars}`);
    assert.match(result.trashed, /^_trash\/2026-11-02@[\dTZ-]+\.md$/,
      `落点名字要能看出「删的是哪天、什么时候删的」：${result.trashed}`);
    assert.equal(result.unreadable, false);
  });

  it('再删一次：`ENTRY_NOT_FOUND`，而不是产出一份空备份', async () => {
    const date = await seedPublic('2026-11-03');
    await store.removeDay({ date });
    await assert.rejects(() => store.removeDay({ date }), (error) => error.code === 'ENTRY_NOT_FOUND');
    const trash = await readdir(join(diaryRoot(), '_trash'));
    // 那一天只该有一份备份：第二次删除没有造出 `…@…-2.md` 之类的东西。
    assert.equal(trash.filter((name) => name.startsWith('2026-11-03@')).length, 1,
      `第二次删除留下了多余的备份：${JSON.stringify(trash)}`);
  });

  it('没写过的那一天：`ENTRY_NOT_FOUND`（不是「删了 0 条」）', async () => {
    await assert.rejects(() => store.removeDay({ date: '2026-11-04' }),
      (error) => error.code === 'ENTRY_NOT_FOUND');
  });

  it('★ 日期白名单在拼路径之前：`../` 拼不出去', async () => {
    for (const date of ['../../etc/passwd', '2026-13-45', '2026-11-01/../x', '']) {
      await assert.rejects(() => store.removeDay({ date }), (error) => error.code === 'BAD_DATE', date);
    }
  });
});

describe('store.removeDay：只动 scope 指定的那一半', () => {
  it('删公开：私密文件必须还在（反向对照）', async () => {
    const date = '2026-11-05';
    await store.append({ date, time: '08:00', kind: '灵感', body: '公开的一条' });
    await store.append({ date, time: '09:00', kind: '日记', body: '私密的一条', vis: 'private' });

    await store.removeDay({ date, scope: 'public' });

    assert.equal(await exists(diaryFilePath(date)), false, '公开文件应该没了');
    assert.equal(await exists(diaryPrivateFilePath(date)), true, '私密文件被连坐删了 —— 这是删错文件');
    // 私密那半边的条目数：`readFull` 是 store 对外的合并出口（`readPrivateDay` 不外露）。
    const full = await store.readFull(date);
    assert.equal(full.entries.filter((entry) => entry.scope === 'private').length, 1);
  });

  it('删私密：公开文件必须还在（反向对照）', async () => {
    const date = '2026-11-06';
    await store.append({ date, time: '08:00', kind: '灵感', body: '公开的一条' });
    await store.append({ date, time: '09:00', kind: '日记', body: '私密的一条', vis: 'private' });

    const result = await store.removeDay({ date, scope: 'private' });

    assert.equal(result.scope, 'private');
    assert.match(result.trashed, /\.enc$/, `私密备份要带 .enc：${result.trashed}`);
    assert.equal(await exists(diaryPrivateFilePath(date)), false, '私密文件应该没了');
    assert.equal(await exists(diaryFilePath(date)), true, '公开文件被连坐删了 —— 这是删错文件');
  });

  it('★ 私密解不开时仍然允许删（否则坏文件永远清不掉）', async () => {
    const date = '2026-11-07';
    await store.append({ date, time: '09:00', kind: '日记', body: '私密的一条', vis: 'private' });
    const file = diaryPrivateFilePath(date);
    // 把信封改坏：解不开，但文件确实在那里。
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{"v":1,"iv":"AAAA","tag":"AAAA","data":"AAAA"}', 'utf8');

    const result = await store.removeDay({ date, scope: 'private' });
    assert.equal(result.unreadable, true, '解不开却没标记 —— 回执会编一个数字出来');
    assert.equal(result.entries, 0);
    assert.equal(await exists(file), false);
  });
});

// ---- 路由层 -------------------------------------------------------------

function fakeReq({ url, method = 'GET', headers = {} } = {}) {
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:52431', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
  req[Symbol.asyncIterator] = async function* iterate() { /* 这个路由不需要 body */ };
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      return this;
    },
    on() { return this; },
    destroy() { return this; },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

const noop = async () => ({});

/** 造一套路由；`removeDay` / `gate` 可覆盖，用来测「没接上」与「锁着」。 */
function routesWith(overrides = {}) {
  const handlers = {
    read: noop, append: noop, updateEntry: noop, removeEntry: noop,
    listMonth: noop, dashboard: noop, search: noop, tags: noop, timeline: noop,
    byBook: noop, bySource: noop, reflections: noop, exportAll: noop, stats: noop,
    removeDay: (input) => store.removeDay(input),
    ...overrides,
  };
  return makeDiaryRoutes(handlers);
}

async function call(routes, options) {
  const res = fakeRes();
  await routes.handler(fakeReq(options), res);
  return res;
}

describe('DELETE /day/:date', () => {
  it('200 且回执里带 `trashed`（用户要知道去哪儿找回来）', async () => {
    const date = await seedPublic('2026-11-08');
    const res = await call(routesWith(), { url: `${DIARY_API_PREFIX}/day/${date}`, method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.entries, 3);
    assert.match(res.json.trashed, /^_trash\//);
  });

  it('★ 私密那半边锁着时 403，且文件一条没少', async () => {
    const date = '2026-11-09';
    await store.append({ date, time: '09:00', kind: '日记', body: '私密的一条', vis: 'private' });
    const res = await call(routesWith({ gate: { allow: () => false } }),
      { url: `${DIARY_API_PREFIX}/day/${date}?scope=private`, method: 'DELETE' });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'GATE_LOCKED');
    assert.equal(await exists(diaryPrivateFilePath(date)), true, '被拒的请求竟然删掉了文件');
  });

  it('★ 公开那半边不受闸门影响（它本来就在明面上）', async () => {
    const date = await seedPublic('2026-11-10');
    const res = await call(routesWith({ gate: { allow: () => false } }),
      { url: `${DIARY_API_PREFIX}/day/${date}`, method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(await exists(diaryFilePath(date)), false);
  });

  it('没接上 `removeDay` 时退化成 501，不是 500', async () => {
    const res = await call(routesWith({ removeDay: undefined }),
      { url: `${DIARY_API_PREFIX}/day/2026-11-11`, method: 'DELETE' });
    assert.equal(res.status, 501);
    assert.equal(res.json.ok, false);
  });

  it('PUT /day/:date 是 405（不要把它读成「删除」）', async () => {
    const res = await call(routesWith(), { url: `${DIARY_API_PREFIX}/day/2026-11-11`, method: 'PUT' });
    assert.equal(res.status, 405);
  });

  it('GET /day/:date 仍然是读（没被删除分支吃掉）', async () => {
    const res = await call(routesWith({ readFull: async () => ({ date: '2026-11-11', entries: [] }) }),
      { url: `${DIARY_API_PREFIX}/day/2026-11-11`, method: 'GET' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });
});
