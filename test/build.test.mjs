/**
 * 构建产物守卫。
 *
 * ★ 为什么需要它：`node --test` **不会**跑 `build.mjs`，而有一整类错误只有打包器抓得到 ——
 *   典型的就是「在 CSS 模板串的注释里写了反引号」，模板串提前闭合 ⇒ 整个 .jsx 语法错误。
 *   实测踩过一次：`PANEL_CSS` 的窗口拖动注释里给 `data-window-drag` 加了反引号，
 *   测试全绿（因为测试只读源码字符串，不做解析），`node build.mjs` 直接失败。
 *
 * 这里跑一次真构建，然后**在产物里**核几件只有产物才知道的事：
 *   - 构建能过（语法/解析/打包全链路）；
 *   - 新增的 Remote 方法真的进了两个半区（不是只在源码里存在）；
 *   - 拖动标记没被 tree-shake 掉。
 *
 * ★ 中文在产物里是 `\uXXXX`，所以下面一律断言 ASCII 标识符或注释里的英文，
 *   不断言中文原文（那会得到一个「看着对、其实永远查不到」的假绿）。
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// 一次构建，三条用例共用。`--test` 会把同一个文件的所有用例放在一个进程里，所以放顶层。
const build = spawnSync(process.execPath, ['build.mjs'], { cwd: pluginRoot, encoding: 'utf8' });

const hostBundle = () => readFileSync(join(pluginRoot, 'lib', 'index.js'), 'utf8');
const clientBundle = () => readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8');

/**
 * 产物里**非第一方**的字节数（依赖被内联时它会立刻暴涨）。
 *
 * ★ 为什么这才该是主判据：老口径量的是「产物的绝对字符数」。可本项目的第一方代码
 *   已经涨到 ~926 KB —— CSS 以文本原样内联、JSX 全在里面、中文注释被 esbuild 转成
 *   `\uXXXX`（一个字 6 个字符）。于是绝对阈值只能一轮一轮往上抬
 *   （800K → 860K → 900K → 940K → 960K，五次），**每抬一次它离真正的目标就远一步**：
 *   那不是维护，是钝化。而这条守卫自己声称要抓的一直是「有没有整个依赖被内联进来」。
 *   直接量那件事：正常值恒为 0；内联 pdf.mjs ⇒ +512 KB，pdf.worker.mjs ⇒ +1.3 MB，
 *   react ⇒ +130 KB，三个都远远越过阈值。
 *
 * ★ 判据的依据是 esbuild 在**不 minify** 时给每个模块插的那行 `// <path>`。
 *   本项目刻意不 minify（产物要能在真机上读调用栈），所以那行一定在 ——
 *   但这是个**前提**，不是事实。哪天有人打开 minify，本判据会静默退化成「恒为 0」，
 *   所以下面配了一条「前提还在吗」的用例钉住它。
 */
function foreignBytes(text) {
  let foreign = 0;
  let inForeign = false;
  for (const line of text.split('\n')) {
    const mark = /^\/\/ (.+)$/.exec(line);
    if (mark !== null) {
      inForeign = /(^|\/)node_modules\//.test(mark[1]);
      continue;
    }
    if (inForeign) foreign += line.length + 1;
  }
  return foreign;
}

describe('构建', () => {
  it('node build.mjs 能过（语法错误只有这一步抓得到）', () => {
    assert.equal(build.status, 0, `构建失败：\n${build.stdout ?? ''}\n${build.stderr ?? ''}`);
  });

  it('两个半区的产物都非空且真的被重写过', () => {
    assert.ok(statSync(join(pluginRoot, 'lib', 'index.js')).size > 1000);
    assert.ok(statSync(join(pluginRoot, 'lib', 'client.js')).size > 1000);
  });
});

describe('产物里的接线（源码里有 ≠ 打进去了）', () => {
  it('Host 半区带上了四个目录方法', () => {
    const text = hostBundle();
    for (const name of ['listCatalog', 'addCatalogSource', 'removeCatalogSource', 'setCatalogHidden']) {
      assert.ok(text.includes(name), `Host 产物里找不到 ${name}`);
    }
  });

  it('Client 半区带上了粘贴订阅、转 RSS 配置与拖动标记', () => {
    const text = clientBundle();
    for (const token of ['npr-discover-drop', 'npr-service-probe', 'data-window-drag']) {
      assert.ok(text.includes(token), `Client 产物里找不到 ${token}`);
    }
    // 反向对照：0.5.0 拆掉的「添加信息源」表单不该还留在产物里（拆了半截最糟：
    // 界面没了、样式与事件还在，下一次改这块的人会以为它还被用着）。
    for (const gone of ['npr-discover-addsource', 'npr-discover-addform', 'npr-discover-catpick']) {
      assert.ok(!text.includes(gone), `Client 产物里还留着已拆除的 ${gone}`);
    }
  });

  it('反向对照：产物里没有「拖动反向标记」——那个是 no-drag，打错等于关掉拖动', () => {
    // ★ 必须在**去注释后**的产物上查：源码的 CSS 注释里抄着宿主 base.css 的规则
    //   原文（含 `data-window-drag-recall`），直接 includes 会把「文档写得详细」
    //   判成「代码打错了」—— 实测踩过。
    const code = stripComments(clientBundle());
    assert.ok(!code.includes('data-window-drag-recall'), '产物里出现了 no-drag 反向标记');
    // ★ 交叉校验：剥离器要是把产物剥坏了（多剥），上面那条会变成恒真式。
    //   所以同一条用例里必须证明「该在的还在」。
    assert.ok(code.includes('data-window-drag'), '剥离后连正向标记都没了 ⇒ 上一条断言已失效');
    assert.ok(code.includes('npr-sidebar-toolbar'), '剥离后连类名都没了 ⇒ 断言已失效');
  });
});

describe('书架（电子书）的接线', () => {
  it('Host 半区带上了取字节、书单索引与两条路由', () => {
    const text = hostBundle();
    for (const name of ['makeLibraryRoutes', 'createPanReader', 'readLibraryIndex', 'isTrustedLocalRequest', 'resolvePdfjsRoot']) {
      assert.ok(text.includes(name), `Host 产物里找不到 ${name}`);
    }
    // 两个前缀是**共用常量**，必须都进产物（客户端按它拼 URL，宿主按它注册）。
    for (const prefix of ['/api/dsh-npie-reader/library', '/vendor/npie-reader/pdfjs']) {
      assert.ok(text.includes(prefix), `Host 产物里找不到前缀 ${prefix}`);
    }
  });

  it('Client 半区带上了书架界面、pdf.js 传输层与两个前缀', () => {
    const text = clientBundle();
    for (const token of [
      'npr-book-toolbar', 'npr-viewswitch', 'npr-book-stage', 'npr-badge-reading',
      'PDFDataRangeTransport', 'pdfjsAsset',
      '/api/dsh-npie-reader/library', '/vendor/npie-reader/pdfjs',
    ]) {
      assert.ok(text.includes(token), `Client 产物里找不到 ${token}`);
    }
  });

  it('★ Client 半区**没有**被拖进任何 Node 内建模块（它跑在浏览器里）', () => {
    // 这条是「共用判据模块不许 import node:*」那条结构性断言的**产物级**对照：
    // 源码干净不代表打包后干净（一个间接 import 就能把 shim 拖进来，而且不报错）。
    const text = clientBundle();
    for (const forbidden of ['node:fs', 'node:path', 'node:os', 'node:url', 'createPanReader', 'readLibraryIndex']) {
      assert.ok(!text.includes(forbidden), `Client 产物里出现了 ${forbidden} —— 宿主半区的东西漏进浏览器了`);
    }
  });

  it('★ pdf.js 保持**动态**导入、没有被内联进客户端 bundle', () => {
    // 内联会让 bundle 从 ~516 KB 涨到 1 MB 以上，而且首屏就要解析 512 KB 的 pdf.js。
    const text = clientBundle();
    assert.match(text, /import\(\s*pdfjsAsset\(\s*"pdf\.mjs"\s*\)\s*\)/, '动态导入的写法变了（可能被内联了）');
    assert.ok(!text.includes('pdfjsVersion'), 'pdf.js 源码被内联进客户端 bundle 了');
    /**
     * ★ 0.27.0 起，**主判据换成「非第一方字节数」**，绝对体积只当兜底。
     *
     *   历史（五次抬数字，全部记录在这里，不删）：800K → 860K → 900K → 940K → 960K。
     *   每次抬之前都量过「本轮新增是依赖还是自己的代码」，每次结论都是「自己的代码」。
     *   0.27.0 这一轮实测 968,607，超出 8,607 —— 触发点只是两个新面板段落 + 一个
     *   格式化模块 + 一段 CSS。这条判据已经**退化成一个「代码量计步器」**，
     *   而它原本要守的东西（依赖被内联）今天可以由 `foreignBytes` 精确量到 0。
     *   ⇒ 不再抬那个「刚好卡住」的数字，改成：
     *     ① 依赖内联 ⇒ `foreignBytes` 立刻暴涨（正常 0，容差只留给 esbuild 的运行时辅助）；
     *     ② 绝对上限只为挡住「第一方代码涨到荒谬」这一种情况。
     *   pdf.mjs 内联后 = 926 KB + 512 KB ≈ 1.44 MB，仍然撞得破 ①。
     *
     * ★ 0.67.0 抬到 1.56 MB（论文视图）。量过，不是估的：
     *   - 加论文之前，工作区里那份在途改动已经把产物顶到 **1,404,943**
     *     （旧闸 1,400,000 那时就已经破了 4,943，与本轮无关）；
     *   - 加论文之后 **1,477,596**，净增 **72,653**：`PapersApp.jsx` 29.9 KB
     *     （含中文注释，esbuild 把非 ASCII 转成 `\uXXXX`，一个汉字 6 字节）、
     *     `paper-api.js` 2.4 KB、论文那段 CSS ≈ 7 KB，其余是 ViewSwitch / ReaderPage
     *     的四视图接线。
     *   - 留给以后的余量 ≈ 82 KB。**若下一次要抬，请先分开量「新增是依赖还是
     *     自己的代码」**：`foreignBytes` 必须仍是 0，否则抬数字就是在替内联开绿灯。
     * ★ 0.71.3 抬到 1.58 MB（中/英查看 + 缓存回执）。仍然先量再抬：
     *   - 本轮实测 **1,561,065 字符**，旧闸 1,560,000 **只超 1,065** —— 不是暴涨，
     *     是长期涨到边界上（0.71.2 那次是 1,558,7xx，差 1 KB 多）；
     *   - `foreignBytes` 仍为 0：增的是「中/英」那颗胶囊、`translatedPageCount()`
     *     读数、落盘失败的一次性提示，以及两段 CSS，全是第一方；
     *   - 新闸 1,580,000，余量 ≈ 19 KB。下一次再要抬，请照旧先分开量依赖与自有代码。
     * ★ 0.72.0 抬到 1.60 MB（灵感速记的取值 / 落盘 / 回执整条路）。先量再抬：
     *   - 本轮实测 **1,584,136 字符**，旧闸 1,580,000 只超 **4,136**（0.26%），
     *     同样是涨到边界上，不是暴涨；
     *   - `foreignBytes` 仍为 0：增的是一整块新的第一方逻辑 ——
     *     `quick-draft.js`（草稿过期 / 坏数据 / 时间说法 / 回执组句 / 撤销前核对 /
     *     引用块 / 标签候选 / 补全光标，约 200 行含注释）＋ `QuickCapture.jsx` 的
     *     恢复行与候选行 ＋ 浮层里那段 CSS。`esbuild` 不做 minify，注释原样进产物，
     *     所以「写得清楚」在这条闸上是要付字符的；
     *   - 新闸 1,600,000，余量 ≈ 16 KB。下一次再要抬，请照旧先分开量依赖与自有代码。
     * ★ 0.75.0 抬到 1.64 MB（删掉某一天的全部记录）。照旧先量再抬：
     *   - 本轮实测 **1,599,194 字符**，旧闸 1,600,000 **只差 806**（0.05%）——
     *     又是「长期涨到边界上」，不是暴涨；
     *   - `foreignBytes` 仍为 0（下面那条断言过），增的全是第一方：
     *     宿主 `removeDay()` 一整套判断（一次 `rename` 到 `_trash/`、只动 scope
     *     那一半、解不开的私密文件仍允许删）≈ 60 行含注释，`DELETE /day/:date`
     *     一条分支，客户端一个幽灵按钮 + 一个确认框 + 状态与派生 ≈ 130 行，
     *     以及两段 CSS。`esbuild` 不 minify，注释原样进产物 —— 「写得清楚」
     *     在这条闸上是要付字符的；
     *   - 新闸 1,640,000，余量 ≈ 41 KB。下一次再要抬，请照旧先分开量。
     * ★ 0.77.0 抬到 1.70 MB（论文伴读的身份分叉）。照旧先量再抬，但**这次的涨幅
     *   不是代码长出来的**，必须写清楚，免得下一个人以为是功能膨胀：
     *   - 本轮实测 **1,661,639 字符**，上一轮记的是 1,599,194，差 **62,445**；
     *   - 按模块量（esbuild metafile，临时探针，未入库）：`refinements.css` 219 KB、
     *     `ReaderPage` 166 KB、`DiaryApp` 157 KB、`BookReader` 101 KB、
     *     `PapersApp` 41 KB，另外两个随仓库走的 JSON 数据文件 172 KB
     *     （`independent-blogs` 111 KB、`catalog-health` 61 KB）—— **没有单个爆掉的模块**，
     *     `foreignBytes` 仍为 0；
     *   - 差额对得上的是**注释**：`esbuild` 把非 ASCII 转成 `\uXXXX`，一个汉字占
     *     6 字节。本轮为「论文与电子书为什么共用、判据为什么是 `source` 而不是
     *     `format`、摘要上限为什么是 4000」写了约 300 行说明，折到产物里就是这个量级。
     *     也就是说：这条闸量的是「产物字节」，而本项目把**为什么这么写**当成
     *     一等公民 —— 两者天然打架，只能记账，不能靠删注释来讨好它；
     *     → **上面这段的前提已被 0.78.0 实测推翻**（注释不进产物），保留原文只为
     *       不让历史数字凭空消失；读到这里请以 0.78.0 那段为准；
     *   - 新闸 1,700,000，余量 ≈ 37 KB。
     *
     * ★ 0.78.0 抬到 1.72 MB（翻译进度与整本确认卡）。照旧先分开量：
     *   - 本轮实测 **1,697,850 字符**（上一轮 1,670,961，差 **26,889**；中途量到
     *     1,691,737 是在「胶囊挪到正中 + 暂停/关闭」之前）；
     *   - 按模块量（esbuild metafile，临时探针，未入库）：`refinements.css` 227 KB、
     *     `ReaderPage` 166 KB、`DiaryApp` 157 KB、`BookReader` 103 KB、`BookEbook` 74 KB、
     *     `PapersApp` 46 KB，两个随仓库走的 JSON 172 KB —— **没有单个爆掉的模块**；
     *   - 新增的是三处：`WholeBookConfirm.jsx` 7 KB（新组件）、`paper-translation.js`
     *     11 → 15 KB（单页任务态 + 并发分批 + 估算 + 取消）、`PaperTranslateLayer.jsx` 9 KB；
     *   - 差额的大头是**新增代码 + 中文 UI 文案**，不是注释：本文件历轮一直写着
     *     「esbuild 不 minify，注释原样进产物」—— **这条是错的**，本轮实测推翻：
     *     在 `lib/client.js` 里搜任何一段源注释（如「为什么进度条只能是不确定态」）
     *     raw / `\uXXXX` 两种写法都 0 命中；`legalComments: 'none'` 加打包模式本来
     *     就会把普通注释剥掉。**进产物的中文只在字符串字面量里**（`\u6A21\u578B…`，
     *     一个字 6 字节）—— 所以真正吃字符的是界面文案与对外错误提示，
     *     写得再厚的「为什么」不占这条闸。
     *   - 新闸 1,720,000，余量 ≈ 22 KB。下一次再要抬，请照旧先分开量。
     *
     * ★ 0.84.0 抬到 1,860,000（平台链接订阅 + 识别双路 + 翻译双引擎 + AI 导读）。
     *   抬闸前照旧分开量（`.build/measure-client.mjs`，esbuild metafile，临时探针未入库）：
     *   - `foreign_inputs=0`、`node_modules` 0 命中、模块注释仍在 ⇒ **没有依赖被内联**；
     *   - 本轮实测 `lib/client.js` **1,793,861 字符**（旧闸 1,720,000，超出 73,861）；
     *   - 按模块量仍是平摊：`refinements.css` 最大，`ReaderPage` / `DiaryApp` /
     *     `BookReader` 依次其后，**没有单个爆掉的模块**；本轮进 client 的新文件只有三个：
     *     `EpisodeDigest.jsx` 6.8 KB、`CaptionSettings.jsx` 9.9 KB、`feed-platform.js` 13.4 KB；
     *   - 差额的大头是这些新增的**中文界面文案与对外错误提示**（esbuild 把汉字转成
     *     `\uXXXX`，一个字 6 字节），以及 `ReaderPage` / `TranscriptPanel` /
     *     `SettingsPage` / `dialogs.jsx` 的接线；host 侧五个新模块（feed-resolve /
     *     google-translate / asr-ollama / asr-cloud / episode-digest）**不进 client bundle**；
     *   - 新闸 1,860,000，余量 ≈ 66 KB。下一次再要抬，请照旧先分开量。
     *
     * ★ 0.88.0 抬到 1,920,000（读后感一键提纲 + 跨源检索）。照旧先量再抬：
     *   - 抬闸当轮实测 **1,889,861 字符**（旧闸 1,860,000，超出 **29,861**，1.6%）；
     *   - 分开量（esbuild metafile 探针，临时文件未入库）：**`node_modules` 命中 0 个
     *     input、0 字节** ⇒ 没有依赖被内联，涨的全是第一方；
     *   - 差额对得上的是**当轮新增的两个客户端文件**：`WeeklyReport.jsx` 17.4 KB +
     *     `SearchPalette.jsx` 8.5 KB + `reflection-draft.js` 0.3 KB = **26.2 KB**，
     *     其余 ≈ 3.7 KB 是 `DiaryApp` / `ReaderPage` / `PapersApp` / `index.jsx` 的接线
     *     与那段 CSS（`refinements.css` 252.1 KB）；
     *   - 按模块量仍然平摊，**没有单个爆掉的模块**（最大 `refinements.css` 252.1 KB）；
     *     新组件的体积大头是中文界面文案 —— esbuild 把汉字转成 `\uXXXX`，
     *     一个字 6 字节，这也是本项目一贯的取舍：**说人话优先于省字节**；
     *   - 宿主侧三个新模块（`weekly.js` / `search-all.js` / `reflection-outline.js`）
     *     **不进 client bundle**，所以没算在这里；
     *   - **0.88.0 定稿时周报界面已撤下**（用户 2026-11-22：「该功能先保留接口，不要
     *     显示在 UI 界面上」）⇒ `WeeklyReport.jsx` 没有生产调用点，被 tree-shake 掉，
     *     实测回落到 **1,851,602 字符**（比抬闸当轮少 38,259）。
     *   - **闸不跟着回降**：1,920,000 对 1,851,602 的余量是 ≈ 68 KB，回降到 1,860,000
     *     只剩 ≈ 8 KB —— 下一次动任何一页都会红，那种闸只会教人「先去把数字改大」。
     *     下一次再要抬，请照旧先分开量。
     */
    const foreign = foreignBytes(text);
    assert.equal(foreign < 4096, true,
      `产物里有 ${(foreign / 1024).toFixed(0)} KB 非第一方代码 —— 有依赖被内联了`);
    assert.ok(text.length < 1_920_000,
      `client.js 有 ${(text.length / 1024).toFixed(0)} KB，第一方代码已经到荒谬的量级`);
  });

  it('★ 判据前提：esbuild 的模块注释还在（minify 之后 foreignBytes 会变恒 0 的假绿）', () => {
    // `foreignBytes` 靠 `// src/client/x.jsx` 这种行切模块。打开 minify 后这行没了，
    // 判据会永远返回 0 —— 看着全绿，其实什么都没量。前提要单独钉住。
    const text = clientBundle();
    assert.match(text, /^\/\/ src\/client\//m, '模块注释不见了：foreignBytes 已失效，需要换判据');
    assert.equal(text.includes('node_modules'), false, '当前产物里不该出现 node_modules');
  });

  it('★ 反向对照：内部塞一段 node_modules ⇒ foreignBytes 必须报出来', () => {
    // 判据本身也要被检验，否则「恒为 0」和「判据写对了」长得一样。
    const fake = [
      '// src/client/index.jsx',
      'var a = 1;',
      '// /project/node_modules/pdfjs-dist/build/pdf.mjs',
      'var big = "x".repeat(10);',
      'var bigger = "y".repeat(10);',
      '// src/client/BookReader.jsx',
      'var b = 2;',
    ].join('\n');
    assert.ok(foreignBytes(fake) > 0, '反向对照失效：内联的依赖没被算进去');
    assert.equal(foreignBytes('// src/client/index.jsx\nvar a = 1;'), 0);
  });

  it('★ 反向对照：书架的样式类真的定义在产物里（不是只有引用）', () => {
    // `check-classes.mjs` 在源码上查这件事，这里在**产物**上再查一遍 —— 因为 CSS 是
    // 塞在模板串里被一起打包的，模板串写错（比如注释里出现反引号）只有这一步抓得到。
    const text = clientBundle();
    for (const cls of ['npr-book-canvas', 'npr-book-toolbar', 'npr-book-error', 'npr-viewswitch']) {
      assert.ok(text.includes(`.${cls}`), `产物里找不到 .${cls} 的样式定义`);
    }
  });
});

describe('日记（第三个 tab）的接线', () => {
  it('Host 半区带上了存储、路由、三个工具与上下文注入', () => {
    const text = hostBundle();
    for (const name of ['makeDiaryRoutes', 'createDiaryStore', 'diaryRoot', 'setDiaryContext', 'diaryToday', 'diaryAppend', 'diarySearch']) {
      assert.ok(text.includes(name), `Host 产物里找不到 ${name}`);
    }
    // 前缀是**共用常量**（客户端按它拼 URL、宿主按它注册），两边都必须在。
    assert.ok(text.includes('/api/dsh-npie-reader/diary'), 'Host 产物里找不到日记路由前缀');
    // 三个工具名是给模型看的**稳定标识符**，改名等于换接口。
    for (const tool of ['diary_today', 'diary_append', 'diary_search']) {
      assert.ok(text.includes(tool), `Host 产物里找不到工具名 ${tool}`);
    }
  });

  it('Client 半区带上了日记界面、日历与路由前缀', () => {
    const text = clientBundle();
    for (const token of [
      'npr-diary-reader', 'npr-diary-scroll', 'npr-diary-cal', 'npr-diary-write',
      'npr-diary-sheet', 'npr-diary-moodrow', 'npr-diary-entry', 'npr-diary-dayrow', 'npr-diary-hit',
      // 0.51：潮汐线的几何与引文卡 —— 它们在新文件里，最容易被漏进产物。
      'npr-diary-tide', 'npr-diary-note',
      '/api/dsh-npie-reader/diary',
    ]) {
      assert.ok(text.includes(token), `Client 产物里找不到 ${token}`);
    }
  });

  it('★ 日记的样式类**定义**也在产物里（模板串写错只有这一步抓得到）', () => {
    // 与书架那条同源：CSS 是塞在模板串里一起打包的，注释里一个反引号就能让它
    // 提前闭合 —— 而那种错误是**语法合法**的减法链，用例全绿、App 起不来。
    const text = clientBundle();
    for (const cls of ['npr-diary-reader', 'npr-diary-cal-day', 'npr-diary-write', 'npr-diary-body']) {
      assert.ok(text.includes(`.${cls}`), `产物里找不到 .${cls} 的样式定义`);
    }
  });

  it('★ Client 半区没有被拖进日记的宿主实现（它跑在浏览器里）', () => {
    const text = clientBundle();
    for (const forbidden of ['createDiaryStore', 'diaryRoot', 'makeDiaryRoutes']) {
      assert.ok(!text.includes(forbidden), `Client 产物里出现了 ${forbidden} —— 宿主半区的东西漏进浏览器了`);
    }
  });

  it('★ 第三个按钮本身真的打进了产物（零件齐了但入口没画出来 = 功能不存在）', () => {
    // 上面几条都在查「日记的零件在不在」，而**入口**是另一件事。
    // ★ esbuild 会把单引号统一成双引号、中文转成 `\uXXXX`，所以这里只能查
    //   双引号形态的 ASCII 片段 —— 查单引号形态会得到一个「永远查不到」的假红。
    const text = clientBundle();
    assert.ok(text.includes('"aria-pressed": mode === "diary"'),
      '产物里找不到日记按钮的选中态绑定 —— 第三个 tab 没打进去');
    // 日历图标是那个按钮唯一的视觉标识（`icons.jsx` 里的 path 起点）。
    assert.ok(text.includes('M8 2v4'), '产物里找不到日历图标的路径 —— 第三个按钮可能换了图标或没打进去');
  });
});

