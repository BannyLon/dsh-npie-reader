/**
 * PDF **页级译文**的磁盘缓存（0.71.0）。
 *
 * 为什么落盘：D 档的「逐页按需」只把译文留在内存里，翻回读过的页是秒开，但重开
 * 插件就要重新调一次模型；而「整本一次翻完」要跑几十页、花的是真金白银的模型调用，
 * 关掉窗口就丢是不可接受的。两种模式现在**共用这一份缓存**（见客户端
 * `paper-translation.js`），逐页翻过的页整本模式也会跳过。
 *
 * 为什么一页一个文件而不是一本书一个 JSON：
 *   - 整本模式是**一页一页写**的。一本书一个文件就得每翻一页把已经积累的几十页
 *     整个重写一遍（O(n²) 写盘），300 页的书会写出几百 MB；
 *   - 单页文件坏了只丢这一页，不会把整本书的译文一起带崩；
 *   - 每本书的目录名就是 bookId，清缓存时按目录删，不碰用户自己的文件。
 *
 *   page-translations/<bookId>/p<page>.json
 *
 * ★ 只存「原文段落 + 对应译文」，**不存排版 IR**：IR 是本机从 PDF 取字算出来的
 *   （毫秒级，且分段规则还在调），存下来反而会在规则升级后盖错位置。客户端每次
 *   重新取字，用 `paragraphs` 逐条比对源码与 id，对不上就这一页重翻。
 */
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBookId } from '../library.js';
import { guardFs } from './disk-errors.js';

export const PAGE_TRANSLATION_VERSION = 1;
/** 与 `/translate-page` 的入参上限一致：一页最多 40 段。 */
export const MAX_PARAGRAPHS = 40;
/** 单段原文 / 译文的字符上限（模型的分段不会比这更长）。 */
export const MAX_TEXT_CHARS = 2500;
/** 一页文件的页号上限，也是目录扫描时认的最大页。 */
export const MAX_PAGE_NUMBER = 99_999;

const PAGE_FILE_RE = /^p([1-9]\d{0,4})\.json$/;
/** 段落 id 的长度上限（真实 id 形如 `0:text:12`，最长二十来个字符）。 */
const MAX_ID_CHARS = 64;
/** 控制字符会把 JSON 写坏 / 让日志变成乱码，其余一律放行。 */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * 段落 id 是否可落盘。
 *
 * ★ **不能**用「字母数字下划线」那一套校验。论文分段生成的 id 是
 *   `0:text:12`（`<页序号>:<区域类型>:<段序号>`，见 `paper-reflow/region-build.mjs`），
 *   带冒号、带文本标记。0.71.0 用 `/^[A-Za-z0-9_-]{1,64}$/` 校验的后果是：
 *   每一条合法 id 都被当成脏数据滤掉 ⇒ `paragraphs` 变空 ⇒ `putPage` 抛
 *   「这一页没有段落」⇒ 路由回 400 ⇒ 客户端按软失败吞掉。于是
 *   **磁盘上一个文件都没写下来**，用户每次重开插件都得重新翻译一遍
 *   （2026-11-07 真机反馈「为什么每次重新打开都要重新翻译」就是这条）。
 *
 * ★ 只挡两件事：长度失控、控制字符。id 只作为 JSON 里的键和 Map 的键，
 *   **不进文件名、不进 URL**（文件名固定是 `p<page>.json`），所以不需要
 *   更严的字符白名单 —— 收紧一点，用户就再丢一次缓存。
 */
function isParagraphId(value) {
  const id = String(value ?? '');
  return id !== '' && id.length <= MAX_ID_CHARS && !CONTROL_RE.test(id);
}

function fail(message) {
  const error = new Error(message);
  error.code = 'BAD_PAGE_TRANSLATION';
  return error;
}

/** 外部输入一律重新构造，不让客户端多塞的字段变成磁盘上的数据源。 */
function normalizeItems(input, label) {
  if (!Array.isArray(input)) throw fail(`${label} 要是数组`);
  if (input.length > MAX_PARAGRAPHS) throw fail(`${label} 超过 ${MAX_PARAGRAPHS} 条`);
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const id = String(raw?.id ?? '');
    const text = String(raw?.text ?? '');
    if (!isParagraphId(id) || seen.has(id)) continue;
    if (text.length > MAX_TEXT_CHARS) throw fail(`${label} 里有一段超过 ${MAX_TEXT_CHARS} 字`);
    seen.add(id);
    out.push({ id, text });
  }
  return out;
}

/**
 * 校验并归一化一页的缓存记录。
 *
 * ★ 译文只保留 `paragraphs` 里真实存在的 id：模型编造 / 抄错的 id 会让中文盖到
 *   别的段落框上（单页探针踩过这个坑），落盘前就滤掉，重开时也不用再防一次。
 */
export function normalizePageTranslation(input, page = input?.page) {
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_NUMBER) throw fail('页码不合法');
  const paragraphs = normalizeItems(input?.paragraphs, 'paragraphs');
  if (paragraphs.length === 0) throw fail('这一页没有段落');
  const known = new Set(paragraphs.map(item => item.id));
  const translations = normalizeItems(input?.translations, 'translations')
    .filter(item => known.has(item.id));
  if (translations.length === 0) throw fail('这一页没有对得上段落的译文');
  return {
    version: PAGE_TRANSLATION_VERSION,
    page: n,
    paragraphs,
    translations,
    at: Number(input?.at) || Date.now(),
  };
}

/** 原子写：先 tmp 再 rename，崩在中途不会留半个 JSON。 */
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  await guardFs(async () => {
    await writeFile(tmp, JSON.stringify(value), 'utf8');
    await rename(tmp, path);
  }, '这一页的译文');
}

export function createPageTranslationStore({ rootDir, log = () => {} } = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') throw new TypeError('page-translation-store: 需要 rootDir');

  const dir = join(rootDir, 'page-translations');

  function bookDir(bookId) {
    // id 从 HTTP 路径来，直接拼就是路径穿越 —— 与 annotation-store 同一道闸。
    if (!isBookId(bookId)) throw new TypeError(`page-translation-store: 非法 bookId ${String(bookId)}`);
    return join(dir, bookId);
  }

  function fileOf(bookId, page) {
    return join(bookDir(bookId), `p${page}.json`);
  }

  /**
   * 每本书一条写队列：`putPage` 与 `clearBook` 必须串行，否则「刚写完第 12 页」
   * 会被同时进行的「清空」抹掉，或者清空后又冒出一个文件。
   */
  const chains = new Map();
  function serialize(bookId, task) {
    const previous = chains.get(bookId) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(bookId, next.catch(() => {}));
    return next;
  }

  /** 整本缓存：`{ [page]: record }`。目录不存在 ⇒ `{}`，坏文件跳过并记一行日志。 */
  async function list(bookId) {
    const base = bookDir(bookId);
    let names;
    try {
      names = await readdir(base);
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    const pages = {};
    for (const name of names) {
      const match = PAGE_FILE_RE.exec(name);
      if (match === null) continue;
      const page = Number(match[1]);
      try {
        const parsed = JSON.parse(await readFile(join(base, name), 'utf8'));
        pages[String(page)] = normalizePageTranslation(parsed, page);
      } catch {
        // 单个文件坏了只丢这一页：整本书的译文不该被一个坏 JSON 带崩。
        log(`[页译文] ${bookId} 第 ${page} 页缓存坏了，已跳过`);
      }
    }
    return pages;
  }

  async function putPage(bookId, page, input) {
    return await serialize(bookId, async () => {
      const record = normalizePageTranslation({ ...input, page });
      const base = bookDir(bookId);
      await mkdir(base, { recursive: true });
      await writeJsonAtomic(fileOf(bookId, record.page), record);
      return record;
    });
  }

  /** 只删自己认得的 `p<page>.json`，再尝试收掉空目录；别的残文件原样留着。 */
  async function clearBook(bookId) {
    return await serialize(bookId, async () => {
      const base = bookDir(bookId);
      let names;
      try {
        names = await readdir(base);
      } catch (error) {
        if (error?.code === 'ENOENT') return { removed: 0 };
        throw error;
      }
      let removed = 0;
      for (const name of names) {
        if (PAGE_FILE_RE.test(name) === false) continue;
        // ★ 删不掉**不能**算清掉：无条件 removed += 1 会让宿主和用户都以为
        //   缓存已空，下一秒 list() 又把旧译文读回来（0.71.0 在禁止 unlink 的
        //   环境里实测踩过）。只有「本来就不在」可以放过，权限错误要冒泡到路由。
        try {
          await unlink(join(base, name));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        removed += 1;
      }
      await rmdir(base).catch(() => {});
      return { removed };
    });
  }

  /** 每本书已缓存几页（设置页 / 测试用；只读目录，不读内容）。 */
  async function counts() {
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    const out = {};
    for (const name of names) {
      if (!isBookId(name)) continue;
      const files = await readdir(join(dir, name)).catch(() => []);
      const n = files.filter(file => PAGE_FILE_RE.test(file)).length;
      if (n > 0) out[name] = n;
    }
    return out;
  }

  return { dir, bookDir, fileOf, list, putPage, clearBook, counts };
}
