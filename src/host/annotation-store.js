/**
 * 一本书的**划线 / 笔记**在磁盘上的布局与读写。
 *
 * ★ 为什么是独立文件而不是 `data.json` 里加一个字段：
 *   `store.js` 的 `flush()` 是**全量重写**，而 `data.json` 现在已经有 8 MB 正文。
 *   划一条线就重写 8 MB，等于「划一下卡一下」—— 与解读产物同一条理由
 *   （见 `digest-store.js` 顶部的说明）。所以：
 *
 *     annotations/<bookId>.json     ← 一本书一个文件，几十条时只有几 KB
 *
 * ★ 为什么不按「页」拆成多个文件：划线是**跨页阅读**的产物，用户打开笔记面板
 *   要的是「这本书我划了哪些」，那是整本一次读；按页拆只会得到几十个小文件
 *   和一次目录扫描。
 *
 * ★ 为什么不塞进 `digests/<bookId>/`：解读目录会**整本删掉**
 *   （`remove(bookId)`，换书或「重新解读」都会走）。划线是用户自己写的，
 *   不能因为重抽一次正文就跟着消失 —— 两个目录的生命周期完全不同。
 *
 * ── 一条划线长什么样 ────────────────────────────────────────────────────
 *
 *   { id, page, start, end, quote, note, tone, createdAt, updatedAt }
 *
 *   `start` / `end` 是**页内文字层字符偏移**（`layer.textContent` 里的下标），
 *   不是坐标、不是 PDF 字号。这是刻意选的锚：
 *     - 坐标会随缩放/适宽变化，存下来的一刷新就错位；
 *     - PDF 原生注释要写回文件，那是改用户的文件，本项目不干；
 *     - 偏移 + 摘录原文，渲染时用 Range 重新算矩形，缩放后自然跟着走；
 *       万一文字层变了（换过文件），还能用 `quote` 兜底找回或如实标为失配。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBookId } from '../library.js';

/** 标记颜色。与客户端 `ANNOTATION_TONES` 必须一致（两边都有测试盯着）。 */
export const TONES = Object.freeze(['yellow', 'green', 'blue', 'pink']);

export const NOTE_LIMIT = 4000;
export const QUOTE_LIMIT = 4000;
/** 一本书最多留多少条。到顶就拒绝并说清楚，而不是静默丢掉最早的那条。 */
export const MAX_ITEMS = 2000;

const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

function fail(message) {
  // 统一带上 code：路由层据此决定回 400 还是 500，不用去猜错误文案。
  const error = new Error(message);
  error.code = 'BAD_ANNOTATION';
  return error;
}

function clampText(value, limit, label) {
  if (typeof value !== 'string') throw fail(`${label}必须是文本`);
  const text = value.replace(/\r\n?/g, '\n');
  if (text.length > limit) throw fail(`${label}超过 ${limit} 字`);
  return text;
}

/**
 * 把外部输入收成一条合法记录。
 *
 * ★ 一律**重新构造**对象，不 `{...input}`：客户端多塞的字段（比如 `bookId`）
 *   进了文件就会变成「谁能写谁就是数据源」，下次渲染时它可能覆盖真实的值。
 */
export function normalizeAnnotation(input, { now = Date.now(), id } = {}) {
  if (input === null || typeof input !== 'object') throw fail('划线必须是对象');
  const page = Number(input.page);
  if (!Number.isInteger(page) || page < 1 || page > 99_999) throw fail('页码不合法');
  const start = Number(input.start);
  const end = Number(input.end);
  if (!Number.isInteger(start) || start < 0) throw fail('起点不合法');
  if (!Number.isInteger(end) || end <= start) throw fail('终点不合法');
  const quote = clampText(input.quote ?? '', QUOTE_LIMIT, '摘录');
  if (quote.trim() === '') throw fail('摘录是空的');
  const note = clampText(input.note ?? '', NOTE_LIMIT, '笔记');
  const tone = input.tone === undefined ? TONES[0] : String(input.tone);
  if (!TONES.includes(tone)) throw fail('颜色不合法');
  const madeId = id ?? input.id ?? `a-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!ID_RE.test(madeId)) throw fail('id 不合法');
  return { id: madeId, page, start, end, quote, note, tone, createdAt: Number(input.createdAt) || now, updatedAt: now };
}

/** 原子写：先写 tmp 再 rename（与 digest-store 同款，崩在中途不会留半个 JSON）。 */
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}

/**
 * @param options.rootDir - 插件数据目录（`pluginDataDir()`）。
 */
export function createAnnotationStore({ rootDir, log = () => {} } = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') throw new TypeError('annotation-store: 需要 rootDir');

  const dir = join(rootDir, 'annotations');

  function fileOf(bookId) {
    // id 从 HTTP 路径来，直接拼就是路径穿越 —— 与 digest-store 同一道闸。
    if (!isBookId(bookId)) throw new TypeError(`annotation-store: 非法 bookId ${String(bookId)}`);
    return join(dir, `${bookId}.json`);
  }

  /**
   * 每本书一条写队列。
   *
   * ★ 读-改-写必须**串行**：划线是用户连点两下的高频操作（划一句、再划下一句），
   *   两个请求同时「读到 12 条 → 各加 1 条 → 写回 13 条」就会静默丢掉一条。
   *   HTTP 层没有事务，只能在这里排队。
   */
  const chains = new Map();
  function serialize(bookId, task) {
    const previous = chains.get(bookId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // 队列本身不该把失败传染给下一个操作，也不该让 Map 无限长。
    chains.set(bookId, next.catch(() => {}));
    return next;
  }

  async function readAll(bookId) {
    let raw;
    try {
      raw = await readFile(fileOf(bookId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 坏掉的 JSON 当作「没有划线」，但**备份**一份原文件：
      //   用户可能划了几十条，直接覆盖等于把他的手写内容丢了。
      const broken = `${fileOf(bookId)}.broken-${Date.now()}`;
      await rename(fileOf(bookId), broken).catch(() => {});
      log(`[划线] ${bookId} 的 JSON 坏了，已备份到 ${broken}`);
      return [];
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const out = [];
    for (const item of items) {
      try {
        out.push(normalizeAnnotation(item, { now: item?.updatedAt ?? Date.now() }));
      } catch {
        // 单条坏掉只丢那一条：不因为它让整本书的划线全没了。
      }
    }
    return out.sort(compare);
  }

  async function writeAll(bookId, items) {
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(fileOf(bookId), { version: 1, bookId, items });
    return items;
  }

  function compare(a, b) {
    if (a.page !== b.page) return a.page - b.page;
    if (a.start !== b.start) return a.start - b.start;
    return a.createdAt - b.createdAt;
  }

  /** 这本书全部划线（按页码 + 位置排序）。文件不存在 ⇒ `[]`，不是错误。 */
  async function list(bookId) {
    return await readAll(bookId);
  }

  /**
   * 加一条。**同一页同一区间**重复加时返回已存在的那条（`duplicate: true`），
   * 不当错误抛 —— 用户拖选的边界常常差一两个字，重复点击是常态。
   */
  async function add(bookId, input) {
    return await serialize(bookId, async () => {
      const items = await readAll(bookId);
      const same = items.find(item => item.page === Number(input?.page)
        && item.start === Number(input?.start) && item.end === Number(input?.end));
      if (same !== undefined) return { items, item: same, duplicate: true };
      if (items.length >= MAX_ITEMS) throw fail(`这本书的划线已经到 ${MAX_ITEMS} 条上限`);
      const item = normalizeAnnotation(input);
      const next = [...items, item].sort(compare);
      await writeAll(bookId, next);
      return { items: next, item, duplicate: false };
    });
  }

  /** 改一条（只允许改 `note` / `tone`：位置是选区量出来的，改位置等于换了一条）。 */
  async function update(bookId, id, patch) {
    return await serialize(bookId, async () => {
      const items = await readAll(bookId);
      const index = items.findIndex(item => item.id === id);
      if (index === -1) throw fail('这条划线已经不在了');
      const current = items[index];
      const next = normalizeAnnotation({
        ...current,
        note: patch?.note === undefined ? current.note : patch.note,
        tone: patch?.tone === undefined ? current.tone : patch.tone,
      }, { id: current.id, now: Date.now() });
      const list = [...items];
      list[index] = next;
      await writeAll(bookId, list);
      return { items: list, item: next };
    });
  }

  /** 删一条。删不存在的 id 不报错（两个窗口同时删是正常的）。 */
  async function remove(bookId, id) {
    return await serialize(bookId, async () => {
      const items = await readAll(bookId);
      const next = items.filter(item => item.id !== id);
      if (next.length !== items.length) await writeAll(bookId, next);
      return { items: next, removed: next.length !== items.length };
    });
  }

  /** 每本书各有多少条（书架列表上显示「12 条笔记」用）。只读目录，不读内容。 */
  async function counts() {
    const { readdir } = await import('node:fs/promises');
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
    const out = {};
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const bookId = name.slice(0, -5);
      if (!isBookId(bookId)) continue;
      const items = await readAll(bookId).catch(() => []);
      if (items.length > 0) out[bookId] = items.length;
    }
    return out;
  }

  return { dir, fileOf, list, add, update, remove, counts };
}
