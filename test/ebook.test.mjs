/**
 * 电子书解析（EPUB / MOBI / TXT）与三条路由。
 *
 * ★ 夹具全部**在测试里现造**，不从磁盘读真书：
 *   真书有版权、几十 MB、而且「跑通一本」说明不了边界（缺 nav、乱编码、
 *   尾部杂字节）。现造的好处是每一条断言都对应一个**具体的坑**，
 *   而坑是我们自己踩过的（见 `src/host/ebook/mobi.js` 里那段 PalmDOC 的说明）。
 *
 * ★ 三条必须有的反向对照：
 *   ① `<?xml …?>` 不许出现在正文里（每本 EPUB 的第一节都踩过这个）；
 *   ② 两个汉字之间的那一个空格要被删掉（源 HTML 的折行不是空格）；
 *   ③ HUFF/CDIC 必须**明确报错**，不许给一个「能打开、全是乱码」的结果。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LIBRARY_API_PREFIX } from '../src/library.js';
import { makeLibraryRoutes } from '../src/host/library-routes.js';
import { createDigestStore } from '../src/host/digest-store.js';
import { readZip } from '../src/host/ebook/zip.js';
import { parseEpub } from '../src/host/ebook/epub.js';
import { parseEbook, digestOutline, pagesOf, sectionIndex } from '../src/host/ebook/index.js';
import { splitByHeadings } from '../src/host/ebook/split.js';
import { decodeTextBuffer, looksLikeHeading, parseTxt } from '../src/host/ebook/plain.js';
import { decompressPalmDoc, parseMobi, sliceTextRecord } from '../src/host/ebook/mobi.js';

// ---- 夹具：一个最小的 ZIP（stored，无压缩）--------------------------------

/**
 * 造一份 ZIP。
 *
 * ★ 用 stored（method 0）而不是 deflate：读那一侧的 `inflateRawSync` 路径由
 *   别处（真实 EPUB）覆盖，这里要验的是**中央目录 / EOCD / 条目名**这几处。
 * ★ CRC 写 0：本项目的 reader 不校验它（校验它只会让「坏一张图」变成「整本打不开」），
 *   而写一个正确的 CRC32 需要多 30 行表驱动代码，与断言无关。
 */
function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, data]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); // stored
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

/** 一本最小的 EPUB3：两份正文 + nav 目录。 */
function epubFixture() {
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title>
    <dc:creator>某作者</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="text/ch1.xhtml">第一章 起点</a></li>
  <li><a href="text/ch2.xhtml#t2">第二章 转折</a></li>
</ol></nav></body></html>`;
  /* ★ 这一节里塞了三个坑：
       ① `<?xml …?>` 头 —— 不许进正文；
       ② 「汉字 汉字」之间的空格 —— 源 HTML 的折行，不是空格；
       ③ `&amp;` 实体 —— 要解成 `&`，不许原样留着。 */
  const ch1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
  <p class="title1">第一章 起点</p>
  <p>这是第一段，跨行
     写在同一段里。</p>
  <p>A &amp; B 的故事</p>
</body></html>`;
  const ch2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>
  <p class="title1">第二章 转折</p>
  <p>第二段。</p>
</body></html>`;
  return storedZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', container],
    ['OEBPS/content.opf', opf],
    ['OEBPS/nav.xhtml', nav],
    ['OEBPS/text/ch1.xhtml', ch1],
    ['OEBPS/text/ch2.xhtml', ch2],
  ]);
}

// ---- 夹具：一份最小的 MOBI（PalmDOC 头 + 不压缩的正文）--------------------

/**
 * 造一份 PalmDB。
 *
 * ★ `recordSize` 与「每条 record 的尾巴」是这里唯一要小心的地方：真书每条正文
 *   record 都带着几个杂字节（尾随数据），而正文长度**只由头里的 recordSize 决定**
 *   （见 `sliceTextRecord`）。夹具里让 recordSize = 4096（真书的典型值），
 *   正文远小于它 ⇒ 截断分支由单独一条用例覆盖。
 */
function mobiFixture({ compression = 1, encoding = 65001, html } = {}) {
  const text = Buffer.from(html, 'utf8');
  const recordSize = 4096;

  const record0 = Buffer.alloc(16 + 232);
  record0.writeUInt16BE(compression, 0);
  record0.writeUInt32BE(text.length, 4);
  record0.writeUInt16BE(1, 8); // recordCount
  record0.writeUInt16BE(recordSize, 10);
  record0.writeUInt16BE(0, 12); // 不加密
  record0.write('MOBI', 16, 'latin1');
  record0.writeUInt32BE(232, 20); // headerLength
  record0.writeUInt32BE(2, 24); // mobiType
  record0.writeUInt32BE(encoding, 28);
  record0.writeUInt32BE(0, 16 + 0x70); // exthFlags：没有 EXTH

  const records = [record0, text, Buffer.alloc(0)];
  const header = Buffer.alloc(78 + records.length * 8);
  header.write('test-book\0', 0, 'latin1');
  header.write('BOOK', 60, 'latin1');
  header.write('MOBI', 64, 'latin1');
  header.writeUInt16BE(records.length, 76);
  let offset = header.length;
  records.forEach((record, index) => {
    const at = 78 + index * 8;
    header.writeUInt32BE(offset, at);
    header[at + 4] = 0;
    offset += record.length;
  });
  return Buffer.concat([header, ...records]);
}

const MOBI_HTML = `<html><body>
<h1>第一章 起点</h1><p>第一段。</p>
<mbp:pagebreak/>
<h1>第二章 转折</h1><p>第二段。</p>
<mbp:pagebreak/>
<h1>第三章 收束</h1><p>第三段。</p>
<mbp:pagebreak/>
<h1>第四章 尾声</h1><p>第四段。</p>
</body></html>`;

// ---- ZIP ------------------------------------------------------------------

describe('readZip', () => {
  it('读得回条目名与内容，缺条目返回 null 而不是抛', () => {
    const zip = readZip(storedZip([['a.txt', '你好'], ['dir/b.txt', 'hello']]));
    assert.deepEqual(zip.names.sort(), ['a.txt', 'dir/b.txt']);
    assert.equal(zip.read('a.txt').toString('utf8'), '你好');
    assert.equal(zip.read('./a.txt').toString('utf8'), '你好', '前导 ./ 要被归一化掉');
    // ★ 缺一张图不该让整本书失败 —— 这里必须是 null。
    assert.equal(zip.read('missing.png'), null);
  });

  it('不是 ZIP 就明确拒绝', () => {
    assert.throws(() => readZip(Buffer.alloc(8)), error => error.code === 'NOT_ZIP');
    assert.throws(() => readZip(Buffer.from('definitely not a zip file at all')), error => error.code === 'NOT_ZIP');
  });

  it('不支持的压缩方式（method=12 bzip2）要报 ZIP_METHOD，不许当成 stored 读', () => {
    const zip = storedZip([['a.txt', 'x']]);
    // 中央目录里 method 在 +10，本地头里在 +8；两处都得改，否则读到的是 stored。
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(central > 0, '夹具里应当有中央目录');
    zip.writeUInt16LE(12, central + 10);
    const reader = readZip(zip);
    assert.throws(() => reader.read('a.txt'), error => error.code === 'ZIP_METHOD');
  });
});

// ---- EPUB -----------------------------------------------------------------

describe('parseEpub', () => {
  it('走出 metadata / spine / nav 三件套，两节两目录', () => {
    const ebook = parseEbook(epubFixture(), { ext: 'epub', fallbackTitle: '兜底名' });
    assert.equal(ebook.format, 'epub');
    assert.equal(ebook.title, '测试之书', '书名要取 OPF 里的 dc:title，而不是文件名');
    assert.equal(ebook.author, '某作者');
    assert.equal(ebook.sections.length, 2);
    assert.equal(ebook.toc.length, 2);
    // 目录条目按**文件**归节：ch2 的锚点是 #t2，但它仍指向第 2 节。
    assert.equal(ebook.toc[0].title, '第一章 起点');
    assert.equal(ebook.toc[0].section, 1);
    assert.equal(ebook.toc[1].section, 2);
    assert.equal(sectionIndex(ebook)[1].n, 2);
  });

  it('★ 三个正文坑：xml 声明不进正文、中文之间的空格被删、实体被解码', () => {
    const ebook = parseEbook(epubFixture(), { ext: 'epub' });
    const lines = ebook.sections[0].lines;
    assert.ok(!lines.join('\n').includes('<?xml'), 'xml 声明漏进正文了');
    assert.ok(!lines.join('\n').includes('version='), 'xml 声明漏进正文了');
    // 「跨行\n写在同一段里」折行不该变成空格。
    assert.ok(lines.includes('这是第一段，跨行写在同一段里。'), `中文折行处多出了空格：${JSON.stringify(lines)}`);
    assert.ok(lines.includes('A & B 的故事'), '实体没解码');
  });

  it('`<p class="title1">` 要当成标题（calibre 生成的书几乎都这么写）', () => {
    const ebook = parseEbook(epubFixture(), { ext: 'epub' });
    const kinds = ebook.sections[0].blocks.map(block => block.k);
    assert.ok(kinds.includes('h2'), `标题没认出来：${JSON.stringify(kinds)}`);
  });

  it('不是 EPUB 就报 NOT_ZIP，不许抛一个看不懂的错', () => {
    assert.throws(() => parseEpub(Buffer.from('nope')), error => error.code === 'NOT_ZIP');
  });
});

// ---- MOBI -----------------------------------------------------------------

describe('parseMobi', () => {
  it('不压缩的正文能切出四节，目录跟着走', () => {
    const ebook = parseEbook(mobiFixture({ html: MOBI_HTML }), { ext: 'mobi', fallbackTitle: '兜底' });
    assert.equal(ebook.format, 'mobi');
    assert.equal(ebook.sections.length, 4);
    assert.equal(ebook.sections[0].title, '第一章 起点');
    assert.equal(ebook.toc.length, 4);
    assert.equal(ebook.sections[0].lines[0], '第一章 起点');
  });

  it('★ HUFF/CDIC 明确报错，不给「能打开、全是乱码」的假象', () => {
    assert.throws(
      () => parseMobi(mobiFixture({ compression: 17480, html: MOBI_HTML })),
      error => error.code === 'MOBI_HUFFDIC' && /calibre/.test(error.message),
    );
  });

  it('DRM（encryption != 0）要说「去 DRM」，而不是「格式不支持」', () => {
    const buffer = mobiFixture({ html: MOBI_HTML });
    // record0 从 78 + 8 条记录表之后开始，encryption 在它的 +12。
    const record0At = buffer.readUInt32BE(78);
    buffer.writeUInt16BE(2, record0At + 12);
    assert.throws(() => parseMobi(buffer), error => error.code === 'BOOK_DRM');
  });

  it('不认识的压缩方式给出它自己的码，不与「解不开」混为一谈', () => {
    assert.throws(
      () => parseMobi(mobiFixture({ compression: 9999, html: MOBI_HTML })),
      error => error.code === 'MOBI_COMPRESSION',
    );
  });
});

describe('PalmDOC 解压与记录截断', () => {
  it('★ 0xC1–0xFF 是「空格 + 该字符」，0xC0 只是空格', () => {
    // 这是 0.25.0 修掉的 bug：只写字符不写空格 ⇒ 全书 ASCII 空格消失
    // （`<h1>第一章` 变成 `<h1第一章`、`height="e"` 之类，而汉字全都正常，
    //   所以第一眼看上去很像「这本书的 HTML 写得糙」）。
    const out = decompressPalmDoc(Buffer.from([0x41, 0xc1, 0xc2, 0xc0, 0x42]));
    assert.equal(out.toString('latin1'), 'A A B B');
  });

  it('可打印 ASCII 原样通过', () => {
    // ★ 只拿 ASCII 做这条：PalmDOC 里 0x80–0xBF 是 LZ77 的「距离」字节、
    //   0xC0–0xFF 是「空格 + 字符」，所以 **UTF-8 的汉字字节进来会被当成指令**
    //   （真书里它们是先被 0x01–0x08 的字面量序列包着的）。拿中文当字面量测
    //   会得到一个「测试说不通、代码其实对」的假失败。
    const source = Buffer.from('hello world, plain ascii!', 'latin1');
    assert.equal(decompressPalmDoc(source).toString('latin1'), 'hello world, plain ascii!');
  });

  it('★ 每条 record 只取前 recordSize 字节（尾巴是杂字节，不是正文）', () => {
    const record = Buffer.from('0123456789ABCDEF');
    assert.equal(sliceTextRecord(record, 4).toString('latin1'), '0123');
    // 短于 recordSize 时**原样返回**：多截一位就会吃掉正文。
    assert.equal(sliceTextRecord(Buffer.from('ab'), 4).toString('latin1'), 'ab');
    assert.equal(sliceTextRecord(Buffer.from('ab'), 0).toString('latin1'), 'ab', 'recordSize 为 0 时不许全截掉');
  });
});

// ---- TXT ------------------------------------------------------------------

describe('TXT 编码与切章', () => {
  it('GB18030 的字节要按 GB18030 读出来，而不是一整本乱码', () => {
    // 「第一章 你好」的 GB2312 字节（已用 TextDecoder("gb18030") 反查确认）。
    const bytes = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xc4, 0xe3, 0xba, 0xc3]);
    const { encoding, text } = decodeTextBuffer(bytes);
    assert.equal(encoding, 'gb18030');
    assert.equal(text, '第一章 你好');
  });

  it('UTF-8 有 BOM 就走 BOM，且 BOM 不进正文', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一章 起点', 'utf8')]);
    const { encoding, text } = decodeTextBuffer(bytes);
    assert.equal(encoding, 'utf-8');
    assert.equal(text, '第一章 起点');
  });

  it('按章节标记切开，标题进正文首行（分段算法靠这一行反查章节）', () => {
    const text = ['第一章 起点', '正文一。', '', '第二章 转折', '正文二。'].join('\n');
    const ebook = parseEbook(Buffer.from(text, 'utf8'), { ext: 'txt', fallbackTitle: '人间喜剧' });
    assert.equal(ebook.format, 'txt');
    assert.equal(ebook.sections.length, 2);
    assert.equal(ebook.sections[0].title, '第一章 起点');
    assert.equal(ebook.sections[0].lines[0], '第一章 起点');
    assert.equal(ebook.title, '人间喜剧', 'TXT 没有元数据，书名走 fallback');
  });

  it('没有章节标记 ⇒ 如实叫「第 N 节」，并记一条 warning', () => {
    const text = Array.from({ length: 400 }, (_, i) => `第 ${i} 行的一点字。`).join('\n');
    const ebook = parseEbook(Buffer.from(text, 'utf8'), { ext: 'txt' });
    assert.ok(ebook.sections.length >= 1);
    assert.match(ebook.sections[0].title, /^第 1 节$/);
    assert.ok(ebook.warnings.some(item => item.includes('没有章节标记')), '缺章结构要如实说');
  });

  it('空文件报 TXT_EMPTY，不是「0 节但正常」', () => {
    assert.throws(() => parseTxt(Buffer.from('')), error => error.code === 'TXT_EMPTY');
  });

  it('looksLikeHeading 的正反两向', () => {
    for (const yes of ['第一章 起点', '第十二回 落水', '楔子', 'Chapter 3', '尾声']) {
      assert.equal(looksLikeHeading(yes), true, `${yes} 应当算标题`);
    }
    for (const no of ['他走到窗边，看见外面下雨了。', '', '第'.repeat(60)]) {
      assert.equal(looksLikeHeading(no), false, `${no} 不应当算标题`);
    }
  });
});

// ---- 归一 / 解读目录 -------------------------------------------------------

describe('parseEbook 的归一与解读目录', () => {
  it('★ 空节不单独占一页：并进下一页，块一个不少（页号由切分统一重算，不存在偏移）', () => {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`;
    const opf = `<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
<manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`;
    const empty = `<?xml version="1.0"?><html><body><p>   </p></body></html>`;
    const full = `<?xml version="1.0"?><html><body><p>有字的一节。</p></body></html>`;
    const ebook = parseEbook(storedZip([
      ['META-INF/container.xml', container], ['c.opf', opf],
      ['a.xhtml', empty], ['b.xhtml', full],
    ]), { ext: 'epub' });
    // 空封面页不单独成页：翻过去是一张白纸，纸质书不会这么装订。
    assert.equal(ebook.sections.length, 1, '空节又单独占了一页');
    assert.equal(ebook.sections[0].empty, false);
    assert.equal(ebook.sections[0].blocks.length, 1, '空节那份内容把下一页的块挤掉了');
  });

  it('pagesOf 每个节一页，页码 = 节号（解读链直接复用 PDF 那条路）', () => {
    const ebook = parseEbook(epubFixture(), { ext: 'epub' });
    const pages = pagesOf(ebook);
    assert.deepEqual(pages.map(page => page.page), [1, 2]);
    assert.deepEqual(pages[0].lines, ebook.sections[0].lines);
  });

  it('digestOutline 把过短的节并进相邻节，避免「200 节 = 200 次模型调用」', () => {
    const ebook = {
      sections: [
        { title: 'A', chars: 200, lines: [], blocks: [] },
        { title: 'B', chars: 200, lines: [], blocks: [] },
        { title: 'C', chars: 2000, lines: [], blocks: [] },
      ],
    };
    const outline = digestOutline(ebook, { minChapterChars: 1500 });
    // 前两节合起来 400 < 1500 ⇒ 并入第三节，最终只剩一章 ⇒ 交给 segment 走页窗。
    assert.deepEqual(outline, []);
    const split = digestOutline(
      { sections: [...ebook.sections, { title: 'D', chars: 3000, lines: [], blocks: [] }] },
      { minChapterChars: 1500 },
    );
    assert.equal(split.length, 2);
    assert.equal(split[0].page, 1, '合并后仍从第一节开始');
  });
});

// ---- 按正文标题切成「一页一节」 --------------------------------------------

describe('splitByHeadings', () => {
  const p = n => ({ k: 'p', x: '字'.repeat(n) });
  const doc = (title, blocks) => ({ title, blocks, lines: [], chars: 0, empty: false });

  it('一节里的每个小标题各起一页，块一个不丢、顺序不变', () => {
    const blocks = [{ k: 'h2', x: '第一卷 甲' }, { k: 'h3', x: '一、子' }, p(200), { k: 'h3', x: '二、丑' }, p(300)];
    const { sections, toc } = splitByHeadings(
      [doc('第一卷 甲', blocks)],
      [{ title: '第一卷 甲', section: 1 }, { title: '二、丑', section: 1 }],
    );
    // 卷标题页（只有 h2）并进第一节那页，于是第一页的标题是卷名。
    assert.deepEqual(sections.map(s => s.title), ['第一卷 甲', '二、丑']);
    assert.deepEqual(sections.flatMap(s => s.blocks), blocks, '块被丢、被重排或内容被改了');
    assert.deepEqual(toc.map(item => item.section), [1, 2], '第二条目录没落到「二、丑」那页');
  });

  it('★ 目录里的重名条目各自落到自己那一节，不许被去重吃掉', () => {
    const one = [p(300), { k: 'h3', x: '本卷注释' }, p(50)];
    const two = [p(300), { k: 'h3', x: '本卷注释' }, p(50)];
    const { toc } = splitByHeadings(
      [doc('第一卷 甲', [{ k: 'h2', x: '第一卷 甲' }, ...one]), doc('第二卷 乙', [{ k: 'h2', x: '第二卷 乙' }, ...two])],
      [
        { title: '第一卷 甲', section: 1 }, { title: '本卷注释', section: 1 },
        { title: '第二卷 乙', section: 2 }, { title: '本卷注释', section: 2 },
      ],
    );
    assert.equal(toc.length, 4, '重名条目被合并掉了 —— 目录里会凭空少一行');
    const notes = toc.filter(item => item.title === '本卷注释');
    assert.equal(notes[0].section, 2);
    assert.equal(notes[1].section, 4, '第二条「本卷注释」被指到了第一卷那页');
  });

  it('正文标题带脚注编号时，目录条目仍然能对上', () => {
    const blocks = [{ k: 'h3', x: '四、TORMENTUM BELLI〔26〕' }, p(400)];
    const { toc } = splitByHeadings(
      [doc('甲', blocks)],
      [{ title: '四、TORMENTUM BELLI', section: 1 }],
    );
    assert.equal(toc[0].section, 1);
    assert.equal(toc[0].title, '四、TORMENTUM BELLI', '目录条目应当保持书里写的原文');
  });

  it('卷标题页并到正文页顶部；带正文块的「第 X 部」扉页自己留一页', () => {
    const { sections } = splitByHeadings([
      doc('第一部 在海上', [{ k: 'h2', x: '第一部 在海上' }, { k: 'p', x: 'spec' }]),
      doc('第一卷 甲', [{ k: 'h2', x: '第一卷 甲' }, { k: 'h3', x: '一、子' }, p(400)]),
    ], []);
    assert.deepEqual(sections.map(s => s.title), ['第一部 在海上', '第一卷 甲']);
    assert.equal(sections[1].chars > 400, true, '卷标题页没有被并进正文页');
  });

  it('没有标题的书原样返回，不硬切', () => {
    const blocks = [p(100), p(100)];
    const { sections } = splitByHeadings([doc('甲', blocks)], [{ title: '甲', section: 1 }]);
    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0].blocks, blocks);
  });

  it('层级：结构标题 depth 0，小节 depth 1', () => {
    const { toc } = splitByHeadings(
      [doc('第一卷 甲', [{ k: 'h2', x: '第一卷 甲' }, { k: 'h3', x: '一、子' }, p(400)])],
      [{ title: '第一卷 甲', section: 1 }, { title: '一、子', section: 1 }],
    );
    assert.deepEqual(toc.map(item => item.depth), [0, 1]);
  });

  it('★ 真 EPUB：一个 XHTML 装一整卷时，按目录拆成多页且条目不丢', () => {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>`;
    const opf = `<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
<manifest><item id="a" href="a.xhtml" properties="nav"/><item id="b" href="b.xhtml"/></manifest>
<spine><itemref idref="b"/></spine></package>`;
    const nav = `<?xml version="1.0"?><html><body><nav epub:type="toc"><ol>
<a href="b.xhtml">第三卷 阿尔马洛</a><a href="b.xhtml#s1">一、起点</a><a href="b.xhtml#s2">二、路上</a>
</ol></nav></body></html>`;
    const body = `<?xml version="1.0"?><html><body>
<h2>第三卷 阿尔马洛</h2><h3>一、起点</h3><p>${'甲'.repeat(200)}</p><h3>二、路上</h3><p>${'乙'.repeat(200)}</p>
</body></html>`;
    const ebook = parseEbook(storedZip([
      ['META-INF/container.xml', container], ['c.opf', opf], ['a.xhtml', nav], ['b.xhtml', body],
    ]), { ext: 'epub' });
    // 卷标题页并进「一、起点」那页，于是两页；三条目录一条不丢。
    assert.equal(ebook.sections.length, 2, '一个 XHTML 里的三个标题没有拆成两页');
    assert.deepEqual(ebook.toc.map(item => item.section), [1, 1, 2]);
    // ★ 缓存版本快照。0.62.0 把「语种」算进解析结果（`script`）⇒ 形状变了，
    //   `EBOOK_CACHE_VERSION` 2 → 3。这条断言就是「改了形状必须记得抬版本」的
    //   提醒物：抬了版本却忘了改这里的字面量，它就会红。
    assert.equal(ebook.v, 3, '缓存版本没跟着变 —— 老缓存会被继续用');
    assert.deepEqual(ebook.toc.map(item => item.depth), [0, 1, 1], '目录层级没算对');
  });
});

// ---- 三条路由 --------------------------------------------------------------

const API = LIBRARY_API_PREFIX;
const BOOK = { id: 'l-ebook', ext: 'epub', size: 1024, title: '测试之书', source: 'local', panPath: '' };

function fakeReq({ url, method = 'GET', headers = {}, body } = {}) {
  const req = {
    url,
    method,
    headers: { host: '127.0.0.1:52431', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
  req[Symbol.asyncIterator] = async function* iterate() {
    if (body !== undefined) yield Buffer.from(body);
  };
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk, done) { this.chunks.push(Buffer.from(chunk)); if (typeof done === 'function') done(); return true; },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
      this.ended = true;
      return this;
    },
    destroy() { return this; },
    on() { return this; },
    get body() { return Buffer.concat(this.chunks); },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

describe('电子书路由', () => {
  let root = '';
  let api = null;
  let ebook = null;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'npie-ebook-routes-'));
    ebook = parseEbook(epubFixture(), { ext: 'epub' });
    const routes = makeLibraryRoutes({
      listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
      bookById: id => (id === BOOK.id ? BOOK : undefined),
      readBytes: async () => Buffer.alloc(0),
      getStates: () => ({}),
      setState: () => ({}),
      reload: async () => {},
      vendorRoot: '/nonexistent',
      digestStore: createDigestStore({ rootDir: root }),
      // 夹具不真解压：这里要验的是路由的形状、状态码与落盘结果。
      ebookOf: async (book) => {
        if (book.ext === 'epub') return ebook;
        const error = new Error('这本 Kindle 书用了 HUFF/CDIC 压缩');
        error.code = 'MOBI_HUFFDIC';
        throw error;
      },
    });
    api = routes[0];
  });

  after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const call = async (path, init) => {
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${API}${path}`, ...init }), res);
    return res;
  };

  it('GET /book/:id/ebook 只回索引，不回正文', async () => {
    const res = await call(`/book/${BOOK.id}/ebook`);
    assert.equal(res.status, 200);
    assert.equal(res.json.format, 'epub');
    assert.equal(res.json.sections.length, 2);
    assert.equal(res.json.sections[0].n, 1);
    assert.equal(res.json.sections[0].blocks, undefined, '索引里不许带正文块（一本 25 万字的书会到 MB 级）');
    assert.equal(res.json.toc.length, 2);
  });

  it('GET /book/:id/ebook/section/:n 回块模型（渲染端用 React 元素重建它）', async () => {
    const res = await call(`/book/${BOOK.id}/ebook/section/1`);
    assert.equal(res.status, 200);
    assert.equal(res.json.n, 1);
    assert.ok(Array.isArray(res.json.blocks) && res.json.blocks.length > 0);
    assert.ok(res.json.blocks.every(block => typeof block.k === 'string' && typeof block.x === 'string'));
  });

  it('越界的节号是 404，不是空正文', async () => {
    const res = await call(`/book/${BOOK.id}/ebook/section/99`);
    assert.equal(res.status, 404);
    assert.match(res.json.error, /第 99 节/);
  });

  it('格式解不开 ⇒ 415 + 宿主那句人话（前端直接把 error 显示给用户）', async () => {
    const mobiRes = fakeRes();
    const failing = makeLibraryRoutes({
      listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
      bookById: () => ({ ...BOOK, ext: 'azw3' }),
      readBytes: async () => Buffer.alloc(0),
      getStates: () => ({}),
      setState: () => ({}),
      reload: async () => {},
      vendorRoot: '/nonexistent',
      ebookOf: async () => {
        const error = new Error('这本 Kindle 书用了 HUFF/CDIC 压缩，当前版本还解不开。');
        error.code = 'MOBI_HUFFDIC';
        throw error;
      },
    })[0];
    await failing.handler(fakeReq({ url: `${API}/book/${BOOK.id}/ebook` }), mobiRes);
    assert.equal(mobiRes.status, 415, '解不开的压缩方式不是「服务器错误」，是「这个文件读不了」');
    assert.match(mobiRes.json.error, /HUFF/);
  });

  it('POST /digest/:id/ebook 一步落盘 + 分段，meta.mode 是 ebook', async () => {
    const res = await call(`/digest/${BOOK.id}/ebook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:52431' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.format, 'epub');
    assert.ok(res.json.sections >= 2);
    const status = await call(`/digest/${BOOK.id}/status`);
    assert.equal(status.json.meta.mode, 'ebook', '分段方式要如实标成 ebook，面板据此换文案');
    assert.ok(status.json.meta.chapters.length >= 1);
  });

  it('没有 ebookOf 的夹具退化成 501（而不是整个 handler 挂掉）', async () => {
    const res = fakeRes();
    const bare = makeLibraryRoutes({
      listBooks: async () => ({ path: '/x', books: [], skipped: 0, missing: false, error: '', bytes: 0 }),
      bookById: () => BOOK,
      readBytes: async () => Buffer.alloc(0),
      getStates: () => ({}),
      setState: () => ({}),
      reload: async () => {},
      vendorRoot: '/nonexistent',
    })[0];
    await bare.handler(fakeReq({ url: `${API}/book/${BOOK.id}/ebook` }), res);
    assert.equal(res.status, 501);
  });
});
