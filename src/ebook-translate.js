/**
 * 电子书**对照翻译**的判据（宿主与渲染端共用）。
 *
 * 为什么这里是纯函数、没有 IO：
 *   「送哪几块去翻」和「译文贴回哪一块」必须由**同一套判据**决定。
 *   宿主送出去的编号，和渲染端要找的编号只要差一次过滤（比如宿主跳过了 `pre`、
 *   渲染端没跳），就会变成「每一段下面都挂着别处的译文」—— 页面结构完全正常，
 *   只是每一句都错位，比「没翻译」难发现得多。这种错只能靠共用一份代码来避免。
 *
 * 与文章的「保结构翻译」（`src/host/structure-translate.js`）的关系：
 *   那边处理的是 HTML，要按文本节点切片段、再写回去；电子书正文**本来就是块**
 *   （`{ k, x }`，纯文本），结构天然保留。所以这里只做三件事：
 *   挑出该翻的块 → 编号 → 让译文按编号落回原下标。
 *
 * ★ 编号用**块下标**，而不是「第几个可翻块」：
 *   前者在渲染端一眼可得（`blocks.map` 的下标就是），后者要再算一遍过滤，
 *   而两次过滤的条件一旦漂移，整节译文就会整体错位。
 */
import { planTranslationChunks } from './host/structure-translate.js';

/** 汉字（含扩展 A / 兼容区）。判「这段是不是中文」用。 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u;

/** 字母（不限语种）。算比例时分母用它 —— 数字与标点不该影响语言判断。 */
const LETTER = /\p{L}/u;

/** 代码块永远不翻。`pre` 里是缩进与符号，翻了只会得到一段废译文。 */
const SKIP_KINDS = new Set(['pre']);

/**
 * 一个块要不要翻。
 *
 * 四条各自对应一个真实形态：
 *   ① 空块 —— 源 HTML 的间距产物，渲染端本来就跳过；
 *   ② `pre` —— 代码 / 排版诗，翻了会毁掉缩进；
 *   ③ **已经是中文** —— 中英混排的书（双语版、脚注）不该把中文再「译」一遍，
 *      否则对照栏里会出现一段与原文几乎一样的字，纯属噪音；
 *   ④ 没有任何字母 —— 页码、「* * *」这类分隔符。
 */
function translatable(block) {
  const kind = String(block?.k ?? 'p');
  if (SKIP_KINDS.has(kind)) return false;
  const text = String(block?.x ?? '').trim();
  if (text === '') return false;
  if (!LETTER.test(text)) return false;
  if (cjkRatio(text) >= 0.5) return false;
  return true;
}

/**
 * 「这本书是中文书」的比例门槛（0.62.0）。
 *
 * ★ 0.7 是**量出来的**，不是拍的（本机实测 2026-11-03）：
 *   纯中文书 0.93–0.98（《越红钩》107 节 0.964）／纯英文书 0.000
 *   （Wuthering Heights 36 节）／中英双语排版（一段英文一段中文）≈ 0.5。
 *   取 0.7 让前两者判得干脆，同时**不把双语版误判成中文** —— 那才是真需要对照的书。
 */
export const CHINESE_BOOK_RATIO = 0.7;

/**
 * 判定语种所需的最少字母数。低于它不表态。
 *
 * 一本只有封面、版权页的书不该被说成「中文书」然后从助手列表里消失 ——
 * 「不知道」和「知道是中文」是两件事。
 */
const SCRIPT_MIN_LETTERS = 200;

/** 数一段文字的字母数 / 汉字数。`cjkRatio` 与 `bookScript` 共用，避免两套数法。 */
function countLetters(text) {
  let letters = 0;
  let cjk = 0;
  for (const char of String(text ?? '')) {
    if (!LETTER.test(char)) continue;
    letters += 1;
    if (CJK.test(char)) cjk += 1;
  }
  return { letters, cjk };
}

/**
 * 文本里汉字占「字母」的比例。
 *
 * ★ 分母是字母而不是全部字符：英文段落里标点、数字、空格占三成，
 *   按全字符算会把一段纯英文的比值压到 0.1 以下，判断本身没错但阈值难调；
 *   按字母算，纯英文≈0、纯中文≈1，中间那段（人名夹中文）才是真正需要判断的。
 */
export function cjkRatio(text) {
  const { letters, cjk } = countLetters(text);
  return letters === 0 ? 0 : cjk / letters;
}

/**
 * 这本书是「中文书」还是「外文书」。
 *
 * ★ 为什么必须有这一条（0.62.0，用户原话「这三本都是中文，不需要翻译的啊。
 *   你判断写的不对」）：{@link translatable} 是**逐块**判的 —— 一块里汉字占到一半
 *   才算中文。于是「我现在的几位同事……这些人包括 PaulHodges」这种段落（一百多个
 *   汉字里夹一串英文人名）会被判成「该翻」，一本纯中文书因此冒出几节「可翻文字」，
 *   整本书就被当成外文书摆进了翻译助手（实测《越红钩》107 节里有 8 节中招，
 *   于是界面写着「共 8 节」）。**一本书的语种是全书的结论，不该由几个混排段落决定。**
 *
 * ★ 按字符量加权，不按节、不看多数票：一节只有一行「ISBN 978…stphbooks」的版权页
 *   与一节三千字的正文，按节投票时分量一样重 —— 那是错的。整本累计字母数才是真实的
 *   语言分布。
 *
 * ★ 与 {@link translatable} 的分工：那条管「这一块要不要翻」（英文书里夹中文脚注、
 *   双语版里的中文段落，靠它跳过），这条管「这本书要不要翻」。两级判据各管一层，
 *   不合并 —— 合并会让英文书里的中文脚注跟着被「译」一遍。
 *
 * @param ebook - `parseEbook()` 的产物，只用 `sections[].blocks[].x`。
 * @returns `{ script, ratio, letters }`；`script` ∈ `'zh' | 'latin' | 'unknown'`
 *   （`unknown` = 字母太少，不表态）。
 */
export function bookScript(ebook) {
  const sections = Array.isArray(ebook?.sections) ? ebook.sections : [];
  let letters = 0;
  let cjk = 0;
  for (const section of sections) {
    const blocks = Array.isArray(section?.blocks) ? section.blocks : [];
    for (const block of blocks) {
      const counted = countLetters(block?.x);
      letters += counted.letters;
      cjk += counted.cjk;
    }
  }
  const ratio = letters === 0 ? 0 : cjk / letters;
  if (letters < SCRIPT_MIN_LETTERS) return { script: 'unknown', ratio, letters };
  return { script: ratio >= CHINESE_BOOK_RATIO ? 'zh' : 'latin', ratio, letters };
}

/**
 * 这一节里**该翻的块**，编号 = 块下标。
 *
 * @param blocks - 块模型 `[{ k, x }]`。
 * @returns `[{ id, text, group }]`；`group` 恒为 0，
 *   因为电子书的每一块都是独立段落 —— 按块分组会让 `buildTranslatePrompt`
 *   在每两条之间插一个空行，既浪费 token 又暗示「这些块属于同一句」。
 */
export function blockSegments(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const out = [];
  list.forEach((block, index) => {
    if (!translatable(block)) return;
    out.push({ id: index, text: String(block.x).trim(), group: 0 });
  });
  return out;
}

/**
 * 切批。
 *
 * 直接复用文章那条分批器：字符预算、上下文预算、块数上限都是同一套实测值。
 * 一节通常只有几千字（= 一批），长节会自动切成多批，失败只影响那一批。
 *
 * @returns `{ segments, chunks }`；`chunks` 每项 `{ segments, context }`。
 */
export function planBlockChunks(blocks, options = {}) {
  const segments = blockSegments(blocks);
  return { segments, chunks: planTranslationChunks(segments, options) };
}

/**
 * 覆盖率：送出去的块里有多少块真的拿到了译文。
 *
 * ★ 必须如实带出去。模型漏条目时界面若说「已翻译」，用户看到的却是中英混排，
 *   第一反应是「这插件坏了」；说「本节 18 段，译出 15 段」才是可核对的事实。
 */
export function blockCoverage(segments, translations) {
  const list = Array.isArray(segments) ? segments : [];
  let done = 0;
  for (const segment of list) {
    const value = translations?.get?.(segment.id);
    if (typeof value === 'string' && value.trim() !== '') done += 1;
  }
  return { total: list.length, done, ratio: list.length === 0 ? 1 : done / list.length };
}

/**
 * 把「编号 → 译文」摊平成可落盘的数组，并按原块顺序排好。
 *
 * 用数组而不是对象：块下标是连续整数，对象在 JSON 里会变成字符串键，
 * 读回来还得再 `Number()` 一遍 —— 那一处转换漏掉时，`Map.get('7')` 与
 * `Map.get(7)` 不相等，症状是「缓存明明写了却读不到」，而且不报错。
 */
export function entriesOf(translations) {
  if (!(translations instanceof Map)) return [];
  return [...translations.entries()]
    .filter(([id, text]) => Number.isInteger(id) && typeof text === 'string' && text.trim() !== '')
    .sort((a, b) => a[0] - b[0]);
}

/** 落盘数组 → Map。非法项直接丢，不抛 —— 一份坏缓存不该让书读不了。 */
export function mapOfEntries(entries) {
  const map = new Map();
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(item)) continue;
    const [id, text] = item;
    if (!Number.isInteger(id) || typeof text !== 'string' || text.trim() === '') continue;
    map.set(id, text);
  }
  return map;
}

/**
 * 渲染用的对照行：每个可见块一行，附上它的译文（没有就是空串）。
 *
 * ★ 这里**不做过滤差异**：`zhMap` 的键是块下标，与 `blocks` 的下标同源，
 *   所以跳过块（空块、`pre`）不会让后面的译文前移一格。这正是用下标做编号的理由。
 * ★ `pre` 的译文**强制为空**，与渲染层 `renderBlocks` 的兜底保持同一语义：
 *   代码块不翻，缓存里即便混进一条也不显示。两处判据若不一致，将来换一处实现
 *   就会出现「代码块下面挂着一句中文」——那看起来像排版事故，不像 bug。
 */
export function contrastRows(blocks, zhMap) {
  const list = Array.isArray(blocks) ? blocks : [];
  const rows = [];
  list.forEach((block, index) => {
    const text = String(block?.x ?? '');
    if (text.trim() === '') return;
    const kind = String(block?.k ?? 'p');
    const zh = kind === 'pre' ? undefined : zhMap?.get?.(index);
    rows.push({
      i: index,
      k: kind,
      x: text,
      zh: typeof zh === 'string' && zh.trim() !== '' ? zh.trim() : '',
    });
  });
  return rows;
}
