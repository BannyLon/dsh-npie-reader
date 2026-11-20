/**
 * 灵感速记的「事后」逻辑（0.72.0）：草稿 / 回执 / 撤销前的核对。
 *
 * ★ 这一层全是纯函数（`src/client/quick-draft.js`），所以直接用 node:test 测，
 *   不需要 DOM 桩。它们的价值都在**判断**上，不在画面上：
 *   草稿什么时候算过期、什么算坏数据、回执里的数字与界面同不同口径、
 *   点「撤销」时文件里那格还是不是原来那条。
 *
 * ★ 必须扎到的四个洞（每一个都对应一种「看起来在工作、实际是错的」）：
 *   ① **按序号盲删**：回执 8 秒里用户删掉上面一条，同一个 `index` 指向另一条记录；
 *   ② **回执撒谎**：用 `index + 1` 报「今天第 N 条」，而界面那个数排除了读后感；
 *   ③ **空草稿**：把字删光再关掉，下次按 `L` 收到「已恢复…」而框里空空如也；
 *   ④ **草稿丢来源**：在《A 书》没写完的半句，第二天在《B 书》里保存到 B 上。
 *
 * ★ 最后一段跑**真的** store（临时 `DSH_HOME`）验 `listedCount` —— 口径属于宿主，
 *   客户端重算一份就是两套判定，迟早漂开。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createDiaryStore } from '../src/host/diary-store.js';
import {
  acceptImage, applyTag, compareSaved, DRAFT_KEY, DRAFT_TTL_MS, draftWhen, imageMarkdown, IMAGE_MAX_BYTES,
  initialBody, makeDraft, readDraft, receiptText, seedBlock, tagSuggestions, writeDraft, clearDraft,
} from '../src/client/quick-draft.js';

/** 仓库根（本文件在 `test/` 下）。拼接处读源码做静态断言时用。 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 内存版 `localStorage`。`getItem` 必须返回 `null` 而不是 `undefined`（真实现就是 null）。 */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    get size() { return map.size; },
  };
}

const NOW = new Date('2026-11-11T09:30:00+08:00').getTime();

describe('草稿：读', () => {
  it('没存过 → null', () => {
    assert.equal(readDraft(fakeStorage(), NOW), null);
  });

  it('存过 → 正文与来源一起回来（来源错了会把灵感挂到别的书上）', () => {
    const storage = fakeStorage();
    writeDraft(storage, { body: '读到一句好话', source: '《某本书》· 第 3 章', where: '《某本书》· 第 3 章', meta: { book: 'p477', chapter: 3 } }, NOW);
    const draft = readDraft(storage, NOW);
    assert.equal(draft.body, '读到一句好话');
    assert.equal(draft.where, '《某本书》· 第 3 章');
    assert.deepEqual(draft.meta, { book: 'p477', chapter: 3 });
  });

  it('过期（> 24 小时）→ null，且恰好没过期时还在', () => {
    const storage = fakeStorage();
    writeDraft(storage, { body: '昨天的半句' }, NOW - DRAFT_TTL_MS - 1);
    assert.equal(readDraft(storage, NOW), null);
    // 边界：正好 24 小时内还该恢复（`>` 不是 `>=`）。
    writeDraft(storage, { body: '昨天的半句' }, NOW - DRAFT_TTL_MS + 1000);
    assert.equal(readDraft(storage, NOW)?.body, '昨天的半句');
  });

  it('★ 未来时间（时钟回拨）不判过期：否则一次改系统时间就丢掉全部草稿', () => {
    const storage = fakeStorage();
    writeDraft(storage, { body: '时钟跳了' }, NOW + 60_000);
    assert.equal(readDraft(storage, NOW)?.body, '时钟跳了');
  });

  it('坏数据一律当没有（不抛）：JSON 断了 / body 不是串 / at 不是数', () => {
    const broken = fakeStorage({ [DRAFT_KEY]: '{oops' });
    assert.equal(readDraft(broken, NOW), null);
    const wrongBody = fakeStorage({ [DRAFT_KEY]: JSON.stringify({ body: 42, at: NOW }) });
    assert.equal(readDraft(wrongBody, NOW), null);
    const wrongAt = fakeStorage({ [DRAFT_KEY]: JSON.stringify({ body: '有字', at: '昨天' }) });
    assert.equal(readDraft(wrongAt, NOW), null);
    const blank = fakeStorage({ [DRAFT_KEY]: JSON.stringify({ body: '   \n ', at: NOW }) });
    assert.equal(readDraft(blank, NOW), null);
  });

  it('localStorage 取不到（隐私模式 / 非浏览器）→ 静默 null，不炸', () => {
    assert.equal(readDraft(null, NOW), null);
    assert.equal(writeDraft(null, { body: 'x' }, NOW), false);
    assert.equal(clearDraft(null), false);
  });

  it('读不删（读函数有写副作用时，任何「看一眼」的调用点都会吞掉用户的话）', () => {
    const storage = fakeStorage();
    writeDraft(storage, { body: '别删我' }, NOW);
    readDraft(storage, NOW);
    assert.notEqual(storage.getItem(DRAFT_KEY), null);
  });
});

describe('草稿：写', () => {
  it('正文全空 → 顺手清掉，下一次不该「已恢复」一条空内容', () => {
    const storage = fakeStorage();
    writeDraft(storage, { body: '有字' }, NOW);
    writeDraft(storage, { body: '   ' }, NOW);
    assert.equal(storage.getItem(DRAFT_KEY), null);
  });

  it('同一份正文反复写只占一个键（不按上下文各存一份）', () => {
    const storage = fakeStorage();
    writeDraft(storage, { body: 'a' }, NOW);
    writeDraft(storage, { body: 'ab', where: '《x》' }, NOW);
    assert.equal(storage.size, 1);
    assert.equal(readDraft(storage, NOW)?.body, 'ab');
  });

  it('配额满了返回 false 而不是抛（草稿是附加保障，不该让「保存灵感」失败）', () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    assert.equal(writeDraft(storage, { body: '很长很长' }, NOW), false);
  });

  it('clearDraft 返回「原来有没有」', () => {
    const storage = fakeStorage();
    assert.equal(clearDraft(storage), false);
    writeDraft(storage, { body: '有' }, NOW);
    assert.equal(clearDraft(storage), true);
    assert.equal(clearDraft(storage), false);
  });
});

describe('草稿：时间说法', () => {
  const at = (iso) => new Date(iso).getTime();

  it('同一天只说钟点', () => {
    assert.equal(draftWhen(at('2026-11-11T09:12:00+08:00'), NOW), '09:12');
  });

  it('★ 跨夜必须说「昨天」：TTL 是 24 小时，隔夜恢复是常态', () => {
    assert.equal(draftWhen(at('2026-11-10T23:41:00+08:00'), NOW), '昨天 23:41');
  });

  it('分钟补零（`9:5` 会被读成两个数字）', () => {
    assert.equal(draftWhen(at('2026-11-11T09:05:00+08:00'), NOW), '09:05');
  });

  it('更早的日子给「M 月 D 日 HH:MM」，不当成今天', () => {
    assert.equal(draftWhen(at('2026-08-03T21:09:00+08:00'), NOW), '8 月 3 日 21:09');
  });

  it('非法时间给空串（宁可少一句，也不显示 `NaN:NaN`）', () => {
    assert.equal(draftWhen(undefined, NOW), '');
    assert.equal(draftWhen(Number.NaN, NOW), '');
  });
});

describe('回执文案', () => {
  it('有计数有来源：一句说清「第几条」与「挂在哪儿」', () => {
    assert.equal(receiptText({ count: 3, where: '《某本书》· 第 2 章' }), '已记下 · 今天第 3 条 · 挂在《某本书》· 第 2 章上');
  });

  it('第一条也是「第 1 条」（不是「第 0 条」）', () => {
    assert.equal(receiptText({ count: 1 }), '已记下 · 今天第 1 条');
  });

  it('宿主没给 listedCount（老版本）→ 不瞎猜数字，只说记下了', () => {
    assert.equal(receiptText({ where: '《某本书》' }), '已记下 · 挂在《某本书》上');
    assert.equal(receiptText({}), '已记下');
  });

  it('计数为 0 / 非整数 时不报（`第 0 条` 比不报更糟）', () => {
    assert.equal(receiptText({ count: 0 }), '已记下');
    assert.equal(receiptText({ count: '3' }), '已记下');
  });

  it('★ count 用 listedCount（1），不是 index + 1（2）：日记里先写过一篇读后感时', () => {
    // 这条断言在客户端侧只是把约定写死；真口径由下面 `listedCount` 那组跑真 store 验。
    assert.equal(receiptText({ count: 1 }), '已记下 · 今天第 1 条');
    assert.notEqual(receiptText({ count: 1 }), '已记下 · 今天第 2 条');
  });
});

describe('撤销前核对：compareSaved', () => {
  const entries = [
    { scope: 'public', index: 0, body: '第一条' },
    { scope: 'public', index: 1, body: '刚记的这句' },
    { scope: 'private', index: 0, body: '私密第一条' },
  ];

  it('还是我写的那句 → 可以删', () => {
    assert.equal(compareSaved(entries, { scope: 'public', index: 1, body: '刚记的这句' }), 'match');
  });

  it('★ 同一个序号指向别的内容（用户删掉上面一条、文件重排）→ changed，不许删', () => {
    const shifted = [
      { scope: 'public', index: 0, body: '刚记的这句' },
      { scope: 'public', index: 1, body: '用户新写的' },
    ];
    assert.equal(compareSaved(shifted, { scope: 'public', index: 1, body: '刚记的这句' }), 'changed');
  });

  it('★ 公开与私密各有自己的序号：只按 index 找会删错半边', () => {
    // index 0 在两半里都存在；私密那条正文不同 ⇒ 拿 public 去比必须得 changed。
    assert.equal(compareSaved(entries, { scope: 'public', index: 0, body: '私密第一条' }), 'changed');
    assert.equal(compareSaved(entries, { scope: 'private', index: 0, body: '私密第一条' }), 'match');
  });

  it('那条已经没了 → gone（不是错误，是用户自己删掉了）', () => {
    assert.equal(compareSaved([], { scope: 'public', index: 3, body: 'x' }), 'gone');
    assert.equal(compareSaved(undefined, { scope: 'public', index: 0, body: 'x' }), 'gone');
  });

  it('尾随空白不算「改过」（用户只是补了个回车就想撤销）', () => {
    const padded = [{ scope: 'public', index: 0, body: '  刚记的这句\n' }];
    assert.equal(compareSaved(padded, { scope: 'public', index: 0, body: '刚记的这句' }), 'match');
  });
});

/* ------------------------------------------------------------------ *
 * P1：按 L 带入选区（seedBlock）与 # 标签补全
 * ------------------------------------------------------------------ */
describe('seedBlock：把选中那段变成引用块', () => {
  it('空 / 纯空白 → 空串（按 L 时不该在框里留一行空引用）', () => {
    assert.equal(seedBlock(''), '');
    assert.equal(seedBlock('   \n\n '), '');
    assert.equal(seedBlock(undefined), '');
  });

  it('单行 → `> 句子` + 一个空行（用户接着往下写）', () => {
    assert.equal(seedBlock('一句话'), '> 一句话\n\n');
  });

  it('多行每行都加前缀，原文里的空行留成裸 `>`', () => {
    assert.equal(seedBlock('第一行\n\n第二行'), '> 第一行\n>\n> 第二行\n\n');
  });

  it('★ 超长截断（一次全选可以是整章）：截到 500 字并补省略号', () => {
    const block = seedBlock('字'.repeat(1200));
    // `> `（2）+ 500 字 + `…`（1）+ 两个换行（2）
    assert.equal(block.length, 500 + 2 + 1 + 2, '> 前缀 + 500 字 + … + 两个换行');
    assert.ok(block.includes('…'));
  });

  it('limit 可调，且没超长时不加省略号', () => {
    assert.equal(seedBlock('abcdef', 3), '> abc…\n\n');
    assert.doesNotMatch(seedBlock('abc', 10), /…/);
  });

  it('★ 行首的 `##` 被前缀挡掉 —— 这正好避开宿主的「按行首标题切条目」', () => {
    // 裸文本 `## 12:00 灵感` 会被 `parseDay` 当成新条目的标题行；
    // 加了 `> ` 之后它只是引用里的一行字。真解析的判据在下面那组。
    assert.equal(seedBlock('## 12:00 灵感'), '> ## 12:00 灵感\n\n');
  });
});

describe('tagSuggestions：光标前的 # 补什么', () => {
  const tags = [{ tag: '灵感', count: 9, last: '2026-11-10' }, { tag: '灵感碎片', count: 2, last: '2026-11-01' }, { tag: '读书', count: 4, last: '2026-10-20' }];

  it('打了前缀 → 只给以它开头的（最近的在前）', () => {
    const found = tagSuggestions('今天 #灵', 6, tags);
    assert.equal(found.start, 3);
    assert.equal(found.query, '灵');
    assert.deepEqual(found.tags, ['灵感', '灵感碎片']);
  });

  it('★ 刚敲下 `#` 就提示：这时最有用（不用先想起标签全名）', () => {
    assert.deepEqual(tagSuggestions('写点 #', 5, tags)?.tags, ['灵感', '灵感碎片', '读书']);
  });

  it('已经打全了就不再提示自己（按 Tab 只会多一个空格）', () => {
    assert.equal(tagSuggestions('#读书', 3, tags), null);
    // 但还有更长的同前缀项时仍要给。
    assert.deepEqual(tagSuggestions('#灵感', 3, tags)?.tags, ['灵感碎片']);
  });

  it('★ `#` 前面不是空白 → 不提示（`C#` / `a#b` 不是在写标签）', () => {
    assert.equal(tagSuggestions('C#', 2, tags), null);
    assert.equal(tagSuggestions('网址 http://a.com/x#sec', 20, tags), null);
  });

  it('★ 前缀里出现空白 → 不提示（`#今天 天气` 不是一个标签）', () => {
    assert.equal(tagSuggestions('#今天 天气', 6, tags), null);
  });

  it('行首的 `#` 算标签（没有前一个字符也要认）', () => {
    assert.equal(tagSuggestions('#灵', 2, tags)?.tags[0], '灵感');
  });

  it('大小写不敏感，但补进去的是标签本来的写法', () => {
    const mixed = [{ tag: 'AI', count: 1 }];
    assert.deepEqual(tagSuggestions('#a', 2, mixed)?.tags, ['AI']);
  });

  it('纯字符串数组也认（`/tags` 之外的地方可能直接给名字）', () => {
    assert.deepEqual(tagSuggestions('#读', 2, ['读书'])?.tags, ['读书']);
  });

  it('没有候选 / 没在打标签 / 参数不合法 → null', () => {
    assert.equal(tagSuggestions('随便写点', 4, tags), null);
    assert.equal(tagSuggestions('#zzz', 4, tags), null);
    assert.equal(tagSuggestions('#灵', undefined, tags), null);
    assert.equal(tagSuggestions(null, 0, tags), null);
    assert.equal(tagSuggestions('#灵', 2, null), null);
  });

  it('最多 6 个候选', () => {
    const many = Array.from({ length: 20 }, (_, i) => `标签${i}`);
    assert.equal(tagSuggestions('#', 1, many)?.tags.length, 6);
  });
});

describe('applyTag：把候选写进正文', () => {
  it('文末补全 → 补一个空格，光标在它后面（接着打字不会打在井号前）', () => {
    const result = applyTag('今天 #灵', 6, 3, '灵感');
    assert.equal(result.text, '今天 #灵感 ');
    assert.equal(result.caret, result.text.length);
  });

  it('★ 后面还有字 → 不补空格（否则得到 `#标签 ，`）', () => {
    const result = applyTag('#灵，然后', 2, 0, '灵感');
    assert.equal(result.text, '#灵感，然后');
    assert.equal(result.caret, 3, '光标落在标签末尾、标点之前');
  });

  it('替换的是「已经打了一半的前缀」，不是整段', () => {
    const result = applyTag('前半 #读 后半', 5, 3, '读书');
    assert.equal(result.text, '前半 #读书 后半');
  });

  it('参数越界不炸（caret 超过长度 / start 大于 caret）', () => {
    const result = applyTag('abc', 99, 99, 'x');
    assert.equal(result.text, 'abc#x ');
    assert.equal(typeof result.caret, 'number');
  });
});

describe('makeDraft：形状兜底', () => {
  it('缺字段时给安全默认值（`undefined` 写进 localStorage 会变成字符串 "undefined"）', () => {
    const draft = makeDraft({ body: 'x' });
    assert.equal(draft.source, '');
    assert.equal(draft.where, '');
    assert.equal(draft.meta, null);
    assert.ok(Number.isFinite(draft.at));
  });
});

/* ------------------------------------------------------------------ *
 * listedCount：跑真的 store（口径属于宿主）
 * ------------------------------------------------------------------ */
describe('append：listedCount 与引用块解析', () => {
  let home = '';
  let store = null;

  before(async () => {
    // ★ 带 pid：同一套件的两个进程同毫秒启动时，共用临时目录会产生串味的偶发失败。
    home = await mkdtemp(join(tmpdir(), `npie-quick-${process.pid}-`));
    process.env.DSH_HOME = home;
    store = createDiaryStore({ log: () => {} });
  });

  after(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('★ 与日记页灵感模块同口径：排除「读后感」，所以不是 index + 1', async () => {
    const date = '2026-11-11';
    const first = await store.append({ date, kind: '读后感', body: '一篇读后感' });
    assert.equal(first.index, 0);
    assert.equal(first.listedCount, 0, '读后感不进灵感列表');

    const second = await store.append({ date, kind: '灵感', body: '一条灵感' });
    assert.equal(second.index, 1);
    assert.equal(second.listedCount, 1, '回执要说「今天第 1 条」，界面也显示 1 条');
    assert.notEqual(second.listedCount, second.index + 1);
  });

  it('连续两条灵感：第二次是「第 2 条」', async () => {
    const date = '2026-11-12';
    await store.append({ date, kind: '灵感', body: 'A' });
    const result = await store.append({ date, kind: '灵感', body: 'B' });
    assert.equal(result.listedCount, 2);
  });

  it('★ 带进来的引用块写回去仍是**一条**（引文里的 `## 12:00` 被 `> ` 挡在行首之外）', async () => {
    const date = '2026-11-13';
    const body = `${seedBlock('## 12:00 灵感\n原文这一段')}我的想法`;
    const result = await store.append({ date, kind: '灵感', body });
    assert.equal(result.index, 0, '只该有一条，所以序号是 0');
    const day = await store.readFull(date);
    assert.equal(day.entries.length, 1, '引用里的 `## 12:00` 不能切成第二条');
    assert.match(day.entries[0].body, /^> ## 12:00 灵感/m);
    assert.match(day.entries[0].body, /我的想法$/);
  });

  it('反向对照：同样的文字**不加** `> ` 前缀确实会被切成两条 —— 证明上一条有牙', async () => {
    const date = '2026-11-14';
    const naive = await store.append({ date, kind: '灵感', body: '## 12:00 灵感\n原文这一段' });
    assert.equal(naive.index, 1, '宿主按行首 `## HH:MM 类型` 切条目，裸文本就是两条');
    assert.equal((await store.readFull(date)).entries.length, 2);
  });
});

/* ------------------------------------------------------------------ *
 * 打开时框里填什么：草稿优先于种子
 * ------------------------------------------------------------------ */
describe('initialBody：草稿与种子打架时听谁的', () => {
  it('有草稿就用草稿（用户自己打的字比原文重要）', () => {
    assert.equal(initialBody({ body: '没写完的半句' }, '> 原文'), '没写完的半句');
  });

  it('没草稿才用种子', () => {
    assert.equal(initialBody(null, '> 原文\n\n'), '> 原文\n\n');
  });

  it('★ 空草稿不算草稿（否则「按 L 有选区」在某些存储脏数据上会静默失效）', () => {
    assert.equal(initialBody({ body: '   \n' }, '> 原文'), '> 原文');
  });

  it('两者都没有 → 空串（不是 undefined，textarea 拿 undefined 会变成非受控）', () => {
    assert.equal(initialBody(null, ''), '');
    assert.equal(initialBody(undefined, undefined), '');
  });
});

/* ------------------------------------------------------------------ *
 * 接线：两个「搬一行就错、且看不出来」的顺序 / 事件判据
 *
 * ★ 这一组是**源码断言**，它只能证明那行代码还在、且顺序对。它证明不了运行时
 *   行为（那由上面的纯函数与下面的真 store 覆盖）。写在这里是因为这几个坑
 *   都属于「代码看着对、跑起来错」，而且错起来没有报错。
 * ------------------------------------------------------------------ */
describe('接线', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const reader = readFileSync(join(root, 'src/client/ReaderPage.jsx'), 'utf8');
  const quick = readFileSync(join(root, 'src/client/QuickCapture.jsx'), 'utf8');

  it('★ 选区快照必须早于打开浮层：textarea 一聚焦，浏览器就把正文选区折叠掉了', () => {
    const seed = reader.indexOf('setQuickSeed(seedBlock(passage?.quote))');
    const open = reader.indexOf('setQuickOpen(true)');
    assert.ok(seed >= 0, '没找到按 L 时的选区快照');
    assert.ok(open >= 0, '没找到 setQuickOpen(true)');
    assert.ok(seed < open, '快照写在打开之后 —— 那时 `passage` 已经被清空了');
    // 只有一处入口：以后若长出第二个开浮层的地方，它同样得先快照，这条会当场红。
    assert.equal(reader.split('setQuickOpen(true)').length - 1, 1);
  });

  it('浮层把种子接过去了（`seed={quickSeed}`）', () => {
    assert.match(reader, /seed=\{quickSeed\}/);
  });

  it('★ 关浮层时清种子：不清的话下次在没有选区的页按 L 会带出上一次的引用', () => {
    assert.match(reader, /setQuickOpen\(false\);\s*setQuickSeed\(''\)/);
  });

  it('★ 中文输入法组字期间不拦键盘（isComposing 与 keyCode 229 两道都要）', () => {
    assert.match(quick, /event\.isComposing \|\| event\.keyCode === 229/);
  });

  it('标签候选只在有候选时画（`{suggest && (`）', () => {
    assert.match(quick, /\{suggest && \(/);
  });
});

describe('贴图：这张能不能收（acceptImage）', () => {
  it('四种位图都放行', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      assert.equal(acceptImage({ type, size: 1024 }).ok, true, `${type} 被拦了`);
    }
  });

  it('★ 反向对照：SVG 不放行（它是 XML，能带脚本）', () => {
    const verdict = acceptImage({ type: 'image/svg+xml', size: 1024 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /PNG/);
  });

  it('★ 8 MB 是**边界**：正好 8 MB 放行，多 1 字节拒绝', () => {
    assert.equal(acceptImage({ type: 'image/png', size: IMAGE_MAX_BYTES }).ok, true);
    const over = acceptImage({ type: 'image/png', size: IMAGE_MAX_BYTES + 1 });
    assert.equal(over.ok, false);
    // 文案里要带上真实大小：只说「太大了」用户不知道要缩到多少。
    assert.match(over.message, /8\.0 MB|8 MB/);
  });

  it('空文件被拒（0 字节的 file 在剪贴板里真的会出现）', () => {
    assert.equal(acceptImage({ type: 'image/png', size: 0 }).ok, false);
  });

  it('★ 客户端的上限必须与宿主同值（放行后被宿主拒 = 「明明说可以」）', () => {
    const source = readFileSync(join(repoRoot, 'src', 'host', 'diary-assets.js'), 'utf8');
    assert.match(source, /ASSET_MAX_BYTES = 8 \* 1024 \* 1024/,
      '宿主的上限变了 —— 客户端 `IMAGE_MAX_BYTES` 要一起改');
  });
});

describe('贴图：插进正文的格式（imageMarkdown）', () => {
  const url = '/api/dsh-npie-reader/diary/assets/0123456789abcdef.png';

  it('空框里贴：就是一行图片，光标在其后', () => {
    const out = imageMarkdown('', 0, url);
    assert.equal(out.text, `![](${url})`);
    assert.equal(out.caret, out.text.length);
  });

  it('★ 句尾贴：图必须**另起一行**（挤在字中间时，排版上就是一张嵌在段落里的小图）', () => {
    const out = imageMarkdown('想到一件事', 5, url);
    assert.equal(out.text, `想到一件事\n![](${url})`);
    assert.equal(out.caret, out.text.length);
  });

  it('★ 反向对照：句首贴不补前导换行（否则每贴一张就多一行空行）', () => {
    const out = imageMarkdown('想到一件事', 0, url);
    assert.equal(out.text, `![](${url})\n想到一件事`);
  });

  it('紧跟已有换行时不重复补', () => {
    const out = imageMarkdown('上一段\n', 4, url);
    assert.equal(out.text, `上一段\n![](${url})`);
  });

  it('★ 光标不在末尾时，后面的字要留在图的**下一行**，不能被吞进 url 里', () => {
    const out = imageMarkdown('前文后文', 2, url);
    assert.equal(out.text, `前文\n![](${url})\n后文`);
    assert.equal(out.text.slice(out.caret), '后文');
  });

  it('★ url 为空时原样返回（宁可不插，也不要插一条渲染不出来的空图）', () => {
    const out = imageMarkdown('已有内容', 4, '');
    assert.equal(out.text, '已有内容');
    assert.equal(out.caret, 4);
  });

  it('★ 整段贴进去之后仍然只有一个条目（`![]()` 行首不会被当成 `## HH:MM` 标题）', () => {
    // 宿主按行首 `## HH:MM 类型` 切条目；这条断言钉的是「图片行不参与切分」。
    const out = imageMarkdown('', 0, url);
    assert.doesNotMatch(out.text, /^## \d{2}:\d{2}/);
  });
});

describe('贴图：浮层的接线', () => {
  const quick = readFileSync(join(repoRoot, 'src', 'client', 'QuickCapture.jsx'), 'utf8');

  it('粘贴走 onPaste（不是给浮层加一颗选图按钮）', () => {
    assert.match(quick, /onPaste=\{\(event\) => \{ void pasteImage\(event\); \}\}/);
  });

  it('★ 类型/大小不合就**不拦**粘贴 —— 否则文字也一起被吃掉（0.73.1）', () => {
    // 顺序必须是「判 → 拦」。一次粘贴常常同时带文字与图片（从网页、从 Word 复制都是）。
    // 先 preventDefault 再判，图片被拒时那段文字也进不了输入框 —— 屏幕上只剩一句
    // 「只收 PNG…」，而用户刚复制的正文凭空消失了。
    assert.match(quick,
      /const verdict = acceptImage\([^)]*\);\s*\n\s*if \(!verdict\.ok\) \{ setError\(verdict\.message\); return; \}\s*\n\s*event\.preventDefault\(\);/);
  });

  it('★ 反向对照：把 preventDefault 挪回判定之前，上一条必须变红', () => {
    const lines = [
      '    const verdict = acceptImage({ type: file.type, size: file.size });\n',
      '    if (!verdict.ok) { setError(verdict.message); return; }\n',
      '    event.preventDefault();\n',
    ];
    const swapped = quick.replace(lines.join(''), `${lines[2]}${lines[0]}${lines[1]}`);
    assert.notEqual(swapped, quick, '反向对照的替换没生效（原文变了，先更新这三行）');
    assert.doesNotMatch(swapped,
      /const verdict = acceptImage\([^)]*\);\s*\n\s*if \(!verdict\.ok\) \{ setError\(verdict\.message\); return; \}\s*\n\s*event\.preventDefault\(\);/);
  });

  it('★ 上传中不许保存（否则存下一条指向不存在文件的 `![]()`）', () => {
    assert.match(quick, /if \(savingRef\.current \|\| uploading > 0\) return;/);
    assert.match(quick, /disabled=\{saving \|\| uploading > 0 \|\| draft\.trim\(\) === ''\}/);
  });

  it('★ `uploading` 是**计数**不是布尔：连贴两张时第一张落地不能解锁保存', () => {
    // 布尔版本的实际症状：贴两张，第一张落地 → 布尔置回 false → 保存按钮当场解锁 →
    // 用户按 ⌘Enter，存下一条指向**还没落盘**那张图的 `![]()`，回执照样说「已记下」。
    assert.match(quick, /const \[uploading, setUploading\] = useState\(0\);/);
    assert.match(quick, /setUploading\(\(count\) => count \+ 1\)/);
    assert.match(quick, /setUploading\(\(count\) => Math\.max\(0, count - 1\)\)/);
  });

  it('★ 两张图排队插入（不然次序由网络决定，而不是用户按下粘贴的次序）', () => {
    assert.match(quick, /const run = chainRef\.current\.then\(\(\) => insertImage\(file\)\);/);
    assert.match(quick, /chainRef\.current = run\.then\(\(\) => \{\}, \(\) => \{\}\);/);
  });

  it('★ 插入位置取上传完成那一刻的光标（不是按下粘贴时的）', () => {
    assert.match(quick, /const caret = input \? \(input\.selectionStart \?\? input\.value\.length\) : draftRef\.current\.length;/);
  });

  it('★ 不展开 DataTransferItemList：它只是类数组、不实现 Symbol.iterator', () => {
    // 写 `[...items]` 在 Chromium 里会抛 "is not iterable"，而症状是「贴图毫无反应」——
    // 这条判据就是为了让这个写法在源码层就被拦住，不用等真机上碰。
    assert.doesNotMatch(quick, /\[\.\.\.items\]/, '`[...items]` 会抛 TypeError，按下标读');
    assert.match(quick, /items\.length/, '没有按下标遍历 —— 贴图会什么都不做');
  });
});
