/**
 * 阅读时的灵感速记浮层（快捷键 `L`）。
 *
 * ★ 用户的原话是「读 RSS 或电子书时，随时按 L 启动灵感速记输入框，是浮层输入，
 *   不影响阅读」—— 所以这里**只有一个输入框**：没有类型选择、没有来源框、
 *   没有情绪、没有私密开关。任何一项加进来，它就不再是「速记」而是第二张日记表单。
 *   要选类型/情绪/私密，去日记页对应的模块里写。
 *
 * ★ 「灵感流转」（0.31.0）：在书里按 `L` 时，正在读的**书 / 页 / 章**会被自动写进
 *   `meta`（`book` / `page` / `chapter`），标题写进 `source`。这是**唯一**既满足
 *   「一键」又不往浮层里加控件的位置 —— 但关联必须**看得见**，所以多一行纯文本
 *   「会记到 《书名》· 第 N 章」。那行不是控件，浮层里仍然只有一个输入框。
 *
 * ★ 为什么浮层由 `ReaderPage` 挂载、而不是日记页：`ReaderPage` 是订阅页与书架页的
 *   共同父级，浮层挂在那里，两种阅读场景下都只有**一份**状态。挂在各页里会出现
 *   「书里按 L 记了一条，切回文章按 L 还看得见上一条草稿」。
 *
 * ★ 存到哪：今天（本地日期）、公开、类型「灵感」。浮层里不给选日期 —— 它服务的
 *   是「此刻」，带日期选择器的浮层就不叫速记了。
 *
 * ★ 这个浮层**不是**拖动区：它盖住了顶栏，语义是模态（Esc 关闭）。给它
 *   `data-window-drag` 会让「按住输入框边缘拖一下」变成把整个浮层拖走。
 *
 * ★ 0.72.0 补的是**写完那一刻**（对照乔木闪记，见 `quick-draft.js` 文件头）：
 *   ① 回执带「撤销 / 去看看」两颗按钮 —— 之前是一句不可交互的死文本；
 *   ② 关掉浮层不再连没写完的半句一起丢，24 小时内恢复，且**显式说出来**；
 *   ③ 回执里报「今天第 N 条」，用的是与日记页顶栏同一个统计口径。
 *
 * ★ 0.73.0 补的是**贴图**：从剪贴板直接粘一张截图（`onPaste`），图落到
 *   `diary/assets/`，正文里留下一条 `![](…/assets/<hash>.png)`。
 *   ★ 没有加按钮、没有加输入框 —— 浮层仍然只有一个 textarea。用粘贴而不是
 *     「加一颗选图按钮」，是因为读纸质书/网页时截图后的**下一步动作本来就是
 *     ⌘C ⌘V**；多一颗按钮就多一次点击，而速记的整个价值就在「不漏那一次」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateKey } from '../diary-format.js';
import { appendDiaryEntry, fetchDiaryDay, fetchDiaryTags, removeDiaryEntry, uploadDiaryAsset } from './diary-api.js';
import { Icon } from './icons.jsx';
import {
  acceptImage, applyTag, clearDraft, compareSaved, draftWhen, imageMarkdown, initialBody, makeDraft, readDraft,
  receiptText, safeStorage, tagSuggestions, writeDraft,
} from './quick-draft.js';

export function QuickCapture({ open, onClose, onOpenDiary, notify, context, seed = '' }) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  /**
   * 还有几张图在路上（0.73.1）。**是计数，不是布尔**。
   *
   * ★ 它必须能挡住保存：粘贴 → 上传是一个异步往返，用户完全可能在图还没落盘时
   *   就按了 ⌘Enter。那一下存下去的正文里是一条指向不存在文件的 `![]()`，
   *   而界面已经关掉并说「已记下」—— 事后再打开日记才发现图是碎的。
   * ★ 为什么不能用布尔（0.73.0 的错误）：连贴两张时，第一张完成会把布尔置回
   *   `false`，而第二张还在路上 —— 保存按钮当场解锁，那条注释里写着要防的事
   *   原样发生。计数只在「最后一张落地」时才归零。
   */
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState('');
  /** 打开时恢复出来的草稿（`null` = 没有）。它的**来源**会覆盖当前上下文，见 `origin`。 */
  const [restored, setRestored] = useState(null);
  /** 光标前正在打的 `#标签` 的候选（`null` = 没在打标签，不画那一行）。 */
  const [suggest, setSuggest] = useState(null);
  /** 候选里高亮的那一个：`Tab` 补全它、`↑` `↓` 换一个。 */
  const [activeTag, setActiveTag] = useState(0);
  const savingRef = useRef(false);
  /**
   * 贴图的**串行队列**（0.73.1）。
   *
   * ★ 两张图同时在路上时，各自上传、各自读一次光标再各自插入 —— 后回来的那张
   *   会用「先插入之后」的位置，于是最终次序取决于网络，而不是用户按下粘贴的次序。
   *   接在一条链上，插入次序就永远等于粘贴次序，且每次插入都读得到上一次的结果。
   */
  const chainRef = useRef(Promise.resolve());
  /** 用过的标签（打开时取一次）。放 ref 不放 state：它变了只需要重算候选，不必重画。 */
  const tagsRef = useRef([]);
  const inputRef = useRef(null);
  /** 最新正文：关浮层的那一下要写草稿，而 effect 里的 `draft` 是旧的闭包值。 */
  const draftRef = useRef('');
  /** 刚才保存成功。关闭时不许再把已存过的正文写回草稿（否则下次按 L 「恢复」出一条已存过的）。 */
  const savedRef = useRef(false);
  const persistTimer = useRef();
  const storage = useMemo(() => safeStorage(), []);

  /**
   * 「灵感流转」：在书里按 `L` 时，**自动**带上正在读的那本书 / 第几页 / 第几章；
   * 在读 RSS 时，带上那一篇文章的标题。
   *
   * ★ 为什么不给一个「关联到哪儿」的选择器：用户对浮层的要求是「不包含其它项」。
   *   自动带上是唯一既满足「一键」又不加控件的位置 —— 阅读上下文本来就摆在那儿，
   *   让用户再选一次是白问。
   * ★ 但**不能悄悄带**：上面那行 `npr-quick-link` 是纯文本（没有按钮、没有输入框），
   *   它只说「会记到哪儿」。看不见的关联比没有关联更糟 —— 事后在日记里看到一条
   *   挂在别的书上的灵感，谁也说不清它是怎么来的。
   * ★ 目录还没抽出来时 `chapter` 是 `null`：那就只记 `book` / `page`，**不猜章节**。
   * ★ 文章为什么也算「挂在某处」（0.38）：用户 2026-10-27 问「那如果在阅读 RSS 时
   *   创建的灵感怎么办？挂在书上的意义？」—— 意义是**回到现场**，不是「它是一本书」。
   *   所以两种上下文走同一个字段 `source`，只是文章名不套书名号（套了就是在说
   *   它是一本书）。日记侧按 `source` 分组，书和文章各自成块，见 `linkedSources`。
   */
  const linked = context && (context.bookId || context.articleKey) ? context : null;
  const chapterLabel = linked?.chapter
    ? (linked.chapter.title || `第 ${linked.chapter.n} 章`)
    : '';
  const bookTitle = linked?.bookTitle || linked?.bookId || '';
  const articleTitle = linked?.articleTitle || '';
  /**
   * 书名这一层：**书源里的标题本来就带书名号**（`《译文名著文库》 076[法]雨果…`），
   * 再无条件套一对就变成 `《《译文名著文库》 076…》`。用户在日记里看到的就是这个。
   * ⇒ 已经含 `《` 的标题原样用，只有裸标题才补书名号。
   */
  const bookLabel = bookTitle === ''
    ? ''
    : (bookTitle.includes('《') ? bookTitle : `《${bookTitle}》`);
  /** 存进 `source` 的那串（书带书名号，文章就是标题本身）。 */
  const source = bookLabel !== ''
    ? `${bookLabel}${chapterLabel ? ` · ${chapterLabel}` : ''}`
    : articleTitle;
  /** 给人看的那串：文章名套「」—— 便于在一行里认出「这一整句是一个标题」。 */
  const where = bookLabel !== '' ? source : (articleTitle === '' ? '' : `「${articleTitle}」`);

  /**
   * 写进 `meta` 的那几个键（书与文章各记各的：`book` 是书架内部 id，用于按书反查页码；
   * 文章只有 `key`）。
   */
  const currentMeta = useMemo(() => {
    const meta = {};
    if (!linked) return meta;
    if (linked.bookId) {
      meta.book = linked.bookId;
      if (Number.isInteger(linked.chapter?.n) && linked.chapter.n >= 0) meta.chapter = linked.chapter.n;
      if (Number.isInteger(linked.page) && linked.page >= 0) meta.page = linked.page;
    }
    if (linked.articleKey) meta.article = linked.articleKey;
    return meta;
  }, [linked]);

  /**
   * 这条要记到哪儿 —— **同时决定「会记到」那一行与真正写进文件的 `source` / `meta`**。
   *
   * ★ 恢复草稿时**沿用草稿自己的来源**，不用当前上下文：草稿是「在《A 书》里没写完的那句」，
   *   拿到《B 书》里按 `L` 时把它记到 B 上，事后完全无从分辨（两条都是合法条目，
   *   界面上看不出任何异常）。宁可「会记到」那一行显示的是上一本书，也不能串味。
   * ★ 点「清空」后 `restored` 归 `null`，来源立刻回到当前上下文 —— 这是唯一的出口。
   */
  const origin = restored
    ? { source: restored.source, meta: restored.meta, where: restored.where }
    : { source, meta: currentMeta, where };

  /** 按当前来源包一份草稿。 */
  const snapshot = (body) => makeDraft({
    body,
    source: origin.source,
    meta: origin.meta,
    where: origin.where,
  });

  /**
   * 打开就聚焦（「打开即写」），关掉时把没写完的存下来。
   *
   * ★ 0.72.0 之前关掉是**直接清空**，注释写的理由是「留着草稿会让下一次按 L 变成
   *   『咦，怎么有上次没写完的半句』」。那个担心是对的，但解法不该是丢掉用户的话 ——
   *   现在靠**显式的恢复提示行**（`npr-quick-restored`）解决「咦」：
   *   用户看得见「已恢复 09:12 未写完的内容」，旁边就有「清空」。
   * ★ 关闭时读 `draftRef` 而不是 `draft`：这个 effect 的依赖只有 `open`，
   *   里面的 `draft` 是上一次渲染的闭包值 —— 用它写盘会少掉最后几个字。
   */
  useEffect(() => {
    if (!open) {
      clearTimeout(persistTimer.current);
      // `savedRef` 为真 = 刚刚存过，正文已经在日记里了，不能再写回草稿。
      // ★ 正文与恢复出来的草稿**一字未改**时不写：`writeDraft` 会把 `at` 刷成现在，
      //   于是「只看了一眼就关掉」会让一条三天前的草稿永不过期。
      // ★ 与 `seed` 一字不差时也不写：`L` 带进来的那段引用是**材料**，用户什么都没写、
      //   关掉它，下次按 `L` 不该恢复出一条只有引用的草稿（那正是「摘录到灵感」的活）。
      if (!savedRef.current && draftRef.current !== seed && (!restored || restored.body !== draftRef.current)) {
        writeDraft(storage, snapshot(draftRef.current));
      }
      savedRef.current = false;
      setDraft(''); draftRef.current = '';
      setRestored(null);
      setSuggest(null); setActiveTag(0);
      setError('');
      setSaving(false);
      setUploading(0);
      return undefined;
    }
    const saved = readDraft(storage);
    /**
     * 打开时填什么：**有草稿就只认草稿**。
     *
     * ★ 草稿与种子（`L` 带进来的那段引用）不能合并：草稿是「上次没写完的我的话」，
     *   种子是「这次的原文」。拼在一起会让用户分不清哪句是自己写的，而保存下去的
     *   是一条混着两本书上下文的内容。草稿优先，是因为它是**用户自己打的字**。
     * ★ 但必须在提示行里说出来（见 `restoredSeedHint`）—— 用户刚选中一段就按了 `L`，
     *   打开却看不见它，不说一句就是「功能坏了」。
     */
    const initial = initialBody(saved, seed);
    setRestored(saved);
    setDraft(initial);
    draftRef.current = initial;
    setSuggest(null); setActiveTag(0);
    setError('');
    // 标签只取一次（打开期间不刷新）：补全只是打字辅助，为它每次按键走一趟 HTTP 不值得。
    let alive = true;
    fetchDiaryTags()
      .then((result) => { if (alive) tagsRef.current = Array.isArray(result?.tags) ? result.tags : []; })
      // 取不到就只是没有补全。这里**不报错**：用户此刻在写东西，弹一条「标签读取失败」
      // 只会打断他，而补全本身不是他要求的功能。
      .catch(() => {});
    const timer = setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      // 预填了引用就把光标放到末尾：引用只是材料，要写的是它后面。
      if (!saved && initial !== '') {
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    }, 0);
    return () => { alive = false; clearTimeout(timer); };

    // `snapshot` 依赖 `origin`，而 `origin` 每次渲染都是新对象 —— 故意不列进依赖：
    // 这条 effect 只该在「开 / 关」时跑一次，中途来源变化不该触发它。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  /** 正文变化：立刻更新界面，250ms 后落一次草稿（别让每次按键都写 localStorage）。 */
  function update(next, caret) {
    setDraft(next);
    draftRef.current = next;
    // 候选跟着**光标**算，不是跟着正文末尾：用户完全可能在中间补一个标签。
    setSuggest(tagSuggestions(next, caret, tagsRef.current));
    setActiveTag(0);
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => { writeDraft(storage, snapshot(next)); }, 250);
  }

  /** 候选里上下换一个（环形）。 */
  function browseTag(delta) {
    const size = suggest?.tags.length ?? 0;
    if (size === 0) return;
    setActiveTag((index) => (index + delta + size) % size);
  }

  /**
   * 补上选中的那个标签。
   *
   * ★ 用**当下**的光标重算一次 `start`，不信 `suggest` 里那个：候选算出来之后用户
   *   还可能点了一下把光标挪走，拿旧下标替换就是「补全把中间一段话吃掉了」。
   * ★ 插入之后要自己把光标挪到插入内容之后（`applyTag` 返回位置）。不挪的话
   *   用户接着打字会打在 `#标签` 前面 —— 症状是「补全完字跑到井号前头去了」。
   */
  function pickTag(tag) {
    const input = inputRef.current;
    if (!input) return;
    const caret = input.selectionStart ?? input.value.length;
    const found = tagSuggestions(input.value, caret, tagsRef.current) ?? suggest;
    if (!found) { setSuggest(null); return; }
    const result = applyTag(input.value, caret, found.start, tag);
    update(result.text, result.caret);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(result.caret, result.caret);
    });
  }

  /** 丢掉恢复出来的草稿，回到当前上下文的空白状态。 */
  function discardDraft() {
    clearDraft(storage);
    setRestored(null);
    setDraft(''); draftRef.current = '';
    clearTimeout(persistTimer.current);
    inputRef.current?.focus();
  }

  /**
   * 撤销刚记的那一条。
   *
   * ★ **绝不按序号盲删**：回执的 8 秒里用户可能已经打开日记删掉了上面一条，
   *   同一个 `index` 此刻指向的是别人 —— 照删就是「撤销一句灵感，删掉一篇读后感」。
   *   所以先读回今天，核对 `scope + index` 那一格的正文，只删「还是我写的那句」。
   * ★ 核对不通过时给的出路是「去看看」而不是「再试一次」：既然内容对不上，
   *   任何自动动作都可能删错东西，只剩人工判断。
   */
  async function undo({ date, index, scope, body }) {
    try {
      const day = await fetchDiaryDay(date);
      const verdict = compareSaved(day?.entries, { scope, index, body });
      if (verdict === 'gone') { notify('这条已经不在了（可能你自己删掉了）'); return; }
      if (verdict === 'changed') {
        notify('这条已经改过了，到日记里手动删', true, { label: '去看看', onClick: onOpenDiary });
        return;
      }
      await removeDiaryEntry(date, index, scope);
      notify('已撤销刚记的那条');
    } catch (cause) {
      notify(`撤销失败：${cause?.message ?? String(cause)}`, true);
    }
  }

  /**
   * 粘贴一张截图（0.73.0）。
   *
   * ★ **先判类型/大小，判过了才拦默认粘贴**（0.73.1 修的）。一次粘贴常常同时带着
   *   文字与图片（从网页复制一段带图的正文、从 Word 复制都是这样）。原来的顺序是
   *   「先 `preventDefault` 再判」—— 图片是 SVG 或超过 8 MB 时，默认粘贴已经被吃掉，
   *   用户既没拿到图，也**丢了那段文字**，屏幕上只剩一句「只收 PNG…」。
   *   文字凭空消失比贴不了图严重得多，所以顺序必须是「判 → 拦」。
   * ★ 插入位置取**上传完成那一刻**的光标，不是按下粘贴时的：等图的这一两秒里用户
   *   完全可能接着打字、移动光标。拿旧下标插进去，那张图会落在别的地方。
   * ★ 失败就只说一句人话（`error`），不进 `notify`：用户此刻在写东西，弹到屏幕
   *   底部的提示会被浮层挡住，他看不到。
   */
  async function pasteImage(event) {
    const items = event.clipboardData?.items;
    if (!items) return;
    /**
     * ★ 不要对 `items` 用**数组展开**：`DataTransferItemList` 只是类数组，
     *   并不实现 `Symbol.iterator`（Chromium 里展开或 `for…of` 会抛
     *   "is not iterable"）。症状极隐蔽 —— 粘贴什么都不发生，控制台只有一条
     *   与贴图无关的 TypeError。按下标读是唯一稳的写法。
     */
    let file = null;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.kind !== 'file' || !String(item.type).startsWith('image/')) continue;
      file = item.getAsFile();
      if (file) break;
      file = null;
    }
    if (file === null) return;
    // ★ 判在前、拦在后（见函数注释）。拒绝时**不拦**，文字照常进输入框。
    const verdict = acceptImage({ type: file.type, size: file.size });
    if (!verdict.ok) { setError(verdict.message); return; }
    event.preventDefault();
    setError('');
    setUploading((count) => count + 1);
    // 排队：链尾挂上这一次，前一次插完才轮到它（见 `chainRef` 的注释）。
    // 链本身接住失败，否则一次贴图失败会让后面所有贴图都卡在一条 rejected 链上。
    const run = chainRef.current.then(() => insertImage(file));
    chainRef.current = run.then(() => {}, () => {});
    try {
      await run;
    } catch (cause) {
      setError(`贴图失败：${cause?.message ?? String(cause)}`);
    } finally {
      setUploading((count) => Math.max(0, count - 1));
    }
  }

  /** 上传一张图并插进正文。只由 `pasteImage` 的队列调用（保证串行）。 */
  async function insertImage(file) {
    const uploaded = await uploadDiaryAsset(file);
    const input = inputRef.current;
    const caret = input ? (input.selectionStart ?? input.value.length) : draftRef.current.length;
    const applied = imageMarkdown(draftRef.current, caret, uploaded?.url);
    update(applied.text, applied.caret);
    requestAnimationFrame(() => {
      const box = inputRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(applied.caret, applied.caret);
    });
  }

  async function save() {
    // 图还在路上时不许存（见 `uploading` 的注释）：存下去就是一条指向不存在文件的
    // `![]()`，而回执照样会说「已记下」。**判的是「还有几张」而不是「有没有」**。
    if (savingRef.current || uploading > 0) return;
    const body = draft.trim();
    if (!body) { inputRef.current?.focus(); return; }
    savingRef.current = true;
    setSaving(true);
    setError('');
    // 日期只算一次：撤销要用同一个日期，跨零点时重算会指到第二天。
    const date = dateKey();
    try {
      const result = await appendDiaryEntry({
        date, kind: '灵感', body: draft, source: origin.source, meta: origin.meta,
      });
      savedRef.current = true;
      clearDraft(storage);
      setDraft(''); draftRef.current = '';
      onClose?.();
      notify(receiptText({ count: result?.listedCount, where: origin.where }), false, [
        {
          label: '撤销',
          onClick: () => void undo({
            date,
            index: result?.index,
            scope: result?.scope ?? 'public',
            body: draft,
          }),
        },
        { label: '去看看', onClick: onOpenDiary },
      ]);
    } catch (cause) {
      setError(cause.message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="npr-quick-backdrop" role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="npr-quick" role="dialog" aria-modal="true" aria-label="灵感速记">
        <div className="npr-quick-head">
          <strong>记一条</strong>
          <span className="npr-quick-hint">⌘/Ctrl + Enter 保存 · Esc 关闭</span>
          <button type="button" className="npr-icon" title="关闭（Esc）" aria-label="关闭" onClick={() => onClose?.()}><Icon name="x" /></button>
        </div>
        {/* 恢复提示行**必须是可见的**：自动填进来一句上次没写完的话而不解释，
            用户的第一反应是「这是哪来的」。一句话 + 一个「清空」就把它变成用户的决定。 */}
        {restored && (
          <p className="npr-quick-restored">
            <Icon name="clock" size={13} />
            <span>
              已恢复 {draftWhen(restored.at)} 未写完的内容
              {restored.where ? `（原来记到 ${restored.where}）` : ''}
              {/* 用户刚选中一段就按了 L，打开却看不见它 —— 不说这一句就是「功能坏了」。
                  草稿优先是因为它是用户自己打的字，但「优先」必须说出来。 */}
              {seed !== '' ? '，选中的文字这次没带入' : ''}
            </span>
            <button type="button" className="npr-quick-discard" onClick={discardDraft}>清空</button>
          </p>
        )}
        {/* 「会记到哪儿」是**一行纯文本**，不是控件：没有按钮、没有选择器、没有输入框。
            它存在的唯一理由是「关联不能悄悄发生」（见上面 `origin` 的注释）。 */}
        {origin.where && <p className="npr-quick-link">会记到 {origin.where}</p>}
        <textarea ref={inputRef} className="npr-quick-input" value={draft} aria-label="灵感正文"
          placeholder="这一刻想到什么？写 #标签 可以自动归类，也可以直接粘贴截图。"
          onChange={(event) => update(event.target.value, event.target.selectionStart)}
          onPaste={(event) => { void pasteImage(event); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              // 候选开着时 Esc 先收候选：用户想放弃这个词，不是想关掉整个浮层。
              if (suggest) { setSuggest(null); return; }
              onClose?.();
              return;
            }
            // ★ 中文输入法组字期间**绝不能**拦 Tab / 方向键：那几个键盘事件属于输入法，
            //   这里再 preventDefault 会让候选框当场消失。`isComposing` 是标准，
            //   `keyCode === 229` 兜老 WebKit（只给后者）。
            if (event.isComposing || event.keyCode === 229) return;
            if (suggest) {
              if (event.key === 'Tab') {
                // 只在**有候选**时劫持 Tab：没候选时 Tab 必须照旧切走焦点。
                event.preventDefault();
                pickTag(suggest.tags[activeTag] ?? suggest.tags[0]);
                return;
              }
              if (event.key === 'ArrowDown') { event.preventDefault(); browseTag(1); return; }
              if (event.key === 'ArrowUp') { event.preventDefault(); browseTag(-1); return; }
              // `Enter` 不劫持（那是换行），只把候选收起来，免得挡着下一行。
              if (event.key === 'Enter') setSuggest(null);
            }
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void save(); }
          }} />
        {/* 标签候选。**不是**第二排控件：只在打着 `#` 时才出现，选完就消失。
            ★ 按钮上 `onPointerDown` 必须 `preventDefault`：不拦的话按下这一下会让
              textarea 失焦，而失焦会把手上的 caret 交出去 —— 补全位置就算错了。 */}
        {suggest && (
          <div className="npr-quick-tags" role="listbox" aria-label="标签候选">
            {suggest.tags.map((tag, index) => (
              <button key={tag} type="button" role="option" aria-selected={index === activeTag}
                className={`npr-quick-tag${index === activeTag ? ' is-active' : ''}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pickTag(tag)}>#{tag}</button>
            ))}
            <span className="npr-quick-hint">Tab 补上 · ↑↓ 选</span>
          </div>
        )}
        <div className="npr-quick-foot">
          {/* 字数旁边就是「图正在存」。不给它一句独立的状态行：等一两秒的事，
              不值得让浮层的高度跳一下。 */}
          <span className="npr-quick-hint">
            {uploading > 0
              ? `图片正在保存${uploading > 1 ? `（还有 ${uploading} 张）` : ''}…`
              : `${draft.replace(/\s/g, '').length} 字`}
          </span>
          <button type="button" className="npr-diary-save" onClick={() => void save()}
            disabled={saving || uploading > 0 || draft.trim() === ''}>
            {saving ? '正在保存…' : (uploading > 0 ? '等图片…' : '记下来')}
          </button>
        </div>
        {error && <p className="npr-quick-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
