/**
 * 日记的月历。
 *
 * ★ 它只负责**画格子**，日期算术全部在 `diary-format.mjs` 的 `monthGrid()` 里 ——
 *   那一份两端共用、有单测（含跨月、跨年、闰月）。在这里重写一遍 `getDay()` 的后果
 *   不是「重复」，而是「日历上 10 月 1 日落在周三，而列表按周四取」这种对不上的错。
 *
 * ★ 不在本月的格子**照样可点**（画淡）。点了就跳过去 —— 用户翻到 10 月看到开头有
 *   9 月 28 日，想看那天的日记，最自然的动作就是点它；点了没反应会让人以为坏了。
 */
import { MOODS, monthGrid } from '../diary-format.js';
import { Icon } from './icons.jsx';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** `tone → 中文名`。日历的无障碍名与 title 都用它，别在 JSX 里再写一遍五个字面量。 */
const MOOD_LABEL = Object.fromEntries(MOODS.map((mood) => [mood.tone, mood.label]));

/**
 * @param props.year - 四位年份。
 * @param props.month0 - 0 起的月份。
 * @param props.marks - `{ [dateKey]: 条数 }`，只含本月。
 *   ★ 必须是**某一侧**的计数（私密模块传 `privateDays`，不是两半相加的 `days`）：
 *   传合计会让私密日历上的点跟着灵感一起亮 —— 用户 2026-10-27 报的就是这个。
 * @param props.tones - `{ [dateKey]: 1..5 }`，那一天的心情分（没记过就没有键）。
 *   有它就按档上色，没有就画默认灰点。
 * @param props.selected - 当前选中的 `YYYY-MM-DD`。
 * @param props.today - 今天的 `YYYY-MM-DD`（由调用方给，组件不自己取时间：
 *   取时间会让「今天」在渲染与测试之间漂移，而它一天只该变一次）。
 * @param props.onPick - `(dateKey) => void`。
 * @param props.onShift - `(delta) => void`，翻月。
 * @param props.onToday - 回到今天。
 */
export function DiaryCalendar({ year, month0, marks = {}, tones = {}, selected, today, onPick, onShift, onToday }) {
  const cells = monthGrid(year, month0, today);
  const written = cells.filter((cell) => cell.inMonth && (marks[cell.key] ?? 0) > 0).length;

  return (
    <div className="npr-diary-cal">
      <div className="npr-diary-cal-head">
        <button type="button" className="npr-icon" title="上个月" aria-label="上个月" onClick={() => onShift(-1)}>
          <Icon name="chevron-left" size={14} />
        </button>
        <span className="npr-diary-cal-title">{year} 年 {month0 + 1} 月</span>
        <button type="button" className="npr-icon" title="下个月" aria-label="下个月" onClick={() => onShift(1)}>
          <Icon name="chevron-right" size={14} />
        </button>
        <button type="button" className="npr-diary-cal-today" onClick={onToday} disabled={selected === today}>今天</button>
      </div>
      <div className="npr-diary-cal-week" aria-hidden="true">
        {WEEKDAYS.map((label) => <span key={label}>{label}</span>)}
      </div>
      <div className="npr-diary-cal-grid" role="group" aria-label={`${year} 年 ${month0 + 1} 月`}>
        {cells.map((cell) => {
          const count = marks[cell.key] ?? 0;
          const tone = Number(tones[cell.key]) || 0;
          const classes = ['npr-diary-cal-cell'];
          if (!cell.inMonth) classes.push('is-out');
          if (cell.today) classes.push('is-today');
          if (cell.key === selected) classes.push('is-selected');
          if (count > 0) classes.push('has-entries');
          return (
            <button key={cell.key} type="button" className={classes.join(' ')}
              aria-pressed={cell.key === selected}
              /* ★ 无障碍名里必须带**条数**：只报日期的话，读屏用户完全不知道哪天写过东西，
                 而「哪几天写过」正是这个日历存在的理由。记过心情的再加一句 ——
                 颜色对读屏用户是不存在的，那是**并列**的信息，不是装饰。 */
              aria-label={`${cell.key}${count > 0 ? `，${count} 条` : '，没有日记'}${tone > 0 ? `，心情 ${MOOD_LABEL[tone] ?? tone}` : ''}`}
              title={count > 0 ? `${cell.key} · ${count} 条${tone > 0 ? ` · ${MOOD_LABEL[tone] ?? ''}` : ''}` : cell.key}
              onClick={() => onPick(cell.key)}>
              <span className="npr-diary-cal-day">{cell.day}</span>
              {count > 0 && <span className="npr-diary-cal-dot" data-tone={tone > 0 ? tone : undefined} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <p className="npr-diary-cal-note" role="status">
        {written > 0 ? `这个月写了 ${written} 天` : '这个月还没写'}
      </p>
    </div>
  );
}
