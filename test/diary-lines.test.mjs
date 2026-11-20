/**
 * `entryLines()` —— 一条灵感怎么拆成「标题 + 摘要」。
 *
 * ★ 它存在的理由：用户 2026-10-29 要时间轴条目像那张 RSS 图一样有层次
 *   （加粗标题 + 灰色多行摘要）。拆法只要有一点不对劲，界面上就会**重复**
 *   （标题和摘要显示同一句）或**丢字**（两句之间那段没了）—— 两种都不会报错。
 *
 * ★ 这里守三件在屏幕上很难发现、但用户一定读得出来的错：
 *   ① 两段拼起来必须**还是原文**：不重复、不吞字（拼回去 `title + rest` 要相等）；
 *   ② 短句不许硬拆（「我再测试测试」不该变成标题「我再测试」+ 摘要「测试」）；
 *   ③ 标题长度不许超过两行的量（`ENTRY_TITLE_MAX`），否则会被 CSS 截掉而摘要
 *      从被截的地方开始 —— 中间那截就永远看不到了。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ENTRY_TITLE_MAX, entryLines, plainSnippet } from '../src/client/diary-lines.js';

/** 把两段拼回去（标题 + 分隔 + 摘要），用来验「一个字都没丢」。 */
const rejoin = ({ title, rest }) => (rest === '' ? title : `${title}${rest}`);

describe('entryLines：标题 + 摘要', () => {
  test('★ 短句：只有标题，不硬拆出半句摘要', () => {
    // 用户截图里的那条原文。拆成「我再测试」+「测试」就滑稽了。
    assert.deepEqual(entryLines('我再测试测试'), { title: '我再测试测试', rest: '' });
    // 八字以内带逗号也一样整句当标题：切出来的「三个人」不像标题，像前缀。
    assert.deepEqual(entryLines('三个人，三种表情'), { title: '三个人，三种表情', rest: '' });
  });

  test('★ 逗号要够靠后才从句切：两个字当标题是噪音', () => {
    // `CLAUSE_MIN` 挡住「他说，……」这种。短标题不如不切。
    const short = entryLines('他说，今天真好');
    assert.equal(short.rest, '', '两个字就切成标题了');
    assert.equal(short.title, '他说，今天真好');
  });

  test('★ 首句带句末标点：标题完整，摘要从标点后起', () => {
    const lines = entryLines('他来了。然后呢？我在门口站了很久。');
    assert.equal(lines.title, '他来了。', '标题没截到第一个句号');
    assert.equal(lines.rest, '然后呢？我在门口站了很久。');
  });

  test('★ 拼回去必须等于原文（不重复、不吞字）', () => {
    const cases = [
      '我再测试测试',
      '时光爬过忍对已久的忍耐者，慢慢把人磨成一块石头。',
      '他来了。然后呢？',
      '甲'.repeat(100),
      '开头一句很短。后面跟着一大段内容，用来验证摘要不会被标题吃掉。',
    ];
    for (const text of cases) {
      const lines = entryLines(text);
      // 从句切时标题不带那个逗号 —— 允许差一个分隔标点，其余必须一字不差。
      const joined = rejoin(lines);
      assert.ok(
        joined === text || joined === text.replace(/^(.{8,30}?)[，,、]/, '$1'),
        `拼不回原文：${JSON.stringify(text)} → ${JSON.stringify(joined)}`,
      );
    }
  });

  test('★ 标题不许超过两行的量，超长的要有摘要接着', () => {
    const long = '这是一个没有任何标点的长句子'.repeat(6); // 78 字
    const lines = entryLines(long);
    assert.ok(lines.title.length <= ENTRY_TITLE_MAX,
      `标题 ${lines.title.length} 字，超过两行的量 —— CSS 会截掉中间那截`);
    assert.notEqual(lines.rest, '', '长句没有摘要：被截掉的部分就永远看不到了');
    assert.equal(lines.title + lines.rest, long, '硬切时丢字了');
  });

  test('★ 空白压平、空输入不出空壳', () => {
    assert.deepEqual(entryLines('  第一句。\n\n第二行  '), { title: '第一句。', rest: '第二行' });
    assert.deepEqual(entryLines(''), { title: '', rest: '' });
    assert.deepEqual(entryLines(null), { title: '', rest: '' });
    assert.deepEqual(entryLines(undefined), { title: '', rest: '' });
  });

  test('* 英文句号不算句末：小数与版本号会被误切', () => {
    const lines = entryLines('GPT-4 在 3.5 版本上提升了 12.4%，主要是长文能力。');
    assert.match(lines.title, /12\.4%/, '标题在英文句号处被切断了');
  });
});

/**
 * `plainSnippet()` —— 预览层不许把 Markdown 标记印出来。
 *
 * ★ 用户 2026-11-11 的截图：时间轴上一条写着
 *   `09:52 **真需求 = 高频 × 刚需 × 普遍。**`，而右边同一张便签是粗体。
 *   左边把 preview 当纯文本印、右边走 `markdownToHtml()` —— 不剥就是两副面孔。
 * ★ 反向对照写在这里：`2 * 3` 里的星号**不许**被当斜体吃掉。剥过头比不剥更难查：
 *   内容少了一个字符，没有任何报错，只有原作者读得出来。
 */
describe('plainSnippet：预览层剥掉行内标记', () => {
  test('★ 用户截图那条：加粗标记一个字都不许留在时间线上', () => {
    assert.equal(plainSnippet('**真需求 = 高频 × 刚需 × 普遍。**'), '真需求 = 高频 × 刚需 × 普遍。');
    // 走完整条路：切句之后标题里也不能带星号（`**。**` 会让句号前面挂两个星）。
    const lines = entryLines('**真需求 = 高频 × 刚需 × 普遍。**');
    assert.equal(lines.title, '真需求 = 高频 × 刚需 × 普遍。');
    assert.equal(lines.rest, '');
  });

  test('★ 成对才剥：算式里的星号不是斜体', () => {
    assert.equal(plainSnippet('2 * 3 * 4 = 24'), '2 * 3 * 4 = 24');
    assert.equal(plainSnippet('粗体**在中间**的句子'), '粗体在中间的句子');
  });

  test('★ 删除线 / 行内代码 / 链接 / 行首标记', () => {
    assert.equal(plainSnippet('~~删掉~~'), '删掉');
    assert.equal(plainSnippet('命令 `npm test` 跑一下'), '命令 npm test 跑一下');
    assert.equal(plainSnippet('[标题](https://example.com)'), '标题');
    assert.equal(plainSnippet('![图](a.png)'), '图');
    assert.equal(plainSnippet('## 小标题'), '小标题');
    assert.equal(plainSnippet('- 一条'), '一条');
  });

  test('* 下划线故意不剥：snake_case 与文件名会被吃坏', () => {
    // 中文内容里几乎不用 `_` 加粗，而代码/文件名里到处是下划线 —— 取舍写进注释。
    assert.equal(plainSnippet('foo_bar_baz'), 'foo_bar_baz');
    assert.match(plainSnippet('__不是粗体__'), /__/);
  });

  test('★ 纯文本原样通过（剥标记不能顺手改正文）', () => {
    assert.equal(plainSnippet('今天什么都没想。'), '今天什么都没想。');
    assert.equal(plainSnippet(''), '');
    assert.equal(plainSnippet(null), '');
    assert.equal(plainSnippet(undefined), '');
  });
});

describe('plainSnippet：只有一张截图的灵感（0.73.0）', () => {
  const url = '/api/dsh-npie-reader/diary/assets/0123456789abcdef.png';

  test('没有 alt 的图给一句「［图片］」，不留空串', () => {
    assert.equal(plainSnippet(`![](${url})`), '［图片］');
  });

  test('有 alt 就用 alt（作者写的话比占位符有信息）', () => {
    assert.equal(plainSnippet(`![函数图像](${url})`), '函数图像');
  });

  test('★ 正文里夹一张图：前后的字都留着，只有地址消失', () => {
    const text = plainSnippet(`这张图说明了问题\n![](${url})\n后面还有一句`);
    assert.equal(text, '这张图说明了问题\n［图片］\n后面还有一句');
    assert.doesNotMatch(text, /api\/dsh-npie-reader/);
  });

  test('★ 反向对照：被 60 字预览截断的图（没有右括号）也不能漏出网址', () => {
    // 宿主给的是正文前 60 字，图片地址本身就有六十来字 —— 截断是常态，不是异常。
    const truncated = `![](${url}`.slice(0, 60);
    const text = plainSnippet(truncated);
    assert.doesNotMatch(text, /dsh-npie-reader/, `截断的图漏出了网址：${text}`);
  });

  test('普通文字里的方括号与感叹号不受影响', () => {
    assert.equal(plainSnippet('真的！[他说]这样'), '真的！[他说]这样');
  });
});
