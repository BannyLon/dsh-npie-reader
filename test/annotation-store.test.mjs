/**
 * 划线 / 笔记的**磁盘层**（`src/host/annotation-store.js`）。
 *
 * 这一层的三条硬要求，每条都对应一种「用户会真的气到」的失败：
 *   ① 写进去的东西下次打开还在（原子写、坏文件不吞）；
 *   ② 连点两下不会丢一条（读-改-写串行）；
 *   ③ `bookId` 不能拼出别的路径（它从 HTTP 路径来）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MAX_ITEMS, TONES, createAnnotationStore, normalizeAnnotation } from '../src/host/annotation-store.js';

const roots = [];
async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), `npr-ann-${process.pid}-`));
  roots.push(root);
  return { root, store: createAnnotationStore({ rootDir: root }) };
}

after(async () => {
  /**
   * ★ 清理失败**不算测试失败**：某些沙箱（含本机的安全策略）会在 `rm` 上回 EPERM，
   *   而那是环境限制，不是被测代码的问题。这里吞掉 —— 临时目录由系统回收。
   *   （本仓库另有几个老测试没吞，所以全量跑时会看到它们的 EPERM，与本文件无关。）
   */
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

const BOOK = 'b-abc_123';
const SAMPLE = { page: 12, start: 100, end: 140, quote: '因为，将生活归入幻想和梦想的例子' };

describe('annotation-store：写 / 读', () => {
  it('加一条之后能读回，字段完好且落在 annotations/<bookId>.json', async () => {
    const { root, store } = await makeStore();
    const { items, item, duplicate } = await store.add(BOOK, SAMPLE);
    assert.equal(duplicate, false);
    assert.equal(items.length, 1);
    assert.equal(item.page, 12);
    assert.equal(item.tone, TONES[0]);
    assert.equal(item.note, '');
    assert.match(item.id, /^a-/);

    const again = await store.list(BOOK);
    assert.deepEqual(again, items);
    const raw = JSON.parse(await readFile(join(root, 'annotations', `${BOOK}.json`), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.items[0].quote, SAMPLE.quote);
  });

  it('空书返回空数组（不是错误）', async () => {
    const { store } = await makeStore();
    assert.deepEqual(await store.list('b-empty'), []);
  });

  it('同页同区间重复加 ⇒ 返回已有的那条，不新增', async () => {
    const { store } = await makeStore();
    const first = await store.add(BOOK, SAMPLE);
    const second = await store.add(BOOK, SAMPLE);
    assert.equal(second.duplicate, true);
    assert.equal(second.item.id, first.item.id);
    assert.equal(second.items.length, 1);
  });

  it('排序按页码 → 起点', async () => {
    const { store } = await makeStore();
    await store.add(BOOK, { ...SAMPLE, page: 30, start: 5, end: 10 });
    await store.add(BOOK, { ...SAMPLE, page: 2, start: 80, end: 90 });
    await store.add(BOOK, { ...SAMPLE, page: 2, start: 10, end: 20 });
    const items = await store.list(BOOK);
    assert.deepEqual(items.map(item => `${item.page}:${item.start}`), ['2:10', '2:80', '30:5']);
  });
});

describe('annotation-store：校验', () => {
  const bad = [
    ['页码为 0', { ...SAMPLE, page: 0 }],
    ['终点不大于起点', { ...SAMPLE, start: 140, end: 140 }],
    ['起点为负', { ...SAMPLE, start: -1 }],
    ['摘录为空', { ...SAMPLE, quote: '   ' }],
    ['颜色不认识', { ...SAMPLE, tone: 'purple' }],
    ['笔记超长', { ...SAMPLE, note: 'x'.repeat(4001) }],
  ];
  for (const [label, input] of bad) {
    it(`拒绝：${label}`, async () => {
      const { store } = await makeStore();
      await assert.rejects(() => store.add(BOOK, input), /页码|终点|起点|摘录|颜色|笔记/);
      assert.equal((await store.list(BOOK)).length, 0, '被拒绝的条目不该落盘');
    });
  }

  it('normalizeAnnotation 丢掉不认识的字段（客户端不能借 extras 改数据源）', () => {
    const item = normalizeAnnotation({ ...SAMPLE, bookId: 'other', createdAt: 5, evil: 1 });
    assert.equal(item.bookId, undefined);
    assert.equal(item.evil, undefined);
    assert.equal(item.createdAt, 5);
  });
});

describe('annotation-store：改 / 删', () => {
  it('update 只改笔记与颜色，位置不动', async () => {
    const { store } = await makeStore();
    const { item } = await store.add(BOOK, SAMPLE);
    const updated = await store.update(BOOK, item.id, { note: '这里说的是生活与艺术', tone: 'green' });
    assert.equal(updated.item.note, '这里说的是生活与艺术');
    assert.equal(updated.item.tone, 'green');
    assert.equal(updated.item.start, SAMPLE.start);
    assert.equal(updated.item.page, SAMPLE.page);
    assert.deepEqual(updated.items, await store.list(BOOK));
  });

  it('update 不存在的 id 报错（面板会显示一句能懂的话）', async () => {
    const { store } = await makeStore();
    await assert.rejects(() => store.update(BOOK, 'a-nope', { note: 'x' }), /已经不在了/);
  });

  it('remove 删掉一条；删不存在的 id 不报错', async () => {
    const { store } = await makeStore();
    const { item } = await store.add(BOOK, SAMPLE);
    const { items, removed } = await store.remove(BOOK, item.id);
    assert.equal(removed, true);
    assert.equal(items.length, 0);
    const again = await store.remove(BOOK, item.id);
    assert.equal(again.removed, false);
  });
});

describe('annotation-store：健壮性', () => {
  it('并发 add 五条 ⇒ 一条都不丢（读-改-写必须串行）', async () => {
    const { store } = await makeStore();
    await Promise.all([0, 1, 2, 3, 4].map(index => store.add(BOOK, {
      page: 1, start: index * 100, end: index * 100 + 10, quote: `第 ${index} 段`,
    })));
    const items = await store.list(BOOK);
    assert.equal(items.length, 5, '并发写丢了条目 —— 串行队列失效');
  });

  it('坏掉的 JSON ⇒ 当作没有划线，但**留一份备份**', async () => {
    const { root, store } = await makeStore();
    await store.add(BOOK, SAMPLE);
    const file = join(root, 'annotations', `${BOOK}.json`);
    await writeFile(file, '{ 这不是 JSON', 'utf8');
    const items = await store.list(BOOK);
    assert.deepEqual(items, []);
    const names = await readdir(join(root, 'annotations'));
    assert.ok(names.some(name => name.includes('.broken-')), '坏文件没有被备份，用户的划线就真没了');
  });

  it('非法 bookId 直接抛（不能拼出别的路径）', async () => {
    const { store } = await makeStore();
    for (const id of ['../etc', 'a/b', '', 'a'.repeat(65)]) {
      await assert.rejects(() => store.list(id), TypeError);
    }
  });

  it('文件里单个坏条目只丢那一条，其余照样能读', async () => {
    const { root, store } = await makeStore();
    await store.add(BOOK, SAMPLE);
    const file = join(root, 'annotations', `${BOOK}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.items.push({ id: 'a-bad', page: 'NaN', start: 0, end: 1, quote: 'x' });
    await writeFile(file, JSON.stringify(raw), 'utf8');
    const items = await store.list(BOOK);
    assert.equal(items.length, 1);
  });

  it('上限常量是个正数（到顶时 add 会明确拒绝，而不是静默丢最早的）', () => {
    assert.ok(Number.isInteger(MAX_ITEMS) && MAX_ITEMS > 100);
  });
});
