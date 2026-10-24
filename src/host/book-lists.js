/**
 * 书单文件与清单的读写：**一条书源 = 一份书单**。
 *
 * 为什么不是「所有源合并成一大份」（0.7.x 的做法）：合并之后「哪本书来自哪个目录」
 * 只在条目内部留一个 `top_dir`，而那是相对该源的**第一层子目录**，不是源本身。
 * 于是用户配了「本地电子书」和「网盘电子书」两个源，想只看网盘那份时**没有任何入口** ——
 * 界面上的分类筛选给不出「按源筛」，因为合并的那一刻这个信息就丢了。
 * 分成多份之后，「载入哪几份」就是一个用户可以自己决定的开关。
 *
 * ===========================================================================
 * 两个文件，两种角色，别搞混
 * ===========================================================================
 *
 * | 文件 | 是什么 | 谁写 |
 * | --- | --- | --- |
 * | `lists/<id>.json` | 一份书单的**全部书条目** | 扫描（`scanBookSources`） |
 * | `lists.json` | 每份书单的**摘要**（id / 本数 / 生成时间） | 扫描与「保存书源」 |
 *
 * ★ 清单里**刻意不存名字、路径、类型**。那三样是用户配置（`settings.bookSources`），
 *   在这里再存一份就是第二个真相来源：用户改个名字，还得回头把清单也改一遍，
 *   漏改一次就出现「设置里叫甲、列表里叫乙」。清单只存**扫出来的事实**。
 *
 * ★ 清单存在的唯一理由是**省一次全量解析**：界面一打开就要「每份多少本、什么时候生成的」，
 *   而书单本身可以有几 MB。为了两个数字去解析 N 份大 JSON，在网盘源那一侧是几秒级。
 *
 * ★ 所有写盘一律 `600` + 临时文件 + `rename`。这里的路径是用户整台机器的目录结构，
 *   权限和原子性和 `data.json` 一个档。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isBookId } from '../library.js';
import { bookListsDir, bookListsIndexPath } from './store.js';

/** 清单文件的结构版本。改动格式时递增，读到不认识的版本一律当空。 */
export const LISTS_INDEX_VERSION = 1;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 一份书单文件落在哪。`id` 必须先是合法书 id —— 它会被拼进路径。 */
export function listFilePath(id) {
  const key = String(id ?? '').trim();
  if (!isBookId(key)) throw coded('BAD_LIST_ID', `书单 id 不合法：${JSON.stringify(id)}`);
  return join(bookListsDir(), `${key}.json`);
}

/** 原子写 + 600 权限。 */
async function writeJsonAtomic(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

/**
 * 读清单。任何问题都返回空数组 —— 清单是**派生物**，丢了只是「显示成还没生成」，
 * 而真正的内容还在 `lists/*.json` 里，重扫一次就回来了。为它抛错会拦住整个设置页。
 */
export async function readListsIndex() {
  let raw;
  try {
    raw = await readFile(bookListsIndexPath(), 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.lists)) return [];
  const out = [];
  const seen = new Set();
  for (const row of parsed.lists) {
    const id = String(row?.id ?? '');
    if (!isBookId(id) || seen.has(id)) continue;
    seen.add(id);
    const count = Number(row?.count);
    const generatedAt = Number(row?.generatedAt);
    out.push({
      id,
      count: Number.isInteger(count) && count >= 0 ? count : 0,
      generatedAt: Number.isFinite(generatedAt) && generatedAt > 0 ? generatedAt : 0,
    });
  }
  return out;
}

export async function writeListsIndex(lists) {
  await writeJsonAtomic(bookListsIndexPath(), {
    version: LISTS_INDEX_VERSION,
    lists: (lists ?? []).map((row) => ({ id: row.id, count: row.count ?? 0, generatedAt: row.generatedAt ?? 0 })),
  });
}

/**
 * 从清单里摘掉不再对应的条目，并回写。
 *
 * ★ 什么时候会需要：用户在第二步把一条书源删了。清单里那条就变成了孤儿 ——
 *   不摘掉的话，第三步的「已载入」里会留着一个点不开的空条目，而用户已经看不到
 *   它对应的那条书源了，根本无从下手修。
 *
 * @returns 保留下来的清单条目。
 */
export async function pruneListsIndex(validIds) {
  const keep = new Set(validIds ?? []);
  const all = await readListsIndex();
  const kept = all.filter((row) => keep.has(row.id));
  if (kept.length !== all.length) await writeListsIndex(kept);
  return kept;
}

/**
 * 读一份书单的**全部书条目**由 `host/library.js` 的 `readLibraryIndex(path)` 负责。
 *
 * ★ 这里刻意**不另写一个读取器**。书单有两种来源（我们生成的 / 用户手写的），
 *   两个读取器意味着两套「什么叫坏文件」的判定 —— 而它俩迟早会漂移，
 *   漂移出来的症状是「同一份文件从外部书单那条路进去能读、从生成的那条路进去报错」，
 *   谁也解释不清为什么。写入在这里（因为文件名由 id 决定），读取统一在那边。
 */

/** 写一份书单（原子 + 600）。`generatedAt` 一并记进文件头部，便于直接打开看。 */
export async function writeListFile(id, books) {
  const payload = {
    version: LISTS_INDEX_VERSION,
    id,
    generatedAt: Date.now(),
    count: (books ?? []).length,
    books: books ?? [],
  };
  await writeJsonAtomic(listFilePath(id), payload);
  return { count: payload.count, generatedAt: payload.generatedAt };
}

/** 删掉一份书单文件（对应的书源被移除时）。文件不在也算成功。 */
export async function removeListFile(id) {
  await rm(listFilePath(id), { force: true });
}
