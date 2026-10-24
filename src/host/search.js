/**
 * 全文检索的匹配与摘录。纯函数，不碰 store —— 便于用反向对照组把行为钉住。
 *
 * 为什么要有预算常量：`rss_search_articles` 的语义是「在**正文**里找」，
 * 而正文散在 `subscriptions[].entries[].html` 与 `articles{}` 两处，单条平均 6 KB 量级。
 * 100 个源 × 200 条的极端情况下，不设上限就是一次调用把整份 `data.json`
 * （最坏上百 MB）逐条转纯文本。所以：条目扫描数、正文条数、单条字符数、
 * 总字符数四个闸门都必须显式写出来，并在工具输出里如实报告扫了多少。
 */

export const SEARCH_LIMITS = {
  /** 一次调用最多「看过」多少条目（标题/摘要检查很便宜，所以这个数可以大）。 */
  maxEntriesScanned: 5_000,
  /** 一次调用最多把多少条**正文**转纯文本（这一步贵）。 */
  maxBodiesPerCall: 800,
  /** 单条正文最多取前多少字符参与匹配。 */
  maxBodyCharsPerEntry: 20_000,
  /** 一次调用处理的正文总字符数上限。 */
  maxBodyCharsTotal: 8_000_000,
};

/** 检索词归一：小写 + 去首尾空白。空串由调用方当「不检索」处理。 */
export function normalizeNeedle(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

/**
 * 截出命中位置前后的一段，供模型判断相关性。
 * 命中在开头/结尾时不加省略号，免得每条都顶着 `…`。
 */
export function snippetAround(text, needle, radius = 70) {
  const haystack = String(text ?? '');
  if (needle === '') return '';
  const at = haystack.toLowerCase().indexOf(needle);
  if (at === -1) return '';
  const start = Math.max(0, at - radius);
  const end = Math.min(haystack.length, at + needle.length + radius);
  const core = haystack.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${core}${end < haystack.length ? '…' : ''}`;
}

/**
 * 在一条目的各个字段里找检索词，返回第一个命中的字段。
 *
 * 顺序是有意的：标题 > 中文标题 > 摘要 > 正文。同一条目同时在标题和正文里命中时，
 * 报「标题」更贴近用户直觉，也省掉一次正文摘录。
 * 标题命中不回摘录 —— 标题本来就会单独打印，再贴一遍是噪音。
 */
export function matchEntry(fields, needle) {
  if (needle === '') return null;
  for (const [field, value] of [['title', fields?.title], ['titleZh', fields?.titleZh]]) {
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) {
      return { matchedIn: field, snippet: '' };
    }
  }
  for (const field of ['summary', 'body']) {
    const value = fields?.[field];
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) {
      return { matchedIn: field, snippet: snippetAround(value, needle) };
    }
  }
  return null;
}
