/**
 * 导出 Markdown（0.44.9）。
 *
 * 这个功能的价值全在**结构**上：正文里的标题层级、列表、表格、代码块、链接。
 * 所以断言全部盯着「结构有没有正确表达」，而不是「文字在不在」——
 * 一个把 `<h2>` 和 `<p>` 都拍平成纯文本的实现，文字一条不少，但导出的文件没用。
 *
 * 三条最容易犯、且**都不报错**的错法：
 *   ① 列表项之间多出空行 ⇒ 松散列表（每项之间空一行，原文的紧凑列表被改掉）；
 *   ② 表头与分隔行之间多出空行 ⇒ Markdown 不认这是表格，退化成几行普通文字；
 *   ③ `<br>` 当成普通换行 ⇒ 软换行被接成一行，诗/地址/分行全挤在一起。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  articleToMarkdown, bodyToMarkdown, downloadText, markdownFileName,
} from '../src/client/article-markdown.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('0.44.9：HTML → Markdown —— 块级结构', () => {
  it('标题按级别还原', () => {
    assert.equal(bodyToMarkdown('<h2>小节</h2>'), '## 小节');
    assert.equal(bodyToMarkdown('<h4>深一层</h4>'), '#### 深一层');
  });

  it('★ 段落之间有空行（块与块要分开）', () => {
    assert.equal(bodyToMarkdown('<p>一</p><p>二</p>'), '一\n\n二');
  });

  it('★ 列表项之间**没有**空行（否则渲染成松散列表）', () => {
    assert.equal(bodyToMarkdown('<ul><li>甲</li><li>乙</li></ul>'), '- 甲\n- 乙',
      '项之间多了空行 —— 紧凑列表被改成了松散列表');
  });

  it('有序列表编号递增，且不跨列表串号', () => {
    assert.equal(bodyToMarkdown('<ol><li>一</li><li>二</li><li>三</li></ol>'), '1. 一\n2. 二\n3. 三');
    // 两个独立的 ol：第二个必须重新从 1 开始
    assert.equal(bodyToMarkdown('<ol><li>一</li></ol><ol><li>一</li></ol>'), '1. 一\n\n1. 一');
  });

  it('嵌套列表用缩进表达', () => {
    assert.equal(bodyToMarkdown('<ul><li>外<ul><li>内</li></ul></li></ul>'), '- 外\n  - 内');
  });

  it('引用逐行加 `> `', () => {
    assert.equal(bodyToMarkdown('<blockquote><p>一段</p><p>二段</p></blockquote>'), '> 一段\n>\n> 二段');
  });

  it('代码块用围栏，且原文里出现 ``` 时加长围栏', () => {
    assert.equal(bodyToMarkdown('<pre><code>a = 1\nb = 2</code></pre>'), '```\na = 1\nb = 2\n```');
    const risky = bodyToMarkdown('<pre><code>```js\nx\n```</code></pre>');
    assert.ok(risky.startsWith('````'), '正文里有 ``` 却没加长围栏 —— 代码块会提前闭合');
  });

  it('分隔线', () => {
    assert.equal(bodyToMarkdown('<p>上</p><hr><p>下</p>'), '上\n\n---\n\n下');
  });

  it('★ `<br>` 变成硬换行（行尾两个空格），不是普通换行', () => {
    assert.equal(bodyToMarkdown('<p>第一行<br>第二行</p>'), '第一行  \n第二行',
      '`<br>` 只当成了普通换行 —— Markdown 会把它接成一行');
  });
});

describe('0.44.9：HTML → Markdown —— 行内与表格', () => {
  it('强调、删除线、行内代码', () => {
    assert.equal(bodyToMarkdown('<p><strong>粗</strong><em>斜</em><del>删</del><code>码</code></p>'),
      '**粗***斜*~~删~~`码`');
  });

  it('★ 链接与图片，且属性里的实体被解码', () => {
    assert.equal(bodyToMarkdown('<p><a href="https://x.example/a?b=1&amp;c=2">文字</a></p>'),
      '[文字](https://x.example/a?b=1&c=2)');
    assert.equal(bodyToMarkdown('<p><img src="https://x.example/i.png" alt="图注"></p>'),
      '![图注](https://x.example/i.png)');
  });

  it('★ 表头与分隔行必须相邻（中间有空行就不是表格了）', () => {
    const md = bodyToMarkdown('<table><tr><th>列1</th><th>列2</th></tr><tr><td>a</td><td>b</td></tr></table>');
    assert.equal(md, '| 列1 | 列2 |\n| --- | --- |\n| a | b |',
      '表头与分隔行被空行隔开 —— Markdown 不认这是表格');
  });

  it('表格列数与表头一致（分隔行不能少一列）', () => {
    const md = bodyToMarkdown('<table><tr><th>1</th><th>2</th><th>3</th></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>');
    assert.equal(md.split('\n')[1], '| --- | --- | --- |');
  });

  it('不认识的标签只留文字（不加标记）', () => {
    assert.equal(bodyToMarkdown('<p><span>普通</span><sup>2</sup></p>'), '普通2');
  });

  it('空输入不炸', () => {
    assert.equal(bodyToMarkdown(''), '');
    assert.equal(bodyToMarkdown(undefined), '');
  });
});

describe('0.44.9：导出文件 —— 标题区与文件名', () => {
  it('标题区带标题、作者、发布、版本、原文', () => {
    const md = articleToMarkdown({
      title: '一篇', url: 'https://x.example/p', author: '张三',
      publishedAt: '2025-09-26T08:00:00.000Z', version: '译文', html: '<p>正文</p>',
    });
    assert.match(md, /^# 一篇\n/);
    assert.match(md, /作者：张三 · 发布：2025-09-26 · 版本：译文/);
    assert.match(md, /原文：https:\/\/x\.example\/p/);
    assert.match(md, /\n---\n\n/);
    assert.ok(md.endsWith('正文\n'));
  });

  it('没有元信息时不留下空行噪音', () => {
    assert.equal(articleToMarkdown({ title: '只有标题', html: '<p>正文</p>' }), '# 只有标题\n\n---\n\n正文\n');
  });

  it('★ 文件名去掉非法字符并带发布日期', () => {
    const name = markdownFileName('Apple/Google 为什么说“不”: 一份清单', '2025-09-26T08:00:00.000Z');
    assert.equal(name, '2025-09-26-Apple Google 为什么说“不” 一份清单.md');
    assert.ok(!/[/\\:<>|?*]/.test(name), '文件名里还留着非法字符 —— Windows 上会直接写不进去');
  });

  it('空标题有兜底名字', () => {
    assert.equal(markdownFileName('', ''), 'RSS 文章.md');
  });

  it('标题过长会被截断（不然某些文件系统写不进去）', () => {
    assert.ok(markdownFileName('长'.repeat(300), '').length < 100);
  });
});

describe('0.44.9：下载 —— 依赖可注入', () => {
  function fakeEnv() {
    const calls = { created: 0, revoked: [], clicked: 0, appended: 0, removed: 0 };
    const scheduled = [];
    const link = {
      download: '',
      href: '',
      rel: '',
      click() { calls.clicked += 1; },
      remove() { calls.removed += 1; },
    };
    const env = {
      document: {
        createElement: () => link,
        body: { appendChild: () => { calls.appended += 1; } },
      },
      url: {
        createObjectURL: () => { calls.created += 1; return 'blob:fake-1'; },
        revokeObjectURL: (href) => calls.revoked.push(href),
      },
      schedule: (fn) => scheduled.push(fn),
    };
    return { env, link, calls, scheduled };
  }

  it('★ 用 a[download] 触发保存，文件名就是传进去的那个', () => {
    const { env, link, calls } = fakeEnv();
    const href = downloadText('文章.md', '# 标题', env);
    assert.equal(href, 'blob:fake-1');
    assert.equal(link.download, '文章.md');
    assert.equal(link.href, 'blob:fake-1');
    assert.equal(calls.clicked, 1);
    assert.equal(calls.appended, 1);
    assert.equal(calls.removed, 1, '链接没从 DOM 里摘掉 —— 每导出一次多一个隐藏的 <a>');
  });

  it('★ revokeObjectURL 必须延后，不能同步调用', () => {
    const { env, calls, scheduled } = fakeEnv();
    downloadText('a.md', 'x', env);
    assert.deepEqual(calls.revoked, [], '同步 revoke 会让下载拿到失效 URL —— 表现为「点了没反应」');
    assert.equal(scheduled.length, 1);
    scheduled[0]();
    assert.deepEqual(calls.revoked, ['blob:fake-1']);
  });
});

describe('0.44.9：导出 —— 组件接线', () => {
  const reader = stripComments(readFileSync(join(pluginRoot, 'src', 'client', 'ReaderPage.jsx'), 'utf8'));

  it('菜单里有「导出 Markdown」', () => {
    assert.match(reader, /导出 Markdown/);
    assert.match(reader, /exportMarkdown\(\)/);
  });

  it('★ 导出的是屏幕上这一版（title + bodyHtml），不是原始 feed', () => {
    const start = reader.indexOf('const exportMarkdown = () =>');
    assert.ok(start > 0, '找不到 exportMarkdown');
    const body = reader.slice(start, start + 900);
    assert.match(body, /html: bodyHtml/, '导出了 article.html —— 用户读译文却拿到英文原文');
    assert.match(body, /title,/, '导出没用当前版本标题');
    assert.match(body, /version: VERSION_LABELS\[active\]/);
  });

  it('失败会说出来（而不是点了没反应）', () => {
    const start = reader.indexOf('const exportMarkdown = () =>');
    assert.match(reader.slice(start, start + 900), /导出失败/);
  });
});
