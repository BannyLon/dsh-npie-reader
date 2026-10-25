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

/**
 * ★ 0.25.9：书页上**不许再压常驻说明**。
 *
 * 用户原话：「这个提示不要了」——指的是 0.20.5 加的那条
 * 「这一页没有文字层（扫描图片），选不中文字」，它压在书页下沿，每翻到一页扫描页
 * 就闪一次。删它的理由不是它错，而是**它已经没有信息量**：
 *   ① 扫描页现在会自动本机 OCR（0.24.8），伴读面板里那句「已识别 N 字 · 已交给伴读」
 *      既说了文字从哪来、又给了「查看 / 复制」，比一条只说「选不中」的胶囊有用得多；
 *   ② 这一页是不是扫描页，看一眼就知道（整页是图片）；
 *   ③ 它是 `pointer-events: none` 的绝对定位浮层，翻页瞬间闪一下还容易被读成「出错了」。
 *
 * ★ 为什么这条断言只能读源码：它只在 `status === 'ready'` 且文字层量出 0 个字时
 *   才渲染，而 `renderToString` 不跑 effect ⇒ 真渲染到不了那个分支。
 *   `test/book-hooks-render.test.mjs` 那边负责的是「渲染期不炸」，管不到这里。
 * ⇒ 判据退而求其次，但**反向对照必须成立**：把那一行塞回真源码，判据要变红。
 */
describe('★ 书页上不压常驻说明（0.25.9 删掉的那条）', () => {
  /** 判据：这段源码有没有在书页上画那条常驻说明。返回违规说明的数组。 */
  function noticeViolations(code) {
    const found = [];
    // ① 类名：那条说明的样式钩子（样式定义已随提示一起删了）。
    if (/\bnpr-book-notice\b/.test(code)) {
      found.push('又出现了 npr-book-notice —— 书页下沿那条常驻说明回来了');
    }
    // ② 文案：换个类名但把同一句话说回去，同样是「每页闪一次噪音」。
    if (code.includes('选不中文字')) {
      found.push('又出现了「选不中文字」这句常驻说明');
    }
    // ③ 它当初靠 `textless` 这个状态驱动；状态留着不用，就是下一次被接回去的把手。
    if (/\bsetTextless\s*\(/.test(code)) {
      found.push('又出现了 setTextless( —— 扫描页说明的状态机被接回来了');
    }
    return found;
  }

  it('当前实现没有那条说明', () => {
    assert.deepEqual(noticeViolations(bookReader), []);
  });

  it('★ 反向对照：把 0.20.5 那一行塞回真源码 ⇒ 判据必须变红', () => {
    // 变异的是**真源码**，不是另写一段坏代码 —— 否则这条对照永远绿。
    // 变异体照 0.20.5 的原样补全：状态 + 那一行 JSX（只补 JSX 会漏掉第三条判据，
    // 那样「>= 3」就成了在数我自己刚打的字面量，不是判据真的抓到了三样东西）。
    const mutant = `${bookReader}
  const [textless, setTextless] = useState(false);
  setTextless(false);
              {textless && (
                <p className="npr-book-notice" role="status">这一页没有文字层（扫描图片），选不中文字</p>
              )}`;
    const found = noticeViolations(mutant);
    assert.ok(found.length >= 3, `变异体只被判出 ${found.length} 条，判据太弱：${JSON.stringify(found)}`);
    assert.ok(found.some((item) => item.includes('npr-book-notice')), '必须抓到类名');
    assert.ok(found.some((item) => item.includes('选不中文字')), '必须抓到文案');
    assert.ok(found.some((item) => item.includes('setTextless')), '必须抓到状态机');
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
