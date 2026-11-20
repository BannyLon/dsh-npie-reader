#!/usr/bin/env node
/**
 * 书页区的**真几何**核对（0.19.0）：目录在左、伴读在右、要点浮层只盖书页。
 *
 * ★ 为什么源码断言不够（本项目的老账）：`test/book-layout.test.mjs` 只能证明
 *   「DOM 里 `<BookDigestPanel>` 写在 `<div className="npr-book-stage">` 之前」，
 *   答不了「画出来它到底在哪边」。CSS 至少有四种办法让顺序与位置分叉，且都不报错：
 *     - `flex-direction: row-reverse`；
 *     - `order`（本项目踩过 `order: .5` 被**静默丢弃**）；
 *     - 把元素 `position: absolute` 挪走；
 *     - 祖先链上某条 `direction: rtl`。
 *   ⇒ 这里用真 Chrome 量 `getBoundingClientRect()`，量的是**像素**。
 *
 * ★ 判据的由来（用户原话）：「目录是不是应该在电子书的左边，现在显示在右边。」
 *   紧接着的一句修正：「目录在左，伴读在右啊。」——所以这是**两侧**的判据，
 *   不是「都挪到左边」。第一版就是都挪到左边，被用户当场指出来了。
 *
 * ★ 每条判据都配**反向对照**：把判据的**原式**喂给一个真的坏摆法，要求变红。
 *   另写一条「旧版应该怎样」只是在描述旧实现，证明不了判据有牙。
 *
 * 运行：node scripts/check-book-panel-layout.mjs
 * 退出码：0 全绿 / 1 有断言失败 / 2 Chrome 不可用（**不静默跳过**）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Chrome 候选路径。找不到就**报错退出**，绝不「跳过」。 */
const CHROME_CANDIDATES = [
  process.env.NPIE_CHROME,
  join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome。设 NPIE_CHROME=<可执行文件> 再跑。候选：');
  for (const p of CHROME_CANDIDATES) console.error(`  ${p}`);
  process.exit(2);
}

// ---- 1. CSS 与宿主令牌从**真源码**里取 -------------------------------------
const readerSrc = readFileSync(join(pluginRoot, 'src/client/ReaderPage.jsx'), 'utf8');
const cssStart = readerSrc.indexOf('const PANEL_CSS = `');
const cssEnd = readerSrc.indexOf('`;', cssStart);
if (cssStart < 0 || cssEnd < cssStart) throw new Error('抽 PANEL_CSS 失败（边界切错了）');
const PANEL_CSS = readerSrc.slice(cssStart + 'const PANEL_CSS = `'.length, cssEnd);
const REFINEMENTS = readFileSync(join(pluginRoot, 'src/client/refinements.css'), 'utf8');

/**
 * 抽错了就当场停 —— 否则后面所有判据都在量一个**不存在的规则**，
 * 而症状是「全部通过」。
 */
for (const anchor of [
  '.npr-reader{',
  'container-type:inline-size',           // @container 的量测对象就是它
  '.npr-book-toolbar{',
]) {
  if (!PANEL_CSS.includes(anchor)) throw new Error(`PANEL_CSS 里没有 ${anchor} —— 抽错了`);
}
for (const anchor of [
  '.npr-book-main { display: flex;',
  '.npr-book-stage { flex: 1;',
  /* ★ 只钉「意图」：目录是**固定宽**的侧栏（`flex: 0 0 <宽>`），不钉那个宽是多少。
     原来这里写着 `306px`，0.25.x 把宽度换成 `var(--npr-book-side-w)` 之后，
     这一行 `includes` 直接抛错 ⇒ **整个脚本在模块加载期就死了**，
     从那次改动起 `npm run verify:book-layout` 一条几何都没量过。
     （同一个坑 `test/book-layout.test.mjs` 也踩过，已一并改成钉前缀。） */
  '.npr-book-digest { flex: 0 0 ',
  '.npr-book-companion { flex: 0 0 348px;',
  '.npr-digest-card { position: absolute;',
  '.npr-book-main { flex-direction: column; }',
  /* ★ 0.24.3：`order` 挂到了 `.npr-book-view`（舞台外面新加的那层，浮动按钮的定位基准）。
     锚点必须跟着走 —— 只改 CSS 不改锚点的话，这条 `includes` 会直接抛错（好在它是
     throw 不是 check，否则就会静默漏掉「窄面板里目录排在书页之后」这一整条判据）。 */
  '.npr-book-main > .npr-book-view { order: 1; }',
  '.npr-book-view { position: relative;',
]) {
  if (!REFINEMENTS.includes(anchor)) throw new Error(`refinements.css 里没有 ${anchor} —— 抽错了`);
}
/**
 * ★ 「改前那两列」不在这份脚本里：本脚本只量**现在**的摆法 + 用真坏摆法做反向
 *   对照。理由是 0.18.x 那份 CSS 已经不在真样式表里了，把它抄回来当夹具，抄的
 *   过程本身就会引入与判据无关的差别（本项目踩过「对照列与判据差的不止这一次改动」）。
 *   反向对照只需要**几何形态**对：目录在书页之后 = 旧摆法。
 */

/** 宿主令牌（浅色）。全部 `--npr-*` 都由它们派生，缺一个就会毒化成空值。 */
const HOST = `:root, body {
  --dsw-alias-bg-base: #ffffff; --dsw-alias-bg-layer-1: #f7f8f9;
  --dsw-alias-bg-layer-2: #f1f2f4; --dsw-alias-bg-layer-3: #ffffff;
  --dsw-alias-bg-mask-1: rgba(15,17,21,.4);
  --dsw-alias-label-primary: #0f1115; --dsw-alias-label-secondary: #61666b;
  --dsw-alias-label-tertiary: #81858c;
  --dsw-alias-border-l1: #e6e8ea; --dsw-alias-border-l2: #d5d8dc;
  --dsw-alias-interactive-bg-hover: #f1f2f4; --dsw-alias-brand-primary: #3d58e0;
  --dsw-alias-state-error-primary: #d92d20;
  --dsw-focus-ring-width: 1px; --dsw-focus-ring-color: #3d58e0;
}`;

// ---- 2. 夹具：四块真结构（宽处目录 / 宽处伴读 / 窄处目录 / 旧摆法）-----------
/**
 * ★ 全部用**真实的类名**搭，不自己写颜色 / 间距：那样量到的是「我以为的取值」，
 *   而不是组件真的取了什么。
 * ★ `.npr-root` 的宽度就是 `@container` 的量测对象（它身上有 `container-type:
 *   inline-size`），所以「宽 / 窄」只由这一条内联宽度决定，不靠视口。
 */

/**
 * 目录面板的正文。类名逐字来自 `BookDigestPanel.jsx`。
 * `open` 决定导出块是折叠还是展开 —— 两种状态都要量：
 * 折叠态要保证章节列表还放得下 3 行；展开态要保证整块不溢出面板。
 */
/**
 * 导出块。类名逐字来自 `SkillExport.jsx`（0.20.1 的两行 summary + chevron）。
 * ★ 抽成函数是为了让**反向对照能用同一段真结构** —— 另写一份「坏掉的 HTML」不算
 *   对照，那只是又写了一遍我以为的样子。反向对照必须只改 CSS。
 */
const skillBlock = ({ open = false } = {}) => `<details class="npr-skill"${open ? ' open' : ''}>
        <summary>
          <span class="npr-skill-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08"></path></svg></span>
          <span class="npr-skill-text"><span class="npr-skill-title">导出成技能包</span><span class="npr-skill-sub">索引 + 每章一份 + 术语表，agent 按需读</span></span>
          <span class="npr-skill-badge">已导出</span>
          <svg class="npr-skill-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m6 9 6 6 6-6"></path></svg>
        </summary>
        <div class="npr-skill-body">
          <div class="npr-skill-row">
            <select class="npr-skill-profile"><option>自动判断（按正文）</option></select>
            <button type="button" class="npr-skill-go"><span>导出</span></button>
          </div>
          <label class="npr-skill-synth"><input type="checkbox"><span>跨章综合（+1 次调用）</span></label>
          <small class="npr-skill-hint">SKILL.md 12.4 KB · 24 个文件 · 268 KB · 4.1k 行</small>
          <div class="npr-skill-last">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20"></path></svg>
            <span class="npr-skill-last-text">已导出 <code>…/skills/the-pragmatic-programmer-20th-anniversary</code> · 2/3 章</span>
            <button type="button" class="npr-skill-copy" aria-label="复制技能包的完整路径"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2Z"></path></svg></button>
          </div>
        </div>
      </details>`;

/**
 * 目录面板的主体。
 * ★ `label` 默认用**真实最长的那句**（`继续生成（120 章）`），不是顺手那句
 *   `生成解读（2 章）`：判据 ㉑ 量的是「两颗按钮挤不挤得下」，短文案挤不出去 ——
 *   用短文案当样本，判据就永远绿（0.24.0 判据 ⑳ 的反向对照正是这么假绿过一次）。
 */
const panelBody = ({ open = false, label = '继续生成（120 章）' } = {}) => `<header class="npr-companion-header"><strong>本书目录</strong></header>
      <div class="npr-companion-context"><strong>猎人笔记</strong><small>19 章 · 共 402 页</small></div>
      <div class="npr-digest-generate">
        <div class="npr-digest-select">
          <span class="npr-digest-select-count">已选 2 章</span>
          <button type="button" class="npr-digest-link" disabled>全选</button>
          <button type="button" class="npr-digest-link">全不选</button>
        </div>
        <div class="npr-digest-actions">
          <button type="button" class="npr-digest-start"><span>${label}</span></button>
          <button type="button" class="npr-digest-skill"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"></path></svg><span>book-to-skill</span></button>
        </div>
        <small class="npr-digest-hint">约 3 千字输入 · 2 次调用（最多 4 次）</small>
        <label class="npr-digest-model"><span>模型</span>
          <select class="npr-ai-model"><option>跟随 Harness 默认模型</option></select></label>
      </div>
      <ol class="npr-digest-list">
        <li class="npr-digest-item"><div class="npr-digest-line">
          <input type="checkbox" class="npr-digest-check" checked>
          <button type="button" class="npr-digest-row"><span class="npr-digest-n">01</span><span class="npr-digest-title">第 1 章 · 霍尔与卡里内奇</span><span class="npr-digest-page">p.20–39</span></button>
        </div></li>
        <li class="npr-digest-item is-expanded"><div class="npr-digest-line">
          <input type="checkbox" class="npr-digest-check" checked>
          <button type="button" class="npr-digest-row is-active"><span class="npr-digest-n">02</span><span class="npr-digest-title">第 2 章 · 叶尔莫莱与磨坊主妇</span><span class="npr-digest-page">p.40–59</span></button>
          <button type="button" class="npr-digest-peek">v</button>
        </div></li>
        <li class="npr-digest-item"><div class="npr-digest-line">
          <input type="checkbox" class="npr-digest-check">
          <button type="button" class="npr-digest-row"><span class="npr-digest-n">03</span><span class="npr-digest-title">第 3 章 · 莓泉</span><span class="npr-digest-page">p.60–79</span></button>
        </div></li>
      </ol>
      ${skillBlock({ open })}`;

const PANEL_BODY = panelBody();

/** 伴读面板的正文。类名逐字来自 `BookCompanion.jsx`。 */
const COMPANION_BODY = `<header class="npr-companion-header"><strong>AI 伴读</strong></header>
      <div class="npr-companion-context"><strong>猎人笔记</strong><small>第 32 页</small></div>
      <div class="npr-native-chat npr-book-companion-chat"></div>`;

/** 章节要点浮层。类名逐字来自 `DigestCard.jsx`。 */
const CARD = `<div class="npr-digest-card" id="CARDID">
        <div class="npr-digest-card-head">
          <span class="npr-digest-card-title">第 2 章 · 叶尔莫莱与磨坊主妇</span>
          <button type="button" class="npr-digest-link">跳页</button>
          <button type="button" class="npr-digest-link">收起</button>
        </div>
        <div class="npr-digest-card-body">
          <div class="npr-digest-body">
            <p class="npr-digest-summary">这一段交代了叙事者与叶尔莫莱的相识，以及磨坊主妇的处境。</p>
            <ul class="npr-digest-points"><li>叙事者以打猎为由进入庄园。</li><li>磨坊主妇的身份是全章的关键。</li></ul>
            <span class="npr-digest-model-tag">模型 free/small</span>
          </div>
        </div>
      </div>`;

/**
 * 书页区。★ 0.24.3 起外面多一层 `.npr-book-view`（舞台 + 浮动按钮的定位基准），
 * 夹具必须同形 —— 否则 `@container` 里 `.npr-book-main > .npr-book-view { order: 1 }`
 * 命中 0 个元素，而目录面板的 `order: 2` 照样把顺序排对，判据 ⑨ 就变成**假绿**：
 * 它证明不了「order 落在正确的层上」。实测过：没这层时 stage 的 computed order 是 0。
 * ★ view 层不带 id（用 `#xxx-main > .npr-book-view` 定位）：九块夹具各调一次
 *   `STAGE.replace('STAGEID', …)`，多一个占位符就要改九处调用。
 */
const STAGE = `<div class="npr-book-view"><div class="npr-book-stage" id="STAGEID">
        <canvas class="npr-book-canvas" width="900" height="1200"></canvas>
      </div></div>`;

/**
 * 一块完整的书页区。`inner` 决定面板摆在哪一侧 —— 这正是被量的东西。
 * ★ 高度必须给死：`.npr-book{flex:1}` 的高度链要靠它才成立。
 */
const reader = (id, width, height, inner) => `<div class="npr-root" id="${id}" style="width:${width}px;height:${height}px">
    <section class="npr-reader npr-reader-book" id="${id}-reader">
      <div class="npr-book">
        <!-- 顶部只剩一条 10px 拖动条（0.22.0）：这块脚本量的是「面板放在哪一侧」，
             顶部结构只要别把高度算错就行，不该再摆一排已经不存在的按钮。 -->
        <div class="npr-book-toolbar" id="${id}-toolbar" data-window-drag></div>
        <div class="npr-book-meta" id="${id}-meta"><span>PDF · 19 章</span><span>适应宽度 · 100%</span></div>
        <div class="npr-book-main" id="${id}-main">
      ${inner}
        </div>
      </div>
    </section>
  </div>`;

const WIDE = 1200;
const NARROW = 780;
/**
 * 高度给 470：目录列表在 400px 里会被裁掉最后一行 —— 交付图上看起来像渲染 bug。
 * 判据不依赖这个数（都是相对位置），但它决定了图能不能自证。
 */
const H_TALL = 470;
/** 宽处：目录（前）→ 书页 → 要点浮层。 */
const WIDE_DIGEST = reader('wide', WIDE, H_TALL, `  <aside class="npr-companion npr-book-digest" id="wide-panel">
      ${PANEL_BODY}
    </aside>
      ${STAGE.replace('STAGEID', 'wide-stage')}
      ${CARD.replace('CARDID', 'wide-card')}`);
/** 宽处：书页 → 伴读（后）。 */
const WIDE_COMPANION = reader('comp', WIDE, H_TALL, `  ${STAGE.replace('STAGEID', 'comp-stage')}
      <aside class="npr-companion npr-book-companion" id="comp-companion">
      ${COMPANION_BODY}
    </aside>`);
/** 窄处：目录（前）→ 书页 → 浮层。`@container (max-width: 820px)` 生效。 */
const NARROW_DIGEST = reader('narrow', NARROW, H_TALL, `  <aside class="npr-companion npr-book-digest" id="narrow-panel">
      ${PANEL_BODY}
    </aside>
      ${STAGE.replace('STAGEID', 'narrow-stage')}
      ${CARD.replace('CARDID', 'narrow-card')}`);
/**
 * 宽处、但导出块**展开**着。
 *
 * ★ 为什么要单独一块夹具：`<details>` 收起时内容根本不参与布局，所以折叠态的
 *   量测证明不了「展开后会不会溢出」。展开是用户会真的点开的状态，而它一旦
 *   比面板高，表现是导出按钮被裁在面板外面 —— 点不到，也没有滚动条（面板本身
 *   不滚，滚的是里面的章节列表）。
 */
const EXPANDED = reader('open', WIDE, H_TALL, `  <aside class="npr-companion npr-book-digest" id="open-panel">
      ${panelBody({ open: true })}
    </aside>
      ${STAGE.replace('STAGEID', 'open-stage')}`);
/**
 * 反向对照 ④（0.20.1）：把 0.20.1 的三条视觉改动整体回退成 0.20.0 的形态
 * —— 副标题隐藏、展开指示器隐藏、主按钮退回「透明底 + 描边」的幽灵按钮。
 * 判据 ⑱⑲ 必须变红。
 *
 * ★★ 它必须是**折叠态**：0.20.1 的真实 CSS 里有「展开后收起副标题」这条
 *    （量出来的，见 refinements.css 里那段注释）。夹具一旦也是展开的，
 *    那条真规则就会顺带把副标题藏掉 ⇒ ⑱ 的反向对照**不靠覆盖也成立**，
 *    于是它什么也没证明。折叠态下副标题该在，只有覆盖能让它消失。
 *
 * ★★ 为什么必须单独一块夹具，而不是像最初那样把覆盖挂在 `#open-panel` 上：
 *    `#open-panel` 是判据 ⑯⑰ 量**真实展开态**的地方，而隐藏副标题会让那块
 *    **矮 28px**（副标题在 306px 栏里折成两行）⇒ ⑯ 从此量的是一个**比现实更宽松**
 *    的样本。实测代价：真实展开态 177.6px、底边 1057.2 **超出面板底 1032.0**，
 *    而挂着覆盖时量到 148.3px「正好在面板内」——**一条假绿，25px 的溢出被藏了整整一轮**。
 *    教训写成一句话：**反向对照要挂在一块只服务它自己的夹具上。**
 */
const GHOST = reader('ghost', WIDE, H_TALL, `  <aside class="npr-companion npr-book-digest" id="ghost-panel">
      ${panelBody()}
    </aside>
      ${STAGE.replace('STAGEID', 'ghost-stage')}`);
/**
 * 反向对照 ⑤（0.24.0）：导出成功那一行里**复制按钮被文字挤出去**。
 *
 * ★ 为什么必须是**展开态**：折叠时 `.npr-skill-body` 是 `display:none`，复制按钮的
 *   rect 全是 0 —— 量到的「没溢出」是因为它根本不存在，判据 ⑳ 会变成空话。
 * ★ 为什么单独一块夹具：`#open-panel` 是 ⑯⑰ 量真实展开态的地方。把
 *   `.npr-skill-last-text{flex:0 0 auto}` 挂上去，长路径会把复制按钮挤到面板外，
 *   于是**整块变宽**、⑯ 量到的东西也变了（这正是 0.20.1 踩过的坑：
 *   反向对照挂错夹具，会把别人的样本改掉）。单独一块最省事。
 * ★ 覆盖只改一处：让文字那一格**不肯收缩**（`flex` 与 `min-width` 同时退回默认值）。
 *   真实世界里这条错误的来源就是「忘了写 `min-width: 0`」——flex 子项的
 *   `min-width:auto` 不允许它缩到内容宽度以下，于是长路径把按钮顶出容器。
 */
const SQUEEZE = reader('squeeze', WIDE, H_TALL, `  <aside class="npr-companion npr-book-digest" id="squeeze-panel">
      ${panelBody({ open: true })}
    </aside>
      ${STAGE.replace('STAGEID', 'squeeze-stage')}`);
/**
 * 反向对照 ⑥（0.24.1）：那一排里**「生成解读」不肯收缩**，把 `book-to-skill` 顶出面板。
 *
 * ★ 用**最长**的按钮文案（`继续生成（120 章）`）而不是顺手那句：短文案挤不出去，
 *   对照就会假绿 —— 0.24.0 判据 ⑳ 的反向对照第一版正是这么翻车的（夹具里用了
 *   短 slug `book-labc`，按钮离面板右缘还有 90px）。
 * ★ 单独一块夹具：`#wide-panel` 是判据 ㉑ 量真实摆法的地方，把覆盖挂上去就等于
 *   把被量的样本改坏了。
 */
const ROW = reader('row', WIDE, H_TALL, `  <aside class="npr-companion npr-book-digest" id="row-panel">
      ${panelBody({ label: '继续生成（120 章 · 46.1 万字）' })}
    </aside>
      ${STAGE.replace('STAGEID', 'row-stage')}`);
/** 0.18.x 的摆法：书页 → 目录（**在右**）。判据 ①② 的反向对照。 */const OLD_DIGEST = reader('old', WIDE, 340, `  ${STAGE.replace('STAGEID', 'old-stage')}
      <aside class="npr-companion npr-book-digest" id="old-panel">
      ${PANEL_BODY}
    </aside>
      ${CARD.replace('CARDID', 'old-card')}`);
/** 0.19.0 的第一版：目录在左 + **伴读也在左**。判据 ⑤ 的反向对照。 */
const ALL_LEFT = reader('allleft', WIDE, 340, `  <aside class="npr-companion npr-book-digest" id="allleft-panel">
      ${PANEL_BODY}
    </aside>
      <aside class="npr-companion npr-book-companion" id="allleft-companion">
      ${COMPANION_BODY}
    </aside>
      ${STAGE.replace('STAGEID', 'allleft-stage')}`);

/**
 * 反向对照用的三条**真**覆盖（都只改一处，其余逐字相同）：
 *  · `#old-main{position:static}` —— 让浮层的定位基准退回 `.npr-reader`（它本来就
 *    有 `position:relative`）。这正是「`position: relative` 挂在 `.npr-book-main` 上」
 *    那条注释在防的错。
 *  · `#old-card{top:4px}` —— 0.20.6 起浮层的 `top` 是 56px（给浮动工具栏让位）。
 *    只拆定位基准的话，56 仍然落在工具栏下方 8px，「压住工具栏」这件事根本没发生，
 *    判据 ⑧ 就成了空话。把浮层顶到 4px 才是真正会压住工具栏的形态（用户拖窗口、
 *    或者面板很矮的时候就会看到）。
 *  · 旧摆法 / 第一版摆法本身由 DOM 顺序决定，不需要额外 CSS。
 */
const OVERRIDES = `
#old-main { position: static; }
#old-card { top: 4px; }
/* 反向对照 ③：把导出块用 order 提到列表**前面**（一个真的坏摆法 —— 用户滚到
   底部才找得到「导出」，结果它跑到了最上面）。判据 ⑫ 必须能抓到它。 */
#old-panel { display: flex; flex-direction: column; }
#old-panel .npr-skill { order: -1; }
/*
 * 反向对照 ④（0.20.1）：把 0.20.1 的三条视觉改动整体回退成 0.20.0 的形态 ——
 * 副标题隐藏、展开指示器隐藏、主按钮退回「透明底 + 描边」的幽灵按钮。
 * 判据 ⑱⑲ 必须变红。
 *
 * ★★ 挂在**专属**的 #ghost-panel 上，不挂 #open-panel：后者是 ⑯⑰ 量真实展开态
 *   的地方，隐藏副标题会让它矮 14px ⇒ ⑯ 从此量一个比现实更宽松的样本。
 *   （最初版本就挂在 open 上，理由是「open 只被 ⑯⑰ 用，都是越小越容易过」——
 *   那句推理错在：把样本缩小，确实不会让判据**变红**，但也让判据**量错了东西**。）
 * 也不挂 #old-panel：那是 ⑬ 的反向对照，隐藏副标题会让它长高、可能把 ⑬ 变绿。
 *
 * ★ 这段注释在**模板串内部**：一个反引号都不能有（本文件为此栽过五次）。
 */
#ghost-panel .npr-skill-sub, #ghost-panel .npr-skill-chev { display: none; }
#ghost-panel .npr-skill-go { background: transparent; color: var(--npr-accent-strong); border-color: var(--npr-accent-strong); }
/*
 * 反向对照 ⑤（0.24.0）：文字那一格退回 flex 的默认值（可长不可缩）。
 * 判据 ⑳ 必须变红 —— 它守的是「复制按钮整颗在面板内，且不压住路径文字」。
 * ★ 只改这一条：真实代码里的错法就是漏了 min-width: 0。
 */
#squeeze-panel .npr-skill-last-text { flex: 0 0 auto; min-width: auto; }
/*
 * 反向对照 ⑥（0.24.1）：「生成解读」退回 flex 的默认值（可长不可缩）。
 * 判据 ㉑ 必须变红 —— 它守的是「两颗按钮都在面板内、不重叠、同一排」。
 * ★ 只改这一条：真实代码里的错法就是漏了 min-width: 0 / 写成 flex: 0 0 auto。
 */
#row-panel .npr-digest-actions .npr-digest-start { flex: 0 0 auto; min-width: auto; }
/*
 * 反向对照 ⑦（0.24.1）：把 :disabled 的灰化盖掉 —— 按钮仍然点不动，但**看着能点**。
 * 判据 ㉒ 必须变红。真实世界里这条错法的来源是「加了 disabled 属性、忘了写样式」，
 * 或者后来一条更特异的规则把它覆盖了。
 */
#broken-off { opacity: 1; cursor: pointer; }`;

const LABEL_CSS = `
body { margin: 0; font: 12px -apple-system, "Helvetica Neue", sans-serif; color: #0f1115; background: #e9eaec; }
.page { display: flex; flex-direction: column; gap: 14px; padding: 20px; align-items: flex-start; }
.item > h1 { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
.legend { margin: 4px 0 0; font-size: 11px; color: #61666b; }
.item { background: #e9eaec; }`;

/**
 * 判据 ㉒ 的夹具：同一颗按钮的**可点**与**不可点**两个实例，并排摆着比。
 * ★ 只加 `disabled` 属性是不够的（本项目记过：缺 `:disabled` 样式 ⇒ 看着能点、
 *   点了没反应）。这里量的就是「两态**看得出**区别」。
 * ★ 摆两组：上面一组用**真实 CSS**（判据 ㉒ 量它），下面一组被 OVERRIDES 把
 *   `:disabled` 那条盖掉（反向对照 ⑦ 量它）。两组必须分开 —— 同一组既当真样本
 *   又当坏样本，等于没有对照。
 */
const SKILL_STATE = `<div class="npr-digest-actions" style="width:306px" id="state-probe">
  <button type="button" class="npr-digest-skill" id="skill-on"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"></path></svg><span>book-to-skill</span></button>
  <button type="button" class="npr-digest-skill" id="skill-off" disabled><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"></path></svg><span>book-to-skill</span></button>
</div>
<div class="npr-digest-actions" style="width:306px;margin-top:8px" id="state-broken">
  <button type="button" class="npr-digest-skill" id="broken-on"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"></path></svg><span>book-to-skill</span></button>
  <button type="button" class="npr-digest-skill" id="broken-off" disabled><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"></path></svg><span>book-to-skill</span></button>
</div>`;

const PAGE = `<!doctype html><meta charset="utf-8">
<style id="host">${HOST}</style>
<style id="panel">${PANEL_CSS}</style>
<style id="refinements">${REFINEMENTS}</style>
<style id="overrides">${OVERRIDES}</style>
<style id="label">${LABEL_CSS}</style>
<div class="page">
  <div class="item"><h1>宽处（容器 1200px）· 目录在左</h1>${WIDE_DIGEST}
    <p class="legend" id="legend-wide">—</p></div>
  <div class="item"><h1>宽处 · 导出块展开（默认是折叠的）</h1>${EXPANDED}
    <p class="legend" id="legend-open">—</p></div>
  <div class="item"><h1>宽处 · 伴读在右</h1>${WIDE_COMPANION}
    <p class="legend" id="legend-comp">—</p></div>
  <div class="item"><h1>窄处（容器 780px）· 书页在上、目录在下</h1>${NARROW_DIGEST}
    <p class="legend" id="legend-narrow">—</p></div>
  <div class="item"><h1>反向对照 ①：0.18.x 的摆法（目录在右）</h1>${OLD_DIGEST}
    <p class="legend" id="legend-old">—</p></div>
  <div class="item"><h1>反向对照 ②：0.19.0 第一版（伴读也挪到了左边）</h1>${ALL_LEFT}
    <p class="legend" id="legend-allleft">—</p></div>
  <div class="item"><h1>反向对照 ④（0.20.1）：0.20.0 的视觉（副标题/指示器隐藏 + 幽灵按钮）</h1>${GHOST}
    <p class="legend" id="legend-ghost">—</p></div>
  <div class="item"><h1>反向对照 ⑤（0.24.0）：路径文字不肯收缩，复制按钮被挤出面板</h1>${SQUEEZE}
    <p class="legend" id="legend-squeeze">—</p></div>
  <div class="item"><h1>反向对照 ⑥（0.24.1）：生成解读不肯收缩，book-to-skill 被顶出面板</h1>${ROW}
    <p class="legend" id="legend-row">—</p></div>
  <div class="item"><h1>判据 ㉒：book-to-skill 的可点 / 不可点两态</h1>${SKILL_STATE}
    <p class="legend" id="legend-state">—</p></div>
</div>`;

// ---- 3. 探针：在真 Chrome 里量像素 ----------------------------------------
const PROBE = `
const rect = (sel) => {
  const el = document.querySelector(sel);
  if (el === null) return null;
  const b = el.getBoundingClientRect();
  return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
};
/**
 * ★ 分隔线方向只能量 **computed border-*-width**，不能读源码里写了 border-left
 *   还是 border-right：「border: 1px solid」简写、「border-inline-start」、逻辑属性、
 *   以及后来的覆盖规则，任何一种都能让源码与画出来的线不一致。
 */
const edges = (sel) => {
  const el = document.querySelector(sel);
  if (el === null) return null;
  const c = getComputedStyle(el);
  return {
    left: c.borderLeftWidth, right: c.borderRightWidth,
    top: c.borderTopWidth, bottom: c.borderBottomWidth,
    position: c.position, order: c.order, flex: c.flex,
    minHeight: c.minHeight, height: c.height, width: c.width,
  };
};
/**
 * 一个元素「看起来像什么」：底色 / 文字色 / transform。
 * ★ 主按钮是不是实心，只能量 computed backgroundColor —— 源码里写 background: var(--x)
 *   不代表那个变量解得出值（本项目记过「未定义的 var() = 毒化成空值」）。
 */
const look = (sel) => {
  const el = document.querySelector(sel);
  if (el === null) return null;
  const c = getComputedStyle(el);
  return { background: c.backgroundColor, color: c.color, transform: c.transform };
};
/**
 * 一段文字有没有被「text-overflow: ellipsis」截掉。
 * ★ 只能量 scrollWidth 与 clientWidth 的差：CSS 里写了 text-overflow 不代表真的截了，
 *   反过来截了也不会报错 —— 界面上只是少了几个字（本项目记过「有按钮 ≠ 点得到」）。
 */
const fit = (sel) => {
  const el = document.querySelector(sel);
  if (el === null) return null;
  return {
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    truncated: el.scrollWidth > el.clientWidth + 1,
  };
};
/** 一颗按钮「看上去能不能点」：opacity / cursor / 字色。只认 computed，不认源码。 */
const styleOf = (sel) => {
  const el = document.querySelector(sel);
  if (el === null) return null;
  const c = getComputedStyle(el);
  return { opacity: c.opacity, cursor: c.cursor, color: c.color };
};
const out = {
  viewport: { width: window.innerWidth, height: window.innerHeight },
  /** 整页高度：判据 ㉓ 用它保证「对照图没把夹具裁掉」。 */
  bodyHeight: document.body.scrollHeight,
  wide: {
    main: rect('#wide-main'), panel: rect('#wide-panel'), stage: rect('#wide-stage'),
    toolbar: rect('#wide-toolbar'), meta: rect('#wide-meta'), card: rect('#wide-card'),
    panelCss: edges('#wide-panel'), cardCss: edges('#wide-card'),
    // 导出块（0.20.0）：它挂在目录列表**之后**，必须确认它没有把列表挤没。
    skill: rect('#wide-panel .npr-skill'),
    skillList: rect('#wide-panel .npr-digest-list'),
    skillGo: rect('#wide-panel .npr-skill-go'),
    skillRow: rect('#wide-panel .npr-skill-row'),
    skillCss: edges('#wide-panel .npr-skill'),
    // 0.20.1 的「看不看得懂 / 看不看得出要点哪」三条（判据 ⑱⑲）。
    skillSub: rect('#wide-panel .npr-skill-sub'),
    skillChev: rect('#wide-panel .npr-skill-chev'),
    skillGoLook: look('#wide-panel .npr-skill-go'),
    // 0.24.1：「生成解读」+「book-to-skill」同一排（判据 ㉑）。
    digestActions: rect('#wide-panel .npr-digest-actions'),
    digestStart: rect('#wide-panel .npr-digest-start'),
    digestSkill: rect('#wide-panel .npr-digest-skill'),
    digestStartFit: fit('#wide-panel .npr-digest-start > span'),
  },
  comp: {
    main: rect('#comp-main'), stage: rect('#comp-stage'), companion: rect('#comp-companion'),
    toolbar: rect('#comp-toolbar'), companionCss: edges('#comp-companion'),
  },
  narrow: {
    main: rect('#narrow-main'), panel: rect('#narrow-panel'), stage: rect('#narrow-stage'),
    panelCss: edges('#narrow-panel'), stageCss: edges('#narrow-stage'),
    /** ★ 0.24.3：order 该落在**这一层**（舞台的直接父节点）上，不在舞台上。 */
    viewCss: edges('#narrow-main > .npr-book-view'),
    // 窄处面板变成整行宽：导出块里的下拉/按钮不能因此拉成两米长，也不能溢出。
    skill: rect('#narrow-panel .npr-skill'),
    skillGo: rect('#narrow-panel .npr-skill-go'),
    skillList: rect('#narrow-panel .npr-digest-list'),
  },
  open: {
    main: rect('#open-main'), panel: rect('#open-panel'), stage: rect('#open-stage'),
    skill: rect('#open-panel .npr-skill'),
    skillGo: rect('#open-panel .npr-skill-go'),
    skillList: rect('#open-panel .npr-digest-list'),
    // 0.24.0 的两项：复制按钮 + 它左边那格文字。⑳ 判的是「按钮整颗在面板内、
    // 且不压住文字」—— 两个 rect 必须都从**真实展开态**取。
    skillCopy: rect('#open-panel .npr-skill-copy'),
    skillLastText: rect('#open-panel .npr-skill-last-text'),
  },
  /**
   * 反向对照 ⑤ 专用：同一段真 DOM，只被 OVERRIDES 里那条「flex: 0 0 auto」改掉。
   * ★ 只能从这里取 —— 从「open」里取等于让 ⑯⑰ 量一个被覆盖过的面板。
   */
  squeeze: {
    panel: rect('#squeeze-panel'),
    skillCopy: rect('#squeeze-panel .npr-skill-copy'),
    skillLastText: rect('#squeeze-panel .npr-skill-last-text'),
  },
  /**
   * 反向对照 ⑥ 专用：同一排两颗按钮，只被 OVERRIDES 里那条「不肯收缩」改掉。
   * ★ 文案用的是最长的那种（继续生成（120 章））—— 短文案挤不出去，对照会假绿。
   */
  row: {
    panel: rect('#row-panel'),
    digestActions: rect('#row-panel .npr-digest-actions'),
    digestStart: rect('#row-panel .npr-digest-start'),
    digestSkill: rect('#row-panel .npr-digest-skill'),
  },
  /**
   * 判据 ㉒ 专用：同一颗按钮的可点 / 不可点两态。
   * ★ 两态都从 computed style 取 —— 源码里写了 :disabled{opacity:.5} 不代表
   *   它真的生效（后面一条更特异的规则就能盖掉它）。
   */
  skillState: {
    on: styleOf('#skill-on'),
    off: styleOf('#skill-off'),
  },
  /** 反向对照 ⑦ 专用：被 OVERRIDES 盖掉灰化之后的那一组。 */
  skillBroken: {
    on: styleOf('#broken-on'),
    off: styleOf('#broken-off'),
  },
  /**
   * 反向对照 ④ 专用：同一段真 DOM，只被 OVERRIDES 里那几条 CSS 回退成 0.20.0 的视觉。
   * ★ 这三项**只能**从这里取，绝不能顺手从 open 里取 —— 那等于让 ⑯⑰ 量一个
   *   被覆盖过的面板（见 GHOST 上方的注释）。
   */
  ghost: {
    skillSub: rect('#ghost-panel .npr-skill-sub'),
    skillChev: rect('#ghost-panel .npr-skill-chev'),
    skillGoLook: look('#ghost-panel .npr-skill-go'),
  },
  old: {
    main: rect('#old-main'), panel: rect('#old-panel'), stage: rect('#old-stage'),
    toolbar: rect('#old-toolbar'), card: rect('#old-card'), mainCss: edges('#old-main'),
    // ⑫⑬ 的反向对照要靠这两块：「order:-1」把它提到列表前面、340 的高度把它挤没。
    skill: rect('#old-panel .npr-skill'),
    skillList: rect('#old-panel .npr-digest-list'),
  },
  allleft: {
    main: rect('#allleft-main'), stage: rect('#allleft-stage'),
    companion: rect('#allleft-companion'), panel: rect('#allleft-panel'),
  },
};
/**
 * ★ 把量到的数字写进图里的说明行，让对照图**自证**（数字在图上），而不是靠报告
 *   里口述。pre 是 --dump-dom 的取数通道，所以用 position:fixed + visibility
 *   挪出画面而不是删掉。
 * ★ 这段注释在**模板串内部**，所以一个反引号都不能有：反引号会提前闭合模板串，
 *   而闭合之后剩下的**有时语法合法**（本项目吃过一次「用例全绿、App 起不来」）。
 *   要引名字就用「」。
 */
const fmt = (n) => Math.round(n);
document.getElementById('legend-wide').textContent =
  '目录 ' + fmt(out.wide.panel.left) + '→' + fmt(out.wide.panel.right)
  + ' · 书页 ' + fmt(out.wide.stage.left) + '→' + fmt(out.wide.stage.right)
  + ' · 目录线 ' + out.wide.panelCss.right + '（右）/ ' + out.wide.panelCss.left + '（左）'
  + ' · 浮层 top=' + fmt(out.wide.card.top) + ' 工具栏底=' + fmt(out.wide.toolbar.bottom);
document.getElementById('legend-comp').textContent =
  '书页 ' + fmt(out.comp.stage.left) + '→' + fmt(out.comp.stage.right)
  + ' · 伴读 ' + fmt(out.comp.companion.left) + '→' + fmt(out.comp.companion.right)
  + ' · 伴读线 ' + out.comp.companionCss.left + '（左）/ ' + out.comp.companionCss.right + '（右）';
document.getElementById('legend-narrow').textContent =
  '书页 top=' + fmt(out.narrow.stage.top) + ' · 目录 top=' + fmt(out.narrow.panel.top)
  + ' · 目录宽 ' + fmt(out.narrow.panel.width) + ' / 阅读区宽 ' + fmt(out.narrow.main.width)
  + ' · order 书页=' + out.narrow.stageCss.order + ' 目录=' + out.narrow.panelCss.order;
document.getElementById('legend-open').textContent =
  '导出块展开后 高 ' + fmt(out.open.skill.height)
  + ' · 底 ' + fmt(out.open.skill.bottom) + ' 面板底 ' + fmt(out.open.panel.bottom)
  + ' · 列表剩 ' + fmt(out.open.skillList.height)
  + ' · 复制钮 right=' + fmt(out.open.skillCopy.right) + '（面板 right=' + fmt(out.open.panel.right) + '）';
document.getElementById('legend-old').textContent =  '书页 ' + fmt(out.old.stage.left) + '→' + fmt(out.old.stage.right)
  + ' · 目录 ' + fmt(out.old.panel.left) + '→' + fmt(out.old.panel.right) + '（在右，旧摆法）'
  + ' · 浮层 top=' + fmt(out.old.card.top) + ' 工具栏底=' + fmt(out.old.toolbar.bottom)
  + '（基准挂错 ⇒ 压在工具栏上）';
document.getElementById('legend-allleft').textContent =
  '目录 ' + fmt(out.allleft.panel.left) + '→' + fmt(out.allleft.panel.right)
  + ' · 书页 ' + fmt(out.allleft.stage.left) + '→' + fmt(out.allleft.stage.right)
  + ' · 伴读 ' + fmt(out.allleft.companion.left) + '→' + fmt(out.allleft.companion.right)
  + '（也跑到左边了）';
document.getElementById('legend-ghost').textContent =
  '0.20.0 的样子：副标题 ' + (out.ghost.skillSub === null ? 'null' : fmt(out.ghost.skillSub.height))
  + ' · 展开指示器 ' + (out.ghost.skillChev === null ? 'null' : fmt(out.ghost.skillChev.height))
  + ' · 按钮底色 ' + (out.ghost.skillGoLook === null ? 'null' : out.ghost.skillGoLook.background);
document.getElementById('legend-squeeze').textContent =
  '文字格 flex=' + (out.squeeze.skillLastText === null ? 'null' : fmt(out.squeeze.skillLastText.width))
  + ' 宽 · 复制钮 ' + (out.squeeze.skillCopy === null ? 'null' : fmt(out.squeeze.skillCopy.left) + '→' + fmt(out.squeeze.skillCopy.right))
  + ' · 面板 right=' + fmt(out.squeeze.panel.right) + '（按钮被挤出去了）';
document.getElementById('legend-row').textContent =
  '生成解读 ' + (out.row.digestStart === null ? 'null' : fmt(out.row.digestStart.width))
  + ' 宽 · book-to-skill ' + (out.row.digestSkill === null ? 'null' : fmt(out.row.digestSkill.left) + '→' + fmt(out.row.digestSkill.right))
  + ' · 面板 right=' + fmt(out.row.panel.right) + '（右边那颗被顶出去了）';
document.getElementById('legend-state').textContent =
  '可点 opacity=' + (out.skillState.on === null ? 'null' : out.skillState.on.opacity)
  + ' · 不可点 opacity=' + (out.skillState.off === null ? 'null' : out.skillState.off.opacity)
  + ' / cursor=' + (out.skillState.off === null ? 'null' : out.skillState.off.cursor);
const pre = document.createElement('pre');
pre.id = 'probe-out';
pre.style.cssText = 'position:fixed;left:0;top:0;margin:0;visibility:hidden';
pre.textContent = JSON.stringify(out);
document.body.appendChild(pre);
`;

/**
 * ★ 防「模板串被反引号提前闭合」——**每一个装着 CSS / HTML 的模板串都要点名一个
 *   靠近尾部的哨兵**：提前闭合必然把它丢掉。本项目为此栽过四次，其中一次闭合后
 *   的残骸**语法合法**（用例全绿、App 起不来）。
 */
const TEMPLATE_SENTINELS = [
  ['PANEL_BODY', PANEL_BODY, '第 3 章 · 莓泉'],
  ['COMPANION_BODY', COMPANION_BODY, 'npr-book-companion-chat'],
  ['CARD', CARD, 'npr-digest-model-tag'],
  ['STAGE', STAGE, 'width="900" height="1200"'],
  ['WIDE_DIGEST', WIDE_DIGEST, 'id="wide-card"'],
  ['WIDE_COMPANION', WIDE_COMPANION, 'id="comp-companion"'],
  ['NARROW_DIGEST', NARROW_DIGEST, 'id="narrow-card"'],
  ['EXPANDED', EXPANDED, 'id="open-stage"'],
  ['GHOST', GHOST, 'id="ghost-stage"'],
  ['SQUEEZE', SQUEEZE, 'id="squeeze-stage"'],
  ['ROW', ROW, 'id="row-stage"'],
  ['SKILL_STATE', SKILL_STATE, 'id="broken-off"'],
  ['OLD_DIGEST', OLD_DIGEST, 'id="old-card"'],
  ['ALL_LEFT', ALL_LEFT, 'id="allleft-stage"'],
  ['OVERRIDES', OVERRIDES, '#old-main { position: static; }'],
  ['LABEL_CSS', LABEL_CSS, '.item { background: #e9eaec; }'],
  ['REFINEMENTS', REFINEMENTS, '.npr-digest-card { position: absolute;'],
  ['PROBE', PROBE, "appendChild(pre)"],
];
for (const [name, text, sentinel] of TEMPLATE_SENTINELS) {
  if (!text.includes(sentinel)) {
    throw new Error(`${name} 里找不到尾部哨兵「${sentinel}」—— 模板串多半被反引号提前闭合了`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'npr-book-panel-'));
/**
 * ★ 量测与截图用**同一份 HTML**。两份一旦分叉，图就不是「被量的那一张」。
 */
const html = `${PAGE}\n<script>\n${PROBE}\n<\/script>\n`;

/** 拼好的脚本再做两道核对：能编译 + 关键哨兵都在（残骸可能语法合法）。 */
const scriptOpen = '<script>';
const scriptBody = html.slice(html.lastIndexOf(scriptOpen) + scriptOpen.length, html.lastIndexOf('</script>'));
try {
  new Function(scriptBody);
} catch (err) {
  throw new Error(`注入的探针脚本编译不过：${err.message}`);
}
for (const sentinel of ["pre.id = 'probe-out'", 'JSON.stringify(out)', 'appendChild(pre)']) {
  if (!scriptBody.includes(sentinel)) {
    throw new Error(`探针脚本里找不到「${sentinel}」—— 模板串多半被反引号提前闭合了`);
  }
}

const htmlPath = join(dir, 'page.html');
writeFileSync(htmlPath, html, 'utf8');

function run(args) {
  const res = spawnSync(CHROME, ['--no-sandbox', '--disable-gpu', '--headless', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`chrome 启动失败：${res.error.message}`);
  return res.stdout;
}

/**
 * ★ 视口尺寸同时决定「量测的宽度」与「出图的宽度」，两次运行必须给同一组参数
 *   （含 `--hide-scrollbars`：少了它，两次的可用宽度会差一条滚动条）。
 * ★ 宽度 1240 = 1200（最宽的那块夹具）+ 左右各 20px 内边距，不多不少 ——
 *   窄了 `.page` 的 flex 会把 `.npr-root` 压扁（`flex-shrink` 默认 1），
 *   于是 `@container` 量到的就不是 1200，所有几何判据都失去意义。
 * ★ 高度是**算出来的**：八块夹具 470×6 + 340×2 = 3500，
 *   加八条标题/说明（各约 20 + 15）与七条 14px 间隙、上下各 20 内边距
 *   ⇒ 3500 + 280 + 98 + 40 ≈ 3918，取 3980 留一点余量。
 *   ★ 加了夹具就必须同步改这里，否则最后一块会被视口裁掉 —— 而裁掉之后
 *     探针量到的 rect 仍然是真值（元素在文档里），只有出图会少一块。
 */
const VIEWPORT = { width: 1240, height: 4600 };
const VIEWPORT_ARGS = ['--hide-scrollbars', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`];

const dom = run(['--virtual-time-budget=2000', ...VIEWPORT_ARGS, '--dump-dom', `file://${htmlPath}`]);
const matched = /<pre id="probe-out"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
if (!matched) throw new Error(`没拿到探针结果（脚本抛了？）\n${dom.slice(-1500)}`);
const decoded = matched[1]
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
const out = JSON.parse(decoded);

// ---- 4. 判定 --------------------------------------------------------------
const failures = [];
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name} —— ${detail}`);
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `（${detail}）`}`);
};
/** 判据的原式：单独抽出来，反向对照才能喂**同一条式子**，而不是另写一句。 */
const digestIsLeft = (r) => r.panel.right <= r.stage.left + 0.6;
const companionIsRight = (r) => r.companion.left >= r.stage.right - 0.6;
const stageIsAbovePanel = (r) => r.stage.top < r.panel.top;
const panelFillsWidth = (r) => near(r.panel.width, r.main.width, 1);
const cardAvoidsToolbar = (r) => r.card.top >= r.toolbar.bottom - 0.6;
const cardLeavesPage = (r) => r.card.left > r.stage.left + 0.6;

console.log(`视口 ${out.viewport.width}×${out.viewport.height}（截图与量测用同一个宽度）`);
const dump = (label, obj, keys) => {
  console.log(`--- ${label} ---`);
  for (const key of keys) {
    const r = obj[key];
    if (r === null || r === undefined || !('top' in r)) continue;
    console.log(`  ${key.padEnd(10)} top=${r.top.toFixed(1)} bottom=${r.bottom.toFixed(1)} `
      + `left=${r.left.toFixed(1)} right=${r.right.toFixed(1)} w=${r.width.toFixed(1)} h=${r.height.toFixed(1)}`);
  }
};
const W = out.wide;
const C = out.comp;
const N = out.narrow;
const O = out.old;
const L = out.allleft;
const EXP = out.open;
const G = out.ghost;
const SQ = out.squeeze;
const RW = out.row;
const ST = out.skillState;
const SB = out.skillBroken;

dump('宽处 · 目录在左', W, ['main', 'panel', 'stage', 'toolbar', 'meta', 'card', 'skill', 'skillList', 'skillGo', 'digestStart', 'digestSkill']);
console.log(`  panelCss  ${JSON.stringify(W.panelCss)}`);
dump('宽处 · 导出块展开', EXP, ['main', 'panel', 'skill', 'skillGo', 'skillList', 'skillCopy', 'skillLastText']);
dump('反向对照 ⑤：文字格不肯收缩', SQ, ['panel', 'skillCopy', 'skillLastText']);
dump('反向对照 ⑥：生成解读不肯收缩（最长文案）', RW, ['panel', 'digestStart', 'digestSkill']);
dump('宽处 · 伴读在右', C, ['main', 'stage', 'companion']);
console.log(`  companionCss ${JSON.stringify(C.companionCss)}`);
dump('窄处 · 书页在上、目录在下', N, ['main', 'stage', 'panel']);
console.log(`  panelCss  ${JSON.stringify(N.panelCss)} · stageCss ${JSON.stringify(N.stageCss)}`);
dump('反向对照 ①：0.18.x（目录在右）', O, ['main', 'stage', 'panel', 'toolbar', 'card']);
dump('反向对照 ②：0.19.0 第一版（伴读也在左）', L, ['main', 'panel', 'companion', 'stage']);
console.log('--- 判据：目录在左、伴读在右 ---');

/**
 * ★ 判据 ①②③ 是一组，缺一条就会被绕过：
 *   只钉 ①（面板在书页左边）时，把**整个 `.npr-book-main` 的内容右移**（比如给
 *   `.npr-book` 加 `padding-left: 306px`）照样全绿 —— 面板与书页的相对关系没变，
 *   但它们一起离开了阅读区的左缘。
 */
check('① ★ 宽处：目录整块在书页**左边**（panel.right ≤ stage.left）',
  digestIsLeft(W),
  `目录 right=${W.panel.right.toFixed(1)} vs 书页 left=${W.stage.left.toFixed(1)}（跑到右边去了）`);
check('② 宽处：目录贴阅读区**左缘**（不是被整体右移）',
  near(W.panel.left, W.main.left),
  `目录 left=${W.panel.left.toFixed(1)} vs 阅读区 left=${W.main.left.toFixed(1)}`);
check('③ 宽处：书页区一直延伸到阅读区**右缘**（面板没把正文挤成一条）',
  near(W.stage.right, W.main.right),
  `书页 right=${W.stage.right.toFixed(1)} vs 阅读区 right=${W.main.right.toFixed(1)}`);
/**
 * ★ 分隔线方向量的是 computed **border-*-width**：面板在左时线该贴它的**右缘**。
 *   源码里写 `border-right` 而画出来在左边，只可能来自覆盖规则或逻辑属性 ——
 *   那种错源码断言完全看不见。
 */
check('④ ★ 宽处：目录的分隔线在**右缘**（贴着书页那一侧）',
  W.panelCss.right === '1px' && W.panelCss.left === '0px',
  `border-right=${W.panelCss.right} border-left=${W.panelCss.left}（期望 1px / 0px）`);
check('⑤ ★ 宽处：伴读整块在书页**右边**（stage.right ≤ companion.left）',
  companionIsRight(C),
  `伴读 left=${C.companion.left.toFixed(1)} vs 书页 right=${C.stage.right.toFixed(1)}`
  + '（用户原话：目录在左，伴读在右啊）');
check('⑥ 宽处：伴读贴阅读区**右缘**',
  near(C.companion.right, C.main.right),
  `伴读 right=${C.companion.right.toFixed(1)} vs 阅读区 right=${C.main.right.toFixed(1)}`);
check('⑦ ★ 宽处：伴读的分隔线在**左缘**（与目录相反，各自贴朝内那一侧）',
  C.companionCss.left === '1px' && C.companionCss.right === '0px',
  `border-left=${C.companionCss.left} border-right=${C.companionCss.right}（期望 1px / 0px）`);
/**
 * ★ 判据 ⑧ 守的是「浮层挂在 `.npr-book-main` 上」那条注释：基准若退回
 *   `.npr-reader`（它本来就有 `position:relative`），`top:10px` 会把浮层压到工具栏上。
 *   两条一起钉：不压工具栏 + 没有盖满整页（左边还留得下正文）。
 */
check('⑧ ★ 宽处：要点浮层不压工具栏，也没盖满整页',
  cardAvoidsToolbar(W) && cardLeavesPage(W),
  `浮层 top=${W.card.top.toFixed(1)} 工具栏底=${W.toolbar.bottom.toFixed(1)}`
  + ` · 浮层 left=${W.card.left.toFixed(1)} 书页 left=${W.stage.left.toFixed(1)}`);
check('⑨ ★ 窄处：书页在**上**、目录在下（stage.top < panel.top）',
  stageIsAbovePanel(N),
  `书页 top=${N.stage.top.toFixed(1)} 目录 top=${N.panel.top.toFixed(1)}（目录被顶到上面了）`);
/**
 * ★ ⑨-a / ⑨-b（0.24.3）：`order` 必须落在 `.npr-book-view` 上，**不在舞台上**。
 *   只钉几何是不够的：目录面板自己有 `order: 2`，所以哪怕舞台的 `order: 1` 整条丢了、
 *   甚至写回到舞台（那时它已经不是 `.npr-book-main` 的直接子节点），竖排顺序**照样**对
 *   —— 判据 ⑨ 会一路绿到底。这两条读的是 computed `order`（渲染结果，不是源码字符串），
 *   一正一反：正确的层是 1，舞台自己是 0。
 */
check('⑨-a ★ 窄处：`order: 1` 落在 `.npr-book-view` 上（computed，不是抄源码）',
  N.viewCss !== null && N.viewCss.order === '1',
  `view 的 order=${N.viewCss === null ? '(没找到这一层)' : N.viewCss.order}（期望 1）`);
check('⑨-b ★ 窄处：舞台上**没有** order（规则写回这一层就等于失效）',
  N.stageCss.order === '0',
  `stage 的 order=${N.stageCss.order}（期望 0）`);
check('⑩ ★ 窄处：目录撑满宽度，分隔线改到上边',
  panelFillsWidth(N) && N.panelCss.top === '1px' && N.panelCss.right === '0px',
  `目录宽=${N.panel.width.toFixed(1)} 阅读区宽=${N.main.width.toFixed(1)}`
  + ` · border-top=${N.panelCss.top} border-right=${N.panelCss.right}`);

/**
 * ★ 判据 ⑫⑬⑭ 守的是 0.20.0 新加的「导出成技能包」那一块。
 *   它挂在 `.npr-digest-list`（`flex: 1`）**之后**，所以有一个真实的风险：
 *   这一块本身有六行内容，面板矮的时候它会把列表压成 0 —— 表现是
 *   「目录里只剩标题，章节一条都看不见」，而代码里没有任何一处报错。
 */
const skillAfterList = (r) => r.skill.top >= r.skillList.bottom - 0.6;
const skillFitsPanel = (r) => r.skill.bottom <= r.panel.bottom + 0.6
  && r.skill.width <= r.panel.width + 0.6;
/** 列表至少要放得下 3 章（一行约 32px）—— 少于此就没法「一边看目录一边看要点」。 */
const ROWS_MIN = 3;
const ROW_H = 32;
const listUsable = (r) => r.skillList.height >= ROWS_MIN * ROW_H;

check('⑫ ★ 宽处：导出块在章节列表**之后**，且没被面板裁掉',
  skillAfterList(W) && skillFitsPanel(W),
  `导出块 top=${W.skill.top.toFixed(1)} 列表底=${W.skillList.bottom.toFixed(1)}`
  + ` · 导出块底=${W.skill.bottom.toFixed(1)} 面板底=${W.panel.bottom.toFixed(1)}`);
check(`⑬ ★ 宽处：导出块没把章节列表挤没（列表 ≥ ${ROWS_MIN} 行）`,
  listUsable(W),
  `列表高=${W.skillList.height.toFixed(1)} 导出块高=${W.skill.height.toFixed(1)}`
  + ` 面板高=${W.panel.height.toFixed(1)}（面板矮的时候这一块会吃掉列表）`);
check('⑭ ★ 宽处：导出块撑满面板宽度但没溢出（不自造固定宽）',
  W.skill.width >= W.panel.width - 4 && W.skill.width <= W.panel.width,
  `导出块宽=${W.skill.width.toFixed(1)} 面板宽=${W.panel.width.toFixed(1)}`);
check('⑮ ★ 窄处：导出块同样贴边不溢出，按钮仍在面板内',
  N.skill.width >= N.panel.width - 4 && N.skill.width <= N.panel.width
  && N.skillGo.right <= N.panel.right + 0.6,
  `导出块宽=${N.skill.width.toFixed(1)} 面板宽=${N.panel.width.toFixed(1)}`
  + ` · 按钮 right=${N.skillGo.right.toFixed(1)} 面板 right=${N.panel.right.toFixed(1)}`);
/**
 * ★ 判据 ⑯ 量的是**展开态**。`<details>` 收起时内容不参与布局，所以 ⑬ 证明不了
 *   展开之后会不会溢出 —— 而溢出后表现是「导出按钮被裁在面板外面，点不到，
 *   也没有滚动条」（面板本身不滚，滚的是里面的章节列表）。
 * ★ 实测（面板 401px，这是 470px 小窗口的极端值，真实窗口通常 700–900px）：
 *   · 折叠态：导出块 35px，列表 **129px ≈ 4 行**；
 *   · 展开态：导出块 143px，列表被压到 **21.6px**（不到一行）。
 *   展开时列表被压小是**有意的**：那一块是用户自己点开的，而面板里没有第二个
 *   能滚的地方；宁可让列表暂时变小，也不能让导出按钮被裁掉。
 *   ⑰ 只守「没有被压成 0」——真的变成 0 时，用户会以为目录里的章节没了。
 */
const skillInsidePanel = (r) => r.skill.bottom <= r.panel.bottom + 0.6
  && r.skillGo.bottom <= r.panel.bottom + 0.6;
check('⑯ ★ 展开态：整块（含导出按钮）仍在面板内，没有被裁到外面',
  skillInsidePanel(EXP),
  `导出块底=${EXP.skill.bottom.toFixed(1)} 按钮底=${EXP.skillGo.bottom.toFixed(1)}`
  + ` 面板底=${EXP.panel.bottom.toFixed(1)} 展开后高=${EXP.skill.height.toFixed(1)}`);
check('⑰ ★ 展开态：章节列表没有被压成 0（还能看到内容）',
  EXP.skillList.height > 0,
  `列表高=${EXP.skillList.height.toFixed(1)}（折叠态是 ${W.skillList.height.toFixed(1)}）`);

/**
 * 0.20.1：用户截图说「这个设计的太不明显了」。下面两条量的是**看得懂 / 看得出要点哪**，
 * 不是「颜色好不好看」—— 后者没法断言，前者可以：
 *   ⑱ 折叠态（**默认状态**）必须同时给出「点了会得到什么」与「这块可以展开」；
 *   ⑲ 主按钮必须是**实心**：306px 的栏里，一圈 1px 描边只是「一个框」，
 *      而它旁边的下拉框占满剩余宽度 ⇒ 视觉重量落在「选什么」上，不在「做什么」上。
 */
const subVisible = (r) => r.skillSub !== null && r.skillSub.height > 0 && r.skillSub.width > 0;
const chevPresent = (r) => r.skillChev !== null && r.skillChev.height > 0;
/**
 * `backgroundColor` 的 alpha。
 * ★ Chrome 对 `color-mix()` 会返回 `color(srgb …)`，对普通值是 `rgb()/rgba()` ——
 *   两种都要认，否则「透明」与「实心」会被读成同一个数（本项目记过：解析器只认 rgb( 时
 *   会跳过自己的底色一路读到页面底色，把对比度算成 1.00）。
 */
const alphaOf = (value) => {
  const text = String(value ?? '');
  if (text === '' || text === 'transparent') return 0;
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < 0) return 0;
  const parts = text.slice(open + 1, close).split(/[\s,/]+/).filter(Boolean);
  const nums = text.startsWith('color(') ? parts.slice(1) : parts;
  return nums.length >= 4 ? Number(nums[3]) : 1;
};
const solidFill = (r) => r.skillGoLook !== null && alphaOf(r.skillGoLook.background) > 0.5;
const shown = (r, key) => (r[key] === null ? 'null' : r[key].height.toFixed(1));

check('⑱ ★ 折叠态（默认状态）就说清了「点了会得到什么」，并且看得出可以展开',
  subVisible(W) && chevPresent(W),
  `副标题高=${shown(W, 'skillSub')} 展开指示器=${shown(W, 'skillChev')}`
  + '（副标题只放在展开体里 = 只讲给已经点开的人听）');
check('⑲ ★ 主按钮是实心填充，不是一圈描边',
  solidFill(W),
  `按钮底色=${W.skillGoLook === null ? 'null' : W.skillGoLook.background}`
  + ` 字色=${W.skillGoLook === null ? 'null' : W.skillGoLook.color}`);

/**
 * ★ 0.24.0 判据 ⑳：导出成功那一行里的**复制按钮**。
 *
 *   守的是一个很朴素的错法：`.npr-skill-last-text` 忘了写 `min-width: 0`。
 *   flex 子项的默认 `min-width: auto` 不肯缩到内容宽度以下 ⇒ 长路径把复制按钮
 *   **顶出容器**。在 306px 的栏里，顶出去不会报错、不会换行，只是按钮不见了 ——
 *   它仍在 DOM 里、仍能 Tab 到，用户却点不到。
 *   （同类教训本项目记过：有 `disabled` 属性 ≠ 用户看得出；这里换成「有按钮 ≠ 点得到」。）
 * ★ 两个条件缺一不可：
 *   ① `right ≤ 面板右缘` —— 整颗都在面板内，没被裁掉；
 *   ② `left ≥ 文字右缘` —— 没压在路径文字上（压上去会吃掉最后几个字符，
 *      而那正是用户要认的目录名）。
 * ★ 必须量**展开态**：折叠时 body 是 `display:none`，两个 rect 全是 0，
 *   「没溢出」只是因为它不存在。
 */
const copyReachable = (r) => r.skillCopy !== null
  && r.skillCopy.width > 0 && r.skillCopy.height > 0
  && r.skillCopy.right <= r.panel.right + 0.6
  && r.skillLastText !== null
  && r.skillCopy.left >= r.skillLastText.right - 0.6;
check('⑳ ★ 导出成功那一行的复制按钮整颗在面板内，且没压住路径文字',
  copyReachable(EXP),
  `复制钮 ${EXP.skillCopy === null ? 'null' : `${EXP.skillCopy.left.toFixed(1)}→${EXP.skillCopy.right.toFixed(1)}`}`
  + ` · 文字 right=${EXP.skillLastText === null ? 'null' : EXP.skillLastText.right.toFixed(1)}`
  + ` · 面板 right=${EXP.panel.right.toFixed(1)}`);

/**
 * ★ 0.24.1 判据 ㉑：「生成解读」右边那颗 `book-to-skill` 与它同一排、整颗在面板内。
 *
 *   守的错法与 ⑳ 同源，但换了一颗按钮：`.npr-digest-start` 是 flex 子项，
 *   默认 `min-width: auto` 不肯缩 —— 长文案（`继续生成（120 章）`）加上第二颗按钮，
 *   在 306px 的栏里就把右边那颗**顶出面板**。顶出去不报错、不换行，只是按钮不见了。
 * ★ 三个条件：
 *   ① `right ≤ 这一排自己的右缘` —— 整颗都在这一排里。**比面板右缘更严**：面板有
 *      14px 内边距，按钮越过内边距就已经压在留白上了（面板若带 overflow 直接被裁）。
 *      0.24.1 第一版拿面板右缘比，反向对照里按钮右缘 318.4 竟然「通过」了 326 —— 假绿。
 *   ② `left ≥ 左边那颗的右缘` —— 没压住「生成解读」（压上去会让两颗按钮糊成一块，
 *      用户分不清点的是哪个）；
 *   ③ 两条垂直中线差 ≤ 1.5px —— 真的**同一排**，不是被挤到下一行。
 *      （第 ③ 条防的是「不换行就溢出」被换成「换行就不溢出」—— 换行本身不是错，
 *      但它不是用户要的那个摆法。）
 * ★ 文案截断不判死：栏宽固定，长文案该让位给按钮。`fit` 的结果只写进消息里备查。
 */
const rowOk = (r) => r.digestStart !== null && r.digestSkill !== null && r.digestActions !== null
  && r.digestStart.width > 0 && r.digestSkill.width > 0
  && r.digestSkill.right <= r.digestActions.right + 0.6
  && r.digestSkill.left >= r.digestStart.right - 0.6
  && Math.abs((r.digestStart.top + r.digestStart.bottom) / 2
    - (r.digestSkill.top + r.digestSkill.bottom) / 2) <= 1.5;
const midY = (r) => (r === null ? 'null' : ((r.top + r.bottom) / 2).toFixed(1));
check('㉑ ★ book-to-skill 在「生成解读」右边、同一排、整颗在面板内',
  rowOk(W),
  `生成解读 ${W.digestStart === null ? 'null' : `${W.digestStart.left.toFixed(1)}→${W.digestStart.right.toFixed(1)}`}`
  + ` · book-to-skill ${W.digestSkill === null ? 'null' : `${W.digestSkill.left.toFixed(1)}→${W.digestSkill.right.toFixed(1)}`}`
  + ` · 这一排 right=${W.digestActions === null ? 'null' : W.digestActions.right.toFixed(1)}`
  + `（面板 right=${W.panel.right.toFixed(1)}）`
  + ` · 中线 ${midY(W.digestStart)}/${midY(W.digestSkill)}`
  + ` · 左边文案${W.digestStartFit === null ? 'null' : (W.digestStartFit.truncated ? '被截断' : '完整')}`);

/**
 * ★ 0.24.1 判据 ㉒：没有解读时那颗按钮**看上去**就不能点。
 *
 *   用户的原话里，「不能点击」是硬要求；但本项目已经踩过一次「只加 `disabled`
 *   属性、没写样式 ⇒ 按钮和能点时长得一模一样，用户点了没反应只会以为坏了」。
 *   所以判据不是「DOM 里有 disabled」，而是**两态的 computed style 有差别**：
 *   可点那态 opacity ≥ 0.95、不可点那态 ≤ 0.7 且 cursor 是 not-allowed。
 * ★ 阈值 0.7 而不是 0.5：真实值写的是 .5，但写死 0.5 会让「改成 .6」也算失败 ——
 *   判据钉的是**意图**（明显更暗），不是某个具体取值。
 */
const disabledLook = (s) => s.on !== null && s.off !== null
  && Number(s.on.opacity) >= 0.95
  && Number(s.off.opacity) <= 0.7
  && s.off.cursor === 'not-allowed';
check('㉒ ★ 没有解读时 book-to-skill 的「不可点」看得出来（不是只有一个 disabled 属性）',
  disabledLook(ST),
  `可点 opacity=${ST.on === null ? 'null' : ST.on.opacity}`
  + ` · 不可点 opacity=${ST.off === null ? 'null' : ST.off.opacity}`
  + ` cursor=${ST.off === null ? 'null' : ST.off.cursor}`);

/**
 * ★ 0.24.1 判据 ㉓：整页必须装得进量测视口。
 *
 *   这条不是量产品，是量**夹具自己** —— 0.24.1 加了两块夹具之后忘了加视口高度，
 *   `#row-panel` 的底边 4419 已经越过 4300，新加的「两态」那块**整块没进图**。
 *   而 ⑪ 只比对 PNG 宽高，照样全绿 ⇒ 交付出去的那张对照图上少了一整块，
 *   没有任何一条判据会说话。真机里同类的错法：内容溢出被 `overflow:hidden` 裁掉，
 *   元素仍在 DOM 里、仍能 Tab 到，用户却看不见（与 ⑳㉑ 是同一类）。
 * ★ 它不需要单独的反向对照：失败形态就是它自己变红（越界即红）。
 */
check('㉓ 所有夹具都装得进量测视口（对照图没有把哪一块裁掉）',
  typeof out.bodyHeight === 'number' && out.bodyHeight <= out.viewport.height,
  `整页高 ${out.bodyHeight} · 视口高 ${out.viewport.height}`
  + '（越界 ⇒ 最下面那块没进对照图，而 ⑪ 只看 PNG 宽高，发现不了）');

console.log('--- 反向对照：判据的原式喂给真坏摆法，必须变红 ---');
/**
 * ★ 四条对照，每条都用**判据自己的那个函数**（不是另写一句描述旧实现）：
 *   · ① ⇒ 0.18.x 的摆法（目录在书页之后）；
 *   · ⑤ ⇒ 0.19.0 第一版（伴读也挪到左边，用户当场指出的那一版）；
 *   · ⑨ ⑩ ⇒ 宽处那块夹具（横排时书页与目录同高、目录只有 306 宽）。
 *   · ⑧ ⇒ 0.18.x 那块夹具顺带把 `.npr-book-main` 的定位基准拆掉。
 */
check('★ 反向对照：① 的原式喂给「目录在书页之后」必须失败',
  !digestIsLeft(O),
  `旧摆法 目录 right=${O.panel.right.toFixed(1)} 书页 left=${O.stage.left.toFixed(1)}`
  + '（居然也在左边？那判据 ① 量不到这次改动）');
check('★ 反向对照：⑤ 的原式喂给「伴读也挪到左边」必须失败',
  !companionIsRight(L),
  `第一版 伴读 left=${L.companion.left.toFixed(1)} 书页 right=${L.stage.right.toFixed(1)}`
  + '（居然在右边？那判据 ⑤ 量不到这次改动）');
check('★ 反向对照：⑨ 的原式喂给**宽处**必须失败（横排时两者同高）',
  !stageIsAbovePanel(W),
  `宽处 书页 top=${W.stage.top.toFixed(1)} 目录 top=${W.panel.top.toFixed(1)}`
  + '（横排居然也「书页在上」？那判据 ⑨ 量不到竖排）');
check('★ 反向对照：⑩ 的原式喂给**宽处**必须失败（306px ≠ 全宽）',
  !panelFillsWidth(W),
  `宽处 目录宽=${W.panel.width.toFixed(1)} 阅读区宽=${W.main.width.toFixed(1)}`);
check('★ 反向对照：⑧ 的原式喂给「定位基准挂错」必须失败',
  !cardAvoidsToolbar(O),
  `基准挂错 浮层 top=${O.card.top.toFixed(1)} 工具栏底=${O.toolbar.bottom.toFixed(1)}`
  + `（main 的 position=${O.mainCss.position}；居然没压到工具栏？那判据 ⑧ 是空话）`);
/**
 * ★ ⑫⑬ 的反向对照用的是**同一块夹具**（0.18.x 那块，高 340）：
 *   · `order: -1` 把导出块提到列表前面 ⇒ ⑫ 必须红；
 *   · 340 的高度装不下「生成区 + 导出块」⇒ 列表被压到 0 ⇒ ⑬ 必须红。
 *   两条都不需要另造夹具，而且都是真实会发生的样子。
 */
check('★ 反向对照：⑫ 的原式喂给「导出块被 order 提到列表前面」必须失败',
  !skillAfterList(O),
  `坏摆法 导出块 top=${O.skill.top.toFixed(1)} 列表底=${O.skillList.bottom.toFixed(1)}`
  + '（居然还在列表之后？那判据 ⑫ 量不到顺序）');
check('★ 反向对照：⑬ 的原式喂给「面板只有 340 高」必须失败',
  !listUsable(O),
  `340 高 列表高=${O.skillList.height.toFixed(1)}`
  + '（居然还够 3 行？那判据 ⑬ 的阈值太松，量不到挤压）');
check('★ 反向对照：⑱ 的原式喂给「隐藏副标题 + 隐藏展开指示器」必须失败',
  !(subVisible(G) && chevPresent(G)),
  `回退后 副标题=${shown(G, 'skillSub')} 指示器=${shown(G, 'skillChev')}`
  + '（还看得见？那判据 ⑱ 量不到「折叠态说不出所以然」这件事）');
check('★ 反向对照：⑲ 的原式喂给「透明底 + 描边的幽灵按钮」必须失败',
  !solidFill(G),
  `回退后按钮底色=${G.skillGoLook === null ? 'null' : G.skillGoLook.background}`
  + '（居然还是实心？那判据 ⑲ 量不到「主按钮不够重」这件事）');
check('★ 反向对照：⑳ 的原式喂给「路径文字不肯收缩」必须失败',
  !copyReachable(SQ),
  `挤出去后 复制钮 ${SQ.skillCopy === null ? 'null' : `${SQ.skillCopy.left.toFixed(1)}→${SQ.skillCopy.right.toFixed(1)}`}`
  + ` 面板 right=${SQ.panel.right.toFixed(1)}`
  + '（居然还在面板内？那判据 ⑳ 量不到「按钮被顶出去」这件事）');
check('★ 反向对照：㉑ 的原式喂给「生成解读不肯收缩 + 最长文案」必须失败',
  !rowOk(RW),
  `挤出去后 生成解读 ${RW.digestStart === null ? 'null' : RW.digestStart.width.toFixed(1) + ' 宽'}`
  + ` · book-to-skill ${RW.digestSkill === null ? 'null' : `${RW.digestSkill.left.toFixed(1)}→${RW.digestSkill.right.toFixed(1)}`}`
  + ` · 面板 right=${RW.panel.right.toFixed(1)}`
  + '（居然还装得下？那判据 ㉑ 量不到「右边那颗被顶出去」这件事）');
check('★ 反向对照：㉒ 的原式喂给「盖掉 :disabled 灰化」必须失败',
  !disabledLook(SB),
  `盖掉后 不可点 opacity=${SB.off === null ? 'null' : SB.off.opacity}`
  + ` cursor=${SB.off === null ? 'null' : SB.off.cursor}`
  + '（居然还看得出？那判据 ㉒ 量不到「只有属性、没有样式」这件事）');

// ---- 5. 出对照图，并自证 PNG 宽高 -----------------------------------------
const pngPath = join(pluginRoot, 'test', '.build', 'book-panel-left-right.png');
run([...VIEWPORT_ARGS, '--virtual-time-budget=2000', `--screenshot=${pngPath}`, `file://${htmlPath}`]);

const png = readFileSync(pngPath);
if (png.slice(1, 4).toString('latin1') !== 'PNG') throw new Error('出的不是 PNG');
const pngW = png.readUInt32BE(16);
const pngH = png.readUInt32BE(20);
/**
 * ★ 自证宽高（DPR = 1）：本项目踩过「交付图被另一次调用静默换成更矮的裁切」——
 *   文件名不变、内容少一半。尺寸对不上就是被覆盖过。
 */
check(`⑪ 对照图宽高 = 量测视口：期望 ${VIEWPORT.width}×${VIEWPORT.height}`,
  pngW === VIEWPORT.width && pngH === VIEWPORT.height,
  `实测 ${pngW}×${pngH}`);
console.log(`  对照图：${pngPath}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} 条判据失败：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('\n全部断言通过。');
