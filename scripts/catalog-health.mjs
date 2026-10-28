/**
 * 内置目录体检：抓一遍目录里的订阅源，记下「每个源最新一篇是什么时候」。
 *
 * 覆盖**两类**内置目录，与 `src/client/Discover.jsx` 的 `builtinCatalog` 同口径：
 *   - `independent-blogs.json` —— 从 upstream 目录同步来的几百条；
 *   - `newsletter-feeds.json` —— 逐条实测手写的那十来条。
 * ★ 2026-10-09 之前只体检前者，Newsletter 那批是「人肉测过就完事」——
 *   代价是目录里躺着两条停更近两年的源（AI Valley 最新 2024-12-07、
 *   Grace Leung 2024-10-11）而界面上一个字都没说。
 *
 * 纪律：
 *   - **只读网络 + 只写数据文件**，不碰用户的订阅数据（`~/.dsh/storages/…`）。
 *   - 产出**必须带测量时间**，且时间记在 `checkedAt[类别]` 上而不是一个笼统的
 *     `generatedAt`：分类别跑时只重测一类，一个 `generatedAt` 会让
 *     「昨天测的博客 + 刚测的 Newsletter」被读成整份都是新的。
 *   - 抓不到 ≠ 已死：可能是超时、反爬、临时 5xx。所以分开记 `ok / newestAt / error`，
 *     由界面决定怎么说，不要在这里把「探不通」直接翻译成「已停更」。
 *
 * 用法：
 *   node scripts/catalog-health.mjs --limit 40          # 先小样本验证
 *   node scripts/catalog-health.mjs                     # 全量（两类）
 *   node scripts/catalog-health.mjs --only Newsletter   # 只重测一类，其余条目原样保留
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseFeed } from '../src/host/feeds.js';
import { PRUNE_CATALOG_DAYS, STALE_CATALOG_DAYS } from '../src/client/catalog-health.js';
import { daysSince } from '../src/client/source-health.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const LIMIT = Number(flag('limit', '0')) || 0;
const CONCURRENCY = Number(flag('concurrency', '8'));
const TIMEOUT_MS = Number(flag('timeout', '12000'));
const ONLY = flag('only', '');
const OUT = flag('out', join(root, 'src', 'data', 'catalog-health.json'));

/**
 * 要体检的目录。`pruneDays` 是**删除线**（不是界面标签线）：
 * 超过它的条目 `prune-catalog.mjs` 会直接从目录里拿掉，两类各有一条。
 */
const CATALOGS = [
  { file: join(root, 'src', 'data', 'independent-blogs.json'), category: '独立博客', pruneDays: STALE_CATALOG_DAYS },
  { file: join(root, 'src', 'data', 'newsletter-feeds.json'), category: 'Newsletter', pruneDays: PRUNE_CATALOG_DAYS },
];

/**
 * ★ 只有**直接执行**时才跑全量体检。
 *
 * 不加这道闸，任何 `import { checkOne } from './catalog-health.mjs'` 都会**顺带把目录里
 * 所有源全抓一遍**：实测 `prune-catalog.mjs` 一启动就先跑了 4 分钟的全量体检、然后才开始复检，
 * 而且会把 `src/data/catalog-health.json` **覆盖掉** —— 一个 import 引起的副作用，
 * 排查时完全看不出来。ESM 的 import 先于模块体执行，所以这个闸必须加在文件里，不能靠调用方自觉。
 */
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

/** 一次抓取：限时 + 限字节。返回 XML 文本。 */
export async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // 有些源对空 UA 直接 403；带一个诚实的标识，别伪装成浏览器。
        'user-agent': 'dsh-npie-reader-catalog-health/0.1 (+local)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > 5 * 1024 * 1024) throw new Error('too large');
    return buffer.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/** 体检一个地址：拿到「最新一篇」的毫秒数。导出给 `prune-catalog.mjs` 复检用。 */
export async function checkOne(entry, { timeoutMs = TIMEOUT_MS, retry = 1 } = {}) {
  let failure;
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    try {
      const xml = await fetchText(entry.url, timeoutMs);
      const parsed = parseFeed(xml, entry.url);
      let newest = 0;
      for (const item of parsed.entries ?? []) {
        const ms = item.publishedAt ? Date.parse(item.publishedAt) : 0;
        if (Number.isFinite(ms) && ms > newest) newest = ms;
      }
      // 只写界面用得上的字段：这份 JSON 会**打进客户端 bundle**，
      // 把 `name`/`title` 抄进去等于把目录再存一份（+100 KB），而它们在对齐时用不上 ——
      // 目录与快照是按 `url` 对齐的。
      return { url: entry.url, category: entry.category, ok: true, newestAt: newest || undefined };
    } catch (error) {
      failure = error;
      /* ★ 重试一次：「慢」和「真的不通」必须分开。
       *   实测 `www.latent.space/feed` 有 **1.38 MB**、单次要 **7.7 秒**，而体检默认 12s 超时
       *   在并发 8 下必然被挤掉 ⇒ 快照记成「没抓到」⇒ 界面照实说「上次体检没抓到」，
       *   用户就以为这个源坏了。可它好端端的。
       *   同理 `blog.google/rss` 单次要 10s 以上。
       *   给一次重试，让「慢」有机会过，留下的 ok:false 才更像「真的不通」。
       *   代价：全量体检里每个失败源多花一次超时（几十条 ⇒ 多几十秒），换掉的是假话。 */
      if (attempt < retry) await new Promise((resolve) => { setTimeout(resolve, 800); });
    }
  }
  return { url: entry.url, category: entry.category, ok: false, error: failure?.message ?? String(failure) };
}

/** 固定并发跑完一批。 */
async function pool(items, workers, worker) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

/** 把一个目录文件摊成待体检条目。 */
function targetsOf(catalog) {
  const data = JSON.parse(readFileSync(catalog.file, 'utf8'));
  return (data.items ?? []).map((item) => ({
    name: item.name,
    url: item.url,
    category: catalog.category,
    pruneDays: catalog.pruneDays,
  }));
}

/**
 * 老快照没有 `checkedAt` 时，用它的 `generatedAt` 给**已存在的每一类**补一个时间。
 *
 * ★ 不补会出真错：只跑 `--only Newsletter` 时，`checkedAt` 里就只剩下 Newsletter 一个键，
 *   而「快照年龄」取的是**最旧**的那一类 ⇒ 整份快照（含 2026-10-08 测的几百条博客）
 *   会被报成「刚测过」，一份两天前的数据冒充现状。补上就退化成老行为，不会更差。
 */
function seededCheckedAt(previous) {
  if (previous?.checkedAt) return previous.checkedAt;
  if (!previous?.generatedAt) return {};
  const categories = [...new Set((previous.items ?? []).map((item) => item.category))];
  return Object.fromEntries(categories.map((category) => [category, previous.generatedAt]));
}

if (isDirectRun) {
const unknownOnly = ONLY && !CATALOGS.some((catalog) => catalog.category === ONLY);
if (unknownOnly) {
  console.error(`★ --only「${ONLY}」不是已知类别。可选：${CATALOGS.map((c) => c.category).join(' / ')}`);
  process.exit(1);
}

// ★ 体检的源集合必须和 `src/client/Discover.jsx` 的 `builtinCatalog` 同口径 ——
//   否则快照里会留下界面根本不会显示的条目，`test/catalog-merge.test.mjs` 的
//   「快照里不该留下已删源的记录」那条会判红。
const all = CATALOGS.flatMap(targetsOf);
const scoped = ONLY ? all.filter((target) => target.category === ONLY) : all;
const targets = LIMIT > 0 ? scoped.slice(0, LIMIT) : scoped;
const scopeLabel = ONLY ? `（只测「${ONLY}」）` : '（两类都测）';

console.log(`体检 ${targets.length} / ${all.length} 个源${scopeLabel}（并发 ${CONCURRENCY}，超时 ${TIMEOUT_MS}ms）…`);
const startedAt = Date.now();
let done = 0;
const results = await pool(targets, CONCURRENCY, async (entry) => {
  const result = await checkOne(entry);
  done++;
  if (done % 50 === 0 || done === targets.length) {
    process.stdout.write(`\r  已查 ${done}/${targets.length}  用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s   `);
  }
  return result;
});
process.stdout.write('\n');

const now = Date.now();
const reachable = results.filter((r) => r.ok);
const withDate = reachable.filter((r) => r.newestAt);
// ★ 判定必须**和界面同一套口径**。这里原先是 `now - r.newestAt >= 90 * 86400000`（原始毫秒差），
//   而界面走 `daysSince`（先向下取整到天）。同一天数差能差出 6 个源：
//   脚本说「266 个 30 天内有更新」、页脚说 272 —— 同一份数据两个数字，用户没法判断信谁。
//   ⇒ 直接引界面那两个模块，别在这里再写一套算术。
const stale = withDate.filter((r) => daysSince(r.newestAt, now) >= STALE_CATALOG_DAYS);
const usable = withDate.filter((r) => daysSince(r.newestAt, now) <= 30);
const dead = reachable.filter((r) => !r.newestAt);
const failed = results.filter((r) => !r.ok);

console.log('');
console.log(`本轮抓得到      ${reachable.length}/${results.length}`);
console.log(`  其中能读出日期 ${withDate.length}`);
console.log(`  30 天内有更新   ${usable.length}   （这就是界面会报的那个数）`);
console.log(`  ${STALE_CATALOG_DAYS} 天以上没更新 ${stale.length}   （界面标签线，占能读出日期的 ${(stale.length / Math.max(1, withDate.length) * 100).toFixed(0)}%）`);
console.log(`  抓得到但没有日期条目 ${dead.length}`);
console.log(`本轮抓不到      ${failed.length}`);

for (const catalog of CATALOGS) {
  const over = withDate.filter((r) => r.category === catalog.category && daysSince(r.newestAt, now) >= catalog.pruneDays);
  const names = over.slice(0, 5).map((r) => r.url).join('、');
  console.log(`  ⚠ ${catalog.category}：${over.length} 条已过**删除线**（≥ ${catalog.pruneDays} 天）${over.length ? ` ⇒ ${names}${over.length > 5 ? ' …' : ''}` : ''}`);
}

// ---------------------------------------------------------------------------
// 写回：`--only` 时**只换掉那一类的条目**，其余原样保留
// ---------------------------------------------------------------------------
// ★ 为什么不能整份覆盖：全量重测一次要打几百个站点，其中必然混进一批「当时被限流」的
//   假阴性；而独立博客那半已经过了「复检 + 裁剪」两道工序，本来就是准的。
//   为了给 Newsletter 补个新鲜度就把那 404 条重打一遍，是拿一次更差的测量换掉一次更准的。
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : undefined;
const carried = ONLY ? (previous?.items ?? []).filter((item) => item.category !== ONLY) : [];
const items = [...carried, ...results];
// 按 CATALOGS 的顺序稳定排序：同一次运行里先博客后 Newsletter，跟界面上的分类顺序一致。
const order = new Map(CATALOGS.map((catalog, index) => [catalog.category, index]));
items.sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99));

const checkedAt = ONLY
  ? { ...seededCheckedAt(previous), [ONLY]: new Date(now).toISOString() }
  : Object.fromEntries(CATALOGS.map((catalog) => [catalog.category, new Date(now).toISOString()]));

// ★ 顶层计数按**留在这份文件里的条目**重算，让它只有一个口径。
//   老版本写的是「本轮 measured/targets」，分类别跑时那两个数会变成半份数据的口径 ——
//   和 `items` 自相矛盾，`test/catalog-merge.test.mjs` 的 `checked === items.length` 也会判红。
const dayAge = (item) => (item.ok && item.newestAt ? daysSince(item.newestAt, now) : undefined);
const count = (predicate) => items.filter(predicate).length;
const summary = {
  // `generatedAt` = 最近一次动过（给「这份文件最后一次被谁改的」用）；
  // 真正决定「过没过期」的是 `checkedAt` 里**最旧**的那一类，见 `oldestCheckedAt`。
  generatedAt: new Date(now).toISOString(),
  checkedAt,
  checked: items.length,
  total: items.length,
  reachable: count((item) => item.ok),
  withDate: count((item) => dayAge(item) !== undefined),
  usable30: count((item) => { const d = dayAge(item); return d !== undefined && d <= 30; }),
  stale90: count((item) => { const d = dayAge(item); return d !== undefined && d >= STALE_CATALOG_DAYS; }),
  failed: count((item) => !item.ok),
};

// 复检/裁剪那几块记录说的是**独立博客**那半的历史，给 Newsletter 补测时必须带走，
// 否则一次 `--only Newsletter` 就把「删了 938 条、复检救回 16 条」的记录清空了。
const history = ONLY
  ? Object.fromEntries(
      ['recheckedAt', 'recheck', 'prunedAt', 'pruned'].filter((key) => previous?.[key] !== undefined).map((key) => [key, previous[key]]),
    )
  : undefined;

writeFileSync(OUT, JSON.stringify({ ...summary, ...history, items }, null, 1));
console.log('');
console.log('写出 ' + OUT);
console.log(`  条目 ${items.length} 条（${ONLY ? `保留了其他类别的 ${carried.length} 条` : '全量'}）`);
console.log('★ 这是**快照**，界面必须把测量时间显示出来，否则它会变成一句假话。');
}
