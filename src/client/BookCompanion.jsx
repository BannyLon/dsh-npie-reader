/**
 * 电子书的 AI 伴读：**Harness 自己的对话** + 「当前这一页」的阅读上下文。
 *
 * 四个刻意的设计：
 *
 * 1. **不自己造对话界面**。这里渲染的是 Harness 的原生对话（`renderSlot`
 *    + `SessionProvider`），所以模型选择、工具调用、审批、上下文长度提示
 *    全部跟着 Harness 走 —— 自己写一套的话，用户在这个框里能做的事会比在
 *    主对话里少一截，而且每升级一次宿主就要补一次。
 * 2. **上下文是「当前这一页」，且会跟着翻页走**。绑定落在宿主那一个
 *    `companionContexts[sessionId]` 上（与文章伴读同一个落点），所以注入通道
 *    完全复用，不需要第二套 systemPrompt 贡献点。
 * 3. **上下文没绑上之前，快捷提问禁用、原生输入框 `inert`**。否则用户在这一
 *    瞬间发出去的消息会**没有**页面上下文，而界面上完全看不出来 —— 模型会
 *    凭书名和页码自信地讲起「这一页大概在说什么」。这个坑文章伴读那边已经踩过
 *    一次（`AskArticle` 的 `card.inert`），这里照同一条纪律来。
 * 4. **样式与文章伴读同款**（2026-10-09 用户要求）：空态开场（书本插画 +
 *    「与这本书对坐片刻」）与输入框上方的快捷提示词条，都照 `AskArticle`
 *    的方式挂在宿主对话的锚点上。锚点选择靠 MutationObserver 而不是
 *    getElementsByClassName 一锤子买卖 —— 宿主的对话是异步挂载的。
 *
 * ★ 扫描版没有文本层：这时**如实说**「这一页看不到文字」，不静默降级。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.jsx';
import { readQuickPrompts } from './quick-prompts.js';

export function BookCompanion({
  api, context, onClose, onManagePrompts, SessionProvider, renderSlot,
  onOcr, ocrNeeded = false, ocrUsed = false, ocrBusy = false, ocrError = '',
}) {
  const [workspaceId, setWorkspaceId] = useState(() => api.defaultChatWorkspace?.());
  const [chat, setChat] = useState(null);
  const [connectError, setConnectError] = useState('');
  const [bindError, setBindError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(true);
  const [attached, setAttached] = useState('');
  const [sending, setSending] = useState(false);
  /** 「重试同步」用的计数器：绑定 effect 依赖它，否则点重试时依赖没变、effect 不重跑。 */
  const [bindAttempt, setBindAttempt] = useState(0);
  const [prompts, setPrompts] = useState(() => readQuickPrompts('book'));
  const [promptMount, setPromptMount] = useState(null);
  const [emptyConversation, setEmptyConversation] = useState(false);
  const chatRoot = useRef(null);
  const owned = useRef(null);
  const generation = useRef(0);
  const started = useRef(false);
  const sendingRef = useRef(false);
  /**
   * 绑定请求**串行化**。
   *
   * ★ 翻页快时会有两个绑定同时在飞。并发发出的两个请求**完成顺序不定**，
   *   后完成的那个才是宿主上留下来的上下文 —— 于是快速翻三页之后，模型看到的
   *   可能是中间那一页。串行之后「最后一次调用」就是最终值，与用户看到的一致。
   */
  const bindQueue = useRef(Promise.resolve());

  /**
   * 绑定键：书 + 页码 + 有没有文字 + **划的那一句**。
   *
   * ★ `quote` 必须进键：用户划了一句再点「问伴读」，模型看到的上下文就该换 ——
   *   不进键的话 `synced` 会一直为真，那句永远传不上去，模型只能看到整页文字，
   *   回答「这句话什么意思」时全靠自己猜是哪句。
   * ★ 键里放**原文**而不是长度：两次划选的句子长度相同是常事（尤其同一行里换一段），
   *   只比长度会让第二次划选**完全不触发重绑**，模型看到的还是上一句 —— 而界面上
   *   一点异常都没有。键只活在内存里，放全文不占存储。
   */
  const contextKey = `${context.bookId}|${context.page}|${context.loaded ? '1' : '0'}|${context.quote ?? ''}`;
  const synced = attached === contextKey;

  // 默认工作区可能比插件启动得晚（宿主还在挂载工作区清单）。
  useEffect(() => {
    if (workspaceId) return undefined;
    return api.watchChatWorkspaces?.(() => setWorkspaceId(api.defaultChatWorkspace?.()));
  }, [api, workspaceId]);

  // 卸载时释放会话引用；`generation` 自增让在飞的异步结果不再写状态。
  useEffect(() => () => { generation.current += 1; owned.current?.release(); }, []);

  useEffect(() => { setActionError(''); }, [contextKey]);

  // 设置页改了提示词要立刻反映到这里（与文章伴读听同一个事件，各读各的 storage）。
  useEffect(() => {
    const reload = () => setPrompts(readQuickPrompts('book'));
    window.addEventListener('npr-prompts-changed', reload);
    return () => window.removeEventListener('npr-prompts-changed', reload);
  }, []);

  /**
   * 往宿主对话里找两个锚点：输入框座位（挂快捷提示词条）与空态阶段（挂开场页）。
   * 与 `AskArticle` 同一套观察方式 —— 宿主对话异步挂载，一次性查询会扑空。
   */
  useEffect(() => {
    if (!chat || !SessionProvider) return undefined;
    const root = chatRoot.current;
    if (!root) return undefined;
    const mount = document.createElement('div');
    mount.className = 'npr-companion-prompt-anchor';
    let placed = false;
    const place = () => {
      const seat = root.querySelector('[data-composer-seat]');
      if (seat?.parentNode) {
        if (mount.nextSibling !== seat) seat.parentNode.insertBefore(mount, seat);
        if (!placed) { placed = true; setPromptMount(mount); }
      }
      setEmptyConversation(root.querySelector('[data-content-phase]')?.getAttribute('data-content-phase') === 'hero');
    };
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-content-phase'] });
    place();
    return () => { observer.disconnect(); mount.remove(); setPromptMount(null); setEmptyConversation(false); };
  }, [chat, SessionProvider]);

  /**
   * 打开（或复用）一个 Harness 会话。
   *
   * 复用键是 `工作区 + 书`：同一本书的伴读应当接上上次的对话（读一本书是一个
   * 连续的过程），而换书必须换会话 —— 否则上一本书的讨论会留在上下文里。
   * 存的 sessionId 失效时（用户删了那个会话）回落到新建，并且**清掉那条记录**，
   * 否则每次打开都要多失败一次。
   */
  async function start(fresh = false) {
    if (!workspaceId) return;
    const current = ++generation.current;
    setBusy(true);
    setConnectError('');
    setBindError('');
    setActionError('');
    const storageKey = `npr.bookChat.${workspaceId}.${context.bookId}`;
    let acquired;
    try {
      const saved = fresh ? null : globalThis.localStorage?.getItem(storageKey);
      try {
        acquired = await api.openChat({ workspaceId, sessionId: saved || undefined });
      } catch (cause) {
        if (!saved) throw cause;
        globalThis.localStorage?.removeItem(storageKey);
        acquired = await api.openChat({ workspaceId });
      }
      if (current !== generation.current) { acquired.release(); return; }
      owned.current?.release();
      owned.current = acquired;
      // `attached` 清空 ⇒ 下面那个绑定 effect 会对新会话重绑一次当前页。
      setAttached('');
      setChat(acquired);
      globalThis.localStorage?.setItem(storageKey, acquired.sessionId);
      acquired = null;
    } catch (cause) {
      acquired?.release();
      setConnectError(cause?.message ?? String(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!workspaceId || started.current) return;
    started.current = true;
    void start();
    // 只在拿到工作区之后启动一次；上下文变化由下面的绑定 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // 上下文绑定：翻页、换书、换会话、点「重试同步」都会走到这里。
  useEffect(() => {
    if (!chat || !context.loaded || synced) return undefined;
    let stale = false;
    setBindError('');
    const pending = bindQueue.current.catch(() => {}).then(() => api.setBookContext({
      sessionId: chat.sessionId,
      bookId: context.bookId,
      title: context.title,
      page: context.page,
      pages: context.pages,
      text: context.text,
      // ★ 必须真的发出去：只让它进 `contextKey` 的话，「问伴读」触发的是一次
      //   **内容完全相同**的重绑 —— 界面上按钮点了、上下文也「同步了」，模型却
      //   从没收到那一句，回答自然答非所问。
      quote: context.quote ?? '',
    }));
    bindQueue.current = pending;
    pending
      .then(() => { if (!stale) setAttached(contextKey); })
      .catch((cause) => { if (!stale) setBindError(cause?.message ?? String(cause)); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, contextKey, context.loaded, synced, bindAttempt]);

  /**
   * 上下文没同步好之前，原生对话整块 `inert`。
   *
   * ★ 为什么是 `inert` 而不是只禁用按钮：用户是**在 Harness 的输入框里**打字的，
   *   我们拦不到那次提交。只有让整块子树不可交互，才能保证「发出去了」⇒「上下文在」。
   *   `inert` 由 ref 直接设，不走 React prop：React 18 对布尔 `inert` 的处理
   *   与 19 不同，写成 prop 会在升级时静默失效（症状正是「守卫看着在，其实没生效」）。
   */
  useEffect(() => {
    const root = chatRoot.current;
    if (!root) return undefined;
    root.inert = !synced;
    return () => { root.inert = false; };
  }, [synced]);

  async function send(item) {
    if (sendingRef.current || !chat || !synced) return;
    sendingRef.current = true;
    setSending(true);
    setActionError('');
    try {
      await chat.sendPrompt(item.body);
    } catch (cause) {
      const message = cause?.message ?? String(cause);
      // 「已有草稿」是用户自己没清空输入框，不是错误 —— 换成能照做的说法。
      setActionError(message.includes('已有草稿') ? '输入框里还有草稿：先发送或清空，再用快捷提问。' : `快捷提问没能发出去：${message}`);
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }

  const detail = context.loaded
    ? (context.text === ''
      ? '这一页没有文字层（扫描版或纯图片页），伴读只看到书名与页码'
      : (ocrUsed
        // ★ 必须与「文字层」分开说：OCR 一定有错字，而错字会直接变成 AI 引用的
        //   错原文。用户有权知道自己看的是哪一种。
        ? '已带上这一页的文字（本机识别，个别字可能不准）'
        : ((context.quote ?? '') === '' ? '已带上这一页的文字' : '已带上这一页的文字与划选的那一段')))
    : '正在读取这一页的文字…';
  /** 扫描页没有文字，「解释这一页」无从解释 —— 与旧版顶部 chips 同一条禁用判据。 */
  const pageReadable = context.loaded && context.text !== '';

  return (
    <aside className="npr-companion npr-book-companion" aria-label="AI 伴读">
      <header className="npr-companion-header">
        <Icon name="wand-sparkles" size={14} />
        <strong>AI 伴读</strong>
        <button type="button" className="npr-icon" title="新建伴读对话" aria-label="新建伴读对话"
          disabled={busy || !workspaceId} onClick={() => void start(true)}><Icon name="plus" /></button>
        <button type="button" className="npr-icon" title="收起伴读" aria-label="收起伴读" onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className="npr-companion-context">
        <strong title={context.title}>{context.title}</strong>
        <small>第 {context.page} 页{context.pages > 0 ? ` / 共 ${context.pages} 页` : ''} · {detail}</small>
      </div>
      {/**
        * 扫描页的出口：本地 OCR。
        *
        * ★ 只在这一页**确实没有文字**（`ocrNeeded`）时才出现。文字层有字时给一个
        *   「识别这一页」等于让用户拿一个更差的结果去换更好的 —— 那只会让人误点。
        * ★ 文案里写「本地、约 1 秒」：用户对 OCR 的印象是「又慢又要钱」，
        *   不写清楚他不会点。实测 0.6–0.8 秒/页，冷启动第一次会久一些。
        * ★ 失败要显示在这里而不是一闪而过的 toast：识别失败时用户正盯着这一块，
        *   而错误信息（比如「没认出字，可能是纯图片页」）恰恰决定他下一步怎么做。
        */}
      {ocrNeeded && typeof onOcr === 'function' && (
        <div className="npr-companion-ocr">
          <button type="button" className="npr-companion-ocr-btn" disabled={ocrBusy}
            onClick={() => void onOcr()}>
            <Icon name="file-text" size={13} />
            {ocrBusy ? '正在识别这一页…' : '识别这一页的文字'}
          </button>
          <small>{ocrBusy ? '本机识别，不联网、不花钱' : '本机识别，约 1 秒，不联网'}</small>
          {ocrError !== '' && <p className="npr-companion-ocr-error" role="alert">{ocrError}</p>}
        </div>
      )}
      {connectError !== '' && (
        <div className="npr-companion-error" role="alert">
          <strong>伴读连接未完成</strong>
          <p>{connectError}</p>
          <button type="button" onClick={() => void start()}>重新连接</button>
        </div>
      )}
      {bindError !== '' && (
        <div className="npr-companion-error" role="alert">
          <strong>这一页的上下文没能同步</strong>
          <p>{bindError}。在同步好之前，这里发出的消息不会带上这一页的内容。</p>
          <button type="button" onClick={() => setBindAttempt((value) => value + 1)}>重试同步</button>
        </div>
      )}
      {actionError !== '' && (
        <div className="npr-companion-notice" role="status">
          <span>{actionError}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setActionError('')}><Icon name="x" size={13} /></button>
        </div>
      )}
      {!chat && connectError === '' && (
        <div className="npr-book-companion-hint" role="status">
          {workspaceId ? '正在打开对话…' : '正在连接默认工作区…'}
        </div>
      )}
      {chat && SessionProvider && (
        <div className="npr-native-chat npr-book-companion-chat" ref={chatRoot}>
          <SessionProvider session={chat.reference}>{renderSlot('npie-reader.chat', {})}</SessionProvider>
          {/* 开场页只看「空态 + 无错误」，不挂 `synced`：取书期间（`loaded=false`）
              同步必然未完成，若挂了它开场页就整段消失，面板只剩空白
              （2026-10-09 用户截图）。输入守卫由上面的 `inert` 独立承担。 */}
          {emptyConversation && connectError === '' && bindError === '' && (
            <div className="npr-companion-opening" aria-label="开始伴读">
              <div className="npr-companion-book" aria-hidden="true">
                <svg viewBox="0 0 112 88" fill="none">
                  <path d="M56 72c-10-7-21-10-37-9V19c16-1 27 2 37 9 10-7 21-10 37-9v44c-16-1-27 2-37 9Z" />
                  <path d="M56 28v44M25 29c9 .3 17 2.5 24 6M25 38c9 .3 17 2.5 24 6M63 35c7-3.5 15-5.7 24-6M63 44c7-3.5 15-5.7 24-6" />
                  <path d="M11 68c18-3 33 0 45 9 12-9 27-12 45-9" />
                  <circle cx="77" cy="13" r="2.5" className="npr-companion-book-spark" />
                  <path d="M77 3v4M77 19v4M67 13h4M83 13h4" className="npr-companion-book-spark" />
                </svg>
              </div>
              <span className="npr-companion-opening-label">与这本书对坐片刻</span>
              <h2>好奇，从这一页开始。</h2>
              <p>一个细节，一处疑问，或一句不同意的话。<br />写下来，我们接着读。</p>
            </div>
          )}
          {promptMount && createPortal(
            <div className="npr-companion-prompt-strip" role="group" aria-label="快捷提问">
              <div className="npr-companion-prompt-scroll">
                {prompts.map((item) => (
                  <button type="button" className="npr-companion-prompt-ghost" key={item.id} title={item.body}
                    aria-label={`直接发送：${item.title}`} disabled={sending || !synced || !pageReadable}
                    onClick={() => void send(item)}>{item.title}</button>
                ))}
              </div>
              <button type="button" className="npr-companion-add-prompt" aria-label="管理电子书快捷提示词"
                title="管理电子书快捷提示词" onClick={onManagePrompts}><Icon name="plus" size={14} /></button>
            </div>, promptMount)}
        </div>
      )}
    </aside>
  );
}
