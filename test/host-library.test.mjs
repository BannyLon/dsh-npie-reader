/**
 * 书单索引的读取（`src/host/library.js`）。
 *
 * ★ 这个文件测的核心是「**两种失败必须能分开**」：
 *   - `missing = true`：文件不存在 ⇒ **配置问题**（用户还没配路径 / 换机器了）；
 *   - `error` 非空：文件在但读不了/解析不了/结构不对 ⇒ **数据问题**。
 *   合并成「一个空书架」会让「文件写坏了」看起来像「书全没了」，而这两句话对用户
 *   意味着完全不同的下一步。所以每个用例都同时断言这两个字段。
 *
 * ★ 另一条边界：这个模块**只读**索引文件。用例在读取前后比对文件内容与 mtime，
 *   证明它没有顺手写点什么（仓库外写操作是本项目的红线）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_LIBRARY_PATH,
  EXTERNAL_LIST_ID,
  createLibrary,
  externalStatesPath,
  mergeLibraries,
  readExternalStates,
  readLibraryIndex,
  resolveLibraryPath,
} from '../src/host/library.js';
import { isBookId, LIBRARY_PATH_DEFAULT } from '../src/library.js';
import { libraryIndexPath, pluginDataDir } from '../src/host/store.js';

const SANDBOX = await mkdtemp(join(tmpdir(), 'npie-lib-'));
const INDEX = join(SANDBOX, 'books.json');

after(() => rm(SANDBOX, { recursive: true, force: true }));

/** 一条接近真机形态的记录。 */
function row(overrides = {}) {
  return {
    id: 'b00001',
    filename: '忧郁的热带.pdf',
    abspath: '',
    pan_path: '/我的资源/欧洲文学/忧郁的热带.pdf',
    fs_id: 111,
    ext: 'pdf',
    size: 1024,
    top_dir: '欧洲文学',
    series: '文化生活译丛',
    year: 2000,
    title: '忧郁的热带',
    ...overrides,
  };
}

async function writeIndex(value, { text } = {}) {
  await writeFile(INDEX, text ?? JSON.stringify(value));
}

beforeEach(async () => {
  await rm(INDEX, { force: true });
  await rm(externalStatesPath(INDEX), { force: true });
});

describe('resolveLibraryPath', () => {
  it('★ 空值解析成**空串** —— 空串是「不用外部书单」，不再回落到插件数据目录', () => {
    // 回落是有害的：用户清空外部书单之后，界面会突然变成「在读插件自己那份」，
    // 而他刚刚才说过「不要用外部书单」—— 语义被悄悄改了，还看不出来是谁改的。
    for (const blank of ['', '   ', '\t', undefined, null, 42, {}, []]) {
      assert.equal(resolveLibraryPath(blank), '', JSON.stringify(blank));
    }
  });

  it('★ 默认值就是空串（真值只有一个来源）；插件数据目录那份另有出处', () => {
    // 这条守的是一个会伤到**所有**用户的缺陷：默认值一旦写成绝对路径，别人装完第一眼
    // 看到的就是作者机器上的路径。现在空串的表达力更强 —— 连「用插件那份」都不默认。
    assert.equal(DEFAULT_LIBRARY_PATH, LIBRARY_PATH_DEFAULT);
    assert.equal(DEFAULT_LIBRARY_PATH, '');
    // 「插件自己生成的那几份」由 `libraryListIds` 显式表达，落点在插件**专属**子目录下：
    // 不能是 `~/.dsh` 根，也不能是别的插件的目录（会跟别人抢同一个文件名）。
    const legacy = libraryIndexPath();
    assert.equal(legacy, join(pluginDataDir(), 'books.json'));
    assert.equal(
      legacy.endsWith(join('storages', 'dsh-npie-reader', 'books.json')),
      true,
      `落点不在插件数据目录里：${legacy}`,
    );
  });

  it('展开 `~` 并转成绝对路径', () => {
    assert.equal(resolveLibraryPath('~/Documents/x.json'), join(homedir(), 'Documents/x.json'));
    assert.equal(resolveLibraryPath('~'), homedir());
    assert.equal(resolveLibraryPath('/a/b/books.json'), '/a/b/books.json');
    // 两侧空格是粘贴常态，要 trim 掉而不是留成一个「前面带空格所以不存在」的路径。
    assert.equal(resolveLibraryPath('  /a/b/books.json  '), '/a/b/books.json');
  });

  it('相对路径按进程 cwd 解析成绝对路径（避免「看起来读了书单其实读的是空气」）', () => {
    const resolved = resolveLibraryPath('./data/books.json');
    assert.equal(resolved.startsWith('/'), true);
    assert.equal(resolved.endsWith('/data/books.json'), true);
  });
});

describe('externalStatesPath', () => {
  it('是**同目录**下的 reading.json', () => {
    assert.equal(externalStatesPath('/a/b/books.json'), '/a/b/reading.json');
    assert.equal(externalStatesPath('/a/books.json'), '/a/reading.json');
  });
});

describe('readLibraryIndex：正常路径', () => {
  it('顶层数组形态（用户那份书单的实际形态）', async () => {
    await writeIndex([row(), row({ id: 'b00002', filename: 'x.epub', ext: 'epub', fs_id: 222 })]);
    const result = await readLibraryIndex(INDEX);
    assert.equal(result.error, '');
    assert.equal(result.missing, false);
    assert.equal(result.path, INDEX);
    assert.equal(result.books.length, 2);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.books.map((book) => book.id), ['b00001', 'b00002']);
    assert.ok(result.bytes > 0);
  });

  it('也接受 `{ books: [...] }` 包装形态（以后换协议不用改代码）', async () => {
    await writeIndex({ version: 2, books: [row()] });
    const result = await readLibraryIndex(INDEX);
    assert.equal(result.error, '');
    assert.equal(result.books.length, 1);
  });

  it('★ 重复 id 只留第一条并计入 skipped（同 id 会让「点的是哪一本」不确定）', async () => {
    await writeIndex([row({ title: '第一本' }), row({ title: '第二本' }), row({ id: 'b00002' })]);
    const result = await readLibraryIndex(INDEX);
    assert.equal(result.books.length, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.books[0].title, '第一本');
  });

  it('没有合法 id 的条目计入 skipped，不打断整份书单', async () => {
    await writeIndex([row(), { filename: 'no-id.pdf' }, null, 'nope', row({ id: 'b00002' })]);
    const result = await readLibraryIndex(INDEX);
    assert.equal(result.error, '');
    assert.equal(result.books.length, 2);
    assert.equal(result.skipped, 3);
  });

  it('空数组是**合法**结果（不是错误）', async () => {
    await writeIndex([]);
    const result = await readLibraryIndex(INDEX);
    assert.equal(result.error, '');
    assert.equal(result.missing, false);
    assert.deepEqual(result.books, []);
  });

  it('★ 只读：读取前后文件内容与 mtime 都不变', async () => {
    await writeIndex([row()]);
    const before = await readFile(INDEX, 'utf8');
    const stampBefore = (await stat(INDEX)).mtimeMs;
    await readLibraryIndex(INDEX);
    assert.equal(await readFile(INDEX, 'utf8'), before);
    assert.equal((await stat(INDEX)).mtimeMs, stampBefore);
  });
});

describe('readLibraryIndex：两种失败必须分开', () => {
  it('文件不存在 ⇒ missing=true 且 error 为空（配置问题）', async () => {
    const result = await readLibraryIndex(join(SANDBOX, 'never-exists.json'));
    assert.equal(result.missing, true);
    assert.equal(result.error, '');
    assert.deepEqual(result.books, []);
  });

  it('★ 坏 JSON ⇒ error 非空且 missing=false（数据问题），绝不静默给空书架', async () => {
    await writeIndex(undefined, { text: '{ 这不是 JSON' });
    const result = await readLibraryIndex(INDEX);
    assert.equal(result.missing, false);
    assert.match(result.error, /不是合法 JSON/);
    assert.deepEqual(result.books, []);
  });

  it('结构不对（既不是数组也没有 books 数组）⇒ error', async () => {
    for (const value of [{}, { books: 'nope' }, 'text', 42, null]) {
      await writeIndex(value);
      const result = await readLibraryIndex(INDEX);
      assert.match(result.error, /结构不对/, JSON.stringify(value));
      assert.equal(result.missing, false);
    }
  });

  it('路径指向目录 ⇒ error 说「不是一个文件」', async () => {
    const directory = join(SANDBOX, 'a-directory');
    await mkdir(directory, { recursive: true });
    const result = await readLibraryIndex(directory);
    assert.match(result.error, /不是一个文件/);
  });

  it('超过体积上限 ⇒ error，且消息里带上实际大小', async () => {
    // 21 MB 的字符串写起来很快，但确实是个大文件 —— 用稀疏写法生成。
    await writeFile(INDEX, `[${' '.repeat(21 * 1024 * 1024)}]`);
    const result = await readLibraryIndex(INDEX);
    assert.match(result.error, /超过 20 MB 上限/);
    assert.equal(result.books.length, 0);
  });

  it('超过条数上限 ⇒ error（防畸形文件把内存撑爆）', async () => {
    const many = Array.from({ length: 20_001 }, (_, index) => row({ id: `b${index}` }));
    await writeIndex(many);
    const result = await readLibraryIndex(INDEX);
    assert.match(result.error, /超过 20000 条上限/);
  });

  it('★ 三种失败互斥：每条用例里另外两个字段必须是「干净」的', async () => {
    // 「missing 与 error 同时为真」会让界面说两句矛盾的话，所以这里显式钉住互斥性。
    const missing = await readLibraryIndex(join(SANDBOX, 'nope.json'));
    assert.deepEqual([missing.missing, missing.error], [true, '']);

    await writeIndex(undefined, { text: 'nope' });
    const broken = await readLibraryIndex(INDEX);
    assert.deepEqual([broken.missing, broken.error === ''], [false, false]);

    await writeIndex([row()]);
    const ok = await readLibraryIndex(INDEX);
    assert.deepEqual([ok.missing, ok.error], [false, '']);
  });
});

describe('readExternalStates', () => {
  it('读同目录的 reading.json，只保留 id 合法的键', async () => {
    await writeIndex([row()]);
    await writeFile(externalStatesPath(INDEX), JSON.stringify({
      b01322: { state: 'reading', page: 1, at: 1791286633475, pages: 350 },
      'bad id': { state: 'read' },
    }));
    const states = await readExternalStates(INDEX);
    assert.deepEqual(Object.keys(states), ['b01322']);
    assert.equal(states.b01322.page, 1);
  });

  it('★ 任何问题都回空对象（这份进度是锦上添花，不该拦住整个书架）', async () => {
    await writeIndex([row()]);
    for (const content of ['{坏', '[]', '"text"', 'null', '42']) {
      await writeFile(externalStatesPath(INDEX), content);
      assert.deepEqual(await readExternalStates(INDEX), {}, content);
    }
    await rm(externalStatesPath(INDEX), { force: true });
    assert.deepEqual(await readExternalStates(INDEX), {});
  });

  it('★ 只读：不会在索引目录里造出任何新文件', async () => {
    await writeIndex([row()]);
    const before = await readFile(externalStatesPath(INDEX), 'utf8').catch(() => null);
    await readExternalStates(INDEX);
    const after2 = await readFile(externalStatesPath(INDEX), 'utf8').catch(() => null);
    assert.equal(before, after2);
    assert.equal(after2, null, '本来不存在的 reading.json 被创建了');
  });
});

describe('mergeLibraries：按 id 合并、不重复计数', () => {
  it('★ 同一个 id 出现在两份书单里只留一条（用户把子目录也加了一份是常态）', () => {
    const merged = mergeLibraries([
      { books: [row()], skipped: 0 },
      { books: [row({ title: '重复的那本' }), row({ id: 'b00002' })], skipped: 1 },
    ]);
    assert.equal(merged.books.length, 2);
    // 第一条胜出：与 `readLibraryIndex` 内部「重复 id 只留第一条」保持同一个方向。
    assert.equal(merged.books[0].title, '忧郁的热带');
    // skipped 是**累加**的，不是取一份 —— 否则「有 3 条跳过」的数字会随来源数变小。
    assert.equal(merged.skipped, 1);
  });

  it('空输入 / 坏输入不抛错，回空书架', () => {
    for (const bad of [undefined, null, [], [{}, { books: null }]]) {
      assert.deepEqual(mergeLibraries(bad).books, []);
    }
  });

  it('★ 排序与去重**复用 book-source 的 mergeSources**（同一份判据不在两处各写一遍）', () => {
    // 反向对照：只给一份时顺序必须是 mergeSources 的顺序，不是输入顺序。
    const books = [row({ id: 'b00002', top_dir: 'A' }), row({ id: 'b00001', top_dir: 'B' })];
    assert.deepEqual(
      mergeLibraries([{ books }]).books.map((book) => book.id),
      mergeLibraries([{ books: [] }, { books }]).books.map((book) => book.id),
    );
  });
});

describe('createLibrary：按 mtime/size 缓存', () => {
  it('同一份文件第二次不再重新解析（reloaded=false）', async () => {
    await writeIndex([row()]);
    const library = createLibrary();
    const first = await library.load({ externalPath: INDEX });
    assert.equal(first.reloaded, true);
    assert.equal(first.books.length, 1);
    const second = await library.load({ externalPath: INDEX });
    assert.equal(second.reloaded, false);
    assert.equal(second.books.length, 1);
  });

  it('★ 文件变了（mtime 或大小）就重新读 —— 用户整理完书单不用重启', async () => {
    await writeIndex([row()]);
    const library = createLibrary();
    await library.load({ externalPath: INDEX });

    await writeIndex([row(), row({ id: 'b00002' })]);
    const after = await library.load({ externalPath: INDEX });
    assert.equal(after.reloaded, true);
    assert.equal(after.books.length, 2);

    // 反向对照：**内容没变**时不该重读（否则每次请求都在解析 1.8 MB 的 JSON）。
    const again = await library.load({ externalPath: INDEX });
    assert.equal(again.reloaded, false);

    // 只改 mtime（内容不变）也必须重读 —— 用户可能用 `touch` 触发刷新。
    const future = new Date(Date.now() + 10_000);
    await utimes(INDEX, future, future);
    const touched = await library.load({ externalPath: INDEX });
    assert.equal(touched.reloaded, true);
  });

  it('★ 换掉 `lists`（勾掉一份 / 新勾一份）也必须重读，不能拿旧合并结果糊弄', async () => {
    const other = join(SANDBOX, 'second.json');
    await writeIndex([row()]);
    await writeFile(other, JSON.stringify([row({ id: 'b00009' })]));
    const library = createLibrary();
    const listA = { id: 'sa', name: 'A', kind: 'local', root: '', path: INDEX };
    const listB = { id: 'sb', name: 'B', kind: 'local', root: '', path: other };

    assert.deepEqual((await library.load({ lists: [listA] })).books.map((b) => b.id), ['b00001']);
    assert.equal((await library.load({ lists: [listA] })).reloaded, false);
    // 加上第二份 ⇒ 必须重读（stamp 里含两份路径，长度变了）。
    const both = await library.load({ lists: [listA, listB] });
    assert.equal(both.reloaded, true);
    assert.deepEqual(both.books.map((b) => b.id).sort(), ['b00001', 'b00009']);
    // 勾回去 ⇒ 仍然按「两份的合并」缓存，不会因为少了一份就张冠李戴。
    assert.deepEqual((await library.load({ lists: [listB] })).books.map((b) => b.id), ['b00009']);
    assert.equal((await library.load({ lists: [listB] })).reloaded, false);
  });

  it('invalidate() 强制下一次重读', async () => {
    await writeIndex([row()]);
    const library = createLibrary();
    await library.load({ externalPath: INDEX });
    library.invalidate();
    assert.equal((await library.load({ externalPath: INDEX })).reloaded, true);
  });

  it('文件不存在时也能 load（missing=true），并且日志里会说明是读取失败', async () => {
    const lines = [];
    const library = createLibrary({ log: (message) => lines.push(message) });
    const result = await library.load({ externalPath: join(SANDBOX, 'nope.json') });
    assert.equal(result.missing, true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /书单已载入：0 本/);
  });

  it('读取失败时日志带出真实原因（否则线上只有「书架是空的」）', async () => {
    await writeIndex(undefined, { text: 'not json' });
    const lines = [];
    const library = createLibrary({ log: (message) => lines.push(message) });
    await library.load({ externalPath: INDEX });
    // 两行：先「哪一份坏了、为什么」，再「这一轮一共载入了多少本」。
    // 只留汇总的话，线上能看到的还是「书架是空的」，故障原因被抹掉了。
    assert.equal(lines.length, 2);
    assert.match(lines[0], /书单读取失败/);
    assert.match(lines[0], /不是合法 JSON/);
    assert.match(lines[1], /书单已载入：0 本/);
  });
});

describe('createLibrary：多份书单 + 外部书单的合并结果', () => {
  /** 造一份 list 条目（形状照抄 service.js 传给 `load()` 的那份）。 */
  function listEntry(id, name, file) {
    return { id, name, kind: 'local', root: '', path: file };
  }

  it('★ 没有任何来源时 missing=true 但 error 为空 —— 这是配置问题，不是数据坏了', async () => {
    const result = await createLibrary().load();
    assert.deepEqual([result.missing, result.error, result.books.length], [true, '', 0]);
    assert.deepEqual(result.sources, []);
    assert.equal(result.external, null);
    assert.equal(result.externalPath, '');
  });

  it('★ 一份坏掉时**其余照常**，顶层 error 为空，坏的那份自己带 error', async () => {
    const good = join(SANDBOX, 'good.json');
    const bad = join(SANDBOX, 'bad.json');
    await writeFile(good, JSON.stringify([row()]));
    await writeFile(bad, '{ 坏 JSON');
    const result = await createLibrary({ log: () => {} }).load({
      lists: [listEntry('sgood', '好的一份', good), listEntry('sbad', '坏的一份', bad)],
    });
    assert.equal(result.books.length, 1);
    assert.equal(result.error, '', '一份坏掉不该把整个书架判死');
    assert.equal(result.missing, false);
    const failed = result.sources.filter((entry) => entry.error !== '');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, 'sbad');
    assert.match(failed[0].error, /不是合法 JSON/);
  });

  it('★ 全部坏掉时顶层 error 才有值 —— 否则「文件写坏了」看起来像「书全没了」', async () => {
    const a = join(SANDBOX, 'x1.json');
    const b = join(SANDBOX, 'x2.json');
    await writeFile(a, '{ 坏');
    await writeFile(b, '也不是 JSON');
    const result = await createLibrary({ log: () => {} }).load({
      lists: [listEntry('s1', '一', a), listEntry('s2', '二', b)],
    });
    assert.notEqual(result.error, '');
    assert.equal(result.missing, false);
    assert.equal(result.books.length, 0);
  });

  it('★ 每份书单都还在 `sources[]` 里（含空的那份）—— 界面要逐份显示计数', async () => {
    const a = join(SANDBOX, 'm1.json');
    const b = join(SANDBOX, 'm2.json');
    await writeFile(a, JSON.stringify([row()]));
    await writeFile(b, JSON.stringify([]));
    const result = await createLibrary().load({
      lists: [listEntry('s1', '有书', a), listEntry('s2', '空的', b)],
    });
    assert.deepEqual(result.sources.map((entry) => [entry.id, entry.count]), [['s1', 1], ['s2', 0]]);
    assert.deepEqual(result.sources.map((entry) => entry.external), [false, false]);
    // 一份空 + 一份有书 ⇒ 不是 missing（用户确实配了源，只是其中一份是空的）。
    assert.equal(result.missing, false);
  });

  it('★ 外部书单单独成一份，id 固定为 EXTERNAL_LIST_ID 且不与生成的 id 冲突', async () => {
    const generated = join(SANDBOX, 'g.json');
    await writeFile(generated, JSON.stringify([row({ id: 'b00001' })]));
    await writeFile(INDEX, JSON.stringify([row({ id: 'b00002' })]));
    const result = await createLibrary().load({
      externalPath: INDEX,
      lists: [listEntry('s4117ec5863472f9c', '生成的一份', generated)],
    });
    assert.equal(result.sources.length, 2);
    assert.equal(result.external.id, EXTERNAL_LIST_ID);
    assert.equal(result.external.external, true);
    assert.equal(result.external.missing, false);
    // 顶层 path 优先给外部那份（用户手填的那条更值得显示）。
    assert.equal(result.path, INDEX);
    assert.deepEqual(result.sources.map((entry) => entry.id), ['s4117ec5863472f9c', EXTERNAL_LIST_ID]);
    // 反向对照：外部 id 是固定常量，不是从 `bookIdFromPath` 算出来的，形状上也不同。
    assert.equal(isBookId(EXTERNAL_LIST_ID), true);
  });

  it('★ 外部书单**没配**时 external 为 null（而不是一个空壳对象）', async () => {
    const generated = join(SANDBOX, 'only.json');
    await writeFile(generated, JSON.stringify([row()]));
    const result = await createLibrary().load({ lists: [listEntry('s1', '一份', generated)] });
    assert.equal(result.external, null);
    assert.equal(result.externalPath, '');
    assert.equal(result.path, generated);
  });

  it('★ 外部书单指向不存在的文件 ⇒ missing=true，但**生成的那份照常可用**', async () => {
    const generated = join(SANDBOX, 'alive.json');
    await writeFile(generated, JSON.stringify([row()]));
    const result = await createLibrary().load({
      externalPath: join(SANDBOX, 'gone.json'),
      lists: [listEntry('s1', '一份', generated)],
    });
    assert.equal(result.books.length, 1);
    assert.equal(result.missing, false, '还有一份能读就不是「缺文件」');
    assert.equal(result.external.missing, true);
    assert.equal(result.error, '');
  });

  it('★ 条目的 `name` / `root` 原样带出去（界面直接显示，不再回查设置）', async () => {
    const generated = join(SANDBOX, 'named.json');
    await writeFile(generated, JSON.stringify([row()]));
    const result = await createLibrary().load({
      lists: [{ id: 's1', name: '网盘 · 电子书', kind: 'pan', root: '/我的资源/电子书', path: generated }],
    });
    assert.deepEqual(
      [result.sources[0].name, result.sources[0].kind, result.sources[0].root],
      ['网盘 · 电子书', 'pan', '/我的资源/电子书'],
    );
  });

  it('映射里缺 `path` 的条目被跳过，而不是拼出一个空路径去 stat', async () => {
    const result = await createLibrary().load({ lists: [{ id: 's1', name: '空壳' }, null, { path: '' }] });
    assert.deepEqual(result.sources, []);
    assert.equal(result.missing, true);
  });
});
