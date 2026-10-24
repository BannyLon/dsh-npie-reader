/**
 * pdf.js 的装载与「按需取字节」的传输层。
 *
 * ★ 为什么必须用 `PDFDataRangeTransport`，而不是 `getDocument({ url })`：
 *
 *   本插件用的这版 pdf.js（6.4.299）里，`validateRangeRequestCapabilities()` 是
 *   **硬要求 `Content-Length`** 的：
 *
 *       const s = parseInt(responseHeaders.get("Content-Length"), 10);
 *       if (!Number.isInteger(s)) return r;      // ← 没有它，直接判定「不支持 Range」
 *
 *   而宿主把 renderer 的请求转发给本机服务时会**扣掉 `content-length`**
 *   （Electron 的 `WITHHELD_RESPONSE_HEADERS`）。于是 `getDocument({ url })` 这条路
 *   会判定「服务端不支持 Range」，然后**把整本拖下来** —— 一本 290 MB 的书就是灾难，
 *   而且**一声不吭**（唯一能看出来的是流量和耗时）。
 *
 *   走 `PDFDataRangeTransport` 时长度由我们自己给（`transport.length`），pdf.js
 *   完全不看响应头，那条退化路径根本不存在。顺带还省掉了对 `Accept-Ranges`、
 *   `Content-Encoding` 这些头的要求。
 *
 * 首块给 1 MiB：pdf.js 解析 PDF 头部、交叉引用表、首页对象都在前几百 KB 里，
 * 一次拿够可以省掉好几个来回（每次来回都是一趟网盘请求）。
 */
import { PDFJS_VENDOR_PREFIX } from '../library.js';
import { fetchBookRange } from './library-api.js';

/** 首块大小。给够一次，后面的范围请求才由 pdf.js 按需发起。 */
export const INITIAL_CHUNK_BYTES = 1 << 20;

/** 单个范围请求失败后的重试次数（宿主侧还有一层网盘重试，这里是本地链路的兜底）。 */
const RANGE_RETRIES = 2;

let pdfjsPromise = null;

/** 内置 pdf.js 资源的绝对路径（相对当前页面，会被宿主转发到本机服务）。 */
export function pdfjsAsset(name) {
  return `${PDFJS_VENDOR_PREFIX}/${name}`;
}

/**
 * 装载 pdf.js（只装一次）。失败**不缓存**，这样用户点「重试」能真的重试一次，
 * 而不是永远拿到同一个被缓存的 rejection。
 */
export function loadPdfjs() {
  if (pdfjsPromise !== null) return pdfjsPromise;
  pdfjsPromise = import(pdfjsAsset('pdf.mjs'))
    .then((module) => {
      // worker 必须走同一个前缀：解析放在 worker 里跑，否则打开一本 30 MB 的书
      // 会把整个界面卡住。
      module.GlobalWorkerOptions.workerSrc = pdfjsAsset('pdf.worker.mjs');
      return module;
    })
    .catch((error) => {
      pdfjsPromise = null;
      throw error;
    });
  return pdfjsPromise;
}

/** `getDocument` 的公共参数：中文 cmap、标准字体、wasm 解码器都要显式指到内置目录。 */
function documentOptions(transport) {
  return {
    range: transport,
    // 只取需要的：默认行为会顺着文件往后预取，那正好是我们想避免的流量。
    disableAutoFetch: true,
    // 我们一次把首块给足、后续按需取，不做渐进式流式读取。
    disableStream: true,
    cMapUrl: pdfjsAsset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAsset('standard_fonts/'),
    wasmUrl: pdfjsAsset('wasm/'),
  };
}

/**
 * 造一个把 `requestDataRange` 接到本机 HTTP 上的传输层。
 *
 * pdf.js 的约定（**6.4.299 实测**，见 `test/pdfjs-vendor.test.mjs` 里真跑的那几条）：
 *   - `requestDataRange(begin, end)` 的 `end` 是**开区间**；
 *   - 取到之后用**同一个 `begin`** 回调 `onDataRange(begin, chunk)`，`begin` 会一路
 *     传到 `PDFDataTransportStream.#Ur(begin, chunk)` 去定位读者；
 *   - ★ `onDataRange` 必须在**传输流构造之后**才能调 —— 它内部走的是私有回调
 *     `#Ks`，那个回调由 `PDFDataTransportStream` 的构造函数通过 `transportReady()`
 *     装上去。装之前调用会抛 `TypeError: this[#Ks] is not a function`（**不是**
 *     老版本那条 `_rangeReaders` / `util_assert` 路径，别照着旧文档改）。
 *     我们的顺序天然安全：`requestDataRange` 只可能被 pdf.js 自己调，而那时流已经建好了。
 *
 * @param pdfjs - 已装载的 pdf.js 模块。
 * @param options.bookId - 书 id。
 * @param options.length - 文件总字节数（来自书单索引，不用问服务端）。
 * @param options.initialChunk - 首块字节。
 * @param options.signal - 中止信号。
 * @param options.onError - 取数彻底失败时的回调（传输层本身没有错误通道）。
 */
export function createBookTransport(pdfjs, { bookId, length, initialChunk, signal, onError }) {
  const transport = new pdfjs.PDFDataRangeTransport(length, initialChunk, true);
  /** 同一个区间并发只发一次（pdf.js 在快速翻页时会重复请求同一段）。 */
  const inflight = new Map();

  transport.requestDataRange = (begin, end) => {
    const key = `${begin}:${end}`;
    const pending = inflight.get(key);
    if (pending !== undefined) return;
    const started = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt < RANGE_RETRIES; attempt += 1) {
        try {
          const chunk = await fetchBookRange(bookId, begin, end, signal);
          transport.onDataRange(begin, chunk);
          return;
        } catch (error) {
          lastError = error;
          if (signal?.aborted) return;
        }
      }
      // 传输层没有错误回调，只能自己往上抛 —— 上层据此把阅读区换成错误态。
      onError?.(lastError ?? new Error('取书失败'));
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, started);
  };

  transport.abort = () => {
    inflight.clear();
  };

  return transport;
}

/* ---------------------------------------------------------------------------
 * ★★ 销毁入口只有 `task`，**不是** `task.promise` 解出来的文档代理 ★★
 *
 * pdf.js 6.4.299 的 `PDFDocumentProxy` 类体里**根本没有 `destroy`**（真跑实测：
 * `typeof doc.destroy === 'undefined'`，原型成员表里也没有它）。旧版本有，所以
 * 「拿到 doc 就 doc.destroy()」是**照着旧文档写出来的错**，而它的报错方式特别
 * 恶劣：`TypeError: loaded.destroy is not a function`，在 React 卸载阶段的
 * cleanup 里**同步抛出** ⇒ 被 Error Boundary 接住 ⇒ 整个阅读器换成
 * 「阅读器页面加载失败」，而真正的原因（一行清理代码）藏在错误文案里。
 *
 * 官方入口是 `PDFDocumentLoadingTask.destroy()`；文档代理上可以用
 * `doc.loadingTask` 把它取回来（真跑实测 `doc.loadingTask === task` 为真）。
 * 本文件把这件事收敛成 `destroyEntry()` 一个函数，并且**永远不向外抛**：
 * 清理失败绝不该让用户失去整个界面。
 * ------------------------------------------------------------------------- */

/**
 * 同时最多留几本**已解析**的文档。
 *
 * 为什么需要缓存：换书时 `BookReader` 是卸载重挂（`key={selected.id}`），
 * 没有缓存的话，每点一次同一本书都要重新走「取首块 1 MiB → 解析交叉引用表」
 * 那一整套 —— 用户看到的就是每点一次都重新「正在取书…」。
 *
 * 取 3 是因为实际使用里 1～2 本同时开着（当前 + 来回对比的那本），留一位余量。
 */
const CACHE_LIMIT = 3;

/** 完成加载的文档：key → `{ bookId, doc, task, controller, onError }`。 */
const docs = new Map();
/** 正在加载的文档：key → Promise（同一本并发只开一次，避免重复取字节）。 */
const pending = new Map();

/** 缓存键带上**字节数**：书被换过文件（同名不同内容）时必须重新解析。 */
function bookKey(bookId, length) {
  return `${bookId}::${length}`;
}

/** LRU：把命中的条目提到队尾。 */
function touch(key) {
  const entry = docs.get(key);
  if (entry === undefined) return;
  docs.delete(key);
  docs.set(key, entry);
}

/**
 * 销毁一个条目。**刻意全程吞错** —— 这是清理路径，抛出去会炸掉调用它的
 * React cleanup（就是本节开头那个事故）。`task.destroy()` 与
 * `doc.loadingTask.destroy()` 是同一个东西，取到哪个用哪个。
 */
function destroyEntry(entry) {
  try { entry.controller?.abort(); } catch { /* 已中止 */ }
  const task = entry.task ?? entry.doc?.loadingTask;
  try {
    const result = task?.destroy?.();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch { /* 同一个 task 被销毁两次会抛，忽略 */ }
}

/** 超编时淘汰最久没碰过的那本。 */
function evict() {
  while (docs.size > CACHE_LIMIT) {
    const oldestKey = docs.keys().next().value;
    const entry = docs.get(oldestKey);
    docs.delete(oldestKey);
    destroyEntry(entry);
  }
}

/**
 * 真正开一本书（不查缓存）。
 *
 * ★ 中止信号是**这个条目自己的** controller，不是调用方传进来的 —— 这是能让
 *   缓存成立的前提：文档的生命周期必须**长于**任何一个调用它的组件。若沿用
 *   组件的 signal，组件一卸载就把传输层 abort 了，下一本复用它时取不到字节。
 */
async function loadEntry(pdfjs, { bookId, length, key }) {
  const controller = new AbortController();
  const entry = { bookId, doc: null, task: null, controller, onError: null };
  try {
    const initialChunk = await fetchBookRange(bookId, 0, Math.min(length, INITIAL_CHUNK_BYTES), controller.signal);
    const transport = createBookTransport(pdfjs, {
      bookId, length, initialChunk, signal: controller.signal,
      // 动态读 `entry.onError`：传输层建好之后就固定了，但「谁来处理错误」每次
      // 复用都可能换人（上一个组件已经卸载了，不该再往它上面写状态）。
      onError: (cause) => entry.onError?.(cause),
    });
    const task = pdfjs.getDocument(documentOptions(transport));
    entry.task = task;
    entry.doc = await task.promise;
    docs.set(key, entry);
    touch(key);
    evict();
    return entry;
  } catch (error) {
    destroyEntry(entry);
    throw error;
  }
}

/**
 * 取一本书的文档：命中缓存就复用，否则加载。
 *
 * @param pdfjs - 已装载的 pdf.js 模块。
 * @param options.bookId - 书 id。
 * @param options.length - 文件总字节数。
 * @param options.onError - **本次调用方**的取数失败回调（会被登记为该条目的当前回调）。
 * @returns `{ doc, task, cached }`。
 */
export async function openCachedBook(pdfjs, { bookId, length, onError }) {
  const key = bookKey(bookId, length);
  const hit = docs.get(key);
  if (hit !== undefined) {
    hit.onError = onError ?? null;
    touch(key);
    return { doc: hit.doc, task: hit.task, cached: true };
  }
  let inFlight = pending.get(key);
  if (inFlight === undefined) {
    inFlight = loadEntry(pdfjs, { bookId, length, key });
    pending.set(key, inFlight);
    const settle = () => pending.delete(key);
    inFlight.then(settle, settle);
  }
  const entry = await inFlight;
  entry.onError = onError ?? null;
  return { doc: entry.doc, task: entry.task, cached: false };
}

/**
 * 丢掉一本书的缓存（它自己出错了、或者用户点了「重试」）。
 *
 * 按 `bookId` 匹配而不是按完整 key：重试时字节数理论上不变，但拿不到 length 的
 * 调用方（比如错误态）也该能清干净。
 */
export function forgetBook(bookId) {
  for (const [key, entry] of [...docs]) {
    if (entry.bookId !== bookId) continue;
    docs.delete(key);
    destroyEntry(entry);
  }
}

/** 清空全部缓存（测试与面板卸载时用）。 */
export function releaseBooks() {
  for (const [key, entry] of [...docs]) {
    docs.delete(key);
    destroyEntry(entry);
  }
  pending.clear();
}

/** 当前缓存了几本（测试用）。 */
export function cachedBookCount() {
  return docs.size;
}
