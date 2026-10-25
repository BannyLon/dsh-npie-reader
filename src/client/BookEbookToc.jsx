/**
 * 重排电子书的**目录**面板（挂在正文左边，与解读面板、伴读互斥占同一格）。
 *
 * ★ 与 `BookDigestPanel` 的分工：
 *   · 这里只做**导航** —— 点一行跳到那一节。目录是书自带的，打开即用，不花钱、
 *     不需要「抽取」。
 *   · 解读（要点 / 生成 / 技能包）在 `BookDigestPanel`，两者用胶囊上不同的两个按钮进。
 *   合并成一个面板的后果是：想跳一章得先经过一排「生成解读」的按钮，而那是要花钱的
 *   动作，摆在导航路径上会让人不敢点。
 *
 * ★ 没有自带目录的书（TXT、或者 EPUB 的 nav/ncx 都缺）**不显示空面板**，
 *   改成「按节列出」（节名来自这一节的首个标题或「第 N 节」）—— 否则用户会以为
 *   「这本书没有目录」，而实际上它只是没有*分层*的目录。
 */
import { useEffect, useRef } from 'react';
import { activeEntryIndex, outlineEntries } from './ebook-outline.js';
import { Icon } from './icons.jsx';

export function BookEbookToc({
  index, page, total, digestCount = 0, digestRunning = false, onJump, onClose, onOpenDigest,
}) {
  const listRef = useRef(null);
  const activeRef = useRef(null);

  const toc = Array.isArray(index?.toc) ? index.toc : [];
  /**
   * 展示用的条目。`depth` 决定缩进：0 = 部 / 卷（章级），1 = 「一、二、三」这类小节。
   * ★ 条目怎么来、层级怎么算，全在 `./ebook-outline.js` —— 页眉的「上级章节」用的是
   *   同一份判据，两处各算一遍迟早会漂成两套答案。
   */
  const entries = outlineEntries(index);

  /**
   * 当前这一页落在目录的哪一条上。判据同样是共用的（见 `activeEntryIndex`）：
   * 取「起始节 ≤ 当前页」里最靠后的那一条 —— 精确匹配会让高亮在绝大多数页上消失。
   */
  const activeIndex = activeEntryIndex(entries, page);

  /**
   * 打开 / 翻到别的节时把当前条滚进视野。
   * ★ 只改列表容器的 `scrollTop`，不用 `scrollIntoView` —— 后者会把**整个页面**
   *   一起滚（阅读区跟着跳一下），而目录与正文是两栏。
   */
  useEffect(() => {
    const list = listRef.current;
    const active = activeRef.current;
    if (!list || !active) return;
    list.scrollTop = Math.max(0, active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2);
  }, [page, entries.length]);

  const warnings = Array.isArray(index?.warnings) ? index.warnings : [];

  return (
    <aside className="npr-book-digest npr-ebook-toc" aria-label="目录">
      <div className="npr-ebook-toc-head">
        <span className="npr-ebook-toc-title">目录</span>
        <span className="npr-ebook-toc-count">
          {toc.length > 0 ? `${entries.length} 条` : `${total} 页`}
        </span>
        <button type="button" className="npr-ebook-toc-close" title="收起目录" aria-label="收起目录" onClick={onClose}>
          <Icon name="panel-left-close" size={14} />
        </button>
      </div>

      {/* 这本文件本身有毛病时如实说（缺章节、解不开的片段…）。不当错误报：
          书还是能读的，只是某几处不完整。 */}
      {warnings.length > 0 && (
        <p className="npr-ebook-toc-warn" role="status">
          <Icon name="info" size={12} />
          <span>{warnings[0]}</span>
        </p>
      )}

      <ul className="npr-digest-list" ref={listRef}>
        {entries.map((entry, i) => (
          <li key={entry.key} className={`npr-digest-item is-depth-${Math.min(entry.depth, 2)}`}>
            <button type="button"
              ref={entry.section === page ? activeRef : null}
              className={`npr-digest-row${entry.section === page ? ' is-active' : ''}${i === activeIndex && entry.section !== page ? ' is-read' : ''}`}
              data-depth={Math.min(entry.depth, 2)}
              title={entry.title}
              onClick={() => onJump(entry.section)}>
              <span className="npr-digest-title">{entry.title}</span>
              {/* 右侧是页码 —— 纸质书目录的样子：标题在左、页码顶右。 */}
              <span className="npr-digest-n">{entry.section}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="npr-ebook-toc-foot">
        {/*
          ★ 这里是**解读的唯一入口**（0.25.1）。顶部胶囊上那个「解读」按钮删掉了：
            它打开的是一张章节列表，与目录几乎是同一屏 —— 用户原话「打开又和目录
            差不多，建议去掉，解读还走目录」。现在路径是「先看目录（免费、书自带），
            想花钱要解读时再往下走一步」，按钮上的字也如实反映当前状态。
        */}
        <button type="button" className="npr-digest-start" onClick={onOpenDigest}
          title="抽出章节并逐章生成解读（生成这一步会调用模型）">
          <Icon name="wand-sparkles" size={13} />
          <span>
            {digestRunning ? '正在解读…' : digestCount > 0 ? `解读 ${digestCount} 章` : '逐章解读'}
          </span>
        </button>
        <small>第 {page} / {total} 页</small>
      </div>
    </aside>
  );
}
