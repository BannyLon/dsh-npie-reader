/**
 * MOBI / AZW / AZW3 封面提取的单元测试。
 *
 * ★ 夹具是**现造的最小 PalmDB**：仓库里没有 .mobi 样本，而这张表要测的正是
 *   「封面在哪两个地方」（MOBI 头 `0x5C` 的 `firstImageIndex` + `EXTH 201` 的偏移）。
 * ★ 判据挑**错了会静默**的那几条：
 *   · EXTH 201 是 4 字节**二进制整数**，当字符串读会永远得到 -1 ⇒ 封面永不出现，
 *     而界面上只是回落成生成式封面，看不出任何异常；
 *   · 偏移算错会指到**正文 record**上 ⇒ 界面显示一张「像噪点的图」，浏览器不报错；
 *   · `0xFFFFFFFF` 是「没有图片段」的哨兵，不挡就会去 `records[4294967295]`。
 * ★ 只测「能取到」那一半是假绿：本机真实书里更常见的是「没有 201」与「指错了」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobiCoverImage } from '../src/host/ebook/mobi.js';
import { ebookCoverImage } from '../src/host/book-cover.js';

/* ---------------------------------------------------------------------------
 * 最小 PalmDB + MOBI 头 + EXTH 写入器
 * ------------------------------------------------------------------------- */

/** 1×1 PNG —— 内容无关，只要求魔数对得上。 */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
  + '0d0a2db40000000049454e44ae426082',
  'hex',
);

/** JPEG 头三个字节就够 `imageMime` 认（`FF D8 FF`）。 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);

const TEXT = Buffer.from('<html><body><h1>第一章</h1><p>正文正文正文</p></body></html>', 'utf8');

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/** EXTH 块：`entries` 是 `[[type, valueBuffer], …]`。 */
function exthBlock(entries) {
  const parts = [];
  for (const [type, value] of entries) {
    parts.push(u32(type), u32(8 + value.length), value);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([
    Buffer.from('EXTH', 'latin1'),
    u32(12 + body.length),
    u32(entries.length),
    body,
  ]);
}

/**
 * MOBI 的 record 0。
 *
 * @param {{ firstImage?: number, entries?: Array<[number, Buffer]>, kf8Boundary?: number }} options
 */
function record0({ firstImage = 2, entries = [], kf8Boundary = 0 } = {}) {
  const list = [...entries];
  // EXTH 121 = KF8 起始 record；只有真的要造双格式文件时才写（否则 `parseMobi` 会去解析它）。
  if (kf8Boundary > 0) list.push([121, u32(kf8Boundary)]);
  const exth = exthBlock(list);
  const headerLength = 0xe8;
  const buffer = Buffer.alloc(16 + headerLength + exth.length);
  buffer.write('MOBI', 16, 'latin1');
  buffer.writeUInt32BE(headerLength, 20);
  buffer.writeUInt32BE(65001, 28); // UTF-8
  buffer.writeUInt32BE(6, 36); // file version
  buffer.writeUInt32BE(0, 16 + 0x40); // first non-book
  buffer.writeUInt32BE(0, 16 + 0x44); // full name offset
  buffer.writeUInt32BE(0, 16 + 0x48); // full name length
  buffer.writeUInt32BE(firstImage >>> 0, 16 + 0x5c); // ★ 第一张图片的 record 索引
  buffer.writeUInt32BE(0x40, 16 + 0x70); // EXTH flags（0x40 = 有 EXTH）
  exth.copy(buffer, 16 + headerLength);
  return buffer;
}

/** 把若干 record 拼成一个 PalmDB 文件。 */
function palmdb(records) {
  const header = Buffer.alloc(78);
  header.write('BOOKMOBI', 60, 'latin1');
  header.writeUInt16BE(records.length, 76);
  const table = Buffer.alloc(8 * records.length);
  let offset = 78 + table.length;
  records.forEach((record, index) => {
    table.writeUInt32BE(offset, index * 8);
    offset += record.length;
  });
  return Buffer.concat([header, table, ...records]);
}

/** 最常见的形态：record 0 头 + 一段正文 + 一张封面。 */
function book({ firstImage = 2, coverOffset = 0, thumbOffset = null, image = PNG } = {}) {
  const entries = [];
  if (coverOffset !== null) entries.push([201, u32(coverOffset)]);
  if (thumbOffset !== null) entries.push([202, u32(thumbOffset)]);
  return palmdb([record0({ firstImage, entries }), TEXT, image]);
}

/* ---------------------------------------------------------------------------
 * 能取到
 * ------------------------------------------------------------------------- */

test('EXTH 201 的偏移按 4 字节整数读，能取到封面', () => {
  const cover = mobiCoverImage(book({ firstImage: 2, coverOffset: 0 }));
  assert.notEqual(cover, null, '封面没取到 —— 检查 EXTH 201 是不是被当字符串解析了');
  assert.equal(cover.mime, 'image/png');
  assert.equal(cover.bytes.toString('hex'), PNG.toString('hex'));
  assert.equal(cover.href, 'record:2');
});

test('偏移不为 0 时取的是 firstImage + offset 那一条', () => {
  // record 1 是正文、record 2 是一张装饰图、record 3 才是封面。
  const file = palmdb([record0({ firstImage: 2, entries: [[201, u32(1)]] }), TEXT, JPEG, PNG]);
  const cover = mobiCoverImage(file);
  assert.notEqual(cover, null);
  // ★ 必须断言**取到的是哪一张**：只断「非空」时，实现直接返回第一张图也照样绿。
  assert.equal(cover.bytes.toString('hex'), PNG.toString('hex'));
  assert.equal(cover.href, 'record:3');
});

test('缺 EXTH 201 时退回 EXTH 202（缩略图）', () => {
  const cover = mobiCoverImage(book({ firstImage: 2, coverOffset: null, thumbOffset: 0 }));
  assert.notEqual(cover, null, '202 这条退路没接上 —— 一批老书会全部没有封面');
  assert.equal(cover.bytes.toString('hex'), PNG.toString('hex'));
});

test('JPEG 封面也认（魔数不是只写了 PNG）', () => {
  const cover = mobiCoverImage(book({ image: JPEG }));
  assert.notEqual(cover, null);
  assert.equal(cover.mime, 'image/jpeg');
});

/* ---------------------------------------------------------------------------
 * 取不到 —— 这几种都不能抛，也不能给错图
 * ------------------------------------------------------------------------- */

test('偏移指到正文 record ⇒ null（魔数挡住，不交出噪点图）', () => {
  // firstImage 指向正文那一条：算出来的字节是 HTML，不是图。
  const file = palmdb([record0({ firstImage: 1, entries: [[201, u32(0)]] }), TEXT, PNG]);
  assert.equal(mobiCoverImage(file), null, '把压缩正文当成封面交出去了 —— 界面会显示一张花图');
});

test('firstImageIndex 是 0xFFFFFFFF（没有图片段）⇒ null，且不去取 records[4294967295]', () => {
  const file = palmdb([record0({ firstImage: 0xffffffff, entries: [[201, u32(0)]] }), TEXT, PNG]);
  assert.equal(mobiCoverImage(file), null);
});

test('firstImageIndex 越界 ⇒ null', () => {
  const file = palmdb([record0({ firstImage: 99, entries: [[201, u32(0)]] }), TEXT, PNG]);
  assert.equal(mobiCoverImage(file), null);
});

test('完全没有 EXTH（没写 201/202）⇒ null，不猜「第一张图就是封面」', () => {
  const file = palmdb([record0({ firstImage: 2, entries: [] }), TEXT, PNG]);
  assert.equal(mobiCoverImage(file), null);
});

test('不是 MOBI ⇒ null（不抛）', () => {
  assert.equal(mobiCoverImage(Buffer.from('这不是一本 MOBI，只是一段普通文本内容')), null);
  assert.equal(mobiCoverImage(Buffer.alloc(0)), null);
});

test('双格式：KF8 头里的相对索引也能取到', () => {
  // record 0 = MOBI7 头（firstImageIndex 乱写），record 1 = 正文，
  // record 2 = KF8 头（base = 2，firstImageIndex 相对它 = 1 ⇒ 绝对 3），record 3 = 封面。
  const kf8 = record0({ firstImage: 1, entries: [[201, u32(0)]] });
  const file = palmdb([
    record0({ firstImage: 0, entries: [], kf8Boundary: 2 }),
    TEXT,
    kf8,
    PNG,
  ]);
  const cover = mobiCoverImage(file);
  assert.notEqual(cover, null, 'KF8 的相对索引没被尝试 —— 双格式的 AZW3 会有一半没有封面');
  assert.equal(cover.href, 'record:3');
});

/* ---------------------------------------------------------------------------
 * 分派层
 * ------------------------------------------------------------------------- */

test('ebookCoverImage 按扩展名分派：mobi/azw/azw3 走 MOBI，epub 走 zip，其余 null', () => {
  const file = book({ firstImage: 2, coverOffset: 0 });
  for (const ext of ['mobi', 'azw', 'azw3', 'MOBI', '.azw3']) {
    assert.notEqual(ebookCoverImage(ext, file), null, `${ext} 没分派到 MOBI 解析`);
  }
  for (const ext of ['txt', 'docx', 'pdf', '', undefined]) {
    assert.equal(ebookCoverImage(ext, file), null, `${ext} 不该在这里解封面`);
  }
});
