/**
 * `book_*` 五个工具的**真跑**：真的注册上、真的读到落盘的解读、真的把包写出去。
 *
 * ★ 为什么必须真跑而不是断言源码里出现了 `book_chapter`：
 *   这五个工具是「逐章解读」对 agent 存在的唯一方式。它们坏掉的样子是
 *   **静默的** —— 工具没注册 ⇒ 模型永远不知道有这回事，用户只会觉得
 *   「AI 好像不知道我读过这本书」，而没有任何报错。
 *   源码字符串断言连「注册了没有」都答不了（`createToolDefinitions` 返回了
 *   不等于 `ctx.tools.register` 跑到了）。
 *
 * ★ 这里量的是**实际输出文本**：走 `output.render`，因为模型看到的是渲染结果。
 *   `execute` 返回一个对象、渲染时拼错，只有渲染这一步才跑得到。
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { bootService, disposeHarness, runTool } from './helpers/tool-harness.mjs';

after(disposeHarness);

const BOOK_ID = 'l-tools';
const CHAPTERS = [
  { n: 1, title: '第一章 起', startPage: 1, endPage: 2 },
  { n: 2, title: '第二章 承', startPage: 3, endPage: 4 },
  { n: 3, title: '第三章 转', startPage: 5, endPage: 6 },
];

/** 第 1、3 章有解读，第 2 章没有（用来测「未解读」那条路）。 */
const DIGESTS = {
  1: {
    summary: '作者把一致性、可用性、分区容忍三者的边界划清。',
    points: ['先分清问题属于哪一类', '再决定用哪种工具'],
    terms: [{ term: '一致性', note: '多副本之间的可见顺序' }],
    model: 'test-provider/test-model',
  },
  3: {
    summary: '复制策略决定了故障时谁还能继续写。',
    points: ['单主最简单但写侧有单点'],
    terms: [{ term: '复制', note: '多副本之间同步数据' }],
    model: 'test-provider/test-model',
  },
};

const BODY = '分布式系统的一致性问题是工程实践里最容易被低估的部分，它同时牵涉到时钟、网络分区与故障检测三件事。'.repeat(4);

/** 起一个 service，把目录 / 正文 / 解读都写好。`rawBody` 可覆盖某一章的正文。 */
async function bootBook({ llmChunks, settings, rawBodies } = {}) {
  const harness = await bootService({ llmChunks, ...(settings === undefined ? {} : { settings }) });
  const { service } = harness;
  await service.ready;
  const pages = [];
  for (let page = 1; page <= 6; page += 1) pages.push({ page, lines: [BODY] });
  await service.digestStore.writeOutline(BOOK_ID, CHAPTERS);
  await service.digestStore.writeChapterTexts(BOOK_ID, pages, CHAPTERS);
  for (const chapter of CHAPTERS) {
    const override = rawBodies?.[chapter.n];
    if (override !== undefined) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(service.digestStore.dirOf(BOOK_ID), 'text', `ch${String(chapter.n).padStart(2, '0')}.txt`), override, 'utf8');
    }
  }
  for (const [n, digest] of Object.entries(DIGESTS)) {
    await service.digestStore.writeDigest(BOOK_ID, Number(n), digest);
  }
  await service.digestStore.writeMeta(BOOK_ID, {
    bookId: BOOK_ID,
    bookTitle: '某本技术书',
    mode: 'toc',
    pageCount: 6,
    chapters: CHAPTERS.map((chapter) => ({
      ...chapter,
      status: DIGESTS[chapter.n] === undefined ? 'pending' : 'done',
      model: DIGESTS[chapter.n] === undefined ? '' : 'test-provider/test-model',
    })),
    task: { state: 'idle', cursor: 6 },
  });
  return harness;
}

const GOOD_SYNTHESIS = JSON.stringify({
  patterns: '全书围绕「代价」展开：一致性与可用性互相挤压（第 1、3 章）。',
  cheatsheet: '选型先问写冲突（第 3 章）；读扩展先问可见顺序（第 1 章）。',
});

describe('book_* 工具：注册', () => {
  it('★★ 五个工具都真的注册到了宿主上', async () => {
    const { tools } = await bootBook();
    for (const name of ['book_list', 'book_outline', 'book_chapter', 'book_search', 'book_export_skill']) {
      assert.ok(tools.has(name), `${name} 没有注册 —— 模型永远不会知道它存在`);
    }
    // 反向对照：名字拼错的情况必须能被这条断言抓到。
    assert.ok(!tools.has('book_read'), '不该有 book_read');
  });

  it('每个工具的 parameters 都是合法 JSON Schema（type: object）', async () => {
    const { tools } = await bootBook();
    for (const name of ['book_list', 'book_outline', 'book_chapter', 'book_search', 'book_export_skill']) {
      const schema = tools.get(name).parameters;
      assert.equal(schema.type, 'object', `${name} 的 parameters 缺 type: object`);
      assert.equal(typeof schema.properties, 'object');
    }
    // 必填项要真的标出来：模型靠它决定能不能省略。
    assert.deepEqual(tools.get('book_chapter').parameters.required, ['bookId', 'n']);
    assert.deepEqual(tools.get('book_list').parameters.required, undefined);
  });
});

describe('book_list / book_outline', () => {
  it('book_list 列出有解读的书，并把「已解读/总数」分开写', async () => {
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_list');
    assert.match(out, new RegExp(BOOK_ID));
    assert.match(out, /2\/3 章已解读/);
    // ★ 「略过 / 失败 / 待生成」必须分开：把待生成算成已解读，用户会以为能问这本书了。
    assert.match(out, /待生成 1/);
    assert.ok(!out.includes('正在生成中'));
  });

  it('没有任何解读时，book_list 说清楚该怎么办（而不是空输出）', async () => {
    const { tools, service } = await bootBook();
    await service.digestStore.remove(BOOK_ID);
    const out = await runTool(tools, 'book_list');
    assert.match(out, /No book has chapter digests yet/);
    assert.match(out, /generate digests first/);
  });

  it('book_outline 给出每章状态，未解读的章明确标「未解读」', async () => {
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_outline', { bookId: BOOK_ID });
    assert.match(out, /《某本技术书》/);
    assert.match(out, /3 章/);
    assert.match(out, /已解读 2 · 略过 0 · 失败 0 · 未解读 1/);
    assert.match(out, /01 第一章 起 \| p\.1–2 \| 已解读（test-provider\/test-model）/);
    assert.match(out, /02 第二章 承 \| p\.3–4 \| 未解读/);
  });

  it('book_outline 对没抽过目录的书抛错（而不是返回空目录）', async () => {
    const { tools } = await bootBook();
    await assert.rejects(() => runTool(tools, 'book_outline', { bookId: 'l-none' }), /还没有抽取目录/);
  });
});

describe('book_chapter：默认给解读，不是原文', () => {
  it('★★ 默认返回解读，并且**自己说明**这是解读而不是原文', async () => {
    const { tools, state } = await bootBook();
    const out = await runTool(tools, 'book_chapter', { bookId: BOOK_ID, n: 1 });
    assert.match(out, /这一章是\*\*解读\*\*（不是原文）/);
    assert.match(out, /作者把一致性、可用性、分区容忍三者的边界划清/);
    assert.match(out, /\*\*一致性\*\*：多副本之间的可见顺序/);
    // ★ 关键：默认路径**不该**把原文吐出来。原文里有这句话而解读里没有。
    assert.ok(!out.includes('分布式系统的一致性问题是工程实践里最容易被低估的部分'), '默认路径把原文带出来了');
    // 也不该调模型 —— 读解读是纯磁盘操作。
    assert.equal(state.llmCalls.length, 0, '读一章解读不该调用模型');
  });

  it('未解读的章：说「还没有解读」，并告诉模型下一步怎么做', async () => {
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_chapter', { bookId: BOOK_ID, n: 2 });
    assert.match(out, /还没有解读/);
    assert.match(out, /raw: true/);
  });

  it('raw: true 才给原文，并明说这是原文', async () => {
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_chapter', { bookId: BOOK_ID, n: 1, raw: true });
    assert.match(out, /这是\*\*抽取出来的原文\*\*/);
    assert.match(out, /分布式系统的一致性问题是工程实践里最容易被低估的部分/);
    // 原文路径不该出现解读里那句话，否则说明两条路串了。
    assert.ok(!out.includes('作者把一致性、可用性、分区容忍三者的边界划清'));
  });

  it('★★ 原文超过 20000 字 ⇒ 截断，并且**明说截断了多少**', async () => {
    // 悄悄截断时模型会把「后面没给」读成「后面没有」，然后替后半本书下结论。
    const long = '这是一段用来撑长度的正文。'.repeat(1600); // 约 20800 字
    const { tools } = await bootBook({ rawBodies: { 1: long } });
    const out = await runTool(tools, 'book_chapter', { bookId: BOOK_ID, n: 1, raw: true });
    assert.match(out, /已截断/);
    assert.match(out, new RegExp(`原文共 ${long.length} 字`));
    assert.match(out, /只给了前 20000 字/);
    assert.match(out, /不要据此推断后半部分的内容/);
    // 反向对照：短正文不该出现这句话。
    const short = await bootBook();
    const shortOut = await runTool(short.tools, 'book_chapter', { bookId: BOOK_ID, n: 1, raw: true });
    assert.ok(!shortOut.includes('已截断'));
  });

  it('章节号非法 / 不存在 ⇒ 抛错，不返回空内容', async () => {
    const { tools } = await bootBook();
    await assert.rejects(() => runTool(tools, 'book_chapter', { bookId: BOOK_ID, n: 99 }), /没有第 99 章/);
    await assert.rejects(() => runTool(tools, 'book_chapter', { bookId: BOOK_ID, n: 0 }), /正整数/);
    await assert.rejects(() => runTool(tools, 'book_chapter', { bookId: BOOK_ID, n: 'x' }), /正整数/);
  });
});

describe('book_search：在解读里检索，不是原文', () => {
  it('跨章命中，报出「哪本书第几章 · 命中的字段」', async () => {
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_search', { query: '一致性' });
    assert.match(out, /命中 1 章/);
    assert.match(out, new RegExp(`${BOOK_ID} 第 1 章 第一章 起`));
    assert.match(out, /在 2 章解读里检索/);
    // 命中的是解读里的字段，不是原文。
    assert.match(out, /摘要：/);
  });

  it('★ 子串匹配：搜一个只出现在术语里的词 ⇒ 命中字段报「术语」', async () => {
    // ★ 用「只出现在术语里」的词，不能用「复制」—— 那个词在摘要里先出现，
    //   而同一章只报第一处命中（够定位就行）。这正是这条断言要钉的行为：
    //   `where` 报的是**真正命中的那个字段**，不是随便一个。
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_search', { query: '同步数据' });
    assert.match(out, /第 3 章/);
    assert.match(out, /术语：/);
    // 反向对照：摘要里的词报「摘要」，不会一律报「术语」。
    const bySummary = await runTool(tools, 'book_search', { query: '单点' });
    assert.match(bySummary, /要点：/);
  });

  it('没有命中时说「没命中」并给出下一步（不返回空串）', async () => {
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_search', { query: '不存在的词' });
    assert.match(out, /没有解读提到/);
    assert.match(out, /book_list/);
  });

  it('空 query 抛错', async () => {
    const { tools } = await bootBook();
    await assert.rejects(() => runTool(tools, 'book_search', { query: '   ' }), /query 不能为空/);
  });

  it('★ limit 生效：截断时明说「结果可能不全」', async () => {
    // 触顶不说，模型会把它当成「全书只有这一章提到」。
    const { tools } = await bootBook();
    const all = await runTool(tools, 'book_search', { query: '副本' });
    assert.match(all, /命中 2 章/);
    assert.ok(!all.includes('可能不全'), '没触顶却说了可能不全');

    const one = await runTool(tools, 'book_search', { query: '副本', limit: 1 });
    assert.match(one, /命中 1 章/);
    assert.match(one, /已达上限，结果可能不全/);
  });
});

describe('book_export_skill：写出一个真的能被别人用的目录', () => {
  it('★★ 不调模型也能导出，且真的在磁盘上留下了那五个文件', async () => {
    const { tools, state } = await bootBook();
    const out = await runTool(tools, 'book_export_skill', { bookId: BOOK_ID });
    assert.equal(state.llmCalls.length, 0, '默认导出不该调用模型');
    assert.match(out, /导出完成/);
    assert.match(out, /跨章综合：未做/);
    assert.match(out, /原样摘录/);

    const dir = /导出完成：(.+)/.exec(out)[1].trim();
    // 五个文件 + 三章，逐个 stat 一遍 —— 「返回里说写了」不等于「盘上有」。
    for (const name of ['SKILL.md', 'glossary.md', 'patterns.md', 'cheatsheet.md', 'skill.json']) {
      const info = await stat(join(dir, name)).catch(() => null);
      assert.ok(info?.isFile() === true, `${name} 没有落盘`);
    }
    for (const n of ['01', '02', '03']) {
      const info = await stat(join(dir, 'chapters', `ch${n}.md`)).catch(() => null);
      assert.ok(info?.isFile() === true, `chapters/ch${n}.md 没有落盘`);
    }
    // 索引层要能读到章标题，否则这个包对 agent 没用。
    const skill = await readFile(join(dir, 'SKILL.md'), 'utf8');
    assert.match(skill, /第三章 转/);
    assert.match(skill, /（未解读）/);
  });

  it('★ 目录名从书名来，且落在插件数据目录里（不往仓库外写）', async () => {
    const { tools, service } = await bootBook();
    const out = await runTool(tools, 'book_export_skill', { bookId: BOOK_ID });
    const dir = /导出完成：(.+)/.exec(out)[1].trim();
    // 书名是中文 ⇒ 回退成 book-<id>。
    assert.equal(dir, join(service.digestStore.skillsDir, `book-${BOOK_ID.replace(/[^A-Za-z0-9]/g, '')}`));
    assert.ok(dir.startsWith(service.digestStore.skillsDir));
  });

  it('★★ 重新导出会清掉上一次的残留章文件', async () => {
    // 不清的话，上一次（章更多）的 ch04.md 会留在包里，而索引里没有它 ——
    // 一个只增不减的包，最坏是「同一本书两个版本的解读混在一起」。
    const { tools, service } = await bootBook();
    const first = await runTool(tools, 'book_export_skill', { bookId: BOOK_ID });
    const dir = /导出完成：(.+)/.exec(first)[1].trim();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'chapters', 'ch99.md'), '# 上次的残骸\n', 'utf8');
    assert.ok((await stat(join(dir, 'chapters', 'ch99.md'))).isFile());

    await runTool(tools, 'book_export_skill', { bookId: BOOK_ID });
    const stale = await stat(join(dir, 'chapters', 'ch99.md')).catch(() => null);
    assert.equal(stale, null, '上次的残骸还留在包里');
    // 该在的还在。
    assert.ok((await stat(join(dir, 'chapters', 'ch01.md'))).isFile());
  });

  it('★ 显式指定 profile ⇒ 横向两页按那个书型组织，且依据写明「显式指定」', async () => {
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_export_skill', { bookId: BOOK_ID, profile: 'fiction' });
    assert.match(out, /书型：fiction/);
    assert.match(out, /由调用方显式指定/);
    const dir = /导出完成：(.+)/.exec(out)[1].trim();
    const patterns = await readFile(join(dir, 'patterns.md'), 'utf8');
    assert.match(patterns, /作者的写法与叙事手法/);
    assert.match(patterns, /叙述视角与人称/);
  });

  it('★ auto 会按正文猜书型，并把依据写出来', async () => {
    // 这份正文是纯论述（无代码、无引号）⇒ nonfiction。
    const { tools } = await bootBook();
    const out = await runTool(tools, 'book_export_skill', { bookId: BOOK_ID, profile: 'auto' });
    assert.match(out, /书型：nonfiction/);
    assert.match(out, /均低于阈值/);
  });

  it('synthesize: true ⇒ 调一次模型，横向两页变成综合结果', async () => {
    const { tools, state } = await bootBook({
      llmChunks: () => [{ type: 'text-delta', text: GOOD_SYNTHESIS }, { type: 'finish', reason: { kind: 'stop' } }],
    });
    const out = await runTool(tools, 'book_export_skill', { bookId: BOOK_ID, synthesize: true });
    assert.equal(state.llmCalls.length, 1, '跨章综合应该只调一次模型');
    assert.match(out, /跨章综合：已做/);
    assert.ok(!out.includes('原样摘录'));
    const dir = /导出完成：(.+)/.exec(out)[1].trim();
    const patterns = await readFile(join(dir, 'patterns.md'), 'utf8');
    assert.match(patterns, /全书围绕「代价」展开/);
    // 反向对照：综合过的文件不该再自称摘录。
    assert.ok(!patterns.includes('原样摘录'));
  });

  it('★★ 综合失败（模型吐垃圾）⇒ 导出仍然成功，退回摘录并说明原因', async () => {
    // 这一步失败不该让整次导出白费：SKILL.md / chapters / glossary 都是好的。
    const { tools } = await bootBook({
      llmChunks: () => [{ type: 'text-delta', text: '抱歉，我不能这么做。' }, { type: 'finish', reason: { kind: 'stop' } }],
    });
    const out = await runTool(tools, 'book_export_skill', { bookId: BOOK_ID, synthesize: true });
    assert.match(out, /导出完成/);
    assert.match(out, /跨章综合：未做/);
    assert.match(out, /⚠ 跨章综合失败/);
    assert.match(out, /没有返回可解析的 JSON/);
    const dir = /导出完成：(.+)/.exec(out)[1].trim();
    const patterns = await readFile(join(dir, 'patterns.md'), 'utf8');
    assert.match(patterns, /原样摘录/);
  });

  it('一章解读都没有 ⇒ 抛错并指路（不产出空包）', async () => {
    const { tools, service } = await bootBook();
    await service.digestStore.remove(BOOK_ID);
    await service.digestStore.writeOutline(BOOK_ID, CHAPTERS);
    await service.digestStore.writeMeta(BOOK_ID, {
      bookId: BOOK_ID, bookTitle: '某本技术书', mode: 'toc', pageCount: 6, chapters: [],
    });
    await assert.rejects(
      () => runTool(tools, 'book_export_skill', { bookId: BOOK_ID }),
      /还没有任何一章生成过解读/,
    );
  });

  it('非法 profile / 模型 ⇒ 抛错，而不是悄悄兜底成别的书型', async () => {
    const { tools } = await bootBook();
    await assert.rejects(
      () => runTool(tools, 'book_export_skill', { bookId: BOOK_ID, profile: 'poetry' }),
      /profile 只能是/,
    );
    await assert.rejects(
      () => runTool(tools, 'book_export_skill', { bookId: BOOK_ID, model: 'not-a-model' }),
      /provider\/model/,
    );
  });
});
