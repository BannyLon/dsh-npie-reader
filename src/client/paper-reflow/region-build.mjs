// Ported from motif (Copyright (c) 2026 poco-ai, MIT). See MOTIF-LICENSE.txt.
//
// JS port of `paragraphFromCharacters()` + `extractReflowDocument()` in
// packages/pdf/src/client/translation/extract.ts, minus the two things pdf.js
// cannot supply (font identity for math islands, layout-model regions).
//
// ★ 0.71.2：上一版是**裁剪版**（文件头写着 "no formula islands, no style spans"），
//   裁掉的那一层里有一个不是可选项的东西 —— `anchors` 归行。作者/机构区那种
//   「Haoyu Lu* ¹、Wen Liu* ¹」的排版里，上标 ¹ 是一个**独立基线**的字符，
//   裁剪版把它当成一行正文，于是原文变成 "1† 1 1‡ 1† …" 开头的怪物串，段框
//   还和相邻行互相重叠 → 中文盖在英文上。上游用「只拿正文字号的字符建行，再把
//   小字号字符按垂直中心挂回最近的行」解决它，这里原样搬回来。

import { groupReadingLines } from "./reading-order.mjs";
import { regionsFromRuns } from "./regions.mjs";
import { unionBoxes } from "./types.mjs";

const centerInside = (a, b) =>
	a.x + a.w / 2 >= b.x && a.x + a.w / 2 <= b.x + b.w && a.y + a.h / 2 >= b.y && a.y + a.h / 2 <= b.y + b.h;

/** 数学字体名。pdf.js 给的是 `g_d0_f1` 这类内部名，这条在 pdf.js 上几乎永不命中；
 *  保留它是为了将来换字体身份真名时不用再改结构。判公式真正起作用的是下面的字号规则。 */
const mathFont = /(?:CMSY|CMEX|CMMI|MSAM|MSBM|Math|Symbol|STIX.*(?:Math|Symbols))/i;

function dominantStyle(chars) {
	const weights = new Map();
	for (const c of chars) {
		if (!c.text.trim()) continue;
		const key = `${c.style.font}|${c.style.size}|${c.style.bold}|${c.style.italic}`;
		const entry = weights.get(key) ?? { style: c.style, count: 0 };
		entry.count++;
		weights.set(key, entry);
	}
	return [...weights.values()].sort((a, b) => b.count - a.count)[0]?.style ?? chars[0].style;
}

const lineCenter = (line) => {
	const boxes = line.items.map((c) => c.box);
	const left = Math.min(...boxes.map((b) => b.x));
	const right = Math.max(...boxes.map((b) => b.x + b.w));
	return (left + right) / 2;
};

/**
 * 连字与软连字符修复（上游 `normalizeTranslationSource()` 的同一条判据）。
 *
 * ★ PDF 字体里的 `ﬁ` `ﬂ` `ﬀ` 是**一个字形**，取出来就是一个字符。pdf.js 有时
 *   按 ToUnicode 还原成 fi，有时原样给出 —— 原样给出时，「different」会变成
 *   「diﬀerent」发给模型，模型通常会照抄这个怪字，于是译文里也带一个 ﬀ。
 *   软连字符（U+00AD）与零宽空格更是完全不可见，留在原文里只会干扰断词。
 */
const LIGATURES = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
function healSource(text) {
	return text
		.normalize("NFC")
		.replace(/[\u00ad\u200b]/gu, "")
		.replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/gu, (hit) => LIGATURES[hit] ?? hit);
}

function emptyParagraph(id, pageIndex, box, heading, style) {
	return {
		id, pageIndex, box, characters: [], formulas: [], styles: {},
		source: "", protectedText: "", style, firstLineIndent: 0, heading, center: false,
	};
}

export function paragraphFromChars(id, pageIndex, box, chars, heading) {
	const style = dominantStyle(chars);
	// 嵌在正文里的图片自带局域坐标的小字，其未变换字号不能被当成上标。
	if (style.size >= 4) {
		const kept = chars.filter((c) => c.style.size >= style.size * 0.3);
		if (kept.length) chars = kept;
	}
	if (!chars.length) return emptyParagraph(id, pageIndex, box, heading, style);

	// ① 只用「正文字号、非数学字体」的字符建行 —— 上标 / 脚注符号不算独立行。
	const anchors = chars.filter((c) => c.style.size >= style.size * 0.85 && !mathFont.test(c.style.font));
	const lines = groupReadingLines(anchors.length ? anchors : chars, (c) => ({
		x: c.box.x, y: c.box.y, width: c.box.w, height: c.box.h,
	}));

	// ② 再把小字号字符按垂直中心挂回最近的那一行，同行内按 x 排序 ⇒ 上标回到
	//    它本来的词后面，而不是被排成一串 "1† 1‡" 顶在段首。
	if (anchors.length) {
		const isAnchor = new Set(anchors);
		for (const c of chars) {
			if (isAnchor.has(c)) continue;
			const middle = c.visualBox.y + c.visualBox.h / 2;
			let best;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (const line of lines) {
				const distance = Math.abs(middle - (line.top + line.bottom) / 2);
				if (distance < bestDistance) {
					best = line;
					bestDistance = distance;
				}
			}
			if (best && bestDistance < style.size) best.items.push(c);
			else lines.push({ items: [c], top: c.box.y, bottom: c.box.y + c.box.h });
		}
	}
	lines.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
	if (!lines.length) return emptyParagraph(id, pageIndex, box, heading, style);
	const ordered = lines.flatMap((line) => line.items.sort((a, b) => a.box.x - b.box.x || a.index - b.index));

	// ③ 拼原文：词间补空格、行末软连字符接上、行间用一个空格连接。
	let source = "";
	lines.forEach((line, lineIndex) => {
		let previous;
		for (const c of line.items) {
			if (
				previous &&
				c.box.x - (previous.box.x + previous.box.w) > style.size * 0.16 &&
				!/\s$/.test(source) &&
				!/^\s/.test(c.text)
			)
				source += " ";
			source += c.text;
			previous = c;
		}
		source = source.trimEnd();
		if (lineIndex < lines.length - 1) {
			if (/[-\u00ad]$/.test(source) && /^[a-z]/.test(lines[lineIndex + 1]?.items[0]?.text ?? "")) source = source.slice(0, -1);
			else source += " ";
		}
	});

	const first = Math.min(...(lines[0]?.items ?? []).map((c) => c.box.x));
	const subsequent = lines.slice(1).map((l) => Math.min(...l.items.map((c) => c.box.x)));
	const left = subsequent.length ? Math.min(first, ...subsequent) : first;

	// ④ 居中块（论文标题、作者区）：每一行的水平中心几乎一致。上游没有这一步，
	//    因为 layout.json 会直接给「这行是居中的」；纯文本回退只能自己判。
	//    判据要**同时**满足两条，缺一条就会把两端对齐的正文误判成居中：
	//      ① 各行水平中心相差不超过 1.5 个字身；
	//      ② 各行的左边界或右边界确实参差 —— 两端对齐的正文左右边界都齐平，
	//         若只看中心，它每一行中心都相等，会被整体逐行居中 ⇒ 左边缘变锯齿轮廓。
	const centers = lines.map(lineCenter);
	const lefts = lines.map((l) => Math.min(...l.items.map((c) => c.box.x)));
	const rights = lines.map((l) => Math.max(...l.items.map((c) => c.box.x + c.box.w)));
	const spread = (values) => Math.max(...values) - Math.min(...values);
	const maxRight = Math.max(...rights);
	// 「贴右边界」的行数：两端对齐的段落每行都贴右边界；居中块只有最宽的那一行贴。
	const flushRight = rights.filter((right) => right >= maxRight - style.size * 0.5).length;
	const centered =
		centers.length >= 2 &&
		centers.every((c) => Math.abs(c - centers[0]) <= style.size * 1.5) &&
		// ① 左边界必须参差（两端对齐的正文左边界齐平）。
		spread(lefts) > style.size * 0.8 &&
		// ② 最多只有一行贴右边界。★ 这条是必须的：正文的**首行缩进**会让左边界
		//    出现 1 个字身的差、各行之中心又几乎相同，只看 ① 会把一整段两端对齐的
		//    正文判成居中，逐行居中之后左边缘就成了锯齿轮廓。缩进段落每行都贴右
		//    边界，居中块只有最宽那行贴 —— 用它把两者分开。
		flushRight <= 1;

	return {
		id,
		pageIndex,
		box,
		characters: ordered,
		formulas: [],
		styles: {},
		source: healSource(source).trim(),
		protectedText: healSource(source).trim(),
		style,
		firstLineIndent: centered || first - left <= style.size * 0.5 ? 0 : first - left,
		heading,
		center: centered,
	};
}

/**
 * 未归入任何区域的字符 → 段落。
 *
 * 上游按 `textObjectId` 分组（PDFium 给得出「这些字属于同一个文本对象」），pdf.js
 * 没有这个字段，所以这里退化成「按阅读行分组 → 相邻行再纵向合并」。合并判据比
 * 区域检测宽：只要字号一致、行距紧凑、水平有重叠就认为是一段，目的是别让每个
 * 单行各自成段 —— 一行的段框装不下中文，只会变成「放不下 → 留英文」。
 */
function fallbackGroups(lines) {
	const merged = [];
	for (const line of lines) {
		const box = unionBoxes(line.items.map((c) => c.box));
		const size = Math.max(...line.items.map((c) => c.style.size));
		const prior = merged.at(-1);
		if (prior) {
			const gap = box.y - (prior.box.y + prior.box.h);
			const overlap = Math.min(prior.box.x + prior.box.w, box.x + box.w) - Math.max(prior.box.x, box.x);
			if (
				gap > -size * 0.35 && gap < size * 0.9 &&
				Math.abs(prior.size - size) < 1 &&
				overlap > Math.min(prior.box.w, box.w) * 0.5
			) {
				prior.box = unionBoxes([prior.box, box]);
				prior.items.push(...line.items);
				continue;
			}
		}
		merged.push({ box, size, items: [...line.items] });
	}
	return merged;
}

/** Build a ReflowPage from one collected pdf.js page. */
export function buildPageIR(payload) {
	const { index, width, height, runs, chars } = payload;
	const regions = regionsFromRuns(runs, index, width, height);
	const claimed = new Set();
	const paragraphs = [];
	for (const region of regions) {
		const owned = chars.filter((c) => !claimed.has(c.index) && centerInside(c.visualBox, region.rect));
		if (!owned.length) continue;
		const box = unionBoxes(owned.filter((c) => c.text.trim()).map((c) => c.box));
		if (!(box.w > 0 && box.h > 0)) continue;
		for (const c of owned) claimed.add(c.index);
		const p = paragraphFromChars(region.id, index, box, owned, region.kind === "header");
		if (p.source.length < 2) continue;
		paragraphs.push(p);
	}
	// Anything the region pass missed (caps, footnotes, page numbers) becomes a
	// fixed-box fallback paragraph so the probe can report it instead of losing it.
	const unclaimed = chars.filter((c) => !claimed.has(c.index) && c.text.trim());
	if (unclaimed.length) {
		const lines = groupReadingLines(unclaimed, (c) => ({ x: c.box.x, y: c.box.y, width: c.box.w, height: c.box.h }));
		for (const group of fallbackGroups(lines)) {
			const items = [...group.items].sort((a, b) => a.box.x - b.box.x || a.index - b.index);
			const p = paragraphFromChars(`${index}:fallback:${items[0].index}`, index, group.box, items, false);
			if (!/\p{L}{2}/u.test(p.source)) continue;
			p.fixedBox = true;
			p.origin = "fallback";
			paragraphs.push(p);
		}
	}
	/**
	 * ★ 段框互斥：两个段的原文框若重叠，两块白底就会互相盖住、两段中文叠在一起
	 *   —— 用户截图里作者区那团乱码正是这么来的。这里按面积重叠率 (>15%) 或
	 *   互相包含判定，**后来的段让位**（它的字留在画布上，保持原样）。
	 *   宁可一段留英文，也不能两段叠着。
	 */
	const kept = [];
	for (const p of paragraphs) {
		const clash = kept.some((q) => {
			const w = Math.min(p.box.x + p.box.w, q.box.x + q.box.w) - Math.max(p.box.x, q.box.x);
			const h = Math.min(p.box.y + p.box.h, q.box.y + q.box.h) - Math.max(p.box.y, q.box.y);
			if (w <= 0 || h <= 0) return false;
			const area = Math.min(p.box.w * p.box.h, q.box.w * q.box.h);
			return area > 0 && (w * h) / area > 0.15;
		});
		if (!clash) kept.push(p);
	}
	kept.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
	return { index, width, height, paragraphs: kept, obstacles: [] };
}
