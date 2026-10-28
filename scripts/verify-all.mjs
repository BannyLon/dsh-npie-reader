#!/usr/bin/env node
/**
 * 一条命令跑完所有门禁，**全跑 + 汇总**，不再用 `&&` 串起来。
 *
 * ---- 为什么要换掉 `npm run verify` 的 `&&` 链 ------------------------------
 *
 * 原来的写法是：
 *   `npm run build && npm test && npm run contract && … && npm run verify:mark-delete`
 *
 * 短路有三个后果，全都在本项目发生过：
 *   ① **一次只看得到第一个失败**：修好 A 再跑，才看见 B 也红。十次迭代里九次
 *      在等构建和测试重跑，而真正想看的是「还有几处红」。
 *   ② **后面的门禁从来没被执行过**：`contract --strict` 因为宿主树缺两个包一直
 *      exit 1，于是它后面那 4 个门禁（对比度 / 菜单禁用态 / Esc 顺序 / 划线删除）
 *      在 `verify` 里**一次都没跑过** —— 它们在 `package.json` 里挂着，看起来像
 *      「已在 CI 里把关」，实际是装饰。
 *   ③ 失败信息散落在滚屏里，最后一行只是某一个工具的一句话，看不出全局。
 *
 * 现在：每个门禁都跑；失败**不中断**；每条输出写进 `test/.build/verify/<name>.log`；
 * 最后打一张表 + 汇总退出码。失败时终端上直接给日志尾部，不用再去翻文件。
 *
 * ---- 为什么每个门禁都带超时 -------------------------------------------------
 *
 * 全量 `node --test` 在某些环境下跑完 `book-tools` 之后会**挂住不退出**（进程活着、
 * 没有任何输出）。挂在 `&&` 链里时症状是「verify 卡死」，人只能 Ctrl-C，然后
 * 不知道到底过了几项。超时把「卡住」变成一条明确的失败记录，剩下的门禁照常跑。
 *
 * ★ 根因已经查清（2026-10-25）：**不是插件的问题，是沙箱拦 file-delete**。
 *   `book-tools` 里 `book_export_skill` 会先删旧导出目录再写（`rm(…, {force:true})`），
 *   而沙箱把 `…/digests/l-tools/**` 的删除全部拒掉 —— 有时立刻 EPERM（用例变红），
 *   有时把进程吊住。证据：单独跑 `node --test test/book-tools.test.mjs` 会被 SIGTERM，
 *   同时沙箱逐条列出被拒的删除路径；而在没有拦截的时候同一套用例
 *   **2117 / 2117 通过、174 秒**（另一次 160 秒）。逐文件探针也证明
 *   **没有任何一个文件会真的死循环**（46 个文件各带 60 秒超时，最长 13 秒）。
 *   ⇒ 在沙箱外（用户自己的终端）跑，`test` 这一项是绿的；在沙箱里它会红，
 *     而红的原因是环境，不是代码。这条注释留在这里，免得下一个人重新诊断一遍。
 *
 * 用法：
 *   node scripts/verify-all.mjs              # 默认链（= npm run verify）
 *   node scripts/verify-all.mjs --all        # 再加 5 个重型门禁（版式 / 真机 / 变异）
 *   node scripts/verify-all.mjs --only pack,contract
 *   node scripts/verify-all.mjs --list
 *   node scripts/verify-all.mjs --bail       # 第一个失败就停（调试用）
 *
 * 退出码：0 = 全过 · 1 = 有失败（或超时）
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((item) => item.startsWith('--')));
const onlyArg = argv.find((item) => item.startsWith('--only'));
const only = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : argv[argv.indexOf(onlyArg) + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  : null;

const LOG_DIR = join(root, 'test', '.build', 'verify');

/**
 * 门禁表。
 *
 * `script` 里允许写 glob（`test/*.test.mjs`）—— 这里自己展开，因为 `spawnSync`
 * 不过 shell。这样每一跳都是「一个 node 进程 + 明确参数」，不会被引号 / 空格坑。
 *
 * ★ `nodeArgs` 与 `args` 分开：`nodeArgs` 在文件**前**（`--test` 这种必须靠前），
 *   `args` 在文件**后**（脚本自己的参数）。这个区分不是洁癖 —— 第一版只有一个
 *   `args`，`test` 那一项没处放 `--test`，于是实际执行的是
 *   `node test/ai-model.test.mjs test/book-….test.mjs …`：Node 把**第一个**当脚本、
 *   其余当 argv ⇒ 只跑了 50 条用例，而门禁报「ok 1 s」。**绿灯比红灯更危险**：
 *   它会让人以为 2117 条都过了。现在有 `expect` 兜底（见下）。
 *
 * ★ `expect`：门禁自己的验收器。跑完从输出里读一句人话结论，读不到 / 不达标就判失败。
 *   这是「守卫也要有牙」在本文件里的落点 —— 只判 exit code 的话，「什么都没跑」和
 *   「全跑过了」长得一模一样（exit 0）。
 */
const GATES = [
  { name: 'build', script: 'build.mjs', timeout: 3 * 60_000, why: '产物（lib/index.js + lib/client.js）' },
  { name: 'test', script: 'test/*.test.mjs', nodeArgs: ['--test'], timeout: 25 * 60_000, why: '全部单测', expect: tapExpect(1000) },
  { name: 'contract', script: 'scripts/check-host-contract.mjs', args: ['--strict'], timeout: 3 * 60_000, why: '宿主契约（插槽 / 锚点 / inject / 版本口径）' },
  { name: 'classes', script: 'scripts/check-classes.mjs', timeout: 2 * 60_000, why: 'CSS 类名：用到必定义、定义必有用' },
  { name: 'contrast', script: 'scripts/check-theme-contrast.mjs', timeout: 2 * 60_000, why: '主题对比度（明暗 × 六套配色）' },
  { name: 'menu', script: 'scripts/check-menu-disabled.mjs', timeout: 2 * 60_000, why: '菜单禁用态' },
  { name: 'escape', script: 'scripts/check-escape-order.mjs', timeout: 2 * 60_000, why: 'Esc 层级顺序' },
  { name: 'mark-delete', script: 'scripts/check-mark-delete.mjs', timeout: 2 * 60_000, why: '划线删除的确认 / 撤销' },
  { name: 'pack', script: 'scripts/check-pack.mjs', timeout: 6 * 60_000, why: '打包守卫（运行时按路径找的文件都在包里）' },
];

/** 重型门禁：要真机 / 要渲染 / 会改写源码跑变异。默认不跑，`--all` 才跑。 */
const HEAVY = [
  { name: 'layout', script: 'scripts/check-library-sidebar-layout.mjs', timeout: 6 * 60_000, why: '书架侧栏版式' },
  { name: 'tabs', script: 'scripts/check-tabs.mjs', timeout: 4 * 60_000, why: '切换控件两档同源（六处 × 两种侧栏宽度 + 反向对照）' },
  { name: 'book-layout', script: 'scripts/check-book-panel-layout.mjs', timeout: 6 * 60_000, why: '书页面板版式' },
  { name: 'book-reading', script: 'scripts/check-book-reading-chrome.mjs', timeout: 6 * 60_000, why: '书页阅读区（顶栏 / 浮动列）' },
  { name: 'book-skill-mutants', script: 'scripts/verify-book-skill-mutants.mjs', timeout: 10 * 60_000, why: '技能包变异验证（会临时改源码）' },
  { name: 'ocr-live', script: 'scripts/check-ocr-live.mjs', timeout: 3 * 60_000, why: '本机 OCR 真跑（要系统权限）' },
];

const ALL = [...GATES, ...HEAVY];
if (flags.has('--list')) {
  for (const gate of ALL) {
    const mark = GATES.includes(gate) ? '默认' : '重型';
    console.log(`${mark}  ${gate.name.padEnd(18)} ${gate.why}`);
  }
  process.exit(0);
}

const selected = (flags.has('--all') ? ALL : GATES).filter((gate) => !only || only.includes(gate.name));
if (selected.length === 0) {
  console.log(`没有匹配的门禁。可用：${ALL.map((gate) => gate.name).join(', ')}`);
  process.exit(1);
}

/** 展开 glob：只支持「目录 + 通配 + 后缀」这一种形状（本项目够用，且不容易写错）。 */
function expand(script) {
  if (!script.includes('*')) return [script];
  const slash = script.lastIndexOf('/');
  const dir = join(root, script.slice(0, slash));
  const pattern = script.slice(slash + 1);
  const suffix = pattern.slice(pattern.indexOf('*') + 1);
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => `${script.slice(0, slash)}/${name}`);
}

const elapsed = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * `node --test` 的验收器：读 TAP 汇总行，别只看 exit code。
 *
 * ★ 为什么必须有这一层：`node --test` 在「一个用例都没跑」时**也是 exit 0**。
 *   实测踩过 —— 门禁漏了 `--test` 标志，实际执行的是
 *   `node test/ai-model.test.mjs test/book-….test.mjs …`（Node 把第一个当脚本、
 *   其余当 argv），只跑了 50 条，而汇总表上写着「ok 1 s 全部单测」。
 *   下限 `floor` 只增不减：低于它说明有大片用例没被执行（通常是 glob 变了 / 目录改名）。
 */
function tapExpect(floor) {
  return (output) => {
    const tests = Number(/# tests (\d+)/.exec(output)?.[1] ?? NaN);
    const fail = Number(/# fail (\d+)/.exec(output)?.[1] ?? NaN);
    if (!Number.isFinite(tests) || !Number.isFinite(fail)) {
      return '读不到 TAP 汇总（# tests / # fail）—— 它没跑完，或者跑的根本不是 node --test';
    }
    if (fail > 0) return `TAP 报 ${fail} 条失败，但进程退出码是成功 —— 别信退出码`;
    if (tests < floor) return `只跑了 ${tests} 条用例（下限 ${floor}）—— 大片用例没被执行`;
    return null;
  };
}

mkdirSync(LOG_DIR, { recursive: true });
console.log(`门禁：${selected.length} 项（日志在 test/.build/verify/）\n`);

const results = [];
for (const gate of selected) {
  const files = expand(gate.script);
  const started = Date.now();
  process.stdout.write(`▶ ${gate.name.padEnd(18)}`);
  const run = spawnSync(process.execPath, [...(gate.nodeArgs ?? []), ...files, ...(gate.args ?? [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: gate.timeout,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const ms = Date.now() - started;
  const timedOut = run.error?.code === 'ETIMEDOUT' || (run.signal === 'SIGTERM' && run.status === null);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const complaint = gate.expect ? gate.expect(output) : null;
  const ok = run.status === 0 && !timedOut && complaint === null;
  writeFileSync(join(LOG_DIR, `${gate.name}.log`), output);

  results.push({ ...gate, ok, ms, timedOut, status: run.status, output, complaint });
  console.log(` ${ok ? 'ok' : (timedOut ? 'TIMEOUT' : 'FAIL')}  ${elapsed(ms)}`);
  if (complaint) console.log(`  ! ${complaint}`);

  if (!ok) {
    // 失败详情就地给尾巴：不打印的话人得自己去找日志，而「顺手看一眼」正是
    // 这类汇总最容易省掉的一步 —— 省掉之后就只剩一句「有一处失败」。
    const lines = output.trim().split('\n');
    const tail = lines.slice(-24);
    console.log(`  ┌─ ${gate.name} 输出尾部（完整日志：test/.build/verify/${gate.name}.log）`);
    for (const line of tail) console.log(`  │ ${line}`);
    console.log('  └─');
    if (flags.has('--bail')) break;
  }
}

// ---- 汇总 -------------------------------------------------------------------
const failed = results.filter((item) => !item.ok);
const skipped = selected.length - results.length;
console.log('\n' + '─'.repeat(64));
for (const item of results) {
  const mark = item.ok ? 'ok  ' : (item.timedOut ? '超时' : '失败');
  console.log(`${mark}  ${item.name.padEnd(18)} ${String(Math.round(item.ms / 1000)).padStart(4)} s   ${item.why}${item.complaint ? `   ← ${item.complaint}` : ''}`);
}
console.log('─'.repeat(64));

if (failed.length === 0 && skipped === 0) {
  console.log(`全过：${results.length} 项门禁`);
  process.exit(0);
}
if (failed.length > 0) {
  console.log(`失败 ${failed.length} / ${results.length}：${failed.map((item) => item.name).join(', ')}`);
}
if (skipped > 0) console.log(`（因 --bail 未跑：${skipped} 项）`);
process.exit(1);
