/**
 * 阅读器的**渲染与生命周期契约**（源码级守卫）。
 *
 * 这里每一条都对应真机上炸过一次的故障，而它们有一个共同特征：**测试全绿、
 * 构建正常，只有真机点下去才暴露**。
 *
 *   ① 换书 = 整个阅读器变成「阅读器页面加载失败」。
 *      根因：cleanup 里对**文档代理**调 `destroy()`，而 pdf.js 6.4.299 的
 *      `PDFDocumentProxy` 没有这个方法（真跑断言见 `test/pdfjs-vendor.test.mjs`）。
 *      报错在 React 提交阶段同步抛出 ⇒ Error Boundary 接住 ⇒ 界面全没了。
 *
 *   ② 每点一次同一本书都要重新「正在取书…」。
 *      根因：宿主用 `key={book.id}` 挂阅读器，换书就是卸载重挂；文档跟着组件
 *      销毁，于是没有任何东西能被复用。
 *
 *   ③ 滚动一下出现「什么都没有的页面」。
 *      根因：给 canvas 赋 `width` 会**立刻丢弃位图**，而「准备渲染」到「渲染完成」
 *      之间可能隔着一次网盘取字节。直接画可见画布 = 那段空窗期是一片白。
 *
 * 第四条断言（反向对照）把 0.7.0 那份坏实现喂给同一套判据，要求**判据变红** ——
 * 否则这些断言只是把当前实现抄了一遍，改坏了照样绿。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
/** 读源码并**先剥注释**：注释里抄着 `doc.destroy()` 这种反面教材，它不是使用。 */
const readCode = (name) => stripComments(readFileSync(join(clientDir, name), 'utf8'));

const bookReader = readCode('BookReader.jsx');
const pdfjsCode = readCode('pdfjs.js');

/**
 * 判据：这份阅读器实现有没有违反「渲染与生命周期契约」。
 * 返回违规说明的数组（空数组 = 通过）。
 */
function violationsOf(code) {
  const found = [];

  // ① 组件不许自己销毁文档 —— 文档是共享资源，销毁只允许发生在 pdfjs.js 的缓存里。
  //    用**裸调用**判定（`.destroy(`）：`task?.destroy?.()` 那种可选调用不在其列，
  //    因为它在文档代理上会静默变成 no-op，而不是炸掉整棵组件树。
  if (/\.destroy\s*\(/.test(code)) {
    found.push('出现了裸的 .destroy( —— 文档由缓存持有，组件不许销毁它（代理上根本没有这个方法）');
  }

  // ② 打开文档必须走缓存，否则换一次书就丢一次解析结果。
  if (!/openCachedBook\s*\(/.test(code)) found.push('没有走 openCachedBook，文档不会被复用');
  if (/\bopenBook\s*\(/.test(code)) found.push('仍在用不缓存的 openBook(');

  // ③ 重试必须清掉缓存条目：坏文档留在缓存里会让「重试」永远命中同一份。
  if (!/forgetBook\s*\(/.test(code)) found.push('重试路径没有 forgetBook(，坏文档会一直命中缓存');

  // ④ 渲染前不许给**可见画布**赋宽度 —— 那一刻位图被丢弃，等待期就是一片白。
  const renderAt = code.indexOf('pdfPage.render(');
  if (renderAt === -1) {
    found.push('找不到 pdfPage.render( —— 判据失效了，先修断言');
  } else {
    const before = code.slice(Math.max(0, renderAt - 1200), renderAt);
    if (/canvas\.width\s*=/.test(before)) {
      found.push('在 render() 之前就改了可见画布的宽度 —— 等待期画布是白的（空白页的根因）');
    }
  }

  // ⑤ 新的一页必须先落在离屏画布上，再整体提交。
  if (!/drawImage\(\s*offscreen/.test(code)) {
    found.push('没有把离屏画布提交到可见画布（drawImage(offscreen…)）');
  }
  if (!/offscreenOf\s*\(/.test(code)) found.push('没有离屏画布');

  // ⑥ 这一页还没画出来时，滚轮不该继续翻页（惯性会在空窗里连翻出好几张空白）。
  if (!/renderedPageRef\.current\s*!==\s*page[\s\S]{0,80}wheelAccRef\.current\s*=\s*0[\s\S]{0,40}return/.test(code)) {
    found.push('滚轮缺少「当前页还没画完就不翻页」的守卫');
  }

  return found;
}

describe('★ 阅读器的渲染与生命周期契约', () => {
  it('当前实现通过全部判据', () => {
    assert.deepEqual(violationsOf(bookReader), []);
  });

  it('★ 反向对照：0.7.0 的坏实现必须被判红', () => {
    // 这份片段逐字来自出故障的那一版（对代理调 destroy、直接画可见画布、没有缓存）。
    const bad = `
      const { task } = await openBook(pdfjs, { bookId, length: book.size, signal: controller.signal });
      const loaded = await task.promise;
      docRef.current = loaded;
      // cleanup：
      return () => {
        const loaded = docRef.current;
        docRef.current = null;
        if (loaded) void loaded.destroy().catch(() => {});
      };
      // 渲染：
      const viewport = pdfPage.getViewport({ scale: nextScale });
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const renderTask = pdfPage.render({ canvasContext: context, canvas, viewport });
    `;
    const found = violationsOf(bad);
    assert.ok(found.length >= 4, `坏实现只被判出 ${found.length} 条，判据太弱：${JSON.stringify(found)}`);
    assert.ok(found.some((item) => item.includes('裸的 .destroy')), '必须抓到「对文档代理调 destroy」');
    assert.ok(found.some((item) => item.includes('宽度')), '必须抓到「提前清空可见画布」');
    assert.ok(found.some((item) => item.includes('openCachedBook')), '必须抓到「没有缓存」');
  });

  it('★ 整个客户端半区只有 pdfjs.js 碰文档销毁', () => {
    const offenders = [];
    for (const name of readdirSync(clientDir)) {
      if (!/\.(jsx|js)$/.test(name) || name === 'pdfjs.js') continue;
      const code = readCode(name);
      // 可选调用（`.destroy?.(`）也列入：它会静默 no-op 而不是报错，更该被看见。
      if (/\.destroy\s*\?\.?\s*\(/.test(code)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], '文档/任务的销毁只允许在 pdfjs.js 的缓存层发生');
  });
});

describe('★ pdfjs.js 的销毁入口', () => {
  it('销毁取的是 loadingTask（task），不是文档代理', () => {
    assert.match(pdfjsCode, /entry\.task\s*\?\?\s*entry\.doc\?\.loadingTask/,
      'destroyEntry 必须优先用 task，兜底才用 doc.loadingTask');
    // 反向对照：写成 `entry.doc` 就是那个会炸的版本。
    assert.ok(!/const\s+\w+\s*=\s*entry\.doc\s*;/.test(pdfjsCode), '不能把文档代理当销毁句柄');
  });

  it('销毁路径全程吞错 —— 清理失败不该让用户失去整个界面', () => {
    const start = pdfjsCode.indexOf('function destroyEntry');
    assert.notEqual(start, -1, '找不到 destroyEntry，判据失效了');
    const body = pdfjsCode.slice(start, start + 700);
    assert.ok(body.includes('try'), 'destroyEntry 必须包 try —— 否则 cleanup 里的同步抛错会打崩阅读器');
    assert.ok(body.includes('catch'), 'destroyEntry 必须有 catch');
  });

  it('缓存条目的生命周期独立于组件：中止信号是自己的 controller', () => {
    // 若沿用调用方的 signal，「组件一卸载就 abort」会让下一次复用取不到字节 ——
    // 缓存会变成一个看起来命中、实际用不了的坑。
    const start = pdfjsCode.indexOf('async function loadEntry');
    assert.notEqual(start, -1, '找不到 loadEntry，判据失效了');
    const body = pdfjsCode.slice(start, start + 900);
    assert.ok(body.includes('new AbortController()'), 'loadEntry 必须自己造中止信号');
  });
});
