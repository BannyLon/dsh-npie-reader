/**
 * 抽取与预检：把一本书的正文从渲染进程里抽出来，并在花钱之前算出代价。
 *
 * ★ 全部依赖注入（`doc` 是传进来的），所以能用假 doc 真跑测试 —— 抽取循环是
 *   「分帧 / 分批落盘 / 可中断」三件事叠在一起，只有真跑才看得出哪一步断了。
 *
 * ★ 为什么要分帧（每 N 页 `await` 一次宏任务）：`getTextContent()` 是异步的，
 *   但连续 300 次 await 之间如果没有一次真正的宏任务让出，React 的进度更新会被
 *   全部推迟到循环结束 —— 用户看到的是「点了没反应」然后突然跳到 100%。
 *   真机实测：单页抽取约 9 ms（153 页的书总共 1.4 秒），所以分帧的成本可以忽略。
 */

import { extractPageLines } from './book-view.js';

/** 每多少页落一次盘。20 页 ≈ 20–30 KB，一次 HTTP 请求不显眼。 */
export const EXTRACT_BATCH = 20;

/** 每抽多少页让出一次宏任务（进度条靠它刷新）。 */
const YIELD_EVERY = 4;

/** 让出一次宏任务。 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function abortError() {
  const error = new Error('抽取已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * 解析 PDF 自带书签 → `[{ title, page }]`。
 *
 * `dest` 有三种形态（实测 6.4.299）：数组（`[ref, {name:'XYZ'}, ...]`）、
 * 命名目的地字符串（要先 `getDestination`）、以及缺失。`ref` 可能是**对象引用**，
 * 必须走 `getPageIndex` 才能换成物理页码 —— 直接 `Number(ref)` 会得到 `NaN`。
 *
 * ★ 单条失败只丢那一条：一本 58 条书签的书里有一条解析不出来，不该让整本退化成
 *   「没有目录」。
 */
export async function resolveOutline(doc) {
  const outline = await doc.getOutline().catch(() => null);
  if (!Array.isArray(outline) || outline.length === 0) return [];
  const out = [];
  const walk = async (list) => {
    for (const node of list ?? []) {
      try {
        let dest = node?.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest)) {
          const ref = dest[0];
          const index = typeof ref === 'object' && ref !== null
            ? await doc.getPageIndex(ref)
            : Number(ref);
          if (Number.isInteger(index) && index >= 0) {
            out.push({ title: String(node?.title ?? '').trim(), page: index + 1 });
          }
        }
      } catch {
        // 这一条解析不了（命名目的地不存在、引用坏了）。丢掉它，继续走。
      }
      await walk(node?.items);
    }
  };
  await walk(outline);
  return out;
}

/**
 * 逐页抽正文，每 `batchSize` 页回调一次。
 *
 * @param options.doc - pdf.js 的文档代理（只要有 `numPages` / `getPage` 就够）。
 * @param options.fromPage - 从第几页开始（断点续抽：上次抽到 180 就从 181 开始）。
 * @param options.toPage - 抽到第几页（含）。
 * @param options.onBatch - `async (pages) => void`，每批调一次。**必须 await 完成**
 *   再继续抽 —— 不 await 的话批次的落盘顺序会乱，断点游标会算错。
 * @param options.onProgress - `({ done, total, page }) => void`，每页一次。
 * @param options.signal - 中止信号。
 * @returns `{ pages, from, to, emptyPages }`。
 *
 * ★ `emptyPages` 单独返回：一本 300 页的书里夹着 40 张插图页是常态，界面要能说
 *   「309/312 页有文字」，而不是让用户以为抽失败了。
 */
export async function extractBookPages({
  doc, fromPage = 1, toPage, batchSize = EXTRACT_BATCH,
  onBatch, onProgress, signal,
} = {}) {
  const total = Number(doc?.numPages) || 0;
  if (total === 0) throw new Error('这本书没有页');
  const from = Math.max(1, Math.min(fromPage, total));
  const to = Math.max(from, Math.min(toPage ?? total, total));
  const count = to - from + 1;

  let batch = [];
  let done = 0;
  let emptyPages = 0;

  for (let pageNo = from; pageNo <= to; pageNo += 1) {
    if (signal?.aborted === true) throw abortError();
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const lines = extractPageLines(content?.items);
    // 释放这一页的渲染资源。不做的话，300 页的书会把内存吃到几百 MB（pdf.js 的
    // page 对象持有字体与操作符列表）。
    try { page.cleanup?.(); } catch { /* 已经清理过 */ }
    if (lines.length === 0) emptyPages += 1;
    batch.push({ page: pageNo, lines });
    done += 1;

    if (batch.length >= batchSize) {
      if (typeof onBatch === 'function') await onBatch(batch);
      batch = [];
    }
    if (typeof onProgress === 'function') onProgress({ done, total: count, page: pageNo });
    if (done % YIELD_EVERY === 0) await tick();
  }

  if (batch.length > 0 && typeof onBatch === 'function') await onBatch(batch);
  return { pages: count, from, to, emptyPages };
}

/**
 * 预检：这次解读大概要花多少次模型调用、多少 token。
 *
 * ★ **不报金额**。模型名与价格常变，硬编码的钱数看着精确、实际上必然过期
 *   （book-to-skill 自己也是这么处理的）。报「调用次数 + 输入规模」，用户自己能
 *   对上他买的那档。
 *
 * ★ 调用次数必须**摆在最显眼处**。只给「可能要一会儿」等于让用户闭眼刷卡。
 *
 * @param input.chapters - 章节数组（含 `startPage` / `endPage`）。
 * @param input.pageChars - 每页字符数（`number[]`，下标 0 = 第 1 页）。
 * @returns `{ calls, inputChars, chapterChars, overLong }`
 */
export function estimateDigestCost({ chapters = [], pageChars = [] } = {}) {
  const sumRange = (start, end) => {
    let total = 0;
    for (let page = start; page <= end; page += 1) total += pageChars[page - 1] ?? 0;
    return total;
  };
  const chapterChars = chapters.map(chapter => sumRange(chapter.startPage, chapter.endPage));
  const bodyChars = chapterChars.reduce((sum, value) => sum + value, 0);
  // 每章生成完之后，全书索引那一次调用的输入是**所有章节的解读**，不是原文。
  // 按每章 1500 token 的产物估算。
  const indexChars = chapters.length * 1500;
  return {
    // 逐章各一次 + 全书索引一次
    calls: chapters.length + 1,
    inputChars: bodyChars + indexChars,
    chapterChars,
    // 一章超过 6 万字符（约 4 万 token）就要分片生成，否则要么塞不进上下文、
    // 要么模型只读了前半章。这里只标记出来，分片在生成阶段做。
    overLong: chapterChars.map((chars, index) => (chars > 60000 ? index + 1 : 0)).filter(Boolean),
  };
}

/**
 * 「现在点『生成』会发生什么」—— 直接读 `meta.chapters`，不需要每页的字符数。
 *
 * ★ 为什么不复用上面的 `estimateDigestCost`：那个估的是**原方案**（逐章 + 全书索引
 *   一次），而全书索引是后面版本才做的。现在实际只跑逐章，用那个函数会多报一次调用、
 *   还把「索引产物」算进输入量 —— 预检数字虚高，用户会因此不敢点。
 *   两个函数并存是刻意的：一个描述**将来**，一个描述**现在**。
 *
 * ★ `maxCalls` 是 `calls` 的两倍：每章第一次被判「照抄原文」时会重试一次
 *   （见 `ai.js` 的 `generateChapterDigest`）。预检要说「最多」，不是「大约」。
 *
 * ★ `todoN` 是**默认勾选**的那几章。界面上那个「全选」的初值必须来自这里，
 *   不能在前端再写一遍「哪些章算待生成」—— 同一判据写两处，迟早出现
 *   「按钮说 3 章、勾选列表里 4 个」这种两个数字对不上的界面（本项目踩过）。
 *
 * @param meta - `digests/<bookId>/meta.json` 的内容。
 * @returns `{{todo: number, todoN: number[], done: number, skipped: number, failed: number, chars: number, calls: number, maxCalls: number}}`
 */
export function planDigestRun(meta) {
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
  const count = (status) => chapters.filter(chapter => chapter.status === status).length;
  // `skipped` 的章（卷标题页、正文过短）不会再跑；`done` 的也不跑（除非 force）。
  const todo = chapters.filter(chapter => chapter.status !== 'done' && chapter.status !== 'skipped');
  const chars = todo.reduce((sum, chapter) => sum + (Number.isFinite(chapter.chars) ? chapter.chars : 0), 0);
  return {
    todo: todo.length,
    todoN: todo.map(chapter => chapter.n),
    done: count('done'),
    skipped: count('skipped'),
    failed: count('failed'),
    chars,
    calls: todo.length,
    maxCalls: todo.length * 2,
  };
}

/**
 * 「按**现在勾选的**章跑」会发生什么（勾选为空时 `count` 为 0）。
 *
 * ★ 与 `planDigestRun` 的分工：那个描述「不勾选时的默认行为」，这个描述「这一次」。
 *   两者都只从 `meta.chapters` 取数，不读 `outline` —— 状态只在 meta 里，
 *   拿 outline 去数状态会数出一个永远为 `pending` 的假结果。
 *
 * ★ `allDone` 存在的理由：勾中的章**全部**已经解读过时，这一次不是「继续」而是
 *   「重做」。这两种情况下按钮上的字必须不同 —— 用户点「继续生成」期待的是补上
 *   没做的，结果把 5 章已经花钱生成过的解读全重跑一遍，是很贵的误会。
 *
 * @param meta - `digests/<bookId>/meta.json` 的内容。
 * @param selected - 勾选的章号（数组或 Set）。
 */
export function planSelection(meta, selected) {
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
  const chosen = new Set(selected ?? []);
  const picked = chapters.filter(chapter => chosen.has(chapter.n));
  const done = picked.filter(chapter => chapter.status === 'done').length;
  return {
    count: picked.length,
    done,
    chars: picked.reduce((sum, chapter) => sum + (Number.isFinite(chapter.chars) ? chapter.chars : 0), 0),
    calls: picked.length,
    // 每章第一次被判照抄会重试一次，与 `planDigestRun` 同一个口径。
    maxCalls: picked.length * 2,
    allDone: picked.length > 0 && done === picked.length,
  };
}
