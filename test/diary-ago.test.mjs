/**
 * `agoLabel()` —— 「上次提笔」那一行怎么说时间。
 *
 * ★ 它存在的理由：「那年今日」要求往年同月同日写过，第一年整年都不会有内容
 *   （用户 2026-10-29 报的逻辑 bug）。退路是「上一次写日记是哪天」，而这句话
 *   不能直接用 `2031-03-02` 说 —— 这一块的用途是让人想起那一天。
 *
 * ★ 这里守三件界面上一眼看不出来的错：
 *   ① 跨年必须带上年份：「12 月 3 日」在同一年里才是唯一的，跨年就是误导；
 *   ② 隔一天说「昨天」而不是「1 天前」（后者是翻译腔）—— 但这个判断靠 `daysAgo`，
 *      不在这里做日期运算（宿主已按 UTC 算好，本地时区跨夏令时会差一天）；
 *   ③ 太远的日子不再报天数：「87 天前」已经不是一个能唤起记忆的量。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { agoLabel } from '../src/client/diary-ago.js';

describe('agoLabel：上次提笔的时间说法', () => {
  test('隔一天说「昨天」，并带上具体日期', () => {
    assert.equal(agoLabel({ date: '2026-10-28', daysAgo: 1 }, '2026-10-29'), '昨天 · 10 月 28 日');
  });

  test('两个月内说「N 天前 · M 月 D 日」：天数是感觉，日期是事实', () => {
    assert.equal(agoLabel({ date: '2026-10-17', daysAgo: 12 }, '2026-10-29'), '12 天前 · 10 月 17 日');
    assert.equal(agoLabel({ date: '2026-09-01', daysAgo: 58 }, '2026-10-29'), '58 天前 · 9 月 1 日');
  });

  test('★ 跨年必须带年份（否则「12 月 3 日」会被当成今年）', () => {
    assert.equal(agoLabel({ date: '2025-12-03', daysAgo: 330 }, '2026-10-29'), '2025 年 12 月 3 日');
    // 反向对照：同一年就不该出现年份，否则每一条都是「2026 年 ……」很吵。
    assert.doesNotMatch(agoLabel({ date: '2026-01-03', daysAgo: 299 }, '2026-10-29'), /年/);
  });

  test('两个月以上不再报天数，只说日期', () => {
    assert.equal(agoLabel({ date: '2026-07-12', daysAgo: 109 }, '2026-10-29'), '7 月 12 日');
  });

  test('日期不合法时给空串（宁可这一行少一句，也不显示 `undefined 月`）', () => {
    assert.equal(agoLabel({}, '2026-10-29'), '');
    assert.equal(agoLabel({ date: 'x' }, '2026-10-29'), '');
    assert.equal(agoLabel(null, '2026-10-29'), '');
  });

  test('`daysAgo` 缺失时退回只报日期，不猜', () => {
    assert.equal(agoLabel({ date: '2026-10-17' }, '2026-10-29'), '10 月 17 日');
  });
});
