/**
 * 八处「切换控件」：**一套数字，两层结构**（0.44.6）。
 *
 * ★ 为什么必须量：同一屏里曾经有**六套**数字 ——
 *     ① 侧栏 全部/未读/收藏：26px / 圆角 5px / 11px（`ReaderPage` 的 PANEL_CSS）
 *     ② 书架 阅读/书架：     28px / 7px / 12px
 *     ③ 日记三个模块：       30px / 直角 + 下划线 / 12.5px
 *     ④ 设置里的分段器：     28px / 5px / 11px
 *     ⑤ 工具栏图标视图开关： 22px 方块 / 6px
 *     ⑥ 灵感二级视图：       26px / 6px / 11.5px
 *   这类「不统一」在源码里**看不出来**：每处都写得对，只是各不相同。唯一钉得住
 *   它的判据是**跨控件相等** —— 所以下面的断言基本都是「A 的某值 == B 的某值」。
 *   （八处 = 上面六处 + 筛选条的两个层级：一级 `npr-filters-primary` / 二级 `npr-filters`。）
 *
 * ★ 0.44.5 收成两档（有槽 13px / 无槽 12px），0.44.6 用户又指了两处、方向相反：
 *     · 「这部分为什么没统一？格式要一致，字体、字体大小也都要统一」
 *       ⇒ **数字**要并成一个数（字号差 1px 在上下相距 8px 的两行之间只读得出「没对齐」）；
 *     · 「这部分不要统一，因为这部分是下一级，还保持原来的样子」
 *       ⇒ **结构**不许并（筛选条是二级，不给它加底座）。
 *   于是现在的判据分三组：
 *     A. 六处**共有**的量必须落成同一个数：按钮高 / 圆角 / 字号 / 字体 / 字重 / 内边距；
 *     B. 有槽的五处：槽高 / 槽圆角 / 槽内边距 / 槽内间距 同值，且**必须有槽**；
 *     C. 无槽的两条筛选：**必须没有槽**（底色透明、无边框），且宽度按文案走（不占满）。
 *   任何一处单独改数字（哪怕改得合理）都会在 A/B/C 里立刻变红。
 *
 * ★ 为什么放在 `scripts/` 而不是 `.build/preview/`：`.build/` 是 gitignore 的草稿区，
 *   把守卫放在那儿等于没提交 —— 下一个人 clone 下来就没有这道判据了。
 *   因此这里**不依赖任何预览帧**：PANEL_CSS 每次从 `ReaderPage.jsx` 现抽，
 *   `refinements.css` 直接读源码，只把宿主主题变量（`--dsw-alias-*`）用近似值兜住。
 *   ⇒ 能查的是**几何**（高度 / 圆角 / 字号 / 字重 / 宽度 / 底色关系 / 溢出），
 *     不查色值是否精确 —— 真机上颜色由宿主主题映射，这里没有宿主。
 *
 * ★ 结构照抄组件输出（`ReaderPage` / `LibraryApp` / `DiaryApp` / `ViewSwitch` / `ReadingAppearance`
 *   的 JSX），外壳用真的 `.npr-root > .npr-sidebar`：0.44.4 那次「按钮被裁」有
 *   一半是夹具外壳搭错造成的。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const REFINEMENTS = readFileSync(join(ROOT, 'src/client/refinements.css'), 'utf8');

/**
 * ★ 从 `ReaderPage.jsx` 现抽 `PANEL_CSS`：少了它，`.npr-sidebar` / `.npr-root`
 *   连骨架都没有，量出来的是一张自造的假版式（`make-diary-preview.mjs` 的注释里
 *   记着 0.32.0 那次同样的教训）。抽不到就报错退出，不静默降级。
 */
const panelSrc = readFileSync(join(ROOT, 'src/client/ReaderPage.jsx'), 'utf8');
const panelMatch = /const PANEL_CSS = `([\s\S]*?)\n`;/.exec(panelSrc);
if (!panelMatch) throw new Error('没从 ReaderPage.jsx 里抽出 PANEL_CSS —— 骨架缺失时量出来的是假几何，拒绝继续');
const PANEL_CSS = panelMatch[1];

/**
 * 字体栈照抄 `make-diary-preview.mjs` 的 `.npr-root`：不写字体会落到 Chrome 的默认
 * 衬线字体上，量出来的文字宽度与真机（PingFang）不是一回事 —— 而「文案装不装得下」
 * 正是一条**吃字宽**的判据，字体不照抄就等于在量另一个界面。
 */
const FONT = `font-family: -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 13px; line-height: 1.5;`;

/** 浅色主题（判据都跑在这个上）。 */
const THEME = `
:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f5f5f7;--dsw-alias-label-primary:#1b1b1f;
  --dsw-alias-label-secondary:#6b6b73;--dsw-alias-label-tertiary:#8e8e96;--dsw-alias-border-l1:#e3e3e8;
  --dsw-alias-border-l2:#cfcfd6;--dsw-alias-interactive-bg-hover:#f1f1f4;--dsw-alias-bg-layer-3:#fff;
  --dsw-alias-brand-primary:#2f9e6e;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#2f9e6e}
html,body{margin:0;padding:0;background:#fff}
.npr-root{${FONT}}`;

/** 深色主题（只为 `--shot` 出图：用户是在深色界面里截图问的，浅色图看不出「两块并排亮着」）。 */
const THEME_DARK = `
:root{--dsw-alias-bg-base:#1c1c1e;--dsw-alias-bg-layer-1:#232325;--dsw-alias-label-primary:#f2f2f4;
  --dsw-alias-label-secondary:#a0a0a6;--dsw-alias-label-tertiary:#7a7a80;--dsw-alias-border-l1:#2e2e31;
  --dsw-alias-border-l2:#3c3c40;--dsw-alias-interactive-bg-hover:#2c2c2f;--dsw-alias-bg-layer-3:#262628;
  --dsw-alias-brand-primary:#5ec99a;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#5ec99a}
html,body{margin:0;padding:0;background:#1c1c1e}
.npr-root{${FONT}}`;

/**
 * 八处控件的真结构，逐字照抄 JSX（属性名、aria 状态、文案）。
 * ★ 文案用真机上最长的那一组：换短的测不出 268px 侧栏里的溢出。
 * ★ 筛选条有**三份**，因为它们真的在三个位置、两个层级：
 *     · `primary` —— RSS 阅读页 全部/未读/收藏（`npr-filters-primary`）：那一页没有页面
 *       切换器，它是**一级**，有底座、等分；
 *     · `filters` —— 书架阅读页 全部/在读/读完/弃读（`READING_STATE_FILTERS`）：在
 *       「阅读/书架」下面，**二级**，无底座、按文案定宽；
 *     · `shelf`   —— 书架页 全部/已加入阅读（N）：同样**二级**，且第二条带计数。
 */
const BLOCKS = {
  primary: `<div class="npr-filters npr-filters-primary" role="group" aria-label="阅读状态">
    <button type="button" aria-pressed="true">全部</button>
    <button type="button" aria-pressed="false">未读</button>
    <button type="button" aria-pressed="false">收藏</button>
  </div>`,
  filters: `<div class="npr-filters" role="group" aria-label="阅读状态">
    <button type="button" aria-pressed="true">全部</button>
    <button type="button" aria-pressed="false">在读</button>
    <button type="button" aria-pressed="false">读完</button>
    <button type="button" aria-pressed="false">弃读</button>
  </div>`,
  shelf: `<div class="npr-filters" role="group" aria-label="书架筛选">
    <button type="button" aria-pressed="true">全部</button>
    <button type="button" aria-pressed="false">已加入阅读（12）</button>
  </div>`,
  libtabs: `<div class="npr-libtabs" role="group" aria-label="书架分页">
    <button type="button" aria-pressed="true">阅读</button>
    <button type="button" aria-pressed="false">书架</button>
  </div>`,
  modes: `<div class="npr-diary-modes" role="group" aria-label="日记功能">
    <button type="button" aria-pressed="true">灵感速记</button>
    <button type="button" aria-pressed="false">私密日记</button>
    <button type="button" aria-pressed="false">读后感</button>
  </div>`,
  settings: `<div class="npr-segmented" role="group" aria-label="版心宽度">
    <button type="button" aria-pressed="true">590</button>
    <button type="button" aria-pressed="false">720</button>
    <button type="button" aria-pressed="false">860</button>
  </div>`,
  viewswitch: `<div class="npr-viewswitch" role="group" aria-label="主视图">
    <button type="button" aria-pressed="true" aria-label="订阅"></button>
    <button type="button" aria-pressed="false" aria-label="书"></button>
    <button type="button" aria-pressed="false" aria-label="日记"></button>
  </div>`,
};

/** 全部八处。 */
const ALL = ['primary', 'filters', 'shelf', 'libtabs', 'modes', 'settings', 'viewswitch'];
/** 一级：有槽的几处（含 RSS 阅读页那条筛选、图标开关）。 */
const TROUGH = ['primary', 'libtabs', 'modes', 'settings', 'viewswitch'];
/** 二级：无槽的两条筛选（书架阅读页、书架页）。结构上**不许**有底座，这是层级本身。 */
const FLAT = ['filters', 'shelf'];
/** 有文字的那几处才参与「字号 / 字体 / 字重」比较（图标开关没有文字）。 */
const TEXT = ALL.filter((key) => key !== 'viewswitch');
/** 占满一行的几处：等分宽度 / 左缘同一条竖线只在它们之间比。 */
const ROWS = ['primary', 'filters', 'shelf', 'libtabs', 'modes'];
/** 等分的那几处（一级、有文字；设置的分段器与二级筛选条按文案定宽）。 */
const SPLIT = ['primary', 'libtabs', 'modes'];

const PROBE = `
<script>
(() => {
  const measure = () => {
    const out = {};
    const cs = (el) => getComputedStyle(el);
    for (const host of document.querySelectorAll('[data-control]')) {
      const id = host.getAttribute('data-control');
      const wrap = host.firstElementChild;
      const box = wrap.getBoundingClientRect();
      const style = cs(wrap);
      out[id] = {
        container: {
          h: +box.height.toFixed(2), w: +box.width.toFixed(2),
          radius: style.borderTopLeftRadius, padding: style.paddingTop,
          bg: style.backgroundColor, border: style.borderTopWidth, display: style.display,
          gap: style.columnGap, left: +box.left.toFixed(2),
          clipped: wrap.scrollWidth - wrap.clientWidth,
        },
        buttons: [...wrap.querySelectorAll(':scope > button')].map((el) => {
          const s = cs(el);
          const b = el.getBoundingClientRect();
          /**
           * ★ 文字（含图标）的**实际宽度**：scrollWidth - clientWidth 在按钮上并不可靠
           *   —— 按钮内容是匿名行盒，居中排布时溢出的那一截不一定记进 scrollWidth，
           *   于是「文字被挤出去」的判据会假绿。这里直接用 Range 量内容本身的盒子。
           */
          const range = document.createRange();
          range.selectNodeContents(el);
          const contentW = +range.getBoundingClientRect().width.toFixed(2);
          return {
            text: el.textContent.trim(),
            pressed: el.getAttribute('aria-pressed') === 'true'
              || el.getAttribute('aria-selected') === 'true' || el.classList.contains('is-on'),
            h: +b.height.toFixed(2), w: +b.width.toFixed(2),
            radius: s.borderTopLeftRadius, fontSize: s.fontSize, fontWeight: s.fontWeight,
            fontFamily: s.fontFamily, padL: parseFloat(s.paddingLeft), padR: parseFloat(s.paddingRight),
            contentW,
            bg: s.backgroundColor, color: s.color,
            clipped: el.scrollWidth - el.clientWidth,
          };
        }),
      };
    }
    document.title = 'D:' + JSON.stringify(out);
  };
  if (document.readyState === 'complete') measure();
  else window.addEventListener('load', measure);
})();
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'npr-tabs-'));
let seq = 0;

function render(width, extraCss, theme = THEME) {
  const body = Object.entries(BLOCKS)
    .map(([key, html]) => `<div data-control="${key}">${html}</div>`)
    .join('\n      ');
  const file = join(dir, `tabs-${width}-${seq++}.html`);
  writeFileSync(file, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${theme}</style>
<style>${PANEL_CSS}</style>
<style>${REFINEMENTS}</style>
${extraCss ? `<style>${extraCss}</style>` : ''}
<style>.npr-sidebar{width:${width}px;box-sizing:border-box;padding:10px 0}[data-control]{margin:0 0 14px}
.probe-icon{display:inline-block;width:13px;height:13px;border-radius:3px;background:#c9c9ce}</style>
</head><body>
  <div class="npr-root" style="width:${width}px">
    <aside class="npr-sidebar">
      ${body}
    </aside>
  </div>
${PROBE}</body></html>`);
  return file;
}

function run(file) {
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=3000',
    '--dump-dom', file,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  const match = dom.match(/<title>D:([\s\S]*?)<\/title>/);
  if (!match) throw new Error('探针没有回传（document.title 里没有 D: 前缀）');
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

/**
 * 一组判据。抽成函数是为了让**反向对照**能用同一个函数：
 * 变异版必须在这里返回非空失败清单 —— 那才说明判据量到了东西。
 */
function crossFailures(d) {
  const fails = [];
  const uniq = (values) => [...new Set(values.map(String))];
  /** `pairs` = [[控件名, 值], …]；不等时把每个控件自己的值列出来，便于一眼定位。 */
  const same = (pairs, label) => {
    if (uniq(pairs.map(([, v]) => v)).length !== 1) {
      fails.push(`${label}不一致：${pairs.map(([k, v]) => `${k}=${v}`).join(' / ')}`);
    }
  };
  const buttonsOf = (keys, prop) => keys.flatMap((k) => d[k].buttons.map((b) => [k, b[prop]]));
  const firstOf = (keys, prop) => keys.map((k) => [k, d[k].buttons[0][prop]]);
  const wrapOf = (keys, prop) => keys.map((k) => [k, d[k].container[prop]]);

  // ── A. 六处共有的量：同一个数 ────────────────────────────────────────────
  same(buttonsOf(ALL, 'h'), '按钮高度');
  same(buttonsOf(ALL, 'radius'), '按钮圆角');
  /**
   * ★ 内边距只比**纯文字**的几处。两个例外各有实测理由，不是漏掉：
   *   · 图标开关（`viewswitch`）：26×26 的方块，`padding: 0`；把它算进来等于要求方块
   *     吃 10px 内边距 —— 26px 会被撑成 46px。
   *   · 灵感视图（`linkviews`）：按钮是「图标 + 文字」且**居中**，内边距不改观感；
   *     而 268px 下每段只有 78px，图标 13 + 间距 4 + 三字 39 = 56，算上 20px 内边距
   *     只剩 2px 余量 —— 现状的 4px 是留给自己变长的余地。
   *   这条判据要守的是「文字到块边的那点距离」，那三处（筛选条 / 分页 / 日记模块）
   *   加上设置里的分段器，都是纯文字。
   *
   * ★★ 但 `primary`（RSS 一级筛选条）在**窄档**是 8px，其余是 10px —— 这是 0.45.2
   *   定下的压缩，不是漏改：这一行要挤下四颗 chip，最长那颗是「已隐藏 12」，
   *   10px 下在 256px 侧栏里排不开会换行，而换行被用户明确否掉（2026-10-29
   *   「换行显得非常的业余」）。另外几行没有这个压力（2~3 颗、字数固定），
   *   跟着收只会无端改掉它们的外观。
   *   ⇒ 所以**不能**把它算进「全局同一个数」，否则这条断言会长期红着 ——
   *     0.45.2 之后它确实一直红，只是 `tabs` 属于 `--all` 的重型门禁，平时没人跑。
   *   ⇒ 改成两条**分别有牙**的断言：其余几处同一个数；primary 必须正好 8px。
   *     后者不是「放行」—— 把它改回 10 或改成 6 都会红。
   *   ★ 本文件只在 320 / 268 两个**窄档**渲染（见文件末尾的宽度循环），所以这里
   *     写死 8px 是对的；将来若加宽档，这条要按宽度分档写。
   */
  same(buttonsOf(['filters', 'shelf', 'libtabs', 'modes', 'settings'], 'padL'), '按钮左内边距');
  {
    const narrowPad = uniq(buttonsOf(['primary'], 'padL').map(([, v]) => v));
    if (narrowPad.length !== 1 || Number(narrowPad[0]) !== 8) {
      fails.push(`RSS 一级筛选条的窄档内边距应为 8px（四颗 chip 才排得成一行），实际 ${narrowPad.join('/')}`);
    }
  }
  same(firstOf(TEXT, 'fontSize'), '字号');
  same(firstOf(TEXT, 'fontFamily'), '字体族');

  const pressed = uniq(TEXT.flatMap((k) => d[k].buttons.filter((b) => b.pressed).map((b) => b.fontWeight)));
  const idle = uniq(TEXT.flatMap((k) => d[k].buttons.filter((b) => !b.pressed).map((b) => b.fontWeight)));
  if (pressed.length !== 1) fails.push(`选中态字重不等：${pressed.join(' / ')}`);
  if (idle.length !== 1) fails.push(`未选中态字重不等：${idle.join(' / ')}`);
  if (pressed.join() === idle.join()) fails.push(`选中与未选中字重相同（${pressed}）—— 选中态没有重量差`);

  // ── B. 有槽的五处：槽的几何同值 + 必须有槽 ───────────────────────────────
  same(wrapOf(TROUGH, 'h'), '槽高');
  same(wrapOf(TROUGH, 'radius'), '槽圆角');
  same(wrapOf(TROUGH, 'padding'), '槽内边距');
  same(wrapOf(TROUGH, 'gap'), '槽内间距');
  for (const key of TROUGH) {
    if (d[key].container.bg === 'rgba(0, 0, 0, 0)') {
      fails.push(`${key} 没有槽（容器底色透明）—— 一级控件少了「换一页」的那层底座`);
    }
    const thumb = d[key].buttons.find((b) => b.pressed)?.bg;
    if (thumb === d[key].container.bg) fails.push(`${key} 的选中块与槽颜色相同（${thumb}）—— 选中态看不见`);
  }

  // ── C. 无槽的两条筛选：不许有底座；宽度按文案走 ──────────────────────────
  for (const key of FLAT) {
    if (d[key].container.bg !== 'rgba(0, 0, 0, 0)') {
      fails.push(`${key} 长了槽（${d[key].container.bg}）—— 筛选是二级，加底座就与分页/模块同层了`);
    }
    if (parseFloat(d[key].container.padding) > 0) {
      fails.push(`${key} 的容器有 ${d[key].container.padding} 内边距 —— 没有槽就不该有槽的留白`);
    }
    for (const b of d[key].buttons) {
      /**
       * ★ 按文案定宽：按钮宽 = 内容宽 + 左右内边距（±1px）。
       *   这条是「保持原来的样子」的量化版 —— 0.44.5 就是这个形态。等分（flex: 1 1 0）
       *   会让每个块都撑成一段，四五个字的标签与两个字的一样宽，看起来像页签而不是筛选项。
       */
      const hug = b.contentW + b.padL + b.padR;
      if (Math.abs(b.w - hug) > 1) {
        fails.push(`${key} 的「${b.text}」宽 ${b.w}px ≠ 内容+内边距 ${hug.toFixed(1)}px —— 筛选条应当按文案定宽`);
      }
    }
  }

  // ── 占满一行的几处：左缘同一条竖线 ──────────────────────────────────────
  same(wrapOf(ROWS, 'left'), '左缘');

  // ── 等分只属于一级 ─────────────────────────────────────────────────────
  for (const key of SPLIT) {
    const widths = d[key].buttons.map((b) => b.w);
    const spread = Math.max(...widths) - Math.min(...widths);
    if (spread > 1) {
      fails.push(`${key} 的按钮不等宽（${widths.map((w) => w.toFixed(1)).join(' / ')}，差 ${spread.toFixed(1)}px）`
        + ' —— 一级控件是「换一页」，各段等宽');
    }
  }

  // ── 溢出 ────────────────────────────────────────────────────────────────
  for (const key of ALL) {
    /**
     * ★ viewswitch 不查容器裁切：它右缘那条 `::after` 分隔线是**故意放在盒子外面**的
     *   （绝对定位到 100% + 8px，这样它不参与轨道填充）。`scrollWidth` 会把这 9px
     *   算成溢出 —— 那是设计的一部分，不是「被裁」。按钮自身的裁切照旧查。
     */
    if (key !== 'viewswitch' && d[key].container.clipped > 0) fails.push(`${key} 容器溢出 ${d[key].container.clipped}px`);
    for (const b of d[key].buttons) {
      if (b.clipped > 0) fails.push(`${key} 的「${b.text}」溢出 ${b.clipped}px`);
      if (b.w <= 0 || b.h <= 0) fails.push(`${key} 的「${b.text}」没渲染出来（${b.w}×${b.h}）`);
      /** 等分的控件里，文案不能超过可用宽度（等分宽度固定，长了就露出去）。 */
      const room = b.w - b.padL - b.padR;
      if (SPLIT.includes(key) && b.contentW > room + 0.5) {
        fails.push(`${key} 的「${b.text}」装不下：内容 ${b.contentW}px > 可用 ${room.toFixed(2)}px`);
      }
    }
  }
  return fails;
}

/**
 * ★ hover 的规矩分两层（源码级）：
 *   · 二级（无槽）：筛选条**不能**画底色，只能改字色 —— 0.44.5 它写在「列表行 hover」
 *     那一组里（5% 底色 + 字变白），与选中块（8% + 白字）撞脸，截图里两块并排亮着。
 *   · 一级（有槽）：画底色没问题，那是槽里的淡水洗，选中是槽里的一块实底。
 *   所以只查二级那一条规则：`[aria-pressed=true]` 之外，它不许出现 background。
 */
function hoverRuleFailures(css) {
  const fails = [];
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const hovers = blocks.filter(([, sel]) => sel.includes(':not(.npr-filters-primary) > button:hover'));
  if (hovers.length !== 1) {
    fails.push(`二级筛选条的 hover 应该只由一条规则负责，实际 ${hovers.length} 条`);
    return fails;
  }
  const body = hovers[0][2];
  const bg = /background\s*:\s*([^;]+)/.exec(body);
  if (!bg || !/^transparent$/i.test(bg[1].trim())) {
    fails.push(`二级筛选条的 hover 画了底色（${bg ? bg[1].trim() : '未声明'}）—— 无槽时它与选中块撞脸`);
  }
  if (!/color\s*:\s*var\(--npr-fg\)/.test(body)) {
    fails.push('二级筛选条的 hover 没把字色提到 --npr-fg —— 那样 hover 就没有任何反馈');
  }
  return fails;
}

let bad = 0;
const check = (ok, message) => {
  if (!ok) { bad += 1; console.log(`  ✗ ${message}`); }
};

/**
 * `--shot <png> [--dark]`：把 320px 的**同一份夹具**存成一张图供人眼复核。
 * ★ 另写一份截图脚本就会出现「判据看的是一套标记、眼睛看的是另一套」——
 *   0.44.4 那次「夹具照抄的是旧结构、断言全绿」正是这么来的。
 */
const shotIndex = process.argv.indexOf('--shot');
if (shotIndex !== -1) {
  const target = process.argv[shotIndex + 1];
  if (!target) throw new Error('--shot 后面要跟一个输出路径');
  const dark = process.argv.includes('--dark');
  const src = render(320, '', dark ? THEME_DARK : THEME);
  writeFileSync(target, readFileSync(src));
  console.log(`已写出夹具快照 → ${target}${dark ? '（深色）' : '（浅色）'}`);
  process.exit(0);
}

/** 268 = 侧栏下限（阅读页能拖到这儿），320 = 默认宽度。 */
for (const width of [320, 268]) {
  const d = run(render(width, ''));
  const fails = crossFailures(d);
  console.log(`\n${width}px`);
  for (const key of ALL) {
    const c = d[key].container;
    const p = d[key].buttons.find((b) => b.pressed);
    console.log(`  ${key.padEnd(10)} 槽 h=${c.h} r=${c.radius} pad=${c.padding} 左=${c.left}`
      + ` ${FLAT.includes(key) ? '无槽' : '有槽'}`
      + ` · 按钮 h=${p.h} r=${p.radius} ${p.fontSize}/${p.fontWeight}`
      + ` · 宽 ${d[key].buttons.map((b) => b.w.toFixed(1)).join('/')}`);
  }
  if (fails.length === 0) {
    console.log('  ok   一套数字 + 两层结构：数字八处同值；一级有槽且等分；二级无槽且按文案定宽');
  }
  for (const f of fails) check(false, f);
}

/** 源码级：hover 分层的两条 + 没有第二个字号变量。 */
{
  const hf = hoverRuleFailures(REFINEMENTS);
  for (const f of hf) check(false, f);
  if (hf.length === 0) console.log('  ok   筛选条 hover 只改字色（不画底色），不会与选中块撞脸');
  check(!/--npr-tab-font-sm/.test(REFINEMENTS + PANEL_CSS),
    '还留着 --npr-tab-font-sm（0.44.5 的 12px）—— 第二个字号只要还在，就一定有人再用它');
}

/**
 * 反向对照一：只把「书架分页」的圆角改成 12px，其余一字不动。
 * ★ 用**同一个** crossFailures：它必须在变异上返回失败，否则那些相等断言其实什么都没量。
 */
{
  const d = run(render(320, '.npr-root .npr-libtabs > button { border-radius: 12px; }'));
  const fails = crossFailures(d);
  const hit = fails.some((f) => f.includes('圆角'));
  check(hit, `★ 反向对照失败：单独把 libtabs 的圆角改成 12px 之后判据仍是绿的 —— 相等断言是空的（实际：${fails.join(' | ') || '无'}）`);
  if (hit) console.log('  ok   ★ 反向对照：单独改一处圆角，跨控件相等立刻变红');
}

/**
 * 反向对照二：给筛选条**加一个槽**（0.44.6 走错的那一步）。
 * ★ 这是用户当天否掉的方向：筛选是二级，加底座就与分页/模块同层了。
 */
{
  const d = run(render(320, `
    .npr-root .npr-filters:not(.npr-filters-primary) { padding: 2px; background: rgba(0, 0, 0, 0.06); }`));
  const fails = crossFailures(d);
  const hit = fails.some((f) => f.includes('长了槽'));
  check(hit, `★ 反向对照失败：给筛选条加底座后判据仍是绿的（实际：${fails.join(' | ') || '无'}）`);
  if (hit) console.log('  ok   ★ 反向对照：给筛选条加槽 → 「筛选是二级」那条立刻变红');
}

/**
 * 反向对照三：把筛选条改成**等分**（0.44.6 同样走错的那一步）。
 * ★ 等分与「按文案定宽」是一对反义；改一个字母（flex: 1 1 0）就该红。
 */
{
  const d = run(render(320, '.npr-root .npr-filters:not(.npr-filters-primary) > button { flex: 1 1 0; min-width: 0; }'));
  const fails = crossFailures(d);
  const hit = fails.some((f) => f.includes('按文案定宽'));
  check(hit, `★ 反向对照失败：把筛选条改成等分后判据仍是绿的（实际：${fails.join(' | ') || '无'}）`);
  if (hit) console.log('  ok   ★ 反向对照：筛选条改等分 → 「按文案定宽」立刻变红');
}

/** 反向对照四：字号退回 12px（0.44.5 的第二个数）。 */
{
  const d = run(render(320, '.npr-root .npr-filters:not(.npr-filters-primary) > button { font-size: 12px; }'));
  const fails = crossFailures(d);
  const hit = fails.some((f) => f.includes('字号不一致'));
  check(hit, `★ 反向对照失败：把筛选条字号退回 12px 后判据仍是绿的（实际：${fails.join(' | ') || '无'}）`);
  if (hit) console.log('  ok   ★ 反向对照：筛选条字号退回 12px → 字号一致立刻变红');
}

/** 反向对照五：给二级筛选条的 hover 加回底色（两块并排亮着的成因）。 */
{
  const css = REFINEMENTS.replace(
    '.npr-root .npr-filters:not(.npr-filters-primary) > button:hover { background: transparent; color: var(--npr-fg); }',
    '.npr-root .npr-filters:not(.npr-filters-primary) > button:hover { background: var(--npr-hover); color: var(--npr-fg); }',
  );
  const hf = hoverRuleFailures(css);
  const hit = hf.some((f) => f.includes('画了底色'));
  check(hit, `★ 反向对照失败：把二级筛选条 hover 的底色加回去，判据没认出来（实际：${hf.join(' | ') || '无'}）`);
  if (hit) console.log('  ok   ★ 反向对照：二级筛选条 hover 加回底色 → 撞脸那条立刻变红');
}

/**
 * 反向对照六：把 RSS 一级筛选条的窄档内边距**放回 10px**。
 * ★ 这一条守的是上面那条「primary 必须正好 8px」—— 那条如果只是「不算进全局比较」，
 *   这里会全绿；它必须能因为「改回 10px」而红，才算真的在守 0.45.2 的那个压缩。
 * ★ 选择器与 PANEL_CSS 里那条窄档规则**同特异度**（0,3,1），靠 extraCss 在 head 里
 *   更靠后取胜 —— 少写一个 `.npr-filters` 就会被原规则盖掉，变异体成了空操作，
 *   于是「仍然绿」会被误读成「判据没牙」。
 */
{
  const d = run(render(320, '.npr-root .npr-filters.npr-filters-primary button { padding: 0 10px; }'));
  const fails = crossFailures(d);
  const hit = fails.some((f) => f.includes('窄档内边距应为 8px'));
  check(hit, `★ 反向对照失败：把 primary 的窄档内边距改回 10px 后判据仍是绿的（实际：${fails.join(' | ') || '无'}）`);
  if (hit) console.log('  ok   ★ 反向对照：primary 窄档内边距改回 10px → 8px 那条立刻变红');
}

console.log(bad === 0 ? '\nALL OK' : `\n${bad} 条不合格`);
process.exit(bad === 0 ? 0 : 1);
