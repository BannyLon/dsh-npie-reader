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

const modeEffect = effectAt(reader, 'setSelected(undefined)');

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
    assert.match(quick, /appendDiaryEntry\(\{ date: dateKey\(\), kind: '灵感', body: draft, source, meta \}\)/);
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

  it('★ 侧栏是三块检索器（标签 / 时间轴 / 挂在书上）；正文摘要只在**展开那一天**时才读', () => {
    // 用户 2026-10-27：「侧边栏的显示实在是不符合常理」，随后又补了一句
    // 「侧边栏是不是要有时间轴啊，比如点击今天，展开今天记录的时间轴」。
    assert.match(diary, /fetchDiaryTimeline\(\{ limit: 30 \}\)/);
    assert.match(diary, /fetchDiaryTags\(\)/);
    for (const label of ['标签', '时间轴', '挂在书上']) {
      // 「标签」这块的标题现在带一个计数徽章（标签几千个时，先看见数量比先看见云有用），
      // 所以判据从 `>标签<` 放宽成「标题以这个字开头」—— 它守的是「这一块存在且叫这个名字」，
      // 不是「标题后面紧跟闭合标签」。
      assert.ok(diary.includes(`>${label}`), `侧栏少了「${label}」这一块的标题`);
    }
    // ★ 展开态：日期行带 aria-expanded，展开后才渲染当天条目。
    assert.match(diary, /aria-expanded=\{open\}/, '日期行不是可展开的 —— 时间轴只剩「哪几天写过」');
    assert.match(diary, /const open = openDay === item\.date/, '没有「同一次只展开一天」的状态');
    const openBlock = /\{open && \(([\s\S]*?)\n\s*\)\}/.exec(diary);
    assert.ok(openBlock, '没有找到「展开后渲染」的分支');
    assert.match(openBlock[1], /entry\.preview/, '展开分支里没有摘要 —— 展开了也看不到写了什么');
    // ★ 但**折叠态**绝不能读 preview：那正是 0.31.0 被否掉的做法（把正文抄一遍）。
    assert.doesNotMatch(diary.replace(openBlock[0], ''), /\.preview/,
      '折叠态也在读 entry.preview —— 正文又被抄了一遍');
    assert.match(diary, /entry\.kind !== '读后感'/, '时间轴没有滤掉读后感');
  });

  it('★ 「挂在书上」把已关联的灵感按书名归拢（灵感流转的落地，不是只写进 meta）', () => {
    // 「灵感流转」的另一半：在书里按 L 记的灵感会带 `source`，但**界面必须能按书反查**，
    // 否则它只是一条普通灵感，用户永远不知道自己挂过什么。
    assert.match(diary, /function linkedBooks\(days\)/, '没有按书归拢的判据');
    assert.match(diary, /\^《\(\[\^》\]\+\)》/, '没有从 source 里取书名');
    assert.match(diary, /linked\.length > 0 &&/, '「挂在书上」那一块没有被条件渲染（会一直空着占位）');
    assert.match(diary, /《\{item\.title\}》/, '那一块没把书名显示出来');
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

describe('入口二：从书里点「写读后感」直接落到那一页', () => {
  it('两个阅读器都有那颗按钮，且只在外部给了回调时才画', () => {
    for (const [name, code] of [['BookReader', bookReader], ['BookEbook', bookEbook]]) {
      assert.match(code, /onWriteReflection,/, `${name} 的 props 里没有 onWriteReflection`);
      assert.match(code, /\{onWriteReflection && \(/, `${name} 的按钮没受回调存在性控制（会画出一颗点了没反应的按钮）`);
      assert.match(code, /onClick=\{\(\) => onWriteReflection\(book\)\}/, `${name} 的按钮没把书传出去`);
    }
  });

  it('书架把回调转交给两个阅读器（只转交，不自己切视图）', () => {
    assert.equal((library.match(/onWriteReflection=\{onWriteReflection\}/g) ?? []).length, 2,
      'LibraryApp 没有把 onWriteReflection 同时转交给 PDF 与电子书两条路');
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

  it('② 浮层只从书架那半边拿上下文（订阅页记的灵感不挂书）', () => {
    assert.match(reader, /context=\{mode === 'library' \? readingCtx : null\}/,
      '订阅页也会带上上一本书的上下文');
  });

  it('③ 浮层把书 / 章 / 页写进 meta，并把「会记到哪儿」说出来', () => {
    assert.match(quick, /const linked = context\?\.bookId \? context : null;/, '没有从 context 取关联');
    assert.match(quick, /meta\.book = linked\.bookId;/, 'meta.book 没写');
    assert.match(quick, /meta\.chapter = linked\.chapter\.n;/, 'meta.chapter 没写');
    assert.match(quick, /meta\.page = linked\.page;/, 'meta.page 没写');
    // 关联必须**看得见**，但它是一行纯文本（不是控件，见上一条 describe）。
    assert.match(quick, /\{linked && <p className="npr-quick-link">会记到 \{source\}<\/p>\}/,
      '「会记到哪儿」那行没了 —— 关联变成悄悄发生的');
  });

  it('★ 反向对照：删掉 meta.book 那一行，判据必须变红', () => {
    const old = quick.replace('      meta.book = linked.bookId;\n', '');
    assert.notEqual(old, quick, '替换没生效，反向对照是假绿');
    assert.doesNotMatch(old, /meta\.book = linked\.bookId;/);
  });

  it('★ 没有阅读上下文时不写 meta.book（不能凭空挂书）', () => {
    // 守卫的形状就是「`linked` 为假时整个 meta 是空对象」——如果哪天有人把
    // `meta.book` 挪到 `if (linked)` 外面，订阅页记的灵感也会被挂上一个空 id。
    assert.match(quick, /if \(linked\) \{\n\s*meta\.book = linked\.bookId;/,
      'meta 的写入不在 `if (linked)` 里 —— 没有上下文时会写出一个空的书 id');
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
  return /const stateOf = \(id\) => bookStates\[id\]\?\.state \?\? 'unread'/.test(code);
}

describe('读后感门禁：只对读完的书开放', () => {
  it('★ 判据的默认值是 unread，不是 read', () => {
    assert.equal(defaultBlocksUnread(diary), true,
      '认不出的书按「已读完」处理 —— 门禁等于没有');
  });

  it('★ 反向对照：把默认值改成 read，判据必须变红', () => {
    const old = diary.replace("bookStates[id]?.state ?? 'unread'", "bookStates[id]?.state ?? 'read'");
    assert.notEqual(old, diary, '替换没生效，反向对照是假绿');
    assert.equal(defaultBlocksUnread(old), false);
  });

  it('★ 侧栏只列读完的书 —— 未读完的不再摊一屏', () => {
    // 用户 2026-10-27：「读后感只显示标记完成的书，不显示未读完的书」。
    // 0.32.0 把 2636 本「还没读完」全部铺在侧栏里，真正要用的那 1 本被挤到最上面一行。
    assert.match(diary, /const readBooks = filteredBooks\.filter\(\(item\) => stateOf\(item\.id\) === 'read'\)/);
    assert.doesNotMatch(diary, /const unreadBooks/, '未读完的那一组还在算');
    assert.ok(!diary.includes('还没读完<span'), '侧栏还在渲染「还没读完」那一块的分组标题');
    assert.ok(!diary.includes('>未读完<'), '侧栏还在把「未读完」当状态胶囊画出来');
  });

  it('★ `openBook` 自己也判一次（从阅读器进来不经过侧栏那道 UI 闸）', () => {
    assert.match(diary, /const status = stateOf\(target\.id\);/,
      'openBook 没判读完状态 —— 从书里点「写读后感」能绕过侧栏');
    assert.match(diary, /readable: status === 'read'/);
  });

  it('★ 书没读完时不画输入框，而是说清楚为什么', () => {
    assert.match(diary, /book\.readable \? \(/, '输入框没有受 readable 控制');
    assert.match(diary, /npr-diary-blocked/, '没读完时没有说明块 —— 用户会以为功能坏了');
    assert.match(diary, /还没标记读完/, '说明里没点明原因');
  });

  it('两个阅读器里的「写读后感」在没读完时也是禁用的', () => {
    for (const [name, code] of [['BookReader', bookReader], ['BookEbook', bookEbook]]) {
      assert.match(code, /disabled=\{current\.state !== 'read'\}/,
        `${name} 的「写读后感」没按读完状态禁用`);
      assert.match(code, /标记读完才能写读后感/, `${name} 没说明为什么点不动`);
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
    const pick = /const pick = \(date\) => \{([\s\S]*?)\n  \};/.exec(diary);
    assert.ok(pick, 'pick() 的锚点找不到了');
    assert.doesNotMatch(pick[1], /setRevealed/, 'pick() 还在用已删掉的 revealed 状态');
  });
});

describe('搜索框：导航不再关掉它', () => {
  it('★ `jump()` 不碰搜索状态', () => {
    const body = /const jump = \(date, key = ''\) => \{([\s\S]*?)\n  \};/.exec(diary);
    assert.ok(body, 'jump() 的锚点找不到了');
    assert.doesNotMatch(body[1], /setSearch/, 'jump() 又把搜索框关了 —— 点一条内容它就消失');
  });

  it('★ 反向对照：把 `setSearch` 塞回 jump，判据必须变红', () => {
    const broken = diary.replace(
      /(const jump = \(date, key = ''\) => \{\n)/,
      "$1    setSearch((current) => ({ ...current, open: false }));\n",
    );
    const body = /const jump = \(date, key = ''\) => \{([\s\S]*?)\n  \};/.exec(broken);
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
    const veilBranch = /\{empty\s*\?[\s\S]*?: veiled\s*\?([\s\S]*?): \(html/.exec(diary);
    assert.ok(veilBranch, '收着 / 展开的分支结构没找到');
    // 只允许读**长度**（「23 字」那种提示），不许把正文本身放进 DOM。
    assert.equal(veilBranch[1].includes('dangerouslySetInnerHTML'), false, '收着的分支里在渲染 HTML —— 正文已经进 DOM 了');
    assert.equal(/\{entry\.body\}/.test(veilBranch[1]), false, '收着的分支里在插 entry.body');
  });

  it('★ 私密：切模块 / 上锁 / 再点一次都会收回（不只靠计时器）', () => {
    assert.match(diary, /const PEEK_MS = 30_000/);
    assert.match(diary, /function hidePeek\(/, '没有「收起来」这个动作');
    assert.match(diary, /\}, \[moduleValue\]\);[\s\S]{0,80}?hidePeek\(\)|hidePeek\(\);[\s\S]{0,200}?\}, \[moduleValue\]\);/,
      '切模块时没有收回 —— 看完的那条会跟着用户去别的页');
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
    assert.match(diary, /const entriesShown = dayAll \? visibleEntries : visibleEntries\.slice\(-DAY_PREVIEW\)/,
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
    const pick = /const pick = \(date\) => \{([\s\S]{0,900}?)\n  \};/.exec(diary);
    assert.ok(pick, 'pick 没找到');
    assert.match(pick[1], /setFocusKey\(''\)/, '换天没有清掉上一条的高亮');
    assert.match(pick[1], /setDayAll\(false\)/, '换天没收回「展开了更早的」');
  });
});
