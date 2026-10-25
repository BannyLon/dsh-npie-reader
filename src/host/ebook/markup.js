/**
 * XHTML / HTML → **块模型**（本书的正文中间表示）。
 *
 * ★ 为什么不用 `dangerouslySetInnerHTML` 把原样 HTML 交给渲染端：
 *   电子书是**外部文件**，里面可以有任何东西（`<script>`、外链图片、`onerror`）。
 *   一旦原样注入，插件的安全边界就等于「用户下载的那本书的作者」。块模型只保留
 *   「这是标题 / 这是段落 / 这是引用」这一层语义，渲染端用 React 元素重建 ——
 *   XSS 面为零，代价是丢掉了粗体、字号、缩进这些**排版**信息。
 *
 *   这个取舍是刻意的：EPUB 本来就是「可重排」格式，它的原版式是**读者设备决定的**，
 *   不存在「原版式」可还原；而 MOBI/AZW3 的排版信息本来就被 Kindle 自己重排。
 *
 * ★ 为什么标题要靠 `class` 猜：calibre 生成的 EPUB（用户书架上 15 本里的绝大多数）
 *   把章节标题写成 `<p class="title1">`，**没有** `<h1>`。只认标签的话，整本书
 *   会被切成一个巨大的段落块，目录能用、正文却没有层级。
 */
/** 单个块的最大字符数。超长的「一段」几乎一定是标签没闭合，切开比整块塞给模型好。 */
export const MAX_BLOCK_CHARS = 12_000;

/** 一本书最多保留多少个块（防构造过的 HTML 撑爆内存）。 */
export const MAX_BLOCKS = 60_000;

/**
 * 硬换行（`<br>`）在内部的哨兵。
 *
 * ★ 不能直接往 buffer 里塞 `\n`：源 HTML 自己的折行也是 `\n`，而这两者的语义
 *   **相反** —— `<br>` 是作者写的换行（中文小说「一句一行」全靠它，必须切成
 *   两段），源折行是排版产物（要删掉）。同一个字符表示两件事，就只能二错其一。
 * ★ 用 NUL：XML 1.0 里它是非法字符，源文件里不可能出现；而 `normalizeWhitespace`
 *   那组空白字符里也没有它，所以它能一路安全地到达 `flush()`。
 */
const HARD_BREAK = '\u0000';

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'blockquote', 'li', 'ul', 'ol', 'dl', 'dd', 'dt',
  'pre', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'figure', 'figcaption', 'center',
  'body', 'html', 'address', 'aside', 'header', 'footer', 'main', 'nav',
]);

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** 内容整体跳过的标签（脚本、样式、以及不承载正文的容器）。 */
const SKIP_TAGS = new Set(['script', 'style', 'head', 'svg', 'math', 'template', 'noscript', 'iframe', 'object']);

/** 这些标签里的空白有意义（代码块、诗歌的缩进）。 */
const PRE_TAGS = new Set(['pre']);

/** 命名实体：只收书里真正常见的一批。其余交给数字实体，缺的按字面保留。 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  plusmn: '±', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
};

/** 解码 HTML 实体（命名 + 十进制 + 十六进制）。 */
export function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return String(text ?? '');
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
      // 代理区码位不是合法字符，替换成 U+FFFD 会被用户当成乱码 —— 直接原样留着。
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

/**
 * 空白归一化。
 *
 * ★ 两件事必须分开处理，否则必然有一头是错的：
 *
 *   ① **源 HTML 的折行不是空格**。EPUB 的 XHTML 是排版过的，`<p>` 里每行折行；
 *      把 `\n` 一律换成空格，一句中文就会被切成「推荐序二 在 工作中 体会」——
 *      用户看得到，模型也会把断点当成词边界。所以「两侧都是 CJK/全角」的换行
 *      **直接删掉**。
 *   ② **真的空格要留着**。章节标题「第一章 起点」里那个空格是作者写的，
 *      按 ① 的粗暴规则（CJK 之间见一个空格就删）会变成「第一章起点」——
 *      这一版之前就是这么错的，目录和正文标题一起错。
 *
 *   所以判据是「**是不是换行**」而不是「是不是空格」：`\n` 按 ① 处理，
 *   `0x20` 原样保留（HTML 里它本来就会被渲染成一个空格）。
 */
export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/([\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f])[ \t]*\n[ \t]*(?=[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f])/g, '$1')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[ \t\r\n\f\v]+/g, ' ')
    .trim();
}

/** 从 `class` / `style` 里判断这是不是标题，以及是第几级。 */
function headingLevelOf(tagName, attrs) {
  if (HEADING_TAGS.has(tagName)) return Number(tagName[1]);
  const cls = String(attrs.class ?? '');
  if (cls === '') return 0;
  // calibre：title1 / title2 …；其它常见：chapter-title / heading / h2 / subtitle
  const title = /(?:^|[\s_-])title([1-6])?(?:$|[\s_-])/i.exec(cls);
  if (title !== null) {
    const level = Number(title[1] ?? '1');
    // title1 是「章」，映射到 h2：正文里再有一个 h1 才不会同级打架。
    return Math.min(3, level + 1);
  }
  if (/(?:^|[\s_-])(?:chapter|heading|headline)(?:$|[\s_-])/i.test(cls)) return 2;
  if (/(?:^|[\s_-])subtitle(?:$|[\s_-])/i.test(cls)) return 3;
  return 0;
}

/** 解析一个开始标签的标签名与属性（只取 class / href / id）。 */
function parseTag(source) {
  const name = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(source);
  const tagName = name === null ? '' : name[1].toLowerCase();
  const attrs = {};
  for (const match of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const key = match[1].toLowerCase();
    if (key !== 'class' && key !== 'href' && key !== 'id') continue;
    attrs[key] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return { tagName, attrs, closing: /^<\s*\//.test(source), selfClosing: /\/\s*>$/.test(source) };
}

/**
 * HTML → `{ blocks, stats }`。
 *
 * 块形状：`{ k, x }`
 *   `k` = `'h1'|'h2'|'h3'|'p'|'q'|'li'|'pre'`
 *   `x` = 纯文本（可能含 `\n`，只有 `pre` 会保留缩进）
 *
 * @param html - 源 HTML（XHTML 也走这里 —— 两者在本函数关心的子集上一致）。
 * @param options.maxBlocks - 块数上限。
 */
export function htmlToBlocks(html, { maxBlocks = MAX_BLOCKS } = {}) {
  const source = String(html ?? '');
  const blocks = [];
  let buffer = '';
  let kind = 'p';
  let quoteDepth = 0;
  let preDepth = 0;
  let skipDepth = 0;
  let skipName = '';
  let dropped = 0;

  const flush = () => {
    const raw = buffer;
    buffer = '';
    if (raw === '') return;
    const emit = (outKind, text) => {
      if (text === '') return;
      if (blocks.length >= maxBlocks) { dropped += 1; return; }
      // 超长的「一段」几乎一定是标签没闭合，切开比整块塞给解释模型好。
      const chunks = text.length > MAX_BLOCK_CHARS
        ? text.match(new RegExp(`[\\s\\S]{1,${MAX_BLOCK_CHARS}}`, 'g')) ?? [text]
        : [text];
      for (const chunk of chunks) blocks.push({ k: outKind, x: chunk });
    };

    /* `pre` 里的空白与换行都有意义：只做尾部去空格与首尾空行，一个字都不折。 */
    if (preDepth > 0) {
      emit('pre', raw
        .replace(/\r\n?/g, '\n')
        .split(HARD_BREAK).join('\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/^\n+|\n+$/g, ''));
      return;
    }

    const outKind = quoteDepth > 0 && kind === 'p' ? 'q' : kind;
    /**
     * ★ 按**硬换行**切成多段，而不是归一化之后再 split('\n')。
     *   `normalizeWhitespace` 会把剩下的换行全部折成空格（那正是它该做的），
     *   所以「先归一化再按 \n 切」这条路切不出任何东西 —— 一句一行的小说
     *   会被拼成一整个长段落。这里先切、后归一化，两件事才互不干扰。
     */
    for (const piece of raw.split(HARD_BREAK)) emit(outKind, normalizeWhitespace(piece));
  };

  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?\s*[a-zA-Z][^>]*>|[^<]+/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const token = match[0];
    /**
     * ★ `<?xml … ?>` 必须一起跳掉。它的第一个字符是 `<`、第二个是 `?`，不匹配下面的
     *   标签规则，于是会被当成**正文**留在第一段里 —— 实测每本 EPUB 的第一节开头都是
     *   「?xml version='1.0' encoding='utf-8'?」，用户点开书先看到一行代码。
     */
    if (token.startsWith('<!--') || token.startsWith('<!') || token.startsWith('<?')) continue;
    if (!token.startsWith('<')) {
      if (skipDepth === 0) buffer += decodeEntities(token);
      continue;
    }
    const { tagName, attrs, closing, selfClosing } = parseTag(token);
    if (tagName === '') continue;

    if (SKIP_TAGS.has(tagName)) {
      if (closing) {
        if (skipDepth > 0 && skipName === tagName) { skipDepth = 0; skipName = ''; }
      } else if (!selfClosing) {
        skipDepth += 1;
        skipName = tagName;
      }
      continue;
    }
    if (skipDepth > 0) continue;

    if (tagName === 'br') { buffer += HARD_BREAK; continue; }
    if (tagName === 'hr') { flush(); continue; }

    if (PRE_TAGS.has(tagName)) {
      flush();
      if (closing) preDepth = Math.max(0, preDepth - 1);
      else if (!selfClosing) preDepth += 1;
      continue;
    }
    if (tagName === 'blockquote') {
      flush();
      if (closing) quoteDepth = Math.max(0, quoteDepth - 1);
      else if (!selfClosing) quoteDepth += 1;
      continue;
    }
    if (tagName === 'li') { flush(); kind = 'li'; if (closing) kind = 'p'; continue; }

    const level = headingLevelOf(tagName, attrs);
    if (level > 0) {
      flush();
      kind = `h${level}`;
      if (closing) kind = 'p';
      continue;
    }

    if (BLOCK_TAGS.has(tagName)) {
      flush();
      // 表格单元格之间留一个空格，否则「张三|92」会粘成「张三92」。
      if (tagName === 'td' || tagName === 'th') buffer = '';
      if (!closing && !selfClosing && kind !== 'p') kind = 'p';
      continue;
    }
    // 其余（a / span / em / strong / sup / small / i / b …）都是行内：只留文字。
  }
  flush();

  return { blocks, stats: { blocks: blocks.length, dropped } };
}

/** 块 → 行数组（分段算法、解读链吃的就是它）。 */
export function blocksToLines(blocks) {
  const out = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    for (const line of String(block?.x ?? '').split('\n')) {
      const text = line.trim();
      if (text !== '') out.push(text);
    }
  }
  return out;
}

/** 第一个标题块的内容（给「这一节没有目录条目」时兜一个名字）。 */
export function titleFromBlocks(blocks) {
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (/^h[1-6]$/.test(String(block?.k ?? ''))) {
      const text = normalizeWhitespace(block?.x ?? '');
      if (text !== '' && text.length <= 60) return text;
    }
  }
  return '';
}

/**
 * 一段纯文本 → 块（TXT 用）。
 *
 * ★ `pre` 不用 normanizeWhitespace 的删空格规则：TXT 里的缩进（全角空格缩进两格）
 *   是**唯一的段落标记**，删掉之后整章会变成一个没有段落的大块。
 */
export function textToBlocks(text, { headingLevel = 0 } = {}) {
  const blocks = [];
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/[\t ]+$/, '');
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (headingLevel > 0 && blocks.length === 0) {
      blocks.push({ k: `h${headingLevel}`, x: normalizeWhitespace(trimmed) });
      continue;
    }
    blocks.push({ k: 'p', x: trimmed });
  }
  return blocks;
}

/** 段落块里的换行已按 `\n` 切开，所以这里不再做第二次拆分。 */
