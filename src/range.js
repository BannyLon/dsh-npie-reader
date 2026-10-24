/**
 * HTTP `Range` 请求头的解析（`bytes=` 单段）。
 *
 * 为什么值得单独一个文件：这是**客户端与宿主之间唯一的字节协议**。两处各写一遍
 * （宿主解析、客户端拼）时最容易错的是三件小事，而它们的症状都很难查：
 *   - 客户端发 `bytes=0-`（开区间）而宿主只认 `bytes=0-999` ⇒ 请求被当成非法；
 *   - 客户端发 `bytes=100-` 且文件正好 100 字节 ⇒ 起点越界，必须回 416，
 *     悄悄回一个空 200 会让 pdf.js 把「空数据」当成文件内容；
 *   - 终点超出文件尾时**必须夹到 `size-1`**，不能报错（浏览器常发 `a-` 或一个很大的终点）。
 *
 * 返回值刻意做成三态，好让调用点被迫显式处理「没有 Range」与「Range 非法」：
 *   - `null`      = 请求里没有 Range（要整段，或是一次探测）
 *   - `'invalid'` = 有 Range 但不合法（回 416）
 *   - `{start,end}` = 闭区间的合法范围（回 206）
 *
 * @param header - `Range` 头的原值（可能为 undefined）。
 * @param size - 资源总字节数。
 * @returns 见上。
 */
export function parseRange(header, size) {
  if (header === undefined || header === null || String(header).trim() === '') return null;
  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(String(header));
  if (match === null) return 'invalid';
  const spec = match[1].trim();
  // 多段范围（`bytes=0-99,200-299`）不支持：明确拒绝，而不是只取第一段 —— 只取第一段
  // 会回一个长度不对的 206，客户端按 Content-Range 拼出来的文件是坏的。
  if (spec.includes(',')) return 'invalid';

  const bounds = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (bounds === null) return 'invalid';
  const [, rawStart, rawEnd] = bounds;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  if (!Number.isFinite(size) || size <= 0) return 'invalid';

  let start;
  let end;
  if (rawStart === '') {
    // 后缀范围：`bytes=-500` = 最后 500 字节。
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
    if (start > end) return 'invalid';
    if (start >= size) return 'invalid';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

/** 拼一个闭区间的 `Range` 头（客户端与测试共用一份拼法）。 */
export function formatRange(start, end) {
  return `bytes=${start}-${end}`;
}

/** 拼 `Content-Range`（206 用带总数的那一种，416 用 `bytes *\/size` 那一种）。 */
export function contentRange(start, end, size) {
  return `bytes ${start}-${end}/${size}`;
}

export function unsatisfiedContentRange(size) {
  return `bytes */${size}`;
}

/** 按扩展名给 Content-Type —— 阅读器要靠它决定怎么渲染。 */
export const BOOK_MIME = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mobi: 'application/x-mobipocket-ebook',
  azw: 'application/vnd.amazon.ebook',
  azw3: 'application/vnd.amazon.ebook',
};

export function mimeForExtension(ext) {
  return BOOK_MIME[ext] ?? 'application/octet-stream';
}
