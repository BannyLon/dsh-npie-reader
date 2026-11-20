/**
 * 整本翻译的**任务台**（0.60.0）。
 *
 * 为什么是模块级单例，而不是 `BookEbook` 里的 `useState`：
 * 一次整本翻译要跑几十分钟到几小时，而人会换书、会切到订阅页、会去处理别的事。
 * 状态挂在阅读组件上的后果是**一换书就断线** —— 任务还在宿主里跑，界面上却
 * 什么都看不见，只能靠直觉猜「它是不是停了」。任务台活在模块作用域里，
 * 组件挂载/卸载不影响它持有的事实。
 *
 * ★ 0.61.0 起**多本可以同时跑**：`entries` 本来就是按 `bookId` 分的一张表，
 *   `pollAll` 对每条 running 各发一个 GET —— 结构上不用改，只是界面不再互相禁用
 *   （`ReadingAssistant` 里那条「同一时刻只翻一本」的说明也随之删掉）。
 *
 * 四条判据（改动前先读）：
 *
 * 1. **宿主是权威，这里只存快照。** 进度以磁盘上已落的译文为准（见
 *    `src/host/ebook/prefetch.js` 文件头），客户端不做累加、不做乐观更新。
 *    一次轮询漏拍、窗口被节流，下一次拿到的一定是对的。
 * 2. **只在有 running 时开表。** 全部停下来就 `clearInterval`，一个请求都不发。
 *    否则一本译完的书开着界面，会一直为一串永远不会变的状态付出请求。
 * 3. **一拍失败不清空。** 网络抖一下就把任务从列表里抹掉，用户看到的是
 *    「翻译凭空消失了」，而它其实还在跑。留旧快照，下一拍接着问。
 * 4. **译完自动退场，停/中断不退场。** `done` 留 12 秒让用户看到「译完了」，
 *    然后自己收走 —— 一本书读第二遍时，那个角标只会是永久噪音。
 *    而 `stopped` / `failed` 必须留着：那是用户要接着处理的两种状态。
 */
import { useSyncExternalStore } from 'react';
import { fetchEbookPrefetch, postEbookPrefetch } from './library-api.js';

/** 1.5 秒一拍：比这快只是空转，比这慢「正在翻第几节」会一跳两节。 */
const POLL_MS = 1_500;

/** 译完之后角标再留多久。够看清「译完了」，又不至于赖着不走。 */
const LINGER_MS = 12_000;

let entries = [];
let pollTimer = null;
const listeners = new Set();
const retireTimers = new Map();

function notify() {
  // ★ 复制一份再遍历：订阅者在回调里取消订阅是合法操作，直接遍历 Set 会在
  //   V8 上得到「删除后继续遍历」的语义，这里不想依赖它。
  for (const listener of [...listeners]) listener();
}

function commit(next) {
  if (next === entries) return;
  entries = next;
  notify();
}

/** 订阅。返回取消函数（`useSyncExternalStore` 要求的形式）。 */
export function subscribe(listener) {
  listeners.add(listener);
  ensurePolling();
  return () => { listeners.delete(listener); };
}

/** 快照。引用只在 `commit` 时变，`useSyncExternalStore` 才不会死循环。 */
export function getEntries() {
  return entries;
}

export function useTranslateJobs() {
  return useSyncExternalStore(subscribe, getEntries, getEntries);
}

/**
 * 两份快照是否「画出来一样」。
 *
 * ★ 只比界面上真的会变的字段。整份 `JSON.stringify` 也能对，但每秒一次、
 *   对象有几十个键时它比逐字段贵得多，而且 `startedAt` 这类每次都不同的
 *   时间戳会让比较永远为假 —— 那就等于没有比较。
 */
function sameSnapshot(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return a.state === b.state
    && a.total === b.total
    && a.translated === b.translated
    && a.failed === b.failed
    && a.percent === b.percent
    && a.eta === b.eta
    && (a.current?.n ?? null) === (b.current?.n ?? null)
    && (a.error ?? '') === (b.error ?? '');
}

function retireKey(bookId) { return `book:${bookId}`; }

function cancelRetire(bookId) {
  const key = retireKey(bookId);
  const timer = retireTimers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    retireTimers.delete(key);
  }
}

/** 移除一条（用户在卡片上点了 ×，或者译完留够了时间）。 */
function removeEntry(bookId) {
  cancelRetire(bookId);
  if (!entries.some((entry) => entry.bookId === bookId)) return;
  commit(entries.filter((entry) => entry.bookId !== bookId));
  ensurePolling();
}

/** 译完留一会儿再走；停 / 中断不走（见文件头判据 4）。 */
function scheduleRetire(bookId) {
  const entry = entries.find((item) => item.bookId === bookId);
  if (entry?.job?.state !== 'done') return;
  if (retireTimers.has(retireKey(bookId))) return;
  const timer = setTimeout(() => {
    retireTimers.delete(retireKey(bookId));
    removeEntry(bookId);
  }, LINGER_MS);
  // Node 里没有 `unref` 之外的意义；浏览器侧有这个判断是为了在测试环境中
  // 不因为一个挂着的定时器把进程留住。
  timer?.unref?.();
  retireTimers.set(retireKey(bookId), timer);
}

function ensurePolling() {
  const active = entries.some((entry) => entry.job?.state === 'running');
  if (active && pollTimer === null) {
    pollTimer = setInterval(() => { void pollAll(); }, POLL_MS);
    pollTimer?.unref?.();
    return;
  }
  if (!active && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollAll() {
  const running = entries.filter((entry) => entry.job?.state === 'running');
  if (running.length === 0) {
    ensurePolling();
    return;
  }
  await Promise.all(running.map(async (entry) => {
    try {
      const job = await fetchEbookPrefetch(entry.bookId);
      applyJob(entry.bookId, job);
    } catch {
      // 判据 3：这一拍没拿到就当作没发生。
    }
  }));
}

function applyJob(bookId, job) {
  if (job === null || typeof job !== 'object') return;
  const index = entries.findIndex((entry) => entry.bookId === bookId);
  if (index < 0) return;
  const current = entries[index];
  /*
   * ★ `stopping` 期间**拒收 running 快照**。
   *   宿主处理停止是两步的：先给批处理发 abort，再等当前这一批收尾，最后才把
   *   `state` 改成 `stopped`。于是「点了停止」到「真的停了」之间，一次 GET 仍然
   *   会老实回答 running —— 照单全收的后果是按钮从「继续」跳回「正在翻译」，
   *   用户会以为刚才那一下没生效，然后再点一次。
   *   这里宁可让界面停在「正在停止…」，直到宿主自己说出一个非 running 的结论。
   */
  if (current.stopping === true && job.state === 'running') return;
  if (sameSnapshot(current.job, job) && current.stopping !== true) return;
  const next = entries.slice();
  next[index] = {
    ...current,
    job,
    stopping: job.state === 'running' ? current.stopping === true : false,
  };
  commit(next);
  scheduleRetire(bookId);
  ensurePolling();
}

/**
 * 把一本书的当前状态拉进来（自愈用）。
 *
 * 场景：界面重载了，但宿主里的任务还在跑。这时任务台上什么都没有，
 * 用户会以为翻译没了。打开一本书时问一次，running / stopped / failed 就补登记；
 * `idle` / `done` 不登记 —— 把一本早就译完的书拉回角标是无意义的噪音。
 */
export async function adopt(book) {
  const bookId = String(book?.id ?? '');
  if (bookId === '' || entries.some((entry) => entry.bookId === bookId)) return;
  try {
    const job = await fetchEbookPrefetch(bookId);
    if (job === null || typeof job !== 'object') return;
    if (job.state === 'idle' || job.state === 'done') return;
    if (entries.some((entry) => entry.bookId === bookId)) return;
    commit([...entries, { bookId, title: String(book?.title ?? ''), job, busy: false, error: '' }]);
    scheduleRetire(bookId);
    ensurePolling();
  } catch {
    // 问不到就算了，下次打开再问。
  }
}

/** 开 / 继续。宿主侧单飞：已经在跑时拿到的是同一份快照，不会开第二个任务。 */
export async function start(book) {
  const bookId = String(book?.id ?? '');
  if (bookId === '') return null;
  cancelRetire(bookId);
  patch(bookId, (entry) => ({ ...entry, busy: true, error: '' }), book);
  try {
    const job = await postEbookPrefetch(bookId, 'start');
    const index = entries.findIndex((entry) => entry.bookId === bookId);
    const base = index < 0
      ? { bookId, title: String(book?.title ?? ''), job: null, busy: false, error: '' }
      : entries[index];
    const next = entries.filter((entry) => entry.bookId !== bookId);
    next.push({ ...base, job, busy: false, error: '' });
    commit(next);
    scheduleRetire(bookId);
    ensurePolling();
    return job;
  } catch (error) {
    patch(bookId, (entry) => ({ ...entry, busy: false, error: String(error?.message ?? error) }), book);
    return null;
  }
}

/** 停止。已译的节留在磁盘上，再点一次就是「继续」。 */
export async function stop(bookId) {
  const id = String(bookId ?? '');
  if (id === '') return null;
  cancelRetire(id);
  // ★ 先挂 `stopping` 再发请求：这样从这一毫秒起，任何一拍 running 快照都不会
  //   再把界面摇回「正在翻译」（见 `applyJob` 里那段说明）。
  patch(id, (entry) => ({ ...entry, busy: true, stopping: true, error: '' }));
  try {
    const job = await postEbookPrefetch(id, 'stop');
    patch(id, (entry) => ({ ...entry, busy: false }));
    applyJob(id, job);
    return job;
  } catch (error) {
    patch(id, (entry) => ({ ...entry, busy: false, stopping: false, error: String(error?.message ?? error) }));
    return null;
  }
}

/** 用户点了 ×。在跑的**不允许**直接移除 —— 那会让任务变成看不见也停不掉的孤儿。 */
export function dismiss(bookId) {
  const id = String(bookId ?? '');
  const entry = entries.find((item) => item.bookId === id);
  if (entry === undefined) return false;
  if (entry.job?.state === 'running') return false;
  removeEntry(id);
  return true;
}

function patch(bookId, mutate, book = null) {
  const index = entries.findIndex((entry) => entry.bookId === bookId);
  if (index < 0) {
    // 还没有这条（第一次点「整本」时）：先建一条空的，`busy` / `error` 才有地方放。
    if (book === null) return;
    commit([...entries, mutate({ bookId, title: String(book?.title ?? ''), job: null, busy: false, error: '' })]);
    return;
  }
  const current = entries[index];
  const patched = mutate(current);
  if (patched === current) return;
  const next = entries.slice();
  next[index] = patched;
  commit(next);
}

/** 仅供测试：把任务台恢复成初始状态，避免用例之间互相串味。 */
export function __resetForTests() {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  for (const timer of retireTimers.values()) clearTimeout(timer);
  retireTimers.clear();
  entries = [];
}
