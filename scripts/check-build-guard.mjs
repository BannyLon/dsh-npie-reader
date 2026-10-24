/**
 * `build.mjs` 那道「产物里不许有变异体」的闸门，反向对照。
 *
 * 做法：把 `digest-store.writeSkill` 里那行真删换成 `void dir;`（= 变异体 #9），
 * 然后跑构建 —— **必须 exit 1 且打印「产物里发现变异体」**。跑完无论成败都还原源码
 * 并重建一次，让盘上留下的是正常产物。
 *
 * ★ 为什么这条对照必须常驻，而不是跑一次就扔：
 *   闸门本身也会坏（锚点改名、正则写错、`to` 太短被跳过）。闸门坏了的表现是
 *   **构建照常通过** —— 和「一切正常」长得一模一样。只有反向对照能区分这两件事。
 * ★ 临时改写源码的脚本必须**信号安全**：`finally` 不覆盖 SIGINT / SIGTERM，
 *   所以显式挂信号处理，先还原再退出。否则变异体留在盘上，而测试仍然全绿。
 *
 * 退出码：0 = 闸门有牙（拒绝构建了）· 1 = 闸门失效 · 2 = 找不到锚点（源码变了）
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const target = join(root, 'src/host/digest-store.js');
const buildScript = join(root, 'build.mjs');
const node = process.execPath;

const original = readFileSync(target, 'utf8');
const md5 = text => createHash('md5').update(text).digest('hex');
const digest = md5(original);
const NEEDLE = '    await rm(dir, { recursive: true, force: true });';

if (!original.includes(NEEDLE)) {
  console.log('✗ 找不到锚点（writeSkill 里那行真删），源码结构变了 —— 先更新这条对照');
  process.exit(2);
}

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  writeFileSync(target, original);
  const ok = md5(readFileSync(target, 'utf8')) === digest;
  console.log(`还原自检 ${ok ? 'ok' : 'MISMATCH'}`);
  if (!ok) return;
  const again = spawnSync(node, [buildScript], { encoding: 'utf8' });
  console.log(`还原后重建 exit=${again.status}`);
}
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

try {
  writeFileSync(target, original.replace(NEEDLE, '    void dir;'));
  const run = spawnSync(node, [buildScript], { encoding: 'utf8' });
  const stderr = run.stderr ?? '';
  console.log(`注入变异体后构建 exit=${run.status}`);
  for (const line of stderr.trim().split('\n').slice(0, 6)) console.log(`  | ${line}`);
  const caught = run.status === 1 && stderr.includes('产物里发现变异体');
  console.log(caught
    ? '★ 闸门有牙：注入变异体后构建被拒绝'
    : '✗ 闸门失效：构建照常通过（这道闸现在证明不了任何事）');
  if (!caught) process.exitCode = 1;
} finally {
  restore();
}
