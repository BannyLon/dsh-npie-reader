/**
 * 「把选中的那段摘进灵感速记」的载荷构造（0.44.9，命名 0.45.0 更正）。
 *
 * 抽成纯函数而不是写在组件里，是为了能**真跑**它、并把结果喂给宿主的
 * `normalizeMeta` —— 白名单会把不认的字段**静默丢掉**，只做源码级断言的话
 * 「摘录写进去了，但反查不到是哪篇文章」这种错法永远抓不到。
 */

/**
 * 日记条目的 kind。
 *
 * ★ **必须是 `'灵感'`**，不能自造 `'摘录'`：宿主的 `assertEntryInput` 拿
 *   `ENTRY_KINDS`（`灵感 / 日记 / 读后感`）做白名单，认不出的值会**静默**兜成
 *   「灵感」—— 也就是说自造一个类型不会报错，只会让你以为生效了。
 *   （0.44.9 第一版就是 `kind: '摘录'`，用户看到的日记里没有「摘录」两个字。）
 * ★ 为什么不把 `'摘录'` 加进 `ENTRY_KINDS`：`src/diary-format.js` 里写着设计决定 ——
 *   「金句摘录属于读后感模板的一部分，不是一种条目类型」。摘录一条 RSS 里的话，
 *   归属就是**灵感速记**（读到什么就记一句），不是一个新模块。
 * ★ 那怎么和「自己写的灵感」分开：靠 `source` 的第一段是「摘录」，标题行会显示成
 *   `## 21:04 灵感 · 摘录 · 某篇文章 · 某 Newsletter`。
 */
export const EXCERPT_KIND = '灵感';

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
  // ★ `source` 会进**日记文件的那一行标题**（`## HH:MM 灵感 · 来源`），所以必须折叠成
  //   单行：标题里带一个换行，那一行就断成两行，后半截变成正文。宿主的
  //   `assertEntryInput` 只做 `trim().slice(0,300)`，**不挡换行**。
  // 第一段固定是「摘录」：它是唯一能在标题行上把「引来的」和「自己写的」分开的标记。
  const source = ['摘录', title, channelName]
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .join(' · ');
  const meta = {};
  // 超长的 key 不写：白名单会丢掉它，而丢掉之后「有出处」和「没出处」看起来一模一样
  // —— 不如一开始就不写，界面上那句提示也就不会骗人。
  if (typeof articleKey === 'string' && articleKey !== '' && articleKey.length <= ARTICLE_KEY_LIMIT) {
    meta.article = articleKey;
  }
  return { date, kind: EXCERPT_KIND, body, source, meta };
}
