/**
 * 书内搜索的判据（0.26.0）。
 *
 * 三组断言，各自对着一种「全绿但没用」的坏实现：
 *
 *   ① **判据与 `book_search` 必须同源**（`src/book-find.js`）。两边各写一套的
 *      症状是「AI 说第 7 章有，你在书里搜不到」—— 用户没法判断谁错了。
 *   ② **逐处命中**。`book_search` 每章只回第一处（它是定位器），书内搜索要能
 *      上下条翻。照抄那边的 `break` 会让「共 1 处」变成一个确定的假话。
 *   ③ **PDF 的页文本拼接不能复用 `extractPageText`**。那个函数用空格 join 每个
 *      pdf.js 游程，于是「磨坊」+「主妇」拼成「磨坊 主妇」，跨游程的中文词
 *      永远搜不到 —— 而中文 PDF 的游程边界恰恰在字与字之间。
 *
 * ★ 每条判据都配一条**反向对照**（喂一个已知错误的实现，要求断言变红），
 *   否则这些断言只是把当前实现抄了一遍。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  FIND_LIMIT_MAX, FIND_QUERY_MAX, findOccurrences, normalizeNeedle, pageIndexText, probePages, snippetOf,
} from '../src/book-find.js';
import { findInEbook } from '../src/host/ebook/index.js';
import { splitByOverlays } from '../src/client/ebook-marks.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (name) => stripComments(readFileSync(join(here, '..', 'src', 'client', name), 'utf8'));

// ---------------------------------------------------------------------------
// ① 判据
// ---------------------------------------------------------------------------

describe('normalizeNeedle：去首尾空白 + 小写', () => {
  it('空白去掉、大小写归一', () => {
    assert.equal(normalizeNeedle('  Mill  '), 'mill');
    assert.equal(normalizeNeedle('磨坊主妇'), '磨坊主妇');
    assert.equal(normalizeNeedle(null), '');
    assert.equal(normalizeNeedle(undefined), '');
  });

  it('★ 不截断：超长查询要由调用方明确拒绝（静默截断等于偷换查询）', () => {
    const long = 'x'.repeat(FIND_QUERY_MAX + 20);
    assert.equal(normalizeNeedle(long).length, FIND_QUERY_MAX + 20);
  });
});

describe('findOccurrences：逐处命中、偏移指向原文', () => {
  it('中文子串：不分词，「磨坊」在「磨坊主妇」里也能命中', () => {
    const text = '磨坊主妇站在磨坊门口';
    const hits = findOccurrences(text, '磨坊');
    assert.deepEqual(hits.map(hit => text.slice(hit.start, hit.end)), ['磨坊', '磨坊']);
    assert.deepEqual(hits.map(hit => hit.start), [0, 6]);
  });

  it('同一段文字里的**每一处**都回（不是只回第一处）', () => {
    const text = '水轮转，水轮停，水轮又转。';
    assert.equal(findOccurrences(text, '水轮').length, 3);
    // ★ 反向对照：book_search 那种「每章只报一处」的实现
    const firstOnly = findOccurrences(text, '水轮').slice(0, 1);
    assert.equal(firstOnly.length, 1, '对照：只报一处会少掉两处 —— 书内搜索不能这么做');
  });

  it('大小写不敏感，但偏移仍是**原文**的（切片还原的是原字）', () => {
    const text = 'The Mill and the miller';
    const hits = findOccurrences(text, 'MILL');
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map(hit => text.slice(hit.start, hit.end)), ['Mill', 'mill']);
  });

  it('不重叠推进：aaaa 里搜 aa 是两处，不是三处', () => {
    const hits = findOccurrences('aaaa', 'aa');
    assert.deepEqual(hits, [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });

  it('★ 小写化改变长度时，偏移必须映射回原文（否则高亮整体前移）', () => {
    // 'İ'.toLowerCase() 是 'i' + 组合点两个码点 —— 长度变了。
    const text = 'İX';
    const hits = findOccurrences(text, 'x');
    assert.equal(hits.length, 1);
    assert.equal(text.slice(hits[0].start, hits[0].end), 'X');
    assert.equal(hits[0].start, 1, '映射丢了就会算成 2（越界）');
  });

  it('空查询 / 空文本 = 没有命中（不是「匹配一切」）', () => {
    assert.deepEqual(findOccurrences('磨坊', ''), []);
    assert.deepEqual(findOccurrences('', '磨坊'), []);
  });

  it('上限生效', () => {
    const text = 'a'.repeat(50);
    assert.equal(findOccurrences(text, 'a', { limit: 5 }).length, 5);
    assert.ok(FIND_LIMIT_MAX >= 100);
  });
});

describe('snippetOf：片段要能读，且标明被截断', () => {
  it('两端截断时补省略号', () => {
    const text = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸';
    const hit = findOccurrences(text, '丙丁')[0];
    const snippet = snippetOf(text, hit.start, hit.end, { before: 2, after: 2 });
    assert.equal(snippet, '…甲乙丙丁戊己…');
  });

  it('不截断时不加省略号', () => {
    const snippet = snippetOf('只有这一句', 0, 2, { before: 40, after: 40 });
    assert.equal(snippet, '只有这一句');
  });

  it('空白压成单个空格（PDF 的换行、电子书的空行）', () => {
    const snippet = snippetOf('上一行\n\n  下一行 关键词', 10, 13);
    assert.ok(!snippet.includes('\n'));
    assert.ok(snippet.includes('关键词'));
  });
});

// ---------------------------------------------------------------------------
// ② PDF 页文本拼接（`pageIndexText`）
// ---------------------------------------------------------------------------

describe('pageIndexText：跨游程的中文必须能搜到', () => {
  const items = [
    { str: '第一章 ', hasEOL: true },
    { str: '磨坊' },
    { str: '主妇' },
    { str: '站着' },
  ];

  it('同游程直拼，不插空格', () => {
    assert.equal(pageIndexText(items), '第一章 \n磨坊主妇站着');
    assert.equal(findOccurrences(pageIndexText(items), '磨坊主妇').length, 1);
  });

  it('★ 反向对照：用空格 join（`extractPageText` 的做法）会搜不到', () => {
    const naive = items.map(item => item.str).join(' ').replace(/\s+/g, ' ');
    assert.equal(findOccurrences(naive, '磨坊主妇').length, 0,
      '空格 join 把词拆开 —— 这正是不能复用它做索引的原因');
  });

  it('英文游程之间补一个空格（否则 Thebookexplains）', () => {
    assert.equal(pageIndexText([{ str: 'The' }, { str: 'book' }]), 'The book');
    assert.equal(pageIndexText([{ str: 'explains' }, { str: '.' }]), 'explains.');
  });

  it('hasEOL 换成换行，下一行不与上一行粘连', () => {
    assert.equal(pageIndexText([{ str: '甲', hasEOL: true }, { str: '乙' }]), '甲\n乙');
  });

  it('★ 不设长度上限：上限会让后半本静默不参与检索', () => {
    const long = pageIndexText([{ str: 'x'.repeat(30_000) }]);
    assert.equal(long.length, 30_000);
  });
});

// ---------------------------------------------------------------------------
// ③ 电子书全文检索（宿主侧）
// ---------------------------------------------------------------------------

const EBOOK = {
  sections: [
    {
      title: '第一章 磨坊',
      blocks: [
        { k: 'h1', x: '第一章 磨坊' },
        { k: 'p', x: '磨坊主妇站在磨坊门口，看着磨坊的水轮。' },
        { k: 'p', x: '' },
        { k: 'p', x: 'The Mill and the miller' },
      ],
    },
    { title: '第二章 水轮', blocks: [{ k: 'p', x: '水轮坏了。' }] },
  ],
};

describe('findInEbook：跨节、跨块、逐处', () => {
  it('每题命中都带「第几节 + 第几块 + 块内偏移 + 片段」', () => {
    const result = findInEbook(EBOOK, '磨坊');
    assert.equal(result.query, '磨坊');
    assert.equal(result.total, 4);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.hits.map(hit => hit.n), [1, 1, 1, 1]);
    assert.deepEqual(result.hits.map(hit => hit.block), [0, 1, 1, 1]);
    const blockText = EBOOK.sections[0].blocks[1].x;
    for (const hit of result.hits.filter(item => item.block === 1)) {
      assert.equal(blockText.slice(hit.start, hit.end), '磨坊');
      assert.ok(hit.snippet.includes('磨坊'));
    }
    assert.equal(result.hits[0].sectionTitle, '第一章 磨坊');
  });

  it('大小写不敏感（与 book_search 同判据）', () => {
    const result = findInEbook(EBOOK, 'THE MILL');
    // 'The Mill' 与 'the miller' 各一处 —— 子串判据不认词边界，这正是与 book_search 一致的地方。
    assert.equal(result.total, 2);
    assert.deepEqual(
      result.hits.map(hit => EBOOK.sections[0].blocks[3].x.slice(hit.start, hit.end)),
      ['The Mill', 'the mill'],
    );
  });

  it('空块不参与（渲染端也跳过它们，偏移不会被带偏）', () => {
    const result = findInEbook(EBOOK, '磨坊');
    assert.equal(result.blocks, 4, '两个非空块 + 标题 + 第二章那一段');
    assert.ok(result.hits.every(hit => hit.block !== 2));
  });

  it('上限 + `truncated` 明说截断', () => {
    const result = findInEbook(EBOOK, '磨坊', { limit: 2 });
    assert.equal(result.total, 2);
    assert.equal(result.truncated, true);
  });

  it('空查询抛错（不返回「全部命中」）', () => {
    assert.throws(() => findInEbook(EBOOK, '   '), /query 不能为空/);
  });

  it('扫过的节数 / 字数都报出来（「共 N 处」要能自证范围）', () => {
    const result = findInEbook(EBOOK, '水轮');
    assert.equal(result.sections, 2);
    // 6（标题）+ 19（磨坊那一段）+ 23（英文那句）+ 5（第二章）= 53
    assert.equal(result.chars, 53);
  });
});

describe('★ 判据同源：与 book_search 的 `indexOf` 结果一致', () => {
  const samples = [
    ['The Mill and the miller', 'mill'],
    ['磨坊主妇站在磨坊门口', '磨坊'],
    ['2019 年的 Water Wheel', 'water'],
    ['全角ＡＢＣ与半角abc', 'abc'],
  ];

  it('第一处命中位置与「小写后 indexOf」完全相同', () => {
    for (const [text, needle] of samples) {
      const expected = text.toLowerCase().indexOf(needle);
      const hits = findOccurrences(text, needle);
      assert.equal(hits[0]?.start ?? -1, expected, `${text} / ${needle}`);
    }
  });
});

// ---------------------------------------------------------------------------
// ④ 电子书高亮切片（划线与命中并成一次切割）
// ---------------------------------------------------------------------------

describe('splitByOverlays：命中与划线同层', () => {
  const text = '磨坊主妇站在磨坊门口';

  it('两层都没有 ⇒ 一整片（调用方据此原样返回字符串，不多包节点）', () => {
    assert.deepEqual(splitByOverlays(text, [], []), [
      { from: 0, to: text.length, tone: null, id: '', find: false, current: false },
    ]);
  });

  it('只有命中：标出 find / current', () => {
    const slices = splitByOverlays(text, [], [{ start: 4, end: 6, current: true }]);
    const hit = slices.find(slice => slice.find);
    assert.deepEqual({ from: hit.from, to: hit.to, current: hit.current }, { from: 4, to: 6, current: true });
    assert.equal(slices.reduce((sum, slice) => sum + (slice.to - slice.from), 0), text.length);
  });

  it('★ 命中的边界与划线的边界并成一次切割（命中不被切开）', () => {
    const slices = splitByOverlays(
      text,
      [{ id: 'm1', tone: 'yellow', start: 0, end: 5 }],
      [{ start: 4, end: 6, current: false }],
    );
    // 命中那一处「磨坊」在 4..6，跨过 m1 的右边界 5 ⇒ 必须切成 4..5 + 5..6 两片，
    // **两片都标 find**（否则高亮只剩半个词）。
    const hitSlices = slices.filter(slice => slice.find);
    assert.deepEqual(hitSlices.map(slice => [slice.from, slice.to]), [[4, 5], [5, 6]]);
    assert.deepEqual(hitSlices.map(slice => slice.tone), ['yellow', null], '划线归属仍按原区间');
  });

  it('相邻同属性片段合并（不在一个色块里画出接缝）', () => {
    const slices = splitByOverlays('abcdef', [{ id: 'm1', tone: 'blue', start: 0, end: 3 }], []);
    assert.deepEqual(slices, [
      { from: 0, to: 3, tone: 'blue', id: 'm1', find: false, current: false },
      { from: 3, to: 6, tone: null, id: '', find: false, current: false },
    ]);
  });

  it('越界偏移被夹住（数据坏了也不许画出块外的高亮）', () => {
    const slices = splitByOverlays('abc', [], [{ start: 2, end: 99 }]);
    assert.equal(Math.max(...slices.map(slice => slice.to)), 3);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 两个阅读器都真的接上了（源码级守卫 + 反向对照）
// ---------------------------------------------------------------------------

/**
 * 只查两件**真会静默失效**的事：
 *   ① 面板真的被渲染（漏了它，按钮点下去什么都不发生）；
 *   ② ⌘F 分支真的在（漏了它，浏览器自带的查找会抢走这个键 —— 只搜当前页，
 *      而用户以为在搜全书）。
 * 其余（计数、跳转、高亮）由纯函数用例覆盖。
 */
function findWiringViolations(code, { unit }) {
  const found = [];
  if (!/<BookFindPanel/.test(code)) found.push('没有渲染 <BookFindPanel>');
  if (!new RegExp(`unit="${unit}"`).test(code)) found.push(`没有把 unit="${unit}" 传给面板`);
  if (!/\(event\.key === 'f' \|\| event\.key === 'F'\)/.test(code)) found.push('没有 ⌘F / ⌃F 分支');
  if (!/toggleFind\(\)/.test(code)) found.push('⌘F 没有调用 toggleFind()');
  if (!/onStep=\{stepFind\}/.test(code)) found.push('面板的上/下条没有接到 stepFind');
  return found;
}

describe('阅读器接线（PDF / 电子书各自一份）', () => {
  it('BookReader 与 BookEbook 都接上了面板与 ⌘F', () => {
    assert.deepEqual(findWiringViolations(readCode('BookReader.jsx'), { unit: 'page' }), []);
    assert.deepEqual(findWiringViolations(readCode('BookEbook.jsx'), { unit: 'section' }), []);
  });

  it('★ 反向对照：把 ⌘F 分支删掉，守卫必须变红', () => {
    for (const name of ['BookReader.jsx', 'BookEbook.jsx']) {
      const broken = readCode(name).replace(/\(event\.key === 'f' \|\| event\.key === 'F'\)/g, '(false)');
      const violations = findWiringViolations(broken, { unit: name === 'BookReader.jsx' ? 'page' : 'section' });
      assert.ok(violations.some(item => item.includes('⌘F')), `${name}：删掉 ⌘F 之后守卫没报警`);
    }
  });

  it('★ 反向对照：把面板从树里摘掉，守卫必须变红', () => {
    const broken = readCode('BookReader.jsx').replace(/<BookFindPanel/g, '<div');
    assert.ok(findWiringViolations(broken, { unit: 'page' }).some(item => item.includes('BookFindPanel')));
  });
});

/**
 * 「这本书有没有文字层」的抽样页（0.27.1）。
 *
 * 它只决定**要不要在用户输入之前就把整本索引跑一遍**，所以判据是「覆盖两端 + 不重复」：
 *  - 只抽前几页 ⇒ 一本「封面是扫描件、正文有字」的书会被误判成全扫描；
 *  - 只抽中间 ⇒ 短的扫描书（10 页）会漏掉封面与末页；
 *  - 抽重复的页 ⇒ 6 个名额实际只看 3 页，白花两次 `getTextContent`。
 */
describe('probePages：抽样页', () => {
  it('长书取 6 页，首尾都含在内、且严格递增不重复', () => {
    const pages = probePages(111);
    assert.equal(pages.length, 6);
    assert.equal(pages[0], 1);
    assert.equal(pages.at(-1), 111);
    assert.deepEqual([...pages].sort((a, b) => a - b), pages);
    assert.equal(new Set(pages).size, pages.length);
  });

  it('1–3 页的短书不重复、不越界', () => {
    assert.deepEqual(probePages(1), [1]);
    assert.deepEqual(probePages(2), [1, 2]);
    for (const total of [1, 2, 3, 4, 5]) {
      const pages = probePages(total);
      assert.equal(new Set(pages).size, pages.length, `total=${total} 有重复页`);
      assert.ok(pages.every(page => page >= 1 && page <= total), `total=${total} 越界`);
    }
  });

  it('0 页 / 坏入参不返回页码（空数组，而不是 [1]）', () => {
    for (const value of [0, -5, undefined, null, 'abc', NaN]) {
      assert.deepEqual(probePages(value), [], `${String(value)} 应该没有抽样页`);
    }
  });

  it('★ 抽样只是触发器：它不负责关于全书的结论', () => {
    // 只抽 1 页是没有意义的（那一页可能正好是扉页），所以 `count` 的下限是 2 ——
    // 传 1 会得到首尾两页。这里钉住的是「下限 2」，不是「照抄入参」。
    assert.deepEqual(probePages(500, 1), [1, 500]);
    // 真正的结论在 BookReader 里由 `textless === 总页数` 给出：抽样只决定要不要提前跑索引。
  });
});
