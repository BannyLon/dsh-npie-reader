/**
 * 电子书总入口：按扩展名分派到各格式解析器，并把结果归一成**同一种形状**。
 *
 * 归一后的形状（也是缓存文件的内容）：
 *
 *   {
 *     v: 3,
 *     format: 'epub' | 'mobi' | 'azw3' | 'azw' | 'txt',
 *     title, author, warnings: string[],
 *     script, scriptRatio,                  // 全书语种（0.62.0 起随缓存落盘）
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
import { FIND_LIMIT_MAX, findOccurrences, normalizeNeedle, snippetOf } from '../../book-find.js';
import { bookScript } from '../../ebook-translate.js';
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
export const EBOOK_CACHE_VERSION = 3;

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
  /*
   * ★ 语种在**解析阶段**算一次、跟着缓存落盘（0.62.0）。
   *   它是整本的结论（`bookScript` 遍历所有块），阅读器那边只有目录、没有正文，
   *   自己算不出来；而「打开书 → 才知道对照按钮该不该灰」每次现算一遍，
   *   一本 50 万字母的书要 15ms、十几本一起探就是几百毫秒。
   *   算一次存下来，之后读缓存就带着（见 `store.js` 的 `script`）。
   */
  const { script, ratio: scriptRatio } = bookScript({ sections });
  return {
    v: EBOOK_CACHE_VERSION,
    format: String(result.format ?? ext),
    title: String(result.title ?? '').trim() || fallbackTitle,
    author: String(result.author ?? '').trim(),
    warnings: (Array.isArray(result.warnings) ? result.warnings : []).filter(item => typeof item === 'string'),
    toc,
    sections,
    script,
    scriptRatio,
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
 * 全书正文检索（书内搜索）。
 *
 * ★ 为什么在宿主做：正文本来就只在这里（EPUB 要解 ZIP、MOBI 要解 LZ77、TXT 要嗅探
 *   编码），而且解析结果已经落盘缓存。浏览器侧要搜就得把一百多节全取过去 ——
 *   一次检索变成一百次往返，还会让「读的是哪一份正文」出现两份可能。
 * ★ 判据来自 `src/book-find.js`（与 `book_search` 同一套），这里只负责**遍历**：
 *   一节 → 一块 → 逐处命中。空块不参与（渲染端也跳过它们，偏移不会被它们带偏）。
 * ★ 返回的 `start / end` 是**块内偏移**（不是全书偏移）：高亮要落在那一块的文字上，
 *   而块是渲染端唯一稳定的定位单位（`data-block`）。
 * ★ 到上限就停下并置 `truncated`：截断必须说出口，否则「共 300 处」会被读成
 *   「全书只有 300 处」。
 */
export function findInEbook(ebook, query, { limit = FIND_LIMIT_MAX } = {}) {
  const needle = normalizeNeedle(query);
  if (needle === '') throw coded('EBOOK_FIND_EMPTY', 'query 不能为空');
  const cap = Math.max(1, Math.min(Number(limit) || FIND_LIMIT_MAX, FIND_LIMIT_MAX));
  const sections = Array.isArray(ebook?.sections) ? ebook.sections : [];
  const hits = [];
  let blocks = 0;
  let chars = 0;
  let truncated = false;
  for (let index = 0; index < sections.length && !truncated; index += 1) {
    const section = sections[index];
    const list = Array.isArray(section?.blocks) ? section.blocks : [];
    for (let block = 0; block < list.length; block += 1) {
      const text = String(list[block]?.x ?? '');
      if (text === '') continue;
      blocks += 1;
      chars += text.length;
      for (const hit of findOccurrences(text, needle, { limit: cap - hits.length })) {
        hits.push({
          n: index + 1,
          sectionTitle: String(section?.title ?? ''),
          block,
          start: hit.start,
          end: hit.end,
          snippet: snippetOf(text, hit.start, hit.end),
        });
        if (hits.length >= cap) { truncated = true; break; }
      }
      if (truncated) break;
    }
  }
  return {
    query: String(query ?? ''),
    total: hits.length,
    truncated,
    sections: sections.length,
    blocks,
    chars,
    hits,
  };
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
