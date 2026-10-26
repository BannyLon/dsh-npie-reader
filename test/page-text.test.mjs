/**
 * 页文本的「从哪来」：文字层优先，扫描页用识别文本（`overlayOcrPages`）。
 *
 * ★ 这一层坏掉的样子是**静默的**：分段不会报错，只会切错章节。典型两例：
 *   · 扫描页没被顶上 ⇒ `textRatio` 仍然是 0 ⇒ 整本还是「扫描版」，而用户明明
 *     已经认了一小时的字（0.27.1 之前就是这个状态：OCR 只喂了搜索，没喂分段）。
 *   · 有文字层的页被 OCR 覆盖 ⇒ 每个字都可能带上形近字错误，而上下文读起来
 *     仍然通顺 —— 读者永远不知道手上这一段不该逐字引用。
 * 所以这里每组都配**反向对照**：改一处应该只影响那一处。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TEXT_PAGE_MIN_CHARS, overlayOcrPages } from '../src/host/page-text.js';

/** 一页「真的正文」：超过阈值、且带句号（形如正文，不像目录条目）。 */
const body = (title) => [title, ...Array.from({ length: 6 }, () => '这一行是正文，长度足够算作有文字的一页，末尾有句号。')];

describe('overlayOcrPages：扫描页用识别文本顶上', () => {
  it('空页 + 有识别文本 ⇒ 用识别文本，且报告用过的那一页', () => {
    const ocr = '第一章 起步\n正文第一行，这一行足够长，算作有文字的一页。\n正文第二行，同样足够长，末尾有句号。';
    const { pages, used } = overlayOcrPages(
      [{ page: 1, lines: [] }, { page: 2, lines: body('第一章 起步') }],
      { 1: ocr },
    );
    assert.deepEqual(pages[0].lines, ocr.split('\n'));
    assert.deepEqual(used, [1]);
  });

  it('★ 有文字层的页**不许**被识别文本覆盖（OCR 一定有错字）', () => {
    const own = body('第二章 进阶');
    const { pages, used } = overlayOcrPages([{ page: 5, lines: own }], { 5: '第二章 进阶（认错的字）\n别的字'.repeat(3) });
    assert.deepEqual(pages[0].lines, own);
    assert.deepEqual(used, []);
  });

  it('★ 只有页眉页脚几个字的页：让识别文本顶上（文字层「有字」但没有正文）', () => {
    // 30 字 < 阈值 ⇒ 这一页在分段眼里本来就不算正文页；OCR 那份才是正文。
    const { pages, used } = overlayOcrPages(
      [{ page: 7, lines: ['第三章', '人民文学出版社'] }],
      { 7: body('第三章 实战').join('\n') },
    );
    assert.equal(pages[0].lines[0], '第三章 实战');
    assert.deepEqual(used, [7]);
  });

  it('识别文本太短（只认出页码）⇒ 不当成正文，页保持原样', () => {
    const { pages, used } = overlayOcrPages([{ page: 3, lines: [] }], { 3: '128' });
    assert.deepEqual(pages[0].lines, []);
    assert.deepEqual(used, []);
  });

  it('★ 阈值与分段是同一个数（各写一份会出现「分段说有字、叠加说没有」）', () => {
    const exactly = '字'.repeat(TEXT_PAGE_MIN_CHARS);
    const over = '字'.repeat(TEXT_PAGE_MIN_CHARS + 1);
    assert.deepEqual(overlayOcrPages([{ page: 1, lines: [] }], { 1: exactly }).used, [], '等于阈值不该顶');
    assert.deepEqual(overlayOcrPages([{ page: 1, lines: [] }], { 1: over }).used, [1], '超过阈值要顶');
  });
});

describe('overlayOcrPages：边角情形不许编数据', () => {
  it('识别文本里有、抽取里没有的页 ⇒ 忽略（不能凭空多出一页，endPage 会落到不存在的位置）', () => {
    const { pages, used } = overlayOcrPages([{ page: 1, lines: [] }], { 1: body('A').join('\n'), 99: body('B').join('\n') });
    assert.equal(pages.length, 1);
    assert.deepEqual(used, [1]);
  });

  it('坏入参不炸：pages 不是数组 / ocrPages 是 null 或数组', () => {
    assert.deepEqual(overlayOcrPages(undefined, undefined).pages, []);
    assert.deepEqual(overlayOcrPages(null, null).used, []);
    const pages = [{ page: 1, lines: [] }];
    assert.deepEqual(overlayOcrPages(pages, null).used, []);
    assert.deepEqual(overlayOcrPages(pages, [1, 2]).used, []);
  });

  it('识别文本里的空行保留成空串 —— 行数就是排版，别替它整理', () => {
    const text = `第一章 起步\n\n${'正文。'.repeat(30)}`;
    const { pages } = overlayOcrPages([{ page: 2, lines: [] }], { 2: text });
    assert.equal(pages[0].lines[1], '');
    assert.equal(pages[0].lines.length, 3);
  });

  it('★ 反向对照：同一份输入原样返回结构（不修改入参对象）', () => {
    const input = [{ page: 1, lines: [] }];
    const ocr = { 1: body('X').join('\n') };
    const { pages } = overlayOcrPages(input, ocr);
    assert.deepEqual(input[0].lines, [], '入参被就地改了');
    assert.notEqual(pages[0], input[0]);
    assert.equal(ocr[1], body('X').join('\n'));
  });
});
