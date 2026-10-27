/**
 * 阅读时的灵感速记浮层（快捷键 `L`）。
 *
 * ★ 用户的原话是「读 RSS 或电子书时，随时按 L 启动灵感速记输入框，是浮层输入，
 *   不影响阅读」—— 所以这里**只有一个输入框**：没有类型选择、没有来源框、
 *   没有情绪、没有私密开关。任何一项加进来，它就不再是「速记」而是第二张日记表单。
 *   要选类型/情绪/私密，去日记页对应的模块里写。
 *
 * ★ 「灵感流转」（0.31.0）：在书里按 `L` 时，正在读的**书 / 页 / 章**会被自动写进
 *   `meta`（`book` / `page` / `chapter`），标题写进 `source`。这是**唯一**既满足
 *   「一键」又不往浮层里加控件的位置 —— 但关联必须**看得见**，所以多一行纯文本
 *   「会记到 《书名》· 第 N 章」。那行不是控件，浮层里仍然只有一个输入框。
 *
 * ★ 为什么浮层由 `ReaderPage` 挂载、而不是日记页：`ReaderPage` 是订阅页与书架页的
 *   共同父级，浮层挂在那里，两种阅读场景下都只有**一份**状态。挂在各页里会出现
 *   「书里按 L 记了一条，切回文章按 L 还看得见上一条草稿」。
 *
 * ★ 存到哪：今天（本地日期）、公开、类型「灵感」。浮层里不给选日期 —— 它服务的
 *   是「此刻」，带日期选择器的浮层就不叫速记了。
 *
 * ★ 这个浮层**不是**拖动区：它盖住了顶栏，语义是模态（Esc 关闭）。给它
 *   `data-window-drag` 会让「按住输入框边缘拖一下」变成把整个浮层拖走。
 */
import { useEffect, useRef, useState } from 'react';
import { dateKey } from '../diary-format.js';
import { appendDiaryEntry } from './diary-api.js';
import { Icon } from './icons.jsx';

export function QuickCapture({ open, onClose, notify, context }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const inputRef = useRef(null);

  /**
   * 「灵感流转」：在书里按 `L` 时，**自动**带上正在读的那本书 / 第几页 / 第几章；
   * 在读 RSS 时，带上那一篇文章的标题。
   *
   * ★ 为什么不给一个「关联到哪儿」的选择器：用户对浮层的要求是「不包含其它项」。
   *   自动带上是唯一既满足「一键」又不加控件的位置 —— 阅读上下文本来就摆在那儿，
   *   让用户再选一次是白问。
   * ★ 但**不能悄悄带**：上面那行 `npr-quick-link` 是纯文本（没有按钮、没有输入框），
   *   它只说「会记到哪儿」。看不见的关联比没有关联更糟 —— 事后在日记里看到一条
   *   挂在别的书上的灵感，谁也说不清它是怎么来的。
   * ★ 目录还没抽出来时 `chapter` 是 `null`：那就只记 `book` / `page`，**不猜章节**。
   * ★ 文章为什么也算「挂在某处」（0.38）：用户 2026-10-27 问「在阅读 RSS 时创建的
   *   灵感怎么办？挂在书上的意义？」—— 意义是**回到现场**，不是「它是一本书」。
   *   所以两种上下文走同一个字段 `source`，只是文章名不套书名号（套了就是在说
   *   它是一本书）。日记侧按 `source` 分组，书和文章各自成块，见 `linkedSources`。
   */
  const linked = context && (context.bookId || context.articleKey) ? context : null;
  const chapterLabel = linked?.chapter
    ? (linked.chapter.title || `第 ${linked.chapter.n} 章`)
    : '';
  const bookTitle = linked?.bookTitle || linked?.bookId || '';
  const articleTitle = linked?.articleTitle || '';
  /** 存进 `source` 的那串（书带书名号，文章就是标题本身）。 */
  const source = bookTitle !== ''
    ? `《${bookTitle}》${chapterLabel ? ` · ${chapterLabel}` : ''}`
    : articleTitle;
  /** 给人看的那串：文章名套「」—— 便于在一行里认出「这一整句是一个标题」。 */
  const where = bookTitle !== '' ? source : (articleTitle === '' ? '' : `「${articleTitle}」`);

  // 打开就聚焦（「打开即写」），关掉就清空草稿 —— 留着草稿会让下一次按 L 变成
  // 「咦，怎么有上次没写完的半句」。
  useEffect(() => {
    if (!open) { setDraft(''); setError(''); setSaving(false); return; }
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  async function save() {
    if (savingRef.current) return;
    if (!draft.trim()) { inputRef.current?.focus(); return; }
    savingRef.current = true;
    setSaving(true);
    setError('');
    const meta = {};
    if (linked) {
      // 书与文章各记各的：`book` 是书架内部 id（用于按书反查页码），
      // 文章只有 `key`（订阅源里的那一篇）。两个都不写进 `source` —— 那是给人看的。
      if (linked.bookId) {
        meta.book = linked.bookId;
        if (Number.isInteger(linked.chapter?.n) && linked.chapter.n >= 0) meta.chapter = linked.chapter.n;
        if (Number.isInteger(linked.page) && linked.page >= 0) meta.page = linked.page;
      }
      if (linked.articleKey) meta.article = linked.articleKey;
    }
    try {
      await appendDiaryEntry({ date: dateKey(), kind: '灵感', body: draft, source, meta });
      notify?.(linked ? `已记下，挂在${where}上` : '已记下，去日记里能看到');
      onClose?.();
    } catch (cause) {
      setError(cause.message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="npr-quick-backdrop" role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="npr-quick" role="dialog" aria-modal="true" aria-label="灵感速记">
        <div className="npr-quick-head">
          <strong>记一条</strong>
          <span className="npr-quick-hint">⌘/Ctrl + Enter 保存 · Esc 关闭</span>
          <button type="button" className="npr-icon" title="关闭（Esc）" aria-label="关闭" onClick={() => onClose?.()}><Icon name="x" /></button>
        </div>
        {/* 「会记到哪儿」是**一行纯文本**，不是控件：没有按钮、没有选择器、没有输入框。
            它存在的唯一理由是「关联不能悄悄发生」（见上面 `linked` 的注释）。 */}
        {linked && <p className="npr-quick-link">会记到 {where}</p>}
        <textarea ref={inputRef} className="npr-quick-input" value={draft} aria-label="灵感正文"
          placeholder="这一刻想到什么？写 #标签 可以自动归类。"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); return; }
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void save(); }
          }} />
        <div className="npr-quick-foot">
          <span className="npr-quick-hint">{draft.replace(/\s/g, '').length} 字</span>
          <button type="button" className="npr-diary-save" onClick={() => void save()} disabled={saving || draft.trim() === ''}>
            {saving ? '正在保存…' : '记下来'}
          </button>
        </div>
        {error && <p className="npr-quick-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
