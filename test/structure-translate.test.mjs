import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectSegments, buildTranslatePrompt, parseTranslateReply,
  applyTranslations, translationCoverage,
} from '../src/host/structure-translate.js';

/** 一段带行内标记的真形状正文：链接 + 加粗 + 图片 + 代码。 */
const page = [
  '<article class="post">',
  '<h1>Gemini 4 Argon is here</h1>',
  '<p>It focuses on inputs that cause <strong>expensive errors</strong>: accents, noise.</p>',
  '<p>Read <a href="https://example.com/a">the full guide</a> for details.</p>',
  '<figure><img src="https://example.com/x.png" width="640" height="360" alt="shot">',
  '<figcaption>Argon on stage</figcaption></figure>',
  '<pre><code>const a = 1;</code></pre>',
  '<ul><li>First point</li><li>Second point</li></ul>',
  '</article>',
].join('');

const countTags = (html) => (html.match(/<\/?[a-zA-Z][a-zA-Z0-9-]*/g) || []).length;
const countLinks = (html) => (html.match(/<a\s[^>]*href\s*=/gi) || []).length;
const countImgs = (html) => (html.match(/<img\s/gi) || []).length;

describe('collectSegments', () => {
  it('picks up text nodes and leaves markup alone', () => {
    const segments = collectSegments(page);
    const texts = segments.map((s) => s.text);
    assert.ok(texts.includes('Gemini 4 Argon is here'));
    assert.ok(texts.includes('It focuses on inputs that cause'));
    assert.ok(texts.includes('expensive errors'));
    assert.ok(texts.includes(': accents, noise.'));
    assert.ok(texts.includes('the full guide'));
    assert.ok(texts.includes('Argon on stage'));
    assert.ok(texts.includes('First point'));
  });

  it('never hands code to the model', () => {
    const texts = collectSegments(page).map((s) => s.text);
    assert.ok(!texts.some((t) => t.includes('const a')));
    assert.equal(collectSegments('<pre><code>let x = 1;</code></pre>').length, 0);
    assert.equal(collectSegments('<p>ok <code>inline()</code> tail</p>').filter((s) => s.text.includes('inline')).length, 0);
  });

  it('skips blank and punctuation-only nodes', () => {
    assert.equal(collectSegments('<p>   </p>').length, 0);
    assert.equal(collectSegments('<p>\u200b</p>').length, 0);
    assert.equal(collectSegments('<p>|</p>').length, 0);
    assert.equal(collectSegments('<p>·—→</p>').length, 0);
  });

  it('groups text nodes that belong to the same paragraph', () => {
    const segments = collectSegments('<p>Hello <strong>world</strong>!</p>');
    // 尾随的 "!" 是纯标点、按设计不进清单（见下一条用例），所以这里是 2 条不是 3 条。
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map((s) => s.text), ['Hello', 'world']);
    assert.equal(new Set(segments.map((s) => s.group)).size, 1);
    const two = collectSegments('<p>a</p><p>b</p>');
    assert.equal(new Set(two.map((s) => s.group)).size, 2);
  });

  it('keeps surrounding whitespace while swapping only the core text', () => {
    const html = '<p>Hello <strong>world</strong>!</p>';
    const segments = collectSegments(html);
    const out = applyTranslations(html, segments, new Map(segments.map((s) => [s.id, 'X'])));
    // 「Hello 」与 <strong> 之间那个空格**没被替换**（它不在任何 core 范围里），
    // 所以活了下来；尾随的「!」是纯标点、没进清单，也留在原地 ——
    // 刻意不去猜它的全角形式，猜错比不换更糟。
    assert.equal(out, '<p>X <strong>X</strong>!</p>');
  });

  it('numbers segments consecutively starting at one', () => {
    const segments = collectSegments(page);
    assert.ok(segments.length > 5);
    assert.deepEqual(segments.map((s) => s.id), segments.map((_, i) => i + 1));
  });

  it('returns an empty list for empty or non-markup input', () => {
    assert.deepEqual(collectSegments(''), []);
    assert.deepEqual(collectSegments(null), []);
    assert.deepEqual(collectSegments(undefined), []);
  });
});

describe('buildTranslatePrompt', () => {
  it('writes one bracketed line per segment and a blank line between paragraphs', () => {
    const prompt = buildTranslatePrompt(collectSegments('<p>a</p><p>b</p>'));
    assert.equal(prompt, '[1] a\n\n[2] b');
  });

  it('keeps same-paragraph segments on consecutive lines without a blank line', () => {
    const prompt = buildTranslatePrompt(collectSegments('<p>a <em>b</em></p>'));
    assert.equal(prompt, '[1] a\n[2] b');
  });

  it('never emits an invisible separator', () => {
    const prompt = buildTranslatePrompt(collectSegments(page));
    assert.ok(!prompt.includes('\u0001'));
    assert.ok(!prompt.includes('\u0002'));
  });
});

describe('parseTranslateReply', () => {
  it('reads the standard numbered form', () => {
    const map = parseTranslateReply('[1] 你好\n[2] 世界');
    assert.equal(map.get(1), '你好');
    assert.equal(map.get(2), '世界');
  });

  it('accepts full-width brackets and stray spaces', () => {
    assert.equal(parseTranslateReply('［1］你好').get(1), '你好');
    assert.equal(parseTranslateReply('[ 1 ] 你好').get(1), '你好');
  });

  it('keeps a multi-line translation attached to its number', () => {
    const map = parseTranslateReply('[1] 第一行\n第二行\n[2] x');
    assert.equal(map.get(1), '第一行\n第二行');
    assert.equal(map.get(2), 'x');
  });

  it('does not invent the segments the model skipped', () => {
    const map = parseTranslateReply('[1] a');
    assert.equal(map.size, 1);
    assert.equal(map.has(2), false);
  });

  it('returns an empty map when there are no numbers at all', () => {
    assert.equal(parseTranslateReply('完全忘了写编号').size, 0);
    assert.equal(parseTranslateReply('').size, 0);
    assert.equal(parseTranslateReply(null).size, 0);
  });

  it('aligns by number even when the model reorders them', () => {
    const map = parseTranslateReply('[2] 先\n[1] 后');
    assert.equal(map.get(2), '先');
    assert.equal(map.get(1), '后');
  });

  it('ignores blank lines and duplicate numbers', () => {
    const map = parseTranslateReply('[1] a\n\n[2] b\n[1] 重复的');
    assert.equal(map.get(1), 'a');
    assert.equal(map.get(2), 'b');
  });
});

describe('applyTranslations', () => {
  const segments = collectSegments(page);
  const fake = new Map(segments.map((s) => [s.id, `【${s.text}】`]));

  it('★ leaves every tag, link and image untouched', () => {
    const out = applyTranslations(page, segments, fake);
    assert.equal(countTags(out), countTags(page));
    assert.equal(countLinks(out), countLinks(page));
    assert.equal(countImgs(out), countImgs(page));
    assert.equal(out.includes('width="640"'), true);
    assert.equal(out.includes('class="post"'), true);
  });

  it('actually replaces the words', () => {
    const out = applyTranslations(page, segments, fake);
    assert.ok(out.includes('【Gemini 4 Argon is here】'));
    assert.ok(!out.includes('>Gemini 4 Argon is here<'));
  });

  it('escapes markup that arrives inside a translation', () => {
    const evil = new Map(fake);
    evil.set(segments[0].id, '<script>alert(1)</script>');
    const out = applyTranslations(page, segments, evil);
    assert.ok(!out.includes('<script>alert(1)</script>'));
    assert.ok(out.includes('&lt;script&gt;'));
    assert.equal(countTags(out), countTags(page));
  });

  it('keeps the original words when a translation is empty', () => {
    const target = segments.find((s) => s.text === 'expensive errors');
    const partial = new Map(fake);
    partial.set(target.id, '   ');
    const out = applyTranslations(page, segments, partial);
    assert.ok(out.includes('expensive errors'));
  });

  it('keeps the original words for segments the model never answered', () => {
    const out = applyTranslations(page, segments, new Map([[segments[0].id, '只翻了一条']]));
    assert.ok(out.includes('expensive errors'));
    assert.ok(out.includes('the full guide'));
    assert.equal(countTags(out), countTags(page));
  });

  it('applies edits back to front so offsets do not drift', () => {
    const html = '<p>alpha</p><p>beta</p><p>gamma</p>';
    const list = collectSegments(html);
    const map = new Map(list.map((s) => [s.id, `【${s.text}】`]));
    assert.equal(applyTranslations(html, list, map), '<p>【alpha】</p><p>【beta】</p><p>【gamma】</p>');
  });

  it('returns the source untouched for degenerate arguments', () => {
    assert.equal(applyTranslations(page, [], new Map()), page);
    assert.equal(applyTranslations(page, segments, new Map()), page);
    assert.equal(applyTranslations('', segments, fake), '');
    assert.equal(applyTranslations(page, segments, null), page);
  });
});

describe('translationCoverage', () => {
  it('reports the honest ratio so a partial run is never called a success', () => {
    const list = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const map = new Map([[1, 'a'], [2, 'b']]);
    assert.deepEqual(translationCoverage(list, map), { total: 4, done: 2, ratio: 0.5 });
  });

  it('counts blank answers as not done', () => {
    assert.equal(translationCoverage([{ id: 1 }], new Map([[1, '  ']])).done, 0);
  });

  it('treats an empty page as fully covered', () => {
    assert.deepEqual(translationCoverage([], new Map()), { total: 0, done: 0, ratio: 1 });
  });
});
