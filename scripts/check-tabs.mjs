/**
 * 六处「切换控件」是不是同一套几何（0.44.5）。
 *
 * ★ 为什么必须量：0.44.5 之前，同一屏里有**六套**数字 ——
 *     ① 侧栏 全部/未读/收藏：26px / 圆角 5px / 11px（`ReaderPage` 的 PANEL_CSS）
 *     ② 书架 阅读/书架：     28px / 7px / 12px
 *     ③ 日记三个模块：       30px / 直角 + 下划线 / 12.5px
 *     ④ 设置里的分段器：     28px / 5px / 11px
 *     ⑤ 工具栏图标视图开关： 22px 方块 / 6px
 *     ⑥ 灵感二级视图：       26px / 6px / 11.5px
 *   这类「不统一」在源码里**看不出来**：每处都写得对，只是各不相同。唯一钉得住
 *   它的判据是**跨控件相等** —— 所以下面的断言基本都是「A 的某值 == B 的某值」。
 *   任何一处单独改数字（哪怕改得合理），相等立刻变红。
 *
 * ★ 为什么放在 `scripts/` 而不是 `.build/preview/`：`.build/` 是 gitignore 的草稿区，
 *   把守卫放在那儿等于没提交 —— 下一个人 clone 下来就没有这道判据了。
 *   因此这里**不依赖任何预览帧**：PANEL_CSS 每次从 `ReaderPage.jsx` 现抽，
 *   `refinements.css` 直接读源码，只把宿主主题变量（`--dsw-alias-*`）用浅色近似值兜住。
 *   ⇒ 能查的是**几何**（高度 / 圆角 / 字号 / 内边距 / 底色关系 / 溢出），
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
 * 宿主主题变量的浅色近似。真机上 `--npr-*` 由 `--dsw-alias-*` 映射过来，这里没有宿主，
 * 所以按浅色主题手填一组同量级的值。**只影响颜色，不影响任何被断言的几何。**
 */
const THEME = `
:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f5f5f7;--dsw-alias-label-primary:#1b1b1f;
  --dsw-alias-label-secondary:#6b6b73;--dsw-alias-label-tertiary:#8e8e96;--dsw-alias-border-l1:#e3e3e8;
  --dsw-alias-border-l2:#cfcfd6;--dsw-alias-interactive-bg-hover:#f1f1f4;--dsw-alias-bg-layer-3:#fff}
html,body{margin:0;padding:0;background:#fff}`;

/**
 * 六处控件的真结构，逐字照抄 JSX（属性名、aria 状态、文案）。
 * ★ 文案用真机上最长的那一组：换短的测不出 268px 侧栏里的溢出。
 */
const BLOCKS = {
  filters: `<div class="npr-filters" role="group">
    <button type="button" aria-pressed="true">全部</button>
    <button type="button" aria-pressed="false">未读</button>
    <button type="button" aria-pressed="false">收藏</button>
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
  linkviews: `<div class="npr-diary-views" role="tablist" aria-label="灵感视图">
    <button type="button" role="tab" aria-selected="true" class="npr-diary-view is-on">按时间</button>
    <button type="button" role="tab" aria-selected="false" class="npr-diary-view">按书本</button>
    <button type="button" role="tab" aria-selected="false" class="npr-diary-view">按文章</button>
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

/** A 档 = 有槽的导航；B 档 = 没有槽的筛选。这个分组就是「两档」本身。 */
const NAV = ['libtabs', 'modes', 'linkviews', 'settings', 'viewswitch'];
const FILTER = ['filters'];
/** 有文字的那几处才参与「字号 / 字重」比较（图标开关没有文字）。 */
const TEXT_NAV = ['libtabs', 'modes', 'linkviews', 'settings'];

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
          bg: style.backgroundColor, display: style.display, gap: style.columnGap,
          clipped: wrap.scrollWidth - wrap.clientWidth,
        },
        buttons: [...wrap.querySelectorAll(':scope > button')].map((el) => {
          const s = cs(el);
          const b = el.getBoundingClientRect();
          return {
            text: el.textContent.trim(),
            pressed: el.getAttribute('aria-pressed') === 'true'
              || el.getAttribute('aria-selected') === 'true' || el.classList.contains('is-on'),
            h: +b.height.toFixed(2), w: +b.width.toFixed(2),
            radius: s.borderTopLeftRadius, fontSize: s.fontSize, fontWeight: s.fontWeight,
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

function render(width, extraCss) {
  const body = Object.entries(BLOCKS)
    .map(([key, html]) => `<div data-control="${key}">${html}</div>`)
    .join('\n      ');
  const file = join(dir, `tabs-${width}-${seq++}.html`);
  writeFileSync(file, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${THEME}</style>
<style>${PANEL_CSS}</style>
<style>${REFINEMENTS}</style>
${extraCss ? `<style>${extraCss}</style>` : ''}
<style>.npr-sidebar{width:${width}px;box-sizing:border-box}[data-control]{margin:0 0 14px}</style>
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
 * 一组「跨控件相等」判据。抽成函数是为了让**反向对照**能用同一个函数：
 * 变异版必须在这里返回非空失败清单 —— 那才说明判据量到了东西。
 */
function crossFailures(d) {
  const fails = [];
  const all = [...NAV, ...FILTER];
  const uniq = (values) => [...new Set(values.map(String))];

  const heights = uniq(all.flatMap((k) => d[k].buttons.map((b) => b.h)));
  if (heights.length !== 1) fails.push(`按钮高度不等：${all.map((k) => `${k}=${d[k].buttons[0].h}`).join(' / ')}`);

  const radii = uniq(all.flatMap((k) => d[k].buttons.map((b) => b.radius)));
  if (radii.length !== 1) fails.push(`按钮圆角不等：${all.map((k) => `${k}=${d[k].buttons[0].radius}`).join(' / ')}`);

  // A 档几个（含图标开关）的**槽高**必须一致：差 2px 就是「边框有没有占位」不一致
  //（26 + 2×2 padding + 2×1 border = 32）。
  const trackHeights = uniq(NAV.map((k) => d[k].container.h));
  if (trackHeights.length !== 1) fails.push(`槽高不等：${NAV.map((k) => `${k}=${d[k].container.h}`).join(' / ')}`);

  /**
   * 字号**分档**比：A 档（导航 13px）内部一致，B 档（筛选 12px）内部一致，且 A > B。
   * ★ 不把 A、B 合成一个数值比：那样只能二选一 —— 要么抹平层级，要么把两档做成同一个数。
   */
  const fontsA = uniq(TEXT_NAV.map((k) => d[k].buttons[0].fontSize));
  if (fontsA.length !== 1) fails.push(`A 档字号不等：${TEXT_NAV.map((k) => `${k}=${d[k].buttons[0].fontSize}`).join(' / ')}`);
  const fontsB = uniq(FILTER.map((k) => d[k].buttons[0].fontSize));
  if (fontsB.length !== 1) fails.push(`B 档字号不等：${FILTER.map((k) => `${k}=${d[k].buttons[0].fontSize}`).join(' / ')}`);
  if (parseFloat(fontsA[0]) <= parseFloat(fontsB[0])) {
    fails.push(`A 档字号 ${fontsA[0]} 不大于 B 档 ${fontsB[0]} —— 一级与二级没有层级差`);
  }

  const pressed = uniq([...TEXT_NAV, ...FILTER].flatMap((k) => d[k].buttons.filter((b) => b.pressed).map((b) => b.fontWeight)));
  const idle = uniq([...TEXT_NAV, ...FILTER].flatMap((k) => d[k].buttons.filter((b) => !b.pressed).map((b) => b.fontWeight)));
  if (pressed.length !== 1) fails.push(`选中态字重不等：${pressed.join(' / ')}`);
  if (idle.length !== 1) fails.push(`未选中态字重不等：${idle.join(' / ')}`);
  if (pressed.join() === idle.join()) fails.push(`选中与未选中字重相同（${pressed}）—— 选中态没有重量差`);

  // A 档必须有槽、B 档必须没有：这是两档之间**结构上**的差别。
  for (const key of NAV) {
    if (d[key].container.bg === 'rgba(0, 0, 0, 0)') fails.push(`${key} 没有槽（容器底色透明）—— A 档少了「换内容」的那层底座`);
  }
  for (const key of FILTER) {
    if (d[key].container.bg !== 'rgba(0, 0, 0, 0)') fails.push(`${key} 长了槽（${d[key].container.bg}）—— B 档不该有底座，两档就没差别了`);
  }

  // 槽里的块必须看得见：两块底色相同 ⇒ 选中项等于没有标记。
  for (const key of NAV) {
    const thumb = d[key].buttons.find((b) => b.pressed)?.bg;
    if (thumb === d[key].container.bg) fails.push(`${key} 的选中块与槽颜色相同（${thumb}）—— 选中态看不见`);
  }

  for (const key of all) {
    /**
     * ★ viewswitch 不查容器裁切：它右缘那条 `::after` 分隔线是**故意放在盒子外面**的
     *   （绝对定位到 100% + 8px，这样它不参与轨道填充）。`scrollWidth` 会把这 9px
     *   算成溢出 —— 那是设计的一部分，不是「被裁」。按钮自身的裁切照旧查。
     */
    if (key !== 'viewswitch' && d[key].container.clipped > 0) fails.push(`${key} 容器溢出 ${d[key].container.clipped}px`);
    for (const b of d[key].buttons) {
      if (b.clipped > 0) fails.push(`${key} 的「${b.text}」溢出 ${b.clipped}px`);
      if (b.w <= 0 || b.h <= 0) fails.push(`${key} 的「${b.text}」没渲染出来（${b.w}×${b.h}）`);
    }
  }
  return fails;
}

let bad = 0;
const check = (ok, message) => {
  if (!ok) { bad += 1; console.log(`  ✗ ${message}`); }
};

/**
 * `--shot <png>`：把 320px 的**同一份夹具**存成一张图供人眼复核。
 * ★ 另写一份截图脚本就会出现「判据看的是一套标记、眼睛看的是另一套」——
 *   0.44.4 那次「夹具照抄的是旧结构、断言全绿」正是这么来的。
 */
const shotIndex = process.argv.indexOf('--shot');
if (shotIndex !== -1) {
  const target = process.argv[shotIndex + 1];
  if (!target) throw new Error('--shot 后面要跟一个输出路径');
  const src = render(320, '');
  writeFileSync(target, readFileSync(src));
  console.log(`已写出夹具快照 → ${target}`);
  process.exit(0);
}

/** 268 = 侧栏下限（阅读页能拖到这儿），320 = 默认宽度。 */
for (const width of [320, 268]) {
  const d = run(render(width, ''));
  const fails = crossFailures(d);
  console.log(`\n${width}px`);
  for (const key of [...NAV, ...FILTER]) {
    const c = d[key].container;
    const p = d[key].buttons.find((b) => b.pressed);
    console.log(`  ${key.padEnd(10)} 槽 h=${c.h} r=${c.radius} pad=${c.padding} ${c.bg === 'rgba(0, 0, 0, 0)' ? '无槽' : '有槽'}`
      + ` · 按钮 h=${p.h} r=${p.radius} ${p.fontSize}/${p.fontWeight} · 选中「${p.text}」${p.w}px`);
  }
  if (fails.length === 0) console.log('  ok   六处同源：高度 / 圆角 / 字重逐值相等，A 档有槽 + 13px，B 档无槽 + 12px');
  for (const f of fails) check(false, f);
}

/**
 * 反向对照：只把「书架分页」的圆角改成 12px，其余一字不动。
 * ★ 用**同一个** crossFailures：它必须在变异上返回失败，否则那些相等断言其实什么都没量。
 */
{
  const d = run(render(320, '.npr-root .npr-libtabs > button { border-radius: 12px; }'));
  const fails = crossFailures(d);
  const hit = fails.some((f) => f.includes('圆角'));
  check(hit, `★ 反向对照失败：单独把 libtabs 的圆角改成 12px 之后判据仍是绿的 —— 相等断言是空的（实际：${fails.join(' | ') || '无'}）`);
  if (hit) console.log('\n  ok   ★ 反向对照：单独改一处圆角，跨控件相等立刻变红');
}

/**
 * 反向对照二：把两档的「有没有槽」**双向**破坏掉。
 * ★ 上面那条只证明「相等」在量东西；这条证明「层级」也在量东西 ——
 *   若把 A 档的槽抹平、或给 B 档加一个槽，两档就退化成同一个控件，
 *   而那正是 0.44.5 之前六套数字的共同病根（谁也不比谁高一级）。
 */
{
  const a = crossFailures(run(render(320, '.npr-root .npr-libtabs, .npr-root .npr-diary-modes, .npr-root .npr-diary-views, .npr-segmented, .npr-viewswitch { background: transparent; }')));
  const b = crossFailures(run(render(320, '.npr-root .npr-filters { background: rgba(0, 0, 0, 0.06); }')));
  const hitA = a.some((f) => f.includes('没有槽'));
  const hitB = b.some((f) => f.includes('长了槽'));
  check(hitA, `★ 反向对照失败：把 A 档的槽全抹成透明后判据仍是绿的（实际：${a.join(' | ') || '无'}）`);
  check(hitB, `★ 反向对照失败：给筛选条加一层底座后判据仍是绿的（实际：${b.join(' | ') || '无'}）`);
  if (hitA && hitB) console.log('  ok   ★ 反向对照：A 档失槽 / B 档长槽，两个方向都会变红');
}

console.log(bad === 0 ? '\nALL OK' : `\n${bad} 条不合格`);
process.exit(bad === 0 ? 0 : 1);
