/**
 * 「翻页 → 落盘」的去抖器（`src/client/page-progress.js`）。
 *
 * ★ 这一组守的是 **P1-4**：阅读进度在切页时被丢掉。
 *
 * 修之前 `LibraryApp.jsx` 的 cleanup 是这么写的：
 *
 *     // 离开书架（切回订阅 / 关掉面板）时把还没落盘的那次进度写完。
 *     useEffect(() => () => { clearTimeout(saveTimer.current); }, []);
 *
 * 注释说的是「写完」，代码做的是「清掉」—— **代码与注释相反**。于是
 * 「翻页后 1.2 秒内切回订阅页 / 关掉面板」那一次永远不会写盘，
 * 而用户以为进度是自动存的（没有任何提示，也不会有任何报错）。
 *
 * ⇒ 所以这里最要紧的一条不是「等够时间会写」，而是
 *   **「窗口内卸载，那一次必须立刻写」**（下面第三条），
 *   并且配一条反向对照，证明「只 clearTimeout」确实会丢（第四条）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPageProgress } from '../src/client/page-progress.js';

/**
 * 假计时器。
 *
 * ★ 刻意自己写而不是用 `node:test` 的 mock timers：这个模块的 `schedule`/`cancel`
 *   是**注入**的，假计时器只要满足这两个签名就够了，不必和全局计时器较劲
 *   （那还会牵动别的测试文件）。注入点本身也是被测契约的一部分。
 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    schedule(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    cancel(id) { timers.delete(id); },
    /** 模拟 `clearTimeout` 却**不**补写 —— 修之前那句 cleanup 的形状。 */
    cancelAll() { timers.clear(); },
    /** 推进时间，按到期顺序执行（执行中新排的、且也在窗口内的同样会跑到）。 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    get pendingTimers() { return timers.size; },
  };
}

/** 造一个「记下每次写盘」的去抖器。 */
function harness({ delayMs = 1200, save } = {}) {
  const clock = fakeClock();
  const writes = [];
  const errors = [];
  const progress = createPageProgress({
    delayMs,
    save: save ?? ((entry) => { writes.push(entry); }),
    schedule: clock.schedule,
    cancel: clock.cancel,
    onError: (error) => errors.push(error),
  });
  return { clock, writes, errors, progress };
}

describe('翻页去抖', () => {
  it('要等满窗口才落盘（逐页翻不该每次都写盘）', () => {
    const { clock, writes, progress } = harness();
    progress.note({ id: 'b1', page: 1, pages: 100 });
    assert.deepEqual(writes, [], '还没到窗口就写盘了 —— 每翻一页都会写一次盘');
    clock.advance(1199);
    assert.deepEqual(writes, []);
    clock.advance(1);
    assert.deepEqual(writes, [{ id: 'b1', page: 1, pages: 100 }]);
  });

  it('窗口内连翻多页只写一次，写的是**最后**那一页', () => {
    const { clock, writes, progress } = harness();
    progress.note({ id: 'b1', page: 1, pages: 100 });
    clock.advance(500);
    progress.note({ id: 'b1', page: 2, pages: 100 });
    clock.advance(500);
    progress.note({ id: 'b1', page: 3, pages: 100 });
    assert.deepEqual(writes, [], '去抖失效了：每翻一页都写了一次');
    clock.advance(1200);
    assert.deepEqual(writes, [{ id: 'b1', page: 3, pages: 100 }]);
  });

  it('★ 守卫（P1-4）：窗口内卸载，那一次必须**立刻**落盘', () => {
    const { clock, writes, progress } = harness();
    progress.note({ id: 'b1', page: 120, pages: 300 });
    assert.equal(progress.hasPending, true, '记了翻页却说没有待写内容');
    clock.advance(300); // 用户在这个窗口里切回了订阅页
    assert.deepEqual(writes, []);
    progress.flush(); // ← 卸载
    assert.deepEqual(
      writes, [{ id: 'b1', page: 120, pages: 300 }],
      '卸载时把没落盘的那一次丢掉了 —— 用户翻到第 120 页切走，进度就没了',
    );
    assert.equal(progress.hasPending, false);
  });

  it('flush 是幂等的（卸载时无条件调一次是安全的）', () => {
    const { clock, writes, progress } = harness();
    progress.flush();
    assert.deepEqual(writes, [], '没有待写内容却写了盘');
    progress.note({ id: 'b1', page: 9, pages: 10 });
    clock.advance(100);
    progress.flush();
    progress.flush();
    assert.equal(writes.length, 1, 'flush 被调两次就写两次盘');
  });

  it('flush 之后计时器不该再补写一次（否则同一页写两遍）', () => {
    const { clock, writes, progress } = harness();
    progress.note({ id: 'b1', page: 5, pages: 10 });
    clock.advance(100);
    progress.flush();
    clock.advance(5000);
    assert.equal(writes.length, 1, `同一页被写了 ${writes.length} 次`);
    assert.equal(clock.pendingTimers, 0, 'flush 之后还留着计时器');
  });

  it('★ 1.2 秒内从 A 书翻到 B 书，两本都要写（一个槽会顶掉前一本）', () => {
    const { clock, writes, progress } = harness();
    progress.note({ id: 'b1', page: 10, pages: 100 });
    clock.advance(300);
    progress.note({ id: 'b2', page: 3, pages: 50 });
    clock.advance(1200);
    assert.deepEqual(
      [...writes].sort((a, b) => a.id.localeCompare(b.id)),
      [{ id: 'b1', page: 10, pages: 100 }, { id: 'b2', page: 3, pages: 50 }],
      '换书时把前一本的进度顶掉了 —— 又一条静默丢进度的路',
    );
  });

  it('★ 反向对照：修之前那句 cleanup（只 clearTimeout）确实会丢', () => {
    // 逐字复刻：`useEffect(() => () => { clearTimeout(saveTimer.current); }, [])`
    const { clock, writes, progress } = harness();
    progress.note({ id: 'b1', page: 120, pages: 300 });
    clock.advance(300);
    clock.cancelAll();
    assert.deepEqual(writes, [], '这正是那个 bug 的形状：进度静默丢失');
    assert.equal(
      progress.hasPending, true,
      '而且连「还有没写完的东西」都还知道 —— 但没有任何人问它，所以一句提示都没有',
    );
    // 同一个状态改用 flush()，进度就保住了 ⇒ 说明「变红」的是 cleanup，不是判据。
    progress.flush();
    assert.deepEqual(writes, [{ id: 'b1', page: 120, pages: 300 }]);
  });
});

describe('落盘失败：卸载路径上没人接 promise，必须自己接住', () => {
  it('★ promise 被拒时走 onError（否则就是 unhandledRejection）', async () => {
    const { clock, errors, progress } = harness({
      delayMs: 10,
      save: () => Promise.reject(new Error('disk full')),
    });
    progress.note({ id: 'b1', page: 1, pages: 2 });
    clock.advance(10);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(errors.length, 1, '写盘失败没有报到 onError');
    assert.match(errors[0].message, /disk full/);
  });

  it('★ 同步抛出的 save 也要被接住（卸载时抛出去没人接）', () => {
    const { clock, errors, progress } = harness({
      delayMs: 10,
      save: () => { throw new Error('boom'); },
    });
    progress.note({ id: 'b1', page: 1, pages: 2 });
    clock.advance(10);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /boom/);
    // 一本书抛了不该影响下一本。
    progress.note({ id: 'b2', page: 1, pages: 2 });
    clock.advance(10);
    assert.equal(errors.length, 2, '一次失败之后整个去抖器就废了');
  });

  it('★ 同步的 save（返回 undefined）不算失败', () => {
    // 写成 `save(entry).catch(...)` 时这里会 TypeError：一次**成功**的写盘变成一次报错。
    let calls = 0;
    const { clock, errors, progress } = harness({ delayMs: 10, save: () => { calls += 1; } });
    progress.note({ id: 'b1', page: 1, pages: 2 });
    clock.advance(10);
    assert.equal(calls, 1, 'save 压根没被调用 —— 这条断言就没在测东西');
    assert.deepEqual(errors, [], '同步 save 的返回值被当成 promise 了');
  });
});
