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

/**
 * 要扫的源文件。
 *
 * ★ 0.47 起也扫 `.js`：**图标名有一半已经从 JSX 挪进数据层**了 ——
 *   `row-menu.js` 的 `rowMenuItems()` 与 `diary-origin.js` 的 `originIcon()`
 *   都是「把名字当数据」的产物（正是为了绕开动态 `name` 扫不到的问题）。
 *   只扫 `.jsx` 的话，那几处名字**一个都没被核对过** —— 守卫看起来是绿的，
 *   而它保护的恰好是它没读的那几个文件。
 */
function clientSources() {
  return readdirSync(clientDir)
    .filter((file) => /\.(jsx|js)$/.test(file))
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

    /**
     * 裸标识符（`name={icon}`）：JSX 属性里看不到名字，但**每一处的取值来源都是
     * 本文件里的 `icon: '…'` 字面量**，由下面那条「数据里的 icon 字段」断言兜住 ——
     * 它们不是漏网，只是把检查挪到了取值那一端。
     *
     * ★ 用**逐处登记**而不是「不超过 N 处」：数量阈值挡不住「新增一处、顺手删掉
     *   另一处」这种一进一出 —— 总数不变，洞却换了地方（这正是 0.44.4 之前的实际
     *   状况：阈值卡在 3，而第 4 处早就冒出来了，测试一直红着却只是被当成噪音）。
     * ★ 多一处要红，少一处也要红：少一处说明取值方式变了，这里「来源在哪」的
     *   说明就该跟着改，否则注释会开始撒谎。
     */
    const BARE_SITES = [
      /**
       * 来源：同函数里那个四路三元的四个分支（rss / layers-3 / folder / book-open）。
       * ★ 这四处**扫不到**，而且试过把它内联进 JSX 属性来「变得可查」—— 失败：
       *   属性表达式里的比较值（`=== 'feed'`、`=== 'all'`、`startsWith('group:')`）
       *   会被本测试当成图标名，一次制造三条假红。要让判据认得「条件」与「分支」，
       *   得写一个真正的表达式解析器 —— 那超出了这道守卫该有的分量。
       *   所以如实登记在这里：这一处是真漏网，不是「已经查过了」。
       */
      'ChannelPicker.jsx: name',
      // 出处 chip 上的图标：同一个 `originIcon()`，传的是条目算出来的 origin。
      // 放在数据层而不是 JSX 的三元里，就是因为这一条扫描 —— 三元里的 `'book'` 会被
      // 当成图标名去查，查不到就红。
      // ★ 现在是**两处**：便签墙卡片（约 285 行）与日记条目（约 3181 行）各一颗
      //   出处 chip。`×2` 由下面的出现次数汇总得出，不是手写的注释；少一处要红。
      'DiaryApp.jsx: originIcon(origin) ×2',
      // 0.47：来源收窄横条上那颗图标 —— 也是 `originIcon()`，传进去的是 scope 对象。
      // ★ 顺序按**收集顺序**（文件遍历顺序 → 文件内出现顺序）排，不按需求先后来排：
      //   这份名单是拿 `deepEqual` 比对的，按「读起来更顺」重排会让测试变红 ——
      //   而那种红与图标名毫无关系。
      'DiaryApp.jsx: originIcon(sourceScope)',
      // 来源：`row-menu.js` 的 `rowMenuItems()` 返回项里的 icon 字段（file-check /
      // download / eye-off），由下一条「数据里的 icon 字段」断言核对。
      // ★ 0.45.4 之前这里是 `name={kind === 'print' ? 'file-check' : …}` 的三元 ——
      //   那写法**反而会被上面的字面量断言扫到**，而三元里的比较值 `'print'` /
      //   `'markdown'` 会被当成图标名，制造两条假红。图标名是数据，挪进那张表才干净。
      'ReaderPage.jsx: item.icon',
      // 来源：TABS 每项的 icon 字段（0.44.4 从三元组改成对象，才扫得到）
      'SettingsPage.jsx: icon',
    ];
    /**
     * ★ 同名多处的计数（0.72.3）。
     *
     * `skipped` 是**逐处**收集的：同一个文件里同一个表达式出现两次，就会得到两条
     * 一模一样的字符串（`DiaryApp.jsx` 的便签墙卡片与日记条目各一处
     * `originIcon(origin)`）。`deepEqual` 分不清「两条同名」与「一条」——
     * 它只会报一串看不出差在哪的 JSON，于是有人会顺手删掉一行让它变绿。
     *
     * 按出现次数汇总成 `… ×2`：登记表仍然一处一行、仍然一进一出就红，
     * 而「这里有两处」写在名单上，不用数重复行。
     */
    const tally = new Map();
    for (const site of skipped) tally.set(site, (tally.get(site) ?? 0) + 1);
    const registered = [...tally].map(([site, times]) => (times > 1 ? `${site} ×${times}` : site));

    assert.deepEqual(registered, BARE_SITES,
      `裸标识符取值的清单变了（现在是 ${JSON.stringify(registered)}）。\n`
      + '新增了一处？先确认它的值来自本文件的 icon 字面量（那条断言会替你核对），'
      + '再把这一行登记进来。改成了内联字面量？把它从这里删掉。'
      + '同一处变成了多处？改 `×N` 这个数字，别删掉那一行。');
  });

  /**
   * 裸标识符那一端，**真的跑一遍**（0.72.3）。
   *
   * 名单上写着 `originIcon()` 那两处「是真漏网」。登记不等于核对：它的返回值
   * 是 `'book-open'` / `'file-text'`，既不在 `name="…"` 里（那是裸标识符），
   * 也不在 `icon: '…'` 字段里（那是数据表），两条断言都够不着 ——
   * 把 `'book-open'` 敲成 `'book-opne'`，整个仓库一片绿，界面上画个圆圈。
   *
   * 它没有依赖（只 import `diary-format.js`），所以可以直接 import 进来跑，
   * 把「已登记」升级成「已核对」。
   */
  test('originIcon() 真的会返回存在的图标名（把名单上的那两处漏网兜住）', async () => {
    const { originIcon } = await import('../src/client/diary-origin.js');
    const returned = new Set();
    for (const kind of ['book', 'article']) {
      const name = originIcon({ kind });
      returned.add(name);
      assert.ok(typeof name === 'string' && name !== '', `originIcon({ kind: '${kind}' }) 没给出图标名`);
      assert.ok(defined.has(name), `originIcon({ kind: '${kind}' }) 返回了不存在的图标名 ${JSON.stringify(name)}`);
    }
    // 两个分支必须是**不同**的图标，否则「跟着出处走」这句话是假的。
    assert.equal(returned.size, 2, '书与文章用的是同一个图标 —— 出处就分不出来了');
    // 没有出处时返回空串（调用方用 `origin !== null` 挡着，不该走到这里画出图标）。
    assert.equal(originIcon(null), '', '没有出处时不该给出图标名');

    // 反向对照：制造一处**真实的错字**（`book-open` → `book-opne`，两个字母换位），
    // 判据必须能认出「不存在」—— 否则 `defined` 太宽（比如解析器把整段文本当名字），
    // 上面那两条就是空对空。
    const typo = originIcon({ kind: 'book' }).replace('open', 'opne');
    assert.notEqual(typo, originIcon({ kind: 'book' }), '反向对照的变异没生效');
    assert.equal(defined.has(typo), false, `反向对照失效：${JSON.stringify(typo)} 被当成了存在的图标名`);
  });

  /**
   * 裸标识符那一端的检查。
   *
   * 上一版把裸标识符当「查不到」直接跳过，等于承认守卫在**最脏的那几处**是空的 ——
   * 而 `<Icon name={tab.icon} />` 的错字恰恰是高发区。它们的值都来自同文件里的
   * `icon: '…'` 字面量，所以改查那一端：谁把 `icon: 'book-opne'` 写错，这里就红。
   */
  test('反向对照：数据里的 icon 字段也必须是真名字', () => {
    const missing = [];
    const checkedFiles = [];
    let checked = 0;
    for (const { file, text } of clientSources()) {
      // `data-icon:` 之类不归这里管，所以前面加一个「不是连字符或单词字符」的前提。
      const hits = [...text.matchAll(/(?<![-\w])icon:\s*'([^']+)'/g)];
      if (hits.length > 0) checkedFiles.push(`${file}(${hits.length})`);
      for (const hit of hits) {
        checked++;
        if (!defined.has(hit[1])) missing.push(`${file}: ${hit[1]}`);
      }
    }
    assert.deepEqual(missing, [], `数据里这些 icon 字段不存在：\n${missing.join('\n')}`);
    // 防「正则失配 ⇒ 一个都没扫到 ⇒ 空对空全绿」。
    assert.ok(checked >= 8, `只核到 ${checked} 个 icon 字段（${checkedFiles.join(' ') || '一个文件都没命中'}），正则可能已失配`);
    // 两端都要扫到才算数：`SettingsPage.jsx` 是「UI 里的数据表」、
    // `row-menu.js` 是「挪到 .js 里的数据表」—— 两个位置各扫到一处，说明
    // 这条断言真的覆盖到了两种放法，而不是只命中一边就全绿。
    assert.ok(checkedFiles.some((line) => line.startsWith('SettingsPage.jsx'))
      && checkedFiles.some((line) => line.startsWith('row-menu.js')),
      `两端都要扫到才算数，实际命中：${checkedFiles.join(' ') || '(无)'}`);
  });
});
