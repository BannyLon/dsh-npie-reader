/**
 * 电子书对照翻译的判据与磁盘层。
 *
 * 这个文件存在的理由：这一层写错时**页面上不会出现任何异常**，只会出现
 * 「每一段下面挂着别处的译文」——结构完整、行文通顺、位置全错，比「没翻译」
 * 难发现得多。所以这里钉的是四个不会自己叫的行为了：
 *   1. 编号 = **块下标**（跳过 `pre`、空块之后，后面的译文不许前移一格）；
 *   2. 已经是中文的块不送翻（否则对照栏里会出现一段与原文几乎一样的字）；
 *   3. 落盘再读回，键仍是数字（`Map.get('7')` 与 `Map.get(7)` 不相等，
 *      错了的症状是「缓存明明写了却读不到」，且不报错）；
 *   4. 字数对不上的缓存必须失效（换书 / 重新分节后，节号仍指向另一段正文）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  blockCoverage, blockSegments, cjkRatio, contrastRows, entriesOf, mapOfEntries, planBlockChunks,
} from '../src/ebook-translate.js';
import { createEbookTranslationStore } from '../src/host/ebook/translation-store.js';

describe('挑块：哪些块该送去翻译', () => {
  it('英文段落 / 标题 / 列表 / 引用都送，代码块与空块不送', () => {
    const blocks = [
      { k: 'h2', x: 'Chapter One' },
      { k: 'p', x: 'It was a bright cold day in April.' },
      { k: 'pre', x: 'const a = 1;' },
      { k: 'p', x: '   ' },
      { k: 'li', x: 'First item' },
      { k: 'q', x: 'A quoted line' },
    ];
    const ids = blockSegments(blocks).map((s) => s.id);
    assert.deepEqual(ids, [0, 1, 4, 5]);
  });

  it('★ 编号是块下标：跳过的块不会让后面的译文前移一格', () => {
    const blocks = [
      { k: 'p', x: 'One' },
      { k: 'pre', x: 'code' },
      { k: 'p', x: 'Two' },
    ];
    assert.deepEqual(blockSegments(blocks).map((s) => s.id), [0, 2]);
    // 渲染端按同一套下标去取：下标 2 拿到的必须是 "Two" 的译文，
    // 而不是「第 2 个可翻块」的译文（那样会前移一格，Every 段都拿到上一段的译文）。
    const rows = contrastRows(blocks, new Map([[0, '一'], [2, '二']]));
    assert.equal(rows.find((r) => r.i === 0).zh, '一');
    assert.equal(rows.find((r) => r.i === 2).zh, '二');
    // 代码块这一行仍然出现（原文要显示），但译文为空。
    assert.equal(rows.find((r) => r.i === 1).zh, '');
  });

  it('已经是中文的块不送（双语书 / 脚注里的中文不该再译一遍）', () => {
    const blocks = [
      { k: 'p', x: '这是一段本来就用中文写的正文。' },
      { k: 'p', x: 'This one is English.' },
      { k: 'p', x: '混合 mixed 段落，中文占多数。' },
    ];
    assert.deepEqual(blockSegments(blocks).map((s) => s.id), [1]);
  });

  it('没有字母的块不送（页码、分隔符、纯数字）', () => {
    const blocks = [
      { k: 'p', x: '* * *' },
      { k: 'p', x: '12' },
      { k: 'p', x: 'Real text' },
    ];
    assert.deepEqual(blockSegments(blocks).map((s) => s.id), [2]);
  });

  it('非数组 / 空数组不抛，返回空清单', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      assert.deepEqual(blockSegments(bad), [], `没有安全处理 ${String(bad)}`);
    }
  });
});

describe('语言判据：汉字占字母的比例', () => {
  it('纯英文约 0，纯中文 1', () => {
    assert.equal(cjkRatio('hello world'), 0);
    assert.equal(cjkRatio('你好世界'), 1);
  });

  it('★ 分母是字母而不是全部字符：标点与数字不该把英文误判成中文', () => {
    // 若按全字符算，这句里 4 个汉字 / 31 个字符 ≈ 0.13，虽然仍低于阈值，
    // 但同样是「中文为主的短句」会被压到阈值以下，阈值就没有意义了。
    const mixed = '他说：“OK, 2026 — let us go.”';
    const ratio = cjkRatio(mixed);
    assert.ok(ratio > 0 && ratio < 0.5, `比例应落在中间段，实际 ${ratio}`);
  });

  it('空串与纯标点返回 0，不除零', () => {
    assert.equal(cjkRatio(''), 0);
    assert.equal(cjkRatio('—— ... !!!'), 0);
    assert.equal(cjkRatio(null), 0);
  });
});

describe('切批与覆盖率', () => {
  it('一节很短时只有一批，且 segments 与 blockSegments 一致', () => {
    const blocks = [{ k: 'p', x: 'Short.' }, { k: 'p', x: 'Also short.' }];
    const plan = planBlockChunks(blocks);
    assert.equal(plan.segments.length, 2);
    assert.equal(plan.chunks.length, 1);
  });

  it('覆盖率如实反映漏段（界面要靠它说「18 段译出 15 段」）', () => {
    const blocks = [
      { k: 'p', x: 'a' }, { k: 'p', x: 'b' }, { k: 'p', x: 'c' },
    ];
    const { segments } = planBlockChunks(blocks);
    const coverage = blockCoverage(segments, new Map([[0, '甲'], [2, '丙']]));
    assert.deepEqual(coverage, { total: 3, done: 2, ratio: 2 / 3 });
  });

  it('空译文不算「已翻」', () => {
    const segments = [{ id: 0, text: 'a', group: 0 }];
    assert.equal(blockCoverage(segments, new Map([[0, '   ']])).done, 0);
  });
});

describe('落盘形状：键必须还是数字', () => {
  it('entriesOf / mapOfEntries 往返之后仍能用数字下标取到', () => {
    const source = new Map([[0, '零'], [7, '七'], [12, '十二']]);
    const round = mapOfEntries(entriesOf(source));
    assert.equal(round.get(7), '七');
    // ★ 这一条钉的是「字符串键」：JSON 往返会把 7 变成 "7"，
    //   若忘记转回来，`get(7)` 就是 undefined，缓存等于白存。
    assert.equal(round.get('7'), undefined);
  });

  it('entriesOf 按块顺序排好，丢掉空值与非整数键', () => {
    const messy = new Map([[3, 'c'], [0, 'a'], [1, '  '], ['x', 'bad'], [2, 'b']]);
    assert.deepEqual(entriesOf(messy), [[0, 'a'], [2, 'b'], [3, 'c']]);
  });

  it('mapOfEntries 遇到坏数据不抛（一份坏缓存不该让书读不了）', () => {
    assert.equal(mapOfEntries([null, 'x', [1], ['2', 'string key'], [3, 4], [4, 'ok']]).size, 1);
  });
});

describe('渲染行：跳过块不产生错位', () => {
  it('空块直接跳过，但译文的键仍是原下标', () => {
    const blocks = [
      { k: 'p', x: '' },
      { k: 'p', x: 'Hello' },
      { k: 'pre', x: 'code' },
      { k: 'p', x: 'World' },
    ];
    const rows = contrastRows(blocks, new Map([[1, '你好'], [3, '世界']]));
    // 空块（下标 0）整行不出；`pre`（下标 2）出原文、不出译文。
    assert.deepEqual(rows.map((r) => r.i), [1, 2, 3]);
    assert.deepEqual(rows.map((r) => r.x), ['Hello', 'code', 'World']);
    assert.deepEqual(rows.map((r) => r.zh), ['你好', '', '世界']);
  });

  it('缓存里混进 pre 的译文也不渲染（判据与渲染层同一语义）', () => {
    const blocks = [{ k: 'pre', x: 'code' }, { k: 'p', x: 'Text' }];
    const rows = contrastRows(blocks, new Map([[0, '代码'], [1, '文本']]));
    // 代码块原文照旧出现，但译文被强制清空 —— 与 `renderBlocks` 里那条
    // `kind !== 'pre'` 的兜底是同一条规则的两处实现。
    assert.equal(rows[0].k, 'pre');
    assert.equal(rows[0].zh, '');
    assert.equal(rows[1].zh, '文本');
  });
});

describe('磁盘层：原子写 / 并发 / 失效', () => {
  let root = '';
  let store = null;

  before(async () => {
    // ★ 目录名带 pid：同一套件的两个进程同毫秒启动时会共用目录，
    //   产生跨进程串味的偶发失败（这类失败重跑往往不复现）。
    root = await mkdtemp(join(tmpdir(), `npie-ebookl10n-${process.pid}-`));
    store = createEbookTranslationStore({ rootDir: root });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('写入后读回，键是数字', async () => {
    await store.writeSection('b-1', 3, {
      chars: 120, entries: [[0, '零'], [2, '二']], model: 'qwen/qwen3.8-flash',
      coverage: { total: 3, done: 2, ratio: 2 / 3 },
    });
    const back = await store.readSection('b-1', 3, { chars: 120 });
    assert.equal(back.entries.get(2), '二');
    assert.equal(back.model, 'qwen/qwen3.8-flash');
    assert.equal(back.coverage.done, 2);
    assert.deepEqual(await store.listSections('b-1'), [3]);
  });

  it('★ 字数对不上 ⇒ 当作没有缓存（换书后节号可能指向另一段正文）', async () => {
    await store.writeSection('b-2', 1, { chars: 100, entries: [[0, '旧译文']] });
    const hit = await store.readSection('b-2', 1, { chars: 100 });
    assert.equal(hit.entries.get(0), '旧译文');
    assert.equal(await store.readSection('b-2', 1, { chars: 999 }), null);
  });

  it('并发写同一本书的两节，两节都留得住', async () => {
    // 读-合并-写若不在队列里，后写的会把先写的那一节整节抹掉，
    // 症状是「翻完第 3 节，翻第 4 节之后第 3 节又没了」，且没有任何报错。
    await Promise.all([
      store.writeSection('b-3', 1, { chars: 10, entries: [[0, '一']] }),
      store.writeSection('b-3', 2, { chars: 20, entries: [[0, '二']] }),
      store.writeSection('b-3', 3, { chars: 30, entries: [[0, '三']] }),
    ]);
    assert.deepEqual(await store.listSections('b-3'), [1, 2, 3]);
  });

  it('坏 JSON 当作没缓存，不抛', async () => {
    await writeFile(join(root, 'b-bad.json'), '{ this is not json', 'utf8');
    assert.equal(await store.readSection('b-bad', 1), null);
    assert.deepEqual(await store.listSections('b-bad'), []);
  });

  it('版本不符当作没缓存（形状变了要重翻）', async () => {
    await writeFile(join(root, 'b-old.json'), JSON.stringify({ v: 0, sections: { 1: { entries: [[0, 'x']] } } }), 'utf8');
    assert.equal(await store.readSection('b-old', 1), null);
  });

  it('非法 bookId 在拼路径之前就被拒', async () => {
    for (const bad of ['../etc', 'a/b', '/etc/passwd', '', 'a'.repeat(65), '中文']) {
      assert.equal(await store.readSection(bad, 1), null, `读没有拒绝 ${String(bad)}`);
      await assert.rejects(() => store.writeSection(bad, 1, { entries: [[0, 'x']] }), TypeError, `写没有拒绝 ${String(bad)}`);
    }
  });

  it('空 entries 不写盘（避免留下一个「有文件但没内容」的节）', async () => {
    assert.equal(await store.writeSection('b-empty', 1, { entries: [] }), null);
    assert.deepEqual(await store.listSections('b-empty'), []);
  });
});

/**
 * 接线：判据写对了、但没接进渲染或没接进路由，等于没做。
 *
 * ★ 这一组全部读**源码文本**断言，而不是 import 组件：`BookEbook.jsx` 是 JSX，
 *   在 node:test 里要么上构建、要么引入转换器，而这条链路要钉的只是
 *   「那个 map 到底传没传下去」——读文本就够，且跑得快。
 * ★ 每条都带失败文案，写清「改回原样会导致什么」，因为这类静默失效
 *   在 review 时看不出来。
 */
describe('接线：判据真的接进了渲染与宿主', () => {
  let client = '';
  let routes = '';
  let service = '';
  let ai = '';

  before(async () => {
    const read = (rel) => readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
    [client, routes, service, ai] = await Promise.all([
      read('client/BookEbook.jsx'),
      read('host/library-routes.js'),
      read('host/service.js'),
      read('host/ai.js'),
    ]);
  });

  it('★ renderBlocks 收到了译文 map（漏传则对照永远不显示）', () => {
    assert.match(client, /function renderBlocks\(blocks, marksByIndex, findsByBlock, zhMap, mode = 'bilingual'\)/,
      'renderBlocks 没接 zhMap / mode 参数 —— 读法菜单点了不会有任何变化');
    assert.match(client, /renderBlocks\(section\.blocks, marksByIndex, findsByBlock, zhState\.n === page \? zhState\.map : null, readMode\)/,
      '渲染时没把译文 map 与读法传进 renderBlocks，或丢了「这份译文属于当前节」的护栏');
  });

  it('★ 切节那一帧不许显示上一节的译文（`zhState.n === page`）', () => {
    // 少了这个判断：翻到第 4 节时 section 已经换了、zhState 还停在第 3 节，
    // 第 3 节的 map 会被套到第 4 节的块下标上 —— 每段都有译文，只是全都错位，
    // 而且看起来完全正常（块数相近时尤其难发现）。
    assert.match(client, /zhState\.n === page/, '渲染时没校验译文属于哪一节');
    assert.match(client, /n: page, status: 'loading'/, 'loading 状态没记下节号');
  });

  it('译文按**块下标**取，而不是重新算第几个可翻块', () => {
    assert.match(client, /zhMap\?\.get\?\.\(index\)/,
      '取译文的方式变了 —— 若改成按「第 n 个可翻块」取，跳过 pre/空块后每段都会错位');
  });

  it('工具栏有读法菜单（原文 / 对照 / 译文），且切回原文时清空译文', () => {
    // 0.65.0：原来的「对照开关」升级成三选一 —— 两态开关表达不了「全中文」。
    assert.match(client, /npr-book-mode-item/, '工具栏里没有读法菜单的选项');
    assert.match(client, /EBOOK_READ_MODE_ORDER\.map/, '三个读法不是从共用常量里来的（会与宿主校验漂开）');
    for (const key of ['original', 'bilingual', 'translation']) {
      assert.ok(client.includes(key), `读法少了一种：${key}`);
    }
    assert.match(client, /if \(next === 'original'\) \{\s*\n\s*setZhState\(\{ n: null, status: 'idle'/,
      '切回原文时没清空译文 —— 下次切回读法会先闪上一节的译文');
  });

  it('宿主有 l10n 路由，且三种形态（清单 / 单节 / 翻译）都挂了', () => {
    assert.match(routes, /\/book\\\/\(\[A-Za-z0-9_-\]\{1,64\}\)\\\/ebook\\\/l10n/,
      '路由里没有 /book/:id/ebook/l10n');
    assert.match(routes, /translateEbookSection\(book, n, \{ force: body\.force === true \}\)/,
      'POST 没走 translateEbookSection');
    assert.match(routes, /code === 'EBOOK_NO_TEXT'[\s\S]{0,80}?sendJson\(res, 422/,
      '「这一节没有英文」没映射成 422');
  });

  it('service 把三个入口都注入了路由（少一个就 501）', () => {
    for (const name of ['translateEbookSection', 'ebookTranslationOf', 'ebookTranslationIndex']) {
      assert.match(service, new RegExp(`${name}: `), `handlers 里没有 ${name}`);
    }
  });

  it('★ 先读缓存再翻（否则翻回上一页会重花一次钱）', () => {
    assert.match(service, /readSection\(book\.id, order, \{ chars: section\.chars \}\)/,
      'translateEbookSection 没先查缓存');
    assert.match(service, /if \(cached !== null\)[\s\S]{0,200}?cached: true/,
      '缓存命中后没有直接返回');
  });

  it('AI 侧有专门的电子书提示词（不是复用文章那条）', () => {
    assert.match(ai, /const EBOOK_TRANSLATE_PROMPT = /, '没有 EBOOK_TRANSLATE_PROMPT');
    assert.match(ai, /planBlockChunks\(blocks/, '没有走电子书的挑块/切批判据');
  });
});
