/**
 * 缓存上限与淘汰（2026-10-25）。
 *
 * 这个文件存在的理由：这一层写错的两个方向都是**不可逆**的 ——
 *   ① 少删了：上限形同虚设，磁盘迟早满，而那时用户看到的是 `ENOSPC`；
 *   ② 多删了：把**花模型调用换来的解读**删掉，用户再点一次要重新付钱。
 * 所以这里既要真跑文件系统，也要钉住「删了什么」和「**没删什么**」。
 *
 * ★ 反向对照是这组用例的核心：一个「什么都不删」的实现能让所有断言变绿
 *   （因为「解读还在」它天然满足）。所以每条「保留了 X」的断言旁边，都必须有
 *   一条「Y 真的被删了 / 体积真的降了」的断言 —— 否则这条用例只是在数自己打的字。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  CACHE_LIMITS, RECOMPUTABLE_PARTS, clearRecomputable, enforceDigestBudget, formatBytes,
  measureBackups, measureDigestCache, pathBytes, planPrune, pruneBackups,
} from '../src/host/cache-budget.js';

let root = '';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'npie-cache-'));
});

after(async () => {
  // 清理失败不该让用例变红：临时目录没删掉和断言失败是两件事（沙箱偶尔拒绝删除）。
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** 造一本书的解读目录：`sizes` 决定各部分多大，`at` 决定「最近用过」的时间。 */
async function makeBook(digestsDir, id, { text = 0, digest = 0, ocr = 0, pages = 0, at = Date.now() } = {}) {
  const dir = join(digestsDir, id);
  await mkdir(join(dir, 'text'), { recursive: true });
  await mkdir(join(dir, 'digest'), { recursive: true });
  await writeFile(join(dir, 'meta.json'), '{"v":1}');
  await writeFile(join(dir, 'outline.json'), '[]');
  if (text > 0) await writeFile(join(dir, 'text', 'ch01.txt'), 'x'.repeat(text));
  if (digest > 0) await writeFile(join(dir, 'digest', 'ch01.json'), 'y'.repeat(digest));
  if (ocr > 0) await writeFile(join(dir, 'ocr.json'), 'z'.repeat(ocr));
  if (pages > 0) await writeFile(join(dir, 'pages.jsonl'), 'w'.repeat(pages));
  // 把**所有**文件的 mtime 都设成同一个值：`latestMtime` 取的是最大值。
  const when = new Date(at);
  await utimes(join(dir, 'meta.json'), when, when);
  await utimes(join(dir, 'outline.json'), when, when);
  for (const part of ['text/ch01.txt', 'digest/ch01.json', 'ocr.json', 'pages.jsonl']) {
    await utimes(join(dir, part), when, when).catch(() => {});
  }
  return dir;
}

async function exists(path) {
  return (await stat(path).catch(() => null)) !== null;
}

describe('formatBytes：数字要说成人话', () => {
  it('0 / 负数 / 非数字 ⇒ `0 B`（绝不能显示 `NaN B`）', () => {
    for (const bad of [0, -1, Number.NaN, undefined, null, 'abc']) {
      assert.equal(formatBytes(bad), '0 B', `${String(bad)} 没有落成 0 B`);
    }
  });

  it('1024 进制，≥100 给整数、其余一位小数（`512.0 MB` 会被读成精度很高）', () => {
    assert.equal(formatBytes(900), '900 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024 + 300 * 1024), '5.3 MB');
    assert.equal(formatBytes(CACHE_LIMITS.digestBytes), '512 MB');
    assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
  });
});

describe('planPrune：删哪几个（纯函数）', () => {
  it('没超上限 ⇒ 一个都不删', () => {
    const plan = planPrune({
      entries: [{ key: 'a', bytes: 10, at: 1 }, { key: 'b', bytes: 10, at: 2 }],
      limitBytes: 100,
    });
    assert.deepEqual(plan.remove, []);
    assert.equal(plan.over, false);
  });

  it('★ 超了就从**最旧**的开始删，删到不超为止（不是只删一个）', () => {
    const plan = planPrune({
      entries: [
        { key: 'new', bytes: 40, at: 300 },
        { key: 'old', bytes: 40, at: 100 },
        { key: 'mid', bytes: 40, at: 200 },
      ],
      limitBytes: 50,
    });
    assert.deepEqual(plan.remove, ['old', 'mid'], '顺序必须是从旧到新，且删到 40 ≤ 50 就停');
    assert.equal(plan.freed, 80);
    assert.equal(plan.over, false);
  });

  it('★ `protect` 里的不删 —— 刚生成的那本不能被自己的预算淘汰', () => {
    const plan = planPrune({
      entries: [{ key: 'reading', bytes: 100, at: 1 }, { key: 'other', bytes: 100, at: 2 }],
      limitBytes: 10,
      protect: new Set(['reading']),
    });
    assert.deepEqual(plan.remove, ['other']);
    assert.equal(plan.over, true, '删光了还是超 ⇒ 必须如实说 over，不能当成功');
  });

  it('★ 反向对照：不夹取的实现（删一个就收工）在这里会剩下 80 > 50', () => {
    const naive = (entries, limit) => (entries.reduce((s, e) => s + e.bytes, 0) > limit ? [entries[0].key] : []);
    const entries = [{ key: 'old', bytes: 40, at: 1 }, { key: 'mid', bytes: 40, at: 2 }, { key: 'new', bytes: 40, at: 3 }];
    assert.deepEqual(naive(entries, 50), ['old'], '对照侧居然不是「只删一个」，那这条断言抓不住东西');
    assert.notDeepEqual(planPrune({ entries, limitBytes: 50 }).remove, naive(entries, 50));
  });

  it('脏数据不炸：非数组 / 缺字段 / 负字节一律跳过', () => {
    assert.deepEqual(planPrune().remove, []);
    assert.deepEqual(planPrune({ entries: null, limitBytes: 10 }).remove, []);
    assert.deepEqual(planPrune({
      entries: [{ key: 'ok', bytes: 5, at: 1 }, { bytes: 99 }, { key: 1, bytes: 5 }, { key: 'neg', bytes: -5, at: 0 }, null],
      limitBytes: 0,
    }).remove, ['ok']);
  });
});

describe('真目录：解读缓存的体积与淘汰', () => {
  let digestsDir = '';

  before(async () => {
    digestsDir = join(root, 'digests-1');
    // 旧书 b-old：正文 4 KB + 解读 4 KB + OCR 2 KB；新书 b-new：正文 4 KB + 解读 4 KB
    await makeBook(digestsDir, 'b-old', { text: 4096, digest: 4096, ocr: 2048, pages: 1024, at: 1_000_000 });
    await makeBook(digestsDir, 'b-new', { text: 4096, digest: 4096, at: 9_000_000 });
  });

  it('量得准：`reclaimable` 只算可重算的那三样', async () => {
    const measured = await measureDigestCache({ digestsDir });
    const old = measured.books.find(book => book.id === 'b-old');
    assert.ok(old !== undefined, '没量到 b-old');
    assert.equal(old.reclaimable, 4096 + 2048 + 1024, '正文 + OCR + pages.jsonl');
    assert.ok(old.bytes > old.reclaimable, '整本体积必须大于可重算部分（解读也在里面）');
    assert.equal(measured.books.length, 2);
  });

  it('★ 超限时只删最旧那本的**可重算部分**，已生成的解读一个字节都不动', async () => {
    const before = await pathBytes(digestsDir);
    const result = await enforceDigestBudget({ digestsDir, limitBytes: before - 1 });

    assert.deepEqual(result.removed, ['b-old'], '应该只淘汰最旧的那本');
    for (const part of RECOMPUTABLE_PARTS) {
      assert.equal(await exists(join(digestsDir, 'b-old', part)), false, `${part} 没删掉，上限没生效`);
    }
    // ★ 这三条是「多删了」的防线，比上面那条更重要。
    assert.equal(await exists(join(digestsDir, 'b-old', 'digest', 'ch01.json')), true, '解读被删了 —— 那是花钱生成的');
    assert.equal(await exists(join(digestsDir, 'b-old', 'meta.json')), true, 'meta.json 被删了 —— 章节状态全丢');
    assert.equal(await exists(join(digestsDir, 'b-old', 'outline.json')), true);
    // 新的那本完全没动。
    assert.equal(await exists(join(digestsDir, 'b-new', 'text', 'ch01.txt')), true, '不该动没超出的那本');
    assert.ok(result.freed > 0, 'freed 是 0 说明根本没删东西');
  });

  it('★ 反向对照：`protect` 里的那本一个字节都不动（否则刚生成就被自己删掉）', async () => {
    const dir2 = join(root, 'digests-protect');
    await makeBook(dir2, 'b-old', { text: 4096, digest: 1024, at: 1_000_000 });
    await makeBook(dir2, 'b-fresh', { text: 4096, digest: 1024, at: 9_000_000 });
    const before = await pathBytes(dir2);
    const result = await enforceDigestBudget({ digestsDir: dir2, limitBytes: before - 1, protect: new Set(['b-old']) });
    assert.deepEqual(result.removed, ['b-fresh'], '保护的是 b-old，那就该删 b-fresh');
    assert.equal(await exists(join(dir2, 'b-old', 'text', 'ch01.txt')), true);
  });

  it('★ 清不出空间时如实说 `over: true`（不能假装成功）', async () => {
    const dir3 = join(root, 'digests-only-digest');
    await makeBook(dir3, 'b-paid', { digest: 8192 });
    const result = await enforceDigestBudget({ digestsDir: dir3, limitBytes: 1024 });
    assert.deepEqual(result.removed, [], '没有可重算的部分，不该删任何东西');
    assert.equal(result.over, true, '清不出空间却报 over: false —— 用户会以为上限已经生效');
    assert.equal(await exists(join(dir3, 'b-paid', 'digest', 'ch01.json')), true);
  });
});

describe('用户点「清理」：只清可重算的', () => {
  it('★ 清完 `digest/` 还在，`text/` `ocr.json` `pages.jsonl` 全没了', async () => {
    const dir = join(root, 'digests-clear');
    await makeBook(dir, 'b1', { text: 2048, digest: 2048, ocr: 1024, pages: 512 });
    await makeBook(dir, 'b2', { text: 2048, digest: 2048 });
    const before = await pathBytes(dir);

    const result = await clearRecomputable({ digestsDir: dir });

    assert.deepEqual(result.removed.sort(), ['b1', 'b2']);
    assert.ok(result.freed > 0 && result.freed < before, '腾出的空间必须小于总量（解读还在）');
    assert.equal(await exists(join(dir, 'b1', 'text')), false);
    assert.equal(await exists(join(dir, 'b1', 'ocr.json')), false);
    assert.equal(await exists(join(dir, 'b1', 'pages.jsonl')), false);
    assert.equal(await exists(join(dir, 'b1', 'digest', 'ch01.json')), true, '解读被删了 —— 用户点的是「清理缓存」');
    assert.equal(await exists(join(dir, 'b2', 'digest', 'ch01.json')), true);
  });
});

describe('备份文件：只留最近几份', () => {
  it('★ 按 mtime 留最新 N 份，旧的删掉；孤立的 .tmp 只删「够老」的', async () => {
    const dir = join(root, 'data-dir');
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    // 5 份备份，越靠后越新。
    for (let i = 0; i < 5; i += 1) {
      const path = join(dir, `data.json.bak-2026-10-0${i + 1}`);
      await writeFile(path, 'x'.repeat(100));
      await utimes(path, new Date(now - (5 - i) * 60_000), new Date(now - (5 - i) * 60_000));
    }
    // 一个两小时前的残留 tmp（该删）+ 一个 1 秒前的（可能是正在写的，不许删）。
    const oldTmp = join(dir, 'data.json.4242.tmp');
    const liveTmp = join(dir, 'data.json.4343.tmp');
    await writeFile(oldTmp, 'y'.repeat(50));
    await writeFile(liveTmp, 'z'.repeat(50));
    await utimes(oldTmp, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));

    const measured = await measureBackups({ dataDir: dir, now });
    assert.equal(measured.count, 5);
    assert.equal(measured.orphans, 1, '只有那个够老的 tmp 算残留');

    const result = await pruneBackups({ dataDir: dir, keep: 2, now });
    const left = (await readdir(dir)).filter(name => name.startsWith('data.json.bak-'));
    assert.equal(left.length, 2, `应该只剩 2 份，实际 ${left.length}`);
    assert.deepEqual(left.sort(), ['data.json.bak-2026-10-04', 'data.json.bak-2026-10-05'], '留下的必须是最新的两份');
    assert.equal(await exists(oldTmp), false, '两小时前的残留 tmp 没删');
    assert.equal(await exists(liveTmp), true, '刚写的 tmp 被删了 —— 可能正在保存');
    assert.ok(result.freed > 0);
  });
});
