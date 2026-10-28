/**
 * 一张书封（真封面 / PDF 首页 / 生成式）。
 *
 * ★ 三种来源在 DOM 上是**一个** `.npr-diary-cover`，用 `data-kind` 区分：
 *   卡片的尺寸、圆角、阴影、悬停统一由这一层给，换来源不会让格子大小跳一下。
 *   （这也是不用「模板串拼类名」的原因：`check-classes` 看不见动态拼出来的类名，
 *   会把它报成「用到但未定义」—— 而它真正的风险是拼错时静默无样式。）
 * ★ PDF 封面**等这块进视口再渲染**：一份 PDF 要走「取首块 1 MiB → 解析交叉引用表 →
 *   渲染第 1 页」，几十本一起渲染会把主线程占满。IntersectionObserver 让它按需来。
 */
import { useEffect, useRef, useState } from 'react';
import { coverCaption, coverGlyph, coverHue, coverKind, epubCoverUrl, pdfCoverDataUrl } from './book-cover.js';

export function BookCover({ book }) {
  const kind = coverKind(book);
  const [src, setSrc] = useState(() => (kind === 'epub' ? epubCoverUrl(book.id) : ''));
  const [failed, setFailed] = useState(false);
  const holder = useRef(null);

  useEffect(() => {
    setFailed(false);
    setSrc(kind === 'epub' ? epubCoverUrl(book.id) : '');
    if (kind !== 'pdf') return undefined;

    let alive = true;
    const run = () => {
      pdfCoverDataUrl(book)
        .then((url) => { if (alive) setSrc(url); })
        .catch(() => { if (alive) setFailed(true); });
    };
    const node = holder.current;
    // 没有 IntersectionObserver（老宿主）就老老实实直接渲染 —— 慢一点，但看得见。
    if (node === null || typeof IntersectionObserver === 'undefined') {
      run();
      return () => { alive = false; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        run();
      }
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => { alive = false; observer.disconnect(); };
    // 只认这三个：书的标题变了封面就该重来，而 `book` 对象每次渲染都可能是新的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, book.id, book.size]);

  const showImage = !failed && src !== '';

  return (
    <span
      className="npr-diary-cover"
      ref={holder}
      data-kind={kind}
      data-image={showImage ? 'yes' : 'no'}
      style={{ '--npr-cover-h': String(coverHue(book.title)) }}>
      {showImage && (
        <img className="npr-diary-cover-img" src={src} alt="" draggable={false}
          onError={() => { setFailed(true); setSrc(''); }} />
      )}
      {!showImage && (
        <span className="npr-diary-cover-made" aria-hidden="true">
          <span className="npr-diary-cover-glyph">{coverGlyph(book.title)}</span>
          <span className="npr-diary-cover-caption">{coverCaption(book.title)}</span>
        </span>
      )}
    </span>
  );
}
