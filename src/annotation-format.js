/**
 * 划线 / 笔记 → Markdown。
 *
 * ★ 宿主（`book_annotations` 工具）与界面（划线面板的「导出」）**共用这一份**。
 *   各写一套的后果是「模型引用的一条划线，用户复制出来找不到」——
 *   而这恰好是同一个人无法判断谁错了的那类不一致：两边都自称在读同一本书。
 *
 * ★ **按页分组，不按时间**：划线是读这本书时留下的，页码就是它的坐标。
 *   按下标 / 时间排会把同一页上相邻的两句拆到很远（后划的反而在前），
 *   而用户想复看时找的是「那一页我划了什么」。
 *
 * ★ 摘录里的换行要**逐行加 `>`**：只给首行加的时候，第二行会掉出引用块 ——
 *   渲染出来是一段普通正文，读者无法区分「作者原文」与「我的笔记」。
 */

/**
 * 色板标签。**唯一来源**：`client/annotations.js` 从这里取（见那边的一行 import），
 * 所以「重点 / 灵感 / 疑问 / 喜欢」不会在界面与导出稿之间漂移。
 */
export const TONE_LABELS = Object.freeze({
  yellow: '重点',
  green: '灵感',
  blue: '疑问',
  pink: '喜欢',
});

export const TONE_ORDER = Object.freeze(Object.keys(TONE_LABELS));

/**
 * 一次导出最多带走多少条。
 *
 * ★ 上限存在的理由不是性能，是**接收端**：500 条约等于 4 万字，
 *   再多的复制结果会被部分编辑器截断，而截断时不报错 —— 用户以为导全了。
 *   到顶就明说「另有 N 条没带」（见返回值的 `truncated`），不静默截断。
 */
export const EXPORT_ITEM_MAX = 500;

/** 未知色值退回第一档，而不是漏掉标签：一条划线不该因为色值而少一行说明。 */
export function toneLabel(tone) {
  return TONE_LABELS[tone] ?? TONE_LABELS[TONE_ORDER[0]];
}

/** 摘录 / 笔记的统一清洗：CRLF 归一、去掉首尾空行。 */
function tidy(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

/** 多行文字 → 每一行都带 `> `（理由见文件头）。 */
function quoteBlock(text) {
  return tidy(text).split('\n').map(line => `> ${line}`).join('\n');
}

/**
 * 生成一份完整的 Markdown。
 *
 * @param {object} input
 * @param {string} input.title    书名（拿不到时可传 bookId）
 * @param {string} input.bookId
 * @param {Array}  input.items    划线（宿主 shop 形状：`{page,start,end,quote,note,tone}`）
 * @param {string} [input.stamp]  导出时间那一行的值；不传就不写这一行
 * @param {number} [input.limit]  条数上限（默认 `EXPORT_ITEM_MAX`）
 * @param {number} [input.total]  这本书**实际**有多少条。不传时按 `items.length` 算。
 *   ★ 工具侧会先按总预算截断再交进来，此时 `items.length` 已经不等于总数 ——
 *   不引入这个参数，头部就会把「预算截断」写成「全书就这么少」，而那正是
 *   本项目全面禁止的那类**确定的假话**。
 * @returns {{ markdown: string, shown: number, total: number, truncated: boolean }}
 */
export function annotationsMarkdown({
  title, bookId, items, stamp = '', limit = EXPORT_ITEM_MAX, total = null,
} = {}) {
  const all = Array.isArray(items) ? items : [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : EXPORT_ITEM_MAX;
  const shown = all.slice(0, cap);
  const known = Number.isInteger(total) && total > all.length ? total : all.length;
  const name = tidy(title) || tidy(bookId) || '未命名';

  const pages = new Set(shown.map(item => item.page));
  const notes = shown.filter(item => tidy(item.note) !== '').length;

  const head = [`# 《${name}》划线`, ''];
  const meta = [`${shown.length} 条划线`, `${notes} 条笔记`, `分布在 ${pages.size} 页`];
  // 被截断时把**全书总数**写进头部：只说「500 条」会被读成「这本书一共 500 条」。
  if (known > shown.length) meta.push(`全书共 ${known} 条，这里只带到前 ${shown.length} 条`);
  head.push(`> ${meta.join(' · ')}${stamp ? ` · ${stamp}` : ''}`, '');

  if (shown.length === 0) {
    head.push('（这本书还没有划线。）', '');
    return { markdown: head.join('\n'), shown: 0, total: known, truncated: false };
  }

  const lines = [...head];
  let lastPage = null;
  for (const item of shown) {
    if (item.page !== lastPage) {
      if (lastPage !== null) lines.push('');
      lines.push(`## 第 ${item.page} 页`, '');
      lastPage = item.page;
    }
    lines.push(quoteBlock(item.quote), '');
    const note = tidy(item.note);
    if (note !== '') {
      // 笔记是**用户自己写的**，不与摘录混成同一段引用：加粗前缀 + 引用块外的缩进，
      // 视觉上分得开，纯文本读起来也能分清哪句是原书。
      lines.push(`- **${toneLabel(item.tone)}** · 我的笔记：${note}`, '');
    } else {
      lines.push(`- ${toneLabel(item.tone)}`, '');
    }
  }

  return {
    markdown: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
    shown: shown.length,
    total: known,
    truncated: known > shown.length,
  };
}
