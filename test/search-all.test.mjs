/**
 * 跨源检索的投影、截断与双链（0.88.0，纯函数）。
 *
 * 这里盯三类「不报错」的缺陷：
 *  1. **四路形状不同**：少映射一个字段，界面上就是「书名那里是空的」，而不是报错；
 *  2. **截断不报数**：只回前 5 条不说「还有 12 条」，用户读成「一共就 5 条」；
 *  3. **双链挂错人**：文章按 key、书按 bookId —— 挂错表的话，一篇文章会显示成
 *     「写过 3 条」而它其实一条都没有（另一个 key 的计数被借来了）。
 * 每条都配反向对照。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_QUERY_CHARS, PER_SOURCE_LIMIT, assembleGroups, attachLinks, normalizeQuery,
} from '../src/host/search-all.js';

describe('0.88.0：查询词归一', () => {
  it('trim + 折叠空白 + 截断', () => {
    assert.equal(normalizeQuery('  信任   的代价 '), '信任 的代价');
    assert.equal(normalizeQuery(''), '');
    assert.equal(normalizeQuery(null), '');
    assert.equal(normalizeQuery(42), '');
    assert.equal(normalizeQuery('a'.repeat(500)).length, MAX_QUERY_CHARS);
  });

  it('★ 不切词、不改大小写（四路都按 trim+小写+子串，这里不能变成第五套口径）', () => {
    assert.equal(normalizeQuery('Transformer'), 'Transformer');
    assert.equal(normalizeQuery('信任的代价'), '信任的代价');
  });
});

describe('0.88.0：四路结果投影', () => {
  const articles = [
    { key: 'https://a/1', title: 'Alpha', titleZh: '甲文', channelName: '示例源', snippet: '…甲…', publishedAt: '2026-11-18T00:00:00.000Z', matchedIn: 'body' },
    { key: 'https://a/2', title: 'Beta', channelName: '示例源', snippet: '', matchedIn: 'title' },
  ];
  const books = [
    { bookId: 'b1', bookTitle: '信任的代价', n: 3, chapterTitle: '转折', where: '摘要', snippet: '…赌局…' },
  ];
  const papers = [
    { paper: { id: 'p1', title: 'Sparse Routing', year: 2024, venue: 'NeurIPS' }, snippet: '…routing…' },
  ];
  const diary = [
    { date: '2026-11-17', index: 2, kind: '读后感', source: '《信任的代价》', snippet: '…我想到…' },
  ];

  it('★ 每一路都映射成同一个形状（id / title / sub / snippet / jump）', () => {
    const { groups } = assembleGroups({ articles, books, papers, diary });
    const byKind = new Map(groups.map((group) => [group.kind, group]));
    assert.deepEqual(groups.map((group) => group.kind), ['article', 'book', 'paper', 'diary']);
    assert.deepEqual(groups.map((group) => group.label), ['订阅', '书', '论文', '日记']);

    const article = byKind.get('article').hits[0];
    assert.equal(article.title, '甲文', '有中文标题时优先用它');
    assert.equal(article.sub, '示例源');
    assert.equal(article.jump.kind, 'article');
    assert.equal(article.jump.key, 'https://a/1');
    assert.ok(article.at > 0, '发布时间没转成毫秒');

    const book = byKind.get('book').hits[0];
    assert.equal(book.title, '信任的代价');
    assert.ok(book.sub.includes('第 3 章') && book.sub.includes('摘要命中'), '书的副标题要能解释「为什么搜出来」');
    assert.deepEqual(book.jump, { kind: 'book', bookId: 'b1', chapter: 3 });

    const paper = byKind.get('paper').hits[0];
    assert.equal(paper.title, 'Sparse Routing');
    assert.ok(paper.sub.includes('2024'));
    assert.equal(paper.jump.paperId, 'p1');

    const note = byKind.get('diary').hits[0];
    assert.equal(note.title, '读后感 · 《信任的代价》');
    assert.equal(note.sub, '2026-11-17');
    assert.deepEqual(note.jump, { kind: 'diary', date: '2026-11-17', index: 2, scope: 'public' });
  });

  it('★ 截断要报出「还有多少」', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, title: `第 ${index} 篇` }));
    const { groups } = assembleGroups({ articles: many });
    const group = groups.find((item) => item.kind === 'article');
    assert.equal(group.hits.length, PER_SOURCE_LIMIT);
    assert.equal(group.total, 9);
    assert.equal(group.hidden, 4, '被折叠的条数必须报出来，否则用户读成「一共 5 条」');
  });

  it('反向对照：没被截断时 hidden 是 0，且 total 等于命中数', () => {
    const { groups, total } = assembleGroups({ articles });
    assert.equal(groups.find((item) => item.kind === 'article').hidden, 0);
    assert.equal(total, 2);
  });

  it('空结果：四组都在、empty 为 true（不是「返回空数组」让界面自己猜）', () => {
    const result = assembleGroups({});
    assert.equal(result.total, 0);
    assert.equal(result.empty, true);
    assert.equal(result.groups.length, 4, '四组必须都在 —— 界面靠它画「这一类没有」');
  });

  it('★ 某一路失败时的备注留在那一组上，不合并成一句', () => {
    const { groups } = assembleGroups({ articles, notes: { book: '这次没搜到（目录坏了）' } });
    const book = groups.find((item) => item.kind === 'book');
    assert.equal(book.note, '这次没搜到（目录坏了）');
    // 反向对照：没有备注的组不能凭空多出一个空 note（界面会画一行空白）。
    assert.equal(groups.find((item) => item.kind === 'article').note, undefined);
  });

  it('形状缺失的输入不炸（paper 直接给扁平的 id/title）', () => {
    const { groups } = assembleGroups({ papers: [{ id: 'p9', title: '扁平' }] });
    const paper = groups.find((item) => item.kind === 'paper').hits[0];
    assert.equal(paper.title, '扁平');
    assert.equal(paper.jump.paperId, 'p9');
  });
});

describe('0.88.0：双链（你在这篇下写过几条）', () => {
  const base = () => assembleGroups({
    articles: [{ key: 'https://a/1', title: '甲' }, { key: 'https://a/2', title: '乙' }],
    books: [{ bookId: 'b1', bookTitle: '书一', n: 1 }, { bookId: 'b2', bookTitle: '书二', n: 2 }],
  }).groups;

  it('★ 按各自的表挂：文章用 key、书用 bookId', () => {
    const groups = attachLinks(base(), {
      articles: { 'https://a/1': 3 },
      books: { b2: 1 },
    });
    const articles = groups.find((item) => item.kind === 'article').hits;
    const books = groups.find((item) => item.kind === 'book').hits;
    assert.equal(articles[0].links?.notes, 3);
    assert.equal(articles[1].links, undefined, '没有链接的条目不该挂 0');
    assert.equal(books[1].links?.notes, 1);
    assert.equal(books[0].links, undefined);
  });

  it('★ 反向对照：交叉挂错表就会被这条抓住', () => {
    // 如果实现把「文章 key」拿去查书的表，b1 的计数就会跑到某篇文章上。
    const groups = attachLinks(base(), { articles: {}, books: { b1: 5 } });
    const articles = groups.find((item) => item.kind === 'article').hits;
    assert.equal(articles.every((hit) => hit.links === undefined), true, '书的计数被挂到文章上了');
  });

  it('计数为 0 或非数字时不挂（否则界面每条都写「写过 0 条」）', () => {
    const groups = attachLinks(base(), { articles: { 'https://a/1': 0, 'https://a/2': 'x' } });
    const articles = groups.find((item) => item.kind === 'article').hits;
    assert.equal(articles.every((hit) => hit.links === undefined), true);
  });

  it('论文与日记组原样返回（它们没有反向链接）', () => {
    const groups = attachLinks(base(), { articles: {}, books: {} });
    const papers = groups.find((item) => item.kind === 'paper');
    assert.equal(papers.hits.length, 0);
    assert.equal(papers.links, undefined);
  });
});
