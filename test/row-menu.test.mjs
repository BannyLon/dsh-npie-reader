/**
 * 列表行右键菜单（0.45.4）。
 *
 * 用户 2026-10-29 的原话：「能不能在 RSS 阅读侧边栏 rss 文章列表中，每一篇文章，
 * 可以弹出操作菜单：1、打印 / 存为 PDF；2、导出 Markdown；3、隐藏这篇文章。」
 * 三个选项里他选了**只要右键**（不新增常驻按钮、不做悬停按钮）。
 *
 * ★ 这里钉的是「错了也看不出来」的两件事：
 *   ① **位置**：菜单贴着窗口右缘 / 底边弹出时会被裁掉一半 —— 它不报错，只是点不到；
 *   ② **项目**：在「已隐藏」筛选下列表里，第三项必须是「恢复这篇文章」，否则
 *      点下去页面什么都不变（它本来就隐藏着），用户会以为按钮坏了。
 * ★ 另外三条源码级判据守的是「接线」：行上真的挂了 `onContextMenu`、键盘有等价键位、
 *   菜单项真的来自 `rowMenuItems`（而不是在这里又写死一份文案）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ROW_MENU_HEIGHT, ROW_MENU_WIDTH, placeRowMenu, rowMenuItems } from '../src/client/row-menu.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const READER = stripComments(readFileSync(join(ROOT, 'src/client/ReaderPage.jsx'), 'utf8'));
const CSS = stripComments(readFileSync(join(ROOT, 'src/client/refinements.css'), 'utf8'));

describe('rowMenuItems', () => {
  it('三项、顺序固定：打印 → Markdown → 隐藏', () => {
    const items = rowMenuItems({ hidden: false });
    assert.deepEqual(items.map((item) => item.kind), ['print', 'markdown', 'hide']);
    assert.deepEqual(items.map((item) => item.label), ['打印 / 存为 PDF', '导出 Markdown', '隐藏这篇文章']);
  });

  it('★ 已隐藏的那篇，第三项换成「恢复」——同一个位置的两态，不是两条并列项', () => {
    const items = rowMenuItems({ hidden: true });
    assert.equal(items.length, 3, '隐藏与恢复必须是同一位置的两态；并列成四项就说明这里写成了两条');
    assert.equal(items[2].kind, 'unhide');
    assert.equal(items[2].label, '恢复这篇文章');
    // ★ 反向对照：前三项里不许再出现「隐藏」，否则「已隐藏」列表里会有一条点了没反应的假话
    assert.equal(items.some((item) => item.kind === 'hide'), false);
  });

  it('`hidden` 缺省 / 为假都按「未隐藏」处理（列表接口老版本没有这个字段也不会炸）', () => {
    assert.equal(rowMenuItems({}).at(-1).kind, 'hide');
    assert.equal(rowMenuItems(undefined).at(-1).kind, 'hide');
  });

  it('两种状态项有且只有一个（不变量）', () => {
    for (const hidden of [true, false, undefined]) {
      const states = rowMenuItems({ hidden }).filter((item) => item.kind === 'hide' || item.kind === 'unhide');
      assert.equal(states.length, 1, `hidden=${hidden} 时状态项有 ${states.length} 个`);
    }
  });

  /**
   * 图标名必须是 `icons.jsx` 的 `PATHS` 里真有的键。
   *
   * ★ 这条本来由 `test/icons.test.mjs` 统一守，但那边只扫 JSX 里 `name="…"` 的**字面量**；
   *   菜单项的图标名放在 `row-menu.js` 的数据表里（不放进 JSX 的三元，否则三元里的
   *   `'print'` / `'markdown'` 会被当成图标名），于是那条守卫覆盖不到这里。
   *   缺了这条，写错一个名字的后果是**静默画一个圆圈** —— 而圆圈看起来像有意为之。
   */
  it('★ 图标都存在（写错会静默退化成圆圈，界面上看不出来）', () => {
    const icons = readFileSync(join(ROOT, 'src/client/icons.jsx'), 'utf8');
    const start = icons.indexOf('const PATHS');
    const end = icons.indexOf('export function Icon');
    assert.ok(start >= 0 && end > start, 'icons.jsx 的 PATHS / Icon 锚点已失效');
    const defined = new Set();
    for (const match of icons.slice(start, end).matchAll(/^\s{2}'?([a-z][a-z0-9-]*)'?:\s*\[/gm)) defined.add(match[1]);
    for (const item of rowMenuItems({ hidden: false })) {
      assert.equal(defined.has(item.icon), true, `${item.kind} 的图标「${item.icon}」不在 PATHS 里`);
    }
  });
});

describe('placeRowMenu', () => {
  const VIEW = { viewportWidth: 1440, viewportHeight: 900 };

  it('鼠标在窗口中间：菜单左上角就落在鼠标处', () => {
    assert.deepEqual(placeRowMenu({ x: 300, y: 400, ...VIEW }), { left: 300, top: 400 });
  });

  it('★ 贴右缘 / 底边：被推回视口内，不会有一半在窗口外', () => {
    const spot = placeRowMenu({ x: 1430, y: 890, ...VIEW });
    assert.ok(spot.left + ROW_MENU_WIDTH <= VIEW.viewportWidth - 8, `右缘溢出：left=${spot.left}`);
    assert.ok(spot.top + ROW_MENU_HEIGHT <= VIEW.viewportHeight - 8, `底边溢出：top=${spot.top}`);
    // 推回界内而不是翻到左边：位置对鼠标仍然是连续的变化
    assert.ok(spot.left > VIEW.viewportWidth / 2, '被推到了左半屏 —— 那是「翻转」而不是「夹取」');
  });

  it('左上越界（坐标为负 / 为 0）时留出 margin，不贴死窗口边', () => {
    assert.deepEqual(placeRowMenu({ x: 0, y: 0, ...VIEW }), { left: 8, top: 8 });
    assert.deepEqual(placeRowMenu({ x: -40, y: -40, ...VIEW }), { left: 8, top: 8 });
  });

  it('★ 视口比菜单还窄时，left 仍是正数（不会被算到窗口左边看不见的地方）', () => {
    const spot = placeRowMenu({ x: 100, y: 100, viewportWidth: 120, viewportHeight: 90 });
    assert.equal(spot.left, 8);
    assert.equal(spot.top, 8);
    assert.ok(spot.left >= 0 && spot.top >= 0);
  });

  it('自定义 margin 真的生效', () => {
    assert.deepEqual(placeRowMenu({ x: 0, y: 0, ...VIEW, margin: 20 }), { left: 20, top: 20 });
  });
});

describe('接线（源码级）', () => {
  it('列表行上挂了右键盘事件，并且拦掉了宿主的系统菜单', () => {
    assert.match(READER, /onContextMenu=\{\(event\) => openRowMenu\(event, entry\)\}/);
    // preventDefault 缺了就会同时弹出 Electron 的系统菜单（重新加载 / 检查元素 / 打印）
    const fn = /const openRowMenu = \(event, entry\) => \{([\s\S]*?)\n  \};/.exec(READER);
    assert.ok(fn, '没找到 openRowMenu —— 判据失效，先确认它没被改名');
    assert.match(fn[1], /event\.preventDefault\(\)/);
    assert.match(fn[1], /event\.stopPropagation\(\)/);
  });

  it('键盘有等价键位（右键菜单本身不可 Tab 到达）', () => {
    assert.match(READER, /event\.key === 'ContextMenu'/);
    assert.match(READER, /event\.shiftKey && event\.key === 'F10'/);
  });

  it('菜单项来自 rowMenuItems，不是在这里又写死一份文案', () => {
    assert.match(READER, /\{rowMenuItems\(entry\)\.map\(/);
    // 反向对照：渲染处不该出现整句文案（那样两处会各自漂）
    const block = /\{rowMenuItems\(entry\)\.map\(\(item\) => \(([\s\S]*?)\)\)\}/.exec(READER);
    assert.ok(block, '没找到菜单项渲染块');
    assert.equal(/打印 \/ 存为 PDF/.test(block[1]), false, '菜单里又写死了一份「打印 / 存为 PDF」');
  });

  it('★ 打印 / 导出走的是「按需取正文」，不经过 openArticle（那会把文章标成已读）', () => {
    const fn = /const runRowAction = async \(kind, key\) => \{([\s\S]*?)\n  \};/.exec(READER);
    assert.ok(fn, '没找到 runRowAction');
    assert.match(fn[1], /api\.getArticle\(key\)/, '必须自己取正文');
    assert.equal(/openArticle\(/.test(fn[1]), false, '调了 openArticle —— 导出/打印会顺手把文章标成已读');
    assert.match(fn[1], /printArticle\(/);
    assert.match(fn[1], /articleToMarkdown\(/);
    // 隐藏 / 恢复复用的是同一个实现，不另写一份
    assert.match(fn[1], /hideArticle\(key\)/);
    assert.match(fn[1], /unhideArticle\(key\)/);
  });

  it('★ 关闭有四条路：点外面、Esc、滚动、resize —— 缺一条就是关不掉的浮层', () => {
    const effect = /if \(!rowMenu\) return undefined;([\s\S]*?)\}, \[rowMenu\]\);/.exec(READER);
    assert.ok(effect, '没找到右键菜单的关闭 effect');
    assert.match(effect[1], /'pointerdown'/, '点外面关不掉');
    assert.match(effect[1], /'Escape'/, 'Esc 关不掉');
    assert.match(effect[1], /'scroll'/, '列表滚走后菜单会浮在别的文章上');
    assert.match(effect[1], /'resize'/, '窗口变化后位置会错');
  });

  it('菜单打开时全局快捷键让位（j/k、L 不许在浮层开着时改选中的文章）', () => {
    // 两条守卫都必须带上 rowMenu
    const guards = READER.match(/if \(dialog \|\| pickerOpen \|\| askContext \|\| appearanceOpen \|\| menuOpen \|\|[^\n]*\) return;/g) ?? [];
    assert.equal(guards.length, 2, `找到 ${guards.length} 条全局守卫，预期 2 条`);
    for (const line of guards) assert.match(line, /rowMenu/, `守卫没带 rowMenu：${line.slice(0, 60)}…`);
  });
});

describe('样式与常量同源', () => {
  it('CSS 里的宽度就是 ROW_MENU_WIDTH（不一致 ⇒ 贴右缘时菜单被裁）', () => {
    const rule = /\.npr-menu\.npr-rowmenu\s*\{([^}]*)\}/.exec(CSS);
    assert.ok(rule, 'refinements.css 里没有 .npr-menu.npr-rowmenu 规则');
    const width = /width:\s*(\d+)px/.exec(rule[1]);
    assert.ok(width, '那条规则没写死 width —— 夹取要用的数就没了来源');
    assert.equal(Number(width[1]), ROW_MENU_WIDTH);
  });

  it('定位必须是 fixed（坐标来自鼠标，不是某个容器的相对位置）', () => {
    const rule = /\.npr-menu\.npr-rowmenu\s*\{([^}]*)\}/.exec(CSS);
    assert.match(rule[1], /position:\s*fixed/);
    // 反向对照：.npr-menu 原规则是 absolute + right:0，必须被覆盖掉
    assert.match(rule[1], /right:\s*auto/);
    assert.match(rule[1], /top:\s*auto/);
  });

  it('菜单高度常量与「三项 × 行高 + 内边距」大致对得上', () => {
    // 只做一个量级校验：3 项各 32px + 上下各 5px = 106。差太多说明项数变了却没改常量。
    assert.equal(ROW_MENU_HEIGHT, 3 * 32 + 2 * 5);
  });
});
