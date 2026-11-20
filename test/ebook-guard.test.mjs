/**
 * 电子书解析的两条防护：MOBI 正文校验、EPUB DRM 前置判定。
 *
 * ★ 夹具全部现造，不从磁盘读真书：要验的是**坏头 / 乱码容器**这类边界，
 *   真书里碰不到，而且「跑通一本」说明不了任何判据。
 *
 * ★ 三条必须有的反向对照（少了任何一条都算假绿）：
 *   ① 正常中文 MOBI / EPUB 不许被误伤；
 *   ② 只带字体混淆的 EPUB **必须照常打开**（见到 encryption.xml 就判 DRM 是误伤）；
 *   ③ 坏值小得离谱时必须**不裁剪**，而不是「截成 100 字节还看起来正常」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEpub, analyzeEncryption } from '../src/host/ebook/epub.js';
import { parseMobi, looksLikeBinary, trustTextLength } from '../src/host/ebook/mobi.js';

// ---- 夹具 ------------------------------------------------------------------

/** 最小 ZIP（stored），与 ebook.test.mjs 同口径：验的是目录结构不是 deflate。 */
function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, data]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试之书</dc:title></metadata>
  <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
const CHAPTER = '<html><body><h1>第一章</h1><p>这是一段正常的中文正文，用来确认解析器仍然能把文字抽出来。</p></body></html>';

/** @param extra 追加/覆盖的条目，用来塞 encryption.xml 或替换 container。 */
function epubFixture(extra = []) {
  const files = new Map([
    ['META-INF/container.xml', CONTAINER],
    ['OEBPS/content.opf', OPF],
    ['OEBPS/ch1.xhtml', CHAPTER],
  ]);
  for (const [name, content] of extra) files.set(name, content);
  return storedZip([...files]);
}

/**
 * 最小 PalmDB：record 0 = PalmDOC 头(16B) + MOBI 头，record 1 = 正文。
 * `compression` 1 = 不压缩，2 = PalmDOC（纯 ASCII 文本自身就是合法 LZ77 流）。
 */
function mobiFixture({ body, textLength, compression = 1 }) {
  const record0 = Buffer.alloc(16 + 264);
  record0.write('MOBI', 16, 'latin1');
  record0.writeUInt32BE(232, 20);      // MOBI headerLength
  record0.writeUInt32BE(65001, 28);    // encoding = UTF-8
  record0.writeUInt16BE(compression, 0);
  record0.writeUInt32BE(textLength, 4);
  record0.writeUInt16BE(1, 8);         // recordCount
  record0.writeUInt16BE(4096, 10);     // recordSize
  record0.writeUInt16BE(0, 12);        // encryption = none
  const header = Buffer.alloc(78 + 2 * 8);
  header.writeUInt16BE(2, 76);
  const dataStart = header.length;
  header.writeUInt32BE(dataStart, 78);
  header.writeUInt32BE(dataStart + record0.length, 86);
  return Buffer.concat([header, record0, body]);
}

const NORMAL_HTML = '<html><body><h1>第一章</h1><p>这是正常中文正文的前半句，用来确认没有误伤。</p>'
  + '<p>这是正常中文正文的后半句，坏值截断时这一句会整段消失。</p></body></html>';

// ---- MOBI：两个纯函数 --------------------------------------------------------

describe('MOBI 正文防护 · 纯函数', () => {
  it('中文 UTF-8 正文不是二进制（防误伤）', () => {
    assert.equal(looksLikeBinary(Buffer.from(NORMAL_HTML, 'utf8')), false);
    assert.equal(looksLikeBinary(Buffer.from('<p>汉字　全角空格　\t\n\r</p>', 'utf8')), false);
  });

  it('已知二进制头一律拦下', () => {
    for (const magic of [
      [0xff, 0xd8, 0xff, 0xe0],       // JPEG
      [0x89, 0x50, 0x4e, 0x47],       // PNG
      [0x47, 0x49, 0x46, 0x38],       // GIF
      [0x25, 0x50, 0x44, 0x46],       // PDF
      [0x50, 0x4b, 0x03, 0x04],       // ZIP
    ]) {
      assert.equal(looksLikeBinary(Buffer.from([...magic, 0, 0, 0, 0])), true);
    }
  });

  it('控制字符占比 >10% 兜底，但 \t\n\r 不算', () => {
    assert.equal(looksLikeBinary(Buffer.concat([Buffer.from('<p>abc'), Buffer.alloc(100, 0)])), true);
    assert.equal(looksLikeBinary(Buffer.from(`<p>${'\n'.repeat(200)}abc</p>`, 'utf8')), false);
  });

  it('textLength 只有同量级才采信', () => {
    assert.equal(trustTextLength(0, 1000), false);
    assert.equal(trustTextLength(1001, 1000), false);   // 垃圾大值
    assert.equal(trustTextLength(100, 1000), false);    // 垃圾小值（最危险）
    assert.equal(trustTextLength(499, 1000), false);
    assert.equal(trustTextLength(500, 1000), true);     // 0.5 边界
    assert.equal(trustTextLength(980, 1000), true);     // 正常 2% 偏差
    assert.equal(trustTextLength(1000, 1000), true);
    assert.equal(trustTextLength(NaN, 1000), false);
  });
});

// ---- MOBI：端到端 ------------------------------------------------------------

describe('MOBI 正文防护 · 解析链路', () => {
  it('正常书照常打开，正文逐字在', () => {
    const body = Buffer.from(NORMAL_HTML, 'utf8');
    const book = parseMobi(mobiFixture({ body, textLength: body.length }));
    const text = book.sections.map(s => s.lines.join('')).join('');
    assert.ok(text.includes('正常中文正文的前半句'));
    assert.ok(text.includes('正常中文正文的后半句'));
  });

  it('PalmDOC 压缩分支同样不被误伤', () => {
    // 纯 ASCII 是合法的 PalmDOC LZ77 流（0x09–0x7F 为字面字节）。
    const body = Buffer.from('<h1>Chapter One</h1><p>Plain ASCII text goes here.</p>', 'ascii');
    const book = parseMobi(mobiFixture({ body, textLength: body.length, compression: 2 }));
    assert.ok(book.sections.map(s => s.lines.join('')).join('').includes('Plain ASCII text'));
  });

  it('声明 918MB、正文其实是一整张 JPEG ⇒ 明确报 MOBI_BINARY，不许入库', () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(6000, 0)]);
    assert.throws(
      () => parseMobi(mobiFixture({ body, textLength: 962700290 })),
      error => error.code === 'MOBI_BINARY' && /不是文字/.test(error.message),
    );
  });

  it('textLength 是垃圾小值时**不裁剪**：正文与正常书逐字相同', () => {
    const body = Buffer.from(NORMAL_HTML, 'utf8');
    const plain = book => book.sections.map(s => s.lines.join('')).join('');
    const good = plain(parseMobi(mobiFixture({ body, textLength: body.length })));
    const bad = plain(parseMobi(mobiFixture({ body, textLength: 100 })));
    // ★ 两条 fixture 只差一个声明值 ⇒ 抽出的正文必须逐字相同。
    //   用「字数 > N」当判据会随块模型的抽字规则漂移（这里误报过一次）。
    assert.equal(bad, good, '坏值把正文截短了 —— 它会被当成一次正常解析');
    assert.ok(bad.includes('后半句'), '后半句消失 = 坏值被无条件采信');
    assert.ok(good.includes('后半句'));
  });
});

// ---- EPUB：DRM ---------------------------------------------------------------

const FONT_ONLY_XML = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></enc:EncryptedData>
</encryption>`;
const ADOBE_FONT_XML = '<encryption><EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/></encryption>';
const REAL_DRM_XML = `<?xml version="1.0"?>
<encryption xmlns:enc="urn:oasis:names:tc:opendocument:xmlns:container">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="RSA" Version="1.0"/>
    <zy:KeyInfo><Proprietary>ZhangYue.Inc</Proprietary></zy:KeyInfo>
  </enc:EncryptedData>
</encryption>`;

describe('EPUB DRM · analyzeEncryption', () => {
  it('字体混淆不是 DRM', () => {
    assert.deepEqual(analyzeEncryption(FONT_ONLY_XML), { drm: false, vendor: '' });
    assert.deepEqual(analyzeEncryption(ADOBE_FONT_XML), { drm: false, vendor: '' });
  });

  it('真 DRM 取到厂商；ADEPT 有兜底名', () => {
    assert.deepEqual(analyzeEncryption(REAL_DRM_XML), { drm: true, vendor: 'ZhangYue.Inc' });
    assert.equal(analyzeEncryption('<EncryptionMethod Algorithm="AdobeADEPT"/>').vendor, 'Adobe ADEPT');
  });

  it('空 / 无算法声明的 XML 不判 DRM', () => {
    assert.deepEqual(analyzeEncryption(''), { drm: false, vendor: '' });
    assert.deepEqual(analyzeEncryption('<encryption></encryption>'), { drm: false, vendor: '' });
  });
});

describe('EPUB DRM · 解析链路', () => {
  it('正常 EPUB 照常打开', () => {
    const book = parseEpub(epubFixture());
    assert.equal(book.title, '测试之书');
    assert.ok(book.sections.length >= 1);
  });

  it('只带字体混淆的 EPUB **必须照常打开**（不能误伤）', () => {
    const book = parseEpub(epubFixture([['META-INF/encryption.xml', FONT_ONLY_XML]]));
    assert.ok(book.sections.length >= 1, '被误判成 DRM 了');
  });

  it('真 DRM：container 也是乱码时仍先报 DRM，且明说书没损坏', () => {
    const noise = Buffer.from([0x8f, 0x3c, 0x91, 0x00, 0xf2, 0x6a, 0x1e, 0x77]);
    assert.throws(
      () => parseEpub(epubFixture([
        ['META-INF/encryption.xml', REAL_DRM_XML],
        ['META-INF/container.xml', noise],
      ])),
      (error) => error.code === 'EPUB_DRM'
        && /DRM/.test(error.message)
        && /ZhangYue\.Inc/.test(error.message)
        && /没有损坏/.test(error.message)
        && !/重新下载/.test(error.message),
    );
  });

  it('容器三种失败各说各的，不混成一句 EPUB_NO_OPF', () => {
    const missing = new Map([
      ['OEBPS/content.opf', OPF],
      ['OEBPS/ch1.xhtml', CHAPTER],
    ]);
    assert.throws(() => parseEpub(storedZip([...missing])), e => e.code === 'EPUB_NO_CONTAINER');

    const noise = Buffer.from([0x8f, 0x3c, 0x91, 0x00, 0xf2, 0x6a, 0x1e, 0x77]);
    assert.throws(
      () => parseEpub(epubFixture([['META-INF/container.xml', noise]])),
      e => e.code === 'EPUB_BAD_CONTAINER' && /不是有效 XML/.test(e.message),
    );

    assert.throws(
      () => parseEpub(epubFixture([['META-INF/container.xml', '<?xml version="1.0"?><container></container>']])),
      e => e.code === 'EPUB_NO_OPF' && /没有 rootfile/.test(e.message),
    );
  });
});
