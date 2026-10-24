/**
 * 从「书源」生成书单。
 *
 * 这是「别人装了插件怎么拿到书源」的那个答案：配好本地目录 / 网盘目录，点一下生成，
 * 插件自己去扫，产出书单 JSON —— 不再需要先跑另一个项目。
 *
 * ★ 生成出来的书单**故意比用户那份整理过的要薄**：
 *
 *   | 字段 | 扫盘能拿到吗 |
 *   |---|---|
 *   | `filename` / `size` / `ext` / 路径 | ✅ 真实值 |
 *   | `top_dir` | ✅ 真实的目录结构（相对源的第一个目录名） |
 *   | `title` | ⚠️ 文件名清洗版（去掉扩展名与 `_20201020_174427` 时间后缀） |
 *   | `series`（丛书名）/ `year` | ❌ **留空** |
 *
 *   最后一行是**刻意的**：文件名里那个 `[文化生活译丛]` / `(1992)` 看着能猜，但
 *   `变形记[古罗马]奥维德.杨周翰译.人民文学出版社(2008)` 里的 `[古罗马]` 是**国别**
 *   不是丛书 —— 正则猜出来的 `series` 会让「按丛书分组」把书归错类，而用户会把这行
 *   当成事实。宁可空着（界面显示未分组），也不填一个看着像真的的猜测。
 *   所以「已有整理好的书单」那条路一直留着：那份的 `series` / `year` 是真正算出来的。
 *
 * ★ 幂等性：**id 必须跨次扫描稳定**。进度是按 id 记的，若每次重新生成都换一批 id，
 *   用户点一下「生成书单」就等于把所有阅读进度清零 —— 这恰恰是最该保住的东西。
 *   所以优先复用上一份书单里同源同文件的 id（`previousIds`），只有全新的文件才现算。
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { BOOK_EXTENSIONS, bookIdFromPath, normalizeExtension, titleFromFilename } from '../library.js';

/** 一次扫描最多产出多少本。挡住「不小心把整个磁盘配成源」。 */
export const MAX_SCAN_BOOKS = 20_000;

/** 本地目录递归深度上限。8 层足够「分类/作者/书」这种结构，还能挡住套娃目录。 */
const MAX_LOCAL_DEPTH = 8;

/** 网盘递归深度上限 —— 与本地同一口径；超过 8 层的目录树在网盘上更可能是套娃误配。 */
const MAX_PAN_DEPTH = 8;

/** 网盘扫描的列目录并发。网盘对同一 token 实测近似串行（4 路并不比 1 路快），
 *  这里留着 4 是给「以后放开限速」留的余地；一棵 216 目录 / 2969 文件的树实测约 75 秒。 */
const PAN_SCAN_CONCURRENCY = 4;

/** 网盘列目录每页条数与最多翻几页（1000 × 30 = 3 万条上限）。 */
const PAN_PAGE_SIZE = 1_000;
const PAN_MAX_PAGES = 30;

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

/** 相对路径的**第一个目录名** = 分类目录。直接放在源根下时返回 `''`。 */
export function topDirOf(relativePath) {
  const parts = String(relativePath ?? '').split(sep).filter((part) => part !== '');
  return parts.length > 1 ? parts[0] : '';
}

/** 网盘路径的规范化：统一成以 `/` 开头、不以 `/` 结尾、无重复分隔符。 */
export function normalizePanPath(path) {
  const text = String(path ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (text === '') return '';
  const withLead = text.startsWith('/') ? text : `/${text}`;
  return withLead.length > 1 ? withLead.replace(/\/+$/, '') : withLead;
}

/**
 * 一份书单里每本书的「来源键」，用来跨次扫描认领同一个文件。
 *
 * 网盘用 `fs_id`（文件在网盘上的唯一 id，改名/移动都不变），本地用**绝对路径**
 * （这里没有别的稳定标识；文件改名会被当成新书，这是可接受的代价）。
 */
export function sourceKeyOf(book) {
  if (!book || typeof book !== 'object') return '';
  if (Number(book.fsId) > 0) return `pan:${book.fsId}`;
  const local = String(book.localPath ?? '').trim();
  return local === '' ? '' : `local:${local}`;
}

/** 从上一份书单建「来源键 → id」映射，供重新扫描时认领。 */
export function buildPreviousIds(books) {
  const map = new Map();
  for (const book of books ?? []) {
    const key = sourceKeyOf(book);
    if (key !== '' && !map.has(key)) map.set(key, book.id);
  }
  return map;
}

/**
 * 扫本地目录。
 *
 * @param roots - 目录列表（可为 `~` 开头）。
 * @param options.previousIds - 上一份书单的「来源键 → id」，用于保住进度。
 * @param options.maxBooks - 条数上限。
 * @param options.log - 记一行日志。
 * @returns `{ books, errors, stats }`。**单个目录失败不中断整次扫描** —— 配了 3 个源
 *   坏掉 1 个时，用户应该拿到另外 2 个的结果 + 一句「第 3 个读不了」，而不是什么都没有。
 */
export async function scanLocalRoots(roots, options = {}) {
  const previousIds = options.previousIds ?? new Map();
  const maxBooks = options.maxBooks ?? MAX_SCAN_BOOKS;
  const log = options.log ?? (() => {});
  const books = [];
  const errors = [];
  let skipped = 0;
  let seenFiles = 0;

  for (const rawRoot of Array.isArray(roots) ? roots : []) {
    const root = resolve(expandHome(String(rawRoot)));
    let info;
    try {
      info = await stat(root);
    } catch (error) {
      errors.push({ root, message: error?.code === 'ENOENT' ? '目录不存在' : `读不了：${error.message}` });
      continue;
    }
    if (!info.isDirectory()) {
      errors.push({ root, message: '不是一个目录' });
      continue;
    }

    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && books.length < maxBooks) {
      const { dir, depth } = stack.pop();
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        errors.push({ root, message: `${dir}：${error.message}` });
        continue;
      }
      for (const entry of entries) {
        if (books.length >= maxBooks) break;
        // 隐藏项一律跳过：`.DS_Store`、`.git`、以及 macOS 的 `.Trash`。
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        // ★ 不跟符号链接。跟了会绕圈（软链接指回上层）、也会悄悄越出用户配的根目录 ——
        //   而越界正是 `local-books.js` 花三道闸挡的事，在这里放进来等于白挡。
        if (entry.isSymbolicLink()) { skipped += 1; continue; }
        if (entry.isDirectory()) {
          if (depth + 1 <= MAX_LOCAL_DEPTH) stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        seenFiles += 1;
        const dot = entry.name.lastIndexOf('.');
        const ext = normalizeExtension(dot === -1 ? '' : entry.name.slice(dot + 1));
        if (ext === '' || !BOOK_EXTENSIONS.includes(ext)) { skipped += 1; continue; }
        let fileInfo;
        try {
          fileInfo = await stat(full);
        } catch { skipped += 1; continue; }

        const relpath = relative(root, full);
        const key = `local:${full}`;
        books.push({
          id: previousIds.get(key) ?? bookIdFromPath('l', full),
          filename: entry.name,
          abspath: full,
          relpath,
          ext,
          size: fileInfo.size,
          top_dir: topDirOf(relpath),
          title: titleFromFilename(entry.name),
        });
      }
    }
    if (books.length >= maxBooks) {
      errors.push({ root, message: `已达到 ${maxBooks} 本上限，后面的目录没有扫` });
      break;
    }
    log(`[书架] 本地源 ${root} 扫完，累计 ${books.length} 本`);
  }

  return { books, errors, stats: { local: books.length, seenFiles, skipped } };
}

/**
 * 扫网盘目录。
 *
 * ★ 自己做 BFS 递归：xpan list 的 `recursion=1` 实测不递归（见 `pan.js` `listDir`
 *   的说明），信了它就会产出一份「0 本」的书单 —— 2026-10-09 真机踩过。
 *   逐层列目录（4 路并发）+ 深度上限（与本地同款 8 层）。
 *
 * @param roots - 网盘绝对路径列表（如 `/E书拾取`）。
 * @param options.listDir - `async (dir) => [{ name, path, fsId, size, isDir }]`，
 *   **只要求返回这一层**（递归在这里做）。
 * @param options.previousIds - 上一份书单的「来源键 → id」。
 */
export async function scanPanRoots(roots, options = {}) {
  const listDir = options.listDir;
  if (typeof listDir !== 'function') throw new TypeError('scanPanRoots: 需要 listDir');
  const previousIds = options.previousIds ?? new Map();
  const maxBooks = options.maxBooks ?? MAX_SCAN_BOOKS;
  const log = options.log ?? (() => {});
  const books = [];
  const errors = [];
  let skipped = 0;
  let seenFiles = 0;
  let listedDirs = 0;

  /** BFS 队列。`root` 是这条目录所属的源根（算 `top_dir` 要用）。 */
  const queue = [];
  for (const rawRoot of Array.isArray(roots) ? roots : []) {
    const root = normalizePanPath(rawRoot);
    if (root === '') { errors.push({ root: String(rawRoot), message: '网盘路径是空的' }); continue; }
    queue.push({ root, dir: root, depth: 0 });
  }
  const validRoots = new Set(queue.map((item) => item.root));

  async function listOne({ root, dir }) {
    try {
      const entries = await listDir(dir);
      listedDirs += 1;
      return entries;
    } catch (error) {
      // 单个目录列不出来不中断整次扫描 —— 源根失败要报（界面上给一句为什么是 0 本），
      // 中间某层失败也报，但其余目录的结果照常带回去。
      errors.push({ root, dir, message: error?.message ?? String(error) });
      return [];
    }
  }

  const workers = Array.from({ length: Math.min(PAN_SCAN_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0 && books.length < maxBooks) {
      const job = queue.shift();
      const entries = await listOne(job);
      for (const entry of entries) {
        if (books.length >= maxBooks) break;
        if (entry.isDir) {
          const child = String(entry.path ?? '').trim() !== '' ? String(entry.path) : `${job.dir}/${String(entry.name ?? '')}`;
          if (job.depth + 1 <= MAX_PAN_DEPTH) queue.push({ root: job.root, dir: child, depth: job.depth + 1 });
          continue;
        }
        seenFiles += 1;
        const name = String(entry.name ?? '');
        const dot = name.lastIndexOf('.');
        const ext = normalizeExtension(dot === -1 ? '' : name.slice(dot + 1));
        if (ext === '' || !BOOK_EXTENSIONS.includes(ext)) { skipped += 1; continue; }
        const fsId = Number(entry.fsId);
        if (!Number.isInteger(fsId) || fsId <= 0) { skipped += 1; continue; }
        const path = String(entry.path ?? '');
        const key = `pan:${fsId}`;
        books.push({
          id: previousIds.get(key) ?? bookIdFromPath('p', String(fsId)),
          filename: name,
          pan_path: path,
          fs_id: fsId,
          ext,
          size: Number(entry.size) || 0,
          top_dir: topDirOf(path.slice(job.root.length).replace(/^\/+/, '')),
          title: titleFromFilename(name),
        });
      }
    }
  });
  await Promise.all(workers);

  if (books.length >= maxBooks) {
    const firstRoot = validRoots.values().next().value ?? '';
    errors.push({ root: firstRoot, message: `已达到 ${maxBooks} 本上限，后面的目录没有扫` });
  }
  log(`[书架] 网盘源 ${[...validRoots].join('、') || '(无)'} 扫完：列了 ${listedDirs} 个目录，累计 ${books.length} 本`);

  return { books, errors, stats: { pan: books.length, seenFiles, skipped, dirs: listedDirs } };
}

/**
 * 合并各源的结果：按 id 去重（重叠的源会产出同一个 id）、按分类 + 书名排序。
 * 排序**在生成时就定下来**，这样直接打开那份 JSON 也是能读的顺序。
 */
export function mergeSources(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const book of group ?? []) {
      if (seen.has(book.id)) continue;
      seen.add(book.id);
      out.push(book);
    }
  }
  return out.sort((a, b) => {
    const left = `${a.top_dir ?? ''}\u0000${a.title ?? ''}`;
    const right = `${b.top_dir ?? ''}\u0000${b.title ?? ''}`;
    return left.localeCompare(right, 'zh-Hans-CN');
  });
}

export { MAX_LOCAL_DEPTH, PAN_PAGE_SIZE, PAN_MAX_PAGES, coded as sourceError };
