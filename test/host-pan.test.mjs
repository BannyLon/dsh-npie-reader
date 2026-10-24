/**
 * 网盘取字节（`src/host/pan.js`）—— 网盘书源的数据源。
 *
 * ★ 本文件**完全不联网**：`fetchImpl` / 凭证路径 / 时钟 / 块大小全部从参数进来。
 *   这不是为了好写测试，而是为了**能测**：这条链路上「token 过期」「直链偶发 403」
 *   「keep-alive 连接被静默丢弃」都只在真机上偶发，靠手工点是测不出来的。
 *
 * ★ 一条贯穿全文件的断言：**续期结果必须写回凭证文件**（0.18.1 起）。
 *   以前这里写的是「凭证文件只读，刷新结果只留内存」，那条契约是错的：百度每次续期都
 *   换发新的 refresh_token、旧的当场作废，只留内存 ⇒ 进程一重启手里就只剩一个作废的
 *   refresh_token ⇒ 之后每次续期都报 `refresh token has been used`（2026-10-23 实测）。
 *   写入者仍然只有一个 —— `pan.js` 把新值交给 `panAuth.saveToken`，自己不碰那个文件。
 *   所以每个刷新用例都**逐字节比对刷新前后的文件内容**，看它到底变没变、变了什么。
 *
 * ★ 0.7.2 起凭证路径是**必填**（不再回落到 `~/.baidu-pan-*`），见「构造参数校验」。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createPanReader, explainFetchError, PAN_UA } from '../src/host/pan.js';
import { createPanAuth } from '../src/host/pan-auth.js';

const SANDBOX = await mkdtemp(join(tmpdir(), 'npie-pan-'));
after(() => rm(SANDBOX, { recursive: true, force: true }));

const TOKEN_PATH = join(SANDBOX, 'token.json');
const APP_PATH = join(SANDBOX, 'app.json');

/** 确定性内容：第 i 个字节是 `i % 256`，于是「取到的是哪一段」可以直接按值断言。 */
const CONTENT = Buffer.from(Array.from({ length: 32 }, (_, index) => index % 256));
const FS_ID = 987654321;
const DLINK_BASE = 'https://d.pcs.baidu.com/file/abc123?fid=1-2-3';

async function writeCredentials(token, app) {
  if (token === undefined) await rm(TOKEN_PATH, { force: true });
  else await writeFile(TOKEN_PATH, JSON.stringify(token));
  if (app === undefined) await rm(APP_PATH, { force: true });
  else await writeFile(APP_PATH, JSON.stringify(app));
}

/**
 * 假网盘：认 `filemetas` 与 dlink 两类 URL，按 `Range` 头切内容。
 *
 * @param options.metaPlan - 每次 `filemetas` 依次返回的 payload（用完则复用最后一个）。
 * @param options.dlinkPlan - 每次 dlink 请求依次返回的 `{status}` 或 `{throw}`（用完则复用最后一个）。
 * @param options.oauth - `/oauth/2.0/token` 的返回（函数或对象）。
 * @param options.content - 文件内容。
 */
function fakePan(options = {}) {
  const {
    content = CONTENT,
    metaPlan = [{ errno: 0, list: [{ dlink: DLINK_BASE }] }],
    dlinkPlan = [{ status: 206 }],
    oauth = { access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 2_592_000 },
  } = options;

  const calls = { meta: [], dlink: [], oauth: [] };

  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const headers = init.headers ?? {};

    if (href.startsWith('https://openapi.baidu.com/oauth/2.0/token')) {
      calls.oauth.push({ href, headers });
      const payload = typeof oauth === 'function' ? oauth(calls.oauth.length) : oauth;
      if (payload?.throw) throw payload.throw;
      return jsonResponse(200, payload);
    }

    if (href.includes('/rest/2.0/xpan/multimedia')) {
      calls.meta.push({ href, headers });
      const payload = metaPlan[Math.min(calls.meta.length - 1, metaPlan.length - 1)];
      if (payload?.throw) throw payload.throw;
      return jsonResponse(200, payload);
    }

    calls.dlink.push({ href, headers });
    const plan = dlinkPlan[Math.min(calls.dlink.length - 1, dlinkPlan.length - 1)];
    if (plan?.throw) throw plan.throw;
    if (plan.status !== 206 && plan.status !== 200) {
      return { status: plan.status, async arrayBuffer() { return new ArrayBuffer(0); } };
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(headers.Range ?? ''));
    assert.notEqual(match, null, `dlink 请求没带合法的 Range 头：${String(headers.Range)}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const slice = content.subarray(start, end + 1);
    return {
      status: 206,
      async arrayBuffer() { return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength); },
    };
  };

  return { fetchImpl, calls };
}

function jsonResponse(status, payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    status,
    async json() { return payload; },
    async arrayBuffer() { return bytes.buffer; },
  };
}

const VALID_TOKEN = { access_token: 'good-token', refresh_token: 'r1', expires_at: Date.now() + 3_600_000 };
const APP = { appKey: 'APP-KEY', secretKey: 'APP-SECRET' };

function reader(overrides = {}) {
  const pan = fakePan(overrides.pan);
  const instance = createPanReader({
    fetchImpl: pan.fetchImpl,
    tokenPath: TOKEN_PATH,
    appPath: APP_PATH,
    blockBytes: 8,
    maxBlocks: 4,
    ...overrides.options,
  });
  return { pan: instance, calls: pan.calls };
}

/**
 * 真凭证写入器，指向同一对路径。
 *
 * ★ 测「写回」时用它而不是造假函数：真实现里那次「读旧文件再合并」正是
 *   「未知字段必须透传」的落点，造假函数会把这一层绕过去，测出来的绿是假的。
 */
function panAuth() {
  return createPanAuth({ appPath: APP_PATH, tokenPath: TOKEN_PATH });
}

// ---------------------------------------------------------------------------

describe('构造参数校验', () => {
  it('fetchImpl 必须是函数（否则要等到第一次读书才炸，症状离原因很远）', () => {
    assert.throws(() => createPanReader({ fetchImpl: 'x' }), /fetchImpl 必须是函数/);
    assert.throws(() => createPanReader({ fetchImpl: 42 }), /fetchImpl 必须是函数/);
    assert.throws(() => createPanReader({ fetchImpl: {} }), /fetchImpl 必须是函数/);
    // 反向对照：`null` / `undefined` 表示「没传」，回落到全局 fetch —— 这是刻意的
    // （`??` 对两者都回落），所以它们**不该**抛。
    assert.doesNotThrow(() => createPanReader({ fetchImpl: undefined, tokenPath: TOKEN_PATH, appPath: APP_PATH }));
    assert.doesNotThrow(() => createPanReader({ fetchImpl: null, tokenPath: TOKEN_PATH, appPath: APP_PATH }));
  });

  it('blockBytes / maxBlocks 必须是正整数', () => {
    for (const blockBytes of [0, -1, 1.5, Number.NaN, '8']) {
      assert.throws(() => createPanReader({ fetchImpl: async () => {}, blockBytes }), /blockBytes 必须是正整数/, String(blockBytes));
    }
    for (const maxBlocks of [0, -1, 2.5]) {
      assert.throws(() => createPanReader({ fetchImpl: async () => {}, maxBlocks }), /maxBlocks 必须是正整数/, String(maxBlocks));
    }
  });

  /**
   * ★ 凭证路径**必填**，没有默认值。
   *
   * 以前它们回落到 `~/.baidu-pan-{token,app}.json`（**另一个项目**写出来的文件）。
   * 那个默认值的真实代价不是「多一个便利」，而是：任何忘了传路径的调用方都会**静默**
   * 走上「读别人项目的凭证」这条旧路。0.7.2 的决定是插件自己管凭证，所以这条旧路
   * 必须**结构性**地堵掉 —— 忘了传就在构造时抛，而不是等用户点开一本书才发现
   * 读的是谁的文件。
   */
  it('★ 凭证路径必填 —— 反向对照：不传就必须抛，不允许悄悄回落去读别的项目的凭证', () => {
    for (const missing of [undefined, null, '']) {
      assert.throws(() => createPanReader({ fetchImpl: async () => {}, tokenPath: missing, appPath: APP_PATH }),
        /需要 tokenPath/, `tokenPath=${String(missing)}`);
      assert.throws(() => createPanReader({ fetchImpl: async () => {}, tokenPath: TOKEN_PATH, appPath: missing }),
        /需要 appPath/, `appPath=${String(missing)}`);
    }
    // 反向对照的另一半：两个都给齐了就**不该**抛（否则上面那几条可能只是因为
    // 别的原因在抛，断言就假绿了）。
    assert.doesNotThrow(() => createPanReader({ fetchImpl: async () => {}, tokenPath: TOKEN_PATH, appPath: APP_PATH }));
  });

  it('构造本身不碰网络（一切取数都是惰性的）', () => {
    const { calls } = reader();
    assert.deepEqual(calls.meta, []);
    assert.deepEqual(calls.dlink, []);
    assert.deepEqual(calls.oauth, []);
  });
});

describe('ensureToken', () => {
  it('没有凭证文件时抛 NO_TOKEN，并把**该去哪儿点**写进消息里', async () => {
    await writeCredentials(undefined, undefined);
    const { pan } = reader();
    await assert.rejects(() => pan.ensureToken(), (error) => {
      assert.equal(error.code, 'NO_TOKEN');
      assert.match(error.message, /插件设置/);
      // 反向对照：消息里**不许**再指向 `tools/pan/auth.mjs login` —— 那是插件仓库里的
      // 开发脚本，别人装完的机器上根本没有它，照着跑只会得到一句 command not found。
      // 授权入口必须落在**用户真的能点到**的地方。
      assert.doesNotMatch(error.message, /auth\.mjs/);
      return true;
    });
  });

  it('token 文件里没有 access_token 也抛 NO_TOKEN', async () => {
    await writeCredentials({ refresh_token: 'r1' }, APP);
    const { pan } = reader();
    // ★ 断言的是 **code** 而不是消息文本：消息是给用户看的文案，会随文案调整而变；
    //   调用方（路由层）分派靠的是 code。
    await assert.rejects(() => pan.ensureToken(), (error) => {
      assert.equal(error.code, 'NO_TOKEN');
      return true;
    });
  });

  it('未过期的 token 直接用，**不发任何请求**', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    assert.equal(await pan.ensureToken(), 'good-token');
    assert.deepEqual(calls.oauth, []);
    assert.deepEqual(calls.meta, []);
  });

  it('过期时用 refresh_token 续期：请求形态正确（grant_type / client_id / client_secret）', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, APP);
    const { pan, calls } = reader();
    assert.equal(await pan.ensureToken(), 'fresh-token');

    assert.equal(calls.oauth.length, 1);
    const url = new URL(calls.oauth[0].href);
    assert.equal(url.pathname, '/oauth/2.0/token');
    assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
    assert.equal(url.searchParams.get('refresh_token'), 'r1');
    assert.equal(url.searchParams.get('client_id'), 'APP-KEY');
    assert.equal(url.searchParams.get('client_secret'), 'APP-SECRET');
    assert.equal(calls.oauth[0].headers['User-Agent'], PAN_UA);
  });

  /**
   * ★★ 0.18.1 的核心修复。旧版本这里断言的是**反面**（「绝不回写」），而那条契约是错的：
   * 百度每次续期都换发新的 refresh_token、旧的当场作废，只留内存 ⇒ 进程一重启手里只剩
   * 一个作废的 refresh_token ⇒ 之后每次续期都报 `refresh token has been used`。
   * 断言从「文件没变」翻成「文件变了、而且变对了」——同一个位置，牙朝相反方向。
   */
  it('★★ 续期结果必须写回凭证文件：refresh_token 会被换发，丢了就再也续不上', async () => {
    const expired = { ...VALID_TOKEN, appKey: 'APP-KEY', scope: 'basic netdisk', expires_at: Date.now() - 1000 };
    await writeCredentials(expired, APP);

    const { pan, calls } = reader({ options: { saveToken: token => panAuth().saveToken(token) } });
    assert.equal(await pan.ensureToken(), 'fresh-token');
    // 第二次必须走内存里的覆盖值，而不是再刷一次。
    assert.equal(await pan.ensureToken(), 'fresh-token');
    assert.equal(calls.oauth.length, 1, '第二次不该再刷新');

    const saved = JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
    assert.equal(saved.access_token, 'fresh-token');
    assert.equal(saved.refresh_token, 'fresh-refresh', '换发出来的 refresh_token 没写回文件 —— 重启后就会报 refresh token has been used');
    assert.ok(saved.expires_at > Date.now(), '写回的过期时间必须是未来的');
    // ★ 未知字段必须透传（「有损模型」陷阱）：一次续期不许把 appKey / scope 抹掉。
    assert.equal(saved.appKey, 'APP-KEY');
    assert.equal(saved.scope, 'basic netdisk');
  });

  it('反向对照：不传 saveToken 时确实一个字都不写（证明上一条不是别的机制在写盘）', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, APP);
    const before = await readFile(TOKEN_PATH, 'utf8');
    const { pan } = reader();
    assert.equal(await pan.ensureToken(), 'fresh-token');
    assert.equal(await readFile(TOKEN_PATH, 'utf8'), before, '没传 saveToken 却写了盘');
  });

  it('写回失败不能让阅读失败，但必须留一条日志（否则这个 bug 又被藏起来）', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, APP);
    const logs = [];
    const { pan } = reader({
      options: {
        log: message => logs.push(message),
        saveToken: async () => { throw new Error('EROFS: read-only file system'); },
      },
    });
    assert.equal(await pan.ensureToken(), 'fresh-token', '写盘失败不该让这次取数失败');
    assert.ok(
      logs.some(line => /写回凭证文件失败/.test(line) && /EROFS/.test(line)),
      `日志里没有写回失败：${logs.join(' | ')}`,
    );
  });

  /**
   * ★ 续期是**一次性**的：两个并发请求各发一次刷新，第一个成功、第二个必报
   *   `refresh token has been used`。而并发是常态 —— pdf.js 打开一本书会同时要好几段
   *   字节，每段都走 `ensureToken()`。
   */
  it('★ 并发 ensureToken 只发一次续期请求', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, APP);
    const { pan, calls } = reader();
    const [a, b, c] = await Promise.all([pan.ensureToken(), pan.ensureToken(), pan.ensureToken()]);
    assert.equal(a, 'fresh-token');
    assert.equal(b, 'fresh-token');
    assert.equal(c, 'fresh-token');
    assert.equal(calls.oauth.length, 1, `并发刷新了 ${calls.oauth.length} 次，第二次以后必然报 refresh token has been used`);
  });

  it('★ `refresh token has been used` 单独归类，不许说成「30 天有效期到了」', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, APP);
    const { pan } = reader({
      pan: { oauth: { error: 'invalid_grant', error_description: 'refresh token has been used' } },
    });
    await assert.rejects(() => pan.ensureToken(), (error) => {
      assert.equal(error.code, 'REFRESH_CONSUMED');
      assert.match(error.message, /重新授权/);
      // 反向对照：把「用过了」说成「有效期到了」，用户会以为每 30 天手动授权是常态。
      assert.doesNotMatch(error.message, /有效期通常 30 天/);
      return true;
    });
  });

  /** ★★ 端到端：换发出来的 refresh_token 必须能被**下一个进程**用上。 */
  it('★★ 模拟重启：第二个进程送出去的是换发出来的新 refresh_token', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, APP);
    const auth = panAuth();
    const first = reader({ options: { saveToken: token => auth.saveToken(token) } });
    assert.equal(await first.pan.ensureToken(), 'fresh-token');

    // 「重启」= 丢掉内存；再把文件里的 access_token 置为过期，模拟 30 天后再读。
    const saved = JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
    await writeFile(TOKEN_PATH, JSON.stringify({ ...saved, expires_at: Date.now() - 1000 }));

    const second = reader({
      pan: { oauth: { access_token: 'second-token', refresh_token: 'r3', expires_in: 2_592_000 } },
    });
    assert.equal(await second.pan.ensureToken(), 'second-token');
    const url = new URL(second.calls.oauth[0].href);
    assert.equal(url.searchParams.get('refresh_token'), 'fresh-refresh', '送出去的还是那个已经作废的旧 refresh_token');
  });

  it('token 过期且没有 AppKey/SecretKey 时抛 NO_APP（并指出去哪儿补）', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, undefined);
    const { pan } = reader();
    await assert.rejects(() => pan.ensureToken(), (error) => {
      assert.equal(error.code, 'NO_APP');
      assert.match(error.message, /插件设置/);
      assert.doesNotMatch(error.message, /auth\.mjs/);
      return true;
    });
  });

  it('没有 refresh_token 时抛 NO_REFRESH', async () => {
    await writeCredentials({ access_token: 'x', expires_at: Date.now() - 1000 }, APP);
    const { pan } = reader();
    await assert.rejects(() => pan.ensureToken(), (error) => {
      assert.equal(error.code, 'NO_REFRESH');
      return true;
    });
  });

  it('刷新请求本身失败 → REFRESH_FAILED，且消息里有底层原因', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, APP);
    const { pan } = reader({
      pan: { oauth: { throw: Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) } },
    });
    await assert.rejects(() => pan.ensureToken(), (error) => {
      assert.equal(error.code, 'REFRESH_FAILED');
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
  });

  it('刷新返回里没有 access_token → REFRESH_FAILED，并把网盘给的错误描述带出来', async () => {
    await writeCredentials({ ...VALID_TOKEN, expires_at: Date.now() - 1000 }, APP);
    const { pan } = reader({ pan: { oauth: { error: 'invalid_grant', error_description: 'refresh token 已失效' } } });
    await assert.rejects(() => pan.ensureToken(), (error) => {
      assert.equal(error.code, 'REFRESH_FAILED');
      assert.match(error.message, /refresh token 已失效/);
      return true;
    });
  });

  it('凭证文件是坏 JSON → BAD_CREDENTIAL_FILE（区别于「没有授权」）', async () => {
    await writeFile(TOKEN_PATH, '{ 这不是 JSON');
    const { pan } = reader();
    await assert.rejects(() => pan.ensureToken(), (error) => {
      assert.equal(error.code, 'BAD_CREDENTIAL_FILE');
      return true;
    });
  });
});

describe('dlinkOf', () => {
  it('取直链的请求形态正确（method / fsids / dlink=1 / UA），并拼上 access_token', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    const dlink = await pan.dlinkOf(FS_ID);

    assert.equal(calls.meta.length, 1);
    const url = new URL(calls.meta[0].href);
    assert.equal(url.pathname, '/rest/2.0/xpan/multimedia');
    assert.equal(url.searchParams.get('method'), 'filemetas');
    assert.equal(url.searchParams.get('dlink'), '1');
    assert.equal(url.searchParams.get('fsids'), JSON.stringify([FS_ID]));
    assert.equal(url.searchParams.get('access_token'), 'good-token');
    assert.equal(calls.meta[0].headers['User-Agent'], PAN_UA);

    // 不带 token 的直链会回 403 user not exists，所以这一步不是可选的。
    assert.equal(dlink, `${DLINK_BASE}&access_token=good-token`);
  });

  it('直链有缓存：同一本书第二次不再问 filemetas', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    await pan.dlinkOf(FS_ID);
    await pan.dlinkOf(FS_ID);
    assert.equal(calls.meta.length, 1);
  });

  it('errno != 0 → META_ERRNO（把 errno 带出来）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan } = reader({ pan: { metaPlan: [{ errno: -9, list: [] }] } });
    await assert.rejects(() => pan.dlinkOf(FS_ID), (error) => {
      assert.equal(error.code, 'META_ERRNO');
      assert.match(error.message, /-9/);
      return true;
    });
  });

  it('没有直链字段 → NO_DLINK', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan } = reader({ pan: { metaPlan: [{ errno: 0, list: [{ path: '/x' }] }] } });
    await assert.rejects(() => pan.dlinkOf(FS_ID), (error) => {
      assert.equal(error.code, 'NO_DLINK');
      return true;
    });
  });
});

describe('readRange', () => {
  it('区间是**闭**的，取到的是内容里那一段', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan } = reader();
    const bytes = await pan.readRange(FS_ID, 0, 3);
    assert.equal(bytes.length, 4);
    assert.deepEqual([...bytes], [...CONTENT.subarray(0, 4)]);
  });

  it('★ 请求是按块对齐的（把几十个小 Range 压成几次大请求）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    // blockBytes=8：读 2..5 只该要一整块 0-7。
    await pan.readRange(FS_ID, 2, 5);
    assert.equal(calls.dlink.length, 1);
    assert.equal(calls.dlink[0].headers.Range, 'bytes=0-7');
  });

  it('跨块时按块取再拼（内容必须无缝）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    const bytes = await pan.readRange(FS_ID, 6, 17);
    // 拼接的正确性由**内容**断言 —— 这才是契约。
    assert.equal(bytes.length, 12);
    assert.deepEqual([...bytes], [...CONTENT.subarray(6, 18)]);
    // 6..17 落在第 0、1、2 块 ⇒ 三次请求，各自对齐。
    // ★ 但**顺序**不是契约：`mapLimited` 是并发的（上限 4），谁先回来谁先记录。
    //   断言顺序会得到一个「跑得快就绿、跑得慢就红」的用例 —— 那不是判据。
    assert.deepEqual(calls.dlink.map((call) => call.headers.Range).sort(), ['bytes=0-7', 'bytes=16-23', 'bytes=8-15']);
  });

  it('★ 返回的是**新** Buffer，不是块缓存里的切片（否则等于把缓存交给 socket）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    const first = await pan.readRange(FS_ID, 0, 3);
    first[0] = 0xFF;
    const again = await pan.readRange(FS_ID, 0, 3);
    assert.equal(again[0], CONTENT[0], '改返回值污染了块缓存');
    assert.equal(calls.dlink.length, 1, '第二次应当命中缓存');
  });

  it('块缓存命中时不再发请求（`blocksServed` 计数）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    await pan.readRange(FS_ID, 0, 3);
    await pan.readRange(FS_ID, 4, 7);
    const stats = pan.stats();
    assert.equal(calls.dlink.length, 1);
    assert.equal(stats.blocksFetched, 1);
    assert.equal(stats.blocksServed, 1);
  });

  it('★ 并发读同一块只发一次请求（`inflight` 合流）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    await Promise.all([
      pan.readRange(FS_ID, 0, 1),
      pan.readRange(FS_ID, 2, 3),
      pan.readRange(FS_ID, 4, 5),
    ]);
    assert.equal(calls.dlink.length, 1, '同一个块被并发取了多次');
  });

  it('★ LRU：超过 maxBlocks 后最久没用过的块被挤掉，再读要重取', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader({ options: { maxBlocks: 2 } });
    await pan.readRange(FS_ID, 0, 0);    // 块 0
    await pan.readRange(FS_ID, 8, 8);    // 块 1
    await pan.readRange(FS_ID, 16, 16);  // 块 2 ⇒ 挤掉块 0
    assert.equal(pan.stats().blockEntries, 2);
    await pan.readRange(FS_ID, 0, 0);    // 块 0 已被挤掉 ⇒ 重取
    assert.equal(calls.dlink.length, 4);
    assert.equal(pan.stats().meta, 1, '直链缓存不该跟着块缓存一起丢');
  });

  it('一次要读太多块时拒绝（防上层一个手滑把整本拖下来）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader({ options: { blockBytes: 1 } });
    await assert.rejects(() => pan.readRange(FS_ID, 0, 40), (error) => {
      assert.equal(error.code, 'RANGE_TOO_LARGE');
      assert.match(error.message, /超过单次上限/);
      return true;
    });
    assert.deepEqual(calls.dlink, [], '拒绝之后不该已经发出请求');
  });

  it('★ 边界：正好 32 块是允许的，33 块才拒（否则守卫会误杀合法请求）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan } = reader({ options: { blockBytes: 1 } });
    const ok = await pan.readRange(FS_ID, 0, 31);
    assert.equal(ok.length, 32);
    // ★ 断言的是 `code` 而不是消息文本：`assert.rejects(fn, /RE/)` 匹配的是
    //   `error.message`，而错误码不在消息里 —— 写成正则会永远不匹配。
    await assert.rejects(() => pan.readRange(FS_ID, 0, 32), (error) => {
      assert.equal(error.code, 'RANGE_TOO_LARGE');
      return true;
    });
  });

  it('非法区间直接抛 BAD_RANGE', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan } = reader();
    for (const [start, end] of [[-1, 3], [5, 4], [1.5, 3], [0, Number.NaN], ['0', 3]]) {
      await assert.rejects(() => pan.readRange(FS_ID, start, end), (error) => {
        assert.equal(error.code, 'BAD_RANGE', `${start}-${end}`);
        return true;
      });
    }
  });

  it('网盘在该处已经没有数据 → PAN_EOF（而不是回一个空 Buffer 让上层以为读到了）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan } = reader();
    // 内容只有 32 字节，但块大小 8 ⇒ 块 4 完全在文件之外，网盘会回空。
    await assert.rejects(() => pan.readRange(FS_ID, 32, 32), (error) => {
      assert.equal(error.code, 'PAN_EOF');
      return true;
    });
  });
});

describe('重试与直链失效', () => {
  it('★ 403 不等于「这本书读不了」：丢掉直链重取一次就能成功', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader({
      pan: { dlinkPlan: [{ status: 403 }, { status: 206 }] },
    });
    const bytes = await pan.readRange(FS_ID, 0, 3);
    assert.deepEqual([...bytes], [...CONTENT.subarray(0, 4)]);
    // 403 之后必须**重新问一次 filemetas**（用旧直链重试是没用的）。
    assert.equal(calls.meta.length, 2);
    assert.equal(pan.stats().retries, 1);
  });

  it('401 同样触发丢弃直链重取', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader({ pan: { dlinkPlan: [{ status: 401 }, { status: 206 }] } });
    await pan.readRange(FS_ID, 0, 3);
    assert.equal(calls.meta.length, 2);
  });

  it('★ 瞬时网络错误（keep-alive 连接被静默丢弃）退避重试后成功', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader({
      pan: {
        dlinkPlan: [
          { throw: Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }) },
          { status: 206 },
        ],
      },
    });
    const bytes = await pan.readRange(FS_ID, 0, 3);
    assert.equal(bytes.length, 4);
    assert.equal(calls.dlink.length, 2);
    assert.equal(pan.stats().retries, 1);
  });

  it('连续 3 次都失败 → PAN_FETCH_FAILED，消息里带底层原因', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader({ pan: { dlinkPlan: [{ status: 500 }] } });
    await assert.rejects(() => pan.readRange(FS_ID, 0, 3), (error) => {
      assert.equal(error.code, 'PAN_FETCH_FAILED');
      assert.match(error.message, /已重试 3 次/);
      assert.match(error.message, /HTTP 500/);
      return true;
    });
    assert.equal(calls.dlink.length, 3);
  });
});

describe('磁盘块缓存（0.8.6：重启 dsh 不再重新取书）', () => {
  const CACHE_DIR = join(SANDBOX, 'pan-cache');

  function cachedReader(overrides = {}) {
    return reader({ options: { cacheDir: CACHE_DIR, ...overrides } });
  }

  it('★ 取过的块落盘；**新实例**（模拟重启）直接从盘上读，不再发网盘请求', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    await rm(CACHE_DIR, { recursive: true, force: true });

    const first = cachedReader();
    const bytes = await first.pan.readRange(FS_ID, 8, 11);
    assert.deepEqual([...bytes], [...CONTENT.subarray(8, 12)]);
    const firstStats = first.pan.stats();
    assert.equal(firstStats.diskWrites, 1, '块应已落盘');
    assert.ok(firstStats.diskBytes >= 8, `diskBytes=${firstStats.diskBytes}`);

    // 全新实例 = 内存缓存全空（dlink/block 都没了），只有磁盘还在。
    const second = cachedReader();
    const again = await second.pan.readRange(FS_ID, 8, 11);
    assert.deepEqual([...again], [...CONTENT.subarray(8, 12)]);
    const secondStats = second.pan.stats();
    assert.equal(secondStats.diskHits, 1, '应当记一次磁盘命中');
    assert.equal(second.calls.dlink.length, 0, '重启后不许再向网盘要同一块');
    assert.equal(second.calls.meta.length, 0, '连直链都不用要');
  });

  it('readRange 返回的仍是新 Buffer，改它不污染磁盘缓存', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const first = cachedReader();
    const bytes = await first.pan.readRange(FS_ID, 0, 3);
    bytes[0] = 0xFF;

    const second = cachedReader();
    const again = await second.pan.readRange(FS_ID, 0, 3);
    assert.equal(again[0], CONTENT[0]);
  });

  it('不传 cacheDir → 行为与旧版完全一致（不落盘）', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    await pan.readRange(FS_ID, 0, 3);
    assert.equal(pan.stats().diskCache, null);
    assert.equal(pan.stats().diskWrites, 0);
    // 反向对照：确实发了网盘请求（不是被别的机制救了）。
    assert.equal(calls.dlink.length, 1);
  });

  it('超过 cacheMaxBytes → 按「整本书」最近写入先删，刚读的书不被淘汰', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    await rm(CACHE_DIR, { recursive: true, force: true });
    // 每块 8 字节，上限 16 字节 = 只装得下两块。用两本不同的书制造两个目录。
    const old = cachedReader({ cacheMaxBytes: 16 });
    await old.pan.readRange(FS_ID, 0, 1);   // 旧书第 0 块
    // 等一下，保证两个目录的文件 mtime 有先后。
    await new Promise((resolveAt) => setTimeout(resolveAt, 25));
    // 新书连写两块 ⇒ 总量 24 > 16 ⇒ 触发淘汰。最近写入排序下旧书最旧，整本删它。
    await old.pan.readRange(11111111, 0, 1);
    await old.pan.readRange(11111111, 8, 9);
    assert.ok(old.pan.stats().diskEvictions >= 1, '应当淘汰过一次');
    const { readdir: ls } = await import('node:fs/promises');
    const books = await ls(CACHE_DIR);
    assert.deepEqual(books.sort(), ['11111111'], `剩下的应是新书：${JSON.stringify(books)}`);
  });

  it('块缓存文件损坏（读出错）→ 当没有，向网盘重取，不炸', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const first = cachedReader();
    await first.pan.readRange(FS_ID, 0, 3);
    // 故意把缓存写成目录，readFile 会抛 EISDIR。
    const { rename: mv } = await import('node:fs/promises');
    await mv(join(CACHE_DIR, String(FS_ID), '0.blk'), join(CACHE_DIR, String(FS_ID), '0.corrupt'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(CACHE_DIR, String(FS_ID), '0.blk'));
    await mv(join(CACHE_DIR, String(FS_ID), '0.corrupt'), join(CACHE_DIR, String(FS_ID), '0.blk/0.blk'));
    // 上面的操作把 0.blk 变成了目录（内含原文件）。重新读要能自愈。
    const second = cachedReader();
    const bytes = await second.pan.readRange(FS_ID, 0, 3);
    assert.deepEqual([...bytes], [...CONTENT.subarray(0, 4)]);
    assert.equal(second.calls.dlink.length, 1, '坏块走了网盘重取');
  });
});

describe('clear / stats', () => {
  it('clear() 丢掉所有缓存（含凭证覆盖），下一次读会重新问一遍', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan, calls } = reader();
    await pan.readRange(FS_ID, 0, 3);
    pan.clear();
    assert.equal(pan.stats().blockEntries, 0);
    assert.equal(pan.stats().dlinkEntries, 0);
    await pan.readRange(FS_ID, 0, 3);
    assert.equal(calls.meta.length, 2);
  });

  it('stats() 报出块大小，便于诊断「一次读多少」', async () => {
    await writeCredentials(VALID_TOKEN, APP);
    const { pan } = reader();
    assert.equal(pan.stats().blockBytes, 8);
  });
});

describe('explainFetchError', () => {
  it('★ 把 Node 那句没用的 "fetch failed" 底下的真实 code 挖出来', () => {
    // 只打印 error.message 的话，日志里永远只有 "fetch failed" —— 排查时等于没有信息。
    const error = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    assert.equal(explainFetchError(error), 'fetch failed ← ECONNRESET');
  });

  it('没有 cause 时退回 message；非 Error 也能处理', () => {
    assert.equal(explainFetchError(new Error('boom')), 'boom');
    assert.equal(explainFetchError('plain string'), 'plain string');
    assert.equal(explainFetchError(undefined), 'undefined');
  });
});
