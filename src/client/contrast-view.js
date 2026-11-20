/**
 * 双语对照：把「原文」与「保结构译文」**逐段交错**成一份可以直接渲染的 HTML。
 *
 * ★ 为什么这件事可以做到「不需要任何对齐算法」
 * ------------------------------------------
 * 保结构翻译（`src/host/structure-translate.js`）只换文本节点，**标签一个都不动**。
 * 于是存下来的 `versions.translation.html` 与原文**块级完全同构**：
 * 第 N 个 `<p>` 对第 N 个 `<p>`，第 N 个 `<li>` 对第 N 个 `<li>`。
 * 这里做的事因此只是「按同一个下标，把译文的那个块搬到原文块后面」。
 *
 * ★ 三条硬纪律
 * ------------
 *   ① **对不上就不对齐**：标签序列 / 父子关系 / 深度任一不一致 ⇒ 整篇退回
 *      「上原文、下译文」（`mode: 'stacked'`）。绝不按「看起来差不多」的位置硬塞 ——
 *      塞错位置的译文比没译文难发现得多（`structure-translate.js` 里同一条底线）。
 *   ② **一个项目符号只留一个**：`<li>` / `<td>` / `<th>` 是**容器**，译文插在
 *      元素内部（`<div class="npr-ct-zh">`），不复制 `<li>` 本身 ——
 *      否则有序列表会变成 1,2,3,4，用户数不清原文有几条。
 *   ③ **图片与代码不复制**：复制的译文块里把 `img/picture/video/...` 全部摘掉
 *      （否则同一张图出现两遍），`pre/code` 整段跳过（代码本来就不翻）。
 *
 * ★ 为什么不用 DOMParser
 * ----------------------
 * 这套判据必须能在 `node --test` 里**真跑**（项目里没有 jsdom，也不该为它加依赖）。
 * `parseTree` 是极简的位置扫描器（`src/host/fulltext.js`，无任何 node 依赖），
 * 同一份扫描器已经被保结构翻译用着 —— 两边不各写一遍，标签边界才不会漂移。
 */

import { parseTree } from '../host/fulltext.js';

/** 译文副本的统一类名（CSS 与测试都认这一个）。 */
export const CONTRAST_CLASS = 'npr-ct-zh';

/**
 * 「对照」这一项读不读得到。
 *
 * ★ 它**没有自己的 `versions.contrast`** —— 数据就是译文那一份。
 *   界面若按 `versions[kind]?.available` 一律判断，对照永远显示「（缺失）」，
 *   于是一个能用的功能被自己的标签判成不可用。这条判据因此单独给出，
 *   下拉的可用性与视图回落都认它。
 */
export function contrastReadable(versions) {
  return versions?.translation?.available === true;
}

/** 可以作为「一个交错单元」的块：它们自己就是一段话，不再往下钻。 */
const UNIT_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'td', 'th', 'dt', 'dd', 'figcaption', 'blockquote', 'caption', 'summary',
]);

/** 这些标签出现，说明它的祖先「还装着别的块」⇒ 祖先不能整体复制。 */
const BLOCKISH = new Set([
  ...UNIT_TAGS,
  'div', 'section', 'article', 'aside', 'main', 'figure', 'header', 'footer',
  'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'pre', 'details',
]);

/** 容器型单元：译文插在**内部**，不复制容器本身（见纪律 ②）。 */
const CONTAINER_UNITS = new Set(['li', 'td', 'th']);

/** 这些子树里的文字不翻，也不需要译文副本。 */
const OPAQUE = new Set(['pre', 'code', 'kbd', 'samp', 'script', 'style', 'textarea']);

/** 成对标签的媒体元素：整棵子树都不要（复制一份就等于重复一张图）。 */
const PAIRED_MEDIA = ['picture', 'video', 'audio', 'iframe', 'svg', 'canvas', 'figure', 'object'];
/** 自闭合 / 空元素的媒体：直接删标签。 */
const VOID_MEDIA_RE = /<(?:img|embed|source|track)\b[^>]*>/gi;

/** 去掉标签与实体后还有没有字 —— 用来判断「这个块值不值得复制一份译文」。 */
function visibleText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[#a-zA-Z0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从译文副本里摘掉媒体元素。
 *
 * ★ 只摘媒体，不摘别的：`<figure>` 里的题注（`figcaption`）如果是独立单元，
 *   它自己会被单独复制，不受这里影响；没被复制说明它本来就没译文。
 */
function stripMedia(html) {
  let out = String(html ?? '');
  for (const tag of PAIRED_MEDIA) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }
  return out.replace(VOID_MEDIA_RE, '');
}

/**
 * 给开标签加上对照类名，并**去掉 id**。
 *
 * ★ 必须去 id：`<h2 id="install">` 复制一份就有了两个同名锚点，
 *   目录跳转与 `getElementById` 会命中第一个（原文那份），
 *   用户点目录后看到的位置与高亮会对不上。
 */
function decorateOpenTag(openTag) {
  const withoutId = String(openTag ?? '').replace(/\sid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
  if (/\sclass\s*=/i.test(withoutId)) {
    return withoutId.replace(
      /(\sclass\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/i,
      (whole, prefix, quoted, doubleQuoted, singleQuoted, bare) => {
        const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
        return `${prefix}"${value ? `${value} ` : ''}${CONTRAST_CLASS}"`;
      },
    );
  }
  // `>` 前补一个 class；自闭合的 `/>` 也照此处理（单元标签里基本不会出现）。
  return withoutId.replace(/\s*(\/?>)\s*$/, ` class="${CONTRAST_CLASS}"$1`);
}

/** 两棵树是否**逐元素同构**（标签、父节点、深度全等）。 */
function sameShape(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].tag !== right[index].tag) return false;
    if (left[index].parent !== right[index].parent) return false;
    if (left[index].depth !== right[index].depth) return false;
  }
  return true;
}

/** 这段文字是不是落在 `pre` / `code` 之类不翻的子树里。 */
function insideOpaque(element, tree) {
  for (let node = element.parent; node >= 0; node = tree[node].parent) {
    if (OPAQUE.has(tree[node].tag)) return true;
  }
  return false;
}

/**
 * 挑出「可以整体复制译文」的单元。
 *
 * 判据：**它自己就是一段话**（`UNIT_TAGS`）、**不含别的块**（否则复制会连带
 * 把子块也复制一遍 → 双重译文）、**不在代码里**、**原文本身有字**。
 */
function pickUnits(html, tree) {
  const hasBlockChild = new Array(tree.length).fill(false);
  for (const element of tree) {
    if (!BLOCKISH.has(element.tag)) continue;
    for (let node = element.parent; node >= 0; node = tree[node].parent) {
      hasBlockChild[node] = true;
    }
  }
  const units = [];
  for (const element of tree) {
    if (!UNIT_TAGS.has(element.tag)) continue;
    if (hasBlockChild[element.index]) continue;
    if (insideOpaque(element, tree)) continue;
    const inner = html.slice(element.start, element.end);
    if (visibleText(inner) === '') continue;
    units.push(element);
  }
  return units;
}

/** 结构对不上时的退路：原文在上、译文在下，中间一条分隔线。 */
function stack(originalHtml, translatedHtml) {
  return `${originalHtml}<hr class="npr-ct-split"><div class="npr-ct-stack">${translatedHtml}</div>`;
}

/**
 * 把原文与译文交错成一份 HTML。
 *
 * @param {{articleHtml?: string, translatedHtml?: string}} [input]
 * @returns {{html: string, mode: 'none'|'stacked'|'interleaved', units: number}}
 *   `mode` 给界面用：`none` = 没有译文（不该走到这里）、`stacked` = 结构对不上
 *   只能整篇上下对照、`interleaved` = 逐段交错成功。`units` 是复制了几个块，
 *   用来在测试里钉住「到底交错了几段」（只看 html 里有类名证明不了数量）。
 */
export function buildContrastHtml({ articleHtml, translatedHtml } = {}) {
  const original = String(articleHtml ?? '');
  const translated = String(translatedHtml ?? '');
  if (original.trim() === '') return { html: '', mode: 'none', units: 0 };
  if (translated.trim() === '') return { html: original, mode: 'none', units: 0 };

  const sourceTree = parseTree(original);
  const translatedTree = parseTree(translated);
  if (!sameShape(sourceTree, translatedTree)) {
    return { html: stack(original, translated), mode: 'stacked', units: 0 };
  }

  const units = pickUnits(original, sourceTree);
  const insertions = [];
  for (const unit of units) {
    const twin = translatedTree[unit.index];
    const innerZh = stripMedia(translated.slice(twin.start, twin.end));
    // 摘掉媒体后一个字都不剩（整段就是一张图）⇒ 这一块不需要译文副本。
    if (visibleText(innerZh) === '') continue;

    if (CONTAINER_UNITS.has(unit.tag)) {
      // 插在容器内部末尾：项目符号 / 单元格只保留一个。
      insertions.push({ at: unit.end, text: `<div class="${CONTRAST_CLASS}">${innerZh}</div>` });
    } else {
      const openTag = decorateOpenTag(translated.slice(twin.openStart, twin.start));
      const closeTag = translated.slice(twin.end, twin.outerEnd);
      insertions.push({ at: unit.outerEnd, text: `${openTag}${innerZh}${closeTag}` });
    }
  }

  // 单元之间不嵌套（`hasBlockChild` 已经保证了），所以按位置升序直接拼即可。
  insertions.sort((a, b) => a.at - b.at);
  let out = '';
  let cursor = 0;
  for (const insertion of insertions) {
    out += original.slice(cursor, insertion.at) + insertion.text;
    cursor = insertion.at;
  }
  out += original.slice(cursor);

  return { html: out, mode: 'interleaved', units: insertions.length };
}
