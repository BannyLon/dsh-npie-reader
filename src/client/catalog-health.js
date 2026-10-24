/**
 * 内置目录的**体检快照**读法。
 *
 * 目录（`src/data/independent-blogs.json` 等）只有 `id/name/url/site/tags`，
 * **没有任何新鲜度信息**，所以订阅前无法预警。实测用户的第二个订阅「透明创业实验」
 * 正是目录的 `items[0]`，最新一篇在 320 天前。
 *
 * `src/data/catalog-health.json` 由 `scripts/catalog-health.mjs` 抓出来。2026-10-08 的账：
 *   - 首轮全量体检 1415 个源（并发 10 一把抓）：抓得到 858、90 天以上没更新 452、探不通 557。
 *   - 557 条「探不通」**降并发复检**（并发 5 / 超时 15s / 重试 2 次）⇒ 救回 16 条假阴性，
 *     仍不通 541 条。
 *   - 于是删掉 541 + 459 = **1000 条**（`scripts/prune-catalog.mjs --apply`），
 *     目录 1415 → **415**；其中 30 天内有更新的从 266 升到 **278**（占比 19% → 67%）。
 *   - 抓得到但读不出日期 10 条**保留**：测不出来就不该判死。
 *
 * ★ 这是**快照**，不是事实。所以这里的每条结论都必须能带上日期，
 *   `healthNotice` 负责把 `generatedAt` 摆到界面上。**不标日期的测量结果会变成假话。**
 * ★ 快照是**裁剪之后**重算过计数的（`pruned` 字段记了删了什么），所以它和目录始终同口径；
 *   想回看裁剪前的全量，去 `/tmp/npr-before-prune-*.json` 或该目录的 revision。
 */
import { daysSince } from './source-health.js';

/** 快照超过这个天数就不再逐行断言（界面上要说明「已过期」）。 */
export const HEALTH_EXPIRY_DAYS = 30;
/** 目录里超过这个天数没更新，就标成「已停更」。比订阅后的 14 天宽松 —— 目录只是线索。 */
export const STALE_CATALOG_DAYS = 90;
/**
 * 「**直接从目录里删掉**」的线 —— 不是像 90 天那样只在界面上标一句。
 *
 * ★ 两条线管的是两件事，别混：
 *   - 90 天只是标签：目录是线索不是精选，停更三个月不等于没价值，用户看到标签自己决定；
 *   - 365 天是删除：**一整年没更新**的源留着只会让目录从「精选」退化成「清单」。
 *   Newsletter 这一类用删除线（`scripts/prune-catalog.mjs` 的 `staleDays`）；
 *   独立博客那条线更严（`--stale-days`，默认 90），因为它的条目是自动同步来的、单价低。
 */
export const PRUNE_CATALOG_DAYS = 365;

/** url → 体检条目。目录与快照都按 url 对齐（没有 id 可用）。 */
export function healthIndex(snapshot) {
  const index = new Map();
  for (const item of snapshot?.items ?? []) {
    if (item && typeof item.url === 'string' && item.url !== '') index.set(item.url, item);
  }
  return index;
}

/**
 * 快照里**最旧**的那次测量时间。
 *
 * ★ 体检现在是分类别跑的（`--only Newsletter` 只重测这一类），所以 `generatedAt`
 *   只代表「最近一次动过」。把它当成整份快照的年龄就是**往新里算**：
 *   一类 3 天前测、另一类 40 天前测，却报「体检于 3 天前、没过期」，
 *   那 40 天那一半就是拿过期数据在冒充现状 —— 而这份快照存在的意义就是不许这么干。
 *   没有 `checkedAt` 的老快照退回 `generatedAt`（老文件不该因为缺字段就变成永久过期）。
 */
export function oldestCheckedAt(snapshot) {
  const stamps = Object.values(snapshot?.checkedAt ?? {})
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (stamps.length === 0) return snapshot?.generatedAt;
  return stamps.reduce((oldest, stamp) => (Date.parse(stamp) < Date.parse(oldest) ? stamp : oldest));
}

/** 快照是多久以前生成的。缺失/非法返回 `undefined`，**不是 0**（0 会被读成「刚测的」）。 */
export function snapshotAgeDays(snapshot, now = Date.now()) {
  return daysSince(oldestCheckedAt(snapshot), now);
}

export function isSnapshotExpired(snapshot, now = Date.now()) {
  const age = snapshotAgeDays(snapshot, now);
  return age === undefined || age > HEALTH_EXPIRY_DAYS;
}

/**
 * 目录里某一条的体检结论。
 * 没被体检过 ⇒ `unknown`（**不许**当成「健康」）。
 */
export function catalogHealthOf(url, index, now = Date.now()) {
  const item = index?.get?.(url);
  if (!item) return { level: 'unknown', days: undefined, label: '' };
  if (!item.ok) return { level: 'unreachable', days: undefined, label: '上次体检没抓到' };
  const days = daysSince(item.newestAt, now);
  // 抓到了但读不出日期：**不等于**「没更新」，也不等于「健康」。
  if (days === undefined) return { level: 'unknown', days: undefined, label: '' };
  if (days >= STALE_CATALOG_DAYS) return { level: 'stale', days, label: `已 ${days} 天未更新` };
  if (days === 0) return { level: 'fresh', days, label: '今天有更新' };
  return { level: 'fresh', days, label: `最新一篇 ${days} 天前` };
}

/** 页脚那条说明。返回 `null` 表示没有快照可用（那就一个字都别说）。 */
export function healthNotice(snapshot, now = Date.now()) {
  const items = snapshot?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const age = snapshotAgeDays(snapshot, now);
  const expired = age === undefined || age > HEALTH_EXPIRY_DAYS;
  // 复用 catalogHealthOf，而不是在这里把分级逻辑再抄一遍 ——
  // 抄一份就会出现「界面标了陈旧、页脚统计说不陈旧」这种自相矛盾。
  const index = healthIndex(snapshot);
  let usable = 0;
  let stale = 0;
  let unreachable = 0;
  for (const item of items) {
    const state = catalogHealthOf(item?.url, index, now);
    if (state.level === 'unreachable') unreachable++;
    else if (state.level === 'stale') stale++;
    else if (state.level === 'fresh' && state.days <= 30) usable++;
  }
  const date = typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt.slice(0, 10) : '未知日期';
  return {
    generatedAt: snapshot.generatedAt,
    ageDays: age,
    expired,
    checked: items.length,
    usable,
    stale,
    unreachable,
    text: `目录体检于 ${date}：${items.length} 个源里 ${usable} 个 30 天内有更新，`
      + `${stale} 个已 ${STALE_CATALOG_DAYS} 天以上未更新，${unreachable} 个探不通。`
      + (expired ? `⚠ 这份结果已过期${age === undefined ? '' : `（${age} 天前）`}，仅供参考。` : ''),
  };
}
