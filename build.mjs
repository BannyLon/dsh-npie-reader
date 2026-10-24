/**
 * Build dsh-npie-reader: host bundle (ESM, host runtimes external) + client
 * bundle (window.__ModuleLoader__ CJS wrapper, react/react-dom external).
 * esbuild is a local development dependency of this package.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = 'dsh-npie-reader';
// The settings page shows the version; inject it so the client bundle never
// has to pull the whole package.json (and its devDependencies) into the browser.
const { version: PLUGIN_VERSION } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

// ---- 产物闸：不许把变异体打进发布包 ----------------------------------------
// ★ 0.20.2 的发布产物里，`digest-store.writeSkill` 是 `void dir;` —— 也就是
//   「导出前不清理旧目录」，重复导出会把上一版的章节文件留在包里。
//   源码是好的、测试是绿的、产物是坏的，三者可以**同时**成立。
//   变异脚本 `verify-book-skill-mutants.mjs` 会**原地改写**源码（换掉一行 → 跑测试
//   → 换回），一次几秒到几分钟；在这段窗口里跑 `node build.mjs`，打出来的就是
//   带变异体的包。⇒ 两道闸，缺一不可：
//   ① 日志说 running 就拒绝构建（挡「撞上窗口」）；
//   ② 构建后扫产物里有没有变异体特征串（与原因无关，手工临时改过忘改回也抓得住）。
const JOURNAL = join(here, 'test/.build/mut-journal.json');
if (existsSync(JOURNAL)) {
  let state = 'unknown';
  try {
    state = JSON.parse(readFileSync(JOURNAL, 'utf8'))?.state ?? 'unknown';
  } catch {
    state = 'unreadable';
  }
  if (state === 'running') {
    console.error('✗ 拒绝构建：变异测试正在改写源码（test/.build/mut-journal.json = running）。');
    console.error('  等它跑完再构建；若它已经被杀掉，重跑一次 scripts/verify-book-skill-mutants.mjs 会自动还原。');
    process.exit(1);
  }
}

mkdirSync(join(here, 'lib'), { recursive: true });

// ---- host ------------------------------------------------------------------

await esbuild.build({
  entryPoints: [join(here, 'src/host/index.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(here, 'lib/index.js'),
  external: ['@deepseek-ai/*', 'node:*'],
  sourcemap: false,
  logLevel: 'info',
  legalComments: 'none',
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __dirnameFn } from "node:path";',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameFn(__filename);',
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

// ---- client ----------------------------------------------------------------

const banner = `window.__ModuleLoader__.load({
	id: "${PLUGIN_ID}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;
const footer = `
		return module.exports;
	}
});
`;

await esbuild.build({
  entryPoints: [join(here, 'src/client/index.jsx')],
  loader: { '.css': 'text' },
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome120',
  jsx: 'automatic',
  jsxImportSource: 'react',
  define: { __NPIE_READER_VERSION__: JSON.stringify(PLUGIN_VERSION) },
  outfile: join(here, 'lib/client.js'),
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  sourcemap: false,
  logLevel: 'info',
  legalComments: 'none',
  banner: { js: banner },
  footer: { js: footer },
});

/**
 * 从变异脚本里把 `from` / `to` 配对抽出来，检查产物里有没有「被换掉的那一行」。
 *
 * ★ 不去 `import` 那个脚本：它在顶层就把整套测试跑一遍，import 等于又跑一次。
 *   所以按文本配对 —— 每条变异体是 `from: '...'` 紧跟 `to: '...'`，`mutate:`
 *   那两条没有这对字段，自然跳过。
 * ★ 只认长度 ≥ 12 的 `to`：太短的串（`true`、`{}`）在任何产物里都能撞上。
 */
function mutantPairs() {
  const text = readFileSync(join(here, 'scripts/verify-book-skill-mutants.mjs'), 'utf8');
  const unescape = value => value.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
  const marks = [...text.matchAll(/\b(from|to):\s*'((?:[^'\\]|\\.)*)'/g)]
    .map(m => ({ kind: m[1], value: unescape(m[2]) }));
  const pairs = [];
  for (let i = 0; i + 1 < marks.length; i += 1) {
    if (marks[i].kind === 'from' && marks[i + 1].kind === 'to') pairs.push([marks[i].value, marks[i + 1].value]);
  }
  return pairs;
}

const hostBundle = readFileSync(join(here, 'lib/index.js'), 'utf8');
const baked = mutantPairs().filter(([from, to]) => to.length >= 12 && hostBundle.includes(to) && !hostBundle.includes(from));
if (baked.length > 0) {
  console.error('\n✗ 产物里发现变异体 —— 这些行本该是正常实现：');
  for (const [from, to] of baked) {
    console.error(`   正常写法: ${from.trim().slice(0, 100)}`);
    console.error(`   产物里是: ${to.trim().slice(0, 100)}`);
  }
  console.error('  ⇒ 构建时源码处于被改写状态。先把源码还原，再重新构建，这份产物不要发。');
  process.exit(1);
}

const hostSize = statSync(join(here, 'lib/index.js')).size;
const clientSize = statSync(join(here, 'lib/client.js')).size;
console.log(`host   lib/index.js  ${(hostSize / 1024).toFixed(1)} KB`);
console.log(`client lib/client.js ${(clientSize / 1024).toFixed(1)} KB`);
