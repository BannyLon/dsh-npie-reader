/**
 * 书架索引：把**若干份**书单读进来，合并成书架内容的那个集合。
 *
 * ===========================================================================
 * 为什么从「一份」变成「若干份」
 * ===========================================================================
 *
 * 0.7.x 只有一份书单：所有书源合并成一个 `books.json`。问题是**合并那一刻丢掉了
 * 「这本书来自哪个源」** —— 条目里只有一个 `top_dir`（相对该源的第一层子目录），
 * 而那不是源本身。于是用户配了「本地电子书」和「网盘电子书」两个目录，想只看网盘
 * 那份时界面给不出任何入口。
 *
 * 0.8.0 改成**一条书源 = 一份书单**（见 `book-lists.js`），这里负责把它们合起来。
 *
 * ===========================================================================
 * 四条边界，改之前先读
 * ===========================================================================
 *
 *   1. 生成书单**只写插件数据目录**（`store.js` 的 `bookListsDir()`），
 *      **绝不写用户 `libraryPath` 指向的文件** —— 那可能是他整理了很久的书单，
 *      覆盖掉不可逆。
 *   2. 外部那份索引文件（比如 ebook-sorter 的 `data/books.json`）本插件**只读**，
 *      绝不写它（用户级记忆里的红线：仓库外写操作先问再做）。
 *   3. 外部那份阅读进度（同目录的 `reading.json`）也只读，且只用来**补齐本插件还没有的
 *      条目** —— 见 `mergeImportedStates`。
 *   4. 索引解析失败时**不许**静默返回空书架：那会让「文件写坏了」看起来像「书全没了」。
 *      一份坏掉时它自己的 `error` 要带出去，全部坏掉时顶层的 `error` 也要带出去。
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LIBRARY_PATH_DEFAULT, isBookId, normalizeBook } from '../library.js';
import { mergeSources } from './book-source.js';

/** 设置留空时的落点。空串 = **不用外部书单**（不是「用插件数据目录里的某一份」）。 */
export const DEFAULT_LIBRARY_PATH = LIBRARY_PATH_DEFAULT;

/** 索引最大允许多大。47 GB 的书单本身只有 1.8 MB，20 MB 是留足余量的硬上限。 */
const MAX_INDEX_BYTES = 20 * 1024 * 1024;

/** 索引里最多接受多少条（防一个畸形文件把内存撑爆）。 */
const MAX_BOOKS = 20_000;

/** 外部书单在 `sources[]` 里的固定 id。它不来自 `bookSources`，所以不能撞上真实 id。 */
export const EXTERNAL_LIST_ID = 'external';

function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 设置项里的**外部书单**路径 → 绝对路径。
 *
 * ★ 空串解析成**空串**（= 不用外部书单），不再回落到插件数据目录里的 `books.json`。
 *   回落是有害的：用户把外部书单清空之后，界面会突然变成「在读插件自己那份」，
 *   而他刚刚才说过「不要用外部书单」—— 语义被悄悄改了，还看不出来是谁改的。
 *   「插件自己生成的」那条路由 `libraryListIds` 显式表达，两条路各说各的。
 */
export function resolveLibraryPath(configured) {
  const text = typeof configured === 'string' ? configured.trim() : '';
  if (text === '') return '';
  return resolve(expandHome(text));
}

/** 外部阅读进度文件：与索引**同目录**的 `reading.json`。 */
export function externalStatesPath(indexPath) {
  return join(dirname(indexPath), 'reading.json');
}

/**
 * 读**一份**书单文件并规范化。
 *
 * @param indexPath - 绝对路径。
 * @returns `{ path, books, skipped, missing, error, bytes }`。
 *   - `missing` 为 true 表示文件不存在（配置问题，不是数据坏了）；
 *   - `error` 非空表示文件存在但读不了/解析不了/结构不对（**数据问题**）。
 *     两种情形在界面上给的话完全不同，所以不能合并成一个「空书架」。
 */
export async function readLibraryIndex(indexPath) {
  const empty = { path: indexPath, books: [], skipped: 0, missing: false, error: '', bytes: 0 };

  let info;
  try {
    info = await stat(indexPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...empty, missing: true };
    return { ...empty, error: `无法访问书单文件：${error.message}` };
  }
  if (!info.isFile()) return { ...empty, error: '书单路径不是一个文件' };
  if (info.size > MAX_INDEX_BYTES) {
    return { ...empty, error: `书单文件 ${(info.size / 1048576).toFixed(1)} MB，超过 ${MAX_INDEX_BYTES / 1048576} MB 上限` };
  }

  let raw;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch (error) {
    return { ...empty, error: `读取书单失败：${error.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ...empty, error: `书单不是合法 JSON：${error.message}` };
  }

  // 用户那份书单是**顶层数组**；这里同时接受 `{ books: [...] }`，因为以后换成
  // 带元信息的包装形态时不该再改一次协议（`lists/<id>.json` 就是后者）。
  const rows = Array.isArray(parsed) ? parsed : parsed?.books;
  if (!Array.isArray(rows)) {
    return { ...empty, error: '书单结构不对：既不是数组，也没有 books 数组' };
  }
  if (rows.length > MAX_BOOKS) {
    return { ...empty, error: `书单有 ${rows.length} 条，超过 ${MAX_BOOKS} 条上限` };
  }

  const books = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows) {
    const book = normalizeBook(row);
    // 重复 id 只留第一条：id 是取字节的键，两条同 id 会让「点哪一本」变得不确定。
    if (book === undefined || seen.has(book.id)) { skipped += 1; continue; }
    seen.add(book.id);
    books.push(book);
  }

  return { path: indexPath, books, skipped, missing: false, error: '', bytes: info.size };
}

/**
 * 读外部阅读进度（只读，用于补齐本插件还没有的条目）。
 * 任何问题都返回空对象：这份进度是**锦上添花**，读不到不该拦住整个书架。
 */
export async function readExternalStates(indexPath) {
  try {
    const raw = await readFile(externalStatesPath(indexPath), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const states = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (isBookId(id)) states[id] = value;
    }
    return states;
  } catch {
    return {};
  }
}

/**
 * 合并若干份已经读好的书单。
 *
 * 去重与排序**复用 `book-source.js` 的 `mergeSources`**：那是一份已经带了回归用例的
 * 实现（含「空分类因 ICU 忽略 `\u0000` 而不排最前」那条实测出来的非直觉行为）。
 * 这里再写一遍等于把那条知识复制成两份 —— 复制出来的那份迟早只剩一份是对的。
 *
 * 去重按 **id**：同一个文件出现在两条书源下（用户把子目录也加了一份）会扫出同一个
 * 本地绝对路径 ⇒ 同一个 id ⇒ 只留一条。这是刻意的，不是附带的：重复条目会让
 * 「书架显示 3000 本、实际 2634 本」，而用户会以为有两批书。
 */
export function mergeLibraries(sources) {
  const groups = (sources ?? []).map((entry) => entry?.books ?? []);
  const books = mergeSources(...groups);
  let skipped = 0;
  for (const entry of sources ?? []) skipped += entry?.skipped ?? 0;
  return { books, skipped };
}

/**
 * 给一份书单里的每本书盖上「它来自哪份书单」的戳。
 *
 * ★ 为什么这件事必须在这里做（而不是让界面去猜）：0.8.0 把书单拆成「一条源一份」之后，
 *   合并（`mergeSources`）只按 id 去重，**来源这一维在合并那一刻就丢了** ——
 *   剩下的 `book.source` 只能答「网盘还是本地」，答不了「本地那三个目录里的哪一个」。
 *   于是「书架里 2634 本，哪几本是 E书拾取、哪几本是 NPIE_Book」在界面上无从回答
 *   （用户 2026-10-23 报的正是这个）。
 *
 * ★ 戳只在**合并前**打：`mergeSources` 按 id 去重、保留先出现的那一份，所以同一本书
 *   被两条源同时收录时，戳跟着**第一条源**走 —— 与「这本书算在谁名下」的既有语义一致
 *   （去重规则本来也是先到先得）。反过来先合并再打戳，就只能拿到一份「源列表」，
 *   对不上具体是哪本。
 *
 * ★ 只加不删：`listId` / `listName` / `listKind` 是**附加字段**，`normalizeBook` 不认它们、
 *   也不该认 —— 那不是书本身的属性，是「它在哪份书单里」。取字节、进度、排序都不看它们。
 */
export function tagBookSource(books, list) {
  const id = String(list?.id ?? '');
  if (id === '') return books ?? [];
  const name = String(list?.name ?? '').trim() || id;
  const kind = String(list?.kind ?? '').trim();
  return (books ?? []).map((book) => ({ ...book, listId: id, listName: name, listKind: kind }));
}

/** 一份书单的状态戳：路径 + mtime + size。任何一个变了都要重读。 */
async function stampOf(path) {
  try {
    const info = await stat(path);
    return `${path}:${info.mtimeMs}:${info.size}`;
  } catch {
    return `${path}:-`;
  }
}

/**
 * 带缓存的书库。**任何一份**书单文件或设置变了才重新读 —— 用户在自己的工具里
 * 整理完书单、或者在设置里勾掉一份之后，这边不用重启就能看到。
 *
 * @param options.log - 记一行日志。
 */
export function createLibrary(options = {}) {
  const log = options.log ?? (() => {});
  let cache = null;

  return {
    /**
     * @param options.externalPath - **已解析**的外部书单绝对路径；`''` = 不用外部书单。
     * @param options.lists - `[{ id, name, kind, root, path }]`，`path` 是那份书单文件的绝对路径。
     * @returns 见下方 `result` 的构造处。
     */
    async load({ externalPath = '', lists = [] } = {}) {
      const wanted = (lists ?? []).filter((entry) => entry && typeof entry.path === 'string' && entry.path !== '');
      const planned = [...wanted.map((entry) => entry.path)];
      if (externalPath !== '') planned.push(externalPath);

      const stamp = (await Promise.all(planned.map(stampOf))).join('|');
      if (cache !== null && cache.stamp === stamp) return { ...cache.result, reloaded: false };

      const sources = [];
      for (const entry of wanted) {
        const read = await readLibraryIndex(entry.path);
        if (read.error !== '') log(`[书架] 书单「${entry.name}」读取失败：${read.error}`);
        sources.push({
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          root: entry.root ?? '',
          path: entry.path,
          external: false,
          // 盖上「这本书来自这份书单」的戳（见 `tagBookSource`）。合并前打，合并只去重不丢戳。
          books: tagBookSource(read.books, entry),
          count: read.books.length,
          skipped: read.skipped,
          missing: read.missing,
          error: read.error,
          bytes: read.bytes,
        });
      }

      let external = null;
      if (externalPath !== '') {
        const read = await readLibraryIndex(externalPath);
        if (read.error !== '') log(`[书架] 外部书单读取失败：${read.error}`);
        external = {
          id: EXTERNAL_LIST_ID,
          name: '外部书单',
          kind: 'external',
          root: '',
          path: externalPath,
          external: true,
          books: tagBookSource(read.books, { id: EXTERNAL_LIST_ID, name: '外部书单', kind: 'external' }),
          count: read.books.length,
          skipped: read.skipped,
          missing: read.missing,
          error: read.error,
          bytes: read.bytes,
        };
        sources.push(external);
      }

      const merged = mergeLibraries(sources);
      const failed = sources.filter((entry) => entry.error !== '');

      /**
       * 顶层 `error` 只在**一份都读不出来**时才有值。
       *
       * 一份坏掉时不该把整个书架判死 —— 用户配了 3 个源、其中 1 个目录被挪走了，
       * 他要的是「另外 2 个还在，第 3 个读不了」；回一个 500 等于把能用的书也拿走。
       * 但**全部**读不出来时必须有话说：那就是 0.7.x 那份「文件写坏了看起来像书全没了」
       * 的场景，只是从一份变成了 N 份。
       */
      const error = sources.length > 0 && merged.books.length === 0 && failed.length === sources.length
        ? failed[0].error
        : '';
      // 没有任何来源配置、或者配置了但一份都还没生成 —— 这是**缺文件**，不是数据坏了。
      const missing = sources.length === 0
        || (merged.books.length === 0 && failed.length === 0 && sources.every((entry) => entry.missing));

      const result = {
        books: merged.books,
        total: merged.books.length,
        skipped: merged.skipped,
        sources,
        externalPath,
        external,
        error,
        missing,
        // 顶层 `path` 保留一个「主书单」的语义给老调用点：优先外部那份（用户手填的那条
        // 更值得显示），否则第一份生成的。
        path: externalPath !== '' ? externalPath : (sources[0]?.path ?? ''),
      };

      const summary = sources.map((entry) => `${entry.name} ${entry.count} 本`).join(' / ');
      log(`[书架] 书单已载入：${result.total} 本（${summary || '没有来源'}）`);
      cache = { stamp, result };
      return { ...result, reloaded: true };
    },
    /** 测试与「重新载入」按钮用。 */
    invalidate() { cache = null; },
  };
}
