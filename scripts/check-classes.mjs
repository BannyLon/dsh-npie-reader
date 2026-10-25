/**
 * CSS/JSX 类名一致性核查：找出「用了但没定义」与「定义了但没人用」的 npr- 类名。
 *
 * 为什么需要它：手改 CSS 时，删掉一个还在用的类名不会报错，只会静默掉样式；
 * 留下一个没人用的类名则永远不会被发现。两者都只能靠交叉比对发现。
 *
 * 用法：node scripts/check-classes.mjs   （有「用了但没定义」时退出码为 1）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'src', 'client');

const CLASS_RE = /\.(npr-[a-zA-Z0-9_-]+)/g;
const TOKEN_RE = /npr-[a-zA-Z0-9_-]+/g;

/** 一次扫描，同时剥掉注释并收集字符串/模板字面量（注释里的撇号会骗到朴素实现）。 */
function scan(source) {
  const literals = [];
  let code = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === ch) break;
        j += 1;
      }
      literals.push(source.slice(i + 1, j));
      code += ' '.repeat(Math.min(j + 1 - i, 64));
      i = j + 1;
      continue;
    }
    code += ch;
    i += 1;
  }
  return { code, literals };
}

const readerPage = readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8');
// PANEL_CSS 常量（定义）与文件其余部分（使用）必须分开看，否则样式块会自证「被使用」。
const panelStart = readerPage.indexOf('const PANEL_CSS');
const panelEnd = readerPage.indexOf('const VERSION_LABELS');
if (panelStart < 0 || panelEnd < panelStart) throw new Error('ReaderPage.jsx 锚点已失效，请更新 check-classes.mjs');

const defined = new Set();
const collect = (css) => { for (const m of css.matchAll(CLASS_RE)) defined.add(m[1]); };
collect(readFileSync(join(clientDir, 'refinements.css'), 'utf8'));
collect(readerPage.slice(panelStart, panelEnd));

const readerPageCode = readerPage.slice(0, panelStart) + readerPage.slice(panelEnd);
const used = new Set();
for (const name of readdirSync(clientDir).filter((f) => /\.(jsx|js)$/.test(f))) {
  const source = name === 'ReaderPage.jsx' ? readerPageCode : readFileSync(join(clientDir, name), 'utf8');
  for (const literal of scan(source).literals) for (const m of literal.matchAll(TOKEN_RE)) used.add(m[0]);
}

// 不是类名的 npr- token：::highlight() 名、window 事件名、CSS 自定义属性、元素 id
const NOT_CLASSES = new Set([
  'npr-reading-selection', 'npr-prompts-changed', 'npr-settings-changed', 'npr-mode',
  'npr-accent', 'npr-accent-strong', 'npr-article-width', 'npr-bg', 'npr-bg-2',
  'npr-border', 'npr-border-strong', 'npr-companion-width', 'npr-elevation',
  'npr-faint', 'npr-fg', 'npr-font-family', 'npr-font-size', 'npr-hover',
  'npr-line-height', 'npr-list-width', 'npr-muted', 'npr-scrim', 'npr-spin',
  'npr-surface', 'npr-existing-groups', 'npr-addfeed-groups',
  // 浮动列的几何量（0.23.0）：三者都是 **CSS 自定义属性**，由 React 写在槽位的
  // `style` 上，CSS 侧用 `translate(var(...))` / `width: var(...)` 消费。
  // 它们永远不会有 `.npr-fab-size` / `.npr-fab-span` 这样的类选择器。
  'npr-fab-size', 'npr-fab-span', 'npr-fab-x', 'npr-fab-y', 'npr-fab-i',
  // 书页亮度（0.22.0）：这是一个 **CSS 自定义属性**（`--npr-book-brightness`），
  // 由 React 写在根节点的 `style` 上、CSS 侧用 `brightness(var(...))` 消费。
  // 它永远不会有 `.npr-book-brightness` 这样的类选择器。
  'npr-book-brightness',
  // 扇出三件套（0.22.0）：同样是 **CSS 自定义属性**（`--npr-fab-x` / `--npr-fab-y` /
  // `--npr-fab-i`），由 JSX 的 `slotStyle()` 逐格写到内联 `style` 上，
  // CSS 侧用 `translate(var(--npr-fab-x), var(--npr-fab-y))` 与
  // `transition-delay: calc(var(--npr-fab-i) * 18ms)` 消费 —— 都不是类名。
  'npr-fab-x', 'npr-fab-y', 'npr-fab-i',
  // 重排电子书（0.25.0）：
  //   - `npr-ebook-width` 是 **CSS 自定义属性**（`--npr-ebook-width`），由 `BookEbook`
  //     写在根节点 `style` 上、`.npr-ebook-sheet` 用 `var(...)` 消费；
  //   - `npr-ebook-fab-list` 是浮动列的 **元素 id**（`aria-controls` 指向它），不是类名。
  'npr-ebook-width', 'npr-ebook-fab-list',
]);

// 有意保留的语义钩子：只用于在 DOM 上标记区块边界，没有对应样式。
// 若将来给它们加样式，请从这里移走。
const HOOK_ONLY = new Set(['npr-settings-sources-card', 'npr-width-options']);

const missing = [...used].filter((n) => !defined.has(n) && !NOT_CLASSES.has(n) && !HOOK_ONLY.has(n)).sort();
const unused = [...defined].filter((n) => !used.has(n)).sort();

console.log(`类名：定义 ${defined.size} 个，使用 ${used.size} 个`);
console.log(`用到但未定义（${missing.length}）：${missing.join(' ') || '(none)'}`);
console.log(`定义但未使用（${unused.length}）：${unused.join(' ') || '(none)'}`);
console.log(`有意保留的语义钩子（${HOOK_ONLY.size}）：${[...HOOK_ONLY].join(' ')}`);
process.exit(missing.length === 0 && unused.length === 0 ? 0 : 1);
