/**
 * 论文条目 → BibTeX。
 *
 * 纯函数、零依赖：宿主（`/papers/:id/bibtex`、Agent 工具）与浏览器（「复制 BibTeX」）
 * 共用同一份。这类「拼字符串」的逻辑一旦写两处，导出的 `.bib` 就一定有两副样子。
 *
 * ★ 三条克制：
 *   1. **不猜字段**。没有 venue 就不写 `journal`；没有 DOI 就不写 `doi`。
 *      编一个空字段出来会让用户在 LaTeX 里看到 `journal = {}`，比缺字段更糟。
 *   2. **标题套双层花括号** `{{…}}`：BibTeX 会把标题转成小写（`attention is all…`），
 *      双层括号是唯一能让「arXiv / BERT / Transformer」保持原样的写法。
 *   3. **只对 LaTeX 里真有特殊含义的字符转义**（`& % $ # _ { } ~ ^ \`）。
 *      把整段按 HTML 那套转一遍会得到 `&amp;` 这种在 .bib 里毫无意义的东西。
 */

/**
 * 需要转义的字符 → 替换。
 *
 * ★ 必须是**一次扫描**（`replace` 带回调），不能按顺序连做十次 `split/join`：
 *   `\` 的替换品 `\textbackslash{}` 自己带花括号与反斜杠，后面那几轮会把它们
 *   再转一遍，得到 `\textbackslash\{\}` —— 编译时直接报错。
 */
const ESCAPES = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/** 把一段普通文本变成可以安全放进 `.bib` 字段的值（不含外层引号/花括号）。 */
export function escapeBibtex(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\&%$#_{}~^]/g, (ch) => ESCAPES[ch]);
}

/** BibTeX 的 `and` 分隔作者；单个名字里的 `,`（`Last, First`）要保持不动，所以只清空白。 */
function formatAuthors(authors) {
  return (Array.isArray(authors) ? authors : [])
    .map((name) => String(name ?? '').replace(/\s+/g, ' ').trim())
    .filter((name) => name !== '')
    .join(' and ');
}

/**
 * 引用键：`姓 + 年 + 标题首个实词`，全小写、只留字母数字。
 *
 * ★ 不做重名去重（`a2020x` / `a2020xa`）：同一批里有重键时，正确的处理是让用户
 *   在 Zotero / JabRef 里看见冲突，而不是我们悄悄加后缀 —— 加了之后他复制的键
 *   与后面再导一次得到的键对不上。
 */
export function citeKeyFor(paper) {
  const firstAuthor = (Array.isArray(paper?.authors) ? paper.authors[0] : '') ?? '';
  // 取「最后一个词」当姓：`Ashish Vaswani` → `vaswani`；`Vaswani, Ashish` → `vaswani`。
  const surname = String(firstAuthor).split(',')[0].trim().split(/\s+/).pop() ?? '';
  const year = Number(paper?.year) > 0 ? String(Math.trunc(paper.year)) : '';
  const stop = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'in', 'to', 'and', 'with', 'is', 'are', 'towards', 'toward']);
  const word = String(paper?.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .find((item) => item.length > 2 && !stop.has(item)) ?? '';
  const key = `${surname}${year}${word}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  // 全空（手写的、没作者没标题的条目）也要有个能编译的键 —— 空串会让 `\cite{}` 直接报错。
  return key === '' ? `paper${String(paper?.id ?? '').replace(/[^a-z0-9]/gi, '')}` : key;
}

/**
 * 条目类型：有 venue 当期刊/会议文章，只有 arXiv 的当 `@misc`（带 eprint）。
 *
 * ★ 这里**不区分** `@article` 与 `@inproceedings`：我们手里只有 `venue` 一个字符串，
 *   「NeurIPS」到底是会议还是期刊没法可靠判断。统一 `@article` + `journal` 是 BibTeX
 *   里最宽容的写法（两种 bst 都能编过），猜错的代价比「编不过」小。
 */
export function entryTypeFor(paper) {
  const venue = String(paper?.venue ?? '').trim();
  if (venue !== '') return 'article';
  if (String(paper?.arxivId ?? '').trim() !== '') return 'misc';
  if (String(paper?.doi ?? '').trim() !== '') return 'article';
  return 'misc';
}

/**
 * 一条论文 → 一段 BibTeX（末尾带换行）。
 *
 * @param {object} paper `PaperStore` 的条目（或任何同形对象）
 * @param {{ key?: string }} [options] 显式指定引用键（导出整库时用来去重）
 */
export function bibtexFor(paper, { key } = {}) {
  if (paper === null || typeof paper !== 'object') return '';
  const type = entryTypeFor(paper);
  const fields = [];
  const push = (name, value) => {
    const clean = String(value ?? '').trim();
    if (clean !== '') fields.push(`  ${name} = {${clean}}`);
  };

  push('title', `{${escapeBibtex(paper.title)}}`);
  push('author', formatAuthors(paper.authors).split(' and ').map((name) => escapeBibtex(name)).join(' and '));
  // 年份写成裸数字：`year = {2026}` 两种 bst 都认，而 `year = 2026` 有些解析器会报错。
  if (Number(paper.year) > 0) push('year', String(Math.trunc(paper.year)));
  if (type === 'article') push('journal', escapeBibtex(paper.venue));
  if (String(paper.doi ?? '').trim() !== '') push('doi', escapeBibtex(paper.doi));
  if (String(paper.arxivId ?? '').trim() !== '') {
    push('eprint', escapeBibtex(paper.arxivId));
    push('archivePrefix', 'arXiv');
    const primary = Array.isArray(paper.categories) ? paper.categories[0] : '';
    if (primary) push('primaryClass', escapeBibtex(primary));
  }
  if (String(paper.url ?? '').trim() !== '') push('url', escapeBibtex(paper.url));
  // 标签留在 `keywords`：这是唯一「用户自己攒的、对文献管理有用的」字段。
  if (Array.isArray(paper.tags) && paper.tags.length > 0) push('keywords', paper.tags.map(escapeBibtex).join(', '));

  const citeKey = String(key ?? '').trim() || citeKeyFor(paper);
  return `@${type}{${citeKey},\n${fields.join(',\n')}\n}\n`;
}

/**
 * 多条 → 一个 `.bib` 文件的内容。
 *
 * ★ 键冲突时**只在这一处**加字母后缀（`a` / `b` / …）：整库导出是一个文件，
 *   同一个 key 出现两次会让 BibTeX 报 `Repeated entry`，整个文件编不过 ——
 *   这不是「好看一点」的问题，是能不能用的分界。
 */
export function bibtexFile(papers) {
  const seen = new Map();
  const blocks = [];
  for (const paper of Array.isArray(papers) ? papers : []) {
    const base = citeKeyFor(paper);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const key = count === 0 ? base : `${base}${String.fromCharCode(96 + count)}`;
    const block = bibtexFor(paper, { key });
    if (block !== '') blocks.push(block);
  }
  return blocks.join('\n');
}
