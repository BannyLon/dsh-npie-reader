// probe-only adapter: pdf.js textContent -> motif-shaped PdfTextRun[] + characters.
// This is the ONLY part that does not exist upstream (embedpdf supplies it there).

/** pdf.js Util.transform, inlined so this module stays dependency-free. */
function transform(m1, m2) {
	return [
		m1[0] * m2[0] + m1[2] * m2[1],
		m1[1] * m2[0] + m1[3] * m2[1],
		m1[0] * m2[2] + m1[2] * m2[3],
		m1[1] * m2[2] + m1[3] * m2[3],
		m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
		m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
	];
}

/**
 * Collect one page as runs + synthetic characters, in page points, top-left origin.
 * Glyphs are approximated by splitting each item's width evenly across its code points.
 */
export async function collectPage(page, pageIndex) {
	const viewport = page.getViewport({ scale: 1 });
	const text = await page.getTextContent();
	const styles = text.styles || {};
	const runs = [];
	const chars = [];
	let charIndex = 0;
	let skippedRotated = 0;
	for (const item of text.items) {
		if (!item.str) continue;
		const tx = transform(viewport.transform, item.transform);
		const fontHeight = Math.hypot(tx[2], tx[3]);
		if (!(fontHeight > 0.5) || !(item.width > 0)) continue;
		// Probe scope: upright horizontal text only.
		if (Math.abs(tx[1]) > 0.01 || Math.abs(tx[0]) < 0.01) {
			skippedRotated++;
			continue;
		}
		const style = styles[item.fontName] || {};
		/**
		 * ★ 2026-11-14：`ascent === 0 && descent === 0` **不是有效度量**，是 pdf.js
		 *   「这个字体它没解析出度量」的信号（非嵌入的标准 14 字体：Times-Italic /
		 *   Courier 等，`text.styles[fontName].ascent` 直接给 0）。
		 *   按有效值收下 ⇒ 字高 0 ⇒ ①`regionsFromRuns` 用 `height > 0` 过滤，这些字
		 *   **进不了区域检测**；②它们全部落进 fallback 的逐行分组，段框高 0；③排版时
		 *   `fits` 必然 false ⇒ 一个白底块都铺不出来，译文全被丢掉，界面停在英文。
		 *   同时 `top = baseline - ascent*h` 也会算成 baseline 本身，框会整体下移一行。
		 *   实测那篇论文第 2 页 85 个 text item 里有 70 个踩中这条。
		 */
		const ascent = Number.isFinite(style.ascent) && style.ascent > 0 ? style.ascent : 0.75;
		const descent = Number.isFinite(style.descent) && style.descent < 0 ? style.descent : -0.2;
		const top = tx[5] - ascent * fontHeight;
		const height = (ascent - descent) * fontHeight;
		const box = { x: tx[4], y: top, w: item.width, h: height };
		runs.push({
			charIndex,
			charCount: Array.from(item.str).length,
			text: item.str,
			rect: { origin: { x: box.x, y: box.y }, size: { width: box.w, height: box.h } },
			fontSize: fontHeight,
			font: { name: item.fontName, weight: 400, italic: false },
			color: { red: 0, green: 0, blue: 0 },
		});
		const glyphs = Array.from(item.str);
		const glyphWidth = item.width / glyphs.length;
		const charStyle = { font: item.fontName, size: fontHeight, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
		glyphs.forEach((glyph, n) => {
			const gx = box.x + glyphWidth * n;
			chars.push({
				index: charIndex++,
				text: glyph,
				box: { x: gx, y: box.y, w: glyphWidth, h: box.h },
				visualBox: { x: gx, y: box.y, w: glyphWidth, h: box.h },
				style: charStyle,
			});
		});
	}
	return { index: pageIndex, width: viewport.width, height: viewport.height, runs, chars, skippedRotated, styles };
}
