/**
 * 定时关闭（P2）。
 *
 * 判据全部真跑控制器 + 假时钟：`setTimeout` 换成可手动触发的队列。
 * ★ 只断言「源码里有 setTimeout」等于没断言 —— 定时关闭最容易错的地方是
 *   「换档没清旧计时器」「到点了没真停引擎」「卸载后还弹一条通知」，
 *   这三件都只在时间轴上才看得出来。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SLEEP_STEPS, createEbookSpeech, nextSleepMinutes, sleepLabel,
} from '../src/client/ebook-speech.js';

/** 可手动推进的假时钟；`clearTimer` 也接受真实的数字句柄。 */
function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const handle = { id: nextId };
      nextId += 1;
      timers.set(handle.id, { fn, ms, handle });
      return handle;
    },
    clearTimer(handle) {
      if (handle && typeof handle === 'object') timers.delete(handle.id);
    },
    get size() { return timers.size; },
    pending() { return [...timers.values()]; },
    fireAll() {
      const snapshot = [...timers.values()];
      timers.clear();
      for (const timer of snapshot) timer.fn();
    },
  };
}

function setup({ clock = fakeClock() } = {}) {
  const log = [];
  const engine = (name) => ({
    play() { log.push(`${name}:play`); },
    pause() { log.push(`${name}:pause`); },
    resume() { log.push(`${name}:resume`); },
    stop() { log.push(`${name}:stop`); },
  });
  const controller = createEbookSpeech({
    getText: () => '第一章正文。',
    planOf: () => ({ engine: 'cloud', voice: { name: 'clara' }, speed: 1, chunks: ['第一章正文。'], error: '' }),
    notify: (message, isError) => log.push(`${isError ? 'err' : 'info'}:${message}`),
    onState: state => log.push(`state:${state}`),
    cloud: engine('cloud'),
    local: engine('local'),
    storage: null,
    bookId: 'b1',
    getPage: () => 2,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { controller, clock, log };
}

describe('档位与文案', () => {
  it('点一下换下一档，60 之后回到 0（不定时）', () => {
    assert.deepEqual(SLEEP_STEPS, [0, 15, 30, 60]);
    assert.equal(nextSleepMinutes(0), 15);
    assert.equal(nextSleepMinutes(15), 30);
    assert.equal(nextSleepMinutes(30), 60);
    assert.equal(nextSleepMinutes(60), 0);
  });

  it('非法档位回落到第一档，不会算出 undefined', () => {
    assert.equal(nextSleepMinutes(7), 15);
    assert.equal(nextSleepMinutes(''), 15);
  });

  it('按钮文案：0 说「定时」，其余说「N 分」', () => {
    assert.equal(sleepLabel(0), '定时');
    assert.equal(sleepLabel(30), '30 分');
    assert.equal(sleepLabel(-5), '定时');
  });
});

describe('控制器真跑：计时、到点、换档、取消', () => {
  it('设 15 分钟 ⇒ 注册一个 900000ms 的计时器', () => {
    const { controller, clock } = setup();
    controller.setSleep(15);
    assert.equal(clock.size, 1);
    assert.equal(clock.pending()[0].ms, 15 * 60_000);
    assert.equal(controller.sleepMinutes, 15);
  });

  it('★ 到点时正在播 ⇒ 引擎真的停了，并且说清为什么停', () => {
    const { controller, clock, log } = setup();
    controller.toggle();                       // 开播
    const before = log.length;
    controller.setSleep(15);
    clock.fireAll();

    assert.deepEqual(log.slice(before).filter(line => line.endsWith(':stop')),
      ['cloud:stop', 'local:stop'], '两条引擎都要停：只停当前那条会留下双声');
    assert.ok(log.some(line => line === 'info:定时 15 分钟到了，已停止朗读'));
    assert.equal(controller.phase, 'idle');
    assert.equal(controller.sleepMinutes, 0, '到点后档位要归零，否则按钮还写着「15 分」');
  });

  it('★ 到点时已经没在播 ⇒ 静默清掉，不弹通知（人可能已经睡了）', () => {
    const { controller, clock, log } = setup();
    controller.setSleep(30);
    const before = log.length;
    clock.fireAll();
    // 引擎的 stop() 照旧会调（幂等、无害），但不许有任何一句给用户看的话。
    const spoken = log.slice(before).filter(line => line.startsWith('info:') || line.startsWith('err:'));
    assert.deepEqual(spoken, [], '没在播还弹「已停止朗读」= 半夜把人吵醒');
    assert.equal(controller.sleepMinutes, 0);
  });

  it('★ 换档必须清掉旧计时器：否则 15 分钟那次先响，用户以为 30 分钟没生效', () => {
    const { clock, controller } = setup();
    controller.setSleep(15);
    controller.setSleep(30);
    assert.equal(clock.size, 1, '旧计时器没清 = 两条定时同时在数');
    assert.equal(clock.pending()[0].ms, 30 * 60_000);
    assert.equal(controller.sleepMinutes, 30);
  });

  it('setSleep(0) 取消：计时器清掉、档位归零', () => {
    const { controller, clock } = setup();
    controller.setSleep(15);
    controller.setSleep(0);
    assert.equal(clock.size, 0);
    assert.equal(controller.sleepMinutes, 0);
  });

  it('★ 暂停 / 继续 / 重新开播都不重置计时（否则每翻一页就续命，永远到不了）', () => {
    const { controller, clock } = setup();
    controller.setSleep(15);
    const handle = clock.pending()[0].handle;
    controller.toggle();          // 开播
    controller.toggle();          // 暂停
    controller.toggle();          // 继续
    controller.stop();            // 手动停
    controller.toggle();          // 再开播
    assert.equal(clock.size, 1);
    assert.equal(clock.pending()[0].handle, handle, '计时器被换掉了 = 计时被重置');
  });

  it('★ dispose 之后不许再响：卸载组件 30 分钟后弹通知是最典型的幽灵提示', () => {
    const { controller, clock, log } = setup();
    controller.setSleep(15);
    controller.dispose();
    assert.equal(clock.size, 0);
    clock.fireAll();                 // 表里已空，这里只证明「没有被排队」
    assert.ok(!log.some(line => line.includes('定时 15 分钟到了')));
  });

  it('定时器带 unref 时不抛（桌面端主进程不该被它拖住退出）', () => {
    const clock = fakeClock();
    const raw = clock.setTimer;
    clock.setTimer = (fn, ms) => {
      const handle = raw(fn, ms);
      handle.unref = () => { handle.unrefed = true; };
      return handle;
    };
    const { controller } = setup({ clock });
    assert.doesNotThrow(() => controller.setSleep(15));
    assert.equal(clock.pending()[0].handle.unrefed, true);
  });
});
