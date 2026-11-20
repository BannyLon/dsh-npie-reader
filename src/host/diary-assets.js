/**
 * 灵感里贴的图（0.73.0）。
 *
 *     <DSH_HOME>/storages/dsh-npie-reader/diary/assets/<sha256 前 16 位>.<ext>
 *
 * ★ 为什么图片不塞进 `.md` 旁边而是单独一个目录：正文是纯文本，日记文件要能
 *   被导出、被 diff、被别的编辑器打开。把 base64 塞进 markdown 会让一条 200 字的
 *   灵感变成 3 MB，`readDay()` 每次翻页都读它 —— 而用户要看的只是那 200 字。
 *
 * ★ 为什么用**内容哈希**当文件名，而不是时间戳 / 随机串：
 *   ① 同一张图反复粘贴只占一份（复制粘贴同一个截图很常见）；
 *   ② 名字由内容决定 ⇒ 天然没有「两个窗口同时写同一张图」的冲突；
 *   ③ 名字里没有用户输入 ⇒ 路径穿越（`../../x`）在**入口处**就被正则挡住，
 *      不需要靠 `join` + `relative` 事后校验。
 *   代价是名字不可读（16 个十六进制数）。但它在 markdown 里只是一个 src，
 *   人本来也不看它；要看的话，`alt` 与上下文的文字才是线索。
 *
 * ★ 为什么按 magic bytes 判类型，不信 `content-type`：请求头是**客户端说的**，
 *   而扩展名会跟着它一起写进文件名 —— 声明 `image/png` 却塞一堆 HTML 进去，
 *   宿主就会用一个 `.png` 的名字把它端回浏览器。类型必须由文件自己回答。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 单张图的上限。
 *
 * 8 MB 是按「一张 4K 截图」定的（Retina 全屏 PNG 大约 3–6 MB）。再大基本是
 * 直接把相机原图拖进来，那属于「附件」而不是「速记里的一个标注」——
 * 拒绝时给的是人话，让用户自己去缩一下，而不是静默存一个 30 MB 的文件。
 */
export const ASSET_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 清理时的「新生保护期」：落盘不足 7 天的图**一律不删**（0.73.1）。
 *
 * ★ 这不是保守，是唯一安全的下限。草稿存在浏览器 `localStorage` 里，宿主**看不见**
 *   它引用了哪张图 —— 用户在草稿里贴了一张图、还没保存就关掉浮层，那张图此刻
 *   没有任何日记正文提到它。一个「删所有没被引用的图」的清理会把它删掉，而
 *   24 小时后用户恢复草稿时，图的位置是一张碎图。
 * ★ 草稿 TTL 是 24 小时，7 天把它完整覆盖，还留了 6 天余量给「周末没打开」。
 *   代价是孤儿图最多多躺一周 —— 磁盘上几十 KB 的事，换「绝不误删」是划算的。
 */
export const ASSET_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** 认识的类型 → 扩展名。**只有位图**：SVG 是 XML，能带脚本，不在速记里放行。 */
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * 合法的资产名。
 *
 * ★ 这条正则是**安全边界**，不只是格式校验：路由直接拿它当文件名拼路径，
 *   一旦允许 `/`、`..`、`%2e` 之类进来，读接口就变成了「读磁盘任意文件」。
 *   所以它是白名单（只许小写十六进制 + 点 + 认识的扩展名），而不是
 *   「过滤掉危险字符」的黑名单 —— 黑名单总有没想到的写法。
 */
export const ASSET_NAME_PATTERN = /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 由**文件自己**判断类型。不认识就返回空串。
 *
 * 只认四种位图的开头几个字节，不解析图像内容 —— 这里要回答的是「能不能安全地
 * 当图片端回浏览器」，而不是「这张图能不能解码」。
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  const head = buffer.subarray(0, 12);
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'image/png';
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  // GIF: 'GIF87a' / 'GIF89a'
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a'
    || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  // WEBP: 'RIFF' + 4 字节长度 + 'WEBP'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}

/** 内容哈希 → 文件名。同一份字节永远得到同一个名字。 */
export function assetNameFor(buffer, mime) {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw coded('BAD_IMAGE', `不支持的图片类型：${mime || '(未知)'}`);
  return `${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}.${ext}`;
}

/** 扩展名 → 回给浏览器的 content-type。名字已经过白名单，这里只做映射。 */
export function assetMimeOf(name) {
  return MIME_BY_EXT[name.slice(name.lastIndexOf('.') + 1)] ?? '';
}

/**
 * @param {{ dir: string, log?: (message: string) => void }} options
 */
export function createDiaryAssets({ dir, log = () => {} } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('createDiaryAssets 需要 dir');

  async function ensureDir() {
    await mkdir(dir, { recursive: true });
  }

  return {
    dir,

    /**
     * 存一张图。
     *
     * @param {{ buffer: Buffer|Uint8Array, mime?: string }} input `mime` 只是**提示**，
     *   真正决定扩展名的是文件自己的 magic bytes。
     * @returns `{ name, mime, bytes }`
     */
    async save({ buffer, mime = '' } = {}) {
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
      if (bytes.length === 0) throw coded('BAD_IMAGE', '这张图是空的');
      if (bytes.length > ASSET_MAX_BYTES) {
        throw coded('IMAGE_TOO_LARGE', `这张图有 ${(bytes.length / 1024 / 1024).toFixed(1)} MB，超过 8 MB —— 先缩一下再贴`);
      }
      const actual = sniffImage(bytes);
      if (actual === '') {
        // ★ 这句要说清「是格式不认识」，而不是「失败了」：用户可能贴的是 PDF 截图、
        //   或者是网页里复制出来的 SVG。前者该重新截图，后者本来就存不了。
        throw coded('BAD_IMAGE', `不认识这种图（声明的是 ${mime || '无'}）—— 速记只存 PNG / JPEG / GIF / WebP`);
      }
      const name = assetNameFor(bytes, actual);
      const target = join(dir, name);
      await ensureDir();
      // 已经有了就不重写：名字是内容哈希，同内容必然同字节。
      const exists = await stat(target).then(() => true, () => false);
      if (exists) return { name, mime: actual, bytes: bytes.length };
      // 先写临时文件再 rename：中途被打断不会留下一个「名字对、内容半截」的图，
      // 而那种图会被 `exists` 判为已存在，从此永远不会被修正。
      const temp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
      try {
        await writeFile(temp, bytes);
        await rename(temp, target);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
      log(`[日记] 存图 ${name}（${(bytes.length / 1024).toFixed(0)} KB）`);
      return { name, mime: actual, bytes: bytes.length };
    },

    /**
     * 读一张图。
     *
     * @param {string} name 必须过 `ASSET_NAME_PATTERN`。
     * @returns `{ buffer, mime }`；不存在时抛 `ENOENT`（路由层映射成 404）。
     */
    async read(name) {
      if (typeof name !== 'string' || !ASSET_NAME_PATTERN.test(name)) {
        throw coded('BAD_ASSET_NAME', '图片名不合法');
      }
      const buffer = await readFile(join(dir, name));
      return { buffer, mime: assetMimeOf(name) };
    },

    /**
     * 清掉**没有任何条目引用**的图（0.73.1）。
     *
     * ★ `keep` 必须由调用方从**全部日记正文**里扫出来（见 `store.referencedAssets()`），
     *   这里不做扫描：这个模块只管文件，不管内容。把「谁引用了它」放进文件层，
     *   等于让一个不认识日记格式的模块去解析日记。
     * ★ **不能反过来做**（删条目时顺手删文件）：文件名是内容哈希，同一张图可能被
     *   两条灵感引用（复制同一张截图两次很常见）。按条目删文件，删掉上面那条就
     *   把下面那条的图一起删了 —— 而下面那条还好好地在日记里。
     * ★ `minAgeMs` 见 `ASSET_KEEP_MS` 的注释：新生图一律不动，因为草稿在
     *   `localStorage` 里，宿主看不见它引用了什么。
     * ★ `dryRun` 默认 `false` 但**界面必须先预演一次**（列清楚删几张、共多少 MB）：
     *   删文件这类动作，用户点之前要能看见代价。
     *
     * @param {{ keep?: Iterable<string>, minAgeMs?: number, dryRun?: boolean }} [options]
     * @returns `{ scanned, removed, kept, freed, dryRun }`
     */
    async prune({ keep = [], minAgeMs = ASSET_KEEP_MS, dryRun = false } = {}) {
      const referenced = keep instanceof Set ? keep : new Set(keep ?? []);
      await ensureDir();
      const names = (await readdir(dir)).filter((name) => ASSET_NAME_PATTERN.test(name));
      const now = Date.now();
      const removed = [];
      /**
       * 删不掉的（权限、只读卷、被别的进程占着）。
       *
       * ★ 绝不吞掉：把失败的算进 `removed` 与 `freed`，回执就会说
       *   「清掉 3 张，腾出 1.2 MB」而实际一张都没删 —— 这是「界面说成功了、
       *   其实没成功」，比直接报错坏得多（用户不会再去查第二次）。
       *   所以失败的一律进 `failed`，且**不计入**删除数与释放量。
       */
      const failed = [];
      let freed = 0;
      for (const name of names) {
        // 被引用 ⇒ 留下。这一条不看年龄：正在用的图没有「太新」与「够老」之分。
        if (referenced.has(name)) continue;
        const info = await stat(join(dir, name)).then((value) => value, () => null);
        if (!info) continue;
        // ★ mtime 有小数精度，`Date.now()` 只有整数：刚写完的文件 `mtimeMs` 可能
        //   比 `now` 大半毫秒，算出来是负年龄（实测 -0.72 ms）。若不夹 0，
        //   `minAgeMs: 0`（关掉保护期）时会把负年龄误判成「还在保护期」而跳过 ——
        //   反向对照因此时红时绿。同理，系统时钟回拨 / 从别处拷来的文件带未来
        //   时间戳，也不该被当成「永远年轻」而永不清理。年龄没有负数。
        const ageMs = Math.max(0, now - info.mtimeMs);
        if (ageMs < minAgeMs) continue;
        if (!dryRun) {
          try {
            await unlink(join(dir, name));
          } catch (error) {
            failed.push({ name, code: error?.code ?? '' });
            continue;
          }
        }
        removed.push({ name, bytes: info.size, ageDays: Math.floor(ageMs / 86400000) });
        freed += info.size;
      }
      if (!dryRun && removed.length > 0) {
        log(`[日记] 清理了 ${removed.length} 张没在用的图，释放 ${(freed / 1024).toFixed(0)} KB`
          + (failed.length > 0 ? `（${failed.length} 张删不掉）` : ''));
      }
      return {
        scanned: names.length,
        removed,
        failed,
        kept: names.length - removed.length,
        freed,
        dryRun,
        // 一并回出去，好让界面能把「为什么只删了 0 张」解释清楚（保护期还没过），
        // 而不是让用户以为清理坏了。
        keepDays: Math.round(minAgeMs / 86400000),
      };
    },
  };
}
