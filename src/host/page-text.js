/**
 * 每页的「行数组」到底从哪里来：**文字层优先，扫描页用识别文本**。
 *
 * ★ 为什么要单独一个模块：分段（`segment.js`）只看「每页有几行字」，它不关心那些字
 *   是 PDF 自带的还是本机识别出来的。把「取哪一份」混进分段里，同一个判据就会在
 *   两处各写一遍（本项目反复踩的那一类：同一件事两套实现，迟早漂移）。
 *
 * ★ 顺序为什么是「文字层优先」而不是「识别优先」：文字层是**书自己写的**，
 *   逐字准确、没有错字；OCR 一定有错字（形近字、漏行、把竖排读成乱序）。
 *   只有当文字层**空到不能用**（扫描页、或者只有页眉页脚几个字）时，
 *   识别文本才是从「没有」到「有」的那一步 —— 这时它的不准确是值得付的代价。
 *
 * ★ 为什么停在 `TEXT_PAGE_MIN_CHARS` 而不是「只要 OCR 更长就用 OCR」：一页正文
 *   若文字层有 300 字、OCR 有 320 字（多认出了页边的书名），换掉等于用一份有错字
 *   的文本替换一份准确的文本，只为了 20 个字的收益。阈值与分段那条判据**同一个数**。
 */

/**
 * 一页算「有文字」的最低字符数。低于它的多半是空白页 / 插图页 / 扫描页。
 *
 * ★ 这个常量是**分段与叠加共用**的判据：`segment.js` 用它算 `textRatio`，
 *   这里用它决定「要不要拿识别文本顶上」。两处各写一个数字的话，会出现
 *   「分段认为这一页有字、叠加认为没有」这种自相矛盾的状态。
 */
export const TEXT_PAGE_MIN_CHARS = 40;

/** 一页有多少字符（行拼接后的长度，不含换行）。与 `segment.js` 的口径一致。 */
function charsOf(lines) {
  return (Array.isArray(lines) ? lines : []).join('').length;
}

/**
 * 把识别文本叠到页上。
 *
 * @param pages - `[{ page, lines }]`，`lines` 来自 PDF 文字层（扫描页是空数组）。
 * @param ocrPages - `{ 页码: 文本 }`，只含**真认出字**的页（`readOcrPages` 的产物）。
 * @returns `{ pages, used }`。`pages` 形状不变，`used` 是**用了识别文本的页码**（升序）。
 *
 * ★ `used` 必须回传，不能只给一个数字：它的第一个用途是 `meta.extract.ocrPages`
 *   （工具与界面据此说「正文里有 N 页是识别来的」），第二个用途是让「这一章的文字
 *   是认出来的」这件事可追溯 —— OCR 有错字，读者有权知道哪些页不该逐字引用。
 * ★ 不往 `pages` 里**加**新页：`pages` 决定页码边界与章节区间，凭空多出一页会让
 *   `endPage` 落到一个不存在的位置。OCR 里有、抽取里没有的页直接忽略（抽取没跑完
 *   时会发生），下一次抽取补齐后自然会用上。
 */
export function overlayOcrPages(pages, ocrPages = {}) {
  const source = (ocrPages !== null && typeof ocrPages === 'object') ? ocrPages : {};
  const used = [];
  const out = (Array.isArray(pages) ? pages : []).map((page) => {
    const lines = Array.isArray(page?.lines) ? page.lines : [];
    const own = charsOf(lines);
    if (own > TEXT_PAGE_MIN_CHARS) return page;

    const text = source[page?.page];
    if (typeof text !== 'string') return page;
    const ocrChars = charsOf(text.split('\n'));
    // 逐字比对没有意义：这一页本来就是空的，只要识别结果够长就是「从无到有」。
    if (ocrChars <= TEXT_PAGE_MIN_CHARS || ocrChars <= own) return page;

    used.push(page.page);
    return { ...page, lines: text.split('\n') };
  });
  return { pages: out, used };
}
