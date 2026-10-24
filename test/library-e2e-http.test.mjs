/**
 * 书架的**真实 HTTP 端到端**：真 socket + 真磁盘 + 真 Range 请求。
 *
 * ★ 为什么在 `library-routes.test.mjs` 之外还要这个文件。
 *   那 71 个用例喂的是**假 req / 假 res**，它答得了「分支对不对」，答不了：
 *
 *   - Node 的 HTTP 层真的把 `Range: bytes=0-4` 交到 `req.headers.range` 里了吗；
 *   - `readBody` 的 `for await (const chunk of req)` 在真 socket 上收得全吗
 *     （假 req 是自己实现的异步迭代器，写得对是理所当然的）；
 *   - 响应真的按 `content-range` / `content-length` 发出来了吗，
 *     而且**发出去的字节与磁盘上的真文件一致**（假夹具里 `readBytes` 返回的是
 *     `Buffer.alloc(n, 0x41)`，两边「一致」是桩对桩，证明不了什么）。
 *
 *   所以这里的每一条断言都拿**磁盘上那串真字节**做基准。
 *
 * ★ 另一条只有真 HTTP 能测出来的：取字节失败时**客户端到底收到什么**。
 *   `rawBook` 为了压探测延迟，在读字节**之前**就 `flushHeaders()`；
 *   于是「报头已经发出去、改不了状态码」这条注释的**实际后果**必须被钉住 ——
 *   否则本地书越界时客户端会拿到「200 + 空 body」，而 pdf.js 只会报一句
 *   与真实原因毫无关系的解析错误。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { loadHostBundle } from './helpers/host-bundle.mjs';
import { libraryIndexPath } from '../src/host/store.js';

const { RssService } = await loadHostBundle();

/**
 * ★ 必须在装假 ctx **之前**把真 fetch 抓下来：`createFakeContext()` 会把
 *   `globalThis.fetch` 换成桩（服务自己取 RSS/网盘时用它）。而本文件要的恰恰是
 *   **真**的 HTTP 客户端去打自己的真 socket —— 两者不能是同一个。
 */
const realFetch = globalThis.fetch;

const sandbox = await mkdtemp(join(tmpdir(), 'npie-e2e-'));
process.env.DSH_HOME = join(sandbox, 'home');
/**
 * ★ `HOME` 一并隔离：service 启动时会跑一次旧网盘凭证迁移
 * （`migrateLegacyPanCredentials` 走的是 `os.homedir()`，不受 `DSH_HOME` 约束）。
 * 不隔离的后果有两层 —— 把用户真凭证复制进沙箱（这条文件里正有
 * 「插件数据目录里没有凭证 ⇒ 401」的用例，会被污染成「有凭证」），
 * 以及可能拿着真 token 去打百度。
 */
process.env.HOME = join(sandbox, 'home');

/** 一个**最小但真实**的 PDF 头 —— 内容不重要，重要的是「字节与磁盘上逐字一致」。 */
const PDF_BYTES = Buffer.from('%PDF-1.4\n%npie-e2e\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

const ROOT = join(sandbox, '库');
const OUTSIDE = join(sandbox, '外面');
const API = '/api/dsh-npie-reader/library';

let service;
let server;
let base;

/** 挂上**真** http.Server，按前缀把请求交给插件自己的路由处理器。 */
function mount(routes) {
  return createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = routes.find((entry) => pathname === entry.path || pathname.startsWith(`${entry.path}/`));
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no route' }));
      return;
    }
    void route.handler(req, res);
  });
}

before(async () => {
  await mkdir(join(ROOT, '甲'), { recursive: true });
  await mkdir(OUTSIDE, { recursive: true });
  await writeFile(join(ROOT, '甲', '忧郁的热带.pdf'), PDF_BYTES);
  await writeFile(join(ROOT, '散本.pdf'), PDF_BYTES);
  // 一本**在配置的根目录之外**的 pdf：它会被扫出来（只要走的是另一份书源），
  // 但取字节时必须被拒。
  await writeFile(join(OUTSIDE, '越界.pdf'), PDF_BYTES);

  const fake = createFakeContext();
  globalThis.fetch = fake.state.fetch;
  service = new RssService(fake.ctx, {});
  await service.ready;

  server = mount(fake.state.webRoutes.map((entry) => entry.route));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => (server === undefined ? resolve() : server.close(resolve)));
  if (service?.store?.saveTimer !== undefined) clearTimeout(service.store.saveTimer);
  // ★ 清理是**尽力而为**：本机的 safe-delete 策略会拦「一次删整棵树」（bulk delete guard），
  //   而 `rm(..., { maxRetries: 5 })` 撞上它会反复重试、把收尾钩子拖死（实测 65 秒后 EPERM，
  //   整个 `npm test` 变红）。清理失败不该让**断言结果**变成失败。
  await rm(sandbox, { recursive: true, force: true, maxRetries: 0 }).catch(() => {});
});

/** 发一个真请求，并把响应体读全。用抓下来的真 fetch，不是 ctx 的桩。 */
async function call(path, init) {
  const response = await realFetch(`${base}${path}`, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString('utf8')); } catch { json = null; }
  return { status: response.status, headers: response.headers, buffer, json };
}

const postJson = (path, body) => call(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

describe('真实 HTTP：真 socket + 真磁盘的完整链路', () => {
  it('★ 三步全流程：配源 → 生成书单 → 载入 → 用 Range 取到磁盘上那串真字节', async () => {
    // 1) 起始状态：没有书源、没有书单，落点在插件数据目录。
    const initial = await call(`${API}/sources`);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.json.sources, []);
    assert.deepEqual(initial.json.lists, []);
    assert.deepEqual(initial.json.loadedListIds, []);
    assert.equal(initial.json.output.dir.endsWith(join('storages', 'dsh-npie-reader', 'lists')), true);
    assert.equal(initial.json.output.indexPath.endsWith(join('storages', 'dsh-npie-reader', 'lists.json')), true);

    // 2) 配一个本地书源（真 POST body，走真 `readBody`）。id 与名字由宿主补上。
    const saved = await postJson(`${API}/sources`, { sources: [{ kind: 'local', path: ROOT }] });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.sources.length, 1);
    const source = saved.json.sources[0];
    assert.deepEqual([source.kind, source.path, source.name], ['local', ROOT, '库']);
    assert.match(source.id, /^s[0-9a-f]{16}$/);

    // 3) 扫描 → **每个源一份书单**（真走磁盘）。
    const scanned = await postJson(`${API}/sources/scan`);
    assert.equal(scanned.status, 200);
    assert.equal(scanned.json.total, 2, `扫出 ${scanned.json.total} 本，期望 2`);
    assert.deepEqual(scanned.json.errors, []);
    assert.deepEqual(scanned.json.scanned.map((row) => [row.id, row.count]), [[source.id, 2]]);
    // 生成完清单里就有这一份了，但**还没载入**。
    assert.deepEqual(scanned.json.lists.map((row) => [row.id, row.count, row.loaded]), [[source.id, 2, false]]);

    // 4) ★ 生成了 ≠ 载入了：第三步还没勾，书架仍是空的。
    const notLoaded = await call(`${API}/books`);
    assert.equal(notLoaded.status, 200);
    assert.equal(notLoaded.json.total, 0, '没有勾选任何书单时书架不该有书');
    assert.equal(notLoaded.json.source.missing, true, '「一份都没载入」是缺文件，不是数据坏了');
    // ★ `/books` 的 `sources[]` 报的是**这次真读了哪几份**，不是「配了哪几份」——
    //   一份都没载入时它是空的。「已生成但没勾」那条信息在 `/sources` 那边
    //   （`lists[].loaded === false`），两条路由各说各的事实，不互相冒充。
    assert.deepEqual(notLoaded.json.sources, []);
    const still = await call(`${API}/sources`);
    assert.deepEqual(still.json.lists.map((row) => [row.id, row.count, row.loaded]), [[source.id, 2, false]]);

    // 5) 第三步：勾上这份（真 POST body）。
    const loaded = await postJson(`${API}/lists/load`, { ids: [source.id] });
    assert.equal(loaded.status, 200);
    assert.deepEqual(loaded.json.loadedListIds, [source.id]);
    assert.deepEqual(loaded.json.lists.map((row) => row.loaded), [true]);

    // 6) 读书单 —— 宿主真的把刚生成的那份读进来了。
    const books = await call(`${API}/books`);
    assert.equal(books.status, 200);
    assert.equal(books.json.total, 2);
    assert.equal(books.json.source.missing, false);
    const target = books.json.books.find((book) => book.filename === '忧郁的热带.pdf');
    assert.ok(target, '书单里没有那本书');
    assert.equal(target.source, 'local', '本地书的 source 必须是 local');
    /**
     * ★ 0.20.4：来源戳必须**真的跨过 HTTP 边界**送到客户端。
     *
     * 这一条守的是一道很容易被疏忽的接缝：`tagBookSource` 在 host 侧把
     * `listId / listName / listKind` 打在书对象上，而 `/books` 路由如果把书**白名单**
     * 序列化（只挑 `id / title / ext …` 那几个字段），戳就会在这里**静默丢掉** ——
     * 症状是界面上什么都不变（没有徽章、来源下拉只有一项），而所有单元判据都是绿的。
     * 所以判据要落在「真 socket 出去的 JSON」上，不是落在 host 的返回值上。
     */
    assert.equal(target.listId, source.id, '书上的 listId 没送到客户端 —— 来源徽章会整块消失');
    assert.equal(target.listName, '库');
    assert.equal(target.listKind, 'local');

    // 7) ★ 真 Range 请求：拿到的必须与磁盘上那串字节**逐字一致**。
    const ranged = await call(`${API}/book/${target.id}/raw`, { headers: { range: 'bytes=0-4' } });
    assert.equal(ranged.status, 206, `Range 请求应当 206，实际 ${ranged.status}`);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-4/${PDF_BYTES.length}`);
    assert.equal(ranged.headers.get('content-length'), '5');
    assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(ranged.buffer, PDF_BYTES.subarray(0, 5), '发出来的字节与磁盘上的不一致');

    // 8) 中段与尾段也对得上（只测头 5 字节的话，偏移算错会从缝里溜过去）。
    const middle = await call(`${API}/book/${target.id}/raw`, { headers: { range: 'bytes=10-19' } });
    assert.equal(middle.status, 206);
    assert.deepEqual(middle.buffer, PDF_BYTES.subarray(10, 20));
    const tail = await call(`${API}/book/${target.id}/raw`, {
      headers: { range: `bytes=${PDF_BYTES.length - 3}-` },
    });
    assert.equal(tail.status, 206);
    assert.deepEqual(tail.buffer, PDF_BYTES.subarray(PDF_BYTES.length - 3));

    // 9) 反向对照：范围超出文件末尾要 416（不是空 200）。
    const beyond = await call(`${API}/book/${target.id}/raw`, { headers: { range: 'bytes=99999-' } });
    assert.equal(beyond.status, 416);
  });

  it('★ 无 Range 的探测请求：报**真实**大小，发出封顶的字节', async () => {
    // 小文件不封顶，所以这里断言的是「没有 Range 时也带 accept-ranges 与真实长度」。
    const books = await call(`${API}/books`);
    const target = books.json.books[0];
    const probe = await call(`${API}/book/${target.id}/raw`);
    assert.equal(probe.status, 200);
    assert.equal(probe.headers.get('content-length'), String(PDF_BYTES.length));
    assert.deepEqual(probe.buffer, PDF_BYTES);
  });

  it('★ 本地书越界时**不许**回 200 + 空 body', async () => {
    /**
     * 构造方式刻意用「写一份真索引 + POST /reload」而不是替换 service 的方法：
     * 后者的「真」只到进程内，而越界这件事恰恰要在**真书单文件 → 真路由 → 真文件系统**
     * 这条链路末端才能观察全。
     *
     * 书的来源是真实场景：用户把书源目录**改窄**了，或者书单是从别处搬过来的 ——
     * 都不是攻击，而是用着用着就会发生的事。
     *
     * 期望：一个 4xx + 一句能自救的原因（「不在已配置的本地目录里」）。
     */
    // 基准：先证明**合法**的那本读得到（否则下面的 4xx 分不清是「拒了越界」还是「整条通道坏了」）。
    const before = await call(`${API}/books`);
    const legit = before.json.books.find((book) => book.filename === '散本.pdf');
    const baseline = await call(`${API}/book/${legit.id}/raw`, { headers: { range: 'bytes=0-4' } });
    assert.equal(baseline.status, 206, '基准请求就没通，下面的断言说明不了任何事');

    /**
     * 先**清空载入选择**，让下面那份**旧版合并书单**（`<数据目录>/books.json`）成为唯一来源。
     *
     * 为什么走这条路径而不是生成一份新书单：越界这件事要在**真书单文件 → 真路由 →
     * 真文件系统**这条链路末端才能观察全，而手写一份索引文件是最直接的造法。
     * 0.8.0 起那份「所有源合并成一份」的文件不会被生成、但只要它还在就会被载入
     * （`service.legacyList()`，标成「旧版合并书单」），所以这条路仍然能跑通 ——
     * 顺带把「老用户升级后书架不空」这条兜底也真机走了一遍。
     */
    await postJson(`${API}/lists/load`, { ids: [] });
    /**
     * ★ 索引文件里放的是**原始字段形态**（`abspath` / `fs_id`），不是
     *   `/books` 返回的那种规范化形态 —— 读回来的那一份要重新过 `normalizeBook`，
     *   而它认的是 `abspath`。写成规范化形态（`localPath`）会让两本书都变成
     *   「两条取字节凭据都没有」，于是拿到一个 400，看着像「越界被挡住了」，
     *   实际上根本没走到取字节那一步。第一版就是这么写的，被这条断言当场抓出来。
     */
    await writeFile(libraryIndexPath(), JSON.stringify({
      books: [
        { id: legit.id, filename: '散本.pdf', ext: 'pdf', size: PDF_BYTES.length, abspath: join(ROOT, '散本.pdf'), top_dir: '', title: '散本' },
        { id: 'e2eout1', filename: '越界.pdf', ext: 'pdf', size: PDF_BYTES.length, abspath: join(OUTSIDE, '越界.pdf'), top_dir: '', title: '越界' },
      ],
    }));
    const reloaded = await postJson(`${API}/reload`);
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.json.total, 2, '索引没被读进来（后面的断言会变成另一回事）');
    assert.equal(reloaded.json.sources[0].external, false);
    assert.equal(reloaded.json.books.find((book) => book.id === 'e2eout1').source, 'local');

    const res = await call(`${API}/book/e2eout1/raw`, { headers: { range: 'bytes=0-4' } });
    // ★ 403 而不是 400：越界对用户意味着「去改设置里的书源目录」，而 400 会被读成
    //   「请求本身有问题」——两件事的自救动作完全不同。
    assert.equal(res.status, 403, `越界的本地书回了 ${res.status}（body ${res.buffer.length} 字节）`);
    assert.equal(res.json?.code, 'LOCAL_OUTSIDE_ROOT');
    assert.match(res.json?.error ?? '', /不在已配置的本地目录里/, '没有给出能自救的那句话');
    // ★ 反向对照：**不许**只发了个 4xx 就完事 —— 响应必须是完整的 JSON，
    //   而不是像修复前那样「声明了 content-length 却零字节、连接被截断」。
    assert.equal(res.buffer.length > 0, true, 'body 是空的：客户端会拿到被截断的响应');

    // 「文件没了」是另一件事，状态码也必须不同（去磁盘上找，而不是去改设置）。
    await writeFile(libraryIndexPath(), JSON.stringify({
      books: [
        { id: legit.id, filename: '散本.pdf', ext: 'pdf', size: PDF_BYTES.length, abspath: join(ROOT, '散本.pdf'), top_dir: '', title: '散本' },
        { id: 'e2egone', filename: '没了.pdf', ext: 'pdf', size: 100, abspath: join(ROOT, '没了.pdf'), top_dir: '', title: '没了' },
      ],
    }));
    await postJson(`${API}/reload`);
    const gone = await call(`${API}/book/e2egone/raw`, { headers: { range: 'bytes=0-4' } });
    assert.equal(gone.status, 404, '文件不存在应当是 404');
    assert.equal(gone.json?.code, 'LOCAL_MISSING');

    // 反向对照：拒了越界那本之后，**同一台服务**上合法的书照样读得到 ——
    // 证明上面那个 4xx 是「这一本被拒」，不是「整条通道被关掉」。
    const again = await call(`${API}/book/${legit.id}/raw`, { headers: { range: 'bytes=0-4' } });
    assert.equal(again.status, 206, '拒了一本之后把整条通道也关掉了');
    assert.deepEqual(again.buffer, PDF_BYTES.subarray(0, 5));
  });

  it('★ 网盘书没有凭证时回 401 + 一句人话，**不是** 200/206 + 空 body', async () => {
    /**
     * 这条钉的是真机上真实发生过的那个症状：书架**列得出来**（书单躺在盘上），
     * 一点开却只报 `Failed to fetch`。
     *
     * 原因不在网盘，而在响应的组织方式：报头在取字节**之前**就发出去了
     * （`rawBook` 为了压探测延迟），于是取字节失败时只能零字节收尾，
     * 浏览器把它读成「响应被截断」⇒ 一句与真实原因（没授权）毫无关系的话。
     *
     * 修法是让 `service.verifyReadable` 对网盘书也确认一次「凭证拿不拿得到」
     * （调 `pan.ensureToken()`，有内存缓存所以不增加可感延迟）。
     * 真机上这份凭证本该由启动时的一次性迁移从 `~/.baidu-pan-*.json` 搬过来；
     * 本文件把 `HOME` 隔离进了沙箱，所以这里**确实**处在「没有凭证」的状态。
     */
    await postJson(`${API}/lists/load`, { ids: [] });
    await writeFile(libraryIndexPath(), JSON.stringify({
      books: [{
        id: 'e2epan1', filename: '网盘书.pdf', ext: 'pdf', size: 4096,
        pan_path: '/E书拾取/网盘书.pdf', fs_id: 418104284000397, top_dir: '', title: '网盘书',
      }],
    }));
    const reloaded = await postJson(`${API}/reload`);
    assert.equal(reloaded.status, 200);
    const book = reloaded.json.books.find((row) => row.id === 'e2epan1');
    assert.equal(book?.source, 'pan', '这本书没被认成网盘书，下面的断言会变成另一回事');
    assert.equal(book?.fsId, 418104284000397);

    const res = await call(`${API}/book/e2epan1/raw`, { headers: { range: 'bytes=0-4' } });

    // ★ 401 而不是 400：请求本身完全正常，缺的是授权 ——
    //   而用户能自救的动作是「去设置页走一次授权向导」，不是「去改请求」。
    assert.equal(res.status, 401, `没有凭证的网盘书回了 ${res.status}（body ${res.buffer.length} 字节）`);
    assert.equal(res.json?.code, 'NO_TOKEN');
    assert.match(res.json?.error ?? '', /百度网盘授权/, '没有给出能自救的那句话');
    // ★ 反向对照：**不许**是「声明了 content-length 却零字节」—— 那正是修复前的形态。
    assert.equal(res.buffer.length > 0, true, 'body 是空的：客户端会拿到被截断的响应');
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  });
});
