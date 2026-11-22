/**
 * 论文元数据源：链接识别 / alphaXiv 页面解析 / 检索排序。
 *
 * 三条纪律：
 *  1. **不联网**。这里只测纯函数；抓取那一层（`fetchText` + 地址守卫）由
 *     `paper.test.mjs` 的文件头纪律共用 —— 把真网络放进单元测试，CI 就变成
 *     一台网络探测器，红绿灯跟着别人的机房走。
 *  2. **每条「该留」都配一条「该丢」**。`rankArxivResults` 这种筛选器最危险的
 *     失败方式是「什么都留」：它不报错，只是把用户看到的那一屏变成一堆无关论文
 *     —— 那正是 0.90.0 要修的那个现象。
 *  3. 界面文案也在这里守一句（用户手上有 alphaXiv 链接，而提示里没有「alphaXiv」
 *     这三个字的话，他不知道该往哪儿粘）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  arxivQueryPlan, isTitleExactMatch, normalizeAlphaXivSlug, normalizeArxivId, paperFromAlphaXivHtml,
  queryPhrase, queryTokens, rankArxivResults, tokenCoverage,
} from '../src/host/paper-source.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => stripComments(readFileSync(join(pluginRoot, relative), 'utf8'));

/**
 * alphaXiv 论文页的 head（2026-11-22 实测抓下来的那几条原样保留）。
 *
 * ★ 用真页面的标签顺序与属性写法，不自己编一个「理想 HTML」：解析器要面对的是
 *   真页面。`q` 那几条是给「属性顺序反过来」用的对照组 —— 真页面里 `content`
 *   在前、`name` 在后也出现过。
 */
const ALPHAXIV_PAGE = `<!doctype html><html><head>
<meta charSet="utf-8"/>
<meta name="description" content="Modern language models (LMs) are post-trained and deployed as agents inside a "harness", but standard harness designs accumulate context."/>
<meta property="og:title" content="Language Model Harnesses Can Be Compositional Generalizers"/>
<meta property="og:description" content="Modern language models (LMs) are post-trained and deployed as agents inside a "harness", but standard harness designs accumulate context."/>
<meta name="citation_title" content="Language Model Harnesses Can Be Compositional Generalizers"/>
<meta name="citation_author" content="Alex L. Zhang"/>
<meta name="citation_author" content="Souradip Chakraborty"/>
<meta name="citation_author" content="Omar Khattab"/>
<meta name="citation_publication_date" content="2026/11/20"/>
<meta name="citation_pdf_url" content="https://www.alphaxiv.org/abs/2611.harness-cg.pdf"/>
</head><body><div id="root"></div></body></html>`;

/** arXiv 有编号的那类 alphaXiv 页面（多一个 `citation_arxiv_id`）。 */
const ALPHAXIV_ARXIV_PAGE = `<html><head>
<meta name="citation_title" content="Attention Is All You Need"/>
<meta name="citation_author" content="Ashish Vaswani"/>
<meta name="citation_publication_date" content="2023/8/2"/>
<meta name="citation_pdf_url" content="https://pdfs.assets.alphaxiv.org/1706.03762v7.pdf"/>
<meta name="citation_arxiv_id" content="1706.03762"/>
</head><body></body></html>`;

/** 不存在的 slug：真页面回 404，body 里一个 `citation_*` 都没有。 */
const NOT_A_PAPER_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>
<title>alphaXiv</title></head><body><h1>404</h1></body></html>`;

describe('alphaXiv 链接识别', () => {
  it('页面地址 / PDF 直链 / 带 query / 裸 slug 都认', () => {
    const slug = '2611.harness-cg';
    for (const input of [
      'https://www.alphaxiv.org/abs/2611.harness-cg',
      'https://www.alphaxiv.org/abs/2611.harness-cg.pdf',
      // ★ 用户 2026-11-22 给的**论文 URL** 就是 /pdf/ 这一条 —— 旧实现不认，
      //   掉到兜底当标题搜，直接导回来一篇无关论文（还没提示没找到）。
      'https://www.alphaxiv.org/pdf/2611.harness-cg',
      'https://alphaxiv.org/pdf/2611.harness-cg',
      'https://www.alphaxiv.org/pdf/2611.harness-cg.pdf',
      'https://alphaxiv.org/abs/2611.harness-cg',
      'https://www.alphaxiv.org/overview/2611.harness-cg',
      'https://www.alphaxiv.org/abs/2611.harness-cg?utm_source=share#comments',
      '  2611.harness-cg  ',
    ]) {
      assert.equal(normalizeAlphaXivSlug(input), slug, `没认出来：${input}`);
    }
  });

  it('★ 不能把 arXiv 编号当成 alphaXiv slug（两者都以 YYMM. 开头）', () => {
    // 误判的后果：一个有编号的论文被拖去 alphaXiv 抓页面（抓不到），
    // 或者一个 alphaXiv slug 被塞进 `id_list`（arXiv 回一条空 feed）。
    assert.equal(normalizeAlphaXivSlug('2611.12345'), '');
    assert.equal(normalizeAlphaXivSlug('https://arxiv.org/abs/2611.12345'), '');
    assert.equal(normalizeAlphaXivSlug('https://www.alphaxiv.org/abs/2611.12345'), '');
    assert.equal(normalizeAlphaXivSlug('hep-th/9901001'), '');
    assert.equal(normalizeAlphaXivSlug(''), '');
  });

  it('别的域名 / 没带年月前缀的都不算', () => {
    assert.equal(normalizeAlphaXivSlug('https://example.com/abs/2611.harness-cg'), '');
    assert.equal(normalizeAlphaXivSlug('harness-cg'), '');
    assert.equal(normalizeAlphaXivSlug('2611.12345v2'), '');
  });

  it('alphaXiv 上有 arXiv 编号的页面，按 arXiv 编号认出来（走 arXiv 那条源）', () => {
    assert.equal(normalizeArxivId('https://www.alphaxiv.org/abs/1706.03762'), '1706.03762');
    assert.equal(normalizeArxivId('https://www.alphaxiv.org/abs/1706.03762v3'), '1706.03762');
    assert.equal(normalizeArxivId('https://www.alphaxiv.org/abs/2611.harness-cg'), '');
  });
});

describe('alphaXiv 页面解析', () => {
  it('标题 / 作者 / 年份 / PDF / 来源页都取到，key 用 slug', () => {
    const paper = paperFromAlphaXivHtml(ALPHAXIV_PAGE, '2611.harness-cg');
    assert.ok(paper !== null);
    assert.equal(paper.title, 'Language Model Harnesses Can Be Compositional Generalizers');
    assert.deepEqual(paper.authors, ['Alex L. Zhang', 'Souradip Chakraborty', 'Omar Khattab']);
    assert.equal(paper.year, 2026);
    assert.equal(paper.pdfUrl, 'https://www.alphaxiv.org/abs/2611.harness-cg.pdf');
    assert.equal(paper.url, 'https://www.alphaxiv.org/abs/2611.harness-cg');
    assert.equal(paper.key, 'alphaxiv:2611.harness-cg');
    assert.equal(paper.source, 'alphaxiv');
    // 没有 arXiv 编号 —— 这正是「arXiv 上搜不到」的根本原因。
    assert.equal(paper.arxivId, '');
    // 摘要退到 og:description（alphaXiv 不写 citation_abstract）。
    assert.match(paper.abstract, /post-trained and deployed as agents/);
  });

  it('★ 404 页面 ⇒ null（而不是一条标题是「未命名论文」的记录）', () => {
    // 真页面回 200 还是 404 都拦不住「元数据是空的」这件事：真 404 页是 200 之外
    // 的形态，但 alphaXiv 的 404 也带完整 head ⇒ 只能靠 citation_title 在不在。
    assert.equal(paperFromAlphaXivHtml(NOT_A_PAPER_PAGE, '2611.nope'), null);
    assert.equal(paperFromAlphaXivHtml('', '2611.nope'), null);
  });

  it('页面带 citation_arxiv_id ⇒ 记下 arXiv 编号（上层据此改走 arXiv）', () => {
    const paper = paperFromAlphaXivHtml(ALPHAXIV_ARXIV_PAGE, '1706.03762');
    assert.equal(paper.arxivId, '1706.03762');
  });

  it('HTML 实体还原：&amp; / &#39; / &quot; 原样进标题', () => {
    const page = `<meta name="citation_title" content="Harness &amp; Co: it&#39;s &quot;open&quot;">`;
    assert.equal(paperFromAlphaXivHtml(page, '2611.x-y').title, 'Harness & Co: it\'s "open"');
  });

  it('属性顺序反过来（content 在前）也取得到', () => {
    const page = '<meta content="Reversed Order Title" name="citation_title">';
    assert.equal(paperFromAlphaXivHtml(page, '2611.x-y').title, 'Reversed Order Title');
  });
});

describe('检索词与查询计划', () => {
  it('去停用词、去单字符、去重、保序', () => {
    assert.deepEqual(queryTokens('Harness^2: Recursive Agent Harnessing for an Open World'),
      ['harness', 'recursive', 'agent', 'harnessing', 'open', 'world']);
    assert.deepEqual(queryTokens('the of and in'), []);
    assert.deepEqual(queryTokens(''), []);
  });

  it('短语保留停用词（去掉 `for` 就不再是标题里那串字）', () => {
    assert.equal(queryPhrase('Sparse Routing for Long Documents'), 'sparse routing for long documents');
    assert.equal(queryPhrase('  "ATTENTION IS ALL YOU NEED"  '), 'attention is all you need');
    assert.equal(queryPhrase('Harness^2: Recursive'), 'harness 2 recursive');
    // 一整段摘要进来时截断，免得白跑一次必然 0 条（还撞限流）的查询。
    assert.equal(queryPhrase('x'.repeat(300)).length, 140);
    assert.equal(queryPhrase('!!!'), '');
  });

  it('★ 第一档是标题短语，第二档是逐词 AND；**任何一档都不是裸 `all:` 多词**', () => {
    // 裸 `all:` 多词在 arXiv 上是**或**语义 —— 实测返回「DeformSmith」「WizardLM」
    // 「Zero-Shot Sign Language」这类只沾一个词的论文，就是用户说的「太笼统」。
    const plan = arxivQueryPlan('Language Model Harnesses Can Be Compositional Generalizers');
    assert.equal(plan[0].query, 'ti:"language model harnesses can be compositional generalizers"');
    assert.equal(plan[0].abstractOk, false);
    // 第二档去掉停用词（`can` / `be`），否则一个 `be` 就把命中面缩掉一大半。
    assert.equal(plan[1].query, 'all:language AND all:model AND all:harnesses AND all:compositional AND all:generalizers');
    assert.equal(plan[1].abstractOk, true);
    for (const tier of plan) {
      if (tier.query.startsWith('all:') && tier.query.includes(' ')) {
        assert.match(tier.query, / AND /, `出现了裸 all: 多词查询（或语义）：${tier.query}`);
      }
    }
  });

  it('单个词只发一条，且用 all:（ti: 会把大半相关论文挡掉）', () => {
    assert.deepEqual(arxivQueryPlan('harness'), [{ query: 'all:harness', abstractOk: true }]);
    assert.deepEqual(arxivQueryPlan('   '), []);
    assert.deepEqual(arxivQueryPlan('the of'), []);
  });
});

describe('检索结果筛选与排序', () => {
  const GARBAGE = [
    { key: 'a', title: 'DeformSmith: Physics Harness-Guided Hierarchical Generation of Deformable Assets for Robot Manipulation', abstract: '' },
    { key: 'b', title: 'WizardLM: Empowering large pre-trained language models to follow complex instructions', abstract: '' },
    { key: 'c', title: 'Zero-Shot Sign Language Recognition: Can Textual Data Uncover Sign Languages?', abstract: '' },
  ];
  const HIT = {
    key: 'hit',
    title: 'Language Model Harnesses Can Be Compositional Generalizers',
    abstract: 'harness',
  };

  it('★ 只沾了一个词的结果必须被筛掉（用户截图里那一屏）', () => {
    const tokens = queryTokens('Language Model Harnesses Can Be Compositional Generalizers');
    const kept = rankArxivResults([...GARBAGE, HIT], { tokens, phrase: tokens.join(' '), limit: 10 });
    assert.deepEqual(kept.map((item) => item.key), ['hit']);
    // 反向对照：不筛的话三条垃圾都在 ⇒ 证明断言不是恒真。
    assert.ok(GARBAGE.length === 3);
    for (const item of GARBAGE) assert.ok(tokenCoverage(item.title, tokens) < 1);
  });

  it('整段标题都出现的结果排在最前（哪怕它后面还有同样全中的）', () => {
    const tokens = ['compositional', 'generalizers', 'harness'];
    const items = [
      // 三个词都在，但「compositional generalizers」不是连着出现的。
      { key: 'partial', title: 'Harness Design for Compositional Tasks With Generalizers', abstract: '' },
      { key: 'exact', title: 'Compositional Generalizers Need a Harness', abstract: '' },
    ];
    const kept = rankArxivResults(items, { tokens, phrase: 'compositional generalizers', limit: 10 });
    assert.deepEqual(kept.map((item) => item.key), ['exact', 'partial']);
  });

  it('摘要里全中、标题里不全中：宽松档留，严格档丢', () => {
    const items = [{
      key: 'abs-only',
      title: 'Something Else Entirely',
      abstract: 'we study harness designs and compositional generalizers',
    }];
    const tokens = ['harness', 'compositional', 'generalizers'];
    assert.deepEqual(rankArxivResults(items, { tokens, limit: 5 }).map((item) => item.key), []);
    assert.deepEqual(
      rankArxivResults(items, { tokens, limit: 5, abstractOk: true }).map((item) => item.key),
      ['abs-only'],
    );
  });

  it('形态差异算同一个词：harness / harnesses / harnessing', () => {
    assert.equal(tokenCoverage('Designing Harnesses for Agents', ['harness']), 1);
    assert.equal(tokenCoverage('Harnessing Agents', ['harnesses']), 1);
    // 短词不放过：`ai` 不能命中 `said`。
    assert.equal(tokenCoverage('Said the model', ['ai']), 0);
  });

  it('空检索词 ⇒ 一条都不留（不把「没有词」当成全中）', () => {
    assert.deepEqual(rankArxivResults([HIT], { tokens: [], limit: 5 }), []);
  });

  it('limit 生效，且不越界', () => {
    const items = Array.from({ length: 8 }, (item, index) => ({ key: `k${index}`, title: 'harness agent', abstract: '' }));
    assert.equal(rankArxivResults(items, { tokens: ['harness', 'agent'], limit: 3 }).length, 3);
    assert.equal(rankArxivResults(items, { tokens: ['harness', 'agent'], limit: 0 }).length, 1);
  });
});

describe('接线守卫（源码级）', () => {
  it('防假阴性：三份源文件都读得到', () => {
    for (const file of ['src/host/paper-source.js', 'src/host/paper-routes.js', 'src/client/PapersApp.jsx']) {
      assert.ok(read(file).length > 2000, `${file} 读出来太短，可能是空扫`);
    }
  });

  it('路由不再自己认编号：判定只留一份（在 searchArxiv 里）', () => {
    const routes = read('src/host/paper-routes.js');
    assert.doesNotMatch(routes, /normalizeArxivId/, '路由又在自己认 arXiv 编号了 —— 两份判定必然漂移');
    assert.match(routes, /await searchArxiv\(query, \{ limit/, '路由没把检索交给 searchArxiv');
  });

  it('★ 导入的解析顺序：arXiv → alphaXiv → DOI（反了会把 alphaXiv 链接送去 Crossref）', () => {
    const source = read('src/host/paper-source.js');
    const arxiv = source.indexOf('export async function resolvePaperInput');
    const body = source.slice(arxiv, arxiv + 3000);
    const arxivAt = body.indexOf('normalizeArxivId(text)');
    const alphaAt = body.indexOf('normalizeAlphaXivSlug(text)');
    const doiAt = body.indexOf('normalizeDoi(text)');
    assert.ok(arxivAt >= 0 && alphaAt >= 0 && doiAt >= 0, '三个分支缺一个');
    assert.ok(arxivAt < alphaAt && alphaAt < doiAt, '顺序不对：必须 arXiv → alphaXiv → DOI');
  });

  it('搜索结果「导入」时用页面地址兜底（alphaXiv 没有编号，只有地址认得出来）', () => {
    const client = read('src/client/PapersApp.jsx');
    assert.match(client, /runImport\(item\.arxivId \|\| item\.doi \|\| item\.url \|\| item\.title\)/);
  });

  it('★ 用户现场：粘《Language Model Harnesses…》绝不能命中 Weak-to-Strong 那篇', () => {
    // 0.90.2 的真缺陷：旧代码取 searchArxiv 第一名，而那篇的摘要里恰好有
    // language / model / compositional，于是被当成用户要的那篇导了进来。
    const input = 'Language Model Harnesses Can Be Compositional Generalizers';
    const wrong = 'Weak-to-Strong Compositional Learning from Generative Models for Language-based Object Detection';
    assert.equal(isTitleExactMatch(input, wrong), false,
      '这篇沾了词的论文必须被拒 —— 导错比导不到糟');
    assert.equal(isTitleExactMatch(input, input), true, '原样标题当然要命中');
  });

  it('★ 双向匹配：只认「输入 ⊂ 候选」会把沾词的另一篇放进来', () => {
    const input = 'language model';
    const long = 'Language Models Are Few-Shot Learners';
    // 输入 ⊂ 候选（单向）成立，但候选里有 few-shot / learners 这些输入没说的 ⇒ 拒。
    assert.equal(isTitleExactMatch(input, long), false,
      '只做单向覆盖会误命中任意一篇更长的论文');
    assert.equal(isTitleExactMatch(long, input), false, '反过来也不能命中');
  });

  it('大小写 / 标点 / 复数 / 书名号不影响同一篇的判定', () => {
    const title = 'Language Model Harnesses Can Be Compositional Generalizers';
    assert.equal(isTitleExactMatch(`《${title}》`, title), true, '书名号要剥掉');
    assert.equal(isTitleExactMatch(title.toLowerCase(), title), true, '大小写不看');
    assert.equal(isTitleExactMatch(title.replace(/ /g, '  '), title), true, '多空格不看');
    // harness / harnesses 形态差异要容（sameWord 公共前缀 ≥5）。
    assert.equal(isTitleExactMatch('Language Model Harness Can Be Compositional Generalizer', title), true);
  });

  it('副标题 / 漏词 / 多词 ⇒ 不算同一篇（宁可报没找到，也不导错）', () => {
    const title = 'Attention Is All You Need';
    assert.equal(isTitleExactMatch('Attention Is All You Need for Translation', title), false, '多了半截副标题');
    assert.equal(isTitleExactMatch('Attention Is All', title), false, '漏了词');
    assert.equal(isTitleExactMatch('', title), false);
    assert.equal(isTitleExactMatch(title, ''), false);
  });

  it('接线：导入兜底用 isTitleExactMatch 逐条筛，不再取搜索第一名', () => {
    const src = read('src/host/paper-source.js');
    assert.match(src, /isTitleExactMatch\(text, item\.title\)/, '没有逐条做精确匹配');
    assert.doesNotMatch(src, /return found\[0\]/, '又把搜索第一名当成导入结果了');
    assert.match(src, /标题完全匹配/, '报错没说清「按标题导入要一致」');
  });

  it('两句界面提示都要出现 alphaXiv 这三个字', () => {
    const client = read('src/client/PapersApp.jsx');
    // 导入框：告诉用户「链接」可以粘哪种。
    assert.match(client, /arXiv 编号 \/ 链接、alphaXiv 页面链接、DOI/);
    // 按标题导入现在要求标题一致 —— 界面得先说清，否则用户粘个简写被拒会一头雾水。
    assert.match(client, /或者论文标题（要和原文一致）/);
    // 搜索空结果：告诉他下一步该做什么。
    assert.match(client, /只发在 alphaXiv 上（没有 arXiv 编号）的论文不在这里/);
    // 有结果但都不是他要的那篇（粘整句标题的典型处境）也要说这一句，
    // 否则「一屏差不多的论文」看起来就像「搜到了，只是不在前面」。
    assert.match(client, /只发在 alphaXiv 上（没有 arXiv 编号）的论文搜不到/);
  });
});
