/**
 * 书架阅读器的**面板高度链**：`.npr-reader-book` 这条配对。
 *
 * 为什么要有静态守卫：这条链改坏了**不会有任何报错** —— 构建过、其它 700 个用例全绿，
 * 只是「适应窗口」按钮点了没反应、面板下方空出一大块。它已经真的坏过一次（0.6.1）：
 *
 *   `.npr-reader` 是普通块盒，而高度链 `.npr-book{flex:1}` → `.npr-book-main{flex:1}`
 *   → `.npr-book-stage` **只有在 flex 上下文里才成立**。块盒里它们全是死代码，舞台
 *   高度于是退化成「画布自己撑出来的高度」（自指量），实测（真 Chrome，1400×900）：
 *     面板可视 813 / 书页区 1588；点「适应窗口」6 次重算后页面仍是 1046×1490
 *     —— 和「适宽」一模一样，「整页缩进面板里，一屏看完」变成一句假话。
 *
 * 一条断言量不到「渲染出来高多少」，所以这里钉的是**判据与配对**：
 *   ① JSX 里那个类名在不在、在不在**同一个** `<section>` 上；
 *   ② CSS 里那条规则还在不在、形状对不对；
 *   ③ 居中必须是**画布自己的 margin:auto**，不是容器的 justify-content:center
 *      （后者在滚动容器里会让起始边永远滚不到：页面比面板宽时左边一截再也看不见）。
 * 每条都配反向对照（把 0.6.1 那份喂给同一套判据，要求变红），否则这些断言只是把
 * 当前实现抄了一遍。
 *
 * ★ 0.19.0 追加第二组：**面板在左、书页在右**。这一条同样「改坏了不报错」——
 *   面板跑到右边、或者竖排时跑到书页上方，页面照样能读，只是用起来别扭，
 *   而没有任何断言会响。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const libraryCode = readFileSync(join(clientDir, 'LibraryApp.jsx'), 'utf8');
const readerCode = readFileSync(join(clientDir, 'BookReader.jsx'), 'utf8');
const css = readFileSync(join(clientDir, 'refinements.css'), 'utf8');

/**
 * 取出某个类选择器的**开标签全文**（`className="…"` 所在的那个元素）。
 *
 * 不用「最近的 `<`」一条路：`.npr-reader` 这种开标签跨行、里面还有 `style={{…}}`，
 * 随手一截就会截在属性中间 —— 那么「标签里有没有那个类名」就可能因为**截断**而假绿。
 * 所以按 `{} [] ()` 深度 + 引号状态扫，只认深度 0 的 `>`（同 `test/window-drag.test.mjs`）。
 */
function openTagOf(source, className) {
  const anchor = source.indexOf(`className="${className} `) !== -1
    ? source.indexOf(`className="${className} `)
    : source.indexOf(`className="${className}"`);
  assert.ok(anchor !== -1, `找不到 class="${className}" —— 断言自己失效了，先修断言`);
  const start = source.lastIndexOf('<', anchor);
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return assert.fail(`class="${className}" 的开标签没有闭合`);
}

/**
 * 取一个类选择器**所有**规则的声明体，合并成一段返回。
 *
 * 三个坑，都踩过或差点踩到：
 *  ① 选择器和 `{` 之间**有空格**（`.npr-reader-book { … }`），所以不能拿
 *     `indexOf('${selector}{')` 去精确匹配 —— 那必然找不到，然后这条断言就
 *     从「守卫」变成「永远失败」或者被顺手删掉。
 *  ② 只取**第一条**匹配会假绿：`.npr-book-stage` 在 `@container` 里还有一条
 *     （窄面板的 min-height 兜底），第一条不是主规则。CSS 的多条同选择器规则
 *     本来就是累加生效的 —— 合并起来看才是真实的最终声明集。
 *  ③ 限定「行首（可含缩进）+ 选择器 + {」，免得命中 `:is(.npr-list, .npr-reader,
 *     .npr-book-stage, …)` 那张滚动条名单里的同名字样。
 */
function ruleBodies(text, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`, 'g');
  const bodies = [...text.matchAll(re)].map((match) => match[1]);
  assert.ok(bodies.length > 0,
    `CSS 里找不到 ${selector} {…} 规则（已按「行首 + 选择器 + {」扫过全文）—— 断言自己失效了，先修断言`);
  return bodies.join('\n');
}

const isFlexColumn = (body) => /display:\s*flex/.test(body) && /flex-direction:\s*column/.test(body);
const centeredByContainer = (body) => /justify-content:\s*center/.test(body);
const centeredByCanvas = (body) => /(^|;)\s*margin:\s*auto/.test(body);

describe('书架阅读器的面板高度链', () => {
  it('★ 书那一半的 .npr-reader 同时带上 npr-reader-book（配对的一半在 JSX 里）', () => {
    const tag = openTagOf(libraryCode, 'npr-reader');
    assert.match(tag, /className="npr-reader npr-reader-book"/,
      '书架的 <section> 丢了 npr-reader-book：高度链会退回块盒，适应窗口按钮随即失效');
  });

  it('★ CSS 里那条规则是把 reader 变成 flex 列容器（配对的另一半在 CSS 里）', () => {
    assert.ok(isFlexColumn(ruleBodies(css, '.npr-reader-book')),
      '.npr-reader-book 必须是 display:flex + flex-direction:column —— 少了它，.npr-book{flex:1} 是死代码');
  });

  it('★ 居中靠**书页块**的 margin:auto，不靠容器的 justify-content:center', () => {
    // 容器是**滚动容器**：`justify-content:center` 在内容比它大时会让起始边滚不到
    //（适宽模式下页面通常比面板高 ⇒ 页面左边一截永远看不见）。margin:auto 是安全居中：
    // 装得下就居中，装不下自动退化成 0，两端都能滚到。
    //
    // ★ 0.20.5：居中主体从 `.npr-book-canvas` 换成了 `.npr-book-sheet`（它是画布与
    //   透明文字层共用的定位基准）。判据要守的东西没变 —— 但**必须跟着换主体**，
    //   否则它守的是一段已经退化成 `margin:0` 的声明，等于静默失效。
    // ★ 画布自己**不能**再吃 auto：两者各居中一次时，画布会在 sheet 里再偏一次，
    //   而文字层是 `inset:0` 铺满 sheet 的 —— 直接后果就是选区整体偏移。
    assert.ok(centeredByCanvas(ruleBodies(css, '.npr-book-sheet')), '.npr-book-sheet 缺 margin:auto');
    assert.ok(!centeredByCanvas(ruleBodies(css, '.npr-book-canvas')),
      '.npr-book-canvas 不该再有 margin:auto —— 居中归 .npr-book-sheet，两边都 auto 会把文字层推离字形');
    assert.ok(!centeredByContainer(ruleBodies(css, '.npr-book-stage')),
      '.npr-book-stage 不能用 justify-content:center 居中（滚动容器里会吃掉起始边）');
  });

  it('反向对照：0.6.1 那份坏配置会被同一套判据判红', () => {
    const badReader = 'display:block';                                            // 块盒 ⇒ flex:1 是死代码
    const badStage = 'display:flex;justify-content:center;align-items:flex-start'; // 容器居中 ⇒ 起始边滚不到
    const badPage = 'display:block;background:#fff;box-shadow:none';              // 没有 margin:auto
    assert.equal(isFlexColumn(badReader), false);
    assert.equal(centeredByContainer(badStage), true);
    assert.equal(centeredByCanvas(badPage), false);
  });

  it('反向对照：取规则体这步本身不会漏（窄面板那条兜底也算进最终声明集）', () => {
    // ★ 0.24.3：这条兜底（`min-height: 120px`）从 `.npr-book-stage` 搬到了
    //   `.npr-book-view`（舞台外面新加的那一层）。断言必须跟着换主体 ——
    //   留着旧选择器的话它会直接抛「找不到规则」，而修的办法不是删断言，
    //   是**盯住现在真正有两条规则的那个选择器**。
    // `.npr-book-view` 有两条规则（主规则 + @container 兜底）。若辅助函数只认第一条，
    // 这条用例会拿到不含 min-height 的那段 —— 那种「漏」上面的断言是看不出来的。
    const view = ruleBodies(css, '.npr-book-view');
    assert.ok(/min-height:\s*120px/.test(view),
      '只取到了第一条 .npr-book-view 规则：@container 里那条兜底被漏掉了（同选择器的多条规则必须合并看）');
    assert.ok(/position:\s*relative/.test(view), '主规则 .npr-book-view{position:relative} 也没取到');
  });
});

/**
 * 目录在**左**、伴读在**右**（0.19.0）。
 *
 * ★ 两块面板方向相反是**有意的**，不是笔误：
 *   · 目录是**导航**类 —— 电子书阅读器的通行摆法，视线从左上往下扫目录、再落到
 *     右边的正文；
 *   · 伴读是**对话**类 —— 与订阅那半边的伴读同侧，同一件事不该在两个方向上找。
 *   把它们都摆到左边（第一版就是这么写的）会让伴读在同一个应用里换边，用户
 *   为「AI 在哪」重新建立一次肌肉记忆。用户当场就指出来了：「目录在左，伴读在右啊」。
 *
 * ★ 判据分两层，缺一层都会假绿：
 *   ① **横排**靠 DOM 顺序（目录在 stage 之前、伴读在 stage 之后）—— 用 CSS `order`
 *      挪视觉会让读屏与 Tab 顺序和眼睛看到的相反；
 *   ② **竖排**（窄容器）必须用 `order` 把书页提回第一位，否则「目录在上面」。
 *   只查①的话，竖排会把正文挤到屏幕下半截；只查②的话，横排方向可能是反的。
 */
describe('目录在左、伴读在右', () => {
  /**
   * ★ 只认 `1px` 那一条，不认 `border-left:` 这个前缀 —— 竖排覆盖里写的是
   *   `border-left: 0`（把横排那条线关掉），而 `ruleBodies` 会把同选择器的
   *   **多条规则合并**起来看。用前缀判断的话，`border-left: 0` 也算「线在左边」，
   *   于是「把横排的线改到右边」这个变异体**抓不住**（实测 MISS 过一次）。
   */
  const sideBorder = (body) => {
    if (/border-left\s*:\s*1px/.test(body)) return 'left';
    if (/border-right\s*:\s*1px/.test(body)) return 'right';
    return 'none';
  };

  it('★ 横排：目录写在书页舞台**之前**，伴读写在**之后**（DOM 顺序 = 视觉顺序）', () => {
    const panel = readerCode.indexOf('<BookDigestPanel');
    const stage = readerCode.indexOf('className="npr-book-stage"');
    const companion = readerCode.indexOf('<BookCompanion');
    assert.ok(panel > 0, '找不到 <BookDigestPanel> —— 断言自己失效了');
    assert.ok(stage > 0, '找不到 npr-book-stage —— 断言自己失效了');
    assert.ok(companion > 0, '找不到 <BookCompanion> —— 断言自己失效了');
    assert.ok(panel < stage, '目录写在了书页后面：它会被摆到右边（用户要的是左边）');
    assert.ok(companion > stage, '伴读写在了书页前面：它会被摆到左边（用户要的是右边）');
  });

  it('★ 分隔线各贴自己**朝内**那一侧：目录 border-right、伴读 border-left', () => {
    assert.equal(sideBorder(ruleBodies(css, '.npr-book-digest')), 'right',
      '.npr-book-digest 的分隔线方向不对：目录在左，线该贴它的右缘');
    assert.equal(sideBorder(ruleBodies(css, '.npr-book-companion')), 'left',
      '.npr-book-companion 的分隔线方向不对：伴读在右，线该贴它的左缘');
  });

  it('★ 竖排：书页 order 1、两块面板 order 2（正文在上，面板在下）', () => {
    // ★ 0.24.3：order 挂在 `.npr-book-view` 上，不在舞台上。舞台已经不是
    //   `.npr-book-main` 的直接子节点，把规则写回它等于整条失效 ——
    //   而**症状只是「竖排时目录又跑到上面」**，几何判据仍可能被面板自己的
    //   `order: 2` 蒙过去（`check-book-panel-layout.mjs` 的 ⑨-a 用 computed
    //   order 专门盯这一层）。这里守的是源码契约：规则落在正确的那一层。
    const viewOrder = /order:\s*(\S+?)\s*;/.exec(ruleBodies(css, '.npr-book-main > .npr-book-view'));
    const panelOrder = /order:\s*(\S+?)\s*;/.exec(ruleBodies(css, '.npr-book-main > .npr-companion'));
    assert.ok(viewOrder, '窄容器里没有给书页那一层写 order —— 竖排会把目录顶到最上面');
    assert.ok(panelOrder, '窄容器里没有给面板写 order');
    // ★ `order` 只吃整数：`.5` 这类值会被**整条声明静默丢弃**，而文本断言看不出来。
    assert.match(viewOrder[1], /^-?\d+$/, `order 必须是整数，实际 ${viewOrder[1]}`);
    assert.match(panelOrder[1], /^-?\d+$/, `order 必须是整数，实际 ${panelOrder[1]}`);
    assert.ok(Number(viewOrder[1]) < Number(panelOrder[1]), '书页必须排在面板前面');
    // 反向：舞台上不该再有 order（写回这一层 = 静默失效）。
    // ★ 不能用 ruleBodies 去取 —— 它找不到规则时会直接抛错（那是它的本职），
    //   而这里要断言的正是「这条规则不存在」。
    assert.ok(!/(?:^|\n)[ \t]*\.npr-book-main > \.npr-book-stage[ \t]*\{/.test(css),
      '.npr-book-main > .npr-book-stage 不该有规则了：order 要落在 .npr-book-view 上');
  });

  it('★ 竖排时两块面板都要撑满宽度、分隔线改到上边', () => {
    // 目录面板此前**缺**这条：`flex: 0 0 306px` 在竖排里是**高度**、`width: 306px`
    // 又把它钉在左边 —— 面板只有 306 宽、右边空一大块。
    const digest = ruleBodies(css, '.npr-book-digest');
    assert.ok(/width:\s*100%/.test(digest), '.npr-book-digest 没有窄容器规则：竖排里会只剩 306px 宽');
    assert.ok(/flex:\s*0 1 320px/.test(digest), '.npr-book-digest 竖排下没有高度上限');
    // 伴读同理；它的横排分隔线在左，竖排里必须**换到上边**，否则竖排时左边多一条竖线。
    const companion = ruleBodies(css, '.npr-book-companion');
    assert.ok(/width:\s*100%/.test(companion), '.npr-book-companion 没有窄容器规则');
    assert.ok(/border-left:\s*0/.test(companion), '竖排时伴读的 border-left 没关掉：会在左边留一条竖线');
  });

  it('★★ 窄容器覆盖必须写在基础规则**之后**（同特异度，只靠源码顺序取胜）', () => {
    // 这一条是 0.19.0 用真 Chrome 量出来的真 bug：窄容器块原来写在文件前半截，
    // 与基础规则**同特异度**（都是单个类）⇒ 后写的基础规则胜出 ⇒
    // `.npr-book-digest{width:306px}` 稳稳压着 `width:100%`。
    // 症状：窄窗口下面板只有 306px 宽、右边空一大块。
    // ★ 而上面那条「合并看声明集」的断言对此**完全无感** —— `width:100%` 明明在。
    //   ⇒ 必须有这一条顺序断言；真几何由 scripts/check-book-panel-layout.mjs 判据 ⑩ 兜底。
    const narrowMain = css.indexOf('.npr-book-main { flex-direction: column; }');
    assert.ok(narrowMain > 0, '找不到窄容器里的 .npr-book-main 覆盖 —— 断言自己失效了');
    for (const base of [
      '.npr-book-digest { flex: 0 0 306px;',
      '.npr-book-companion { flex: 0 0 348px;',
      '.npr-book-stage { flex: 1;',
    ]) {
      const at = css.indexOf(base);
      assert.ok(at > 0, `找不到基础规则 ${base}`);
      assert.ok(narrowMain > at,
        `窄容器块写在了 ${base} 之前：同特异度下基础规则胜出，竖排覆盖是死代码`);
    }
  });

  it('反向对照：0.18.x 那份摆法（两块都在右）会被同一套判据判红', () => {
    // 旧版：目录在书页之后 + border-left + 没有 order。
    const oldPanel = 'flex: 0 0 306px; width: 306px; border-left: 1px solid var(--npr-border);';
    assert.equal(sideBorder(oldPanel), 'left');
    assert.equal(/order:\s*\S+\s*;/.test(oldPanel), false);
    // 旧顺序：`<BookDigestPanel>` 出现在 `npr-book-stage` 之后。
    const oldOrder = '<div className="npr-book-stage" />…<BookDigestPanel />';
    assert.ok(oldOrder.indexOf('<BookDigestPanel') > oldOrder.indexOf('npr-book-stage'));
  });

  it('反向对照：第一版那套「两块都挪到左边」也会被判红', () => {
    // 0.19.0 的第一版把伴读也写到了 stage 前面、并把它的线改成 border-right。
    // 用户的原话就是冲着这一版来的：「目录在左，伴读在右啊」。
    const allLeft = '<BookDigestPanel />…<BookCompanion />…<div className="npr-book-stage" />';
    // 判据的原式（伴读必须在 stage 之后）喂给这个形态 ⇒ 必须为假。
    assert.equal(allLeft.indexOf('<BookCompanion') > allLeft.indexOf('npr-book-stage'), false,
      '这条对照自己写坏了：应当构造出「伴读在 stage 之前」的形态');
    const wrongCompanion = 'flex: 0 0 348px; width: 348px; border-right: 1px solid var(--npr-border);';
    assert.equal(sideBorder(wrongCompanion), 'right',
      '把伴读的线改成 border-right 之后判据应当读出 right（那就不等于期望的 left）');
  });
});

/**
 * 从**剥过注释**的源码里抠出一个 `const NAME = <expr>;` 的完整表达式。
 *
 * ★ 不靠缩进、不靠「找到下一个空行」：`useCallback(() => {…}, [deps])` 里既有花括号
 *   又有圆括号，任何按行截断的写法都会截在函数中间 —— 那样「函数体里有没有 X」这条
 *   判据会因为**截断**而假绿（历史教训：截断式断言给死代码发过合格证）。
 *   这里按括号配对走，`;` 只在配对深度归零时才算结束。
 * ★ 前提：`source` 已经剥掉注释，且字符串里没有未配对的 `(`/`;`。本文件目前满足；
 *   哪天某条字符串里出现裸括号，就得换成真正的解析器，别在这里打补丁。
 */
function extractBinding(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `源码里找不到 \`const ${name}\`，这条判据失去对象`);
  const from = start + marker.length;
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(from, i);
  }
  assert.fail(`\`const ${name}\` 的表达式没找到结尾（括号不配对？）`);
  return '';
}

/**
 * 全屏的**入口唯一性 + 与沉浸解耦**（0.24.2 立的规矩，0.24.6 换了守法）。
 *
 * 0.24.2 的规矩（用户原话）：「点沉浸只是左边两列缩掉，只显示阅读的这一列，但是在
 * 点击沉浸的时候窗口大小不动，如果要全屏是用户自己选择点击。」
 * 当时的写法是「阅读器里**一个全屏 API 都不许出现**」—— 简单、够用，因为那会儿
 * 插件确实一次都不调全屏。
 *
 * ★ 0.24.6 用户报了「提示说按 ⌃⌘F 全屏，我试过了，没反应」，于是插件**必须**真的
 *   绑这个键 ⇒ `requestFullscreen` 合法地回来了。原来那两条断言的前提变了，
 *   但**它守的那件事没变**：全屏是用户对**窗口**的主动决定，不许被沉浸顺手驱动。
 *   ⇒ 判据从「不许出现」收紧成「只许出现在 `toggleFullscreen` 里，且沉浸函数体
 *   里一个全屏字样都没有」。删掉判据是错的，换成「哪里出现都行」更错。
 *
 * ★ 为什么这里只能用源码断言：调一次全屏 API 的后果（窗口变形、Esc 被接管）在
 *   node 里根本观察不到，而几何脚本跑的是静态夹具、不会点按钮。
 * ★ 先剥注释：注释里提到这几个名字（解释为什么不那么做）不算调用 —— 否则判据会
 *   因为「解释了自己为什么不这么做」而变红。
 */
describe('0.24.6：全屏是独立入口，不由沉浸驱动', () => {
  const code = readerCode
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const FULLSCREEN_APIS = ['requestFullscreen', 'exitFullscreen', 'fullscreenElement'];

  it('★ 全屏 API 只出现在 toggleFullscreen 里（一个独立入口，别处不许有）', () => {
    const entry = extractBinding(code, 'toggleFullscreen');
    const elsewhere = code.replace(entry, '');
    for (const api of FULLSCREEN_APIS) {
      assert.equal(elsewhere.includes(api), false,
        `全屏 API 跑到 toggleFullscreen 外面去了：${api}`);
    }
    // 「只在里面」这条可以靠「哪儿都没有」蒙过去 ⇒ 还要证明它自己真的调了
    assert.ok(entry.includes('requestFullscreen') && entry.includes('exitFullscreen'),
      'toggleFullscreen 里没有进出全屏的调用 —— 那它就是空壳，⌃⌘F 还是没反应');
  });

  it('★ 沉浸不驱动全屏：toggleImmersive 函数体里没有全屏字样，也不调 toggleFullscreen', () => {
    const fn = extractBinding(code, 'toggleImmersive');
    for (const name of [...FULLSCREEN_APIS, 'fullscreenchange', 'toggleFullscreen']) {
      assert.equal(fn.includes(name), false,
        `沉浸又去动窗口大小了：${name} 出现在 toggleImmersive 里`);
    }
  });

  it('★ 没有 fullscreenchange 监听（它是把两个状态机缠在一起的东西）', () => {
    assert.equal(code.includes('fullscreenchange'), false,
      '挂了 fullscreenchange ⇒ 用户自己按 ⌃⌘F 进出全屏时会被顺手退出沉浸');
  });

  it('反向对照：把 requestFullscreen 挪进 toggleImmersive，上面那条判据必须变红', () => {
    const mutated = code.replace(
      'const next = !immersive;',
      'const next = !immersive; void globalThis.document.documentElement.requestFullscreen();',
    );
    assert.notEqual(mutated, code, '变异没打上：锚点 `const next = !immersive;` 没命中');
    const fn = extractBinding(mutated, 'toggleImmersive');
    assert.ok(fn.includes('requestFullscreen'),
      '变异体里读不到 requestFullscreen —— 说明 extractBinding 抠错了范围，判据是瞎的');
  });

  it('反向对照：原文里**有**这些词（注释里解释过），剥完注释才落到函数里 —— 判据看得见它们', () => {
    assert.ok(readerCode.includes('requestFullscreen'),
      '注释里连提都没提？那上面几条判据没有对照价值（它可能只是名字压根不在文件里）');
    assert.ok(readerCode.includes('fullscreenchange'),
      '注释里没提 fullscreenchange ⇒ 「没有监听」那条可能只是名字不在文件里，不是真删了');
    assert.equal(code.includes('fullscreenchange'), false);
  });

  it('只把全屏拿出来了，没动布局：插件自己的两列在沉浸态仍然收掉', () => {
    assert.ok(css.includes('.npr-workarea.is-book-immersive .npr-sidebar'), '书架列不收了');
    assert.ok(css.includes('.npr-workarea.is-book-immersive .npr-resize'), '分隔条不收了');
    assert.ok(css.includes('.npr-book.is-immersive .npr-book-meta'), '元信息行不收了');
    assert.ok(readerCode.includes('is-immersive'), '阅读器不再标沉浸态');
  });
});
