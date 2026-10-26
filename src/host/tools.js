/**
 * Agent-facing tools. The model reaches the reader through a small surface:
 * list channels/articles, read one article in any version, generate a missing
 * Chinese version, manage subscriptions, and refresh.
 */
import { createRequire } from 'node:module';
import { annotationsMarkdown } from '../annotation-format.js';

/**
 * 回退路径必须产出标准 object JSON Schema：部分运行环境解析不到
 * `@deepseek-ai/dsh-tools`，直接回传扁平属性表会缺顶层 `type: "object"`，
 * 模型侧报 `schema must be a JSON Schema of type: "object"`。
 */
function flatParametersToJsonSchema(parameters) {
  if (parameters && typeof parameters === 'object' && parameters.type === 'object') return parameters;
  const properties = {};
  const required = [];
  for (const [name, definition] of Object.entries(parameters ?? {})) {
    if (!definition || typeof definition !== 'object') continue;
    const { required: isRequired, ...schema } = definition;
    properties[name] = schema;
    if (isRequired === true) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

let requireFn;
try {
  requireFn = createRequire(import.meta.url);
} catch {
  requireFn = undefined;
}

/**
 * 宿主 `defineTool` 可用时用真的，解析不到时退回等价普通对象——插件只拿它
 * 声明工具，注册由 `ctx.tools.register` 完成。外部 link 插件的 Host 半区解析
 * 不到宿主内部包是常态（见 typert-lite.js 顶部说明），所以静态 import 会让
 * 整个插件加载失败；运行时试探 + 回退才是安全写法。
 */
function defineTool(definition) {
  try {
    const mod = requireFn?.('@deepseek-ai/dsh-tools');
    if (typeof mod?.defineTool === 'function') return mod.defineTool(definition);
  } catch {
    // 宿主包不可解析：走下面的等价回退。
  }
  return { ...definition, parameters: flatParametersToJsonSchema(definition.parameters) };
}
/**
 * `rss_list_articles` 一次能取回的上限。
 *
 * 原来是 50，太小了：「最近 3 天」这类时间窗设在多个源上时，窗口内的量根本装不下，
 * 模型会把「它没要够」读成「就这么多」，于是给出「这几天没什么内容」的错误结论。
 * 上限仍要封顶 —— 一次返回上千行会把上下文塞满。
 */
const LIST_LIMIT_MAX = 200;
/** `rss_search_articles` 的结果上限。 */
const SEARCH_LIMIT_MAX = 100;

function text(value) {
  return [{ type: 'text', text: value }];
}

function formatEntryLine(entry) {
  const flags = [entry.read === false ? '未读' : null, entry.favorite ? '收藏' : null].filter(Boolean).join(',');
  const channel = entry.channelName ? ` [${entry.channelName}]` : '';
  const date = entry.publishedAt ? ` (${entry.publishedAt.slice(0, 10)})` : '';
  return `- ${entry.key} | ${entry.title}${channel}${date}${flags ? ` ${flags}` : ''}`;
}

export const TOOL_NAMES = {
  listChannels: 'rss_list_channels',
  listArticles: 'rss_list_articles',
  readArticle: 'rss_read_article',
  generateVersion: 'rss_generate_version',
  searchArticles: 'rss_search_articles',
  digest: 'rss_digest',
  addSubscription: 'rss_add_subscription',
  removeSubscription: 'rss_remove_subscription',
  refresh: 'rss_refresh',
  // ---- 电子书（逐章解读）------------------------------------------------
  bookList: 'book_list',
  bookOutline: 'book_outline',
  bookChapter: 'book_chapter',
  bookSearch: 'book_search',
  bookAnnotations: 'book_annotations',
  bookExportSkill: 'book_export_skill',
};

/**
 * 时间窗与「无发布时间条目被排除」的说明。
 *
 * ★ 这些数字必须一起出现。只报「命中 5 条」而不说「另有 12 条没有发布时间被排除」，
 *   模型会把它当成「订阅源里就这么多」，于是给出「最近三天没有相关讨论」这种
 *   建立在缺失数据上的结论 —— 一个确定的假话。
 *
 * ★ 「触顶」的三类原因必须**分开说**，不能合成一句「结果可能不全」：
 *   - 条目扫描到顶 ⇒ 补救是**收窄时间窗 / 指定频道**；
 *   - 正文预算用完 ⇒ 补救是**把检索词写具体**（部分条目只比对了标题与摘要）；
 *   - 频道数被丢弃 ⇒ 补救是**分批再调**。
 *   合成一句时模型三选一只能瞎猜，而它通常猜成「就这么多」。
 */
function windowNote(result) {
  const parts = [];
  if (result.window) parts.push(`时间窗 ${result.window}`);
  if (result.undatedExcluded) parts.push(`另有 ${result.undatedExcluded} 条没有发布时间，已排除`);
  if (result.truncatedScan) parts.push('已达条目扫描上限，更早的条目没有看，结果可能不全');
  if (result.truncatedBodies) parts.push('已达正文预算上限，部分条目只比对了标题与摘要');
  if (result.droppedChannels) parts.push(`另有 ${result.droppedChannels} 个频道本次没有处理，请分两批再调一次`);
  return parts.length ? `（${parts.join('；')}）` : '';
}

/** 命中位置的中文说法，让模型知道这个词是从哪找到的。 */
const MATCH_LABELS = { title: '标题', titleZh: '中文标题', summary: '摘要', body: '正文' };

function formatSearchHit(entry) {
  const line = formatEntryLine(entry);
  const where = MATCH_LABELS[entry.matchedIn] ?? entry.matchedIn ?? '';
  if (where === '' || where === '标题' || where === '中文标题') return `${line} ← ${where}`;
  return `${line} ← ${where}：${entry.snippet || '（命中处无上下文）'}`;
}

/**
 * `channels` 参数的容错解析：模型可能给逗号/空格分隔的字符串，也可能给数组。
 *
 * ★ 两种都要认。只认一种的话，另一种会**静默变成「不过滤」= 搜全库**，
 *   而用户以为自己限定在那几份源上 —— 结果看起来完全正常，只是范围错了。
 */
function channelList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  }
  if (typeof value === 'string') return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

/** 章节状态的中文说法。`pending` 单独一档 —— 它和 `failed` 的补救动作完全不同。 */
const CHAPTER_STATUS_LABEL = {
  done: '已解读',
  pending: '未解读',
  running: '生成中',
  failed: '失败',
  stale: '已过期',
  skipped: '略过',
};

/** 一本书的「已解读 / 总数」一行，给 `book_list` 与 `book_outline` 共用。 */
function bookProgressLine(book) {
  const parts = [`${book.done}/${book.chapters} 章已解读`];
  if (book.skipped > 0) parts.push(`略过 ${book.skipped}`);
  if (book.failed > 0) parts.push(`失败 ${book.failed}`);
  if (book.pending > 0) parts.push(`待生成 ${book.pending}`);
  if (book.generating) parts.push('**正在生成中**');
  return parts.join(' · ');
}

/**
 * 一章的 markdown。**默认是解读，不是原文**。
 *
 * ★ 输出必须自己说明「这是解读」。模型拿到一段通顺的中文时，会默认它是原文，
 *   于是把解读里的一句概括当成作者的原话引用出去 —— 这是最坏的一类错误：
 *   用户完全没法从输出里看出它被转过一手。
 */
function formatChapterDigest(chapter) {
  const head = `# 第 ${chapter.n} 章 · ${chapter.chapterTitle || '（无标题）'}`;
  const meta = [
    `《${chapter.title}》`,
    Number.isInteger(chapter.startPage) ? `p.${chapter.startPage}${chapter.endPage && chapter.endPage !== chapter.startPage ? `–${chapter.endPage}` : ''}` : '',
  ].filter(part => part !== '').join(' · ');
  const digest = chapter.digest;
  if (digest === null) {
    return [
      head,
      '',
      `> ${meta}`,
      '',
      '这一章**还没有解读**。要么它被判定为正文不足（跳过），要么还没生成。',
      '如果用户确实需要这一章的内容，用 book_chapter 加 `raw: true` 取原文（会很大）。',
    ].join('\n');
  }
  const lines = [head, '', `> ${meta} · 这一章是**解读**（不是原文），模型 ${digest.model || '未知'}`];
  if (digest.summary) lines.push('', '## 讲了什么', '', digest.summary);
  if (digest.points.length > 0) lines.push('', '## 要点', '', ...digest.points.map(point => `- ${point}`));
  if (digest.terms.length > 0) {
    lines.push('', '## 术语', '', ...digest.terms.map(term => `- **${term.term}**：${term.note}`));
  }
  if (digest.format === 'text') {
    lines.push('', '> 注：这一章的解读没有结构化要点（模型当时返回的是整段文字）。');
  }
  lines.push('', '需要作者原话时，用 book_chapter 加 `raw: true` 取这一章的原文。');
  return lines.join('\n');
}

/** Build every tool definition; `service` is the live RssService. */
export function createToolDefinitions(service) {
  return [
    defineTool({
      name: TOOL_NAMES.listChannels,
      description: 'List reading channels available in the dsh-npie-reader plugin (aggregate, per-group, and personal subscriptions) with unread counts.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async () => {
        const { channels, dataError } = await service.listChannels();
        // ★ 数据文件读不出来时必须**先说**。内存里此时是空的 `defaults()`，不说的话
        //   模型看到 "No channels yet" 会告诉用户「你还没订阅任何源」—— 而真相是
        //   「订阅数据读不出来，原文件没被覆盖、还能抢救」。前者让用户去重新订阅，
        //   后者让用户去修文件，两个动作完全相反。
        const warning = dataError
          ? `⚠ 数据文件读不出来（${dataError}）。已**拒绝覆盖**原文件，下面这份清单不代表你已有的订阅。\n`
          : '';
        if (channels.length === 0) return `${warning}No channels yet. Add a personal subscription with rss_add_subscription, then refresh with rss_refresh.`;
        const lines = channels.map((channel) => `- ${channel.key} | ${channel.name}${channel.group ? ` (${channel.group})` : ''} | ${channel.kind} | unread ${channel.unread}/${channel.total}`);
        return `${warning}Channels:\n${lines.join('\n')}`;
      },
    }),
    defineTool({
      name: TOOL_NAMES.listArticles,
      description: 'List recent articles of one channel (or the aggregate stream), optionally within a time window. Returns article keys suitable for rss_read_article. Entries without a publish date are excluded whenever since/until is set.',
      parameters: {
        channel: { type: 'string', description: 'Channel key from rss_list_channels; omit for the aggregate stream.' },
        filter: { type: 'string', description: 'all | unread | favorite' },
        search: { type: 'string', description: 'Case-insensitive title filter. For full-text search use rss_search_articles instead.' },
        since: { type: 'string', description: 'Window start. Relative (3d, 72h, 2w) or an ISO date (2026-10-05). Omit for no lower bound.' },
        until: { type: 'string', description: 'Window end. Relative or an ISO date; a date-only value includes that whole day. Omit for no upper bound.' },
        limit: { type: 'number', description: `Max entries to return (default 20, cap ${LIST_LIMIT_MAX}). A time window over many feeds needs a higher limit.` },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const page = await service.listEntries({
          channel: args.channel,
          filter: args.filter,
          search: args.search,
          since: args.since,
          until: args.until,
          limit: Math.min(args.limit ?? 20, LIST_LIMIT_MAX),
        });
        if (page.entries.length === 0) return `No articles matched${windowNote(page)}. Try rss_refresh, a wider window, or a different filter.`;
        return [`Articles (${page.entries.length}${page.hasMore ? '+, more available' : ''})${windowNote(page)}:`, ...page.entries.map(formatEntryLine)].join('\n');
      },
    }),
    defineTool({
      name: TOOL_NAMES.readArticle,
      description: 'Read one full article. version: original (default), translation (Chinese), or rewrite (Chinese deep rewrite). Missing Chinese versions are reported instead of auto-generated.',      parameters: {
        key: { type: 'string', description: 'Article key from rss_list_articles.', required: true },
        version: { type: 'string', description: 'original | translation | rewrite' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const { article } = await service.getArticle({ key: args.key });
        const wanted = args.version ?? 'original';
        const versions = await service.getVersionContent({ key: args.key });
        const chosen = versions[wanted];
        if (!chosen) throw new Error('version must be original, translation or rewrite');
        if (wanted !== 'original' && !chosen.available) {
          return `Version "${wanted}" is not available for this article. Use rss_generate_version to create it with the local model, or read the original.`;
        }
        const body = chosen.content;
        const header = [
          `# ${chosen.title ?? article.title}`,
          '',
          article.url ? `原文链接: ${article.url}` : null,
          article.author ? `作者: ${article.author}` : null,
          article.publishedAt ? `发布时间: ${article.publishedAt}` : null,
          '',
        ].filter((line) => line !== null).join('\n');
        return `${header}\n${body}`;
      },
    }),
    defineTool({
      name: TOOL_NAMES.generateVersion,
      description: 'Generate a missing Chinese version (translation or rewrite) of one article with the harness model. This calls the configured LLM and may take a while.',
      parameters: {
        key: { type: 'string', description: 'Article key from rss_list_articles.', required: true },
        kind: { type: 'string', description: 'translation | rewrite', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        if (args.kind !== 'translation' && args.kind !== 'rewrite') {
          throw new Error('kind must be "translation" or "rewrite"');
        }
        const version = await service.generateVersion({ key: args.key, kind: args.kind });
        return `Generated ${args.kind} (source: ${version.source}):\n\n# ${version.title ?? ''}\n\n${version.markdown ?? version.paragraphs?.join('\n\n') ?? ''}`;
      },
    }),
    defineTool({
      name: TOOL_NAMES.searchArticles,
      description: 'Full-text search across subscribed articles — matches titles, Chinese titles, summaries and article bodies. Use this to answer "what did my sources say about X". Narrow the corpus with channels and/or a time window when the user asks about specific sources or a specific period.',
      parameters: {
        query: { type: 'string', description: 'Search text, case-insensitive. Matched against title, Chinese title, summary and body.', required: true },
        channels: { type: 'string', description: 'Comma-separated channel keys from rss_list_channels to restrict the search; omit to search every subscription.' },
        since: { type: 'string', description: 'Window start. Relative (3d, 72h, 2w) or an ISO date (2026-10-05).' },
        until: { type: 'string', description: 'Window end. Relative or an ISO date; a date-only value includes that whole day.' },
        limit: { type: 'number', description: `Max results (default 20, cap ${SEARCH_LIMIT_MAX}).` },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const found = await service.searchArticlesDetailed({
          query: args.query,
          channels: channelList(args.channels),
          since: args.since,
          until: args.until,
          limit: Math.min(args.limit ?? 20, SEARCH_LIMIT_MAX),
        });
        const note = `${windowNote(found)}（扫描 ${found.scanned} 条，读了 ${found.bodiesRead} 篇正文）`;
        if (found.results.length === 0) {
          return `Nothing matches "${args.query}"${note}. Widen the window, drop the channel filter, or run rss_refresh first.`;
        }
        return `Results (${found.results.length})${note}:\n${found.results.map(formatSearchHit).join('\n')}`;
      },
    }),
    defineTool({
      name: TOOL_NAMES.digest,
      description: 'Digest across several channels within one time window, in a single call. Returns the newest entries per channel plus per-channel totals, so you can see at a glance which sources published and which stayed silent. Use this first for requests like "summarise what my newsletters covered in the last 3 days".',
      parameters: {
        channels: { type: 'string', description: 'Comma-separated channel keys from rss_list_channels; omit for every subscription combined.' },
        since: { type: 'string', description: 'Window start. Relative (3d, 72h, 2w) or an ISO date (2026-10-05).' },
        until: { type: 'string', description: 'Window end. Relative or an ISO date; a date-only value includes that whole day.' },
        perChannel: { type: 'number', description: 'How many newest entries to list per channel (default 8, cap 30).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const result = await service.digest({
          channels: channelList(args.channels),
          since: args.since,
          until: args.until,
          perChannel: args.perChannel,
        });
        const head = `Digest over ${result.channels} channel(s), ${result.total} entries${windowNote(result)}:`;
        if (result.total === 0) return `${head}\nNo entries in this window. Widen it, or run rss_refresh to fetch newer items.`;
        const body = result.groups.map((group) => {
          const lines = group.entries.map(formatEntryLine);
          const more = group.total > group.entries.length ? `\n  …还有 ${group.total - group.entries.length} 条` : '';
          return `## ${group.name} (${group.key}) — ${group.total} 条 / 未读 ${group.unread}\n${lines.join('\n')}${more}`;
        });
        return [head, '', ...body, '', 'Read any entry in full with rss_read_article.'].join('\n');
      },
    }),
    defineTool({
      name: TOOL_NAMES.addSubscription,
      description: 'Add a personal RSS/Atom subscription. The feed is fetched immediately to validate it and seed articles.',
      parameters: {
        url: { type: 'string', description: 'Full RSS/Atom feed URL (http/https).', required: true },
        name: { type: 'string', description: 'Optional display name; defaults to the feed title.' },
        group: { type: 'string', description: 'Optional group label.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const sub = await service.addSubscription(args);
        return `Subscribed to "${sub.name}" (${sub.id}) with ${sub.entryCount ?? 0} articles seeded.`;
      },
    }),
    defineTool({
      name: TOOL_NAMES.removeSubscription,
      description: 'Remove one personal subscription by id or URL. Favorites and saved notes are kept.',
      parameters: {
        id: { type: 'string', description: 'Subscription id or feed URL.', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const removed = await service.removeSubscription({ id: args.id });
        return removed ? 'Subscription removed.' : 'No matching subscription found.';
      },
    }),
    defineTool({
      name: TOOL_NAMES.refresh,
      description: 'Refresh feeds now: all personal feeds, one feed, or one group; omit channel for everything.',
      parameters: {
        channel: { type: 'string', description: 'Channel key to refresh; omit for everything.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const outcome = await service.refresh({ channel: args.channel });
        // ★ 「成功几个 / 失败几个」必须**同屏**出现。只报总数时，「3 个源全连不上」
        //   与「3 个源都连上了、确实没新东西」产出完全相同的输出，而这两句话对
        //   用户的含义相反。失败原因也要带上 —— 模型据此才能说出「XX 源抓不动了」，
        //   而不是替用户下「这几天没内容」的结论。
        const parts = [
          `Feeds refreshed: ${outcome.ok ?? 0} ok / ${outcome.failed ?? 0} failed`
          + ` (of ${outcome.feeds ?? 0}), new/updated entries: ${outcome.entries ?? 0}`,
        ];
        if (outcome.failures?.length) {
          const shown = outcome.failures.slice(0, 5).map((item) => `${item.name}: ${item.error}`);
          const rest = outcome.failures.length - shown.length;
          parts.push(`Failures: ${shown.join('; ')}${rest > 0 ? `; …and ${rest} more failed` : ''}`);
        }
        if (outcome.error !== undefined) parts.push(`Error: ${outcome.error}`);
        else if (outcome.feeds === 0) parts.push('No feeds to refresh — add one with rss_add_subscription first.');
        return `Refresh done. ${parts.join('; ')}`;
      },
    }),

    // ---- 电子书 -----------------------------------------------------------
    //
    // 这五个工具是「逐章解读」这个东西**对 agent 存在**的唯一方式。
    // 没有它们，解读只是磁盘上的一堆 JSON，只有人点开面板才看得到 ——
    // 也就是说，用户花 token 生成的东西，模型永远读不到。

    defineTool({
      name: TOOL_NAMES.bookList,
      description: 'List the e-books in the reader that have chapter digests, with per-book progress (digested / skipped / failed / pending). Start here for any question about a book; the returned bookId is what the other book_* tools take.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async () => {
        const books = await service.listBookDigests();
        if (books.length === 0) {
          return 'No book has chapter digests yet. Open a book in the reader plugin and generate digests first — the book_* tools read those digests.';
        }
        const lines = books.map((book) => {
          const author = book.author ? ` · ${book.author}` : '';
          const pages = book.pageCount === null ? '' : ` · ${book.pageCount} 页`;
          return `- ${book.bookId} | 《${book.title}》${author}${pages} | ${bookProgressLine(book)}`;
        });
        return [
          `Books with digests (${books.length}):`,
          ...lines,
          '',
          'Use book_outline to see the chapter tree, book_chapter to read one chapter (digest by default), book_search to find which chapters cover a topic, and book_annotations to read the passages the user personally highlighted (that one also works for books with no digests at all).',
        ].join('\n');
      },
    }),
    defineTool({
      name: TOOL_NAMES.bookOutline,
      description: 'Chapter tree of one book with each chapter\'s digest status, page range and the model used. Call this before book_chapter so you know which chapters actually have digests — reading a chapter that was never digested returns nothing useful.',
      parameters: {
        bookId: { type: 'string', description: 'Book id from book_list.', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const outline = await service.bookOutlineOf(args.bookId);
        const counts = { done: 0, skipped: 0, failed: 0, pending: 0 };
        const lines = outline.chapters.map((chapter) => {
          if (counts[chapter.status] !== undefined) counts[chapter.status] += 1;
          const pages = Number.isInteger(chapter.startPage)
            ? ` | p.${chapter.startPage}${Number.isInteger(chapter.endPage) && chapter.endPage !== chapter.startPage ? `–${chapter.endPage}` : ''}`
            : '';
          const label = CHAPTER_STATUS_LABEL[chapter.status] ?? chapter.status;
          const model = chapter.model ? `（${chapter.model}）` : '';
          const error = chapter.error ? `：${chapter.error}` : '';
          return `- ${String(chapter.n).padStart(2, '0')} ${chapter.title || '（无标题）'}${pages} | ${label}${model}${error}`;
        });
        const total = outline.chapters.length;
        const head = `《${outline.title}》 (${outline.bookId}) — ${total} 章 · ${outline.mode || '未知分段'}${outline.pageCount === null ? '' : ` · ${outline.pageCount} 页`}`;
        /**
         * ★ 「0 章」不是一种情况，至少两种，下一步完全不同：
         *   · **扫描版**：整本没有文字层，分段从第一页就什么都读不到。这时说
         *     「这本书没有章节」是假话 —— 它有章节，是我们看不见。让模型去
         *     「换一章试试」，它会一章章读到空（0.27.1 修的是同一类错：在全是
         *     图的书里建议换个词）。
         *   · 有文字层但分段没命中目录/标题：那是分段没认出来，换不了章也说得通。
         *
         * ★ 0.28.0 起识别文本**会进分段**（`page-text.js` 叠加 → `segment.js`）。
         *   所以扫描版这条话术要跟着改，而且必须分三档 —— 区别在「认了多少页」：
         *     · `ocrPages === 0`：一页都没认过。下一步是识别整本（认完自动重抽目录）。
         *     · `0 < ocrPages < pageCount`：认了一部分，还不足以分出章节。下一步是
         *       接着认剩下的页，而不是「换个词」「换一章」。
         *     · 认满了仍然 0 章：分段没在识别文本里找到目录/章标题。这一步就走不通了，
         *       老实说走不通，别让人再刷一遍识别。
         *   上一版这里写的是「识别出来的文字不进分段」—— 那句话在当时是真的，
         *   现在是假的；工具里留着一句已经过期的断言，比没有更坏。
         */
        if (total === 0) {
          const known = Number(outline.ocrKnown) || 0;
          const pageCount = Number(outline.pageCount) || 0;
          const scanned = outline.mode === 'scanned';
          const ocrLine = !scanned
            ? '这本书没能分出章节（分段没有命中目录或标题）。book_chapter 对它没有内容可给；用户划过的原文不受影响，用 book_annotations 读。'
            : known === 0
              ? '这本书是**扫描版**（整本没有文字层），也还没有识别过的页，所以一章都分不出来：book_chapter 对它没有内容可给，book_search 也搜不到它。用户那侧在阅读器里按 ⌘F，「搜索」面板会给出「识别整本 N 页」—— 识别完会**自动重新分段**（识别文本会进分段），这本书就能读了。'
              : pageCount > 0 && known < pageCount
                ? `这本书是**扫描版**，目前只识别了 ${known} / ${pageCount} 页，还不够分出章节。下一步是把剩下的页认完（阅读器 ⌘F →「识别这 N 页」），不是换一章、也不是换一个词 —— 认完会自动重新分段。`
                : `这本书是**扫描版**，${known} 页都识别过了，但认出来的字太少（多半是空白页、图片页、插图扉页），分不出章节。book_chapter 对它没有内容可给；要原话用 book_search（能搜到认出来的那些页），要用户划过的句子用 book_annotations。`;
          return [head, ocrLine, ''].join('\n');
        }
        return [
          head,
          `已解读 ${counts.done} · 略过 ${counts.skipped} · 失败 ${counts.failed} · 未解读 ${counts.pending}`,
          '',
          ...lines,
        ].join('\n');
      },
    }),
    defineTool({
      name: TOOL_NAMES.bookChapter,
      description: 'Read ONE chapter of a book. By default returns that chapter\'s Chinese digest (summary + key points + terms, roughly 1k tokens) — this is what you want for almost every question. Set raw=true only when the user asks for the author\'s exact wording; the raw text is ~10x larger and is truncated at 20000 characters with an explicit notice.',
      parameters: {
        bookId: { type: 'string', description: 'Book id from book_list.', required: true },
        n: { type: 'number', description: 'Chapter number from book_outline (1-based).', required: true },
        raw: { type: 'boolean', description: 'true = the extracted original text instead of the digest. Costs ~10x more tokens; use only for direct quotes.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const chapter = await service.readBookChapter({
          bookId: args.bookId,
          n: Number(args.n),
          raw: args.raw === true,
        });
        if (chapter.raw !== true) return formatChapterDigest(chapter);
        const head = `# 第 ${chapter.n} 章 · ${chapter.chapterTitle || '（无标题）'} · 原文`;
        const note = chapter.truncated
          // ★ 截断必须说出来。悄悄截断时模型会把「后面没给」读成「后面没有」，
          //   于是替一本书的后半段下结论。
          ? `\n\n> ⚠ 原文共 ${chapter.chars} 字，这里只给了前 ${chapter.text.length} 字（**已截断**）。后半部分没有给出，不要据此推断后半部分的内容。`
          : '';
        return `${head}\n\n> 《${chapter.title}》 · 这是**抽取出来的原文**，不是解读。\n\n${chapter.text}${note}`;
      },
    }),
    defineTool({
      name: TOOL_NAMES.bookSearch,
      description: 'Search across chapter DIGESTS (not raw text) to find which chapters of which books cover a topic, person or term. Chinese matching is by substring, so a shorter query finds more. Use this to narrow a whole book down to the few chapters worth reading, then read those with book_chapter.',
      parameters: {
        query: { type: 'string', description: 'Text to look for. Matched as a case-insensitive substring against summaries, key points and terms.', required: true },
        bookId: { type: 'string', description: 'Restrict to one book; omit to search every book that has digests.' },
        limit: { type: 'number', description: 'Max hits (default 20, cap 50).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const found = await service.searchBookDigests({
          query: args.query,
          bookId: args.bookId,
          limit: args.limit,
        });
        const note = `（在 ${found.scanned} 章解读里检索${found.truncated ? '，已达上限，结果可能不全' : ''}）`;
        if (found.hits.length === 0) {
          return `没有解读提到「${args.query}」${note}。换个更短的词，或者这本书还没生成解读 —— 用 book_list 看进度。`;
        }
        const lines = found.hits.map(hit => `- ${hit.bookId} 第 ${hit.n} 章 ${hit.chapterTitle || ''} | ${hit.where}：${hit.snippet}`);
        return [
          `「${args.query}」命中 ${found.hits.length} 章${note}：`,
          ...lines,
          '',
          '这些是**解读**里的命中，不是原文。要原话用 book_chapter 取那一章（默认给解读，raw=true 给原文）。',
        ].join('\n');
      },
    }),
    defineTool({
      name: TOOL_NAMES.bookAnnotations,
      description: 'Read the passages the USER personally highlighted in a book, together with the notes they wrote. These are the strongest available signal of what this reader cares about: a highlight is their own judgement made while reading, while a digest is text a model wrote about the book. Use this when asked what the user marked as important, what they noted, or to ground an answer in passages they already found worth keeping. Read-only — there is no way to add, edit or delete highlights through this tool.',
      parameters: {
        bookId: { type: 'string', description: 'Book id from book_list. Omit to read highlights across every book that has any.' },
        notesOnly: { type: 'boolean', description: 'true = only highlights that carry a written note. Default false.' },
        limit: { type: 'number', description: 'Max highlights across all returned books (default 200, cap 500).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const found = await service.listBookAnnotations({
          bookId: args.bookId,
          notesOnly: args.notesOnly === true,
          limit: args.limit,
        });
        if (found.books.length === 0) {
          // ★ 空态必须说清「是没划过」还是「划了但没写笔记」：合成一句的话，
          //   模型会照着「这本书没划线」去回答，而用户其实划了十几条。
          if (args.notesOnly === true) {
            return 'None of the reader\'s highlights carries a written note. Call book_annotations again without notesOnly to get the highlights themselves.';
          }
          const scope = args.bookId === undefined ? 'any book' : `book ${args.bookId}`;
          return `The user has not highlighted anything in ${scope} yet. Do not invent or infer highlights — if the question needs marked passages, say there are none and answer from book_chapter instead.`;
        }

        const totalNotes = found.books.reduce((sum, book) => sum + book.notes, 0);
        const lines = [
          `The user highlighted ${found.totalItems} passages${totalNotes > 0 ? ` (${totalNotes} of them carry a written note)` : ''} across ${found.books.length} book${found.books.length === 1 ? '' : 's'}.`,
          '',
        ];
        for (const book of found.books) {
          lines.push(annotationsMarkdown({
            title: book.title,
            bookId: book.bookId,
            items: book.items,
            // ★ 把已知总数交进去：预算截断发生在 service 里，这里手里的数组
            //   已经变短了，不传 total 就会把「截断」写成「全书就这么多」。
            total: book.total,
          }).markdown);
          lines.push('---', '');
        }
        if (found.truncated) {
          lines.push(`> ⚠ 只带回了前 ${found.shown} 条（共 ${found.totalItems} 条）。要看完剩下的，用 bookId 逐本调一次。`);
          lines.push('');
        }
        lines.push('These are the user\'s own highlights (original wording), not digests. Quote them as what the user marked, and do not claim a page you were not given.');
        return lines.join('\n');
      },
    }),
    defineTool({
      name: TOOL_NAMES.bookExportSkill,
      description: 'Export one book\'s digests as a portable skill package (SKILL.md index + chapters/*.md + glossary.md + patterns.md + cheatsheet.md) into the plugin data directory, and return the absolute path. This does NOT call the model by default — it only rearranges digests that already exist, so it costs nothing. Set synthesize=true to additionally run ONE model call that writes the cross-chapter pages (patterns / cheatsheet); without it those two files contain a plainly-labelled excerpt instead.',
      parameters: {
        bookId: { type: 'string', description: 'Book id from book_list.', required: true },
        profile: { type: 'string', description: 'Book type: auto (default, detected from the text) | technical | fiction | nonfiction. It decides what the cross-chapter pages ask about.' },
        synthesize: { type: 'boolean', description: 'true = one extra model call for the cross-chapter pages. Default false (free, excerpt only).' },
        model: { type: 'string', description: 'Model for the synthesis call as provider/model; omit to follow the reader\'s digest model setting.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args) => {
        const result = await service.exportBookSkill({
          bookId: args.bookId,
          profile: args.profile,
          synthesize: args.synthesize === true,
          model: args.model,
        });
        const lines = [
          `导出完成：${result.dir}`,
          '',
          `- 书型：${result.profile}${result.profileReason ? `（依据：${result.profileReason}）` : ''}`,
          `- 章节：${result.stats.chapters} 章（已解读 ${result.stats.digested}`
            + `${result.stats.skipped > 0 ? ` · 略过 ${result.stats.skipped}` : ''}`
            + `${result.stats.failed > 0 ? ` · 失败 ${result.stats.failed}` : ''}）`,
          `- 术语：${result.stats.terms} 条`,
          `- 体积：${result.bytes} 字节`,
          `- 跨章综合：${result.synthesized ? '已做' : '未做（patterns.md / cheatsheet.md 是原样摘录，文件里已写明）'}`,
          `- 文件：${result.files.join('、')}`,
        ];
        if (result.synthesisError) lines.push(`- ⚠ 跨章综合失败：${result.synthesisError}（已退回原样摘录，其余文件不受影响）`);
        lines.push('', '这是一个独立的目录，没有装进任何 agent 的 skills 目录。要用它，把整个目录拷到那个 agent 的 skills 目录下。');
        return lines.join('\n');
      },
    }),
  ];
}
