/**
 * 页级按需翻译（D 档）：把单页探针验证过的那几步串成一条可复用的链路。
 *
 * 来源与许可 ----------------------------------------------------------------
 * 本目录里的 `types / reading-order / layout / fonts / regions / region-build /
 * adapter` 是从 agentero 的 motif 移植并针对内置 pdf.js 补过的实现，
 * **MIT，Copyright (c) 2026 poco-ai**，许可全文见同目录 `MOTIF-LICENSE.txt`。
 * 那个文件不可删除、不可改写。
 *
 * 为什么要有这一层 ----------------------------------------------------------
 * 探针 `browser-probe.mjs` 是把「取字 → 分段 → 排版 → 铺 DOM」写在一个函数里。
 * 那样没法单测，也没法在缩放变化时只重排、不重新调模型。这里把链路切成
 * 三个**纯数据**步骤：
 *   ① `pageParagraphs()`  pdf.js 页 → 段落 IR + 待译段落表
 *   ② `translationsOf()`  模型返回的 [{id,text}] → 按 id 对齐的 Map
 *   ③ `overlayBlocksOf()` 排版结果 + 当前 scale → 与 DOM 无关的渲染块
 * 组件只负责把 ③ 画出来；缩放变了重跑 ③ 即可，译文缓存完全不受影响。
 *
 * ★ 坐标系：IR 里全是 **page points**（左上原点、scale=1）；`overlayBlocksOf`
 *   乘上阅读器当前渲染 scale 才变成 CSS 像素。别在 ①② 里提前乘 —— 那样
 *   缓存下来的 IR 就绑死在某一次缩放上了。
 */
import { collectPage } from './adapter.mjs';
import { buildPageIR } from './region-build.mjs';
import { layoutReflowDocument } from './layout.mjs';

export { browserReflowFonts, fontFamily } from './fonts.mjs';

/**
 * 不值得送去翻译的段落（0.71.2）。
 *
 * ★ 为什么要在**送模型之前**拦：这两类段落翻出来只会更糟，而且每次都要花钱。
 *   ① 已经是中文的段落（论文里的多语种示例图、中文摘要）——「中译中」模型只会
 *      原样返回，白花一次调用，还会在 5pt 的图例框里重新排一遍字。
 *   ② 字号小于 6pt 的段落——那是图 / 表内部的标签（DeepSeek-VL 第 4 页整页图例
 *      都是 4.9pt）。段落框只有 5pt 高，中文塞进去会被裁成半行。
 *   上游靠 layout.json 把这类区域标成 `figure` / `table` 直接不选，我们没有版面
 *   模型，只能用字号与语种这两个代理判据。
 */
export const MIN_TRANSLATABLE_SIZE = 6;
export const ALREADY_TRANSLATED_RATIO = 0.4;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** 这段值得翻吗？（导出以便单测钉住判据，别让它悄悄放宽） */
export function worthTranslating(paragraph) {
  const text = String(paragraph?.source ?? '').trim();
  if (text.length < 2) return false;
  if (Number(paragraph?.style?.size ?? 0) < MIN_TRANSLATABLE_SIZE) return false;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return false;
  const han = text.match(CJK_CHAR)?.length ?? 0;
  return han / letters < ALREADY_TRANSLATED_RATIO;
}

/**
 * 取一页的文字，分出段落。
 *
 * @param {object} pdfPage pdf.js 的 PDFPageProxy
 * @param {number} pageIndex **0 起**的页索引（`BookReader` 里的 page 是 1 起，要减一）
 * @returns {Promise<{ ir: object, paragraphs: {id: string, text: string}[] }>}
 */
export async function pageParagraphs(pdfPage, pageIndex) {
  const payload = await collectPage(pdfPage, pageIndex);
  const ir = buildPageIR(payload);
  return {
    ir,
    // ★ 送模型的是 `p.source`（这一段的原文字符串），不是 id 也不是整页文本：
    //   分段规则一变，按序号匹配就会整页错配 —— 单页探针踩过这个坑。
    // ★ 只有 `worthTranslating()` 通过的段才进列表；没进列表的段不会有译文，
    //   也就不会被覆盖（原文留在画布上）。
    paragraphs: ir.paragraphs
      .filter(worthTranslating)
      .map((p) => ({ id: String(p.id), text: String(p.source ?? '') })),
  };
}

/**
 * 模型返回的译文 → 排版层要的 Map。
 *
 * ★ 只收 `ir` 里真实存在的 id：模型编造 / 抄错的 id 会让译文盖到别的段落框上。
 * ★ 一条都没对上就返回空 Map —— 调用方据此判「这次没翻成」，而不是铺一页
 *   空白把原文盖掉。
 */
export function translationsOf(ir, translations) {
  const known = new Set(ir.paragraphs.map((p) => String(p.id)));
  const result = new Map();
  for (const item of Array.isArray(translations) ? translations : []) {
    const id = String(item?.id ?? '');
    const text = String(item?.text ?? '').trim();
    if (id === '' || text === '' || !known.has(id) || result.has(id)) continue;
    result.set(id, text);
  }
  return result;
}

/** 用当前字体度量重排这一页（纯计算；探针实测 35–40ms/页）。 */
export function layoutPage(ir, translations, fonts) {
  return layoutReflowDocument({ version: 1, pages: [ir] }, translations, fonts)[0];
}

/**
 * 排版结果 → 渲染块（CSS 像素）。
 *
 * ★ 白底块取 `layout.sourceBox`（**原文框**）而不是 `layout.box`（排版后可能被
 *   外扩过的框）：要盖掉的是画布上那一片英文，多盖一点就会压住旁边的公式或图。
 * ★ `unit.y` 是基线，往上一个字身（`fontSize * 0.8`）才是 CSS 的 top —— 与上游
 *   `page-overlay.tsx` 完全一致，别改成 1.0 或加行距。
 * ★ 0.71.2 起**回到逐字绝对定位**（上游形态）。上一版曾把框内交给浏览器流式排版，
 *   换来的是「`fits` 判据失效」：流式排版不会告诉你它放不下，于是放不下的段
 *   照样铺满、溢出到下一段，两段中文叠在一起。`fits` 要能用，字就必须由 motif
 *   自己定位 —— 它才是那个算过「这一行到没到框底」的人。
 * ★ `fits === false` 的块由调用方**跳过**（见 `PaperTranslateLayer.jsx`）：上游
 *   `page-overlay.tsx` 就是 `filter(p => p.fits)`，放不下就保留原文像素。
 */
export function overlayBlocksOf(pageLayout, scale = 1) {
  const s = Number(scale) > 0 ? Number(scale) : 1;
  return (pageLayout?.paragraphs ?? []).map((layout) => {
    const box = layout.sourceBox;
    return {
      id: String(layout.id),
      fits: Boolean(layout.fits),
      scale: layout.scale,
      box: {
        left: box.x * s,
        top: box.y * s,
        width: box.w * s,
        height: box.h * s,
      },
      units: (layout.units ?? []).map((unit) => {
        const font = String(unit.font ?? '').toLowerCase();
        return {
          text: String(unit.text ?? ''),
          left: (unit.x - box.x) * s,
          top: (unit.y - box.y - unit.fontSize * 0.8) * s,
          fontSize: unit.fontSize * s,
          bold: font.includes('bold'),
          italic: font.includes('italic'),
        };
      }),
    };
  });
}
