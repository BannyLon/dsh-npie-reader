const ORDER = ['original', 'translation', 'rewrite'];

/** Apply the reader preference only when that article actually has content. */
export function resolveReadingVersion(preferred, article) {
  const readable = (kind) => kind === 'original'
    ? Boolean(article?.html?.trim())
    : article?.versions?.[kind]?.available === true && Boolean(article.versions[kind].markdown?.trim());
  const candidates = [preferred, ...ORDER.filter(kind => kind !== preferred && kind !== 'original'), 'original'];
  return candidates.find(kind => ORDER.includes(kind) && readable(kind)) ?? 'original';
}

/**
 * 这篇要不要**自动**翻译成中文（用户要求：「将原文直接翻译为中文，而不是在 AI
 * 伴读框里通过 prompt 来翻译」）。
 *
 * 四个条件缺一不可，任何一个放宽都会变成「替用户花模型的钱」或「做无用功」：
 *   1. 设置里打开了 `autoTranslate` —— 默认关闭，因为是计费行为；
 *   2. 宿主判定的原文语种是 `en` —— 判据在 `src/language.js`，两端共用一份；
 *      中文原文不必翻，日文/韩文不能当英文直译，样本不足时宿主给 `unknown`，
 *      这里一律不动；
 *   3. 该篇还没有中文版本 —— 已经有的（订阅源自带或上次生成的）直接用，别重生成；
 *   4. 原文本身有正文 —— 没正文时生成出来的只会是一篇空转的译文。
 *
 * @param {{autoTranslate?: boolean}} reading 阅读设置
 * @param {{article?: object, html?: string, versions?: object}} payload `api.getArticle` 的返回值
 */
export function shouldAutoTranslate(reading, payload) {
  if (reading?.autoTranslate !== true) return false;
  if (payload?.article?.language !== 'en') return false;
  if (payload?.versions?.translation?.available === true) return false;
  return Boolean(payload?.html?.trim());
}
