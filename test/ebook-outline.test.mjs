/**
 * 电子书目录的层级判据：条目、当前条、页眉的「上级章节」。
 *
 * 这个文件存在的理由：目录缩进与页眉那一行是**同一个问题的两个出口**，
 * 而它们错起来都很安静 —— 缩进错了只是"看着挤"，页眉错了是"写着别的章"，
 * 都不会报错。所以判据抽成纯函数，在这里用真实形状的 index 喂进去，
 * 并且**每一条都配反向对照**：喂一个已知会坏的输入，证明判据会变红。
 * 没有反向对照的断言只是把当前实现抄了一遍。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activeEntryIndex, outlineEntries, runningHead } from '../src/client/ebook-outline.js';

/** 九三年那份真目录的前几段（`/tmp/npie-shot/book.json` 原样抄下来）。 */
const TOC = [
  { title: '目录', section: 1, depth: 0 },
  { title: '扉页', section: 2, depth: 0 },
  { title: '译本序', section: 3, depth: 0 },
  { title: '第一部 在海上', section: 4, depth: 0 },
  { title: '第二卷 克莱莫尔号军舰', section: 7, depth: 0 },
  { title: '二、黑夜笼罩下的军舰和乘客', section: 8, depth: 1 },
  { title: '三、贵族和平民混杂在一起', section: 9, depth: 1 },
];

/** 与 `index` 同形状：`toc` + `sections` 都带上。 */
const INDEX = {
  toc: TOC,
  sections: TOC.map(item => ({ n: item.section, title: item.title, chars: 0, level: item.depth })),
};

describe('outlineEntries：目录条目', () => {
  it('自带目录优先，原样带出 title / section / depth', () => {
    const entries = outlineEntries(INDEX);
    assert.equal(entries.length, TOC.length);
    assert.deepEqual(
      entries.map(e => [e.section, e.depth]),
      TOC.map(e => [e.section, e.depth]),
    );
    assert.equal(entries[3].title, '第一部 在海上');
  });

  it('反向对照：两条同名的「本卷注释」不许被合并成一条', () => {
    // 命名的 key 若用标题拼，这个数组会在 React 侧表现成"少一条"，
    // 而这里能先在纯数据上看出条目数量本身没被吃掉。
    const entries = outlineEntries({
      toc: [
        { title: '本卷注释', section: 10, depth: 0 },
        { title: '本卷注释', section: 40, depth: 0 },
      ],
    });
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0].key, entries[1].key);
  });

  it('没有自带目录时用节索引兜底，层级取宿主的 level', () => {
    const entries = outlineEntries({
      toc: [],
      sections: [
        { n: 1, title: '第一章', chars: 100, level: 0 },
        { n: 2, title: '一、开头', chars: 90, level: 1 },
      ],
    });
    assert.deepEqual(entries.map(e => [e.section, e.depth]), [[1, 0], [2, 1]]);
    assert.equal(entries[0].key, 'n-1');
  });

  it('反向对照：`sections` 缺失时不抛异常、返回空数组', () => {
    assert.deepEqual(outlineEntries({ toc: [] }), []);
    assert.deepEqual(outlineEntries(null), []);
  });
});

describe('activeEntryIndex：当前页落在哪一条', () => {
  const entries = outlineEntries(INDEX);

  it('锚点正好落在这一页', () => {
    assert.equal(activeEntryIndex(entries, 8), 5);
  });

  it('页在两条锚点之间 ⇒ 取前一条（精确匹配会让高亮消失）', () => {
    // 第 5 页没有自己的锚点，它属于第 4 页起的那一条。
    assert.equal(activeEntryIndex(entries, 5), 3);
  });

  it('反向对照：这几种写法都会让高亮在绝大多数页上消失', () => {
    const naive = (page) => entries.findIndex(e => e.section === page);
    assert.equal(naive(5), -1, '`findIndex(section === page)` 在第 5 页找不到');
    assert.equal(activeEntryIndex(entries, 5), 3);
  });

  it('第 1 页之前没有锚点 ⇒ -1', () => {
    assert.equal(activeEntryIndex(entries, 0), -1);
  });
});

describe('runningHead：页眉只显示上级', () => {
  const entries = outlineEntries(INDEX);

  it('部 / 卷那一页自己不显示上级（正文第一行就是它的名字）', () => {
    assert.equal(runningHead(entries, 4, '第一部 在海上'), '');
    assert.equal(runningHead(entries, 7, '第二卷 克莱莫尔号军舰'), '');
  });

  it('小节页显示它所属的卷', () => {
    assert.equal(runningHead(entries, 8, '二、黑夜笼罩下的军舰和乘客'), '第二卷 克莱莫尔号军舰');
  });

  it('页在某一卷内部、自己没有锚点 ⇒ 那一卷就是最近的上级', () => {
    assert.equal(runningHead(entries, 5, '第一卷 索德罗克号'), '第一部 在海上');
  });

  it('反向对照：当页标题就是页眉那一句时不显示（否则同一句字出现两遍）', () => {
    // 书里「卷名 = 第一节名」的排法：页眉若是照抄当页标题，正文 `<h1>` 立刻重复一遍。
    // 这里用一条 depth 1 的条目故意与上一卷同名（正文侧常带脚注编号，所以还要过 squash）。
    const dup = outlineEntries({
      toc: [
        { title: '第一部 在海上', section: 4, depth: 0 },
        { title: '第一部，在海上〔26〕', section: 5, depth: 1 },
      ],
    });
    assert.equal(runningHead(dup, 5, '第一部，在海上〔26〕'), '');
    // 同一句字只要差标点 / 脚注编号，仍然认作同一句。
    assert.equal(runningHead(dup, 5, '第一部 在 海上'), '');
    // 反向对照：把标题换成另一句，页眉就该显示出来（证明上面不是恒为空）。
    assert.equal(runningHead(dup, 5, '一、沙丘顶上'), '第一部 在海上');
  });

  it('反向对照：照抄当页标题的实现在这些页上会重复', () => {
    const naive = (page, title) => title;             // 上一版页眉的做法
    assert.equal(naive(3, '译本序'), '译本序');
    assert.equal(runningHead(entries, 3, '译本序'), '');
  });

  it('没有目录的书：页眉不显示章节（书名仍由组件自己画）', () => {
    const flat = outlineEntries({ toc: [], sections: [{ n: 1, title: '第一章', chars: 10, level: 0 }] });
    assert.equal(runningHead(flat, 1, '第一章'), '');
    assert.equal(runningHead([], 1, '第一章'), '');
  });
});
