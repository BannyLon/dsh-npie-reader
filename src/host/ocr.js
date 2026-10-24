/**
 * 本地 OCR 的执行器：把一张图交给 macOS 的 Vision，拿回文字。
 *
 * ★ 为什么 OCR 放在**宿主**而不是渲染进程：渲染进程是浏览器沙箱，起不了子进程；
 *   而 `osascript` 是系统自带的，不需要编译、不需要 Xcode、不需要联网。
 *   （详见 `ocr-vision.js` 顶部那三条理由。）
 *
 * ★ 输入**只有图片字节**，没有路径参数 —— 这是刻意的：
 *   路由一旦接受「路径」，就等于把「宿主进程能读的任意文件」开放给一个 HTTP 端点。
 *   现在它只能识别调用方自己编码进来的位图，穿越面为零。
 *
 * ★ 超时给 60 秒而不是 10 秒：Vision 在**这台机器第一次**被调用时要加载识别模型，
 *   实测冷启动 26–29 秒（之后每页 0.5–0.8 秒）。给 10 秒会让「第一次点识别」永远失败，
 *   而第二次却好了 —— 那种「偶发失败」最难被当成环境问题。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 单张图的字节上限。200 DPI 的 A5 扫描页 JPEG 大约 300–900 KB，4 MB 足够。 */
export const OCR_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 冷启动要 30 秒上下，见文件头。 */
export const OCR_TIMEOUT_MS = 60_000;

/** `osascript` 的 stdout 上限：一本书一页的识别结果最多几十 KB，给 4 MB 是浪费但安全。 */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/**
 * 认图片类型（只看 magic，不信扩展名也不信 MIME）。
 *
 * ★ 只放行 PNG / JPEG：Vision 还能读 HEIC / TIFF，但客户端只会发这两种，
 *   多放行一种就多一条没被测过的路径。
 * @returns {'png'|'jpeg'|undefined}
 */
export function sniffImageExt(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return undefined;
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  return undefined;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 把客户端发来的图解码成 Buffer。
 *
 * 接受两种形态：`data:image/png;base64,…` 与裸 base64。
 *
 * ★ **必须自己校验 base64 字符集**：`Buffer.from(str, 'base64')` 遇到非法字符是
 *   **静默跳过**的，于是 `"@@@@"` 会解码成空 Buffer，然后被当成「一张 0 字节的图」
 *   往下走 —— 错误会出现在 OCR 那一侧，报「图片损坏」，与真正的原因（请求体写错了）
 *   隔着两层。宁可在这里当场抛。
 */
export function decodeImagePayload(raw) {
  if (typeof raw !== 'string' || raw === '') throw new Error('缺少图片数据');
  let base64 = raw;
  const comma = raw.indexOf(',');
  if (raw.startsWith('data:')) {
    if (comma < 0) throw new Error('图片 data URL 不完整');
    const header = raw.slice(5, comma);
    if (!header.startsWith('image/')) throw new Error('只接受图片 data URL');
    if (!header.endsWith(';base64')) throw new Error('图片 data URL 必须是 base64');
    base64 = raw.slice(comma + 1);
  }
  if (base64.length === 0) throw new Error('缺少图片数据');
  if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
    throw new Error('图片不是合法的 base64');
  }
  return Buffer.from(base64, 'base64');
}

/**
 * 造一个 OCR 执行器。
 *
 * @param {object} options
 * @param {string} options.scriptPath - `ocr-vision.js` 的绝对路径（由宿主按插件根算）。
 * @param {string} [options.platform] - 默认 `process.platform`；测试里改它来模拟非 macOS。
 * @param {Function} [options.exec] - `(file, args, opts) => Promise<{stdout}>`，测试注入。
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.log]
 */
export function createOcrRunner({
  scriptPath,
  platform = process.platform,
  exec,
  timeoutMs = OCR_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const run = typeof exec === 'function'
    ? exec
    : (file, args, options) => new Promise((resolve, reject) => {
      execFile(file, args, options, (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  const isMac = platform === 'darwin';
  const hasScript = typeof scriptPath === 'string' && scriptPath !== '';
  const supported = isMac && hasScript;
  /**
   * ★ 两种「不支持」必须说成两句话。都写成「这台机器不是 macOS」的话，
   *   一个**安装不完整**（脚本没打进去）的 mac 用户会看到一句与事实相反的话，
   *   于是永远查不到真正的原因。
   */
  const unavailableReason = isMac
    ? '本机 OCR 组件缺失（插件安装不完整，重装一次插件即可）'
    : '这台机器不是 macOS，本地 OCR 用不了';

  return {
    supported,
    /** 给路由层做闸门用的一句话说明。 */
    unavailableReason: supported ? '' : unavailableReason,

    /**
     * 识别一张图。
     *
     * @param {Buffer} buffer - PNG / JPEG 字节。
     * @returns {Promise<{text: string, lines: number, ms: number}>}
     */
    async recognize(buffer) {
      if (!supported) throw new Error(unavailableReason);
      const ext = sniffImageExt(buffer);
      if (ext === undefined) throw new Error('只支持 PNG / JPEG 图片');
      if (buffer.length > OCR_MAX_IMAGE_BYTES) {
        throw new Error(`图片太大（${Math.round(buffer.length / 1024)} KB，上限 ${OCR_MAX_IMAGE_BYTES / 1024} KB）`);
      }

      const dir = await mkdtemp(join(tmpdir(), 'npr-ocr-'));
      const file = join(dir, `page.${ext}`);
      try {
        await writeFile(file, buffer);
        let stdout = '';
        try {
          const result = await run('osascript', ['-l', 'JavaScript', scriptPath, file], {
            timeout: timeoutMs,
            maxBuffer: MAX_STDOUT_BYTES,
          });
          stdout = String(result?.stdout ?? '');
        } catch (error) {
          /**
           * ★ 超时要与「识别失败」分开说：前者是环境（冷启动没跑完 / 机器太忙），
           *   后者是这张图真的读不出字。混成一句话的话，用户会以为是书坏了。
           */
          if (error?.killed === true || error?.signal === 'SIGTERM') {
            throw new Error(`本地 OCR 超时（${Math.round(timeoutMs / 1000)} 秒）`);
          }
          const detail = String(error?.stderr ?? '').trim();
          /**
           * ★ 脚本文件在探测之后消失了（升级到一半、被清理工具删了）：这**不是**
           *   用户的错，也不该让他在界面上读一段 `osascript: /Users/…/ocr-vision.js:
           *   No such file or directory` —— 那句话既看不懂也照不了做。
           *   实测就是这么暴露的：候选路径算错了一级，界面上直接糊了一整屏路径。
           */
          if (/No such file or directory/i.test(detail) && /ocr-vision\.js/i.test(detail)) {
            throw new Error('本机 OCR 组件缺失（插件安装不完整，重装一次插件即可）');
          }
          throw new Error(`本地 OCR 没跑起来${detail === '' ? '' : `：${detail.slice(0, 200)}`}`);
        }

        const parsed = parseOutput(stdout);
        if (parsed.ok !== true) throw new Error(`本地 OCR 失败：${parsed.error ?? '未知原因'}`);
        const lines = Array.isArray(parsed.text) ? parsed.text : [];
        log(`ocr: ${lines.length} 行 / ${parsed.ms} ms`);
        return { text: lines.join('\n'), lines: lines.length, ms: Number(parsed.ms) || 0 };
      } finally {
        // 临时文件必须走：一张 200 DPI 的页面几百 KB，攒几十张就是几十 MB。
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

/**
 * 从 `osascript` 的 stdout 里取出那一行 JSON。
 *
 * ★ 不能直接 `JSON.parse(stdout)`：JXA 里任何一句 `console.log` 都会混进来，
 *   而 `osascript` 还可能在前面打警告。**倒着找第一个能解析成对象的行** ——
 *   我们的结果永远是最后一行。
 */
function parseOutput(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      // 继续往前找。
    }
  }
  throw new Error('本地 OCR 没有返回可解析的结果');
}
