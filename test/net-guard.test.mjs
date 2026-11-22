/**
 * 外抓守卫的判据（0.24.4）。
 *
 * 这一层守的是「第三方可控的 URL 不许把插件引向本机/内网」。
 * 每条判据都配反向对照 —— 尤其是「不判私网时这些地址确实会被放行」，
 * 否则整组断言只是在描述自己。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkPublicUrl, isPrivateAddress, isPrivateHostname, isPrivateIPv4, isPrivateIPv6,
  isProxyFakeAddress,
} from '../src/host/net-guard.js';
import { fetchPage } from '../src/host/page-fetch.js';

describe('isPrivateIPv4：私网与保留段', () => {
  const PRIVATE = [
    '127.0.0.1', '127.1.2.3', '127.255.255.255',   // 回环整段，不止 .0.1
    '10.0.0.1', '10.255.255.254',
    '172.16.0.1', '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',                              // 云元数据地址
    '100.64.0.1', '100.127.255.255',                // CGNAT
    '0.0.0.0', '0.1.2.3',                           // 本网络
    '192.0.0.1', '192.0.2.5', '198.51.100.7', '203.0.113.9',
    '198.18.0.1', '198.19.255.255',
    '224.0.0.1', '239.255.255.250',                 // 组播（SSDP 就在这一段）
    '240.0.0.1', '255.255.255.255',
  ];
  const PUBLIC = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    '172.15.0.1', '172.32.0.1',                     // 172.16/12 的**两侧**
    '192.167.0.1', '192.169.0.1',                   // 192.168/16 的两侧
    '100.63.255.255', '100.128.0.1',                // CGNAT 的两侧
    '169.253.0.1', '169.255.0.1',
  ];

  it('私网/保留段全部判为 true', () => {
    for (const ip of PRIVATE) assert.equal(isPrivateIPv4(ip), true, ip);
  });

  it('公网地址一个都不许误判（段边界的两侧都测了）', () => {
    for (const ip of PUBLIC) assert.equal(isPrivateIPv4(ip), false, ip);
  });

  it('非法写法不炸，且判为「不是私网 IP」', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '1.2.3.256', 'a.b.c.d', '1.2.3.-1', null, undefined]) {
      assert.equal(isPrivateIPv4(bad), false, String(bad));
    }
  });

  it('反向对照：把 172.16/12 写成 172.16/16 会漏掉 172.17–172.31（真实错法）', () => {
    const narrow = (ip) => ip.split('.')[0] === '172' && ip.split('.')[1] === '16';
    assert.equal(narrow('172.17.0.1'), false, '窄判据漏掉了 172.17');
    assert.equal(isPrivateIPv4('172.17.0.1'), true, '我们的判据必须抓住它');
  });
});

describe('isProxyFakeAddress：只认 198.18/15 这个基准测试段', () => {
  it('收 198.18.0.0–198.19.255.255，段两侧一个都不收', () => {
    for (const ip of ['198.18.0.0', '198.18.0.49', '198.19.255.255']) {
      assert.equal(isProxyFakeAddress(ip), true, ip);
    }
    for (const ip of ['198.17.255.255', '198.20.0.1', '198.18.0.256', '127.0.0.1', '8.8.8.8', 'fc00::1']) {
      assert.equal(isProxyFakeAddress(ip), false, ip);
    }
  });

  it('非法写法不炸（这一层跑在用户机器给的 DNS 结果上）', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', 'a.b.c.d', null, undefined, '198.18.0.x']) {
      assert.equal(isProxyFakeAddress(bad), false, String(bad));
    }
  });

  it('★ isPrivateIPv4 仍把这段判为私网 —— 放宽的只有 checkPublicUrl 那一步', () => {
    // 守住边界：别为了 fake-ip 把「198.18 是保留段」这个事实也改掉，
    // 否则依赖 isPrivateAddress 的其他调用点会跟着松动。
    assert.equal(isPrivateIPv4('198.18.0.49'), true);
    assert.equal(isProxyFakeAddress('198.18.0.49'), true);
  });
});

describe('isPrivateIPv6：回环、ULA、IPv4-mapped', () => {
  const PRIVATE = [
    '::1', '::', '0:0:0:0:0:0:0:1',
    'fe80::1', 'fe80::1%en0', 'febf::1',            // 链路本地（带 zone 也算）
    'fc00::1', 'fd12:3456:789a::1',                 // ULA
    'ff02::1', 'ff05::2',                           // 组播
    '::ffff:127.0.0.1', '::ffff:10.0.0.1',          // IPv4-mapped 到私网
    '::127.0.0.1',                                  // IPv4-compatible（已废弃但能连）
    '2001:db8::1',                                  // 文档段
    '64:ff9b::7f00:1',                              // NAT64 → 127.0.0.1
  ];
  const PUBLIC = [
    '2606:4700:4700::1111', '2001:4860:4860::8888',
    '::ffff:8.8.8.8',                               // IPv4-mapped 到公网
    '2001:4860::1',
  ];

  it('私网/保留段全部判为 true（含方括号与 zone id）', () => {
    for (const ip of PRIVATE) assert.equal(isPrivateIPv6(ip), true, ip);
    assert.equal(isPrivateIPv6('[::1]'), true);
  });

  it('公网地址不误判', () => {
    for (const ip of PUBLIC) assert.equal(isPrivateIPv6(ip), false, ip);
  });

  it('解析不了的写法返回 false（不抛错）', () => {
    for (const bad of ['', 'gggg::1', '1:2:3', '::1::2', 'fe80::1::2', null]) {
      assert.equal(isPrivateIPv6(bad), false, String(bad));
    }
  });
});

describe('isPrivateHostname：不查 DNS 就能判的', () => {
  it('localhost 系、mDNS、云内部域名、裸私网 IP 全部拦下', () => {
    for (const host of [
      'localhost', 'LOCALHOST', 'api.localhost', 'printer.local', 'db.internal',
      '127.0.0.1', '[::1]', '10.1.2.3', '169.254.169.254', '::ffff:127.0.0.1',
    ]) {
      assert.equal(isPrivateHostname(host), true, host);
    }
  });

  it('正常域名不误伤（含名字里带 local 的）', () => {
    for (const host of ['example.com', 'localhost.example.com', 'mylocal.dev', 'sub.domain.co.uk']) {
      assert.equal(isPrivateHostname(host), false, host);
    }
  });
});

describe('checkPublicUrl：解析结果也要判', () => {
  /** 假解析器：把 host 映射到给定地址，未登记的抛错（模拟解析失败）。 */
  const resolver = (table) => async (host) => {
    if (!(host in table)) throw new Error('ENOTFOUND');
    return table[host].map((address) => ({ address }));
  };

  it('公网域名 + 公网地址 ⇒ 放行', async () => {
    const verdict = await checkPublicUrl('https://example.com/a', {
      resolve: resolver({ 'example.com': ['93.184.216.34'] }),
    });
    assert.equal(verdict.ok, true);
  });

  it('域名解析到回环 ⇒ 拒（这就是「恶意 feed 指本机」的主路径）', async () => {
    const verdict = await checkPublicUrl('https://evil.test/a', {
      resolve: resolver({ 'evil.test': ['127.0.0.1'] }),
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /内网地址/);
  });

  it('★ 混合记录（一个公网 + 一个私网）⇒ 拒 —— 只看第一条会被绕过', async () => {
    const verdict = await checkPublicUrl('https://mixed.test/a', {
      resolve: resolver({ 'mixed.test': ['93.184.216.34', '10.0.0.5'] }),
    });
    assert.equal(verdict.ok, false, '只查第一条的实现会放行这一条');
  });

  it('裸私网 IP 不用查 DNS 就拒（解析器一次都不许被调用）', async () => {
    let called = 0;
    const verdict = await checkPublicUrl('http://127.0.0.1:8899/api/books', {
      resolve: async () => { called += 1; return []; },
    });
    assert.equal(verdict.ok, false);
    assert.equal(called, 0, '裸 IP 不该走到 DNS 那一步');
  });

  it('解析失败 ⇒ 拒（fail-closed，不是放行）', async () => {
    const verdict = await checkPublicUrl('https://nxdomain.test/a', { resolve: resolver({}) });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /解析不了/);
  });

  it('解析结果为空 ⇒ 拒', async () => {
    const verdict = await checkPublicUrl('https://empty.test/a', { resolve: async () => [] });
    assert.equal(verdict.ok, false);
  });

  it('非 http(s) 协议 ⇒ 拒', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,x', 'ftp://example.com/a']) {
      const verdict = await checkPublicUrl(url, { resolve: async () => ['93.184.216.34'] });
      assert.equal(verdict.ok, false, url);
    }
  });

  it('非法 URL ⇒ 拒（不抛错）', async () => {
    for (const url of ['', 'not a url', 'http://']) {
      const verdict = await checkPublicUrl(url, { resolve: async () => ['93.184.216.34'] });
      assert.equal(verdict.ok, false, url);
    }
  });

  it('★ 代理 fake-ip（198.18/15）⇒ 放行（0.90.1：不开这个口子所有外抓都发不出去）', async () => {
    // 用户现场：export.arxiv.org → 198.18.0.49，curl 通而插件报「解析到内网地址」。
    // TUN 模式下系统解析器对任何域名都回这个段的占位地址，真正的连接由代理按域名完成。
    for (const address of ['198.18.0.49', '198.19.255.255']) {
      const verdict = await checkPublicUrl('https://export.arxiv.org/api/query', {
        resolve: resolver({ 'export.arxiv.org': [address] }),
      });
      assert.equal(verdict.ok, true, `${address} 是代理的 fake-ip，不该当内网拦`);
    }
  });

  it('★ fake-ip 混着真私网 ⇒ 仍拒（不能因为放了一个就整批放行）', async () => {
    const verdict = await checkPublicUrl('https://evil.test/a', {
      resolve: resolver({ 'evil.test': ['198.18.0.49', '127.0.0.1'] }),
    });
    assert.equal(verdict.ok, false, 'DNS 被投毒：一个 fake-ip + 一个回环，仍必须拒');
    assert.match(verdict.reason, /内网地址/);
  });

  it('★ 裸 fake-ip 地址 ⇒ 仍拒（只放行「解析结果」，不放行手写 IP）', async () => {
    let called = 0;
    const verdict = await checkPublicUrl('http://198.18.0.5/api/books', {
      resolve: async () => { called += 1; return []; },
    });
    assert.equal(verdict.ok, false);
    assert.equal(called, 0, '裸 IP 应该在 DNS 之前就被拒');
  });

  it('IPv6 的 fake-ip 池不猜：照旧按 ULA 拒', async () => {
    const verdict = await checkPublicUrl('https://v6.test/a', {
      resolve: resolver({ 'v6.test': ['fc00::1'] }),
    });
    assert.equal(verdict.ok, false);
  });

  it('反向对照：把私网判定换成恒 false，同一批地址全部会被放行', async () => {
    // 这正是 0.24.3 及之前的形态（只校验 ^https?://）。它证明上面那些断言
    // 量的是**私网判定本身**，而不是「URL 恰好写错了」。
    const permissive = async (raw) => {
      try { return { ok: ['http:', 'https:'].includes(new URL(raw).protocol) }; } catch { return { ok: false }; }
    };
    for (const url of [
      'http://127.0.0.1:8899/api/books', 'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/admin', 'http://localhost:4000/',
    ]) {
      assert.equal((await permissive(url)).ok, true, `${url} 在旧形态下会被放行`);
      assert.equal((await checkPublicUrl(url, { resolve: async () => ['127.0.0.1'] })).ok, false);
    }
  });
});

describe('fetchPage：守卫接在请求之前，重定向逐跳校验', () => {
  /** 造一个假 Response。 */
  const response = (status, { location, contentType = 'text/html; charset=utf-8', body = '<html>ok</html>' } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? (location ?? null) : name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });

  /** 记录调用序列的假 fetch。 */
  const spyFetch = (plan) => {
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      const step = plan[url];
      if (step === undefined) throw new Error(`没有为 ${url} 准备响应`);
      return step;
    };
    return { impl, calls };
  };

  const allowAll = async () => ({ ok: true });

  it('正常 200 HTML ⇒ 返回文本', async () => {
    const spy = spyFetch({ 'https://ok.test/a': response(200) });
    const html = await fetchPage('https://ok.test/a', { fetchImpl: spy.impl, checkUrl: allowAll });
    assert.equal(html, '<html>ok</html>');
  });

  it('★ 守卫拒绝时**一个请求都不发**（不是先打了再报错）', async () => {
    const spy = spyFetch({ 'http://127.0.0.1:8899/api/books': response(200) });
    await assert.rejects(
      () => fetchPage('http://127.0.0.1:8899/api/books', {
        fetchImpl: spy.impl,
        checkUrl: async () => ({ ok: false, reason: '指向本机或内网地址' }),
      }),
      /拒绝抓取/,
    );
    assert.deepEqual(spy.calls, [], '守卫拒绝之后仍然发出了请求 —— 内网服务已经被打过一次了');
  });

  it('★ 重定向到私网 ⇒ 拒（首跳公网也不行）', async () => {
    const spy = spyFetch({
      'https://public.test/a': response(302, { location: 'http://127.0.0.1:8899/api/books' }),
      'http://127.0.0.1:8899/api/books': response(200),
    });
    const seen = [];
    const checkUrl = async (url) => {
      seen.push(url);
      const isPrivate = new URL(url).hostname === '127.0.0.1';
      return isPrivate ? { ok: false, reason: '指向本机或内网地址' } : { ok: true };
    };
    await assert.rejects(() => fetchPage('https://public.test/a', { fetchImpl: spy.impl, checkUrl }), /拒绝抓取/);
    assert.deepEqual(spy.calls, ['https://public.test/a'], '跳转目标不该被真的请求');
    assert.equal(seen.length, 2, '每一跳都要过一遍校验');
  });

  it('相对 Location 按当前地址解析', async () => {
    const spy = spyFetch({
      'https://ok.test/a': response(301, { location: '/b' }),
      'https://ok.test/b': response(200, { body: '<html>second</html>' }),
    });
    const html = await fetchPage('https://ok.test/a', { fetchImpl: spy.impl, checkUrl: allowAll });
    assert.equal(html, '<html>second</html>');
  });

  it('重定向超过上限 ⇒ 抛错（不是无限跟）', async () => {
    const plan = {};
    for (let i = 0; i < 10; i += 1) plan[`https://ok.test/${i}`] = response(302, { location: `/${i + 1}` });
    const spy = spyFetch(plan);
    await assert.rejects(
      () => fetchPage('https://ok.test/0', { fetchImpl: spy.impl, checkUrl: allowAll, maxRedirects: 3 }),
      /重定向次数超过/,
    );
  });

  it('非 HTML 的 content-type ⇒ 抛错（PDF/图片不该当正文抽）', async () => {
    const spy = spyFetch({ 'https://ok.test/a.pdf': response(200, { contentType: 'application/pdf' }) });
    await assert.rejects(
      () => fetchPage('https://ok.test/a.pdf', { fetchImpl: spy.impl, checkUrl: allowAll }),
      /not an HTML page/,
    );
  });

  it('超过大小上限 ⇒ 抛错', async () => {
    const spy = spyFetch({ 'https://ok.test/big': response(200, { body: 'x'.repeat(200) }) });
    // ★ 断言**这次的**上限（100 字节），不写死默认值。原来这里断言 `/larger than 5 MB/`
    //   而调用传的是 `maxBytes: 100` —— 那句断言等于给一句假话发合格证：
    //   文案写死「5 MB」，实现改坏了也照样绿。
    await assert.rejects(
      () => fetchPage('https://ok.test/big', { fetchImpl: spy.impl, checkUrl: allowAll, maxBytes: 100 }),
      /larger than 100 bytes/,
    );
  });

  it('HTTP 404 ⇒ 抛错（带上最终地址）', async () => {
    const spy = spyFetch({ 'https://ok.test/missing': response(404) });
    await assert.rejects(
      () => fetchPage('https://ok.test/missing', { fetchImpl: spy.impl, checkUrl: allowAll }),
      /HTTP 404/,
    );
  });

  it('★ 超时真的会中断（signal 被假 fetch 监听）', async () => {
    // 假 fetch 像真 fetch 一样响应 abort，否则「超时」这条判据量不到东西。
    const hanging = (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const pending = fetchPage('https://ok.test/slow', {
      fetchImpl: hanging, checkUrl: allowAll, timeoutMs: 30,
    });
    /* ★ 必须有一个 **ref** 定时器把事件循环按住：`AbortSignal.timeout()` 内部的
       定时器是 unref 的（Node 刻意不让它拖住进程退出）。测试里若只有它在等，
       Node 会在 30ms 到点之前就认为「没事可做了」，于是整条用例被 cancel
       ——报错是「Promise resolution is still pending but the event loop has
       already resolved」，看上去像代码有问题，其实是量测环境太安静。 */
    const keepAlive = new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(
      pending,
      (error) => error?.name === 'TimeoutError' || /abort/i.test(String(error?.message)),
    );
    await keepAlive;
  });
});
