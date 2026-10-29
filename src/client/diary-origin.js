/**
 * 一条灵感的**出处**（0.46.0）：它是从哪本书 / 哪篇文章里记下的。
 *
 * ★ 为什么单独成一个文件：这是「要不要显示那颗图标」的唯一判据，而它错了
 *   在界面上**看不出来** —— 没有出处的条目多一颗点了没内容的图标、有出处的条目
 *   少了那颗图标，两种错都不会报错，只会让人多点两下。放成纯函数才测得动。
 *
 * ★ 为什么不是「挂到书上」那个功能（0.44 及之前）：
 *   用户 2026-10-29 的原话：「我选择的是在 RSS 文章生成的灵感，点击这个书图片
 *   弹出的窗口竟然还有电子书列表，这太荒唐」；追问手记的灵感要不要保留挂书入口时，
 *   他答：「如果是手记的灵感不是在书本和文章里记录的灵感，就没必要挂在了啊」。
 *   ⇒ 出处是**读的时候自动记下的**（`QuickCapture` 写 `source` 与 `meta`），
 *     不是事后挂的。所以这里只有「读出来」，没有「写回去」。
 */

import { parseSource } from '../diary-format.js';

/**
 * 把一条日记条目归一成「出处」。没有出处（直接在灵感页记的）返回 `null`。
 *
 * @param {object} entry 日记条目（`timeline()` / `day()` 的形状：带 source / meta 展开的字段）
 * @param {string} date 这一条属于哪天（`YYYY-MM-DD`）。列表接口里条目本身不带日期。
 * @returns {null | {kind:'book'|'article', title:string, label:string, source:string,
 *   date:string, time:string, bookId:string, chapter:number|null, page:number|null, articleKey:string}}
 */
export function entryOrigin(entry, date = '') {
  const source = typeof entry?.source === 'string' ? entry.source.trim() : '';
  if (source === '') return null;
  const parsed = parseSource(source);
  if (parsed === null) return null;
  const kind = parsed.isBook ? 'book' : 'article';
  /**
   * ★ 同一条灵感有**两种形状**，两边都得认（0.47.1 的 bug 就出在这儿）：
   *   · `timeline()` / `bySource()` 的条目 —— `meta` 已被摊平，`book / chapter /
   *     page / article` 在**顶层**（侧栏时间轴用的是这一种）；
   *   · `day()` 的条目 —— 原样，元数据在 **`entry.meta`** 里（右侧正文区用的是
   *     这一种）。
   *   0.47 只读了顶层，于是正文区每一条的 `bookId` 都是空 ⇒ 卡片永远没有「打开这本
   *   书」，还弹一句「这本书已经不在书架上了」—— 用户 2026-10-29 当场指出：
   *   「书在阅读栏啊」。书在，是这里没认出来。
   *   取 `meta` 优先（那是文件里真正写下的那一份），顶层兜底。
   */
  const field = (name) => (entry?.meta?.[name] ?? entry?.[name]);
  const book = field('book');
  const chapter = field('chapter');
  const page = field('page');
  const article = field('article');
  return {
    kind,
    title: parsed.title,
    label: parsed.label,
    // 原始那串给人看的出处（书带上「· 第 19 章」）。`parseSource` 会把章切掉，
    // 而浮层里要显示的正是完整的那一句 —— 用户问的是「在哪篇文章 / 哪一章下记的」。
    source,
    date: typeof date === 'string' && date !== '' ? date : (typeof entry?.date === 'string' ? entry.date : ''),
    time: typeof entry?.time === 'string' ? entry.time : '',
    // ★ 只信与 kind 同侧的 id：`source` 说是书、`meta.book` 却是空（老条目或手改过），
    //   那就没有「去哪里」可跳，不能拿另一个字段凑一个出来。
    bookId: kind === 'book' && typeof book === 'string' ? book : '',
    chapter: kind === 'book' && Number.isInteger(chapter) ? chapter : null,
    page: kind === 'book' && Number.isInteger(page) ? page : null,
    articleKey: kind === 'article' && typeof article === 'string' ? article : '',
  };
}

/**
 * 有这个出处的一侧，能不能**去现场**（打开那本书 / 那一篇）。
 *
 * ★ 分开判而不是在界面上写 `origin.bookId !== ''`：两种出处的字段名不同，
 *   写两遍必然有一遍写错，而错了的表现是「点一下什么都不发生」。
 * ★ 不能跳不代表坏：0.30 之前的老条目只有书名（`source` 里那串文字），
 *   那时还没有 `meta.book`。这种也要能看到「出处是什么」，只是没有按钮。
 */
export function originTarget(origin) {
  if (origin === null || typeof origin !== 'object') return null;
  if (origin.kind === 'book') {
    if (origin.bookId === '') return null;
    return {
      kind: 'book', bookId: origin.bookId, title: origin.title, page: origin.page, chapter: origin.chapter,
    };
  }
  if (origin.kind === 'article') {
    if (origin.articleKey === '') return null;
    return { kind: 'article', key: origin.articleKey, title: origin.title };
  }
  return null;
}

/** 浮层里那颗按钮上写什么。按去处说话，而不是按出处类型说话。 */
export function originJumpLabel(origin) {
  if (origin === null || typeof origin !== 'object') return '';
  return origin.kind === 'book' ? '打开这本书' : '跳到这篇文章';
}

/**
 * 条目头上那颗图标的**名字**。
 *
 * ★ 图标名是**数据**，不写成 JSX 里的三元表达式：`test/icons.test.mjs` 会把
 *   `name={…}` 里的每个字符串字面量当图标名去查 —— 三元里 `origin.kind === 'book'`
 *   那个 `'book'` 也会被当成图标名，查不到就红（0.45.4 在右键菜单上踩过一次）。
 * ★ 图标跟着**出处**走：书用 `book-open`、文章用 `file-text`。它与侧栏切换器上
 *   那两个图标同源，用户在两处看到的是同一个符号。
 */
export function originIcon(origin) {
  if (origin === null || typeof origin !== 'object') return '';
  return origin.kind === 'book' ? 'book-open' : 'file-text';
}

/**
 * 跳不了时那句解释（说清楚「为什么没有按钮」，而不是静静少一个按钮）。
 *
 * ★ 0.47 只有一句「这本书已经不在书架上了」。它把**三种**不同的原因说成了同一种，
 *   而最常见的那种根本不是那回事 —— 用户 2026-10-29 就是在书还开着的时候看到
 *   这句话的（真因是 `entryOrigin()` 没认出 `day()` 形状的条目，见上）。
 *   文案诬告一次，后面再说什么都不被信了。
 *
 * @param {object} origin `entryOrigin()` 的返回
 * @param {'missing-id'|'no-host'} reason 缺 id（老条目）/ 宿主没接上跳转
 */
export function originMissNote(origin, reason = 'missing-id') {
  if (origin === null || typeof origin !== 'object') return '';
  if (reason === 'no-host') return '这里打不开它 —— 当前界面没有接上「打开书 / 打开文章」。';
  return origin.kind === 'book'
    ? '这条灵感里没有记下是哪一本书，只能在这里看出处。'
    : '这条灵感里没有记下是哪一篇文章，只能在这里看出处。';
}
