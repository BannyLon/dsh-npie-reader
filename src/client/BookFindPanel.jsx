/**
 * 书内搜索面板（PDF 与重排电子书**共用同一个**）。
 *
 * 三件事刻意如此：
 *
 * 1. **只有一个输入框，输入即搜**。不设「搜索」按钮 —— 书内搜索的重复率极高
 *    （改一个字再搜一次），多一次点击就多一次「我是不是没点」的疑惑。回车 / ↓
 *    是「下一处」，⇧回车 / ↑ 是「上一处」，Esc 收起。
 * 2. **不自己判断「有没有命中」**。命中由 `src/book-find.js` 那套判据算出来
 *    （与 `book_search` 工具同一套：trim + 小写 + 子串，不分词），这里只画。
 *    两处各写一套判据的后果是「AI 说第 7 章有，你自己搜不到」。
 * 3. **把「没搜的部分」写在结果旁边**。扫描页没有文字层、命中到上限被截断 ——
 *    这两件事都让「共 N 处」变成一个不完整的数字。不说出来，用户会把它读成
 *    「全书只有 N 处」，那是一个确定的假话。
 *
 * ★ Esc 必须在这里自己处理：宿主阅读器的 keydown 监听在焦点落进输入框时会**让路**
 *   （否则在页码框里按方向键就翻页了），所以面板里的 Esc 收不到外层那一层。
 * ★ 一个 `tabIndex` 都不许加（文件头同 `BookReader`）：`.npr-book-toolbar` 是宿主
 *   的窗口拖动行，任何祖先带 `tabindex` 都会把整块拖动区减掉。
 */
import { useEffect, useMemo, useRef } from 'react';
import { FIND_QUERY_MAX, findOccurrences } from '../book-find.js';
import { Icon } from './icons.jsx';

/**
 * 片段 → 带高亮的碎片。
 *
 * ★ 重新在片段里找一遍，而不是让调用方把「命中在哪」也算好传进来：片段是**被截断
 *   又压过空白**的，原偏移在片段里已经对不上了。用同一套判据再找一次，短片段的
 *   成本可以忽略，而高亮会自然落在「用户搜的那几个字」上。
 * ★ 片段里找不到（例如命中跨越了被压掉的换行）时**原样显示**，不做降级猜测。
 */
function snippetParts(snippet, needle) {
  const text = String(snippet ?? '');
  const ranges = findOccurrences(text, needle, { limit: 8 });
  if (ranges.length === 0) return [{ text, hit: false }];
  const parts = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) parts.push({ text: text.slice(at, range.start), hit: false });
    parts.push({ text: text.slice(range.start, range.end), hit: true });
    at = range.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * 「识别这 N 页」要多久。**按本机实测 0.8 秒/页**（Vision，冷启动另算）。
 *
 * ★ 必须给这个数字：几百页的批量是分钟级动作，只写「可能要一会儿」等于让用户
 *   闭眼等。反过来，给一个精确到秒的假数字更糟 —— 所以按 0.8 秒估、只取整。
 */
function ocrEstimate(pages) {
  const seconds = Math.max(1, Math.round(pages * 0.8));
  if (seconds < 90) return `约 ${seconds} 秒`;
  return `约 ${Math.round(seconds / 60)} 分钟`;
}

export function BookFindPanel({
  query, onQuery, status, error = '', hits = [], activeIndex = -1,
  progress = null, notes = [], unit = 'page', onPick, onStep, onClose,
  /** 扫描页的补救（只有 PDF 有）：`{ running, done, total, note }`；`null` = 没有这个出口。 */
  ocr = null, onOcr = null, onOcrStop = null,
}) {
  const inputRef = useRef(null);
  /**
   * 打开面板就把焦点放进输入框：用户点「搜索」之后下一步一定是打字。
   * ★ 只在挂载时做一次（`[]`）：每次输入都 focus 会在 IME 组字时把光标拽回来。
   */
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const needle = useMemo(() => String(query ?? '').trim(), [query]);
  const total = hits.length;
  const current = activeIndex >= 0 && activeIndex < total ? activeIndex : -1;
  const done = status === 'done';

  const step = (delta) => {
    if (total === 0) return;
    onStep?.(delta);
  };

  return (
    <aside className="npr-find" aria-label="书内搜索">
      <header className="npr-find-head">
        <div>
          <h2>书内搜索</h2>
          <p>
            {done
              ? (total === 0 ? '没有命中' : `共 ${total} 处${current >= 0 ? ` · 第 ${current + 1} 处` : ''}`)
              : status === 'searching' ? '正在检索…' : '在这个搜索框里输入，整本正文一起找'}
          </p>
        </div>
        <button type="button" className="npr-icon" title="收起搜索面板（Esc）" aria-label="收起搜索面板" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="npr-find-inputrow">
        <Icon name="search" size={14} />
        <input ref={inputRef} className="npr-find-input" type="text" value={query}
          maxLength={FIND_QUERY_MAX} placeholder="在全书正文里找…"
          aria-label="搜索词" autoComplete="off" spellCheck={false}
          onChange={(event) => onQuery?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); return; }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose?.(); return; }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              // ★ 方向键在输入框里只有一个合理用途：翻命中。把光标移来移去对
              //   单行短词没有意义，而「按 ↓ 找下一处」是搜索框的通行手感。
              event.preventDefault();
              step(event.key === 'ArrowDown' ? 1 : -1);
            }
          }} />
        <div className="npr-find-steps" role="group" aria-label="上一处 / 下一处">
          <button type="button" className="npr-find-step" title="上一处（⇧回车）"
            aria-label="上一处" disabled={total === 0} onClick={() => step(-1)}>
            <Icon name="chevron-up" size={13} />
          </button>
          <button type="button" className="npr-find-step" title="下一处（回车）"
            aria-label="下一处" disabled={total === 0} onClick={() => step(1)}>
            <Icon name="chevron-down" size={13} />
          </button>
        </div>
      </div>

      {status === 'searching' && progress !== null && (
        <p className="npr-find-progress" role="status">
          {`已扫 ${progress.done} / ${progress.total} ${unit === 'page' ? '页' : '节'}${total > 0 ? ` · 已找到 ${total} 处` : ''}`}
        </p>
      )}
      {status === 'error' && <p className="npr-find-error" role="alert">{error === '' ? '检索失败' : error}</p>}

      <div className="npr-find-list">
        {status !== 'error' && needle === '' && (
          <p className="npr-find-empty">
            输入一个词就会在整本正文里找，命中的每一处都能跳过去。
            <br />
            {/* ★ 界面上不写反引号：那是 Markdown 的语法，渲染成 HTML 之后就是
                一对可见的反引号，看着像没排版。工具名用「」括起来。 */}
            判据与 AI 用的「book_search」是同一套：不区分大小写、按子串匹配、不分词。
          </p>
        )}
        {status !== 'error' && needle !== '' && done && total === 0 && (
          <p className="npr-find-empty">没有找到「{needle}」。换一个更短或更常见的词再试。</p>
        )}
        {hits.map((hit, index) => (
          <button key={hit.key ?? `${hit.where}-${index}`} type="button"
            className={`npr-find-item${index === current ? ' is-current' : ''}`}
            title="跳到这一处" onClick={() => onPick?.(index)}>
            <span className="npr-find-where">{hit.where}</span>
            {hit.via === 'ocr' && (
              // ★ 这个标记不是装饰：摘录里那几个字**不是书上写的**，是识别出来的。
              //   不标的话用户会拿一句错字去核对原文，然后怀疑搜索坏了。
              <span className="npr-find-via" title="这一页没有文字层，摘录来自本机文字识别（可能有错字）">识别</span>
            )}
            {hit.sub !== undefined && hit.sub !== '' && <span className="npr-find-sub">{hit.sub}</span>}
            <span className="npr-find-snippet">
              {snippetParts(hit.snippet, needle).map((part, partIndex) => (
                part.hit
                  ? <mark key={partIndex} className="npr-find-hit">{part.text}</mark>
                  : <span key={partIndex}>{part.text}</span>
              ))}
            </span>
          </button>
        ))}
      </div>

      {/*
        扫描页的补救出口。
        ★ 位置在**命中列表之后、说明之前**：它是「这次没搜到可以再努力一把」的动作，
          必须紧挨着「另有 N 页没搜」那句，否则用户看到「共 3 处」就关面板走了。
        ★ 运行中只留「停止」，不留「再搜一次」：按钮同时存在时，用户在 5 分钟的
          进度条前最想点的是那个还能点的。
      */}
      {ocr !== null && (
        <div className="npr-find-ocr">
          {ocr.running ? (
            <>
              <p className="npr-find-progress" role="status">
                {`正在识别文字 ${ocr.done} / ${ocr.total} 页…`}
              </p>
              <button type="button" className="npr-find-ocr-btn" onClick={onOcrStop}>
                停止
              </button>
            </>
          ) : (
            <>
              <button type="button" className="npr-find-ocr-btn" onClick={onOcr}
                title="用 macOS 本机文字识别认出这些页，然后重新搜一遍（不联网、不花钱）">
                {`识别这 ${ocr.total} 页再搜一次`}
              </button>
              <p className="npr-find-ocr-hint">
                {`本机识别，不联网、不花钱，${ocrEstimate(ocr.total)}`}
              </p>
            </>
          )}
          {ocr.note !== undefined && ocr.note !== '' && (
            <p className="npr-find-ocr-note" role="status">{ocr.note}</p>
          )}
        </div>
      )}

      {notes.length > 0 && (
        <footer className="npr-find-notes">
          {notes.map(note => <p key={note} className="npr-find-note">{note}</p>)}
        </footer>
      )}
    </aside>
  );
}
