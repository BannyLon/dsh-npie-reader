/**
 * 朗读（Read aloud）的两条纯逻辑。
 *
 * ★ 为什么只做「播 / 暂停 / 继续 / 停 / 变速」，不做逐句高亮：高亮要求把正文切成
 *   一句一个 `<span>`，而正文是 `dangerouslySetInnerHTML` 塞进去的 —— 切一次就要
 *   重建整棵子树，滚动位置会跳、选中会丢、划线也会失效。用「值不值」来换：
 *   高亮好看，但它会破坏阅读本身；而这颗按钮的主要场景是**不听屏幕**（通勤、走路）。
 *   ⇒ 真要做高亮，得先给正文一个不重建 DOM 的渲染路径，那是另一件事。
 *
 * ★ 语音选择与分块都放在这里：这两条是「读出来对不对」的全部内容，留在组件里
 *   就只能靠读源码断言，而读源码答不了「选出来的那个声音能不能说中文」。
 */

/** 中文语音的匹配优先级：带地区的最准，然后是不带地区的 `zh`。 */
const ZH_PREFIXES = ['zh-CN', 'zh-Hans', 'zh-SG', 'zh-TW', 'zh-HK', 'zh'];

/**
 * 从一批语音里挑一个能读中文的。
 *
 * @param {Array<{name?: string, lang?: string, localService?: boolean}>} voices
 * @param {string} [preferred] 用户上次选的那一个（`voice.name`）
 * @returns {{name: string, lang: string, localService: boolean} | null}
 *
 * ★ 先看用户选过的那个**还在不在**：语音列表是异步填的，重启后顺序也可能变，
 *   拿名字去找比拿下标去找稳（下标会指向另一个声音，而且听起来"能用"）。
 * ★ 优先**本机语音**（`localService`）：在线语音要联网、按量计费，而且断网时
 *   静默不出声 —— 用户会以为按钮坏了。
 * ★ 一个中文语音都没有时返回 `null`，**不要退回第一个英语语音**：那会把一篇中文
 *   文章用英语音素念成噪音，比不念更糟。调用方据此说「这台机器没有中文语音」。
 */
export function pickVoice(voices, preferred = '') {
  const list = Array.isArray(voices) ? voices : [];
  if (list.length === 0) return null;
  if (preferred) {
    const chosen = list.find((voice) => voice?.name === preferred);
    if (chosen) return normalizeVoice(chosen);
  }
  for (const prefix of ZH_PREFIXES) {
    // 本机语音优先于在线语音（同一语言内）
    const locals = list.filter((voice) => String(voice?.lang ?? '').toLowerCase().startsWith(prefix.toLowerCase())
      && voice?.localService === true);
    if (locals.length > 0) return normalizeVoice(locals[0]);
    const any = list.filter((voice) => String(voice?.lang ?? '').toLowerCase().startsWith(prefix.toLowerCase()));
    if (any.length > 0) return normalizeVoice(any[0]);
  }
  return null;
}

const normalizeVoice = (voice) => ({
  name: String(voice?.name ?? ''),
  lang: String(voice?.lang ?? ''),
  localService: voice?.localService === true,
});

/**
 * 把正文切成能念的块。
 *
 * @param {string} text 正文纯文本
 * @param {number} [maxLength] 每块上限（字符数）
 * @returns {string[]}
 *
 * ★ 为什么要切：`SpeechSynthesisUtterance` 在 Chromium 里对超长文本会被截断
 *   （不同版本阈值不同，实测几千字就开始丢尾巴），而且**不报错** —— 用户听完
 *   开头就静音，以为读完了。
 * ★ 为什么按句子边界切而不是定长切：定长切会把一句话拦腰截断，念出来是两个
 *   半句，中间没有任何停顿。按句末标点切，块与块之间天然有停顿。
 * ★ 超长单句（没有标点的长段落）还是要硬切：不切就会超过上限，又回到截断。
 */
export function speechChunks(text, maxLength = 600) {
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 600;
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean === '') return [];
  // 句末标点（含中文的 。！？；与英文的 .!?;）后面切开，标点留在前一块
  const sentences = clean.split(/(?<=[。！？；!?;])\s*/).filter((part) => part.trim() !== '');
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current !== '') { chunks.push(current); current = ''; }
      // 超长单句硬切
      for (let at = 0; at < sentence.length; at += limit) chunks.push(sentence.slice(at, at + limit));
      continue;
    }
    if ((current + sentence).length > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/**
 * 语速档位。数字是 `SpeechSynthesisUtterance.rate` 的取值。
 *
 * ★ 上限只到 2：再快中文就听不清了（Chromium 允许到 10，但那是给无障碍场景的
 *   极端值）。下限 0.75：再慢会让人觉得卡住了。
 */
export const SPEECH_RATES = [
  { rate: 0.85, label: '慢' },
  { rate: 1, label: '正常' },
  { rate: 1.3, label: '快' },
  { rate: 1.7, label: '很快' },
];
