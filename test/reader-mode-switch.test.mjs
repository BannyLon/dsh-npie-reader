/**
 * 打开阅读器面板必须是**初始态**：右侧是欢迎页（现标题「只读你选的，读懂每一篇」），列表无选中。
 *
 * 这条判据被用户按了三次才长成现在这样，每一次都指向同一个动作 —— **自动打开一篇**：
 *
 *   2026-10-26 第一次（切模式）：从「书」切回订阅，阅读区落在上一篇。
 *   2026-10-26 第二次（开面板）：从侧边栏点「阅读器」进来，直接打开了第一条 RSS。
 *   两次都不是「布局不对」，而是有条 effect 在 `openArticle` —— 而 `openArticle` 里
 *   挂着「英文自动生成中文版本」⇒ **打开一个面板 = 替你花一次模型调用**。
 *
 * 所以现在的规则是**结构性**的，不是「某一行有没有加守卫」：
 *   ① 任何 `useEffect` 里都不许调用 `openArticle`（打开文章只能由用户动作发起）；
 *   ② `npr.view.*` 那套「回到上次那篇」的读写一并删掉（只写不读的持久化会招人加回去）；
 *   ③ 切到书架时把选中清空（`selected` 挂在 ReaderPage 上，切走不卸载）。
 *
 * ★ 为什么是源码级：判据的形状是「effect 里有没有那个调用」，真跑要 DOM + 宿主槽位；
 *   而缺陷的因果恰好全在静态结构里。每条判据都配**反向对照**（塞回旧代码必须变红），
 *   并显式断言锚点找得到 —— 锚点失效时宁可报错，也不要静默全绿。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const reader = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));

/** 切掉单个 effect 的正文（从 `useEffect(() => {` 到它的 `}, [deps]`）。 */
function effectsOf(code) {
  const out = [];
  let at = code.indexOf('useEffect(() => {');
  while (at >= 0) {
    const end = code.indexOf('}, [', at);
    if (end < 0) break;
    out.push(code.slice(at, end));
    at = code.indexOf('useEffect(() => {', end);
  }
  return out;
}

/** ① 没有任何 effect 会自己打开文章。 */
function noAutoOpenInEffects(code) {
  const effects = effectsOf(code);
  if (effects.length === 0) return false; // 一个 effect 都扫不到 ⇒ 锚点坏了，不许当通过
  return effects.every((body) => !/openArticle\s*\(/.test(body));
}

/** ② 「回到上次那篇」的读写都不在了。 */
function noViewRestore(code) {
  return !/npr\.view\./.test(code);
}

/** ③ 切到书架时清空选中：守卫、清空、作废在途请求，三条缺一不可。 */
function dropsSelectionOnLibrary(effect) {
  if (typeof effect !== 'string') return false;
  const guarded = /if\s*\(\s*mode\s*!==\s*'library'\s*\)\s*return/.test(effect);
  const cleared = /setSelected\(\s*undefined\s*\)/.test(effect);
  const cancels = /articleRequest\.current\s*\+=\s*1/.test(effect);
  return guarded && cleared && cancels;
}

/** 取包含 marker 的那个 effect。null 表示锚点没对上。 */
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
 * 「切到书架时清空选中」那条 effect。
 *
 * ★ 锚点**不能**用 `setSelected(undefined)`：`hideArticle()` 里也有同样一句，而
 *   `effectAt()` 取的是文件里**第一处** —— 于是切出来的是「每 15 分钟自动刷新」那条
 *   effect 的正文（守卫、作废在途请求都不在里面），③ 一直红着，而代码本身是对的。
 *   假红比不测更糟：它教人忽略红灯。
 * ★ 改用只在那一处出现的模式守卫（与 `diary-ui.test.mjs` 同源写法）。
 */
const dropEffect = effectAt(reader, "if (mode !== 'library') return;");

/** 把用户第二次报的那条恢复原样塞回去 —— 反向对照的素材。 */
function withOldRestore(code) {
  return code.replace(
    /const refresh = async \(target\) => \{/,
    "useEffect(() => { try { const saved = JSON.parse(localStorage.getItem('npr.view.' + channel) || 'null'); if (saved?.key) void openArticle(saved.key, saved.active); } catch {} }, []);\n  const refresh = async (target) => {",
  );
}

describe('打开阅读器/切回来，都必须是初始态', () => {
  it('锚点存在：能扫到 effect，也找得到「清空选中」那一条', () => {
    assert.ok(effectsOf(reader).length >= 5, '扫不到 effect —— 锚点失效，判据会静默全绿');
    assert.notEqual(dropEffect, null, '没找到「清空选中」那条 effect —— 锚点失效');
  });

  it('① 没有任何 effect 自己打开文章（自动打开 = 自动翻译）', () => {
    assert.equal(noAutoOpenInEffects(reader), true,
      '有 effect 在调用 openArticle —— 打开面板就会落在某篇文章上，英文还会自动生成译文');
  });

  it('② 「回到上次那篇」的读写都删干净了', () => {
    assert.equal(noViewRestore(reader), true,
      '源码里还有 npr.view.* —— 那条恢复只要在，迟早会有人接回去');
  });

  it('③ 切到书架时清空选中，并作废还在路上的正文请求', () => {
    assert.equal(dropsSelectionOnLibrary(dropEffect), true,
      '切到书架时没有把 selected 清空（或缺守卫 / 缺在途请求作废）—— 切回来会落在上一篇上');
  });

  it('★ 反向对照：把旧的恢复塞回去，① 和 ② 必须同时变红', () => {
    const before = withOldRestore(reader);
    assert.notEqual(before, reader, '替换没生效，反向对照是假绿');
    assert.equal(noAutoOpenInEffects(before), false, '塞回了 openArticle 却仍判绿 —— 判据没牙');
    assert.equal(noViewRestore(before), false, '塞回了 npr.view.* 却仍判绿 —— 判据没牙');
  });

  it('★ 反向对照：去掉 setSelected(undefined)，③ 必须变红', () => {
    const before = dropEffect.replace(/setSelected\(\s*undefined\s*\)/, '');
    assert.notEqual(before, dropEffect, '替换没生效，反向对照是假绿');
    assert.equal(dropsSelectionOnLibrary(before), false);
  });

  it('★ 反向对照：只留清空、丢掉在途请求作废，③ 也必须变红', () => {
    const before = dropEffect.replace(/articleRequest\.current\s*\+=\s*1/, '');
    assert.equal(dropsSelectionOnLibrary(before), false,
      '在途请求不作废时，它回来会把刚清掉的 selected 又填上');
  });

  it('守它的理由还在：没有选中时右侧确实是那张欢迎页', () => {
    // ★ 钉结构、不钉文案（0.28.3 把标题从「订阅你关注的作者」换成了
    //   「只读你选的，读懂每一篇」，一句 copy 的改动不该让一条**行为**判据变红）。
    //   这里要守的是「未选中 ⇒ 渲染欢迎页」这件事本身；文案由 CHANGELOG 记录。
    assert.match(reader, /className="npr-welcome"/, '欢迎页不见了 —— 请重新评估这几条判据');
  });
});
