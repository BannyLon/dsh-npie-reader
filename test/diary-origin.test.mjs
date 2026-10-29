/**
 * 灵感的「出处」（0.46.0）。
 *
 * 用户 2026-10-29 的原话：
 *   「如果是在 RSS 阅读期间按 L 添加的灵感，那这条点击书籍图标弹出的是什么时间、
 *    在哪篇文章下记录的这条灵感，并有一个直接跳转到这篇文章的按钮」
 *   「如果是我直接在灵感页记录下的灵感，就没必要去往文章上挂，也就是说就不应该有
 *    这个书籍按钮显示，挂书本同理」
 *
 * ★ 这一组测的是**判据**，不是外观：`entryOrigin()` 说「这条有没有出处、是哪一种」，
 *   `originTarget()` 说「能不能去现场」。它们错了在界面上看不出来 ——
 *   多一颗点了没内容的图标 / 少一颗该有的，都不会报错。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { entryOrigin, originJumpLabel, originMissNote, originTarget } from '../src/client/diary-origin.js';
import { stampLabel } from '../src/diary-format.js';

const css = readFileSync(new URL('../src/client/refinements.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/client/DiaryApp.jsx', import.meta.url), 'utf8');

/** 读书时按 L 记的那一条（`QuickCapture` 写的形状）。 */
const BOOK_ENTRY = {
  time: '13:34',
  source: '《译文名著文库》 076[法]雨果-九三年（叶尊译） · 第 19 章',
  book: 'bk_9f3',
  chapter: 19,
  page: 214,
  article: null,
};

/** 读 RSS 时按 L 记的那一条。 */
const ARTICLE_ENTRY = {
  time: '23:43',
  source: '第 294 期 · AI 网络安全恐慌、肯·格里芬泡沫预警',
  book: null,
  chapter: null,
  page: null,
  article: 'rss-294-ai-security',
};

/** 直接在灵感页手记的那一条。 */
const PLAIN_ENTRY = { time: '09:12', source: '', book: null, chapter: null, page: null, article: null };

/**
 * ★ 右侧正文区拿到的**真实形状**：`day()` 原样返回，元数据在 `entry.meta` 下，
 *   顶层没有 `book` / `page`（`timeline()` 才会摊平）。
 *
 * 0.47 只认顶层 ⇒ 正文区每一条的 `bookId` 都是空，卡片弹「这本书已经不在书架上
 * 了」——用户 2026-10-29 就是在书还开着的时候看到这句的。
 */
const DAY_BOOK_ENTRY = {
  time: '16:37',
  kind: '灵感',
  source: '《[20世纪世界诗歌译丛]德瑞克·沃尔科特诗选》',
  meta: { book: 'p2cd920c1a321019b', page: 13 },
  body: '时光爬过忍耐已久的忍耐者',
};

/** `day()` 里的文章条目。 */
const DAY_ARTICLE_ENTRY = {
  time: '17:08',
  kind: '灵感',
  source: '第 503 期 · 数学中的 AI 危机',
  meta: { article: 'feed:5bdce512c55ec9966a093b87e361c74c' },
  body: '三个人，三种表情',
};

describe('0.46：出处 —— 有没有、是哪一种', () => {
  it('★ 书：书名带《》，带上书 id / 章 / 页', () => {
    const origin = entryOrigin(BOOK_ENTRY, '2026-10-27');
    assert.equal(origin.kind, 'book');
    assert.equal(origin.bookId, 'bk_9f3');
    assert.equal(origin.chapter, 19);
    assert.equal(origin.page, 214);
    assert.equal(origin.date, '2026-10-27');
    // ★ 浮层里要显示**完整那一句**（带「· 第 19 章」）：用户问的是「哪一章下记的」，
    //   而 `parseSource()` 会把章切掉（那是分组用的 `title`）。
    assert.equal(origin.source, BOOK_ENTRY.source);
    // 书名号留着：侧栏那一行显示的就是 `item.title`，剥掉反而看不懂。
    assert.equal(origin.title, '《译文名著文库》 076[法]雨果-九三年（叶尊译）');
  });

  it('★ 文章：标题里可能有 ` · `，不能被当成「书名 · 章」切开', () => {
    const origin = entryOrigin(ARTICLE_ENTRY, '2026-10-29');
    assert.equal(origin.kind, 'article');
    assert.equal(origin.articleKey, 'rss-294-ai-security');
    assert.equal(origin.bookId, '');
    // 整串就是标题：`parseSource()` 对没有书名号的来源不做切分。
    assert.equal(origin.title, ARTICLE_ENTRY.source);
  });

  it('★ 手记的灵感：没有出处（`null`），界面上就没有那颗图标', () => {
    assert.equal(entryOrigin(PLAIN_ENTRY, '2026-10-29'), null);
    assert.equal(entryOrigin({ ...PLAIN_ENTRY, source: '   ' }, '2026-10-29'), null, '空白 source 被当成有出处');
    assert.equal(entryOrigin(null, '2026-10-29'), null, '空条目炸了');
    assert.equal(entryOrigin({ ...PLAIN_ENTRY, source: '《》' }, '2026-10-29'), null, '只有书名号也算一个有出处的来源');
  });

  it('★ 只信与 kind 同侧的 id，不拿另一边的字段凑', () => {
    // `source` 写着书、`meta.book` 却是空（0.30 老条目 / 手改过）——
    // 这时没有「去哪里」可跳，但仍然要能看到「出处是什么」。
    const orphan = entryOrigin({ ...BOOK_ENTRY, book: null }, '2026-10-27');
    assert.notEqual(orphan, null, '没有 bookId 就把整条出处丢掉 —— 用户连「哪一章」都看不到了');
    assert.equal(orphan.bookId, '');
    assert.equal(originTarget(orphan), null, '没有 bookId 也给出了跳转目标');
    // 反过来：文章条目带着一个 bookId（历史脏数据）不能变成「打开这本书」。
    const wired = entryOrigin({ ...ARTICLE_ENTRY, book: 'bk_9f3' }, '2026-10-29');
    assert.equal(wired.bookId, '');
    assert.equal(originTarget(wired).kind, 'article');
  });

  it('★ 跳转目标：书带页码/章节，文章带 key', () => {
    const bookTarget = originTarget(entryOrigin(BOOK_ENTRY, '2026-10-27'));
    assert.deepEqual(bookTarget, {
      kind: 'book', bookId: 'bk_9f3', title: '《译文名著文库》 076[法]雨果-九三年（叶尊译）', page: 214, chapter: 19,
    });
    const articleTarget = originTarget(entryOrigin(ARTICLE_ENTRY, '2026-10-29'));
    assert.deepEqual(articleTarget, {
      kind: 'article', key: 'rss-294-ai-security', title: ARTICLE_ENTRY.source,
    });
    assert.equal(originTarget(null), null);
  });

  it('★ 两种条目形状结果必须一致：`day()` 的 meta 嵌套 / `timeline()` 的摊平', () => {
    // ★ 这是 0.47.1 修的那个 bug 的判据。同一条灵感在两侧拿到的是**不同形状**：
    //   侧栏时间轴（`timeline()`）已摊平，右侧正文区（`day()`）原样带 `meta`。
    //   只认一种 ⇒ 一种视图能跳、另一种不能，而界面上没有任何地方看得出为什么。
    const nested = entryOrigin(DAY_BOOK_ENTRY, '2026-10-29');
    const flat = entryOrigin({ ...DAY_BOOK_ENTRY, ...DAY_BOOK_ENTRY.meta, meta: undefined }, '2026-10-29');
    assert.deepEqual(nested, flat, '两种形状认出来的出处不一样 —— 有一侧会「跳不了」');
    assert.equal(nested.bookId, 'p2cd920c1a321019b', '正文区的书 id 没取出来（卡片会诬告「不在书架上」）');
    assert.equal(nested.page, 13);
    assert.equal(nested.chapter, null, '没有章却编了一个');
    // 取出来了才算「能去现场」—— 没有这一颗，用户就只能看不能回。
    assert.deepEqual(originTarget(nested), {
      kind: 'book', bookId: 'p2cd920c1a321019b', title: '[20世纪世界诗歌译丛]德瑞克·沃尔科特诗选', page: 13, chapter: null,
    });

    const nestedArticle = entryOrigin(DAY_ARTICLE_ENTRY, '2026-10-29');
    assert.equal(nestedArticle.articleKey, 'feed:5bdce512c55ec9966a093b87e361c74c');
    assert.equal(originTarget(nestedArticle).kind, 'article', '正文区的文章没取到 key —— 卡片既没有摘要也没有跳转');
  });

  it('★ 按钮与解释按去处说话（书 / 文章各一句）', () => {
    const book = entryOrigin(BOOK_ENTRY, '2026-10-27');
    const article = entryOrigin(ARTICLE_ENTRY, '2026-10-29');
    assert.equal(originJumpLabel(book), '打开这本书');
    assert.equal(originJumpLabel(article), '跳到这篇文章');
    // 跳不了时说清楚为什么 —— 不能静静少一个按钮，用户会以为功能坏了。
    // ★ 而且**不能诬告**：0.47 一律说「这本书已经不在书架上了」，用户在书还开着的
    //   时候看到这句，直接判成 bug。现在的文案只说事实：这条里没记下 id。
    assert.match(originMissNote(book), /没有记下是哪一本书/);
    assert.match(originMissNote(article), /没有记下是哪一篇文章/);
    assert.doesNotMatch(originMissNote(book), /不在书架上/, '还在诬告「书不在书架上」');
    assert.doesNotMatch(originMissNote(article), /不在订阅里/, '还在诬告「文章不在订阅里」');
    // 宿主没接上跳转是**另一件事**，要说另一句话：书在不在一回事，这里能不能开是另一回事。
    assert.match(originMissNote(book, 'no-host'), /当前界面没有接上/);
    assert.notEqual(originMissNote(book, 'no-host'), originMissNote(book), '两种原因给了同一句话');
    assert.equal(originJumpLabel(null), '');
    assert.equal(originMissNote(null), '');
  });
});

describe('0.46：条目上的「日期 + 时刻」', () => {
  it('★ 今天 / 昨天写词，更早写 10-27（只有时刻回答不了「哪天」）', () => {
    assert.equal(stampLabel('2026-10-29', '16:37', '2026-10-29'), '今天 16:37');
    assert.equal(stampLabel('2026-10-27', '13:34', '2026-10-29'), '10-27 13:34');
    assert.equal(stampLabel('2026-01-05', '08:00', ''), '01-05 08:00');
  });

  it('★ 边界：没有时刻只给日期，没有日期只给时刻，非标准日期原样保留', () => {
    assert.equal(stampLabel('2026-10-27', '', '2026-10-29'), '10-27');
    assert.equal(stampLabel('', '16:37', '2026-10-29'), '16:37');
    assert.equal(stampLabel('', '', ''), '');
    // 手改过的文件名不该被这里吞掉（格式不认识就不动它）。
    assert.equal(stampLabel('10/27', '16:37', '2026-10-29'), '10/27 16:37');
  });

  it('★ 反向对照：`today` 没传时不能凭空写出「今天」', () => {
    // 空串是「不知道今天是哪天」的合法值（私有外壳 / 夹具里就是空的）。
    // 把 `today=''` 和 `date=''` 判成相等 ⇒ 每一行都变成「今天 16:37」，看着全对。
    assert.equal(stampLabel('2026-10-29', '16:37', ''), '10-29 16:37');
  });
});

describe('0.46：出处浮层的版式约束', () => {
  it('★ 宽度在 JS 与 CSS 两侧必须同值（浮层第一次出现时量不到自己）', () => {
    assert.match(app, /const ORIGIN_POP_W = (\d+);/);
    const width = Number(RegExp.$1);
    assert.match(css, new RegExp(`\\.npr-diary-pop \\{[^}]*width: ${width}px`),
      `CSS 里的浮层宽度不是 ${width}px —— 定位会用错宽度算出边界`);
  });

  it('★ 浮层是 fixed（坐标是视口坐标），且压在模态之下', () => {
    assert.match(css, /\.npr-diary-pop \{[^}]*position: fixed/, '浮层不是 fixed —— 会跟着列表一起滚走');
    assert.match(css, /\.npr-diary-pop \{[^}]*z-index: 30/, '浮层层级变了 —— 会盖住「展开全文」的模态');
  });
});
