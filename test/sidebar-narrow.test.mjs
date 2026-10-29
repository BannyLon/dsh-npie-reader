/**
 * 侧边栏在窄宽度下的自适应（0.45.1 → 0.45.2）。
 *
 * 用户 2026-10-28 的截图：侧边栏被挤窄之后，筛选条「已隐藏 1」的数字被切掉半个、
 * 「1 个订阅源…」提示条被切、工具栏最右那颗设置齿轮只剩半颗。
 * 2026-10-29 的第二轮：0.45.1 把下限设成 232px，**换行**了（「已隐藏 1」独占一行被拉满），
 * 齿轮还是被遮 —— 原话「换行显得非常的业余」。
 *
 * ⇒ 两条是**不同**的门槛，0.45.1 只钉住了前一条：
 *   不溢出 = scrollWidth <= clientWidth（232px 就够）；
 *   不换行 = 筛选条只有一行（**256px** 才够，两位数的「已隐藏 12」要 252px）。
 *   真 Chrome 量出来的三档依据：工具栏 240 / 单行 chip 244 / 两位数计数 252
 *   （`.build/preview/measure-sidebar-min.mjs`）。
 *
 * ★ 为什么不能用 `@container` 量侧边栏自己：`.npr-sidebar` 一旦设 `container-type`，
 *   它内部**所有无名的** `@container (max-width:700px)` 规则会改按侧边栏宽度求值 ——
 *   那些规则本来是量面板的（全项目 10+ 条断点都靠无名查询），会集体误触发。
 *   所以这里走「列宽下限 + flex 自己算」，不新增容器。
 *
 * ★ 真几何判据（真 Chrome 量 scrollWidth / 换行行数 / 裁字 / 频道图标宽度）在
 *   `.build/preview/measure-sidebar-narrow.mjs`，反向对照是同目录的
 *   `check-sidebar-narrow-mutant.mjs`（4 条变异，其中一条故意要求「仍然绿」）。
 *   那两个脚本在 gitignored 的 `.build/` 里，所以这里只钉**源码契约** ——
 *   契约被改回去时本文件必须变红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const source = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));

/** 源码里那个下限（CSS 变量）。 */
const cssMin = Number(/--npr-sidebar-min:(\d+)px/.exec(source)?.[1] ?? NaN);
/** JS 里那个下限（拖动与首屏夹取用）。 */
const jsMin = Number(/export const SIDEBAR_MIN_WIDTH = (\d+);/.exec(source)?.[1] ?? NaN);

describe('0.45.2：侧边栏下限 —— 一个数，两处写', () => {
  it('CSS 变量与 JS 常数都存在', () => {
    assert.ok(Number.isFinite(cssMin), 'PANEL_CSS 里缺 --npr-sidebar-min');
    assert.ok(Number.isFinite(jsMin), '缺导出的 SIDEBAR_MIN_WIDTH');
  });

  /* ★ 这条是「同一判据在两处各写一遍 ⇒ 两个数字对不上」的那个坑的补丁：
     CSS 那条管「面板宽度算出来的列宽」，JS 那条管「拖动 + 首屏读回」。
     两个数岔开就会出现「拖到 220 不换行、窗口一缩就换行」这种只在一条路径上复现的状态。 */
  it('两处必须是同一个数（CSS 变量 === SIDEBAR_MIN_WIDTH）', () => {
    assert.equal(cssMin, jsMin, `CSS 写 ${cssMin}px、JS 写 ${jsMin}px —— 两条路径会对不上`);
  });

  /* 量出来的门槛：两位数的「已隐藏 12」要 252px 才不换行。下限必须盖住它，
     否则计数一过 9 就又开始换行（用户报的正是这个形态）。 */
  it('下限不低于量出来的 252px（两位数计数仍单行）', () => {
    assert.ok(cssMin >= 252, `下限 ${cssMin}px 盖不住 252px —— 「已隐藏 12」会换行`);
  });
});

describe('0.45.2：侧边栏下限 —— 两条列宽公式都带着它', () => {
  it('窄面板那一档用 clamp(var(--npr-sidebar-min),42cqw,300px)', () => {
    assert.match(
      source,
      /@container \(max-width:700px\)\{\.npr-layout\{grid-template-columns:clamp\(var\(--npr-sidebar-min\),42cqw,300px\)/,
      '窄面板的列宽必须是 clamp(var(--npr-sidebar-min),42cqw,300px)',
    );
  });

  it('宽面板那一档（基础规则）用 max(...) 兜住同一个下限', () => {
    assert.match(
      source,
      /\.npr-layout\{flex:1;min-height:0;display:grid;grid-template-columns:max\(var\(--npr-sidebar-min\),min\(var\(--npr-list-width\),calc\(100cqw - 330px\)\)\) 1px minmax\(0,1fr\)\}/,
      '基础列宽没兜下限：侧边栏被拖窄时这一条才是生效的那条',
    );
  });

  it('反向对照：不能再出现 min(240px,42cqw) —— 那个写法面板 500px 时只给 210px', () => {
    assert.doesNotMatch(
      source,
      /min\(240px,42cqw\)/,
      'min(240px,42cqw) 没有下限：面板 500px 时算出 210px，工具栏放不下',
    );
  });

  it('反向对照：也不能再出现 0.45.1 的 clamp(232px,...) —— 它只够不溢出、不够不换行', () => {
    assert.doesNotMatch(
      source,
      /clamp\(232px,42cqw,240px\)/,
      '232px 是「不溢出」的下限，不是「不换行」的下限（用户 2026-10-29 否掉的正是它）',
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

describe('0.45.2：拖动与首屏读回也夹在同一个下限上', () => {
  it('拖动夹取用 SIDEBAR_MIN_WIDTH，不是写死的 220', () => {
    assert.match(
      source,
      /Math\.max\(startX === 0 \? 300 : \(listWidth \+ moveEvent\.clientX - startX\), SIDEBAR_MIN_WIDTH\)/,
      '拖动下限要跟着 SIDEBAR_MIN_WIDTH 走 —— 220 正好是用户拖到底时那个坏宽度',
    );
    assert.doesNotMatch(
      source,
      /- startX\), 220\)/,
      '拖动下限还写死 220：那是 0.45.1 之前的值，比「排得开」还窄',
    );
  });

  /* ★ 老用户的 localStorage 里存着 220（旧下限）。不在**首屏读回**时夹一下，
     表现就是「一打开就换行 + 齿轮被遮」，而用户根本没拖过 —— 最难自查的一类。 */
  it('首屏读回 npr.listWidth 时也要夹（老用户存的是 220）', () => {
    assert.match(
      source,
      /useState\(\(\) => Math\.max\(SIDEBAR_MIN_WIDTH, Number\(localStorage\.getItem\('npr\.listWidth'\)\) \|\| 300\)\)/,
      '首屏读回没夹下限：老用户存的 220 会原样生效',
    );
  });
});

describe('0.45.1：工具栏自己收紧（0.45.2 起是余量，不是必需品）', () => {
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

describe('0.45.1：筛选 chip 不裁字', () => {
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

  /* ★ 换行是**兜底**（换行 ≠ 裁字），不是常态：下限 256px 盖住了四位以内的计数，
     所以它平时不该触发。真几何那一侧有一条 D 号变异专门证明「换行」这条判据有牙
     （把 chip 内边距放大到 16px ⇒ 宽度照样过、但排不开 ⇒ 必须报「换成了 2 行」）。 */
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
