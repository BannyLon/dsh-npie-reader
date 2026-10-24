/**
 * Allowlist HTML sanitizer shared by article ingestion (host) and rendering
 * (client copy). The sanitizer rebuilds the document from a token walk, so
 * anything not explicitly allowed — scripts, event handlers, exotic URL
 * schemes — never reaches the output string.
 */

const VOID_TAGS = new Set([
  'br', 'hr', 'img', 'wbr', 'input', 'col', 'source',
]);

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'i', 'strong', 'b',
  'u', 's', 'del', 'a', 'img', 'figure', 'figcaption', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'th', 'td', 'sup', 'sub', 'small', 'mark',
  'details', 'summary', 'span', 'div', 'abbr', 'time', 'kbd', 'samp',
]);

/** Tags whose entire content is dropped, not merely the tag itself. */
const DROP_CONTENT_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'form',
  'textarea', 'select', 'button', 'svg', 'math', 'template', 'title',
  'head', 'link', 'meta', 'base',
]);

const SAFE_URL_ATTRS = new Set(['href', 'src', 'cite', 'poster']);
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function decodeHtmlEntities(text) {
  if (!text.includes('&')) return text;
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©',
    reg: '®', trade: '™', middot: '·', bull: '•', times: '×', deg: '°',
  };
  return text.replace(/&(#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,30});/g, (raw, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return raw;
      try {
        return String.fromCodePoint(code);
      } catch {
        return raw;
      }
    }
    return named[body.toLowerCase()] ?? raw;
  });
}

function escapeText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

function isSafeUrl(raw) {
  const value = raw.trim();
  if (value === '' || value.startsWith('#')) return true;
  // Browsers ignore ASCII whitespace and control characters inside a URL, so
  // `java\tscript:alert(1)` still runs. Normalize the same way before reading
  // the scheme, otherwise the tab hides the scheme and the URL looks relative.
  const normalized = value.replace(/[\u0000-\u0020\u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  // No scheme at all means a relative path; it is resolved against the article
  // base by the caller and cannot introduce a new origin.
  if (!scheme) return true;
  return SAFE_SCHEMES.has(`${scheme[1].toLowerCase()}:`);
}

function safeUrl(raw, baseUrl) {
  const value = raw.trim();
  if (!isSafeUrl(value)) return undefined;
  if (baseUrl) {
    try {
      return new URL(value, baseUrl).href;
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * Sanitize one HTML fragment.
 * @param {string} html - untrusted markup.
 * @param {{baseUrl?: string, maxLength?: number}} [options] - base for relative URLs and an output cap.
 * @returns {string} sanitized markup.
 */
export function sanitizeHtml(html, options = {}) {
  const { baseUrl, maxLength = 400_000 } = options;
  let out = '';
  /**
   * Open elements, each tagged with whether it sits inside a dropped subtree.
   *
   * 为什么不是「一个 droppedDepth 计数器」：`<script>` 原先只把计数器加一、
   * **不入栈**，于是 `</script>` 找不到对应的开标签，计数器永远减不回去 ——
   * 一篇正文里只要出现一个 `<script>`，它**后面全部内容都被静默丢弃**
   * （实测 `<p>a</p><script>x</script><p>b</p>` → `<p>a</p>`）。
   * 现在丢弃的子树也照常入栈，只是标记 `dropped`，由栈顶自己表达
   * 「当前是否在被丢弃的子树里」。
   */
  const stack = [];
  const insideDropped = () => stack.length > 0 && stack[stack.length - 1].dropped;
  let i = 0;
  const n = html.length;
  while (i < n && out.length < maxLength) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (!insideDropped()) out += escapeText(decodeHtmlEntities(html.slice(i)));
      break;
    }
    if (lt > i && !insideDropped()) out += escapeText(decodeHtmlEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt === -1) break;
    const source = html.slice(lt + 1, gt);
    i = gt + 1;
    if (source.startsWith('/')) {
      const name = source.slice(1).trim().toLowerCase();
      let openIdx = -1;
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].tag === name) { openIdx = k; break; }
      }
      if (openIdx !== -1) {
        while (stack.length > openIdx) {
          const closing = stack.pop();
          if (!closing.dropped) out += `</${closing.tag}>`;
        }
      }
      continue;
    }
    const selfClosing = source.endsWith('/');
    const header = selfClosing ? source.slice(0, -1) : source;
    const nameMatch = /^[^\s/>]+/.exec(header);
    if (!nameMatch) continue;
    const tag = nameMatch[0].toLowerCase();
    const dropped = insideDropped() || DROP_CONTENT_TAGS.has(tag);
    if (DROP_CONTENT_TAGS.has(tag)) {
      // 入栈（标记为已丢弃），这样配对的闭合标签能找到它并结束丢弃状态。
      if (!selfClosing && !VOID_TAGS.has(tag)) stack.push({ tag, dropped: true });
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (dropped) {
      // 在被丢弃的子树里（典型情形：上游剪枝后留下的**没有配对闭合标签**的
      // `<svg>` / `<style>`）：照常入栈以维持结构配对，但**一个字符都不写出去**。
      //
      // ★ 以前这里只对**文本**做了丢弃判断，开标签是照写的 —— 于是被丢弃子树里的
      //   `<div>` 会泄漏到输出里。实测 The Rundown AI：`</svg>` 被上游删掉后永久
      //   处于丢弃状态，正文里第一个 `<div>` 泄漏出来，`sanitizeHtml` 的产物
      //   就是 `<a href="…twitter…"><div></a>` 这 216 个字符。
      //   `DROP_CONTENT_TAGS` 的语义是「整棵子树丢掉」，就不该有任何标签泄漏。
      if (!selfClosing && !VOID_TAGS.has(tag)) stack.push({ tag, dropped: true });
      continue;
    }
    const attrs = parseAttrs(header.slice(nameMatch[0].length));
    const rendered = [];
    for (const [key, value] of Object.entries(attrs)) {
      // 事件处理器与内联样式一律丢弃。`class` 不在这里点名：它既不在
      // SAFE_URL_ATTRS 也不在下面的属性白名单里，本来就会被丢掉。
      if (key.startsWith('on') || key === 'style') continue;
      if (!SAFE_URL_ATTRS.has(key)) {
        if (key === 'alt' || key === 'title' || key === 'colspan' || key === 'rowspan' || key === 'datetime') {
          rendered.push(`${key}="${escapeAttr(value.slice(0, 300))}"`);
        }
        continue;
      }
      const url = safeUrl(decodeHtmlEntities(value), baseUrl);
      if (url !== undefined) rendered.push(`${key}="${escapeAttr(url)}"`);
    }
    const attrText = rendered.length > 0 ? ` ${rendered.join(' ')}` : '';
    if (tag === 'img') {
      out += `<img${attrText} loading="lazy">`;
      continue;
    }
    if (VOID_TAGS.has(tag)) {
      out += `<${tag}>`;
      continue;
    }
    out += `<${tag}${attrText}>`;
    if (!selfClosing) stack.push({ tag, dropped });
  }
  // 只补上真正输出过的开标签的闭合标签。
  while (stack.length > 0) {
    const closing = stack.pop();
    if (!closing.dropped) out += `</${closing.tag}>`;
  }
  return out.slice(0, maxLength);
}

function findTagEnd(source, from) {
  let quote = '';
  for (let i = from + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

const ATTR = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')?/g;

function parseAttrs(header) {
  const attrs = {};
  ATTR.lastIndex = 0;
  let match;
  while ((match = ATTR.exec(header)) !== null) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? '';
  }
  return attrs;
}

/** Extract the first safe <img> source from an HTML fragment. */
export function firstImageUrl(html, baseUrl) {
  const img = /<img\s[^>]*src\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html);
  if (!img) return undefined;
  const raw = img[2] ?? img[3] ?? '';
  return safeUrl(decodeHtmlEntities(raw), baseUrl);
}

/** 代码围栏写成常量：三个反引号在正则和字符串里都容易被误读。 */
const FENCE = '```';

/**
 * 块级标签：在纯文本里必须换**空行**，不能只换行。
 *
 * ★ 2026-10-12 修的就是这一条。以前所有块级标签统一压成单个 \n，于是
 *   `<p>a</p><p>b</p>` 产出 "a\nb"。而在 Markdown 语义里，单换行属于
 *   **同一段** —— 把这段文本交给模型翻译时，模型无从知道原文哪里分段，
 *   只能自己猜。实测用户那篇 SageMaker 文章：原文十来个短段被吐成一个
 *   1165 字的巨段，用户报「翻译后排版全变了」。
 *
 * 不含 `li`：列表项之间要的是单换行（空行会把列表断开），单独用「- 」前缀处理。
 */
const BLOCK_TAGS = 'p|div|section|article|blockquote|figure|figcaption|tr|dd|dt'
  + '|ul|ol|table|thead|tbody|tfoot|details|summary';

/**
 * Reduce sanitized HTML to plain text with paragraph structure.
 * @param {string} html - already-sanitized markup.
 * @param {number} [maxLength] - output cap.
 * @param {{keepImages?: boolean, links?: string[]}} [options]
 *   - `keepImages` 把每张 `<img>` 转成一行 Markdown 图片（`![alt](src)`），而不是剥掉。
 *     喂给模型的正文需要它：模型看不见图，就不可能在译文里保留图
 *     （2026-10-09 用户报「翻译后图片没了」的根因）。
 *   - `links` **传数组即启用**：每遇到一个 `<a href>` 就往数组里 push 一条 URL，
 *     正文里写成 `[文字]({{L3}})` 这样的**占位符**。为什么不让模型直接抄 URL：
 *     实测它会把 `q_auto:good` 抄成 `q_2A` —— 一个字符之差，前者 HTTP 200、
 *     后者 404。占位符让 URL 完全不经过模型，生成之后由 `restoreLinks` 换回来。
 */
export function htmlToText(html, maxLength = 20_000, { keepImages = false, links } = {}) {
  /**
   * `<pre>` 的正文。必须在下面对「剥标签 + 压缩空白」之前先摘出来：
   * 代码的缩进和换行就是它全部的意义，走过那两步只剩一行没缩进的文字
   * （实测原文 17 个 `<pre>`，译文里 0 个围栏、Python 缩进全丢）。
   */
  const codes = [];
  let body = String(html ?? '')
    // 先摘 script/style 整棵子树（img 不会出现在这两者里，顺序只是少做无用功）。
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
      // 代码里的实体要还原：sanitizeHtml 写回的 `&amp;` / `&lt;` 在源码里本来就是
      // `&` / `<`，不还原的话它们会原样进译文（模型只会照抄）。
      codes.push(decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, ''));
      return `\u0000pre${codes.length - 1}\u0000`;
    });
  if (keepImages) {
    // alt 与 src 都要**先解码实体**：sanitizeHtml 写回的是转义后的属性值，
    // `&amp;` 原样进 URL 图片就打不开。URL 里的空格 / 右括号会破坏 Markdown 语法，
    // 顺手转成百分号编码 —— 浏览器取图时两者等价。
    body = body.replace(/<img\s[^>]*>/gi, (tag) => {
      const src = decodeHtmlEntities(/src\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '').trim()
        .replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
      if (src === '') return '\n\n';
      const alt = decodeHtmlEntities(/alt\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '').replace(/[[\]]/g, '');
      // ★ 图片行前后各留一个空行，让它成为**独立段落**。与文字挤在同一段时
      //   （以前是 `前\n![图](url)\n后`），模型会把它当成正文的一部分顺手处理掉 ——
      //   实测 4 篇译文里模型整批丢图，兜底只能把它们全堆到文末。
      return `\n\n![${alt}](${src})\n\n`;
    });
  }
  if (Array.isArray(links)) {
    // 必须排在 `<img>` 之后：Substack 的图片链接是 `<a href><div><img></div></a>`，
    // 那时里面已经是一个 `![alt](src)` 了，包一层就得到 `[![alt](src)]({{L5}})`。
    body = body.replace(
      /<a\s[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]{0,2000}?)<\/a>/gi,
      (_, href, inner) => {
        const url = decodeHtmlEntities(href).trim();
        // 链接里可能包着块级元素，先压成一行 —— 否则换行会跑进 Markdown 的 `[ ]` 里。
        const label = inner
          .replace(/<\/?(?:div|p|span|section|figure|figcaption)[^>]*>/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (url === '' || label === '') return label;
        links.push(url);
        return `[${label}]({{L${links.length - 1}}})`;
      },
    );
  }
  const flat = body
    .replace(/<h([1-6])[^>]*>/gi, (_, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    // ★ 行内格式：不转成 Markdown 标记，它们会在下面「剥标签」那一步**无声消失**。
    //   真机全库实测 493 个 `<strong>` / 59 个 `<em>` / 123 个 `<code>` 一个都没
    //   进过译文，用户看到的就是「原文有加粗、有橙色链接，译文全是纯文本」。
    //   这些都是 Markdown 原生语法，模型照抄的负担很小。
    // ★ 标签名后面必须是 `>` 或空白，不能是 `[^>]*` 直接跟 —— 那样 `b` 会匹配到
    //   `<br>`、`i` 会匹配到 `<img>`，于是换行变成 `**`、图片变成 `*`。
    .replace(/<\/?(?:strong|b)(?:\s[^>]*)?>/gi, '**')
    .replace(/<\/?(?:em|i)(?:\s[^>]*)?>/gi, '*')
    .replace(/<\/?(?:del|s)(?:\s[^>]*)?>/gi, '~~')
    .replace(/<\/?code(?:\s[^>]*)?>/gi, '`')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})[^>]*>`, 'gi'), '\n\n')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n\n---\n\n')
    .replace(/<[^>]+>/g, ' ');
  // ★ 实体解码必须**排在剥标签之后**。反过来的话，正文里本来只是文字的
  //   `&lt;script&gt;` 会先变成真标签、再被上一行剥掉，那一段内容凭空消失。
  //   （`<pre>` 分支自带解码，走的是同一条规矩：先剥标签，再解码。）
  const text = decodeHtmlEntities(flat)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // ★ 列表：块级标签在 `<li>` 内部各给一个空行，于是「- 」和正文被劈开
    //   （`<li><p>x</p></li>` → `-` / 空行 / `x`）。Markdown 里那是一个**空列表项**
    //   加一个普通段落 —— 实测用户那篇 newsletter 36 个列表项 36 个都这样，
    //   界面上就是孤零零一个「-」，条目之间还被空行撑开。
    //   ① 把标记和它下面那段合回一行（负向断言：下一行自己也是列表项时不合，
    //      那是「空列表项 + 下一项」，合了会变成嵌套标记 `- - a`）；
    //   ② 相邻列表项之间的空行去掉，还原紧凑列表。
    .replace(/\n-[ \t]*\n+(?!- )/g, '\n- ')
    .replace(/(^|\n)(- [^\n]*)\n\n(?=- )/gm, '$1$2\n')
    .trim();
  // 代码块插回：内容原样（含缩进），外面包 Markdown 围栏。
  // ★ 必须在上面那两条列表规则**之后**：代码块里一行孤零零的 `-` 会被它们吃掉。
  const withCode = text
    .replace(/\u0000pre(\d+)\u0000/g, (_, index) => `\n\n${FENCE}\n${codes[Number(index)]}\n${FENCE}\n\n`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return withCode.length > maxLength ? `${withCode.slice(0, maxLength)}…` : withCode;
}

/**
 * 把 `htmlToText({ links })` 写进正文的 `{{L3}}` 占位符换回真 URL。
 *
 * ★ 宽容两件事：模型在花括号里加了空格，或者用了全角括号（它「顺手美化」过）。
 *   这两处都不影响识别，没必要因此丢掉一个链接。
 */
export function restoreLinks(markdown, links) {
  if (!Array.isArray(links) || links.length === 0) return String(markdown ?? '');
  return String(markdown ?? '').replace(
    /[{｛]{2}\s*[Ll]\s*(\d+)\s*[}｝]{2}/g,
    (whole, index) => links[Number(index)] ?? whole,
  );
}
