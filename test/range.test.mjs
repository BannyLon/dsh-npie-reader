/**
 * HTTP `Range` 解析 —— 客户端与宿主之间**唯一**的字节协议。
 *
 * ★ 本文件刻意围着「三态」写：`null`（没有 Range）/ `'invalid'`（回 416）/ `{start,end}`
 *   （回 206）。把它们合成两态（比如非法时返回 `null`）是最容易犯的错，症状是
 *   **越界请求被当成「要整段」**，于是悄悄回一个 200 全量 —— 而 pdf.js 会把那个
 *   响应当成「这就是我要的那段」，拼出来的文件是坏的，且没有任何一处报错。
 *
 * ★ 每个「合法」断言都配了一个只差一个字节的**反向对照**：`bytes=999-`（正好最后
 *   一字节，合法）对 `bytes=1000-`（起点越界，必须 416）。少了反向对照，一个
 *   「永远返回 `{start: 0, end: size-1}`」的实现也能让合法用例全绿。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOOK_MIME,
  contentRange,
  formatRange,
  mimeForExtension,
  parseRange,
  unsatisfiedContentRange,
} from '../src/range.js';

const SIZE = 1000;

describe('parseRange：没有 Range', () => {
  it('undefined / null / 空串 / 纯空白都表示「没有 Range」，返回 null', () => {
    assert.equal(parseRange(undefined, SIZE), null);
    assert.equal(parseRange(null, SIZE), null);
    assert.equal(parseRange('', SIZE), null);
    assert.equal(parseRange('   ', SIZE), null);
  });

  it('★ 反向对照：只要给了 Range 头，返回值就**不是** null（哪怕它非法）', () => {
    // 把「非法」也归成 null 的实现会在这里露馅：调用点再也分不出「要整段」和「要错段」。
    assert.equal(parseRange('bytes=-', SIZE), 'invalid');
    assert.equal(parseRange('bytes=1000-', SIZE), 'invalid');
    assert.equal(parseRange('items=0-9', SIZE), 'invalid');
  });
});

describe('parseRange：合法闭区间', () => {
  it('解析 `bytes=a-b`', () => {
    assert.deepEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=100-199', SIZE), { start: 100, end: 199 });
  });

  it('容忍空白与大小写（浏览器与手写 curl 都会带上）', () => {
    assert.deepEqual(parseRange('  Bytes = 0 - 99 ', SIZE), { start: 0, end: 99 });
    assert.deepEqual(parseRange('BYTES=5-6', SIZE), { start: 5, end: 6 });
  });

  it('开区间 `bytes=a-` 表示「从 a 到文件尾」', () => {
    assert.deepEqual(parseRange('bytes=100-', SIZE), { start: 100, end: 999 });
  });

  it('★ 边界：`bytes=999-` 正好是最后一个字节，合法（反向对照见下一个用例）', () => {
    assert.deepEqual(parseRange(`bytes=${SIZE - 1}-`, SIZE), { start: 999, end: 999 });
  });

  it('终点超出文件尾时**夹到** `size-1`，而不是报错', () => {
    // 浏览器与 pdf.js 都会发一个「很大的终点」，报错会让正常请求失败。
    assert.deepEqual(parseRange('bytes=0-999999', SIZE), { start: 0, end: 999 });
    assert.deepEqual(parseRange('bytes=999-1000', SIZE), { start: 999, end: 999 });
  });

  it('后缀范围 `bytes=-N` 取最后 N 字节', () => {
    assert.deepEqual(parseRange('bytes=-500', SIZE), { start: 500, end: 999 });
    assert.deepEqual(parseRange('bytes=-1', SIZE), { start: 999, end: 999 });
  });

  it('后缀比文件还大时取整个文件（不报错）', () => {
    assert.deepEqual(parseRange('bytes=-99999', SIZE), { start: 0, end: 999 });
    assert.deepEqual(parseRange('bytes=-1000', SIZE), { start: 0, end: 999 });
  });
});

describe('parseRange：非法（调用点必须回 416）', () => {
  it('起点越界 —— 这是最关键的一条', () => {
    // 悄悄回空 200 会让 pdf.js 把「空数据」当成文件内容，而不是「这段不存在」。
    assert.equal(parseRange('bytes=1000-', SIZE), 'invalid');
    assert.equal(parseRange('bytes=1000-2000', SIZE), 'invalid');
    assert.equal(parseRange('bytes=99999-', SIZE), 'invalid');
  });

  it('起点大于终点', () => {
    assert.equal(parseRange('bytes=500-499', SIZE), 'invalid');
    assert.equal(parseRange('bytes=999-0', SIZE), 'invalid');
  });

  it('多段范围一律拒绝，而不是只取第一段', () => {
    // 只取第一段会回一个「长度与 Content-Range 对不上」的 206，拼出来的文件是坏的。
    assert.equal(parseRange('bytes=0-99,200-299', SIZE), 'invalid');
    assert.equal(parseRange('bytes=0-99, 200-299', SIZE), 'invalid');
  });

  it('单位不是 bytes', () => {
    assert.equal(parseRange('items=0-99', SIZE), 'invalid');
    assert.equal(parseRange('0-99', SIZE), 'invalid');
  });

  it('两端都空 / 非数字 / 负号位置不对', () => {
    assert.equal(parseRange('bytes=-', SIZE), 'invalid');
    assert.equal(parseRange('bytes=abc-def', SIZE), 'invalid');
    assert.equal(parseRange('bytes=--5', SIZE), 'invalid');
    assert.equal(parseRange('bytes=-0', SIZE), 'invalid');
    assert.equal(parseRange('bytes=5--10', SIZE), 'invalid');
  });

  it('文件大小为 0 或非数时，任何 Range 都判非法（否则会算出 `end=-1`）', () => {
    assert.equal(parseRange('bytes=0-', 0), 'invalid');
    assert.equal(parseRange('bytes=-10', 0), 'invalid');
    assert.equal(parseRange('bytes=0-9', Number.NaN), 'invalid');
    assert.equal(parseRange('bytes=0-9', -1), 'invalid');
  });
});

describe('parseRange：不变式（对一批输入一律成立）', () => {
  it('凡是返回 {start,end} 的，必然 0 ≤ start ≤ end ≤ size-1', () => {
    const headers = [
      'bytes=0-0', 'bytes=0-', 'bytes=-1', 'bytes=-1000000', 'bytes=999-',
      'bytes=500-500', 'bytes=0-999999999', 'bytes=1-2',
    ];
    for (const header of headers) {
      const parsed = parseRange(header, SIZE);
      assert.notEqual(parsed, null, `${header} 应当被解析`);
      assert.notEqual(parsed, 'invalid', `${header} 应当合法`);
      assert.ok(parsed.start >= 0, `${header} start=${parsed.start}`);
      assert.ok(parsed.end >= parsed.start, `${header} ${parsed.start}-${parsed.end}`);
      assert.ok(parsed.end <= SIZE - 1, `${header} end=${parsed.end}`);
    }
  });
});

describe('头部拼法', () => {
  it('formatRange 拼出闭区间，且能被 parseRange 原样读回（同一份拼法）', () => {
    const header = formatRange(100, 199);
    assert.equal(header, 'bytes=100-199');
    assert.deepEqual(parseRange(header, SIZE), { start: 100, end: 199 });
  });

  it('206 用带总数的 Content-Range，416 用 `bytes */size`', () => {
    assert.equal(contentRange(0, 99, 1000), 'bytes 0-99/1000');
    assert.equal(contentRange(999, 999, 1000), 'bytes 999-999/1000');
    assert.equal(unsatisfiedContentRange(1000), 'bytes */1000');
  });
});

describe('mimeForExtension', () => {
  it('认识书架里出现的每一种扩展名', () => {
    assert.equal(mimeForExtension('pdf'), 'application/pdf');
    assert.equal(mimeForExtension('epub'), 'application/epub+zip');
    assert.equal(mimeForExtension('txt'), 'text/plain; charset=utf-8');
    assert.equal(mimeForExtension('azw3'), BOOK_MIME.azw3);
  });

  it('不认识的扩展名回落到 octet-stream，而不是 undefined', () => {
    // 回 undefined 会让 `res.writeHead` 静默丢掉这个头，浏览器自己嗅探 —— 对
    // 「读用户网盘里的文件」这条链路，嗅探是攻击面而不是便利。
    assert.equal(mimeForExtension('exe'), 'application/octet-stream');
    assert.equal(mimeForExtension(''), 'application/octet-stream');
    assert.equal(mimeForExtension(undefined), 'application/octet-stream');
  });
});
