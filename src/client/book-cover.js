/**
 * 书封面的客户端支持：把「真封面」与「生成式封面」收敛成一套取值。
 *
 * ★ 为什么需要这一层：书架索引里**没有封面字段**（见 `src/host/book-cover.js` 顶部）。
 *   于是封面只有两条真实来源：
 *     ① EPUB —— 宿主解 zip 取内嵌封面（`GET /cover/:id`）；
 *     ② PDF  —— 客户端用 pdf.js 把**第一页**渲染成图（宿主没有 canvas）。
 *   剩下的格式（mobi / azw3 / txt / docx）没有可用的封面来源 ⇒ 生成式。
 *   **生成式不是「假封面」**：它是界面明说的占位（书名首字 + 主题色渐变），
 *   与「这本书没有封面」这句话在视觉上是两件事，不会误导。
 *
 * ★ 生成式封面的色相**从书名哈希来**，不是随机：同一本书每次都是同一个颜色，
 *   而不同书之间会散开。随机色相会让侧栏每刷新一次就换一套颜色 —— 那是噪声。
 */

import { LIBRARY_API_PREFIX } from '../library.js';
import { loadPdfjs, openCachedBook } from './pdfjs.js';

/** 生成式封面的色相表：12 档，都是「布面书封」能接受的低饱和色位。 */
const COVER_HUES = [6, 18, 34, 52, 96, 142, 170, 192, 212, 234, 266, 318];

/** PDF 封面在内存里留几张（dataURL，一张约 10–30 KB）。 */
const PDF_COVER_LIMIT = 32;

/** 已经渲染好的 PDF 封面：`id::size` → Promise<dataURL>。 */
const pdfCovers = new Map();

/** 取值失败**不缓存**：用户可能刚把书换掉，重试应该真的重试一次。 */
function remember(key, job) {
  pdfCovers.set(key, job);
  while (pdfCovers.size > PDF_COVER_LIMIT) {
    pdfCovers.delete(pdfCovers.keys().next().value);
  }
  job.catch(() => { pdfCovers.delete(key); });
  return job;
}

/** 这本书的封面该走哪条路：`epub`（宿主解）/ `pdf`（客户端渲染）/ `made`（生成）。 */
export function coverKind(book) {
  const ext = String(book?.ext ?? '').toLowerCase();
  if (ext === 'epub') return 'epub';
  if (ext === 'pdf') return 'pdf';
  return 'made';
}

/** 宿主那侧封面接口的 URL（EPUB）。 */
export function epubCoverUrl(bookId) {
  return `${LIBRARY_API_PREFIX}/cover/${encodeURIComponent(String(bookId))}`;
}

/**
 * 书名 → 色相。
 *
 * djb2 就够了：要的是「稳定 + 散开」，不是密码学性质。
 * ★ 取模用 `>>> 0` 之后再算，负数色相会让 `hsl(-12 …)` 变成无效值（浏览器会整条丢掉）。
 */
export function coverHue(title) {
  const text = String(title ?? '');
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return COVER_HUES[hash % COVER_HUES.length];
}

const GLYPH_STRIP = /[《》〈〉「」『』【】\[\]()（）{}<>“”‘’"'`·、，,。.：:；;！！?？—–\-_/\\|~^*+=\s0-9]/g;

/**
 * 掐掉**开头那些成组的元信息**：`（英）`、`[法]`、`【修订版】`、`《丛书名》`。
 *
 * ★ 只掐「后面还有内容」的组：`《九三年》` 整串就是一个组，掐掉就什么都不剩了，
 *   那种情况留给 `GLYPH_STRIP` 去剥符号。
 * ★ 这是**尽力而为**：本机的书名是文件名清洗来的（`《译文名著文库》 076[法]雨果-九三年`），
 *   里面混着丛书名、编号、国籍、作者 —— 没有结构化信息可依。取到的可能是作者而不是
 *   书名首字，这不是 bug，是数据本身就没有那个信息。卡片下方永远有完整书名。
 */
const LEADING_GROUP = /^[（(\[［【《][^）)】》\]］]{1,24}[）)】》\]］]\s*/;

function stripLeadingGroups(text) {
  let rest = text;
  for (let round = 0; round < 3; round += 1) {
    const hit = LEADING_GROUP.exec(rest);
    if (hit === null || hit[0].length >= rest.length) break;
    rest = rest.slice(hit[0].length);
  }
  return rest;
}

/**
 * 生成式封面正中那个大字。
 *
 * ★ 先剥掉书名号、括号、标点与空白，再取首字 —— 否则 `《九三年》` 会显示成 `《`。
 * ★ 剥完一个字符都不剩（例如书名就是 `---`）时退回原始串的首字；再不行才用 `?`。
 *   这不是装饰：空字符串会让封面正中什么都没有，看起来像加载失败。
 */
export function coverGlyph(title) {
  const raw = String(title ?? '').trim();
  const clean = stripLeadingGroups(raw).replace(GLYPH_STRIP, '');
  const source = clean === '' ? raw.replace(GLYPH_STRIP, '') || raw : clean;
  const first = Array.from(source)[0];
  return first ?? '?';
}

/** 生成式封面上那行小字（书名太长就截断，不靠 CSS 兜）。 */
export function coverCaption(title, max = 12) {
  const chars = Array.from(String(title ?? '').replace(/[《》]/g, '').trim());
  if (chars.length === 0) return '';
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

/** 格式胶囊上的字：`epub` → `EPUB`，空值给空串（不印一个空洞的胶囊）。 */
export function formatExt(ext) {
  return String(ext ?? '').trim().toUpperCase();
}

/**
 * PDF 的封面：把第一页渲染成一张 JPEG dataURL。
 *
 * ★ 只渲染**第一页**，并且按卡片宽度缩放（默认 210px 宽）：整页按原尺寸画会得到
 *   一张 2000px 的图，内存与耗时都是浪费，而它最终只显示在一张 ~110px 宽的卡片里。
 * ★ 走 `openCachedBook` 而不是自己 `getDocument`：那层缓存会按 `id::size` 复用已经
 *   解析过的文档，并带 LRU 销毁 —— 否则来回切书会反复取首块 1 MiB 并重复解析。
 * ★ 失败一律抛给调用方：它负责回落生成式封面。这里**不吞**，因为「渲染失败」与
 *   「没有封面」在界面上可以是同一句话，但在排查时是两件事。
 */
export async function pdfCoverDataUrl(book, width = 210) {
  const bookId = String(book?.id ?? '');
  const length = Number(book?.size ?? 0);
  if (bookId === '' || !(length > 0)) throw new Error('这本书没有可取字节的体积信息');
  const key = `${bookId}::${length}`;
  const hit = pdfCovers.get(key);
  if (hit !== undefined) return await hit;

  return await remember(key, (async () => {
    const pdfjs = await loadPdfjs();
    const { doc } = await openCachedBook(pdfjs, { bookId, length, onError: () => {} });
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(0.15, width / Math.max(1, base.width)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('拿不到 2d 画布');
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  })());
}

/** 测试与面板卸载用：清掉 PDF 封面的内存表。 */
export function forgetCovers() {
  pdfCovers.clear();
}
