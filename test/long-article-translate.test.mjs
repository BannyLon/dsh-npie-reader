/**
 * 长文翻译**端到端**：一篇 17 万字符的文章，到底发几次请求、每次多大、回填是否完整。
 *
 * ---- 为什么这条不能只有 `translate-chunking.test.mjs` ----------------------
 *
 * 那个文件证明的是「`planTranslationChunks` 这个函数按预算切块」「`mergeTranslations`
 * 先到先得」「`generateStructuredTranslation` 会循环」—— 都是**用构造出来的
 * segments** 喂进去的。它答不了用户真正关心的那一问：
 *
 *   「我那篇 17 万字的长文，现在点一下『中文版』，实际会发几次、每次多大？」
 *
 * 中间隔着三段真代码：`sanitizeHtml` → `collectSegments`（真 HTML 切段）→
 * `planTranslationChunks`。任何一段把段数或段长算错（比如把 `<p>` 里带 `<a>`
 * 的那句话切成三段），预算就会失真，而单测全绿。
 *
 * ⇒ 这里喂**真 HTML**、跑**真链路**、量**真 prompt 长度**。
 *
 * ---- 假模型，但不假调用 ---------------------------------------------------
 *
 * `ctx.llm.stream` 是桩：它只做一件事 —— 从 prompt 里把本批的编号抽出来，
 * 原样回一份「[n] 译 n」。这样能验证「编号 → 回填」这条链路真的通，
 * 而**不需要花钱**、也不会因为模型今天心情不好而飘。
 * 真模型那一半（耗时、是否报错、译文质量）只能在真机上点一次，任何测试都替代不了。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateStructuredTranslation } from '../src/host/ai.js';
import {
  buildTranslatePrompt,
  collectSegments,
  planTranslationChunks,
  TRANSLATE_MAX_CHUNKS,
} from '../src/host/structure-translate.js';
import { createFakeContext } from './helpers/fake-ctx.mjs';

/**
 * 造一篇「长度真实」的文章。
 *
 * 41 段 × 约 4,200 字符 ≈ **17.2 万字符** —— 与实测那篇真文章（175,002 字符 / 41 段）
 * 同一量级。刻意让「一段 = 一整段长文」：这正是把「按条数带上文」变成灾难的那个形态
 * （3 条上文 ≈ 12,000 字符）。
 */
function buildLongArticle({ paragraphs = 41, charsPerParagraph = 4200 } = {}) {
  const sentence = 'The committee reviewed the proposal and noted that several assumptions about latency, cost, and operational risk had not yet been validated by measurement. ';
  const parts = [];
  for (let index = 1; index <= paragraphs; index += 1) {
    let body = '';
    while (body.length < charsPerParagraph) body += sentence;
    parts.push(`<p>Paragraph ${index}. ${body.slice(0, charsPerParagraph)}</p>`);
  }
  return `<h1>Long form test article</h1>\n${parts.join('\n')}`;
}

/**
 * 从一条 message 里取出纯文本。
 *
 * ★ `content` 不是字符串，是 `[{ type: 'text', text }]`（见 `ai.js` 的
 *   `createUserMessage`）。第一版直接 `String(message.content)` 得到的是
 *   `[object Object]`，于是桩模型一条编号都抓不到 —— 症状是「prompt 格式变了」，
 *   而真正的原因在测试自己身上。
 */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
  return '';
}

/** 从一次请求里取出「要翻的正文」那一段（有【上文】时从标记之后算）。 */
function bodyOf(request) {
  const user = request.messages
    .filter((message) => message.role === 'user')
    .map(textOf)
    .join('\n');
  const marker = '【正文】';
  return user.includes(marker) ? user.slice(user.lastIndexOf(marker)) : user;
}

/** 桩模型：把本批的编号抽出来，回「[n] 译 n」。 */
function fakeModel(request) {
  const body = bodyOf(request);
  const ids = [...body.matchAll(/^\[(\d+)\] /gm)].map((match) => Number(match[1]));
  assert.ok(ids.length > 0, '桩模型：prompt 里一条编号都没抓到 —— 说明 prompt 格式变了');
  const text = ids.map((id) => `[${id}] 译${id}`).join('\n');
  return [
    { type: 'text-delta', text },
    { type: 'finish', reason: { kind: 'ok' } },
  ];
}

describe('长文翻译端到端：17 万字符不再整篇发一次', () => {
  const html = buildLongArticle();
  const segments = collectSegments(html);
  /** 「整篇一次」会发多大 —— 这就是改之前的实际请求体。 */
  const wholePromptChars = buildTranslatePrompt(segments, {}).length;

  it('文章本身够长（前置条件，不够长这条用例什么也证明不了）', () => {
    assert.ok(html.length > 150_000, `文章只有 ${html.length} 字符，够不到「长文」`);
    assert.ok(segments.length >= 40, `只切出 ${segments.length} 段`);
    assert.ok(wholePromptChars > 150_000, `整篇 prompt 只有 ${wholePromptChars} 字符`);
  });

  it('★ 真跑：批数 > 1，每批都在一万多字符，41 段一条不丢', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: fakeModel });
    const result = await generateStructuredTranslation(ctx, {
      url: 'https://example.org/long-form',
      html,
    }, {});

    const requests = state.llmCalls;
    const sizes = requests.map((request) => bodyOf(request).length);
    const largest = Math.max(...sizes);

    // ① 真的分批了，而且没撞安全阀
    assert.ok(requests.length > 1, `只发了 ${requests.length} 次 —— 等于没分批`);
    assert.ok(
      requests.length <= TRANSLATE_MAX_CHUNKS,
      `发了 ${requests.length} 次，超过安全阀 ${TRANSLATE_MAX_CHUNKS}`,
    );

    // ② 每批都在预算内。上界 = 正文 12,000 + 上文 1,500 + 提示词抬头
    assert.ok(
      largest < 16_000,
      `最大一批 ${largest} 字符（预期 < 16,000）—— 整篇一次是 ${wholePromptChars}`,
    );
    // ③ 这一条才是「彻底修复」的判据：最大一批必须远小于整篇
    assert.ok(
      largest < wholePromptChars / 10,
      `最大一批 ${largest} 字符，仍超过整篇（${wholePromptChars}）的 1/10`,
    );

    // ④ 正文没有被重复发：总字符只比整篇多出「上文重叠」那部分
    const totalChars = sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(
      totalChars < wholePromptChars * 1.3,
      `所有批次合计 ${totalChars} 字符，是整篇（${wholePromptChars}）的 ${(totalChars / wholePromptChars).toFixed(2)} 倍 —— 正文被重复发了`,
    );

    // ⑤ 回填：每一段都换成了译文，一段不剩
    assert.equal(result.coverage.done, segments.length, '覆盖率没有满');
    assert.equal(result.coverage.total, segments.length);
    for (const segment of segments) {
      assert.ok(
        result.html.includes(`译${segment.id}`),
        `第 ${segment.id} 段没被回填（原文保留）`,
      );
    }
    // ⑥ 原文一句都不该留下 —— 只查「有没有译文」会漏掉「译文加进去、原文没删」
    assert.ok(
      !result.html.includes('Paragraph 1. '),
      '第 1 段的英文原文还在 —— 回填成了「追加」而不是「替换」',
    );
  });

  /**
   * 反向对照：把预算放大到「等于不分批」，必须**一次发完**、且那一次超过 15 万字符。
   *
   * ★ 这条对照防的是「分批代码写了但没接上」：把预算改回整篇，如果用例照样绿，
   *   说明上面那些断言量的根本不是分批的结果。
   */
  it('★ 反向对照：预算放到 1e9 ⇒ 一次发完，那一次就是 15 万字符以上', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: fakeModel });
    await generateStructuredTranslation(ctx, {
      url: 'https://example.org/long-form',
      html,
    }, { chunking: { maxChars: 1e9, maxSegments: 1e9 } });

    assert.equal(state.llmCalls.length, 1, '预算放到无限大之后仍然分了批');
    const only = bodyOf(state.llmCalls[0]).length;
    assert.ok(only > 150_000, `那一次只有 ${only} 字符 —— 说明预算根本没起作用`);
  });

  it('分批计划本身与真跑一致（同一份 segments 算两遍，不能有两个答案）', () => {
    const chunks = planTranslationChunks(segments, {});
    const covered = chunks.reduce((sum, chunk) => sum + chunk.segments.length, 0);
    assert.equal(covered, segments.length, '分批计划漏了段');
    assert.deepEqual(
      chunks.flatMap((chunk) => chunk.segments.map((segment) => segment.id)),
      segments.map((segment) => segment.id),
      '分批之后顺序变了',
    );
  });
});
