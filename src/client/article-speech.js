import { applyPronunciation } from '../speech-pronunciation.js';
import { SILICON_VOICES, parseSpeechVoice, speechVoiceValue } from '../speech.js';

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
 * 语言标签：把 BCP-47 的 `zh-*` 翻成人话。
 *
 * ★ 为什么不直接显示 `zh_CN`：下拉里全是 `zh_CN` / `zh_TW` / `zh_HK` 时，用户要
 *   先知道哪个代码是哪个地区才选得动。而这是**唯一**能让他分辨同名音色的线索
 *   （婷婷在台湾版与大陆版里都有）。
 */
const REGION_LABELS = [
  ['zh-cn', '大陆'], ['zh-hans', '大陆'], ['zh-sg', '新加坡'],
  ['zh-tw', '台湾'], ['zh-hk', '香港'], ['zh-mo', '澳门'], ['zh', '中文'],
];

export function voiceRegion(lang) {
  const key = String(lang ?? '').toLowerCase().replace('_', '-');
  for (const [prefix, label] of REGION_LABELS) {
    if (key === prefix || key.startsWith(`${prefix}-`)) return label;
  }
  return '其他';
}

/**
 * 给用户挑的那份中文语音清单（0.54.0）。
 *
 * @param {Array<{name?: string, lang?: string, localService?: boolean}>} voices
 * @returns {Array<{name: string, lang: string, region: string, localService: boolean, label: string}>}
 *
 * ★ 为什么需要它：`pickVoice` 只负责「自动挑一个能用的」，而用户说「非常机械声」
 *   时真正缺的是**换一个**。挑的前提是先把候选摊开 —— 这台机器上有 20 条中文语音，
 *   而在此之前界面上一条都看不见。
 * ★ **按 语言+名字 去重**：macOS 的「婷婷」会同时以紧凑版与高音质版出现，两条
 *   `name` 与 `lang` 完全一样 —— 不去重的话下拉里是两个一模一样的选项，用户点了
 *   另一个也听不出区别（他不知道自己其实在切音质档）。
 * ★ 排序不是装饰：默认选中项来自 `pickVoice`，它按 zh-CN → zh-TW → zh-HK 的优先级
 *   找。清单也照这个顺序排，用户打开下拉时**第一项就是他正在听的那个**，不用先找。
 */
export function chineseVoices(voices) {
  const list = Array.isArray(voices) ? voices : [];
  const seen = new Set();
  const rows = [];
  for (const voice of list) {
    const lang = String(voice?.lang ?? '');
    const name = String(voice?.name ?? '');
    if (name === '' || !/^zh($|[-_])/i.test(lang)) continue;
    const key = `${lang.toLowerCase().replace('_', '-')}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const region = voiceRegion(lang);
    const localService = voice?.localService === true;
    rows.push({
      name, lang, region, localService,
      // 在线语音要标出来：它按量计费、断网就没声，用户得知道自己选了什么
      label: `${name}（${region}）${localService ? '' : ' · 在线'}`,
    });
  }
  const rank = (row) => {
    const at = ZH_PREFIXES.findIndex((prefix) => row.lang.toLowerCase().replace('_', '-').startsWith(prefix.toLowerCase()));
    return at === -1 ? ZH_PREFIXES.length : at;
  };
  return rows.sort((a, b) => rank(a) - rank(b)
    || Number(b.localService) - Number(a.localService)
    || a.name.localeCompare(b.name));
}

/**
 * 试听用的那句话。
 *
 * ★ 必须是**中文 + 有停顿 + 有数字与英文**的一小段：只听「你好」判断不出朗读
 *   效果，真实文章里既有逗号句号也有数字和专有名词，那才是机械感暴露的地方。
 */
export const SPEECH_SAMPLE = '这是一段试听：2026 年的秋天，AI 让阅读变快了吗？听完再决定。';

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
 * **朗读专用**的切块入口：先做发音修正，再按句子切。
 *
 * ★ 为什么不是改 `speechChunks` 本身：那个函数在测试里被断言「拼回去等于原文」，
 *   也是别处可能复用的纯切块工具。发音修正是**朗读策略**，不该混进切块语义。
 * ★ 为什么变换在切块**之前**：按句边界硬切时，一个词可能被切在两块之间，
 *   切完再逐块变换就会漏掉它。替换等长，所以先变换不会挪动任何块边界。
 * ★ 这是文章云端、文章本机、电子书云端、电子书本机四条播放路径的**唯一汇合点**。
 *   少接一条就会出现「电子书里读对了、文章里还读错」这种只改一道门的漏。
 *
 * @param {string} text 正文纯文本
 * @param {number} [maxLength] 每块上限
 * @param {boolean} [enabled] 发音修正开关（由调用点现读 localStorage）
 * @returns {string[]}
 */
export function speechChunksForReading(text, maxLength = 600, enabled = true) {
  const source = String(text ?? '');
  return speechChunks(enabled ? applyPronunciation(source) : source, maxLength);
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

/**
 * 朗读偏好在浏览器里的两个键。
 *
 * ★ **全插件只在这里定义一次**。设置页、文章阅读页、电子书页三处都从这里取 ——
 *   同一个键手写三遍，改一处忘两处的结果是「设置里选了云端音色、阅读页还在用本机」，
 *   而三个文件各自看都对。
 */
export const SPEECH_VOICE_KEY = 'npr.speechVoice';
export const SPEECH_RATE_KEY = 'npr.speechRate';

/**
 * 朗读偏好被改动时广播的事件名。
 *
 * ★ 三个入口（设置页 / 阅读页 ⋯ 菜单 / 电子书 FAB）改完都要派发它，另两处监听后
 *   重读。少了这一步，用户在设置页把语速调成「很快」，回来点听本节仍按「正常」念，
 *   而按钮上的词已经变了 —— 界面说谎比报错更难查。
 */
export const SPEECH_PREFS_EVENT = 'npr-speech-prefs-changed';

/**
 * 声音下拉里的两组选项。
 *
 * ★ 云端排前面：用户的抱怨是「本机的都不自然」，那一组是他已经试遍的。
 * ★ 没配 Key 时**不列出云端音色**（而不是列出来点了报错）：一个能选但选完就报
 *   「没填 Key」的下拉，比一个明确写着「去设置里填 Key」的提示更让人恼火。
 * ★ 抽成函数、不留在组件里（0.76.1）：设置页和阅读页各要一个下拉，抄两份的话
 *   以后加一个音色只改一处，两个下拉就不一致。
 */
export function speechVoiceGroups({ voices = [], cloud = null } = {}) {
  const local = chineseVoices(voices).map((item) => ({
    value: speechVoiceValue('system', item.name),
    label: item.label,
  }));
  const remote = (cloud?.configured === true ? (cloud.voices ?? SILICON_VOICES) : [])
    .map((item) => ({
      value: speechVoiceValue('siliconflow', item.id),
      label: `${item.label} · 云端`,
    }));
  return { local, remote };
}

/**
 * 下拉里应该显示的那一项。
 *
 * ★ 用户没选过时显示 `pickVoice` 自动挑中的那个，而不是空 —— 否则下拉是空值，
 *   用户以为「没选就没在用」，而实际上朗读一直在用某个音色。
 * ★ 选过云端、但 Key 后来被清空时返回空串：界面上补一条禁用的「当前选的音色现在
 *   用不了」，如实说明，而不是悄悄跳到本机语音。
 */
export function activeSpeechVoiceValue({ value = '', voices = [], cloud = null } = {}) {
  const parsed = parseSpeechVoice(value);
  if (parsed.engine === 'siliconflow') {
    return cloud?.configured === true ? speechVoiceValue('siliconflow', parsed.voice) : '';
  }
  const picked = pickVoice(voices, parsed.voice)?.name ?? '';
  return picked === '' ? '' : speechVoiceValue('system', picked);
}

/**
 * 写朗读偏好 + 广播。
 *
 * ★ 写失败（隐私模式 / 配额满）时**不广播**：别处监听后会重读，读到的还是旧值，
 *   于是「我刚选的音色一刷新就回去了」—— 那比不广播更让人困惑。调用方拿到 `false`
 *   后应把界面回滚。
 */
export function writeSpeechPrefs(storage, patch = {}, env = globalThis) {
  if (typeof storage?.setItem !== 'function') return false;
  try {
    if ('voice' in patch) storage.setItem(SPEECH_VOICE_KEY, String(patch.voice));
    if ('rate' in patch) storage.setItem(SPEECH_RATE_KEY, String(patch.rate));
  } catch { return false; }
  try {
    if (typeof env?.Event === 'function') env.dispatchEvent?.(new env.Event(SPEECH_PREFS_EVENT));
  } catch { /* 没有 Event 构造器 / dispatch 抛错：不算写失败，值已经落盘了 */ }
  return true;
}
