/**
 * 整本预翻的排期、进度与剩余时间。
 *
 * 这个文件钉的是四件**不会自己叫**的事：
 *   1. 分母是「有可翻文字的节」，不是全书节数 —— 算错时进度条永远停在 97%，
 *      旁边写着「还剩 1 节」，而那一节根本不需要翻；
 *   2. 失败的节**不算进度** —— 算进去的话进度条跑到 100%，而书里还缺两节，
 *      用户会把「100%」当成「都能看了」；
 *   3. 停止**不是失败** —— 混进去就会显示「译了 6 节、失败 1 节」，
 *      而他明明只是不想继续了；
 *   4. **同一本书只跑一份、不同书可以并行但不超上限**（0.61.0 改）—— 同一本书
 *      两份并行会重复计费，后写的还会覆盖前写的译文；不同书并行是用户明确要的
 *      （「多本书可以同时进行翻译」），上限见 `DEFAULT_MAX_CONCURRENT`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  createPrefetchRunner, estimateEtaSeconds, etaText, planPrefetch, prefetchPercent,
} from '../src/host/ebook/prefetch.js';

/** 造一节：只给 `blocks`，`planPrefetch` 不关心别的字段。 */
const section = (title, ...texts) => ({ title, chars: texts.join('').length, blocks: texts.map(x => ({ k: 'p', x })) });

/** 一节里**没有**可翻文字（纯中文 / 只有代码）。 */
const chineseSection = (title) => ({ title, chars: 8, blocks: [{ k: 'p', x: '这一节本来就是中文写的正文。' }] });
const codeSection = (title) => ({ title, chars: 8, blocks: [{ k: 'pre', x: 'const a = 1;' }] });

const ebookOf = (sections) => ({ sections });
const book = (id = 'b1') => ({ id, title: 'A Book', ext: 'epub', size: 1 });

/** 轮询到条件成立，避免测试里写死 sleep 时长（那是 flaky 的常见来源）。 */
async function until(check, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('until: 超时');
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

describe('排期：哪些节要翻', () => {
  it('纯中文节、只有代码的节不进分母，也不算「没译完」', () => {
    const plan = planPrefetch(ebookOf([
      section('一', 'It was a bright cold day.'),
      chineseSection('二'),
      codeSection('三'),
      section('四', 'The clocks were striking thirteen.'),
    ]), []);
    assert.equal(plan.total, 2);
    assert.deepEqual(plan.translatable, [1, 4]);
    assert.deepEqual(plan.skipped, [2, 3]);
    assert.deepEqual(plan.targets, [1, 4]);
    assert.equal(plan.cached, 0);
  });

  it('★ 已译的节不重复翻，但仍算进分母（进度从 50% 开始，而不是 0%）', () => {
    const plan = planPrefetch(ebookOf([
      section('一', 'One.'), section('二', 'Two.'), section('三', 'Three.'), section('四', 'Four.'),
    ]), [1, 2]);
    assert.equal(plan.total, 4);
    assert.deepEqual(plan.targets, [3, 4]);
    assert.equal(plan.cached, 2);
    assert.equal(prefetchPercent(plan.total, plan.cached), 0.5);
  });

  it('缓存里有的节号若已不是「可翻节」（换书 / 重新分节），不算进度', () => {
    // 盘上记着第 2 节译过，但这一版第 2 节是中文 —— 那条缓存已经失效。
    const plan = planPrefetch(ebookOf([section('一', 'One.'), chineseSection('二')]), [2]);
    assert.equal(plan.total, 1);
    assert.equal(plan.cached, 0);
    assert.deepEqual(plan.targets, [1]);
  });

  it('整本没有可翻的节：total 0，targets 空', () => {
    const plan = planPrefetch(ebookOf([chineseSection('一')]), []);
    assert.equal(plan.total, 0);
    assert.deepEqual(plan.targets, []);
  });

  it('没有 sections 也不炸（坏缓存 / 空文件）', () => {
    assert.equal(planPrefetch({}, []).total, 0);
    assert.equal(planPrefetch(null, []).total, 0);
  });
});

describe('进度与剩余时间', () => {
  it('进度夹在 0…1，分母为 0 时算 1（没有可翻的节 = 已经「全译完」）', () => {
    assert.equal(prefetchPercent(4, 1), 0.25);
    assert.equal(prefetchPercent(4, 9), 1);
    assert.equal(prefetchPercent(0, 0), 1);
    assert.equal(prefetchPercent(4, 0, 0.5), 0.125);
  });

  it('没有实测样本时不给剩余时间（「不知道」比「0 分钟」诚实）', () => {
    assert.equal(estimateEtaSeconds([], 5), null);
    assert.equal(estimateEtaSeconds([1000], 0), null);
  });

  it('★ 用最近 5 节的平均值：冷启动那几节会拉高整本平均，让「还剩 3 小时」一路虚高', () => {
    // 前两节各 100 秒（冷启动），后面稳定在 10 秒。还剩 10 节。
    const eta = estimateEtaSeconds([100_000, 100_000, 10_000, 10_000, 10_000, 10_000, 10_000], 10);
    assert.equal(eta, 100);   // 最近 5 节各 10 秒 × 10 节 = 100 秒，不是被 100 秒那两节拉成 3 倍
  });

  it('★ 单位：样本是毫秒、返回是秒（0.63.0 显示成 1858.8 小时的根因）', () => {
    /*
     * 用户原话（截图里那行是「正在翻译 · 19% · 还剩约 1858.8 小时 · 382 KB」）：
     * 「还剩约 1858.8 小时？这对吗？这谁还会翻译，一天 24 小时，这个时间谁受的了」
     *
     * 1858.8 / 1000 = 1.86 小时 —— 正好放大 1000 倍，就是「毫秒当秒」。
     * 这条断言用**真实量级**兜住它：一节 5 分钟、还剩 36 节，是 3 小时，不是 3000 小时。
     */
    const fiveMinutes = 5 * 60 * 1000;
    const eta = estimateEtaSeconds([fiveMinutes, fiveMinutes, fiveMinutes], 36);
    assert.equal(eta, 36 * 300, '36 节 × 300 秒 = 10800 秒');
    assert.equal(etaText(eta), '还剩约 3 小时');
    assert.ok(eta < 24 * 3600, '一本正常长篇的 ETA 不该超过一天；超了就是单位又错了');
  });

  it('剩余时间的人话：分档与参考实现一致', () => {
    assert.equal(etaText(10), '马上完成');
    assert.equal(etaText(44), '马上完成');
    assert.equal(etaText(90), '还剩约 2 分钟');
    assert.equal(etaText(3540), '还剩约 59 分钟');
    assert.equal(etaText(3 * 3600), '还剩约 3 小时');
    assert.equal(etaText(4.3 * 3600), '还剩约 4.3 小时');
    assert.equal(etaText(-1), '');
  });
});

describe('调度：一次跑一本，可停，单节失败不拖垮整本', () => {
  const twoSections = () => ebookOf([section('一', 'One.'), section('二', 'Two.')]);

  /**
   * ★ 假磁盘必须**跟着写**：真实实现里进度是问磁盘的（`listSections`），
   *   一个永远返回空数组的假磁盘会让「跑完之后 progress 应该是 100%」这类断言
   *   全部落空 —— 而那不是实现的错，是夹具不像。译成一节就记一节。
   */
  function runnerFor({ sections, translated = [], translate, maxConcurrent }) {
    // ★ 每本书**一份**磁盘集合：0.61.0 起两本可以同时在跑，共用一份的话
    //   「b1 译完了第 1 节」会被算进 b2 的缓存，测试会绿在一个错的事实上。
    const disks = new Map();
    const diskOf = (id) => {
      const key = String(id ?? '');
      if (!disks.has(key)) disks.set(key, new Set(translated.map(Number)));
      return disks.get(key);
    };
    return createPrefetchRunner({
      resolveEbook: async () => sections,
      // ★ 夹具把 `ebook` 丢掉：这一组测的是「翻了几节、停没停住」，不看解析结果。
      //   「ebook 真的传下去了」单独有一条断言（见本文件最后一组）。
      translateSection: async (target, _ebook, n, options) => {
        const result = await translate(target, n, options);
        diskOf(target?.id).add(n);
        return result;
      },
      translatedSections: async (bookId) => [...diskOf(bookId)],
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    });
  }

  it('依次翻完所有待翻节，最后是 done / 100%', async () => {
    const called = [];
    const runner = runnerFor({
      sections: twoSections(),
      translate: async (_book, n, options) => {
        called.push(n);
        options.onChunk?.({ index: 0, total: 1 });
        return { n };
      },
    });
    await runner.start(book());
    const done = await until(async () => {
      const status = await runner.status(book());
      return status.state === 'done' ? status : null;
    });
    assert.deepEqual(called, [1, 2]);
    assert.equal(done.translated, 2);
    assert.equal(done.percent, 1);
    assert.equal(done.failed, 0);
  });

  it('已译的节不再请求模型', async () => {
    const called = [];
    const runner = runnerFor({
      sections: twoSections(),
      translated: [1],
      translate: async (_book, n) => { called.push(n); return { n }; },
    });
    await runner.start(book());
    await until(async () => (await runner.status(book())).state === 'done');
    assert.deepEqual(called, [2]);
  });

  it('★ 同一本书再点一次「整本」不会开第二个任务', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runner = runnerFor({
      sections: twoSections(),
      translate: async () => { calls += 1; await gate; return {}; },
    });
    const first = await runner.start(book());
    const second = await runner.start(book());
    assert.equal(first.state, 'running');
    assert.equal(second.state, 'running');
    assert.equal(calls, 1);
    release();
    await until(async () => (await runner.status(book())).state === 'done');
  });

  it('★ 两本书可以同时翻（0.61.0）：各自推进，不排队', async () => {
    const calls = [];
    const waiters = [];
    let open = false;
    const runner = runnerFor({
      sections: twoSections(),
      translate: async (target, n) => {
        calls.push(`${target.id}:${n}`);
        // 第一拍全部挂住：两本书**同时**各有一个节在飞，才说明它们真的并行。
        if (!open) await new Promise((resolve) => { waiters.push(resolve); });
        return { n };
      },
    });
    await runner.start(book('b1'));
    await runner.start(book('b2'));
    await until(() => calls.length === 2);
    assert.deepEqual([...calls].sort(), ['b1:1', 'b2:1']);
    open = true;
    for (const release of waiters.splice(0)) release();
    await until(async () => {
      const [a, b] = [await runner.status(book('b1')), await runner.status(book('b2'))];
      return a.state === 'done' && b.state === 'done';
    });
  });

  it('★ 超过并行上限就明确拒绝，不偷偷排队（默认 4 本，测里改成 1）', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runner = runnerFor({
      sections: twoSections(),
      translate: async () => { await gate; return {}; },
      maxConcurrent: 1,
    });
    await runner.start(book('b1'));
    await assert.rejects(
      () => runner.start(book('b2')),
      (error) => error.code === 'EBOOK_PREFETCH_BUSY' && error.limit === 1,
    );
    release();
    await until(async () => (await runner.status(book('b1'))).state === 'done');
  });

  it('★ 停止不是失败：state=stopped，已译的节留着，当前节不计入 failed', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const runner = runnerFor({
      sections: twoSections(),
      translate: async (_book, n, options) => {
        calls += 1;
        if (n === 2) { await gate; }
        if (options.signal?.aborted) throw new Error('aborted');
        return { n };
      },
    });
    await runner.start(book());
    await until(async () => (await runner.status(book())).current !== null);
    assert.deepEqual(runner.stop('b1'), { stopped: true });
    release();
    const stopped = await until(async () => {
      const status = await runner.status(book());
      return status.state === 'stopped' ? status : null;
    });
    assert.equal(stopped.failed, 0);
    assert.equal(stopped.translated, 1);
    assert.equal(stopped.percent, 0.5);
    assert.equal(calls, 2);
    // 再停一次不算错，也不该把状态改回去。
    assert.deepEqual(runner.stop('b1'), { stopped: false });
  });

  it('单节失败继续跑完，失败的节**不算进度**', async () => {
    const runner = runnerFor({
      sections: ebookOf([section('一', 'One.'), section('二', 'Two.'), section('三', 'Three.')]),
      translate: async (_book, n) => {
        if (n === 2) throw new Error('429');
        return { n };
      },
    });
    await runner.start(book());
    const status = await until(async () => {
      const value = await runner.status(book());
      // ★ 0.64.0：有节没成时终态是 `partial`，不再是 `done` ——
      //   否则界面会一边说「已译完」一边画一条 67% 的进度条。
      return value.state === 'partial' ? value : null;
    });
    assert.equal(status.translated, 2);
    assert.equal(status.failed, 1);
    assert.deepEqual(status.failedSections, [2]);
    // 2/3：进度条停在 67%，而不是假装 100%。
    assert.equal(Math.round(status.percent * 100), 67);
  });

  it('每一节都带上 signal 与 onChunk（停止与节内进度都靠它们）', async () => {
    const seen = [];
    const runner = runnerFor({
      sections: ebookOf([section('一', 'One.')]),
      translate: async (_book, n, options) => {
        seen.push({ n, hasSignal: options.signal instanceof AbortSignal, hasChunk: typeof options.onChunk === 'function' });
        options.onChunk({ index: 0, total: 2 });
        return {};
      },
    });
    await runner.start(book());
    await until(async () => (await runner.status(book())).state === 'done');
    assert.deepEqual(seen, [{ n: 1, hasSignal: true, hasChunk: true }]);
  });

  it('★ 解析结果**传进了每一次调用**（不传的话宿主会每节重新解析一遍整本书）', async () => {
    const shared = ebookOf([section('一', 'One.'), section('二', 'Two.')]);
    const received = [];
    const runner = createPrefetchRunner({
      resolveEbook: async () => shared,
      translateSection: async (_book, ebook, n) => { received.push({ same: ebook === shared, n }); return {}; },
      translatedSections: async () => [],
    });
    await runner.start(book());
    await until(async () => (await runner.status(book())).state === 'done');
    assert.deepEqual(received, [{ same: true, n: 1 }, { same: true, n: 2 }]);
  });
});

describe('进度以磁盘为准', () => {
  it('没跑过但盘上已有译文：state=idle，进度按已译算', async () => {
    const runner = createPrefetchRunner({
      resolveEbook: async () => ebookOf([section('一', 'One.'), section('二', 'Two.')]),
      translateSection: async () => ({}),
      translatedSections: async () => [1],
    });
    const status = await runner.status(book());
    assert.equal(status.state, 'idle');
    assert.equal(status.translated, 1);
    assert.equal(status.total, 2);
    assert.equal(status.percent, 0.5);
  });

  it('★ 全书都译好了：state=done（这是磁盘的结论，不是上一轮运行的残留）', async () => {
    const runner = createPrefetchRunner({
      resolveEbook: async () => ebookOf([section('一', 'One.'), section('二', 'Two.')]),
      translateSection: async () => ({}),
      translatedSections: async () => [1, 2],
    });
    const status = await runner.status(book());
    assert.equal(status.state, 'done');
    assert.equal(status.planned, 0);
    assert.equal(status.percent, 1);
  });

  it('没有可翻的节：total 0，state 不是 done（没东西可译 ≠ 译完了）', async () => {
    const runner = createPrefetchRunner({
      resolveEbook: async () => ebookOf([chineseSection('一')]),
      translateSection: async () => ({}),
      translatedSections: async () => [],
    });
    const status = await runner.status(book());
    assert.equal(status.total, 0);
    assert.equal(status.state, 'idle');
  });

  it('缺依赖时构造就报错（不做半残的调度器）', () => {
    assert.throws(() => createPrefetchRunner({}), /需要 resolveEbook/);
    assert.throws(() => createPrefetchRunner({ resolveEbook: async () => ({}) }), /需要 translateSection/);
  });
});

/**
 * 接线：调度器写得再对，只要有一条线没接上，界面就会「什么也不发生」。
 *
 * ★ 这三处断掉时**都不会报错**：路由没挂 ⇒ 前端 404；service 没传 handler ⇒ 501；
 *   客户端没渲染进度条 ⇒ 任务在跑而用户看不见。三种都只能靠读源码发现，
 *   所以这里直接读源码断言「线在」。
 */
describe('接线：宿主 / 路由 / 渲染三层都接上了', () => {
  const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

  it('宿主把三个 handler 传给了路由', () => {
    const source = read('src/host/service.js');
    assert.match(source, /startEbookPrefetch: book => this\.startEbookPrefetch\(book\)/);
    assert.match(source, /stopEbookPrefetch: bookId => this\.stopEbookPrefetch\(bookId\)/);
    assert.match(source, /ebookPrefetchStatus: book => this\.ebookPrefetchStatus\(book\)/);
  });

  it('★ translateSectionOf 把 signal 与 onChunk 透传给模型调用（漏一个，停止/进度就哑了）', () => {
    const source = read('src/host/service.js');
    assert.match(source, /async translateSectionOf\(book, ebook, n, \{ force = false, signal, onChunk \} = \{\}\)/);
    assert.match(source, /\{ model: this\.aiModel\(\), signal, onChunk \}/);
  });

  it('路由挂了 prefetch 那一条，并且排在 `l10n/:n` 之前', () => {
    const source = read('src/host/library-routes.js');
    const prefetch = source.indexOf('ebook/l10n/prefetch');
    const single = source.indexOf('/ebook\\/l10n(?:\\/([1-9]');
    assert.ok(prefetch > 0, '没有 prefetch 路由');
    assert.ok(single > 0, '没有逐节路由');
    assert.ok(prefetch < single, 'prefetch 路由排到了逐节路由后面');
  });

  it('客户端把进度画出来了，样式也定义了', () => {
    // ★ 0.60.0：进度从正文顶部搬进了左栏的「澄境阅读助手」（`ReadingAssistant`），
    //   所以这条断言跟着换文件 —— 但「画出来 + 有样式」这两个要求不变。
    //   「不许画回阅读器 / 工具条」由 `test/translate-hub.test.mjs` 的反向断言守着。
    assert.match(read('src/client/ReadingAssistant.jsx'), /npr-ra-track/);
    assert.match(read('src/client/refinements.css'), /\.npr-ra-track/);
  });
});

/**
 * 0.62.0：中文书连「开始」这一步都不该走。
 *
 * ★ 界面不列出来只解决了「看不见」；书单会变（用户刚导入一本中文书、页签还开着），
 *   一旦真跑起来就是逐节调模型 —— 白花的钱和白等的几十分钟收不回来。
 */
describe('中文书在 start 这一层就拒掉', () => {
  const runnerWith = (script) => createPrefetchRunner({
    resolveEbook: async () => ({ sections: [section('一', 'It was a bright cold day.')], script }),
    translateSection: async () => { throw new Error('中文书不该走到这里'); },
    translatedSections: async () => [],
  });

  it('★ script === zh：抛 EBOOK_PREFETCH_CHINESE，且一次模型调用都不发', async () => {
    await assert.rejects(
      () => runnerWith('zh').start(book('b1')),
      (error) => error.code === 'EBOOK_PREFETCH_CHINESE',
    );
  });

  it('latin / unknown 照常开跑（不知道不等于中文）', async () => {
    for (const script of ['latin', 'unknown']) {
      const runner = createPrefetchRunner({
        resolveEbook: async () => ({ sections: [section('一', 'It was a bright cold day.')], script }),
        translateSection: async () => ({}),
        translatedSections: async () => [],
      });
      const started = await runner.start(book('b1'));
      assert.equal(started.script, script, '快照要把语种带出去，界面才不用再问一次');
      await until(async () => (await runner.status(book('b1'))).state === 'done');
    }
  });

  it('★ 快照里带 script：助手拿它过滤，阅读器拿它灰按钮', async () => {
    const source = readFileSync(new URL('../src/host/ebook/prefetch.js', import.meta.url), 'utf8');
    assert.match(source, /script: run\.script/);
    assert.match(source, /script: plan\.script/);
  });
});

/**
 * 0.64.0：`done` 只能表示「真的译完了」。
 *
 * 用户截图（助手窗口里那本书）：副标题写「已译完 · 共 36 节」，进度条却停在 83%。
 * 实测那本书 36 节全部可翻、磁盘上只有 30 节 —— 第 16/19/20/24/26/34 节**失败了**。
 *
 * 三个缺陷叠在一起才出现那一幕：
 *   ① `loop` 结尾无条件写 `done`（失败的节也算「试过了」）；
 *   ② `status()` 用内存的 `state` 覆盖磁盘的结论；
 *   ③ 界面在 `done` 分支里根本不看 `failed`。
 */
describe('0.64.0：done 与「进度条 100%」必须是同一句话', () => {
  const source = readFileSync(new URL('../src/host/ebook/prefetch.js', import.meta.url), 'utf8');
  const assistant = readFileSync(new URL('../src/client/ReadingAssistant.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/client/refinements.css', import.meta.url), 'utf8');

  /**
   * 三节；`bad` 里的节号抛错。每节留 5ms，避免「0ms 样本」被档案过滤（见 0.63.0）。
   *
   * ★ 假翻译**必须真的写盘**：`status()` 在任务结束后按磁盘算进度，
   *   一个「译成了却不落盘」的夹具会测出「进度 0%」这种真实环境里不存在的结果 ——
   *   那是夹具失真，不是产品缺陷（第一版就这么写红了两条）。
   */
  const runnerWith = (bad) => {
    const disk = new Set();
    return createPrefetchRunner({
      resolveEbook: async () => ({
        sections: [section('一', 'One.'), section('二', 'Two.'), section('三', 'Three.')],
        script: 'latin',
      }),
      translateSection: async (_book, _ebook, n) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (bad.includes(n)) throw new Error('429 Too Many Requests');
        disk.add(n);
        return {};
      },
      translatedSections: async () => [...disk],
    });
  };

  it('全部译成：state 是 done，且 percent 正好 1（两者不许各说各话）', async () => {
    const runner = runnerWith([]);
    await runner.start(book());
    const done = await until(async () => {
      const value = await runner.status(book());
      return value.state === 'done' ? value : null;
    });
    assert.equal(done.failed, 0);
    assert.equal(done.percent, 1, 'done 必须等价于 100%');
  });

  it('★ 有一节失败：终态是 partial，不是 done（用户截图那一幕）', async () => {
    const runner = runnerWith([2]);
    await runner.start(book());
    const value = await until(async () => {
      const status = await runner.status(book());
      return status.state === 'partial' ? status : null;
    });
    assert.notEqual(value.state, 'done', '有节没译成还说「已译完」，就是自相矛盾');
    assert.equal(value.failed, 1);
    assert.equal(Math.round(value.percent * 100), 67, '进度条画出 67%，文字就不能说完成');
    assert.deepEqual(value.failedSections, [2], '哪几节要能说清，用户才知道补哪里');
  });

  it('再点一次「继续」：只补失败的那几节，已有的 2 节不重花钱', async () => {
    const disk = new Set();
    const attempts = [];
    const runner = createPrefetchRunner({
      resolveEbook: async () => ({
        sections: [section('一', 'One.'), section('二', 'Two.'), section('三', 'Three.')],
        script: 'latin',
      }),
      translateSection: async (_book, _ebook, n) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        attempts.push(n);
        if (n === 2 && attempts.filter(x => x === 2).length === 1) throw new Error('429');
        disk.add(n);
        return {};
      },
      translatedSections: async () => [...disk],
    });
    await runner.start(book());
    await until(async () => ['partial', 'done'].includes((await runner.status(book())).state));
    assert.deepEqual(attempts, [1, 2, 3]);

    const again = await runner.start(book());
    assert.equal(again.state, 'running');
    const done = await until(async () => {
      const value = await runner.status(book());
      return value.state === 'done' ? value : null;
    });
    assert.deepEqual(attempts, [1, 2, 3, 2], '重试只该补第 2 节，1 和 3 已在磁盘上');
    assert.equal(done.percent, 1);
  });

  it('★ 源码：loop 结尾必须按 failed 分流，不能无条件写 done', () => {
    assert.match(
      source,
      /run\.state\s*=\s*run\.failed\.length > 0 \? 'partial' : 'done'/,
      '这一行是 0.64.0 的核心；写回无条件 done，界面就会重新出现「已译完 + 83%」',
    );
    assert.match(source, /finishedInRun < run\.total \? 'partial' : run\.state/, 'status 还要有一道兜底');
  });

  it('★ 界面：partial 不说「已译完」，按钮给「继续」，进度条不再是强调色', () => {
    assert.ok(assistant.includes("job.state === 'partial'"), '副标题要为 partial 单列一句');
    assert.ok(assistant.includes('节没译成'), '要说出「还差几节」，而不是只报总数');
    assert.ok(assistant.includes("state === 'partial') ? '继续'"), 'partial 的按钮是「继续」');
    assert.ok(css.includes('.npr-ra-row.is-partial'), 'partial 的进度条要灰掉（和 stopped 一样）');
  });
});

/**
 * 0.64.0 的第二条入口：**译出来了，但没写进磁盘**。
 *
 * `translateSectionOf` 里写盘失败只 warn、照样返回结果。于是整本预翻会把它算成
 * 「译好了一节」，而磁盘上没有 —— 重启后进度条掉回去，用户还得再花一次钱。
 * 这条链子不修，就算把 `failed` 分流做对了，「已译完 + 不满的进度条」还会从
 * 另一个方向冒出来。
 */
describe('0.64.0：没落盘的节不算进度', () => {
  it('★ persisted === false：不计 done、进 failedSections', async () => {
    const runner = createPrefetchRunner({
      resolveEbook: async () => ({
        sections: [section('一', 'One.'), section('二', 'Two.')],
        script: 'latin',
      }),
      translateSection: async (_book, _ebook, n) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        // 第 2 节：模型给了译文，但写盘失败。
        return n === 2 ? { persisted: false } : {};
      },
      translatedSections: async () => [1],
    });
    await runner.start(book());
    const value = await until(async () => {
      const status = await runner.status(book());
      return status.state === 'partial' ? status : null;
    });
    assert.equal(value.failed, 1, '没落盘的节必须算「没成」');
    assert.deepEqual(value.failedSections, [2]);
    assert.equal(value.translated, 1, '进度只认磁盘上真有的那一节');
  });

  it('★ 老调用方不返回 persisted：默认视为已落盘（不能把正常路径判成失败）', async () => {
    const runner = createPrefetchRunner({
      resolveEbook: async () => ({ sections: [section('一', 'One.')], script: 'latin' }),
      translateSection: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return {}; },
      translatedSections: async () => [1],
    });
    await runner.start(book());
    const value = await until(async () => {
      const status = await runner.status(book());
      return status.state === 'done' ? status : null;
    });
    assert.equal(value.failed, 0);
  });

  it('★ service 侧：写盘失败要上报，不能再静默 warn 完当成功', () => {
    const service = readFileSync(new URL('../src/host/service.js', import.meta.url), 'utf8');
    assert.ok(service.includes('persisted = false'), 'catch 里要置 persisted');
    assert.match(service, /\n\s+persisted,\n/, '返回对象里要带上它');
  });
});
