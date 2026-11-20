/**
 * 每节实测耗时的档案（`src/host/ebook/prefetch-stats.js`）+ 它对 ETA 的作用。
 *
 * 这一组钉的是一条**用户直接看得见**的缺口（0.63.0，原话「你显示了百分比但是
 * 没显示剩余时间」）：
 *
 *   上次翻到 17% 停下 → 磁盘上有 6 节译文 → 这次点「继续」→ 百分比立刻是 17%，
 *   但 ETA 是空的，因为 `estimateEtaSeconds` 只认**这一轮**译完的节，而这一轮
 *   第一节还没跑完。耗时档案就是补这一段的：它把「上次跑得多快」存下来。
 *
 * 另外三条是档案本身的边界：坏文件回空（不能让一本坏档案挡住翻译）、
 * 脏样本被过滤、条数有上限（文件不能无限长）。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createPrefetchStatsStore } from '../src/host/ebook/prefetch-stats.js';
import { createPrefetchRunner } from '../src/host/ebook/prefetch.js';
import { rm } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
/** 沙箱放在仓库内（`test/.build/`，已 gitignore），不用 `os.tmpdir()`（同 `backfill.test.mjs`）。 */
const sandbox = await mkdtemp(join(here, '.build', 'sandbox-stats-' + process.pid + '-'));

after(async () => { await rm(sandbox, { recursive: true, force: true }).catch(() => {}); });

const rootOf = (name) => join(sandbox, name);
const book = (id = 'b1') => ({ id, title: 'A Book', ext: 'epub', size: 1 });
const section = (title, ...texts) => ({ title, chars: texts.join('').length, blocks: texts.map(x => ({ k: 'p', x })) });

/** 轮询到条件成立（同 `ebook-prefetch.test.mjs`，不写死 sleep）。 */
async function until(check, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('until: 超时');
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

describe('耗时档案：读写与边界', () => {
  it('写进去、读回来（毫秒数组，保序）', async () => {
    const store = createPrefetchStatsStore({ rootDir: rootOf('rw') });
    await store.write('b1', [1200, 900, 1500]);
    assert.deepEqual(await store.read('b1'), [1200, 900, 1500]);
    const raw = JSON.parse(await readFile(store.pathOf('b1'), 'utf8'));
    assert.equal(raw.v, 1, '档案要带版本号，形状变了才能判废');
  });

  it('★ 文件坏了 / 版本不认识 / 根本没有 ⇒ 空数组，绝不抛错', async () => {
    const root = rootOf('broken');
    await mkdir(root, { recursive: true });
    const store = createPrefetchStatsStore({ rootDir: root });
    assert.deepEqual(await store.read('never-written'), []);
    await writeFile(join(root, 'b-bad.json'), '{ 这不是 JSON', 'utf8');
    assert.deepEqual(await store.read('b-bad'), []);
    await writeFile(join(root, 'b-old.json'), JSON.stringify({ v: 0, durations: [100] }), 'utf8');
    assert.deepEqual(await store.read('b-old'), []);
  });

  it('★ 脏样本被过滤：负数、NaN、超过 2 小时', async () => {
    const root = rootOf('dirty');
    await mkdir(root, { recursive: true });
    const store = createPrefetchStatsStore({ rootDir: root });
    await writeFile(join(root, 'b1.json'), JSON.stringify({
      v: 1, durations: [1000, -5, 0, 'x', 3 * 60 * 60 * 1000, 2000],
    }), 'utf8');
    assert.deepEqual(await store.read('b1'), [1000, 2000]);
  });

  it('★ 只留最近 24 条（文件不能随着翻书无限长）', async () => {
    const store = createPrefetchStatsStore({ rootDir: rootOf('cap') });
    await store.write('b1', Array.from({ length: 100 }, (_, i) => (i + 1) * 10));
    const back = await store.read('b1');
    assert.equal(back.length, 24);
    assert.equal(back.at(-1), 1000, '留的是**最近**的，不是最早的');
  });

  it('空数组不写文件（免得每次开跑都落一个空档案）', async () => {
    const root = rootOf('empty');
    const store = createPrefetchStatsStore({ rootDir: root });
    await store.write('b1', []);
    assert.deepEqual(await store.read('b1'), []);
  });

  it('并发写同一本书不会写坏（串行化 + 原子替换）', async () => {
    const store = createPrefetchStatsStore({ rootDir: rootOf('race') });
    await Promise.all([
      store.write('b1', [100]), store.write('b1', [200]), store.write('b1', [300]),
    ]);
    const back = await store.read('b1');
    assert.ok(back.length === 1 && [100, 200, 300].includes(back[0]), '读到的是某一次完整的写，不是半份文件');
  });
});

describe('★ ETA 跨会话：上次的耗时让「继续」一开跑就有剩余时间', () => {
  const sections = [
    section('一', 'One.'), section('二', 'Two.'), section('三', 'Three.'),
    section('四', 'Four.'), section('五', 'Five.'), section('六', 'Six.'),
  ];

  /** 一个永不放行的翻译函数：任务停在「正在翻第一节」，正是用户截图那一刻。 */
  const stalledRunner = (stats) => createPrefetchRunner({
    resolveEbook: async () => ({ sections, script: 'latin' }),
    translateSection: () => new Promise(() => {}),
    // 前 3 节已译（磁盘上），这一轮从第 4 节继续。
    translatedSections: async () => [1, 2, 3],
    ...(stats === undefined ? {} : { stats }),
  });

  it('★ 有历史档案：start 之后**立刻**就有 eta（补上用户截图里缺的那个数）', async () => {
    const store = createPrefetchStatsStore({ rootDir: rootOf('eta-yes') });
    // 上次跑的时候，每节约 20 分钟。
    await store.write('b1', [20 * 60 * 1000, 20 * 60 * 1000, 20 * 60 * 1000]);
    const runner = stalledRunner(store);
    const started = await runner.start(book('b1'));
    assert.equal(started.state, 'running');
    assert.equal(started.translated, 3);
    assert.ok(started.etaSeconds > 0, 'ETA 必须已有值 —— 这正是「只显示百分比、不显示剩余时间」的反面');
    assert.match(started.eta, /还剩约|马上完成/);
    await runner.stop('b1');
  });

  it('没有历史档案（第一次翻这本书）：eta 为空，界面负责说「正在估算」', async () => {
    const runner = stalledRunner(undefined);
    const started = await runner.start(book('b1'));
    assert.equal(started.eta, '');
    assert.equal(started.etaSeconds, null);
    await runner.stop('b1');
  });

  it('★ 这一轮译完的节会写进档案（下次才有历史可用）', async () => {
    const store = createPrefetchStatsStore({ rootDir: rootOf('eta-write') });
    const runner = createPrefetchRunner({
      resolveEbook: async () => ({ sections: [section('一', 'One.'), section('二', 'Two.')], script: 'latin' }),
      // ★ 必须真的花点时间：档案会丢掉 0ms 的样本（真模型不可能 0ms 返回，
      //   而 0 会让「最近 5 节均值」把 ETA 算成 0 —— 那是个假数字）。
      translateSection: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return {}; },
      translatedSections: async () => [],
      stats: store,
    });
    await runner.start(book('b1'));
    await until(async () => (await runner.status(book('b1'))).state === 'done');
    await until(async () => (await store.read('b1')).length === 2);
    assert.equal((await store.read('b1')).length, 2, '收尾那一次写盘不能漏（2 节不是 3 的倍数）');
  });
});
