/**
 * 字幕翻译的**驱动逻辑**（`src/client/transcript-translation.js`）。
 *
 * ★ 这里不装 DOM、不挂 React：驱动逻辑的全部内容是「一批一批往后推」，
 *   而它最容易错的三处都不需要界面才看得见 —— 批数、续翻起点、原地踏步的死循环。
 *   真界面上的表现是「点了没反应」「翻到一半停了」「一直在转圈」，三者都很难复现。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TRANSLATION_BATCH, mergeTranslations, runTranscriptTranslation, translatedCount,
} from '../src/client/transcript-translation.js';

/** 造一个按段返回整份数组的假宿主。 */
function fakeApi(total, { batch = TRANSLATION_BATCH, onCall } = {}) {
  const calls = [];
  return {
    calls,
    async translateTranscriptBatch(key, start) {
      calls.push({ key, start });
      onCall?.(start);
      const from = Math.max(0, Math.min(Number(start) || 0, total));
      const translations = new Array(total).fill('');
      for (let index = 0; index < total; index += 1) translations[index] = `中${index}`;
      // 已经翻好的段在这份假实现里永远「有值」，没翻到的也给值 —— 这不影响
      // 「推进到哪」，正是驱动层要判的东西。
      const count = Math.min(batch, total - from);
      return { key, from, count, total, done: from + count >= total, translations };
    },
  };
}

describe('translatedCount / mergeTranslations', () => {
  it('连续有译文的段数到第一处空串为止', () => {
    assert.equal(translatedCount([]), 0);
    assert.equal(translatedCount(['a', 'b', '']), 2);
    // ★ 中间有洞不算「已译到这里」：第 3 段缺译文时，从第 3 段往后重翻才是对的。
    //   若实现写成「数非空项的个数」，第 3 段会永远没人翻。
    assert.equal(translatedCount(['a', '', 'c']), 1);
    assert.equal(translatedCount(undefined), 0);
  });

  it('同长度时保留旧的、补上新的：不因为某一批返回空串就把已译段抹掉', () => {
    assert.deepEqual(mergeTranslations(['a', 'b', 'c'], ['x', '', 'y']), ['x', 'b', 'y']);
    // 长度不同就整份采用：那只有两种可能 —— 第一批（previous 是空数组）或换了集。
    // 逐位合并会把「上一集的第 2 段译文」塞进这一集的第 2 段时间轴。
    assert.deepEqual(mergeTranslations(['a', 'b'], ['x', '', 'y']), ['x', '', 'y']);
    assert.deepEqual(mergeTranslations([], ['x']), ['x']);
  });

  it('反向对照：如果 merge 直接返回新数组，已译段会被空串覆盖', () => {
    const previous = ['旧1', '旧2'];
    const next = ['', '新2'];
    const merged = mergeTranslations(previous, next.length === previous.length ? next : []);
    assert.notDeepEqual(merged, next, '合并结果与「直接采用新数组」相同，说明它没在保护旧值');
    assert.equal(merged[0], '旧1');
  });
});

describe('runTranscriptTranslation', () => {
  it('一批一批推到 done：25 段 → 2 批，第 2 批从 20 起', async () => {
    const api = fakeApi(25);
    const progress = [];
    const result = await runTranscriptTranslation({
      api, key: 'k', onProgress: (state) => progress.push(state),
    });
    assert.deepEqual(api.calls, [{ key: 'k', start: 0 }, { key: 'k', start: 20 }]);
    assert.equal(result.done, true);
    assert.equal(result.batches, 2);
    assert.equal(progress.length, 2);
    // 进度必须是**单调**的：界面上的「翻译中 20/25」倒退，用户会以为白翻了。
    assert.deepEqual(progress.map((item) => item.total), [25, 25]);
  });

  it('宿主说 done 就停，不再多发一批', async () => {
    const api = fakeApi(10);
    await runTranscriptTranslation({ api, key: 'k' });
    assert.equal(api.calls.length, 1);
  });

  it('★ 一批一段都没推进时收手，而不是原地死循环', async () => {
    // 这正是「翻到一半一直转圈」的形态：宿主永远回 count:0 / done:false。
    const api = {
      calls: 0,
      async translateTranscriptBatch() {
        this.calls += 1;
        return { translations: ['a'], total: 3, from: 0, count: 0, done: false };
      },
    };
    const result = await runTranscriptTranslation({ api, key: 'k' });
    assert.equal(api.calls, 1, '没有推进时又发了一批 —— 会无限循环');
    assert.equal(result.done, false);
  });

  it('作废票（用户切集）之后不再发下一批', async () => {
    let cancelled = false;
    const api = fakeApi(60, { onCall: (start) => { if (start >= 20) cancelled = true; } });
    const result = await runTranscriptTranslation({
      api, key: 'k', isCancelled: () => cancelled,
    });
    assert.equal(api.calls.length, 2);
    assert.equal(result.done, false);
  });

  it('宿主没有这个方法时抛人话，而不是 TypeError', async () => {
    await assert.rejects(() => runTranscriptTranslation({ api: {}, key: 'k' }), /不支持字幕翻译/);
  });
});
