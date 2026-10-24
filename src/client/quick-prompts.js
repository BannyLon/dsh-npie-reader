/**
 * 快捷提示词，**按伴读场景分两套**：
 *
 * - `article` —— RSS 文章伴读（`AskArticle`）。存在 `npr.quick-prompts.v1`，
 *   与历史数据无缝衔接（这个键从单套时代就在用，改键会让老用户丢一次配置）。
 * - `book` —— 电子书伴读（`BookCompanion`）。存在 `npr.book-quick-prompts.v1`。
 *
 * 两套刻意**不共用**：文章的提问以「这篇 / 选段」为单位（翻译全文、追问证据），
 * 书的提问以「当前这一页」为单位（解释这一页、梳理要点）—— 混在一起会让
 * 「翻译全文」出现在只有一页扫描件的伴读里，点出去就是答非所问。
 */

const STORAGE_KEYS = {
  article: 'npr.quick-prompts.v1',
  book: 'npr.book-quick-prompts.v1',
};

export const DEFAULT_PROMPTS = [
  { id: 'summary', title: '概括要点', body: '请用三点概括这篇文章的核心观点，并区分事实与作者判断。' },
  { id: 'translate', title: '翻译全文', body: '请将这篇文章全文翻译成中文，保留原文结构。' },
  { id: 'explain', title: '解释选段', body: '请结合上下文解释我选中的这段话，用通俗的中文说明。' },
  { id: 'question', title: '追问证据', body: '这篇文章的主要结论有哪些证据支持？哪些地方还需要核实？' },
];

/** 电子书伴读的默认三条：都以「当前这一页」为单位（原 BookCompanion 的写死三项）。 */
export const BOOK_DEFAULT_PROMPTS = [
  { id: 'explain', title: '解释这一页', body: '请解释当前这一页：先用一句话说清它在讲什么，再展开要点。遇到术语、人名或隐含前提请点明。' },
  { id: 'outline', title: '梳理要点', body: '请把当前这一页的内容整理成三到五条要点，并指出哪一条最值得继续追问、为什么。' },
  { id: 'question', title: '挑一个值得问的问题', body: '读完当前这一页，挑一个最值得继续追问的问题，说明它为什么值得问，并给出你自己的初步回答。' },
];

function defaultsOf(scope) {
  return scope === 'book' ? BOOK_DEFAULT_PROMPTS : DEFAULT_PROMPTS;
}

export function readQuickPrompts(scope = 'article') {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS[scope] ?? STORAGE_KEYS.article));
    if (Array.isArray(saved)) return saved.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string').slice(0, 20);
  } catch { /* Damaged preferences must not block reading. */ }
  return defaultsOf(scope);
}

export function saveQuickPrompts(items, scope = 'article') {
  localStorage.setItem(STORAGE_KEYS[scope] ?? STORAGE_KEYS.article, JSON.stringify(items));
  window.dispatchEvent(new Event('npr-prompts-changed'));
}

/**
 * Adapt built-in prompts only; preserve customized instructions, including explicit full-article requests.
 * （仅 article 伴读用：有选段时内置四条换读成「选段」措辞。）
 */
export function scopedQuickPrompts(items, selection = '') {
  const scoped = {
    summary: { title: '概括选段', body: '请用三点概括选中段落的核心观点，并区分事实与作者判断。只处理选段，文章仅作背景。' },
    translate: { title: '翻译选段', body: '请只将选中段落翻译成中文，保留原意和结构。文章仅作背景，不翻译全文。' },
    explain: { title: '解释选段', body: '请结合文章背景，用通俗的中文解释选中段落。只解释选段。' },
    question: { title: '追问证据', body: '选中段落的结论有哪些证据支持？哪些地方还需要核实？文章仅作背景，聚焦选段。' },
  };
  return items.map(item => {
    const original = DEFAULT_PROMPTS.find(prompt => prompt.id === item.id);
    if (!original || original.body !== item.body) return item;
    if (selection.trim()) return { ...item, ...scoped[item.id] };
    if (item.id === 'explain') return { ...item, title: '解释文章', body: '请用通俗的中文解释这篇文章的核心观点。' };
    return item;
  });
}
