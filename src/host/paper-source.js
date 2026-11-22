/**
 * 论文元数据源：arXiv / Crossref / OpenAlex，以及 PDF 下载。
 *
 * 四个源的定位（前三个都**不需要 key**，带 `mailto` 就进「礼貌池」）：
 *
 *   - **arXiv Atom API**：主源。标题、作者、摘要、分类、`journal_ref`、PDF 直链，
 *     一次 `id_list=a,b,c` 能批量拿回多条 —— 实测 3 个 id 一次返回 3 条完整元数据。
 *   - **alphaXiv 论文页**（0.90.0）：arXiv 之外**另一条论文发布渠道**。它把
 *     「没有 arXiv 编号」的论文也挂在 `/abs/<slug>` 下（形如 `2611.harness-cg`），
 *     这类论文在 arXiv 上**根本不存在** —— 只查 arXiv 的话，用户手里的链接永远
 *     导不进来。页面带 Google Scholar 那套 Highwire 元标签
 *     （`citation_title` / `citation_author` / `citation_pdf_url` …），照它解即可。
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
  /**
   * ★ 报错只报**主机名**，不报整条 URL：这条消息会原样出现在对话框里，而整条
   *   带 `search_query=…` 的 URL 会把那行红字撑成三行（用户 2026-11-22 的截图）。
   *   用户需要知道的是「哪个站点没抓成、为什么」，不需要看查询串。
   */
  if (!verdict?.ok) throw new Error(`${new URL(url).host} 没通过地址校验：${verdict?.reason ?? '未知原因'}`);
  const response = await fetch(url, {
    headers: { accept, 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) {
    /**
     * 429/503 是 arXiv 的限流，**不是**「你的论文不存在」。
     *
     * ★ 两者原来共用一句「返回 HTTP 503」，用户会去换关键词，而正确做法是等几秒 ——
     *   文案必须能区分，否则这条错误把人引向错误的自救。
     * ★ `status` 挂到 error 上，给 `fetchTextRetry` 判「值不值得重试」用。
     */
    const host = new URL(url).host;
    const busy = response.status === 429 || response.status === 503;
    const error = new Error(busy
      ? `${host} 忙不过来（HTTP ${response.status}），等几秒再试`
      : `${host} 返回 HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const buffer = await readCapped(response, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

/**
 * 抓文本，遇到限流（429 / 502 / 503）**重试一次**。
 *
 * ★ 实测（2026-11-22）：连续发四五条 arXiv 检索，第一条之后就开始回 429/503。
 *   而一次搜索现在最多发两档查询（标题短语 → 逐词 AND），正好落在限流窗口里。
 *   不重试的话，用户看到的是「服务忙」而不是结果 —— 而其实隔两秒就通了。
 * ★ 只重试一次、只重试限流类状态：网络真断、域名打不开这类重试也白等，
 *   反而把一次 20 秒的超时变成两次。
 */
async function fetchTextRetry(url, options, { attempts = 2, waitMs = 2600 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchText(url, options);
    } catch (error) {
      const status = Number(error?.status);
      const throttled = status === 429 || status === 502 || status === 503;
      if (!throttled || attempt >= attempts) throw error;
      await new Promise((resolve) => { setTimeout(resolve, waitMs); });
    }
  }
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
 * `https://www.alphaxiv.org/abs/2401.00001`（有 arXiv 编号的 alphaXiv 页面）、
 * 老式 `hep-th/9901001`。
 *
 * @returns {string} 归一后的 id（不带版本号、不带前缀）；认不出就是空串。
 */
export function normalizeArxivId(input) {
  const text = String(input ?? '').trim();
  if (text === '') return '';
  const stripped = text
    .replace(/^https?:\/\/(?:(?:export|www)\.)?(?:arxiv\.org|alphaxiv\.org)\/(?:abs|pdf)\//i, '')
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
 * arXiv 检索里没有区分度的词。
 *
 * ★ 留着它们只会把查询撑宽：`AND` 里多一个 `be`，正确结果就少一条。
 */
const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'on', 'in', 'to', 'with', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'can', 'could', 'do', 'does', 'did', 'not', 'no', 'from', 'by', 'as', 'at',
  'that', 'this', 'these', 'those', 'we', 'our', 'you', 'your', 'it', 'its', 'via', 'using', 'use',
  'toward', 'towards', 'into', 'about', 'how', 'what', 'why', 'when', 'which', 'than', 'then',
]);

/**
 * 把输入拆成检索词（小写、去标点、去停用词、去重）。
 *
 * ★ 去掉长度 1 的词：`Harness^2` 里的 `2` 在标题里几乎不构成区分度，但它会进
 *   `AND`，一个 `2` 不匹配就把正确结果整条筛掉。
 *
 * @returns {string[]}
 */
export function queryTokens(text, { max = 12 } = {}) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 2 && !SEARCH_STOPWORDS.has(word));
  return [...new Set(words)].slice(0, Math.max(1, max));
}

/**
 * 短语查询用的串：小写、去标点与引号、压空格，**保留停用词**。
 *
 * ★ 停用词在短语里是有用的：`Sparse Routing for Long Documents` 去掉 `for` 之后
 *   就不再是标题里的那串字，`ti:"…"` 会 0 命中 —— 而它本来是最好用的一档。
 * ★ 截断到 140 字符：粘一整段摘要进来时，短语查询只会有 0 条结果，
 *   白白多一次请求（还有限流风险）。
 */
export function queryPhrase(text, max = 140) {
  const phrase = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return phrase.length > max ? phrase.slice(0, max).trim() : phrase;
}

/**
 * 两个词算不算同一个（复数、`-ing`、`-tion` 这类形态差异）。
 *
 * ★ 用**公共前缀 ≥5** 而不是 Porter 词干器：词干器会把 `less` 削成 `les`，
 *   于是任何长词都能命中它。我们要的只是「harness / harnesses / harnessing
 *   算一个词」这种粗粒度对齐，前缀够长就够了。
 * ★ 短词（<5）要求完全一致，否则 `ai` 会命中 `said`。
 */
function sameWord(token, word) {
  if (token === word) return true;
  if (token.length < 5 || word.length < 5) return false;
  let index = 0;
  while (index < token.length && index < word.length && token[index] === word[index]) index += 1;
  return index >= 5;
}

/**
 * 一段文字命中了几个检索词（0–1）。
 *
 * @returns {number} 命中比例；`tokens` 为空时返回 0（不把「没有词」算成全中）。
 */
export function tokenCoverage(text, tokens) {
  if (tokens.length === 0) return 0;
  const words = String(text ?? '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  let hit = 0;
  for (const token of tokens) {
    if (words.some((word) => sameWord(token, word))) hit += 1;
  }
  return hit / tokens.length;
}

/**
 * 导入场景下，用户粘的标题与候选标题算不算**同一篇**（0.90.2）。
 *
 * ★ 为什么不能复用搜索的判据（`rankArxivResults`）：搜索求「召回」，标题命中全部词
 *   **或摘要**命中全部词都留下；导入求「精确」，取搜索第一名会把沾了几个词的
 *   另一篇论文当成用户要的那篇。用户 2026-11-22 的现场：粘
 *   《Language Model Harnesses Can Be Compositional Generalizers》，导进来的却是
 *   「Weak-to-Strong Compositional Learning from Generative Models for Language-based
 *   Object Detection」—— 后者摘要里恰好有 language / model / compositional。
 *   **导错比导不到糟**：导不到他会换个写法，导错了他会拿着错的论文写读后感。
 *
 * ★ 判据：归一化后逐字相同，或**双向**实词全覆盖 —— 输入的每个实词都在候选标题里，
 *   候选标题的每个实词也都在输入里。双向缺一不可：
 *   - 只要单向（输入 ⊂ 候选）⇒ 上面那篇 Weak-to-Strong 会因为含有
 *     language / compositional 而误判成命中；
 *   - 只要另一向（候选 ⊂ 输入）⇒ 粘「language model」会命中任意一篇标题更长的论文。
 * ★ 用 `tokenCoverage`（带 `sameWord` 的形态容差）：harness / harnesses 算一个词，
 *   复数与 -ing 差异不至于把同一篇论文判成两篇。
 *
 * @param {string} input 用户粘的标题
 * @param {string} candidateTitle 候选论文的标题
 * @returns {boolean}
 */
export function isTitleExactMatch(input, candidateTitle) {
  const a = queryPhrase(input);
  const b = queryPhrase(candidateTitle);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const inTokens = queryTokens(input, { max: 30 });
  const candidateTokens = queryTokens(candidateTitle, { max: 30 });
  if (inTokens.length === 0 || candidateTokens.length === 0) return false;
  return tokenCoverage(candidateTitle, inTokens) === 1
    && tokenCoverage(input, candidateTokens) === 1;
}

/**
 * 只留「每个词都命中」的结果，并按标题吻合度排序。
 *
 * ★ 这一步才是「不笼统」的关键。arXiv 的 `ti:` / `AND` 只保证这些词**出现过**，
 *   而 `all:` 多词是**或**语义 —— 用户 2026-11-22 的截图里搜标题，
 *   前三条是「DeformSmith」「WizardLM」「Zero-Shot Sign Language」，
 *   只沾了 language / model / be。这类结果一条都不该出现在列表里。
 * ★ `abstractOk` 只给「逐词 AND」那一档：那一档本来就放宽了匹配面，
 *   连摘要里都没提到全部词的话，它跟这次搜索就没关系。
 * ★ `sort` 在 V8 里是稳定的 ⇒ 同分时保留 arXiv 自己的 relevance 顺序，
 *   不会把一个好好的排序打乱成随机。
 *
 * @param {object[]} items arXiv 返回的条目
 * @param {{ tokens: string[], phrase?: string, limit?: number, abstractOk?: boolean }} options
 * @returns {object[]}
 */
export function rankArxivResults(items, { tokens, phrase = '', limit = 20, abstractOk = false } = {}) {
  const scored = [];
  for (const item of items) {
    const inTitle = tokenCoverage(item?.title, tokens);
    const passes = inTitle >= 1
      || (abstractOk && tokenCoverage(`${item?.title ?? ''} ${item?.abstract ?? ''}`, tokens) >= 1);
    if (!passes) continue;
    let score = inTitle;
    // 整段标题短语都出现在标题里 ⇒ 几乎肯定就是这篇，顶到最前。
    if (phrase !== '' && String(item?.title ?? '').toLowerCase().includes(phrase)) score += 0.35;
    scored.push({ item, score });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, Math.max(1, limit)).map((entry) => entry.item);
}

/**
 * 这次搜索该发哪几条查询（精确度高 → 低）。
 *
 * ★ **不再拼「裸 `all:` 多词」**（0.90.0）。实测那是**或**语义：
 *   `all:LANGUAGE MODEL HARNESSES CAN BE COMPOSITIONAL GENERALIZERS` 返回的是
 *   「DeformSmith」「WizardLM」「Zero-Shot Sign Language」—— 只沾一个词的论文。
 *   用户报的「太笼统、太模糊」就是它。
 * ★ 标题短语（`ti:"…"`）排第一：粘标题来搜是主用法。实测
 *   `ti:"Attention Is All You Need"` 前三条都对得上，而 `all:` 会掺进
 *   「Not All Attention Is All You Need」这类只共词的。
 * ★ 第二档用逐词 `AND`（不用短语）：用户的输入常带副标题、作者、年份，
 *   短语一严格就 0 命中；而逐词 AND 的返回实测是同一主题的论文，能兜住。
 *
 * @returns {Array<{ query: string, abstractOk: boolean }>}
 */
export function arxivQueryPlan(text) {
  const tokens = queryTokens(text);
  if (tokens.length === 0) return [];
  if (tokens.length === 1) return [{ query: `all:${tokens[0]}`, abstractOk: true }];
  const phrase = queryPhrase(text);
  const tiers = [];
  // ★ 短语用**原句**（含 `for` / `can be` 这类词），不是过滤后的词表：短语要的是
  //   连续性，把中间的 `for` 抠掉之后「Sparse Routing for Long Documents」就不再
  //   是标题里的那串字，`ti:` 直接 0 命中。
  if (phrase !== '') tiers.push({ query: `ti:"${phrase}"`, abstractOk: false });
  tiers.push({ query: tokens.map((token) => `all:${token}`).join(' AND '), abstractOk: true });
  return tiers;
}

/** 发一次 arXiv 检索，把 Atom 解成条目。限流时由 `fetchTextRetry` 重试一次。 */
async function fetchArxivFeed(searchQuery, maxResults) {
  const url = 'https://export.arxiv.org/api/query?search_query='
    + encodeURIComponent(searchQuery)
    + `&start=0&max_results=${maxResults}`
    + `&sortBy=relevance&sortOrder=descending&mailto=${MAILTO}`;
  const xml = await fetchTextRetry(url, { accept: 'application/atom+xml, application/xml' });
  const root = parseXml(xml);
  const feed = localName(root.tag) === 'feed' ? root : find(root, 'feed');
  return childrenOf(feed, 'entry').map(entryToPaper).filter((item) => item !== null);
}

/**
 * 检索：编号/链接 → 精确命中；自由词 → 两档查询 + 本地严格筛选。
 *
 * ★ 用户粘的是**链接**时绝不走全文检索：`all:"https://…"` 只会查到 0 条，
 *   然后界面上一句「没找到」，而他手里明明有能打开的那一页。
 *
 * @param {string} query - 自由词、arXiv 编号、alphaXiv 链接/slug。
 * @param {{ limit?: number }} [options]
 * @returns {Promise<object[]>}
 */
export async function searchArxiv(query, { limit = 20 } = {}) {
  const text = cleanText(query, 300);
  if (text === '') return [];
  const arxivId = normalizeArxivId(text);
  if (arxivId !== '') return [await arxivById(arxivId)];
  const slug = normalizeAlphaXivSlug(text);
  // ★ 认出来了就必须查通，不退回关键词：slug 当关键词搜只有 0 条，
  //   而「页面打不开」是另一件要如实告诉用户的事。
  if (slug !== '') return [await alphaXivBySlug(text)];

  const tokens = queryTokens(text);
  // 排序加分用**原句短语**（与 `ti:` 那一档同一口径）：标题里连着出现这串字，
  // 基本就是同一篇。
  const phrase = queryPhrase(text);
  for (const tier of arxivQueryPlan(text)) {
    const items = await fetchArxivFeed(tier.query, Math.min(50, Math.max(10, limit * 2)));
    const ranked = rankArxivResults(items, { tokens, phrase, limit, abstractOk: tier.abstractOk });
    if (ranked.length > 0) return ranked;
  }
  return [];
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

/** HTML 实体还原（`&amp;` / `&#39;` / `&quot;` …）。`&amp;` 最后做，避免二次解码。 */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (whole, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (whole, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 取页面里所有同名 `<meta name|property="key" content="…">` 的 content。
 *
 * ★ 标签内部用「引号内不吃 `>`」的分支来匹配：标题里出现 `>`（`Harness>2`）时，
 *   朴素的 `<meta[^>]*>` 会在那里截断，`content` 就取不到了。
 */
function metaContents(html, key) {
  const tag = new RegExp(`<meta\\b(?:[^>"']|"[^"]*"|'[^']*')*?(?:name|property)=["']${key}["'](?:[^>"']|"[^"]*"|'[^']*')*?>`, 'gi');
  const out = [];
  for (const match of String(html ?? '').match(tag) ?? []) {
    const content = /content=["']([^"']*)["']/i.exec(match);
    if (content !== null) out.push(decodeEntities(content[1]));
  }
  return out;
}

/**
 * 认出 alphaXiv 的论文页地址 / slug。
 *
 * 接受 `https://www.alphaxiv.org/abs/2611.harness-cg`、
 * `https://www.alphaxiv.org/pdf/2611.harness-cg`（0.90.2：**`/pdf/` 也是论文 URL**，
 * 用户 2026-11-22 现场给的正是这一条 —— 旧实现只认 `/abs|overview/`，它掉到兜底
 * 当标题搜，又导进了一篇无关论文）、带 `.pdf` 的直链、带 `?`/`#` 的分享链接，
 * 以及**裸 slug**（`2611.harness-cg`）。
 *
 * ★ 为什么不能把它当 arXiv 编号：alphaXiv 的 slug 形状是「YYMM.可读后缀」，
 *   而 `2611` 这个前缀长得跟 arXiv 的 `YYMM.序号` 一模一样。判据放在**点后面
 *   是不是以字母开头**：`2611.12345` 是 arXiv 的，`2611.harness-cg` 是 alphaXiv 的。
 *   混为一谈的后果是「有 arXiv 编号的那类」被当成 slug 去抓页面，反之亦然。
 *
 * @returns {string} 归一后的 slug；不是 alphaXiv 的地址就是空串。
 */
export function normalizeAlphaXivSlug(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return '';
  const stripped = raw
    .replace(/^https?:\/\/(?:www\.)?alphaxiv\.org\/(?:abs|overview|pdf)\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\.pdf$/i, '')
    .replace(/^\/+/, '')
    .trim();
  return /^\d{4}\.[a-z][a-z0-9-]{0,60}$/i.test(stripped) ? stripped : '';
}

/**
 * alphaXiv 论文页 → 论文记录（**纯函数**，拿一段 HTML 就能跑，可离线单测）。
 *
 * ★ 解析的是 Google Scholar 那套 Highwire 标签，不是页面上的 React 数据：
 *   后者是 `$R[27]={title:…}` 这种序列化产物，键名与嵌套随时会变，而
 *   `citation_*` 是给索引器看的公开契约，改它等于把自己的页面从学术检索里摘出去。
 * ★ 判断「这页是不是论文页」只看 `citation_title` **有没有**：不存在的 slug
 *   会回一个 404 的框架页（实测 68 KB），里面一个 `citation_*` 都没有 ——
 *   没有标题就返回 `null`，比抛异常更好测。
 * ★ 摘要取 `citation_abstract`，没有就退到 `og:description`（alphaXiv 实测只给后者，
 *   是摘要的开头一段，够速读卡显示）。
 *
 * @returns {object|null} 不是论文页就返回 null。
 */
export function paperFromAlphaXivHtml(html, slug) {
  const page = String(html ?? '');
  const title = cleanText(metaContents(page, 'citation_title')[0], 400);
  if (title === '') return null;
  const authors = metaContents(page, 'citation_author')
    .map((name) => cleanText(name, 120))
    .filter((name) => name !== '');
  const date = metaContents(page, 'citation_publication_date')[0] ?? metaContents(page, 'citation_date')[0] ?? '';
  const year = Number(String(date).slice(0, 4));
  const pdfUrl = cleanText(metaContents(page, 'citation_pdf_url')[0], 600)
    // 页面一定会给 `citation_pdf_url`；万一没给，alphaXiv 的 PDF 就是同一路径加 `.pdf`。
    || `https://www.alphaxiv.org/abs/${slug}.pdf`;
  return {
    key: `alphaxiv:${slug}`,
    source: 'alphaxiv',
    // 有 arXiv 编号的那一类，页面会带 `citation_arxiv_id`（实测 1706.03762 有）。
    arxivId: normalizeArxivId(metaContents(page, 'citation_arxiv_id')[0] ?? ''),
    title,
    authors,
    abstract: cleanText(
      metaContents(page, 'citation_abstract')[0] ?? metaContents(page, 'og:description')[0] ?? '',
      20_000,
    ),
    year: Number.isInteger(year) && year > 1900 ? year : 0,
    // 不把 `alphaXiv` 写进 venue：venue 是要进 BibTeX 的 `journal` 字段的，
    // 写成「alphaXiv」等于给一条不存在的期刊。界面那边按 `source` 显示来源。
    venue: cleanText(metaContents(page, 'citation_journal_title')[0], 200),
    categories: [],
    url: `https://www.alphaxiv.org/abs/${slug}`,
    pdfUrl,
    doi: normalizeDoi(metaContents(page, 'citation_doi')[0] ?? ''),
  };
}

/**
 * 按 alphaXiv 地址取一条元数据。
 *
 * ★ 页面自己报了 arXiv 编号时**以 arXiv 为准**（再查一次）：arXiv 那边有真实的
 *   `published` 日期、分类、`journal_ref`，而 alphaXiv 的 `citation_publication_date`
 *   是它自己录入的（实测「Attention Is All You Need」写成 2023/8/2，实际 2017）。
 *   arXiv 抽风时才退用页面元数据 —— 宁可年份略有偏差，也不要导不进来。
 */
export async function alphaXivBySlug(input) {
  const slug = normalizeAlphaXivSlug(input);
  if (slug === '') throw new Error(`认不出这个 alphaXiv 地址：${String(input)}`);
  let html;
  try {
    html = await fetchTextRetry(`https://www.alphaxiv.org/abs/${slug}`, {
      accept: 'text/html,application/xhtml+xml',
      // 实测论文页 300–350 KB（首页 1.2 MB），6 MB 是安全阀。
      maxBytes: 6 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`打不开 alphaXiv 页面（${slug}）：${error?.message ?? String(error)}`);
  }
  const paper = paperFromAlphaXivHtml(html, slug);
  if (paper === null) throw new Error(`alphaXiv 上没有这篇：${slug}`);
  if (paper.arxivId !== '') {
    try { return await arxivById(paper.arxivId); } catch { /* arXiv 抽风就用页面元数据 */ }
  }
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
 * ★ 顺序有意义：**先认 arXiv**（能直接拿到 PDF），再认 alphaXiv（有 arXiv 编号的
 *   页面会被它里面的 `citation_arxiv_id` 送回 arXiv），再认 DOI（可能只有元数据），
 *   最后才当成自由词。反过来的话，一个长得像 DOI 的 arXiv 链接会被送到 Crossref
 *   去查一个不存在的 DOI。
 */
export async function resolvePaperInput(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') throw new Error('给一个 arXiv 编号、alphaXiv 链接、DOI 或论文标题');

  const arxivId = normalizeArxivId(text);
  if (arxivId !== '') return await arxivById(arxivId);

  /**
   * alphaXiv（0.90.0）。
   *
   * ★ 用户 2026-11-22 的现场：`https://www.alphaxiv.org/abs/2611.harness-cg`
   *   在「导入」里回「没找到」—— 因为那篇论文**没有 arXiv 编号**
   *   （页面里写着 `arxivId:null`），是 alphaXiv 自己发的。只认 arXiv 的实现
   *   永远导不进这一类，而它们恰恰只能在 alphaXiv 上拿到。
   * ★ 认出来就必须走这条路：不认的话它会掉到下面的自由词检索，
   *   把整条 URL 当关键词去问 arXiv，结果是 0 条 + 一句误导人的「没找到」。
   */
  const slug = normalizeAlphaXivSlug(text);
  if (slug !== '') return await alphaXivBySlug(text);

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

  /**
   * 认不出的 URL 不能当关键词：`all:"https://…"` 必然是 0 条，而用户会得到
   * 一句「没找到」，之后既不知道该换什么词，也不知道自己给的东西没被理解。
   */
  if (/^https?:\/\//i.test(text)) {
    throw new Error('这个链接暂时认不出来。目前支持 arXiv 论文页、alphaXiv 论文页和 DOI 链接。');
  }

  /**
   * 兜底：用户粘的是**标题**。这里绝不能取搜索第一名（0.90.2 修的真缺陷）。
   *
   * ★ 搜索求召回，导入求精确：粘《Language Model Harnesses Can Be Compositional
   *   Generalizers》，搜索会返回一篇摘要里沾了 language / model / compositional 的
   *   「Weak-to-Strong Compositional Learning…」，旧代码取 found[0] 就把它导进来了。
   *   导错比导不到糟 —— 用户会拿错的论文写读后感，而且很难自查。
   * ★ 改为：多取几条候选（limit 8），逐条用 `isTitleExactMatch` 双向比对，
   *   **只有标题与输入指向同一篇才导入**；否则如实报「没找到」。用户手里的标题
   *   多半略有出入（副标题、大小写、复数），判据用 `sameWord` 容这些形态差异，
   *   但绝不容「换了另一篇论文」。
   */
  const candidates = await searchArxiv(text, { limit: 8 });
  const exact = candidates.find((item) => isTitleExactMatch(text, item.title));
  if (exact === undefined) {
    /**
     * ★ 说清「为什么没找到」和「还能怎么办」：论文只在 alphaXiv 上（没有 arXiv
     *   编号）是常见情况，而那句话正好是用户下一步要做的动作。
     * ★ 顺带告诉用户「按标题导入要一字不差」：他粘的标题可能只是少了个副标题，
     *   不给这句话他会以为插件搜不到，其实换个写法就能命中。
     */
    throw new Error(`没有找到标题完全匹配的论文「${text}」。按标题导入需要标题一致（大小写、复数不看）；如果标题有出入，或这篇只在 alphaXiv 上发表（没有 arXiv 编号），把它的论文页链接贴进来最准。`);
  }
  return exact;
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
  /**
   * alphaXiv 来的论文既没有 DOI 也没有 arXiv 编号，只能从它自己的页面补
   * （0.90.0）。`key` 里存着 slug，`url` 是页面地址 —— 两处任一能认出来就行。
   */
  if (fetched === null) {
    const slug = normalizeAlphaXivSlug(paper?.url ?? '')
      || normalizeAlphaXivSlug(String(paper?.key ?? '').replace(/^alphaxiv:/i, ''));
    if (slug !== '') {
      try { fetched = await alphaXivBySlug(slug); } catch { fetched = null; }
    }
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
