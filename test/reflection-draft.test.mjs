/**
 * 提纲落进正文（0.88.0）。
 *
 * 这一条测的是**唯一不可逆**的那一步：覆盖用户手打的内容没有任何地方能撤回。
 * 所以判据不是「提纲进去了」，而是「原来的字一个都没少」—— 每条正向断言都配一条
 * 「原有内容逐字包含」的断言，反过来也要有一条「空提纲不会改动正文」。
 *
 * ★ 0.88.0 定稿时补了「空模板被提纲替掉」这一支：模板与提纲都会往正文放结构，
 *   叠在一起就是两套标题（用户原话「就会让输入框里很乱」）。所以那一支必须配
 *   反向对照 —— 用户只要动过一个字，就必须回到「追加」，不能借「替换」把字吃掉。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isPristineSkeleton,
  isPristineTemplate,
  mergeOutlineIntoDraft,
  needsTemplateConfirm,
  outlinePlacement,
} from '../src/client/reflection-draft.js';
import { REFLECTION_TEMPLATE } from '../src/diary-format.js';

const OUTLINE = '## 一、赌局里的信任\n回到第 1 章\n\n## 二、我犯过的错\n对照你划的那句';

describe('0.88.0：提纲接进正文', () => {
  it('空正文 ⇒ 就是提纲（末尾补一个换行，光标落在下一行）', () => {
    assert.equal(mergeOutlineIntoDraft('', OUTLINE), `${OUTLINE}\n`);
    // 全是空白也算空：用户敲了几个回车不算「写了东西」。
    assert.equal(mergeOutlineIntoDraft('  \n\n ', OUTLINE), `${OUTLINE}\n`);
  });

  it('★ 已有正文 ⇒ 接在末尾，原有内容逐字保留', () => {
    const existing = '我先写了两段。\n\n第二段写的是那次合作。';
    const merged = mergeOutlineIntoDraft(existing, OUTLINE);
    assert.ok(merged.startsWith(existing), '原有内容被改动了');
    assert.ok(merged.includes(OUTLINE), '提纲没进去');
    assert.ok(merged.includes(`${existing}\n\n## 一、`), '中间没有空行，Markdown 会把它们并成一段');
  });

  it('★ 空提纲 ⇒ 正文原样返回（连空行都不加）', () => {
    const existing = '  写完的一段，末尾有两个换行\n\n';
    assert.equal(mergeOutlineIntoDraft(existing, ''), existing);
    assert.equal(mergeOutlineIntoDraft(existing, '   '), existing);
    assert.equal(mergeOutlineIntoDraft(existing, undefined), existing);
    assert.equal(mergeOutlineIntoDraft(existing, null), existing);
  });

  it('非字符串入参不炸（宿主可能给 null / 数字）', () => {
    assert.equal(mergeOutlineIntoDraft(null, OUTLINE), `${OUTLINE}\n`);
    assert.equal(mergeOutlineIntoDraft('已有', 123), '已有');
    assert.equal(mergeOutlineIntoDraft(undefined, undefined), '');
  });

  it('★ 连点两次 ⇒ 接两遍，除非调用方告诉它「正文就是上一份提纲」（0.89.0 起后者才是常态）', () => {
    // 老行为保留在纯函数里：不知道上一份是什么，就只能追加（宁可多一份，不删字）。
    const once = mergeOutlineIntoDraft('原文', OUTLINE);
    const twice = mergeOutlineIntoDraft(once, OUTLINE);
    assert.equal(twice.split('## 一、').length - 1, 2, '第二次把第一份覆盖了');
    assert.ok(twice.startsWith('原文'));

    // 真实调用点会传 lastOutline：正文还是那份提纲 ⇒ 换掉，不是接龙。
    const replaced = mergeOutlineIntoDraft(`${OUTLINE}\n`, OUTLINE, { lastOutline: OUTLINE });
    assert.equal(replaced, `${OUTLINE}\n`, '带 lastOutline 时没有替换 —— 用户连点两次会得到两份提纲');
  });
});

describe('0.88.0：空模板不会被提纲叠成两套结构', () => {
  it('★ 正文原封不动就是模板 ⇒ 提纲替掉它，只留一套结构', () => {
    const merged = mergeOutlineIntoDraft(REFLECTION_TEMPLATE, OUTLINE, { template: REFLECTION_TEMPLATE });
    assert.equal(merged, `${OUTLINE}\n`);
    // 模板的四个标题一个都不该剩下来 —— 留着就是两套结构（用户看到的「很乱」）。
    for (const heading of ['## 一句话总结', '## 核心收获', '## 行动指南', '## 金句摘录']) {
      assert.equal(merged.includes(heading), false, `模板标题 ${heading} 还在，两套结构叠在一起`);
    }
  });

  it('★ 反向对照：模板里动过一个字，就必须回到「追加」，一个字都不能少', () => {
    // 用户在「核心收获」下面写了半句。这是**他的字**，替换等于把它删了。
    const edited = REFLECTION_TEMPLATE.replace('## 核心收获\n', '## 核心收获\n我先写半句。\n');
    const merged = mergeOutlineIntoDraft(edited, OUTLINE, { template: REFLECTION_TEMPLATE });
    assert.ok(merged.startsWith(edited.replace(/\s+$/, '')), '动过的正文被替换掉了 —— 用户的字丢了');
    assert.ok(merged.includes(OUTLINE), '提纲没进去');
  });

  it('★ 反向对照：删掉模板里的一节也算动过（不再走替换）', () => {
    const trimmedTemplate = REFLECTION_TEMPLATE.replace('## 金句摘录', '');
    const merged = mergeOutlineIntoDraft(trimmedTemplate, OUTLINE, { template: REFLECTION_TEMPLATE });
    assert.ok(merged.includes(trimmedTemplate.trim()), '删过一节的正文被替换掉了');
  });

  it('不给 template 时行为完全不变（老调用点不受影响）', () => {
    const merged = mergeOutlineIntoDraft(REFLECTION_TEMPLATE, OUTLINE);
    assert.ok(merged.startsWith(REFLECTION_TEMPLATE.replace(/\s+$/, '')), '没给 template 却触发了替换');
  });

  it('isPristineSkeleton：首尾空白不算改动，只认逐字相同', () => {
    assert.equal(isPristineSkeleton(`\n\n${REFLECTION_TEMPLATE}\n\n`, REFLECTION_TEMPLATE), true);
    assert.equal(isPristineSkeleton(REFLECTION_TEMPLATE, REFLECTION_TEMPLATE), true);
    assert.equal(isPristineSkeleton(`${REFLECTION_TEMPLATE}x`, REFLECTION_TEMPLATE), false);
    assert.equal(isPristineSkeleton('', REFLECTION_TEMPLATE), false);
    // 空骨架 + 空正文 ⇒ 不是「原封不动的骨架」，否则替换判据会恒真。
    assert.equal(isPristineSkeleton('', ''), false);
    assert.equal(isPristineSkeleton(null, REFLECTION_TEMPLATE), false);
    // 0.88.0 的老名字还指同一个函数（调用点不用集体改口）。
    assert.equal(isPristineTemplate, isPristineSkeleton);
  });
});

/**
 * 「套用模板」会不会删掉别的东西（0.88.0 定稿／用户 2026-11-22 的第三张截图）。
 *
 * 那一轮的现场：先「生成提纲」得到四节，再点「套用模板」，正文变成
 * 提纲四节 **+** 模板四节 —— 两套并列。旧实现是「非空就追加」，追加的代价就是
 * 两套结构。现在的规矩：模板是整份骨架，正文里已经有别的东西时必须替换，而替换
 * 会删字，所以要用户再点一次。
 *
 * ★ 这条判据决定「要不要多问一次」，所以它自己必须**宁严勿松**：任何一句没把握
 *   算「干净」的正文，都必须返回 true（问一次），不能返回 false（直接删）。
 */
describe('0.88.0：套用模板要不要二次确认', () => {
  it('空正文 ⇒ 不用确认（没有东西可删，多点一次只是刁难）', () => {
    assert.equal(needsTemplateConfirm('', REFLECTION_TEMPLATE), false);
    assert.equal(needsTemplateConfirm('  \n\n ', REFLECTION_TEMPLATE), false);
    assert.equal(needsTemplateConfirm(null, REFLECTION_TEMPLATE), false);
    assert.equal(needsTemplateConfirm(undefined, REFLECTION_TEMPLATE), false);
  });

  it('正文就是原封不动的模板 ⇒ 不用确认（按钮那边已经禁用，两条路不打架）', () => {
    assert.equal(needsTemplateConfirm(REFLECTION_TEMPLATE, REFLECTION_TEMPLATE), false);
    assert.equal(needsTemplateConfirm(`\n${REFLECTION_TEMPLATE}\n\n`, REFLECTION_TEMPLATE), false);
  });

  it('★ 正文是提纲（用户现场）⇒ 必须确认', () => {
    assert.equal(needsTemplateConfirm(OUTLINE, REFLECTION_TEMPLATE), true);
  });

  it('★ 正文是手打的字 ⇒ 必须确认', () => {
    assert.equal(needsTemplateConfirm('我读完了，先说一个让我不舒服的地方。', REFLECTION_TEMPLATE), true);
  });

  it('★ 反向对照：模板里动过一个字，也必须确认（不再算「空模板」）', () => {
    const edited = REFLECTION_TEMPLATE.replace('## 核心收获\n', '## 核心收获\n半句。\n');
    assert.equal(needsTemplateConfirm(edited, REFLECTION_TEMPLATE), true);
  });

  it('★ 反向对照：模板少了一节，也必须确认', () => {
    const trimmed = REFLECTION_TEMPLATE.replace('## 金句摘录', '');
    assert.equal(needsTemplateConfirm(trimmed, REFLECTION_TEMPLATE), true);
  });
});

/**
 * 「生成提纲」这一下，正文该怎么办（0.89.0）。
 *
 * 用户 2026-11-22 的现场：连点两次「生成提纲」，正文里两份提纲首尾相接。
 * 根因不是 `mergeOutlineIntoDraft` 写错了（它就是「不删字」），而是**调用点没有
 * 区分意图**：点第二次明明是想换一份，却走了「追加」。
 *
 * ★ 这一组判据必须成对存在：
 *   - 「一个字都不是他写的」⇒ 替换（否则连点两次就是接龙）；
 *   - 「有他写的」⇒ ask（否则替换会删他的字）。
 *   只测前一半，实现可以变成「无脑替换」；只测后一半，可以变成「无脑追加」。
 */
describe('0.89.0：这一下该替换、还是该先问', () => {
  it('空正文 ⇒ 替换（没有东西可删，一次点成）', () => {
    assert.equal(outlinePlacement('', { template: REFLECTION_TEMPLATE }), 'replace');
    assert.equal(outlinePlacement('  \n\n ', { template: REFLECTION_TEMPLATE }), 'replace');
    assert.equal(outlinePlacement(null, { template: REFLECTION_TEMPLATE }), 'replace');
    assert.equal(outlinePlacement(undefined), 'replace');
  });

  it('★ 正文是原封不动的模板 ⇒ 替换（不是叠成两套标题）', () => {
    assert.equal(outlinePlacement(REFLECTION_TEMPLATE, { template: REFLECTION_TEMPLATE }), 'replace');
    assert.equal(outlinePlacement(`\n${REFLECTION_TEMPLATE}\n\n`, { template: REFLECTION_TEMPLATE }), 'replace');
  });

  it('★ 正文还是上一份提纲 ⇒ 替换（这就是用户连点两次的那个 bug）', () => {
    assert.equal(outlinePlacement(`${OUTLINE}\n`, { lastOutline: OUTLINE }), 'replace');
    // 两种骨架同时给也要认：先套模板、再生成、再点一次。
    assert.equal(
      outlinePlacement(`${OUTLINE}\n`, { template: REFLECTION_TEMPLATE, lastOutline: OUTLINE }),
      'replace',
    );
  });

  it('★ 反向对照：他往提纲里填了半句 ⇒ 必须先问，不能替他把字删了', () => {
    const written = `${OUTLINE}\n\n我同意第二点，去年那次合作就是这样。`;
    assert.equal(outlinePlacement(written, { lastOutline: OUTLINE }), 'ask');
  });

  it('★ 反向对照：手打的正文 ⇒ 必须先问', () => {
    assert.equal(outlinePlacement('我读完了，先说一个让我不舒服的地方。', {
      template: REFLECTION_TEMPLATE,
      lastOutline: OUTLINE,
    }), 'ask');
  });

  it('★ 反向对照：不给 lastOutline 时，一份提纲也算「有东西」⇒ 先问（宁严勿松）', () => {
    // 调用点忘了传 lastOutline 时，最坏结果是多问一句；反过来（默认替换）
    // 会在用户已经往提纲里写了字的时候把字删掉。
    assert.equal(outlinePlacement(OUTLINE, { template: REFLECTION_TEMPLATE }), 'ask');
    assert.equal(outlinePlacement(OUTLINE), 'ask');
  });

  it('★ 端到端：模板 → 生成 → 再生成，正文里始终只有一套提纲', () => {
    // 第一次：正文是模板，替换。
    const first = mergeOutlineIntoDraft(REFLECTION_TEMPLATE, OUTLINE, { template: REFLECTION_TEMPLATE });
    assert.equal(first, `${OUTLINE}\n`);

    // 第二次：正文就是上一份，替换（用户现场是这里接龙成两份）。
    const second = mergeOutlineIntoDraft(first, OUTLINE, { template: REFLECTION_TEMPLATE, lastOutline: OUTLINE });
    assert.equal(second, `${OUTLINE}\n`);
    assert.equal(second.split('## 一、').length - 1, 1, '正文里出现了两份提纲');
    // 模板的四个标题一个都不该在（否则又是两套结构）。
    for (const heading of ['## 一句话总结', '## 核心收获', '## 行动指南', '## 金句摘录']) {
      assert.equal(second.includes(heading), false, `模板标题 ${heading} 还在`);
    }
  });
});
