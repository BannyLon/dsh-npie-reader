/**
 * 图标名守卫。
 *
 * `Icon` 在找不到名字时会**静默退化成 `PATHS.circle`**（见 `src/client/icons.jsx`）：
 * 写错一个图标名不会报错、不会警告，只是那个位置永远画一个圆圈 ——
 * 而圆圈在界面里看起来「像是有意为之」，所以谁也不会发现。
 *
 * 本轮新加了 `eye-off`（隐藏内置源）与 `trash-2`（移除自己的源），
 * 正好是这类 typo 的高发区，所以钉一道。
 *
 * 做法：从 `icons.jsx` 的 `PATHS` 里取名字，再从 JSX 里取 `<Icon name="…" />` 的用法，
 * 两边交叉核对。`name={…}` 这种动态取值**不在**检查范围（静态文本查不到），
 * 所以下面同时钉住「动态取值只有已知的那几处」，免得有人用动态写法绕开守卫。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'src', 'client');
const iconsSource = readFileSync(join(clientDir, 'icons.jsx'), 'utf8');

/** `PATHS` 对象字面量的键。 */
function definedNames() {
  const start = iconsSource.indexOf('const PATHS');
  const end = iconsSource.indexOf('export function Icon');
  assert.ok(start >= 0 && end > start, 'icons.jsx 的 PATHS / Icon 锚点已失效，请更新本测试');
  const block = iconsSource.slice(start, end);
  const names = new Set();
  // 单行 `  'eye-off': [...]` 与多行 `  'wand-sparkles': [\n … \n  ],` 都要认。
  for (const match of block.matchAll(/^\s{2}'?([a-z][a-z0-9-]*)'?:\s*\[/gm)) names.add(match[1]);
  return names;
}

const defined = definedNames();

function clientSources() {
  return readdirSync(clientDir)
    .filter((file) => /\.jsx$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(clientDir, file), 'utf8') }));
}

describe('图标名', () => {
  test('PATHS 解析正常（否则下面的检查会变成空对空）', () => {
    assert.ok(defined.size >= 20, `只解析出 ${defined.size} 个图标名，解析器可能坏了`);
    assert.ok(defined.has('circle'), 'PATHS 里必须有 circle —— 它是兜底值');
    assert.ok(defined.has('eye-off') && defined.has('trash-2'));
  });

  test('每个 <Icon name="…" /> 的名字都真的存在', () => {
    const missing = [];
    for (const { file, text } of clientSources()) {
      for (const match of text.matchAll(/<Icon\s+name="([^"]+)"/g)) {
        if (!defined.has(match[1])) missing.push(`${file}: ${match[1]}`);
      }
    }
    assert.deepEqual(missing, [], `这些图标名不存在，会静默画成圆圈：\n${missing.join('\n')}`);
  });

  test('集合基数：至少真的扫到了一批用法（防止正则失配导致假绿）', () => {
    let count = 0;
    for (const { text } of clientSources()) count += [...text.matchAll(/<Icon\s+name="([^"]+)"/g)].length;
    assert.ok(count >= 20, `只扫到 ${count} 处 <Icon name="…" />，正则可能已失配`);
  });

  test('反向对照：动态 name 里的每个字面量也必须存在', () => {
    // `name={cond ? 'a' : 'b'}` 这类写法静态查不到，但它**里面**的字符串还是字面量，
    // 一样能核对。这里不断言「动态写法一共有几处」——那种精确集合断言一重构就红，
    // 只会制造噪音，而它想保护的性质其实只是「里面的名字都存在」。
    // 裸标识符（`name={icon}`）查不了，如实跳过并报出，别假装查过了。
    const skipped = [];
    const missing = [];
    let checked = 0;
    for (const { file, text } of clientSources()) {
      for (const match of text.matchAll(/<Icon\s+name=\{([^}]+)\}/g)) {
        const literals = [...match[1].matchAll(/'([^']+)'/g)].map((hit) => hit[1]);
        if (literals.length === 0) { skipped.push(`${file}: ${match[1].trim()}`); continue; }
        for (const name of literals) {
          checked++;
          if (!defined.has(name)) missing.push(`${file}: ${name}`);
        }
      }
    }
    assert.deepEqual(missing, [], `动态 name 里的这些名字不存在：\n${missing.join('\n')}`);
    assert.ok(checked >= 5, `只核到 ${checked} 个字面量，正则可能已失配`);
    // 裸标识符是可接受的中转（值由调用方保证），但必须是「少数几处」，不能变成主流写法。
    assert.ok(skipped.length <= 3, `有 ${skipped.length} 处裸标识符取值，太多了，守卫会形同虚设：\n${skipped.join('\n')}`);
  });
});
