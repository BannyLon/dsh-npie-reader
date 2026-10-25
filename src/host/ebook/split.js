/**
 * 把「一节」（= EPUB 的一个 XHTML 文件）再切细成「页」。
 *
 * ★ 为什么要切：EPUB 的常态是**一个 XHTML 装一整卷**。九三年这本 21 个文件、
 *   目录 99 条 —— 第四卷 1.5 万字全在同一个文件里，里面还有「一、沙丘顶上」
 *   ……「七、绝不宽大」「本卷注释」八个小标题。不切的话：
 *     · 一页装一整卷，翻页粒度太粗，读到「四、卡义芒」就不知道自己在哪；
 *     · 目录里点「二、AURES HABET」只能跳到卷首，还得自己往下滚着找。
 *   切完之后「一节 = 一页 = 目录的一条」，翻页和跳转都对得上纸质书的手感。
 *
 * ★ 切点只看**正文里的标题块**，不看目录：目录会漏条目（九三年就漏了
 *   「一、沙丘顶上」—— nav 里没写），只按目录切会把这一节的内容并进上一页，
 *   而页面标题仍写着上一节的名字，症状是「点目录跳到的页标题不对」。
 *   正文标题是**完整**的那一份，所以以它为准，目录再用标题文本映射回来。
 *
 * ★ 目录条目映射不上时**必须兜底**（落到它原来所属节的第一页），不许丢条目：
 *   丢一条 = 目录里少一行 = 用户以为书缺了一章。
 *
 * ★ 不允许丢块。合并后每一页的块首尾相接、顺序不变、总数等于切之前那一节的块数。
 *   这条是硬不变量，测试里逐个文件校验。
 */
import { blocksToLines } from './markup.js';

/** 标题块。`h1`–`h6` 都算，但电子书正文里实际只用得到 h1–h3。 */
const HEADING = /^h([1-6])$/u;

/** 页数上限。超过它的书多半是「一段一个标题」的坏排版，宁可不切，也不能炸成上万页。 */
const MAX_PAGES = 4000;

function headingRank(kind) {
  const match = HEADING.exec(String(kind ?? ''));
  return match === null ? 0 : Number(match[1]);
}

/**
 * 标题文本的比较形：**只留字**。
 *
 * ★ 目录和正文的同一句标题经常差在标点和空白上（正文「二、AURES HABET，ET NON
 *   AUDIET〔2〕」vs 目录「二、AURES HABET，ET NON AUDIET」），逐字相等匹配不上。
 *   把标点、空白、脚注方括号全去掉再比，命中率才对。
 */
function squash(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[〔〕[\]【】()（）]/gu, '')
    .replace(/[，,。．.、：:；;！!？?“”"'‘’《》<>—–\-·_/\\|]/gu, '')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase();
}

/** 把级别压成连续下标（只用到 h2/h3 的书得到 0/1）。页标题与页内标题共用一张表。 */
function compactLevels(pages) {
  const values = [];
  for (const page of pages) {
    values.push(page.level);
    for (const head of page.heads) values.push(head.level);
  }
  const used = [...new Set(values)].sort((a, b) => a - b);
  const table = new Map(used.map((level, index) => [level, index]));
  for (const page of pages) {
    page.level = table.get(page.level) ?? 0;
    for (const head of page.heads) head.level = table.get(head.level) ?? 0;
  }
}

/**
 * 在**某一节切出来的页范围**里，按标题文本找那一页（以及它在目录里的层级）。
 *
 * ★ 必须限定在范围内找：目录里「本卷注释」每条都重名，全局找的话全书的注释页
 *   会全部并到第一处，后面的条目被当成重复项吃掉 —— 九三年就这样少了 11 条。
 * ★ 允许前缀匹配：正文的标题常带脚注编号（`四、TORMENTUM BELLI〔26〕`），
 *   目录里没有（`四、TORMENTUM BELLI`）。完全相等匹配不上，得放宽。
 * ★ 还要查**页内标题**：卷标题页会并进第一节那页，此时「一、子」不是页的标题，
 *   却仍要按小节（depth 1）显示在目录里，否则整章的小节都跟卷名同级。
 * @returns `{ page, level }`，页号 1 起；找不到返回 undefined。
 */
function locateTitle(pages, from, to, title) {
  const key = squash(title);
  if (key === '') return undefined;
  let prefixHit;
  for (let page = from; page <= to; page += 1) {
    const candidate = squash(pages[page - 1].title);
    if (candidate === '') continue;
    if (candidate === key) return { page, level: pages[page - 1].level };
    if (prefixHit === undefined && (candidate.startsWith(key) || key.startsWith(candidate))) {
      prefixHit = { page, level: pages[page - 1].level };
    }
  }
  for (let page = from; page <= to; page += 1) {
    for (const head of pages[page - 1].heads) {
      if (head.key === key) return { page, level: head.level };
    }
  }
  return prefixHit;
}

/**
 * 按正文标题重切分节，并把目录条目重新映射到新页号。
 *
 * @param sections - 已归一的节（`[{ title, blocks, lines, chars, empty }]`）。
 * @param toc - 已归一的目录（`[{ title, section }]`，`section` 是 1 起的节号）。
 * @returns `{ sections, toc }`，目录条目多一个 `depth`（0 = 章，1 = 节…）。
 */
export function splitByHeadings(sections, toc) {
  const source = Array.isArray(sections) ? sections : [];
  if (source.length === 0) return { sections: source, toc: Array.isArray(toc) ? toc : [] };

  /** 本书用到的标题级别 → 序号（h1 最粗）。 */
  const kinds = new Set();
  for (const section of source) {
    for (const block of Array.isArray(section.blocks) ? section.blocks : []) {
      if (HEADING.test(String(block?.k ?? ''))) kinds.add(String(block.k));
    }
  }
  const ordered = [...kinds].sort((a, b) => headingRank(a) - headingRank(b));
  const rankOfKind = new Map(ordered.map((kind, index) => [kind, index]));

  const pages = [];
  /** 旧节号（1 起）→ 它切出来的页号范围，目录按范围匹配与兜底都要用。 */
  const spanOfOld = new Map();

  for (let index = 0; index < source.length; index += 1) {
    const section = source[index];
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    const heads = [];
    blocks.forEach((block, at) => {
      if (!HEADING.test(String(block?.k ?? ''))) return;
      const text = String(block?.x ?? '').trim();
      if (text === '') return;
      heads.push({ at, text, kind: String(block.k) });
    });

    /** 每一页的起点：`{ at, title, level }`。 */
    const starts = [];
    if (heads.length === 0) {
      starts.push({ at: 0, title: section.title, level: 0 });
    } else {
      // 第一个标题之前的块（前言、献词）：单独一页，用原节名。
      if (heads[0].at > 0) starts.push({ at: 0, title: section.title, level: 0 });
      for (const head of heads) {
        starts.push({ at: head.at, title: head.text, level: rankOfKind.get(head.kind) ?? 0 });
      }
    }

    const firstPage = pages.length + 1;
    for (let i = 0; i < starts.length; i += 1) {
      const from = starts[i].at;
      const to = i + 1 < starts.length ? starts[i + 1].at : blocks.length;
      const slice = blocks.slice(from, to);
      const lines = blocksToLines(slice);
      pages.push({
        title: starts[i].title,
        blocks: slice,
        lines,
        chars: lines.join('').length,
        level: starts[i].level,
        /** 这一页里的所有标题（含页标题本身），目录映射与层级显示都查它。 */
        heads: slice
          .filter(block => HEADING.test(String(block?.k ?? '')))
          .map(block => ({ key: squash(block.x), level: rankOfKind.get(String(block.k)) ?? 0 })),
        /** 这一页（合并之后）由哪几个旧节贡献，目录兜底按它反查页号。 */
        owners: [index + 1],
      });
    }
    if (pages.length >= MAX_PAGES) break;
    spanOfOld.set(index + 1, { from: firstPage, to: pages.length });
  }

  if (pages.length > MAX_PAGES) return { sections: source, toc: Array.isArray(toc) ? toc : [] };

  /**
   * 把「只有标题、没有半句正文」的页并到下一张正文页的顶部。
   *
   * ★ 为什么必须并：不少 EPUB 把「第二卷 克莱莫尔号军舰」单独放进一个 XHTML，
   *   正文在下一段里。切完之后就变成「翻一页只有一行标题、再翻一页才是正文」，
   *   纸质书不是这样 —— 章标题印在章首页顶上，底下直接接正文。
   * ★ 判据是**页里除了标题块一个正文块都没有**，不是「字数少」。按字数判会把
   *   「第一章 起点 / 第一段。」这种短章也并掉，一本书会并成一页。
   * ★ 「第一部 在海上」这类扉页自带一个正文块（这版电子书里是个 `spec` 残字），
   *   于是它留独立一页 —— 正好是纸质书的样子。
   */
  const kept = [];
  let pending = null;
  pages.forEach((page, index) => {
    /** 没有任何正文块的页：整页空白，或只有一个标题。两种都并到下一张正文页去。 */
    const titleOnly = page.blocks.length === 0
      || page.blocks.every(block => HEADING.test(String(block?.k ?? '')));
    if (titleOnly && index < pages.length - 1) {
      if (pending === null) {
        pending = { ...page, owners: [...page.owners] };
        return;
      }
      const blocks = [...pending.blocks, ...page.blocks];
      const lines = blocksToLines(blocks);
      pending = {
        ...pending,
        blocks,
        lines,
        chars: lines.join('').length,
        heads: [...pending.heads, ...page.heads],
        owners: [...pending.owners, ...page.owners],
      };
      return;
    }
    if (pending === null) {
      kept.push(page);
      return;
    }
    const blocks = [...pending.blocks, ...page.blocks];
    const lines = blocksToLines(blocks);
    kept.push({
      ...page,
      title: pending.title,
      level: pending.level,
      blocks,
      lines,
      chars: lines.join('').length,
      heads: [...pending.heads, ...page.heads],
      owners: [...pending.owners, ...page.owners],
    });
    pending = null;
  });
  if (pending !== null) kept.push(pending);

  compactLevels(kept);

  /** 旧节号 → 它切出来的页号范围。合并过的旧节，范围就是它并进去的那一页。 */
  const spanOfMerged = new Map();
  kept.forEach((page, index) => {
    for (const owner of page.owners) {
      const current = spanOfMerged.get(owner);
      if (current === undefined) spanOfMerged.set(owner, { from: index + 1, to: index + 1 });
      else current.to = index + 1;
    }
  });

  const out = kept.map(page => ({
    title: page.title,
    blocks: page.blocks,
    lines: page.lines,
    chars: page.chars,
    empty: page.chars === 0,
    level: page.level,
  }));

  const nextToc = [];
  const seen = new Set();
  for (const entry of Array.isArray(toc) ? toc : []) {
    const title = String(entry?.title ?? '').trim();
    if (title === '') continue;
    const span = spanOfMerged.get(Number(entry?.section)) ?? spanOfOld.get(Number(entry?.section));
    if (span === undefined) continue;
    // 先在这一节自己的范围里按标题找，找不到就落到这一节的第一页（绝不丢条目）。
    const hit = locateTitle(kept, span.from, span.to, title);
    const page = hit?.page ?? span.from;
    const key = `${page}\u0000${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nextToc.push({ title, section: page, depth: hit?.level ?? kept[page - 1].level });
  }

  return { sections: out, toc: nextToc };
}
