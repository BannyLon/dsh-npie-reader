/**
 * 日记的浏览器侧客户端：**走 HTTP**，不走 Remote/Gateway。
 *
 * 为什么和书架一样走 HTTP：日记是**文件**，界面要的是「某个月哪几天有内容」
 * 「这一天的全文」「跨天搜一句话」，全是读盘操作。走 RPC 会把每次翻页变成一次
 * 全量序列化，而 `data.json` 已经 9.6 MB —— 日记正文根本不可能放进去。
 *
 * 路径全部用**相对路径**：renderer 的原点是自定义协议 `dsh-app://app`，相对路径会被
 * Electron 主进程转发给宿主（并补上 Host），所以这里不需要知道端口。
 */
import { DIARY_API_PREFIX } from '../diary-format.js';

const TIMEOUT_MS = 20_000;
/** 导出全部日记可能几 MB，给它更长的超时。 */
const EXPORT_TIMEOUT_MS = 120_000;

async function jsonRequest(path, init = {}, { timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DIARY_API_PREFIX}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      cache: 'no-store',
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch { body = null; }
    if (!response.ok || body?.ok === false) {
      // 宿主返回的 error 是给用户看的中文说明（「这一天已经 20 万字…」），优先用它。
      throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`);
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 某月哪几天有日记、各有几条。 */
export async function fetchDiaryMonth(month) {
  return await jsonRequest(`/days?month=${encodeURIComponent(month)}`);
}

/** 某一天的全文 + 解析好的分条。不存在时 `exists: false`（**不是错误**）。 */
export async function fetchDiaryDay(date) {
  return await jsonRequest(`/day/${encodeURIComponent(date)}`);
}

/**
 * 私密侧栏的自省面板：本月情绪分布 / 连续天数 / 本月字数 / 那年今日。
 *
 * ★ 三个日期都要传，而且**不能合并**：
 *   - `date` 是用户正在看的那一天 —— 「那年今日」按它的月-日回溯；
 *   - `today` 是真实的今天 —— 连续天数按它数；
 *   - `month` 是日历**正在显示**的那个月 —— 情绪分布与字数按它统计。
 *   翻到去年的今天、或者只按箭头翻月却没点任何一天时，这三者互不相同；
 *   只传一个会让「连续 12 天」变成「连续 0 天」，或者「本月情绪」说的不是这个月。
 * ★ 锁着时宿主会把 `chars` 收成 `null`、`moods` 收成 `[]`，并把 `onThisDay` 里每一条
 *   降级成 `{ date, years, locked: true }`。界面据此显示锁态，别自己再猜一遍。
 */
export async function fetchDiaryDashboard({ date, today, month }) {
  const params = new URLSearchParams({ date });
  if (today) params.set('today', today);
  if (month) params.set('month', month);
  return await jsonRequest(`/dashboard?${params.toString()}`);
}

/**
 * 追加一条。
 *
 * `vis: 'private'` 写进**加密文件**（`private/YYYY-MM-DD.md.enc`），`meta` 是
 * 情绪 / 关联（见 `diary-format.js` 的 `normalizeMeta`，宿主会再洗一遍白名单）。
 */
export async function appendDiaryEntry({ date, time, kind, source, body, meta, vis }) {
  return await jsonRequest(`/day/${encodeURIComponent(date)}/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ time, kind, source, body, meta, vis }),
  });
}

/**
 * 传一张图（0.73.0），拿回可直接写进 markdown 的地址。
 *
 * ★ 请求体**直接放那个 `File`**，不先转 base64：转一次体积多 33%，还要在内存里
 *   多留一份 —— 而 8 MB 是允许的上限，多一份就是多 11 MB 的字符串。
 * ★ `content-type` 照文件自己的报，但**宿主不信它**（按 magic bytes 再判）。
 *   这里照报只是为了让宿主在拒绝时能说清「你声明的类型我们不收」。
 * ★ 超时给得比默认长：图是要落盘的，慢的是磁盘而不是网络。
 */
export async function uploadDiaryAsset(file) {
  if (!file) throw new Error('没有可上传的图片');
  return await jsonRequest('/assets', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  }, { timeoutMs: 60_000 });
}

/**
 * 清掉没被任何条目引用的图（0.73.1）。
 *
 * ★ **默认只预演**（`dryRun: true`）：返回「会删几张、一共多少 MB」，不真删。
 *   调用方拿到数字给人看过、得到确认之后，再传 `{ dryRun: false }` 真删。
 *   把默认值设成真删，第一个手滑的调用就把用户的图清干净了 —— 而图不在
 *   `data.json` 里，没有备份能救回来。
 */
export async function pruneDiaryAssets({ dryRun = true } = {}) {
  return await jsonRequest('/assets/prune', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun }),
  });
}

/**
 * 删掉某一天的某一条。
 *
 * ★ `scope` 必须跟着走：公开与私密是**两个文件**，各有自己的序号。只传一个下标
 *   就等于让宿主去猜「他说的是哪一半」，猜错一次就是删掉另一条日记。
 */
export async function removeDiaryEntry(date, index, scope = 'public') {
  const query = scope === 'private' ? '?scope=private' : '';
  return await jsonRequest(`/day/${encodeURIComponent(date)}/entry/${index}${query}`, { method: 'DELETE' });
}

/**
 * 删掉某一天的**全部记录**（0.75.0）。
 *
 * ★ 它与 `removeDiaryEntry` 的差别不只是「多删几条」：宿主那边是**一次移动**
 *   （`rename` 到 `diary/_trash/`），不是 N 次「读整份 → 删一条 → 整份写回」。
 *   所以它只有两种结果 —— 整天没了，或者一条都没动，不会出现删了一半的一天。
 * ★ `scope` 仍然必须显式：公开与私密是两个文件，猜错一次就是删错一整天。
 * ★ 回执里有 `trashed`（`_trash/2026-11-11@…md`）：那是「去哪儿找回来」，
 *   界面必须把它说出来，否则用户以为这是不可逆的。
 */
export async function removeDiaryDay(date, scope = 'public') {
  const query = scope === 'private' ? '?scope=private' : '';
  return await jsonRequest(`/day/${encodeURIComponent(date)}${query}`, { method: 'DELETE' });
}

/**
 * 改写某一天的某一条，**只传要改的字段**。
 *
 * ★ 界面只拿它做「挂到书」：把 `source` 与 `meta.book / chapter` 补上去。
 *   **绝不传 `body`** —— 那是整条替换，而「给这一条挂个出处」不该顺手改用户的原话。
 *   （工具侧 `diary_update` 走的是同一个路由，那边是模型明确要改正文，两回事。）
 * ★ `scope` 必须跟着走，同 `removeDiaryEntry`：公开与私密是两个文件、各有自己的序号。
 * ★ 宿主对 `meta` 走 `normalizeMeta` 白名单，所以多传的键会被丢掉而不是写进文件 ——
 *   这也是为什么这里只挑 `book` / `chapter` 两个键。
 */
export async function patchDiaryEntry(date, index, patch, scope = 'public') {
  const query = scope === 'private' ? '?scope=private' : '';
  return await jsonRequest(`/day/${encodeURIComponent(date)}/entry/${index}${query}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(patch),
  });
}

/** 标签索引（带次数与最后使用日期）。 */
export async function fetchDiaryTags() {
  return await jsonRequest('/tags');
}

/** 某一本书的全部读后感（跨天）。读后感工作台的主视图。 */
export async function fetchDiaryBook(bookId) {
  return await jsonRequest(`/book/${encodeURIComponent(bookId)}`);
}

/**
 * 哪几本书写过读后感（0.48）。
 *
 * ★ 侧栏那份名单是「读完的书」，读后感只占其中一部分 —— 靠它标出「已写 / 待写」。
 *   不这么做的话，界面只能逐本点进去才知道有没有内容，而那是 N 次读盘。
 * ★ 返回里 `total` 是**书数**，`entries` 才是篇数：两者在界面上必须分开写，
 *   混着算会得到一个对不上的数（「已写 3 本」却列出 7 篇）。
 */
export async function fetchReflectionIndex() {
  return await jsonRequest('/reflections');
}

/** 时间轴：最近 N 天 + 每天几条预览。`before` 传日期就是「加载更早」。 */
export async function fetchDiaryTimeline({ limit, before } = {}) {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  if (before) params.set('before', before);
  const query = params.toString();
  return await jsonRequest(`/timeline${query ? `?${query}` : ''}`);
}

/**
 * 「这个来源的全部灵感」（0.47）。
 *
 * ★ 与 `/timeline` 分开而不是给它加参数：时间轴只读最近 N 天，而聚合视图问的是
 *   **全部** —— 拿分页接口凑一个「全部」出来，两者迟早会在某个数字上对不上。
 * ★ 返回的 `days` 与 `/timeline` 同形，客户端直接替换数据源，不换渲染。
 */
export async function fetchDiarySource({ book = '', article = '' } = {}) {
  const params = new URLSearchParams();
  if (book) params.set('book', book);
  if (article) params.set('article', article);
  return await jsonRequest(`/source?${params.toString()}`);
}

/**
 * 密钥状态。**会触发取密钥**（首次会在登录钥匙串里建一条），所以只能由一次明确的
 * 用户动作调它 —— 不要放进轮询、也不要放进页脚的 `stats`。
 */
export async function fetchDiarySecret() {
  return await jsonRequest('/secret');
}

/**
 * 口令闸门的状态。**不碰钥匙串、不做密码学**，可以随时调。
 *
 * ★ 锁着的时候宿主的 `/day` 已经把私密正文摘掉了（`body: ''` + `locked: true`），
 *   所以界面必须**先问这个**再决定画什么：画条目还是画解锁框。
 */
export async function fetchDiaryGate() {
  return await jsonRequest('/gate');
}

/**
 * 第一次设置私密日记的口令。
 * ★ 只在「还没设过」时可用：设过之后宿主回 409，界面要走解锁而不是覆盖。
 */
export async function setupDiaryGate(passphrase) {
  return await jsonRequest('/gate', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ passphrase }),
  });
}

/** 解锁。口令不对时宿主回 401，这里会抛「口令不对」。 */
export async function unlockDiaryGate(passphrase) {
  return await jsonRequest('/gate/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ passphrase }),
  });
}

/** 立刻上锁。关闭私密模块、点「锁定」、窗口失焦超时都调它。 */
export async function lockDiaryGate() {
  return await jsonRequest('/gate/lock', { method: 'POST' });
}

/**
 * 跨天搜。
 *
 * ★ `module`（0.86.0）：跟着选项卡走 —— 在读后感里搜就只搜读后感。
 *   不传 = 搜全部（老行为）。宿主的 `moduleScope()` 负责把它翻成 `kind` 过滤，
 *   客户端不自己拼查询条件（两处各拼一次，迟早出现「界面筛了、宿主没筛」）。
 */
export async function searchDiary(query, limit, module = '') {
  const params = new URLSearchParams({ q: query });
  if (limit !== undefined) params.set('limit', String(limit));
  if (module !== '') params.set('module', module);
  return await jsonRequest(`/search?${params.toString()}`);
}

/** 多少天、占多少字节、目录在哪。 */
export async function fetchDiaryStats() {
  return await jsonRequest('/stats');
}

/**
 * 阅读周报（0.88.0）。
 *
 * ★ `week` 只传 `2026-W47` 这种形状，**不传日期**：一周的边界由宿主按本地时区算
 *   （`weekRange`）。客户端传一个日期的话，同一台机器上两个时区解释会打架 ——
 *   而那种错不会报错，只会让某一周多一天或少一天。
 * @param {string} [week] - 缺省 = 本机当前时间所在周。
 * @param {number} [weeks] - 一次返回几周（侧栏列表用），默认 8。
 */
export async function fetchWeekly(week, weeks) {
  const query = new URLSearchParams();
  if (typeof week === 'string' && week !== '') query.set('week', week);
  if (Number.isFinite(weeks) && weeks > 0) query.set('weeks', String(Math.trunc(weeks)));
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
  // 周报要读 8 周的日记文件（最多 56 个）+ 划线目录，给比普通请求更长的超时。
  return await jsonRequest(`/weekly${suffix}`, {}, { timeoutMs: 60_000 });
}

/**
 * 读后感一键提纲（0.88.0）。
 *
 * ★ 超时给 90 秒：一次模型调用 + 最多 40 章的要点读取。默认 20 秒的话，
 *   材料稍多的书就会稳定超时 —— 而用户看到的「请求超时」和「模型太慢」是两件事，
 *   他只会觉得这个按钮坏了。
 * ★ `draft` 要一起送：提纲要**接着**用户已经写的半截写，不是另起一套。
 *   只送 bookId 的话，用户写了两段再点一次，模型会把那两段的思路绕开。
 */
export async function requestReflectionOutline(bookId, draft) {
  return await jsonRequest('/reflection/outline', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ bookId, draft: typeof draft === 'string' ? draft : '' }),
  }, { timeoutMs: 90_000 });
}

/** 在系统文件管理器里打开日记目录（`module` 决定打开 `daily/` 还是 `private/`）。 */
export async function revealDiaryFolder(module = '') {
  return await jsonRequest('/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ module }),
  });
}

/**
 * 导出（一次性出口）。
 *
 * ★ **默认不含私密日记**：导出写的是浏览器下载目录里的明文，那正好是加密层要防的
 *   第一件事。要含必须显式传 `includePrivate: true`，且界面负责把后果说清楚
 *   （明文会落到下载目录、不进废纸篓就一直在）。
 * ★ `module`（0.86.0）：用户 2026-11-19「明明我切到读后感了，点击下载下载的还是
 *   日记」。作用域由宿主按 `kind` 拆条目，客户端只把当前模块原样带上 ——
 *   客户端自己过滤的话，`content` 里那行 `<!-- 2026-11-11.md -->` 与条目就对不上了。
 * ★ `module: 'private'` 时宿主会自动按「含私密」处理（`/export` 那一行），
 *   这里仍然显式传 `includePrivate`：两个参数各说一半，迟早出现「模块=私密、
 *   private 忘了传 ⇒ 导出一份空文件，文件名还写着私密」。
 */
export async function fetchDiaryExport({ includePrivate = false, module = '' } = {}) {
  const params = new URLSearchParams();
  if (includePrivate) params.set('private', '1');
  if (module !== '') params.set('module', module);
  const query = params.toString();
  return await jsonRequest(`/export${query ? `?${query}` : ''}`, {}, { timeoutMs: EXPORT_TIMEOUT_MS });
}

/**
 * 把导出的那些天拼成**一份** Markdown 交给浏览器下载。
 *
 * ★ 为什么是单文件而不是逐天各下一个：浏览器会**拦掉**连续多个自动下载
 *   （Chrome 对「一个动作触发多个下载」默认阻断，用户看到的只是「什么都没发生」）。
 * ★ 为什么（全部导出时）原样保留每天的全文（含它自己的 frontmatter）：这样导出的
 *   东西是**可逆**的 —— 每块前面有一行 `<!-- 2026-10-26.md -->` 说明它原来叫什么
 *   文件，用户按它切回去就能还原成一天一个 .md。顺手把 frontmatter 规范化掉就
 *   做不到这一点了。
 * ★ `label`（0.86.0）：文件名必须说出**这次导的是什么**。写死「日记-导出」时，
 *   在读后感里点下载会得到一个叫「日记」的文件 —— 用户的第一反应就是「下错了」。
 *   空串退回「日记」（老调用点）。
 */
export function downloadDiaryBundle(files, today, label = '') {
  const name = typeof label === 'string' ? label.trim() : '';
  const scope = name === '' ? '日记' : name;
  const parts = [
    `<!-- dsh-npie-reader ${scope}导出 -->`,
    `<!-- 导出时间：${today}；共 ${files.length} 天 -->`,
    '<!-- 每块前一行注释是它原来的文件名。要还原成一天一个 .md，按这些注释切开即可。 -->',
    '',
  ];
  for (const file of files) {
    parts.push(`<!-- ${file.name} -->`, file.text.trimEnd(), '');
  }
  const blob = new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${scope}-导出-${today}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器拿不到内容，延后一拍。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return files.length;
}
