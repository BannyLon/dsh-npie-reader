/**
 * 划线的**纯判据**（`src/client/annotations.js`）。
 *
 * 这些函数决定「线画在哪儿、算不算重复、面板上写几个字」，全是纯数字/字符串
 * 运算 —— 所以这里的断言可以直接对着数字写，不需要 DOM。
 * DOM 那一小截（`rangeOfAnchor` / `rectsOfRange`）由真 Chrome 脚本量，
 * 理由与 `book-text.js` 相同：几何的正确性只能靠量。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  ANNOTATION_TONES, NOTE_LIMIT, TONE_ORDER,
  annotationsOnPage, compareAnnotations, coveringAnnotation, nextTone,
  normalizeAnnotation, normalizeAnnotations, overlaps, slicesOf, summariseAnnotations,
} from '../src/client/annotations.js';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');

const base = { id: 'a-1', page: 3, start: 10, end: 20, quote: '一段话', note: '', tone: 'yellow', createdAt: 1, updatedAt: 1 };

describe('normalizeAnnotation', () => {
  it('正常条目原样通过', () => {
    assert.deepEqual(normalizeAnnotation(base), base);
  });

  it('缺字段 / 类型错的条目返回 null（渲染它会 NaN 掉整个阅读器）', () => {
    const bad = [
      null, 'x', {},
      { ...base, page: 0 },
      { ...base, page: 'abc' },
      { ...base, start: -1 },
      { ...base, end: base.start },
      { ...base, quote: '  ' },
      { ...base, id: '' },
    ];
    for (const value of bad) assert.equal(normalizeAnnotation(value), null, JSON.stringify(value));
  });

  it('不认识的颜色退回第一个（旧文件里的 purple 不该让整条失效）', () => {
    assert.equal(normalizeAnnotation({ ...base, tone: 'purple' }).tone, TONE_ORDER[0]);
  });
});

describe('normalizeAnnotations / 排序', () => {
  it('丢掉坏条目并按页码 → 起点排序', () => {
    const list = normalizeAnnotations([
      { ...base, id: 'c', page: 9, start: 1, end: 4 },
      null,
      { ...base, id: 'a', page: 2, start: 50, end: 60 },
      { ...base, id: 'b', page: 2, start: 5, end: 9 },
    ]);
    assert.deepEqual(list.map(item => item.id), ['b', 'a', 'c']);
  });

  it('非数组当空列表', () => {
    assert.deepEqual(normalizeAnnotations(undefined), []);
  });

  it('compareAnnotations 同页同起点时用创建时间兜底（稳定排序）', () => {
    const a = { page: 1, start: 5, createdAt: 2 };
    const b = { page: 1, start: 5, createdAt: 1 };
    assert.ok(compareAnnotations(a, b) > 0);
  });
});

describe('重复判定', () => {
  const existing = [{ id: 'a-1', page: 3, start: 10, end: 20 }];

  it('完全包含 ⇒ 命中', () => {
    assert.equal(coveringAnnotation(existing, { page: 3, start: 12, end: 18 })?.id, 'a-1');
  });

  it('部分相交**不算**重复（先划一句、再划更大的段落是两次意图）', () => {
    assert.equal(coveringAnnotation(existing, { page: 3, start: 15, end: 30 }), null);
  });

  it('不同页不算重复', () => {
    assert.equal(coveringAnnotation(existing, { page: 4, start: 10, end: 20 }), null);
  });

  it('overlaps：端点相接不算重叠', () => {
    assert.equal(overlaps({ page: 1, start: 0, end: 10 }, { page: 1, start: 10, end: 20 }), false);
    assert.equal(overlaps({ page: 1, start: 0, end: 11 }, { page: 1, start: 10, end: 20 }), true);
    assert.equal(overlaps({ page: 1, start: 0, end: 11 }, { page: 2, start: 10, end: 20 }), false);
  });
});

describe('slicesOf（把字符区间切到文本节点上）', () => {
  // 三个节点，长度 5 / 0 / 6 —— pdf.js 真的会产出空 span（页边距占位）。
  const lengths = [5, 0, 6];

  it('区间落在单个节点内', () => {
    assert.deepEqual(slicesOf(lengths, 1, 4), [{ index: 0, from: 1, to: 4 }]);
  });

  it('跨节点切开，空节点被跳过', () => {
    assert.deepEqual(slicesOf(lengths, 3, 8), [
      { index: 0, from: 3, to: 5 },
      { index: 2, from: 0, to: 3 },
    ]);
  });

  it('超出范围的端点被裁到节点边界', () => {
    assert.deepEqual(slicesOf(lengths, 4, 99), [
      { index: 0, from: 4, to: 5 },
      { index: 2, from: 0, to: 6 },
    ]);
  });

  it('起点等于终点 / 反向 / 非整数 ⇒ 空（调用方据此不画）', () => {
    assert.deepEqual(slicesOf(lengths, 5, 5), []);
    assert.deepEqual(slicesOf(lengths, 6, 5), []);
    assert.deepEqual(slicesOf(lengths, 1.5, 4), []);
    assert.deepEqual(slicesOf([], 0, 3), []);
  });
});

describe('summariseAnnotations', () => {
  it('数出总条数、写了笔记的条数、涉及几页', () => {
    const stats = summariseAnnotations([
      { note: '一句', page: 1 }, { note: '', page: 1 }, { note: '  ', page: 2 }, { note: '三', page: 5 },
    ]);
    assert.deepEqual(stats, { total: 4, notes: 2, pages: 3 });
  });

  it('空列表是三个 0（面板据此显示「还没有划线」）', () => {
    assert.deepEqual(summariseAnnotations([]), { total: 0, notes: 0, pages: 0 });
  });
});

describe('annotationsOnPage / nextTone', () => {
  it('只取这一页', () => {
    const items = [{ page: 1, id: 'a' }, { page: 2, id: 'b' }, { page: 1, id: 'c' }];
    assert.deepEqual(annotationsOnPage(items, 1).map(item => item.id), ['a', 'c']);
  });

  it('色点轮转到头回到第一个；未知颜色也给第一个', () => {
    const tones = TONE_ORDER;
    for (let i = 0; i < tones.length; i += 1) {
      const expected = tones[(i + 1) % tones.length];
      assert.equal(nextTone(tones[i]), expected);
    }
    assert.equal(nextTone('purple'), tones[0]);
  });

  it('四种颜色的名字都要有中文标签（面板上只显示标签，不显示 key）', () => {
    for (const tone of TONE_ORDER) assert.ok(String(ANNOTATION_TONES[tone]).length > 0);
  });
});

describe('与宿主侧对齐的常量', () => {
  it('笔记长度上限与宿主一致（4000）', () => {
    assert.equal(NOTE_LIMIT, 4000);
  });
});

// ---------------------------------------------------------------------------
// 源码 / 样式契约（这几条都是「真机上才看得出来」的那类错）
// ---------------------------------------------------------------------------

describe('高亮层的样式契约', () => {
  const css = readFileSync(join(clientDir, 'refinements.css'), 'utf8');
  const reader = readFileSync(join(clientDir, 'BookReader.jsx'), 'utf8');

  it('★ 高亮层必须 pointer-events: none（否则划过线的文字拖选不了）', () => {
    const rule = /\.npr-book-marks\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule !== null, '找不到 .npr-book-marks 规则');
    assert.match(rule[1], /pointer-events:\s*none/, '高亮层能接收点击 ⇒ 已经划过线的地方再也拖选不出新的一条');
  });

  it('★ 夜间配色下高亮改 screen（黑底上 multiply 等于看不见）', () => {
    assert.match(css, /\.npr-book\[data-tint="night"\]\s*\.npr-book-mark\s*\{[^}]*mix-blend-mode:\s*screen/);
  });

  it('四种颜色都有 CSS 变量定义（缺一个就是「点了没反应」）', () => {
    for (const tone of TONE_ORDER) {
      assert.match(css, new RegExp(`\\.npr-book-mark\\[data-tone="${tone}"\\][^{]*\\{[^}]*--npr-mark-color`), `缺 ${tone} 的色值`);
    }
  });

  it('高亮矩形用 data-tone 上色（而不是内联 style 里写死颜色）', () => {
    assert.match(reader, /className="npr-book-mark" data-tone=\{mark\.tone\}/);
    assert.doesNotMatch(reader, /className="npr-book-mark"[^>]*background/, '内联背景色会让四种颜色绕过 CSS，夜间档就没法覆盖');
  });

  it('面板与目录互斥：打开划线时收掉目录/伴读/要点浮层', () => {
    const block = /const toggleMarks = useCallback\([\s\S]*?\}, \[[^\]]*\]\);/.exec(reader);
    assert.ok(block !== null, '找不到 toggleMarks');
    for (const call of ['closeDigest(', 'setCompanion(false)', 'setExpandedN(0)']) {
      assert.ok(block[0].includes(call), `toggleMarks 漏了 ${call} —— 打开划线面板时另外两栏还开着`);
    }
  });
});
