/**
 * Compact Markdown → HTML renderer, used to display AI-generated 译文 / 改写
 * （它们都是 Markdown）。范围刻意很小：标题、强调、链接、图片、围栏与行内代码、
 * 列表、引用。
 *
 * 只有这一个方向：本插件不做笔记导出，因此不存在 HTML → Markdown 的反向转换。
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttrPart(value) {
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text) {
  let out = escapeHtml(text);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    // alt 必须和 src 一样做属性转义：`escapeHtml` 只处理 & < >，双引号会活下来
    // 并**提前闭合 alt 属性**（实测 `![a"b](x.png)` → `alt="a"b"`）。
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => `<img src="${escapeAttrPart(src)}" alt="${escapeAttrPart(alt)}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
      const safe = /^(?:https?:|mailto:|\/|#)/i.test(href) ? href : '#';
      return `<a href="${escapeAttrPart(safe)}" target="_blank" rel="noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

/**
 * Render a Markdown document to HTML.
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let listType;
  let inQuote = false;
  let codeFence = false;
  let codeBuffer = [];

  const closeParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType !== undefined) {
      out.push(`</${listType}>`);
      listType = undefined;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (codeFence) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        codeBuffer = [];
        codeFence = false;
      } else {
        codeBuffer.push(rawLine);
      }
      continue;
    }
    if (/^```/.test(line)) {
      closeParagraph();
      closeList();
      closeQuote();
      codeFence = true;
      continue;
    }
    if (line.trim() === '') {
      closeParagraph();
      closeList();
      closeQuote();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      closeQuote();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(?:-{3,}|\*{3,})$/.test(line.trim())) {
      closeParagraph();
      closeList();
      closeQuote();
      out.push('<hr>');
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeParagraph();
      closeList();
      if (!inQuote) {
        out.push('<blockquote>');
        inQuote = true;
      }
      out.push(`<p>${inline(quote[1])}</p>`);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ordered || unordered) {
      closeParagraph();
      closeQuote();
      const wanted = ordered ? 'ol' : 'ul';
      if (listType !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        listType = wanted;
      }
      out.push(`<li>${inline((ordered ?? unordered)[1])}</li>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  if (codeFence && codeBuffer.length > 0) out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  closeParagraph();
  closeList();
  closeQuote();
  return out.join('\n');
}
