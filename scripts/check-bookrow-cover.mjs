/**
 * 书籍行**封面位 + 状态角标**（0.45.3）。
 *
 * ★ 用户的原话是两句，合起来才是完整需求：
 *     ①「阅读选项下可以增加封面图位吗」
 *     ②「我觉得 A 角标好像醒目一些。C 的话就是还是放在全文字里，很难发现」
 *   而 0.45.3 之前我**否决过角标**，理由是「这页没有封面图位，角标只能去挤标题
 *   或动作列」。用户补上封面位之后，那个理由就不成立了 —— 角标贴到封面上，
 *   既不占标题的宽度，也不和动作列抢位置。**这道判据守的就是这件事**：
 *   角标必须在封面上（不是行上、不是文字里），而封面必须没把标题挤坏。
 *
 * ★ 为什么必须真量：
 *   · 侧栏最小 268px，一行里已经有「封面 36 + 动作列约 76 + 两处内边距 26」，
 *     留给标题的只有一百出头。多 4px 就会让 7 字的书名折行 —— 这不是「略窄」，
 *     是「书名读不全」。
 *   · 角标是 `position: absolute` + 负偏移（出血）。锚点一旦从 `.npr-bookrow-cover`
 *     退到 `.npr-bookrow`，它还是会「看起来在这附近」，但会盖到动作列上去 ——
 *     这种错**量不出来就没有任何东西拦得住**。
 *
 * ★ 不依赖预览帧（`.build/` 是 gitignore 的草稿区，守卫放那儿等于没提交）：
 *   PANEL_CSS 每次从 `ReaderPage.jsx` 现抽、`refinements.css` 直读源码，
 *   宿主主题变量用近似值兜住。查的是**几何与相对关系**，不查色值精不精确。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const REFINEMENTS = readFileSync(join(ROOT, 'src/client/refinements.css'), 'utf8');
const LIBRARY_APP = readFileSync(join(ROOT, 'src/client/LibraryApp.jsx'), 'utf8');

const panelSrc = readFileSync(join(ROOT, 'src/client/ReaderPage.jsx'), 'utf8');
const panelMatch = /const PANEL_CSS = `([\s\S]*?)\n`;/.exec(panelSrc);
if (!panelMatch) throw new Error('没从 ReaderPage.jsx 里抽出 PANEL_CSS —— 骨架缺失时量出来的是假几何，拒绝继续');
const PANEL_CSS = panelMatch[1];

const FONT = `font-family: -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 13px; line-height: 1.5;`;

const THEME = `
:root{--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f5f5f7;--dsw-alias-label-primary:#1b1b1f;
  --dsw-alias-label-secondary:#6b6b73;--dsw-alias-label-tertiary:#8e8e96;--dsw-alias-border-l1:#e3e3e8;
  --dsw-alias-border-l2:#cfcfd6;--dsw-alias-interactive-bg-hover:#f1f1f4;--dsw-alias-bg-layer-3:#fff;
  --dsw-alias-brand-primary:#2f9e6e;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#2f9e6e}
html,body{margin:0;padding:0;background:#fff}
.npr-root{${FONT}}`;

const THEME_DARK = `
:root{--dsw-alias-bg-base:#191919;--dsw-alias-bg-layer-1:#232323;--dsw-alias-label-primary:#e8e8ec;
  --dsw-alias-label-secondary:#a0a0a8;--dsw-alias-label-tertiary:#77777f;--dsw-alias-border-l1:#2e2e33;
  --dsw-alias-border-l2:#3c3c43;--dsw-alias-interactive-bg-hover:#262629;--dsw-alias-bg-layer-3:#202024;
  --dsw-alias-brand-primary:#4ecfa8;--dsw-focus-ring-width:2px;--dsw-focus-ring-color:#4ecfa8}
html,body{margin:0;padding:0;background:#191919}
.npr-root{${FONT}}`;

/** 侧栏两个宽度：268 是拖到最窄的下限，320 是默认。 */
const WIDTHS = [268, 320];

/**
 * 一行书的真结构（逐字照抄 `LibraryApp.jsx` 的 `BookRow`）。
 *
 * ★ 书名用真机上最长的之一（`影响力（全新升级版）` 10 字）+ 一个 7 字的短名做对照：
 *   只量长名会看不出「短名其实早就放得下」，只量短名则量不出折行边界。
 * ★ 动作列两枚竖排按钮不能省：它是吃掉 76px 的那一方，去掉它标题会宽得很轻松，
 *   于是「加封面后标题够不够」这条判据会假绿。
 */
function row(scope, { title, flag, badge, badgeText, mark }) {
  /* ★ `badgeText` 为空时**整个徽章都不渲染**（不是渲染一个空 span）：这正是真机行为
     —— `BookRow` 里那句是 `metaBadge !== '' && (...)`。夹具里留一个空 span 会多出
     一个 7px 的 gap（`.npr-bookrow-meta` 是 flex + gap），量出来的元信息行高比真机
     宽一点点，判据就变成在量一个不存在的东西。 */
  const badgeHtml = badgeText === ''
    ? ''
    : `<span class="npr-bookrow-badge ${badge}">${badgeText}</span>`;
  return `<div class="npr-bookrow" id="row-${scope}">
    <button type="button" class="npr-bookrow-main">
      <span class="npr-bookrow-cover">
        <span class="npr-diary-cover" data-kind="made" data-image="no" style="--npr-cover-h: 212">
          <span class="npr-diary-cover-made">
            <span class="npr-diary-cover-glyph">影</span>
            <span class="npr-diary-cover-caption">影响力</span>
          </span>
        </span>
        <span class="npr-bookrow-flag ${flag}" aria-hidden="true">${mark}</span>
      </span>
      <span class="npr-bookrow-body">
        <span class="npr-bookrow-title">${title}</span>
        <span class="npr-bookrow-meta">
          <span class="npr-bookrow-source is-local">本地 · NPIE_Book</span>
          ${badgeHtml}
          <span class="npr-bookrow-file">PDF · 7.7 MB</span>
        </span>
      </span>
    </button>
    <span class="npr-bookrow-acts">
      <button type="button" class="npr-bookrow-action">写读后感</button>
      <button type="button" class="npr-bookrow-action">重新阅读</button>
    </span>
  </div>`;
}

/** 无封面的一行：书架页（2634 本）走的就是这一支，用来对照封面到底吃掉了多少宽度。 */
const noCover = (scope, title) => `<div class="npr-bookrow" id="row-${scope}">
    <button type="button" class="npr-bookrow-main">
      <span class="npr-bookrow-body">
        <span class="npr-bookrow-title">${title}</span>
        <span class="npr-bookrow-meta">
          <span class="npr-bookrow-source is-local">本地 · NPIE_Book</span>
          <span class="npr-bookrow-badge npr-badge-reading">在读 · 读到 24 / 387 页</span>
          <span class="npr-bookrow-file">PDF · 7.7 MB</span>
        </span>
      </span>
    </button>
    <span class="npr-bookrow-acts">
      <button type="button" class="npr-bookrow-action">重新阅读</button>
    </span>
  </div>`;

const BLOCKS = {
  reading: row('reading', { title: '影响力（全新升级版）', flag: 'npr-flag-reading', badge: 'npr-badge-reading', badgeText: '读到 24 / 387 页', mark: '在' }),
  /* ★ 终态两行的 `badgeText` 是**空串**（读完 / 弃读都交给角标说）：这与 `bookRowView`
     的 `badgeProgress` 一致 —— `read` / `dropped` 在阅读页不再往元信息行写徽章。
     之前夹具里写着「读完」/「弃读」，量到的是「角标说一遍、徽章再说一遍」的旧形态，
     于是这两行的元信息被挤成两行（PDF 孤零零掉到下面），而真机早已不是那样。 */
  done: row('done', { title: '1984（中英）', flag: 'npr-flag-read', badge: 'npr-badge-read', badgeText: '', mark: '完' }),
  dropped: row('dropped', { title: '思考，快与慢', flag: 'npr-flag-dropped', badge: 'npr-badge-dropped', badgeText: '', mark: '弃' }),
  short: row('short', { title: '如何阅读一本书', flag: 'npr-flag-reading', badge: 'npr-badge-reading', badgeText: '读到 210 / 376 页', mark: '在' }),
  none: noCover('none', '影响力（全新升级版）'),
};

const PROBE = `
<script>
(() => {
  const measure = () => {
    const cs = (el) => getComputedStyle(el);
    const rect = (el) => {
      if (el === null) return null;
      const b = el.getBoundingClientRect();
      return { x: +b.left.toFixed(2), y: +b.top.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2), right: +b.right.toFixed(2), bottom: +b.bottom.toFixed(2) };
    };
    const out = {};
    for (const box of document.querySelectorAll('[data-row]')) {
      const scope = box.getAttribute('data-row');
      const rowEl = box.querySelector('.npr-bookrow');
      const cover = box.querySelector('.npr-bookrow-cover');
      const flag = box.querySelector('.npr-bookrow-flag');
      const title = box.querySelector('.npr-bookrow-title');
      const body = box.querySelector('.npr-bookrow-body');
      out[scope] = {
        row: rect(rowEl),
        cover: rect(cover),
        flag: rect(flag),
        title: rect(title),
        body: rect(body),
        meta: rect(box.querySelector('.npr-bookrow-meta')),
        acts: rect(box.querySelector('.npr-bookrow-acts')),
        main: rect(box.querySelector('.npr-bookrow-main')),
        coverStyle: cover === null ? null : { position: cs(cover).position, width: cs(cover).width },
        flagStyle: flag === null ? null : {
          bg: cs(flag).backgroundColor, color: cs(flag).color,
          fontSize: cs(flag).fontSize, radius: cs(flag).borderTopLeftRadius,
        },
        titleOverflowX: title.scrollWidth - title.clientWidth,
        titleOverflowY: title.scrollHeight - title.clientHeight,
      };
    }
    return out;
  };
  const dump = () => { document.title = 'D:' + JSON.stringify(measure()); };
  if (document.readyState === 'complete') setTimeout(dump, 300);
  else window.addEventListener('load', () => setTimeout(dump, 300));
})();
</script>`;

const dir = mkdtempSync(join(tmpdir(), `npie-cover-${process.pid}-`));
let seq = 0;

function render(width, extraCss = '', theme = THEME) {
  const body = Object.entries(BLOCKS)
    .map(([key, html]) => `<div data-row="${key}">${html}</div>`)
    .join('\n      ');
  const file = join(dir, `cover-${width}-${seq++}.html`);
  writeFileSync(file, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${theme}</style>
<style>${PANEL_CSS}</style>
<style>${REFINEMENTS}</style>
${extraCss === '' ? '' : `<style>${extraCss}</style>`}
<style>.npr-sidebar{width:${width}px;box-sizing:border-box;padding:10px 0}[data-row]{margin:0}</style>
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

let bad = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { bad += 1; console.log(`  FAIL ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const near = (a, b, tol = 0.8) => Math.abs(a - b) <= tol;

/**
 * 一组判据。抽成函数是为了让**反向对照**用同一个函数 —— 变异版必须在里面
 * 返回非空失败清单，否则说明这条判据量不到东西。
 */
function coverFailures(d, width) {
  const fails = [];

  // ── 1. 封面本身：36 宽、3:4，而且在标题**左侧** ─────────────────────────
  /**
   * ★ 最后那半条（在左边）是**反向对照逼出来的**：把 `flex-direction` 从 row 改回
   *   column 时，封面会跑到标题上方 —— 而这时标题反而**变宽**（封面不再吃它的宽度），
   *   于是「标题够不够宽」那一条完全不会响。真正坏掉的是方位：封面与文字从
   *   「并排」变成了「上下摞」，行高会翻倍，而这条判据是唯一看得见它的。
   */
  for (const key of ['reading', 'done', 'dropped', 'short']) {
    const s = d[key];
    if (s.cover === null) { fails.push(`${key} 没有封面（showCover 为真时必须渲染）`); continue; }
    if (!near(s.cover.w, 36)) fails.push(`${key} 封面宽 ${s.cover.w}px，应为 36px`);
    if (!near(s.cover.h, 54, 1.2)) fails.push(`${key} 封面高 ${s.cover.h}px，应约 54px（2:3）—— 3:4 的 48px 比文字块矮一截，看着像张缩得太小的图`);
    if (s.title !== null && s.cover.right > s.title.x + 0.5) {
      fails.push(`${key} 封面右缘 ${s.cover.right} 越过了标题左缘 ${s.title.x} —— 封面不在标题左侧（竖排了？）`);
    }
    /** 竖直方向必须与标题重叠：不重叠就说明它们摞成了上下两段。 */
    if (s.title !== null && (s.cover.bottom <= s.title.y + 0.5 || s.cover.y >= s.title.bottom - 0.5)) {
      fails.push(`${key} 封面与标题在竖直方向上不重叠 —— 它们摞成了上下两段`);
    }
  }

  // ── 2. 标题可用宽度：加封面之后还剩多少 ─────────────────────────────────
  /**
   * ★ 下限按「能装下 7 个汉字」定：`如何阅读一本书`（7 字）在 13px / 600 下约
   *   91px，留一点余量 ⇒ 268px 侧栏下 108px。低于这个数，7 字书名就要折行 ——
   *   而折行之后只有两行可用（`-webkit-line-clamp: 2`），10 字书名必然被截。
   * ★ 320px 下按比例抬高：多出来的 52px 应当**归标题**（封面与动作列都不跟着变宽）。
   */
  const minTitle = width <= 268 ? 108 : 160;
  for (const key of ['reading', 'done', 'dropped', 'short']) {
    const w = d[key].title === null ? 0 : d[key].title.w;
    if (w < minTitle) fails.push(`${key} 标题只剩 ${w}px（${width}px 侧栏下限 ${minTitle}px）—— 7 字书名要折行`);
  }

  // ── 3. 封面吃掉的宽度必须真的还给文字 ───────────────────────────────────
  /**
   * ★ 反向守恒：有封面与无封面两行的**标题差**应该约等于「封面宽 + 间距」。
   *   差得太多 ⇒ 多出一层没用的盒子在吃宽度（`body` 没设 `flex: 1` 时就是这样：
   *   它会收缩到内容宽，于是封面旁边多出一条空白）。
   */
  const delta = d.none.title.w - d.reading.title.w;
  if (!near(delta, 36 + 9, 2.5)) {
    fails.push(`有无封面时标题差 ${delta.toFixed(1)}px，应约 45px（封面 36 + 间距 9）—— 多出来的宽度不是封面吃的`);
  }

  // ── 4. 角标必须在**封面**的右上角，且出血朝外 ───────────────────────────
  for (const key of ['reading', 'done', 'dropped']) {
    const { cover, flag, row: rowBox } = d[key];
    if (flag === null || cover === null) { fails.push(`${key} 没有角标`); continue; }
    if (d[key].coverStyle === null || d[key].coverStyle.position !== 'relative') {
      fails.push(`${key} 的封面不是定位容器（position=${d[key].coverStyle?.position}）—— 角标会跑到行上`);
    }
    const bleedRight = flag.right - cover.right;
    const bleedTop = cover.y - flag.y;
    if (bleedRight < 1 || bleedRight > 6) {
      fails.push(`${key} 角标右缘出血 ${bleedRight.toFixed(1)}px，应在 1–6px（贴在封面右上角的外沿）`);
    }
    if (bleedTop < 1 || bleedTop > 6) {
      fails.push(`${key} 角标上缘出血 ${bleedTop.toFixed(1)}px，应在 1–6px`);
    }
    /** 出血 ≠ 越界：角标必须整块落在这一行里，否则会被侧栏的滚动容器裁掉一半。 */
    if (flag.x < rowBox.x - 0.5 || flag.right > rowBox.right + 0.5) {
      fails.push(`${key} 角标出了行的左右边界（行 ${rowBox.x}–${rowBox.right}，角标 ${flag.x}–${flag.right}）`);
    }
    if (flag.w < 16 || flag.h < 16) fails.push(`${key} 角标只有 ${flag.w}×${flag.h}，一个 10px 的字泡在里面`);
  }

  // ── 5. 三档必须真的不同 ─────────────────────────────────────────────────
  /**
   * ★ 量的是**底色**而不是文字：三个字（在/完/弃）本来就不同，光比文字等于什么都没比。
   *   而「读完」与「弃读」如果底色一样，用户在列表里看到的就还是两块灰 —— 那正是
   *   用户这次要解决的问题。
   */
  const bgs = ['reading', 'done', 'dropped'].map((k) => d[k].flagStyle?.bg ?? '');
  if (new Set(bgs).size !== 3) {
    fails.push(`三档角标底色不互异：${bgs.join(' / ')}`);
  }
  /** 「弃读」必须比「读完」弱：它的字色应当更接近背景（transparent 的 alpha 更低 / 灰阶更近）。 */
  const luma = (rgb) => {
    const n = (rgb.match(/[\d.]+/g) ?? []).map(Number);
    return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
  };
  const readContrast = Math.abs(luma(d.done.flagStyle.color) - luma(d.done.flagStyle.bg));
  const dropContrast = Math.abs(luma(d.dropped.flagStyle.color) - luma(d.dropped.flagStyle.bg));
  if (!(dropContrast < readContrast)) {
    fails.push(`「弃读」角标的对比度 ${dropContrast.toFixed(0)} 不低于「读完」的 ${readContrast.toFixed(0)} —— 三档没有形成强/最强/弱的梯队`);
  }

  // ── 6. 标题不许横向溢出 ─────────────────────────────────────────────────
  for (const key of Object.keys(d)) {
    if (d[key].titleOverflowX > 1) {
      fails.push(`${key} 标题横向溢出 ${d[key].titleOverflowX}px —— 长书名把行撑破了`);
    }
  }

  // ── 7. 元信息行不许因为加封面而换行 ─────────────────────────────────────
  /**
   * ★ 这条是**实测逼出来的**：加封面吃掉 45px 之后，`在读 · 读到 24 / 387 页`
   *   会把 `PDF / 7.7 MB` 挤成第三行，而且第三行只剩 `7.7 MB` 一个孤儿
   *   —— 行高从 76 涨到 96，截图上只显得「突然空了一截」，说不出是哪条引起的。
   * ⇒ 阅读页的徽章只留进度（`badgeProgress`），终态干脆不写；状态由角标承担。
   *   实测效果：320px 下从**三行 + 孤儿**降到**两行且两行都有内容**
   *   （`本地 · NPIE_Book / 读到 24 / 387 页` 一行，`PDF / 7.7 MB` 一行）。
   *
   * ★ 为什么不在 320px 上硬要求单行：那是**物理放不下**，不是没做好。封面 36 + 间距 9
   *   + 动作列 76 + 两侧内边距 26 之后，一行只剩 183px，而四项内容光字宽就 266px。
   *   真要单行只剩「删掉来源徽章」一条路 —— 而来源是用户 2026-10-23 明确要求
   *   能一眼分辨的东西（「分不清楚哪个是本地目录下的电子书，哪个是网盘」），
   *   不能为了排版把它砍掉。所以判据守的是「不许更多行」，不是「必须一行」。
   */
  const maxMetaH = width >= 320 ? 46 : 70;
  for (const key of ['reading', 'done', 'dropped', 'short']) {
    const h = d[key].meta === null ? 0 : d[key].meta.h;
    if (h > maxMetaH) {
      fails.push(`${key} 元信息行高 ${h}px（${width}px 侧栏上限 ${maxMetaH}px）—— 加封面之后行数又涨了`);
    }
  }

  return fails;
}

console.log(`书籍行封面位 + 状态角标（0.45.3）\n`);

const measured = {};
for (const width of WIDTHS) {
  const d = run(render(width));
  measured[width] = d;
  console.log(`── ${width}px 侧栏 ─────────────────────────────────────`);
  for (const [key, s] of Object.entries(d)) {
    const t = s.title === null ? 0 : s.title.w;
    console.log(`  ${key.padEnd(9)} 封面 ${s.cover === null ? '—' : `${s.cover.w}×${s.cover.h}`}`
      + ` · 标题 ${t} · 行高 ${s.row.h} · 元信息 ${s.meta === null ? '—' : s.meta.h}`
      + ` · 角标 ${s.flag === null ? '—' : `${s.flag.w}×${s.flag.h} @右出血 ${(s.flag.right - (s.cover?.right ?? 0)).toFixed(1)}`}`);
  }
  const fails = coverFailures(d, width);
  for (const f of fails) fail(f);
  if (fails.length === 0) ok(`${width}px：封面 36×54 / 标题够宽 / 角标贴封面右上 / 三档互异`);
}

// ── 7. 源码级：书架页不画封面（2634 行） ───────────────────────────────────
{
  const hasGate = /showCover=\{onReadingTab\}/.test(LIBRARY_APP);
  check(hasGate, 'showCover 由「是否阅读页」决定 —— 书架页 2634 行不画封面');
  const hasCoverImport = /from '\.\/BookCover\.jsx'/.test(LIBRARY_APP);
  check(hasCoverImport, '复用日记书墙的 BookCover（三种来源已在那边收敛过，PDF 那条带懒加载）');
}

// ── 反向对照：每条都必须让判据变红 ───────────────────────────────────────
console.log('\n反向对照');
const mutant = (label, css, expect) => {
  const d = run(render(268, css));
  const fails = coverFailures(d, 268);
  const hit = fails.find((f) => f.includes(expect));
  if (hit) ok(`★ ${label} → ${hit.slice(0, 46)}…`);
  else fail(`★ 反向对照失效：${label}，判据没认出来（实际：${fails.join(' | ') || '无'}）`);
};

mutant('封面宽 36 → 60', '.npr-root { --npr-cover-w: 60px }', '标题只剩');
mutant('封面不再是定位容器', '.npr-root .npr-bookrow-cover { position: static }', '不是定位容器');
mutant('角标退到行上（锚点错误）',
  '.npr-root .npr-bookrow-cover { position: static } .npr-root .npr-bookrow { position: relative } .npr-root .npr-bookrow-flag { top: -4px; right: 8px }',
  '右缘出血');
mutant('封面列与文字列改回竖排',
  '.npr-bookrow-main { flex-direction: column }', '封面不在标题左侧');
mutant('「弃读」角标抄「读完」的底色',
  '.npr-root .npr-bookrow-flag.npr-flag-dropped { background: var(--npr-fg); color: var(--npr-bg) }', '底色不互异');
mutant('文字列不收缩（多出一条空白）',
  '.npr-bookrow-body { flex: 0 0 auto }', '有无封面时标题差');

const shotIndex = process.argv.indexOf('--shot');
if (shotIndex !== -1) {
  const target = process.argv[shotIndex + 1];
  if (!target) throw new Error('--shot 后面要跟一个输出路径');
  const theme = process.argv.includes('--dark') ? THEME_DARK : THEME;
  writeFileSync(target, readFileSync(render(320, '', theme)));
  console.log(`\n已写出夹具快照 → ${target}`);
}

console.log(bad === 0 ? '\nALL OK' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
