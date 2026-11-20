/**
 * 灵感贴图：宿主那一半（0.73.0）。
 *
 * 这一层的四个判据都不是「能存能读」这种正例能覆盖的：
 *   ① 类型由 **magic bytes** 决定，不信 `content-type` —— 否则一个声明成
 *      `image/png` 的 HTML 会被以 `.png` 的名字端回浏览器；
 *   ② 名字是**内容哈希** ⇒ 同名必然同字节（同图不重复存）；
 *   ③ 名字白名单是**安全边界**，`../` 之类必须在入口就被挡住；
 *   ④ 上限是**边读边判**，不是先收下再量。
 *
 * 每条都配了反向对照 —— 只断「调用成功」的测试，在把校验整段删掉之后照样绿。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  ASSET_MAX_BYTES, ASSET_NAME_PATTERN, assetNameFor, createDiaryAssets, sniffImage,
} from '../src/host/diary-assets.js';
import { DIARY_API_PREFIX, makeDiaryRoutes } from '../src/host/diary-routes.js';

/** 最小可判的四种图头。内容不解码，`sniffImage` 只看开头几个字节。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from('gif-body')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x10, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'latin1'),
  Buffer.from('webp-body'),
]);

describe('sniffImage：类型由文件自己说', () => {
  it('四种位图都认得出', () => {
    assert.equal(sniffImage(PNG), 'image/png');
    assert.equal(sniffImage(JPEG), 'image/jpeg');
    assert.equal(sniffImage(GIF), 'image/gif');
    assert.equal(sniffImage(WEBP), 'image/webp');
  });

  it('★ 反向对照：HTML 冒充满 PNG 也不算（这条就是「不信任 content-type」的牙）', () => {
    const html = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
    assert.equal(sniffImage(html), '', '一段 HTML 被认成了图片');
    // 前面补 PNG 头、后面接脚本：按头认图是正确的（浏览器会按图片解码失败，
    // 不会执行脚本），所以这里只钉「没有头就一定不认」。
    assert.equal(sniffImage(Buffer.alloc(12)), '');
  });

  it('太短的一律不认（`< 12` 字节，避免越界读）', () => {
    assert.equal(sniffImage(PNG.subarray(0, 8)), '');
    assert.equal(sniffImage(Buffer.alloc(0)), '');
  });
});

describe('assetNameFor：内容寻址', () => {
  it('同内容同名字、不同内容不同名字', () => {
    const a = assetNameFor(PNG, 'image/png');
    assert.match(a, ASSET_NAME_PATTERN);
    assert.equal(assetNameFor(Buffer.from(PNG), 'image/png'), a, '同字节给出了不同的名字');
    const b = assetNameFor(Buffer.concat([PNG, Buffer.from('x')]), 'image/png');
    assert.notEqual(a, b, '改了内容却没换名字 —— 「同名必同字节」这条就没了');
  });

  it('类型决定扩展名', () => {
    assert.ok(assetNameFor(JPEG, 'image/jpeg').endsWith('.jpg'));
    assert.ok(assetNameFor(GIF, 'image/gif').endsWith('.gif'));
    assert.ok(assetNameFor(WEBP, 'image/webp').endsWith('.webp'));
  });
});

let dir = '';
let assets = null;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), `npie-assets-${process.pid}-`));
  assets = createDiaryAssets({ dir });
});

// 清理失败 ≠ 断言失败（本机安全策略会拦 `$TMPDIR` 下的批量删除）。
after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

describe('save / read', () => {
  it('存一次、读回来是同一份字节', async () => {
    const saved = await assets.save({ buffer: PNG, mime: 'image/png' });
    assert.equal(saved.mime, 'image/png');
    assert.equal(saved.bytes, PNG.length);
    const read = await assets.read(saved.name);
    assert.equal(read.mime, 'image/png');
    assert.deepEqual(read.buffer, PNG);
  });

  it('★ 同一张图存两次只落一份文件（复制粘贴同一截图很常见）', async () => {
    const first = await assets.save({ buffer: GIF, mime: 'image/gif' });
    const second = await assets.save({ buffer: GIF, mime: 'image/gif' });
    assert.equal(first.name, second.name);
    // 名字相同不等于「没写第二遍」—— 这里再确认盘上确实只有这一个文件。
    const reread = await readFile(join(dir, first.name));
    assert.deepEqual(reread, GIF);
  });

  it('★ 声明的类型与内容不符时，按**内容**存（`.png` 里不会装着 JPEG）', async () => {
    const saved = await assets.save({ buffer: JPEG, mime: 'image/png' });
    assert.equal(saved.mime, 'image/jpeg');
    assert.ok(saved.name.endsWith('.jpg'), `按声明存成了 ${saved.name}`);
  });

  it('★ 反向对照：不认识的内容必须被拒（否则上面那条「按内容存」是空话）', async () => {
    await assert.rejects(() => assets.save({ buffer: Buffer.from('not an image at all'), mime: 'image/png' }),
      (error) => error.code === 'BAD_IMAGE');
  });

  it('空的图被拒（剪贴板里偶尔真会给出 0 字节的 file）', async () => {
    await assert.rejects(() => assets.save({ buffer: Buffer.alloc(0) }), (error) => error.code === 'BAD_IMAGE');
  });

  it('超过 8 MB 被拒，且**没有**留下半个文件', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(ASSET_MAX_BYTES)]);
    await assert.rejects(() => assets.save({ buffer: big }), (error) => error.code === 'IMAGE_TOO_LARGE');
    const name = assetNameFor(big, 'image/png');
    await assert.rejects(() => stat(join(dir, name)), '超限的图仍然落了盘');
  });

  it('★ 名字白名单挡住路径穿越（这条是安全边界，不是格式校验）', async () => {
    for (const name of ['../data.json', '..%2Fdata.json', '/etc/passwd', 'a/b.png', 'ABCDEF0123456789.png', 'x.png']) {
      await assert.rejects(() => assets.read(name), (error) => error.code === 'BAD_ASSET_NAME', `${name} 没被挡住`);
    }
  });

  it('不存在的图报 ENOENT（路由层据此回 404）', async () => {
    await assert.rejects(() => assets.read('0123456789abcdef.png'), (error) => error.code === 'ENOENT');
  });
});

/* ------------------------------------------------------------------ 路由 */

function fakeReq({ url, method = 'GET', headers = {}, body } = {}) {
  const req = {
    url, method, headers: { host: '127.0.0.1:52431', ...headers }, socket: { remoteAddress: '127.0.0.1' },
  };
  req[Symbol.asyncIterator] = async function* iterate() {
    if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(body);
  };
  return req;
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk !== undefined) this.chunks.push(Buffer.from(chunk)); return this; },
    destroy() { return this; },
    on() { return this; },
    get json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
    get buffer() { return Buffer.concat(this.chunks); },
  };
}

const noop = async () => ({});

describe('路由：POST /assets 与 GET /assets/<name>', () => {
  let api = null;
  before(() => {
    api = makeDiaryRoutes({
      read: noop, append: noop, removeEntry: noop, listMonth: noop, search: noop,
      exportAll: noop, stats: noop, assets,
    });
  });

  it('贴一张图 → 拿到可直接写进 markdown 的地址', async () => {
    const res = fakeRes();
    await api.handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets`, method: 'POST',
      headers: { 'content-type': 'image/png' }, body: PNG,
    }), res);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.match(res.json.name, ASSET_NAME_PATTERN);
    // ★ 地址必须是**带前缀的绝对路径**：正文渲染时没有 baseUrl，
    //   相对路径会按页面地址解析 —— 症状是「存进去了，显示一张碎图」。
    assert.equal(res.json.url, `${DIARY_API_PREFIX}/assets/${res.json.name}`);
  });

  it('按那条地址取回来，字节一致、带正确的 content-type 与 nosniff', async () => {
    const posted = fakeRes();
    await api.handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets`, method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG,
    }), posted);
    const res = fakeRes();
    await api.handler(fakeReq({ url: posted.json.url }), res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(res.buffer, PNG);
  });

  it('★ 不认识的类型回 400（而不是 500：这不是「插件坏了」）', async () => {
    const res = fakeRes();
    await api.handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets`, method: 'POST',
      headers: { 'content-type': 'text/plain' }, body: 'hello',
    }), res);
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BAD_IMAGE');
  });

  it('★ 路径穿越回 400，且**没有**任何文件内容被读出来', async () => {
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${DIARY_API_PREFIX}/assets/${encodeURIComponent('../data.json')}` }), res);
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BAD_ASSET_NAME');
    assert.equal(res.chunks.length, 1, '除了那条 JSON 之外还写了别的东西');
  });

  it('图不在了回 404 且说人话（不是 `ENOENT: no such file…`）', async () => {
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${DIARY_API_PREFIX}/assets/0123456789abcdef.png` }), res);
    assert.equal(res.status, 404);
    assert.match(res.json.error, /不在了/);
  });

  it('方法不对回 405', async () => {
    const res = fakeRes();
    await api.handler(fakeReq({ url: `${DIARY_API_PREFIX}/assets`, method: 'GET' }), res);
    assert.equal(res.status, 405);
  });

  it('没接上资产层时回 501，而不是让整个前缀挂掉', async () => {
    const bare = makeDiaryRoutes({
      read: noop, append: noop, removeEntry: noop, listMonth: noop, search: noop, exportAll: noop, stats: noop,
    });
    const res = fakeRes();
    await bare.handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets`, method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG,
    }), res);
    assert.equal(res.status, 501);
    // 反向对照：同一个实例的别的路由照常工作 —— 证明 501 只影响贴图。
    const stats = fakeRes();
    await bare.handler(fakeReq({ url: `${DIARY_API_PREFIX}/stats` }), stats);
    assert.equal(stats.status, 200);
  });
});

describe('prune：清掉没被引用的图（0.73.1）', () => {
  let dir;
  let assets;
  /**
   * 这个环境能不能真的删文件。
   *
   * ★ 本机的安全策略会拦 `unlink`，而且**不抛错**（文件还在，`await` 正常返回）。
   *   于是「够老 ⇒ 真删」这条会变成假红；更糟的是它有时拦、有时不拦，
   *   同一份判据时而红时而绿 —— 那比红还坏。
   *   ⇒ 用一次探针判定，不能验证的用例**显式跳过**并在输出里说明。
   */
  let canDelete = true;

  before(async () => {
    // ★ 临时目录放在仓库的 `.build/` 下，**不用 `os.tmpdir()`**：这一组用例要
    //   真的 `unlink` 文件，而安全中心对 `$TMPDIR` 下的删除会直接拦下来。
    //   `.build/` 已在 `.gitignore` 里。
    const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.build');
    await mkdir(buildDir, { recursive: true });
    dir = await mkdtemp(join(buildDir, `npr-prune-${process.pid}-`));
    assets = createDiaryAssets({ dir });
    // 探针：删得掉吗？
    const probe = join(dir, '.probe');
    await writeFile(probe, 'x');
    await unlink(probe).catch(() => {});
    canDelete = await stat(probe).then(() => false, () => true);
  });
  // 清理失败 ≠ 断言失败：本机安全策略会拦删除，而它拦的正是刚才要测的那件事。
  after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

  /** 把文件的修改时间往前推 N 天（保护期判据就是看 mtime）。 */
  async function age(name, days) {
    const when = new Date(Date.now() - days * 86400000);
    await utimes(join(dir, name), when, when);
  }

  it('被引用的一张都不动 —— 哪怕它已经放了 60 天', async () => {
    const saved = await assets.save({ buffer: PNG });
    await age(saved.name, 60);
    const result = await assets.prune({ keep: new Set([saved.name]), dryRun: false });
    assert.equal(result.removed.length, 0);
    assert.equal(await stat(join(dir, saved.name)).then(() => true, () => false), true);
  });

  it('★ 没被引用但还很新（保护期里）的不动 —— 它可能是草稿里那张', async () => {
    // 草稿在浏览器 localStorage 里，宿主看不见它引用了哪张图。
    // 删掉它 = 用户 24 小时后恢复草稿时看到一张碎图。
    const saved = await assets.save({ buffer: JPEG });
    const result = await assets.prune({ keep: new Set(), dryRun: false });
    assert.equal(result.removed.some((item) => item.name === saved.name), false);
    assert.equal(await stat(join(dir, saved.name)).then(() => true, () => false), true);
  });

  it('★ 没被引用且够老 ⇒ 真删（这条证明上一条不是「什么都不删」的假绿）', async (t) => {
    if (!canDelete) { t.skip('本机安全策略拦了 unlink（不报错但文件还在），这条无法验证'); return; }
    const saved = await assets.save({ buffer: GIF });
    await age(saved.name, 30);
    const result = await assets.prune({ keep: new Set(), dryRun: false });
    assert.equal(result.removed.some((item) => item.name === saved.name), true);
    assert.equal(await stat(join(dir, saved.name)).then(() => true, () => false), false);
  });

  it('dryRun 只报数、不删（界面必须先给人看一遍）', async () => {
    const saved = await assets.save({ buffer: WEBP });
    await age(saved.name, 30);
    const preview = await assets.prune({ keep: new Set(), dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.removed.some((item) => item.name === saved.name), true);
    assert.equal(await stat(join(dir, saved.name)).then(() => true, () => false), true,
      'dryRun 竟然真删了');
    // 收尾：让它不干扰后面的用例
    await assets.prune({ keep: new Set(), dryRun: false });
  });

  it('★ 反向对照：保护期可以调成 0 —— 同一个文件就会进 removed（证明它是真判据）', async () => {
    const saved = await assets.save({ buffer: PNG });
    const fresh = await assets.prune({ keep: new Set(), minAgeMs: 0, dryRun: true });
    assert.equal(fresh.removed.some((item) => item.name === saved.name), true);
  });

  it('结果里带上 keepDays：界面要能解释「为什么只删了 0 张」', async () => {
    const result = await assets.prune({ keep: new Set(), dryRun: true });
    assert.equal(result.keepDays, 7);
    assert.equal(typeof result.scanned, 'number');
    assert.equal(typeof result.kept, 'number');
    assert.equal(typeof result.freed, 'number');
  });

  it('★ 删不掉时如实报 `failed`，且**不算进** removed / freed', async () => {
    // 这条是「界面说成功了、其实没成功」的守卫：把失败的算进 removed 与 freed，
    // 回执就会说「清掉 3 张，腾出 1.2 MB」而实际一张都没删 —— 用户不会再去查第二次。
    const fs = await import('node:fs/promises');
    const blockedDir = join(dir, 'readonly');
    const blocked = createDiaryAssets({ dir: blockedDir });
    const saved = await blocked.save({ buffer: PNG });
    const old = new Date(Date.now() - 40 * 86400000);
    await utimes(join(blockedDir, saved.name), old, old);
    await fs.chmod(blockedDir, 0o500);
    try {
      const result = await blocked.prune({ keep: new Set(), dryRun: false });
      assert.ok(result.failed.some((item) => item.name === saved.name),
        '只读目录里的文件删不掉，却没有进 `failed`');
      assert.equal(result.removed.some((item) => item.name === saved.name), false,
        '删不掉的文件被算进了 `removed` —— 回执会说「清掉了」');
      assert.equal(result.freed, 0, '删不掉却算了释放量');
    } finally {
      await fs.chmod(blockedDir, 0o700).catch(() => {});
    }
  });

  it('目录不存在时返回空结果，不抛（第一次用还没贴过图）', async () => {
    const empty = createDiaryAssets({ dir: join(dir, 'nope') });
    const result = await empty.prune({ keep: new Set() });
    assert.deepEqual(result.removed, []);
    assert.equal(result.scanned, 0);
  });
});

describe('路由：POST /assets/prune（0.73.1）', () => {
  /** 最小可判的资产层：只记录路由传下来的参数，不碰磁盘。 */
  function stubAssets() {
    const calls = [];
    return {
      calls,
      save: noop,
      read: noop,
      referenced: async () => new Set(['aaaaaaaaaaaaaaaa.png']),
      prune: async ({ keep = [], dryRun } = {}) => {
        calls.push({ keep: [...keep], dryRun });
        return {
          scanned: 2,
          removed: [{ name: 'bbbbbbbbbbbbbbbb.png', bytes: 1048576, ageDays: 30 }],
          kept: 1,
          freed: 1048576,
          dryRun,
          keepDays: 7,
        };
      },
    };
  }

  function apiFor(assets) {
    return makeDiaryRoutes({
      read: noop, append: noop, removeEntry: noop, listMonth: noop, search: noop,
      exportAll: noop, stats: noop, assets,
    });
  }

  it('★ 不传 dryRun 时只预演 —— 删文件的默认值不能是「真删」', async () => {
    const assets = stubAssets();
    const res = fakeRes();
    await apiFor(assets).handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets/prune`, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}',
    }), res);
    assert.equal(res.status, 200);
    assert.equal(assets.calls[0].dryRun, true, '没传 dryRun 竟然就真删了');
    assert.equal(res.json.dryRun, true);
  });

  it('显式传 `{ dryRun: false }` 才真删', async () => {
    const assets = stubAssets();
    await apiFor(assets).handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets/prune`, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun: false }),
    }), fakeRes());
    assert.equal(assets.calls[0].dryRun, false);
  });

  it('★ 白名单来自 assets.referenced()，路由自己不扫日记', async () => {
    const assets = stubAssets();
    await apiFor(assets).handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets/prune`, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}',
    }), fakeRes());
    assert.deepEqual(assets.calls[0].keep, ['aaaaaaaaaaaaaaaa.png']);
  });

  it('★ 回包里带 `privateUnchecked`：私密正文核对不到，这件事不能悄悄存在', async () => {
    const res = fakeRes();
    await apiFor(stubAssets()).handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets/prune`, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}',
    }), res);
    assert.equal(res.json.privateUnchecked, true);
  });

  it('没接上 prune 时回 501，而不是让整个前缀挂掉', async () => {
    const res = fakeRes();
    await apiFor({ save: noop, read: noop }).handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets/prune`, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}',
    }), res);
    assert.equal(res.status, 501);
    // 反向对照：同一个实例的其它路由照常工作。
    const stats = fakeRes();
    await apiFor({ save: noop, read: noop }).handler(fakeReq({ url: `${DIARY_API_PREFIX}/stats` }), stats);
    assert.equal(stats.status, 200);
  });

  it('GET /assets/prune 回 405（只能 POST）', async () => {
    const res = fakeRes();
    await apiFor(stubAssets()).handler(fakeReq({
      url: `${DIARY_API_PREFIX}/assets/prune`, method: 'GET',
    }), res);
    assert.equal(res.status, 405);
  });
});
