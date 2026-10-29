/**
 * 「心绪潮汐」——这个月的心情折线。
 *
 * ★ 一条线说的事，两三个百分比说不出来：**时间**。月中塌了一次、月末有没有回上来，
 *   只有把点按日期排开才看得见。所以这块不再是「占比卡片」，是一条潮位线。
 * ★ 坐标全在 `diary-tide.js` 里算（有单测）。这里只负责把它画出来 ——
 *   组件里做日期算术的后果是「画歪了也不报错」，而画歪的线仍然像一条线。
 * ★ 用 `preserveAspectRatio="none"` 让 viewBox 随容器拉伸（268px 到 420px 都对得上日历
 *   的横向比例）；代价是描边会被非等比缩放，所以描边一律 `vector-effect="non-scaling-stroke"`，
 *   圆点不用 SVG 画（会被压成椭圆），改用绝对定位的 DOM 圆点。
 */
import { useMemo } from 'react';
import { dayX, daysInMonth, tideGeometry } from './diary-tide.js';

/** `[{x,y}]` → `"x,y x,y"`。 */
function toPoints(list) {
  return list.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

/** 每周一道格线：8 / 15 / 22 / 29 号。1 号本身就是左边缘，不必再画。 */
const WEEK_TICKS = Object.freeze([8, 15, 22, 29]);

/** 面积：折线 + 沿着底边合回来。 */
function toArea(list) {
  const first = list[0];
  const last = list[list.length - 1];
  return `${toPoints(list)} ${last.x.toFixed(2)},100 ${first.x.toFixed(2)},100`;
}

/**
 * @param props.series - `[{ date: 'YYYY-MM-DD', score: 1..5 }]`，宿主给的按天基调。
 * @param props.monthKey - `YYYY-MM`，决定横轴的格子数与缺口的位置。
 * @param props.selected - 当前选中的那一天：画一条很淡的竖线，把曲线和上面的日历系在一起。
 */
export function DiaryTide({ series, monthKey, selected }) {
  const { points, segments } = useMemo(() => tideGeometry(series, monthKey), [series, monthKey]);
  const total = daysInMonth(monthKey);
  const markerX = typeof selected === 'string' && selected.slice(0, 7) === monthKey
    ? dayX(Number(selected.slice(8)), monthKey)
    : null;
  if (points.length === 0) return null;

  /*
   * 点少的时候把每一天都点出来 —— 「这个月只记了两天」不能画成一片空白，
   * 那看起来像图坏了。点多的时候只留孤点和最新那个（十四个点串起来已经很花）。
   */
  const last = points[points.length - 1];
  const candidates = points.length <= 8
    ? points
    : [...segments.filter((run) => run.length === 1).map((run) => run[0]),
      ...(segments[segments.length - 1]?.length >= 2 ? [last] : [])];
  const dots = [];
  for (const point of candidates) {
    if (!dots.some((seen) => seen.date === point.date)) dots.push(point);
  }

  return (
    <div
      className="npr-diary-tide"
      role="img"
      aria-label={`本月 ${points.length} 天记过心情，这里是它们连成的走势`}>
      <svg className="npr-diary-tide-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {/*
          * 每周一道极淡的竖格线（像本子上印的格子）。
          * ★ 不是因为好看：数据稀疏时（刚开张两三天），大半张图是空的，
          *   而空图看起来像**坏了**。格子把「空白」说成「还没写」——
          *   同一片空白，有没有参照物，读出来的意思完全不同。
          * ★ 选中的那天不画格线：那天另有一条自己的标记线，两条叠在同一处
          *   会变成一条更深的虚线 —— 看起来像「这天有两条线」，其实只有一条。
          */}
        {WEEK_TICKS
          .filter((day) => markerX === null || Math.abs(dayX(day, monthKey) - markerX) > 0.01)
          .map((day) => (
            <line
              key={day}
              className="npr-diary-tide-grid"
              x1={dayX(day, monthKey)}
              y1="0"
              x2={dayX(day, monthKey)}
              y2="100"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        <line className="npr-diary-tide-base" x1="0" y1="99.5" x2="100" y2="99.5" vectorEffect="non-scaling-stroke" />
        {markerX !== null && total > 0 && (
          <line className="npr-diary-tide-mark" x1={markerX} y1="0" x2={markerX} y2="100" vectorEffect="non-scaling-stroke" />
        )}
        {segments.filter((run) => run.length >= 2).map((run) => (
          <g key={`${run[0].date}-${run[run.length - 1].date}`}>
            <polygon className="npr-diary-tide-fill" points={toArea(run)} />
            <polyline className="npr-diary-tide-line" points={toPoints(run)} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
      {dots.map((point) => (
        <span
          key={point.date}
          className={`npr-diary-tide-dot${point === last ? ' is-last' : ''}`}
          style={{ left: `${point.x}%`, top: `${point.y}%` }}
        />
      ))}
    </div>
  );
}
