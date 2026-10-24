import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SEARCH_LIMITS, matchEntry, normalizeNeedle, snippetAround } from '../src/host/search.js';

describe('normalizeNeedle', () => {
  it('去空白 + 转小写；非字符串当空处理', () => {
    assert.equal(normalizeNeedle('  DeepSeek  '), 'deepseek');
    assert.equal(normalizeNeedle(''), '');
    assert.equal(normalizeNeedle(undefined), '');
    assert.equal(normalizeNeedle(42), '');
  });
});

describe('snippetAround', () => {
  it('命中在中间时两侧加省略号', () => {
    const text = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`;
    const snippet = snippetAround(text, 'needle', 20);
    assert.match(snippet, /^…a+NEEDLEb+…$/);
    assert.ok(snippet.length < text.length);
  });

  it('命中在开头/结尾时不加多余的省略号', () => {
    assert.equal(snippetAround('NEEDLE tail', 'needle'), 'NEEDLE tail');
    assert.equal(snippetAround('head NEEDLE', 'needle'), 'head NEEDLE');
  });

  it('把换行折叠成空格（否则工具输出会被撑成一堆空行）', () => {
    assert.equal(snippetAround('a\n\n  b NEEDLE c', 'needle'), 'a b NEEDLE c');
  });

  it('反向对照：没命中就回空串，不能回整段正文', () => {
    // 回整段的话，每条「命中」都带着几 KB 正文，上下文立刻爆掉。
    assert.equal(snippetAround('a'.repeat(5000), 'needle'), '');
    assert.equal(snippetAround('anything', ''), '');
    assert.equal(snippetAround(undefined, 'x'), '');
  });
});

describe('matchEntry', () => {
  const needle = 'deepseek';

  it('字段优先级：标题 > 中文标题 > 摘要 > 正文', () => {
    assert.equal(matchEntry({ title: 'DeepSeek 发布', body: 'deepseek 相关' }, needle).matchedIn, 'title');
    assert.equal(matchEntry({ titleZh: 'DeepSeek 发布', body: 'deepseek 相关' }, needle).matchedIn, 'titleZh');
    assert.equal(matchEntry({ summary: 'DeepSeek 相关', body: 'deepseek 相关' }, needle).matchedIn, 'summary');
    assert.equal(matchEntry({ body: 'deepseek 相关' }, needle).matchedIn, 'body');
  });

  it('标题命中不回摘录（标题本来就会单独打印）', () => {
    assert.equal(matchEntry({ title: 'DeepSeek 发布' }, needle).snippet, '');
  });

  it('摘要与正文命中要回摘录', () => {
    assert.match(matchEntry({ summary: '关于 DeepSeek 的评估' }, needle).snippet, /DeepSeek/);
    assert.match(matchEntry({ body: `${'x'.repeat(120)}deepseek${'y'.repeat(120)}` }, needle).snippet, /^…/);
  });

  it('大小写不敏感', () => {
    assert.ok(matchEntry({ title: 'DEEPSEEK 周报' }, needle));
  });

  it('反向对照：空检索词一律不命中 —— 否则「不检索」会变成「命中全部」', () => {
    assert.equal(matchEntry({ title: 'anything', body: 'anything' }, ''), null);
  });

  it('反向对照：字段缺失/非字符串不能抛', () => {
    assert.equal(matchEntry({}, needle), null);
    assert.equal(matchEntry(undefined, needle), null);
    assert.equal(matchEntry({ title: null, summary: 42, body: {} }, needle), null);
  });
});

describe('SEARCH_LIMITS', () => {
  it('四个闸门都是正数，且正文相关的闸门比条目闸门更紧', () => {
    // 转正文这一步贵得多，所以「能读多少篇正文」必须小于「能看多少条条目」。
    for (const [name, value] of Object.entries(SEARCH_LIMITS)) {
      assert.ok(Number.isFinite(value) && value > 0, `${name} 必须是正数`);
    }
    assert.ok(SEARCH_LIMITS.maxBodiesPerCall < SEARCH_LIMITS.maxEntriesScanned);
    assert.ok(SEARCH_LIMITS.maxBodyCharsPerEntry * SEARCH_LIMITS.maxBodiesPerCall >= SEARCH_LIMITS.maxBodyCharsTotal);
  });
});
