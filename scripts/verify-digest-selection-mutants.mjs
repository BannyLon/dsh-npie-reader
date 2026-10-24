/**
 * 变异验证：把新加的判据逐条打掉，确认对应用例真的变红。
 *
 * ★ 每个变异体都先备份原文、跑完立刻按原样写回，并用 md5 自证「写回的字节与原文
 *   完全一致」—— 变异脚本本身把源码改坏、而 `npm test` 仍然全绿，是本项目踩过的坑。
 * ★ 任何一步抛错都要在 `finally` 里还原（包括 Ctrl-C / SIGTERM：否则变异体会留在
 *   盘上，下一次跑测试会莫名其妙地红）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const md5 = (text) => createHash('md5').update(text).digest('hex');

const MUTANTS = [
  {
    name: '宿主：勾了 done 的章也照样跳过（勾选不再等于意图）',
    file: 'src/host/service.js',
    from: "      if (only === null && !force && (previous === 'done' || previous === 'skipped')) continue;",
    to: "      if (!force && (previous === 'done' || previous === 'skipped')) continue;",
    test: 'test/book-digest-run.test.mjs',
    expect: '显式勾了 done 的章',
  },
  {
    name: '宿主：模型退回用翻译那个设置项',
    file: 'src/host/service.js',
    from: 'const modelValue = typeof model === \'string\' ? model : this.digestModel();',
    to: 'const modelValue = typeof model === \'string\' ? model : this.aiModel();',
    test: 'test/book-digest-run.test.mjs',
    expect: 'digestModel 与 aiModel 互不影响',
  },
  {
    name: '宿主：循环仍然遍历全书（chapters 只用于计数）',
    file: 'src/host/service.js',
    from: '    for (const chapter of targets) {',
    to: '    for (const chapter of outline) {',
    test: 'test/book-digest-run.test.mjs',
    expect: '只调两次模型',
  },
  {
    name: '宿主：这一批的进度不记（进度条会停在全书口径）',
    file: 'src/host/service.js',
    from: 'task: { ...(current.task ?? {}), digestRunDone: runDone, digestRunTotal: targets.length },',
    to: 'task: { ...(current.task ?? {}) },',
    test: 'test/book-digest-run.test.mjs',
    expect: '这一批的进度记在 task 上',
  },
  {
    name: '路由：没带 chapters 也造一个空键',
    file: 'src/host/library-routes.js',
    from: '            if (Array.isArray(body.chapters)) {',
    to: '            if (true) {',
    test: 'test/digest-generate-routes.test.mjs',
    expect: '入参里**根本没有**这个键',
  },
  {
    name: '面板：勾选数与按钮数字各算一遍（按钮回到 plan.todo）',
    file: 'src/client/BookDigestPanel.jsx',
    from: '      : done > 0 ? `继续生成（${chosen.count} 章）` : `生成解读（${chosen.count} 章）`;',
    to: '      : done > 0 ? `继续生成（${plan.todo} 章）` : `生成解读（${plan.todo} 章）`;',
    test: 'test/book-digest-panel.test.mjs',
    expect: '按钮上的数字与调用次数',
  },
  {
    name: '面板：解读正文又回到目录列表里',
    file: 'src/client/BookDigestPanel.jsx',
    from: '                    {canPeek && (',
    to: '                    {canPeek && <span className="npr-digest-body">正文</span>}{canPeek && (',
    test: 'test/book-digest-panel.test.mjs',
    expect: '解读正文**不再**渲染在目录列表里',
  },
  {
    name: 'CSS：目录的分隔线又贴回面板左边',
    file: 'src/client/refinements.css',
    from: '.npr-book-digest { flex: 0 0 306px; width: 306px; min-width: 0; border-right: 1px solid var(--npr-border);',
    to: '.npr-book-digest { flex: 0 0 306px; width: 306px; min-width: 0; border-left: 1px solid var(--npr-border);',
    test: 'test/book-layout.test.mjs',
    expect: '分隔线各贴自己',
  },
  {
    name: 'CSS：伴读的分隔线写成右边（伴读在右，线该贴左缘）',
    file: 'src/client/refinements.css',
    from: '.npr-book-companion { flex: 0 0 348px; width: 348px; min-width: 0; border-left: 1px solid var(--npr-border); }',
    to: '.npr-book-companion { flex: 0 0 348px; width: 348px; min-width: 0; border-right: 1px solid var(--npr-border); }',
    test: 'test/book-layout.test.mjs',
    expect: '分隔线各贴自己',
  },
  {
    name: 'CSS：竖排时书页不再提前（目录会跑到上面）',
    file: 'src/client/refinements.css',
    from: '  .npr-book-main > .npr-book-stage { order: 1; }\n  .npr-book-main > .npr-companion { order: 2; }\n',
    to: '',
    test: 'test/book-layout.test.mjs',
    expect: '书页 order 1',
  },
  {
    name: 'CSS：窄容器块挪到基础规则之前（同特异度 ⇒ 竖排覆盖变死代码）',
    file: 'src/client/refinements.css',
    // 这一条只能用函数做变异：要挪的是**一整块**，而且要挪到某个锚点之前。
    // 真机症状：窄窗口下面板只有 306px 宽、右边空一大块（0.19.0 量到过）。
    mutate: (text) => {
      const start = text.indexOf('@container (max-width: 820px) {\n  .npr-book-main { flex-direction: column; }');
      if (start < 0) return null;
      const end = text.indexOf('\n}\n', start);
      if (end < 0) return null;
      const block = text.slice(start, end + 3);
      const rest = text.slice(0, start) + text.slice(end + 3);
      const at = rest.indexOf('.npr-book-main { display: flex;');
      if (at < 0) return null;
      return rest.slice(0, at) + block + rest.slice(at);
    },
    test: 'test/book-layout.test.mjs',
    expect: '窄容器块写在了',
  },
  {
    name: 'JSX：目录与书页的两块**调换位置**（目录被摆到右边）',
    file: 'src/client/BookReader.jsx',
    // 用函数做变异：要证明的是「顺序」，而顺序不是一个字符串能表达的。
    mutate: (text) => {
      const panelStart = text.indexOf('        {digestOpen && (');
      const stageStart = text.indexOf('        <div ref={stageRef} className="npr-book-stage">');
      const tail = text.indexOf('        {/* 这一章的要点');
      if (panelStart < 0 || stageStart < 0 || tail < 0 || !(panelStart < stageStart && stageStart < tail)) return null;
      const panelBlock = text.slice(panelStart, stageStart);
      const stageBlock = text.slice(stageStart, tail);
      return text.slice(0, panelStart) + stageBlock + panelBlock + text.slice(tail);
    },
    test: 'test/book-layout.test.mjs',
    expect: '目录写在书页舞台',
  },
  {
    name: 'JSX：伴读也挪到书页之前（用户当场指出的那一版）',
    file: 'src/client/BookReader.jsx',
    mutate: (text) => {
      const companionStart = text.indexOf('        {companion && (');
      const stageStart = text.indexOf('        <div ref={stageRef} className="npr-book-stage">');
      const tail = text.indexOf('        {/* 这一章的要点');
      if (companionStart < 0 || stageStart < 0 || tail < 0) return null;
      if (!(stageStart < companionStart && companionStart < tail)) return null;
      const stageBlock = text.slice(stageStart, companionStart);
      const companionBlock = text.slice(companionStart, tail);
      return text.slice(0, stageStart) + companionBlock + stageBlock + text.slice(tail);
    },
    test: 'test/book-layout.test.mjs',
    expect: '伴读写在',
  },
];

const originals = new Map();
const restore = () => {
  for (const [file, text] of originals) writeFileSync(ROOT + file, text);
};
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

let failed = 0;
try {
  for (const mutant of MUTANTS) {
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
      failed += 1;
      continue;
    }
    writeFileSync(path, mutated);
    let output = '';
    let red = false;
    try {
      output = execFileSync(process.execPath, ['--test', mutant.test], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      red = true;
    }
    writeFileSync(path, original);
    const after = md5(readFileSync(path, 'utf8'));
    const restored = before === after;
    const named = output.includes(mutant.expect);
    console.log(`${red && named ? 'OK  ' : 'MISS'} ${mutant.name}  (红=${red} 命中用例=${named} 还原=${restored})`);
    if (!(red && named && restored)) failed += 1;
  }
} finally {
  restore();
  for (const [file, text] of originals) {
    console.log(`还原自检 ${file}: ${md5(readFileSync(ROOT + file, 'utf8')) === md5(text) ? 'ok' : 'MISMATCH'}`);
  }
}
console.log(failed === 0 ? '\n全部变异体都被抓住了' : `\n有 ${failed} 个变异体没被抓住`);
process.exit(failed === 0 ? 0 : 1);
