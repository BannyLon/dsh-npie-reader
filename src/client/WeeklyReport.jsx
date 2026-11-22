/**
 * 阅读周报（0.88.0）。
 *
 * 这一页回答一个问题：「我这一周到底读了什么、写了什么」。所以它不是一张统计
 * 仪表盘 —— 每张卡片都必须能落到**具体的名字**上（哪几篇、哪几本、哪几天），
 * 只有数字没有名字的话，用户看完还是不知道这一周去哪儿了。
 *
 * ★ 为什么是**整页**而不是日记页里的第四块：日记的三个模块是「写入形态」
 *   （极简 / 加密 / 结构化），而周报只读。把它塞进 `DIARY_MODULES` 会让那套
 *   `mod.kind` / `mod.vis` 的契约凭空多一个没有 kind 的成员，写入路径要处处判空。
 *   这里从日记页**整块换掉**工作区，带自己的返回按钮，与三块互不相干。
 *
 * ★ 数据一次要 8 周（`fetchWeekly`），不是只要当前这一周：左栏要列「最近几周 +
 *   一句话摘要」。分开请求的话，切一次视图就是 8 个 HTTP、每个都重新扫一遍
 *   同一批日记文件。宿主那边一次扫完，纯函数算 8 遍。
 *
 * ★ 切周**不清空旧数据**（见 `load()`）：清空会让整页闪一下白，然后卡片逐个
 *   出现 —— 那是「重新打开」的观感，而用户只是点了「上一周」。旧的先留着，
 *   摘要那一行降透明度表示正在换。
 *
 * ★ 私密日记**不进来**。页脚写明了这一条：周报是一张会被截图的东西，
 *   「你这周写了 5 天私密日记」本身就是信息。
 *
 * ★ **取数（`WeeklyReport`）与画（`WeeklyView`）分成两个组件**：`WeeklyView` 是
 *   纯展示，可以由 `renderToStaticMarkup` 直接渲染 —— 否则要测「文案与结构在不在」
 *   就得先把 `useEffect` + `fetch` 搬进测试环境，那种测试既慢又测不到重点。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWeekly } from './diary-api.js';
import { ViewSwitch } from './ViewSwitch.jsx';
import { Icon } from './icons.jsx';

/** 空列表的占位。不写「暂无数据」那种系统腔，写清「这一周没有」这件事。 */
function Empty({ children }) {
  return <p className="npr-weekly-empty">{children}</p>;
}

/** 一行「名字 · 补充」。`onClick` 有值时整行可点（带 hover 与键盘可达）。 */
function Row({ title, meta, onClick, mark }) {
  const content = (
    <>
      <span className="npr-weekly-row-title">{title}</span>
      {meta ? <span className="npr-weekly-row-meta">{meta}</span> : null}
    </>
  );
  if (typeof onClick !== 'function') {
    return <div className="npr-weekly-row" data-plain="1">{content}</div>;
  }
  return (
    <button type="button" className="npr-weekly-row" onClick={onClick} title={title}>
      {mark ? <Icon name={mark} size={13} /> : null}
      {content}
    </button>
  );
}

/** 一张卡片。标题 + 一个右上的补充数（「12 篇」），内容自己画。 */
function Card({ title, badge, children }) {
  return (
    <section className="npr-weekly-card">
      <header>
        <h3>{title}</h3>
        {badge ? <span className="npr-weekly-badge">{badge}</span> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * 周报的**画面**：左栏周列表 + 右栏卡片流。
 *
 * 所有数据与回调都从外面来 —— 这样它可以被静态渲染，也可以在 Storybook 之类的
 * 地方单独摆出来看。要加「AI 写一段本周回顾」也加在这里（它是展示），
 * 取数仍然留在 `WeeklyReport`。
 */
export function WeeklyView({
  data, error, loading, onRefresh, onPick, onExit, onExitTo, onOpenArticle, onOpenBook,
}) {
  const report = data?.report ?? null;
  const recent = Array.isArray(data?.recent) ? data.recent : [];
  /** 当前周在列表里的位置：0 是最新的，「上一周」= 往后一格。 */
  const index = useMemo(() => recent.findIndex((item) => item.key === report?.range?.key), [recent, report]);

  const goOlder = () => {
    const next = recent[index + 1];
    if (next) onPick?.(next.key);
  };
  const goNewer = () => {
    if (index <= 0) return;
    const next = recent[index - 1];
    if (next) onPick?.(next.key);
  };

  return (
    <div className="npr-workarea npr-weekly">
      <div className="npr-layout">
        <aside className="npr-sidebar">
          {/* ★ `data-window-drag` 是**布局必需**：少了它，在周报页按住空白处拖不动窗口。 */}
          <div className="npr-sidebar-toolbar" data-window-drag>
            <button type="button" className="npr-icon" title="回到日记" aria-label="回到日记"
              onClick={() => onExit?.()}><Icon name="chevron-left" /></button>
            <span className="npr-weekly-brand">阅读周报</span>
            <ViewSwitch mode="diary" onChange={(next) => { if (next !== 'diary') onExitTo?.(next); }} showLibrary />
          </div>

          <nav className="npr-weekly-list" aria-label="最近的周">
            {recent.length === 0 && !loading ? <Empty>还没有可回看的周</Empty> : null}
            {recent.map((item) => (
              <button key={item.key} type="button"
                className={`npr-weekly-item${item.key === report?.range?.key ? ' is-current' : ''}`}
                aria-current={item.key === report?.range?.key ? 'true' : undefined}
                onClick={() => onPick?.(item.key)}>
                <span className="npr-weekly-item-label">{item.label}</span>
                <span className="npr-weekly-item-head">{item.headline}</span>
              </button>
            ))}
          </nav>

          <div className="npr-weekly-foot">
            数据都在本机 · 不含私密日记
          </div>
        </aside>

        <section className="npr-reader npr-weekly-main">
          <header className="npr-weekly-head" data-window-drag>
            <div className="npr-weekly-head-title">
              <h2>{report?.range?.label ?? '本周'}</h2>
              <p>{greetingOf(report)}</p>
            </div>
            <div className="npr-weekly-nav">
              <button type="button" className="npr-icon" title="上一周" aria-label="上一周"
                disabled={index < 0 || index >= recent.length - 1} onClick={goOlder}><Icon name="chevron-left" /></button>
              <button type="button" className="npr-icon" title="下一周" aria-label="下一周"
                disabled={index <= 0} onClick={goNewer}><Icon name="chevron-right" /></button>
            </div>
          </header>

          <div className="npr-weekly-body">
            {error ? (
              <div className="npr-weekly-error" role="alert">
                <p>{error}</p>
                <button type="button" onClick={() => onRefresh?.()}>重新加载</button>
              </div>
            ) : null}

            {!report && loading ? <p className="npr-weekly-empty">正在汇总这一周…</p> : null}

            {report ? (
              <>
                <p className="npr-weekly-summary" data-loading={loading ? '1' : undefined}>{headlineOf(report)}</p>

                {/* 阅读 ------------------------------------------------------ */}
                <Card title="读" badge={report.reading.articles > 0 ? `${report.reading.articles} 篇` : ''}>
                  {report.reading.articles === 0 && report.reading.saved === 0 ? (
                    <Empty>这一周没有标记已读的文章</Empty>
                  ) : (
                    <>
                      {report.reading.topFeeds.length > 0 ? (
                        <div className="npr-weekly-chips">
                          {report.reading.topFeeds.map((feed) => (
                            <span key={feed.name} className="npr-weekly-chip">{feed.name}<b>{feed.count}</b></span>
                          ))}
                        </div>
                      ) : null}
                      {report.reading.titles.map((row) => (
                        <Row key={row.key} title={row.title || row.key} meta={row.feed}
                          onClick={typeof onOpenArticle === 'function' ? () => onOpenArticle(row.key) : undefined} />
                      ))}
                      {report.reading.saved > 0 ? (
                        <p className="npr-weekly-note">另有 {report.reading.saved} 篇加了收藏</p>
                      ) : null}
                    </>
                  )}
                </Card>

                {/* 书 -------------------------------------------------------- */}
                <Card title="书" badge={report.books.finished.length > 0 ? `读完 ${report.books.finished.length} 本` : ''}>
                  {report.books.finished.length === 0 && report.books.progressed.length === 0 ? (
                    <Empty>这一周没有翻书</Empty>
                  ) : (
                    <>
                      {report.books.finished.map((book) => (
                        <Row key={book.id} title={book.title || book.id} meta="读完" mark="circle-check"
                          onClick={typeof onOpenBook === 'function' ? () => onOpenBook({ bookId: book.id }) : undefined} />
                      ))}
                      {report.books.progressed.map((book) => (
                        <Row key={book.id} title={book.title || book.id}
                          meta={book.pages > 0 ? `读到 ${book.page}/${book.pages} 页` : '在读'}
                          onClick={typeof onOpenBook === 'function' ? () => onOpenBook({ bookId: book.id, page: book.page || null }) : undefined} />
                      ))}
                    </>
                  )}
                </Card>

                {/* 写 -------------------------------------------------------- */}
                <Card title="写" badge={report.writing.entries > 0 ? `${report.writing.entries} 条` : ''}>
                  {report.writing.entries === 0 ? (
                    <Empty>这一周没有写日记</Empty>
                  ) : (
                    <>
                      <div className="npr-weekly-stats">
                        <span><b>{report.writing.days}</b> 天</span>
                        <span><b>{report.writing.chars}</b> 字</span>
                        {report.writing.streak > 1 ? <span>连写 <b>{report.writing.streak}</b> 天</span> : null}
                      </div>
                      {Object.keys(report.writing.byKind).length > 0 ? (
                        <div className="npr-weekly-chips">
                          {Object.entries(report.writing.byKind).map(([kind, count]) => (
                            <span key={kind} className="npr-weekly-chip">{kind}<b>{count}</b></span>
                          ))}
                        </div>
                      ) : null}
                      {report.writing.moods.length > 0 ? (
                        <p className="npr-weekly-note">
                          心情最多的是「{report.writing.moods[0].label}」（{report.writing.moods[0].count} 条）
                        </p>
                      ) : null}
                      {report.writing.reflections.map((row, position) => (
                        <Row key={`${row.bookId}-${position}`} title={row.title || row.bookId}
                          meta={row.date.slice(5)} mark="pencil"
                          onClick={typeof onOpenBook === 'function' ? () => onOpenBook({ bookId: row.bookId }) : undefined} />
                      ))}
                    </>
                  )}
                </Card>

                {/* 划 -------------------------------------------------------- */}
                <Card title="划" badge={report.books.highlightCount > 0 ? `${report.books.highlightCount} 处` : ''}>
                  {report.books.highlightCount === 0 ? (
                    <Empty>
                      {report.scanned?.annotationsReadable === false
                        ? '划线目录这次没读到，数量未知'
                        : '这一周没有划线'}
                    </Empty>
                  ) : (
                    report.books.highlights.map((row) => (
                      <Row key={row.id} title={row.title || row.id} meta={`${row.count} 处`} mark="highlighter"
                        onClick={typeof onOpenBook === 'function' ? () => onOpenBook({ bookId: row.id }) : undefined} />
                    ))
                  )}
                </Card>

                {/* 论文 ------------------------------------------------------ */}
                {(report.papers.added.length > 0 || report.papers.finished.length > 0) ? (
                  <Card title="论文" badge={report.papers.finished.length > 0 ? `读完 ${report.papers.finished.length} 篇` : ''}>
                    {report.papers.finished.map((row) => (
                      <Row key={row.id} title={row.title || row.id} meta="读完" mark="file-check" />
                    ))}
                    {report.papers.added.map((row) => (
                      <Row key={row.id} title={row.title || row.id} meta="新加入" />
                    ))}
                  </Card>
                ) : null}

                {report.empty ? (
                  <p className="npr-weekly-hint">
                    这一周还没有记录。去读点什么，或者写下今天的一个想法 —— 下周这里就会有内容。
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

/** 取数 + 把状态交给 `WeeklyView`。 */
export function WeeklyReport({ onExit, onExitTo, notify, onOpenArticle, onOpenBook }) {
  /**
   * 当前看的周。`null` = 让宿主给「本机当前时间所在周」。
   * ★ 不用客户端 `new Date()` 拼周键：那一套 ISO 周换算（跨年、周一为始）已经在
   *   宿主 `weekly.js` 里验过 24 条，客户端再写一遍就会有两份可能漂开的实现 ——
   *   而漂开的症状是「点进来看到的是上一周」。
   */
  const [week, setWeek] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  /** 请求序号：连点「上一周」时，先发的慢响应不能覆盖后发的快响应。 */
  const ticket = useRef(0);

  const load = useCallback(async (target) => {
    const mine = ticket.current + 1;
    ticket.current = mine;
    setLoading(true);
    setError('');
    try {
      const result = await fetchWeekly(target ?? undefined, 8);
      if (ticket.current !== mine) return;
      setData(result);
      if (target == null) setWeek(result?.week ?? null);
    } catch (failure) {
      if (ticket.current !== mine) return;
      setError(failure?.message ?? String(failure));
      // 失败也要说一声：周报页没有「保存」这类动作，静默失败会让人以为「这一周真的没数据」。
      notify?.('周报没读出来', true);
    } finally {
      if (ticket.current === mine) setLoading(false);
    }
  }, [notify]);

  useEffect(() => { void load(week); }, [load, week]);

  return (
    <WeeklyView
      data={data}
      error={error}
      loading={loading}
      onRefresh={() => void load(week)}
      onPick={(key) => setWeek(key)}
      onExit={onExit}
      onExitTo={onExitTo}
      onOpenArticle={onOpenArticle}
      onOpenBook={onOpenBook}
    />
  );
}

/**
 * 顶部那句「这一周读了 12 篇 · 读完 2 本」。
 *
 * ★ 与宿主的 `weeklyHeadline()` **不是**同一句：那个给侧栏用（「读了 12 篇 ·
 *   写完 2 本 · 写了 5 条」），这里给正文用，措辞更贴「这一周」。两边都只取三项
 *   —— 一句塞五个数字等于没重点。
 */
function headlineOf(report) {
  const parts = [];
  if (report.reading.articles > 0) parts.push(`读了 ${report.reading.articles} 篇`);
  if (report.books.finished.length > 0) parts.push(`读完 ${report.books.finished.length} 本`);
  if (report.writing.entries > 0) parts.push(`写了 ${report.writing.entries} 条`);
  if (parts.length === 0 && report.books.progressed.length > 0) parts.push(`翻了 ${report.books.progressed.length} 本书`);
  if (parts.length === 0 && report.books.highlightCount > 0) parts.push(`划了 ${report.books.highlightCount} 处`);
  if (parts.length === 0) return '这一周很安静';
  return parts.slice(0, 3).join(' · ');
}

/** 副标题：给这一周一句「说人话」的话，不用形容词堆砌。 */
function greetingOf(report) {
  if (!report) return '';
  const { reading, books, writing } = report;
  const total = reading.articles + books.finished.length + writing.entries + books.highlightCount;
  if (total === 0) return '没有任何记录 —— 也许休息也是需要的。';
  if (writing.days >= 5) return '写了五天以上，这一周的想法留下来了。';
  if (books.finished.length > 0) return '有书读完了，值得写一份读后感。';
  if (reading.articles > 20) return '读得很多。挑一两篇值得回看的，比读完更重要。';
  if (books.highlightCount > 0) return '划了句子 —— 那些句子通常才是真正记住的部分。';
  return '按自己的节奏就好。';
}
