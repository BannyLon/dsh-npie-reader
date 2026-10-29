/**
 * 侧栏时间轴上，一条灵感要拆成「标题 + 摘要」两段。
 *
 * ★ 0.47.4：用户 2026-10-29 贴了一张 RSS 时间线（日期块 + 时间 + **加粗标题** +
 *   灰色多行摘要），说「显示格式能不能调整下，效果和这张图差不多」。
 *   原来这里是一条 `white-space: nowrap` 的单行：11px 灰色时间 + 12px 灰色正文，
 *   截断到一行 —— 长一点的灵感（「时光爬过忍对已久的忍耐者……」）只剩半句，
 *   每条长得一模一样，扫过去分不出哪条是重点。
 * ⇒ 正文首句当标题（实色、600、最多两行），剩下的当摘要（淡一档、最多两行）。
 *   不是「把正文抄一遍」：这里给的仍然是 `timeline()` 已经截到 160 字的 `preview`，
 *   只是把它**分层**，让每一条有个能一眼抓住的头部。
 *
 * 为什么不用后端多给一个字段：`preview` 是压缩过空白的纯文本（换行已经没了），
 * 而原始 body 里那句话本来就是连续写的。分层规则放客户端，改样式不用动宿主。
 */

/** 标题最多这么多个字。超过就按这个长度硬切，剩下的进摘要。 */
export const ENTRY_TITLE_MAX = 30;

/** 句末标点：遇到它就把标题截到它（含标点）。英文句号不算 —— 小数和版本号会被误切。 */
const SENTENCE_END = /[。！？!?…；;]/;
/** 次级切点：句末标点都没出现时，退一步在第一个逗号/顿号处断开（标题不带逗号）。 */
const CLAUSE_END = /[，,、]/;
/** 从句切标题时，切点至少要这么靠后 —— 否则「他说，……」会切出两个字当标题。 */
const CLAUSE_MIN = 8;

/**
 * @param {string} preview 后端给的 160 字预览（空白已压缩）
 * @returns {{ title: string, rest: string }} `rest` 为空表示只有标题、不画第二行
 */
export function entryLines(preview) {
  const text = String(preview ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return { title: '', rest: '' };

  // 1. 首句：标题带上句末标点（读到「他来了。」这种落点是完整的，去掉标点反而像断了）。
  const stop = text.search(SENTENCE_END);
  if (stop >= 0 && stop + 1 <= ENTRY_TITLE_MAX) {
    return { title: text.slice(0, stop + 1), rest: text.slice(stop + 1).trim() };
  }

  // 2. 没有句末标点，就在第一个逗号处断：标题不带逗号，摘要从逗号后开始。
  const comma = text.search(CLAUSE_END);
  if (comma >= CLAUSE_MIN && comma <= ENTRY_TITLE_MAX) {
    return { title: text.slice(0, comma), rest: text.slice(comma + 1).trim() };
  }

  // 3. 一整句很长的流水账：按字数硬切，剩下的仍然进摘要（标题只有两行，不会重复）。
  if (text.length > ENTRY_TITLE_MAX) {
    return { title: text.slice(0, ENTRY_TITLE_MAX), rest: text.slice(ENTRY_TITLE_MAX).trim() };
  }

  // 4. 短句：一行标题就是全部。
  return { title: text, rest: '' };
}
