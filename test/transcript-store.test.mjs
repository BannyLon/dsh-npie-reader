/**
 * 单集字幕的落盘层（`src/host/transcript-store.js`）。
 *
 * 它守的是「**别把别人的字幕挂到这一集上**」与「**坏文件不该让面板报错**」这两件事。
 * 两者在界面上都不是显眼的故障：前者会让用户读到另一期的内容还以为是翻译错了，
 * 后者会让「点开这一集就弹错误」而用户根本不知道删哪个文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { TRANSCRIPT_STORE_VERSION, createTranscriptStore } from '../src/host/transcript-store.js';

const roots = [];

/** 临时目录带 pid：同一套件的两个进程并发跑时不会共用一个目录（那会造成偶发串味）。 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), `npr-tr-${process.pid}-`));
  roots.push(root);
  return root;
}

after(async () => {
  for (const root of roots) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // 安全中心偶尔会拦住临时目录的删除；判据不依赖「删干净了」。
    }
  }
});

const SEGMENTS = [
  { start: 0, end: 2, text: 'hello' },
  { start: 2.2, end: 4, text: 'world' },
];

/** 找到目录里唯一那份字幕文件（不去复刻实现的哈希算法，避免判据与实现同一份口径）。 */
async function onlyFile(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 1, `目录里应当只有一份字幕：${names.join(',')}`);
  return join(dir, names[0]);
}

describe('transcript-store', () => {
  it('写进去再读回来，字段一个不少', async () => {
    const store = createTranscriptStore({ rootDir: await makeRoot() });
    const written = await store.write('feed:abc', {
      segments: SEGMENTS,
      format: 'vtt',
      source: { kind: 'feed', url: 'https://cdn.example/a.vtt' },
    });
    assert.equal(written.segments.length, 2);
    assert.ok(written.bytes > 0);
    // 返回的是完整记录（不是 { segments: 2 } 这种摘要）：调用方要拿它去切段。
    assert.equal(written.format, 'vtt');

    const record = await store.read('feed:abc');
    assert.equal(record.key, 'feed:abc');
    assert.equal(record.format, 'vtt');
    assert.equal(record.source.url, 'https://cdn.example/a.vtt');
    assert.deepEqual(record.segments, SEGMENTS);
    assert.ok(record.fetchedAt > 0);
  });

  it('没有这一集时给 null，不抛错', async () => {
    const store = createTranscriptStore({ rootDir: await makeRoot() });
    assert.equal(await store.read('feed:missing'), null);
  });

  it('文件里的 key 与请求的不一致时当「没有」（哈希撞了也不能串集）', async () => {
    const store = createTranscriptStore({ rootDir: await makeRoot() });
    await store.write('feed:abc', { segments: SEGMENTS });
    const path = await onlyFile(store.dir);
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.key = 'feed:other';
    await writeFile(path, JSON.stringify(data), 'utf8');
    assert.equal(await store.read('feed:abc'), null);
  });

  it('坏 JSON / 旧版本都按没有处理，并留下一条日志', async () => {
    const logs = [];
    const brokenStore = createTranscriptStore({ rootDir: await makeRoot(), log: (message) => logs.push(message) });

    await brokenStore.write('feed:broken', { segments: SEGMENTS });
    const brokenPath = await onlyFile(brokenStore.dir);
    await writeFile(brokenPath, '{oops', 'utf8');
    assert.equal(await brokenStore.read('feed:broken'), null);
    assert.match(logs.join('\n'), /不是合法 JSON/);

    // 旧版本用**另一个根目录**：同一个目录里放两份文件时，`onlyFile` 会先报出「两份」
    // 这个无关的错误，把真正要验的「版本不符」挡住。
    const oldStore = createTranscriptStore({ rootDir: await makeRoot(), log: (message) => logs.push(message) });
    await oldStore.write('feed:old', { segments: SEGMENTS });
    const oldPath = await onlyFile(oldStore.dir);
    const data = JSON.parse(await readFile(oldPath, 'utf8'));
    data.version = TRANSCRIPT_STORE_VERSION - 1;
    await writeFile(oldPath, JSON.stringify(data), 'utf8');
    assert.equal(await oldStore.read('feed:old'), null);
    assert.match(logs.join('\n'), /版本或 key 不匹配/);
  });

  it('空条目直接拒绝写（一份空字幕比没有更糟：面板会显示成「有字幕」）', async () => {
    const store = createTranscriptStore({ rootDir: await makeRoot() });
    await assert.rejects(() => store.write('feed:empty', { segments: [] }), /没有可写的字幕条目/);
  });

  it('usage 统计文件数与字节数（设置页要看得见这块占用）', async () => {
    const store = createTranscriptStore({ rootDir: await makeRoot() });
    assert.deepEqual(await store.usage(), { files: 0, bytes: 0 });
    await store.write('feed:a', { segments: SEGMENTS });
    await store.write('feed:b', { segments: SEGMENTS });
    const usage = await store.usage();
    assert.equal(usage.files, 2);
    assert.ok(usage.bytes > 0);
  });

  it('rootDir 缺失要当场报错（配置写错不该等到写盘时才炸）', () => {
    assert.throws(() => createTranscriptStore({}), /需要 rootDir/);
  });
});

/**
 * 译文缓存（`readTranslation` / `writeTranslation`）。
 *
 * ★ 它和字幕缓存**必须是两个文件**：重新获取字幕（`refresh`）不该把花过钱的译文
 *   一起丢掉。判据里同时钉住「写译文不会覆盖字幕」「写字幕不会覆盖译文」两件事。
 */
describe('中文译文缓存', () => {
  it('写进去能读出来，且字段原样（model / sourceHash 要能自证是哪次翻的）', async () => {
    const store = createTranscriptStore({ rootDir: await makeRoot() });
    await store.writeTranslation('feed:zh', { translations: ['你好', '世界'], sourceHash: 'abc', model: 'p/m' });
    const read = await store.readTranslation('feed:zh');
    assert.deepEqual(read.translations, ['你好', '世界']);
    assert.equal(read.sourceHash, 'abc');
    assert.equal(read.model, 'p/m');
    assert.equal(read.target, 'zh-CN');
  });

  it('★ 部分译文也能落盘（逐批翻、逐批写，中途关掉不白花钱）', async () => {
    const store = createTranscriptStore({ rootDir: await makeRoot() });
    await store.writeTranslation('feed:part', { translations: ['a', '', ''], sourceHash: 'h' });
    const first = await store.readTranslation('feed:part');
    assert.equal(first.translations.length, 3);
    assert.equal(first.translations[1], '');
    await store.writeTranslation('feed:part', { translations: ['a', 'b', ''], sourceHash: 'h' });
    assert.equal((await store.readTranslation('feed:part')).translations[1], 'b');
  });

  it('★ 字幕与译文互不覆盖（重抓字幕不该丢译文，重译也不该丢字幕）', async () => {
    const root = await makeRoot();
    const store = createTranscriptStore({ rootDir: root });
    await store.write('feed:both', { segments: SEGMENTS, format: 'vtt' });
    await store.writeTranslation('feed:both', { translations: ['你好'], sourceHash: 'h' });
    await store.write('feed:both', { segments: SEGMENTS, format: 'vtt' });
    assert.deepEqual((await store.readTranslation('feed:both')).translations, ['你好']);
    assert.equal((await store.read('feed:both')).segments.length, 2);
    await store.writeTranslation('feed:both', { translations: ['你好呀'], sourceHash: 'h' });
    assert.equal((await store.read('feed:both')).segments[0].text, 'hello');
  });

  it('没有译文时返回 null（不是空数组：界面要区分「没译过」与「译了但全空」）', async () => {
    const store = createTranscriptStore({ rootDir: await makeRoot() });
    assert.equal(await store.readTranslation('feed:none'), null);
  });

  it('坏 JSON / 版本不符一律当没有（不能让面板因为一个缓存文件打不开）', async () => {
    const logs = [];
    const root = await makeRoot();
    const store = createTranscriptStore({ rootDir: root, log: (message) => logs.push(message) });
    await store.writeTranslation('feed:bad', { translations: ['x'], sourceHash: 'h' });
    const dir = store.dir;
    const names = (await readdir(dir)).filter((name) => name.endsWith('.zh-CN.json'));
    assert.equal(names.length, 1);
    await writeFile(join(dir, names[0]), '{oops', 'utf8');
    assert.equal(await store.readTranslation('feed:bad'), null);
    assert.match(logs.join('\n'), /不是合法 JSON/);
  });
});
