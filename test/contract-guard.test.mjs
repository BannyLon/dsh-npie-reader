/**
 * 契约守卫的**变异测试**：证明 `scripts/check-host-contract.mjs` 真的会变红。
 *
 * 一个只会打 OK 的守卫等于一张合格证，所以这里逐条制造它声称能抓到的错误，
 * 并要求它以 1 退出、报出对应的话。
 *
 * 为什么用**自建的假宿主树**而不是真机安装树：
 *  - 封闭：不依赖用户装的 DSH 版本，也不会因为宿主升级而漂移；
 *  - 快：真机树有 2000+ 个 `.d.ts` 与 73 个客户端产物，跑一次要几十秒；
 *  - 更强：可以**连宿主侧一起变异**（把插槽声明删掉），证明守卫真的在读宿主，
 *    而不是拿一张硬编码的名单自我印证。
 *
 * 每条变异都先断言「替换真的发生了」—— 否则变异是空操作，测试会变成假绿。
 */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await mkdtemp(join(tmpdir(), 'npie-guard-'));
const copy = join(sandbox, 'dsh-npie-reader');
const host = join(sandbox, 'host');

/** 宿主真实声明的插槽（本插件用到的 4 个）。 */
const HOST_SLOTS = ['main', 'sidebar.panellist', 'conversation.session', 'conversation.content'];

/** 宿主客户端产物里真实存在的 DOM 锚点 / 类名片段。 */
const HOST_ANCHOR_TOKENS = [
  'data-composer-seat', 'data-composer-card', 'data-content-phase',
  'data-conversation-scroll', 'data-conversation-content', 'data-chat-flow',
  'composerHero', 'heroWorkspaceRow',
  // 宿主每个 chrome 行自己打的拖动区标记。假宿主树里必须也有它，
  // 否则「原样副本必须全绿」那条用例会因为夹具缺这个锚点而红。
  'data-window-drag',
];

const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));

function slotMapSource(names) {
  const body = names.map((name) => `    '${name}': { kind: 'single'; scope: 'root' };`).join('\n');
  return `declare module 'fake' {\n  interface SlotMap {\n${body}\n  }\n}\n`;
}

/** 建一棵最小但结构真实的宿主安装树。 */
async function buildFakeHost() {
  await rm(host, { recursive: true, force: true });
  const scope = join(host, 'node_modules', '@deepseek-ai');
  await mkdir(scope, { recursive: true });
  await writeFile(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }));

  // 1. 每个 dsh.client.inject 包都要真实存在
  for (const name of pkg.dsh.client.inject) {
    const dir = join(scope, name.replace(/^@deepseek-ai\//, ''));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name }));
  }

  // 2. 插槽声明：放在契约目录 lib/types/client/ 下（守卫的语料过滤器认这个路径）
  const layout = join(scope, 'dsh-client-ui-layout', 'lib', 'types', 'client');
  const conversation = join(scope, 'dsh-client-ui-conversation', 'lib', 'types', 'client', 'contract');
  const sidebar = join(scope, 'dsh-client-ui-sidebar', 'lib', 'types', 'client', 'contract');
  await mkdir(layout, { recursive: true });
  await mkdir(conversation, { recursive: true });
  await mkdir(sidebar, { recursive: true });
  await writeFile(join(layout, 'index.d.ts'), slotMapSource(['main']));
  await writeFile(join(sidebar, 'slots.d.ts'), slotMapSource(['sidebar.panellist']));
  await writeFile(join(conversation, 'slots.d.ts'), slotMapSource(['conversation.session', 'conversation.content']));

  // 3. 客户端产物：锚点出现在某个 bundle 里
  const conversationLib = join(scope, 'dsh-client-ui-conversation', 'lib');
  await writeFile(join(conversationLib, 'client.js'), `// fake bundle\n${HOST_ANCHOR_TOKENS.join(' ')}\n`);

  // 4. 主题包：令牌表从插件**原始**源码推导，插件被变异后就会对不上
  const themeLib = join(scope, 'dsh-client-ui-theme', 'lib');
  await mkdir(themeLib, { recursive: true });
  const pristineClient = await readClientSource();
  const tokens = [...new Set([...pristineClient.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0]))];
  await writeFile(join(themeLib, 'client.js'), `// fake theme\n${tokens.join(' ')}\n`);
  return tokens.length;
}

async function readClientSource() {
  const files = ['index.jsx', 'refinements.css', 'ReaderPage.jsx'];
  let text = '';
  for (const file of files) {
    try {
      text += await readFile(join(pluginRoot, 'src', 'client', file), 'utf8');
    } catch {
      // 文件不存在就跳过；守卫自己的完整性检查会兜住
    }
  }
  return text;
}

before(async () => {
  for (const entry of ['src', 'scripts', 'lib', 'package.json', 'cordis.patch.yml']) {
    await cp(join(pluginRoot, entry), join(copy, entry), { recursive: true });
  }
  await buildFakeHost();
});

after(() => rm(sandbox, { recursive: true, force: true }));

function runGuard() {
  const result = spawnSync(process.execPath, [join(copy, 'scripts', 'check-host-contract.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, DSH_INSTALL_ROOT: host },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

/** 替换一处；返回还原函数。替换没命中就当场判红。 */
async function mutate(file, from, to) {
  const original = await readFile(file, 'utf8');
  assert.ok(original.includes(from), `变异未命中：${file} 里没有 ${JSON.stringify(from)}`);
  await writeFile(file, original.replace(from, to), 'utf8');
  return async () => writeFile(file, original, 'utf8');
}

const mutatePlugin = (relativePath, from, to) => mutate(join(copy, relativePath), from, to);
const mutateHost = (relativePath, from, to) => mutate(join(host, relativePath), from, to);

describe('check-host-contract guard', () => {
  it('passes on the pristine copy', () => {
    const { code, output } = runGuard();
    assert.equal(code, 0, output);
    assert.match(output, /0 ERROR/);
  });

  // ---- 宿主侧变异：证明守卫真的在读宿主，而不是自我印证 --------------------

  it('reads the host, not a hardcoded list: a slot the host stops declaring is caught', async () => {
    const restore = await mutateHost('node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts', "'sidebar.panellist'", "'sidebar.renamed'");
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /插槽 "sidebar\.panellist" 既不在宿主的 SlotMap 声明里/);
    } finally {
      await restore();
    }
  });

  it('reads the host theme package: a token the host stops defining is caught', async () => {
    const restore = await mutateHost('node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js', '--dsw-alias-bg-base ', ' ');
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /令牌 "--dsw-alias-bg-base" 在宿主主题包里不存在/);
    } finally {
      await restore();
    }
  });

  it('reads the host bundles: an anchor the host stops emitting is caught', async () => {
    const restore = await mutateHost('node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', 'data-composer-seat', 'data-composer-seat-renamed');
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /宿主锚点 "data-composer-seat"/);
    } finally {
      await restore();
    }
  });

  // ---- 插件侧变异 ---------------------------------------------------------

  it('catches a slot name the plugin typos', async () => {
    const restore = await mutatePlugin('src/client/index.jsx', "slots.inject('sidebar.panellist'", "slots.inject('sidebar.panelList'");
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /插槽 "sidebar\.panelList" 既不在宿主的 SlotMap 声明里/);
    } finally {
      await restore();
    }
  });

  it('catches an anchor that has no registered owner', async () => {
    const restore = await mutatePlugin('src/client/refinements.css', '[data-composer-seat]', '[data-composer-seat-typo]');
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /没有归属登记/);
    } finally {
      await restore();
    }
  });

  it('catches a --dsw-* token typo', async () => {
    const restore = await mutatePlugin('src/client/refinements.css', '--dsw-alias-bg-base', '--dsw-alias-bg-basee');
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /令牌 "--dsw-alias-bg-basee" 在宿主主题包里不存在/);
    } finally {
      await restore();
    }
  });

  it('catches a pinned @deepseek-ai/dsh-* peer dependency', async () => {
    const restore = await mutatePlugin('package.json', '"react": "^18.2.0"', '"react": "^18.2.0",\n    "@deepseek-ai/dsh-base": "^0.2.1-alpha.1"');
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /peerDependencies 里出现了 @deepseek-ai\/dsh-base/);
    } finally {
      await restore();
    }
  });

  it('catches a pinned engines range', async () => {
    const restore = await mutatePlugin('package.json', '">=0.1.2-alpha.2 || >=0.1.5-rc.2 || >=0.1.7-alpha.2"', '"0.2.1-alpha.1"');
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /dsh\.engines\.dsh 必须是宽松范围/);
    } finally {
      await restore();
    }
  });

  it('catches a mount row that names a different package', async () => {
    const restore = await mutatePlugin('cordis.patch.yml', "name: 'dsh-npie-reader'", "name: 'dsh-npie-reader-typo'");
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /行 name "dsh-npie-reader-typo" 与 package\.json 的 name/);
    } finally {
      await restore();
    }
  });

  it('catches a client bundle whose ModuleLoader id drifted from the package name', async () => {
    const restore = await mutatePlugin('lib/client.js', 'id: "dsh-npie-reader",', 'id: "dsh-npie-reader-typo",');
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /ModuleLoader id "dsh-npie-reader-typo"/);
    } finally {
      await restore();
    }
  });

  it('catches a preload entry that is not installed', async () => {
    const restore = await mutatePlugin('package.json', '"@deepseek-ai/dsh-api-gateway",', '"@deepseek-ai/dsh-api-gateway-typo",');
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /dsh\.client\.inject 里的 "@deepseek-ai\/dsh-api-gateway-typo"/);
    } finally {
      await restore();
    }
  });

  // ---- Host 半区依赖：真机上「failed to import」的那一类 -------------------

  it('catches a host-half static import of an internal package', async () => {
    const restore = await mutatePlugin(
      'src/host/store.js',
      "import { homedir } from 'node:os';",
      "import { homedir } from 'node:os';\nimport { resolveDshHome } from '@deepseek-ai/dsh-home-paths';",
    );
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /Host 半区静态导入了未声明的宿主内部包/);
      assert.match(output, /src\/host\/store\.js → @deepseek-ai\/dsh-home-paths/);
    } finally {
      await restore();
    }
  });

  it('catches a host bundle that lost its apply export', async () => {
    const restore = await mutatePlugin(
      'lib/index.js',
      'export {\n  RssService,\n  apply,\n  inject,\n  name\n};',
      'export {\n  RssService,\n  inject,\n  name\n};',
    );
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /既没有 apply 函数导出也没有 default 导出/);
    } finally {
      await restore();
    }
  });

  it('catches a host bundle whose apply export has no inject', async () => {
    const restore = await mutatePlugin(
      'lib/index.js',
      'export {\n  RssService,\n  apply,\n  inject,\n  name\n};',
      'export {\n  RssService,\n  apply,\n  name\n};',
    );
    try {
      const { code, output } = runGuard();
      assert.equal(code, 1, output);
      assert.match(output, /导出了 apply 却没有 inject/);
    } finally {
      await restore();
    }
  });
});
