/**
 * 侧边栏在窄宽度下的自适应（0.45.1）。
 *
 * 用户 2026-10-28 的截图：侧边栏被挤窄之后，筛选条「已隐藏 1」的数字被切掉半个、
 * 「1 个订阅源…」提示条被切、工具栏最右那颗设置齿轮只剩半颗。
 *
 * 根因是两条**没有下限**的列宽公式叠在一起：
 *   - `@container (max-width:700px)` 里的 `min(240px, 42cqw)`：面板 500px 时算出 210px；
 *   - 而工具栏那一行的**固定项**就要 238px（三档视图开关 88 + 频道按钮 46 +
 *     四颗图标 112 + 间距 10 + 内边距 20）。
 * 两者相遇，最右那颗图标被挤出侧边栏、被父级裁掉。
 *
 * ★ 为什么不能用 `@container` 量侧边栏自己：`.npr-sidebar` 一旦设 `container-type`，
 *   它内部**所有无名的** `@container (max-width:700px)` 规则会改按侧边栏宽度求值 ——
 *   那些规则本来是量面板的（全项目 10+ 条断点都靠无名查询），会集体误触发。
 *   所以这里走「flex 自己算 + 列宽下限」，不新增容器。
 *
 * ★ 真几何判据（真 Chrome 量 scrollWidth / 裁字 / 频道图标宽度）在
 *   `.build/preview/measure-sidebar-narrow.mjs`，反向对照是同目录的
 *   `check-sidebar-narrow-mutant.mjs`（3 条变异）。那两个脚本在 gitignored 的
 *   `.build/` 里，所以这里只钉**源码契约** —— 契约被改回去时本文件必须变红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const source = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));

describe('0.45.1：侧边栏窄宽度 —— 列宽下限', () => {
  it('窄面板那一档的列宽有下限（clamp），不再是无下限的 min', () => {
    assert.match(
      source,
      /@container \(max-width:700px\)\{\.npr-layout\{grid-template-columns:clamp\(232px,42cqw,240px\)/,
      '窄面板的列宽必须是 clamp(232px,42cqw,240px)',
    );
  });

  it('反向对照：不能再出现 min(240px,42cqw) —— 那个写法面板 500px 时只给 210px', () => {
    assert.doesNotMatch(
      source,
      /min\(240px,42cqw\)/,
      'min(240px,42cqw) 没有下限：面板 500px 时算出 210px，工具栏放不下',
    );
  });

  it('460px 以下仍然是单列（下限不能把侧边栏撑到把阅读区挤没）', () => {
    assert.match(
      source,
      /@container \(max-width:460px\)\{\.npr-layout\{grid-template-columns:minmax\(0,1fr\)\}/,
      '460px 以下必须单列 —— 侧边栏有下限之后，这一档是「两列都别挤」的唯一出口',
    );
  });
});

describe('0.45.1：侧边栏窄宽度 —— 工具栏自己收紧', () => {
  it('窄面板里工具栏的图标缩到 24px、间距归零、右内边距 4px', () => {
    assert.match(source, /\.npr-root \.npr-sidebar-toolbar\{gap:0;padding:5px 4px 5px 10px\}/, '缺工具栏收紧');
    assert.match(
      source,
      /\.npr-root \.npr-sidebar-toolbar \.npr-icon\{width:24px;height:24px;padding:4px\}/,
      '侧边栏里的图标要单独缩到 24px（通用那条是 28px）',
    );
  });

  it('收紧规则的特异性高于通用 .npr-root .npr-icon（否则压不过）', () => {
    // 通用那条是 2 个类（.npr-root .npr-icon），收紧这条是 3 个类 ⇒ 后者胜。
    // 反向对照：如果把收紧写成 .npr-root .npr-icon，两条同特异性，后写的通用规则会赢，
    // 图标还是 28px —— 而源码看起来「明明写了 24px」。
    const tighten = /\.npr-root \.npr-sidebar-toolbar \.npr-icon\{/;
    assert.match(source, tighten);
    assert.doesNotMatch(
      source,
      /@container \(max-width:700px\)\{[^}]*\.npr-root \.npr-icon\{width:24px/,
      '不能把 24px 写成通用规则 —— 那会把阅读区工具条的图标也一起缩掉',
    );
  });
});

describe('0.45.1：侧边栏窄宽度 —— 筛选 chip 不裁字', () => {
  it('chip 的最小宽度是内容宽（max-content），不是 0', () => {
    assert.match(
      source,
      /\.npr-root \.npr-filters\.npr-filters-primary button\{flex:1 1 0;min-width:max-content\}/,
      'chip 必须 min-width:max-content —— min-width:0 会让等分把「已隐藏 1」的数字压掉',
    );
    assert.doesNotMatch(
      source,
      /\.npr-root \.npr-filters\.npr-filters-primary button\{flex:1 1 0;min-width:0\}/,
      'min-width:0 就是用户截图里「1 只露出半个」的那个写法',
    );
  });

  it('筛选条允许换行（放不下时换行，而不是把字裁掉）', () => {
    assert.match(
      source,
      /\.npr-root \.npr-filters\.npr-filters-primary\{[^}]*flex-wrap:wrap/,
      '一级筛选条缺 flex-wrap:wrap',
    );
  });

  it('窄面板里 chip 的内边距从 10px 收到 8px（少这 4px 就要换行）', () => {
    assert.match(
      source,
      /@container \(max-width:700px\)\{[\s\S]*?\.npr-root \.npr-filters\.npr-filters-primary button\{padding:0 8px\}/,
      '窄面板里 chip 的内边距没收到 8px',
    );
  });
});
