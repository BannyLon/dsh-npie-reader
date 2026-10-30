/**
 * 设置齿轮的落点：两个侧栏都必须在**顶部工具栏的最右端**（2026-10-23 用户定）。
 *
 * 为什么是结构判据而不是几何判据：这次的诉求就是「换一个容器」——
 * 「它在工具栏里」与「它不在筛选 chip 行里」两件事，源码里答得干净利落；
 * 而 `.npr-sidebar-toolbar` 里最后那个带 `margin-left: auto` 的按钮天然贴右，
 * 不需要再起一个真 Chrome 去量 3 个像素。
 *
 * ★ 书架的侧栏原先**没有**设置入口（齿轮只长在订阅页的筛选行上）。所以这里同时守
 *   「订阅页挪过来了」与「书架页补上了」—— 两条各自配反向对照。
 *
 * ★ 锚点必须点名选择器（`npr-sidebar-toolbar` / `npr-filters` / `npr-libtabs`）：
 *   只用 `indexOf('npr-settings-button')` 会命中文件里任何一处，判据恒真。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const reader = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));
const app = stripComments(readFileSync(join(clientDir, 'LibraryApp.jsx'), 'utf8'));
const refinements = stripComments(readFileSync(join(clientDir, 'refinements.css'), 'utf8'));

/**
 * 订阅页「筛选 chip 行」那个容器的开标签原文。
 *
 * ★ 必须写**完整**的 class 值：它 0.53.x 起是 `npr-filters npr-filters-primary`。
 *   这里原先写的是 `className="npr-filters"`（少了后面半截），于是 `indexOf` 返回
 *   -1 ⇒ `between` 返回 null ⇒
 *     · 「齿轮在工具栏里」那条**报红**（假阴性，看起来像功能坏了）；
 *     · 「齿轮不在 chip 行里」那条**静默通过**（`null` 被读成「不在里面」）——
 *       假绿，而且是最危险的一种：那条断言从此什么也不守。
 *   ⇒ 锚点必须点名真实的字符串，并且 `between` 找不到锚点时**抛错**，不许返回 null。
 */
const FILTERS_ROW = 'className="npr-filters npr-filters-primary"';

/** 两个锚点之间的那段源码。★ 任一锚点找不到就**抛错** —— 静默返回 null 会把
 *  「不在里面」和「根本没找到这段」混成同一个结论（上一条注释里那个假绿就是这么来的）。 */
function between(code, from, to) {
  const start = code.indexOf(from);
  assert.notEqual(start, -1, `锚点不存在：${from}`);
  const end = code.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `结束锚点不存在：${to}`);
  return code.slice(start, end);
}

/** 齿轮是否落在某个区段里。 */
function settingsButtonIn(code, from, to) {
  return between(code, from, to).includes('npr-settings-button');
}

const GEAR = '<button type="button" className="npr-icon npr-settings-button" title="插件设置" aria-label="插件设置"';

describe('设置齿轮：两个侧栏都在工具栏最右端', () => {
  it('订阅页：齿轮在侧栏工具栏里（筛选行之前）', () => {
    assert.equal(settingsButtonIn(reader, 'className="npr-sidebar-toolbar"', FILTERS_ROW), true,
      '订阅页的齿轮不在工具栏里');
  });

  it('订阅页：筛选 chip 行里不再有齿轮', () => {
    assert.equal(settingsButtonIn(reader, FILTERS_ROW, 'npr-search-box'), false,
      '齿轮还在筛选行里 —— chip 行是「筛当前列表」，混进整页动作会被读成第四个筛选项');
  });

  it('书架页：工具栏里有齿轮（0.20.1 之前完全没有入口）', () => {
    assert.equal(settingsButtonIn(app, 'className="npr-sidebar-toolbar"', 'className="npr-libtabs"'), true,
      '书架页没有设置齿轮');
  });

  it('书架页的齿轮直接落在「电子书书架」那一页', () => {
    const region = between(app, 'npr-settings-button', '</div>');
    assert.match(region, /tab:\s*'library'/,
      '从书架点进来的设置没有落在书架那一页 —— 要改书源的人还得再点一次左侧导航');
  });

  it('CSS：工具栏那条规则接管了 margin-left:auto，刷新按钮不再抢右端', () => {
    assert.match(reader, /\.npr-sidebar-toolbar \.npr-settings-button\s*\{[^}]*margin-left:auto/,
      '工具栏里的齿轮没有贴右');
    assert.doesNotMatch(reader, /\.npr-filters \.npr-settings-button/,
      '筛选行那条齿轮样式还在（搬走之后它只会误导下一个人）');
    const refreshRule = refinements.match(/\n\.npr-lib-refresh\s*\{([^}]*)\}/);
    assert.notEqual(refreshRule, null, '没找到 `.npr-lib-refresh` 的规则');
    assert.doesNotMatch(refreshRule[1], /margin-left:\s*auto/,
      '刷新按钮还在抢右端：两个 auto 会平分空档，齿轮贴不到边');
  });

  it('★ 反向对照：把齿轮放回筛选行 ⇒ 两条判据都变红', () => {
    const before = reader.replace(GEAR, '').replace(
      FILTERS_ROW,
      `${FILTERS_ROW}>\n            ${GEAR}/>`,
    );
    assert.notEqual(before, reader, '替换没生效，反向对照是假绿');
    assert.equal(settingsButtonIn(before, 'className="npr-sidebar-toolbar"', FILTERS_ROW), false);
    assert.equal(settingsButtonIn(before, FILTERS_ROW, 'npr-search-box'), true);
  });

  it('★ 反向对照：书架页删掉齿轮 ⇒ 那条判据变红', () => {
    const before = app.replace(GEAR, '');
    assert.notEqual(before, app, '替换没生效，反向对照是假绿');
    assert.equal(settingsButtonIn(before, 'className="npr-sidebar-toolbar"', 'className="npr-libtabs"'), false);
  });
});
