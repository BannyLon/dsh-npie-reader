/**
 * 日记的三个工具（`diary_today` / `diary_append` / `diary_search`）**真跑**。
 *
 * ★ 为什么必须真跑而不是断言源码里出现了 `diary_append`：
 *   工具坏掉的样子是**静默的** —— 没注册上 ⇒ 模型永远不知道有这回事，用户只会
 *   觉得「AI 好像不知道我写过日记」，全程没有任何报错。源码字符串断言连
 *   「注册了没有」都答不了（`createToolDefinitions` 返回了，不等于
 *   `ctx.tools.register` 跑到了）。
 *
 * ★ 这里量的是**渲染出来的文本**（走 `output.render`），因为模型看到的就是它。
 *
 * ★ 一条硬边界：**没有**改写 / 删除工具。`diary_append` 只追加，而这句话必须
 *   在给模型看的文本里**说清楚** —— 否则模型会把「打磨后的整篇」再追加一遍，
 *   用户第二天打开会看到两篇几乎一样的日记，且分不清哪篇是原稿。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TOOL_NAMES } from '../src/host/tools.js';
import { bootService, disposeHarness, runTool } from './helpers/tool-harness.mjs';

let tools = null;

before(async () => {
  const harness = await bootService();
  await harness.service.ready;
  tools = harness.tools;
});

after(disposeHarness);

describe('注册', () => {
  it('三个工具都注册上了', () => {
    for (const name of [TOOL_NAMES.diaryToday, TOOL_NAMES.diaryAppend, TOOL_NAMES.diarySearch]) {
      assert.ok(tools.get(name), `工具没注册：${name}`);
    }
  });

  it('★ 名字就是文档里承诺的那三个（改名字会让 skill 里写的调用全部失效）', () => {
    assert.equal(TOOL_NAMES.diaryToday, 'diary_today');
    assert.equal(TOOL_NAMES.diaryAppend, 'diary_append');
    assert.equal(TOOL_NAMES.diarySearch, 'diary_search');
  });

  it('★ 没有改写 / 删除工具（这条边界靠「不存在」来保证）', () => {
    for (const name of ['diary_delete', 'diary_edit', 'diary_update', 'diary_remove', 'diary_rewrite']) {
      assert.equal(tools.get(name), undefined, `不该存在的工具出现了：${name}`);
    }
  });

  it('★ 每个工具的说明都写明了自己的写权限', () => {
    const append = tools.get('diary_append');
    assert.match(append.description, /only ever APPENDS/);
    assert.match(append.description, /never edits or deletes/);
    // 两个读工具必须自称只读
    for (const name of ['diary_today', 'diary_search']) {
      assert.match(tools.get(name).description, /Read-only/);
    }
  });
});

describe('diary_today', () => {
  it('还没写时明说「这一天还没有日记」，并给出目录（不能编内容）', async () => {
    const out = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.match(out, /还没有日记/);
    assert.match(out, /diary/, '要告诉用户东西在哪');
    assert.match(out, /diary_append/, '要给出下一步怎么做');
  });

  it('★ 空态不能说成「你写过」—— 文本里不能出现假装有条目的迹象', async () => {
    const out = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.equal(out.includes('共 1 条'), false);
    assert.equal(out.includes('###'), false, '没有条目时不该出现条目小标题');
  });

  it('日期非法时抛错（不是静默返回空，让人以为那天没写）', async () => {
    await assert.rejects(() => runTool(tools, TOOL_NAMES.diaryToday, { date: '2026-13-45' }), (error) => error.code === 'BAD_DATE');
  });
});

describe('diary_append', () => {
  it('写入后回执带日期、时间、序号、字数与文件路径', async () => {
    const out = await runTool(tools, TOOL_NAMES.diaryAppend, { body: '第一想法', kind: '灵感' });
    assert.match(out, /已追加到 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(out, /第 1 条/);
    assert.match(out, /\.md/, '要给出文件路径，用户才知道写在哪');
  });

  it('★ 回执里的序号必须跟着变（写错序号会让模型以为没写进去、再写一遍）', async () => {
    const second = await runTool(tools, TOOL_NAMES.diaryAppend, { body: '第二想法' });
    assert.match(second, /第 2 条/);
  });

  it('写进去的内容能在 diary_today 里读回来', async () => {
    const out = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.match(out, /第一想法/);
    assert.match(out, /第二想法/);
    assert.match(out, /共 2 条/);
  });

  it('★ 读回来的文本必须声明「这是用户自己写的原文」（否则模型会当成自己写的去改写）', async () => {
    const out = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.match(out, /用户自己写的原文/);
    assert.match(out, /不要改写/);
  });

  it('类型与来源写进标题（这是用户日后知道「这条在说哪本书」的唯一线索）', async () => {
    await runTool(tools, TOOL_NAMES.diaryAppend, {
      body: '划线一句',
      kind: '读后感',
      source: '《被讨厌的勇气》第 3 章',
    });
    const out = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.match(out, /读后感/);
    assert.match(out, /引自 《被讨厌的勇气》第 3 章/);
  });

  it('★ 老类型「书摘」不能被**新建**：传它会落成别的类型，而不是复活一个已废弃的类型', async () => {
    /**
     * ★ 这条用例原本写的是 `kind: '书摘'` 并断言读回来含「书摘」—— 那是 0.30.0 的语义。
     *   0.31.0 把「书摘」降级成 `LEGACY_KINDS`（只解析、不再新建，见 `src/diary-format.js`
     *   第 30–37 行），这条用例从那之后就一直是红的，直到 0.32.0 交接时才发现。
     *
     * ★ 现在钉住的是**新语义**：老类型读得回来，但新建不出来。
     *   判据取「整个今天都不含书摘」—— 上面两条用例用的是默认类型（灵感），
     *   所以这里出现「书摘」只可能来自这一次 append。
     *
     * ★ 已知缺口（交接文档 P1）：这个回落是**静默**的 —— `assertEntryInput` 里
     *   `ENTRY_KINDS.includes(kind) ? kind : '灵感'`，模型传了「书摘」会得到「灵感」，
     *   而回执里不说。模型于是可能对用户说「我记成书摘了」，而文件里是灵感。
     *   要修就在 `tools.js` 的 `diary_append` 回执里加一句「你给的类型不认识，已按灵感存」，
     *   并给那句话配一条用例。这里**不**顺手改，因为它动的是模型可见的措辞。
     */
    await runTool(tools, TOOL_NAMES.diaryAppend, { body: '一句金句', kind: '书摘' });
    const out = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.doesNotMatch(out, /书摘/);
  });

  it('空正文被拒（EMPTY_ENTRY）', async () => {
    await assert.rejects(
      () => runTool(tools, TOOL_NAMES.diaryAppend, { body: '   ' }),
      (error) => error.code === 'EMPTY_ENTRY',
    );
  });

  it('超长被拒（ENTRY_TOO_LARGE）', async () => {
    await assert.rejects(
      () => runTool(tools, TOOL_NAMES.diaryAppend, { body: 'x'.repeat(20_001) }),
      (error) => error.code === 'ENTRY_TOO_LARGE',
    );
  });
});

describe('diary_search', () => {
  it('中文短查询能命中（不切词）', async () => {
    await runTool(tools, TOOL_NAMES.diaryAppend, { body: '今天在琢磨磨坊主妇那个故事' });
    const out = await runTool(tools, TOOL_NAMES.diarySearch, { query: '磨坊' });
    assert.match(out, /命中 1 条/);
    assert.match(out, /磨坊主妇/);
    assert.match(out, /\d{4}-\d{2}-\d{2}/, '要给出日期，否则模型没法再定位');
  });

  it('★ 搜不到时明说「没有」+ 说明只看了最近多少天（不能让人读成「日记里就这么多」）', async () => {
    const out = await runTool(tools, TOOL_NAMES.diarySearch, { query: '这个词一定不存在zzz' });
    assert.match(out, /没有提到/);
    assert.match(out, /最近 \d+ 天/);
  });

  it('★ 空查询不能说成「日记里一篇都没有」（这是两个完全不同的原因）', async () => {
    const out = await runTool(tools, TOOL_NAMES.diarySearch, { query: '' });
    assert.match(out, /需要一个查询词/);
    assert.equal(out.includes('一篇都没有'), false, '空查询被误报成「日记是空的」');
  });

  it('提示了下一步怎么读全文（模型不该在这里猜）', async () => {
    const out = await runTool(tools, TOOL_NAMES.diarySearch, { query: '磨坊' });
    assert.match(out, /diary_today/);
  });
});
