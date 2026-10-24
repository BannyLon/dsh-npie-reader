/**
 * 一章的解读正文 —— **浮动在阅读区上的一张卡**，不再塞进目录列表里。
 *
 * ★ 为什么不在列表里展开（0.18.x 的做法）：目录栏只有 306px 宽，而一段解读是
 *   「一段总述 + 3–6 条要点 + 几个术语」，在那个宽度里要占掉七八行。用户点开
 *   一章的要点，看到的是**目录被挤走大半**，而他本来是想「一边看目录、一边看这章
 *   讲什么」。窄栏里塞长文，两种用途互相破坏。
 *
 * ★ 为什么是**浮层**而不是第三列：阅读区的宽度是用户读正文用的（本项目已经因为
 *   「两列化之后每列变窄」踩过一次）。更要紧的是，第三列会改变 `.npr-book-stage`
 *   的宽度 ⇒ `ResizeObserver` 触发 ⇒ 整页重画一次位图。浮层不参与布局，翻页手感
 *   不受影响。
 *
 * ★ 只渲染「结构化字段」，不渲染 Markdown：客户端那个 Markdown 渲染器不支持表格、
 *   `<ol>` 会变成无序列表（见 README）。解读的产物本来就是 `{summary, points, terms}`，
 *   直接映射成 `<p>` / `<ul>` / `<dl>` 更准，也不用担心模型在 Markdown 里写出花来。
 */
import { Icon } from './icons.jsx';

/**
 * 一章的解读正文（纯内容，不含外框）。
 *
 * 导出它是因为「内容」与「外框」是两件事：外框（`DigestCard`）管位置与关闭，
 * 内容管三种状态（读不到 / 还没生成 / 有内容）。测试也按这条缝分开测。
 */
export function DigestBody({ entry }) {
  if (entry === undefined || entry === null) return null;
  if (entry.status === 'loading') {
    return (
      <div className="npr-digest-body" role="status">
        <small className="npr-digest-loading">正在读取这一章的解读…</small>
      </div>
    );
  }
  if (entry.status === 'error') {
    return (
      <div className="npr-digest-body" role="alert">
        <small className="npr-digest-body-error">{entry.error}</small>
      </div>
    );
  }

  const digest = entry.digest ?? {};
  const points = Array.isArray(digest.points) ? digest.points : [];
  const terms = Array.isArray(digest.terms) ? digest.terms : [];
  // `model` 是生成时记下来的取值（跟随默认时是 `'default'`）。
  // ★ 把模型名显示出来，是因为「我这一章到底是用哪个模型跑的」正是用户最想确认的
  //   那件事 —— 他就是为了不烧默认模型才去选免费模型的。`'default'` 不显示：
  //   它不是一个模型名，写出来只会让人以为有个叫 default 的模型。
  const model = typeof digest.model === 'string' && digest.model !== '' && digest.model !== 'default'
    ? digest.model
    : '';

  return (
    <div className="npr-digest-body">
      {digest.format === 'text' && (
        // 模型没按结构化格式返回时，产物里只有一段话。说出来，别让用户以为
        // 「这一章本来就没有要点」。
        <small className="npr-digest-format">模型没有按结构化格式返回，以下是一段整体说明。</small>
      )}
      {digest.summary !== '' && digest.summary !== undefined && <p className="npr-digest-summary">{digest.summary}</p>}
      {points.length > 0 && (
        <ul className="npr-digest-points">
          {points.map((point, index) => <li key={index}>{point}</li>)}
        </ul>
      )}
      {terms.length > 0 && (
        <dl className="npr-digest-terms">
          {terms.map((term, index) => (
            <div key={index}>
              <dt>{term.term}</dt>
              <dd>{term.note}</dd>
            </div>
          ))}
        </dl>
      )}
      {model !== '' && <small className="npr-digest-model-tag">模型 {model}</small>}
    </div>
  );
}

/**
 * 浮在阅读区右侧的解读卡。
 *
 * @param chapter - 目录里那一条（`{ n, title, startPage, endPage }`）
 * @param entry - `digestChapters[n]`（`{status:'loading'|'ready'|'error', digest?, error?}`）
 * @param onClose - 收起
 * @param onJump - 跳到 `chapter.startPage`
 */
export function DigestCard({ chapter, entry, onClose, onJump }) {
  if (chapter === undefined || chapter === null) return null;
  return (
    <aside className="npr-digest-card" aria-label={`第 ${chapter.n} 章的要点`}>
      <header className="npr-digest-card-head">
        <span className="npr-digest-n">{String(chapter.n).padStart(2, '0')}</span>
        <strong className="npr-digest-card-title" title={chapter.title}>{chapter.title}</strong>
        <span className="npr-digest-page">p.{chapter.startPage}–{chapter.endPage}</span>
        {/* 两个热区各做一件事：跳页 vs 收起。与目录里那条「行 = 跳页、箭头 = 看要点」
            是同一套分工，用户不用在两处学两种规则。 */}
        <button type="button" className="npr-icon" title={`跳到第 ${chapter.startPage} 页`}
          aria-label={`跳到第 ${chapter.startPage} 页`} onClick={() => onJump?.(chapter.startPage)}>
          <Icon name="book-open" size={14} />
        </button>
        <button type="button" className="npr-icon" title="收起要点" aria-label="收起要点" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="npr-digest-card-body">
        <DigestBody entry={entry} />
      </div>
    </aside>
  );
}
