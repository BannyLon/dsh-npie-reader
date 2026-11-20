/**
 * 论文页级翻译的**唯一入口**（0.71.0）：逐页按需 + 整本一次翻完，共用一份缓存。
 *
 * 两种模式以前是两回事：D 档把 IR + 译文留在组件内的 Map、不落盘、上限 60 页；
 * 整本模式要求「跑完就有、重开还在、已译的页不重复计费」。若各写一份缓存，
 * 逐页翻过的页整本模式会再调一次模型 —— 这正是本文要消掉的分叉。
 *
 * 链路（唯一一份）：
 *   ① 打开书时 GET 整本译文 → 内存索引 + 按页缓存；
 *   ② `ensurePageTranslation()` 取字分段 → 命中缓存且段落一致就直接用，
 *      否则 POST /translate-page → 按 id 对齐 → 写内存 + 落盘；
 *   ③ 逐页模式翻到哪页调 ②；整本模式从 1 到 N 依次调 ②，命中即跳过。
 *
 * ★ 缓存只存「原文段落 + 译文」，不存排版 IR：IR 由本机取字算出来（毫秒级），
 *   且分段规则还在调。每次比对 `paragraphs`（id + 原文），规则一变这一页自动重翻，
 *   不会把中文盖到错框上。缩放只重排，永远不触发 ② 里的模型请求。
 * ★ 落盘失败是**软失败**：译文照样显示，只是下次重开要再翻一次。缓存挂了不能
 *   把阅读页一起打挂 —— 但**必须把失败说出来**（`ensurePageTranslation()` 返回
 *   `persisted`），否则用户只能看到「怎么每次都在重翻」这个现象。
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  clearPageTranslations, fetchPageTranslations, postTranslatePage, putPageTranslation,
} from './library-api.js';
import { pageParagraphs, translationsOf } from './paper-reflow/index.js';

/** 内存缓存页数上限（整本模式下整本都可能在内存里，给到 300 页）。 */
export const CACHE_LIMIT = 300;
/** 一次整本最多跑多少页：再大的 PDF 也别让一次点击变成无限任务。 */
export const WHOLE_BOOK_MAX_PAGES = 2000;
/**
 * 一页最多送多少段。
 *
 * ★ 这个 40 **不是我们选的**：宿主 `/translate-page` 的入参校验写死
 *   `paragraphs.length > 40 ⇒ 400`（`host/library-routes.js`）。客户端以前原样
 *   把一页所有段发过去，于是段落多的一页（双栏论文的参考文献页常见 50+ 段）
 *   永远失败，界面上只有一句「paragraphs 要是 1–40 条的数组」——
 *   整本模式连撞三页就停，用户看到的是「跑不完、一直报错」。
 * ★ 超限时**分批**而不是截断：截断等于把后半页的原文留在画布上，且下次
 *   比对段落仍不一致 ⇒ 每次都重翻。分批的代价是同一页的术语可能前后不齐，
 *   但「翻完」比「译得完美却翻不完」重要，且这种页是少数。
 */
export const PAGE_PARAGRAPH_LIMIT = 40;

const CACHE = new Map();       // `${bookId}:${page}` → { paragraphs, translations }
const INDEX = new Map();       // bookId → Set<page>（不受内存淘汰影响）
const LOADED = new Map();      // bookId → Promise（整本缓存只读一次）
const INFLIGHT = new Map();    // key → Promise（逐页与整本撞到同一页时合并成一次）
const WRITES = new Map();      // bookId → Promise 写队列
const VERSIONS = new Map();    // key → 版本号，供 React 订阅
const PAGE_LISTENERS = new Map();
const JOBS = new Map();        // bookId → 任务快照
const RUNNING = new Map();     // bookId → { cancel }
const JOB_LISTENERS = new Set();
/**
 * 单页翻译的任务态：key → `{ state, step, startedAt, batch, batches }`。
 *
 * ★ 为什么放在模块里而不是组件里：这件事有**两个消费者** —— 页面上的进度胶囊
 *   （`PaperTranslateLayer`）和顶部那颗「翻译这一页」菜单项（`BookReader`）。
 *   菜单项在翻译中必须灰掉：第二次点它是纯粹的无效操作（in-flight 被复用，
 *   界面什么都不变），而「点了没反应」比一句「正在翻译」糟糕得多。
 *   各存一份的话，菜单那份永远不知道翻译已经开始。
 * ★ `step` 是**阶段**不是百分比：一页只发一次模型请求，模型不回流中途进度
 *   ⇒ 任何「37%」都是编的。阶段 + 已等待秒数是唯一诚实的读数。
 * ★ 快照必须是**稳定引用**（`useSyncExternalStore` 拿到新对象就死循环），
 *   所以 idle 用一个共享常量对象。
 */
const IDLE_TASK = { state: 'idle', step: 'idle', startedAt: 0, batch: 0, batches: 0 };
const PAGE_TASKS = new Map();
const TASK_LISTENERS = new Map();
/**
 * 每页在飞请求的 `AbortController`（0.78.0）。
 *
 * ★ 用户能按「暂停」就必须真的停：模型请求掐不断的话，「暂停」只是把界面
 *   关掉、后台照样跑满 3 分钟、缓存照样写进去 —— 用户以为省下的钱其实没省。
 * ★ key 与 `INFLIGHT` 同一套（`${bookId}:${page}`），一个 key 同一时刻只有一个。
 */
const PAGE_ABORT = new Map();

export function translationKey(bookId, page) {
  return `${bookId}:${page}`;
}

function itemsOf(input) {
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    const id = String(item?.id ?? '');
    const text = String(item?.text ?? '');
    if (id !== '' && text !== '') out.push({ id, text });
  }
  return out;
}

function normalizeRecord(record) {
  const paragraphs = itemsOf(record?.paragraphs);
  const translations = itemsOf(record?.translations);
  if (paragraphs.length === 0 || translations.length === 0) return null;
  const known = new Set(paragraphs.map(item => item.id));
  return { paragraphs, translations: translations.filter(item => known.has(item.id)) };
}

function sameParagraphs(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || a[i].text !== b[i].text) return false;
  }
  return true;
}

function trimCache() {
  while (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value);
}

function notifyPage(key) {
  VERSIONS.set(key, (VERSIONS.get(key) ?? 0) + 1);
  for (const listener of [...(PAGE_LISTENERS.get(key) ?? [])]) listener();
}

/** React 订阅：只在这一页的译文到达时变号，整本跑别的页不会晃当前页。 */
export function subscribePageTranslation(key, listener) {
  if (key === '') return () => {};
  let set = PAGE_LISTENERS.get(key);
  if (set === undefined) { set = new Set(); PAGE_LISTENERS.set(key, set); }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) PAGE_LISTENERS.delete(key);
  };
}

export function pageTranslationVersion(key) {
  return VERSIONS.get(key) ?? 0;
}

// ---- 单页翻译的任务态（0.78.0）------------------------------------------

function setPageTask(key, patch) {
  const next = { ...(PAGE_TASKS.get(key) ?? IDLE_TASK), ...patch };
  PAGE_TASKS.set(key, next);
  for (const listener of [...(TASK_LISTENERS.get(key) ?? [])]) listener();
}

/** 这一页现在在做什么。没在翻时返回共享的 idle 快照。 */
export function pageTaskSnapshot(key) {
  return PAGE_TASKS.get(key) ?? IDLE_TASK;
}

export function subscribePageTask(key, listener) {
  if (key === '') return () => {};
  let set = TASK_LISTENERS.get(key);
  if (set === undefined) { set = new Set(); TASK_LISTENERS.set(key, set); }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) TASK_LISTENERS.delete(key);
  };
}

/**
 * 订阅**这一页**的翻译任务态。
 *
 * ★ 只订阅当前页：整本在后台翻别的页时，这个 hook 不该让阅读器重渲染。
 * ★ 第三个参数（server snapshot）不能省 —— 阅读器有 `react-dom/server` 渲染
 *   路径（真渲染测试走它），少了它直接抛 `Missing getServerSnapshot`。
 */
export function usePageTranslationTask(key) {
  return useSyncExternalStore(
    useCallback(listener => subscribePageTask(key, listener), [key]),
    useCallback(() => pageTaskSnapshot(key), [key]),
    useCallback(() => pageTaskSnapshot(key), [key]),
  );
}

/** 阶段的用户可读说法。`extract` / `layout` 都是毫秒级，但说出来比干等强。 */
export const PAGE_STEP_TEXT = {
  extract: '正在取这一页的字',
  translate: '正在翻译这一页',
  layout: '正在排版译文',
  idle: '',
};

function indexOf(bookId) {
  let set = INDEX.get(bookId);
  if (set === undefined) { set = new Set(); INDEX.set(bookId, set); }
  return set;
}

/**
 * 打开一本书时把磁盘上已译的页拉回来。只跑一次；HTTP 失败当「没有缓存」，
 * 逐页模式照常能翻（只是重新调一次模型）。
 */
export function loadBookTranslations(bookId) {
  if (LOADED.has(bookId)) return LOADED.get(bookId);
  const task = (async () => {
    let pages = {};
    try {
      pages = await fetchPageTranslations(bookId);
    } catch {
      pages = {};
    }
    const set = indexOf(bookId);
    for (const [rawPage, record] of Object.entries(pages ?? {})) {
      const page = Number(rawPage);
      const entry = Number.isInteger(page) && page > 0 ? normalizeRecord(record) : null;
      if (entry === null || entry.translations.length === 0) continue;
      CACHE.set(translationKey(bookId, page), entry);
      set.add(page);
    }
    trimCache();
    // 可能译文层的 effect 已经先跑完一轮（当时缓存还是空的），这里补一次通知。
    for (const key of PAGE_LISTENERS.keys()) notifyPage(key);
    return set;
  })();
  LOADED.set(bookId, task);
  return task;
}

export function hasPageTranslation(bookId, page) {
  return indexOf(bookId).has(page);
}

export function translatedPageCount(bookId) {
  return indexOf(bookId).size;
}

function enqueueWrite(bookId, task) {
  const previous = WRITES.get(bookId) ?? Promise.resolve();
  const next = previous.then(task, task);
  WRITES.set(bookId, next.catch(() => {}));
  return next;
}

/**
 * 写一页：内存立刻生效，磁盘排在同一本书的队列里。
 *
 * ★ 返回**写入结果**（`true / false`），调用方要把它交给用户。上一版是
 *   `void enqueueWrite(...)` + 空 catch：缓存从来没写成功过（段落 id 带冒号，
 *   被宿主的落盘校验全丢掉），而界面一句提示都没有，用户只看到
 *   「每次重开都要重新翻译」这个现象，查不到原因。软失败可以，**哑失败不行**。
 */
function rememberPage(bookId, page, paragraphs, translations) {
  const key = translationKey(bookId, page);
  CACHE.set(key, { paragraphs, translations });
  indexOf(bookId).add(page);
  trimCache();
  notifyPage(key);
  return enqueueWrite(bookId, async () => {
    try {
      await putPageTranslation(bookId, { page, paragraphs, translations });
      return true;
    } catch {
      // 软失败：本机缓存没写进去，界面上这一页照样是中文。
      return false;
    }
  });
}

function cachedMap(bookId, page, paragraphs) {
  const entry = CACHE.get(translationKey(bookId, page));
  if (entry === undefined || !sameParagraphs(entry.paragraphs, paragraphs)) return null;
  const map = new Map();
  for (const item of entry.translations) if (!map.has(item.id)) map.set(item.id, item.text);
  return map;
}

/**
 * 把一页的段落交给模型，超过 `PAGE_PARAGRAPH_LIMIT` 时分批。
 *
 * ★ 分批只发生在**段落数超限**的页上（见上面那段 40 的来由）。两批之间
 *   术语可能不一致，这是「翻得完」换来的代价；不碰 40 段以内的页，
 *   常规正文页仍是一次请求、术语一致。
 * ★ 分批**并发 2**（0.78.0）：一页 60 段串行就是两个 80 秒 —— 用户实测截图里
 *   「第 1/2 批 · 168 秒」。并发之后总时长接近单批，而且先到的那批能先铺上去。
 *   上限是 2 不是无限：同一页并发太多会撞限流、反而更慢，也会把别人的任务挤掉。
 * ★ 每完成一批就 `onBatch`：界面据此**渐进**铺字，用户 80 秒就能看到前半页中文，
 *   不必等两批全回。
 */
async function translateParagraphsInBatches(paragraphs, { signal, onBatch } = {}) {
  if (paragraphs.length <= PAGE_PARAGRAPH_LIMIT) {
    const body = await postTranslatePage(paragraphs, { signal });
    const out = Array.isArray(body?.translations) ? body.translations : [];
    return out;
  }
  const slices = [];
  for (let index = 0; index < paragraphs.length; index += PAGE_PARAGRAPH_LIMIT) {
    slices.push(paragraphs.slice(index, index + PAGE_PARAGRAPH_LIMIT));
  }
  const batches = slices.length;
  const collected = [];
  let cursor = 0;
  /**
   * ★ 内部再来一个 controller（0.78.0）：一批失败时要把**兄弟批**也掐掉。
   *   否则用户点了等待、第一批 500、第二批照旧跑满 80 秒 —— 钱花了，界面已经报错了。
   *   外部 `signal`（用户点「暂停」）通过监听转进来，所以两条路都停在同一个地方。
   */
  const inner = new AbortController();
  const forward = () => inner.abort();
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) inner.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  let failure = null;
  const worker = async () => {
    while (cursor < slices.length) {
      if (inner.signal.aborted) return;
      const index = cursor;
      cursor += 1;
      try {
        const body = await postTranslatePage(slices[index], { signal: inner.signal });
        const list = Array.isArray(body?.translations) ? body.translations : [];
        collected.push(...list);
        // ★ 回调里出错不能把整页翻译打挂（它只是「先画一部分」的旁路）。
        try { onBatch?.(collected, index + 1, batches); } catch { /* 旁路失败不影响正文 */ }
      } catch (cause) {
        // 只记第一个：后面的都是被这一下掐出来的连带 AbortError，没有信息量。
        if (failure === null) failure = cause;
        inner.abort();
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(2, batches) }, worker));
  } finally {
    signal?.removeEventListener?.('abort', forward);
  }
  if (failure !== null) throw failure;
  /**
   * ★ 暂停可能**落在两批之间**（第一批已经回来，第二批还没发）。
   *   这时 worker 只是 `return`，没有失败可抛 —— 若不在这里补一刀，
   *   `collected` 会被当成「整页成功」交给调用方，半页译文就落了盘，
   *   而用户明明按了暂停。
   */
  if (signal?.aborted) {
    const paused = new Error('已暂停');
    paused.code = 'PAUSED';
    throw paused;
  }
  return collected;
}

/**
 * 取一页译文。逐页模式与整本模式**都只走这里**。
 *
 * 返回 `{ ir, translations, cached, persisted }`；`translations` 是 `Map<id, 中文>`。
 * `persisted === false` 表示这一页**显示得出来、存不下来**（缓存没写成功），
 * 调用方应当提示一次 —— 否则用户只会觉得「怎么每次都在重翻」。
 * 同一页同时在途时复用同一个 Promise —— 用户停在某个页上点「整本」也不会
 * 让这一页被调两次模型。
 *
 * `onPartial({ ir, translations })`：分批页每回来一批就叫一次，调用方据此
 * **渐进铺字**。它拿到的 `translations` 是不完整的（只含已回的批），
 * 排版层对缺失的 id 天然不画 —— 缺的段落保留英文，正好是想要的效果。
 */
export function ensurePageTranslation({ bookId, pdfPage, page, onPartial }) {
  const key = translationKey(bookId, page);
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  setPageTask(key, { state: 'running', step: 'extract', startedAt: Date.now(), batch: 0, batches: 0 });
  const controller = new AbortController();
  PAGE_ABORT.set(key, controller);
  const task = (async () => {
    try {
      await loadBookTranslations(bookId);
      const { ir, paragraphs } = await pageParagraphs(pdfPage, page - 1);
      // ★ 不是错误：整页只有图、或者正文本来就是中文（`worthTranslating` 滤掉了）。
      //   这里**不能抛** —— 抛了整本模式会把这一页记成「失败」，用户还会看到
      //   「这一页没取到文字（可能是扫描页）」这种吓人的提示，而其实什么也没坏。
      if (paragraphs.length === 0) {
        return { ir, translations: new Map(), cached: false, persisted: true, empty: true };
      }
      const hit = cachedMap(bookId, page, paragraphs);
      if (hit !== null) return { ir, translations: hit, cached: true, persisted: true };
      setPageTask(key, { step: 'translate', batches: Math.ceil(paragraphs.length / PAGE_PARAGRAPH_LIMIT) });
      const raw = await translateParagraphsInBatches(paragraphs, {
        signal: controller.signal,
        onBatch: (list, batch, batches) => {
          setPageTask(key, { step: 'translate', batch, batches });
          if (typeof onPartial !== 'function') return;
          const partial = translationsOf(ir, list);
          if (partial.size > 0) onPartial({ ir, translations: partial });
        },
      });
      setPageTask(key, { step: 'layout' });
      const translations = translationsOf(ir, raw);
      if (translations.size === 0) throw new Error('模型没有返回对得上段落的译文');
      const persisted = await rememberPage(
        bookId, page, paragraphs, [...translations].map(([id, text]) => ({ id, text })),
      );
      return { ir, translations, cached: false, persisted };
    } finally {
      PAGE_ABORT.delete(key);
      // ★ 一定要清：不清的话失败后那一页会永远停在「正在翻译」，
      //   菜单项永远灰着 —— 一次网络抖动就把这一页锁死。
      setPageTask(key, IDLE_TASK);
    }
  })().finally(() => { INFLIGHT.delete(key); });
  INFLIGHT.set(key, task);
  return task;
}

/**
 * 暂停这一页的翻译（0.78.0）。
 *
 * ★ 真的掐断请求，不只是把界面关掉：`fetch` 收到 abort 就不会再等那 3 分钟。
 * ★ **不落盘**：已回来的那一批中文会留在屏幕上（钱已经花了，没必要撤掉），
 *   但缓存不写 —— 否则下次打开会拿着一份不完整的译文当「已译」，
 *   剩下半页永远是英文而没有任何人知道为什么。
 * ★ 返回 `false` 表示这一页本来就没在翻（重复点、或者刚好已结束）。
 */
export function cancelPageTranslation(key) {
  const controller = PAGE_ABORT.get(key);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

// ---- 整本一次翻完 ---------------------------------------------------------

/**
 * 每页耗时的**量级区间**（毫秒）。
 *
 * ★ 这是估算，不是实测，也不是承诺。它的用途只有一个：在**开始之前**让用户
 *   知道「这件事是几分钟还是几小时」—— 没有这个数，「翻译全本」那颗按钮就是
 *   一次盲点：不知道自己点了会等多久。
 * ★ 跑过一次之后就用实测值替换（`msPerPage` 存在任务快照里），所以这个区间
 *   只影响第一本还没跑过的书。
 * ★ 区间给得宽是对的：一页 15 段和一页 40 段差两倍多，模型快慢也差一倍。
 *   给一个「约 20 分钟」的单点数字，用户会拿它当承诺。
 * ★ 上限从 40 秒抬到 90 秒（0.78.0）：用户实测一页 60 段的页两批**串行**跑了
 *   168 秒，两路并发之后最坏仍要一分多。原来按 40 秒封顶，等于向用户保证一个
 *   我们自己都没见过的速度 —— 估时的唯一用途是别让人惊讶，宁可先说长。
 */
export const PAGE_MS_RANGE = { min: 15_000, max: 90_000 };

function idleJob(bookId) {
  return {
    bookId, state: 'idle', total: 0, done: 0, skipped: 0, failed: 0, error: '',
    /** 这本书**实际**多少页。`total` 是「这次会翻多少页」，可能被上限截断。 */
    pages: 0,
    /** `pages > total` ⇒ 只翻了前 total 页；文案必须说出来，不能报「整本完成」。 */
    capped: false,
    /** 本页任务开始的时间戳；用来算实测速率与「已跑多久」。 */
    startedAt: 0,
    /** 真实新翻的页数（`done - skipped`）：速率只能按它算，读缓存是 0 耗时。 */
    newDone: 0,
    /** 实测每页毫秒数；0 表示还没跑过，只能用 `PAGE_MS_RANGE` 估。 */
    msPerPage: 0,
  };
}

/** 任务快照。★ 必须返回**稳定引用**：`useSyncExternalStore` 拿到新对象会死循环。 */
export function wholeBookJob(bookId) {
  if (!JOBS.has(bookId)) JOBS.set(bookId, idleJob(bookId));
  return JOBS.get(bookId);
}

function setJob(bookId, patch) {
  JOBS.set(bookId, { ...wholeBookJob(bookId), ...patch, bookId });
  for (const listener of [...JOB_LISTENERS]) listener();
}

export function subscribeWholeBook(listener) {
  JOB_LISTENERS.add(listener);
  return () => { JOB_LISTENERS.delete(listener); };
}

export function useWholeBookJob(bookId) {
  return useSyncExternalStore(subscribeWholeBook, () => wholeBookJob(bookId), () => wholeBookJob(bookId));
}

/**
 * 只订阅**状态字符串**。
 *
 * ★ 顶部胶囊长在 2900 行的 `BookReader` 里：整本跑几十页时若让整棵阅读器跟着
 *   每页进度重渲染，就是用户上一轮报的「进到阅读页非常卡」。`state` 只在
 *   idle → running → stopping → done/stopped 这几跳之间变，一整本书最多重渲染
 *   三四次；逐页数字交给下面那个小组件自己订阅。
 */
export function useWholeBookState(bookId) {
  return useSyncExternalStore(subscribeWholeBook, () => wholeBookJob(bookId).state, () => wholeBookJob(bookId).state);
}

/** 让出一帧：整本跑几十页时界面要能翻页、能点停止。 */
function nextFrame() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * 开始（或继续）整本翻译。已在跑时直接返回同一份快照，不会开第二个任务。
 *
 * ★ 不 await 整个循环：按钮点击要立刻回到界面，进度靠 `setJob` 推。
 * ★ 连续 3 页失败就停：模型限流 / 没配模型时继续跑只是把后面每一页都烧一遍。
 * ★ 停 / 失败后已译的页都留在磁盘上，再点一次只补没译的页。
 */
export function startWholeBookTranslation({ bookId, doc, numPages, notify = () => {} }) {
  const requested = Math.max(Math.round(Number(numPages) || 0), 0);
  const total = Math.min(requested, WHOLE_BOOK_MAX_PAGES);
  // ★ 上限截断必须**记下来**（0.84.7）：以前 total 被截成 2000 后，跑完照样
  //   notify「整本翻译完成」，而这本书可能有 3000 页 —— 用户以为全书已是中文，
  //   实际后 1000 页还是原文，且界面上看不出任何异常。
  const capped = requested > total;
  if (bookId === '' || doc === null || doc === undefined || total === 0) {
    notify('这本书还没打开，等 PDF 读出来再翻全书');
    return wholeBookJob(bookId);
  }
  if (RUNNING.has(bookId)) return wholeBookJob(bookId);
  const token = { cancel: false };
  const startedAt = Date.now();
  RUNNING.set(bookId, token);
  setJob(bookId, {
    state: 'running', total, pages: requested, capped, done: 0, skipped: 0, failed: 0, error: '',
    startedAt, newDone: 0,
  });

  void (async () => {
    let done = 0;
    let skipped = 0;
    let failed = 0;
    let unsaved = 0;
    let streak = 0;
    let fatal = '';
    try {
      await loadBookTranslations(bookId);
      for (let page = 1; page <= total; page += 1) {
        if (token.cancel) break;
        if (hasPageTranslation(bookId, page)) {
          skipped += 1;
          done += 1;
        } else {
          try {
            const pdfPage = await doc.getPage(page);
            if (token.cancel) break;
            const result = await ensurePageTranslation({ bookId, pdfPage, page });
            if (result?.persisted === false) unsaved += 1;
            done += 1;
            streak = 0;
          } catch (error) {
            failed += 1;
            streak += 1;
            if (streak >= 3) {
              fatal = error?.message ?? String(error);
              break;
            }
          }
        }
        /**
         * ★ 实测速率就地从「真实新翻页数 / 已跑时长」推，而不是另存一份计时器：
         *   读缓存页几乎不耗时，把它们算进分母会得到「每页 0.3 秒」这种假快。
         *   少于 2 页新翻时不出速率 —— 一页的耗时方差太大，会给出剧烈跳动的 ETA。
         */
        const newDone = done - skipped;
        const elapsed = Date.now() - startedAt;
        setJob(bookId, {
          done, skipped, failed, newDone,
          msPerPage: newDone >= 2 ? Math.round(elapsed / newDone) : 0,
        });
        await nextFrame();
      }
      const state = token.cancel ? 'stopped' : (fatal !== '' || failed > 0 ? 'failed' : 'done');
      setJob(bookId, { state, done, skipped, failed, error: fatal });
      // ★ `unsaved > 0` 必须说出来：跑完了、界面也是中文，但下次打开这些页要重翻。
      const unsavedHint = unsaved > 0 ? `；${unsaved} 页没能存到本机，下次打开要重翻` : '';
      if (state === 'done') {
        notify(capped
          ? `已翻完前 ${total} 页（这本书共 ${requested} 页，超过单次上限 ${WHOLE_BOOK_MAX_PAGES}）：`
            + `${skipped} 页直接读缓存，${done - skipped} 页新翻${unsavedHint}`
          : `整本翻译完成：${skipped} 页直接读缓存，${done - skipped} 页新翻${unsavedHint}`);
      }
      else if (state === 'stopped') notify(`已停止，完成 ${done} 页；已译的页留在本机${unsavedHint}`);
      else notify(`有 ${failed} 页没译出来，再点一次只补没译的页${unsavedHint}`);
    } catch (error) {
      setJob(bookId, { state: 'failed', done, skipped, failed, error: error?.message ?? String(error) });
      notify(`整本翻译中断：${error?.message ?? String(error)}`);
    } finally {
      RUNNING.delete(bookId);
    }
  })();

  return wholeBookJob(bookId);
}

/** 停止：当前这一页翻完就收手，不会删已落盘的译文。 */
export function stopWholeBookTranslation(bookId) {
  const token = RUNNING.get(bookId);
  if (token === undefined) return false;
  token.cancel = true;
  setJob(bookId, { state: 'stopping' });
  return true;
}

/**
 * 收掉那条进度胶囊（`failed` / `stopped` / `done` 之后）。
 *
 * ★ 用户 2026-11-13：「整本完成后如果出错，没有暂停或停止的按钮，好像一直在
 *   提示错误」。胶囊以前只在 running / stopping 时给「停止」，进入 failed 之后
 *   既没有按钮、也不会自己消失 —— 一条红色报错就永久贴在书页上。
 * ★ 只把 `state` 收回 `idle`，**保留** `total / done / skipped / msPerPage`：
 *   再点「翻译全本」时还能用实测速率给出时长，也不会让「已译 N 页」凭空消失。
 * ★ 不删任何缓存：这是收提示，不是放弃成果。
 */
export function dismissWholeBookJob(bookId) {
  if (RUNNING.has(bookId)) return false;
  setJob(bookId, { state: 'idle', error: '' });
  return true;
}

/**
 * 整本翻译的时长估算（开始之前用）。
 *
 * 返回 `{ pages, minMs, maxMs, measured }`：
 * - `pages`：本次真正要翻的页数（总量减掉读缓存的部分）；
 * - `measured: true` 表示用的是这本书上次跑出来的实测速率，`false` 表示用的
 *   默认量级区间 —— 界面必须把这两个说法写出来，不能让用户以为是实测。
 */
export function estimateWholeBook({ total = 0, cached = 0, msPerPage = 0 } = {}) {
  const pages = Math.max(0, Math.round(Number(total) || 0) - Math.max(0, Math.round(Number(cached) || 0)));
  if (pages === 0) return { pages: 0, minMs: 0, maxMs: 0, measured: false };
  const measured = Number(msPerPage) > 0;
  if (measured) {
    const mid = Number(msPerPage) * pages;
    // 实测值给 ±20% 的余量：模型快慢会变，单点数字会被当成承诺。
    return { pages, minMs: Math.round(mid * 0.8), maxMs: Math.round(mid * 1.2), measured: true };
  }
  return { pages, minMs: pages * PAGE_MS_RANGE.min, maxMs: pages * PAGE_MS_RANGE.max, measured: false };
}

/** 把毫秒说成人话。故意粗：这是估算值，精确到秒只会显得比实际更可信。 */
export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '不到 1 分钟';
  const minutes = value / 60_000;
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `约 ${Math.round(minutes)} 分钟`;
  const hours = minutes / 60;
  return hours < 10 ? `约 ${hours.toFixed(1)} 小时` : `约 ${Math.round(hours)} 小时`;
}

/**
 * 清掉这本书的全部译文（换模型 / 分段规则升级后想重翻时用）。
 *
 * ★ 返回**真的清掉了没有**。上一版无论成败都报「已清空」：磁盘删不掉时内存先清，
 *   界面当场变回英文，看起来像成功了；下次打开 `loadBookTranslations()` 又把旧
 *   译文读回来 —— 用户看到的是「清不掉 / 清了又回来」。删失败时**不动内存**，
 *   并如实回 `false`，让调用方说真话。
 */
export async function clearWholeBookTranslations(bookId) {
  let cleared = true;
  await enqueueWrite(bookId, async () => {
    try { await clearPageTranslations(bookId); } catch { cleared = false; }
  });
  if (!cleared) return false;
  const prefix = `${bookId}:`;
  for (const key of [...CACHE.keys()]) if (key.startsWith(prefix)) CACHE.delete(key);
  INDEX.delete(bookId);
  LOADED.delete(bookId);
  for (const key of [...PAGE_LISTENERS.keys()]) if (key.startsWith(prefix)) notifyPage(key);
  setJob(bookId, idleJob(bookId));
  return true;
}

/** 仅供测试：清空所有模块级状态，避免用例之间串味。 */
export function __resetPaperTranslationForTests() {
  CACHE.clear(); INDEX.clear(); LOADED.clear(); INFLIGHT.clear(); WRITES.clear();
  VERSIONS.clear(); PAGE_LISTENERS.clear(); JOBS.clear(); RUNNING.clear(); JOB_LISTENERS.clear();
  PAGE_TASKS.clear(); TASK_LISTENERS.clear(); PAGE_ABORT.clear();
}
