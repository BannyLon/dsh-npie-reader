/**
 * 封面提取（EPUB）的单元测试。
 *
 * ★ 夹具是**现造的最小 EPUB**：仓库里没有 .epub 样本，而这张表要测的正是
 *   「不同 EPUB 版本把封面写在哪三个地方」。造的是 store 模式（不压缩）的 ZIP，
 *   因为 `readZip` 只读中央目录里的名、大小与本地偏移，不校验 CRC —— 压缩反而是
 *   噪音（它只影响 `read()` 走哪条解压分支，与「封面在哪」无关）。
 * ★ 四条路径一条都不能少：EPUB3 的 properties、EPUB2 的 meta、包装页里的 <img>、
 *   以及「都没有」时返回 null。**只测第一条**的话，本机那本《九三年》恰好走的是
 *   第二条，会直接落进兜底 —— 那是典型的假绿。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epubCoverImage } from '../src/host/book-cover.js';

/* ---------------------------------------------------------------------------
 * 最小 ZIP 写入器（store 模式）
 * ------------------------------------------------------------------------- */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名字
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(0, 14); // crc（readZip 不校验）
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 1×1 的 PNG —— 内容无关，只要求「是位图后缀 + 非空」。 */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
  + '0d0a2db40000000049454e44ae426082',
  'hex',
);

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function epub(opf, extra = []) {
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: opf },
    ...extra,
  ]);
}

/* ---------------------------------------------------------------------------
 * 四条路径
 * ------------------------------------------------------------------------- */

test('EPUB3：properties="cover-image" 能取到', () => {
  const book = epub(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>九三年</dc:title></metadata>
  <manifest>
    <item id="c1" href="images/deep.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="t1" href="text/part1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
</package>`, [{ name: 'OEBPS/images/deep.jpg', data: Buffer.from('fakejpeg') }]);

  const cover = epubCoverImage(book);
  assert.notEqual(cover, null);
  assert.equal(cover.mime, 'image/jpeg');
  assert.equal(cover.bytes.toString(), 'fakejpeg');
  assert.equal(cover.href, 'OEBPS/images/deep.jpg');
});

test('EPUB2：<meta name="cover" content="id"> 能取到', () => {
  const book = epub(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata><meta name="cover" content="cover-img"/></metadata>
  <manifest>
    <item id="cover-img" href="cover.png" media-type="image/png"/>
    <item id="c2" href="other.jpg" media-type="image/jpeg"/>
  </manifest>
</package>`, [
    { name: 'OEBPS/cover.png', data: PNG },
    { name: 'OEBPS/other.jpg', data: Buffer.from('notthisone') },
  ]);

  const cover = epubCoverImage(book);
  assert.notEqual(cover, null);
  // ★ 必须是 meta 指的那一张，不是「随便一张图」：两处 id 都带 cover 时，
  //   选错就会显示别的插图，而测试如果只断言「非空」照样绿。
  assert.equal(cover.bytes.toString('hex'), PNG.toString('hex'));
  assert.equal(cover.mime, 'image/png');
});

test('包装页：cover.xhtml 里的 <img> 会被追一层', () => {
  const book = epub(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata><meta name="cover" content="page"/></metadata>
  <manifest>
    <item id="page" href="cover.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
</package>`, [
    { name: 'OEBPS/cover.xhtml', data: '<html><body><img src="art/real-cover.jpg" alt=""/></body></html>' },
    { name: 'OEBPS/art/real-cover.jpg', data: Buffer.from('realcover') },
  ]);

  const cover = epubCoverImage(book);
  assert.notEqual(cover, null);
  assert.equal(cover.bytes.toString(), 'realcover');
  assert.equal(cover.href, 'OEBPS/art/real-cover.jpg');
});

test('没有任何封面线索 ⇒ null（不抛）', () => {
  const book = epub(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="t1" href="text/a.xhtml" media-type="application/xhtml+xml"/></manifest>
</package>`, [{ name: 'OEBPS/text/a.xhtml', data: '<html><body><p>正文</p></body></html>' }]);
  assert.equal(epubCoverImage(book), null);
});

test('不是 ZIP ⇒ null（不抛）', () => {
  assert.equal(epubCoverImage(Buffer.from('这不是一个 zip 文件，只是一段普通文本')), null);
});

test('封面指向的条目不存在 ⇒ null', () => {
  const book = epub(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="c1" href="missing.jpg" media-type="image/jpeg" properties="cover-image"/></manifest>
</package>`);
  assert.equal(epubCoverImage(book), null);
});
