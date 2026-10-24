import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markdownToHtml } from '../src/host/markdown.js';

describe('markdownToHtml', () => {
  it('renders headings and paragraphs', () => {
    assert.equal(markdownToHtml('# Title'), '<h1>Title</h1>');
    assert.equal(markdownToHtml('### Deep'), '<h3>Deep</h3>');
    assert.equal(markdownToHtml('plain text'), '<p>plain text</p>');
    assert.equal(markdownToHtml('---'), '<hr>');
  });

  it('renders inline emphasis and code', () => {
    assert.equal(markdownToHtml('**bold**'), '<p><strong>bold</strong></p>');
    assert.equal(markdownToHtml('*em*'), '<p><em>em</em></p>');
    assert.equal(markdownToHtml('~~gone~~'), '<p><del>gone</del></p>');
    assert.equal(markdownToHtml('use `x = 1` here'), '<p>use <code>x = 1</code> here</p>');
  });

  it('joins soft-wrapped source lines and splits on blank lines', () => {
    assert.equal(markdownToHtml('one\ntwo'), '<p>one two</p>');
    assert.equal(markdownToHtml('one\n\ntwo'), '<p>one</p>\n<p>two</p>');
    assert.equal(markdownToHtml('one\r\ntwo'), '<p>one two</p>', 'CRLF is normalized');
  });

  it('renders lists, switching type when the marker changes', () => {
    assert.equal(markdownToHtml('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    assert.equal(markdownToHtml('1. a\n2. b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    assert.equal(markdownToHtml('1. a\n- b'), '<ol>\n<li>a</li>\n</ol>\n<ul>\n<li>b</li>\n</ul>');
  });

  it('renders blockquotes', () => {
    assert.equal(markdownToHtml('> quoted'), '<blockquote>\n<p>quoted</p>\n</blockquote>');
  });

  it('escapes HTML inside code fences so the output stays inert', () => {
    const html = markdownToHtml('```\n<script>alert(1)</script> & <b>x</b>\n```');
    assert.equal(html, '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;x&lt;/b&gt;</code></pre>');
    assert.ok(!html.includes('<script'));
  });

  it('closes an unterminated code fence at the end of the document', () => {
    assert.equal(markdownToHtml('```\nunclosed'), '<pre><code>unclosed</code></pre>');
  });

  it('renders links with target/rel and images', () => {
    assert.equal(
      markdownToHtml('[text](https://e.org/a)'),
      '<p><a href="https://e.org/a" target="_blank" rel="noreferrer">text</a></p>',
    );
    assert.equal(
      markdownToHtml('![alt](https://e.org/a.png)'),
      '<p><img src="https://e.org/a.png" alt="alt" loading="lazy"></p>',
    );
  });

  it('degrades an unsafe link target to # instead of emitting it', () => {
    // 模型生成的译文/改写不可信，链接协议必须在这里就被削掉。
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x']) {
      const html = markdownToHtml(`[click](${href})`);
      assert.ok(html.includes('href="#"'), `${href} must degrade to #: ${html}`);
      assert.ok(!html.includes(href), `${href} must not survive: ${html}`);
    }
  });

  it('escapes HTML that appears literally in the Markdown source', () => {
    assert.equal(markdownToHtml('a < b & c > d'), '<p>a &lt; b &amp; c &gt; d</p>');
    assert.equal(markdownToHtml('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('escapes quotes in attribute values', () => {
    assert.ok(markdownToHtml('![a"b](https://e.org/x.png)').includes('alt="a&quot;b"'));
  });
});
