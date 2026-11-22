/**
 * 「生成提纲」落进正文的那一步（0.88.0，0.89.0 改口径）。
 *
 * ★ 为什么单独一个文件、单独一套测试：这一步是全功能里**唯一不可逆**的操作。
 *   点一下模型跑十几秒，回来的一坨文本要放进用户正在写的编辑框 —— 写错就是把
 *   他手打的那几段盖掉。而覆盖之后没有任何地方能撤回（日记没有 undo 栈）。
 *   所以判据只有一条：**已经写的字，一个都不能少**。
 *
 * ★ 也刻意不做「智能合并」（比如找出同名小标题替换）：那个「智能」一旦判断错，
 *   用户看到的就是自己的段落被悄悄改写。宁可接两遍让他自己删。
 *   唯一的例外是下面这条「原封不动的骨架」—— 那里面一个字都不是用户写的。
 *
 * ★ 0.89.0 改口径：**「生成提纲」不再默认追加**。
 *   用户 2026-11-22 实测：连点两次「生成提纲」，正文里出现两份提纲首尾相接
 *   （第二份接在第一份末尾）。这不是他要的 —— 按钮叫「生成提纲」，点第二次的
 *   意思显然是「这份不满意，换一份」，没人想把两套骨架都留在稿纸上。
 *   所以现在分两档（`outlinePlacement`）：
 *     - 正文里一个字都不是他写的（空 / 纯模板 / 纯上一份提纲）⇒ **替换**，一次点成；
 *     - 正文里有他写的字 ⇒ **不写正文**，把提纲摆到一张待放入的卡片上让他选
 *       （`ask`）。这时任何自动选择都会得罪一半人：替换删他的字，追加叠两套结构。
 *   注意「上一份提纲」也算骨架：它同样是模型给的，用户没往里面写字时替换是安全的。
 */

/**
 * 正文是不是**原封不动的骨架**（模板，或上一份 AI 提纲；一个字都不是用户写的）。
 *
 * ★ 为什么要有这条（0.88.0 定稿时补）：模板与提纲都会往正文里放结构。
 *   用户先点「套用模板」（正文变成四个空标题），再点「生成提纲」—— 按「接在末尾」
 *   的规矩，正文里就有**两套结构**：模板的「一句话总结 / 核心收获 / 行动指南 /
 *   金句摘录」，加上提纲自己的章节。「一句话总结」这种标题在屏幕中间出现两次，
 *   用户的原话是「就会让输入框里很乱」。
 * ★ 判据用**全等**而不是「包含骨架的某个标题」：用户可能已经删掉了其中一节、
 *   又添了自己的一句话，那就不再是「空骨架」，此时必须走追加（他的字不能丢）。
 *   全等只在一种情况下成立 —— 正文与骨架逐字相同，即真的一个字都没写。
 * ★ 两侧都 trim：骨架首尾的空行不该让判据失效。
 * ★ 名字里的 skeleton 而不是 template：0.89.0 起它也被用来判「上一份提纲」，
 *   判据本身与骨架从哪来无关（见 `outlinePlacement`）。
 */
export function isPristineSkeleton(body, skeleton) {
  if (typeof body !== 'string' || typeof skeleton !== 'string') return false;
  const draft = body.trim();
  const shape = skeleton.trim();
  return shape !== '' && draft === shape;
}

/** 0.88.0 的历史名字，只用于模板；保留是为了老调用点与老测试不必改口。 */
export const isPristineTemplate = isPristineSkeleton;

/**
 * 「套用模板」这一下，是不是会**删掉别的东西**（⇒ 需要用户再点一次确认）。
 *
 * ★ 0.88.0 定稿时补。上一版「套用模板」在正文非空时**接在末尾**，于是
 *   「生成提纲」之后再点它，屏幕里就出现两套小标题（提纲的四节 + 模板的四节）。
 *   模板是**整份骨架**，不是补丁 —— 所以现在只有两种情况可以一次点成：
 *   正文是空的（没有东西可删），或者正文就是原封不动的模板（`refTemplated` 已经
 *   把按钮禁掉了，这里再返回 false 只是让两条路别互相打架）。
 * ★ 其余一切（一份提纲、用户手打的三段、甚至只删了一节的模板）都算「有东西要删」，
 *   一律走两步。宁可多点一次，也不让一次误点毁掉他写的东西。
 */
export function needsTemplateConfirm(body, template) {
  if (typeof body !== 'string') return false;
  if (body.trim() === '') return false;
  return !isPristineSkeleton(body, template);
}

/**
 * 这一下「生成提纲」，正文该怎么处理。
 *
 * - `'replace'`：正文是空的、是原封不动的模板、或就是上一份提纲
 *   ⇒ 一个字都不是用户写的，直接换掉，一次点成。
 * - `'ask'`：正文里有用户写的字（或他改过的骨架）
 *   ⇒ **不要自己决定**。替换会删他的字，追加会叠两套结构，两个都错。
 *   调用方应该把提纲摆出来让他选「换成这份 / 接在末尾 / 不用了」。
 *
 * ★ 为什么「上一份提纲」要单独认：没有这条的话，连点两次就是两份提纲接龙 ——
 *   用户 2026-11-22 报的就是这个。`lastOutline` 由调用方记住「上一次落进正文的
 *   那份提纲原文」，这里只做逐字比较，不猜「这段文本看着像不像提纲」。
 * ★ 认不出来时一律 `ask`：宁可多问一句，也不替他删字（与 `needsTemplateConfirm`
 *   同一种「宁严勿松」的取向）。
 *
 * @param {string} body - 编辑框里的正文。
 * @param {{ template?: string, lastOutline?: string }} [options]
 * @returns {'replace' | 'ask'}
 */
export function outlinePlacement(body, options = {}) {
  const draft = typeof body === 'string' ? body : '';
  if (draft.trim() === '') return 'replace';
  if (isPristineSkeleton(draft, options?.template)) return 'replace';
  if (isPristineSkeleton(draft, options?.lastOutline)) return 'replace';
  return 'ask';
}

/**
 * 把提纲放进正文。
 *
 * - 正文是**原封不动的骨架**（模板 / 上一份提纲）⇒ 用提纲**替掉**它（见
 *   `isPristineSkeleton`：那里一个字都不是用户写的，留着只会让两套结构叠在一起）；
 * - 正文为空（只有空白）⇒ 直接是提纲；
 * - 正文已有内容 ⇒ 接在末尾，中间空一行（贴着最后一行会并成同一段）；
 * - 提纲为空 ⇒ **原样返回正文**（不清理、不加空行）。这一步是防线：
 *   上游没给提纲时调用方未必先判空，而「原样返回」不会造成任何损失。
 *
 * ★ 什么时候该替换、什么时候该先问，由 `outlinePlacement()` 决定；
 *   这个函数假定调用方已经决定「要落进去」，所以它对 `ask` 那种情况是追加。
 *   两个函数共用同一份骨架判据，不会出现「一个说该换、一个说该接」。
 *
 * @param {string} current - 编辑框里的正文。
 * @param {string} outline - 模型给的提纲。
 * @param {{ template?: string, lastOutline?: string }} [options]
 *   - `template`：「套用模板」用的那份骨架；
 *   - `lastOutline`：上一次落进正文的提纲（连点两次时用来认「正文还是它」）。
 * @returns {string} 新的正文。
 */
export function mergeOutlineIntoDraft(current, outline, options = {}) {
  const body = typeof current === 'string' ? current : '';
  const next = typeof outline === 'string' ? outline.trim() : '';
  if (next === '') return body;
  if (outlinePlacement(body, options) === 'replace') return `${next}\n`;
  return `${body.replace(/\s+$/, '')}\n\n${next}\n`;
}
