/**
 * Formatting helpers for the reader.
 *
 * The host rule is: one controlled formatter, never a naked `toLocaleString()`
 * whose output depends on ambient locale/timezone defaults. Every formatter
 * here pins an explicit locale and an explicitly resolved timezone, and the
 * instances are shared so repeated calls stay consistent.
 */
const LOCALE = (() => {
  const lang = globalThis.document?.documentElement?.lang;
  return typeof lang === 'string' && lang.trim() !== '' ? lang : 'zh-CN';
})();

const TIME_ZONE = (() => {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

const dayFormatter = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, month: 'numeric', day: 'numeric' });
const fullDayFormatter = new Intl.DateTimeFormat(LOCALE, { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function parse(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Short list-row date, e.g. `9/24`. Empty string when unparseable. */
export function formatDay(value) {
  const date = parse(value);
  return date ? dayFormatter.format(date) : '';
}

/** Full article date, e.g. `2025/09/24`. Empty string when unparseable. */
export function formatFullDay(value) {
  const date = parse(value);
  return date ? fullDayFormatter.format(date) : '';
}

export const READER_LOCALE = LOCALE;
export const READER_TIME_ZONE = TIME_ZONE;
