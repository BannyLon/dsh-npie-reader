/**
 * 朗读引擎：**宿主半区与浏览器半区共用**的常量与判据。
 *
 * ★ 为什么这些值必须只写一份：音色 id 在界面里是下拉项的 value、在宿主是发给
 *   云端的 `voice` 字段、在测试里是断言的期望值。三处各写一遍，迟早出现
 *   「界面上选的是 claire、发出去的是 diana」—— 而症状是「换了音色没变化」，
 *   没人会往拼写错误上想。
 *
 * ★ 为什么要引入「云端朗读」这条引擎，而不是继续打磨系统语音：
 *   macOS 的 20 条中文语音全部试过，用户的判词是「没有一个读起来自然的，都很重的
 *   机器味」。那是**采样拼接式**合成的上限，换音色解决不了，只能换合成方式。
 *   云端神经语音（CosyVoice2）是生成式的，与系统语音不是一个量级。
 */

/**
 * 两个引擎。
 *
 * `system` = 本机 `speechSynthesis`（免费、离线、机械）；`siliconflow` = 云端
 * 神经语音（按字节计费、需要 API Key、自然）。
 */
export const SPEECH_ENGINES = {
  system: '本机语音',
  siliconflow: '硅基流动',
};

/**
 * 下拉项 value 的前缀。
 *
 * ★ 为什么合并成一个下拉框、用前缀区分引擎，而不是「先选引擎、再选音色」两级：
 *   用户要解决的问题是「换一个听起来自然的声音」，两级选择把这个动作拆成了两步，
 *   且第一步要理解「引擎」是什么概念。合成一个清单，他只需要在一堆声音里挑一个
 *   好听的 —— 这正是他本来想做的事。
 */
export const LOCAL_PREFIX = 'local:';
export const CLOUD_PREFIX = 'cloud:';

/**
 * 朗读路由的前缀。
 *
 * ★ 放在**共用模块**里，不放在 `host/speech-routes.js`：那个文件 import 了
 *   `node:*` 与 `./trust.js`，浏览器半区 import 它会把整条宿主链路拖进 bundle。
 *   路由文件从这里转出去，调用点就近 import（与 `library.js` 的做法一致）。
 */
export const SPEECH_API_PREFIX = '/api/dsh-npie-reader/speech';

/** 硅基流动的 TTS 端点（OpenAI 兼容形态，但走自己的域名）。 */
export const SILICON_ENDPOINT = 'https://api.siliconflow.cn/v1/audio/speech';

/** 模型名。换模型要同时改音色的写法（见 `siliconVoiceParam`）。 */
export const SILICON_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';

/**
 * 系统预置音色（8 条，4 男 4 女）。
 *
 * 文案照抄官方文档的定位词，不自创 —— 用户去开通页面看到的也是这些词，对得上。
 */
export const SILICON_VOICES = [
  { id: 'alex', label: '沉稳男声', gender: 'male' },
  { id: 'benjamin', label: '低沉男声', gender: 'male' },
  { id: 'charles', label: '磁性男声', gender: 'male' },
  { id: 'david', label: '欢快男声', gender: 'male' },
  { id: 'anna', label: '沉稳女声', gender: 'female' },
  { id: 'bella', label: '激情女声', gender: 'female' },
  { id: 'claire', label: '温柔女声', gender: 'female' },
  { id: 'diana', label: '欢快女声', gender: 'female' },
];

/** 默认音色。挑 `claire`（温柔女声）而不是第一个：读长文时男声偏快、偏硬。 */
export const SILICON_VOICE_DEFAULT = 'claire';

/**
 * 计费单价：**每 1000 UTF-8 字节 0.05 元**。
 *
 * ★ 单位是「字节」不是「字符」——这是本模块最容易被算错的一处。一个汉字 3 字节，
 *   所以「每千字节 0.05 元」等于「每千字 0.15 元」。按字符算会低估 3 倍。
 */
export const SILICON_PRICE_PER_KB = 0.05;

/** 一次请求最多送多少字。超了宿主直接拒（而不是截断后默默只念一半）。 */
export const SPEECH_CHUNK_MAX = 1000;

/**
 * 云端朗读每块切多少字（0.55.0）。
 *
 * ★ 为什么比本机语音的 600 小一半：本机合成是**本地**的，切多大都不影响延迟；
 *   云端每块要一次网络往返，块越大首字延迟越长。300 字约 60 秒语音，实测
 *   CosyVoice2 合成 300 字在 1–3 秒内返回 —— 用户点下去一两秒就出声。
 * ★ 为什么不再切小（比如 80 字一句）：每块都有一次固定的请求开销（鉴权、排队、
 *   编码），切太碎之后「句句之间都要等一次往返」，反而更卡，而且单价按字节算
 *   不变、请求数翻倍。
 */
export const SPEECH_CLOUD_CHUNK = 300;

/** 合法音色 id 集合。 */
export function isSiliconVoice(id) {
  return SILICON_VOICES.some((voice) => voice.id === id);
}

/** 音色 id → 官方要求的 `voice` 参数形态（`模型:音色`）。 */
export function siliconVoiceParam(id) {
  const voice = isSiliconVoice(id) ? id : SILICON_VOICE_DEFAULT;
  return `${SILICON_MODEL}:${voice}`;
}

/** 合法音色 id 一律放行，非法值落到默认（不报错，界面下拉不该因此变空）。 */
export function normalizeSiliconVoice(id) {
  return isSiliconVoice(id) ? id : SILICON_VOICE_DEFAULT;
}

/**
 * 语速。范围照抄官方文档的 `[0.25, 4.0]`。
 *
 * ★ 但界面上的档位（`SPEECH_RATES`）只到 1.7：再快中文就听不清了。这里保留全范围
 *   是因为它是**校验**，不是界面。
 */
export const SPEECH_SPEED_RANGE = Object.freeze({ min: 0.25, max: 4 });

/** 语速落到合法区间；非数字一律回 1。 */
export function normalizeSpeechSpeed(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(SPEECH_SPEED_RANGE.max, Math.max(SPEECH_SPEED_RANGE.min, Math.round(number * 100) / 100));
}

/**
 * 下拉项 value 的**唯一**构造处。
 *
 * @param {'system' | 'siliconflow'} engine
 * @param {string} voice 本机语音名 / 硅基流动音色 id
 */
export function speechVoiceValue(engine, voice) {
  const prefix = engine === 'siliconflow' ? CLOUD_PREFIX : LOCAL_PREFIX;
  return `${prefix}${String(voice ?? '')}`;
}

/**
 * 把下拉项 value 拆回「引擎 + 音色」。
 *
 * ★ 兼容 0.54.0 存下的**裸名字**（那时候只有一个引擎，存的是 `Tingting`）：
 *   没有前缀一律当本机语音。不兼容的话，升级后用户上次选的音色会静默失效，
 *   而界面上看不出任何异常 —— 他会以为「怎么又变回那个难听的了」。
 *
 * @param {string} value
 * @returns {{ engine: 'system' | 'siliconflow', voice: string }}
 */
export function parseSpeechVoice(value) {
  const raw = String(value ?? '');
  if (raw.startsWith(CLOUD_PREFIX)) {
    return { engine: 'siliconflow', voice: normalizeSiliconVoice(raw.slice(CLOUD_PREFIX.length)) };
  }
  if (raw.startsWith(LOCAL_PREFIX)) return { engine: 'system', voice: raw.slice(LOCAL_PREFIX.length) };
  return { engine: 'system', voice: raw };
}

/**
 * UTF-8 字节数（与云端计费口径**同一个量**）。
 *
 * ★ 用 `TextEncoder` 而不是「汉字数 × 3」：正文里混着英文、数字、全角标点，
 *   按字数估会把 3000 字的文章算成 9000 字节，而实际可能只有 7800。
 */
export function speechBytes(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

/**
 * 这段文本大概要花多少钱（元）。
 *
 * ★ 存在的理由是**知情**：用户点「朗读」时应该知道这一下要花几分钱。按篇显示
 *   比按「每千字多少钱」有用得多 —— 后者要他自己乘。
 */
export function estimateSpeechCost(text) {
  return (speechBytes(text) / 1000) * SILICON_PRICE_PER_KB;
}

/**
 * API Key 的展示形态：只露头尾。
 *
 * ★ 设置页必须能回答「填了没有」，但不能把完整 Key 再吐回浏览器一次 ——
 *   那等于把一个本可以只存在宿主进程里的密钥，复制到了渲染进程的内存和
 *   DevTools 的请求记录里。
 */
export function maskApiKey(key) {
  const raw = String(key ?? '');
  if (raw === '') return '';
  if (raw.length <= 8) return '••••';
  return `${raw.slice(0, 4)}••••${raw.slice(-4)}`;
}
