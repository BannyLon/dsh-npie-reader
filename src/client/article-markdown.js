/**
 * 导出 Markdown（0.44.9）。
 *
 * 之前只有「打印 / 存为 PDF」—— 那份东西是给人**看**的，拿去做笔记、进 Obsidian、
 * 塞进知识库都不行：PDF 里的文字选不中、也改不了。
 *
 * ★ 为什么是「HTML → Markdown」而不是「纯文本」：正文里真正有价值的结构是标题层级、
 *   列表、引用、代码块、图片、链接。剥成纯文本之后这些全没了，一篇带小标题的长文会
 *   变成一大段。所以这里做的是**结构转换**，不是去标签。
 * ★ 输入是**已经过 `sanitizeHtml` 的**那一份（`bodyHtml`），标签集合是封闭的
 *   （见 `src/host/sanitize.js` 的 `ALLOWED_TAGS`）。所以这里的词法分析可以只认
 *   那几十个标签，不需要一个真正的 HTML 解析器 —— 这也是它能在 node 里直接单测的原因
 *   （没有 DOM 依赖）。
 * ★ 有意**不转义**正文里的 `*` / `_` / `#`：转义会让「C++ 与 C#」这类文本变成
 *   `C\+\+`，可读性掉一大截，而误触发的条件（成对出现且被空白包围）在中文长文里
 *   几乎不出现。代价是极端文本可能被渲染成斜体 —— 这里选择「可读」而不是「绝对无损」。
 */
import { decodeHtmlEntities } from '../host/sanitize.js';

/** 行内标签 → 前后缀。`code` 在 `pre` 里走围栏，不在这里。 */
const INLINE = {
  strong: '**', b: '**',
  em: '*', i: '*',
  del: '~~', s: '~~',
  // 行内 `<code>`。`<pre>` 里的那一份走围栏（`inPre` 时不会走到这里）。
  code: '`',
  kbd: '`', samp: '`',
};

const HEADING = /^h([1-6])$/;

/**
 * 把一篇已经渲染好的正文 HTML 转成 Markdown 全文（含标题区）。
 *
 * @param {{title?: string, url?: string, author?: string, publishedAt?: string, version?: string, html?: string}} article
 * @returns {string}
 */
export function articleToMarkdown({ title = '', url = '', author = '', publishedAt = '', version = '', html = '' } = {}) {
  const head = [];
  head.push(`# ${title || '未命名文章'}`, '');
  const meta = [];
  if (author) meta.push(`作者：${author}`);
  if (publishedAt) meta.push(`发布：${formatDay(publishedAt)}`);
  if (version) meta.push(`版本：${version}`);
  if (meta.length > 0) head.push(meta.join(' · '), '');
  if (url) head.push(`原文：${url}`, '');
  head.push('---', '');

  // 多一个 `\n`：`head` 以空串结尾，`join` 之后末尾只有一个换行 —— 少了它就变成
  // 「---」紧贴正文第一行，导出的 md 里那条分隔线会被当成 setext 标题的下划线。
  return `${head.join('\n')}\n${bodyToMarkdown(html)}\n`;
}

/** 正文部分（不含标题区）。单独导出，便于测试逐段比对。 */
export function bodyToMarkdown(html) {
  const out = [];
  let buf = '';
  /** 列表栈：每层 `{ordered, index}`。嵌套时用缩进表达。 */
  const listStack = [];
  /** `<a>` 的 href 栈 —— 开标签时吐 `[`，闭标签时吐 `](href)`。 */
  const linkStack = [];
  let quoteDepth = 0;
  let inPre = false;
  let preBuffer = '';
  /** 表格：已输出几行、本行几个单元格、第一行几列。 */
  let tableRows = 0;
  let rowCells = 0;
  let firstRowCells = 0;

  /**
   * 空行。
   *
   * ★ 引用里的空行必须带 `>`：只推一个空串的话，引用块在那一行就**断了**，
   *   后半个引用会变成正文（Markdown 的引用靠每行的 `>` 连续，不靠缩进）。
   */
  const blank = () => {
    const marker = quoteDepth > 0 ? '> '.repeat(quoteDepth).trimEnd() : '';
    if (out.length > 0 && out[out.length - 1] !== marker) out.push(marker);
  };

  const pushLine = (text) => {
    const trimmed = text.replace(/[ \t]+$/, '');
    if (trimmed.trim() === '') { blank(); return; }
    out.push(`${'> '.repeat(quoteDepth)}${trimmed}`);
  };

  /**
   * 结束当前块：把缓冲推成一行。
   *
   * ★ 缓冲为空时**什么都不做** —— 这不是优化，是正确性：`<li>` 之间、`<tr>` 之间
   *   都会先调一次 `endBlock()`，空缓冲若也推一个空行，列表就变成「松散列表」
   *   （每项之间空一行），表格的分隔行会和表头被空行隔开 ⇒ **Markdown 不认这是表格**。
   *   实测症状：导出的 md 在编辑器里是一堆「| 列1 | 列2 |」的普通段落。
   */
  const endBlock = () => {
    if (buf.trim() === '') { buf = ''; return; }
    pushLine(buf);
    buf = '';
  };

  /**
   * 硬换行（`<br>`）。
   *
   * ★ 不能只 `endBlock()`：Markdown 里单个换行是**软换行**，渲染时会被接成一行 ——
   *   原文用 `<br>` 分开的两行（诗、地址、代码外的分行）会挤在一起。
   *   硬换行要行尾两个空格，而 `pushLine` 会把行尾空白 trim 掉，所以这里单独走。
   */
  const hardBreak = () => {
    if (buf.trim() === '') return;
    out.push(`${'> '.repeat(quoteDepth)}${buf.replace(/[ \t]+$/, '')}  `);
    buf = '';
  };

  const tokens = String(html ?? '').split(/(<[^>]+>)/);
  for (const token of tokens) {
    if (token === '') continue;

    if (!token.startsWith('<')) {
      // 文本
      const text = decodeHtmlEntities(token);
      if (inPre) preBuffer += text;
      else buf += text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
      continue;
    }

    // 标签
    const close = token.startsWith('</');
    const selfClose = /\/>$/.test(token);
    const name = (token.match(/^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/) ?? [])[1]?.toLowerCase() ?? '';
    if (name === '') continue;

    if (name === 'br') { if (inPre) preBuffer += '\n'; else hardBreak(); continue; }
    if (name === 'hr') { endBlock(); pushLine('---'); blank(); continue; }

    if (name === 'pre') {
      if (!close) { endBlock(); inPre = true; preBuffer = ''; }
      else {
        inPre = false;
        // 围栏要足够长：正文里出现 ``` 时不能提前闭合
        const fence = preBuffer.includes('```') ? '````' : '```';
        out.push(`${fence}`, preBuffer.replace(/\n+$/, ''), `${fence}`);
        blank();
        preBuffer = '';
      }
      continue;
    }
    if (inPre) continue;

    const heading = HEADING.exec(name);
    if (heading) {
      // 标题后面留一个空行：紧贴下一段在 ATX 语法下是合法的，但导出的文件是给人
      // 改的 —— 「## 小节」下一行直接接正文，读起来像漏了空行。
      if (!close) { endBlock(); buf = `${'#'.repeat(Number(heading[1]))} `; }
      else { endBlock(); blank(); }
      continue;
    }

    if (name === 'p' || name === 'div' || name === 'figure' || name === 'figcaption'
      || name === 'section' || name === 'article' || name === 'header' || name === 'footer') {
      // 列表项里的 `<p>` 不切行：切了会得到「- 文字」+ 空行 + 缩进文字，渲染成松散列表
      if (listStack.length > 0) continue;
      // 闭合时补空行：段落紧跟一个 `- 列表` 在 CommonMark 里虽然合法，但导出的文件
      // 是给人改的，块与块之间没有空行读起来是一坨。
      if (close) { endBlock(); blank(); } else endBlock();
      continue;
    }

    if (name === 'blockquote') {
      if (!close) { endBlock(); quoteDepth += 1; }
      else { endBlock(); quoteDepth = Math.max(0, quoteDepth - 1); if (quoteDepth === 0) blank(); }
      continue;
    }

    if (name === 'ul' || name === 'ol') {
      endBlock();
      if (!close) listStack.push({ ordered: name === 'ol', index: 0 });
      else { listStack.pop(); if (listStack.length === 0) blank(); }
      continue;
    }

    if (name === 'li') {
      if (!close) {
        endBlock();
        const level = Math.max(1, listStack.length);
        const top = listStack[level - 1] ?? { ordered: false, index: 0 };
        top.index += 1;
        buf = `${'  '.repeat(level - 1)}${top.ordered ? `${top.index}. ` : '- '}`;
      } else endBlock();
      continue;
    }

    if (name === 'table') {
      endBlock();
      if (!close) { tableRows = 0; firstRowCells = 0; } else blank();
      continue;
    }
    if (name === 'tr') {
      // ★ `endBlock()` 只能在**开标签**那一侧调：闭标签时整行的内容还在 `buf` 里，
      //   先 flush 掉会让下面那句 `pushLine(buf + ' ')` 拿到空串，于是每行表格后面
      //   多出一个空行 —— 表头与分隔行被隔开，Markdown 就不认这是表格了。
      if (!close) { endBlock(); rowCells = 0; buf = '|'; } else {
        // 第一行之后补分隔行，否则 Markdown 不认这是表格
        pushLine(`${buf} `);
        buf = '';
        tableRows += 1;
        if (tableRows === 1) {
          firstRowCells = rowCells;
          pushLine(`|${' --- |'.repeat(Math.max(1, firstRowCells))}`);
        }
      }
      continue;
    }
    if (name === 'td' || name === 'th') {
      if (!close) { rowCells += 1; buf += ' '; } else buf += ' |';
      continue;
    }

    if (name === 'img') {
      const src = attr(token, 'src');
      if (src) buf += `![${attr(token, 'alt')}](${src})`;
      continue;
    }

    if (name === 'a') {
      if (!close) { linkStack.push(attr(token, 'href')); buf += '['; }
      else {
        const href = linkStack.pop();
        buf += href ? `](${href})` : ']';
      }
      continue;
    }

    const mark = INLINE[name];
    if (mark) { buf += mark; continue; }
    // 其余（`span` / `sup` / `sub` / `small` / `mark` / `abbr` / `time` …）
    // 只保留文字，不加标记 —— Markdown 里没有对应语法，硬加会变成噪音。
    void selfClose;
  }

  if (inPre && preBuffer !== '') out.push('```', preBuffer.replace(/\n+$/, ''), '```');
  endBlock();
  // 结尾的空行 / 只由 `>` 组成的行都去掉：导出的文件末尾挂着一串 `>` 很难看，
  // 而且某些编辑器会把它当成一个空的引用块。
  while (out.length > 0 && /^[>\s]*$/.test(out[out.length - 1])) out.pop();
  return out.join('\n');
}

/** 取一个属性值（已解码实体）。 */
function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
    ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return match ? decodeHtmlEntities(match[1]) : '';
}

/**
 * 导出文件名。
 *
 * ★ 必须把 `/ \ : * ? " < > |` 和控制字符换掉：`publishedAt` 是 ISO 串，
 *   标题里也常见「Apple/Google」「他为什么说“不”」—— 这些字符在 macOS 上会被
 *   悄悄换成 `_`，在 Windows 上直接让写入失败。用户看到的文件名和期望不一致时，
 *   第一反应是「导出坏了」。
 */
export function markdownFileName(title, publishedAt) {
  const safe = String(title ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  const day = formatDay(publishedAt);
  const stem = safe === '' ? 'RSS 文章' : safe;
  return day ? `${day}-${stem}.md` : `${stem}.md`;
}

function formatDay(value) {
  if (!value) return '';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 让浏览器把一段文本存成文件。
 *
 * ★ 用 `Blob` + `a[download]` 而不是 `showSaveFilePicker`：后者在 Electron 的
 *   渲染进程里不一定有（取决于 Chromium 版本），而 `a[download]` 在桌面端会走
 *   Electron 的 `will-download` ⇒ 弹出系统保存对话框，正是想要的行为。
 * ★ `revokeObjectURL` 必须延后一拍：同步 revoke 会让下载在某些 Chromium 版本里
 *   拿到一个已经失效的 URL，表现为「点了没反应」。
 *
 * @param {string} filename
 * @param {string} text
 * @param {{document?: Document, url?: typeof URL, schedule?: (fn: () => void) => void}} [env]
 *   三个依赖都可注入 —— 单测里没有真的 document，也不需要真的下载。
 * @returns {string} 实际使用的 blob URL（测试用）
 */
export function downloadText(filename, text, env = {}) {
  const doc = env.document ?? (typeof document === 'undefined' ? undefined : document);
  const urlApi = env.url ?? (typeof URL === 'undefined' ? undefined : URL);
  const schedule = env.schedule ?? ((fn) => { setTimeout(fn, 0); });
  if (!doc || !urlApi || typeof Blob === 'undefined') throw new Error('当前环境不支持导出文件');
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const href = urlApi.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  schedule(() => urlApi.revokeObjectURL(href));
  return href;
}
