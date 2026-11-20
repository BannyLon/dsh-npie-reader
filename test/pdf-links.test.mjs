/**
 * 页内链接层（`src/client/pdf-links.js`）。
 *
 * 这一层的作用是让 PDF 里的链接真的能点：外链开浏览器、内部目的地跳页。
 * 它同时是**安全边界** —— PDF 里的 URL 是文档作者写的内容，不是我们生成的。
 * 所以这里的用例大多是「xx 必须被拦下」而不是「xx 能用」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_LINKS_PER_PAGE, isLinkAnnotation, linkBoxesOf, resolveDestPage, safeLinkUrl,
} from '../src/client/pdf-links.js';

/** 一个只会平移/翻转 y 的假视口：够验坐标归一，不需要真的 pdf.js。 */
function fakeViewport({ height = 100 } = {}) {
  return {
    // pdf.js 返回的是 [x0, y0, x1, y1]，左下原点 ⇒ 这里按 `height - y` 翻到左上原点。
    convertToViewportRectangle: rect => [
      rect[0], height - rect[3], rect[2], height - rect[1],
    ],
  };
}

describe('safeLinkUrl：只放过 http / https / mailto', () => {
  it('正常外链原样返回（绝对化）', () => {
    assert.equal(safeLinkUrl('https://arxiv.org/abs/1706.03762'), 'https://arxiv.org/abs/1706.03762');
    assert.equal(safeLinkUrl('  http://example.com/x  '), 'http://example.com/x');
    assert.equal(safeLinkUrl('mailto:a@b.com'), 'mailto:a@b.com');
  });

  it('★ javascript: 一律拦下（PDF 里放脚本是真实攻击面）', () => {
    assert.equal(safeLinkUrl('javascript:alert(1)'), '');
    assert.equal(safeLinkUrl('JavaScript:alert(1)'), '');
    // 大小写 + 前导空白 + 内嵌制表符，都是常见的绕过写法
    assert.equal(safeLinkUrl('  JAVASCRIPT:alert(1)'), '');
    assert.equal(safeLinkUrl('java\tscript:alert(1)'), '');
    assert.equal(safeLinkUrl('java\nscript:alert(1)'), '');
  });

  it('file: / data: / 自定义协议一律拦下', () => {
    assert.equal(safeLinkUrl('file:///etc/passwd'), '');
    assert.equal(safeLinkUrl('data:text/html,<script>x</script>'), '');
    assert.equal(safeLinkUrl('dsh-app://app/index.html'), '');
  });

  it('相对地址丢掉：PDF 没有「当前页面 URL」，拼出来的只会是个假站', () => {
    assert.equal(safeLinkUrl('./chapter2.html'), '');
    assert.equal(safeLinkUrl('/abs/path'), '');
  });

  it('空值 / 非字符串都能安全退化', () => {
    assert.equal(safeLinkUrl(''), '');
    assert.equal(safeLinkUrl(undefined), '');
    assert.equal(safeLinkUrl(null), '');
    assert.equal(safeLinkUrl(42), '');
  });
});

describe('isLinkAnnotation', () => {
  it('只认 subtype=Link 且 rect 是四个有限数', () => {
    assert.equal(isLinkAnnotation({ subtype: 'Link', rect: [0, 0, 10, 10] }), true);
    assert.equal(isLinkAnnotation({ subtype: 'Link', rect: ['0', '0', '10', '10'] }), true);
    assert.equal(isLinkAnnotation({ subtype: 'Widget', rect: [0, 0, 10, 10] }), false);
    assert.equal(isLinkAnnotation({ subtype: 'Link', rect: [0, 0, 10] }), false);
    assert.equal(isLinkAnnotation({ subtype: 'Link', rect: [0, 0, 10, 'x'] }), false);
    assert.equal(isLinkAnnotation({ subtype: 'Link' }), false);
    assert.equal(isLinkAnnotation(null), false);
  });
});

describe('linkBoxesOf：PDF 坐标 → 视口 CSS 像素', () => {
  it('y 轴翻转后取左上原点，矩形归一成长宽', () => {
    const boxes = linkBoxesOf([
      { subtype: 'Link', rect: [10, 20, 60, 34], url: 'https://example.com/a' },
    ], fakeViewport({ height: 100 }));
    assert.equal(boxes.length, 1);
    // top = 100 - 34 = 66，height = 34 - 20 = 14
    assert.deepEqual(
      { left: boxes[0].left, top: boxes[0].top, width: boxes[0].width, height: boxes[0].height },
      { left: 10, top: 66, width: 50, height: 14 },
    );
  });

  it('★ 翻转过的轴（大到小）也能归一，不出现负宽高', () => {
    const viewport = { convertToViewportRectangle: () => [60, 34, 10, 20] };
    const boxes = linkBoxesOf([{ subtype: 'Link', rect: [10, 20, 60, 34], url: 'https://example.com' }], viewport);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].width, 50);
    assert.equal(boxes[0].height, 14);
    assert.equal(boxes[0].top, 20);
  });

  it('既没有 url 也没有 dest 的 Link 不渲染（点了什么都不会发生的热区只会挡文字）', () => {
    assert.deepEqual(linkBoxesOf([{ subtype: 'Link', rect: [0, 0, 10, 10] }], fakeViewport()), []);
  });

  it('只有 dest 的链接保留 dest 原样透传', () => {
    const dest = [{ num: 7, gen: 0 }, { name: 'XYZ' }, 0, 0, 0];
    const boxes = linkBoxesOf([{ subtype: 'Link', rect: [0, 0, 10, 10], dest }], fakeViewport());
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].url, '');
    assert.equal(boxes[0].dest, dest);
  });

  it('★ 危险协议的 Link 在坐标换算之后仍然被丢掉', () => {
    const boxes = linkBoxesOf([
      { subtype: 'Link', rect: [0, 0, 10, 10], url: 'javascript:alert(1)' },
      { subtype: 'Link', rect: [0, 0, 10, 10], url: 'https://ok.example' },
    ], fakeViewport());
    assert.equal(boxes.length, 1);
    // `new URL()` 会把裸主机规范化成带尾斜杠的形式，这是它该做的事。
    assert.equal(boxes[0].url, 'https://ok.example/');
  });

  it('亚像素 / 零尺寸热区不渲染（点不到的东西不该占位置）', () => {
    assert.deepEqual(linkBoxesOf([
      { subtype: 'Link', rect: [10, 20, 10.4, 34], url: 'https://example.com' },
      { subtype: 'Link', rect: [10, 20, 60, 20.5], url: 'https://example.com' },
    ], fakeViewport()), []);
  });

  it('一页的注解超过上限就截断（畸形 PDF 挡在渲染前）', () => {
    const many = Array.from({ length: MAX_LINKS_PER_PAGE + 40 }, (_, index) => ({
      subtype: 'Link', rect: [0, 0, 10, 10], url: `https://example.com/${index}`,
    }));
    assert.equal(linkBoxesOf(many, fakeViewport()).length, MAX_LINKS_PER_PAGE);
  });

  it('入参不是数组 / 视口不可用时退化成空数组，不抛', () => {
    assert.deepEqual(linkBoxesOf(null, fakeViewport()), []);
    assert.deepEqual(linkBoxesOf([], null), []);
    assert.deepEqual(linkBoxesOf([{ subtype: 'Link', rect: [0, 0, 10, 10], url: 'https://a.b' }], {}), []);
  });
});

describe('resolveDestPage：内部目的地 → 页码（1 起）', () => {
  const doc = {
    getPageIndex: async (ref) => {
      if (ref?.num === 7) return 8; // 0 起 ⇒ 第 9 页
      throw new Error('unknown ref');
    },
    getDestination: async (name) => (name === 'chap1' ? [{ num: 7, gen: 0 }, { name: 'XYZ' }, 0, 0, 0] : null),
  };

  it('命名目的地先解析名字，再取页号', async () => {
    assert.equal(await resolveDestPage(doc, 'chap1'), 9);
  });

  it('直接给 ref 也能解析', async () => {
    assert.equal(await resolveDestPage(doc, [{ num: 7, gen: 0 }, { name: 'Fit' }]), 9);
  });

  it('第一位已经是 0 起页码时 +1', async () => {
    assert.equal(await resolveDestPage(doc, [4, { name: 'XYZ' }, 0, 0, 0]), 5);
  });

  it('★ 解析不出来返 0，不猜 1 —— 跳到第一页比什么都不做更让人困惑', async () => {
    assert.equal(await resolveDestPage(doc, 'nope'), 0);
    assert.equal(await resolveDestPage(doc, [{ num: 99, gen: 0 }]), 0);
    assert.equal(await resolveDestPage(doc, []), 0);
    assert.equal(await resolveDestPage(doc, null), 0);
    assert.equal(await resolveDestPage(null, 'chap1'), 0);
  });

  it('命名目的地命中缓存后不再问文档', async () => {
    const cache = new Map();
    let calls = 0;
    const counting = {
      ...doc,
      getDestination: async (name) => { calls += 1; return doc.getDestination(name); },
    };
    assert.equal(await resolveDestPage(counting, 'chap1', cache), 9);
    assert.equal(await resolveDestPage(counting, 'chap1', cache), 9);
    assert.equal(calls, 1);
  });
});
