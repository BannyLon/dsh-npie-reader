/**
 * 切模式回来必须是**初始态**（`src/client/ReaderPage.jsx`）。
 *
 * 缺陷（用户 2026-10-26 真机 + 截图）：读到一半点右上角切到「书」，再切回「订阅」，
 * 右侧直接落在上一篇文章上；那篇原文是英文时，译文也一并摆出来。用户的原话是
 * 「这不是我想的」——他要的是切回来看到「订阅你关注的作者」那张欢迎页。
 *
 * ★ 根因不止一处，两处都在本文件里：
 *   ① `selected` 挂在 ReaderPage 上（订阅页只是它的一个渲染分支），切到书架时它**不卸载**，
 *      于是那篇文章原封不动地留着；
 *   ② 反方向也有一处：面板以 `mode === 'library'` 打开时，那条「回到上次那篇」仍会跑，
 *      在用户看不见的地方 `openArticle` —— 英文还会顺手自动生成译文。
 *
 * ★ 为什么是源码级：这条判据的形状是「effect 里有没有模式守卫」，真跑要 DOM + 宿主槽位；
 *   而缺陷的因果恰好全在静态结构里。每条判据都配**反向对照**（喂回未修版本必须变红），
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

/**
 * 取包含 marker 的那个 `useEffect(() => { … }, [deps])`。
 * 返回 null 表示锚点没对上 —— 那时判据必须报错。
 */
function effectAt(code, marker) {
  const at = code.indexOf(marker);
  if (at < 0) return null;
  const start = code.lastIndexOf('useEffect(() => {', at);
  if (start < 0 || start > at) return null;
  const end = code.indexOf('}, [', at);
  if (end < 0) return null;
  return code.slice(start, end);
}

/** 「初始模式是书架时不许恢复上次阅读」。 */
function guardsRestoreOnLibrary(effect) {
  return typeof effect === 'string' && /if\s*\(\s*mode\s*===\s*'library'\s*\)\s*return/.test(effect);
}

/** 「切到书架时把选中清空」。三条缺一不可：守卫、清空、作废在途请求。 */
function dropsSelectionOnLibrary(effect) {
  if (typeof effect !== 'string') return false;
  const guarded = /if\s*\(\s*mode\s*!==\s*'library'\s*\)\s*return/.test(effect);
  const cleared = /setSelected\(\s*undefined\s*\)/.test(effect);
  const cancels = /articleRequest\.current\s*\+=\s*1/.test(effect);
  return guarded && cleared && cancels;
}

// ★ 锚点用 `getItem('npr.view.'`（读回）而不是 `npr.view.`：后者先命中上面那条**写**缓存的
//   effect，切片就会切到别人的 effect 里去 —— 判据在那上面照样全绿，守的却不是这里。
const restoreEffect = effectAt(reader, "getItem('npr.view.'");
const dropEffect = effectAt(reader, 'setSelected(undefined)');

describe('切到书架再切回来，订阅页保持初始态', () => {
  it('锚点存在：两处 effect 都还找得到', () => {
    assert.notEqual(restoreEffect, null, '没找到「恢复上次阅读」那条 effect —— 锚点失效');
    assert.notEqual(dropEffect, null, '没找到「清空选中」那条 effect —— 锚点失效');
  });

  it('① 面板以书架模式打开时不恢复上次那篇（否则会在后台自动翻译）', () => {
    assert.equal(guardsRestoreOnLibrary(restoreEffect), true,
      '「恢复上次阅读」没有 mode 守卫 —— 书架模式下它仍会 openArticle 并自动生成译文');
  });

  it('② 切到书架时清空选中，并作废还在路上的正文请求', () => {
    assert.equal(dropsSelectionOnLibrary(dropEffect), true,
      '切到书架时没有把 selected 清空（或缺守卫 / 缺在途请求作废）—— 切回来会落在上一篇上');
  });

  it('★ 反向对照：去掉恢复处的 mode 守卫，判据必须变红', () => {
    const before = restoreEffect.replace(/if\s*\(\s*mode\s*===\s*'library'\s*\)\s*return\s*;?/, '');
    assert.notEqual(before, restoreEffect, '替换没生效，反向对照是假绿');
    assert.equal(guardsRestoreOnLibrary(before), false);
  });

  it('★ 反向对照：去掉 setSelected(undefined)，判据必须变红', () => {
    const before = dropEffect.replace(/setSelected\(\s*undefined\s*\)/, '');
    assert.notEqual(before, dropEffect, '替换没生效，反向对照是假绿');
    assert.equal(dropsSelectionOnLibrary(before), false);
  });

  it('★ 反向对照：只留清空、丢掉在途请求作废，也必须判红', () => {
    const before = dropEffect.replace(/articleRequest\.current\s*\+=\s*1/, '');
    assert.equal(dropsSelectionOnLibrary(before), false,
      '在途请求不作废时，它回来会把刚清掉的 selected 又填上');
  });

  it('守它的理由还在：没有选中时右侧确实是那张欢迎页', () => {
    // 若这条文案没了，说明「初始态」被换成了别的形状，上面的判据要重新评估。
    assert.match(reader, /订阅你关注的作者/, '欢迎页文案不见了 —— 请重新评估这几条判据');
  });
});
