#!/usr/bin/env node
/**
 * 打包守卫：`npm pack` 真打一遍 → 解开 → 核对「运行时按路径找的文件」是不是都在包里。
 *
 * ---- 为什么需要这一条 ------------------------------------------------------
 *
 * 0.20 出过一次真实事故：`src/host/ocr-vision.js` 是 `osascript` **直接读**的 JXA
 * 脚本（不进 bundle），宿主半区按路径找它 —— 而它一度不在 `package.json → files`
 * 里。当时的症状是：源码里一切正常、单测全绿、`npm run dev` 好用，装到用户机器上
 * 「扫描识别」永远失败，界面上只有一句
 * `osascript: …/lib/ocr-vision.js: No such file or directory`。
 *
 * 同类风险还有 `vendor/pdfjs` 的 cmaps / standard_fonts / wasm：少了任何一片，
 * 症状是「中文 PDF 打开是空白」或「某些书打不开」，**不是**一句「文件缺失」。
 *
 * ---- 为什么不能写一条「files 里有没有这个字符串」的断言 ---------------------
 *
 *   ① 路径是**拼出来的**：`joinPath(here, '..', 'src', 'host', 'ocr-vision.js')`。
 *      产物里根本不存在 `src/host/ocr-vision.js` 这个整串（实测：`lib/index.js`
 *      里只有 `'..'`、`'src'`、`'host'`、`'ocr-vision.js'` 四段），grep 必然漏报。
 *   ② 「源码树里有」≠「包里也有」：`files` 白名单、glob 写错、`.npmignore`
 *      这三件事**只在打包这一步**才暴露。
 *   ⇒ 判据只能来自**真打包的结果**；而「需要哪些文件」必须**从代码里问出来**
 *      （直接调用 `resolvePdfjsRoot()` / `ocrScriptCandidates()`），不能在这里
 *      再抄一份清单 —— 抄的那份会和代码一起漂移，然后守卫自己变成安慰剂。
 *
 * ---- 双向一致：两个方向都要判 ----------------------------------------------
 *
 *   缺 → 用户装上就坏（上面那 0.20 事故）；
 *   多 → 包里塞了源码树里没有的残留 / 旧产物 / 测试夹具，代价是体积，以及
 *        「改了不起作用」（用户改包里的 `src/data/*.json`，实际生效的是内联副本）。
 *   所以既要判「源码树里的运行时文件全在包里」，也要判「包里每个文件都说得清为什么在」。
 *
 * 用法：
 *   node scripts/check-pack.mjs               # 正常检查
 *   node scripts/check-pack.mjs --keep        # 留下解包目录，便于手工翻
 *   node scripts/check-pack.mjs --self-check  # 反向对照：故意改坏 files，守卫必须变红
 *
 * 退出码：0 = 全过 · 1 = 有失败 · 2 = 前置条件不满足（没构建 / 打不了包）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './strip-comments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkgPath = join(root, 'package.json');
const flags = new Set(process.argv.slice(2));

/** 一次打包约 30 秒（205 个文件，`npm pack` 自己就要这么久）—— 这条检查本来就慢。 */
const PACK_TIMEOUT = 5 * 60 * 1000;

/**
 * DSH Plugin Manager 详情页的运行时展示资源。
 * 它们虽然在 docs/ 下，但不是给人读的文档源，而是 `meta.detail` 在包内指向、
 * 由宿主直接渲染的文件：缺一份，详情页就显示「文件缺失 + Retry」。
 * 具名登记，不放宽整个 docs/。
 */
const DETAIL_ASSETS = new Set(['docs/DETAIL.md', 'docs/DETAIL.zh.md', 'docs/preview.svg']);

const toPosix = (p) => p.split(sep).join('/');
const md5 = (text) => createHash('md5').update(text).digest('hex');
const sample = (list, n = 3) => (list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} …（共 ${list.length}）`);

/** 递归列文件，返回相对 `base` 的 posix 路径（排序，便于比对与复现）。 */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(toPosix(relative(base, full)));
  }
  return out.sort();
}

class Fatal extends Error {}
const fatal = (message) => {
  throw new Fatal(message);
};

/* ------------------------------------------------------------------ 主体 */

async function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  let pass = 0;
  const failures = [];
  const ok = (message) => {
    pass += 1;
    console.log(`  OK   ${message}`);
  };
  const err = (message) => {
    failures.push(message);
    console.log(`  ERR  ${message}`);
  };

  // ---- 1. 产物新鲜度 -------------------------------------------------------
  // ★ 断言读的是**产物**，就必须先钉新鲜度：否则「包里少了一段新代码」会被
  //   当成打包配置的问题，而真实原因是没人重新构建。
  const entryFiles = ['lib/index.js', 'lib/client.js'];
  for (const rel of entryFiles) {
    if (!existsSync(join(root, rel))) fatal(`缺少构建产物 ${rel} —— 先跑 npm run build`);
  }
  // ★ 只比「参与打包」的输入：`src/host/ocr-vision.js` 不进 bundle（osascript 直读），
  //   改它不影响产物；把它算进来会造出「改一句注释就红」的假警报。
  const inputs = listFiles(join(root, 'src')).filter((rel) => rel !== 'host/ocr-vision.js');
  const newestInput = Math.max(...inputs.map((rel) => statSync(join(root, 'src', rel)).mtimeMs));
  const oldestBuilt = Math.min(...entryFiles.map((rel) => statSync(join(root, rel)).mtimeMs));
  if (newestInput > oldestBuilt) {
    const lag = Math.round((newestInput - oldestBuilt) / 1000);
    err(`产物是旧的：src/ 里最新的改动比 lib/ 产物新 ${lag} 秒 ⇒ 现在打出来的包不含这次改动（先 npm run build）`);
  } else {
    ok(`产物新鲜度：src/ ${inputs.length} 个输入都早于 lib/ 产物`);
  }

  // ---- 2. 真打包 + 解包 ----------------------------------------------------
  const dest = mkdtempSync(join(tmpdir(), 'npie-pack-'));
  try {
    const npmArgs = ['pack', '--ignore-scripts', '--json', '--pack-destination', dest];
    // `--ignore-scripts` 是为了不触发 prepack 里的第二次构建（新鲜度上面已经判过）。
    // 走 `npm_execpath` 是为了用**同一个 npm**：直接敲 `npm` 在 nvm / corepack
    // 环境下可能解析到另一个版本，包出来的清单会与用户实际发布的不一致。
    const useExecPath = Boolean(process.env.npm_execpath);
    const run = spawnSync(
      useExecPath ? process.execPath : 'npm',
      useExecPath ? [process.env.npm_execpath, ...npmArgs] : npmArgs,
      { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: PACK_TIMEOUT },
    );
    if (run.status !== 0) {
      const tail = `${run.stderr ?? ''}`.trim().split('\n').slice(-3).join(' / ');
      fatal(`npm pack 失败（exit ${run.status}）：${tail || '无输出'}`);
    }
    const info = parsePackJson(run.stdout);
    const tarball = join(dest, info.filename);
    if (!existsSync(tarball)) fatal(`npm pack 说打了 ${info.filename}，但磁盘上没有这个文件`);

    const unpack = join(dest, 'unpacked');
    mkdirSync(unpack, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', tarball, '-C', unpack], { encoding: 'utf8' });
    if (tar.status !== 0) fatal(`解包失败（exit ${tar.status}）：${`${tar.stderr ?? ''}`.trim().split('\n')[0]}`);
    const packedRoot = join(unpack, 'package');
    const packedList = listFiles(packedRoot);
    const packed = new Set(packedList);
    const sizeNote = info.unpackedSize > 0 ? ` / ${(info.unpackedSize / 1024 / 1024).toFixed(1)} MB（解开后）` : '';
    ok(`真打包并解包：${packedList.length} 个文件${sizeNote}`);

    // ---- 3. 运行时按路径查找：pdf.js 的目录 --------------------------------
    // ★ 从**源码**里把解析函数拿过来真调一次。这不是「多绕一层」：
    //   探测函数的落点取决于调用方在哪个目录（`src/host/` 退两级、`lib/` 退一级），
    //   在这里重写一遍层级判断，就等于把「最容易抄错的那一步」再抄一次。
    const svc = await import(pathToFileURL(join(root, 'src', 'host', 'service.js')).href);
    const pdfjsRoot = svc.resolvePdfjsRoot();
    const pdfjsRel = toPosix(relative(root, pdfjsRoot));
    if (!existsSync(join(pdfjsRoot, 'pdf.mjs'))) {
      err(`resolvePdfjsRoot() 探测不到 pdf.mjs（返回 ${pdfjsRoot}）—— 内置解析器整块不可用`);
    } else if (!pdfjsRel.startsWith('vendor/')) {
      err(`resolvePdfjsRoot() 落到了插件根之外：${pdfjsRel}`);
    } else {
      ok(`pdf.js 落点：${pdfjsRel}（探测函数真跑，不是写死的相对路径）`);
    }

    // ---- 4. 运行时按路径查找：OCR 脚本（0.20 事故的回归判据） ---------------
    // ★ 两种运行形态各算一遍候选表，逐条要求「源码树里存在的候选，包里也必须有」。
    //   打包后走的是 `lib/` 形态 ⇒ 第二个候选正是 `<插件根>/src/host/ocr-vision.js`，
    //   它不在包里就是当年那个 bug。
    const ocrMissing = [];
    const ocrChecked = [];
    for (const form of [join(root, 'src', 'host'), join(root, 'lib')]) {
      for (const candidate of svc.ocrScriptCandidates(form)) {
        if (!existsSync(candidate)) continue; // 该形态下本来就不该存在的候选，不要求
        const rel = toPosix(relative(root, candidate));
        if (rel.startsWith('..')) continue; // 落到插件根之外，不在打包范围
        if (ocrChecked.includes(rel)) continue;
        ocrChecked.push(rel);
        if (!packed.has(rel)) ocrMissing.push(`${rel}（由 ${toPosix(relative(root, form))} 形态算出）`);
      }
    }
    if (ocrMissing.length > 0) err(`OCR 脚本没打进包：${ocrMissing.join(' / ')} ⇒ 用户装上后「扫描识别」永远失败`);
    else ok(`OCR 脚本：两种运行形态的候选 ${ocrChecked.length} 条全部在包里（${ocrChecked.join(', ')}）`);

    // 内容一致性：包里的那份必须与源码树逐字节相同（防止被截断 / 被替换成占位）
    const ocrRel = ocrChecked.find((rel) => rel.startsWith('src/'));
    if (ocrRel && packed.has(ocrRel)) {
      const same = md5(readFileSync(join(root, ocrRel), 'utf8')) === md5(readFileSync(join(packedRoot, ocrRel), 'utf8'));
      if (same) ok(`OCR 脚本内容与源码树逐字节一致（${ocrRel}）`);
      else err(`包里的 ${ocrRel} 与源码树不一致 —— 打包过程改过它？`);
    }

    // ---- 5. vendor 全树双向一致 -------------------------------------------
    // pdf.js 会按**PDF 里写的名字**去请求 `cmaps/<x>.bcmap`、`standard_fonts/<y>.pfb`，
    // 名字来自文件本身、我们事先不知道 ⇒ 不能只挑几个抽查，必须整棵树一致。
    // ★ base 传 `root`：两份清单必须**同一套命名**（都带 `vendor/` 前缀）才比得了。
    //   这里曾经用默认 base（相对 `vendor/`），结果两边 194 条全部「互不存在」。
    const srcVendor = listFiles(join(root, 'vendor'), root);
    const packedVendor = packedList.filter((rel) => rel.startsWith('vendor/'));
    const srcVendorSet = new Set(srcVendor);
    const missingVendor = srcVendor.filter((rel) => !packed.has(rel));
    const extraVendor = packedVendor.filter((rel) => !srcVendorSet.has(rel));
    const countOf = (prefix) => srcVendor.filter((rel) => rel.startsWith(prefix)).length;
    if (missingVendor.length > 0) err(`vendor/ 里 ${missingVendor.length} 个文件没打进包：${sample(missingVendor)}`);
    if (extraVendor.length > 0) err(`包里有 ${extraVendor.length} 个 vendor/ 文件在源码树里不存在（残留）：${sample(extraVendor)}`);
    if (missingVendor.length === 0 && extraVendor.length === 0) {
      ok(`vendor/ 全树一致：${srcVendor.length} 个文件（cmaps ${countOf('vendor/pdfjs/cmaps/')} / standard_fonts ${countOf('vendor/pdfjs/standard_fonts/')} / wasm ${countOf('vendor/pdfjs/wasm/')}）`);
    }

    // 体积下限：不是「数字好看」，是抓「文件在、内容空了」这一类（拷贝中断、占位文件）
    for (const [rel, min] of [['vendor/pdfjs/pdf.mjs', 200 * 1024], ['vendor/pdfjs/pdf.worker.mjs', 500 * 1024]]) {
      if (!packed.has(rel)) {
        err(`${rel} 不在包里 —— PDF 阅读整块不可用`);
        continue;
      }
      const size = statSync(join(packedRoot, rel)).size;
      if (size < min) err(`${rel} 只有 ${Math.round(size / 1024)} KB（预期 ≥ ${Math.round(min / 1024)} KB）—— 像是拷贝中断`);
      else ok(`${rel} ${Math.round(size / 1024)} KB`);
    }

    // ---- 6. 入口文件 -------------------------------------------------------
    const entries = new Set();
    const addEntry = (value) => {
      if (typeof value === 'string') entries.add(value.replace(/^\.\//, ''));
    };
    // 入口可能是 glob（0.92.0 起 `./locale/*.json` 也在 exports 里）。glob 不能当
    // 字面文件名去比对，否则 locale 真打进包了守卫仍报「入口点名的文件不在包里」。
    // 只对**包内已有的文件**做展开：既认 glob，又不放宽「必须真的在包里」这条牙。
    const expandEntry = (rel) => {
      if (!rel.includes('*')) return [rel];
      const escaped = rel.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const matcher = new RegExp(`^${escaped}$`);
      return packedList.filter((candidate) => matcher.test(candidate));
    };
    addEntry(pkg.main);
    for (const value of Object.values(pkg.exports ?? {})) {
      if (value && typeof value === 'object') for (const inner of Object.values(value)) addEntry(inner);
      else addEntry(value);
    }
    addEntry(pkg.dsh?.bundle?.patch);
    // 0.92.0：详情页文件只在 locale 的 `meta.detail` 里点名，不在 exports 里。
    // 若不登记进入口检查，删掉 files 里的 DETAIL.md 守卫照样全绿 —— 安慰剂。
    // 从两份 locale 里把 detail 路径读出来，纳入同一套「必须在包里」判据。
    for (const localeFile of ['locale/en.json', 'locale/zh.json']) {
      if (!existsSync(join(root, localeFile))) continue;
      const locale = JSON.parse(readFileSync(join(root, localeFile), 'utf8'));
      const detail = locale?.meta?.detail;
      if (typeof detail === 'string' && !detail.startsWith('/') && !detail.includes('..')) {
        addEntry(detail);
      }
    }
    // preview.svg 由 DETAIL 文档引用，同样必须随包；不在 exports 里，单独登记。
    for (const asset of DETAIL_ASSETS) addEntry(asset);
    const resolvedEntries = new Set([...entries].flatMap(expandEntry));
    const missingEntries = [...resolvedEntries].filter((rel) => !packed.has(rel));
    if (missingEntries.length > 0) err(`入口点名的文件不在包里：${missingEntries.join(', ')}`);
    else ok(`入口文件齐：${[...resolvedEntries].join(' / ')}`);

    // ★ `build.mjs` 只 `mkdirSync(lib)`、**不清理** lib：旧产物会一直留在盘上。
    //   入口没点名的 lib 文件 = 旧构建残留，会被一起发出去（用户永远加载不到它）。
    const libExtras = packedList.filter((rel) => rel.startsWith('lib/') && !entries.has(rel));
    if (libExtras.length > 0) err(`lib/ 里有入口没点名的产物（旧构建残留会一起发出去）：${sample(libExtras)}`);
    else ok('lib/ 里只有入口点名的产物');

    // ---- 7. 不该进包的 -----------------------------------------------------
    const FORBIDDEN = [
      [(rel) => rel.startsWith('test/'), '测试夹具'],
      [(rel) => rel.startsWith('scripts/'), '开发脚本'],
      [(rel) => rel.startsWith('node_modules/'), '依赖'],
      [(rel) => rel.startsWith('retired/'), '下线数据'],
      // 0.92.0：这三份不是「文档源」，而是 DSH Plugin Manager 详情页的**运行时展示资源**。
      // `meta.detail` 指向包内文档，`npm pack` 必须带上它们，否则详情页显示「文件缺失 + Retry」。
      // 只豁免这三份具名文件；docs/ 下其它文件仍属文档源，不许进包。
      [(rel) => rel.startsWith('docs/') && !DETAIL_ASSETS.has(rel), '文档源'],
      [(rel) => rel.startsWith('shots/'), '截图'],
      [(rel) => rel.startsWith('assets/'), '素材'],
      [(rel) => rel.startsWith('shared/'), '共享类型'],
      [(rel) => rel.startsWith('.github/'), 'CI 配置'],
      [(rel) => rel.startsWith('src/') && rel !== 'src/host/ocr-vision.js', '源码（只应打产物）'],
      [(rel) => rel === 'package-lock.json', '锁文件'],
      [(rel) => rel.endsWith('.map'), 'sourcemap'],
      [(rel) => rel.endsWith('.ts') || rel.endsWith('.tsx'), '类型源'],
      [(rel) => rel === '.DS_Store' || rel.endsWith('/.DS_Store'), '系统垃圾'],
      [(rel) => rel === '.env' || rel.endsWith('/.env'), '环境变量'],
    ];
    const violations = [];
    for (const rel of packedList) {
      for (const [test, why] of FORBIDDEN) {
        if (test(rel)) {
          violations.push(`${rel}（${why}）`);
          break;
        }
      }
    }
    if (violations.length > 0) err(`不该进包的 ${violations.length} 个文件进去了：${sample(violations)}`);
    else ok('不该进包的一样没进（测试 / 脚本 / 依赖 / 源码 / 锁文件 / sourcemap）');

    // ---- 8. 包里每个文件都要说得清为什么在（兜底） --------------------------
    // ★ 这一条才是「双向一致」的兜底：以后谁往 `files` 里加一个通配符，
    //   只要新进来的文件归不到下面任何一类，这里就红 —— 不需要有人记得回来加断言。
    const classify = (rel) => {
      if (rel === 'package.json') return '清单';
      if (rel === 'cordis.patch.yml') return '宿主补丁声明';
      if (rel === 'README.md' || rel === 'CHANGELOG.md') return '文档';
      if (rel === 'LICENSE') return '许可证';
      // 第三方组件的版权行与许可正文都在这里。与 LICENSE 同等地位：署名义务要求它随包。
      if (rel === 'THIRD-PARTY-NOTICES.md') return '第三方署名';
      // 编辑器产物本身不入库（约 374 KB 的构建结果），但 Milkdown 的 MIT 署名必须随包。
      if (rel === 'vendor/editor/LICENSE') return '上游编辑器署名';
      // 上游「中文独立博客」目录的内容已内联进 client.js，但**署名义务还在** ⇒ 它的
      // LICENSE 必须随包。这条不是「顺手留着的垃圾」。
      if (rel === 'vendor/chinese-independent-blogs/LICENSE') return '上游目录署名';
      if (DETAIL_ASSETS.has(rel)) return '详情页展示资源';
      // 0.92.0：Plugin Manager 在**激活插件前**读 locale 的名称/描述/详情路径与图标。
      // 它们是展示元数据，不是文档源，也不进 bundle，属于必须随包发布的文件。
      if (rel.startsWith('locale/') && rel.endsWith('.json')) return '展示元数据（locale）';
      if (rel === 'icon.svg') return '展示元数据（图标）';
      if (rel.startsWith('vendor/')) return '运行时';
      if (rel.startsWith('lib/')) return '运行时';
      if (rel === 'src/host/ocr-vision.js') return '运行时';
      return undefined;
    };
    const unknown = packedList.filter((rel) => classify(rel) === undefined);
    if (unknown.length > 0) {
      err(`包里 ${unknown.length} 个文件说不清为什么在（要么补白名单并写清用途，要么别打）：${sample(unknown)}`);
    } else {
      const tally = {};
      for (const rel of packedList) {
        const kind = classify(rel);
        tally[kind] = (tally[kind] ?? 0) + 1;
      }
      ok(`包里 ${packedList.length} 个文件全部有归属（${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' / ')}）`);
    }

    // ---- 9. 目录数据：不打包，但必须已内联进产物 ---------------------------
    // `src/data/*.json` 由 `src/client/Discover.jsx` 静态 import ⇒ esbuild 在构建期
    // 内联进 `lib/client.js`。把它们再打进包，等于同一份数据发两遍，而且制造一个
    // 假象：用户改包里的 json 就能改目录（实际生效的是内联副本，改了没用）。
    // ⇒ 两头都要判：**不打包**，且**内容真的在产物里**。后半条让「删掉白名单」这一步
    //   有据可依，也让「以后改成运行时 fetch」立刻变红。
    const discoverSrc = stripComments(readFileSync(join(root, 'src', 'client', 'Discover.jsx'), 'utf8'));
    const dataRefs = [...discoverSrc.matchAll(/from\s+'([^']+\.json)'/g)]
      .map((match) => toPosix(relative(root, join(root, 'src', 'client', match[1]))));
    const packedData = packedList.filter((rel) => rel.startsWith('src/data/'));
    if (packedData.length > 0) err(`src/data/ 里 ${packedData.length} 个文件被打进了包：${sample(packedData)} —— 构建期已内联，打进去是重复数据`);
    else ok(`src/data/ 未打包（${dataRefs.length} 份目录数据由构建期内联）`);

    if (dataRefs.length > 0 && packed.has('lib/client.js')) {
      const packedClient = readFileSync(join(packedRoot, 'lib/client.js'), 'utf8');
      const stale = [];
      for (const rel of dataRefs) {
        if (!existsSync(join(root, rel))) continue;
        const data = JSON.parse(readFileSync(join(root, rel), 'utf8'));
        const items = Array.isArray(data) ? data : (data.items ?? []);
        const probe = firstDistinctiveString(items[0]);
        if (!probe) continue; // 空目录 / 首条没有够长的字符串 ⇒ 没有可用的探针
        if (!packedClient.includes(probe)) stale.push(`${rel}（探针 ${probe}）`);
      }
      if (stale.length > 0) err(`目录数据没进产物（改了源数据但产物是旧的？）：${stale.join(' / ')}`);
      else ok(`内联自证：${dataRefs.length} 份目录数据的首条内容都在包里的 client.js 里`);
    }

    // ---- 汇总 --------------------------------------------------------------
    console.log('');
    if (failures.length > 0) {
      console.log(`打包守卫：${failures.length} 处失败 / ${pass} 项通过`);
      return 1;
    }
    console.log(`打包守卫：${pass} 项全过（${packedList.length} 个文件）`);
    if (flags.has('--keep')) console.log(`（解包目录保留在 ${unpack}）`);
    return 0;
  } finally {
    if (!flags.has('--keep')) {
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {
        // 沙箱里 unlink 可能被拦；清不掉临时目录不影响结论，也不该让守卫变红。
      }
    }
  }
}

/**
 * `npm pack --json` 的输出形状。
 *
 * ★ 不只看 JSON：老 npm 在 `--json` 下仍会往 stdout 混一行提示（实测 npm 10 干净、
 *   9 会有）。解析失败时退回「最后一行非空输出就是文件名」，比直接抛错可靠。
 */
function parsePackJson(stdout) {
  const text = `${stdout ?? ''}`.trim();
  try {
    const parsed = JSON.parse(text);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first?.filename) return first;
  } catch {
    /* 落到下面的兜底 */
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (!last.endsWith('.tgz')) fatal(`读不懂 npm pack 的输出：${sample(lines.slice(-2))}`);
  return { filename: last.split('/').pop(), unpackedSize: 0 };
}

/** 从对象里取第一个「够长、够独特」的字符串值，当作「这份数据确实内联进来了」的探针。 */
function firstDistinctiveString(value, min = 12) {
  if (typeof value === 'string') return value.length >= min ? value : undefined;
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      const hit = firstDistinctiveString(inner, min);
      if (hit) return hit;
    }
  }
  return undefined;
}

/* ------------------------------------------------------- 反向对照（有牙吗） */

/**
 * 反向对照：故意把 `files` 改坏，守卫**必须**变红。
 *
 * ★ 为什么这条对照要常驻：守卫坏掉的样子和「一切正常」长得一模一样 —— 它会一直
 *   打印 OK。只有「注入一个已知会漏文件的白名单」才能证明它真的在看包。
 * ★ 每改一次 `package.json` 都要还原：脚本被 Ctrl-C / SIGTERM 打断时 `finally`
 *   不会兜住这两个信号（Node 默认直接退出），必须显式挂处理，否则盘上留下的是
 *   被改坏的白名单 —— 而那时候 `npm test` 仍然全绿（它们不读 files）。
 */
async function selfCheck() {
  const original = readFileSync(pkgPath, 'utf8');
  const digest = md5(original);
  const put = (text) => writeFileSync(pkgPath, text);
  const onSignal = (code) => () => {
    put(original);
    console.log(`\n（被信号中断，已还原 package.json）`);
    process.exit(code);
  };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));

  const cases = [
    {
      name: '去掉 files 里的 "vendor/**/*"（模拟漏打 cmaps / 字体 / wasm）',
      apply: (pkg) => {
        pkg.files = pkg.files.filter((item) => item !== 'vendor/**/*');
      },
      expect: /vendor/,
    },
    {
      name: '去掉 files 里的 "src/host/ocr-vision.js"（0.20 那次事故本身）',
      apply: (pkg) => {
        pkg.files = pkg.files.filter((item) => item !== 'src/host/ocr-vision.js');
      },
      expect: /ocr-vision/,
    },
    {
      name: '把 "src/data/*.json" 加回 files（重复数据）',
      apply: (pkg) => {
        pkg.files = [...pkg.files, 'src/data/*.json'];
      },
      expect: /src\/data/,
    },
    {
      name: '去掉 files 里的 "docs/DETAIL.zh.md"（详情页会缺中文文件）',
      apply: (pkg) => {
        pkg.files = pkg.files.filter((item) => item !== 'docs/DETAIL.zh.md');
      },
      expect: /入口点名的文件不在包里/,
    },
    {
      name: '把 "../../etc/passwd" 写进 exports（包外路径不该被当成入口放过）',
      apply: (pkg) => {
        pkg.exports = { ...(pkg.exports ?? {}), './escape': '../../etc/passwd' };
      },
      expect: /入口点名的文件不在包里/,
    },
  ];

  let bad = 0;
  try {
    for (const item of cases) {
      const mutated = JSON.parse(original);
      item.apply(mutated);
      put(`${JSON.stringify(mutated, null, 2)}\n`);
      const run = spawnSync(process.execPath, [join(here, 'check-pack.mjs')], {
        cwd: root,
        encoding: 'utf8',
        timeout: PACK_TIMEOUT,
      });
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      const caught = run.status === 1 && item.expect.test(output);
      console.log(`${caught ? '  ★' : '  ✗'} ${item.name}`);
      console.log(`     exit=${run.status} ${caught ? '（守卫变红，有牙）' : '（守卫没变红 —— 这条判据是安慰剂）'}`);
      if (!caught) {
        bad += 1;
        for (const line of output.split('\n').filter((row) => row.includes('ERR')).slice(0, 4)) {
          console.log(`      | ${line.trim()}`);
        }
      }
      put(original);
    }
  } finally {
    put(original);
    const back = md5(readFileSync(pkgPath, 'utf8')) === digest;
    console.log(`\n还原自检 ${back ? 'ok' : 'MISMATCH'}`);
    if (!back) bad += 1;
  }

  console.log(bad === 0
    ? `\n反向对照：${cases.length} 个变异体全部被抓到 —— 打包守卫有牙`
    : `\n反向对照：${bad} 项没抓到 —— 守卫现在证明不了任何事`);
  return bad === 0 ? 0 : 1;
}

/* -------------------------------------------------------------- 入口 */

try {
  process.exitCode = flags.has('--self-check') ? await selfCheck() : await main();
} catch (error) {
  if (error instanceof Fatal) {
    console.log(`  ERR  ${error.message}`);
    console.log('\n打包守卫：前置条件不满足，检查没跑完');
    process.exitCode = 2;
  } else {
    throw error;
  }
}
