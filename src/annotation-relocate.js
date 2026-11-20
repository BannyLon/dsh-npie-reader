/**
 * 划线锚点**按摘录原文重定位**（共用层纯函数，host 与 client 都只读它）。
 *
 * ── 补的是哪一笔债 ──────────────────────────────────────────────────────
 *
 * `annotation-store.js` 与 `annotations.js` 的文件头都写着「文字层变了还能用
 * `quote` 兜底找回或如实标为失配」，但那条路径此前**只有注释、没有实现**：
 * 落盘的 `{ page, start, end }` 一旦因为重切页 / 换过文件而失效，渲染端照样
 * 拿旧坐标去切字，症状是「线画到了别的字上」—— 比不画更糟，因为用户会以为
 * 自己划的就是那句。
 *
 * ── 三条不可让的判据 ────────────────────────────────────────────────────
 *
 *  ① 锚点处的文字仍等于 `quote` ⇒ **一个字段都不动**（正常打开书是绝大多数）；
 *  ② 失配 ⇒ 在全书找 `quote`，**唯一命中**才改 `page/start/end`；
 *  ③ 找到 0 处或多处 ⇒ 标 `mismatch`，**不猜、不静默丢弃、不画到别的字上**。
 *     常见短语（「他说」）在多页重复时宁可如实说「定不了位」，也不随便挑一处。
 *
 * ── 为什么按「去掉空白后逐字相等」比 === 更合适 ────────────────────────
 *
 * `selectionQuote()` 存盘前会把连续空白压成一个空格、跨行保留换行、两端 trim，
 * 而 `anchorOfSelection()` 量的偏移是**未归一化**的原文下标。两者在同一个块里
 * 通常相等，遇到多空格 / 跨块换行就会差一两个字。若用严格相等判「是否失配」，
 * 一本排版松散的书会被整本误判成失配。所以比较与查找都在「去空白字符序列」
 * 上做，命中后再用 `positions` 映回**原文下标**（含中间空白），渲染端按块切时
 * 不会丢字。
 *
 * ── 与页文本口径的关系 ──────────────────────────────────────────────────
 *
 * `BLOCK_SEP` 与 `pageTextOfBlocks()` 是**唯一定义**，`client/ebook-marks.js`
 * 从此处 import 后原样导出。改这个值 = 让所有已存划线错位，两份定义更是会让
 * 重定位与渲染各算各的（不报错，只是越修越歪）。
 */

/** 块与块之间的分隔符。改这个值等于让所有已存的划线错位。 */
export const BLOCK_SEP = '\n';

export const MISMATCH = Object.freeze({
  NONE: '',
  /** 全书都找不到这段原文。 */
  MISSING: 'missing',
  /** 全书出现多处，无法确定是哪一处。 */
  AMBIGUOUS: 'ambiguous',
});

/** 一页上最多数几处命中：超过 1 处就已判歧义，不必把整本数完。 */
const MAX_HITS = 2;

const SPACE = /\s/u;

/** 页内坐标系下的全文（与 `blockSpans` 同一基准，空块不占坐标）。 */
export function pageTextOfBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(block => String(block?.x ?? ''))
    .filter(text => text !== '')
    .join(BLOCK_SEP);
}

/**
 * 去掉所有空白后的字符序列 + 每个字符在原文里的下标。
 * 用非全局正则逐字判断，避免 `lastIndex` 在同一份文本上跨页串味。
 */
function compactOf(text) {
  const source = String(text ?? '');
  const chars = [];
  const positions = [];
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (SPACE.test(ch)) continue;
    chars.push(ch);
    positions.push(index);
  }
  return { compact: chars.join(''), positions };
}

/** 在去空白序列里找出所有起点（重叠也算），够 MAX_HITS 就停。 */
function startsOf(compact, needle) {
  const out = [];
  if (needle === '') return out;
  let from = 0;
  for (;;) {
    const at = compact.indexOf(needle, from);
    if (at === -1) break;
    out.push(at);
    if (out.length >= MAX_HITS) break;
    from = at + 1;
  }
  return out;
}

/**
 * @param items - 落盘的划线 `[{ id, page, start, end, quote, ... }]`。
 * @param pageTexts - `[{ page, text }]`，`text` 来自 `pageTextOfBlocks(section.blocks)`。
 *                    传空数组 ⇒ 一条都不判失配（PDF 书 / 缓存还没建时走这条）。
 * @returns `{ items, relocated, mismatched }`
 *   `items` 是新数组，不改动入参；`mismatch` 是**只在内存里的标记**，不落盘。
 */
export function relocateAnnotations(items, pageTexts) {
  const list = Array.isArray(items) ? items : [];
  const pages = Array.isArray(pageTexts) ? pageTexts : [];
  if (list.length === 0 || pages.length === 0) {
    return { items: list.slice(), relocated: [], mismatched: [] };
  }

  /** 每页只建一次索引：一本书几万字、几十条划线，逐条重建会白烧几十倍。 */
  const indexed = [];
  const byPage = new Map();
  for (const entry of pages) {
    const page = Number(entry?.page);
    if (!Number.isInteger(page) || page < 1) continue;
    const text = String(entry?.text ?? '');
    const built = { page, text, ...compactOf(text) };
    indexed.push(built);
    byPage.set(page, built);
  }
  if (indexed.length === 0) return { items: list.slice(), relocated: [], mismatched: [] };

  const out = [];
  const relocated = [];
  const mismatched = [];
  for (const item of list) {
    const quote = String(item?.quote ?? '');
    const needle = compactOf(quote).compact;
    const current = byPage.get(Number(item?.page));

    // ① 锚点还准 ⇒ 原样保留。去空白比较是为了兼容选区存盘时的空白归一化。
    if (needle !== '' && current !== undefined
      && Number.isInteger(item?.start) && Number.isInteger(item?.end)) {
      const slice = compactOf(current.text.slice(item.start, item.end)).compact;
      if (slice === needle) {
        out.push({ ...item, mismatch: MISMATCH.NONE });
        continue;
      }
    }

    // ② 全书找。0 处 / 多处都如实标出来，绝不挑一个凑数。
    const hits = [];
    if (needle !== '') {
      for (const entry of indexed) {
        for (const at of startsOf(entry.compact, needle)) {
          const last = at + needle.length - 1;
          hits.push({
            page: entry.page,
            start: entry.positions[at],
            end: entry.positions[last] + 1,
          });
          if (hits.length >= MAX_HITS) break;
        }
        if (hits.length >= MAX_HITS) break;
      }
    }

    if (hits.length !== 1) {
      const mismatch = hits.length === 0 ? MISMATCH.MISSING : MISMATCH.AMBIGUOUS;
      out.push({ ...item, mismatch });
      mismatched.push({ id: String(item?.id ?? ''), mismatch });
      continue;
    }

    const hit = hits[0];
    // 二次校验：新区间映回原文后逐字（去空白）必须等于摘录，否则当没找到。
    const found = byPage.get(hit.page);
    if (compactOf(found.text.slice(hit.start, hit.end)).compact !== needle) {
      out.push({ ...item, mismatch: MISMATCH.MISSING });
      mismatched.push({ id: String(item?.id ?? ''), mismatch: MISMATCH.MISSING });
      continue;
    }
    out.push({ ...item, page: hit.page, start: hit.start, end: hit.end, mismatch: MISMATCH.NONE });
    relocated.push({ id: String(item?.id ?? ''), from: Number(item?.page), to: hit.page });
  }

  return { items: out, relocated, mismatched };
}

/** 客户端渲染前用：失配的划线不参与切字，也不参与「这一段已经划过了」。 */
export function withoutMismatch(items) {
  return (Array.isArray(items) ? items : []).filter(item => !item?.mismatch);
}
