/**
 * AI 生成的**重试**与**失败文案**。
 *
 * ★ 背景（2026-10-13 实测自 `/Applications/DeepSeek Harness.app/.../app.asar`）：
 *   宿主**有** `@deepseek-ai/dsh-llm-retry`，默认对 `RATE_LIMIT` / `SERVER` / `TIMEOUT` /
 *   `TRANSPORT` / `EMPTY_RESPONSE` 重试 5 次 —— 但它的文档写明「当调用不经 agent loop、
 *   直接走 `ctx.llm.stream()` 时**跳过它**：这些消费方仍是单次尝试」。
 *   本插件走的正是直连 `ctx.llm.stream()`，所以**它落在宿主重试机制的覆盖范围之外**。
 *   这组用例守的就是「插件自己那一份重试」。
 *
 * ★ 两个方向都要钉住，缺一不可：
 *   - **该重试的要重试**（429 / 5xx / 传输中断 / 空响应）；
 *   - **不该重试的绝不重试** —— `QUOTA`（重试变不出额度）、以及**插件自己的超时**
 *     （那意味着「已经等了很久」，再等一遍只是让用户多等一遍）。
 *   只有前者会得到「重试没用却让用户白等」的实现；只有后者会得到「一次限流就彻底失败」。
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  GENERATION_MAX_ATTEMPTS, RETRYABLE_FAILURE_CODES,
  cancellableSleep, generateRewrite, generateTranslation, retryDelay,
} from '../src/host/ai.js';
import { createFakeContext } from './helpers/fake-ctx.mjs';

const ARTICLE = { title: 'T', html: '<p>x</p>' };

/** 一个「模型自己报的失败」finish chunk。 */
const failureChunk = (code, message) => ({
  type: 'finish',
  reason: { kind: 'error', failure: { message, ...(code === undefined ? {} : { code }) } },
});

const OK_CHUNKS = [
  { type: 'text-delta', text: '# 译文\n\n正文' },
  { type: 'finish', reason: { kind: 'stop' } },
];

/**
 * 前 `failures.length` 次调用各返回一个失败，之后成功。
 * ★ `createFakeContext` 的 `llmChunks` 允许是函数，所以「第一次失败、第二次成功」
 *   这种形态是原生支持的 —— 不需要去改桩。
 */
function flaky(failures) {
  let call = 0;
  return () => {
    const failure = failures[call];
    call += 1;
    return failure === undefined ? OK_CHUNKS : [failure];
  };
}

/** 永远返回同一个失败的桩。 */
const alwaysFails = (code, message) => () => [failureChunk(code, message)];

/**
 * 把 `ctx.llm.stream` 换成指定的桩，并把每次调用记进 `state.llmCalls`
 * （与 ai-timeout.test.mjs 同一套写法；`ctx.llm === services.get('llm')`，改属性两边都看得见）。
 */
function useStream(ctx, state, factory) {
  ctx.llm.stream = (request) => {
    state.llmCalls.push(request);
    return factory(request);
  };
}

/**
 * 永远不 settle 的流（模拟「模型不响应」）。
 *
 * ★ 必须走 `useStream` 注入，**不能**塞进 `createFakeContext` 的 `llmChunks`：
 *   那个桩内部是 `for (const chunk of chunks)`，而 async generator 只有
 *   `Symbol.asyncIterator`、**没有** `Symbol.iterator` ⇒ 直接报
 *   "chunks is not iterable"（本次踩过；症状离原因很远）。
 */
const hangingStream = () => (async function* () { await new Promise(() => {}); })();

/**
 * 把「这次调用会 reject」变成一次**有上限**的等待。
 * ★ `node --test` 没有每用例默认超时；少了这个兜底，一次回归会让整个文件挂住，
 *   症状是「一个用例都不输出」（与 ai-timeout.test.mjs 同一套理由）。
 */
async function rejectionOf(run, { withinMs = 5000 } = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(run).then(
        (value) => { throw new Error(`预期 reject，实际成功返回了：${JSON.stringify(value)?.slice(0, 160)}`); },
        (error) => error,
      ),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`测试自身超时（${withinMs}ms）：既没成功也没失败 —— 多半是重试参数没被传下去`)),
          withinMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 退避等待的桩：立刻返回，但把每次的时长记下来。 */
function recordingSleep(sink) {
  return async (delayMs, signal) => {
    sink.push(delayMs);
    return signal?.aborted ? false : true;
  };
}

describe('重试：该重试的必须重试', () => {
  test('★ 429（RATE_LIMIT）会自动重试 —— 第二次成功就正常返回', async () => {
    const { ctx, state } = createFakeContext({
      llmChunks: flaky([failureChunk('RATE_LIMIT', '429: Rate Limit Exceeded')]),
    });
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m', sleep: async () => true });
    assert.equal(result.title, '译文');
    assert.equal(result.markdown, '正文');
    assert.equal(state.llmCalls.length, 2, '没有重试 ⇒ 用户看到的还是「重新生成失败」，而服务端只是一次限流');
  });

  test('★ 反向对照：把次数上限压到 1（= 本轮之前的行为）就只发一次请求', async () => {
    const { ctx, state } = createFakeContext({
      llmChunks: flaky([failureChunk('RATE_LIMIT', '429')]),
    });
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, { model: 'p/m', maxAttempts: 1, sleep: async () => true }),
    );
    assert.equal(state.llmCalls.length, 1);
    // 反向对照的要点：**同样的桩**在有重试时会成功（上一条用例），没有重试时就失败。
    // 两条用例合起来才证明「重试」是这里唯一的差别。
    assert.match(error.message, /限流/);
  });

  test('★ 连续失败时尝试次数有上限，且文案说得出「已经重试了几次」', async () => {
    const { ctx, state } = createFakeContext({
      llmChunks: alwaysFails('RATE_LIMIT', '429: Rate Limit Exceeded'),
    });
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, { model: 'p/m', sleep: async () => true }),
    );
    assert.equal(state.llmCalls.length, GENERATION_MAX_ATTEMPTS,
      '重试次数与上限不一致 ⇒ 要么白等、要么永远不放弃');
    assert.match(error.message, new RegExp(`已自动重试 ${GENERATION_MAX_ATTEMPTS - 1} 次仍失败`));
  });

  test('退避按指数增长、封顶，抖动不越界（公式与宿主 localDelay 对齐）', () => {
    const fixed = [1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(n, { random: () => 0.5 }));
    assert.deepEqual(fixed, [500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    assert.equal(retryDelay(1, { random: () => 0 }), 450, '对称抖动的下界');
    assert.equal(retryDelay(1, { random: () => 1 }), 550, '对称抖动的上界');
    assert.equal(retryDelay(9, { random: () => 1 }), 10_000, '抖动不得把退避顶出上限');
  });

  test('★ 重试前会真的等一段退避（不是立刻再打一次 —— 那会把限流打得更死）', async () => {
    const slept = [];
    const { ctx } = createFakeContext({
      llmChunks: flaky([failureChunk('RATE_LIMIT', '429'), failureChunk('RATE_LIMIT', '429')]),
    });
    await generateTranslation(ctx, ARTICLE, {
      model: 'p/m', sleep: recordingSleep(slept), random: () => 0.5,
    });
    assert.deepEqual(slept, [500, 1000], '两次重试之间必须退避，且按指数增长');
  });

  test('★ 每一次尝试都要把 signal 交给宿主（否则用户取消不了）', async () => {
    const { ctx, state } = createFakeContext({
      llmChunks: flaky([failureChunk('RATE_LIMIT', '429')]),
    });
    const controller = new AbortController();
    await generateTranslation(ctx, ARTICLE, {
      model: 'p/m', signal: controller.signal, sleep: async () => true,
    });
    assert.equal(state.llmCalls.length, 2);
    assert.ok(state.llmCalls.every((call) => call.signal), '有尝试没带 signal');
  });

  test('改写入口同样带重试（两个入口共用一套闸门，别只修一个）', async () => {
    const { ctx, state } = createFakeContext({
      llmChunks: flaky([failureChunk('SERVER', '500 Internal Server Error')]),
    });
    const result = await generateRewrite(ctx, ARTICLE, { model: 'p/m', sleep: async () => true });
    assert.equal(result.markdown, '正文');
    assert.equal(state.llmCalls.length, 2);
  });
});

describe('重试：不该重试的绝不重试', () => {
  test('★ 配额用尽（QUOTA）不重试 —— 重试变不出额度，只会让用户白等', async () => {
    const { ctx, state } = createFakeContext({
      llmChunks: alwaysFails('QUOTA', 'insufficient balance'),
    });
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, { model: 'p/m', sleep: async () => true }),
    );
    assert.equal(state.llmCalls.length, 1, '对「额度用尽」重试 = 白等 4 次退避');
    assert.match(error.message, /配额/);
    assert.match(error.message, /重试没有用/);
  });

  test('★ 插件自己的整体超时**不**重试（那是「已经等很久了」）', async () => {
    const { ctx, state } = createFakeContext();
    useStream(ctx, state, hangingStream);
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, {
        model: 'p/m', timeoutMs: 60, idleMs: 600_000, sleep: async () => true,
      }),
    );
    assert.equal(state.llmCalls.length, 1, '把超时也重试 ⇒ 用户要多等 5 个 10 分钟');
    assert.match(error.message, /超过 1 秒仍未完成|超过 0 秒仍未完成/);
  });

  test('★ 静默看门狗触发同样不重试', async () => {
    const { ctx, state } = createFakeContext();
    useStream(ctx, state, hangingStream);
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, {
        model: 'p/m', timeoutMs: 600_000, idleMs: 60, sleep: async () => true,
      }),
    );
    assert.equal(state.llmCalls.length, 1);
    assert.match(error.message, /没有任何输出/);
  });

  test('★ 用户取消之后一个字都不再发', async () => {
    const controller = new AbortController();
    const { ctx, state } = createFakeContext({
      llmChunks: alwaysFails('RATE_LIMIT', '429'),
    });
    await rejectionOf(() => generateTranslation(ctx, ARTICLE, {
      model: 'p/m',
      signal: controller.signal,
      // 退避途中用户关掉了面板：等待必须被打断，且不再发下一次请求。
      sleep: async (ms, signal) => { controller.abort(); return cancellableSleep(0, signal); },
    }));
    assert.equal(state.llmCalls.length, 1, '取消之后还发了请求 = 用户白花钱');
  });

  test('反向对照：认不出的失败码不改文案，原始错误照原样透出', async () => {
    const { ctx, state } = createFakeContext({
      llmChunks: alwaysFails(undefined, 'boom'),
    });
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, { model: 'p/m', sleep: async () => true }),
    );
    assert.equal(state.llmCalls.length, 1, '没有 code 就无从判断可不可重试，只能不重试');
    assert.match(error.message, /model call failed: boom/);
  });

  test('★ 可重试集合的边界（写错了就会「重试没用的事」或「放弃能救的事」）', () => {
    for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']) {
      assert.ok(RETRYABLE_FAILURE_CODES.includes(code), `${code} 应该可重试`);
    }
    for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED']) {
      assert.ok(!RETRYABLE_FAILURE_CODES.includes(code), `${code} 不该重试`);
    }
  });
});

describe('失败文案：用户要能读出「发生了什么」和「我该干什么」', () => {
  test('★ 限流：说清是限流、重试过几次、以及补救动作', async () => {
    const { ctx } = createFakeContext({
      llmChunks: alwaysFails('RATE_LIMIT', '429: {"code":429,"message":"Rate Limit Exceeded"}'),
    });
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, { model: 'p/m', sleep: async () => true }),
    );
    assert.match(error.message, /模型服务限流/);
    assert.match(error.message, /换一个模型/, '必须给出补救动作，否则用户不知道下一步做什么');
    // ★ 原始错误要留着：用户截图来问的时候，那一串才是定位用的证据。
    assert.match(error.message, /原始错误：429/);
    // ★ 反向对照：不该再是那句只有开发者看得懂的话术。
    assert.doesNotMatch(error.message, /^dsh-npie-reader: model call failed:/);
  });

  test('★ 凭据无效与上下文超限各自给出**不同**的补救动作', async () => {
    const boot = (code, message) => {
      const { ctx } = createFakeContext({ llmChunks: alwaysFails(code, message) });
      return rejectionOf(() => generateTranslation(ctx, ARTICLE, { model: 'p/m', sleep: async () => true }));
    };
    const auth = await boot('AUTH', '401 Unauthorized');
    const overflow = await boot('CONTEXT_WINDOW_EXCEEDED', 'context length exceeded');

    assert.match(auth.message, /API Key/);
    assert.match(overflow.message, /上下文更长的模型/);
    // 三种失败的补救动作必须互不相同 —— 都写「请稍后重试」等于没说。
    assert.notEqual(auth.message, overflow.message);
  });
});
