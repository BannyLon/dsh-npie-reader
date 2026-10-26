/**
 * 电子书划线的**锚点坐标**：块区间、块内偏移、碎片切分。
 *
 * 这个文件盯的是「看起来对、错起来很安静」的三类问题：
 *   ① 块区间的基准与渲染不一致 —— 症状是线画到了下一段开头几个字；
 *   ② 空块占了坐标 —— 症状同样错位，但它只在这一页有空段落时出现；
 *   ③ 碎片切分把字丢掉或多画一条接缝 —— 前者是内容缺失，后者是视觉毛刺。
 * 每一条都配反向对照：喂一个已知会坏的实现，要求判据变红。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BLOCK_SEP, blockSpans, marksForBlock, pageText, spanOfElement, splitByMarks, splitByOverlays,
} from '../src/client/ebook-marks.js';

/** 一页的块（`k` 是种类，`x` 是文字），含一个空块与一条列表项。 */
const BLOCKS = [
  { k: 'h1', x: '第三章' },
  { k: 'p', x: '' },            // 空块：不渲染，也不该占坐标
  { k: 'p', x: '第一段。' },
  { k: 'li', x: '条目甲' },
  { k: 'li', x: '条目乙' },
];

describe('blockSpans：块在页内坐标系里的区间', () => {
  it('空块不占坐标，块间一个换行', () => {
    const spans = blockSpans(BLOCKS);
    assert.deepEqual(spans.map(s => s.index), [0, 2, 3, 4]);
    // 「第三章」(3) + \n + 「第一段。」(4) + \n + 「条目甲」(3) + \n + 「条目乙」(3)
    assert.deepEqual(spans.map(s => [s.start, s.end]), [[0, 3], [4, 8], [9, 12], [13, 16]]);
    assert.equal(pageText(BLOCKS).length, 16);
    assert.equal(spans[spans.length - 1].end, pageText(BLOCKS).length);
  });

  it('每块的 end − start 等于它自己的字数', () => {
    for (const span of blockSpans(BLOCKS)) {
      assert.equal(span.end - span.start, BLOCKS[span.index].x.length);
    }
  });

  it('反向对照：空块也占坐标的实现在这一页上会整体偏移一个字', () => {
    // 「把空块也算进去」是最容易写出来的一版（`blocks.forEach` 里不跳过空串）。
    const naive = [];
    let offset = 0;
    BLOCKS.forEach((block, index) => {
      if (naive.length > 0) offset += 1;
      naive.push({ index, start: offset, end: offset + block.x.length });
      offset += block.x.length;
    });
    // 第一个非空块（「第一段。」）在好实现里从 4 开始、坏实现从 5 开始 —— 差的就是
    // 那个空块白占的一格。这一格会让线整段右移一个字。
    const good = blockSpans(BLOCKS);
    assert.deepEqual(good.map(s => s.index), [0, 2, 3, 4]);
    assert.equal(good[1].start, 4);
    assert.equal(naive[2].start, 5);
  });

  it('空数组 / 非数组不抛', () => {
    assert.deepEqual(blockSpans([]), []);
    assert.deepEqual(blockSpans(null), []);
    assert.equal(pageText(undefined), '');
  });
});

describe('spanOfElement：块元素 → 区间', () => {
  const spans = blockSpans(BLOCKS);

  it('按 `data-block` 下标找', () => {
    assert.deepEqual(spanOfElement(spans, { dataset: { block: '3' } }), { index: 3, start: 9, end: 12 });
  });

  it('反向对照：空块的那个下标不该有区间（它在 DOM 里根本不存在）', () => {
    assert.equal(spanOfElement(spans, { dataset: { block: '1' } }), null);
    assert.equal(spanOfElement(spans, null), null);
  });
});

describe('marksForBlock：跨块的划线裁到本块', () => {
  const spans = blockSpans(BLOCKS);

  it('跨两块的划线在两块里各自被裁开', () => {
    // 从「第三章」的第二个字划到「第一段。」的第二个字 ⇒ 页内 [1, 6)
    const items = [{ id: 'a', tone: 'yellow', start: 1, end: 6 }];
    assert.deepEqual(marksForBlock(items, spans[0], 3), [{ id: 'a', tone: 'yellow', start: 1, end: 3 }]);
    assert.deepEqual(marksForBlock(items, spans[1], 4), [{ id: 'a', tone: 'yellow', start: 0, end: 2 }]);
    // 后面的块没有交集。
    assert.deepEqual(marksForBlock(items, spans[2], 3), []);
  });

  it('结果按起点排序', () => {
    const items = [
      { id: 'b', tone: 'green', start: 2, end: 3 },
      { id: 'a', tone: 'blue', start: 0, end: 1 },
    ];
    assert.deepEqual(marksForBlock(items, spans[0], 3).map(m => m.id), ['a', 'b']);
  });

  it('反向对照：不裁剪就会画出块外的长度', () => {
    const items = [{ id: 'a', tone: 'yellow', start: 1, end: 16 }];
    const [mark] = marksForBlock(items, spans[0], 3);
    assert.equal(mark.end, 3, '必须裁到本块长度');
    assert.notEqual(mark.end, 16);
  });
});

describe('splitByMarks：文字 → 碎片', () => {
  it('没有划线时是一整片（调用方据此不包 <mark>）', () => {
    assert.deepEqual(splitByMarks('第一段。', []), [{ from: 0, to: 4, tone: null, id: '' }]);
  });

  it('一条划线切成「前 / 中 / 后」三片', () => {
    const parts = splitByMarks('第一段。', [{ id: 'a', tone: 'yellow', start: 1, end: 3 }]);
    assert.deepEqual(parts.map(p => [p.from, p.to, p.tone]), [[0, 1, null], [1, 3, 'yellow'], [3, 4, null]]);
    // 拼回去一个字符都不能少 —— 这是「高亮不能吃掉正文」的硬判据。
    assert.equal(parts.map(p => '第一段。'.slice(p.from, p.to)).join(''), '第一段。');
  });

  it('同一条被切开后的相邻碎片要合并（否则一个色块里会画出接缝）', () => {
    const parts = splitByMarks('abcdef', [
      { id: 'a', tone: 'yellow', start: 1, end: 3 },
      { id: 'a', tone: 'yellow', start: 3, end: 5 },
    ]);
    assert.deepEqual(parts.map(p => [p.from, p.to, p.tone]), [[0, 1, null], [1, 5, 'yellow'], [5, 6, null]]);
  });

  it('反向对照：不合并就是两片同色碎片', () => {
    const parts = splitByMarks('abcdef', [
      { id: 'a', tone: 'yellow', start: 1, end: 3 },
      { id: 'a', tone: 'yellow', start: 3, end: 5 },
    ]);
    const naivelySplit = parts.filter(p => p.tone === 'yellow').length;
    assert.equal(naivelySplit, 1, '合并后只剩一片');
  });

  it('重叠时取先出现的那条，且不丢字', () => {
    const parts = splitByMarks('abcdef', [
      { id: 'a', tone: 'yellow', start: 1, end: 4 },
      { id: 'b', tone: 'blue', start: 2, end: 5 },
    ]);
    assert.equal(parts.map(p => 'abcdef'.slice(p.from, p.to)).join(''), 'abcdef');
    // [1,4) 全归先出现的 A（同色相邻碎片已合并），[4,5) 才轮到 B。
    assert.deepEqual(parts.map(p => p.tone), [null, 'yellow', 'blue', null]);
  });

  it('越界 / 倒置的划线被丢掉，不制造负长度碎片', () => {
    assert.deepEqual(splitByMarks('abc', [{ id: 'a', tone: 'yellow', start: 5, end: 9 }]),
      [{ from: 0, to: 3, tone: null, id: '' }]);
    assert.deepEqual(splitByMarks('abc', [{ id: 'a', tone: 'yellow', start: 2, end: 2 }]),
      [{ from: 0, to: 3, tone: null, id: '' }]);
    assert.deepEqual(splitByMarks('', [{ id: 'a', tone: 'yellow', start: 0, end: 3 }]),
      [{ from: 0, to: 0, tone: null, id: '' }]);
  });
});

/**
 * 书内搜索（0.26.0）：**两层一起切**。
 *
 * 这个函数的全部价值在一条：命中可能**横跨划线边界**。先按划线切、再在碎片里找命中，
 * 跨界的命中就只剩半截高亮 —— 症状是「搜到了，但标错位置」，而它不会报任何错。
 */
describe('splitByOverlays：划线 + 搜索命中合并成一次切割', () => {
  const text = 'abcdefgh';

  it('两层都空 ⇒ 整段一片，字一个不少', () => {
    const parts = splitByOverlays(text, [], []);
    assert.deepEqual(parts, [{ from: 0, to: 8, tone: null, id: '', find: false, current: false }]);
  });

  it('只有命中 ⇒ 前 / 命中 / 后 三片，中片 find=true', () => {
    const parts = splitByOverlays(text, [], [{ start: 2, end: 5, current: true }]);
    assert.deepEqual(parts.map(p => text.slice(p.from, p.to)), ['ab', 'cde', 'fgh']);
    assert.deepEqual(parts.map(p => p.find), [false, true, false]);
    assert.deepEqual(parts.map(p => p.current), [false, true, false]);
  });

  it('★ 命中横跨两片划线的边界 ⇒ 命中**不断成两截**（两片都带 find）', () => {
    const marks = [
      { id: 'a', tone: 'yellow', start: 0, end: 4 },
      { id: 'b', tone: 'blue', start: 4, end: 8 },
    ];
    const parts = splitByOverlays(text, marks, [{ start: 3, end: 5, current: false }]);
    // [3,4) 与 [4,5) 两片：底色不同（划线不同），但**都算命中**。
    const hit = parts.filter(p => p.find);
    assert.equal(hit.length, 2);
    assert.equal(text.slice(hit[0].from, hit[1].to), 'de');
    assert.deepEqual(hit.map(p => p.tone), ['yellow', 'blue']);
  });

  it('划线与命中重叠的碎片：一个碎片同时带 tone 与 find（不嵌套、不重复挂）', () => {
    const parts = splitByOverlays(text, [{ id: 'a', tone: 'yellow', start: 1, end: 5 }],
      [{ start: 1, end: 5, current: true }]);
    assert.equal(parts.length, 3);
    const both = parts[1];
    assert.deepEqual([both.tone, both.id, both.find, both.current], ['yellow', 'a', true, true]);
  });

  it('不丢字、不重叠、全段被覆盖（拼接等于原文）', () => {
    const marks = [{ id: 'a', tone: 'yellow', start: 0, end: 3 }, { id: 'b', tone: 'blue', start: 5, end: 7 }];
    const finds = [{ start: 2, end: 6, current: false }, { start: 7, end: 8, current: true }];
    const parts = splitByOverlays(text, marks, finds);
    assert.equal(parts.map(p => text.slice(p.from, p.to)).join(''), text);
    for (let i = 1; i < parts.length; i += 1) assert.equal(parts[i].from, parts[i - 1].to);
  });

  it('越界 / 倒置 / 零长度的输入被丢掉，不制造负长度碎片', () => {
    const parts = splitByOverlays(text, [{ id: 'a', tone: 'yellow', start: 6, end: 2 }],
      [{ start: 5, end: 5 }, { start: 20, end: 30 }]);
    assert.deepEqual(parts, [{ from: 0, to: 8, tone: null, id: '', find: false, current: false }]);
  });

  it('空文字 ⇒ 一片空碎片（调用方据此原样显示，不会得到 undefined）', () => {
    assert.deepEqual(splitByOverlays('', [], [{ start: 0, end: 1 }]),
      [{ from: 0, to: 0, tone: null, id: '', find: false, current: false }]);
  });

  it('反向对照：先按划线切、再在碎片里找命中 ⇒ 跨界命中确实只剩半截', () => {
    const marks = [{ id: 'a', tone: 'yellow', start: 0, end: 4 }, { id: 'b', tone: 'blue', start: 4, end: 8 }];
    const needle = 'de';
    const naive = [];
    for (const piece of splitByMarks(text, marks)) {
      const local = text.slice(piece.from, piece.to);
      const at = local.indexOf(needle);
      if (at >= 0) naive.push(text.slice(piece.from + at, piece.from + at + needle.length));
    }
    assert.deepEqual(naive, [], '两段各切一次 ⇒ 「de」跨在边界上，两边都找不到（这正是不复用它当判据的理由）');
    const merged = splitByOverlays(text, marks, [{ start: 3, end: 5 }]).filter(p => p.find);
    assert.equal(text.slice(merged[0].from, merged[merged.length - 1].to), needle);
  });
});
