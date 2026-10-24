/**
 * 「这本书的解读」的磁盘布局与读写。
 *
 * ★ 这一层**完全不碰 `data.json`**，这是刻意的。
 *
 *   `store.js` 的 `flush()` 是**全量重写**：一次调用把整个文档序列化写盘，正文缓存
 *   也在里面。一本 300 页书的抽取文本约 1–2 MB，而阅读器每翻一页都会更新进度 ——
 *   把书正文放进 `data.json`，等于「翻一页重写两兆」。这条教训在本仓库已经记过
 *   （`data.json` 现在 8 MB，里面全是文章正文）。
 *
 *   所以解读产物全部落在 `digests/<bookId>/` 下的独立文件里：翻页不写、只有抽取
 *   和生成才写，而且写的是**单独一个文件**。
 *
 * ── 布局 ────────────────────────────────────────────────────────────────
 *
 *   digests/<bookId>/
 *   ├── meta.json          文件指纹 / 抽取统计 / 分段方式 / 章节状态 / 任务状态
 *   ├── outline.json       章节树（`[{ n, title, startPage, endPage, source }]`）
 *   ├── pages.jsonl        抽取中：每行一页 `{"page":12,"lines":[...]}`（断点续跑靠它）
 *   └── text/ch01.txt …    抽完之后按章切好的原文
 *
 * ★ 为什么抽取中间态用 `jsonl` 而不是 `pages.json`：抽取要**边抽边落盘**（面板一关
 *   就断），而 JSON 数组没法追加 —— 每次都要读出来、push、整个写回去，一本 300 页
 *   的书在抽取过程中要重写几十次。JSONL 是天然追加的，断电最多丢最后一行。
 *
 * ★ 为什么抽完要按章切：生成解读时按章取原文（一次一章），`book_search` 只 grep
 *   需要的章。留一整本的话每次都要在 1 MB 里定位。
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isBookId } from '../library.js';

/** 一本书的解读产物在磁盘上占多少算「过大」—— 只用来在日志里提醒，不做清理。 */
const WARN_BYTES = 200 * 1024 * 1024;

/**
 * 章节状态。
 *
 * ★ **不存在 `digested: true` 这种字段**。19 章挂 1 章、模型漏一章，一个布尔值
 *   完全看不出来 —— 那正是本项目反复踩的「假绿」。整体进度一律由章节聚合出来。
 *
 * ★ `SKIPPED` 不是 `DONE` 的近义词，两者必须分开：
 *   `DONE` 表示「这一章生成过解读」；`SKIPPED` 表示「这一章没有可解读的正文」
 *   （卷标题页只剩两个字、版权页、空白页）。把跳过算成完成，界面上的
 *   「已解读 19/19」就是一句确定的假话。
 */
export const CHAPTER_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  STALE: 'stale',
  SKIPPED: 'skipped',
});

/** 任务状态。`cursor` 是「已经抽到第几页」，断点续跑靠它。 */
export const TASK_STATE = Object.freeze({
  IDLE: 'idle',
  EXTRACTING: 'extracting',
  GENERATING: 'generating',
  FAILED: 'failed',
});

/** 原子写：先写 tmp 再 rename。中途崩了不会留下半个 JSON。 */
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    // 坏掉的 JSON 当「没有」处理，但要让调用方知道 —— 抛出去由上层记日志，
    // 不要静默返回 null（那会让界面显示「还没解读」而磁盘上明明有文件）。
    throw error;
  }
}

/**
 * @param options.rootDir - `digests` 的父目录（一般是 `pluginDataDir()`）。
 */
export function createDigestStore({ rootDir, log = () => {} } = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('digest-store: 需要 rootDir');
  }

  const digestsDir = join(rootDir, 'digests');

  /** 书的目录。**id 必须过 `isBookId`** —— 它是从 HTTP 路径里来的，直接拼路径就是穿越。 */
  function dirOf(bookId) {
    if (!isBookId(bookId)) throw new TypeError(`digest-store: 非法 bookId ${String(bookId)}`);
    return join(digestsDir, bookId);
  }

  async function ensureDir(bookId) {
    const dir = dirOf(bookId);
    await mkdir(join(dir, 'text'), { recursive: true });
    await mkdir(join(dir, 'digest'), { recursive: true });
    return dir;
  }

  async function readMeta(bookId) {
    return readJson(join(dirOf(bookId), 'meta.json'));
  }

  async function writeMeta(bookId, meta) {
    const dir = await ensureDir(bookId);
    await writeJsonAtomic(join(dir, 'meta.json'), meta);
  }

  async function readOutline(bookId) {
    return readJson(join(dirOf(bookId), 'outline.json'));
  }

  async function writeOutline(bookId, chapters) {
    const dir = await ensureDir(bookId);
    await writeJsonAtomic(join(dir, 'outline.json'), chapters);
  }

  /** 追加一批页（抽取过程中调用，每批落一次盘）。 */
  async function appendPages(bookId, pages) {
    if (!Array.isArray(pages) || pages.length === 0) return;
    const dir = await ensureDir(bookId);
    const lines = pages.map(page => JSON.stringify(page)).join('\n');
    await appendFile(join(dir, 'pages.jsonl'), `${lines}\n`, 'utf8');
  }

  /** 读回已抽的全部页（断点续跑 / 抽完之后算章节）。坏行跳过，不让一行毁掉整本。 */
  async function readPages(bookId) {
    let raw;
    try {
      raw = await readFile(join(dirOf(bookId), 'pages.jsonl'), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (text === '') continue;
      try {
        const parsed = JSON.parse(text);
        if (Number.isInteger(parsed?.page) && Array.isArray(parsed?.lines)) out.push(parsed);
      } catch {
        // 最后一行可能写了一半（进程被杀）。跳过它，下一次抽取会重抽这一页。
      }
    }
    out.sort((a, b) => a.page - b.page);
    return out;
  }

  /** 把已抽的页按章节切成 `text/chNN.txt`。`chapters` 的页码区间是闭区间。 */
  async function writeChapterTexts(bookId, pages, chapters) {
    const dir = await ensureDir(bookId);
    const byPage = new Map(pages.map(page => [page.page, page.lines]));
    const written = [];
    for (const chapter of chapters) {
      const lines = [];
      for (let p = chapter.startPage; p <= chapter.endPage; p += 1) {
        const pageLines = byPage.get(p);
        if (pageLines === undefined) continue;
        lines.push(pageLines.join('\n'));
      }
      const name = `ch${String(chapter.n).padStart(2, '0')}.txt`;
      await writeFile(join(dir, 'text', name), lines.join('\n\n'), 'utf8');
      written.push({ n: chapter.n, name, chars: lines.join('').length });
    }
    return written;
  }

  async function readChapterText(bookId, n) {
    const name = `ch${String(n).padStart(2, '0')}.txt`;
    try {
      return await readFile(join(dirOf(bookId), 'text', name), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  // ---- 逐章解读的产物 ---------------------------------------------------
  //
  // 一章一个文件，而不是整本一个 `digests.json`：
  //   ① 生成是**逐章**推进的，写整本意味着每生成一章就重写一遍全书解读；
  //   ② 一章坏了不该牵连别的章 —— 单文件坏掉只丢那一章；
  //   ③ 「点开某章才读」天然对应一个文件，不用把整本读进内存再挑。

  /** 某一章解读文件的路径。**`n` 必须是正整数**，否则 `ch0.txt` / `ch-1.txt` 这种会跑出目录。 */
  function digestFileOf(bookId, n) {
    if (!Number.isInteger(n) || n < 1 || n > 9999) {
      throw new TypeError(`digest-store: 非法章节号 ${String(n)}`);
    }
    return join(dirOf(bookId), 'digest', `ch${String(n).padStart(2, '0')}.json`);
  }

  async function writeDigest(bookId, n, digest) {
    const dir = await ensureDir(bookId);
    await writeJsonAtomic(join(dir, 'digest', `ch${String(n).padStart(2, '0')}.json`), { ...digest, n });
  }

  /** 读一章解读。没有就返回 `null`（**不是**抛错 —— 「还没生成」是正常状态）。 */
  async function readDigest(bookId, n) {
    return readJson(digestFileOf(bookId, n));
  }

  /**
   * 这本书的文件是否换过了。
   *
   * ★ 用 `size + mtimeMs` 而不是内容哈希：后者要读整本（网盘书 = 几十 MB 流量），
   *   而「换文件」这件事在用户侧一定伴随 mtime 变化。代价是「同大小同毫秒的替换」
   *   检测不到 —— 这个概率远低于「为了校验而每次打开书都全量读一遍」的成本。
   */
  async function isStale(bookId, fingerprint) {
    const meta = await readMeta(bookId);
    if (meta === null || meta.fingerprint === undefined || fingerprint === undefined) return false;
    return meta.fingerprint.size !== fingerprint.size || meta.fingerprint.mtimeMs !== fingerprint.mtimeMs;
  }

  /** 整本删掉（换书、或者用户点「重新解读」）。 */
  async function remove(bookId) {
    await rm(dirOf(bookId), { recursive: true, force: true });
  }

  /**
   * 磁盘占用（给设置页显示「解读缓存多大」）。目录不存在返回 0。
   *
   * ★ 必须把 `text/` 与 `digest/` 一起算进来。只算那三个顶层文件会严重低报 ——
   *   一本 800 页书的正文全在 `text/` 里，而它恰恰是这个目录**最大**的部分。
   *   一个低报的「缓存占用」比不显示更糟：用户会据此判断「不用清」。
   */
  async function sizeOf(bookId) {
    let total = 0;
    const dir = dirOf(bookId);
    for (const name of ['meta.json', 'outline.json', 'pages.jsonl', 'ocr.json']) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (info?.isFile()) total += info.size;
    }
    const { readdir } = await import('node:fs/promises');
    for (const sub of ['text', 'digest']) {
      let names;
      try {
        names = await readdir(join(dir, sub));
      } catch {
        continue;
      }
      for (const name of names) {
        const info = await stat(join(dir, sub, name)).catch(() => null);
        if (info?.isFile()) total += info.size;
      }
    }
    return total;
  }

  /** 列已解读的书（给 `book_list` 工具用，不扫全书）。 */
  async function listDigested() {
    let names;
    try {
      const { readdir } = await import('node:fs/promises');
      names = await readdir(digestsDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const name of names) {
      if (!isBookId(name)) continue;
      const meta = await readMeta(name).catch(() => null);
      if (meta === null) continue;
      out.push(meta);
    }
    return out;
  }

  /**
   * 这本书**全部**已解读的章（`Map<n, digest>`）。
   *
   * ★ 只读 `chapters` 里列出的章，不扫目录：目录里可能留着「上次书里有的章」
   *   （换过文件），扫目录会把它们带进导出结果，而 SKILL.md 的章节索引是按
   *   `outline` 生成的 —— 于是索引里没有、包里却有的章，谁都不会去读。
   * ★ 一章读失败不影响别的章（那一章当「未解读」处理）：一本书 19 章里有 1 个
   *   坏文件，不该让整次导出失败。
   */
  async function readAllDigests(bookId, chapters) {
    const out = new Map();
    for (const chapter of Array.isArray(chapters) ? chapters : []) {
      const n = chapter?.n;
      if (!Number.isInteger(n)) continue;
      try {
        const digest = await readDigest(bookId, n);
        if (digest !== null) out.set(n, digest);
      } catch {
        // 坏掉的单个 JSON 当「没有」：导出的其余部分仍然有用。
      }
    }
    return out;
  }

  // ---- 导出的技能包 -----------------------------------------------------
  //
  //   skills/<slug>/
  //   ├── SKILL.md          索引层（始终进上下文）
  //   ├── chapters/chNN.md  按需加载
  //   ├── glossary.md       术语汇总（带章号）
  //   ├── patterns.md       跨章：写法/结构
  //   ├── cheatsheet.md     跨章：速查
  //   └── skill.json        机器可读元数据
  //
  // ★ 放在插件数据目录下，**不往仓库外写**：写 `~/.claude/skills` 之类的位置
  //   属于「用户机器上的别的东西」，那要用户点头（本项目红线）。界面上把绝对路径
  //   显示出来，用户自己拷过去。
  // ★ 目录名只允许 `[a-z0-9-]`：它来自书名，而书名里可能有 `/`、空格、引号。
  //   不校验就是一次路径穿越（`../../`），和 `isBookId` 是同一类闸。

  const skillsDir = join(rootDir, 'skills');

  function skillDirOf(slug) {
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      throw new TypeError(`digest-store: 非法 skill 名 ${String(slug)}`);
    }
    return join(skillsDir, slug);
  }

  /**
   * 写一整套技能包。**先删旧目录再写** —— 否则上一次导出的
   * `chapters/ch20.md` 会在这次（只剩 18 章）之后留在包里，
   * 而 `SKILL.md` 的索引里没有它，agent 也不会去读它：一个只增不减的包里
   * 藏着上次的残骸，最坏的情况是「同一本书两个版本的解读混在一起」。
   */
  async function writeSkill(slug, files) {
    const dir = skillDirOf(slug);
    await rm(dir, { recursive: true, force: true });
    let bytes = 0;
    for (const [relative, content] of files) {
      // 相对路径也要过一遍：`chapters/ch01.md` 允许，`../x` 不允许。
      if (typeof relative !== 'string' || relative.includes('..') || relative.startsWith('/')) {
        throw new TypeError(`digest-store: 非法相对路径 ${String(relative)}`);
      }
      const target = join(dir, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      bytes += Buffer.byteLength(content, 'utf8');
    }
    return { dir, bytes };
  }

  /** 读一个已导出的 skill 的元数据（界面上「上次导出」那一行）。没有就返回 `null`。 */
  async function readSkill(slug) {
    return readJson(join(skillDirOf(slug), 'skill.json'));
  }

  /**
   * 包内清单：每个文件的相对路径 / 字节 / 行数。目录不存在返回 `null`。
   *
   * ★ 为什么由宿主算、而不是让界面按 `skill.json` 里的 `chapters[].file` 去推：
   *   ① 行数**必须读文件**，界面拿不到；
   *   ② `skill.json` 只记章节文件，`SKILL.md` / `glossary.md` / `patterns.md` /
   *      `cheatsheet.md` 都不在里面 —— 而 `SKILL.md` 恰恰是**每次都进上下文**的那一份，
   *      它的体积才是用户真正在意的数字。
   * ★ 真读盘而不是记在 `skill.json` 里：这样**旧包**（这个版本之前导出的）也有清单，
   *   不必让用户为了看一眼体积而重新导出一次。
   * ★ 只读，不写、不删。读不出来的文件直接跳过（不抛）—— 这一层是信息展示，
   *   不该因为一个权限问题把整个状态查询变成红字。
   */
  async function skillFiles(slug) {
    const dir = skillDirOf(slug);
    const out = [];
    async function walk(relative) {
      const entries = await readdir(join(dir, relative), { withFileTypes: true }).catch(() => null);
      if (entries === null) return;
      for (const entry of entries) {
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile()) continue;
        const text = await readFile(join(dir, path), 'utf8').catch(() => null);
        if (text === null) continue;
        // 末尾换行不算一行：`a\n` 是 1 行，不是 2 行。
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        out.push({ path, bytes: Buffer.byteLength(text, 'utf8'), lines });
      }
    }
    await walk('');
    if (out.length === 0) return null;
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /**
   * 扫描页的 OCR 文本（`ocr.json`，一页一条）。
   *
   * ★ 为什么单独一个文件、**不往 `pages.jsonl` 里追加**：那个文件是**抽取任务的
   *   断点续跑凭据**（`meta.task.cursor` 按它前进），而 OCR 是一页一页随手发生的。
   *   往里插一条会让「已抽多少页」与「cursor 走到哪」对不上；而重写整个文件又要与
   *   正在跑的抽取抢同一个文件。两件事的写入者不同、生命周期不同，就放两个文件。
   * ★ 上限 3000 页：一页中文正文约 1–2 KB，3000 页约 3–6 MB，比 `data.json` 小一个
   *   量级；超出时按 `at` 淘汰最旧的 —— 不设上限的话，长年累月会变成第二个
   *   「8 MB 的单文件」。
   */
  const OCR_PAGE_LIMIT = 3000;

  function ocrFileOf(bookId) {
    return join(dirOf(bookId), 'ocr.json');
  }

  async function readOcr(bookId) {
    /**
     * ★ 这里**故意**与 `readMeta` / `readOutline` 不同：那两个是「事实」，坏了必须
     *   抛出去让人知道；而 `ocr.json` 是**缓存** —— 它的内容随时可以从书上重算。
     *   如果这里跟着抛，一次半截写入（进程被杀、磁盘满）就会让这一页**永远**识别
     *   不了：读要抛（界面当没识别过）、写也要抛（因为 `putOcrPage` 先读后写）
     *   ⇒ 用户点多少次「识别这一页」都只会得到同一个 500，只能自己去删文件。
     *   所以坏文件当空、记一条日志，下一次写入自然把它覆盖成好的。
     */
    let value;
    try {
      value = await readJson(ocrFileOf(bookId));
    } catch (error) {
      log(`digest-store: ocr.json 解析失败，当作空缓存（下次写入会覆盖）：${error.message}`);
      return {};
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const page = Number(key);
      if (!Number.isInteger(page) || page < 1) continue;
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.text !== 'string') continue;
      out[page] = { text: entry.text, at: Number(entry.at) || 0, ms: Number(entry.ms) || 0 };
    }
    return out;
  }

  /** 读某一页的 OCR 文本；没有就是 `''`（不是 `undefined` —— 调用方只需要「有没有字」）。 */
  async function readOcrPage(bookId, page) {
    const all = await readOcr(bookId);
    return all[page]?.text ?? '';
  }

  /**
   * 写入一页的 OCR 文本。
   *
   * ★ 空文本**不写**：OCR 一个字都没认出来时，写进去等于把「这一页没有文字」
   *   永久钉死 —— 而它可能只是这一版模型没认出来，换个 DPI 重试就好了。
   *   不写的话，下次点「识别这一页」会真的重试。
   */
  async function putOcrPage(bookId, page, { text, ms = 0, at = Date.now() }) {
    if (!Number.isInteger(page) || page < 1) throw new TypeError('digest-store: page 必须是正整数');
    if (typeof text !== 'string') throw new TypeError('digest-store: OCR 文本必须是字符串');
    if (text.trim() === '') return { written: false, pages: 0 };
    await ensureDir(bookId);
    const all = await readOcr(bookId);
    all[page] = { text, at, ms };
    const pages = Object.keys(all).map(Number);
    if (pages.length > OCR_PAGE_LIMIT) {
      const keep = pages
        .map((n) => ({ n, at: all[n].at }))
        .sort((a, b) => b.at - a.at)
        .slice(0, OCR_PAGE_LIMIT);
      const next = {};
      for (const { n } of keep) next[n] = all[n];
      await writeJsonAtomic(ocrFileOf(bookId), next);
      return { written: true, pages: OCR_PAGE_LIMIT };
    }
    await writeJsonAtomic(ocrFileOf(bookId), all);
    return { written: true, pages: pages.length };
  }

  return {
    digestsDir,
    skillsDir,
    dirOf,
    ensureDir,
    readMeta,
    writeMeta,
    readOutline,
    writeOutline,
    appendPages,
    readPages,
    ocrFileOf,
    readOcr,
    readOcrPage,
    putOcrPage,
    writeChapterTexts,
    readChapterText,
    digestFileOf,
    writeDigest,
    readDigest,
    readAllDigests,
    skillDirOf,
    writeSkill,
    readSkill,
    skillFiles,
    isStale,
    remove,
    sizeOf,
    listDigested,
    warnBytes: WARN_BYTES,
    log,
  };
}
