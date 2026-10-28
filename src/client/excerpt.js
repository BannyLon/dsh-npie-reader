/**
 * 「把选中的那段摘进日记」的载荷构造（0.44.9）。
 *
 * 抽成纯函数而不是写在组件里，是为了能**真跑**它、并把结果喂给宿主的
 * `normalizeMeta` —— 白名单会把不认的字段**静默丢掉**，只做源码级断言的话
 * 「摘录写进去了，但反查不到是哪篇文章」这种错法永远抓不到。
 */

/** 日记条目的 kind 标签。`kind` 是自由字符串，宿主要拿它当小标题显示。 */
export const EXCERPT_KIND = '摘录';

/** `meta.article` 的长度上限，与 `src/diary-format.js` 的 `normalizeMeta` 一致。 */
const ARTICLE_KEY_LIMIT = 200;

/**
 * @param {{quote?: string, title?: string, channelName?: string, articleKey?: string, date?: string}} input
 * @returns {{date: string, kind: string, body: string, source: string, meta: object} | null}
 *   没有可摘的正文时返回 `null`（调用方据此提示用户先选中一段）。
 *
 * ★ `source` 与 `meta` 是**两件事**，都要写：
 *   - `source` 是给人看的那一行（「文章标题 · 频道名」），进日记文件时原样显示；
 *   - `meta.article` 是给程序反查用的 key，`normalizeMeta` 的白名单认得它。
 *   只写 `source` ⇒ 日记里回不到那篇文章；只写 `meta` ⇒ 日记里那一行看不出出处。
 */
export function excerptEntry({ quote, title, channelName, articleKey, date } = {}) {
  const body = String(quote ?? '').trim();
  if (body === '') return null;
  const source = [title, channelName].filter((item) => typeof item === 'string' && item.trim() !== '').join(' · ');
  const meta = {};
  // 超长的 key 不写：白名单会丢掉它，而丢掉之后「有出处」和「没出处」看起来一模一样
  // —— 不如一开始就不写，界面上那句提示也就不会骗人。
  if (typeof articleKey === 'string' && articleKey !== '' && articleKey.length <= ARTICLE_KEY_LIMIT) {
    meta.article = articleKey;
  }
  return { date, kind: EXCERPT_KIND, body, source, meta };
}
