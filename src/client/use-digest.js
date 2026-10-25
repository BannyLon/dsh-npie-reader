/**
 * 「本书解读」的状态机 —— 抽取 → 目录 → 逐章生成 → 取正文，一套实现。
 *
 * ★ 为什么要抽成 hook：PDF 与重排电子书的**只有第一步不同**
 *   （PDF 要渲染进程边读边 POST 页；电子书宿主一步解析到底），
 *   后面的「meta 轮询 / 勾选 / 生成 / 停止 / 展开一章要点」是同一件事。
 *   两处各写一遍的后果不是重复几行，而是**同一个字段在两本书上含义不同**
 *   （本项目反复踩过的「同一判据两处各写一遍」）。
 *
 * ★ 抽取那一步由调用方以 `work(options)` 传进来：
 *   - `onProgress({ done, total, phase })` 让调用方汇报自己的进度（PDF 有页数进度，
 *     电子书只有一步，报 `{ done: 0, total: 1, phase: 'extract' }`）；
 *   - 返回值需要 `{ chapters, mode }`（宿主两个路由都返回这个形状）。
 *
 * ★ 这个 hook **不碰页面/文档/渲染**：它只认 `book`（取 id 与标题）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchChapterDigest, fetchDigestStatus, postDigestGenerate, postDigestStop, resetDigest } from './library-api.js';
import { planDigestRun } from './book-digest.js';

/** 生成期间的轮询间隔。一章通常十几到几十秒，更密的轮询只换来「进度条更顺滑」。 */
const POLL_MS = 2500;

/**
 * 模型列表的**会话级缓存**。
 *
 * ★ 为什么缓存：宿主那个 `listAiModels` 是逐个 provider 去问的（每个 8 秒超时，
 *   可能真的发一次网络请求）。目录面板每打开一次就问一遍，等于每翻一次目录都要等一次网络。
 * ★ 为什么失败**不缓存**：读不到多半是某个 provider 的 key 没配好，用户修好之后
 *   应该能立刻重试成功；缓存失败会让它只能重启窗口，而界面上没有任何提示。
 */
let modelCatalogCache = null;

/** 取模型列表；成功结果缓存，失败结果下一次重试。**永不 reject**。 */
export function loadModelCatalog(api) {
  if (modelCatalogCache !== null) return Promise.resolve(modelCatalogCache);
  return api.listAiModels().then(
    (value) => { modelCatalogCache = value ?? { providers: [], current: null }; return modelCatalogCache; },
    (error) => ({ providers: [], current: null, error: String(error?.message ?? error) }),
  );
}

export function useBookDigest({ book, api, notify }) {
  const [meta, setMeta] = useState(null);
  const [outline, setOutline] = useState([]);
  /** 抽取任务：`{ running, done, total, phase, error }`。null = 没在跑。 */
  const [job, setJob] = useState(null);
  /**
   * 逐章生成中。★ **不是**客户端自己说了算：点「生成」时乐观置 true，但每一轮
   *   轮询都以宿主回的 `generating` 为准。否则关掉面板再打开会出现「宿主在跑、
   *   界面以为没跑」—— 进度条永远停在 0。
   */
  const [generating, setGenerating] = useState(false);
  /** 已取回的解读：`n → { status, digest?, error? }`。按需取，不预载全书。 */
  const [chapters, setChapters] = useState({});
  /** 当前展开要点的章号（0 = 都没展开）。同一时刻只展开一章 —— 浮层只有一张。 */
  const [expandedN, setExpandedN] = useState(0);
  /**
   * 勾选要解读的章号；**`null` = 还没动过手**，此时按「所有待生成的章」算。
   *
   * ★ 用 `null` 表示默认而不是在 effect 里初始化成一份数组：`meta` 是轮询刷新的，
   *   初始化式 effect 会在每次状态变化后把用户手动改过的勾选悄悄重置回全选。
   * ★ 一批生成结束时会显式置回 `null`：否则跑完之后那几章变成 `done`，而勾选里
   *   还留着它们，用户再点一次就会把刚生成的解读**重跑一遍**（再花一次钱）。
   */
  const [selectedN, setSelectedN] = useState(null);
  /** 这次用哪个模型（`null` = 设置还没读到；`''` = 跟随 Harness 默认模型）。 */
  const [model, setModel] = useState(null);
  const [modelCatalog, setModelCatalog] = useState(null);

  /** 抽取在跑的同步闸门：`job.running` 是 state，同一帧内两次点击都读到旧值。 */
  const running = useRef(false);

  // ---- 换书：读一次这本书的解读状态 --------------------------------------
  /**
   * ★ 读失败**不当错误报**：`meta: null` 就是「还没抽取」，而宿主没接上解读路由时
   *   也是同一句话。弹一条红色错误反而会让人以为书坏了。
   */
  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setOutline([]);
    setJob(null);
    setGenerating(false);
    setChapters({});
    setExpandedN(0);
    setSelectedN(null);
    running.current = false;
    (async () => {
      try {
        const body = await fetchDigestStatus(book.id);
        if (cancelled) return;
        setMeta(body.meta ?? null);
        setOutline(Array.isArray(body.outline) ? body.outline : []);
        // ★ 以宿主为准：换本书再换回来时，这本书可能正在后台生成。
        setGenerating(body.generating === true);
      } catch {
        // 见上：这不是错误。
      }
    })();
    return () => { cancelled = true; };
  }, [book.id]);

  // ---- 生成期间轮询 ------------------------------------------------------
  /**
   * ★ 轮询**只读 status**，不预载各章解读正文：那是几十 KB，而用户可能一章都没展开。
   */
  useEffect(() => {
    if (!generating) return undefined;
    let cancelled = false;
    const tick = async () => {
      const body = await fetchDigestStatus(book.id).catch(() => null);
      if (cancelled || body === null) return;
      setMeta(body.meta ?? null);
      if (Array.isArray(body.outline) && body.outline.length > 0) setOutline(body.outline);
      if (body.generating !== true) {
        setGenerating(false);
        setSelectedN(null);
        const list = Array.isArray(body.meta?.chapters) ? body.meta.chapters : [];
        const failed = list.filter(chapter => chapter.status === 'failed').length;
        notify?.(failed > 0
          ? `解读生成完了，${failed} 章失败（可以再点一次重试）`
          : '解读生成完了');
      }
    };
    const timer = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [generating, book.id, notify]);

  // ---- 「解读用哪个模型」这个设置：只在挂载时读一次 ----------------------
  /**
   * ★ 它是**全局设置**，与书无关。每次换书重读会让面板里刚选的模型被设置文件里
   *   的旧值覆盖回去（用户看到「我明明选了免费的，它自己跳回去了」）。
   */
  const settingsRead = useRef(false);
  useEffect(() => {
    if (settingsRead.current || typeof api?.getSettings !== 'function') return undefined;
    settingsRead.current = true;
    let cancelled = false;
    api.getSettings().then((body) => {
      if (!cancelled) setModel(body?.settings?.digestModel ?? '');
    }).catch(() => {
      // 读不到设置 ⇒ 按「跟随默认」处理（与宿主 `digestModel()` 的兜底同一个取值）。
      if (!cancelled) setModel('');
    });
    return () => { cancelled = true; };
  }, [api]);

  /** 面板打开时才去读模型列表 —— 绝大多数用户打开阅读器是为了看书，不是解读。 */
  const needModels = useCallback(() => {
    if (modelCatalog !== null || typeof api?.listAiModels !== 'function') return;
    loadModelCatalog(api).then(setModelCatalog);
  }, [modelCatalog, api]);

  // ---- 抽取 --------------------------------------------------------------
  /**
   * 跑一遍抽取 + 分段。
   *
   * @param work - `async ({ onProgress }) => result`，`result` 含 `{ chapters, mode, ... }`。
   * @returns 宿主那一步的原始返回（调用方要自己写 `scanned` 标记之类）；失败返回 null。
   *
   * ★ 抽取**不花钱**（纯本地 CPU），所以点一下就开始，不需要预检确认。花钱的是
   *   「逐章生成」，那一步才需要把调用次数摆给用户看。
   */
  const runDigest = useCallback(async (work) => {
    if (running.current) return null;
    running.current = true;
    setJob({ running: true, done: 0, total: 1, phase: 'extract' });
    try {
      const result = await work({
        onProgress: ({ done = 0, total = 1, phase = 'extract' } = {}) => {
          setJob({ running: true, done, total, phase });
        },
      });
      setJob({ running: true, done: 1, total: 1, phase: 'segment' });
      const after = await fetchDigestStatus(book.id).catch(() => null);
      setMeta(after?.meta ?? null);
      setOutline(Array.isArray(after?.outline) ? after.outline : []);
      setJob(null);
      return result ?? {};
    } catch (error) {
      setJob({ running: false, error: error?.message ?? '抽取失败' });
      return null;
    } finally {
      running.current = false;
    }
  }, [book.id]);

  /** 「重新抽取」：书换过文件、或上次抽坏了。先删这本书的产物再走一遍。 */
  const rebuildDigest = useCallback(async (work) => {
    if (running.current) return null;
    try {
      await resetDigest(book.id);
    } catch {
      // 删不掉也继续：重抽会覆盖同名章节文件与 outline。
    }
    setOutline([]);
    setMeta(null);
    return await runDigest(work);
  }, [book.id, runDigest]);

  // ---- 勾选 --------------------------------------------------------------
  const plan = planDigestRun(meta);
  const selected = selectedN ?? plan.todoN;

  /**
   * 勾 / 取消勾某一章。以**当前渲染出来的 `selected`** 为基准做加减，而不是在
   * updater 里再算一遍默认集合 —— 两处各算一遍会出现「勾上一个，另一个跟着跳」。
   */
  const toggleSelect = useCallback((n) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n); else next.add(n);
    setSelectedN([...next]);
  }, [selected]);

  const selectAll = useCallback(() => setSelectedN([...plan.todoN]), [plan]);
  const selectNone = useCallback(() => setSelectedN([]), []);

  /**
   * 换模型。写回设置（`digestModel`），下次打开面板还是它。
   * ★ 写盘失败**不打断**：这一次生成用的仍是刚选的模型（随请求发出去）。
   */
  const changeModel = useCallback((value) => {
    setModel(value);
    api?.saveSettings?.({ digestModel: value }).catch(() => {});
  }, [api]);

  // ---- 生成 / 停止 -------------------------------------------------------
  /**
   * ★ 把**勾选的章**和**这一次的模型**一起发过去：不给的话宿主会按「所有没解读的章」
   *   跑整本，而且会用它自己那份设置 —— 用户在面板里换的模型就被静默忽略了。
   * ★ `model === null`（设置还没读到）时**不传** `model`：传 `''` 会把「还没读到」
   *   变成「明确跟随默认」，静默丢掉用户设过的模型。
   */
  const startGenerate = useCallback(async () => {
    if (selected.length === 0) return;
    try {
      await postDigestGenerate(book.id, {
        bookTitle: book.title,
        chapters: [...selected],
        ...(model === null ? {} : { model }),
      });
      setGenerating(true);
    } catch (error) {
      notify?.(error?.message ?? '没能开始生成解读');
    }
  }, [book.id, book.title, notify, selected, model]);

  const stopGenerate = useCallback(async () => {
    try {
      await postDigestStop(book.id);
    } catch {
      // 停止请求失败也照样停轮询：宿主最多把当前这一章跑完。
    }
    setGenerating(false);
    notify?.('已停止生成；已经生成好的章节保留');
  }, [book.id, notify]);

  /**
   * 展开 / 收起某一章的要点。第一次展开才去取正文。
   * ★ 只负责展开，从不改变当前页（跳页是另一个热区）。
   */
  const toggleChapter = useCallback(async (n) => {
    if (expandedN === n) {
      setExpandedN(0);
      return;
    }
    setExpandedN(n);
    if (chapters[n]?.status === 'ready') return;
    setChapters(prev => ({ ...prev, [n]: { status: 'loading' } }));
    try {
      const body = await fetchChapterDigest(book.id, n);
      setChapters(prev => ({ ...prev, [n]: { status: 'ready', digest: body.digest } }));
    } catch (error) {
      setChapters(prev => ({
        ...prev,
        [n]: { status: 'error', error: error?.message ?? '读不出这一章的解读' },
      }));
    }
  }, [book.id, expandedN, chapters]);

  const closeCard = useCallback(() => setExpandedN(0), []);

  return {
    meta, outline, job, generating, chapters, expandedN, model, modelCatalog,
    plan, selected,
    runDigest, rebuildDigest, needModels,
    toggleSelect, selectAll, selectNone, changeModel,
    startGenerate, stopGenerate, toggleChapter, closeCard,
  };
}
