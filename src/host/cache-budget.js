/**
 * 缓存上限与淘汰（2026-10-25）。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────────────────
 *
 * 这个插件在磁盘上有四类东西，体积量级差三个数量级：
 *
 *   pan-cache/<fsId>/*.blk   网盘块缓存        实测 89 MB（几十本书）
 *   digests/<bookId>/        解读 + 抽出的正文  实测 5.3 MB（几本书），一本 1–2 MB
 *   data.json.bak-*          历次清理的备份    实测 7 份 ≈ 40 MB，**只增不减**
 *   annotations/<bookId>.json 划线             几十 KB
 *
 * 前三类**都没有上限**（`pan.js` 的块缓存除外，它 0.8.6 起就有 1 GiB + 整本淘汰）。
 * 按现在的增速，读完 300 本书光是 `digests/` 就是 500 MB 量级，而备份文件是
 * 「每跑一次清理脚本就多一份，永不删除」—— 这类东西的特征是**没人会主动去看**，
 * 直到磁盘满了才发现，而那时用户看到的是一句 `ENOSPC: no space left on device`。
 *
 * ── 三条设计约束（都是「不这么做就会出人命」的级别）─────────────────────
 *
 * 1. **只删可重算的**。`digest/` 是花模型调用换来的（一章一次），`annotations/`
 *    是用户手写的 —— 自动删这两种，用户会**再付一次钱 / 永久丢内容**。
 *    所以超限时删的是 `text/`（重新抽取即可，纯本地）、`pages.jsonl`（抽取中间态）、
 *    `ocr.json`（重新识别，0.5–0.8 秒/页）。删完 `digest/` 还在，解读照样能看。
 * 2. **绝不因为「缓存超限」拒绝一次写入**。要写的东西要么是花钱生成的，要么是
 *    用户手写的，丢掉比占空间糟得多。上限靠淘汰执行；淘汰也腾不出空间时，
 *    如实返回 `over: true`，由界面说「自动清理已经清不出空间了，请手动清理」。
 * 3. **淘汰要能解释**。每一次删都写一条日志（删了哪本、腾了多少），界面上也有
 *    「已用 / 上限」可看 —— 否则用户永远不知道自己少了一本书的正文。
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 默认上限。
 *
 * `digestBytes` 取 512 MiB：一本 300 页书的 `text/` + `digest/` 约 1–2 MB，
 * 512 MiB ≈ 250–500 本，对「常读的那几十本」绰绰有余；再往上调只是把问题推迟。
 * 用户机器宽裕时可以调大（见 `GET /cache` 返回的 `limit`）。
 */
export const CACHE_LIMITS = Object.freeze({
  digestBytes: 512 * 1024 * 1024,
  /** `data.json.bak-*` 保留几份。一次清理一份，留 5 份足够回溯，再多只是占地方。 */
  backupCount: 5,
  /** 孤立的 `data.json.<pid>.tmp` 超过这个年龄就当垃圾（正常写入只活几毫秒）。 */
  orphanTmpMs: 60 * 60 * 1000,
});

/** 超限时可以删的（都能从书上重算）。顺序无关，按目录逐个算体积。 */
export const RECOMPUTABLE_PARTS = Object.freeze(['text', 'pages.jsonl', 'ocr.json']);

/** 绝不能自动删的。写在这里是为了让「为什么没删它」有据可查，而不是靠读代码猜。 */
export const PROTECTED_PARTS = Object.freeze(['digest', 'meta.json', 'outline.json']);

/**
 * 字节数说成人话。
 *
 * ★ 不用 `toFixed(1)` 一律保留一位：`512.0 MB` 这种写法会让人以为精度很高，
 *   而这些数字本来就是目录扫描的近似值。≥100 时给整数，其余给一位小数。
 * ★ 单位用 KB / MB / GB（1024 进制）而不是 KiB：用户对前者有直觉，后者要换算。
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const text = index === 0 ? String(Math.round(value))
    : (value >= 100 ? String(Math.round(value)) : value.toFixed(1));
  return `${text} ${units[index]}`;
}

/**
 * 算出「要删哪几个」。
 *
 * @param {object} input
 * @param {Array<{key: string, bytes: number, at: number}>} input.entries - 每个候选**能腾出多少**字节，与最近使用时间。
 * @param {number} input.limitBytes - 上限。
 * @param {number} [input.totalBytes] - 当前**总体积**。默认 = `entries` 之和。
 *   ★ 这两个数必须分开传：`entries` 只是「能删的那部分」，而限保管的是**全部**。
 *     把两者混成一个数（第一版就是这么写的）会让判据永远判「没超」——
 *     因为「能删的总量」天然小于「总量」，于是删除永远不会发生，而上限看起来是生效的。
 *     这个 bug 被 `test/cache-budget.test.mjs` 里「超限时只删最旧那本」那条抓到。
 * @param {Iterable<string>} [input.protect] - 这批 key **不许删**（比如正在读的那本）。
 * @returns {{ remove: string[], freed: number, remaining: number, over: boolean }}
 *   `over: true` 表示「能删的都删了还是超」—— 调用方必须把这件事说出来，不能当成功。
 *
 * ★ 纯函数（不碰盘），所以可以真跑用例。判据是「删到不超为止」，不是「删一个」。
 * ★ 按 `at` **从旧到新**删：`at` 是「这本书最近一次被写/读」的时间，不是目录 mtime
 *   （往旧书里写新内容会把目录 mtime 刷新，按目录排会删掉刚用的那本，方向反了 ——
 *   `pan.js` 的 `evictDisk` 里记过同一个坑）。
 */
export function planPrune({ entries, limitBytes, totalBytes, protect } = {}) {
  const list = Array.isArray(entries)
    ? entries.filter((entry) => entry !== null && typeof entry === 'object'
      && typeof entry.key === 'string' && Number.isFinite(entry.bytes) && entry.bytes >= 0)
    : [];
  const limit = Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 0;
  const keep = protect instanceof Set ? protect : new Set(protect ?? []);
  const sum = list.reduce((acc, entry) => acc + entry.bytes, 0);
  const total = Number.isFinite(totalBytes) && totalBytes >= 0 ? totalBytes : sum;
  if (total <= limit) return { remove: [], freed: 0, remaining: total, over: false };

  const order = [...list].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  const remove = [];
  let freed = 0;
  for (const entry of order) {
    if (total - freed <= limit) break;
    if (keep.has(entry.key)) continue;
    if (entry.bytes <= 0) continue;
    remove.push(entry.key);
    freed += entry.bytes;
  }
  const remaining = total - freed;
  return { remove, freed, remaining, over: remaining > limit };
}

/** 一个目录（或文件）占多少字节。不存在 / 读不了 ⇒ 0，不抛。 */
export async function pathBytes(path) {
  const info = await stat(path).catch(() => null);
  if (info === null) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const name of await readdir(path).catch(() => [])) {
    total += await pathBytes(join(path, name));
  }
  return total;
}

/** 一个目录里所有文件的**最新** mtime —— 用作「这本书最近用过」的判据。 */
async function latestMtime(dir) {
  const info = await stat(dir).catch(() => null);
  let latest = info?.mtimeMs ?? 0;
  for (const name of await readdir(dir).catch(() => [])) {
    const child = join(dir, name);
    const childInfo = await stat(child).catch(() => null);
    if (childInfo === null) continue;
    if (childInfo.isDirectory()) {
      latest = Math.max(latest, await latestMtime(child));
    } else if (childInfo.mtimeMs > latest) {
      latest = childInfo.mtimeMs;
    }
  }
  return latest;
}

/**
 * 盘一遍 `digests/`：每本书占多少、其中多少是「可重算的」、最近什么时候用过。
 *
 * @returns {Promise<{ total: number, books: Array<{id: string, bytes: number, reclaimable: number, at: number}> }>}
 */
export async function measureDigestCache({ digestsDir } = {}) {
  if (typeof digestsDir !== 'string' || digestsDir === '') {
    throw new TypeError('cache-budget: 需要 digestsDir');
  }
  const names = await readdir(digestsDir).catch(() => []);
  const books = [];
  let total = 0;
  for (const name of names) {
    const dir = join(digestsDir, name);
    const info = await stat(dir).catch(() => null);
    if (info === null || !info.isDirectory()) continue;
    const bytes = await pathBytes(dir);
    let reclaimable = 0;
    for (const part of RECOMPUTABLE_PARTS) reclaimable += await pathBytes(join(dir, part));
    books.push({ id: name, bytes, reclaimable, at: await latestMtime(dir) });
    total += bytes;
  }
  return { total, books };
}

/**
 * 把解读缓存压回上限以内。
 *
 * ★ 只删 `RECOMPUTABLE_PARTS`，**`digest/` 一个字节都不动**（理由见文件头第 1 条）。
 * ★ `protect` 用来保护「正在读 / 刚生成」的那本：一次解读刚写完就被自己的预算淘汰掉，
 *   用户看到的是「生成成功但点开是空的」，比磁盘满更难查。
 *
 * @returns {Promise<{ total: number, limit: number, freed: number, removed: string[], over: boolean }>}
 */
export async function enforceDigestBudget({
  digestsDir, limitBytes = CACHE_LIMITS.digestBytes, protect, log = () => {},
} = {}) {
  const measured = await measureDigestCache({ digestsDir });
  const limit = Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : CACHE_LIMITS.digestBytes;
  if (measured.total <= limit) {
    return { total: measured.total, limit, freed: 0, removed: [], over: false };
  }

  const plan = planPrune({
    entries: measured.books.map((book) => ({ key: book.id, bytes: book.reclaimable, at: book.at })),
    limitBytes: limit,
    // ★ 必须把**总量**单独传进去（见 `planPrune` 的说明）：只传「能删的总和」，
    //   判据会永远判「没超」，于是删除一次也不会发生，而上限看起来是生效的。
    totalBytes: measured.total,
    protect,
  });

  let freed = 0;
  const removed = [];
  for (const id of plan.remove) {
    const dir = join(digestsDir, id);
    let bookFreed = 0;
    for (const part of RECOMPUTABLE_PARTS) {
      const target = join(dir, part);
      const bytes = await pathBytes(target);
      if (bytes <= 0) continue;
      await rm(target, { recursive: true, force: true }).catch(() => {});
      bookFreed += bytes;
    }
    if (bookFreed <= 0) continue;
    freed += bookFreed;
    removed.push(id);
    log(`[缓存] 超出上限，清掉 ${id} 的正文/OCR（腾出 ${formatBytes(bookFreed)}，已生成的解读保留）`);
  }

  const remaining = measured.total - freed;
  if (remaining > limit) {
    log(`[缓存] 可重算的部分已经清完，仍超上限：${formatBytes(remaining)} / ${formatBytes(limit)}`
      + '（剩下的都是已生成的解读，不自动删）');
  }
  return { total: remaining, limit, freed, removed, over: remaining > limit };
}

/**
 * 清掉 `digests/` 里**整本**的目录。
 *
 * ★ 与 `enforceDigestBudget` 是两件事，别合并：那个是「超限时自动腾地方」，
 *   这个是**用户明确点了「清理」**。用户点的清理要真的腾出空间，所以连解读一起删；
 *   自动淘汰不能碰解读（花钱的）。
 *
 * @param {object} input
 * @param {string[]} [input.bookIds] - 指定清哪几本；不传 = 全清。
 */
export async function clearDigestCache({ digestsDir, bookIds, log = () => {} } = {}) {
  const before = await pathBytes(digestsDir);
  const names = Array.isArray(bookIds) ? bookIds : await readdir(digestsDir).catch(() => []);
  let freed = 0;
  let removed = 0;
  for (const name of names) {
    const dir = join(digestsDir, name);
    const bytes = await pathBytes(dir);
    if (bytes <= 0) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    freed += bytes;
    removed += 1;
  }
  if (removed > 0) log(`[缓存] 用户清理解读缓存：${removed} 本，腾出 ${formatBytes(freed)}`);
  return { freed, removed, total: Math.max(0, before - freed) };
}

/**
 * 盘一遍 `data.json.bak-*` 与残留的 `data.json.<pid>.tmp`（只算体积，不删）。
 *
 * ★ 与 `pruneBackups` 分开：`GET /cache` 要能**只读**地报出「备份占了多少」，
 *   而 `pruneBackups` 是写操作。把两者混成一个函数，读接口就会顺手删文件 ——
 *   一个 GET 会改变磁盘状态，那是没法解释的行为。
 */
export async function measureBackups({ dataDir, now = Date.now(), orphanTmpMs = CACHE_LIMITS.orphanTmpMs } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('cache-budget: 需要 dataDir');
  const names = await readdir(dataDir).catch(() => []);
  let bytes = 0;
  let count = 0;
  let orphans = 0;
  for (const name of names) {
    const isBackup = /^data\.json\.bak-/.test(name);
    const isOrphanTmp = /^data\.json\.[^.]*\.tmp$/.test(name);
    if (!isBackup && !isOrphanTmp) continue;
    const info = await stat(join(dataDir, name)).catch(() => null);
    if (info === null || !info.isFile()) continue;
    if (isOrphanTmp && now - info.mtimeMs <= orphanTmpMs) continue;
    bytes += info.size;
    if (isBackup) count += 1;
    else orphans += 1;
  }
  return { bytes, count, orphans };
}

/**
 * 把**所有**可重算的部分清掉（用户点了「清理」时用）。
 *
 * ★ 与 `enforceDigestBudget` 的区别只有一个：那个是「超限才动」，这个是「用户要求动」。
 * ★ 仍然**不碰 `digest/`** —— 用户点的是「清理缓存」，不是「删掉我花过钱的解读」。
 *   要删解读得走「重新解读」/删书那条路，那里的文案会明确说会重新生成。
 */
export async function clearRecomputable({ digestsDir, log = () => {} } = {}) {
  const measured = await measureDigestCache({ digestsDir });
  let freed = 0;
  const removed = [];
  for (const book of measured.books) {
    if (book.reclaimable <= 0) continue;
    let bookFreed = 0;
    for (const part of RECOMPUTABLE_PARTS) {
      const target = join(digestsDir, book.id, part);
      const bytes = await pathBytes(target);
      if (bytes <= 0) continue;
      await rm(target, { recursive: true, force: true }).catch(() => {});
      bookFreed += bytes;
    }
    if (bookFreed <= 0) continue;
    freed += bookFreed;
    removed.push(book.id);
  }
  if (freed > 0) log(`[缓存] 用户清理可重算缓存：${removed.length} 本，腾出 ${formatBytes(freed)}`);
  return { freed, removed, total: measured.total - freed };
}

/**
 * 收拾 `data.json.bak-*` 与孤立的 `data.json.<pid>.tmp`。
 *
 * ★ 这些是**历次清理脚本**留下的（本项目在 `data.json` 上做过好几轮 orphan 清理），
 *   每跑一次多一份 6–8 MB 的完整副本，而没有任何代码会去删它们。实测一台机器上
 *   攒了 7 份 ≈ 40 MB。
 * ★ 只留最近 `keep` 份：备份的用途是「刚改坏时回滚」，回溯到三个月前的那一份没有意义。
 * ★ 孤立的 `.tmp` 要按**年龄**判（默认 1 小时）：正常写入的 tmp 只活几毫秒，
 *   但「正在写的那一个」和「上次崩溃留下的」在文件名上长得一模一样 —— 删错正在写的
 *   文件会让那次保存失败，所以宁可多留一小时。
 */
export async function pruneBackups({
  dataDir, keep = CACHE_LIMITS.backupCount, orphanTmpMs = CACHE_LIMITS.orphanTmpMs,
  now = Date.now(), log = () => {},
} = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('cache-budget: 需要 dataDir');
  const names = await readdir(dataDir).catch(() => []);
  const backups = [];
  const orphans = [];
  for (const name of names) {
    const full = join(dataDir, name);
    const info = await stat(full).catch(() => null);
    if (info === null || !info.isFile()) continue;
    if (/^data\.json\.bak-/.test(name)) {
      backups.push({ full, size: info.size, at: info.mtimeMs });
      continue;
    }
    if (/^data\.json\.[^.]*\.tmp$/.test(name) && now - info.mtimeMs > orphanTmpMs) {
      orphans.push({ full, size: info.size });
    }
  }

  backups.sort((a, b) => b.at - a.at);
  let freed = 0;
  const removed = [];
  for (const item of backups.slice(Math.max(0, keep))) {
    await rm(item.full, { force: true }).catch(() => {});
    freed += item.size;
    removed.push(item.full);
  }
  for (const item of orphans) {
    await rm(item.full, { force: true }).catch(() => {});
    freed += item.size;
    removed.push(item.full);
  }
  if (removed.length > 0) {
    log(`[缓存] 清掉 ${removed.length} 个备份/残留文件，腾出 ${formatBytes(freed)}`);
  }
  return { freed, removed, kept: Math.min(backups.length, keep) };
}
