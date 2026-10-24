/**
 * 书架与阅读器的 HTTP 面。
 *
 * 为什么书架不走 Remote/Gateway 而走 HTTP：**pdf.js 只会说 HTTP**。它要发 `Range`
 * 请求、要看 `206` 与 `Content-Range`。而本插件用的那版 pdf.js 里，
 * `validateRangeRequestCapabilities()` 是**硬要求 `Content-Length`** 的：
 *
 *     const s = parseInt(responseHeaders.get("Content-Length"), 10);
 *     if (!Number.isInteger(s)) return r;        // ← 没有它，直接判定「不支持 Range」
 *
 * 而宿主把 renderer 的请求转发给本机服务时会**扣掉 `content-length`**
 * （`WITHHELD_RESPONSE_HEADERS`），所以任何走「给 pdf.js 一个 URL 让它自己去取」的路
 * 都会静默退化成「把整本拖下来」（290 MB 的书 = 灾难）。⇒ 客户端必须自己取字节、
 * 自己喂给 pdf.js（用 `PDFDataRangeTransport`），而取字节这件事最自然的通道就是
 * 本机 HTTP + Range —— 和用户已有那份阅读器同一条路。
 *
 * ★ 每条路由都过 `isTrustedLocalRequest` 栅栏：宿主派发插件路由**不经过**它自己的
 *   鉴权拦截器（先精确路由、再鉴权），所以这里漏掉就等于把「读用户本地文件」和
 *   「改阅读进度」敞开给任何能访问本机端口的东西。
 *
 * ★ 本地书这条通道（0.7.2 起）多一层风险：`/book/:id/raw` 现在可能读的是**本机文件**。
 *   挡住「顺着它读整台机器」的是 `local-books.js` 里的三道闸（配置的根目录 / realpath
 *   之后再比对 / 比对时补分隔符）。**取字节的分派不在这里** —— 路由只把 `book` 交给
 *   调用方的 `readBytes`，白名单不在这一层，避免两处各有一份判定然后慢慢漂移。
 *
 * 路由一览（都挂在 `LIBRARY_API_PREFIX` 下）：
 *
 *   GET  /books              书单 + **逐份来源状态**
 *   POST /reload             丢掉缓存重读书单
 *   GET  /state   POST /state  阅读进度
 *   GET  /annotations/:id  POST /annotations/:id   划线 / 笔记（整份读，按 op 改一条）
 *   GET  /book/:id/raw       Range 取字节（网盘或本地，由 `readBytes` 分派）
 *   GET  /sources  POST /sources   书源配置（GET 同时给出每份书单的状态与载入选择）
 *   POST /sources/scan       扫描书源 → 生成书单（body 里给 `id` 就只生成那一条源）
 *   POST /lists/load         换一套「已载入哪几份书单」
 *   POST /pan/app            存 AppKey / SecretKey
 *   POST /pan/authorize      自检 AppKey + 拿授权地址
 *   POST /pan/token          用授权码换 token
 *   POST /pan/logout         解除授权
 *   GET  /pan/dirs?path=…    列网盘目录（给目录选择器用）
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { BOOKS_PAGE_LIMIT, LIBRARY_API_PREFIX, PDFJS_VENDOR_PREFIX, isBookId, isReadable } from '../library.js';
import { contentRange, formatRange, mimeForExtension, parseRange, unsatisfiedContentRange } from '../range.js';
import { segmentBook } from './segment.js';
import { OCR_MAX_IMAGE_BYTES, decodeImagePayload, sniffImageExt } from './ocr.js';
import { isTrustedLocalRequest } from './trust.js';

// 前缀的真值在共用模块里（浏览器半区也要用）。这里转出去，方便调用点就近 import。
export { LIBRARY_API_PREFIX, PDFJS_VENDOR_PREFIX };

/** 状态写入的 body 上限。 */
const JSON_BODY_LIMIT = 64 * 1024;

/**
 * 无 Range 的请求最多为它发多少字节。
 *
 * 这类请求只可能是**探测**（pdf.js 先发一个不带 Range 的请求看 `Accept-Ranges` 和文件
 * 大小，拿到响应头就把这个响应丢掉、改用 Range 请求）。实测把它压到 256 KB，pdf.js
 * 照样正常打开 357 页的书，而打开耗时从 62 秒降到 9 秒、流量从 3.3 MB 降到 0.5 MB。
 */
const PROBE_LIMIT = 256 * 1024;

/** 小于这个体积的文件**绝不能截断** —— 客户端会把整个响应当作完整数据读走。 */
const RANGE_MIN_SIZE = 2 * 256 * 1024;

const VENDOR_MIME = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

function forbidden(res) {
  sendJson(res, 403, { ok: false, error: 'forbidden' });
}

/**
 * 「取字节失败」要回哪个状态码。
 *
 * ★ 这三种失败对用户意味着**完全不同的下一步**，所以状态码也要分开：
 *   - `LOCAL_OUTSIDE_ROOT` / `NO_LOCAL_ROOT` ⇒ **403**：这本不在你配的目录里（改设置）；
 *   - `LOCAL_MISSING` ⇒ **404**：文件没了（去磁盘上找）；
 *   - 其余 ⇒ **400**。
 *
 * 合并成一句「加载失败」的后果不是难看，而是**没法自救**：用户看着一句
 * 「解析 PDF 失败」，而真正的原因是他上周把书源目录改窄了。
 */
function readErrorStatus(error) {
  const code = error?.code ?? '';
  if (code === 'LOCAL_OUTSIDE_ROOT' || code === 'NO_LOCAL_ROOT') return 403;
  if (code === 'LOCAL_MISSING') return 404;
  // 网盘凭证类 ⇒ **401**（未授权），不是 400（请求有问题）：
  // 请求本身完全正常，缺的是授权；而用户能自救的那条路是「去设置页走一次授权向导」。
  if (code === 'NO_TOKEN' || code === 'NO_APP' || code === 'NO_REFRESH') return 401;
  // refresh_token 被用掉了（续期是一次性的）也属于「要重新授权」，同样 401：
  // 上游完全正常，缺的是授权。
  if (code === 'REFRESH_CONSUMED') return 401;
  // 续期失败是**上游**（百度）的问题，不是用户的请求有问题。
  if (code === 'REFRESH_FAILED') return 502;
  return 400;
}

async function readBody(req, limit = JSON_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed;
}

/**
 * 把 URL 路径安全地转成 vendor 目录下的相对路径。
 * 返回 undefined 表示路径非法（越界 / 编码异常），调用点一律 404。
 */
export function vendorRelativePath(pathname, prefix = PDFJS_VENDOR_PREFIX) {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest === '' || rest === '/') return undefined;
  let decoded;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return undefined;
  }
  // 反斜杠在 POSIX 上是合法文件名字符，但在 Windows 上是分隔符 —— 一律拒掉，
  // 免得同一段路径在两个平台上语义不同（这正是目录穿越最常见的入口形态）。
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const trimmed = decoded.replace(/^\/+/, '');
  const normalized = normalize(trimmed);
  if (normalized.startsWith('..') || normalized.startsWith(sep) || normalized.includes(`..${sep}`)) return undefined;
  return normalized;
}

/**
 * 造书架的 WebRoute 列表。
 *
 * 依赖全部从参数进来，所以测试里可以喂假书库、假取字节函数，**不需要联网**。
 *
 * @param handlers.listBooks - `async () => { path, books, skipped, missing, error }`
 * @param handlers.bookById - `(id) => book | undefined`
 * @param handlers.readBytes - `async (book, start, end) => Buffer`（闭区间）。
 *   **由调用方按 `book.source` 分派**（网盘走 `pan.readRange`，本地走 `local.read`）——
 *   路由层不需要知道字节是从哪来的，也不需要持有那条本地通道的根目录白名单。
 * @param handlers.verifyReadable - 可选，`async (book) => void`，在**写响应头之前**
 *   确认这本书能读；抛错则按错误码回 4xx。不接就退化成「边读边失败」的旧行为
 *   （见 `rawBook` 里那段说明：报头出去之后改不了状态码）。
 * @param handlers.getStates - `() => states`
 * @param handlers.setState - `(id, patch) => state`
 * @param handlers.reload - `async () => 同 listBooks`
 * @param handlers.vendorRoot - 内置 pdf.js 的目录绝对路径。
 * @param handlers.getSources - `async () => 整份书源 payload`（书源 + 每份书单 + 载入选择 + 外部书单 + 落点）。
 * @param handlers.setSources - `async (list) => 规范化后的书源列表`。
 * @param handlers.setLoadedLists - `async (ids) => 规范化后的已载入 id 列表`。
 * @param handlers.scanSources - `async ({ id }) => { lists, errors, stats, total }`。
 * @param handlers.panAuth - 网盘授权器（`pan-auth.js` 的 `createPanAuth`）。
 * @param handlers.listPanDirs - `async (path) => [{ name, path, isDir }]`。
 * @param handlers.log - 记一行日志。
 * @returns WebRoute 数组。
 */
export function makeLibraryRoutes(handlers) {
  const {
    listBooks, bookById, readBytes, getStates, setState, reload,
    vendorRoot, log = () => {},
    getSources, setSources, setLoadedLists, scanSources,
    panAuth, listPanDirs,
    verifyReadable,
    digestStore,
    startDigests, stopDigests, isGenerating,
    exportSkill, skillStatus,
    annotationStore,
    ocrRunner,
  } = handlers;

  /**
   * 书源那几条路由只在依赖齐了才挂。
   *
   * 为什么是「退化」而不是「报错」：本文件的测试夹具只喂了读书那条链路的依赖，而缺依赖
   * 时必须退化成 404 —— 一旦抛异常，整个 `handler` 都会挂掉，连带把 `GET /books` 也打歪
   * （界面上表现为书架一直转圈，而真正的问题在书源那一侧，谁也看不出来）。
   */
  const sourcesReady = typeof getSources === 'function' && typeof setSources === 'function'
    && typeof scanSources === 'function' && typeof setLoadedLists === 'function';
  const panReady = sourcesReady && panAuth !== undefined && panAuth !== null
    && typeof listPanDirs === 'function';

  /**
   * 解读那几条路由的依赖。缺了就退化成 501，理由同上（不能让整个 handler 挂掉）。
   *
   * ★ 逐章生成额外要求 `startDigests`：只挂了 `digestStore` 的夹具（比如只测抽取的
   *   那一组）仍然能抽目录、能读状态，但点「生成解读」会得到 501 而不是一个
   *   「started: true」然后什么也不发生 —— 后者是最糟的假象。
   */
  const digestReady = digestStore !== undefined && digestStore !== null
    && typeof digestStore.appendPages === 'function';
  const digestGenerateReady = digestReady
    && typeof startDigests === 'function' && typeof stopDigests === 'function';
  /**
   * 导出技能包的依赖。
   *
   * ★ 单独一道闸，理由同 `digestGenerateReady`：导出**不调模型**，但它会往磁盘上
   *   写一个目录。只挂了 `digestStore` 的夹具不该因为「没有导出入口」而让整个
   *   `/digest/...` 前缀变成 501 —— 抽目录、看状态、生成解读都得照常。
   */
  const skillReady = digestReady && typeof exportSkill === 'function';

  /**
   * 划线 / 笔记那两条路由的依赖。
   *
   * ★ 与解读**完全独立**的一道闸：划线是纯本地文件、不调模型、不碰书源，
   *   夹具里只喂 `annotationStore` 也能测它。缺了就 501，理由同上。
   */
  const annotationsReady = annotationStore !== undefined && annotationStore !== null
    && typeof annotationStore.list === 'function';

  /**
   * 本地 OCR 的依赖。
   *
   * ★ 两条都齐了才算接上：执行器（能不能跑）**和** `digestStore` 的 OCR 落盘
   *   （结果能不能留住）。只挂执行器的话，识别成功却存不下来 —— 用户每翻回来一次
   *   就要重识别一次，而他并不知道。
   * ★ 缺了就 501，理由同上面几道闸：不能让整个 handler 挂掉。
   */
  const ocrReady = digestStore !== undefined && digestStore !== null
    && typeof digestStore.putOcrPage === 'function'
    && ocrRunner !== undefined && ocrRunner !== null
    && typeof ocrRunner.recognize === 'function';

  /** OCR 请求体上限：base64 会把体积撑大约 1/3，再留一点 JSON 包装的余量。 */
  const OCR_BODY_LIMIT = Math.ceil(OCR_MAX_IMAGE_BYTES * 1.4) + 64 * 1024;

  const queryOf = (req) => new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;

  /**
   * 界面每次打开这一页都要的那一小撮状态：书源、每份书单、载入选择、外部书单、网盘授权。
   *
   * ★ `getSources()` 现在返回的是**整份 payload**（见 `service.libraryPayload`），
   *   而不是光秃秃的数组 —— 「名字 / 类型 / 路径」来自设置、「本数 / 生成时间」来自
   *   扫描产出的清单，这个 join 只能在宿主侧做一次。放到界面上做的话，两边各有一份
   *   join 逻辑，迟早出现「设置里改了名字、列表上还是旧的」。
   */
  const sourcesPayload = async () => ({
    ...(await getSources()),
    pan: panReady ? await panAuth.status() : null,
  });

  const bookList = async (res) => {
    const library = await listBooks();
    /**
     * 逐份书单的状态。
     *
     * ★ 0.8.0 起书架由**若干份**书单合成，所以「读到了 2634 本」这句必须能拆开：
     *   用户配了 3 个源、其中 1 个目录被挪走了，他要看到的是「甲 1204 本 / 乙 890 本 /
     *   丙 读不了：目录不存在」—— 而不是一句总数，或者一个 500。
     *   这里**不带 books**（那是 `bookList` 的事），只带状态，payload 大小与份数同阶。
     */
    const sources = (library.sources ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      path: entry.path,
      count: entry.count,
      skipped: entry.skipped,
      missing: entry.missing,
      error: entry.error,
      external: entry.external === true,
    }));
    if (library.error !== '') {
      // ★ 不返回空书架：文件写坏了与「书全没了」在界面上必须是两件事。
      //   0.8.0 起这条只在**所有**书单都读不出来时才走到 —— 一份坏掉不该把能用的书也拿走。
      return sendJson(res, 500, {
        ok: false,
        error: library.error,
        source: { path: library.path, missing: library.missing, skipped: library.skipped },
        sources,
      });
    }
    const books = library.books.slice(0, BOOKS_PAGE_LIMIT);
    return sendJson(res, 200, {
      ok: true,
      source: {
        path: library.path,
        missing: library.missing,
        skipped: library.skipped,
        bytes: library.bytes,
      },
      sources,
      total: library.books.length,
      truncated: library.books.length > books.length,
      books,
    });
  };

  const rawBook = async (req, res, id) => {
    // ★ 这里**必须 await**：真实调用方传进来的 `bookById` 是 `async` 的
    //   （`id => this.bookById(id)`，内部要等书单载入）。漏掉 await 时 `book` 是一个
    //   Promise —— `book === undefined` 为假（Promise 不是 undefined），
    //   `book.fsId` 是 `undefined`，于是**每一本书**都回 400「没有网盘 fs_id」。
    //   这个 bug 骗过了单元测试，因为夹具里的 `bookById` 是同步的（签名与真调用方不一致）
    //   —— 见 `test/library-routes.test.mjs` 里夹具改成 async 的那条注释。
    const book = await bookById(id);
    if (book === undefined) return sendJson(res, 404, { ok: false, error: '没有这本书' });
    // ★ 取字节的凭据有**两种**（网盘 `fs_id` / 本地路径），所以判据住在共用模块里
    //   （`isReadable`）。0.7.1 之前这里是硬编码的 `book.fsId > 0`，于是本地书**永远**
    //   回 400 —— 症状是「书看得见、点开就说取不到字节」，而原因藏在一条只有网盘书才
    //   满足的断言里，用户完全无从下手。
    if (!isReadable(book)) {
      return sendJson(res, 400, { ok: false, error: '这本书的书单记录里既没有网盘 fs_id 也没有本地路径，取不到字节' });
    }
    const size = book.size;
    if (!(size > 0)) return sendJson(res, 400, { ok: false, error: '这本书的体积是 0，取不到字节' });

    /**
     * ★ 报头发出去**之前**先把「这本到底能不能读」确认掉。
     *
     * 为什么必须在这个位置：下面几行就 `writeHead` + `flushHeaders` 了，而报头一旦
     * 出去就**改不了状态码**。本地书那三种失败（越界 / 文件没了 / 没配根目录）都是
     * **可预期、且用户能自救**的，必须给一个正经的 4xx。
     *
     * 不给的后果不是「难看」，而是**客户端拿到一个坏响应**：实测（真 socket）是
     * 「`206` + `content-range: bytes 0-4/N` + `content-length: 5`，然后零字节、
     * 连接被关闭」⇒ undici 抛 `TypeError: terminated`，pdf.js 报一句与真实原因
     * 毫无关系的解析错误，而用户对着「解析失败」无从下手。
     *
     * 这条检查只做路径解析（realpath + stat），**不读字节**，所以不增加可感延迟；
     * 也只在调用方接了 `verifyReadable` 时生效（网盘的失败要等直链，不值得为它预检）。
     */
    if (typeof verifyReadable === 'function') {
      try {
        await verifyReadable(book);
      } catch (error) {
        return sendJson(res, readErrorStatus(error), {
          ok: false,
          error: error.message,
          code: error.code ?? '',
        });
      }
    }

    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { 'content-range': unsatisfiedContentRange(size), 'cache-control': 'no-store' });
      return res.end();
    }
    const start = range === null ? 0 : range.start;
    const end = range === null ? size - 1 : range.end;
    const capped = range === null && size > RANGE_MIN_SIZE && PROBE_LIMIT < size;
    const last = capped ? start + PROBE_LIMIT - 1 : end;

    const headers = {
      'content-type': mimeForExtension(book.ext),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      // 即使封顶，也必须报**真实**大小：客户端靠它算 Range 偏移。
      'content-length': String(end - start + 1),
    };
    if (range !== null) headers['content-range'] = contentRange(start, end, size);
    res.writeHead(range === null ? 200 : 206, headers);
    // ★ 头必须**立刻**发出去：探测请求只等响应头，压在第一次 write 之后会让它干等。
    res.flushHeaders?.();
    if (req.method === 'HEAD') return res.end();

    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });

    let buffer;
    try {
      buffer = await readBytes(book, start, last);
    } catch (error) {
      // 报头已经发出去了，改不了状态码；只能记日志并结束响应。
      log(`[书架] ${book.id} 取 ${start}-${last} 失败：${error.message}`);
      return res.end();
    }
    if (aborted || res.writableEnded || res.destroyed) return undefined;
    if (capped) {
      // 封顶的情形：字节写出去之后主动断开。留着连接会让客户端以为「文件就读到这儿」。
      log(`[书架] ${book.id} 无 Range 探测请求：发出 ${(buffer.length / 1e6).toFixed(2)}MB / 全书 ${(size / 1e6).toFixed(2)}MB`);
      return res.write(buffer, () => res.destroy());
    }
    res.end(buffer);
    return undefined;
  };

  const vendor = async (res, relPath) => {
    const absolute = join(vendorRoot, relPath);
    // 二次确认：`vendorRelativePath` 已经拒过越界，这里再确认落点在 vendorRoot 之内。
    if (!absolute.startsWith(vendorRoot + sep)) return sendJson(res, 404, { ok: false, error: 'not found' });
    let info;
    try {
      info = await stat(absolute);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    if (!info.isFile()) return sendJson(res, 404, { ok: false, error: 'not found' });
    let body;
    try {
      body = await readFile(absolute);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    res.writeHead(200, {
      'content-type': VENDOR_MIME[extname(absolute).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(body);
  };

  const api = {
    kind: 'prefix',
    path: LIBRARY_API_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) return forbidden(res);
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const rest = pathname.slice(LIBRARY_API_PREFIX.length);
      const method = req.method ?? 'GET';

      if (rest === '/books') {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return bookList(res);
      }
      if (rest === '/reload') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        await reload();
        return bookList(res);
      }
      if (rest === '/state') {
        if (method === 'GET') return sendJson(res, 200, { ok: true, states: getStates() });
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: '需要 JSON body' });
        }
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        const id = String(body.id ?? '');
        if (!isBookId(id)) return sendJson(res, 400, { ok: false, error: '无效的书 id' });
        try {
          // 同 `bookById`：调用方给的可能是 async 的（写盘要走 store 的去抖），
          // 不 await 就既拿不到状态、又吞掉 rejection —— 客户端会收到 `state: undefined`
          // 而 `ok: true`。`await` 一个同步值也无害，所以这里一律 await。
          const state = await setState(id, body);
          return sendJson(res, 200, { ok: true, id, state });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      // ---- 本地 OCR：把扫描页变成可读的文字 ---------------------------------
      //
      // ★ 只有一个入口，而且**不收路径**：路由只接受「调用方自己编码进来的位图」，
      //   所以这里既没有路径参数、也没有目录白名单 —— 穿越面为零（见 `ocr.js` 文件头）。
      // ★ GET 用来读**已经识别过**的页：翻回上一页不该再 OCR 一遍（0.5–1 秒 / 次）。
      if (rest === '/ocr') {
        if (!ocrReady) {
          return sendJson(res, 501, { ok: false, error: '本地 OCR 没有接上（缺少 ocrRunner 或 digestStore）' });
        }
        if (method === 'GET') {
          const query = queryOf(req);
          const bookId = String(query.get('bookId') ?? '');
          const page = Number(query.get('page'));
          if (!isBookId(bookId)) return sendJson(res, 400, { ok: false, error: '无效的书 id' });
          if (!Number.isInteger(page) || page < 1) {
            return sendJson(res, 400, { ok: false, error: 'page 必须是正整数' });
          }
          const text = await digestStore.readOcrPage(bookId, page);
          return sendJson(res, 200, { ok: true, page, text, cached: text !== '' });
        }
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: '需要 JSON body' });
        }
        if (ocrRunner.supported !== true) {
          return sendJson(res, 501, { ok: false, error: ocrRunner.unavailableReason || '这台机器不支持本地 OCR' });
        }
        let body;
        try {
          body = await readBody(req, OCR_BODY_LIMIT);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        const bookId = String(body.bookId ?? '');
        const page = Number(body.page);
        if (!isBookId(bookId)) return sendJson(res, 400, { ok: false, error: '无效的书 id' });
        if (!Number.isInteger(page) || page < 1) {
          return sendJson(res, 400, { ok: false, error: 'page 必须是正整数' });
        }
        let buffer;
        try {
          buffer = decodeImagePayload(body.image);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        if (sniffImageExt(buffer) === undefined) {
          return sendJson(res, 415, { ok: false, error: '只接受 PNG / JPEG 图片' });
        }
        try {
          const result = await ocrRunner.recognize(buffer);
          const saved = await digestStore.putOcrPage(bookId, page, { text: result.text, ms: result.ms });
          return sendJson(res, 200, {
            ok: true,
            page,
            text: result.text,
            lines: result.lines,
            ms: result.ms,
            chars: result.text.replace(/\s+/g, '').length,
            saved: saved.written === true,
          });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: error.message });
        }
      }

      // ---- 划线 / 笔记 ------------------------------------------------------
      //
      // ★ 一本书一个文件（`annotations/<bookId>.json`），GET 取全量、POST 改一条。
      //   不做「全量 PUT」：客户端在本机 HTTP 上重试很常见（面板重开、切页），
      //   全量覆盖会让「另一个窗口刚划的一条」被旧的整份列表抹掉。
      // ★ `op` 是**服务端认的白名单**，不是通用 patch：`{...body}` 直接落盘的话，
      //   客户端就成了数据源（能改 `createdAt`、能塞别的书的 id）。
      const annotationsMatch = /^\/annotations\/([A-Za-z0-9_-]{1,64})$/.exec(rest);
      if (annotationsMatch !== null) {
        if (!annotationsReady) {
          return sendJson(res, 501, { ok: false, error: '划线/笔记没有接上（缺少 annotationStore）' });
        }
        const bookId = annotationsMatch[1];
        if (method === 'GET') {
          try {
            return sendJson(res, 200, { ok: true, items: await annotationStore.list(bookId) });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: '需要 JSON body' });
        }
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        const op = String(body.op ?? '');
        try {
          if (op === 'add') {
            const result = await annotationStore.add(bookId, body.item ?? body);
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (op === 'update') {
            const result = await annotationStore.update(bookId, String(body.id ?? ''), {
              note: body.note,
              tone: body.tone,
            });
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (op === 'remove') {
            const result = await annotationStore.remove(bookId, String(body.id ?? ''));
            return sendJson(res, 200, { ok: true, ...result });
          }
          return sendJson(res, 400, { ok: false, error: `不认识的 op：${op}` });
        } catch (error) {
          // 校验类错误回 400（用户能自救：换个颜色、少写几个字），其余是 500。
          return sendJson(res, error?.code === 'BAD_ANNOTATION' ? 400 : 500, {
            ok: false,
            error: error?.message ?? String(error),
          });
        }
      }

      const rawMatch = /^\/book\/([A-Za-z0-9_-]{1,64})\/raw$/.exec(rest);
      if (rawMatch !== null) {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return rawBook(req, res, rawMatch[1]);
      }

      // ---- 本书解读：抽取落盘 → 分段 --------------------------------------
      //
      // ★ 抽取为什么由**渲染进程**发起、只把结果 POST 过来：宿主这一侧有取字节的
      //   能力（`readBytes`），但**没有 PDF 文本解析器**。要么引入 pdfjs-dist（新增
      //   依赖 + 那份 6.4.299 的 Node 兼容问题），要么自己写 PDF 解析。而渲染进程里
      //   那份 pdf.js 本来就在跑，且对本地书与网盘书是同一条路。
      //
      // ★ 为什么每 20 页就落一次盘：阅读器面板一关，渲染进程里的抽取循环就断了。
      //   不落盘的话，用户抽到 180 页时关一下面板，回来要从第 1 页重来。

      const digestMatch = /^\/digest\/([A-Za-z0-9_-]{1,64})\/(pages|segment|status|reset|generate|stop|skill)$/.exec(rest);
      if (digestMatch !== null) {
        if (!digestReady) return sendJson(res, 501, { ok: false, error: '解读功能没有接上（缺少 digestStore）' });
        const bookId = digestMatch[1];
        const action = digestMatch[2];

        // ---- 导出技能包 ---------------------------------------------------
        //
        // ★ 为什么导出走 POST 而不是 GET：它会**写盘**（`skills/<slug>/`）。
        //   GET 必须保持可重入、可预取 —— 一个被浏览器预取触发的导出会悄悄
        //   覆盖用户上一次的包。
        // ★ `synthesize` 会花一次模型调用，所以它是显式的 body 字段，默认 false。
        if (action === 'skill') {
          if (!skillReady) {
            return sendJson(res, 501, { ok: false, error: '导出技能包没有接上（缺少导出入口）' });
          }
          if (method === 'GET') {
            // 只读：上一次导出的结果。没导出过就返回 null（不是 404 ——
            // 「还没导出」是正常状态，界面据此决定显示哪一行）。
            try {
              const last = typeof skillStatus === 'function' ? await skillStatus({ bookId }) : null;
              return sendJson(res, 200, { ok: true, skill: last });
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: error.message });
            }
          }
          if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          let body = {};
          try {
            body = await readBody(req, 16 * 1024);
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
          try {
            // ★ 与上面 `generate` 同一套纪律：**只在请求里真的带了才出现这个键**。
            //   `model: undefined` 与「没有 model 键」对当前的下游是等价的（它写的是
            //   `model !== undefined` 与 `typeof model === 'string'`），但 `undefined`
            //   会让 `'model' in request` 为真、`JSON.stringify` 又看不见它 ——
            //   排查时对着日志找半天。要么有值，要么没有这个键。
            const request = {
              bookId,
              // `auto` 与「没带」等价：都交给宿主按正文去猜，并把依据写进 SKILL.md。
              profile: typeof body.profile === 'string' ? body.profile.slice(0, 40) : 'auto',
              // 只认真布尔。字符串 `"false"` 是真值 —— 用户点「不综合」反而会花钱。
              synthesize: body.synthesize === true,
            };
            if (typeof body.model === 'string' && body.model.trim() !== '') {
              request.model = body.model.slice(0, 200);
            }
            const result = await exportSkill(request);
            return sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }

        if (action === 'status') {
          if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          const [meta, outline] = await Promise.all([digestStore.readMeta(bookId), digestStore.readOutline(bookId)]);
          // `generating` 必须由宿主说了算：面板关掉再打开时，客户端已经不知道
          // 自己有没有在跑了，而宿主那边进程里还挂着一条正在跑的循环。
          return sendJson(res, 200, { ok: true, meta, outline, generating: isGenerating?.(bookId) === true });
        }

        if (action === 'generate' || action === 'stop') {
          if (!digestGenerateReady) {
            return sendJson(res, 501, { ok: false, error: '逐章解读没有接上（缺少生成入口）' });
          }
          if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          let body = {};
          if (action === 'generate') {
            try {
              body = await readBody(req, 16 * 1024);
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: error.message });
            }
          }
          try {
            if (action === 'stop') {
              return sendJson(res, 200, { ok: true, ...(await stopDigests(bookId)) });
            }
            // ★ `chapters` / `model` **只在请求里真的带了它们时才出现**在入参上。
            //   `undefined`（没带）与 `[]`（带了但勾了 0 章）对下游是两件事：
            //   前者 = 老行为（跑所有没解读的章），后者 = 调用方的 bug，要报错。
            //   一律写成 `chapters: body.chapters` 会把「没带」也变成 `undefined`
            //   并多出一个键 —— 用例里那条 deepEqual 就是靠这个区分出真伪的。
            const request = {
              bookId,
              bookTitle: typeof body.bookTitle === 'string' ? body.bookTitle.slice(0, 300) : '',
              force: body.force === true,
            };
            if (Array.isArray(body.chapters)) {
              // 章号必须是正整数：`readChapterText` 会拿它拼文件名，`0` / `-1` /
              // `'3'` 这类值到下游只会变成「这一章没有正文」的静默跳过。
              request.chapters = body.chapters
                .filter(n => Number.isInteger(n) && n >= 1 && n <= 9999)
                .slice(0, 2000);
            }
            if (typeof body.model === 'string') request.model = body.model.slice(0, 200);
            const result = await startDigests(request);
            return sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }

        if (action === 'reset') {
          // 「重新抽取」：书换过文件、或者上次抽到一半把页面抽坏了。
          // ★ 只删这本书自己的目录（`digestStore.remove` 里 bookId 已经过校验），
          //   不碰别的书、也不碰 data.json。
          if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            await digestStore.remove(bookId);
            return sendJson(res, 200, { ok: true });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }

        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });

        let body;
        try {
          // 一批 20 页 × 每页上千字，64 KB 的默认上限不够。
          body = await readBody(req, 2 * 1024 * 1024);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }

        if (action === 'pages') {
          const incoming = Array.isArray(body.pages) ? body.pages : [];
          const clean = incoming
            .filter(page => Number.isInteger(page?.page) && page.page >= 1 && Array.isArray(page?.lines))
            .map(page => ({ page: page.page, lines: page.lines.filter(line => typeof line === 'string') }));
          if (clean.length === 0) return sendJson(res, 400, { ok: false, error: '没有可落盘的页' });
          try {
            await digestStore.appendPages(bookId, clean);
            const meta = (await digestStore.readMeta(bookId)) ?? { bookId };
            const cursor = Math.max(meta.task?.cursor ?? 0, ...clean.map(page => page.page));
            await digestStore.writeMeta(bookId, {
              ...meta,
              bookId,
              task: { ...(meta.task ?? {}), state: 'extracting', cursor },
            });
            return sendJson(res, 200, { ok: true, received: clean.length, cursor });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }

        // action === 'segment'：抽完之后算章节、写 outline、按章切原文。
        try {
          const raw = await digestStore.readPages(bookId);
          if (raw.length === 0) return sendJson(res, 409, { ok: false, error: '还没有抽取任何页' });
          const pageCount = Number.isInteger(body.pageCount) && body.pageCount > 0 ? body.pageCount : raw.length;
          const pages = raw.map(page => page.lines);
          const result = segmentBook({
            pages,
            outline: Array.isArray(body.outline) ? body.outline : [],
            pageCount,
          });
          await digestStore.writeOutline(bookId, result.chapters);
          const written = await digestStore.writeChapterTexts(bookId, raw, result.chapters);
          const charsByN = new Map(written.map(item => [item.n, item.chars]));
          const previous = (await digestStore.readMeta(bookId)) ?? {};
          const meta = {
            ...previous,
            bookId,
            fingerprint: body.fingerprint ?? previous.fingerprint,
            pageCount,
            extract: result.stats,
            mode: result.mode,
            // ★ 章节状态按章记，不存在「整本已解读」这种布尔 —— 19 章挂 1 章，
            //   一个布尔完全看不出来（本项目反复踩的假绿）。
            chapters: result.chapters.map(chapter => ({
              n: chapter.n,
              title: chapter.title,
              startPage: chapter.startPage,
              endPage: chapter.endPage,
              source: chapter.source,
              chars: charsByN.get(chapter.n) ?? 0,
              status: 'pending',
            })),
            task: { state: 'idle', cursor: pageCount },
          };
          await digestStore.writeMeta(bookId, meta);
          return sendJson(res, 200, { ok: true, mode: result.mode, stats: result.stats, chapters: meta.chapters });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      // `GET /digest/:bookId/chapter/:n` —— 单章解读正文。
      //
      // ★ 刻意**不**把它并进 `status`：面板在生成期间每两秒轮询一次 status，
      //   而整本 30 章的解读正文有几十 KB。并进去等于「每两秒传一次全书解读」，
      //   而用户此刻可能一章都没展开。按需取，一次一章。
      // ★ 章节号用 `[1-9]\d{0,3}` 而不是 `\d{1,4}`：后者会放过 `0` 和 `01`，
      //   而 `readDigest` 对 0 抛 TypeError（变成 400）、对 `01` 又会当成第 1 章
      //   （静默命中另一个资源）。路由层就把「不是正整数的章号」挡成 404，
      //   比让下游各写一套校验清楚。
      const chapterMatch = /^\/digest\/([A-Za-z0-9_-]{1,64})\/chapter\/([1-9]\d{0,3})$/.exec(rest);
      if (chapterMatch !== null) {
        if (!digestReady) return sendJson(res, 501, { ok: false, error: '解读功能没有接上（缺少 digestStore）' });
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        try {
          const digest = await digestStore.readDigest(chapterMatch[1], Number(chapterMatch[2]));
          if (digest === null) return sendJson(res, 404, { ok: false, error: '这一章还没有生成解读' });
          return sendJson(res, 200, { ok: true, digest });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      // ---- 书源配置与网盘授权向导 ------------------------------------------
      // 全部挂在同一个前缀下（`LIBRARY_API_PREFIX`），因为它们是同一件事的三个面：
      // 配源 → 扫描生成书单 → 读那份书单。分成两套前缀反而要多维护一份 `isTrustedLocalRequest`。
      if (!sourcesReady) return sendJson(res, 404, { ok: false, error: 'not found' });

      if (rest === '/sources') {
        if (method === 'GET') return sendJson(res, 200, { ok: true, ...(await sourcesPayload()) });
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        try {
          await setSources(body.sources);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        return sendJson(res, 200, { ok: true, ...(await sourcesPayload()) });
      }

      if (rest === '/sources/scan') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        try {
          // `id` 可选：给了就只生成那一条源（第二步每行一个「生成」按钮），
          // 不给就全生成（「生成全部」）。
          const result = await scanSources({ id: body.id });
          return sendJson(res, 200, {
            ok: true,
            total: result.total ?? 0,
            // 单个源失败**不**让整次扫描失败：用户该拿到另外几个源的结果 + 一句说明。
            errors: result.errors ?? [],
            stats: result.stats ?? {},
            /**
             * ★ 名字叫 `scanned` 而不是 `lists`。两者**不是一回事**：
             *   - `scanned`：这一轮**实际生成**的那几份（只点一行时就只有一份）；
             *   - 下面的 `lists`（来自 payload）：全量状态，带 `loaded` 与 `generatedAt`。
             *   同名时后者会把前者静默盖掉，客户端读到「全量」却以为在数「这次生成了几份」
             *   —— 症状是点单行「生成」之后提示「已生成 3 份书单」。
             */
            scanned: result.lists ?? [],
            ...(await sourcesPayload()),
          });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
      }

      /**
       * 换一套「已载入」。
       *
       * ★ 单独一条路由、而不是塞进 `POST /sources`：这两件事的**写入者不同** ——
       *   书源由第二步的增删改产出，载入选择由第三步的勾选产出。合成一条之后，
       *   第二步里任何一次「改个名字」都得把第三步的勾选一起回传，
       *   传漏了就变成「我改个路径，载入选择没了」。
       */
      if (rest === '/lists/load') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        try {
          await setLoadedLists(body.ids);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message });
        }
        return sendJson(res, 200, { ok: true, ...(await sourcesPayload()) });
      }

      if (rest.startsWith('/pan/')) {
        if (!panReady) return sendJson(res, 501, { ok: false, error: '网盘向导没有接上（缺少 panAuth / listPanDirs）' });

        if (rest === '/pan/app') {
          if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
          try {
            await panAuth.saveApp(body.appKey, body.secretKey);
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
          return sendJson(res, 200, { ok: true, pan: await panAuth.status() });
        }

        if (rest === '/pan/authorize') {
          if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          // 先自检 AppKey 再给授权地址：错的 AppKey 在授权页上只显示「与百度连接失败」，
          // 用户会以为是网络问题反复点。这一步**不消耗授权码**，可以随便试。
          try {
            const check = await panAuth.verifyApp();
            const url = await panAuth.authorizeUrl();
            return sendJson(res, 200, { ok: true, clientOk: check.ok, reason: check.reason ?? '', url });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }

        if (rest === '/pan/token') {
          if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
          try {
            return sendJson(res, 200, { ok: true, pan: await panAuth.completeAuthorization(body.code) });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }

        if (rest === '/pan/logout') {
          if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            return sendJson(res, 200, { ok: true, pan: await panAuth.logout() });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }

        if (rest === '/pan/dirs') {
          if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          const target = queryOf(req).get('path') ?? '';
          if (target.trim() === '') return sendJson(res, 400, { ok: false, error: '需要 path 参数（网盘目录，如 /E书拾取）' });
          try {
            const entries = await listPanDirs(target);
            const dirs = entries.filter((entry) => entry.isDir === true).map((entry) => ({ name: entry.name, path: entry.path }));
            return sendJson(res, 200, { ok: true, path: target, dirs, files: entries.length - dirs.length });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message });
          }
        }
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    },
  };

  const staticVendor = {
    kind: 'prefix',
    path: PDFJS_VENDOR_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) return forbidden(res);
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const relPath = vendorRelativePath(pathname);
      if (relPath === undefined) return sendJson(res, 404, { ok: false, error: 'not found' });
      return vendor(res, relPath);
    },
  };

  return [api, staticVendor];
}

/** 让测试与客户端共用一份 Range 拼法。 */
export { formatRange };
