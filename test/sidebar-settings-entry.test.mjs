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

/** 两个锚点之间的那段源码；任一锚点找不到就返回 null（判据必须报错，不能静默通过）。 */
function between(code, from, to) {
  const start = code.indexOf(from);
  if (start === -1) return null;
  const end = code.indexOf(to, start + from.length);
  if (end === -1) return null;
  return code.slice(start, end);
}

/** 齿轮是否落在某个区段里。 */
function settingsButtonIn(code, from, to) {
  const region = between(code, from, to);
  return region !== null && region.includes('npr-settings-button');
}

const GEAR = '<button type="button" className="npr-icon npr-settings-button" title="插件设置" aria-label="插件设置"';

describe('设置齿轮：两个侧栏都在工具栏最右端', () => {
  it('订阅页：齿轮在侧栏工具栏里（筛选行之前）', () => {
    assert.equal(settingsButtonIn(reader, 'className="npr-sidebar-toolbar"', 'className="npr-filters"'), true,
      '订阅页的齿轮不在工具栏里');
  });

  it('订阅页：筛选 chip 行里不再有齿轮', () => {
    assert.equal(settingsButtonIn(reader, 'className="npr-filters"', 'npr-search-box'), false,
      '齿轮还在筛选行里 —— chip 行是「筛当前列表」，混进整页动作会被读成第四个筛选项');
  });

  it('书架页：工具栏里有齿轮（0.20.1 之前完全没有入口）', () => {
    assert.equal(settingsButtonIn(app, 'className="npr-sidebar-toolbar"', 'className="npr-libtabs"'), true,
      '书架页没有设置齿轮');
  });

  it('书架页的齿轮直接落在「电子书书架」那一页', () => {
    const region = between(app, 'npr-settings-button', '</div>');
    assert.notEqual(region, null);
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
      'className="npr-filters"',
      `className="npr-filters">\n            ${GEAR}/>`,
    );
    assert.notEqual(before, reader, '替换没生效，反向对照是假绿');
    assert.equal(settingsButtonIn(before, 'className="npr-sidebar-toolbar"', 'className="npr-filters"'), false);
    assert.equal(settingsButtonIn(before, 'className="npr-filters"', 'npr-search-box'), true);
  });

  it('★ 反向对照：书架页删掉齿轮 ⇒ 那条判据变红', () => {
    const before = app.replace(GEAR, '');
    assert.notEqual(before, app, '替换没生效，反向对照是假绿');
    assert.equal(settingsButtonIn(before, 'className="npr-sidebar-toolbar"', 'className="npr-libtabs"'), false);
  });
});
