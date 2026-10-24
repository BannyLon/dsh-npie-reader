/**
 * 百度网盘授权（`src/host/pan-auth.js`）。
 *
 * ★ 本文件最重要的一条：**`status()` 绝不回传 token / SecretKey**。
 *   它会被设置页整个读出来并渲染 —— token 落在界面数据里，等于把网盘的全盘读权限
 *   摊在设置页上（任何一个能读那段响应的东西都拿到了它）。所以那条用例不只查
 *   特征串，还查字段名（防止有人「顺手」把 `access_token` 加进返回值）。
 *
 * ★ 另一条结构性契约：**两个请求的 User-Agent 故意不同**（授权页装浏览器、token 接口
 *   装网盘）。这是跑通过的实现里实测出来的，看起来像手滑，实际上是必需的 ——
 *   用例把它固定下来，免得下次有人「顺手统一」。
 *
 * 全部外部依赖都从参数进来（fetch / 凭证路径），所以这里不联网、也不碰真凭证。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  APP_KEY_RE,
  OAUTH_BASE,
  authorizeUrl,
  checkClient,
  createPanAuth,
  exchangeCode,
  refreshToken,
} from '../src/host/pan-auth.js';

const SANDBOX = await mkdtemp(join(tmpdir(), 'npie-auth-'));
const APP_PATH = join(SANDBOX, 'pan-app.json');
const TOKEN_PATH = join(SANDBOX, 'pan-token.json');

const APP = { appKey: 'APPKEY123456', secretKey: 'APPSECRET123456' };
const TOKEN_OK = { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'basic,netdisk' };

after(() => rm(SANDBOX, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(APP_PATH, { force: true });
  await rm(TOKEN_PATH, { force: true });
});

/** 记下每次请求的 url / init，并按给定文本作答。 */
function record(text) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => text };
    },
  };
}

const jsonFetch = (payload) => record(JSON.stringify(payload)).fetchImpl;

function authorizer(options = {}) {
  return createPanAuth({
    appPath: APP_PATH,
    tokenPath: TOKEN_PATH,
    fetchImpl: options.fetchImpl,
    log: options.log,
  });
}

describe('authorizeUrl', () => {
  it('是一条完整的授权页地址，五组参数与已跑通的实现逐字一致', () => {
    const url = new URL(authorizeUrl('APPKEY123456'));
    assert.equal(`${url.origin}${url.pathname}`, `${OAUTH_BASE}/authorize`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'APPKEY123456');
    assert.equal(url.searchParams.get('redirect_uri'), 'oob');
    assert.equal(url.searchParams.get('scope'), 'basic,netdisk');
    assert.equal(url.searchParams.get('device_id'), 'APPKEY123456');
  });

  it('★ `redirect_uri=oob` 是整套流程能成立的前提', () => {
    // out-of-band ⇒ 授权码直接显示在页面上，用户复制粘贴回来。改成回调地址就意味着
    // 插件要在宿主里起一个回调端口 —— 那是另一件麻烦事，而成品实现验证过的就是这条。
    assert.equal(new URL(authorizeUrl('K')).searchParams.get('redirect_uri'), 'oob');
    // `scope` 少了 netdisk 就列不了目录（书源扫描整条走不通）。
    assert.equal(new URL(authorizeUrl('K')).searchParams.get('scope'), 'basic,netdisk');
    // 授权码模式（而非简化模式）才拿得到 refresh_token ⇒ 30 天后能静默续期。
    assert.equal(new URL(authorizeUrl('K')).searchParams.get('response_type'), 'code');
  });

  it('AppKey 原样进 URL，不做任何猜测性清洗', () => {
    assert.equal(new URL(authorizeUrl('has-dash_and.dot')).searchParams.get('client_id'), 'has-dash_and.dot');
  });
});

describe('checkClient（探测 AppKey，不消耗授权码）', () => {
  it('授权页说 invalid_client → 一句「百度不认识这个 AppKey」', async () => {
    const result = await checkClient('BAD', { fetchImpl: record('<div>invalid_client</div>').fetchImpl });
    assert.equal(result.ok, false);
    assert.match(result.reason, /不认识这个 AppKey/);
  });

  it('授权页正常 → ok（判据是页面里那句「与百度连接」）', async () => {
    const result = await checkClient('KEY', { fetchImpl: record('<h1>与百度连接…</h1>').fetchImpl });
    assert.deepEqual(result, { ok: true });
  });

  it('★ 三类失败各给一句**不同**的话（合并成一句用户没法自救）', async () => {
    const badKey = await checkClient('KEY', { fetchImpl: record('invalid_client').fetchImpl });
    const weird = await checkClient('KEY', { fetchImpl: record('<html>请先登录</html>').fetchImpl });
    const boom = await checkClient('KEY', { fetchImpl: async () => { throw new Error('boom'); } });
    assert.equal(weird.ok, false);
    assert.match(weird.reason, /无法识别/);
    assert.equal(boom.ok, false);
    assert.match(boom.reason, /网络错误/);
    const reasons = new Set([badKey.reason, weird.reason, boom.reason]);
    assert.equal(reasons.size, 3, `三句话必须互不相同：${[...reasons].join(' | ')}`);
  });

  it('探测的是授权页本身 —— 所以可以随便点，不消耗授权码', async () => {
    const { fetchImpl, calls } = record('与百度连接');
    await checkClient('KEY', { fetchImpl });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/oauth\/2\.0\/authorize\?/);
    assert.equal(calls[0].url.includes('/token'), false);
  });
});

describe('两个请求的 User-Agent（★ 故意不同，别顺手统一）', () => {
  it('授权页装浏览器、token 接口装网盘', async () => {
    const calls = [];
    // 两个请求的应答体形态不同（一个是 HTML、一个是 JSON），所以按序切换。
    let answer = '与百度连接';
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => answer };
    };

    await checkClient('KEY', { fetchImpl });
    const pageUa = calls[0].init.headers['User-Agent'];

    answer = JSON.stringify(TOKEN_OK);
    await exchangeCode('CODE', APP, { fetchImpl });
    const tokenUa = calls[1].init.headers['User-Agent'];

    assert.notEqual(pageUa, tokenUa, '两个 UA 变得一样了 —— 这是实测出来的必要条件');
    assert.match(pageUa, /^Mozilla\//);
    assert.equal(tokenUa, 'pan.baidu.com');
  });
});

describe('exchangeCode', () => {
  it('空授权码 → EMPTY_CODE（本地拦掉，不浪费一次请求）', async () => {
    const { fetchImpl, calls } = record(JSON.stringify(TOKEN_OK));
    for (const bad of ['', '   ', undefined, null]) {
      await assert.rejects(() => exchangeCode(bad, APP, { fetchImpl }), (error) => error.code === 'EMPTY_CODE', String(bad));
    }
    assert.deepEqual(calls, [], '空授权码不该发请求');
    // 反向对照：两侧空格是粘贴常态 ⇒ trim 后照常用。
    await exchangeCode('  CODE  ', APP, { fetchImpl });
    assert.equal(new URL(calls[0].url).searchParams.get('code'), 'CODE');
  });

  it('请求形态正确（grant_type / redirect_uri / client_id / client_secret）', async () => {
    const { fetchImpl, calls } = record(JSON.stringify(TOKEN_OK));
    await exchangeCode('CODE', APP, { fetchImpl });
    const url = new URL(calls[0].url);
    assert.equal(`${url.origin}${url.pathname}`, 'https://openapi.baidu.com/oauth/2.0/token');
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(url.searchParams.get('redirect_uri'), 'oob');
    assert.equal(url.searchParams.get('client_id'), APP.appKey);
    assert.equal(url.searchParams.get('client_secret'), APP.secretKey);
  });

  it('★ 百度回 error → TOKEN_REJECTED，并把 error_description 带上（用户要知道是不是码过期了）', async () => {
    const fetchImpl = jsonFetch({ error: 'invalid_grant', error_description: '授权码已过期' });
    await assert.rejects(() => exchangeCode('CODE', APP, { fetchImpl }), (error) => {
      assert.equal(error.code, 'TOKEN_REJECTED');
      assert.match(error.message, /invalid_grant/);
      assert.match(error.message, /授权码已过期/);
      return true;
    });
  });

  it('返回不是 JSON → TOKEN_NOT_JSON，且带上开头一段（排障要看实际回了什么）', async () => {
    await assert.rejects(
      () => exchangeCode('CODE', APP, { fetchImpl: record('<html>风控</html>').fetchImpl }),
      (error) => error.code === 'TOKEN_NOT_JSON' && error.message.includes('<html>'),
    );
  });

  it('网络层抛错 → TOKEN_NETWORK', async () => {
    await assert.rejects(
      () => exchangeCode('CODE', APP, { fetchImpl: async () => { throw new Error('fetch failed'); } }),
      (error) => error.code === 'TOKEN_NETWORK',
    );
  });

  it('成功 → 规范化：提前 10 分钟判过期、scope 与 refresh_token 落进来', async () => {
    const startedAt = Date.now();
    const token = await exchangeCode('CODE', APP, { fetchImpl: jsonFetch(TOKEN_OK) });
    assert.equal(token.access_token, 'AT');
    assert.equal(token.refresh_token, 'RT');
    assert.equal(token.scope, 'basic,netdisk');
    assert.equal(token.appKey, APP.appKey);
    assert.match(token.obtained_at, /^\d{4}-\d{2}-\d{2}T/);
    // 3600s 有效期 − 600s 余量 = 3000s。
    const expected = startedAt + 3_600_000 - 600_000;
    assert.ok(Math.abs(token.expires_at - expected) < 5_000, `expires_at 偏了：${token.expires_at - expected}ms`);
  });

  it('响应没给 expires_in 时按百度默认的 30 天算（而不是立刻判过期）', async () => {
    const token = await exchangeCode('CODE', APP, { fetchImpl: jsonFetch({ access_token: 'AT' }) });
    assert.ok(token.expires_at > Date.now() + 29 * 86_400_000, '缺 expires_in 被当成了 0');
  });
});

describe('refreshToken', () => {
  it('grant_type 与凭证形态正确', async () => {
    const { fetchImpl, calls } = record(JSON.stringify({ access_token: 'NEW', expires_in: 3600 }));
    await refreshToken('OLD-RT', APP, { fetchImpl });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
    assert.equal(url.searchParams.get('refresh_token'), 'OLD-RT');
    assert.equal(url.searchParams.get('client_id'), APP.appKey);
    assert.equal(url.searchParams.get('client_secret'), APP.secretKey);
  });

  it('★ 响应不带新的 refresh_token 时沿用旧的（否则 30 天后就再也续不了）', async () => {
    const kept = await refreshToken('OLD-RT', APP, { fetchImpl: jsonFetch({ access_token: 'NEW', expires_in: 3600 }) });
    assert.equal(kept.refresh_token, 'OLD-RT');
    // 反向对照：响应**带了**就必须换成新的（百度会滚动 refresh_token）。
    const rotated = await refreshToken('OLD-RT', APP, {
      fetchImpl: jsonFetch({ access_token: 'NEW', refresh_token: 'ROTATED', expires_in: 3600 }),
    });
    assert.equal(rotated.refresh_token, 'ROTATED');
  });
});

describe('createPanAuth：凭证路径必填', () => {
  it('★ 两个路径都必须给 —— 不给默认值（默认值会让「写到谁的机器上」变得不确定）', () => {
    assert.throws(() => createPanAuth({ tokenPath: TOKEN_PATH }), /appPath/);
    assert.throws(() => createPanAuth({ appPath: APP_PATH }), /tokenPath/);
    assert.throws(() => createPanAuth({ appPath: '', tokenPath: TOKEN_PATH }), TypeError);
    assert.throws(() => createPanAuth({ appPath: APP_PATH, tokenPath: '' }), TypeError);
    assert.throws(() => createPanAuth(), TypeError);
    // 反向对照：都给齐了就不该抛。
    assert.doesNotThrow(() => createPanAuth({ appPath: APP_PATH, tokenPath: TOKEN_PATH }));
  });
});

describe('saveApp', () => {
  it('形态不对的 AppKey / SecretKey 一律当场拒绝（手抄错一位要在这里拦下）', async () => {
    const auth = authorizer();
    const bad = ['', '   ', 'abc', 'a b c', 'ab@cd.com', 'x'.repeat(65), null, undefined];
    for (const value of bad) {
      await assert.rejects(() => auth.saveApp(value, 'SECRET123456'), (error) => error.code === 'BAD_APP_KEY', String(value));
      await assert.rejects(() => auth.saveApp('KEY123456', value), (error) => error.code === 'BAD_SECRET_KEY', String(value));
    }
    // 反向对照：正好 6 位与正好 64 位都合法（边界不许误杀）。
    await auth.saveApp('A'.repeat(6), 'B'.repeat(64));
    assert.equal(APP_KEY_RE.test('A'.repeat(6)), true);
    assert.equal(APP_KEY_RE.test('A'.repeat(5)), false);
  });

  it('trim 后写盘、按 600 权限、只落 appKey / secretKey 两个字段', async () => {
    const auth = authorizer();
    assert.deepEqual(await auth.saveApp('  KEY123456  ', '  SECRET123456  '), { appKey: 'KEY123456' });
    assert.deepEqual(JSON.parse(await readFile(APP_PATH, 'utf8')), {
      appKey: 'KEY123456',
      secretKey: 'SECRET123456',
    });
    // SecretKey 泄露 = 任何人都能替你换 token ⇒ 文件权限必须是 600。
    assert.equal((await stat(APP_PATH)).mode & 0o777, 0o600);
  });
});

/**
 * `saveToken` 是 0.18.1 新增的：续期结果必须写回文件，而**写入者仍然只有这一个**。
 *
 * 不写回的后果不是「多刷一次 token」，而是：百度每次续期都换发新的 refresh_token、
 * 旧的当场作废 ⇒ 进程一重启手里只剩一个作废的 ⇒ 之后每次续期都报
 * `refresh token has been used`（2026-10-23 实测）。
 */
describe('saveToken（续期结果落盘）', () => {
  it('★ 合并而不是覆盖：未知字段必须透传，appKey / scope 不能被一次续期抹掉', async () => {
    await writeFile(TOKEN_PATH, JSON.stringify({
      appKey: 'APPKEY123456',
      access_token: 'OLD',
      refresh_token: 'OLD-RT',
      expires_at: 1,
      scope: 'basic,netdisk',
      obtained_at: '2026-09-20T02:43:38.571Z',
      // 将来版本才会有的字段 —— 一次续期不许把它弄丢（「有损模型」陷阱）。
      future_field: 'keep-me',
    }));
    const auth = authorizer();
    const merged = await auth.saveToken({
      access_token: 'NEW',
      refresh_token: 'NEW-RT',
      expires_at: 999,
      obtained_at: '2026-10-23T00:00:00.000Z',
    });
    assert.equal(merged.access_token, 'NEW');
    const onDisk = JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
    assert.equal(onDisk.refresh_token, 'NEW-RT');
    assert.equal(onDisk.appKey, 'APPKEY123456');
    assert.equal(onDisk.scope, 'basic,netdisk');
    assert.equal(onDisk.future_field, 'keep-me');
  });

  it('文件不存在时直接写（不要求先授权过），且仍然是 600 权限', async () => {
    const auth = authorizer();
    await auth.saveToken({ access_token: 'A', refresh_token: 'B', expires_at: 1 });
    assert.deepEqual(JSON.parse(await readFile(TOKEN_PATH, 'utf8')), {
      access_token: 'A', refresh_token: 'B', expires_at: 1,
    });
    assert.equal((await stat(TOKEN_PATH)).mode & 0o777, 0o600);
  });
});

describe('status（★ 绝不回传凭证）', () => {
  it('★ 不回传 access_token / refresh_token / SecretKey —— 连字段名都不许有', async () => {
    const auth = authorizer();
    await auth.saveApp('KEY123456', 'SECRET123456');
    await writeFile(TOKEN_PATH, JSON.stringify({
      access_token: 'AT-SECRET',
      refresh_token: 'RT-SECRET',
      expires_at: Date.now() + 3_600_000,
    }));
    const snapshot = await auth.status();
    const text = JSON.stringify(snapshot);
    for (const secret of ['AT-SECRET', 'RT-SECRET', 'SECRET123456']) {
      assert.equal(text.includes(secret), false, `status() 泄露了 ${secret}`);
    }
    // 字段名也查：界面可能照着字段名去读，留着名字等于留着一个随时会被填充的口子。
    for (const key of ['access_token', 'refresh_token', 'secretKey', 'appKey']) {
      assert.equal(Object.hasOwn(snapshot, key), false, `status() 多了字段 ${key}`);
    }
    // 反向对照：AppKey 只给**掩码预览** —— 够确认「配的是哪个应用」，不够拿去用。
    assert.equal(snapshot.appKeyPreview, 'KEY123…3456');
    assert.equal(snapshot.appKeyPreview.includes('123456'), false);
  });

  it('四个状态互斥、各有含义（尤其「有 token 但过期」≠「从来没授权」）', async () => {
    const auth = authorizer();

    // 什么都没配。
    assert.deepEqual(await auth.status(), {
      configured: false,
      appKeyPreview: '',
      authorized: false,
      expired: false,
      hasRefreshToken: false,
      expiresAt: 0,
      authorizeUrl: '',
    });

    // 只配了应用：还没授权，但已经有授权页地址可点。
    await auth.saveApp('KEY123456', 'SECRET123456');
    let status = await auth.status();
    assert.equal(status.configured, true);
    assert.equal(status.authorized, false);
    assert.equal(status.expired, false, '从来没授权过 ≠ 已过期');
    assert.match(status.authorizeUrl, /\/oauth\/2\.0\/authorize\?/);

    // 已授权。
    await writeFile(TOKEN_PATH, JSON.stringify({ access_token: 'AT', expires_at: Date.now() + 3_600_000 }));
    status = await auth.status();
    assert.equal(status.authorized, true);
    assert.equal(status.expired, false);
    assert.ok(status.expiresAt > Date.now());

    // 有过 token、但现在过期了：刷新一下就能用，不是「重新授权」。
    await writeFile(TOKEN_PATH, JSON.stringify({
      access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() - 1000,
    }));
    status = await auth.status();
    assert.equal(status.authorized, false);
    assert.equal(status.expired, true);
    assert.equal(status.hasRefreshToken, true);
    assert.equal(status.expiresAt > 0, true, '过期的 token 也要报出原来的到期时间（供界面显示）');
  });

  it('凭证文件是坏 JSON → BAD_CREDENTIAL_FILE（不静默当成「没配」）', async () => {
    await writeFile(APP_PATH, '{ 这不是 json');
    await assert.rejects(() => authorizer().status(), (error) => error.code === 'BAD_CREDENTIAL_FILE');
  });
});

describe('verifyApp / authorizeUrl() / completeAuthorization / logout', () => {
  it('没填 AppKey 时三者都抛 NO_APP（并且不发请求）', async () => {
    const { fetchImpl, calls } = record('与百度连接');
    const auth = authorizer({ fetchImpl });
    await assert.rejects(() => auth.verifyApp(), (error) => error.code === 'NO_APP');
    await assert.rejects(() => auth.authorizeUrl(), (error) => error.code === 'NO_APP');
    await assert.rejects(() => auth.completeAuthorization('CODE'), (error) => error.code === 'NO_APP');
    assert.deepEqual(calls, []);
  });

  it('verifyApp 填了 AppKey 后就去探一次授权页', async () => {
    const auth = authorizer({ fetchImpl: record('与百度连接…').fetchImpl });
    await auth.saveApp('KEY123456', 'SECRET123456');
    assert.deepEqual(await auth.verifyApp(), { ok: true });
  });

  it('authorizeUrl() 给出的是**带当前 AppKey** 的地址', async () => {
    const auth = authorizer();
    await auth.saveApp('KEY123456', 'SECRET123456');
    assert.equal(new URL(await auth.authorizeUrl()).searchParams.get('client_id'), 'KEY123456');
  });

  it('★ completeAuthorization：换到 token 立刻落盘，状态随即变成已授权', async () => {
    const auth = authorizer({ fetchImpl: jsonFetch(TOKEN_OK) });
    await auth.saveApp('KEY123456', 'SECRET123456');
    const status = await auth.completeAuthorization('CODE');
    assert.equal(status.authorized, true);
    assert.equal(status.expired, false);
    const onDisk = JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
    assert.equal(onDisk.access_token, 'AT');
    assert.equal(onDisk.refresh_token, 'RT');
    assert.equal((await stat(TOKEN_PATH)).mode & 0o777, 0o600, 'token 文件权限必须是 600');
  });

  it('★ 换 token 失败时**不落盘**（不许把半截凭证写下去）', async () => {
    const auth = authorizer({
      fetchImpl: jsonFetch({ error: 'invalid_grant', error_description: '授权码已被使用' }),
    });
    await auth.saveApp('KEY123456', 'SECRET123456');
    await assert.rejects(() => auth.completeAuthorization('CODE'), (error) => error.code === 'TOKEN_REJECTED');
    await assert.rejects(() => readFile(TOKEN_PATH, 'utf8'), (error) => error.code === 'ENOENT', '失败却写了 token 文件');
  });

  it('★ logout 删 token 但**保留 AppKey** —— 换一次授权码就能再用，不必重抄 32 位', async () => {
    const auth = authorizer({ fetchImpl: jsonFetch(TOKEN_OK) });
    await auth.saveApp('KEY123456', 'SECRET123456');
    await auth.completeAuthorization('CODE');

    const after = await auth.logout();
    assert.equal(after.configured, true, 'AppKey 必须留着');
    assert.equal(after.authorized, false);
    assert.equal(after.hasRefreshToken, false);
    assert.equal(after.expired, false, '解除授权之后是「没授权」，不是「过期」');
    // 反向对照：授权页地址还在 ⇒ 用户能直接再去点一次。
    assert.match(after.authorizeUrl, /\/authorize\?/);
    // 再走一次授权就恢复，期间不需要重新填 AppKey。
    const again = await auth.completeAuthorization('CODE2');
    assert.equal(again.authorized, true);
  });

  it('logout 在本来就没有 token 时不抛错', async () => {
    const auth = authorizer();
    await auth.saveApp('KEY123456', 'SECRET123456');
    assert.equal((await auth.logout()).authorized, false);
  });
});
