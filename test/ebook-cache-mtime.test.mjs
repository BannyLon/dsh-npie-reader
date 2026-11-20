/**
 * 本地电子书缓存加 mtime（P2）。
 *
 * 起因：缓存判据原来只有 `(块模型版本, 体积)`。用编辑器在书里改一章、字数正好
 * 没变（改标点、换同长度词），体积不变 ⇒ 插件永远读旧正文，而用户看到的是
 * 「我明明改了，它还念老的」。本地文件拿得到 mtime，就必须用上。
 *
 * ★ 这里真读真写真 stat，不用桩：`exists` 类判据最容易写成「看起来在比」。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { cacheIsStale, createEbookStore } from '../src/host/ebook/store.js';
import { EBOOK_CACHE_VERSION } from '../src/host/ebook/index.js';
import { RssService } from '../src/host/service.js';

const ROOTS = [];

async function sandbox(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `npie-${prefix}-${process.pid}-`));
  ROOTS.push(dir);
  return dir;
}

after(async () => {
  // 只删自己写的那一个文件 + 空目录：本机安全策略会拦递归删。
  for (const dir of ROOTS) {
    for (const name of ['book.txt', 'b1.json']) {
      await rm(join(dir, name), { force: true }).catch(() => {});
    }
    await rm(dir, { force: true }).catch(() => {});
  }
});

const PAYLOAD = {
  // 版本号从实现里取：写死一个数会在下次升版本时让这几条判据变成假红。
  v: EBOOK_CACHE_VERSION,
  size: 1024,
  mtimeMs: 1_700_000_000_000,
  sections: [{ title: '一', chars: 10, blocks: [{ t: 'p', x: '正文' }] }],
};

describe('缓存失效判据：版本 + 体积 +（本地书）mtime', () => {
  it('★ 体积没变、mtime 变了 ⇒ 判废（这条不生效时改动就白做了）', () => {
    assert.equal(cacheIsStale(PAYLOAD, { size: 1024, mtimeMs: 1_700_000_000_999 }), true);
  });

  it('体积与 mtime 都相同 ⇒ 命中', () => {
    assert.equal(cacheIsStale(PAYLOAD, { size: 1024, mtimeMs: 1_700_000_000_000 }), false);
  });

  it('体积变了 ⇒ 判废（原有判据不许回退）', () => {
    assert.equal(cacheIsStale(PAYLOAD, { size: 2048, mtimeMs: 1_700_000_000_000 }), true);
  });

  it('块模型版本变了 ⇒ 判废（原有判据不许回退）', () => {
    assert.equal(cacheIsStale({ ...PAYLOAD, v: -1 }, { size: 1024 }), true);
  });

  it('★ 老缓存没有 mtimeMs 字段 + 本地书传了 mtime ⇒ 判废（否则新判据等于没生效）', () => {
    const { mtimeMs, ...old } = PAYLOAD;
    assert.equal(mtimeMs, 1_700_000_000_000, '夹具里本来就没有 mtimeMs 才说明这条在测什么');
    assert.equal(cacheIsStale(old, { size: 1024, mtimeMs: 1_700_000_000_000 }), true);
  });

  it('★ 网盘书（mtime 传 0）只看体积：不能因为加判据就让网盘书每次重解析', () => {
    const { mtimeMs, ...old } = PAYLOAD;
    assert.equal(cacheIsStale(old, { size: 1024, mtimeMs: 0 }), false);
    assert.equal(cacheIsStale(PAYLOAD, { size: 1024 }), false);
  });

  it('payload 不是对象 ⇒ 判废，不抛', () => {
    for (const bad of [null, undefined, 0, 'x']) assert.equal(cacheIsStale(bad, { size: 1 }), true);
  });
});

describe('store 真落盘：mtime 参与读写往返', () => {
  const BOOK = { format: 'txt', title: '测试', author: '', warnings: [], toc: [], script: 'zh', scriptRatio: 1, sections: [{ title: '一', chars: 2, blocks: [{ t: 'p', x: '正文' }], level: 0 }] };

  it('写进去的 mtime 能被读回来；换一个 mtime 就读不到', async () => {
    const dir = await sandbox('ebcache');
    const store = createEbookStore({ rootDir: dir });
    await store.write('b1', 1024, BOOK, 1_700_000_000_000);

    const hit = await store.read('b1', 1024, 1_700_000_000_000);
    assert.ok(hit !== null, '同体积同 mtime 应当命中');
    assert.equal(hit.sections.length, 1);

    assert.equal(await store.read('b1', 1024, 1_700_000_000_001), null, 'mtime 变了还命中 = 读到旧正文');
  });

  it('不传 mtime（网盘口径）时只按体积命中', async () => {
    const dir = await sandbox('ebcache');
    const store = createEbookStore({ rootDir: dir });
    await store.write('b1', 1024, BOOK, 1_700_000_000_000);
    assert.ok((await store.read('b1', 1024)) !== null, '不传 mtime 应当命中');
    assert.ok((await store.read('b1', 1024, 0)) !== null, 'mtime=0 是「不知道」，不是「不匹配」');
  });
});

describe('service.ebookFingerprint：本地书按盘上实况，网盘返回 null', () => {
  const withLocal = (resolve) => ({ local: { resolve } });
  const samePaths = { resolve: async path => path };

  it('★ 真 stat 一个本地文件：拿到真实体积与 mtime', async () => {
    const dir = await sandbox('ebstat');
    const file = join(dir, 'book.txt');
    await writeFile(file, '第一章 正文\n第二章 正文');
    const info = await stat(file);

    const fingerprint = await RssService.prototype.ebookFingerprint.call(
      withLocal(samePaths.resolve),
      { source: 'local', localPath: file },
    );
    assert.ok(fingerprint !== null);
    assert.equal(fingerprint.size, info.size);
    assert.equal(fingerprint.mtimeMs, info.mtimeMs);
  });

  it('★ 改内容但保持体积不变：mtime 必须变（这正是只比体积漏掉的场景）', async () => {
    const dir = await sandbox('ebstat');
    const file = join(dir, 'book.txt');
    await writeFile(file, '第一章 正文');
    const before = await RssService.prototype.ebookFingerprint.call(
      withLocal(samePaths.resolve), { source: 'local', localPath: file },
    );
    // 等一毫秒再写，避免文件系统把两次写合并到同一个 mtime 刻度上。
    await new Promise(resolve => setTimeout(resolve, 12));
    await writeFile(file, '第一章 正文'.replace('正文', '本文'));
    const afterFingerprint = await RssService.prototype.ebookFingerprint.call(
      withLocal(samePaths.resolve), { source: 'local', localPath: file },
    );
    assert.equal(afterFingerprint.size, before.size, '体积必须一样，否则测不到 mtime 这条路');
    assert.notEqual(afterFingerprint.mtimeMs, before.mtimeMs);
  });

  it('网盘书 / 论文 / 没有 localPath ⇒ null，不假装有 mtime', async () => {
    const ctx = withLocal(samePaths.resolve);
    assert.equal(await RssService.prototype.ebookFingerprint.call(ctx, { source: 'pan', fsId: 1 }), null);
    assert.equal(await RssService.prototype.ebookFingerprint.call(ctx, { source: 'paper' }), null);
    assert.equal(await RssService.prototype.ebookFingerprint.call(ctx, { source: 'local', localPath: '  ' }), null);
  });

  it('文件不存在 ⇒ null（让 local.read 抛它自己那条更准的错）', async () => {
    const dir = await sandbox('ebstat');
    const fingerprint = await RssService.prototype.ebookFingerprint.call(
      withLocal(samePaths.resolve),
      { source: 'local', localPath: join(dir, 'nope.txt') },
    );
    assert.equal(fingerprint, null);
  });

  it('★ stat 走的是 local.resolve（那三道闸），不是直接读 localPath', async () => {
    let asked = '';
    await RssService.prototype.ebookFingerprint.call(
      { local: { resolve: async (path) => { asked = path; throw new Error('闸拦住了'); } } },
      { source: 'local', localPath: '../etc/passwd' },
    );
    assert.equal(asked, '../etc/passwd', '没经过 resolve 就说明闸被绕过了');
  });
});
