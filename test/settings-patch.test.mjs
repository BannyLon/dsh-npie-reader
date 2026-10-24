/**
 * 「保存设置」的提交范围（`src/client/settings-patch.js`）—— **真跑**，不是源码断言。
 *
 * 这里守的是 2026-10-23 用户实测的那个缺陷：
 *   在「电子书书架」里加一个本地目录（界面立刻出现、磁盘也写了）→ 点「保存设置」→
 *   目录消失、「生成书单 / 载入到书架」两步回到打开弹窗时的样子。
 *
 * ★ 为什么必须真跑：这条判据的形状是「两份 state 合并之后还在不在」，而字符串断言
 *   （「代码里有没有过滤 bookSources」）答不了它 —— 过滤了也可能过滤错字段名，
 *   而字段名写错时宿主那边**不会报错**，只会安静地把数组清空。
 *
 * ★ 每条判据都配**反向对照**：把「整份快照直接提交」那一版（即修之前的行为）喂进
 *   同一个模拟宿主，必须**丢掉**刚加的书源。否则这组用例只是把修复抄了一遍。
 *
 * ★ 模拟的宿主形状取自真源码：`src/host/service.js` 的 `saveSettings` 是
 *     `Object.assign(this.store.data.settings, validateSettings(patch))`
 *   而 `validateSettings` 认可 `bookSources` / `libraryListIds`（见 `src/reading-settings.js`）。
 *   所以这里直接用真的 `validateSettings`，不另写一份「像宿主那样」的校验。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIVE_WRITTEN_SETTINGS, pageOwnedPatch } from '../src/client/settings-patch.js';
import { READING_DEFAULTS, validateSettings } from '../src/reading-settings.js';

/** 宿主的写盘语义（与 `service.js` 的 `saveSettings` 同形）。 */
function hostSave(store, patch) {
  Object.assign(store, validateSettings(patch));
  return store;
}

/** 一套「打开弹窗时」的设置：两条书源 + 已经载入一份书单。 */
function snapshotWithTwoSources() {
  const sources = validateSettings({
    bookSources: [{ kind: 'local', path: '/Users/habhy/Books' }, { kind: 'pan', path: '/E书拾取' }],
  }).bookSources;
  return {
    ...READING_DEFAULTS,
    bookSources: sources,
    libraryListIds: [sources[0].id],
  };
}

/** 用户在弹窗里改了外观（本页拥有的字段）。 */
const APPEARANCE_EDIT = { fontSize: 22, readingTheme: 'paper' };

describe('pageOwnedPatch：不把别人在写的字段提交回去', () => {
  it('只去掉 bookSources / libraryListIds，其余字段一个不少', () => {
    const snapshot = { ...snapshotWithTwoSources(), ...APPEARANCE_EDIT };
    const patch = pageOwnedPatch(snapshot);
    assert.equal(Object.hasOwn(patch, 'bookSources'), false);
    assert.equal(Object.hasOwn(patch, 'libraryListIds'), false);
    assert.equal(patch.fontSize, 22);
    assert.equal(patch.readingTheme, 'paper');
    // 其余默认项也要在：漏掉它们等于「保存设置」把这些项重置成默认值。
    for (const key of Object.keys(READING_DEFAULTS)) {
      if (LIVE_WRITTEN_SETTINGS.includes(key)) continue;
      assert.equal(Object.hasOwn(patch, key), true, `patch 里缺了 ${key}`);
    }
  });

  it('不修改入参（后面的 `setSettings(result.settings)` 依赖快照本身还在）', () => {
    const snapshot = snapshotWithTwoSources();
    const before = JSON.stringify(snapshot);
    pageOwnedPatch(snapshot);
    assert.equal(JSON.stringify(snapshot), before);
  });

  it('非对象一律当空 patch —— 读设置失败时不该把整份配置写坏', () => {
    assert.deepEqual(pageOwnedPatch(null), {});
    assert.deepEqual(pageOwnedPatch(undefined), {});
    assert.deepEqual(pageOwnedPatch('x'), {});
  });

  it('★ 反向对照：整份快照直接提交 ⇒ 刚加的书源被旧快照盖掉（这就是修之前的行为）', () => {
    const store = snapshotWithTwoSources();
    const snapshot = JSON.parse(JSON.stringify(store));
    // 弹窗开着时，BookSources 走 POST /sources 直接写盘，多了一条本地目录：
    store.bookSources = validateSettings({
      bookSources: [...store.bookSources, { kind: 'local', path: '/NPIE_Book' }],
    }).bookSources;
    assert.equal(store.bookSources.length, 3);
    // 修之前：整份快照提交 → 回到 2 条（用户看到的就是「添加不成功」）。
    hostSave(store, snapshot);
    assert.equal(store.bookSources.length, 2, '反向对照失效：整份提交竟然没覆盖掉新书源');
  });

  it('★ 修复后：同样的一次保存，新书源留住了，外观改动也生效了', () => {
    const store = snapshotWithTwoSources();
    const snapshot = JSON.parse(JSON.stringify(store));
    store.bookSources = validateSettings({
      bookSources: [...store.bookSources, { kind: 'local', path: '/NPIE_Book' }],
    }).bookSources;
    store.libraryListIds = [...store.libraryListIds, store.bookSources[1].id];

    hostSave(store, pageOwnedPatch({ ...snapshot, ...APPEARANCE_EDIT }));

    assert.equal(store.bookSources.length, 3, '新加的书源被保存设置覆盖了');
    assert.equal(store.bookSources.some((source) => source.path === '/NPIE_Book'), true);
    assert.equal(store.libraryListIds.length, 2, '第三步的勾选被保存设置覆盖了');
    assert.equal(store.fontSize, 22, '本页的改动没有生效');
    assert.equal(store.readingTheme, 'paper');
  });
});
