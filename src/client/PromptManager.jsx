import { useState } from 'react';
import { Icon } from './icons.jsx';
import { readQuickPrompts, saveQuickPrompts } from './quick-prompts.js';

const MAX_PROMPTS = 20;

/** `crypto.randomUUID` needs a secure context; the reader must not depend on one. */
function newId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fall through */ }
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const SCOPE_META = {
  article: {
    heading: '文章伴读（RSS）',
    intro: '显示在文章伴读输入框上方，点击后直接发送；选中文字时会自动换成「选段」措辞。输入框已有草稿时会保留草稿。',
  },
  book: {
    heading: '电子书伴读',
    intro: '显示在电子书伴读输入框上方，点击后直接发送。提问以「当前这一页」为单位；扫描页（无文字层）会禁用。',
  },
};

export function PromptManager({ notify, startAdding = false, scope = 'article' }) {
  const meta = SCOPE_META[scope] ?? SCOPE_META.article;
  const [items, setItems] = useState(() => readQuickPrompts(scope));
  const [editing, setEditing] = useState(() => (startAdding && readQuickPrompts(scope).length < MAX_PROMPTS ? { title: '', body: '' } : null));
  const persist = (next) => {
    saveQuickPrompts(next, scope);
    setItems(next);
  };
  const save = () => {
    const title = editing.title.trim();
    const body = editing.body.trim();
    if (!title || !body) return;
    const next = editing.id
      ? items.map(item => item.id === editing.id ? { id: item.id, title, body } : item)
      : [...items, { id: newId(), title, body }];
    persist(next);
    setEditing(null);
    notify('快捷提示词已保存');
  };
  return <div className="npr-prompt-manager">
    <div className="npr-settings-card-head npr-settings-source-head">
      <div><h3>{meta.heading}</h3><p>{meta.intro}</p></div>
      <button type="button" className="npr-prompt-add" disabled={items.length >= MAX_PROMPTS} onClick={() => setEditing({ title: '', body: '' })}><Icon name="plus" size={15} />新增</button>
    </div>
    <div className="npr-prompt-list">{items.map(item => <div className="npr-prompt-row" key={item.id}>
      <div><strong>{item.title}</strong><span>{item.body}</span></div>
      <button type="button" aria-label={`编辑 ${item.title}`} onClick={() => setEditing(item)}><Icon name="pencil" size={15} /></button>
      <button type="button" aria-label={`删除 ${item.title}`} onClick={() => { persist(items.filter(prompt => prompt.id !== item.id)); notify('提示词已删除'); }}><Icon name="trash-2" size={15} /></button>
    </div>)}{!items.length && <p>还没有快捷提示词。</p>}</div>
    {editing && <div className="npr-subscription-editor-backdrop" onClick={() => setEditing(null)}>
      <form className="npr-subscription-editor" role="dialog" aria-modal="true" aria-label={editing.id ? '编辑提示词' : '新增提示词'} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); } }} onSubmit={event => { event.preventDefault(); save(); }}>
        <div><strong>{editing.id ? '编辑提示词' : '新增提示词'}</strong><button type="button" aria-label="关闭" onClick={() => setEditing(null)}><Icon name="x" size={16} /></button></div>
        <label>名称<input autoFocus maxLength={60} aria-label="提示词名称" value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
        <label>提示词<textarea rows={5} maxLength={5000} aria-label="提示词内容" value={editing.body} onChange={event => setEditing({ ...editing, body: event.target.value })} /></label>
        <div className="npr-subscription-editor-actions"><button type="button" onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={!editing.title.trim() || !editing.body.trim()}>保存</button></div>
      </form>
    </div>}
  </div>;
}
