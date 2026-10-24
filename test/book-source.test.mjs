/**
 * 从书源生成书单（`src/host/book-source.js`）。
 *
 * ★ 这个文件要守住三条互相独立的性质，每条都配反向对照：
 *
 *   1. **单个源失败不中断整次扫描**。用户配了 3 个源、坏掉 1 个时，应该拿到另外 2 个
 *      的结果 + 一句「第 3 个读不了」；全都返回空等于把一个坏目录放大成「一本书都没了」。
 *   2. **id 跨次扫描稳定**。进度是按 id 记的，重新生成书单一换 id 就等于把用户所有
 *      阅读进度清零 —— 而这恰恰是最该保住的东西。
 *   3. **不跟符号链接**。跟了会绕圈（软链指回上层）、也会悄悄把书扫到用户配的根目录
 *      之外 —— 而越界正是 `local-books.js` 花三道闸挡的事，在扫描阶段放进来等于白挡。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  MAX_SCAN_BOOKS,
  buildPreviousIds,
  mergeSources,
  normalizePanPath,
  scanLocalRoots,
  scanPanRoots,
  sourceKeyOf,
  topDirOf,
} from '../src/host/book-source.js';

const SANDBOX = await mkdtemp(join(tmpdir(), 'npie-src-'));
const ROOT = join(SANDBOX, '库');

before(async () => {
  await mkdir(join(ROOT, '甲', '深'), { recursive: true });
  await mkdir(join(ROOT, '乙'), { recursive: true });
  await mkdir(join(ROOT, '.hidden'), { recursive: true });
  await writeFile(join(ROOT, '甲', '忧郁的热带_20201020_174427.pdf'), 'PDF-A');
  await writeFile(join(ROOT, '甲', '深', 'deep.pdf'), 'PDF-DEEP');
  await writeFile(join(ROOT, '乙', 'y.epub'), 'EPUB-B');
  await writeFile(join(ROOT, '散本.pdf'), 'PDF-FLAT');
  await writeFile(join(ROOT, 'bad.md'), 'NOT-A-BOOK');
  await writeFile(join(ROOT, '.hidden', 'nope.pdf'), 'HIDDEN');
  await writeFile(join(ROOT, '.DS_Store'), 'junk');
  // ★ 根目录之内的符号链接，指向根目录**之外**：扫描阶段就必须跳过。
  await writeFile(join(SANDBOX, '外面的书.pdf'), 'OUTSIDE');
  await symlink(join(SANDBOX, '外面的书.pdf'), join(ROOT, 'link.pdf'));
});

after(() => rm(SANDBOX, { recursive: true, force: true }));

describe('topDirOf', () => {
  it('取相对路径的**第一个目录名**；直接放在源根下时是空串', () => {
    assert.equal(topDirOf('甲/忧郁的热带.pdf'), '甲');
    assert.equal(topDirOf('甲/深/deep.pdf'), '甲');
    assert.equal(topDirOf('散本.pdf'), '');
    assert.equal(topDirOf('/甲/x.pdf'), '甲');
    assert.equal(topDirOf('甲//x.pdf'), '甲');
  });

  it('空值 / 非字符串不抛错，回空串', () => {
    for (const bad of ['', undefined, null, 0, {}]) {
      assert.equal(topDirOf(bad), '', String(bad));
    }
    // 反向对照：一个只有目录名、没有文件名的输入不算有分类目录（目录名不是分类）。
    assert.equal(topDirOf('甲'), '');
  });
});

describe('normalizePanPath', () => {
  it('统一成「以 / 开头、不以 / 结尾、无重复分隔符」', () => {
    assert.equal(normalizePanPath('/E书'), '/E书');
    assert.equal(normalizePanPath('E书'), '/E书');
    assert.equal(normalizePanPath('/E书/'), '/E书');
    assert.equal(normalizePanPath('E书//子目录'), '/E书/子目录');
    assert.equal(normalizePanPath('E书\\子目录'), '/E书/子目录');
    assert.equal(normalizePanPath('  /E书  '), '/E书');
  });

  it('空值回空串；根路径 `/` 保持 `/`', () => {
    for (const bad of ['', '   ', undefined, null]) {
      assert.equal(normalizePanPath(bad), '', String(bad));
    }
    // 反向对照：`/` 去掉尾分隔符会变成空串 ⇒ 会被上层判成「网盘路径是空的」。
    assert.equal(normalizePanPath('/'), '/');
    assert.equal(normalizePanPath('///'), '/');
    // ★ 这里**不**列数字：`String(0)` 是 `'0'`，函数会老实地推出 `/0`。
    //   那不是一个要守的判据 —— 设置校验（`normalizeBookSource`）已经要求 path 是字符串，
    //   数字到不了这里。写进用例只会造一条「实现没承诺过」的断言。
  });
});

describe('sourceKeyOf / buildPreviousIds', () => {
  it('网盘认 fsId（改名/移动都不变），本地认绝对路径', () => {
    assert.equal(sourceKeyOf({ fsId: 42 }), 'pan:42');
    assert.equal(sourceKeyOf({ fsId: 0, localPath: '/库/甲/书.pdf' }), 'local:/库/甲/书.pdf');
    // ★ 网盘优先：一条同时有 fsId 与本地路径的记录，认领键必须是网盘的那个 ——
    //   否则同一本书在「本地也存了一份」之后会被当成新书，进度清零。
    assert.equal(sourceKeyOf({ fsId: 42, localPath: '/库/甲/书.pdf' }), 'pan:42');
  });

  it('两条凭据都没有 → 空串（这种记录不参与 id 认领）', () => {
    for (const bad of [{}, { fsId: 0 }, { fsId: 0, localPath: '  ' }, null, undefined, 'x', 42]) {
      assert.equal(sourceKeyOf(bad), '', JSON.stringify(bad));
    }
  });

  it('buildPreviousIds：同键只留**第一条**（对应「先扫到的那个 id 是用户正在读的」）', () => {
    const map = buildPreviousIds([
      { id: 'a1', fsId: 1 },
      { id: 'a2', fsId: 1 },
      { id: 'b1', localPath: '/库/x.pdf' },
      { id: 'c1' },
    ]);
    assert.equal(map.get('pan:1'), 'a1');
    assert.equal(map.get('local:/库/x.pdf'), 'b1');
    assert.equal(map.size, 2);
    // 反向对照：非数组不抛错。
    assert.equal(buildPreviousIds(undefined).size, 0);
    assert.equal(buildPreviousIds(null).size, 0);
  });
});

describe('scanLocalRoots', () => {
  it('扫出电子书、算好 relpath / abspath / top_dir / title / ext / size', async () => {
    const { books, errors, stats } = await scanLocalRoots([ROOT]);
    assert.deepEqual(errors, []);
    const names = books.map((book) => book.filename).sort();
    assert.deepEqual(names, ['deep.pdf', 'y.epub', '忧郁的热带_20201020_174427.pdf', '散本.pdf'].sort());

    const flat = books.find((book) => book.filename === '散本.pdf');
    assert.equal(flat.abspath, join(ROOT, '散本.pdf'));
    assert.equal(flat.relpath, '散本.pdf');
    assert.equal(flat.top_dir, '');
    assert.equal(flat.ext, 'pdf');
    assert.equal(flat.size, Buffer.byteLength('PDF-FLAT'));
    assert.equal(flat.title, '散本');

    const deep = books.find((book) => book.filename === 'deep.pdf');
    assert.equal(deep.relpath, join('甲', '深', 'deep.pdf'));
    assert.equal(deep.top_dir, '甲', '分类目录是**第一层**，不是最深那一层');

    // 文件名里的 `_20201020_174427` 时间后缀要被清掉（`titleFromFilename`）。
    const tropic = books.find((book) => book.ext === 'pdf' && book.filename.startsWith('忧郁'));
    assert.equal(tropic.title, '忧郁的热带');

    assert.equal(stats.local, books.length);
    // ★ 刻意**不**填 series / year：文件名里的 `[古罗马]` 是国别不是丛书，正则猜出来的
    //   会让「按丛书分组」把书归错类，而用户会把这行当成事实。宁可空着。
    for (const book of books) {
      assert.equal(Object.hasOwn(book, 'series'), false, `${book.filename} 不该有 series`);
      assert.equal(Object.hasOwn(book, 'year'), false, `${book.filename} 不该有 year`);
    }
  });

  it('★ 跳过符号链接、隐藏项、非电子书后缀（并且把「跳过」计入 stats）', async () => {
    const { books, stats } = await scanLocalRoots([ROOT]);
    const names = books.map((book) => book.filename);
    // 跟了软链接就会读到「外面的书.pdf」——那是根目录之外的文件。
    assert.equal(names.includes('link.pdf'), false);
    assert.equal(names.includes('外面的书.pdf'), false);
    // 隐藏目录整个不进（`.hidden/nope.pdf`、`.DS_Store` 都不该出现）。
    assert.equal(names.includes('nope.pdf'), false);
    assert.equal(names.includes('.DS_Store'), false);
    assert.equal(names.includes('bad.md'), false);
    // `.md` 与软链接各计一次跳过；隐藏项**不进**计数（它们是被规则挡的噪声，不是异常）。
    assert.ok(stats.skipped >= 2, `skipped=${stats.skipped}，应当至少含 bad.md 与 link.pdf`);
    assert.ok(stats.seenFiles >= 4);
  });

  it('★ 单个根目录坏掉不中断整次扫描', async () => {
    const dead = join(SANDBOX, '不存在的目录');
    const { books, errors } = await scanLocalRoots([dead, ROOT]);
    // 好根的结果照常返回 —— 这是「配了 3 个源坏 1 个」时的正确表现。
    assert.equal(books.length, 4);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].root, dead);
    assert.match(errors[0].message, /目录不存在/);
    // 反向对照：把坏根放后面也一样（顺序不该影响结果）。
    const reversed = await scanLocalRoots([ROOT, dead]);
    assert.equal(reversed.books.length, 4);
    assert.equal(reversed.errors.length, 1);
  });

  it('根目录不是目录 → 一句「不是一个目录」，而不是当成空目录静默跳过', async () => {
    const { books, errors } = await scanLocalRoots([join(ROOT, '散本.pdf')]);
    assert.deepEqual(books, []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, '不是一个目录');
  });

  it('空 / 非数组根列表 → 空结果且不抛错', async () => {
    for (const roots of [[], undefined, null, 'x']) {
      const result = await scanLocalRoots(roots);
      assert.deepEqual(result.books, [], String(roots));
      assert.deepEqual(result.errors, []);
    }
  });

  it('★ 达到条数上限时给出**明确的一句**（而不是静默少扫几本）', async () => {
    const { books, errors } = await scanLocalRoots([ROOT], { maxBooks: 2 });
    assert.equal(books.length, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /上限/);
    // 反向对照：上限没到就不该有这条提示。
    const plenty = await scanLocalRoots([ROOT], { maxBooks: MAX_SCAN_BOOKS });
    assert.deepEqual(plenty.errors, []);
  });

  it('★ id 跨次扫描稳定：重新扫一遍，同一批文件的 id 一个都不变', async () => {
    const first = await scanLocalRoots([ROOT]);
    const previousIds = buildPreviousIds(first.books);
    const second = await scanLocalRoots([ROOT], { previousIds });
    const idOf = (result) => new Map(result.books.map((book) => [book.filename, book.id]));
    assert.deepEqual(idOf(second), idOf(first), '重扫换了 id ⇒ 用户点一次「生成书单」就清空全部进度');
  });

  it('★ 认领是按**文件**而不是按整份书单：老文件保 id、新文件拿新 id', async () => {
    const first = await scanLocalRoots([ROOT]);
    const before = new Map(first.books.map((book) => [book.filename, book.id]));
    const added = join(ROOT, '乙', '新来的.pdf');
    await writeFile(added, 'NEW');
    try {
      const second = await scanLocalRoots([ROOT], { previousIds: buildPreviousIds(first.books) });
      const after = new Map(second.books.map((book) => [book.filename, book.id]));
      for (const [name, id] of before) assert.equal(after.get(name), id, `${name} 的 id 变了`);
      assert.equal(after.has('新来的.pdf'), true);
      assert.equal(before.has('新来的.pdf'), false);
    } finally {
      await rm(added, { force: true });
    }
  });
});

describe('scanPanRoots', () => {
  /**
   * 真机形态（2026-10-09 实测后修正）：xpan list 的 `recursion=1` **不递归**，
   * 每次只回这一层 —— 所以 TREE 按「目录 → 单层条目」组织，递归是 scanPanRoots
   * 自己 BFS 出来的。旧版这里按「一次摊平整棵子树」造假数据，正好把 bug 盖住了：
   * 测试全绿、真机 0 本。
   */
  const TREE = {
    '/E书': [
      { name: '甲.pdf', path: '/E书/甲.pdf', fsId: 11, size: 100 },
      { name: '子目录', path: '/E书/子', fsId: 12, isDir: true },
      { name: '说明.md', path: '/E书/说明.md', fsId: 13, size: 5 },
      { name: '坏.pdf', path: '/E书/坏.pdf', fsId: 0, size: 5 },
      { name: '也没 id.pdf', path: '/E书/也没 id.pdf', fsId: 'abc', size: 5 },
    ],
    '/E书/子': [
      { name: '乙.epub', path: '/E书/子/乙.epub', fsId: 14, size: 200 },
      { name: '更深层', path: '/E书/子/深', fsId: 15, isDir: true },
    ],
    '/E书/子/深': [
      { name: '丙.txt', path: '/E书/子/深/丙.txt', fsId: 16, size: 300 },
    ],
    '/另一个源': [{ name: '分类目录', path: '/另一个源/分类', fsId: 21, isDir: true }],
    '/另一个源/分类': [{ name: '丁.pdf', path: '/另一个源/分类/丁.pdf', fsId: 22, size: 400 }],
  };
  const listed = [];
  const listDir = async (dir) => {
    listed.push(dir);
    if (!Object.hasOwn(TREE, dir)) throw new Error(`列目录失败：${dir}`);
    return TREE[dir];
  };

  it('★ 递归下钻：子目录（含更深层）里的书都能扫到 —— recursion 不递归，得自己 BFS', async () => {
    const { books, errors, stats } = await scanPanRoots(['/E书'], { listDir });
    assert.deepEqual(errors, [], `不该有错：${JSON.stringify(errors)}`);
    assert.deepEqual(books.map((book) => book.filename).sort(), ['乙.epub', '丙.txt', '甲.pdf'].sort());
    assert.equal(stats.dirs, 3, '根 + 两层子目录都列到了');

    const first = books.find((book) => book.filename === '甲.pdf');
    assert.equal(first.fs_id, 11);
    assert.equal(first.pan_path, '/E书/甲.pdf');
    assert.equal(first.ext, 'pdf');
    assert.equal(first.size, 100);
    assert.equal(first.top_dir, '', '直接放在源根下 ⇒ 没有分类目录');
    assert.equal(Object.hasOwn(first, 'abspath'), false, '网盘书不该带本地路径');

    const nested = books.find((book) => book.filename === '乙.epub');
    assert.equal(nested.top_dir, '子', '分类目录取源根之后的第一层');
    const deep = books.find((book) => book.filename === '丙.txt');
    assert.equal(deep.top_dir, '子', '更深的书分类也取第一层，不取全路径');

    // 目录、非电子书后缀、fs_id 非正整数各计一次跳过。
    assert.equal(stats.pan, books.length);
    assert.equal(stats.skipped, 3);
  });

  it('★ 一个源列不出来不中断整次扫描（另一句明确的话 + 其余源的结果）', async () => {
    const { books, errors } = await scanPanRoots(['/不存在的源', '/另一个源'], { listDir });
    assert.deepEqual(books.map((book) => book.filename), ['丁.pdf']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].root, '/不存在的源');
    assert.match(errors[0].message, /列目录失败/);
  });

  it('中间某层列不出来：报错但继续扫其余分支（单目录失败不吞掉整棵树）', async () => {
    const broken = { ...TREE };
    delete broken['/E书/子'];
    const { books, errors } = await scanPanRoots(['/E书'], {
      listDir: async (dir) => {
        if (!Object.hasOwn(broken, dir)) throw new Error(`列目录失败：${dir}`);
        return broken[dir];
      },
    });
    assert.ok(books.some((book) => book.filename === '甲.pdf'), '顶层的书还在');
    assert.ok(!books.some((book) => book.filename === '乙.epub'), '坏掉那层的书确实没扫到');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].dir, '/E书/子');
  });

  it('网盘路径是空的 → 明确报一句，而不是去列根目录', async () => {
    const calls = [];
    const { errors } = await scanPanRoots(['', '   ', '/E书'], { listDir: async (dir) => { calls.push(dir); return listDir(dir); } });
    assert.equal(errors.filter((item) => item.message === '网盘路径是空的').length, 2);
    // BFS 会继续下钻 /E书 的子目录，这里只钉住两条硬判据：空串绝不落到 listDir、
    // 第一个被列的目录是源根本身（不是根 `/`）。
    assert.ok(!calls.includes(''), `空路径不许落到 listDir：${JSON.stringify(calls)}`);
    assert.equal(calls[0], '/E书');
  });

  it('没给 listDir → TypeError（接线漏了要立刻炸，而不是静默产出空书单）', async () => {
    await assert.rejects(() => scanPanRoots(['/E书'], {}), TypeError);
    await assert.rejects(() => scanPanRoots(['/E书']), TypeError);
  });

  it('★ id 跨次扫描稳定（网盘侧认 fsId，改名也不变）', async () => {
    const first = await scanPanRoots(['/E书'], { listDir });
    const renamedDirs = new Set(['/E书']);
    const renamed = async (dir) => (await listDir(dir)).map((entry) => (
      entry.name === '甲.pdf' && renamedDirs.has(dir) ? { ...entry, name: '甲（改名）.pdf', path: '/E书/甲（改名）.pdf' } : entry
    ));
    const second = await scanPanRoots(['/E书'], { listDir: renamed, previousIds: buildPreviousIds(first.books) });
    const before = first.books.find((book) => book.fs_id === 11).id;
    const after = second.books.find((book) => book.fs_id === 11).id;
    assert.equal(after, before, '改名换了 id ⇒ 进度清零（而这正是 fsId 存在的意义）');
  });

  it('多源 + 上限：达到上限时给一句明确的话', async () => {
    const { books, errors } = await scanPanRoots(['/E书', '/另一个源'], { listDir, maxBooks: 2 });
    assert.equal(books.length, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /上限/);
  });
});

describe('mergeSources', () => {
  it('按 id 去重（重叠的源会产出同一个 id），第一条优先', () => {
    const merged = mergeSources(
      [{ id: 'a', top_dir: '甲', title: 'x' }],
      [{ id: 'a', top_dir: '乙', title: 'y' }, { id: 'b', top_dir: '乙', title: 'b' }],
    );
    assert.deepEqual(merged.map((book) => book.id), ['a', 'b']);
    assert.equal(merged[0].top_dir, '甲', '第一条优先');
  });

  it('★ 排序在生成时就定下来：按分类 + 书名 —— 直接打开那份 JSON 也是能读的顺序', () => {
    const merged = mergeSources([
      { id: '3', top_dir: '乙', title: 'a' },
      { id: '1', top_dir: '甲', title: 'b' },
      { id: '2', top_dir: '甲', title: 'a' },
      { id: '0', top_dir: '', title: 'z' },
    ]);
    // 反向对照：这不是「按 title 排」——若按 title 排会得到 [2,3,1,0]（z 排最后也不算数，
    // 见下面那条说明）；这里是**先分类、后书名**，所以同分类内永远是 a 在 b 前。
    const order = merged.map((book) => book.id);
    assert.notDeepEqual(order, ['2', '3', '1', '0']);
    // 同分类内按书名：甲 组里 2(a) 在 1(b) 之前。
    assert.ok(order.indexOf('2') < order.indexOf('1'), `甲 组内顺序错了：${order}`);
    // 分类之间：所有 甲 都在所有 乙 之前。
    assert.ok(order.indexOf('1') < order.indexOf('3'), `分类之间顺序错了：${order}`);

    /**
     * ★ 空分类（直接放在源根下的书）**不在最前面**，这是实测出来的，不是笔误。
     *
     * 排序键是 `` `${top_dir}\u0000${title}` ``，而 ICU 把 `\u0000` 当成**可忽略字符**：
     * 于是 `'\u0000z'` 与 `'甲\u0000a'` 比的是 `'z'` 与 `'甲'`，而在 `zh-Hans-CN` 里
     * 拉丁字母排在汉字**之后** ⇒ 这条落在末尾。
     * 影响仅限「源根下那些散本排在哪一段」，不影响分组正确性，所以这里把它**固定成
     * 事实**（而不是改判据）：哪天换排序键，这条会红，提醒重新想一遍空分类的去处。
     */
    assert.equal(order.indexOf('0'), order.length - 1, `空分类的位置变了：${order}`);
  });

  it('空分组 / 非数组不抛错', () => {
    assert.deepEqual(mergeSources(), []);
    assert.deepEqual(mergeSources(undefined, null, []), []);
    assert.deepEqual(mergeSources([{ id: 'a' }]).length, 1);
  });
});

// 「生成后把书单写到哪里」的用例搬去了 `book-lists.test.mjs`：0.8.0 起**一条书源
// 一份书单**，写入方是 `book-lists.js` 的 `writeListFile`（文件名由书源 id 决定），
// 这个模块只负责**算出**条目，不再碰盘。
