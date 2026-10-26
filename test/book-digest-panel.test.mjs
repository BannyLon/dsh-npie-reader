/**
 * 目录面板的**真渲染**（react-dom/server），不是读源码猜。
 *
 * 盯四件事：
 *  1. **扫描版与「还没抽取」必须是两句话**。前者用户要去 OCR，后者点一下就行 ——
 *     合并成「没有目录」会让扫描版的用户反复点那个永远不会有结果的按钮。
 *  2. **分段方式必须露出来**。用户看到「19 章」会当成书的目录，而 `window` 档
 *     是按 20 页硬切的；面板上那行说明就是用来拆掉这个误会的。
 *  3. **点章节要能跳页**（按钮带着正确的目标页码）。
 *  4. **当前页所在的章要高亮**，否则用户翻到第 87 页时不知道自己在第几章。
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(pluginRoot, 'test', '.build', 'digest-panel.cjs');

let pending;
function loadModule() {
  pending ??= (async () => {
    mkdirSync(dirname(outFile), { recursive: true });
    await esbuild.build({
      stdin: {
        contents: [
          `import React from 'react';`,
          `import { renderToStaticMarkup } from 'react-dom/server';`,
          `import { BookDigestPanel } from ${JSON.stringify(join(pluginRoot, 'src/client/BookDigestPanel.jsx'))};`,
          `import { DigestCard } from ${JSON.stringify(join(pluginRoot, 'src/client/DigestCard.jsx'))};`,
          `export { React, renderToStaticMarkup, BookDigestPanel, DigestCard };`,
        ].join('\n'),
        resolveDir: pluginRoot,
        loader: 'js',
        sourcefile: 'digest-panel-entry.mjs',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      outfile: outFile,
      logLevel: 'warning',
    });
    return import(`${pathToFileURL(outFile).href}?v=${Date.now()}`);
  })();
  return pending;
}

const { React, renderToStaticMarkup, BookDigestPanel, DigestCard } = await loadModule();
const noop = () => {};

const CHAPTERS = [
  { n: 1, title: '自序', startPage: 4, endPage: 5 },
  { n: 2, title: '§01 为什么是 Claude Code', startPage: 6, endPage: 10 },
  { n: 3, title: '§02 10 分钟完成安装', startPage: 11, endPage: 17 },
];

function render(props = {}) {
  return renderToStaticMarkup(React.createElement(BookDigestPanel, {
    book: { id: 'l-1', title: '《测试书》' },
    meta: null,
    outline: [],
    job: null,
    currentPage: 1,
    onStart: noop,
    onClose: noop,
    onJump: noop,
    onRebuild: noop,
    ...props,
  }));
}

describe('空态：还没抽取', () => {
  it('说清楚「还没抽取」并给一个按钮，且承诺不花钱', () => {
    const html = render();
    assert.ok(html.includes('还没有抽取这本书的目录'), html.slice(0, 200));
    assert.ok(html.includes('不调用模型、不花钱'));
    assert.ok(html.includes('抽取目录'));
  });

  it('★ 空态不该出现章节列表或分段方式说明', () => {
    const html = render();
    assert.ok(!html.includes('npr-digest-list'));
    assert.ok(!html.includes('npr-digest-mode'));
  });
});

describe('扫描版：必须与「还没抽取」区分开', () => {
  it('★ 扫描版说「读不了」并给 OCR 建议，而不是给一个抽取按钮', () => {
    const html = render({ meta: { mode: 'scanned' }, outline: [] });
    assert.ok(html.includes('扫描版'), html.slice(0, 200));
    assert.ok(html.includes('OCR'), '没有告诉用户下一步该做什么');
    // 反向对照：扫描版不该出现那个「点一下就好」的按钮 —— 它永远不会有结果。
    assert.ok(!html.includes('抽取目录'), '扫描版仍然显示「抽取目录」按钮');
  });

  /**
   * 0.28.0：插件自己就有识别，而且是**认完直接进分段**的那条路。
   *
   * ★ 以前这里第一种建议是「下载 → ocrmypdf → 作为本地书源加回来」——
   *   一条要用户离开阅读器、装工具、再导一次书的路。把远路写在近路前面，
   *   等于把一个已经在手边的答案藏起来（而它还不花钱、不联网）。
   */
  it('★ 先给插件自己的路（⌘F → 识别整本），再说一劳永逸的外部工具', () => {
    const html = render({ meta: { mode: 'scanned' }, outline: [] });
    assert.ok(html.includes('⌘F'), '没告诉用户识别入口在哪儿');
    assert.ok(html.includes('识别整本'), '没说要识别整本');
    // 声称「认完会自动重新分段」—— 这是 0.28.0 才成立的承诺，写错会让人白等。
    assert.ok(html.includes('会自动重新分段'), '没交代认完会发生什么');
    // 顺序：先近后远。`indexOf` 相等即为反了。
    assert.ok(html.indexOf('⌘F') < html.indexOf('ocrmypdf'), '远路被写在了近路前面');
  });

  it('★ 已经认过一部分：说出「已经识别了 40 / 111 页」，而不是叫他再认一遍整本', () => {
    const html = render({
      meta: { mode: 'scanned', pageCount: 111, extract: { ocrKnown: 40, ocrPages: 38 } },
      outline: [],
    });
    assert.ok(html.includes('已经识别了 40 / 111 页'), html.slice(0, 400));
    // 反向对照：认过 40 页的人不该再看到「还没识别过」那套话（他会以为白认了）。
    assert.ok(!html.includes('识别整本'), '已经在认了，不该再给「识别整本」');
  });

  /**
   * ★ 网盘书的下一步与本地书**不是同一件事**：网盘上那份没法原地 OCR。
   *   只说「给它加一层文字，再重新打开」，网盘书的用户会卡在「我改的是哪个文件」。
   */
  it('★ 网盘书的 OCR 指引必须说清「下载 → OCR → 作为本地书源加回来」', () => {
    const pan = render({ meta: { mode: 'scanned' }, outline: [], book: { id: 'p-1', source: 'pan' } });
    assert.ok(pan.includes('下载'), '没告诉网盘书用户要先下载');
    assert.ok(pan.includes('本地书源'), '没告诉他 OCR 完怎么让插件用上');
    assert.ok(pan.includes('没法原地改'), '没说明为什么不能直接改网盘上那份');

    // 反向对照：本地书不该出现这套网盘流程（否则是在教他做无用功）。
    const local = render({ meta: { mode: 'scanned' }, outline: [], book: { id: 'l-1', source: 'local' } });
    assert.ok(local.includes('OCR'));
    assert.ok(!local.includes('本地书源'), '本地书却被告知要「作为本地书源加进来」');
    assert.ok(!local.includes('下载'), '本地书却被告知要先下载');
  });
});

describe('有目录：章节列表', () => {
  const html = render({ meta: { mode: 'toc', pageCount: 153, chapters: CHAPTERS }, outline: CHAPTERS });

  it('每一章都渲染成一行，带页码范围', () => {
    assert.ok(html.includes('§01 为什么是 Claude Code'));
    assert.ok(html.includes('p.6–10'), html.slice(0, 400));
    assert.equal((html.match(/npr-digest-row/g) ?? []).length, 3);
  });

  it('★ 分段方式必须露出来（用户会把它当成书的真实目录）', () => {
    assert.ok(html.includes('来自书的目录页'), html.slice(0, 400));
  });

  it('★ 页窗兜底要明说「按页分段」，不能伪装成章名', () => {
    const windows = [
      { n: 1, title: '第 1–20 页', startPage: 1, endPage: 20 },
      { n: 2, title: '第 21–40 页', startPage: 21, endPage: 40 },
    ];
    const out = render({ meta: { mode: 'window', pageCount: 40 }, outline: windows });
    assert.ok(out.includes('没有可识别的章节，按页分段'), out.slice(0, 400));
  });

  it('★ 当前页所在的章要高亮（且只有那一章）', () => {
    const out = render({ meta: { mode: 'toc', chapters: CHAPTERS }, outline: CHAPTERS, currentPage: 12 });
    assert.equal((out.match(/is-active/g) ?? []).length, 1);
    // 第 12 页落在第 3 章（11–17）
    const active = out.slice(out.indexOf('is-active'));
    assert.ok(active.includes('§02 10 分钟完成安装'), active.slice(0, 200));
  });

  it('点章节带着正确的目标页码', () => {
    assert.ok(html.includes('跳到第 6 页'), '第 2 章的按钮没有指向 p.6');
  });

  it('★ 卷标题页不显示页码范围（「上册 p.6–6」看着像一章）', () => {
    const withSection = [
      { n: 1, title: '上册', startPage: 1, endPage: 1, section: true },
      { n: 2, title: '第一章 起', startPage: 2, endPage: 9 },
      { n: 3, title: '第二章 承', startPage: 10, endPage: 20 },
    ];
    const out = render({ meta: { mode: 'outline', chapters: withSection }, outline: withSection });
    assert.ok(out.includes('is-section'), '卷标题页没有单独的样式类');
    // 反向对照：正常章节必须照旧显示页码。
    assert.ok(out.includes('p.2–9'));
    assert.ok(!out.includes('p.1–1'), '卷标题页仍然显示了 p.1–1');
  });
});

describe('抽取中：进度直接写在面板上', () => {
  it('running 时显示百分比与「抽取中 x/y」', () => {
    const out = render({ job: { running: true, done: 60, total: 153, phase: 'extract' } });
    assert.ok(out.includes('60/153'), out.slice(0, 300));
    assert.ok(out.includes('npr-digest-bar'));
  });

  it('切章阶段文案要换掉（不是还写「抽取中」）', () => {
    const out = render({ job: { running: true, done: 153, total: 153, phase: 'segment' } });
    assert.ok(out.includes('正在切分章节'), out.slice(0, 300));
  });

  it('★ 失败时要给错误原文与重试，不能只说「失败了」', () => {
    const out = render({ job: { running: false, error: '宿主没有响应' } });
    assert.ok(out.includes('宿主没有响应'));
    assert.ok(out.includes('重试'));
  });
});

describe('已解读的章节打勾', () => {
  it('done 的章显示完成标记，pending 的不显示', () => {
    const meta = {
      mode: 'toc',
      chapters: [
        { n: 1, title: '自序', startPage: 4, endPage: 5, status: 'done' },
        { n: 2, title: '§01', startPage: 6, endPage: 10, status: 'pending' },
        { n: 3, title: '§02', startPage: 11, endPage: 17, status: 'done' },
      ],
    };
    const out = render({ meta, outline: CHAPTERS });
    assert.equal((out.match(/npr-digest-done/g) ?? []).length, 2);
    // ★ 进度是**聚合**出来的：2/3，不是「已完成」。
    assert.ok(out.includes('已解读 2/3'), out.slice(-300));
  });
});

/** 三章都还没解读，带 `chars`（预检要按它算输入量）。 */
const PENDING_META = {
  mode: 'toc',
  pageCount: 17,
  chapters: [
    { n: 1, title: '自序', startPage: 4, endPage: 5, status: 'pending', chars: 5000 },
    { n: 2, title: '§01', startPage: 6, endPage: 10, status: 'pending', chars: 12000 },
    { n: 3, title: '§02', startPage: 11, endPage: 17, status: 'pending', chars: 8000 },
  ],
};

describe('生成解读：预检', () => {
  it('★ 点之前就要报出「几次调用、最多几次、多少输入」', () => {
    // 只写「可能要一会儿」等于让用户闭眼刷卡。
    const out = render({ meta: PENDING_META, outline: CHAPTERS });
    assert.ok(out.includes('生成解读（3 章）'), out.slice(0, 400));
    assert.ok(out.includes('3 次调用'));
    assert.ok(out.includes('最多 6 次'), '「最多」必须说出来：照抄重试会多一次');
    assert.ok(out.includes('2.5 万字'), out.slice(0, 400));
  });

  it('已解读一部分时，按钮改成「继续生成（N 章）」', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[0].status = 'done';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(out.includes('继续生成（2 章）'), out.slice(0, 400));
    // 同时要能看到「已经好了几章」，否则「继续生成 2 章」在「已好 1 章」和
    // 「已好 0 章」两种情况下长得一模一样。
    assert.ok(out.includes('已解读 1/3'));
  });

  it('★ 略过的章不算「待生成」，也不算「已解读」', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[0].status = 'skipped';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(out.includes('生成解读（2 章）'), out.slice(0, 400));
    assert.ok(!out.includes('已解读 1/3'), '跳过的章不能算进已解读');
  });

  it('上次有失败的章 ⇒ 明说「再点一次会重试它们」', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[1].status = 'failed';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(out.includes('1 章上次失败'));
  });
});

describe('生成解读：进行中', () => {
  it('显示进度与「停止」，不再显示「生成解读」按钮', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[0].status = 'done';
    const out = render({ meta, outline: CHAPTERS, generating: true });
    assert.ok(out.includes('npr-digest-stop'));
    assert.ok(out.includes('已解读 1/3'));
    assert.ok(!out.includes('生成解读（'), '生成中不该再出现「生成」按钮');
  });

  it('★ 明说生成跑在宿主后台（关掉面板不会中断）', () => {
    // 不说的话，用户会守着面板不敢关。
    const out = render({ meta: PENDING_META, outline: CHAPTERS, generating: true });
    assert.ok(out.includes('关掉这个面板也不会中断'));
  });

  it('running 的章带「生成中」徽章', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[1].status = 'running';
    const out = render({ meta, outline: CHAPTERS, generating: true });
    assert.ok(out.includes('生成中'));
  });
});

describe('生成解读：全部完成', () => {
  it('全部 done ⇒ 不显示生成按钮，只说结果', () => {
    const meta = structuredClone(PENDING_META);
    for (const chapter of meta.chapters) chapter.status = 'done';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(!out.includes('生成解读（'));
    assert.ok(out.includes('已解读 3/3'));
  });

  it('★ 有略过的章要说出来，别让「已解读 2/3」看起来像少了一章', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[0].status = 'done';
    meta.chapters[1].status = 'done';
    meta.chapters[2].status = 'skipped';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(out.includes('已解读 2/3'));
    assert.ok(out.includes('1 章没有正文，已略过'), out.slice(0, 500));
  });

  /**
   * 用户报的现象：「一旦解读完成，全选和全不选就不能操作了」。
   *
   * 真身是**两个问题叠在一起**：
   *   ① 「全选」在「整本都解读完」时**亮着但不干活** —— `todoN` 是空集，
   *      `allTodoPicked` 的前置条件 `todoN.length > 0` 让它恒为 false，于是按钮
   *      保持可点，点下去 `setSelectedN([])` 什么都不变。用户合理怀疑是坏了。
   *   ② 目录行上的勾选框**一直都在**，只是原生 13px 的浅灰方框在浅灰底上看不见，
   *      于是被当成「选择框没了」。它不能真的去掉：解读完之后，勾它是重做单章的
   *      **唯一入口**（面板自己那句提示就是这么写的）。
   */
  it('★ 全部解读完：「全选」必须灰掉（不可点），并说清怎么重做单章', () => {
    const meta = structuredClone(PENDING_META);
    for (const chapter of meta.chapters) chapter.status = 'done';
    const out = render({ meta, outline: CHAPTERS });
    assert.match(out, /class="npr-digest-link" disabled=""[^>]*>全选/,
      '全部解读完时「全选」仍然可点 —— 点了什么都不会发生，看起来就是坏了');
    assert.ok(out.includes('所有章节都解读过了'), out.slice(0, 800));
    // 反向对照：只勾了一章（还有可勾的待生成章）时，它不能是灰的。
    // ★ 不能用「默认全勾」那种状态做对照 —— 那时 `allTodoPicked` 本来就是 true，
    //   「全选」按设计就该灰（全勾上了还选什么），拿它当对照会得出相反结论。
    const partial = render({ meta: PENDING_META, outline: CHAPTERS, selected: [1] });
    assert.doesNotMatch(partial, /class="npr-digest-link" disabled=""[^>]*>全选/);
  });

  it('★ 全部解读完：计数说「全部 3 章已解读」，而不是误导性的「已选 0 章」', () => {
    const meta = structuredClone(PENDING_META);
    for (const chapter of meta.chapters) chapter.status = 'done';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(out.includes('全部 3 章已解读'), out.slice(0, 800));
    assert.ok(!out.includes('已选 0 章'), '「已选 0 章」听起来像用户还没选，实际是没有可选的章了');
    // 反向对照：有待生成的章时仍然是「已选 N 章」。
    assert.ok(render({ meta: PENDING_META, outline: CHAPTERS }).includes('已选 3 章'));
  });

  it('★ 全部解读完：勾选框**一个都不能少**（重做单章的唯一入口）', () => {
    const meta = structuredClone(PENDING_META);
    for (const chapter of meta.chapters) chapter.status = 'done';
    const out = render({ meta, outline: CHAPTERS });
    assert.equal((out.match(/npr-digest-check"/g) ?? []).length, 3,
      '勾选框被隐藏了 —— 那「要重做某一章，先在目录里勾上它」就成了一句做不到的话');
    assert.ok(!out.includes('npr-digest-check" disabled="'), '已解读的章必须可勾（勾 = 重做）');
  });
});

describe('章节选择：一次只跑勾上的那几章（0.19.0）', () => {
  it('默认勾上「所有待生成的章」，按钮数字 = 勾选数', () => {
    const out = render({ meta: PENDING_META, outline: CHAPTERS });
    assert.ok(out.includes('已选 3 章'), out.slice(0, 500));
    assert.equal((out.match(/npr-digest-check"/g) ?? []).length, 3, '每章都要有一个勾选框');
    assert.equal((out.match(/checked=""/g) ?? []).length, 3, '默认应该全勾上');
  });

  it('★ 勾掉两章之后，按钮上的数字与调用次数**一起**变小', () => {
    // 用户抱怨的原话是「一本书章节太多，这一点一次要耗费好多 token」。判据必须是
    // 两个数字同时变 —— 只改按钮文案而预检仍报全书，用户还是不敢点。
    const out = render({ meta: PENDING_META, outline: CHAPTERS, selected: [2] });
    assert.ok(out.includes('已选 1 章'), out.slice(0, 500));
    assert.ok(out.includes('生成解读（1 章）'));
    assert.ok(out.includes('1 次调用'), '预检没有跟着勾选变');
    assert.ok(!out.includes('2.5 万字'), '预检仍然按全书报输入量');
    assert.equal((out.match(/checked=""/g) ?? []).length, 1, '勾选框状态没有跟着 selected 走');
  });

  it('★ 勾中的章全都已解读 ⇒ 说「重新生成」，不是「继续生成」', () => {
    // 这两种情况下用户点下去的心理预期完全不同：前者是补上没做的，后者是把花钱
    // 生成过的重跑一遍。按钮上写「继续」而实际重做，是很贵的误会。
    const meta = structuredClone(PENDING_META);
    for (const chapter of meta.chapters) chapter.status = 'done';
    const out = render({ meta, outline: CHAPTERS, selected: [1, 2, 3] });
    assert.ok(out.includes('重新生成（3 章）'), out.slice(0, 500));
    assert.ok(!out.includes('继续生成'));
  });

  it('★ 一章都不勾 ⇒ 按钮禁用并说明为什么（不是点了没反应）', () => {
    const out = render({ meta: PENDING_META, outline: CHAPTERS, selected: [] });
    assert.ok(out.includes('disabled'), '按钮没有禁用');
    assert.ok(out.includes('先在上面勾选要解读的章节'), out.slice(0, 600));
    // 反向对照：有勾选时不该出现这句引导（否则它成了常驻的噪音）。
    assert.equal(render({ meta: PENDING_META, outline: CHAPTERS }).includes('先在上面勾选'), false);
  });

  it('全部已解读且没勾任何章 ⇒ 引导语换成「要重做就勾上它」', () => {
    const meta = structuredClone(PENDING_META);
    for (const chapter of meta.chapters) chapter.status = 'done';
    const out = render({ meta, outline: CHAPTERS, selected: [] });
    assert.ok(out.includes('所有章节都解读过了'), out.slice(0, 600));
    assert.ok(out.includes('要重做某一章'), '没有告诉用户怎么重做');
  });

  it('★★ 勾选框与行按钮是**兄弟**（input 不能嵌进 button 里）', () => {
    // ★ 判据用「深度」而不是「两段文字之间有没有 `<button`」：后者在取下标时会
    //   把行按钮自己的开标签也算进去，于是永远为真（一个永远会红的假断言）。
    //   真正要证的是：勾选框出现的位置上，还没闭合的 `<button>` 个数为 0。
    const out = render({ meta: PENDING_META, outline: CHAPTERS });
    const check = out.indexOf('npr-digest-check');
    const row = out.indexOf('npr-digest-row');
    assert.ok(check > 0 && row > check, '勾选框不在行按钮之前（DOM 顺序反了）');
    const before = out.slice(0, check);
    const opens = (before.match(/<button/g) ?? []).length;
    const closes = (before.match(/<\/button>/g) ?? []).length;
    assert.equal(opens, closes, '勾选框落在某个 <button> 里面（非法结构，点击归属不确定）');
    // 反向对照：同一段切法用在「行按钮内部」上必须量出深度 1 —— 否则上面那条
    // 在切法写错时也会通过。
    const insideRow = out.slice(0, out.indexOf('npr-digest-n'));
    assert.equal(
      (insideRow.match(/<button/g) ?? []).length - (insideRow.match(/<\/button>/g) ?? []).length,
      1,
      '深度切法本身失效了（行按钮内部应当量出 1）',
    );
  });

  it('没有正文的章（skipped）勾选框禁用，并说明勾了也没用', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[2].status = 'skipped';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(out.includes('这一章没有正文，勾了也不会生成'), out.slice(0, 600));
  });
});

describe('模型选择：这一次用哪个模型（0.19.0）', () => {
  const catalog = {
    providers: [
      { id: 'free', name: 'Free Provider', models: [{ id: 'free-model', name: '免费模型' }] },
      { id: 'paid', name: 'Paid', models: [] },
    ],
    current: { provider: 'deepseek', model: 'deepseek-chat' },
  };

  it('★ 第一项写出 Harness 当前默认模型的名字（用户要知道「不选」是在用哪个）', () => {
    const out = render({ meta: PENDING_META, outline: CHAPTERS, modelCatalog: catalog });
    assert.ok(out.includes('跟随 Harness 默认模型（deepseek · deepseek-chat）'), out.slice(0, 900));
  });

  it('目录里的每个模型都成为可选项', () => {
    const out = render({ meta: PENDING_META, outline: CHAPTERS, modelCatalog: catalog });
    assert.ok(out.includes('免费模型'));
    assert.ok(out.includes('value="free/free-model"'));
    // 一个模型都没读到的 provider 要说明原因，而不是给一个空的分组。
    assert.ok(out.includes('没读到模型'));
  });

  it('★ 目录还没读到 ⇒ 下拉框禁用并说「正在读取」（不是给一个空下拉框）', () => {
    const out = render({ meta: PENDING_META, outline: CHAPTERS, modelCatalog: null });
    assert.ok(out.includes('正在读取可用模型'));
    assert.ok(out.includes('disabled'));
  });

  it('目录读取失败 ⇒ 说出原因，而不是静默只剩「跟随默认」', () => {
    const out = render({
      meta: PENDING_META, outline: CHAPTERS,
      modelCatalog: { providers: [], current: null, error: 'no llm service' },
    });
    assert.ok(out.includes('读不到模型列表：no llm service'), out.slice(0, 900));
  });

  it('生成中不显示模型下拉框（那一次已经定下来了）', () => {
    const out = render({ meta: PENDING_META, outline: CHAPTERS, generating: true, modelCatalog: catalog });
    assert.equal(out.includes('这一次用哪个模型'), false);
  });
});

describe('状态徽章', () => {
  it('失败带「失败」二字，原因进 title（不是只靠颜色）', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[1].status = 'failed';
    meta.chapters[1].error = '与原文重合 91%，这段是照抄';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(out.includes('>失败<'));
    assert.ok(out.includes('与原文重合 91%'));
  });

  it('略过带「略过」二字', () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[2].status = 'skipped';
    const out = render({ meta, outline: CHAPTERS });
    assert.ok(out.includes('>略过<'));
  });
});

describe('展开要点：与「跳页」是两个热区', () => {
  const doneMeta = () => {
    const meta = structuredClone(PENDING_META);
    meta.chapters[2].status = 'done';
    return meta;
  };

  it('只有 done 的章才有展开箭头', () => {
    const out = render({ meta: doneMeta(), outline: CHAPTERS });
    assert.equal((out.match(/npr-digest-peek/g) ?? []).length, 1);
  });

  it('★★ 箭头与行是**兄弟**：行按钮里不能再套一个 button（非法结构）', () => {
    // `<button>` 套 `<button>` 在 React 里会警告、真机上点击归属也不确定。
    // 断言方式：从行按钮的起点到它自己的闭合标签之间，不允许出现新的 `<button`。
    const out = render({ meta: doneMeta(), outline: CHAPTERS });
    const start = out.indexOf('npr-digest-row');
    assert.ok(start > 0);
    const close = out.indexOf('</button>', start);
    assert.ok(close > start);
    const inner = out.slice(start, close);
    assert.equal(inner.includes('<button'), false, '行按钮里套了 button');
    // 反向对照：箭头确实在行按钮**之后**，不是压根没渲染。
    assert.ok(out.indexOf('npr-digest-peek') > close);
  });

  it('★★ 解读正文**不再**渲染在目录列表里（0.19.0：挪到阅读区上的浮层）', () => {
    // 306px 的栏里塞「总述 + 要点 + 术语」，会把目录挤走大半 —— 用户点开一章的要点，
    // 看到的却是目录没了。正文改由 `DigestCard` 浮在阅读区上。
    const digests = {
      3: { status: 'ready', digest: { format: 'json', summary: '这一章讲安装。', points: ['先装依赖'], terms: [] } },
    };
    const out = render({ meta: doneMeta(), outline: CHAPTERS, expandedN: 3, digests });
    assert.equal(out.includes('这一章讲安装。'), false, '目录列表里仍然渲染了正文');
    assert.equal(out.includes('npr-digest-body'), false, '目录列表里仍然有正文容器');
    // 反向对照：这一章确实是「展开中」的（行上有标记），不是压根没展开 ——
    // 否则上面两条在「展开功能整个坏了」时也会通过。
    assert.ok(out.includes('is-expanded'), '展开状态本身没有渲染出来');
  });
});

describe('章节要点浮层（DigestCard）', () => {
  const chapter = CHAPTERS[2];
  const renderCard = (entry, extra = {}) => renderToStaticMarkup(React.createElement(DigestCard, {
    chapter, entry, onClose: noop, onJump: noop, ...extra,
  }));

  it('带章号、标题、页码与两个动作（跳页 / 收起）', () => {
    const out = renderCard({ status: 'ready', digest: { format: 'json', summary: '讲安装。', points: [], terms: [] } });
    assert.ok(out.includes('§02 10 分钟完成安装'), out.slice(0, 300));
    assert.ok(out.includes('p.11–17'));
    assert.ok(out.includes('跳到第 11 页'));
    assert.ok(out.includes('收起要点'));
  });

  it('展开时渲染 summary / 要点 / 术语', () => {
    const out = renderCard({
      status: 'ready',
      digest: {
        format: 'json',
        summary: '这一章讲安装。',
        points: ['先装依赖', '再跑初始化'],
        terms: [{ term: '初始化', note: '生成配置文件的那一步' }],
      },
    });
    assert.ok(out.includes('这一章讲安装。'));
    assert.ok(out.includes('先装依赖'));
    assert.ok(out.includes('生成配置文件的那一步'));
    assert.ok(out.includes('npr-digest-terms'));
  });

  it('展开但还没取回来 ⇒ 说「正在读取」，不是空白', () => {
    assert.ok(renderCard({ status: 'loading' }).includes('正在读取'));
  });

  it('取失败 ⇒ 显示原因', () => {
    assert.ok(renderCard({ status: 'error', error: '这一章还没有生成解读' }).includes('这一章还没有生成解读'));
  });

  it('★ 模型没按结构化格式返回时要说明（否则用户以为「本来就没有要点」）', () => {
    const out = renderCard({ status: 'ready', digest: { format: 'text', summary: '一段话。', points: [], terms: [] } });
    assert.ok(out.includes('没有按结构化格式返回'));
  });

  it('★ 写出这一章是哪个模型生成的（用户选免费模型就是为了确认这件事）', () => {
    const out = renderCard({
      status: 'ready',
      digest: { format: 'json', summary: 'x', points: [], terms: [], model: 'free-provider/free-model' },
    });
    assert.ok(out.includes('free-provider/free-model'), '没写出实际用的模型');
    // 反向对照：跟随默认时记录的是 `default` —— 那不是一个模型名，不该显示出来，
    // 否则用户会以为有个叫 default 的模型在跑。
    const fallback = renderCard({
      status: 'ready',
      digest: { format: 'json', summary: 'x', points: [], terms: [], model: 'default' },
    });
    assert.equal(fallback.includes('模型 default'), false, '把 default 当成模型名显示出来了');
  });
});

/**
 * 0.24.1：入口从顶部胶囊搬回这一排（用户：「把导出放在菜单条毫无意义……
 * 还不如在生成解读右边放一个 book-to-skill 的按钮」）。
 *
 * 这里守两件事：
 *   1. **没有解读时不可点** —— 技能包的内容就是已有的逐章解读，一章都没有时
 *      导出只会产出一个空索引（用户拿到一个「能装但没用」的包）；
 *   2. 两颗按钮在**同一个** `npr-digest-actions` 里，且导出那颗在后（= 右边）。
 *      几何脚本 `check-book-panel-layout.mjs` 的夹具是照这个结构手写的 ——
 *      这条断言就是**夹具与组件之间的锚**：结构一变，夹具就该跟着改。
 */
describe('0.24.1：book-to-skill 那颗按钮', () => {
  const DIGESTED = [
    { n: 1, title: '自序', startPage: 4, endPage: 5, status: 'done' },
    { n: 2, title: '§01 为什么是 Claude Code', startPage: 6, endPage: 10, status: 'pending' },
  ];
  const pickSkill = (html) => /<button[^>]*class="npr-digest-skill"[^>]*>/.exec(html);

  it('★ 一章解读都没有时，按钮在、但不可点', () => {
    const html = render({ meta: { mode: 'toc', chapters: CHAPTERS }, outline: CHAPTERS });
    assert.ok(html.includes('book-to-skill'), '按钮根本没渲染出来');
    const button = pickSkill(html);
    assert.ok(button !== null, '没找到 book-to-skill 那颗按钮');
    assert.ok(button[0].includes('disabled'), `没有解读却可点：${button[0]}`);
  });

  it('有解读（status=done）时按钮可点', () => {
    const html = render({ meta: { mode: 'toc', chapters: DIGESTED }, outline: DIGESTED });
    const button = pickSkill(html);
    assert.ok(button !== null, '没找到 book-to-skill 那颗按钮');
    assert.ok(!button[0].includes('disabled'), `已有解读却不可点：${button[0]}`);
  });

  it('★ 反向对照：只有「略过」的章不算有解读 —— 它们没有解读产物可拼', () => {
    const skipped = CHAPTERS.map(chapter => ({ ...chapter, status: 'skipped' }));
    const html = render({ meta: { mode: 'toc', chapters: skipped }, outline: skipped });
    const button = pickSkill(html);
    assert.ok(button !== null && button[0].includes('disabled'),
      '「略过」被当成了已解读 ⇒ 导出的会是一个空索引');
  });

  it('★ 两颗按钮在同一个动作排里，book-to-skill 在后（右边），且只有一颗', () => {
    const html = render({ meta: { mode: 'toc', chapters: DIGESTED }, outline: DIGESTED });
    const row = html.indexOf('class="npr-digest-actions"');
    const gen = html.indexOf('class="npr-digest-start"');
    const skill = html.indexOf('class="npr-digest-skill"');
    assert.ok(row >= 0, '没有 npr-digest-actions 这个容器（几何夹具照它写，缺了就对不上）');
    assert.ok(gen > row && skill > gen, `顺序不对：row=${row} gen=${gen} skill=${skill}`);
    // 反向对照：整份 HTML 里只该有一颗 —— 有第二颗就是「两处 busy 态、两处文案」的开端。
    assert.equal((html.match(/npr-digest-skill/g) ?? []).length, 1);
  });
});
