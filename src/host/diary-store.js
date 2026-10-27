/**
 * 日记的存储层：一天一个 `.md`，落在**插件自己的数据目录**里。
 *
 *     <DSH_HOME>/storages/dsh-npie-reader/diary/daily/2026-10-26.md
 *
 * ★ 为什么不写用户的 Obsidian 库（这条是用户 2026-10-26 定的）：
 *   库那边有自己的写入者（Obsidian 进程、iCloud、手机端），两边都能改就必然分叉，
 *   而「哪份是新的」没有答案。日记放插件自己家，只有**一个真相**；
 *   想搬出去走「导出」，一次性、不记账、不留同步语义。
 *
 * ★ 为什么不是 `data.json`：那个文件已经 9.6 MB，`flush()` 是**全量重写**。
 *   日记正文进去等于每写一句话重写 9.6 MB，而且一份坏 JSON 会连累全部订阅数据。
 *
 * ★ 为什么要有「按文件串行队列」：界面里「保存」可以被连点，AI 整理与手工编辑
 *   也可能同时回来。两次读-改-写并发时，后完成的那次会把前一次的结果整段抹掉。
 *   `annotation-store.js` 已经因为同一件事加过队列，这里照抄那个形状。
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  DIARY_API_PREFIX, ENTRY_KINDS, META_OPEN, appendEntryText, buildDay, dateKey, dayCharCount, dayFileName,
  isValidDateKey, isValidMonthKey, moodScore, normalizeMeta, parseDay, parseTags, removeEntryText, updateEntryText,
  splitFrontmatter, timeKey,
} from '../diary-format.js';
import { createDiaryGate } from './diary-gate.js';
import { createDiarySecret } from './diary-secret.js';
import { pluginDataDir } from './store.js';

export { DIARY_API_PREFIX };

/** 一条记录的字数上限。一条灵感写 2 万字，多半是粘错了东西。 */
export const MAX_ENTRY_CHARS = 20_000;
/** 一天的总字数上限。超过就拒绝写入 —— 一天 20 万字，界面和检索都会开始难受。 */
export const MAX_DAY_CHARS = 200_000;
/** 搜索时最多看多少个文件（按日期倒序，最近的先看）。 */
export const SEARCH_FILE_LIMIT = 400;
/** 搜索默认返回条数。 */
export const SEARCH_RESULT_DEFAULT = 30;
export const SEARCH_RESULT_MAX = 100;
/** 时间轴一次最多给多少天。 */
export const TIMELINE_DAY_LIMIT = 60;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 列目录，**目录不存在就是空**（第一次用插件时两个目录都还没有）。 */
async function readDirQuiet(dir) {
  try {
    return await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** 日记根目录。导出给路由与设置页显示（用户要知道东西在哪）。 */
export function diaryRoot() {
  return join(pluginDataDir(), 'diary');
}

export function diaryDailyDir() {
  return join(diaryRoot(), 'daily');
}

/**
 * 私密日记的目录。**与 `daily/` 平级、文件后缀不同**（`.md.enc`）。
 *
 * ★ 为什么不是「同一个文件里有的条目加密」：Markdown 没法只加密一部分。
 *   一天里既有公开灵感又有私密日记时，只能是两个文件。
 * ★ 为什么后缀是 `.md.enc` 而不是 `.enc`：一眼看得出它是「加密的 Markdown」，
 *   用户想用 `openssl` 之类手工处理时也不会猜错内容格式。
 */
export function diaryPrivateDir() {
  return join(diaryRoot(), 'private');
}

/**
 * 一个日期对应的绝对路径。
 *
 * ★ **自己校验，不依赖调用方**（2026-10-26 修）：原来只做 `join`，靠「调用点都
 *   先 `isValidDateKey` 过了」这条口头约定 —— 而 `join(root, '../../etc/passwd.md')`
 *   是**真的能拼出去**的。口头约定在下一个调用点就会被忘掉，所以白名单必须长在
 *   拼路径这个函数自己身上。这一条由 `test/diary-store.test.mjs` 的「拼不出路径」
 *   钉着，那条用例是**先失败**才补上的。
 */
export function diaryFilePath(key) {
  if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
  return join(diaryDailyDir(), dayFileName(key));
}

/** 私密那半边的路径。同样自己校验日期。 */
export function diaryPrivateFilePath(key) {
  if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
  return join(diaryPrivateDir(), `${dayFileName(key)}.enc`);
}

/** 读一天。文件不存在时 `exists: false`，**不是错误** —— 那天就是还没写。 */
export async function readDay(key) {
  if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
  const file = diaryFilePath(key);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { date: key, exists: false, text: '', entries: [], chars: 0 };
    throw error;
  }
  const { entries } = parseDay(text);
  return { date: key, exists: true, text, entries, chars: dayCharCount(entries) };
}

/**
 * 写入一天（原子）。
 *
 * `tmp → rename` 不是洁癖：非原子写在断电/崩溃时留下的是**半截文件**，而半截的
 * 日记比没有更糟 —— 它会静默吞掉后半段，界面上看起来"就写了这么多"。
 */
async function writeDayAtomic(key, text) {
  await mkdir(diaryDailyDir(), { recursive: true });
  const file = diaryFilePath(key);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
  return file;
}

/**
 * 写入一天的私密日记（**先加密再原子写**）。
 *
 * ★ 顺序不能反：先写明文再原地加密，中间那一瞬磁盘上就是明文 —— 而这一整层
 *   存在的唯一理由就是「磁盘上没有明文」。
 */
async function writePrivateAtomic(key, text, secret) {
  await mkdir(diaryPrivateDir(), { recursive: true });
  const file = diaryPrivateFilePath(key);
  const envelope = await secret.encrypt(text);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, envelope, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
  return file;
}

/**
 * 造一个日记存储。
 *
 * @param options.log - 记一行日志（可选）。
 * @param options.now - 取当前时间（测试注入用，默认 `new Date()`）。
 * @param options.secret - 密钥/信封（测试注入用；默认走钥匙串，见 `diary-secret.js`）。
 */
export function createDiaryStore(options = {}) {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const secret = options.secret ?? createDiarySecret({ log, keyPath: join(diaryRoot(), 'secret.key') });
  // 口令闸门：与磁盘加密**正交**。加密管「拷走也看不见」，闸门管「本机上点一下也看不见」。
  const gate = options.gate ?? createDiaryGate({ root: diaryRoot(), log, now: () => now().getTime() });
  /** 每个文件一条队列：读-改-写必须串行，否则并发时后写覆盖先写。 */
  const queues = new Map();

  function enqueue(file, task) {
    const previous = queues.get(file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queues.set(file, next);
    // 队列跑完就摘掉，否则「写过一天的 Map」会一直长。
    next.catch(() => {}).then(() => {
      if (queues.get(file) === next) queues.delete(file);
    });
    return next;
  }

  function assertEntryInput(input) {
    const body = typeof input?.body === 'string' ? input.body : '';
    if (body.trim() === '') throw coded('EMPTY_ENTRY', '这一条是空的，没有可保存的内容');
    if (body.length > MAX_ENTRY_CHARS) throw coded('ENTRY_TOO_LARGE', `一条最多 ${MAX_ENTRY_CHARS} 字`);
    const kind = ENTRY_KINDS.includes(input?.kind) ? input.kind : '灵感';
    const source = typeof input?.source === 'string' ? input.source.trim().slice(0, 300) : '';
    const time = /^\d{2}:\d{2}$/.test(input?.time ?? '') ? input.time : timeKey(now());
    // ★ `vis` 不写进元数据行：它描述的是「这条存在哪个文件里」，不是内容属性。
    //   写进正文反而会出现「公开条目里写着 private」这种自相矛盾的文件。
    const meta = normalizeMeta(input?.meta);
    delete meta.vis;
    const vis = input?.vis === 'private' ? 'private' : 'public';
    return { time, kind, source, meta, body, vis };
  }

  /**
   * 读一天的**私密**那半边（解密后仍是同一套 Markdown）。
   * 没有文件 ⇒ `exists: false`；解不开 ⇒ 抛 `DECRYPT_FAILED`（**不能当成空的**，
   * 那会让用户以为自己的日记没了，而再写一条就会把整天的密文覆盖掉）。
   */
  async function readPrivateDay(key) {
    if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
    const file = diaryPrivateFilePath(key);
    let blob;
    try {
      blob = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { date: key, exists: false, text: '', entries: [], chars: 0 };
      throw error;
    }
    const text = await secret.decrypt(blob);
    const { entries } = parseDay(text);
    return { date: key, exists: true, text, entries, chars: dayCharCount(entries) };
  }

  /**
   * 一天的全部条目：公开 + 私密，按时间合并，**每一条都带 `scope` 与 `index`**。
   *
   * ★ 为什么不把两边合成一个下标数组：界面要能删「第 3 条」，而第 3 条可能是私密的。
   *   两个文件各有自己的下标，合并后只保留一个序号就必然要「反查」，反查错一次
   *   就是删掉别人一条日记。所以序号按 `scope` 各自编号，界面带着 `scope` 回来。
   */
  async function readDayFull(key) {
    const pub = await readDay(key);
    const priv = await readPrivateDay(key);
    const tagged = (list, scope) => list.map((entry, index) => ({ ...entry, scope, index }));
    const entries = [...tagged(pub.entries, 'public'), ...tagged(priv.entries, 'private')]
      // 时间相同就公开在前：私密条目排在后面，界面上的小锁才不会被一条灵感挡掉。
      .sort((left, right) => left.time.localeCompare(right.time) || (left.scope === right.scope ? 0 : left.scope === 'public' ? -1 : 1));
    return {
      date: key,
      exists: pub.exists || priv.exists,
      text: pub.text,
      entries,
      chars: pub.chars + priv.chars,
      publicCount: pub.entries.length,
      privateCount: priv.entries.length,
    };
  }

  /**
   * 追加一条到某一天（默认今天）。
   * @returns `{ date, time, index, chars, path, scope }` —— `index` 是这一条在
   *   **它自己那一半**里的序号，界面靠它做「删掉刚写的那条」，不用重新解析一遍。
   */
  async function append(input = {}) {
    const key = input.date ?? dateKey(now());
    if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
    const entry = assertEntryInput(input);
    const privateSide = entry.vis === 'private';
    const file = privateSide ? diaryPrivateFilePath(key) : diaryFilePath(key);
    return await enqueue(file, async () => {
      const current = privateSide ? await readPrivateDay(key) : await readDay(key);
      const nextText = appendEntryText(current.exists ? current.text : '', { ...entry, date: key });
      const { entries } = parseDay(nextText);
      const chars = dayCharCount(entries);
      if (chars > MAX_DAY_CHARS) {
        throw coded('DAY_TOO_LARGE', `这一天已经 ${chars} 字，超过 ${MAX_DAY_CHARS} 字上限，请新建一条读后感单独存`);
      }
      if (privateSide) await writePrivateAtomic(key, nextText, secret);
      else await writeDayAtomic(key, nextText);
      log(`[日记] 追加 ${key} ${entry.time} ${entry.kind}（${entry.body.length} 字${privateSide ? '，私密' : ''}）`);
      return { date: key, time: entry.time, index: entries.length - 1, chars, path: file, scope: entry.vis };
    });
  }

  /**
   * 删掉某一天的某一条。
   * `scope` 缺省为 `'public'`（老调用点与老测试都只有公开那半边）。
   */
  async function removeEntry(input = {}) {
    const key = input.date;
    if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
    const privateSide = input.scope === 'private';
    const file = privateSide ? diaryPrivateFilePath(key) : diaryFilePath(key);
    return await enqueue(file, async () => {
      const current = privateSide ? await readPrivateDay(key) : await readDay(key);
      if (!current.exists) throw coded('ENTRY_NOT_FOUND', `${key} 还没有日记`);
      const result = removeEntryText(current.text, input.index);
      if (result === null) throw coded('ENTRY_NOT_FOUND', '这一条已经不存在了（可能刚被删掉）');
      if (privateSide) await writePrivateAtomic(key, result.text, secret);
      else await writeDayAtomic(key, result.text);
      return { date: key, entries: result.entries.length, chars: dayCharCount(result.entries), scope: input.scope === 'private' ? 'private' : 'public' };
    });
  }

  /**
   * 改写某一天的某一条（正文 / 时间 / 类型 / 来源 / 元数据）。
   *
   * ★ 为什么需要它：在它之前，agent 只有 `append` —— 用户说「把今天这五条压成三条」，
   *   模型只能**追加**三条新的、把原来五条留在原地。用户 2026-10-27 的原话是
   *   「AI 整理为什么只能往灵感里追加新条目，不能改也不能删。我需要的是能改能删」。
   * ★ `scope` 与删除同源：两个文件各有自己的序号，只给一个数字必然要靠合并下标反查。
   * ★ 空正文一律拒绝（`ENTRY_EMPTY`）：要清空就该用删除，而不是留一条空壳。
   */
  async function updateEntry(input = {}) {
    const key = input.date;
    if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
    if (typeof input.body !== 'string' || input.body.trim() === '') {
      throw coded('ENTRY_EMPTY', '改写后的正文是空的。要删掉这一条，请用删除。');
    }
    if (input.body.length > MAX_ENTRY_CHARS) {
      throw coded('ENTRY_TOO_LARGE', `一条最多 ${MAX_ENTRY_CHARS} 字，这一条 ${input.body.length} 字`);
    }
    const privateSide = input.scope === 'private';
    const file = privateSide ? diaryPrivateFilePath(key) : diaryFilePath(key);
    return await enqueue(file, async () => {
      const current = privateSide ? await readPrivateDay(key) : await readDay(key);
      if (!current.exists) throw coded('ENTRY_NOT_FOUND', `${key} 还没有日记`);
      const result = updateEntryText(current.text, input.index, {
        body: input.body,
        time: input.time,
        kind: input.kind,
        source: input.source,
        meta: normalizeMeta(input.meta),
      });
      if (result === null) throw coded('ENTRY_NOT_FOUND', '这一条已经不存在了（可能刚被删掉）');
      const chars = dayCharCount(result.entries);
      if (chars > MAX_DAY_CHARS) {
        throw coded('DAY_TOO_LARGE', `这一天会变成 ${chars} 字，超过 ${MAX_DAY_CHARS} 字上限`);
      }
      if (privateSide) await writePrivateAtomic(key, result.text, secret);
      else await writeDayAtomic(key, result.text);
      log(`[日记] 改写 ${key} #${input.index} ${result.entry.kind}（${result.entry.body.length} 字${privateSide ? '，私密' : ''}）`);
      return {
        date: key,
        index: input.index,
        time: result.entry.time,
        kind: result.entry.kind,
        chars,
        scope: privateSide ? 'private' : 'public',
      };
    });
  }

  /**
   * 某个月里哪些天有日记、各有几条。
   * ★ 公开那半边只按**标题行**计数，不解析正文：一个月 31 个文件全量解析在月视图里
   *   是白花的开销，而界面只需要那个数字。
   * ★ 私密那半边必须**解密**才知道条数。解不开时按 1 条算并置 `privateError` ——
   *   谎报 0 条会让用户以为那天的私密日记没了。
   */
  /**
   * 某个月里哪些天有日记、各有几条，**公开与私密分开数**。
   *
   * ★ 为什么要分开（2026-10-27 用户反馈）：以前 `days` 是两半加在一起的一个数。
   *   私密日记本的侧栏于是显示「今天 2 条」——而那 2 条是**灵感**。用户的原话是
   *   「私密日记本侧边栏为什么还显示灵感的记录条数」。合成一个数以后，
   *   「这一天我写了几篇私密日记」这个问题在界面上**无法回答**。
   *   `days` 保留为合计（老调用点与老测试还在用），`publicDays` / `privateDays`
   *   才是界面该看的两个数。
   *
   * ★ 私密那半边必须**解密**才知道条数。解不开时按 1 条算并置 `privateError` ——
   *   谎报 0 条会让用户以为那天的私密日记没了。
   *
   * ★ `moods` 是给日历上那粒点用的：`{ [date]: { public: 1..5|null, private: 1..5|null } }`，
   *   取那一边所有条目心情的**平均值**（四舍五入）。以前日历只有「有 / 没有」一个灰点，
   *   而「情绪追踪」这条需求要的正是「翻月历能看出这个月大概怎么样」。
   *   只有一天里**真的记过心情**才给分；没记就是 `null`，界面画默认点 —— 不编数。
   *
   * ★ 只按**标题行**计数、只在文件里出现元数据标记时才解析：一个月 31 个文件全量
   *   解析是白花的开销。但心情必须解析才拿得到，所以用 `META_OPEN` 做个短路 ——
   *   没写过心情的那天连 `parseDay` 都不跑。
   */
  async function listMonth(monthKey) {
    if (!isValidMonthKey(monthKey)) throw coded('BAD_MONTH', `无效的月份：${monthKey}`);
    const days = {};
    const publicDays = {};
    const privateDays = {};
    const moods = {};
    let total = 0;
    const add = (side, key, count, scores) => {
      days[key] = (days[key] ?? 0) + count;
      total += count;
      const bucket = side === 'private' ? privateDays : publicDays;
      bucket[key] = (bucket[key] ?? 0) + count;
      if (scores.length === 0) return;
      const cell = moods[key] ?? { public: null, private: null };
      cell[side] = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
      moods[key] = cell;
    };
    const scoresOf = (text) => (text.includes(META_OPEN)
      ? parseDay(text).entries.map((entry) => moodScore(entry.meta?.mood)).filter((value) => value !== null)
      : []);
    for (const name of await readDirQuiet(diaryDailyDir())) {
      if (!name.endsWith('.md')) continue;
      const key = name.slice(0, -3);
      if (!isValidDateKey(key) || !key.startsWith(monthKey)) continue;
      const text = await readFile(join(diaryDailyDir(), name), 'utf8').catch(() => '');
      add('public', key, (text.match(/^## \d{2}:\d{2}/gm) ?? []).length, scoresOf(text));
    }
    let privateError = '';
    for (const name of await readDirQuiet(diaryPrivateDir())) {
      if (!name.endsWith('.md.enc')) continue;
      const key = name.slice(0, -7);
      if (!isValidDateKey(key) || !key.startsWith(monthKey)) continue;
      try {
        const text = await secret.decrypt(await readFile(join(diaryPrivateDir(), name), 'utf8'));
        add('private', key, (text.match(/^## \d{2}:\d{2}/gm) ?? []).length, scoresOf(text));
      } catch (error) {
        // 解不开也要在日历上留一个点：那天**确实写过**，只是数不出来（心情同理）。
        add('private', key, 1, []);
        privateError = error?.message ?? String(error);
      }
    }
    const result = { month: monthKey, days, publicDays, privateDays, moods, total };
    if (privateError !== '') result.privateError = privateError;
    return result;
  }

  /**
   * 扫一遍所有日记（默认只扫公开那半边），按日期倒序，对每一条回调。
   *
   * 三个功能共用它：搜索、标签索引、时间轴。分开写三遍的后果是「搜索能搜到、
   * 标签里没有、时间轴里也不显示」，而三处都"对"。
   *
   * ★ `includePrivate` 默认 **false**。这不是性能考量，是**边界**：
   *   私密日记的内容不该经过模型。工具（`diary_search`）不传这个参数就永远看不到
   *   私密条目；只有用户自己在界面上翻/搜时，路由层才显式传 `true`。
   *   想「让 AI 也读私密」的话，那是一个需要单独想清楚的决定，不该是默认值。
   *
   * @param visit - `(item) => boolean|void`，返回 `false` 表示「够了，停」。
   * @returns `{ scanned, truncated, privateError }`。
   */
  async function scanDays(visit, { fileLimit = SEARCH_FILE_LIMIT, includePrivate = false } = {}) {
    const pubNames = (await readDirQuiet(diaryDailyDir()))
      .filter((name) => name.endsWith('.md') && isValidDateKey(name.slice(0, -3)));
    const privNames = includePrivate
      ? (await readDirQuiet(diaryPrivateDir())).filter((name) => name.endsWith('.md.enc') && isValidDateKey(name.slice(0, -7)))
      : [];
    const keys = [...new Set([...pubNames.map((name) => name.slice(0, -3)), ...privNames.map((name) => name.slice(0, -7))])]
      .sort()
      .reverse();
    const scanned = keys.slice(0, fileLimit);
    let privateError = '';
    let stop = false;
    for (const key of scanned) {
      const sides = [];
      if (pubNames.includes(dayFileName(key))) {
        const text = await readFile(join(diaryDailyDir(), dayFileName(key)), 'utf8').catch(() => '');
        sides.push({ scope: 'public', entries: parseDay(text).entries });
      }
      if (privNames.includes(`${dayFileName(key)}.enc`)) {
        try {
          const text = await secret.decrypt(await readFile(join(diaryPrivateDir(), `${dayFileName(key)}.enc`), 'utf8'));
          sides.push({ scope: 'private', entries: parseDay(text).entries });
        } catch (error) {
          // 解不开就跳过这一天，但把原因带出去 —— 静默跳过等于「那几天的日记不存在」。
          privateError = error?.message ?? String(error);
        }
      }
      for (const side of sides) {
        for (const [index, entry] of side.entries.entries()) {
          if (visit({ date: key, scope: side.scope, index, entry }) === false) { stop = true; break; }
        }
        if (stop) break;
      }
      if (stop) break;
    }
    return { scanned: scanned.length, truncated: keys.length > scanned.length || stop, privateError };
  }

  /**
   * 标签索引：`{ tags: [{ tag, count, last }], scanned, truncated }`。
   *
   * `last` 是最后一次用到这个标签的日期 —— 界面按它倒序。按次数排会让一个两年前的
   * `#灵感` 永远压在第一个，而它早就不代表现在了。
   *
   * ★ `includePrivate` **默认 false，必须由调用方显式打开**。路由层（用户在界面上
   *   看标签云）传 `true`；任何工具/模型侧的调用都不传 —— 标签名本身就是内容
   *   （`#离婚` 这种标签泄露的信息不比正文少），所以它和正文守同一条边界。
   */
  async function tags(input = {}) {
    const index = new Map();
    const scan = await scanDays(({ date, entry }) => {
      for (const tag of parseTags(entry.body)) {
        const current = index.get(tag) ?? { tag, count: 0, last: '' };
        current.count += 1;
        if (date > current.last) current.last = date;
        index.set(tag, current);
      }
    }, { includePrivate: input.includePrivate === true });
    const list = [...index.values()].sort((left, right) => (
      right.last.localeCompare(left.last) || right.count - left.count || left.tag.localeCompare(right.tag)
    ));
    const result = { tags: list, scanned: scan.scanned, truncated: scan.truncated };
    if (scan.privateError) result.privateError = scan.privateError;
    return result;
  }

  /**
   * 时间轴：最近 N 天，每天带上条目预览。
   * `before` 传一个 `YYYY-MM-DD` 就只给比它更早的（「加载更早」）。
   * `includePrivate` 同 `tags()`：默认 false，只有界面显式打开。
   */
  async function timeline(input = {}) {
    const asked = Number(input.limit);
    const limit = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), TIMELINE_DAY_LIMIT)
      : 30;
    const before = isValidDateKey(input.before) ? input.before : '';
    const days = new Map();
    const scan = await scanDays(({ date, scope, index, entry }) => {
      if (before !== '' && date >= before) return;
      const day = days.get(date) ?? { date, entries: [] };
      day.entries.push({
        scope,
        index,
        time: entry.time,
        kind: entry.kind,
        source: entry.source,
        mood: entry.meta?.mood ?? '',
        // 「灵感流转」的落地证据：在书里按 L 记的灵感带着这三个字段。
        // 侧栏按 `book` 分组就是「哪些灵感已经挂到书上了」，不需要再扫一遍。
        book: entry.meta?.book ?? null,
        chapter: entry.meta?.chapter ?? null,
        page: entry.meta?.page ?? null,
        // 挂在文章上的那一条记的是订阅源里的 key：日记页点一下要能回到那一篇，
        // 而不是把用户丢回「这一天」的日记列表（0.39 之前就是这样）。
        article: entry.meta?.article ?? null,
        tags: parseTags(entry.body),
        preview: entry.body.replace(/\s+/g, ' ').slice(0, 160),
      });
      days.set(date, day);
    }, { includePrivate: input.includePrivate === true });
    const ordered = [...days.values()]
      .sort((left, right) => right.date.localeCompare(left.date))
      .slice(0, limit)
      .map((day) => ({ ...day, entries: day.entries.sort((left, right) => left.time.localeCompare(right.time)) }));
    const result = { days: ordered, total: ordered.length, scanned: scan.scanned, truncated: scan.truncated };
    if (scan.privateError) result.privateError = scan.privateError;
    return result;
  }

  /**
   * 某一本书的全部读后感（跨天）。
   *
   * ★ 为什么需要它：读后感**不属于某一天**，它属于一本书 —— 「这本书我写过什么」
   *   是读后感工作台的主视图，而按日期翻是找不到它的。存储仍是「一天一个文件」，
   *   这里按 `meta.book` 反查。
   * ★ 只扫公开那半边：读后感模块写的是明文条目（私密是另一个模块）。
   * ★ **必须同时按 `kind` 过滤**：0.31.0 起「灵感流转」也会写 `meta.book`
   *   （在书里按 `L` 记的灵感自动挂到那本书上）。只按 `meta.book` 收的话，
   *   这本书的灵感会一条条混进「读后感」列表 —— 而两边都是合法条目，
   *   界面上看不出任何异常，只是「读后感」里出现了不是你写读后感的段落。
   */
  async function byBook(bookId) {
    const id = typeof bookId === 'string' ? bookId.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw coded('BAD_BOOK', `无效的书籍 id：${bookId}`);
    const entries = [];
    const scan = await scanDays(({ date, scope, index, entry }) => {
      if (entry.meta?.book !== id) return;
      if (entry.kind !== '读后感') return;
      entries.push({
        date,
        scope,
        index,
        time: entry.time,
        kind: entry.kind,
        mood: entry.meta?.mood ?? '',
        chapter: entry.meta?.chapter ?? null,
        page: entry.meta?.page ?? null,
        body: entry.body,
      });
    });
    // 新的在前：读后感是「最近写了什么」的视图，不是年表。
    entries.sort((left, right) => right.date.localeCompare(left.date) || right.time.localeCompare(left.time));
    return { bookId: id, entries, total: entries.length, scanned: scan.scanned, truncated: scan.truncated };
  }

  /**
   * 跨天搜索。
   *
   * ★ 判据与 `rss_search_articles` / `book_search` **同一条**：trim + 小写 + 子串，不分词。
   *   「磨坊主妇」与「磨坊」应当互相包含，而不是两种结果 —— 否则会出现
   *   「AI 说写过、你自己搜不到」。
   * ★ 触顶要**说清楚**：扫到上限就带上 `truncated: true`，界面/工具必须写
   *   「只看了最近 N 篇」，不能让人以为「就这些」。
   */
  async function search(input = {}) {
    const needle = String(input.query ?? '').trim().toLowerCase();
    if (needle === '') return { query: '', hits: [], scanned: 0, truncated: false };
    // ★ 非正数 / 非数字一律按「没指定」处理，**不夹成 1**（2026-10-26 明确）：
    //   夹成 1 时，模型把「不限」写错成 `limit: 0` 就只会拿到一条，而它会把这
    //   读成「日记里关于这件事就一条」—— 又是一个确定的假话。退回默认值至少
    //   只会「少给一些」，不会给出一个错误的结论。
    const asked = Number(input.limit);
    const limit = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), SEARCH_RESULT_MAX)
      : SEARCH_RESULT_DEFAULT;
    const hits = [];
    const scan = await scanDays(({ date, scope, index, entry }) => {
      const hay = `${entry.kind} ${entry.source} ${entry.body}`.toLowerCase();
      if (!hay.includes(needle)) return;
      const at = hay.indexOf(needle);
      hits.push({
        date,
        scope,
        index,
        time: entry.time,
        kind: entry.kind,
        source: entry.source,
        snippet: entry.body.replace(/\s+/g, ' ').slice(Math.max(0, at - 40), at + 120),
      });
      if (hits.length >= limit) return false;
    }, { includePrivate: input.includePrivate === true });
    const result = { query: needle, hits: hits.slice(0, limit), scanned: scan.scanned, truncated: scan.truncated };
    if (scan.privateError) result.privateError = scan.privateError;
    return result;
  }

  /**
   * 全部导出：`{ files: [{ name, text }] }`。
   *
   * ★ 取消「移入 Obsidian」之后，这是日记**唯一**的出口。没有它，重装 DSH 就是全丢，
   *   而 `~/.dsh/storages/` 不是用户会去翻的地方。
   * ★ 只读、只拼内存里的字符串，不写任何用户目录 —— 落盘由浏览器下载完成。
   * ★ **默认不含私密日记**：导出是往浏览器下载目录里写明文，那正好是加密层要防的
   *   第一件事。要导出私密部分必须显式传 `includePrivate: true`，且由界面把后果
   *   说清楚 —— 不能让一次「点导出」把加密悄悄拆了。
   */
  async function exportAll(input = {}) {
    const files = [];
    for (const name of (await readDirQuiet(diaryDailyDir()))
      .filter((item) => item.endsWith('.md') && isValidDateKey(item.slice(0, -3)))
      .sort()) {
      const text = await readFile(join(diaryDailyDir(), name), 'utf8').catch(() => '');
      if (text !== '') files.push({ name, text });
    }
    let skippedPrivate = 0;
    const privNames = (await readDirQuiet(diaryPrivateDir()))
      .filter((item) => item.endsWith('.md.enc') && isValidDateKey(item.slice(0, -7)))
      .sort();
    skippedPrivate = privNames.length;
    if (input.includePrivate === true) {
      for (const name of privNames) {
        const key = name.slice(0, -7);
        try {
          const text = await secret.decrypt(await readFile(join(diaryPrivateDir(), name), 'utf8'));
          files.push({ name: `${key}.private.md`, text });
          skippedPrivate -= 1;
        } catch {
          // 解不开就留在「没导出」的计数里，让界面如实说「有 N 天没导出」。
        }
      }
    }
    const result = { files, total: files.length, skippedPrivate };
    return result;
  }

  /** 目录里有多少天的日记、占多少字节、密钥在哪（设置页与页脚显示用）。 */
  async function stats() {
    const pubNames = (await readDirQuiet(diaryDailyDir()))
      .filter((name) => name.endsWith('.md') && isValidDateKey(name.slice(0, -3)));
    const privNames = (await readDirQuiet(diaryPrivateDir()))
      .filter((name) => name.endsWith('.md.enc') && isValidDateKey(name.slice(0, -7)));
    /*
     * ★ 两边**分开称重**（2026-10-27 用户反馈「这个数据怎么还在灵感这里出现」）：
     *   以前只回一个 `days` = 公开 + 私密，界面于是原样印成
     *   「日记共 4 天（私密 1 天）· 5 KB」—— 在灵感模块里也会闻到私密的存在：
     *   天数里混着私密的天，字节数里混着私密的密文，再挂一个导出私密明文的入口。
     *   那不是「信息多一点」，是**两个模块的数据串在一起** —— 你在读自己的灵感，
     *   界面却在汇报你写过多少私密日记。
     *   ⇒ 现在两边各自给天数与字节数，页脚按当前模块挑自己的那份。
     * ★ 合计仍保留：`days` / `bytes` 回答的是另一个问题（「这套日记一共占多少盘」），
     *   只是它不再被当成某一个模块的数字。
     */
    let publicBytes = 0;
    for (const name of pubNames) {
      publicBytes += (await stat(join(diaryDailyDir(), name)).catch(() => null))?.size ?? 0;
    }
    let privateBytes = 0;
    for (const name of privNames) {
      privateBytes += (await stat(join(diaryPrivateDir(), name)).catch(() => null))?.size ?? 0;
    }
    const secretStatus = secret.peek();
    return {
      days: pubNames.length + privNames.length,
      publicDays: pubNames.length,
      privateDays: privNames.length,
      bytes: publicBytes + privateBytes,
      publicBytes,
      privateBytes,
      root: diaryRoot(),
      // ★ 只报「已知的状态」，**不在这里取密钥**：页脚会频繁调它，而取密钥可能碰
      //   系统钥匙串。用户没写过私密日记时更不该凭空造一把密钥出来。
      secret: secretStatus.mode,
    };
  }

  /** 测试用：清掉某一天（**不导出给路由**，路由层不该有删除整天的能力）。 */
  async function dropDayForTest(key) {
    if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
    for (const file of [diaryFilePath(key), diaryPrivateFilePath(key)]) {
      await unlink(file).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  return {
    root: diaryRoot,
    dailyDir: diaryDailyDir,
    privateDir: diaryPrivateDir,
    pathOf: diaryFilePath,
    privatePathOf: diaryPrivateFilePath,
    read: readDay,
    readFull: readDayFull,
    readPrivate: readPrivateDay,
    append,
    updateEntry,
    removeEntry,
    listMonth,
    search,
    tags,
    timeline,
    byBook,
    exportAll,
    stats,
    secret,
    gate,
    dropDayForTest,
    buildDay,
    splitFrontmatter,
    // 供守卫脚本断言「这个模块没有把正文写进 data.json」时用的标记：
    writesOnlyUnder: diaryRoot(),
    pathSeparator: sep,
  };
}
