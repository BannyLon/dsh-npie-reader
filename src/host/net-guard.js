/**
 * 外抓地址守卫（SSRF）。
 *
 * 为什么需要它：`hydrateBody` 会去抓 `entry.url`，而这个 URL 是 **feed 内容给的** ——
 * 第三方可控。一个恶意 feed 只要把条目的 `<link>` 写成 `http://127.0.0.1:<端口>/…`，
 * 插件就会替它去读本机服务，把结果当正文存进库、再灌进译文/解读链路。
 * 而插件自己的 loopback 路由（`/books`、`/api/...`）信任「来自回环 socket 的请求」
 * （见 `trust.js`）—— 也就是说这一跳恰好绕过了那道栅栏。
 *
 * ★ 只管**外部输入来的** URL。用户在设置里手填的订阅地址、转 RSS 服务基地址**不设限**：
 *   wewe-rss 这类服务本来就常跑在 `localhost:4000`，拦了等于把正当用法打死。
 *   所以守卫只接在 `fetchPage`（抓原文页）上，不接 `fetchText`（抓 feed）。
 *
 * ★ 三条判据，缺一条都漏：
 *   ① 协议只收 http/https（`file:` / `data:` 之类直接拒）；
 *   ② 主机名本身已经是本机/内网（`localhost`、`*.local`、裸 IP）⇒ 不用查 DNS 就拒；
 *   ③ 域名必须查 DNS，**任一**解析结果落在私网段就拒 —— 只查第一条会被
 *      「公网 A 记录 + 私网 A 记录」混合的域名绕过。
 *
 * ★ 唯一的例外是**代理的 fake-ip 段**（`198.18/15`）：开了 TUN 的代理对任何域名
 *   都回一个这个段的占位地址，它不是「指向内网」而是「这台机器有代理」。
 *   见 `isProxyFakeAddress` —— 不放行的话，一次都抓不出去（0.90.1 的现场）。
 *
 * ★ 解析失败一律**拒绝**（fail-closed）：宁可「这次读不到原文」，也不要在解析器
 *   被投毒/劫持时放行。调用方（`hydrateBody`）本来就把任何失败退化成 null。
 *
 * ★ 残余风险（写在明面上，不假装没有）：DNS 解析与实际连接之间仍有 TOCTOU 窗口
 *   （解析时是公网、连接时变成 127.0.0.1）。要彻底关掉得自己建 socket 连解析出的 IP，
 *   Node 的 `fetch` 做不到。重定向那一半已经堵住了（逐跳校验，见 `service.js` 的
 *   `fetchPage`），剩下的窗口需要攻击者同时控制 DNS 的 TTL 与响应时序，成本高得多。
 */

import { lookup } from 'node:dns/promises';

/**
 * IPv4 是否属于「不该让外部输入指过来」的段。
 *
 * 除了 RFC1918，还收了这些容易被忽略的：
 *   - `127/8` 回环（不止 127.0.0.1，`127.0.0.2` 一样能打到本机）；
 *   - `169.254/16` 链路本地 —— **云元数据地址 `169.254.169.254` 就在这一段**，
 *     拿到它等于拿到实例凭证，是 SSRF 最经典的靶子；
 *   - `100.64/10` 运营商级 NAT（RFC6598）：企业内网常用，且能路由到别人家；
 *   - `0/8`「本网络」：Linux 上 `0.0.0.0` 会连到本机；
 *   - `198.18/15` benchmark、三段 TEST-NET、`192.0.0/24`：都是保留段；
 *   - `224/4` 组播与 `240/4` 保留（含 `255.255.255.255` 广播）。
 *
 * @param {string} address - 形如 `10.1.2.3`。
 * @returns {boolean} 是否属于私网/保留段（非法写法一律 false，交给调用方按「不是 IP」处理）。
 */
export function isPrivateIPv4(address) {
  const parts = String(address ?? '').trim().split('.');
  if (parts.length !== 4) return false;
  const n = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (n.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = n;
  if (a === 0) return true;                                   // 0/8 本网络
  if (a === 10) return true;                                  // 10/8
  if (a === 127) return true;                                 // 127/8 回环
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true;                    // 169.254/16 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24、TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true;         // 6to4 中继任播
  if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true;        // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;         // TEST-NET-3
  if (a >= 224) return true;                                  // 组播 224/4 + 保留 240/4 + 广播
  return false;
}

/**
 * 把 IPv6 文本解析成 8 个 16 位整数。解析不了返回 null。
 *
 * ★ 为什么要自己解析而不是拿字符串前缀比：`::ffff:127.0.0.1`（IPv4-mapped）、
 *   `fe80::1%en0`（带 zone）、`2001:0db8::`（前导零）这些写法光看前缀判不出来，
 *   而它们全都是能真正连到内网的形态。解析成整数段之后，判定就只剩位运算。
 */
function parseIPv6(raw) {
  let text = String(raw ?? '').trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (text.includes('%')) text = text.split('%')[0];
  if (!text.includes(':')) return null;

  // 内嵌 IPv4（`::ffff:1.2.3.4`）：先换成两个 hextet，后面就只剩十六进制段。
  const tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const octets = [tail[2], tail[3], tail[4], tail[5]].map(Number);
    if (octets.some((value) => value > 255)) return null;
    text = `${tail[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    head.push(...Array(missing).fill('0'));
  }
  const merged = [...head, ...rest];
  if (merged.length !== 8) return null;
  const out = [];
  for (const part of merged) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out.push(Number.parseInt(part, 16));
  }
  return out;
}

/**
 * IPv6 是否属于私网/保留段（含 IPv4-mapped 递归到 IPv4 判据）。
 *
 * @param {string} address - 可带方括号与 zone id。
 * @returns {boolean}
 */
export function isPrivateIPv6(address) {
  const h = parseIPv6(address);
  if (h === null) return false;
  const zero = (from, to) => h.slice(from, to).every((value) => value === 0);
  // `::` 未指定 与 `::1` 回环
  if (zero(0, 7) && (h[7] === 0 || h[7] === 1)) return true;
  // `::ffff:a.b.c.d` IPv4-mapped：段 0–4 为 0、段 5 为 0xffff
  if (zero(0, 5) && h[5] === 0xffff) {
    return isPrivateIPv4(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
  }
  // `::a.b.c.d` IPv4-compatible（已废弃，但老实现仍会连过去）
  if (zero(0, 6) && (h[6] !== 0 || h[7] !== 0)) {
    return isPrivateIPv4(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
  }
  if ((h[0] & 0xffc0) === 0xfe80) return true;  // fe80::/10 链路本地
  if ((h[0] & 0xfe00) === 0xfc00) return true;  // fc00::/7 唯一本地地址
  if ((h[0] & 0xff00) === 0xff00) return true;  // ff00::/8 组播
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // 2001:db8::/32 文档段
  if (h[0] === 0x0064 && h[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  return false;
}

/** 任何形态的 IP 地址是否私网/保留。不是合法 IP 时返回 false。 */
export function isPrivateAddress(address) {
  const text = String(address ?? '').trim();
  if (text === '') return false;
  return text.includes(':') ? isPrivateIPv6(text) : isPrivateIPv4(text);
}

/**
 * 这个地址是不是**代理客户端给的虚拟 IP**（fake-ip）。
 *
 * 症状现场（用户 2026-11-22，0.90.0）：论文的导入与搜索**全部**失败，错误是
 * 「域名解析到内网地址（export.arxiv.org → 198.18.0.49）」—— 而同一个地址
 * 用 `curl` 是通的。原因是他的代理开了 TUN / 虚拟 IP 模式：系统解析器对**任何**
 * 域名都回一个 `198.18.x.x` 占位地址，真正的解析与连接由代理按**域名**完成。
 *
 * 于是「解析到 198.18/15」不是「指向内网」，而是「这台机器上有个代理」。
 * 把它当内网拦下来的后果不是「挡了一次可疑请求」，而是**所有外抓都不通**，
 * 而这条守卫的初衷（挡住恶意 feed 指向 `127.0.0.1` / `192.168.x` / 云元数据）
 * 一点都不需要这个段：`198.18/15`（RFC 2544 基准测试段）既不是 RFC1918，
 * 也不是链路本地，正常内网服务不会坐在那里。
 *
 * ★ 只放行**解析结果**，不放行**裸 IP**：`http://198.18.0.5/` 这种手写地址照旧
 *   在 `isPrivateHostname` 那一步被拒 —— 没有人会「正常地」访问一个基准测试段。
 * ★ 同一批解析结果里只要还有一个真的私网地址（`127.0.0.1` / `10.x` …），
 *   仍然整条拒绝：那才是「DNS 被投毒指到本机」的形态。
 * ★ IPv6 不猜：代理的 fake-ip v6 池（`fc00::/18`）与 ULA 重叠，认不准就不动。
 *
 * @param {string} address
 * @returns {boolean}
 */
export function isProxyFakeAddress(address) {
  const parts = String(address ?? '').trim().split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const nums = parts.map(Number);
  if (!nums.every((num) => num <= 255)) return false;
  const [first, second] = nums;
  return first === 198 && (second === 18 || second === 19);
}

/**
 * 主机名是否**不用查 DNS** 就能判定指向本机/内网。
 *
 * ★ `*.local`（mDNS）与 `*.internal`（云厂商内部域名）也拦：它们在企业网/云上
 *   普遍解析到内网地址，而这类名字经常出现在「开发者自己的机器」上 ——
 *   正常订阅源不会用它们。
 */
export function isPrivateHostname(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  return isPrivateAddress(host);
}

/** 默认解析器：走系统解析（含 `/etc/hosts`），拿全部 A/AAAA 记录。 */
const defaultResolve = async (host) => lookup(host, { all: true, verbatim: true });

/**
 * 这个 URL 能不能让插件去抓。
 *
 * @param {string} rawUrl - 待检查的地址。
 * @param {{ resolve?: (host: string) => Promise<Array<{ address: string }|string>>,
 *           allowProtocols?: string[] }} [options]
 *   `resolve` 可注入（单测用假解析器，不碰真 DNS）。
 * @returns {Promise<{ ok: boolean, reason?: string, url?: URL }>}
 */
export async function checkPublicUrl(rawUrl, options = {}) {
  const { resolve = defaultResolve, allowProtocols = ['http:', 'https:'] } = options;
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: '不是合法的 URL' };
  }
  if (!allowProtocols.includes(url.protocol)) {
    return { ok: false, reason: `协议 ${url.protocol} 不允许（只收 http/https）` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHostname(host)) {
    return { ok: false, reason: `指向本机或内网地址（${host}）` };
  }
  let records;
  try {
    records = await resolve(host);
  } catch {
    return { ok: false, reason: `解析不了主机名（${host}）` };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: `主机名没有解析结果（${host}）` };
  }
  for (const record of records) {
    const address = typeof record === 'string' ? record : record?.address;
    if (typeof address !== 'string' || address === '') {
      return { ok: false, reason: `解析结果不可用（${host}）` };
    }
    if (isPrivateAddress(address)) {
      /**
       * 代理的 fake-ip（`198.18/15`）不算「指向内网」，见 `isProxyFakeAddress`
       * 上面那段：它是「这台机器装了代理」的指纹，把它拦掉等于让插件一条外抓
       * 都发不出去。
       */
      if (isProxyFakeAddress(address)) continue;
      return { ok: false, reason: `域名解析到内网地址（${host} → ${address}）` };
    }
  }
  return { ok: true, url };
}
