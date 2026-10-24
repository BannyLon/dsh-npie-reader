/**
 * 划线 / 笔记面板（阅读器左侧那一栏）。
 *
 * 版式参照「一本书的笔记」这一类界面：顶部是**两个页签**（全部划线 / 有笔记），
 * 下面是一叠卡片；每张卡片是「摘录原文 + 页码 + 我这句下面写了什么」，
 * 点摘录跳到那一页。
 *
 * ★ 为什么标题写「全部」而不是「热门划线」：本插件是**单人本地**的，
 *   没有别人的划线可看。写「热门」等于承诺一个根本不存在的数据源 ——
 *   界面上最坏的谎话不是少一个功能，而是摆一个永远空的榜单。
 *
 * ★ 编辑（改颜色 / 写笔记 / 删除）**只在这个面板里做**，不在书页上做：
 *   书页上的高亮层必须 `pointer-events: none`，否则它会挡住拖选 ——
 *   而拖选恰恰是「划下一条」的入口。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ANNOTATION_TONES, NOTE_LIMIT, TONE_ORDER, summariseAnnotations } from './annotations.js';
import { Icon } from './icons.jsx';

const TABS = [
  { id: 'all', label: '全部划线' },
  { id: 'note', label: '笔记' },
];

export function AnnotationPanel({ items, focusId = '', onJump, onUpdate, onRemove, onClose }) {
  const [tab, setTab] = useState('all');
  /** 正在编辑的那一条（`''` = 没在编辑）。 */
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState('');
  /**
   * 正在等「再点一次」的那条划线（`''` = 没有）。
   *
   * ★ 删除是**不可逆**的：划线只存在本地 `data.json` 里，没有回收站、没有历史版本，
   *   误触一次就真的没了。所以必须有第二次确认。
   * ★ 为什么是「同一位置换成确认」而不是弹模态：删除是个高频小动作，弹窗要多一次
   *   点击 + 一次视觉跳转；把图标原地换成「确认删除」就能拦住手滑，成本只有一次点击。
   * ★ 为什么不用红色：本项目没有 danger 语义色变量，硬写色值会在六种纸色 ×
   *   宿主明暗两态下踩对比度；这条判据要的是「两个动作」，颜色不是必需品。
   */
  const [confirmingId, setConfirmingId] = useState('');
  const inputRef = useRef(null);

  const stats = useMemo(() => summariseAnnotations(items), [items]);
  const visible = useMemo(() => (tab === 'note'
    ? items.filter(item => item.note.trim() !== '')
    : items), [items, tab]);

  // 打开编辑时把焦点放进输入框：用户点「写笔记」之后下一步一定是打字。
  useEffect(() => {
    if (editingId === '') return;
    inputRef.current?.focus();
  }, [editingId]);

  /**
   * 确认态会自己过期。
   *
   * ★ 不过期的话，用户点了一次垃圾桶又改主意，那一行就永远停在「确认删除」上 ——
   *   下次回来看到的是一个不认识的按钮状态，比没有确认更让人困惑。
   * ★ 4 秒：够看完那句话并决定，又不至于久到「以为它自己会一直等」。
   */
  useEffect(() => {
    if (confirmingId === '') return undefined;
    const timer = setTimeout(() => setConfirmingId(''), 4000);
    return () => clearTimeout(timer);
  }, [confirmingId]);

  /**
   * 外面指定「打开就编辑这一条」（划完线顺手写一句的那个入口）。
   *
   * ★ 用 `[focusId]` 触发而不是「由父组件改 key 重挂面板」：重挂会丢掉用户
   *   已经切到「笔记」页签、滚到一半的位置这些局部状态。
   */
  useEffect(() => {
    if (focusId === '') return;
    const target = items.find(item => item.id === focusId);
    if (target === undefined) return;
    setEditingId(target.id);
    setDraft(target.note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const beginEdit = (item) => {
    setEditingId(item.id);
    setDraft(item.note);
  };

  const commit = () => {
    if (editingId === '') return;
    onUpdate(editingId, { note: draft.slice(0, NOTE_LIMIT) });
    setEditingId('');
  };

  return (
    <aside className="npr-marks" aria-label="划线与笔记">
      <header className="npr-marks-head">
        <div>
          <h2>划线</h2>
          <p>
            {stats.total === 0
              ? '还没有划线'
              : `${stats.total} 条 · ${stats.notes} 条笔记 · 分布在 ${stats.pages} 页`}
          </p>
        </div>
        <button type="button" className="npr-icon" title="收起划线面板" aria-label="收起划线面板" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>

      <div className="npr-marks-tabs" role="tablist" aria-label="划线分类">
        {TABS.map(entry => (
          <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id}
            className={`npr-marks-tab${tab === entry.id ? ' is-on' : ''}`}
            onClick={() => setTab(entry.id)}>
            {entry.label}
            <span className="npr-marks-tab-count">
              {entry.id === 'note' ? stats.notes : stats.total}
            </span>
          </button>
        ))}
      </div>

      <div className="npr-marks-list">
        {visible.length === 0 && (
          <p className="npr-marks-empty">
            {stats.total === 0
              ? '在书页上拖选一段文字，点「划线」就会出现在这里；加上笔记之后还能按页签筛出来。'
              : '还没有写过笔记的划线。点某一行的「笔记」写一句。'}
          </p>
        )}
        {visible.map((item) => {
          const editing = editingId === item.id;
          return (
            <article key={item.id} className={`npr-mark-card${editing ? ' is-editing' : ''}`} data-tone={item.tone}>
              <button type="button" className="npr-mark-quote" title="跳到这一页" onClick={() => onJump(item.page)}>
                {item.quote}
              </button>
              <div className="npr-mark-foot">
                <span className="npr-mark-page">第 {item.page} 页</span>
                <div className="npr-mark-tones" role="group" aria-label="标记颜色">
                  {TONE_ORDER.map(tone => (
                    <button key={tone} type="button" className="npr-mark-tone" data-tone={tone}
                      title={ANNOTATION_TONES[tone]}
                      aria-label={ANNOTATION_TONES[tone]}
                      aria-pressed={item.tone === tone}
                      onClick={() => onUpdate(item.id, { tone })} />
                  ))}
                </div>
                <button type="button" className="npr-mark-action" title={editing ? '取消' : '写笔记'}
                  onClick={() => (editing ? setEditingId('') : beginEdit(item))}>
                  {/* ★ 图标名要写成**两个各自独立的字面量**：`test/icons.test.mjs` 会
                      把 `name={...}` 表达式里的字符串逐个当图标名核对，而表达式里一旦
                      出现 `''`（这里比较笔记是否为空），它按引号切分就会错位成 `? ` / `: `。 */}
                  {item.note.trim() === '' ? <Icon name="pencil" size={13} /> : <Icon name="file-text" size={13} />}
                </button>
                {confirmingId === item.id ? (
                  <button type="button" className="npr-mark-action is-confirming"
                    title="再点一次就删掉（4 秒后自动取消）"
                    onClick={() => { setConfirmingId(''); onRemove(item.id); }}>
                    确认删除
                  </button>
                ) : (
                  <button type="button" className="npr-mark-action" title="删除这条划线"
                    onClick={() => setConfirmingId(item.id)}>
                    <Icon name="trash-2" size={13} />
                  </button>
                )}
              </div>
              {!editing && item.note.trim() !== '' && (
                <p className="npr-mark-note">{item.note}</p>
              )}
              {editing && (
                <div className="npr-mark-editor">
                  <textarea ref={inputRef} value={draft} maxLength={NOTE_LIMIT} rows={3}
                    placeholder="写一句你的想法…"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commit(); }
                      if (event.key === 'Escape') { event.preventDefault(); setEditingId(''); }
                    }} />
                  <div className="npr-mark-editor-foot">
                    <button type="button" className="npr-marks-primary" onClick={commit}>保存笔记</button>
                    <span>{draft.length > 0 ? `${draft.length} 字 · ⌘↵ 保存` : '记下这一句为什么值得留'}</span>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </aside>
  );
}
