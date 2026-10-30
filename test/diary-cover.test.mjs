/**
 * 开场说明页（灵感 0.53.0 / 私密 0.56.2）。
 *
 * 用户 2026-10-29：「这一项功能也能不能点进来，右边默认页也类似于这样，标题是
 * 『寸心拾遗 · 思想原点』，按下鼠标左键动画消失，出现记录灵感的内容」。
 * 用户 2026-10-30（私密那张）：「私密日记的说明页和灵感开场页操作一样，
 * 就是鼠标点一下消失，出现解锁页面。」
 *
 * 判据分两层：
 *   ① **纯函数** `coverVisible()` —— 三条例外，每一条写反都只是「封面不出现」或
 *      「封面挡着编辑器」，肉眼都像正常；
 *   ② **接线** —— 判据真的被调用、「进过了」真的按模块记、两张真的二选一、
 *      按下真的是 pointerdown 而不是 click、CSS 的时长与 `COVER_EXIT_MS` 是同一个数。
 *
 * ★ 「两张真的二选一」在源码层只能判到分派写在哪；**它是否真的渲染出来**
 *   由 `diary-render.test.mjs` 真渲染钉住（`{showHead || …}` 这类写错，
 *   字符串断言照样绿）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { coverVisible, COVER_EXIT_MS } from '../src/client/diary-cover.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const diary = readFileSync(new URL('../src/client/DiaryApp.jsx', import.meta.url), 'utf8');
const cover = readFileSync(new URL('../src/client/DiaryCover.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/client/refinements.css', import.meta.url), 'utf8');

describe('封面什么时候出现（coverVisible）', () => {
  it('灵感模块 + 没进过 + 没有外部意图 ⇒ 出现', () => {
    assert.equal(coverVisible({ module: 'inspiration', entered: false, intent: null }), true);
  });

  it('★ 已经进过 ⇒ 不再出现 —— 切模块来回不该反复弹', () => {
    // 没有这一条，用户去私密看一眼再回来，封面会再弹一次：一个「开场」变成一道门。
    assert.equal(coverVisible({ module: 'inspiration', entered: true, intent: null }), false);
  });

  it('★ 私密也出现（0.56.2）—— 用户要的就是这一张', () => {
    // 2026-10-30：「为什么私密日记没有说明页，我给你的需求不明确吗？
    //   私密日记的说明页和灵感开场页操作一样，就是鼠标点一下消失，出现解锁页面。」
    assert.equal(coverVisible({ module: 'private', entered: false, intent: null }), true);
  });

  it('读后感 ⇒ 不出现 —— 它的「说明页」是那个欢迎页，条件完全不同', () => {
    // 读后感的说明页判据是「有没有选书」，由组件自己判，不是这张开场页。
    assert.equal(coverVisible({ module: 'reflection', entered: false, intent: null }), false);
  });

  it('★ 私密那张进过之后也不再出现（按模块记，不是全局一个布尔）', () => {
    assert.equal(coverVisible({ module: 'private', entered: true, intent: null }), false);
  });

  it('★ 外部带着灵感意图进来 ⇒ 不拦（用户已经在写了）', () => {
    assert.equal(coverVisible({ module: 'inspiration', entered: false, intent: { module: 'inspiration' } }), false);
  });

  it('★ 带着私密意图进来仍然要出现 —— 那张说明页是那道门的门牌', () => {
    // 对称地抄成「意图模块 === 当前模块就不出现」很顺手，但私密这半边没有
    // 「已经在写了」的外部入口；从哪儿进来都该先看见说明，再按一下面对口令卡。
    assert.equal(coverVisible({ module: 'private', entered: false, intent: { module: 'private' } }), true);
  });

  it('读后感意图不影响灵感封面（那是另一个模块的 intent）', () => {
    assert.equal(coverVisible({ module: 'inspiration', entered: false, intent: { module: 'reflection', bookId: 'b1' } }), true);
  });

  it('intent 是 undefined / 空对象也不炸', () => {
    assert.equal(coverVisible({ module: 'inspiration', entered: false, intent: undefined }), true);
    assert.equal(coverVisible({ module: 'inspiration', entered: false, intent: {} }), true);
  });
});

describe('接线：判据真的被用上，且封面与正文是二选一', () => {
  it('DiaryApp 通过 coverVisible() 判，而不是自己写一串三元', () => {
    assert.match(diary, /coverVisible\(\{ module: moduleValue, entered: Boolean\(coverEntered\[moduleValue\]\), intent \}\)/,
      '封面判据没有走纯函数，或「进过了」没按模块取 —— 一个布尔会让两张封面互相吃掉');
  });

  it('★ 「进过了」按模块记：标记写的是按下那一刻的模块', () => {
    // 退场动画有 260ms，这段时间里用户完全可能切模块；照回调执行时的 `moduleValue`
    // 记，会把标记写到新模块头上，刚切过去的那张说明页就被静默吃掉。
    assert.match(diary, /const markCoverEntered = \(module\) => \{\s*setCoverEntered\(\(current\) => \(\{ \.\.\.current, \[module\]: true \}\)\);/,
      '「进过了」不是按模块记的');
    assert.match(diary, /const module = moduleValue;\s*setCoverLeaving\(\(current\) => \(\{ \.\.\.current, \[module\]: true \}\)\);/,
      '退场时没有把模块名捕获下来 —— 定时器里读的会是回调执行那一刻的值');
    assert.match(diary, /markCoverEntered\(module\);\s*setCoverLeaving\(\(current\) => \(\{ \.\.\.current, \[module\]: false \}\)\);/,
      '定时器里没用捕获下来的模块名');
    // 「正在退场」也是按模块的：共用时切模块会让新那张带着 is-leaving 渲染出来。
    assert.match(diary, /const leavingNow = Boolean\(coverLeaving\[moduleValue\]\);/,
      '「正在退场」是一个全局布尔 —— 切模块会带出一帧空白');
    assert.match(diary, /leaving=\{leavingNow\}/, '说明页的 leaving 没接到按模块的那个值');
  });

  it('★ 两张说明页按模块二选一（不是两个并列的 showCover）', () => {
    // 两个条件都成立时，两张会一起挂上去 —— 上下排两块「点一下开始」。
    assert.match(diary, /\{showCover && \(moduleValue === 'private' \? \(\s*<PrivateCover/,
      '私密没有自己的说明页 —— 用户要的正是这一张');
    assert.match(diary, /<PrivateCover[\s\S]{0,400}?<DiaryCover/,
      '灵感那张不在 else 分支上');
  });

  it('★ 封面与 `.npr-diary-flow` 互斥渲染（不是叠着盖一层）', () => {
    assert.match(diary, /\{showCover && \(moduleValue === 'private'/, '封面没有挂在 showCover 上');
    assert.match(diary, /\{!showCover && \(\s*<div className="npr-diary-flow">/,
      '正文列没有跟着 showCover 一起收起来 —— 编辑器会在封面底下继续挂载');
  });

  it('★ 封面态顶栏不报「今天 · N 条」：结果不能排在动作前面', () => {
    // 顶栏开始标签之后、第一段文案之前，必须已经出现 `{showHead && (`。
    // ★ 0.56.0 起这里不再是 `!showCover`：顶栏的内容判据改成了 `showHead`
    //   （封面 / 私密 / 读后感都空着），见 DiaryApp 里那一段。
    assert.match(diary, /<div className="npr-book-toolbar" data-window-drag>\s*\{[\s\S]{0,900}?\{showHead && \(/,
      '顶栏没有跟着封面一起收起 —— 封面上面还挂着「今天 / 0 条」');
  });

  it('★ 顶栏空着时那条拖动行与书架欢迎页同款：无底边、44px', () => {
    // 用户 2026-10-30：「红色线的地方明显有个分割线，为什么，其它的是没有的」。
    // 编辑器态的 `border-bottom` 是「日期栏 / 正文」的分界；栏里一个字都没有时，
    // 线就成了没来由的一条横线 —— 而书架欢迎页顶上只有一条无边框的 44px 空拖动行。
    // ★ 0.56.0：标记从 `data-cover` 改名 `data-bare`（封面 / 私密 / 读后感共用）。
    assert.match(diary, /className="npr-reader npr-diary-reader" data-bare=/,
      '顶栏空着的状态没给容器标记 —— CSS 没有把顶栏那条线让掉的依据');
    const rule = /\.npr-diary-reader\[data-bare\] > \.npr-book-toolbar \{([^}]*)\}/.exec(css);
    assert.ok(rule, '找不到无头态顶栏规则');
    assert.match(rule[1], /border-bottom: 0/, '无头态顶栏还留着底边 —— 就是那条没来由的横线');
    assert.match(rule[1], /height: 44px/, '无头态顶栏不是 44px —— 和书架欢迎页的顶部留白对不齐');
    assert.match(rule[1], /min-height: 0/, 'min-height 没归零：多出的 12px 会把大标题整体顶下去');
    // 反向对照：高度归零就没有拖动区了 —— 0 高的元素按不住。
    // ★ 必须带 `(?:^|;)` 边界：裸 `/height:\s*0/` 会命中 `min-height: 0`
    //   （上面那条正断言要求的），于是这条反向对照对**正确**的规则也报红。
    assert.doesNotMatch(rule[1], /(?:^|;)\s*height:\s*0(?![.\d])/,
      '拖动行被压成 0 高 —— 这一页顶部拖不动窗口');
  });

  it('★ 按下左键就退场：是 pointerdown + button === 0，不是 click', () => {
    assert.match(cover, /onPointerDown=/, '没有 pointerdown —— click 要求按下与抬起之间指针不动，按住再松手就不灵');
    assert.match(cover, /event\.button === 0/, '没判左键 —— 右键菜单与中键也会把封面点掉');
  });

  it('键盘也能进（Enter / Space）：一张只能用鼠标开场的页面，键盘用户进不去', () => {
    assert.match(cover, /onKeyDown=/);
    assert.match(cover, /event\.key === 'Enter' \|\| event\.key === ' '/);
  });

  it('标题是用户定的那一句', () => {
    assert.match(cover, /<h2>寸心拾遗 · 思想原点<\/h2>/);
  });

  it('★ 私密那张共用同一个外壳，标题与提示语各是各的', () => {
    // 外壳共用（版式 / 按下即退场 / 键盘可达只写一处），内容各写各的 ——
    // 两张说的是两件事：一张讲怎么写，一张讲这里锁着、谁也看不到。
    assert.match(cover, /<DiaryStartpage leaving=\{leaving\} label="进入私密日记" onEnter=\{onEnter\}>/,
      '私密说明页没走共用外壳 —— 版式与键盘可达会各抄一份');
    assert.match(cover, /<h2>私密日记 · 只在本机<\/h2>/);
    assert.match(cover, /点一下，进入私密日记/, '私密说明页没告诉用户下一步做什么');
  });

  it('★ 私密说明页不报条数与字数（上锁时宿主根本不给正文）', () => {
    // 报「0 条 · 0 字」是确定的假话：锁着的时候那些数不是零，是取不到。
    const at = cover.indexOf('export function PrivateCover');
    assert.notEqual(at, -1, '找不到 PrivateCover');
    const block = cover.slice(at);
    assert.doesNotMatch(block, /条<\/span>|字<\/span>/, '私密说明页报了条数或字数');
    assert.match(block, /已记 \{days\} 天/);
  });

  it('★ 整页按一下就跳过封面 —— 判定面不能小于可点面积', () => {
    // 用户 2026-10-30 的原话：「说明页只有点击说明页本身以及点击灵感时间线的灵感条
    // 会消失，点击其它不会消失，日记也是，只有点击说明页本身以及日历会消失」。
    // 那个手感对应的是「钩子只绑在某几个子区域上」：点到的算，没点到的就是「点了没反应」。
    // 所以判定面必须与用户看到的可点面积一样大 —— 挂在整页那一层，谁都不用猜哪儿能点。
    // ★ 用剥过注释的源码：注释里写过的同一串字会让本判据假绿。
    const code = stripComments(diary);
    const from = code.indexOf('npr-workarea npr-diary-workarea');
    const to = code.indexOf('npr-layout npr-diary-layout', from + 1);
    assert.ok(from > 0 && to > from, '找不到整页根节点');
    const head = code.slice(from, to);
    assert.match(head, /onPointerDownCapture=\{showCover \? skipCover : undefined\}/,
      '整页那一层没有撤封面的钩子 —— 点标签、点工具条、点空白处，右边都还停在说明页');
    assert.match(head, /onKeyDownCapture=\{showCover \? skipCover : undefined\}/,
      '键盘按下去不会撤 —— Enter 不触发 pointerdown');
    // 反向：钩子不能缩回左栏。缩回去就等于「只有日历和时间线能撤」那个老毛病。
    const asideAt = code.indexOf('<aside className="npr-sidebar npr-diary-nav"');
    assert.ok(asideAt > 0, '找不到左栏');
    const asideTag = code.slice(asideAt, code.indexOf('>', asideAt) + 1);
    assert.doesNotMatch(asideTag, /skipCover/,
      '钩子被缩回左栏了 —— 判定面又小于可点面积');
  });

  it('★ CSS 的退场时长与 COVER_EXIT_MS 是同一个数', () => {
    assert.match(css, new RegExp(`\\.npr-diary-startpage\\.is-leaving[^}]*transition: opacity ${COVER_EXIT_MS}ms`),
      `CSS 里的退场时长不是 ${COVER_EXIT_MS}ms —— 两处不一致会出现「动画没走完页面已经换了」的一帧闪`);
  });

  it('退场只动 opacity / transform（动高度会让编辑器在最后一帧跳一下）', () => {
    const rule = /\.npr-diary-startpage\.is-leaving \{([^}]*)\}/.exec(css);
    assert.ok(rule, '找不到退场规则');
    assert.match(rule[1], /opacity: 0/);
    assert.match(rule[1], /transform:/);
    assert.doesNotMatch(rule[1], /height:/, '退场动画动了 height');
  });
});

describe('★ 开场页不得借用书封面的类名', () => {
  // 教训（2026-10-29，「为什么背景颜色不统一」）：开场页原本叫 `.npr-diary-cover`，
  // 与 BookCover.jsx 的封面缩略图同名，于是继承了它的 `color-mix(fg 6%, bg)` 灰罩底色、
  // 4px 圆角、1px 描边和 `aspect-ratio: 3 / 4` —— 开场页变成一块灰卡，与周围两个色。
  // ★ 必须**剥掉注释再判**：`DiaryCover.jsx` 的文件头注释里写了这个类名（在解释
  //   为什么不能用），带着注释做反向断言会对注释永远报红 —— 一次假阴性。
  const book = readFileSync(new URL('../src/client/BookCover.jsx', import.meta.url), 'utf8');
  const coverCode = stripComments(cover);
  const bookCode = stripComments(book);

  it('开场页不用 npr-diary-cover 这个类', () => {
    assert.doesNotMatch(coverCode, /npr-diary-cover/, '开场页与书封面同名 —— 会继承它的灰罩底色');
    assert.match(coverCode, /npr-diary-startpage/, '开场页没有自己的类');
  });

  it('开场页规则里不给不透明的 background —— 它应当露出页面底色', () => {
    const rule = /^\.npr-diary-startpage \{([^}]*)\}/m.exec(css);
    assert.ok(rule, '找不到 `.npr-diary-startpage` 规则');
    assert.match(rule[1], /background: transparent|background:\s*transparent/,
      '开场页没有显式透明 —— 少了它会继承后面任何一条带底色的规则');
    assert.doesNotMatch(rule[1], /aspect-ratio/, '开场页被套进了固定宽高比');
  });

  it('开场页的类只在开场页出现；书封面的类只用在 BookCover 上', () => {
    assert.match(bookCode, /className="npr-diary-cover"/, '书封面改名了 —— 本条与那边的对照要一起改');
    assert.doesNotMatch(bookCode, /npr-diary-startpage/, '开场页的类跑到书封面上去了');
  });
});
