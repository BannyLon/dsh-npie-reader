/**
 * 频道路由的纯决策。三件事：
 *   1. 新增订阅之后该落到哪个频道；
 *   2. 宿主返回的频道清单变了之后，当前频道还成不成立；
 *   3. 列表为空时该说哪句话。
 *
 * 为什么单独抽出来：这三条都是状态机决策，原先散在 `ReaderPage` 的 JSX 里，
 * 只有真开界面才能验证。而它们的失效形态恰好就是用户报上来的两个 bug ——
 * 停在「某个只抓到 0 篇的订阅源」上，界面只说「这个频道暂无文章」，
 * 既不说原因（源获取失败）也不给出口，看起来就是「一篇文章都不显示」。
 */

/** 「聚合」频道：内容来自全部订阅源，不是某一个源。 */
const AGGREGATE_CHANNELS = ['all', 'feeds:all'];

/** 当前频道是不是聚合频道。 */
export function isAggregateChannel(key) {
  return AGGREGATE_CHANNELS.includes(key);
}

/** 频道清单里真实订阅源的数量（`kind === 'feed'`）。 */
export function countFeeds(channels) {
  return (channels ?? []).filter((channel) => channel?.kind === 'feed').length;
}

/**
 * 新增订阅之后该落到哪个频道。
 * @returns {string|undefined} `undefined` = 保持当前视图不动。
 */
export function channelAfterAdd(current) {
  // 已经在聚合频道上：新源的文章本来就会出现在列表里，不要动视图。
  if (isAggregateChannel(current)) return undefined;
  // 停在某个具体源（或某个分组）上：切回「我的订阅」，让新旧订阅的内容同时可见。
  return 'feeds:all';
}

/**
 * 当前频道在宿主返回的清单里还成不成立。
 * @returns {string|undefined} `undefined` = 成立，或清单还没到（别乱动）。
 */
export function resolveChannel(current, channels) {
  // 清单为空说明还没读到，此时回落会把用户存的频道白扔掉。
  if (!Array.isArray(channels) || channels.length === 0) return undefined;
  if (channels.some((channel) => channel?.key === current)) return undefined;
  return 'feeds:all';
}

/**
 * 当前频道取不到文章时，宿主给出的失败原因；没有就返回 `null`。
 * 只看带 `lastError` 的频道 —— 分组与聚合频道的失败要归到具体源上才说得清。
 */
export function channelFailure(current, channels) {
  const channel = (channels ?? []).find((item) => item?.key === current);
  if (!channel || !channel.lastError) return null;
  return { name: channel.name, error: String(channel.lastError) };
}

/** 空列表该说哪句话。 */
export function emptyListMessage({ filter, refreshing, channel, channels }) {
  if (filter === 'favorites') return '还没有收藏的文章';
  if (filter === 'unread') return '没有未读文章';
  // 这一档空了 = 全部恢复过了。要说清「你可以走了」，而不是让用户在这一页等着
  // 一篇文章自己冒出来（别的档的空态文案都在讲「这里为什么没东西」）。
  if (filter === 'hidden') return '没有隐藏的文章，都恢复过了';
  if (refreshing) return '正在获取这个频道的文章…';
  if (countFeeds(channels) === 0) return '还没有订阅。点上方 + 探索订阅源。';
  const failure = channelFailure(channel, channels);
  if (failure) return `「${failure.name}」获取失败：${failure.error}`;
  return '这个频道暂无文章，稍后会自动尝试更新。';
}
