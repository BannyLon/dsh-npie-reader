/**
 * 「四个工具按钮跟着模块走」（0.86.0）。
 *
 * 用户 2026-11-19 的原话：
 *   「不管是切换那个（灵感/日记/读后感），点击文件夹图标打开的都是这个文件夹」
 *   「明明我切到读后感了，点击下载下载的还是日记，这肯定是bug啊」
 *
 * ⇒ 这两条是**同一个成因**：顶栏那四颗按钮长在模块选项卡**上方**，代码里一次都没
 *   读过 `moduleValue`。它们各自对着「整套日记」生效，于是切到哪个模块都一样。
 *
 * ★ 为什么这一层要有牙：坏了以后**界面完全正常** —— 按钮在、点得动、文件也下来了，
 *   只是内容不是这一页的。肉眼看不见，只有打开文件才发现。
 * ★ 必须同时钉住「旧的没坏」：不带 `module` 的调用（工具 / 老客户端）仍要导出
 *   **整天原文**（逐字节可逆）。按模块导出是重拼条目，两条路径的产品性质不同，
 *   一条盖住另一条就是拿可逆性换作用域。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createDiaryStore, diaryFilePath } from '../src/host/diary-store.js';
import { createDiarySecret } from '../src/host/diary-secret.js';
import { stripComments } from '../scripts/strip-comments.mjs';

let home = '';
let store = null;

before(async () => {
  home = await mkdtemp(join(tmpdir(), `npie-diary-scope-${process.pid}-`));
  process.env.DSH_HOME = home;
  store = createDiaryStore({
    log: () => {},
    // 不碰真实钥匙串：私密那半边的用例要能重跑。
    secret: createDiarySecret({ key: Buffer.alloc(32, 5), keyPath: join(home, 'scope.key') }),
  });
  // 10-10：三种模块各一条（私密落在另一个文件里）。
  await store.append({ date: '2026-11-10', time: '09:00', kind: '灵感', body: '第一条灵感正文' });
  await store.append({ date: '2026-11-10', time: '21:00', kind: '读后感', source: '《一本书》', body: '第一篇读后感正文', meta: { book: 'b1' } });
  await store.append({ date: '2026-11-10', time: '23:00', kind: '日记', vis: 'private', body: '一条私密日记正文' });
  // 10-11：两种公开模块。
  await store.append({ date: '2026-11-11', time: '08:00', kind: '灵感', body: '第二条灵感正文' });
  await store.append({ date: '2026-11-11', time: '22:00', kind: '读后感', source: '《另一本书》', body: '第二篇读后感正文', meta: { book: 'b2' } });
  // 10-12：**只有读后感** —— 用来钉「灵感导出里不该出现一天的空气块」。
  await store.append({ date: '2026-11-12', time: '07:00', kind: '读后感', source: '《第三本》', body: '第三篇读后感正文', meta: { book: 'b3' } });
});

after(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('导出：按模块拆条目，不是按目录搬整天', () => {
  it('★ 灵感模块只导出灵感，读后感一条都不进来', async () => {
    const result = await store.exportAll({ module: 'inspiration' });
    assert.equal(result.scope.module, 'inspiration');
    assert.equal(result.total, 2, '只有 10 / 11 两天有灵感');
    assert.equal(result.entries, 2, '条目数要单独给，不能塞进 total（那是「天」）');
    assert.deepEqual(result.files.map((file) => file.name), ['2026-11-10.md', '2026-11-11.md'],
      '★ 10-12 只有读后感 —— 灵感导出里不该出现一个只有 frontmatter 的空块');
    const text = result.files.map((file) => file.text).join('\n');
    assert.match(text, /第一条灵感正文/);
    assert.match(text, /第二条灵感正文/);
    assert.doesNotMatch(text, /读后感正文/, '读后感漏进了灵感导出');
    assert.doesNotMatch(text, /一条私密日记正文/, '私密漏进了灵感导出');
  });

  it('★ 读后感模块只导出读后感（这就是用户报的那一条）', async () => {
    const result = await store.exportAll({ module: 'reflection' });
    assert.equal(result.total, 3);
    assert.equal(result.entries, 3);
    const text = result.files.map((file) => file.text).join('\n');
    assert.match(text, /第一篇读后感正文/);
    assert.match(text, /第三篇读后感正文/);
    assert.doesNotMatch(text, /灵感正文/, '灵感漏进了读后感导出');
  });

  it('重拼出来的仍然是**能还原的文件**：frontmatter 与条目标题行都在', async () => {
    const result = await store.exportAll({ module: 'reflection' });
    const first = result.files[0].text;
    assert.match(first, /^---\ndate: 2026-11-10\ntype: daily\nstatus: 草稿\n---/, 'frontmatter 没了 —— 切回去就不是一天的日记了');
    assert.match(first, /^## 21:00 读后感 · 《一本书》$/m, '标题行（时间 / 类型 / 出处）没了');
    assert.match(first, /<!-- npr \{"book":"b1"\} -->/, '元数据行没了 —— 读后感的「挂在哪本书」会丢');
  });

  it('私密模块只导出私密（不夹带公开日记）', async () => {
    const result = await store.exportAll({ module: 'private', includePrivate: true });
    assert.equal(result.scope.vis, 'private');
    assert.equal(result.total, 1);
    assert.equal(result.entries, 1);
    assert.deepEqual(result.files.map((file) => file.name), ['2026-11-10.private.md']);
    assert.match(result.files[0].text, /一条私密日记正文/);
    assert.doesNotMatch(result.files[0].text, /灵感正文/, '私密导出里混进了公开日记');
  });

  it('★ 反向对照：不带 module 时**行为逐字节不变**（工具与老客户端靠它）', async () => {
    const result = await store.exportAll({});
    assert.equal(result.scope, null);
    assert.equal(result.total, 3, '全部导出仍然是三天的公开日记');
    assert.equal(result.entries, 5);
    assert.equal(result.skippedPrivate, 1, '默认不含私密，但要如实说「有 1 天没导出」');
    // 「可逆」的定义：交给用户的文本与磁盘上的原文逐字节相同。
    const onDisk = await readFile(diaryFilePath('2026-11-10'), 'utf8');
    assert.equal(result.files.find((file) => file.name === '2026-11-10.md').text, onDisk,
      '全部导出被重排了 —— 「按注释切回一天一个 .md」这个性质就没了');
  });

  it('显式要私密时，全天都进来（公开 3 + 私密 1）', async () => {
    const result = await store.exportAll({ includePrivate: true });
    assert.equal(result.total, 4);
    assert.equal(result.entries, 6);
    assert.equal(result.skippedPrivate, 0);
  });
});

describe('搜索：跟着模块走', () => {
  it('读后感模块只命中读后感', async () => {
    const result = await store.search({ query: '正文', module: 'reflection' });
    assert.equal(result.hits.length, 3);
    for (const hit of result.hits) assert.equal(hit.kind, '读后感', `命中了 ${hit.kind}`);
  });

  it('灵感模块只命中灵感（并且不含私密）', async () => {
    const result = await store.search({ query: '正文', module: 'inspiration' });
    assert.equal(result.hits.length, 2);
    for (const hit of result.hits) assert.equal(hit.kind, '灵感');
  });

  it('私密模块只命中私密那半边', async () => {
    const hit = await store.search({ query: '私密', module: 'private', includePrivate: true });
    assert.equal(hit.hits.length, 1);
    assert.equal(hit.hits[0].scope, 'private');
    // 没解锁（路由层不会给 includePrivate）⇒ 搜不到任何东西，而不是搜到公开的。
    const locked = await store.search({ query: '私密', module: 'private' });
    assert.equal(locked.hits.length, 0);
  });

  it('★ 反向对照：不带 module 时仍搜全部（工具不该被界面选项卡限制）', async () => {
    const result = await store.search({ query: '正文' });
    assert.equal(result.hits.length, 5);
  });
});

describe('界面侧：四颗按钮真的把模块传下去了', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const diaryApp = stripComments(readFileSync(join(root, 'src', 'client', 'DiaryApp.jsx'), 'utf8'));
  const api = stripComments(readFileSync(join(root, 'src', 'client', 'diary-api.js'), 'utf8'));

  it('导出 / 文件夹 / 搜索都带当前模块', () => {
    assert.match(diaryApp, /fetchDiaryExport\(\{ module: moduleValue \}\)/, '导出没带模块 —— 又会导出整本日记');
    assert.match(diaryApp, /revealDiaryFolder\(moduleValue\)/, '打开文件夹没带模块 —— 三个模块还是同一个目录');
    assert.match(diaryApp, /searchDiary\(query, 40, moduleValue\)/, '搜索没带模块 —— 读后感里会搜到灵感');
  });

  it('私密模块的下载走两次确认那条路', () => {
    assert.match(diaryApp, /mod\.vis === 'private' \? exportWithPrivate\(\) : exportAll\(\)/,
      '私密模块直接走 exportAll —— 明文会一次点击就落到下载目录');
    assert.match(diaryApp, /fetchDiaryExport\(\{ includePrivate: true, module: 'private' \}\)/,
      '导出私密仍然夹带着公开日记');
  });

  it('垃圾桶只在灵感模块出现（贴图入口只有灵感那条快速记录）', () => {
    assert.match(diaryApp, /moduleValue === 'inspiration' && \(\s*<button[^>]*aria-label="清理没在用的图片"/,
      '垃圾桶进了读后感/私密 —— 一颗不可撤销的清理按钮摆在不相干的页面上');
  });

  it('文件名说出这次导的是什么，不再写死「日记」', () => {
    assert.match(api, /const scope = name === '' \? '日记' : name;/, '没给标签时没有退回「日记」');
    assert.match(api, /-导出-\$\{today\}\.md`/, '文件名不再带标签');
    // 反向锚点：写死的那一行必须已经不存在（它正是用户看到的那句「日记-导出-…」）。
    assert.doesNotMatch(api, /anchor\.download = `日记-导出-/, '文件名又写死成「日记-导出」了');
  });
});
