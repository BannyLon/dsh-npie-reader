/**
 * 0.88.0：阅读周报的边界与计数。
 *
 * 守的是「数字看着对、但和用户记忆差一天」这类缺陷 —— 它不报错、不空白。
 * 所以每条断言都配一个**反向对照**（相邻的那一天必须落在另一周），否则
 * 「整周都算进来」这种实现也能让正向断言全绿。
 *
 * 全部用固定日期，不看 `Date.now()`：周报要能回看任意一周，测试也一样。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dateKeyOf, inRange, isoWeek, moodLabel, ms, mondayOfWeekKey, streakEndingAt, summarizeWeekly,
  topCounts, weekKeyOf, weekRange, weeklyHeadline,
} from '../src/host/weekly.js';

const at = (key, hour = 12) => new Date(`${key}T${String(hour).padStart(2, '0')}:00:00`).getTime();

describe('0.88.0：周区间（周一 → 周日）', () => {
  it('★ 2026-W47 = 11/16（周一）～ 11/22（周日）', () => {
    const range = weekRange('2026-W47');
    assert.equal(range.fromKey, '2026-11-16');
    assert.equal(range.toKey, '2026-11-22');
    assert.deepEqual(range.days, [
      '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22',
    ]);
    assert.equal(range.key, '2026-W47');
  });

  it('★ 周日 23:59 属本周；下周一 00:00 属下一周（反向对照）', () => {
    const range = weekRange('2026-W47');
    assert.equal(inRange(at('2026-11-22', 23), range), true, '周日晚上写的被算到下一周了');
    assert.equal(inRange(at('2026-11-23', 0), range), false, '下周一被算进本周了');
    assert.equal(inRange(at('2026-11-16', 0), range), true, '周一凌晨被漏掉了');
    assert.equal(inRange(at('2026-11-15', 23), range), false, '上周日被算进本周了');
  });

  it('★ 传任意一天都落到它所在的那一周，不要求传周一', () => {
    for (const day of ['2026-11-16', '2026-11-18', '2026-11-22']) {
      assert.equal(weekRange(at(day)).key, '2026-W47', `${day} 没落在 W47`);
    }
  });

  it('跨年：2027-01-01（周五）属 2026-W53，不属 2027-W01', () => {
    assert.equal(weekKeyOf(at('2027-01-01')), '2026-W53');
    // 反向对照：2027-01-04 是周一，才是 2027-W01。
    assert.equal(weekKeyOf(at('2027-01-04')), '2027-W01');
    // 而 2026-12-31 与 2027-01-01 必须是同一周 —— 这一条才是「跨年」的真正含义。
    assert.equal(weekRange(at('2026-12-31')).key, weekRange(at('2027-01-01')).key);
    assert.equal(weekRange(at('2027-01-01')).fromKey, '2026-12-28');
  });

  it('2026-01-01（周四）属 2026-W01', () => {
    assert.equal(weekKeyOf(at('2026-01-01')), '2026-W01');
  });

  it('非法周键返回 null，而不是悄悄给一个别的周', () => {
    assert.equal(weekRange('2026-W99'), null);
    assert.equal(weekRange('2026-53-01'), null);
    // 2026 年**有** 53 周（12/31 是周四，见上面跨年那条），所以越界要用 54。
    assert.equal(mondayOfWeekKey('2026-W54'), null);
    assert.notEqual(mondayOfWeekKey('2026-W53'), null, '2026-W53 是合法周，不能被拒');
    assert.notEqual(mondayOfWeekKey('2026-W47'), null);
  });

  it('周键可以排序（侧栏按时间倒序要用）', () => {
    const keys = ['2026-W09', '2026-W10', '2026-W47', '2027-W01'];
    assert.deepEqual([...keys].sort(), keys);
  });
});

describe('0.88.0：时间戳归一', () => {
  it('毫秒、ISO 串、Date 都认；0 与空值是「没有」，不是 1970', () => {
    const base = at('2026-11-18');
    assert.equal(ms(base), base);
    assert.equal(ms(new Date(base)), base);
    assert.equal(ms(new Date(base).toISOString()), base);
    assert.equal(ms(0), 0);
    assert.equal(ms(undefined), 0);
    assert.equal(ms(''), 0);
    assert.equal(ms('not-a-date'), 0);
  });

  it('★ 日期键用本地时区，不用 toISOString', () => {
    // 东八区凌晨 5 点：toISOString 会给出前一天。
    const early = new Date('2026-11-18T05:00:00');
    assert.equal(dateKeyOf(early), '2026-11-18');
    assert.equal(shortIso(early), '2026-11-17', '这条断言是给时区做对照的：UTC 确实是前一天');
  });
});

/** 只为上面那条对照：把「用 UTC 会得到什么」写出来，说明为什么不能用它。 */
function shortIso(date) {
  return date.toISOString().slice(0, 10);
}

describe('0.88.0：周报聚合', () => {
  const range = weekRange('2026-W47');
  const entryIndex = new Map([
    ['https://a.example/1', { title: '甲', feed: '源一' }],
    ['https://a.example/2', { title: '乙', feed: '源一' }],
    ['https://b.example/3', { title: '丙', feed: '源二' }],
    ['https://c.example/4', { title: '丁', feed: '源三' }],
  ]);

  it('★ 只统计本周的已读，上周的不能混进来', () => {
    const report = summarizeWeekly({
      range,
      read: {
        'https://a.example/1': at('2026-11-17'),
        'https://a.example/2': at('2026-11-21'),
        'https://b.example/3': at('2026-11-10'), // 上周
      },
      entryIndex,
    });
    assert.equal(report.reading.articles, 2);
    assert.deepEqual(report.reading.titles.map((row) => row.title), ['乙', '甲'], '应按时间倒序');
    assert.equal(report.empty, false);
  });

  it('★ 论文不能算进「读完的书」（反向对照）', () => {
    const report = summarizeWeekly({
      range,
      states: {
        b00001: { finishedAt: at('2026-11-19'), at: at('2026-11-19') },
        p00001: { finishedAt: at('2026-11-20'), at: at('2026-11-20') },
      },
      bookTitles: [{ id: 'b00001', title: '一本书' }, { id: 'p00001', title: '一篇论文' }],
      papers: [{ id: 'p00001', title: '一篇论文', addedAt: at('2026-11-01') }],
    });
    assert.deepEqual(report.books.finished.map((row) => row.id), ['b00001']);
    assert.deepEqual(report.papers.finished.map((row) => row.id), ['p00001']);
  });

  it('读完的那本不再重复算进「在推进」', () => {
    const report = summarizeWeekly({
      range,
      states: { b1: { state: 'read', finishedAt: at('2026-11-19'), at: at('2026-11-20') } },
      bookTitles: [{ id: 'b1', title: '书' }],
    });
    assert.equal(report.books.finished.length, 1);
    assert.equal(report.books.progressed.length, 0, '同一本书被数了两次');
  });

  it('日记：只数区间内的天，情绪只收 1..5，读后感单独列出', () => {
    const report = summarizeWeekly({
      range,
      diaryDays: [
        { date: '2026-11-17', entries: [
          { kind: '灵感', body: '今天想到一件事', mood: { score: 4 } },
          { kind: '读后感', body: '这本书讲的是**信任**的成本', meta: { book: 'b1' }, mood: 5 },
        ] },
        { date: '2026-11-18', entries: [{ kind: '私密', body: '不想说', mood: 3 }] },
        { date: '2026-11-10', entries: [{ kind: '灵感', body: '上周的' }] }, // 不在区间
      ],
      bookTitles: [{ id: 'b1', title: '信任' }],
    });
    assert.equal(report.writing.entries, 3);
    assert.equal(report.writing.days, 2);
    assert.deepEqual(report.writing.dayKeys, ['2026-11-17', '2026-11-18']);
    assert.equal(report.writing.byKind['灵感'], 1);
    assert.equal(report.writing.byKind['私密'], 1);
    assert.equal(report.writing.reflections.length, 1);
    assert.equal(report.writing.reflections[0].title, '信任');
    assert.equal(report.writing.reflections[0].date, '2026-11-17');
    assert.deepEqual(report.writing.moods.map((row) => row.score), [4, 5, 3].sort((a, b) => a - b).reverse().slice(0, 3).sort((a, b) => b - a));
  });

  it('情绪越界（0 / 6 / 非数字）不收，也不报错', () => {
    const report = summarizeWeekly({
      range,
      diaryDays: [{ date: '2026-11-17', entries: [
        { kind: '灵感', body: 'x', mood: 0 }, { kind: '灵感', body: 'y', mood: 6 }, { kind: '灵感', body: 'z', mood: 'abc' },
      ] }],
    });
    assert.deepEqual(report.writing.moods, []);
    assert.equal(report.writing.entries, 3, '情绪无效不该把条目本身丢掉');
  });

  it('划线的 bookId 变成书名，且按条数排序', () => {
    const report = summarizeWeekly({
      range,
      annotations: [
        { bookId: 'b1', createdAt: at('2026-11-17') },
        { bookId: 'b1', createdAt: at('2026-11-18') },
        { bookId: 'b2', createdAt: at('2026-11-19') },
        { bookId: 'b1', createdAt: at('2026-11-01') }, // 上周
      ],
      bookTitles: [{ id: 'b1', title: '甲书' }, { id: 'b2', title: '乙书' }],
    });
    assert.equal(report.books.highlightCount, 3);
    assert.deepEqual(report.books.highlights.map((row) => [row.title, row.count]), [['甲书', 2], ['乙书', 1]]);
  });

  it('空周：empty 为 true，概览是一句人话（不是「无数据」）', () => {
    const report = summarizeWeekly({ range });
    assert.equal(report.empty, true);
    assert.equal(weeklyHeadline(report), '这一周没有记录');
  });

  it('概览最多三项，且只报非零项', () => {
    const headline = weeklyHeadline({
      reading: { articles: 12 },
      books: { finished: [{ id: 'b1' }, { id: 'b2' }], progressed: [] },
      writing: { entries: 5 },
    });
    assert.equal(headline, '读了 12 篇 · 读完 2 本 · 写了 5 条');
    // 反向对照：一项都没有时不能拼出「读了 0 篇」。
    assert.equal(weeklyHeadline({ reading: { articles: 0 }, books: { finished: [], progressed: [{ id: 'b1' }] }, writing: { entries: 0 } }), '翻了 1 本书');
  });

  it('「常看的源」按条数降序，同数按名字稳定排序', () => {
    // 同条数时按拼音（`localeCompare('zh')`）：甲 jia < 乙 yi，所以甲在前。
    const rows = topCounts([['乙'], ['甲'], ['乙'], ['丙'], ['甲']], 3);
    assert.deepEqual(rows.map((row) => row.name), ['甲', '乙', '丙']);
    assert.deepEqual(rows.map((row) => row.count), [2, 2, 1]);
    assert.deepEqual(topCounts([['同'], ['同']], 3).length, 1);
  });
});

describe('0.88.0：连写天数', () => {
  it('★ 从这一周最后一天往回数', () => {
    assert.equal(streakEndingAt(['2026-11-20', '2026-11-21', '2026-11-22'], '2026-11-22'), 3);
    // 反向对照：断一天就停。
    assert.equal(streakEndingAt(['2026-11-19', '2026-11-21', '2026-11-22'], '2026-11-22'), 2);
    assert.equal(streakEndingAt([], '2026-11-22'), 0);
  });

  it('周日没写也不算断（周报看的是这一周，不是今天）', () => {
    // 最后一天没写 ⇒ 从 endKey 起就算不出来；这由调用方用「最后写过的那天」兜住。
    // 这里钉住的是：不写 endKey 时它是 0，不会凭空给一个 1。
    assert.equal(streakEndingAt(['2026-11-20'], '2026-11-22'), 0);
  });

  it('跨月往回数不断', () => {
    assert.equal(streakEndingAt(['2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02'), 3);
  });
});

describe('0.88.0：ISO 周算法自检', () => {
  it('一年内的周号连续递增，不跳号不复号', () => {
    let previous = 0;
    for (let day = 0; day < 366; day += 1) {
      const date = new Date(2026, 0, 1 + day);
      if (date.getFullYear() !== 2026) break;
      const { week } = isoWeek(date);
      assert.ok(week >= previous, `第 ${day} 天周号倒退了：${previous} → ${week}`);
      previous = week;
    }
    assert.ok(previous >= 52, `2026 年只数到 ${previous} 周，明显不对`);
  });

  it('每个周键反解出来的周一，再正解回去还是同一个键', () => {
    for (const key of ['2026-W01', '2026-W09', '2026-W47', '2026-W53', '2027-W01']) {
      const monday = mondayOfWeekKey(key);
      assert.ok(monday, `${key} 反解失败`);
      assert.equal(weekKeyOf(monday), key);
    }
  });

  it('情绪文案只在 1..5 有值', () => {
    assert.equal(moodLabel(5), '很好');
    assert.equal(moodLabel(0), '');
    assert.equal(moodLabel(undefined), '');
  });
});
