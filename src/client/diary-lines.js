/**
 * 侧栏时间轴上，一条灵感要拆成「标题 + 摘要」两段。
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

import { stripInlineTargets } from '../diary-format.js';

/** 标题最多这么多个字。超过就按这个长度硬切，剩下的进摘要。 */
export const ENTRY_TITLE_MAX = 30;

/**
 * 把一段 Markdown 压成**能直接当纯文本印**的预览。
 *
 * ★ 起因（2026-11-11 用户截图）：时间轴上印着
 *   「09:52 **真需求 = 高频 × 刚需 × 普遍。**」 —— 同一串在右侧卡片里是粗体
 *   （那里走 markdownToHtml()），在侧栏却被当纯文本印出来，标记就露在脸上。
 *   预览层不该渲染 HTML（它是摘要，不是正文），只能把标记去掉。
 *
 * ★ 只剥**成对**的标记，且标记内首尾不能是空白：2 * 3、a * b 不会被当成斜体
 *   吃掉星号。反过来 **粗**、~~删~~、「码」都能干净剥掉。
 * ★ **故意不处理下划线**：中文内容里几乎不用它加粗，而 snake_case、文件名、
 *   URL 里到处是下划线 —— 剥它换来的收益远小于把 foo_bar_baz 变成 foobarbaz 的代价。
 * ★ 行首结构标记（#、>、列表、序号）只在整串开头剥一次：preview 已被宿主
 *   压成一行，后面那些「行首」其实只是句中标点，按行首剥会吃掉正文里的连字符。
 *
 * ★ 本文件**一个反引号都不能出现**（注释与正则里都不行）：`test/client-runtime`
 *   的「模板串完整性」守卫按反引号配对来判断模板串边界，正则字面量里的三个反引号
 *   会把它带偏，报成「模板串被提前闭合」。行内代码那条规则因此写成 \x60。
 */
export function plainSnippet(input) {
  let text = String(input ?? '');
  // 图片 / 链接：留文字，去掉目标地址。
  // ★ 没有 alt 时给一个「［图片］」占位（0.73.0）：一条灵感可以**只有一张截图**，
  //   剥成空串之后时间轴上那张卡就没有标题了，看起来像一条坏数据。
  // ★ 实现已挪到 `diary-format.js` 的 `stripInlineTargets()`（0.73.1）：宿主的
  //   `diary_search` 也要同一件事，两边各写一份正则必然漂移成两种行为 ——
  //   界面上写着「［图片］」，搜索却因为地址里含 `assets` 把每条贴图灵感都搜出来。
  text = stripInlineTargets(text);
  // 行首结构标记（标题 / 引用 / 列表 / 有序列表）
  text = text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,2}[.)]\s+)/, '');
  // 行内代码（\x60 = 反引号，理由见文件头最后一段）
  text = text.replace(/\x60([^\x60]*)\x60/g, '$1');
  // 粗体 / 斜体 / 删除线：成对才剥，首尾不许是空白
  text = text.replace(/(\*{1,3}|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  return text;
}

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
  // ★ 先剥 Markdown 标记再切句：`**真需求 = 高频 × 刚需 × 普遍。**` 里的句号
  //   前面要是还挂着 `**`，切出来的标题会带两个星号（用户 2026-11-11 报的就是这个）。
  const text = plainSnippet(preview).replace(/\s+/g, ' ').trim();
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
