/**
 * 电子书页的「语速」槽（0.76.1）。
 *
 * 起因：设置页的「朗读」只有 API Key 与念准多音字，音色和语速的控件原本只在
 * **文章阅读页的 ⋯ 菜单**里。书架里没有文章可开时，用户在电子书里根本改不了
 * 语速 —— 这是硬断点，不是不方便。
 *
 * 判据全部真跑 `applySpeechRate` + 纯函数，不查源码字符串：
 * ★ 只断言「按钮 onClick 里有个 changeRate」等于没断言 —— 这个功能最容易错在
 *   「在播时改了语速却没停」（听到原速、以为按钮坏了）、「停了却自动续播」
 *   （用户只点了一下语速，云端就重新合成、重新扣费）、「读写的归一规则不一致」
 *   （标签说正常、实际按 4 倍念）。这三件都只在状态与实参上才看得出来。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SPEECH_RATES } from '../src/client/article-speech.js';
import {
  SPEECH_RATE_KEY, SPEECH_RATE_STEPS, applySpeechRate,
  nextSpeechRate, readSpeechRate, speechRateLabel,
} from '../src/client/ebook-speech.js';

/** 最小 storage：只实现 getItem / setItem，顺便记下写了几次。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); writes.push([key, String(value)]); },
    get writes() { return writes; },
    get map() { return map; },
  };
}

/** 假的朗读控制器：只暴露 `phase` 与 `stop`，`stop` 记账。 */
function fakeController(phase = 'playing') {
  const calls = { stop: 0 };
  return {
    get phase() { return phase; },
    stop() { calls.stop += 1; phase = 'idle'; },
    set(value) { phase = value; },
    get calls() { return calls; },
  };
}

describe('语速档位：只有一份定义', () => {
  it('★ 与文章阅读页共用同一个数组，不是抄一份', () => {
    assert.equal(SPEECH_RATE_STEPS, SPEECH_RATES, '同一组档位手写两处，改一处忘另一处会让两个页面互相打脸');
    assert.deepEqual(SPEECH_RATE_STEPS.map((item) => item.rate), [0.85, 1, 1.3, 1.7]);
  });

  it('点一下换下一档，走完一圈回到「慢」', () => {
    assert.equal(nextSpeechRate(0.85), 1);
    assert.equal(nextSpeechRate(1), 1.3);
    assert.equal(nextSpeechRate(1.3), 1.7);
    assert.equal(nextSpeechRate(1.7), 0.85);
  });

  it('★ 存着不在档位里的值（手改过 / 旧版本）从第一档开始，不是原地不动', () => {
    assert.equal(nextSpeechRate(0.5), 0.85);
    assert.equal(nextSpeechRate(4), 0.85);
  });

  it('★ 解析不出来的值按「正常」处理，再点一下是「快」（不是跳回「慢」）', () => {
    // `normalizeSpeechSpeed` 把 NaN / 非数字一律当 1 —— 这是刻意的：坏值当成
    // 「正常」比当成 0.25 倍安全（4 倍/0.25 倍念中文都是噪音）。
    assert.equal(nextSpeechRate(Number.NaN), 1.3);
    assert.equal(nextSpeechRate('abc'), 1.3);
  });

  it('反向对照：同一个输入连着点两次不会卡住（否则按钮看起来是死的）', () => {
    const first = nextSpeechRate(1);
    const second = nextSpeechRate(first);
    assert.notEqual(first, second);
  });
});

describe('按钮上的那个词', () => {
  it('四档各有自己的词', () => {
    assert.equal(speechRateLabel(0.85), '慢');
    assert.equal(speechRateLabel(1), '正常');
    assert.equal(speechRateLabel(1.3), '快');
    assert.equal(speechRateLabel(1.7), '很快');
  });

  it('怪值给空串，不硬编一个假档位名', () => {
    // 4 被 clamp 到 4（合法范围上限）但不在档位里 ⇒ 空串，让「哪来的怪值」暴露出来。
    assert.equal(speechRateLabel(4), '');
    // NaN 走的是另一条路：`normalizeSpeechSpeed` 先把它当 1，于是有词。
    assert.equal(speechRateLabel(Number.NaN), '正常');
  });
});

describe('读：空值 / 越界 / 不在档位里 → 一律「正常」', () => {
  it('没有 storage、没有这个键、值是垃圾，都回 1', () => {
    assert.equal(readSpeechRate(null), 1);
    assert.equal(readSpeechRate(fakeStorage()), 1);
    assert.equal(readSpeechRate(fakeStorage({ [SPEECH_RATE_KEY]: 'abc' })), 1);
    assert.equal(readSpeechRate(fakeStorage({ [SPEECH_RATE_KEY]: '0' })), 1);
  });

  it('★ 越界值不许原样当倍速用：9 倍念出来是噪音，标签还会空着', () => {
    assert.equal(readSpeechRate(fakeStorage({ [SPEECH_RATE_KEY]: '9' })), 1);
    assert.equal(readSpeechRate(fakeStorage({ [SPEECH_RATE_KEY]: '0.1' })), 1);
  });

  it('档位里的值原样读回（0.85 不能被 round 掉）', () => {
    for (const item of SPEECH_RATE_STEPS) {
      assert.equal(readSpeechRate(fakeStorage({ [SPEECH_RATE_KEY]: String(item.rate) })), item.rate);
    }
  });
});

describe('换语速：在播时先停、绝不自动续播', () => {
  it('★ 正在播 → 停引擎 + 明确告诉用户「按新语速重听」', () => {
    const storage = fakeStorage();
    const controller = fakeController('playing');
    const said = [];
    const result = applySpeechRate({
      next: 1.3, storage, controller, notify: (message) => said.push(message),
    });

    assert.equal(controller.calls.stop, 1, '没停 = 用户点了「快」却听到原速，会以为按钮坏了');
    assert.equal(result.stopped, true);
    assert.equal(controller.phase, 'idle');
    assert.equal(said.length, 1);
    assert.match(said[0], /语速已改为「快」/);
    assert.match(said[0], /再点「听本节」/);
  });

  it('★ 云端音色要额外说清「重新合成、重新计费」', () => {
    const storage = fakeStorage();
    const said = [];
    applySpeechRate({
      next: 1.7, storage, controller: fakeController('playing'), cloud: true,
      notify: (message) => said.push(message),
    });
    assert.match(said[0], /重新计费/, '缓存键含语速，换档必然重新合成 —— 不说就是悄悄花钱');
  });

  it('本机音色不提钱（免费），别拿「计费」吓人', () => {
    const said = [];
    applySpeechRate({
      next: 1.7, storage: fakeStorage(), controller: fakeController('playing'),
      cloud: false, notify: (message) => said.push(message),
    });
    assert.doesNotMatch(said[0], /计费/);
  });

  it('★ 暂停态也算在听：不改的话恢复播放还是旧语速', () => {
    const controller = fakeController('paused');
    const result = applySpeechRate({
      next: 1.3, storage: fakeStorage(), controller, notify: () => {},
    });
    assert.equal(result.stopped, true);
    assert.equal(controller.calls.stop, 1);
  });

  it('★ 没在听的时候只改值、不弹提示（那是预设，不是一次操作的结果）', () => {
    const said = [];
    const idle = fakeController('idle');
    const result = applySpeechRate({
      next: 1.3, storage: fakeStorage(), controller: idle,
      notify: (message) => said.push(message),
    });
    assert.equal(result.stopped, false);
    assert.equal(result.message, '');
    assert.equal(idle.calls.stop, 0);
    assert.deepEqual(said, []);
  });

  it('控制器还没建（一次都没点过听本节）也不许抛', () => {
    const result = applySpeechRate({ next: 1.3, storage: fakeStorage(), controller: null });
    assert.equal(result.rate, 1.3);
    assert.equal(result.stopped, false);
  });
});

describe('写：落的是同一个键、同一组值', () => {
  it('★ 写进 npr.speechRate（与文章阅读页共用），值是字符串', () => {
    const storage = fakeStorage();
    applySpeechRate({ next: 1.3, storage });
    assert.deepEqual(storage.writes, [[SPEECH_RATE_KEY, '1.3']]);
    assert.equal(readSpeechRate(storage), 1.3, '自己写进去的值必须能被自己读回同一个数');
  });

  it('★ 写进怪值时也归到档位：否则出现「写 4、读回 1」', () => {
    const storage = fakeStorage();
    const result = applySpeechRate({ next: 4, storage });
    assert.equal(result.rate, 1);
    assert.equal(storage.map.get(SPEECH_RATE_KEY), '1');
    assert.equal(readSpeechRate(storage), 1);
  });

  it('storage 写失败（隐私模式）时本次仍然生效，不抛', () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } };
    const result = applySpeechRate({ next: 1.3, storage: broken });
    assert.equal(result.rate, 1.3);
  });

  it('反向对照：没接 storage 时什么都不会写，也不会炸', () => {
    const result = applySpeechRate({ next: 1.3, storage: null });
    assert.equal(result.rate, 1.3);
  });
});
