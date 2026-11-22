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
  DIARY_API_PREFIX, DIARY_MODULES, ENTRY_KINDS, META_OPEN, appendEntryText, buildDay, dateKey, dayCharCount, dayFileName,
  isValidDateKey, isValidMonthKey, moodScore, normalizeMeta, parseDay, parseTags, removeEntryText, updateEntryText,
  splitFrontmatter, stripInlineTargets, timeKey,
} from '../diary-format.js';
import { snippetAround } from './search.js';
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
/**
 * 「某一个来源的全部灵感」最多看多少个文件。
 *
 * ★ 不能借用 `SEARCH_FILE_LIMIT`（400）：那一档设计给「搜索，先看最近的」，
 *   而这里的答案是**「这本书一共有多少条」**。三年日记就超过 400 个文件，
 *   借用它会让横条上那个数字变成「最近 400 天里的 N 条」—— 一个看起来是全部、
 *   其实不全的数字，正是 `bySource()` 存在的理由。
 * ★ 仍留一个上限：目录异常（被塞了几十万个文件）时不能把主进程拖死。
 *   两万天 = 五十多年，正常日记永远到不了。
 */
export const SOURCE_SCAN_LIMIT = 20_000;

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

/** 摘要：压掉空白、取前 60 字。侧栏 268px 只放得下一行多一点。 */
function previewOf(body) {
  return String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * `YYYY-MM-DD` 前后挪几天。
 * ★ 用 UTC 算：本地时区里跨夏令时的那两天是 23 / 25 小时，按毫秒加减会把
 *   「昨天」算成前天或今天，而「连续记录」正是靠这个数一天天数出来的。
 */
function shiftDay(key, delta) {
  const [year, month, day] = key.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, day + delta));
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  return `${at.getUTCFullYear()}-${mm}-${dd}`;
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

/**
 * 「现在在哪个模块」→ 导出 / 搜索的作用域。
 *
 * ★ 这张表**只有一份**（`DIARY_MODULES`）。界面上那三个选项卡的 `value` 与这里的
 *   `kind` 本来是同一件事；宿主再抄一份映射，迟早漂成「界面写着读后感、导出的
 *   却是灵感」—— 而文件名看起来完全正常，用户要到打开文件才发现。
 * ★ 认不出的模块返回 `null`：这里**不猜**。猜错的后果是一份不是用户要的文件
 *   已经落进下载目录了（而下载目录还会被 iCloud 同步走）。
 *   调用方（路由层）负责把非法值拒成 400。
 */
export function moduleScope(value) {
  const found = DIARY_MODULES.find((item) => item.value === value);
  return found ? { module: found.value, label: found.label, kind: found.kind, vis: found.vis } : null;
}

/**
 * 某一条属不属于这个模块（只用于公开那半边：灵感与读后感同处一个 `.md`）。
 *
 * ★ 灵感用**排除法**（`kind !== '读后感'`），不是「等于灵感」：0.30 之前写过的
 *   「书摘」条目还躺在文件里（`LEGACY_KINDS`）。按等于判，它们会在模块导出里
 *   凭空消失，而用户只看到「导出的比写的少」，无从知道少了什么。
 * ★ 这条口径与界面的 `inspirationEntries`、`append()` 的 `listedCount` 同源。
 */
export function inModule(mod, entry) {
  if (mod.module === 'inspiration') return entry.kind !== '读后感';
  return entry.kind === mod.kind;
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
   * @returns `{ date, time, index, chars, path, scope, kind, kindAsked, kindFellBack, listedCount }`
   *   —— `index` 是这一条在**它自己那一半**里的序号，界面靠它做「删掉刚写的那条」；
   *   `listedCount` 见下（回执里「今天第 N 条」用它，**不要**用 `index + 1`）；
   *   `kindFellBack` 表示「调用方给的类型不认识、已按 `kind` 存下」，回执必须说出来。
   */
  async function append(input = {}) {
    const key = input.date ?? dateKey(now());
    if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
    const asked = typeof input?.kind === 'string' ? input.kind.trim() : '';
    const entry = assertEntryInput(input);
    /*
     * ★ 把「你要的类型」和「实际存下的类型」一起回给调用方。
     *   `assertEntryInput` 对不认识的 kind 是**静默**兜成「灵感」的（`ENTRY_KINDS` 白名单），
     *   而工具回执原来不提这件事 —— 模型于是可能对用户说「我记成书摘了」，
     *   文件里却是灵感。这正是本项目最忌讳的「确定的假话」。
     * ★ 判据用 `asked !== entry.kind`（**结果**），不在这里再抄一份白名单：
     *   白名单只有 `assertEntryInput` 一处，抄第二份迟早漂开。
     */
    const kindFellBack = asked !== '' && asked !== entry.kind;
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
      /*
       * ★ `listedCount` = **界面上那个模块会列出来的条数**（0.72.0）。
       *   灵感速记的回执要说「今天第 N 条」，而 `index + 1` 是公开侧**全部**条目的
       *   序号 —— 灵感模块的列表排除「读后感」（`DiaryApp` 的 `inspirationEntries`）。
       *   今天写过一篇读后感时两个数就差 1：回执说「第 3 条」而界面显示 2 条，
       *   是一句可以被当场证伪的话。
       * ★ 口径只在这里算一次，客户端不重算：白名单/过滤规则分散到两处，迟早漂开。
       */
      const listedCount = privateSide
        ? entries.length
        : entries.filter((item) => item.kind !== '读后感').length;
      return {
        date: key, time: entry.time, index: entries.length - 1, chars, path: file, scope: entry.vis,
        kind: entry.kind, kindAsked: asked, kindFellBack, listedCount,
      };
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
   * 删掉某一天的**全部记录**（0.75.0）。
   *
   * 用户 2026-11-11：「我需要一个删除某天的全部记录」。
   *
   * ★ 为什么不写成「循环调用 `removeEntry`」：那是 N 次「读整份 → 删一条 → 整份写回」，
   *   中途任何一次失败都会留下**删了一半**的一天 —— 界面上看起来是「有些没了、
   *   有些还在」，而且没有任何一条路径能把它恢复到之前的样子。
   *   整天删除必须是一次原子动作：一次 `rename`。
   * ★ **先挪后删，绝不 `unlink`**：移到 `diary/_trash/`，原文件消失、界面立刻清空，
   *   但磁盘上那一天还是完整的 Markdown。删一整天与删一条的量级不同 ——
   *   误点一次就是一天的东西永久没了，而这里没有撤销栈能救回来。
   *   文件名带删除时刻（`2026-11-11@2026-11-11T13-36-37-901Z.md`），
   *   想找回时一眼看得出「哪一次删的、删的是哪天」。
   * ★ 只动**这一半**：公开与私密是两个文件（`daily/*.md` 与 `private/*.md.enc`），
   *   调用方必须用 `scope` 说明删哪一半 —— 与 `removeEntry` 同一条理由，猜错一次
   *   就是删错文件。
   * ★ 解不开的私密文件**仍然允许删**：`readPrivateDay` 在密钥不可用 / 信封损坏时
   *   会抛 `DECRYPT_FAILED`，若据此拒绝删除，那个文件就会永远赖在那里，而用户要的
   *   正是把它清掉。这种情况下条目数报 0、并用 `unreadable` 如实说明
   *   （回执不能编一个数字）。
   */
  async function removeDay(input = {}) {
    const key = input.date;
    if (!isValidDateKey(key)) throw coded('BAD_DATE', `无效的日期：${key}`);
    const privateSide = input.scope === 'private';
    const file = privateSide ? diaryPrivateFilePath(key) : diaryFilePath(key);
    return await enqueue(file, async () => {
      let current;
      let unreadable = false;
      if (privateSide) {
        try {
          current = await readPrivateDay(key);
        } catch {
          unreadable = true;
          // 解不开 ≠ 不存在：文件在那里，只是读不出条目。删除照做，数字不编。
          current = { exists: true, entries: [], chars: 0 };
        }
      } else {
        current = await readDay(key);
      }
      if (!current.exists) throw coded('ENTRY_NOT_FOUND', `${key} 还没有日记`);
      const entries = current.entries.length;
      const chars = current.chars;

      const trashDir = join(diaryRoot(), '_trash');
      await mkdir(trashDir, { recursive: true });
      // 毫秒级时间戳：同一毫秒删同一天不可能发生（第一次已经把文件挪走了）。
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      // ★ `dayFileName()` 自带 `.md`，这里要的是**去掉后缀的日期**：
      //   直接拼会得到 `2026-11-02.md@…md`（第一版就是这么写的，被测试当场抓住）。
      const base = dayFileName(key).replace(/\.md$/, '');
      const name = `${base}@${stamp}${privateSide ? '.md.enc' : '.md'}`;
      await rename(file, join(trashDir, name));

      return {
        date: key,
        scope: privateSide ? 'private' : 'public',
        entries,
        chars,
        unreadable,
        // 相对 `diary/` 的落点，回执与确认框都要用它告诉用户「去哪儿找回来」。
        trashed: `_trash/${name}`,
      };
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
    /*
     * ★ `body` 是**可选**的：不传 = 保留原文（`updateEntryText` 本来就是这么写的）。
     *   路由文档（`diary-routes.js` 顶部）写的是「body 里给要改的字段」，
     *   而这里原来强制要求整条正文 —— 等于把 PATCH 做成了 PUT。
     *   后果很具体：界面只想「补一个出处」，却必须把用户的原话再传一遍；
     *   万一浮层开着的时候正文在别处被改过，这一传就把改动覆盖回去，而且**不报错**。
     *   传了就必须非空：空正文不是「清空」，那条路是删除。
     */
    if (input.body !== undefined && (typeof input.body !== 'string' || input.body.trim() === '')) {
      throw coded('ENTRY_EMPTY', '改写后的正文是空的。要删掉这一条，请用删除。');
    }
    if (typeof input.body === 'string' && input.body.length > MAX_ENTRY_CHARS) {
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
   * 私密那一侧的自省面板：「本月情绪与足迹」+「那年今日」。
   *
   * ★ 为什么单开一个方法，不往 `listMonth` 里塞：`listMonth` 回答的是「哪几天写过、
   *   各几条」，它跑在**每一次翻月**上。这里要的是按心情分档计数、连续天数、跨年同月日 ——
   *   翻页用不上的东西不该让日历变慢。
   * ★ 只读**私密**那半边。用户要的就是「私密日记多一份跨越时间的浪漫」；
   *   把公开那半边也并进来，这一块会变成第二份时间轴。
   * ★ `locked` 是**量出来的结果**，不是猜的：解不开就明说，界面据此把情绪与字数收起来。
   *   连续天数只靠**文件名**，所以锁着也照样给 —— 它是这一块里唯一在锁着时还有意义的数。
   *
   * ★ 三个日期**各有所指，不能合并成一个**：
   *   - `date`  → 「那年今日」的锚点（按它的月-日回溯往年）；
   *   - `today` → 连续天数的锚点（真实今天；翻看去年某天时 `date ≠ today`）；
   *   - `month` → 情绪分布与字数的统计月（**跟着日历显示的那个月走**）。
   *   少传 `month` 就用 `date` 的月 —— 但界面在「按箭头翻到上个月、却没点任何一天」时
   *   `selected` 仍停在上个月，此时若拿 `date` 当统计月，会出现「『这个月』列的是九月、
   *   『本月情绪』说的是八月」这种两个数字对不上的样子。
   */
  async function dashboard({ date, today = date, month = String(date ?? '').slice(0, 7) } = {}) {
    if (!isValidDateKey(date)) throw coded('BAD_DATE', `无效的日期：${date}`);
    if (!isValidDateKey(today)) throw coded('BAD_DATE', `无效的今天：${today}`);
    if (!isValidMonthKey(month)) throw coded('BAD_MONTH', `无效的月份：${month}`);
    const keys = (await readDirQuiet(diaryPrivateDir()))
      .filter((name) => name.endsWith('.md.enc'))
      .map((name) => name.slice(0, -7))
      .filter((key) => isValidDateKey(key))
      .sort();
    const keySet = new Set(keys);
    const readPrivate = async (key) => secret.decrypt(
      await readFile(join(diaryPrivateDir(), `${dayFileName(key)}.enc`), 'utf8'),
    );
    let locked = false;
    let days = 0;
    let chars = 0;
    const counts = new Map();
    const byMood = new Map();
    /*
     * 按天汇总的基调：`date -> { sum, n }`，最后取平均。
     *
     * ★ 为什么要它：`counts` 只回答「这个月各档各几条」，那是**没有时间的一句统计** ——
     *   界面上只能画成两个百分比，看不出「月中塌了一次、月末回上来」。
     *   一天的基调取当天所有条目的平均分（一天写三条、两条一般一条烦，
     *   那天就是 2.67），这样曲线上的一个点对应日历上的一格，两块能对得上。
     * ★ 解不开的那天**不落点**，不补 0 —— 曲线在缺口处断开（见 `diary-tide.js`），
     *   而不是被一条直线横穿过去假装有数据。
     */
    const dayTone = new Map();
    for (const key of keys) {
      if (!key.startsWith(month)) continue;
      days += 1;
      let text = '';
      try {
        text = await readPrivate(key);
      } catch {
        // 解不开就只算「那天写过」，不计字数与心情 —— 不能把 0 字当成真的 0 字。
        locked = true;
        continue;
      }
      const entries = parseDay(text).entries;
      chars += dayCharCount(entries);
      let daySum = 0;
      let dayCount = 0;
      for (const entry of entries) {
        const score = moodScore(entry.meta?.mood);
        if (score === null) continue;
        daySum += score;
        dayCount += 1;
        counts.set(score, (counts.get(score) ?? 0) + 1);
        const bucket = byMood.get(score) ?? [];
        if (bucket.length < 200) bucket.push({ date: key, time: entry.time, preview: previewOf(entry.body) });
        byMood.set(score, bucket);
      }
      if (dayCount > 0) dayTone.set(key, { sum: daySum, n: dayCount });
    }
    /*
     * 连续记录：**今天没写就从昨天起算**。
     * 直接从今天数的话，早上打开这一页会看到「连续 0 天」—— 而用户昨天明明写了、
     * 昨天那一串也还在，一个还没到的日子不该把已有的记录判成断了。
     */
    let streak = 0;
    let cursor = keySet.has(today) ? today : shiftDay(today, -1);
    while (keySet.has(cursor) && streak < 3650) {
      streak += 1;
      cursor = shiftDay(cursor, -1);
    }
    /*
     * 那年今日：同一个「月-日」、更早的年份，最多 5 年。
     * ★ 这里给的是**摘要**不是全文：侧栏 268px 放不下正文，而这一块的用途是
     *   「想起来还有那么一天」，点进去才是正文。
     */
    const mmdd = date.slice(5);
    const year = Number(date.slice(0, 4));
    const onThisDay = [];
    for (const key of [...keys].reverse()) {
      if (onThisDay.length >= 5) break;
      if (key.slice(5) !== mmdd) continue;
      const past = Number(key.slice(0, 4));
      if (!Number.isInteger(past) || past >= year) continue;
      const cell = { date: key, years: year - past, time: '', preview: '' };
      try {
        const first = parseDay(await readPrivate(key)).entries[0];
        if (first) {
          cell.time = first.time;
          cell.preview = previewOf(first.body);
        }
      } catch {
        cell.locked = true;
      }
      onThisDay.push(cell);
    }
    /*
     * 「上次提笔」：选中这一天**之前**的最近一篇。
     *
     * ★ 为什么要有它：`onThisDay` 只认「更早年份的同一个日子」。第一年用这个插件，
     *   那块永远是空的 —— 而且不只是第一年：**一年里的 364 天**，只要往年没在同月
     *   同日写过，也都是空的。空着不是「今天没有可看的」，是这块地方在整段时间里
     *   没有任何用途（用户 2026-10-29：「感觉要用一年之后才会有那年今日，那么第一年
     *   这里怎么办？这是个逻辑bug」）。
     * ★ 所以没有往年同日时，退回「上一次写日记是哪天、写了什么」。它回答的是同一个
     *   问题（「我以前留下过什么」），只是把「去年的今天」放宽成了「上一次」。
     * ★ 只往前找，不找选中这天之后：这一块的语义是回望，不是预览。
     */
    const toUTC = (key) => {
      const [year_, month_, day_] = key.split('-').map(Number);
      return Date.UTC(year_, month_ - 1, day_);
    };
    let lastEntry = null;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key >= date) continue;
      lastEntry = {
        date: key,
        daysAgo: Math.round((toUTC(date) - toUTC(key)) / 86400000),
        time: '',
        preview: '',
      };
      try {
        const first = parseDay(await readPrivate(key)).entries[0];
        if (first) {
          lastEntry.time = first.time;
          lastEntry.preview = previewOf(first.body);
        }
      } catch {
        lastEntry.locked = true;
      }
      break;
    }
    const moods = [...counts.entries()]
      .map(([score, count]) => ({ score, count }))
      .sort((left, right) => right.count - left.count || right.score - left.score);
    /*
     * 曲线要的那串点：一天一个，`score` 是当天各条的平均（保留一位小数）。
     * 按日期升序 —— 画线的人不该自己再排一次（排错的后果是线倒退着画）。
     */
    const moodSeries = [...dayTone.entries()]
      .map(([date, cell]) => ({ date, score: Math.round((cell.sum / cell.n) * 10) / 10 }))
      .sort((left, right) => left.date.localeCompare(right.date));
    return {
      date,
      month,
      today,
      locked,
      days,
      /*
       * ★ 有哪怕一天解不开，字数就是 `null`（不知道），**不是 0**。
       *   0 是一句确定的话：「这个月一个字都没写」—— 而真实情况是「有几天的锁着，
       *   我没数到」。界面上 `0 字` 与 `—` 是两个完全不同的信息。
       */
      chars: locked ? null : chars,
      streak,
      moods,
      /*
       * 「心绪潮汐」那根线要的料：`[{ date: '2026-10-27', score: 3.5 }]`，一天一个点。
       * 只有**记过心情**的那天才有点 —— 没记心情、或那天解不开，都不落点。
       */
      moodSeries,
      // 点某一档情绪 → 右侧列出本月这一档的全部条目（只有摘要，点一行才回那一天）。
      moodEntries: Object.fromEntries([...byMood.entries()].map(([score, rows]) => [String(score), rows])),
      onThisDay,
      // 没有「往年同日」时这一块的退路：上一次写日记是哪天、写了什么（见上面的注释）。
      lastEntry,
    };
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
  /**
   * 时间轴上一条的投影。
   *
   * ★ 抽出来是因为「时间轴」和「按来源看全部灵感」**必须同形**：客户端把两者塞进
   *   同一个渲染（日期行 → 条目），形状一有偏差，症状是「按来源进来时条目点不动」
   *   这种只存在于一条路径上的毛病 —— 而两边的单测各自都是绿的。
   * ★ `date` 不放进条目：日分组的上层已经有它了（时间轴和按来源都一样）。
   */
  function timelineEntry(scope, index, entry) {
    return {
      scope,
      index,
      time: entry.time,
      kind: entry.kind,
      source: entry.source,
      mood: entry.meta?.mood ?? '',
      // 「灵感流转」的落地证据：在书里按 L 记的灵感带着这三个字段。
      book: entry.meta?.book ?? null,
      chapter: entry.meta?.chapter ?? null,
      page: entry.meta?.page ?? null,
      // 挂在文章上的那一条记的是订阅源里的 key：日记页点一下要能回到那一篇，
      // 而不是把用户丢回「这一天」的日记列表（0.39 之前就是这样）。
      article: entry.meta?.article ?? null,
      tags: parseTags(entry.body),
      preview: entry.body.replace(/\s+/g, ' ').slice(0, 160),
    };
  }

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
      day.entries.push(timelineEntry(scope, index, entry));
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
   * 某一个来源（一本书 / 一篇文章）的**全部**灵感，跨天。
   *
   * ★ 为什么不复用 `timeline({ limit })` 再在客户端筛：时间轴只读最近 N 天
   *   （`TIMELINE_DAY_LIMIT`），于是「这本书 7 条」实际是「最近 30 天里的 7 条」——
   *   一个看起来是全部、其实不全的数字，比不显示更糟。这条必须扫完。
   * ★ `kind !== '读后感'` 与时间轴的取舍**同一条**：灵感模块不看读后感，
   *   否则「这本书的灵感」里会掺进整篇读后感。
   * ★ 只扫公开那半边：私密模块有它自己的一套（加锁、逐条、不外泄），
   *   把它并进这里等于绕过那道闸门。
   * ★ 返回形状与 `timeline()` 的 `days` 完全一致（见 `timelineEntry`）：
   *   客户端拿它直接替换 `timeline.days`，不需要第二套渲染。
   */
  async function bySource(input = {}) {
    const bookId = typeof input.book === 'string' ? input.book.trim() : '';
    const articleKey = typeof input.article === 'string' ? input.article.trim() : '';
    if ((bookId === '') === (articleKey === '')) {
      throw coded('BAD_SOURCE', '按来源查灵感需要且只需要一个 book / article');
    }
    if (bookId !== '' && !/^[A-Za-z0-9_-]{1,64}$/.test(bookId)) {
      throw coded('BAD_BOOK', `无效的书籍 id：${bookId}`);
    }
    if (articleKey !== '' && articleKey.length > 200) {
      throw coded('BAD_ARTICLE', '文章 key 太长');
    }
    const days = new Map();
    const scan = await scanDays(({ date, scope, index, entry }) => {
      if (scope !== 'public') return;
      if (entry.kind === '读后感') return;
      if (bookId !== '' && entry.meta?.book !== bookId) return;
      if (articleKey !== '' && entry.meta?.article !== articleKey) return;
      const day = days.get(date) ?? { date, entries: [] };
      day.entries.push(timelineEntry(scope, index, entry));
      days.set(date, day);
    }, { fileLimit: SOURCE_SCAN_LIMIT });
    const ordered = [...days.values()]
      .sort((left, right) => right.date.localeCompare(left.date))
      .map((day) => ({ ...day, entries: day.entries.sort((left, right) => left.time.localeCompare(right.time)) }));
    const total = ordered.reduce((sum, day) => sum + day.entries.length, 0);
    const result = { days: ordered, total, scanned: scan.scanned, truncated: scan.truncated };
    return result;
  }

  /**
   * 哪些书**写过读后感**，各几篇、最后一篇是哪天（0.48）。
   *
   * ★ 要它是因为侧栏那份名单是「读完的书」，而读后感只写过其中一部分 ——
   *   用户 2026-10-29：「这个列表里都是我已经读完的电子书，混杂了写过读后感和没有
   *   写过读后感的。所以这里，如果写过和没写过读后感是不是要做个区分」。
   *   不先问一遍宿主，界面只能靠「点进去看有没有内容」才知道，而那是逐本读盘。
   * ★ 只扫公开那半边：读后感模块写的是明文，私密是另一个模块。
   * ★ 与 `byBook()` 用同一条判据（`kind === '读后感'` + `meta.book`）：
   *   「灵感流转」也挂 `meta.book`，混进来的话会出现「标着写过、点进去一篇都没有」。
   * ★ 全量扫（`SOURCE_SCAN_LIMIT`），不借用搜索那 400 天：这个数要回答的是
   *   「我一共写过几本书的读后感」，不是「最近一年多里写过几本」。
   */
  async function reflectionIndex() {
    const index = new Map();
    const scan = await scanDays(({ date, entry }) => {
      if (entry.kind !== '读后感') return;
      const id = typeof entry.meta?.book === 'string' ? entry.meta.book.trim() : '';
      if (id === '') return;
      const row = index.get(id) ?? { id, count: 0, first: date, last: date };
      row.count += 1;
      if (date > row.last) row.last = date;
      if (date < row.first) row.first = date;
      index.set(id, row);
    }, { fileLimit: SOURCE_SCAN_LIMIT });
    const books = [...index.values()]
      .sort((left, right) => right.last.localeCompare(left.last) || right.count - left.count);
    const result = {
      books,
      // 书数（不是篇数）：界面上「已写 N」比的是书，混着算会得到一个对不上的数。
      total: books.length,
      entries: books.reduce((sum, row) => sum + row.count, 0),
      scanned: scan.scanned,
      truncated: scan.truncated,
    };
    if (scan.privateError) result.privateError = scan.privateError;
    return result;
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
    /*
     * ★ 「在哪个模块里搜」是作用域，不是排序建议（0.86.0）：
     *   在读后感里搜一本书，返回一堆灵感 —— 用户点进去发现是一句话便签，
     *   那比「没搜到」更让人困惑（他会以为读后感丢了）。
     * ★ 不传 `module` 时**不过滤**：工具（`diary_search`）与老调用点仍能看到全部，
     *   这条默认值是「模型侧不该被界面的选项卡限制」。
     */
    const mod = moduleScope(input.module);
    const hits = [];
    const scan = await scanDays(({ date, scope, index, entry }) => {
      if (mod !== null) {
        // 私密模块只搜私密那半边，公开模块连解密都不该发生（`includePrivate` 由路由层关掉）。
        if (mod.vis === 'private' ? scope !== 'private' : scope !== 'public') return;
        if (mod.vis === 'public' && !inModule(mod, entry)) return;
      }
      // ★ 匹配用的是**剥掉链接地址之后**的正文（0.73.1）。不剥的话，一条贴过图的
      //   灵感会因为正文里含 `![](/api/dsh-npie-reader/diary/assets/3f2a…png)`
      //   而被 `assets`、`api`、`png`、甚至那串哈希本身命中 —— 搜索变成索引噪音。
      //   而用户真正想搜的「图」反而一条也搜不到（正文里没有那个字）。
      const plain = stripInlineTargets(entry.body);
      const hay = `${entry.kind} ${entry.source} ${plain}`.toLowerCase();
      if (!hay.includes(needle)) return;
      hits.push({
        date,
        scope,
        index,
        time: entry.time,
        kind: entry.kind,
        source: entry.source,
        // ★ 摘要必须**在正文自己里**定位（0.73.1）。原来拿 `hay.indexOf(needle)`
        //   的下标去切 `entry.body` —— 那个下标带着 `kind`/`source` 的前缀长度，
        //   一条「读后感 · 《某本书》」就整体偏了七八个字，摘出来的是错的片段。
        snippet: snippetAround(plain, needle, 60),
      });
      if (hits.length >= limit) return false;
    }, { includePrivate: input.includePrivate === true });
    const result = { query: needle, hits: hits.slice(0, limit), scanned: scan.scanned, truncated: scan.truncated };
    if (scan.privateError) result.privateError = scan.privateError;
    return result;
  }

  /**
   * 反向链路计数（0.88.0，跨源检索的「双链」那一半）。
   *
   * 回答的是：「这篇文章 / 这本书下面，我写过几条？」
   *
   * ★ 为什么不是一个 key 一个调用（`bySource({ article: key })` 已经能做这件事）：
   *   那个函数一次扫一遍全部日记。检索结果一屏二十条，二十次调用就是二十遍全扫
   *   （本机 400 个文件 × 20）。这里一次扫完，用两个 Set 匹配 —— 二十次变一次。
   *
   * ★ 只认 `meta.article` / `meta.book`，**不按 `|source|` 那串文字猜**：
   *   书名可以改、文章标题会被截断（`parseSource` 那套是给人看的），
   *   拿它当外键就会漏。两个字段是写日记时确定落下的结构化引用。
   *
   * ★ 私密条目**不算**（`scanDays` 默认不读私密）。与 `bySource` 保持同一条边界：
   *   周报、检索、工具三处口径一致，用户侧的「几条」才对得上。
   *
   * @param {{articleKeys?: string[], bookIds?: string[]}} input
   * @returns `{ articles: { [key]: n }, books: { [bookId]: n }, scanned, truncated }`
   */
  async function linkCounts(input = {}) {
    const articleKeys = new Set((Array.isArray(input.articleKeys) ? input.articleKeys : [])
      .filter((key) => typeof key === 'string' && key !== ''));
    const bookIds = new Set((Array.isArray(input.bookIds) ? input.bookIds : [])
      .filter((id) => typeof id === 'string' && id !== ''));
    const articles = {};
    const books = {};
    if (articleKeys.size === 0 && bookIds.size === 0) {
      return { articles, books, scanned: 0, truncated: false };
    }
    const scan = await scanDays(({ entry }) => {
      const article = entry?.meta?.article;
      if (typeof article === 'string' && articleKeys.has(article)) {
        articles[article] = (articles[article] ?? 0) + 1;
      }
      const book = entry?.meta?.book;
      if (typeof book === 'string' && bookIds.has(book)) {
        books[book] = (books[book] ?? 0) + 1;
      }
    });
    return { articles, books, scanned: scan.scanned, truncated: scan.truncated };
  }

  /**
   * 全部日记正文里出现过的图片名（0.73.1，给 `diaryAssets.prune()` 当白名单）。
   *
   * ★ **只扫公开的 `daily/`**，这是有意的：私密条目禁止贴图（见 `DiaryComposer`
   *   里的说明），且私密正文是加密的，宿主本来也读不出 url。将来若允许私密贴图，
   *   **这里必须一起扫**，否则私密里引用的图会被当成孤儿删掉 —— 那是「图凭空消失」
   *   的经典成因，而且只在用户翻旧私密日记时才发现。
   * ★ 扫文件**原文**而不是 `parseDay()` 的结果：图可能出现在任何位置，而 `parseDay()`
   *   只认 `## HH:MM 类型` 开头的那几块。一份被手动改过、格式不再规整的日记不会
   *   因为这一点就失去保护 —— 宁可多留一张图，不可删掉一张还在用的。
   * ★ 正则限定成 `ASSET_NAME_PATTERN` 的形状（16 位小写十六进制 + 认识的扩展名）：
   *   匹配宽一点不会出事（宽出来的只是「不删」），但两份正则不一致会让「被引用的
   *   那张图」永远对不上号。改任一边都要同时改另一边，判据里有一条对账。
   */
  async function referencedAssets() {
    const names = new Set();
    for (const item of await readDirQuiet(diaryDailyDir())) {
      if (!item.endsWith('.md') || !isValidDateKey(item.slice(0, -3))) continue;
      const text = await readFile(join(diaryDailyDir(), item), 'utf8').catch(() => '');
      for (const hit of text.matchAll(/\/assets\/([a-f0-9]{16}\.(?:png|jpg|gif|webp))/g)) {
        names.add(hit[1]);
      }
    }
    return names;
  }

  /**
   * 导出：`{ files: [{ name, text }], total, entries, skippedPrivate, scope }`。
   *
   * ★ 取消「移入 Obsidian」之后，这是日记**唯一**的出口。没有它，重装 DSH 就是全丢，
   *   而 `~/.dsh/storages/` 不是用户会去翻的地方。
   * ★ 只读、只拼内存里的字符串，不写任何用户目录 —— 落盘由浏览器下载完成。
   * ★ **默认不含私密日记**：导出是往浏览器下载目录里写明文，那正好是加密层要防的
   *   第一件事。要导出私密部分必须显式传 `includePrivate: true`，且由界面把后果
   *   说清楚 —— 不能让一次「点导出」把加密悄悄拆了。
   *
   * ★ `module`（0.86.0）：用户 2026-11-19 的反馈是「明明我切到读后感了，点击下载
   *   下载的还是日记」。这不是文件名写错，是**这条路径没有作用域** —— 它一直导的是
   *   整个 `daily/` 目录。三个模块共用一份 `daily/*.md`，所以「按模块导出」必须
   *   按 `kind` 拆条目重拼：整天原样搬的写法在这里不成立。
   *   · 不传 `module` ⇒ **老行为逐字节不变**（整天文件原样、可逆），工具与老调用点不受影响；
   *   · `inspiration` / `reflection` ⇒ 只留该类的条目，一天没有该类内容就整天不出现
   *     （否则导出里会有「2026-11-11.md」却一个字都没有的块，看起来像那天丢了）；
   *   · `private` ⇒ 只导出私密那半边（解密后一天一份），并**不**夹带公开日记。
   */
  async function exportAll(input = {}) {
    const mod = moduleScope(input.module);
    const files = [];
    let entries = 0;
    /*
     * 公开那半边。灵感与读后感同处 `daily/YYYY-MM-DD.md`，靠标题行的 `kind` 分家
     * （见 `diary-format.js` 的 `ENTRY_LINE`）—— 所以「按模块导出」在这里只能是
     * 按条目重拼，不能整天搬。
     */
    if (mod === null || mod.vis === 'public') {
      const pubNames = (await readDirQuiet(diaryDailyDir()))
        .filter((item) => item.endsWith('.md') && isValidDateKey(item.slice(0, -3)))
        .sort();
      for (const name of pubNames) {
        const text = await readFile(join(diaryDailyDir(), name), 'utf8').catch(() => '');
        if (text === '') continue;
        if (mod === null) {
          // ★ 「全部日记」这条路径**一个字节都不重排**：每块前面那行
          //   `<!-- 2026-10-26.md -->` 说明它原来叫什么文件，用户按注释切回去
          //   就能还原成一天一个 `.md`。重排一次这个性质就没了。
          files.push({ name, text });
          entries += parseDay(text).entries.length;
          continue;
        }
        const key = name.slice(0, -3);
        const kept = parseDay(text).entries.filter((entry) => inModule(mod, entry));
        if (kept.length === 0) continue;
        // 走 `buildDay()` 而不是手拼：条目块（标题行 + 元数据行 + 正文）的排版
        // 只该有一份实现，手拼一份就会和「追加 / 改写」写出的文件长得不一样。
        files.push({ name, text: buildDay(key, kept), count: kept.length });
        entries += kept.length;
      }
    }
    /*
     * 私密那半边。
     *
     * ★ `skippedPrivate` 的两种含义都要如实说，不能混成一个「跳过 N 天」：
     *   · 全部导出时 = 「没勾含私密，所以留在磁盘上的天数」；
     *   · 私密模块时 = 「本该导出、但解不开的天数」（这是**失败**，不是越界）。
     */
    const privNames = (await readDirQuiet(diaryPrivateDir()))
      .filter((item) => item.endsWith('.md.enc') && isValidDateKey(item.slice(0, -7)))
      .sort();
    const wantPrivate = mod === null ? input.includePrivate === true : mod.vis === 'private';
    let skippedPrivate = mod === null && !wantPrivate ? privNames.length : 0;
    if (wantPrivate) {
      for (const name of privNames) {
        const key = name.slice(0, -7);
        try {
          const text = await secret.decrypt(await readFile(join(diaryPrivateDir(), name), 'utf8'));
          files.push({ name: `${key}.private.md`, text });
          entries += parseDay(text).entries.length;
        } catch {
          // 解不开就留在「没导出」的计数里，让界面如实说「有 N 天没导出」。
          skippedPrivate += 1;
        }
      }
    }
    /*
     * `total` 一直是「几天」：界面文案、老调用点都按它写。条数另给 `entries` ——
     * 两者的关系是「N 天 / M 条」，把条数塞进 `total` 会让回执变成一句假话。
     * `scope` 原样回给客户端拼文件名与文案：客户端若自己再抄一份模块表，就会漂。
     */
    const result = { files, total: files.length, entries, skippedPrivate, scope: mod };
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
    removeDay,
    listMonth,
    dashboard,
    search,
    referencedAssets,
    tags,
    timeline,
    byBook,
    bySource,
    linkCounts,
    reflectionIndex,
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
