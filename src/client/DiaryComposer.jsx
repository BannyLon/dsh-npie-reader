/**
 * 日记的写入口（灵感 / 私密 / 读后感三种模块共用）。
 *
 * 底座：Milkdown（markdown 原生，ProseMirror 内核），按需从宿主下载
 * ------------------------------------------------------------------
 * 用户在 2026-10-27 第三次要求「去 GitHub 找一个好的文本编辑器」，前两次我都交的是
 * 手写 textarea + 自造工具栏。这次换了做法：**接一个真正的编辑器**。
 *
 * 为什么是 Milkdown，而不是 stars 更高的那几个（数据是当天 GitHub API 实测的）：
 *   quill 47,374 / monaco 46,897 / editor.js 31,977 / lexical 23,987 都排在它前面，
 *   但 **5 万以上的仓库全是完整应用**（AppFlowy / AFFiNE / Joplin / Logseq），不是库；
 *   而排在前面的库里，Quill 与 Lexical 都是 **HTML 输出** —— 我们的日记是
 *   **一天一个 .md 文件**，人要能拿任何编辑器直接打开。HTML 路线要 HTML→Markdown
 *   往返（turndown），一次往返就可能改掉用户写的 `#标签`、`---`、空行。
 *   Milkdown 两头都是 markdown（remark 解析 / 序列化），是这几家里往返损耗最小的。
 *   → 结论：这一步不该按 stars 选，该按「能不能保住存储格式」选。
 *
 * 为什么它不被打进主 bundle：
 *   373 KB 的第三方代码内联进去会撞破 `test/build.test.mjs` 那条「非第一方字节数为 0」
 *   的闸。所以照 pdf.js 的老路：单独构建到 `vendor/editor/editor.mjs`，由宿主按
 *   `EDITOR_VENDOR_PREFIX` 发出来，客户端**按需** `import()`（见 `diary-editor.js`）。
 *
 * ★ **textarea 没有删，它是退路**：拿不到编辑器（宿主没托管、请求失败、命令不可用）
 *   时 `rich` 保持 false，界面照旧是 textarea + 同一排工具栏。日记必须永远能写 ——
 *   编辑器是增强，不是前提。
 * ★ 两者是**同一份 markdown 的两个视图**，不是两套存储：编辑器里看到的是排好版的
 *   标题和列表，落盘的仍然是可读的 `.md` 原文。
 *
 * 手写那部分留下的东西（仍然在用）：
 *   - 工具栏的**命令层**（`wrap` / `prefix` / `insertTag`）：富文本模式下按钮改走
 *     Milkdown 命令，退路模式下仍然是「命令 → 改字符串」，共用同一份 `COMMANDS`；
 *   - tab 预览 + 180ms 防抖：⌘E 仍然能在「写」和「渲染后的样子」之间切；
 *   - 高度跟着内容长、⌘↵ 提交、私密模块的情绪行插在工具栏与底栏之间。
 * 已删掉的是 0.33 那圈 2px 品牌绿 outline 与灰底圆角盒子 —— 那是「表单」的样子，
 * 不是「稿纸」的样子。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sanitizeHtml } from '../host/sanitize.js';
import { markdownToHtml } from '../host/markdown.js';
import { loadDiaryEditor } from './diary-editor.js';

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
  { id: 'tag', label: '#', title: '标签（正文里写 #词 就会进标签云）', run: insertText('#', 0), plainOnly: true },
  { id: 'rule', label: '—', title: '分隔线', run: insertText('\n\n---\n\n') },
];

/**
 * 富文本模式里**没有**的命令。
 *
 * `tag` 插的是一个纯文本 `#`，在所见即所得里等于「多打一个字符」—— 留着反而占位；
 * 而正文里打 `#灵感` 本身就是标签的写法，不需要工具栏帮忙。
 */
const RICH_BLOCKED = new Set(['tag']);

/**
 * @param props.value     当前文本
 * @param props.onChange  `(next: string) => void`
 * @param props.onSubmit  点「记下来」/⌘↵
 * @param props.variant   `quick`（灵感）| `private` | `reflection`（更高的起点）
 * @param props.busy      正在保存
 * @param props.disabled  不可写（例如这本书还没标记读完）
 * @param props.actions   底部左侧的附加动作（清空 …）
 * @param props.extra     工具栏与底栏之间的附加行（私密的情绪行）
 * @param props.header    编辑器**上方**的一行（读后感的「结构化读后感模板」条）。
 *   它不属于正文，所以不能塞进 markdown：写进正文会跟着 `.md` 落盘，
 *   而且用户删掉那行标题就再也点不到「套用模板」了。
 */
export function DiaryComposer({
  value, onChange, onSubmit, placeholder, variant = 'quick', busy = false, disabled = false,
  submitLabel = '记下来', actions = null, maxHeight = 320, autoFocus = false, inputRef = null,
  extra = null, insertRef = null, header = null,
}) {
  const el = useRef(null);
  const [mode, setMode] = useState('edit');
  const [preview, setPreview] = useState('');
  /** 正在被拖进来的东西悬在上面（只影响样式，见 `.npr-write[data-drop]`）。 */
  const [dropping, setDropping] = useState(false);

  // ---- 富文本编辑器（Milkdown，按需从宿主下载）------------------------------
  const richEl = useRef(null);
  const richRef = useRef(null);
  const [rich, setRich] = useState(false);
  /** 编辑器自己的 onChange 走 ref：effect 只挂一次，不能因为父组件重渲染就重挂。 */
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (disabled) return undefined;
    let alive = true;
    loadDiaryEditor()
      .then(async (mod) => {
        if (!alive) return;
        // 先把挂载点渲染出来再挂编辑器：ProseMirror 挂在一个不可见的容器里
        // 会按 0 高度量一遍，光标位置和滚动都会错位。
        setRich(true);
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        if (!alive || !richEl.current) return;
        const editor = await mod.createDiaryEditor({
          root: richEl.current,
          value: valueRef.current,
          onUpdate: (markdown) => changeRef.current(markdown),
        });
        if (!alive) { editor.destroy(); return; }
        richRef.current = editor;
        if (autoFocus) editor.focus();
      })
      .catch(() => {
        // 拿不到编辑器（宿主没托管这个文件 / 请求失败）⇒ 退回 textarea。
        // 日记必须还能写：编辑器是增强，不是前提。
        if (alive) setRich(false);
      });
    return () => {
      alive = false;
      try { richRef.current?.destroy(); } catch { /* 已销毁 */ }
      richRef.current = null;
      setRich(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  // 外部改值（套用模板 / 清空 / 切到另一天）要写回编辑器。
  useEffect(() => {
    if (!rich || !richRef.current) return;
    richRef.current.setMarkdown(value);
  }, [value, rich]);

  /**
   * 对外暴露「在光标处插入一段文本」。
   *
   * ★ 富文本与 textarea **两条路都收在这一层**：上层（划线的「引用」、拖拽落点）
   *   不需要知道当前挂的是哪一个编辑器 —— 那正是「textarea 是退路」的意思。
   * ★ 富文本插入失败（编辑器内部状态异常、`insert` 返回 false）时**不报错而是降级**
   *   到 textarea 那条字符串路径：日记正文的 value 是同一份 markdown，
   *   只是这一拍没有富文本视图而已。
   */
  useEffect(() => {
    if (!insertRef) return undefined;
    insertRef.current = (text, coords) => {
      const snippet = typeof text === 'string' ? text : '';
      if (snippet === '') return;
      if (rich && richRef.current && richRef.current.insert(snippet, coords)) return;
      const node = el.current ?? null;
      const current = valueRef.current;
      const at = node === null ? current.length : (node.selectionStart ?? current.length);
      changeRef.current(`${current.slice(0, at)}${snippet}${current.slice(at)}`);
      requestAnimationFrame(() => {
        if (node === null) return;
        const to = at + snippet.length;
        node.focus();
        node.setSelectionRange(to, to);
      });
    };
    return () => { insertRef.current = null; };
  }, [rich, insertRef]);

  // 高度跟着内容长：先归零再读 scrollHeight，否则只会越缩越长。
  useLayoutEffect(() => {
    const node = el.current;
    if (!node || mode !== 'edit') return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
  }, [value, mode, maxHeight]);

  /**
   * 从预览点「继续写」回来时，把光标放回编辑区。
   *
   * ★ 预览是把编辑区 `display: none` 收掉（不是卸载，见下面 `.npr-write-body` 的
   *   注释）。浏览器会把焦点丢回 `body` —— 用户回来直接敲键盘，字落在页面上，
   *   正文一个字没进。所以这一行是「回来之后还能接着写」的一半。
   * ★ 用 ref 跳过第一次：`mode` 初值就是 `edit`，不跳过的话挂载那一刻就会抢焦点
   *   （这一页上可能还有别的输入框在等着）。也**不能**把 `rich` 写进依赖：
   *   编辑器加载完 `rich` 从 false 变 true 时会把焦点抢过去。
   */
  const modeSeen = useRef(false);
  useLayoutEffect(() => {
    if (!modeSeen.current) { modeSeen.current = true; return; }
    if (mode !== 'edit') return;
    if (rich && richRef.current) richRef.current.focus();
    else el.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
  /**
   * 富文本模式下要隐掉的按钮，以及「因为被隐掉而变成连续/落单的分隔符」。
   * 不做这一步的话，工具栏上会出现「B I | H • " | | —」这种两道竖线挨着的怪相。
   */
  const shownCommands = useMemo(() => {
    if (!rich) return commands;
    const kept = commands.filter((item) => item.divider || !RICH_BLOCKED.has(item.id));
    return kept.filter((item, at, all) => {
      if (!item.divider) return true;
      const prev = all[at - 1];
      const next = all[at + 1];
      return Boolean(prev && next && !prev.divider);
    });
  }, [commands, rich]);

  const runCommand = (item) => {
    if (disabled || !item.run) return;
    // 富文本模式下交给编辑器自己的命令层（它知道光标在哪、选区是什么）；
    // 退路模式下还是那一套「命令 → 改字符串」。
    if (rich && richRef.current) {
      richRef.current.run(item.id);
      return;
    }
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
    <div className="npr-write" data-variant={variant} data-mode={mode}
      data-drop={dropping ? 'yes' : 'no'}
      /*
       * ★ 拖拽落点用 `clientX/clientY` 交给 `insert(…, coords)` 去算 ProseMirror
       *   的文档位置（`posAtCoords`）。用「插到末尾」会让拖拽等于没做 ——
       *   用户把一条划线拖到第三段，引用块出现在最后一页。
       * ★ `dragover` 必须 `preventDefault()` 才会触发 `drop`；只判 `text/plain`，
       *   拖着图片或文件经过时不该点亮这块。
       */
      onDragOver={(event) => {
        if (disabled || !event.dataTransfer?.types?.includes('text/plain')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        const text = event.dataTransfer?.getData('text/plain') ?? '';
        if (disabled || text.trim() === '') return;
        event.preventDefault();
        insertRef?.current?.(text, { x: event.clientX, y: event.clientY });
      }}>
      {header}
      {/*
        * ★★ 编辑区**永远挂着**，预览只是把它藏起来（`data-mode="preview"` 时 CSS 收掉
        *   `.npr-write-body`，见 refinements.css）。
        *
        *   0.56.4 的 bug（用户 2026-10-30：「没写任何内容，点预览、再点继续写就错乱了」）：
        *   这里原来是三元 —— 进预览就把整棵子树卸掉，回来再挂一棵**空的**
        *   `<div class="npr-write-rich">`。而 ProseMirror 实例只在 effect 里创建一次
        *   （依赖是 `[disabled]`，不会因为切模式重跑），`richRef.current` 指着的还是
        *   那个**容器已经被 React 摘走**的旧实例 —— 它不认新的 DOM。
        *   结果：回来之后编辑区高度 0、占位提示（`position: absolute`）压在工具栏上、
        *   正文里点不出光标，整块看起来像塌了。
        *
        *   ⇒ 卸载重挂这条路对「有实例的富文本」是走不通的，只能藏。textarea 那条路
        *   本来就不受影响（它是受控节点，重挂会照 value 画回来）—— 但两条路共用这一层，
        *   所以按同一条写。
        */}
      <div className="npr-write-body">
        {/*
          * ★ 这一层是**定位基准**，不是装饰：0.44.2 给读后感加了纸面内边距
          *   （12px 16px），而占位提示是 `position: absolute`。没有这层的话，
          *   它会相对带着内边距的 `.npr-write` 定位，文字与光标的起点差 16px。
          *   （预览时这层被 `display: none` 收掉，但**不从 DOM 里摘**。）
          *
          * ★ 富文本挂载点**先于**编辑器存在：ProseMirror 需要一个已经排好版的
          *   容器才能算光标与滚动位置。`rich` 为假时它被 CSS 收掉，显示 textarea。
          * ★ 两者的值始终是**同一份 markdown 字符串**：富文本不是另一套存储，
          *   它只是这份 .md 的一个视图 —— 拿编辑器打开文件依然是可读的原文。
          */}
        <div className="npr-write-rich" ref={richEl} data-ready={rich ? 'yes' : 'no'}
          onKeyDown={(event) => {
            const mod = event.metaKey || event.ctrlKey;
            if (mod && event.key === 'Enter') { event.preventDefault(); onSubmit?.(); }
          }} />
        {/* 空的时候盖一条提示。ProseMirror 的空文档不是空节点（里面有一个 <br>），
            所以占位只能由我们这一层出；有字就不渲染，聚焦时 CSS 再收掉。 */}
        {rich && value.trim() === '' && <span className="npr-write-ph" aria-hidden="true">{placeholder}</span>}
        {!rich && (
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
      </div>
      {/* 预览画在编辑区**之后**：它是同一份 markdown 的另一个视图，不是另一块内容。 */}
      {mode === 'preview' && (preview
        ? <div className="npr-write-preview" dangerouslySetInnerHTML={{ __html: preview }} />
        : <p className="npr-write-empty">还没有内容。</p>)}

      <div className="npr-write-tools" role="toolbar" aria-label="格式">
        {shownCommands.map((item) => (item.divider
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
