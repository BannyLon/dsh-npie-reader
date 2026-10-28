/**
 * 选中段落 → 摘录到日记（0.44.9）。
 *
 * ★ 这里断言的重点不是「字段都传了」，而是**过一遍宿主的白名单之后还在**：
 *   `normalizeMeta` 会把不认的键静默丢掉，所以「摘录写进去了、但回不到那篇文章」
 *   这种错法，只看客户端传了什么永远发现不了。所以下面真的调用宿主那份
 *   `normalizeMeta`，比对输出。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { EXCERPT_KIND, excerptEntry } from '../src/client/excerpt.js';
import { normalizeMeta, parseMetaLine, metaLine } from '../src/diary-format.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('0.44.9：摘录 —— 载荷', () => {
  it('基本形状：kind 是「摘录」，正文就是选中的那段', () => {
    const entry = excerptEntry({ quote: '原文里的一句话', title: '一篇', date: '2026-10-29' });
    assert.equal(entry.kind, EXCERPT_KIND);
    assert.equal(entry.body, '原文里的一句话');
    assert.equal(entry.date, '2026-10-29');
  });

  it('两端空白被去掉（选中常常带上换行）', () => {
    assert.equal(excerptEntry({ quote: '  一句话\n' }).body, '一句话');
  });

  it('★ 空 / 只有空白 ⇒ null（调用方据此提示「先选中一段」）', () => {
    assert.equal(excerptEntry({ quote: '' }), null);
    assert.equal(excerptEntry({ quote: '   \n\t ' }), null);
    assert.equal(excerptEntry({}), null);
  });

  it('source 是「摘录 · 标题 · 频道名」，缺哪个就少哪个', () => {
    assert.equal(excerptEntry({ quote: 'x', title: '标题', channelName: '某博客' }).source, '摘录 · 标题 · 某博客');
    assert.equal(excerptEntry({ quote: 'x', title: '标题' }).source, '摘录 · 标题');
    assert.equal(excerptEntry({ quote: 'x', channelName: '某博客' }).source, '摘录 · 某博客');
    // 一个来源都没有时只剩「摘录」—— 也不能是空串，否则标题行上看不出这是引来的
    assert.equal(excerptEntry({ quote: 'x' }).source, '摘录');
  });

  it('★ 标题里的换行会被折叠（否则日记那一行断成两行）', () => {
    assert.equal(excerptEntry({ quote: 'x', title: '第一行\n第二行' }).source, '摘录 · 第一行 第二行');
  });

  it('★ meta.article 能过宿主白名单（否则日记里回不到那篇文章）', () => {
    const key = 'feed:https://a.example/feed.xml#post-1';
    const entry = excerptEntry({ quote: 'x', articleKey: key });
    const kept = normalizeMeta(entry.meta);
    assert.equal(kept.article, key, '白名单把 article 丢了 —— 摘录在日记里查不到出处');
  });

  it('★ 整条能写成日记那一行元数据，再原样读回来', () => {
    const entry = excerptEntry({ quote: 'x', articleKey: 'k-1' });
    const line = metaLine(entry.meta);
    assert.ok(line.length > 0, '没有生成元数据行 —— 摘录会变成一条没有出处的普通日记');
    assert.deepEqual(parseMetaLine(line), { article: 'k-1' });
  });

  it('超长 key 不写进 meta（白名单会丢，写了等于骗人）', () => {
    const entry = excerptEntry({ quote: 'x', articleKey: 'k'.repeat(201) });
    assert.deepEqual(entry.meta, {});
    assert.equal(normalizeMeta(entry.meta).article, undefined);
  });

  it('★ 带 `-->` 或换行的 key 不写进 meta（会提前结束那行注释）', () => {
    const entry = excerptEntry({ quote: 'x', articleKey: 'a-->b' });
    // 客户端不拦，宿主白名单会拦 —— 这里断言的是「宿主拦得住」，即不会写坏文件
    assert.equal(normalizeMeta(entry.meta).article, undefined);
  });
});

describe('0.44.9：摘录 —— 组件接线', () => {
  const reader = stripComments(readFileSync(join(pluginRoot, 'src', 'client', 'ReaderPage.jsx'), 'utf8'));

  it('菜单里有「摘录到灵感」', () => {
    assert.match(reader, /摘录到灵感/);
    assert.match(reader, /void excerptToDiary\(\)/);
  });

  it('★ 提示条说清写到哪个模块（用户看的是「私密日记」时不会以为坏了）', () => {
    assert.match(reader, /已摘录到「灵感速记」/);
  });

  it('★ 只在有选中时渲染（不做「常驻 + disabled」）', () => {
    assert.match(reader, /\{passage\?\.quote && \(/, '摘录项没有按「有没有选中」条件渲染');
  });

  it('走的是日记 HTTP 的 append，而不是往别处写', () => {
    assert.match(reader, /await appendDiaryEntry\(entry\)/);
    assert.match(reader, /date: dateKey\(\)/, '没指定日期 —— 会写到哪一天取决于宿主默认值');
  });

  it('失败会说出来', () => {
    const start = reader.indexOf('const excerptToDiary = async () =>');
    assert.ok(start > 0);
    assert.match(reader.slice(start, start + 900), /摘录失败/);
  });
});
