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
 * 删掉某一天的某一条。
 *
 * ★ `scope` 必须跟着走：公开与私密是**两个文件**，各有自己的序号。只传一个下标
 *   就等于让宿主去猜「他说的是哪一半」，猜错一次就是删掉另一条日记。
 */
export async function removeDiaryEntry(date, index, scope = 'public') {
  const query = scope === 'private' ? '?scope=private' : '';
  return await jsonRequest(`/day/${encodeURIComponent(date)}/entry/${index}${query}`, { method: 'DELETE' });
}

/** 标签索引（带次数与最后使用日期）。 */
export async function fetchDiaryTags() {
  return await jsonRequest('/tags');
}

/** 某一本书的全部读后感（跨天）。读后感工作台的主视图。 */
export async function fetchDiaryBook(bookId) {
  return await jsonRequest(`/book/${encodeURIComponent(bookId)}`);
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

/** 跨天搜。 */
export async function searchDiary(query, limit) {  const params = new URLSearchParams({ q: query });
  if (limit !== undefined) params.set('limit', String(limit));
  return await jsonRequest(`/search?${params.toString()}`);
}

/** 多少天、占多少字节、目录在哪。 */
export async function fetchDiaryStats() {
  return await jsonRequest('/stats');
}

/** 在系统文件管理器里打开日记目录。 */
export async function revealDiaryFolder() {
  return await jsonRequest('/reveal', { method: 'POST' });
}

/**
 * 全部日记（一次性出口）。
 *
 * ★ **默认不含私密日记**：导出写的是浏览器下载目录里的明文，那正好是加密层要防的
 *   第一件事。要含必须显式传 `includePrivate: true`，且界面负责把后果说清楚
 *   （明文会落到下载目录、不进废纸篓就一直在）。
 */
export async function fetchDiaryExport({ includePrivate = false } = {}) {
  const query = includePrivate ? '?private=1' : '';
  return await jsonRequest(`/export${query}`, {}, { timeoutMs: EXPORT_TIMEOUT_MS });
}

/**
 * 把「全部日记」拼成**一份** Markdown 交给浏览器下载。
 *
 * ★ 为什么是单文件而不是逐天各下一个：浏览器会**拦掉**连续多个自动下载
 *   （Chrome 对「一个动作触发多个下载」默认阻断，用户看到的只是「什么都没发生」）。
 * ★ 为什么原样保留每天的全文（含它自己的 frontmatter）：这样导出的东西是**可逆**的
 *   —— 每块前面有一行 `<!-- 2026-10-26.md -->` 说明它原来叫什么文件，用户按它
 *   切回去就能还原成一天一个 .md。顺手把 frontmatter 规范化掉就做不到这一点了。
 */
export function downloadDiaryBundle(files, today) {
  const parts = [
    '<!-- dsh-npie-reader 日记导出 -->',
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
  anchor.download = `日记-导出-${today}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器拿不到内容，延后一拍。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return files.length;
}
