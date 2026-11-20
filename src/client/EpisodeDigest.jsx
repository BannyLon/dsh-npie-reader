import { Icon } from './icons.jsx';
import { formatClock } from '../transcript.js';

/**
 * 从宿主文案里读出失败码。Remote 边界只传 message，前端拿不到 Error 对象上的
 * `aiFailureCode`；宿主把码写在固定的 `（CODE）` 位置（见 ai.js 的 describeFailure），
 * 从那里读比在两端各维护一份错误码映射少一处漂移。
 *
 * 认不出就返回空串 —— 落回通用「再试一次」，不猜。
 */
export function digestFailureCode(message) {
  const match = /^dsh-npie-reader:[^\n]*?（([A-Z][A-Z_]*)）/.exec(String(message ?? ''));
  return match ? match[1] : '';
}

/**
 * 「AI 导读」（0.84.0）：这一期讲了什么 + 每段的**可点时间戳**。
 *
 * ── 为什么不是又一块摘要文字 ──────────────────────────────────────────
 *
 * 播客没有可扫描的目录。用户想知道「这 80 分钟值不值得听」，需要的是
 * 「哪几段在聊什么」，而不是一段 300 字的概述 —— 后者读完仍然不知道从哪开始听。
 * 所以这里的每一段都挂一个时间戳按钮，点一下：音频跳到那里，字幕列表滚到那一段
 * 并高亮（两者由 `onJump` 一条链路驱动，见 `ReaderPage` 的 `jumpToTime`）。
 *
 * ── 三个状态，各自说不同的话 ─────────────────────────────────────────
 *
 *   `idle`           还没生成 → 给一个按钮，并说清「会调用一次模型」
 *   `loading`        正在读 → 一行确定的文案（30–60 秒），不画虚假进度
 *   `ready`          有内容 → 摘要 + 分段 + 原话
 *   `no-transcript`  没字幕 → 说清「要先有字幕」，**不给**按钮（点了必然失败）
 *   `too-short`      字幕太短 → 说清「太短了，不值得生成」
 *
 * ★ 不画进度条：生成只有一次模型调用，进度条只会是假的。文案里写「30–60 秒」，
 *   比一个永远停在 40% 的条诚实。
 * ★ 时间戳按钮的文案用 `formatClock`（与字幕面板同一份实现）：两处各写一份，
 *   迟早出现「导读写 1:02:03、字幕写 62:03」这种对不上的情况。
 */
export function EpisodeDigest({
  state = { status: 'idle' },
  onGenerate,
  onJump,
  /** 没有字幕时把它藏起来会更安静，但用户会以为「这功能不存在」——所以仍然显示，只是不给按钮。 */
  compact = false,
}) {
  const status = state?.status ?? 'idle';
  const digest = state?.data ?? null;
  const chapters = Array.isArray(digest?.chapters) ? digest.chapters : [];
  const quotes = Array.isArray(digest?.quotes) ? digest.quotes : [];
  const people = Array.isArray(digest?.people) ? digest.people : [];

  const jump = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    onJump?.(seconds);
  };

  return (
    <section className={`npr-dig${compact ? ' is-compact' : ''}`} aria-label="AI 导读">
      <div className="npr-dig-head">
        <span className="npr-dig-title">
          <Icon name="sparkles" size={15} strokeWidth={1.7} />
          AI 导读
        </span>
        {status === 'ready' && (
          <span className="npr-dig-meta">
            {chapters.length} 段{digest?.sampled ? ' · 长片抽样' : ''}
            {state.cached ? ' · 已缓存' : ''}
          </span>
        )}
        {status === 'ready' && (
          <button type="button" className="npr-dig-again" title="重新读一遍这一集（会再调用一次模型）" onClick={onGenerate}>
            重新生成
          </button>
        )}
      </div>

      {status === 'idle' && (
        <div className="npr-dig-body">
          <p className="npr-dig-lead">先看一遍这一集讲了什么，再决定从哪听起。生成时会调用一次模型。</p>
          <button type="button" className="npr-btn npr-btn-primary" onClick={onGenerate}>生成导读</button>
        </div>
      )}

      {status === 'loading' && (
        <div className="npr-dig-body">
          <p className="npr-dig-lead" role="status">正在读这一集的字幕（30–60 秒）…</p>
          {/* 一条来回走的细线，而不是百分比：这次调用没有可观测的进度。 */}
          <div className="npr-dig-busy" aria-hidden="true"><span /></div>
        </div>
      )}

      {status === 'no-transcript' && (
        <div className="npr-dig-body">
          <p className="npr-dig-lead">这一集还没有字幕。先在上面拿到字幕（订阅源自带，或用本机识别），再来读导读。</p>
        </div>
      )}

      {status === 'too-short' && (
        <div className="npr-dig-body">
          <p className="npr-dig-lead">这一集的字幕太短，不值得单独做导读 —— 直接听或者读字幕更快。</p>
        </div>
      )}

      {status === 'error' && (() => {
        // 额度耗尽 / 输出上限都不是「多点几次就会好」。按钮文案要说清下一步做什么，
        // 否则用户只会反复点同一个按钮、反复看到同一段英文（截图里已经发生过）。
        const code = digestFailureCode(state.error);
        const retryLabel = code === 'FREE_QUOTA' ? '换好通道后再试'
          : code === 'OUTPUT_LIMIT' ? '换模型后再试'
            : '再试一次';
        const hint = code === 'FREE_QUOTA'
          ? '这是通道的免费额度问题，换模型躲不开 —— 换通道或填自己的 API Key。'
          : code === 'OUTPUT_LIMIT'
            ? '这是输出长度上限，不是文章太长 —— 换一个允许更长输出的模型。'
            : '';
        return (
          <div className="npr-dig-body">
            <p className="npr-dig-lead" role="alert">导读没生成出来：{state.error || '未知原因'}</p>
            {hint ? <p className="npr-dig-hint">{hint}</p> : null}
            <button type="button" className="npr-btn npr-btn-primary" onClick={onGenerate}>{retryLabel}</button>
          </div>
        );
      })()}

      {status === 'ready' && digest && (
        <div className="npr-dig-body">
          {digest.title ? <h3 className="npr-dig-name">{digest.title}</h3> : null}
          {digest.summary ? <p className="npr-dig-summary">{digest.summary}</p> : null}

          {chapters.length > 0 && (
            <ol className="npr-dig-chapters">
              {chapters.map((chapter, index) => (
                <li key={`${chapter.at}-${index}`} className="npr-dig-chapter">
                  {chapter.at > 0 ? (
                    <button type="button" className="npr-dig-at" data-at={chapter.at}
                      title={`跳到 ${formatClock(chapter.at)}`} onClick={() => jump(chapter.at)}>
                      {formatClock(chapter.at)}
                    </button>
                  ) : <span className="npr-dig-at is-flat" aria-hidden="true">·</span>}
                  <div className="npr-dig-text">
                    {chapter.title ? <h4>{chapter.title}</h4> : null}
                    {Array.isArray(chapter.points) && chapter.points.length > 0 && (
                      <ul>
                        {chapter.points.map((point, at) => <li key={at}>{point}</li>)}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {quotes.length > 0 && (
            <div className="npr-dig-quotes">
              <span className="npr-dig-label">原话</span>
              {quotes.map((quote, index) => (
                <p key={index} className="npr-dig-quote">
                  {quote.at > 0 ? (
                    <button type="button" className="npr-dig-at is-quote" title={`跳到 ${formatClock(quote.at)}`}
                      onClick={() => jump(quote.at)}>{formatClock(quote.at)}</button>
                  ) : null}
                  <span>{quote.text}</span>
                </p>
              ))}
            </div>
          )}

          {people.length > 0 && (
            <p className="npr-dig-people"><span className="npr-dig-label">提到</span>{people.join(' · ')}</p>
          )}
        </div>
      )}
    </section>
  );
}
