/**
 * 阅读周报：把「这一周读了什么、写了什么」从四份互不相干的数据里拼成一张纸。
 *
 * ★ 为什么要有这个文件（而不是在 `service.weeklyReport()` 里直接算）：
 *   周区间、ISO 周键、跨年、时区，这四件事每一件都能单独算错，而算错的症状
 *   都是「数字看起来挺正常，但和用户记忆对不上」—— 没有报错、没有空白，
 *   只是悄悄少了一天或把周日算进下一周。所以边界与计数全部放在**纯函数**里，
 *   用固定时间戳钉住（`test/weekly.test.mjs`），service 那边只剩「把数据喂进来」。
 *
 * ★ 周的起点是**周一**（ISO 8601）。不要用 `getDay()` 的原生 0=周日：
 *   那会让「周日晚上写的读后感」掉进下一周，而用户明明是在这一周写的。
 *   换算只有一处：`mondayIndex()`。
 *
 * ★ 所有时间戳入口都过 `ms()`：`read{}` 里是毫秒数，`publishedAt` 是 ISO 字符串，
 *   `library.states[].at` 可能是 `0`（表示「从没读过」）。`0` 是**合法时间戳**
 *   （1970 年），但它在这里的语义是「没有」—— 所以用 `> 0` 而不是 `>= 0`。
 *   这一条踩过：频道新鲜度曾经拿 `'2025-09-01T…' > 0` 比大小，`Number(...)` 是 NaN
 *   ⇒ 恒 false ⇒ 每个源都显示「还没抓到过内容」。
 */

/** 一周七天的中文短名，索引与 `dateKeyOf()` 的 `getDay()` 无关（见 `mondayIndex`）。 */
export const WEEKDAY_LABELS = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);

/** 一次周报最多列多少篇「本周读的」，多了没人看，还会把面板撑成一条长列表。 */
export const WEEKLY_TITLE_LIMIT = 8;

/** 周报里「常看的源」列几个。三个足够看出偏向，四个就开始像统计报表了。 */
export const WEEKLY_FEED_LIMIT = 3;

/** 时间戳归一：接受毫秒数、ISO 字符串、Date；拿不到就 `0`（= 没有）。 */
export function ms(value) {
  if (value instanceof Date) {
    const at = value.getTime();
    return Number.isFinite(at) && at > 0 ? at : 0;
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === 'string' && value !== '') {
    const at = Date.parse(value);
    return Number.isFinite(at) && at > 0 ? at : 0;
  }
  return 0;
}

/** 本地日期键 `YYYY-MM-DD`。**绝不用 `toISOString()`**：东八区凌晨 7 点前会写成前一天。 */
export function dateKeyOf(value) {
  const at = value instanceof Date ? value : new Date(ms(value));
  if (!Number.isFinite(at.getTime())) return '';
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 周一=0 … 周日=6。原生 `getDay()` 是周日=0，这里只此一处换算。 */
function mondayIndex(date) {
  return (date.getDay() + 6) % 7;
}

/** 本地零点，用来做「周一到周日」的边界（带时分秒的 Date 直接比较会漏掉当天）。 */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** 本地当天最后一毫秒。周报的 `to` 用它，这样「周日 23:59 写的」也算本周。 */
function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/**
 * ISO 周号（`{ year, week }`）。
 *
 * 算法是标准的那一套：先挪到本周周四，再和当年第一个周四比周差。
 * ★ 必须挪到**周四**而不是周一：跨年那几天（12 月 29 日～1 月 3 日）属于哪一年
 *   由「这一周有没有 4 天在新年」决定，周四刚好是分界点。用 `Math.round` 除
 *   7 天是为了抵消夏令时造成的 ±1 小时 —— 用 floor 会在换季那周少算一周。
 */
export function isoWeek(anchor) {
  const date = startOfDay(anchor instanceof Date ? anchor : new Date(ms(anchor)));
  if (!Number.isFinite(date.getTime())) return { year: 0, week: 0 };
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  thursday.setDate(thursday.getDate() - mondayIndex(date) + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - mondayIndex(firstThursday) + 3);
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));
  return { year: thursday.getFullYear(), week };
}

/** 周键：`2026-W47`。补零到两位，是为了让字符串排序等于时间排序（侧栏要用）。 */
export function weekKeyOf(anchor) {
  const { year, week } = isoWeek(anchor);
  if (year === 0) return '';
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** ISO 周 → 那一周的周一（本地零点）。非法键返回 `null`，让调用方自己决定怎么报错。 */
export function mondayOfWeekKey(key) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(key ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(year, 0, 4);
  const monday = new Date(year, 0, 4 - mondayIndex(jan4));
  monday.setDate(monday.getDate() + (week - 1) * 7);
  // 反解出来的周一必须真的落在这一年这一周里：`2026-W53` 这种越界键要拒掉，
  // 否则会静默返回「2027 年第 1 周」的周一，用户看到的是空周报而不是错误。
  const back = isoWeek(monday);
  if (back.year !== year || back.week !== week) return null;
  return monday;
}

/**
 * 一周的边界与展示用的标签。
 *
 * @param anchor - `Date` / 毫秒 / ISO 字符串 / 周键 `2026-W47` 都行。
 * @returns `{ key, from, to, fromKey, toKey, days, label, shortLabel }`
 *   - `from` / `to`：毫秒时间戳，直接和 `read{}` 的值比较；
 *   - `fromKey` / `toKey`：本地日期键，和日记的「一天一个文件」比较；
 *   - `days`：七天的日期键，周报里画「哪几天写过」用。
 */
export function weekRange(anchor = Date.now()) {
  let monday;
  if (typeof anchor === 'string' && /^\d{4}-W\d{2}$/.test(anchor.trim())) {
    monday = mondayOfWeekKey(anchor.trim());
    if (monday === null) return null;
  } else {
    /*
     * ★ 这里必须先过 `ms()` 再判 `> 0`，不能直接 `new Date(anchor)`：
     *   `new Date('2026-99-01')` 是 Invalid Date（能判），但 `new Date(ms(...))`
     *   里 `ms()` 返回 0 ⇒ 变成 **1970-01-01 那一周**，于是「非法输入」被静默
     *   渲染成一张 1969 年的周报 —— 用户只会觉得这功能坏了，日志里什么都没有。
     */
    const stamp = anchor instanceof Date ? anchor.getTime() : ms(anchor);
    if (!(stamp > 0)) return null;
    const date = new Date(stamp);
    if (!Number.isFinite(date.getTime())) return null;
    monday = startOfDay(date);
    monday.setDate(monday.getDate() - mondayIndex(date));
  }
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
    return dateKeyOf(day);
  });
  const from = startOfDay(monday).getTime();
  const to = endOfDay(sunday).getTime();
  return {
    key: weekKeyOf(monday),
    from,
    to,
    fromKey: days[0],
    toKey: days[6],
    days,
    label: `${monday.getMonth() + 1} 月 ${monday.getDate()} 日 – ${sunday.getMonth() + 1} 月 ${sunday.getDate()} 日`,
    /** 侧栏窄，只放「11/16 – 11/22」。 */
    shortLabel: `${monday.getMonth() + 1}/${monday.getDate()} – ${sunday.getMonth() + 1}/${sunday.getDate()}`,
  };
}

/** 时间戳是否落在区间内（含两端）。`0` 永远不算 —— 那是「没有时间」，不是 1970 年。 */
export function inRange(value, range) {
  const at = ms(value);
  return at > 0 && at >= range.from && at <= range.to;
}

/** 日期键是否落在区间内。日记按字符串比较，不绕时区。 */
export function dayInRange(dayKey, range) {
  return typeof dayKey === 'string' && dayKey >= range.fromKey && dayKey <= range.toKey;
}

/**
 * 计数并降序取前 N。
 *
 * `ties` 按名字排序而不是按插入顺序：同一批数据的两次渲染要给同一个结果，
 * 否则「常看的源」会在两次刷新之间换位，看起来像数据在变。
 */
export function topCounts(pairs, limit = WEEKLY_FEED_LIMIT) {
  const counts = new Map();
  for (const [name] of pairs) {
    if (typeof name !== 'string' || name === '') continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh'))
    .slice(0, limit);
}

/**
 * 连写天数：从 `endKey` 往回数，连续有日记的天数。
 *
 * ★ 今天没写不该把连击清零 —— 用户早上打开周报，看到「0 天」会以为自己的记录丢了。
 *   所以从「这一周的最后一天」往回数，而不是从今天。周报的语义本来就是「看这一周」。
 */
export function streakEndingAt(daysWithEntries, endKey) {
  const set = new Set(daysWithEntries);
  let cursor = endKey;
  let streak = 0;
  while (set.has(cursor) && streak < 400) {
    streak += 1;
    const date = new Date(`${cursor}T00:00:00`);
    if (!Number.isFinite(date.getTime())) break;
    date.setDate(date.getDate() - 1);
    cursor = dateKeyOf(date);
  }
  return streak;
}

/** 情绪分档的展示文案（周报里用文字，不用 emoji —— 同 `MOODS` 的理由）。 */
const MOOD_LABELS = { 1: '很低落', 2: '有点烦', 3: '一般', 4: '还不错', 5: '很好' };

export function moodLabel(score) {
  return MOOD_LABELS[score] ?? '';
}

/**
 * 把四路原始数据折成周报。
 *
 * 输入全部是**已经取出来的普通对象**，这个函数不读盘、不看 `Date.now()` ——
 * 所以它可以在测试里用一组固定数据跑，也可以在「回看第 12 周」时跑，
 * 不需要把时钟拨回去。
 *
 * @param {object} input
 * @param {object} input.range - `weekRange()` 的返回值。
 * @param {object} input.read - `store.data.read`（`{ [key]: 毫秒 }`）。
 * @param {object} input.favorites - `store.data.favorites`（`{ [key]: { savedAt } }`）。
 * @param {Map} input.entryIndex - key → `{ title, feed, feedId }`，用来把已读回填成标题。
 * @param {object} input.states - `store.data.library.states`（书 + 论文共用）。
 * @param {Array} input.bookTitles - `[{ id, title }]`，把 id 变成书名。
 * @param {Array} input.papers - `[{ id, title, addedAt }]`。
 * @param {Array} input.diaryDays - `[{ date, entries }]`，只含区间内的天。
 * @param {Array} input.annotations - `[{ bookId, createdAt }]`，只含区间内新划的。
 * @param {object} [input.scanned] - 各处实际扫了多少（报告用，缺了就不显示）。
 */
export function summarizeWeekly(input = {}) {
  const range = input.range ?? weekRange();
  if (!range) throw new TypeError('summarizeWeekly: 无效的周区间');
  const read = input.read ?? {};
  const favorites = input.favorites ?? {};
  const entryIndex = input.entryIndex instanceof Map ? input.entryIndex : new Map();
  const states = input.states ?? {};
  const titles = new Map((input.bookTitles ?? []).map((book) => [book.id, book.title]));
  const papers = input.papers ?? [];
  const diaryDays = input.diaryDays ?? [];
  const annotations = input.annotations ?? [];

  // ---- 读：RSS ---------------------------------------------------------
  const readRows = [];
  for (const [key, at] of Object.entries(read)) {
    if (!inRange(at, range)) continue;
    const meta = entryIndex.get(key) ?? {};
    readRows.push({
      key,
      at: ms(at),
      title: meta.title ?? '',
      feed: meta.feed ?? '',
      feedId: meta.feedId ?? '',
    });
  }
  readRows.sort((left, right) => right.at - left.at);

  const savedRows = [];
  for (const [key, value] of Object.entries(favorites)) {
    const at = ms(value?.savedAt);
    if (!inRange(at, range)) continue;
    const meta = entryIndex.get(key) ?? {};
    savedRows.push({ key, at, title: meta.title ?? '', feed: meta.feed ?? '' });
  }
  savedRows.sort((left, right) => right.at - left.at);

  // ---- 书 / 论文 -------------------------------------------------------
  const paperIds = new Set(papers.map((paper) => paper.id));
  const finished = [];
  const progressed = [];
  for (const [id, raw] of Object.entries(states)) {
    // `states` 里书和论文混着放（论文被当成书读，见 `paperAsBook`）。分开数，
    // 否则「本周读完 5 本」里掺着 4 篇论文，用户会以为书读得很快。
    if (paperIds.has(id)) continue;
    const state = raw ?? {};
    const title = titles.get(id) ?? id;
    if (inRange(state.finishedAt, range)) {
      finished.push({ id, title, at: ms(state.finishedAt) });
    } else if (inRange(state.at, range)) {
      progressed.push({
        id,
        title,
        at: ms(state.at),
        page: Number(state.page) || 0,
        pages: Number(state.pages) || 0,
      });
    }
  }
  finished.sort((left, right) => right.at - left.at);
  progressed.sort((left, right) => right.at - left.at);

  const papersAdded = papers.filter((paper) => inRange(paper.addedAt, range));
  const papersFinished = [];
  const papersRead = [];
  for (const paper of papers) {
    const state = states[paper.id] ?? {};
    if (inRange(state.finishedAt, range)) papersFinished.push({ id: paper.id, title: paper.title ?? '', at: ms(state.finishedAt) });
    else if (inRange(state.at, range)) papersRead.push({ id: paper.id, title: paper.title ?? '', at: ms(state.at) });
  }

  // ---- 写：日记 --------------------------------------------------------
  const byKind = {};
  const byMood = new Map();
  const writtenDays = [];
  const reflections = [];
  let entries = 0;
  let chars = 0;
  for (const day of diaryDays) {
    if (!day || !dayInRange(day.date, range)) continue;
    const rows = Array.isArray(day.entries) ? day.entries : [];
    if (rows.length === 0) continue;
    writtenDays.push(day.date);
    entries += rows.length;
    for (const entry of rows) {
      const kind = typeof entry.kind === 'string' && entry.kind !== '' ? entry.kind : '未分类';
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      const body = typeof entry.body === 'string' ? entry.body : '';
      chars += [...body].length;
      const score = Number(entry.mood?.score ?? entry.mood);
      if (Number.isFinite(score) && score >= 1 && score <= 5) {
        byMood.set(score, (byMood.get(score) ?? 0) + 1);
      }
      // 读后感单独列出来：周报里最有价值的一行不是「写了 14 条」，而是
      // 「你为这 3 本书写了读后感」—— 那是可回看的产出，不是计数。
      if (kind === '读后感' && entry.meta?.book) {
        reflections.push({
          bookId: entry.meta.book,
          title: titles.get(entry.meta.book) ?? '',
          date: day.date,
          preview: body.replace(/\s+/g, ' ').trim().slice(0, 80),
        });
      }
    }
  }
  writtenDays.sort();
  const moods = [...byMood.entries()]
    .map(([score, count]) => ({ score, count, label: moodLabel(score) }))
    .sort((left, right) => right.count - left.count || right.score - left.score);

  // ---- 划：这本书上划了多少 ------------------------------------------
  const highlightBooks = new Map();
  let highlights = 0;
  for (const item of annotations) {
    if (!inRange(item.createdAt, range)) continue;
    highlights += 1;
    if (typeof item.bookId === 'string' && item.bookId !== '') {
      highlightBooks.set(item.bookId, (highlightBooks.get(item.bookId) ?? 0) + 1);
    }
  }
  const highlightRows = [...highlightBooks.entries()]
    .map(([id, count]) => ({ id, title: titles.get(id) ?? '', count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));

  const articleCount = readRows.length;
  const isEmpty = articleCount === 0 && finished.length === 0 && progressed.length === 0
    && entries === 0 && highlights === 0 && papersAdded.length === 0 && papersFinished.length === 0;

  return {
    range: {
      key: range.key,
      fromKey: range.fromKey,
      toKey: range.toKey,
      days: range.days,
      label: range.label,
      shortLabel: range.shortLabel,
    },
    reading: {
      articles: articleCount,
      saved: savedRows.length,
      topFeeds: topCounts(readRows.map((row) => [row.feed]), WEEKLY_FEED_LIMIT),
      titles: readRows.slice(0, WEEKLY_TITLE_LIMIT),
      savedTitles: savedRows.slice(0, WEEKLY_TITLE_LIMIT),
    },
    books: {
      finished,
      progressed,
      highlightCount: highlights,
      highlights: highlightRows.slice(0, WEEKLY_TITLE_LIMIT),
    },
    papers: {
      added: papersAdded.slice(0, WEEKLY_TITLE_LIMIT),
      finished: papersFinished,
      read: papersRead.slice(0, WEEKLY_TITLE_LIMIT),
    },
    writing: {
      entries,
      chars,
      days: writtenDays.length,
      dayKeys: writtenDays,
      streak: streakEndingAt(writtenDays, range.toKey),
      byKind,
      moods,
      reflections,
    },
    empty: isEmpty,
    scanned: input.scanned ?? {},
  };
}

/**
 * 「一句话概览」。周报顶部那一行，也是侧栏每周一行的摘要。
 *
 * ★ 只报**非零**项，而且最多三项：一句里塞五个数字等于没重点。
 *   全零时给一句人话，不是「本周无数据」那种系统腔。
 */
export function weeklyHeadline(report) {
  const parts = [];
  const { reading, books, writing } = report ?? {};
  if (reading?.articles > 0) parts.push(`读了 ${reading.articles} 篇`);
  if (books?.finished?.length > 0) parts.push(`读完 ${books.finished.length} 本`);
  if (writing?.entries > 0) parts.push(`写了 ${writing.entries} 条`);
  if (parts.length === 0 && books?.progressed?.length > 0) parts.push(`翻了 ${books.progressed.length} 本书`);
  if (parts.length === 0 && books?.highlightCount > 0) parts.push(`划了 ${books.highlightCount} 处`);
  if (parts.length === 0) return '这一周没有记录';
  return parts.slice(0, 3).join(' · ');
}
