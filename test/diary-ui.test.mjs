/**
 * 日记作为**第三个 tab** 的入口契约（2026-10-26 新增）。
 *
 * 这一层守的是「**进得去、切得走、回得来、刷新后还在**」——四件事各自会以
 * 完全不同的方式坏掉，而且**都不会报错**：
 *
 *   ① 入口没画出来 ⇒ 用户根本不知道有这个功能（不是崩溃，是消失）。
 *   ② 切得走但回不来 ⇒ 进了日记就只剩「订阅」一条路，书架丢了。
 *   ③ 刷新后落回订阅 ⇒ `localStorage` 里存着 `'diary'`，而初值写成
 *      `=== 'library' ? 'library' : 'feeds'` 就把它**静默吞成订阅**。
 *   ④ 日记页留着「专注」状态 ⇒ `.npr-root.npr-focus .npr-sidebar{display:none}`
 *      把日记自己的日历列藏掉，而日记页里没有任何「显示列表」的按钮。
 *
 * ★ 为什么这一层是源码级：真跑要宿主槽位 + DOM + `localStorage`，而缺陷的因果
 *   全在**静态结构**里（哪个分支、哪个白名单、哪一行守卫）。每条判据都配反向对照
 *   （塞回旧写法必须变红），并显式断言锚点找得到 —— 锚点失效时宁可报错，
 *   也不要静默全绿。
 *
 * ★ 产物级的那一半（类名/前缀真的进了 `lib/client.js`）在 `build.test.mjs` 里，
 *   因为那需要先跑一次真构建。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const read = (name) => stripComments(readFileSync(join(clientDir, name), 'utf8'));

const reader = read('ReaderPage.jsx');
const library = read('LibraryApp.jsx');
const diary = read('DiaryApp.jsx');
const viewSwitch = read('ViewSwitch.jsx');

/** 切出单个 `useEffect(() => {` … `}, [deps]` 的正文（与 reader-mode-switch 同源写法）。 */
function effectAt(code, marker) {
  const at = code.indexOf(marker);
  if (at < 0) return null;
  const start = code.lastIndexOf('useEffect(() => {', at);
  if (start < 0 || start > at) return null;
  const end = code.indexOf('}, [', at);
  if (end < 0) return null;
  return code.slice(start, end);
}

/**
 * ③ 的判据：`npr.mode` 的初值必须**逐个列出**已知值。
 * 写成三元（`saved === 'library' ? … : …`）就会把 `'diary'` 静默吞成 `'feeds'`。
 */
function acceptsDiaryFromStorage(code) {
  const at = code.indexOf("localStorage.getItem('npr.mode')");
  if (at < 0) return false;
  // 初值表达式就在这条语句之后、到 `});` 为止的那一小段里。
  const window = code.slice(at, at + 400);
  return /saved\s*===\s*'library'\s*\|\|\s*saved\s*===\s*'diary'/.test(window)
    || /saved\s*===\s*'diary'\s*\|\|\s*saved\s*===\s*'library'/.test(window);
}

/** ④ 的判据：日记那条 `setFocused(false)` 必须是**独立一行**，不能并进 library 那条。 */
function resetsFocusOnDiary(code) {
  return /if\s*\(\s*mode\s*===\s*'diary'\s*\)\s*setFocused\(\s*false\s*\)/.test(code);
}

/**
 * 「切模块时清空选中」那条 effect 的正文。
 *
 * ★ 锚点**不能**用 `setSelected(undefined)`：`hideArticle()` 里也有同样一句（隐藏的正好是
 *   当前这篇时清掉右侧），而 `effectAt()` 取的是文件里**第一处**。0.45 加了那次「隐藏后
 *   清右侧」之后，这个锚点就悄悄指到了另一个 effect 上 —— 于是这一组两条一直是红的，
 *   而代码本身是对的（假红比不测更糟：它教人忽略红灯）。
 * ★ 改用只在那一处出现的模式守卫：`if (mode !== 'library') return;`（全文件唯一）。
 */
const modeEffect = effectAt(reader, "if (mode !== 'library') return;");

describe('入口：三个 tab 都在，且语义说得清', () => {
  it('ViewSwitch 渲染三个按钮（订阅 / 书 / 日记），选中态各自独立', () => {
    assert.match(viewSwitch, /aria-label="订阅"/, '没有「订阅」按钮');
    assert.match(viewSwitch, /aria-label="书"/, '没有「书」按钮');
    assert.match(viewSwitch, /aria-label="日记"/, '没有「日记」按钮 —— 第三个 tab 的入口丢了');
    // 三个 `aria-pressed` 必须分别绑到三种模式上，不能复制粘贴成同一个。
    for (const value of ['feeds', 'library', 'diary']) {
      assert.match(viewSwitch, new RegExp(`aria-pressed=\\{mode === '${value}'\\}`), `${value} 的选中态没绑对`);
    }
  });

  it('★ 分组标签是「主视图」而不是「阅读模式」（日记不是一种阅读）', () => {
    assert.match(viewSwitch, /role="group" aria-label="主视图"/);
    // 反向对照：旧文案不能以任何形式留在这一层 —— 读屏用户听到「阅读模式」再摸到
    // 「日记」，会以为那是一种阅读方式。
    assert.doesNotMatch(viewSwitch, /aria-label="阅读模式"/);
  });

  it('三个半边各放一个 ViewSwitch（否则进了任何一半就回不去）', () => {
    // 订阅页那一份在 ReaderPage 的工具栏里。
    assert.match(reader, /<ViewSwitch mode="feeds"/);
    assert.match(library, /<ViewSwitch mode="library"/);
    assert.match(diary, /<ViewSwitch mode="diary"/);
  });

  it('★ 两个非订阅半边都把**目标**往外传（无参回调会让「切到日记」变成「切回订阅」）', () => {
    assert.match(library, /onChange=\{\(next\) => \{ if \(next !== 'library'\) onExit\?\.\(next\); \}\}/,
      '书架没把目标传出去 —— 在书架里点「日记」会落回订阅');
    assert.match(diary, /onChange=\{\(next\) => \{ if \(next !== 'diary'\) onExit\?\.\(next\); \}\}/,
      '日记没把目标传出去 —— 在日记里点「书」会落回订阅');
  });
});

describe('切换：三条分支互斥渲染，且「离开」都带目标', () => {
  it('ReaderPage 按 mode 三选一渲染，日记那条真的挂上了 DiaryApp', () => {
    assert.match(reader, /mode === 'library' \?/, '书架分支不见了');
    assert.match(reader, /mode === 'diary' \?/, '日记分支不见了 —— 第三个 tab 点了没反应');
    assert.match(reader, /<DiaryApp /, 'DiaryApp 没被渲染');
    // 反向对照：日记必须排在「订阅」那一支**之前**，否则永远落到 else 里。
    const diaryAt = reader.indexOf("mode === 'diary' ?");
    const feedsAt = reader.indexOf('className={`npr-workarea${askContext');
    assert.ok(diaryAt > 0 && feedsAt > 0 && diaryAt < feedsAt, '日记分支落在了订阅分支之后 ⇒ 恒不生效');
  });

  it('从书架/日记往回切时，目标模式各自映射对（不是恒 feeds）', () => {
    assert.match(reader, /<LibraryApp[^>]*onExit=\{\(next\) => setMode\(next === 'diary' \? 'diary' : 'feeds'\)\}/,
      '书架的 onExit 没认出 diary ⇒ 在书架里点「日记」会落回订阅');
    assert.match(reader, /<DiaryApp[^>]*onExit=\{\(next\) => setMode\(next === 'library' \? 'library' : 'feeds'\)\}/,
      '日记的 onExit 没认出 library ⇒ 在日记里点「书」会落回订阅');
  });

  it('★ 反向对照：把 onExit 写回无参形态，上面那条必须变红', () => {
    // 旧写法（两个视图时代）是 `onExit={() => setMode('feeds')}` —— 第三个视图一来
    // 它就把「去日记」压成「回订阅」，而且**没有任何报错**。
    const old = reader.replace(
      /onExit=\{\(next\) => setMode\(next === 'diary' \? 'diary' : 'feeds'\)\}/,
      "onExit={() => setMode('feeds')}",
    );
    assert.notEqual(old, reader, '替换没生效，反向对照是假绿');
    assert.doesNotMatch(old, /<LibraryApp[^>]*onExit=\{\(next\) => setMode\(next === 'diary'/,
      '无参 onExit 居然还判绿 —— 判据没牙');
  });
});

describe('持久化：刷新后还停在日记', () => {
  it('npr.mode 的初值白名单里有 diary', () => {
    assert.equal(acceptsDiaryFromStorage(reader), true,
      'mode 初值没认 diary —— 刷新后静默落回订阅，日记 tab 看着像丢了');
  });

  it('★ 反向对照：把白名单改回两值（三元写法）必须变红', () => {
    const old = reader.replace(
      /return saved === 'library' \|\| saved === 'diary' \? saved : 'feeds';/,
      "return saved === 'library' ? saved : 'feeds';",
    );
    assert.notEqual(old, reader, '替换没生效，反向对照是假绿');
    assert.equal(acceptsDiaryFromStorage(old), false, '三元写法居然还判绿 —— 判据没牙');
  });

  it('「书架被设置关掉时请出去」那条不碰日记（日记没有开关）', () => {
    // 日记是纯本地的，没有 `reading.bookshelf === false` 那种设置项。
    // 如果哪天有人把这条守卫写成 `mode !== 'feeds'`，关掉书架会顺手把日记也踢走。
    assert.match(reader, /if \(reading\.bookshelf === false && mode === 'library'\) \{ setMode\('feeds'\); return; \}/,
      '这条守卫的形状变了 —— 现在它会连日记一起踢出去');
  });
});

describe('专注状态：日记页必须复位（否则日历列被藏掉）', () => {
  it('有独立的 `if (mode === \'diary\') setFocused(false)`', () => {
    assert.equal(resetsFocusOnDiary(reader), true,
      '日记页没复位专注 —— `.npr-root.npr-focus .npr-sidebar{display:none}` 会把日历列藏掉');
  });

  it('★ 它必须另起一行，不能并进 library 那条（reader-focus-scope 逐字守着那一句）', () => {
    const merged = /if\s*\(\s*mode\s*===\s*'library'\s*\|\|\s*mode\s*===\s*'diary'\s*\)/;
    assert.doesNotMatch(reader, merged,
      '两条守卫被并成了一条 —— reader-focus-scope.test.mjs 逐字钉着 library 那一句，并进去会变红');
    assert.match(reader, /if \(mode === 'library'\) setFocused\(false\);/, 'library 那条守卫不见了');
  });

  it('★ 反向对照：删掉日记那条，判据必须变红', () => {
    const old = reader.replace(/if \(mode === 'diary'\) setFocused\(false\);/, '');
    assert.notEqual(old, reader, '替换没生效，反向对照是假绿');
    assert.equal(resetsFocusOnDiary(old), false);
  });

  it('专注类名只按 feeds 才算（这一道保证「画不出来」）', () => {
    assert.match(reader, /focused && mode === 'feeds' \? ' npr-focus' : ''/,
      '专注类名不再按 feeds 收窄 —— 日记页会被套上专注样式');
  });
});

describe('选中：切到日记**故意**不清空（写读后感要能切回原文章）', () => {
  it('那条 effect 的守卫仍然只认 library', () => {
    assert.notEqual(modeEffect, null, '没找到「清空选中」那条 effect —— 锚点失效');
    assert.match(modeEffect, /if\s*\(\s*mode\s*!==\s*'library'\s*\)\s*return/,
      '守卫被改宽了 —— 切到日记也会把 selected 清掉，「写完读后感切回订阅」会落在欢迎页');
  });

  it('★ 但切到书架仍然要清（两条语义不同，不能统一）', () => {
    // 书架清空是因为「自动打开上一篇 ⇒ 英文自动生成译文 ⇒ 替你花一次模型调用」；
    // 日记不清是因为「读后感就是要引用刚才那篇」。混成一条必错一边。
    assert.match(modeEffect, /setSelected\(\s*undefined\s*\)/, '清空动作没了');
    assert.match(modeEffect, /articleRequest\.current \+= 1/, '在途正文请求没作废');
  });
});

describe('日记页的骨架与拖动区（与书架同构）', () => {
  it('自带 workarea / layout / sidebar / resize / reader 五件套', () => {
    for (const cls of ['npr-workarea', 'npr-layout', 'npr-sidebar', 'npr-resize', 'npr-reader']) {
      assert.ok(diary.includes(cls), `DiaryApp 里找不到 .${cls}`);
    }
  });

  it('两条拖动行都带 data-window-drag（祖先链的干净度由 window-drag 那个文件守）', () => {
    assert.match(diary, /className="npr-sidebar-toolbar" data-window-drag/);
    assert.match(diary, /className="npr-book-toolbar" data-window-drag/);
  });
});

// ---------------------------------------------------------------------------
// 0.31 返工：**三个功能模块**（灵感速记 / 私密日记 / 读后感）
//
// ★ 这一组守的是「用户说的是三个模块，不是三种条目类型」这条设计事实。
//   0.30.0 把它做成了一张表单 + 「灵感 / 读后感 / 书摘」三个类型按钮 —— 那是错的，
//   而且**没有任何测试会变红**（界面照样能点、能存、能读）。所以这里把
//   「类型不再出现在界面上」「模块决定 kind / vis」「`L` 浮层只有输入框」
//   三条都钉成断言，并各配一条反向对照。
// ---------------------------------------------------------------------------

const quick = read('QuickCapture.jsx');

describe('三个功能模块（不是三种条目类型）', () => {
  it('侧栏的切换来自 DIARY_MODULES，且顺序就是用户列的顺序', () => {
    assert.match(diary, /DIARY_MODULES\.map\(/, '模块切换没有从 DIARY_MODULES 来');
    assert.match(diary, /role="group" aria-label="日记功能"/, '分组标签应说「日记功能」');
    // 反向对照：不能是「主视图」/「阅读模式」那种说法 —— 这三个是**日记内部**的模块。
    assert.doesNotMatch(diary, /aria-label="侧栏视图"/, '旧的「侧栏视图」分组名还在');
  });

  it('★ 界面上不再有「书摘」这个类型（用户的设计里根本没有它）', () => {
    assert.doesNotMatch(diary, /书摘/, 'DiaryApp 里还残留「书摘」');
    assert.doesNotMatch(quick, /书摘/, '浮层里还残留「书摘」');
    assert.doesNotMatch(diary, /ENTRY_KINDS\.map\(/, '类型按钮还在（应由模块决定类型）');
  });

  it('★ kind / vis 由模块决定，用户不再手选', () => {
    // `mod` 是当前模块，`save()` 的默认值全部来自它。
    assert.match(diary, /MODULE_BY_VALUE\.get\(moduleValue\)/);
    assert.match(diary, /kind: kind \?\? mod\.kind/);
    assert.match(diary, /vis: vis \?\? mod\.vis/);
  });

  it('三个模块各有自己的写入口，不是同一张表单', () => {
    for (const marker of ["moduleValue === 'inspiration' &&", "moduleValue === 'private' &&", "moduleValue === 'reflection' &&"]) {
      assert.ok(diary.includes(marker), `缺少 ${marker} 那一块`);
    }
    // 灵感：极简（一个写入口，**没有**情绪行）
    // ★ 0.34 三个模块共用 `DiaryComposer`（同一个组件、三种变体），而不是三份
    //   textarea。判据因此从「类名」变成「变体」：类名相同是重构的自由，
    //   而 `variant` 三者必须齐、且各自配对——那才是「三种形态」这件事本身。
    assert.match(diary, /<DiaryComposer[\s\S]{0,200}?variant="quick"/);
    assert.match(diary, /<DiaryComposer[\s\S]{0,200}?variant="private"/);
    assert.match(diary, /<DiaryComposer[\s\S]{0,200}?variant="reflection"/);
    // 灵感那一块里不能出现 MoodRow（情绪追踪只在私密）。
    assert.equal((diary.match(/<MoodRow /g) ?? []).length, 1);
    // 私密：加密说明必须在
    assert.match(diary, /npr-diary-secret/, '私密的加密说明不见了');
    // 读后感：模板 + 划线引用
    assert.match(diary, /REFLECTION_TEMPLATE/);
    assert.match(diary, /quoteAnnotation\(item\)/);
  });
});

describe('读后感工作台：书 → 模板 → 引用划线', () => {
  it('书籍列表来自书架，点一本就打开', () => {
    assert.match(diary, /fetchBooks\(\)/);
    assert.match(diary, /openBook\(item\)/);
  });

  it('★ 读后感按**书**反查，不是按日期翻', () => {
    assert.match(diary, /fetchDiaryBook\(book\.id\)/);
  });

  it('划线侧栏是独立的一块，点「引用」插进正文', () => {
    assert.match(diary, /npr-diary-marks/);
    assert.match(diary, /fetchAnnotations\(target\.id\)/);
    // 引用要包成 Markdown 引用块，并带页码（页码在纯文本里也看得见）。
    assert.match(diary, /`> \$\{String\(item\.quote/);
    assert.match(diary, /第 \$\{item\.page\} 页/);
  });

  it('★ 模板只在正文为空时预填（否则会覆盖用户已经改过的内容）', () => {
    assert.match(diary, /current\.trim\(\) === '' \? REFLECTION_TEMPLATE : current/);
  });

  /*
   * 用户 2026-10-28：「读后感这部分，划线侧边栏应该可以收缩起来，写读后感的区域自适应」。
   * ★ 这里是**源码级**的粗判据（结构在不在）；几何与「正文真的变宽了」在
   *   `scripts/check-diary-marks-collapse.mjs` 里量渲染结果。
   */
  it('★ 划线侧栏可收起：两态都有入口，状态记在本机', () => {
    assert.match(diary, /npr-diary-marks-toggle/, '没有收起按钮');
    assert.match(diary, /npr-diary-marks-rail/, '没有展开用的窄轨 —— 收起来就再也打不开');
    assert.match(diary, /aria-expanded="true"/);
    assert.match(diary, /aria-expanded="false"/);
    // 默认**展开**：划线是写读后感的主要素材，收起是主动动作。
    assert.match(diary, /localStorage\.getItem\('npr\.diaryMarksOpen'\) !== '0'/,
      '默认态不是展开');
    assert.match(diary, /localStorage\.setItem\('npr\.diaryMarksOpen'/,
      '收起状态没记住 —— 每次重开都复位');
  });

  it('★ 收起态：不渲染列表、窄轨 34px、竖排直立', () => {
    // ★ 用 `diaryCss`（= `read('refinements.css')`，已剥注释）：不剥注释的话，
    //   注释里出现「text-orientation: upright」这几个字就能把这条判据蒙绿。
    const css = diaryCss;
    // 列表必须在 `marksPanelOpen ?` 的真值分支里。用下标比，不玩正则花活。
    const gate = diary.indexOf('marksPanelOpen ? (');
    const list = diary.indexOf('annotations.items.map((item) => (');
    assert.ok(gate > 0 && list > 0, '找不到开关或列表');
    assert.ok(list > gate, '划线列表写在开关之前 —— 收起时它照样渲染在 DOM 里');
    assert.match(css, /\.npr-root \.npr-diary-marks\.is-collapsed \{[^}]*flex: 0 0 34px/,
      '收起态不锁宽 —— AI 面板一开就把窄轨压成一条缝');
    // 展开态那一条不能被顺手删掉：划线栏要能让位（0.44.1 的教训）。
    assert.match(css, /\.npr-diary-marks \{[^}]*flex: 0 1 300px/);
    // 竖排里数字必须直立，否则「12」被转 90° 看起来像另一个字。
    assert.match(css, /\.npr-diary-marks-rail-label \{[^}]*text-orientation: upright/,
      '竖排标签没写 text-orientation: upright');
  });
});

describe('`L` 灵感浮层：只有一个输入框', () => {
  const lEffect = effectAt(reader, "event.key !== 'l'");

  it('ReaderPage 里有独立的 L 快捷键 effect（不能并进只认 feeds 的那条）', () => {
    assert.notEqual(lEffect, null, '没找到 L 键那条 effect —— 锚点失效或功能丢了');
    // 反向对照：那条 feeds 专属 effect 的第一行就是 `if (mode !== 'feeds') return undefined;`
    // —— 如果 L 被写进它里面，书架里按 L 会毫无反应。
    const feedsEffect = effectAt(reader, "if (mode !== 'feeds') return undefined;");
    assert.notEqual(feedsEffect, null, '订阅页那条 effect 不见了');
    assert.equal(feedsEffect.includes("event.key !== 'l'"), false, 'L 被并进了只认 feeds 的 effect');
  });

  it('★ 日记页不响应 L（那儿本来就有输入框，再盖一层会挡住它）', () => {
    assert.match(lEffect, /if \(mode === 'diary'\) return;/);
    const old = reader.replace("      if (mode === 'diary') return;\n", '');
    assert.notEqual(old, reader, '替换没生效，反向对照是假绿');
    assert.doesNotMatch(effectAt(old, "event.key !== 'l'") ?? '', /mode === 'diary'/, '删掉守卫居然还判绿');
  });

  it('浮层只在非日记页渲染，且只挂一份', () => {
    assert.match(reader, /\{mode !== 'diary' && <QuickCapture /);
    assert.equal((reader.match(/<QuickCapture /g) ?? []).length, 1, '浮层被挂了两份');
  });

  it('★ 浮层里**只有输入框**：没有类型 / 情绪 / 私密 / 任何选择器', () => {
    // 用户 2026-10-26 明确：「不包含其它项」。任何一项加回来，它就不再是速记。
    assert.doesNotMatch(quick, /ENTRY_KINDS/, '浮层里又出现了类型按钮');
    assert.doesNotMatch(quick, /MOODS/, '浮层里又出现了情绪');
    assert.doesNotMatch(quick, /vis/, '浮层里又出现了私密开关');
    // ★ 判据从「源码里不许出现 `source`」换成「不许出现**输入控件**」：
    //   0.31.0 的「灵感流转」会**自动**把正在读的书写进 `source` / `meta` ——
    //   那些值来自阅读上下文，不是用户在这一层选的。用户在浮层里能操作的仍然
    //   只有一个输入框；真正该守的是「别在这里长出第二个控件」。
    assert.doesNotMatch(quick, /<input/, '浮层里出现了输入框');
    assert.doesNotMatch(quick, /<select/, '浮层里出现了下拉选择');
    assert.equal((quick.match(/<textarea/g) ?? []).length, 1, '浮层里不止一个输入框');
    assert.equal((quick.match(/<button/g) ?? []).length, 2, '浮层的按钮不止「关闭」与「保存」两个');
    // ★ 只数个数是不够的：2 这个数字对「把保存换成别的操作」完全不敏感 —— 只要按钮总数
    //   还是 2，就算把「保存」删掉、塞一个无关按钮进来，这条判据照样绿。
    //   所以还要点名:这两个按钮必须是**关闭**与**保存**。
    assert.match(quick, /aria-label="关闭"/, '浮层没有「关闭」按钮');
    assert.match(quick, /保存/, '浮层没有「保存」按钮');
    assert.match(quick, /appendDiaryEntry\(\{ date: dateKey\(\), kind: '灵感', body: draft, source, meta \}\)/);
  });

  it('★ 反向对照：把「关闭」按钮删掉，上面的点名判据必须变红', () => {
    // 判据要跟 guardian 一样先证明自己不是假绿 —— 去掉 aria-label="关闭" 就得报错。
    const broken = quick.replace(/aria-label="关闭"/, 'aria-label="取消"');
    assert.notEqual(broken, quick, '替换没生效，反向对照不成立');
    assert.doesNotMatch(broken, /aria-label="关闭"/, '删掉「关闭」居然还判绿 —— 这条判据没有真正咬住');
  });

  it('★ 浮层里没有 data-window-drag（模态不能是拖动区）', () => {
    assert.doesNotMatch(quick, /data-window-drag/,
      '浮层被标成了拖动区 —— 按住它拖一下会把输入框拖走');
  });
});

/**
 * 切出某个模块的**写入口那一块** JSX（`{moduleValue === 'x' && (` … 下一个模块）。
 *
 * ★ 为什么需要它：0.32.0 把「AI 整理」从「每条一个」改成「日期栏上一个」，
 *   于是「私密模块里不能出现 AI 整理」这条边界不再是「某个分支里没有按钮」，
 *   而是「**这一整块**里没有」。用 `doesNotMatch(整个文件, /AI 整理/)` 会误伤
 *   读后感那一块（它按篇整理是合理的），必须按块取。
 */
function moduleBlock(code, name, nextName) {
  const start = code.indexOf(`{moduleValue === '${name}' && (`);
  if (start < 0) return null;
  const end = nextName ? code.indexOf(`{moduleValue === '${nextName}' && (`, start) : -1;
  return code.slice(start, end < 0 ? start + 4000 : end);
}

/**
 * 「AI 整理这一天」那颗按钮最近的模块守卫是哪一个。
 *
 * ★ 判据不能只看「文件里有 `moduleValue === 'inspiration'`」—— 那句在侧栏、
 *   写入口、日期栏各出现一次，随便一次就能让断言变绿。取**离按钮最近**的那一个。
 */
function aiButtonGuard(code) {
  const at = code.indexOf('className="npr-diary-ai"');
  if (at < 0) return null;
  const before = code.slice(Math.max(0, at - 500), at);
  const hits = [...before.matchAll(/moduleValue === '(\w+)' && \(/g)];
  return hits.length > 0 ? hits[hits.length - 1][1] : null;
}

describe('私密：三个入口都必须带 scope', () => {
  it('删条目用条目自己的日期与 scope（读后感列表跨天，不能拿「今天」去删）', () => {
    assert.match(diary, /removeDiaryEntry\(entry\.date \?\? selected, entry\.index, entry\.scope \?\? 'public'\)/);
  });

  it('★ 「正在忙哪一条」用 scope+index 组合键，不用下标', () => {
    // 用下标的后果：公开 0 号与私密 0 号会同时变成「确认删除」，而用户只看见一个。
    assert.match(diary, /function entryKey\(entry\)/);
    assert.match(diary, /return `\$\{entry\?\.scope \?\? 'public'\}-\$\{entry\?\.index \?\? 0\}`/);
    const old = diary.replace(/return `\$\{entry\?\.scope \?\? 'public'\}-\$\{entry\?\.index \?\? 0\}`/, 'return String(entry?.index ?? 0)');
    assert.notEqual(old, diary, '替换没生效，反向对照是假绿');
    assert.doesNotMatch(old, /return `\$\{entry\?\.scope/);
  });

  it('★ 私密模块里不出现「AI 整理」（宿主读的是公开那半边）', () => {
    const privateBlock = moduleBlock(diary, 'private', 'reflection');
    assert.notEqual(privateBlock, null, '私密那一块找不到了 —— 锚点失效');
    assert.doesNotMatch(privateBlock, /AI 整理/,
      '私密写入口里出现了 AI 整理 —— 模型读的是公开那半边，看到的会是同一天的另一段内容');
    assert.match(diary, /私密条目不进模型/, '私密的边界说明没了');
  });

  it('切到私密模块时显式取一次密钥状态，并把 file 模式说出来', () => {
    assert.match(diary, /fetchDiarySecret\(\)/, '没取密钥状态 —— 用户不知道密钥在哪');
    assert.match(diary, /secret\.mode === 'file'/);
    assert.match(diary, /防不住有人用这台已解锁的 Mac/, 'file 模式的后果没写出来');
  });
});

describe('导出：私密那半边要两次点击', () => {
  it('第一次只上膛，第二次才下载', () => {
    assert.match(diary, /if \(!exportArmed\) \{ setExportArmed\(true\); return; \}/);
    assert.match(diary, /fetchDiaryExport\(\{ includePrivate: true \}\)/);
    // 默认导出**不能**带私密：那条路写的是下载目录里的明文。
    assert.match(diary, /fetchDiaryExport\(\)/);
  });
});

describe('灵感模块：情绪 / 标签 / 时间轴 / 关联到书', () => {
  it('情绪按钮来自 MOODS，带 tone（CSS 按它取色），选中可再点一次取消', () => {
    assert.match(diary, /MOODS\.map\(/);
    assert.match(diary, /onChange\(value === item\.emoji \? '' : item\.emoji\)/,
      '心情按钮不再「再点一次取消」');
    // ★ tone 是配色与日历点的唯一依据：丢了它，五档会退回同一个灰。
    assert.match(diary, /data-tone=\{item\.tone\}/, '心情按钮上没有 data-tone —— 选中态染不上色');
  });

  it('条目上的标签可点，点了就走搜索 `#tag`', () => {
    assert.match(diary, /parseTags\(entry\.body\)/);
    assert.match(diary, /function searchTag\(tag\)/);
    assert.match(diary, /const query = `#\$\{tag\}`/);
  });

  it('★ 侧栏 = 一条时间轴：没有「按时间 / 按书本 / 按文章」', () => {
    // 用户 2026-10-29：「左边栏不应该分三个选项卡「按时间」、「按书本」、按文章。
    //   而应该只有按时间的时间轴，不管是在 RSS 文章阅读期间还是在读电子书期间按 L
    //   创建的灵感还是在灵感专题页下记录的灵感都显示在时间轴上，只是时间轴上的
    //   条目做个区分」。
    // ★ 他那句「逻辑不对」是准的：那三档不是三个视图，是**同一份数据的三种排法**
    //   （`timeline()` 每条已带 book/chapter/page/article）；而「按书本」还要换一整套
    //   行结构（来源行 → 展开 → 条目），于是同一件事有了两套排序、两套条目样式。
    assert.match(diary, /const TIMELINE_PAGE = 30;/, '时间轴没有分页步长常量');
    assert.match(diary, /fetchDiaryTimeline\(\{ limit: TIMELINE_PAGE \}\)/, '首屏没按步长取');
    assert.match(diary, /fetchDiaryTags\(\)/);
    // 「标签」这块的标题带一个计数徽章，所以判据是「标题以这个字开头」，
    // 它守的是「这一块存在且叫这个名字」。
    assert.ok(diary.includes('>标签'), '侧栏少了「标签」这一块的标题');
    // ★ 0.47.3：时间轴那块改名并**抬成主标题**。用户 2026-10-29：
    //   「这个时间轴明显一些，名称重新创意，比如你的灵感时间线之类的」。
    //   病根是层级倒挂 —— 标题 12px，而它统辖的日期行 12.5px，标题比内容还小。
    assert.match(diary, /npr-diary-sect-head is-lead[\s\S]{0,200}?你的灵感时间线/,
      '时间轴没有用那个名字 / 没有抬成主标题');
    assert.match(diary, /<span className="npr-diary-sect-mark"><Icon name="clock"/,
      '主标题没有品牌色图标块 —— 又退成一行裸文字');
    assert.match(diaryCss, /\.npr-diary-sect-head\.is-lead \{[^}]*font-size: 14px/,
      '主标题字号没越过它统辖的日期行（12.5px）—— 这就是「不明显」的根因');
    // ★ 0.47.4：时间轴默认展开**今天**。用户 2026-10-29：「时间轴上自动展开当天的」。
    //   用初值而不是 effect：effect 会在每次 timeline 重载后把用户手动收起的今天又摊开。
    assert.match(diary, /const \[openDay, setOpenDay\] = useState\(today\)/,
      '时间轴没有默认展开今天 —— 打开灵感页还要再点一下');
    for (const gone of ['LINK_VIEWS', 'setLinkView', 'openSrcKey', 'linkViewMeta', 'linkedSources', 'npr-diary-views']) {
      // 反向对照就写在同一条里：留着任何一处，「三档」就还在，只是长成了另一个样子。
      assert.equal(diary.includes(gone), false, `三档视图的残留还在：${gone}`);
    }
    // ★ 聚合不是第三个选项卡，而是时间轴的**一次收窄**：换数据源，不换渲染。
    //   换成两套渲染，就又会漂出两套排序 / 两套条目样式 —— 那正是它难用的原因。
    assert.match(diary, /const timelineDays = sourceScope === null \? timeline\.days : sourceDays\.days/,
      '收窄没有走「换数据源」这条路');
    assert.match(diary, /const recentDays = timelineDays/, '时间轴没有用统一的那份数据源');
    assert.match(diary, /fetchDiarySource\(\{ book: scopeBook, article: scopeArticle \}\)/, '没有按来源取全量');
    // 横条**只在收窄时**出现：默认态这一栏一个筛选控件都没有。
    assert.match(diary, /\{sourceScope !== null && \(\s*<div className=\{`npr-diary-scope/,
      '来源横条不是「只在收窄时出现」');
    assert.match(diary, /aria-label="回到全部灵感"/, '收窄态没有出口 —— 进去了出不来');
    // ★ 0.47.4：条目正文分两层（首句当标题、余下当摘要），不再是一行灰字**截断**。
    //   用户 2026-10-29 贴了一张 RSS 时间线，要的就是那种「加粗标题 + 淡色多行摘要」。
    //   反向对照也写在这里：只要 `.npr-diary-dayitem-text`（`white-space: nowrap` +
    //   ellipsis）还活着，两层就会被压回一行，而且看不出是哪里压的。
    assert.match(diary, /const lines = entryLines\(entry\.preview\)/, '条目正文没有分层');
    assert.match(diary, /npr-diary-dayitem-title">\{lines\.title\}/, '没有标题那一层');
    assert.match(diary, /\{lines\.rest !== '' && \([\s\S]{0,140}?npr-diary-dayitem-rest/,
      '没有摘要那一层 —— 长灵感只剩首句');
    assert.equal(diaryCss.includes('npr-diary-dayitem-text'), false,
      '旧的单行省略样式还在 —— 两层会被压回一行');
  });

  it('★ 时间轴：日期行可展开，折叠态不读正文', () => {
    // 用户 2026-10-27：「侧边栏是不是要有时间轴啊，比如点击今天，展开今天记录的
    // 时间轴」。0.32.0 这里只给「日期 + 条数」，点一下直接跳走 —— 侧栏因此只剩
    // 「哪几天写过」，回答不了「那天写了什么」，也就不算时间轴。
    assert.match(diary, /aria-expanded=\{open\}/, '日期行不是可展开的');
    assert.match(diary, /const open = openDay === item\.date/, '没有「同一次只展开一天」的状态');
    const openBlock = /\{open && \(([\s\S]*?)\n\s*\)\}/.exec(diary);
    assert.ok(openBlock, '没有找到「展开后渲染」的分支');
    assert.match(openBlock[1], /entry\.preview/, '展开分支里没有摘要 —— 展开了也看不到写了什么');
    const collapsedRows = [...diary.matchAll(/aria-expanded=\{open\}/g)].map((hit) => (
      diary.slice(hit.index, diary.indexOf('</button>', hit.index))
    ));
    assert.ok(collapsedRows.length >= 1, `可展开的行只找到 ${collapsedRows.length} 处 —— 判据锚点失效`);
    for (const row of collapsedRows) {
      assert.doesNotMatch(row, /\.preview/, '折叠态也在读 entry.preview —— 正文又被抄了一遍');
    }
    assert.match(diary, /entry\.kind !== '读后感'/, '时间轴没有滤掉读后感');
  });

  it('★ 「加载更早」：时间轴能往前翻，不是只给最近 30 天', () => {
    // 用户 2026-10-27 的诉求是「支持通过时间轴或标签快速检索」。
    // 0.39 之前这里只有一句「只看了最近 N 天。」—— 用户看得到还有更早的，
    // 却没有任何办法把它们调出来。那句话等于宣告「到此为止」。
    assert.match(diary, /async function loadMoreTimeline\(\)/, '没有翻页函数');

    // ★ 游标用**日期**，不是「已加载 N 天」。后端是 `date < before`，中间隔着
    //   没写日记的日子也照样对得上；用条数当 offset 会在空档上错位，而且错得安静
    //   （少一天、多一天都不报错，用户只会觉得「那几天怎么没了」）。
    assert.match(diary, /const oldest = timeline\.days\[timeline\.days\.length - 1\]\?\.date/,
      '翻页游标不是「最早那一天的日期」');
    assert.match(diary, /fetchDiaryTimeline\(\{ limit: TIMELINE_PAGE, before: oldest \}\)/,
      '翻页没把 before 传下去 —— 等于又从头取了一遍');

    // ★ 追加，不是替换。替换会让用户点一次「加载更早」就把眼前这 30 天换掉。
    assert.match(diary, /days: \[\.\.\.current\.days, \.\.\.added\]/, '翻页是替换而不是追加');

    // ★ 按 date 去重：重复键会让 React 报 key 冲突，侧栏还会多出一行同一天。
    assert.match(diary, /const seen = new Set\(current\.days\.map\(\(day\) => day\.date\)\)/,
      '追加没有去重');
    assert.match(diary, /\.filter\(\(day\) => !seen\.has\(day\.date\)\)/, '去重没有真的过滤');

    // ★ 只有真拿到了新的天，才继续声称「还有更早」。否则按钮永远停在那里、
    //   点一次什么也不发生 —— 死按钮比没有按钮更糟。
    assert.match(diary, /truncated: added\.length > 0 && payload\.truncated === true/,
      '翻页拿到 0 天仍写着「还有更早」');

    // 界面：按钮存在、带数字、忙碌时禁用并给出可见文案。
    assert.match(diary, /className="npr-diary-dayload"/, '侧栏没有「加载更早」的入口');
    assert.match(diary, /disabled=\{timeline\.more \|\| timeline\.busy\}/, '翻页时按钮没有禁用');
    assert.match(diary, /正在读更早的记录/, '翻页时没有可见的忙碌文案');
    assert.match(diary, /目前只显示最近 \$\{timeline\.days\.length\} 天/, '按钮没印出已显示多少天');

    // 反向对照：旧的「到此为止」那句话不能单独回来 —— 它现在长在按钮里。
    assert.doesNotMatch(diary, /<p className="npr-diary-sect-note">只看了最近/,
      '又退回了「只看了最近 N 天」的死胡同');
  });

});

// ---------------------------------------------------------------------------
// 「AI 整理」的粒度：**一天一个**，不是一条一个（2026-10-27 用户明确）
// ---------------------------------------------------------------------------

describe('AI 整理：整天，不是逐条', () => {
  it('★ 上下文不传 target —— 那是「整天模式」的开关', () => {
    // `diaryContext()` 里 `target === null` 时开场白写的是「处理对象是这一天的
    // 日记整体」。传了 target 就退回「一条一条整理」，正是用户否掉的做法。
    // ★ 0.34 起同一个函数服务两种上下文（整天 / 单篇），用三元表达式分流。
    //   判据是**两个分支各自的样子**：整天那条不许带 target，单篇那条必须带。
    assert.match(diary, /\{ sessionId: acquired\.sessionId, date: selected \}/,
      '「AI 整理这一天」还在传 target —— 那还是逐条整理');
    assert.match(diary, /date: entry\.date \?\? selected, target: entry\.index/,
      '单篇整理没有带 target —— 模型会在整天的上下文里找那一篇');
    // 提示词也得说清是「整天」，否则模型看到多条上下文仍会只改第一条。
    assert.match(diary, /今天这一整天/, '提示词没说明是整天 —— 模型会当成某一条');
  });

  it('★ 灵感模块没有逐条 AI 按钮，读后感才有（一篇读后感本身就是一整篇文档）', () => {
    assert.doesNotMatch(diary, /tidyWithAi/, '逐条整理的旧函数还在');
    // ★ 0.34 起 `openAiPanel()` 有三个正当调用点：抽屉的「换一个对话」、面板里的
    //   「重试」、以及灵感模块那颗主按钮。所以**不能再按出现次数**判「只挂一处」——
    //   那会把两个恢复入口当成越界。真正要守的是「那颗**日期栏**按钮的守卫是
    //   inspiration」，由下面 `aiButtonGuard` 那条专门管。
    assert.match(diary, /void openAiPanel\(\)/, '「AI 整理这一天」的入口不见了');
    assert.equal((diary.match(/void openAiPanel\(entry\)/g) ?? []).length, 1, '逐条 AI 整理挂了不止一处');
    assert.match(diary, /AI 整理这一篇/, '读后感那条没有标明它是「按篇」');
  });

  it('★ 「AI 整理这一天」只出现在灵感模块的守卫里', () => {
    assert.equal(aiButtonGuard(diary), 'inspiration',
      '那颗按钮的守卫不是 inspiration —— 私密/读后感模块也会出现「AI 整理这一天」');
  });

  it('★ 反向对照：把守卫换成 private，上面那条判据必须变红', () => {
    const broken = '<div>{moduleValue === \'private\' && (\n  <button type="button" className="npr-diary-ai" onClick={x}>y</button>)}</div>';
    assert.equal(aiButtonGuard(broken), 'private', '判据读不出守卫 —— 它对任何输入都会给同一个答案');
  });
});

// ---------------------------------------------------------------------------
// 0.32：两个入口（书里点「写读后感」）+ 书籍档案卡
//
// ★ 这一组守的是两条**静默失效**的路：
//   ① 书里那颗按钮点了没反应 —— 因为先切视图、后记意图，`DiaryApp` 挂载那一刻
//      `intent` 还是 null，而它的 effect 依赖 `intent?.bookId`，此后永不再跑。
//      界面不报错、按钮有 hover、点了也确实切到了日记 —— 只是落在灵感速记上。
//   ② 档案卡把「划线数」当成「摘录笔记数」显示 —— 两个数都合理，谁也不会怀疑。
// ---------------------------------------------------------------------------

const bookReader = read('BookReader.jsx');
const bookEbook = read('BookEbook.jsx');

/** ① 的判据：`writeReflection` 里 `setDiaryIntent` 必须排在 `setMode('diary')` 之前。 */
function intentRecordedBeforeSwitch(code) {
  const at = code.indexOf('const writeReflection = (book) => {');
  if (at < 0) return false;
  const end = code.indexOf('\n  };', at);
  if (end < 0) return false;
  const body = code.slice(at, end);
  const intentAt = body.indexOf('setDiaryIntent(');
  const modeAt = body.indexOf("setMode('diary')");
  return intentAt >= 0 && modeAt >= 0 && intentAt < modeAt;
}

/** ② 的判据：`noteCount` 只数**写过 note 的**划线。 */
function countsOnlyAnnotatedNotes(code) {
  const at = code.indexOf('const noteCount =');
  if (at < 0) return false;
  const line = code.slice(at, code.indexOf('\n', at));
  return line.includes('annotations.items')
    && line.includes('item.note')
    && /!==\s*''/.test(line);
}

/**
 * 取一个 JSX 开标签的正文。
 *
 * ★ **不能用 `/<X[^>]*prop=/`**：这几个组件的 `onExit` 里带箭头函数，
 *   `>` 出现在 `=>` 上，`[^>]*` 会在那里断掉 —— 于是「属性没接上」的假红
 *   （本文件第一版就踩了：`<LibraryApp … onWriteReflection={writeReflection}>` 判不出来）。
 *   按「起点 + 固定窗口」取，窗口足够覆盖这几行属性。
 */
function openTag(code, name, span = 600) {
  const at = code.indexOf(`<${name}`);
  return at < 0 ? '' : code.slice(at, at + span);
}

describe('入口二：阅读页「读完」那一行 → 写读后感', () => {
  it('书架把「写读后感」的去处交给**行**，不再交给两个阅读器', () => {
    assert.match(library, /canReflect=\{canReflect\} onReflect=\{reflectBook\}/,
      '「读完」那一行没接上写读后感的去处 —— 只剩「重新阅读」，用户就得自己翻话题');
    assert.equal((library.match(/onWriteReflection=\{onWriteReflection\}/g) ?? []).length, 0,
      '还在把 onWriteReflection 转交给阅读器 —— 那个按钮 0.44.3 已经删了');
  });

  it('★ 回调引用必须稳定（memo 过的行，内联箭头会让 2634 行每次全重渲染）', () => {
    // `onWriteReflection` 是 ReaderPage 里的普通函数，每次渲染都是新身份。
    // 直接当 prop 传下去，`BookRow` 的 memo 就全废了（P1-5 那两条前提里的第 2 条）。
    assert.match(library, /const reflectBook = useCallback\(\(book\) => \{ reflectRef\.current\?\.\(book\); \}, \[\]\);/,
      'reflectBook 不是零依赖的 useCallback —— 每一行都会重渲染');
    assert.match(library, /const canReflect = typeof onWriteReflection === 'function';/,
      'canReflect 没按「有没有这个去处」算 —— 没有时会画出一颗点了没反应的按钮');
  });

  it('★ ReaderPage 先记意图、再切视图', () => {
    assert.ok(openTag(reader, 'LibraryApp').includes('onWriteReflection={writeReflection}'),
      '书架没接上 writeReflection');
    assert.ok(openTag(reader, 'DiaryApp').includes('intent={diaryIntent}'),
      '日记没收到 intent');
    assert.equal(intentRecordedBeforeSwitch(reader), true,
      'setDiaryIntent 排在 setMode 之后 —— DiaryApp 挂载时 intent 还是 null，按钮点了没反应');
  });

  it('★ 反向对照：把两步调换顺序，上面那条必须变红', () => {
    const swapped = reader
      .replace("    setMode('diary');\n  };", '  };')
      .replace('  const writeReflection = (book) => {\n', "  const writeReflection = (book) => {\n    setMode('diary');\n");
    assert.notEqual(swapped, reader, '替换没生效，反向对照是假绿');
    assert.equal(intentRecordedBeforeSwitch(swapped), false, '先切视图居然还判绿 —— 判据没牙');
  });

  it('DiaryApp 用 intent 初始化模块，并直接打开那本书（不等书单）', () => {
    assert.match(diary, /DIARY_MODULES\.some\(\(item\) => item\.value === intent\?\.module\)/,
      '模块初值没认 intent（传错值也直接赋值的话 mod 会是 undefined，下面 mod.kind 当场炸）');
    assert.match(diary, /\}, \[intent\?\.bookId\]\)/, '那条 effect 的依赖不是原始值 ⇒ 每次渲染都多读一轮盘');
    // ★ 直接拼一个最小 book 对象：书架会被 BOOKS_PAGE_LIMIT 截断，截断之外的书
    //   在书单里根本找不到，但 `/book/:id` 照样读得到。
    assert.match(diary, /void openBook\(\{ id: intent\.bookId,/,
      '没有直接用 intent 的 id 打开 —— 书被截断时点了没反应');
  });
});

describe('书籍档案卡：五个数，全部来自已有计量', () => {
  it('卡片在，五格都在', () => {
    assert.match(diary, /className="npr-diary-dossier"/);
    assert.equal((diary.match(/npr-diary-dossier-cell/g) ?? []).length, 5, '档案卡的格数变了');
    for (const label of ['划线', '摘录笔记', '读后感', '读到']) {
      assert.ok(diary.includes(`<span>${label}</span>`), `档案卡少了「${label}」这一格`);
    }
  });

  it('★ 「摘录笔记」只数写过 note 的划线（不能拿划线数冒充）', () => {
    assert.equal(countsOnlyAnnotatedNotes(diary), true,
      'noteCount 没按 note 过滤 —— 「划线 12」会被读成「写了 12 条笔记」');
  });

  it('★ 反向对照：把 noteCount 换成全部划线，判据必须变红', () => {
    const old = diary.replace(
      /const noteCount = annotations\.items\.filter\(\(item\) => String\(item\.note \?\? ''\)\.trim\(\) !== ''\)\.length;/,
      'const noteCount = annotations.items.length;',
    );
    assert.notEqual(old, diary, '替换没生效，反向对照是假绿');
    assert.equal(countsOnlyAnnotatedNotes(old), false);
  });

  it('「读到」用的是书架已有的进度，取不到就写「未开始」而不是 0', () => {
    assert.match(diary, /fetchStates\(\)/, '没取阅读进度');
    assert.match(diary, /const readLabel = bookStates\[book\?\.id\]\?\.pages/, '读到那一格没有兜底');
    assert.match(diary, /: '未开始';/, '取不到进度时没有兜底文案（会显示成 0 / 0）');
  });
});

// ---------------------------------------------------------------------------
// 灵感流转：在书里按 `L`，自动挂到「这本书 · 这一章」
//
// ★ 这一条的三段链路任何一段断了，症状都一样：**灵感照常记下，只是没挂上书**。
//   用户要过很久才会发现「按书反查」里少了一堆，而那时已经没法补。
//   所以三段各自钉一条：
//     ① 阅读器 → 外层：报「当前第几章」（章节只有阅读器算得出来）；
//     ② 外层 → 浮层：`context` 一路传下去，离开书架要**清空**；
//     ③ 浮层 → 请求：`meta.book / chapter / page` + 一行「会记到哪儿」的纯文本。
// ---------------------------------------------------------------------------

describe('灵感流转：按 L 时自动带上正在读的书与章节', () => {
  it('① 两个阅读器都上报当前章节（章节只有它们算得出来）', () => {
    assert.match(bookReader, /onChapter\?\.\(chapterAt\(digestOutline, page\)\)/,
      'PDF 阅读器没报章节 —— 在 PDF 里记的灵感挂不上书');
    assert.match(bookEbook, /onChapter\?\.\(index === null \? null : \{ n: page, title: chapterTitle \}\)/,
      '电子书阅读器没报章节');
    // ★ PDF 那条必须依赖 `digestOutline`：目录是异步读回来的，只依赖 page 的话
    //   「打开书、还没翻页就按 L」会拿到 null —— 而那正是最常见的时机。
    assert.match(bookReader, /\}, \[digestOutline, page, onChapter\]\)/,
      'PDF 那条 effect 没盯目录 —— 目录晚到时章节会一直是 null');
  });

  it('② 书架把上下文往上报，并在**离开时清空**', () => {
    assert.equal((library.match(/onChapter=\{setChapter\}/g) ?? []).length, 2,
      'PDF 与电子书没有同时接上 onChapter');
    assert.match(library, /onReadingContext\?\.\(\{\s*\n\s*bookId: selected\.id,/,
      '书架没把「正在读哪本书」报出去');
    assert.match(library, /page: Number\.isInteger\(state\.page\) \? state\.page : 1,/,
      '上报里没有页码（章节会随版本变，页码不会，两个都要记）');
    // ★ 不清空的后果：在书里记一条 → 切回订阅读文章 → 再按 L，
    //   那条灵感会被挂到上一本书上，而界面上没有任何提示。
    assert.match(library, /useEffect\(\(\) => \(\) => onReadingContext\?\.\(null\), \[onReadingContext\]\)/,
      '离开书架时没清空上下文 —— 之后在订阅页记的灵感会被挂到上一本书上');
    assert.match(reader, /onReadingContext=\{setReadingCtx\}/, 'ReaderPage 没接上书架上报的上下文');
  });

  it('② 浮层在书架与订阅两处都拿上下文（书 → 书名号，文章 → 标题）', () => {
    // ★ 0.38 改的是**这一条本身**：0.37 及以前写的是 `mode === 'library' ? readingCtx : null`，
    //   于是订阅页按 L 记的灵感连来源都没有。用户 2026-10-27 问「那如果是在阅读 RSS 时
    //   创建的灵感怎么办？挂在书上的意义？」—— 意义是回到现场，与「是不是书」无关。
    assert.match(reader, /mode === 'library' \? readingCtx : \(activeArticle\?\.article \? \{/,
      '订阅页仍然不带上下文 —— 那篇文章名丢了，日记里回不去');
    assert.match(reader, /articleKey: activeArticle\.article\.key,/, '没带上文章的 key');
    // 书那边不能被顺手删掉（同一个三元的两支）。
    assert.match(reader, /context=\{mode === 'library' \? readingCtx :/,
      '书架那一支被改坏了');
  });

  it('③ 浮层把书 / 章 / 页 / 文章写进 meta，并把「会记到哪儿」说出来', () => {
    assert.match(quick, /const linked = context && \(context\.bookId \|\| context\.articleKey\) \? context : null;/,
      '没有从 context 取关联（书和文章都要算）');
    assert.match(quick, /meta\.book = linked\.bookId;/, 'meta.book 没写');
    assert.match(quick, /meta\.chapter = linked\.chapter\.n;/, 'meta.chapter 没写');
    assert.match(quick, /meta\.page = linked\.page;/, 'meta.page 没写');
    assert.match(quick, /meta\.article = linked\.articleKey;/, 'meta.article 没写 —— 文章的灵感没有出处');
    // 关联必须**看得见**，但它是一行纯文本（不是控件，见上一条 describe）。
    assert.match(quick, /\{linked && <p className="npr-quick-link">会记到 \{where\}<\/p>\}/,
      '「会记到哪儿」那行没了 —— 关联变成悄悄发生的');
    // ★ 书名号**不能无条件套**：书源标题本身就带《》（`《译文名著文库》 076[法]雨果…`），
    //   再套一层会存成 `《《译文名著文库》 076…》` —— 用户 2026-10-27 的截图就是它，
    //   侧栏还会因为「按第一个 》 截断」显示成畸形的 `《《译文名著文库》》。
    assert.match(quick, /bookTitle\.includes\('《'\) \? bookTitle : `《\$\{bookTitle\}》`/,
      '书名号又无条件套了一层 —— 书源带《》的书名会被套成双书名号');
  });

  it('★ 反向对照：删掉 meta.book 那一行，判据必须变红', () => {
    const old = quick.replace('        meta.book = linked.bookId;\n', '');
    assert.notEqual(old, quick, '替换没生效，反向对照是假绿');
    assert.doesNotMatch(old, /meta\.book = linked\.bookId;/);
  });

  it('★ 没有阅读上下文时不写 meta.book（不能凭空挂书）', () => {
    // 守卫的形状就是「`linked` 为假时整个 meta 是空对象」——如果哪天有人把
    // `meta.book` 挪到 `if (linked)` 外面，订阅页记的灵感也会被挂上一个空 id。
    assert.match(quick, /if \(linked\) \{[\s\S]{0,200}?if \(linked\.bookId\) \{\n\s*meta\.book = linked\.bookId;/,
      'meta 的写入不在 `if (linked)` / `if (linked.bookId)` 里 —— 没有上下文时会写出一个空的书 id');
  });
});

// ---------------------------------------------------------------------------
// 读后感门禁：只有**标记为读完**的书才可以写
//
// ★ 用户 2026-10-27：「这一步分一个非常重要的已经标记为读完的书，只有读完的书才可以
//   写读后感」。这条规则有三条**静默失效**的路，各自都不会报错：
//     ① 判据默认值写反（`?? 'read'`）⇒ 所有书都能写，界面上看不出任何异常；
//     ② 只挡侧栏不挡 `openBook` ⇒ 从阅读器点「写读后感」进来照样能写；
//     ③ 挡住了输入框却没说为什么 ⇒ 用户以为功能坏了。
//   三条各钉一条断言。
// ---------------------------------------------------------------------------

/** ① 的判据：认不出的 id 一律按**未读完**（宁可挡住，不可放行）。 */
function defaultBlocksUnread(code) {
  return /const stateNameOf = \(id\) => \(bookStates\[id\]\?\.state \?\? 'unread'\)/.test(code);
}

describe('读后感门禁：只对读完（过）的书开放', () => {
  it('★ 判据的默认值是 unread，不是 read', () => {
    assert.equal(defaultBlocksUnread(diary), true,
      '认不出的书按「已读完」处理 —— 门禁等于没有');
  });

  it('★ 反向对照：把默认值改成 read，判据必须变红', () => {
    const old = diary.replace("bookStates[id]?.state ?? 'unread'", "bookStates[id]?.state ?? 'read'");
    assert.notEqual(old, diary, '替换没生效，反向对照是假绿');
    assert.equal(defaultBlocksUnread(old), false);
  });

  it('★ 侧栏只列读完（过）的书 —— 未读完的不再摊一屏', () => {
    // 用户 2026-10-27：「读后感只显示标记完成的书，不显示未读完的书」。
    // 0.32.0 把 2636 本「还没读完」全部铺在侧栏里，真正要用的那 1 本被挤到最上面一行。
    // ★ 0.44.3 起判据是 `finishedOf`（= `library.js` 的 `hasFinished`），不是
    //   `stateOf(id) === 'read'`：用户点「重新阅读」之后书不能从这份名单里消失。
    assert.match(diary, /const readBooks = filteredBooks\.filter\(\(item\) => finishedOf\(item\.id\)\)/,
      '侧栏的取向又变回「此刻状态是读完」了 —— 点了「重新阅读」，读后感会当场少一本');
    assert.doesNotMatch(diary, /stateOf\(item\.id\) === 'read'/, '侧栏还在按 state 判，而不是按「读完过」判');
    assert.doesNotMatch(diary, /const unreadBooks/, '未读完的那一组还在算');
    assert.ok(!diary.includes('还没读完<span'), '侧栏还在渲染「还没读完」那一块的分组标题');
    assert.ok(!diary.includes('>未读完<'), '侧栏还在把「未读完」当状态胶囊画出来');
  });

  it('★ 「读完过」的判据只有一份（library.js 的 hasFinished），这里是调用不是重写', () => {
    // 两处各写一遍「算不算读完过」，迟早有一处漏掉 finishedAt —— 而症状是
    // 「列表里有这本书、点进去却说没读完」。所以判据必须是 import 进来的。
    assert.match(diary, /import \{[^}]*hasFinished[^}]*\} from '\.\.\/library\.js'/,
      'DiaryApp 没从 library.js 引 hasFinished —— 判据被复制成了两份');
    assert.match(diary, /const finishedOf = \(id\) => hasFinished\(bookStates\[id\]\);/,
      'finishedOf 没走共用判据');
  });

  it('★ `openBook` 自己也判一次（从阅读页进来不经过侧栏那道 UI 闸）', () => {
    assert.match(diary, /const finished = finishedOf\(target\.id\);/,
      'openBook 没判读完状态 —— 外面点「写读后感」能绕过侧栏');
    assert.match(diary, /readable: finished/,
      'openBook 把「读完过」又写回了 `state === \'read\'`');
  });

  it('★ 书没读完时不画输入框，而是说清楚为什么', () => {
    // 0.36 起写入口被提到固定的 `.npr-diary-dock` 里，判据从此压在这一层上：
    // `book && book.readable && (...)`。守的仍然是同一件事 —— 没读完不给写。
    assert.match(diary, /moduleValue === 'reflection' && book && book\.readable && \(/,
      '输入框没有受 readable 控制');
    assert.match(diary, /npr-diary-blocked/, '没读完时没有说明块 —— 用户会以为功能坏了');
    assert.match(diary, /还没标记读完/, '说明里没点明原因');
  });

  it('★ 阅读器顶部**没有**「写读后感」入口（0.44.3 搬到「读完」那一行）', () => {
    // 用户 2026-10-28：「头部菜单条不应该有『写读后感』按钮入口……入口应该是写在
    // 读完列表下」。这里钉的是「不许回来」：两个阅读器的源码里都不许再出现这颗按钮。
    for (const [name, code] of [['BookReader', bookReader], ['BookEbook', bookEbook]]) {
      assert.doesNotMatch(code, /<span>写读后感<\/span>/, `${name} 顶部又把「写读后感」按钮加回来了`);
      assert.doesNotMatch(code, /onWriteReflection/, `${name} 还挂着 onWriteReflection（按钮删了，转交也该删）`);
    }
  });
});

// ---------------------------------------------------------------------------
// 私密侧栏：只数私密
//
// ★ 用户 2026-10-27：「私密日记本侧边栏为什么还显示灵感的记录条数」。
//   `listMonth` 以前把公开与私密加成一个 `days`，私密日历于是跟着灵感一起亮。
// ---------------------------------------------------------------------------

describe('私密侧栏：只数私密，不混灵感的条数', () => {
  it('★ 日历与「这个月」都吃 privateDays，不吃合计的 days', () => {
    assert.match(diary, /const privateDays = marks\.privateDays \?\? \{\}/, '没有单独取私密的计数');
    assert.match(diary, /marks=\{privateDays\}/,
      '日历还在吃合计的 days —— 灵感会让私密日历上的点亮起来');
    assert.match(diary, /Object\.entries\(privateDays\)/, '「这个月」那一列还在吃合计');
    assert.doesNotMatch(diary, /marks=\{marks\.days\}/, '合计的 days 又被塞回日历了');
  });

  it('★ 情绪点来自 marks.moods 的 private 那一半', () => {
    // 一半对一半错是最糟的形态：日历上「写了」和「心情」来自两个不同的集合，
    // 会出现「有点、但点了没反应」或者「有心情、但没有点」。
    assert.match(diary, /cell\?\.private/, '情绪点没有按 private 取');
    assert.match(diary, /tones=\{privateTones\}/, '日历没收到情绪色');
  });
});

// ---------------------------------------------------------------------------
// 0.33：用户 2026-10-27 的六条真机反馈里，三条是「**不报错但坏掉了**」
//
//   ① 「AI 整理这一天功能失效」—— 错误只写在伴读面板内部，而面板要成功打开才会出现，
//      于是失败时界面一片安静，看起来像按钮没接上。
//   ② 「我一点击内容条它就消失」—— `jump()` 里顺手把搜索框关了，导航与检索互相打断。
//   ③ 「撰写的日记显示不能是明文」—— 私密条目直接 `dangerouslySetInnerHTML`，
//      加密只保护了**盘上的文件**，屏幕上是明文。
// ---------------------------------------------------------------------------

describe('私密日记：口令闸门，而不是屏幕遮罩', () => {
  /*
   * ★ 0.33 这一组守的是「默认遮罩、点一下显示」。用户 2026-10-27 一句话否掉了它：
   *   「私密日记点击就能查看还有什么私密，一定是只能本人查看啊。」
   *   遮罩只挡眼睛：正文照样在 DOM 里，点一下就开，谁坐在这台机器前都能看。
   *   0.34 改成**宿主侧的闸门**（`/gate`）：锁着时 `/day` 返回的私密条目 body 是
   *   空串，界面想看也没有东西可渲染。这里守的是界面那一半的契约。
   */
  it('★ 锁着时不渲染写入口，也不渲染条目', () => {
    // 写入口的守卫必须带 `gate.unlocked`：给一个「能写、但看不到自己昨天写了什么」
    // 的框，是在骗人。
    assert.match(diary, /moduleValue === 'private' && \(gate\.available === false \|\| gate\.unlocked\)/,
      '私密写入口没有上锁判据');
    // 锁着时画的是解锁卡，且解锁卡本身**不含**写入口。
    const gateCard = /moduleValue === 'private' && gate\.available !== false && !gate\.unlocked/.test(diary);
    assert.ok(gateCard, '没有解锁卡');
    assert.match(diary, /npr-gate-form/, '解锁卡里没有输入框');
  });

  it('★ 口令交给宿主校验，不是前端比一下', () => {
    // 判据：调用的是 `/gate` 的三个动作，而不是在本地比较某个常量。
    assert.match(diary, /await unlockDiaryGate\(text\)/, '解锁没有走宿主');
    assert.match(diary, /await setupDiaryGate\(text\)/, '设口令没有走宿主');
    assert.doesNotMatch(diary, /passphrase ===|=== passphrase/, '前端在自己比口令 —— 那不是权限');
  });

  it('★ 离开私密模块就上锁（锁跟着人，不跟着日期）', () => {
    assert.match(diary, /void lockDiaryGate\(\)/, '离开模块没有上锁');
    // 反向：`pick()` 里**不该**再清「已显示」那套旧状态（它已经不存在了）。
    const pick = /const pick = \(date[^)]*\) => \{([\s\S]*?)\n  \};/.exec(diary);
    assert.ok(pick, 'pick() 的锚点找不到了');
    assert.doesNotMatch(pick[1], /setRevealed/, 'pick() 还在用已删掉的 revealed 状态');
  });
});

describe('搜索框：导航不再关掉它', () => {
  it('★ `jump()` 不碰搜索状态', () => {
    // `[^)]*` 而不是 `key = ''`：签名后来加过 `opts`（回书那条兜底要留住筛选态），
    // 写成精确签名会让「签名变了」被误报成「功能坏了」。
    const body = /const jump = \(date[^)]*\) => \{([\s\S]*?)\n  \};/.exec(diary);
    assert.ok(body, 'jump() 的锚点找不到了');
    assert.doesNotMatch(body[1], /setSearch/, 'jump() 又把搜索框关了 —— 点一条内容它就消失');
  });

  it('★ 反向对照：把 `setSearch` 塞回 jump，判据必须变红', () => {
    const broken = diary.replace(
      /(const jump = \(date[^)]*\) => \{\n)/,
      "$1    setSearch((current) => ({ ...current, open: false }));\n",
    );
    const body = /const jump = \(date[^)]*\) => \{([\s\S]*?)\n  \};/.exec(broken);
    assert.match(body[1], /setSearch/, '反向对照没生效，这条判据是假绿');
  });
});

describe('AI 整理：失败必须在**面板之外**可见', () => {
  it('★ 错误渲染在正文区，而不是只在伴读面板里', () => {
    assert.match(diary, /const \[aiError, setAiError\]/, '没有独立的失败状态');
    const alert = diary.indexOf('npr-diary-alert"');
    const companion = diary.indexOf('className="npr-companion');
    assert.ok(alert > 0, '没有失败横幅');
    assert.ok(companion > 0, '伴读面板的锚点找不到了');
    assert.ok(alert < companion, '失败横幅在伴读面板之后 —— 面板没打开时它也不会渲染');
  });

  it('★ 打开失败要同时写横幅与面板，且释放半成品会话', () => {
    // 0.34 把「整天 / 单篇」合成同一个 `openAiPanel(entry)`，所以这里只剩**一条**
    // 建会话的路径 —— 两条路径各写一份 `setAiError` 的旧判据反而会鼓励复制粘贴。
    assert.equal((diary.match(/setAiError\(message\)/g) ?? []).length, 1,
      '打开失败没有上报原因');
    assert.equal((diary.match(/acquired\?\.release\?\.\(\)/g) ?? []).length, 1,
      '失败后没有释放半成品会话');
    // 面板必须**先开再建对话**：否则失败时它压根不渲染，错误就没地方显示。
    assert.match(diary, /\{aiOpen && \(/, '面板还是绑在 chat 上 —— 建会话失败时它是隐形的');
  });
});

describe('灵感模块：没有情绪追踪', () => {
  it('★ 灵感写入口不含 MoodRow，私密写入口仍然有', () => {
    assert.equal((diary.match(/<MoodRow /g) ?? []).length, 1,
      '情绪行挂了不止一处 —— 灵感模块不该有情绪追踪');
    const guard = /moduleValue === 'private'[\s\S]{0,600}?<MoodRow /.test(diary);
    assert.ok(guard, '剩下的那一处不在私密模块里');
  });

  it('★ 灵感保存时不带 mood（否则会继承私密里选过的心情）', () => {
    assert.match(diary, /const meta = moduleValue === 'private' && mood \? \{ mood \} : \{\}/,
      '保存时无条件带 mood —— 灵感条目会悄悄带上用户没选过的心情');
  });
});

/**
 * 0.35.0 的三处「用户看图指出来的事」，逐条钉住。
 *
 * ★ 这三条都不是「样式好不好看」：每一条背后都有一个**会静默发生**的坏结果 ——
 *   标签多了看不见、私密正文渲染进 DOM、读后感空页没有落点。
 */
describe('0.35：标签扩展性 / 私密逐条查看 / 读后感空状态', () => {
  const composer = () => read('DiaryComposer.jsx');

  it('★ 标签：侧栏只铺固定几个，全量走浮层（268px 装不下几千个）', () => {
    // 用户 2026-10-27 第三次问「几千个标签怎么办」。0.35 的答案是「内联筛选 + 展开 300」，
    // 那是往侧栏里塞更多东西 —— 而侧栏在任何阈值下都装不下几千个。
    assert.match(diary, /const TAG_SIDE = 6/, '侧栏内联上限不见了');
    assert.match(diary, /const tagSide = tagIndex\.tags\.slice\(0, TAG_SIDE\)/,
      '侧栏没有按 TAG_SIDE 截断 —— 又会把整栏铺满');
    // 浮层里的过滤必须作用在**全部**标签上，不是侧栏已经截断的那几个。
    assert.match(diary, /tagIndex\.tags\.filter\(/, '浮层过滤没有作用在全部标签上');
    assert.match(diary, /const tagSheetMatched = tagSheetNeedle === ''/, '浮层没有「先过滤」这一步');
    assert.match(diary, /全部 \{tagIndex\.tags\.length\} 个/, '没有打开全量的入口');
    assert.match(diary, /className="npr-tagsheet"/, '浮层没有渲染');
  });

  it('★ 标签：浮层不悄悄截断，且入口只在标签真的超出时才出现', () => {
    assert.match(diary, /还有 \{tagSheetHidden\} 个没铺开/, '截断后没有说还有多少 —— 用户会以为标签丢了');
    assert.match(diary, /tagIndex\.tags\.length > TAG_SIDE && \(\s*<button type="button" className="npr-diary-tagmore"/,
      '入口的出现条件不对（标签只有 4 个时也挂一个「全部 4 个」是噪音）');
    // 搜索命中时不受 TAG_SHEET_MAX 约束：搜到了却不给看，比不搜更糟。
    assert.match(diary, /tagSheetNeedle === ''\s*\?\s*tagSheetMatched\.slice\(0, TAG_SHEET_MAX\)/,
      '搜索时也被截断了');
  });

  it('★ 私密：解锁之后仍然**逐条点开**才明文（DOM 里不能有正文）', () => {
    // 用户 2026-10-27：「即使输入口令解锁后，展示在面板上的日记应该还不是明码，
    // 点击查看才可以明码，查看完就又不是明码。」
    assert.match(diary, /const veiled = privateSide && !empty && peek !== key/,
      '收着的判据不见了 —— 解锁后会把整页私密日记铺成明文');
    assert.match(diary, /className="npr-diary-veil"[\s\S]{0,200}?peekEntry\(key\)/, '收着的时候没有「点开看」入口');
    // 收着时必须**不渲染**正文节点，而不是渲染了再遮住。
    // 0.36 起「摊开」那一支不再是内联的 html/纯文本二选一，而是 `<EntryBody>`。
    const veilBranch = /\{empty\s*\?[\s\S]*?: veiled\s*\?([\s\S]*?): <EntryBody/.exec(diary);
    assert.ok(veilBranch, '收着 / 展开的分支结构没找到');
    // 只允许读**长度**（「23 字」那种提示），不许把正文本身放进 DOM。
    assert.equal(veilBranch[1].includes('dangerouslySetInnerHTML'), false, '收着的分支里在渲染 HTML —— 正文已经进 DOM 了');
    assert.equal(/\{entry\.body\}/.test(veilBranch[1]), false, '收着的分支里在插 entry.body');
  });

  it('★ 私密：切模块 / 上锁 / 再点一次都会收回（不只靠计时器）', () => {
    assert.match(diary, /const PEEK_MS = 30_000/);
    assert.match(diary, /function hidePeek\(/, '没有「收起来」这个动作');
    // ★ 0.47 起这个 effect 里多了两件事（退出情绪筛选、退出来源收窄），写「hidePeek
    //   距 `[moduleValue]` 不超过 N 个字符」那种窗口判据，会被新加的注释直接挤爆
    //   （这次又踩了一遍：真绿变假红）。改成把 effect 的**函数体**切出来再断言。
    const moduleEffect = effectAt(diary, 'hidePeek()');
    assert.ok(moduleEffect, '切模块的那个 effect 没找到 —— 锚点失效');
    assert.match(moduleEffect, /hidePeek\(\);/, '切模块时没有收回 —— 看完的那条会跟着用户去别的页');
    // 来源收窄同一个道理：它是「对这个来源的一次提问」，换模块不该还留着。
    assert.match(moduleEffect, /setSourceScope\(null\);/, '切模块时没有退出来源收窄 —— 横条会跟着用户去别的页');
    // 窗口给到 400：`lockNow` 开头有一个 try/catch，第一个 `}` 落在 catch 里，
    // 用 300 字符 + 首个右括号会把 `hidePeek()` 挡在窗口外（写这条时踩过一次）。
    assert.match(diary, /async function lockNow\(\)[\s\S]{0,400}?hidePeek\(\)/, '上锁时没有收回');
  });

  it('★ 读后感空状态与「阅读」那一页同一套版式（不是三行说明文字）', () => {
    assert.match(diary, /<div className="npr-welcome">/, '空状态没用 welcome 版式');
    assert.match(diary, /NPIE REFLECTION/);
    // 版式必须**在读后感模块里**，不能顺手加到别的模块的空状态上。
    const block = /moduleValue === 'reflection'[\s\S]{0,4000}?NPIE REFLECTION/.test(diary);
    assert.ok(block, 'welcome 版式不在读后感模块里');
    // 只判**空状态那一段**：`先在左边选一本书` 作为保存时的报错文案还在（那是另一处，合理）。
    assert.equal(diary.includes('<p>先在左边选一本书。</p>'), false, '旧的三行说明还在');
  });

  it('★ 编辑器是**按需下载**的第三方底座，且 textarea 留着当退路', () => {
    const c = composer();
    assert.match(c, /loadDiaryEditor\(\)/, '没有接入编辑器底座');
    assert.match(c, /\.catch\(\(\) => \{[\s\S]{0,200}?setRich\(false\)/, '加载失败时没有退回 textarea');
    assert.match(c, /\{!rich && \(/, 'textarea 退路不见了 —— 编辑器一挂，日记就写不了');
    // 两个视图必须是同一份值：不能各自维护一份 state。
    assert.match(c, /onUpdate: \(markdown\) => changeRef\.current\(markdown\)/);
  });
});

/**
 * 0.36.0：用户 2026-10-27 对「灵感速记」的两条现场反馈。
 *
 * ★ 一条是 bug（时间轴点了没有标注），一条是结构问题（一天太长要滚很久）。
 *   两条都会**静默**发生 —— 不报错，只是用起来难受，所以只能靠测试钉住。
 */
describe('0.36：时间轴联动 / 一天太长 / 标签全量', () => {
  it('★ 时间轴点了某一条，右边那一条要标出来，而且不是一闪就没', () => {
    // 0.33–0.35 的判据是 `focusKey === key && privateSide`：灵感侧永远不会高亮，
    // 用户点完时间轴在正文里找不到任何标注（2026-10-27 的截图就是这么来的）。
    assert.match(diary, /npr-diary-entry\$\{focusKey === key \? ' is-focus' : ''\}/,
      '正文里的高亮判据不见了 —— 用户点了时间轴会找不到对应那一条');
    assert.equal(/focusKey === key && privateSide/.test(diary), false,
      '高亮又绑回私密侧了 —— 灵感模块永远不会亮');
    assert.equal(/setTimeout\(\(\) => setFocusKey\(''\)/.test(diary), false,
      '高亮还在 1.8 秒自动褪 —— 平滑滚动没落位标注就没了');
    // 侧栏那一项也要亮：两处同时亮才叫「对应」。
    assert.match(diary, /npr-diary-dayitem\$\{focusKey === entryKey\(entry\) \? ' is-focus' : ''\}/,
      '侧栏时间轴没有选中态');
  });

  it('★ 一天太长：默认只铺最近 N 条，并说清楚还藏了几条', () => {
    assert.match(diary, /const DAY_PREVIEW = 10/);
    assert.match(diary, /const entriesShown = dayAll \? listEntries : listEntries\.slice\(-DAY_PREVIEW\)/,
      '默认没有截断 —— 一天几十条就要滚八屏');
    assert.match(diary, /更早还有 \{entriesHidden\} 条/, '折叠后没有说自己藏了多少 —— 等于把记录藏起来');
    assert.match(diary, /\{entriesShown\.map\(/, '列表没改成渲染 entriesShown');
  });

  it('★ 点开被折叠的那一条时要自动展开，换天则把两个临时状态收回', () => {
    // 被折叠的条目不在 DOM 里：不先展开，`scrollIntoView` 会静默失败。
    assert.match(diary, /if \(!node\) \{\s*if \(!dayAll\) setDayAll\(true\)/,
      '点了被折叠的条目不会展开 —— 点击静默无效');
    // 窗口给到 900：pick 里有一段解释为什么换天要收回状态的注释，
    // 400 字符会在注释里就截断（写这条时踩过一次，报「pick 没找到」而不是「断言失败」）。
    const pick = /const pick = \(date[^)]*\) => \{([\s\S]{0,1200}?)\n  \};/.exec(diary);
    assert.ok(pick, 'pick 没找到');
    assert.match(pick[1], /setFocusKey\(''\)/, '换天没有清掉上一条的高亮');
    assert.match(pick[1], /setDayAll\(false\)/, '换天没收回「展开了更早的」');
    // ★ 0.47 反过来：换天**不**退出来源收窄。0.46 及之前它是个隐形字符串状态，
    //   所以只能靠 `pick()` 顺手清空兜底（用户当时抱怨「点时间轴就回不去了」）。
    //   现在它是顶上一条看得见、点得掉的横条 —— 换了天还悄悄失效，反而像横条坏了。
    assert.equal(/setLinkKey|keepLink/.test(pick[1]), false,
      '换天还在偷偷退出收窄 —— 横条会变成「有时有效有时无效」');
    assert.match(diary, /aria-label="回到全部灵感"[\s\S]{0,200}?setSourceScope\(null\)/,
      '收窄没有显式出口 —— 那就只能靠「换天偷偷失效」兜底，用户会觉得横条坏了');
  });
});

// ---------------------------------------------------------------------------
// 0.37：写作区固定 / 三行截断 / AI 面板可拖
//
// ★ 三条反馈的共同点：**都不是「少个按钮」，是布局结构不对**
//   ① 写入口和记录挤在同一个滚动容器里 ⇒ 翻下去就没了输入框；
//   ② 一条长记录整段摊开 ⇒ 一屏只剩两三条，用户说的「要滚动好久」；
//   ③ 日记页的 AI 面板宽度写死 ⇒ 同一套面板在阅读页能拖、在这里不能。
//   结构一旦回退，界面上不会报错，只会「用起来很难受」，所以必须钉住。
// ---------------------------------------------------------------------------

const diaryCss = read('refinements.css');

describe('0.37：写入口固定 / 每条三行 / AI 面板可拖', () => {
  it('★ 写入口在固定的 dock 里，不在滚动区里', () => {
    // 顺序即结构：dock 必须先出现，scroll 在它后面 —— 反过来就是「dock 在滚动区里面」。
    const dockAt = diary.indexOf('<div className="npr-diary-dock">');
    const scrollAt = diary.indexOf('<div className="npr-diary-scroll">', dockAt);
    assert.ok(dockAt > 0, '没有 dock —— 写入口还和记录挤在同一个滚动容器里');
    assert.ok(scrollAt > dockAt, 'dock 不在滚动区之前（写入口还是会被滚走）');
    // 写作区必须落在 dock 与 scroll 之间这一段里。
    const between = diary.slice(dockAt, scrollAt);
    assert.match(between, /<DiaryComposer/, 'dock 里没有写入口');
    assert.match(diaryCss, /\.npr-diary-dock \{[^}]*flex: 0 0 auto/, 'dock 会被 flex 拉伸/压缩');
    assert.match(diaryCss, /\.npr-diary-dock \{[^}]*background: var\(--npr-bg\)/,
      'dock 没有底色 —— 记录会从它下面透出来');
  });

  it('★ dock 与滚动区各带一份 sheet（宽度约束不能一边有一边没有）', () => {
    const dockAt = diary.indexOf('<div className="npr-diary-dock">');
    const scrollAt = diary.indexOf('<div className="npr-diary-scroll">', dockAt);
    assert.match(diary.slice(dockAt, scrollAt), /<div className="npr-diary-sheet">/,
      'dock 里没有 sheet —— 600px 的宽度约束只作用在滚动区，上下两块左边缘会差几像素');
    assert.match(diary.slice(scrollAt, scrollAt + 400), /<div className="npr-diary-sheet">/,
      '滚动区里没有 sheet');
  });

  it('★ 每条最多三行，靠排版结果截而不是数字数', () => {
    assert.match(diaryCss, /-webkit-line-clamp: 3/, '没有三行截断');
    assert.match(diary, /className=\{`npr-diary-body npr-diary-clamp\$\{html \? '' : ' npr-diary-body-plain'\}`\}/,
      '正文没用 clamp 容器');
    // 「要不要给展开按钮」必须量出来：宽度可拖，字数换算不准。
    assert.match(diary, /node\.scrollHeight - node\.clientHeight > 1/, '展开按钮没有按实际溢出判断');
    assert.match(diary, /new ResizeObserver\(measure\)/, '拖窗口/拖侧栏后不会重新量 —— 按钮会残留');
    assert.match(diary, /\{over && \(/, '没有 overflow 判据就直接给了按钮（每条都会有「展开全文」）');
  });

  it('★ 展开是**窗口**，不是把这一条就地拉长', () => {
    assert.match(diary, /className="npr-diary-modal"/, '展开没有独立的阅读窗');
    assert.match(diary, /role="dialog" aria-modal="true" aria-label="完整这一条"/, '阅读窗没有对话框语义');
    assert.match(diaryCss, /\.npr-diary-modal-body \{[^}]*overflow: auto/, '窗口正文不能自己滚 —— 长文会撑破卡片');
    // 窗口里的正文**不能**再被 clamp，否则「看全文」还是三行。
    assert.match(diary, /npr-diary-modal-body[\s\S]{0,400}?dangerouslySetInnerHTML/, '窗口里没有渲染正文');
    assert.equal(/npr-diary-modal-body[\s\S]{0,300}?npr-diary-clamp/.test(diary), false,
      '窗口里的正文也被 clamp 了 —— 展开之后还是三行');
    // Esc 是唯一的另一条出口（它盖住了整块正文）。
    assert.match(diary, /\}, \[expand\]\);/, '阅读窗没有 Esc / 状态收回的 effect');
  });

  it('★ 私密：「展开全文」不能成为绕过逐条点开的第二条路', () => {
    // 上锁 / 超时必须连窗口一起关掉，否则收起了正文、窗口里还摊着全文。
    assert.match(diary, /function hidePeek\(\)[\s\S]{0,300}?setExpand\(null\)/,
      '收起私密正文时没有关掉阅读窗 —— 那是个后门');
    assert.match(diary, /peekTimer\.current = setTimeout\(\(\) => \{[\s\S]{0,120}?setExpand\(null\)/,
      '30 秒超时只收了正文，窗口里还是明文');
  });

  it('★ AI 面板宽度可拖，且与阅读页共用同一个偏好', () => {
    assert.match(diary, /className="npr-companion-divider"/, '日记页的 AI 面板没有分隔条');
    assert.match(diary, /localStorage\.getItem\('npr\.companionWidth'\)/, '没有读取已存的宽度');
    assert.match(diary, /localStorage\.setItem\('npr\.companionWidth'/, '拖完没有存 —— 下次打开又回去了');
    assert.match(diary, /--npr-companion-width/, '没把宽度变量挂到 workarea 上');
    // `has-companion` 必须跟着**面板打开**，不能等对话建好：否则点了没反应、也拖不了。
    assert.match(diary, /aiOpen \|\| chat \? ' has-companion' : ''/, '面板打开后正文没有让位');
    // 窄容器下 workarea 变纵向，分隔条要跟着改方向。
    assert.match(diary, /getComputedStyle\(area\)\.flexDirection === 'column'/,
      '分隔条写死了横向 —— 窄容器里会拖不动');
  });
});

// ---------------------------------------------------------------------------
// 0.38：漏在界面上的 `)}` / 提示词不换行 / 一开面板就收起侧栏 / 挂在书上点了不对应
//
// ★ 这一轮四条里有三条是**上一轮自己造成的**，所以每一条都配一条结构判据：
//   ① 删代码时把 `{hasDock && (` 一起吃掉，`)}` 变成文本渲染在界面上；
//   ② 面板一开就 `display: none` 收掉导航（用户：「为什么打开 AI 整理左侧边栏就关闭了呢」）；
//   ③ 点一行书名只 `jump(日期)`，列表不跟着收窄。
//   这三件事都不会报错，只会「用起来不对」，所以只能靠结构钉住。
// ---------------------------------------------------------------------------

describe('0.38：写作坞的闸 / 提示词换行 / 侧栏保留 / 来源筛选', () => {
  it('★ `hasDock` 必须真的被用来包住写作坞（不是声明了却没人用）', () => {
    // 声明了不用的后果就是 0.37 那个 bug：dock 无条件渲染，读后感「还没选书」时
    // 顶上一条空白的 24px 带 + 一条边线，看起来像加载失败。
    assert.match(diary, /\{hasDock && \(\s*\n\s*<div className="npr-diary-dock">/,
      '写作坞没有被 hasDock 包住 —— 而 `hasDock` 又声明着，正是 0.37 漏掉 `)}` 的现场');
    // 闸的三个分支都要在（灵感恒有 / 私密解锁 / 读后感选到读完的书）。
    assert.match(diary, /const hasDock = moduleValue === 'inspiration'/, 'hasDock 的判据不见了');
  });

  it('★ AI 面板打开时**不收侧栏**，改成给正文一个下限', () => {
    assert.doesNotMatch(diaryCss, /has-companion[^{]*\{[^}]*\.npr-diary-nav[^}]*display: none/,
      '侧栏又被收起来了 —— 用户 2026-10-27 明确问「为什么打开 AI 整理左侧边栏就关闭了呢」');
    assert.equal(/has-companion > \.npr-layout\.npr-diary-layout > \.npr-diary-nav,\s*\n?\s*\.npr-workarea\.has-companion > \.npr-layout\.npr-diary-layout > \.npr-resize \{ display: none; \}/.test(diaryCss),
      false, '那对「收起导航 + 收起拖动条」的规则还在');
    /*
     * 新的做法：面板宽度上限按「总宽 − 导航 − 480」算。
     * ★ 0.44.1 从 340 改成 480：340 是「正文区」的保留量，而 0.44.1 给正文列
     *   （`.npr-diary-flow`）加了 320px 下限之后，340 − 320 只剩 20px 给划线栏 ——
     *   一条 20px 的缝看起来就是渲染坏了。480 = 正文列 320 + 划线栏至少 160。
     */
    assert.match(diaryCss, /--npr-companion-width, 44%\), calc\(100% - var\(--npr-list-width, 268px\) - 480px\)/,
      '面板没有留出正文的下限 —— 拖宽之后正文会被压成一条缝');
    // 正文列自己也得有下限，否则面板再窄一点它就吸收全部挤压（0.44.1 的真 bug）。
    assert.match(diaryCss, /\.npr-diary-flow \{[^}]*min-width: min\(320px, 100%\)/,
      '正文列没有下限 —— AI 面板一开，正文会被压成一个字一行');
    // 划线栏必须可以让位：`flex: 0 0 auto` + `width` 一个像素都不让。
    assert.match(diaryCss, /\.npr-diary-marks \{[^}]*flex: 0 1 300px[^}]*min-width: 0/,
      '划线栏还在「绝不让位」—— 挤压全落到正文头上');
    // 拖动时也必须扣掉侧栏，否则手柄算出来的上限和 CSS 不是一回事（会出现拖不动的死区）。
    assert.match(diary, /querySelector\('\.npr-diary-nav'\)\?\.getBoundingClientRect\(\)\.width/,
      '拖动没扣侧栏宽度 —— 面板会吃掉导航的位置');
    assert.match(diary, /const room = Math\.max\(0, total - nav\);/, '没有把「减去导航」这一步算出来');
    /*
     * ★ 480 在 CSS 与 JS 各写一次，注释里写着「必须同源」。这里把它钉成断言：
     *   只改一处的话，拖到底会先被 CSS 卡住、而手柄还在跟着指针走（拖不动的死区）。
     */
    assert.match(diary, /const READER_FLOOR = 480;/, '拖动那边的保留量不是 480 —— 与 CSS 不同源，会出现死区');
    assert.match(diary, /Math\.min\(span, room - READER_FLOOR\)/, '拖动没有用 READER_FLOOR 去扣');
  });

  it('★ AI 面板里的快捷提示词换行，不横滚', () => {
    // 用户 2026-10-27：「ai整理的提示prompt没有自适应」——最后一条被面板右边缘切掉，
    // 而滚动条被 `scrollbar-width: none` 藏着：能滚，但看不出来等于没有。
    assert.match(diaryCss, /\.npr-diary-companion \.npr-companion-prompt-scroll \{[^}]*flex-wrap: wrap/,
      '提示词条还是横滚 —— 窄面板下最后一条被切掉');
    assert.match(diaryCss, /\.npr-diary-companion \.npr-companion-prompt-scroll \{[^}]*overflow-x: visible/,
      '还在 `overflow-x: auto` 里 —— 换行 + 横滚会互相抵消');
    // ★ 只改日记页：伴读那边一长串提示词横滚是刻意的，换行会顶掉半屏输入框。
    //   判据必须**锚在行首**（`\n`）：不锚的话 `.npr-diary-companion .npr-companion-
    //   prompt-scroll` 自己会被这条反向断言当成「别人也被改了」，永远是假红。
    assert.equal(/\n\.npr-companion-prompt-scroll \{[^}]*flex-wrap: wrap/.test(diaryCss), false,
      '把伴读那边的横滚也一起改掉了 —— 那是另一个页面的既定行为');
  });

  it('★ 右侧「只显示这一个来源」跟着收窄走，不另存一份状态', () => {
    // ★ 0.47：`linkKey` 不再是用户点出来的，而是从 `sourceScope` **派生**的。
    //   两处各存一份（一个选中的书 + 一个筛选键）迟早对不上 —— 横条关掉了、
    //   右侧还筛着某本书，就变成「一整天只剩 2 条」这种没人能解释的假象。
    assert.match(diary, /const linkKey = sourceScope === null \? '' : sourceScope\.label;/,
      '来源筛选键没有从收窄派生 —— 横条与右侧会各说各的');
    assert.equal(diary.includes('setLinkKey'), false, '还在单独维护一个筛选键');
    assert.match(diary, /const listEntries = linkKey === ''[\s\S]{0,200}?sourceKey\(entry\.source\) === linkKey/,
      '列表没有被筛选（收窄了却还铺一整天）');
    // 顶栏那条「7 条」说的是这一天的总量，不能跟着筛 —— 否则会以为记录变少了。
    assert.match(diary, /`\$\{visibleEntries\.length\} 条`/, '顶栏的条数被筛选影响了');
    // 空态要说清「为什么这里是空的」，并指向横条右端的 ✕（唯一出口）。
    assert.match(diary, /这一天没有记自这个来源的灵感。/, '收窄后的空态没说清原因');
    // ★ 来源归一仍是**一个**函数：收窄时拿它比，写入侧（`QuickCapture`）也拿它比。
    assert.match(diary, /function sourceKey\(source\) \{/, '没有来源归一（收窄后没法比）');
    assert.match(diary, /parseSource\(source\)\?\.label/, '来源键没有走统一解析 —— 会和写入侧漂开');
  });
});

/**
 * 0.39：页脚「东西在哪」必须按模块报自己的数。
 *
 * ★ 用户 2026-10-27 第二次反馈：「日记共 4 天（私密 1 天）· 5 KB 这个数据怎么还在灵感
 *   这里出现」。`stats.days` / `stats.bytes` 是公开 + 私密的**合计** —— 它在任何一个
 *   模块里印出来，都是在读灵感的人面前汇报他写过几天私密日记。
 */
describe('0.39：页脚按模块报自己的数（灵感页不该闻到私密）', () => {
  /** 切出页脚那一段 JSX —— 判据要打在**那一块**上，不是整个文件。 */
  const footBlock = (source = diary) => {
    const start = source.indexOf('<p className="npr-diary-foot">');
    assert.notEqual(start, -1, '页脚不见了 —— 这条断言的锚点失效，先修断言');
    return source.slice(start, source.indexOf('</p>', start));
  };

  it('★ 天数与字节按当前模块挑（私密用 privateDays，其余用 publicDays）', () => {
    assert.match(diary, /footDays = footPrivate \? \(stats\?\.privateDays \?\? 0\) : \(stats\?\.publicDays \?\? 0\)/,
      '页脚没有按模块挑天数 —— 又用了合计数');
    assert.match(diary, /footBytes = footPrivate \? \(stats\?\.privateBytes \?\? 0\) : \(stats\?\.publicBytes \?\? 0\)/,
      '页脚没有按模块挑字节数 —— 私密的密文又算进了灵感的 KB');
    assert.match(diary, /footWhere = footPrivate \? `\$\{stats\?\.root \?\? ''\}\/private`/,
      '私密那条没指到自己的目录');
  });

  it('★ 页脚里**一个合计数都没有**（这是「数据串联」的可执行版本）', () => {
    assert.doesNotMatch(footBlock(), /stats\./, '页脚又直接读 stats —— 合计一旦回来，灵感页就闻到私密了');
    assert.doesNotMatch(footBlock(), /（私密/, '页脚又在括号里汇报私密天数');
  });

  it('★ 反向对照：把合计数塞回页脚，上面那条必须变红', () => {
    const broken = diary.replace('{footDays} 天', '{stats.days} 天');
    assert.notEqual(broken, diary, '替换没生效，反向对照是假绿');
    assert.match(footBlock(broken), /stats\./, '合计数塞回来了居然还判绿 —— 这条判据没咬住');
  });

  it('★ 读后感仍然不挂这条页脚（0.38 那次修的，别回退）', () => {
    assert.match(diary, /moduleValue !== 'reflection' && footDays > 0/,
      '读后感又挂上了别的模块的页脚');
  });

  it('★ 「导出私密明文」跟着私密模块走，不在灵感页出现', () => {
    assert.match(diary, /\{footPrivate && gate\.unlocked && \(/,
      '导出私密明文的入口没有跟着私密模块 —— 灵感页会出现一个它不该有的按钮');
  });
});

// ---------------------------------------------------------------------------
// 0.47：不是「三个选项卡」，是**一条时间轴 + 一次收窄**
//
// ★ 用户 2026-10-29 推翻了 0.41：「左边栏不应该分三个选项卡「按时间」、「按书本」、
//   按文章。而应该只有按时间的时间轴……只是时间轴上的条目做个区分」。
//   那三档不是三个视图，是同一份数据的三种排法；而「按书本」还换掉了一整套行结构
//   （来源行 → 展开 → 条目）—— 于是同一件事有了两套排序、两套条目样式，而两排
//   长得一样的分段控件（一个换页、一个筛选）只能靠用户自己猜。
// ⇒ 现在只有一条时间轴。「这本书 / 这篇文章的全部灵感」是**换数据源、不换渲染**：
//   入口在出处卡片里，出口是顶上那条带 ✕ 的横条 —— 进与出都在你正站的地方。
// ---------------------------------------------------------------------------
describe('0.47：一条时间轴 + 出处 chip + 收窄', () => {
  it('★ 出处 chip：有出处的才画，带字、按来源取色', () => {
    // 用户 2026-10-29：「如果我直接在灵感页记录下的灵感，就没必要去往文章上挂……
    //   就不应该有这个书籍按钮显示」。判据在 `entryOrigin()`，JSX 里不写三元。
    assert.match(diary, /const origin = privateSide \? null : entryOrigin\(entry, entry\.date \?\? selected\)/,
      '出处判据没集中在 entryOrigin() 里');
    assert.match(diary, /\{origin !== null && \(/, 'chip 不是「有出处才渲染」—— 手记的灵感也会长出一颗');
    // ★ 0.46 是一颗 13px 裸图标，用户看不出那是什么。现在是图标 + 出处名。
    assert.match(diary, /<span className="npr-diary-origin-name">\{origin\.title\}<\/span>/,
      'chip 没把出处名写出来 —— 那颗图标仍然是哑的');
    assert.match(diary, /<Icon name=\{originIcon\(origin\)\} size=\{12\} \/>/,
      'chip 的图标名散在 JSX 里（三元里的字面量会被图标判据当成图标名）');
    assert.match(diary, /onClick=\{\(event\) => openOrigin\(event, origin\)\}/, 'chip 点了不开卡片');
    // 底色按来源分（书=暖褐 / 文章=品牌色）。
    assert.match(diaryCss, /\.npr-diary-origin\.is-book \{[^}]*background: color-mix\(in srgb, #b4762a 14%, transparent\)/,
      '书的 chip 没有自己的底色');
    assert.match(diaryCss, /\.npr-diary-origin\.is-article \{[^}]*background: color-mix\(in srgb, var\(--npr-accent\) 16%, transparent\)/,
      '文章和书长得一样 —— 用户分不出这条是在哪类来源里记的');
    // ★ 0.47.4：文章 chip 的文字色**必须**混前景色。用户 2026-10-29：「这个看不大清楚」。
    //   原来 `color: var(--npr-accent)` 是品牌绿 #7ddcae，压在同色系的浅绿底上对比度
    //   只有 **1.45:1**（WCAG 下限 4.5）—— 书那一支早就混了 `var(--npr-fg)`，只有文章漏了。
    //   45% 是算出来的：浅色 #48725f on #e3f3ea = 4.75:1（50% 只有 4.16，不够）。
    //   纯 accent 在源码里看着「有颜色」，在屏幕上是一团淡绿。
    assert.match(diaryCss, /\.npr-diary-origin\.is-article \{[^}]*color: color-mix\(in srgb, var\(--npr-accent\) 45%, var\(--npr-fg\)\)/,
      '文章 chip 又用纯品牌绿当文字色了 —— 浅色主题下只有 1.45:1');
    // 12px：正文区上千像素宽，11px 是照抄侧栏的尺寸，不是这里的尺寸。
    assert.match(diaryCss, /\.npr-diary-origin \{[^}]*font-size: 12px/,
      'chip 字号还停在侧栏那档（11px）');
    // ★ 但**不铺整行**：整行底色会和 `.is-focus` 的高亮叠成第三种颜色 ——
    //   来源是属性、高亮是状态，只有状态配铺满一行。
    assert.equal(/npr-diary-entry\.is-(book|article)/.test(diaryCss), false,
      '又改回「整行铺底色」了 —— 会和选中高亮叠成第三种颜色');
  });

  it('★ 卡片：封面 + 标题 + 元信息 + 记于何时 + 摘要 + 去现场', () => {
    // 用户 2026-10-29 要的是四样：「文章的封面，文章的核心信息简介，什么时间在这篇
    //   文章下创建，跳转到该文章」。少一样，这张卡片就答不全他的问题。
    assert.match(diary, /<span className="npr-diary-pop-cover"/, '卡片没有封面位');
    assert.match(diary, /<BookCover book=\{originBook\} \/>/, '书没用真封面（书架那一份）');
    assert.match(diary, /<img className="npr-diary-pop-img" src=\{originEntry\.image\}/, '文章没用 RSS 的封面图');
    assert.match(diary, /<span className="npr-diary-pop-tile"/, '没有封面时留了空框（该用同一套生成封面）');
    assert.match(diary, /记于 \{originPop\.date\} \{originPop\.time\}/, '卡片没写「什么时间记的」');
    assert.match(diary, /<p className="npr-diary-pop-summary">\{originCardSummary\}<\/p>/, '卡片没有摘要');
    assert.match(diary, /onClick=\{\(\) => jumpOrigin\(originPop\)\}/, '卡片没有「去现场」');
    // 元信息由数据层拼（章 / 页 / 频道·作者·发布日），不在 JSX 里堆三元。
    assert.match(diary, /const originCardMeta = \(\(\) => \{/, '元信息没有独立的拼装函数');
    // ★ 封面两种比例：书 2:3、文章 1:1 —— 硬把 RSS 的横图裁成 2:3 会把标题裁掉。
    assert.match(diaryCss, /\.npr-diary-pop\.is-book \.npr-diary-pop-cover \{ height: 60px/, '书封比例变了');
    assert.match(diaryCss, /\.npr-diary-pop\.is-article \.npr-diary-pop-cover \{ height: 40px/, '文章封面也用 2:3 了');
  });

  it('★ 文章的信息走 entryMeta，不走 getArticle（画卡片不能去抓正文）', () => {
    // ★ `getArticle()` 会 `ensureArticle → hydrateBody` 去原文页抓正文。为了画一张
    //   300px 的卡片发一次网络请求，离线时它就永远停在「正在读这篇文章的信息…」。
    assert.match(diary, /await api\.entryMeta\(origin\.articleKey\)/, '没有走只读的 entryMeta');
    assert.equal(/api\.getArticle/.test(diary), false, '又去原文页抓正文了 —— 离线时卡片会一直转');
    // 竞态：连点两条文章时，先发的那次不许把后发的结果盖掉。
    assert.match(diary, /if \(originLoadRef\.current !== token\) return;/, '卡片没有防竞态 —— 连点两条会显示上一条的信息');
  });

  it('★ 收窄 = 换数据源，不换渲染（同一套 days 形状、同一套 JSX）', () => {
    assert.match(diary, /const timelineDays = sourceScope === null \? timeline\.days : sourceDays\.days/,
      '收窄没走「换数据源」—— 又会漂出第二套行结构');
    assert.match(diary, /const timelineBusy = sourceScope === null \? timeline\.busy : sourceDays\.busy/,
      '忙碌态没跟着换 —— 收窄时会先闪一句「还没有灵感」');
    assert.match(diary, /const recentDays = timelineDays/, '时间轴没吃统一的那份数据源');
    // ★ 收窄后不能再给「加载更早」：`bySource()` 已经是全部，那个按钮在这里是假的。
    assert.match(diary, /\{sourceScope === null && timeline\.truncated && \(/, '收窄后还留着「加载更早」');
    // 依赖写**原始值**，不写 `sourceScope` 对象：对象每次渲染都是新的，会让这个
    // effect 在每次父组件渲染时重扫一遍全盘。
    assert.match(diary, /const scopeBook = sourceScope\?\.kind === 'book' \? sourceScope\.id : '';/,
      'effect 依赖写成对象了 —— 每次渲染重扫一遍');
  });

  it('★ 横条：只在收窄时出现，说清「不是全部」，并且自带出口', () => {
    assert.match(diary, /\{sourceScope !== null && \(\s*<div className=\{`npr-diary-scope/,
      '横条不是「只在收窄时出现」—— 默认态又多了一个筛选控件');
    assert.match(diary, /\{sourceDays\.busy \? '正在数…' : `全部 \$\{sourceDays\.total\} 条`\}/,
      '横条没印出这个来源一共有多少条');
    assert.match(diary, /aria-label="回到全部灵感"[\s\S]{0,200}?setSourceScope\(null\)/,
      '横条没有出口 —— 进去了出不来');
    // 暖褐必须混 `--npr-fg`：写死 #8a5610 在深色主题下就是「深棕字压在深底上」。
    assert.match(diaryCss, /\.npr-diary-scope\.is-book \{[^}]*color: color-mix\(in srgb, #b4762a 45%, var\(--npr-fg\)\)/,
      '暖褐写死了 —— 深色主题下看不见');
    // 它**不 sticky**：收窄后的列表通常只有几天，钉住它会白占一行高度。
    assert.doesNotMatch(diaryCss, /\.npr-diary-scope \{[^}]*position: sticky/,
      '横条被钉住了 —— 收窄后列表很短，白占一行高度');
  });

  it('★ 聚合入口只在出处卡片里，不另开一个「按书本」视图', () => {
    assert.match(diary, /function openOriginScope\(\)/, '没有「收窄到这个来源」这个动作');
    assert.match(diary, /这本书的全部灵感/, '卡片里没有书的聚合入口');
    assert.match(diary, /这篇文章的全部灵感/, '卡片里没有文章的聚合入口');
    // 收窄前先把卡片关掉、把展开的天收回：两者都挂在「全部」那一份列表上。
    const body = /function openOriginScope\(\) \{([\s\S]{0,900}?)\n  \}/.exec(diary);
    assert.ok(body, 'openOriginScope 没找到 —— 锚点失效');
    assert.match(body[1], /setOriginPop\(null\)/, '收窄了卡片还贴着 —— 它对应的那条已经不在列表里了');
    assert.match(body[1], /setOpenDay\(''\)/, '收窄后还留着展开的那一天（日期集合变了）');
    // ★ 反向对照：三档的残骸一个都不许回来。它们回来时不会报错，只会「多一块东西」。
    for (const gone of ['LINK_VIEWS', 'linkedSources', 'linkViewRows', 'npr-diary-srcrow', 'npr-diary-views']) {
      assert.equal(diary.includes(gone), false, `三档的残骸还在：${gone}`);
    }
    assert.equal(/linkView/.test(diary), false, '还有 linkView 这个档位状态');
  });
});

/**
 * 0.43：私密侧栏日历下面那两块（本月情绪 / 那年今日）。
 *
 * 用户 2026-10-27 的原话：日历下面那一整块是空的，想放「情绪罗盘与微型统计」和
 * 「那年今日」，让侧栏「告别空旷、充满生命力」。这里守四件事：
 *   ① 两块卡片**排在「这个月」之后**（不是插到日历上面去）；
 *   ② 占比的分母是「记过心情的条数」，且只取前三档；
 *   ③ 锁着时**不编数**：字数给「—」而不是 0，「那年今日」点一下把人带到解锁卡；
 *   ④ 点情绪 → 右侧**替换**成整月列表，而不是叠在当天条目上。
 */
describe('0.43：私密侧栏的「本月情绪」与「那年今日」', () => {
  it('★ 两块卡片排在「这个月」之后（日历 → 这个月 → 本月情绪 → 那年今日）', () => {
    const atSect = diary.indexOf('>这个月</h2>');
    const atMood = diary.indexOf('>本月情绪</h2>');
    const atEcho = diary.indexOf('>那年今日</h2>');
    assert.ok(atSect > 0, '锚点失效：「这个月」那块找不到了');
    assert.ok(atMood > atSect, '「本月情绪」没有排在「这个月」后面 —— 它该占日历下面那块空地');
    assert.ok(atEcho > atMood, '「那年今日」该在本月情绪下面（先看这个月，再往回看）');
    // 两块都是卡片容器（边框 + 淡底），不是又一串列表行
    assert.equal((diary.match(/className="npr-diary-card"/g) ?? []).length, 2,
      '两块卡片应该都用 .npr-diary-card 包着，否则它们看起来像「这个月」列表的续行');
  });

  it('★ 卡片底色用 color-mix(fg 3%)，不写死 rgba(255,255,255,…)', () => {
    // ★ 写死的白色在浅色主题下是**完全看不见**的（白底 + 白 3%）。
    assert.match(diaryCss, /\.npr-diary-card \{[^}]*background: color-mix\(in srgb, var\(--npr-fg\) 3%, transparent\)/,
      '卡片底色没有跟着主题走 —— 浅色主题下会消失');
    assert.match(diaryCss, /\.npr-diary-card \{[^}]*border: 1px solid var\(--npr-border\)/,
      '卡片没有边框（需求原话是「微弱的边框」）');
    assert.doesNotMatch(diaryCss, /\.npr-diary-card[^{]*\{[^}]*rgba\(255, ?255, ?255/,
      '卡片底色写死了白色 —— 浅色主题下等于没有底色');
  });

  it('★ 占比的分母是「记过心情的条数」，且只取前三档', () => {
    assert.match(diary, /dash\.moods\.slice\(0, 3\)/, '没有只取前三档（五档铺满 268px 会糊成一片）');
    assert.match(diary, /const total = dash\.moods\.reduce\(\(sum, cell\) => sum \+ \(cell\.count \?\? 0\), 0\);/,
      '占比的分母不是「记过心情的条数」—— 用总条数会让三档加起来永远不到 100%');
  });

  it('点一格筛右侧、再点同一格收回；悬停给占比明细', () => {
    assert.match(diary, /onClick=\{\(\) => setMoodFilter\(\(current\) => \(current === cell\.score \? null : cell\.score\)\)\}/,
      '点情绪格没有切换筛选（或者点了收不回来）');
    assert.match(diary, /title=\{`本月「\$\{cell\.label\}」的条目 \$\{cell\.count\} 条，占记过心情的 \$\{cell\.share\}%`\}/,
      '没有 Tooltip 说明这一格是多少条、占多少');
    assert.match(diary, /aria-pressed=\{moodFilter === cell\.score\}/, '筛选态没有 aria-pressed');
  });

  it('★ 锁着时字数给「—」，不给 0', () => {
    assert.match(diary, /<strong>\{dash\.chars === null \? '—' : dash\.chars\}<\/strong> 字/,
      '字数没区分「不知道」与「0 字」—— 锁着时显示 0 字是一句确定的假话');
    assert.doesNotMatch(diary, /\{dash\.chars \?\? 0\}/, '把 null 兜成了 0');
    assert.match(diary, /上锁时只数天数。心情分布与字数要解锁后才看得到。/,
      '锁着时没有说明「为什么这里是空的」');
  });

  it('★ 那年今日：空态文案照抄需求、锁着时点一下把人带到解锁卡', () => {
    assert.match(diary, /这一天，时光悄悄走过，还没有留下痕迹 ✨/, '空态文案不是需求里那句');
    assert.match(diary, /📅 \{cell\.years\} 年前的今天/, '没有「N 年前的今天」这一行');
    assert.match(diary, /onClick=\{\(\) => \(cell\.locked \? askUnlock\(\) : pick\(cell\.date\)\)\}/,
      '锁着的条目被点了没有分流 —— 要么跳到看不到的正文，要么毫无反应');
    assert.match(diary, /function askUnlock\(\)[\s\S]{0,500}box\.querySelector\('input'\)\?\.focus\(\)/,
      'askUnlock 没有把光标放进口令框（用户点一下还得自己再点一次输入框）');
    // ★ 没有这个 ref，askUnlock 会在第一行 return，而按钮看起来「能点」。
    assert.match(diary, /className="npr-gate" aria-label="私密日记已上锁" ref=\{gateRef\}/,
      '解锁卡没有挂 ref —— 侧栏那颗「解锁后方可穿越时空」会静默失效');
  });

  it('★ 点情绪后右侧**替换**掉当天条目与写入口，不叠在上面', () => {
    assert.match(diary, /\{moduleValue !== 'reflection' && moodFilter === null && \(/,
      '筛选时当天的条目列表还在 —— 两块同时在场，人会以为下面那堆也属于这个筛选');
    assert.match(diary, /\{moduleValue === 'private' && \(gate\.available === false \|\| gate\.unlocked\) && moodFilter === null && \(/,
      '筛选时写入口还开着 —— 写进去会落到「今天」，而屏幕上是一张整月列表');
    assert.match(diary, /\{moodFilter !== null && \(\s*\n\s*<section className="npr-diary-moodview"/,
      '没有整月列表这一块');
    assert.match(diary, /onClick=\{\(\) => pick\(row\.date\)\}/, '整月列表点一行没有回到那一天');
  });

  it('★ 换天 / 切模块 / 上锁都要退出情绪筛选', () => {
    // 反向对照：漏掉任何一处，都会出现「人在 3 号，顶部却写着只看本月 😄」。
    // ★ 锚点只锚到 `const pick = (date`：0.47 把 `opts` 参数删了（收窄有了显式出口，
    //   换天不再需要「保住筛选」那个选项），写全签名会让这条判据在签名变化时**静默**
    //   变成 indexOf(-1) —— 报的是「没有退出情绪筛选」，而真正坏的是锚点。
    const pickAt = diary.indexOf('const pick = (date');
    assert.notEqual(pickAt, -1, '锚点失效：pick() 不见了');
    const pick = diary.slice(pickAt);
    assert.match(pick.slice(0, pick.indexOf('\n  };')), /setMoodFilter\(null\)/,
      'pick() 没有退出情绪筛选');
    assert.match(diary, /setMoodFilter\(null\);\s*\n\s*setDraft\(''\);/, 'lockNow() 没有退出情绪筛选');
    assert.equal((diary.match(/setMoodFilter\(null\)/g) ?? []).length >= 3, true,
      '退出筛选的地方少于三处（换天 / 切模块 / 上锁）');
  });

  it('★ 面板请求要带齐 date / today / month 三个日期', () => {
    const api = read('diary-api.js');
    assert.match(api, /export async function fetchDiaryDashboard\(\{ date, today, month \}\)/,
      'fetchDiaryDashboard 的入参不是三个（date/today/month 各有各的用途）');
    assert.match(api, /if \(month\) params\.set\('month', month\);/, '没有把 month 传给宿主');
    assert.match(diary, /fetchDiaryDashboard\(\{ date: selected, today, month: monthKey \}\)/,
      '调用点没把「正在看的那天 / 真实今天 / 日历显示的月」分开传');
    // 三种变化都要重拉：翻月、换天、解锁
    assert.match(diary, /\}, \[moduleValue, monthKey, selected, gate\.unlocked\]\);/,
      '面板没跟着翻月 / 换天 / 解锁刷新 —— 数字会停在上一次');
  });
});

describe('0.44：读后感的三块 —— 封面书墙 / 合并长文 / 划线拖拽', () => {
  const cover = read('BookCover.jsx');
  const coverLib = read('book-cover.js');
  const composer = read('DiaryComposer.jsx');
  const editorEntry = stripComments(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vendor', 'editor-entry.js'), 'utf8',
  ));

  it('★ 左栏是两列封面网格，且书不再走单行列表', () => {
    assert.match(diaryCss, /\.npr-diary-shelf \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
      '侧栏不是两列 grid —— 需求原话是「两列式卡片网格」');
    assert.match(diary, /className="npr-diary-shelf"/, 'JSX 里没有挂 .npr-diary-shelf');
    assert.match(diary, /<BookCover book=\{item\} \/>/, '卡片里没有封面组件');
    /*
     * ★ 反向对照用的是「切出这一段再看」而不是 `assert.doesNotMatch(diary, …)`：
     *   灵感页与私密页里也有 `npr-diary-dayrow`（日期行 / 月份行），全文件禁它必然假红。
     */
    const at = diary.indexOf('className="npr-diary-shelf"');
    assert.ok(at > 0, '锚点失效：找不到书墙');
    const block = diary.slice(at, at + 1200);
    assert.doesNotMatch(block, /npr-diary-dayrow/, '书的卡片还在用单行 dayrow 的结构 —— CSS 改了、结构没改');
  });

  it('★ 封面三种来源：EPUB 走宿主、PDF 走 pdf.js、其余生成式', () => {
    assert.match(coverLib, /if \(ext === 'epub'\) return 'epub';/, '没有把 EPUB 判成宿主解封面那一路');
    assert.match(coverLib, /if \(ext === 'pdf'\) return 'pdf';/, 'PDF 没有走客户端渲染那一路');
    assert.match(coverLib, /return 'made';/, '没有第三档兜底 —— 其余格式会没有封面');
    assert.match(cover, /typeof IntersectionObserver === 'undefined'/, '没有 IntersectionObserver 时应该直接渲染，而不是永远不渲染');
    assert.match(cover, /rootMargin: '160px'/, 'PDF 封面没有按视口懒渲染（几十本一起渲染会占满主线程）');
    // 生成式封面必须跟着主题走：色相由书名哈希给，不是写死一种颜色
    assert.match(cover, /'--npr-cover-h': String\(coverHue\(book\.title\)\)/, '生成式封面的色相不是从书名算的（刷新一次换一套颜色）');
    assert.match(diaryCss, /\.npr-diary-cover-made \{[^}]*linear-gradient\(158deg, hsl\(var\(--npr-cover-h/, 
      '生成式封面没有用色相变量 —— 所有书会是同一个颜色');
    assert.match(diaryCss, /\.npr-diary-cover-img \{[^}]*object-fit: cover/, '真封面没有 object-fit: cover，会被拉变形');
    // 3:4 的比例写在封面容器上（卡片宽度变化时等比缩放，不需要断点）
    assert.match(diaryCss, /\.npr-diary-cover \{[^}]*aspect-ratio: 3 \/ 4/, '封面不是 3:4 竖版比例');
  });

  it('★ 历史读后感合成一篇长文（只并渲染，不并数据）', () => {
    assert.equal((diary.match(/npr-diary-longform/g) ?? []).length, 1, '长文容器不是恰好一个');
    assert.match(diary, /<article className="npr-diary-entry npr-diary-longform">/, '长文容器没有用 article.npr-diary-entry');
    assert.match(diary, /className="npr-diary-part"/, '篇与篇之间没有 .npr-diary-part 分隔');
    // 数据层不动：仍然是按篇 map，存储仍是一天一篇
    assert.match(diary, /bookEntries\.items\.map\(\(entry\) => \{/, '没有按篇遍历（说明数据被合并了）');
    assert.doesNotMatch(diary, /mergeReflection|reflectAll|combineEntries/, '出现了「真合并数据」的函数 —— 这一版只改渲染');
    // CSS：长文自己无上边框，段间是虚线
    assert.match(diaryCss, /\.npr-diary-longform \{ padding: 0; border-top: 0; \}/, '长文自己还留着上边框 —— 又变成「列表里的第一条」');
    assert.match(diaryCss, /\.npr-diary-part \+ \.npr-diary-part \{[^}]*border-top: 1px dashed/, '段间分隔不是虚线');
  });

  it('★ 引用与拖拽插入的是同一段文本，且落在光标 / 落点', () => {
    assert.match(diary, /function quoteSnippet\(item\) \{/, '没有抽出共享的 snippet 构造函数');
    assert.match(diary, /const snippet = quoteSnippet\(item\);\n    if \(insertRef\.current\)/, '「引用」按钮没走编辑器插入');
    assert.match(diary, /event\.dataTransfer\.setData\('text\/plain', snippet\)/, '拖拽没有把 snippet 放进 dataTransfer');
    assert.match(diary, /draggable\n/, '划线卡不可拖拽');
    // 编辑器侧：富文本插入要能拿到落点，而不是一律追加到末尾
    assert.match(editorEntry, /insert\(markdown, coords\)/, '编辑器没有暴露 insert(markdown, coords)');
    assert.match(editorEntry, /view\.posAtCoords\(\{ left: coords\.x, top: coords\.y \}\)/, '拖拽落点没有换算成文档位置');
    assert.match(composer, /richRef\.current\.insert\(snippet, coords\)/, '富文本模式下没走编辑器插入');
    assert.match(composer, /node\.setSelectionRange\(to, to\)/, 'textarea 退路没有把光标移到插入之后');
    // 反向对照：插入应该先试富文本，失败才退 textarea
    assert.match(composer, /if \(rich && richRef\.current && richRef\.current\.insert\(snippet, coords\)\) return;/,
      '富文本可用时仍走了 textarea 路径');
  });
});

/**
 * 0.44.2：读后感的写作区从「四个赤裸的标题」改成「一张纸 + 区块标签」。
 *
 * ★ 用户 2026-10-28 提的方案是「把四个大标题变成可折叠的卡片区块」。
 *   **没有照做**，理由写在 `diary-format.js` 与 `refinements.css` 的注释里：
 *   模板是四个 `##` 的 markdown 文本，不是四个字段。真卡片只有两条路 ——
 *   按标题文字包容器（用户改名就塌）或拆成四个 input（退回填空表单）。
 *   所以这里做的是**版式节奏**。下面每条判据都对应一个「不这么做会怎样」。
 *
 * ★ 这一层是源码级（同本文件其余部分）：缺陷的因果全在静态结构里，
 *   而几何量测在 `.build/preview/measure-paper.mjs`（11 条 CSS 变异做反向对照）。
 */
describe('0.44.2：写作区的纸面与区块标签', () => {
  const composer = read('DiaryComposer.jsx');
  const css = read('refinements.css');

  it('模板条不属于正文，占位提示有独立的定位基准', () => {
    // 模板条走 `header` 槽位，不进 markdown：写进正文会跟着 .md 落盘，
    // 而且用户删掉那行标题就再也点不到按钮。
    assert.match(composer, /header = null,/, 'DiaryComposer 没有 header 槽位');
    assert.match(composer, /^\s*\{header\}$/m, 'header 没有渲染在写作区里');

    // ★ 定位层：纸面有 padding，占位提示是 absolute。
    //   没有 `.npr-write-body` 当包含块，它会相对 `.npr-write` 的 padding box 定位，
    //   与正文左边缘差整整一个 padding-left（实测 16px）—— 空态看起来就是「提示浮在左边」。
    assert.match(composer, /className="npr-write-body"/, '编辑器没有独立的定位层');
    assert.match(css, /\.npr-write-body \{ position: relative; \}/, '.npr-write-body 不是定位基准');
    const bodyAt = composer.indexOf('className="npr-write-body"');
    const phAt = composer.indexOf('npr-write-ph');
    const toolsAt = composer.indexOf('className="npr-write-tools"');
    assert.ok(bodyAt > 0 && phAt > bodyAt && phAt < toolsAt,
      '占位提示不在定位层里 —— 它会跟着纸面的 padding 一起偏移');
  });

  it('「套用模板」不会把模板插第二遍', () => {
    // 0.44.1 及以前：按钮只看「正文空不空」，于是已经套过又点一次，
    // 四个 `##` 会被追加第二遍，正文里出现两套「一句话总结」。
    assert.match(diary, /const refTemplated = refDraft\.includes\('## 一句话总结'\)/,
      '没有判断正文里是否已经有模板骨架');
    assert.match(diary, /disabled=\{refTemplated\}/, '已套用时按钮仍然可点');
    assert.match(diary, /\{refTemplated \? '已套用' : '套用模板'\}/, '按钮没有反映「已套用」状态');
    // 反向对照：正文非空但还没套过模板时，仍然应该能套 —— 禁用条件不能是「非空」。
    assert.doesNotMatch(diary, /disabled=\{refDraft\.trim\(\)/, '禁用条件写成了「正文非空」—— 写了几个字就再也套不上模板');
  });

  it('写作区是一张纸，不是四张卡片', () => {
    const paper = /\.npr-write\[data-variant="reflection"\] \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.match(paper, /padding: 12px clamp\(8px, 4%, 16px\) 10px/,
      '纸面内边距不是「宽时 16px、窄时收到 8px」—— 写死 16px 在 252px 宽时会挤出工具条（实测溢出 4px）');
    assert.match(paper, /border: 1px solid color-mix\(in srgb, var\(--npr-fg\) 7%, transparent\)/,
      '纸面没有极细边框 —— 没有它，所谓「层级」只剩字色差别');
    assert.match(paper, /border-radius: 10px/, '纸面圆角与拖拽高亮态的 10px 不一致（两者叠在同一元素上）');
    // 只上 reflection：灵感是「打开即写」，私密页要把高度留给字。
    assert.doesNotMatch(css, /^\.npr-write \{[^}]*border: 1px/m, '纸面被加到了所有模块上');
    assert.match(diary, /className="npr-diary-write is-paper"/, '读后感那一块没有标记成纸面');
    assert.match(css, /\.npr-diary-write\.is-paper \{ padding-bottom: 0; border-bottom: 0;/,
      '纸面之外还留着合缝线 —— 纸的底边已经把块收住了');
  });

  it('四个 `##` 靠版式分开：13px 标签 + 分隔线 + 一道装饰竖线', () => {
    const head = /\.npr-write\[data-variant="reflection"\] \.npr-write-rich \.ProseMirror h2 \{[^}]*\}/.exec(css)?.[0] ?? '';
    // 16px → 13px：原来只比正文大 1px，靠 .9em 的 margin 撑着，在流里跟正文几乎同权重。
    assert.match(head, /font-size: 13px/, '区块标签不是 13px —— 又会变回「只比正文大一号」的标题');
    assert.match(head, /border-top: 1px solid color-mix/, '区块标签上方没有分节线');
    assert.match(head, /padding-top: 11px/, '分节线会贴住文字');
    assert.match(css, /h2:first-child \{ margin-top: 0; padding-top: 0; border-top: 0; \}/,
      '第一个标签上方也有分隔线 —— 它顶着纸的顶边，再加一条就是双线');
    // 装饰竖线：用伪元素而不是把 emoji 写进模板（写进去会跟着 .md 落盘，
    // 旧日记里没有它，同一个功能在文件里就长成两种样子）。
    assert.match(css, /h2::before \{ content: ''; display: inline-block; width: 3px; height: 10px;/,
      '标签前没有装饰竖线');
    assert.doesNotMatch(css, /h2::before \{[^}]*content: '[^']*[💡🎯⚡✍]/, '装饰用了 emoji —— 换成 CSS 图形');
  });

  it('档案条从「表头」变成「标签」', () => {
    const dossier = /\.npr-diary-dossier \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.match(dossier, /border: 1px solid color-mix/, '档案条没有细边');
    assert.match(dossier, /background: transparent/, '档案条还有淡底 —— 3% 淡底是「后台报表」的语汇');
    assert.match(dossier, /border-radius: 10px/, '档案条圆角不是 10px —— 999px 在折成三行时会变成三个胖椭圆');
  });

  it('工具条被纸包住，不再自带上边框', () => {
    const tools = /\.npr-write-tools \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.match(tools, /border-top: 0/, '工具条还有上边框 —— 纸已经包住它，再来一条就是「表尾」');
    assert.match(css, /\.npr-write:not\(\[data-variant="reflection"\]\) \.npr-write-tools \{ border-top: 1px solid var\(--npr-border\); \}/,
      '灵感和私密的工具条丢了分隔线 —— 那两个模块没有纸面兜着');
    assert.match(tools, /opacity: \.55/, '工具条平时不够轻');
  });

  it('主次动作拉开：危险动作用低饱和文字', () => {
    assert.match(diary, /className="npr-diary-linkish is-danger" onClick=\{\(\) => setRefDraft\(''\)\}>清空/,
      '「清空」没有标记成危险动作');
    assert.match(css, /\.npr-diary-linkish\.is-danger:hover \{ color: #e5484d; \}/, '危险动作没有单独的 hover 色');
    assert.match(css, /\.npr-write\[data-variant="reflection"\] \.npr-diary-save \{ height: 32px;/, '「记下来」在读后感里没有加一档分量');
    assert.match(css, /\.npr-root \.npr-diary-tplbtn \{[^}]*border-radius: 999px/, '「套用模板」不是描边胶囊');
  });
});


// ---------------------------------------------------------------------------
// 0.48：读后感侧栏的「已写 / 待写」、文艺一点的名单标题、以及**丢掉的封面**
//
// ★ 用户 2026-10-29 三句话，其实是三件互相独立的事：
//   ① 「读完的」这个标题太 low —— 这是**文案层级**的问题（0.47.3 也踩过同一条：
//      标题不明显，真因是层级倒挂，不是颜色）；
//   ② 「混杂了写过读后感和没有写过读后感的」—— 需要一次**区分**，且这个区分必须
//      来自宿主（不先问一遍，界面只能逐本点进去看有没有内容）；
//   ③ 「书的封面为什么没有获取到，为什么在电子书阅读这里可以获取到」—— 这是
//      **一条数据被中间层丢了**：`pdfCoverDataUrl()` 第一件事是判 `book.size > 0`。
// ---------------------------------------------------------------------------
describe('读后感侧栏：区分已写 / 待写，封面不再退化成方块', () => {
  const css = read('refinements.css');

  it('★ 名单标题是「思想留白 · 拾遗」，不是「读完的」', () => {
    assert.match(diary, /思想留白 · 拾遗/, '标题还是「读完了 / 读完的」—— 用户嫌它太直白');
    assert.doesNotMatch(diary, />读完的</, '旧标题还在渲染');
    // 与 0.47.3 的「你的灵感时间线」同一档：主标题（is-lead）+ 图标块。
    assert.match(diary, /npr-diary-sect-head is-lead[\s\S]{0,220}?思想留白 · 拾遗/,
      '这份名单又退回普通小标题了 —— 它是这一页的主结构');
    assert.match(diary, /npr-diary-sect-mark[\s\S]{0,80}?思想留白 · 拾遗/, '标题旁没有图标块');
  });

  it('★ 封面：`loadBooks` 必须把 `size` 带过来（PDF 首页渲染的唯一入口）', () => {
    // `pdfCoverDataUrl()` 的守卫是 `Number(book?.size ?? 0)`，为 0 就直接抛。
    // 0.47 这里只留了 `{ id, title, ext }` ⇒ 同一条书在阅读页有真封面、在这里是方块。
    const load = /async function loadBooks\(\)[\s\S]*?\n  \}/.exec(diary)?.[0] ?? '';
    assert.notEqual(load, '', '找不到 loadBooks —— 锚点失效，断言是假绿');
    assert.match(load, /size: Number\(item\.size\) \|\| 0/, '书单里又没带 size —— 读后感侧栏的 PDF 封面会全部退化成首字方块');
    // 反向对照：把它删掉，判据必须变红（否则这条断言只是在测「文件里有 size 这个词」）。
    assert.doesNotMatch(load.replace(/size: Number\(item\.size\) \|\| 0,/, ''), /size: Number\(item\.size\)/,
      '反向对照失败：替换没生效');
  });

  it('★ 封面：EPUB 走 id、PDF 走 size —— two 条来源都要在 book 对象上留得下', () => {
    // 这条守的是「别把 book 收窄成 { id, title }」：EPUB 只认 id，PDF 只认 size，
    // 收窄一次就有一半格式没封面，而界面上只是「不同书长得不一样」。
    assert.match(diary, /ext: item\.ext,/, '书单里没有 ext —— BookCover 连「走哪条来源」都判不出来');
    assert.match(diary, /filename: item\.filename,/, '书单里没有 filename（书名兜底与排查都靠它）');
  });

  it('★ 区分来自宿主的一次索引，不是逐本点开看', () => {
    assert.match(diary, /fetchReflectionIndex/, '没有拉读后感索引 —— 只能靠点开每本书才知道写没写');
    assert.match(diary, /const writtenBooks = readBooks\.filter\(\(item\) => \(shelfMeta\(item\)\?\.count \?\? 0\) > 0\)/,
      '「写过」的判据不是 count > 0');
    assert.match(diary, /const blankBooks = readBooks\.filter\(\(item\) => shelfMeta\(item\) === null\)/,
      '「待写」的判据不是「索引里没有这本书」');
  });

  it('★ 索引取不到时**不标**，也不假装「你一篇都没写过」', () => {
    // 三条都要在：筛选条只在 ready 时画、卡片标记只在 ready 时挂、取不到时不清空旧表。
    assert.match(diary, /\{reflections\.ready && readBooks\.length > 0 && \(/, '筛选条没等索引就画出来了');
    assert.match(diary, /\{reflections\.ready && \(written > 0/, '卡片上的已写 / 待写没等索引就挂了');
    assert.match(diary, /if \(payload === null \|\| payload === undefined\) \{[\s\S]{0,320}?return;/,
      '索引取不到时把表清空了 —— 写完一篇再刷新会闪掉所有「已写」标记');
  });

  it('★ 筛选是三档、只收窄不换结构（全部 / 写过 / 待写）', () => {
    assert.match(diary, /\{ key: 'all', label: '全部', count: readBooks\.length \}/);
    assert.match(diary, /\{ key: 'written', label: '写过', count: writtenBooks\.length \}/);
    assert.match(diary, /\{ key: 'blank', label: '待写', count: blankBooks\.length \}/);
    // 网格仍然只渲染一次（同一套卡片），筛选只换数据源 —— 换两套行结构就是 0.47 删掉的东西。
    assert.match(diary, /\{shelfBooks\.map\(\(item\) => \{/, '书墙没跟着筛选走');
  });

  it('写完一篇要重算索引，不能停在打开这一页时的快照', () => {
    const refresh = /async function refresh\(\)[\s\S]*?\n  \}/.exec(diary)?.[0] ?? '';
    assert.notEqual(refresh, '', '找不到 refresh —— 锚点失效');
    assert.match(refresh, /await reloadReflections\(\);/, '写完读后感后「已写」标记不会变');
  });

  it('★ 「已写」的文字色必须混 fg（品牌绿当文字只有 1.45:1）', () => {
    const writtenMark = /\.npr-diary-shelfcard-mark\.is-written \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.notEqual(writtenMark, '', '找不到已写标记的样式');
    assert.match(writtenMark, /color: color-mix\(in srgb, var\(--npr-accent\) 45%, var\(--npr-fg\)\)/,
      '已写标记用了纯品牌绿当文字色 —— 浅色主题下几乎读不出来');
    assert.doesNotMatch(writtenMark, /color: var\(--npr-accent\);/, '又直接拿 accent 当文字色了');
    const chip = /\.npr-root button\.npr-diary-shelfchip\.is-on \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.match(chip, /color: color-mix\(in srgb, var\(--npr-accent\) 45%, var\(--npr-fg\)\)/,
      '选中的筛选 chip 用了纯品牌绿当文字色');
  });

  it('两态长得不一样：写过是实底，待写只有一圈虚线', () => {
    const blankMark = /\.npr-diary-shelfcard-mark\.is-blank \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.notEqual(blankMark, '', '找不到待写标记的样式');
    assert.match(blankMark, /border: 1px dashed/, '待写没有虚线 —— 两态都是实底胶囊，看不出哪个是还没做');
    assert.doesNotMatch(blankMark, /background:/, '待写也上了底色 —— 它不该和「已写」一样重');
  });
});

// ---------------------------------------------------------------------------
// 0.49：读后感侧栏那个搜索框「看不出来是搜索框」
//
// ★ 用户 2026-10-29 原话：「下面这个既是说明标签又是搜索框对吗？搜索框太不明显了」。
//   两件事一起把人骗了，缺一不可：
//   ① 文案 —— placeholder 写的是「只列出标记为读完的书…」，那是一句**说明**，
//      回答的是「这份名单是什么」，而不是「要我输入什么」。输入框的提示语只能回答后者。
//   ② 外形 —— 只有一块 4% 淡底、没有描边、没有放大镜。网格里每格都是圆角卡片，
//      一块无边的浅灰在它们上面就只是一条注记。
// ---------------------------------------------------------------------------
describe('读后感侧栏：搜索框要像输入框', () => {
  const css = read('refinements.css');

  it('★ placeholder 只回答「搜什么」，不兼任名单说明', () => {
    assert.match(diary, /<Icon name="search"[\s\S]{0,400}?placeholder="搜书名…"/,
      '搜索框里没有放大镜，或者 placeholder 又不是搜索语');
    assert.doesNotMatch(diary, /只列出标记为读完的书/,
      '说明语还塞在 placeholder 里 —— 用户会把它当成标签而不是输入提示');
  });

  it('这份名单是什么，由标题和筛选条回答（说明语删掉不等于语义丢了）', () => {
    assert.match(diary, /思想留白 · 拾遗/, '标题没了，说明语又删了，这块就没有任何文字说它是「读完的书」');
    assert.match(diary, /\{ key: 'written', label: '写过'/, '已写 / 待写 的筛选条也没了');
  });

  it('★ 框本体要长出描边，不是一块淡底', () => {
    const input = /\.npr-root \.npr-diary-searchfield input \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.notEqual(input, '', '找不到搜索框样式 —— 锚点失效，下面的断言都是假绿');
    assert.match(input, /border: 1px solid var\(--npr-border-strong\)/,
      '搜索框没有 1px 实描边 —— 回到「只有一层淡底」那种注记样');
    assert.doesNotMatch(input, /border: 1px solid transparent/,
      '描边又写成 transparent 了（0.48 就是这么丢掉边框的）');
    assert.match(input, /height: 32px/, '高度又回到 30px 以下 —— 和卡片比起来像一行小字');
  });

  it('聚焦时换成品牌色描边，而不是只把底色刷白', () => {
    const focus = /\.npr-root \.npr-diary-searchfield input:focus-visible \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.notEqual(focus, '', '找不到聚焦态');
    assert.match(focus, /border-color: color-mix\(in srgb, var\(--npr-accent\) 55%, var\(--npr-fg\)\)/,
      '聚焦态没有品牌色描边 —— 品牌亮色直接当前景只有 1.45:1，必须混 fg');
    assert.match(focus, /box-shadow: 0 0 0 3px/);
  });

  it('有内容时才给清空钮，且原生 ✕ 要收掉（否则两个叉叠在一起）', () => {
    assert.match(diary, /\{bookQuery !== '' && \([\s\S]{0,240}?npr-diary-searchclear/,
      '清空钮不是「有内容才出现」');
    assert.match(css, /::-webkit-search-cancel-button \{ appearance: none; \}/,
      '原生 ✕ 没收掉 —— 它和自定义圆钮会叠在同一个位置');
  });

  it('★ 样式锚在自己的类名上，不锚容器（换容器就整块消失）', () => {
    assert.doesNotMatch(css, /\.npr-sidebar \.npr-diary-shelfsearch/,
      '又挂回 .npr-sidebar 了 —— 这个块只属于读后感模块，样式不该依赖它被放在哪');
  });
});
