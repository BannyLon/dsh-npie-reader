import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { hasWindow, parseWindow, toMillis, windowLabel, withinWindow } from '../src/host/time-window.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86_400_000;

describe('toMillis', () => {
  it('认 ISO 字符串、毫秒数，认不出来一律回 0', () => {
    assert.equal(toMillis('2026-10-05T00:00:00Z'), Date.parse('2026-10-05T00:00:00Z'));
    assert.equal(toMillis(1_700_000_000_000), 1_700_000_000_000);
    assert.equal(toMillis('not a date'), 0);
    assert.equal(toMillis(undefined), 0);
    assert.equal(toMillis(null), 0);
    assert.equal(toMillis({}), 0);
  });

  it('反向对照：0 与负数不是合法时间，不能被当成 1970 年', () => {
    // 客户端把 0 当「没有时间」；若这里把 0 原样返回，界面会显示「19000 天没更新」。
    assert.equal(toMillis(0), 0);
    assert.equal(toMillis(-1), 0);
    assert.equal(toMillis(NaN), 0);
    assert.equal(toMillis(Infinity), 0);
  });
});

describe('parseWindow', () => {
  it('相对写法按 now 往前推', () => {
    assert.equal(parseWindow({ since: '3d' }, NOW).from, NOW - 3 * DAY);
    assert.equal(parseWindow({ since: '72h' }, NOW).from, NOW - 3 * DAY);
    assert.equal(parseWindow({ since: '2w' }, NOW).from, NOW - 14 * DAY);
    assert.equal(parseWindow({ since: '30m' }, NOW).from, NOW - 30 * 60_000);
  });

  it('★ `mo`（月）不能被当成 `m`（分钟）', () => {
    // 单位表里 `m` 排在 `mo` 前面时，正则会把 `1mo` 截成 `1m` + 剩下 `o` 匹配失败，
    // 于是「最近一个月」静默变成「最近一分钟」，检索结果直接空掉。
    assert.equal(parseWindow({ since: '1mo' }, NOW).from, NOW - 30 * DAY);
    assert.equal(parseWindow({ since: '1m' }, NOW).from, NOW - 60_000);
  });

  it('日期形态按 UTC 零点解释', () => {
    assert.equal(parseWindow({ since: '2026-10-05' }, NOW).from, Date.parse('2026-10-05T00:00:00Z'));
  });

  it('★ 日期形态的 until 含整天 —— 否则「到 10 月 8 日」会把当天发的全漏掉', () => {
    const { to } = parseWindow({ until: '2026-10-08' }, NOW);
    assert.equal(new Date(to).toISOString(), '2026-10-08T23:59:59.999Z');
    // 当天下午发的文章必须在窗口内。
    assert.equal(withinWindow('2026-10-08T18:30:00Z', { to }), true);
  });

  it('缺省一侧不设限', () => {
    assert.deepEqual(parseWindow({}, NOW), { from: undefined, to: undefined });
    assert.deepEqual(parseWindow({ since: '' }, NOW), { from: undefined, to: undefined });
    assert.equal(hasWindow(parseWindow({}, NOW)), false);
    assert.equal(hasWindow(parseWindow({ since: '1d' }, NOW)), true);
  });

  it('反向对照：起点晚于终点要报错，不能静默返回空结果', () => {
    assert.throws(() => parseWindow({ since: '2026-10-09', until: '2026-10-05' }, NOW), /起点晚于终点/);
  });

  it('反向对照：认不出来的写法要报错，不能当成「不设限」', () => {
    // 当成不设限的话，用户说「只看最近 3 天」却拿到全库，而且没有任何提示。
    assert.throws(() => parseWindow({ since: '三天' }, NOW), /认不出来/);
    assert.throws(() => parseWindow({ since: '0d' }, NOW), /正数/);
    assert.throws(() => parseWindow({ since: -1 }, NOW), /毫秒时间戳/);
    assert.throws(() => parseWindow({ since: true }, NOW), /字符串或毫秒数/);
  });
});

describe('withinWindow', () => {
  it('按毫秒比较，两种时间形态都能吃', () => {
    const window = parseWindow({ since: '2026-10-05', until: '2026-10-08' }, NOW);
    assert.equal(withinWindow('2026-10-06T00:00:00Z', window), true);
    assert.equal(withinWindow(Date.parse('2026-10-07T00:00:00Z'), window), true);
    assert.equal(withinWindow('2026-10-04T23:59:59Z', window), false);
    assert.equal(withinWindow('2026-10-09T00:00:00Z', window), false);
  });

  it('★ 没有时间的条目一律不算命中 —— 无法证明它在窗口内', () => {
    // 算进来的话，「最近 3 天」这个承诺就是假的：一篇去年的文章没有时间戳也会混进来。
    const window = parseWindow({ since: '3d' }, NOW);
    assert.equal(withinWindow(undefined, window), false);
    assert.equal(withinWindow('', window), false);
    assert.equal(withinWindow('bad-date', window), false);
    assert.equal(withinWindow(0, window), false);
  });
});

describe('windowLabel', () => {
  it('没设窗口时不产出标签（免得工具输出里出现空括号）', () => {
    assert.equal(windowLabel(parseWindow({}, NOW)), undefined);
    assert.equal(windowLabel(undefined), undefined);
  });

  it('用 UTC 格式化，与日期形态的解析口径一致', () => {
    assert.equal(windowLabel(parseWindow({ since: '2026-10-05', until: '2026-10-08' }, NOW)), '2026-10-05 → 2026-10-08');
    assert.equal(windowLabel(parseWindow({ since: '3d' }, NOW)), '≥ 2026-10-05');
    assert.equal(windowLabel(parseWindow({ until: '2026-10-08' }, NOW)), '≤ 2026-10-08');
  });
});
