/**
 * 字幕文件解析：WebVTT / SubRip(SRT) / Podcasting 2.0 JSON。
 *
 * ★ 为什么放在宿主：渲染半区拿到的应该是**已经切好段落**的结构，而不是一份原始文本。
 *   放在两半区都能拿到的地方（比如 `src/transcript.js`）会诱使某处再解析一遍，
 *   于是「同样的 VTT 在面板里和在 agent 工具里切出的段落不一样」。
 *
 * ★ 只认三种格式，理由不是懒：`<podcast:transcript>` 规范里真正被广泛使用的就是
 *   `text/vtt`、`application/x-subrip`、`application/json`。`text/html` 那份是给人看的，
 *   抓回来是整页 DOM，解析它等于再写一个正文抽取器 —— 那是 P0 不做的事。
 */

import { TRANSCRIPT_LIMITS, normalizeSegments, parseClock } from '../transcript.js';

/** 字幕格式的规范化名字（落到盘上、显示在界面上都用它）。 */
export const TRANSCRIPT_FORMATS = Object.freeze({
  VTT: 'vtt',
  SRT: 'srt',
  JSON: 'json',
});

/** 带机器可读 `code` 的错误：路由层要按 code 决定状态码，靠匹配中文文案会静默漂移。 */
export class TranscriptError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'TranscriptError';
    this.code = code;
    this.status = status;
  }
}

/** HTML 实体：VTT 里允许，SRT 里偶见。只解这几条，不做通用 HTML 解码。 */
const ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
});

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * 清一条 cue 的文本。
 *
 * ★ 三类必须清掉的东西，都来自真实字幕文件：
 *   1. `<c.colorE5E5E5>` / `<i>` 这类内联标签 —— 不清就会原样出现在正文里；
 *   2. `<00:00:01.500>` 卡拉 OK 时间戳（YouTube 自动字幕的逐词时间）—— 它是**控制符**，
 *      不是内容；
 *   3. `{\an8}` 这类 ASS 定位标记 —— 有些转换工具会把 SRT 转成带 ASS 头的文本。
 * ★ 清完如果只剩空白，这条 cue 就丢掉（纯音乐标记、纯换行很常见）。
 */
function cleanCueText(raw) {
  const text = String(raw ?? '')
    .replace(/<(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\\[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return decodeEntities(text);
}

/** `00:01:02.500 --> 00:01:05.000 align:start position:0%` 里取两端。 */
function parseCueLine(line) {
  const arrow = line.indexOf('-->');
  if (arrow < 0) return undefined;
  const left = line.slice(0, arrow).trim();
  // 右侧只取第一个空白之前的部分：后面跟的是 `align:` / `line:` / `position:` 等设置。
  const right = line.slice(arrow + 3).trim().split(/\s+/)[0] ?? '';
  const start = parseClock(left);
  const end = parseClock(right);
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

/**
 * 按空行切块，再从每块里找 `-->` 那一行。VTT 与 SRT 的差别只有时间戳的分隔符
 * （点号 / 逗号）与块首的序号，`parseClock` 两种都认，所以两个解析器共用这一份主体。
 *
 * ★ 跳过 `WEBVTT` 头、`NOTE` / `STYLE` / `REGION` 块：它们没有 `-->`，会被
 *   `parseCueLine` 自然滤掉，不需要单独写分支（少一个分支就少一处判据）。
 */
function parseCueBlocks(body) {
  const cues = [];
  const normalized = String(body ?? '').replace(/\r\n?/g, '\n');
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const index = lines.findIndex((line) => line.includes('-->'));
    if (index < 0) continue;
    const timing = parseCueLine(lines[index]);
    if (timing === undefined) continue;
    const text = cleanCueText(lines.slice(index + 1).join(' '));
    if (text === '') continue;
    cues.push({ start: timing.start, end: timing.end, text });
  }
  return cues;
}

/** WebVTT。 */
export function parseVtt(text) {
  return normalizeSegments(parseCueBlocks(text));
}

/** SubRip。与 VTT 共用主体，只是历史原因分开导出，方便判据指名道姓。 */
export function parseSrt(text) {
  return normalizeSegments(parseCueBlocks(text));
}

/**
 * Podcasting 2.0 JSON（`<podcast:transcript type="application/json">`）。
 *
 * 形状：`{"version":"1.0.0","segments":[{"startTime":0,"endTime":1.5,"body":"…"}]}`
 *
 * ★ `startTime` / `endTime` 是**秒**（可以是小数），不是时间戳字符串 —— 这也是它
 *   与 VTT 唯一实质的差别。
 * ★ 缺 `endTime` 时用 `startTime + 2` 兜底：规范允许省略，而丢掉这些条目会让整份
 *   字幕只剩零星几段。
 */
export function parsePodcastJson(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch {
    throw new TranscriptError('字幕文件不是合法 JSON', 'TRANSCRIPT_JSON', 422);
  }
  const raw = Array.isArray(data) ? data : data?.segments;
  if (!Array.isArray(raw)) throw new TranscriptError('字幕 JSON 里没有 segments 数组', 'TRANSCRIPT_JSON', 422);
  const segments = [];
  for (const item of raw) {
    const start = Number(item?.startTime);
    if (!Number.isFinite(start) || start < 0) continue;
    const end = Number.isFinite(Number(item?.endTime)) ? Number(item.endTime) : start + 2;
    segments.push({ start, end, text: String(item?.body ?? '') });
  }
  return normalizeSegments(segments);
}

/**
 * 按声明类型解析；类型缺失或认不出时**按内容嗅探**。
 *
 * ★ 为什么要嗅探：`<podcast:transcript>` 的 `type` 属性是**可选**的，实测相当一部分
 *   节目不写。直接判「没类型就不支持」会让这些节目永远显示「没有字幕」。
 * ★ 顺序是 JSON → VTT → SRT：JSON 以 `{` 开头、VTT 以 `WEBVTT` 开头，两者不会误判；
 *   剩下的带 `-->` 一律当 SRT 解析（它与 VTT 共用主体）。
 *
 * @param {string} text - 文件正文。
 * @param {string} [declaredType] - 形如 `text/vtt`。
 * @returns {{ format: string, segments: Array<{start:number,end:number,text:string}> }}
 */
export function parseTranscript(text, declaredType = '') {
  const body = typeof text === 'string' ? text : '';
  if (body.length > TRANSCRIPT_LIMITS.maxBytes) {
    throw new TranscriptError('字幕文件过大', 'TRANSCRIPT_TOO_LARGE', 413);
  }
  const type = String(declaredType ?? '').toLowerCase().split(';')[0].trim();
  const declaredFormat = /vtt/.test(type)
    ? TRANSCRIPT_FORMATS.VTT
    : /subrip|srt/.test(type)
      ? TRANSCRIPT_FORMATS.SRT
      : /json/.test(type)
        ? TRANSCRIPT_FORMATS.JSON
        : '';

  const trimmed = body.trimStart();
  const guessedFormat = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? TRANSCRIPT_FORMATS.JSON
    : /^WEBVTT/i.test(trimmed)
      ? TRANSCRIPT_FORMATS.VTT
      : body.includes('-->')
        ? TRANSCRIPT_FORMATS.SRT
        : '';

  /**
   * 格式判定：**内容嗅探优先于声明类型**，只有嗅不出来时才信 `type`。
   *
   * ★ 反过来（声明优先）会踩一类真事：节目把 `application/json` 的字幕文件
   *   声明成 `text/vtt`，于是它被当成 cue 文本解析，一条都切不出来，界面显示
   *   「字幕里没有可用的时间轴条目」—— 而文件是好的。嗅探赢的代价只是「标签写错
   *   时以内容为准」，这正是我们要的结果。
   */
  const format = guessedFormat !== ''
    ? guessedFormat
    : declaredFormat;

  if (format === '') throw new TranscriptError('认不出这份字幕的格式（支持 VTT / SRT / Podcasting 2.0 JSON）', 'TRANSCRIPT_FORMAT', 415);

  const segments = format === TRANSCRIPT_FORMATS.JSON
    ? parsePodcastJson(body)
    : normalizeSegments(parseCueBlocks(body));
  if (segments.length === 0) throw new TranscriptError('字幕里没有可用的时间轴条目', 'TRANSCRIPT_EMPTY', 422);
  return { format, segments };
}
