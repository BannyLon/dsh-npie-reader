/**
 * 书源的**浏览器半区**：`library-api.js` 的请求契约 + `BookSources.jsx` 的向导。
 *
 * ★ 为什么要有这个文件：新建的 `BookSources.jsx`（约 330 行）与 `library-api.js` 的
 *   八个新函数原先**一个用例都没有**。而这两处恰好是「客户端与宿主之间那道缝」——
 *   缝对不齐时的症状全都是**静默的**：
 *
 *   - `saveSources` 把书源放错字段名 ⇒ 宿主收到 `undefined` ⇒ `normalizeBookSources`
 *     返回 `[]` ⇒ **用户的书源被清空，而界面显示「已保存」**；
 *   - `listPanDirs` 不对 path 编码 ⇒ 含中文/空格的网盘目录列不出来；
 *   - `scanSources` 用默认 20 秒超时 ⇒ 走磁盘或列一棵 1400 本的网盘树必然超时，
 *     而超时的表现是「点了没反应」，用户会反复点；
 *   - `BookSources` 缺了准备说明 ⇒ 向导第一步就是死胡同（百度开放平台**没有**
 *     「零申请」的调用方式），而用户卡住时不会看到任何报错。
 *
 * 请求那一半用假 `fetch` **真调**（不是查字符串），因为「URL 拼错一位」正是要抓的东西；
 * 组件那一半是本仓库对客户端文件一贯的做法（读源码断言关键结构 + 反向对照）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { LIBRARY_API_PREFIX } from '../src/library.js';
import {
  fetchSources,
  listPanDirs,
  loadLists,
  panLogout,
  requestPanAuthorize,
  savePanApp,
  saveSources,
  scanSources,
  submitPanCode,
} from '../src/client/library-api.js';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(pluginRoot, 'src', 'client');

const realFetch = globalThis.fetch;

/** 装一个假 fetch，返回它收到的调用记录。 */
function stubFetch(payload = { ok: true }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: payload.__status ? payload.__status < 400 : true,
      status: payload.__status ?? 200,
      json: async () => payload,
    };
  };
  return calls;
}

after(() => { globalThis.fetch = realFetch; });

const bodyOf = (call) => JSON.parse(call.init.body);

describe('library-api：书源请求与宿主逐字对齐', () => {
  it('fetchSources → GET /sources', async () => {
    const calls = stubFetch({ ok: true, sources: [] });
    await fetchSources();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/sources`);
    // GET 不该带 method 之外的 body（带了会让宿主在 `readBody` 上白等一次流）。
    assert.equal(calls[0].init.method, undefined);
    assert.equal(calls[0].init.body, undefined);
  });

  it('★ saveSources 把书源放在 `sources` 字段里 —— 宿主读的就是 `body.sources`', async () => {
    // 断错字段名的后果特别隐蔽：宿主收到 `undefined` ⇒ `normalizeBookSources(undefined)`
    // 是 `[]` ⇒ **静默把用户的书源清空**，而界面以为保存成功了。
    const calls = stubFetch();
    await saveSources([{ kind: 'local', path: '/库' }]);
    assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/sources`);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(bodyOf(calls[0]), { sources: [{ kind: 'local', path: '/库' }] });
    // 反向对照：**宿主那一侧**确实读 `body.sources`（两半区同时断言，缝才对得齐）。
    const routes = readFileSync(join(pluginRoot, 'src', 'host', 'library-routes.js'), 'utf8');
    assert.ok(routes.includes('setSources(body.sources)'), '宿主不再读 body.sources 了');
  });

  it('★ scanSources → POST /sources/scan，且超时必须是分钟级', () => {
    const calls = stubFetch({ ok: true, total: 0 });
    return scanSources().then(() => {
      assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/sources/scan`);
      assert.equal(calls[0].init.method, 'POST');
      // 这一步要真走磁盘、或者在网盘上列一棵 1400 本的树。用默认的 20 秒必然超时，
      // 而超时的表现是「点了没反应」，用户会反复点（每次都重新扫一遍）。
      const source = readFileSync(join(clientDir, 'library-api.js'), 'utf8');
      const found = /scanSources\([^)]*\)\s*\{[\s\S]{0,300}?timeoutMs:\s*([\d_]+)/.exec(source);
      assert.ok(found, '没找到 scanSources 的超时设置');
      const ms = Number(found[1].replace(/_/g, ''));
      assert.ok(ms >= 120_000, `scanSources 超时只有 ${ms}ms —— 走磁盘/列网盘树必然超时`);
      // 反向对照：默认超时**不该**跟着一起放大（读书那条链路 20 秒是合理上限，
      // 拖长它只会让真正的网络故障多转两分钟圈）。
      const fallback = /const TIMEOUT_MS = ([\d_]+)/.exec(source);
      assert.ok(Number(fallback[1].replace(/_/g, '')) <= 60_000, '默认超时被放大了');
    });
  });

  it('★ scanSources(id) 把 id 放进 body —— 第二步「只生成这一行」靠它', async () => {
    let calls = stubFetch({ ok: true, total: 0 });
    await scanSources('s4117ec5863472f9c');
    assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/sources/scan`);
    assert.deepEqual(bodyOf(calls[0]), { id: 's4117ec5863472f9c' });
    // 反向对照：不传 id 时 body 必须是**空对象**而不是 `{id: undefined}` ——
    // JSON.stringify 会把 `undefined` 整个键丢掉，但写成 `{id}` 时宿主读到的仍是
    // 「没给 id」；这里钉住的是「别传一个空串 id」，那会让宿主回 400「没有这条书源」。
    calls = stubFetch({ ok: true, total: 0 });
    await scanSources();
    assert.deepEqual(bodyOf(calls[0]), {});
    calls = stubFetch({ ok: true, total: 0 });
    await scanSources('');
    assert.deepEqual(bodyOf(calls[0]), {});
    // 反向对照（宿主一侧）：路由读的就是 `body.id`。
    const routes = readFileSync(join(pluginRoot, 'src', 'host', 'library-routes.js'), 'utf8');
    assert.ok(routes.includes('scanSources({ id: body.id })'), '宿主不再读 body.id 了');
  });

  it('★ loadLists(ids) → POST /lists/load，字段名必须是 `ids` —— 第三步唯一的写入口', async () => {
    const calls = stubFetch({ ok: true, loadedListIds: [] });
    await loadLists(['a1', 'a2']);
    assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/lists/load`);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(bodyOf(calls[0]), { ids: ['a1', 'a2'] });
    // 空数组要**照传**（「一份都不载入」是有意义的操作，不是「没传」）。
    const empty = stubFetch({ ok: true, loadedListIds: [] });
    await loadLists([]);
    assert.deepEqual(bodyOf(empty[0]), { ids: [] });
    // 反向对照（宿主一侧）：路由读的就是 `body.ids`。
    const routes = readFileSync(join(pluginRoot, 'src', 'host', 'library-routes.js'), 'utf8');
    assert.ok(routes.includes('setLoadedLists(body.ids)'), '宿主不再读 body.ids 了');
  });

  it('★ listPanDirs 必须 URL 编码 path（网盘目录名常含中文 / 空格 / #）', async () => {
    const calls = stubFetch({ ok: true, dirs: [] });
    await listPanDirs('/我的 资源/电子#书');
    const url = calls[0].url;
    // `#` 不编码会被浏览器当成 fragment ⇒ 宿主只收到前半段，而且**不报错**。
    assert.equal(url.includes('#'), false, `path 没编码：# 被当成了 fragment（${url}）`);
    assert.equal(url.includes(' '), false, `path 没编码：URL 里有裸空格（${url}）`);
    assert.equal(
      new URL(url, 'http://127.0.0.1').searchParams.get('path'),
      '/我的 资源/电子#书',
      '来回一趟之后 path 变了',
    );
  });

  it('savePanApp / submitPanCode 的字段名与宿主一致', async () => {
    let calls = stubFetch();
    await savePanApp('KEY123456', 'SECRET123456');
    assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/pan/app`);
    assert.deepEqual(bodyOf(calls[0]), { appKey: 'KEY123456', secretKey: 'SECRET123456' });

    calls = stubFetch();
    await submitPanCode('THE-CODE');
    assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/pan/token`);
    assert.deepEqual(bodyOf(calls[0]), { code: 'THE-CODE' });

    // 反向对照：宿主读的就是这两个字段名。
    const routes = readFileSync(join(pluginRoot, 'src', 'host', 'library-routes.js'), 'utf8');
    assert.ok(routes.includes('body.appKey'), '宿主不再读 body.appKey');
    assert.ok(routes.includes('body.code'), '宿主不再读 body.code');
  });

  it('requestPanAuthorize / panLogout 是 POST 且不带参数', async () => {
    let calls = stubFetch({ ok: true, clientOk: true, url: 'https://x' });
    await requestPanAuthorize();
    assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/pan/authorize`);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(bodyOf(calls[0]), {});

    calls = stubFetch();
    await panLogout();
    assert.equal(calls[0].url, `${LIBRARY_API_PREFIX}/pan/logout`);
    assert.equal(calls[0].init.method, 'POST');
  });

  it('★ 宿主回 `ok:false` 时要抛错（不能把失败当成功）', async () => {
    stubFetch({ ok: false, error: '书源必须是数组' });
    await assert.rejects(() => saveSources('x'), /书源必须是数组/);
  });

  it('★ 反向对照：宿主没给 error 字段时也要有话说（不许抛 undefined）', async () => {
    stubFetch({ ok: false });
    await assert.rejects(() => fetchSources(), /请求失败（HTTP 200）/);
  });

  it('HTTP 层失败也带上状态码（排障要知道是 404 还是 500）', async () => {
    stubFetch({ __status: 404, ok: false, error: 'not found' });
    await assert.rejects(() => fetchSources(), /not found/);
  });
});

describe('BookSources：向导不能是死胡同', () => {
  const source = readFileSync(join(clientDir, 'BookSources.jsx'), 'utf8');

  it('★ 五步准备说明必须在，且覆盖「缺一条就走不通」的那几个点', () => {
    // 百度开放平台**没有**「零申请」的调用方式。说明不完整时用户第一步就卡死，
    // 而他卡住时看不到任何报错 —— 只会以为插件坏了。
    for (const must of ['实名认证', '创建应用', 'oob', 'AppKey', 'SecretKey', '网盘']) {
      assert.ok(source.includes(must), `准备说明缺了「${must}」`);
    }
    // 反向对照：说明必须逐条渲染成一个列表（压成一段长文案会被当背景略过）。
    assert.match(source, /SETUP_STEPS\.map/, '准备说明没有逐条渲染');
    assert.match(source, /<li key=\{index\}>/, '准备说明不是列表项');
  });

  it('网盘状态分四种说法（合并成「已连接 / 未连接」会让用户不知道该做什么）', () => {
    for (const tone of ['is-bad', 'is-todo', 'is-ok']) {
      assert.ok(source.includes(tone), `缺了状态样式 ${tone}`);
    }
    // 三种「没连上」的下一步不同：注册应用 / 重新授权 / 去点授权。
    assert.ok(source.includes('还没配置应用'), '未配置应用那句不见了');
    assert.ok(source.includes('授权已过期'), '过期那句不见了');
    assert.ok(source.includes('但还没授权'), '「填了应用但没授权」那句不见了');
    // 宿主没接上时要说「向导没接上」，而不是伪装成「未配置」让用户去注册应用。
    assert.ok(source.includes('没有接上'), '宿主未挂载时的说法不见了');
  });

  it('★ 提交 AppKey / SecretKey 成功之后立刻清空草稿（秘密不在页面上多留一秒）', () => {
    assert.match(
      source,
      /setAppDraft\(\{\s*appKey:\s*'',\s*secretKey:\s*''\s*\}\)/,
      '提交成功后没有清空 AppKey / SecretKey 草稿',
    );
    // 反向对照：SecretKey 输入框必须是 password 类型（不该明文显示、也不该被自动填充）。
    assert.match(source, /type="password"[^>]*aria-label="百度网盘 SecretKey"/, 'SecretKey 不是 password 输入框');
    assert.match(source, /autoComplete="off"/, '凭证输入框关掉自动填充了吗');
  });

  it('★ 扫描结果要**逐条**列出失败源 —— 只说「生成了 0 本」用户无从下手', () => {
    assert.match(source, /scan\.errors/, '没有渲染扫描失败清单');
    assert.match(source, /error\.root/, '失败清单里没说是哪个源');
    assert.match(source, /error\.message/, '失败清单里没说是什么原因');
  });

  it('★ 保存之后用**宿主返回值**回填，不做乐观更新', () => {
    // 乐观更新的后果：坏行被宿主规范化丢掉之后，界面还显示着那条坏行 ——
    // 用户下次点保存时以为它还在，而宿主那边早就没有了。
    assert.match(source, /setState\(await saveSources\(next\)\)/, '保存后没用宿主返回值回填');
    // 反向对照：扫描那条路也是回填空宿主给的 sources / output / pan。
    assert.match(source, /setState\(\(previous\)\s*=>/, '扫描后没有回填宿主状态');
  });

  it('生成落点必须来自宿主，客户端不许自己拼', () => {
    // 客户端拿不到 DSH_HOME（要 import `node:os`）⇒ 自己拼的路径一定是错的。
    assert.match(source, /state\?\.output\?\.dir/, '落点目录没有从宿主状态里取');
    // 反向对照：这个文件不许出现任何 Node 内建模块。
    assert.equal(/from\s+'node:/.test(source), false, '客户端文件 import 了 Node 内建模块');
  });

  it('★ 书单行显示的是**书源目录**，不是数据目录下的哈希文件名', () => {
    // `row.path` 是 `<数据目录>/lists/<id>.json`，直接显示出来就是一串 `s0f3a1c9…json`：
    // 用户既认不出这是什么，也看不出这份书单扫的是哪个目录。而书单名可以改，
    // 改名之后**目录名就是唯一的来源线索**，所以这行必须回落到 `row.root`。
    assert.match(source, /baseName\(row\.root \|\| row\.path\)/, '书单行没有回落到书源目录');
    assert.match(source, /title=\{row\.root \|\| row\.path\}/, '完整路径没有放进 title');
    // 反向对照 ①：不许再出现把内部 id 文件名当显示内容的写法（这就是回归点）。
    assert.equal(/\{baseName\(row\.path\)\}/.test(source), false, '书单行又把哈希文件名显示出来了');
    // 反向对照 ②：第 1 步的书源行**必须**继续直接显示 `source.path`（那本来就是真目录），
    // 不许被这一轮顺手改掉 —— 两处语义不同，不能一起改。
    assert.match(source, /\{source\.path\}/, '书源行的目录路径被误改了');
  });

  it('★ SettingsPage 真的把它挂上了（组件写了但没接进去 = 用户永远看不到）', () => {
    const settings = readFileSync(join(clientDir, 'SettingsPage.jsx'), 'utf8');
    assert.match(settings, /import \{ BookSources \} from '\.\/BookSources\.jsx'/);
    assert.match(settings, /<BookSources\b/, 'SettingsPage 没有渲染 BookSources');
  });
});

describe('refinements.css：书源面板的样式', () => {
  const css = readFileSync(join(clientDir, 'refinements.css'), 'utf8');
  const source = readFileSync(join(clientDir, 'BookSources.jsx'), 'utf8');

  /**
   * 取出所有 `@container` / `@media` 块的**完整正文**。
   *
   * ★ 用花括号配平来定界，不用正则圈长度：正则圈出来的区间会越出块尾，
   *   把后面**顶层**的规则也吞进来 —— 那样「块里有没有 X」的答案就是假的
   *   （本文件第一版正是这么写的，结果是假失败）。
   */
  function conditionalBlocks(text) {
    const blocks = [];
    const re = /@(container|media)\b[^{]*\{/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      let depth = 1;
      let index = re.lastIndex;
      while (index < text.length && depth > 0) {
        if (text[index] === '{') depth += 1;
        else if (text[index] === '}') depth -= 1;
        index += 1;
      }
      blocks.push({ head: match[0].trim(), body: text.slice(re.lastIndex, index - 1) });
      re.lastIndex = index;
    }
    return blocks;
  }

  it('★ 组件用到的 `npr-src` 类在 CSS 里都有定义', () => {
    const used = new Set();
    for (const match of source.matchAll(/className="([^"]*)"/g)) {
      for (const name of match[1].split(/\s+/)) if (name.startsWith('npr-src')) used.add(name);
    }
    // 反向对照：样扫必须真的扫到东西 —— 一个都没扫到时，下面的循环会「0 个全绿」。
    assert.ok(used.size >= 4, `只找到 ${used.size} 个 npr-src 类，类扫可能写错了`);
    for (const name of used) {
      assert.ok(css.includes(`.${name}`), `CSS 缺了 .${name}`);
    }
  });

  it('★ 书源卡的样式不许放进 @container —— 它挂在固定 820px 的设置弹窗里', () => {
    // `@container` 量的是**外层容器**的宽度：面板宽、弹窗窄时规则不触发，
    // 表现是「大窗口里排版正常、弹窗里挤成一坨」，而且换窗口大小还会变。
    const blocks = conditionalBlocks(css);
    assert.ok(blocks.length >= 3, `只解析出 ${blocks.length} 个条件块，解析器可能坏了`);
    const offenders = blocks.filter((block) => block.body.includes('.npr-src'));
    assert.deepEqual(
      offenders.map((block) => block.head),
      [],
      '书源卡的样式被放进了容器查询/媒体查询里',
    );
    // 反向对照：解析器确实能定位到块**内**的选择器 —— 拿已知在 @container 里的
    // 类名验证（阅读器那部分在用）。少了这条，一个「永远返回空块」的解析器也能全绿。
    assert.ok(
      blocks.some((block) => block.body.includes('.npr-workarea')),
      '@container 块里找不到已知的 .npr-workarea —— 解析器假绿',
    );
  });
});
