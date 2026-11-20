/**
 * 论文元数据源：arXiv / Crossref / OpenAlex，以及 PDF 下载。
 *
 * 三个源的定位（都**不需要 key**，带 `mailto` 就进「礼貌池」）：
 *
 *   - **arXiv Atom API**：主源。标题、作者、摘要、分类、`journal_ref`、PDF 直链，
 *     一次 `id_list=a,b,c` 能批量拿回多条 —— 实测 3 个 id 一次返回 3 条完整元数据。
 *   - **Crossref**：有 DOI 但 arXiv 没有的（期刊/会议论文）。给标题、作者、期刊、年份，
 *     **不给 PDF**：闭源出版社的 `link[]` 只有 TDM 条目（要订阅 + API key）。
 *   - **OpenAlex**：补「合法开放获取副本」的地址（`best_oa_location.pdf_url`）。
 *     注意它给的是 `oa_status`，不是保证有 PDF —— 实测 Nature 那篇 `green` 但
 *     `pdf_url` 为 null，只给了个落地页。所以它只能当**回退链的一环**，不能当承诺。
 *
 * ★ 全部外抓都过 `checkPublicUrl`：这些地址虽然是我们自己拼的，但 OpenAlex 返回的
 *   `pdf_url` 是**第三方数据**，直接去取等于把 SSRF 面开给了数据源。宁可多一次 DNS。
 * ★ 全部有字节上限：`Content-Length` 不可信（可以是流式、可以是假的），所以边读
 *   边计数，超了就中断 —— 否则一个「PDF 直链」可以喂给我们 500 MB。
 */
import { checkPublicUrl } from './net-guard.js';
import { attrOf, childrenOf, find, localName, parseXml, textOf } from './xml.js';

/** 带联系方式进「礼貌池」（arXiv / Crossref / OpenAlex 都认这个约定）。 */
const MAILTO = 'dsh-npie-reader@users.noreply.github.com';
const USER_AGENT = `dsh-npie-reader/1.0 (mailto:${MAILTO})`;

/** 元数据响应上限：Atom 单页 100 条约 300 KB，8 MB 是安全阀。 */
const META_MAX_BYTES = 8 * 1024 * 1024;
/** PDF 上限。arXiv 单篇最大实测 60 MB 左右（大图附录），给到 120 MB。 */
const PDF_MAX_BYTES = 120 * 1024 * 1024;

/**
 * 抓一段文本（Atom / JSON）。
 *
 * @param {string} url
 * @param {{ accept?: string, timeoutMs?: number, maxBytes?: number }} [options]
 */
async function fetchText(url, { accept = '*/*', timeoutMs = 25_000, maxBytes = META_MAX_BYTES } = {}) {
  const verdict = await checkPublicUrl(url);
  if (!verdict?.ok) throw new Error(`拒绝访问 ${url}：${verdict?.reason ?? '地址未通过校验'}`);
  const response = await fetch(url, {
    headers: { accept, 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${new URL(url).host} 返回 HTTP ${response.status}`);
  const buffer = await readCapped(response, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

/**
 * 边读边计数，超过 `maxBytes` 就掐断。
 *
 * ★ 不用 `arrayBuffer()`：它会把整个响应读进内存之后我们才发现太大 —— 而那个
 *   「太大」正是我们想防的东西。
 */
async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    return buffer;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function cleanText(value, max = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** Crossref 的摘要是 JATS（`<jats:p>…`），去掉标签留文字。 */
function stripTags(html) {
  return cleanText(String(html ?? '').replace(/<[^>]*>/g, ' '), 20_000);
}

/**
 * 从各种写法里认出 arXiv id。
 *
 * 接受：`2401.00001`、`2401.00001v5`、`arXiv:2401.00001`、
 * `https://arxiv.org/abs/2401.00001v2`、`https://arxiv.org/pdf/2401.00001.pdf`、
 * 老式 `hep-th/9901001`。
 *
 * @returns {string} 归一后的 id（不带版本号、不带前缀）；认不出就是空串。
 */
export function normalizeArxivId(input) {
  const text = String(input ?? '').trim();
  if (text === '') return '';
  const stripped = text
    .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/^arxiv:\s*/i, '')
    .trim();
  // 新式：YYMM.NNNN(N)  + 可选版本号；老式：archive/YYMMNNN
  const modern = /^(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(stripped);
  if (modern !== null) return modern[1];
  const legacy = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.exec(stripped);
  if (legacy !== null) return legacy[1];
  return '';
}

/** 从各种写法里认出 DOI（`10.xxx/yyy`、`https://doi.org/10.xxx/yyy`、`doi:10.…`）。 */
export function normalizeDoi(input) {
  const text = String(input ?? '').trim();
  if (text === '') return '';
  const stripped = text
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
  return /^10\.\d{4,9}\/\S+$/.test(stripped) ? stripped : '';
}

/**
 * 从 arXiv 的 `<arxiv:comment>` 里猜一个「发表在哪」。
 *
 * ★ 必须过滤：绝大多数 comment 写的是**排版信息**（实测 2401.00001 是
 *   「15 pages, 5 figures」），直接当 venue 显示，界面上就成了
 *   「Sparse Routing for Long Documents — 15 pages, 5 figures」，比空着更糟。
 *   只有「CVPR 2024」「Published in NeurIPS」这类才留。
 */
function venueFromComment(comment) {
  const head = cleanText(comment, 200).split(/[,;]|\band\b/i)[0].trim();
  if (head === '') return '';
  if (/^(\d+\s*(pages?|figures?|tables?|equations?)\b)/i.test(head)) return '';
  if (!/[A-Za-z]{3,}/.test(head)) return '';
  return head;
}

/** arXiv Atom 的 `<entry>` → 条目。 */
function entryToPaper(entry) {
  const rawId = textOf(find(entry, 'id')).trim();
  // `<id>` 永远是 `http://arxiv.org/abs/<id>vN` 形态 —— 版本号必须去掉，
  // 否则同一篇论文的 v1/v2 会算成两条记录（去重键是 `arxiv:<id>`）。
  const arxivId = normalizeArxivId(rawId);
  if (arxivId === '') return null;
  const authors = childrenOf(entry, 'author')
    .map((author) => cleanText(textOf(find(author, 'name')), 120))
    .filter((name) => name !== '');
  const links = childrenOf(entry, 'link');
  const absLink = links.find((link) => attrOf(link, 'rel') === 'alternate');
  const primary = find(entry, 'primary_category');
  const categories = [attrOf(primary, 'term'), ...childrenOf(entry, 'category').map((node) => attrOf(node, 'term'))]
    .filter((value) => typeof value === 'string' && value !== '');
  const published = textOf(find(entry, 'published')) || textOf(find(entry, 'updated'));
  const year = Number(published.slice(0, 4));
  return {
    key: `arxiv:${arxivId}`,
    source: 'arxiv',
    arxivId,
    title: cleanText(textOf(find(entry, 'title')), 400) || '未命名论文',
    authors,
    abstract: cleanText(textOf(find(entry, 'summary')), 20_000),
    year: Number.isInteger(year) && year > 1900 ? year : 0,
    // `journal_ref` 是真·发表信息；没有它才退回 comment（并且要过滤）。
    venue: cleanText(textOf(find(entry, 'journal_ref')), 200)
      || venueFromComment(textOf(find(entry, 'comment'))),
    categories: [...new Set(categories)].slice(0, 8),
    url: absLink ? attrOf(absLink, 'href') ?? `https://arxiv.org/abs/${arxivId}` : `https://arxiv.org/abs/${arxivId}`,
    // ★ 不带版本号：`…/pdf/2401.00001v7` 会随新的 v8 失效（旧的 v7 链接在 arXiv
    //   上仍然可达，但那是历史版本）。存版本无关的地址，下载永远拿到最新版。
    pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
    doi: cleanText(textOf(find(entry, 'doi')), 200),
  };
}

/**
 * arXiv 检索。
 *
 * @param {string} query - 自由词。
 * @param {{ limit?: number }} [options]
 * @returns {Promise<object[]>}
 */
export async function searchArxiv(query, { limit = 20 } = {}) {
  const text = cleanText(query, 300);
  if (text === '') return [];
  /**
   * 整段当**短语**（`all:"…"`），而不是逐词 AND。
   *
   * ★ 实测对照：`all:sparse routing for long documents` 的前三条是
   *   「Do You Even Need Attention?」「"All You Need" is Not All You Need」这类
   *   只沾了单词的结果；加引号之后第一条就是原论文。用户粘标题来搜是主用法，
   *   逐词 AND 会让「搜不到自己要的那篇」。
   * ★ 引号由**我们**加：先剥掉用户输入里的引号，避免 `"` 把查询语法截断。
   */
  const safe = text.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
  const url = 'https://export.arxiv.org/api/query?search_query='
    + encodeURIComponent(`all:"${safe}"`)
    + `&start=0&max_results=${Math.min(50, Math.max(1, limit))}`
    + `&sortBy=relevance&sortOrder=descending&mailto=${MAILTO}`;
  const xml = await fetchText(url, { accept: 'application/atom+xml, application/xml' });
  const root = parseXml(xml);
  const feed = localName(root.tag) === 'feed' ? root : find(root, 'feed');
  const exact = childrenOf(feed, 'entry').map(entryToPaper).filter((item) => item !== null);
  if (exact.length > 0) return exact;
  /**
   * 短语搜索**一条都没有**时退回逐词。
   *
   * 为什么不直接返回空：短语匹配要求原文里连续出现这几个词，而用户常把
   * 「作者 年份 关键词」混着敲 —— 那种输入永远匹配不到连续短语，但逐词是能命中的。
   */
  const loose = 'https://export.arxiv.org/api/query?search_query='
    + encodeURIComponent(`all:${safe}`)
    + `&start=0&max_results=${Math.min(50, Math.max(1, limit))}`
    + `&sortBy=relevance&sortOrder=descending&mailto=${MAILTO}`;
  const xmlLoose = await fetchText(loose, { accept: 'application/atom+xml, application/xml' });
  const rootLoose = parseXml(xmlLoose);
  const feedLoose = localName(rootLoose.tag) === 'feed' ? rootLoose : find(rootLoose, 'feed');
  return childrenOf(feedLoose, 'entry').map(entryToPaper).filter((item) => item !== null);
}

/** 按 id 取一条（顺带当「这个 id 存不存在」的校验）。 */
export async function arxivById(id) {
  const arxivId = normalizeArxivId(id);
  if (arxivId === '') throw new Error(`认不出这个 arXiv 编号：${String(id)}`);
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&mailto=${MAILTO}`;
  const xml = await fetchText(url, { accept: 'application/atom+xml, application/xml' });
  const root = parseXml(xml);
  const feed = localName(root.tag) === 'feed' ? root : find(root, 'feed');
  const entry = childrenOf(feed, 'entry')[0];
  if (entry === undefined) throw new Error(`arXiv 上找不到 ${arxivId}`);
  // arXiv 对不存在的 id 也会回一个 200 + 空 feed；再兜一层标题为空的情况。
  const paper = entryToPaper(entry);
  if (paper === null || paper.title === '未命名论文') throw new Error(`arXiv 上找不到 ${arxivId}`);
  return paper;
}

function crossrefAuthors(message) {
  return (message.author ?? [])
    .map((author) => cleanText([author.given, author.family].filter(Boolean).join(' '), 120) || cleanText(author.name, 120))
    .filter((name) => name !== '');
}

/** 按 DOI 取元数据（Crossref）。 */
export async function crossrefByDoi(doi) {
  const normalized = normalizeDoi(doi);
  if (normalized === '') throw new Error(`认不出这个 DOI：${String(doi)}`);
  const url = `https://api.crossref.org/works/${encodeURIComponent(normalized)}?mailto=${MAILTO}`;
  const body = JSON.parse(await fetchText(url, { accept: 'application/json' }));
  const message = body?.message;
  if (message === null || typeof message !== 'object') throw new Error(`Crossref 没有 ${normalized} 的记录`);
  const parts = message.issued?.['date-parts']?.[0] ?? message.published?.['date-parts']?.[0] ?? [];
  const year = Number(parts[0]);
  return {
    key: `doi:${normalized}`,
    source: 'doi',
    doi: normalized,
    arxivId: '',
    title: cleanText(message.title?.[0], 400) || '未命名论文',
    authors: crossrefAuthors(message),
    abstract: stripTags(message.abstract),
    year: Number.isInteger(year) && year > 1900 ? year : 0,
    venue: cleanText(message['container-title']?.[0] ?? message.publisher, 200),
    categories: [],
    url: cleanText(message.URL, 600) || `https://doi.org/${normalized}`,
    pdfUrl: '',
  };
}

/**
 * OpenAlex 的开放获取副本地址。
 *
 * @returns {Promise<{ pdfUrl: string, landing: string, oaStatus: string } | null>}
 *   `null` = 查不到这条。**空 pdfUrl 不是错误**：OA 状态是 green 但没有 PDF 直链
 *   很常见（实测 Nature「Deep learning」就是这样），调用方据此显示「去落地页看看」。
 */
export async function openAlexPdfByDoi(doi) {
  const normalized = normalizeDoi(doi);
  if (normalized === '') return null;
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normalized)}?mailto=${MAILTO}`;
  let body;
  try {
    body = JSON.parse(await fetchText(url, { accept: 'application/json', timeoutMs: 20_000 }));
  } catch {
    return null; // 查不到就当没有 —— 它是回退链，不该让主流程报错
  }
  const best = body?.best_oa_location ?? {};
  const locations = Array.isArray(body?.locations) ? body.locations : [];
  const pdfUrl = cleanText(best.pdf_url, 600)
    || cleanText(locations.map((item) => item?.pdf_url).find((value) => typeof value === 'string' && value !== ''), 600);
  return {
    pdfUrl,
    landing: cleanText(best.landing_page_url, 600),
    oaStatus: cleanText(body?.open_access?.oa_status, 20),
  };
}

/** arXiv 版本号归一：去掉 `vN` 后缀，`/pdf/` 直链才稳定。 */
function pdfUrlForArxiv(arxivId) {
  const id = normalizeArxivId(arxivId);
  return id === '' ? '' : `https://arxiv.org/pdf/${id}`;
}

/** 这条论文有没有可以直接下载的 PDF（不看网络，只看已知字段）。 */
export function pdfCandidate(paper) {
  const direct = cleanText(paper?.pdfUrl, 600);
  if (direct !== '') return direct;
  return pdfUrlForArxiv(paper?.arxivId);
}

/**
 * 下载一份 PDF。
 *
 * ★ 校验**魔数** `%PDF-`：有些出版社/代理会把 302 到登录页、或者返回一段
 *   `text/html` 的错误页，HTTP 状态却是 200。只信 `content-type` 挡不住
 *   （有站点发 `application/octet-stream`，也有站点把 `application/pdf` 写在
 *   错误页上）。魔数是唯一能确认「这真的是 PDF」的判据。
 */
export async function downloadPdf(url, { maxBytes = PDF_MAX_BYTES, timeoutMs = 120_000 } = {}) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error(`不是可下载的地址：${target}`);
  const verdict = await checkPublicUrl(target);
  if (!verdict?.ok) throw new Error(`拒绝下载 ${target}：${verdict?.reason ?? '地址未通过校验'}`);
  const response = await fetch(target, {
    headers: { accept: 'application/pdf,*/*', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const buffer = await readCapped(response, maxBytes);
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('下载到的内容不是 PDF（可能被重定向到了登录页或错误页）');
  }
  return buffer;
}

export { MAILTO, PDF_MAX_BYTES, fetchText as fetchMetadataText };

/**
 * 把「用户随手粘的一串东西」解析成一条论文元数据。
 *
 * ★ 这段原本住在 `paper-routes.js` 里，0.69.0 挪到这里：Agent 工具（`paper_import`）
 *   与 HTTP 路由要用**同一套**判定。写两份的后果不是「略有不同」，而是
 *   「界面上导入成功、对话框里说没找到」—— 用户无从判断信哪个。
 *
 * ★ 顺序有意义：**先认 arXiv**（能直接拿到 PDF），再认 DOI（可能只有元数据），
 *   最后才当成自由词。反过来的话，一个长得像 DOI 的 arXiv 链接会被送到 Crossref
 *   去查一个不存在的 DOI。
 */
export async function resolvePaperInput(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') throw new Error('给一个 arXiv 编号、DOI 或链接');

  const arxivId = normalizeArxivId(text);
  if (arxivId !== '') return await arxivById(arxivId);

  const doi = normalizeDoi(text);
  if (doi !== '') {
    const paper = await crossrefByDoi(doi);
    // Crossref 不给 PDF；OpenAlex 可能知道哪里有合法副本。查不到就留空 ——
    // 界面上会显示「这篇要你自己下载后拖进来」。
    const open = await openAlexPdfByDoi(doi);
    if (open?.pdfUrl) paper.pdfUrl = open.pdfUrl;
    else if (open?.landing) paper.url = paper.url || open.landing;
    return paper;
  }

  // 兜底：把整段当关键词，取第一条。用户粘贴标题时这是最省事的行为。
  const found = await searchArxiv(text, { limit: 1 });
  if (found.length === 0) throw new Error(`没找到：${text}`);
  return found[0];
}

/**
 * 「补全元数据」：去源上再查一次，**只填空着的字段**，绝不覆盖已填的。
 *
 * ★ 只补空是硬规则。用户的 venue / 摘要可能是自己改过的（`patch` 白名单里就有
 *   `venue` / `abstract` / `year`），拿源上的值盖掉等于「点一下补全，我改的全没了」。
 *   —— 这类「顺手同步」最伤，因为用户点的是「补全」两个字，预期是加法。
 *
 * ★ 查不到就返回 `changed: []`，**不报错**：可能是付费墙内的 DOI、可能是源临时抽风。
 *   界面上一句「这次没查到新东西」比一个红色错误有用得多。
 *
 * @returns {Promise<{ patch: object, changed: string[] }>}
 */
export async function enrichPaperFields(paper) {
  const doi = normalizeDoi(paper?.doi);
  const arxivId = normalizeArxivId(paper?.arxivId);
  /** 元数据的候选来源：按「已知标识符」挑，一次只查一个（两个都查纯属浪费配额）。 */
  let fetched = null;
  if (doi !== '') {
    try { fetched = await crossrefByDoi(doi); } catch { fetched = null; }
  }
  if (fetched === null && arxivId !== '') {
    try { fetched = await arxivById(arxivId); } catch { fetched = null; }
  }
  if (fetched === null) return { patch: {}, changed: [] };

  const patch = {};
  const changed = [];
  const empty = (value) => (typeof value === 'string' ? value.trim() === '' : !(Number(value) > 0));
  for (const field of ['title', 'venue', 'abstract', 'doi', 'arxivId', 'url', 'pdfUrl']) {
    const incoming = cleanText(fetched[field], field === 'abstract' ? 20_000 : 600);
    if (incoming !== '' && empty(paper?.[field])) { patch[field] = incoming; changed.push(field); }
  }
  if (!(Number(paper?.year) > 0) && Number(fetched?.year) > 0) { patch.year = fetched.year; changed.push('year'); }
  // 作者：只在完全没有的时候补。部分缺失（有 3 个少了 2 个）不猜 —— 无法对齐是谁。
  if ((paper?.authors ?? []).length === 0 && (fetched?.authors ?? []).length > 0) {
    patch.authors = fetched.authors;
    changed.push('authors');
  }
  return { patch, changed };
}
