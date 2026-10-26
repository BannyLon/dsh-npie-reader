/**
 * `annotation-format.js`：划线 → Markdown。
 *
 * 这个模块被**两处**消费（`book_annotations` 工具、划线面板的「导出」），
 * 所以它的每条判据都按「两边都会吃到」来测：模型读到的与用户复制走的
 * 必须是同一段文字，任何一边单独跑偏都是不可接受的。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXPORT_ITEM_MAX, TONE_LABELS, TONE_ORDER, annotationsMarkdown, toneLabel,
} from '../src/annotation-format.js';
import { ANNOTATION_TONES, TONE_ORDER as CLIENT_TONE_ORDER } from '../src/client/annotations.js';

const item = (over = {}) => ({
  page: 42, start: 0, end: 6, quote: '磨坊主妇', note: '', tone: 'yellow', ...over,
});

describe('annotationsMarkdown', () => {
  it('空列表 ⇒ 明说「还没有划线」，不是返回空串', () => {
    const out = annotationsMarkdown({ title: '空书', bookId: 'b2', items: [] });
    assert.equal(out.shown, 0);
    assert.match(out.markdown, /还没有划线/);
    // ★ 反向对照：返回空串时调用方要么显示一片空白、要么自己再写一句 ——
    //   两种都会让「这本书没划线」与「导出坏了」长得一样。
    assert.notEqual(out.markdown.trim(), '');
  });

  it('按页分组：同一页的两条相邻，页码只出现一次', () => {
    const out = annotationsMarkdown({
      title: '磨坊', bookId: 'b1',
      items: [item({ page: 42 }), item({ page: 42, start: 20, quote: '门口' }), item({ page: 57, quote: '风停了' })],
    });
    assert.equal(out.markdown.split('## 第 42 页').length - 1, 1);
    assert.equal(out.markdown.split('## 第 57 页').length - 1, 1);
    // 「## 第 42 页」之后紧跟第一条，再到第二条 —— 顺序没被时间打乱。
    assert.ok(out.markdown.indexOf('磨坊主妇') < out.markdown.indexOf('门口'));
    assert.ok(out.markdown.indexOf('门口') < out.markdown.indexOf('风停了'));
  });

  it('★ 多行摘录逐行加 `>`（否则第二行掉出引用块，读者分不清原文与笔记）', () => {
    const out = annotationsMarkdown({
      title: 'x', bookId: 'b', items: [item({ quote: '第一行\n第二行\n第三行' })],
    });
    for (const line of ['> 第一行', '> 第二行', '> 第三行']) {
      assert.ok(out.markdown.includes(line), `缺「${line}」：\n${out.markdown}`);
    }
  });

  it('有笔记 / 没笔记是两种行，且笔记不混进引用块', () => {
    const out = annotationsMarkdown({
      title: 'x', bookId: 'b',
      items: [item({ note: '这句是转折' }), item({ start: 10, tone: 'blue' })],
    });
    assert.ok(out.markdown.includes('- **重点** · 我的笔记：这句是转折'));
    assert.ok(out.markdown.includes('- 疑问'));
    // 笔记行必须以列表项开头：`> ` 开头会被渲染成「书上的原文」。
    assert.equal(/(- \*\*重点\*\* · 我的笔记：这句是转折)/.test(out.markdown), true);
  });

  it('未知色值退回第一档标签，不丢这一行说明', () => {
    assert.equal(toneLabel('rainbow'), TONE_LABELS[TONE_ORDER[0]]);
    const out = annotationsMarkdown({ title: 'x', bookId: 'b', items: [item({ tone: 'rainbow' })] });
    assert.ok(out.markdown.includes(`- ${TONE_LABELS[TONE_ORDER[0]]}`));
  });

  it('★ 截断必须写明全书总数（否则「500 条」被读成「一共 500 条」）', () => {
    const items = Array.from({ length: 3 }, (_, i) => item({ start: i * 10, quote: `第${i}句` }));
    const out = annotationsMarkdown({ title: 'x', bookId: 'b', items: items.slice(0, 1), total: 88 });
    assert.equal(out.total, 88);
    assert.equal(out.truncated, true);
    assert.match(out.markdown, /全书共 88 条/);
    assert.match(out.markdown, /只带到前 1 条/);
  });

  it('total 比手里的条数还小时不倒挂（调用方传错也不写矛盾的话）', () => {
    const items = [item(), item({ start: 10 }), item({ start: 20 })];
    const out = annotationsMarkdown({ title: 'x', bookId: 'b', items, total: 1 });
    assert.equal(out.total, 3);
    assert.equal(out.truncated, false);
  });

  it('limit 生效但总数仍然照实报', () => {
    const items = Array.from({ length: EXPORT_ITEM_MAX + 5 }, (_, i) => item({ start: i * 10, quote: `第${i}句` }));
    const out = annotationsMarkdown({ title: 'x', bookId: 'b', items });
    assert.equal(out.shown, EXPORT_ITEM_MAX);
    assert.equal(out.total, EXPORT_ITEM_MAX + 5);
    assert.equal(out.truncated, true);
  });

  it('摘录里的 CRLF 归一，不留下 `\\r`', () => {
    const out = annotationsMarkdown({ title: 'x', bookId: 'b', items: [item({ quote: '甲\r\n乙' })] });
    assert.equal(out.markdown.includes('\r'), false);
    assert.ok(out.markdown.includes('> 乙'));
  });

  it('没有书名时退回 bookId，不编一个标题', () => {
    const out = annotationsMarkdown({ title: '', bookId: 'b-77', items: [item()] });
    assert.ok(out.markdown.includes('《b-77》'));
  });
});

describe('色板单一来源', () => {
  it('界面侧的 ANNOTATION_TONES 就是这里的 TONE_LABELS（同一个对象，改一处两边都变）', () => {
    assert.equal(ANNOTATION_TONES, TONE_LABELS);
    assert.deepEqual(CLIENT_TONE_ORDER, TONE_ORDER);
  });

  it('四个语义色一个不多一个不少', () => {
    assert.deepEqual(Object.keys(TONE_LABELS), ['yellow', 'green', 'blue', 'pink']);
  });
});
