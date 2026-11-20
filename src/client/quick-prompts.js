/**
 * 快捷提示词，**按伴读场景分三套**：
 *
 * - `article` —— RSS 文章伴读（`AskArticle`）。存在 `npr.quick-prompts.v1`，
 *   与历史数据无缝衔接（这个键从单套时代就在用，改键会让老用户丢一次配置）。
 * - `book` —— 电子书伴读（`BookCompanion`）。存在 `npr.book-quick-prompts.v1`。
 * - `paper` —— 论文伴读（同一个 `BookCompanion`，`kind === 'paper'`）。
 *   存在 `npr.paper-quick-prompts.v1`。
 *
 * 三套刻意**不共用**：文章的提问以「这篇 / 选段」为单位（翻译全文、追问证据），
 * 书以「当前这一页讲了什么」为单位，论文则以**论证结构**为单位（这一页在整篇里
 * 承担什么、证据够不够、值不值得精读）。混在一起会让「翻译全文」出现在只有一页
 * 扫描件的伴读里，点出去就是答非所问；论文用书那套则会让模型把它当成一本散文。
 */

const STORAGE_KEYS = {
  article: 'npr.quick-prompts.v1',
  book: 'npr.book-quick-prompts.v1',
  paper: 'npr.paper-quick-prompts.v1',
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

/**
 * 论文伴读的默认三条。
 *
 * ★ 三条分别对应读论文时**真正会卡住的三件事**，不是把书那套换个说法：
 *   1. 这一页在整篇论证里的位置（论文是拼图，单页常常只有半句前提）；
 *   2. 方法与证据强度（「作者声称」和「实验支持」必须分开）；
 *   3. 要不要继续投入时间（读论文的最大成本是时间，不是理解）。
 * ★ 措辞里都带「当前这一页 / 这一篇」，因为宿主只给了这一页正文 + 元数据，
 *   让模型去答「整篇的创新点」等于逼它编。
 */
export const PAPER_DEFAULT_PROMPTS = [
  { id: 'position', title: '这一页在讲什么位置', body: '请说明当前这一页在整篇论文里承担什么：它属于问题陈述、方法、实验还是讨论？这一页要支撑的论断是哪一个？' },
  { id: 'evidence', title: '方法与证据够不够', body: '请把这一页涉及的方法与实验讲清楚：输入输出、对比基线、评价指标。哪些结论是这一页的数据直接支持的，哪些只是作者的推断？' },
  { id: 'worth', title: '值不值得精读', body: '结合标题、摘要与当前这一页，判断这一篇值不值得精读：给出理由，并列出精读时应该重点核对的三个点。' },
];

function defaultsOf(scope) {
  if (scope === 'paper') return PAPER_DEFAULT_PROMPTS;
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
