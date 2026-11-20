// Ported from motif (Copyright (c) 2026 poco-ai, MIT). See MOTIF-LICENSE.txt.
// JS port of the text-only fallback in packages/pdf/src/client/translation/regions.ts

import { groupReadingLines } from "./reading-order.mjs";
import { unionBoxes } from "./types.mjs";

const DEBUG = typeof process !== "undefined" && process.env?.DEBUG_SEG === "1";

/**
 * Text-only fallback: baseline grouping from motif, split columns before joining paragraphs.
 * `runs` here are the pdf.js-derived runs (see adapter.mjs).
 */
export function regionsFromRuns(runs, pageIndex, width, height) {
	const usable = runs.filter((run) => run.text.trim() && run.rect.size.width > 0 && run.rect.size.height > 0);
	const lines = groupReadingLines(usable, (run) => ({ ...run.rect.origin, ...run.rect.size }));
	const fragments = [];
	for (const line of lines) {
		let group = [];
		const flush = () => {
			if (!group.length) return;
			const rect = unionBoxes(
				group.map((r) => ({ x: r.rect.origin.x, y: r.rect.origin.y, w: r.rect.size.width, h: r.rect.size.height })),
			);
			fragments.push({
				box: rect,
				size: Math.max(...group.map((r) => r.fontSize)),
				bold: group.every((r) => r.font.weight >= 600),
				text: group.map((r) => r.text).join(" "),
			});
			group = [];
		};
		for (const run of line.items) {
			const last = group.at(-1);
			if (last && run.rect.origin.x - last.rect.origin.x - last.rect.size.width > Math.max(last.fontSize, run.fontSize) * 1.5)
				flush();
			group.push(run);
		}
		flush();
	}
	const groups = [];
	const median = (values) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)] ?? 0;
	};
	/**
	 * ★ 栏宽基准取**整页行宽的中位数**，不取「本组已有行」的中位数。
	 *   本组只有一行时（标题的第一行、段首行），中位数就是它自己 ⇒ 「上一行写满了」
	 *   恒为真，原先用来区分「段末行」的信号直接失效：标题第二行因此永远并不进第一行。
	 */
	const pageLineWidth = median(fragments.filter((f) => /\p{L}/u.test(f.text)).map((f) => f.box.w));
	for (const fragment of fragments) {
		// ★ 纯符号行（上标 ¹、†、‡、脚注标记）不是正文行：让它自己成段，段框就只有
		//   一行高、还和相邻行重叠 —— 那正是作者区那团乱码的来源。丢掉它，它的字
		//   会在 buildPageIR 里按「中心落在哪个段框内」被并进真正的那一段。
		if (!/\p{L}/u.test(fragment.text)) continue;
		const prior = groups.findLast((g) => {
			const gap = fragment.box.y - g.box.y - g.box.h;
			// motif 的版面模型直接给段落框；纯文本回退要自己判段界。
			// 用中位数估计栏左边界与栏宽：单行的极值（行首连字符、公式）会污染极值法。
			const colLeft = median(g.lefts);
			const prevLineFull = g.lastW > pageLineWidth * 0.9;
			const sameColumn = Math.abs(fragment.box.x - colLeft) < fragment.size * 2.5;
			const indented = fragment.box.x > colLeft + fragment.size * 0.5;
			// 段界只认一个信号：上一行没有写到右边界（段末行）。缩进不能作判据——
			// 列表的悬挂缩进会让每个续行都「缩进」，从而被切成一行一段。
			//
			// ★ 居中块（论文标题、作者 / 机构区）走另一条判据：这类行**每行都短**，
			//   用「上一行写满」永远不成立，于是标题被切成两段、作者区被切成一团。
			//   它们的共同特征是**各行水平中心几乎一致**，用它来判。
			const centerAligned = Math.abs((fragment.box.x + fragment.box.w / 2) - g.lastCenter) < fragment.size * 2;
			// ★ 居中分支看的是**当前行**有没有写满，不是上一行。标题的第一行往往就是全页
			//   最宽的一行（它就是「写满」的），用「上一行写满」当门槛会让标题第二行
			//   永远并不回去。而正文的下一个段首行是写满的 ⇒ 不会被误并。
			const fragmentFull = fragment.box.w > pageLineWidth * 0.9;
			const ok =
				gap > -fragment.size * 0.6 &&
				gap < fragment.size * 0.9 &&
				Math.abs(g.size - fragment.size) < 1 &&
				g.bold === fragment.bold &&
				((sameColumn && prevLineFull) || (centerAligned && !fragmentFull));
			if (DEBUG && !ok && sameColumn && gap > -2 && gap < 6)
				console.log(
					`NO-MERGE y=${fragment.box.y.toFixed(1)} gap=${gap.toFixed(1)} x=${fragment.box.x.toFixed(1)}/${colLeft.toFixed(1)} prevFull=${prevLineFull}(${g.lastW.toFixed(0)}/${pageLineWidth.toFixed(0)}) indented=${indented} :: ${fragment.text.slice(0, 36)}`,
				);
			return ok;
		});
		if (prior) {
			prior.box = unionBoxes([prior.box, fragment.box]);
			prior.text += ` ${fragment.text}`;
			prior.lastW = fragment.box.w;
			prior.lastCenter = fragment.box.x + fragment.box.w / 2;
			prior.lefts.push(fragment.box.x);
			prior.widths.push(fragment.box.w);
		} else
			groups.push({
				...fragment,
				lastW: fragment.box.w,
				lastCenter: fragment.box.x + fragment.box.w / 2,
				lefts: [fragment.box.x],
				widths: [fragment.box.w],
			});
	}
	const sizes = usable.map((r) => r.fontSize).sort((a, b) => a - b);
	const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 10;
	return groups
		.filter((g) => /\p{L}{2}/u.test(g.text))
		.map((g, index) => ({
			id: `${pageIndex}:text:${index}`,
			pageIndex,
			readingOrder: index,
			score: 1,
			kind: g.size > bodySize * 1.2 || (g.bold && g.text.length < 100) ? "header" : "text",
			label: "text",
			rect: g.box,
			bbox: { x: g.box.x / width, y: g.box.y / height, w: g.box.w / width, h: g.box.h / height },
		}));
}
