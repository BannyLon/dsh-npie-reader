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

  it('★ 按钮与解释按去处说话（书 / 文章各一句）', () => {
    const book = entryOrigin(BOOK_ENTRY, '2026-10-27');
    const article = entryOrigin(ARTICLE_ENTRY, '2026-10-29');
    assert.equal(originJumpLabel(book), '打开这本书');
    assert.equal(originJumpLabel(article), '跳到这篇文章');
    // 跳不了时说清楚为什么 —— 不能静静少一个按钮，用户会以为功能坏了。
    assert.match(originMissNote(book), /不在书架上/);
    assert.match(originMissNote(article), /不在订阅里/);
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
