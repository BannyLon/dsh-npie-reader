#!/usr/bin/env node
/**
 * check-host-contract.mjs —— dsh-npie-reader 与 DSH 宿主之间的契约守卫（零依赖）。
 *
 * 这里每条断言之所以存在，都是因为对应的错误在运行期**不报错**：
 *
 * 1. 插槽名。客户端半区自己声明插槽名，所以类型系统只检查「名字的形状」，
 *    从不检查「名字是否存在」。注册到一个宿主从未声明的插槽既不抛错也不警告：
 *    `ctx.slots.inject` 只是永远等不到那个声明，贡献**无声消失**。
 *    ⇒ 判据不是字符串 grep（`main` 这种通用词在哪都能命中，等于没有牙），
 *      而是宿主安装树里 `interface SlotMap` / `interface SlotFactoryMap` 的
 *      声明正文 —— 那是宿主自己的权威口径。
 *
 * 2. 宿主 DOM 锚点。选择器写错一个字，CSS 规则**静默不生效**，界面看起来
 *    只是「没调好」。⇒ 每个宿主锚点都必须能在某个宿主客户端产物里找到。
 *
 * 3. 模块预加载清单。`package.json → dsh.client.inject` 里的包名拼错，预加载
 *    清单就少一项，症状是「某个能力时有时无」。
 *
 * 4. 版本声明纪律（AGENTS.md §6）。内核每次升级会统一重编号全部
 *    `@deepseek-ai/dsh-*`；写死版本号 ⇒ 插件面板集体标「异常」。
 *
 * 5. 挂载行契约。`cordis.patch.yml` 的行 `name` 与 `package.json` 的 `name`
 *    必须一致，否则那一行指向一个不存在的包。
 *
 * 6. 构建产物。宿主产物必须能被真的 import、并导出 apply（或 default）与
 *    inject；客户端产物必须仍是 `__ModuleLoader__` 包装，且 react 保持外置 ——
 *    一旦 react 被打进产物，会出现「两份 react」这种极难定位的故障。
 *
 * 8. Host 半区依赖。外部 link 插件的 Host 半区解析不到宿主内部包（它们在 App 的
 *    asar 里），静态 import 会让整个插件 `failed to import`；测试若用 esbuild
 *    alias 换成替身，这种错误会被伪装成绿灯。
 *
 * 用法：
 *   node scripts/check-host-contract.mjs [--strict]
 *   DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node scripts/check-host-contract.mjs
 *
 * 退出码：0 = 无 ERROR（跳过项明确列出，不算失败）；1 = 至少一条 ERROR。
 * `--strict` 下跳过项也算失败。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './strip-comments.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');

const errors = [];
const skips = [];
const ok = [];
const fail = (message) => errors.push(message);
const pass = (message) => ok.push(message);

// ---------------------------------------------------------------------------
// 声明的契约面 —— 代码里出现的每个 token 都必须在这里登记归属，
// 否则第 2 组检查判红。这样清单没法悄悄和代码漂移。
// ---------------------------------------------------------------------------

/** 本插件自己声明的子插槽（不是宿主提供的）。 */
const SELF_SLOTS = new Set(['npie-reader.chat']);

/** 宿主 DOM 锚点 / 宿主 CSS Module 类名片段 → 用途。 */
const HOST_ANCHORS = new Map([
  ['data-composer-seat', '原生对话的输入区座位'],
  ['data-composer-card', '原生对话的输入卡片'],
  ['data-content-phase', '原生对话的内容相位（hero / settling / active）'],
  ['data-conversation-scroll', '原生对话的滚动容器'],
  ['data-chat-flow', '原生对话的消息流'],
  ['data-conversation-content', '原生对话的内容层'],
  ['composerHero', '宿主 composer 的 hero 态类名片段'],
  ['heroWorkspaceRow', '宿主 hero 工作区行的类名片段'],
  // 宿主 base.css 里唯一的 darwin 拖动规则就是 `[data-window-drag]{-webkit-app-region:drag}`，
  // 而**每个 chrome 行自己打这个标记**（宿主自己的插件管理器页、侧栏、会话头都打了）。
  // 插件的面板铺满主区域却不打 ⇒ 默认的 none 把窗口顶部拖动几何整块挡住，
  // 症状是「插件一打开，窗口就拖不动」。
  ['data-window-drag', '宿主窗口拖动区标记（darwin 下开启 -webkit-app-region:drag）'],
]);

/**
 * 本插件自己写到 DOM 上的属性 —— 不是宿主契约，别误登记成宿主锚点。
 * 判据：由 `dataset.<camelCase>` 赋值或 JSX 属性写入（见下面 foundTokens 的推导）。
 *
 * 本插件**不需要** `body[data-ds-dark-theme]` 这类宿主主题信号：自有界面一律走
 * `--dsw-*` 令牌，令牌本身随宿主换肤，所以没有需要手动开灯的深色覆盖层。
 * （§4 那条「主题信号跟随 data-ds-dark-theme」针对的是手写深色覆盖层的场景。）
 */
const OWNED_ATTRS = new Set([
  'data-dragging', 'data-titlebar', 'data-reading-theme', 'data-images', 'data-plugin',
  'data-backfilling', 'data-tint', 'data-tone',
  // 重排电子书（0.25.x）自己写到 DOM 上的三个：
  //   `data-block` —— 每个正文块的下标，划线锚点靠它认「选区落在第几块」（少了划不出线且不报错）；
  //   `data-theme` —— `.npr-ebook` 根节点上的纸色/主题（`dark` / `black`），自有 CSS 选它；
  //   `data-depth` —— 目录条目的层级（0/1/2），自有 CSS 按它缩进。
  // 三者都是本插件自己的选择器依据，**不是宿主锚点** —— 登记进 HOST_ANCHORS 会被
  // 下面那条「宿主产物里必须命中」的反向检查判红。
  'data-block', 'data-theme', 'data-depth',
  // 富文本编辑器（0.35.0）自己写的一个：
  //   `data-ready` —— 编辑器挂载点上的 `yes`/`no`，自有 CSS 靠它决定「显示编辑器还是
  //     退回 textarea」（两者是同一个值的两个视图，不能同时可见）。
  'data-ready',
  // 书内搜索（0.26.0）自己写的一个：
  //   `data-current` —— 当前这一处命中（`true` / `false`），跳转后给它加个描边。
  //   仍然只是自有 CSS 的选择器依据，不是宿主锚点。
  'data-current',
  // 日记（0.33 / 0.34）自己写的三个：
  //   `data-diary-key` —— 条目的唯一键（`scope-index`），时间轴点一条之后靠它 scrollIntoView；
  //   `data-variant` —— 写入口的三种形态（quick / private / reflection），自有 CSS 按它调起点高度；
  //   `data-mode` —— 写入口当前是「写」还是「预览」，用来切工具条的可用态。
  //   ★ 这三个都是**本插件**的 DOM 契约。宿主完全不认识它们，登记进 HOST_ANCHORS
  //     会被下面那条「宿主产物里必须命中」的反向检查判红。
  'data-diary-key', 'data-variant', 'data-mode',
  // 读后感整页重做（0.44.0）自己写的三个：
  //   `data-kind` / `data-image` —— 书架卡片上那张封面**这一帧用的是哪条路**
  //     （`epub` / `pdf` / `made`，以及真图有没有真的画上去），自有 CSS 只认这两个值
  //     来切「真封面」与「生成式封面」的排版；
  //   `data-drop` —— 编辑器「正被拖进来」的开关（`yes` / `no`），拖拽经过时画一圈描边。
  //   三者都只服务于本插件自己的样式，宿主完全不认识 —— 登记进 HOST_ANCHORS 会被
  //   上面那条「宿主产物里必须命中」的反向检查判红（`data-image` 尤其容易撞车）。
  'data-kind', 'data-image', 'data-drop',
  // 文章大纲（0.44.8）自己写的两个：
  //   `data-outline` —— 每个标题上的锚点下标（**不用 `id`**：`id` 会被类名检查脚本当成
  //     类名报缺口，也可能和文章自带的锚点撞名），点目录时按它 `scrollTo`；
  //   `data-level` —— 标题层级（1–4），自有 CSS 按它缩进目录行。
  //   ★ 这两个是 0.44.8 引入时的**欠账**：当时没登记，守卫直到 0.45.0 跑
  //     `contract-guard` 才报出来（同一轮里大纲按钮换了图标，但错误与图标无关）。
  //     仍然是本插件自己的 DOM 契约，宿主完全不认识 ⇒ 不能进 HOST_ANCHORS。
  'data-outline', 'data-level',
  // 日记右栏顶栏（0.53.2 引入 `data-cover`，0.56.x 改名）：
  //   `data-bare` —— 顶栏空着时（灵感/私密两张说明页、读后感还没选书）在
  //     `.npr-diary-reader` 上标出来。自有 CSS 靠它把拖动行退回**书架欢迎页那一条**：
  //     44px、无底边、无内边距。编辑器态那条 `border-bottom` 是「日期栏 / 正文」的分界，
  //     空栏上还挂着它就是一条没来由的横线；56px 的 min-height 还会让说明页比书架低一截。
  //   宿主不认识它 ⇒ 只能进 OWNED_ATTRS，进 HOST_ANCHORS 会被「宿主产物必须命中」判红。
  'data-bare',
]);


const LOOSE_ENGINES = '>=0.1.2-alpha.2 || >=0.1.5-rc.2 || >=0.1.7-alpha.2';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function listFiles(dir, predicate) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // 不可读的目录直接跳过，不要因为一个权限问题整条检查挂掉
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      // ★ 必须用 `withFileTypes` 而不是 `statSync(full)`：宿主树有 2000+ 个
      //   `.d.ts`，逐文件 stat 会让每次调用都多一次系统调用 —— 实测这会把整条
      //   检查从「不到 1 秒」拖到「一分钟」。readdir 一次就带回类型。
      if (entry.isDirectory()) walk(full);
      else if (predicate(full)) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** 转义正则元字符。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按**词边界**判断宿主产物里有没有这个 token。
 *
 * 不能用 `text.includes(token)`：那样宿主把 `data-composer-seat` 改名成
 * `data-composer-seat-renamed` 之后，守卫照样打 OK —— 典型的假绿（变异测试
 * 实测抓到过）。
 *
 * 边界用 `[a-z0-9-]` 而不是 `\w`：宿主 CSS Module 的类名形如
 * `composerHero_<hash>`，下划线是合法的后续字符，用 `\w` 会把它误判成改名。
 */
function hasToken(haystack, token) {
  return new RegExp(`(?<![a-z0-9-])${escapeRegExp(token)}(?![a-z0-9-])`, 'i').test(haystack);
}

/** 花括号配对取出 `interface <header>` 的正文。 */
function interfaceBody(text, header) {
  const at = text.indexOf(header);
  if (at === -1) return undefined;
  const open = text.indexOf('{', at);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return undefined;
}

/** 定位宿主安装树（`@deepseek-ai/dsh`）。 */
function resolveInstallRoot() {
  if (process.env.DSH_INSTALL_ROOT) {
    return existsSync(join(process.env.DSH_INSTALL_ROOT, 'package.json')) ? process.env.DSH_INSTALL_ROOT : undefined;
  }
  const candidates = [
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
    join(homedir(), 'node_modules', '@deepseek-ai', 'dsh'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json')));
}

const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
const clientFiles = listFiles(join(pluginRoot, 'src', 'client'), (file) => /\.(jsx|js|css)$/.test(file));
/**
 * ★ 必须先剥注释再扫描：本文件所有断言问的都是「**代码里**有没有出现这个 token」，
 *   而注释里出现的 token 不是使用。
 *   实测踩过：`ReaderPage.jsx` 的 CSS 注释里抄着宿主 base.css 的拖动规则原文
 *   （`html[data-platform=darwin] [data-window-drag-recall]{…}`）⇒ 锚点扫描把它
 *   当成「客户端用到的锚点」，报「data-platform / data-window-drag-recall 没有归属
 *   登记」。症状是**守卫在骂文档写得太详细，而不是代码有错**。
 *   剥离器本身有单测（`test/strip-comments.test.mjs`），因为它多剥一点就会让这里静默变瞎。
 */
const clientSource = clientFiles.map((file) => stripComments(readFileSync(file, 'utf8'))).join('\n');

// ---------------------------------------------------------------------------
// 1. 插槽契约
// ---------------------------------------------------------------------------

const installRoot = resolveInstallRoot();
/**
 * 语料收窄：插槽声明只出现在客户端契约目录 `lib/types/client/**` 下（实测：
 * `main` 在 dsh-client-ui-layout、`sidebar.panellist` 在 dsh-client-ui-sidebar、
 * `conversation.*` 在 dsh-client-ui-conversation，都在这一层）。宿主树有 2000+
 * 个 `.d.ts`，为了找 ~60 个契约文件而全读一遍纯属浪费。
 * 过滤器若收得太窄，「用到的插槽名必须找得到」那条检查会立刻判红 —— 不会静默放行。
 */
const CLIENT_CONTRACT_DIR = /[\\/]lib[\\/]types[\\/]client[\\/]/;
/** 客户端产物：`<pkg>/lib/client.js` 才是宿主真正加载的那一份。 */
const CLIENT_BUNDLE = /[\\/]lib[\\/]client\.js$/;
const hostDtsFiles = installRoot
  ? listFiles(join(installRoot, 'node_modules', '@deepseek-ai'), (file) => file.endsWith('.d.ts') && CLIENT_CONTRACT_DIR.test(file))
  : [];

const hostSlots = new Map();
for (const file of hostDtsFiles) {
  const text = readFileSync(file, 'utf8');
  for (const header of ['interface SlotMap', 'interface SlotFactoryMap']) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(header, from);
      if (at === -1) break;
      from = at + header.length;
      const body = interfaceBody(text.slice(at), header);
      if (!body) continue;
      for (const match of body.matchAll(/^\s{4,8}'([\w.\-]+)'\??:/gm)) {
        if (!hostSlots.has(match[1])) hostSlots.set(match[1], file);
      }
    }
  }
}

// 客户端用到的插槽名（注册目标、注入目标、渲染目标）
const usedSlots = new Map();
for (const pattern of [
  /slots\.inject\(\s*'([^']+)'/g,
  /slots\.register\(\s*\{\s*name:\s*'([^']+)'/g,
  /renderSlot\(\s*'([^']+)'/g,
  /renderFactorySlot\(\s*'([^']+)'/g,
]) {
  for (const match of clientSource.matchAll(pattern)) usedSlots.set(match[1], true);
}

// 本插件自己声明的子插槽（`children: { 'x': { kind: ... } }`）
const declaredChildren = new Set();
for (const match of clientSource.matchAll(/'([\w.\-]+)'\s*:\s*\{\s*kind:/g)) declaredChildren.add(match[1]);

if (!installRoot) {
  skips.push('插槽契约：找不到宿主安装树（用 DSH_INSTALL_ROOT=<path> 指定）');
  skips.push('宿主 DOM 锚点：同上');
  skips.push('dsh.client.inject 包存在性：同上');
} else {
  // 1a. 每个用到的插槽名都必须有归属
  for (const name of usedSlots.keys()) {
    const inHost = hostSlots.has(name);
    const inSelf = SELF_SLOTS.has(name);
    if (!inHost && !inSelf) {
      fail(`插槽 "${name}" 既不在宿主的 SlotMap 声明里，也没登记为自有插槽 —— 贡献会无声消失`);
    }
  }

  // 1b. 自有插槽必须真的被注入/渲染，否则它声明出来却永远没人填
  for (const name of SELF_SLOTS) {
    if (!declaredChildren.has(name)) fail(`自有插槽 "${name}" 不在 SELF_SLOTS 里声明为 children —— 子插槽不会存在`);
    if (!usedSlots.has(name)) fail(`自有插槽 "${name}" 声明了却从没被 inject/renderSlot —— 面板位置永远空着`);
  }

  // 1c. 自有插槽不得与宿主同名（会遮蔽宿主语义）
  for (const name of SELF_SLOTS) {
    if (hostSlots.has(name)) fail(`自有插槽 "${name}" 与宿主 SlotMap 同名，会造成遮蔽`);
  }

  // 1d. 代码里声明的每个 children 键都必须有归属（防止清单漏登记）
  for (const name of declaredChildren) {
    if (!SELF_SLOTS.has(name) && !hostSlots.has(name)) {
      fail(`children 里声明的插槽 "${name}" 没有归属登记`);
    }
  }

  if (errors.length === 0) {
    pass(`插槽契约：用到 ${usedSlots.size} 个插槽名，全部有权威归属（宿主声明 ${hostSlots.size} 个）`);
  }
}

// ---------------------------------------------------------------------------
// 2. 宿主 DOM 锚点 / 类名片段
// ---------------------------------------------------------------------------

const foundTokens = new Set();
for (const match of clientSource.matchAll(/\bdata-[a-z][\w-]*/g)) foundTokens.add(match[0]);
for (const match of clientSource.matchAll(/\[class\*=\\?["']([\w-]+)\\?["']\]/g)) foundTokens.add(match[1]);
// `dataset.titlebar = ...` 写入的是自有属性，字面串里**没有** `data-titlebar`，
// 只靠上面那条扫描会漏掉它，于是清单里会出现「登记了却找不到」的假报错。
for (const match of clientSource.matchAll(/dataset\.([A-Za-z]\w*)/g)) {
  foundTokens.add(`data-${match[1].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
}

for (const token of foundTokens) {
  if (!HOST_ANCHORS.has(token) && !OWNED_ATTRS.has(token)) {
    fail(`客户端用到的锚点 "${token}" 没有归属登记（宿主锚点请进 HOST_ANCHORS，自有属性请进 OWNED_ATTRS）`);
  }
}
// 反向：两张清单里的每个条目都必须在客户端里真的被用到，否则清单会烂成死条目。
for (const token of [...HOST_ANCHORS.keys(), ...OWNED_ATTRS]) {
  if (!foundTokens.has(token)) fail(`清单里登记的 "${token}" 在客户端源码里根本没用到 —— 清掉它或补上使用点`);
}

if (installRoot) {
  const bundles = listFiles(join(installRoot, 'node_modules', '@deepseek-ai'), (file) => CLIENT_BUNDLE.test(file));
  const corpus = bundles.map((file) => readFileSync(file, 'utf8'));
  for (const [token, purpose] of HOST_ANCHORS) {
    const hit = corpus.some((text) => hasToken(text, token));
    if (!hit) fail(`宿主锚点 "${token}"（${purpose}）在 ${bundles.length} 个宿主客户端产物里都找不到 —— 选择器永远不会命中`);
  }
  if (errors.length === 0) pass(`宿主锚点：${HOST_ANCHORS.size} 个全部在宿主产物里命中（扫了 ${bundles.length} 个 bundle）`);
}

// ---------------------------------------------------------------------------
// 3. 模块预加载清单
// ---------------------------------------------------------------------------

const preload = pkg.dsh?.client?.inject ?? [];
if (installRoot) {
  for (const name of preload) {
    const bare = name.replace(/^@deepseek-ai\//, '');
    if (!existsSync(join(installRoot, 'node_modules', '@deepseek-ai', bare))) {
      fail(`dsh.client.inject 里的 "${name}" 在宿主安装树里不存在`);
    }
  }
  if (errors.length === 0) pass(`dsh.client.inject：${preload.length} 个包名全部在宿主安装树里存在`);
}

// ---------------------------------------------------------------------------
// 4. 版本声明纪律（AGENTS.md §6）
// ---------------------------------------------------------------------------

const dshPeers = Object.keys(pkg.peerDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/dsh'));
if (dshPeers.length > 0) {
  fail(`peerDependencies 里出现了 ${dshPeers.join(', ')} —— 内核升级重编号后会集体标「异常」（§6 硬性口径）`);
}
const engines = pkg.dsh?.engines?.dsh;
if (engines !== LOOSE_ENGINES) {
  fail(`dsh.engines.dsh 必须是宽松范围 "${LOOSE_ENGINES}"，当前是 "${engines}"`);
}
if (errors.length === 0) pass('版本声明：无 dsh-* peer，engines 为宽松范围');

// ---------------------------------------------------------------------------
// 5. 挂载行契约
// ---------------------------------------------------------------------------

const patchPath = join(pluginRoot, 'cordis.patch.yml');
if (!existsSync(patchPath)) {
  fail('缺少 cordis.patch.yml —— 插件没有挂载行');
} else {
  const patch = readFileSync(patchPath, 'utf8');
  const rowName = /^\s*name:\s*'([^']+)'/m.exec(patch)?.[1];
  const rowId = /^\s*-\s*id:\s*(\S+)/m.exec(patch)?.[1];
  if (rowName !== pkg.name) fail(`cordis.patch.yml 的行 name "${rowName}" 与 package.json 的 name "${pkg.name}" 不一致`);
  if (!rowId) fail('cordis.patch.yml 的挂载行缺少 id');
  if (errors.length === 0) pass(`挂载行：id=${rowId} name=${rowName}`);
}

// ---------------------------------------------------------------------------
// 6. 构建产物
// ---------------------------------------------------------------------------

const hostOut = join(pluginRoot, 'lib', 'index.js');
const clientOut = join(pluginRoot, 'lib', 'client.js');
if (!existsSync(hostOut) || !existsSync(clientOut)) {
  fail('缺少构建产物 lib/index.js 或 lib/client.js —— 先跑 npm run build');
} else {
  const hostText = readFileSync(hostOut, 'utf8');
  const clientText = readFileSync(clientOut, 'utf8');

  // 入口有两种合法形状：函数式插件的 `export { apply, inject }`（scheduledtasks
  // 的活样板），或类式插件的 default 导出。判据不是对源码 grep，而是**真的
  // import 产物**：产物若又出现宿主内部包静态导入，这里会当场 ERR_MODULE_NOT_FOUND
  // —— 那正是真机上「failed to import」的同一个错误。
  let hostModule;
  try {
    hostModule = await import(pathToFileURL(hostOut).href);
  } catch (error) {
    fail(`lib/index.js 无法被 import（真机会同样加载失败）：${error?.code ?? ''} ${error?.message ?? error}`.trim());
  }
  if (hostModule !== undefined) {
    const hasApply = typeof hostModule.apply === 'function';
    const hasDefault = hostModule.default !== undefined;
    if (!hasApply && !hasDefault) fail('lib/index.js 既没有 apply 函数导出也没有 default 导出 —— 宿主加载器拿不到插件入口');
    if (hasApply && !('inject' in hostModule)) fail('lib/index.js 导出了 apply 却没有 inject —— 依赖服务未就绪时 apply 会直接抛错');
  }

  const bannerId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientText)?.[1];
  if (bannerId !== pkg.name) fail(`lib/client.js 的 ModuleLoader id "${bannerId}" 与包名 "${pkg.name}" 不一致`);

  for (const external of ['react', 'react-dom', 'react/jsx-runtime']) {
    if (!clientText.includes(`require("${external}")`)) {
      fail(`lib/client.js 里找不到 require("${external}") —— 说明它被打进了产物，会出现两份副本`);
    }
  }
  if (errors.length === 0) pass('构建产物：host 入口导出、ModuleLoader id、react 外置三项通过');
}

// ---------------------------------------------------------------------------
// 7. `--dsw-*` 令牌必须真实存在于宿主主题包
// ---------------------------------------------------------------------------
// 令牌名写错**不会报错**：`color: var(--dsw-typo)` 只是让整条声明失效，症状是
// 「这个按钮 hover 没反应」，静默失效极难排查。判据是宿主主题包自己的令牌表，
// 不是「看着像」。
if (!installRoot) {
  skips.push('--dsw-* 令牌存在性：找不到宿主安装树');
} else {
  const themeBundle = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js');
  if (!existsSync(themeBundle)) {
    fail('找不到宿主主题包 dsh-client-ui-theme/lib/client.js —— 无法校验 --dsw-* 令牌');
  } else {
    const themeText = readFileSync(themeBundle, 'utf8');
    const usedTokens = new Set();
    for (const match of clientSource.matchAll(/--dsw-[a-z0-9-]+/g)) usedTokens.add(match[0]);
    for (const token of usedTokens) {
      if (!hasToken(themeText, token)) fail(`令牌 "${token}" 在宿主主题包里不存在 —— 引用它的声明会整条失效`);
    }
    if (errors.length === 0) pass(`--dsw-* 令牌：${usedTokens.size} 个全部在宿主主题包里存在`);
  }
}

// ---------------------------------------------------------------------------
// 8. Host 半区不得静态导入宿主内部包
// ---------------------------------------------------------------------------
// 外部 link 插件的 Host 半区在 Node 解析链上拿不到宿主内部包：桌面端把它们放在
// App 的 asar 里，profile 的 node_modules 里没有。静态 import 的症状是**整个插件
// 加载失败**（插件面板报 `did not activate … failed to import`）。测试若用 esbuild
// alias 把包换成替身，还会得到「测试全绿、真机全挂」的假绿 —— 本项目踩过这个坑。
// 例外：写在 dependencies 里的包由 pnpm 实装进插件自己的 node_modules，可以导入。
{
  const hostFiles = listFiles(join(pluginRoot, 'src', 'host'), (file) => file.endsWith('.js'));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const offenders = [];
  for (const file of hostFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) {
      if (!declared.has(match[1])) offenders.push(`${relative(pluginRoot, file)} → ${match[1]}`);
    }
  }
  if (offenders.length > 0) {
    fail(`Host 半区静态导入了未声明的宿主内部包（真机会 failed to import）：${offenders.join('；')}`);
  } else {
    pass(`Host 半区依赖：${hostFiles.length} 个源文件零宿主包静态导入`);
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

for (const line of ok) console.log(`  OK   ${line}`);
for (const line of skips) console.log(`  SKIP ${line}`);
for (const line of errors) console.log(`  ERR  ${line}`);

const effective = errors.length + (strict ? skips.length : 0);
console.log(
  `\n${pkg.name}: ${errors.length} ERROR / ${skips.length} SKIP / ${ok.length} OK${strict ? '（--strict）' : ''}`,
);
process.exit(effective > 0 ? 1 : 0);
