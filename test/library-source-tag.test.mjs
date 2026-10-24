/**
 * 书架「来源区分」（0.20.4）的判据。
 *
 * 用户原话（2026-10-23）：「电子书源增加的比较多，你看目前是一个网盘和一个本地目录，
 * 但是在前端显示时都融在一起了。我分不清楚哪个是本地目录下的电子书，哪个是百度网盘
 * 的电子书。」
 *
 * ★ 根因不在界面，在**数据**：0.8.0 把书单拆成「一条源一份」之后，`mergeSources` 只按
 *   `id` 去重，来源这一维在合并那一刻就丢了 —— 剩下的 `book.source` 只能答「网盘还是
 *   本地」，答不了「本地那几个目录里的哪一个」。所以这些判据里**一半是数据侧的**：
 *   ① 每本书到底有没有带上它所在的源（`tagBookSource`）；
 *   ② 打戳发生在**合并前**还是合并后（顺序错了，同一本书的归属会张冠李戴）。
 *
 * ★ 每一条判据都配一条**反向对照**：把「修之前」那一版喂进同一条原式必须变红。
 *   这个项目的规矩是「没有反向对照的判据等于没写」—— 否则它只是在描述实现。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createLibrary, mergeLibraries, tagBookSource } from '../src/host/library.js';
import {
  bookScopes, countSources, filterBooks, parseScope, scopeValue, sourceLabelOf,
} from '../src/library.js';

const SANDBOX = await mkdtemp(join(tmpdir(), 'npie-src-'));
/**
 * 清理失败**不许**让判据变红。
 *
 * ★ 这是本机环境的事实，不是被测行为：这个工作区里的删除操作会被安全策略拦掉
 *   （`EPERM: operation not permitted, unlink …`，`host-library.test.mjs` /
 *   `book-lists.test.mjs` 等同一个原因红着）。把 `after` 写成裸 `rm()` 时，一个
 *   「跑完清场」的动作会让整个文件报 `fail 1` —— 看起来像 25 条判据挂了一条。
 * ★ 断言从不依赖清理是否成功（每个用例只读自己刚写的文件），所以这里用
 *   `catch` 把它降级成「尽力而为」。★ 别把这条当成可以忽略的噪声：
 *   真机（不受限的环境）上它照样会真的删掉。
 */
after(() => rm(SANDBOX, { recursive: true, force: true }).catch(() => {}));

/** 一条接近真机形态的记录（字段名与 0.7.x 生成的书单一致）。 */
function row(overrides = {}) {
  return {
    id: 'b00001',
    filename: '忧郁的热带.pdf',
    abspath: '',
    pan_path: '/我的资源/欧洲文学/忧郁的热带.pdf',
    fs_id: 111,
    ext: 'pdf',
    size: 1024 * 1024,
    top_dir: '欧洲文学',
    series: '',
    year: 2000,
    title: '忧郁的热带',
    ...overrides,
  };
}

/** 规范化之后的书（`normalizeBook` 产出的形态）再手动补上来源戳，用来测共用判据。 */
function tagged(overrides = {}) {
  return {
    id: 'b1',
    title: '一本书',
    ext: 'pdf',
    size: 1000,
    year: 2000,
    series: '',
    topDir: '欧洲文学',
    panPath: '',
    localPath: '',
    source: 'pan',
    fsId: 1,
    renderable: true,
    ...overrides,
  };
}

describe('★ tagBookSource：每本书都要带上「它来自哪份书单」', () => {
  it('打上 listId / listName / listKind，且**不动**原字段', () => {
    const before = [row(), row({ id: 'b00002' })];
    const out = tagBookSource(before, { id: 's-pan', name: 'E书拾取', kind: 'pan' });
    assert.equal(out.length, 2);
    for (const book of out) {
      assert.equal(book.listId, 's-pan');
      assert.equal(book.listName, 'E书拾取');
      assert.equal(book.listKind, 'pan');
    }
    // 原字段全在：戳是**附加**字段，不是替换。
    assert.equal(out[0].id, 'b00001');
    assert.equal(out[0].top_dir, '欧洲文学');
    assert.equal(out[0].fs_id, 111);
    // 不改入参（纯函数）：调用方还要用原数组算 count / bytes。
    assert.equal(before[0].listId, undefined);
  });

  it('「只加不删」的反向对照：若把原字段丢掉，界面上连书名都会消失', () => {
    // 模拟一个「只留戳」的实现 —— 这类写法在重构里很常见（`{ listId: id }`）。
    const onlyTag = (books, list) => (books ?? []).map(() => ({ listId: list.id }));
    const out = onlyTag([row()], { id: 's-pan' });
    assert.equal(out[0].title, undefined, '这条对照本身失效了：它居然还带着 title');
    assert.notEqual(out[0].title, row().title);
  });

  it('没有 id 时原样返回（别给没有来源的书盖一个空戳）', () => {
    const books = [row()];
    assert.equal(tagBookSource(books, undefined), books);
    assert.equal(tagBookSource(books, { id: '' })[0].listId, undefined);
  });
});

describe('★★ 戳必须打在**合并前**：同一本书跟「先到的那条源」走', () => {
  /** 两条源里都有 `b00001`，各自还各有一本独占的书。 */
  const listFor = (file) => ({ id: file, name: file, kind: 'local', root: '', path: join(SANDBOX, `${file}.json`) });

  async function makeLibrary() {
    await writeFile(join(SANDBOX, 'sa.json'), JSON.stringify([
      row(), row({ id: 'b00009', title: '只在 A' }),
    ]));
    await writeFile(join(SANDBOX, 'sb.json'), JSON.stringify([
      row(), row({ id: 'b00010', title: '只在 B' }), row({ id: 'b00011', title: '也只在 B' }),
    ]));
    return createLibrary();
  }

  it('合并后每本书的 listId 就是它所在的那份书单', async () => {
    const library = await makeLibrary();
    const body = await library.load({ lists: [listFor('sa'), listFor('sb')] });
    const byId = Object.fromEntries(body.books.map((book) => [book.id, book]));
    // 两本只有 B 有 ⇒ 必须是 sb。这一条单独就足以说明「来源没在合并时丢掉」。
    assert.equal(byId.b00010.listId, 'sb');
    assert.equal(byId.b00011.listId, 'sb');
    assert.equal(byId.b00009.listId, 'sa');
    // 交集那本：`mergeSources` 去重**保留先出现的一份** ⇒ 归属跟着 A 走。
    assert.equal(byId.b00001.listId, 'sa');
    assert.equal(byId.b00001.listName, 'sa');
    assert.equal(byId.b00001.listKind, 'local');
  });

  it('★ 反向对照：先合并再打戳，就只能给**所有**书盖同一个戳（这正是要避免的形态）', async () => {
    const library = await makeLibrary();
    const body = await library.load({ lists: [listFor('sa'), listFor('sb')] });
    const wrong = tagBookSource(mergeLibraries(body.sources).books, listFor('sa'));
    const byId = Object.fromEntries(wrong.map((book) => [book.id, book]));
    // 先合并再打戳时，B 独占的那两本会被错标成 A —— 界面上会显示「本地 · sa」。
    assert.equal(byId.b00010.listId, 'sa', '这条对照失效了：先合并再打戳居然也能分出源');
    assert.notEqual(byId.b00010.listId, 'sb');
  });

  it('外部书单也带戳，kind 是 external（界面上显示成「外部 · 外部书单」）', async () => {
    const external = join(SANDBOX, 'external.json');
    await writeFile(external, JSON.stringify([row({ id: 'b00077' })]));
    const library = createLibrary();
    const body = await library.load({ externalPath: external });
    const book = body.books.find((item) => item.id === 'b00077');
    assert.equal(book.listKind, 'external');
    assert.equal(book.listName, '外部书单');
    assert.equal(sourceLabelOf(book).text, '外部书单');
  });
});

describe('★ filterBooks：来源与分类必须**成对**判', () => {
  /**
   * 两个源里各有一个叫「欧洲文学」的目录 —— 这正是真机形状（网盘和本地目录都会
   * 按丛书/品类分目录），也是「只按 dir 筛会混源」这个缺陷的温床。
   */
  const books = [
    tagged({ id: 'p1', listId: 's-pan', listName: 'E书拾取', listKind: 'pan', topDir: '欧洲文学' }),
    tagged({ id: 'p2', listId: 's-pan', listName: 'E书拾取', listKind: 'pan', topDir: '欧洲文学' }),
    tagged({ id: 'l1', listId: 's-local', listName: 'NPIE_Book', listKind: 'local', topDir: '欧洲文学', source: 'local' }),
    tagged({ id: 'l2', listId: 's-local', listName: 'NPIE_Book', listKind: 'local', topDir: '计算机', source: 'local' }),
  ];

  it('选「网盘 · 欧洲文学」只出网盘那两本', () => {
    const ids = filterBooks(books, { listId: 's-pan', dir: '欧洲文学' }).map((book) => book.id);
    assert.deepEqual(ids.sort(), ['p1', 'p2']);
  });

  it('选「本地 · 欧洲文学」只出本地那一本', () => {
    const ids = filterBooks(books, { listId: 's-local', dir: '欧洲文学' }).map((book) => book.id);
    assert.deepEqual(ids, ['l1']);
  });

  it('只给 listId（整个源）⇒ 组内全部；只给 dir ⇒ **混源**（所以界面上不许只传 dir）', () => {
    assert.equal(filterBooks(books, { listId: 's-local' }).length, 2);
    assert.equal(filterBooks(books, { dir: '欧洲文学' }).length, 3);
  });

  it('★ 反向对照：把 `listId` 那一行判据去掉（旧行为），同一条断言必须变红', () => {
    // 逐字模拟 0.9.x：只在结果上按 `topDir` 过一遍。
    const old = filterBooks(books, {}).filter((book) => book.topDir === '欧洲文学');
    assert.deepEqual(old.map((book) => book.id).sort(), ['l1', 'p1', 'p2']);
    // 三个 id 里混了两个源 ⇒ 与「选网盘 · 欧洲文学」应得的 ['p1','p2'] 不同。
    assert.notDeepEqual(old.map((book) => book.id).sort(), ['p1', 'p2']);
  });

  it('两个参数留空 = 不过滤（「全部来源」那一项）', () => {
    assert.equal(filterBooks(books, { listId: '', dir: '' }).length, 4);
  });
});

describe('★ sourceLabelOf：徽章与下拉共用同一份文案', () => {
  it('类型 + 书单名：`网盘 · E书拾取`', () => {
    const label = sourceLabelOf(tagged({ listId: 's-pan', listName: 'E书拾取', listKind: 'pan' }));
    assert.deepEqual(label, { text: '网盘 · E书拾取', kind: 'pan', name: 'E书拾取' });
  });

  it('名字已经带类型前缀时**不重复**（`外部书单` + `外部` 不该变 `外部 · 外部书单`）', () => {
    assert.equal(sourceLabelOf(tagged({ listName: '外部书单', listKind: 'external' })).text, '外部书单');
    // 反向对照：无条件拼前缀时会得到重复的那一版。
    const repeated = `外部 · ${'外部书单'}`;
    assert.notEqual(sourceLabelOf(tagged({ listName: '外部书单', listKind: 'external' })).text, repeated);
  });

  it('只有 `book.source`（老数据 / 没打戳）时退回类型名', () => {
    assert.equal(sourceLabelOf(tagged({ source: 'local' })).text, '本地');
    assert.equal(sourceLabelOf(tagged({ source: 'pan' })).text, '网盘');
  });

  it('什么来源信息都没有 ⇒ null（界面据此不渲染徽章）', () => {
    assert.equal(sourceLabelOf(tagged({ source: '' })), null);
    assert.equal(sourceLabelOf(undefined), null);
  });
});

describe('★ bookScopes：下拉的「来源 ▸ 分类」两层结构', () => {
  const books = [
    tagged({ id: 'p1', listId: 's-pan', listName: 'E书拾取', listKind: 'pan', topDir: '欧洲文学' }),
    tagged({ id: 'p2', listId: 's-pan', listName: 'E书拾取', listKind: 'pan', topDir: '欧洲文学' }),
    tagged({ id: 'p3', listId: 's-pan', listName: 'E书拾取', listKind: 'pan', topDir: '计算机' }),
    tagged({ id: 'p4', listId: 's-pan', listName: 'E书拾取', listKind: 'pan', topDir: '' }),
    tagged({ id: 'l1', listId: 's-local', listName: 'NPIE_Book', listKind: 'local', topDir: '计算机' }),
  ];

  it('按来源分组、组内按分类分组，计数各算各的', () => {
    const groups = bookScopes(books);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((group) => group.id), ['s-pan', 's-local']);   // 本数倒序：主库在前
    assert.equal(groups[0].label, '网盘 · E书拾取');
    assert.equal(groups[0].total, 4);
    assert.deepEqual(groups[0].dirs, [
      { key: '欧洲文学', count: 2 },
      { key: '计算机', count: 1 },
    ]);
    assert.deepEqual(groups[1], {
      id: 's-local', label: '本地 · NPIE_Book', kind: 'local', total: 1,
      dirs: [{ key: '计算机', count: 1 }],
    });
  });

  it('分类为空的（直接放在源根下的书）不进 dirs，但计入 total', () => {
    const group = bookScopes(books)[0];
    assert.equal(group.dirs.some((dir) => dir.key === ''), false);
    assert.equal(group.total, group.dirs.reduce((sum, dir) => sum + dir.count, 0) + 1);
  });

  it('★ 反向对照：组内若按目录名字典序排，第一项会是「计算机」而不是 2 本的「欧洲文学」', () => {
    const sorted = [...bookScopes(books)[0].dirs].sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans-CN'));
    assert.equal(sorted[0].key, '计算机');
    assert.notEqual(sorted[0].key, bookScopes(books)[0].dirs[0].key);
  });

  it('没有 listId 的书不进任何组（它们是「没打戳」的老数据）', () => {
    assert.deepEqual(bookScopes([tagged({ id: 'x' })]), []);
  });
});

describe('★ countSources：决定行内要不要挂徽章', () => {
  it('两条同类型（都是本地目录）的源算**两个**', () => {
    const books = [
      tagged({ id: 'a', listId: 's1', listKind: 'local', source: 'local' }),
      tagged({ id: 'b', listId: 's2', listKind: 'local', source: 'local' }),
    ];
    assert.equal(countSources(books), 2);
  });

  it('★ 反向对照：按 `book.source`（本地 / 网盘）去重只会得到 1 —— 那正是「分不清哪个目录」的旧口径', () => {
    const books = [
      tagged({ id: 'a', listId: 's1', listKind: 'local', source: 'local' }),
      tagged({ id: 'b', listId: 's2', listKind: 'local', source: 'local' }),
    ];
    assert.equal(new Set(books.map((book) => book.source)).size, 1);
    assert.notEqual(new Set(books.map((book) => book.source)).size, countSources(books));
  });

  it('0 本 / 1 条源 / 没有戳', () => {
    assert.equal(countSources([]), 0);
    assert.equal(countSources([tagged({ listId: 's1' }), tagged({ listId: 's1' })]), 1);
    assert.equal(countSources([tagged({}), tagged({})]), 0);
  });
});

describe('★ scopeValue / parseScope：下拉值里同时装「来源」和「分类」', () => {
  it('往返一致', () => {
    assert.deepEqual(parseScope(scopeValue('s-pan', '欧洲文学')), { listId: 's-pan', dir: '欧洲文学' });
    assert.deepEqual(parseScope(scopeValue('s-pan')), { listId: 's-pan', dir: '' });
  });

  it('空串 = 两者都不过滤', () => {
    assert.deepEqual(parseScope(''), { listId: '', dir: '' });
    assert.equal(scopeValue(''), '');
  });

  it('书单名里带竖线也不会串味（分隔符是 `\\u0000`，不是 `|`）', () => {
    const value = scopeValue('s|1', 'a|b');
    assert.deepEqual(parseScope(value), { listId: 's|1', dir: 'a|b' });
    assert.notDeepEqual(value.split('|'), ['s', '1', 'a', 'b']);
  });
});
