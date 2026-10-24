/**
 * 原文语种判定 —— **宿主半区与客户端半区共用同一份判据**。
 *
 * ★ 为什么必须共用一份，而不是两边各写一遍：
 *   界面要回答「这篇文章要不要自动翻译成中文」，而 Agent 工具也要回答「这篇是
 *   不是英文原文」。两处若各写一遍阈值，就会出现「界面说英文、工具说中文」这种
 *   互相矛盾的结论，而且两边各自的单测都是绿的 —— 排查时最费时间的一类。
 *   （本项目在「一份数据两个视图」上踩过同型问题：脚本按原始毫秒算、界面按整天算，
 *   同一判据两个数字对不上，266 vs 272。）
 *
 * ★ 判据为什么是「汉字占比」而不是「有没有汉字」：
 *   中文技术文章里夹英文术语、代码、URL 是常态（`useEffect`、`npm install`）；
 *   反过来英文文章里也可能出现一两个汉字。所以看的是**占比**，且要求样本量够大
 *   才下结论 —— 样本太小时返回 `unknown`，让调用方什么都别做，而不是猜一个。
 *
 * ★ 为什么要先剥 HTML 标签：
 *   `article.html` 里 `<div>` `<span>` `<a href=...>` 的标签名与属性全是拉丁字母。
 *   一篇中文文章的标签就能贡献成百上千个拉丁字母，不剥掉的话占比会被拉到
 *   阈值以下，中文文章被判成英文 —— 然后每次打开都自动调一次模型翻译。
 */

/** 汉字（含扩展 A 与兼容区）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** 日文假名。 */
const KANA = /[\u3040-\u30ff]/g;
/** 韩文谚文。 */
const HANGUL = /[\uac00-\ud7af]/g;
/** 拉丁字母。 */
const LATIN = /[A-Za-z]/g;

/** 汉字占比低于这个值就认为原文不是中文。 */
export const CJK_RATIO_THRESHOLD = 0.15;

/**
 * 只在正文**开头**这么多字符上判语种（剥完标签、去掉首尾空白之后算）。
 *
 * ★ 为什么不是整篇：真机里有一类文章是「开头一篇中文精读 + 后面附整篇英文逐字稿」
 *   （Lex Fridman 播客的中文精读源）。那篇正文被截到 20 万字符，其中拉丁字母 13.7 万、
 *   汉字只有 1.27 万 —— 整篇算下来汉字占比 8.5%，低于阈值 ⇒ 判成 `en` ⇒ 界面对着
 *   一篇用户读得懂的中文文章说「原文是英文」，并且**真的去调模型翻译一遍**。
 *   而人判断「这篇是什么语言」看的就是**打开后先读到的那段**。
 *
 * ★ 取值是量出来的，不是拍的：用 2000 字符的窗口跑遍真机上 93 篇缓存正文，
 *   只有那 2 篇中文精读从 `en` 变 `zh`，其余 91 篇结论一篇都没动
 *   （62 篇真英文没有一篇被误判成中文）。
 *
 * ★ 代价是有意的：一篇「开头 2000 字符全是英文、后面才是中文」的文章会被判 `en`。
 *   那个方向错了只是多翻一次；反方向错了是「说错话 + 白花钱」。
 */
export const LEAD_CHARS = 2000;

/**
 * 少于这么多「有意义的字符」（汉字 + 拉丁字母 + 假名 + 谚文）就不判语种。
 * 60 大约是一个短标题加一句话；比这更短的样本（「Hello」「RSS 更新」）不足以
 * 区分语种，硬判会让界面做出莫名其妙的事。
 *
 * ★ 四类都要算进来：只算汉字与拉丁字母的话，一段纯假名的日文 total = 0，
 *   会被判成「样本不足」，于是它既不会被标成 other、也不会被翻译 —— 静默地
 *   什么都不发生，比判错更难查。
 */
export const MIN_SAMPLE = 60;

/** 去掉标签与注释，留下可读文本。`<script>` / `<style>` 的内容一并去掉。 */
export function stripMarkup(input) {
  return String(input ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ');
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;

/**
 * 判一篇原文的语种。
 *
 * ★ 只看**开头** `LEAD_CHARS` 个字符（标题算在最前面），理由见上面那个常量的说明。
 *
 * @param {string} input 标题 + 正文（可以是 HTML，本函数自己会剥标签）
 * @returns {'zh'|'en'|'other'|'unknown'}
 *   `zh` 中文 · `en` 英文（自动翻译只对这一个取值生效）·
 *   `other` 日文/韩文等（**不**自动翻成中文，避免把日文当英文直译）·
 *   `unknown` 样本不足，调用方什么都不该做
 */
export function detectLanguage(input) {
  // ★ 先 trim 再截：正文 HTML 开头常常是一堆缩进与空行，不 trim 的话窗口会被空白吃掉一截。
  const text = stripMarkup(input).trim().slice(0, LEAD_CHARS);
  const cjk = count(text, CJK);
  const latin = count(text, LATIN);
  const kana = count(text, KANA);
  const hangul = count(text, HANGUL);
  // ★ 样本量必须把假名与谚文一起算进来。只算「汉字 + 拉丁字母」的话，
  //   一段纯假名的日文会得到 total = 0 而被判成「样本不足 ⇒ unknown」，
  //   于是它既不会被标成 other、也不会被翻译，静默地什么都不发生。
  const total = cjk + latin + kana + hangul;
  if (total < MIN_SAMPLE) return 'unknown';
  // 假名 / 谚文占比可观 ⇒ 不是中文也不是英文。判在「英文」之前，否则
  // 一篇日文（汉字 + 假名 + 少量英文）会被当成英文直译成中文。
  if (kana + hangul >= total * 0.05) return 'other';
  return cjk / total < CJK_RATIO_THRESHOLD ? 'en' : 'zh';
}

/**
 * 从一篇文章对象取语种（标题 + 正文**开头**一起看，标题太短不足以定论）。
 *
 * ★ 标题放在最前面：短标题单独判会落到 `unknown`，跟正文开头拼起来才有足够样本。
 *
 * ★ 刻意**不看** `titleZh`：它判的是**原文**的语种，而 `titleZh` 是订阅源
 *   自带的另一份中文标题。把它算进来会让「原文是英文但源给了中文标题」的文章
 *   被拉向 `zh` —— 而那类文章恰恰是最需要自动翻译的。至于「源已经给了中文版本」，
 *   那是另一个信号，由 `versions.translation.available` 负责，不该混进来。
 */
export function articleLanguage(article) {
  if (!article) return 'unknown';
  return detectLanguage(`${article.title ?? ''}\n${article.html ?? ''}`);
}
