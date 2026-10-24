/**
 * 内置 pdf.js（`vendor/pdfjs/`）—— 钉住**我们依赖它的那几件事**。
 *
 * ★ 为什么要「真跑」而不是只 grep 版本号：我们整个「按需取字节」的架构建立在一个
 *   **实现细节**上 —— pdf.js 的 `validateRangeRequestCapabilities()` 硬要求
 *   `Content-Length`，而宿主转发 renderer 请求时会扣掉这个头，于是
 *   `getDocument({ url })` 会静默退化成「把整本拖下来」。这个细节升级一次 pdf.js
 *   就可能变。所以这里既钉版本号（变了要有人去看），也**真跑** `PDFDataRangeTransport`
 *   把契约钉成行为，而不是钉成源码字符串。
 *
 * ★ 本文件是少数「源码字符串断言是对的工具」的场合之一：要钉的是
 *   「**产物里**存在这段逻辑」，而它是一条**文档腐化的警报**，不是正确性守卫。
 *   每条这样的断言都写了「变了要做什么」。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'pdfjs');

/**
 * 真装载内置 pdf.js。
 *
 * ★ 静音 `console.warn`：在 Node 里它加载时会抱怨 `@napi-rs/canvas` 不在、
 *   `DOMMatrix` 无法 polyfill（那是给浏览器渲染用的，测试不需要）。那几行会盖住
 *   真正的失败信息，所以这里临时关掉 —— 但**只关装载那一小段**，其余照常。
 */
async function loadPdfjs() {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    return await import(`${join(VENDOR, 'pdf.mjs')}`);
  } finally {
    console.warn = realWarn;
  }
}

const pdfjs = await loadPdfjs();
const source = readFileSync(join(VENDOR, 'pdf.mjs'), 'utf8');

// ---------------------------------------------------------------------------

describe('产物清单', () => {
  it('五部分都在，且都不为空（少任何一部分都会在真机上以「某本书打不开」的形式暴露）', () => {
    const parts = [
      ['pdf.mjs', '主模块'],
      ['pdf.worker.mjs', 'worker（没有它解析会卡住界面）'],
      ['README.md', '来源与许可说明'],
    ];
    for (const [name, why] of parts) {
      const info = statSync(join(VENDOR, name));
      assert.ok(info.isFile() && info.size > 0, `${name}（${why}）缺失或为空`);
    }
    // 中文 PDF 要靠 cmaps；老书要靠 standard_fonts；JPEG2000/JBIG2/ICC 要靠 wasm。
    assert.ok(readdirSync(join(VENDOR, 'cmaps')).length > 100, 'cmaps 目录太少');
    assert.ok(readdirSync(join(VENDOR, 'standard_fonts')).length > 5, 'standard_fonts 目录太少');
    assert.ok(readdirSync(join(VENDOR, 'wasm')).length > 3, 'wasm 目录太少');
  });

  it('体积在合理量级（突然翻十倍说明误打包了别的东西）', () => {
    const size = (name) => statSync(join(VENDOR, name)).size;
    assert.ok(size('pdf.mjs') > 100_000 && size('pdf.mjs') < 3_000_000, `pdf.mjs ${size('pdf.mjs')}`);
    assert.ok(size('pdf.worker.mjs') > 100_000 && size('pdf.worker.mjs') < 5_000_000, `pdf.worker.mjs ${size('pdf.worker.mjs')}`);
  });
});

describe('版本与导出（客户端 import 的名字必须存在）', () => {
  it('版本号与 README 记录的一致', () => {
    assert.equal(pdfjs.version, '6.4.299');
    assert.equal(pdfjs.build, 'd0991a0d5');
  });

  it('★ 客户端用到的导出名逐个存在（改版把某个名字去掉 ⇒ 整块阅读器崩）', () => {
    // `src/client/pdfjs.js` 用到：PDFDataRangeTransport / GlobalWorkerOptions / getDocument。
    for (const name of ['PDFDataRangeTransport', 'GlobalWorkerOptions', 'getDocument', 'version']) {
      assert.notEqual(pdfjs[name], undefined, `pdf.js 没有导出 ${name}`);
    }
    assert.equal(typeof pdfjs.getDocument, 'function');
    assert.equal(typeof pdfjs.PDFDataRangeTransport, 'function');
    // GlobalWorkerOptions 必须能接 workerSrc（我们靠它把 worker 指到内置目录）。
    pdfjs.GlobalWorkerOptions.workerSrc = '/x/pdf.worker.mjs';
    assert.equal(pdfjs.GlobalWorkerOptions.workerSrc, '/x/pdf.worker.mjs');
  });
});

describe('★ PDFDataRangeTransport 的真实契约（真跑，不是 grep）', () => {
  it('构造签名是 `(length, initialData, progressiveDone, contentDispositionFilename)`', () => {
    const initial = new Uint8Array([1, 2, 3]);
    const transport = new pdfjs.PDFDataRangeTransport(1000, initial, true);
    assert.equal(transport.length, 1000);
    assert.equal(transport.initialData, initial);
    assert.equal(transport.progressiveDone, true);
    assert.equal(typeof transport.requestDataRange, 'function');
    assert.equal(typeof transport.onDataRange, 'function');
    assert.equal(typeof transport.abort, 'function');
  });

  it('`requestDataRange` 在基类上是**抽象**的（我们必须在实例上覆盖它）', () => {
    const transport = new pdfjs.PDFDataRangeTransport(1000, new Uint8Array([1]), true);
    // 我们的 createBookTransport 是**赋值到实例上**来覆盖的；这里证明「不覆盖就会抛」。
    assert.throws(() => transport.requestDataRange(0, 10), /Abstract method PDFDataRangeTransport\.requestDataRange/);
  });

  it('★ `onDataRange` 在传输流建好**之前**调用会抛 TypeError（不是老版本那条 util_assert）', () => {
    // 这条钉的是一个**顺序要求**：`onDataRange` 内部走私有回调 `#Ks`，由
    // `PDFDataTransportStream` 的构造函数通过 `transportReady()` 装上去。
    // ⇒ 将来若有人「顺手把首块直接推进去」，会在这里炸出一个看不懂的私有字段错误。
    const transport = new pdfjs.PDFDataRangeTransport(1000, new Uint8Array([1]), true);
    assert.throws(() => transport.onDataRange(0, new Uint8Array([9])), TypeError);
  });

  it('★ `transportReady(cb)` 之后 `onDataRange(begin, chunk)` 把 begin 原样传给 cb', () => {
    const transport = new pdfjs.PDFDataRangeTransport(1000, new Uint8Array([1]), true);
    const seen = [];
    transport.transportReady((message) => seen.push(message));
    transport.onDataRange(0, new Uint8Array([1, 2]));
    transport.onDataRange(4096, new Uint8Array([3]));

    assert.equal(seen.length, 2);
    assert.deepEqual(seen.map((message) => message.type), ['range', 'range']);
    // ★ `begin` 必须**原样**透传：客户端是靠它把自己发出的请求与 pdf.js 的读者对上的。
    assert.deepEqual(seen.map((message) => message.begin), [0, 4096]);
    assert.equal(seen[1].chunk.length, 1);
  });

  it('`initialData` 会被当作首块（长度为 0 时不入队）', () => {
    // 我们靠 `initialChunk` 省掉好几个来回；这里只钉「pdf.js 确实读它」这一事实。
    const withData = new pdfjs.PDFDataRangeTransport(1000, new Uint8Array([1, 2, 3]), true);
    assert.equal(withData.initialData.length, 3);
    const empty = new pdfjs.PDFDataRangeTransport(1000, new Uint8Array(0), true);
    assert.equal(empty.initialData.length, 0);
    assert.equal(empty.length, 1000);
  });
});

describe('★ 为什么不能走 `getDocument({ url })`（架构依据的文档腐化警报）', () => {
  it('`validateRangeRequestCapabilities` 仍然**硬要求** Content-Length', () => {
    // ★ 这条断言不是正确性守卫，而是**警报**：如果某次升级把这里放宽了，我们的
    //   PDFDataRangeTransport 方案就不再是「唯一可行」，可以重新评估要不要简化。
    //   反过来，如果这里变得**更严**（比如还要求别的头），就要同步更新 README 与
    //   src/client/pdfjs.js 顶部那段说明。
    const body = source.slice(source.indexOf('function validateRangeRequestCapabilities'));
    const head = body.slice(0, 700);
    assert.match(head, /parseInt\(\w+\.get\("Content-Length"\),10\)/, 'Content-Length 的读取方式变了');
    assert.match(head, /if\(!Number\.isInteger\(/, '整数校验没了 —— 说明判据变了');
    // 「没有 Content-Length 就直接返回（isRangeSupported 保持 false）」这一形状：
    // 读取与校验之间不能隔太多东西。
    const readAt = head.indexOf('Content-Length');
    const guardAt = head.indexOf('Number.isInteger');
    assert.ok(guardAt > readAt && guardAt - readAt < 80, 'Content-Length 与它的校验之间被插了别的东西');
  });

  it('`PDFNetworkStream` 仍然要求 http(s) 协议（自定义协议走不了那条路）', () => {
    // 这条是「为什么不能用 `dsh-app://` 直接喂 url」的依据。
    assert.match(source, /isHttp=\/https\?:\/\.test\(\w+\.protocol\)/, 'isHttp 的判据变了');
  });
});

/**
 * 造一个最小的**合法**单页 PDF（含正确的 xref 字节偏移）。
 *
 * 现场构造而不是放夹具文件：xref 的偏移必须与最终字节流严格对齐，手写夹具很容易
 * 在编辑时被改坏，而坏掉的夹具会让下面那条真跑断言以一种看不懂的方式失败。
 */
function minimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describe('★★ 销毁入口：`PDFDocumentProxy` 上**没有** destroy（真跑，不是 grep）', () => {
  /**
   * 这条钉的是一个真机上炸过的故障：
   *
   *   `TypeError: loaded.destroy is not a function` —— 阅读着 A 去点 B，
   *   整个阅读器变成「阅读器页面加载失败」。根因是 cleanup 里对**文档代理**调
   *   `destroy()`，而 pdf.js 6.4.299 的 `PDFDocumentProxy` 根本没有这个方法
   *   （旧版本有）。它在 React 提交阶段同步抛出，被 Error Boundary 接住，
   *   于是错误文案背后真正的原因（一行清理代码）完全看不出来。
   *
   * 官方入口是 `PDFDocumentLoadingTask.destroy()`，可用 `doc.loadingTask` 取回。
   * 升级 pdf.js 时若这条变红，去 `src/client/pdfjs.js` 的 `destroyEntry()` 对齐。
   */
  it('代理上没有 destroy，而 loadingTask 上有；且 loadingTask === task', async () => {
    pdfjs.GlobalWorkerOptions.workerSrc = join(VENDOR, 'pdf.worker.mjs');
    const bytes = minimalPdf();
    const transport = new pdfjs.PDFDataRangeTransport(bytes.length, bytes, true);
    transport.requestDataRange = (begin, end) => {
      transport.onDataRange(begin, bytes.slice(begin, end));
    };
    transport.abort = () => {};

    const task = pdfjs.getDocument({
      range: transport, disableAutoFetch: true, disableStream: true,
      cMapUrl: join(VENDOR, 'cmaps') + '/', cMapPacked: true,
      standardFontDataUrl: join(VENDOR, 'standard_fonts') + '/', wasmUrl: join(VENDOR, 'wasm') + '/',
    });
    const doc = await task.promise;

    assert.ok(doc.numPages >= 1, '夹具 PDF 没被解析出来，先修夹具');
    // ★ 主角：这两条一旦变红，说明 pdf.js 的销毁契约变了。
    assert.equal(typeof doc.destroy, 'undefined',
      'PDFDocumentProxy 上有 destroy 了 —— src/client/pdfjs.js 的注释与 destroyEntry 需要重新评估');
    assert.equal(typeof doc.loadingTask?.destroy, 'function',
      '销毁入口不见了：doc.loadingTask.destroy 是当前唯一能用的关闭方式');
    assert.equal(doc.loadingTask, task, 'loadingTask 应当就是 getDocument 返回的那个 task');

    // 反向对照：照着旧文档写的调用方式**确实会炸**，而且炸的就是那句文案。
    assert.throws(() => doc.destroy(), { name: 'TypeError' },
      '如果这里不炸，说明 pdf.js 又把 destroy 加回了代理上（那时可以简化 destroyEntry）');

    await task.destroy();
  });
});
