/**
 * `runBookDigests` 的**真跑**：勾选哪几章、用哪个模型、进度记在哪。
 *
 * ★ 为什么这个文件必须存在：这三件事全是「界面说 A、宿主做 B」的高危点，而
 *   它们都是**纯源码字符串断言答不了的** —— 字符串能证明「把 chapters 传进去了」，
 *   证明不了「传进去之后真的只跑了那几章」。这里用真 service + 真 digestStore +
 *   假 llm 跑一遍，数的是**实际调了几次模型、写了哪几个解读文件**。
 *
 * ★ 假 llm 只回一段合格的解读 JSON（与 `book-digest-generate.test.mjs` 同一个
 *   判据：summary 不能照抄原文），所以这里量到的是「跑了几章」，不是「模型好不好」。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { loadHostBundle } from './helpers/host-bundle.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(join(tmpdir(), 'npie-digest-run-'));
process.env.DSH_HOME = sandbox;
// 与 `service.test.mjs` 同一条理由：`~/.baidu-pan-*.json` 的迁移走 `os.homedir()`，
// 不隔离的话会去读用户真实 home。
process.env.HOME = sandbox;

const { RssService } = await loadHostBundle();

const liveServices = new Set();
after(async () => {
  for (const service of liveServices) {
    const store = service?.store;
    if (store?.saveTimer !== undefined) {
      clearTimeout(store.saveTimer);
      store.saveTimer = undefined;
    }
  }
  liveServices.clear();
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

/** 一段合格但「完全自述」的解读（不含原文长串）。 */
const GOOD_JSON = JSON.stringify({
  summary: '作者把这一章拆成三条线索，并指出多数线上事故来自把三者混为一谈。',
  points: ['先分清是哪一类问题', '再决定用什么工具'],
  terms: [{ term: '一致性', note: '本章指多副本之间的可见顺序' }],
});

/** 正文：要超过 `DIGEST_MIN_CHARS`（200），否则会被判「不值得调模型」。 */
const BODY = '分布式系统的一致性问题是工程实践里最容易被低估的部分，它同时牵涉到时钟、网络分区与故障检测三件事。'.repeat(6);

const CHAPTERS = [
  { n: 1, title: '第一章 起', startPage: 1, endPage: 2 },
  { n: 2, title: '第二章 承', startPage: 3, endPage: 4 },
  { n: 3, title: '第三章 转', startPage: 5, endPage: 6 },
];

let homeCounter = 0;
/** 起一个 service，并把这本书的目录 / 正文 / meta 都写好。 */
async function bootBook({ statuses = ['pending', 'pending', 'pending'], settings = {} } = {}) {
  process.env.DSH_HOME = join(sandbox, `home-${homeCounter}`);
  homeCounter += 1;
  const calls = [];
  const fake = createFakeContext({
    llmChunks: (request) => {
      calls.push(request);
      return [{ type: 'text-delta', text: GOOD_JSON }, { type: 'finish', reason: { kind: 'stop' } }];
    },
  });
  const service = new RssService(fake.ctx, {});
  liveServices.add(service);
  await service.ready;
  if (Object.keys(settings).length > 0) await service.saveSettings({ patch: settings });

  const bookId = 'l-run';
  const pages = [];
  for (let page = 1; page <= 6; page += 1) pages.push({ page, lines: [BODY] });
  await service.digestStore.writeOutline(bookId, CHAPTERS);
  await service.digestStore.writeChapterTexts(bookId, pages, CHAPTERS);
  await service.digestStore.writeMeta(bookId, {
    bookId,
    bookTitle: '某本书',
    mode: 'toc',
    pageCount: 6,
    chapters: CHAPTERS.map((chapter, index) => ({
      ...chapter,
      chars: BODY.length * 2,
      status: statuses[index],
    })),
    task: { state: 'idle', cursor: 6 },
  });
  return { service, calls, bookId };
}

const statusesOf = async (service, bookId) => {
  const meta = await service.digestStore.readMeta(bookId);
  return Object.fromEntries((meta.chapters ?? []).map(chapter => [chapter.n, chapter.status]));
};

describe('runBookDigests：只跑勾上的章', () => {
  it('★★ 勾了 1、3 ⇒ 只调两次模型，第 2 章连解读文件都没有', async () => {
    const { service, calls, bookId } = await bootBook();
    await service.runBookDigests(bookId, { chapters: [1, 3], signal: new AbortController().signal });

    assert.equal(calls.length, 2, '勾了 2 章却调了别的次数');
    assert.deepEqual(await statusesOf(service, bookId), { 1: 'done', 2: 'pending', 3: 'done' });
    assert.equal(await service.digestStore.readDigest(bookId, 2), null, '第 2 章不该有解读');
    assert.equal((await service.digestStore.readDigest(bookId, 3)).title, '第三章 转');
  });

  it('★ 这一批的进度记在 task 上（界面画进度条要靠它）', async () => {
    const { service, bookId } = await bootBook();
    await service.runBookDigests(bookId, { chapters: [1, 3], signal: new AbortController().signal });
    const meta = await service.digestStore.readMeta(bookId);
    // 全书 3 章，这一批 2 章 —— 两个数字必须分开记：只记全书的话，勾 2 章跑完时
    // 进度条会永远停在 2/3。
    assert.equal(meta.task.digestTotal, 3);
    assert.equal(meta.task.digestRunTotal, 2);
    assert.equal(meta.task.digestRunDone, 2);
  });

  it('★ 没给 chapters ⇒ 老行为：跳过 done 的，跑其余', async () => {
    const { service, calls, bookId } = await bootBook({ statuses: ['done', 'pending', 'pending'] });
    await service.runBookDigests(bookId, { signal: new AbortController().signal });
    assert.equal(calls.length, 2);
    assert.deepEqual(await statusesOf(service, bookId), { 1: 'done', 2: 'done', 3: 'done' });
  });

  it('★★ 显式勾了 done 的章 ⇒ 重做它（勾选即意图，不被「done 就跳过」吞掉）', async () => {
    // 不这样的话，用户勾了 3 章、界面说「重新生成（3 章）」，实际一章都没跑 ——
    // 界面上的字与真实行为直接矛盾。
    const { service, calls, bookId } = await bootBook({ statuses: ['done', 'done', 'pending'] });
    await service.runBookDigests(bookId, { chapters: [1], signal: new AbortController().signal });
    assert.equal(calls.length, 1, '勾了已解读的章却没有重跑');
    const meta = await service.digestStore.readMeta(bookId);
    assert.equal(meta.chapters[0].status, 'done');
    // 另外两章保持原样（没被顺手跑一遍）。
    assert.deepEqual(meta.chapters.map(c => c.status), ['done', 'done', 'pending']);
  });

  it('勾了不存在的章号 ⇒ 什么都不做，而不是把整本跑一遍', async () => {
    const { service, calls, bookId } = await bootBook();
    await service.runBookDigests(bookId, { chapters: [99], signal: new AbortController().signal });
    assert.equal(calls.length, 0, '勾了一个不存在的章号，却把整本跑了一遍');
    assert.deepEqual(await statusesOf(service, bookId), { 1: 'pending', 2: 'pending', 3: 'pending' });
  });

  it('正文过短的章勾了也只会被标成 skipped，不会调模型', async () => {
    const { service, calls, bookId } = await bootBook();
    // 把第 2 章的正文清空。
    await service.digestStore.writeChapterTexts(bookId, [
      { page: 1, lines: [BODY] }, { page: 2, lines: [BODY] },
      { page: 3, lines: ['短'] }, { page: 4, lines: ['短'] },
      { page: 5, lines: [BODY] }, { page: 6, lines: [BODY] },
    ], CHAPTERS);
    await service.runBookDigests(bookId, { chapters: [2], signal: new AbortController().signal });
    assert.equal(calls.length, 0);
    assert.equal((await statusesOf(service, bookId))[2], 'skipped');
  });
});

describe('runBookDigests：这一次用哪个模型', () => {
  it('★★ 传进来的 model 必须出现在每一次请求上（不是只写进产物）', async () => {
    const { service, calls, bookId } = await bootBook();
    await service.runBookDigests(bookId, {
      chapters: [1], model: 'free-provider/free-model', signal: new AbortController().signal,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'free-provider');
    assert.equal(calls[0].model, 'free-model');
    // 产物里也记下来 —— 用户事后要能看出这一章是哪个模型跑的。
    assert.equal((await service.digestStore.readDigest(bookId, 1)).model, 'free-provider/free-model');
  });

  it('不传 model ⇒ 用设置里的 digestModel', async () => {
    const { service, calls, bookId } = await bootBook({ settings: { digestModel: 'cheap-provider/cheap-model' } });
    await service.runBookDigests(bookId, { chapters: [1], signal: new AbortController().signal });
    assert.equal(calls[0].provider, 'cheap-provider');
    assert.equal(calls[0].model, 'cheap-model');
  });

  it('★ digestModel 与 aiModel 互不影响（翻译用的模型不会被解读借用）', async () => {
    const { service, calls, bookId } = await bootBook({
      settings: { aiModel: 'translate-provider/translate-model', digestModel: 'digest-provider/digest-model' },
    });
    await service.runBookDigests(bookId, { chapters: [1], signal: new AbortController().signal });
    assert.equal(calls[0].provider, 'digest-provider');
    // 反向对照：如果宿主错用了 aiModel，上面那条会变成 translate-provider。
    assert.notEqual(calls[0].provider, 'translate-provider');
  });

  it('跟随默认模型时产物里记的是 default（不是空串，也不是编出来的名字）', async () => {
    const { service, bookId } = await bootBook();
    await service.runBookDigests(bookId, { chapters: [1], model: '', signal: new AbortController().signal });
    assert.equal((await service.digestStore.readDigest(bookId, 1)).model, 'default');
  });
});

describe('startBookDigests：参数校验', () => {
  it('★ chapters 为空数组 ⇒ 报错（「勾了 0 章」不该静默跑整本）', async () => {
    const { service, bookId } = await bootBook();
    await assert.rejects(
      () => service.startBookDigests({ bookId, chapters: [] }),
      /没有勾选任何章节/,
    );
  });

  it('chapters 不是数组 ⇒ 报错', async () => {
    const { service, bookId } = await bootBook();
    await assert.rejects(() => service.startBookDigests({ bookId, chapters: '1,2' }), /必须是章节号数组/);
  });

  it('★ 模型取值读不出来 ⇒ 报错，绝不静默回退到默认模型', async () => {
    // 静默回退的症状是「用户以为在用免费模型，其实一直在花默认模型的钱」，
    // 没有任何报错 —— 只有账单能看出来。
    const { service, bookId } = await bootBook();
    for (const bad of ['free-model', '/x', 'x/', 42]) {
      await assert.rejects(
        () => service.startBookDigests({ bookId, model: bad }),
        /必须形如 provider\/model/,
        String(bad),
      );
    }
  });

  it('★ 同一本书正在跑时再点一次 ⇒ alreadyRunning，而不是报错', async () => {
    const { service, bookId } = await bootBook();
    const first = await service.startBookDigests({ bookId, chapters: [1] });
    assert.equal(first.started, true);
    const second = await service.startBookDigests({ bookId, chapters: [2] });
    assert.deepEqual(second, { started: false, alreadyRunning: true });
    await service.stopBookDigests(bookId);
  });
});
