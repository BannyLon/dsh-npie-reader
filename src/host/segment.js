/**
 * 把一本书的「每页行数组」切成章节。
 *
 * ★ 这个模块是**纯函数**：不碰 pdf.js、不碰文件系统、不碰网络。输入是渲染进程
 *   抽好的行，输出是章节树。理由和 `book-view.js` 顶部那条一样 —— 分段是
 *   「看起来对、实际错得很隐蔽」的典型：切错了不会报错，只会让用户点第 5 章跳到
 *   第 3 章，而代码读起来完全正常。抽成纯函数之后，每一档都能拿真实书的页面
 *   数据喂进去，并配反向对照。
 *
 * ── 四档降级（顺序即优先级）─────────────────────────────────────────────
 *
 *   outline  PDF 自带的书签目录。**最准**，页码直接来自 `getPageIndex`。
 *   toc      书前面的「目录」页：取条目 → 在正文里反查起始页。
 *   heading  页面首行匹配「第 N 章 / Chapter N / Part N」。
 *   window   固定页窗兜底。**标题必须写成「第 12–28 页」**，不许伪造成章名。
 *
 * ★ 为什么 `toc` 排在 `heading` 前面（2026-10-23 真机实测）：
 *   22 本本机 PDF 里只有 1 本带书签目录（5%），所以 outline 指望不上；
 *   而「目录页」在真正的书里几乎必有，且目录条目标题与正文章节首页**逐字相同**，
 *   反查命中率远高于正则猜章号。实测两本技术书：toc 档 24/24、31/31 章全部命中，
 *   且交叉验证（用有 outline 的书当标准答案）10/11 精确、0 个差一页。
 *
 * ★ `window` 的标题为什么不能写成「第 2 章」：本仓库的 `series` / `year` 就是因为
 *   「正则猜出来的值会被用户当成事实」而刻意留空的（见 `book-source.js` 顶部）。
 *   页窗是**兜底**，它自己就该承认自己是页窗。
 */

/**
 * ★ 这个阈值与 `page-text.js` 的叠加判据**是同一个数**（从那边导入）：那边用它决定
 *   「要不要拿识别文本顶上」，这里用它算 `textRatio`。各写一份的后果不是重复，
 *   而是「分段认为这一页有字、叠加认为没有」这种自己跟自己打架的状态。
 */
import { TEXT_PAGE_MIN_CHARS } from './page-text.js';

/** 有文字页占比低于这个值 ⇒ 判为扫描版，直接拒绝解读。 */
export const SCANNED_RATIO = 0.2;

/** 目录页判定：行均长上限。正文行是撑满的（实测 35–45 字/行），目录条目短。 */
const TOC_AVG_LINE_MAX = 34;

/** 目录页判定：最少行数。少于这个数的「短页」多半是章节尾页或插图页。 */
const TOC_MIN_LINES = 4;

/** 目录页只可能出现在书的前部。按总页数取 15% + 5 页，封顶 40 页。 */
function tocSearchLimit(pageCount) {
  return Math.min(Math.ceil(pageCount * 0.15) + 5, 40);
}

/** 页窗兜底每段多少页。 */
const WINDOW_STEP = 20;

/** 目录条目里这些标题不是「可跳转的内容章节」，是书的骨架件，要剔掉。 */
const SKIP_OUTLINE_TITLES = /^(扉页|封面|封底|书名页|目录|目\s*录|contents|版权页|版权信息|copyright|title\s*page)$/i;

/** 行尾的句末/句中停顿标点。目录条目几乎不会以它们结尾。 */
const TRAILING_PUNCT = /[。，、；：！？,;:!?…]$/;

/**
 * 归一化：用来比对「目录里的标题」与「正文里的标题」。
 *
 * ★ 必须做 NFKC：PDF 字体映射会把同一个汉字映射到**康熙部首**码位 ——
 *   实测某本 PDF 的「自序」在文本层里是 `⾃序`（U+2F83，不是 U+81EA）。
 *   不归一化的话，肉眼完全一样的两行字符串比对会失败，而且失败得毫无线索。
 *   顺带把点导引（`……`）和空白一起抹掉。
 */
export function normalizeTitle(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\s\u00a0·・•…⋯]/g, '')
    .replace(/[.。]{2,}/g, '')
    .toLowerCase();
}

/** 这一页有多少字符（行拼接后的长度，不含换行）。 */
function pageChars(lines) {
  return lines.join('').length;
}

/** 这一页算不算「有文字」。 */
function isTextPage(lines) {
  return pageChars(lines) > TEXT_PAGE_MIN_CHARS;
}

/**
 * 页面形态：目录页与正文页在**行尾标点**这一维上几乎完全分开。
 *
 * ★ 2026-10-23 实测一本 98 页的手册前 40 页：目录页（p2–p4）的 `noPunct`
 *   恒为 `1.00`，正文页在 `0.54–0.96` 之间波动 —— 没有任何一页正文达到 1.00。
 *   而「字符数 < 900」这条曾被我用来当主判据，结果把目录页（572/628 字符）
 *   全排除了、又把正文页放了进来，切出 43 个叫「2025年11月」的假章节。
 */
function pageShape(lines) {
  const chars = pageChars(lines);
  const count = lines.length;
  const noPunct = count === 0
    ? 0
    : lines.filter(line => !TRAILING_PUNCT.test(line)).length / count;
  return {
    chars,
    lines: count,
    avgLen: count === 0 ? 0 : chars / count,
    noPunct,
  };
}

/** 目录页形态判据（不含「有没有目录字样」，那一条单独判）。 */
function looksLikeTocPage(lines) {
  if (lines.length < TOC_MIN_LINES) return false;
  const shape = pageShape(lines);
  return shape.avgLen < TOC_AVG_LINE_MAX && shape.noPunct === 1;
}

/** 页面前几行是否写着「目录」。允许中英文与中间夹空格。 */
function hasTocHeading(lines) {
  return /目录|CONTENTS|目\s*录/i.test(lines.slice(0, 3).join(' '));
}

/**
 * 从「目录页」的文字行里提出条目。
 *
 * 去掉两种尾巴：点导引 + 页码（`第1章……12`）、纯数字页码（`第1章 12`）。
 * 页码在这个阶段没用 —— 电子书的目录页码常常是**印刷页码**，与 PDF 物理页
 * 差一截（前言用罗马数字、封面不计页），照着它跳页会整体偏移。
 */
function tocEntries(lines) {
  const out = [];
  for (const raw of lines) {
    const title = String(raw ?? '')
      .replace(/\s*[.·…]{2,}\s*\d+$/, '')
      .replace(/\s+\d{1,4}$/, '')
      .trim();
    if (title.length < 2 || title.length > 44) continue;
    if (/^(目录|contents|目\s*录)$/i.test(title)) continue;
    if (/^\d+$/.test(title)) continue;
    out.push(title);
  }
  return out;
}

/**
 * 在正文里找这个标题第一次作为「页面开头」出现的页。
 *
 * 两级：先要求归一化后**页首两行**以标题开头（目录条目标题与章节首页标题逐字相同，
 * 这是最可靠的锚）；找不到再退到「前 6 行里包含」。
 *
 * ★ 为什么不能一上来就用「包含」：正文里提到章名的句子到处都是（「下一章我们会
 *   讲 §07 扩展能力」），用包含会命中前面的引用页，用户点章节就跳到不相干的地方。
 *
 * @returns 页码（1 起），找不到返回 null。
 */
function resolveEntryPage(pages, key, fromPage) {
  for (let i = fromPage; i <= pages.length; i += 1) {
    const lines = pages[i - 1] ?? [];
    const head = normalizeTitle((lines[0] ?? '') + (lines[1] ?? ''));
    if (head.startsWith(key)) return i;
  }
  for (let i = fromPage; i <= pages.length; i += 1) {
    const lines = pages[i - 1] ?? [];
    if (normalizeTitle(lines.slice(0, 6).join(' ')).includes(key)) return i;
  }
  return null;
}

/** 找目录页组：首页必须写着「目录」，后续页只要形态相符就一起吞进来。 */
function findTocPages(pages) {
  const limit = tocSearchLimit(pages.length);
  let first = null;
  for (let i = 1; i <= limit; i += 1) {
    const lines = pages[i - 1] ?? [];
    if (!hasTocHeading(lines)) continue;
    if (!looksLikeTocPage(lines)) continue;
    first = i;
    break;
  }
  if (first === null) return [];
  const out = [];
  for (let i = first; i <= limit && looksLikeTocPage(pages[i - 1] ?? []); i += 1) out.push(i);
  return out;
}

/** 章节序号统一重排（1 起）。`n` 是给界面和工具调用用的稳定标识，不是页码。 */
function numberChapters(list) {
  return list.map((chapter, index) => ({ ...chapter, n: index + 1 }));
}

/**
 * 同页多条目只留最长的那条。
 *
 * ★ 实测某本手册的目录里「附录」和「附录A」指向同一页，
 *   留着短的会算出 `endPage = 116 < startPage = 117` 的倒挂章节 ——
 *   界面上显示成 `p117-116`，点进去还在那一页，但排序和进度计算全乱。
 */
function dedupeByPage(list) {
  const byPage = new Map();
  for (const chapter of list) {
    const prev = byPage.get(chapter.startPage);
    if (prev === undefined || chapter.title.length > prev.title.length) {
      byPage.set(chapter.startPage, chapter);
    }
  }
  return [...byPage.values()].sort((a, b) => a.startPage - b.startPage);
}

/** 补 endPage：下一章的起始页减一；最后一章到全书末页。 */
function fillEndPages(list, pageCount) {
  return list.map((chapter, index) => ({
    ...chapter,
    endPage: index + 1 < list.length ? list[index + 1].startPage - 1 : pageCount,
  }));
}

/**
 * outline 档。条目来自渲染进程的 `doc.getOutline()` + `getPageIndex()`。
 *
 * 过滤掉「扉页 / 目录 / 版权页」这类骨架件 —— 它们不是可读章节，生成解读时会
 * 白烧一次模型调用。实测某本 635 页的书，58 条书签里混着 4 条「扉页/目录/版权页」。
 */
export function chaptersFromOutline(outline, pageCount) {
  const entries = (Array.isArray(outline) ? outline : [])
    .filter(item => item && typeof item.title === 'string')
    .filter(item => !SKIP_OUTLINE_TITLES.test(item.title.trim()))
    .filter(item => Number.isInteger(item.page) && item.page >= 1 && item.page <= pageCount)
    .map(item => ({ title: item.title.trim(), startPage: item.page, source: 'outline' }));
  return fillEndPages(dedupeByPage(entries), pageCount);
}

/**
 * toc 档：目录页条目 → 正文反查。
 *
 * @returns `{ chapters, tocPages }`。`chapters` 可能为空（目录页里全是无法反查的
 *   分组标题时）—— 调用方据此降级，**不要**把空结果当成「这本书没有章节」。
 */
export function chaptersFromToc(pages) {
  const tocPages = findTocPages(pages);
  if (tocPages.length === 0) return { chapters: [], tocPages };

  const bodyStart = tocPages[tocPages.length - 1] + 1;
  const entries = [];
  for (const pageNo of tocPages) {
    for (const title of tocEntries(pages[pageNo - 1] ?? [])) entries.push(title);
  }

  const found = [];
  const seen = new Set();
  for (const title of entries) {
    const key = normalizeTitle(title);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const page = resolveEntryPage(pages, key, bodyStart);
    // 反查不到的条目是目录里的**分组标题**（`Part 1: 起步`、`附录`），
    // 正文里本来就没有对应页。丢掉它们，不是失败。
    if (page === null) continue;
    found.push({ title, startPage: page, source: 'toc' });
  }
  return { chapters: fillEndPages(dedupeByPage(found), pages.length), tocPages };
}

/** 章节文字量低于这个值、且只占一页 ⇒ 判定为「分组标题页」而不是内容章节。 */
const SECTION_MAX_CHARS = 50;

/**
 * 把「卷标题页」标成 `section`。
 *
 * ★ 实测一本 838 页的书、19 条书签，第一条是「上册」—— 它只占 p6 一页、
 *   正文两个字。不标出来的后果：界面上出现一个「上册 p.6–6 2字」的章节，
 *   用户点进去看到一页白纸；P2 生成时还会为它白烧一次模型调用。
 *
 * ★ 只标记、**不删**：这是书的结构，「上册 / 下册」本身是有效信息，
 *   只是它不是可读的一章。删掉之后章节序号会跳，用户会以为漏了一章。
 *
 * @param chapters - 已补好 endPage 的章节。
 * @param pages - 每页的行数组。**没有正文时无法判定，原样返回** ——
 *   宁可漏标，也不要凭页码瞎猜。
 */
function markSections(chapters, pages) {
  if (pages.length === 0) return chapters;
  return chapters.map((chapter) => {
    let chars = 0;
    for (let page = chapter.startPage; page <= chapter.endPage; page += 1) {
      chars += (pages[page - 1] ?? []).join('').length;
    }
    return chars < SECTION_MAX_CHARS ? { ...chapter, section: true } : chapter;
  });
}

/** heading 档的章标记。刻意保守：宁可退回页窗，也不要切出一堆假章。 */const HEADING_CN = /^第\s*[0-9一二三四五六七八九十百千零〇]+\s*[章回节篇卷部讲]/;
const HEADING_EN = /^(chapter|part|appendix)\b/i;

export function chaptersFromHeadings(pages) {
  const found = [];
  for (let i = 1; i <= pages.length; i += 1) {
    const head = (pages[i - 1] ?? [])[0] ?? '';
    if (head.length > 40) continue;
    if (!HEADING_CN.test(head) && !HEADING_EN.test(head)) continue;
    found.push({ title: head, startPage: i, source: 'heading' });
  }
  return fillEndPages(dedupeByPage(found), pages.length);
}

/**
 * 页窗兜底。
 *
 * ★ 标题就是「第 X–Y 页」。不要从附近文本里挑一行当章名 —— 那会让用户以为
 *   自己看到的是书的真实章节结构。
 */
export function chaptersFromWindows(pageCount, step = WINDOW_STEP) {
  const out = [];
  for (let start = 1; start <= pageCount; start += step) {
    const end = Math.min(start + step - 1, pageCount);
    out.push({ n: out.length + 1, title: `第 ${start}–${end} 页`, startPage: start, endPage: end, source: 'window' });
  }
  return out;
}

/**
 * 分段入口。
 *
 * @param input.pages - 每页的行数组（`pages[0]` 是第 1 页）。
 * @param input.outline - 渲染进程解析好的 outline 条目 `[{ title, page }]`。
 * @param input.pageCount - 总页数（`pages` 可能只抽了一部分时用它兜 endPage）。
 * @param input.assumeText - **调用方已经知道正文一定有字**（重排电子书：文字是我们
 *   从文件里解出来的）。见下面那段说明。
 * @returns `{ mode, chapters, stats }`。`mode === 'scanned'` 时 `chapters` 为空。
 *
 * ★ 扫描版判定放在**最前面**，因为它决定后面所有事：没有文字层就没有目录页、
 *   没有章标记、也没有可解读的正文。实测 32 本本机 PDF 里 9 本（28%）是扫描版，
 *   这不是边缘情况 —— 界面必须先说清楚「这本书读不了」，而不是先算出一堆章节
 *   再在生成时一页页失败。
 *
 * ★ 但这条判据**只对 PDF 成立**，所以留了 `assumeText` 这个口子：
 *   - 它按「每页至少 `TEXT_PAGE_MIN_CHARS` 字」算 `textRatio`，而电子书的「一页」
 *     是**一节**，章节扉页、卷标题页、`part0008.html` 里只有一行字都很正常；
 *   - 一本 3 节的短书会被判成「扫描版」⇒ 面板上写「这本书是扫描版，没有可抽取的
 *     文字」，而它明明是纯文本 —— 这是最糟的一类错：说得斩钉截铁且完全不对。
 *   - 电子书一旦走到这里，文字已经在内存里了，「有没有字」不是待猜的事。
 *
 * ★ `assumeText` 也跳过「目录页反查」与「章标记识别」两档启发式：那两档是为
 *   PDF 的排版猜结构写的，套在电子书上只会把正文行误当成目录条目
 *   （实测会把「2025 年 11 月」切成 43 个假章节）。
 */
export function segmentBook({ pages = [], outline = [], pageCount, assumeText = false } = {}) {
  const total = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : pages.length;
  const textPages = pages.filter(isTextPage).length;
  const textRatio = pages.length === 0 ? 0 : textPages / pages.length;

  const stats = {
    pages: total,
    sampled: pages.length,
    textPages,
    textRatio: Number(textRatio.toFixed(3)),
    outlineEntries: Array.isArray(outline) ? outline.length : 0,
    tocPages: [],
  };

  if (pages.length === 0) {
    // 还没抽正文（只拿到了 outline）。这时 outline 仍然可用，别浪费。
    const chapters = chaptersFromOutline(outline, total);
    if (chapters.length > 0) return { mode: 'outline', chapters: numberChapters(chapters), stats };
    return { mode: 'scanned', chapters: [], stats };
  }

  if (!assumeText && textRatio < SCANNED_RATIO) return { mode: 'scanned', chapters: [], stats };

  const fromOutline = chaptersFromOutline(outline, total);
  // ★ 这里必须过 `numberChapters`：章节序号 `n` 是章节文件名的来源
  //   （`ch${n}.txt`），漏掉它就会写出 `chundefined.txt` —— 而单元测试里
  //   「序号连续」那条只跑了 toc 档，全绿也发现不了（2026-10-23 端到端抓到的）。
  /**
   * 够不够格当目录的门槛：PDF 要 3 条（书签常被切碎，1–2 条多半是噪声），
   * 电子书**要 1 条就够** —— 那是解析器从 nav/ncx 里读出来的真目录，不是猜的。
   */
  if (fromOutline.length >= (assumeText ? 1 : 3)) {
    return { mode: 'outline', chapters: numberChapters(markSections(fromOutline, pages)), stats };
  }

  // 电子书没有自己的目录（TXT / 无 nav 的 EPUB）：按节切成页窗，不再猜。
  if (assumeText) return { mode: 'window', chapters: chaptersFromWindows(total), stats };

  const toc = chaptersFromToc(pages);
  stats.tocPages = toc.tocPages;
  if (toc.chapters.length >= 3) {
    return { mode: 'toc', chapters: numberChapters(toc.chapters), stats };
  }

  const headings = chaptersFromHeadings(pages);
  if (headings.length >= 3) {
    return { mode: 'heading', chapters: numberChapters(headings), stats };
  }

  return { mode: 'window', chapters: chaptersFromWindows(total), stats };
}
