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

import { PEEK_HIDE, PEEK_PANEL_CLASSES, PEEK_SHOW, insidePanel, peekNext, peekOnLeave } from '../src/client/book-peek.js';

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

/**
 * 「指针在面板上就别滑出」—— 0.25.7。
 *
 * 用户原话：「在沉浸阅读的时候，打开目录，目录的框就会关闭了，因为鼠标一移动上去，
 * 就会划出菜单，菜单就会遮挡掉目录框的关闭按钮」。
 * 关目录必须点面板右上角那颗按钮，鼠标路径必然经过面板顶部那一行；判据只有 y 时，
 * 胶囊就在那一刻滑出来正好盖住它。
 */
function node(className, parent = null) {
  return { className, parentElement: parent };
}

describe('insidePanel：指针在不在面板上', () => {
  it('面板根节点自己', () => {
    assert.equal(insidePanel(node('npr-book-digest npr-ebook-toc')), true);
    assert.equal(insidePanel(node('npr-marks')), true);
    assert.equal(insidePanel(node('npr-companion')), true);
  });

  it('面板里面很深的子节点（沿父链往上找得到）', () => {
    const deep = node('npr-icon', node('icon-wrap', node('npr-ebook-toc-close', node('npr-ebook-toc-head', node('npr-book-digest')))));
    assert.equal(insidePanel(deep), true);
  });

  it('★ 相似前缀不算：`npr-marks-list` / `npr-book-digest-bar` 不能混淆', () => {
    // 用 `includes` 而不是按空白切词就会在这里判错 —— 面板里满是这种前缀相同的类名。
    assert.equal(insidePanel(node('npr-marks-list')), false);
    assert.equal(insidePanel(node('npr-book-digest-bar')), false);
  });

  it('正文 / 胶囊 / 拖动条都不算面板', () => {
    assert.equal(insidePanel(node('npr-ebook-sheet')), false);
    assert.equal(insidePanel(node('npr-book-chrome', node('npr-book'))), false);
    assert.equal(insidePanel(node('npr-book-toolbar')), false);
  });

  it('target 是 null（合成事件 / 指针已移出文档）时不炸，按「不在面板上」处理', () => {
    assert.equal(insidePanel(null), false);
    assert.equal(insidePanel(undefined), false);
  });

  it('SVG 元素的 className 是对象，不能拼成 [object SVGAnimatedString]', () => {
    // 面板里的图标就是 `<svg>`；若这里判不出来，指针停在图标上时胶囊照样滑出。
    const svg = { className: { baseVal: 'npr-icon-svg' }, parentElement: node('npr-book-digest') };
    assert.equal(insidePanel(svg), true);
  });

  it('父链成环也不会死循环（深度上限兜住）', () => {
    const a = node('a');
    const b = node('b', a);
    a.parentElement = b;
    assert.equal(insidePanel(a), false);
  });

  it('自定义面板类名可替换（PDF / 电子书以后加面板不必改判据）', () => {
    assert.equal(insidePanel(node('my-panel'), ['my-panel']), true);
    assert.equal(insidePanel(node('npr-marks'), ['my-panel']), false);
    // 0.26.0 加了书内搜索面板 `npr-find`：它同样在 `npr-book-main` 里，
    // 漏掉它的话沉浸态下胶囊会滑出来盖住搜索框（与目录那次同一个故障）。
    assert.deepEqual(
      [...PEEK_PANEL_CLASSES].sort(),
      ['npr-book-digest', 'npr-companion', 'npr-find', 'npr-marks'],
    );
  });
});
