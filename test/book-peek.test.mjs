/**
 * 沉浸态「胶囊滑出」的判据（0.25.4）。
 *
 * 用户原话：「顶部的菜单条一旦隐藏就出不来了，为什么」。
 * 根因不是 CSS 写漏了 —— 是热区 `.npr-book-toolbar` 在宿主里带
 * `-webkit-app-region: drag`（窗口拖动条），Chromium 把它当标题栏命中，
 * 页面收不到鼠标事件 ⇒ `:hover` 永不成立。所以改成「按指针到面板顶边的距离」判断。
 *
 * 这些用例锁的是**两个阈值与滞回**：去掉滞回会在边界上反复开合（视觉上就是抖），
 * 把阈值调小会让「鼠标还在正文第一行」就把工具栏弹出来。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PEEK_HIDE, PEEK_SHOW, peekNext, peekOnLeave } from '../src/client/book-peek.js';

describe('peekNext：沉浸态胶囊滑出', () => {
  it('指针进到 56px 以内就滑出', () => {
    assert.equal(peekNext(false, 0), true);
    assert.equal(peekNext(false, 20), true);
    assert.equal(peekNext(false, PEEK_SHOW), true, '正好在阈值上要算「在里面」');
  });

  it('指针离开 72px 以外才收', () => {
    assert.equal(peekNext(true, PEEK_HIDE + 1), false, '越过 HIDE 就该收');
    assert.equal(peekNext(true, 400), false);
  });

  it('★ 56~72 之间是滞回区：保持原状，不来回跳', () => {
    // 这正是「已滑出」时指针停在中间：如果只用一个阈值，它会立刻收起、
    // 指针一动又弹出，看起来就是胶囊在抖。
    for (const d of [57, 60, 66, PEEK_HIDE]) {
      assert.equal(peekNext(true, d), true, `已滑出时距离 ${d}px 不该收`);
      assert.equal(peekNext(false, d), false, `还没滑出时距离 ${d}px 不该弹`);
    }
  });

  it('两个阈值本身的顺序不能反过来（SHOW < HIDE）', () => {
    assert.ok(PEEK_SHOW < PEEK_HIDE, '阈值顺序反了会让滞回区变成负区间');
  });

  it('拿不到坐标（NaN / Infinity）时保持原状，不要突然藏起来', () => {
    assert.equal(peekNext(true, Number.NaN), true);
    assert.equal(peekNext(false, Number.NaN), false);
    assert.equal(peekNext(true, Number.POSITIVE_INFINITY), true, '无穷大不是「很远」，是「读不出」');
  });

  it('负数（指针跑到面板上方）算「在里面」', () => {
    assert.equal(peekNext(false, -12), true);
  });
});

describe('peekOnLeave：指针离开面板时收不收', () => {
  it('★ 从顶部离开（进了那 10px 拖动条）要留着 —— 用户正在伸手去点它', () => {
    // 拖动条在宿主里连鼠标事件都不给，我们收到的是「离开面板」。
    // 这时候收掉，等于伸手的瞬间工具条消失 —— 又变回「出不来了」。
    assert.equal(peekOnLeave(4), true);
    assert.equal(peekOnLeave(PEEK_SHOW), true);
  });

  it('从正文那一侧离开就收掉', () => {
    assert.equal(peekOnLeave(PEEK_SHOW + 1), false);
    assert.equal(peekOnLeave(500), false);
  });

  it('读不出坐标时按「收掉」处理（宁可少露一会儿，别一直糊在书上）', () => {
    assert.equal(peekOnLeave(Number.NaN), false);
    assert.equal(peekOnLeave(Number.NEGATIVE_INFINITY), false);
  });
});
