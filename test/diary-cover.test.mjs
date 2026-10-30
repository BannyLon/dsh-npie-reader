/**
 * 灵感模块的开场封面（0.53.0）。
 *
 * 用户 2026-10-29：「这一项功能也能不能点进来，右边默认页也类似于这样，标题是
 * 『寸心拾遗 · 思想原点』，按下鼠标左键动画消失，出现记录灵感的内容」。
 *
 * 判据分两层：
 *   ① **纯函数** `coverVisible()` —— 三条「不该拦」的例外，每一条写反都只是
 *      「封面不出现」或「封面挡着编辑器」，肉眼都像正常；
 *   ② **接线** —— 判据真的被调用、封面与正文是二选一、按下真的是 pointerdown
 *      而不是 click、CSS 的时长与 `COVER_EXIT_MS` 是同一个数。
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

  it('★ 私密 / 读后感 ⇒ 不出现 —— 它们各有自己的开场，不能再叠一层', () => {
    assert.equal(coverVisible({ module: 'private', entered: false, intent: null }), false);
    assert.equal(coverVisible({ module: 'reflection', entered: false, intent: null }), false);
  });

  it('★ 外部带着灵感意图进来 ⇒ 不拦（用户已经在写了）', () => {
    assert.equal(coverVisible({ module: 'inspiration', entered: false, intent: { module: 'inspiration' } }), false);
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
    assert.match(diary, /coverVisible\(\{ module: moduleValue, entered: coverEntered, intent \}\)/,
      '封面判据没有走纯函数 —— 三条例外会被抄成条件分支，改一处漏一处');
  });

  it('★ 封面与 `.npr-diary-flow` 互斥渲染（不是叠着盖一层）', () => {
    assert.match(diary, /\{showCover && \(\s*<DiaryCover/, '封面没有挂在 showCover 上');
    assert.match(diary, /\{!showCover && \(\s*<div className="npr-diary-flow">/,
      '正文列没有跟着 showCover 一起收起来 —— 编辑器会在封面底下继续挂载');
  });

  it('★ 封面态顶栏不报「今天 · N 条」：结果不能排在动作前面', () => {
    // 顶栏开始标签之后、第一段文案之前，必须已经出现 `{!showCover && (`。
    assert.match(diary, /<div className="npr-book-toolbar" data-window-drag>\s*\{[\s\S]{0,600}?\{!showCover && \(/,
      '顶栏没有跟着封面一起收起 —— 封面上面还挂着「今天 / 0 条」');
  });

  it('★ 封面态那条拖动行与书架欢迎页同款：无底边、44px', () => {
    // 用户 2026-10-30：「红色线的地方明显有个分割线，为什么，其它的是没有的」。
    // 编辑器态的 `border-bottom` 是「日期栏 / 正文」的分界；封面态这一栏里一个字都没有，
    // 线就成了没来由的一条横线 —— 而书架欢迎页顶上只有一条无边框的 44px 空拖动行。
    assert.match(diary, /className="npr-reader npr-diary-reader" data-cover=/,
      '封面态没给容器标记 —— CSS 没有把顶栏那条线让掉的依据');
    const rule = /\.npr-diary-reader\[data-cover\] > \.npr-book-toolbar \{([^}]*)\}/.exec(css);
    assert.ok(rule, '找不到封面态顶栏规则');
    assert.match(rule[1], /border-bottom: 0/, '封面态顶栏还留着底边 —— 就是那条没来由的横线');
    assert.match(rule[1], /height: 44px/, '封面态顶栏不是 44px —— 和书架欢迎页的顶部留白对不齐');
    assert.match(rule[1], /min-height: 0/, 'min-height 没归零：多出的 12px 会把大标题整体顶下去');
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

  it('★ 侧栏一动就跳过封面 —— 否则选了日期、右边还是封面，等于点了没反应', () => {
    assert.match(diary, /onPointerDownCapture=\{showCover \? skipCover : undefined\}/,
      '侧栏没有撤封面的钩子 —— 点一天之后右边仍是欢迎页');
    assert.match(diary, /onKeyDownCapture=\{showCover \? skipCover : undefined\}/,
      '键盘用户点侧栏日期时封面不会撤 —— Enter 不触发 pointerdown');
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
