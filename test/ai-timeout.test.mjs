/**
 * AI 生成的**超时**与**抢占**。
 *
 * ★ 这一组守的是一个「一次失败就把功能永久堵死」的缺陷，而不是「体验差一点」：
 *   `ctx.llm.stream()` 在模型不响应时**永不返回** ⇒ 那条 promise 不 settle
 *   ⇒ `createGenerationGuard` 的 inflight 条目永远删不掉 ⇒ 这一篇的这个类型
 *   **再也不可能重新生成**，只能重启进程。
 *
 * 所以下面两组用例分别钉两道防线，缺一不可：
 *   - `complete()` 的两层超时（静默看门狗 / 整体上限）—— 主防线；
 *   - `createGenerationGuard` 的 `staleMs` 抢占 —— 主防线失效时的第二道保险。
 *
 * ★ 为什么两层而不是一层：真正的故障形态是「一个 chunk 都不来」，那时只做整体上限
 *   要等满 10 分钟才断 —— 用户在这 10 分钟里看到的是一个永远转不完的圈，
 *   而且这一篇锁着。流是逐块回来的，所以「多久没动静」比「总共跑了多久」
 *   早得多地指向故障。反过来只做看门狗也不行：一个一直吐字但永不结束的流
 *   能跑一整天。
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  GENERATION_IDLE_TIMEOUT_MS, GENERATION_STALE_MS, GENERATION_TIMEOUT_MS,
  createGenerationGuard, generateRewrite, generateTranslation,
} from '../src/host/ai.js';
import { createFakeContext } from './helpers/fake-ctx.mjs';

const ARTICLE = { title: 'T', html: '<p>x</p>' };

/** 永远不 settle 的 promise。★ 刻意不带任何 handle —— 它不会拖住事件循环。 */
const never = () => new Promise(() => {});

/**
 * 把「这次调用会 reject」变成一次**有上限**的等待。
 *
 * ★ 这个兜底不是可有可无的：`node --test` **没有**每用例默认超时。如果超时参数
 *   因为回归没被传下去，被测调用会按 10 分钟的默认值去等 —— 整个测试文件就挂住，
 *   而且症状是「一个用例都不输出」（本项目踩过同一个坑，最后被 SIGKILL）。
 *   有了它，同样的回归会变成一条 5 秒内出现、且说得清原因的失败。
 *
 * ★ 这里的计时器**故意不 unref**：它要的正是「把挂住的事件循环拽回来」。
 *   （`src/host/ai.js` 里那个看门狗计时器恰好相反、必须 unref —— 两者目的不同，
 *   别照抄。）
 */
async function rejectionOf(run, { withinMs = 5000 } = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .then(
          (value) => { throw new Error(`预期 reject，实际成功返回了：${JSON.stringify(value)?.slice(0, 160)}`); },
          (error) => error,
        ),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`测试自身超时（${withinMs}ms）：这次调用既没成功也没失败 —— 多半是超时参数没被传下去`)),
          withinMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 `ctx.llm.stream` 换成指定的桩，并把每次调用记进 `state.llmCalls`
 * （与 `createFakeContext` 的 llm 桩同口径，断言写法保持一致）。
 *
 * 注：`createFakeContext` 里 `ctx.llm === services.get('llm')`，改属性两边都看得见。
 */
function useStream(ctx, state, factory) {
  ctx.llm.stream = (request) => {
    state.llmCalls.push(request);
    return factory(request);
  };
}

/**
 * 「一个 chunk 都不来」的流，**照宿主的契约**在 signal 上挂 abort 监听
 * （abort 时像真流那样抛 `AbortError`）。这是宿主正常配合时的形态。
 */
function silentStreamHonoringSignal(request) {
  return (async function* () {
    await new Promise((_, reject) => {
      const signal = request?.signal;
      const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  })();
}

/**
 * 「一个 chunk 都不来」且**完全无视 signal** 的流。
 *
 * ★ 这是本文件最关键的一条桩。宿主到底有没有把我们传的 signal 一路转发给底层的
 *   网络请求，**不在插件的契约里**，我们验不了；而 `for await` 只在拿到下一个
 *   chunk 的时候才有机会回头看 `combined.aborted` —— 一个 chunk 都不来时，
 *   那个 await 会永远挂着。所以超时必须由 `complete()` **自己**兑现
 *   （abort 事件 → reject → 与读流赛跑）。
 *   这条桩一旦变红，就说明超时又退回成「取决于宿主配不配合」——
 *   也就是「10 分钟上限」退化成一个永远不会发生的超时。
 */
function silentStreamIgnoringSignal() {
  return (async function* () {
    await never();
  })();
}

describe('两层超时：模型不响应时必须能自己断掉', () => {
  test('★ 整体上限到点必须中断，并报出「超过 N 秒仍未完成」（可重试）', async () => {
    const { ctx, state } = createFakeContext();
    useStream(ctx, state, silentStreamHonoringSignal);
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, { model: 'p/m', timeoutMs: 1000, idleMs: 600_000 }),
    );
    assert.ok(error instanceof Error, String(error));
    assert.match(error.message, /超过 1 秒仍未完成/);
    assert.match(error.message, /可以重新生成/);
    // 反向对照：这句话里**不能**出现「没有任何输出」—— 那是另一种原因，补救动作不同。
    assert.doesNotMatch(error.message, /没有任何输出/);
  });

  test('★ 宿主**不**转发 signal 时，超时也必须生效（否则 10 分钟上限等于不存在）', async () => {
    const { ctx, state } = createFakeContext();
    useStream(ctx, state, silentStreamIgnoringSignal);
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, { model: 'p/m', timeoutMs: 1000, idleMs: 600_000 }),
      { withinMs: 4000 },
    );
    assert.match(error.message, /超过 1 秒仍未完成/);
  });

  test('★ 静默看门狗：先来了几个 chunk、之后不再出声，也要中断', async () => {
    const { ctx, state } = createFakeContext();
    // 先吐一块，然后**永远沉默**，并且无视 signal —— 看门狗同样必须自己兑现。
    useStream(ctx, state, () => (async function* () {
      yield { type: 'text-delta', text: '# 半截' };
      await never();
    })());
    const error = await rejectionOf(
      () => generateTranslation(ctx, ARTICLE, { model: 'p/m', timeoutMs: 600_000, idleMs: 1000 }),
      { withinMs: 4000 },
    );
    assert.match(error.message, /连续 1 秒没有任何输出/);
    assert.match(error.message, /可以重新生成/);
    assert.doesNotMatch(error.message, /仍未完成/);
  });

  test('★ 三种中断原因必须互相区分（说不清是哪一种 = 用户不知道该怎么办）', async () => {
    const boot = () => {
      const { ctx, state } = createFakeContext();
      useStream(ctx, state, silentStreamIgnoringSignal);
      return ctx;
    };
    // ① 整体上限
    const timedOut = await rejectionOf(
      () => generateTranslation(boot(), ARTICLE, { model: 'p/m', timeoutMs: 60, idleMs: 600_000 }),
    );
    // ② 静默看门狗
    const silent = await rejectionOf(
      () => generateTranslation(boot(), ARTICLE, { model: 'p/m', timeoutMs: 600_000, idleMs: 60 }),
    );
    // ③ 调用方主动取消（用户关掉了面板）—— 不该被报成「超时」
    const caller = await rejectionOf(() => {
      const controller = new AbortController();
      controller.abort();
      return generateTranslation(boot(), ARTICLE, {
        model: 'p/m', signal: controller.signal, timeoutMs: 600_000, idleMs: 600_000,
      });
    });

    assert.match(timedOut.message, /仍未完成/);
    assert.doesNotMatch(timedOut.message, /没有任何输出/);

    assert.match(silent.message, /没有任何输出/);
    assert.doesNotMatch(silent.message, /仍未完成/);

    assert.match(caller.message, /aborted/);
    assert.doesNotMatch(caller.message, /仍未完成|没有任何输出/);
  });

  test('★ 改写入口同样带超时（两个入口共用一套闸门，别只修一个）', async () => {
    const { ctx, state } = createFakeContext();
    useStream(ctx, state, silentStreamIgnoringSignal);
    const error = await rejectionOf(
      () => generateRewrite(ctx, ARTICLE, { model: 'p/m', timeoutMs: 1000, idleMs: 600_000 }),
    );
    assert.match(error.message, /超过 1 秒仍未完成/);
  });

  test('反向对照：正常返回的流不该被任何闸门误伤', async () => {
    const { ctx, state } = createFakeContext({
      llmChunks: [
        { type: 'text-delta', text: '# 译文\n\n正文' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    });
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    assert.equal(result.title, '译文');
    // H1 归 `title`，正文里不再留一份。
    assert.equal(result.markdown, '正文');
    assert.equal(state.llmCalls.length, 1);
    // 至少要把 signal 交给宿主 —— 否则宿主连配合的机会都没有（这时就只剩我们自己
    // 那条赛跑兜底了）。
    assert.ok(state.llmCalls[0].signal, '没有把 signal 传给宿主');
  });

  test('反向对照：模型自己报的错**不**被归一化成超时话术', async () => {
    const { ctx } = createFakeContext({
      llmChunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }],
    });
    const error = await rejectionOf(() => generateTranslation(ctx, ARTICLE, { model: 'p/m' }));
    assert.match(error.message, /model call failed: boom/);
    assert.doesNotMatch(error.message, /仍未完成|没有任何输出|aborted/);
  });

  test('反向对照：模型返回空结果仍然报「empty result」，不报超时', async () => {
    const { ctx } = createFakeContext({
      llmChunks: [{ type: 'text-delta', text: '   \n  ' }, { type: 'finish', reason: { kind: 'stop' } }],
    });
    const error = await rejectionOf(() => generateTranslation(ctx, ARTICLE, { model: 'p/m' }));
    assert.match(error.message, /empty result/);
    assert.doesNotMatch(error.message, /仍未完成|没有任何输出/);
  });
});

describe('生成守卫：同一篇同一个类型同时只跑一个，但**永远**要能重新开始', () => {
  test('★ 第二次调用拿到的是**同一个** promise，而不是并发再跑一次', async () => {
    const guard = createGenerationGuard();
    let release;
    const first = guard('a1', 'translate', () => new Promise((resolve) => { release = resolve; }));
    let secondRan = false;
    const second = guard('a1', 'translate', () => { secondRan = true; return Promise.resolve('second'); });
    assert.equal(second, first, '没有复用 ⇒ 同一篇会被并发生成两次（白花钱、还可能互相覆盖）');
    assert.equal(secondRan, false);
    release('done');
    assert.equal(await first, 'done');
  });

  test('跑完之后必须释放（否则这一篇再也生成不了）', async () => {
    const guard = createGenerationGuard();
    assert.equal(await guard('a2', 'translate', async () => 'one'), 'one');
    let calls = 0;
    assert.equal(await guard('a2', 'translate', async () => { calls += 1; return 'two'; }), 'two');
    assert.equal(calls, 1, '跑完没释放 ⇒ 点第二次生成会拿到上一次的旧结果');
  });

  test('不同 kind 互不阻塞：译文在跑的时候改写照样能开', async () => {
    const guard = createGenerationGuard();
    let release;
    const translating = guard('a3', 'translate', () => new Promise((resolve) => { release = resolve; }));
    const rewritten = guard('a3', 'rewrite', async () => 'rw');
    assert.notEqual(rewritten, translating);
    assert.equal(await rewritten, 'rw');
    release('tr');
    assert.equal(await translating, 'tr');
  });

  test('★ 超过 staleMs 的条目允许被抢占（「永远不释放」的第二道保险）', async () => {
    let clock = 1_000_000;
    const guard = createGenerationGuard({ staleMs: 1000, now: () => clock });
    let calls = 0;
    const hung = guard('a4', 'translate', () => { calls += 1; return never(); });

    // 还没到阈值：仍然复用 —— 这是正常的「正在生成，别重复点」。
    clock += 999;
    assert.equal(guard('a4', 'translate', () => { calls += 1; return Promise.resolve('x'); }), hung);
    assert.equal(calls, 1, '没到阈值就抢占 ⇒ 防重复点击失效，同一篇会并发生成');

    // 越过阈值：允许抢占 —— 这是「模型不响应」时唯一的自救。
    clock += 2;
    const fresh = guard('a4', 'translate', () => { calls += 1; return Promise.resolve('fresh'); });
    assert.notEqual(fresh, hung, '过了阈值还复用 ⇒ 这一篇永久堵死，只能重启进程');
    assert.equal(await fresh, 'fresh');
    assert.equal(calls, 2);
  });

  test('★ 被抢占的旧条目晚到之后，不许把新条目摘掉（否则又退化成可以并发）', async () => {
    let clock = 1_000_000;
    const guard = createGenerationGuard({ staleMs: 1000, now: () => clock });
    let releaseOld;
    const old = guard('a5', 'translate', () => new Promise((resolve) => { releaseOld = resolve; }));

    clock += 2000;
    let releaseNew;
    const fresh = guard('a5', 'translate', () => new Promise((resolve) => { releaseNew = resolve; }));
    assert.notEqual(fresh, old);

    // 旧的终于回来了 —— 真机上就是「宿主的超时比我们晚」那种情形。
    releaseOld('old');
    await old;

    // 再调一次：必须还是**新**那一条。
    const third = guard('a5', 'translate', () => Promise.resolve('third'));
    assert.equal(third, fresh, '被抢占的旧条目把新条目摘掉了 ⇒ 同一篇又能并发两个');
    releaseNew('new');
    assert.equal(await fresh, 'new');
  });

  test('★ 三个常量的相对关系（顺序错了，两道防线会互相拆台）', () => {
    assert.ok(GENERATION_IDLE_TIMEOUT_MS < GENERATION_TIMEOUT_MS,
      '静默看门狗必须比整体上限短得多，否则真正的故障要等满整体上限才断');
    assert.ok(GENERATION_STALE_MS > GENERATION_TIMEOUT_MS,
      '抢占阈值必须**大于**整体上限：超时是主防线，抢占是它失效后的第二道保险');
    assert.ok(GENERATION_TIMEOUT_MS >= 60_000, '翻译/改写是长输出，整体上限不能太短');
  });
});
