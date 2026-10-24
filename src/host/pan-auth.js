/**
 * 百度网盘开放平台授权：应用凭证（AppKey / SecretKey）+ 授权码换 token。
 *
 * 为什么这件事必须落在插件里：以前凭证由**另一个项目**（ebook-sorter 的
 * `tools/pan/auth.mjs`）生成到 `~/.baidu-pan-*.json`，于是「别人装了插件之后怎么拿到
 * 书源」这件事根本没有答案 —— 他既不知道要先跑那个项目，也拿不到那份文件。
 * 现在设置页里有向导，走完就有凭证。
 *
 * ★ 一条替不了任何人的前提：百度网盘开放平台**没有「零申请」的调用方式**。用户必须
 *   自己注册应用（实名认证 → 创建应用 → 拿 AppKey / SecretKey → 回调地址填 oob）。
 *   所以界面上必须把这段准备说明**完整地**写出来，否则向导第一步就是个死胡同。
 *
 * 协议与参数**逐字照抄**那份已经跑通的实现（`tools/pan/auth.mjs`）：
 *   - 授权页 `redirect_uri=oob` ⇒ 授权码直接显示在页面上，用户复制粘贴回来，
 *     不需要我们起一个回调端口（插件挂在宿主里，起端口是另一件麻烦事）。
 *   - 授权码模式（而非简化模式）才能拿到 `refresh_token`，30 天后能静默续期。
 *   - 两个请求的 `User-Agent` 不一样（授权页自检要装浏览器，token 接口要装网盘），
 *     这是实测出来的，别顺手统一。
 *
 * ★ 凭证文件按 600 权限写、不进设置文件、也**绝不打回给浏览器**（见 `status()`：
 *   只回一个掩码后的 AppKey 预览）。设置文件会被界面整体读出来，token 落在那里
 *   等于把网盘全盘读权限摊在设置页上。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const OAUTH_BASE = 'https://openapi.baidu.com/oauth/2.0';

/** 授权页自检要装成浏览器（百度按 UA 决定给不给页面）。 */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
/** token 接口要装成网盘自己。与 `pan.js` 的 `PAN_UA` 同源。 */
const PAN_UA = 'pan.baidu.com';

/** 提前 10 分钟判过期，避免刚好在边界上失效（与已有实现同源）。 */
const EXPIRY_MARGIN_MS = 600_000;
/** 百度默认有效期 30 天；响应没给 `expires_in` 时按它算。 */
const DEFAULT_EXPIRES_IN = 2_592_000;

const TIMEOUT_MS = 20_000;

/** AppKey / SecretKey 的形态：百度给的是一串字母数字。放宽到 64 位以免误杀。 */
const APP_KEY_RE = /^[A-Za-z0-9]{6,64}$/;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function explainFetchError(error) {
  const cause = error?.cause;
  if (cause) return `${error.message} ← ${cause.code || cause.message || String(cause)}`;
  return error?.message || String(error);
}

/** 原子写 + 600 权限。凭证文件一旦被别的进程读到，等于网盘全盘可读。 */
async function writeSecret(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw coded('BAD_CREDENTIAL_FILE', `读取 ${path} 失败：${error.message}`);
  }
}

/**
 * 让用户去浏览器点授权的地址（`redirect_uri=oob` ⇒ 授权码显示在页面上）。
 * 参数与已有实现逐字一致。
 */
export function authorizeUrl(appKey) {
  const url = new URL(`${OAUTH_BASE}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', appKey);
  url.searchParams.set('redirect_uri', 'oob');
  url.searchParams.set('scope', 'basic,netdisk');
  url.searchParams.set('device_id', appKey);
  return url.toString();
}

/**
 * 探测 AppKey 是不是百度认可的 client_id。
 *
 * 为什么要探：用户手抄 32 位 AppKey 极容易错一位，而错的 AppKey 在授权页上表现为
 * 「与百度连接失败」这种看不出所以然的页面 —— 他会以为是网络问题，反复点。这里先
 * 读一次授权页并找 `invalid_client`，能给出「百度不认识这个 AppKey」这句确定的话。
 * 这一步**不消耗授权码**，可以随便点。
 */
export async function checkClient(appKey, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(authorizeUrl(appKey), {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const html = await response.text();
    if (html.includes('invalid_client')) {
      return { ok: false, reason: '百度不认识这个 AppKey（应用不存在、已关闭，或字符抄错了）' };
    }
    if (html.includes('与百度连接')) return { ok: true };
    return { ok: false, reason: '授权页响应无法识别，可能被风控拦截' };
  } catch (error) {
    return { ok: false, reason: `网络错误：${explainFetchError(error)}` };
  }
}

function normalizeToken(json, appKey, previousRefresh = '') {
  const now = Date.now();
  return {
    appKey,
    access_token: json.access_token,
    // 刷新响应可能不带新的 refresh_token ⇒ 沿用旧的（已有实现同此）。
    refresh_token: json.refresh_token || previousRefresh,
    expires_at: now + (Number(json.expires_in) || DEFAULT_EXPIRES_IN) * 1000 - EXPIRY_MARGIN_MS,
    scope: json.scope,
    obtained_at: new Date(now).toISOString(),
  };
}

async function tokenRequest(params, fetchImpl) {
  const url = new URL(`${OAUTH_BASE}/token`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let text;
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': PAN_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw coded('TOKEN_NETWORK', `换取 token 失败：${explainFetchError(error)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw coded('TOKEN_NOT_JSON', `换取 token 失败（返回不是 JSON）：${text.slice(0, 200)}`);
  }
  if (json.error) {
    throw coded('TOKEN_REJECTED', `换取 token 失败：${json.error} - ${json.error_description ?? ''}`);
  }
  return json;
}

/**
 * 用授权码换 token。
 * @throws code=`TOKEN_REJECTED`（授权码错/过期/已被用过）等。
 */
export async function exchangeCode(code, app, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const trimmed = String(code ?? '').trim();
  if (trimmed === '') throw coded('EMPTY_CODE', '授权码是空的 —— 把授权页上那串字符完整复制过来');
  const json = await tokenRequest({
    grant_type: 'authorization_code',
    code: trimmed,
    client_id: app.appKey,
    client_secret: app.secretKey,
    redirect_uri: 'oob',
  }, fetchImpl);
  return normalizeToken(json, app.appKey);
}

/** 用 refresh_token 续期。 */
export async function refreshToken(refresh, app, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const json = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: app.appKey,
    client_secret: app.secretKey,
  }, fetchImpl);
  return normalizeToken(json, app.appKey, refresh);
}

/**
 * 造一个授权器（凭证读写 + 换 token）。
 *
 * 全部外部依赖（fetch、凭证路径、时钟）都从参数进来，所以测试里可以喂假 fetch 与
 * 临时目录，**不需要联网、也不碰真凭证**。
 *
 * @param options.appPath - AppKey / SecretKey 文件（插件数据目录）。
 * @param options.tokenPath - token 文件（插件数据目录）。
 * @param options.fetchImpl - fetch 实现。
 * @param options.now - 取当前时间（测试用假时钟）。
 * @param options.log - 记一行日志。
 */
export function createPanAuth(options = {}) {
  const appPath = options.appPath;
  const tokenPath = options.tokenPath;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  if (typeof appPath !== 'string' || appPath === '') throw new TypeError('pan-auth: 需要 appPath');
  if (typeof tokenPath !== 'string' || tokenPath === '') throw new TypeError('pan-auth: 需要 tokenPath');

  const loadApp = async () => await readJsonOrNull(appPath);
  const loadToken = async () => await readJsonOrNull(tokenPath);

  /** 存 AppKey / SecretKey。两者都要过形态校验 —— 手抄错一位在这里就得拦下来。 */
  async function saveApp(appKey, secretKey) {
    const key = String(appKey ?? '').trim();
    const secret = String(secretKey ?? '').trim();
    if (!APP_KEY_RE.test(key)) throw coded('BAD_APP_KEY', 'AppKey 形态不对（应为 6–64 位字母数字，注意别把空格带进来）');
    if (!APP_KEY_RE.test(secret)) throw coded('BAD_SECRET_KEY', 'SecretKey 形态不对（应为 6–64 位字母数字，注意别把空格带进来）');
    await writeSecret(appPath, { appKey: key, secretKey: secret });
    log('[书架] 网盘应用凭证已保存');
    return { appKey: key };
  }

  /**
   * 当前授权状态。**绝不回传 access_token / refresh_token / secretKey** ——
   * 它会被设置页整个读出来并渲染。只回一个 AppKey 预览，够用户确认「配的是哪个应用」。
   */
  async function status() {
    const app = await loadApp();
    const token = await loadToken();
    const configured = Boolean(app?.appKey && app?.secretKey);
    const expiresAt = Number(token?.expires_at ?? 0);
    const authorized = typeof token?.access_token === 'string' && token.access_token !== '' && now() < expiresAt;
    return {
      configured,
      appKeyPreview: configured ? `${String(app.appKey).slice(0, 6)}…${String(app.appKey).slice(-4)}` : '',
      authorized,
      // 「有 token 但已过期」与「从来没授权」是两件事：前者刷新一下就能用，后者要重新点授权。
      expired: Boolean(token?.access_token) && !authorized,
      hasRefreshToken: typeof token?.refresh_token === 'string' && token.refresh_token !== '',
      expiresAt: expiresAt > 0 ? expiresAt : 0,
      authorizeUrl: configured ? authorizeUrl(String(app.appKey)) : '',
    };
  }

  /** 自检 AppKey（不消耗授权码）。 */
  async function verifyApp() {
    const app = await loadApp();
    if (!app?.appKey) throw coded('NO_APP', '还没有填 AppKey / SecretKey');
    return await checkClient(String(app.appKey), { fetchImpl });
  }

  /** 用授权码换 token 并落盘。 */
  async function completeAuthorization(code) {
    const app = await loadApp();
    if (!app?.appKey || !app?.secretKey) throw coded('NO_APP', '还没有填 AppKey / SecretKey');
    const token = await exchangeCode(code, app, { fetchImpl });
    await writeSecret(tokenPath, token);
    log('[书架] 网盘授权完成');
    return await status();
  }

  /**
   * 把续期结果写回凭证文件。**本文件是 token 的唯一写入者** —— `pan.js` 只调这里，
   * 自己绝不碰这个文件（两个写入者会互相覆盖，这条边界不能松）。
   *
   * ★ 为什么要合并旧内容：`pan.js` 只送来四个字段（access / refresh / expires_at /
   *   obtained_at），直接覆盖会把 `appKey` / `scope` 一起抹掉 —— 那是「有损模型」的
   *   经典形态：读进模型、序列化写回，未知字段全丢。这里读旧文件再展开，同名键被
   *   新值覆盖，其余原样透传。
   *
   * ★ 为什么这件事必须存在（0.18.1 修的正是它）：百度每次续期都会**换发**新的
   *   refresh_token，旧的当场作废。以前只把新值留在进程内存里，进程一重启手里就只剩
   *   一个作废的 refresh_token，之后每次续期都报 `refresh token has been used` ——
   *   用户被迫每 30 天手动重新授权一次，而这恰恰是 refresh_token 本该免掉的事。
   *   2026-10-23 实测踩中（凭证文件停在 10-09，access_token 已于 10-20 过期）。
   *
   * @param next - 要合并进去的字段。
   * @returns 合并后真正写下去的对象（调用方可以据此断言，不用再读一遍盘）。
   */
  async function saveToken(next) {
    const previous = (await loadToken()) ?? {};
    const merged = { ...previous, ...next };
    await writeSecret(tokenPath, merged);
    return merged;
  }

  /** 解除授权：删 token，保留 AppKey（用户换一次授权码就能再用，不用重抄 32 位）。 */
  async function logout() {
    await rm(tokenPath, { force: true });
    log('[书架] 网盘授权已解除');
    return await status();
  }

  return {
    appPath,
    tokenPath,
    loadApp,
    loadToken,
    saveApp,
    status,
    verifyApp,
    authorizeUrl: async () => {
      const app = await loadApp();
      if (!app?.appKey) throw coded('NO_APP', '还没有填 AppKey / SecretKey');
      return authorizeUrl(String(app.appKey));
    },
    completeAuthorization,
    saveToken,
    logout,
  };
}

export { APP_KEY_RE, OAUTH_BASE };
