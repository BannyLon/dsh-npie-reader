/**
 * `generateChapterDigest` 的行为断言（用假 ctx 真跑一遍生成流程）。
 *
 * ★ 这里测的不是「模型写得好不好」（那测不了），而是**外层那几件事**：
 *   - 第一次就被判照抄时，会不会带着具体数字重试一次；
 *   - 两次都不行时，抛的错能不能让上层区分「照抄」和「网络挂了」；
 *   - 取消能不能真的打断（面板上那个「停止」按钮）。
 *   这三件全是**代码的责任**，而且全都能在没有真模型的情况下测。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateChapterDigest } from '../src/host/ai.js';
import { COPY_RUN_LIMIT } from '../src/host/digest-prompt.js';
import { createFakeContext } from './helpers/fake-ctx.mjs';

const BASE = '分布式系统的一致性问题是工程实践里最容易被低估的部分，它同时牵涉到时钟、网络分区与故障检测三件事。';
const SOURCE = BASE.repeat(30);

/** 一段合法但「完全自述」的解读 JSON。 */
const GOOD_JSON = JSON.stringify({
  summary: '作者把一致性问题拆成三条互相纠缠的线索，并指出多数线上事故源于把三者混为一谈。',
  points: ['先分清是哪一类不一致', '再决定用什么工具'],
  terms: [{ term: '一致性', note: '本章指多副本之间的可见顺序' }],
});

/** 一段「照抄原文」的解读 JSON。 */
const COPIED_JSON = JSON.stringify({ summary: SOURCE.slice(0, 400), points: [], terms: [] });

const chunksOf = (text) => [
  { type: 'text-delta', text },
  { type: 'finish', reason: { kind: 'stop' } },
];

/** 按调用次序返回不同输出的桩；`llmChunks` 允许是函数（见 fake-ctx）。 */
function staged(outputs) {
  let call = 0;
  return () => {
    const next = outputs[Math.min(call, outputs.length - 1)];
    call += 1;
    return chunksOf(next);
  };
}

const chapter = { bookTitle: '分布式系统', chapterTitle: '一致性问题', chapterN: 3, text: SOURCE };

describe('generateChapterDigest：一次成功', () => {
  it('第一次就合格 ⇒ attempts=1，只调一次模型', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: () => chunksOf(GOOD_JSON) });
    const result = await generateChapterDigest(ctx, chapter);
    assert.equal(result.attempts, 1);
    assert.equal(state.llmCalls.length, 1);
    assert.match(result.summary, /三条互相纠缠的线索/);
    assert.equal(result.points.length, 2);
    assert.equal(result.format, 'json');
  });

  it('结果里带上判据的两个数字（界面上「重合 3%」那句话的数据源）', async () => {
    const { ctx } = createFakeContext({ llmChunks: () => chunksOf(GOOD_JSON) });
    const result = await generateChapterDigest(ctx, chapter);
    assert.equal(typeof result.overlap, 'number');
    assert.equal(typeof result.longestRun, 'number');
    assert.ok(result.longestRun < COPY_RUN_LIMIT);
    assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('喂进去的是「书名 + 章名 + 正文」三件东西', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: () => chunksOf(GOOD_JSON) });
    await generateChapterDigest(ctx, chapter);
    const sent = JSON.stringify(state.llmCalls[0].messages);
    assert.match(sent, /分布式系统/);
    assert.match(sent, /一致性问题/);
    assert.match(sent, /不可信引用材料/);
  });
});

describe('generateChapterDigest：抄原文时重试', () => {
  it('★ 第一次照抄、第二次合格 ⇒ attempts=2，且**第二次的提示里带着具体数字**', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: staged([COPIED_JSON, GOOD_JSON]) });
    const result = await generateChapterDigest(ctx, chapter);

    assert.equal(result.attempts, 2);
    assert.equal(state.llmCalls.length, 2);

    const firstSystem = JSON.stringify(state.llmCalls[0].messages);
    const secondSystem = JSON.stringify(state.llmCalls[1].messages);
    assert.equal(/被判为照抄原文/.test(firstSystem), false, '第一次的提示里不该有「照抄」这句');
    assert.match(secondSystem, /被判为照抄原文/);
    // 「只说别抄」模型会以为自己在改写 —— 必须报出连续多少字。
    assert.match(secondSystem, /个字与原文连续相同/);
  });

  it('★★ 两次都照抄 ⇒ 抛错，且能被上层识别成「照抄」而不是网络故障', async () => {
    // 上层要按这个标记决定「重试」还是「换提示词」：照抄重试没用，网络抖值得重试。
    const { ctx, state } = createFakeContext({ llmChunks: staged([COPIED_JSON]) });
    await assert.rejects(
      () => generateChapterDigest(ctx, chapter),
      (error) => {
        assert.equal(error.digestCopied, true);
        assert.ok(error.judgement.longestRun >= COPY_RUN_LIMIT);
        assert.match(error.message, /照抄/);
        return true;
      },
    );
    assert.equal(state.llmCalls.length, 2, '只该重试一次，不该无限循环烧钱');
  });
});

describe('generateChapterDigest：坏输出与取消', () => {
  it('模型吐空 ⇒ 抛错（不会把空字符串当成解读收下）', async () => {
    const { ctx } = createFakeContext({ llmChunks: () => chunksOf('   ') });
    await assert.rejects(() => generateChapterDigest(ctx, chapter));
  });

  it('空壳 JSON ⇒ 抛错，且不会把花括号当成摘要显示', async () => {
    const { ctx } = createFakeContext({ llmChunks: () => chunksOf('{"summary":"","points":[],"terms":[]}') });
    await assert.rejects(
      () => generateChapterDigest(ctx, chapter),
      (error) => {
        assert.equal(String(error.message).includes('{'), false, `错误信息里不该出现 JSON：${error.message}`);
        return true;
      },
    );
  });

  it('★ 传进来的 signal 已经 aborted ⇒ 立刻抛错，不发出请求', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: () => chunksOf(GOOD_JSON) });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => generateChapterDigest(ctx, chapter, { signal: controller.signal }));
    assert.equal(state.llmCalls.length, 0);
  });

  it('指定的模型会传到 ctx.llm.stream 上（不是永远走默认模型）', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: () => chunksOf(GOOD_JSON) });
    await generateChapterDigest(ctx, chapter, { model: 'test-provider/cheap-model' });
    assert.match(JSON.stringify(state.llmCalls[0]), /cheap-model/);
  });
});
