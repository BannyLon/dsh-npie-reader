/**
 * 原文正文抽取：从一整页 HTML 里挑出「正文容器」，返回它的 inner HTML。
 *
 * 为什么自己写：插件不能引第三方包（Host 半区必须零外部依赖），而 feed 里只有
 * 摘要时又必须去原文页取全文 —— 这两条同时成立，就只能自己做一遍简化版
 * readability。
 *
 * 策略（先简后繁，能命中就早退）：
 *   1. 先删噪声子树（script / style / nav / header / footer / aside / form …）；
 *   2. 若存在 `<article>` / `<main>` / `role="main"` / `itemprop="articleBody"`，
 *      且它的正文占比够大，直接采用其中最大者 —— 现代博客基本都命中这一条；
 *   3. 否则按「段落打分 + 向上传播」挑容器：给每个 `<p>` / `<pre>` / `<blockquote>`
 *      / `<li>` 计分，按 1 / 0.6 / 0.3 传给最近三层祖先，再用**链接密度**扣分
 *      （导航栏、相关阅读、页脚链接多、正文少），最后向上收敛到不引入大量额外
 *      文本的那一层。
 *
 * 返回 `null` 表示「没找到可信的正文容器」，调用方应退回 feed 自带的正文，
 * 而不是拿一页导航当文章渲染。
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** 整棵子树一律丢弃。故意不含 `figure` / `picture` / `video`：正文配图要留下。 */
const NOISE_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'form', 'nav', 'header', 'footer', 'aside', 'template', 'button', 'select', 'textarea', 'canvas']);

const PARAGRAPH_TAGS = new Set(['p', 'pre', 'blockquote', 'li', 'td', 'dd']);

export const TAG_RE = /<!--[\s\S]*?-->|<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/g;

/** 单个段落至少这么多字才算「正文候选」，否则多半是按钮、标签、日期。 */
const MIN_PARAGRAPH_CHARS = 25;
/** 正文容器至少要这么多字，低于这个数就认定抽取失败。 */
const MIN_BODY_CHARS = 200;
/** `<article>` / `<main>` 要占到全页这么多文本才允许直接采用。 */
const DIRECT_TAG_SHARE = 0.25;
/** 打分法的兜底门槛。 */
const MIN_SCORE = 120;

/**
 * 「文本块收敛」兜底用的两道闸门。
 *
 * ★ 为什么需要它：Next.js / Tailwind 一类站点**整页一个 `<p>` 都没有**（实测
 *   TLDR AI：`p:0` `li:0`，正文全在 `<div>` 里），而打分法的**种子**只认
 *   `p/pre/blockquote/li/td/dd` ⇒ 种子集为空 ⇒ 语义直取与打分法双双落空 ⇒
 *   返回 null ⇒ 界面上是「这个版本还没有内容」。
 *
 * ★ 链接密度闸门不能省：没有它，一个「全是链接」的页面（导航页）也会被当成
 *   正文块选中 —— 而那条反向对照用例本来就要求这种页面返回 null。
 */
const MAX_BLOCK_LINK_DENSITY = 0.25;
/** 向下收敛的比例，与向上收敛的 `ownText * 1.35` 是同一个常数（互为镜像）。 */
const CONTAIN_RATIO = 1.35;

/**
 * 极简 HTML 元素树扫描器：只记录**位置**与**父子关系**，不做任何内容解释。
 *
 * ★ 被 `structure-translate.js` 复用（保结构翻译要知道每个文本节点落在哪个块里）。
 *   导出它而不是让那边再写一份：同一个扫描器写两遍，两边的「标签边界」判据
 *   一旦漂移，就会出现「这边认为在 `<a>` 里、那边认为在外面」这种查不出来的错位。
 */
export function parseTree(html) {
  const elements = [];
  const stack = [];
  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(html)) !== null) {
    if (match[1] !== undefined) {
      const tag = match[1].toLowerCase();
      const attrs = match[2] ?? '';
      const parent = stack.length ? stack[stack.length - 1].index : -1;
      const element = {
        tag,
        attrs,
        parent,
        depth: stack.length,
        index: elements.length,
        /**
         * ★ 开标签 `<` 的**真实**位置。`stripNoise` 必须从这里开始删。
         *
         * 以前 `stripNoise` 用 `start - (tag.length + 2)` 反推，那等于假设开标签
         * 写成 `<tag>`（**不带属性**）。真机上 `<nav class="text-xs text-mute">`
         * 的属性比标签名长得多，反推出来的起点落在**属性值内部**，删完还剩半截
         * `<nav class="text-xs text-m` —— 一个引号不平衡、`>` 已被删掉的开标签。
         * 它在下游 `sanitizeHtml` 里被 `findTagEnd` 的引号跟踪吞掉一大段
         * （实测 The Rundown AI：吞掉 931 字符；正文容器 72704 → 216 字符 →
         * 纯文本 0 字符，`hydrateBody` 判定「不比订阅源更多」⇒ 界面只剩摘要）。
         * ⇒ 位置只能**记下来**，不能从结尾反推。
         */
        openStart: match.index,
        start: TAG_RE.lastIndex,
        end: html.length,
        outerEnd: html.length,
      };
      elements.push(element);
      const selfClosing = /\/\s*$/.test(attrs) || VOID_TAGS.has(tag);
      if (selfClosing) {
        element.end = element.start;
        // 自闭合元素没有配对闭合标签，`outerEnd` 必须停在开标签末尾 ——
        // 留成 `html.length` 会让 `stripNoise` 把它**之后的全页**一起删掉。
        element.outerEnd = element.start;
      } else {
        stack.push({ tag, index: element.index });
      }
    } else if (match[3] !== undefined) {
      const tag = match[3].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          const element = elements[stack[i].index];
          element.end = match.index;
          element.outerEnd = TAG_RE.lastIndex;
          stack.length = i;
          break;
        }
      }
    }
  }
  return elements;
}

/** 把噪声子树与注释从整页 HTML 里剪掉，偏移量随之变化 ⇒ 剪完要重新 parse 一次。 */
function stripNoise(html) {
  const ranges = [];
  for (const element of parseTree(html)) {
    // ★ 起点必须用 `openStart`（开标签 `<` 的真实位置）。见 `parseTree` 里的长注释：
    //   从 `start` 反推会在带属性的噪声标签上留下半截开标签，那半截标签会让
    //   下游 sanitize 吞掉整篇正文。
    if (NOISE_TAGS.has(element.tag)) ranges.push([element.openStart, element.outerEnd]);
  }
  for (const match of html.matchAll(/<!--[\s\S]*?-->/g)) ranges.push([match.index, match.index + match[0].length]);
  if (ranges.length === 0) return html;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    out += html.slice(cursor, Math.max(cursor, start));
    cursor = Math.max(cursor, end);
  }
  return out + html.slice(cursor);
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;/gi, ' ');
}

/** 一段 HTML 的可见文本长度，以及其中落在 `<a>` 里的长度（链接密度用）。 */
function measure(fragment) {
  const text = decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  let linkLength = 0;
  for (const match of fragment.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    linkLength += decodeEntities(match[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().length;
  }
  return { length: text.length, linkLength };
}

function attrsOf(element) {
  return element.attrs.toLowerCase();
}

/**
 * 最后一道兜底：**整页没有任何 `<p>`** 时按「文本块」收敛。
 *
 * 思路是打分法向上收敛的镜像：先取「文本最多、且链接密度可接受」的那一层
 * （通常就是 `<html>`），再**向下**走 —— 只要某个子元素仍然握着父层
 * `1 / CONTAIN_RATIO` 以上的文本，它就只是把正文包起来的一层壳，可以往下走。
 * 一旦最大的子元素握不住（说明父层真的装了别的东西：侧栏、相关阅读、页脚），
 * 就停在当前层。
 *
 * ★ 为什么不用「占比 ≥25% 的最内层」那种写法：它依赖 25% 这条硬线，实测
 *   TLDR AI 的正文容器占全页 99.3%、而它内部最大的 `<section>` 占 24.4% ——
 *   差 0.6 个百分点就会多钻一层、只拿到一节。向下收敛的判据是「握得住握不住」，
 *   离阈值远得多，稳。
 *
 * @returns {{html: string, strategy: 'text', textLength: number}|null}
 */
function pickTextBlock(clean, elements, measureAt) {
  const acceptable = (element) => {
    const own = measureAt(element);
    if (own.length < MIN_BODY_CHARS) return undefined;
    return own.linkLength / own.length > MAX_BLOCK_LINK_DENSITY ? undefined : own;
  };

  let node;
  let nodeText;
  for (const element of elements) {
    if (element.end <= element.start) continue;
    const own = acceptable(element);
    if (own === undefined) continue;
    if (node === undefined || own.length > nodeText.length) { node = element; nodeText = own; }
  }
  if (node === undefined) return null;

  for (let hops = 0; hops < 20; hops += 1) {
    let next;
    let nextText;
    for (const element of elements) {
      if (element.parent !== node.index) continue;
      const own = acceptable(element);
      if (own === undefined) continue;
      // 子层握不住父层文本 ⇒ 父层不是纯壳，停在这里。
      if (own.length * CONTAIN_RATIO < nodeText.length) continue;
      if (next === undefined || own.length > nextText.length) { next = element; nextText = own; }
    }
    if (next === undefined) break;
    node = next;
    nodeText = nextText;
  }
  if (nodeText.length < MIN_BODY_CHARS) return null;
  return { html: clean.slice(node.start, node.end), strategy: 'text', textLength: nodeText.length };
}

/**
 * @param {string} rawHtml - 原文页的整页 HTML。
 * @returns {{html: string, strategy: 'article'|'main'|'role'|'score'|'text', textLength: number}|null}
 */
export function extractMainHtml(rawHtml) {
  const html = String(rawHtml ?? '');
  if (html.length < MIN_BODY_CHARS) return null;
  const clean = stripNoise(html);
  if (clean.length < MIN_BODY_CHARS) return null;
  const elements = parseTree(clean);
  const measureOf = (element) => measure(clean.slice(element.start, element.end));
  const page = measure(clean);
  if (page.length < MIN_BODY_CHARS) return null;

  // ---- 第一优先：语义标签 -------------------------------------------------
  let direct = null;
  for (const element of elements) {
    if (element.end <= element.start) continue;
    const attrs = attrsOf(element);
    const strategy = element.tag === 'article' ? 'article'
      : element.tag === 'main' ? 'main'
        : /role\s*=\s*["']?main\b/.test(attrs) || /itemprop\s*=\s*["']?articlebody\b/.test(attrs) ? 'role'
          : null;
    if (!strategy) continue;
    const { length } = measureOf(element);
    if (length < MIN_BODY_CHARS || length < page.length * DIRECT_TAG_SHARE) continue;
    if (!direct || length > direct.length) direct = { element, strategy, length };
  }
  if (direct) return { html: clean.slice(direct.element.start, direct.element.end), strategy: direct.strategy, textLength: direct.length };

  // ---- 兜底：段落打分 + 向上传播 ------------------------------------------
  const scores = new Map();
  const measured = new Map();
  const measureAt = (element) => {
    if (!measured.has(element.index)) measured.set(element.index, measureOf(element));
    return measured.get(element.index);
  };
  for (const element of elements) {
    if (!PARAGRAPH_TAGS.has(element.tag)) continue;
    const own = measureAt(element);
    if (own.length < MIN_PARAGRAPH_CHARS) continue;
    const bonus = element.tag === 'pre' ? 30 : 0;
    let node = element;
    for (let level = 0; level < 3 && node; level += 1) {
      const weight = level === 0 ? 1 : level === 1 ? 0.6 : 0.3;
      scores.set(node.index, (scores.get(node.index) ?? 0) + (own.length + bonus) * weight);
      node = node.parent >= 0 ? elements[node.parent] : undefined;
    }
  }
  let best;
  let bestScore = 0;
  for (const [index, score] of scores) {
    const element = elements[index];
    const own = measureAt(element);
    if (own.length === 0) continue;
    const density = Math.min(1, own.linkLength / own.length);
    const tagBonus = element.tag === 'article' ? 220 : element.tag === 'main' ? 180 : element.tag === 'section' ? 40 : 0;
    // 链接密度是平方惩罚：一半是链接的容器，得分直接掉到 1/4。
    const total = score * (1 - density) ** 2 + tagBonus;
    if (total > bestScore) { bestScore = total; best = element; }
  }
  // 两条路都落空时再走「文本块收敛」—— 严格兜底：上面任何一条命中都不会到这里，
  // 所以对现在能正常抽取的站点**零影响**（这也是它敢放宽判据的前提）。
  if (!best || bestScore < MIN_SCORE) return pickTextBlock(clean, elements, measureAt);

  // 向上收敛：父层如果只是把正文包起来（文本量没有暴涨），就用父层，避免只拿到
  // 一个孤零零的 <p>。一旦父层引入大量额外文本（侧栏、相关阅读），就停在当前层。
  let node = best;
  for (let hops = 0; hops < 4; hops += 1) {
    if (node.parent < 0) break;
    const parent = elements[node.parent];
    const parentScore = scores.get(parent.index) ?? 0;
    const ownScore = scores.get(node.index) ?? 0;
    const parentText = measureAt(parent).length;
    const ownText = measureAt(node).length;
    if (parentScore < ownScore * 0.85) break;
    if (parentText > ownText * 1.35) break;
    node = parent;
  }
  const chosen = measureAt(node);
  if (chosen.length < MIN_BODY_CHARS) return null;
  return { html: clean.slice(node.start, node.end), strategy: 'score', textLength: chosen.length };
}

export const FULLTEXT_LIMITS = { minBodyChars: MIN_BODY_CHARS, minParagraphChars: MIN_PARAGRAPH_CHARS, minScore: MIN_SCORE };
