/**
 * 阅读主题（纸色）与宿主主题（明/暗）是**两根独立的轴**，必须正交。
 *
 * 为什么单独一个文件、而且非要用**数值**断言：这个缺陷（P0-2 / P1-1）的全部症状都是
 * 「某个像素看不清」，而源码 grep、打包、类型检查、类名交叉比对**全是绿的**。
 * 项目里已有先例（refinements.css 里「警告色实测对比度只有 2.15」那段）。
 *
 * 判据分三层，每层都配反向对照：
 *   ① **结构**：主题生效时，五个语义色必须由 `var(--npr-fg)` / `var(--npr-bg)` 经
 *      `color-mix` 派生。只要还引用任何 `--dsw-*`，宿主主题就会再次渗进来 ——
 *      这正是「宿主深色 + 纸色 light ⇒ 摘要对比度 2.64」的成因。
 *   ② **数值**：按六种纸色算出 WCAG 对比度，正文 / 次要 / 更次要三级逐条 ≥4.5。
 *   ③ **定义完整性**：`refinements.css` 里每一个**没有兜底值**的 `var(--npr-*)`
 *      都必须能找到定义。少一个的定义方式不是「不生效」，而是把别人的变量
 *      **静默置空**（guaranteed-invalid），波及整棵子树 —— 见 P0-2。
 *
 * ★ 关键设计：比例和调色板都**从源码里解析**，不在测试里再写一份。
 *   写两份的话，改了 CSS 而测试还在用旧数字 ⇒ 测试全绿而真机已经坏了。
 *   这里断言的是**性质**（对比度 ≥4.5），不是「等于 84%」。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const readerSrc = readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8');
const refinements = readFileSync(join(clientDir, 'refinements.css'), 'utf8');

/**
 * 去掉 CSS 注释。
 * ★ 必须去：注释里会出现「（--npr-chat-bg: …）」这种写法，不去掉的话
 *   「这个变量有定义」会被**注释里的文字**满足 —— 那正是最典型的假绿。
 */
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 从 ReaderPage.jsx 里抽出 PANEL_CSS 模板串（与审计探针同一套边界切法）。 */
function panelCssOf(source) {
  const start = source.indexOf('const PANEL_CSS = `');
  assert.notEqual(start, -1, 'ReaderPage.jsx 里找不到 PANEL_CSS');
  const end = source.indexOf('`;', start);
  assert.notEqual(end, -1, 'PANEL_CSS 模板串没有闭合 —— 注释里出现反引号就会这样');
  const css = source.slice(start + 'const PANEL_CSS = `'.length, end);
  // ★ 边界自证：`.npr-sidebar-toolbar` 在 PANEL_CSS 的**尾部**（窗口拖动那一段），
  //   所以它出现就说明模板串被完整切到了，而不是在开头附近提前收尾。
  //   这条断言在**模块加载时**执行（不在 it 里），切错了整个文件直接报错 ——
  //   这正是要的：抽不到就大声失败，别让后面的断言在空字符串上全绿。
  assert.ok(css.includes('.npr-sidebar-toolbar'), '抽 PANEL_CSS 失败（边界切错了）');
  return css;
}

const PANEL_CSS = panelCssOf(readerSrc);

/** 抽出阅读主题的调色板（`light: ['#ffffff', '#202124']` 这种）。 */
function paletteOf(source) {
  const at = source.indexOf('const THEME_COLORS = {');
  assert.notEqual(at, -1, 'ReaderPage.jsx 里找不到 THEME_COLORS');
  const block = source.slice(at, source.indexOf('};', at));
  const palette = {};
  for (const m of block.matchAll(/(\w+)\s*:\s*\[\s*'(#[0-9a-fA-F]{3,8})'\s*,\s*'(#[0-9a-fA-F]{3,8})'\s*\]/g)) {
    palette[m[1]] = { bg: m[2], fg: m[3] };
  }
  return palette;
}

const PALETTE = paletteOf(readerSrc);

const THEMED_SELECTOR = '.npr-root[data-reading-theme]:not([data-reading-theme=auto]){';

/**
 * 抽出「主题生效」那条规则里五个语义色的 color-mix 比例。
 *
 * 只认**完整形状**：`--npr-X:color-mix(in srgb,var(--npr-fg) N%,var(--npr-bg))`。
 * 值里出现任何 `--dsw-` 都会被下面第 ① 层的断言抓住。
 */
function themedDerivationOf(css) {
  const at = css.indexOf(THEMED_SELECTOR);
  if (at === -1) return null;
  const body = css.slice(at + THEMED_SELECTOR.length);
  const rule = body.slice(0, body.indexOf('}'));
  const tokens = {};
  for (const m of rule.matchAll(/--npr-([a-z-]+)\s*:\s*([^;}]+)/g)) tokens[m[1]] = m[2];
  return { rule, tokens };
}

/** 只认「无兜底值」的引用：带 `,` 的是有意可选的（如 `var(--npr-mono, ui-monospace…)`）。 */
function requiredRefs(css) {
  const refs = new Set();
  for (const m of stripCssComments(css).matchAll(/var\(\s*(--npr-[a-z0-9-]+)\s*([,)])/g)) {
    if (m[2] === ')') refs.add(m[1]);
  }
  return refs;
}

/**
 * 定义来源：一份 PANEL_CSS + refinements.css + 任意客户端文件里的内联 `'--npr-x':`。
 *
 * 三处都要算，因为三种定义方式都是真的：面板基座写在 PANEL_CSS 里、作用域内的
 * 局部变量（如 `--npr-discover-tint`）写在 refinements.css 里、跟随 React 状态
 * 变化的（如 `--npr-list-width`）只能写在 JSX 的 inline style 里。
 */
function definedTokens(panel) {
  const defined = new Set();
  for (const source of [panel, refinements]) {
    for (const m of stripCssComments(source).matchAll(/(--npr-[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  for (const file of readdirSync(clientDir)) {
    if (!/\.(jsx?|mjs)$/.test(file)) continue;
    const code = readFileSync(join(clientDir, file), 'utf8');
    for (const m of code.matchAll(/['"](--npr-[a-z0-9-]+)['"]\s*:/g)) defined.add(m[1]);
  }
  return defined;
}

/** 同一套判据，喂什么都行 —— 反向对照靠它，而不是另写一份逻辑。 */
function auditDefinitions({ panel = PANEL_CSS, refsSource = refinements } = {}) {
  const defined = definedTokens(panel);
  const refs = [...requiredRefs(refsSource)];
  return { missing: refs.filter((name) => !defined.has(name)).sort(), defined, refs };
}

// ---- 颜色数学（与 scripts/check-theme-contrast.mjs 同源）--------------------

function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/**
 * `color-mix(in srgb, A p%, B)`。
 *
 * 两端都不透明时它就是**有定义的分量线性插值**：每个通道 `A*p + B*(1-p)`。
 * （CSS Color 5 规定按预乘 alpha 插值；两端不透明时预乘不改变结果。）
 * 这个实现与真 Chrome 的实测值在 `scripts/check-theme-contrast.mjs` 里逐档对照过。
 */
const mixSrgb = (a, b, p) => a.map((channel, i) => channel * p + b[i] * (1 - p));

/** WCAG 2.x 相对亮度。 */
function luminance([r, g, b]) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// ---------------------------------------------------------------------------

describe('阅读主题：语义色必须从纸自己的两色派生', () => {
  it('主题生效时，五个语义色都由 --npr-fg / --npr-bg 经 color-mix 算出来', () => {
    const themed = themedDerivationOf(PANEL_CSS);
    assert.ok(themed, 'PANEL_CSS 里没有「主题生效」那条派生规则 —— 纸色主题会继续吃宿主令牌');

    for (const token of ['muted', 'faint', 'border', 'border-strong', 'hover']) {
      const value = themed.tokens[token];
      assert.ok(value, `主题规则里没有 --npr-${token}`);
      assert.match(
        value,
        /^color-mix\(in srgb,var\(--npr-fg\) \d+%,var\(--npr-bg\)\)$/,
        `--npr-${token} 必须是「按 --npr-fg / --npr-bg 就地派生」，实得 ${value}`,
      );
    }
  });

  it('★ 派生规则里**一个 --dsw- 都不许有**（有的话宿主主题就会再次渗进来）', () => {
    const themed = themedDerivationOf(PANEL_CSS);
    assert.doesNotMatch(
      themed.rule,
      /--dsw-/,
      '派生规则里出现了宿主令牌 —— 宿主深色 + 纸色 light 时它会把浅灰文字压到纸上',
    );
  });

  it('调色板覆盖六种纸色，每种都是两色（底 + 字）', () => {
    assert.deepEqual(Object.keys(PALETTE).sort(), ['black', 'dark', 'light', 'mist', 'paper', 'sage']);
    for (const [name, pair] of Object.entries(PALETTE)) {
      assert.match(pair.bg, /^#[0-9a-fA-F]{6}$/, `${name}.bg`);
      assert.match(pair.fg, /^#[0-9a-fA-F]{6}$/, `${name}.fg`);
    }
  });
});

describe('阅读主题：六种纸色 × 三档文字的对比度', () => {
  const themed = themedDerivationOf(PANEL_CSS);
  const ratioOf = (token) => {
    const m = /var\(--npr-fg\) (\d+)%/.exec(themed.tokens[token]);
    assert.ok(m, `解析不出 --npr-${token} 的比例`);
    return Number(m[1]) / 100;
  };

  // 11–12px 的小字也在这三档里（日期走 --npr-faint、摘要走 --npr-muted），
  // 所以按本项目一贯的门槛 4.5 收口，不按「大字 3.0」放宽。
  const LEVELS = [['正文', null, 4.5], ['次要 --npr-muted', 'muted', 4.5], ['更次要 --npr-faint', 'faint', 4.5]];

  it('★ 每一档都 ≥4.5（这是「纸色主题」这个功能存在的全部意义）', () => {
    const measured = [];
    for (const [themeName, { bg, fg }] of Object.entries(PALETTE)) {
      const bgRgb = parseHex(bg);
      const fgRgb = parseHex(fg);
      for (const [label, token, need] of LEVELS) {
        const rgb = token === null ? fgRgb : mixSrgb(fgRgb, bgRgb, ratioOf(token));
        const value = contrast(rgb, bgRgb);
        measured.push({ theme: themeName, level: label, value: Number(value.toFixed(2)) });
        assert.ok(value >= need, `${themeName} / ${label}: 对比度 ${value.toFixed(2)} < ${need}`);
      }
    }
    const worst = measured.reduce((min, row) => (row.value < min.value ? row : min));
    // 把最差组合钉在报错信息里：将来有人换调色板时，一眼能看到还剩多少余量。
    assert.ok(worst.value >= 4.5, `最差组合 ${worst.theme}/${worst.level} = ${worst.value}`);
  });

  it('★ 反向对照：把宿主浅色主题的次级灰当成一个调色板喂进来，必须不达标', () => {
    // 这正是修之前的状态：--npr-muted 挂在 --dsw-alias-label-secondary (#61666b) 上，
    // 而纸色是 dark(#252525) ⇒ 浅灰压在深底上实测 2.64。
    // 用同一套数值判据去量它，要求它**必须红** —— 否则说明这些断言只是把当前实现抄了一遍。
    const hostSecondary = parseHex('#61666b');
    const darkBg = parseHex(PALETTE.dark.bg);
    const value = contrast(hostSecondary, darkBg);
    assert.ok(value < 4.5, `反向对照失效：宿主次级灰压在深色纸上竟然有 ${value.toFixed(2)}`);
  });

  it('★ 反向对照：把三档都设成 100%（= 正文色）也会被抓到（层次塌了）', () => {
    // 防止有人为了「全绿」把三档都调成正文色 —— 那样对比度当然够，但层次没了。
    const muted = ratioOf('muted');
    const faint = ratioOf('faint');
    assert.notEqual(muted, faint, '次要与更次要不能是同一个值');
    assert.ok(muted > faint, `--npr-muted(${muted}) 应当比 --npr-faint(${faint}) 更靠近正文色`);
    assert.ok(muted < 1 && faint < 1, '两档都不该等于正文色');
  });
});

describe('变量定义完整性：没有兜底值的 var(--npr-*) 必须找得到定义', () => {
  it('★ 守卫：refinements.css 里每个裸引用都能在 PANEL_CSS / 内联样式里找到定义', () => {
    const { missing, refs } = auditDefinitions();
    assert.ok(refs.length > 10, `只扫到 ${refs.length} 个裸引用 —— 抽取逻辑自己失效了，先修断言`);
    assert.deepEqual(missing, [], `这些变量引用了却从没定义：${missing.join(', ')}`);
  });

  it('★ 守卫：PANEL_CSS 自己也不许裸引用未定义的变量', () => {
    const { missing } = auditDefinitions({ refsSource: PANEL_CSS });
    assert.deepEqual(missing, [], `PANEL_CSS 里裸引用了未定义的变量：${missing.join(', ')}`);
  });

  it('伴读容器那两个变量必须有定义（P0-2 的根因就是它们从来没被定义过）', () => {
    // refinements.css 里那条 `--dsw-alias-bg-base: var(--npr-chat-bg)` 会**覆写**宿主的
    // 原生对话令牌；而 --npr-chat-bg 不存在时该声明变成 guaranteed-invalid ⇒ 解析成空值
    // ⇒ 整棵子树里靠 var(--dsw-alias-bg-base) 画底的卡片全部透明、边框消失。
    // 失败方式不是「不生效」，是**静默把别人的变量置空**。
    const css = stripCssComments(PANEL_CSS);
    assert.match(css, /--npr-chat-bg\s*:\s*var\(--npr-bg\)/, '--npr-chat-bg 应当取 --npr-bg');
    assert.match(css, /--npr-chat-fg\s*:\s*var\(--npr-fg\)/, '--npr-chat-fg 应当取 --npr-fg');
  });

  it('★ 反向对照：删掉 --npr-chat-bg 的定义，同一套判据必须报出它缺失', () => {
    const broken = PANEL_CSS.replace(/--npr-chat-bg\s*:\s*var\(--npr-bg\)\s*;?/, '');
    assert.notEqual(broken, PANEL_CSS, '反向对照没生效：替换根本没匹配上');
    // 先确认原样是干净的，再确认改坏之后不干净 —— 两步走同一套判据。
    assert.deepEqual(auditDefinitions().missing, []);
    assert.deepEqual(auditDefinitions({ panel: broken }).missing, ['--npr-chat-bg']);
  });
});
