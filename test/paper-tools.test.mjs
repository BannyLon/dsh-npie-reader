/**
 * `paper_*` 五个工具的**真跑**：真的注册上、真的读到落盘的论文库、真的渲染成文本。
 *
 * ★ 与 `book-tools.test.mjs` 同一条理由：工具坏掉是**静默的** —— 没注册上，模型
 *   就永远不知道有这个能力，用户只会觉得「AI 好像不知道我存了论文」。源码里
 *   出现 `paper_list` 这几个字证明不了任何事（`createToolDefinitions` 返回了，
 *   不等于 `ctx.tools.register` 跑到了）。所以这里走 `runTool`，量**渲染后的文本**。
 *
 * ★ 全部用例**不联网**：`paper_import` 只测入参校验那条路（空输入 / 已注册）。
 *   真去弹 arXiv 会让这套测试在断网 CI 上红，而它守的是「工具面接对了没有」，
 *   不是「arXiv 今天在不在」。
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { bootService, disposeHarness, runTool } from './helpers/tool-harness.mjs';

after(disposeHarness);

const ATTENTION = {
  key: 'arxiv:1706.03762',
  source: 'arxiv',
  arxivId: '1706.03762',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer'],
  abstract: 'The dominant sequence transduction models are based on complex recurrent networks.',
  year: 2017,
  venue: '',
  categories: ['cs.CL'],
  tags: ['transformer', 'nmt'],
};

const BERT = {
  key: 'arxiv:1810.04805',
  source: 'arxiv',
  arxivId: '1810.04805',
  title: 'BERT: Pre-training of Deep Bidirectional Transformers',
  authors: ['Jacob Devlin'],
  abstract: 'We introduce a new language representation model.',
  year: 2019,
  venue: '',
  categories: ['cs.CL'],
  tags: ['transformer', 'pretraining'],
};

/** 刻意**没有**摘要、也没有全文：用来测「没有摘要」与「无全文」两条提示。 */
const BARE = {
  key: 'doi:10.1145/3292500.3330701',
  source: 'doi',
  doi: '10.1145/3292500.3330701',
  title: 'Deep Learning for Sequential Recommendation',
  authors: [],
  year: 0,
  venue: 'KDD',
  tags: [],
};

async function seed() {
  const harness = await bootService();
  const { service } = harness;
  await service.ready;
  await service.paperStore.ready;
  for (const draft of [ATTENTION, BERT, BARE]) await service.paperStore.upsert(draft);
  return harness;
}

describe('paper_* 工具', () => {
  it('五个工具都注册上了（少一个 = 模型根本不知道有这个能力）', async () => {
    const { tools } = await bootService();
    for (const name of ['paper_list', 'paper_search', 'paper_import', 'paper_abstract', 'paper_related']) {
      assert.ok(tools.get(name) !== undefined, `没有注册 ${name}`);
    }
  });

  it('paper_list：列出条目、标出「没有全文」、给出下一步工具名', async () => {
    const { tools } = await seed();
    const out = await runTool(tools, 'paper_list');
    assert.match(out, /Attention Is All You Need/);
    assert.match(out, /BERT: Pre-training/);
    // 三篇都没有 PDF（种子只写了元数据）⇒ 必须有这句提醒，否则模型会以为能直接读。
    assert.match(out, /没有全文/);
    assert.match(out, /paper_abstract/);
  });

  it('paper_list：按标签筛（大小写不敏感），筛空时给的是「换个条件」而不是「库是空的」', async () => {
    const { tools } = await seed();
    const hit = await runTool(tools, 'paper_list', { tag: 'TRANSFORMER' });
    assert.match(hit, /Attention Is All You Need/);
    assert.match(hit, /BERT/);
    assert.doesNotMatch(hit, /Deep Learning for Sequential/);

    const empty = await runTool(tools, 'paper_list', { tag: '不存在的标签' });
    assert.match(empty, /没有符合当前条件/);
    assert.doesNotMatch(empty, /论文库还是空的/);
  });

  it('paper_list：库里真的空时，说的是「怎么导入」而不是「没有符合条件的」', async () => {
    const { tools } = await bootService();
    const out = await runTool(tools, 'paper_list');
    assert.match(out, /论文库还是空的/);
    assert.match(out, /arXiv/);
  });

  it('paper_search：命中摘要并给片段；搜不到时明确说找过哪些字段', async () => {
    const { tools } = await seed();
    const hit = await runTool(tools, 'paper_search', { query: 'recurrent networks' });
    assert.match(hit, /Attention Is All You Need/);
    // 片段要带上下文，且**从词边界起步**（不能是「…ransduction」那种半个单词）。
    assert.match(hit, /transduction models are based/);
    assert.doesNotMatch(hit, /…ransduction/);

    const miss = await runTool(tools, 'paper_search', { query: '量子纠缠' });
    assert.match(miss, /没有提到/);
    assert.match(miss, /标签/);
  });

  it('paper_search：空查询被挡住（空串会匹配一切，那样答案就是假的）', async () => {
    const { tools } = await seed();
    const out = await runTool(tools, 'paper_search', { query: '   ' });
    assert.match(out, /需要一个查询词/);
  });

  it('paper_abstract：给标题、作者、venue、摘要；没有摘要时说清怎么补', async () => {
    const { tools, service } = await seed();
    const [attention] = service.paperStore.list().filter((paper) => paper.arxivId === '1706.03762');
    const out = await runTool(tools, 'paper_abstract', { paperId: attention.id });
    assert.match(out, /Attention Is All You Need/);
    assert.match(out, /Ashish Vaswani/);
    assert.match(out, /dominant sequence transduction/);

    const [bare] = service.paperStore.list().filter((paper) => paper.venue === 'KDD');
    const out2 = await runTool(tools, 'paper_abstract', { paperId: bare.id });
    assert.match(out2, /没有存摘要/);
    assert.match(out2, /补全元数据/);
  });

  it('paper_related：按同标签 / 同分类排序，排除自己', async () => {
    const { tools, service } = await seed();
    const [attention] = service.paperStore.list().filter((paper) => paper.arxivId === '1706.03762');
    const out = await runTool(tools, 'paper_related', { paperId: attention.id });
    assert.match(out, /BERT/);
    assert.doesNotMatch(out, /与「Attention Is All You Need」相关的 \d+ 篇：\n\n- [^\n]*Attention Is All You Need/);
  });

  it('paper_related：库里只有自己时，说的是「多打几个标签」而不是「没有相关论文」', async () => {
    const { tools, service } = await bootService();
    await service.ready;
    await service.paperStore.ready;
    const { paper } = await service.paperStore.upsert(ATTENTION);
    const out = await runTool(tools, 'paper_related', { paperId: paper.id });
    assert.match(out, /多打几个标签/);
    assert.doesNotMatch(out, /相关的 0 篇/);
  });

  it('paper_import：空输入被挡住（不然会拿空串去搜 arXiv）', async () => {
    const { tools } = await bootService();
    const out = await runTool(tools, 'paper_import', { input: '  ' });
    assert.match(out, /需要一个 arXiv 编号、DOI 或标题/);
  });
});
