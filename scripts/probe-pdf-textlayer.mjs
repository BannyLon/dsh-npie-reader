#!/usr/bin/env node
/**
 * 探测「这本书有没有文字层」—— 不 OCR、不打开阅读器，只读 PDF 字节。
 *
 * 为什么需要它：扫描版的书在阅读器里看着**完全正常**（页面就是图），但目录/解读永远
 * 抽不出字。用户手上往往有同一本书的多个版本（同一本《散文诗》就有 5 个译本），
 * 到底哪个是文字版，只能一个一个试 —— 试一次就要下载 + 打开，很笨。
 * 这个脚本直接看 PDF 的结构：**有字体对象 ⇒ 有文字层；只有图 ⇒ 扫描版**。
 *
 * 判据（三条，宁可不结论也不给错结论）：
 *   - 出现 `/Type /Font` 或 `/ToUnicode` ⇒ **有文字层**（可抽取）；
 *   - 没有字体、但有 `/Subtype /Image` ⇒ **扫描版**（要 OCR）；
 *   - 两者都没有、却出现 `/ObjStm`（对象流压缩）⇒ **看不清** —— 字体表被压进对象流里，
 *     纯字节扫描看不见它。这种必须真打开一次才知道，不许猜。
 *
 * 运行：
 *   node scripts/probe-pdf-textlayer.mjs                 # 探书单里所有 pdf（很慢，慎用）
 *   node scripts/probe-pdf-textlayer.mjs p1c53 pa92e     # 只探这几本（按 id 前缀）
 *   node scripts/probe-pdf-textlayer.mjs --limit 20      # 只探前 20 本
 *
 * ★ 只读：走的是插件自己的块缓存与网盘读取器，不写任何东西（块缓存会顺带填充，那是
 *   插件本来就会做的事）。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPanAuth } from '../src/host/pan-auth.js';
import { createPanReader } from '../src/host/pan.js';
import { bookListsDir, bookListsIndexPath, panAppPath, panCacheDir, panTokenPath } from '../src/host/store.js';

const args = process.argv.slice(2);
const limitAt = args.indexOf('--limit');
const LIMIT = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
// ★ 不能写成 `index !== limitAt + 1`：没有 `--limit` 时 `limitAt` 是 -1，
//   `limitAt + 1` 就是 0 —— 于是**第一个 id 前缀被静默丢掉**（第一版就这样漏掉了一本）。
const prefixes = args.filter((arg, index) => !arg.startsWith('--') && !(limitAt >= 0 && index === limitAt + 1));

/** 整本读的上限：32 块 × 1 MiB 是 `readRange` 的单次硬上限，留点余量。 */
const FULL_READ_MAX = 24 * 1024 * 1024;
const SAMPLE_HEAD = 4 * 1024 * 1024;
const SAMPLE_TAIL = 1024 * 1024;

const count = (text, re) => (text.match(re) ?? []).length;

/**
 * 判定：返回 `{ verdict, detail }`。
 *
 * ★★ 第一版只判「有没有字体对象」，**结论是错的**。实测：一本 269 页的扫描书里也有
 *    4 个字体对象（扫描软件在封面/版权页上打的那几个字），于是被判成「有文字层」——
 *    用户照着去抽目录，抽出来还是空的。
 *    所以必须看**比例**：每页都该有字体才叫文字版；图片数量接近页数、字体只有个位数，
 *    那就是「扫描 + 封面打了几个字」。
 */
function judge(text) {
  const pages = count(text, /\/Type\s*\/Page\b(?!s)/g);
  const fonts = count(text, /\/Type\s*\/Font\b/g) + count(text, /\/BaseFont\b/g);
  const toUnicode = count(text, /\/ToUnicode\b/g);
  const images = count(text, /\/Subtype\s*\/Image\b/g);
  const objStm = count(text, /\/ObjStm\b/g);
  const detail = { pages, fonts, toUnicode, images, objStm };
  // 页对象被压进对象流（`/ObjStm`）时数不到页数。这时只能看「有字体 + 图很少」——
  // 一本 300 页的书只有十几张图，那就不是扫描。结论带「需打开实测」，不装作确定。
  if (pages === 0) {
    if (fonts > 0 && images < 100) return { verdict: '大概率有文字层', detail };
    return { verdict: '看不清（对象流）', detail };
  }
  const imagePerPage = images / pages;
  // 图片几乎每页一张 + 字体只有个位数 ⇒ 扫描版（那几个字体是封面/版权页）。
  if (imagePerPage >= 0.8 && fonts <= Math.max(4, pages * 0.1)) return { verdict: '扫描版', detail };
  if (fonts > 0 && imagePerPage < 0.8) return { verdict: '有文字层', detail };
  if (objStm > 0) return { verdict: '看不清（对象流）', detail };
  return { verdict: '不确定', detail };
}

async function main() {
  const index = JSON.parse(await readFile(bookListsIndexPath(), 'utf8'));
  const lists = Array.isArray(index?.lists) ? index.lists : [];
  if (lists.length === 0) {
    console.log('✗ 还没有任何书单 —— 先去插件设置里「扫描生成书单」。');
    return 1;
  }

  const all = [];
  for (const list of lists) {
    try {
      const payload = JSON.parse(await readFile(join(bookListsDir(), `${list.id}.json`), 'utf8'));
      const books = Array.isArray(payload) ? payload : (payload.books ?? []);
      for (const book of books) all.push(book);
    } catch { /* 某份书单坏了不影响别的 */ }
  }

  let targets = all.filter(book => String(book.ext ?? '').toLowerCase() === 'pdf' && Number(book.fs_id ?? 0) > 0);
  if (prefixes.length > 0) {
    targets = targets.filter(book => prefixes.some(prefix => String(book.id).startsWith(prefix)));
  }
  targets = targets.slice(0, LIMIT === Infinity ? targets.length : LIMIT);
  if (targets.length === 0) {
    console.log('✗ 没有匹配的网盘 PDF。');
    return 1;
  }

  const panAuth = createPanAuth({ appPath: panAppPath(), tokenPath: panTokenPath() });
  const pan = createPanReader({
    appPath: panAppPath(),
    tokenPath: panTokenPath(),
    saveToken: token => panAuth.saveToken(token),
    cacheDir: panCacheDir(),
    log: () => {},
  });
  // 先确保凭证可用（过期会自动续期；0.18.1 起续期结果会写回文件）。
  await pan.ensureToken();

  console.log(`探 ${targets.length} 本（只读，不改任何东西）\n`);
  const tally = new Map();
  for (const book of targets) {
    const size = Number(book.size ?? 0);
    const fsId = Number(book.fs_id);
    let text;
    try {
      if (size <= FULL_READ_MAX) {
        text = (await pan.readRange(fsId, 0, size - 1)).toString('latin1');
      } else {
        // 太大就抽样：头 + 尾。字体对象几乎总在头部（第一页内容流附近）。
        const head = await pan.readRange(fsId, 0, SAMPLE_HEAD - 1);
        const tail = await pan.readRange(fsId, size - SAMPLE_TAIL, size - 1);
        text = head.toString('latin1') + tail.toString('latin1');
      }
    } catch (error) {
      console.log(`✗ ${book.filename}\n   读取失败：${error?.message ?? error}`);
      continue;
    }
    const { verdict, detail } = judge(text);
    tally.set(verdict, (tally.get(verdict) ?? 0) + 1);
    const mark = verdict === '有文字层' ? '✓' : verdict === '扫描版' ? '✗' : '?';
    console.log(`${mark} ${verdict.padEnd(14)} ${(size / 1048576).toFixed(1).padStart(5)}MB  ${book.filename}`);
    const ratio = detail.pages > 0 ? (detail.images / detail.pages).toFixed(2) : '—';
    console.log(`    页 ${detail.pages} · 字体 ${detail.fonts} · 图 ${detail.images}（${ratio}/页）· ToUnicode ${detail.toUnicode} · 对象流 ${detail.objStm}`);
  }

  console.log('\n小结：');
  for (const [verdict, n] of tally) console.log(`  ${verdict}：${n} 本`);
  return 0;
}

process.exitCode = await main();
