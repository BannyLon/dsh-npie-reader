/**
 * 日记存储层（`src/host/diary-store.js`）。
 *
 * ★ 用**真的**文件系统（临时 `DSH_HOME`），不 mock `node:fs`：这一层的全部价值
 *   都在「串行队列 + 原子写 + 逐字节保留」上，换成假 fs 就等于只测了函数调用顺序。
 *
 * ★ 三个必须有牙的地方：
 *   1. **并发追加不丢**（队列的全部意义）。这条要真并发，且断言**总条数**与
 *      **每条内容都在**，不能只看「没抛错」。
 *   2. **`exists: false` 不是错误**（那天就是还没写），且不能因此建出空文件。
 *   3. **日上限是硬闸**：超了要抛带人话的错，且**不能把半截内容落盘**。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDiaryStore, diaryFilePath, diaryPrivateDir, diaryRoot, MAX_ENTRY_CHARS } from '../src/host/diary-store.js';
import { createDiarySecret } from '../src/host/diary-secret.js';
import { parseDay } from '../src/diary-format.js';

let home = '';
let store = null;
/** 注入密钥的 store：私密那半边的全部用例都走它（不碰真实钥匙串）。 */
let secure = null;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'npie-diary-'));
  // ★ 必须在造 store **之前**：`pluginDataDir()` 每次现读 `$DSH_HOME`，
  //   而 store 里的 `root` / `writesOnlyUnder` 是在构造时求值的。
  process.env.DSH_HOME = home;
  store = createDiaryStore({ log: () => {} });
  secure = createDiaryStore({
    log: () => {},
    secret: createDiarySecret({ key: Buffer.alloc(32, 7), keyPath: join(home, 'secret.key') }),
  });
});

after(async () => {
  // 清理失败 ≠ 断言失败（沙箱有时会拦删除）。
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

const body = '今天读到一句话，忽然明白了点什么。';

describe('目录与路径', () => {
  it('落在插件自己的数据目录下，和 Obsidian 库无关', () => {
    assert.equal(diaryRoot(), join(home, 'storages', 'dsh-npie-reader', 'diary'));
    assert.equal(diaryFilePath('2026-10-26'), join(diaryRoot(), 'daily', '2026-10-26.md'));
  });

  it('★ 日期非法时**拼不出**路径（白名单在拼路径之前）', () => {
    for (const key of ['../../etc/passwd', '2026-13-45', '2026-10-26/../x', '']) {
      assert.throws(() => diaryFilePath(key), (error) => error.code === 'BAD_DATE', key);
    }
  });
});

describe('read：那天还没写不是错误', () => {
  it('不存在时 exists:false、entries 空、且**不建文件**', async () => {
    const day = await store.read('2026-01-01');
    assert.equal(day.exists, false);
    assert.deepEqual(day.entries, []);
    assert.equal(day.chars, 0);
    assert.equal(day.text, '');
    // ★ 「不建文件」是可观察的：目录里不该多出一个 0 字节的 .md
    const names = await readdir(join(diaryRoot(), 'daily')).catch(() => []);
    assert.equal(names.includes('2026-01-01.md'), false);
  });

  it('日期非法时抛 BAD_DATE（不是静默返回空）', async () => {
    await assert.rejects(() => store.read('2026-02-30'), (error) => error.code === 'BAD_DATE');
  });
});

describe('append', () => {
  it('第一次追加会建目录、写 frontmatter、返回序号 0', async () => {
    const result = await store.append({ date: '2026-10-26', time: '09:31', kind: '灵感', body });
    assert.equal(result.date, '2026-10-26');
    assert.equal(result.time, '09:31');
    assert.equal(result.index, 0);
    assert.ok(result.chars > 0);

    const text = await readFile(diaryFilePath('2026-10-26'), 'utf8');
    assert.match(text, /^---\ndate: 2026-10-26\ntype: daily\nstatus: 草稿\n---\n/);
    assert.match(text, /## 09:31 灵感/);
  });

  it('再追加一条，序号递增、顺序正确', async () => {
    const result = await store.append({ date: '2026-10-26', time: '21:05', kind: '读后感', source: '《被讨厌的勇气》', body: '第二条' });
    assert.equal(result.index, 1);
    const day = await store.read('2026-10-26');
    assert.equal(day.entries.length, 2);
    assert.deepEqual(day.entries.map(item => item.body), [body, '第二条']);
    assert.equal(day.entries[1].source, '《被讨厌的勇气》');
  });

  it('空正文 / 纯空白正文一律拒（EMPTY_ENTRY），且不落盘', async () => {
    await assert.rejects(() => store.append({ date: '2026-02-02', body: '' }), (error) => error.code === 'EMPTY_ENTRY');
    await assert.rejects(() => store.append({ date: '2026-02-02', body: '   \n\t ' }), (error) => error.code === 'EMPTY_ENTRY');
    const day = await store.read('2026-02-02');
    assert.equal(day.exists, false, '被拒的请求不该留下一个空文件');
  });

  it('超长单条拒（ENTRY_TOO_LARGE）', async () => {
    await assert.rejects(
      () => store.append({ date: '2026-02-03', body: 'x'.repeat(MAX_ENTRY_CHARS + 1) }),
      (error) => error.code === 'ENTRY_TOO_LARGE',
    );
  });

  it('恰好等于上限时**通过**（边界属于允许范围）', async () => {
    const result = await store.append({ date: '2026-02-04', body: 'x'.repeat(MAX_ENTRY_CHARS) });
    assert.equal(result.index, 0);
  });

  it('不认识的 kind 兜成「灵感」，时间格式不对就用当前时间', async () => {
    const result = await store.append({ date: '2026-02-05', kind: '随笔', time: '99:99', body: '兜底' });
    assert.match(result.time, /^\d{2}:\d{2}$/);
    const day = await store.read('2026-02-05');
    assert.equal(day.entries[0].kind, '灵感');
  });

  it('★ 并发 8 条不丢：队列的全部意义', async () => {
    const date = '2026-03-01';
    const bodies = Array.from({ length: 8 }, (_, index) => `并发第 ${index} 条`);
    await Promise.all(bodies.map((item, index) => store.append({ date, time: `1${index}:00`, body: item })));

    const day = await store.read(date);
    assert.equal(day.entries.length, 8, `丢条了：只留下 ${day.entries.length} 条`);
    const got = new Set(day.entries.map(item => item.body));
    for (const item of bodies) assert.ok(got.has(item), `少了一条：${item}`);
    // 磁盘上的全文也必须是 8 条（内存对了但没落盘 = 重启就丢）
    const onDisk = parseDay(await readFile(diaryFilePath(date), 'utf8'));
    assert.equal(onDisk.entries.length, 8);
  });

  it('★ 并发追加后每一条都是完整的，没有被截断的中间态', async () => {
    const date = '2026-03-02';
    const long = '长'.repeat(500);
    await Promise.all(Array.from({ length: 5 }, (_, index) => store.append({ date, body: `${index}-${long}` })));
    const day = await store.read(date);
    assert.equal(day.entries.length, 5);
    for (const item of day.entries) {
      assert.equal(item.body.length, 502, `有一条被截断了：${item.body.length}`);
      assert.ok(item.body.includes(long));
    }
  });
});

describe('removeEntry', () => {
  it('删掉指定一条，其余保留', async () => {
    const date = '2026-04-01';
    await store.append({ date, body: '甲' });
    await store.append({ date, body: '乙' });
    await store.append({ date, body: '丙' });
    const result = await store.removeEntry({ date, index: 1 });
    assert.equal(result.entries, 2);
    const day = await store.read(date);
    assert.deepEqual(day.entries.map(item => item.body), ['甲', '丙']);
  });

  it('★ 越界与「这一天还没有日记」是两种错，都要抛且码不同', async () => {
    await assert.rejects(() => store.removeEntry({ date: '2026-04-02', index: 0 }), (error) => error.code === 'ENTRY_NOT_FOUND');
    const date = '2026-04-03';
    await store.append({ date, body: '只有一条' });
    await assert.rejects(() => store.removeEntry({ date, index: 5 }), (error) => error.code === 'ENTRY_NOT_FOUND');
    // 而且越界删除**没有**动到文件
    const day = await store.read(date);
    assert.equal(day.entries.length, 1);
  });
});

describe('listMonth', () => {
  it('只数本月，给出每天几条', async () => {
    const result = await store.listMonth('2026-10');
    assert.equal(result.month, '2026-10');
    assert.equal(result.days['2026-10-26'], 2);
    assert.equal(result.total, 2);
    assert.equal(Object.keys(result.days).some(key => !key.startsWith('2026-10')), false);
  });

  it('没有日记的月份回空，不抛错', async () => {
    const result = await store.listMonth('2019-05');
    assert.deepEqual(result.days, {});
    assert.equal(result.total, 0);
  });

  it('月份非法抛 BAD_MONTH', async () => {
    await assert.rejects(() => store.listMonth('2026-13'), (error) => error.code === 'BAD_MONTH');
    await assert.rejects(() => store.listMonth('2026-10-26'), (error) => error.code === 'BAD_MONTH');
  });

  it('★ 公开与私密**分开数**（私密侧栏不能显示灵感的条数）', async () => {
    // 用户 2026-10-27：「私密日记本侧边栏为什么还显示灵感的记录条数」。
    // 以前 `days` 是两半相加的一个数，界面于是**无法回答**「这一天我写了几篇私密日记」。
    const date = '2026-11-02';
    await secure.append({ date, time: '08:00', body: '灵感一' });
    await secure.append({ date, time: '09:00', body: '灵感二' });
    await secure.append({ date, time: '22:00', body: '私密一', vis: 'private' });

    const result = await secure.listMonth('2026-11');
    assert.equal(result.days[date], 3, '合计还要在（老调用点靠它）');
    assert.equal(result.publicDays[date], 2, '公开那半边数错了');
    assert.equal(result.privateDays[date], 1, '私密那半边数错了 —— 界面会显示成 3');
  });

  it('★ 一天的心情取平均分；没记过的那天**没有键**', async () => {
    const date = '2026-11-03';
    await secure.append({ date, time: '08:00', body: '还行', meta: { mood: '🙂' } });
    await secure.append({ date, time: '09:00', body: '低落', meta: { mood: '😔' } });
    await secure.append({ date, time: '10:00', body: '没记心情' });

    const result = await secure.listMonth('2026-11');
    // (4 + 1) / 2 = 2.5 → 3，只数**记过心情**的那两条
    assert.equal(result.moods[date].public, 3, '平均分没算对（或者把没记心情的也算成了 0）');
    assert.equal(result.moods[date].private, null, '公开那半边的心情串到了私密');
    // ★ 反向对照：2026-11-02 那天写了 3 条但一条心情都没记 —— 不该有键。
    //   有键（哪怕是 0）会让日历画出「低落」的点，那是编出来的数据。
    assert.equal(result.moods['2026-11-02'], undefined, '没记心情的那天被编出了分数');
  });
});

describe('search', () => {
  it('子串命中、大小写不敏感', async () => {
    await store.append({ date: '2026-05-01', body: 'Obsidian 的双链很好用' });
    const hit = await store.search({ query: 'obsidian' });
    assert.equal(hit.hits.length, 1);
    assert.equal(hit.hits[0].date, '2026-05-01');
    assert.ok(hit.hits[0].snippet.includes('Obsidian'));
  });

  it('★ 中文不切词：短查询能命中长句（与 rss_search_articles 同一条判据）', async () => {
    await store.append({ date: '2026-05-02', body: '磨坊主妇的故事讲的是耐心' });
    const short = await store.search({ query: '磨坊' });
    const long = await store.search({ query: '磨坊主妇' });
    assert.equal(short.hits.length >= 1, true, '短查询必须命中');
    assert.equal(long.hits.length, 1);
    assert.equal(short.hits[0].date, long.hits[0].date);
  });

  it('按标题里的类型与来源也能命中', async () => {
    await store.append({ date: '2026-05-03', kind: '书摘', source: '《瓦尔登湖》', body: '正文不含关键词' });
    const hit = await store.search({ query: '瓦尔登湖' });
    assert.equal(hit.hits.length, 1);
  });

  it('空查询回空结果（不是把所有条目都倒出来）', async () => {
    const empty = await store.search({ query: '' });
    assert.deepEqual(empty.hits, []);
    assert.equal(empty.scanned, 0);
    assert.deepEqual((await store.search({ query: '   ' })).hits, []);
  });

  it('limit 生效，且触顶时 truncated 为真', async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.append({ date: `2026-06-0${index + 1}`, body: `关键词 ${index}` });
    }
    const limited = await store.search({ query: '关键词', limit: 2 });
    assert.equal(limited.hits.length, 2);
    assert.equal(limited.truncated, true);
  });

  it('★ 搜不到时 truncated 为假 —— 「没有」不能被读成「可能还有」', async () => {
    const none = await store.search({ query: '这个词一定不存在zzz' });
    assert.equal(none.hits.length, 0);
    assert.equal(none.truncated, false);
  });

  it('★ limit 非正数/非数字按「没指定」处理（不是夹成 1）', async () => {
    // 夹成 1 的后果不是「少给一条」，而是模型把「就一条」当成结论。所以约定是：
    // 说不清楚就退回默认值 30，而不是给一个看起来确定的最小值。
    for (const limit of [0, -5, 'abc', undefined, null]) {
      const result = await store.search({ query: '关键词', limit });
      assert.equal(result.hits.length, 6, `limit=${String(limit)} 应当退回默认值`);
    }
  });

  it('limit 超过上限时夹到 100', async () => {
    const huge = await store.search({ query: '关键词', limit: 100000 });
    assert.ok(huge.hits.length <= 100);
    assert.equal(huge.hits.length, 6, '本例只有 6 条命中');
  });
});

describe('exportAll', () => {
  it('按日期升序给出全部文件，且只读不写', async () => {
    const before = (await readdir(join(diaryRoot(), 'daily'))).length;
    const result = await store.exportAll();
    assert.ok(result.total >= 1);
    const names = result.files.map(file => file.name);
    assert.deepEqual(names, [...names].sort(), '文件名必须升序');
    assert.equal(names.every(name => name.endsWith('.md')), true);
    const after = (await readdir(join(diaryRoot(), 'daily'))).length;
    assert.equal(after, before, '导出不该在磁盘上多出任何东西');
  });
});

describe('stats', () => {
  it('给出天数、字节数与目录（设置页要显示「东西在哪」）', async () => {
    const result = await store.stats();
    assert.ok(result.days >= 1);
    assert.ok(result.bytes > 0);
    assert.equal(result.root, diaryRoot());
    // 字节数要和真实文件对得上。
    // ★ 必须把 private/ 也算进来：`stats().bytes` 报的是**两边合计**（页脚那句话
    //   写的是「日记共 N 天 · X KB」，私密的密文也占盘）。只数 daily/ 的后果是
    //   「一旦有人写过私密日记，这条断言就红」—— 而红的原因跟字节数无关。
    const dailyNames = (await readdir(join(diaryRoot(), 'daily'))).filter(name => name.endsWith('.md'));
    const privateNames = await readdir(join(diaryRoot(), 'private')).catch(() => []);
    let expected = 0;
    for (const name of dailyNames) expected += (await stat(join(diaryRoot(), 'daily', name))).size;
    for (const name of privateNames) expected += (await stat(join(diaryRoot(), 'private', name))).size;
    assert.equal(result.bytes, expected);
  });
});

describe('写入范围', () => {
  it('★ 所有文件都落在 diary/ 下（这是「不碰 Obsidian 库」的可执行版本）', async () => {
    assert.equal(store.writesOnlyUnder, diaryRoot());
    const names = await readdir(join(diaryRoot(), 'daily'));
    assert.ok(names.length > 0);
    assert.equal(names.every(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)), true, `意外的文件名：${names}`);
  });

  it('★ 日记**没有**写进 data.json（那是全量重写，且一份坏 JSON 会连累订阅）', async () => {
    // 整个流程跑完之后，storages/dsh-npie-reader 下不该出现 data.json
    const names = await readdir(join(home, 'storages', 'dsh-npie-reader'));
    assert.equal(names.includes('data.json'), false, '日记不该碰 data.json');
  });
});

// ---------------------------------------------------------------------------
// 私密那一半（分层加密）
//
// ★ 这一组的断言全部是「可观察的后果」，不是「函数被调用了」：
//   - 磁盘上**没有明文**（唯一的直接证据是去文件里找那段文字）；
//   - 两个文件各有**独立序号**（合并成一个下标就必然反查，反查错就是删错一条）；
//   - 默认路径（搜索 / 标签 / 时间轴 / 导出）**看不到**私密，必须显式打开。
// ---------------------------------------------------------------------------

const SECRET_BODY = '这段是私密的：机密暗号 #秘密标签';

describe('私密那一半（分层加密）', () => {
  it('★ 私密条目落成 `.enc`，磁盘上找不到明文', async () => {
    const result = await secure.append({ date: '2026-07-01', time: '22:10', body: SECRET_BODY, vis: 'private' });
    assert.equal(result.scope, 'private');
    assert.equal(result.index, 0);
    // 公开那半边不该出现这一天
    await assert.rejects(() => readFile(diaryFilePath('2026-07-01'), 'utf8'), (error) => error.code === 'ENOENT');
    const blob = await readFile(join(diaryPrivateDir(), '2026-07-01.md.enc'), 'utf8');
    assert.equal(blob.includes('机密暗号'), false, '磁盘上出现了明文 —— 加密层等于没有');
    assert.equal(blob.includes(Buffer.from(SECRET_BODY).toString('base64')), false);
    // 反向对照：同样「一段带关键词的正文」用公开方式写，磁盘上**能**读到 ——
    // 证明上面那两条有牙。★ 对照组的文字必须和私密那段**不同**，否则下面
    // 「默认搜不到私密」那条会因为这条公开记录而命中，看着像是边界漏了。
    await secure.append({ date: '2026-07-02', body: '这段是公开的：明码暗号 #公开标签' });
    const plain = await readFile(diaryFilePath('2026-07-02'), 'utf8');
    assert.ok(plain.includes('明码暗号'));
  });

  it('readFull 合并两边，每条带 scope 与**各自独立**的 index', async () => {
    const date = '2026-07-03';
    await secure.append({ date, time: '08:00', body: '公开一' });
    await secure.append({ date, time: '09:00', body: '公开二' });
    await secure.append({ date, time: '08:30', body: '私密一', vis: 'private' });
    await secure.append({ date, time: '09:30', body: '私密二', vis: 'private' });

    const day = await secure.readFull(date);
    assert.equal(day.publicCount, 2);
    assert.equal(day.privateCount, 2);
    assert.deepEqual(
      day.entries.map(item => `${item.time}/${item.scope}/${item.index}`),
      ['08:00/public/0', '08:30/private/0', '09:00/public/1', '09:30/private/1'],
      '按时间合并，序号按 scope 各自从 0 起',
    );
  });

  it('★ removeEntry 带 scope：删私密不动公开，删公开不动私密', async () => {
    const date = '2026-07-04';
    await secure.append({ date, time: '08:00', body: '公开留下' });
    await secure.append({ date, time: '09:00', body: '私密删掉', vis: 'private' });
    await secure.append({ date, time: '10:00', body: '私密留下', vis: 'private' });

    await secure.removeEntry({ date, index: 0, scope: 'private' });
    let day = await secure.readFull(date);
    assert.deepEqual(day.entries.map(item => item.body), ['公开留下', '私密留下']);

    await secure.removeEntry({ date, index: 0 });
    day = await secure.readFull(date);
    assert.deepEqual(day.entries.map(item => item.body), ['私密留下'], '删公开那一条不该碰私密');
  });

  it('listMonth 把私密那半边也算进条数', async () => {
    const result = await secure.listMonth('2026-07');
    assert.equal(result.days['2026-07-01'], 1, '纯私密的一天也要在日历上有点');
    assert.equal(result.days['2026-07-03'], 4);
    assert.equal(result.privateError, undefined);
  });

  it('★ 解不开时抛 DECRYPT_FAILED —— **不能当成空的**', async () => {
    // 谎报 0 条会让用户以为私密日记没了，而再写一条就把整天的密文覆盖掉。
    const other = createDiaryStore({
      log: () => {},
      secret: createDiarySecret({ key: Buffer.alloc(32, 9), keyPath: join(home, 'other.key') }),
    });
    await assert.rejects(() => other.readFull('2026-07-01'), (error) => error.code === 'DECRYPT_FAILED');
    // 月视图里也不能消失：按 1 条算 + 带上原因
    const month = await other.listMonth('2026-07');
    assert.equal(month.days['2026-07-01'], 1);
    assert.match(month.privateError, /解不开|密钥/);
  });

  it('★ 搜索 / 标签 / 时间轴**默认看不到**私密，显式打开才看到', async () => {
    const date = '2026-07-05';
    await secure.append({ date, time: '21:00', body: SECRET_BODY, vis: 'private' });

    // 搜索
    assert.equal((await secure.search({ query: '机密暗号' })).hits.length, 0, '工具侧不该看到私密');
    const opened = await secure.search({ query: '机密暗号', includePrivate: true });
    // 2026-07-01 也是同一段私密正文，所以这里是「至少一条」，重点是**每一条**都来自私密那半边。
    assert.ok(opened.hits.length >= 1);
    assert.equal(opened.hits.every(hit => hit.scope === 'private'), true, '打开私密后也不该冒出公开命中');
    assert.ok(opened.hits.some(hit => hit.date === date));

    // 标签
    assert.equal((await secure.tags()).tags.some(item => item.tag === '秘密标签'), false);
    assert.equal((await secure.tags({ includePrivate: true })).tags.some(item => item.tag === '秘密标签'), true);

    // 时间轴
    const dayOf = (payload) => payload.days.find(day => day.date === date) ?? { entries: [] };
    assert.equal(dayOf(await secure.timeline()).entries.length, 0);
    const withPrivate = dayOf(await secure.timeline({ includePrivate: true }));
    assert.equal(withPrivate.entries.length, 1);
    assert.equal(withPrivate.entries[0].scope, 'private');
  });

  it('★ 导出默认**不含**私密（那条路写的是磁盘上的明文）', async () => {
    const without = await secure.exportAll();
    assert.equal(without.files.some(file => file.name.includes('2026-07-01')), false);
    assert.equal(without.files.every(file => file.name.endsWith('.md')), true);
    assert.ok(without.skippedPrivate >= 1, '要如实报「有 N 天没导出」');

    const withPrivate = await secure.exportAll({ includePrivate: true });
    const exported = withPrivate.files.find(file => file.name === '2026-07-01.private.md');
    assert.ok(exported, `私密那半边没导出：${withPrivate.files.map(file => file.name)}`);
    assert.ok(exported.text.includes('机密暗号'), '导出的应当是解密后的 Markdown');
    assert.equal(withPrivate.skippedPrivate, 0);
  });

  it('stats 报私密天数与密钥模式', async () => {
    const result = await secure.stats();
    assert.ok(result.privateDays >= 3);
    assert.ok(result.days > result.privateDays, '公开与私密都算在 days 里');
    assert.equal(result.secret, 'injected');
  });
});

// ---------------------------------------------------------------------------
// 读后感工作台：按**书**反查（读后感不属于某一天）
// ---------------------------------------------------------------------------

describe('timeline：把「挂在哪本书上」带出来', () => {
  it('★ 条目上带 book / chapter / page（侧栏按书归拢靠的就是它）', async () => {
    // 「灵感流转」在存储层写的是 `meta.book/chapter/page`。时间轴如果不把它们带出来，
    // 侧栏就只能按 `source` 字符串猜 —— 而 `source` 是给人看的，格式随时会变。
    const date = '2026-12-01';
    await store.append({ date, time: '21:00', kind: '灵感', body: '书里记的一条', source: '《深度工作》· 第 3 章', meta: { book: 'b7f3k2', chapter: 3, page: 128 } });
    await store.append({ date, time: '22:00', kind: '灵感', body: '普通灵感' });

    const day = (await store.timeline()).days.find(item => item.date === date);
    assert.notEqual(day, undefined, '时间轴里找不到刚写的那天');
    // 时间轴给的是 `preview`（截断到 160 字），不是完整 `body` —— 按 preview 找。
    const linked = day.entries.find(entry => entry.preview === '书里记的一条');
    assert.notEqual(linked, undefined, '时间轴里找不到刚写的那一条');
    assert.equal(linked.book, 'b7f3k2');
    assert.equal(linked.chapter, 3);
    assert.equal(linked.page, 128);
    // 反向对照：没关联的那条三个字段都是 null，不是 undefined、也不是空串 ——
    // 侧栏用 `entry.source` 过滤时，undefined 与 null 行为一样，但 `0` 会漏。
    const plain = day.entries.find(entry => entry.preview === '普通灵感');
    assert.equal(plain.book, null);
    assert.equal(plain.chapter, null);
  });
});

describe('byBook', () => {
  it('只回这本书的条目，跨天、按日期倒序', async () => {
    await store.append({ date: '2026-09-01', time: '09:00', kind: '读后感', body: '第一篇', meta: { book: 'l29fc96838f2d0e5d' } });
    await store.append({ date: '2026-09-03', time: '21:00', kind: '读后感', body: '第二篇', meta: { book: 'l29fc96838f2d0e5d' } });
    await store.append({ date: '2026-09-02', time: '10:00', kind: '读后感', body: '别的书', meta: { book: 'labcdef012345678' } });
    await store.append({ date: '2026-09-02', time: '11:00', body: '没有关联任何书' });

    const result = await store.byBook('l29fc96838f2d0e5d');
    assert.equal(result.total, 2);
    assert.deepEqual(result.entries.map(entry => entry.body), ['第二篇', '第一篇'], '新的在前');
    assert.deepEqual(result.entries.map(entry => entry.date), ['2026-09-03', '2026-09-01']);
  });

  it('★ 带上 date / index / scope —— 界面靠它们删除，不能只给正文', async () => {
    const result = await store.byBook('l29fc96838f2d0e5d');
    for (const entry of result.entries) {
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(Number.isInteger(entry.index), true);
      assert.equal(entry.scope, 'public');
    }
  });

  it('★ 非法 bookId 抛 BAD_BOOK（不拼进任何路径、也不全量扫一遍）', async () => {
    for (const bad of ['../../etc/passwd', 'a b', '', 'x'.repeat(80)]) {
      await assert.rejects(() => store.byBook(bad), (error) => error.code === 'BAD_BOOK', String(bad));
    }
  });

  /**
   * ★ 0.31.0 起「灵感流转」也会写 `meta.book`（在书里按 `L` 记的灵感自动挂到那本书）。
   *   只按 `meta.book` 收的话，这本书的灵感会一条条混进「读后感」列表 ——
   *   两边都是合法条目，界面上看不出任何异常，只是列表里出现了不是读后感的段落。
   */
  it('★ 只回**读后感**：挂在同一本书上的灵感不能混进来', async () => {
    await store.append({ date: '2026-09-04', time: '08:00', kind: '灵感', body: '书里按 L 记的灵感', meta: { book: 'l29fc96838f2d0e5d', chapter: 2, page: 30 } });
    // 同一本书、同一天，但类型是读后感 —— 它**必须**进来。没有这一条，
    // 上面那条断言在「byBook 干脆什么都不返回」时也会绿。
    await store.append({ date: '2026-09-05', time: '09:00', kind: '读后感', body: '同一本书的读后感', meta: { book: 'l29fc96838f2d0e5d' } });

    const result = await store.byBook('l29fc96838f2d0e5d');
    assert.deepEqual(result.entries.map(entry => entry.body), ['同一本书的读后感', '第二篇', '第一篇'],
      '灵感混进了读后感列表');
    assert.equal(result.entries.every(entry => entry.kind === '读后感'), true);
    assert.equal(result.entries.some(entry => entry.body === '书里按 L 记的灵感'), false);
  });
});
