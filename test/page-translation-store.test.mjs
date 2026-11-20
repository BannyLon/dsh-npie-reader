/**
 * PDF 页译文落盘缓存（0.71.0）。
 *
 * 重点不是「能读写 JSON」，而是三条会静默出错的契约：
 *   ① 逐页写、整本读 —— 写第 2 页不能把第 1 页抹掉；
 *   ② 译文里编造的 id 不落盘（会让中文盖到别的段落框上）；
 *   ③ bookId 是路径的一部分，非法 id 必须在拼路径之前被挡住。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_PARAGRAPHS, MAX_TEXT_CHARS, createPageTranslationStore, normalizePageTranslation,
} from '../src/host/page-translation-store.js';

let seq = 0;
function freshStore() {
  const root = mkdtempSync(join(tmpdir(), `npr-page-trans-${process.pid}-${seq += 1}-`));
  return { root, store: createPageTranslationStore({ rootDir: root }) };
}

const PAGE = {
  paragraphs: [
    { id: 'p1', text: 'Attention is all you need.' },
    { id: 'p2', text: 'The transformer is simple.' },
  ],
  translations: [
    { id: 'p1', text: '注意力就是你所需要的一切。' },
    { id: 'p2', text: 'Transformer 很简单。' },
    { id: 'made-up', text: '编造的段落' },
  ],
};

describe('页记录的归一化', () => {
  it('只保留原文里存在的段落 id', () => {
    const record = normalizePageTranslation(PAGE, 3);
    assert.equal(record.page, 3);
    assert.deepEqual(record.paragraphs, PAGE.paragraphs);
    assert.deepEqual(record.translations.map(item => item.id), ['p1', 'p2']);
  });

  /**
   * ★ 回归：真实论文的段落 id 是 `0:text:12`（带冒号）。
   *
   * 0.71.0–0.71.2 用 `/^[A-Za-z0-9_-]{1,64}$/` 校验，把这些**合法** id 全滤掉，
   * 于是 `paragraphs` 为空、`putPage` 抛「这一页没有段落」、路由回 400、客户端
   * 按软失败吞掉 —— 磁盘上一页都没写下来，用户每次重开都要重新翻译。
   * 这条用例量的是「真页面记录必须存得下」，不是「随便什么字符串都放行」。
   */
  it('★ 真实分段的 id（`0:text:12`）要能落盘，控制字符仍要被丢掉', () => {
    const real = {
      paragraphs: [
        { id: '0:text:0', text: 'We present DeepSeek-VL, an open-source model.' },
        { id: '0:text:1', text: 'Data Construction: We strive to ensure…' },
      ],
      translations: [
        { id: '0:text:0', text: '我们提出 DeepSeek-VL，一个开源模型。' },
        { id: '0:bad\u0007', text: '带控制字符的 id 不该进文件' },
      ],
    };
    const record = normalizePageTranslation(real, 1);
    assert.deepEqual(record.paragraphs.map(item => item.id), ['0:text:0', '0:text:1']);
    assert.deepEqual(record.translations.map(item => item.id), ['0:text:0']);
  });

  it('页码、段落数、单段长度都要挡住', () => {
    assert.throws(() => normalizePageTranslation(PAGE, 0), /页码/);
    assert.throws(() => normalizePageTranslation(PAGE, 1.5), /页码/);
    assert.throws(() => normalizePageTranslation({ ...PAGE, paragraphs: [] }, 1), /没有段落/);
    assert.throws(() => normalizePageTranslation({
      paragraphs: Array.from({ length: MAX_PARAGRAPHS + 1 }, (_, i) => ({ id: `p${i}`, text: 'x' })),
      translations: [{ id: 'p0', text: 'x' }],
    }, 1), /超过/);
    assert.throws(() => normalizePageTranslation({
      paragraphs: [{ id: 'p1', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }],
      translations: [{ id: 'p1', text: '译文' }],
    }, 1), /超过/);
  });

  it('客户端多塞的字段不会进文件', () => {
    const record = normalizePageTranslation({ ...PAGE, bookId: 'another', evil: true }, 1);
    assert.equal(record.bookId, undefined);
    assert.equal(record.evil, undefined);
  });
});

describe('逐页写、整本读', () => {
  it('空目录 ⇒ {}；写两页 ⇒ 两页都在；重开 store 仍能读回', async () => {
    const { root, store } = freshStore();
    assert.deepEqual(await store.list('paper-1'), {});
    await store.putPage('paper-1', 1, PAGE);
    await store.putPage('paper-1', 2, { ...PAGE, paragraphs: [{ id: 'q1', text: 'Second page.' }], translations: [{ id: 'q1', text: '第二页。' }] });
    const pages = await store.list('paper-1');
    assert.deepEqual(Object.keys(pages).sort(), ['1', '2']);
    assert.equal(pages['1'].translations.length, 2);
    assert.equal(pages['2'].translations[0].text, '第二页。');

    const reopened = createPageTranslationStore({ rootDir: root });
    assert.deepEqual(Object.keys(await reopened.list('paper-1')).sort(), ['1', '2']);
  });

  it('一页一个文件，写第 2 页不重写第 1 页的文件', async () => {
    const { store } = freshStore();
    await store.putPage('paper-1', 1, PAGE);
    const first = readFileSync(store.fileOf('paper-1', 1), 'utf8');
    await store.putPage('paper-1', 2, PAGE);
    assert.equal(readFileSync(store.fileOf('paper-1', 1), 'utf8'), first);
    assert.equal(dirname(store.fileOf('paper-1', 2)), store.bookDir('paper-1'));
  });

  it('覆盖同一页只换这一页；清空只清这本书', async () => {
    const { store } = freshStore();
    await store.putPage('a', 1, PAGE);
    await store.putPage('b', 1, PAGE);
    await store.putPage('a', 1, { paragraphs: [{ id: 'p1', text: 'new' }], translations: [{ id: 'p1', text: '新' }] });
    assert.equal((await store.list('a'))['1'].translations[0].text, '新');
    const result = await store.clearBook('a');
    assert.equal(result.removed, 1);
    assert.deepEqual(await store.list('a'), {});
    assert.equal((await store.list('b'))['1'].paragraphs.length, 2);
    assert.deepEqual(await store.counts(), { b: 1 });
  });

  it('非法 bookId 在拼路径之前就抛（路径穿越）', async () => {
    const { store } = freshStore();
    for (const id of ['../evil', 'a/b', '', 'a b']) {
      assert.throws(() => store.bookDir(id), /非法 bookId/);
      await assert.rejects(() => store.list(id), /非法 bookId/);
    }
  });

  it('坏掉的单个 JSON 只丢这一页，并记一行日志', async () => {
    const { root } = freshStore();
    const logs = [];
    const withLog = createPageTranslationStore({ rootDir: root, log: message => logs.push(message) });
    await withLog.putPage('paper-1', 1, PAGE);
    // 直接写一个坏文件到同目录（模拟写到一半断电）。
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join: joinPath } = await import('node:path');
    mkdirSync(withLog.bookDir('paper-1'), { recursive: true });
    writeFileSync(joinPath(withLog.bookDir('paper-1'), 'p2.json'), '{broken', 'utf8');
    const pages = await withLog.list('paper-1');
    assert.deepEqual(Object.keys(pages), ['1']);
    assert.equal(logs.length, 1);
  });
});
