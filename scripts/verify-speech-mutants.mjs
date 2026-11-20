#!/usr/bin/env node
/**
 * 云端朗读（0.55.0）的**反向对照**：每条关键判据都要能被一个变异体打红。
 *
 * 为什么非要有这个脚本：这一批断言里有一半是「读源码 / 读返回值」的形态，
 * 而这类断言最常见的失效方式是**永远为真** —— 比如把
 *   `cloud?.configured === true ? (...) : []`
 * 写成 `(cloud?.voices ?? SILICON_VOICES)`，界面上「没配 Key 也列出云端音色」，
 * 而测试如果只断言「有 voiceGroups.remote」就照样全绿。
 * ⇒ 每条变异体必须**变红**，而且必须是**因为预期的那条断言**变红（脚本会把
 *   失败用例名打出来，人工核对一眼）。
 *
 * ★ 信号安全（踩过）：`finally` 不覆盖 `SIGTERM`。被沙箱掐掉时变异体会留在盘上，
 *   而 `npm test` 仍然全绿 —— 于是下一次构建打进的是变异体。
 *   所以：① 落盘日志 `test/.build/mut-journal.json`；② 挂 SIGINT/SIGTERM；
 *   ③ 启动时先按日志收尸。构建脚本认这份日志，`state: 'running'` 时拒绝构建。
 *
 * 运行：node scripts/verify-speech-mutants.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const JOURNAL_DIR = join(ROOT, 'test/.build');
const JOURNAL = join(JOURNAL_DIR, 'mut-journal.json');

/** 删日志；删不掉就写 done 标记（沙箱会拦删除，而留着 running 会害下次构建）。 */
function dropJournal() {
  try { rmSync(JOURNAL, { force: true }); return; } catch { /* 删不掉，往下写标记 */ }
  try { writeFileSync(JOURNAL, JSON.stringify({ state: 'done', files: {} }, null, 2)); } catch { /* 只读盘 */ }
}

/** 启动时收尸：上一次被 SIGKILL 掐掉的话，源码里还躺着变异体。 */
function recoverFromKill() {
  if (!existsSync(JOURNAL)) return;
  let saved = null;
  try { saved = JSON.parse(readFileSync(JOURNAL, 'utf8')); } catch { dropJournal(); return; }
  if (saved?.state === 'done') { dropJournal(); return; }
  for (const [file, entry] of Object.entries(saved?.files ?? {})) {
    const original = typeof entry === 'string' ? entry : entry?.original;
    const onDisk = typeof entry === 'string' ? null : entry?.onDisk;
    if (typeof original !== 'string') continue;
    const current = readFileSync(ROOT + file, 'utf8');
    if (current === original) continue;
    if (onDisk !== null && current !== onDisk) {
      console.log(`⚠ ${file} 在崩溃之后被改过，跳过还原（请自己确认）`);
      continue;
    }
    writeFileSync(ROOT + file, original);
    console.log(`⚠ 上次运行被强杀，已按日志还原 ${file}`);
  }
  dropJournal();
}
recoverFromKill();

/** 当前正在被改写的文件 → 原文。信号处理器要靠它还原。 */
const live = new Map();

function writeJournal() {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  const files = {};
  for (const [file, original] of live) {
    files[file] = { original, onDisk: readFileSync(ROOT + file, 'utf8') };
  }
  writeFileSync(JOURNAL, JSON.stringify({ state: 'running', files }, null, 2));
}

function restoreAll() {
  for (const [file, original] of live) writeFileSync(ROOT + file, original);
  live.clear();
  dropJournal();
}

process.on('SIGINT', () => { restoreAll(); process.exit(130); });
process.on('SIGTERM', () => { restoreAll(); process.exit(143); });

/**
 * 每条变异体：`from` 必须在原文里**恰好出现一次**（出现 0 次 = 锚点写错，
 * 出现多次 = 改错地方），否则直接报错，不跑测试 —— 那种「变异体没生效、
 * 测试当然全绿」是最典型的假绿。
 */
const MUTANTS = [
  {
    label: 'A 设置里的密钥不剔掉（publicSettings 失效）',
    file: 'src/host/service.js',
    from: '  delete copy.speechApiKey;',
    to: '  void copy.speechApiKey;',
    expect: 'publicSettings',
  },
  {
    label: 'B 缓存永不命中（每听一次都花钱）',
    file: 'src/host/speech.js',
    from: '    const cached = await readCache(key);',
    to: '    const cached = null;',
    expect: '命中缓存',
  },
  {
    label: 'C 200 + 空 body 也写进缓存（那篇文章从此读不出声）',
    file: 'src/host/speech.js',
    from: '      if (bytes.length === 0) {',
    to: '      if (bytes.length === -1) {',
    expect: '空 body',
  },
  {
    label: 'D 没配 Key 也照发请求（把空凭证送到公网）',
    file: 'src/host/speech.js',
    from: "    if (apiKey === '') {",
    to: '    if (apiKey === "\\u0000") {',
    expect: '没配 Key',
  },
  {
    label: 'E 并发同一段重复合成（重复计费）',
    file: 'src/host/speech.js',
    from: '    if (pending !== undefined) {',
    to: '    if (pending === null) {',
    expect: '并发',
  },
  {
    label: 'F 路由漏掉信任栅栏',
    file: 'src/host/speech-routes.js',
    from: '      if (!isTrustedLocalRequest(req)) return forbidden(res);',
    to: '      if (isTrustedLocalRequest(req) === "never") return forbidden(res);',
    expect: '403',
  },
  {
    label: 'G GET /config 回完整 Key',
    file: 'src/host/speech-routes.js',
    from: '      masked: maskApiKey(key.trim()),',
    to: '      masked: key.trim(),',
    expect: '只回掩码',
  },
  {
    label: 'H 没配 Key 也列出云端音色',
    // ★ 0.76.1 起这段逻辑搬到 `article-speech.js` 的 `speechVoiceGroups`（设置页与
    //   阅读页共用一份），**不在 ReaderPage.jsx 里**。锚点跟着搬，否则出现 0 次、
    //   这条变异体白跑（0.84.1 全量验证时实测撞上）。
    // ★ 光改静态断言还不够：`runTests()` 一并跑 `speech-prefs.test.mjs`，那是拿假
    //   voices / 假 cloud **真跑** `speechVoiceGroups`、断言 remote 为空的行为判据。
    file: 'src/client/article-speech.js',
    from: '  const remote = (cloud?.configured === true ? (cloud.voices ?? SILICON_VOICES) : [])',
    to: '  const remote = (cloud?.voices ?? SILICON_VOICES)',
    expect: '没配 Key 时不列出',
  },
  {
    label: 'I stop 之后预取的那块还能出声',
    file: 'src/client/speech-engine.js',
    from: '      if (run !== null) {\n        teardown(run);\n        run = null;\n      }\n      onState(\'idle\');',
    to: '      run = null;\n      onState(\'idle\');',
    expect: 'stop 之后预取',
  },
  {
    label: 'J 按字符而不是 UTF-8 字节计费（低估 3 倍）',
    file: 'src/speech.js',
    from: "  return new TextEncoder().encode(String(text ?? '')).length;",
    to: "  return String(text ?? '').length;",
    expect: 'UTF-8 字节',
  },
  {
    label: 'K 0.54 的裸音色名不兼容（升级后选择静默失效）',
    file: 'src/speech.js',
    from: "  return { engine: 'system', voice: raw };",
    to: "  return { engine: 'system', voice: '' };",
    expect: '裸名字',
  },
  {
    label: 'L 语速不夹边界（把 0.1 原样发出去）',
    file: 'src/speech.js',
    from: '  return Math.min(SPEECH_SPEED_RANGE.max, Math.max(SPEECH_SPEED_RANGE.min, Math.round(number * 100) / 100));',
    to: '  return number;',
    expect: '语速',
  },
];

function countOccurrences(haystack, needle) {
  let count = 0;
  let at = 0;
  for (;;) {
    const found = haystack.indexOf(needle, at);
    if (found === -1) return count;
    count += 1;
    at = found + needle.length;
  }
}

function runTests() {
  // ★ H 的行为判据在 `speech-prefs.test.mjs`（真跑 `speechVoiceGroups`），
  //   只跑 `speech.test.mjs` 的话 H 只能靠静态源码扫描，那不是「有牙」的验证。
  const result = spawnSync(process.execPath, ['--test', 'test/speech.test.mjs', 'test/speech-prefs.test.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * 从 node --test 的输出里挑出失败用例名（人工核对「是不是因为预期的那条」）。
 *
 * ★ 必须允许**行首空白**：`node --test` 把嵌套的 `it()` 缩进四级打成
 *   `    not ok 3 - …`，只匹配顶格的 `/^not ok/` 会漏掉所有真正失败的用例，
 *   只剩下一行 `not ok 7 - <describe 名>` —— 于是「红的不是预期那条」这条判据
 *   自己就成了假阳性源（第一版实测：12 条变异体全被判「红了但不是预期那条」，
 *   而它们其实全都红对了）。
 */
function failingNames(output) {
  return [...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((match) => match[1].trim());
}

console.log('基线：先跑一次未变异的测试\n');
const baseline = runTests();
if (!baseline.ok) {
  console.log('✗ 基线就是红的，先修好再谈反向对照：');
  for (const name of failingNames(baseline.output)) console.log(`   ${name}`);
  process.exit(1);
}
console.log('✓ 基线全绿\n');

let red = 0;
let bad = 0;
for (const mutant of MUTANTS) {
  const path = ROOT + mutant.file;
  const original = readFileSync(path, 'utf8');
  const occurrences = countOccurrences(original, mutant.from);
  if (occurrences !== 1) {
    console.log(`✗ ${mutant.label}`);
    console.log(`   锚点在 ${mutant.file} 里出现了 ${occurrences} 次（必须恰好 1 次）—— 变异体没生效，这条不算数`);
    bad += 1;
    continue;
  }
  live.set(mutant.file, original);
  writeJournal();
  let result;
  try {
    writeFileSync(path, original.replace(mutant.from, mutant.to));
    result = runTests();
  } finally {
    writeFileSync(path, original);
    live.delete(mutant.file);
    dropJournal();
  }
  if (result.ok) {
    console.log(`✗ ${mutant.label} —— 测试仍然全绿，这条断言没有牙`);
    bad += 1;
    continue;
  }
  const names = failingNames(result.output);
  const hit = names.some((name) => name.includes(mutant.expect));
  if (!hit) {
    console.log(`✗ ${mutant.label} —— 变红了，但红的不是预期那条（期望含「${mutant.expect}」）`);
    for (const name of names) console.log(`     红了：${name}`);
    bad += 1;
    continue;
  }
  console.log(`✓ ${mutant.label} —— 变红且报对理由`);
  red += 1;
}

console.log(`\n${red}/${MUTANTS.length} 条变异体被抓到${bad > 0 ? `，${bad} 条有问题` : '，全部有牙'}`);
process.exit(bad === 0 ? 0 : 1);
