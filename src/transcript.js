/**
 * 字幕（播客单集的时间轴文本）的**共用判据**：宿主解析后要用它切段，渲染半区要用它
 * 格式化时间、判断「现在播到哪一段」。两边各写一份的结果是「跳转差 1.2 秒」「高亮卡在
 * 上一段」这类只有用户能发现的偏差 —— 所以常量与算法只写一遍。
 *
 * ★ 这里**不认识 HTTP、不认识文件系统**：只收「已经拿到的 segments」。
 *   解析（VTT / SRT / Podcasting 2.0 JSON）在 `host/transcript-parse.js`，
 *   落盘在 `host/transcript-store.js`，取网络在 `host/transcript-fetch.js`。
 */

/**
 * 上限。
 *
 * ★ 这些数字是**防呆**不是性能调优：一个两小时的单集约 1500 条 cue，`maxSegments`
 *   给到 12000 足够，而一条被投毒的 feed 塞进 50 万条会把界面卡死。
 * ★ 8 MB 是**单个字幕文件**的上限。实测 2 小时英文 VTT 约 180 KB，8 MB 已经是
 *   「一眼就不对劲」的量级。
 */
export const TRANSCRIPT_LIMITS = Object.freeze({
  maxSegments: 12_000,
  maxParagraphs: 4_000,
  maxBytes: 8 * 1024 * 1024,
  /** 相邻两条 cue 的间隔小于它，才有可能并成一段。 */
  mergeGapSeconds: 1.2,
  /** 并完超过这么多字就必须断段（阅读节奏，不是技术限制）。 */
  maxParagraphChars: 220,
  /** 并完至少这么多字，才允许在句末断开 —— 否则一句一断，读起来像电报。 */
  minBreakChars: 60,
});

/** 句末标点（中英）。用来决定「这里能不能断段」。 */
const SENTENCE_END = /[.!?…。！？]["'”’)\]]?\s*$/;

/**
 * 秒 → `mm:ss`（超过一小时给 `h:mm:ss`）。
 *
 * ★ 不认负数与非有限值：宁可显示 `--:--`，也不要显示 `-1:59`。
 * ★ 秒数向下取整。字幕是「已经过去的时间」，四舍五入会让 59.6 秒显示成 1:00，
 *   而音频还在 59 秒处 —— 用户会以为跳转有误差。
 */
export function formatClock(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return '--:--';
  const whole = Math.floor(total);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const pad = (value) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * `01:02:03.500` / `1:02.5` / `62` / `00:00:01,200` → 秒。认不出来给 `undefined`。
 *
 * ★ 逗号是 SRT 的写法，点号是 VTT 的写法，两种都要收 —— 只认一种的话，另一家的
 *   字幕会**整份解析成空**（每条 cue 都因时间戳非法被丢掉），界面显示「这期没有字幕」，
 *   而文件其实好得很。
 */
export function parseClock(stamp) {
  if (typeof stamp !== 'string') return undefined;
  const text = stamp.trim().replace(',', '.');
  if (text === '') return undefined;
  const parts = text.split(':');
  if (parts.length === 0 || parts.length > 3) return undefined;
  let total = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return undefined;
    total = total * 60 + value;
  }
  return Number.isFinite(total) ? total : undefined;
}

/**
 * 清洗解析结果：丢掉时间轴不合法的条目、按起点排序、把完全重复的 cue 去掉。
 *
 * ★ 为什么要「排序」：YouTube 的自动字幕、以及部分 SRT 在滚动字幕里会乱序。不排序时
 *   段落合并算法（按相邻间隙并段）会把两条相隔两小时的字幕并成一段。
 * ★ 为什么不在这里合并重叠：音频是线性的，重叠的 cue 显示时天然是「后一条覆盖前一条」，
 *   合并反而会改变原文。
 *
 * @param {Array<{start:number,end:number,text:string}>} raw
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function normalizeSegments(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (out.length >= TRANSCRIPT_LIMITS.maxSegments) break;
    const start = Number(item?.start);
    const end = Number(item?.end);
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(end) || end <= start) continue;
    if (text === '') continue;
    // 同一秒同一句话重复出现（VTT 的 roll-up 字幕常见）只留一条。
    const stamp = `${start.toFixed(2)}|${text}`;
    if (seen.has(stamp)) continue;
    seen.add(stamp);
    out.push({ start, end, text });
  }
  out.sort((left, right) => left.start - right.start);
  return out;
}

/**
 * cue → 段落。
 *
 * ★ 为什么必须并段：一条 cue 常常只有 3–6 个词（自动字幕按呼吸切），逐条渲染成
 *   一行的话，两小时的单集是 1500 个可点行 —— 界面上是一堵墙，而且「读到哪」这件事
 *   会退化成「看到哪一行」。
 * ★ 断段的三条判据（全都要满足才继续并）：
 *     ① 间隔 ≤ `mergeGapSeconds`（留白是语义上的段落边界）；
 *     ② 并完不超过 `maxParagraphChars`；
 *     ③ 当前这段还没到「句末 + 至少 minBreakChars」—— 到了就应该断，否则一段里挤进
 *        五六个句子，点一下跳转的粒度又太粗。
 *
 * @param {Array<{start:number,end:number,text:string}>} segments - 已经 `normalizeSegments` 过。
 * @param {Partial<typeof TRANSCRIPT_LIMITS>} [options]
 * @returns {Array<{start:number,end:number,text:string}>}
 */
export function paragraphize(segments, options = {}) {
  const gap = Number.isFinite(options.mergeGapSeconds) ? options.mergeGapSeconds : TRANSCRIPT_LIMITS.mergeGapSeconds;
  const maxChars = Number.isFinite(options.maxParagraphChars) ? options.maxParagraphChars : TRANSCRIPT_LIMITS.maxParagraphChars;
  const minBreak = Number.isFinite(options.minBreakChars) ? options.minBreakChars : TRANSCRIPT_LIMITS.minBreakChars;
  const limit = Number.isFinite(options.maxParagraphs) ? options.maxParagraphs : TRANSCRIPT_LIMITS.maxParagraphs;

  const out = [];
  let current = null;
  const flush = () => {
    if (current) out.push(current);
    current = null;
  };
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (out.length >= limit) break;
    if (current === null) {
      current = { start: segment.start, end: segment.end, text: segment.text };
      continue;
    }
    const joined = `${current.text} ${segment.text}`;
    const closeEnough = segment.start - current.end <= gap;
    const fits = joined.length <= maxChars;
    const shouldBreak = SENTENCE_END.test(current.text) && current.text.length >= minBreak;
    if (closeEnough && fits && !shouldBreak) {
      current.text = joined;
      current.end = segment.end;
    } else {
      flush();
      current = { start: segment.start, end: segment.end, text: segment.text };
    }
  }
  flush();
  return out;
}

/**
 * 当前时间落在第几段。
 *
 * ★ 停在两段之间的空白里时返回**上一段**，不是 -1：音频在句间停顿，字幕全灭再亮，
 *   读起来像接触不良。返回上一段的代价是「高亮多停留 0.4 秒」，可接受。
 * ★ 时间在第一段之前返回 -1（还没开始读，不该有任何一段亮着）。
 * ★ 用二分：2000 段 × 每秒 4 次 `timeupdate` 的线性扫描是白烧 CPU。
 *
 * @param {Array<{start:number,end:number}>} paragraphs
 * @param {number} time - 秒。
 * @returns {number} 段落下标，或 -1。
 */
export function activeParagraphIndex(paragraphs, time) {
  const list = Array.isArray(paragraphs) ? paragraphs : [];
  if (list.length === 0) return -1;
  const t = Number(time);
  if (!Number.isFinite(t)) return -1;
  if (t < list[0].start) return -1;
  let low = 0;
  let high = list.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (list[mid].start <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * 从订阅条目里取字幕地址。
 *
 * ★ 只收 `https:`：字幕文件是 feed 给的第三方地址，`http:` 会被中间人替换成任意文本，
 *   而那段文本会**当成正文**展示给用户。与 `media.js` 里音频地址的判据同一条理由。
 * ★ 类型缺省时返回空串，由解析层按内容嗅探（`parseTranscript` 认得 VTT / SRT / JSON）。
 *
 * @param {object} entry - feed 归一化后的条目（见 `host/feeds.js`）。
 * @returns {{ url: string, type: string } | undefined}
 */
export function transcriptRefOf(entry) {
  const raw = entry?.transcript;
  const value = typeof raw === 'string' ? raw : raw?.url;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  const type = typeof raw?.type === 'string' ? raw.type.trim().toLowerCase() : '';
  return { url: url.href, type };
}

/**
 * 一条字幕的「来源标签」：界面上要说清这份字幕是哪来的。
 *
 * ★ 三种来源对用户的意义完全不同：官方 = 时间轴可信；本插件生成 = 可能有错字；
 *   手工导入 = 不知道是谁做的。合并成一句「字幕」会让人以为都是官方的。
 */
export const TRANSCRIPT_SOURCES = Object.freeze({
  feed: '订阅源提供',
  manual: '手动导入',
  asr: '本机识别',
  cloud: '云端识别',
});

/** 把来源 id 翻成中文；未知来源一律落回「来源不明」，不显示 id。 */
export function transcriptSourceLabel(source) {
  return TRANSCRIPT_SOURCES[source] ?? '来源不明';
}

/**
 * 落盘记录 → 给界面/agent 的视图。
 *
 * ★ **只有这一份**。宿主（Remote 方法）与 HTTP 路由（`/transcript`）都要给同一个
 *   形状；两处各拼一次的话，`segments` 与 `paragraphs` 的口径迟早分叉，而症状是
 *   「面板里 320 段、agent 工具说 828 段」—— 两边都"对"，用户没法判断谁是真的。
 * ★ 段落切分在这里做（每次读都切一遍）：一集 1500 条 cue 的切分是毫秒级，
 *   换来的是「合并规则改了，旧缓存也立刻按新规则显示」。
 *
 * @param {{ key: string, source?: object, format?: string, fetchedAt?: number, segments: Array }} record
 * @returns {{ key: string, source: object, format: string, fetchedAt: number, segments: number, paragraphs: Array } | null}
 */
export function transcriptView(record) {
  if (record === null || record === undefined) return null;
  const segments = Array.isArray(record.segments) ? record.segments : [];
  return {
    key: record.key,
    source: record.source ?? {},
    format: record.format ?? '',
    fetchedAt: Number.isFinite(record.fetchedAt) ? record.fetchedAt : 0,
    segments: segments.length,
    paragraphs: paragraphize(segments),
  };
}

/**
 * 这段话是不是**本来就以中文为主**。
 *
 * ★ 用来跳过翻译。中文播客的字幕本来就是中文，再送一遍模型只会把「我们」
 *   译成「我们」，白花钱，还可能把专有名词改坏（实测过把「特斯拉」译成
 *   「Tesla 公司」这种回译）。
 * ★ 判据是「汉字占非空白非标点字符的比例 > 0.5」，**不是**「含有汉字」：
 *   中文口播里常见 `OK，那我们开始吧`（含汉字但主体是混合），也常见
 *   `This is a podcast`（一个汉字都没有）。只判「有没有」会把整段英文
 *   里夹一个「谢谢」的样本误判成中文而跳过翻译 —— 用户看到的就是
 *   「这段没翻译」。
 */
export function isMostlyChinese(text) {
  const value = String(text ?? '');
  let cjk = 0;
  let total = 0;
  for (const ch of value) {
    if (/[\s，。、！？；：「」『』（）【】《》…—–·,.!?;:'"()[\]{}<>/\\|-]/.test(ch)) continue;
    const code = ch.codePointAt(0);
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
    total += 1;
  }
  if (total === 0) return false;
  return cjk / total > 0.5;
}
