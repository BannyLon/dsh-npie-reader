/**
 * 插件 HTTP 路由的**信任栅栏**（`src/host/trust.js`）。
 *
 * ★ 为什么这个文件不能只写「合法请求返回 true」：宿主派发插件路由**不经过**它自己的
 *   鉴权拦截器（先精确路由、再鉴权），所以这四条判据就是「读用户网盘文件」和
 *   「改阅读进度」这两个接口的**全部**防线。一个恒真的 `isTrustedLocalRequest`
 *   会让所有「合法请求」用例照样全绿。
 *
 * ⇒ 本文件的纪律：**每条判据都有一个反向对照**，且该对照把**其余判据全部摆成通过
 *   状态**，只让被测那一条失败。这样「哪一条挡下的」是可证的，而不是靠 403 猜。
 *
 * ★ DNS rebinding 是本文件的主角：把一个域名解析到 127.0.0.1 之后，请求真的打到了
 *   本机服务，而 `Origin` 与 `Host` **都是攻击者的域名**、浏览器视为同源 ——
 *   所以「Origin 存在」「Origin == Host」这两条**挡不住**它。挡住它的是
 *   「Host 头必须解析成回环主机名」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isIPv4Loopback, isLoopbackAddress, isLoopbackHostname, isTrustedLocalRequest } from '../src/host/trust.js';

/** 造一条「其余判据全部通过」的请求：回环 socket + 回环 Host，无 Origin、无跨站标记。 */
function goodRequest(overrides = {}) {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:52431' },
    ...overrides,
  };
}

describe('isIPv4Loopback', () => {
  it('127/8 全段都是回环（不只是 127.0.0.1）', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '127.255.255.255', '127.0.0.0']) {
      assert.equal(isIPv4Loopback(address), true, address);
    }
  });

  it('反向对照：只差第一段的都不是回环', () => {
    for (const address of ['126.0.0.1', '128.0.0.1', '192.168.1.1', '10.0.0.1', '8.8.8.8', '0.0.0.0']) {
      assert.equal(isIPv4Loopback(address), false, address);
    }
  });

  it('段数 / 段值不合法的一律不是（不能让 `127.0.0.1.evil` 混进来）', () => {
    for (const address of ['127.0.0.1.evil', '127.0.0.1.5', '127.0.0', '127.0.0.1.1.1', '127.0.0.999', '127.0.0.-1', '', 'localhost', '::1']) {
      assert.equal(isIPv4Loopback(address), false, address);
    }
  });
});

describe('isLoopbackAddress（socket 对端）', () => {
  it('认 IPv4 回环、`::1`、IPv4-mapped `::ffff:127/8`', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::FFFF:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.9.9.9'), true);
  });

  it('反向对照：非回环地址与空值一律不是', () => {
    assert.equal(isLoopbackAddress('::ffff:192.168.1.5'), false);
    assert.equal(isLoopbackAddress('192.168.1.5'), false);
    assert.equal(isLoopbackAddress('fe80::1'), false);
    assert.equal(isLoopbackAddress(''), false);
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(null), false);
    assert.equal(isLoopbackAddress(42), false);
  });
});

describe('isLoopbackHostname（Host 头）', () => {
  it('认 localhost / `[::1]` / `::1` / 127/8', () => {
    assert.equal(isLoopbackHostname('localhost'), true);
    assert.equal(isLoopbackHostname('LOCALHOST'), true);
    assert.equal(isLoopbackHostname('[::1]'), true);
    assert.equal(isLoopbackHostname('::1'), true);
    assert.equal(isLoopbackHostname('127.0.0.1'), true);
  });

  it('★ DNS rebinding：回环 IP 的**子域名**不是回环主机名', () => {
    // `127.0.0.1.evil.com` 会被解析到攻击者控制的 IP；而 `localhost.evil.com`
    // 同理。用「包含 localhost」或「以 127.0.0.1 开头」做判据会在这里漏。
    for (const hostname of [
      '127.0.0.1.evil.com',
      'localhost.evil.com',
      'evil.com',
      '127.0.0.1.nip.io',
      'notlocalhost',
      'localhost-',
      'x127.0.0.1',
    ]) {
      assert.equal(isLoopbackHostname(hostname), false, hostname);
    }
  });
});

describe('isTrustedLocalRequest：合法请求', () => {
  it('回环 socket + 回环 Host，没有 Origin（Electron 转发后的形态）', () => {
    assert.equal(isTrustedLocalRequest(goodRequest()), true);
  });

  it('IPv6 与 IPv4-mapped 形态', () => {
    assert.equal(isTrustedLocalRequest(goodRequest({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:52431' } })), true);
    assert.equal(isTrustedLocalRequest(goodRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } })), true);
    assert.equal(isTrustedLocalRequest(goodRequest({ headers: { host: 'localhost:52431' } })), true);
  });

  it('Origin 与 Host 完全一致时通过（同源的浏览器请求）', () => {
    assert.equal(isTrustedLocalRequest(goodRequest({
      headers: { host: '127.0.0.1:52431', origin: 'http://127.0.0.1:52431' },
    })), true);
  });

  it('sec-fetch-site 是 same-origin / same-site / none 都不拦（只拦 cross-site）', () => {
    for (const site of ['same-origin', 'same-site', 'none']) {
      assert.equal(isTrustedLocalRequest(goodRequest({
        headers: { host: '127.0.0.1:52431', 'sec-fetch-site': site },
      })), true, site);
    }
  });

  it('★ `x-forwarded-for` 一律不信 —— 它既不能否决、也不能授予信任', () => {
    // 不能否决：带着一个公网 XFF 的回环请求照常通过。
    assert.equal(isTrustedLocalRequest(goodRequest({
      headers: { host: '127.0.0.1:52431', 'x-forwarded-for': '8.8.8.8' },
    })), true);
    // ★ 不能授予：socket 不是回环时，把 XFF 写成 127.0.0.1 也**不通过**。
    //   信 XFF 的实现会在这里放行 —— 那是把栅栏交给调用方自己声明的头。
    assert.equal(isTrustedLocalRequest({
      socket: { remoteAddress: '203.0.113.7' },
      headers: { host: '127.0.0.1:52431', 'x-forwarded-for': '127.0.0.1' },
    }), false);
  });
});

describe('isTrustedLocalRequest：每条判据各自的反向对照', () => {
  it('判据一（socket 必须是回环）—— 其余全部摆成通过', () => {
    for (const address of ['192.168.1.5', '10.0.0.1', '203.0.113.7', '::ffff:192.168.1.5', 'fe80::1']) {
      assert.equal(isTrustedLocalRequest({
        socket: { remoteAddress: address },
        // Host 是回环的、没有 Origin、没有跨站标记 —— 只有 socket 这一条不合格。
        headers: { host: '127.0.0.1:52431' },
      }), false, address);
    }
  });

  it('判据一：socket 缺失 / 地址为空也不通过（不能「读不到就放行」）', () => {
    assert.equal(isTrustedLocalRequest({ headers: { host: '127.0.0.1:52431' } }), false);
    assert.equal(isTrustedLocalRequest({ socket: {}, headers: { host: '127.0.0.1:52431' } }), false);
    assert.equal(isTrustedLocalRequest({ socket: { remoteAddress: '' }, headers: { host: '127.0.0.1:52431' } }), false);
  });

  it('★ 判据二（Host 必须解析成回环主机名）—— 这就是挡住 DNS rebinding 的那一条', () => {
    for (const host of ['evil.com:52431', '127.0.0.1.evil.com:52431', 'localhost.evil.com:52431', 'attacker.test']) {
      assert.equal(isTrustedLocalRequest({
        socket: { remoteAddress: '127.0.0.1' },   // 请求确实打到了本机
        headers: { host },                        // 但 Host 是攻击者的域名
      }), false, host);
    }
  });

  it('★ 反向对照的加强版：rebinding 场景下 Origin == Host 也**不能**放行', () => {
    // 这是「只看 Origin == Host」那条弱判据会漏掉的确切情形：两边都是攻击者的域名，
    // 浏览器视为同源。只有 Host 判据能挡住。
    assert.equal(isTrustedLocalRequest({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'evil.com:52431', origin: 'http://evil.com:52431' },
    }), false);
  });

  it('判据二：Host 缺失 / 空 / 解析不了也不通过', () => {
    assert.equal(isTrustedLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), false);
    assert.equal(isTrustedLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '' } }), false);
    assert.equal(isTrustedLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'http://' } }), false);
    assert.equal(isTrustedLocalRequest({ socket: { remoteAddress: '127.0.0.1' } }), false);
  });

  it('判据三（显式拒 cross-site）—— 其余全部摆成通过', () => {
    assert.equal(isTrustedLocalRequest({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:52431', 'sec-fetch-site': 'cross-site' },
    }), false);
  });

  it('判据四（有 Origin 时必须与 Host 同源）—— 其余全部摆成通过', () => {
    const base = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:52431' } };
    // 跨站 Origin
    assert.equal(isTrustedLocalRequest({ ...base, headers: { ...base.headers, origin: 'https://evil.com' } }), false);
    // ★ 同主机不同端口也算跨源（端口是源的一部分）
    assert.equal(isTrustedLocalRequest({ ...base, headers: { ...base.headers, origin: 'http://127.0.0.1:9999' } }), false);
    // 主机名写法不同也是跨源（`localhost` 与 `127.0.0.1` 是两个字面量）
    assert.equal(isTrustedLocalRequest({ ...base, headers: { ...base.headers, origin: 'http://localhost:52431' } }), false);
    // 解析不了的 Origin
    assert.equal(isTrustedLocalRequest({ ...base, headers: { ...base.headers, origin: 'null' } }), false);
    assert.equal(isTrustedLocalRequest({ ...base, headers: { ...base.headers, origin: '' } }), false);
  });

  it('★ 判据四**故意不比较协议**（Host 是 authority，不是 origin）', () => {
    // 这是刻意的取舍，不是漏判：
    //   - `Host` 头的形态就是 authority（`host:port`），**不带协议**，所以「相等」
    //     只能在 authority 这一维上定义；
    //   - 反过来按协议比会把宿主配了 TLS 的正常请求挡掉（页面 origin 是 `https://…`
    //     而 Host 仍是裸 authority）—— 那是把用户自己的界面锁在门外。
    //   - 真正的攻击面（跨站页面读响应）由「socket 必须回环」+「Host 必须回环主机名」
    //     + 「拒 cross-site」三条挡着；这一条是纵深，不是主力。
    assert.equal(isTrustedLocalRequest({
      ...{ socket: { remoteAddress: '127.0.0.1' } },
      headers: { host: '127.0.0.1:52431', origin: 'https://127.0.0.1:52431' },
    }), true);
  });
});

describe('isTrustedLocalRequest：一批敌意请求必须全判 false', () => {
  it('逐个断言，避免「批量里有一条悄悄通过」被平均数掩盖', () => {
    const hostile = [
      // DNS rebinding 的几种写法
      { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.com' } },
      { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost.evil.com' } },
      { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1.evil.com' } },
      // 内网其它机器直接打过来
      { socket: { remoteAddress: '192.168.1.20' }, headers: { host: '192.168.1.20:52431' } },
      { socket: { remoteAddress: '10.1.2.3' }, headers: { host: '127.0.0.1:52431' } },
      // 跨站页面发起的请求
      { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:52431', 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' } },
      // 头缺失
      { headers: { host: '127.0.0.1:52431' } },
      { socket: { remoteAddress: '127.0.0.1' }, headers: {} },
      {},
    ];
    for (const [index, req] of hostile.entries()) {
      assert.equal(isTrustedLocalRequest(req), false, `第 ${index} 条敌意请求被放行了：${JSON.stringify(req)}`);
    }
    assert.equal(hostile.length, 9);
  });
});
