#!/usr/bin/env node
/**
 * 真机验证：网盘续期出来的新 refresh_token **到底有没有写回凭证文件**。
 *
 * 为什么需要这个脚本：单元测试用的是假网盘（`test/host-pan.test.mjs`），它证明的是
 * 「代码路径对不对」。而 0.18.1 修的这件事，本质是一个**真服务器的行为**——
 * 百度每次续期都会换发新的 refresh_token、旧的当场作废。要证明「真的写回去了」，
 * 只能拿真凭证跟真服务器跑一次。
 *
 * ★★★ 先说清楚风险：**这个脚本会消耗掉你当前的 refresh_token**。
 *   续期是单向的 —— 跑完之后，旧的那个立刻作废，只有「新值成功写回文件」这一条路
 *   能让你继续用。所以：
 *     - **刚重新授权完再跑**（这样万一失败，代价只是再授权一次）；
 *     - 跑之前**关掉桌面端**（DSH 进程里也持有一份内存 token，两边同时续期必有一边失败）。
 *
 * ★ 默认是**干跑**：只读、只报告，一个字都不写。真跑要显式加两个开关。
 *
 * 运行：
 *   node scripts/verify-pan-refresh.mjs                          # 只看现状
 *   node scripts/verify-pan-refresh.mjs --apply --dsh-stopped    # 真跑（会消耗 refresh_token）
 *
 * 判据（三条全中才算 PASS）：
 *   1. 续期请求成功，拿到新 access_token；
 *   2. 文件里的 `refresh_token` **变了**（说明换发出来的新值真的落盘了）；
 *   3. 文件里其余字段还在（`appKey` / `scope` 不被覆盖 —— 合并而不是覆盖）。
 * 任何一条不中：从备份还原，并明确告诉你「要不要重新授权」。
 */

import { copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createPanReader } from '../src/host/pan.js';
import { createPanAuth } from '../src/host/pan-auth.js';
import { panAppPath, panTokenPath } from '../src/host/store.js';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const DSH_STOPPED = args.has('--dsh-stopped');

const TOKEN_PATH = panTokenPath();
const APP_PATH = panAppPath();
const BACKUP_PATH = `${TOKEN_PATH}.bak-verify-${Date.now()}`;

/** 绝不打印任何 token 值 —— 只打印「有没有」「变没变」「多长」。 */
const shape = (value) => (typeof value === 'string' && value !== '' ? `有（${value.length} 字符）` : '没有');

async function readTokenOrNull() {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const token = await readTokenOrNull();
  if (token === null) {
    console.log(`✗ ${TOKEN_PATH} 不存在 —— 还没授权，先走一次授权向导。`);
    return 1;
  }
  const before = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Number(token.expires_at ?? 0),
    extras: Object.keys(token).filter(key => !['access_token', 'refresh_token', 'expires_at'].includes(key)),
  };
  const info = await stat(TOKEN_PATH);

  console.log('凭证文件：', TOKEN_PATH);
  console.log('  mtime       ', new Date(info.mtimeMs).toISOString());
  console.log('  access_token', shape(before.access_token));
  console.log('  refresh_token', shape(before.refresh_token));
  console.log('  expires_at  ', before.expires_at > 0 ? new Date(before.expires_at).toISOString() : '（0 / 没写）');
  console.log('  其他字段    ', before.extras.length > 0 ? before.extras.join(', ') : '（无）');
  console.log('  过期了吗    ', Date.now() >= before.expires_at ? '是（本来就要续期）' : '否（下面会临时把它改成过期）');

  if (before.refresh_token === undefined) {
    console.log('✗ 文件里没有 refresh_token —— 只能重新授权。');
    return 1;
  }

  if (!APPLY) {
    console.log('\n—— 干跑结束，什么都没写。要真跑：');
    console.log('   1) 先退出桌面端（DSH 进程里也有一份内存 token）');
    console.log('   2) node scripts/verify-pan-refresh.mjs --apply --dsh-stopped');
    console.log('   ★ 这会消耗掉当前 refresh_token（旧的当场作废），建议刚授权完再跑。');
    return 0;
  }
  if (!DSH_STOPPED) {
    console.log('\n✗ 真跑必须加 --dsh-stopped，并且**真的**已经把桌面端关掉。');
    console.log('  两个进程同时续期，必有一边拿到 refresh token has been used。');
    return 1;
  }

  // 1. 备份（600 权限，与凭证文件同档）。
  await copyFile(TOKEN_PATH, BACKUP_PATH);
  console.log(`\n备份：${BACKUP_PATH}`);

  // 2. 把 expires_at 改成 0 ⇒ 逼它走续期分支（其余字段一个不动）。
  await writeFile(TOKEN_PATH, JSON.stringify({ ...token, expires_at: 0 }, null, 2), { encoding: 'utf8', mode: 0o600 });
  console.log('已把 expires_at 临时改成 0（只为触发续期，别的字段没动）');

  let failure = null;
  try {
    const panAuth = createPanAuth({ appPath: APP_PATH, tokenPath: TOKEN_PATH, log: line => console.log('  [auth]', line) });
    const pan = createPanReader({
      appPath: APP_PATH,
      tokenPath: TOKEN_PATH,
      saveToken: next => panAuth.saveToken(next),
      log: line => console.log('  [pan]', line),
    });
    const accessToken = await pan.ensureToken();
    console.log('续期成功：access_token', shape(accessToken));

    // 3. 判据：文件变了、refresh_token 换了、其余字段还在。
    const after = await readTokenOrNull();
    const checks = [
      ['文件里有新的 access_token', typeof after?.access_token === 'string' && after.access_token !== ''],
      ['access_token 换了', after?.access_token !== before.access_token],
      ['★ refresh_token 换了（换发出来的新值真的落盘了）', after?.refresh_token !== before.refresh_token],
      ['★ 其他字段还在（合并而不是覆盖）', before.extras.every(key => key in (after ?? {}))],
    ];
    console.log('');
    for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (checks.some(([, ok]) => !ok)) {
      failure = '有判据没通过';
    } else {
      console.log('\nPASS —— 续期结果已经写回凭证文件。以后 30 天到期会自动续，不用再手动授权。');
    }
  } catch (error) {
    failure = `${error?.code ?? 'ERROR'}：${error?.message ?? error}`;
  }

  if (failure === null) {
    // 成功：文件里现在是**新的、有效的** token，备份留着也没用（旧的那个已作废）。
    await rm(BACKUP_PATH, { force: true }).catch(() => {
      console.log(`（备份删不掉，留着也无害：${BACKUP_PATH}）`);
    });
    return 0;
  }

  console.log(`\nFAIL —— ${failure}`);
  // ★ 注意：此刻旧 refresh_token 已经被消费掉了，还原备份**救不回**授权。
  //   还原只是为了不让文件里留下一份「expires_at=0」的怪状态。
  await copyFile(BACKUP_PATH, TOKEN_PATH).catch(() => {});
  console.log('已从备份还原文件（但旧的 refresh_token 已被消费，恐怕还是要重新授权一次）。');
  console.log('请到插件设置 →「电子书书架 → 百度云盘」重新走一次授权码流程。');
  return 1;
}

process.exitCode = await main();
