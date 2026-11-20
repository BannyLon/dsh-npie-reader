/**
 * EPUB 解析：ZIP → `container.xml` → OPF（manifest / spine / metadata）→ 各章 XHTML。
 *
 * 目录三级降级：
 *   1. EPUB3 的 `nav.xhtml`（`<nav epub:type="toc">`）；
 *   2. EPUB2 的 `toc.ncx`（`<navPoint>`，可嵌套，展平后按文档顺序）；
 *   3. 都没有 ⇒ 用每节第一个标题当节名（`titleFromBlocks`），再不行「第 N 节」。
 *
 * ★ 目录条目与 spine 的对应靠**文件名**，不靠锚点：`text/part0007.html#c3` 与
 *   `text/part0007.html` 是同一节。按锚点分节会把「一章被切成多个锚点」的书
 *   切成许多几百字的碎片。
 * ★ spine 里的 `linear="no"` 条目（封面、广告页、索引）**照样读**，但会标 `linear:false`：
 *   不读的话，封面之后的第一节会变成正文的「第 1 节」，用户点到目录第一项时对不上。
 */
import { htmlToBlocks, blocksToLines, decodeEntities, normalizeWhitespace, titleFromBlocks } from './markup.js';
import { readZip } from './zip.js';

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 章节 XHTML 的体积上限：超过它的多半是「整本书被塞进一个文件」，仍然读，但会报一句。 */
export const MAX_SECTION_HTML = 8 * 1024 * 1024;

/** 这一节最多保留多少行（给分段算法用；真实一章很少超过 3000 行）。 */
const MAX_SECTION_LINES = 20_000;

/** 相对路径解析（OPF 里的 href 相对于 OPF 自己所在的目录）。 */
export function resolveHref(baseDir, href) {
  const clean = String(href ?? '').split('#')[0].trim();
  if (clean === '') return '';
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* 百分号编码坏了就按原样 */ }
  const parts = `${baseDir === '' ? '' : `${baseDir}/`}${decoded}`.split('/');
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** 目录所在的目录名（`OEBPS/content.opf` → `OEBPS`）。 */
function dirOf(path) {
  const at = String(path ?? '').lastIndexOf('/');
  return at < 0 ? '' : String(path).slice(0, at);
}

/** 从 XML 里取第一个匹配标签的文本。 */
function tagText(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match === null ? '' : normalizeWhitespace(decodeEntities(match[1].replace(/<[^>]+>/g, ' ')));
}

/** 解析 `<meta name="cover" content="id">`、`<dc:creator>` 等最小元数据。 */
function parseMetadata(opf) {
  const metadata = /<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i.exec(opf)?.[1] ?? '';
  const creator = /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(metadata);
  return {
    title: tagText(metadata, 'dc:title'),
    author: creator === null ? '' : normalizeWhitespace(decodeEntities(creator[1].replace(/<[^>]+>/g, ' '))),
    language: tagText(metadata, 'dc:language'),
  };
}

/** manifest：`id → { href, type }`。 */
function parseManifest(opf) {
  const manifest = /<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i.exec(opf)?.[1] ?? '';
  const items = new Map();
  for (const match of manifest.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attrs = match[1];
    const id = /\bid\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\bid\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ?? '';
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\bhref\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ?? '';
    const type = /\bmedia-type\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '';
    const properties = /\bproperties\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '';
    if (id === '' || href === '') continue;
    items.set(id, { href, type, properties });
  }
  return items;
}

/** spine：按阅读顺序的 `[{ idref, linear }]`。 */
function parseSpine(opf) {
  const spine = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf)?.[1] ?? '';
  const out = [];
  for (const match of spine.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const attrs = match[1];
    const idref = /\bidref\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\bidref\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ?? '';
    if (idref === '') continue;
    out.push({ idref, linear: !/\blinear\s*=\s*"no"/i.test(attrs) });
  }
  return out;
}

/** EPUB3 nav：`<nav epub:type="toc">` 里的 `<a>`，按出现顺序。 */
function parseNav(navHtml, baseDir) {
  const nav = /<nav\b[^>]*(?:epub:type\s*=\s*"toc"|role\s*=\s*"doc-toc")[^>]*>([\s\S]*?)<\/nav>/i.exec(navHtml);
  const body = nav?.[1] ?? navHtml;
  const out = [];
  for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(match[1])?.[1] ?? /\bhref\s*=\s*'([^']*)'/i.exec(match[1])?.[1] ?? '';
    const title = normalizeWhitespace(match[2].replace(/<[^>]+>/g, ' '));
    if (href === '' || title === '') continue;
    out.push({ title, file: resolveHref(baseDir, href) });
  }
  return out;
}

/** EPUB2 NCX：`<navPoint>` 按文档顺序展平（父条目在前、子条目紧随）。 */
function parseNcx(ncxXml, baseDir) {
  const out = [];
  for (const match of ncxXml.matchAll(/<navPoint\b[\s\S]*?<\/navPoint>/gi)) {
    const block = match[0];
    const title = /<navLabel\b[^>]*>([\s\S]*?)<\/navLabel>/i.exec(block)?.[1] ?? '';
    const src = /<content\b[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(block)?.[1] ?? '';
    const clean = normalizeWhitespace(decodeEntities(title.replace(/<[^>]+>/g, ' ')));
    if (clean === '' || src === '') continue;
    out.push({ title: clean, file: resolveHref(baseDir, src) });
  }
  return out;
}

/**
 * 字体混淆用的加密算法 —— 这两个是**无害**的。
 *
 * EPUB 允许对嵌入字体做混淆（防止字体被直接拿去用），它会在 `encryption.xml` 里
 * 声明加密，但正文与 `container.xml` 都是明文。实测 1190 本里 7 本带这个文件，
 * 全部属于此类且都能正常解析 ⇒ **见到 encryption.xml 就判 DRM 会误伤真能读的书**。
 */
const FONT_OBFUSCATION_ALGORITHMS = [
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
];

/**
 * 分析 `META-INF/encryption.xml`：是不是真的 DRM，以及厂商是谁。
 *
 * 判据：出现任何一个**不属于字体混淆**的 `EncryptionMethod` 算法即为 DRM；
 * 厂商优先取 `<Proprietary>`（掌阅一类），ADEPT 兜底给个能看懂的名字。
 */
export function analyzeEncryption(xml) {
  const text = String(xml ?? '');
  const algorithms = [];
  for (const match of text.matchAll(/EncryptionMethod[^>]*\bAlgorithm\s*=\s*["']([^"']+)["']/gi)) {
    algorithms.push(match[1]);
  }
  const proprietary = /<Proprietary>\s*([^<]+?)\s*<\/Proprietary>/i.exec(text)?.[1]?.trim() ?? '';
  const drmAlgorithms = algorithms.filter(
    algorithm => !FONT_OBFUSCATION_ALGORITHMS.some(font => algorithm.startsWith(font)),
  );
  return {
    drm: drmAlgorithms.length > 0,
    vendor: proprietary || (drmAlgorithms.some(algorithm => /adept/i.test(algorithm)) ? 'Adobe ADEPT' : ''),
  };
}

/** 这段文本像不像 XML（用来区分「加密后的乱码」与「真的结构不合规范」）。 */
function looksLikeXml(text) {
  return /^\s*(<\?xml|<container|<package)/i.test(String(text ?? '').replace(/^\uFEFF/, ''));
}

/**
 * 解析一本 EPUB。
 *
 * @param buffer - 整份文件字节。
 * @param options.fallbackTitle - 解析不到 `dc:title` 时用（书单里的标题）。
 * @returns `{ format, title, author, sections, toc, warnings }`
 *   `sections`: `[{ title, blocks, lines, chars, href }]`
 *   `toc`: `[{ title, section }]`，`section` 是 1 起的节号。
 */
export function parseEpub(buffer, { fallbackTitle = '' } = {}) {
  const zip = readZip(buffer);
  const warnings = [];

  /**
   * ★ DRM **必须最先判**。加密的书（掌阅 ZhangYue.Inc + RSA）连 `container.xml`
   *   一起加密，读出来是乱码；往下走只会得到「找不到 rootfile」这种把人带偏的
   *   结论，用户会以为文件损坏而白白重新下载一本根本没坏的书。
   *   文案要明说「书本身没有损坏」，否则等于没修。
   */
  const encryptionXml = zip.read('META-INF/encryption.xml')?.toString('utf8') ?? '';
  if (encryptionXml !== '') {
    const enc = analyzeEncryption(encryptionXml);
    if (enc.drm) {
      throw coded(
        'EPUB_DRM',
        `这本书有 DRM 加密${enc.vendor ? `（${enc.vendor}）` : ''}，插件读不了。`
        + '书本身没有损坏，请换一个无 DRM 的版本，或先用工具去除 DRM。',
      );
    }
  }

  /** 容器三种失败各说各的：缺文件 / 是乱码 / 结构不合规范。 */
  const containerEntry = zip.read('META-INF/container.xml');
  if (containerEntry === null) throw coded('EPUB_NO_CONTAINER', '这本 EPUB 缺 META-INF/container.xml');
  const container = containerEntry.toString('utf8');
  if (!looksLikeXml(container)) {
    throw coded('EPUB_BAD_CONTAINER', '这本 EPUB 的 container.xml 不是有效 XML（文件可能损坏或带未声明的加密）');
  }
  const rootfile = /<rootfile\b[^>]*\bfull-path\s*=\s*"([^"]*)"/i.exec(container)?.[1]
    ?? /<rootfile\b[^>]*\bfull-path\s*=\s*'([^']*)'/i.exec(container)?.[1]
    ?? '';
  if (rootfile === '') throw coded('EPUB_NO_OPF', '这本 EPUB 的 container.xml 里没有 rootfile 路径');
  const opfPath = resolveHref('', rootfile);
  const opf = zip.read(opfPath)?.toString('utf8') ?? '';
  if (opf === '') throw coded('EPUB_NO_OPF', `这本 EPUB 里找不到 ${opfPath}`);
  const opfDir = dirOf(opfPath);

  const meta = parseMetadata(opf);
  const manifest = parseManifest(opf);
  const spine = parseSpine(opf);
  if (spine.length === 0) throw coded('EPUB_NO_SPINE', '这本 EPUB 的 OPF 里没有 spine（没有阅读顺序）');

  /** 目录：nav 优先，NCX 兜底。 */
  let tocEntries = [];
  const navItem = [...manifest.values()].find(item => /\bnav\b/.test(item.properties));
  if (navItem !== undefined) {
    const html = zip.read(resolveHref(opfDir, navItem.href))?.toString('utf8') ?? '';
    if (html !== '') tocEntries = parseNav(html, dirOf(resolveHref(opfDir, navItem.href)));
  }
  if (tocEntries.length === 0) {
    const ncx = [...manifest.values()].find(item => item.type === 'application/x-dtbncx+xml');
    if (ncx !== undefined) {
      const xml = zip.read(resolveHref(opfDir, ncx.href))?.toString('utf8') ?? '';
      if (xml !== '') tocEntries = parseNcx(xml, dirOf(resolveHref(opfDir, ncx.href)));
    }
  }
  if (tocEntries.length === 0) warnings.push('这本书没有目录（nav / ncx 都缺），按 spine 顺序分节');

  /** 目录条目按**文件名**归到节上。同一文件的第一条作为节名。 */
  const titleByFile = new Map();
  for (const entry of tocEntries) {
    if (entry.file !== '' && !titleByFile.has(entry.file)) titleByFile.set(entry.file, entry.title);
  }

  const sections = [];
  let totalChars = 0;
  for (const item of spine) {
    const entry = manifest.get(item.idref);
    if (entry === undefined) {
      warnings.push(`spine 引用了 manifest 里不存在的条目：${item.idref}`);
      continue;
    }
    if (entry.type !== '' && !/xhtml|html|xml/i.test(entry.type)) continue;
    const href = resolveHref(opfDir, entry.href);
    const raw = zip.read(href);
    if (raw === null) {
      warnings.push(`读不到 ${href}`);
      continue;
    }
    const html = raw.length > MAX_SECTION_HTML
      ? raw.subarray(0, MAX_SECTION_HTML).toString('utf8')
      : raw.toString('utf8');
    if (raw.length > MAX_SECTION_HTML) warnings.push(`${href} 超过 ${MAX_SECTION_HTML / 1024 / 1024} MB，只读了前面一段`);

    const { blocks } = htmlToBlocks(html);
    const lines = blocksToLines(blocks).slice(0, MAX_SECTION_LINES);
    const chars = lines.join('').length;
    totalChars += chars;
    const title = titleByFile.get(href) ?? titleFromBlocks(blocks);
    sections.push({
      title: title === '' ? `第 ${sections.length + 1} 节` : title,
      blocks,
      lines,
      chars,
      href,
      linear: item.linear,
    });
  }

  if (sections.length === 0) throw coded('EPUB_EMPTY', '这本 EPUB 解析出了 0 节正文');
  if (totalChars < 200) warnings.push('这本书的正文几乎抽不到字（可能是纯图片版 EPUB）');

  // 目录条目 → 节号（1 起）。同一节被多次引用时保留全部条目 —— 它们是真实结构。
  const sectionByFile = new Map();
  sections.forEach((section, index) => {
    if (!sectionByFile.has(section.href)) sectionByFile.set(section.href, index + 1);
  });
  const toc = [];
  const seen = new Set();
  for (const entry of tocEntries) {
    const section = sectionByFile.get(entry.file);
    if (section === undefined) continue;
    const key = `${section}\u0000${entry.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toc.push({ title: entry.title, section });
  }

  return {
    format: 'epub',
    title: meta.title || fallbackTitle,
    author: meta.author,
    language: meta.language,
    sections,
    toc,
    warnings,
  };
}
