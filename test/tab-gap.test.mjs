/**
 * 「工具栏 → 切换控件」的纵向间距：三处必须同一个数（0.53.3）。
 *
 * 用户 2026-10-30 拿三张截图（RSS 侧栏 / 书架侧栏 / 日记侧栏）说
 * 「这三个的上下间距没有统一」。根因不是谁写错了，而是**三处各写各的**：
 *   · `.npr-filters-primary`  margin-top 0
 *   · `.npr-libtabs`          margin-top 0
 *   · `.npr-diary-modes`      margin-top 6（0.44.5 为「与工具栏断开」单独加的）
 * 画出来 8 / 8 / 11。
 *
 * ★ 为什么之前没被发现：`scripts/check-tabs.mjs` 量了切换控件的**自身几何**
 *   （高 / 圆角 / 字号 / 字重 / 内边距 / 宽度 / 底色关系），**一条 margin 都没查**。
 *   量了控件、没量控件之间 —— 所以「全绿」和「一眼不齐」可以同时成立。
 *
 * ★ 真几何判据在 `scripts/check-tab-gap.mjs`（三处 × 三个宽度 + 五条反向对照）。
 *   本文件只钉**源码契约**，因为它要进默认门禁（`node --test`），而几何判据要起
 *   Chrome、属于 `--all` 的重型门禁。两道都要：契约拦住「改回硬编码」，
 *   几何拦住「变量改了但算出来不是 8」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const css = stripComments(readFileSync(join(clientDir, 'refinements.css'), 'utf8'));
const panel = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));

/** 三处切换控件：选择器 → 它在 refinements.css 里的那条 margin 规则。 */
const ROWS = [
  ['.npr-filters-primary', 'RSS 一级筛选条'],
  ['.npr-libtabs', '书架分页'],
  ['.npr-diary-modes', '日记三模块'],
];

/** 取某条规则的整段声明（`{ … }`）。找不到就返回空串，由调用方断言。 */
function ruleBody(selector) {
  const escaped = selector.replace(/\./g, '\\.');
  const match = new RegExp(`\\.npr-root ${escaped} \\{([^}]*)\\}`).exec(css);
  return match ? match[1] : '';
}

describe('0.53.3：切换控件的上边距 —— 一个变量，三处引用', () => {
  it('变量 --npr-tab-gap-top 只定义一次', () => {
    const hits = css.match(/--npr-tab-gap-top:/g) ?? [];
    assert.equal(hits.length, 1, `定义了 ${hits.length} 次 —— 两个定义点迟早写出两个数`);
  });

  for (const [selector, label] of ROWS) {
    it(`${label}（${selector}）的上边距引用同一个变量`, () => {
      const body = ruleBody(selector);
      assert.ok(body, `没找到 ${selector} 的规则 —— 选择器改名了？这条判据会静默失效`);
      assert.match(
        body,
        /margin:\s*var\(--npr-tab-gap-top\)/,
        `${selector} 的上边距不是 var(--npr-tab-gap-top)，实际：${body.trim()}`,
      );
    });
  }

  /* ★ 这条是「改回硬编码」的闸门：0.44.5 那版就是 npr-diary-modes 单独写 6px。
     只要三处都引用变量，就不可能出现「一处改了、另两处没跟上」。 */
  it('三处都没有硬编码的上边距', () => {
    for (const [selector, label] of ROWS) {
      const body = ruleBody(selector);
      assert.doesNotMatch(
        body,
        /margin:\s*\d/,
        `${label} 又把上边距写成了数字：${body.trim()}`,
      );
    }
  });

  it('上下等距：下边距也是 8px', () => {
    for (const [selector, label] of ROWS) {
      const body = ruleBody(selector);
      assert.match(body, /8px;?\s*$|\)\s*8px;?/, `${label} 的下边距不是 8px：${body.trim()}`);
    }
  });

  /**
   * ★ 这个变量的取值**与工具栏的下内边距耦合**：画出来的间距 = 工具栏 padding-bottom
   *   + 变量。工具栏改成 6px 而变量不动，三处会一起变成 9px —— 仍然「相等」，
   *   所以只查相等的那条判据看不出来；这条把和钉死。
   */
  it('变量 + 工具栏下内边距 = 8px（画出来的间距）', () => {
    const gapTop = Number(/--npr-tab-gap-top:\s*(\d+)px/.exec(css)?.[1] ?? NaN);
    assert.ok(Number.isFinite(gapTop), '没解析出 --npr-tab-gap-top 的像素值');

    const bar = /\.npr-sidebar-toolbar\{([^}]*)\}/.exec(panel)?.[1] ?? '';
    const padding = /padding:([^;}]+)/.exec(bar)?.[1]?.trim() ?? '';
    const parts = padding.split(/\s+/).map((v) => parseFloat(v));
    assert.ok(parts.length >= 2 && parts.every((n) => Number.isFinite(n)), `工具栏 padding 解析失败：${padding}`);
    /**
     * padding 简写的展开规则（上 右 下 左）：
     *   1 个值 → 四周同值；2 个值 → 上下 / 左右；3 个值 → 上 / 左右 / 下；4 个值 → 上 右 下 左。
     * ⇒ 下边距 = 1 或 2 个值时的第 1 个；3 或 4 个值时的第 3 个。
     */
    const padBottom = parts.length <= 2 ? parts[0] : parts[2];

    assert.equal(
      gapTop + padBottom,
      8,
      `工具栏下内边距 ${padBottom}px + 变量 ${gapTop}px = ${gapTop + padBottom}px，应为 8px`,
    );
  });
});
