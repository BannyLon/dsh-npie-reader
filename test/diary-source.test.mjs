/**
 * 「某一个来源的全部灵感」（0.47）—— `diary-store.js` 的 `bySource()`。
 *
 * ★ 它存在的唯一理由：灵感侧栏只有**一条**时间轴，聚合不能另开一套视图；
 *   而时间轴只读最近 `TIMELINE_DAY_LIMIT` 天，于是「这本书 7 条」实际是
 *   「最近 30 天里的 7 条」—— 一个看起来是全部、其实不全的数字，比不显示更糟。
 *
 * ★ 必须有牙的四条（每一条错了都**不会报错**，只会给一个错的数）：
 *   1. **形状与 `timeline()` 的 `days` 完全一致**：客户端拿它直接替换，不换渲染。
 *      形状一漂，症状是「从这个来源进来时条目点不动」这种只在一条路径上的毛病，
 *      而两边各自的单测都是绿的。
 *   2. **读后感不混进来**：它同样带 `meta.book`，收进来就会在「这本书的灵感」里
 *      出现一整篇读后感。
 *   3. **私密那半边不进来**：私密有它自己的闸门（加锁、逐条点开），并进来等于绕过它。
 *   4. **不借用搜索的 400 文件上限**：那条上限是给「搜索，先看最近的」设计的，
 *      而这里问的是「一共有多少条」。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildDay } from '../src/diary-format.js';
import { createDiarySecret } from '../src/host/diary-secret.js';
import { createDiaryStore, diaryFilePath, SEARCH_FILE_LIMIT } from '../src/host/diary-store.js';

let home = '';
let store = null;
/** 注入密钥的第二个实例：私密那半边的夹具走它（不碰真实钥匙串）。 */
let secure = null;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'npie-diary-source-'));
  // ★ 必须在造 store **之前**：`pluginDataDir()` 每次现读 `$DSH_HOME`。
  process.env.DSH_HOME = home;
  store = createDiaryStore({ log: () => {} });
  secure = createDiaryStore({
    log: () => {},
    secret: createDiarySecret({ key: Buffer.alloc(32, 5), keyPath: join(home, 'secret.key') }),
  });
});

after(async () => {
  // 清理失败 ≠ 断言失败（沙箱有时会拦删除）。
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('bySource：跨天、只给一个来源', () => {
  it('★ 形状与 `timeline().days` 完全一致（客户端直接替换，不换渲染）', async () => {
    await store.append({
      date: '2026-03-02', time: '10:00', kind: '灵感', body: '书里的第二条',
      source: '《九三年》 · 第 9 章', meta: { book: 'lbook1', chapter: 9, page: 211 },
    });

    const bySource = await store.bySource({ book: 'lbook1' });
    const timeline = await store.timeline({ limit: 10 });
    const srcDay = bySource.days.find((day) => day.date === '2026-03-02');
    const tlDay = timeline.days.find((day) => day.date === '2026-03-02');
    assert.ok(srcDay && tlDay, '两个接口没给同一天 —— 后面的比较没有意义');
    assert.deepEqual(Object.keys(srcDay).sort(), Object.keys(tlDay).sort(), 'day 这一层的形状漂了');
    assert.deepEqual(Object.keys(srcDay.entries[0]).sort(), Object.keys(tlDay.entries[0]).sort(),
      'entry 这一层的形状漂了 —— 客户端那套渲染会开始出现「只在一条路径上」的毛病');
    // 这一位是卡片上「第 9 章」的来源，不能少。
    assert.equal(srcDay.entries[0].chapter, 9);
    assert.equal(srcDay.entries[0].page, 211);
  });

  it('★ 跨天：日期倒序、同一天按时刻升序，且只收这个来源的', async () => {
    await store.append({ date: '2026-03-01', time: '20:00', kind: '灵感', body: '书里的第一条', source: '《九三年》 · 第 3 章', meta: { book: 'lbook1', chapter: 3 } });
    await store.append({ date: '2026-03-01', time: '08:00', kind: '灵感', body: '早上那条', source: '《九三年》', meta: { book: 'lbook1' } });
    await store.append({ date: '2026-03-02', time: '09:00', kind: '灵感', body: '另一本书的', source: '《悲惨世界》', meta: { book: 'lbook2' } });
    await store.append({ date: '2026-03-02', time: '11:00', kind: '灵感', body: '文章下的', source: '第 294 期', meta: { article: 'feed:294' } });
    await store.append({ date: '2026-03-05', time: '07:00', kind: '灵感', body: '手记的（没有出处）' });

    const byBook = await store.bySource({ book: 'lbook1' });
    assert.deepEqual(byBook.days.map((day) => day.date), ['2026-03-02', '2026-03-01']);
    assert.equal(byBook.total, 3, 'total 是条数，不是天数');
    const first = byBook.days[1];
    assert.deepEqual(first.entries.map((entry) => entry.time), ['08:00', '20:00'],
      '同一天没有按时刻升序 —— 时间轴那一套是升序的，两处不一致就看不出是同一天');
    const previews = byBook.days.flatMap((day) => day.entries.map((entry) => entry.preview));
    for (const wrong of ['另一本书的', '文章下的', '手记的（没有出处）']) {
      assert.equal(previews.includes(wrong), false, `别的来源混进来了：${wrong}`);
    }

    // 文章那一侧：key 里带冒号也要原样对上。
    const byArticle = await store.bySource({ article: 'feed:294' });
    assert.equal(byArticle.total, 1);
    assert.equal(byArticle.days[0].entries[0].article, 'feed:294');
  });

  it('★ 读后感不混进来（它同样带 meta.book）', async () => {
    await store.append({ date: '2026-03-03', time: '22:00', kind: '读后感', body: '一整篇读后感', meta: { book: 'lbook1' } });
    const byBook = await store.bySource({ book: 'lbook1' });
    const previews = byBook.days.flatMap((day) => day.entries.map((entry) => entry.preview));
    assert.equal(previews.includes('一整篇读后感'), false,
      '「这本书的灵感」里出现了一整篇读后感 —— 而它是读后感工作台的内容');
  });

  it('★ 私密那半边不进来（它有自己的一道闸门）', async () => {
    await secure.append({ date: '2026-03-04', time: '23:00', kind: '日记', body: '私密里的这一条', vis: 'private', meta: { book: 'lbook1' } });
    // 用**没有注入密钥**的 store 查：`scanDays` 默认不碰私密目录。
    const byBook = await store.bySource({ book: 'lbook1' });
    const previews = byBook.days.flatMap((day) => day.entries.map((entry) => entry.preview));
    assert.equal(previews.includes('私密里的这一条'), false, '私密被并进了灵感聚合 —— 绕过了它的闸门');
    // 反向对照：那条私密确实写进去了（否则上一条断言是「文件都没写」的假绿）。
    const decoded = await secure.readFull('2026-03-04');
    assert.equal(decoded.entries.some((entry) => entry.body.includes('私密里的这一条')), true,
      '夹具没写进去 —— 上面那条「没混进来」是假绿');
  });
});

describe('bySource：参数', () => {
  it('两个都给 / 都不给 ⇒ BAD_SOURCE（不是「两个都筛一遍」）', async () => {
    for (const input of [{}, { book: '' }, { article: '' }, { book: 'lbook1', article: 'feed:294' }]) {
      await assert.rejects(() => store.bySource(input), (error) => error.code === 'BAD_SOURCE', JSON.stringify(input));
    }
  });

  it('book id 不像 id ⇒ BAD_BOOK；article key 过长 ⇒ BAD_ARTICLE', async () => {
    await assert.rejects(() => store.bySource({ book: 'a b' }), (error) => error.code === 'BAD_BOOK');
    await assert.rejects(() => store.bySource({ article: 'x'.repeat(201) }), (error) => error.code === 'BAD_ARTICLE');
  });

  it('没有这个来源的灵感 ⇒ 空数组而不是抛错（横条要显示「0 条」）', async () => {
    const empty = await store.bySource({ book: 'lbook_never_used' });
    assert.deepEqual(empty.days, []);
    assert.equal(empty.total, 0);
  });
});

/**
 * ★ 这条是这一组的**要害**：`bySource()` 的注释里写着「时间轴只读最近 N 天，
 *   于是『这本书 7 条』实际是『最近 30 天里的 7 条』」，而它自己若借用搜索的
 *   400 文件上限，就犯下同一个错 —— 只是把 30 天换成了 400 天。
 */
describe('bySource：不借用搜索的 400 文件上限', () => {
  it('★ 三年日记里最旧的那一条也在（搜不到的，聚合要搜得到）', async () => {
    const days = SEARCH_FILE_LIMIT + 3;
    const oldest = '2019-01-01';
    const start = Date.parse(`${oldest}T00:00:00Z`);
    await mkdir(dirname(diaryFilePath(oldest)), { recursive: true });
    // ★ 分批发、每批并行：这一层是**文件系统延迟**在花时间，串行 400 次写入
    //   在慢盘上能到半分钟（第一版就是这么写的，单条用例 32 秒）。
    const keys = Array.from({ length: days }, (_, index) => (
      new Date(start + index * 86_400_000).toISOString().slice(0, 10)
    ));
    for (let at = 0; at < keys.length; at += 40) {
      await Promise.all(keys.slice(at, at + 40).map((key, offset) => {
        const entries = key === oldest
          ? [{ time: '09:00', kind: '灵感', source: '《九三年》', meta: { book: 'lbook_old' }, body: '最旧的一条' }]
          : [{ time: '09:00', kind: '灵感', body: `第 ${at + offset} 天的普通一条` }];
        return writeFile(diaryFilePath(key), buildDay(key, entries), 'utf8');
      }));
    }

    // 反向对照：这份夹具**真的**落在搜索的上限之外（否则下面那条断言没有牙）。
    // ★ 这里用 `readdir` 数文件，而不是真的跑一次 `search()`：沙箱里每次 `readFile`
    //   约 35ms（实测），跑一次搜索要 400 × 35ms ≈ 14 秒，而它要证明的只是
    //   「文件数 > SEARCH_FILE_LIMIT」这一件事。
    const names = await readdir(dirname(diaryFilePath(oldest)));
    assert.ok(names.length > SEARCH_FILE_LIMIT,
      `夹具只有 ${names.length} 个文件，没超过搜索上限 ${SEARCH_FILE_LIMIT} —— 这条测不到东西`);

    const bySource = await store.bySource({ book: 'lbook_old' });
    assert.equal(bySource.total, 1, `聚合只扫了 ${SEARCH_FILE_LIMIT} 个文件 —— 「全部 N 条」是个假数字`);
    assert.equal(bySource.days[0].entries[0].preview, '最旧的一条');
    assert.equal(bySource.truncated, false, '还有没扫到的文件，却按「全部」在报数');
    // ★ 而且它数的是**全部**天：403 个文件里只有一天有这条灵感，其余都是别的。
    assert.equal(bySource.scanned, names.length, '没扫完全部文件');
  });
});
