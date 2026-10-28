/**
 * 封面取值（浏览器半区）的单元测试。
 *
 * ★ 这一层是纯函数，跑在 node 里：色相、首字、截断、来源判定。**渲染**的部分
 *   （PDF 首页画到 canvas）不在这一层测 —— 它需要真 Chrome，验在
 *   `.build/preview/measure-shelf.mjs` 与真图上。
 * ★ 判据都挑「错了会静默」的：色相不稳定 ⇒ 每次刷新换一套颜色；
 *   首字没剥书名号 ⇒ 每本书显示《；后缀没大写 ⇒ 胶囊里是 `epub` 而不是 `EPUB`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coverCaption, coverGlyph, coverHue, coverKind, epubCoverUrl, formatExt, pdfCoverDataUrl, forgetCovers,
} from '../src/client/book-cover.js';

test('生成式封面的色相稳定，且落在 12 档布面色里', () => {
  const hue = coverHue('九三年');
  assert.equal(hue, coverHue('九三年'), '同一个书名两次算出不同色相（刷新一次换一套颜色）');
  assert.notEqual(hue, coverHue('深度工作'), '两本不同的书撞到同一个色相（侧栏会糊成一片）');
  for (const title of ['九三年', '深度工作', '', '《译文名著文库》 076[法]雨果-九三年（叶尊译，上']) {
    const value = coverHue(title);
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 359, `色相不是 0..359：${value}（hsl 会整条失效）`);
  }
});

test('首字剥掉书名号与标点，剥空了再退回', () => {
  assert.equal(coverGlyph('《九三年》'), '九', '书名号没剥掉 —— 封面上会显示一个「《」');
  assert.equal(coverGlyph('（英）乔治·奥威尔 1984'), '乔');
  assert.equal(coverGlyph('  深度工作  '), '深');
  assert.equal(coverGlyph('---'), '-', '整串都是标点时应该退回原串首字');
  assert.equal(coverGlyph(''), '?', '空书名应该给一个可见字符，而不是空白封面');
});

test('封面小字去掉书名号并截断', () => {
  assert.equal(coverCaption('《九三年》'), '九三年');
  assert.equal(coverCaption('九三年'), '九三年');
  const long = coverCaption('《译文名著文库》 076[法]雨果-九三年（叶尊译，上）', 6);
  assert.equal(Array.from(long).length, 7, `截断长度不对：${long}`);
  assert.ok(long.endsWith('…'), '截断没有省略号 —— 看起来像书名就到这里');
  assert.equal(coverCaption(''), '');
});

test('封面来源的判定：只有 epub / pdf 有真封面', () => {
  assert.equal(coverKind({ ext: 'epub' }), 'epub');
  assert.equal(coverKind({ ext: 'PDF' }), 'pdf', '大写后缀没被识别（书单里两本书都是 `PDF`）');
  for (const ext of ['mobi', 'azw3', 'txt', 'docx', '']) {
    assert.equal(coverKind({ ext }), 'made', `${ext} 被当成了有真封面 —— 它没有`);
  }
});

test('宿主封面 URL 把 id 编码掉', () => {
  assert.equal(epubCoverUrl('abc'), '/api/dsh-npie-reader/library/cover/abc');
  assert.ok(epubCoverUrl('a/b c').endsWith('a%2Fb%20c'), 'id 没有编码 —— 带斜杠的 id 会打到别的路由');
});

test('格式胶囊是大写；空值给空串而不是空胶囊', () => {
  assert.equal(formatExt('epub'), 'EPUB');
  assert.equal(formatExt(' pdf '), 'PDF');
  assert.equal(formatExt(''), '');
  assert.equal(formatExt(undefined), '');
});

test('PDF 封面没有体积信息时抛错，而不是画一张空图', () => {
  forgetCovers();
  assert.rejects(() => pdfCoverDataUrl({ id: 'x' }), /体积/, '没有 size 时应该明确报错');
  assert.rejects(() => pdfCoverDataUrl({ id: '', size: 10 }), /体积/, '没有 id 时应该明确报错');
});
