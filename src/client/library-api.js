/**
 * 书架的浏览器侧客户端：**走 HTTP**，不走 Remote/Gateway。
 *
 * 为什么不能走 Remote：pdf.js 只会说 HTTP。它要发 `Range`、要看 `206` 与
 * `Content-Range`。而本插件用的那版 pdf.js 里 `validateRangeRequestCapabilities()`
 * **硬要求 `Content-Length`**，宿主转发又会把 `content-length` 扣掉 ⇒ 任何「给 pdf.js
 * 一个 URL 让它自己取」的路都会静默退化成「把整本拖下来」。所以字节必须由我们自己取、
 * 自己喂给 pdf.js，而最自然的取字节通道就是本机 HTTP + Range。
 *
 * 路径全部用**相对路径**：renderer 的原点是自定义协议 `dsh-app://app`，相对路径会被
 * Electron 主进程转发给宿主（并补上 Host cookie），所以这里不需要知道端口。
 */
import { LIBRARY_API_PREFIX } from '../library.js';

const TIMEOUT_MS = 20_000;

/** 带超时 + 错误正文的 JSON 请求。 */
async function jsonRequest(path, init = {}, { timeoutMs = TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /**
   * ★ 外部取消（用户点「暂停」）必须也能掐断这条请求。
   *
   * 以前只有一个内部 controller 管超时，外部没有任何办法主动中止 ——
   * 于是「暂停翻译」只能做成「UI 上假装停了，请求继续跑到 3 分钟超时」：
   * 模型照样烧完、缓存照样写进去，用户以为省下了钱。
   * `AbortSignal` 不能相加，只能把外部那条挂到内部来。
   */
  const onAbort = () => controller.abort();
  if (signal instanceof AbortSignal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(`${LIBRARY_API_PREFIX}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      cache: 'no-store',
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch { body = null; }
    if (!response.ok || body?.ok === false) {
      // 宿主返回的 error 是给用户看的中文说明（比如「书单不是合法 JSON」），优先用它。
      throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`);
    }
    return body;
  } catch (error) {
    // ★ 先判外部取消：超时与暂停都走 `AbortError`，顺序反了会把「你按了暂停」
    //   报成「请求超时（180 秒）」，用户会以为是插件的问题。
    if (signal?.aborted) {
      const paused = new Error('已暂停');
      paused.code = 'PAUSED';
      throw paused;
    }
    if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal instanceof AbortSignal) signal.removeEventListener('abort', onAbort);
  }
}

/** 书单 + 索引来源信息。 */
export async function fetchBooks() {
  return await jsonRequest('/books');
}

/**
 * 缓存占用（设置页「存储」卡）。
 *
 * ★ 返回的是**三类分开**的体积（解读缓存 / 网盘块缓存 / 备份文件）+ 上限，
 *   不是一个总数：用户要知道该清哪个。
 */
export async function fetchCacheUsage() {
  return await jsonRequest('/cache');
}

/**
 * 清理可重算的缓存（备份文件 + 抽出的正文 / OCR）。
 *
 * ★ 已生成的解读**不会**被删 —— 那是花模型调用换来的。所以这个按钮可以放心点。
 */
export async function cleanCache() {
  return await jsonRequest('/cache/clean', { method: 'POST' });
}

/** 全部阅读进度。 */
export async function fetchStates() {
  const body = await jsonRequest('/state');
  return body.states ?? {};
}

/** 写一本书的阅读状态。 */
export async function saveBookState(id, patch) {
  const body = await jsonRequest('/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...patch }),
  });
  return body.state;
}

/** 丢掉宿主的书单缓存重新读一遍（用户刚在自己的工具里整理完书单时用）。 */
export async function reloadLibrary() {
  return await jsonRequest('/reload', { method: 'POST' });
}

/**
 * 取 `[begin, end)` 这段字节。
 *
 * ★ `end` 是**开区间** —— 这是 pdf.js 的约定（它内部发的是 `bytes=${begin}-${end - 1}`）。
 *   传闭区间会让每段都多读一个字节，段与段之间就会重叠，页面上看不出来，
 *   但底层拼出来的流是错的。
 *
 * ★ 0.24.4 两条硬约束（此前都没有）：
 *
 *   ① **只收 206**。以前 `206 || 200` 都收 —— 而 200 意味着「服务端忽略了 Range、
 *      把整个文件返回来了」。那一段会被当成「从 begin 开始的这一片」塞给 pdf.js：
 *      字节数对不上时它报的是解析错误（离真实原因十万八千里），对得上时更糟 ——
 *      整本书被当成第一页，翻页全乱。宁可在这里报一句人话。
 *   ② **超时**。以前只接外部 signal（pdf.js 取消时才有），网络卡住就永远挂着，
 *      用户看到的是「这本书一直在转圈」，而代码里没有任何一处会放弃。
 *      超时与外部 signal 是**两个方向**的取消，必须分开报错：一个是「太慢」，
 *      一个是「用户不要了」—— 后者不该显示成超时。
 *
 * ★ 顺带校验 `content-range` 的起点：宿主自己实现的 `contentRange()` 一定对得上，
 *   这条守的是「以后换成别的取字节通道」时不会静默喂错段。
 */
export async function fetchBookRange(bookId, begin, end, signal, { timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /* 外部 signal（pdf.js 取消）与超时合并：任一个触发都中断这次请求。 */
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    // ★ 已经取消就别发请求：真 fetch 会自己 reject，但这一句省掉一次无意义的
    //   往返，也让「取消后一个请求都不发」成为可断言的行为（不是靠 fetch 实现）。
    if (controller.signal.aborted) throw new Error('取书已取消');
    const response = await fetch(`${LIBRARY_API_PREFIX}/book/${bookId}/raw`, {
      headers: { Range: `bytes=${begin}-${end - 1}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status === 200) {
      throw new Error('取书失败：服务端忽略了 Range 请求（返回 200 整本），分片通道不可用');
    }
    if (response.status !== 206) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body?.error === 'string') detail = body.error;
      } catch { /* 非 JSON 就用手上的状态码 */ }
      throw new Error(`取书失败：${detail}`);
    }
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
      const match = /bytes\s+(\d+)-(\d+)\//i.exec(contentRange);
      if (match && Number(match[1]) !== begin) {
        throw new Error(`取书失败：服务端返回的区间不对（要 ${begin} 起，给的是 ${contentRange}）`);
      }
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    // ★ 只有「超时」才改写成超时文案；pdf.js 主动取消（signal.aborted）保持原样。
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(`取书超时（${timeoutMs / 1000} 秒）：${bookId}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', forwardAbort);
  }
}

// ---- 重排电子书（EPUB / MOBI / AZW3 / TXT）-------------------------------

/**
 * 一本书的「目录 + 分节索引」：`{ format, title, author, warnings, toc, sections }`。
 *
 * `sections` 只有元信息（`title / chars / href`），**正文不在里面** —— 一本 25 万字的
 * 书 JSON 化之后上兆，而用户打开时只看第一节。正文由 `fetchEbookSection` 按需取。
 *
 * ★ 超时给到 2 分钟：宿主第一次见到这本书要「取整本字节 → 解 ZIP/LZ77 → 抽块 → 落盘
 *   缓存」。实测 EPUB 412 KB 用 30 ms、MOBI 2.5 MB 用 24 ms，但网盘书要先把整本
 *   拉下来（2.5 MB 走网盘 SDK 可能十几秒），20 秒的默认值会卡在「就差一点」的地方。
 * ★ 第二次开同一本书走缓存，是毫秒级 —— 两者共用一个超时是可以接受的。
 */
export async function fetchEbookIndex(bookId, { timeoutMs = 120_000 } = {}) {
  return await jsonRequest(`/book/${encodeURIComponent(bookId)}/ebook`, {}, { timeoutMs });
}

/**
 * 取第 `n` 节（1 起）的块模型：`{ n, title, chars, blocks }`。
 *
 * `blocks` 是 `{ k: 'h1'|'h2'|'h3'|'p'|'q'|'li'|'pre', x: string }` 的数组 ——
 * 渲染端用 React 元素重建，**不用 `dangerouslySetInnerHTML`**，所以书里的任何
 * 标记都进不了 DOM（XSS 面为零）。
 *
 * ★ 节号从 1 起：目录里的 `section` 与 `pages.jsonl` 里的 `page` 是同一个数
 *   （电子书的「一页」就是「一节」），少一层 ±1 转换就少一处偏移 bug。
 */
export async function fetchEbookSection(bookId, n, { timeoutMs = 30_000 } = {}) {
  return await jsonRequest(`/book/${encodeURIComponent(bookId)}/ebook/section/${Number(n)}`, {}, { timeoutMs });
}

/**
 * 某一节的**对照译文**（只读缓存）。
 *
 * 返回 `{ n, available, entries: [[块下标, 译文]], coverage, model }`。
 * ★ `available: false` 是**正常状态**（这一节还没翻过），不是错误：
 *   界面据此决定「要不要发那个几十秒的翻译请求」。把它当错误抛出去会让每次
 *   打开对照都先弹一条红字。
 */
export async function fetchEbookTranslation(bookId, n, { timeoutMs = 20_000 } = {}) {
  return await jsonRequest(`/book/${encodeURIComponent(bookId)}/ebook/l10n/${Number(n)}`, {}, { timeoutMs });
}

/** 这本书已经译过哪些节（工具栏上「已译 3 节」）。 */
export async function fetchEbookTranslationIndex(bookId, { timeoutMs = 20_000 } = {}) {
  return await jsonRequest(`/book/${encodeURIComponent(bookId)}/ebook/l10n`, {}, { timeoutMs });
}

/**
 * 真去翻这一节。
 *
 * ★ 超时给到 5 分钟：一节通常是几千字（一批），但长节会切成多批，而模型
 *   逐批回来；`ai.js` 那侧的单次上限本来就是 10 分钟。比它短的话，界面会先
 *   报「请求超时」，而宿主那边其实还在跑、还会把结果写进缓存 —— 用户重试时
 *   看到的是一份「凭空出现」的译文。
 */
export async function postEbookTranslation(bookId, n, { force = false, timeoutMs = 300_000 } = {}) {
  return await jsonPost(`/book/${encodeURIComponent(bookId)}/ebook/l10n`, { n: Number(n), force }, { timeoutMs });
}

/**
 * 整本预翻的进度（0.59.0）。
 *
 * ★ 轮询用**短超时**：它是每秒一次的状态查询，一个慢请求不该把界面拖住。
 *   超时就当作「这一拍没拿到」，下一拍继续 —— 进度条宁可晚半秒，也不要卡死。
 * ★ 没在跑时也会回一份（`state: 'idle'` 或 `'done'`，来自磁盘），
 *   界面靠它画「已译 3 / 14 节」的初始值，不需要另一个接口。
 */
export async function fetchEbookPrefetch(bookId, { timeoutMs = 15_000 } = {}) {
  return await jsonRequest(`/book/${encodeURIComponent(bookId)}/ebook/l10n/prefetch`, {}, { timeoutMs });
}

/**
 * 开 / 停整本预翻。
 *
 * ★ `action` 必须显式给，没有默认值：host 那侧拒绝缺省的请求，就是怕一个拿错
 *   body 的调用悄悄花掉几十次模型调用。
 * ★ 超时给 60 秒：启动时要先解析整本（冷启动一本 100 MB 的 EPUB 也就十几秒）。
 */
export async function postEbookPrefetch(bookId, action, { timeoutMs = 60_000 } = {}) {
  return await jsonPost(`/book/${encodeURIComponent(bookId)}/ebook/l10n/prefetch`, { action: String(action) }, { timeoutMs });
}

/**
 * 书内搜索：在**全书正文**里找一处词，回 `{ query, total, truncated, sections, blocks,
 * chars, hits: [{ n, sectionTitle, block, start, end, snippet }] }`。
 *
 * ★ `start / end` 是**块内偏移**（不是节内偏移）：高亮落在那一块文字上，而块
 *   （`data-block`）是渲染端唯一稳定的定位单位。
 * ★ 判据（trim + 小写 + 子串，不分词）在宿主侧的 `src/book-find.js` 里，与
 *   `book_search` 工具共用 —— 见那个文件顶部为什么必须共用。
 * ★ 输入即搜，所以超时按「一次本机 HTTP + 一次可能的解析缓存命中」给：首次打开
 *   一本要解压的书时，解析本身可能几十秒（与 `fetchEbookIndex` 同因），之后的检索
 *   是毫秒级。共用同一个上限比让用户看到两次不同的超时文案更清楚。
 */
export async function fetchEbookFind(bookId, query, { timeoutMs = 120_000 } = {}) {
  const q = encodeURIComponent(String(query ?? ''));
  return await jsonRequest(`/book/${encodeURIComponent(bookId)}/ebook/find?q=${q}`, {}, { timeoutMs });
}

/**
 * 电子书一步到位抽取 + 分段（不走浏览器侧 pdf.js 那条循环）。
 *
 * 与 PDF 的 `postDigestPages` + `postDigestSegment` 两步相比，这里只有一步：
 * 正文本来就是宿主解析出来的，没有「渲染进程边读边 POST」的必要。
 *
 * 返回 `{ chapters, pages, mode, format, sections }`。
 * ★ 超时给到 5 分钟：宿主要把缓存里的块展开成 `pages.jsonl`（几十万字）再跑分段，
 *   与 `postDigestSegment` 同量级。
 */
export async function postDigestEbook(bookId, { timeoutMs = 300_000 } = {}) {
  return await jsonPost(`/digest/${encodeURIComponent(bookId)}/ebook`, {}, { timeoutMs });
}

// ---- 书源配置与网盘授权向导 -------------------------------------------

/** 带 JSON body 的 POST（少写几遍 header）。 */
function jsonPost(path, body, options) {
  return jsonRequest(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }, options);
}

/**
 * 划词翻译：把阅读器里选中的一段原文交给宿主，拿回中文。
 *
 * ★ 超时给到 3 分钟：一次划词正常几秒，但宿主那条链路和「逐章解读」共用
 *   `agentDefaultModel` —— 用户切到推理模型时，一段长公式推导能跑上一分钟。
 *   20 秒的默认值会让它稳定报超时，而表现是「翻译功能时好时坏」。
 * ★ 失败文案直接用宿主回的那句（它写的是人话：模型没配 / 限流 / 超时）。
 */
export async function postTranslatePassage({ text, context = '' }, { timeoutMs = 180_000 } = {}) {
  return await jsonPost('/translate', { text, context }, { timeoutMs });
}

/**
 * 页级按需翻译（D 档）：整页若干段**一次**交模型，返回 `[{id, text}]`。
 *
 * ★ 超时同样给 3 分钟：一页十几段比一次划词长得多，但仍是单次请求；
 *   用划词那个 20 秒默认值会在模型刚开始生成时就把请求掐掉。
 * ★ `signal` 透传给 `fetch`：用户点「暂停」时这条请求会被真的掐断，
 *   而不是跑满 3 分钟再丢结果（那样模型费照付、缓存照写）。
 */
export async function postTranslatePage(paragraphs, { timeoutMs = 180_000, signal } = {}) {
  return await jsonPost('/translate-page', { paragraphs }, { timeoutMs, signal });
}

/**
 * PDF 页译文缓存（0.71.0）：逐页按需与整本一次翻完共用这一份。
 *
 * ★ 读整本是一次 GET：打开书时拉回「哪些页已经译过」，整本模式据此跳过；
 *   写一页是一次 POST，绝不做整本覆盖（另一个窗口刚译完的页会被旧快照抹掉）。
 * ★ 缓存路由没接上（501）时调用方要当**软失败**：译文照样显示，只是不落盘。
 */
export async function fetchPageTranslations(bookId, { timeoutMs = 30_000 } = {}) {
  const body = await jsonRequest(`/page-translation/${encodeURIComponent(bookId)}`, {}, { timeoutMs });
  return body?.pages ?? {};
}

export async function putPageTranslation(bookId, { page, paragraphs, translations }, { timeoutMs = 30_000 } = {}) {
  return await jsonPost(`/page-translation/${encodeURIComponent(bookId)}`,
    { op: 'put', page, paragraphs, translations }, { timeoutMs });
}

export async function clearPageTranslations(bookId, { timeoutMs = 30_000 } = {}) {
  return await jsonPost(`/page-translation/${encodeURIComponent(bookId)}`, { op: 'clear' }, { timeoutMs });
}

/** 书源配置 + 每份书单 + 载入选择 + 外部书单 + 网盘授权状态。 */
export async function fetchSources() {
  return await jsonRequest('/sources');
}

/** 换一套书源。宿主会走 `normalizeBookSources` 再落盘（坏的条目丢掉、不报错）。 */
export async function saveSources(sources) {
  return await jsonPost('/sources', { sources });
}

/**
 * 扫描书源 → 生成书单。
 *
 * ★ 超时给到 5 分钟（默认 20 秒）：这一步要真的走磁盘、或者在网盘上列一棵
 *   1400 本的目录树，20 秒必然超时 —— 而超时的表现是「点了没反应」，用户会反复点。
 *
 * @param id - 只生成这一条源；不给就全部生成。
 */
export async function scanSources(id) {
  return await jsonPost('/sources/scan', id ? { id } : {}, { timeoutMs: 300_000 });
}

/** 换一套「已载入哪几份书单」。ids 为**全量**（不是增量）。 */
export async function loadLists(ids) {
  return await jsonPost('/lists/load', { ids });
}

/** 存网盘 AppKey / SecretKey。 */
export async function savePanApp(appKey, secretKey) {
  return await jsonPost('/pan/app', { appKey, secretKey });
}

/** 自检 AppKey（不消耗授权码）并拿授权地址。 */
export async function requestPanAuthorize() {
  return await jsonPost('/pan/authorize');
}

/** 用授权码换 token。 */
export async function submitPanCode(code) {
  return await jsonPost('/pan/token', { code });
}

/** 解除网盘授权（保留 AppKey，换一次授权码就能再用）。 */
export async function panLogout() {
  return await jsonPost('/pan/logout');
}

/** 列网盘目录（目录选择器用）。 */
export async function listPanDirs(path) {
  return await jsonRequest(`/pan/dirs?path=${encodeURIComponent(path)}`);
}

// ---- 本书解读（抽取 → 分段）-------------------------------------------

/**
 * 一本书的解读状态：`{ meta, outline }`。
 *
 * `meta` 为 null 就是「还没解读」。**不存在 `digested: true` 这种字段** ——
 * 进度由 `meta.chapters[].status` 聚合，19 章挂 1 章时界面显示 18/19。
 */
export async function fetchDigestStatus(bookId) {
  return await jsonRequest(`/digest/${encodeURIComponent(bookId)}/status`);
}

/**
 * 落盘一批页。
 *
 * ★ 超时给到 2 分钟（默认 20 秒）：一次 20 页、每页上千字，走本机 HTTP 通常
 *   几十毫秒，但宿主这时可能正在做别的写盘（阅读进度、书单缓存），排队排到
 *   20 秒是可能的。超时的表现是「抽到一半报错」，用户会以为书有问题。
 */
export async function postDigestPages(bookId, pages) {
  return await jsonPost(`/digest/${encodeURIComponent(bookId)}/pages`, { pages }, { timeoutMs: 120_000 });
}

/**
 * 抽完之后算章节：宿主读回全部页 → 分段 → 写 `outline.json` + 按章切原文。
 *
 * ★ 超时给到 5 分钟：这一步要读回整本 `pages.jsonl`（几百 KB 到 2 MB）、跑分段、
 *   再写 N 个章节文件。它是纯 CPU + 本地磁盘，正常几秒，但一本 1000 页的书
 *   加上磁盘慢的时候，20 秒是不够的。
 */
export async function postDigestSegment(bookId, payload) {
  return await jsonPost(`/digest/${encodeURIComponent(bookId)}/segment`, payload, { timeoutMs: 300_000 });
}

/**
 * 丢掉这本书的抽取产物（「重新抽取」用：书换过文件，或者上次抽到一半坏了）。
 *
 * ★ 只删这本书自己的目录。宿主侧的 `remove()` 里 bookId 已经过 `isBookId` 校验，
 *   拼不出别的路径。
 */
export async function resetDigest(bookId) {
  return await jsonPost(`/digest/${encodeURIComponent(bookId)}/reset`, {});
}

/**
 * 启动逐章生成解读。
 *
 * ★ 这个请求**立刻返回**（`{ started: true }`），生成跑在宿主后台 ——
 *   一本 30 章的书要几分钟，没有哪个浏览器请求会等它。
 *   之后靠 `fetchDigestStatus` 轮询进度。
 *
 * ★ `chapters` / `model` 是**可选**的，而且「不传」与「传空」在宿主那边是两件事：
 *   - 不传 `chapters` ⇒ 跑所有还没解读的章（老行为）；
 *   - 传 `[]` ⇒ 宿主报错（勾了 0 章是调用方的 bug，不该静默跑整本）。
 *   `JSON.stringify` 会把 `undefined` 的键整条丢掉，所以「不传」在线上就是真的没有
 *   这个字段，不需要额外的哨兵值。
 */
export async function postDigestGenerate(bookId, { bookTitle = '', force = false, chapters, model } = {}) {
  return await jsonPost(`/digest/${encodeURIComponent(bookId)}/generate`, { bookTitle, force, chapters, model });
}

/** 停止生成。只对正在跑的书有效，没在跑时返回 `{ stopped: false }`，不报错。 */
export async function postDigestStop(bookId) {
  return await jsonPost(`/digest/${encodeURIComponent(bookId)}/stop`, {});
}

/**
 * 取某一章的解读正文。
 *
 * ★ 按需取、不并进 `status`：面板在生成期间每两秒轮询一次 status，
 *   而整本解读有几十 KB —— 并进去就是「每两秒传一次全书解读」，
 *   而用户此刻可能一章都没展开。
 */
export async function fetchChapterDigest(bookId, n) {
  return await jsonRequest(`/digest/${encodeURIComponent(bookId)}/chapter/${n}`);
}

// ---- 划线 / 笔记 --------------------------------------------------------

/**
 * 这本书的全部划线（按页码 + 页内偏移排序）。
 *
 * ★ 一次取全量，不分页：一页几十条也就几 KB，而「当前页的划线」是随翻页连续
 *   变化的 —— 分页取会让翻到第 200 页时先闪一下空白再出现。
 */
export async function fetchAnnotations(bookId) {
  const body = await jsonRequest(`/annotations/${encodeURIComponent(bookId)}`);
  return body.items ?? [];
}

/**
 * 增 / 改 / 删一条划线。
 *
 * ★ 返回值里的 `items` 是**整份列表**，服务端是唯一真相：本地算「加了这条之后
 *   的列表」在单窗口下没问题，但两个入口（设置面板与侧边栏浮层）同时开着时就会
 *   各自维护一份逐渐漂移的副本。
 */
export async function postAnnotation(bookId, payload) {
  return await jsonPost(`/annotations/${encodeURIComponent(bookId)}`, payload);
}

// ---- 导出成技能包 --------------------------------------------------------

/**
 * 上一次导出的结果（面板上「已导出到 …」那一行）。没导出过就是 `null`。
 *
 * ★ 「没导出过」不是错误：宿主回的是 `{ ok: true, skill: null }`，这里原样透传。
 *   把它当异常抛会让面板把「还没导出」画成红色报错。
 */
export async function fetchSkillStatus(bookId) {
  const body = await jsonRequest(`/digest/${encodeURIComponent(bookId)}/skill`);
  return body.skill ?? null;
}

/**
 * 导出一个 skill 包。
 *
 * ★ 超时给到 3 分钟（默认 20 秒）：默认路径是纯磁盘拼装（毫秒级），但
 *   `synthesize: true` 会**多跑一次模型调用**，而一次跨章综合的输入是全书要点
 *   （几万字）。20 秒必然超时，用户看到的是「导出失败」—— 而实际上包可能
 *   已经写好了（宿主那边是先调模型再写盘，超时后请求断了、写盘照常发生）。
 *
 * ★ 只传**真的有值**的字段：`model: ''` 会让宿主的 `isValidAiModel` 报
 *   「模型取值必须形如 provider/model」—— 用户明明什么都没填。
 */
export async function postExportSkill(bookId, { profile = 'auto', synthesize = false, model } = {}) {
  const payload = { profile, synthesize };
  if (typeof model === 'string' && model !== '') payload.model = model;
  return await jsonRequest(`/digest/${encodeURIComponent(bookId)}/skill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, { timeoutMs: 180_000 });
}

/**
 * 读**已经识别过**的某一页（没有就返回空串）。
 *
 * ★ 单独一条 GET 而不是「OCR 时顺带返回」：翻回上一页时不该再 OCR 一遍
 *   （0.5–1 秒 / 次，冷启动更久）。
 */
export async function fetchOcrPage(bookId, page) {
  const body = await jsonRequest(`/ocr?bookId=${encodeURIComponent(bookId)}&page=${Number(page)}`);
  return typeof body.text === 'string' ? body.text : '';
}

/**
 * 读**整本**已经识别过的页：`{ 页码: 文本 }`。
 *
 * ★ 这本书的搜索要它：扫描书的索引里，没有文字层的页要拿识别结果去填 ——
 *   一页一次 `fetchOcrPage` 是「上百次请求 + 上百次读同一份 JSON」。
 * ★ 只收正整数键、只收字符串值：这份数据来自一个**可能被手改过**的 JSON 文件，
 *   而它会被直接拼进检索文本。坏形状当没有，不抛 —— 搜索不该因为缓存脏了而失败。
 */
export async function fetchOcrPages(bookId) {
  const body = await jsonRequest(`/ocr/pages?bookId=${encodeURIComponent(bookId)}`);
  const pages = body?.pages;
  if (pages === null || typeof pages !== 'object') return {};
  const out = {};
  for (const [key, text] of Object.entries(pages)) {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1) continue;
    if (typeof text !== 'string') continue;
    if (text.trim() === '') continue;
    out[page] = text;
  }
  return out;
}

/**
 * 让宿主对**这一页的位图**做本地 OCR。
 *
 * @param {string} bookId
 * @param {number} page - 1 起。
 * @param {string} image - `data:image/jpeg;base64,…`（客户端自己渲染出来的那一页）。
 *
 * ★ 超时给 120 秒：宿主侧 `osascript` 的**第一次**调用要加载 Vision 模型，
 *   实测冷启动 26–29 秒；宿主自己的超时是 60 秒。这里必须比它更长，否则
 *   用户看到的是「请求超时」，而宿主那边其实已经识别完并写盘了。
 * ★ 发 JPEG 不发 PNG：一页 200 DPI 的扫描页 PNG 常到 3–5 MB，JPEG(q=0.85)
 *   只要 300–900 KB，而 Vision 对两者的识别结果实测一致。
 */
export async function ocrBookPage(bookId, page, image) {
  return await jsonRequest('/ocr', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId, page, image }),
  }, { timeoutMs: 120_000 });
}
