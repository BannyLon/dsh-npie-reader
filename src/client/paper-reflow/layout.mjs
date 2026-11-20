// Ported from motif (Copyright (c) 2026 poco-ai, MIT). See MOTIF-LICENSE.txt.
// JS port of packages/pdf/src/client/translation/layout.ts (behaviour unchanged).

import { formulaToken, intersects } from "./types.mjs";

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const opening = /^[“‘（《「『【([{]$/u;
const closing = /^[”’，。！？；：、）》」』】)\]},.!?;:]$/u;

function fontFor(text, p, fonts) {
	if (cjk.test(text) || (text.codePointAt(0) ?? 0) > 255) return p.style.bold ? "cjkBold" : "cjk";
	const key = p.style.bold
		? p.style.italic
			? "boldItalic"
			: "bold"
		: p.style.italic
			? "italic"
			: "regular";
	try {
		fonts[key].encodeText(text);
		return key;
	} catch {
		return p.style.bold ? "cjkBold" : "cjk";
	}
}

export function translationUnits(p, text, fonts) {
	const tokens = text.split(/(⟪(?:F|\/?S)\d+⟫)/u).filter(Boolean);
	const units = [];
	let current = p;
	const opened = new Set();
	const closed = new Set();
	let activeStyle;
	for (const token of tokens) {
		const styleMatch = /^⟪(\/?)S(\d+)⟫$/.exec(token);
		if (styleMatch) {
			const id = styleMatch[2];
			const style = p.styles[id];
			if (!style) throw new Error(`Unknown style in ${p.id}`);
			if (styleMatch[1]) {
				if (activeStyle !== id || closed.has(id)) throw new Error(`Unbalanced style in ${p.id}`);
				closed.add(id);
				activeStyle = undefined;
				current = p;
			} else {
				if (activeStyle || opened.has(id)) throw new Error(`Repeated style in ${p.id}`);
				opened.add(id);
				activeStyle = id;
				current = { ...p, style };
			}
			continue;
		}
		const formula = p.formulas.find((f) => formulaToken(f.id) === token);
		if (/^⟪F/.test(token) && !formula) throw new Error(`Unknown formula in ${p.id}`);
		if (formula) {
			units.push({
				text: formula.text,
				width: formula.box.w,
				height: formula.box.h,
				font: "regular",
				fontSize: p.style.size,
				formula,
				color: current.style.color,
				cjk: false,
				space: false,
			});
			continue;
		}
		for (const ch of Array.from(token.replace(/[\r\n]+/g, " "))) {
			const font = fontFor(ch, current, fonts);
			units.push({
				text: ch,
				width: fonts[font].widthOfTextAtSize(ch, p.style.size),
				height: fonts[font].heightAtSize(p.style.size),
				font,
				fontSize: p.style.size,
				color: current.style.color,
				cjk: cjk.test(ch),
				space: /\s/u.test(ch),
			});
		}
	}
	for (const f of p.formulas)
		if (text.split(formulaToken(f.id)).length !== 2) throw new Error(`Missing or repeated formula in ${p.id}`);
	if (activeStyle || Object.keys(p.styles).some((id) => !opened.has(id) || !closed.has(id)))
		throw new Error(`Missing style in ${p.id}`);
	return units.filter(
		(unit, i) =>
			!unit.space ||
			!(
				closing.test(units.slice(i + 1).find((u) => !u.space)?.text ?? "") ||
				opening.test(
					units
						.slice(0, i)
						.reverse()
						.find((u) => !u.space)?.text ?? "",
				)
			),
	);
}

/**
 * 居中块逐行居中（0.71.2）。
 *
 * motif 原文没有这一层：它的 `layout.json` 会告诉它哪一段是居中的，而重排只负责
 * 「框内从左上角开始铺」。我们从纯文本回退里认出居中块（论文标题、作者区）之后，
 * 若还按左边对齐铺，标题就会变成左对齐 —— 一眼看出是机器改的。
 * 这里只平移 x，不动基线、不动 `fits` 判据（是否放得下在放进 out 时已定）。
 */
function recenterLines(out, box) {
	const lines = new Map();
	for (const unit of out) {
		const key = Math.round(unit.y * 10);
		const bucket = lines.get(key);
		if (bucket) bucket.push(unit);
		else lines.set(key, [unit]);
	}
	for (const bucket of lines.values()) {
		const left = Math.min(...bucket.map((u) => u.x));
		const right = Math.max(...bucket.map((u) => u.x + u.width));
		const shift = box.x + (box.w - (right - left)) / 2 - left;
		for (const unit of bucket) unit.x += shift;
	}
}

function place(p, units, box, scale, fonts, keepWords) {
	const out = [];
	const lineSkip = units.some((u) => u.cjk) ? 1.5 : 1.3;
	const em = p.style.size * scale;
	let x = box.x + Math.min(p.firstLineIndent, box.w * 0.3) * scale;
	const ascent = fonts.regular.heightAtSize(em, { descender: false });
	let baseline = box.y + ascent;
	let lineTop = box.y;
	let lineStart = 0;
	let lineHeight = em;
	let previous;
	let fits = true;
	const widths = units.map((u) => u.width * scale);
	for (let i = 0; i < units.length; i++) {
		const unit = units[i];
		if (!unit) continue;
		if (x === box.x && unit.space) continue;
		let gap =
			previous &&
			previous.cjk !== unit.cjk &&
			!previous.space &&
			!unit.space &&
			!closing.test(previous.text) &&
			!closing.test(unit.text) &&
			!opening.test(previous.text) &&
			!opening.test(unit.text)
				? em * 0.25
				: 0;
		let needed = widths[i] ?? 0;
		let wordEnd = i;
		if (keepWords && !unit.cjk && !unit.formula && !unit.space && !closing.test(unit.text)) {
			for (let j = i + 1; j < units.length; j++) {
				const next = units[j];
				if (!next || next.cjk || next.space || next.formula || closing.test(next.text) || opening.test(next.text))
					break;
				needed += widths[j] ?? 0;
				wordEnd = j;
			}
		}
		if (opening.test(unit.text)) needed += widths[i + 1] ?? 0;
		// Reserve closing punctuation with its preceding word/character.
		for (let j = wordEnd + 1; j < units.length && closing.test(units[j].text); j++) needed += widths[j];
		if (x + gap + needed > box.x + box.w + 0.01 && x > box.x) {
			// Closing punctuation may hang by half an em; never start a line with it.
			if (!(closing.test(unit.text) && x + gap + (widths[i] ?? 0) <= box.x + box.w + em * 0.5)) {
				x = box.x;
				baseline += Math.max(em * lineSkip, lineHeight * 1.05);
				lineHeight = em;
				lineTop = baseline - ascent;
				lineStart = out.length;
				gap = 0;
				previous = undefined;
				if (unit.space) continue;
			}
		}
		const width = unit.width * scale;
		const height = unit.height * scale;
		if (unit.formula) {
			const required = height - unit.formula.baselineOffset * scale;
			const shift = Math.max(0, lineTop + required - baseline);
			if (shift > 0) {
				baseline += shift;
				for (let n = lineStart; n < out.length; n++) out[n].y += shift;
			}
		}
		if (
			width > box.w + 0.01 ||
			baseline + Math.max(0, unit.formula?.baselineOffset ?? 0) * scale > box.y + box.h + 0.01
		)
			fits = false;
		out.push({
			...unit,
			x: x + gap,
			y: baseline + (unit.formula?.baselineOffset ?? 0) * scale,
			width,
			height,
			fontSize: em,
		});
		x += gap + width;
		lineHeight = Math.max(lineHeight, height);
		previous = unit;
	}
	if (p.center) recenterLines(out, box);
	return { id: p.id, pageIndex: p.pageIndex, sourceBox: p.box, box, scale, units: out, fits };
}

function expandedBox(p, page, obstacles, right) {
	const box = { ...p.box };
	if (right) {
		let edge = page.width - 12;
		for (const o of obstacles)
			if (o.x >= box.x + box.w - 0.1 && o.y < box.y + box.h && o.y + o.h > box.y) edge = Math.min(edge, o.x - 5);
		box.w = Math.max(box.w, edge - box.x);
	} else {
		let edge = page.height - 12;
		for (const o of obstacles)
			if (o.y >= box.y + box.h - 0.1 && o.x < box.x + box.w && o.x + o.w > box.x) edge = Math.min(edge, o.y - 2);
		box.h = Math.max(box.h, edge - box.y);
	}
	return box;
}

export function layoutParagraph(p, text, page, fonts, initialScale = 1, occupied = []) {
	const units = translationUnits(p, text, fonts);
	const obstacles = [...page.obstacles, ...page.paragraphs.filter((q) => q.id !== p.id).map((q) => q.box), ...occupied];
	let fallback;
	for (const keepWords of [true, false]) {
		let box = { ...(p.layoutBox ?? p.box) };
		for (let n = Math.round(initialScale * 100); n >= 10; n -= n > 60 ? 5 : 10) {
			const scale = n / 100;
			if (!p.fixedBox && n === 65) box = expandedBox({ ...p, box }, page, obstacles, false);
			if (!p.fixedBox && n === 60) box = expandedBox({ ...p, box }, page, obstacles, true);
			const result = place(p, units, box, scale, fonts, keepWords);
			fallback = result;
			if (result.fits) return result;
		}
	}
	if (!fallback) throw new Error(`Cannot typeset ${p.id}`);
	return fallback;
}

/** Full-document pass, then a translated-unit-weighted common scale pass. */
export function layoutReflowDocument(ir, translations, fonts, commonScale = true) {
	const result = ir.pages.map((page) => {
		const paragraphs = [];
		for (const p of page.paragraphs) {
			const text = translations.get(p.id);
			if (text === undefined) continue;
			paragraphs.push(layoutParagraph(p, text, page, fonts, 1, paragraphs.map((q) => q.box)));
		}
		return { index: page.index, width: page.width, height: page.height, paragraphs };
	});
	const weights = new Map();
	for (const page of ir.pages)
		for (const p of page.paragraphs) {
			const placed = result.find((r) => r.index === page.index)?.paragraphs.find((r) => r.id === p.id);
			if (placed) {
				const weight = placed.units.reduce(
					(sum, u) => sum + (u.formula ? u.formula.characterIndexes.length : Array.from(u.text).length),
					0,
				);
				weights.set(placed.scale, (weights.get(placed.scale) ?? 0) + weight);
			}
		}
	const common = [...weights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 1;
	for (const page of result) {
		const source = ir.pages.find((p) => p.index === page.index);
		if (!source) continue;
		page.paragraphs = page.paragraphs.map((layout) => {
			const p = source.paragraphs.find((q) => q.id === layout.id);
			const text = translations.get(layout.id);
			if (!commonScale || !p || !text || layout.scale <= common) return layout;
			const candidate = layoutParagraph(
				p,
				text,
				source,
				fonts,
				common,
				page.paragraphs.filter((q) => q.id !== p.id).map((q) => q.box),
			);
			return candidate.fits ? candidate : layout;
		});
		// A translated paragraph must not paint over another paragraph's source.
		for (const p of page.paragraphs)
			if (source.paragraphs.some((q) => q.id !== p.id && intersects(p.box, q.box) && !intersects(p.sourceBox, q.box)))
				p.fits = false;
	}
	return result;
}
