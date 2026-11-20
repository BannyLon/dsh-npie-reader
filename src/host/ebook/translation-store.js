/**
 * 电子书**对照译文**的磁盘层（`<pluginData>/ebook-translations/<bookId>.json`）。
 *
 * ★ 为什么不塞进 `ebooks/<bookId>.json`（解析缓存）：
 *   那份会被「重新解析」整份覆盖掉，而译文是**花过钱**的产物 —— 用户换了一个
 *   同名的书、或者解析缓存因为体积变化被丢弃时，解析结果可以重算，译文不该跟着没了。
 *   两份文件、两种生命周期，分开存最省心。
 *
 * ★ 为什么不塞进 `data.json`：
 *   那份是全量重写。一本 300 节的书译文有几兆，翻一页写一次两兆是灾难
 *   （同 `digest-store.js` 文件头那条判断）。
 *
 * ★ 一节一份、整本一个文件：
 *   按节分文件（`<bookId>/<n>.json`）会让目录里塞进几百个小文件；整本一个文件
 *   又怕并发写坏。折中是「整本一个文件 + 每次写入都原子替换 + 同书写入串行」——
 *   并发只可能来自同一本书的两次翻译，串行一下就没有竞态了。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapOfEntries } from '../../ebook-translate.js';

const BOOK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 译文文件的版本。形状变了就 +1，老文件会被当成「没有缓存」重翻。 */
export const EBOOK_TRANSLATION_VERSION = 1;

/** 单本译文文件的上限。超了就不再写（宁可不缓存，也不让磁盘被一本书吃满）。 */
const MAX_BOOK_BYTES = 24 * 1024 * 1024;

export function createEbookTranslationStore({ rootDir, log = () => {} } = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') throw new TypeError('ebookTranslationStore: 需要 rootDir');

  const pathOf = (bookId) => join(rootDir, `${bookId}.json`);

  /** 同一本书的写入串行化。见文件头最后一段。 */
  const queues = new Map();

  async function load(bookId) {
    if (!BOOK_ID.test(String(bookId ?? ''))) return null;
    let text;
    try {
      text = await readFile(pathOf(bookId), 'utf8');
    } catch {
      return null;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }
    if (payload?.v !== EBOOK_TRANSLATION_VERSION) return null;
    if (payload.sections === null || typeof payload.sections !== 'object') return null;
    return payload;
  }

  /**
   * 取某一节的译文。
   *
   * ★ `chars` 校验是**失效判据**：文件被换过（同名、同体积都算极端情况）、
   *   或者解析结果重算后分节变了，节号仍可能指向另一段正文。字数对不上就当作
   *   没有缓存 —— 让用户重翻一次，好过把上一本书的译文贴到这一本上。
   *
   * @returns `{ entries: Map<number, string>, coverage, model, at }` 或 `null`。
   */
  async function readSection(bookId, n, { chars } = {}) {
    const payload = await load(bookId);
    const section = payload?.sections?.[String(n)];
    if (section === undefined) return null;
    if (Number.isFinite(chars) && Number.isFinite(section.chars) && Number(section.chars) !== Number(chars)) {
      return null;
    }
    const entries = mapOfEntries(section.entries);
    if (entries.size === 0) return null;
    return {
      entries,
      coverage: section.coverage ?? { total: entries.size, done: entries.size, ratio: 1 },
      model: String(section.model ?? ''),
      at: String(section.at ?? ''),
    };
  }

  /**
   * 写入某一节的译文。
   *
   * ★ 读-合并-写三步在**队列里**完成：两个请求同时翻同一本书的两节时，
   *   各自读到旧文件再各自写回，后写的会把先写的那一节整个抹掉 ——
   *   症状是「刚翻完第 3 节，翻第 4 节之后第 3 节又没了」，且没有任何报错。
   */
  async function writeSection(bookId, n, { chars = 0, entries, model = '', coverage = null } = {}) {
    if (!BOOK_ID.test(String(bookId ?? ''))) throw new TypeError(`ebookTranslationStore: 书 id 不合法（${bookId}）`);
    const pairs = Array.isArray(entries) ? entries : [];
    if (pairs.length === 0) return null;
    const payload = {
      chars: Number(chars) || 0,
      entries: pairs,
      model: String(model ?? ''),
      coverage,
      at: new Date().toISOString(),
    };
    const previous = queues.get(bookId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const current = (await load(bookId)) ?? {
        v: EBOOK_TRANSLATION_VERSION, bookId, updatedAt: '', sections: {},
      };
      current.v = EBOOK_TRANSLATION_VERSION;
      current.sections = current.sections ?? {};
      current.sections[String(n)] = payload;
      current.updatedAt = payload.at;
      const text = JSON.stringify(current);
      if (text.length > MAX_BOOK_BYTES) {
        log(`[书架] 译文缓存已满（${bookId}），这一节不落盘`);
        return payload;
      }
      await mkdir(rootDir, { recursive: true });
      const target = pathOf(bookId);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, text, 'utf8');
      try {
        await rename(tmp, target);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      log(`[书架] 对照译文已写：${bookId} 第 ${n} 节（${pairs.length} 段）`);
      return payload;
    });
    queues.set(bookId, next);
    try {
      return await next;
    } finally {
      if (queues.get(bookId) === next) queues.delete(bookId);
    }
  }

  /**
   * 这本书已译的节号（升序）。
   *
   * 界面用它回答「这本书对照到哪了」；也用来判断「点开对照时要不要真的发请求」。
   */
  async function listSections(bookId) {
    const payload = await load(bookId);
    if (payload === null) return [];
    return Object.keys(payload.sections ?? {})
      .map(Number)
      .filter(n => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);
  }

  async function remove(bookId) {
    if (!BOOK_ID.test(String(bookId ?? ''))) return;
    await rm(pathOf(bookId), { force: true }).catch(() => {});
  }

  return { readSection, writeSection, listSections, remove, pathOf };
}
