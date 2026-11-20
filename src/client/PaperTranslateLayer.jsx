/**
 * 论文译文覆盖层（D 档 0.70.0 → 0.71.0）：在原 PDF 页面上把英文段落换成中文。
 *
 * 为什么是「覆盖层」而不是另一棵树 ------------------------------------------
 * 画布是 pdf.js 画的位图，公式、图、表格都在上面。要「保留公式和版面」，就不能
 * 重新渲染一页 HTML —— 只能按每段的原文框盖一块白底，再把重排好的中文字绝对
 * 定位铺上去。这正是单页探针（13/13 段放下、零溢出、35–40ms/页）验证过的形态。
 *
 * 0.71.0 的变化 -------------------------------------------------------------
 * 缓存与「取哪一页来翻」搬到了共用的 `paper-translation.js`：逐页按需与整本
 * 一次翻完走同一条链路、同一份内存 + 磁盘缓存。这里只负责订阅当前页的译文，
 * 再把它排版成 DOM 块。整本模式在后台译到当前页时，本组件会被通知并立刻换字。
 *
 * ★ 这个组件**不改 BookReader 的任何状态**：它只拿 `pageView`（当前页的 pdf.js
 *   对象与渲染 scale）和 active 开关。阅读器那 2900 行里只多三处接线。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  cancelPageTranslation, dismissWholeBookJob, ensurePageTranslation, formatDuration,
  pageTranslationVersion, PAGE_STEP_TEXT, stopWholeBookTranslation, subscribePageTranslation,
  translationKey, usePageTranslationTask, useWholeBookJob,
} from './paper-translation.js';
import { Icon } from './icons.jsx';
import { browserReflowFonts, fontFamily, layoutPage, overlayBlocksOf } from './paper-reflow/index.js';

let cachedFonts = null;
/** 字体度量要用 canvas，懒建一次；Node 侧跑纯函数测试时不会走到这里。 */
function reflowFonts() {
  if (cachedFonts === null) cachedFonts = browserReflowFonts();
  return cachedFonts;
}

/**
 * 「已经等了 12 秒」这句读数。
 *
 * ★ 单独一层组件，只为了让**秒数**每秒重渲染一次：挂在 `PaperTranslateLayer`
 *   上就是几十个绝对定位的 `<span>` 每秒全部重排一遍（正是上一轮「翻译时卡」的形态）。
 * ★ 计时靠 `startedAt` 而不是 `mount` 时间：中文到达后组件会换一次状态，
 *   但真正想回答的是「这一页翻多久了」，跟着任务走才对。
 */
function WaitingSeconds({ startedAt }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!startedAt) { setSeconds(0); return undefined; }
    const tick = () => setSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  /* ★ `aria-hidden`：秒数每秒变一次，`role="status"` 的容器会把它当成内容更新
     逐秒播报一遍，读屏用户听到的就是「3 秒、4 秒、5 秒…」。 */
  return <span className="npr-book-wait-sec" aria-hidden="true">{seconds} 秒</span>;
}

export function PaperTranslateLayer({ bookId, pageView, active, notify, attempt = 0, pinHost = null }) {
  const [entry, setEntry] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 非错误的一句话解释（这一页没有可翻的字、有几段放不下）。 */
  const [notice, setNotice] = useState('');
  /** 用户按了「暂停」之后的说明（不是错误，所以不走红色）。 */
  const [paused, setPaused] = useState('');
  /** 用户按了「关闭」：这条胶囊收起来，直到换页 / 重新点翻译。 */
  const [closed, setClosed] = useState(false);
  /** 胶囊上那颗「重试」：让 effect 再跑一轮（`attempt` 来自菜单，这里是自己）。 */
  const [retry, setRetry] = useState(0);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const viewRef = useRef(pageView);
  viewRef.current = pageView;
  /**
   * 「译文存不到本机」只提示一次。
   *
   * ★ 这件事在 0.71.0–0.71.2 是**哑失败**：段落 id 带冒号被落盘校验全丢，
   *   每页都写不进去，界面却一句提示都没有，用户看到的是「每次重开都重翻」。
   *   现在写入结果由 `ensurePageTranslation()` 返回 `persisted`，这里说一句。
   *   只提示一次：每页都弹一遍会盖掉真正的内容。
   */
  const unsavedToldRef = useRef(false);

  const key = pageView === null ? '' : translationKey(bookId, pageView.page);
  /** 只有**这一页**的译文到达才变号：整本在后台翻别的页不会让当前页重跑。 */
  const snapshot = useCallback(() => pageTranslationVersion(key), [key]);
  const version = useSyncExternalStore(
    useCallback(listener => subscribePageTranslation(key, listener), [key]),
    snapshot,
    // ★ 第三个参数不能省：阅读器有服务端渲染（真渲染测试走 react-dom/server），
    //   少了它会直接抛 "Missing getServerSnapshot"，界面表现为一打开阅读页白屏。
    snapshot,
  );
  /**
   * 这一页翻到哪一步了。
   *
   * ★ 判据在 `paper-translation.js`，与顶部菜单那颗「翻译这一页」**共用一份**：
   *   组件自己再存一份的话，菜单永远不知道翻译已经开始（这正是用户报的
   *   「点了没反应，按钮也不灰」）。
   */
  const task = usePageTranslationTask(key);
  const running = task.state === 'running';

  useEffect(() => {
    if (!active || key === '') {
      setEntry(null);
      setError('');
      setNotice('');
      setPaused('');
      setClosed(false);
      setBusy(false);
      return undefined;
    }
    const view = viewRef.current;
    if (view === null) return undefined;
    let cancelled = false;
    setBusy(true);
    setError('');
    setNotice('');
    setPaused('');
    // 新的一次翻译（换页 / 菜单重试 / 胶囊上的重试）要把上一条提示放出来。
    setClosed(false);
    // 同一页的缓存刷新不要先把中文撤掉（会闪一下英文），只换页时才清空。
    setEntry(current => (current?.key === key ? current : null));
    void (async () => {
      try {
        const result = await ensurePageTranslation({
          bookId, pdfPage: view.pdfPage, page: view.page,
          /**
           * ★ 分批页每回来一批就先铺上去（0.78.0）。
           *   用户实测一页 168 秒（第 1/2 批），而两批串行时前 80 秒屏幕上
           *   一个字都不会变 —— 看上去像卡死了。现在先到的半页立刻变中文，
           *   剩下半页随后补上，缺的段落保留英文（排版层对缺失 id 天然不画）。
           */
          onPartial: (partial) => {
            if (cancelled) return;
            setEntry({ ir: partial.ir, translations: partial.translations, key });
          },
        });
        if (cancelled) return;
        setEntry({ ir: result.ir, translations: result.translations, key });
        // 全是图 / 本来就是中文：给出解释，不然用户会以为「点了没反应」。
        if (result.empty) setNotice('这一页没有需要翻译的文字（图内的字不动）');
        if (result.persisted === false && !unsavedToldRef.current) {
          unsavedToldRef.current = true;
          notifyRef.current?.('译文显示出来了，但没能存到本机：下次打开这一页还要重新翻译');
        }
      } catch (cause) {
        if (cancelled) return;
        // ★ 暂停不是失败：不报红、不弹提示。已回来的那批中文留在屏幕上
        //   （钱已经花了），但要说明它没落盘 —— 否则用户重开发现又变英文。
        if (cause?.code === 'PAUSED') {
          setPaused('已暂停，这一页的译文不存到本机');
          return;
        }
        const message = cause?.message ?? String(cause);
        setError(message);
        notifyRef.current?.(`翻译这一页没成功：${message}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
    // ★ 依赖里**没有** `pageView.scale`：缩放只重排版，不能重新调模型。
    //   `notify` 每次渲染可能是新函数，走 ref，不进依赖。
    // ★ `attempt`（菜单点「翻译这一页」）与 `retry`（胶囊上的「重试」）在依赖里：
    //   暂停过之后 `translateOn` 已经是 true，没有这两个勾子就再也点不动这一页。
  }, [active, key, version, bookId, attempt, retry]);

  const blocks = useMemo(() => {
    if (entry === null || pageView === null) return [];
    try {
      return overlayBlocksOf(layoutPage(entry.ir, entry.translations, reflowFonts()), pageView.scale);
    } catch {
      // 排版失败不该把整页变成白屏：这一页就保持原文，状态里给出原因。
      return [];
    }
  }, [entry, pageView?.scale]);

  /**
   * ★ 只画 `fits === true` 的段（上游 `page-overlay.tsx` 的 `filter(p => p.fits)`）。
   *   放不下的段**保留原文**，一个像素都不盖 —— 上一版把放不下的段也铺上去，
   *   中文溢出到下一段，用户看到的就是两段字叠在一起。
   */
  const placed = useMemo(() => blocks.filter((block) => block.fits), [blocks]);
  const skipped = blocks.length - placed.length;

  /**
   * 「N 段排不下」用**一次性提示**，不是常驻胶囊。
   * 常驻等于每翻一页顶一个横条，而这件事本身是「这一段保持英文」——页面看起来
   * 就是对的，不需要一直解释。一次性提示只在真的发生了的时候说一次。
   */
  const toldRef = useRef('');
  useEffect(() => {
    if (busy || skipped === 0) return;
    const stamp = `${key}#${skipped}`;
    if (toldRef.current === stamp) return;
    toldRef.current = stamp;
    notifyRef.current?.(`这一页有 ${skipped} 段排不下，已保留原文`);
  }, [busy, skipped, key]);

  if (!active) return null;
  /**
   * 状态胶囊本体（0.78.1 起可能被 portal 送到阅读区）。
   *
   * ★ 为什么从「书页里」搬出来：它原来挂在 `.npr-book-translation` 里，随书页一起
   *   被 `.npr-book-stage` 那个滚动容器裁剪 —— 用户 2026-11-14 的原话是
   *   「改成钉在阅读区中心（不随页面滚动）」。页面比窗口高时，那条「正在翻译」
   *   会直接滚出视野，等两分钟看不到任何进度。
   * ★ `pinHost` 由 `BookReader` 给出（`.npr-book-pins`，stage 的兄弟节点）。
   *   拿不到时退回原来的画法：服务端渲染（`react-dom/server` 不支持 portal）、
   *   以及还没挂载完的首帧，都不该把这条提示丢掉。
   */
  const capsule = !closed && (running || error !== '' || notice !== '' || paused !== '')
    ? (
      <div className={`npr-book-translation-status${error !== '' ? ' is-error' : running ? ' is-busy' : ''}`} role="status">
        <span className="npr-book-translation-status-line">
          <span className="npr-book-translation-status-text">
            {error !== ''
              ? error
              // ★ 阶段而非百分比：一页只发一次模型请求，模型不回流中途进度。
              //   段落超限分批时才有真实里程碑（第 2/3 批），那时说出来。
              : running
                ? (task.batches > 1 && task.batch > 0
                  ? `正在翻译这一页 · 第 ${task.batch}/${task.batches} 批`
                  : `${PAGE_STEP_TEXT[task.step] ?? '正在翻译这一页'}…`)
                : (paused !== '' ? paused : notice)}
          </span>
          {/* 秒数每秒变一次，对读屏是噪音（会被逐秒播报）。 */}
          {running && <WaitingSeconds startedAt={task.startedAt} />}
          {/*
            ★ 暂停与关闭（0.78.0）：一页翻译慢起来要两三分钟，用户必须能在
              中途脱身。「暂停」真的掐断请求（见 `cancelPageTranslation`），
              不是把界面关掉、后台继续跑满 3 分钟。「关闭」只是收起这条提示 ——
              翻译已经开始的话它同时暂停，因为「看不见还在花钱」是最坏的状态。
            ★ 按钮在 `pointer-events: none` 的胶囊里，靠 `.npr-book-translation-acts`
              把 pointer-events 打开（CSS 里写了），否则整条点不动。
          */}
          <span className="npr-book-translation-acts">
            {running && (
              <button type="button" className="npr-book-translation-op"
                title="掐断这一页的翻译请求；已翻好的部分留在屏幕上，但不会存到本机"
                onClick={() => { cancelPageTranslation(key); }}>暂停</button>
            )}
            {!running && (paused !== '' || error !== '') && (
              <button type="button" className="npr-book-translation-op"
                onClick={() => { setPaused(''); setError(''); setNotice(''); setRetry(value => value + 1); }}>
                重试
              </button>
            )}
            <button type="button" className="npr-book-translation-x" aria-label="关闭提示" title="关闭"
              onClick={() => {
                // 还在跑就先掐断：关掉提示却让请求继续跑，等于「看不见还在花钱」。
                if (running) cancelPageTranslation(key);
                setClosed(true);
              }}><Icon name="x" size={12} /></button>
          </span>
        </span>
        {running && <span className="npr-book-translation-track" aria-hidden="true"><i /></span>}
      </div>
    )
    : null;
  return (
    <div className="npr-book-translation">
      {placed.map((block) => (
        <div key={block.id}
          className="npr-book-translation-block"
          style={{
            left: block.box.left, top: block.box.top,
            width: block.box.width, height: block.box.height,
          }}>
          {/* 逐字绝对定位：坐标由 motif 的排版给出（行宽、行距、首行缩进、禁则都已算过），
              这里只按它的结论摆字。字宽用同一套 canvas 度量，所以字距是准的。 */}
          {block.units.map((unit, index) => (
            <span key={index}
              style={{
                left: unit.left, top: unit.top,
                fontSize: unit.fontSize, fontFamily,
                fontWeight: unit.bold ? 700 : 400,
                fontStyle: unit.italic ? 'italic' : 'normal',
              }}>{unit.text}</span>
          ))}
        </div>
      ))}
      {/* 译文块仍留在书页坐标里（它们要跟原文逐段对齐），只有状态胶囊被送出去。 */}
      {capsule !== null && (pinHost === null ? capsule : createPortal(capsule, pinHost))}
    </div>
  );
}

/**
 * 整本翻译的进度条（0.71.0 → 0.78.0 加真实进度与「收起」）。
 *
 * ★ 故意是**独立的小组件**：逐页进度每翻一页就变一次，订阅放在这里，重渲染的
 *   就只有这一条胶囊；挂在 `BookReader` 上会让那 2900 行的阅读器跟着跑几十次。
 * ★ 只在「在跑 / 正在停 / 停了 / 失败」时出现，译完就收掉 —— 读第二遍时
 *   常驻的「已完成」只是噪音。
 * ★ 用户 2026-11-13：失败之后这条胶囊既没有按钮、也不会自己消失，一句红色
 *   报错就永久贴在书页上。现在 `stopped` / `failed` 给「收起」，点了收干净
 *   （`dismissWholeBookJob` 不删任何译文，下次再点「翻译全本」只补没译的页）。
 * ★ 进度条是**真实百分比**（done / total）：整本的每一页都是一个明确的里程碑，
 *   这里没有「编一个数字」的问题 —— 与单页那条不确定动画不是一回事。
 */
export function PaperWholeBookJobBar({ bookId }) {
  const job = useWholeBookJob(bookId);
  if (!['running', 'stopping', 'stopped', 'failed'].includes(job.state)) return null;
  const percent = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const running = job.state === 'running' || job.state === 'stopping';
  /** 剩余时间只用**实测**速率：没跑够两页时 `msPerPage` 是 0，宁可不显示。 */
  const remaining = job.state === 'running' && job.msPerPage > 0 && job.total > job.done
    ? ` · 还剩${formatDuration(job.msPerPage * (job.total - job.done))}`
    : '';
  return (
    <div className={`npr-book-whole-job is-${job.state}`} role="status" aria-live="polite">
      <span className="npr-book-whole-job-text">
        {job.state === 'stopping'
          ? '正在停止…'
          : job.state === 'stopped'
            ? `已停止 · ${job.done}/${job.total} 页 · 已译的页留在本机`
            : job.state === 'failed'
              ? `停在第 ${job.done} 页${job.failed > 0 ? ` · ${job.failed} 页没译出来` : ''}`
              : (job.capped
                // 被上限截断时不能写「整本」：这本书还有 800 页没动，界面上得说清楚。
                ? `前 ${job.done}/${job.total} 页 · 全书 ${job.pages} 页`
                : `整本 ${job.done}/${job.total} 页`)
                + (job.skipped > 0 ? ` · 读缓存 ${job.skipped} 页` : '')
                + (job.failed > 0 ? ` · 失败 ${job.failed} 页` : '')
                + remaining}
        {job.error !== '' ? ` · ${job.error}` : ''}
      </span>
      {/* 进度条：`stopping` 时已经不动了，但保留在 100% 以前的真实位置 ——
          换成空条会让人以为「刚才跑的都不算」。 */}
      <span className="npr-book-whole-job-track" aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </span>
      {/* 「清除译文」只在顶部那颗翻译菜单里有一个入口：两处各写一遍，二段确认的
          措辞迟早会不一样。这里只留进度、停止与收起。 */}
      {running ? (
        <button type="button" disabled={job.state === 'stopping'}
          onClick={() => stopWholeBookTranslation(bookId)}>停止</button>
      ) : (
        <button type="button" onClick={() => dismissWholeBookJob(bookId)}>收起</button>
      )}
    </div>
  );
}
