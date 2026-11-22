/**
 * 「生成提纲」落进正文的那一步（0.88.0）。
 *
 * ★ 为什么单独一个文件、单独一套测试：这一步是全功能里**唯一不可逆**的操作。
 *   点一下模型跑十几秒，回来的一坨文本要放进用户正在写的编辑框 —— 写错就是把
 *   他手打的那几段盖掉。而覆盖之后没有任何地方能撤回（日记没有 undo 栈）。
 *   所以判据只有一条：**已经写的字，一个都不能少**。
 *
 * ★ 也刻意不做「智能合并」（比如找出同名小标题替换）：那个「智能」一旦判断错，
 *   用户看到的就是自己的段落被悄悄改写。宁可接两遍让他自己删。
 *   唯一的例外是下面这条「原封不动的模板」—— 那里面一个字都不是用户写的。
 */

/**
 * 正文是不是**原封不动的模板**（用户一个字都没写）。
 *
 * ★ 为什么要有这条（0.88.0 定稿时补）：模板与提纲都会往正文里放结构。
 *   用户先点「套用模板」（正文变成四个空标题），再点「生成提纲」—— 按「接在末尾」
 *   的规矩，正文里就有**两套结构**：模板的「一句话总结 / 核心收获 / 行动指南 /
 *   金句摘录」，加上提纲自己的章节。「一句话总结」这种标题在屏幕中间出现两次，
 *   用户的原话是「就会让输入框里很乱」。
 * ★ 判据用**全等**而不是「包含模板的某个标题」：用户可能已经删掉了其中一节、
 *   又添了自己的一句话，那就不再是「空模板」，此时必须走追加（他的字不能丢）。
 *   全等只在一种情况下成立 —— 正文与模板逐字相同，即真的一个字都没写。
 * ★ 两侧都 trim：模板首尾的空行不该让判据失效。
 */
export function isPristineTemplate(body, template) {
  if (typeof body !== 'string' || typeof template !== 'string') return false;
  const draft = body.trim();
  const shape = template.trim();
  return shape !== '' && draft === shape;
}

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
  return !isPristineTemplate(body, template);
}

/**
 * 把提纲放进正文。
 *
 * - 正文是**原封不动的模板** ⇒ 用提纲**替掉**它（见 `isPristineTemplate`：
 *   那里一个字都不是用户写的，留着只会让两套结构叠在一起）；
 * - 正文为空（只有空白）⇒ 直接是提纲；
 * - 正文已有内容 ⇒ 接在末尾，中间空一行（贴着最后一行会并成同一段）；
 * - 提纲为空 ⇒ **原样返回正文**（不清理、不加空行）。这一步是防线：
 *   上游没给提纲时调用方未必先判空，而「原样返回」不会造成任何损失。
 *
 * @param {string} current - 编辑框里的正文。
 * @param {string} outline - 模型给的提纲。
 * @param {{ template?: string }} [options] - `template` 是「套用模板」用的那份骨架；
 *   给了它才可能触发「替换空模板」，不给就完全保持旧行为。
 * @returns {string} 新的正文。
 */
export function mergeOutlineIntoDraft(current, outline, options = {}) {
  const body = typeof current === 'string' ? current : '';
  const next = typeof outline === 'string' ? outline.trim() : '';
  if (next === '') return body;
  if (isPristineTemplate(body, options?.template)) return `${next}\n`;
  if (body.trim() === '') return `${next}\n`;
  return `${body.replace(/\s+$/, '')}\n\n${next}\n`;
}
