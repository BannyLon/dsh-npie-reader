/**
 * 读后感提纲的宿主侧（0.88.0）：材料真的被取出来了、真的送进了提示词。
 *
 * 纯函数那半边（预算 / 解析）在 `reflection-outline.test.mjs`。这一份盯的是另一类
 * 缺陷：**材料没接上**。它的症状很安静 —— 提纲照样生成、界面照样显示，只是内容
 * 泛得像通用模板；而用户会得出「这个 AI 不行」的结论，不会报 bug。
 *
 * 所以断言分两层：
 *   ① 返回值里的 `sources` 报了几章要点、几条划线；
 *   ② **真的发给模型的那段文本里**有没有书名、章节要点、用户划的句子。
 *      只测 ① 的话，一个「把数字算对但把材料扔了」的实现也能全绿。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { loadHostBundle } from './helpers/host-bundle.mjs';

const sandbox = await mkdtemp(join(tmpdir(), 'npie-outline-'));
process.env.DSH_HOME = sandbox;
process.env.HOME = sandbox;

const { RssService } = await loadHostBundle();
const realFetch = globalThis.fetch;
const liveServices = new Set();

after(async () => {
  globalThis.fetch = realFetch;
  for (const service of liveServices) {
    if (service?.store?.saveTimer !== undefined) {
      clearTimeout(service.store.saveTimer);
      service.store.saveTimer = undefined;
    }
  }
  liveServices.clear();
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

const OUTLINE_TEXT = [
  '## 一、赌局里的信任是怎么被定价的',
  '回到第 1 章那个赌局（第 1 章）',
  '',
  '## 二、我在合作里犯过的同一个错',
  '对照你划的那句「信任是可以计价的」',
].join('\n');

let counter = 0;
function boot({ chunks } = {}) {
  process.env.DSH_HOME = join(sandbox, `home-${counter}`);
  counter += 1;
  const fake = createFakeContext({
    llmChunks: chunks ?? [{ type: 'text-delta', text: OUTLINE_TEXT }, { type: 'finish', reason: { kind: 'ok' } }],
  });
  globalThis.fetch = fake.state.fetch;
  const service = new RssService(fake.ctx, { pageGuard: async () => ({ ok: true }) });
  liveServices.add(service);
  return { service, state: fake.state };
}

/** 一本书 + 两章要点 + 一条划线。用桩替换 IO 层，只测「组装」这一段。 */
function stubBook(service, { chapters = 2, annotations = 1 } = {}) {
  service.bookById = async () => ({ id: 'b00001', title: '信任的代价', author: '某作者', ext: '.epub' });
  service.digestStore = {
    readOutline: async () => [
      { n: 1, title: '开端', startPage: 1, endPage: 20 },
      { n: 2, title: '转折', startPage: 21, endPage: 40 },
    ].slice(0, chapters),
    readDigest: async (bookId, n) => ({ summary: `第 ${n} 章讲了赌局与代价`, points: ['要点甲', '要点乙'] }),
  };
  service.annotationStore = {
    list: async () => (annotations === 0 ? [] : [{ page: 33, quote: '信任是可以计价的', note: '想起上次合作' }]),
  };
}

/** 取出发给模型的那段用户文本。 */
function userTextOf(state) {
  const call = state.llmCalls.at(-1);
  assert.ok(call, '没有发生模型调用');
  const user = (call.messages ?? []).find((message) => message?.role === 'user');
  const text = user?.content?.[0]?.text ?? '';
  assert.ok(typeof text === 'string' && text !== '', '用户消息里没有文本');
  return text;
}

describe('0.88.0：提纲的材料', () => {
  it('★ 章节要点与划线真的进了提示词（不只是数字对上）', async () => {
    const { service, state } = boot();
    stubBook(service);
    const result = await service.reflectionOutline({ bookId: 'b00001', draft: '' });

    assert.equal(result.sources.chapters, 2);
    assert.equal(result.sources.annotations, 1);
    assert.equal(result.thin, false);
    assert.equal(result.headings.length, 2);
    assert.equal(result.book.title, '信任的代价');

    const text = userTextOf(state);
    for (const needle of ['信任的代价', '某作者', '第 1 章 开端', '赌局与代价', '信任是可以计价的', '第 33 页']) {
      assert.ok(text.includes(needle), `提示词里缺了「${needle}」—— 材料没接上`);
    }
  });

  it('用户已写的半截正文也进提示词（提纲接着它写）', async () => {
    const { service, state } = boot();
    stubBook(service);
    await service.reflectionOutline({ bookId: 'b00001', draft: '我读到第三章时想起自己的一次失败。' });
    assert.ok(userTextOf(state).includes('我读到第三章时想起自己的一次失败。'));
  });

  it('★ 材料薄 ⇒ thin: true（界面据此说「会比较泛」）', async () => {
    const { service } = boot();
    stubBook(service, { chapters: 0, annotations: 0 });
    const result = await service.reflectionOutline({ bookId: 'b00001' });
    assert.equal(result.thin, true, '没有要点也没有划线时还报「材料充足」');
    assert.equal(result.sources.chapters, 0);
    assert.equal(result.sources.annotations, 0);
    // 反向对照：有划线就算材料不薄 —— 很多书写完才划线，那时没有解读。
    const { service: another } = boot();
    stubBook(another, { chapters: 0, annotations: 1 });
    assert.equal((await another.reflectionOutline({ bookId: 'b00001' })).thin, false);
  });

  it('书不在书单里 ⇒ BOOK_MISSING（路由回 404）', async () => {
    const { service } = boot();
    service.bookById = async () => null;
    await assert.rejects(() => service.reflectionOutline({ bookId: 'b00009' }), (error) => {
      assert.equal(error.code, 'BOOK_MISSING');
      return true;
    });
  });

  it('非法 bookId ⇒ BAD_BOOK，且**不调模型**', async () => {
    const { service, state } = boot();
    await assert.rejects(() => service.reflectionOutline({ bookId: '../etc/passwd' }), (error) => {
      assert.equal(error.code, 'BAD_BOOK');
      return true;
    });
    assert.equal(state.llmCalls.length, 0, '非法 id 不该花掉一次模型调用');
  });

  it('★ 模型给了半成品 ⇒ 抛 outlineUnusable（路由回 502，让用户再点一次）', async () => {
    const { service } = boot({
      chunks: [{ type: 'text-delta', text: '## 一句话总结\n\n（空）' }, { type: 'finish', reason: { kind: 'ok' } }],
    });
    stubBook(service);
    await assert.rejects(() => service.reflectionOutline({ bookId: 'b00001' }), (error) => {
      assert.equal(error.outlineUnusable, true);
      return true;
    });
  });

  it('解读目录读不出来时，提纲仍然生成（只用划线）', async () => {
    const { service } = boot();
    stubBook(service);
    service.digestStore = {
      readOutline: async () => { throw new Error('目录坏了'); },
      readDigest: async () => null,
    };
    const result = await service.reflectionOutline({ bookId: 'b00001' });
    assert.equal(result.sources.chapters, 0);
    assert.equal(result.sources.annotations, 1);
    assert.equal(result.thin, false);
  });
});
