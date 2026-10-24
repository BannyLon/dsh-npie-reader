/**
 * 插件 HTTP 路由的**请求级信任栅栏**。
 *
 * 为什么必须有：宿主对插件路由的派发是「先精确路由、再走鉴权拦截器」—— 也就是说
 * 命中插件路由的请求**不会**经过宿主自己的 token 鉴权。所以每条插件路由的安全
 * 完全由它自己负责。
 *
 * ★ 为什么判据是这三条，而不是更省事的「Origin 存在」「Origin == Host」：
 *   恶意网页可以把一个域名解析到 127.0.0.1（DNS rebinding），此时请求打到的确实是
 *   本机服务，但 `Origin` 与 `Host` **都是攻击者的域名**、浏览器视为同源 ⇒
 *   只看这两个相等是**挡不住**的，响应还能被读走。所以：
 *     1. **socket 的对端地址**必须是回环（这条无法伪造）；
 *     2. **Host 头**必须解析成回环主机名（rebinding 时这里是攻击者域名，被挡下）；
 *     3. 显式拒 `sec-fetch-site: cross-site`（浏览器标出来的跨站）。
 *   `X-Forwarded-For` 一律不信。
 *
 * 注：桌面端 renderer 的原点是自定义协议 `dsh-app://app`，它发出的请求由 Electron
 * 主进程转发给宿主，转发时会**删掉** `host` / `origin` / `sec-fetch-site` 再由
 * fetch 自己补上（`Host` 因此是 `127.0.0.1:<port>`），所以这三条对它天然成立。
 */

/** IPv4 127/8 判据（四段十进制，第一段 127）。 */
export function isIPv4Loopback(v4) {
  const parts = String(v4).split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** socket 对端地址是不是回环（127/8、`::1`、IPv4-mapped `::ffff:127/8`）。 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length));
  return isIPv4Loopback(normalized);
}

/** 主机名是不是回环（`localhost`、`[::1]`、127/8）。 */
export function isLoopbackHostname(hostname) {
  const normalized = String(hostname).toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true;
  return isIPv4Loopback(normalized);
}

/**
 * 这条请求是否可信。
 *
 * ★ 返回 `false` 时**不区分是哪一条挡下的**（对调用者而言就是 403）。但测试必须
 *   能证明「只被哪一条挡下」—— 见 `test/library-routes.test.mjs` 里的反向对照：
 *   每个用例都把其余子判据摆成通过状态，只让被测那一条失败。
 *
 * @param req - `node:http` 的 IncomingMessage（或其等价假对象）。
 * @returns 是否可信。
 */
export function isTrustedLocalRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(parsed.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    // ★ 比的是 **authority（host:port）**，不是 origin —— 即**刻意不比较协议**。
    //   理由：`Host` 头本身就是 authority 形态、不带协议，「相等」只在这一维上有定义；
    //   而按协议比会把宿主配了 TLS 的正常请求挡掉（页面 origin 是 `https://…`、
    //   Host 仍是裸 authority），等于把用户自己的界面锁在门外。
    //   真正的攻击面由上面三条挡着（socket 回环 + Host 回环 + 拒 cross-site），
    //   这一条是纵深防御，不是主力。改动前先读 `test/library-trust.test.mjs` 里
    //   那条「故意不比较协议」的用例。
    return new URL(origin).host === parsed.host;
  } catch {
    return false;
  }
}
