// Ported from motif (Copyright (c) 2026 poco-ai, MIT). See MOTIF-LICENSE.txt.
// JS port of packages/pdf/src/client/translation/types.ts (types erased, runtime helpers kept).

export const formulaToken = (id) => `⟪F${id}⟫`;

export function unionBoxes(boxes) {
	if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
	const x = Math.min(...boxes.map((b) => b.x));
	const y = Math.min(...boxes.map((b) => b.y));
	return {
		x,
		y,
		w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
		h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
	};
}

export function intersects(a, b) {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Formula and style tags are a structural contract, not ordinary prose. */
export function validReflowTranslation(p, text) {
	const formulas = new Set();
	const opened = new Set();
	const closed = new Set();
	let active;
	for (const match of text.matchAll(/⟪(F|S|\/S)(\d+)⟫/gu)) {
		const kind = match[1];
		const id = match[2];
		if (kind === "F") {
			if (!p.formulas.some((f) => f.id === id) || formulas.has(id)) return false;
			formulas.add(id);
		} else if (kind === "S") {
			if (active || !p.styles[id] || opened.has(id)) return false;
			active = id;
			opened.add(id);
		} else {
			if (active !== id || closed.has(id)) return false;
			active = undefined;
			closed.add(id);
		}
	}
	return (
		!active &&
		p.formulas.every((f) => formulas.has(f.id)) &&
		Object.keys(p.styles).every((id) => opened.has(id) && closed.has(id))
	);
}

export function reflowDisplayText(p, text) {
	return text
		.replace(/⟪F(\d+)⟫/gu, (_, id) => p.formulas.find((f) => f.id === id)?.text ?? "")
		.replace(/⟪\/?S\d+⟫/gu, "");
}
