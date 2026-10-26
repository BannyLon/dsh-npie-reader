/**
 * 解读产物的磁盘层：布局、原子写、断点续跑、按章切分。
 *
 * 这个文件存在的理由：这一层一旦写错，症状是**数据丢失且不可逆**（覆盖了用户
 * 已经生成的解读），或者**悄悄退化**（每翻一页重写两兆的 data.json）。两者都不会
 * 报错。所以这里全部用真实文件系统跑（临时目录），并钉住三件事：
 *   1. 非法 bookId 必须在拼路径**之前**被拒（它是从 HTTP 路径来的）；
 *   2. 抽取中间态必须能追加、能容忍最后一行写坏（进程被杀是常态）；
 *   3. 章节文本必须按章切，且页码区间是闭区间。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CHAPTER_STATUS, TASK_STATE, createDigestStore } from '../src/host/digest-store.js';

let root = '';
let store = null;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'npie-digest-'));
  store = createDigestStore({ rootDir: root });
});

after(async () => {
  // 清理失败不该让测试变红：这个目录在系统临时区，沙箱/杀毒软件偶尔会拒绝删除，
  // 而「测试跑完了但临时目录没删掉」和「断言失败」是两件完全不同的事。
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('bookId 校验：拼路径之前必须挡住穿越', () => {
  it('★ 路径穿越与绝对路径一律拒绝', () => {
    // 这是最重要的一条：`bookId` 直接从 HTTP 路径段来，`join(root, '../../etc')`
    // 会把「读一本书的解读」变成「读写任意文件」。
    for (const bad of ['../etc', '..', 'a/b', '/etc/passwd', '', 'a'.repeat(65), '中文', null, undefined, 42]) {
      assert.throws(() => store.dirOf(bad), TypeError, `没有拒绝 ${String(bad)}`);
    }
  });

  it('合法 id 正常拼路径', () => {
    assert.ok(store.dirOf('l-abc_123').endsWith(join('digests', 'l-abc_123')));
  });

  it('反向对照：拒绝的是「拼接前」，不是「读到不存在就报错」', () => {
    // 若只在读取时判存在性，`dirOf` 就会先把越界路径算出来 —— 那是真正危险的一步。
    assert.throws(() => store.dirOf('../../x'), TypeError);
  });
});

describe('meta / outline：原子读写往返', () => {
  it('写进去读出来是同一份', async () => {
    const meta = { bookId: 'l-meta', fingerprint: { size: 10, mtimeMs: 20 }, task: { state: TASK_STATE.IDLE } };
    await store.writeMeta('l-meta', meta);
    assert.deepEqual(await store.readMeta('l-meta'), meta);
  });

  it('不存在时返回 null，不是抛错（界面上就是「还没解读」）', async () => {
    assert.equal(await store.readMeta('l-nothing'), null);
    assert.equal(await store.readOutline('l-nothing'), null);
  });

  it('★ 坏掉的 JSON 要抛出去，不能静默当成「没有」', async () => {
    // 静默返回 null 会让界面显示「还没解读」，而磁盘上明明有一份解读 ——
    // 用户会以为解读丢了，重新花几十次模型调用。
    await store.ensureDir('l-broken');
    await writeFile(join(store.dirOf('l-broken'), 'meta.json'), '{ 这不是 JSON', 'utf8');
    await assert.rejects(() => store.readMeta('l-broken'), SyntaxError);
  });

  it('章节树往返，且保留 source 字段', async () => {
    const chapters = [{ n: 1, title: '第一章', startPage: 1, endPage: 9, source: 'toc' }];
    await store.writeOutline('l-out', chapters);
    assert.deepEqual(await store.readOutline('l-out'), chapters);
  });
});

describe('pages.jsonl：追加式中间态', () => {
  it('分批追加、按页码读回', async () => {
    await store.appendPages('l-pages', [{ page: 3, lines: ['c'] }, { page: 1, lines: ['a'] }]);
    await store.appendPages('l-pages', [{ page: 2, lines: ['b'] }]);
    const pages = await store.readPages('l-pages');
    assert.deepEqual(pages.map(p => p.page), [1, 2, 3]);
  });

  it('★ 最后一行写坏（进程被杀）时跳过它，不毁掉整本', async () => {
    const path = join(store.dirOf('l-pages'), 'pages.jsonl');
    await writeFile(path, `${await readFile(path, 'utf8')}{"page":4,"lin`, 'utf8');
    const pages = await store.readPages('l-pages');
    assert.deepEqual(pages.map(p => p.page), [1, 2, 3]);
  });

  it('没有文件时返回空数组', async () => {
    assert.deepEqual(await store.readPages('l-empty'), []);
  });

  it('反向对照：坏行跳过之后，好行一条都不能少', async () => {
    // 「跳过坏行」很容易写成「遇到坏行就停」—— 那样后面所有页都丢了。
    const pages = await store.readPages('l-pages');
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.find(p => p.page === 2)?.lines, ['b']);
  });
});

describe('writeChapterTexts：按章切原文', () => {
  it('按闭区间切，章与章之间不重叠', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, lines: [`第${i + 1}页`] }));
    const chapters = [
      { n: 1, title: '一', startPage: 1, endPage: 4 },
      { n: 2, title: '二', startPage: 5, endPage: 10 },
    ];
    const written = await store.writeChapterTexts('l-cut', pages, chapters);
    assert.deepEqual(written.map(w => w.name), ['ch01.txt', 'ch02.txt']);
    // 页与页之间空一行：原文里要能看出分页边界（生成时模型据此判断「这一段跨页」）。
    assert.equal(await store.readChapterText('l-cut', 1), '第1页\n\n第2页\n\n第3页\n\n第4页');
    assert.equal(await store.readChapterText('l-cut', 2), '第5页\n\n第6页\n\n第7页\n\n第8页\n\n第9页\n\n第10页');
  });

  it('缺页时跳过，不写空行占位', async () => {
    const pages = [{ page: 1, lines: ['a'] }, { page: 3, lines: ['c'] }];
    await store.writeChapterTexts('l-gap', pages, [{ n: 1, startPage: 1, endPage: 3 }]);
    assert.equal(await store.readChapterText('l-gap', 1), 'a\n\nc');
  });

  it('读不存在的章返回 null', async () => {
    assert.equal(await store.readChapterText('l-cut', 9), null);
  });
});

describe('isStale：文件换过就过期', () => {
  it('size 或 mtime 变了都算过期', async () => {
    await store.writeMeta('l-stale', { fingerprint: { size: 100, mtimeMs: 200 } });
    assert.equal(await store.isStale('l-stale', { size: 100, mtimeMs: 200 }), false);
    assert.equal(await store.isStale('l-stale', { size: 101, mtimeMs: 200 }), true);
    assert.equal(await store.isStale('l-stale', { size: 100, mtimeMs: 201 }), true);
  });

  it('没有 meta 或没有指纹时不算过期（没解读过，谈不上过期）', async () => {
    assert.equal(await store.isStale('l-nothing', { size: 1, mtimeMs: 1 }), false);
    await store.writeMeta('l-nofp', {});
    assert.equal(await store.isStale('l-nofp', { size: 1, mtimeMs: 1 }), false);
  });
});

describe('listDigested：列已解读的书', () => {
  it('只回有 meta.json 的目录，坏目录跳过', async () => {
    await store.writeMeta('l-a', { bookId: 'l-a' });
    await store.ensureDir('l-orphan'); // 有目录没 meta
    const list = await store.listDigested();
    const ids = list.map(m => m.bookId);
    assert.ok(ids.includes('l-a'));
    assert.ok(!ids.includes('l-orphan'));
  });
});

describe('★ 布局纪律：绝不写 data.json', () => {
  it('全部产物都落在 digests/ 下', async () => {
    // 这条断言的由来：`store.js` 的 flush() 是全量重写，一本 300 页书的正文
    // 放进去就是「翻一页重写两兆」。所以这里要证明解读层不碰外层任何文件。
    const names = await readdir(root);
    assert.deepEqual(names, ['digests']);
  });

  it('一本书的全部文件都在自己的目录里', async () => {
    // 断言的是**布局契约**，不是「此刻写了哪几个文件」（那取决于跑到这里之前
    // 调用过哪些方法，把断言钉死在具体文件上会让它随测试顺序变化）。
    // 契约有两条：只有两个子目录；顶层只允许那几种文件。
    const names = await readdir(store.dirOf('l-cut'));
    const dirs = names.filter(name => !name.endsWith('.json') && name !== 'pages.jsonl');
    assert.deepEqual(dirs.sort(), ['digest', 'text']);
    const stray = names.filter(name => !(name === 'digest' || name === 'text'
      || name === 'pages.jsonl' || name === 'meta.json' || name === 'outline.json'));
    assert.deepEqual(stray, [], `顶层出现了意料之外的文件：${stray.join(', ')}`);
  });

  it('★ 逐章解读单独一个子目录（`digest/`），不与原文混在一起', async () => {
    // 原文（`text/chNN.txt`）是抽取产物、解读（`digest/chNN.json`）是模型产物，
    // 两者的生命周期不同：重新抽取会重写 text/，但解读要留着（除非用户点重新生成）。
    await store.writeDigest('l-cut', 1, { summary: '解' });
    const names = await readdir(store.dirOf('l-cut'));
    assert.ok(names.includes('digest'));
    assert.ok(names.includes('text'));
  });
});

describe('状态常量', () => {
  it('章节状态里没有布尔式的「已完成」', () => {
    // 「19 章挂 1 章」在布尔模型下完全看不出来 —— 这正是本项目反复踩的假绿。
    assert.deepEqual(
      Object.values(CHAPTER_STATUS).sort(),
      ['done', 'failed', 'pending', 'running', 'skipped', 'stale'],
    );
    assert.ok(!Object.values(CHAPTER_STATUS).includes(true));
  });

  it('★ `skipped` 与 `done` 是两个值 —— 把跳过算成完成，「已解读 19/19」就是假话', () => {
    assert.notEqual(CHAPTER_STATUS.SKIPPED, CHAPTER_STATUS.DONE);
  });
});

describe('逐章解读的落盘（digest/chNN.json）', () => {
  const BOOK = 'l-digest-files';

  it('写进去能原样读回来，且带上章号', async () => {
    await store.writeDigest(BOOK, 3, { summary: '讲了什么', points: ['a'], terms: [] });
    const digest = await store.readDigest(BOOK, 3);
    assert.equal(digest.summary, '讲了什么');
    assert.deepEqual(digest.points, ['a']);
    assert.equal(digest.n, 3, '章号要写进文件：文件名叫 ch03.json，但内容里也要有');
  });

  it('没生成过 ⇒ null（「还没生成」是正常状态，不该抛错）', async () => {
    assert.equal(await store.readDigest(BOOK, 42), null);
  });

  it('★ 章节号非法时拒绝拼路径（ch0 / ch-1 / 小数都会跑出目录）', async () => {
    for (const bad of [0, -1, 1.5, 10000, '3', null, undefined]) {
      await assert.rejects(() => store.readDigest(BOOK, bad), TypeError, `没有拒绝 ${String(bad)}`);
    }
  });

  it('★★ sizeOf 必须把 text/ 与 digest/ 算进去 —— 低报的「缓存占用」比不显示更糟', async () => {
    const sizeBook = 'l-size';
    await store.writeMeta(sizeBook, { bookId: sizeBook });
    await store.writeChapterTexts(sizeBook, [
      { page: 1, lines: ['字'.repeat(2000)] },
    ], [{ n: 1, startPage: 1, endPage: 1 }]);
    await store.writeDigest(sizeBook, 1, { summary: '解'.repeat(500) });

    const size = await store.sizeOf(sizeBook);
    const textSize = (await readFile(join(store.dirOf(sizeBook), 'text', 'ch01.txt'))).length;
    const digestSize = (await readFile(join(store.dirOf(sizeBook), 'digest', 'ch01.json'))).length;
    assert.ok(size >= textSize + digestSize, `sizeOf=${size} 小于 text+digest=${textSize + digestSize}`);
  });
});

describe('skillFiles：技能包的体积清单（导出成功后那行统计的唯一来源）', () => {
  /**
   * 这层为什么值得单独钉：界面那行 `SKILL.md 12.4 KB · 24 个文件 · 268 KB · 4.1k 行`
   * 全部来自这里。数字错了不会报错、也不会崩，只会让用户按一个**假的体积**
   * 判断「这个包值不值得塞进 agent 的上下文」—— 而 `SKILL.md` 是每次都进上下文的
   * 那一份，它被低报是最坏的情况。
   */
  const SLUG = 'book-stat-probe';

  async function put(relative, text) {
    const target = join(store.skillDirOf(SLUG), relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }

  it('★ 行数口径：末尾换行不算一行，空文件 0 行', async () => {
    await put('SKILL.md', 'a\nb\nc\n');
    const files = await store.skillFiles(SLUG);
    const row = files.find((f) => f.path === 'SKILL.md');
    assert.equal(row.lines, 3);

    // 反向对照：naive 写法（`text.split('\n').length`）在这里给 4。
    // 两个数字都断言，判据才不会在「有人把公式改回 naive」时假绿。
    assert.equal('a\nb\nc\n'.split('\n').length, 4);
  });

  it('★ 边界：空文件 0 行、只有换行 1 行、两行换行 2 行', async () => {
    await put('empty.md', '');
    await put('one-blank.md', '\n');
    await put('two-blank.md', '\n\n');
    const files = await store.skillFiles(SLUG);
    const lines = (name) => files.find((f) => f.path === name).lines;
    assert.equal(lines('empty.md'), 0);
    assert.equal(lines('one-blank.md'), 1);
    assert.equal(lines('two-blank.md'), 2);
  });

  it('★ 递归：子目录里的章文件也在清单里，且整体按路径排序', async () => {
    await put('chapters/ch01.md', '一\n');
    await put('chapters/ch02.md', '二\n');
    await put('glossary.md', '词\n');
    const files = await store.skillFiles(SLUG);
    assert.deepEqual(files.map((f) => f.path), [
      'SKILL.md',
      'chapters/ch01.md',
      'chapters/ch02.md',
      'empty.md',
      'glossary.md',
      'one-blank.md',
      'two-blank.md',
    ]);
  });

  it('★ bytes 按 UTF-8 字节算，不是字符数', async () => {
    await put('zh.md', '中\n');
    const files = await store.skillFiles(SLUG);
    const row = files.find((f) => f.path === 'zh.md');
    assert.equal(row.bytes, 4, '「中」是 3 字节 + 换行 1 字节');
    assert.notEqual(row.bytes, 2, '按字符数会得到 2 —— 差一半会让「268 KB」变成「134 KB」');
  });

  it('★ 包不存在 / 空目录都回 null（不是空数组：界面据此决定显不显示统计行）', async () => {
    assert.equal(await store.skillFiles('book-never-exported'), null);

    const emptySlug = 'book-empty-dir';
    await mkdir(store.skillDirOf(emptySlug), { recursive: true });
    assert.equal(await store.skillFiles(emptySlug), null, '空目录里没有可报的体积，界面同样无话可说');
  });

  it('非法 slug 在拼路径前就被拒（和 dirOf 同一类栅栏）', async () => {
    for (const bad of ['../etc', 'a/b', 'A-upper', '', 'a'.repeat(65), null, 42]) {
      await assert.rejects(() => store.skillFiles(bad), TypeError, `没有拒绝 ${String(bad)}`);
    }
  });
});

/**
 * 「重新抽取」要不要留住识别结果（0.28.0）。
 *
 * ★ 这条守的是一次**不可逆的静默丢失**：以前 `remove` 是 `rm -r` 整个目录，
 *   `ocr.json` 一起没了。用户认完 111 页（70–90 秒）、顺手点一下目录面板的
 *   「重新抽取」（那个按钮的提示写着「书换过文件时用」，很容易被读成「让识别生效」），
 *   就回到「这本书是扫描版」，而那 90 秒去了哪里没有任何提示。
 * ★ 但默认值**不能**改：换过文件的书写着上一本文件的识别文本，比没有更糟。
 *   所以这里是「调用方点名要留才留」。
 */
describe('remove：识别结果留不留，由调用方点名', () => {
  it('默认全删（含 ocr.json）—— 这条不能悄悄改', async () => {
    const book = 'l-remove-wipe';
    await store.writeMeta(book, { bookId: book });
    await store.putOcrPage(book, 1, { text: '识别过的一页' });
    const result = await store.remove(book);
    assert.deepEqual(result, { keptOcr: false, ocrPages: 0 });
    const names = await readdir(join(root, 'digests')).catch(() => []);
    assert.equal(names.includes(book), false, '默认应当整本删掉');
  });

  it('★ keepOcr：目录与章节全没，`ocr.json` 与里面的页数都还在', async () => {
    const book = 'l-remove-keep';
    await store.writeMeta(book, { bookId: book, mode: 'scanned' });
    await store.writeOutline(book, []);
    await store.writePages(book, [{ page: 1, lines: [] }]);
    await store.putOcrPage(book, 1, { text: '第一页识别出来的字' });
    await store.putOcrPage(book, 2, { text: '第二页识别出来的字' });

    const result = await store.remove(book, { keepOcr: true });
    assert.deepEqual(result, { keptOcr: true, ocrPages: 2 });

    const reader = createDigestStore({ rootDir: root });
    assert.equal(await reader.readMeta(book), null, 'meta 应该没了（分段要重做）');
    assert.deepEqual(await reader.readPages(book), [], 'pages.jsonl 应该没了');
    const ocr = await reader.readOcrPages(book);
    assert.equal(ocr[1], '第一页识别出来的字');
    assert.equal(ocr[2], '第二页识别出来的字');
  });

  it('本来就没识别过：keepOcr 也不报错，如实回 keptOcr=false', async () => {
    const book = 'l-remove-nothing';
    await store.writeMeta(book, { bookId: book });
    const result = await store.remove(book, { keepOcr: true });
    assert.deepEqual(result, { keptOcr: false, ocrPages: 0 });
  });
});
