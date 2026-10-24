/**
 * 抽取与预检的判据：行重建、书签解析、分批抽取、代价估算。
 *
 * 这个文件存在的理由：抽取循环里三件事叠在一起（分帧、分批落盘、可中断），
 * 任何一件错了都**不会报错** —— 只会在真机上表现为「进度条不动」「断点续抽重来」
 * 或者「章节标题全都对不上」。所以用假 doc 真跑循环，把顺序与次数钉死。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPageLines } from '../src/client/book-view.js';
import { estimateDigestCost, extractBookPages, planDigestRun, planSelection, resolveOutline } from '../src/client/book-digest.js';

/** 造一个 pdf.js 的文本项。 */
const run = (str, eol = false) => ({ str, hasEOL: eol });

/** 造一个只有 `numPages` / `getPage` 的假文档。`pages[i]` 是第 i+1 页的 items。 */
function fakeDoc(pages, extra = {}) {
  return {
    numPages: pages.length,
    async getPage(index) {
      return {
        async getTextContent() { return { items: pages[index - 1] }; },
        cleanup() {},
      };
    },
    async getOutline() { return null; },
    ...extra,
  };
}

describe('extractPageLines：保留行结构', () => {
  it('★ 同一行的中文游程必须直接拼，不能补空格', () => {
    // 分段判据全靠「行」：补空格会把行均长撑大、把「页首行以标题开头」判死。
    // 反向对照：如果实现改成空格 join，这里会得到「推荐序二 在 工作中」而失败。
    const items = [run('推荐序二'), run('在工作中体会生命的精彩', true), run('正文'), run('继续', true)];
    assert.deepEqual(extractPageLines(items), ['推荐序二在工作中体会生命的精彩', '正文继续']);
  });

  it('★ 英文游程之间要补空格（英文的游程是「词」不是「字」）', () => {
    const items = [run('The'), run('book'), run('explains', true)];
    assert.deepEqual(extractPageLines(items), ['The book explains']);
  });

  it('反向对照：中文与英文混排时只在该补的地方补', () => {
    const items = [run('用'), run('Claude'), run('写代码', true)];
    assert.deepEqual(extractPageLines(items), ['用Claude写代码']);
  });

  it('hasEOL 断行，空行丢掉', () => {
    const items = [run('第一行', true), run('', true), run('第三行', true)];
    assert.deepEqual(extractPageLines(items), ['第一行', '第三行']);
  });

  it('没有 hasEOL 的整页拼成一行', () => {
    assert.deepEqual(extractPageLines([run('只有一行')]), ['只有一行']);
  });

  it('★ 行数上限生效（一本 300 页的书不该让一页撑爆内存）', () => {
    const items = Array.from({ length: 50 }, (_, i) => run(`第${i}行`, true));
    assert.equal(extractPageLines(items, { maxLines: 10 }).length, 10);
  });

  it('扫描页（没有文本项）返回空数组，不是 [""]', () => {
    assert.deepEqual(extractPageLines([]), []);
    assert.deepEqual(extractPageLines(undefined), []);
    assert.deepEqual(extractPageLines([run(''), run('', true)]), []);
  });
});

describe('resolveOutline：书签 → 页码', () => {
  it('★ 对象引用要走 getPageIndex（直接 Number(ref) 会得到 NaN）', async () => {
    const doc = fakeDoc([[], [], []], {
      async getOutline() { return [{ title: '第二章', dest: [{ index: 1 }, { name: 'XYZ' }] }]; },
      async getPageIndex(ref) { return ref.index; },
    });
    assert.deepEqual(await resolveOutline(doc), [{ title: '第二章', page: 2 }]);
  });

  it('命名目的地要先 getDestination', async () => {
    const doc = fakeDoc([[], [], []], {
      async getOutline() { return [{ title: '第三章', dest: 'chapter3' }]; },
      async getDestination(name) { return name === 'chapter3' ? [{ index: 2 }] : null; },
      async getPageIndex(ref) { return ref.index; },
    });
    assert.deepEqual(await resolveOutline(doc), [{ title: '第三章', page: 3 }]);
  });

  it('★ 单条坏掉只丢那一条，不拖垮整本', async () => {
    const doc = fakeDoc([[], [], []], {
      async getOutline() {
        return [
          { title: '好的一', dest: [{ index: 0 }] },
          { title: '坏的', dest: 'missing' },
          { title: '好的二', dest: [{ index: 2 }] },
        ];
      },
      async getDestination() { return null; },
      async getPageIndex(ref) { return ref.index; },
    });
    assert.deepEqual((await resolveOutline(doc)).map(x => x.title), ['好的一', '好的二']);
  });

  it('没有书签返回空数组', async () => {
    assert.deepEqual(await resolveOutline(fakeDoc([[]])), []);
  });

  it('嵌套子项要摊平（目录树不是一层）', async () => {
    const doc = fakeDoc([[], [], []], {
      async getOutline() {
        return [{ title: '卷', dest: [{ index: 0 }], items: [{ title: '篇', dest: [{ index: 1 }] }] }];
      },
      async getPageIndex(ref) { return ref.index; },
    });
    assert.deepEqual((await resolveOutline(doc)).map(x => x.page), [1, 2]);
  });
});

describe('extractBookPages：分批抽取', () => {
  it('按 batchSize 分批回调，页数一条不少', async () => {
    const pages = Array.from({ length: 7 }, (_, i) => [run(`第${i + 1}页`, true)]);
    const batches = [];
    const result = await extractBookPages({
      doc: fakeDoc(pages),
      batchSize: 3,
      onBatch: async (batch) => { batches.push(batch.map(p => p.page)); },
    });
    assert.deepEqual(batches, [[1, 2, 3], [4, 5, 6], [7]]);
    assert.equal(result.pages, 7);
  });

  it('★ 断点续抽：从第 4 页开始时，前面的页不再被抽', async () => {
    const pages = Array.from({ length: 6 }, (_, i) => [run(`p${i + 1}`, true)]);
    const seen = [];
    await extractBookPages({
      doc: fakeDoc(pages), fromPage: 4, batchSize: 2,
      onBatch: async (batch) => { seen.push(...batch.map(p => p.page)); },
    });
    assert.deepEqual(seen, [4, 5, 6]);
  });

  it('★ 进度回调每页一次，且 done 单调递增', async () => {
    const pages = Array.from({ length: 5 }, () => [run('x', true)]);
    const progress = [];
    await extractBookPages({ doc: fakeDoc(pages), onProgress: (p) => progress.push(p.done) });
    assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  });

  it('★ 中止信号在页与页之间生效（不是抽完才理）', async () => {
    const pages = Array.from({ length: 10 }, () => [run('x', true)]);
    const controller = new AbortController();
    const seen = [];
    await assert.rejects(
      () => extractBookPages({
        doc: fakeDoc(pages), batchSize: 2, signal: controller.signal,
        onBatch: async (batch) => { seen.push(batch.length); controller.abort(); },
      }),
      (error) => error.name === 'AbortError',
    );
    // 反向对照：中断之后不该继续把 10 页抽完。
    assert.ok(seen.length <= 2, `中断后还跑了 ${seen.length} 批`);
  });

  it('空页单独计数（界面要能说「309/312 页有文字」）', async () => {
    const pages = [[run('a', true)], [], [run('c', true)], []];
    const result = await extractBookPages({ doc: fakeDoc(pages), onBatch: async () => {} });
    assert.equal(result.emptyPages, 2);
  });

  it('toPage 越界时夹到末页', async () => {
    const pages = Array.from({ length: 3 }, () => [run('x', true)]);
    const result = await extractBookPages({ doc: fakeDoc(pages), toPage: 99, onBatch: async () => {} });
    assert.equal(result.to, 3);
  });

  it('零页文档直接报错，不返回空结果', async () => {
    await assert.rejects(() => extractBookPages({ doc: { numPages: 0 }, onBatch: async () => {} }), /没有页/);
  });
});

describe('estimateDigestCost：预检估算', () => {
  it('★ 调用次数 = 章节数 + 1（逐章各一次 + 全书索引一次）', () => {
    const chapters = [{ startPage: 1, endPage: 5 }, { startPage: 6, endPage: 10 }];
    const result = estimateDigestCost({ chapters, pageChars: Array(10).fill(1000) });
    assert.equal(result.calls, 3);
    assert.deepEqual(result.chapterChars, [5000, 5000]);
  });

  it('输入规模包含索引那一次的产物（不是原文）', () => {
    const chapters = [{ startPage: 1, endPage: 2 }];
    const result = estimateDigestCost({ chapters, pageChars: [100, 200] });
    // 300 字原文 + 1 章 × 1500 字索引输入
    assert.equal(result.inputChars, 300 + 1500);
  });

  it('★ 超长章要标出来（>6 万字符得先分片）', () => {
    const chapters = [{ startPage: 1, endPage: 1 }, { startPage: 2, endPage: 2 }];
    const result = estimateDigestCost({ chapters, pageChars: [70000, 100] });
    assert.deepEqual(result.overLong, [1]);
  });

  it('没有章节时调用次数是 1，不是 0', () => {
    assert.equal(estimateDigestCost({ chapters: [], pageChars: [] }).calls, 1);
  });
});

describe('planDigestRun：点「生成」之前会跑什么', () => {
  const meta = (statuses, chars = 1000) => ({
    chapters: statuses.map((status, index) => ({ n: index + 1, status, chars })),
  });

  it('全都没跑过 ⇒ todo 等于章数，调用次数等于 todo', () => {
    const plan = planDigestRun(meta(['pending', 'pending', 'pending']));
    assert.equal(plan.todo, 3);
    assert.equal(plan.calls, 3);
    // ★ 最多是两倍：每章第一次被判照抄时会重试一次。
    assert.equal(plan.maxCalls, 6);
  });

  it('★ done 与 skipped 都不计入 todo —— 否则「继续生成」会把已经好的章重跑一遍', () => {
    const plan = planDigestRun(meta(['done', 'skipped', 'pending', 'failed', 'stale']));
    assert.equal(plan.todo, 3, 'pending / failed / stale 三个要跑');
    assert.equal(plan.done, 1);
    assert.equal(plan.skipped, 1);
    assert.equal(plan.failed, 1);
  });

  it('输入量只算要跑的那几章（拿全书的量报数会把人吓退）', () => {
    const plan = planDigestRun({
      chapters: [
        { n: 1, status: 'done', chars: 99999 },
        { n: 2, status: 'pending', chars: 1000 },
        { n: 3, status: 'pending', chars: 2000 },
      ],
    });
    assert.equal(plan.chars, 3000);
  });

  it('全部完成 ⇒ todo 为 0，界面据此不再显示「生成」按钮', () => {
    const plan = planDigestRun(meta(['done', 'done']));
    assert.equal(plan.todo, 0);
    assert.equal(plan.maxCalls, 0);
  });

  it('★ 缺 chars / 缺 meta 时不产生 NaN', () => {
    // NaN 会一路渗进界面（「约 NaN 万字输入」），而它不会抛错。
    assert.equal(planDigestRun({ chapters: [{ n: 1, status: 'pending' }] }).chars, 0);
    assert.equal(planDigestRun(null).todo, 0);
    assert.equal(planDigestRun({}).chars, 0);
  });

  it('★ `todoN` 与 `todo` 必须是**同一批**章（勾选初值就来自它）', () => {
    // 界面上「全选」的初值、按钮上的数字都从这两个值派生。两者对不上，就会出现
    // 「按钮说 3 章、勾选列表里 4 个」这种自相矛盾的界面 —— 而两个数字各自都"算对了"。
    const plan = planDigestRun(meta(['done', 'pending', 'skipped', 'failed']));
    assert.equal(plan.todo, 2);
    assert.deepEqual(plan.todoN, [2, 4]);
    assert.equal(plan.todoN.length, plan.todo);
  });
});

describe('planSelection：按勾选算这一次的代价', () => {
  const meta = {
    chapters: [
      { n: 1, status: 'pending', chars: 1000 },
      { n: 2, status: 'done', chars: 2000 },
      { n: 3, status: 'failed', chars: 3000 },
      { n: 4, status: 'skipped', chars: 4000 },
    ],
  };

  it('只算勾中的那几章：章数、输入量、调用次数', () => {
    const plan = planSelection(meta, [1, 3]);
    assert.equal(plan.count, 2);
    assert.equal(plan.chars, 4000);
    assert.equal(plan.calls, 2);
    assert.equal(plan.maxCalls, 4);
  });

  it('★ 勾中的全是已解读 ⇒ allDone（界面据此说「重新生成」而不是「继续生成」）', () => {
    assert.equal(planSelection(meta, [2]).allDone, true);
    // 反向对照：混进一章没解读的，就不是 allDone。
    assert.equal(planSelection(meta, [2, 1]).allDone, false);
    // 一章都没勾时 allDone 必须是 false —— 否则按钮会显示「重新生成（0 章）」。
    assert.equal(planSelection(meta, []).allDone, false);
  });

  it('★ 勾了不存在的章号 ⇒ 不计入（宿主也会忽略它）', () => {
    const plan = planSelection(meta, [99]);
    assert.equal(plan.count, 0);
    assert.equal(plan.chars, 0);
  });

  it('缺 meta / 缺 chars 时不产生 NaN', () => {
    assert.equal(planSelection(null, [1]).count, 0);
    assert.equal(planSelection({ chapters: [{ n: 1, status: 'pending' }] }, [1]).chars, 0);
  });
});
