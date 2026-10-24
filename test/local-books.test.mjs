/**
 * 本地电子书取字节（`src/host/local-books.js`）—— 以及这条通道的**安全边界**。
 *
 * ★ 本文件最重要的一组用例是「**越界必须被拒**」。理由：把本地书接进书架，等于开了
 *   一条「把本机文件通过 loopback HTTP 发出去」的通道；而宿主派发插件路由**不经过**
 *   它自己的鉴权拦截器（先精确路由、再鉴权）。所以能拦住「任何能访问本机端口的进程
 *   顺着它读整台机器」的，只有这个模块里的三道闸：
 *
 *     1. 必须落在用户配置的根目录之内（**空配置 = 一本都读不了**）；
 *     2. 先 `realpath` 再比对（挡 `..` 与符号链接逃逸）；
 *     3. 比对时补分隔符（`/books` 不得匹配 `/books-old`）。
 *
 *   三道闸**各自**配了用例，并且每组都带**反向对照**：合法的读取必须成功。少了反向
 *   对照，一个「一律拒绝」的实现也能让上面全绿，而那时书架里一本本地书都打不开。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  MAX_LOCAL_READ_BYTES,
  createLocalReader,
  readLocalRange,
  resolveLocalFile,
  withinRoot,
} from '../src/host/local-books.js';

/**
 * ★ 先把沙盒自身 realpath 一次：macOS 的 `tmpdir()` 返回 `/var/folders/…`，而它的
 *   真实路径是 `/private/var/folders/…`。不统一的话「期望值」与「实际值」会差一层，
 *   整套用例看起来全在报错，而原因与判据毫无关系。
 */
const SANDBOX = await realpath(await mkdtemp(join(tmpdir(), 'npie-local-')));
const ROOT = join(SANDBOX, 'root');
const OUTSIDE = join(SANDBOX, 'outside');

/** 一个**同级相似目录**：与 `root` 共享前缀，只比字符串前缀的实现会把它放进来。 */
const SIBLING = join(SANDBOX, 'root-old');

const FLAT = join(ROOT, '平铺.pdf');
const NESTED = join(ROOT, '甲', '忧郁的热带.pdf');
const SECRET = join(OUTSIDE, 'secret.pdf');

before(async () => {
  await mkdir(join(ROOT, '甲'), { recursive: true });
  await mkdir(OUTSIDE, { recursive: true });
  await mkdir(SIBLING, { recursive: true });
  // 一个**目录**，名字却像电子书 —— 用来区分「不是一个文件」与「不存在」。
  await mkdir(join(ROOT, 'adir.pdf'), { recursive: true });
  await writeFile(FLAT, 'PDF-FLAT');
  await writeFile(NESTED, 'PDF-NESTED');
  await writeFile(SECRET, 'TOPSECRET');
  await writeFile(join(SIBLING, 'secret.pdf'), 'SIBLING-SECRET');
  // ★ 根目录**之内**的一个符号链接，指向根目录**之外**。第二道闸的核心样本。
  await symlink(SECRET, join(ROOT, 'link.pdf'));
});

after(() => rm(SANDBOX, { recursive: true, force: true }));

describe('withinRoot（第三道闸：比对时补分隔符）', () => {
  it('根之内（含根自身）算之内；同级相似目录不算', () => {
    assert.equal(withinRoot('/b', '/b'), true);
    assert.equal(withinRoot('/b/x.pdf', '/b'), true);
    assert.equal(withinRoot('/b/sub/x.pdf', '/b'), true);
    // 根带尾分隔符时不许把 `/b` 变成 `/b//` 而让**子路径**全部落空。
    assert.equal(withinRoot('/b/x.pdf', '/b/'), true);
    /**
     * ★ 根带尾分隔符、而被比的恰好是根自身时判 false。
     *
     * 这是**收紧**方向（多拒一个「根自身」，不会多放行一个越界文件），而且这条在
     * `resolveLocalFile` 里**不可达**：那里的根目录都先过了 `realpath(resolve(...))`，
     * 尾分隔符已被抹掉（`/b/` → `/b`）。这条断言是**故意把它固定下来**的 ——
     * 若哪天有人把 `realRoot` 换成不做规范化，这里会红，提醒他重新想一遍。
     */
    assert.equal(withinRoot('/b', '/b/'), false);

    // ★ 少写 `+ sep` 就会把下面这四个一起放进来（`/b2` 以 `/b` 开头）。
    assert.equal(withinRoot('/b2/x.pdf', '/b'), false);
    assert.equal(withinRoot('/b-old/x.pdf', '/b'), false);
    assert.equal(withinRoot('/bb/x.pdf', '/b'), false);
    // 反向对照：真正的父目录不是「之内」（防止把方向写反成 `root.startsWith(file)`）。
    assert.equal(withinRoot('/x.pdf', '/b'), false);
  });
});

describe('resolveLocalFile：第一道闸 —— 没配根目录就一本都读不了', () => {
  it('本地路径为空 → NO_LOCAL_PATH', async () => {
    for (const empty of ['', '   ', undefined, null]) {
      await assert.rejects(() => resolveLocalFile(empty, [ROOT]), (error) => error.code === 'NO_LOCAL_PATH', String(empty));
    }
  });

  it('★ 没有配任何根目录 → NO_LOCAL_ROOT（默认是**全拒**，不是全放开）', async () => {
    // 这是整条通道的安全前提：空配置若被当成「不限制」，等于把整个家目录敞开，
    // 而用户根本没意识到自己开了什么。
    for (const roots of [[], undefined, null, {}, ['', '   ']]) {
      await assert.rejects(
        () => resolveLocalFile(FLAT, roots),
        (error) => error.code === 'NO_LOCAL_ROOT',
        JSON.stringify(roots),
      );
    }
    // 反向对照：配了根目录就不该报 NO_LOCAL_ROOT。
    assert.equal(await resolveLocalFile(FLAT, [ROOT]), FLAT);
  });
});

describe('resolveLocalFile：第二道闸 —— 越界必须被拒（realpath 之后比对）', () => {
  it('★ 相对路径里的 `..` 逃逸 → LOCAL_OUTSIDE_ROOT', async () => {
    await assert.rejects(
      () => resolveLocalFile('../outside/secret.pdf', [ROOT]),
      (error) => error.code === 'LOCAL_OUTSIDE_ROOT',
    );
    // 深一层也挡：`甲/../../outside/…`。
    await assert.rejects(
      () => resolveLocalFile('甲/../../outside/secret.pdf', [ROOT]),
      (error) => error.code === 'LOCAL_OUTSIDE_ROOT',
    );
  });

  it('★ 根目录里的符号链接指向外面 → LOCAL_OUTSIDE_ROOT', async () => {
    await assert.rejects(
      () => resolveLocalFile(join(ROOT, 'link.pdf'), [ROOT]),
      (error) => error.code === 'LOCAL_OUTSIDE_ROOT',
    );
    // 反向对照：**按字面比对是拦不住这条的** —— `root/link.pdf` 明明以 root 开头。
    // 这条断言把「必须先 realpath 再比」固定下来，防止有人为了省一次系统调用改回字面比对。
    assert.equal(join(ROOT, 'link.pdf').startsWith(ROOT), true);
    // 相对写法同样要挡（走的是同一个 realpath）。
    await assert.rejects(
      () => resolveLocalFile('link.pdf', [ROOT]),
      (error) => error.code === 'LOCAL_OUTSIDE_ROOT',
    );
  });

  it('★ 绝对路径指向外面 → LOCAL_OUTSIDE_ROOT；**同级相似目录**也拒', async () => {
    await assert.rejects(() => resolveLocalFile(SECRET, [ROOT]), (error) => error.code === 'LOCAL_OUTSIDE_ROOT');
    // `root-old` 与 `root` 共享前缀 —— 少了「补分隔符」这一手就会被放行。
    await assert.rejects(
      () => resolveLocalFile(join(SIBLING, 'secret.pdf'), [ROOT]),
      (error) => error.code === 'LOCAL_OUTSIDE_ROOT',
    );
  });

  it('★ 所有根目录都失效时，一个**存在**的文件也读不到（不是「根坏了 ⇒ 放开」）', async () => {
    const dead = join(SANDBOX, '不存在的根');
    await assert.rejects(() => resolveLocalFile(FLAT, [dead]), (error) => error.code === 'LOCAL_OUTSIDE_ROOT');
    // 反向对照：坏根**不许**连带把好根一起废掉 —— 一个根坏了只影响它自己。
    assert.equal(await resolveLocalFile(FLAT, [dead, ROOT]), FLAT);
  });

  it('反向对照：根目录之内的绝对路径与相对路径都必须读得到', async () => {
    assert.equal(await resolveLocalFile(NESTED, [ROOT]), NESTED);
    assert.equal(await resolveLocalFile(FLAT, [ROOT]), FLAT);
    // 外部书单里的相对路径（`relpath`）按根目录拼出来 —— 这是 `normalizeBook` 退到
    // `relpath` 之后必须能落地的那一环。
    assert.equal(await resolveLocalFile(join('甲', '忧郁的热带.pdf'), [ROOT]), NESTED);
    assert.equal(await resolveLocalFile('平铺.pdf', [ROOT]), FLAT);
    // `~` 展开：坏根静默作废，好根照常命中。
    assert.equal(await resolveLocalFile(FLAT, ['~/npie-不存在的根', ROOT]), FLAT);
  });
});

describe('resolveLocalFile：三种失败必须各给一句不同的话', () => {
  it('文件不存在 → LOCAL_MISSING（**不是**越界：让用户去翻目录，而不是去改配置）', async () => {
    await assert.rejects(() => resolveLocalFile(join(ROOT, '没有这本.pdf'), [ROOT]), (error) => error.code === 'LOCAL_MISSING');
    await assert.rejects(() => resolveLocalFile('不存在/书.pdf', [ROOT]), (error) => error.code === 'LOCAL_MISSING');
  });

  it('路径指向目录 → LOCAL_NOT_FILE', async () => {
    await assert.rejects(() => resolveLocalFile(join(ROOT, 'adir.pdf'), [ROOT]), (error) => error.code === 'LOCAL_NOT_FILE');
  });

  it('★ 「越界」与「不存在」不许合并成同一个 code', async () => {
    // 合并的后果：用户看到「文件不存在」就去翻目录，而他真正的错是根目录配错了 ——
    // 翻多久都翻不出来。这条把两个 code 固定成不同值。
    const outside = await resolveLocalFile(SECRET, [ROOT]).catch((error) => error);
    const missing = await resolveLocalFile(join(ROOT, 'nope.pdf'), [ROOT]).catch((error) => error);
    assert.notEqual(outside.code, missing.code);
    assert.notEqual(outside.message, missing.message);
  });

  it('多根目录：相对路径逐个根试，命中第一个能解析的', async () => {
    assert.equal(await resolveLocalFile('平铺.pdf', [join(SANDBOX, '不存在'), ROOT]), FLAT);
  });

  it('根目录支持 `~`；返回的是**真实**绝对路径（供上层直接 open）', async () => {
    const resolved = await resolveLocalFile(FLAT, [ROOT]);
    assert.equal(resolved, await realpath(FLAT));
    assert.equal(resolved.startsWith('/'), true);
  });
});

describe('readLocalRange', () => {
  it('读闭区间 `[start, end]`，两端都含', async () => {
    const head = await readLocalRange(FLAT, 0, 2);
    assert.equal(head.toString(), 'PDF');
    assert.equal(head.length, 3);
    assert.equal((await readLocalRange(FLAT, 4, 4)).toString(), 'F');
  });

  it('★ 末段短于请求长度时按实际读到的返回（不补零、也不抛）', async () => {
    // 书单里的 size 可能是旧的、比磁盘上这个文件大 —— 那是常态，不该变成一次失败。
    const buffer = await readLocalRange(FLAT, 4, 99);
    assert.equal(buffer.toString(), 'FLAT');
    assert.equal(buffer.length, 4);
  });

  it('区间非法 → BAD_RANGE（负数 / 反序 / 小数 / 非数）', async () => {
    const bad = [[-1, 2], [3, 2], [0.5, 2], [0, 1.5], ['0', 2], [0, undefined], [Number.NaN, 2], [0, Number.NaN]];
    for (const [start, end] of bad) {
      await assert.rejects(
        () => readLocalRange(FLAT, start, end),
        (error) => error.code === 'BAD_RANGE',
        `${String(start)}-${String(end)}`,
      );
    }
  });

  it('★ 单次区间超上限 → RANGE_TOO_LARGE（第二道顶，防一次把整本拖下来）', async () => {
    await assert.rejects(
      () => readLocalRange(FLAT, 0, MAX_LOCAL_READ_BYTES),
      (error) => error.code === 'RANGE_TOO_LARGE',
    );
    // 反向对照：**正好等于**上限必须放行 —— 判据是 `>` 而不是 `>=`。
    // 少了这条，把上限写成 0 也能让上面那条绿。
    const atLimit = await readLocalRange(FLAT, 0, MAX_LOCAL_READ_BYTES - 1);
    assert.equal(atLimit.toString(), 'PDF-FLAT');
  });

  it('打开失败 → LOCAL_OPEN_FAILED，且消息里带上底层原因', async () => {
    await assert.rejects(
      () => readLocalRange(join(ROOT, '不存在.pdf'), 0, 1),
      (error) => error.code === 'LOCAL_OPEN_FAILED' && error.message.includes('不存在.pdf'),
    );
  });
});

describe('createLocalReader', () => {
  it('★ roots 每次现取 —— 用户改完设置不必重启插件', async () => {
    let roots = [];
    const reader = createLocalReader({ rootsOf: () => roots });
    assert.deepEqual(reader.roots(), []);
    // 还没配 ⇒ 读不了（默认全拒）。
    await assert.rejects(() => reader.read(FLAT, 0, 2), (error) => error.code === 'NO_LOCAL_ROOT');

    // 改设置（换一个数组）立刻生效，不需要重建 reader。
    roots = [ROOT];
    assert.deepEqual(reader.roots(), [ROOT]);
    assert.equal((await reader.read(FLAT, 0, 2)).toString(), 'PDF');

    // 反向对照：换配置**不会**顺手把闸拆了 —— 越界仍然被拒。
    await assert.rejects(() => reader.read(SECRET, 0, 2), (error) => error.code === 'LOCAL_OUTSIDE_ROOT');

    // 再把配置清空，仍然立刻变回「全拒」。
    roots = [];
    await assert.rejects(() => reader.read(FLAT, 0, 2), (error) => error.code === 'NO_LOCAL_ROOT');
  });

  it('没有传 rootsOf 时是「一个都读不了」，不是「全都放开」', async () => {
    const reader = createLocalReader();
    assert.deepEqual(reader.roots(), []);
    await assert.rejects(() => reader.read(FLAT, 0, 2), (error) => error.code === 'NO_LOCAL_ROOT');
  });

  it('★ 端到端：读出来的字节与磁盘上的一致（空 buffer 也算「没抛错」）', async () => {
    const reader = createLocalReader({ rootsOf: () => [ROOT] });
    const buffer = await reader.read(NESTED, 0, 9);
    assert.equal(buffer.toString(), await readFile(NESTED, 'utf8'));
    assert.equal(buffer.length, 10);
  });

  it('`log` 收到一行可读的记录（排障时靠它区分「拒了」与「没请求到」）', async () => {
    const lines = [];
    const reader = createLocalReader({ rootsOf: () => [ROOT], log: (line) => lines.push(line) });
    await reader.read(FLAT, 0, 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /平铺\.pdf/);
    // 反向对照：被拒的那次不写「已读」日志 —— 否则日志会让人以为读成功了。
    lines.length = 0;
    await assert.rejects(() => reader.read(SECRET, 0, 2));
    assert.deepEqual(lines, []);
  });
});
