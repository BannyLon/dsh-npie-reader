#!/usr/bin/env node
/**
 * 清掉「已退订的源」留在 articles 缓存里的文章。
 *
 * ★ 必须**先退出 dsh 桌面端**再运行
 * ------------------------------
 * 插件宿主进程内存里有 data.json 的副本，任何一次保存都会把它写回磁盘。
 * 2026-10-20 第一次清理就是这样被覆盖的：脚本写完校验是 89 条，几秒后文件回到
 * 99 条、大小与原文件一致 —— 界面上什么都没变。
 *
 * 判定规则（保守，宁可少删）：
 *   频道名 **不在** 当前订阅名列表里
 *   且 **不是** 任何订阅名的前缀/被包含（`AIHOT — 精选` 是 `AIHOT — 精选全文` 的旧名，保留）
 *   ⇒ 才删。
 *
 * 用法：
 *   node scripts/purge-orphan-articles.mjs --dry-run   # 只看会删什么
 *   node scripts/purge-orphan-articles.mjs             # 真删（自动备份 + 原子写 + chmod 600）
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA = join(homedir(), '.dsh/storages/dsh-npie-reader/data.json');
const dryRun = process.argv.includes('--dry-run');

const data = JSON.parse(readFileSync(DATA, 'utf8'));
const subscriptions = data.subscriptions ?? [];
const names = [...new Set(subscriptions.map((sub) => String(sub.name ?? '').trim()).filter(Boolean))];
const articles = data.articles ?? {};
const totalBefore = Object.keys(articles).length;

/** 旧名判定：`X` 是某个订阅名的前缀、或包含订阅名 ⇒ 当作同一个源的旧版本，保留。 */
const isAliasOfSubscribed = (channel) => names.some((name) => name.startsWith(channel) || channel.startsWith(name));

const doomed = Object.entries(articles).filter(([, article]) => {
  const channel = String(article?.channelName ?? '').trim();
  if (!channel) return false;            // 没频道名的（体检抓的空壳）不碰
  if (names.includes(channel)) return false;
  return !isAliasOfSubscribed(channel);
});

if (!doomed.length) {
  console.log(`没有需要清理的文章，缓存已经是干净的（${totalBefore} 条）。`);
  process.exit(0);
}

const byChannel = doomed.reduce((acc, [, article]) => {
  const key = article.channelName;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

console.log(`当前文章缓存 ${totalBefore} 条，将删除 ${doomed.length} 条：`);
for (const [channel, count] of Object.entries(byChannel).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${channel}`);
}
for (const [key, article] of doomed) {
  console.log(`    - ${key} | ${String(article.title ?? '').slice(0, 60)}`);
}

if (dryRun) {
  console.log('\n--dry-run：没有写入任何文件。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${DATA}.bak-${stamp}-orphan-articles`;
copyFileSync(DATA, backup);
console.log(`\n备份：${backup}`);

for (const [key] of doomed) delete articles[key];
const tmp = `${DATA}.purge.tmp`;
writeFileSync(tmp, JSON.stringify(data));
renameSync(tmp, DATA);
chmodSync(DATA, 0o600);   // writeFileSync 按 umask 建文件，会把 600 变成 644

const after = JSON.parse(readFileSync(DATA, 'utf8'));
const doomedChannels = new Set(Object.keys(byChannel));
const left = Object.values(after.articles ?? {})
  .filter((article) => doomedChannels.has(String(article?.channelName ?? '').trim()));
console.log(`完成：articles ${totalBefore} → ${Object.keys(after.articles ?? {}).length}，`
  + `订阅仍是 ${(after.subscriptions ?? []).length} 条，残留 ${left.length} 条。`);
