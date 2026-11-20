/**
 * MOBI / AZW / AZW3 解析。
 *
 * 容器是 PalmDB：文件头之后是一张 record 偏移表，record 0 是「PalmDOC 头 +
 * MOBI 头 + EXTH 元数据」，record 1..N 是压缩过的正文（HTML 片段）。
 *
 * 三种压缩在真机上都会遇到（本机 9 本实测）：
 *   - `comp=1` 不压缩；
 *   - `comp=2` PalmDOC LZ77 —— 7/9 本；
 *   - `comp=17480` HUFF/CDIC —— 2/9 本（都是 AZW3）。
 *
 * ★ 为什么 AZW3（KF8）要单独取一遍：双格式文件（EXTH 121 = KF8 起始 record）
 *   前半是 MOBI7、后半是 KF8。KF8 那一段有它自己的 record 0 头。优先读 KF8：
 *   它是亚马逊后来重排用的版本，章节结构通常比 MOBI7 干净。
 *
 * ★ 必须有 DRM 闸：加密的书（`PalmDOC 头` 的 encryption type ≠ 0）解出来是乱码。
 *   不挡的话，用户会看到一整本「烫烫烫」，然后以为是插件坏了。
 */
import { htmlToBlocks, blocksToLines, normalizeWhitespace, titleFromBlocks } from './markup.js';

const MOBI_COMPRESSION_NONE = 1;
const MOBI_COMPRESSION_PALMDOC = 2;
const MOBI_COMPRESSION_HUFF = 17480;

/** 一本 MOBI 的 record 数上限（真实书 200–5000，4 万条已属构造过）。 */
const MAX_RECORDS = 40_000;

/** 解压后正文的上限：一本 40 MB 的合集解压后可以到 15 MB，给 64 MB 余量。 */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 读 PalmDB 的 record 偏移表。 */
export function palmRecords(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 78) throw coded('NOT_MOBI', '这不是一本 MOBI（文件太短）');
  const count = buffer.readUInt16BE(76);
  if (!Number.isInteger(count) || count <= 0 || count > MAX_RECORDS) {
    throw coded('NOT_MOBI', `record 数异常（${count}）`);
  }
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const at = 78 + index * 8;
    if (at + 4 > buffer.length) break;
    offsets.push(buffer.readUInt32BE(at));
  }
  offsets.push(buffer.length);
  const records = [];
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const start = offsets[index];
    const end = offsets[index + 1];
    if (start >= end || end > buffer.length) { records.push(Buffer.alloc(0)); continue; }
    records.push(buffer.subarray(start, end));
  }
  return records;
}

/**
 * PalmDOC LZ77 解压。
 *
 * 字节语义（规范就只有这几条）：
 *   `0x01–0x08` 后面跟 n 个**原样**字节；`0x09–0x7F` 是自身；
 *   `0x80–0xBF` 是「长度 + 距离」对（2 字节，距离 11 位、长度 3 位）；
 *   `0xC0` 是空格、`0xC1–0xFF` 是 `c ^ 0x80`。
 *
 * ★ 距离越界必须**停下**而不是抛错：坏流在最后几个字节截断是常态，抛错会让
 *   整本书丢掉前面已经解出来的 200 页。
 */
export function decompressPalmDoc(data) {
  let out = Buffer.alloc(Math.max(data.length * 8, 1024));
  let length = 0;
  let index = 0;
  const at = data.length;

  const ensure = (need) => {
    if (length + need <= out.length) return true;
    if (out.length >= MAX_TEXT_BYTES) return false;
    const next = Buffer.alloc(Math.min(Math.max(out.length * 2, length + need), MAX_TEXT_BYTES));
    out.copy(next, 0, 0, length);
    out = next;
    return true;
  };

  while (index < at) {
    const byte = data[index];
    index += 1;
    if (byte === 0) continue;
    if (byte <= 0x08) {
      const take = Math.min(byte, at - index);
      if (!ensure(take)) break;
      data.copy(out, length, index, index + take);
      length += take;
      index += take;
      continue;
    }
    if (byte <= 0x7f) {
      if (!ensure(1)) break;
      out[length] = byte;
      length += 1;
      continue;
    }
    if (byte >= 0xc0) {
      /**
       * ★ `0xC1–0xFF` 的语义是「**一个空格 + 该字符**」，不是「该字符」。
       *   只写字符的话，整本书的 ASCII 空格会全部消失 —— 实测症状是
       *   `<h6title="封面">`、`heighte=800`，而**汉字本身完全正常**，所以很容易
       *   被误判成「HTML 写得糙」。`0xC0` 单独表示一个空格（没有后续字符）。
       */
      const need = byte === 0xc0 ? 1 : 2;
      if (!ensure(need)) break;
      out[length] = 0x20;
      length += 1;
      if (byte !== 0xc0) {
        out[length] = byte ^ 0x80;
        length += 1;
      }
      continue;
    }
    if (index >= at) break;
    const pair = (byte << 8) | data[index];
    index += 1;
    const distance = (pair >> 3) & 0x7ff;
    const copyLength = (pair & 0x07) + 3;
    if (distance === 0 || distance > length) break;
    if (!ensure(copyLength)) break;
    for (let step = 0; step < copyLength; step += 1) {
      out[length] = out[length - distance];
      length += 1;
    }
  }
  return out.subarray(0, length);
}

/**
 * 剪切一条正文 record。
 *
 * ★ 每条 record 的正文**正好是前 `recordSize` 字节**（头里那个字段，通常 4096），
 *   超出的部分是 MOBI 的内部数据（索引 / 多字节重叠），不是正文。
 *   实测：按 `recordSize` 截断后，一本 86 万字节的书**一个坏字都没有**，且总长度与
 *   头里的 `textLength` 分毫不差；不截断则每 4 KB 蹦出 2–4 个 `\uFFFD`。
 */
export function sliceTextRecord(record, recordSize) {
  const size = Number.isInteger(recordSize) && recordSize > 0 ? recordSize : 4096;
  return record.length > size ? record.subarray(0, size) : record;
}

/** 读 MOBI 头里我们需要的那几个字段。 */
function parseMobiHeader(record0, { base = 0 } = {}) {
  if (record0.length < 16 + 132) return null;
  if (record0.toString('latin1', 16, 20) !== 'MOBI') return null;
  const headerLength = record0.readUInt32BE(20);
  const encoding = record0.readUInt32BE(28);
  const version = record0.readUInt32BE(36);
  const firstNonBook = record0.readUInt32BE(16 + 0x40) || 0;
  const nameOffset = record0.readUInt32BE(16 + 0x44) || 0;
  const nameLength = record0.readUInt32BE(16 + 0x48) || 0;
  const huffOffset = record0.readUInt32BE(16 + 0x64) || 0;
  const huffCount = record0.readUInt32BE(16 + 0x68) || 0;
  const exthFlags = record0.readUInt32BE(16 + 0x70) || 0;
  /**
   * 第一张图片所在的 record 索引（MOBI 头 offset `0x5C`）。
   *
   * ★ 封面**不是**从这个索引直接取，而是 `firstImageIndex + EXTH[201]` ——
   *   一本书里的图片 record 从「封面」开始排是**不成立**的（前面常有一堆装饰图）。
   */
  const firstImageIndex = record0.readUInt32BE(16 + 0x5C) || 0;

  let name = '';
  if (nameOffset > 0 && nameLength > 0 && nameOffset + nameLength <= record0.length) {
    name = record0.toString(encoding === 65001 ? 'utf8' : 'latin1', nameOffset, nameOffset + nameLength);
  }

  const exth = {};
  /**
   * ★ 这两个**必须从原始字节读**（`readUInt32BE`），不能走下面那张字符串表：
   *   EXTH 201 / 202 的值是**4 字节大端整数**，用 `toString()` 出来是
   *   `"\u0000\u0000\u0000\u0003"` 这种 —— `parseInt` 永远拿到 NaN，于是
   *   「有封面」与「没封面」在代码里长得一模一样，封面功能会静默失效。
   */
  let coverOffset = -1;
  let thumbOffset = -1;
  /**
   * EXTH 121 = KF8 正文起始 record，同样是**4 字节整数**。
   *
   * ★ 这一条此前是从字符串表里 `parseInt` 出来的 —— 值里全是 `\u0000`，
   *   于是 `kf8Boundary` **恒为 0**，下面 `parts.unshift(kf8)` 那段「优先 KF8」
   *   一次都没执行过。症状完全看不见：MOBI7 那一半也有正文，照样读得出来，
   *   只是章节结构用的是旧的那一套。0.71.6 修封面时才发现（双格式的封面索引
   *   在 KF8 头里，取不到边界就永远走不到那一支）。
   */
  let kf8Boundary = 0;
  if ((exthFlags & 0x40) !== 0 && headerLength > 0) {
    const at = 16 + headerLength;
    if (at + 12 <= record0.length && record0.toString('latin1', at, at + 4) === 'EXTH') {
      const count = record0.readUInt32BE(at + 8);
      let cursor = at + 12;
      for (let index = 0; index < count && cursor + 8 <= record0.length; index += 1) {
        const type = record0.readUInt32BE(cursor);
        const length = record0.readUInt32BE(cursor + 4);
        if (length < 8 || cursor + length > record0.length) break;
        const value = record0.toString(encoding === 65001 ? 'utf8' : 'latin1', cursor + 8, cursor + length);
        if (!(type in exth)) exth[type] = value;
        if (type === 121 && length >= 12) kf8Boundary = record0.readUInt32BE(cursor + 8);
        if (type === 201 && length >= 12) coverOffset = record0.readUInt32BE(cursor + 8);
        if (type === 202 && length >= 12) thumbOffset = record0.readUInt32BE(cursor + 8);
        cursor += length;
      }
    }
  }
  return {
    base,
    headerLength,
    encoding: encoding === 65001 ? 'utf8' : 'latin1',
    version,
    firstNonBook,
    firstImageIndex,
    coverOffset,
    thumbOffset,
    name: normalizeWhitespace(name),
    huffOffset,
    huffCount,
    kf8Boundary,
    author: normalizeWhitespace(exth[100] ?? ''),
    title: normalizeWhitespace(exth[503] ?? ''),
    publisher: normalizeWhitespace(exth[101] ?? ''),
    exth,
  };
}

/**
 * 解出来的正文像不像二进制数据。
 *
 * ★ 为什么正文也要拦（封面那条路早就有魔数校验，这里没有）：头部损坏的 MOBI 会
 *   声明一个离谱的 `textLength`，而按 record 解出来的「正文」可能其实是**一整张
 *   JPEG + 几千个 NUL**。它长度自洽、不报错，会被当成一本正常的书收进书架，用户
 *   点开只看到满屏方块，且完全不知道发生了什么 —— 属于「存在性 ≠ 有效性」。
 *
 * 两条判据：① 已知二进制文件头（确凿）；② 控制字符占比 > 10%（兜底）。
 * 正常正文是 ASCII 或 UTF-8（多字节都在 0x80 以上），除 \t\n\r 外几乎不含控制字符，
 * 所以这条**不会误伤中文书**；判 4 KB 前缀而不是全书，是 mega 合集的解析开销考虑。
 */
export function looksLikeBinary(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return false;
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (head.length >= 4) {
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;                    // JPEG
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return true;                    // GIF
    if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return true; // PDF
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03) return true;                    // ZIP
  }
  let control = 0;
  for (const byte of head) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20) control += 1;
  }
  return control / head.length > 0.1;
}

/**
 * 头里的 `textLength` 值不值得信。
 *
 * ★ 反向的危险比「垃圾大值」更大：坏值小得离谱（比如 100）时无条件采信，会把整本
 *   书截成 100 字节，**而且看起来像正常解析**（长度自洽、无乱码），谁都不会去查。
 *   要求它与实测解压长度同量级：正常偏差在 2% 上下（多读了几条尾部记录），
 *   0.5 这个下限既挡得住垃圾小值，也不会放过正常的裁剪。
 */
export function trustTextLength(declared, actual) {
  if (!Number.isFinite(declared) || declared <= 0) return false;
  if (!Number.isFinite(actual) || actual <= 0 || declared > actual) return false;
  return declared >= actual * 0.5;
}

/** 解出一段 record 区间的正文。 */
function decodeSection(records, header, startRecord) {
  const palm = records[startRecord];
  if (palm === undefined || palm.length < 16) throw coded('MOBI_BAD', '这本 MOBI 的正文头读不出来');
  const compression = palm.readUInt16BE(0);
  const encryption = palm.readUInt16BE(12);
  if (encryption !== 0) {
    throw coded('BOOK_DRM', '这本书带 DRM（加密），插件解不开。请在 calibre 里去掉 DRM 后转成 EPUB 再读。');
  }
  const textLength = palm.readUInt32BE(4);
  const recordCount = palm.readUInt16BE(8);
  const recordSize = palm.readUInt16BE(10);
  const textRecords = [];
  for (let index = 0; index < recordCount; index += 1) {
    const record = records[startRecord + 1 + index];
    if (record === undefined) break;
    textRecords.push(record);
  }
  if (textRecords.length === 0) throw coded('MOBI_NO_TEXT', '这本 MOBI 没有正文记录');

  let bytes;
  if (compression === MOBI_COMPRESSION_NONE) {
    bytes = Buffer.concat(textRecords.map(record => sliceTextRecord(record, recordSize)));
  } else if (compression === MOBI_COMPRESSION_PALMDOC) {
    // ★ 先解压、再按 recordSize 截断：多余字节在**解压之后**的流末尾。
    bytes = Buffer.concat(textRecords.map(record => sliceTextRecord(decompressPalmDoc(record), recordSize)));
  } else if (compression === MOBI_COMPRESSION_HUFF) {
    /**
     * HUFF/CDIC（`comp=17480`）：本机 9 本里 2 本是它，都是 AZW3。
     *
     * ★ 这一档**刻意不做半成品**：解错了不会报错，只会把整本书解成
     *   「烫烫烫」式的乱码或几十倍的膨胀，用户看到的是「插件把书读坏了」。
     *   如实拒绝 + 给一条能自救的路（calibre 转 EPUB，文字不会丢），比给一个
     *   看起来能打开、实际全是乱码的阅读器更好。
     */
    throw coded(
      'MOBI_HUFFDIC',
      '这本 Kindle 书用了 HUFF/CDIC 压缩，当前版本还解不开。'
      + '可以在 calibre 里转成 EPUB（文字不会丢），或者换一本 AZW3/EPUB 版本。',
    );
  } else {
    throw coded('MOBI_COMPRESSION', `这本 MOBI 用了不认识的压缩方式（${compression}）`);
  }

  /**
   * ★ 顺序不能反：**先**判「是不是文字」，**再**决定裁不裁。先按 `textLength` 裁，
   *   坏值会把一段二进制截成看似正常的长度，魔数也可能被裁掉，两条判据互相拆台。
   */
  if (looksLikeBinary(bytes)) {
    throw coded('MOBI_BINARY', '这本 MOBI 的正文不是文字（文件头可能损坏），已停止解析，以免把乱码当正文显示。');
  }
  const text = trustTextLength(textLength, bytes.length) ? bytes.subarray(0, textLength) : bytes;
  return { text, compression, encoding: header.encoding };
}

/** 按页分隔符切成若干段 HTML。 */
export function splitMobiHtml(html) {
  const parts = String(html ?? '').split(/<mbp:pagebreak\s*\/?>|<div[^>]*class\s*=\s*"[^"]*pagebreak[^"]*"[^>]*>\s*<\/div>/i);
  return parts.map(part => part.trim()).filter(part => part !== '');
}

/**
 * 解析一本 MOBI / AZW / AZW3。
 *
 * @returns `{ format, title, author, sections, toc, warnings }`
 */
export function parseMobi(buffer, { ext = 'mobi', fallbackTitle = '' } = {}) {
  const records = palmRecords(buffer);
  const record0 = records[0];
  if (record0 === undefined || record0.length < 16) throw coded('NOT_MOBI', '这不是一本 MOBI（record 0 太短）');

  const head = parseMobiHeader(record0);
  if (head === null) throw coded('NOT_MOBI', '这不是一本 MOBI（record 0 里没有 MOBI 头）');

  const warnings = [];
  /** 双格式：前半 MOBI7、后半 KF8。优先 KF8（章节结构通常更干净）。 */
  const parts = [{ start: 0, header: head }];
  if (head.kf8Boundary > 0 && head.kf8Boundary < records.length) {
    const kf8Header = parseMobiHeader(records[head.kf8Boundary], { base: head.kf8Boundary });
    if (kf8Header !== null) parts.unshift({ start: head.kf8Boundary, header: kf8Header });
    else warnings.push('这本书里有一段 KF8 正文读不出来，退回 MOBI7');
  }

  let decoded = null;
  let used = null;
  let lastError = null;
  for (const part of parts) {
    try {
      const result = decodeSection(records, part.header, part.start);
      const bytes = result.text;
      if (bytes.length === 0) throw coded('MOBI_NO_TEXT', '这一段没有正文');
      decoded = result;
      used = part;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (decoded === null || used === null) throw lastError ?? coded('MOBI_NO_TEXT', '这本 MOBI 解不出正文');

  const encoding = decoded.encoding === 'utf8' ? 'utf8' : 'latin1';
  const html = decoded.text.toString(encoding);
  const chunks = splitMobiHtml(html);
  const sections = [];

  const pushSection = (partHtml) => {
    const { blocks } = htmlToBlocks(partHtml);
    const lines = blocksToLines(blocks);
    if (lines.length === 0) return;
    const title = titleFromBlocks(blocks) || (sections.length === 0 ? '正文' : `第 ${sections.length + 1} 节`);
    sections.push({ title, blocks, lines, chars: lines.join('').length });
  };

  if (chunks.length >= 3) {
    for (const chunk of chunks) pushSection(chunk);
  } else {
    /** 没有页分隔符的书：按标题切；连标题都没有就按字数硬切（标成「第 N 节」）。 */
    const { blocks } = htmlToBlocks(html);
    const headingAt = [];
    blocks.forEach((block, index) => {
      if (/^h[12]$/.test(block.k)) headingAt.push(index);
    });
    if (headingAt.length >= 3) {
      const starts = [0, ...headingAt.filter(index => index > 0)];
      const unique = [...new Set(starts)].sort((a, b) => a - b);
      for (let index = 0; index < unique.length; index += 1) {
        const slice = blocks.slice(unique[index], unique[index + 1] ?? blocks.length);
        const lines = blocksToLines(slice);
        if (lines.length === 0) continue;
        sections.push({
          title: titleFromBlocks(slice) || `第 ${sections.length + 1} 节`,
          blocks: slice,
          lines,
          chars: lines.join('').length,
        });
      }
    } else {
      let chunkBlocks = [];
      let chars = 0;
      const flush = () => {
        if (chunkBlocks.length === 0) return;
        const lines = blocksToLines(chunkBlocks);
        sections.push({
          title: `第 ${sections.length + 1} 节`,
          blocks: chunkBlocks,
          lines,
          chars: lines.join('').length,
        });
        chunkBlocks = [];
        chars = 0;
      };
      for (const block of blocks) {
        chunkBlocks.push(block);
        chars += String(block.x ?? '').length;
        if (chars > 8000) flush();
      }
      flush();
      if (sections.length > 0) warnings.push('这本 MOBI 没有可识别的章节标记，按字数切成了若干节');
    }
  }

  if (sections.length === 0) throw coded('MOBI_EMPTY', '这本 MOBI 解出了字节，但抽不到任何文字');

  const toc = sections.length > 1
    ? sections.map((section, index) => ({ title: section.title, section: index + 1 }))
    : [];

  return {
    format: ext === 'azw3' ? 'azw3' : (ext === 'azw' ? 'azw' : 'mobi'),
    title: head.title || used.header.title || head.name || fallbackTitle,
    author: head.author || used.header.author,
    sections,
    toc,
    warnings,
    compression: decoded.compression,
  };
}

/**
 * 图片魔数 → MIME。认不出来的一律 `''`。
 *
 * ★ 这张表**不是可选的**：`firstImageIndex + coverOffset` 算错一个数就会指到正文
 *   record 上，而正文是压缩过的 HTML —— 直接发给界面会得到一张「像噪点的图」，
 *   浏览器不报错、用户只会觉得「封面怎么是花的」。魔数校验是唯一在源头挡住它的东西。
 * ★ 只收浏览器 `<img>` 画得出来的位图：MOBI 里也可能塞 SVG（当包装页），
 *   那种不在这里解。
 */
function imageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/** `firstImageIndex` 的哨兵值：`0xFFFFFFFF` 表示「这本书里没有图片段」。 */
const NO_IMAGES = 0xffffffff;

/**
 * 从 MOBI / AZW / AZW3 字节里取出封面图。
 *
 * 取值链（与 calibre / dalibre 同一套，但多一层校验）：
 *   `MOBI 头 0x5C` = 第一张图片的 record 索引；
 *   `EXTH 201` = 封面相对它的偏移；`EXTH 202` = 缩略图偏移（201 缺失时的退路）。
 *
 * ★ `base` 的两种口径都要试：单格式文件里 `firstImageIndex` 是**绝对** record 索引；
 *   而双格式（MOBI7 + KF8）文件的 KF8 头里，见过按**相对 KF8 起点**记的写盘。
 *   两种都算一遍、取第一条**通过魔数校验**的 —— 猜错的那条只会被魔数挡掉，不会出错图。
 *
 * @param {Buffer} buffer 整本 MOBI 的字节
 * @returns {{ bytes: Buffer, mime: string, href: string } | null}
 *   解不出来一律 `null`（**不抛**）：封面是界面的装饰，不该让侧栏报错。
 */
export function mobiCoverImage(buffer) {
  let records;
  let head;
  try {
    records = palmRecords(buffer);
    const record0 = records[0];
    if (record0 === undefined) return null;
    head = parseMobiHeader(record0);
  } catch {
    return null;
  }
  if (head === null) return null;

  /**
   * 双格式文件（MOBI7 前半 + KF8 后半）有**两个 record 0**，各有一套图片索引。
   * 与 `parseMobi` 同一个顺序：KF8 优先（它才是亚马逊后来重排用的那一版，
   * 封面通常也更新），读不出来再退回 MOBI7。
   */
  const heads = [head];
  if (head.kf8Boundary > 0 && head.kf8Boundary < records.length) {
    const kf8 = parseMobiHeader(records[head.kf8Boundary], { base: head.kf8Boundary });
    if (kf8 !== null) heads.unshift(kf8);
  }

  for (const candidate of heads) {
    const firstImage = candidate.firstImageIndex;
    // 0 与 0xFFFFFFFF 都是「没有图片段」；越界的直接跳过（坏文件比封面更常见）。
    if (!(firstImage > 0) || firstImage === NO_IMAGES || firstImage >= records.length) continue;
    const offsets = [candidate.coverOffset, candidate.thumbOffset]
      .filter((value) => Number.isInteger(value) && value >= 0);
    for (const offset of offsets) {
      // 绝对索引（单格式：与 calibre 写的一致）与相对 `base` 索引（KF8 里见过）都试。
      for (const base of [0, candidate.base]) {
        const index = base + firstImage + offset;
        if (!(index >= 0) || index >= records.length) continue;
        const bytes = records[index];
        const mime = imageMime(bytes);
        if (mime === '') continue;
        return { bytes, mime, href: `record:${index}` };
      }
    }
  }
  return null;
}

export { MOBI_COMPRESSION_HUFF, MOBI_COMPRESSION_PALMDOC };
