/**
 * 四个视图共用一份左侧栏宽度（0.71.0）。
 *
 * 用户 2026-11-06：「以目前 RSS 阅读左侧边栏的宽度再增加一些为准，进行统一」。
 * 这条测试同时钉住**数值**和**接线**：
 *   - 数值：默认 380（0.88.0 从 340 再抬，RSS 那一行加到八项）、下限 288 / 上限 520；
 *   - 接线：四个视图都从 `sidebar-width.js` 读、都把 `--npr-list-width` 交给同一套
 *     `.npr-layout` 网格 —— 只改一处常量、漏接一个视图时界面照样会「切一下跳一下」，
 *     而这正是靠肉眼最容易看漏的那类错。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH, SIDEBAR_WIDTH_KEY,
  clampSidebarWidth, readSidebarWidth, saveSidebarWidth,
} from '../src/client/sidebar-width.js';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const sourceOf = (name) => readFileSync(join(clientDir, name), 'utf8');
const VIEWS = ['ReaderPage.jsx', 'LibraryApp.jsx', 'PapersApp.jsx', 'DiaryApp.jsx'];

/** localStorage 的最小替身；每个用例前重置，避免互相串味。 */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
  };
  return data;
}

describe('共用宽度的数值', () => {
  it('基准比 RSS 原 300 宽两次：0.71.0 → 340，0.88.0 → 380', () => {
    assert.equal(SIDEBAR_WIDTH, 380);
    assert.equal(SIDEBAR_MIN_WIDTH, 288);
    assert.equal(SIDEBAR_MAX_WIDTH, 520);
    assert.ok(SIDEBAR_WIDTH > 340, '没比上一版宽');
  });

  it('夹取：低于下限抬到下限、高于上限压到上限、坏值回落基准', () => {
    assert.equal(clampSidebarWidth(220), SIDEBAR_MIN_WIDTH);
    assert.equal(clampSidebarWidth(999), SIDEBAR_MAX_WIDTH);
    assert.equal(clampSidebarWidth('abc'), SIDEBAR_WIDTH);
    assert.equal(clampSidebarWidth(undefined), SIDEBAR_WIDTH);
    assert.equal(clampSidebarWidth(377.6), 378);
  });
});

describe('共用 key 与迁移', () => {
  it('没有任何存储时读回基准', () => {
    fakeStorage();
    assert.equal(readSidebarWidth(), SIDEBAR_WIDTH);
  });

  it('写一次之后读回同一个值，且落在共用 key 上', () => {
    const data = fakeStorage();
    assert.equal(saveSidebarWidth(412), 412);
    assert.equal(data.get(SIDEBAR_WIDTH_KEY), '412');
    assert.equal(readSidebarWidth(), 412);
  });

  it('旧 RSS key = 300 时整体抬到基准（不缩窄用户拖宽过的界面）', () => {
    fakeStorage({ 'npr.listWidth': '300' });
    assert.equal(readSidebarWidth(), SIDEBAR_WIDTH);
    fakeStorage({ 'npr.listWidth': '420' });
    assert.equal(readSidebarWidth(), 420);
  });

  it('旧 RSS key = 220 时抬到统一基准，不复发窄屏换行', () => {
    fakeStorage({ 'npr.listWidth': '220' });
    assert.equal(readSidebarWidth(), SIDEBAR_WIDTH);
    assert.ok(readSidebarWidth() >= SIDEBAR_MIN_WIDTH);
  });

  it('新 key 优先，旧 key 不覆盖用户刚拖过的宽度', () => {
    fakeStorage({ [SIDEBAR_WIDTH_KEY]: '380', 'npr.listWidth': '500' });
    assert.equal(readSidebarWidth(), 380);
  });

  it('★ 上一版基准 340 会被抬到 380，而且**只抬一次**', () => {
    // 0.88.0：抬默认值对已经存过值的用户无效，所以配了一次基准版本迁移。
    const data = fakeStorage({ [SIDEBAR_WIDTH_KEY]: '340' });
    assert.equal(readSidebarWidth(), SIDEBAR_WIDTH);
    assert.equal(data.get(SIDEBAR_WIDTH_KEY), String(SIDEBAR_WIDTH));
    // 抬过之后用户自己拖窄到 300 —— 下一次挂载必须尊重它，不能又顶回 380。
    data.set(SIDEBAR_WIDTH_KEY, '300');
    assert.equal(readSidebarWidth(), 300, '迁移在每次挂载都生效 —— 用户拖窄的动作被反复顶回去');
  });

  it('★ 用户拖宽过（460）时，「抬宽」不会把他缩回 380', () => {
    fakeStorage({ [SIDEBAR_WIDTH_KEY]: '460' });
    assert.equal(readSidebarWidth(), 460);
  });

  it('★ 亲手拖过的宽度会记下版本，下一次挂载不把它抬回去', () => {
    fakeStorage();
    assert.equal(saveSidebarWidth(310), 310);
    assert.equal(readSidebarWidth(), 310, 'save 没记版本 ⇒ 用户拖窄的宽度立刻被抬回基准');
  });
});

describe('四个视图都接在同一份宽度上', () => {
  for (const name of VIEWS) {
    it(`${name} 读共用模块 + 把 --npr-list-width 交给 .npr-layout`, () => {
      const source = sourceOf(name);
      assert.match(source, /from '\.\/sidebar-width\.js'/, `${name} 没 import 共用宽度模块`);
      assert.match(source, /useState\(readSidebarWidth\)/, `${name} 首屏没读共用宽度`);
      assert.match(source, /--npr-list-width/, `${name} 没把宽度交给布局网格`);
      assert.doesNotMatch(source, /npr\.libListWidth|npr\.diaryListWidth/, `${name} 还在写自己的旧 key`);
    });
  }

  it('旧的三份私有 key 只剩共用模块里那一条迁移读取', () => {
    const legacy = /'npr\.listWidth'/;
    assert.match(sourceOf('sidebar-width.js'), legacy, '共用模块没有读旧 RSS key 做迁移');
    for (const name of VIEWS) {
      assert.doesNotMatch(sourceOf(name), /'npr\.listWidth'/, `${name} 仍直接读旧 key`);
    }
  });

  it('双击复位统一到同一个基准（不再各写 300 / 320 / 268）', () => {
    for (const name of VIEWS) {
      assert.match(sourceOf(name), /saveSidebarWidth\(SIDEBAR_WIDTH\)/, `${name} 的双击复位没走共用基准`);
    }
  });
});
