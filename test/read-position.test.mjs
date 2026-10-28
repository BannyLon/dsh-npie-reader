/**
 * 阅读位置（0.44.9）。
 *
 * 守三件事，三件的错法都不报错：
 *   ① 比例算错 ⇒ 「滚到底」恢复回来只到一半（分母用了 scrollHeight 而不是可滚距离）；
 *   ② 不裁剪 ⇒ 每天读 20 篇，一年 7000 个键，localStorage 5 MB 撑爆后
 *      `setItem` 在滚动事件里抛 ⇒ 滚一下就报一次错；
 *   ③ 读坏值不兜 ⇒ 上一版存进去的像素字符串被当成比例，`scrollTop` 变成天文数字。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  POSITION_LIMIT, clearPosition, positionKey, readPosition, savePosition, scrollFromRatio, scrollRatio,
} from '../src/client/read-position.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const readerSource = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));

/** 最小 localStorage 替身：够用、能数调用、能模拟配额满。 */
function fakeStorage({ failOnWrite = false } = {}) {
  const map = new Map();
  return {
    map,
    writes: 0,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) {
      if (failOnWrite) throw new Error('QuotaExceededError');
      this.writes += 1;
      map.set(key, String(value));
    },
    removeItem(key) { map.delete(key); },
  };
}

describe('0.44.9：阅读位置 —— 像素与比例互转', () => {
  it('滚到底 = 1（分母是可滚距离，不是内容总高）', () => {
    // 内容 2000、可视 600 ⇒ 可滚 1400。滚到 1400 就是到底。
    assert.equal(scrollRatio(1400, 2000, 600), 1,
      '分母用了 scrollHeight —— 滚到底只有 0.7，恢复时永远差一截');
  });

  it('内容比视口还短时给 0（不可滚）', () => {
    assert.equal(scrollRatio(0, 400, 600), 0);
    assert.equal(scrollFromRatio(0.5, 400, 600), 0);
  });

  it('中间值按比例算', () => {
    assert.equal(scrollRatio(700, 2000, 600), 0.5);
    assert.equal(scrollFromRatio(0.5, 2000, 600), 700);
  });

  it('★ 往返一致：存进去再取出来，像素误差不超过 1', () => {
    for (const top of [0, 1, 123, 700, 1399, 1400]) {
      const back = scrollFromRatio(scrollRatio(top, 2000, 600), 2000, 600);
      assert.ok(Math.abs(back - top) <= 1, `往返偏了：${top} → ${back}`);
    }
  });

  it('越界与非数字都被夹住', () => {
    assert.equal(scrollRatio(-50, 2000, 600), 0);
    assert.equal(scrollRatio(9999, 2000, 600), 1);
    assert.equal(scrollRatio(NaN, 2000, 600), 0);
    assert.equal(scrollFromRatio(NaN, 2000, 600), 0);
    assert.equal(scrollFromRatio(9, 2000, 600), 1400);
  });
});

describe('0.44.9：阅读位置 —— 存取', () => {
  it('没记过 ⇒ 0（从头开始）', () => {
    assert.equal(readPosition('a1', fakeStorage()), 0);
    assert.equal(readPosition('', fakeStorage()), 0);
  });

  it('存进去能读回来', () => {
    const storage = fakeStorage();
    savePosition('a1', 0.42, storage);
    assert.equal(readPosition('a1', storage), 0.42);
    assert.equal(storage.map.get(positionKey('a1')), '0.42');
  });

  it('★ 0 不写盘（滚到顶部不该覆盖「上次读到中间」）', () => {
    const storage = fakeStorage();
    savePosition('a1', 0, storage);
    assert.equal(storage.map.has(positionKey('a1')), false,
      '把 0 也存下来了 —— 打开文章时那一下 scrollTo(0) 会把上次的位置冲掉');
  });

  it('★ 读坏值不抛，给 0', () => {
    const storage = fakeStorage();
    // 上一版可能存的是像素字符串
    storage.map.set(positionKey('a1'), '1420');
    assert.equal(readPosition('a1', storage), 1, '像素 1420 被夹到 1（可接受），但不能抛');
    storage.map.set(positionKey('a2'), '不是数字');
    assert.equal(readPosition('a2', storage), 0);
  });

  it('★ 超过上限时淘汰最久没读的那篇', () => {
    const storage = fakeStorage();
    for (let index = 0; index < POSITION_LIMIT + 1; index += 1) savePosition(`k${index}`, 0.5, storage);
    assert.equal(storage.map.has(positionKey('k0')), false, '最老的那篇没被淘汰 —— 键会无限增长');
    assert.equal(storage.map.has(positionKey(`k${POSITION_LIMIT}`)), true, '刚写的反而被删了');
    const index = JSON.parse(storage.map.get('npr.posIndex'));
    assert.equal(index.length, POSITION_LIMIT);
  });

  it('★ 重读旧文章会把它提到最前，不被淘汰', () => {
    const storage = fakeStorage();
    for (let index = 0; index < POSITION_LIMIT; index += 1) savePosition(`k${index}`, 0.5, storage);
    savePosition('k0', 0.7, storage);                    // 重读最老的那篇
    savePosition('new', 0.5, storage);                   // 再读一篇新的，该淘汰的是 k1
    assert.equal(storage.map.has(positionKey('k0')), true, '重读过的被淘汰了 —— 索引不是按最近使用排的');
    assert.equal(storage.map.has(positionKey('k1')), false);
  });

  it('配额满时不抛（阅读位置丢了不影响读文章）', () => {
    const storage = fakeStorage({ failOnWrite: true });
    assert.doesNotThrow(() => savePosition('a1', 0.5, storage));
  });

  it('clearPosition 同时清索引', () => {
    const storage = fakeStorage();
    savePosition('a1', 0.5, storage);
    clearPosition('a1', storage);
    assert.equal(storage.map.has(positionKey('a1')), false);
    assert.deepEqual(JSON.parse(storage.map.get('npr.posIndex')), []);
  });
});

describe('0.44.9：阅读位置 —— 组件接线', () => {
  it('★ 打开文章时恢复，而不是无条件回顶', () => {
    assert.match(readerSource, /setRestoreFor\(key\)/, '打开文章时没标记「待恢复」');
    assert.match(readerSource, /scrollFromRatio\(ratio, scroller\.scrollHeight, scroller\.clientHeight\)/,
      '恢复时没用比例换算');
  });

  it('★ 恢复后立刻清标记（否则切版本会再滚一次）', () => {
    assert.match(readerSource, /setRestoreFor\(''\)/);
  });

  it('滚动保存走节流，并在切文章时 flush', () => {
    assert.match(readerSource, /setTimeout\(flush, 400\)/, '没有节流 —— 每滚一像素写一次 localStorage');
    assert.match(readerSource, /if \(timer !== 0\) \{ clearTimeout\(timer\); flush\(\); \}/,
      '切文章时没 flush —— 「读到底就切走」那一下会丢');
  });
});
