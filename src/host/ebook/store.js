/**
 * 解析结果的磁盘缓存（`~/.dsh/storages/dsh-npie-reader/ebooks/<bookId>.json`）。
 *
 * ★ 为什么必须落盘：解析一本 2.5 MB 的 MOBI（LZ77 解压 + HTML → 块）在本机约
 *   0.4–1.2 秒，一本书翻来覆去打开十次就是十次；而「重新打开一本刚看过的书要等一秒」
 *   正是这个插件一直想避免的手感（PDF 那条路是用会话级文档缓存解决的）。
 * ★ 为什么缓存里**不存 `lines`**：`lines` 完全由 `blocks` 推导（`blocksToLines`），
 *   两份一起存等于让缓存文件大 40%，而读盘是在每次打开书时都要付的。
 * ★ 失效判据 = `v`（块模型版本）+ `size`（文件被换过）。网盘书没有 mtime，
 *   用「体积 + 版本」是能拿到的最强信号；同名同体积不同内容属于极端情况。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EBOOK_CACHE_VERSION } from './index.js';
import { blocksToLines } from './markup.js';

const BOOK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 缓存文件的上限（一本 100 MB 的合集解出来的块也会小于它）。 */
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

export function createEbookStore({ rootDir, log = () => {} } = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') throw new TypeError('ebookStore: 需要 rootDir');

  const pathOf = (bookId) => join(rootDir, `${bookId}.json`);

  /** 读缓存。任何异常都当「没有缓存」—— 一份坏缓存不该让书打不开。 */
  async function read(bookId, size) {
    if (!BOOK_ID.test(String(bookId ?? ''))) return null;
    let text;
    try {
      text = await readFile(pathOf(bookId), 'utf8');
    } catch {
      return null;
    }
    if (text.length > MAX_CACHE_BYTES) return null;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }
    if (payload?.v !== EBOOK_CACHE_VERSION) return null;
    if (Number.isFinite(size) && size > 0 && Number(payload.size) !== Number(size)) return null;
    if (!Array.isArray(payload.sections) || payload.sections.length === 0) return null;
    return {
      ...payload,
      sections: payload.sections.map((section, index) => {
        const blocks = Array.isArray(section.blocks) ? section.blocks : [];
        const lines = Array.isArray(section.lines) ? section.lines : blocksToLines(blocks);
        return {
          title: String(section.title ?? '') || `第 ${index + 1} 节`,
          blocks,
          lines,
          chars: Number(section.chars) || 0,
          empty: Number(section.chars) === 0,
          level: Number.isInteger(section.level) ? section.level : 0,
        };
      }),
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
      toc: Array.isArray(payload.toc) ? payload.toc : [],
    };
  }

  /** 写缓存（原子替换：先写 tmp 再 rename，避免半份文件被下次读到）。 */
  async function write(bookId, size, ebook) {
    if (!BOOK_ID.test(String(bookId ?? ''))) throw new TypeError(`ebookStore: 书 id 不合法（${bookId}）`);
    await mkdir(rootDir, { recursive: true });
    const payload = {
      v: EBOOK_CACHE_VERSION,
      size: Number(size) || 0,
      format: ebook.format,
      title: ebook.title,
      author: ebook.author,
      warnings: ebook.warnings,
      toc: ebook.toc,
      sections: ebook.sections.map(section => ({
        title: section.title,
        chars: section.chars,
        blocks: section.blocks,
        // 目录层级：没有自带目录的书（TXT）靠它缩进，丢了就整本一个层级。
        level: Number.isInteger(section.level) ? section.level : 0,
      })),
    };
    const target = pathOf(bookId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    try {
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    log(`[书架] 电子书缓存已写：${bookId}（${ebook.sections.length} 节）`);
  }

  async function remove(bookId) {
    if (!BOOK_ID.test(String(bookId ?? ''))) return;
    await rm(pathOf(bookId), { force: true }).catch(() => {});
  }

  return { read, write, remove, pathOf };
}
