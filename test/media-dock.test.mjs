/**
 * 播放控制面（`audio-controller.js`）与断点记忆（`media-progress.js`）。
 *
 * 这两块都没有 React：一个只认 `<audio>` 元素，一个只认 storage。所以判据可以塞
 * 假元素、假 storage，把**边界**真的跑出来 —— 而边界正是它们唯一会出错的地方：
 * 跳到总时长之后（浏览器静默停在末尾）、负时间（抛 DOMException）、
 * 倍速被写成字符串（赋值静默无效）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createAudioController } from '../src/client/audio-controller.js';
import { PROGRESS_PREFIX, RATE_CHOICES, progressKey, readProgress, resumeAt, saveProgress } from '../src/client/media-progress.js';

const CONTROLLER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/client/audio-controller.js');

/** 够用的假 `<audio>`：只实现控制器真正用到的那几个成员。 */
function fakeAudio({ duration = 100, currentTime = 0, paused = true, readyState = 4 } = {}) {
  const handlers = new Map();
  const element = {
    currentTime,
    duration,
    paused,
    /** `preload="none"` 的元素在首次播放前是 0 —— 0.85.0 的 seek 加固就为这个值。 */
    readyState,
    playbackRate: 1,
    playCalls: 0,
    pauseCalls: 0,
    loadCalls: 0,
    addEventListener(name, handler) { handlers.set(name, handler); },
    removeEventListener(name, handler) { if (handlers.get(name) === handler) handlers.delete(name); },
    play() { element.playCalls += 1; element.paused = false; return Promise.resolve(); },
    pause() { element.pauseCalls += 1; element.paused = true; },
    load() { element.loadCalls += 1; },
    emit(name) { handlers.get(name)?.(); },
    get listenerCount() { return handlers.size; },
  };
  return element;
}

/** 内存 storage，可注入「写入抛错」的坏实现。 */
function fakeStorage({ failWrite = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) {
      if (failWrite) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
  };
}

describe('createAudioController', () => {
  it('订阅当场给一次当前值（面板挂载时不该等到下一次 timeupdate）', () => {
    const element = fakeAudio({ currentTime: 7 });
    const controller = createAudioController(element);
    const seen = [];
    controller.subscribe((time) => seen.push(time));
    assert.deepEqual(seen, [7]);
    controller.dispose();
  });

  it('微小的 timeupdate 不通知（一秒四次会让高亮闪）', () => {
    const element = fakeAudio({ currentTime: 0 });
    const controller = createAudioController(element);
    const seen = [];
    controller.subscribe((time) => seen.push(time));
    element.currentTime = 0.05;
    element.emit('timeupdate');
    assert.deepEqual(seen, [0], '0.05 秒的位移不该触发');
    element.currentTime = 0.2;
    element.emit('timeupdate');
    assert.deepEqual(seen, [0, 0.2]);
    controller.dispose();
  });

  it('跳转立刻通知并开始播放，目标是段落的起点而不是下一次心跳', () => {
    const element = fakeAudio({ duration: 100 });
    const controller = createAudioController(element);
    const seen = [];
    controller.subscribe((time) => seen.push(time));
    const landed = controller.seek(30);
    assert.equal(landed, 30);
    assert.equal(element.currentTime, 30);
    assert.equal(element.playCalls, 1);
    assert.deepEqual(seen, [0, 30]);
    controller.dispose();
  });

  it('跳转被夹在 [0, 总时长) 里：负数和越界都不会交给浏览器', () => {
    const element = fakeAudio({ duration: 100 });
    const controller = createAudioController(element);
    assert.equal(controller.seek(-5, { play: false }), 0);
    // 100 - 0.25：停在正好等于 duration 的位置时，浏览器会把它当作「播完了」。
    assert.equal(controller.seek(999, { play: false }), 99.75);
    controller.dispose();
  });

  it('±15 秒保留原本的播放/暂停状态', () => {
    const playing = fakeAudio({ duration: 100, currentTime: 30, paused: false });
    const controller = createAudioController(playing);
    assert.equal(controller.nudge(15), 45);
    assert.equal(playing.playCalls, 1, '本来在播，跳完继续播');

    const paused = fakeAudio({ duration: 100, currentTime: 30, paused: true });
    const second = createAudioController(paused);
    assert.equal(second.nudge(-15), 15);
    assert.equal(paused.playCalls, 0, '本来暂停，跳完不该自己开始播');
    controller.dispose();
    second.dispose();
  });

  it('dispose 之后元素上不再挂着监听器，也不再回调', () => {
    const element = fakeAudio();
    const controller = createAudioController(element);
    const seen = [];
    controller.subscribe((time) => seen.push(time));
    // timeupdate / seeked / loadedmetadata（0.85.0 起的第三个：等元数据补跳）。
    assert.equal(element.listenerCount, 3);
    controller.dispose();
    assert.equal(element.listenerCount, 0);
    element.emit('timeupdate');
    assert.equal(seen.length, 1);
  });

  /**
   * ★ 0.85.0：`preload="none"` 下还没点播放就拖进度条 —— 这是播客面板上
   *   最自然的动作之一。此时 `readyState === 0`，Chromium 给 `currentTime`
   *   赋值抛 `InvalidStateError`。原来裸赋值、调用方无 catch ⇒ 异常冒到
   *   React 事件里，`setScrubbing(null)` 执行不到 ⇒ **滑块卡在拖到的位置、
   *   音频不动**，用户看到的就是「进度条拖不动」。
   */
  it('元数据还没到也能跳：先 load，再赋值，位置要真的落地', () => {
    const element = fakeAudio({ readyState: 0, duration: 3600 });
    const controller = createAudioController(element);
    // 模拟 Chromium 的真实行为：readyState 为 0 时赋值抛 InvalidStateError。
    let value = 0;
    Object.defineProperty(element, 'currentTime', {
      configurable: true,
      get() { return value; },
      set(next) {
        if (element.readyState === 0) throw new Error('InvalidStateError');
        value = next;
      },
    });

    assert.doesNotThrow(() => controller.seek(120, { play: false }), 'seek 把异常漏给了调用方');
    assert.equal(element.loadCalls, 1, 'readyState 为 0 时没有先 load —— 浏览器不会自己开始取数据');

    // 元数据到达：这一刻才真的能定位。
    element.readyState = 1;
    element.emit('loadedmetadata');
    assert.equal(value, 120, '元数据到了也没把待跳目标补上');
    controller.dispose();
  });

  it('反向对照：把 seek 的 try/catch 拿掉，这条判据必须红', async () => {
    const source = readFileSync(CONTROLLER_SOURCE, 'utf8');
    const anchor = 'try {\n      element.currentTime = target;\n    } catch {\n      pendingSeek = target;\n    }';
    assert.ok(source.includes(anchor), `变异锚点没命中：${anchor}`);
    const mutated = source.replace(anchor, 'element.currentTime = target;');
    const mod = await import(`data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`);
    const element = fakeAudio({ readyState: 0 });
    const controller = mod.createAudioController(element);
    Object.defineProperty(element, 'currentTime', {
      configurable: true,
      get() { return 0; },
      set() { throw new Error('InvalidStateError'); },
    });
    assert.throws(() => controller.seek(60, { play: false }), /InvalidStateError/,
      '去掉 catch 之后仍然不抛，说明这条判据没绑在加固上');
    controller.dispose();
  });

  it('反向对照：把上界的夹子去掉，seek(999) 就必须真的给到 999', async () => {
    const source = readFileSync(CONTROLLER_SOURCE, 'utf8');
    const from = 'Math.min(Math.max(target, 0), Math.max(upper - 0.25, 0))';
    assert.ok(source.includes(from), `变异锚点没命中：${from}`);
    const mutated = source.replace(from, 'Math.max(target, 0)');
    const mod = await import(`data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`);
    const element = fakeAudio({ duration: 100 });
    const controller = mod.createAudioController(element);
    assert.equal(controller.seek(999, { play: false }), 999, '去掉夹子后仍然被夹住，说明判据没绑在这句上');
    controller.dispose();
  });
});

describe('断点记忆', () => {
  it('写进去再读回来，位置与倍速都在', () => {
    const storage = fakeStorage();
    assert.equal(saveProgress(storage, 'feed:ep1', { t: 123.4, rate: 1.5 }), true);
    assert.deepEqual(readProgress(storage, 'feed:ep1'), { t: 123.4, rate: 1.5 });
    assert.equal(storage.map.has(`${PROGRESS_PREFIX}feed:ep1`), true);
    assert.equal(progressKey('feed:ep1'), `${PROGRESS_PREFIX}feed:ep1`);
  });

  it('档位表之外的倍速一律回到 1（否则赋值给 playbackRate 会静默无效）', () => {
    const storage = fakeStorage();
    storage.setItem(progressKey('k'), JSON.stringify({ t: 10, rate: 3 }));
    const { rate } = readProgress(storage, 'k');
    assert.equal(rate, 1);
    assert.equal(RATE_CHOICES.includes(rate), true);
  });

  it('坏 JSON / 空值 / 负数位置都不抛错，回到起点', () => {
    const storage = fakeStorage();
    storage.setItem(progressKey('bad'), '{oops');
    assert.deepEqual(readProgress(storage, 'bad'), { t: 0, rate: 1 });
    storage.setItem(progressKey('neg'), JSON.stringify({ t: -20, rate: 1 }));
    assert.deepEqual(readProgress(storage, 'neg'), { t: 0, rate: 1 });
    assert.deepEqual(readProgress(null, 'x'), { t: 0, rate: 1 });
  });

  it('storage 写失败只返回 false，不把「记不住进度」升级成「播不了」', () => {
    const storage = fakeStorage({ failWrite: true });
    assert.equal(saveProgress(storage, 'k', { t: 5, rate: 1 }), false);
  });

  it('恢复点：开头 3 秒内不跳，快结束时从头，正常位置原样恢复', () => {
    // 几乎等于从头，跳一下只会削掉开头。
    assert.equal(resumeAt({ t: 2 }, 3600), 0);
    assert.equal(resumeAt({ t: 3 }, 3600), 0);
    assert.equal(resumeAt({ t: 3.1 }, 3600), 3.1);
    // 换了一版音频（上次的位置超过了新文件的总长）⇒ 从头。
    assert.equal(resumeAt({ t: 500 }, 100), 0);
    // 剩不到 5 秒 ⇒ 从头，否则一播放就结束，看起来像文件坏了。
    assert.equal(resumeAt({ t: 3598 }, 3600), 0);
    assert.equal(resumeAt({ t: 3590 }, 3600), 3590);
    // 总时长还不知道（0）时按存的来。
    assert.equal(resumeAt({ t: 120 }, 0), 120);
  });
});
