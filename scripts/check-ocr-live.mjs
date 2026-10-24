/**
 * 真机 OCR 探针（手动跑，不进 `npm test`）。
 *
 * ★ 为什么要有它：`test/ocr.test.mjs` 里 `exec` 是**注入**的 —— 那能证明
 *   「参数怎么拼、JSON 怎么解、错了怎么报」，但证明不了**这条路真的通**：
 *   `osascript -l JavaScript` 能不能加载 JXA、Vision 认不认这张图、中文出来对不对，
 *   只有真的起一次子进程才知道。
 *
 * ★ 为什么不能放进 `npm test`：第一次调用要**加载识别模型**，实测冷启动 26–29 秒
 *   （热启动 0.5–0.8 秒）。把它塞进单测等于让每次回归都等半分钟，而且依赖 macOS。
 *
 * 用法：
 *   node scripts/check-ocr-live.mjs <图片路径> [更多图片…]
 *   node scripts/check-ocr-live.mjs            # 不传图就打印用法并退出 0
 *
 * 判据（任一不满足即非 0 退出）：
 *   1. `resolveOcrScript()` 必须探测到一个**存在**的脚本 —— 探测不到说明
 *      `package.json` 的 `files` 白名单漏了它（打包后会 501，而源码树里一切正常）；
 *   2. 每张图都要跑出 ≥1 行文字；
 *   3. 报告耗时必须落在墙钟之内（脚本自己报的 `ms` 不可能比整次调用还长）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcrRunner } from '../src/host/ocr.js';
import { resolveOcrScript } from '../src/host/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const images = process.argv.slice(2);
if (images.length === 0) {
  console.log('用法：node scripts/check-ocr-live.mjs <图片路径> [更多图片…]');
  console.log('提示：`/tmp` 里任意一张带中文的截图都可以（UI 截图也算 —— 这里验的是链路，不是排版）。');
  process.exit(0);
}

let failed = 0;
const fail = (message) => {
  failed += 1;
  console.log(`  ✗ ${message}`);
};

// ---- 1. 脚本路径必须真的存在（这是 `files` 白名单漏项的唯一现场证据） ----
const scriptPath = resolveOcrScript();
console.log(`脚本路径：${scriptPath}`);
if (!existsSync(scriptPath)) {
  fail(`脚本不存在 —— 检查 package.json 的 files 是否包含 src/host/ocr-vision.js`);
} else {
  console.log(`  ✓ 存在（${readFileSync(scriptPath, 'utf8').split('\n').length} 行）`);
  const rel = resolve(pluginRoot, 'src', 'host', 'ocr-vision.js');
  if (scriptPath !== rel) fail(`解析到 ${scriptPath}，期望 ${rel}`);
}

const runner = createOcrRunner({ scriptPath, log: (message) => console.log(`  · ${message}`) });
console.log(`平台支持：${runner.supported}${runner.unavailableReason === '' ? '' : `（${runner.unavailableReason}）`}`);
if (!runner.supported) fail('这台机器不支持本地 OCR（非 macOS，或脚本路径为空）');

// ---- 2. 每张图都要真的认出行来 ----
for (const image of images) {
  const path = resolve(image);
  console.log(`\n=== ${path} ===`);
  if (!existsSync(path)) { fail('文件不存在'); continue; }
  const bytes = readFileSync(path);
  const started = Date.now();
  try {
    const result = await runner.recognize(bytes);
    const wall = Date.now() - started;
    console.log(`  图 ${(bytes.length / 1024).toFixed(0)} KB → ${result.lines} 行 / ${result.text.replace(/\s+/g, '').length} 字`);
    console.log(`  脚本自报 ${result.ms} ms，墙钟 ${wall} ms`);
    if (result.lines < 1) fail('一行字都没认出来');
    if (result.ms > wall + 50) fail(`自报耗时（${result.ms}）比墙钟（${wall}）还长，量测口径不对`);
    for (const line of result.text.split('\n').slice(0, 6)) console.log(`    ${line}`);
  } catch (error) {
    fail(error.message);
  }
}

console.log('');
if (failed > 0) {
  console.log(`✗ ${failed} 项未通过`);
  process.exit(1);
}
console.log('✓ 全部通过');
