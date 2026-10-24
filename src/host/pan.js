/**
 * 百度网盘取字节 —— 网盘书源的唯一数据源。
 *
 * 凭证**由本插件自己管**，位置在插件数据目录（`store.js` 的 `panAppPath()` /
 * `panTokenPath()`），授权流程见 `pan-auth.js`。0.7.1 之前这里读的是用户主目录下
 * 那对机器级凭证（`~/.baidu-pan-*`），由另一个项目生成 —— 后果是「别人装了插件
 * 之后去哪拿凭证」没有答案。现在设置页里有向导，走完就有。
 *
 * 三件事：
 *   1. 取字节走 `filemetas` 拿 dlink，再对 dlink 发 `Range` 请求。
 *   2. 上层（pdf.js）只发它真正需要的那几段，所以这里按 **1 MiB 对齐的块**取数并缓存，
 *      把「几十个小 Range 请求」压成「几次大请求」。实测一本 14 MB 的书打开一轮
 *      只需要几 MB 流量，而不是整本 47 GB。
 *   3. `listDir` 给「扫描生成书单」用（`book-source.js`）。
 *   4. 取到的块**落盘**（`cacheDir`，0.8.6）：内存 LRU 重启就清零，没有磁盘缓存的话
 *      每次打开 dsh 都要把同一本书重新向网盘要一遍 —— 2026-10-09 用户实测撞上。
 *      磁盘缓存按「fsId/块号」一文件一块，跨进程生效；上限由 `cacheMaxBytes` 兜底。
 *
 * ★ 续期出来的新 token **必须写回凭证文件**，但写入者仍然只有一个：这里把新值交给
 *   `pan-auth.js` 的 `saveToken`，**自己不碰那个文件**（两个写入者会互相覆盖）。
 *   为什么非写不可：百度每次续期都会**换发**新的 refresh_token、旧的当场作废 ——
 *   只留内存的话，进程一重启手里就只剩一个作废的 refresh_token，之后每次续期都报
 *   `refresh token has been used`，用户被迫每 30 天手动重新授权一次，而这正是
 *   refresh_token 本该免掉的事。0.18.0 及以前就是这样，2026-10-23 实测踩中。
 *   不传 `saveToken` 时退回「只留内存」（单元测试用），生产调用方必须传。
 *   块缓存相反：它**没有第二写入者**，磁盘由这里独家读写。
 *
 * ★ 两条踩过的坑，代码里各有一处对应实现，改之前先读注释：
 *   - 网盘会在响应结束后**静默丢弃** keep-alive 连接，而 undici 会继续复用这条死连接
 *     ⇒ 下一次 fetch 立刻 `fetch failed`。这是瞬时的，退避重试能救回来（`fetchFromPan`）。
 *   - dlink 自带有效期，但连续 Range 请求后会**偶发 403** ⇒ 403 不等于「这本书读不了」，
 *     要丢掉直链重取一次再试（`fetchFromPan` + `dlinkOf`）。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 网盘接口对 User-Agent 敏感：必须伪装成网盘自身，否则会被拒。 */
export const PAN_UA = 'pan.baidu.com';

const PAN_BASE = 'https://pan.baidu.com';
const OAUTH_BASE = 'https://openapi.baidu.com/oauth/2.0';

/** 块大小：1 MiB。太小 ⇒ 请求数暴涨；太大 ⇒ 单次读一页也要等一整块。 */
export const DEFAULT_BLOCK_BYTES = 1 << 20;

/** 块缓存上限（块数）。64 块 ≈ 64 MB，够装下「当前这本 + 刚翻过的一本」。 */
export const DEFAULT_MAX_BLOCKS = 64;

/** 单次 `readRange` 最多允许铺开多少块 —— 防上层一个手滑请求把整本拖下来。 */
const MAX_BLOCKS_PER_READ = 32;

/** 磁盘块缓存默认上限。1 GiB ≈ 几十本普通电子书；超了按「整本书目录」最旧先删。 */
export const DEFAULT_CACHE_MAX_BYTES = 1 << 30;

/** 同一块并发取数的上限。网盘对并发不友好，给 4 就够把延迟藏起来。 */
const FETCH_CONCURRENCY = 4;

/** dlink 缓存时长：网盘给的有效期是 8 小时，这里保守取 6 小时。 */
const DLINK_TTL_MS = 6 * 3600e3;

/** 提前 10 分钟判过期，避免刚好在边界上失效（与用户已有那份实现同源）。 */
const EXPIRY_MARGIN_MS = 600_000;

const FETCH_TIMEOUT_MS = 60_000;
const META_TIMEOUT_MS = 20_000;

/*
 * ★ 这里**不再有** `defaultTokenPath()` / `defaultAppPath()`。
 *
 * 它们以前回落到 `~/.baidu-pan-{token,app}.json` —— 那是**另一个项目**（ebook-sorter）
 * 写出来的机器级凭证。留着这个默认值的坏处不是「多一个便利」，而是：任何忘了传
 * `tokenPath` 的调用方都会**静默**走上「读别人项目的凭证」这条旧路，而那正是 0.7.2
 * 要消掉的东西（「别人装了插件去哪拿凭证」没有答案）。所以改成**必填**：
 * 忘了传就在构造时直接抛错，而不是在用户点开一本书的时候才发现读的是谁的文件。
 */

/** 把错误里真正有用的那层挖出来（Node 的 fetch 失败只给一句 "fetch failed"）。 */
export function explainFetchError(error) {
  const cause = error?.cause;
  if (cause) return `${error.message} ← ${cause.code || cause.message || String(cause)}`;
  return error?.message || String(error);
}

/** 带 code 的错误，便于上层按类别给用户不同的话。 */
function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw coded('BAD_CREDENTIAL_FILE', `读取 ${path} 失败：${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 列目录 / 取直链时网盘常见 errno 的人话解释。
 *
 * 只列**确认过**的几个：认不出来的 errno 一律只报数字，不猜 —— 猜错的解释会把用户
 * 引到完全错误的方向（比如把「应用没有网盘权限」说成「目录不存在」，他会去反复改路径）。
 */
const ERRNO_HINT = {
  '-6': '（access_token 无效或已过期，请重新授权）',
  '-7': '（这个网盘路径不存在）',
  '-9': '（这个网盘路径不存在）',
  '2': '（参数不合法：网盘路径要以 / 开头）',
};

/**
 * 造一个网盘读取器。
 *
 * 全部外部依赖都从参数进来（fetch / now / 凭证路径 / 日志），所以测试里可以喂假
 * fetch 与假时钟，**不需要联网**也不需要碰真实凭证文件。
 *
 * @param options.fetchImpl - fetch 实现，默认全局 fetch。
 * @param options.tokenPath - access_token / refresh_token 所在文件（**这里只读**；
 *   写由 `options.saveToken` 转交 `pan-auth.js`，见文件顶部说明）。
 * @param options.appPath - AppKey / SecretKey 所在文件（只在需要刷新时读）。
 * @param options.saveToken - 可选，`async (token) => void`，把续期结果写回凭证文件。
 *   生产调用方**必须**传（`service.js` 传的是 `panAuth.saveToken`）；不传则只留内存。
 * @param options.blockBytes - 对齐块大小。
 * @param options.maxBlocks - 块缓存上限。
 * @param options.cacheDir - 磁盘块缓存目录。**不传 = 不落盘**（保持旧行为，测试用）。
 * @param options.cacheMaxBytes - 磁盘缓存总字节上限。
 * @param options.now - 取当前时间的函数（测试用假时钟）。
 * @param options.log - 记一行日志。
 * @returns 读取器。
 */
export function createPanReader(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tokenPath = options.tokenPath;
  const appPath = options.appPath;
  const saveToken = options.saveToken;
  const blockBytes = options.blockBytes ?? DEFAULT_BLOCK_BYTES;
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const cacheDir = options.cacheDir;
  const cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  if (typeof fetchImpl !== 'function') throw new TypeError('pan: fetchImpl 必须是函数');
  if (!Number.isInteger(blockBytes) || blockBytes <= 0) throw new TypeError('pan: blockBytes 必须是正整数');
  if (!Number.isInteger(maxBlocks) || maxBlocks <= 0) throw new TypeError('pan: maxBlocks 必须是正整数');
  if (cacheDir !== undefined && (typeof cacheDir !== 'string' || cacheDir === '')) throw new TypeError('pan: cacheDir 要么不传，要么是非空字符串路径');
  if (!Number.isInteger(cacheMaxBytes) || cacheMaxBytes <= 0) throw new TypeError('pan: cacheMaxBytes 必须是正整数');
  if (saveToken !== undefined && typeof saveToken !== 'function') throw new TypeError('pan: saveToken 要么不传，要么是函数');
  // 放最后：前面几条是「参数写错了」，「没给凭证路径」是「接线漏了」——
  // 两者混在一起报时，先报前者能让人一次看清自己传了什么。
  if (typeof tokenPath !== 'string' || tokenPath === '') throw new TypeError('pan: 需要 tokenPath（凭证路径必填，不提供默认值 —— 见本文件顶部说明）');
  if (typeof appPath !== 'string' || appPath === '') throw new TypeError('pan: 需要 appPath（凭证路径必填，不提供默认值 —— 见本文件顶部说明）');

  /** 进程内的 token 覆盖：刷新结果**只留在这里**，不回写磁盘。 */
  let tokenOverride = null;
  /** fsId -> { dlink, at } */
  const dlinkCache = new Map();
  /** `${fsId}:${index}` -> Buffer（Map 的插入顺序就是 LRU 顺序） */
  const blockCache = new Map();
  /** `${fsId}:${index}` -> Promise<Buffer>，同一个块并发只取一次 */
  const inflight = new Map();
  const counters = { meta: 0, fetch: 0, retries: 0, blocksServed: 0, blocksFetched: 0, list: 0, diskHits: 0, diskWrites: 0, diskEvictions: 0 };

  // ── 磁盘块缓存（`cacheDir` 给了才启用）────────────────────────────
  // 布局：`<cacheDir>/<fsId>/<块号>.blk`，一块一文件。选「一文件一块」而不是
  // 「一册一文件 + 索引」：块的到来顺序就是 pdf.js 的随机访问顺序，追加式文件
  // 要自己维护索引、还要处理写一半崩溃的索引损坏；散文件**天然原子**（rename），
  // 缺哪块补哪块，删书 = 删目录。
  let diskReady = false;
  /** 已落盘的字节估计（首次写入前扫一遍目录算出来，之后增量维护）。 */
  let diskBytes = 0;

  async function initDisk() {
    if (diskReady || cacheDir === undefined) return;
    diskReady = true;
    try {
      await mkdir(cacheDir, { recursive: true });
      // 启动盘点：文件数 = 读过的块数（几千个 stat 以内），一次性成本可接受。
      for (const book of await readdir(cacheDir)) {
        const bookDir = join(cacheDir, book);
        for (const file of await readdir(bookDir)) {
          const info = await stat(join(bookDir, file)).catch(() => null);
          if (info?.isFile()) diskBytes += info.size;
        }
      }
      log(`[书架] 网盘块缓存 ${cacheDir}，已有 ${Math.round(diskBytes / 1024)} KB`);
    } catch (error) {
      // 磁盘坏了不能拖累读书：记日志，之后每次写盘的 catch 同样兜着。
      log(`[书架] 网盘块缓存不可用（${error?.message ?? error}），退回纯内存缓存`);
      diskBytes = 0;
    }
  }

  async function readDiskBlock(fsId, index) {
    if (cacheDir === undefined) return null;
    await initDisk();
    try {
      return await readFile(join(cacheDir, String(fsId), `${index}.blk`));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      // 读得出来但损坏等怪状态：删掉当没有，让网盘重给。
      await rm(join(cacheDir, String(fsId), `${index}.blk`), { force: true }).catch(() => {});
      return null;
    }
  }

  async function evictDisk() {
    if (cacheDir === undefined || diskBytes <= cacheMaxBytes) return;
    let books;
    try {
      books = await readdir(cacheDir);
    } catch {
      return;
    }
    // 「最旧」按**书里最新一块**的时间算，不用目录 mtime —— 往旧书里写新块
    // 会把目录 mtime 刷新成最新，按目录排序会删掉刚读的那本（方向反了）。
    const withTime = [];
    for (const book of books) {
      const bookDir = join(cacheDir, book);
      const info = await stat(bookDir).catch(() => null);
      if (!info?.isDirectory()) continue;
      let latest = info.mtimeMs;
      for (const file of await readdir(bookDir).catch(() => [])) {
        const fileInfo = await stat(join(bookDir, file)).catch(() => null);
        if (fileInfo?.isFile() && fileInfo.mtimeMs > latest) latest = fileInfo.mtimeMs;
      }
      withTime.push({ book, bookDir, at: latest });
    }
    withTime.sort((a, b) => a.at - b.at);
    for (const { book, bookDir } of withTime) {
      if (diskBytes <= cacheMaxBytes) break;
      let size = 0;
      for (const file of await readdir(bookDir).catch(() => [])) {
        const info = await stat(join(bookDir, file)).catch(() => null);
        if (info?.isFile()) size += info.size;
      }
      await rm(bookDir, { recursive: true, force: true }).catch(() => {});
      diskBytes -= size;
      counters.diskEvictions += 1;
      log(`[书架] 网盘块缓存超限，整本淘汰 fsId=${book}（约 ${Math.round(size / 1024)} KB）`);
    }
  }

  async function writeDiskBlock(fsId, index, buffer) {
    if (cacheDir === undefined) return;
    await initDisk();
    if (!diskReady) return;
    const bookDir = join(cacheDir, String(fsId));
    const target = join(bookDir, `${index}.blk`);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await mkdir(bookDir, { recursive: true });
      await writeFile(tmp, buffer);
      await rename(tmp, target);
      diskBytes += buffer.length;
      counters.diskWrites += 1;
      await evictDisk();
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      log(`[书架] 块缓存写盘失败（${error?.message ?? error}），不影响本次阅读`);
    }
  }

  /** 续期请求在飞时挂在这里 —— 并发调用共用同一次刷新。 */
  let refreshing = null;

  /**
   * 拿一个可用的 access_token（需要时续期）。
   *
   * ★ 为什么必须**单飞**（并发共用同一个 Promise）：百度续期是一次性的 —— 两个并发
   *   调用各发一次刷新，第一个成功、第二个拿到 `refresh token has been used`，于是
   *   「点开一本书」变成随机失败。而并发是常态：pdf.js 打开一本书会同时要好几段字节，
   *   每一段都要走到这里。
   */
  async function ensureToken() {
    if (tokenOverride && now() < tokenOverride.expires_at) return tokenOverride.access_token;
    if (refreshing !== null) return await refreshing;
    refreshing = refreshOnce();
    try {
      return await refreshing;
    } finally {
      refreshing = null;
    }
  }

  /** 真正发那一次续期请求。只该被 `ensureToken` 调用（它负责单飞与内存覆盖）。 */
  async function refreshOnce() {
    const token = await readJson(tokenPath);
    if (!token || typeof token.access_token !== 'string' || token.access_token === '') {
      throw coded('NO_TOKEN', '还没有百度网盘授权。'
        + '请在插件设置的「电子书书架 → 百度云盘」里走一次授权（填 AppKey / SecretKey → 打开授权页 → 粘贴授权码）。');
    }
    if (now() < Number(token.expires_at ?? 0)) return token.access_token;

    const app = await readJson(appPath);
    if (!app?.appKey || !app?.secretKey) {
      throw coded('NO_APP', 'access_token 已过期，且没有可以续期的 AppKey / SecretKey。'
        + '请在插件设置的「电子书书架 → 百度云盘」里重新填写 AppKey / SecretKey，再走一次授权。');
    }
    if (typeof token.refresh_token !== 'string' || token.refresh_token === '') {
      throw coded('NO_REFRESH', 'access_token 已过期，凭证文件里也没有 refresh_token，请重新授权。');
    }

    const url = new URL(`${OAUTH_BASE}/token`);
    url.searchParams.set('grant_type', 'refresh_token');
    url.searchParams.set('refresh_token', token.refresh_token);
    url.searchParams.set('client_id', app.appKey);
    url.searchParams.set('client_secret', app.secretKey);

    let payload;
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': PAN_UA },
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      payload = await response.json();
    } catch (error) {
      throw coded('REFRESH_FAILED', `刷新网盘 token 失败：${explainFetchError(error)}`);
    }
    if (!payload?.access_token) {
      const detail = payload?.error_description || payload?.error || '返回里没有 access_token';
      // ★ 「用过了」和「30 天到了」是两件完全不同的事，不能给同一句话：
      //   后者用户只能等/重新授权，前者是**插件自己把换发出来的新 refresh_token 丢了**。
      //   混在一起说，用户会以为是正常过期，于是每 30 天手动授权一次还以为是常态。
      if (/has been used|already used|已被使用/i.test(String(detail))) {
        throw coded('REFRESH_CONSUMED',
          '网盘授权已经用完了（refresh token has been used）。百度每次续期都会换发新的 '
          + 'refresh_token、旧的当场作废，而插件以前把新的只放在内存里、没存回文件，'
          + '所以重启之后手里只剩一个作废的。请到插件设置的「电子书书架 → 百度云盘」'
          + '重新授权一次 —— 之后就正常了，续期会自动存回。');
      }
      throw coded('REFRESH_FAILED', `刷新网盘 token 失败：${detail}。refresh_token 有效期通常 30 天，请重新授权。`);
    }

    tokenOverride = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || token.refresh_token,
      expires_at: now() + (Number(payload.expires_in) || 2_592_000) * 1000 - EXPIRY_MARGIN_MS,
    };
    // ★ 写盘失败**不能让这次阅读失败**（内存里的 token 是好的），但必须留日志：
    //   「没写回去」正是下一次重启后报 `refresh token has been used` 的唯一原因，
    //   静默失败等于把这个 bug 藏起来。
    if (typeof saveToken === 'function') {
      try {
        await saveToken({
          access_token: tokenOverride.access_token,
          refresh_token: tokenOverride.refresh_token,
          expires_at: tokenOverride.expires_at,
          obtained_at: new Date(now()).toISOString(),
        });
        log('[书架] 网盘 access_token 已过期，已续期并写回凭证文件');
      } catch (error) {
        log(`[书架] 续期成功但写回凭证文件失败（${error?.message ?? error}）：本次可读，重启后要重新授权`);
      }
    } else {
      log('[书架] 网盘 access_token 已过期，已用 refresh_token 续期（没给 saveToken，只留内存）');
    }
    return tokenOverride.access_token;
  }

  /** 拿这本书的下载直链（带 access_token；不带 token 会回 403 user not exists）。 */
  async function dlinkOf(fsId) {
    const key = String(fsId);
    const hit = dlinkCache.get(key);
    if (hit && now() - hit.at < DLINK_TTL_MS) return hit.dlink;

    const token = await ensureToken();
    const url = new URL(`${PAN_BASE}/rest/2.0/xpan/multimedia`);
    url.searchParams.set('method', 'filemetas');
    url.searchParams.set('access_token', token);
    url.searchParams.set('fsids', JSON.stringify([Number(fsId)]));
    url.searchParams.set('dlink', '1');

    counters.meta += 1;
    let payload;
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': PAN_UA },
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      payload = await response.json();
    } catch (error) {
      throw coded('META_FAILED', `取网盘直链失败：${explainFetchError(error)}`);
    }
    if (payload?.errno !== 0) throw coded('META_ERRNO', `网盘返回 errno=${payload?.errno}（取直链）`);

    const dlink = payload.list?.[0]?.dlink;
    if (typeof dlink !== 'string' || dlink === '') throw coded('NO_DLINK', '网盘没有给这本书的下载直链');
    const full = `${dlink}&access_token=${token}`;
    dlinkCache.set(key, { dlink: full, at: now() });
    return full;
  }

  /**
   * 从网盘取一段字节，失败退避重试 3 次。
   * `start` / `end` 都是**闭区间**的字节下标。
   */
  async function fetchFromPan(fsId, start, end) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const dlink = await dlinkOf(fsId);
        const response = await fetchImpl(dlink, {
          headers: { 'User-Agent': PAN_UA, Range: `bytes=${start}-${end}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status === 401 || response.status === 403) {
          // 直链失效（偶发），丢掉重取；下一次循环会重新走 filemetas。
          dlinkCache.delete(String(fsId));
          lastError = coded('PAN_DENIED', `网盘拒绝（HTTP ${response.status}）`);
        } else if (response.status !== 206 && response.status !== 200) {
          lastError = coded('PAN_HTTP', `网盘返回 HTTP ${response.status}`);
        } else {
          counters.fetch += 1;
          return Buffer.from(await response.arrayBuffer());
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt < 2) {
        counters.retries += 1;
        log(`[书架] 网盘取 ${start}-${end} 第 ${attempt + 1} 次失败（${explainFetchError(lastError)}），退避重试`);
        await sleep(400 * (attempt + 1));
      }
    }
    throw coded('PAN_FETCH_FAILED', `${start}-${end} 取数失败（已重试 3 次）：${explainFetchError(lastError)}`);
  }

  function rememberBlock(key, buffer) {
    blockCache.set(key, buffer);
    while (blockCache.size > maxBlocks) {
      const oldest = blockCache.keys().next().value;
      blockCache.delete(oldest);
    }
  }

  /** 取第 index 块（对齐块）。同一个块并发只发一次网盘请求。
   *  三级查找：内存 LRU → 磁盘块缓存（跨进程）→ 网盘。 */
  async function blockOf(fsId, index) {
    const key = `${fsId}:${index}`;
    const hit = blockCache.get(key);
    if (hit !== undefined) {
      // 触碰一下：Map 的插入顺序就是 LRU 顺序。
      blockCache.delete(key);
      blockCache.set(key, hit);
      counters.blocksServed += 1;
      return hit;
    }
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;

    const start = index * blockBytes;
    const promise = (async () => {
      const cached = await readDiskBlock(fsId, index);
      if (cached !== null && cached.length > 0) {
        // 磁盘命中也回填内存：这本书显然正在读，别让后续翻页再走磁盘 IO。
        rememberBlock(key, cached);
        counters.diskHits += 1;
        return cached;
      }
      const buffer = await fetchFromPan(fsId, start, start + blockBytes - 1);
      // 末块可能短于 blockBytes（网盘只回文件里还剩的那些字节），照存不误：
      // 上层按 offset 切片，短块只影响最后那一块的尾部。
      rememberBlock(key, buffer);
      counters.blocksFetched += 1;
      // 落盘**等它写完**（几 MB 以内、本机 SSD，微秒级），换取测试确定性与
      // 「读到 = 已缓存」的简单语义；写失败在内部吞掉，绝不影响阅读。
      await writeDiskBlock(fsId, index, buffer);
      return buffer;
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  }

  /** 有上限的并发执行（保持结果顺序）。 */
  async function mapLimited(items, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = new Array(Math.min(FETCH_CONCURRENCY, items.length)).fill(null).map(async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }

  /**
   * 读 `[start, end]`（闭区间）这段字节。跨块时按块取再拼。
   *
   * ★ 返回的是**新拼出来的 Buffer**，不是块缓存里的切片 —— 上层（HTTP 路由）会把它
   *   交给 socket，若直接给出缓存里的 subarray，就等于把缓存暴露给外部生命周期。
   */
  async function readRange(fsId, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw coded('BAD_RANGE', `无效的字节区间 ${start}-${end}`);
    }
    const first = Math.floor(start / blockBytes);
    const last = Math.floor(end / blockBytes);
    const count = last - first + 1;
    if (count > MAX_BLOCKS_PER_READ) {
      throw coded('RANGE_TOO_LARGE',
        `一次要读 ${count} 块（${((count * blockBytes) / 1048576).toFixed(1)} MB），超过单次上限 ${MAX_BLOCKS_PER_READ} 块`);
    }
    const indices = Array.from({ length: count }, (_, offset) => first + offset);
    const parts = await mapLimited(indices, (index) => blockOf(fsId, index));
    const joined = Buffer.concat(parts);
    const offset = start - first * blockBytes;
    const length = end - start + 1;
    const slice = joined.subarray(offset, offset + length);
    if (slice.length === 0) throw coded('PAN_EOF', `网盘在 ${start} 处已经没有数据了`);
    return Buffer.from(slice);
  }

  /**
   * 列一个网盘目录（**只这一层**，含子目录条目）。给「浏览网盘目录」和
   * 「扫描生成书单」（`book-source.js`）用。
   *
   * ★ 2026-10-09 实测：xpan list 的 `recursion=1` 在本应用的凭证下**并不递归**
   *   （带不带 `web`/`order` 都只回顶层 —— `/E书拾取` 顶层 8 个全是目录，一个
   *   文件都没给，而子目录里明明有书）。所以递归改由 `scanPanRoots` 自己做
   *   BFS，这里只老实回单层。单层目录一页一般拿得满，翻页只当兜底：
   *   一页拿满就再翻一页，直到拿不满或到页数上限。
   *   宁可少扫到几本（界面上会如实报扫到多少），也不要在这儿挂住不动。
   *
   * @param dir - 网盘绝对路径（以 `/` 开头）。
   * @returns `[{ name, path, fsId, size, isDir }]`。
   */
  async function listDir(dir, options = {}) {
    const pageSize = options.pageSize ?? 1000;
    const maxPages = options.maxPages ?? 30;
    const token = await ensureToken();
    const out = [];
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(`${PAN_BASE}/rest/2.0/xpan/file`);
      url.searchParams.set('method', 'list');
      url.searchParams.set('access_token', token);
      url.searchParams.set('dir', String(dir));
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('start', String(page * pageSize));
      url.searchParams.set('web', '1');
      url.searchParams.set('order', 'name');

      counters.list += 1;
      let payload;
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': PAN_UA },
          signal: AbortSignal.timeout(META_TIMEOUT_MS),
        });
        payload = await response.json();
      } catch (error) {
        throw coded('LIST_FAILED', `列网盘目录失败：${explainFetchError(error)}`);
      }
      if (payload?.errno !== 0) {
        const hint = ERRNO_HINT[String(payload?.errno)] ?? '';
        throw coded('LIST_ERRNO', `网盘返回 errno=${payload?.errno}（列目录 ${dir}）${hint}`);
      }
      const rows = Array.isArray(payload.list) ? payload.list : [];
      for (const row of rows) {
        out.push({
          name: String(row.server_filename ?? ''),
          path: String(row.path ?? ''),
          fsId: Number(row.fs_id),
          size: Number(row.size) || 0,
          isDir: row.isdir === 1 || row.isdir === '1',
        });
      }
      if (rows.length < pageSize) return out;
    }
    log(`[书架] 列目录 ${dir} 到页数上限（${maxPages} 页），已取 ${out.length} 条`);
    return out;
  }

  return {
    ensureToken,
    dlinkOf,
    readRange,
    listDir,
    stats: () => ({
      ...counters,
      dlinkEntries: dlinkCache.size,
      blockEntries: blockCache.size,
      blockBytes,
      diskCache: cacheDir ?? null,
      diskBytes,
    }),
    /** 测试与「重试」按钮用：丢掉所有**内存**缓存（凭证缓存也丢）。
     *  磁盘块缓存是持久数据（和 data.json 同级），clear 不动它 ——
     *  丢缓存是为了「重新走一遍网络路径」，不是为了删数据。 */
    clear: () => { dlinkCache.clear(); blockCache.clear(); inflight.clear(); tokenOverride = null; },
  };
}
