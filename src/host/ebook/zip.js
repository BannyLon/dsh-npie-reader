/**
 * 最小 ZIP 读取器（EPUB 就是 ZIP）。
 *
 * ★ 为什么自己写、不用 npm 包：本仓库的硬规矩是**不借 `node_modules`**（见 README
 *   「边界与已知限制」）。EPUB 用到的只是「中央目录 + 本地头 + deflate」这三样，
 *   而 `node:zlib` 自带 `inflateRawSync` —— 不需要任何第三方实现。
 *
 * ★ 为什么**只**支持存储(0)与 deflate(8)：这两种覆盖了全部真实 EPUB（mimetype 必须
 *   是存储，其余多数是 deflate）。bzip2 / lzma / zstd 出现在 epub 里属于极少数，
 *   而解不了它的正确做法是**如实报一句**，不是猜。
 *
 * ★ 三道闸都为了「坏文件不许把进程拖死」：条目数上限、单条解压体积上限、
 *   全书解压总量上限。攻击面不在网络，而在一份构造过的 ZIP —— 一个 40 KB 的
 *   deflate 流能解出几个 GB（zip bomb），而阅读器是在宿主进程里跑的。
 */
import { inflateRawSync } from 'node:zlib';

/** 一份 EPUB 最多允许多少条目。真实书 50–2000 条，2 万条已属异常。 */
export const MAX_ENTRIES = 20_000;

/** 单个条目解压后的上限（封面图 / 大章节都远小于它）。 */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** 全书解压后的总量上限（含图片；不含图片的书通常 1–5 MB）。 */
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 从尾部找 EOCD。注释最长 64 KB，所以只需回扫 22 + 65535 字节。 */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= min; at -= 1) {
    if (buffer.readUInt32LE(at) !== EOCD_SIG) continue;
    const commentLength = buffer.readUInt16LE(at + 20);
    // 注释长度必须正好把文件收尾 —— 否则这 4 个字节只是数据里凑巧出现的签名。
    if (at + 22 + commentLength === buffer.length) return at;
  }
  return -1;
}

/** ZIP 内部文件名：UTF-8 标志位优先，否则按 UTF-8 试，坏了退 latin1（保住可读性）。 */
function decodeName(bytes, flags) {
  const utf8 = (flags & 0x0800) !== 0;
  if (!utf8) {
    const text = bytes.toString('latin1');
    // 没有标志位但内容明显是 UTF-8 的包很常见（calibre 老版本），能解就解。
    if (/[\u0080-\u00ff]/.test(text)) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return text;
      }
    }
    return text;
  }
  return bytes.toString('utf8');
}

/** 归一化条目名：去掉开头的 `/` 与 `./`，把 `\` 换成 `/`（有些 Windows 工具会写反斜杠）。 */
export function normalizeEntryName(name) {
  return String(name ?? '').replace(/\\/g, '/').replace(/^(\.?\/)+/, '');
}

/**
 * 读一份 ZIP 的中央目录。
 *
 * @param buffer - 整份文件（EPUB 只有几百 KB 到几 MB，整份读进来是刻意的：
 *   边读边解会引入「字节流随机访问」的复杂度，而这里没有任何收益）。
 * @returns `{ names, has(name), read(name), stats }`。`read` 返回 Buffer，
 *   条目不存在返回 `null`（不抛 —— 缺一张图不该让整本书失败）。
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw coded('NOT_ZIP', '这不是一个 ZIP 文件（太短）');
  }
  const eocd = findEocd(buffer);
  if (eocd < 0) throw coded('NOT_ZIP', '这不是一个 ZIP 文件（找不到中央目录结尾）');

  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw coded('ZIP64', '这份 EPUB 用了 ZIP64（单文件超过 4 GB），当前不支持');
  }
  if (count > MAX_ENTRIES) throw coded('ZIP_TOO_MANY', `这份 EPUB 有 ${count} 个条目，超出上限`);
  if (cdOffset + cdSize > buffer.length) throw coded('NOT_ZIP', 'ZIP 中央目录越界（文件被截断？）');

  const entries = new Map();
  let at = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIG) break;
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = normalizeEntryName(decodeName(buffer.subarray(at + 46, at + 46 + nameLength), flags));
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }

  let totalOut = 0;

  function read(name) {
    const key = normalizeEntryName(name);
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (entry.localOffset + 30 > buffer.length) return null;
    if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIG) return null;
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > buffer.length || start > end) return null;
    const raw = buffer.subarray(start, end);
    if (entry.method === 0) {
      totalOut += raw.length;
      if (totalOut > MAX_TOTAL_BYTES) throw coded('ZIP_TOO_BIG', '这本 EPUB 解压后体积超出上限');
      return raw;
    }
    if (entry.method !== 8) {
      throw coded('ZIP_METHOD', `EPUB 里有条目用了不支持的压缩方式（method=${entry.method}）`);
    }
    let out;
    try {
      out = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (error) {
      // 解不出来就只坏这一个条目（多半是坏图），不要连累正文。
      if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(String(error?.message))) {
        throw coded('ZIP_TOO_BIG', `EPUB 里有个条目解压后超过 ${MAX_ENTRY_BYTES} 字节`);
      }
      return null;
    }
    totalOut += out.length;
    if (totalOut > MAX_TOTAL_BYTES) throw coded('ZIP_TOO_BIG', '这本 EPUB 解压后体积超出上限');
    return out;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(normalizeEntryName(name)),
    read,
    stats: { entries: entries.size },
  };
}

export { coded as zipError };
