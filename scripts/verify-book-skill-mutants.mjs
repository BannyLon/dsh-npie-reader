/**
 * 变异验证（0.20.0）：把「导出成 skill 包」这一层的判据逐条打掉，确认用例真的变红。
 *
 * ★ 为什么单独一份而不是塞进 `verify-digest-selection-mutants.mjs`：那一份守的是
 *   0.19.0 的勾选/模型/布局，跑一轮要几分钟。这一层是新加的，锚点全在不同文件里，
 *   混在一起之后「哪条变异体守哪条判据」会变得看不出来。
 *
 * ★ 骨架照抄既有那份（这是本项目验证过的写法）：
 *   · 每个变异体先备份原文、跑完立刻按原样写回，并用 md5 自证字节完全一致；
 *   · 任何一步抛错都在 `finally` 里还原，并且挂 `SIGINT` / `SIGTERM` ——
 *     `finally` **不覆盖信号**，不挂的话 Ctrl-C 会把变异体留在盘上，
 *     而下一次跑 `npm test` 会莫名其妙地红（本项目踩过）。
 *
 * ★ 每个变异体都点名一条**用例名**（`expect`）：只要求「跑红了」是不够的 ——
 *   一个语法错误也能让整个文件变红，那证明不了那条判据有牙。
 *
 * ★★ 0.20.0 又加了一层：**落盘日志**（`test/.build/mut-journal.json`）。
 *   起因是实测踩到的：这个脚本被 SIGKILL 掐掉（后台任务被回收）时，`finally` 与
 *   SIGTERM 处理器**都不会跑**，于是 `src/host/tools.js` 上的变异体
 *   （`raw: args.raw !== false`）留在了盘上 —— 而它看起来完全正常，
 *   下一次 `npm test` 会莫名其妙地红，且症状离原因很远。
 *   ⇒ 每次改写前把**原文**写进日志；脚本**启动时**先检查日志，有残留就先还原
 *   并大声说出来。SIGKILL 拿不走已经落盘的东西。
 *
 * ★★ 0.20.0 的第三层：**基线闸**（每个测试文件先不带变异跑一遍）。
 *   变异测试最容易出的假绿是「用例本来就红」：那样**每一个**变异体都会显示
 *   「抓住了」，而变异体到底有没有牙一点也看不出来。实测踩到的正是这一种 ——
 *   沙箱开始拒绝删除 `/var/folders/**` 之后，`book-tools.test.mjs` 里三条
 *   「清掉上一次的残留 / 没有解读时抛错」的用例直接在 `unlink` 上 EPERM，
 *   于是那三个变异体即使把源码改坏也「红」。
 *   ⇒ 基线红的文件**整组跳过**并写明原因，不参与「抓住」的计数；
 *   脚本只在「基线绿」的变异体上给结论。
 *
 * ★ 每次跑测试都带 `timeout`：`execFileSync` 是同步阻塞的，一个挂住的用例
 *   （本项目实测：收尾钩子里 `rm` 被安全删除代理卡住）会让整个脚本永久停住，
 *   而**信号也进不来** —— 事件循环被占着，`SIGTERM` 处理器要等它返回才跑。
 *   只能靠外层杀掉，杀掉就留下「源码还是变异的」现场。超时让它自己退出来并报 HANG。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const md5 = (text) => createHash('md5').update(text).digest('hex');

const JOURNAL_DIR = `${ROOT}test/.build`;
const JOURNAL = `${JOURNAL_DIR}/mut-journal.json`;

/**
 * 启动时先收尸：上一次如果是被 SIGKILL 掐掉的，日志还在，源码里就还躺着变异体。
 * ★ 这里**先还原再继续**，而不是只报个警告 —— 用户跑这个脚本的目的是验证判据，
 *   不是来手动修源码的。
 */
/**
 * 删日志；删不掉就写一个 `done` 标记。
 * ★ 必须留标记，不能「删不掉就算了」：实测踩过 —— 沙箱禁止删除时 `rmSync` 抛错，
 *   上一次**正常跑完**的日志留在盘上，下一次启动把它当成「上次被强杀」，
 *   于是用旧内容覆盖了刚改好的源码（`skillSlugFor` 被抹掉，基线当场变红）。
 *   日志只在 `state === 'running'` 时才有权还原。
 */
const dropJournal = () => {
  try {
    rmSync(JOURNAL, { force: true });
    return;
  } catch {
    // 删不掉：往下写标记。
  }
  try {
    writeFileSync(JOURNAL, JSON.stringify({ state: 'done', files: {} }, null, 2));
  } catch {
    // 连标记也写不了就算了 —— 那时磁盘基本是只读的。
  }
};

function recoverFromKill() {
  if (!existsSync(JOURNAL)) return;
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(JOURNAL, 'utf8'));
  } catch {
    dropJournal();
    return;
  }
  if (saved?.state === 'done') {
    dropJournal();
    return;
  }
  let restored = 0;
  for (const [file, entry] of Object.entries(saved?.files ?? {})) {
    // 兼容第一版格式（值是原文本身，没有 onDisk）。
    const original = typeof entry === 'string' ? entry : entry?.original;
    const onDisk = typeof entry === 'string' ? null : entry?.onDisk;
    if (typeof original !== 'string') continue;
    const current = readFileSync(ROOT + file, 'utf8');
    if (current === original) continue;
    if (onDisk !== null && current !== onDisk) {
      // ★ 盘上既不是原文、也不是我们写下去的变异体 ⇒ 崩溃之后有人改过它。
      //   这时候「还原」等于用更旧的版本盖掉新代码。
      console.log(`⚠ ${file} 在崩溃之后被改过，跳过还原（请自己确认）`);
      continue;
    }
    writeFileSync(ROOT + file, original);
    restored += 1;
    console.log(`⚠ 上次运行被强杀，已按日志还原 ${file}`);
  }
  if (restored > 0) console.log(`（共 ${restored} 个文件）\n`);
  dropJournal();
}
recoverFromKill();

const journalWrite = (map) => {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  const files = {};
  for (const [file, original] of map) {
    files[file] = { original, onDisk: readFileSync(ROOT + file, 'utf8') };
  }
  writeFileSync(JOURNAL, JSON.stringify({ state: 'running', files }, null, 2));
};
const journalClear = dropJournal;

const SKILL = 'src/host/book-skill.js';

const MUTANTS = [
  // ---- 书型判定 ---------------------------------------------------------
  {
    name: '书型：代码密度这条判据被打掉（技术书判不出来）',
    file: SKILL,
    from: 'if (codeDensity >= CODE_DENSITY) {',
    to: 'if (false) {',
    test: 'test/book-skill.test.mjs',
    expect: '代码密集 ⇒ technical',
  },
  {
    name: '书型：对话密度这条判据被打掉（小说判不出来）',
    file: SKILL,
    from: 'if (dialogueDensity >= DIALOGUE_DENSITY) {',
    to: 'if (false) {',
    test: 'test/book-skill.test.mjs',
    expect: '对话密集 ⇒ fiction',
  },

  // ---- 术语表 -----------------------------------------------------------
  {
    name: '术语表：主条退回「按输入顺序」（换个人调用就换一条主解释）',
    file: SKILL,
    from: 'if (entry.n < found.primary) {',
    to: 'if (false) {',
    test: 'test/book-skill.test.mjs',
    expect: '同一个词跨章 ⇒ 一条，章号合并并升序',
  },
  {
    name: '术语表：章号渲染回退成「第 1 章、第 3 章」（与模块自己的契约不符）',
    file: SKILL,
    from: '        ? `第 ${entry.chapters[0]} 章`\n        : `第 ${entry.chapters.join(\'、\')} 章`;',
    to: '        ? `第 ${entry.chapters[0]} 章`\n        : entry.chapters.map(n => `第 ${n} 章`).join(\'、\');',
    test: 'test/book-skill.test.mjs',
    expect: 'glossary.md 的每一条都带章号',
  },
  {
    name: '术语表：空词也进表（垃圾条目）',
    file: SKILL,
    from: "      if (name === '') continue;",
    to: '      if (false) continue;',
    test: 'test/book-skill.test.mjs',
    expect: '空词 / 空 note 不产生垃圾条目',
  },

  // ---- 整套文件 ---------------------------------------------------------
  {
    name: '索引层：SKILL.md 少写最后一章的索引行',
    file: SKILL,
    from: 'const indexRows = chapters.map((chapter) => {',
    to: 'const indexRows = chapters.slice(0, -1).map((chapter) => {',
    test: 'test/book-skill.test.mjs',
    expect: '两两性质',
  },
  {
    name: '横向页：不再声明自己是「原样摘录」（让 agent 把要点当结论）',
    file: SKILL,
    from: "    '> 这次导出**没有**做跨章综合（那需要一次额外的模型调用）。下面是各章要点的**原样摘录**，',",
    to: "    '',",
    test: 'test/book-skill.test.mjs',
    expect: '明说自己是「原样摘录」',
  },
  {
    name: '未解读的章：文件里不再说明（看起来像解读被丢了）',
    file: SKILL,
    from: "    lines.push('这一章还没有解读（未生成、或正文不足 200 字被略过）。', '');",
    to: "    lines.push('', '');",
    test: 'test/book-skill.test.mjs',
    expect: '未解读的章也有一份文件',
  },
  {
    // ★ 上一版这条变异体写的是「放宽字符类，允许大写」—— 它**永远抓不住**，
    //   因为源码在 replace 之前已经 `.toLowerCase()` 了，放宽字符类等于没改。
    //   一个跑不红的变异体只会让人以为「判据有牙」，其实什么也没证明。
    //   换成真的能破坏跨模块契约的：回退名里带 `/`（路径穿越）。
    name: '目录名：中文标题的回退名带斜杠（会跑出 skills 目录）',
    file: SKILL,
    from: "return `book-${String(bookId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;",
    to: "return `book/${String(bookId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;",
    test: 'test/book-skill.test.mjs',
    expect: '与 digest-store 的闸必须一致',
  },
  {
    name: '跨章综合：两段都空也返回对象（产出两个空文件还说是综合的）',
    file: SKILL,
    from: "        if (patterns === '' && cheatsheet === '') return null;",
    to: '        if (false) return null;',
    test: 'test/book-skill.test.mjs',
    expect: '两段都空',
  },

  // ---- 工具层 -----------------------------------------------------------
  {
    name: 'book_chapter：默认给原文（一章 10 倍 token）',
    file: 'src/host/tools.js',
    from: '          raw: args.raw === true,',
    to: '          raw: args.raw !== false,',
    test: 'test/book-tools.test.mjs',
    expect: '默认返回解读',
  },
  {
    name: 'book_export_skill：默认就去调模型（说好的不花钱）',
    file: 'src/host/tools.js',
    from: '          synthesize: args.synthesize === true,',
    to: '          synthesize: args.synthesize !== false,',
    test: 'test/book-tools.test.mjs',
    expect: '不调模型也能导出',
  },

  // ---- 路由层 -----------------------------------------------------------
  {
    name: '路由：synthesize 用真值转换（"false" 也会花钱）',
    file: 'src/host/library-routes.js',
    from: '              synthesize: body.synthesize === true,',
    to: '              synthesize: Boolean(body.synthesize),',
    test: 'test/book-skill-routes.test.mjs',
    expect: 'synthesize 只认真布尔',
  },
  {
    name: '路由：没带 model 也造一个键（下游会报「模型格式不对」）',
    file: 'src/host/library-routes.js',
    from: "            if (typeof body.model === 'string' && body.model.trim() !== '') {",
    to: '            if (true) {',
    test: 'test/book-skill-routes.test.mjs',
    expect: '没带 profile ⇒ auto',
  },

  // ---- 磁盘层 -----------------------------------------------------------
  {
    name: '写盘：导出前不删旧目录（上次的残骸混进这次）',
    file: 'src/host/digest-store.js',
    from: '    await rm(dir, { recursive: true, force: true });',
    to: '    void dir;',
    test: 'test/book-tools.test.mjs',
    expect: '重新导出会清掉上一次的残留章文件',
  },
];

const originals = new Map();
const restore = () => {
  for (const [file, text] of originals) writeFileSync(ROOT + file, text);
};
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

/** 跑一个测试文件，返回 `{ red, hung, output }`。 */
const RUN_TIMEOUT = 120_000;
function runTest(file) {
  try {
    const output = execFileSync(process.execPath, ['--test', file], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: RUN_TIMEOUT, killSignal: 'SIGKILL',
    });
    return { red: false, hung: false, output };
  } catch (error) {
    return {
      red: true,
      hung: error?.code === 'ETIMEDOUT',
      output: `${error?.stdout ?? ''}${error?.stderr ?? ''}`,
    };
  }
}

// ★ 基线闸：先证明「不打变异时这些用例是绿的」。理由见文件头。
const baselines = new Map();
for (const file of new Set(MUTANTS.map((mutant) => mutant.test))) {
  const result = runTest(file);
  baselines.set(file, result);
  if (!result.red) {
    console.log(`基线 ${file}: 绿`);
    continue;
  }
  const notOk = (result.output.match(/^not ok /gm) ?? []).length;
  const eperm = (result.output.match(/code: 'EPERM'/g) ?? []).length;
  console.log(
    `基线 ${file}: **红**（${result.hung ? '跑不完、被超时掐掉' : `${notOk} 个 not ok，其中 ${eperm} 处 EPERM`}）`
    + ` ⇒ 这一组的变异体本轮无法验证`,
  );
}
console.log('');

let missed = 0;
let skipped = 0;
let hungCount = 0;
let caught = 0;
try {
  for (const mutant of MUTANTS) {
    // ★ 基线红的文件整组跳过：这种情况下「变红」不证明任何事。
    if (baselines.get(mutant.test)?.red === true) {
      console.log(`SKIP ${mutant.name}: 基线红，变异体跑红了也说明不了问题`);
      skipped += 1;
      continue;
    }
    const path = ROOT + mutant.file;
    const original = originals.get(mutant.file) ?? readFileSync(path, 'utf8');
    originals.set(mutant.file, original);
    const before = md5(original);
    let mutated = null;
    if (typeof mutant.mutate === 'function') {
      mutated = mutant.mutate(original);
    } else if (original.includes(mutant.from)) {
      mutated = original.replace(mutant.from, mutant.to);
    }
    if (mutated === null || mutated === original) {
      console.log(`?? ${mutant.name}: 找不到锚点，变异体无效`);
      missed += 1;
      continue;
    }
    writeFileSync(path, mutated);
    // ★ 先落日志**再**跑测试：跑测试这一步最可能被强杀（它要几秒到几十秒）。
    journalWrite(originals);
    const { red, hung, output } = runTest(mutant.test);
    writeFileSync(path, original);
    const after = md5(readFileSync(path, 'utf8'));
    const restored = before === after;
    const named = output.includes(mutant.expect);
    const good = red && named && restored && !hung;
    if (hung) hungCount += 1;
    else if (good) caught += 1;
    else missed += 1;
    console.log(
      `${hung ? 'HANG' : good ? 'OK  ' : 'MISS'} ${mutant.name}`
      + `  (红=${red} 命中用例=${named} 还原=${restored}${hung ? ' 超时' : ''})`,
    );
  }
} finally {
  restore();
  journalClear();
  for (const [file, text] of originals) {
    console.log(`还原自检 ${file}: ${md5(readFileSync(ROOT + file, 'utf8')) === md5(text) ? 'ok' : 'MISMATCH'}`);
  }
}
const total = MUTANTS.length;
console.log(`\n抓住 ${caught} / 没抓住 ${missed} / 基线红未验证 ${skipped}${hungCount > 0 ? ` / 超时 ${hungCount}` : ''}（共 ${total} 个变异体）`);
if (missed > 0 || hungCount > 0) process.exit(1);
if (skipped > 0) {
  // ★ 不把「没验证」说成「通过」。宁可让这条命令以 2 退出，也不要给一个假的合格证。
  console.log('⚠ 有变异体因基线红未验证 —— 这不是「通过」，是「没验证」。先修环境再跑。');
  process.exit(2);
}
console.log(`全部 ${total} 个变异体都被抓住了`);
process.exit(0);
