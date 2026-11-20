/**
 * 澄境阅读助手（0.60.0，0.61.0 改成分档显示 + 多本并行 + 只列英文书）。
 *
 * 名字与位置来自用户 2026-11-03 的修正（第一版做成了阅读页右下角的小浮层）：
 * 「名字应该是『澄境阅读助手』，放在电子书阅读选项卡的左边栏顶部，然后点击，
 * 弹出助手窗口，罗列出需要翻译的在读英文书籍，然后书籍后面是翻译全本。」
 * 「这个『澄境阅读助手』只在『在读』选项卡下有用，其它都是变灰失效的状态。」
 *
 * 0.61.0 用户又提了三条（截图对照 `kindle-push-macos` 的任务列表）：
 * 「要显示书籍的封面图，每本书显示正在翻译·的百分比，以及还剩约多小小时。
 *  另外，多本书可以同时进行翻译；另外一个问题是，这里只显示需要翻译的英文电子书，
 *  中文的就不要显示在这里面了，所以你要做个过滤。」
 *
 * 六条判据（改动前先读）：
 *
 * 1. **入口在左栏顶部，不在阅读页里。** 它回答的是「哪几本在读的书还没译好」这种
 *    按书架问的问题，属于**列表层**；「我现在就想读这一段」是阅读页里那颗「对照」。
 *    两者不同层，所以不合并，也不互相顶替。
 * 2. **只在「在读」页签可用。** 其它页签里按钮**变灰并且 title 说得出为什么**，
 *    不是隐藏 —— 藏起来的入口等于每次都让人猜「这个功能是不是没了」。
 * 3. **列表只装在读的**、正文是外文的电子书（0.61.0 加的后半句，0.62.0 修对了判据）。
 *    PDF 不进来（没有块模型，整本翻译无从谈起）；**中文书不进来** —— 一本中文书在
 *    这一屏里唯一能给的结论是「不需要翻」，占着一行只会让人多扫一眼。
 *    ★ 判据是宿主的 `script`（整本正文的汉字占比 ≥ 0.7 → `zh`），**不是** `total === 0`：
 *      0.61.0 拿「有几节可翻」反推语种，结果中文段落里夹一串英文人名，那一块就被判成
 *      「该翻」，一本纯中文书因此有几节可翻，于是它照常出现在列表里 —— 用户截图里
 *      《译文名著文库》076/103、《越红钩》三本全是这么混进来的（实测《越红钩》
 *      107 节里 8 节中招）。「有几个可翻的块」与「这本书要不要翻」是两个问题。
 *    ★ 探测失败（`null`）**保留**：未知不等于「中文」，把一本真需要翻的书因为一次
 *      网络抖动藏掉，比多显示一行坏得多。
 * 4. **一本书一行，行里说清三件事**：封面（哪一本）、`正在翻译 · 17% · 还剩约 2.3 小时`
 *    （到哪一步了）、右侧按钮（现在能做什么）。百分比与剩余时间**都来自宿主**：
 *    进度以磁盘为准、ETA 是实测每节耗时算出来的（见 `src/host/ebook/prefetch.js`）。
 * 5. **多本可以同时翻，但上限是宿主的**（0.61.0）。界面不再互相禁用，也不再写
 *    「同一时刻只翻一本」—— 那是 0.59.0 的规定，已被用户推翻。超过上限时宿主回
 *    `EBOOK_PREFETCH_BUSY`，这里把那句话原样显示出来，而不是自己编一个。
 * 6. **关掉窗口不等于停下来。** 翻译在宿主侧跑、进度写在磁盘上；关窗只是收起列表，
 *    左栏那颗按钮上的小点仍然在走，下次打开接着看。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { BookCover } from './BookCover.jsx';
import { formatBytes, isEbookExtension, stateOf } from '../library.js';
import { fetchEbookPrefetch } from './library-api.js';
import { getEntries, start, stop, useTranslateJobs } from './translate-hub.js';

/** 打开窗口时同时向宿主问几本。3 是「一本大 EPUB 解析几秒」与「十本书一行行冒出来」的折中。 */
const PROBE_CONCURRENCY = 3;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function percentOf(job) {
  const raw = Number(job?.percent ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(100, Math.round(raw * 100));
}

/**
 * 这一行下面的那行字。
 *
 * ★ 格式照用户给的参考（`kindle-push-macos` 的任务列表）：**正在做什么 · 百分之几 ·
 *   还剩多久**。他不关心「第 7 节 / 共 14 节」这种中间量 —— 那放 tooltip 里，
 *   想知道细节的人 hover 一下就有，不想知道的人不必每行读三个数字。
 * ★ 剩余时间**只在真的在跑时显示**：停下来的时候那个数是上次的残留，写上去
 *   等于承诺一个没人会兑现的时间。
 */
function subOf(job, book) {
  const size = book?.size ? formatBytes(book.size) : '';
  const withSize = (text) => (size === '' ? text : `${text} · ${size}`);
  if (job === null || job === undefined) return withSize('—');
  const total = Number(job.total ?? 0);
  const done = Number(job.translated ?? 0);
  const failed = Number(job.failed ?? 0);
  if (job.state === 'running') {
    const percent = percentOf(job);
    /*
     * ★ 没有 ETA 时**说一句实话，不要留白**（0.63.0，用户原话「你显示了百分比但是
     *   没显示剩余时间」）。宿主只在**有实测样本**时才给 `eta`（最近 5 节耗时 ×
     *   剩余节数）；这个兜底覆盖两种情况：
     *   · 剩最后几节：宿主回 `null`，其实马上就要完 → 「马上完成」；
     *   · 这本书第一次翻、历史档案是空的：第一节跑完就有数字 → 「正在估算剩余时间」。
     *   留白最糟：用户只会得出「这个功能就是不给剩余时间」。
     *   ★ 不在这里自己拿字符数估一个假数字 —— 那个数会在第一节跑完后突然腰斩，
     *     而他记住的是第一个数。
     */
    const left = total > 0 ? total - done : 0;
    const eta = typeof job.eta === 'string' && job.eta !== ''
      ? ` · ${job.eta}`
      : left <= 0 ? ' · 马上完成' : ' · 正在估算剩余时间';
    return withSize(`正在翻译 · ${percent}%${eta}`);
  }
  if (job.state === 'done') return withSize(`已译完 · 共 ${total} 节`);
  if (job.state === 'idle') return withSize(`待翻译 · 共 ${total} 节`);
  /*
   * `partial`（0.64.0，用户截图「为什么说已翻译完，但是进度条却显示的不完整」）：
   * 宿主跑完了所有待翻的节，**其中几节失败了**。这时候说「已译完」是撒谎 ——
   * 那几节打开时没有对照，而进度条已经把真相画出来了，两句话自相矛盾。
   * 把它说清楚：还差几节、已经译了多少，按钮给「继续」让用户补。
   */
  if (job.state === 'partial') {
    const missing = Math.max(0, total - done);
    return withSize(`还差 ${missing} 节没译成 · 已译 ${done} / ${total} 节`);
  }
  const parts = [`已译 ${done} / ${total} 节`];
  if (failed > 0) parts.push(`${failed} 节没成`);
  return withSize(parts.join(' · '));
}

/** 悬停时补充那些「想知道才看」的中间量。 */
function detailOf(job) {
  if (job === null || job === undefined) return '';
  const parts = [`已译 ${Number(job.translated ?? 0)} / ${Number(job.total ?? 0)} 节`];
  if (job.state === 'running' && job.current?.n != null) parts.push(`正在翻第 ${job.current.n} 节`);
  if (Number(job.failed ?? 0) > 0) parts.push(`${job.failed} 节没成`);
  if (typeof job.error === 'string' && job.error !== '') parts.push(job.error);
  return parts.join(' · ');
}

/**
 * 左栏顶部那颗按钮。
 *
 * ★ 它**自己**订阅任务台，不让 `LibraryApp` 代劳：书架那一层一旦订阅，每 1.5 秒
 *   一次的进度推进就会把整张书单重渲染一遍。这里只需要一个布尔量，而订阅的代价
 *   被关在这颗按钮里面。
 * ★ `urgent` 是「有书停在半路」（stopped / failed）：那不是「在跑」，但也绝不该
 *   看起来像「什么都没发生」—— 一颗灰点比一个静默的按钮有用。
 */
export function ReadingAssistantTrigger({ disabled = false, open = false, onToggle }) {
  const jobs = useTranslateJobs();
  const running = jobs.some((entry) => entry.job?.state === 'running');
  const urgent = !running && jobs.some((entry) => (
    entry.job?.state === 'stopped'
    || entry.job?.state === 'failed'
    // `partial`（0.64.0）：有几节没译成。用户关掉窗口就不会知道，红点点着才算交代过。
    || entry.job?.state === 'partial'
  ));
  return (
    <button type="button"
      className={`npr-icon npr-ra-trigger${open ? ' is-on' : ''}`}
      aria-pressed={open}
      aria-label="澄境阅读助手"
      disabled={disabled}
      title={disabled
        ? '澄境阅读助手只在「在读」页签下可用 —— 它管的是「哪几本在读的书还没译好」'
        : `澄境阅读助手${running ? '：整本翻译正在后台跑' : ''}`}
      onClick={() => onToggle?.()}>
      <Icon name="languages" />
      {(running || urgent) && <span className={`npr-ra-dot${running ? '' : ' is-idle'}`} aria-hidden="true" />}
    </button>
  );
}

function Row({ book, job, busy, onStart, onStop }) {
  const state = job?.state ?? 'idle';
  const percent = percentOf(job);
  const running = state === 'running';
  const done = state === 'done';
  const label = running ? '翻译中'
    : done ? '已译完'
      /*
       * `partial`（0.64.0）：宿主说「这一轮跑完了，但有几节没成」。
       * 它既不是「已译完」（进度条不满），也不是「翻译全本」（已经有 30 节译文，
       * 重翻一遍是白花钱）—— 点它是**接着补那几节**，所以按钮写「继续」。
       */
      : (state === 'stopped' || state === 'failed' || state === 'partial') ? '继续'
        : '翻译全本';
  return (
    <div className={`npr-ra-row is-${state}`}>
      {/* 封面：用户要的第一件事。复用书架那颗 `BookCover`（EPUB 用书里那张真封面、
          PDF 渲染首页、都没有时按书名生成底色），所以同一本书在两处长得一样。 */}
      <div className="npr-ra-cover"><BookCover book={book} /></div>
      <div className="npr-ra-row-main">
        <div className="npr-ra-row-head">
          <span className="npr-ra-title" title={book.title}>{book.title}</span>
          <span className="npr-ra-tag">{String(book.ext ?? '').toUpperCase()}</span>
        </div>
        <div className="npr-ra-sub" title={detailOf(job)}>{subOf(job, book)}</div>
        {state !== 'idle' && (
          <div className="npr-ra-track" aria-hidden="true"><i style={{ width: `${percent}%` }} /></div>
        )}
      </div>
      <div className="npr-ra-row-action">
        <button type="button"
          className={`npr-ra-action${running ? ' is-stop' : ''}${done ? ' is-done' : ''}`}
          disabled={done || busy}
          title={detailOf(job) || label}
          onClick={() => { void (running ? onStop(book.id) : onStart(book)); }}>
          {busy ? '…' : label}
        </button>
      </div>
    </div>
  );
}

export function ReadingAssistantPanel({ open, onClose, books = [], states = {} }) {
  const jobs = useTranslateJobs();
  const [probed, setProbed] = useState({});
  const [scanning, setScanning] = useState(false);
  const [tip, setTip] = useState('');
  const probedRef = useRef(new Set());

  /** 在读的电子书。PDF / DOCX 不进来 —— 整本翻译只对块模型成立。 */
  const ebookTargets = useMemo(() => (Array.isArray(books) ? books : []).filter((book) => (
    isEbookExtension(book?.ext) && stateOf(states, book.id).state === 'reading'
  )), [books, states]);

  const runningEntries = jobs.filter((entry) => entry.job?.state === 'running');

  /**
   * 真正要列出来的那几本。
   *
   * ★ 状态按优先级问：任务台里的实时快照 → 打开窗口时探到的 → 都没有（还没问完）。
   * ★ 判据是**宿主给的 `script`**（0.62.0），不是 `total === 0`：
   *   `script === 'zh'` 才是「这本书是中文书」。0.61.0 拿 `total` 反推是错的 ——
   *   中文段落里夹一串英文人名，那一块就被判成「该翻」，一本纯中文书因此有几节
   *   可翻（用户截图里那三本《译文名著文库》/《越红钩》都是这么混进来的）。
   *   `total === 0` 留着，它说的是另一件事：「这本书一节可翻的都没有」（整本都是
   *   代码 / 图片）。两条都留，因为它们是两个问题。
   * ★ 探测失败（`null`）**保留**：未知不等于「中文」，把一本真需要翻的书因为一次
   *   网络抖动藏掉，比多显示一行坏得多。
   */
  const rows = [];
  let chinese = 0;
  for (const book of ebookTargets) {
    const id = String(book.id);
    const entry = jobs.find((item) => item.bookId === id) ?? null;
    const known = entry !== null || hasOwn(probed, id);
    if (!known) continue;
    const status = entry?.job ?? probed[id] ?? null;
    if (status !== null && status.script === 'zh') { chinese += 1; continue; }
    if (status !== null && Number(status?.total ?? 0) === 0) continue;
    rows.push({ book, id, entry, job: status });
  }
  const hidden = ebookTargets.length - rows.length;

  /** 打开窗口时逐本问一次进度（并发 3）。已问过的靠 `probedRef` 挡，不重复问。 */
  useEffect(() => {
    if (!open) return undefined;
    const pending = ebookTargets.filter((book) => !probedRef.current.has(String(book.id)));
    if (pending.length === 0) return undefined;
    let cancelled = false;
    const queue = [...pending];
    setScanning(true);
    const worker = async () => {
      while (queue.length > 0) {
        const book = queue.shift();
        if (cancelled) return;
        const id = String(book.id);
        let job = null;
        try {
          job = await fetchEbookPrefetch(id);
        } catch {
          // 问不到就当「不知道」：列表照常列出来，按钮仍然能点。
          job = null;
        }
        if (cancelled) return;
        probedRef.current.add(id);
        setProbed((previous) => ({ ...previous, [id]: job }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker))
      .then(() => { if (!cancelled) setScanning(false); });
    return () => { cancelled = true; };
  }, [open, ebookTargets]);

  /**
   * 任务台上推来的快照，顺手记一份到 `probed`。
   *
   * ★ 为什么必须记：译完的条目 **12 秒后自动退场**（判据写在 `translate-hub.js` 里），
   *   退场之后这一行就没有 `entry` 了，会**退回**打开窗口时那次探测的旧快照 ——
   *   刚翻完 14 节的书重新显示「已译 0 / 14 节 · 翻译全本」，看起来像白翻了。
   *   记下每次收到的快照，退场后留下的就是**最后一次真实状态**。
   */
  useEffect(() => {
    if (jobs.length === 0) return;
    setProbed((previous) => {
      let next = null;
      for (const entry of jobs) {
        if (!entry.job || previous[entry.bookId] === entry.job) continue;
        next = next ?? { ...previous };
        next[entry.bookId] = entry.job;
      }
      return next ?? previous;
    });
  }, [jobs]);

  const startHere = useCallback(async (book) => {
    setTip('');
    const job = await start({ id: book.id, title: book.title });
    if (job === null) {
      // ★ 宿主的话原样显示（比如「同时最多翻 4 本」）：自己编一句「稍后再试」
      //   会让用户以为是自己点慢了，而其实是撞了上限。
      const error = getEntries().find((entry) => entry.bookId === String(book.id))?.error;
      setTip(error !== undefined && error !== '' ? error : `没能启动《${book.title}》的整本翻译，稍后再试`);
      return;
    }
    setProbed((previous) => ({ ...previous, [String(book.id)]: job }));
    if (Number(job.total ?? 0) === 0) {
      setTip(`《${book.title}》没有需要翻译的英文（中文正文，或者只有代码 / 图片）`);
    }
  }, []);

  const stopHere = useCallback(async (bookId) => { await stop(bookId); }, []);

  const stopAll = useCallback(async () => {
    await Promise.all(runningEntries.map((entry) => stop(entry.bookId)));
  }, [runningEntries]);

  if (!open) return null;

  const pendingCount = rows.filter((row) => row.job === null || row.job.state !== 'done').length;
  const caption = runningEntries.length > 0
    ? `正在翻译 ${runningEntries.length} 本`
    : ebookTargets.length === 0
      ? '在读的书里没有电子书'
      : rows.length === 0 && scanning
        ? '正在挑出需要翻译的书…'
        : `在读 ${rows.length} 本外文书 · ${pendingCount} 本还没译完`;

  return (
    <>
      {/* 点遮罩关窗：这是一个「看一眼就走」的窗口，不该逼人回右上角找 ×。 */}
      <div className="npr-ra-scrim" role="presentation" onClick={() => onClose?.()} />
      <section className="npr-ra-window" role="dialog" aria-modal="true" aria-label="澄境阅读助手">
        <header className="npr-ra-head">
          <div className="npr-ra-head-text">
            <h2 className="npr-ra-name">澄境阅读助手</h2>
            <p className="npr-ra-caption">{caption}</p>
          </div>
          <button type="button" className="npr-icon npr-ra-close" title="关闭" aria-label="关闭"
            onClick={() => onClose?.()}>
            <Icon name="x" />
          </button>
        </header>

        <div className="npr-ra-body">
          {ebookTargets.length === 0 ? (
            <p className="npr-ra-empty">
              这个页签里还没有电子书。<br />
              到「书架」把想读的 EPUB / MOBI / AZW3 / TXT 加进阅读列表，它们就会出现在这儿。
            </p>
          ) : rows.length > 0 ? rows.map(({ book, id, entry, job }) => (
            <Row key={id} book={book} job={job}
              busy={entry?.busy === true || entry?.stopping === true}
              onStart={startHere} onStop={stopHere} />
          )) : scanning ? (
            <p className="npr-ra-empty">正在挑出需要翻译的书…</p>
          ) : (
            <p className="npr-ra-empty">
              {chinese === ebookTargets.length
                ? <>在读的 {chinese} 本正文都是中文，不需要翻译。<br />中文书不占这一屏 —— 「对照」在这些书里也是灰的。</>
                : <>在读的 {hidden} 本没有可翻的正文，不需要翻译。<br />助手只列正文是外文的电子书 —— 中文书不占这一屏。</>}
            </p>
          )}
          {tip !== '' && <p className="npr-ra-error">{tip}</p>}
        </div>

        <footer className="npr-ra-foot">
          <p className="npr-ra-foot-note">
            翻译在后台跑，关掉这个窗口也不会停；译过的节留在磁盘上，接着翻不用重花钱。
          </p>
          {runningEntries.length > 0 && (
            <button type="button" className="npr-ra-stopall"
              disabled={runningEntries.some((entry) => entry.busy === true || entry.stopping === true)}
              onClick={() => { void stopAll(); }}>
              {runningEntries.some((entry) => entry.stopping === true)
                ? '正在停止…'
                : runningEntries.length > 1 ? '全部停止' : '停止'}
            </button>
          )}
        </footer>
      </section>
    </>
  );
}
