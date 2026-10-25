/**
 * 电子书的**层级判据**：目录条目、当前条、页眉里那一行「上级章节」。
 *
 * ★ 为什么单独一个文件：目录面板与页眉都要回答同一个问题 —— 「这一页在书的哪一层」。
 *   两处各算一遍的后果不是「代码重复」，是**两套答案**：目录按一种方式缩进、页眉按
 *   另一种方式显示，用户点完目录会发现页眉写着别的章。判据只有一份，两个调用点
 *   喂同一个 `index`。
 * ★ 页眉**只显示上级（部 / 卷），不显示当页标题**：当页标题就画在正文第一行的 `<h1>`
 *   里，页眉再写一遍，同一句字在屏幕顶部连着出现两遍 —— 0.25.1 的截图里就是这样，
 *   一眼就「low」。纸质书的书眉（running head）写的也从来是**当前所属的章 / 卷**，
 *   或者干脆只有书名。
 */

/**
 * 比较标题时只认字：全角空格、标点、脚注编号都不该让两条标题「不相等」。
 *
 * ★ 脚注编号要**连括号带数字整组删掉**（`〔26〕` / `[26]` / `(26)`）：正文标题常带
 *   脚注标记、目录里不带，只删括号会留下一个 `26`，两条标题仍然不相等 —— 这个坑在
 *   宿主侧的 `split.js` 里踩过一次（那次靠前缀匹配绕过，这里一次性删干净）。
 * ★ 只删**括号里的**数字，不删裸数字：`第三章` 与 `第4章` 必须判为不同，否则页眉
 *   会把「第三章」的上卷当成当页标题而整行不显示。
 */
function plain(value) {
  return String(value ?? '')
    .replace(/[〔[(（]\s*\d{1,4}\s*[〕\])）]/gu, '')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[〔〕[\]【】()（）]/gu, '')
    .replace(/[，,。．.、：:；;！!？?“”"'‘’《》<>—–\-·_/\\|]/gu, '')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase();
}

function toSection(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

/**
 * 目录面板要画的条目：`{ key, title, section, depth }`。
 *
 * ★ 书自带目录优先，**不与节索引合并去重**：自带目录里本来就可能有两章指向同一节
 *   （卷标题页 + 正文首页），合并会**吃掉**其中一条 —— 用户点卷标题时跳的位置就和
 *   他预期的不一样。
 * ★ 没有自带目录的书（TXT，或 EPUB 的 nav / ncx 都缺）用节索引兜底，层级取宿主在
 *   `splitByHeadings` 里算好的 `level` —— 否则这类书的目录会平铺成一列，用户看不出
 *   哪几节属于同一卷。
 * ★ `key` 不用标题拼：同一本书里「本卷注释」出现四次是常事，标题做 key 会让 React
 *   认定它们是同一个节点，翻页时高亮会跳到别的卷上。
 */
export function outlineEntries(index) {
  const toc = Array.isArray(index?.toc) ? index.toc : [];
  if (toc.length > 0) {
    return toc.map((item, i) => ({
      key: `toc-${i}`,
      title: String(item?.title ?? ''),
      section: toSection(item?.section),
      depth: Number(item?.depth) || 0,
    }));
  }
  const sections = Array.isArray(index?.sections) ? index.sections : [];
  return sections.map((item) => ({
    key: `n-${item?.n ?? ''}`,
    title: String(item?.title ?? ''),
    section: toSection(item?.n),
    depth: Number(item?.level) || 0,
  }));
}

/**
 * 当前这一页落在目录的**哪一条**上：`entries` 里「起始节 ≤ 当前页」中最靠后的那一条，
 * 没有则 -1。
 *
 * ★ 不用 `find(entry => entry.section === page)`：目录锚点不可能覆盖每一页（一页里
 *   有两个小标题是常事），精确匹配会让高亮在绝大多数页上消失 —— 用户看到的是
 *   「目录不知道我在哪」。
 * ★ 前提是 `entries` 按阅读顺序排列。目录来自书自己的 nav / ncx，那个顺序就是书的
 *   顺序；判据本身不做排序（排序会掩盖解析端把顺序弄错这件事）。
 */
export function activeEntryIndex(entries, page) {
  let at = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].section <= page) at = i;
  }
  return at;
}

/**
 * 页眉右边那一行：**当前页所属的上级章节名**，没有就返回空串。
 *
 * 三种情形（都以 `page` 是否恰好是某条的起点来分）：
 *   1. 这一页就是「部 / 卷」本身（depth 0）⇒ 不显示 —— 正文第一行就是它的名字。
 *   2. 这一页是一个小节（depth 1）⇒ 显示它所属的卷。
 *   3. 这一页在某个条目内部、自己没有锚点（`section < page`）⇒ 那个条目就是最近的
 *      上级，显示它；再要说清楚就把「自己算深一层」交给下面的 `ownDepth`。
 *
 * `title` 是**当页标题**，只用来兜一道：万一算出来的上级和正文第一行是同一句字
 * （书里「卷名 = 第一节名」这种排法），宁可页眉空着，也不让同一句字出现两遍。
 */
export function runningHead(entries, page, title = '') {
  const at = activeEntryIndex(entries, page);
  if (at < 0) return '';
  const own = entries[at];
  /** 这一页比 `own` 深一层还是同一层 —— 「自己没有锚点」时它就是容器，不是标题。 */
  const ownDepth = own.section === page ? own.depth : own.depth + 1;
  for (let i = at; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.depth >= ownDepth) continue;
    if (entry.title === '') return '';
    return plain(entry.title) === plain(title) ? '' : entry.title;
  }
  return '';
}
