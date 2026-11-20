/**
 * 单集字幕的磁盘布局与读写。
 *
 * ★ **完全不碰 `data.json`**，理由与 `digest-store.js` 开头那段完全一样（不再重复
 *   论证，只记结论）：`store.js` 的 `flush()` 是整份重写，而字幕是「一集 1500 条
 *   cue、约 200 KB」的量级；把它塞进 `data.json`，等于每听一分钟就重写几兆。
 *
 * ── 布局 ────────────────────────────────────────────────────────────────
 *
 *   transcripts/
 *   ├── 7f3ab9…12cd.json         一集一个字幕文件（英文原文）
 *   ├── 7f3ab9…12cd.zh-CN.json   同一集的中文译文
 *   └── …
 *
 * ★ 文件名是**文章 key 的 sha256 前 32 位**，不是 key 本身：key 里可能有 `/`、`:`、
 *   甚至 emoji（`feed:<hash>` 之外，导入的文章 key 由标题派生）。直接把 key 当文件名
 *   在这台 macOS 上勉强能跑，换一台就变成「文件写不进去」。
 * ★ 文件里仍然保留 `key` 字段：哈希碰撞（32 位十六进制 ≈ 128 bit，概率可忽略，但
 *   「可忽略」不等于「不存在」）与改名都要靠它自证。读的时候 key 不匹配就当没有，
 *   宁可重抓一次，也不要把别人的字幕挂到这一集上。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TRANSCRIPT_LIMITS } from '../transcript.js';
import { guardFs } from './disk-errors.js';

/** 落盘格式的版本。合并规则或字段一变就抬它，旧缓存自然作废（读的时候版本不符当没有）。 */
export const TRANSCRIPT_STORE_VERSION = 1;

/** 译文缓存版本（与字幕缓存独立：改提示词不用把字幕也重抓一遍）。 */
export const TRANSCRIPT_TRANSLATION_VERSION = 1;

/**
 * 「AI 导读」缓存版本（0.84.0）。
 *
 * ★ 也独立：导读吃的是**字幕段落**，提示词或输出形状一改，旧导读的时间戳就可能
 *   指错位置。版本一抬，旧文件读的时候当没有，下次点「生成导读」重新出 ——
 *   不会出现「点时间戳跳到一句毫不相干的话」。
 */
export const TRANSCRIPT_DIGEST_VERSION = 1;

/** 译文目标语言。目前只有中文；写成常量是为了让文件名自证，不要靠猜。 */
export const TRANSLATION_TARGET = 'zh-CN';

/** 原子写：先 tmp 再 rename。中途崩了不会留下半个 JSON。 */
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await guardFs(async () => {
    await writeFile(tmp, JSON.stringify(value), 'utf8');
    await rename(tmp, path);
  }, '字幕');
}

/**
 * @param {object} options
 * @param {string} options.rootDir - 插件数据目录（`pluginDataDir()`）。
 * @param {(message: string) => void} [options.log]
 */
export function createTranscriptStore({ rootDir, log = () => {} } = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') {
    throw new TypeError('transcript-store: 需要 rootDir');
  }
  const dir = join(rootDir, 'transcripts');

  const fileOf = (key) => join(dir, `${createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 32)}.json`);
  const translationFileOf = (key) => fileOf(key).replace(/\.json$/, `.${TRANSLATION_TARGET}.json`);
  const digestFileOf = (key) => fileOf(key).replace(/\.json$/, '.digest.json');

  return {
    dir,

    /**
     * 读一集的字幕。
     *
     * ★ 坏 JSON / 版本不符 / key 不符一律当「没有」，并记一行日志 —— 不抛错。
     *   抛错的后果是「点开这一集就报错」，而用户对此毫无办法（他既不知道文件在哪，
     *   也不知道该删什么）。当成没有，下一次抓取自然会把它覆盖成好的。
     */
    async read(key) {
      const path = fileOf(key);
      let raw;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        log(`[字幕] ${key} 的缓存不是合法 JSON，按没有处理`);
        return null;
      }
      if (data?.version !== TRANSCRIPT_STORE_VERSION || data?.key !== key) {
        log(`[字幕] ${key} 的缓存版本或 key 不匹配，按没有处理`);
        return null;
      }
      if (!Array.isArray(data.segments) || data.segments.length === 0) return null;
      return {
        key,
        source: typeof data.source === 'object' && data.source !== null ? data.source : {},
        format: typeof data.format === 'string' ? data.format : '',
        fetchedAt: Number.isFinite(data.fetchedAt) ? data.fetchedAt : 0,
        segments: data.segments,
      };
    },

    /** 写一集的字幕。`segments` 必须已经过 `normalizeSegments`（调用方负责）。 */
    async write(key, { segments, source = {}, format = '' }) {
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new TypeError('transcript-store: 没有可写的字幕条目');
      }
      const payload = {
        version: TRANSCRIPT_STORE_VERSION,
        key,
        source,
        format,
        fetchedAt: Date.now(),
        segments,
      };
      const serialized = JSON.stringify(payload);
      if (serialized.length > TRANSCRIPT_LIMITS.maxBytes) {
        throw new Error('这集字幕超过了单集上限，没有保存');
      }
      await guardFs(async () => { await mkdir(dir, { recursive: true }); }, '字幕');
      await writeJsonAtomic(fileOf(key), payload);
      /**
       * 返回**完整记录**（含 `segments` 数组），不是一份统计摘要。
       *
       * ★ 调用方（`fetchTranscriptRecord`）拿到之后要直接交给 `transcriptView` 去切段。
       *   返回 `{ segments: 1500 }` 这种摘要时，`paragraphize(1500)` 得到空数组 ——
       *   界面显示「有字幕但 0 段」，而写入完全成功、没有任何报错。
       */
      return { ...payload, bytes: serialized.length };
    },

    /**
     * 读一集的中文译文。
     *
     * ★ 与字幕**分开两个文件**：重新获取字幕（`refresh`）不该把花过钱的译文一起丢掉，
     *   反过来「重译」也不该逼用户重抓一次字幕。两者唯一的联系是 `sourceHash` ——
     *   字幕真的变了（源站换了转写文本）时，译文必须作废，否则时间轴对不上原文。
     * ★ `sourceHash` 由调用方算（`paragraphs` 拼串的 sha256）。这里不重算：
     *   「哪一串英文对应这 120 段」只有切段那一步知道。
     */
    async readTranslation(key) {
      const path = translationFileOf(key);
      let raw;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        log(`[字幕] ${key} 的译文缓存不是合法 JSON，按没有处理`);
        return null;
      }
      if (data?.version !== TRANSCRIPT_TRANSLATION_VERSION || data?.key !== key) {
        log(`[字幕] ${key} 的译文缓存版本或 key 不匹配，按没有处理`);
        return null;
      }
      if (!Array.isArray(data.translations)) return null;
      return {
        key,
        sourceHash: typeof data.sourceHash === 'string' ? data.sourceHash : '',
        model: typeof data.model === 'string' ? data.model : '',
        // 0.84.0：这批译文是谁翻的（`google` / 模型名）。空串 = 旧缓存，界面按模型名说。
        via: typeof data.via === 'string' ? data.via : '',
        target: typeof data.target === 'string' ? data.target : TRANSLATION_TARGET,
        updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
        translations: data.translations.map((text) => (typeof text === 'string' ? text : '')),
      };
    },

    /**
     * 写一集的中文译文（可写**部分**：逐批翻、逐批落，中途关掉不白花钱）。
     *
     * ★ 不校验 `translations.length` 是否等于段数：调用方在逐批追加，写到一半时
     *   本来就短于段数；「够不够」这件事由读的人拿 `sourceHash` 与段数一起判。
     */
    async writeTranslation(key, { translations, sourceHash = '', model = '', via = '' } = {}) {
      if (!Array.isArray(translations)) {
        throw new TypeError('transcript-store: translations 需要是数组');
      }
      const payload = {
        version: TRANSCRIPT_TRANSLATION_VERSION,
        key,
        target: TRANSLATION_TARGET,
        sourceHash,
        model,
        via,
        updatedAt: Date.now(),
        translations: translations.map((text) => (typeof text === 'string' ? text : '')),
      };
      await guardFs(async () => { await mkdir(dir, { recursive: true }); }, '字幕');
      await writeJsonAtomic(translationFileOf(key), payload);
      return payload;
    },

    /**
     * 读一集的 AI 导读（0.84.0）。
     *
     * ★ 与译文一样按 `sourceHash` 判新旧：字幕换了（重新识别 / 源站换了转写），
     *   旧导读里的时间戳与章节就会指到别的话上 —— 那种错在界面上看不出来，
     *   只有点下去才发现「跳到了不相干的地方」。
     */
    async readDigest(key) {
      const path = digestFileOf(key);
      let raw;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        log(`[导读] ${key} 的导读缓存不是合法 JSON，按没有处理`);
        return null;
      }
      if (data?.version !== TRANSCRIPT_DIGEST_VERSION || data?.key !== key || typeof data?.digest !== 'object') {
        return null;
      }
      return {
        key,
        sourceHash: typeof data.sourceHash === 'string' ? data.sourceHash : '',
        model: typeof data.model === 'string' ? data.model : '',
        updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
        digest: data.digest,
      };
    },

    /** 写一集的 AI 导读。形状由 `episode-digest.js` 的解析函数保证。 */
    async writeDigest(key, { digest, sourceHash = '', model = '' } = {}) {
      if (typeof digest !== 'object' || digest === null) {
        throw new TypeError('transcript-store: digest 需要是对象');
      }
      const payload = {
        version: TRANSCRIPT_DIGEST_VERSION,
        key,
        sourceHash,
        model,
        updatedAt: Date.now(),
        digest,
      };
      await guardFs(async () => { await mkdir(dir, { recursive: true }); }, '字幕');
      await writeJsonAtomic(digestFileOf(key), payload);
      return payload;
    },

    /**
     * 占用统计。
     *
     * ★ 给设置页的「存储」卡用：字幕是本插件**新开的一类缓存**，看不见占用就意味着
     *   某天用户发现磁盘少了几百兆却找不到出处。
     */
    async usage() {
      let names;
      try {
        names = await readdir(dir);
      } catch (error) {
        if (error?.code === 'ENOENT') return { files: 0, bytes: 0 };
        throw error;
      }
      let bytes = 0;
      let files = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const info = await stat(join(dir, name));
          if (info.isFile()) {
            files += 1;
            bytes += info.size;
          }
        } catch {
          // 并发清理时文件会边数边消失，跳过即可（这类统计不需要精确到字节）。
        }
      }
      return { files, bytes };
    },
  };
}
