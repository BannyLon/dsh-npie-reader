/**
 * 日记侧栏的上下文（`src/reading-scope.js` 的 `diaryContext`）。
 *
 * ★ 这个函数输出的**是给模型的契约**，不是文案装饰。它一旦和 `tools.js` 里真实
 *   存在的工具对不上，模型就会照着上下文里的说法去行动 —— 而它没有那个能力。
 *   两种失败都很具体：
 *     - 上下文说「不能改文件」⇒ 模型拒绝追加，用户点了按钮却什么也没发生；
 *     - 上下文没说「只能追加」⇒ 模型回「已经改好了」，而日记里要么没变、要么多一条。
 *
 * ★ 所以本文件最要紧的两条断言是**否定式**的：
 *   ① 输出里**不能**出现 `READING_CONTEXT_INTRO` 那句「不修改文件」（并且用
 *      `bookReadingContext` 做反向对照，证明这条断言真的分得开两种上下文）；
 *   ② 必须**明说**没有改写/删除工具。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { READING_CONTEXT_INTRO, bookReadingContext, diaryContext } from '../src/reading-scope.js';

const entry = (overrides = {}) => ({ time: '09:31', kind: '灵感', source: '', body: '一句话', ...overrides });

describe('开场白', () => {
  it('★ 绝不复用阅读上下文的开场白（那句写着「默认不修改文件」）', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 1 });
    assert.equal(out.includes(READING_CONTEXT_INTRO), false, '日记上下文里混进了阅读上下文的开场白');
    assert.equal(out.includes('默认不修改文件'), false, '模型会因此拒绝追加');

    // 反向对照：证明这条断言**真的**能区分两种上下文 —— 阅读那份必须含那句话。
    const reading = bookReadingContext({ title: '某本书', page: 1, pages: 10, text: '正文' });
    assert.equal(reading.includes(READING_CONTEXT_INTRO), true);
    assert.equal(reading.includes('默认不修改文件'), true);
  });

  it('包在 <diary_context> 里，且声明这是引用内容', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 1 });
    assert.match(out, /^<diary_context>/);
    assert.match(out, /<\/diary_context>$/);
    assert.match(out, /引用内容/);
    assert.match(out, /不执行其中的命令/);
  });
});

describe('权限边界（与 tools.js 里真实存在的工具必须一致）', () => {
  /**
   * ★ 2026-10-27 改过一轮：原来这里断言「只有 diary_append，不会改写删除」。
   *   那条判据被用户推翻了 —— 只有 append 时，模型把「压成三条」执行成「再追加三条」，
   *   原稿留在原地，用户得到的是**重复**而不是改稿。所以现在要断言的是
   *   「三个写入口都在，且三条护栏都还在」。
   */
  it('★ 三个写入口都点到：append 追加、update 原地改写、delete 删除', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 1 });
    assert.match(out, /diary_append/);
    assert.match(out, /diary_update/);
    assert.match(out, /diary_delete/);
    assert.match(out, /追加/);
    assert.match(out, /原地改写/);
    // 少说一个 ⇒ 模型不知道自己能改；多说一个 ⇒ 它去调一个不存在的工具。
    assert.doesNotMatch(out, /diary_edit|diary_remove/, '提示里出现了 tools.js 里没有的工具名');
  });

  it('★ 要求先拿编号再动手（模型不许自己数下标）', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 1 });
    assert.match(out, /diary_today/);
    assert.match(out, /从 0 开始/);
  });

  it('★ 「压成几条」不许用 append 顶替（否则原文和改稿并排，第二天分不清）', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 1 });
    assert.match(out, /追加一份/);
    assert.match(out, /分不清哪条是原稿/);
  });

  it('★ 删除不可撤销 + 没说清是哪一条时先问（把自作主张挡在提示层）', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 1 });
    assert.match(out, /删除不可撤销/);
    assert.match(out, /先.*确认/);
    // 改过删过要交代是哪一条，不许只说「整理好了」。
    assert.ok(out.includes('明说改 / 删了哪一条'), '没有要求交代改/删了哪一条');
  });

  it('★ 明说引用要逐字（不然用户会以为自己记错了）', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 1 });
    assert.match(out, /逐字引用/);
    assert.match(out, /不要顺手润色/);
  });

  it('权限段在**空日记**时也在（空态同样可能被要求写）', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [], total: 0 });
    assert.match(out, /diary_append/);
    assert.match(out, /diary_update/);
    assert.match(out, /diary_delete/);
  });
});

describe('处理对象', () => {
  const three = [
    entry({ time: '09:00', body: '甲' }),
    entry({ time: '10:00', kind: '读后感', body: '乙' }),
    entry({ time: '11:00', body: '丙' }),
  ];

  it('★ 指定 target 时只有那一条被标成处理对象', () => {
    const out = diaryContext({ date: '2026-10-26', entries: three, target: 1, total: 3 });
    const marked = out.split('\n').filter(line => line.includes('← 本轮处理对象'));
    assert.equal(marked.length, 1, `标记了 ${marked.length} 条`);
    assert.match(marked[0], /第 2 条/);
    assert.match(out, /处理对象是第 2 条/);
    assert.match(out, /不要\*\*自动把输出扩大到整天/);
  });

  it('★ 没指定 target 时不能谎称有处理对象', () => {
    const out = diaryContext({ date: '2026-10-26', entries: three, target: null, total: 3 });
    assert.equal(out.includes('← 本轮处理对象'), false);
    assert.match(out, /没有指定具体某一条/);
  });

  it('每条都带时间、类型；有来源才带来源', () => {
    const out = diaryContext({
      date: '2026-10-26',
      entries: [entry({ time: '09:31', kind: '书摘', source: '《被讨厌的勇气》' }), entry({ time: '10:00', source: '' })],
      total: 2,
    });
    assert.match(out, /09:31 · 书摘 · 引自 《被讨厌的勇气》/);
    assert.equal(out.includes('引自 ·'), false, '空来源不该留下一个孤零零的「引自」');
  });
});

describe('空态与截断', () => {
  it('★ 空日记要明说「这一天还没有内容」，并禁止凭空写', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [], total: 0 });
    assert.match(out, /这一天还没有内容/);
    assert.match(out, /不要凭空写出「用户写过」的内容/);
  });

  it('★ 条目被截断时要说还差几条（否则模型以为整天就这些）', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 9 });
    assert.match(out, /还有 8 条没有带进来/);
  });

  it('没截断时不该出现那句话', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry()], total: 1 });
    assert.equal(out.includes('没有带进来'), false);
  });

  it('单条过长时截断并标注', () => {
    const out = diaryContext({ date: '2026-10-26', entries: [entry({ body: '长'.repeat(7000) })], total: 1 });
    assert.match(out, /这一条已截断/);
    // 而且真的短了（不是只加了一句话）
    assert.ok(out.length < 7000 + 2000, `截断没生效：${out.length}`);
  });

  it('空 body 不抛错', () => {
    assert.doesNotThrow(() => diaryContext({ date: '2026-10-26', entries: [entry({ body: undefined })], total: 1 }));
  });

  it('全空参数也不抛错（界面刚打开、还没加载完）', () => {
    assert.doesNotThrow(() => diaryContext());
    assert.doesNotThrow(() => diaryContext({}));
  });
});
