/**
 * 书架的**共用判据**（`src/library.js`）—— 宿主半区与浏览器半区 import 同一份。
 *
 * ★ 为什么这一份要测得细：这个文件存在的唯一理由就是「同一个判据不能在两处各写一遍」。
 *   一旦它的行为变了（比如 `matchesQuery` 不再匹配丛书名），**两端会同时**变 —— 所以
 *   这里没有「另一边会兜住」这种保险，测试就是唯一的保险。
 *
 * ★ 本文件末尾有一条**结构性**断言（`src/library.js` 不许出现 Node / 浏览器 API）。
 *   这是少数「源码字符串断言是对的工具」的场合：契约本身就是「文件里有什么」——
 *   它被浏览器半区 import，混进一个 `node:fs` 就会把整个客户端 bundle 拖上一堆 shim，
 *   而那件事在 Node 里跑测试时**完全不会报错**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';
import {
  BOOK_EXTENSIONS,
  BOOK_LIST_NAME_MAX,
  BOOK_SOURCE_KINDS,
  BOOK_SOURCE_LABELS,
  BOOK_SOURCES_MAX,
  BOOK_STATE_LABELS,
  BOOK_STATE_MARKS,
  BOOK_STATES,
  BOOKS_PAGE_LIMIT,
  applyStatePatch,
  bookIdFromPath,
  bookRowView,
  defaultSourceName,
  emptyState,
  filterBooks,
  formatBytes,
  groupBooks,
  hasFinished,
  isBookId,
  isReadable,
  addedBooks,
  isAdded,
  LIBRARY_API_PREFIX,
  LIBRARY_PATH_DEFAULT,
  libraryStats,
  matchesQuery,
  mergeImportedStates,
  normalizeBook,
  normalizeBookSource,
  normalizeBookSources,
  normalizeExtension,
  normalizeLibraryListIds,
  normalizeState,
  readingProgressLabel,
  PDFJS_VENDOR_PREFIX,
  progressPercent,
  READING_STATE_FILTERS,
  sourceListId,
  sourceTotals,
  stateOf,
  stateRank,
  titleFromFilename,
} from '../src/library.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 一条接近真机形态的原始索引记录（键名照抄 ebook-sorter/data/books.json）。 */
function rawBook(overrides = {}) {
  return {
    id: 'b00001',
    filename: '忧郁的热带_20201020_174427.pdf',
    relpath: '欧洲文学/忧郁的热带.pdf',
    abspath: '',
    pan_path: '/我的资源/电子书/欧洲文学/忧郁的热带.pdf',
    fs_id: 123456789,
    ext: 'pdf',
    size: 14_140_000,
    top_dir: '欧洲文学',
    existing_region: '',
    series: '文化生活译丛',
    year: 2000,
    title: '忧郁的热带',
    ...overrides,
  };
}

describe('id 与扩展名判据', () => {
  it('isBookId 只认 1–64 位字母数字下划线连字符', () => {
    assert.equal(isBookId('b00001'), true);
    assert.equal(isBookId('b-1_2'), true);
    assert.equal(isBookId(''), false);
    assert.equal(isBookId('a'.repeat(65)), false);
    assert.equal(isBookId('a/b'), false);
    assert.equal(isBookId('a b'), false);
    assert.equal(isBookId(123), false);
    assert.equal(isBookId(undefined), false);
  });

  it('normalizeExtension 去掉前导点、大小写不敏感，不认识的回空串', () => {
    assert.equal(normalizeExtension('PDF'), 'pdf');
    assert.equal(normalizeExtension('.Epub'), 'epub');
    assert.equal(normalizeExtension('  pdf  '), 'pdf');
    assert.equal(normalizeExtension('exe'), '');
    assert.equal(normalizeExtension(undefined), '');
  });

  it('BOOK_EXTENSIONS 与 normalizeExtension 的结果集一致（集合基数 + 逐项性质）', () => {
    assert.equal(BOOK_EXTENSIONS.length, 7);
    for (const ext of BOOK_EXTENSIONS) assert.equal(normalizeExtension(ext), ext);
    // 反向：任何一个被接受的输入，结果必然落在这个集合里 —— 否则 `filterBooks`
    // 的扩展名筛选会出现「选了却筛不出来」的项。
    for (const probe of ['PDF', '.epub', 'txt', 'azw3']) {
      assert.ok(BOOK_EXTENSIONS.includes(normalizeExtension(probe)), `${probe} 不在集合里`);
    }
  });
});

describe('titleFromFilename', () => {
  it('去掉扩展名与扫盘时加的时间后缀', () => {
    assert.equal(titleFromFilename('忧郁的热带_20201020_174427.pdf'), '忧郁的热带');
    assert.equal(titleFromFilename('Book Title.epub'), 'Book Title');
  });

  it('时间后缀只认「8 位日期 + 6 位时间」，别的下划线后缀保留', () => {
    assert.equal(titleFromFilename('Volume_2.pdf'), 'Volume_2');
    assert.equal(titleFromFilename('A_20201020.pdf'), 'A_20201020');
  });

  it('空值不抛错', () => {
    assert.equal(titleFromFilename(undefined), '');
    assert.equal(titleFromFilename(''), '');
  });
});

describe('normalizeBook', () => {
  it('把真机形态的记录规范化成界面用的形状', () => {
    const book = normalizeBook(rawBook());
    assert.deepEqual(book, {
      id: 'b00001',
      title: '忧郁的热带',
      filename: '忧郁的热带_20201020_174427.pdf',
      ext: 'pdf',
      size: 14_140_000,
      fsId: 123456789,
      localPath: '',
      // 有 fs_id ⇒ 网盘书。界面不用管这个字段，取字节那一层靠它分派。
      source: 'pan',
      panPath: '/我的资源/电子书/欧洲文学/忧郁的热带.pdf',
      series: '文化生活译丛',
      year: 2000,
      topDir: '欧洲文学',
      renderable: true,
    });
  });

  it('没有合法 id 的记录一律丢掉（宁可缺一条，也不要造一个点进去必然报错的条目）', () => {
    assert.equal(normalizeBook(rawBook({ id: '' })), undefined);
    assert.equal(normalizeBook(rawBook({ id: 'a b' })), undefined);
    assert.equal(normalizeBook(rawBook({ id: undefined })), undefined);
    assert.equal(normalizeBook(null), undefined);
    assert.equal(normalizeBook('nope'), undefined);
  });

  it('书名缺字段时逐级兜底：title → 文件名清洗 → id', () => {
    assert.equal(normalizeBook(rawBook({ title: '' })).title, '忧郁的热带');
    assert.equal(normalizeBook(rawBook({ title: '', filename: '' })).title, 'b00001');
  });

  it('fsId 不是正整数时归 0（而不是留一个 NaN 让 `fsId > 0` 变成 false 的兄弟形态）', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '12abc', undefined, null, {}, []]) {
      const book = normalizeBook(rawBook({ fs_id: bad }));
      assert.equal(book.fsId, 0, `fs_id=${String(bad)} 应当归 0`);
    }
    // 反向对照：数字字符串**故意**接受（JSON 往返、手改索引都可能带引号），
    // 而 `Number('123')` 是精确的 —— 这不是「脏值」。
    assert.equal(normalizeBook(rawBook({ fs_id: '123' })).fsId, 123);
  });

  it('★ renderable 是「能打开来读（PDF 或重排电子书）且能取到字节」', () => {
    assert.equal(normalizeBook(rawBook({ ext: 'pdf' })).renderable, true);
    // 反向对照：光看扩展名就置 true 的实现会让用户点开一本读不了的书。
    // ★ 必须把 fs_id / abspath / relpath **三条全清掉**才算「取不到字节」：夹具默认带
    //   `relpath`，而新判据在「没有 fs_id」时把它当成本地路径（见 src/library.js 里
    //   「abspath 优先、只有没有 fs_id 时才退到 relpath」那段）。只清 fs_id 会假失败。
    assert.equal(
      normalizeBook(rawBook({ ext: 'pdf', fs_id: 0, abspath: '', relpath: '' })).renderable,
      false,
    );
    // 0.25.0 起 EPUB / MOBI / AZW3 / AZW / TXT 也能读了（重排，不是原版式），
    // 判据与 `EBOOK_EXTENSIONS` **同源** —— 加一个格式只改那一处。
    for (const ext of ['epub', 'mobi', 'azw3', 'azw', 'txt']) {
      assert.equal(normalizeBook(rawBook({ ext })).renderable, true, `${ext} 应当可读`);
      assert.equal(
        normalizeBook(rawBook({ ext, fs_id: 0, abspath: '', relpath: '' })).renderable,
        false,
        `${ext} 取不到字节时不得可读`,
      );
    }
    // 反向对照：`.docx` 仍是「列得出来、读不了」—— 它是文档不是书。
    assert.equal(normalizeBook(rawBook({ ext: 'docx' })).renderable, false);
  });

  it('★ 本地源的书（有 relpath、没有 fs_id）必须可渲染 —— 否则本地书单接进来全是「打不开」', () => {
    const local = normalizeBook(rawBook({ fs_id: 0, abspath: '', relpath: '欧洲文学/忧郁的热带.pdf' }));
    assert.equal(local.localPath, '欧洲文学/忧郁的热带.pdf');
    assert.equal(local.source, 'local');
    assert.equal(local.renderable, true);
    assert.equal(isReadable(local), true);

    // 反向对照：有 fs_id 时**不许**退到 relpath。`relpath` 在两个生成器里含义不同 ——
    // 网盘列表器写的是网盘路径，无条件采用会让取字节那层去本地磁盘上找
    // `/我的资源/电子书/…`，报一句谁也看不懂的错。
    const pan = normalizeBook(rawBook({ fs_id: 123, abspath: '' }));
    assert.equal(pan.localPath, '', '有 fs_id 时 relpath 不得被当成本地路径');
    assert.equal(pan.source, 'pan');
    // `abspath` 则是真信息（用户本地也存了一份），有 fs_id 时照样认。
    assert.equal(normalizeBook(rawBook({ fs_id: 123, abspath: '/tmp/a.pdf' })).localPath, '/tmp/a.pdf');

    // 反向对照：两条凭据都空 ⇒ source 是空串（而不是硬说成某一种来源）。
    assert.equal(normalizeBook(rawBook({ fs_id: 0, abspath: '', relpath: '' })).source, '');
  });

  it('扩展名缺失时从文件名后缀推', () => {
    assert.equal(normalizeBook(rawBook({ ext: undefined })).ext, 'pdf');
    // ★ 空串也要回退 —— `??` 不认空串（见 src/library.js 里那段注释）。
    assert.equal(normalizeBook(rawBook({ ext: '', filename: 'x.epub' })).ext, 'epub');
    assert.equal(normalizeBook(rawBook({ ext: '   ', filename: 'x.azw3' })).ext, 'azw3');
    // 两边都给不出时是空串，而不是文件名本身。
    assert.equal(normalizeBook(rawBook({ ext: '', filename: 'README' })).ext, '');
    assert.equal(normalizeBook(rawBook({ ext: '', filename: '' })).ext, '');
  });

  it('size / year 的脏值归零，而不是把 NaN 带进界面', () => {
    assert.equal(normalizeBook(rawBook({ size: 'big' })).size, 0);
    assert.equal(normalizeBook(rawBook({ size: -5 })).size, 0);
    assert.equal(normalizeBook(rawBook({ year: 'MMXX' })).year, 0);
    assert.equal(normalizeBook(rawBook({ year: 2000.5 })).year, 0);
  });

  it('isReadable 认「网盘有 fsId」或「本地有路径」两种来源', () => {
    assert.equal(isReadable(normalizeBook(rawBook())), true);
    assert.equal(isReadable(normalizeBook(rawBook({ fs_id: 0, abspath: '/tmp/a.pdf' }))), true);
    // ★ 三条凭据全空才算读不了（夹具默认带 relpath，只清 fs_id 会假失败）。
    assert.equal(isReadable(normalizeBook(rawBook({ fs_id: 0, abspath: '', relpath: '' }))), false);
    assert.equal(isReadable(undefined), false);
    // ★ 反向对照：字段**缺失**（而不是空串）时也必须是「读不了」。写成
    //   `book.localPath !== ''` 的实现会让 `undefined !== ''` 为真，在这里假绿 ——
    //   `library-routes` 的 `GET /book/:id/raw` 用例就是这么抓到过一次的。
    assert.equal(isReadable({ fsId: 0 }), false);
    assert.equal(isReadable({ fsId: 0, localPath: undefined }), false);
    assert.equal(isReadable({ fsId: 0, localPath: '   ' }), false);
    assert.equal(isReadable({}), false);
  });
});

describe('matchesQuery', () => {
  const book = normalizeBook(rawBook());

  it('书名 / 文件名 / 丛书名 三处都能命中（用户记得的可能是任何一个）', () => {
    assert.equal(matchesQuery(book, '忧郁'), true);
    assert.equal(matchesQuery(book, '20201020'), true);
    assert.equal(matchesQuery(book, '文化生活译丛'), true);
  });

  it('大小写不敏感，两侧 trim（粘贴带空格是常态）', () => {
    const en = normalizeBook(rawBook({ title: 'The Raw and the Cooked' }));
    assert.equal(matchesQuery(en, 'raw'), true);
    assert.equal(matchesQuery(en, '  RAW  '), true);
  });

  it('空查询命中全部', () => {
    assert.equal(matchesQuery(book, ''), true);
    assert.equal(matchesQuery(book, '   '), true);
    assert.equal(matchesQuery(book, undefined), true);
  });

  it('反向对照：不相关的词不命中', () => {
    assert.equal(matchesQuery(book, '量子力学'), false);
  });
});

describe('filterBooks', () => {
  const books = [
    normalizeBook(rawBook({ id: 'b1', title: 'Beta', ext: 'pdf', size: 300, year: 1990 })),
    normalizeBook(rawBook({ id: 'b2', title: 'Alpha', ext: 'epub', size: 100, year: 2010 })),
    normalizeBook(rawBook({ id: 'b3', title: 'Gamma', ext: 'pdf', size: 200, year: 2000 })),
  ];
  const states = { b1: { state: 'read', at: 30 }, b2: { state: 'reading', at: 10 } };

  it('不改入参（返回新数组）', () => {
    const before = books.map((b) => b.id);
    filterBooks(books, { sort: 'size' });
    assert.deepEqual(books.map((b) => b.id), before);
  });

  it('按扩展名筛', () => {
    assert.deepEqual(filterBooks(books, { ext: 'pdf' }).map((b) => b.id), ['b1', 'b3']);
    assert.deepEqual(filterBooks(books, { ext: '' }).length, 3);
  });

  it('按阅读状态筛 —— 缺省（表里没有）算「未读」', () => {
    assert.deepEqual(filterBooks(books, { state: 'unread', states }).map((b) => b.id), ['b3']);
    assert.deepEqual(filterBooks(books, { state: 'read', states }).map((b) => b.id), ['b1']);
    assert.deepEqual(filterBooks(books, { state: 'reading', states }).map((b) => b.id), ['b2']);
  });

  it('搜索与筛选是**与**的关系', () => {
    assert.deepEqual(filterBooks(books, { query: 'a', ext: 'pdf', states }).map((b) => b.id), ['b1', 'b3']);
  });

  it('排序：title / size / year / state / recent', () => {
    assert.deepEqual(filterBooks(books, { sort: 'title' }).map((b) => b.id), ['b2', 'b1', 'b3']);
    assert.deepEqual(filterBooks(books, { sort: 'size' }).map((b) => b.id), ['b1', 'b3', 'b2']);
    assert.deepEqual(filterBooks(books, { sort: 'year' }).map((b) => b.id), ['b2', 'b3', 'b1']);
    // state 顺序：在读(0) > 未读(1) > 读完(2) > 弃读(3)
    assert.deepEqual(filterBooks(books, { sort: 'state', states }).map((b) => b.id), ['b2', 'b3', 'b1']);
    // recent：按 at 倒序，从没读过的排最后
    assert.deepEqual(filterBooks(books, { sort: 'recent', states }).map((b) => b.id), ['b1', 'b2', 'b3']);
  });

  it('不认识的 sort 退回按书名，而不是原样返回（否则界面上的排序下拉会静默失效）', () => {
    assert.deepEqual(filterBooks(books, { sort: 'nonsense' }).map((b) => b.id), ['b2', 'b1', 'b3']);
  });
});

describe('groupBooks', () => {
  const books = [
    normalizeBook(rawBook({ id: 'b1', top_dir: '欧洲文学', series: 'S1', ext: 'pdf', year: 2000 })),
    normalizeBook(rawBook({ id: 'b2', top_dir: '欧洲文学', series: 'S2', ext: 'epub', year: 2000 })),
    normalizeBook(rawBook({ id: 'b3', top_dir: '亚洲文学', series: '', ext: 'pdf', year: 0 })),
  ];

  it('按 topDir / series / ext / year 分组，按条目数倒序', () => {
    assert.deepEqual(groupBooks(books, 'topDir'), [
      { key: '欧洲文学', label: '欧洲文学', count: 2 },
      { key: '亚洲文学', label: '亚洲文学', count: 1 },
    ]);
    assert.deepEqual(groupBooks(books, 'ext'), [
      { key: 'pdf', label: 'pdf', count: 2 },
      { key: 'epub', label: 'epub', count: 1 },
    ]);
    assert.deepEqual(groupBooks(books, 'year'), [{ key: '2000', label: '2000', count: 2 }]);
  });

  it('空值与 0 的条目**不进任何分组**（而不是造一个名字是空串的分组）', () => {
    assert.deepEqual(groupBooks(books, 'series'), [
      { key: 'S1', label: 'S1', count: 1 },
      { key: 'S2', label: 'S2', count: 1 },
    ]);
  });

  it('不认识的维度回空数组', () => {
    assert.deepEqual(groupBooks(books, 'nope'), []);
  });
});

describe('阅读状态', () => {
  it('BOOK_STATES 与标签表一一对应（集合基数 + 每项都有标签）', () => {
    assert.deepEqual(BOOK_STATES, ['unread', 'reading', 'read', 'dropped']);
    for (const state of BOOK_STATES) {
      assert.equal(typeof BOOK_STATE_LABELS[state], 'string');
      assert.notEqual(BOOK_STATE_LABELS[state], '');
    }
    assert.equal(Object.keys(BOOK_STATE_LABELS).length, BOOK_STATES.length);
  });

  it('stateRank 顺序固定：在读 > 未读 > 读完 > 弃读；不认识的值按未读', () => {
    assert.ok(stateRank('reading') < stateRank('unread'));
    assert.ok(stateRank('unread') < stateRank('read'));
    assert.ok(stateRank('read') < stateRank('dropped'));
    assert.equal(stateRank('finished'), stateRank('unread'));
  });

  it('normalizeState 是**读旧数据**的兜底：不认识的状态退回未读，不抛错', () => {
    // `added: true` 来自「有进度就算已加入」的老数据兜底（专项用例见下面的「阅读」列表一节）。
    assert.deepEqual(normalizeState({ state: 'finished', page: 3 }), { state: 'unread', page: 3, pages: 0, at: 0, finishedAt: 0, added: true, scanned: false });
    assert.deepEqual(normalizeState(null), emptyState());
    assert.deepEqual(normalizeState('nope'), emptyState());
  });

  it('normalizeState 夹掉脏数字（负数 / 小数 / 字符串数字）', () => {
    assert.deepEqual(normalizeState({ state: 'reading', page: -1, pages: 2.5, at: -9 }), {
      state: 'reading', page: 0, pages: 0, at: 0, finishedAt: 0, added: true, scanned: false,
    });
    assert.deepEqual(normalizeState({ state: 'reading', page: '12', pages: '350' }), {
      state: 'reading', page: 12, pages: 350, at: 0, finishedAt: 0, added: true, scanned: false,
    });
  });

  /**
   * `finishedAt` 是「读完过」的唯一凭据（0.44.3），只认**正数时间戳**。
   *
   * ★ 和 `scanned` 同一条道理：写成 `'true'`、`'yes'` 这类真值，或 `-1` 这种负数，
   *   都会让一本没读完的书被判成「读完过」—— 于是它出现在读后感列表里，
   *   而用户从来没读完过。假话在界面上的表现是「凭空多出一本书」。
   */
  it('finishedAt 只认真正的正数（脏值一律归 0，不猜）', () => {
    assert.equal(normalizeState({ finishedAt: 1710000000000 }).finishedAt, 1710000000000);
    /**
     * ★ 刻意**与 `page` / `at` 的处理不一样**：那三个字段走 `Number()`，因为它们只
     *   影响显示；这个字段是门禁（决定一本书出现在不在读后感列表里）。
     *   `Number(true) === 1`、`Number('1') === 1` 都是正数 —— 一个写错位的布尔值
     *   就能让没读完的书出现在读后感里。所以这里只收真数字，其余一律归 0。
     */
    for (const dirty of ['1710000000000', '1', 'yes', true, -1, 0, null, undefined, NaN, {}, []]) {
      assert.equal(normalizeState({ finishedAt: dirty }).finishedAt, 0,
        `finishedAt=${JSON.stringify(dirty)} 被当成了「读完过」`);
    }
  });

  /**
   * 「曾经读完过」是**不可逆**的事实（0.44.3，用户 2026-10-28 的要求）。
   *
   * ★ 这条写的是**状态机**，不是格式化：`applyStatePatch` 是宿主写盘与浏览器
   *   乐观更新的唯一入口，所以「重新阅读不会抹掉读完史」只在它这里成立一次，
   *   全链路就都成立。
   * ★ 走一遍真实顺序：标记读完 → 重新阅读 → 再标记读完 → 弃读。最后仍要
   *   `finishedAt > 0`，而 `state` 是 `dropped`（用户确实弃读了，这个也要如实反映）。
   */
  it('applyStatePatch：标记读完写下 finishedAt，之后的任何写入都不抹掉它', () => {
    const T1 = 1710000000001;
    const marked = applyStatePatch(emptyState(), { state: 'read' }, T1);
    assert.equal(marked.state, 'read');
    assert.equal(marked.finishedAt, T1, '标记读完没有记下读完时间');
    assert.equal(marked.at, T1);

    // 「重新阅读」只改 state —— 读完史必须还在，否则读后感列表会当场少一本。
    const reading = applyStatePatch(marked, { state: 'reading' }, T1 + 1000);
    assert.equal(reading.state, 'reading');
    assert.equal(reading.finishedAt, T1, '「重新阅读」把读完史抹掉了');
    assert.equal(reading.at, T1 + 1000, 'at 应该跟着这次写入走');

    // 再读一遍、再读完：finishedAt 仍记**第一次**读完的时间（那是这条事实的起点）。
    const again = applyStatePatch(reading, { state: 'read' }, T1 + 5000);
    assert.equal(again.finishedAt, T1, '第二次标记读完覆盖了首次时间');

    // 弃读、移出再添加，同样不许清掉。
    const dropped = applyStatePatch(again, { state: 'dropped' }, T1 + 9000);
    assert.equal(dropped.finishedAt, T1);
    const removed = applyStatePatch(dropped, { added: false }, T1 + 9000);
    assert.equal(removed.finishedAt, T1, '移出「阅读」把读完史抹掉了');
    assert.equal(removed.added, false);
  });

  it('applyStatePatch：老数据里 state=read 但没时间戳，离开 read 的那一刻补记', () => {
    // 0.44.3 之前标记读完的书只有 `state: 'read'`。用户第一次点「重新阅读」时
    // 正是它离开 `read` 的那一刻 —— 不在这里补，就再也没有机会补了。
    const legacy = { state: 'read', page: 40, pages: 300, added: true };
    const reading = applyStatePatch(legacy, { state: 'reading' }, 1710000000777);
    assert.equal(reading.finishedAt, 1710000000777, '老数据离开 read 时没有补记读完史');
    assert.equal(reading.page, 40, '补记不该动进度');
  });

  it('applyStatePatch：finishedAt 不接受调用方给的值（传 0 清不掉，传大数也伪造不了）', () => {
    const marked = applyStatePatch(emptyState(), { state: 'read' }, 1710000000123);
    assert.equal(applyStatePatch(marked, { finishedAt: 0 }, 1710000000456).finishedAt, 1710000000123);
    assert.equal(applyStatePatch(marked, { finishedAt: 9e12 }, 1710000000456).finishedAt, 1710000000123,
      '调用方能直接写 finishedAt —— 一个手写请求就能让没读完的书进读后感列表');
    // 从没读完过的书记不住任何时间戳，哪怕请求里带了一个。
    assert.equal(applyStatePatch(emptyState(), { state: 'reading', finishedAt: 9e12 }, 1710000000456).finishedAt, 0);
  });

  /**
   * `hasFinished` 是读后感侧栏与门禁的**唯一**判据。
   *
   * ★ 与 `state === 'read'` 的差别只有一条：读完过、现在在读（或弃读）的书也算
   *   —— 那正是用户要的那一条。这里把四个状态逐个钉住，别让谁改成「只看 state」。
   */
  it('hasFinished：读完 + 读完过都算；没读完的不算（四个状态逐个钉）', () => {
    assert.equal(hasFinished({ state: 'read', finishedAt: 0 }), true, '读完的书不算读完过');
    assert.equal(hasFinished({ state: 'reading', finishedAt: 1700000000000 }), true, '重读中的书被踢出了读后感');
    assert.equal(hasFinished({ state: 'dropped', finishedAt: 1700000000000 }), true, '弃读但读完过的书被踢出了读后感');
    assert.equal(hasFinished({ state: 'reading', finishedAt: 0 }), false);
    assert.equal(hasFinished({ state: 'dropped' }), false);
    assert.equal(hasFinished({ state: 'unread' }), false, '没读过的书被放进了读后感');
    assert.equal(hasFinished(undefined), false);
  });

  /**
   * ★ `scanned` 是「实测这本书没有文字层」的结论，会被书架行渲染成标记。
   *   所以它必须是**严格布尔**：写成 `'true'` / `1` 这类真值会让一本没探过的书
   *   挂上「扫描版」—— 那是确定的假话。
   */
  it('scanned 只认布尔 true，其余一律 false（真值不算）', () => {
    assert.equal(normalizeState({ scanned: true }).scanned, true);
    for (const value of [false, undefined, null, 'true', 1, {}, [], 'yes']) {
      assert.equal(normalizeState({ scanned: value }).scanned, false, `scanned=${JSON.stringify(value)} 被判成了 true`);
    }
    assert.equal(emptyState().scanned, false);
  });

  it('stateOf 对缺省 / 空表都给未读', () => {
    assert.deepEqual(stateOf(undefined, 'b1'), emptyState());
    assert.deepEqual(stateOf({}, 'b1'), emptyState());
    assert.equal(stateOf({ b1: { state: 'read' } }, 'b1').state, 'read');
  });

  it('emptyState 每次是新对象（共用一份会被某个调用点改坏）', () => {
    assert.notEqual(emptyState(), emptyState());
  });

  it('progressPercent：页数未知返回 **null**，不返回 0', () => {
    // ★ 这是刻意的：「不知道」与「0%」在界面上必须能区分 —— 否则一本没解析出
    //   页数的书会永远显示「0%」，而用户会以为自己的进度丢了。
    assert.equal(progressPercent({ state: 'reading', page: 5, pages: 0 }), null);
    assert.equal(progressPercent({ state: 'reading', page: 5 }), null);
    assert.equal(progressPercent(null), null);
    assert.equal(progressPercent(undefined), null);
  });

  it('progressPercent：页数为 0 或未开始时给 0，并夹在 100 以内', () => {
    assert.equal(progressPercent({ page: 0, pages: 350 }), 0);
    assert.equal(progressPercent({ page: 125, pages: 350 }), 36);
    assert.equal(progressPercent({ page: 350, pages: 350 }), 100);
    assert.equal(progressPercent({ page: 400, pages: 350 }), 100);
  });
});

describe('mergeImportedStates', () => {
  it('★ 只导入本插件还没有的条目（集合基数与逐项性质写在一起）', () => {
    const mine = { b1: { state: 'reading', page: 5, pages: 100, at: 900 } };
    const external = {
      b1: { state: 'reading', page: 125, pages: 350, at: 100 },  // 我这边更新，不能盖
      b2: { state: 'read', page: 30, pages: 30, at: 500 },       // 那边独有，要导入
      b3: { state: 'unread', page: 0, at: 0 },                   // 空记录，别导入
    };
    const { states, imported } = mergeImportedStates(mine, external);

    // 基数：只导入了 1 条
    assert.equal(imported, 1);
    // 逐项性质：b1 保留我的、b2 导入、b3 没进来
    assert.equal(states.b1.page, 5);
    assert.equal(states.b2.page, 30);
    assert.equal(states.b2.state, 'read');
    // ★ 导进来的一律进「阅读」页：那边有记录的书就是用户在读的书，
    //   导进来却不在阅读页里，用户看到的是「我读过的书不见了」。
    assert.equal(states.b2.added, true);
    assert.equal(states.b3, undefined);
    assert.equal(Object.keys(states).length, 2);
  });

  it('不改入参（返回新对象）', () => {
    const mine = {};
    const { states } = mergeImportedStates(mine, { b9: { state: 'read', page: 1, pages: 2, at: 5 } });
    assert.equal(mine.b9, undefined);
    assert.equal(states.b9.state, 'read');
  });

  it('外部表里 id 非法的条目跳过；外部表本身不是对象也不炸', () => {
    assert.equal(mergeImportedStates({}, { 'a/b': { state: 'read' } }).imported, 0);
    assert.equal(mergeImportedStates({}, null).imported, 0);
    assert.equal(mergeImportedStates({}, 'nope').imported, 0);
    assert.deepEqual(mergeImportedStates({}, null).states, {});
  });

  it('外部条目的脏状态会被规范化后再存（存进去的永远是合法状态）', () => {
    const { states } = mergeImportedStates({}, { b7: { state: 'finished', page: 2, pages: 0, at: 7 } });
    assert.equal(states.b7.state, 'unread');
    assert.equal(states.b7.page, 2);
  });
});

describe('libraryStats', () => {
  it('总数 / 已加入数 / 各状态数 / 可渲染数 / 总体积', () => {
    const books = [
      normalizeBook(rawBook({ id: 'b1', ext: 'pdf', size: 100, fs_id: 1 })),
      normalizeBook(rawBook({ id: 'b2', ext: 'epub', size: 50, fs_id: 2 })),
      // b3 是「三条取字节凭据全空」的 pdf ⇒ 出现在书架上但不可渲染。夹具默认带
      // `relpath`，不清掉的话新判据会把它当成本地路径、renderable 变成 3。
      normalizeBook(rawBook({ id: 'b3', ext: 'pdf', size: 25, fs_id: 0, abspath: '', relpath: '' })),
    ];
    const stats = libraryStats(books, { b1: { state: 'read' }, b2: { state: 'reading' } });
    assert.equal(stats.total, 3);
    assert.equal(stats.bytes, 175);
    // b1（pdf）+ b2（epub，0.25.0 起重排可读）算得出；b3 取不到字节，不算。
    assert.equal(stats.renderable, 2);
    assert.deepEqual(stats.byState, { unread: 1, reading: 1, read: 1, dropped: 0 });
    // 有进度的两条算已加入（老数据兜底），b3 连状态记录都没有 ⇒ 0 进度 ⇒ 不在阅读页里。
    assert.equal(stats.added, 2);
    // 基数自洽：各状态数之和 = 总数
    assert.equal(Object.values(stats.byState).reduce((a, b) => a + b, 0), stats.total);
  });

  it('★ 统计是**对传进来的这批书**算的：阅读页传子集，两个页面的数字才各自成立', () => {
    const books = [
      normalizeBook(rawBook({ id: 'b1', ext: 'pdf', size: 100, fs_id: 1 })),
      normalizeBook(rawBook({ id: 'b2', ext: 'pdf', size: 100, fs_id: 2 })),
      normalizeBook(rawBook({ id: 'b3', ext: 'pdf', size: 100, fs_id: 3 })),
    ];
    const states = { b1: { state: 'reading', page: 3 }, b2: { state: 'read', page: 9, pages: 9 } };
    // 书架页：总数是所有书，但「在读」不能报成全部书里的 2 本 —— 那是阅读页的数字。
    assert.equal(libraryStats(books, states).total, 3);
    assert.equal(libraryStats(books, states).added, 2);
    const reading = libraryStats(addedBooks(books, states), states);
    assert.equal(reading.total, 2);
    assert.deepEqual(reading.byState, { unread: 0, reading: 1, read: 1, dropped: 0 });
    // 反向对照：拿全量书单去报阅读页的数字，就会得到「2 本里 1 本未读」这种不存在的分类。
    assert.notDeepEqual(libraryStats(books, states).byState, reading.byState);
  });

  it('空书架不炸', () => {
    assert.deepEqual(libraryStats([], {}), {
      total: 0, added: 0, byState: { unread: 0, reading: 0, read: 0, dropped: 0 }, bytes: 0, renderable: 0,
    });
  });
});

/**
 * 「阅读」列表：把「在不在阅读里」（added）与「读到哪儿」（state/page）分成**两个维度**。
 *
 * 这一节存在的理由：这两件事一旦混成一个字段，界面会长出两个相反的假象 ——
 *   - 全部按 state 推（没有 added）：「已加入 + 未读」的书根本没有办法表示，
 *     用户加进来的书在阅读页里显示不出来，而移出的书只要读过就再也移不掉；
 *   - 全部按 added 推：老数据（这个字段还不存在时写下的进度）会被判成未加入，
 *     用户升上来第一眼看到的是「我在读的 9 本书不见了」。
 */
describe('「阅读」列表：added', () => {
  it('★ 老数据（没有 added 字段）按**已有进度**推：读过 / 读完的书不能从阅读页消失', () => {
    assert.equal(normalizeState({ state: 'reading', page: 5 }).added, true);
    assert.equal(normalizeState({ state: 'read', page: 350 }).added, true);
    assert.equal(normalizeState({ state: 'dropped' }).added, true);
    // 「未读但翻过一页」的旧记录同样是「在读这本书」——只按 state 判会漏掉它。
    assert.equal(normalizeState({ state: 'unread', page: 1 }).added, true);
    // 反向对照：从没有过任何进度的书**不该**被算进来，否则阅读页就等于书架（2634 本）。
    assert.equal(normalizeState({ state: 'unread', page: 0 }).added, false);
    assert.equal(normalizeState({}).added, false);
  });

  it('★ 字段存在就照它走：移出必须真的能移出，兜底不许把它翻回来', () => {
    // 反向对照：判据若写成「state !== 'unread' || page > 0」而不看显式字段，
    // 一本「已加入 + 未读」的书点「移出」之后会**立刻自己回来**（界面上就是移不掉）。
    assert.equal(normalizeState({ state: 'reading', page: 5, added: false }).added, false);
    assert.equal(normalizeState({ state: 'unread', page: 0, added: true }).added, true);
    // 非布尔值不许被当成 true：`'false'` 是**真值**，`=== true` 才是这条判据的形态。
    assert.equal(normalizeState({ added: 'true' }).added, false);
    assert.equal(normalizeState({ added: 1 }).added, false);
  });

  it('isAdded / addedBooks 与界面走同一份判据', () => {
    const states = { b1: { state: 'reading', page: 5 }, b2: { state: 'unread', page: 0, added: true } };
    assert.equal(isAdded(states, 'b1'), true);
    assert.equal(isAdded(states, 'b2'), true);
    assert.equal(isAdded(states, 'b3'), false);
    assert.equal(isAdded(undefined, 'b1'), false);
    assert.deepEqual(addedBooks([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }], states).map((book) => book.id), ['b1', 'b2']);
    // 缺省 states（宿主还没读回来）不能炸。
    assert.deepEqual(addedBooks([{ id: 'b1' }]), []);
  });

  it('filterBooks 的 inReading：只留已加入的书，且与状态筛是「与」的关系', () => {
    const books = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }];
    const states = { b1: { state: 'reading', page: 5 }, b2: { state: 'unread', page: 0, added: true } };
    assert.deepEqual(filterBooks(books, { inReading: true, states }).map((b) => b.id), ['b1', 'b2']);
    assert.deepEqual(filterBooks(books, { inReading: true, state: 'reading', states }).map((b) => b.id), ['b1']);
    // 书架页（inReading 缺省）看得见全部书 —— 这就是「书架显示全部分类」那条需求。
    assert.equal(filterBooks(books, { states }).length, 3);
  });

  it('★ filterBooks 的 state 收字符串与数组，且「不过滤」的三种写法必须等价', () => {
    const books = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }];
    const states = {
      b1: { state: 'reading', page: 5 },
      b2: { state: 'unread', page: 0, added: true },
      b3: { state: 'read', page: 9, pages: 9 },
    };
    // 字符串：原有行为，不许退化。
    assert.deepEqual(filterBooks(books, { state: 'reading', states }).map((b) => b.id), ['b1']);
    // 数组 = 分组筛：「在读」= 未开始 + 在读（见 READING_STATE_FILTERS）。
    assert.deepEqual(filterBooks(books, { state: ['unread', 'reading'], states }).map((b) => b.id), ['b1', 'b2']);
    // ★ 「不过滤」的三种写法必须等价。`null` 那条是本项目实测踩到的：解构默认值
    //   `state = ''` **只在 undefined 时生效**，显式的 `null` 会一路走到 `[null]`，
    //   于是「全部」筛出 **0 本** —— 而 READING_STATE_FILTERS 里「全部」就是 null。
    for (const none of ['', null, undefined]) {
      assert.equal(filterBooks(books, { state: none, states }).length, 3, `state=${String(none)} 应当不过滤`);
    }
    // ★ 空数组与它们**不是一回事**：那是「一个状态都不要」。
    assert.equal(filterBooks(books, { state: [], states }).length, 0);
    // 反向对照：旧的 `[null]` 形态必须筛空 —— 证明上面那三条不是白写的。
    assert.equal(filterBooks(books, { state: [null], states }).length, 0);
  });

  /**
   * ★ 一行书的**呈现真值表**（徽章文字 / 动作文字 / 能不能点开 / 要不要压暗）。
   *
   * ★ 为什么这张表住在 `src/library.js` 而不是组件里：住在组件里就只能靠源码字符串
   *   断言，而字符串断言答不了「这条分支跑不跑得到」—— 本项目给死代码发过合格证。
   *   放这里就能**真跑**：四个状态 × 两个页面逐个跑一遍。
   *
   * ★★ 两个页面的职责（用户 2026-10-09 的原话，逐字）：
   *   「阅读是点击电子书可以取书阅读，但是书架就是电子书的一个展示，不能点击电子书取书阅读。」
   *   「书架电子书的标签应该是：『+ 阅读』；一旦点击就把这本书加到『阅读』选项卡下；
   *     然后『+ 阅读』就变为『已开始阅读』。但是电子书不能有任何取书阅读动作。」
   *   另外四条来自同一天更早的要求：
   *   ① 「『在读』标签应该是『在读+进度』」；
   *   ② 「『读完』下面的电子书点击应该不能有任何动作，只能点击『重新阅读』才可以」；
   *   ③ 「『弃读』下面的…点击移出就是移回书架，点击电子书就是重新开始阅读」；
   *   ④ 「『全部』和『在读』的『已在阅读』标签应该是显示『弃读』」。
   */
  const rowBook = { id: 'b1', title: '屠格涅夫散文诗集' };
  const rowView = (state, patch = {}, onReadingPage = true) => bookRowView(
    rowBook, { added: true, state, page: 0, pages: 0, ...patch }, { onReadingPage },
  );
  /** 右侧动作的 `kind` 序列 —— **顺序即显示顺序**。 */
  const kinds = (view) => view.actions.map((item) => item.kind);
  const texts = (view) => view.actions.map((item) => item.text);
  /** 数据模型里所有合法的 `kind`。新增一个却忘了登记，下面的遍历断言会红。 */
  const KINDS = ['add', 'remove', 'drop', 'restart'];

  it('★ bookRowView：未加入 → 没有徽章，动作是「+ 阅读」（加入）', () => {
    const view = bookRowView(rowBook, { added: false, state: 'unread', page: 0, pages: 0 }, { onReadingPage: false });
    assert.equal(view.badgeText, '', '未加入的书不该挂状态徽章 —— 2634 本全是「未读」，等于没有信息');
    assert.deepEqual(kinds(view), ['add']);
    assert.deepEqual(texts(view), ['+ 阅读']);
    assert.equal(view.openable, false, '书架是展示：还没加进来时不能取书阅读');
  });

  it('★★ 书架页：整页没有一行能点开（用户这次的核心要求）', () => {
    for (const state of BOOK_STATES) {
      for (const added of [false, true]) {
        const view = bookRowView(rowBook, { added, state, page: 3, pages: 9 }, { onReadingPage: false });
        assert.equal(view.openable, false, `书架页里${added ? '已加入' : '未加入'}的「${state}」不许能点开`);
        // ★ 会**打开书**的动作（`restart`）永远不许出现在书架页 —— 那正是用户说的
        //   「不能点击电子书取书阅读」。这条比逐个状态抄一遍更耐改：以后新增任何
        //   「会打开书」的 kind，只要它出现在书架页就会红。
        assert.deepEqual(kinds(view).filter((kind) => kind !== 'add'), [],
          `书架页出现了会打开书的动作 ${kinds(view).join('/')} —— 书架只是展示`);
        assert.equal(view.dim, false, '书架页整页都不可点，不该压暗（2634 个灰标题只会像坏了）');
      }
    }
  });

  /**
   * ★ 遍历式不变量：**`actions` 与 `statusLabel` 恰好有一个非空**。
   *
   * 这条比逐个状态抄一遍耐改得多 —— 以后新增任何一个状态，只要它同时给出动作与
   * 状态标签（或两个都不给），这里就红。而「两个都不给」的症状是**那个位置整个空掉**，
   * 光看代码是发现不了的（`view.actions.map()` 空数组渲染出来什么都没有）。
   */
  it('★★ 四个状态 × 两个页面：动作与状态标签**恰好有一个**，且字段都不为空', () => {
    for (const state of BOOK_STATES) {
      for (const added of [false, true]) {
        for (const onReadingPage of [false, true]) {
          const view = bookRowView(rowBook, { added, state, page: 3, pages: 9 }, { onReadingPage });
          const where = `${added ? '已加入' : '未加入'} / ${state} / ${onReadingPage ? '阅读页' : '书架页'}`;
          assert.equal(view.actions.length > 0, view.statusLabel === null,
            `${where}：actions 与 statusLabel 必须恰好有一个非空`);
          assert.ok(view.actions.length <= 2, `${where}：一行最多两个按钮（再多就把书名挤没了）`);
          for (const action of view.actions) {
            assert.ok(KINDS.includes(action.kind), `${where}：不认识的 kind ${action.kind}`);
            for (const field of ['text', 'title', 'label']) {
              assert.ok(typeof action[field] === 'string' && action[field].length > 0,
                `${where}：动作 ${action.kind} 的 ${field} 是空的`);
            }
          }
          if (view.statusLabel !== null) {
            assert.ok(view.statusLabel.text.length > 0 && view.statusLabel.title.length > 0,
              `${where}：状态标签的文字不能为空`);
          }
          // ★ `restart` 会**打开书**，所以它只许出现在不可点开的行上 —— 否则同一行
          //   既有「点行就打开」又有「点按钮再打开一次」，两条路径抢同一件事。
          if (kinds(view).includes('restart')) {
            assert.equal(view.openable, false, `${where}：有「重新阅读」的行不许再点开`);
          }
        }
      }
    }
  });

  it('★ bookRowView：书架页「已加入」是**状态标签**「已开始阅读」，不是动作', () => {
    for (const state of BOOK_STATES) {
      const view = rowView(state, {}, false);
      assert.deepEqual(view.actions, [], '书架页那一格是状态 ⇒ 组件必须渲染成 span 而不是 button');
      assert.equal(view.statusLabel.text, '已开始阅读');
    }
  });

  it('★ bookRowView：阅读页「未开始 / 在读」→ 徽章「在读 + 进度」，动作「弃读」（要求 ①④）', () => {
    assert.equal(rowView('unread').badgeText, '在读 · 未开始');
    assert.equal(rowView('reading', { page: 125, pages: 327 }).badgeText, '在读 · 读到 125 / 327 页');
    // 页数未知时不写分母 —— 「读到 125 / 0 页」是句假话。
    assert.equal(rowView('reading', { page: 125 }).badgeText, '在读 · 读到 125 页');
    for (const state of ['unread', 'reading']) {
      assert.deepEqual(kinds(rowView(state)), ['drop']);
      assert.deepEqual(texts(rowView(state)), ['弃读'], '按钮名必须说「点下去会发生什么」，不是「已经在阅读」');
      assert.equal(rowView(state).openable, true, '阅读页里点书名就是取书阅读，必须可点');
    }
    // 「未读」这个字面量**不许**再出现在徽章里：筛选条上这一格叫「在读」，
    // 徽章里叫「未读」是自相矛盾的（0.9.0 合并筛选条时漏掉的那一处）。
    assert.ok(!rowView('unread').badgeText.includes('未读'), '徽章里不许再出现「未读」');
  });

  it('★ bookRowView：阅读页「读完」→ 动作「重新阅读」，且**这一行点不开**（要求 ②）', () => {
    const view = rowView('read');
    assert.equal(view.badgeText, '读完');
    assert.deepEqual(kinds(view), ['restart']);
    assert.deepEqual(texts(view), ['重新阅读']);
    assert.equal(view.openable, false, '「读完」那一行不许点开 —— 免得手滑把读完的书重新翻开');
    assert.notEqual(view.openHint, '', '不可点就必须说明原因，否则用户只看到「点了没反应」');
    assert.equal(view.dim, true, '同一页里别的行能点、这一格不能 ⇒ 必须压暗，否则「看起来能点」');
  });

  /**
   * 0.44.3：写完读后感的入口**搬到「读完」那一行**（用户 2026-10-28 的原话：
   * 「头部菜单条不应该有『写读后感』按钮入口……入口应该是写在读完列表下」）。
   *
   * ★ 两条都要钉住：
   *   ① `canReflect` 为真 ⇒ 「写读后感」在左、「重新阅读」在右（**原有按钮不许挪位**）；
   *   ② 为假 ⇒ 只剩「重新阅读」，**不画一颗点了没反应的按钮**。
   * ★ 只有「读完」这一格有它：别的状态根本没读完，写不了读后感。
   */
  it('★ bookRowView：读完那一行有「写读后感」（左），「重新阅读」仍在最右', () => {
    const view = bookRowView({ title: '某本书' }, { added: true, state: 'read', page: 10, pages: 100 }, { onReadingPage: true, canReflect: true });
    assert.deepEqual(texts(view), ['写读后感', '重新阅读'], '写完读后感的入口不在读完那一行，或者把「重新阅读」挤走了');
    assert.deepEqual(kinds(view), ['reflect', 'restart']);
    assert.equal(view.openable, false, '加了按钮也不能让这一行变成可点开');
    // 两颗按钮都自带文字，「为什么这一行点不动」已经写在屏幕上了。
    // 再叠一句「点右边的按钮」是重复，而且会把元信息行挤成第三行（268px 侧栏实测）。
    assert.equal(view.openHint, '', '两个按钮自带文字了，还叠一句重复提示');

    // 没有这个去处时不许留一颗空按钮；那种行仍要保留那句可见提示。
    const bare = rowView('read');
    assert.deepEqual(texts(bare), ['重新阅读']);
    assert.notEqual(bare.openHint, '', '只剩一颗按钮时，仍然必须说明为什么这一行点不动');

    // 别的状态不许出现它（没读完就写不了读后感）。
    for (const state of ['unread', 'reading', 'dropped']) {
      const other = bookRowView({ title: 'x' }, { added: true, state, page: 1, pages: 10 }, { onReadingPage: true, canReflect: true });
      assert.equal(texts(other).includes('写读后感'), false, `${state} 那一行也冒出了「写读后感」`);
    }
  });

  /**
   * ★★ 弃读那一行（0.9.4 用户新要求，原话逐字）：
   *   「阅读选项卡下，弃读下的电子书也不能点击阅读，除了『移出』按钮之外还应该有个
   *     『+ 阅读』按钮，点击即可再次阅读。」
   *
   * 三个要点，一个都不能少：① 点行**没有动作**；② **两个**按钮；③ 顺序是
   *   「+ 阅读」在前、「移出」在后（`移出` 留在最右 = 用户原来的手位，破坏性动作
   *   也不该让光标先落上去）。
   */
  it('★★ bookRowView：阅读页「弃读」→ 不可点开 + 两个按钮「+ 阅读」「移出」（0.9.4 用户定）', () => {
    const view = rowView('dropped');
    assert.equal(view.badgeText, '弃读');
    assert.equal(view.openable, false, '用户原话：「弃读下的电子书也不能点击阅读」');
    assert.notEqual(view.openHint, '', '不可点就必须说明怎么恢复，否则用户只看到「点了没反应」');
    assert.deepEqual(kinds(view), ['restart', 'remove'], '恢复在前、移出在后');
    assert.deepEqual(texts(view), ['+ 阅读', '移出']);
    // ★ 两个按钮的文字不许相同 —— 同名的两个按钮等于让用户猜。
    assert.equal(new Set(texts(view)).size, texts(view).length);
    // ★ 恢复走的是 `restart`（写 `state: 'reading'`），不是 `add`：这本书**已经在**
    //   阅读页里了（`added` 一直是 true），只是被标记成弃读。写成 `add` 只会把
    //   `added` 再设成 true（它本来就是），点了**什么都不会变**。
    assert.equal(kinds(view)[0], 'restart');
    assert.equal(view.dim, true, '和「读完」同理：同页里「未开始 / 在读」能点，这两格不能');
  });

  /**
   * 封面角标 + 元信息徽章（0.45.3）。
   *
   * ★ 用户原话：「读完、在读、弃读我觉得要有一个明显的区分……是不是可以分别加个
   *   醒目角标？」「我觉得 A 角标好像醒目一些。C 的话就是还是放在全文字里，很难发现」。
   *   于是封面右上角那一个方块成了**唯一**说状态的地方（阅读页），元信息行只留进度。
   *
   * ★ 钉三件事：
   *   ① 每个状态都有角标字 —— 缺一个，那一格的书就没有状态可看；
   *   ② 角标字**跟着徽章文字走**，不是跟着 `name` 走：`unread` 与 `reading` 的徽章
   *      都是「在读」，角标也必须同字。否则同一本书角标说「未读」、徽章说「在读」；
   *   ③ 终态（读完 / 弃读）的 `badgeProgress` 是空串 —— 角标已经说了，元信息行
   *      再说一遍的代价是**行高**（320px 实测：一行 17 → 两行 43，整列变松）。
   */
  it('★ bookRowView：角标字跟着**徽章**走，终态不再重复写在元信息行（0.45.3）', () => {
    // ① 四格都有字，且只占一个字（角标是 17×17 的方块，两个字会溢出）。
    for (const state of BOOK_STATES) {
      const mark = rowView(state).badgeMark;
      assert.equal(typeof mark, 'string');
      assert.equal(mark.length <= 1, true, `${state} 的角标是「${mark}」—— 方块只有 17px 宽，装不下两个字`);
    }
    // ② 「未开始 / 在读」同字：它们本来就同一条进度轴。
    assert.equal(rowView('unread').badgeMark, rowView('reading').badgeMark, '「未开始」与「在读」的角标必须一致 —— 徽章文字就是一致的');
    assert.equal(rowView('read').badgeMark, '完');
    assert.equal(rowView('dropped').badgeMark, '弃');
    // 三个终态/进行态的角标必须两两不同，否则「一眼分辨」这件事就没做到。
    const marks = ['reading', 'read', 'dropped'].map((s) => rowView(s).badgeMark);
    assert.equal(new Set(marks).size, 3, `三档角标字重复了：${marks.join(' / ')}`);

    // ③ 只有「还在读」的两格留进度；终态留空。
    assert.equal(rowView('reading', { page: 24, pages: 387 }).badgeProgress, '读到 24 / 387 页');
    assert.equal(rowView('unread').badgeProgress, '未开始');
    assert.equal(rowView('read').badgeProgress, '', '「读完」的角标已经说了，元信息行再说一遍会把行挤高');
    assert.equal(rowView('dropped').badgeProgress, '', '同上');

    // ★ 反向不变量：`badgeProgress` 不许**再带**状态前缀。
    //   `badgeText` 是「在读 · 读到 24 / 387 页」，去掉的那一段正是角标现在负责的部分；
    //   如果哪天它又变成整句，元信息行就会在 320px 下多占一行 —— 那是 0.45.3 修掉的那个坑。
    for (const state of ['unread', 'reading']) {
      const view = rowView(state, { page: 24, pages: 387 });
      assert.equal(view.badgeText.includes(view.badgeProgress), true, '进度必须是整句徽章的一部分，否则两处文案会各说各话');
      assert.equal(view.badgeProgress.includes(BOOK_STATE_LABELS[state]), false, `${state} 的进度里又带上了状态词`);
    }
  });


  it('★ bookRowView：`dim` 只给**不可点开**的那几格，且两格必须一致', () => {
    // 压暗是一种**对比**手段：整页都不可点时它没有信息量（书架页），只有
    // 「同页里有能点的邻居」时它才说明「这一格不一样」。
    // ★ 0.9.4 起不可点开的有两格（读完 / 弃读）—— 只压其中一格会让「压暗」
    //   变成随机的，所以这里要求**两格一致**。
    assert.equal(rowView('read').dim, true);
    assert.equal(rowView('dropped').dim, true);
    for (const state of ['unread', 'reading']) {
      assert.equal(rowView(state).dim, false, `${state} 不该压暗`);
    }
    assert.equal(rowView('read', {}, false).dim, false, '书架页整页不可点 ⇒ 不压暗');
    assert.equal(rowView('dropped', {}, false).dim, false, '书架页整页不可点 ⇒ 不压暗');
    // 「压暗」与「可点开」必须完全对齐 —— 这条把上面几个逐项断言收成一条不变量。
    // ★ 只在**阅读页**成立：书架页整页不可点，压暗没有信息量，所以那边恒为 false。
    for (const state of BOOK_STATES) {
      assert.equal(rowView(state).dim, !rowView(state).openable,
        `阅读页 ${state}：dim 与 openable 必须互为反面，否则「压暗」在说谎`);
    }
  });

  it('★ bookRowView：状态非法时退回「未读」，不抛错', () => {
    const view = bookRowView(rowBook, { added: true, state: 'nonsense', page: 0, pages: 0 }, { onReadingPage: true });
    assert.equal(view.badgeText, '在读 · 未开始');
    assert.deepEqual(kinds(view), ['drop']);
  });

  it('★ readingProgressLabel：没开始 / 有进度 / 页数未知', () => {
    assert.equal(readingProgressLabel({ page: 0, pages: 327 }), '未开始');
    assert.equal(readingProgressLabel({ page: 125, pages: 327 }), '读到 125 / 327 页');
    assert.equal(readingProgressLabel({ page: 125, pages: 0 }), '读到 125 页');
    // ★ 反向对照：页数未知时**不许**写分母（「读到 125 / 0 页」是句假话）。
    assert.ok(!readingProgressLabel({ page: 125, pages: 0 }).includes('/'));
    // 缺字段 / 传空都不能炸 —— 状态表里的半截数据会直接喂进来。
    assert.equal(readingProgressLabel(undefined), '未开始');
    assert.equal(readingProgressLabel({}), '未开始');
  });

  it('★ READING_STATE_FILTERS：四组互不重叠、合起来正好是 BOOK_STATES', () => {
    const groups = READING_STATE_FILTERS.filter((group) => group.states !== null);
    const flat = groups.flatMap((group) => group.states);
    assert.deepEqual([...flat].sort(), [...BOOK_STATES].sort(), '分组合起来必须覆盖整个数据模型');
    assert.equal(new Set(flat).size, flat.length, '同一状态不许出现在两个分组里');
    // 「全部」必须是 `null`（不过滤）—— 写成 `[]` 会筛出 0 本。
    assert.equal(READING_STATE_FILTERS[0].value, '');
    assert.equal(READING_STATE_FILTERS[0].states, null);
  });
});

describe('formatBytes', () => {
  it('两端必须打印同样的数字 —— 所以刻意不用 Intl', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(999), '999 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(14_140_000), '13 MB');
    assert.equal(formatBytes(47 * 1024 ** 3), '47 GB');
  });

  it('两位有效感的边界：≥10 取整、<10 保留一位', () => {
    assert.equal(formatBytes(9.5 * 1024), '9.5 KB');
    assert.equal(formatBytes(10.4 * 1024), '10 KB');
  });

  it('负值 / 非数回空串（界面据此不显示这一格）', () => {
    assert.equal(formatBytes(-1), '');
    assert.equal(formatBytes('big'), '');
    assert.equal(formatBytes(Number.NaN), '');
  });
});

describe('书源配置', () => {
  it('BOOK_SOURCE_KINDS 与标签表一一对应（加了一种源却忘了起名字，界面就会显示空白）', () => {
    for (const kind of BOOK_SOURCE_KINDS) {
      assert.equal(typeof BOOK_SOURCE_LABELS[kind], 'string', `${kind} 缺标签`);
      assert.ok(BOOK_SOURCE_LABELS[kind].length > 0);
    }
    assert.equal(Object.keys(BOOK_SOURCE_LABELS).length, BOOK_SOURCE_KINDS.length);
  });

  it('normalizeBookSource 只认白名单里的 kind（不认识的一律丢掉，不猜）', () => {
    assert.deepEqual(normalizeBookSource({ kind: 'local', path: '/books' }), {
      id: sourceListId('local', '/books'),
      kind: 'local',
      path: '/books',
      name: 'books',
    });
    assert.deepEqual(normalizeBookSource({ kind: 'pan', path: '/我的资源/电子书' }), {
      id: sourceListId('pan', '/我的资源/电子书'),
      kind: 'pan',
      path: '/我的资源/电子书',
      name: '网盘 · 电子书',
    });
    // 反向对照：大小写 / 前后空格 / 同义词都不算合法 kind。
    for (const bad of ['', 'LOCAL', 'Local', ' local', 'ftp', 'network', 'undefined', undefined, null]) {
      assert.equal(
        normalizeBookSource({ kind: bad, path: '/books' }),
        undefined,
        `kind=${String(bad)} 不该通过`,
      );
    }
  });

  it('normalizeBookSource 要求 path 非空、不过长、不含 NUL', () => {
    assert.equal(normalizeBookSource({ kind: 'local', path: '' }), undefined);
    assert.equal(normalizeBookSource({ kind: 'local', path: '   ' }), undefined);
    assert.equal(normalizeBookSource({ kind: 'local' }), undefined);
    assert.equal(normalizeBookSource({ kind: 'local', path: `/${'a'.repeat(600)}` }), undefined);
    assert.equal(normalizeBookSource({ kind: 'local', path: '/a\u0000b' }), undefined);
    // 反向对照：两侧空格是**粘贴常态**，要 trim 掉而不是判成非法。
    assert.deepEqual(normalizeBookSource({ kind: 'local', path: '  /books  ' }), {
      id: sourceListId('local', '/books'),
      kind: 'local',
      path: '/books',
      name: 'books',
    });
  });

  it('normalizeBookSource 只挑出 id / kind / path / name 四个字段（不把 raw 上的杂物带进设置）', () => {
    const source = normalizeBookSource({ kind: 'local', path: '/books', secret: 'x', nested: { a: 1 } });
    assert.deepEqual(Object.keys(source).sort(), ['id', 'kind', 'name', 'path']);
    // 反向对照：非对象一律丢掉，而不是把字符串当 path。
    for (const bad of [null, undefined, 'local', 42, [], true]) {
      assert.equal(normalizeBookSource(bad), undefined);
    }
  });

  it('★ normalizeBookSource 的 id **一律现算**，外部塞进来的 id 不生效', () => {
    // 允许外部指定 id ⇒ 两条配置可以指向同一份书单文件，而「哪几份已载入」正是按 id 记的。
    const forged = normalizeBookSource({ kind: 'local', path: '/books', id: 's0000000000000000' });
    assert.equal(forged.id, sourceListId('local', '/books'));
    assert.notEqual(forged.id, 's0000000000000000');
    // 同一组 kind + path 永远同一个 id（书单文件名与载入清单两处都靠它跨次稳定）。
    assert.equal(
      normalizeBookSource({ kind: 'local', path: '/books', name: '随便改的名字' }).id,
      normalizeBookSource({ kind: 'local', path: '/books' }).id,
    );
  });

  it('★ normalizeBookSource 的 name：缺省/超长取目录名，正常值原样保留', () => {
    assert.equal(normalizeBookSource({ kind: 'local', path: '/a/电子书' }).name, '电子书');
    assert.equal(normalizeBookSource({ kind: 'local', path: '/a/电子书', name: '' }).name, '电子书');
    assert.equal(normalizeBookSource({ kind: 'local', path: '/a/电子书', name: '   ' }).name, '电子书');
    assert.equal(normalizeBookSource({ kind: 'local', path: '/a/电子书', name: '我的书' }).name, '我的书');
    // 超长（而不是截断）直接回落到目录名：截断会产出两个前半段相同的名字，比自动名更难分辨。
    const tooLong = 'n'.repeat(BOOK_LIST_NAME_MAX + 1);
    assert.equal(normalizeBookSource({ kind: 'local', path: '/a/电子书', name: tooLong }).name, '电子书');
    assert.equal(
      normalizeBookSource({ kind: 'local', path: '/a/电子书', name: 'n'.repeat(BOOK_LIST_NAME_MAX) }).name,
      'n'.repeat(BOOK_LIST_NAME_MAX),
    );
    // 名字里的换行/多空格收敛成单个空格 —— 名字会进书单清单文件。
    assert.equal(normalizeBookSource({ kind: 'local', path: '/a/e', name: ' 甲\n\n 乙 ' }).name, '甲 乙');
  });

  it('★ defaultSourceName：本机取末段，网盘必须带前缀（否则两个源在界面上长得一模一样）', () => {
    assert.equal(defaultSourceName('local', '/Users/你/电子书'), '电子书');
    assert.equal(defaultSourceName('local', '/Users/你/电子书/'), '电子书');
    assert.equal(defaultSourceName('local', 'C:\\Users\\你\\电子书'), '电子书');
    assert.equal(defaultSourceName('local', ''), '本地目录');
    assert.equal(defaultSourceName('local', '/'), '本地目录');
    assert.equal(defaultSourceName('pan', '/电子书'), '网盘 · 电子书');
    assert.equal(defaultSourceName('pan', '/我的资源/电子书/'), '网盘 · 电子书');
    assert.equal(defaultSourceName('pan', ''), '网盘 · 根目录');
    assert.equal(defaultSourceName('pan', '/'), '网盘 · 根目录');
    // 反向对照：**同一条末段**在两种 kind 下必须不同名 —— 这正是加前缀的理由。
    assert.notEqual(defaultSourceName('local', '/电子书'), defaultSourceName('pan', '/电子书'));
  });

  it('★ sourceListId：同 kind+path 稳定、不同 kind 或不同 path 必须分开', () => {
    const a = sourceListId('local', '/电子书');
    assert.equal(a, sourceListId('local', '/电子书'));
    // 两侧空格不影响 id —— 否则「配置里多打了一个空格」等于换了一份书单。
    assert.equal(a, sourceListId('local', ' /电子书 '));
    assert.equal(isBookId(a), true, `sourceListId 产出不合法：${a}`);
    assert.notEqual(a, sourceListId('pan', '/电子书'));
    assert.notEqual(a, sourceListId('local', '/电子书2'));
    // ★ 不能用下标或时间：id 必须只由 kind+path 决定，否则删掉中间一条会让后面全部错位。
    const ids = new Set(['/a', '/b', '/c'].map((path) => sourceListId('local', path)));
    assert.equal(ids.size, 3);
  });

  it('normalizeBookSources 丢掉坏行、去重、限长', () => {
    assert.deepEqual(normalizeBookSources([{ kind: 'local', path: '/a' }, { kind: 'bogus', path: '/b' }]), [
      { id: sourceListId('local', '/a'), kind: 'local', path: '/a', name: 'a' },
    ]);
    // 非数组 ⇒ 空数组（设置文件手改坏了不许把整份设置卡死）。
    for (const bad of [undefined, null, 'x', 42, {}]) {
      assert.deepEqual(normalizeBookSources(bad), []);
    }
    // 同 kind + 同 path 只留一条：重复扫同一目录会产出重复 id，而 id 是进度的键。
    assert.deepEqual(
      normalizeBookSources([
        { kind: 'local', path: '/a' },
        { kind: 'local', path: '/a' },
        { kind: 'local', path: ' /a ' },
      ]),
      [{ id: sourceListId('local', '/a'), kind: 'local', path: '/a', name: 'a' }],
    );
    // 反向对照：**不同 kind** 的同一条路径不算重复（同一个目录下既扫本地又列网盘是合法的）。
    assert.deepEqual(
      normalizeBookSources([{ kind: 'local', path: '/a' }, { kind: 'pan', path: '/a' }]),
      [
        { id: sourceListId('local', '/a'), kind: 'local', path: '/a', name: 'a' },
        { id: sourceListId('pan', '/a'), kind: 'pan', path: '/a', name: '网盘 · a' },
      ],
    );
    // 限长：多出来的直接截断，而不是把设置文件撑到任意大。
    const many = Array.from({ length: BOOK_SOURCES_MAX + 5 }, (unused, index) => ({
      kind: 'local',
      path: `/d${index}`,
    }));
    assert.equal(normalizeBookSources(many).length, BOOK_SOURCES_MAX);
  });

  it('★ normalizeLibraryListIds：去重、丢掉不合法 id、限长，但**不校验存在性**', () => {
    assert.deepEqual(normalizeLibraryListIds([sourceListId('local', '/a')]), [sourceListId('local', '/a')]);
    // 非数组 ⇒ 空数组。
    for (const bad of [undefined, null, 'x', 42, {}]) {
      assert.deepEqual(normalizeLibraryListIds(bad), []);
    }
    // 重复 id 只留一条；两侧空格要 trim（载入清单是手改得动的设置项）。
    const id = sourceListId('local', '/a');
    assert.deepEqual(normalizeLibraryListIds([id, id, ` ${id} `]), [id]);
    // 坏 id（形状不合法）丢掉，而不是把整份设置卡死。
    assert.deepEqual(normalizeLibraryListIds([id, '', '   ', '有中文', 'a'.repeat(80), null]), [id]);
    // 反向对照：形状合法的就留下 —— 非字符串会被 String() 化，`42` 变成合法 id `'42'`，
    // 它匹配不到任何清单条目、界面上不出现，代价可忽略；而**形状不合法的必须丢**。
    assert.deepEqual(normalizeLibraryListIds(['42']), ['42']);
    // ★ 反向对照：**不校验这个 id 在清单里存不存在** —— 校验了会让「先载入、后配源」不可能。
    assert.deepEqual(normalizeLibraryListIds(['sdeadbeefdeadbeef']), ['sdeadbeefdeadbeef']);
    // 限长。
    const many = Array.from({ length: BOOK_SOURCES_MAX + 5 }, (unused, index) => bookIdFromPath('s', `/l${index}`));
    assert.equal(normalizeLibraryListIds(many).length, BOOK_SOURCES_MAX);
  });

  it('normalizeBookSources 不改入参（调用点往往直接把设置对象递进来）', () => {
    const input = [{ kind: 'local', path: ' /a ' }, { kind: 'bogus', path: '/b' }];
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeBookSources(input);
    assert.deepEqual(input, snapshot);
  });

  it('★ bookIdFromPath 必须**跨次扫描稳定** —— id 一变，用户重新生成书单后进度全清零', () => {
    const a = bookIdFromPath('l', '欧洲文学/忧郁的热带.pdf');
    const b = bookIdFromPath('l', '欧洲文学/忧郁的热带.pdf');
    assert.equal(a, b);
    // 形状：前缀 + 16 个十六进制字符（两轮 FNV-1a 拼 64 位）。
    assert.equal(a.length, 17);
    assert.ok(a.startsWith('l'));
    assert.match(a.slice(1), /^[0-9a-f]{16}$/);
    // 必须也是合法的 bookId —— 否则 normalizeBook 会把扫描出来的书全丢掉。
    assert.equal(isBookId(a), true);
  });

  it('★ bookIdFromPath 的区分度：不同路径 / 不同来源都不得撞到同一个 id', () => {
    const ids = new Set();
    for (const prefix of ['l', 'p']) {
      for (let index = 0; index < 2000; index += 1) ids.add(bookIdFromPath(prefix, `/库/书${index}.pdf`));
    }
    assert.equal(ids.size, 4000, '4000 条里出现了重复 id');
    // 反向对照：同一个 seed、不同 prefix 必须不同 —— 否则同一本书在本地与网盘之间互相覆盖。
    assert.notEqual(
      bookIdFromPath('l', '/same.pdf'),
      bookIdFromPath('p', '/same.pdf'),
    );
  });

  it('bookIdFromPath 对空值 / 非字符串不抛错（来源路径可能是任何东西）', () => {
    for (const seed of [undefined, null, '', 0, false, {}, []]) {
      const id = bookIdFromPath('l', seed);
      assert.equal(isBookId(id), true, `seed=${String(seed)} 产出的 id 不合法：${id}`);
    }
    // 反向对照：不同空值之间不要求相同，但 undefined 与 null 都会 String() 成同一个串，
    // 这里只断言「不抛 + 合法」，不断言它们必须相等。
  });
});

describe('共用常量', () => {
  it('两个路由前缀都是绝对路径且不互相包含（否则路由会抢）', () => {
    for (const prefix of [LIBRARY_API_PREFIX, PDFJS_VENDOR_PREFIX]) {
      assert.ok(prefix.startsWith('/'), `${prefix} 必须是绝对路径`);
      assert.equal(prefix.endsWith('/'), false, `${prefix} 不该以 / 结尾`);
    }
    assert.equal(LIBRARY_API_PREFIX.startsWith(PDFJS_VENDOR_PREFIX), false);
    assert.equal(PDFJS_VENDOR_PREFIX.startsWith(LIBRARY_API_PREFIX), false);
  });

  it('★ 书单默认路径是空串 —— 由宿主演绎成**插件数据目录**，不是写死某个人的机器路径', () => {
    // 这条用例守的是一个会伤到**所有**用户的缺陷：默认值一旦写成绝对路径，别人装完
    // 第一眼看到的就是作者机器上的路径，书架直接空掉，而原因藏在「默认值」里。
    assert.equal(LIBRARY_PATH_DEFAULT, '');
    // 反向对照：不许出现任何 `~` 或以 `/` 开头的硬编码（空串当然满足，但它同时
    // 挡住了「换成另一个人的绝对路径」这种半吊子修法）。
    assert.equal(LIBRARY_PATH_DEFAULT.includes('~'), false);
    assert.equal(LIBRARY_PATH_DEFAULT.startsWith('/'), false);
  });

  it('BOOKS_PAGE_LIMIT 是安全阀而不是分页大小 —— 必须大于真机书单（2634 条）', () => {
    // 只发前 N 条会让「搜不到某本书」变成一个**假的**结论。
    assert.ok(BOOKS_PAGE_LIMIT >= 5000, `当前 ${BOOKS_PAGE_LIMIT}，小于真机书单条数`);
  });
});

describe('结构性契约：src/library.js 不许出现运行环境专属 API', () => {
  // ★ 必须先剥注释：文件顶部那段说明里就写着 `node:*` / `document` / `fetch` ——
  //   直接对原文查子串会**把文档当成违规**，然后人就会去删文档（而不是修判据）。
  const source = stripComments(readFileSync(join(here, '..', 'src', 'library.js'), 'utf8'));

  it('没有 import 语句（两端共用，任何 import 都可能把 shim 拖进浏览器 bundle）', () => {
    // 这条断言答的是「文件里有什么」—— 正是契约本身。若将来真需要 import，
    // 必须同步把这条断言改成「只允许 import 白名单」，而不是删掉它。
    assert.equal(/^\s*import\s/m.test(source), false, 'src/library.js 出现了 import 语句');
    assert.equal(/\brequire\s*\(/.test(source), false, 'src/library.js 出现了 require');
  });

  it('不引用 node: / document / window / fetch', () => {
    for (const forbidden of ['node:', 'document.', 'window.', 'localStorage', 'fetch(']) {
      assert.equal(source.includes(forbidden), false, `src/library.js 出现了 ${forbidden}`);
    }
  });

  it('反向对照：同一段判据确实能抓到真违规（否则上面两条是假绿）', () => {
    // 把一行真代码塞进原文再剥注释 —— 证明判据本身有牙。
    const polluted = stripComments(`import { readFile } from 'node:fs';\nconst a = document.title;\n`);
    assert.equal(polluted.includes('node:'), true);
    assert.equal(polluted.includes('document.'), true);
  });
});

/**
 * 欢迎页那行统计的**来源**维度（0.25.6）。
 *
 * 用户原话：「这地方是不是根据用户添加的书源时时表达：比如目前：书源：网盘的情况。
 * 本地目录的情况。」
 * 原来四项（书单 / 已在阅读 / 可阅读 / 总体积）全是状态与总量，一个字的来源信息都没有 ——
 * 同时配了网盘和本地目录的人，读不出来「2637 本里有几本在网盘上」。
 */
describe('sourceTotals：按书源分堆', () => {
  const book = (id, kind, size, extra = {}) => ({ id, listKind: kind, size, ...extra });

  it('两种源各算各的本数与体积', () => {
    const totals = sourceTotals([
      book('a', 'local', 100), book('b', 'local', 300), book('c', 'pan', 1000),
    ]);
    assert.deepEqual(totals.map((row) => [row.kind, row.label, row.total, row.bytes]), [
      ['local', '本地', 2, 400],
      ['pan', '网盘', 1, 1000],
    ]);
  });

  it('书多的排前面（体积不参与排序 —— 一本 1GB 的书不该压过 800 本小书）', () => {
    const totals = sourceTotals([
      book('a', 'pan', 5_000_000_000), book('b', 'local', 1), book('c', 'local', 1),
    ]);
    assert.deepEqual(totals.map((row) => row.kind), ['local', 'pan']);
  });

  it('没有 listKind 时回落到 source —— 与 sourceLabelOf 同一套判据', () => {
    const totals = sourceTotals([{ id: 'a', source: 'pan', size: 10 }]);
    assert.deepEqual(totals.map((row) => [row.kind, row.label]), [['pan', '网盘']]);
  });

  it('来源完全缺失的书算进「其他」，不丢、也不写 NaN', () => {
    const totals = sourceTotals([{ id: 'a', size: 10 }, { id: 'b' }]);
    assert.deepEqual(totals.map((row) => [row.kind, row.label, row.total, row.bytes]), [
      ['other', '其他', 2, 10],
    ]);
  });

  it('空书架返回空数组（调用方不用判空）', () => {
    assert.deepEqual(sourceTotals([]), []);
    assert.deepEqual(sourceTotals(undefined), []);
  });

  it('★ 反向对照：按书单名分组会多出堆 —— 证明聚合粒度确实是 kind', () => {
    // 三个本地目录 = 三条源。若判据改成按 listName 分组，这里会数出 3 堆而不是 1 堆。
    const books = [
      book('a', 'local', 1, { listId: 'x', listName: '小说' }),
      book('b', 'local', 1, { listId: 'y', listName: '技术' }),
      book('c', 'local', 1, { listId: 'z', listName: '画册' }),
    ];
    assert.equal(sourceTotals(books).length, 1, '同类型的多个目录必须在同一堆里，否则那行会被撑爆');
    assert.equal(new Set(books.map((item) => item.listName)).size, 3, '反向对照本身要有牙：这三本书确实分属三个书单');
  });
});
