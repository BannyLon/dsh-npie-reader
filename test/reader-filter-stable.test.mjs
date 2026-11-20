/**
 * 切换「全部 / 未读 / 收藏 / 已隐藏」时，列表**不许先清空**。
 *
 * 用户 2026-11-11：「为什么点击『全部』『未读』…… 切换的时候，会闪一下。」
 *
 * 闪的不是选中块，是**整块列表**：那条 effect 原来不分情况
 * `setPage({ entries: [] })` 再请求，于是三帧里换了两次内容 ——
 * 列表消失 → 「正在加载…」→ 新列表。
 *
 * 顺着它还有两件事一起发生，第二件比列表更晃眼：
 *   ① 列表滚动位置归零（内容回来时从顶上开始）；
 *   ② `page.hiddenCount` 变 `undefined` ⇒ `hiddenCount > 0` 为 false ⇒
 *      「已隐藏 N」那颗 chip 消失，底座里从 4 颗变 3 颗、等分宽度重算，
 *      整排 chip 左右跳一下，再随数据回来跳回去。
 *
 * ★ 为什么是源码级：真跑要宿主 api + 两帧截图才能看出「中间那一帧是空的」；
 *   而因果全在「哪条路径清空 page.entries」这一处结构上。
 * ★ 反向对照写在每一条里：把清空搬回 `saveChannelState` 之后，必须变红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const reader = stripComments(
  readFileSync(join(here, '..', 'src', 'client', 'ReaderPage.jsx'), 'utf8'),
);

/** `saveChannelState(...)` 之后那一段 —— 用来验「中间没有插一次清空」。 */
function tailAfterSave(code) {
  const marker = 'saveChannelState(channel, { filter, query }, localStorage);';
  const at = code.indexOf(marker);
  assert.notEqual(at, -1, '找不到 saveChannelState —— 锚点失效，判据变成空转');
  return code.slice(at, at + 300);
}

describe('切换筛选不清空列表（0.72.2）', () => {
  it('★ 清空只发生在「换频道」这一条路径上', () => {
    // 条件必须是「这条列表现在摆的不是这个频道的文章」，不能是「每次 effect 都清」。
    assert.match(reader, /if \(listedChannel\.current !== channel\) \{[\s\S]{0,140}?setPage\(\{ entries: \[\]/,
      '清空没有挂在「换频道」上 —— 换筛选时列表会整块消失再出现');
    // 反向对照：把条件改成恒真（= 原来的一律清空），这条必须变红。
    const always = reader.replace('listedChannel.current !== channel', 'true');
    assert.notEqual(always, reader, '替换没生效，反向对照不成立');
    assert.doesNotMatch(always, /if \(listedChannel\.current !== channel\)/,
      '把清空改成无条件之后，判据仍然绿 —— 它没有咬住触发条件');
  });

  it('★ 请求之前只有保存状态，没有插进一次清空', () => {
    const tail = tailAfterSave(reader);
    assert.match(tail, /saveChannelState\([^)]*\);\s*void loadPage\(undefined, true\);/,
      'saveChannelState 与 loadPage 之间插了别的动作 —— 换筛选时列表会被清空一次');
    // 反向对照：把旧那行塞回去，必须不匹配。
    const old = tail.replace(
      'void loadPage(undefined, true);',
      'setPage({ entries: [], hasMore: false, nextCursor: undefined });\n    void loadPage(undefined, true);',
    );
    assert.notEqual(old, tail, '替换没生效');
    assert.doesNotMatch(old, /saveChannelState\([^)]*\);\s*void loadPage\(undefined, true\);/,
      '旧写法（先清空再请求）居然还判绿 —— 这条判据挡不住它');
  });

  it('★ 不清空的前提：加载文案只在「列表还是空的」时出现', () => {
    // 保留旧条目的同时 `loading` 会是 true。渲染条件若只看 `loading`，
    // 整块列表会被「正在加载…」顶掉 —— 那还是闪，只是换了个文案。
    // ★ 判据必须连 `{!pageError &&` 一起写：只写 `loading && page.entries.length === 0`
    //   会**同时**命中下面那条 `!loading && page.entries.length === 0`（空态），
    //   于是反向对照永远不可能变红 —— 那种「假绿」比没有判据更糟。
    const LOADING_EMPTY = /\{!pageError && loading && page\.entries\.length === 0 &&/;
    assert.match(reader, LOADING_EMPTY,
      '加载文案没有带「列表为空」这个条件 —— 保留旧条目时会被它整块顶掉');
    // 反向对照：去掉 entries 条件，必须变红。
    const loose = reader.replace(
      '{!pageError && loading && page.entries.length === 0 &&',
      '{!pageError && loading &&',
    );
    assert.notEqual(loose, reader, '替换没生效');
    assert.doesNotMatch(loose, LOADING_EMPTY,
      '去掉「列表为空」之后判据仍绿 —— 它没有真正检查渲染条件');
  });
});
