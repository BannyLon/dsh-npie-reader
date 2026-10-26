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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { LIVE_WRITTEN_SETTINGS, pageOwnedPatch } from '../src/client/settings-patch.js';
import { APPEARANCE_KEYS, READING_DEFAULTS, appearanceDefaults, validateSettings } from '../src/reading-settings.js';
import { stripComments } from '../scripts/strip-comments.mjs';

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

/**
 * 「阅读外观」浮层里的「恢复默认」——**同一个缺陷换了个入口**。
 *
 * 2026-10-25 实测：`ReadingAppearance.jsx` 的按钮提交 `{ ...READING_DEFAULTS }`，
 * 而宿主是整份 `Object.assign` ⇒ 点一下「恢复默认」，书源 / 外部书单路径 /
 * 翻译与解读模型**一起被清空**。复现脚本的输出：`bookSources: []`、`libraryPath: ''`。
 *
 * ★ 判据全部**真跑**（走真的 `validateSettings` + 与宿主同形的 `hostSave`）：
 *   这条缺陷的形状是「一次写入之后哪些字段变了」，字符串断言答不了。
 */
describe('appearanceDefaults：「恢复默认」只动外观', () => {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  it('只含这一屏渲染的字段，且与面板里的控件一一对应', () => {
    // 面板（`ReadingControls`）渲染的正是这 8 个；多一个少一个都说明集合漂移了。
    assert.deepEqual(
      [...APPEARANCE_KEYS].sort(),
      ['customFont', 'defaultVersion', 'fontSize', 'lineHeight', 'readingFont', 'readingTheme', 'showImages', 'textWidth'],
    );
    const patch = appearanceDefaults();
    assert.deepEqual(Object.keys(patch).sort(), [...APPEARANCE_KEYS].sort());
    // 取值与 `READING_DEFAULTS` 同源（不另抄一份默认值）。
    for (const key of APPEARANCE_KEYS) assert.equal(patch[key], READING_DEFAULTS[key], `${key} 的默认值漂了`);
  });

  it('不含任何「别人在写」或「不属于外观」的字段', () => {
    const patch = appearanceDefaults();
    for (const key of LIVE_WRITTEN_SETTINGS) assert.equal(Object.hasOwn(patch, key), false, `${key} 不该进恢复默认`);
    for (const key of ['libraryPath', 'aiModel', 'digestModel', 'bookshelf', 'bookTint', 'bookBrightness']) {
      assert.equal(Object.hasOwn(patch, key), false, `${key} 不属于阅读外观`);
    }
  });

  it('★ 真跑：点一次「恢复默认」之后，书源 / 书单路径 / 模型都还在', () => {
    const store = snapshotWithTwoSources();
    Object.assign(store, {
      libraryPath: '/Users/habhy/my-books.json',
      aiModel: 'deepseek/deepseek-chat',
      digestModel: 'deepseek/deepseek-chat',
      fontSize: 22,
      readingTheme: 'dark',
    });

    hostSave(store, appearanceDefaults());

    assert.equal(store.bookSources.length, 2, '书源被「恢复默认」清空了');
    assert.deepEqual(store.libraryListIds.length, 1);
    assert.equal(store.libraryPath, '/Users/habhy/my-books.json', '外部书单路径被清空了');
    assert.equal(store.aiModel, 'deepseek/deepseek-chat', '翻译模型被改回默认了');
    assert.equal(store.digestModel, 'deepseek/deepseek-chat');
    // 外观本身确实回到默认 —— 否则这条修复就成了「按钮没反应」。
    assert.equal(store.fontSize, READING_DEFAULTS.fontSize);
    assert.equal(store.readingTheme, READING_DEFAULTS.readingTheme);
  });

  it('★ 反向对照：提交整份 READING_DEFAULTS ⇒ 书源与模型必须被清空（修之前的行为）', () => {
    const store = snapshotWithTwoSources();
    Object.assign(store, { libraryPath: '/x/books.json', aiModel: 'p/m' });

    hostSave(store, { ...READING_DEFAULTS });

    assert.equal(store.bookSources.length, 0, '反向对照失效：整份默认值竟然没清掉书源');
    assert.equal(store.libraryPath, '');
    assert.equal(store.aiModel, '');
  });

  it('★ 源码守卫：面板不许再直接提交 READING_DEFAULTS', () => {
    // ★ 必须**先剥注释**再查：解释这条缺陷的注释里就写着 `...READING_DEFAULTS`
    //   （反面教材），不剥的话守卫会被自己的注释命中 —— 与「拿裸字符串当守卫」
    //   是同一类失效（见 `book-render.test.mjs` 里 `readCode` 的注释）。
    const source = stripComments(readFileSync(join(pluginRoot, 'src/client/ReadingAppearance.jsx'), 'utf8'));
    assert.equal(source.includes('...READING_DEFAULTS'), false, '「恢复默认」又回到整份默认值了');
    assert.match(source, /onClick=\{\(\) => set\(appearanceDefaults\(\)\)\}/, '「恢复默认」没有走 appearanceDefaults()');
  });
});
