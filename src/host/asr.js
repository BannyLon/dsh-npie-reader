/**
 * 本机语音识别（0.82.0）：订阅源没给字幕时，用本机模型把音频转成字幕。
 *
 * ── 为什么要自己识别 ──────────────────────────────────────────────────
 *
 * Podcasting 2.0 的 `<podcast:transcript>` 只是「可选的附加物」。实测中文播客
 * （硅谷101、忽左忽右、半拿铁、知行小酒馆）**全部没有**这一项，英文播客里也常
 * 只有 `text/html`（解析不了）。也就是说「没字幕」不是个别情况，而是多数情况。
 * 只做「抓订阅源字幕」就等于给一半节目判了死刑。
 *
 * ── 引擎与模型 ────────────────────────────────────────────────────────
 *
 * 引擎用 CrispASR（MIT，whisper.cpp 的兼容实现，macOS arm64 单文件 17.8 MB）。
 * 不要求用户 `brew install`：brew 那套会连带升级 llama.cpp / libomp / ssl，
 * 改动十几个包，代价远超一个插件该有的分量。这里把引擎下载到插件自己的数据
 * 目录，删掉目录就等于卸载干净。
 *
 * ★ **不打包二进制**：17.8 MB 的 dylib 塞进插件包会让每次安装都背着它，而绝大多数
 *   用户只在「确实遇到没字幕的集子」时才需要。按需下载，下过一次就不再下。
 *
 * ── 时间轴怎么来 ──────────────────────────────────────────────────────
 *
 * 整段音频先转成 16 kHz 单声道 WAV（一次），然后按 5 分钟切片识别。切片**不切文件**：
 * CrispASR 的 `-ot`（毫秒偏移）会把时间戳直接加到输出上（实测 `-ot 30000` 的首段
 * 是 `from: 30000`），所以同一个 wav 反复读不同区段即可，省掉一整套临时文件。
 *
 * ★ 为什么一定要切片：一集 1–3 小时，整段识别要十几分钟。做成一个调用的话，
 *   界面在十几分钟里没有任何进展可显示，用户分不清「在跑」与「卡死」，也没法停。
 */

import { spawn } from 'node:child_process';
import { access, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 引擎版本与下载地址。改版本就换一个 release tag，别用 latest（结果会漂）。 */
export const ASR_ENGINE = Object.freeze({
  name: 'CrispASR',
  version: '0.8.54',
  /** macOS arm64 包（含 crispasr 可执行文件与 libc2pa_c.dylib）。 */
  asset: 'crispasr-macos-arm64.tar.gz',
});

/**
 * 下载镜像。按顺序试，第一个通了就用。
 *
 * ★ 为什么需要镜像：GitHub release 的下载域名（objects.githubusercontent.com）
 *   在国内是「API 能通、文件下载空回复」—— 本机实测 `curl` 报 `Empty reply`，
 *   而 `api.github.com` 一切正常。所以不能靠「能不能 ping 通 GitHub」来判断。
 * ★ 最后一项是直连：在能直连的环境（CI、海外）不该被迫走第三方代理。
 */
export const ASR_MIRRORS = Object.freeze([
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  '',
]);

/** 模型下载源（Hugging Face 镜像；国内可直连，官方域名常常超时）。 */
export const ASR_MODEL_BASE = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/';

/**
 * 可选的模型。`sizeMb` 是下载体积（不是内存占用）。
 *
 * ★ 默认 `small`：`base` 对中文明显不够用（实测把「HF0」听成「HFZERO」、
 *   「球季」听成「球计」）。`small` 只多 40 MB，中文准确率高一档。
 * ★ `turbo` 是「准但慢」的选项：一小时音频在 M 系列上约 3–5 分钟（subcast 实测），
 *   适合愿意等的人。
 */
export const ASR_MODELS = Object.freeze([
  {
    id: 'base',
    name: 'Whisper base',
    file: 'ggml-base.bin',
    sizeMb: 142,
    note: '最快，中文错字偏多；先用它试水',
  },
  {
    id: 'small',
    name: 'Whisper small（推荐）',
    file: 'ggml-small-q5_1.bin',
    sizeMb: 181,
    note: '中英文都够用，一小时音频约 2–3 分钟',
  },
  {
    id: 'turbo',
    name: 'Whisper large-v3-turbo',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sizeMb: 547,
    note: '最准，一小时音频约 5–8 分钟',
  },
]);

export const DEFAULT_MODEL_ID = 'small';

/** 一片多少毫秒。5 分钟：既能让进度条动起来，又不至于同一步反复加载模型。 */
export const SLICE_MS = 5 * 60 * 1000;

/** 带状态码的失败：路由层选 HTTP 状态，界面照着文案说人话。 */
export class AsrError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AsrError';
    this.status = status;
    this.code = code;
  }
}

/** 可执行文件的常见位置。★ 从 Dock 启动的 Electron 看不到 `/opt/homebrew/bin`。 */
const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  join(homedir(), '.local', 'bin'),
];

function pluginDirs(dataDir) {
  const root = join(dataDir, 'asr');
  return {
    root,
    engineDir: join(root, `crispasr-${ASR_ENGINE.version}`),
    engineBin: join(root, `crispasr-${ASR_ENGINE.version}`, 'crispasr'),
    modelsDir: join(root, 'models'),
    tmpDir: join(root, 'tmp'),
  };
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 与已知目录里找一个可执行文件；返回绝对路径或空串。 */
export async function findExecutable(names, extraDirs = []) {
  const dirs = [...extraDirs, ...String(process.env.PATH ?? '').split(':'), ...EXTRA_BIN_DIRS]
    .filter((dir) => typeof dir === 'string' && dir !== '');
  for (const name of names) {
    // 已经带路径的直接试，不去每个目录里拼一遍。
    if (name.includes('/')) {
      if (await isExecutable(name)) return name;
      continue;
    }
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return '';
}

async function fileSizeMB(path) {
  try {
    return (await stat(path)).size / (1024 * 1024);
  } catch {
    return 0;
  }
}

/**
 * 现有模型：插件自己下的 + 用户机器上已有的。
 *
 * ★ 为什么要找机器上已有的：subcast 的经验是「很多应用已经带了 ggml 模型」
 *   （Screen Studio 就有一个 1.4 GB 的 medium）。能直接复用就不该让用户再下一份
 *   181 MB。这里只查几个确定的位置，不做全盘扫描 —— 全盘扫描在冷启动时会卡住界面。
 */
async function existingModels(dataDir) {
  const dirs = pluginDirs(dataDir);
  const discovered = [];
  const seen = new Set();
  for (const model of ASR_MODELS) {
    const path = join(dirs.modelsDir, model.file);
    if ((await fileSizeMB(path)) > 1) {
      discovered.push({ ...model, path, origin: '插件下载' });
      seen.add(model.file);
    }
  }
  const extraDirs = [
    join(homedir(), 'whisper.cpp', 'models'),
    join(homedir(), '.cache', 'whisper.cpp'),
    join(homedir(), 'Library', 'Application Support', 'Screen Studio'),
  ];
  for (const dir of extraDirs) {
    for (const model of ASR_MODELS) {
      if (seen.has(model.file)) continue;
      const path = join(dir, model.file);
      if ((await fileSizeMB(path)) > 1) {
        discovered.push({ ...model, path, origin: '机器上已有' });
        seen.add(model.file);
      }
    }
  }
  return discovered;
}

/**
 * 探测本机能不能识别：解码器、引擎、模型三件套分别就位没有。
 *
 * ★ 三者分开报，不合并成一个 `ready`：用户需要知道「缺什么、补哪一步」。
 *   只给一个 false，界面只能写一句「暂不可用」—— 用户既不知道要下载 181 MB，
 *   也不知道自己其实只差一个 ffmpeg。
 */
export async function probeAsr({ dataDir, log = () => {} } = {}) {
  const dirs = pluginDirs(dataDir);
  const ffmpeg = await findExecutable(['ffmpeg']);
  const systemEngine = await findExecutable(['whisper-cli', 'whisper-cpp', 'main']);
  const ownEngine = (await isExecutable(dirs.engineBin)) ? dirs.engineBin : '';
  const enginePath = ownEngine || systemEngine;
  const models = await existingModels(dataDir);
  const missing = [];
  if (ffmpeg === '') missing.push('ffmpeg');
  if (enginePath === '') missing.push('engine');
  if (models.length === 0) missing.push('model');
  if (missing.length > 0) log(`[识别] 缺：${missing.join('、')}`);
  return {
    ffmpeg: { ok: ffmpeg !== '', path: ffmpeg },
    engine: {
      ok: enginePath !== '',
      path: enginePath,
      name: enginePath === ownEngine && ownEngine !== '' ? ASR_ENGINE.name : 'whisper.cpp',
      version: enginePath === ownEngine && ownEngine !== '' ? ASR_ENGINE.version : '',
    },
    models,
    defaultModel: models.some((model) => model.id === DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : (models[0]?.id ?? ''),
    ready: missing.length === 0,
    missing,
  };
}

/** 取模型路径；找不到给空串（调用方据此报「先下模型」）。 */
export function modelPathOf(probe, modelId) {
  const wanted = String(modelId ?? '') || probe?.defaultModel || DEFAULT_MODEL_ID;
  const hit = (probe?.models ?? []).find((model) => model.id === wanted);
  return hit?.path ?? '';
}

/**
 * 下载到文件，**带断点续传**。
 *
 * ★ 为什么必须有续传：模型 181 MB，本机实测同一条镜像链路时快时慢（142 MB 的 base
 *   用了 3.5 分钟，随后 181 MB 的 small 六分钟只下到 72 MB）。不续传的话，任何一次
 *   网络抖动都让用户从头再来 ——「下了十分钟又归零」是最容易让人放弃的体验。
 * ★ 用 `.part` 而不是直接写目标文件：只有完整下完才 `rename`。半截文件被当成模型
 *   用时，报错是「引擎崩溃」，比「没下完」难查得多。
 */
export async function fetchToFile(url, path, { onProgress, signal } = {}) {
  const tmp = `${path}.part`;
  await mkdir(dirname(path), { recursive: true });
  let have = 0;
  try {
    have = Math.max(0, (await stat(tmp)).size);
  } catch {
    have = 0;
  }
  const response = await fetch(url, {
    signal,
    redirect: 'follow',
    // 有半截就只要后半段。服务端不认 Range 会回 200 全量，下面按 200 处理。
    headers: have > 0 ? { range: `bytes=${have}-` } : {},
  });
  if (!response.ok && response.status !== 206) {
    throw new AsrError(`下载失败：HTTP ${response.status}`, 502, 'ASR_DOWNLOAD');
  }
  const partial = response.status === 206;
  // 服务端不支持续传时从头写：`have` 归零，否则进度会从 40% 起跳。
  if (!partial) have = 0;
  const length = Number(response.headers.get('content-length') ?? 0);
  const total = partial ? have + length : length;
  const handle = await open(tmp, partial ? 'a' : 'w');
  let written = have;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new AsrError('下载流为空', 502, 'ASR_DOWNLOAD');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      written += value.byteLength;
      // 有的 CDN 不给 content-length，那就只在进度里报已下字节，不报百分比。
      onProgress?.(total > 0 ? Math.min(1, written / total) : 0, written, total);
    }
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  return written;
}

/**
 * 确保引擎可执行文件在插件目录里。
 *
 * ★ 解压用 `tar` 子进程而不是在 JS 里解 gzip：`tar` 是 macOS 自带命令，
 *   而 gzip + tar 的两段解压在几十 MB 上有明显的额外内存与代码量。
 */
export async function ensureEngine({ dataDir, log = () => {}, onProgress, signal } = {}) {
  const dirs = pluginDirs(dataDir);
  if (await isExecutable(dirs.engineBin)) return dirs.engineBin;
  await mkdir(dirs.root, { recursive: true });
  const archive = join(dirs.root, ASR_ENGINE.asset);
  let lastError = null;
  for (const mirror of ASR_MIRRORS) {
    const url = `${mirror}https://github.com/CrispStrobe/CrispASR/releases/download/v${ASR_ENGINE.version}/${ASR_ENGINE.asset}`;
    try {
      log(`[识别] 下载引擎：${mirror === '' ? '直连' : mirror}`);
      await fetchToFile(url, archive, { onProgress, signal });
      // 归档里是 `crispasr-macos-arm64/` 一个目录。摊平到 engineDir（`--strip-components=1`），
      // 这样路径不依赖归档里的目录名 —— 上游换个命名，这边不用跟着改。
      await mkdir(dirs.engineDir, { recursive: true });
      await runCapture('tar', ['-xzf', archive, '-C', dirs.engineDir, '--strip-components=1'], { signal });
      // ★ 归档里的可执行位一般不丢，但「一般」不够：有的代理会把 tar 原样转发、
      //   落到 umask 022 的目录里就成了 `rw-r--r--`，随后 `isExecutable` 判死，
      //   界面报「引擎没能下载下来」而文件明明在 —— 这种错误最难自证。
      //   补一次 chmod，代价是一次系统调用。
      await chmod(dirs.engineBin, 0o755).catch(() => undefined);
      break;
    } catch (error) {
      lastError = error;
      log(`[识别] 引擎下载失败（${mirror || '直连'}）：${error?.message ?? error}`);
    }
  }
  if (!(await isExecutable(dirs.engineBin))) {
    throw new AsrError(
      `识别引擎没能下载下来${lastError ? `：${lastError.message}` : ''}。可以换个网络再试，或者手动装 whisper.cpp（brew install whisper.cpp）。`,
      502,
      'ASR_ENGINE_MISSING',
    );
  }
  await unlink(archive).catch(() => undefined);
  return dirs.engineBin;
}

/** 确保某个模型在插件目录里；返回模型路径。 */
export async function ensureModel({ dataDir, modelId, log = () => {}, onProgress, signal } = {}) {
  const dirs = pluginDirs(dataDir);
  const model = ASR_MODELS.find((item) => item.id === (modelId || DEFAULT_MODEL_ID)) ?? ASR_MODELS[1];
  const path = join(dirs.modelsDir, model.file);
  if ((await fileSizeMB(path)) > 1) return path;
  // 机器上已有同款就直接指过去，不复制（subcast 也只做「链接」不做「复制」）。
  const probe = await probeAsr({ dataDir });
  const existing = probe.models.find((item) => item.id === model.id);
  if (existing) return existing.path;
  await mkdir(dirs.modelsDir, { recursive: true });
  log(`[识别] 下载模型 ${model.file}（${model.sizeMb} MB）`);
  await fetchToFile(`${ASR_MODEL_BASE}${model.file}`, path, { onProgress, signal });
  return path;
}

/** 跑一个命令并收集输出；非零退出把 stderr 尾部带进错误里。 */
export function runCapture(command, args, { signal, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new AsrError(`${command} 退出码 ${code}：${stderr.trim().slice(-300)}`, 500, 'ASR_SPAWN'));
    });
  });
}

/**
 * 远端音频 → 16 kHz 单声道 WAV。
 *
 * ★ 为什么整段转一次，而不是每片直接 `-ss` 从网上取：播客托管是短链 302 到 CDN，
 *   每片都要重新握手并重新定位，5 分钟片的光是握手就占掉好几秒，24 片就是两分钟
 *   纯等待；而且 MP3 的 seek 精度靠估算，切点可能落在句子中间。
 * ★ `-nostdin` 必须有：Electron 里子进程继承 stdin，ffmpeg 会等它而卡住。
 */
export async function toWav({ ffmpeg, url, outPath, signal, timeoutMs = 30 * 60 * 1000 } = {}) {
  if (ffmpeg === '') throw new AsrError('本机没有 ffmpeg，无法解码音频', 501, 'ASR_NO_FFMPEG');
  await mkdir(dirname(outPath), { recursive: true });
  await runCapture(ffmpeg, [
    '-nostdin', '-loglevel', 'error',
    '-i', url,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-y', outPath,
  ], { signal, timeoutMs });
  const size = await stat(outPath).catch(() => null);
  if (size === null || size.size < 1000) throw new AsrError('音频解码后是空的', 422, 'ASR_EMPTY_AUDIO');
  // 16 kHz × 2 字节/采样 = 32000 B/s（WAV 头 44 字节忽略不计）。
  return Math.round(size.size / 32000);
}

/**
 * 识别用的提示词。
 *
 * ★ 简体引导不是装饰：whisper 的中文输出默认是**繁体**（实测「美國人/簽證/遺憾」）。
 *   大陆用户看到一整篇繁体，第一反应是「这是从台湾站抓的吗」。加一句「用简体中文
 *   转写」之后同一段音频直接输出简体，标点也从全角逗号变成规范的逗号。
 * ★ 专名要放进去，这是 subcast 的实测结论：一位叫「曾鸣」的嘉宾，不给背景时
 *   Whisper 写成「曾敏」、Qwen3-ASR 写成「曾明」；给节目简介后两者都对了。
 *   本机复现：`HFZERO` → `HF0`。所以标题与节目名必须进提示词。
 * ★ 长度上限 160 字：Whisper 的 prompt 只有 n_text_ctx/2 个 token，而**末尾权重最大**
 *   —— 所以把「用简体」放最前、标题放最后，被截断时先丢的是中间那截泛泛的描述。
 */
export function buildPrompt({ title = '', show = '', language = 'zh' } = {}) {
  const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const head = (language === 'zh' || language === 'auto' || language === '')
    ? '以下是普通话的句子，用简体中文转写。'
    : '';
  const tail = [clean(title), clean(show)].filter((part) => part !== '').join('，');
  const budget = 160;
  const headPart = head.slice(0, Math.max(0, budget - 40));
  const room = Math.max(0, budget - headPart.length - 1);
  const tailPart = tail.slice(0, room);
  return `${headPart}${tailPart === '' ? '' : `${tailPart}。`}`.trim();
}

/**
 * 识别器 JSON → 段落。
 *
 * CrispASR / whisper.cpp 的 `-oj` 形状相同：`{ transcription: [{ offsets: { from, to }, text }] }`，
 * 毫秒。**不读 `timestamps` 字符串**：那是格式化过的 `hh:mm:ss,mmm`，再解析一遍等于
 * 让同一个时间轴有两种来源，偏移一多就会各自漂。
 */
export function parseRecognizerJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw ?? ''));
  } catch {
    throw new AsrError('识别结果不是合法 JSON', 502, 'ASR_BAD_JSON');
  }
  const list = Array.isArray(parsed?.transcription) ? parsed.transcription : [];
  const out = [];
  for (const item of list) {
    const text = String(item?.text ?? '').trim();
    if (text === '') continue;
    const from = Number(item?.offsets?.from);
    const to = Number(item?.offsets?.to);
    if (!Number.isFinite(from)) continue;
    out.push({
      start: Math.max(0, from / 1000),
      end: Math.max(0, (Number.isFinite(to) ? to : from + 1200) / 1000),
      text,
    });
  }
  return out;
}

/**
 * whisper 在静音处会「编」出话来。这里把它最常见的几种丢掉。
 *
 * ★ 必要性：一集播客里有片头音乐、片尾音乐、以及讲话之间的长停顿。模型在这些
 *   位置没有音频可对齐，就用训练数据里最高频的那几句填空 —— 中文是「谢谢观看」
 *   「请不吝点赞」，英文是「Thanks for watching」「Subtitles by…」。用户看到的是
 *   字幕里突然冒出一句从没说过的话。
 * ★ 只在「短且没有上下文」时才删：一句 30 字以上、持续 4 秒以上的话，即便包含
 *   「订阅」也大概率是真在说订阅 —— 误删真话比留一句幻觉更糟。
 * ★ 相邻重复也删：模型卡住时会把同一句连着吐两遍（时长与文本完全一样）。
 */
export const HALLUCINATION_PHRASES = Object.freeze([
  '谢谢观看', '感谢观看', '谢谢大家观看', '请不吝点赞', '字幕由', '字幕by', '字幕提供',
  '訂閱', '訂閱頻道', '請訂閱', '感謝觀看', '謝謝觀看', '字幕由', '字幕提供',
  'thanks for watching', 'thank you for watching', 'subtitles by', 'amara.org',
  'subscribe to my channel', 'like and subscribe',
]);

const MUSIC_ONLY = /^[\s[\[(（【♪]*[\[\]()（）【】\s]*(music|音乐|音樂|applause|掌声|掌聲|laughter|笑声|笑聲|♪+)[\]\)）】♪\s]*$/i;

export function cleanCues(cues) {
  const out = [];
  for (const cue of Array.isArray(cues) ? cues : []) {
    let text = String(cue?.text ?? '').replace(/♪/g, '').replace(/\[\]/g, '').replace(/\(\)/g, '').trim();
    if (text === '' || MUSIC_ONLY.test(text)) continue;
    const lower = text.toLowerCase();
    const seconds = Number(cue?.end) - Number(cue?.start);
    const chars = [...text].length;
    if (seconds < 4 && chars < 30 && HALLUCINATION_PHRASES.some((phrase) => lower.includes(phrase))) continue;
    if (out.length > 0 && out[out.length - 1].text === text) continue;
    out.push({ start: Number(cue.start) || 0, end: Number(cue.end) || 0, text });
  }
  return out;
}

/**
 * 识别一片。`startMs` 交给引擎的 `-ot`，输出的时间戳已经是全局时间。
 *
 * ★ 每片都新起一个进程（不是常驻服务）：模型加载虽然要多花一两秒，但换来的是
 *   「崩一片不影响整集」与「随时能停」—— 常驻进程崩了要整集重来。
 */
export async function recognizeSlice({
  bin, model, wav, startMs = 0, durationMs = SLICE_MS, language = 'zh', prompt = '', threads = 0, signal, outDir,
} = {}) {
  const outBase = join(outDir, `slice-${Math.round(startMs / 1000)}`);
  // ★ 引擎不会替我们建目录：目录不存在时它安静地不写文件，随后「读不到 JSON」
  //   会被误报成「识别结果是空的」。先建，让失败点落在真正的原因上。
  await mkdir(outDir, { recursive: true });
  const args = [
    '-m', model,
    '-f', wav,
    '-l', language,
    '-ot', String(Math.max(0, Math.round(startMs))),
    '-d', String(Math.max(1000, Math.round(durationMs))),
    '-oj', '-of', outBase,
    // ★ `-sp`（按句末标点切行）必须加：不加时引擎会把一整片 5 分钟吐成**一条**
    //   cue（实测 30 秒也是「30.0 → 59.99 一段」），时间轴只剩一头一尾，
    //   高亮与点句跳转都失效。加了之后同一段音频切成 10 条带时间的分句。
    '-sp',
    '-np',
  ];
  if (prompt !== '') args.push('--prompt', prompt);
  if (Number.isFinite(threads) && threads > 0) args.push('-t', String(Math.round(threads)));
  await runCapture(bin, args, { signal });
  const raw = await readText(`${outBase}.json`);
  await unlink(`${outBase}.json`).catch(() => undefined);
  return cleanCues(parseRecognizerJson(raw));
}

async function readText(path) {
  return await readFile(path, 'utf8');
}

/** 供测试与临时文件用：把一段文本写成 wav 头 + 静音（不依赖 ffmpeg）。 */
export async function writeSilentWav(path, seconds = 1, rate = 16000) {
  const samples = Math.max(1, Math.round(seconds * rate));
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.concat([header, data]));
  return path;
}
