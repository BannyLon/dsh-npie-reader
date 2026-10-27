/**
 * 日记的写入口（灵感 / 私密 / 读后感三种模块共用）。
 *
 * 为什么自己写而不用现成的编辑器组件 —— 以及到底抄了谁
 * ------------------------------------------------------
 * 2026-10-27 用户的第 3 条反馈：「你的写作框真的巨丑，而且不便捷。再次命令你去
 * github 找好的文本编辑框。」上一轮我给的两份调研全是数据层的，没有一个字讲编辑器，
 * 所以这一轮先真的去看了三个参考实现，再决定怎么做：
 *
 *   ① **uiwjs/react-md-editor**（9.6k★，MIT）
 *      - 工具栏分两区：左侧 `commands`（格式命令）、右侧 `extraCommands`（视图/全屏），
 *        中间用 `divider` 分组；命令多了用 `group` 收成下拉。
 *      - 架构是清晰的三层：**按键 → 命令 → 文本操作**（TextState 带 selectedText，
 *        TextAreaTextApi 提供 replaceSelection / makeList）。
 *      - 高度自适应靠 `minHeight` / `maxHeight` 两个边界，`autoFocusEnd` 让人接着上次写。
 *      - 这条最重要：它**没有**把 textarea 换成 contenteditable —— 纯 textarea 也能有
 *        好用的工具栏，只要命令层写对。
 *
 *   ② **bytedance/bytemd**（4.6k★，MIT）
 *      - 三种模式 `split` / `tab` / `auto`；默认 `auto` 跟着容器宽度自己切。
 *      - 预览有 `previewDebounce`（300ms）—— 边打边渲染会把光标位置抖没。
 *      - 工具栏里没启用的功能（比如没传 uploadImages）就不显示对应按钮。
 *
 *   ③ **usememos/memos**（40k★）
 *      - 写入口**在流里**，不是一张浮在页面上的表单卡；提交后回到列表顶部。
 *      - 支持 markdown 快捷输入（`- ` 自动续列表、`# ` 变标题）。
 *
 * 抄的是**交互**，不是代码：
 *   - 工具栏 + 命令层（①）：本文件下半部的 `wrap` / `prefix` / `insertTag` 就是那个
 *     「命令 → 文本操作」的骨架，只是用 textarea 的 setRangeText 实现；
 *   - tab 预览 + 防抖（②）：`useEffect` 里 180ms 后再渲染预览；
 *   - 焦点在正文、工具栏收在底部（③）：写的时候看不见一排按钮，鼠标移上来才出现。
 *
 * 为什么**不**直接装这些依赖：
 *   本插件是 esbuild 单文件打包、产物已经 1.07 MB，react-md-editor 带 rehype/prism
 *   一整套（≈300 KB gzip 前），换来的主要是「CodeMirror 级的高亮」——而日记的行内
 *   格式只有粗体、列表、引用三种。为了三种格式背 300 KB，还要把它整套 CSS 覆盖成
 *   宿主主题（`--npr-*` 变量是独立的一套），收益比不划算。这里只借它们的**结构**。
 *
 * 视觉上要修掉的具体毛病（用户截图里那三条）：
 *   - 焦点态是一圈 2px 的品牌绿 outline（截图里那圈荧光绿）⇒ 现在没有描边，
 *     焦点只靠「工具栏浮出来 + 光标」表达；
 *   - 整块是灰底圆角盒子 ⇒ 现在透明底，只用一条 1px 的线跟正文分开；
 *   - 占位符里写着 `**一句话总结**` 的源码 ⇒ 模板改成 `## 一句话总结`，且预览
 *     一按就渲染成真标题。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sanitizeHtml } from '../host/sanitize.js';
import { markdownToHtml } from '../host/markdown.js';

/** 预览防抖：边打边渲染会把光标抖没（bytemd 的 previewDebounce 是同一个理由）。 */
const PREVIEW_DEBOUNCE_MS = 180;

/**
 * 一句命令 = `{ id, label, title, run }`。`run` 拿到 `{ el, value, onChange }`。
 * 把「点按钮」和「动文本」拆开，才能让工具栏、快捷键、模板三处共用同一套动作。
 */
function wrapInline(mark, sample) {
  return ({ el, value, onChange }) => {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const picked = value.slice(start, end) || sample;
    const next = `${value.slice(0, start)}${mark}${picked}${mark}${value.slice(end)}`;
    onChange(next);
    // 选中的如果是自己塞进去的占位词，选中它，接着打字就替换掉了。
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + mark.length, start + mark.length + picked.length);
    });
  };
}

function toggleLinePrefix(prefix) {
  return ({ el, value, onChange }) => {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', end);
    const stop = lineEnd === -1 ? value.length : lineEnd;
    const block = value.slice(lineStart, stop);
    const lines = block.split('\n');
    // 全都已经带前缀 ⇒ 去掉；否则一律加上（不做「部分加一半」这种半吊子状态）。
    const all = lines.every((line) => line === '' || line.startsWith(prefix));
    const nextBlock = lines
      .map((line) => (all ? line.slice(prefix.length) : `${prefix}${line}`))
      .join('\n');
    const next = `${value.slice(0, lineStart)}${nextBlock}${value.slice(stop)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(lineStart, lineStart + nextBlock.length);
    });
  };
}

function insertText(snippet, back = 0) {
  return ({ el, value, onChange }) => {
    const start = el.selectionStart;
    const next = `${value.slice(0, start)}${snippet}${value.slice(el.selectionEnd)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + snippet.length - back, start + snippet.length - back);
    });
  };
}

const COMMANDS = [
  { id: 'bold', label: 'B', title: '粗体（⌘B）', className: 'is-strong', run: wrapInline('**', '粗体') },
  { id: 'italic', label: 'I', title: '斜体（⌘I）', className: 'is-italic', run: wrapInline('*', '斜体') },
  { id: 'divider', divider: true },
  { id: 'h2', label: 'H', title: '小标题', run: toggleLinePrefix('## ') },
  { id: 'list', label: '•', title: '列表', run: toggleLinePrefix('- ') },
  { id: 'quote', label: '”', title: '引用', run: toggleLinePrefix('> ') },
  { id: 'divider2', divider: true },
  { id: 'tag', label: '#', title: '标签（正文里写 #词 就会进标签云）', run: insertText('#', 0) },
  { id: 'rule', label: '—', title: '分隔线', run: insertText('\n\n---\n\n') },
];

/**
 * @param props.value     当前文本
 * @param props.onChange  `(next: string) => void`
 * @param props.onSubmit  点「记下来」/⌘↵
 * @param props.variant   `quick`（灵感）| `private` | `reflection`（更高的起点）
 * @param props.busy      正在保存
 * @param props.disabled  不可写（例如这本书还没标记读完）
 * @param props.actions   底部左侧的附加动作（套用模板 / 清空 …）
 * @param props.extra     工具栏与底栏之间的附加行（私密的情绪行）
 */
export function DiaryComposer({
  value, onChange, onSubmit, placeholder, variant = 'quick', busy = false, disabled = false,
  submitLabel = '记下来', actions = null, maxHeight = 320, autoFocus = false, inputRef = null,
  extra = null,
}) {
  const el = useRef(null);
  const [mode, setMode] = useState('edit');
  const [preview, setPreview] = useState('');

  // 高度跟着内容长：先归零再读 scrollHeight，否则只会越缩越长。
  useLayoutEffect(() => {
    const node = el.current;
    if (!node || mode !== 'edit') return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
  }, [value, mode, maxHeight]);

  useEffect(() => {
    if (mode !== 'preview') { setPreview(''); return undefined; }
    const id = setTimeout(() => {
      try {
        setPreview(sanitizeHtml(markdownToHtml(value)));
      } catch {
        setPreview('');
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [mode, value]);

  useEffect(() => {
    if (autoFocus && el.current) el.current.focus();
  }, [autoFocus]);

  const commands = useMemo(() => COMMANDS.map((item) => ({ ...item })), []);
  const runCommand = (item) => {
    if (disabled || !item.run) return;
    item.run({ el: el.current, value, onChange });
  };

  function onKeyDown(event) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key === 'Enter') { event.preventDefault(); onSubmit?.(); return; }
    if (mod && (event.key === 'b' || event.key === 'B')) { event.preventDefault(); runCommand(commands[0]); return; }
    if (mod && (event.key === 'i' || event.key === 'I')) { event.preventDefault(); runCommand(commands[1]); return; }
    if (mod && (event.key === 'e' || event.key === 'E')) { event.preventDefault(); setMode((current) => (current === 'edit' ? 'preview' : 'edit')); return; }
    if (event.key === 'Tab') {
      // Tab 不跳焦点：写日记时它应当是缩进（react-md-editor 的 tabSize 行为）。
      event.preventDefault();
      const start = event.currentTarget.selectionStart;
      const next = `${value.slice(0, start)}  ${value.slice(event.currentTarget.selectionEnd)}`;
      onChange(next);
      requestAnimationFrame(() => { if (el.current) el.current.setSelectionRange(start + 2, start + 2); });
      return;
    }
    if (event.key === 'Enter') {
      // 列表续行（memos / obsidian 都是这个行为）：在 `- ` 后面回车，下一行还是 `- `。
      const start = event.currentTarget.selectionStart;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const line = value.slice(lineStart, start);
      const match = /^(> |- |\* |\d+\. )(.*)$/.exec(line);
      if (!match) return;
      event.preventDefault();
      const bullet = match[1];
      const nextBullet = /^\d+\. $/.test(bullet) ? `${Number(bullet.slice(0, -2)) + 1}. ` : bullet;
      // 空列表项再回车 ⇒ 结束列表（否则会无限续下去，用户得自己删符号）。
      const inserted = match[2].trim() === '' ? '\n' : `\n${nextBullet}`;
      const next = `${value.slice(0, start)}${inserted}${value.slice(start)}`;
      onChange(next);
      requestAnimationFrame(() => {
        if (el.current) el.current.setSelectionRange(start + inserted.length, start + inserted.length);
      });
    }
  }

  const chars = value.replace(/\s/g, '').length;

  return (
    <div className="npr-write" data-variant={variant} data-mode={mode}>
      {mode === 'preview' ? (
        preview
          ? <div className="npr-write-preview" dangerouslySetInnerHTML={{ __html: preview }} />
          : <p className="npr-write-empty">还没有内容。</p>
      ) : (
        <textarea
          ref={(node) => { el.current = node; if (inputRef) inputRef.current = node; }}
          className="npr-write-input"
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )}

      <div className="npr-write-tools" role="toolbar" aria-label="格式">
        {commands.map((item) => (item.divider
          ? <span key={item.id} className="npr-write-sep" aria-hidden="true" />
          : (
            <button key={item.id} type="button" title={item.title} aria-label={item.title}
              className={`npr-write-tool${item.className ? ` ${item.className}` : ''}`}
              disabled={disabled || mode === 'preview'} onClick={() => runCommand(item)}>
              {item.label}
            </button>
          )))}
        <span className="npr-write-grow" />
        <button type="button" className="npr-write-tool is-text"
          aria-pressed={mode === 'preview'} title="预览（⌘E）"
          onClick={() => setMode((current) => (current === 'edit' ? 'preview' : 'edit'))}>
          {mode === 'preview' ? '继续写' : '预览'}
        </button>
      </div>

      {/* 模块自己的附加行（目前只有私密的情绪行）：夹在工具栏与底栏之间，
          因为「选心情」是**写完之前**的动作，放在「记下来」下面会让人先点保存再选心情。 */}
      {extra}

      <div className="npr-write-foot">
        <span className="npr-write-hint">{chars} 字 · ⌘/Ctrl + Enter</span>
        {actions}
        <button type="button" className="npr-diary-save" disabled={disabled || busy || value.trim() === ''}
          onClick={() => onSubmit?.()}>
          {busy ? '正在保存…' : submitLabel}
        </button>
      </div>
    </div>
  );
}
