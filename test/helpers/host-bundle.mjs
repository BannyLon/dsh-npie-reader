/**
 * 把宿主半区源码打包成一份可直接 import 的测试产物。
 *
 * 历史教训：`src/host/service.js` 曾经静态 import 四个 `@deepseek-ai/dsh-*` 包，
 * 这里用 esbuild alias 把它们换成替身 —— 结果是 **测试全绿、真机加载失败**：
 * 那些包不在外部 link 插件的解析链上，真机没有替身可用。现在 Host 半区已经零
 * 宿主包依赖，替身与 alias 一并删除。
 *
 * 删掉 alias 本身就是护栏：源码若再出现静态宿主包导入，esbuild 解析不到裸导入
 * 会**直接打包失败**，测试随即变红，而不是被替身悄悄掩盖。
 *
 * 产物落在 test/.build/（已 gitignore），每次调用都重新构建，杜绝读到旧快照。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..', '..');
const outFile = join(pluginRoot, 'test', '.build', 'host.mjs');

let pending;

/** 构建（或复用本次进程内已构建的）宿主测试产物，返回它的模块命名空间。 */
export function loadHostBundle() {
  pending ??= build();
  return pending;
}

async function build() {
  mkdirSync(dirname(outFile), { recursive: true });
  const service = join(pluginRoot, 'src', 'host', 'service.js');
  const store = join(pluginRoot, 'src', 'host', 'store.js');
  const typertLite = join(pluginRoot, 'src', 'host', 'typert-lite.js');
  const entry = join(pluginRoot, 'src', 'host', 'index.js');
  await esbuild.build({
    stdin: {
      contents: [
        `import { RssService } from ${JSON.stringify(service)};`,
        `import { remoteMethods } from ${JSON.stringify(typertLite)};`,
        `export { RssService };`,
        `export { apply, inject, name } from ${JSON.stringify(entry)};`,
        `export { remoteMethods };`,
        `export { RssStore, dataFilePath, defaultData, MAX_ARTICLE_BODIES, MAX_HIDDEN_IDS } from ${JSON.stringify(store)};`,
        // Remote 标记清单读真实现（src/host/typert-lite.js），不再读替身：替身
        // 永远返回空清单，会让「方法漏挂」逃过检查（假绿）。空壳实例让
        // remoteMethods 读到 RssService.prototype 上的描述符。
        'export const registeredRemoteMethods = remoteMethods(Object.create(RssService.prototype))',
        '  .map((marker) => ({ name: marker.exportName ?? marker.method, meta: marker }));',
      ].join('\n'),
      resolveDir: pluginRoot,
      sourcefile: 'dsh-npie-reader-test-entry.mjs',
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: outFile,
    sourcemap: 'inline',
    logLevel: 'warning',
    legalComments: 'none',
  });
  return import(`${pathToFileURL(outFile).href}?v=${Date.now()}`);
}
