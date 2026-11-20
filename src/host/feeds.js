/**
 * Feed normalization: RSS 2.x, RSS 1.0 (RDF), and Atom 1.0 documents become a
 * common entry shape. IDs are stable within one feed URL: GUID / Atom id,
 * falling back to the link, then the title+date hash.
 */
import { createHash } from 'node:crypto';
import { attrOf, childrenOf, find, findAll, localName, parseXml, textOf } from './xml.js';
import { firstImageUrl, sanitizeHtml } from './sanitize.js';

const MAX_BODY_CHARS = 200_000;
const MAX_ENTRIES_INSPECTED = 500;
const MAX_ENTRIES_KEPT = 200;
/**
 * 每个源只保留最新这么多条的正文。
 *
 * 不能给全部 200 条都存正文：实测每条正文平均 12 KB，而 `RssStore.flush()` 是
 * **整份文档全量重写**。200 条 × 12 KB × 10 个源 ≈ 25 MB，每次去抖保存都要
 * `JSON.stringify` 一遍这个体积 —— 那是个真实的性能悬崖。所以条目列表留 200 条
 * 用于浏览，正文只留最新 20 条；更早的条目只留摘要，打开时按需去原文页抓。
 */
const MAX_ENTRY_BODIES = 20;
const MAX_BODY_BYTES_TOTAL = 8_000_000;

export function hashKey(...parts) {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 32);
}

/**
 * First **direct** child with that tag name.
 *
 * 必须用直接子元素而不是 `find()`（递归）：`<channel>` 里跟着几十个 `<item>`，
 * 每个 item 都有自己的 `<title>` / `<link>`。递归查找在 channel 自身缺字段时
 * 会**静默取到第一条 item 的值** —— 标题变成文章标题、订阅链接变成文章链接。
 */
function firstChild(node, wanted) {
  return childrenOf(node, wanted)[0];
}

/** Pick the article URL from a normalized entry node. */
function linkOf(node, isAtom) {
  if (isAtom) {
    for (const link of childrenOf(node, 'link')) {
      const rel = attrOf(link, 'rel');
      const href = attrOf(link, 'href');
      if (href && (rel === undefined || rel === 'alternate')) return href;
    }
    return attrOf(find(node, 'link'), 'href');
  }
  const link = firstChild(node, 'link') ?? find(node, 'link');
  const text = textOf(link).trim();
  if (text !== '') return text;
  return attrOf(firstChild(node, 'link') ?? find(node, 'link'), 'href');
}

function contentOf(node, isAtom) {
  const encoded = firstChild(node, 'encoded'); // content:encoded
  const content = firstChild(node, 'content');
  if (isAtom && content) {
    const type = attrOf(content, 'type') ?? 'text';
    const body = textOf(content);
    return type.includes('html') || type.includes('xhtml') ? body : `<p>${escapeHtml(body)}</p>`;
  }
  if (encoded) return textOf(encoded);
  if (content) return textOf(content);
  const description = firstChild(node, 'description') ?? firstChild(node, 'summary');
  return description ? textOf(description) : '';
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain-text list excerpt: strip tags, collapse whitespace, cap the length. */
export function excerptOf(html, limit = 180) {
  const text = String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function mediaAssetOf(node) {
  const asset = {};
  for (const name of ['thumbnail', 'content']) {
    for (const media of childrenOf(node, name)) {
      const url = attrOf(media, 'url');
      const medium = attrOf(media, 'medium');
      const type = attrOf(media, 'type') ?? '';
      if (url && !asset.image && (medium === 'image' || type.startsWith('image/') || name === 'thumbnail')) asset.image = url;
      if (url && !asset.audio && (medium === 'audio' || type.startsWith('audio/'))) asset.audio = url;
    }
  }
  for (const enclosure of childrenOf(node, 'enclosure')) {
    const url = attrOf(enclosure, 'url');
    const type = attrOf(enclosure, 'type') ?? '';
    if (url && !asset.audio && type.startsWith('audio/')) asset.audio = url;
    if (url && !asset.image && type.startsWith('image/')) asset.image = url;
  }
  return asset;
}

/**
 * 单集时长（`<itunes:duration>`）→ 秒。
 *
 * ★ 这个字段有三种写法，全都真实存在：`3723`（秒）、`62:03`、`1:02:03`。
 *   只认一种的话，界面上就会出现「2:03:00」被显示成「123 秒」这类错位 ——
 *   而进度条、剩余时间、倍速全部由它派生。
 * ★ 认不出来就不写这个字段（`undefined`），不要写成 0：0 秒会被界面当成
 *   「这一集是空的」。
 */
function durationOf(node) {
  const raw = textOf(firstChild(node, 'duration')).trim();
  if (raw === '') return undefined;
  let seconds;
  if (raw.includes(':')) {
    const parts = raw.split(':');
    if (parts.length > 3) return undefined;
    seconds = 0;
    for (const part of parts) {
      const value = Number(part);
      if (!Number.isFinite(value) || value < 0) return undefined;
      seconds = seconds * 60 + value;
    }
  } else {
    seconds = Number(raw);
  }
  // 27 小时以上的「单集时长」只可能是写坏了（把发布日期塞进了这个字段）。
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 100_000 ? seconds : undefined;
}

/**
 * `<podcast:transcript url="…" type="text/vtt"/>` → `{ url, type }`。
 *
 * ★ 一个条目可能有**多条** transcript（不同语言、不同格式）。P0 只取第一条能用的：
 *   界面上没有语言选择器，多语言并存时按「第一条」展示是确定的，而不是随机一条。
 * ★ 只认 `https:`：这段地址来自第三方 feed，会被插件当文本抓回来展示。
 *   `http:` 允许中间人替换成任意内容 —— 判据与音频地址（`media.js`）同一条。
 * ★ 不给 `type` 时保留空串，由 `parseTranscript` 按内容嗅探。
 */
function transcriptOf(node) {
  for (const item of childrenOf(node, 'transcript')) {
    const url = attrOf(item, 'url');
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) continue;
    const type = attrOf(item, 'type');
    return { url: parsed.href, type: typeof type === 'string' ? type.toLowerCase() : '' };
  }
  return undefined;
}

function dateOf(node, isAtom) {
  const raw = textOf(isAtom ? firstChild(node, 'updated') ?? firstChild(node, 'published') : firstChild(node, 'pubdate') ?? firstChild(node, 'date'));
  const parsed = raw ? new Date(raw) : undefined;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function authorOf(node) {
  const atom = firstChild(node, 'author');
  if (atom) {
    const name = firstChild(atom, 'name');
    if (name) return textOf(name).trim();
  }
  return textOf(firstChild(node, 'creator')).trim() || undefined; // dc:creator
}

function normalizeItem(node, isAtom, feedUrl, keepBody) {
  const title = textOf(firstChild(node, 'title')).trim();
  const link = linkOf(node, isAtom);
  const id = textOf(isAtom ? firstChild(node, 'id') : firstChild(node, 'guid')).trim() || link || `${title}|${dateOf(node, isAtom) ?? ''}`;
  if (title === '' && !link) return undefined;
  const rawHtml = contentOf(node, isAtom);
  const asset = mediaAssetOf(node);
  const html = keepBody ? sanitizeHtml(rawHtml, { baseUrl: link, maxLength: MAX_BODY_CHARS }) : '';
  const key = `feed:${hashKey(feedUrl, id)}`;
  return {
    key,
    id,
    title: title || '(untitled)',
    titleZh: undefined,
    author: authorOf(node),
    publishedAt: dateOf(node, isAtom),
    url: link,
    image: asset.image ?? (html ? firstImageUrl(html, link) : undefined),
    audio: asset.audio,
    /**
     * 播客那两个字段（`undefined` 时 JSON 序列化会直接丢掉，所以旧数据结构不变）。
     * `duration` = 秒；`transcript` = `{ url, type }`，供字幕面板按需抓取。
     */
    duration: durationOf(node),
    transcript: transcriptOf(node),
    // 正文被丢掉的条目也要有摘要：退回原始 HTML 再抽，否则列表里会出现空白行。
    summary: excerptOf(html || rawHtml),
    html,
    truncated: rawHtml.length > MAX_BODY_CHARS,
    bodyDropped: !keepBody,
  };
}

/**
 * Parse one feed document into entries plus the feed's own metadata.
 * @param {string} xmlText - raw feed XML (≤ 5 MB, DTD-free).
 * @param {string} feedUrl - subscription URL, part of the stable entry id.
 * @returns {{title: string, link?: string, description?: string, entries: object[]}}
 */
export function parseFeed(xmlText, feedUrl) {
  const root = parseXml(xmlText);
  const rss = find(root, 'rss') ?? root;
  const channel = childrenOf(rss, 'channel')[0] ?? find(root, 'channel');
  const atomFeed = find(root, 'feed');
  const rdf = find(root, 'rdf');

  let title = '';
  let link;
  let description;
  let items;

  if (channel) {
    title = textOf(firstChild(channel, 'title')).trim();
    link = linkOf(channel, false);
    description = textOf(firstChild(channel, 'description')).trim() || undefined;
    items = findAll(channel, 'item');
    // RSS 1.0 RDF keeps <item> as a sibling of <channel>.
    if (items.length === 0 && rdf) items = findAll(rdf, 'item');
  } else if (atomFeed) {
    title = textOf(firstChild(atomFeed, 'title')).trim();
    link = linkOf(atomFeed, true);
    const subtitle = firstChild(atomFeed, 'subtitle');
    description = subtitle ? textOf(subtitle).trim() || undefined : undefined;
    items = findAll(atomFeed, 'entry');
  } else {
    throw new Error('dsh-npie-reader: feed contains no channel/entry records');
  }

  const entries = [];
  let totalBytes = 0;
  for (const item of items.slice(0, MAX_ENTRIES_INSPECTED)) {
    const entry = normalizeItem(item, Boolean(atomFeed), feedUrl, entries.length < MAX_ENTRY_BODIES);
    if (!entry) continue;
    totalBytes += entry.html.length;
    if (totalBytes > MAX_BODY_BYTES_TOTAL) break;
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES_KEPT) break;
  }
  return {
    title: title || feedUrl,
    link,
    description,
    entries,
  };
}

/**
 * Parse an OPML 2.0 outline into subscription stubs.
 * Nested group outlines become path names (`Tech / AI`).
 * @param {string} xmlText - OPML document.
 * @returns {{name?: string, group?: string, url: string}[]}
 */
export function parseOpml(xmlText) {
  const root = parseXml(xmlText);
  const body = find(root, 'body');
  const out = [];
  const visit = (node, group) => {
    for (const child of childrenOf(node, 'outline')) {
      const url = attrOf(child, 'xmlurl');
      const text = attrOf(child, 'text') ?? attrOf(child, 'title');
      if (url) {
        out.push({ url, name: text?.trim() || undefined, group: group?.trim() || undefined });
      } else if (text) {
        visit(child, group ? `${group} / ${text.trim()}` : text.trim());
      }
    }
  };
  visit(body ?? root, undefined);
  const seen = new Set();
  return out.filter((item) => {
    const normalized = item.url.replace(/\/+$/, '');
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return /^https?:\/\//i.test(item.url);
  });
}

/** Render current subscriptions into an OPML 2.0 document. */
export function buildOpml(subscriptions) {
  const escape = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>dsh-npie-reader subscriptions</title></head>',
    '  <body>',
  ];
  const groups = new Map();
  for (const sub of subscriptions) {
    const key = sub.group ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sub);
  }
  for (const [group, subs] of groups) {
    if (group !== '') lines.push(`    <outline text="${escape(group)}">`);
    for (const sub of subs) {
      const indent = group !== '' ? '      ' : '    ';
      const name = sub.name ?? sub.url;
      lines.push(`${indent}<outline type="rss" text="${escape(name)}" title="${escape(name)}" xmlUrl="${escape(sub.url)}"/>`);
    }
    if (group !== '') lines.push('    </outline>');
  }
  lines.push('  </body>', '</opml>');
  return lines.join('\n');
}

export const FEED_LIMITS = {
  maxSubscriptions: 100,
  maxEntriesKept: MAX_ENTRIES_KEPT,
  maxEntryBodies: MAX_ENTRY_BODIES,
  maxBodyChars: MAX_BODY_CHARS,
  localName,
};
