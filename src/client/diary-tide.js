/**
 * 「心绪潮汐」——把一个月的心情画成一条潮位线。
 *
 * ★ 为什么要有这个文件：`dashboard()` 给的是 `moods: [{score, count}]`，
 *   那是一句**没有时间**的统计。界面上只能画成两三个百分比，而百分比是这一块
 *   最弱的表达 —— 两条 50% 并排，等于什么都没说：看不出月中塌了一次、
 *   也看不出月末有没有回上来。加上 `moodSeries`（一天一个点）才会有形状。
 *
 * ★ 形状交给纯函数算，不在 JSX 里拼字符串：坐标算错的后果是「线画歪了」，
 *   而画歪的线看起来仍然像一条线 —— 它不会报错，只会安静地说谎。
 *   所以这里每一件事都必须能被 `test/diary-tide.test.mjs` 单独按住。
 */

/** 相邻两个点隔了几天以上就不连线。 */
const MAX_GAP = 2;

/** 一个月的天数。用 UTC 算，避免本地时区把 2 月算成 28/29 之外的数。 */
export function daysInMonth(monthKey) {
  const [year, month] = String(monthKey ?? '').split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return 0;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 「某月 1 号」是这一格的左边缘，「最后一天」是右边缘 —— 日历上也是这么排的。 */
export function dayX(day, monthKey, width = 100) {
  const total = daysInMonth(monthKey);
  if (total <= 1 || !Number.isFinite(day)) return 0;
  const clamped = Math.min(Math.max(day, 1), total);
  return ((clamped - 1) / (total - 1)) * width;
}

/** 情绪 1~5 档 → 纵坐标。5 在最上面，1 在最下面（留出 `pad` 的上下呼吸位）。 */
export function scoreY(score, { height = 100, pad = 12 } = {}) {
  const value = Number.isFinite(score) ? Math.min(Math.max(score, 1), 5) : 3;
  return pad + (1 - (value - 1) / 4) * (height - pad * 2);
}

/**
 * 把 `moodSeries` 折成可以直接喂给 `<svg>` 的坐标。
 *
 * ★ **缺口必须断开**：这个月 3 号记了心情、18 号才又记一次（中间没记），
 *   把两点连起来就是画了一条 15 天的假走势 —— 曲线看起来最像真的，所以它最危险。
 *   隔了超过 `MAX_GAP` 天就分成两段。
 *
 * @returns `{ points, segments }`，`segments` 是若干段连续的点（每段长度 ≥ 1）。
 */
export function tideGeometry(series, monthKey, { width = 100, height = 100, pad = 12 } = {}) {
  const total = daysInMonth(monthKey);
  const points = [];
  for (const cell of series ?? []) {
    const date = String(cell?.date ?? '');
    if (total === 0 || date.slice(0, 7) !== monthKey) continue;
    const day = Number(date.slice(8));
    const score = Number(cell?.score);
    if (!Number.isInteger(day) || day < 1 || day > total) continue;
    if (!Number.isFinite(score)) continue;
    points.push({ date, day, score, x: dayX(day, monthKey, width), y: scoreY(score, { height, pad }) });
  }
  points.sort((left, right) => left.day - right.day);

  const segments = [];
  let run = [];
  for (const point of points) {
    const prev = run[run.length - 1];
    if (prev !== undefined && point.day - prev.day > MAX_GAP) {
      segments.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) segments.push(run);
  return { points, segments };
}

/**
 * 一条情绪的主调读法。
 *
 * ★ 用「日子」当主语，不用「心情」：日记里的心情是**那一天的底色**，
 *   不是一场持续一个月的情绪状态。说法要是「亮的日子多些」，
 *   而不是「你很开朗」—— 后者是诊断，前者是观察。
 */
const LEAD = Object.freeze({
  5: '亮的日子多些',
  4: '多半还算舒展',
  3: '大多是平平的日子',
  2: '烦的时候不少',
  1: '沉的日子多些',
});

/**
 * 一句话把分布读出来。
 *
 * ★ `moods` 决定主调（和下面那三枚 chip 同一个来源，不能各说各的），
 *   `series` 决定走势（前半段和后半段的平均分之差）。
 * ★ 点太少就不谈走势：三四个点分两半，一半只有一个点，
 *   那一句话描述的是**那一天**，不是「最近」。宁可不说。
 */
export function tideReading({ moods = [], series = [] } = {}) {
  const top = moods[0];
  if (top === undefined || !(top.count > 0)) return '';
  const lead = LEAD[top.score] ?? '';
  if (lead === '') return '';
  const rows = (series ?? []).filter((cell) => Number.isFinite(Number(cell?.score)));
  /*
   * ★ 一两天就**不谈分布**。
   *   「烦的时候不少」这句话，只有一条数据也能算出来（那条正好是 2 分），
   *   而它听起来像是在描述一个月 —— 用户刚开张两天，看到这句只会觉得被诬告。
   *   这一条和第二块「那年今日第一年怎么办」是同一个道理：数据不够时要说
   *   「还看不出来」，不要说一个凑出来的结论。
   */
  if (rows.length === 0) return '';
  if (rows.length < 3) return `这个月只有 ${rows.length} 天记了心情，还看不出走势。`;
  if (rows.length < 4) return `${lead}。`;
  const half = Math.floor(rows.length / 2);
  const mean = (list) => list.reduce((sum, cell) => sum + Number(cell.score), 0) / list.length;
  const delta = mean(rows.slice(half)) - mean(rows.slice(0, half));
  /*
   * ★ 门槛 0.75 档，不是 0.1：四五个点时，前后半段各两三个，
   *   `0.5` 的差往往只是**某一天**的心情低了一档（[3,3,3,4] 就会算出 0.5）。
   *   把那种抖动说成「最近在往上走」，等于每天换一句判词 —— 而它并不是趋势。
   */
  const drift = delta >= 0.75 ? '最近在往上走' : delta <= -0.75 ? '最近沉了一些' : '一个月里起落不大';
  return `${lead}，${drift}。`;
}
