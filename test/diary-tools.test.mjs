/**
 * 日记的五个工具（`diary_today` / `diary_append` / `diary_update` / `diary_delete` /
 * `diary_search`）**真跑**。
 *
 * ★ 为什么必须真跑而不是断言源码里出现了 `diary_append`：
 *   工具坏掉的样子是**静默的** —— 没注册上 ⇒ 模型永远不知道有这回事，用户只会
 *   觉得「AI 好像不知道我写过日记」，全程没有任何报错。源码字符串断言连
 *   「注册了没有」都答不了（`createToolDefinitions` 返回了，不等于
 *   `ctx.tools.register` 跑到了）。
 *
 * ★ 这里量的是**渲染出来的文本**（走 `output.render`），因为模型看到的就是它。
 *
 * ★ `diary_append` 必须自称「只追加」，这句不能删：它挡的是「把打磨后的整篇再追加
 *   一遍」，用户第二天打开会看到两篇几乎一样的日记、分不清哪篇是原稿。
 *   但「只追加」不等于「没有别的路」—— 0.35 起 `diary_update` / `diary_delete`
 *   就是那条路，描述里必须互相指向（用户 2026-10-27：「我需要的是能改能删」）。
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
  it('五个工具都注册上了', () => {
    for (const name of [
      TOOL_NAMES.diaryToday, TOOL_NAMES.diaryAppend, TOOL_NAMES.diaryUpdate,
      TOOL_NAMES.diaryDelete, TOOL_NAMES.diarySearch,
    ]) {
      assert.ok(tools.get(name), `工具没注册：${name}`);
    }
  });

  it('★ 名字就是文档里承诺的那五个（改名字会让 skill 里写的调用全部失效）', () => {
    assert.equal(TOOL_NAMES.diaryToday, 'diary_today');
    assert.equal(TOOL_NAMES.diaryAppend, 'diary_append');
    assert.equal(TOOL_NAMES.diaryUpdate, 'diary_update');
    assert.equal(TOOL_NAMES.diaryDelete, 'diary_delete');
    assert.equal(TOOL_NAMES.diarySearch, 'diary_search');
  });

  it('★ 改写 / 删除**存在**，且没有第二个别名（0.35 推翻了 0.34 的「靠不存在来保证」）', () => {
    // 用户 2026-10-27：「AI 整理为什么只能往灵感里追加新条目，不能改也不能删。
    // 我需要的是能改能删」。所以这条判据从「必须不存在」反过来了 ——
    // 保留的意义是：**只能有一个名字**。多出一个 diary_edit / diary_rewrite 之类的
    // 别名，模型会在两个之间挑，而两条路的实现迟早不一致。
    assert.ok(tools.get('diary_update'), 'diary_update 不见了');
    assert.ok(tools.get('diary_delete'), 'diary_delete 不见了');
    for (const alias of ['diary_edit', 'diary_rewrite', 'diary_remove', 'diary_modify']) {
      assert.equal(tools.get(alias), undefined, `不该存在的别名：${alias}`);
    }
  });

  it('★ 每个工具的说明都写明了自己的写权限', () => {
    const append = tools.get('diary_append');
    // 「只追加」这句**必须还在** —— 它挡的是「把改稿再追加一遍」那种重复。
    assert.match(append.description, /ONLY appends/);
    assert.match(append.description, /never edits or deletes/);
    // 但它不能再让模型以为「没有别的路」：描述里必须指向真正能改的那个工具。
    assert.match(append.description, /diary_update/);
    assert.match(tools.get('diary_update').description, /IN PLACE/);
    assert.match(tools.get('diary_update').description, /destructive/);
    assert.match(tools.get('diary_delete').description, /cannot be undone/);
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
      source: '《示例书名》第 3 章',
    });
    const out = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.match(out, /读后感/);
    assert.match(out, /引自 《示例书名》第 3 章/);
  });

  it('★ 老类型「书摘」不能被**新建**，而且回执必须**说出来**', async () => {
    /**
     * ★ 这条用例原本写的是 `kind: '书摘'` 并断言读回来含「书摘」—— 那是 0.30.0 的语义。
     *   0.31.0 把「书摘」降级成 `LEGACY_KINDS`（只解析、不再新建，见 `src/diary-format.js`
     *   第 30–37 行），这条用例从那之后就一直是红的，直到 0.32.0 交接时才发现。
     *
     * ★ 现在钉住的是**新语义**：老类型读得回来，但新建不出来。
     *   判据取「整个今天都不含书摘」—— 上面两条用例用的是默认类型（灵感），
     *   所以这里出现「书摘」只可能来自这一次 append。
     *
     * ★ 0.40 补上：回落**不许静默**。原来 `assertEntryInput` 兜成「灵感」而回执不提，
     *   模型于是可能对用户说「我记成书摘了」，文件里却是灵感 —— 一句确定的假话。
     *   现在 `append()` 回 `kindFellBack`，`diary_append` 的回执里点名三件事：
     *   你给的类型不认识 / 按什么存了 / 复述时别说是原来那个。
     */
    const out = await runTool(tools, TOOL_NAMES.diaryAppend, { body: '一句金句', kind: '书摘' });
    assert.match(out, /「书摘」不认识/, '回执没说你给的类型不认识 —— 模型会以为存成了书摘');
    assert.match(out, /按「灵感」存下/, '回执没说出实际存成了什么');
    assert.match(out, /不要说是「书摘」/, '回执没有拦住「复述时照旧说法」这条路');
    const today = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.doesNotMatch(today, /书摘/);
  });

  it('★ 反向对照：类型认识时**不许**冒出那句回落提示', async () => {
    // 否则每一条都带一句「类型不认识」，模型会开始忽略它 —— 提示也就失效了。
    const out = await runTool(tools, TOOL_NAMES.diaryAppend, { body: '正常一条', kind: '日记' });
    assert.doesNotMatch(out, /不认识/);
    // 不传 kind 走默认值，同样不该触发：默认值不是「用户给了个错值」。
    const fallback = await runTool(tools, TOOL_NAMES.diaryAppend, { body: '默认类型' });
    assert.doesNotMatch(fallback, /不认识/);
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

describe('diary_update / diary_delete', () => {
  /** 读现在这一天有几条。测试之间共享同一个 store，所以条数一律现读现算。 */
  async function count() {
    const text = await runTool(tools, TOOL_NAMES.diaryToday, {});
    const hit = /共 (\d+) 条/.exec(text);
    if (!hit) return 0;
    return Number(hit[1]);
  }

  it('改写是**原地替换**：条数不变，原文不见了', async () => {
    await runTool(tools, TOOL_NAMES.diaryAppend, { body: '要被改掉的原稿' });
    const before = await count();
    const index = before - 1;
    const out = await runTool(tools, TOOL_NAMES.diaryUpdate, { index, body: '改过之后的稿子' });
    assert.match(out, /已改写/);
    assert.match(out, /原文已被替换/, '回执照抄「另存了一份」会让模型以为原文还在');
    const after = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.match(after, /改过之后的稿子/);
    assert.equal(after.includes('要被改掉的原稿'), false, '原文还在 —— 那不是改写，是又抄了一份');
    assert.match(after, new RegExp(`共 ${before} 条`), '改写不该改变条数');
  });

  it('★ 空正文不写进去，并指向 diary_delete（不许用改写清空一条日记）', async () => {
    const out = await runTool(tools, TOOL_NAMES.diaryUpdate, { index: 0, body: '   ' });
    assert.match(out, /diary_delete/);
  });

  it('★ 删除是**少一条**，被删的那条读不回来了', async () => {
    await runTool(tools, TOOL_NAMES.diaryAppend, { body: '这条马上会被删掉' });
    const before = await count();
    const index = before - 1;
    const out = await runTool(tools, TOOL_NAMES.diaryDelete, { index });
    assert.match(out, /已删掉/);
    const after = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.equal(after.includes('这条马上会被删掉'), false, '删了还在：模型会再删一次，把别的条目删掉');
    assert.match(after, new RegExp(`共 ${before - 1} 条`));
  });

  it('★ diary_today 必须把**从 0 开始**的编号印在每条前面（改 / 删都靠它）', async () => {
    const text = await runTool(tools, TOOL_NAMES.diaryToday, {});
    assert.match(text, /\[0\]/, '编号没印出来，模型只能自己数 —— 差一位就改错条目');
    assert.match(text, /从 0 开始/);
  });
});
