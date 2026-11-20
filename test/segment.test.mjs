/**
 * 分段算法的判据：四档降级、目录页识别、正文反查、页窗兜底。
 *
 * 这个文件存在的理由：分段错了**不会报错**。切错的唯一症状是用户点第 5 章跳到
 * 第 3 章，或者界面上出现一个叫「2025年11月」的章节。所以这里不抄实现，而是拿
 * **整本书的逐页行数组**喂进去，钉住「章节数 / 页码连续性 / 标题长什么样」，
 * 并给每类判据配反向对照。
 *
 * ★ 夹具是**合成的**（`scripts/gen-segment-fixtures.mjs` 生成，确定性，不含任何真实出版物
 *   的内容）。形态照着历次真机 dump 里遇到过的坑复刻 —— 只有形态重要，正文不参与
 *   任何断言：
 *     toc-3pages.json   98 页；目录占 p2–p4；40 章；第一章在 p5；目录页行尾无句读
 *     toc-radical.json  153 页；目录在 p2；首条用康熙部首「⾃」，正文用「自」；
 *                       目录里「附录」与「附录A」指向同一页
 *     outline.json      635 页；58 条书签，含扉页/目录/版权页噪音；首条在 p3
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SCANNED_RATIO, chaptersFromOutline, chaptersFromToc, chaptersFromWindows,
  normalizeTitle, segmentBook,
} from '../src/host/segment.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = name => JSON.parse(readFileSync(join(HERE, 'fixtures', 'segment', name), 'utf8'));

const tocA = fixture('toc-3pages.json');
const tocB = fixture('toc-radical.json');
const outline = fixture('outline.json');

/** 造一页「正文」：行撑满、以句号结尾。 */
function bodyPage(seed = '正文') {
  return Array.from({ length: 20 }, (_, i) => `${seed}第${i + 1}行，这一行写得比较长，用来模拟正文的排版宽度，末尾加句号。`);
}

/** 造一页「目录」：短行、无句读。 */
function tocPage(titles) {
  return ['目录', 'CONTENTS', ...titles];
}

describe('normalizeTitle：标题归一化', () => {
  it('★ 康熙部首要折叠成正常汉字', () => {
    // 实测：某些 PDF 字体映射会把「自」映射到 U+2F83（康熙部首），
    // 与目录页里的 U+81EA 不是同一个字符。不归一化 ⇒ 肉眼一样、比对失败、且无线索。
    assert.notEqual('⾃序', '自序');
    assert.equal(normalizeTitle('⾃序 关于这本书'), normalizeTitle('自序关于这本书'));
  });

  it('抹掉空白、点导引与全角差异', () => {
    assert.equal(normalizeTitle('第 1 章　起步……'), normalizeTitle('第1章起步'));
    assert.equal(normalizeTitle('ＡＢＣ'), 'abc');
  });

  it('反向对照：不同的标题不能被归一化成同一个', () => {
    assert.notEqual(normalizeTitle('第1章 起步'), normalizeTitle('第2章 起步'));
  });
});

describe('chaptersFromOutline：书签目录档', () => {
  it('真书 58 条书签切出连续的章节树', () => {
    const chapters = chaptersFromOutline(outline.outline, outline.pages);
    assert.ok(chapters.length > 40, `只切出 ${chapters.length} 章`);
    // 页码必须严格递增 —— 递增是 endPage 计算成立的前提。
    for (let i = 1; i < chapters.length; i += 1) {
      assert.ok(chapters[i].startPage > chapters[i - 1].startPage, `第 ${i} 章页码没有递增`);
    }
    assert.equal(chapters[0].startPage, 3);
    assert.equal(chapters.at(-1).endPage, outline.pages);
  });

  it('★ 扉页 / 目录 / 版权页这类骨架件要剔掉', () => {
    // 它们不是可读章节，留着会在生成解读时白烧一次模型调用。
    const chapters = chaptersFromOutline(outline.outline, outline.pages);
    const titles = chapters.map(c => c.title);
    assert.ok(!titles.some(t => /^(扉页|目录|版权页|版权信息)$/.test(t)), titles.slice(0, 8).join(' / '));
    // 反向对照：原文里确实有这些条目，证明「剔掉」不是因为它们不存在。
    assert.ok(outline.outline.some(item => item.title === '扉页'));
  });

  it('★ 越界页码的条目要丢弃，不能让它算出 endPage < startPage', () => {
    const chapters = chaptersFromOutline(
      [{ title: '第一章', page: 1 }, { title: '第二章', page: 5 }, { title: '幽灵章', page: 999 }],
      10,
    );
    assert.deepEqual(chapters.map(c => c.title), ['第一章', '第二章']);
    assert.equal(chapters.at(-1).endPage, 10);
  });

  it('条目不足 3 条时不算 outline 档（单条书签不是目录）', () => {
    assert.equal(chaptersFromOutline([{ title: '唯一', page: 1 }], 100).length, 1);
  });
});

describe('chaptersFromToc：目录页反查档', () => {
  it('目录占 p2–p4：反查出 30+ 章且页码连续', () => {
    const { chapters, tocPages } = chaptersFromToc(tocA.pages);
    assert.deepEqual(tocPages, [2, 3, 4]);
    assert.ok(chapters.length >= 30, `只切出 ${chapters.length} 章`);
    assert.equal(chapters[0].startPage, 5);
    for (let i = 1; i < chapters.length; i += 1) {
      assert.ok(chapters[i].startPage > chapters[i - 1].startPage, `第 ${i} 章页码没有递增`);
    }
  });

  it('目录里的 `⾃序`（康熙部首）能反查到正文里的「自序」', () => {
    const { chapters } = chaptersFromToc(tocB.pages);
    const first = chapters[0];
    assert.equal(first.startPage, 4);
    assert.ok(first.title.includes('序'), first.title);
    assert.ok(chapters.length >= 20, `只切出 ${chapters.length} 章`);
  });

  it('★ 同一页的多个条目只留最长的（「附录」与「附录A」撞页会倒挂）', () => {
    // 实测：留着短的会得到 `p140-139`，界面上是倒挂区间。
    const { chapters } = chaptersFromToc(tocB.pages);
    for (const chapter of chapters) {
      assert.ok(chapter.endPage >= chapter.startPage, `${chapter.title} 区间倒挂 ${chapter.startPage}-${chapter.endPage}`);
    }
    // 反向对照：目录里确实同时有「附录」和「附录A」。
    const titles = chapters.map(c => c.title);
    assert.ok(titles.some(t => t.startsWith('附录A')), titles.filter(t => t.startsWith('附录')).join(' / '));
  });

  it('★ 正文页不能被误判成目录页（判据是行尾标点，不是字符数）', () => {
    // 反向对照：把目录页的「无句读」特征破坏掉，就应当认不出目录。
    const broken = tocA.pages.map((lines, index) => (
      index < 6 ? lines.map(line => `${line}。`) : lines
    ));
    const { tocPages } = chaptersFromToc(broken);
    assert.deepEqual(tocPages, []);
  });

  it('★ 代码页/表格页不能被当成目录页（行尾无句读 ≠ 目录）', () => {
    // 这是「行均长上限」这条判据的守门人。实测某本手册的表格页：noPunct 也是 1.00
    // —— 只看行尾标点，任何表格页都会被认成目录页。
    // 真正把正文页挡在外面的是**行是撑满的**（代码行 40+ 字/行）。
    const codePage = [
      '目录结构说明',
      // ★ 行尾刻意**不带**分号：`;` 在句读字符类里，带上它这页的 noPunct 就不是 1，
      //   测试根本走不到「行均长」那条判据 —— 那样这条断言就是假的（变异测试抓到的）。
      ...Array.from({ length: 15 }, () => 'const config = { provider: "openai", model: "gpt-4", timeout: 30000 }'),
    ];
    const pages = [['封面'], ...Array.from({ length: 3 }, () => bodyPage()), codePage, ...Array.from({ length: 20 }, () => bodyPage())];
    const { tocPages } = chaptersFromToc(pages);
    assert.ok(!tocPages.includes(5), `代码页被当成目录页：${tocPages.join(',')}`);
  });

  it('没有目录页的书返回空章节，而不是编出一批假章', () => {
    const pages = Array.from({ length: 30 }, () => bodyPage());
    const { chapters, tocPages } = chaptersFromToc(pages);
    assert.deepEqual(tocPages, []);
    assert.deepEqual(chapters, []);
  });
});

describe('chaptersFromWindows：页窗兜底档', () => {
  it('★ 标题必须写成「第 X–Y 页」，不许伪装成章名', () => {
    const chapters = chaptersFromWindows(45);
    assert.deepEqual(chapters.map(c => c.title), ['第 1–20 页', '第 21–40 页', '第 41–45 页']);
    assert.deepEqual(chapters.map(c => [c.startPage, c.endPage]), [[1, 20], [21, 40], [41, 45]]);
  });

  it('反向对照：页窗标题里不出现「章」字', () => {
    for (const chapter of chaptersFromWindows(100)) {
      assert.ok(!/章/.test(chapter.title), chapter.title);
    }
  });
});

describe('segmentBook：四档降级与扫描版判定', () => {
  it('有书签 ⇒ 走 outline，且优先级高于目录页', () => {
    const result = segmentBook({ pages: [], outline: outline.outline, pageCount: outline.pages });
    assert.equal(result.mode, 'outline');
    assert.ok(result.chapters.length > 40);
  });

  it('有目录页、无书签 ⇒ 走 toc', () => {
    const result = segmentBook({ pages: tocA.pages, outline: [], pageCount: tocA.pages.length });
    assert.equal(result.mode, 'toc');
    assert.equal(result.stats.tocPages.join(','), '2,3,4');
  });

  it('★ 扫描版必须直接判 scanned，不许降级到页窗', () => {
    // 实测 32 本本机 PDF 里 9 本（28%）是扫描版。若这里降级成页窗，
    // 用户会看到一本「有 19 章」的书，然后每一章生成都失败。
    const pages = Array.from({ length: 40 }, () => []);
    const result = segmentBook({ pages, outline: [], pageCount: 40 });
    assert.equal(result.mode, 'scanned');
    assert.deepEqual(result.chapters, []);
    assert.equal(result.stats.textRatio, 0);
  });

  it('★ 扫描版判据的边界：刚好超过阈值就走正常流程', () => {
    const total = 20;
    const textCount = Math.ceil(total * SCANNED_RATIO) + 1;
    const pages = Array.from({ length: total }, (_, i) => (i < textCount ? bodyPage() : []));
    const result = segmentBook({ pages, outline: [], pageCount: total });
    assert.notEqual(result.mode, 'scanned');
  });

  it('无目录页的短文档 ⇒ 页窗兜底', () => {
    const pages = Array.from({ length: 12 }, () => bodyPage());
    const result = segmentBook({ pages, outline: [], pageCount: 12 });
    assert.equal(result.mode, 'window');
    assert.equal(result.chapters[0].title, '第 1–12 页');
  });

  it('★ 章节序号必须从 1 连续编到 n（界面和工具调用靠它定位）', () => {
    // ★ 必须覆盖**每一档**。之前只测了 toc，outline 档漏了编号 ⇒ 章节文件名变成
    //   `chundefined.txt`，而所有断言全绿（2026-10-23 端到端跑真书才抓到）。
    const cases = [
      ['toc', { pages: tocA.pages, outline: [], pageCount: tocA.pages.length }],
      ['toc', { pages: tocB.pages, outline: [], pageCount: tocB.pages.length }],
      ['outline', { pages: [], outline: outline.outline, pageCount: outline.pages }],
    ];
    for (const [label, input] of cases) {
      const result = segmentBook(input);
      assert.equal(result.mode, label);
      assert.deepEqual(
        result.chapters.map(c => c.n),
        result.chapters.map((_, i) => i + 1),
        `${label} 档的序号不连续`,
      );
    }
  });

  it('★ 每一档的章节都必须有可用的 n（它是章节文件名的来源）', () => {
    const windows = segmentBook({ pages: Array.from({ length: 12 }, () => bodyPage()), pageCount: 12 });
    assert.equal(windows.mode, 'window');
    for (const chapter of windows.chapters) {
      assert.ok(Number.isInteger(chapter.n) && chapter.n >= 1, `window 档的 n 是 ${chapter.n}`);
    }
  });

  it('★ 只占一页、两个字的分组标题页要标成 section（不是可读的一章）', () => {
    // 实测：一本 838 页的书有 19 条书签，第一条「上册」只占 p6 一页、正文两个字。
    // 不标出来 ⇒ 界面上出现「上册 p.6–6 2字」，点进去是一页白纸，
    // 而且 P2 会为它白烧一次模型调用。
    const pages = [
      ['封面'],
      ['上册'],            // p2：卷标题页，只有两个字
      ['第一章 起', ...Array.from({ length: 10 }, () => '正文写得比较长，用来模拟排版宽度，末尾加句号。')],
      ['第二章 承', ...Array.from({ length: 10 }, () => '正文写得比较长，用来模拟排版宽度，末尾加句号。')],
      ['第三章 转', ...Array.from({ length: 10 }, () => '正文写得比较长，用来模拟排版宽度，末尾加句号。')],
    ];
    const result = segmentBook({
      pages,
      outline: [
        { title: '上册', page: 2 },
        { title: '第一章 起', page: 3 },
        { title: '第二章 承', page: 4 },
        { title: '第三章 转', page: 5 },
      ],
      pageCount: 5,
    });
    assert.equal(result.mode, 'outline');
    assert.equal(result.chapters[0].section, true, '「上册」没有被标成 section');
    // 反向对照：正常章节不能被误标。
    assert.ok(!result.chapters.slice(1).some(c => c.section === true), '正常章节被误标成 section');
  });

  it('★ 没有正文时不能凭页码猜 section（宁可漏标）', () => {
    const result = segmentBook({ pages: [], outline: outline.outline, pageCount: outline.pages });
    assert.equal(result.mode, 'outline');
    assert.ok(!result.chapters.some(c => c.section === true), '没有正文却标了 section');
  });
});
