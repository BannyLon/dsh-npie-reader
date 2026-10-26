/**
 * 书架**分批挂载**（2026-10-25）。
 *
 * ★ 背景：真机 2634 本时，书架原来是 `visible.map(...)` 一次全画 —— 两万多个
 *   DOM 节点，首屏要等它们全部建好，搜索框每敲一个字还要整批重算。
 *
 * ★ 为什么不做「只画可视区」的虚拟滚动：书架行的标题是 `-webkit-line-clamp: 2`、
 *   元信息 `flex-wrap: wrap` ⇒ **行高不固定**。用固定行高算位置，误差会累积成
 *   「滚到底看到空白 / 滚动位置自己跳」，比"慢"难查得多。分批挂载零高度假设。
 *
 * ★ 这一组用例分两层：
 *   ① **纯函数真跑**（`shelf-window.js`）—— 判据「渲染多少 / 下一批到哪」；
 *   ② **接线**（源码级，先 `stripComments`）—— 判据「那个模块真的被用上了」。
 *   只有 ② 会「给死代码发合格证」，只有 ① 会「测一个没人用的模块」。两层缺一不可。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { SHELF_BATCH, shelfNextCount, shelfRenderCount } from '../src/client/shelf-window.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const app = stripComments(readFileSync(join(clientDir, 'LibraryApp.jsx'), 'utf8'));

describe('shelfRenderCount：这一屏该画多少行', () => {
  it('空列表 ⇒ 0（不画任何行）', () => {
    assert.equal(shelfRenderCount({ total: 0 }), 0);
    assert.equal(shelfRenderCount({}), 0);
    assert.equal(shelfRenderCount(), 0);
  });

  it('书比一批少 ⇒ 全画（小于批量的书架行为与以前完全一致）', () => {
    assert.equal(shelfRenderCount({ total: 50 }), 50);
    assert.equal(shelfRenderCount({ total: SHELF_BATCH }), SHELF_BATCH);
  });

  it('★ 2634 本时只画一批，不是全量', () => {
    const count = shelfRenderCount({ total: 2634 });
    assert.equal(count, SHELF_BATCH);
    assert.ok(count < 2634, '一次全画正是这次要修的东西');
  });

  it('已经展开过 ⇒ 按展开的数量画，但**绝不超过总数**', () => {
    assert.equal(shelfRenderCount({ total: 300, shown: 240 }), 240);
    assert.equal(shelfRenderCount({ total: 300, shown: 5000 }), 300, '超过总数时会被夹住');
  });
});

describe('shelfNextCount：再挂一批到哪', () => {
  it('每点一次加一批', () => {
    assert.equal(shelfNextCount({ total: 300, shown: 120 }), 240);
    assert.equal(shelfNextCount({ total: 300, shown: 240 }), 300);
  });

  it('★ 到顶之后**不许再涨**（不夹取的话它每滚一下加 120，再也回不来）', () => {
    assert.equal(shelfNextCount({ total: 300, shown: 300 }), 300);
    assert.equal(shelfNextCount({ total: 300, shown: 296 }), 300, '最后一批只补到总数');
  });

  it('★ 反复展开一定收敛到总数，且任何一步都不超', () => {
    const total = 1000;
    let shown = SHELF_BATCH;
    for (let step = 0; step < 50; step += 1) {
      shown = shelfNextCount({ total, shown });
      assert.ok(shown <= total, `第 ${step} 步涨到 ${shown}，超过总数 ${total}`);
    }
    assert.equal(shown, total, '展开到底应该正好等于总数');
  });

  it('空列表 ⇒ 0', () => {
    assert.equal(shelfNextCount({ total: 0 }), 0);
  });

  it('★ 反向对照：不夹取的实现会涨到总数之外', () => {
    /** 坏实现：`shown + batch`，不夹。 */
    const naive = (total, shown) => shown + SHELF_BATCH;
    assert.equal(naive(300, 300), 420, '对照侧居然没超，那上面那条断言抓不住任何东西');
    assert.notEqual(shelfNextCount({ total: 300, shown: 300 }), naive(300, 300));
  });
});

describe('接线：LibraryApp 真的用上了它', () => {
  it('列表画的是 `visible.slice(0, shelfCount)`，不是 `visible.map`', () => {
    assert.match(app, /visible\.slice\(0, shelfCount\)\.map\(/, '列表还是一次全画');
    // 反向对照：把修之前那一版逐字喂进同一条判据，必须不命中。
    assert.doesNotMatch('{visible.map((book) => {', /visible\.slice\(0, shelfCount\)\.map\(/);
  });

  it('`shelfCount` 来自 `shelfRenderCount`，不是就地算的魔法数', () => {
    assert.match(app, /const shelfCount = shelfRenderCount\(\{ total: visible\.length, shown: shelfShown \}\)/);
  });

  it('★ 有「显示更多」按钮，且它是第 121 本之后**唯一**的入口', () => {
    assert.match(app, /shelfCount < visible\.length && \(/, '按钮的显隐条件没接上');
    assert.match(app, /显示更多（还有 \{visible\.length - shelfCount\} 本）/, '按钮文案里没有「还剩多少本」');
    assert.match(app, /onClick=\{growShelf\}/, '按钮没接 growShelf —— 它只是个摆设');
  });

  it('★★ 不许再出现「滚到底自动追加」（真机实测：它会让那个按钮**永远**看不见）', () => {
    // 2026-10-25 真机反馈原话：「书架滚到底没有出现『显示更多（还有 N 本）』，
    // 只要我往下滚动就一直显示书籍」。
    // 第一版接的 IntersectionObserver 每滚近一次就自动 +120，按钮刚被推进视口，
    // 就立刻被新挂的行推到下面去 —— 用户一次也看不见它，还以为分批没生效。
    // ⇒ 这条断言要的不是「观察器写对」，而是「**不许有**观察器」。
    assert.doesNotMatch(app, /IntersectionObserver/, '又接回自动加载了：按钮会被新挂的行推走，用户永远看不到它');
    assert.doesNotMatch(app, /shelfSentinelRef/, '哨兵元素还在 —— 它只服务于自动加载');
    // ★ 反向对照：把**第一版那段代码**逐字喂进同一条判据，必须命中。
    //   不这么做的话，这条 `doesNotMatch` 有可能是「判据本身写瞎了」而恒绿。
    const firstVersion = stripComments(`
      useEffect(() => {
        const observer = new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer.disconnect();
          growShelf();
        }, { root: null, rootMargin: '400px 0px' });
        observer.observe(shelfSentinelRef.current);
      }, [growShelf, shelfCount, visible.length]);
    `);
    assert.match(firstVersion, /IntersectionObserver/, '反向对照失效：第一版的观察器没被这条判据命中');
    assert.match(firstVersion, /shelfSentinelRef/, '反向对照失效：第一版的哨兵没被这条判据命中');
  });

  it('★ 筛选条件一变就回到第一批（否则「分批」在最该生效的时刻失效）', () => {
    assert.match(app, /useEffect\(\(\) => \{ setShelfShown\(SHELF_BATCH\); \}, \[filters\]\);/);
  });
});
