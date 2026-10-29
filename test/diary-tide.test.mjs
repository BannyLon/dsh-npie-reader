/**
 * `diary-tide.js` —— 「心绪潮汐」的几何与那句人话。
 *
 * ★ 为什么值得单测：坐标算错的后果是「线画歪了」，而画歪的线**看起来仍然像一条线**。
 *   它不报错、不白屏，只会安静地说一句假话（比如把一个 15 天的空档连成一条
 *   「那阵子很平稳」的斜线）。这类错只能靠坐标断言按住。
 *
 * ★ 守五件事：
 *   ① 每一天落在自己那一格上（1 号在最左、月末在最右）—— 和日历同构；
 *   ② 情绪 5 档 → 纵坐标是**反的**（5 在上面）；
 *   ③ 缺口超过 2 天就断开，绝不横穿；
 *   ④ 一天多条的取平均（不是取最后一条、也不是取最高那条）；
 *   ⑤ 点太少就不谈走势 —— 三四个点分两半，那一半只有一个点。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dayX, daysInMonth, scoreY, tideGeometry, tideReading } from '../src/client/diary-tide.js';

const OCT = '2026-10';

describe('心绪潮汐：几何', () => {
  test('一个月的天数（含闰年 2 月）', () => {
    assert.equal(daysInMonth('2026-10'), 31);
    assert.equal(daysInMonth('2026-02'), 28);
    assert.equal(daysInMonth('2024-02'), 29);
    assert.equal(daysInMonth('乱七八糟'), 0);
  });

  test('★ 1 号在最左、最后一天在最右 —— 与日历同构', () => {
    assert.equal(dayX(1, OCT), 0);
    assert.equal(dayX(31, OCT), 100);
    // 中间的格子等距：16 号正落在中点。
    assert.ok(Math.abs(dayX(16, OCT) - 50) < 0.001);
    // 越界的日期夹回边界，不画到画布外面去。
    assert.equal(dayX(40, OCT), 100);
    assert.equal(dayX(-3, OCT), 0);
  });

  test('★ 5 档在最上面、1 档在最下面（纵坐标是反的）', () => {
    assert.ok(scoreY(5) < scoreY(3), '「很好」画得比「一般」低 —— 上下颠倒了');
    assert.ok(scoreY(3) < scoreY(1));
    assert.equal(scoreY(5), 12);
    assert.equal(scoreY(1), 88);
    // 越界的分数夹回 1~5，不画到画布外。
    assert.equal(scoreY(9), scoreY(5));
    assert.equal(scoreY(0), scoreY(1));
  });

  test('★ 一天多条取平均（0.51 宿主给的就是平均分）', () => {
    const { points } = tideGeometry([{ date: '2026-10-05', score: 2.5 }], OCT);
    assert.equal(points.length, 1);
    assert.equal(points[0].y, scoreY(2.5));
  });

  test('★ 缺口超过 2 天就断开：不许一条直线横穿半个月', () => {
    const { segments } = tideGeometry([
      { date: '2026-10-01', score: 4 },
      { date: '2026-10-02', score: 3 },
      // 隔两天（3 号跳过、4 号有）→ 仍算同一段。
      { date: '2026-10-04', score: 2 },
      // 隔 14 天 → 必须断开。
      { date: '2026-10-18', score: 5 },
      { date: '2026-10-19', score: 5 },
    ], OCT);
    assert.equal(segments.length, 2, '断点没生效 —— 中间那半个月会被画成一条平缓的斜线');
    assert.deepEqual(segments[0].map((point) => point.date), ['2026-10-01', '2026-10-02', '2026-10-04']);
    assert.deepEqual(segments[1].map((point) => point.date), ['2026-10-18', '2026-10-19']);
  });

  test('★ 只要这个月的点：翻到 9 月时，10 月的记忆不该混进来', () => {
    const { points } = tideGeometry([
      { date: '2026-09-30', score: 4 },
      { date: '2026-10-02', score: 2 },
    ], OCT);
    assert.deepEqual(points.map((point) => point.date), ['2026-10-02']);
  });

  test('乱序输入会被排好：宿主换了顺序也不至于把线倒退着画', () => {
    const { points } = tideGeometry([
      { date: '2026-10-20', score: 2 },
      { date: '2026-10-03', score: 5 },
    ], OCT);
    assert.deepEqual(points.map((point) => point.day), [3, 20]);
  });

  test('脏数据不抛错，只是不落点', () => {
    const { points } = tideGeometry([
      { date: '2026-10-05' },            // 没有 score
      { date: '2026-10-0x', score: 3 },  // 日期不合法
      { score: 4 },                      // 没有日期
      null,
    ], OCT);
    assert.equal(points.length, 0);
  });
});

describe('心绪潮汐：那句话', () => {
  const moods = [{ score: 3, count: 6 }, { score: 2, count: 4 }];
  const series = (list) => list.map((score, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    score,
  }));

  test('没有心情就不说话（而不是说「这个月很平静」）', () => {
    assert.equal(tideReading({ moods: [], series: [] }), '');
    assert.equal(tideReading({}), '');
  });

  test('★ 主调来自 `moods[0]`（和下面那几枚 chip 同一个来源）', () => {
    assert.equal(tideReading({ moods, series: series([3, 3, 3]) }), '大多是平平的日子。');
    assert.equal(tideReading({ moods: [{ score: 5, count: 3 }], series: series([5, 5, 5]) }), '亮的日子多些。');
  });

  test('★ 只有一两天就**不谈分布**：那条正好是 2 分，也不该说「烦的时候不少」', () => {
    // 用户刚开张两天的真实处境。一个凑出来的结论比没有结论更糟。
    assert.equal(tideReading({ moods: [{ score: 2, count: 1 }, { score: 4, count: 1 }], series: series([2, 4]) }),
      '这个月只有 2 天记了心情，还看不出走势。');
    assert.equal(tideReading({ moods: [{ score: 3, count: 1 }], series: series([3]) }),
      '这个月只有 1 天记了心情，还看不出走势。');
  });

  test('★ 四个点以上才谈走势，且走势只看「前一半 vs 后一半」', () => {
    assert.equal(tideReading({ moods, series: series([4, 4, 4, 4]) }), '大多是平平的日子，一个月里起落不大。');
    assert.equal(tideReading({ moods, series: series([1, 1, 5, 5]) }), '大多是平平的日子，最近在往上走。');
    assert.equal(tideReading({ moods, series: series([5, 5, 1, 1]) }), '大多是平平的日子，最近沉了一些。');
  });

  test('★ 差半档不算走势：那多半是「某一天的心情低了一档」', () => {
    // 前半 3.0、后半 3.5 ⇒ 差 0.5，够不上 0.75 的门槛。
    assert.equal(tideReading({ moods, series: series([3, 3, 3, 4]) }), '大多是平平的日子，一个月里起落不大。');
    // 但真正的趋势（差 1 档以上）必须说出来。
    assert.equal(tideReading({ moods, series: series([2, 2, 2, 4]) }), '大多是平平的日子，最近在往上走。');
  });

  test('别处的 `count: 0` 不说成主调', () => {
    assert.equal(tideReading({ moods: [{ score: 3, count: 0 }], series: [] }), '');
  });
});
