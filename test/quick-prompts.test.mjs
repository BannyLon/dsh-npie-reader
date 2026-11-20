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
import { BOOK_DEFAULT_PROMPTS, DEFAULT_PROMPTS, PAPER_DEFAULT_PROMPTS, readQuickPrompts, saveQuickPrompts, scopedQuickPrompts } from '../src/client/quick-prompts.js';

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

/**
 * 第三套：论文伴读。
 *
 * ★ 论文与电子书共用同一个面板组件（`BookCompanion`），所以「提问套餐」是两者
 *   唯一的体验差异点之一。抄书那套的后果不只是措辞不对：书的三条都以「这一页
 *   讲了什么」为单位，而读论文真正会卡住的是「这一页在整篇论证里的位置」和
 *   「证据够不够」—— 问错了，模型就只好把一页散文当书讲。
 */
describe('第三套：论文伴读', () => {
  test('默认三条按论证结构组织，不是书那套换词', () => {
    assert.notDeepEqual(PAPER_DEFAULT_PROMPTS, BOOK_DEFAULT_PROMPTS);
    const bookBodies = new Set(BOOK_DEFAULT_PROMPTS.map((item) => item.body));
    assert.ok(PAPER_DEFAULT_PROMPTS.every((item) => !bookBodies.has(item.body)), '论文的条目与书重复');
    // 每一条都得指向「这一页 / 这一篇」—— 宿主只给这一页，让它答整篇就是逼它编。
    assert.ok(PAPER_DEFAULT_PROMPTS.every((item) => item.body.includes('这一页') || item.body.includes('这一篇')));
  });

  test('paper 走自己的键，与 article / book 互不串扰', () => {
    const { store } = stubStorage();
    const mine = [{ id: 'p', title: 'P', body: '论' }];
    saveQuickPrompts(mine, 'paper');
    assert.deepEqual(readQuickPrompts('paper'), mine);
    assert.equal(store.get('npr.paper-quick-prompts.v1'), JSON.stringify(mine));
    // 书那套没被碰过 —— 没存过就是默认集，不是论文那套。
    assert.deepEqual(readQuickPrompts('book'), BOOK_DEFAULT_PROMPTS);
    assert.ok(!store.has('npr.book-quick-prompts.v1'));
  });

  test('★ 反向对照：未知作用域仍退回文章那套（老行为不变）', () => {
    stubStorage();
    assert.deepEqual(readQuickPrompts('nonsense'), DEFAULT_PROMPTS);
    assert.deepEqual(readQuickPrompts(), DEFAULT_PROMPTS);
  });
});

describe('scopedQuickPrompts（article 特有）不受双作用域影响', () => {  test('有选段时内置条目换成「选段」措辞，自定义条目原样保留', () => {
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
