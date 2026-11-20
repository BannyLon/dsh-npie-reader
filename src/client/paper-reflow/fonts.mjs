// Ported from motif (Copyright (c) 2026 poco-ai, MIT). See MOTIF-LICENSE.txt.
// JS port of packages/pdf/src/client/translation/fonts.ts

export const fontFamily = '"Noto Serif CJK SC", "Songti SC", "SimSun", serif';

export function fontCss(key, size) {
	return `${key.toLowerCase().includes("italic") ? "italic " : ""}${key.toLowerCase().includes("bold") ? "700 " : "400 "}${size}px ${fontFamily}`;
}

/** Measure the same browser font that paints the page overlay. No font download required. */
export function browserReflowFonts() {
	const context = document.createElement("canvas").getContext("2d");
	if (!context) throw new Error("Canvas text measurement is unavailable");
	return Object.fromEntries(
		["regular", "bold", "italic", "boldItalic", "cjk", "cjkBold"].map((key) => [
			key,
			{
				encodeText: (text) => text,
				widthOfTextAtSize(text, size) {
					context.font = fontCss(key, size);
					return context.measureText(text).width;
				},
				heightAtSize(size, options) {
					context.font = fontCss(key, size);
					const metrics = context.measureText("Mg国");
					return (
						Math.max(size * 0.8, metrics.actualBoundingBoxAscent) +
						(options?.descender === false ? 0 : Math.max(size * 0.2, metrics.actualBoundingBoxDescent))
					);
				},
			},
		]),
	);
}
