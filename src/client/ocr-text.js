/**
 * 把 OCR 的**视觉行**拼回可读的段落。
 *
 * ★ 为什么需要（0.25.9 量出来的）：本机 OCR（macOS Vision）是按「它在图上看到的
 *   每一行」输出的 —— 行末硬断，宽度约等于原页的正文宽度。而伴读面板只有 380px，
 *   直接把这段文字塞进 `<pre>` + `white-space: pre-wrap`，每一行都会在窄处**二次
 *   折行**：一句话被切成「…白色」/「封面」两截，读起来像被打碎了。
 *   截图证据：同一段文字在面板里从 8 行变成 16 行，中间还夹着孤字。
 *
 * ★ 规则（只做「合并行」，不改字）：
 *   - 单个换行 → 合并；两个及以上换行（空行）→ 保留成段落分隔。
 *   - 合并时**中文直接连**（中文本来就不该有空格）；两侧都是 ASCII 字母/数字时补
 *     一个空格 —— 否则英文会粘成 `NewYork`。
 *   - 不碰标点、不做错字纠正：OCR 的错字要原样留着，用户才知道该不该信。
 *
 * ★ 复制走的是同一份结果：用户要的是「这段文字」，不是「它在纸上怎么断行」。
 */
export function tidyOcrText(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (text.trim() === '') return '';

  const paragraphs = [];
  let line = '';
  const flush = () => {
    if (line !== '') {
      paragraphs.push(line);
      line = '';
    }
  };

  for (const row of text.split('\n')) {
    const piece = row.trim();
    if (piece === '') {
      flush();
      continue;
    }
    if (line === '') {
      line = piece;
      continue;
    }
    const glue = /[A-Za-z0-9]$/.test(line) && /^[A-Za-z0-9]/.test(piece) ? ' ' : '';
    line += glue + piece;
  }
  flush();

  return paragraphs.join('\n\n');
}
