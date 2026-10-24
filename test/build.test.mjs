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
    // 体积上限：内联 pdf.mjs（512 KB）或 pdf.worker.mjs（1.3 MB）都会立刻撞破它。
    // ★ 0.20.4 把这个数字从 800_000 抬到 860_000。抬的原因是**口径过时**，不是放宽守卫：
    //   写这条的时候 bundle 是 ~516 KB，20 个版本之后它已经是 ~790 KB（`refinements.css`
    //   是以 `text` loader 原样内联的，每一段带说明的 CSS 都算数），于是这条判据在
    //   **本轮改动之前**就已经踩线（实测 808,950 字符，而本轮新增约 2 KB）。
    //   守卫真正要抓的是「有没有整个依赖被内联进来」：pdf.mjs 512 KB ⇒ 790 + 512 =
    //   1.3 MB，pdf.worker.mjs 1.3 MB ⇒ 2.1 MB，两个都远在 860 KB 之上，牙**没有**变钝。
    // ★ 0.21.0 再抬到 900_000，同样先量后抬：本轮新增是第一方代码 ——
    //   `annotations.js`（锚点换算 + 判据）+ `AnnotationPanel.jsx` + 一段面板 CSS
    //   + `BookReader` 里的接线，**没有新增任何依赖**。实测 874,716 字符（+30 KB 量级），
    //   而 900 KB 距离「内联 pdf.mjs 后的 1.36 MB」仍有 460 KB 余量。
    //   ⇒ 若哪天它又红了，先量「本轮新增了多少、是依赖还是自己的代码」，别直接推数字。
    // ★ 0.23.0 抬到 940_000：本轮新增**全是注释与第一方代码**（右下角那颗按钮从
    //   「绕圆心扇出的 7 个圆片」改成「带文字标签的竖直列」，附带一大段解释为什么
    //   hover 展开在这个几何里根本不成立）。实测 908,106 字符，比上一档超 8,106。
    //   增量里最容易被误判的一项是：`refinements.css` 是**以 text loader 原样内联**的，
    //   CSS 注释一个字都不删（实测全产物里注释占 133 KB，其中非 ASCII 每字转义成
    //   6 个字符），所以「多写几段中文说明」在这条判据上等于几百行代码。
    //   真正的牙（内联 pdf.mjs ⇒ 1.36 MB）离 940 KB 还有 480 KB。
    assert.ok(text.length < 940_000, `client.js 有 ${(text.length / 1024).toFixed(0)} KB，说明有大块依赖被内联了`);
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
