/**
 * 读后感一键提纲的输入与解析（0.88.0）。
 *
 * 这两条是纯函数，也是这个功能唯一能「不调模型就测」的部分。它们各自守着一类
 * **不报错**的缺陷：
 *
 *  - `buildOutlineInput()`：预算。章太多 / 划线太长时模型会突然变傻，或者一次调用
 *    花掉几毛钱。两种都不会抛错。反过来，预算写得太狠（比如只给 3 章）会让提纲
 *    只覆盖书的开头，看起来「AI 没读完」。
 *  - `parseOutline()`：半成品。一个 `##` 的提纲插进正文，用户看到的是一个孤零零的
 *    小标题，而他以为「这本书只有这么多可写」。所以判据是**至少两个**小标题。
 *
 * ★ 每条正向断言都配一条反向对照：只测「该进来的进来了」，不测「不该进来的没进来」，
 *   一个「把所有东西都塞进去」的实现也能全绿。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OUTLINE_LIMITS, OUTLINE_SYSTEM_PROMPT, buildOutlineInput, parseOutline,
} from '../src/host/reflection-outline.js';

describe('0.88.0：提纲输入', () => {
  it('书名、作者、章节、划线都进来', () => {
    const built = buildOutlineInput({
      bookTitle: '信任的代价',
      author: '某作者',
      chapters: [{ n: 1, title: '开端', summary: '讲了一个赌局' }, { n: 2, title: '转折' }],
      annotations: [{ quote: '信任是可以计价的', note: '想起上次合作', page: 33 }],
    });
    for (const needle of ['信任的代价', '某作者', '第 1 章 开端', '讲了一个赌局', '第 2 章 转折', '信任是可以计价的', '第 33 页', '想起上次合作']) {
      assert.ok(built.text.includes(needle), `材料里缺了「${needle}」`);
    }
    assert.equal(built.chapters, 2);
    assert.equal(built.annotations, 1);
    assert.equal(built.truncated, false);
  });

  it('★ 没做过解读、也没划线时，明说「没有」，而不是留白', () => {
    const built = buildOutlineInput({ bookTitle: '一本新书' });
    assert.ok(built.text.includes('手边没有'), '章节缺失要写明');
    assert.ok(built.text.includes('暂时没有'), '划线缺失要写明');
    assert.equal(built.chapters, 0);
    assert.equal(built.annotations, 0);
  });

  it('★ 章节超过 40 章只取前 40 且标记 truncated（反向对照：39 章不标）', () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ n: index + 1, title: `第 ${index + 1} 节` }));
    const cut = buildOutlineInput({ bookTitle: '厚书', chapters: many });
    assert.equal(cut.chapters, OUTLINE_LIMITS.maxChapters);
    assert.equal(cut.truncated, true);
    assert.ok(!cut.text.includes('第 41 节'), '超出的章节不该进材料');

    const fits = buildOutlineInput({ bookTitle: '薄书', chapters: many.slice(0, 39) });
    assert.equal(fits.truncated, false);
  });

  it('★ 单条摘要与划线按上限截断，且截断处带省略号', () => {
    const long = '字'.repeat(400);
    const built = buildOutlineInput({
      bookTitle: '长句之书',
      chapters: [{ n: 1, title: '一', summary: long }],
      annotations: [{ quote: long, note: long }],
    });
    assert.ok(built.text.includes(`${'字'.repeat(OUTLINE_LIMITS.maxSummaryChars)}…`), '摘要没在 140 字处截断');
    assert.ok(built.text.includes(`${'字'.repeat(OUTLINE_LIMITS.maxQuoteChars)}…`), '划线没在 220 字处截断');
    // 反向对照：短内容不该被加上省略号。
    const short = buildOutlineInput({ bookTitle: '短句之书', annotations: [{ quote: '短句' }] });
    assert.ok(!short.text.includes('短句…'));
  });

  it('用户已经写的正文要带上（提纲接着它写）', () => {
    const built = buildOutlineInput({ bookTitle: '书', existing: '我读到第三章时想起自己的一次失败。' });
    assert.ok(built.text.includes('用户已经写下的内容'));
    assert.ok(built.text.includes('我读到第三章时想起自己的一次失败。'));
    // 反向对照：空正文不该出现那一段标题（否则模型会以为用户写了东西）。
    assert.ok(!buildOutlineInput({ bookTitle: '书' }).text.includes('用户已经写下的内容'));
  });

  it('章节号不是数字的条目被丢掉，不炸', () => {
    const built = buildOutlineInput({
      bookTitle: '书',
      chapters: [{ n: 'x', title: '坏条目' }, { n: 2, title: '好条目' }],
    });
    assert.equal(built.chapters, 1);
    assert.ok(built.text.includes('好条目'));
    assert.ok(!built.text.includes('坏条目'));
  });

  it('★ 提示词里必须有「不要再给通用骨架」这条（否则这个功能等于模板按钮）', () => {
    assert.ok(OUTLINE_SYSTEM_PROMPT.includes('不要再给一遍'));
    assert.ok(OUTLINE_SYSTEM_PROMPT.includes('贴着这本书'));
    assert.ok(OUTLINE_SYSTEM_PROMPT.includes('不可信的引用内容'), '缺了防注入那句');
  });
});

describe('0.88.0：提纲解析', () => {
  const good = [
    '## 一、赌局里的信任是怎么被定价的',
    '写这一节时回到第 1 章那个赌局（第 1 章）',
    '',
    '## 二、我在合作里犯过的同一个错',
    '把上次合作的失败写下来，对照你划的那句「信任是可以计价的」',
  ].join('\n');

  it('正常输出：两个以上小标题才算数', () => {
    const parsed = parseOutline(good);
    assert.ok(parsed);
    assert.equal(parsed.headings.length, 2);
    assert.equal(parsed.outline, good);
  });

  it('★ 剥掉 ```markdown 围栏（不剥的话整份提纲变成一个代码块）', () => {
    const parsed = parseOutline(`\`\`\`markdown\n${good}\n\`\`\``);
    assert.ok(parsed);
    assert.ok(!parsed.outline.includes('```'));
    assert.equal(parsed.headings.length, 2);
  });

  it('★ 剥掉第一行的客套话，但不动真正的标题', () => {
    const parsed = parseOutline(`好的，这是提纲：\n${good}`);
    assert.ok(parsed);
    assert.ok(!parsed.outline.startsWith('好的'));
    assert.ok(parsed.outline.startsWith('## 一、'));

    // 反向对照：第一行本身就是标题时不能被剥掉。
    const keep = parseOutline(good);
    assert.ok(keep.outline.startsWith('## 一、'));
  });

  it('★ 只有一个小标题 ⇒ null（半成品不插进正文）', () => {
    assert.equal(parseOutline('## 一句话总结\n\n这里是空的'), null);
    assert.equal(parseOutline('就是这样，没有结构。'), null);
    assert.equal(parseOutline(''), null);
    assert.equal(parseOutline(null), null);
    assert.equal(parseOutline(undefined), null);
  });

  it('三级标题也算（模型有时用 ### 分组）', () => {
    const parsed = parseOutline('### 甲\n写甲\n\n### 乙\n写乙');
    assert.ok(parsed);
    assert.equal(parsed.headings.length, 2);
  });

  it('小标题里的 markdown 记号被剥掉，方便界面直接当标题用', () => {
    const parsed = parseOutline('## 一、**重点**\n\n## 二、`代码`\n');
    assert.ok(parsed);
    assert.deepEqual(parsed.headings.slice(0, 2), ['一、**重点**', '二、`代码`']);
  });
});
