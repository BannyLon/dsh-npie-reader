/**
 * 日记页顶栏：**说明页没有，工作页有**（0.56.0）。
 *
 * 这条判据改过一次方向，两版反馈都记在这里：
 *
 *   2026-10-30 第一次：
 *     「是不是将私密日记这一页，也改成与记录这一页格式统一显示，
 *       读后感里也全屏显示，不要有顶部的条」
 *   ⇒ 我做成了「私密与读后感的顶栏都撤掉」。
 *
 *   2026-10-30 第二次（纠正）：
 *     「这个页面保持和之前一致，就是顶部有标题栏」（写读后感那一屏）
 *     「私密日记同样，这个页面和之前保持一致，只是增加的说明页没有标题栏」
 *   ⇒ 要撤的是**说明页**的顶栏，不是**工作页**的顶栏：
 *     · 工作页（今天写了什么 / 写给哪本书）：顶栏就是这一页的抬头，要留；
 *     · 说明页（灵感开场「寸心拾遗」/ 私密开场「只在本机」/ 读后感欢迎页
 *       「读完的书，值得留一句」）：上面一个可操作的对象都没有，顶栏只是把下面
 *       几段说明再说一遍。
 *
 * 判据分两层：
 *   ① **纯函数** `headVisible()` —— 七格真值表，写反任何一格界面上都只是
 *      「多一行字 / 少一行字」，肉眼完全正常；
 *   ② **接线** —— 判据真的被调用、顶栏只是空着而不是被删掉（`data-window-drag`
 *      在它身上，删了这一页顶部就拖不动窗口）、档案卡在编辑器上方而不是跑到顶上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { headVisible } from '../src/client/diary-head.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const diary = readFileSync(new URL('../src/client/DiaryApp.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/client/refinements.css', import.meta.url), 'utf8');

describe('顶栏什么时候有内容（headVisible）', () => {
  it('★ 真值表：工作页有，说明页没有', () => {
    const table = [
      // 灵感：编辑器有顶栏（今天 · N 条 · M 字 + AI 整理），开场页没有
      ['inspiration', false, false, true],
      ['inspiration', false, true, true],
      ['inspiration', true, false, false],
      // 私密：上锁也是工作页，顶栏要留（用户第二次明确要求「和之前保持一致」）；
      // 但私密也有自己的说明页（0.56.2），那一屏没有顶栏 —— 说明页不是工作页。
      ['private', false, false, true],
      ['private', true, false, false],
      // 读后感：没选书 = 说明页（无顶栏），选了书 = 写作页（有顶栏）
      ['reflection', false, false, false],
      ['reflection', false, true, true],
    ];
    for (const [module, cover, book, expected] of table) {
      assert.equal(headVisible({ cover, module, book }), expected,
        `${module} + cover=${cover} + book=${book} 应为 ${expected}`);
    }
  });

  it('★ 反向对照一：判据写成「不在封面就显示」，读后感说明页那一格就变红', () => {
    // 这正是第一版的写法（`!showCover`），也正是用户第一次反馈引出来的那个错。
    const mutant = ({ cover }) => !cover;
    assert.equal(mutant({ cover: false, module: 'reflection', book: false }), true);
    assert.notEqual(
      headVisible({ cover: false, module: 'reflection', book: false }),
      mutant({ cover: false, module: 'reflection', book: false }),
      '真函数与「非封面就显示」的变异体给出了同一个答案 —— 真值表没有牙',
    );
  });

  it('★ 反向对照二：判据写成「读后感一律不给」，写作页那一格就变红', () => {
    // 这是第二版（我改错方向的那一版）。写作页没有顶栏就没有抬头，
    // 用户看到的是一页「写下这本书留给你的东西」，不知道在写给谁。
    const mutant = ({ cover, module }) => !cover && module !== 'reflection';
    assert.equal(mutant({ cover: false, module: 'reflection', book: true }), false);
    assert.notEqual(
      headVisible({ cover: false, module: 'reflection', book: true }),
      mutant({ cover: false, module: 'reflection', book: true }),
      '真函数与「读后感一律不给」的变异体给出了同一个答案',
    );
  });

  it('★ 反向对照三：判据里忘了 `cover`，私密说明页那一格就变红', () => {
    // 这一版（只看模块与书）对**六格**都答对，只有「私密 + 说明页」露馅 ——
    // 而那一格正是 0.56.2 新加的，也正是用户这次要的那一屏。
    const mutant = ({ module, book }) => (module === 'reflection' ? Boolean(book) : true);
    assert.equal(mutant({ cover: true, module: 'private', book: false }), true);
    assert.notEqual(
      headVisible({ cover: true, module: 'private', book: false }),
      mutant({ cover: true, module: 'private', book: false }),
      '真函数与「忘了 cover」的变异体给出了同一个答案 —— 新加的那一格没有牙',
    );
  });

  it('未知模块名一律给顶栏（工作页是常态；说明页才是那个要单独排除的）', () => {
    assert.equal(headVisible({ cover: false, module: undefined }), true);
    assert.equal(headVisible({ cover: false, module: 'whatever' }), true);
  });
});

describe('接线：判据真的被用上', () => {
  it('DiaryApp 通过 headVisible() 判，且把「有没有选书」一起传进去', () => {
    assert.match(diary, /const showHead = headVisible\(\{ cover: showCover, module: moduleValue, book: Boolean\(book\) \}\);/,
      '顶栏判据没有走纯函数，或没把 book 传进去 —— 读后感的两个状态会共用一个答案');
    assert.match(diary, /const bareHead = !showHead;/, 'bareHead 不是从 showHead 推出来的');
  });

  it('★ 顶栏内容挂在 showHead 上（不是 showCover，也不是模块判断）', () => {
    assert.match(diary, /\{showHead && \(\s*<>\s*<div className="npr-diary-head">/,
      '顶栏内容没有挂在 showHead 上');
    assert.doesNotMatch(diary, /\{!showCover && \(\s*<>\s*<div className="npr-diary-head">/,
      '还在用「非封面就显示」的旧判据');
  });

  it('★ 顶栏这一条本身没有被删掉（`data-window-drag` 在它身上）', () => {
    // 删掉之后这一页顶部就按不住、拖不动窗口 —— 而且只在桌面端才看得出来。
    assert.match(diary, /<div className="npr-book-toolbar" data-window-drag>/,
      '拖动行没了 —— 说明页顶部拖不动窗口');
  });

  it('★ 空着时给容器打 data-bare，CSS 才有依据把那条底边让掉', () => {
    assert.match(diary, /className="npr-reader npr-diary-reader" data-bare=\{bareHead \? '' : undefined\}/,
      '容器没有 data-bare 标记');
    assert.doesNotMatch(diary, /data-cover=/, '旧的 data-cover 标记还在 —— 两个名字守同一件事');
    assert.match(css, /\.npr-diary-reader\[data-bare\] > \.npr-book-toolbar \{/,
      'CSS 里没有 [data-bare] 规则');
  });
});

describe('档案卡回到编辑器上方（不是跑到页面顶上）', () => {
  // 0.56.0 中途顶栏被撤掉过一次，为了不丢书名把档案卡挪到了最顶上、还加了书名一格。
  // 用户当场反馈「点书之后又回到带顶部栏的写读后感状态」：盒子在顶上就是一条栏。
  // 顶栏恢复之后，卡退回原位，书名还给顶栏 —— 同一件事不说两遍。
  const at = diary.indexOf('className="npr-diary-write is-paper"');

  it('★ 档案卡在 `.is-paper` 里面，不在它前面', () => {
    assert.notEqual(at, -1, '找不到写作区的锚点');
    const block = diary.slice(at, at + 1600);
    assert.match(block, /className="npr-diary-dossier"/, '档案卡没有回到编辑器里');
    assert.match(block, /aria-label="这本书的档案"/, '档案卡没有分组标签');
  });

  it('★ 档案卡里不再印书名（顶栏已经报了）', () => {
    const block = diary.slice(at, at + 1600);
    assert.doesNotMatch(block, /《\{book\.title\}》/, '书名印了两遍 —— 顶栏一遍、档案卡一遍');
  });

  it('★ 五个数一个不少', () => {
    const block = diary.slice(at, at + 1600);
    for (const label of ['划线', '摘录笔记', '读后感', '字', '读到']) {
      assert.ok(block.includes(`<span>${label}</span>`), `档案卡少了「${label}」`);
    }
  });

  it('反向对照：把类名改掉，上面那条断言确实会失配', () => {
    const broken = diary.replace('className="npr-diary-dossier"', 'className="npr-diary-dossier-x"');
    assert.notEqual(broken, diary, '替换没生效，反向对照是假绿');
    assert.doesNotMatch(broken, /className="npr-diary-dossier"/);
  });

  it('★ 旧的那行旁注（bookcap）已经撤掉 —— 它是「顶栏被撤」时期的临时产物', () => {
    assert.doesNotMatch(stripComments(css), /\.npr-diary-bookcap/, 'CSS 里还留着旁注的规则');
    assert.doesNotMatch(stripComments(diary), /npr-diary-bookcap/, 'JSX 里还留着旁注');
  });
});
