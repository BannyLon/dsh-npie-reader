/**
 * 日记的格式层（`src/diary-format.js`）。
 *
 * ★ 这个文件是**宿主与浏览器半区共用**的那一份。它一旦对同一段文字给出两种解释，
 *   症状不是「解析报错」，而是「界面数出 3 条、导出 2 条」—— 两边都"对"，
 *   而用户没有任何办法判断谁错了。所以这里的断言全部钉在**可观察的结果**上。
 *
 * ★ 本文件的纪律（与 `library-trust.test.mjs` 同一条）：凡是「不能这么做」的判据，
 *   都配一条**反向对照** —— 证明那条断言真能变红，而不是恰好为真。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DIARY_MODULES, ENTRY_KINDS, LEGACY_KINDS, MOODS, REFLECTION_TEMPLATE, appendEntryText, buildDay,
  buildFrontmatter, dateKey, dayCharCount, dayFileName, entryAt, entryBlock, entryHeading,
  isValidDateKey, isValidMonthKey, metaLine, monthGrid, monthKeyOf, moodScore, normalizeMeta,
  parseDay, parseMetaLine, parseMonthKey, parseSource, parseTags, removeEntryText, shiftMonth, splitFrontmatter,
  updateEntryText,
  timeKey,
} from '../src/diary-format.js';

// ★ `meta` 是 2026-10-26 加上的（情绪 / 关联书节点 / 可见性），`parseDay` 一定会
//   给这个字段（空对象也算），所以夹具必须带上 —— 否则「往返一致」会因为一个
//   本来正确的空对象变红，而人只会去怀疑序列化写坏了。
const entry = (overrides = {}) => ({ time: '09:31', kind: '灵感', source: '', meta: {}, body: '一句话', ...overrides });

describe('dateKey / timeKey', () => {
  it('dateKey 用**本地**时区补零', () => {
    assert.equal(dateKey(new Date(2026, 0, 5, 12, 0)), '2026-01-05');
    assert.equal(dateKey(new Date(2026, 11, 31, 12, 0)), '2026-12-31');
  });

  it('★ dateKey 不是 UTC —— 反向对照证明这条断言有牙', () => {
    // 本地 00:30 与 23:30 各取一个：在任何一个非 UTC 时区里，总有一个的 UTC 日期
    // 与本地日期不同。如果实现写成 `toISOString().slice(0,10)`，它会在那一侧变红。
    const early = new Date(2026, 9, 26, 0, 30);
    const late = new Date(2026, 9, 26, 23, 30);
    assert.equal(dateKey(early), '2026-10-26');
    assert.equal(dateKey(late), '2026-10-26');
    const offset = early.getTimezoneOffset();
    if (offset < 0) {
      // 东半球（UTC+）：本地 00:30 的 UTC 还在前一天
      assert.notEqual(early.toISOString().slice(0, 10), '2026-10-26', '这条反向对照在本机应当成立');
    }
    if (offset > 0) {
      // 西半球（UTC-）：本地 23:30 的 UTC 已经到第二天
      assert.notEqual(late.toISOString().slice(0, 10), '2026-10-26', '这条反向对照在本机应当成立');
    }
  });

  it('timeKey 补零到两位', () => {
    assert.equal(timeKey(new Date(2026, 0, 1, 7, 5)), '07:05');
    assert.equal(timeKey(new Date(2026, 0, 1, 0, 0)), '00:00');
    assert.equal(timeKey(new Date(2026, 0, 1, 23, 59)), '23:59');
  });
});

describe('isValidDateKey / isValidMonthKey', () => {
  it('真的存在的日期才通过', () => {
    for (const key of ['2026-10-26', '2024-02-29', '2026-01-01', '2026-12-31']) {
      assert.equal(isValidDateKey(key), true, key);
    }
  });

  it('★ 正则过得了但日期不存在的必须被拒（否则落成一个永远打不开的文件名）', () => {
    for (const key of ['2026-13-45', '2026-02-30', '2025-02-29', '2026-00-10', '2026-04-31']) {
      assert.equal(isValidDateKey(key), false, key);
    }
  });

  it('反向对照：格式不对 / 会拼出路径的一律不是', () => {
    for (const key of ['2026-1-1', '26-10-26', '2026/10/26', '../2026-10-26', '2026-10-26.md', '', ' 2026-10-26', '2026-10-26\n', '٢٠٢٦-١٠-٢٦']) {
      assert.equal(isValidDateKey(key), false, JSON.stringify(key));
    }
    assert.equal(isValidDateKey(undefined), false);
    assert.equal(isValidDateKey(20261026), false);
  });

  it('月份只认 01–12', () => {
    assert.equal(isValidMonthKey('2026-10'), true);
    assert.equal(isValidMonthKey('2026-01'), true);
    assert.equal(isValidMonthKey('2026-00'), false);
    assert.equal(isValidMonthKey('2026-13'), false);
    assert.equal(isValidMonthKey('2026-1'), false);
    assert.equal(isValidMonthKey('2026-10-26'), false);
  });
});

describe('frontmatter', () => {
  it('buildFrontmatter 与 splitFrontmatter 互为逆运算', () => {
    const front = buildFrontmatter('2026-10-26');
    assert.equal(splitFrontmatter(`${front}\n正文`).front, front);
    assert.equal(splitFrontmatter(`${front}\n正文`).body, '\n正文');
  });

  it('切不开就整段当正文，不抛错（用户手工删掉半个 `---` 是常事）', () => {
    const broken = '---\ndate: 2026-10-26\n没有结束标记\n\n## 09:31 灵感\n\n正文';
    const { front, body } = splitFrontmatter(broken);
    assert.equal(front, '');
    assert.equal(body, broken, '正文一个字节都不能丢');
    // 而且条目照样解析得出来 —— 这是「坏 frontmatter 不该连累内容」的可观察证据
    assert.equal(parseDay(broken).entries.length, 1);
  });
});

describe('entryHeading / parseDay', () => {
  it('标题行带时间、类型、来源', () => {
    assert.equal(entryHeading(entry()), '## 09:31 灵感');
    assert.equal(entryHeading(entry({ kind: '读后感' })), '## 09:31 读后感');
    assert.equal(
      entryHeading(entry({ kind: '书摘', source: '《被讨厌的勇气》第 3 章' })),
      '## 09:31 书摘 · 《被讨厌的勇气》第 3 章',
    );
  });

  it('不认识的类型兜成「灵感」，而不是丢字段', () => {
    assert.equal(entryHeading(entry({ kind: '随笔' })), '## 09:31 灵感');
    assert.deepEqual(parseDay('## 09:31 随笔\n\n正文').entries[0].kind, '灵感');
  });

  it('parseDay 把标题行拆成 time / kind / source / body', () => {
    const text = [
      buildFrontmatter('2026-10-26'),
      '',
      '## 09:31 书摘 · 《被讨厌的勇气》第 3 章',
      '',
      '一切烦恼都来自人际关系。',
      '',
      '## 21:05 读后感 · 引自 RSS：如何做选择',
      '',
      '第一行',
      '第二行',
      '',
    ].join('\n');
    const { front, entries } = parseDay(text);
    assert.match(front, /date: 2026-10-26/);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { time: '09:31', kind: '书摘', source: '《被讨厌的勇气》第 3 章', meta: {}, body: '一切烦恼都来自人际关系。' });
    assert.equal(entries[1].kind, '读后感');
    assert.equal(entries[1].source, '引自 RSS：如何做选择');
    assert.equal(entries[1].body, '第一行\n第二行', '正文里的换行必须留着');
  });

  it('★ 正文里的行内空白/缩进/列表标记不能被 trim 掉', () => {
    const text = '## 09:31 灵感\n\n- 第一条\n  - 缩进的子项\n\n    代码块缩进\n';
    const body = parseDay(text).entries[0].body;
    assert.equal(body, '- 第一条\n  - 缩进的子项\n\n    代码块缩进');
  });

  it('没有标题行 ⇒ 0 条（不编出幽灵条目）', () => {
    assert.equal(parseDay('随便一段文字\n没有标题').entries.length, 0);
    assert.equal(parseDay('').entries.length, 0);
    assert.equal(parseDay(undefined).entries.length, 0);
  });

  it('★ 时间格式不合法的行不算标题（否则正文里的 `## 3. 结论` 会被切成一条）', () => {
    const text = '## 09:31 灵感\n\n## 3. 结论\n\n正文';
    const { entries } = parseDay(text);
    assert.equal(entries.length, 1);
    assert.match(entries[0].body, /## 3\. 结论/, '它应当留在正文里');
  });
});

describe('buildDay ⇄ parseDay', () => {
  it('往返一致', () => {
    const entries = [
      entry({ time: '09:31', kind: '灵感', body: '甲' }),
      entry({ time: '21:05', kind: '读后感', source: '《被讨厌的勇气》', body: '乙\n丙' }),
    ];
    const text = buildDay('2026-10-26', entries);
    assert.deepEqual(parseDay(text).entries, entries);
    assert.equal(parseDay(text).front, buildFrontmatter('2026-10-26'));
  });

  it('空的一天只有 frontmatter', () => {
    const text = buildDay('2026-10-26', []);
    assert.equal(parseDay(text).entries.length, 0);
    assert.equal(text.trim(), buildFrontmatter('2026-10-26').trim());
  });
});

describe('appendEntryText', () => {
  it('空文件时自己补 frontmatter', () => {
    const text = appendEntryText('', { ...entry(), date: '2026-10-26' });
    assert.match(text, /^---\ndate: 2026-10-26\ntype: daily\nstatus: 草稿\n---\n/);
    assert.equal(parseDay(text).entries.length, 1);
  });

  it('追加到已有内容之后，条目顺序是追加顺序', () => {
    let text = appendEntryText('', { ...entry({ time: '09:00', body: '甲' }), date: '2026-10-26' });
    text = appendEntryText(text, { ...entry({ time: '10:00', body: '乙' }) });
    text = appendEntryText(text, { ...entry({ time: '11:00', body: '丙' }) });
    assert.deepEqual(parseDay(text).entries.map(item => item.body), ['甲', '乙', '丙']);
  });

  it('★ 旧内容逐字节保留：手工改过的 frontmatter 与块间空行不能被规范化', () => {
    // 这是本函数存在的**全部理由**。写成 `buildDay(key, [...parseDay(text).entries, newEntry])`
    // 也「能追加」，但会把下面这份文件整篇改写。
    const original = [
      '---',
      'date: 2026-10-26',
      'type: daily',
      'status: 已发布',
      'tags: [周记, 读书]',
      '---',
      '',
      '## 07:05 灵感 · 手写的一条',
      '',
      '第一段',
      '',
      '',
      '',
      '隔了三行才写的第二段',
      '',
    ].join('\n');
    const next = appendEntryText(original, entry({ time: '22:10', body: '新的一条' }));

    assert.ok(next.includes('status: 已发布'), 'frontmatter 被改写了');
    assert.ok(next.includes('tags: [周记, 读书]'), 'frontmatter 的未知字段被丢了');
    assert.ok(next.includes('## 07:05 灵感 · 手写的一条'));
    assert.ok(next.includes('隔了三行才写的第二段'));
    assert.equal(parseDay(next).entries.length, 2);
    assert.equal(parseDay(next).entries[1].body, '新的一条');

    // 反向对照：证明上面那几条断言**真的**能区分两种实现 ——
    // 走「解析再整体重写」的那条路会把 `status` 抹成「草稿」。
    const naive = buildDay('2026-10-26', [...parseDay(original).entries, entry({ time: '22:10', body: '新的一条' })]);
    assert.ok(!naive.includes('status: 已发布'), '反向对照失效：naive 实现竟然保住了 status');
    assert.ok(!naive.includes('tags: [周记, 读书]'));
  });

  it('追加不会在中间插进多余空行', () => {
    let text = appendEntryText('', { ...entry({ body: '甲' }), date: '2026-10-26' });
    text = appendEntryText(text, entry({ body: '乙' }));
    assert.ok(!text.includes('\n\n\n'), `出现了三连空行：${JSON.stringify(text)}`);
  });
});

describe('updateEntryText', () => {
  const three = () => {
    let text = appendEntryText('', { ...entry({ time: '09:00', body: '甲' }), date: '2026-10-26' });
    text = appendEntryText(text, entry({ time: '10:00', body: '乙' }));
    text = appendEntryText(text, entry({ time: '11:00', body: '丙' }));
    return text;
  };

  it('只改指定的那一条，其余逐字不动', () => {
    const result = updateEntryText(three(), 1, { body: '乙改' });
    assert.ok(result);
    assert.deepEqual(result.entries.map(item => item.body), ['甲', '乙改', '丙']);
    assert.deepEqual(parseDay(result.text).entries.map(item => item.body), ['甲', '乙改', '丙']);
  });

  it('★ 时间沿用原来的：改写不该把 10:00 变成「现在」', () => {
    // 一旦时间被改成当前时刻，时间轴上的位置就在说谎 —— 用户看到的是「我 14:32 写的」，
    // 而那句话其实是上午十点写的。
    const result = updateEntryText(three(), 1, { body: '乙改' });
    assert.equal(result.entries[1].time, '10:00');
    assert.equal(result.before.time, '10:00');
  });

  it('显式给了 time / kind 才覆盖（其余字段保住原值）', () => {
    const result = updateEntryText(three(), 0, { body: '甲改', time: '23:05' });
    assert.equal(result.entries[0].time, '23:05');
    assert.equal(result.entries[0].kind, entry().kind);
  });

  it('★ 越界返回 null（与 removeEntryText 同一套判据）', () => {
    assert.equal(updateEntryText(three(), 3, { body: 'x' }), null);
    assert.equal(updateEntryText(three(), -1, { body: 'x' }), null);
    assert.equal(updateEntryText('', 0, { body: 'x' }), null);
    assert.equal(updateEntryText('随便一段没有条目的文字', 0, { body: 'x' }), null);
  });

  it('★ 条数不变（改写不是「再加一条」）', () => {
    const result = updateEntryText(three(), 0, { body: '全新的甲' });
    assert.equal(result.entries.length, 3);
    assert.equal(parseDay(result.text).entries.length, 3);
  });
});

describe('entryAt / removeEntryText', () => {
  const three = () => {
    let text = appendEntryText('', { ...entry({ time: '09:00', body: '甲' }), date: '2026-10-26' });
    text = appendEntryText(text, entry({ time: '10:00', body: '乙' }));
    text = appendEntryText(text, entry({ time: '11:00', body: '丙' }));
    return text;
  };

  it('entryAt 按序号取，越界返回 null', () => {
    const text = three();
    assert.equal(entryAt(text, 1).body, '乙');
    assert.equal(entryAt(text, 3), null);
    assert.equal(entryAt(text, -1), null);
    assert.equal(entryAt(text, 1.5), null);
    assert.equal(entryAt(text, undefined), null);
  });

  it('删中间那条，其余原样保留', () => {
    const result = removeEntryText(three(), 1);
    assert.ok(result);
    assert.deepEqual(result.entries.map(item => item.body), ['甲', '丙']);
    assert.deepEqual(parseDay(result.text).entries.map(item => item.body), ['甲', '丙']);
    assert.equal(result.key, '2026-10-26');
  });

  it('删到只剩零条也不报错（那一天回到「还没写」）', () => {
    const one = appendEntryText('', { ...entry({ body: '只有一条' }), date: '2026-10-26' });
    const result = removeEntryText(one, 0);
    assert.equal(result.entries.length, 0);
    assert.equal(parseDay(result.text).entries.length, 0);
  });

  it('★ 越界返回 null（不是空对象、不是抛错）—— 调用方靠它区分「删了」和「本来就没有」', () => {
    assert.equal(removeEntryText(three(), 3), null);
    assert.equal(removeEntryText(three(), -1), null);
    assert.equal(removeEntryText('', 0), null);
    assert.equal(removeEntryText('随便一段没有条目的文字', 0), null);
  });
});

describe('dayCharCount', () => {
  it('口径是去掉空白后的字符数（与界面显示同源）', () => {
    assert.equal(dayCharCount([entry({ body: '一二三' })]), 3);
    assert.equal(dayCharCount([entry({ body: '一 二\n三' })]), 3, '空白不计');
    assert.equal(dayCharCount([entry({ body: '甲' }), entry({ body: '乙丙' })]), 3);
    assert.equal(dayCharCount([]), 0);
  });
});

describe('月历与月份', () => {
  it('monthGrid 给 42 格、周日开头、跨月格子也带 key', () => {
    // 2026-10-01 是周四 ⇒ 前面要补 4 个 9 月的格子
    const cells = monthGrid(2026, 9, '2026-10-26');
    assert.equal(cells.length, 42);
    assert.equal(cells[0].key, '2026-09-27');
    assert.equal(cells[0].inMonth, false);
    assert.equal(cells[4].key, '2026-10-01');
    assert.equal(cells[4].inMonth, true);
    assert.equal(cells.filter(cell => cell.today).length, 1);
    assert.equal(cells.find(cell => cell.today).key, '2026-10-26');
    assert.equal(cells[41].key, '2026-11-07');
    assert.equal(cells[41].inMonth, false);
  });

  it('★ 跨月格子的 key 必须是对的日期，不能是 0 号或 32 号', () => {
    for (const cell of monthGrid(2026, 1, '2026-02-01')) {
      assert.equal(isValidDateKey(cell.key), true, `${cell.key} 不是合法日期`);
    }
  });

  it('shiftMonth 跨年', () => {
    assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month0: 0 });
    assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month0: 11 });
    assert.deepEqual(shiftMonth(2026, 9, 3), { year: 2027, month0: 0 });
  });

  it('parseMonthKey / monthKeyOf 互为逆运算', () => {
    assert.deepEqual(parseMonthKey('2026-10'), { year: 2026, month0: 9 });
    assert.equal(monthKeyOf(2026, 9), '2026-10');
    assert.equal(parseMonthKey('2026-13'), null);
    assert.equal(monthKeyOf(2026, 0), '2026-01');
  });
});

describe('常量', () => {
  it('类型只剩三种，且**由模块决定**（不是界面上的选择题）', () => {
    // 0.31.0 返工：用户要的是三个功能模块（灵感速记 / 私密日记 / 读后感），
    // 「书摘」根本不在他的设计里 —— 它是 0.30.0 我自己编的条目类型。
    assert.deepEqual([...ENTRY_KINDS], ['灵感', '日记', '读后感']);
    assert.ok(Object.isFrozen(ENTRY_KINDS));
    // ★ 老数据仍要能解析：`LEGACY_KINDS` 只用于读回与写回，不再出现在可选列表里。
    assert.deepEqual([...LEGACY_KINDS], ['书摘']);
    assert.equal(ENTRY_KINDS.includes('书摘'), false);
  });

  it('三个模块各自决定 kind / vis（用户不再手选类型）', () => {
    assert.deepEqual(DIARY_MODULES.map((item) => item.value), ['inspiration', 'private', 'reflection']);
    assert.deepEqual(DIARY_MODULES.map((item) => item.label), ['灵感速记', '私密日记', '读后感']);
    assert.deepEqual(DIARY_MODULES.map((item) => item.kind), ['灵感', '日记', '读后感']);
    assert.deepEqual(DIARY_MODULES.map((item) => item.vis), ['public', 'private', 'public']);
    assert.ok(Object.isFrozen(DIARY_MODULES));
  });

  it('读后感模板含用户要的四段', () => {
    for (const part of ['一句话总结', '核心收获', '行动指南', '金句摘录']) {
      assert.ok(REFLECTION_TEMPLATE.includes(part), `模板里没有「${part}」`);
    }
    // 模板必须是**合法 Markdown**，而且四段要用 `##` 小标题。
    // ★ 0.34 从 `**一句话总结**` 改成 `## 一句话总结`：前者在编辑器里是一串星号，
    //   用户 2026-10-27 的截图就是那个样子（「写作框巨丑」）。小标题在预览里是真
    //   标题，源码里也只是两个 `#` —— 一眼就知道那是标题，而不是乱码。
    assert.ok(REFLECTION_TEMPLATE.includes('## 一句话总结'));
    assert.ok(!REFLECTION_TEMPLATE.includes('**'), '模板里还留着加粗语法的 * 号');
    // 四段之间要留空行，否则渲染出来是四行连着的标题。
    assert.equal(REFLECTION_TEMPLATE.split('\n\n').length, 4);
  });

  it('★ 老条目「书摘」写回去仍然是「书摘」（重写不能改类型）', () => {
    // 一次「删掉别的条目」的重写会重建整个文件；如果 `entryHeading` 不认书摘，
    // 那条老数据的类型就会被静默改成「灵感」。
    assert.equal(entryHeading({ time: '09:31', kind: '书摘', source: '' }), '## 09:31 书摘');
  });

  it('文件名就是日期加 .md', () => {
    assert.equal(dayFileName('2026-10-26'), '2026-10-26.md');
  });
});

// ---------------------------------------------------------------------------
// 2026-10-26 新增：情绪 / 关联 / 可见性（元数据行）+ 标签 + 情绪分数
//
// ★ 这三块的全部风险都在**「用户手改 Markdown」**上：日记是纯文本，用户随时会
//   在编辑器里删掉一行注释、把 `#灵感` 打成 `# 灵感`、或者把标签写成全角标点
//   结尾。所以这里的断言不是「功能好不好用」，而是「坏输入会不会变成一句假话」。
// ---------------------------------------------------------------------------

describe('元数据行（情绪 / 关联 / 可见性）', () => {
  it('没有元数据时**不写空行**（普通灵感保持原样）', () => {
    assert.equal(metaLine({}), '');
    assert.equal(metaLine(undefined), '');
    assert.equal(metaLine({ mood: '不认识的表情' }), '', '全是坏字段 ⇒ 等于没有元数据');
    // 反向对照：真的给了合法字段就必须写出来（否则上一条会因为「永远返回空串」而假绿）
    assert.notEqual(metaLine({ mood: '🙂' }), '');
  });

  it('写出来的是 HTML 注释，且能被读回（Markdown 合法、渲染器看不见）', () => {
    const line = metaLine({ mood: '🙂', book: 'b7f3', chapter: 3, page: 128 });
    assert.ok(line.startsWith('<!-- npr '), line);
    assert.ok(line.endsWith(' -->'), line);
    assert.deepEqual(parseMetaLine(line), { mood: '🙂', book: 'b7f3', chapter: 3, page: 128 });
  });

  it('★ 字段顺序固定：乱序输入两次写出来逐字节相同', () => {
    // 顺序不稳的后果不是「难看」：追加时新旧两次写出不同形态，`git diff` 会把
    // 一次「加了一条」显示成「改了这一条」，而人只会以为内容被改了。
    const one = metaLine({ page: 12, book: 'abc', mood: '😐' });
    const two = metaLine({ mood: '😐', page: 12, book: 'abc' });
    assert.equal(one, two);
    assert.ok(one.indexOf('mood') < one.indexOf('book'), one);
    assert.ok(one.indexOf('book') < one.indexOf('page'), one);
  });

  it('★ 坏字段一律丢弃，不抛错（一个坏字段不该让整条日记读不出来）', () => {
    assert.deepEqual(normalizeMeta({ mood: '🔥' }), {});
    // `book` 会拼进文件名/URL 的语境，所以只认安全字符：路径分隔符与空格都拒。
    assert.deepEqual(normalizeMeta({ book: '../../etc/passwd' }), {});
    assert.deepEqual(normalizeMeta({ book: 'a b' }), {});
    assert.deepEqual(normalizeMeta({ book: 'b7f3' }), { book: 'b7f3' });
    // 负数 / 小数 / 非数字都不认（页码是「第几页」，不是量出来的浮点数）
    assert.deepEqual(normalizeMeta({ page: -1 }), {});
    assert.deepEqual(normalizeMeta({ page: 1.5 }), {});
    assert.deepEqual(normalizeMeta({ page: 'abc' }), {});
    assert.deepEqual(normalizeMeta({ page: '128' }), { page: 128 }, '数字字符串应当被接受（JSON 里常见）');
    assert.deepEqual(normalizeMeta(null), {});
    assert.deepEqual(normalizeMeta('字符串'), {});
  });

  it('★ 文章的 key 也进 meta（读 RSS 时按 L 记的灵感要有出处）', () => {
    // 用户 2026-10-27：「那如果是在阅读 RSS 时创建的灵感怎么办？」——
    // 出处不能只写在 `source`（那是给人看的一句话，文章标题里带什么都不奇怪），
    // 还要有一个稳定的 key 能反查回那一篇。
    assert.deepEqual(normalizeMeta({ article: 'feed:abc/2026-10-27-1' }), { article: 'feed:abc/2026-10-27-1' });
    // URL 片段要能过（订阅源的 key 可能带 `:` `/` `#`），空格也会出现。
    assert.deepEqual(normalizeMeta({ article: 'https://example.com/a#b' }), { article: 'https://example.com/a#b' });
    // ★ 但会**提前结束 HTML 注释**的 `-->` 必须拒：写进去之后那行注释就断了，
    //   后半截会变成正文，而且读回来永远少一半。
    assert.deepEqual(normalizeMeta({ article: 'x --> y' }), {});
    // 换行同理：整行断成两行，第二行变成普通正文。
    assert.deepEqual(normalizeMeta({ article: 'a\nb' }), {});
    assert.deepEqual(normalizeMeta({ article: '' }), {});
    assert.deepEqual(normalizeMeta({ article: 'x'.repeat(201) }), {});
  });

  it('★ 文章 key 能原样过一遍注释行（写进去再读回来要一样）', () => {
    const key = 'feed:abc/2026-10-27-1';
    const line = metaLine({ article: key, mood: '🙂' });
    assert.deepEqual(parseMetaLine(line), { mood: '🙂', article: key });
    // 顺序：mood 在 article 之前（META_FIELDS 的顺序，两次写出必须逐字节相同）
    assert.ok(line.indexOf('mood') < line.indexOf('article'), line);
  });

  it('元数据只认白名单字段，别的键不会被写回去', () => {
    assert.deepEqual(normalizeMeta({ mood: '🙂', secret: '不该出现', __proto__: 'x' }), { mood: '🙂' });
    assert.equal(metaLine({ mood: '🙂', extra: 1 }).includes('extra'), false);
  });

  it('★ 元数据行只在标题行之后、正文第一行之前被认', () => {
    // 用户自己写在正文中间的注释是他写的内容，绝不能被悄悄吃掉。
    const text = [
      '---', 'date: 2026-10-26', 'type: daily', 'status: 草稿', '---', '',
      '## 09:31 灵感', '<!-- npr {"mood":"🙂"} -->', '',
      '正文第一段',
      '',
      '<!-- npr {"mood":"😔"} -->', '正文里我自己写的注释', '',
    ].join('\n');
    const { entries } = parseDay(text);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].meta, { mood: '🙂' }, '标题行下面那行才是元数据');
    assert.ok(entries[0].body.includes('<!-- npr {"mood":"😔"} -->'), '正文中间的注释必须留在正文里');
    assert.ok(entries[0].body.includes('正文里我自己写的注释'));
  });

  it('★ 坏 JSON 的元数据行被吃掉，不混进正文（也不抛错）', () => {
    const text = '## 09:31 灵感\n<!-- npr {不是 json} -->\n\n正文\n';
    const { entries } = parseDay(text);
    assert.deepEqual(entries[0].meta, {});
    assert.equal(entries[0].body, '正文');
    // 反向对照：这一行**不是**被当普通正文留下的（否则用户会在日记里看到一串机器码）
    assert.equal(entries[0].body.includes('npr'), false);
  });

  it('entryBlock 往返：带元数据的条目写完再读回来完全一致', () => {
    const one = entry({ meta: { mood: '😣', book: 'b7f3', chapter: 2, page: 30 } });
    const text = buildDay('2026-10-26', [one]);
    const { entries } = parseDay(text);
    assert.deepEqual(entries[0], one);
  });

  it('★ 老版本的心情 emoji（😕）读回来不丢，且被换成当前这版（😣）', () => {
    // 0.32.0 把「有点烦」从 😕 换成 😣。判据若写成 `MOOD_SCORE.has(mood)`，
    // 老条目会在**读取时**静默丢掉心情 —— 文件里那行元数据还在，界面上却没了，
    // 日历上那天的点也退回灰色。这条守的就是那次换 emoji 的兼容性。
    const text = '## 09:31 灵感\n<!-- npr {"mood":"😕"} -->\n\n正文\n';
    const { entries } = parseDay(text);
    assert.equal(entries[0].meta.mood, '😣', '老 emoji 被丢掉了（或没换成新值）');
    assert.equal(moodScore(entries[0].meta.mood), 2, '分数变了 —— 情绪曲线会跟着歪');
    // 反向对照：认不出的值仍然不许写进去（白名单还在，只是放宽到「认得的旧值」）。
    const junk = parseDay('## 09:31 灵感\n<!-- npr {"mood":"开心"} -->\n\n正文\n');
    assert.equal(junk.entries[0].meta.mood, undefined, '任意字符串混进了 meta.mood');
  });

  it('★ 标题行与元数据行之间允许多余空行（用户手改常见）', () => {
    const { entries } = parseDay('## 09:31 灵感\n\n<!-- npr {"mood":"😄"} -->\n\n正文\n');
    assert.deepEqual(entries[0].meta, { mood: '😄' });
    assert.equal(entries[0].body, '正文');
  });

  it('★ 没有元数据的旧文件读出来是 `meta: {}`，不是 undefined', () => {
    // 这个字段的存在本身就是契约：界面会写 `entry.meta.mood`，
    // 缺字段会让那一行在渲染时抛 TypeError（整块日记白屏）。
    const { entries } = parseDay('## 09:31 灵感\n\n正文\n');
    assert.deepEqual(entries[0].meta, {});
    assert.deepEqual(entryBlock(entry()).includes('npr'), false, '空元数据不该写出注释行');
  });
});

describe('来源（parseSource）', () => {
  it('书：切掉 ` · 第几章`，并保留书名号', () => {
    assert.deepEqual(parseSource('《深度工作》 · 第 3 章'), {
      isBook: true, title: '深度工作', label: '《深度工作》',
    });
  });

  it('文章：整段就是标题，不切 ` · `（「A · B」是常见写法），也不套书名号', () => {
    assert.deepEqual(parseSource('Anthropic 刚刚向 SEC 递交了 S-1'), {
      isBook: false, title: 'Anthropic 刚刚向 SEC 递交了 S-1', label: 'Anthropic 刚刚向 SEC 递交了 S-1',
    });
    assert.deepEqual(parseSource('模型 · 资本 · 幻觉').label, '模型 · 资本 · 幻觉');
  });

  it('★ 书名自带书名号时只剥外层（0.38 存成过 `《《X》 076…》`）', () => {
    // 真实数据：书源标题是 `《译文名著文库》 076[法]雨果-九三年（叶尊译…）`，
    // 0.38 的 `QuickCapture` 又套了一层 ⇒ 侧栏显示成 `《《译文名著文库》》`。
    const source = '《《译文名著文库》 076[法]雨果-九三年（叶尊译，上海译文出版社2011）》 · 第三卷 阿尔马洛';
    const parsed = parseSource(source);
    assert.equal(parsed.isBook, true);
    // 剥掉最外那层之后，里面那段**本身**就带书名号 ⇒ 原样显示，不再补一对。
    assert.equal(parsed.label, '《译文名著文库》 076[法]雨果-九三年（叶尊译，上海译文出版社2011）');
    assert.equal(parsed.title, '《译文名著文库》 076[法]雨果-九三年（叶尊译，上海译文出版社2011）');
  });

  it('★ 反向对照：`《《X》` 若按「第一个 》」截断，会得到畸形的 `《《X》`', () => {
    // 这条守的是**0.38 的错法**：`^《([^》]+)》` 在 `《《X》 076》` 上只能取到 `《X`。
    const source = '《《译文名著文库》 076[法]雨果-九三年》 · 第三卷';
    const oldWay = /^《([^》]+)》/.exec(source);
    assert.equal(`《${oldWay[1]}》`, '《《译文名著文库》', '旧写法在这条数据上本该截出畸形键');
    // 正确结果不出现两个连续的 `》`。
    assert.doesNotMatch(parseSource(source).label, /》》/);
  });

  it('空来源返回 null（不进任何分组，也不硬塞「未分类」）', () => {
    assert.equal(parseSource(''), null);
    assert.equal(parseSource(null), null);
    assert.equal(parseSource('   '), null);
    assert.equal(parseSource('《》'), null);
  });
});

describe('标签（parseTags）', () => {
  it('行首、空白后、中文标点后都算边界（比 Obsidian 宽松一档）', () => {
    // ★ 为什么放宽：Obsidian 只认「行首或空格」，而中文写作里 `。#灵感` 不带空格
    //   是常态。严格照抄的后果是「正文里明明有 #灵感，筛选时找不到」，而**这个
    //   失败是看不见的** —— 用户会以为自己记错了。
    assert.deepEqual(parseTags('#灵感'), ['灵感']);
    assert.deepEqual(parseTags('想到一件事 #商业 值得记'), ['商业']);
    assert.deepEqual(parseTags('今天很累。#生活'), ['生活']);
    assert.deepEqual(parseTags('他说：「#引用」'), ['引用']);
    assert.deepEqual(parseTags('（#括号）'), ['括号']);
  });

  it('★ 反向对照：`## 标题` 与 `# 带空格` 都不算标签', () => {
    assert.deepEqual(parseTags('## 09:31 灵感'), []);
    assert.deepEqual(parseTags('# 灵感'), []);
    assert.deepEqual(parseTags('井号 # 后面是空格'), []);
  });

  it('纯数字不算（`#1` 更像编号 / issue 号）', () => {
    assert.deepEqual(parseTags('见 #1 和 #42'), []);
    assert.deepEqual(parseTags('#1a'), ['1a'], '带字母就是标签了');
  });

  it('尾部标点被裁掉，标签本身不带标点', () => {
    assert.deepEqual(parseTags('结尾 #灵感，'), ['灵感']);
    assert.deepEqual(parseTags('结尾 #灵感。'), ['灵感']);
    assert.deepEqual(parseTags('#读书笔记；下一句'), ['读书笔记']);
  });

  it('去重保序：同一个标签出现两次只留第一次的位置', () => {
    assert.deepEqual(parseTags('#a 中间 #b 又来 #a'), ['a', 'b']);
  });

  it('标签不跨空白、不跨换行', () => {
    assert.deepEqual(parseTags('#灵感\n#商业'), ['灵感', '商业']);
    assert.deepEqual(parseTags('#灵感 商业'), ['灵感'], '空格后面那个没有井号');
  });

  it('★ 超长片段**整个不认**，而不是截断成 24 字（截出来的标签正文里根本没有）', () => {
    // 这一条是真踩过的：`{1,24}` 后面不跟否定前瞻时，25 个字的连写片段会被
    // 静默截成 24 个字 —— 标签云里出现一个正文里不存在的标签，点进去搜不到。
    assert.equal(parseTags(`#${'字'.repeat(24)}`).length, 1, '24 字仍然算标签');
    assert.deepEqual(parseTags(`#${'字'.repeat(25)}`), [], '25 字应当整个不认');
  });

  it('非字符串输入返回空数组（不抛错）', () => {
    assert.deepEqual(parseTags(undefined), []);
    assert.deepEqual(parseTags(null), []);
    assert.deepEqual(parseTags(42), []);
  });
});

describe('情绪（MOODS / moodScore）', () => {
  it('五档，分数从高到低，emoji 唯一', () => {
    assert.equal(MOODS.length, 5);
    assert.deepEqual(MOODS.map(mood => mood.score), [5, 4, 3, 2, 1]);
    assert.equal(new Set(MOODS.map(mood => mood.emoji)).size, 5);
    assert.ok(Object.isFrozen(MOODS));
  });

  it('★ 每档都带 tone，且 tone 与 score 一一对应（CSS 按 tone 取色、日历按 tone 画点）', () => {
    // tone 与 score 现在恰好同值，但它们是**两个契约**：调配色不该动统计口径。
    // 这条守的是「tone 缺失 / 重复」——重复会让两档共用一个颜色，界面上看不出来，
    // 但日历上「一般」和「低落」会变成同一种点。
    assert.deepEqual(MOODS.map(mood => mood.tone), [5, 4, 3, 2, 1]);
    assert.equal(new Set(MOODS.map(mood => mood.tone)).size, 5);
    for (const mood of MOODS) assert.equal(typeof mood.label, 'string', `${mood.emoji} 没有中文标签`);
  });

  it('★ 不认识的情绪返回 null，不是 0 —— 曲线要能区分「没记」和「最低」', () => {
    assert.equal(moodScore('😄'), 5);
    assert.equal(moodScore('😔'), 1);
    assert.equal(moodScore('🔥'), null);
    assert.equal(moodScore(''), null);
    assert.equal(moodScore(undefined), null);
    // 反向对照：最低那一档**不是** null（否则「没记」和「低落」会被画成同一个点）
    assert.notEqual(moodScore('😔'), null);
  });
});
