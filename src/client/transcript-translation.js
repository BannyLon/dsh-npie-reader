/**
 * 字幕中文层的**驱动逻辑**（不含 React、不含 DOM）。
 *
 * 抽出来的理由和 `jumpToParagraph` 一样：这段代码里有三处只有真机才暴露的取舍
 * —— 从哪一段接着翻、什么时候算完、失败后进度停在哪 —— 写进组件里就只能靠
 * 「翻一集两分钟的节目看看」来验，而这类验证不可重复。
 *
 * ★ 为什么是**客户端**驱动分批，而不是宿主一次翻完：一集 120 段要 6 次模型调用、
 *   一两分钟。一次调用期间界面没有任何进展可显示，用户不知道是在翻还是卡死了。
 * ★ 为什么每批都从**已译段**往后推：中途关掉面板、模型限流中断、切走再回来，
 *   都应该从断点接着翻，而不是从头再花一遍钱。
 */

/** 一批多少段。与宿主 `runTranscriptTranslation` 的 BATCH 保持一致（那边是权威）。 */
export const TRANSLATION_BATCH = 20;

/**
 * 把一批结果并进已有的译文数组。
 *
 * ★ 按**完整数组**覆盖而不是拼接：宿主每批都返回整份数组（已译段在内）。
 *   拼接的话「第 2 批返回前 40 段」会把第 1 批的结果挤到后面去。
 */
export function mergeTranslations(previous, next) {
  const list = Array.isArray(next) ? next : [];
  if (!Array.isArray(previous) || previous.length !== list.length) return [...list];
  return list.map((text, index) => (typeof text === 'string' && text !== '' ? text : previous[index] ?? ''));
}

/** 已经译到第几段（从 0 开始算「连续有译文的段数」）。 */
export function translatedCount(translations) {
  const list = Array.isArray(translations) ? translations : [];
  let count = 0;
  for (const text of list) {
    if (typeof text !== 'string' || text === '') break;
    count += 1;
  }
  return count;
}

/**
 * 从 `start` 开始一批一批翻到完。
 *
 * @param {object} options
 * @param {{ translateTranscriptBatch: (key: string, start: number) => Promise<any> }} options.api
 * @param {string} options.key
 * @param {number} [options.start] 起始段落下标（续翻时传 `translatedCount(已有译文)`）
 * @param {(state: { translations: string[], total: number, done: boolean, batches: number }) => void} [options.onProgress]
 * @param {() => boolean} [options.isCancelled] 用户切走 / 换了另一集时返回 true
 * @returns {Promise<{ translations: string[], total: number, done: boolean, batches: number } | null>}
 */
export async function runTranscriptTranslation({ api, key, start = 0, onProgress, isCancelled } = {}) {
  if (!api || typeof api.translateTranscriptBatch !== 'function') {
    throw new Error('当前宿主不支持字幕翻译');
  }
  let from = Math.max(0, Math.floor(Number(start) || 0));
  let translations = [];
  let total = 0;
  let batches = 0;

  for (;;) {
    if (typeof isCancelled === 'function' && isCancelled()) {
      return translations.length > 0 ? { translations, total, done: false, batches } : null;
    }
    const result = await api.translateTranscriptBatch(key, from);
    batches += 1;
    translations = mergeTranslations(translations, result?.translations);
    total = Number.isFinite(result?.total) ? result.total : translations.length;
    onProgress?.({ translations, total, done: result?.done === true, batches });
    if (result?.done === true) return { translations, total, done: true, batches };

    const count = Number.isFinite(result?.count) ? result.count : 0;
    const next = Number.isFinite(result?.from) ? result.from + count : from + count;
    // ★ 不允许原地踏步：宿主在「这批一段都没翻成」时仍会返回 done=false，
    //   不判这一步就是一个永远转下去的循环 —— 界面表现为「翻译中…」永不结束。
    if (count <= 0 || next <= from) {
      return { translations, total, done: false, batches };
    }
    from = next;
  }
}
