/**
 * 电子书总入口：按扩展名分派到各格式解析器，并把结果归一成**同一种形状**。
 *
 * 归一后的形状（也是缓存文件的内容）：
 *
 *   {
 *     v: 2,
 *     format: 'epub' | 'mobi' | 'azw3' | 'azw' | 'txt',
 *     title, author, warnings: string[],
 *     toc: [{ title, section, depth }],     // section 是 1 起的节号，depth 是目录层级
 *     sections: [{ title, blocks, lines, chars, empty, level }]
 *   }
 *
 * ★ `sections` 的下标就是「第几节」，**不许在归一阶段删空节**：目录条目、阅读进度、
 *   解读的页号全都按这个下标对齐；删一个空节，后面所有引用都会整体偏移一节，
 *   而症状是「点目录第 5 章跳到第 4 章」——最难查的一类错。
 *
 * ★ **一节 = 一页**，而「节」的粒度是**正文的标题**，不是 EPUB 的 XHTML 文件：
 *   `splitByHeadings` 会把「一个文件装一整卷」的书按小标题再切开。切之前的文件粒度
 *   与切之后的页号之间由那个模块内部兜底，这里只认它返回的结果。
 */
import { parseEpub } from './epub.js';
import { parseMobi } from './mobi.js';
import { parseTxt } from './plain.js';
import { splitByHeadings } from './split.js';

/**
 * 能**重排阅读**的扩展名 —— 清单的**唯一来源**在 `src/library.js`，这里只转出去。
 *
 * ★ 不要在这里另写一份：`renderable`（书架上「能不能读」）与 `BookReader` 的分流
 *   都读那一份。两处各写一份时，加一个格式必然漏改一处，症状是「书架写着能读，
 *   点进去说没接上」。
 */
export { EBOOK_EXTENSIONS, isEbookExtension } from '../../library.js';

/** 缓存格式版本。块模型的形状变了就 +1，老缓存会被自动丢弃。 */
export const EBOOK_CACHE_VERSION = 2;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 归一：补齐字段、算字数、标空节，不改顺序。 */
function normalize(result, { ext, fallbackTitle }) {
  const raw = (Array.isArray(result.sections) ? result.sections : []).map((section, index) => {
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    const lines = Array.isArray(section.lines) ? section.lines : [];
    const chars = Number.isFinite(section.chars) ? section.chars : lines.join('').length;
    return {
      title: String(section.title ?? '').trim() || `第 ${index + 1} 节`,
      blocks,
      lines,
      chars,
      empty: chars === 0,
    };
  });
  if (raw.length === 0) throw coded('EBOOK_EMPTY', '这本书里没有可读的正文');
  const rawToc = (Array.isArray(result.toc) ? result.toc : [])
    .filter(item => Number.isInteger(item?.section) && item.section >= 1 && item.section <= raw.length)
    .map(item => ({ title: String(item.title ?? '').trim(), section: item.section }))
    .filter(item => item.title !== '');
  /**
   * ★ 切分放在**归一之后**：切分只看块里的标题，与格式无关，
   *   所以 EPUB / MOBI / TXT 共用同一套判据，不必每个解析器各写一遍。
   */
  const { sections, toc } = splitByHeadings(raw, rawToc);
  return {
    v: EBOOK_CACHE_VERSION,
    format: String(result.format ?? ext),
    title: String(result.title ?? '').trim() || fallbackTitle,
    author: String(result.author ?? '').trim(),
    warnings: (Array.isArray(result.warnings) ? result.warnings : []).filter(item => typeof item === 'string'),
    toc,
    sections,
  };
}

/**
 * 解析一本书。
 *
 * @param buffer - 整份文件字节。
 * @param options.ext - 扩展名（决定分派）。
 * @param options.fallbackTitle - 书单里的标题（文件里没有元数据时用它）。
 */
export function parseEbook(buffer, { ext = '', fallbackTitle = '' } = {}) {
  const kind = String(ext ?? '').toLowerCase();
  if (kind === 'epub') return normalize(parseEpub(buffer, { fallbackTitle }), { ext: kind, fallbackTitle });
  if (kind === 'mobi' || kind === 'azw' || kind === 'azw3') {
    return normalize(parseMobi(buffer, { ext: kind, fallbackTitle }), { ext: kind, fallbackTitle });
  }
  if (kind === 'txt') return normalize(parseTxt(buffer, { fallbackTitle }), { ext: kind, fallbackTitle });
  throw coded('EBOOK_FORMAT', `不认识的电子书格式：${kind || '(空)'}`);
}

/** 给阅读器用的节索引（不含正文块，payload 很小）。 */
export function sectionIndex(ebook) {
  return (ebook?.sections ?? []).map((section, index) => ({
    n: index + 1,
    title: section.title,
    chars: section.chars,
    empty: section.empty === true,
    level: Number.isInteger(section.level) ? section.level : 0,
  }));
}

/** 节 → `pages.jsonl` 的一页（解读链原样复用 PDF 那条路）。 */
export function pagesOf(ebook) {
  return (ebook?.sections ?? []).map((section, index) => ({
    page: index + 1,
    lines: Array.isArray(section.lines) ? section.lines : [],
  }));
}

/**
 * 生成解读用的目录（`[{ title, page }]`），把过短的节并进相邻节。
 *
 * ★ 为什么要并：EPUB 里「一章一个 XHTML 文件」是常态，但也有把**每一段**装进一个
 *   文件的排版（`part0008.html` 只有 563 字节）。一节一章的话，一本 200 节的书会
 *   变成 200 次模型调用，而其中大半是半页纸。
 *
 * ★ 为什么阈值是 1500 字：中文一屏约 500 字，1500 字约三屏 —— 再小的「章」
 *   解读出来只有一句「本章很短」，纯属浪费调用。这个数只影响**章节怎么分组**，
 *   不影响原文怎么存（`pagesOf` 仍然一节一页）。
 */
export function digestOutline(ebook, { minChapterChars = 1500 } = {}) {
  const sections = Array.isArray(ebook?.sections) ? ebook.sections : [];
  const out = [];
  let bucket = null;

  const flush = () => {
    if (bucket === null) return;
    out.push({ title: bucket.title, page: bucket.page });
    bucket = null;
  };

  sections.forEach((section, index) => {
    if (section.chars <= 0) return;
    if (bucket === null) {
      bucket = { title: section.title, page: index + 1, chars: section.chars };
    } else {
      bucket.chars += section.chars;
    }
    if (bucket.chars >= minChapterChars) flush();
  });
  flush();

  // 只有一章时不要伪装成「目录」：没有结构的书按页窗分段更诚实（交给 segmentBook）。
  return out.length > 1 ? out : [];
}
