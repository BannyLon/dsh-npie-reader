/**
 * 本地 OCR：图片校验、执行器、以及 `ocr.json` 的读写。
 *
 * 这个文件存在的理由：这条链路上**每一环的错误都会伪装成别的错误**。
 *   - `Buffer.from(str, 'base64')` 遇到非法字符是**静默跳过**的 ⇒ 一个写错的请求体
 *     会变成「一张 0 字节的图」⇒ 最后报「图片损坏」，与真实原因隔两层；
 *   - `osascript` 的 stdout 里可能混进警告行 ⇒ `JSON.parse` 整串会炸，
 *     而炸出来的信息跟「识别失败」看起来一模一样；
 *   - 超时与「认不出字」混成一句话 ⇒ 用户会以为书坏了，而不是「第一次要等模型加载」；
 *   - 临时目录不删 ⇒ 一张 200 DPI 的页面几百 KB，几十次之后就是几十 MB 垃圾。
 *
 * 所以这里**不碰真 macOS**：`exec` 是注入的，跑得快、也不依赖机器。
 * 真机那一条由 `scripts/check-ocr-live.mjs`（手动跑）覆盖 —— 单元测试不该在
 * 每台机器上都去加载一遍 Vision 模型。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createDigestStore } from '../src/host/digest-store.js';
import { ocrScriptCandidates, resolveOcrScript } from '../src/host/service.js';
import {
  OCR_MAX_IMAGE_BYTES,
  OCR_TIMEOUT_MS,
  createOcrRunner,
  decodeImagePayload,
  sniffImageExt,
} from '../src/host/ocr.js';

/** 最小的 PNG 头（8 字节 magic + 一点载荷）。Vision 不会读它，`sniffImageExt` 只认 magic。 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
/** JPEG 的 SOI + APP0 头。 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

describe('sniffImageExt：只看 magic', () => {
  it('认出 PNG 与 JPEG', () => {
    assert.equal(sniffImageExt(PNG), 'png');
    assert.equal(sniffImageExt(JPEG), 'jpeg');
  });

  it('别的字节一律不认（不给 Vision 送没被测过的格式）', () => {
    for (const buffer of [
      Buffer.from('GIF89a'),
      Buffer.from('RIFF0000WEBP'),
      Buffer.from('%PDF-1.7'),
      Buffer.alloc(0),
      Buffer.from([0x89, 0x50]),           // 截断的 PNG magic
    ]) {
      assert.equal(sniffImageExt(buffer), undefined, `不该认出 ${buffer.toString('latin1')}`);
    }
  });

  it('非 Buffer 不抛异常，只返回 undefined', () => {
    for (const value of [undefined, null, 'PNG', 42, {}, new Uint8Array([0x89, 0x50, 0x4e, 0x47])]) {
      assert.equal(sniffImageExt(value), undefined);
    }
  });
});

describe('decodeImagePayload：base64 必须当场校验', () => {
  it('裸 base64 能解回原字节', () => {
    assert.deepEqual(decodeImagePayload(PNG.toString('base64')), PNG);
  });

  it('data URL 能解，且前缀大小写不敏感的是「协议名」而不是内容', () => {
    assert.deepEqual(decodeImagePayload(`data:image/png;base64,${PNG.toString('base64')}`), PNG);
    assert.deepEqual(decodeImagePayload(`data:image/jpeg;base64,${JPEG.toString('base64')}`), JPEG);
  });

  it('★ 非法字符必须当场抛 —— 这是本文件最重要的一条', () => {
    // 反向对照：先证明「不校验会静默成功」。`Buffer.from` 对非法字符是跳过的，
    // 所以 `"@@@@"` 会解出一个**长度为 0 的 Buffer**，而不是报错。
    assert.equal(Buffer.from('@@@@', 'base64').length, 0, '前提变了：Node 现在会拒绝非法 base64？');

    // 于是「不校验」的写法会让一个写错的请求体一路走到 OCR 那侧，
    // 最后报「图片损坏」—— 与真实原因（请求体编码错了）隔着两层。
    assert.throws(() => decodeImagePayload('@@@@'), /不是合法的 base64/);
    assert.throws(() => decodeImagePayload('AAAA AAAA'), /不是合法的 base64/, '空格不在 base64 字符集里');
    assert.throws(() => decodeImagePayload('AAAAA'), /不是合法的 base64/, '长度不是 4 的倍数');
  });

  it('data URL 的三道门：不完整 / 不是图片 / 不是 base64', () => {
    assert.throws(() => decodeImagePayload('data:image/png'), /不完整/);
    assert.throws(() => decodeImagePayload('data:text/plain;base64,AAAA'), /只接受图片 data URL/);
    assert.throws(() => decodeImagePayload('data:image/png,AAAA'), /必须是 base64/);
  });

  it('空输入与空载荷都拒', () => {
    for (const value of ['', undefined, null, 42, {}]) {
      assert.throws(() => decodeImagePayload(value), /缺少图片数据/);
    }
    assert.throws(() => decodeImagePayload('data:image/png;base64,'), /缺少图片数据/);
  });
});

/**
 * 造一个 runner，`exec` 被换成记录器。
 *
 * ★ 记下 `imagePath` **在调用那一刻**是否存在、内容是什么：这是唯一能证明
 *   「临时文件确实写进去了、扩展名按 magic 选的」的时机 —— 函数返回后它已经被删了。
 */
function makeRunner({ stdout = '', error = null, platform = 'darwin', timeoutMs = OCR_TIMEOUT_MS } = {}) {
  const calls = [];
  const logs = [];
  const runner = createOcrRunner({
    scriptPath: '/fake/ocr-vision.js',
    platform,
    timeoutMs,
    log: (message) => logs.push(message),
    exec: async (file, args, options) => {
      const imagePath = args[args.length - 1];
      calls.push({
        file,
        args,
        options,
        imagePath,
        seenAtCall: existsSync(imagePath),
        bytes: existsSync(imagePath) ? readFileSync(imagePath) : null,
      });
      if (error !== null) throw error;
      return { stdout };
    },
  });
  return { runner, calls, logs };
}

const okStdout = (lines, ms = 640) => `\n${JSON.stringify({ ok: true, lines: lines.length, ms, text: lines })}\n`;

describe('createOcrRunner：平台闸门', () => {
  it('非 macOS 直接标不支持，且不调 exec', async () => {
    const { runner, calls } = makeRunner({ platform: 'win32' });
    assert.equal(runner.supported, false);
    assert.match(runner.unavailableReason, /不是 macOS/);
    await assert.rejects(() => runner.recognize(PNG), /不是 macOS/);
    assert.equal(calls.length, 0, '不支持时绝不能真的去起子进程');
  });

  it('脚本路径为空也算不支持（缺文件的安装应该报错，而不是静默藏掉按钮）', () => {
    const runner = createOcrRunner({ scriptPath: '', platform: 'darwin' });
    assert.equal(runner.supported, false);
  });

  it('macOS + 有脚本路径 = 支持', () => {
    const { runner } = makeRunner();
    assert.equal(runner.supported, true);
    assert.equal(runner.unavailableReason, '');
  });
});

describe('createOcrRunner：正常识别', () => {
  it('把多行拼成一段，并回报行数与耗时', async () => {
    const { runner, logs } = makeRunner({ stdout: okStdout(['第一行', '第二行'], 512) });
    const result = await runner.recognize(PNG);
    assert.equal(result.text, '第一行\n第二行');
    assert.equal(result.lines, 2);
    assert.equal(result.ms, 512);
    assert.deepEqual(logs, ['ocr: 2 行 / 512 ms']);
  });

  it('调用形状：osascript -l JavaScript <脚本> <临时文件>，并带超时', async () => {
    const { runner, calls } = makeRunner({ stdout: okStdout(['x']) });
    await runner.recognize(PNG);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.file, 'osascript');
    assert.deepEqual(call.args.slice(0, 3), ['-l', 'JavaScript', '/fake/ocr-vision.js']);
    assert.equal(call.options.timeout, OCR_TIMEOUT_MS);
    assert.ok(call.options.maxBuffer >= 1024 * 1024);
  });

  it('临时文件的扩展名按 magic 选，内容就是原字节', async () => {
    for (const [buffer, ext] of [[PNG, 'png'], [JPEG, 'jpeg']]) {
      const { runner, calls } = makeRunner({ stdout: okStdout(['x']) });
      await runner.recognize(buffer);
      assert.ok(calls[0].seenAtCall, '调用 exec 的那一刻临时文件必须已经落盘');
      assert.ok(calls[0].imagePath.endsWith(`.${ext}`), `扩展名应该是 .${ext}，实际 ${calls[0].imagePath}`);
      assert.deepEqual(calls[0].bytes, buffer);
    }
  });

  it('★ 临时文件必须落在系统临时目录里（绝不写进插件数据目录）', async () => {
    const { runner, calls } = makeRunner({ stdout: okStdout(['x']) });
    await runner.recognize(PNG);
    // 这条与环境无关，永远能断言：一张 200 DPI 的页面几百 KB，写错地方就是长期堆积。
    assert.ok(
      calls[0].imagePath.startsWith(tmpdir()),
      `临时文件落在 ${calls[0].imagePath}，不在系统临时目录下`,
    );
    assert.match(calls[0].imagePath, /npr-ocr-/);
  });

  it('★ 跑完必须删掉临时目录（成功、失败都要）', async (t) => {
    /**
     * ★ 先自证「这台机器删得掉文件」再断言。
     *
     * 沙箱与安全软件会**拦 `unlink`**（本机实测间歇性如此，`book-lists` 那几条
     * 也因此红过）。而 runner 里的 `rm(...).catch(() => {})` 是**故意**吞掉异常的
     * （临时文件删不掉不该让识别失败）—— 于是「目录还在」这件事在那种环境下
     * 说明不了任何代码问题。
     * ⇒ 与其把断言放宽（那等于丢保护），不如把**量测前提**显式验一遍：
     *   删不掉就跳过并写明原因，删得掉就必须真的断言。
     */
    const probe = await mkdtemp(join(tmpdir(), 'npr-rmprobe-'));
    let canDelete = true;
    try {
      await rm(probe, { recursive: true, force: true });
    } catch {
      canDelete = false;
    }
    if (!canDelete || existsSync(probe)) {
      t.skip('这台机器拦 unlink（沙箱 / 安全软件），清理断言无法量测');
      return;
    }

    const good = makeRunner({ stdout: okStdout(['x']) });
    await good.runner.recognize(PNG);
    assert.equal(existsSync(good.calls[0].imagePath), false, '成功后临时文件还在盘上');

    const bad = makeRunner({ error: Object.assign(new Error('boom'), { stderr: 'stderr 内容' }) });
    await assert.rejects(() => bad.runner.recognize(PNG));
    assert.equal(existsSync(bad.calls[0].imagePath), false, '失败后临时文件还在盘上');
  });
});

describe('createOcrRunner：stdout 的解析', () => {
  it('★ 倒着找最后一个能解析的 JSON 行（osascript 会混进警告）', async () => {
    const stdout = [
      '2026-10-24 12:00:00.000 osascript[123:456] 警告：something deprecated',
      'not json at all',
      JSON.stringify({ ok: true, lines: 1, ms: 700, text: ['正文'] }),
      '',
    ].join('\n');
    const { runner } = makeRunner({ stdout });
    const result = await runner.recognize(PNG);
    assert.equal(result.text, '正文');
  });

  it('一行都解析不出来时，错误信息必须说「没有可解析的结果」而不是「识别失败」', async () => {
    const { runner } = makeRunner({ stdout: 'totally broken\n' });
    await assert.rejects(() => runner.recognize(PNG), /没有返回可解析的结果/);
  });

  it('脚本自己报 ok:false 时，把它给的原因带出来', async () => {
    const { runner } = makeRunner({ stdout: JSON.stringify({ ok: false, error: 'Vision 没有完成识别' }) });
    await assert.rejects(() => runner.recognize(PNG), /Vision 没有完成识别/);
  });

  it('ok:true 但 text 不是数组时，当空结果而不是崩', async () => {
    const { runner } = makeRunner({ stdout: JSON.stringify({ ok: true, lines: 0, ms: 10, text: null }) });
    const result = await runner.recognize(PNG);
    assert.equal(result.text, '');
    assert.equal(result.lines, 0);
  });
});

describe('createOcrRunner：超时与失败必须分开说', () => {
  it('★ 被杀掉（超时）说「超时」，并带出秒数', async () => {
    const error = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
    const { runner } = makeRunner({ error, timeoutMs: 60_000 });
    await assert.rejects(() => runner.recognize(PNG), /本地 OCR 超时（60 秒）/);
  });

  it('★ 没跑起来说「没跑起来」，并带出 stderr 片段', async () => {
    const error = Object.assign(new Error('Command failed'), { stderr: 'execution error: 不允许的 Apple 事件\n' });
    const { runner } = makeRunner({ error });
    await assert.rejects(() => runner.recognize(PNG), /本地 OCR 没跑起来：execution error/);
  });

  it('stderr 为空时不留一个孤零零的冒号', async () => {
    const { runner } = makeRunner({ error: Object.assign(new Error('x'), { stderr: '  ' }) });
    await assert.rejects(() => runner.recognize(PNG), (err) => {
      assert.match(err.message, /^本地 OCR 没跑起来$/);
      return true;
    });
  });
});

describe('createOcrRunner：输入闸门（都不该起子进程）', () => {
  it('非 PNG / JPEG 拒绝', async () => {
    const { runner, calls } = makeRunner();
    await assert.rejects(() => runner.recognize(Buffer.from('GIF89a......')), /只支持 PNG \/ JPEG/);
    assert.equal(calls.length, 0);
  });

  it('超过上限的图拒绝，且报出实际大小', async () => {
    const { runner, calls } = makeRunner();
    const big = Buffer.concat([PNG, Buffer.alloc(OCR_MAX_IMAGE_BYTES)]);
    await assert.rejects(() => runner.recognize(big), /图片太大（\d+ KB，上限 4096 KB）/);
    assert.equal(calls.length, 0, '超限的图不该被写进临时目录');
  });
});

describe('ocr.json：一页一条，空文本不落盘', () => {
  let root = '';
  let store = null;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'npie-ocr-'));
    store = createDigestStore({ rootDir: root });
  });

  after(async () => {
    // 清理失败不该让测试变红（见 digest-store.test.mjs 的同一段注释）。
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('写进去能读回来，页与页互不影响', async () => {
    const first = await store.putOcrPage('l-ocr_1', 60, { text: '第六十页', ms: 800 });
    assert.deepEqual(first, { written: true, pages: 1 });
    const second = await store.putOcrPage('l-ocr_1', 61, { text: '第六十一页', ms: 679 });
    assert.deepEqual(second, { written: true, pages: 2 });

    assert.equal(await store.readOcrPage('l-ocr_1', 60), '第六十页');
    assert.equal(await store.readOcrPage('l-ocr_1', 61), '第六十一页');
  });

  it('没识别过的页读出来是空串，不是 undefined', async () => {
    assert.equal(await store.readOcrPage('l-ocr_1', 62), '');
    assert.equal(await store.readOcrPage('l-ocr_never', 1), '');
  });

  it('★ 空文本不写 —— 否则「这一页认不出字」会被永久钉死', async () => {
    const result = await store.putOcrPage('l-ocr_1', 62, { text: '   \n  ', ms: 300 });
    assert.deepEqual(result, { written: false, pages: 0 });
    assert.equal(existsSync(join(store.dirOf('l-ocr_1'), 'ocr.json')), true, '前面两页应该还在');
    const all = await store.readOcr('l-ocr_1');
    assert.deepEqual(Object.keys(all).sort(), ['60', '61'], '空文本那一页不该出现');
  });

  it('非法 page / 非字符串文本当场抛（不从坏数据里猜）', async () => {
    for (const page of [0, -1, 1.5, '60', null, undefined]) {
      await assert.rejects(() => store.putOcrPage('l-ocr_1', page, { text: 'x' }), TypeError);
    }
    await assert.rejects(() => store.putOcrPage('l-ocr_1', 1, { text: null }), TypeError);
  });

  it('★ 坏掉的 ocr.json 当「没识别过」，而不是让整本书打不开', async () => {
    const { writeFile } = await import('node:fs/promises');
    await store.ensureDir('l-ocr_broken');
    await writeFile(store.ocrFileOf('l-ocr_broken'), '{"60": "不是对象"', 'utf8');
    assert.equal(await store.readOcrPage('l-ocr_broken', 60), '');
    // 而且还能继续写进去（坏文件被下一次写入覆盖）。
    const result = await store.putOcrPage('l-ocr_broken', 60, { text: '修好了', ms: 100 });
    assert.equal(result.written, true);
    assert.equal(await store.readOcrPage('l-ocr_broken', 60), '修好了');
  });

  it('尺寸统计把 ocr.json 算进去（否则「缓存占用」会低报）', async () => {
    const before = await store.sizeOf('l-ocr_1');
    await store.putOcrPage('l-ocr_1', 63, { text: '第六十三页'.repeat(50), ms: 700 });
    const after = await store.sizeOf('l-ocr_1');
    assert.ok(after > before, `写了正文之后占用应该变大：${before} → ${after}`);
  });

  /**
   * ★ 并发写：`putOcrPage` 是「读整份 → 改一页 → 整份写回」。
   *
   * 这条判据是**确定性**的，不靠运气：`Promise.all` 里 5 个调用会在同一个 tick 里
   * 各自 `await ensureDir` → 各自 `await readJson`，**五个都读到空文件**，然后各写
   * 各的那一页 ⇒ 文件里只剩最后写的那一页。修之前**必现**，不是偶发。
   *
   * 用户侧的触发方式很普通：连点两页「识别这一页」；或者整本 OCR 在跑、用户又手动
   * 点了一页。丢掉的那页不会有任何报错 —— 客户端命中缓存就直接用，翻回去是空白。
   */
  it('★ 并发识别 5 页：一页都不许丢（读-改-写必须串行）', async () => {
    const bookId = 'l-ocr_race';
    const pages = [1, 2, 3, 4, 5];
    await Promise.all(pages.map((page) => store.putOcrPage(bookId, page, { text: `第${page}页`, ms: 600 })));

    const all = await store.readOcr(bookId);
    assert.deepEqual(Object.keys(all).map(Number).sort((a, b) => a - b), pages,
      `并发写入丢了页：只剩 ${JSON.stringify(Object.keys(all))}`);
    for (const page of pages) assert.equal(await store.readOcrPage(bookId, page), `第${page}页`);
  });

  it('★ 反向对照：绕过队列的「读-改-写」必须丢页（证明上面那条有牙）', async () => {
    // 手写一份修之前的实现：直接读、改、写，不排队。
    const bookId = 'l-ocr_race_mutant';
    const { writeFile } = await import('node:fs/promises');
    const writeDirect = async (page) => {
      await store.ensureDir(bookId);
      const all = await store.readOcr(bookId);
      all[page] = { text: `第${page}页`, at: Date.now(), ms: 600 };
      await writeFile(store.ocrFileOf(bookId), JSON.stringify(all), 'utf8');
    };
    await Promise.all([1, 2, 3, 4, 5].map(writeDirect));
    const all = await store.readOcr(bookId);
    assert.equal(Object.keys(all).length, 1,
      `反向对照失效：不排队竟然没丢页（${JSON.stringify(Object.keys(all))}）`);
  });
});

/**
 * ★ 两种运行形态：`resolveOcrScript` 必须两种都算对。
 *
 * 这条是**事故驱动**的：第一版照抄了 `resolvePdfjsRoot` 的 `'..','..'` —— 那个函数
 * 从 `src/host/` 出发要退**两级**才到插件根，而打包后 `here` 是 `lib/`，只隔**一级**。
 * 于是候选路径落到 `<plugin>/../src/host/…`（不存在），兜底又返回了
 * `<plugin>/lib/ocr-vision.js`，用户界面上直接糊出一整屏
 * `osascript: …/lib/ocr-vision.js: No such file or directory`。
 *
 * ★ 为什么原来的测试没抓住：`check-ocr-live.mjs` 与 `ocr.test.mjs` 都从**源码**导入
 *   （`here` = `src/host`，候选 0 就命中），**打包形态一次都没被跑过**。
 *   ⇒ 一条数据路径要覆盖「所有形态」，而不只是「我能跑通的那一种」。
 */
describe('resolveOcrScript：两种运行形态', () => {
  let root = '';

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'npie-ocr-path-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** 造一棵「插件树」：`<root>/lib/` + `<root>/src/host/ocr-vision.js`。 */
  async function makeTree() {
    const plugin = await mkdtemp(join(root, 'plugin-'));
    await mkdir(join(plugin, 'lib'), { recursive: true });
    await mkdir(join(plugin, 'src', 'host'), { recursive: true });
    await writeFile(join(plugin, 'src', 'host', 'ocr-vision.js'), '// 假脚本\n', 'utf8');
    return plugin;
  }

  it('未打包形态：`here` = src/host，同目录就能命中', async () => {
    const plugin = await makeTree();
    const hits = ocrScriptCandidates(join(plugin, 'src', 'host')).filter((path) => existsSync(path));
    assert.deepEqual(hits, [join(plugin, 'src', 'host', 'ocr-vision.js')]);
  });

  it('★ 打包形态：`here` = lib，只该往上**一级**', async () => {
    const plugin = await makeTree();
    const hits = ocrScriptCandidates(join(plugin, 'lib')).filter((path) => existsSync(path));
    assert.deepEqual(hits, [join(plugin, 'src', 'host', 'ocr-vision.js')]);
  });

  it('★ 反向对照：照抄 `..\\..` 的写法在打包形态下一条都不命中', async () => {
    const plugin = await makeTree();
    // 这就是那个错版本：多退了一级，落到了 `dsh_plugins_desktop/src/host/…`。
    const wrong = join(plugin, 'lib', '..', '..', 'src', 'host', 'ocr-vision.js');
    assert.equal(existsSync(wrong), false, '这个反向对照自己失效了：错版本居然命中了');
    // 而正确版本必须命中（否则上面那条 deepEqual 就是空对空）。
    assert.equal(existsSync(join(plugin, 'lib', '..', 'src', 'host', 'ocr-vision.js')), true);
  });

  it('两种形态都不命中时返回空串（不是「最像的那个」）', async () => {
    const empty = await mkdtemp(join(root, 'empty-'));
    // `ocrScriptCandidates` 只负责给出候选；「探测不到返回空串」在 `resolveOcrScript` 里，
    // 那一层用真实插件树验证（见下一条）。
    assert.equal(ocrScriptCandidates(join(empty, 'lib')).filter((path) => existsSync(path)).length, 0);
  });

  it('在**这个仓库**里（未打包）能探测到真实脚本', () => {
    const resolved = resolveOcrScript();
    assert.notEqual(resolved, '', '探测不到脚本 —— 界面上的 OCR 会变成「组件缺失」');
    assert.ok(resolved.endsWith(join('src', 'host', 'ocr-vision.js')), `解析到 ${resolved}`);
    assert.equal(existsSync(resolved), true);
  });
});
