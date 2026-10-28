/**
 * 选中文字浮出的操作条（0.45.0）。
 *
 * 守四件事，四件的错法都不报错：
 *   ① 上方贴边不翻转 ⇒ 工具条被窗口顶边裁掉，用户看不到「摘录到灵感」，只会觉得「选中没反应」；
 *   ② 左右不夹取 ⇒ 选到行尾那几个字时工具条一半飘出窗口；
 *   ③ 空 range 也浮 ⇒ 单击正文（选区折叠）留下一根孤儿条，点哪儿都不消失；
 *   ④ 点工具条自己算「点外面」⇒ 按钮在 click 之前就被卸载，点了没反应 —— 这正是用户报的那个 bug 的形态。
 *
 * ★ 第 ④ 条只能在源码层咬：没有 React 渲染器，行为测不了，但「有没有写 closest 判断」是可判的。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  BAR_HALF_WIDTH, BAR_HEIGHT, VIEWPORT_EDGE, selectionBarPlacement,
} from '../src/client/selection-bar.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const readerSource = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));

/** 造一个 Range.getBoundingClientRect 形状的矩形。 */
const rect = (top, left, width = 200, height = 18) => ({ top, bottom: top + height, left, width, height });
const viewport = (innerWidth = 1200, innerHeight = 800) => ({ innerWidth, innerHeight });

describe('0.45.0：选中操作条 —— 纵向定位', () => {
  it('正常情况浮在选区上方（不是压在选中的字上）', () => {
    const placed = selectionBarPlacement(rect(300, 400), viewport());
    assert.deepEqual(placed, { top: 300 - BAR_HEIGHT, left: 500 });
  });

  it('上方贴到窗口边就翻到下方 —— 否则工具条被顶边裁掉', () => {
    const placed = selectionBarPlacement(rect(20, 400), viewport());
    assert.equal(placed.top, 20 + 18 + VIEWPORT_EDGE, '顶部放不下时应落在选区下方');
  });

  it('上下都放不下（窗口很矮）时贴底部，不越出窗口', () => {
    const placed = selectionBarPlacement(rect(20, 400), viewport(1200, 60));
    assert.equal(placed.top, 60 - BAR_HEIGHT - VIEWPORT_EDGE);
    assert.ok(placed.top >= VIEWPORT_EDGE, '贴底后仍须留出上边距');
  });

  it('不传 viewport 也算得出来，且不出 NaN', () => {
    const placed = selectionBarPlacement(rect(300, 400));
    assert.equal(Number.isFinite(placed.top), true);
    assert.equal(Number.isFinite(placed.left), true);
  });
});

describe('0.45.0：选中操作条 —— 横向夹取', () => {
  it('以选区中心为轴（不是以左边缘对齐）', () => {
    const placed = selectionBarPlacement(rect(300, 100, 60), viewport());
    assert.equal(placed.left, 130);
  });

  it('选区贴左边时夹到半宽处，左半截不飘出窗口', () => {
    const placed = selectionBarPlacement(rect(300, 0, 40), viewport());
    assert.equal(placed.left, BAR_HALF_WIDTH);
  });

  it('选区贴右边时夹到窗口内', () => {
    const placed = selectionBarPlacement(rect(300, 1150, 40), viewport());
    assert.equal(placed.left, 1200 - BAR_HALF_WIDTH);
  });

  it('窗口比工具条还窄时 left 不为负（夹取上限跟着缩）', () => {
    const placed = selectionBarPlacement(rect(300, 10, 20), viewport(100, 800));
    assert.equal(placed.left, 50);
    assert.ok(placed.left >= 0);
  });
});

describe('0.45.0：选中操作条 —— 无效选区不浮条', () => {
  it('矩形是 0×0（选区折叠 / 只选到空白）返回 null', () => {
    assert.equal(selectionBarPlacement({ top: 0, bottom: 0, left: 0, width: 0, height: 0 }, viewport()), null);
  });

  it('range 重建失败（null）返回 null，而不是抛错', () => {
    assert.equal(selectionBarPlacement(null, viewport()), null);
  });
});

describe('0.45.0：选中操作条 —— 组件接线（源码契约）', () => {
  // 工具条那段 JSX 的切片。★ 必须限定在块内查：`void excerptToDiary()` 在「…」菜单里
  //   也有一份，全文件匹配会咬到菜单那一份 —— 实测变异体「工具条按钮只关条不摘录」照样全绿。
  const barStart = readerSource.indexOf('className="npr-selection-bar"');
  const barEnd = readerSource.indexOf('npr-toast', barStart);
  const barBlock = barStart >= 0 && barEnd > barStart ? readerSource.slice(barStart, barEnd) : '';

  it('工具条 JSX 切片有效（边界找错会让下面几条变成空转）', () => {
    assert.ok(barBlock.length > 100, `切片失败：长度 ${barBlock.length}`);
    assert.match(barBlock, /摘录到灵感/, '切片里应含工具条按钮文案');
  });

  it('定位规则只在 selection-bar.js 里，组件不再自己算 top', () => {
    assert.match(readerSource, /selectionBarPlacement\(rect/, '组件应把定位交给纯函数');
    assert.doesNotMatch(readerSource, /const top = rect\.top/, '组件里不应再留一份内联定位');
  });

  it('收起条件三件套齐全：点外面 / 滚动 / Esc', () => {
    assert.match(readerSource, /addEventListener\('pointerdown', onDown, true\)/, '缺「点外面收起」');
    assert.match(readerSource, /addEventListener\('scroll', hide, true\)/, '缺「滚动收起」');
    assert.match(readerSource, /event\.key === 'Escape'/, '缺「Esc 收起」');
  });

  it('点工具条自己不算点外面（否则按钮在 click 前就被卸载）', () => {
    assert.match(readerSource, /closest\?\.\('\.npr-selection-bar'\)/, '缺少自身命中判断');
  });

  it('按下按钮不让选区折叠（保住高亮）', () => {
    assert.match(barBlock, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/, '缺少 pointerdown preventDefault');
  });

  it('工具条上的按钮直接摘录，不再绕菜单', () => {
    assert.match(barBlock, /void excerptToDiary\(\)/, '工具条应直连 excerptToDiary');
  });

  it('捕获选区不无条件开伴读（一开面板正文变宽，选中段会跳）', () => {
    const body = readerSource.slice(
      readerSource.indexOf('const captureSelection = ()'),
      readerSource.indexOf('const captureSelection = ()') + 900,
    );
    assert.ok(body.includes('setSelectionBar'), 'captureSelection 里应设置工具条位置');
    // ★ 顺序有意义：两条断言守的是同一个 if 的两种改坏方式，先报「无条件」那条。
    assert.doesNotMatch(body, /^    openCompanion\(/m, '不应无条件 openCompanion');
    assert.match(body, /if \(askContext\) openCompanion\(found\.quote\);/, '面板已开时应跟随新选区');
  });

  it('按钮样式逐条写死，不被宿主全局 button 规则撑成整行', () => {
    assert.match(readerSource, /\.npr-selection-bar button\{[^}]*white-space:nowrap/, '按钮缺 nowrap/尺寸约束');
  });
});
