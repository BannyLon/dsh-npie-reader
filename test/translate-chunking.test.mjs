/**
 * 保结构翻译的**分批**（2026-10-25）。
 *
 * ★ 这一组用例守的是「长文不再整篇一次性发出去」。
 *   改之前这条路径一个字符都不砍：正文入库上限 200,000 字符 ⇒ 一篇 17.5 万字符的
 *   长文会生成 175,278 字符的清单（≈7.3 万 token，实测）。后果分三层：
 *     ① 超过模型单次上下文 ⇒ 直接报错，用户只看到「生成失败」；
 *     ② 没超限但输出太长 ⇒ 模型漏条目，漏掉的保留英文原文 ⇒ 中英混排；
 *     ③ 按字数计费 ⇒ 同一篇的钱是改写路径（恒 32,000 字符）的五倍。
 *
 * ★ 断言的形状值得留意：这里**没有一条**是「源码里出现了 `planTranslationChunks`」。
 *   全部走真代码：纯函数喂真数组，编排层喂假模型（`createFakeContext`）。
 *   因为「函数存在」和「它被真的用上了、且真的把请求切小了」是两件事 ——
 *   本项目记过这条（源码字符串断言会给死代码发合格证）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TRANSLATE_CHUNK_CHARS, TRANSLATE_CONTEXT_CHARS, TRANSLATE_MAX_CHUNKS,
  buildTranslatePrompt, collectSegments, mergeTranslations, planTranslationChunks,
} from '../src/host/structure-translate.js';
import { generateStructuredTranslation } from '../src/host/ai.js';
import { createFakeContext } from './helpers/fake-ctx.mjs';

/** 造一篇足够长的正文：`paragraphs` 段，每段约 `chars` 个字符。
 *  ★ 正文刻意用**英文**：这样「漏翻的段落保留原文」才是个能分辨的断言 ——
 *  用中文夹具的话，翻没翻在结果里长得一样。 */
function longArticle(paragraphs, chars) {
  const body = 'This is a sentence used to stress the chunk planner. '.repeat(Math.ceil(chars / 50)).slice(0, chars);
  return `<article><h1>Long read</h1>${Array.from({ length: paragraphs }, (_, i) => `<p>${i} ${body}</p>`).join('')}</article>`;
}

/** 从一次请求里取出发给模型的正文。 */
const userTextOf = (request) => request.messages.find((m) => m.role === 'user').content[0].text;

/** 把清单里所有 `[编号]` 抓出来（**只看行首**，与 `parseTranslateReply` 的口径一致）。 */
const idsIn = (text) => [...text.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));

/** 假模型：把请求里的每条编号都回一句中文。`failWhen` 返回 true 时回一个不可重试的失败。 */
function echoTranslator(options = {}) {
  const { failWhen = () => false, onCall } = options;
  return (request) => {
    const text = userTextOf(request);
    onCall?.(text);
    if (failWhen(text)) {
      // `QUOTA` 是**不可重试**的失败码 —— 用它才能测「这一批失败后编排层继续跑下一批」，
      // 换成 429 会先走完 5 次重试，用例变成在测重试而不是在测分批。
      return [{ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: '额度不足' } } }];
    }
    const reply = idsIn(text).map((id) => `[${id}] 译文${id}`).join('\n');
    return [{ type: 'text-delta', text: reply }, { type: 'finish', reason: { kind: 'stop' } }];
  };
}

describe('planTranslationChunks：切块', () => {
  it('空清单切出 0 批；单条切出 1 批', () => {
    assert.deepEqual(planTranslationChunks([]), []);
    const one = planTranslationChunks([{ id: 1, text: 'a', group: 1 }]);
    assert.equal(one.length, 1);
    assert.deepEqual(one[0].segments.map((s) => s.id), [1]);
    assert.deepEqual(one[0].context, []);
  });

  it('★ 一条都不许丢、不许重、顺序不许变 —— 丢一条就等于那句话永远不翻', () => {
    const segments = collectSegments(longArticle(40, 200));
    assert.ok(segments.length > 20, '夹具本身要够长，否则这条断言在数空气');
    // 换几组预算各跑一遍：无论怎么切，拼回来必须与原文逐条相同。
    for (const maxChars of [200, 800, 4000, 1_000_000]) {
      const chunks = planTranslationChunks(segments, { maxChars });
      const flat = chunks.flatMap((chunk) => chunk.segments);
      assert.deepEqual(flat.map((s) => s.id), segments.map((s) => s.id), `maxChars=${maxChars} 时清单对不上`);
    }
  });

  it('★ 一段话不许从中间断开（同 group 的几条留在同一批）', () => {
    // 3 段，每段 2 条：预算刚好只够放「一段零一条」—— 那正是最容易切错的位置。
    const segments = [
      { id: 1, text: 'a'.repeat(40), group: 1 },
      { id: 2, text: 'b'.repeat(40), group: 1 },
      { id: 3, text: 'c'.repeat(40), group: 2 },
      { id: 4, text: 'd'.repeat(40), group: 2 },
      { id: 5, text: 'e'.repeat(40), group: 3 },
      { id: 6, text: 'f'.repeat(40), group: 3 },
    ];
    const chunks = planTranslationChunks(segments, { maxChars: 60 });
    const groupOf = new Map(segments.map((s) => [s.id, s.group]));
    for (const chunk of chunks) {
      const groups = new Set(chunk.segments.map((s) => groupOf.get(s.id)));
      // 每一批里同一个 group 只能整段出现 —— 也就是说，不存在「某 group 的一半在这批」。
      for (const group of groups) {
        const whole = segments.filter((s) => s.group === group).map((s) => s.id);
        const here = chunk.segments.filter((s) => s.group === group).map((s) => s.id);
        assert.deepEqual(here, whole, `第 ${group} 段被切开了`);
      }
    }
    assert.ok(chunks.length > 1, '预算压得这么低还只切出 1 批，说明切块根本没生效');
  });

  it('★ 单段本身就超预算时，到硬上限必须断（不许一个块顶满整篇）', () => {
    // 一段 20 条、每条 500 字 = 一万字，全在同一 group 里。
    const segments = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, text: 'x'.repeat(500), group: 1 }));
    const chunks = planTranslationChunks(segments, { maxChars: 2000 });
    assert.ok(chunks.length > 1, '同一段超预算也必须能切开，否则它就是一个无限长的块');
    assert.equal(chunks.flatMap((c) => c.segments).length, 20);
  });

  it('条数预算也生效（字符预算管不住「一万个短句」）', () => {
    const segments = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, text: '短', group: i + 1 }));
    const chunks = planTranslationChunks(segments, { maxChars: 1_000_000, maxSegments: 7 });
    assert.ok(chunks.every((chunk) => chunk.segments.length <= 7), '条数预算没生效');
    assert.equal(chunks.flatMap((c) => c.segments).length, 30);
  });

  it('★ 每批带上批的最后几条作为上文，且上文只有文字、没有编号', () => {
    const segments = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, text: `第${i + 1}条`, group: i + 1 }));
    const chunks = planTranslationChunks(segments, { maxChars: 100, contextSegments: 2 });
    assert.ok(chunks.length >= 2, '预算这么低还没切开，这条用例测不到任何东西');
    assert.deepEqual(chunks[0].context, [], '第一批没有上文');
    // ★ 断「上文 = 上一批的末尾 N 条」，**不写死具体是哪几条** ——
    //   写死等于把「一批能装几条」这个预算细节抄进断言里，改预算就会假红。
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1].segments;
      assert.deepEqual(
        chunks[index].context.map((item) => item.text),
        previous.slice(-2).map((segment) => segment.text),
        `第 ${index + 1} 批的上文接错了`,
      );
    }
    // ★ 上文条目**不能带 id**：带上编号模型就会去翻它，回填时把别处的译文顶掉。
    for (const chunk of chunks) for (const item of chunk.context) assert.deepEqual(Object.keys(item), ['text']);
  });

  it('★ 上文有字符上限：一条就是整段时，不许把上文带成和正文一样长', () => {
    // 每条 5000 字符 —— 真实长文里「一条 = 一整段」很常见（实测 4000+ 字/段）。
    const segments = [
      { id: 1, text: 'x'.repeat(5000), group: 1 },
      { id: 2, text: 'y'.repeat(5000), group: 2 },
      { id: 3, text: 'z'.repeat(5000), group: 3 },
    ];
    const chunks = planTranslationChunks(segments, { maxChars: 6000 });
    assert.ok(chunks.length >= 2, '预算 6000、每条 5000，必须切开');
    for (const chunk of chunks) {
      const chars = chunk.context.reduce((sum, item) => sum + item.text.length, 0);
      assert.ok(chars <= TRANSLATE_CONTEXT_CHARS, `上文 ${chars} 字符，超过上限 ${TRANSLATE_CONTEXT_CHARS}`);
    }
    /*
     * ★ 反向对照：只按**条数**带上文（这正是第一版的做法）时，上文就是整整 5000 字符。
     *   实测过的症状：一篇 17.5 万字符的长文，每批正文 12,024 字符、上文 12,072 字符 ——
     *   预算凭空翻倍，分批的意义少了一半。所以这条上限必须钉住。
     */
    const lastOfFirst = chunks[0].segments[chunks[0].segments.length - 1];
    assert.ok(
      lastOfFirst.text.length > TRANSLATE_CONTEXT_CHARS,
      '对照侧的那一条居然没超上限，那这条断言抓不住任何东西',
    );
  });

  it('批数有安全阀（正文上限调大时不至于发出上百次调用）', () => {
    const segments = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, text: 'x'.repeat(100), group: i + 1 }));
    const chunks = planTranslationChunks(segments, { maxChars: 200 });
    assert.ok(chunks.length <= TRANSLATE_MAX_CHUNKS, `切出了 ${chunks.length} 批，超过安全阀`);
  });

  it('★ 反向对照：按字符硬切的实现会把一段话切开 —— 这条断言有牙', () => {
    const segments = [
      { id: 1, text: 'a'.repeat(40), group: 1 },
      { id: 2, text: 'b'.repeat(40), group: 1 },
      { id: 3, text: 'c'.repeat(40), group: 2 },
      { id: 4, text: 'd'.repeat(40), group: 2 },
    ];
    /** 坏实现：只看字符数，不看 group —— 这正是「写得看起来对」的那种。 */
    const naive = (list, maxChars) => {
      const out = [];
      let current = [];
      let size = 0;
      for (const segment of list) {
        if (size >= maxChars && current.length > 0) { out.push(current); current = []; size = 0; }
        current.push(segment);
        size += segment.text.length + 12;
      }
      if (current.length > 0) out.push(current);
      return out;
    };
    /** 两边的形状不一样（坏实现是「数组的数组」，真的是「{segments}」）—— 先归一。 */
    const asLists = (chunks) => chunks.map((chunk) => (Array.isArray(chunk) ? chunk : chunk.segments));
    const split = (chunks) => asLists(chunks).some((list) => {
      const groups = new Set(list.map((s) => s.group));
      return [...groups].some((group) => list.filter((s) => s.group === group).length
        !== segments.filter((s) => s.group === group).length);
    });
    // 预算取 50：每条带编号约 52 字符，于是「放一条就超了」—— 坏实现每批只装得下
    // 一条，第 1 段的两条必然被劈到两批里。取 60 的话每批恰好装两条，坏实现也
    // 不会切开，对照就成了摆设（这次就是这么发现的）。
    assert.equal(split(naive(segments, 50)), true, '坏实现居然没切开，那上面那条断言就抓不住任何东西');
    assert.equal(split(planTranslationChunks(segments, { maxChars: 50 })), false);
  });
});

describe('buildTranslatePrompt：上文块', () => {
  it('不带上文时输出与以前逐字相同（回归）', () => {
    const prompt = buildTranslatePrompt(collectSegments('<p>a</p><p>b</p>'));
    assert.equal(prompt, '[1] a\n\n[2] b');
  });

  it('★ 上文块里不许出现任何 `[编号]`', () => {
    const segments = collectSegments('<p>a</p><p>b</p>');
    const prompt = buildTranslatePrompt(segments, { context: [{ text: '这是上一批的原文' }] });
    assert.ok(prompt.includes('这是上一批的原文'));
    assert.ok(prompt.includes('不要翻译它'), '没有明确禁止翻译上文');
    // 整段 prompt 里的编号只能来自正文那两条。
    assert.deepEqual(idsIn(prompt), segments.map((s) => s.id));
  });

  it('正文部分仍逐字是 `[编号] 原文`', () => {
    const segments = collectSegments('<p>a</p><p>b</p>');
    const prompt = buildTranslatePrompt(segments, { context: [{ text: '上文' }] });
    assert.ok(prompt.endsWith('[1] a\n\n[2] b'), prompt);
  });
});

describe('mergeTranslations：合并', () => {
  it('先到先得：后来的同号译文不覆盖已经有的', () => {
    const target = new Map([[1, '第一']]);
    mergeTranslations(target, new Map([[1, '被污染的第一'], [2, '第二']]));
    assert.equal(target.get(1), '第一');
    assert.equal(target.get(2), '第二');
  });

  it('★ 只收属于本批的编号（上文被模型擅自翻译时它会复用上一批的编号）', () => {
    const target = new Map([[1, '第一'], [2, '第二']]);
    mergeTranslations(target, new Map([[1, '重复'], [3, '第三']]), new Set([3]));
    assert.equal(target.get(1), '第一', '不属于本批的编号必须被丢弃');
    assert.equal(target.get(3), '第三');
  });

  it('空译文与非字符串一律丢弃', () => {
    const target = new Map();
    mergeTranslations(target, new Map([[1, ''], [2, '   '], [3, null], [4, 'ok']]));
    assert.deepEqual([...target.keys()], [4]);
  });
});

describe('generateStructuredTranslation：真跑（假模型）', () => {
  const boot = (llmChunks) => {
    const { ctx, state } = createFakeContext({ llmChunks });
    return { ctx, state };
  };

  it('★ 长文必须被切成多批，而且每一批的正文都远小于整篇', async () => {
    const article = { title: '长文', url: 'https://example.org/long', html: longArticle(120, 800) };
    const bodies = [];
    const { ctx, state } = boot(echoTranslator({ onCall: (text) => bodies.push(text.length) }));
    const result = await generateStructuredTranslation(ctx, article, {});

    assert.ok(bodies.length >= 3, `只发了 ${bodies.length} 次请求，分批没生效`);
    assert.equal(state.llmCalls.length, bodies.length);
    // 每一批都必须在预算量级内 —— 这是「不会超上下文」的直接证据。
    assert.ok(Math.max(...bodies) < TRANSLATE_CHUNK_CHARS * 2.2, `最大一批 ${Math.max(...bodies)} 字符，超预算了`);
    // 反过来：整篇的字数远大于单批预算，否则上面那条断言毫无意义。
    //   ★ 量 `article.html` 而不是 `result.markdown`：假模型把每条都换成「译文N」，
    //   译文的长度和原文没关系 —— 拿它当规模证据等于在数自己造的字面量。
    assert.ok(article.html.length > TRANSLATE_CHUNK_CHARS * 3, '夹具不够长，测不出分批');
    assert.equal(result.coverage.ratio, 1, '所有批都成功了，覆盖率必须是 100%');
    assert.equal(result.chunks, bodies.length);
  });

  it('★ 反向对照：不分批时单次请求就是整篇 —— 证明「分批」这个动作真的在起作用', async () => {
    const article = { title: '长文', url: 'https://example.org/long', html: longArticle(120, 800) };
    const bodies = [];
    const { ctx } = boot(echoTranslator({ onCall: (text) => bodies.push(text.length) }));
    await generateStructuredTranslation(ctx, article, { chunking: { maxChars: 1e9, maxSegments: 1e9 } });
    assert.equal(bodies.length, 1, '预算放到无限大就该只有一次请求');
    assert.ok(bodies[0] > TRANSLATE_CHUNK_CHARS * 3, '不分批时正文必须远大于预算 —— 否则这个对照说明不了任何事');
  });

  it('★ 某一批失败 ⇒ 其他批照常，覆盖率如实变小，但**不抛错**', async () => {
    const article = { title: '长文', url: 'https://example.org/long', html: longArticle(60, 800) };
    let call = 0;
    const { ctx } = boot(echoTranslator({
      failWhen: () => { call += 1; return call === 2; },
    }));
    const result = await generateStructuredTranslation(ctx, article, {});
    assert.ok(result.chunks >= 3, '至少要三批才能测「中间一批坏掉」');
    assert.ok(result.coverage.ratio < 1, '有一批失败了，覆盖率必须小于 1');
    assert.ok(result.coverage.ratio > 0, '其他批成功了，覆盖率不能是 0');
    // 没翻的那几条**必须是原文**（不是空、也不是乱码）—— 这是「安全底线」那一条。
    assert.ok(result.html.includes('This is a sentence used to stress'), '漏翻的段落应该保留英文原文');
  });

  it('★ 第一批就失败 ⇒ 立刻抛错，且**不再发后面的请求**（省掉一串注定失败的调用）', async () => {
    const article = { title: '长文', url: 'https://example.org/long', html: longArticle(60, 800) };
    const { ctx, state } = boot(echoTranslator({ failWhen: () => true }));
    await assert.rejects(() => generateStructuredTranslation(ctx, article, {}), /额度不足|翻译/);
    assert.equal(state.llmCalls.length, 1, `第一批失败后还发了 ${state.llmCalls.length} 次请求`);
  });

  it('★ 一条都没翻出来 ⇒ 抛错，绝不返回「全是英文的译文」当成功', async () => {
    const article = { title: 'T', url: 'https://example.org/a', html: '<p>Hello world</p><p>Second line</p>' };
    // 模型有输出，但一条编号都不带（等于什么都没翻）。
    const { ctx } = boot(() => [{ type: 'text-delta', text: '抱歉，我无法完成。' }, { type: 'finish', reason: { kind: 'stop' } }]);
    await assert.rejects(() => generateStructuredTranslation(ctx, article, {}), /一条都没翻/);
  });

  it('取消之后一条请求都不再发', async () => {
    const article = { title: '长文', url: 'https://example.org/long', html: longArticle(60, 800) };
    const controller = new AbortController();
    controller.abort();
    const { ctx, state } = boot(echoTranslator());
    await assert.rejects(() => generateStructuredTranslation(ctx, article, { signal: controller.signal }), /aborted/);
    assert.equal(state.llmCalls.length, 0);
  });
});
