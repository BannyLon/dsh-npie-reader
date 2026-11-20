/**
 * 论文页级翻译的「受保护片段」掩码。
 *
 * 来源与许可：移植自 agentero 的 motif
 * `packages/host/src/translation/mask.ts`（MIT，Copyright (c) 2026 poco-ai）。
 * 许可全文见 `src/client/paper-reflow/MOTIF-LICENSE.txt`，不可删除或改写。
 *
 * 为什么需要：模型会把 `$E=mc^2$`、`\cite{...}`、DOI、URL 当成普通英文顺手
 * 「翻译」或改写。编号/公式一旦被改掉，译文盖回原 PDF 就是错的版面，而且
 * 不报错 —— 比漏翻更难发现。这里在发给模型前把这些片段换成 `⟦n⟧`
 * （数学白括号，论文正文里不出现），回来后按占位符还原。
 *
 * ★ 判据：占位符**少一个、多一个、重复一次**都判这一段翻译失败，调用方
 *   直接丢掉该段译文（保留画布上的原文），绝不把 `⟦3⟧` 印给用户看。
 */

/** 与上游 mask.ts 的顺序一致：先长后短，重叠片段只取第一个。 */
const MASK_PATTERNS = [
  /⟪(?:F|\/?S)\d+⟫/gu,
  /\$\$[^$]{1,400}\$\$/g,
  /\$[^$\n]{1,200}\$/g,
  /\\\((?:[^\\]|\\[^)]){1,200}?\\\)/g,
  /\\[A-Za-z]+(?:\{[^{}]{0,120}\})?/g,
  /https?:\/\/[^\s、，。]+/g,
  /\bdoi:\s*10\.\d{4,9}\/\S+/gi,
  /\b10\.\d{4,9}\/[^\s、，。]+/g,
  /`[^`\n]+`/g,
  /⟦\s*\d+\s*⟧/g,
  /\[\[\d+\]\]/g,
];

const placeholderFor = (index) => `⟦${index}⟧`;

/**
 * @param {string} text 一段原文
 * @returns {{text: string, tokens: {placeholder: string, original: string}[]}}
 */
export function maskInlineTokens(text) {
  const source = String(text ?? '');
  const spans = [];
  for (const pattern of MASK_PATTERNS) {
    for (const match of source.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const start = match.index ?? 0;
      spans.push({ start, end: start + match[0].length, text: match[0] });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const tokens = [];
  let cursor = 0;
  let masked = '';
  let index = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // 重叠：长片段已经吃掉了
    let placeholder = placeholderFor(index++);
    while (source.includes(placeholder)) placeholder = placeholderFor(index++);
    tokens.push({ placeholder, original: span.text });
    masked += source.slice(cursor, span.start) + placeholder;
    cursor = span.end;
  }
  return { text: masked + source.slice(cursor), tokens };
}

/**
 * @param {string} text 模型返回的该段译文
 * @param {{placeholder: string, original: string}[]} tokens maskInlineTokens 的结果
 * @returns {{text: string, missing: number, invalid: boolean}}
 */
export function restoreInlineTokens(text, tokens) {
  const source = String(text ?? '');
  const originals = new Map(
    (Array.isArray(tokens) ? tokens : []).map((token) => [
      String(token.placeholder).slice(1, -1),
      String(token.original),
    ]),
  );
  if (originals.size === 0) return { text: source, missing: 0, invalid: false };
  const counts = new Map();
  let invalid = false;
  const out = source.replace(/⟦\s*(\d+)\s*⟧/g, (full, id) => {
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    const original = originals.get(id);
    if (original === undefined || count > 1) invalid = true;
    return original ?? full;
  });
  const missing = [...originals.keys()].filter((id) => !counts.has(id)).length;
  return { text: out, missing, invalid };
}
