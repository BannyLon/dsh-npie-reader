/**
 * TXT 解析：编码嗅探 + 切章。
 *
 * ★ 编码是这一档的**主要风险**，不是切章。用户书架上那本《人间喜剧》是
 *   **GB18030**（实测：当 UTF-8 解码直接抛 `UnicodeDecodeError`）。中文 TXT 的
 *   现实分布是 GBK/GB18030 与 UTF-8 各占一半，Big5 在港台书里偶见；
 *   只按 UTF-8 读会得到一整本「锟斤拷」。
 *
 * ★ 判据顺序（先严后宽）：
 *   1. BOM（UTF-8 / UTF-16LE / UTF-16BE）—— 有 BOM 就是它，不用猜；
 *   2. **严格** UTF-8 解码成功 ⇒ UTF-8（中文 UTF-8 的字节序列偶然全部合法 GB18030
 *      的概率远低于相反方向，所以先试 UTF-8）；
 *   3. GB18030（GBK 的超集，含 4 字节扩展）；
 *   4. Big5；
 *   5. 都不行 ⇒ UTF-8 宽容解码（乱码也比读不出来强），并记一条 warning。
 */
import { normalizeWhitespace } from './markup.js';

/** 一章最多多少字（没有章节标记时按这个粒度切开）。 */
export const TXT_CHUNK_CHARS = 6000;

/** 识别章节开头的正则。中文小说的实际写法就这几种。 */
const CHAPTER_PATTERNS = [
  /^第\s*[0-9〇一二三四五六七八九十百千零两]+\s*[章节回卷部篇集]/,
  /^(序章|序言|序|楔子|引子|前言|后记|尾声|终章|附录|番外)/,
  /^(Chapter|CHAPTER|Part|PART)\s+([0-9]+|[IVXLC]+)\b/,
];

/** 这一行像不像章节标题（短、且以章号/固定词开头）。 */
export function looksLikeHeading(line) {
  const text = String(line ?? '').trim();
  if (text === '' || text.length > 40) return false;
  return CHAPTER_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * 编码嗅探。
 *
 * @returns `{ encoding, text, warning }`。`encoding` 是最终采用的标签（会写进缓存，
 *   下次不必重猜 —— 同一本书两处猜出不同编码，界面上会看到两段不同的乱码）。
 */
export function decodeTextBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', text: bytes.subarray(3).toString('utf8'), warning: '' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', text: bytes.subarray(2).toString('utf16le'), warning: '' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return { encoding: 'utf-16be', text: swapped.toString('utf16le'), warning: '' };
  }

  const strict = (label) => {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };

  const utf8 = strict('utf-8');
  if (utf8 !== null) return { encoding: 'utf-8', text: utf8, warning: '' };

  const gb = strict('gb18030');
  if (gb !== null) return { encoding: 'gb18030', text: gb, warning: '' };

  const big5 = strict('big5');
  if (big5 !== null) return { encoding: 'big5', text: big5, warning: '' };

  return {
    encoding: 'utf-8',
    text: new TextDecoder('utf-8').decode(bytes),
    warning: '这本书的编码认不出来，按 UTF-8 读了 —— 可能有乱码',
  };
}

/**
 * 纯文本 → 节。
 *
 * 有章节标记就按标记切（每章一节），否则按 `chunkChars` 硬切并**如实**命名成
 * 「第 N 节」—— 不把切出来的块伪装成「章」。
 */
export function splitPlainText(text, { chunkChars = TXT_CHUNK_CHARS } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = null;

  const start = (title, heading = '') => {
    current = { title, lines: [], heading };
    sections.push(current);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '') {
      if (current !== null) current.lines.push('');
      continue;
    }
    if (looksLikeHeading(trimmed)) {
      start(normalizeWhitespace(trimmed), trimmed);
      // 标题本身也进正文（分段算法靠「页面首行是标题」反查章节）。
      current.lines.push(trimmed);
      continue;
    }
    if (current === null) start('开头');
    current.lines.push(line);
  }

  const withContent = sections.filter(section => section.lines.join('').trim() !== '');
  if (withContent.length >= 2) {
    return withContent.map((section, index) => ({
      title: section.title || `第 ${index + 1} 节`,
      blocks: section.lines
        .map(line => (line.trim() === ''
          ? null
          : { k: line.trim() === section.heading ? 'h2' : 'p', x: line }))
        .filter(Boolean),
      lines: section.lines.map(line => line.trim()).filter(Boolean),
    }));
  }

  /** 没有章节标记：按字数在**段落边界**硬切。 */
  const paragraphs = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.trim()).filter(Boolean);
  const out = [];
  let bucket = [];
  let chars = 0;
  const flush = () => {
    if (bucket.length === 0) return;
    out.push({
      title: `第 ${out.length + 1} 节`,
      blocks: bucket.map(text => ({ k: 'p', x: text })),
      lines: bucket.slice(),
    });
    bucket = [];
    chars = 0;
  };
  for (const paragraph of paragraphs) {
    bucket.push(paragraph);
    chars += paragraph.length;
    if (chars >= chunkChars) flush();
  }
  flush();
  return out;
}

/** 解析一本 TXT。 */
export function parseTxt(buffer, { fallbackTitle = '' } = {}) {
  const { encoding, text, warning } = decodeTextBuffer(buffer);
  const raw = splitPlainText(text);
  const sections = raw.map(section => ({
    ...section,
    chars: section.lines.join('').length,
  }));
  if (sections.length === 0) {
    const error = new Error('这本书里没有可读的文字（文件是空的？）');
    error.code = 'TXT_EMPTY';
    throw error;
  }
  const warnings = warning === '' ? [] : [warning];
  if (sections.length === 1) warnings.push('这本 TXT 没有章节标记，整本算一节');
  return {
    format: 'txt',
    title: fallbackTitle,
    author: '',
    encoding,
    sections,
    toc: sections.length > 1
      ? sections.map((section, index) => ({ title: section.title, section: index + 1 }))
      : [],
    warnings,
  };
}
