/**
 * 书架组件（`src/client/LibraryApp.jsx`）的两条契约：**P1-4** 与 **P1-5**。
 *
 * ★ 这一层是**接线**守卫（源码级），它只答「那个模块真的被用上了吗」。
 *   行为那一半在 `test/page-progress.test.mjs`（用假计时器真跑）。两层缺一不可：
 *   - 只有行为级 ⇒ 组件里**没接上**那个模块时，行为测试照样全绿（测的是一个
 *     没人用的模块）—— 这正是「给死代码发合格证」；
 *   - 只有源码级 ⇒ 答不了「这段代码跑不跑得到」。
 *
 * ★ 每条判据都配**反向对照**：把修之前那一版（逐字）喂进同一套判据，必须变红。
 *   否则这些断言只是把当前实现抄了一遍，改坏了照样绿。
 *
 * ★ 一律先 `stripComments`：注释里抄着反面教材（比如「以前这里只有一句
 *   `clearTimeout(saveTimer.current)`」），而**注释里出现的 X 不是使用**。
 *   本项目为这件事踩过两次（见 `scripts/strip-comments.mjs` 文件头）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';
/**
 * `BOOK_STATES` 从**真模块**取，不在这里抄一份：判据 ③ 要的就是「分组覆盖数据模型」，
 * 抄一份常量会让这条判据变成「覆盖我抄的那份」，而数据模型加了值它不会红。
 */
import { BOOK_STATES } from '../src/library.js';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const app = stripComments(readFileSync(join(clientDir, 'LibraryApp.jsx'), 'utf8'));

/**
 * 取一个 `const <name> = …;` 声明的完整文本。
 *
 * ★ 必须**在下一个同级 `const` 处截断**，否则「依赖数组是不是空的」这类判据会
 *   扫到**后面**那个回调的 `}, [])` 上去 —— 那是一条恒真的断言（本项目把这种
 *   误命中记在「锚点必须点名选择器」那一条里）。
 *   缩进用两个空格做锚点：函数体里的局部 `const` 是四个空格，不会误命中。
 */
function declarationOf(code, name) {
  const at = code.indexOf(`const ${name} = `);
  if (at === -1) return null;
  const next = code.indexOf('\n  const ', at + 1);
  return code.slice(at, next === -1 ? code.length : next);
}

/** 判据：这份实现有没有违反 P1-4 / P1-5 的接线契约。返回违规说明（空 = 通过）。 */
function violationsOf(code) {
  const found = [];

  // ---------- P1-4：卸载时必须把没落盘的那次进度补写完 ----------

  const flushAt = code.indexOf('progress.current?.flush()');
  if (flushAt === -1) {
    found.push('卸载路径没有调 flush() —— 翻页后 1.2 秒内切走，那一次进度就丢了（P1-4）');
  } else {
    const around = code.slice(Math.max(0, flushAt - 90), flushAt + 40);
    if (!/=>\s*\(\)\s*=>/.test(around)) {
      found.push('flush() 不在一个 effect 的 cleanup（`() => () => …`）里 —— 它不会被卸载触发');
    }
    if (!/\[\s*\]\s*\)/.test(around)) {
      found.push('这个 cleanup 的依赖数组不是空的 —— 依赖一变就提前 flush，去抖等于没有');
    }
  }

  if (/clearTimeout\(\s*saveTimer/.test(code)) {
    found.push('还在自己管 saveTimer —— 卸载时只 clearTimeout 就是把那一次进度丢掉');
  }
  if (!/createPageProgress\(/.test(code)) {
    found.push('没有用 createPageProgress —— 卸载补写那条路就没有行为测试守（见 test/page-progress.test.mjs）');
  }

  // ---------- P1-5：延迟筛选 + 行 memo ----------

  if (!/useDeferredValue\(/.test(code)) {
    found.push('没有 useDeferredValue —— 2634 本会在搜索框每次敲字时同步重算（P1-5）');
  }

  const filters = declarationOf(code, 'filters');
  if (filters === null || !/useMemo\(/.test(filters)) {
    found.push('筛选条件没有先 useMemo 成**一个对象** —— useDeferredValue 比的是 Object.is，'
      + '每次渲染现造的对象会让它永远认为「值变了」⇒ 永远在推迟（列表可能一直停在旧值上）');
  }
  if (!/useDeferredValue\(\s*filters\s*\)/.test(code)) {
    found.push('useDeferredValue 的入参不是那个 memo 过的 filters');
  }

  if (!/memo\(/.test(code)) found.push('行组件没有包 memo');
  if (!/export const BookRow = memo\(/.test(code)) {
    found.push('BookRow 不是 `memo(...)` 组件 —— 2634 行每次输入都会全部重渲染');
  }

  const rowAt = code.indexOf('<BookRow');
  if (rowAt === -1) {
    found.push('找不到 <BookRow —— 判据失效了，先修断言（别再让这一条静默通过）');
  } else {
    const end = code.indexOf('/>', rowAt);
    const tag = code.slice(rowAt, end === -1 ? rowAt + 400 : end + 2);
    // ★ `state={…}` 是把 `stateOf()` 那个**每次都是新对象**的状态当 prop 传下去：
    //   `memo` 的浅比较永远不等 ⇒ 每行每次都重渲染 ⇒ `memo` 完全白做。
    //   注意正则不能写成 `/state=/`：`stateName={` 也含 `state`，会误命中。
    if (/\bstate=\{/.test(tag)) {
      found.push('把 stateOf(...) 那个每次都是新对象的状态当 prop 传给了行 —— memo 的浅比较永远不等');
    }
    if (!/\badded=\{/.test(tag) || !/\bstateName=\{/.test(tag)) {
      found.push('行组件没有收到 added / stateName 两个**原始值**');
    }
  }

  // ★ 四个回调一个都不能漏：它们都要传给 `memo` 过的行，引用一变 `memo` 就白做。
  //   0.9.1 补上 `dropBook` / `restartBook` —— 新增回调时最容易漏的就是这一步。
  for (const name of ['openBook', 'restartBook', 'toggleAdded', 'dropBook']) {
    const decl = declarationOf(code, name);
    if (decl === null || !/useCallback\(/.test(decl)) {
      found.push(`${name} 不是 useCallback —— 引用每次渲染都变，传给 memo 过的行会让所有行每次都重渲染`);
      continue;
    }
    // ★ 依赖数组必须是空的：里面有 `states` / `persist` 这类会变的东西时，
    //   引用跟着变，`memo` 又白做了。动态的东西必须走 ref。
    if (!/\}\s*,\s*\[\s*\]\s*\)/.test(decl)) {
      found.push(`${name} 的依赖数组不是空的 —— 依赖一变引用就变，行的 memo 白做`);
    }
  }

  // ---------- 延迟必须真的落到过滤上 ----------

  const visible = declarationOf(code, 'visible');
  if (visible === null) {
    found.push('找不到 visible 的声明 —— 判据失效了，先修断言');
  } else {
    // ★ 0.9.1 起 `sort` 不再是 `sort: shown.sort` 这种直白形态：阅读页的排序被写死成
    //   `READING_SORT`（那一页**没有**排序控件），书架页才用延迟后的 `sort`。
    //   所以这里只要求「延迟值真的被用到了」；形态与「隐藏控件」那件事由下面
    //   `hiddenControlViolationsOf` 单独钉。
    for (const key of ['query', 'sort']) {
      if (!new RegExp(`shown\\.${key}\\b`).test(visible)) {
        found.push(`visible 没有用延迟后的 ${key} —— useDeferredValue 就只是个摆设`);
      }
    }
    const deps = /\[([^\]]*)\]\s*,?\s*\)\s*;/.exec(visible)?.[1];
    if (deps === undefined) {
      found.push('读不出 visible 的依赖数组 —— 判据失效了，先修断言');
    } else {
      for (const raw of ['query', 'sort', 'stateFilter', 'scope']) {
        if (new RegExp(`(^|[,\\s])${raw}([,\\s]|$)`).test(deps)) {
          found.push(`visible 的依赖里还有**未延迟**的 ${raw} —— 它一变就同步重算，延迟白做`);
        }
      }
    }
  }

  return found;
}

describe('★ 书架：P1-4 卸载补写 / P1-5 延迟筛选的接线契约', () => {
  it('当前实现通过全部判据', () => {
    assert.deepEqual(violationsOf(app), []);
  });

  it('★ 反向对照：0.8.7 那一版必须被判红（否则判据只是把实现抄了一遍）', () => {
    // 逐字来自修之前：只 clearTimeout 的 cleanup、行内联在 map 里、没有延迟。
    const old = `
  const saveTimer = useRef(undefined);
  // 离开书架（切回订阅 / 关掉面板）时把还没落盘的那次进度写完。
  useEffect(() => () => { clearTimeout(saveTimer.current); }, []);

  const onPageChange = useCallback((page, pages) => {
    const id = selectedId;
    if (id === '') return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { /* 落盘 */ }, SAVE_DEBOUNCE_MS);
  }, [selectedId, notify]);

  const openBook = (id) => {
    setSelectedId(id);
    const current = stateOf(states, id);
    if (current.state === 'unread') void persist(id, { state: 'reading' });
  };

  const toggleAdded = (id, next) => void persist(id, { added: next });

  const visible = useMemo(
    () => filterBooks(books, { query, sort }).filter((book) => topDir === '' || book.topDir === topDir),
    [books, query, sort, topDir],
  );

  {visible.map((book) => {
    const state = stateOf(states, book.id);
    return (
      <div key={book.id} className="npr-bookrow">
        <button type="button" aria-pressed={book.id === selectedId} onClick={() => openBook(book.id)}>
          {state.added ? '已在阅读' : '阅读'}
        </button>
      </div>
    );
  })}
`;
    const found = violationsOf(old);
    assert.ok(found.length >= 6, `旧实现只被判出 ${found.length} 条，判据太弱：${JSON.stringify(found, null, 2)}`);
    const has = (needle) => found.some((item) => item.includes(needle));
    assert.ok(has('flush()'), '必须抓到「卸载时不补写」—— 那就是 P1-4 本身');
    assert.ok(has('saveTimer'), '必须抓到「自己管 saveTimer」');
    assert.ok(has('useDeferredValue'), '必须抓到「没有延迟筛选」');
    assert.ok(has('memo'), '必须抓到「行没有 memo」');
    assert.ok(has('openBook'), '必须抓到「回调引用不稳定」');
    assert.ok(has('未延迟'), '必须抓到「visible 依赖未延迟的筛选条件」');
  });

  it('★ 判据的反向对照也测一遍：把「依赖数组」写错必须变红', () => {
    // 只改一处：openBook 的依赖里放一个每次渲染都可能变的东西。
    const mutated = app.replace(
      /(const openBook = useCallback\(\(id\) => \{[\s\S]*?\n  \}, )\[\]/,
      '$1[states]',
    );
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      violationsOf(mutated).some((item) => item.includes('openBook')),
      '把 openBook 的依赖从 [] 改成 [states] 居然没被判红',
    );
  });

  it('★ 判据的反向对照：把行 prop 换回状态对象必须变红', () => {
    const mutated = app.replace('added={state.added} stateName={state.state}', 'state={state}');
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    const found = violationsOf(mutated);
    assert.ok(
      found.some((item) => item.includes('每次都是新对象')),
      '把原始值换回状态对象居然没被判红 —— 这正是 memo 失效的形态',
    );
  });
});

/**
 * 「筛选项」的三条不变量（0.9.0 升级：从「一项一条判据」变成「一整组判据」）。
 *
 * ★ 起因（2026-10-09 实测）：筛选条上曾经有五项，其中「弃读」点进去**永远是 0 本**。
 *   四态模型是从 ebook-sorter 的 `reading.json` **整体继承**来的 schema，而本插件
 *   只实现了 4 条转移里的 3 条 —— `dropped` 没有任何写入路径（宿主会接受它，
 *   只是没人发）。它却带着筛选按钮、虚线徽章样式、`stateRank` 排序位一起留在界面上，
 *   **看起来像功能，实际恒空，而且没有任何报错**。用户只能靠自己盯着看才发现。
 *
 * ★ 0.9.0 之后筛选条改成**分组**（`READING_STATE_FILTERS`，定义在 `src/library.js`）：
 *   「在读」= 未开始 + 在读。判据随之升级成三条，缺一条都会漏掉一类缺陷：
 *
 *   ① **每个状态都写得出来**（原判据）。没有写入路径的状态 = 恒空的筛。
 *   ② **分组两两不相交**。重叠时同一本书会同时出现在两个筛里，而界面上看不出谁对。
 *   ③ **合起来覆盖 `BOOK_STATES`**。漏掉的状态只能在「全部」里露面 —— 用户永远
 *      没法单独看它。这条是 ① 的**对偶**：① 挡「有筛没状态」，③ 挡「有状态没筛」。
 *
 * ★ 这三条**只答「静态可达性」**，答不了「那条路跑不跑得到」—— 后者靠上面那组接线
 *   判据与 `test/page-progress.test.mjs` 的真跑用例。但它们正好挡得住本项目的真实
 *   缺陷形态：**继承来的枚举值没有写入路径**。
 * ★ ③ 要求的是「覆盖 `BOOK_STATES`」，**不是**「覆盖所有可写状态」—— 后者会把
 *   `BOOK_STATES` 里未来新增、但还没配筛的值也判红，而那是个正当的中间状态。
 */
const librarySrc = stripComments(readFileSync(join(clientDir, '..', 'library.js'), 'utf8'));

/** 取 `READING_STATE_FILTERS` 的分组（`value` / `label` / `states`）。 */
function filterGroupsOf(code) {
  const decl = /export const READING_STATE_FILTERS = \[([\s\S]*?)\n\];/.exec(code)?.[1];
  if (decl === undefined) return null;
  return [...decl.matchAll(/value: '([^']*)', label: '([^']*)', states: (null|\[[^\]]*\])/g)]
    .map((match) => ({
      value: match[1],
      label: match[2],
      states: match[3] === 'null' ? null : [...match[3].matchAll(/'([^']+)'/g)].map((item) => item[1]),
    }));
}

/** 源码里所有被**写入**的状态值（`state: 'x'` 形态）。 */
function writableStatesOf(...sources) {
  const found = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\bstate:\s*'([a-z]+)'/g)) found.add(match[1]);
  }
  return found;
}

/** 判据本体：返回违规说明（空 = 通过）。抽成函数才好把变异喂进来做反向对照。 */
function filterViolationsOf(code) {
  const found = [];
  const groups = filterGroupsOf(code);
  if (groups === null) return ['读不出 READING_STATE_FILTERS —— 判据失效了，先修断言（别让它静默通过）'];
  if (groups.length < 3) found.push(`只解析出 ${groups.length} 个筛选项，判据多半失效了`);

  const writable = writableStatesOf(app, code);
  if (writable.size < 3) {
    found.push(`只扫到 ${writable.size} 个可写状态，判据多半失效了：${JSON.stringify([...writable])}`);
  }

  // ① 每个状态都写得出来
  for (const group of groups) {
    for (const state of group.states ?? []) {
      if (!writable.has(state)) {
        found.push(`筛选项「${group.label}」包含状态 ${state}，但它没有任何写入路径 —— 那个筛会恒为空`);
      }
    }
  }

  // ② 分组两两不相交
  const owner = new Map();
  for (const group of groups) {
    for (const state of group.states ?? []) {
      if (owner.has(state)) {
        found.push(`状态 ${state} 同时属于「${owner.get(state)}」与「${group.label}」—— 同一本书会出现在两个筛里`);
      } else {
        owner.set(state, group.label);
      }
    }
  }

  // ③ 合起来覆盖 BOOK_STATES
  for (const state of BOOK_STATES) {
    if (!owner.has(state)) {
      found.push(`状态 ${state} 没有任何筛选项能筛出来 —— 那些书只能在「全部」里露面`);
    }
  }

  return found;
}

describe('★ 书架：状态筛选条的三条不变量', () => {
  it('当前实现通过全部判据', () => {
    assert.deepEqual(filterViolationsOf(librarySrc), []);
  });

  it('★ 反向对照 ①：给筛选项配一个写不出来的状态必须变红', () => {
    // 复刻 0.8.9 之前那个缺陷的形态：多一个筛，而它对应的状态没有写入路径。
    const mutated = librarySrc.replace(
      "{ value: 'dropped', label: '弃读', states: ['dropped'] },",
      "{ value: 'dropped', label: '弃读', states: ['dropped'] },\n  { value: 'finished', label: '已终结', states: ['finished'] },",
    );
    assert.notEqual(mutated, librarySrc, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      filterViolationsOf(mutated).some((item) => item.includes('finished')),
      '给一个没有写入路径的状态配筛选项居然没被判红 —— 那这条断言就挡不住原始缺陷',
    );
  });

  it('★ 反向对照 ②：让两个分组重叠必须变红', () => {
    const mutated = librarySrc.replace(
      "{ value: 'read', label: '读完', states: ['read'] },",
      "{ value: 'read', label: '读完', states: ['read', 'reading'] },",
    );
    assert.notEqual(mutated, librarySrc, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      filterViolationsOf(mutated).some((item) => item.includes('同时属于')),
      '「在读」与「读完」都收 reading 居然没被判红',
    );
  });

  it('★ 反向对照 ③：删掉一个筛选项、留下没人筛的状态必须变红', () => {
    const mutated = librarySrc.replace("  { value: 'dropped', label: '弃读', states: ['dropped'] },\n", '');
    assert.notEqual(mutated, librarySrc, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      filterViolationsOf(mutated).some((item) => item.includes('没有任何筛选项能筛出来')),
      '删掉「弃读」筛之后 dropped 没人管，居然没被判红',
    );
  });

  it('★ 反向对照 ④：锚点消失时必须报「判据失效」，不许静默通过', () => {
    assert.deepEqual(
      filterViolationsOf(librarySrc.replace('export const READING_STATE_FILTERS', 'export const SOMETHING_ELSE')),
      ['读不出 READING_STATE_FILTERS —— 判据失效了，先修断言（别让它静默通过）'],
    );
  });
});

/**
 * 「控件不显示 ⇒ 它对应的 state 也不许再参与筛选 / 排序」。
 *
 * ★ 起因（用户 2026-10-09 定的两条）：阅读页不显示分类下拉（0.9.0），也不显示排序
 *   下拉（0.9.1）。而 `topDir` / `sort` 是**两页共用**的一份 state —— 只要 `visible`
 *   还在读它们，阅读页的列表就会被一个**看不见、也改不回来**的条件筛着或排着。
 *   症状是「列表莫名其妙少了几本 / 顺序莫名其妙变了」，而界面上找不到任何原因。
 *   这与「控件的内容与它作用的集合不对应」是同一个缺陷类，只是方向相反。
 *
 * ★ 判据钉四件事：
 *   ① 阅读页那一支不许出现 `shown.topDir` / `shown.sort`（形态读不出来就**显式报
 *      「判据失效」**，不许静默通过 —— 本项目吃过「锚点消失 ⇒ 恒真空断言」的亏）；
 *   ② 阅读页的排序必须走 `READING_SORT` 那个常量；
 *   ③ 那个常量的取值必须是 `SORTS` 里**真实存在**的键 —— 写错时 `filterBooks` 末尾的
 *      `??` 会**静默**退回按书名，界面上完全看不出异常；
 *   ④ 行内动作按钮的文案必须来自 `bookRowView`，不许在这里再写一份（0.9.1 刚把
 *      「已在阅读」改成「弃读 / 重新阅读 / 移出」，写死的文案会让这次改名静默回退）。
 */
function hiddenControlViolationsOf(code) {
  const found = [];
  const visible = declarationOf(code, 'visible');
  if (visible === null) return ['找不到 visible 的声明 —— 判据失效了，先修断言'];

  const readingSort = /const READING_SORT = '([^']*)';/.exec(code)?.[1];
  const sortsDecl = /const SORTS = \[([\s\S]*?)\n\];/.exec(code)?.[1];
  if (readingSort === undefined || sortsDecl === undefined) {
    return ['读不出 READING_SORT / SORTS —— 判据失效了，先修断言（别让它静默通过）'];
  }
  const sortKeys = [...sortsDecl.matchAll(/\['([^']*)',/g)].map((match) => match[1]);
  if (sortKeys.length < 2) found.push(`只从 SORTS 里解析出 ${sortKeys.length} 个键，判据多半失效了`);
  if (!sortKeys.includes(readingSort)) {
    found.push(`阅读页的排序键 '${readingSort}' 不在 SORTS 里 —— filterBooks 会静默退回按书名，界面看不出异常`);
  }

  /**
   * ★ 0.20.4：`scope` 现在有**两支**（`listId` 与 `dir` 各一行三目），所以这里遍历
   *   `visible` 里**所有** `onReadingTab ? A : B` 形态，而不是只抓第一个匹配 ——
   *   只抓第一个的话，第二支（`dir`）偷偷改成阅读页也生效是**看不出来**的。
   * ★ 判据本体没变：`B` 用到某个下拉的 state 时，`A` 就不许也碰它 ——
   *   阅读页没有那个控件，碰了就是「看不见的条件在筛列表」。
   */
  for (const key of ['scope', 'sort']) {
    const pairs = [...visible.matchAll(/onReadingTab\s*\?\s*([^:?\n]+?)\s*:\s*([^;\n]+)/g)]
      .map(([, yes, no]) => ({ yes: yes.trim(), no: no.trim() }))
      .filter((pair) => pair.no.includes(`shown.${key}`));
    if (pairs.length === 0) {
      found.push(`visible 里读不出「阅读页的 ${key}」那一支 —— 判据失效了，先修断言（别让它静默通过）`);
      continue;
    }
    for (const pair of pairs) {
      if (pair.yes.includes('shown.')) {
        found.push(`阅读页没有${key === 'sort' ? '排序' : '来源/分类'}控件，却还在用它的 state（${pair.yes}）`
          + ' —— 列表会被一个看不见、也改不回来的条件筛着或排着');
      }
    }
    if (key === 'sort') {
      for (const pair of pairs) {
        if (pair.yes !== 'READING_SORT') {
          found.push(`阅读页的排序写成了 ${pair.yes} —— 必须走 READING_SORT，`
            + '否则上面那条「排序键必须合法」的判据管不到它');
        }
      }
    }
  }

  /**
   * ★ 0.9.5 起：分类与排序**各自**挂一个 `!onReadingTab` 条件 —— 不再是「一整块被罩住」。
   *   搜索系统改成两行（0.9.5 的网格 → 0.9.6 的 flex 行）后，结果行插在两者之间，
   *   外层的「三件套」包裹没有了。所以这里逐个守；少守一个，
   *   「阅读页不许有排序下拉」就会从那个缺口漏掉。
   */
  for (const [label, cls] of [['分类', 'npr-lib-dir'], ['排序', 'npr-lib-sort']]) {
    const gated = new RegExp(`!onReadingTab\\s*&&\\s*\\(\\s*<label className="${cls}">`).test(code);
    if (!gated) {
      found.push(`${label}下拉没有挂在「只在书架页」的条件里 —— 阅读页会出现这个下拉（0.9.1 用户明确要取消）`);
    }
  }

  /**
   * ★ 锚点必须容忍 `<button` 与 `className` 之间的**其它属性**：0.9.4 给两个按钮各加了
   *   一个 `key={action.kind}`，而旧锚点写的是 `<button type="button" className=…`
   *   —— 属性一多就匹配不上。这次它是**显式报红**（「找不到动作位」）而不是静默放行，
   *   正是「锚点消失必须报判据失效」那条纪律要的效果；但锚点本身也该写得松一点。
   */
  const actionTag = /<button[^>]*className=\{`npr-bookrow-action[\s\S]*?<\/button>/.exec(code)?.[0];
  /**
   * 动作位有**两种元素形态**，两种都要守。
   * ★ 书架页「已加入」显示的是**状态**「已开始阅读」（用户原话：「『+ 阅读』就变为
   *   『已开始阅读』」）⇒ 必须是 `span` 而不是 `button`：一个点了没反应的按钮就是
   *   「看起来像功能」，而本项目最怕这个。
   * ★ 0.9.4 起一个行可以有**两个**按钮（弃读 = 「+ 阅读」+「移出」）⇒ 动作位是
   *   `view.actions.map(...)`，文案与回调都从每一项上取（见下面三条）。
   */
  const statusTag = /<span className="npr-bookrow-status"[\s\S]*?<\/span>/.exec(code)?.[0];
  if (actionTag === undefined || statusTag === undefined) {
    found.push('找不到动作位（动作按钮 / 状态标签）—— 判据失效了，先修断言');
  } else {
    for (const [name, tag] of [['动作按钮', actionTag], ['状态标签', statusTag]]) {
      if (!/\{action\.text\}|\{view\.statusLabel\.text\}/.test(tag)) {
        found.push(`${name}的文字不是 bookRowView 给的 —— 文案会与那张真值表漂移`);
      }
      if (/[\u4e00-\u9fff]/.test(tag)) {
        found.push(`${name}的文案是写死的 —— 必须来自 bookRowView（那张真值表有真跑用例守着）`);
      }
    }
    if (!/view\.statusLabel\s*!==\s*null\s*\?/.test(code)) {
      found.push('动作位没有按 `statusLabel` 分岔 —— 状态标签会被渲染成按钮（或反过来）');
    }
    // ★ 三个「一行两个按钮」才需要的判据。少任何一条，弃读那一行的「+ 阅读」
    //   都会在某次重构里**静默消失**（少渲染一个按钮不会报错、也不会让别的用例红）。
    if (!/view\.actions\.map\(/.test(code)) {
      found.push('动作位没有把 `view.actions` **全部**渲染出来 —— 弃读那一行会少一个按钮');
    }
    if (!/onClick=\{runners\[action\.kind\]\}/.test(code)) {
      found.push('按钮的 onClick 不是按 `kind` 查表 —— 「按钮上写什么」与「点下去做什么」会漂移');
    }
    if (!/key=\{action\.kind\}/.test(code)) {
      found.push('两个按钮没有各自稳定的 key —— React 会按位置复用，文案与回调会串到另一行');
    }
  }

  return found;
}

describe('★ 书架：阅读页不许被「看不见的控件」筛着 / 排着', () => {
  it('当前实现通过全部判据', () => {
    assert.deepEqual(hiddenControlViolationsOf(app), []);
  });

  it('★ 反向对照 ①：阅读页改回「按 sort 排」必须变红', () => {
    const mutated = app.replace(
      'const order = onReadingTab ? READING_SORT : shown.sort;',
      'const order = onReadingTab ? shown.sort : shown.sort;',
    );
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      hiddenControlViolationsOf(mutated).some((item) => item.includes('看不见')),
      '阅读页没有排序控件却继续按 sort 排，居然没被判红 —— 那这条判据挡不住它',
    );
  });

  it('★ 反向对照 ②：排序键写错必须变红（filterBooks 会静默退回按书名）', () => {
    const mutated = app.replace("const READING_SORT = 'recent';", "const READING_SORT = 'recents';");
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      hiddenControlViolationsOf(mutated).some((item) => item.includes('不在 SORTS 里')),
      '把一个不存在的排序键当成阅读页顺序，居然没被判红',
    );
  });

  it('★ 反向对照 ③：把排序下拉的页面条件反掉必须变红', () => {
    // ★ 锚点写成**空白无关**的：0.9.6 把排序那行从 12 空格缩进挪到 14 空格，
    //   抄死缩进的锚点当场失效（对照会红，但红的是锚点不是判据 —— 白跑一趟）。
    const mutated = app.replace(
      /\{!onReadingTab && (\(\s*<label className="npr-lib-sort">)/,
      '{onReadingTab && ($1',
    );
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      hiddenControlViolationsOf(mutated).some((item) => item.includes('只在书架页')),
      '阅读页又出现了排序下拉，居然没被判红',
    );
  });

  it('★ 反向对照 ④：把动作按钮的文案写死必须变红', () => {
    const mutated = app.replace('{action.text}', '已在阅读');
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      hiddenControlViolationsOf(mutated).some((item) => item.includes('写死')),
      '把按钮文案写回硬编码的「已在阅读」居然没被判红 —— 那 0.9.1 的改名会静默回退',
    );
  });

  it('★ 反向对照 ⑤：锚点消失时必须报「判据失效」，不许静默通过', () => {
    assert.ok(
      hiddenControlViolationsOf(app.replace(
        'const order = onReadingTab ? READING_SORT : shown.sort;',
        'const order = shown.sort;',
      )).some((item) => item.includes('判据失效')),
      '阅读页的排序不再写成三元时，必须显式报「判据失效」而不是静默通过',
    );
    assert.deepEqual(
      hiddenControlViolationsOf(app.replace('const READING_SORT = ', 'const SOMETHING_ELSE = ')),
      ['读不出 READING_SORT / SORTS —— 判据失效了，先修断言（别让它静默通过）'],
    );
  });

  it('★ 反向对照 ⑥：把「已开始阅读」那个状态标签改回按钮必须变红', () => {
    const mutated = app.replace(
      '<span className="npr-bookrow-status" title={view.statusLabel.title}>{view.statusLabel.text}</span>',
      '<button type="button" className="npr-bookrow-status" onClick={run}>{view.statusLabel.text}</button>',
    );
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      hiddenControlViolationsOf(mutated).some((item) => item.includes('找不到动作位')),
      '把状态标签改回按钮居然没被判红 —— 那这条判据守不住「状态不该长成按钮」',
    );
  });

  /**
   * ★★ 0.9.4 新增的两条对照：守「弃读那一行有**两个**按钮」。
   *   这是本次改动的核心，而它的失效形态是**静默**的 —— 少渲染一个按钮不会报错、
   *   不会让别的用例红，界面上只是少了一个「+ 阅读」。
   */
  it('★ 反向对照 ⑦：只渲染第一个动作（弃读行少掉「+ 阅读」）必须变红', () => {
    const mutated = app.replace('view.actions.map(', 'view.actions.slice(0, 1).map(');
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      hiddenControlViolationsOf(mutated).some((item) => item.includes('全部')),
      '弃读那一行少了一个按钮，居然没被判红 —— 那「+ 阅读」随时会静默消失',
    );
  });

  it('★ 反向对照 ⑧：把 onClick 写死成某个回调必须变红', () => {
    const mutated = app.replace('onClick={runners[action.kind]}', 'onClick={runners.drop}');
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      hiddenControlViolationsOf(mutated).some((item) => item.includes('查表')),
      '两个按钮点下去做同一件事，居然没被判红 —— 「移出」会把书标成弃读',
    );
  });
});

/**
 * 搜索系统（2026-10-09 用户定，0.9.3）。
 *
 * 用户原话：「顶部的输入搜索框建议移动到下面，与全部分类+按书名形成一个完整搜索
 * 系统」「我如果知道书的分类，就输入框输入书名的关键字，选择书的分类，然后搜索」。
 *
 * 五条判据，每条都配反向对照：
 *   ① 工具栏里**不许**再有搜索框 —— 它搬走了；工具栏那两件是「换页面」「重新取数」；
 *   ② 搜索系统在筛选条**下面** —— 「移动到下面」就是这一条；
 *   ③ 搜索框 / 分类 / 结果行 / 排序在**同一个块**里 —— 「一个完整搜索系统」就是这一条；
 *   ④ 搜索框**两页都渲染** —— 被 `!onReadingTab` 罩住的话阅读页没有搜索框，
 *      而且同一个输入框会在切页时跳位置。
 *   ⑤ ★ 0.9.5 新增：**DOM 顺序 = 视觉顺序**（搜索框 → 分类 → 结果行 → 排序）。
 *      两行网格靠 `grid-template-areas` 摆放，**不看** DOM 顺序 —— 把 `npr-status`
 *      写回排序后面（旧逻辑顺序）能过构建、能过渲染，只在画面上悄悄把结果行
 *      挪进排序的格子。几何判据量得到，源码级也要钉一道。
 *
 * ★ 这里刻意**一个反斜杠都不用**：锚点靠 `.*?` + `s` 标志与 `[/]` 拼出来，
 *   换行也不用转义字面量。理由是「写进源码的东西」和「断言里读出来的东西」
 *   必须是同一串字符 —— 少一种转义就少一种两边不一致的可能。
 * ★ 0.9.6 起搜索系统是**两条独立的 flex 行**（`<div className="npr-lib-row">`），
 *   每行 =「一个可伸缩项 + 一个按内容定宽的下拉」。0.9.5 的具名区域网格已经拿掉：
 *   网格的两列是**共用**的，右列宽度 = 该列所有格子里最宽的那个（分类最长标签
 *   「系列丛书全套（1419）」实测约 147px），排序下拉因此永远缩不下来 ——
 *   用户报的「结果行文字折成两行」就是这么来的。
 *   行数、以及每行装哪两件，由判据 ⑦/⑧ 在**源码层**钉住；几何层另有
 *   `scripts/check-library-sidebar-layout.mjs`（真 Chrome 量宽）。
 * ★ 「块」的边界按缩进找：从 `<div className="npr-lib-controls"` 到同缩进
 *   （8 空格）的收尾 `</div>`。**不能**用惰性 `.*?</div>` —— 块里第一个 `</div>`
 *   是内层行的收尾，那样只会覆盖到第一行。
 * ★ 变异一律**只作用在块内**（`mutateBlock`）：跨块的 `String.replace` 会命中
 *   文件里别处的同名串，把对照变成假绿（本项目栽过：`SRC.replace` 打错目标）。
 */
const TOOLBAR_RE = /<div className="npr-sidebar-toolbar".*?<[/]div>/s;
const CONTROLS_OPEN = '<div className="npr-lib-controls"';
const CONTROLS_CLOSE = '\n        </div>';
const ROW_OPEN = '<div className="npr-lib-row">';
/** 行自己收尾在 10 空格缩进。 */
const ROW_CLOSE = '\n          </div>';
const INPUT_RE = /<input ref=.searchRef..*?[/]>/s;
const STATUS_RE = /<div className=\{`npr-status[^\n]*[/]div>/;
const SORT_RE = /<label className="npr-lib-sort">.*?[/]label>/s;
const GATE = '{!onReadingTab && (';
/** 四件的「在哪」标记 —— 都用源码里的原文（带引号的更不容易互相误命中）。 */
const PARTS = [
  ['搜索框', 'className="npr-lib-search"'],
  ['分类', 'className="npr-lib-dir"'],
  ['结果行', 'npr-status'],
  ['排序', 'className="npr-lib-sort"'],
];
/** 每行该装哪两件、谁在前 —— 0.9.6 的「两行」就是靠它钉住的。 */
const ROW_PARTS = [
  ['第一行', [PARTS[0], PARTS[1]]],
  ['第二行', [PARTS[2], PARTS[3]]],
];
/** 对调两段子串用的占位符（两段互为子串时连着两次 `replace` 会来回抵消）。 */
const SWAP_SLOT = '/* npr-swap-slot */';

/** 取「搜索系统」那一块（含收尾 `</div>`）；取不到返回 undefined。 */
function controlsBlockOf(code) {
  const at = code.indexOf(CONTROLS_OPEN);
  if (at === -1) return undefined;
  const end = code.indexOf(CONTROLS_CLOSE, at);
  if (end === -1) return undefined;
  return code.slice(at, end + CONTROLS_CLOSE.length);
}

/** 取块里的每一条行（按 10 空格缩进的收尾 `</div>` 切）；取不到返回 []。 */
function rowBlocksOf(block) {
  const rows = [];
  let at = block.indexOf(ROW_OPEN);
  while (at !== -1) {
    const end = block.indexOf(ROW_CLOSE, at);
    if (end === -1) break;
    rows.push(block.slice(at, end + ROW_CLOSE.length));
    at = block.indexOf(ROW_OPEN, end + ROW_CLOSE.length);
  }
  return rows;
}

/** 只改块内；锚点没命中就抛 —— 免得对照静默变成假绿。 */
function mutateBlock(code, mutate, what) {
  const block = controlsBlockOf(code);
  if (block === undefined) throw new Error('取不到搜索系统那一块 —— 先修锚点');
  const next = mutate(block);
  if (next === block) throw new Error(`变异没有生效（锚点没命中）：${what}`);
  return code.replace(block, next);
}

function searchSystemViolationsOf(code) {
  const found = [];
  const toolbar = TOOLBAR_RE.exec(code)?.[0];
  const block = controlsBlockOf(code);
  if (toolbar === undefined || block === undefined) {
    return ['找不到工具栏 / 搜索系统那一块 —— 判据失效了，先修断言（别让它静默通过）'];
  }

  if (toolbar.includes('npr-lib-search')) {
    found.push('搜索框又出现在顶部工具栏里 —— 它已经搬到筛选条下面了'
      + '（工具栏里那两件是「换页面」和「重新取数」）');
  }

  const filtersAt = code.indexOf('<div className="npr-filters"');
  const blockAt = code.indexOf(CONTROLS_OPEN);
  if (filtersAt === -1 || blockAt === -1 || blockAt < filtersAt) {
    found.push('搜索系统不在筛选条下面 —— 用户要的是「输入关键字 + 选分类」挨在一起');
  }

  // 结尾那个引号是判据的一部分：`className="npr-lib-sort"` 与 `…sortbox"` 就靠它区分
  // （0.9.3 为 `npr-lib-search` / `npr-lib-searchbar` 的前缀关系踩过一次）。
  for (const [label, marker] of PARTS) {
    if (!block.includes(marker)) {
      found.push(`${label}不在搜索系统里 —— 四件被拆开了，「完整搜索系统」不成立`);
    }
  }

  const gateAt = block.indexOf(GATE);
  const head = gateAt === -1 ? block : block.slice(0, gateAt);
  if (!head.includes('className="npr-lib-search"')) {
    found.push('搜索框被「只在书架页」的条件罩住了 —— 阅读页会没有搜索框，切页时它还会跳位置');
  }

  // ★ 判据 ⑤：DOM 顺序必须与视觉顺序一致（四件都在时才判，缺件由 ③ 报）。
  const at = PARTS.map(([, marker]) => block.indexOf(marker));
  if (at.every((index) => index !== -1) && !(at[0] < at[1] && at[1] < at[2] && at[2] < at[3])) {
    found.push('四件的 DOM 顺序不是「搜索框 → 分类 → 结果行 → 排序」——'
      + 'flex 行按 DOM 顺序摆，所以这个错不会报错，只会在画面上把结果行摆到排序右边');
  }

  // ★ 判据 ⑦（0.9.6）：搜索系统必须是**两条行**。退回单块 = 退回 0.9.5 的共用列网格，
  //   排序下拉会被分类那一列撑宽、结果行文字折行 —— 用户这次报的就是它。
  const rows = rowBlocksOf(block);
  if (rows.length !== 2) {
    found.push(`搜索系统不是两条行（实得 ${rows.length} 条）——`
      + '退回单块会让排序下拉被分类那一列撑宽，结果行文字折行');
    return found; // 行数不对时 ⑧ 没有意义，报一条就够
  }

  // ★ 判据 ⑧：每行「可伸缩项在前、按内容定宽的下拉在后」。flex 行按 DOM 顺序摆，
  //   顺序写反下拉就跑到左边、右边空出来（不会报错，只是画面不对）。
  ROW_PARTS.forEach(([rowLabel, [left, right]], index) => {
    const row = rows[index];
    const leftAt = row.indexOf(left[1]);
    const rightAt = row.indexOf(right[1]);
    if (leftAt === -1 || rightAt === -1) {
      found.push(`${rowLabel}里${leftAt === -1 ? left[0] : right[0]}不见了 —— 两条行的分工被打乱`);
    } else if (!(leftAt < rightAt)) {
      found.push(`${rowLabel}里${right[0]}排在${left[0]}前面 ——`
        + 'flex 行按 DOM 顺序摆，下拉会跑到左边、右边空出来');
    }
  });

  return found;
}

describe('★ 书架：搜索框必须与分类 / 结果 / 排序合成一套（0.9.3 用户定，0.9.6 两行）', () => {
  it('当前实现通过全部判据', () => {
    assert.deepEqual(searchSystemViolationsOf(app), []);
  });

  it('锚点先自证 —— 取不到就得在这里红，不许让后面几条对照变成假绿', () => {
    const block = controlsBlockOf(app);
    assert.notEqual(block, undefined, '取不到搜索系统那一块');
    assert.notEqual(TOOLBAR_RE.exec(app), null, '取不到顶部工具栏');
    assert.notEqual(INPUT_RE.exec(app), null, '取不到搜索框');
    assert.notEqual(STATUS_RE.exec(app), null, '取不到结果行');
    assert.notEqual(SORT_RE.exec(app), null, '取不到排序那一段（对调对照要用它）');
    assert.ok(app.includes('data-window-drag>'), '取不到工具栏锚点');
    assert.ok(app.includes(GATE), '取不到「只在书架页」那个闸门');
    assert.ok(app.includes('<div className="npr-libtabs"'), '取不到分页锚点');
    for (const [label, marker] of PARTS) {
      assert.ok(block.includes(marker), `块里取不到${label}的锚点：${marker}`);
    }
    // ★ 块边界必须**止于**收尾 `</div>`，而不是被内层行自己的 `</div>` 提前截断。
    assert.ok(block.includes(STATUS_RE.exec(app)[0]), '块没覆盖到结果行 —— 边界取错了');
    assert.ok(block.trimEnd().endsWith('</div>'), '块没覆盖到收尾 </div> —— 边界取错了');
    // ★ 切行也必须先自证：切不出两条行，判据 ⑦/⑧ 与下面两条对照全是假绿。
    const rows = rowBlocksOf(block);
    assert.equal(rows.length, 2, `块里切出 ${rows.length} 条行（应 2 条）—— 行锚点取错了`);
    assert.ok(rows[0].includes(PARTS[0][1]) && rows[0].includes(PARTS[1][1]),
      '第一行里没有「搜索框 + 分类」—— 行锚点取错了');
    assert.ok(rows[1].includes(PARTS[2][1]) && rows[1].includes(PARTS[3][1]),
      '第二行里没有「结果行 + 排序」—— 行锚点取错了');
  });

  it('★ 反向对照 ①：把搜索框放回顶部工具栏必须变红', () => {
    const mutated = app.replace('data-window-drag>', 'data-window-drag><input className="npr-lib-search" />');
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      searchSystemViolationsOf(mutated).some((item) => item.includes('顶部工具栏')),
      '搜索框搬回工具栏居然没被判红 —— 那这次搬家随时会静默回退',
    );
  });

  it('★ 反向对照 ②：把搜索系统挪回筛选条上面必须变红', () => {
    const block = controlsBlockOf(app);
    const mutated = app.replace(block, '')
      .replace('<div className="npr-libtabs"', () => block + '<div className="npr-libtabs"');
    assert.notEqual(mutated, app, '变异没有生效 —— 这条对照是假绿，先修锚点');
    assert.ok(
      searchSystemViolationsOf(mutated).some((item) => item.includes('不在筛选条下面')),
      '搜索系统又回到筛选条上面，居然没被判红',
    );
  });

  it('★ 反向对照 ③：把搜索框从搜索系统里摘出去必须变红', () => {
    const mutated = mutateBlock(app, (b) => b.replace(INPUT_RE, ''), '摘掉搜索框');
    assert.ok(
      searchSystemViolationsOf(mutated).some((item) => item.includes('搜索框不在搜索系统里')),
      '搜索框和分类 / 排序分了家，居然没被判红',
    );
  });

  it('★ 反向对照 ④：把排序从搜索系统里拆出去必须变红', () => {
    const mutated = mutateBlock(app,
      (b) => b.replace('<label className="npr-lib-sort">', '<label className="npr-lib-sortbox">'),
      '把排序改名成块外的类');
    assert.ok(
      searchSystemViolationsOf(mutated).some((item) => item.includes('排序不在搜索系统里')),
      '排序被拆出搜索系统（四件变三件），居然没被判红',
    );
  });

  it('★ 反向对照 ⑤：把搜索框塞进「只在书架页」的条件里必须变红', () => {
    const mutated = mutateBlock(app, (b) => b.replace(INPUT_RE, (match) => GATE + match), '罩住搜索框');
    assert.ok(
      searchSystemViolationsOf(mutated).some((item) => item.includes('阅读页会没有搜索框')),
      '搜索框被书架页的条件罩住，居然没被判红 —— 那阅读页会没有搜索框，切页时还会跳位置',
    );
  });

  it('★ 反向对照 ⑥：把结果行写回排序后面（旧逻辑顺序）必须变红', () => {
    const mutated = mutateBlock(app, (b) => {
      const status = STATUS_RE.exec(b)[0];
      return b.replace(status, '').replace(/\n        <[/]div>$/, `\n          ${status}\n        </div>`);
    }, '把结果行挪到排序后面');
    assert.ok(
      searchSystemViolationsOf(mutated).some((item) => item.includes('DOM 顺序')),
      'DOM 顺序与视觉顺序分叉了，居然没被判红 —— 结果行会画进排序的格子',
    );
  });

  it('★ 反向对照 ⑦：四件退回**一个块**（0.9.5 的共用列形状）必须变红', () => {
    // 删掉「第一行收尾 + 第二行开头」这一对，两条行就并成一条 ——
    // 正是 0.9.5 那个共用列网格的 DOM 形状（也是用户报的折行的来源）。
    const mutated = mutateBlock(app,
      (b) => b.replace(ROW_CLOSE + '\n          ' + ROW_OPEN, ''), '把两条行并成一条');
    assert.ok(
      searchSystemViolationsOf(mutated).some((item) => item.includes('不是两条行')),
      '退回单块居然没被判红 —— 那排序下拉随时会被分类那一列重新撑宽、结果行重新折行',
    );
  });

  it('★ 反向对照 ⑧：第二行里「结果行」与「排序」对调必须变红', () => {
    const mutated = mutateBlock(app, (b) => {
      const rows = rowBlocksOf(b);
      const row2 = rows[1];
      const status = STATUS_RE.exec(row2)[0];
      const sort = SORT_RE.exec(row2)[0];
      // 两段互为子串时连着两次 replace 会来回抵消，所以借一个占位符对调。
      const swapped = row2.replace(status, SWAP_SLOT).replace(sort, status).replace(SWAP_SLOT, sort);
      return b.replace(row2, swapped);
    }, '对调第二行里的结果行与排序');
    assert.ok(
      searchSystemViolationsOf(mutated).some((item) => item.includes('第二行')),
      '结果行与排序对调了，居然没被判红 —— 那样排序会跑到左边、右边空出来',
    );
  });

  it('★ 反向对照 ⑨：锚点消失时必须报「判据失效」，不许静默通过', () => {
    assert.deepEqual(
      searchSystemViolationsOf(app.replace(CONTROLS_OPEN, '<div className={`npr-lib-panel')),
      ['找不到工具栏 / 搜索系统那一块 —— 判据失效了，先修断言（别让它静默通过）'],
    );
  });
});

// ---------------------------------------------------------------------------
// 搜索词的**作用域**（0.18.3）
// ---------------------------------------------------------------------------

/**
 * ★ 用户实测（2026-10-23）：在书架搜「《译文名著文库》」→ 点「+ 阅读」→ 切到阅读页，
 *   统计条写着「1 / 5 本」，另外 4 本**全被那个搜索词筛掉了**，他的原话是
 *   「之前添加的阅读书不显示了呢」。
 *
 * 这与 0.9.0（分类）/ 0.9.1（排序）是**同一类缺陷**：控件看不见、列表却被隐藏条件筛着。
 * 但那两次的解法是「阅读页干脆不生效」（那两个控件在阅读页根本不渲染）；搜索不一样 ——
 * 输入框两页都在，所以正确解法是**两页各记各的**。
 *
 * 判据答的问题：`query` 到底是一份共用的，还是按当前页取的？
 */
function queryScopeViolationsOf(code) {
  const found = [];
  if (/const\s*\[\s*query\s*,\s*setQuery\s*\]\s*=\s*useState\(/.test(code)) {
    found.push('搜索词还是一份共用的 useState —— 在书架搜过的词会跟着带到阅读页，把那几本筛没');
  }
  for (const name of ['shelfQuery', 'readingQuery']) {
    if (!new RegExp(`const\\s*\\[\\s*${name}\\s*,`).test(code)) {
      found.push(`没有独立的 ${name} —— 「两页各记各的搜索词」这条契约不成立`);
    }
  }
  if (!/const\s+query\s*=\s*onReadingTab\s*\?/.test(code)) {
    found.push('query 不是按当前页取的那一份 —— 要么两页共用、要么写死其中一页');
  }
  if (!/const\s+setQuery\s*=\s*onReadingTab\s*\?/.test(code)) {
    found.push('setQuery 没有按当前页分派 —— 在阅读页打字会写进书架那一份');
  }
  // 筛选生效时界面必须**自己说出来**并且能一键清掉：只靠统计条那个「1 / 5 本」，
  // 用户看到的是「我的书不见了」，而不是「有筛选条件」。
  // ★ 结尾那个引号是判据的一部分：`npr-lib-querychip` 与 `npr-lib-querychip-gone`
  //   靠它区分（本项目为 `npr-lib-search` / `npr-lib-searchbar` 的前缀关系踩过一次）。
  if (!/className="npr-lib-querychip"/.test(code)) {
    found.push('没有「筛选：xxx」那颗 chip —— 筛掉了多少本、怎么恢复，界面上没有交代');
  }
  return found;
}

describe('★ 搜索词的作用域：两页各记各的（0.18.3）', () => {
  it('当前实现通过全部判据', () => {
    assert.deepEqual(queryScopeViolationsOf(app), []);
  });

  it('★ 反向对照：回到「一份共用的 query」必须被判红', () => {
    const old = app
      .replace("const [shelfQuery, setShelfQuery] = useState('');", "const [query, setQuery] = useState('');")
      .replace("const [readingQuery, setReadingQuery] = useState('');", '')
      .replace('const query = onReadingTab ? readingQuery : shelfQuery;', '')
      .replace('const setQuery = onReadingTab ? setReadingQuery : setShelfQuery;', '');
    assert.notEqual(old, app, '变异没生效 —— 这条反向对照是假的');
    const found = queryScopeViolationsOf(old);
    assert.ok(found.some((item) => item.includes('共用')), `没判出「共用一份」：${found.join(' | ')}`);
  });

  it('★ 反向对照：把「筛选：xxx」那颗 chip 去掉必须被判红', () => {
    const found = queryScopeViolationsOf(app.replace(/className="npr-lib-querychip"/g, 'className="npr-lib-querychip-gone"'));
    assert.ok(found.some((item) => item.includes('筛选：xxx')), `没判出缺 chip：${found.join(' | ')}`);
  });
});

/**
 * 欢迎页那段说明文字：**不许只写网盘**（0.25.5）。
 *
 * 用户原话：「这个说明文字改一下。不仅是只有网盘还有本地目录」。
 * 书源有三种（本地目录 / 百度网盘 / 外部书单），而原本文案标题就叫「读网盘里的书」、
 * 首句写「书架是网盘上的全部书」—— 一个只配了本地目录的用户读到这页，
 * 会以为这不是给他看的地方。**文案错一层，功能就白做。**
 *
 * ★ 标题后来改成了 slogan「随心所阅，无界书房」，它**不承担列举数据源的责任**；
 *   列源落在第一段（书架放全部的书：本地目录 / 百度网盘 / 外部书单）。判据取的是
 *   h2 + 三段说明这一整块：slogan 里不出现这两个词不影响，而一旦有人把第一段里的
 *   「本地目录、百度网盘、外部书单」抹掉，就必然判红。
 *
 * ★ 0.25.5 修订：说明文字从**一个自然段**拆成三段（书架 / 怎么开始读 / 能干什么）。
 *   用户原话：「现在根本就看不懂」。判据本身不用改 —— 它扫的是整块可见文字，
 *   拆段只是让这句话更好读，不该影响「有没有说本地」这条事实。
 */
function welcomeCopyOf(code) {
  const at = code.indexOf('className="npr-welcome"');
  if (at === -1) return '';
  const end = code.indexOf('className="npr-welcome-keys"', at);
  return code.slice(at, end === -1 ? at + 2000 : end);
}

function welcomeViolationsOf(code) {
  const copy = welcomeCopyOf(code);
  if (copy === '') return ['找不到欢迎页文案 —— 结构改了，这条守卫要跟着改'];
  const found = [];
  // 「本地」是判据的核心：三种书源里它是**最容易被文案漏掉**的那一种，
  // 因为它不像「网盘」那样自带一个服务名。
  if (!/本地/.test(copy)) found.push('欢迎页文案没有「本地」—— 只配了本地目录的用户会以为这页不是给他的');
  if (!/网盘/.test(copy)) found.push('欢迎页文案没有「网盘」—— 反过来漏掉网盘，配了网盘的人读不到对应说明');
  return found;
}

describe('★ 欢迎页文案：书源不止网盘一种（0.25.5）', () => {
  it('当前实现通过（首句把本地 / 网盘 / 外部书单都说了）', () => {
    assert.deepEqual(welcomeViolationsOf(app), []);
  });

  it('★ 反向对照：把第一段的三种源抹掉必须判红', () => {
    // 标题是 slogan（「随心所阅，无界书房」），**不承担列举数据源的责任** ——
    // 所以变异只动第一段，标题保持原样。判据因此只该看正文。
    const before = app.replace('（本地目录、百度网盘、外部书单里的都算）', '');
    assert.notEqual(before, app, '变异没生效 —— 这条反向对照是假的');
    const found = welcomeViolationsOf(before);
    assert.ok(found.some((item) => item.includes('本地')), `没判出「只写网盘」：${found.join(' | ')}`);
  });
});

/**
 * 欢迎页统计行必须**按书源分项**（0.25.6）。
 *
 * 用户原话：「这地方是不是根据用户添加的书源时时表达：比如目前：书源：网盘的情况。
 * 本地目录的情况。」
 * 之前那行写死四项（书单 / 已在阅读 / 可阅读 / 总体积），一个字的来源信息都没有；
 * 「书单」与「总体积」还和各源本数之和重复 —— 等于让读者自己加一遍。
 */
function statsViolationsOf(code) {
  const at = code.indexOf('className="npr-welcome-keys"');
  if (at === -1) return ['找不到统计行 —— 结构改了，这条守卫要跟着改'];
  const block = code.slice(at, code.indexOf('</div>', at));
  const found = [];
  if (!/sourceStats\.map\(|\bsourceTotals\(/.test(block)) {
    found.push('统计行没有接书源分项 —— 又变回「书单/已在阅读/可阅读/总体积」了');
  }
  // 「书单」「总体积」是总和的另一说法：各源本数之和 / 体积之和。留着就是重复计数。
  if (/'书单'/.test(block)) found.push('「书单」那项又回来了 —— 各源本数之和已经是它');
  if (/'总体积'/.test(block)) found.push('「总体积」那项又回来了 —— 各源体积之和已经是它');
  return found;
}

describe('★ 欢迎页统计行：按书源分项（0.25.6）', () => {
  it('当前实现通过（源项 + 已在阅读 + 可阅读）', () => {
    assert.deepEqual(statsViolationsOf(app), []);
  });

  it('★ 反向对照：写死原来那四项必须判红', () => {
    const before = app.replace(
      /\.\.\.sourceStats\.map\([\s\S]*?\),\n/,
      "['书单', `${shelfStats.total} 本`],\n                ['已在阅读', `${shelfStats.added} 本`],\n                ['可阅读', `${shelfStats.renderable} 本`],\n                ['总体积', formatBytes(shelfStats.bytes)],\n",
    );
    assert.notEqual(before, app, '变异没生效 —— 这条反向对照是假的');
    const found = statsViolationsOf(before);
    assert.ok(found.length >= 2, `没判出写死的四项：${found.join(' | ')}`);
  });
});
