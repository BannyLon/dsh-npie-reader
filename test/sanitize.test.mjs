import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeHtmlEntities, firstImageUrl, htmlToText, restoreLinks, sanitizeHtml } from '../src/host/sanitize.js';

describe('sanitizeHtml', () => {
  it('keeps the allowlisted structure', () => {
    const html = sanitizeHtml('<p>Hello <strong>world</strong> and <em>more</em></p>');
    assert.equal(html, '<p>Hello <strong>world</strong> and <em>more</em></p>');
  });

  it('drops script bodies, not just the script tag', () => {
    const html = sanitizeHtml('<p>a</p><script>alert("xss")</script><p>b</p>');
    assert.ok(!html.includes('alert'), html);
    assert.ok(!html.includes('<script'), html);
    assert.ok(html.includes('<p>a</p>') && html.includes('<p>b</p>'));
  });

  it('drops whole subtrees for style / iframe / svg / form', () => {
    for (const tag of ['style', 'iframe', 'svg', 'form', 'textarea', 'button', 'template']) {
      const html = sanitizeHtml(`<p>keep</p><${tag}>payload</${tag}>`);
      assert.ok(!html.includes('payload'), `${tag} content must be dropped: ${html}`);
      assert.ok(html.includes('keep'));
    }
  });

  it('removes every event handler and inline style', () => {
    const html = sanitizeHtml('<p onclick="x()" onmouseover="y()" style="color:red">text</p>');
    assert.equal(html, '<p>text</p>');
  });

  it('removes class attributes (they are neither a safe URL nor an allowlisted plain attribute)', () => {
    assert.equal(sanitizeHtml('<p class="host-thing">text</p>'), '<p>text</p>');
  });

  it('rejects javascript: and data: URLs but keeps http/https/mailto/relative', () => {
    assert.ok(!sanitizeHtml('<a href="javascript:alert(1)">x</a>').includes('javascript'));
    assert.ok(!sanitizeHtml('<a href="data:text/html,<script>">x</a>').includes('data:'));
    assert.ok(sanitizeHtml('<a href="https://example.org/a">x</a>').includes('https://example.org/a'));
    assert.ok(sanitizeHtml('<a href="mailto:a@b.example">x</a>').includes('mailto:a@b.example'));
    assert.ok(sanitizeHtml('<a href="#anchor">x</a>').includes('#anchor'));
  });

  it('rejects schemes hidden behind ASCII whitespace and control characters', () => {
    // 浏览器会忽略 URL 里的制表符/换行，`java\tscript:` 照样执行；
    // 只按字面量前缀判协议就会把它当成相对路径放过去。
    for (const raw of ['java\tscript:alert(1)', 'java\nscript:alert(1)', '  javascript:alert(1)', 'java\u0000script:alert(1)']) {
      const html = sanitizeHtml(`<a href="${raw}">x</a>`);
      assert.ok(!html.includes('script:'), `${JSON.stringify(raw)} must not survive: ${html}`);
    }
  });

  it('keeps bare relative paths (they resolve against the article base)', () => {
    assert.ok(sanitizeHtml('<a href="post/2">next</a>').includes('href="post/2"'));
    assert.ok(sanitizeHtml('<a href="../up">up</a>').includes('href="../up"'));
    assert.ok(sanitizeHtml('<a href="//cdn.example/x">cdn</a>').includes('href="//cdn.example/x"'));
  });

  it('resolves relative URLs against the article base', () => {
    const html = sanitizeHtml('<img src="/pic.png"><a href="post/2">next</a>', { baseUrl: 'https://example.org/blog/1' });
    assert.ok(html.includes('src="https://example.org/pic.png"'), html);
    assert.ok(html.includes('href="https://example.org/blog/post/2"'), html);
  });

  it('adds loading="lazy" to images and keeps only alt/title', () => {
    const html = sanitizeHtml('<img src="https://e.org/a.png" alt="An image" title="T" width="99" onerror="x()">');
    assert.equal(html, '<img src="https://e.org/a.png" alt="An image" title="T" loading="lazy">');
  });

  it('drops comments and doctypes', () => {
    assert.equal(sanitizeHtml('<!-- secret --><p>visible</p>'), '<p>visible</p>');
    assert.equal(sanitizeHtml('<!DOCTYPE html><p>x</p>'), '<p>x</p>');
  });

  it('caps the output length', () => {
    const html = sanitizeHtml(`<p>${'x'.repeat(500)}</p>`, { maxLength: 40 });
    assert.equal(html.length, 40);
  });

  it('closes tags left open at the end of the document', () => {
    assert.equal(sanitizeHtml('<p><strong>bold'), '<p><strong>bold</strong></p>');
  });

  it('★ 被丢弃的子树里不许泄漏开标签（DROP_CONTENT 丢的是「整棵」）', () => {
    // 2026-10-13 The Rundown AI：上游剪枝后 `<svg>` 的配对闭合标签被删掉，
    // 于是永久处于丢弃状态。旧实现只对**文本**做了 `insideDropped()` 判断，
    // 开标签是照写的 —— 正文里第一个 `<div>` 就泄漏出来了。真机产物是
    // `<a href="…twitter…"><div></a>` 这 216 个字符（纯文本 0 字符）。
    const html = sanitizeHtml('<p>before</p><script>var s = "<div>leak</div>";</script><p>after</p>');
    assert.ok(!html.includes('<div'), `丢弃子树里的 <div> 不该泄漏：${html}`);
    assert.ok(!html.includes('leak'), html);
    assert.equal(html, '<p>before</p><p>after</p>');
  });

  it('★ 丢弃子树里的允许标签仍要入栈（否则闭合标签会错配到外层）', () => {
    // 只去掉「写出去」这一步，入栈照旧。若连入栈也去掉，丢弃子树里的 `</div>`
    // 会往上找到**外层**的 div 并把它闭合，后面的正文就被挤到容器外面了。
    assert.equal(
      sanitizeHtml('<div><script><div>inner</div></script><p>after</p></div>'),
      '<div><p>after</p></div>',
    );
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named and numeric references and leaves unknown ones alone', () => {
    assert.equal(decodeHtmlEntities('a&amp;b'), 'a&b');
    assert.equal(decodeHtmlEntities('&mdash;'), '—');
    assert.equal(decodeHtmlEntities('&#65;&#x42;'), 'AB');
    assert.equal(decodeHtmlEntities('&notarealentity;'), '&notarealentity;');
  });

  it('refuses control characters and lone surrogates', () => {
    assert.equal(decodeHtmlEntities('&#0;'), '&#0;');
    assert.equal(decodeHtmlEntities('&#xD800;'), '&#xD800;');
  });
});

describe('firstImageUrl', () => {
  it('finds the first safe image source', () => {
    assert.equal(firstImageUrl('<p><img src="https://e.org/a.png"></p>'), 'https://e.org/a.png');
    assert.equal(firstImageUrl('<img src="/rel.png">', 'https://e.org/blog/'), 'https://e.org/rel.png');
    assert.equal(firstImageUrl('<img src="javascript:alert(1)">'), undefined);
    assert.equal(firstImageUrl('<p>no image</p>'), undefined);
  });
});

describe('htmlToText', () => {
  it('★ 段落之间必须是**空行**：Markdown 里单换行属于同一段', () => {
    // 2026-10-12 修的就是这一条。以前最后一步做了 `.replace(/\n{2,}/g, '\n')`，
    // `<p>a</p><p>b</p>` 产出 "a\nb"。喂给翻译模型时它无从知道原文哪里分段，
    // 实测把十来个短段吐成一个 1165 字的巨段，用户报「翻译后排版全变了」。
    assert.equal(htmlToText('<p>One</p><p>Two</p>'), 'One\n\nTwo');
    assert.equal(htmlToText('<h1>Title</h1><p>Body</p>'), '# Title\n\nBody');
    assert.equal(htmlToText('<h2>小节</h2><p>b</p>'), '## 小节\n\nb');
    // 列表项之间要单换行（空行会把列表断开），用「- 」前缀表达层级。
    assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
    // 行内换行保持单换行：它不是段落边界。
    assert.equal(htmlToText('<p>a<br>b</p>'), 'a\nb');
    assert.equal(htmlToText('<p>a</p><hr><p>b</p>'), 'a\n\n---\n\nb');
  });

  it('★ 反向对照：把段落压成单换行的实现会在这一条上变红', () => {
    const naive = (html) => html.replace(/<\/?p>/g, '\n').replace(/\n{2,}/g, '\n').trim();
    assert.equal(naive('<p>a</p><p>b</p>'), 'a\nb');
    assert.notEqual(naive('<p>a</p><p>b</p>'), htmlToText('<p>a</p><p>b</p>'));
    assert.ok(htmlToText('<p>a</p><p>b</p>').includes('\n\n'));
  });

  it('★ 代码块：保留缩进并包上围栏（否则译文里的代码是一坨没缩进的文字）', () => {
    const text = htmlToText('<p>说明</p><pre><code>def f():\n    return 1</code></pre><p>后</p>');
    assert.ok(text.includes('```\ndef f():\n    return 1\n```'), text);
    assert.ok(text.startsWith('说明\n\n'), text);
    assert.ok(text.endsWith('\n\n后'), text);
  });

  it('★ 反向对照：把 pre 当普通块处理会同时丢掉缩进与围栏', () => {
    // 旧实现走的是「剥标签 + [ \t]+ → 单空格」，实测原文 17 个 pre 在译文里
    // 0 个围栏、Python 缩进全没。
    const naive = htmlToText('<pre>def f():\n    return 1</pre>')
      .replace(/```/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    assert.ok(!naive.includes('    return 1'), naive);
    assert.ok(htmlToText('<pre>def f():\n    return 1</pre>').includes('    return 1'));
  });

  it('★ 代码块里的 HTML 实体要还原（源码里本来就是 & 和 <）', () => {
    assert.equal(htmlToText('<pre>if (a &amp;&amp; b &lt; c) {}</pre>'), '```\nif (a && b < c) {}\n```');
  });

  it('strips scripts and collapses intra-paragraph whitespace', () => {
    assert.equal(htmlToText('<p>a   \t  b</p>'), 'a b');
    assert.ok(!htmlToText('<script>bad()</script><p>good</p>').includes('bad'));
  });

  it('caps the output length with an ellipsis', () => {
    const text = htmlToText(`<p>${'x'.repeat(300)}</p>`, 50);
    assert.equal(text.length, 51);
    assert.ok(text.endsWith('…'));
  });

  it('默认剥掉 img；keepImages 把每张图转成**独立成段**的 Markdown 标记', () => {
    const html = '<p>前</p><img src="https://e/a.png" alt="图"><p>后</p>';
    assert.ok(!htmlToText(html).includes('img') && !htmlToText(html).includes('e/a.png'));
    // 前后各一个空行：与文字挤在同一段时，模型会把它当成正文的一部分顺手处理掉。
    assert.equal(htmlToText(html, 20_000, { keepImages: true }), '前\n\n![图](https://e/a.png)\n\n后');
  });

  it('keepImages：URL 里的空格与右括号转百分号编码（否则 Markdown 语法被截断）', () => {
    const text = htmlToText('<img src="https://e/a b(1).png" alt="">', 20_000, { keepImages: true });
    assert.ok(text.includes('](https://e/a%20b%281%29.png)'), text);
  });

  it('keepImages：alt 里的方括号被剥掉（会提前闭合 ![ ] 语法）', () => {
    const text = htmlToText('<img src="https://e/a.png" alt="a[b]c">', 20_000, { keepImages: true });
    assert.ok(text.includes('![abc]('), text);
  });

  it('keepImages：没有 src 的图只留换行，不产出空标记', () => {
    const text = htmlToText('<img loading="lazy"><p>x</p>', 20_000, { keepImages: true });
    assert.equal(text, 'x');
  });

  it('★ 列表项：块级标签在 <li> 内部各给一个空行，必须合回去', () => {
    // 2026-10-13 用户报「译文排版还是混乱」。真机那篇 newsletter 的 HTML 是
    // `<ul><li><p>…</p></li>…</ul>`，**36 个列表项 36 个**都被劈成
    // 「`-` / 空行 / 正文」。Markdown 里那是一个**空列表项**加一个普通段落 ——
    // 界面上就是孤零零一个「-」，条目之间还被空行撑开。
    assert.equal(
      htmlToText('<ul><li><p>甲</p></li><li><p>乙</p></li><li><p>丙</p></li></ul>'),
      '- 甲\n- 乙\n- 丙',
    );
    // 本来就没包 <p> 的列表项不受影响。
    assert.equal(htmlToText('<ul><li>甲</li><li>乙</li></ul>'), '- 甲\n- 乙');
    // 列表项里的行内格式照旧保留。
    assert.equal(htmlToText('<ul><li><p>看 <strong>这里</strong></p></li></ul>'), '- 看 **这里**');
    // 多段落的列表项：段落边界不能丢（那是真内容，不是包装）。
    assert.equal(htmlToText('<ul><li><p>甲一</p><p>甲二</p></li></ul>'), '- 甲一\n\n甲二');
  });

  it('★ 反向对照：把 <li> 里的 <p> 当普通块处理，就会产出孤零零一个「-」', () => {
    const html = '<ul><li><p>甲</p></li><li><p>乙</p></li></ul>';
    // 朴素实现 = 修复前的行为：`<li>` → `- `、`<p>` → 空行，不做任何合并。
    const naive = html
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<\/li>/gi, '')
      .replace(/<\/?(?:ul|p)[^>]*>/gi, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    assert.ok(/^-\n/m.test(naive), `朴素实现应当产出孤立的「-」：${JSON.stringify(naive)}`);
    assert.ok(!/^-\n/m.test(htmlToText(html)), '修复后的实现不能再出现孤立的「-」');
  });

  it('★ 行内格式要转成 Markdown 标记（否则「剥标签」那一步把它们无声吃掉）', () => {
    // 真机全库实测 493 个 `<strong>` / 59 个 `<em>` / 123 个 `<code>` 一个都没
    // 进过译文 —— 用户看到的就是「原文有加粗、有橙色链接，译文全是纯文本」。
    assert.equal(htmlToText('<p><strong>粗</strong>和<em>斜</em>和<code>x=1</code></p>'), '**粗**和*斜*和`x=1`');
    assert.equal(htmlToText('<p><del>删</del></p>'), '~~删~~');
    // 带属性的写法同样要认。
    assert.equal(htmlToText('<p><strong class="k">粗</strong></p>'), '**粗**');
  });

  it('★ 反向对照：只剥标签的实现，行内格式全丢', () => {
    const html = '<p><strong>粗</strong>和<em>斜</em></p>';
    const naive = html.replace(/<[^>]+>/g, '').trim();
    assert.equal(naive, '粗和斜');
    assert.notEqual(naive, htmlToText(html));
    assert.ok(htmlToText(html).includes('**粗**'));
  });

  it('★ 回归：<br> 不能被 <b> 的规则吃掉，<img> 不能被 <i> 的规则吃掉', () => {
    // 第一版写成 `</?(?:strong|b)[^>]*>`，标签名后面直接跟 `[^>]*` ——
    // `b` 于是匹配到 `<br>`、`i` 匹配到 `<img>`：换行变成 `**`、图片变成 `*`。
    assert.equal(htmlToText('<p>a<br>b</p>'), 'a\nb');
    assert.equal(htmlToText('<p>a<img src="https://e/a.png">b</p>'), 'a b');
    assert.equal(htmlToText('<p><s>删</s>与<small>小</small></p>'), '~~删~~与 小');
  });

  it('★ 实体解码要排在剥标签之后', () => {
    // 反过来的话，正文里本来只是**文字**的 `&lt;b&gt;` 会先变成真标签、再被剥掉。
    assert.equal(htmlToText('<p>a &amp; b</p>'), 'a & b');
    assert.equal(htmlToText('<p>AT&amp;T</p>'), 'AT&T');
    assert.equal(htmlToText('<p>用 &lt;b&gt; 加粗</p>'), '用 <b> 加粗');
  });

  it('★ 反向对照：先解码再剥标签，`&lt;b&gt;` 那三个字会被吃掉', () => {
    const html = '<p>用 &lt;b&gt; 加粗</p>';
    const naive = html
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    assert.equal(naive, '用 加粗');
    assert.ok(htmlToText(html).includes('<b>'), htmlToText(html));
  });

  it('★ 链接：URL 走占位符，完全不进模型', () => {
    // 模型抄 URL 不可靠 —— 实测它把 `q_auto:good` 抄成了 `q_2A`（前者 HTTP 200、
    // 后者 404）。占位符让 URL 一次都不经过模型。
    const links = [];
    const text = htmlToText(
      '<p>看 <a href="https://e.org/a?q=1">这个</a> 和 <a href="https://e.org/b">那个</a></p>',
      20_000, { links },
    );
    assert.equal(text, '看 [这个]({{L0}}) 和 [那个]({{L1}})');
    assert.deepEqual(links, ['https://e.org/a?q=1', 'https://e.org/b']);
    // 不传数组就维持原样（URL 被剥掉、只留文字）—— 伴读问答走这条路。
    assert.equal(htmlToText('<p>看 <a href="https://e.org/a">这个</a></p>'), '看 这个');
  });

  it('★ 图片链接（<a><div><img></div></a>）要包成 [![alt](src)](占位符)', () => {
    const links = [];
    const text = htmlToText(
      '<a href="https://e.org/page"><div><img src="https://e.org/p.png" alt="图"></div></a>',
      20_000, { keepImages: true, links },
    );
    assert.equal(text, '[![图](https://e.org/p.png)]({{L0}})');
    assert.deepEqual(links, ['https://e.org/page']);
  });

  it('★ 反向对照：不做还原，译文里就会原样露出 {{L0}}', () => {
    const links = [];
    const text = htmlToText('<p><a href="https://e.org/a">这个</a></p>', 20_000, { links });
    assert.ok(text.includes('{{L0}}'), text);
    assert.ok(!text.includes('https://e.org/a'), '真 URL 本来就不该出现在正文里');
    assert.ok(!restoreLinks(text, links).includes('{{L0}}'), '还原之后不该再有占位符');
  });

  it('restoreLinks：换回真 URL，并宽容模型加的空格 / 全角括号', () => {
    const links = ['https://e.org/a', 'https://e.org/b'];
    assert.equal(restoreLinks('[文字]({{L0}})', links), '[文字](https://e.org/a)');
    assert.equal(restoreLinks('[文字]({{ L1 }})', links), '[文字](https://e.org/b)');
    assert.equal(restoreLinks('[文字](｛｛L0｝｝)', links), '[文字](https://e.org/a)');
    // 越界 / 空表不炸，也不改内容（宁可留个占位符，也不要写出一个假链接）。
    assert.equal(restoreLinks('[文字]({{L9}})', links), '[文字]({{L9}})');
    assert.equal(restoreLinks('[文字]({{L0}})', []), '[文字]({{L0}})');
  });
});
