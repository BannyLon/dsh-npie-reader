/**
 * 订阅源的「新鲜度」。
 *
 * 为什么需要它：第三方 RSS 代理会**悄悄停止更新**，而界面以前只显示文章自己的日期。
 * 用户看到列表顶上写着 9/18、今天是 10/8，无法区分下面三件事：
 *   ① 源已经死了；② 插件没有去抓；③ 这个源本来就一周一更。
 * 实测证据（这正是那些源后来被整类撤掉的原因）：内置的 8 个微信公众号源全部经
 * `rss.t5t6.com` 这个第三方代理，该代理的 `lastBuildDate` 停在 2026-09-21，
 * 之后一条都没再产出 —— 而界面一个字都没说。2026-10-08 那批源连同「微信公众号」
 * 分类一起撤了（见仓库根的 `retired/README.md`）；这段判据留着，因为**任何**经第三方
 * 代理的源都会以同样的方式悄悄死掉，而用户自己订阅的源里就有这种。
 *
 * 所以这里把时间差翻成一句人话，并明确区分「抓到了但源没新内容」与「压根没抓到」。
 */

/** 超过这个天数算「已经很久没更新」，界面上要明确提示。 */
export const STALE_DAYS = 14;
/** 超过这个天数算「有点旧」，界面上淡化处理。 */
export const AGING_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * 从时间戳算天数差；缺失或非法返回 `undefined`（**不是 0**，0 会被读成「今天刚更新」）。
 *
 * 同时接受 ISO 字符串：宿主那边 `publishedAt` 存的就是 ISO 字符串，`lastFetchedAt` 才是毫秒数。
 * 只认 number 会让字符串静默落进「未知」分支 —— 实测宿主曾把 ISO 字符串当时间戳传下来，
 * 结果每一个源都显示「还没抓到过内容」，而这个功能存在的意义恰恰是防这种事。
 */
export function daysSince(timestamp, now = Date.now()) {
  const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

/**
 * 一个频道的新鲜度。
 *
 * 判据优先看**最新一篇文章有多老**，而不是「上次抓取时间」：
 * 抓取成功但源不再产出新内容，才是用户真正感知到的「滞后一个月」。
 * 只有一条内容都没有时才退回看抓取时间。
 *
 * @returns {{level: 'unknown'|'fresh'|'aging'|'stale', days: number|undefined, label: string}}
 */
export function freshness(channel, now = Date.now()) {
  const fromEntry = daysSince(channel?.newestEntryAt, now);
  const days = fromEntry ?? daysSince(channel?.lastFetchedAt, now);
  if (days === undefined) {
    return {
      level: 'unknown',
      days: undefined,
      label: channel?.lastError ? `获取失败：${channel.lastError}` : '还没抓到过内容',
    };
  }
  if (days >= STALE_DAYS) return { level: 'stale', days, label: `已 ${days} 天未更新` };
  if (days === 0) return { level: 'fresh', days, label: '今天有更新' };
  return { level: days >= AGING_DAYS ? 'aging' : 'fresh', days, label: `最新一篇 ${days} 天前` };
}

/** 清单里已经陈旧的订阅源（只看 `feed` 频道，分组与聚合由成员代表）。 */
export function staleFeeds(channels, now = Date.now()) {
  return (channels ?? []).filter((channel) => channel?.kind === 'feed' && freshness(channel, now).level === 'stale');
}

/**
 * 当前频道要不要给一条「源已陈旧」的提示。
 *
 * ★ 除了给用户看的 `title` / `detail`，还返回一个**稳定的 `key`**：界面用它记
 *   「这条提示被用户点掉过」。不能用 `title` 当标识 —— 它里面带天数
 *   （「已 15 天未更新」），用户今天点掉、明天又会冒出来一条「已 16 天未更新」。
 *   `key` 只由**源的身份集合**决定：源没变，就是同一条提示。
 *
 * @returns {{level: string, key: string, title: string, detail: string}|null}
 */
export function staleNotice(channelKey, channels, now = Date.now()) {
  const list = channels ?? [];
  const current = list.find((channel) => channel?.key === channelKey);
  if (!current) return null;
  if (current.kind === 'feed') {
    const state = freshness(current, now);
    if (state.level !== 'stale') return null;
    return {
      level: state.level,
      key: `feed:${current.key}`,
      title: `「${current.name}」${state.label}`,
      detail: `这个源可能已经停止更新。可以点右上角 + 换一个地址，或看看其他源。`,
    };
  }
  const stale = staleFeeds(list, now);
  if (stale.length === 0) return null;
  return {
    level: 'stale',
    key: `group:${stale.map((channel) => channel.key).sort().join(',')}`,
    title: `${stale.length} 个订阅源超过 ${STALE_DAYS} 天没有更新`,
    detail: stale.map((channel) => channel.name).join('、'),
  };
}
