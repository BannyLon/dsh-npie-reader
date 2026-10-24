/**
 * 本地电子书取字节 —— 以及这条通道必然带来的那道**安全边界**。
 *
 * 为什么必须单独一个模块：把本地书接进书架，等于开了一条「把本机文件通过 loopback
 * HTTP 发出去」的通道。而宿主派发插件路由**不经过**它自己的鉴权拦截器
 * （先精确路由、再鉴权 —— 见 `library-routes.js` 顶部），所以能拦住
 * 「任何能访问本机端口的进程顺着它读整台机器」的，**只有这个文件里的三道闸**：
 *
 *   1. **必须落在用户配置的根目录之内**。配置为空时**一个本地文件都读不了** ——
 *      不是「读全部」。默认放开等于把整个家目录敞开，而用户根本没意识到自己开了什么。
 *   2. **先 realpath、再比对**。只比字符串前缀的话有两条漏洞：`/books/../.ssh/id_rsa`
 *      这种带 `..` 的写法能通过字面比对；在根目录里放一个指向别处的**符号链接**也能通过。
 *      realpath 把两者都解析成真实路径之后再比，两条路一起堵掉。
 *      （根目录本身也要 realpath：`/tmp` 在 macOS 上实际是 `/private/tmp`，只解析一边
 *        会让一个完全合法的路径被判成越界。）
 *   3. **比对时补上分隔符**。`/books` 不能匹配 `/books-secret/x.pdf` —— 少了这个
 *      `+ sep`，前缀比对会把同级的相似目录（`/books2`、`/books-old`）一起放进来。
 *
 * ★ 未做的取舍：这里**不挡硬链接**（`ln /etc/passwd /books/x.pdf` 仍然读得到）。
 *   挡它要按 inode 反查全盘，代价远超收益；而能建硬链接的进程本来就能直接读那个文件。
 */

import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** 一次本地读取最多多少字节。上层（Range 路由）已经封过顶，这是第二道。 */
const MAX_LOCAL_READ_BYTES = 64 * 1024 * 1024;

/** 与 `store.js` / `host/library.js` 同形（三处各一份，都是为了不互相 import）。 */
function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * `file` 在不在 `root` 之内。
 *
 * ★ `file === root` 也要算「在之内」：用户完全可能把一个文件本身配成源（虽然界面上
 *   引导他填目录），这时它不该被自己拒掉。导出是为了让守卫能直接测这条判据。
 */
export function withinRoot(file, root) {
  if (file === root) return true;
  const base = root.endsWith(sep) ? root : root + sep;
  return file.startsWith(base);
}

/** realpath 一个根目录；不存在 / 不可解析时返回 null（这个根就作废，而不是报错）。 */
async function realRoot(root, realpathImpl) {
  try {
    const absolute = await realpathImpl(resolve(expandHome(String(root ?? ''))));
    const info = await stat(absolute);
    return info.isDirectory() ? absolute : null;
  } catch {
    return null;
  }
}

/**
 * 把书条目上的本地路径解析成**可以安全读取**的绝对路径。
 *
 * @param localPath - 书条目上的 `localPath`（绝对路径，或外部书单里的相对路径）。
 * @param roots - 用户配置的本地根目录列表（可为 `~` 开头）。
 * @param options.realpathImpl - 注入用（测试里喂假实现，不碰真磁盘）。
 * @returns 解析后的真实绝对路径。
 * @throws 带 `code` 的错误：`NO_LOCAL_PATH` / `NO_LOCAL_ROOT` / `LOCAL_OUTSIDE_ROOT` /
 *   `LOCAL_MISSING` / `LOCAL_NOT_FILE`。每个 code 对应界面上**一句不同的话** ——
 *   「没配目录」「文件没了」「越界了」是三件完全不同的事，合并成一句用户没法自救。
 */
export async function resolveLocalFile(localPath, roots, options = {}) {
  const raw = String(localPath ?? '').trim();
  if (raw === '') throw coded('NO_LOCAL_PATH', '这本书的书单记录里没有本地路径');

  const list = Array.isArray(roots) ? roots.filter((root) => String(root ?? '').trim() !== '') : [];
  if (list.length === 0) {
    throw coded('NO_LOCAL_ROOT', '还没有在设置里配本地电子书目录，所以本地书读不了');
  }
  const realpathImpl = options.realpathImpl ?? realpath;
  const statImpl = options.statImpl ?? stat;

  // 根目录先各自解析一次真实路径，避免在「多候选 × 多根」的循环里重复 realpath。
  const realRoots = [];
  for (const root of list) {
    const resolved = await realRoot(root, realpathImpl);
    if (resolved !== null) realRoots.push(resolved);
  }

  // 绝对路径直接用；相对路径（外部书单里的 `relpath`）按每个根目录各试一次。
  const candidates = isAbsolute(raw)
    ? [resolve(raw)]
    : list.map((root) => join(resolve(expandHome(String(root))), raw));

  let escaped = false;
  for (const candidate of candidates) {
    let fileReal;
    try {
      fileReal = await realpathImpl(candidate);
    } catch {
      continue; // 这个候选不存在 —— 试下一个根目录
    }
    for (const root of realRoots) {
      if (!withinRoot(fileReal, root)) continue;
      const info = await statImpl(fileReal);
      if (!info.isFile()) throw coded('LOCAL_NOT_FILE', `这不是一个文件（可能是目录）：${raw}`);
      return fileReal;
    }
    // 路径**确实存在**、但没有任何一个根目录容得下它 —— 这是越界，不是「找不到」。
    // 两者必须分开：说成「找不到」会让用户去翻目录，而真相是他配错了根。
    escaped = true;
  }

  if (escaped) throw coded('LOCAL_OUTSIDE_ROOT', `这本书不在已配置的本地目录里，已拒绝读取：${raw}`);
  throw coded('LOCAL_MISSING', `本地文件不存在：${raw}`);
}

/** 读本地文件的闭区间 `[start, end]` 字节。 */
export async function readLocalRange(absolute, start, end, options = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw coded('BAD_RANGE', `无效的字节区间 ${start}-${end}`);
  }
  const length = end - start + 1;
  if (length > MAX_LOCAL_READ_BYTES) {
    throw coded('RANGE_TOO_LARGE', `一次要读 ${(length / 1048576).toFixed(1)} MB，超过单次上限`);
  }
  const openImpl = options.openImpl ?? open;
  let handle;
  try {
    handle = await openImpl(absolute, 'r');
  } catch (error) {
    throw coded('LOCAL_OPEN_FAILED', `打开本地文件失败：${error.message}`);
  }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    // 末段可能短于请求长度（文件比书单里记的短）—— 按实际读到的返回，
    // 上层按 `content-range` 报的是**书单里的**大小，差一个尾巴也不会崩。
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 造一个本地读取器。
 *
 * `rootsOf` 是个**函数**而不是数组：书源配置存在设置里、随时会变，而读取器是在
 * 插件启动时造一次、挂进路由的。传数组的话用户改完设置得重启插件才生效。
 *
 * @param options.rootsOf - `() => string[]`，每次调用取当前配置。
 * @param options.log - 记一行日志。
 */
export function createLocalReader(options = {}) {
  const rootsOf = options.rootsOf ?? (() => []);
  const log = options.log ?? (() => {});

  const resolveBook = async (localPath) => await resolveLocalFile(localPath, rootsOf());

  return {
    roots: () => rootsOf(),
    resolve: resolveBook,
    /** 读闭区间字节。越界/不存在都会抛带 code 的错误。 */
    async read(localPath, start, end) {
      const absolute = await resolveBook(localPath);
      const buffer = await readLocalRange(absolute, start, end);
      log(`[书架] 本地取 ${start}-${end} → ${buffer.length} 字节（${absolute}）`);
      return buffer;
    },
  };
}

export { MAX_LOCAL_READ_BYTES };
