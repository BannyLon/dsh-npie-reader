/**
 * 按体检结果裁剪内置目录：删掉「探不通」和「长期不更新」的条目。
 *
 * ★ 为什么要先**复检**再删：
 *   上一轮全量体检是几百个源、并发 8–10 一把抓完的。**单个 IP 在几分钟内连打几百个站点**，
 *   相当一部分主机会限流/临时拒绝 —— 那批 `fetch failed` 里必然混着「其实活着、
 *   只是那一下被挡了」的假阴性。按一次并发结果直接删，会把活源一起删掉，而且**删掉就没了**。
 *   所以这里对「探不通」的那批**降并发 + 重试 + 加长超时**再跑一遍，只有仍然不通的才算死。
 *   「长期未更新」那批不需要复检：它们的 feed 是**解析成功**的，日期是源自己给的，可信。
 *
 * ★ 两个目录两条删除线，别用同一个数：
 *   - **独立博客**（`independent-blogs.json`）—— 默认 90 天（`--stale-days`）。
 *     几百条自动同步来的，单价低，删错了还能从 upstream revision 重新同步。
 *   - **Newsletter**（`newsletter-feeds.json`）—— **365 天**（`PRUNE_CATALOG_DAYS`）。
 *     十来条**逐条实测手写**出来的，没有 upstream 可以重新同步 ⇒ 删掉就是永久丢失，
 *     所以线放得更宽（用户 2026-10-09 的原话：「停更一年的直接删掉吧」），
 *     而且删掉的条目**必须先归档到 `retired/`**。
 *
 * 两步走，中间必须停一次：
 *   node scripts/prune-catalog.mjs             # 第一步：复检 + 出计划（写回复检结果，不动目录）
 *   node scripts/prune-catalog.mjs --apply     # 第二步：按计划裁剪目录
 * `--apply` 会拒绝在没有复检记录的快照上执行 —— 那等于用一把并发抓取的结果去删数据。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkOne } from './catalog-health.mjs';
import { PRUNE_CATALOG_DAYS, STALE_CATALOG_DAYS } from '../src/client/catalog-health.js';
import { daysSince } from '../src/client/source-health.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};
const APPLY = argv.includes('--apply');
const CONCURRENCY = Number(flag('concurrency', '4'));
const TIMEOUT_MS = Number(flag('timeout', '20000'));
const ATTEMPTS = Number(flag('attempts', '2'));
const STALE_DAYS = Number(flag('stale-days', String(STALE_CATALOG_DAYS)));

const HEALTH = join(root, 'src', 'data', 'catalog-health.json');

/** 要裁剪的目录。`staleDays` 是**删除线**；`archive` 非空时被删条目必须先归档再删。 */
const CATALOGS = [
  {
    label: '独立博客',
    slug: 'blogs',
    file: join(root, 'src', 'data', 'independent-blogs.json'),
    staleDays: STALE_DAYS,
    archive: null,
  },
  {
    label: 'Newsletter',
    slug: 'newsletter',
    file: join(root, 'src', 'data', 'newsletter-feeds.json'),
    staleDays: PRUNE_CATALOG_DAYS,
    archive: join(root, 'retired', 'newsletter-feeds-retired.json'),
  },
];

const health = JSON.parse(readFileSync(HEALTH, 'utf8'));
const now = Date.now();

/** 复检一条：最多试 `ATTEMPTS` 次，任一次成功就算活。 */
async function recheck(item) {
  let lastError;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = await checkOne({ url: item.url, category: item.category }, { timeoutMs: TIMEOUT_MS });
    if (result.ok) return { ...item, ok: true, newestAt: result.newestAt, error: undefined, revivedOnAttempt: attempt + 1 };
    lastError = result.error;
  }
  return { ...item, ok: false, newestAt: undefined, error: lastError };
}

async function pool(items, workers, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  }));
  return out;
}

/** 一个目录当前的条目（`items` 那一段）。 */
function itemsOf(file) {
  return JSON.parse(readFileSync(file, 'utf8')).items ?? [];
}

/** 按各自删除线给每个目录分好「该删谁」。 */
function planOf(catalog) {
  const urls = new Set(itemsOf(catalog.file).map((item) => item.url));
  const mine = health.items.filter((item) => urls.has(item.url));
  const dead = mine.filter((item) => !item.ok);
  const stale = mine.filter((item) => item.ok && item.newestAt && daysSince(item.newestAt, now) >= catalog.staleDays);
  return { catalog, dead, stale, remove: new Set([...dead, ...stale].map((item) => item.url)) };
}

/**
 * 把要删的条目**连着名字和理由**归档到 retired/，再让调用方去删。
 *
 * 体检快照按 url 对齐、刻意没存 name —— 所以名字只能从**目录文件自己的条目**里取，
 * 理由（多少天没更新）也只能在这里现算。归档里缺了这两样，将来想恢复就成了猜谜。
 *
 * @param {object} catalog
 * @param {{entry: object, reason: string}[]} doomed
 */
function archive(catalog, doomed) {
  if (!catalog.archive || doomed.length === 0) return 0;
  const existing = existsSync(catalog.archive)
    ? JSON.parse(readFileSync(catalog.archive, 'utf8'))
    : { note: '', removed: [] };
  const byUrl = new Map((existing.removed ?? []).map((item) => [item.url, item]));
  for (const { entry, reason } of doomed) {
    byUrl.set(entry.url, { ...entry, removedAt: new Date(now).toISOString(), reason });
  }
  existing.removed = [...byUrl.values()];
  writeFileSync(catalog.archive, JSON.stringify(existing, null, 1));
  return doomed.length;
}

// ---------------------------------------------------------------------------
// 第一步：复检「探不通」的那批
// ---------------------------------------------------------------------------
if (!APPLY) {
  const unreachable = health.items.filter((item) => !item.ok);
  console.log(`复检「探不通」的 ${unreachable.length} 条（并发 ${CONCURRENCY}，超时 ${TIMEOUT_MS}ms，最多 ${ATTEMPTS} 次）…`);
  const startedAt = Date.now();
  let done = 0;
  const rechecked = await pool(unreachable, CONCURRENCY, async (item) => {
    const result = await recheck(item);
    done++;
    if (done % 25 === 0 || done === unreachable.length) {
      process.stdout.write(`\r  已复检 ${done}/${unreachable.length}  用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s   `);
    }
    return result;
  });
  process.stdout.write('\n');

  const byUrl = new Map(rechecked.map((item) => [item.url, item]));
  health.items = health.items.map((item) => byUrl.get(item.url) ?? item);

  const revived = rechecked.filter((item) => item.ok);
  const stillDead = rechecked.filter((item) => !item.ok);
  const noDate = health.items.filter((item) => item.ok && !item.newestAt);

  health.recheckedAt = new Date(now).toISOString();
  health.recheck = {
    attempts: ATTEMPTS,
    timeoutMs: TIMEOUT_MS,
    revived: revived.length,
    stillDead: stillDead.length,
    // ★ 这里只能记**一条**线（历史上就一条）。两类目录两条线，所以 `--apply` 那边
    //   一律读各目录自己的 `staleDays`，不再回读这个字段 —— 否则「独立博客 90 /
    //   Newsletter 365」会被写成一个数，把删除记录写成假话。
    staleDays: STALE_DAYS,
    stale: health.items.filter((item) => item.ok && item.newestAt && daysSince(item.newestAt, now) >= STALE_DAYS).length,
    noDate: noDate.length,
  };
  writeFileSync(HEALTH, JSON.stringify(health, null, 1));

  console.log('');
  console.log(`★ 复检救回 ${revived.length} 条 —— 上一轮被判「探不通」，其实是当时被限流挡了：`);
  for (const item of revived.slice(0, 8)) console.log(`    ${item.url}${item.revivedOnAttempt > 1 ? `（第 ${item.revivedOnAttempt} 次才通）` : ''}`);
  if (revived.length > 8) console.log(`    …另有 ${revived.length - 8} 条`);
  console.log('');
  console.log(`仍然探不通 ${stillDead.length} 条  ⇒ 删`);
  console.log(`抓得到但无日期 ${noDate.length} 条  ⇒ **保留**（测不出来就不该判死）`);

  const plans = CATALOGS.map(planOf);
  for (const plan of plans) {
    const labels = [...plan.stale].map((item) => item.url);
    console.log(`  ${plan.catalog.label}：≥ ${plan.catalog.staleDays} 天未更新 ${labels.length} 条  ⇒ 删`);
    for (const url of labels.slice(0, 8)) console.log(`      ${url}`);
    if (labels.length > 8) console.log(`      …另有 ${labels.length - 8} 条`);
  }
  console.log(`合计要删 ${plans.reduce((sum, plan) => sum + plan.remove.size, 0)} 条`);
  console.log('');
  console.log('已把复检结果写回体检快照。确认无误后执行：node scripts/prune-catalog.mjs --apply');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 第二步：裁剪目录
// ---------------------------------------------------------------------------
if (!health.recheck) {
  console.error('★ 这份体检快照没有复检记录 —— 拒绝执行。');
  console.error('  直接按一把并发抓取的结果删数据，会把「当时被限流」的活源一起删掉。');
  console.error('  先跑：node scripts/prune-catalog.mjs');
  process.exit(1);
}

const plans = CATALOGS.map(planOf);

// 先备份到 /tmp —— 裁剪是破坏性的，出错了要能立刻回退。
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupTargets = [...CATALOGS.map((catalog) => [catalog.file, catalog.slug]), [HEALTH, 'health']];
for (const [from, tag] of backupTargets) {
  writeFileSync(`/tmp/npr-before-prune-${tag}-${stamp}.json`, readFileSync(from));
}
console.log(`已备份裁剪前的文件到 /tmp/npr-before-prune-*-${stamp}.json`);

/** 「探不通」那半的说明只在这轮真的删了死源时才写进规则。 */
function ruleText(catalog, dead, stale) {
  const parts = [];
  if (dead.length > 0) parts.push(`探不通（复检 ${health.recheck.attempts} 次、超时 ${health.recheck.timeoutMs}ms 后仍失败）`);
  if (stale.length > 0) parts.push(`≥ ${catalog.staleDays} 天未更新`);
  return parts.join('或');
}

for (const plan of plans) {
  const { catalog, dead, stale, remove } = plan;
  // ★ 这一轮一条都没删时**一个字都不许改**：`pruned` 记的是「上一次真的删了什么」。
  //   原样重写会把独立博客那条「1342 → 404」的记录改成「404 → 404」——
  //   既毁掉历史，也会让 `assert(pruned.from > pruned.to)` 直接判红。
  if (remove.size === 0) {
    console.log(`\n${catalog.label}：本轮 0 条要删，目录与 pruned 记录都不动。`);
    continue;
  }

  const data = JSON.parse(readFileSync(catalog.file, 'utf8'));
  const before = (data.items ?? []).length;
  const ageOf = (item) => daysSince(item.newestAt, now);
  const entryOf = (item) => (data.items ?? []).find((row) => row.url === item.url) ?? item;
  const doomed = [
    ...dead.map((item) => ({ entry: entryOf(item), reason: '探不通' })),
    ...stale.map((item) => ({ entry: entryOf(item), reason: `最新一篇在 ${ageOf(item)} 天前，超过删除线 ${catalog.staleDays} 天` })),
  ];

  if (catalog.archive) {
    const archived = archive(catalog, doomed);
    console.log(`\n${catalog.label}：先把 ${archived} 条归档到 ${catalog.archive}`);
  }

  data.items = (data.items ?? []).filter((item) => !remove.has(item.url));
  // ★ `pruned` 说的是「上一次真的删了什么」。一条都没删的分支已经提前 continue，
  //   所以走到这里 `from > to` 必然成立。
  data.pruned = {
    at: new Date(now).toISOString(),
    from: before,
    to: data.items.length,
    rule: ruleText(catalog, dead, stale),
  };
  writeFileSync(catalog.file, JSON.stringify(data, null, 1));
  console.log(`${catalog.label} ${before} → ${data.items.length}`);
}

// 体检快照只保留还在目录里的条目，免得 bundle 里躺着一堆已删源的记录。
const liveUrls = new Set(CATALOGS.flatMap((catalog) => itemsOf(catalog.file).map((item) => item.url)));
health.items = health.items.filter((item) => liveUrls.has(item.url));
health.prunedAt = new Date(now).toISOString();
health.pruned = Object.fromEntries(plans.map((plan) => [plan.catalog.label, {
  unreachable: plan.dead.length,
  stale: plan.stale.length,
  staleDays: plan.catalog.staleDays,
}]));
health.pruned.kept = health.items.length;

// ★ 顶层那几个计数（`checked` / `total` / `reachable` / `stale90` / `failed`）说的是
// **裁剪前**那一轮全量体检，裁完之后它们和 `items` 对不上了 —— 留着就是一份自相矛盾的快照。
// 这里按存活下来的条目重算，让整份文件只有一个口径。
const survivors = health.items;
const days = (item) => (item.ok && item.newestAt ? daysSince(item.newestAt, now) : undefined);
health.checked = survivors.length;
health.total = survivors.length;
health.reachable = survivors.filter((item) => item.ok).length;
health.withDate = survivors.filter((item) => days(item) !== undefined).length;
health.usable30 = survivors.filter((item) => { const d = days(item); return d !== undefined && d <= 30; }).length;
health.stale90 = survivors.filter((item) => { const d = days(item); return d !== undefined && d >= STALE_CATALOG_DAYS; }).length;
health.failed = survivors.filter((item) => !item.ok).length;

writeFileSync(HEALTH, JSON.stringify(health, null, 1));

console.log('');
console.log(`体检快照条目 ${health.items.length}（只留还在目录里的）`);
console.log('');
console.log('独立博客被删清单可从 /tmp 的备份 + 源目录 revision 取回；');
console.log('Newsletter 被删清单已归档到 retired/ —— 它没有 upstream，只能从那里取回。');
