/**
 * 「专注阅读」不许漏进书架页（`src/client/ReaderPage.jsx`）。
 *
 * 缺陷（用户 2026-10-23 真机）：从宿主侧栏打开阅读器、点侧栏的「阅读」，书架**左侧那份
 * 书单不见了**，只剩右边那张欢迎页；同一个面板换一次视图又恢复正常。
 *
 * ★ 失效链（每一环都在真源码里，判据逐环守着）：
 *   ① `mode` 从 localStorage 恢复成 `library`；
 *   ② 面板挂载时还会「自动打开上次那篇文章」→ `openArticle`；
 *   ③ `openArticle` 里有一条「宽度 < 460 就自动进专注模式」（挂载那一帧宽度还没铺开）；
 *   ④ `focused` 只体现在 `.npr-root` 的类名上、**不区分是哪一页**；
 *   ⑤ 而 `.npr-root.npr-focus .npr-sidebar{display:none}` 会把书架自己的书单一起藏掉。
 *
 * ★ 为什么是源码级：这条判据的形状是「类名挂没挂」，真跑需要 DOM + 宿主槽位；
 *   而缺陷的**因果**恰好全在静态结构里（类名条件 + 那条 CSS）。所以这里守结构，
 *   并给每条判据配**反向对照**（把修之前那一版喂进来必须变红）。
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

/**
 * 取根节点 className 模板串里的条件表达式（`npr-root${…}`）。
 * 返回 null 表示锚点没对上 —— 那时判据必须报错，而不是静默通过。
 */
function focusConditionOf(code) {
  const found = code.match(/className=\{`npr-root\$\{([^}]*)\}`\}/);
  return found === null ? null : found[1].trim();
}

/** 这个条件只在订阅页才允许挂 `npr-focus`。 */
function scopedToFeeds(condition) {
  if (typeof condition !== 'string') return false;
  return /mode\s*===\s*'feeds'/.test(condition) || /mode\s*!==\s*'library'/.test(condition);
}

/** 切到书架时有没有把专注状态复位。 */
function resetsFocusOnLibrary(code) {
  return /if\s*\(\s*mode\s*===\s*'library'\s*\)\s*setFocused\(false\)/.test(code);
}

describe('专注阅读不得泄漏到书架页', () => {
  it('锚点存在：根节点的类名里真的有 npr-focus 这个分支', () => {
    const condition = focusConditionOf(reader);
    assert.notEqual(condition, null, '没找到 `npr-root${…}` 那个 className —— 锚点失效');
    assert.match(condition, /npr-focus/, '条件里没有 npr-focus，判据失去意义');
  });

  it('① 类名必须按模式收紧（书架页永不挂 npr-focus）', () => {
    assert.equal(scopedToFeeds(focusConditionOf(reader)), true,
      '`npr-focus` 没有按 mode 收紧 —— 书架页的书单会被 display:none 藏掉');
  });

  it('② 切到书架时必须把 focused 复位（否则回订阅页会莫名进一次专注）', () => {
    assert.equal(resetsFocusOnLibrary(reader), true, '没有 `if (mode === \'library\') setFocused(false)`');
  });

  it('★ 反向对照：修之前那一版（`focused ? \' npr-focus\' : \'\'`）必须被判红', () => {
    const before = reader.replace(focusConditionOf(reader), "focused ? ' npr-focus' : ''");
    assert.notEqual(before, reader, '替换没生效，反向对照是假绿');
    assert.equal(scopedToFeeds(focusConditionOf(before)), false);
  });

  it('★ 反向对照：去掉复位 effect 之后，判据必须变红', () => {
    const before = reader.replace(/if\s*\(\s*mode\s*===\s*'library'\s*\)\s*setFocused\(false\)/g, '');
    assert.equal(resetsFocusOnLibrary(before), false);
  });

  it('守它的理由还在：那条「隐藏侧栏」的 CSS 与书架的侧栏都还在', () => {
    // 若哪天 `.npr-focus` 不再隐藏侧栏，这两条判据就该重新评估（而不是继续假装在守）。
    assert.match(reader, /\.npr-root\.npr-focus \.npr-sidebar[^{]*\{[^}]*display:none/,
      '隐藏侧栏的规则没了 —— 请重新评估这两条判据是否还有意义');
    assert.match(app, /<aside className="npr-sidebar">/, '书架页的侧栏结构变了');
  });
});
