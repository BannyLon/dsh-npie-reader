/**
 * 电子书**整本预翻**的调度、进度与剩余时间（0.59.0）。
 *
 * 为什么要有它：
 *   0.57.0 的对照是「翻到哪节译哪节」。一本 16 节的书想全译完，用户得**手动往下
 *   翻 16 次、每次干等 30–60 秒**；而且等的正是他此刻想读的那一段。整本预翻把这件事
 *   挪到后台：点一次，去倒杯水，回来每一节都秒开。
 *
 * ★ 进度以**磁盘**为准，不以内存为准。
 *   译文本来就是逐节落盘的（`translation-store.js`），所以「已译几节」随时可以
 *   从缓存目录数出来。内存里那份 run 只负责liveness（正在翻第几节、还要多久）。
 *   两者分开的好处：进程重启、任务被强杀、用户换了个页面 —— 进度条都不会撒谎，
 *   因为它问的是磁盘，而不是一个可能已经不存在的对象。
 *
 * ★ 剩余时间是**实测**的，不是估的。
 *   参考实现（kindle-push-macos）靠正则抓引擎日志里的 tqdm 尾巴
 *   （`21%|...<4:18:22`）算剩余；引擎一换版本、日志格式一变，那个正则就静默失效，
 *   界面上的「还剩 4.3 小时」会变成一个永不更新的数字。这里不用正则：每节跑完
 *   记一次真实耗时，取最近几节的平均值乘剩余节数。节数一旦变化（用户删了书、
 *   缓存被清），估算跟着变，不会失灵。
 *
 * ★ 分母是「有可翻文字的节」，不是「全书节数」。
 *   纯中文节、只有代码的节、只有图片的节，永远不会有译文。把它们算进分母，
 *   进度条就会永远停在 97% 然后显示「还剩 1 节」，而那一节其实根本不需要翻。
 */
import { blockSegments } from '../../ebook-translate.js';

/**
 * 同时在跑的书数上限（0.61.0）。
 *
 * 4 不是拍脑袋：每个任务在循环里持有一份整本解析结果（`ebookOf` 每次都重新解析），
 * 一本 100 MB 的 EPUB 解析后正文常驻几十兆 —— 10 本并行就是几百兆。
 * 而「同时备好 4 本」已经覆盖了真实用法（点几本常读的英文书，然后去干别的）。
 * 超了就明确报错，不偷偷排队（见 `createPrefetchRunner` 的说明）。
 */
export const DEFAULT_MAX_CONCURRENT = 4;

/**
 * 这本书要翻哪些节。
 *
 * @param ebook - `parseEbook()` 的产物，只用 `sections[].blocks`。
 * @param translated - 磁盘上已译的节号。
 * @returns `{ total, translatable, skipped, targets, cached }`
 *   `total` = 有可翻文字的节数（进度条的分母）；
 *   `targets` = 还没译、这次真的要翻的节号；
 *   `cached` = 开跑前就已经译好的节数。
 */
export function planPrefetch(ebook, translated = []) {
  const sections = Array.isArray(ebook?.sections) ? ebook.sections : [];
  const done = new Set((Array.isArray(translated) ? translated : []).map(Number));
  const translatable = [];
  const skipped = [];
  sections.forEach((section, index) => {
    const n = index + 1;
    // 判据与渲染端、与 `translateEbookSection` 完全同源（`blockSegments`），
    // 不另写一套「这段算不算英文」——那套判据一旦漂移，进度和实际译文就对不上。
    if (blockSegments(section?.blocks).length === 0) {
      skipped.push(n);
      return;
    }
    translatable.push(n);
  });
  const targets = translatable.filter(n => !done.has(n));
  return {
    total: translatable.length,
    translatable,
    skipped,
    targets,
    cached: translatable.length - targets.length,
    /*
     * ★ 这本书的语种（0.62.0），直接从解析结果带出来。
     *   **不能**用 `total === 0` 反推「是不是中文书」—— 中文段落里夹一串英文人名，
     *   那一块就会被判成「该翻」，一本纯中文书因此有几节可翻（实测《越红钩》
     *   107 节里有 8 节中招）。`total` 说的是「有几节有可翻的块」，
     *   与「这本书要不要翻」是两个问题。
     */
    script: ebook?.script ?? 'unknown',
  };
}

/**
 * 进度 0…1。
 *
 * `partialSection` 是**当前这一节内部**的进度（0…1，来自分批回调）。
 * 加它是为了长节不至于「卡住不动」：一节切成 5 批、跑 3 分钟时，进度条若只按整节
 * 跳，用户会以为卡死了。
 */
export function prefetchPercent(total, finished, partialSection = 0) {
  const whole = Number(total) || 0;
  if (whole <= 0) return 1;
  const raw = (Number(finished) || 0) + (Number(partialSection) || 0);
  return Math.max(0, Math.min(1, raw / whole));
}

/**
 * 还要多久（秒）。样本不足时返回 `null` —— 「不知道」比「0 分钟」诚实。
 *
 * ★ 只取最近 5 节：整本平均会被最早那几节的冷启动（第一次请求要建连接、
 *   模型侧可能冷）拉长，于是「还剩 3 小时」会一路虚高，跑到后面才快速下跌。
 *   最近几节更接近「接下来还要多久」。
 *
 * ★ **单位必须在这里换算掉**（0.63.1 修的真 bug）：`durations` 是
 *   `Date.now() - startedAt`，单位**毫秒**；而这个函数按约定返回**秒**，
 *   下游 `etaText(seconds)` 也按秒分档。0.59.0 起一直漏了这一步 ——
 *   结果 `毫秒 × 节数` 被当成秒，一本还剩 1.9 小时的书显示成
 *   「还剩约 1858.8 小时」（正好放大 1000 倍，用户截图里的那个数）。
 *   测试当时也没拦住：那条断言把 `10_000`（毫秒）写成注释里的「10 秒」，
 *   等于用同一个单位错觉把 bug 锁进了预期值里。
 */
export function estimateEtaSeconds(durations, remaining) {
  const list = (Array.isArray(durations) ? durations : []).filter(v => Number.isFinite(v) && v > 0);
  if (list.length === 0 || !Number.isFinite(remaining) || remaining <= 0) return null;
  const recent = list.slice(-5);
  const averageMs = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  return Math.round((averageMs * remaining) / 1000);
}

/**
 * 剩余时间的人话。
 *
 * 分档与参考实现一致（< 45 秒不说分钟数），因为它对了一个细微的点：
 * 「还剩约 0 分钟」比「马上完成」难看得多。
 */
export function etaText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 45) return '马上完成';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `还剩约 ${Math.max(1, minutes)} 分钟`;
  const hours = (seconds / 3600).toFixed(1);
  return `还剩约 ${hours.endsWith('.0') ? hours.slice(0, -2) : hours} 小时`;
}

/**
 * 整本预翻的调度器。
 *
 * 同一本书**同时只跑一个**：再点一次「整本」返回正在跑的那个，而不是排第二份 ——
 * 两份会重复计费，而且后写的那份会覆盖前一份的译文（模型两次译文不同，用户看着
 * 看着字变了）。
 *
 * ★ **不同书可以并行**（0.61.0，用户原话「多本书可以同时进行翻译」）。
 *   0.59.0 一开始规定「同时只跑一本」，理由是「每节本身就是一次模型调用，两本
 *   并行等于把请求数翻倍」。那个理由是错的：**每个任务内部本来就是逐节串行**的，
 *   所以同时跑 N 本 = 同时在飞的 N 个请求，不是 2N 倍；而「把书备好」这件事从来
 *   不要求用户守在旁边一本一本点。真正需要守的是**上限**：
 *   · 每个任务在自己的闭包里持有一份整本解析结果（`ebookOf` 每次调用都重新解析，
 *     所以循环里只能拿着那一份），N 本并行就是 N 份正文常驻内存；
 *   · 每本书内部仍然是**逐节**跑，所以「N 本并行」不会让单本的进度变慢成 1/N，
 *     只会让总请求数随 N 线性上升。
 *   于是上限取 {@link DEFAULT_MAX_CONCURRENT}，超了**明确报错**（`EBOOK_PREFETCH_BUSY`），
 *   而不是偷偷排队 —— 排队要持久化、要能解释「为什么我点了没反应」，
 *   而这里用户要的只是「再点两本一起翻」。
 *
 * @param {object} options
 * @param {number} [options.maxConcurrent] 同时在跑的书数上限（默认 4）。
 * @param {(book: object) => Promise<object>} options.resolveEbook 解析整本（解析缓存）
 * @param {(book: object, ebook: object, n: number, options: object) => Promise<object>} options.translateSection
 * @param {(bookId: string) => Promise<number[]>} options.translatedSections 磁盘上已译的节号
 * @param {object} [options.stats] 每节实测耗时的档案（`prefetch-stats.js`）。
 *   给了它，ETA 就能用**上次**跑出来的样本 —— 否则「继续翻一本译到 17% 的书」
 *   在第一轮跑完一节之前都没有数字（0.63.0 修的就是这个）。缺省不持久化。
 * @param {(message: string) => void} [options.log]
 */
export function createPrefetchRunner({
  resolveEbook, translateSection, translatedSections, stats = null, log = () => {},
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
} = {}) {
  if (typeof resolveEbook !== 'function') throw new TypeError('prefetchRunner: 需要 resolveEbook');
  if (typeof translateSection !== 'function') throw new TypeError('prefetchRunner: 需要 translateSection');
  if (typeof translatedSections !== 'function') throw new TypeError('prefetchRunner: 需要 translatedSections');
  const limit = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : DEFAULT_MAX_CONCURRENT;

  /** `bookId → run`。跑完也留着，让界面还能看到「刚才那轮翻了 2 节、失败 1 节」。 */
  const runs = new Map();

  /** 正在跑的书数（不是节数）。 */
  function runningCount() {
    let count = 0;
    for (const run of runs.values()) if (run.state === 'running') count += 1;
    return count;
  }

  function snapshot(run) {
    /*
     * ★ `finished` **只数真的拿到译文的节**（开跑前就有的 + 这一轮译成的），
     *   不数失败的那几节。把它们算进进度，进度条跑到 100% 而书里还缺两节，
     *   用户会把「100%」当成「都能看了」—— 那正是这条功能最不该给的错觉。
     *   失败的节让进度条停在 12/14，旁边写「有 2 节没翻成」，他才好点重试。
     */
    const finished = run.cached + run.done;
    const remaining = Math.max(0, run.total - finished);
    const partial = run.current !== null && run.current.chunks > 0
      ? run.current.chunk / run.current.chunks
      : 0;
    const etaSeconds = run.state === 'running' ? estimateEtaSeconds(run.durations, remaining) : null;
    return {
      bookId: run.bookId,
      state: run.state,
      /** 这本书的语种（0.62.0）：`zh` / `latin` / `unknown`。见 `planPrefetch`。 */
      script: run.script ?? 'unknown',
      total: run.total,
      planned: run.planned,
      cached: run.cached,
      done: run.done,
      /** 有译文的节数（`cached + done`）—— 界面上「已译 6 / 14 节」用的就是它。 */
      translated: finished,
      failed: run.failed.length,
      // 只带前几条节号：界面用来说「第 7、12 节没翻成，点这里重试」。
      failedSections: run.failed.slice(0, 5).map(item => item.n),
      skipped: run.skipped,
      current: run.current === null
        ? null
        : { n: run.current.n, title: run.current.title, chunk: run.current.chunk, chunks: run.current.chunks },
      percent: prefetchPercent(run.total, finished, partial),
      etaSeconds,
      eta: etaSeconds === null ? '' : etaText(etaSeconds),
      elapsedSeconds: Math.max(0, Math.round(((run.finishedAt || Date.now()) - run.startedAt) / 1000)),
      error: run.error,
    };
  }

  /** 开始（或接回）整本预翻。解析失败就在这里抛 —— 让路由回一个能读懂的错。 */
  async function start(book) {
    const bookId = String(book?.id ?? '');
    if (bookId === '') throw new Error('没有这本书');

    const mine = runs.get(bookId);
    if (mine !== undefined && mine.state === 'running') return snapshot(mine);
    // ★ 同一个 `bookId` 的旧 run（done / stopped / failed）不拦：那本书再点一次是
    //   「接着翻」，`planPrefetch` 会按磁盘上的已译节重新算 target。
    if (runningCount() >= limit) {
      const error = new Error(`同时最多翻 ${limit} 本，等一本跑完、或者先停掉一本`);
      error.code = 'EBOOK_PREFETCH_BUSY';
      error.limit = limit;
      throw error;
    }

    const ebook = await resolveEbook(book);
    const plan = planPrefetch(ebook, await translatedSections(bookId));
    /*
     * ★ 中文书**在宿主这一层就拒掉**（0.62.0），不只是界面上不列出来。
     *   界面过滤解决的是「看不见」，这一句解决的是「点得到」：书单会变（用户刚
     *   导入一本中文书、页签刚好还开着），而一旦真跑起来是**逐节调模型**——
     *   白花的钱与白等的几十分钟都收不回来。
     *   `unknown` 不拒：判不出来不等于中文（见 `bookScript` 的 `SCRIPT_MIN_LETTERS`）。
     */
    if (plan.script === 'zh') {
      const error = new Error('这本书的正文是中文，不需要翻译（对照也不需要）');
      error.code = 'EBOOK_PREFETCH_CHINESE';
      throw error;
    }
    const titles = new Map((ebook.sections ?? []).map((section, index) => [index + 1, section?.title ?? '']));
    /*
     * ★ 历史耗时**先读回来**（0.63.0）：`status()` 与 `snapshot()` 都靠
     *   `run.durations` 算 ETA，而它原本只在「这一轮每节译完」后才有值。
     *   于是「上次译到 17% 停下、这次点继续」—— 百分比有了（那是磁盘的结论），
     *   剩余时间却没有（那是内存的结论），正是用户截图里的样子。
     *   读失败按空数组处理：最差只是这一轮开头没有 ETA，不能因此开不了跑。
     */
    const history = stats === null
      ? []
      : await stats.read(bookId).catch(() => []);
    const run = {
      bookId,
      state: 'running',
      script: plan.script,
      controller: new AbortController(),
      total: plan.total,
      planned: plan.targets.length,
      cached: plan.cached,
      skipped: plan.skipped.length,
      done: 0,
      failed: [],
      durations: Array.isArray(history) ? history : [],
      current: null,
      startedAt: Date.now(),
      finishedAt: 0,
      error: '',
      promise: null,
    };
    runs.set(bookId, run);

    if (plan.targets.length === 0) {
      run.state = 'done';
      run.finishedAt = Date.now();
      return snapshot(run);
    }

    // ★ 刻意**不 await**：路由要立刻回响应，否则浏览器会挂到整本翻完（几小时）。
    //   错误在这里就地吞掉并记进 run，不让它变成 unhandledRejection（Node ≥15 会因此终止进程）。
    // ★ `ebook` 跟着传进循环：解析一本 100 MB 的 EPUB 要几秒、占几十兆，
    //   每节重解一遍是纯浪费。它在任务期间被这一个闭包持有，任务结束即释放。
    run.promise = loop(book, ebook, run, plan.targets, titles)
      .catch((error) => {
        run.state = 'failed';
        run.error = String(error?.message ?? error);
        log(`[书架] 整本预翻中断 ${bookId}：${run.error}`);
      })
      .finally(() => {
        run.finishedAt = run.finishedAt || Date.now();
        log(`[书架] 整本预翻结束 ${bookId}：${run.state} 译 ${run.done}/${run.planned} 失败 ${run.failed.length}`);
      });
    return snapshot(run);
  }

  /**
   * 逐节跑。**单节失败不拖垮整本** —— 与逐章解读同一条纪律：
   * 16 节里第 7 节撞上一次 429 就放弃后面 9 节，用户得到的是「几乎什么都没译」；
   * 继续跑完、把那一节记下来，他点一下就能补。
   */
  async function loop(book, ebook, run, targets, titles) {
    for (const n of targets) {
      if (run.controller.signal.aborted) {
        run.state = 'stopped';
        break;
      }
      const startedAt = Date.now();
      run.current = { n, title: titles.get(n) ?? '', chunk: 0, chunks: 0 };
      try {
        const result = await translateSection(book, ebook, n, {
          signal: run.controller.signal,
          // 分批回调：让长节在进度条上也动一下（见 `prefetchPercent`）。
          onChunk: ({ index, total }) => {
            if (run.current === null || run.current.n !== n) return;
            run.current.chunk = index + 1;
            run.current.chunks = total;
          },
        });
        /*
         * ★ 译出来了、但**没写进磁盘**（0.64.0）：这时算它「成功」就是在骗进度条 ——
         *   磁盘上没有这一节，下次打开要重翻（重复计费），而界面已经宣布译完。
         *   和失败的节同等对待：不计进度、留在 `failedSections` 里等重试。
         *   老调用方不返回这个字段，默认视为已落盘。
         */
        if (result?.persisted === false) {
          run.failed.push({ n, error: '译文没能写进磁盘' });
          continue;
        }
        run.done += 1;
        run.durations.push(Date.now() - startedAt);
        /*
         * **每节译完就落盘**（0.63.0），而且 `await`。
         * 为什么不是「每 3 节」也不是 fire-and-forget：真实用法里下一件事往往就是
         * ⌘Q（用户会关窗、会退出 dsh）。省下这几次写盘，代价是**第一节白跑**——
         * 而第一节恰恰是唯一能让「正在估算剩余时间」变成数字的那一节。
         * 一次写是几百字节、几毫秒，而节与节之间本来就隔着一次模型调用。
         */
        if (stats !== null) await stats.write(run.bookId, run.durations);
      } catch (error) {
        // ★ 用户主动停止**不是失败**。算进 failed 的话，界面会显示「译了 6 节、
        //   失败 1 节」，而他明明只是不想继续了。
        if (run.controller.signal.aborted) {
          run.state = 'stopped';
          break;
        }
        run.failed.push({ n, error: String(error?.message ?? error) });
      } finally {
        run.current = null;
      }
    }
    /*
     * ★ `done` 只能表示**真的译完了**（0.64.0 修）。
     *   这里原来无条件写 `done`，而 `loop` 只保证「每个待翻的节都**试过**一遍」——
     *   失败的那几节也「试过」了。于是状态说译完、进度条却停在 83%：
     *   用户截图里那句「已译完 · 共 36 节」配着一条没满的进度条，就是这么来的。
     *   失败的节留在 `run.failed` 里，界面上应该说「还差 6 节没成」，而不是「已译完」。
     */
    if (run.state === 'running') run.state = run.failed.length > 0 ? 'partial' : 'done';
    run.finishedAt = Date.now();
    /*
     * 收尾必写一次（0.63.0）：跑到第 2 节就被停、或译完的节数不是 3 的倍数时，
     * 上面那条「每 3 节」永远不会触发 —— 而这一轮恰恰积累了几个有效样本，
     * 扔掉它们等于下次开跑又从零开始。
     */
    if (stats !== null) void stats.write(run.bookId, run.durations);
  }

  /** 停止。只对正在跑的这本书有效；没在跑就返回 `false`，不报错。 */
  function stop(bookId) {
    const run = runs.get(String(bookId ?? ''));
    if (run === undefined || run.state !== 'running') return { stopped: false };
    // 只 abort，不改 state：loop 会在下一轮开始前或 catch 里把它改成 `stopped`，
    // 这样「正在飞的那一节」到底是完成了还是被打断了，只有一个地方下结论。
    run.controller.abort();
    return { stopped: true };
  }

  /**
   * 当前进度。**没在跑也回一份**（来自磁盘），因为界面需要它来画
   * 「已译 3 / 14 节」那个初始值。
   */
  async function status(book) {
    const bookId = String(book?.id ?? '');
    if (bookId === '') throw new Error('没有这本书');
    const run = runs.get(bookId);
    if (run !== undefined && run.state === 'running') return snapshot(run);

    const ebook = await resolveEbook(book);
    const plan = planPrefetch(ebook, await translatedSections(bookId));
    const baseline = {
      bookId,
      // ★ 没有内存记录时，「没有任何待翻的节」就是 done —— 这是**磁盘**的结论，
      //   不是上一次运行的残留。进程重启后进度条仍然说真话，靠的就是这一句。
      state: plan.targets.length === 0 && plan.total > 0 ? 'done' : 'idle',
      script: plan.script,
      total: plan.total,
      planned: plan.targets.length,
      cached: plan.cached,
      done: 0,
      translated: plan.cached,
      failed: 0,
      failedSections: [],
      skipped: plan.skipped.length,
      current: null,
      percent: prefetchPercent(plan.total, plan.cached),
      etaSeconds: null,
      eta: '',
      elapsedSeconds: 0,
      error: '',
    };
    if (run === undefined) return baseline;
    // 这一进程里已经跑过一轮：把它最后的结论（stopped / failed / 失败节号）盖回来，
    // 但进度数字仍然用磁盘的 —— 两者不一致时，磁盘才是真的。
    //
    // ★ `done` 必须与「进度条 100%」等价（0.64.0）：本轮已译节数不够 `total` 时，
    //   结论只能是「没译完」（`partial`），否则又会出现「已译完 + 83%」。
    //   判据用**本轮内存里的数字**（`cached + done`），不重新问磁盘 —— `plan.cached`
    //   依赖 `translatedSections` 读回，某些路径上会比写入慢一拍，拿它当判据会把
    //   「刚译完」误判成「没译完」。run 自己的计数在 loop 里逐节同步累加，没有时间差。
    const finishedInRun = run.cached + run.done;
    const state = run.state === 'done' && finishedInRun < run.total ? 'partial' : run.state;
    return {
      ...baseline,
      state,
      failed: run.failed.length,
      failedSections: run.failed.slice(0, 5).map(item => item.n),
      error: run.error,
    };
  }

  return { start, stop, status };
}
