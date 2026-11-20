/**
 * 论文库的 HTTP 面（`PAPER_API_PREFIX`）。
 *
 * 设计上刻意**只有一层**：路由只做「校验入参 → 调 store/source → 回 JSON」，
 * 不持有任何判定逻辑。理由与 `library-routes.js` 那段一样 —— 判定写在两处
 * （路由一份、store 一份）时，漂移的那一份会静默放过不该放行的请求。
 *
 * ★ 每条路由都过 `isTrustedLocalRequest`：宿主派发插件路由**不经过**它自己的
 *   鉴权拦截器（先精确路由、再鉴权），所以这里漏掉就等于把「往用户数据目录写
 *   PDF」「删用户的论文」敞开给任何能访问本机端口的东西。
 *
 * ★ 读 PDF 字节**不在这条前缀下**：论文 PDF 落盘之后就是一个普通的本地 PDF 书条目，
 *   客户端照旧走 `/api/dsh-npie-reader/library/book/:id/raw`（Range、分片、OCR 全复用）。
 *
 * 路由一览：
 *
 *   GET  /papers                       列表 + 标签 + 计数
 *   POST /papers/search                按关键词查 arXiv（不落库）
 *   POST /papers/import                按 arXiv id / DOI / 链接导入（可顺带下载 PDF）
 *   POST /papers/upload                上传本地 PDF（base64）
 *   GET  /papers/:id/bibtex            BibTeX（纯读）
 *   POST /papers/:id/download          给已入库的论文补下载全文
 *   POST /papers/:id/enrich            去源上补全空着的元数据字段
 *   POST /papers/:id/patch             改标签 / 状态 / 进度
 *   POST /papers/:id/trash             移入回收站
 *   POST /papers/:id/restore           从回收站恢复
 *   POST /papers/:id/delete            彻底删除（只允许删回收站里的）
 */
import { PAPER_API_PREFIX, isPaperId } from '../library.js';
import { bibtexFor, citeKeyFor } from '../paper-bibtex.js';
import { isTrustedLocalRequest } from './trust.js';
import {
  arxivById, downloadPdf, enrichPaperFields, normalizeArxivId, pdfCandidate, resolvePaperInput, searchArxiv,
} from './paper-source.js';

/** 普通请求体上限。 */
const JSON_BODY_LIMIT = 256 * 1024;
/**
 * 上传 PDF 的上限（base64 之后）。
 *
 * 原文 120 MB → base64 约 160 MB。这里是**解码前**的字节上限，所以要留出 4/3 的余量。
 * 不给到无限：`readBody` 是把整个 body 收进内存的，一个人误拖一个 2 GB 的 PDF，
 * 进程就直接 OOM 了 —— 而症状是「整个界面白屏」，不是一句「文件太大」。
 */
const UPLOAD_BODY_LIMIT = 168 * 1024 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

async function readBody(req, limit = JSON_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
  return parsed;
}

/** 条目对外形态：`file` 只暴露字节数与文件名，不暴露绝对路径。 */
function publicPaper(paper) {
  return {
    id: paper.id,
    key: paper.key,
    source: paper.source,
    title: paper.title,
    authors: paper.authors,
    abstract: paper.abstract,
    year: paper.year,
    venue: paper.venue,
    doi: paper.doi,
    arxivId: paper.arxivId,
    categories: paper.categories,
    url: paper.url,
    pdfUrl: paper.pdfUrl,
    tags: paper.tags,
    status: paper.status,
    lastPage: paper.lastPage,
    pages: paper.pages,
    note: paper.note,
    addedAt: paper.addedAt,
    updatedAt: paper.updatedAt,
    trashedAt: paper.trashedAt,
    // 有这个对象 = 全文已经在本地，可以点开就读。
    file: paper.file === null ? null : { name: paper.file.name, bytes: paper.file.bytes },
  };
}

/**
 * 造论文路由。
 *
 * @param {object} handlers
 * @param {import('./paper-store.js').PaperStore} handlers.store
 * @param {(message: string) => void} [handlers.log]
 */
export function makePaperRoutes({ store, log = () => {} }) {
  async function handle(req, res) {
    if (!isTrustedLocalRequest(req)) return fail(res, 403, 'forbidden');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rest = url.pathname.slice(PAPER_API_PREFIX.length).replace(/^\/+/, '');
    const segments = rest === '' ? [] : rest.split('/');
    const method = String(req.method ?? 'GET').toUpperCase();
    await store.ready;

    // ---- GET /papers ----------------------------------------------------
    if (segments.length === 1 && segments[0] === 'papers' && method === 'GET') {
      const includeTrashed = url.searchParams.get('trash') === '1';
      const papers = store.list({ includeTrashed: false }).map(publicPaper);
      const trashed = includeTrashed
        ? store.list({ includeTrashed: true }).filter((paper) => paper.trashedAt > 0).map(publicPaper)
        : undefined;
      return sendJson(res, 200, {
        ok: true,
        papers,
        ...(trashed === undefined ? {} : { trashed }),
        tags: store.tags(),
        stats: {
          total: papers.length,
          withFile: papers.filter((paper) => paper.file !== null).length,
          trashed: store.list({ includeTrashed: true }).length - papers.length,
        },
      });
    }

    // ---- POST /papers/search -------------------------------------------
    if (segments.length === 2 && segments[0] === 'papers' && segments[1] === 'search' && method === 'POST') {
      const body = await readBody(req);
      const query = String(body.q ?? '').trim();
      if (query === '') return fail(res, 400, '搜索词不能为空');
      // 粘贴 arXiv 编号/链接时直接精确命中，比全文检索可靠得多。
      const arxivId = normalizeArxivId(query);
      if (arxivId !== '') {
        try {
          return sendJson(res, 200, { ok: true, items: [await arxivById(arxivId)] });
        } catch { /* 认出来了但 arXiv 没有 ⇒ 继续当关键词搜 */ }
      }
      const items = await searchArxiv(query, { limit: Math.min(30, Number(body.limit) || 20) });
      return sendJson(res, 200, { ok: true, items });
    }

    // ---- POST /papers/import -------------------------------------------
    if (segments.length === 2 && segments[0] === 'papers' && segments[1] === 'import' && method === 'POST') {
      const body = await readBody(req);
      const paper = await resolvePaperInput(body.input ?? body.arxivId ?? body.doi ?? body.url);
      const { paper: stored, created } = await store.upsert(paper);
      let downloadError = '';
      let downloaded = false;
      // `download !== false`：默认**立刻下载**。只存元数据的论文点开是一片空白，
      // 用户还得再按一次「补下载」—— 那一步没有任何决策价值。
      if (body.download !== false && stored.file === null) {
        const target = pdfCandidate(stored);
        if (target === '') {
          downloadError = '这篇没有可下载的开放全文（出版社付费墙内），可以自己下载后上传';
        } else {
          try {
            const buffer = await downloadPdf(target);
            const next = await store.putPdf(stored.id, buffer, { name: `${stored.arxivId || stored.id}.pdf` });
            downloaded = true;
            return sendJson(res, 200, { ok: true, paper: publicPaper(next), created, downloaded: true });
          } catch (error) {
            downloadError = error?.message ?? String(error);
          }
        }
      }
      return sendJson(res, 200, {
        ok: true,
        paper: publicPaper(store.get(stored.id) ?? stored),
        created,
        downloaded,
        ...(downloadError === '' ? {} : { downloadError }),
      });
    }

    // ---- POST /papers/upload -------------------------------------------
    if (segments.length === 2 && segments[0] === 'papers' && segments[1] === 'upload' && method === 'POST') {
      const body = await readBody(req, UPLOAD_BODY_LIMIT);
      const name = String(body.name ?? '').trim() || '未命名.pdf';
      const data = String(body.data ?? '');
      if (data === '') return fail(res, 400, '没有收到文件内容');
      const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
      let buffer;
      try {
        buffer = Buffer.from(base64, 'base64');
      } catch {
        return fail(res, 400, '文件内容不是合法的 base64');
      }
      if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return fail(res, 400, '这不是 PDF 文件');
      }
      const { paper } = await store.upsert({
        // 上传的论文只能靠「文件名 + 字节数」认身份：同一份文件重传要落到同一条上，
        // 不同文件同名也不会互相覆盖（字节数一变 key 就变）。
        key: `upload:${name}:${buffer.length}`,
        source: 'upload',
        title: name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' '),
        file: null,
      });
      const next = await store.putPdf(paper.id, buffer, { name });
      return sendJson(res, 200, { ok: true, paper: publicPaper(next), created: true });
    }

    // ---- POST /papers/:id/* --------------------------------------------
    if (segments[0] === 'papers' && isPaperId(segments[1])) {
      const id = segments[1];
      const action = segments[2] ?? '';
      if (store.get(id) === undefined) return fail(res, 404, `没有这篇论文：${id}`);

      /**
       * BibTeX 用 **GET**：它是一次纯读，而浏览器/打开链接那一侧只会发 GET。
       * ★ 放在 `method !== 'POST'` 那道闸之前 —— 放后面就永远回 405。
       * ★ 不写文件、不落盘：复制走剪贴板，导出整库由客户端把多条拼起来即可
       *   （`bibtexFile()` 同一份实现），少一条「文件写到哪里去了」的疑问。
       */
      if (action === 'bibtex') {
        // ★ 非 GET 要回 405，不能落到下面「未知的论文操作」那个 404 —— 那会让
        //   「方法用错了」看起来像「没有这个功能」。
        if (method !== 'GET') return fail(res, 405, 'BibTeX 只支持 GET');
        const paper = store.get(id);
        const text = bibtexFor(paper);
        return sendJson(res, 200, { ok: true, key: citeKeyFor(paper), text });
      }

      if (method !== 'POST') return fail(res, 405, '只支持 POST');

      /**
       * 补全元数据（0.69.0）：去 Crossref / arXiv 再查一次，**只填空着的字段**。
       * 查不到就回 200 + `changed: []` —— 「这次没查到新东西」不是错误。
       */
      if (action === 'enrich') {
        const paper = store.get(id);
        const { patch, changed } = await enrichPaperFields(paper);
        if (changed.length === 0) return sendJson(res, 200, { ok: true, paper: publicPaper(paper), changed });
        const next = await store.patch(id, patch);
        return sendJson(res, 200, { ok: true, paper: publicPaper(next), changed });
      }

      if (action === 'download') {
        const paper = store.get(id);
        const target = pdfCandidate(paper);
        if (target === '') return fail(res, 400, '这篇没有已知的开放全文地址（付费墙内），请自己下载后上传');
        try {
          const buffer = await downloadPdf(target);
          const next = await store.putPdf(id, buffer, { name: `${paper.arxivId || id}.pdf` });
          return sendJson(res, 200, { ok: true, paper: publicPaper(next) });
        } catch (error) {
          return fail(res, 502, error?.message ?? String(error));
        }
      }

      if (action === 'patch') {
        const body = await readBody(req);
        const next = await store.patch(id, body.patch ?? body);
        return sendJson(res, 200, { ok: true, paper: publicPaper(next) });
      }

      if (action === 'trash') {
        const next = await store.trash(id);
        return sendJson(res, 200, { ok: true, paper: publicPaper(next) });
      }

      if (action === 'restore') {
        const next = await store.restore(id);
        return sendJson(res, 200, { ok: true, paper: publicPaper(next) });
      }

      if (action === 'delete') {
        await store.remove(id);
        return sendJson(res, 200, { ok: true });
      }

      return fail(res, 404, `未知的论文操作：${action}`);
    }

    return fail(res, 404, 'not found');
  }

  return {
    kind: 'prefix',
    path: PAPER_API_PREFIX,
    handler: async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        // ★ 这里必须兜住：路由里任何一处抛出去，宿主那条 handler 就整体挂掉，
        //   连带把同一个端口上其它路由的响应打歪。错误文案直接给用户看，
        //   所以用 `error.message`（store/source 里写的都是人话）。
        const message = error?.message ?? String(error);
        log(`[论文] ${message}`);
        if (!res.headersSent) return fail(res, 400, message);
      }
    },
  };
}

export { PAPER_API_PREFIX, publicPaper };
