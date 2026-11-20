/**
 * 整本预翻的**每节实测耗时**档案（`<pluginData>/prefetch-stats/<bookId>.json`）。
 *
 * ★ 为什么必须落盘（0.63.0，用户原话「你显示了百分比但是没显示剩余时间」）：
 *   ETA 是「最近 5 节的实测耗时 × 剩余节数」算出来的（见 `prefetch.js` 的
 *   `estimateEtaSeconds`），而样本只在**这一轮**每节译完后才有。用户上次翻到
 *   17% 停下（6 节落在磁盘上），隔一会儿点「继续」—— 这一轮第一节还没跑完，
 *   `durations` 是空的，界面就只能写「正在翻译 · 17%」，把「还剩多久」咽回去。
 *   而他要的正是那个数：**已经译过几节这件事，恰好证明过去跑过、耗时可查。**
 *
 * ★ 为什么不塞进译文文件（`ebook-translations/`）：译文是**花过钱**的产物，
 *   这份是「跑得多快」的观测值，会持续被改写。混在一起的话，每记一次耗时都要
 *   重写整本译文（几兆），而且译文文件的失效判据会跟着变脏。
 *
 * ★ 只存「每节毫秒数」这一个数组，不存时间戳、不存节号：
 *   估算只用「最近 5 节的均值」，节号与先后顺序在 `slice(-5)` 里已经隐含。
 *   多存一份节号会让「同一节被重翻」出现两条样本，还要额外去重 —— 而重翻的
 *   那一节耗时同样是有效样本。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BOOK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 档案版本。形状变了就 +1（老文件当「没有样本」，重新积累即可）。 */
export const PREFETCH_STATS_VERSION = 1;

/**
 * 最多留多少条样本。
 *
 * 24 与 `estimateEtaSeconds` 的窗口（最近 5 节）比着留：它只用 5 条，
 * 这里留 24 是为了让「上次跑到中途、这次从另一处继续」也够挑 —— 多出来的
 * 几十条只会让文件从 200 字节涨到 1 KB，没有别的代价。
 */
const MAX_SAMPLES = 24;

/** 单条样本的合理上限（2 小时）。超过就当脏数据丢掉。 */
const MAX_SAMPLE_MS = 2 * 60 * 60 * 1000;

export function createPrefetchStatsStore({ rootDir, log = () => {} } = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') throw new TypeError('prefetchStats: 需要 rootDir');

  const pathOf = (bookId) => join(rootDir, `${bookId}.json`);

  /** 同一本书的写入串行化（两次写并发时，后一次 rename 可能吃掉前一次）。 */
  const queues = new Map();

  /**
   * 读这本书的历史耗时（毫秒）。**任何异常都回空数组** ——
   * 一份坏档案不该让整本翻译开不了跑，最差的结果只是「第一次没有 ETA」。
   */
  async function read(bookId) {
    if (!BOOK_ID.test(String(bookId ?? ''))) return [];
    let text;
    try {
      text = await readFile(pathOf(bookId), 'utf8');
    } catch {
      return [];
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return [];
    }
    if (payload?.v !== PREFETCH_STATS_VERSION || !Array.isArray(payload.durations)) return [];
    return payload.durations
      .filter(value => Number.isFinite(value) && value > 0 && value <= MAX_SAMPLE_MS)
      .slice(-MAX_SAMPLES);
  }

  /** 写档案。只保留最近 {@link MAX_SAMPLES} 条。失败只记日志，**绝不影响翻译**。 */
  async function write(bookId, durations) {
    if (!BOOK_ID.test(String(bookId ?? ''))) return;
    const samples = (Array.isArray(durations) ? durations : [])
      .filter(value => Number.isFinite(value) && value > 0 && value <= MAX_SAMPLE_MS)
      .slice(-MAX_SAMPLES);
    if (samples.length === 0) return;

    const previous = queues.get(bookId) ?? Promise.resolve();
    const task = previous.then(async () => {
      await mkdir(rootDir, { recursive: true });
      const payload = { v: PREFETCH_STATS_VERSION, durations: samples };
      const target = pathOf(bookId);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(payload), 'utf8');
      try {
        await rename(tmp, target);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    }).catch((error) => {
      log(`[书架] 耗时档案写入失败 ${bookId}：${error?.message ?? error}`);
    });
    queues.set(bookId, task);
    // 队列尾部自己清掉，免得 Map 随着书数无限长（一本书一份，长期用会攒几千）。
    task.then(() => { if (queues.get(bookId) === task) queues.delete(bookId); });
    await task;
  }

  return { read, write, pathOf };
}
