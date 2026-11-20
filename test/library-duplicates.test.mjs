/**
 * 跨源重复书提示的单元测试。
 *
 * ★ 这个功能的风险**不是漏报，是误报**：书架上一枚「同名」标记会让人回去删掉一本，
 *   而删错的那一本带着阅读进度与划线（按 id 记，删了就是没了）。所以下面的判据
 *   一半在测「不该报的没报」：
 *     · 同一份书单里的同名条目 —— 用户就在同一屏看得见两行，不需要提示；
 *     · 《三体 1》《三体 2》《三体 3》—— 折叠时**保留数字**才不会被当成一本；
 *     · 书名折叠后为空（整串都是标点）—— 空键会让它们全部互相「重复」。
 * ★ 另一半在测「两档不一样」：`same`（同文件名 + 同格式 + 体积差 <2%）说的是
 *   「你重复下载了」，`title` 说的是「你可能有两个版本」。合成一档就是在替用户下结论。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateHintOf, duplicateKeyOf, findDuplicateBooks } from '../src/library.js';

/** 造一条书单条目（只写判重会用到的字段）。 */
function row(id, title, { filename = '', ext = 'epub', size = 1000, listId = 'L1', listName = '本地' } = {}) {
  return { id, title, filename: filename === '' ? `${title}.${ext}` : filename, ext, size, listId, listName };
}

/* ---------------------------------------------------------------------------
 * 折叠规则
 * ------------------------------------------------------------------------- */

test('书名折叠：书名号 / 括号 / 标点都吃掉，字与数字保留', () => {
  assert.equal(duplicateKeyOf({ title: '《九三年》' }), '九三年');
  assert.equal(duplicateKeyOf({ title: '九三年：修订版' }), '九三年修订版');
  assert.equal(duplicateKeyOf({ title: '  深度工作  ' }), '深度工作');
  assert.equal(duplicateKeyOf({ title: 'Deep Work (2016)' }), 'deepwork2016');
  // ★ 数字必须留着：去掉数字会把三部曲合并成一本。
  assert.notEqual(duplicateKeyOf({ title: '三体 1' }), duplicateKeyOf({ title: '三体 2' }));
  // 整串都是标点 ⇒ 空键，不参与判重。
  assert.equal(duplicateKeyOf({ title: '---' }), '');
  assert.equal(duplicateKeyOf({}), '');
});

/* ---------------------------------------------------------------------------
 * 该报的
 * ------------------------------------------------------------------------- */

test('跨源同名同文件 ⇒ same', () => {
  const books = [
    row('a1', '九三年', { filename: '九三年.epub', size: 1000, listId: 'L1', listName: '本地电子书' }),
    row('a2', '《九三年》', { filename: '九三年.epub', size: 1005, listId: 'L2', listName: '网盘电子书' }),
  ];
  const index = findDuplicateBooks(books);
  assert.equal(index.size, 2, '两本都该被标出来（用户可能从任意一行点开）');
  assert.equal(index.get('a1').level, 'same');
  assert.equal(index.get('a1').count, 1);
  assert.equal(index.get('a1').others[0].listName, '网盘电子书');
});

test('跨源同名但格式不同 ⇒ title（两个版本，不是重复下载）', () => {
  const books = [
    row('b1', '九三年', { filename: '九三年.epub', size: 1000, listId: 'L1' }),
    row('b2', '九三年', { filename: '九三年.mobi', ext: 'mobi', size: 1000, listId: 'L2' }),
  ];
  const index = findDuplicateBooks(books);
  assert.equal(index.get('b1').level, 'title', '不同格式被说成「同一个文件被下了两遍」—— 会让人删错版本');
});

test('跨源同名、同格式但体积差很多 ⇒ title', () => {
  const books = [
    row('c1', '九三年', { filename: '九三年.epub', size: 1000, listId: 'L1' }),
    row('c2', '九三年', { filename: '九三年.epub', size: 3000, listId: 'L2' }),
  ];
  assert.equal(findDuplicateBooks(books).get('c1').level, 'title');
});

test('三本同名（跨三个源）⇒ count 是 3-1=2，且每个人都看得到另外两本', () => {
  const books = [
    row('d1', '九三年', { listId: 'L1' }),
    row('d2', '九三年', { listId: 'L2' }),
    row('d3', '九三年', { listId: 'L3' }),
  ];
  const index = findDuplicateBooks(books);
  for (const id of ['d1', 'd2', 'd3']) {
    assert.equal(index.get(id).count, 2, `${id} 的「同名 N 本」算错了（不能把自己算进去）`);
    const peers = index.get(id).others.map((entry) => entry.id);
    assert.ok(!peers.includes(id), `${id} 把自己列成了重复项`);
    assert.equal(peers.length, 2);
  }
});

test('没有 listId 时退回 source / id：本地与网盘同名也算跨源', () => {
  const books = [
    { id: 'e1', title: '九三年', filename: '九三年.epub', ext: 'epub', size: 1000, source: 'local' },
    { id: 'e2', title: '九三年', filename: '九三年.epub', ext: 'epub', size: 1000, source: 'pan' },
  ];
  assert.equal(findDuplicateBooks(books).get('e1').level, 'same');
});

/* ---------------------------------------------------------------------------
 * 不该报的
 * ------------------------------------------------------------------------- */

test('同一份书单里的同名条目 ⇒ 不报（同一屏看得见两行）', () => {
  const books = [
    row('f1', '九三年', { listId: 'L1' }),
    row('f2', '九三年', { listId: 'L1' }),
  ];
  assert.equal(findDuplicateBooks(books).size, 0);
});

test('三部曲不会被折成一本', () => {
  const books = [
    row('g1', '三体 1', { listId: 'L1' }),
    row('g2', '三体 2', { listId: 'L2' }),
    row('g3', '三体 3', { listId: 'L3' }),
  ];
  assert.equal(findDuplicateBooks(books).size, 0, '数字被折掉了 —— 三部曲整排会被标成「同名 3 本」');
});

test('书名整串都是标点 ⇒ 不参与判重（空键会让它们互为重复）', () => {
  const books = [row('h1', '---', { listId: 'L1' }), row('h2', '...', { listId: 'L2' })];
  assert.equal(findDuplicateBooks(books).size, 0);
});

test('只有一本书 / 空书单 ⇒ 空索引', () => {
  assert.equal(findDuplicateBooks([row('i1', '九三年')]).size, 0);
  assert.equal(findDuplicateBooks([]).size, 0);
  assert.equal(findDuplicateBooks(undefined).size, 0);
});

/* ---------------------------------------------------------------------------
 * 文案
 * ------------------------------------------------------------------------- */

test('提示文案说「同名」不说「重复」，并写清代价（进度各存一份）', () => {
  const index = findDuplicateBooks([
    row('j1', '九三年', { filename: '九三年.epub', size: 1048576, listId: 'L1', listName: '本地电子书' }),
    row('j2', '九三年', { filename: '九三年.epub', size: 1048576, listId: 'L2', listName: '网盘电子书' }),
  ]);
  const hint = duplicateHintOf(index.get('j1'));
  assert.equal(hint.text, '同名 1 本');
  assert.ok(!hint.text.includes('重复'), '界面上的字说「重复」是在替用户下结论 —— 他可能因此删掉一本书');
  assert.ok(hint.tip.includes('网盘电子书'), '悬浮说明没说清是哪一份书单里的');
  assert.ok(hint.tip.includes('进度'), '悬浮说明没写代价 —— 用户没有据此决定的信息');
  // ★ 书名自己带书名号时不能再包一层（`《《九三年》》`）。
  assert.ok(!hint.tip.includes('《《'), `书名号套了两层：${hint.tip}`);
});

test('两个版本的说明里带上对方的格式与体积', () => {
  const index = findDuplicateBooks([
    row('k1', '九三年', { filename: '九三年.epub', size: 1048576, listId: 'L1' }),
    row('k2', '九三年', { filename: '九三年.mobi', ext: 'mobi', size: 2097152, listId: 'L2', listName: '网盘' }),
  ]);
  const hint = duplicateHintOf(index.get('k1'));
  assert.equal(hint.text, '同名 1 本');
  assert.ok(hint.tip.includes('MOBI'), `说明里没有对方的格式：${hint.tip}`);
  assert.ok(hint.tip.includes('2'), `说明里没有对方的体积：${hint.tip}`);
});

test('没有判重结果 ⇒ null（调用方据此不渲染空胶囊）', () => {
  assert.equal(duplicateHintOf(undefined), null);
  assert.equal(duplicateHintOf(null), null);
  assert.equal(duplicateHintOf({ count: 0, others: [] }), null);
  assert.equal(duplicateHintOf({ count: 1, others: [] }), null);
});
