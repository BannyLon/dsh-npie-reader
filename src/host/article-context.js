import { decodeHtmlEntities, htmlToText } from './sanitize.js';

/**
 * 喂给模型的正文上限（字符）。
 *
 * ★ 2026-10-12 从 12000 提到 32000。12000 是按「够翻译就行」拍的，但它把长文的
 *   **后半段整段挡在模型外面** —— 用户那篇 SageMaker 文章正文 30605 字符，
 *   12000 只覆盖到第 11 张图（全文 22 张），后 11 张模型压根没见过，
 *   兜底只能把它们追加到文末。于是「图片全堆在尾部」这个现象，
 *   一半是模型丢图、一半是这个上限造成的。
 *
 *   取值依据（真机全库 71 篇 `articleContext` 的长度分布）：
 *   中位数 2062 / 75% 8315 / 90% 13494 / 95% 27307 / 最大 31624。
 *   12000 完整覆盖 90%，32000 覆盖 100%（超过 32000 的：0 篇）。
 *   ★ 2026-10-13 起正文里还带 Markdown 行内标记与链接占位符（`**`、`[文字]({{L3}})`），
 *     实测对长文的增量只有 9~304 字符 —— 不影响这个上限的结论。
 *   成本：英文 32000 字符 ≈ 8000 input token，中文译文约 12000 output token。
 *
 * ★ 这**不是**可以随手继续抬的数：翻译是长输出任务，一次吐两万字中文质量会掉，
 *   而且 `GENERATION_TIMEOUT_MS` 只有 10 分钟。再长的文章应当走「分段翻译」，
 *   而不是继续放大这个上限。
 */
export const ARTICLE_CONTEXT_LIMIT = 32000;

/**
 * 喂给模型的正文形态。
 *
 * ★ HTML 优先于 `text`：`html` 里带插图，`text` 没有。翻译 / 改写必须知道
 *   「哪里有一张图」，否则模型只会照着纯文本译——译文里图片就没了
 *   （2026-10-09 用户报的 bug：原文图文并茂，译文只剩文字）。
 *   以前 text 优先是「已选版本的正文别被原文 HTML 盖掉」的意思，但这个函数
 *   的唯一调用方是 AI 伴读（`ai.js` 的 `articleInput`），传进来的文章只有
 *   `html`、没有 `text` —— text 优先等于一条永远走不到的分支，还顺带把
 *   图片挡在了模型外面。
 */
/**
 * @param {object} article
 * @param {number} [limit]
 * @param {{links?: string[]}} [options]
 *   `options.links` **传数组即启用链接占位符**（见 `htmlToText`）：正文里的
 *   `<a href>` 会变成 `[文字]({{L3}})`，真 URL 落在这个数组里。
 *   翻译 / 改写必须带它 —— 否则译文里所有链接都会退化成纯文本。
 *   伴读问答不带（那边没有还原步骤，占位符会原样露给模型）。
 */
export function articleContext(article, limit = ARTICLE_CONTEXT_LIMIT, options = {}) {
  const heading = article.title ? `标题: ${String(article.title).slice(0,500)}\n\n` : '';
  const html = typeof article.html === 'string' ? article.html.trim() : '';
  const plain = html !== ''
    ? htmlToText(html, limit + 1, { keepImages: true, links: options.links })
    : (typeof article.text === 'string' ? article.text : '');
  const available = Math.max(0,limit - heading.length);
  const truncated = plain.length > available;
  const suffix = truncated ? '\n（上下文已截断）' : '';
  let body = plain.slice(0,Math.max(0,available - suffix.length));
  // ★ 截断可能把一个 `{{L3}}` 切成两半，留下 `{{L` / `{{L0}` 这种垃圾 ——
  //   模型会照抄它，而 `restoreLinks` 认不出来。截断时把尾部这一段整个切掉。
  //
  //   ★ 字符集必须写全 `[Ll\s\d}｝]`：第一版只写到数字（`[Ll]?\s*\d{0,4}`），
  //     切片落在 `{{L0}` 时（少了一个右括号）**清不掉** —— 而那正是最常见的切法之一。
  //     末尾就算本来是完整占位符也一并切掉：正文都截断了，末尾那个链接留不住。
  if (truncated) body = body.replace(/[{｛]{2}[Ll\s\d}｝]*$/, '');
  return heading + body + suffix;
}

/**
 * 正文里的插图清单（按出现顺序去重）。`html` 必须是**已清洗**的
 * （`sanitizeHtml` 产物）：src 是安全 URL，属性值里的实体在这里解码 ——
 * **必须与 `htmlToText({ keepImages: true })` 产出的标记同口径**：
 * 那边解了码、这边不解，「兜底比对缺了哪些图」就会全部误判成缺失，
 * 给译文追加重一份已有的图。
 *
 * 生成译文 / 改写后拿它做**确定性兜底**：提示词管不住模型时，
 * 少一张就补一张 —— 图片可以不翻译，但不能丢。
 */
export function articleImages(article) {
  const html = typeof article?.html === 'string' ? article.html : '';
  const urls = [];
  const seen = new Set();
  for (const match of html.matchAll(/<img\s[^>]*>/gi)) {
    const src = decodeHtmlEntities(/src\s*=\s*"([^"]*)"/i.exec(match[0])?.[1] ?? '').trim()
      .replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    if (src === '' || seen.has(src)) continue;
    seen.add(src);
    urls.push(src);
  }
  return urls;
}
