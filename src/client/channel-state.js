/**
 * 每个频道记住自己的浏览状态（0.44.9）。
 *
 * 之前只记住了 `npr.channel`（「上次看的是哪个源」）。切回来的时候：
 *   - 筛选被重置成「全部」⇒ 在「未读」里翻到一半、去别的源看一眼、回来又是全部；
 *   - 搜索框被清空、还自动收起 ⇒ 刚打的检索词没了；
 *   - 列表滚到顶上 ⇒ 刚才读到第 20 条，回来要重新往下找。
 *
 * 三件事都记，因为它们是**同一个动作**（「我正在这个源里找东西」）的三个部分，
 * 只记其中一个会让另外两个显得更像 bug。
 *
 * ★ 为什么按频道分而不是全局：一个源一个用法。订阅「Hacker News」时可能一直停在
 *   「未读」、订阅某个博客时一直停在「全部」。全局记一个筛选，切源就得手动改回来。
 * ★ 为什么搜索词也要记：不记的话「切走再回来」等于把用户刚输入的东西删了 ——
 *   这是最容易被当成「输入框有 bug」的一种。
 */

/** 认得的筛选项。写进去别的值一律回落成 `all`（见 `readChannelState`）。 */
const FILTERS = new Set(['all', 'unread', 'favorites', 'hidden']);

/** 最多记多少个频道。超了按最后使用时间淘汰。 */
export const CHANNEL_STATE_LIMIT = 60;

/** 搜索词的长度上限。正常检索词几十个字符，超长的多半是误粘贴。 */
const QUERY_LIMIT = 120;

const STORE_KEY = 'npr.channelState';

function readAll(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORE_KEY) ?? '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 读一个频道的状态。
 *
 * @param {string} channel
 * @param {{getItem: Function}} storage
 * @returns {{filter: string, query: string, scroll: number}}
 *
 * ★ 任何一项坏掉都只回落那一项，不整条丢弃：localStorage 里可能留着上一版写的形状
 *   （比如 `filter` 曾经是数字下标）。整条丢掉的话，用户「刚设好的筛选」会因为
 *   一个不相干的字段坏掉而一起没了。
 */
export function readChannelState(channel, storage) {
  if (!channel) return { filter: 'all', query: '', scroll: 0 };
  const raw = readAll(storage)[channel];
  if (raw === null || typeof raw !== 'object') return { filter: 'all', query: '', scroll: 0 };
  const filter = typeof raw.filter === 'string' && FILTERS.has(raw.filter) ? raw.filter : 'all';
  const query = typeof raw.query === 'string' ? raw.query.slice(0, QUERY_LIMIT) : '';
  const scroll = Number.isFinite(Number(raw.scroll)) && Number(raw.scroll) > 0 ? Number(raw.scroll) : 0;
  return { filter, query, scroll };
}

/**
 * 写一个频道的状态（合并，不是覆盖整条）。
 *
 * @param {string} channel
 * @param {{filter?: string, query?: string, scroll?: number}} patch
 * @param {{getItem: Function, setItem: Function}} storage
 *
 * ★ `scroll` 允许传 0（滚回顶是正常状态），所以不能用 `patch.scroll || 旧值` 那种写法
 *   —— 那会让「滚回顶部」永远存不进去，下次进来又跳回中间。
 */
export function saveChannelState(channel, patch, storage) {
  if (!channel) return;
  try {
    const all = readAll(storage);
    const previous = all[channel] !== null && typeof all[channel] === 'object' ? all[channel] : {};
    const next = {
      filter: typeof patch.filter === 'string' && FILTERS.has(patch.filter) ? patch.filter : (previous.filter ?? 'all'),
      query: typeof patch.query === 'string' ? patch.query.slice(0, QUERY_LIMIT) : (previous.query ?? ''),
      scroll: patch.scroll === undefined ? (previous.scroll ?? 0) : Math.max(0, Math.round(Number(patch.scroll) || 0)),
      at: Date.now(),
    };
    const merged = { ...all, [channel]: next };
    // 超上限时按最后使用时间淘汰：`at` 每次写都更新，所以「最近还在用的源」活得更久。
    const keys = Object.keys(merged);
    if (keys.length > CHANNEL_STATE_LIMIT) {
      keys.sort((a, b) => (merged[a]?.at ?? 0) - (merged[b]?.at ?? 0));
      for (const key of keys.slice(0, keys.length - CHANNEL_STATE_LIMIT)) delete merged[key];
    }
    storage?.setItem(STORE_KEY, JSON.stringify(merged));
  } catch {
    // 配额满 / 隐私模式：记住浏览状态是锦上添花，抛出去会让切频道直接失败
  }
}

/** 清掉一个频道的状态（「重来一遍」时用）。 */
export function clearChannelState(channel, storage) {
  if (!channel) return;
  try {
    const all = readAll(storage);
    delete all[channel];
    storage?.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // 同上
  }
}
