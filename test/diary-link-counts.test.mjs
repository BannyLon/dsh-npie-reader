/**
 * 反向链路计数（0.88.0，`diary.linkCounts`）。
 *
 * 跨源检索里那句「写过 2 条」就是从这儿来的。它守三条：
 *
 *  1. **一次扫描搞定多个 key**。一次一个 key 的话，一屏结果就是二十遍全扫
 *     （`bySource` 能干，但它是按单 key 设计的）。这里钉的是「扫一遍，两个都数对」。
 *  2. **只认 `meta.article` / `meta.book`**，不按 `source` 那串文字猜：
 *     书名会改、标题会被截断（`《…》` 是给人看的）。
 *  3. **私密条目不算**。与 `bySource` / 周报同一条边界 —— 三处口径不一致的话，
 *     用户会看到「这里写 2 条、点进去 3 条」。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDiarySecret } from '../src/host/diary-secret.js';
import { createDiaryStore } from '../src/host/diary-store.js';

let home = '';
let store = null;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'npie-link-counts-'));
  process.env.DSH_HOME = home;
  store = createDiaryStore({
    log: () => {},
    secret: createDiarySecret({ key: Buffer.alloc(32, 7), keyPath: join(home, 'counts.key') }),
  });
});

after(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('0.88.0：反向链路计数', () => {
  it('★ 一次扫描同时数清文章与书，没提到的 key 不给 0', async () => {
    await store.append({ body: '第一篇的感想', kind: '灵感', meta: { article: 'https://a/1' } });
    await store.append({ body: '又是这篇', kind: '灵感', meta: { article: 'https://a/1' } });
    await store.append({ body: '书里的划线', kind: '灵感', meta: { book: 'b1' } });

    const counts = await store.linkCounts({
      articleKeys: ['https://a/1', 'https://a/9'],
      bookIds: ['b1'],
    });
    assert.equal(counts.articles['https://a/1'], 2);
    assert.equal(counts.articles['https://a/9'], undefined, '没写过的 key 不该给一个 0');
    assert.equal(counts.books.b1, 1);
    assert.ok(counts.scanned >= 1);
  });

  it('★ 私密条目不进计数（与 bySource / 周报同一条边界）', async () => {
    await store.append({
      body: '私密里也提到这篇', kind: '日记', vis: 'private', meta: { article: 'https://a/2' },
    });
    const counts = await store.linkCounts({ articleKeys: ['https://a/2'] });
    assert.equal(counts.articles['https://a/2'], undefined, '私密条目被算进来了');
  });

  it('★ 只认结构化字段，不按 source 文字猜', async () => {
    // 这条的 `source` 里写着书名，但**没有** `meta.book`：老数据就是这种形状。
    // 按文字猜的话它会被算到 b2 头上，而用户点进去看到的是另一本书的笔记。
    await store.append({ body: '一段没有结构引用的读后感', kind: '读后感', source: '《某本书》' });
    const counts = await store.linkCounts({ bookIds: ['某本书', 'b2'] });
    assert.equal(counts.books['某本书'], undefined);
    assert.deepEqual(counts.books, {});
  });

  it('什么都不问 ⇒ 不扫盘（回 0 且不作数）', async () => {
    const counts = await store.linkCounts({});
    assert.deepEqual(counts.articles, {});
    assert.deepEqual(counts.books, {});
    assert.equal(counts.scanned, 0);
  });

  it('非字符串 / 空串的 key 被丢掉，不炸', async () => {
    const counts = await store.linkCounts({ articleKeys: ['', null, 42, 'https://a/1'], bookIds: [undefined] });
    assert.equal(counts.articles['https://a/1'], 2, '有效 key 仍然要数到');
    assert.equal(Object.keys(counts.books).length, 0);
  });
});
