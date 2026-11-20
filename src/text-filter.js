/**
 * TXT「像不像一本书」的判定（共用层零依赖纯函数）。
 *
 * ★ 这里**只给结论，不做处置**：返回 `{ suspect, reason }`，由扫描器决定怎么标、
 *   由用户在书单里决定要不要留。绝不返回「删掉 / 跳过」—— 过滤放错层会把
 *   「不展示」做成「删文件」，或让已入库的书突然打不开。
 *
 * ★ 判据参考 shuting（MIT，Copyright (c) 2026 Zanbin Xu）的
 *   `src/core/txt.ts:73-108`。它的 CHANGELOG 记过两次真事故：
 *     ① 初版只看行特征，requirements.txt / KutoolsLog.txt 混进书库（于是加字数下限）；
 *     ② ASCII 句末标点一刀切，40 行 `ip address 10.0.0.1` 网络设备配置
 *        被当成散文收了进来（小数点 / IP / 版本号不算句子结尾）。
 *   两条都在这里被写成反向对照的判据，别再退化回去。
 *
 * ★ **不搬它的解码**：本插件 `host/ebook/plain.js` 的 `decodeTextBuffer` 是
 *   严格 TextDecoder(fatal:true) 的 UTF-8 → GB18030 → Big5 → 宽容 UTF-8，
 *   比 shuting 的「toString('utf8') 里出现 U+FFFD 才回退」严谨得多。
 */

/**
 * 判据版本。改 `inspectText` 的规则时**必须递增**，否则将来做缓存时旧结论
 * 永远不会重算（新规则对已入库的书不生效）。
 *   1  三条原始判据；2  字数下限；3  ASCII 句末标点不再把小数点/IP 算进去。
 */
export const TEXT_FILTER_VERSION = 3;

/** 汉字 / 日文假名按字算，连续的拉丁数字按词算 —— 与书的长度感一致。 */
function wordCount(text) {
  const hits = String(text).match(/[\u3400-\u9fff\u3040-\u30ff]|[A-Za-z0-9]+/g);
  return hits === null ? 0 : hits.length;
}

/**
 * 这一行像不像自然语言句子。
 *
 * ★ 中文标点没有歧义，直接认；ASCII 的 `.!?;` 必须是「前面不是数字」且
 *   「后面是空白或行尾」。否则 `10.0.0.1` 里的点、`v1.2` 里的点全成了句号。
 */
export function hasSentencePunctuation(line) {
  const text = String(line ?? '');
  if (/[。！？；]/.test(text)) return true;
  return /(?<!\d)[.!?;](?=\s|$)/.test(text);
}

/**
 * @returns {{ suspect: boolean, reason: string, words: number, lines: number,
 *   longLines: number, sentenceLines: number }}
 *   `reason === ''` 表示「像书」，书单里不打任何标记。
 */
export function inspectText(text) {
  const source = String(text ?? '');
  const lines = source.split(/\r\n|\r|\n/).filter(line => line.trim().length > 0);
  const words = wordCount(source);
  const base = { words, lines: lines.length, longLines: 0, sentenceLines: 0 };

  if (lines.length === 0) return { ...base, suspect: true, reason: '这个文件里没有正文' };
  if (words < 200) {
    return { ...base, suspect: true, reason: `只有 ${words} 字，像是便签、日志或依赖清单，不像一本书` };
  }

  const longLines = lines.filter(line => line.trim().length >= 30).length;
  const sentenceLines = lines.filter(hasSentencePunctuation).length;
  const veryShort = lines.filter(line => line.trim().length < 20).length;
  const stats = { ...base, longLines, sentenceLines };

  // 配置导出 / 依赖清单：行数多但每行极短，几乎没有句子。
  if (veryShort / lines.length > 0.9 && sentenceLines / lines.length < 0.1) {
    return { ...stats, suspect: true, reason: '几乎全是短行，也没有句子，像是配置或清单' };
  }
  if (longLines >= 5 || sentenceLines / lines.length >= 0.2) {
    return { ...stats, suspect: false, reason: '' };
  }
  return { ...stats, suspect: true, reason: '长句太少，像是日志、脚本或数据文件' };
}

/** 与 shuting 同名的布尔口径，便于对照与复用。 */
export function looksLikeBook(text) {
  return !inspectText(text).suspect;
}
