/**
 * 时间窗：把 agent 传进来的 `since` / `until` 解析成毫秒区间，并用同一套判据过滤条目。
 *
 * 为什么单独一个模块：同一个数据文档里混着两种时间形态 —— `entry.publishedAt` 是
 * **ISO 字符串**（见 `feeds.js` 的 `dateOf`），而 `lastFetchedAt` 是 `Date.now()` 毫秒数。
 * 判定逻辑只写一遍，才不会出现「列表说 3 天、工具说 4 天」这种分叉。
 *
 * 接受的写法：
 *   - 相对：`30m` / `12h` / `3d` / `2w` / `1mo`（相对 `now` 往前推）
 *   - 日期：`2026-10-05`（按 UTC 零点解释）
 *   - 日期时间：`2026-10-05T08:00:00Z` 或带偏移量的完整 ISO 串
 *   - 毫秒数
 *
 * ★ 日期形态的 `until` **含整天**：`until: '2026-10-08'` 解析成该日 23:59:59.999Z。
 *   不这么做的话，「最近到 10 月 8 日」会把 10 月 8 日当天发的文章全部漏掉 ——
 *   这是时间窗最经典的一个差一天。
 */

/** 相对写法：数字 + 单位。`mo` 必须排在 `m` 前面，否则 `1mo` 会被当成 1 分钟。 */
const RELATIVE_RE = /^(\d+(?:\.\d+)?)(mo|[mhdw])$/i;
const UNIT_MS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,
};
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * 时间值 → 毫秒数。认不出来一律回 `0`（由调用方当「没有时间」处理）。
 * `publishedAt` 是 ISO 字符串，`lastFetchedAt` 是毫秒数，两种都要能转。
 */
export function toMillis(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 这个值有没有可用的时间。没有的话，设了时间窗就必须把它排除。 */
export function isDated(value) {
  return toMillis(value) > 0;
}

/**
 * @param {{ since?: string|number, until?: string|number }} request
 * @param {number} [now] 注入当前时间，便于测试
 * @returns {{ from?: number, to?: number }} 两端都可能缺省（= 该侧不设限）
 */
export function parseWindow(request = {}, now = Date.now()) {
  const from = parseBound(request.since, now, 'since', false);
  const to = parseBound(request.until, now, 'until', true);
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error('时间窗的起点晚于终点，检查 since / until');
  }
  return { from, to };
}

function parseBound(value, now, field, isEnd) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} 不是有效的毫秒时间戳`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`${field} 只接受字符串或毫秒数`);
  const raw = value.trim();
  if (raw === '') return undefined;

  const relative = RELATIVE_RE.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[relative[2].toLowerCase()];
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${field} 的相对时间必须是正数`);
    return now - amount * unit;
  }

  if (DATE_ONLY_RE.test(raw)) {
    const start = Date.parse(`${raw}T00:00:00Z`);
    if (Number.isNaN(start)) throw new Error(`${field} 不是有效的日期：${raw}`);
    // ★ 终点含整天，否则「到 10 月 8 日」会把当天发的全漏掉。
    return isEnd ? start + DAY_MS - 1 : start;
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${field} 认不出来：${raw}（可用 3d / 72h / 2w / 2026-10-05 / 完整 ISO 时间）`);
  }
  return parsed;
}

/** 有没有设时间窗。没设时不该去统计「无时间条目被排除了几条」。 */
export function hasWindow(window) {
  return Boolean(window) && (window.from !== undefined || window.to !== undefined);
}

/**
 * 条目时间落不落在窗口内。
 * ★ 没有时间的条目一律**不算命中** —— 把无法证明在窗口内的东西算进来，
 *   等于让「最近 3 天」这个承诺变成假的。调用方负责把这类条目数出来告知用户。
 */
export function withinWindow(value, window) {
  const ms = toMillis(value);
  if (ms === 0) return false;
  if (window.from !== undefined && ms < window.from) return false;
  if (window.to !== undefined && ms > window.to) return false;
  return true;
}

/**
 * 给人看的时间窗描述。用 UTC 格式化，与日期形态的解析口径一致（`Date.parse('2026-10-05')`
 * 也是 UTC 零点），否则界面上会出现「窗说 10-05、条目说 10-06」这种错位。
 */
export function windowLabel(window) {
  if (!hasWindow(window)) return undefined;
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  if (window.from !== undefined && window.to !== undefined) return `${day(window.from)} → ${day(window.to)}`;
  if (window.from !== undefined) return `≥ ${day(window.from)}`;
  return `≤ ${day(window.to)}`;
}
