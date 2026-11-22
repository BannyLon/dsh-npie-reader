/**
 * 跨源检索：把四份互不相干的结果折成一张统一的清单（0.88.0）。
 *
 * ★ 为什么要有这个文件：四路搜索各有各的形状 ——
 *   RSS 给 `{ key, title, titleZh, matchedIn, snippet }`，
 *   书给 `{ bookId, bookTitle, n, chapterTitle, where, snippet }`，
 *   论文给 `{ paper, snippet }`，
 *   日记给 `{ date, index, kind, source, snippet }`。
 *   如果界面直接吃这四种形状，那么「键盘上下选、回车跳过去」这一件事就要写四遍，
 *   而四份里必然有一份会漏 —— 症状是「某一类结果按回车没反应」。
 *
 * ★ 这里只做**投影与截断**，不重排：每一路的排序是各自的检索函数决定的
 *   （RSS 按正文/标题命中位置与时间、书按章节顺序、日记按日期倒序）。
 *   在这里强行统一打分，等于用一个没被验证过的公式覆盖掉四份都有理由的顺序。
 *
 * ★ 每组的 `hidden` 必须单独算并回传：只返回前 5 条而不说「还有 12 条」，
 *   用户会把它读成「一共就 5 条」—— 那是确定的假话，和 `windowNote()` 同一条纪律。
 */

/** 一次检索每一路最多显示几条。再多，面板就要滚动了，而面板的定位是「快速跳过去」。 */
export const PER_SOURCE_LIMIT = 5;

/** 查询词上限。2000 字的「查询词」不是检索，是往 indexOf 里塞一篇文章。 */
export const MAX_QUERY_CHARS = 120;

/**
 * 归一查询词。
 *
 * ★ 只做 trim + 折叠内部空白 + 截断，**不切词、不改大小写**：四路的判据都是
 *   「trim + 小写 + 子串」（RSS / 书 / 论文 / 日记全一致），在这里改一次就变成
 *   第五套口径。中文没有空格，切词反而会把「信任的代价」切成三个单字查询。
 */
export function normalizeQuery(raw) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text;
}

/** 一条统一的命中。`jump` 是界面跳转要的全部信息，别的字段只用于显示。 */
function hitOf(jump, { title, sub, snippet, at }) {
  return {
    id: `${jump.kind}:${jump.key ?? jump.bookId ?? jump.paperId ?? jump.date ?? ''}:${jump.index ?? jump.chapter ?? ''}`,
    title: typeof title === 'string' ? title : '',
    sub: typeof sub === 'string' ? sub : '',
    snippet: typeof snippet === 'string' ? snippet : '',
    at: Number.isFinite(Number(at)) ? Number(at) : 0,
    jump,
  };
}

function take(rows, per) {
  const list = Array.isArray(rows) ? rows : [];
  return { hits: list.slice(0, per), hidden: Math.max(0, list.length - per) };
}

/**
 * 四路原始结果 → 统一分组。
 *
 * @param {object} input
 * @param {Array} [input.articles] - `searchArticlesDetailed().results`
 * @param {Array} [input.books] - `searchBookDigests().hits`
 * @param {Array} [input.papers] - `papersSearch().hits`
 * @param {Array} [input.diary] - `diary.search().hits`
 * @param {number} [input.perSource]
 * @param {object} [input.scanned] - 各路实际扫了多少（如实报出去）
 * @param {object} [input.notes] - 各路自己的「结果可能不全」说明
 */
export function assembleGroups({
  articles = [], books = [], papers = [], diary = [], perSource = PER_SOURCE_LIMIT, scanned = {}, notes = {},
} = {}) {
  const articleRows = (Array.isArray(articles) ? articles : []).map((row) => hitOf(
    { kind: 'article', key: String(row?.key ?? '') },
    {
      title: row?.titleZh || row?.title || row?.key || '',
      sub: row?.channelName ?? '',
      snippet: row?.snippet ?? '',
      at: row?.publishedAt ? Date.parse(row.publishedAt) : 0,
    },
  ));

  const bookRows = (Array.isArray(books) ? books : []).map((row) => hitOf(
    { kind: 'book', bookId: String(row?.bookId ?? ''), chapter: Number(row?.n) || 0 },
    {
      title: row?.bookTitle || row?.bookId || '',
      // 「第 3 章 转折 · 摘要命中」比只写章节标题有用：它回答了「为什么这条被搜出来」。
      sub: [row?.n ? `第 ${row.n} 章` : '', row?.chapterTitle ?? '', row?.where ? `${row.where}命中` : '']
        .filter((part) => part !== '').join(' · '),
      snippet: row?.snippet ?? '',
    },
  ));

  const paperRows = (Array.isArray(papers) ? papers : []).map((row) => {
    const paper = row?.paper ?? row ?? {};
    return hitOf(
      { kind: 'paper', paperId: String(paper.id ?? '') },
      {
        title: paper.title || paper.id || '',
        sub: [paper.year, paper.venue].filter((part) => part !== undefined && part !== '' && part !== null).join(' · '),
        snippet: row?.snippet ?? '',
      },
    );
  });

  const diaryRows = (Array.isArray(diary) ? diary : []).map((row) => hitOf(
    { kind: 'diary', date: String(row?.date ?? ''), index: Number(row?.index), scope: row?.scope === 'private' ? 'private' : 'public' },
    {
      title: row?.kind ? `${row.kind}${row.source ? ` · ${row.source}` : ''}` : (row?.date ?? ''),
      sub: row?.date ?? '',
      snippet: row?.snippet ?? '',
    },
  ));

  const groups = [
    { kind: 'article', label: '订阅', total: articleRows.length, ...take(articleRows, perSource) },
    { kind: 'book', label: '书', total: bookRows.length, ...take(bookRows, perSource) },
    { kind: 'paper', label: '论文', total: paperRows.length, ...take(paperRows, perSource) },
    { kind: 'diary', label: '日记', total: diaryRows.length, ...take(diaryRows, perSource) },
  ].map((group) => (notes[group.kind] ? { ...group, note: notes[group.kind] } : group));

  const total = groups.reduce((sum, group) => sum + group.total, 0);
  return { groups, total, empty: total === 0, scanned };
}

/**
 * 给命中条目挂上「你在它下面写过什么」的反查数（双链）。
 *
 * ★ 这是本功能与「四个搜索框」的区别：搜到一篇文章时，用户真正想知道的往往不是
 *   「这篇文章讲什么」，而是「**我当时怎么想的**」。所以命中旁边直接给出
 *   「2 条笔记」，点一下就能过去。
 * ★ 只在**有**链路时加字段（`links: { notes: 2 }`）。给每条都塞一个 `0`，
 *   界面就得逐条判 0 才不显示 —— 那种判断漏一处的症状是「每条都写着 0 条笔记」。
 *
 * @param {Array} groups - `assembleGroups()` 的输出
 * @param {{articles?: object, books?: object}} links - `{ [key]: 条数 }`
 */
export function attachLinks(groups, links = {}) {
  const articleCounts = links.articles ?? {};
  const bookCounts = links.books ?? {};
  return (Array.isArray(groups) ? groups : []).map((group) => {
    if (group.kind !== 'article' && group.kind !== 'book') return group;
    const table = group.kind === 'article' ? articleCounts : bookCounts;
    return {
      ...group,
      hits: group.hits.map((hit) => {
        const key = group.kind === 'article' ? hit.jump.key : hit.jump.bookId;
        const count = Number(table?.[key]) || 0;
        return count > 0 ? { ...hit, links: { notes: count } } : hit;
      }),
    };
  });
}
