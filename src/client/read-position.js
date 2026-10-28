/**
 * 文章阅读位置（0.44.9）。
 *
 * 之前的行为：`openArticle` 里写死 `scrollTo({ top: 0 })` —— 长文读一半被叫走，
 * 回来从头开始。`read: true/false` 只回答「读没读过」，回答不了「读到哪」。
 *
 * ★ 为什么存 `scrollTop` 的**像素值**而不是「读到第几节」：像素是唯一不需要解释的
 *   单位。存「第 3 节」的话，改字号 / 改版心宽度 / 换译文之后那个锚点会漂，
 *   而用户的心智是「我刚才读到这一段」，段落位置对应的是像素。代价是**换字号后
 *   位置会偏** —— 所以这里存的是「比例」而不是绝对值。
 *
 * ★ 为什么是比例（`top / scrollHeight`）而不是纯像素：同一篇文章在 1182px 宽的窗口
 *   和 800px 宽的窗口里，同样的段落落在完全不同的 `scrollTop` 上。存比例，换窗口
 *   尺寸后还能回到**同一段**；存像素就只能回到「差不多的位置」。
 */

/** 最多记多少篇的位置。超了按最近使用淘汰 —— 不设上限会无限撑大 localStorage。 */
export const POSITION_LIMIT = 200;

const INDEX_KEY = 'npr.posIndex';

export const positionKey = (articleKey) => `npr.pos.${articleKey}`;

/**
 * 把一次滚动换算成 0–1 的比例。
 *
 * @param {number} scrollTop
 * @param {number} scrollHeight 整个内容高度
 * @param {number} clientHeight 可视高度
 * @returns {number} 0–1；算不出来时给 0
 *
 * ★ 分母用 `scrollHeight - clientHeight`（可滚动的总距离），不是 `scrollHeight`：
 *   用后者的话「滚到底」永远到不了 1（因为最后还有一屏可见高度），恢复时总会差一截。
 */
export function scrollRatio(scrollTop, scrollHeight, clientHeight) {
  const span = Number(scrollHeight) - Number(clientHeight);
  if (!Number.isFinite(span) || span <= 0) return 0;
  const ratio = Number(scrollTop) / span;
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * 比例换回 `scrollTop`。
 *
 * @param {number} ratio 0–1
 * @param {number} scrollHeight
 * @param {number} clientHeight
 * @returns {number} 整数像素
 */
export function scrollFromRatio(ratio, scrollHeight, clientHeight) {
  const span = Number(scrollHeight) - Number(clientHeight);
  if (!Number.isFinite(span) || span <= 0) return 0;
  const value = Number(ratio);
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * span);
}

/**
 * 读一篇的比例。
 *
 * @param {string} articleKey
 * @param {{getItem: (key: string) => string | null}} storage
 * @returns {number} 0–1；没记过或记坏了都给 0
 *
 * ★ 读坏了给 0 而不是抛：localStorage 里可能留着上一版写进去的别的形状
 *   （比如早期存的是像素字符串）。给 0 的效果是「从头开始」，而抛会让整篇文章打不开。
 */
export function readPosition(articleKey, storage) {
  if (!articleKey) return 0;
  try {
    const raw = storage?.getItem(positionKey(articleKey));
    if (raw === null || raw === undefined) return 0;
    const value = Number(raw);
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  } catch {
    return 0;
  }
}

/**
 * 存一篇的比例，并把索引裁到 {@link POSITION_LIMIT}。
 *
 * @param {string} articleKey
 * @param {number} ratio
 * @param {{getItem: Function, setItem: Function, removeItem: Function}} storage
 *
 * ★ 必须**同时维护索引并裁掉旧的**：只写不删的话，每天读 20 篇、一年就是 7000 个键，
 *   localStorage 有 5 MB 硬上限 —— 撑爆之后 `setItem` 会抛，而它是在滚动事件里调的，
 *   抛出去就是「滚一下就报一次错」。
 * ★ 裁剪时按**最近使用**而不是写入顺序：`npr.posIndex` 每次把刚读的提到最前，
 *   于是「上周读过的」比「三个月前读过一次的」活得更久。
 */
export function savePosition(articleKey, ratio, storage) {
  if (!articleKey) return;
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) return;
  try {
    storage?.setItem(positionKey(articleKey), String(Math.round(value * 1000) / 1000));
    const index = readIndex(storage);
    const next = [articleKey, ...index.filter((key) => key !== articleKey)];
    for (const dropped of next.slice(POSITION_LIMIT)) storage.removeItem(positionKey(dropped));
    storage?.setItem(INDEX_KEY, JSON.stringify(next.slice(0, POSITION_LIMIT)));
  } catch {
    // 配额满了就算了：阅读位置丢一次不影响读文章，而抛出去会让滚动卡住
  }
}

/** 清掉一篇的位置（用户主动「从头开始读」时用）。 */
export function clearPosition(articleKey, storage) {
  if (!articleKey) return;
  try {
    storage?.removeItem(positionKey(articleKey));
    const index = readIndex(storage).filter((key) => key !== articleKey);
    storage?.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // 同上
  }
}

function readIndex(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(INDEX_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}
