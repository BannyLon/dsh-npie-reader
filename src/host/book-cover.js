/**
 * 书封面的提取（EPUB 一侧）。
 *
 * ★ 为什么这件事**必须有兜底**：书架索引里**没有封面字段** —— `book-source.js` 的字段
 *   表只给 filename / size / ext / path / title。所以「封面」在真机上从来只有两种可能：
 *   从书里解出来，或者界面上画一个生成式的。**没有第三种**，也没有「已有封面图」这回事。
 * ★ 为什么只做 EPUB，不做 MOBI / AZW3：那两种的封面在 MOBI 记录偏移表里，
 *   等于再写一个解析器，而它们在本机只有零星几本。返回 null，界面回落生成式封面 ——
 *   这是一句**真话**（「没解出来」），不是「这本书没有封面」。
 * ★ 也不在这里解 PDF：PDF 首页要靠 pdf.js 渲染，而 pdf.js 是**浏览器半区**的产物
 *   （`pdfjs.js` 用 `PDFDataRangeTransport` 走 Range 取字节）。宿主侧没有 canvas，
 *   在 Node 里渲染首页需要再引一套 native canvas —— 那是另一个量级的依赖。
 *   PDF 封面在客户端渲染，见 `src/client/book-cover.js`。
 *
 * 解析路径（EPUB3 / EPUB2 都要成立）：
 *   `META-INF/container.xml` → `<rootfile full-path>` → OPF →
 *   ① `<meta name="cover" content="id">`（EPUB2 的约定）
 *   ② manifest 里 `properties="cover-image"`（EPUB3 的约定）
 *   ③ manifest 里 id 或文件名带 `cover` 的图片（两者都缺时的现实兜底）
 *   → 若命中的是 `cover.xhtml` 这类**包装页**，再从它里面的 `<img src>` 追一层。
 */

import { readZip } from './ebook/zip.js';
import { resolveHref } from './ebook/epub.js';

/** 封面图体积上限：超过它的一定是「把整本书塞进了一张图」，不值得发给界面。 */
export const MAX_COVER_BYTES = 12 * 1024 * 1024;

/** 包装页最多追几层（正常只有一层：cover.xhtml → cover.jpg）。 */
const MAX_WRAP_DEPTH = 2;

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** 只认浏览器 `<img>` 能直接画的位图。SVG **刻意不收**：它常是包一层 `<image>` 的壳。 */
const DRAWABLE = new Set(Object.keys(MIME_BY_EXT));

function extOf(path) {
  const name = String(path ?? '');
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function attr(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match === null ? '' : (match[2] ?? match[3] ?? '');
}

/** 从 XML 文本里取所有同名标签（`<item ...>` 这种没有闭合内容的）。 */
function tags(xml, name) {
  return [...String(xml ?? '').matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((hit) => hit[0]);
}

/** manifest 条目：`{ id, href, type, properties }`。 */
function manifestItems(opf) {
  const block = /<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i.exec(opf)?.[1] ?? '';
  return tags(block, 'item').map((tag) => ({
    id: attr(tag, 'id'),
    href: attr(tag, 'href'),
    type: attr(tag, 'media-type').toLowerCase(),
    properties: attr(tag, 'properties').toLowerCase(),
  }));
}

/**
 * 在 manifest 里挑出封面图。
 *
 * ★ 顺序不能反：`properties="cover-image"` 是 EPUB3 的**声明**，比「文件名里带 cover」
 *   可靠得多 —— 后者会命中 `cover-thumb.jpg`、`back-cover.jpg` 这类陪衬图。
 * ★ 也**不能**只认 `<meta name="cover">`：大量 EPUB3 里没有这条 meta，
 *   只有 properties（本机那本《九三年》就是这一类）。
 */
function pickCoverItem(opf, items) {
  const meta = /<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i.exec(opf)?.[0] ?? '';
  const declaredId = attr(meta, 'content');
  if (declaredId !== '') {
    const hit = items.find((item) => item.id === declaredId);
    if (hit !== undefined) return hit;
  }
  const byProperty = items.find((item) => item.properties.split(/\s+/).includes('cover-image'));
  if (byProperty !== undefined) return byProperty;
  return items.find((item) => item.type.startsWith('image/') && /cover/i.test(`${item.id} ${item.href}`)) ?? null;
}

/** 包装页里的 `<img src>` / `<image xlink:href>`，解析成绝对条目名。 */
function imageInsideWrapper(xml, baseDir) {
  const img = /<img\b[^>]*>/i.exec(xml)?.[0] ?? '';
  const fromImg = attr(img, 'src');
  if (fromImg !== '') return resolveHref(baseDir, fromImg);
  const image = /<image\b[^>]*>/i.exec(xml)?.[0] ?? '';
  const href = attr(image, 'xlink:href') || attr(image, 'href');
  return href === '' ? '' : resolveHref(baseDir, href);
}

/**
 * 从 EPUB 字节里取出封面图。
 *
 * @param {Buffer} buffer 整本 EPUB 的字节
 * @returns {{ bytes: Buffer, mime: string, href: string } | null}
 *   解不出来一律 `null`（**不抛**）：封面是界面的装饰，不该让侧栏报错。
 */
export function epubCoverImage(buffer) {
  let zip;
  try {
    zip = readZip(buffer);
  } catch {
    return null;
  }

  const container = zip.names.find((name) => /^META-INF\/container\.xml$/i.test(name));
  let opfPath = '';
  if (container !== undefined) {
    const xml = zip.read(container)?.toString('utf8') ?? '';
    const rootfile = /<rootfile\b[^>]*>/i.exec(xml)?.[0] ?? '';
    opfPath = attr(rootfile, 'full-path');
  }
  if (opfPath === '') opfPath = zip.names.find((name) => /\.opf$/i.test(name)) ?? '';
  if (opfPath === '') return null;

  const opf = zip.read(opfPath)?.toString('utf8') ?? '';
  if (opf === '') return null;
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const items = manifestItems(opf);
  const item = pickCoverItem(opf, items);
  if (item === null || item.href === '') return null;

  let href = resolveHref(baseDir, item.href);
  for (let depth = 0; depth < MAX_WRAP_DEPTH; depth += 1) {
    const ext = extOf(href);
    if (DRAWABLE.has(ext)) break;
    // 不是位图 ⇒ 当成包装页（cover.xhtml / cover.svg），从它里面再追一层。
    const wrapper = zip.read(href)?.toString('utf8') ?? '';
    const inner = wrapper === '' ? '' : imageInsideWrapper(wrapper, href.includes('/') ? href.slice(0, href.lastIndexOf('/')) : '');
    if (inner === '') return null;
    href = inner;
  }

  const ext = extOf(href);
  if (!DRAWABLE.has(ext)) return null;

  const bytes = zip.read(href);
  if (bytes === null || bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null;
  return { bytes, mime: MIME_BY_EXT[ext], href };
}
