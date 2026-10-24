#!/usr/bin/env node
/**
 * 一次性清理：状态表 `library.states` 里那 5 条**孤儿**阅读进度记录。
 *
 * 「孤儿」= 键（书 id）在当前书单里找不到对应条目。它们来自书单换 id 方案之前
 * （旧 id 形如 `b01322`，新 id 形如 `p4e18c94b5f30b5e5`）。用户 2026-10-09 定：
 * 「状态表里那 5 条孤儿记录删除即可」。
 *
 * ★★★ 为什么必须在 **DSH 完全退出之后** 才跑 —— 这不是谨慎，是硬约束：
 *
 *   `RssStore` 在插件启动时把 `data.json` 读进内存（`this.data`），此后**只在内存里
 *   改**，靠 500ms 去抖的 `flush()` 全量重写落盘；而 `dispose()`（插件卸载路径，
 *   也就是「退出 DSH」）会**无条件**再 `flush()` 一次。
 *
 *   ⇒ 边开边删 = 白删：你改完盘，退出 DSH 那一下又把内存里那份（还带着 5 条）
 *     整个写回去。而且**不报错**，只有下次打开才会发现那 5 条又回来了。
 *
 * ★ 为什么硬编码这 5 个 id，而不是「动态算所有孤儿」：
 *   动态算法会把「**书单暂时没加载出来**」的那些书的进度一起当成孤儿删掉 ——
 *   那是真数据丢失。这里只认这 5 个已经逐个核对过的 id。
 *
 * ★ 为什么先做 `pan_path` 预检：这 5 条都能在**当前书单**里按 `pan_path` 找到
 *   同一本书（实测 5/5 命中，`pan_path` 在 2634 本里 2634 个唯一值）。
 *   所以删掉的只是「旧 id 那份进度」，书本身还在；想读还能重新加进来。
 *   预检不通过就**拒绝执行** —— 那说明前提变了，得重新判断。
 *
 * 运行：
 *   node scripts/cleanup-orphan-states.mjs              # 只看，不写
 *   node scripts/cleanup-orphan-states.mjs --apply --dsh-stopped
 *
 * 退出码：0 完成（含「本来就没有」）/ 1 预检失败 / 2 数据文件不可用 / 3 缺少确认开关
 */
import { copyFile, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 这 5 条。`panPath` 与 `newId` 是 2026-10-09 逐个核对出来的（旧 id → pan_path →
 * 当前书单里的新 id），写死在脚本里：清理脚本不该依赖另一个项目的文件还在不在。
 */
const ORPHANS = [
  {
    oldId: 'b01322',
    newId: 'p4e18c94b5f30b5e5',
    panPath: '/E书拾取/系列丛书全套/11、20世纪世界诗歌译丛/第三辑/《20世纪世界诗歌译丛》第三辑《伽姆扎托夫爱情诗》.pdf',
    title: '《20世纪世界诗歌译丛》第三辑《伽姆扎托夫爱情诗》',
  },
  {
    oldId: 'b01469',
    newId: 'p4e510a439c46eeed',
    panPath: '/E书拾取/系列丛书全套/2、外国文学名著丛书/网格本《外国文学名著丛书书系》031[波斯]内扎米《蕾莉与马杰农》.卢永译，人民文学出版社(1988).pdf',
    title: '网格本《外国文学名著丛书书系》031[波斯]内扎米《蕾莉与马杰农》',
  },
  {
    oldId: 'b00773',
    newId: 'p1b2c17b1069b4edb',
    panPath: '/E书拾取/欧洲文学/中欧【包括波兰、捷克、斯洛伐克、匈牙利、德国、奥地利、瑞士、列支敦士登】/德语文学/尼采/[域外诗丛]尼采诗选[德]尼采.钱春绮译.漓江出版社(1986).pdf',
    title: '尼采诗选[德]尼采.钱春绮译.漓江出版社(1986)',
  },
  {
    oldId: 'b02397',
    newId: 'p2f5b9e9468458298',
    panPath: '/E书拾取/亚洲文学/日本/[ilxdh.com]-干法 （日）稻盛和夫着.pdf',
    title: '-干法 （日）稻盛和夫著',
  },
  {
    oldId: 'b02116',
    newId: 'p2033ff5a5e5c725e',
    panPath: '/E书拾取/系列丛书全套/随笔散文/[天山游记].(俄)彼·彼·谢苗诺夫.扫描版.pdf',
    title: '.(俄)彼·彼·谢苗诺夫.扫描版',
  },
];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const STOPPED = argv.includes('--dsh-stopped');
const DATA_DIR = process.env.NPIE_DATA_DIR ?? join(homedir(), '.dsh', 'storages', 'dsh-npie-reader');
const DATA = join(DATA_DIR, 'data.json');
const LISTS = join(DATA_DIR, 'lists');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const fail = (code, message) => { console.error(message); process.exit(code); };

if (APPLY && !STOPPED) {
  fail(3, [
    '拒绝写入：缺少 --dsh-stopped。',
    '',
    '这个脚本改的是 DSH 插件的数据文件，而插件**把整份数据缓存在内存里**，',
    '退出 DSH 时会无条件再全量写回一次（dispose → flush）。',
    '所以必须先把 DSH 完全退出，再跑这个脚本 —— 否则你删掉的那几条会被写回来，',
    '而且不报任何错。',
    '',
    '确认 DSH 已退出后：node scripts/cleanup-orphan-states.mjs --apply --dsh-stopped',
  ].join('\n'));
}

// ---- 1. 读 ---------------------------------------------------------------
let raw;
try {
  raw = await readFile(DATA, 'utf8');
} catch (error) {
  fail(2, `读不了 ${DATA}：${error.message}`);
}
const data = JSON.parse(raw);
if (data?.library === undefined || typeof data.library.states !== 'object' || data.library.states === null) {
  fail(2, `${DATA} 里没有 library.states —— 前提变了，先别删。`);
}
const states = data.library.states;
const before = Object.keys(states).length;
console.log(`数据文件 ${DATA}`);
console.log(`  mtime ${(await stat(DATA)).mtime.toISOString()}  大小 ${raw.length} 字节`);
console.log(`  library.states 共 ${before} 条`);

// ---- 2. 预检：5 条都在、且都能按 pan_path 在当前书单里认回同一本书 ----------
const listFiles = (await readdir(LISTS)).filter((name) => name.endsWith('.json'));
const byPanPath = new Map();
for (const name of listFiles) {
  const parsed = JSON.parse(await readFile(join(LISTS, name), 'utf8'));
  const books = Array.isArray(parsed) ? parsed : (parsed.books ?? []);
  for (const book of books) if (typeof book?.pan_path === 'string') byPanPath.set(book.pan_path, book);
}
console.log(`  书单文件 ${listFiles.join(' / ')}，合计 ${byPanPath.size} 本，pan_path 唯一值 `
  + `${new Set(byPanPath.keys()).size} 个`);

const present = [];
const missing = [];
const problems = [];
for (const orphan of ORPHANS) {
  if (!Object.hasOwn(states, orphan.oldId)) { missing.push(orphan.oldId); continue; }
  const book = byPanPath.get(orphan.panPath);
  if (book === undefined) {
    problems.push(`${orphan.oldId}（${orphan.title}）：当前书单里按 pan_path 找不到这本书`);
    continue;
  }
  if (book.id !== orphan.newId) {
    problems.push(`${orphan.oldId}：pan_path 命中的新 id 是 ${book.id}，脚本里记的是 ${orphan.newId}`);
    continue;
  }
  present.push(orphan);
}
if (problems.length > 0) {
  fail(1, ['预检失败，一条都不动：', ...problems.map((p) => `  - ${p}`)].join('\n'));
}

console.log(`\n待删 ${present.length} 条（已在本文件里 ${missing.length} 条不存在）：`);
for (const orphan of ORPHANS) {
  const record = states[orphan.oldId];
  const flag = record === undefined ? '已不存在' : '待删';
  console.log(`  [${flag}] ${orphan.oldId} → ${orphan.newId}  ${JSON.stringify(record ?? null)}`);
  console.log(`         《${orphan.title}》`);
}
if (present.length === 0) {
  console.log('\n没有要删的 —— 状态表已经清干净了。');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n（只读演练。要真删加 --apply --dsh-stopped，且**先退出 DSH**。）');
  process.exit(0);
}

// ---- 3. 备份 + 侧车记录（删掉的信息一个字节都不丢）-------------------------
const at = stamp();
const backup = `${DATA}.bak-${at}-orphan-cleanup`;
await copyFile(DATA, backup);
console.log(`\n已备份：${backup}`);

/**
 * 侧车记录：把「删了什么」连同**认回路径**一起留在数据目录里。
 * 删掉的只是「旧 id 那份进度」；有了 oldId → panPath → newId 这张表，
 * 用户改主意时可以把进度按新 id 写回去（`page` / `pages` 都在下面）。
 */
const sidecar = join(DATA_DIR, `orphan-states-removed-${at}.json`);
await writeFile(sidecar, `${JSON.stringify({
  removedAt: new Date().toISOString(),
  reason: '书单换 id 方案后残留的旧 id 进度；用户 2026-10-09 决定删除',
  dataFile: DATA,
  backup,
  restoredBy: '把下面 records 里的 state 按 newId 写回 data.json 的 library.states',
  records: present.map((orphan) => ({
    oldId: orphan.oldId,
    newId: orphan.newId,
    panPath: orphan.panPath,
    title: orphan.title,
    state: states[orphan.oldId],
  })),
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`已留记录：${sidecar}`);

// ---- 4. 删 + 原子写 ------------------------------------------------------
const removed = {};
for (const orphan of present) {
  removed[orphan.oldId] = states[orphan.oldId];
  delete states[orphan.oldId];
}
const temp = `${DATA}.${process.pid}.tmp`;
await writeFile(temp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
await rename(temp, DATA);

// ---- 5. 自证：重新读回来核一遍 --------------------------------------------
const after = JSON.parse(await readFile(DATA, 'utf8'));
const afterKeys = Object.keys(after.library.states);
const stillThere = Object.keys(removed).filter((id) => afterKeys.includes(id));
if (stillThere.length > 0) fail(2, `写回去了但没删掉：${stillThere.join(' ')}`);
if (afterKeys.length !== before - present.length) {
  fail(2, `条数对不上：${before} - ${present.length} ≠ ${afterKeys.length}`);
}
/** 除了 states 那 5 个键，**其余必须逐字节等价**（JSON 深比较，不是「看着差不多」）。 */
const expected = JSON.parse(raw);
for (const id of Object.keys(removed)) delete expected.library.states[id];
if (JSON.stringify(after) !== JSON.stringify(expected)) {
  fail(2, '写出来的文件与「原文件减去这 5 个键」不一致 —— 有别的东西被动了，去看备份。');
}

console.log(`\n完成：library.states ${before} → ${afterKeys.length} 条（删了 ${present.length} 条）。`);
console.log('其余内容逐字节未变（已重新读回来深比较过）。');
console.log('★ 现在可以重新打开 DSH 了；打开后那 5 行不会再出现。');
