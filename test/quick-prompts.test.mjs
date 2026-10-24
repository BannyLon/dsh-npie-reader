/**
 * 快捷提示词的双作用域：文章伴读（RSS）与电子书伴读各一套。
 *
 * ★ 分两套不是整洁癖：文章的提问以「这篇 / 选段」为单位（翻译全文、追问证据），
 *   书的提问以「当前这一页」为单位（解释这一页、梳理要点）—— 混在一起会让
 *   「翻译全文」出现在只有一页扫描件的伴读里。
 *
 * ★ 兼容硬约束：`npr.quick-prompts.v1` 这个键从单套时代就在用，article 必须
 *   **原键续用** —— 改键等于让所有老用户丢一次配置。
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { BOOK_DEFAULT_PROMPTS, DEFAULT_PROMPTS, readQuickPrompts, saveQuickPrompts, scopedQuickPrompts } from '../src/client/quick-prompts.js';

/** 够用的假 localStorage + window（模块直接引用全局裸名）。 */
function stubStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const events = [];
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  return { store, events };
}

afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
});

describe('双作用域各自一套', () => {
  test('默认集不同：文章以「这篇/选段」为单位，书以「这一页」为单位', () => {
    assert.ok(DEFAULT_PROMPTS.some((item) => item.body.includes('这篇文章')));
    assert.ok(BOOK_DEFAULT_PROMPTS.every((item) => item.body.includes('当前这一页') || item.body.includes('这一页')));
    assert.notDeepEqual(DEFAULT_PROMPTS, BOOK_DEFAULT_PROMPTS);
  });

  test('★ article 原键续用（改键 = 老用户丢一次配置）', () => {
    const legacy = JSON.stringify([{ id: 'custom', title: '老配置', body: '留着' }]);
    const { store } = stubStorage({ 'npr.quick-prompts.v1': legacy });
    assert.deepEqual(readQuickPrompts('article'), [{ id: 'custom', title: '老配置', body: '留着' }]);
    assert.ok(store.has('npr.quick-prompts.v1'));
  });

  test('book 走自己的键，读写互不串扰', () => {
    const { store } = stubStorage();
    saveQuickPrompts([{ id: 'a', title: 'A', body: '甲' }], 'book');
    assert.deepEqual(readQuickPrompts('book'), [{ id: 'a', title: 'A', body: '甲' }]);
    assert.equal(store.get('npr.book-quick-prompts.v1'), JSON.stringify([{ id: 'a', title: 'A', body: '甲' }]));
    // 文章那套没被碰到 —— 没存过就是默认集，不是空、也不是书那套。
    assert.deepEqual(readQuickPrompts('article'), DEFAULT_PROMPTS);
    assert.ok(!store.has('npr.quick-prompts.v1'));
  });

  test('损坏的数据退回默认集，不让伴读面板挂掉', () => {
    stubStorage({ 'npr.book-quick-prompts.v1': '{not json' });
    assert.deepEqual(readQuickPrompts('book'), BOOK_DEFAULT_PROMPTS);
  });

  test('条目不合规的被滤掉（缺 title/body 的脏数据不进面板）', () => {
    stubStorage({
      'npr.book-quick-prompts.v1': JSON.stringify([
        { id: 'ok', title: '好', body: '内容' },
        { id: 'no-title', body: 'x' },
        { title: 'no-body' },
        null,
        'junk',
      ]),
    });
    assert.deepEqual(readQuickPrompts('book'), [{ id: 'ok', title: '好', body: '内容' }]);
  });

  test('保存会广播 npr-prompts-changed（两边的伴读面板都靠它即时刷新）', () => {
    const { events } = stubStorage();
    saveQuickPrompts([], 'book');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'npr-prompts-changed');
  });
});

describe('scopedQuickPrompts（article 特有）不受双作用域影响', () => {
  test('有选段时内置条目换成「选段」措辞，自定义条目原样保留', () => {
    const items = [
      ...DEFAULT_PROMPTS,
      { id: 'mine', title: '自定义', body: '我的提示词' },
    ];
    const scoped = scopedQuickPrompts(items, '选中的文字');
    assert.equal(scoped.find((item) => item.id === 'summary').title, '概括选段');
    assert.equal(scoped.find((item) => item.id === 'mine').body, '我的提示词');
  });

  test('书作用域**不走**这套改写（书没有「选段」概念）', () => {
    // 判据：BOOK_DEFAULT_PROMPTS 的正文不会被 scoped 映射改掉 ——
    // scopedQuickPrompts 只认 DEFAULT_PROMPTS 里的 id+body。
    const untouched = scopedQuickPrompts(BOOK_DEFAULT_PROMPTS, '选中的文字');
    assert.deepEqual(untouched, BOOK_DEFAULT_PROMPTS);
  });
});
