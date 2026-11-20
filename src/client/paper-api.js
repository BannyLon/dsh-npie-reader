/**
 * 论文库的浏览器侧客户端（走 HTTP，与 `library-api.js` 同一条通道）。
 *
 * ★ 为什么不用 Remote/Gateway：论文 PDF 要交给 pdf.js，而 pdf.js 只会说 HTTP
 *   （Range / 206 / Content-Length）—— 那条链路已经是书架的既成事实，论文跟着走，
 *   就不再需要第二套取字节机制。
 * ★ 路径全部用**相对路径**：renderer 的原点是自定义协议，相对路径会被主进程转发
 *   给宿主并补上 Host cookie，所以这里不需要知道端口。
 */
import { PAPER_API_PREFIX } from '../library.js';

/** 元数据类请求的超时。arXiv 冷启动偶尔 3–5 秒，20 秒足够。 */
const TIMEOUT_MS = 20_000;
/** 导入 / 下载全文：要真的去 arXiv 拉一份几 MB 的 PDF。 */
const DOWNLOAD_TIMEOUT_MS = 180_000;
/** 上传本地 PDF：几十 MB 走本机 HTTP，读盘 + 写盘。 */
const UPLOAD_TIMEOUT_MS = 120_000;

async function jsonRequest(path, init = {}, { timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${PAPER_API_PREFIX}${path}`, {
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
      // 宿主回的中文文案是给用户看的（「这篇没有可下载的开放全文…」），优先用它。
      throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）`);
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function jsonPost(path, payload, options) {
  return jsonRequest(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }, options);
}

/**
 * 论文列表 + 标签云 + 计数。
 *
 * @param {{ trash?: boolean }} [options] `trash: true` 时额外返回回收站里的条目。
 * @returns {Promise<{ papers: object[], trashed?: object[], tags: {name:string,count:number}[], stats: object }>}
 */
export async function fetchPapers({ trash = false } = {}) {
  return await jsonRequest(`/papers${trash ? '?trash=1' : ''}`);
}

/**
 * 查 arXiv（**不落库**）。
 *
 * ★ 与「导入」分开：用户搜十次只想留下一条，搜到就入库会让论文库变成垃圾场。
 */
export async function searchPapers(query, { limit = 20 } = {}) {
  const body = await jsonPost('/papers/search', { q: query, limit });
  return Array.isArray(body.items) ? body.items : [];
}

/**
 * 按 arXiv 编号 / DOI / 链接 / 标题导入。
 *
 * @returns {Promise<{ paper: object, created: boolean, downloaded: boolean, downloadError?: string }>}
 *   `downloadError` 是**非致命**的：元数据已经入库，只是全文没拿到（付费墙内）。
 *   界面据此显示「已收录，全文要你自己下载」—— 当错误处理会让人以为整个导入失败了。
 */
export async function importPaper(input, { download = true } = {}) {
  return await jsonPost('/papers/import', { input, download }, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
}

/** 上传本地 PDF（`dataUrl` 是 `data:application/pdf;base64,…`）。 */
export async function uploadPaper(name, dataUrl) {
  return await jsonPost('/papers/upload', { name, data: dataUrl }, { timeoutMs: UPLOAD_TIMEOUT_MS });
}

/** 给已入库的论文补下载全文。 */
export async function downloadPaperPdf(id) {
  return await jsonPost(`/papers/${encodeURIComponent(id)}/download`, {}, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
}

/** 改标签 / 状态 / 阅读进度。 */
export async function patchPaper(id, patch) {
  return await jsonPost(`/papers/${encodeURIComponent(id)}/patch`, { patch });
}

/**
 * 一条论文的 BibTeX（`GET /papers/:id/bibtex`）。
 *
 * ★ 走 GET 而不是让客户端自己拼：拼接规则（双层花括号、转义、引用键）只有一份，
 *   在 `src/paper-bibtex.js`。客户端再写一遍就一定与它漂开。
 */
export async function fetchPaperBibtex(id) {
  return await jsonRequest(`/papers/${encodeURIComponent(id)}/bibtex`);
}

/**
 * 补全元数据：去 Crossref / arXiv 再查一次，**只填空着的字段**。
 *
 * @returns {Promise<{ paper: object, changed: string[] }>} `changed` 为空表示这次
 *   没查到新东西（付费墙内的 DOI、源临时抽风都长这样）—— 不是错误。
 */
export async function enrichPaper(id) {
  return await jsonPost(`/papers/${encodeURIComponent(id)}/enrich`, {}, { timeoutMs: 40_000 });
}

/** 移入回收站（可撤销）。 */
export async function trashPaper(id) {
  return await jsonPost(`/papers/${encodeURIComponent(id)}/trash`, {});
}

/** 从回收站恢复。 */
export async function restorePaper(id) {
  return await jsonPost(`/papers/${encodeURIComponent(id)}/restore`, {});
}

/** 彻底删除（宿主只允许删回收站里的）。 */
export async function deletePaper(id) {
  return await jsonPost(`/papers/${encodeURIComponent(id)}/delete`, {});
}
