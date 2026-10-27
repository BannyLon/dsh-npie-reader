/**
 * 日记的 HTTP 面。
 *
 * 为什么日记要有自己的 HTTP 前缀，而不是全走 Remote/Gateway：日记是**文件**，不是
 * 单文档状态。界面要的是「某个月哪几天有内容」「这一天的全文」「跨天搜一句话」，
 * 这些都是**读盘**操作，走 RPC 会把每一次都变成一次全量序列化；而 `data.json`
 * 已经 9.6 MB（见 `diary-store.js` 文件头），不可能把日记塞进去。
 *
 * 路由一览（都挂在 `DIARY_API_PREFIX` 下，前缀真值在 `diary-format.js`，
 * 浏览器半区也要用同一份）：
 *
 *   GET    /days?month=YYYY-MM        某月哪几天有日记、各有几条
 *   GET    /day/:date                 某一天的全部条目（公开 + 私密）
 *   POST   /day/:date/append          追加一条（body: { time?, kind?, source?, meta?, vis?, body }）
 *   PATCH  /day/:date/entry/:index?scope=private   改写某一条（body 里给要改的字段）
 *   DELETE /day/:date/entry/:index?scope=private   删掉某一条（按序号 + 归属哪一半）
 *   GET    /tags                      标签索引（带次数与最后使用日期）
 *   GET    /timeline?limit=&before=   时间轴（最近的 N 天 + 条目预览）
 *   GET    /book/:bookId              某一本书的全部读后感（跨天，按 `meta.book` 反查）
 *   GET    /search?q=…&limit=…        跨天搜
 *   GET    /export?private=1          全部日记（一次性出口；默认**不含**私密）
 *   GET    /stats                     多少天、占多少字节、目录在哪、密钥在哪
 *   GET    /secret                    密钥状态（会触发取密钥，只在真正需要时调）
 *   POST   /reveal                    在访达/资源管理器里打开日记目录
 *   GET    /gate                      口令闸门状态（有没有设、现在解没解锁）
 *   POST   /gate                      第一次设置口令（body: { passphrase }）
 *   POST   /gate/unlock               解锁（body: { passphrase }）；错口令 401
 *   POST   /gate/lock                 立刻上锁
 *
 * ★ **私密正文在未解锁时不会离开宿主**。这不是界面上的遮罩：`/day` 返回的私密条目
 *   在锁着时 `body` 是空串、`locked: true`；`/search`、`/tags`、`/timeline` 会关掉
 *   `includePrivate`；`/export?private=1` 与「删掉一条私密」直接 403。
 *   用户 2026-10-27：「私密日记点击就能查看还有什么私密，一定是只能本人查看啊。」
 *   —— 「点一下就看见」正是当时的行为，因为解密发生在宿主、遮罩只画在屏幕上。
 *
 * ★ 每条路由都过 `isTrustedLocalRequest` 栅栏：宿主派发插件路由**不经过**它自己的
 *   鉴权拦截器（先精确路由、再鉴权），漏掉就等于把「读用户日记、删用户日记」
 *   敞开给任何能访问本机端口的东西。这一条和 `library-routes.js` 是同一个理由，
 *   但**不能**共用那个文件里的 `forbidden()` —— 两个模块各自独立，谁改谁都不该
 *   波及另一条通道（`sendJson` 也就一并各写一份，各 10 行，比共享一个 utils 更稳）。
 *
 * ★ 这里**没有任何路径参数**。日期先过 `isValidDateKey`（白名单 + 反解确认），
 *   再由 store 拼成绝对路径 —— 路由层永远拿不到用户输入的路径，穿越面为零。
 *
 * ★ 也**没有**「删掉一整天」的路由。删整天的破坏力与「删一条」不是一个量级，
 *   而它的正当用途只有一个（清空今天重写），那件事用逐条删也能做。少一个入口，
 *   就少一次「手滑点错」。
 */

import { DIARY_API_PREFIX, isValidDateKey, isValidMonthKey } from '../diary-format.js';
import { isTrustedLocalRequest } from './trust.js';

export { DIARY_API_PREFIX };

/**
 * 请求体上限。
 *
 * 一条正文最多 `MAX_ENTRY_CHARS` = 20,000 字（`diary-store.js`）。中文按 UTF-8 是
 * 3 字节，再算 JSON 转义与 `source` 那 300 字，64 KB 会**卡掉合法请求**；
 * 而 20,000 × 3 × 1.4 ≈ 84 KB 已经够宽，留到 256 KB 是为了让「超长」这件事由
 * store 的 `ENTRY_TOO_LARGE`（带一句人话）来回答，而不是路由层一句 `body too large`。
 */
const JSON_BODY_LIMIT = 256 * 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

function forbidden(res) {
  sendJson(res, 403, { ok: false, error: 'forbidden' });
}

function methodNotAllowed(res) {
  sendJson(res, 405, { ok: false, error: 'method not allowed' });
}

/**
 * 日记的错误码 → HTTP 状态码。
 *
 * ★ 分开的理由和 `library-routes.readErrorStatus` 一致：这三种失败对用户意味着
 *   **完全不同的下一步**。
 *   - `ENTRY_TOO_LARGE` / `DAY_TOO_LARGE` ⇒ **413**：内容太大（拆一条 / 换一天存）；
 *   - `EMPTY_ENTRY` / `BAD_DATE` / `BAD_MONTH` / `BAD_BOOK` ⇒ **400**：请求本身不对；
 *   - `ENTRY_NOT_FOUND` ⇒ **404**：这一条已经没了（多半是另一个窗口刚删掉）；
 *   - 磁盘满 ⇒ **507**：清磁盘，不是重试；
 *   - 磁盘权限 / 只读 ⇒ **403**；其余 IO 故障 ⇒ **500**。
 *   全落到 400 的后果是：用户照着「请求有问题」去改，怎么改都没用。
 */
function diaryErrorStatus(error) {
  const code = error?.code ?? '';
  if (code === 'ENTRY_TOO_LARGE' || code === 'DAY_TOO_LARGE') return 413;
  if (code === 'DISK_FULL' || code === 'DISK_TOO_MANY_FILES') return 507;
  if (code === 'DISK_DENIED' || code === 'DISK_READONLY' || code === 'EACCES' || code === 'EPERM') return 403;
  if (code === 'DISK_IO' || code === 'DISK_BAD_PATH' || code === 'EIO') return 500;
  if (code === 'ENTRY_NOT_FOUND' || code === 'ENOENT') return 404;
  if (code === 'EMPTY_ENTRY' || code === 'BAD_DATE' || code === 'BAD_MONTH' || code === 'BAD_BOOK') return 400;
  // 口令闸门：弱口令是**请求不对**（400），锁着是**没权限**（403），
  // 口令文件读不出来是**我们自己坏了**（500，别让用户去改口令试）。
  if (code === 'GATE_WEAK' || code === 'GATE_UNSET') return 400;
  if (code === 'GATE_LOCKED') return 403;
  if (code === 'GATE_WRONG') return 401;
  return 500;
}

function fail(res, error) {
  return sendJson(res, diaryErrorStatus(error), {
    ok: false,
    error: error?.message ?? String(error),
    code: error?.code ?? '',
  });
}

async function readBody(req, limit = JSON_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('这一条太长了，请求体超过上限');
      error.code = 'ENTRY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed;
}

/** 路径段解码。日期是白名单字符，解码失败一律当非法（由 `isValidDateKey` 兜住）。 */
function segment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

/**
 * @param handlers.read - `async (date) => { date, exists, text, entries, chars }`（只公开半边）
 * @param handlers.readFull - `async (date) => { date, exists, entries, chars, publicCount, privateCount }`
 *   可选；给了就用它（合并公开 + 私密）。没给则退回 `read`，行为与 0.30.0 一致。
 * @param handlers.append - `async ({ date, time, kind, source, meta, vis, body }) => { date, time, index, chars, path, scope }`
 * @param handlers.removeEntry - `async ({ date, index, scope }) => { date, entries, chars, scope }`
 * @param handlers.updateEntry - 可选，`async ({ date, index, scope, body, time, kind, source, meta }) => { date, index, time, kind, chars, scope }`
 * @param handlers.listMonth - `async (month) => { month, days, total }`
 * @param handlers.search - `async ({ query, limit, includePrivate }) => { query, hits, scanned, truncated }`
 * @param handlers.tags - 可选，`async ({ includePrivate }) => { tags, scanned, truncated }`
 * @param handlers.timeline - 可选，`async ({ limit, before, includePrivate }) => { days, total, scanned, truncated }`
 * @param handlers.byBook - 可选，`async (bookId) => { bookId, entries, total }`（读后感工作台用）
 *
 * ★ **`includePrivate: true` 只在这一层出现**（`/search` `/tags` `/timeline` 三条）。
 *   这三条都是「用户本人在这台机器上看自己的日记」，界面会给私密条目打小锁；
 *   而工具（`diary_search`）不传这个参数 ⇒ 模型侧永远看不到私密内容。边界就守在
 *   这一行上，所以它必须是**显式写出来**的，不能靠 store 的默认值碰巧对上。
 *   `/export` 是例外：它默认**不含**私密，因为那条路写的是磁盘上的明文。
 * @param handlers.exportAll - `async ({ includePrivate }) => { files: [{ name, text }], total, skippedPrivate }`
 * @param handlers.stats - `async () => { days, bytes, root, privateDays, secret }`
 * @param handlers.secretStatus - 可选，`async () => { mode, keyPath }`。**会触发取密钥**。
 * @param handlers.reveal - 可选，`async () => void`，在系统文件管理器里打开日记目录。
 *   缺了就 501（不能因为「没有这个按钮」让整个前缀挂掉）。
 * @param handlers.log - 记一行日志。
 * @returns WebRoute
 */
export function makeDiaryRoutes(handlers = {}) {
  const {
    read, readFull, append, updateEntry, removeEntry, listMonth, search, tags, timeline, byBook,
    exportAll, stats, secretStatus, reveal, gate,
    log = () => {},
  } = handlers;

  /**
   * 依赖齐不齐。
   *
   * ★ 缺依赖时**退化成 501，而不是抛异常**：一旦 `handler` 抛，整个前缀连同
   *   「读今天」都会 500 —— 界面上表现为日记页一直转圈，而真正的问题在别处。
   *   这个形状是从 `library-routes.js` 的 `sourcesReady` 照抄的，理由一样。
   */
  const ready = typeof read === 'function' && typeof append === 'function'
    && typeof removeEntry === 'function' && typeof listMonth === 'function'
    && typeof search === 'function' && typeof exportAll === 'function'
    && typeof stats === 'function';
  /** 0.31 才有的几条：没接上就 501，不影响老路由。 */
  const extraReady = typeof tags === 'function' && typeof timeline === 'function';
  /**
   * 私密正文现在能不能交出去。
   *
   * ★ 没接上闸门（老测试直接构造路由）时**放行**，这样它是一条可选依赖；
   *   真实宿主一定会接（`service.js` 里 `this.diary.gate`）。这条默认值是权衡后的
   *   选择，写在这里免得以后有人以为「漏传也能用」是设计。
   */
  const gateAllow = () => (gate && typeof gate.allow === 'function' ? gate.allow() === true : true);
  /** 锁着时把私密条目的正文摘掉 —— **不是**加个标记让界面自己藏。 */
  const redact = (payload) => {
    if (!payload || gateAllow()) return payload;
    const entries = Array.isArray(payload.entries)
      ? payload.entries.map((entry) => (entry?.scope === 'private'
        ? { ...entry, body: '', source: '', locked: true }
        : entry))
      : payload.entries;
    return { ...payload, entries, locked: true };
  };

  return {
    kind: 'prefix',
    path: DIARY_API_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) return forbidden(res);
      if (!ready) {
        return sendJson(res, 501, { ok: false, error: '日记存储没有接上' });
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rest = url.pathname.slice(DIARY_API_PREFIX.length) || '/';
      const method = req.method ?? 'GET';
      const parts = rest.split('/').filter((part) => part !== '');

      // ---- GET /days?month=YYYY-MM ------------------------------------------
      if (parts.length === 1 && parts[0] === 'days') {
        if (method !== 'GET') return methodNotAllowed(res);
        const month = url.searchParams.get('month') ?? '';
        if (!isValidMonthKey(month)) {
          return sendJson(res, 400, { ok: false, error: `无效的月份：${month}`, code: 'BAD_MONTH' });
        }
        try {
          return sendJson(res, 200, { ok: true, ...(await listMonth(month)) });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- GET /stats -------------------------------------------------------
      if (parts.length === 1 && parts[0] === 'stats') {
        if (method !== 'GET') return methodNotAllowed(res);
        try {
          return sendJson(res, 200, { ok: true, ...(await stats()) });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- GET /search?q=…&limit=… -----------------------------------------
      if (parts.length === 1 && parts[0] === 'search') {
        if (method !== 'GET') return methodNotAllowed(res);
        const query = url.searchParams.get('q') ?? '';
        // 空查询回空结果、**不回 400**：界面上搜索框每敲一个字都会发一次，
        // 清空输入框时那一次不该变成一条红字。
        try {
          // ★ `includePrivate: true` 只出现在**路由层**。工具（`diary_search`）不传，
          //   所以模型永远看不到私密条目；而在这里看的人是这台机器的用户本人，
          //   界面上每条私密条目都带小锁 —— 看得见「这是私密的」才是正确形态。
          return sendJson(res, 200, {
            ok: true,
            ...(await search({ query, limit: url.searchParams.get('limit'), includePrivate: gateAllow() })),
          });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- GET /tags --------------------------------------------------------
      if (parts.length === 1 && parts[0] === 'tags') {
        if (method !== 'GET') return methodNotAllowed(res);
        if (!extraReady) return sendJson(res, 501, { ok: false, error: '标签索引没有接上' });
        try {
          return sendJson(res, 200, { ok: true, ...(await tags({ includePrivate: gateAllow() })) });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- GET /timeline?limit=&before= -------------------------------------
      if (parts.length === 1 && parts[0] === 'timeline') {
        if (method !== 'GET') return methodNotAllowed(res);
        if (!extraReady) return sendJson(res, 501, { ok: false, error: '时间轴没有接上' });
        try {
          const payload = await timeline({
            limit: url.searchParams.get('limit'),
            before: url.searchParams.get('before') ?? '',
            includePrivate: gateAllow(),
          });
          return sendJson(res, 200, { ok: true, ...payload });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- GET /secret ------------------------------------------------------
      //
      // ★ 这条**会触发取密钥**（首次会在登录钥匙串里建一条）。所以它必须是一个
      //   明确的动作，不能塞进 `/stats` 让页脚每次刷新都去碰钥匙串。
      if (parts.length === 1 && parts[0] === 'secret') {
        if (method !== 'GET') return methodNotAllowed(res);
        if (typeof secretStatus !== 'function') {
          return sendJson(res, 501, { ok: false, error: '密钥状态没有接上' });
        }
        try {
          return sendJson(res, 200, { ok: true, ...(await secretStatus()) });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- /gate -----------------------------------------------------------
      //
      // ★ 闸门不可用（没接上）时回 `{ set:false, unlocked:true }`：那台机器上
      //   私密日记本来就没有口令这层，界面不该显示一个点不动的解锁框。
      if (parts[0] === 'gate' && parts.length <= 2) {
        const gateReady = gate && typeof gate.peek === 'function';
        if (parts.length === 1) {
          if (method === 'GET') {
            if (!gateReady) return sendJson(res, 200, { ok: true, set: false, unlocked: true, available: false });
            try {
              return sendJson(res, 200, { ok: true, ...(await gate.peek()), available: true });
            } catch (error) {
              return fail(res, error);
            }
          }
          if (method === 'POST') {
            // 第一次设置口令。已经设过 ⇒ 409，界面必须走「先解锁」而不是静默覆盖
            // （静默覆盖会让「知道旧口令的人」被悄悄踢出去，用户以为是 App 抽风）。
            if (!gateReady || typeof gate.setup !== 'function') {
              return sendJson(res, 501, { ok: false, error: '口令闸门没有接上' });
            }
            if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
              return sendJson(res, 415, { ok: false, error: '需要 JSON body' });
            }
            let body;
            try { body = await readBody(req); } catch (error) { return fail(res, error); }
            try {
              const result = await gate.setup(body.passphrase);
              log('[日记] 私密日记已上锁（口令已设置）');
              return sendJson(res, 200, { ok: true, ...result });
            } catch (error) {
              if (error?.code === 'GATE_EXISTS') {
                return sendJson(res, 409, { ok: false, error: error.message, code: error.code });
              }
              return fail(res, error);
            }
          }
          return methodNotAllowed(res);
        }

        const action = parts[1];
        if (action === 'unlock') {
          if (method !== 'POST') return methodNotAllowed(res);
          if (!gateReady || typeof gate.unlock !== 'function') {
            return sendJson(res, 501, { ok: false, error: '口令闸门没有接上' });
          }
          if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            return sendJson(res, 415, { ok: false, error: '需要 JSON body' });
          }
          let body;
          try { body = await readBody(req); } catch (error) { return fail(res, error); }
          try {
            const ok = await gate.unlock(body.passphrase);
            if (!ok) {
              // 401 而不是 400：这是「你是谁没验证通过」，不是「请求格式不对」。
              return sendJson(res, 401, { ok: false, error: '口令不对', code: 'GATE_WRONG' });
            }
            return sendJson(res, 200, { ok: true, set: true, unlocked: true });
          } catch (error) {
            return fail(res, error);
          }
        }
        if (action === 'lock') {
          if (method !== 'POST') return methodNotAllowed(res);
          if (!gateReady || typeof gate.lock !== 'function') {
            return sendJson(res, 501, { ok: false, error: '口令闸门没有接上' });
          }
          gate.lock();
          return sendJson(res, 200, { ok: true, set: true, unlocked: false });
        }
        return sendJson(res, 404, { ok: false, error: `没有这条口令路由：${rest}` });
      }

      // ---- GET /export ------------------------------------------------------
      //
      // ★ 取消「移入 Obsidian」之后这是日记**唯一**的出口。它只读、只拼内存字符串，
      //   不往任何用户目录写文件 —— 落盘由浏览器下载完成（用户自己选位置）。
      // ★ 默认**不含**私密日记：导出写的是浏览器下载目录里的明文，那正是加密层
      //   要防的第一件事。要包含必须显式 `?private=1`，界面负责把后果说清楚。
      if (parts.length === 1 && parts[0] === 'export') {
        if (method !== 'GET') return methodNotAllowed(res);
        const includePrivate = url.searchParams.get('private') === '1';
        // ★ 锁着时连「导出」也不给：导出的落点是浏览器下载目录里的**明文**，
        //   那正是加密层要防的第一件事，而锁着的闸门不该被一个 GET 绕过。
        if (includePrivate && !gateAllow()) {
          return sendJson(res, 403, { ok: false, error: '私密日记还是锁着的，先解锁再导出', code: 'GATE_LOCKED' });
        }
        try {
          const payload = await exportAll({ includePrivate });
          log(`[日记] 导出 ${payload.total} 天${includePrivate ? '（含私密）' : ''}`);
          return sendJson(res, 200, { ok: true, ...payload });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- POST /reveal -----------------------------------------------------
      if (parts.length === 1 && parts[0] === 'reveal') {
        if (method !== 'POST') return methodNotAllowed(res);
        if (typeof reveal !== 'function') {
          return sendJson(res, 501, { ok: false, error: '打开文件夹没有接上' });
        }
        try {
          // ★ 把目录带回去：界面上要能显示「东西在哪」，而用户点这个按钮的时候
          //   往往正是第一次想确认这件事。只回 `{ok:true}` 就等于把路径藏起来了。
          const result = await reveal();
          return sendJson(res, 200, { ok: true, ...(result ?? {}) });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- GET /book/:bookId -----------------------------------------------
      //
      // 读后感工作台的主视图：「这本书我写过什么」。读后感不属于某一天，
      // 按日期翻是找不到它的 —— 所以按 `meta.book` 反查（存储仍是一天一个文件）。
      if (parts.length === 2 && parts[0] === 'book') {
        if (method !== 'GET') return methodNotAllowed(res);
        if (typeof byBook !== 'function') return sendJson(res, 501, { ok: false, error: '按书查读后感没有接上' });
        try {
          return sendJson(res, 200, { ok: true, ...(await byBook(segment(parts[1]))) });
        } catch (error) {
          return fail(res, error);
        }
      }

      // ---- /day/:date[/append] 与 /day/:date/entry/:index -------------------
      if (parts[0] === 'day' && parts.length >= 2) {
        const date = segment(parts[1]);
        if (!isValidDateKey(date)) {
          return sendJson(res, 400, { ok: false, error: `无效的日期：${date}`, code: 'BAD_DATE' });
        }

        // GET /day/:date
        if (parts.length === 2) {
          if (method !== 'GET') return methodNotAllowed(res);
          try {
            // `readFull` 给了就用它（合并公开 + 私密，每条带 `scope` / `index`）。
            const payload = typeof readFull === 'function' ? await readFull(date) : await read(date);
            // ★ `redact` 在锁着时把私密条目的 body 摘成空串 —— 正文根本不出宿主。
            return sendJson(res, 200, { ok: true, ...redact(payload) });
          } catch (error) {
            return fail(res, error);
          }
        }

        // POST /day/:date/append
        if (parts.length === 3 && parts[2] === 'append') {
          if (method !== 'POST') return methodNotAllowed(res);
          if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
            return sendJson(res, 415, { ok: false, error: '需要 JSON body' });
          }
          let body;
          try {
            body = await readBody(req);
          } catch (error) {
            return fail(res, error);
          }
          try {
            const result = await append({
              date,
              time: body.time,
              kind: body.kind,
              source: body.source,
              // `meta` / `vis` 由 store 再洗一遍（白名单）：路由层不猜、不校验语义，
              // 只负责把客户端说的原样递进去。
              meta: body.meta,
              vis: body.vis,
              body: body.body,
            });
            return sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            return fail(res, error);
          }
        }

        // PATCH / DELETE /day/:date/entry/:index?scope=private
        if (parts.length === 4 && parts[2] === 'entry') {
          const index = Number(segment(parts[3]));
          if (!Number.isInteger(index) || index < 0) {
            return sendJson(res, 400, { ok: false, error: '无效的条目序号' });
          }
          // ★ `scope` 必须显式说明动的是哪一半：两个文件各有自己的序号，
          //   只给一个数字就必然要靠「合并后的下标」反查，反查错一次就是改错 / 删错一条。
          const scope = url.searchParams.get('scope') === 'private' ? 'private' : 'public';
          // ★ 改写与删除都是**破坏性**动作，锁着时必须先解锁：否则拿到本机端口的人
          //   可以在没有口令的情况下一天一条地把私密日记改空、删空。
          if (scope === 'private' && !gateAllow()) {
            return sendJson(res, 403, { ok: false, error: '私密日记还是锁着的，解锁后才能改', code: 'GATE_LOCKED' });
          }

          // PATCH：改写这一条（正文 / 时间 / 类型 / 来源 / 元数据）
          if (method === 'PATCH') {
            if (typeof updateEntry !== 'function') {
              return sendJson(res, 501, { ok: false, error: '改写日记没有接上' });
            }
            if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
              return sendJson(res, 415, { ok: false, error: '需要 JSON body' });
            }
            let patchBody;
            try {
              patchBody = await readBody(req);
            } catch (error) {
              return fail(res, error);
            }
            try {
              const result = await updateEntry({
                date, index, scope,
                body: patchBody.body,
                time: patchBody.time,
                kind: patchBody.kind,
                source: patchBody.source,
                meta: patchBody.meta,
              });
              return sendJson(res, 200, { ok: true, ...result });
            } catch (error) {
              return fail(res, error);
            }
          }

          if (method !== 'DELETE') return methodNotAllowed(res);
          try {
            return sendJson(res, 200, { ok: true, ...(await removeEntry({ date, index, scope })) });
          } catch (error) {
            return fail(res, error);
          }
        }
      }

      return sendJson(res, 404, { ok: false, error: `没有这条日记路由：${rest}` });
    },
  };
}
