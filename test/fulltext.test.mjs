import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractMainHtml, FULLTEXT_LIMITS } from '../src/host/fulltext.js';

/** 一段足够长的正文（60 个词 ≈ 299 字符，远超单段门槛）。 */
const paragraph = (words = 60) => `<p>${'word '.repeat(words).trim()}</p>`;
const prose = (count = 3) => paragraph().repeat(count);

describe('extractMainHtml', () => {
  it('rejects documents too small to contain an article', () => {
    assert.equal(extractMainHtml(''), null);
    assert.equal(extractMainHtml('<p>hi</p>'), null);
    assert.equal(extractMainHtml(null), null);
    assert.equal(extractMainHtml(undefined), null);
  });

  it('takes <article> and drops nav, header, footer and aside around it', () => {
    const page = `<!doctype html><html><head><title>x</title></head><body>
      <header><a href="/">Homepage link text</a></header>
      <nav><a href="/about">About us page</a></nav>
      <aside><a href="/sponsor">Sponsored by somebody</a></aside>
      <article>${prose()}</article>
      <footer><a href="/privacy">Privacy policy and terms</a></footer>
    </body></html>`;
    const result = extractMainHtml(page);
    assert.equal(result.strategy, 'article');
    assert.ok(result.html.includes('word'), '正文必须在');
    for (const noise of ['About us page', 'Sponsored by somebody', 'Privacy policy and terms', 'Homepage link text']) {
      assert.ok(!result.html.includes(noise), `噪声「${noise}」不该出现`);
    }
  });

  it('takes <main> when there is no <article>', () => {
    const result = extractMainHtml(`<html><body><div><main>${prose()}</main></div></body></html>`);
    assert.equal(result.strategy, 'main');
    assert.ok(result.html.includes('word'));
  });

  it('takes role="main" and itemprop="articleBody"', () => {
    assert.equal(extractMainHtml(`<html><body><div role="main">${prose()}</div></body></html>`).strategy, 'role');
    assert.equal(extractMainHtml(`<html><body><div itemprop="articleBody">${prose()}</div></body></html>`).strategy, 'role');
  });

  it('does not trust a tiny <article> that only holds a byline', () => {
    // 反向对照组：直接采用 <article> 的捷径必须有「占比」这道闸门，
    // 否则页面上任何一个小 <article>（作者署名、卡片）都会把正文挤掉。
    const page = `<html><body><article><p>By Jane Doe</p></article>
      <div class="post">${prose()}</div></body></html>`;
    const result = extractMainHtml(page);
    assert.equal(result.strategy, 'score', '不该采用那个只有署名的 <article>');
    assert.ok(result.html.includes('word'));
    assert.ok(!result.html.includes('Jane Doe'));
  });

  it('scores prose above a link-heavy sidebar', () => {
    const links = Array.from({ length: 12 }, (_value, index) => `<li><a href="/l${index}">Recommended reading number ${index} for you</a></li>`).join('');
    const page = `<html><body><div id="wrap">
      <div class="side"><ul>${links}</ul></div>
      <div class="post">${prose()}</div>
    </div></body></html>`;
    const result = extractMainHtml(page);
    assert.equal(result.strategy, 'score');
    assert.ok(result.html.includes('word'));
    assert.ok(!result.html.includes('Recommended reading'), '侧栏不该被当成正文');
  });

  it('returns null for a page whose only text is a link farm', () => {
    // 反向对照：链接密度惩罚必须真的能让「全是链接」的容器落选，
    // 否则导航页会被当成文章渲染出来。
    const page = `<html><body><div><ul>${Array.from({ length: 20 }, (_value, index) => `<li><a href="/a${index}">A fairly long link title number ${index}</a></li>`).join('')}</ul></div></body></html>`;
    assert.equal(extractMainHtml(page), null);
  });

  it('returns null when stripping noise leaves too little text', () => {
    const page = `<html><body><nav><a href="/">Home</a><a href="/x">Another page link</a></nav><p>tiny</p></body></html>`;
    assert.equal(extractMainHtml(page), null);
  });

  it('drops script and style content entirely', () => {
    const page = `<html><head><style>.x{color:red}</style><script>var secret='UNIQUE_MARKER';</script></head>
      <body><article>${prose()}</article></body></html>`;
    const result = extractMainHtml(page);
    assert.ok(!result.html.includes('UNIQUE_MARKER'), '脚本内容不该进正文');
    assert.ok(!result.html.includes('color:red'), '样式内容不该进正文');
  });

  it('keeps relative links and images verbatim for the caller to resolve', () => {
    const page = `<html><body><article>${prose()}<a href="/rel">a link</a><img src="/pic.png" alt="p"></article></body></html>`;
    const result = extractMainHtml(page);
    assert.ok(result.html.includes('href="/rel"'));
    assert.ok(result.html.includes('src="/pic.png"'));
  });

  it('survives unclosed tags without throwing', () => {
    const page = `<html><body><div><p>${'word '.repeat(80).trim()}`;
    let result;
    assert.doesNotThrow(() => { result = extractMainHtml(page); });
    assert.equal(result.strategy, 'score');
    assert.ok(result.textLength >= FULLTEXT_LIMITS.minBodyChars);
  });

  it('★ 回归：带属性的噪声标签必须删干净，不能留下半截开标签', () => {
    // 2026-10-13 用户报「The Rundown AI 只显示摘要」的根因。
    //
    // `stripNoise` 原先用 `element.start - (element.tag.length + 2)` **反推**删除起点，
    // 那等于假设开标签写成 `<tag>`（**不带属性**）。上面那条 `drops nav, header,
    // footer and aside` 用的恰好就是不带属性的 `<nav>` / `<header>`，所以一直是绿的。
    // 真机上是 `<nav class="text-xs text-mute">` —— 属性比标签名长得多，反推出的起点
    // 落在**属性值内部**，删完还剩半截 `<nav class="text-xs text-m`：一个引号不平衡、
    // `>` 已被删掉的开标签。它在下游 `sanitizeHtml` 里被 `findTagEnd` 的引号跟踪
    // 吞掉 931 字符，正文容器 72 704 → 216 字符 → 纯文本 0 字符，`hydrateBody`
    // 判定「不比订阅源提供的更多」⇒ 界面只剩摘要。
    const page = `<html><body><article>
      <nav class="text-xs text-mute"><a href="/">The Rundown AI</a> / <a href="/a">Newsletters</a></nav>
      <header class="site-header sticky"><a href="/x">A header link with text</a></header>
      ${prose()}
      <footer class="site-footer"><a href="/p">Privacy policy and terms</a></footer>
    </article></body></html>`;
    const result = extractMainHtml(page);
    assert.ok(result, '必须抽出正文');
    for (const noise of ['The Rundown AI', 'Newsletters', 'A header link with text', 'Privacy policy and terms']) {
      assert.ok(!result.html.includes(noise), `噪声「${noise}」不该出现：${result.html.slice(0, 200)}`);
    }
    // 关键断言：容器的**第一个标签**必须是正文，不能是半截噪声标签。
    // （只跳过源码缩进留下的空白，不许跳过任何标签。）
    assert.ok(/^\s*<p>/.test(result.html), `容器开头是 ${JSON.stringify(result.html.slice(0, 60))}`);
    for (const tag of ['nav', 'header', 'footer']) {
      assert.ok(!new RegExp(`<${tag}\\b`, 'i').test(result.html), `不该残留 <${tag}`);
    }
  });

  it('★ 反向对照：旧的「从开标签结尾反推起点」公式切错位置', () => {
    // 把那条错误公式单独钉住，免得日后有人「顺手」改回去。
    const html = '<nav class="text-xs text-mute"><a href="/">Home</a></nav><p>body</p>';
    const openTagEnd = html.indexOf('>') + 1;          // = element.start
    const oldStart = openTagEnd - ('nav'.length + 2);  // = 旧公式
    assert.equal(html.slice(0, oldStart), '<nav class="text-xs text-m', '旧公式切出来的就是半截标签');
    assert.ok(!html.slice(0, oldStart).endsWith('>'), '半截标签的 `>` 已经被切掉了');
    // 正确起点是 `<` 本身。
    assert.equal(html.slice(0, 1), '<');
  });

  it('★ 自闭合的噪声标签只删自己，不能把后面整页一起删掉', () => {
    // `parseTree` 里自闭合元素的 `outerEnd` 原本留成 `html.length`，
    // `stripNoise` 于是从该标签一直删到文件末尾。形态罕见（真实页面里
    // `<svg/>` 这么写的很少），但代价是全页正文消失，值得钉住。
    const page = `<html><body><div><p>${'first '.repeat(60).trim()}</p>`
      + `<svg/><p>${'second '.repeat(60).trim()}</p></div></body></html>`;
    const result = extractMainHtml(page);
    assert.ok(result, '必须抽出正文');
    assert.ok(result.html.includes('first'), '前半段正文必须在');
    assert.ok(result.html.includes('second'), '★ 自闭合标签之后的正文也必须在');
    assert.ok(!result.html.includes('<svg'), '自闭合标签本身必须删掉');
  });

  it('★ 整页一个 <p> 都没有时，按「文本块收敛」抽出正文（TLDR AI 形态）', () => {
    // 2026-10-13 用户报「TLDR AI 订阅不到原文内容」的根因。
    //
    // 该站是 Next.js + Tailwind：**整页 0 个 `<p>`**（实测 `p:0` `li:0`），
    // 正文全在 `<div>` 里。打分法的**种子**只认 `p/pre/blockquote/li/td/dd`
    // ⇒ 种子集为空 ⇒ 语义直取（18 个 `<article>` 全部只占全页 0.3–1.1%，
    // 远低于 `DIRECT_TAG_SHARE` 那道 25% 闸门）与打分法**双双落空** ⇒ 返回 null
    // ⇒ 界面上是「这个版本还没有内容」。
    // ⇒ 兜底必须**换判据**（按「文本块收敛」找容器），而不是放宽阈值 ——
    //   种子集是空的时候，阈值再松也变不出种子来。
    const page = `<html><body>
      <div class="shell">
        <div class="content-center max-w-xl mt-5">
          <div>${'alpha '.repeat(80).trim()}</div>
          <div>${'beta '.repeat(80).trim()}</div>
        </div>
      </div>
      <div class="sidebar">${'sidebar '.repeat(10).trim()}</div>
    </body></html>`;
    const result = extractMainHtml(page);
    assert.ok(result, '必须抽出正文');
    assert.equal(result.strategy, 'text');
    assert.ok(result.html.includes('alpha'));
    assert.ok(result.html.includes('beta'));
    // 收敛必须停在「正文容器」而不是外层壳：壳里的旁栏不该被一起带走。
    assert.ok(!result.html.includes('sidebar'), `旁栏被带进来了：${result.html.slice(0, 200)}`);
  });

  it('★ 反向对照：没有 <p> 的纯链接页仍必须返回 null（链接密度闸门得有牙）', () => {
    // 「文本块收敛」比打分法宽松得多（不要求种子、不要求占比），所以它必须
    // 自带一道闸门：**链接密度**。去掉这道闸门，导航页会被当成文章渲染出来。
    // 这条用例专门走新兜底那条路（整页 0 个 `<p>`，种子集为空）。
    const links = Array.from({ length: 20 }, (_value, index) => `<a href="/a${index}">A fairly long link title number ${index}</a>`).join(' ');
    const page = `<html><body><div class="nav-only">${links}</div></body></html>`;
    assert.equal(extractMainHtml(page), null);
  });
});
