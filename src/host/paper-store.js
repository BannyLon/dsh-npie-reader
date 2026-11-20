/**
 * 论文库的落盘层：一份 `papers.json` + 一个 `papers/` 目录（每篇一个 PDF）。
 *
 * 为什么**单独一份文件**、不并进 `data.json`：`data.json` 是「去抖 500ms 全量重写」
 * 的，里面装的是进度、已读、正文缓存这类高频小数据。论文条目带摘要与作者列表，
 * 几百篇就是几百 KB —— 并进去等于「每翻一页都重写整个论文库」。
 *
 * ★ 与书单（`lists/`）的区别是**可再生性**：书单是从用户目录扫描出来的，删了能再扫；
 *   论文是用户自己攒的（下载的 PDF、打的标签、写下的笔记关联），删了不可再生。
 *   所以这里的写盘策略偏保守：**坏文件绝不覆盖**（照 `RssStore` 那条规矩）。
 *
 * ★ 读 PDF 字节**不在这里分片**（`readRange` 只是按闭区间读一段）：Range 语义、
 *   `Content-Range` 拼装都在 `library-routes.js` 那一层，两边各写一份必然漂移。
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { guardFs } from './disk-errors.js';
import { isPaperId, paperIdFromKey } from '../library.js';
import { paperIndexPath, papersDir } from './store.js';

/** 条目总数上限。挡的是畸形数据把内存撑爆，不是「不让你存」。 */
const MAX_PAPERS = 4000;
/** 单篇标签数 / 单个标签长度。 */
const MAX_TAGS = 24;
const MAX_TAG_LEN = 24;
/** 摘要上限（字符）。arXiv 摘要实测 1–2 KB，2 万字足够兜住任何离谱输入。 */
const MAX_ABSTRACT = 20_000;
const MAX_TITLE = 400;
const MAX_AUTHORS = 40;

/** 允许被 `patch` 改的字段。**白名单**，不是黑名单。 */
const PATCHABLE = new Set(['title', 'tags', 'status', 'lastPage', 'pages', 'venue', 'year', 'abstract', 'note']);

const STATUSES = ['new', 'reading', 'done'];

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // 折叠所有空白：arXiv 的 `<title>` 在 Atom 里是**折行**的，不折叠会在界面上
  // 出现「Attention Is\nAll You Need」这种断行。
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function cleanAuthors(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    // 允许 `{name}` 与裸字符串两种形态：arXiv/Crossref 解析出来是对象，
    // 手改过的数据可能是字符串。
    const name = cleanText(typeof item === 'string' ? item : item?.name, 120);
    if (name === '') continue;
    out.push(name);
    if (out.length >= MAX_AUTHORS) break;
  }
  return out;
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const tag = cleanText(item, MAX_TAG_LEN);
    if (tag === '') continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function cleanYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : 0;
}

function cleanStatus(value, fallback = 'new') {
  return STATUSES.includes(value) ? value : fallback;
}

/** 把一条来路不明的记录归一成界面能直接用的形状。坏字段一律**降级**，不抛。 */
function normalizePaper(raw, id) {
  if (raw === null || typeof raw !== 'object') return null;
  const key = cleanText(raw.key, 300);
  if (key === '') return null;
  const file = raw.file !== null && typeof raw.file === 'object' && Number(raw.file.bytes) > 0
    ? {
      name: cleanText(raw.file.name, 200) || `${id}.pdf`,
      bytes: Math.max(0, Math.trunc(Number(raw.file.bytes))),
      savedAt: Number(raw.file.savedAt) || 0,
    }
    : null;
  return {
    id,
    key,
    source: cleanText(raw.source, 16) || 'manual',
    title: cleanText(raw.title, MAX_TITLE) || '未命名论文',
    authors: cleanAuthors(raw.authors),
    abstract: cleanText(raw.abstract, MAX_ABSTRACT),
    year: cleanYear(raw.year),
    venue: cleanText(raw.venue, 200),
    doi: cleanText(raw.doi, 200),
    arxivId: cleanText(raw.arxivId, 60),
    categories: cleanTags(raw.categories),
    url: cleanText(raw.url, 600),
    pdfUrl: cleanText(raw.pdfUrl, 600),
    tags: cleanTags(raw.tags),
    status: cleanStatus(raw.status),
    lastPage: Number.isInteger(raw.lastPage) && raw.lastPage > 0 ? raw.lastPage : 0,
    pages: Number.isInteger(raw.pages) && raw.pages > 0 ? raw.pages : 0,
    note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_ABSTRACT) : '',
    addedAt: Number(raw.addedAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || 0,
    trashedAt: Number(raw.trashedAt) || 0,
    file,
  };
}

export class PaperStore {
  /**
   * @param {{ path?: string, dir?: string, log?: (message: string) => void }} [options]
   *   `path` / `dir` 只给测试注入用；生产走 `store.js` 那两个解析函数。
   */
  constructor({ path, dir, log = () => {} } = {}) {
    this.path = path ?? paperIndexPath();
    this.dir = dir ?? papersDir();
    this.log = log;
    this.data = { version: 1, papers: {} };
    this.saving = Promise.resolve();
    /** 读不出来时置位 ⇒ 此后**一律拒绝写盘**（理由同 `RssStore.corrupt`）。 */
    this.corrupt = false;
    this.ready = this.load();
  }

  /**
   * 从盘上读回来。
   *
   * ★★ **合并，不覆盖** ★★：`ready` 是构造期就发起、调用方不一定等过的（`service.ready`
   *   只等 `data.json`，论文库这条是独立的一条）。如果导入发生在读盘完成之前，写进
   *   `this.data.papers` 的那条会被这里 `this.data = { papers }` 整体抹掉 —— 症状是
   *   「明明提示导入成功，列表里没有 / 立刻点开说没有这篇论文」，且只在冷启动后第一次
   *   操作时出现（并发跑测试时尤其容易撞上）。所以这里以**内存里已有的为准**合并。
   *   写方法还会 `await this.ready`（见下），两层都挡住才不缺。
   */
  async load() {
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // 盘上没有：保留内存里可能已经写进来的条目，不要重置成空。
        this.data = { version: 1, papers: { ...this.data.papers } };
        return this.data;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // 坏 JSON：**不覆盖**。留一次取证副本，然后让状态停在「只读」。
      // 用户还能自己打开那个文件抢救；我们这边只是新导入的论文暂时存不进去。
      this.corrupt = true;
      const copy = `${this.path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await writeFile(copy, raw, { encoding: 'utf8', mode: 0o600 }).catch(() => {});
      this.log(`[论文] papers.json 读不出来（${error.message}），已留副本 ${copy}；本次运行不写盘`);
      this.data = { version: 1, papers: { ...this.data.papers } };
      return this.data;
    }
    const papers = {};
    for (const [id, value] of Object.entries(parsed?.papers ?? {})) {
      if (!isPaperId(id)) continue;
      const paper = normalizePaper(value, id);
      if (paper !== null) papers[id] = paper;
    }
    this.data = { version: 1, papers: { ...papers, ...this.data.papers } };
    return this.data;
  }

  /** 原子写：临时文件 + rename，串行。 */
  async save() {
    if (this.corrupt) return this.data;
    this.saving = this.saving.catch(() => {}).then(async () => {
      await guardFs(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const temp = `${this.path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.path);
      }, '论文库');
    });
    return this.saving;
  }

  // ---- 读 -----------------------------------------------------------------

  /** 全部条目（默认不含回收站），按「最近加入」在前。 */
  list({ includeTrashed = false } = {}) {
    const out = [];
    for (const paper of Object.values(this.data.papers)) {
      if (!includeTrashed && paper.trashedAt > 0) continue;
      out.push(paper);
    }
    out.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    return out;
  }

  get(id) {
    return isPaperId(id) ? this.data.papers[id] : undefined;
  }

  findByKey(key) {
    const text = String(key ?? '');
    if (text === '') return undefined;
    return Object.values(this.data.papers).find((paper) => paper.key === text && paper.trashedAt === 0);
  }

  /** 标签及其篇数（只数未进回收站的）。 */
  tags() {
    const counts = new Map();
    for (const paper of this.list()) {
      for (const tag of paper.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
      .map(([name, count]) => ({ name, count }));
  }

  // ---- 写 -----------------------------------------------------------------

  /**
   * 按 `key` 去重写入：同一条 arXiv 导入两次**更新**原来那条，不新增。
   *
   * @returns {Promise<{ paper: object, created: boolean }>}
   */
  async upsert(draft) {
    // 读盘没完成就写会与 `load()` 抢 `this.data` —— 先等它（理由见 `load()` 上面那段）。
    await this.ready.catch(() => {});
    const key = cleanText(draft?.key, 300);
    if (key === '') throw new Error('论文缺少稳定键（key），无法去重入库');
    const existing = this.findByKey(key);
    const now = Date.now();
    if (existing !== undefined) {
      // 只补**空字段**，不覆盖用户可能改过的标题/标签/状态。
      const merged = { ...existing, updatedAt: now };
      for (const field of ['title', 'abstract', 'venue', 'doi', 'arxivId', 'url', 'pdfUrl']) {
        if (!existing[field] && draft[field]) merged[field] = cleanText(draft[field], field === 'abstract' ? MAX_ABSTRACT : 600);
      }
      if (existing.authors.length === 0) merged.authors = cleanAuthors(draft.authors);
      if (existing.year === 0) merged.year = cleanYear(draft.year);
      if (existing.categories.length === 0) merged.categories = cleanTags(draft.categories);
      if (existing.trashedAt > 0) merged.trashedAt = 0; // 重新导入 = 从回收站拉回来
      this.data.papers[merged.id] = merged;
      await this.save();
      return { paper: merged, created: false };
    }
    if (Object.keys(this.data.papers).length >= MAX_PAPERS) {
      throw new Error(`论文库已到上限（${MAX_PAPERS} 篇），先清理回收站再导入`);
    }
    let id = paperIdFromKey(key);
    // 哈希撞了就换一个后缀，**不要**静默合并成一条（那会让两篇不同的论文互相覆盖）。
    for (let n = 1; this.data.papers[id] !== undefined; n += 1) {
      id = paperIdFromKey(key) + n.toString(36);
      if (n > 64) throw new Error('论文 id 分配失败（哈希冲突过多）');
    }
    const paper = normalizePaper({
      ...draft,
      key,
      addedAt: now,
      updatedAt: now,
      status: 'new',
      lastPage: 0,
      file: null,
    }, id);
    if (paper === null) throw new Error('论文条目形状不合法');
    this.data.papers[id] = paper;
    await this.save();
    return { paper, created: true };
  }

  /** 改一条（标签 / 状态 / 进度 / 手工补的元数据）。白名单之外一律忽略。 */
  async patch(id, patch = {}) {
    await this.ready.catch(() => {});
    const paper = this.get(id);
    if (paper === undefined) throw new Error(`没有这篇论文：${String(id)}`);
    const next = { ...paper, updatedAt: Date.now() };
    for (const [field, value] of Object.entries(patch)) {
      if (!PATCHABLE.has(field)) continue;
      if (field === 'tags') next.tags = cleanTags(value);
      else if (field === 'status') next.status = cleanStatus(value, paper.status);
      else if (field === 'lastPage' || field === 'pages') {
        const number = Number(value);
        next[field] = Number.isInteger(number) && number > 0 ? number : 0;
      } else if (field === 'year') next.year = cleanYear(value);
      else if (field === 'note') next.note = typeof value === 'string' ? value.slice(0, MAX_ABSTRACT) : '';
      else next[field] = cleanText(value, field === 'abstract' ? MAX_ABSTRACT : MAX_TITLE);
    }
    this.data.papers[id] = next;
    await this.save();
    return next;
  }

  /** 移入回收站（可撤销）。PDF **不删** —— 单篇 5–30 MB，删了就要重新下载。 */
  async trash(id) {
    await this.ready.catch(() => {});
    const paper = this.get(id);
    if (paper === undefined) throw new Error(`没有这篇论文：${String(id)}`);
    if (paper.trashedAt > 0) return paper;
    const next = { ...paper, trashedAt: Date.now() };
    this.data.papers[id] = next;
    await this.save();
    return next;
  }

  async restore(id) {
    await this.ready.catch(() => {});
    const paper = this.get(id);
    if (paper === undefined) throw new Error(`没有这篇论文：${String(id)}`);
    if (paper.trashedAt === 0) return paper;
    const next = { ...paper, trashedAt: 0 };
    this.data.papers[id] = next;
    await this.save();
    return next;
  }

  /**
   * 彻底删除：条目 + PDF。
   *
   * ★ 只允许删**回收站里的**：用户点「清空回收站」时才会走到这里，
   *   而列表页上的删除动作永远是 `trash()`。多一道判定，`rm` 就不可能从
   *   一个误传的 id 上把还在读的论文的 PDF 删掉。
   */
  async remove(id) {
    await this.ready.catch(() => {});
    const paper = this.get(id);
    if (paper === undefined) return false;
    if (paper.trashedAt === 0) throw new Error('论文还在库里，先移入回收站');
    delete this.data.papers[id];
    await this.save();
    await rm(this.pdfPath(id), { force: true }).catch(() => {});
    return true;
  }

  // ---- PDF 文件 -----------------------------------------------------------

  pdfPath(id) {
    if (!isPaperId(id)) throw new Error(`论文 id 不合法：${String(id)}`);
    return join(this.dir, `${id}.pdf`);
  }

  /**
   * 存一份 PDF。
   *
   * ★ 先写临时名再 rename：写到一半断电/磁盘满时，`papers/<id>.pdf` 要么是完整的
   *   新文件、要么是完整的旧文件 —— 不会是「半份 PDF」。半份 PDF 的表现是
   *   pdf.js 报解析错误，而用户会以为文件本来就是坏的。
   */
  async putPdf(id, buffer, { name = '' } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('PDF 内容是空的');
    await this.ready.catch(() => {});
    const target = this.pdfPath(id);
    await guardFs(async () => {
      await mkdir(this.dir, { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, buffer, { mode: 0o600 });
      await rename(temp, target);
    }, '论文 PDF');
    const paper = this.get(id);
    if (paper === undefined) throw new Error(`没有这篇论文：${String(id)}`);
    const next = {
      ...paper,
      updatedAt: Date.now(),
      file: { name: cleanText(name, 200) || `${id}.pdf`, bytes: buffer.length, savedAt: Date.now() },
    };
    this.data.papers[id] = next;
    await this.save();
    return next;
  }

  /** 文件在不在、多大。`undefined` = 记录里有 file 但磁盘上没了（被手工删过）。 */
  async statPdf(id) {
    try {
      const info = await stat(this.pdfPath(id));
      return info.isFile() ? { bytes: info.size } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 读 `[start, end]`（**闭区间**）。
   *
   * 闭区间是 `library-routes.js` 那条 Range 通道的约定（它自己 `+1` 转开区间），
   * 这里跟着它，少一层 ±1 换算就少一处偏移错误。
   */
  async readRange(id, start, end) {
    const path = this.pdfPath(id);
    const begin = Math.max(0, Math.trunc(Number(start)));
    const finish = Math.max(begin, Math.trunc(Number(end)));
    const length = finish - begin + 1;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, begin);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}

export { MAX_PAPERS, MAX_TAGS, PATCHABLE, normalizePaper };
