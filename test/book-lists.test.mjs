/**
 * 书单文件与清单（`src/host/book-lists.js`）—— **一条书源 = 一份书单**。
 *
 * ★ 这个文件守三件事：
 *
 *   1. **文件名由 id 决定，不由顺序决定**。用下标命名的话，用户在第二步删掉中间
 *      一条书源，后面每一份书单都会**整体错位** —— A 的书单变成 B 的。
 *   2. **清单里只存扫出来的事实**（id / 本数 / 生成时间）。名字和路径是用户配置，
 *      在清单里再存一份就是第二个真相来源，迟早出现「设置里叫甲、列表里叫乙」。
 *   3. **写盘一律 600 + 原子**。书单里是本机绝对路径，权限和 `data.json` 一个档。
 *
 * ★ 安全前提：`bookListsDir()` 解析 `DSH_HOME`，默认落在用户真实的 `~/.dsh`。
 *   本文件在**第一次调用任何函数之前**把 `DSH_HOME` 指向临时目录，并断言解析结果
 *   确实在 `tmpdir()` 下 —— 万一将来有人改坏了这条链路，测试会当场判红，
 *   而不是把用户真实的书单目录写花。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  LISTS_INDEX_VERSION,
  listFilePath,
  pruneListsIndex,
  readListsIndex,
  removeListFile,
  writeListFile,
  writeListsIndex,
} from '../src/host/book-lists.js';
import { bookListsDir, bookListsIndexPath, pluginDataDir } from '../src/host/store.js';

const SANDBOX = await mkdtemp(join(tmpdir(), `npie-lists-${process.pid}-`));
process.env.DSH_HOME = SANDBOX;

after(() => rm(SANDBOX, { recursive: true, force: true }));

/** 一个合法的书源 id（形状与 `sourceListId` 一致：前缀 + 16 位十六进制）。 */
const ID_A = 's0123456789abcdef';
const ID_B = 'sfedcba9876543210';

describe('落点', () => {
  it('★ 必须落在 `DSH_HOME` 下的插件专属子目录 —— 绝不碰用户真实数据目录', () => {
    const dir = bookListsDir();
    assert.equal(dir.startsWith(SANDBOX), true, `落点跑出沙箱了：${dir}`);
    assert.equal(dir, join(pluginDataDir(), 'lists'));
    assert.equal(dir.endsWith(join('storages', 'dsh-npie-reader', 'lists')), true);
    assert.equal(bookListsIndexPath(), join(pluginDataDir(), 'lists.json'));
  });

  it('listFilePath 把 id 拼成文件名；同一 id 永远同一个文件', () => {
    assert.equal(listFilePath(ID_A), join(bookListsDir(), `${ID_A}.json`));
    assert.equal(listFilePath(ID_A), listFilePath(ID_A));
    assert.notEqual(listFilePath(ID_A), listFilePath(ID_B));
  });

  it('★ id 不合法时**抛错**而不是拼出一个乱七八糟的路径（这是防目录穿越的最后一道）', () => {
    for (const bad of ['', '  ', '../escape', 'a/b', 's..x', null, undefined, '中文', 'a'.repeat(65)]) {
      assert.throws(() => listFilePath(bad), /书单 id 不合法/, JSON.stringify(bad));
    }
    // 反向对照：合法 id 不能误伤（含 `_` / `-` 的都算合法）。
    for (const good of ['abc', 's_1-2', 'A'.repeat(64)]) {
      assert.equal(typeof listFilePath(good), 'string', good);
    }
  });
});

describe('writeListFile', () => {
  it('写出包装形态（version / id / generatedAt / count / books），自动建父目录、不留临时文件', async () => {
    const before = Date.now();
    const info = await writeListFile(ID_A, [{ id: 'b1', title: '甲' }]);
    const entries = await readdir(bookListsDir());
    assert.deepEqual(entries, [`${ID_A}.json`], '原子写的临时文件必须已经改名走，不能留在目录里');
    const parsed = JSON.parse(await readFile(listFilePath(ID_A), 'utf8'));
    assert.equal(parsed.version, LISTS_INDEX_VERSION);
    assert.equal(parsed.id, ID_A);
    assert.equal(parsed.count, 1);
    assert.deepEqual(parsed.books, [{ id: 'b1', title: '甲' }]);
    assert.ok(parsed.generatedAt >= before && parsed.generatedAt <= Date.now());
    // 返回值就是清单要记的那两个数字 —— 调用方不必自己再数一遍。
    assert.deepEqual(info, { count: 1, generatedAt: parsed.generatedAt });
  });

  it('★ 按 600 权限写（书单里是本机绝对路径，不该被同机其他用户读到）', async () => {
    await writeListFile(ID_B, []);
    const file = await stat(listFilePath(ID_B));
    assert.equal(file.mode & 0o777, 0o600);
  });

  it('★ 重复生成**覆盖同一份**，不是每次多一个文件', async () => {
    await writeListFile(ID_A, [{ id: 'b1' }, { id: 'b2' }]);
    await writeListFile(ID_A, [{ id: 'b1' }]);
    const parsed = JSON.parse(await readFile(listFilePath(ID_A), 'utf8'));
    assert.equal(parsed.count, 1);
    assert.equal(parsed.books.length, 1);
    // 反向对照：另一个 id 是**另一个文件**，不会被覆盖掉一起。
    await writeListFile(ID_B, [{ id: 'b9' }]);
    assert.equal(JSON.parse(await readFile(listFilePath(ID_A), 'utf8')).books.length, 1);
    assert.equal(JSON.parse(await readFile(listFilePath(ID_B), 'utf8')).books[0].id, 'b9');
  });

  it('空书单是**合法**结果（扫了一个空目录），照常落盘', async () => {
    const info = await writeListFile(ID_B, []);
    assert.equal(info.count, 0);
    assert.deepEqual(JSON.parse(await readFile(listFilePath(ID_B), 'utf8')).books, []);
    // 传 undefined / null 也不抛（调用方可能漏传）。
    assert.equal((await writeListFile(ID_A, undefined)).count, 0);
  });
});

describe('removeListFile', () => {
  it('删掉对应文件；文件本来就不在也算成功', async () => {
    await writeListFile(ID_A, [{ id: 'b1' }]);
    await removeListFile(ID_A);
    assert.equal(await stat(listFilePath(ID_A)).then(() => 'yes', () => 'no'), 'no');
    await removeListFile(ID_A);
    // 反向对照：删 A 不该动到 B。
    await writeListFile(ID_B, [{ id: 'b9' }]);
    await removeListFile(ID_A);
    assert.equal(await stat(listFilePath(ID_B)).then(() => 'yes', () => 'no'), 'yes');
  });
});

describe('readListsIndex / writeListsIndex', () => {
  it('写出后读回来：只留 id / count / generatedAt 三个字段', async () => {
    await writeListsIndex([{ id: ID_A, count: 12, generatedAt: 1700000000000, name: '不该存的名字', path: '/x' }]);
    const rows = await readListsIndex();
    assert.deepEqual(rows, [{ id: ID_A, count: 12, generatedAt: 1700000000000 }]);
    // ★ 名字与路径**刻意不存** —— 它们是用户配置，在清单里再存一份就是第二个真相来源。
    assert.deepEqual(Object.keys(rows[0]).sort(), ['count', 'generatedAt', 'id']);
  });

  it('★ 清单丢了/坏了/版本不认识 ⇒ 空数组，绝不抛错（它是派生物，重扫一次就回来了）', async () => {
    for (const content of ['{坏', '[]', '"text"', 'null', '42', JSON.stringify({ version: 99, lists: [] })]) {
      await writeFile(bookListsIndexPath(), content);
      assert.deepEqual(await readListsIndex(), [], content);
    }
    await rm(bookListsIndexPath(), { force: true });
    assert.deepEqual(await readListsIndex(), [], '文件不存在');
  });

  it('清单里的脏行被跳过：坏 id / 重复 id / 缺字段', async () => {
    await writeFile(bookListsIndexPath(), JSON.stringify({
      version: LISTS_INDEX_VERSION,
      lists: [
        { id: ID_A, count: 3, generatedAt: 1 },
        { id: ID_A, count: 99, generatedAt: 2 },
        { id: '../坏', count: 1 },
        { count: 5 },
        null,
        'nope',
        { id: ID_B, count: 'NaN', generatedAt: -1 },
      ],
    }));
    assert.deepEqual(await readListsIndex(), [
      { id: ID_A, count: 3, generatedAt: 1 },
      // 脏数字归零，而不是把 NaN 带进界面（`NaN 本` 这种显示比 0 本更糟）。
      { id: ID_B, count: 0, generatedAt: 0 },
    ]);
  });

  it('count / generatedAt 的浮点、负数、NaN 被规整，不抛错', async () => {
    await writeListsIndex([
      { id: ID_A, count: 2.7, generatedAt: 1.5 },
      { id: ID_B, count: -3, generatedAt: 1700000000000 },
    ]);
    assert.deepEqual(await readListsIndex(), [
      // count 必须是**非负整数**才认，否则归 0（`NaN 本` 这种显示比 0 本更糟）。
      { id: ID_A, count: 0, generatedAt: 1.5 },
      { id: ID_B, count: 0, generatedAt: 1700000000000 },
    ]);
  });
});

describe('pruneListsIndex', () => {
  it('摘掉不再对应的条目并回写；没有可摘的就不写盘', async () => {
    await writeListsIndex([
      { id: ID_A, count: 1, generatedAt: 1 },
      { id: ID_B, count: 2, generatedAt: 2 },
    ]);
    const kept = await pruneListsIndex([ID_B]);
    assert.deepEqual(kept.map((row) => row.id), [ID_B]);
    assert.deepEqual((await readListsIndex()).map((row) => row.id), [ID_B]);

    // 反向对照：全都还在时不该改动文件（避免每次保存书源都白写一次盘）。
    const before = await stat(bookListsIndexPath());
    await new Promise((done) => setTimeout(done, 8));
    await pruneListsIndex([ID_B]);
    assert.equal((await stat(bookListsIndexPath())).mtimeMs, before.mtimeMs);
  });

  it('★ 传空集合等于把清单清空 —— 这是「书源全删了」的正确结果，不是 bug', async () => {
    await writeListsIndex([{ id: ID_A, count: 1, generatedAt: 1 }]);
    assert.deepEqual(await pruneListsIndex([]), []);
    assert.deepEqual(await readListsIndex(), []);
    // 清单不存在时也不抛。
    await rm(bookListsIndexPath(), { force: true });
    assert.deepEqual(await pruneListsIndex([]), []);
  });
});
