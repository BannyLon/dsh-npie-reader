/**
 * 「上次提笔」那一行的时间说法。
 *
 * ★ 这个函数的存在理由，是「那年今日」在**第一年**没有东西可显示（用户 2026-10-29：
 *   「感觉要用一年之后才会有那年今日，那么第一年这里怎么办？这是个逻辑bug」）。
 *   退路是「上一次写日记是哪天」，而「哪天」不能用 `2026-10-17` 这种机器日期说话 ——
 *   这一块的用途是让人想起那一天，所以时间要说成「昨天 / 12 天前 / 去年 7 月 12 日」。
 *
 * 规则：
 *   - 跨年：直接给年份（「2025 年 12 月 3 日」）—— 「12 月 3 日」在同一年里才是唯一的。
 *   - 隔一天：说「昨天」。说「1 天前」也行，但那是一句翻译腔。
 *   - 两个月内：说「N 天前 · 10 月 17 日」。给两个说法是因为**天数是感觉、日期是事实**：
 *     只有天数时用户不知道是哪天，只有日期时又要自己减一遍。
 *   - 再远：只说日期。60 天以后「87 天前」已经不再是一个能唤起记忆的量。
 *
 * `daysAgo` 由宿主算（UTC 差值），这里不做日期运算 —— 本地时区跨夏令时按毫秒算会把
 * 「昨天」算成前天，宿主那边已经踩过这个坑（`shiftDay()` 的注释）。
 *
 * @param {{ date?: string, daysAgo?: number, today?: string }} cell
 * @param {string} [today] 今天的 `YYYY-MM-DD`；缺省时按 `cell.today`，再缺省就不判跨年
 * @returns {string} 例如 `昨天 · 10 月 28 日` / `12 天前 · 10 月 17 日` / `2025 年 12 月 3 日`
 */
export function agoLabel(cell, today) {
  const date = String(cell?.date ?? '');
  const [year, mm, dd] = date.split('-');
  if (!year || !mm || !dd) return '';
  const day = `${Number(mm)} 月 ${Number(dd)} 日`;
  const todayYear = String(today ?? cell?.today ?? '').slice(0, 4);
  if (todayYear !== '' && todayYear !== year) return `${year} 年 ${day}`;
  const days = Number(cell?.daysAgo);
  if (!Number.isFinite(days) || days <= 0) return day;
  if (days === 1) return `昨天 · ${day}`;
  if (days < 60) return `${days} 天前 · ${day}`;
  return day;
}
