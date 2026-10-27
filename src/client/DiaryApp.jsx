/**
 * 日记视图（第三个 tab）。
 *
 * ★ **按用户的三个功能模块组织，不是按「条目类型」**（0.31.0 返工）。
 *   0.30.0 把界面做成「一张表单 + 灵感/读后感/书摘 三个类型按钮」，那是错的：
 *   用户的设计是**三个模块**，每个模块有自己的入口、自己的浏览方式、自己的写入口。
 *
 *     灵感速记  → 极简输入（打开即写）+ 标签检索 + 时间轴检索 + 已关联到书的灵感
 *     私密日记  → 加密输入（AES-256-GCM）+ 情绪 + 日历（只数私密）
 *     读后感    → **只对标记为「读完」的书**开放 + 结构化模板 + 这本书的划线侧栏
 *
 *   `kind` / `vis` 现在由**模块**决定（见 `diary-format.js` 的 `DIARY_MODULES`），
 *   用户不再手选类型。老数据里的「书摘」仍能原样读出（`LEGACY_KINDS`）。
 *
 * ★ 0.32.0 的这一轮是**按用户逐条指出的错**改的（2026-10-27），五条：
 *   ① 视觉层级：日期只是 14px 粗体，和正文、说明挤在同一层灰里，整页没有焦点；
 *      卡片套卡片（composer 卡片里再套一个带边框的 textarea）；
 *      正文一路铺到 1000px 宽（一行 70 个汉字，中文舒适区是 35–45）。
 *   ② 「AI 整理」原来挂在**每一条**上 ⇒ 用户原话「AI 整理是整理当天的全部记录，
 *      不是一条记录一个 AI 整理」。现在它是**日期栏上的一个动作**，上下文不传
 *      `target`，走 `diaryContext` 的整天模式。
 *   ③ 灵感侧栏原来是一份「最近 30 天，每天每条的时间 + 预览」—— 那是把正文抄了
 *      一遍，既不是「按标签检索」也不是「按时间轴检索」。现在侧栏是三块**检索器**：
 *      标签云（权重分档）／最近写过（只给日期与条数）／挂在书上（灵感流转的落地）。
 *   ④ 私密侧栏原来显示的是「公开 + 私密」的合计条数 ⇒ 用户原话「为什么还显示
 *      灵感的记录条数」。`listMonth` 现在分开给 `publicDays` / `privateDays`。
 *   ⑤ 情绪只有 14px、默认 `grayscale(.55)` + `opacity(.7)`，五个里有两个分不开。
 *      现在独立成行、22px、带中文标签、选中按档染色。
 *
 * ★ 骨架与书架那半边**逐块对应**（`.npr-workarea > .npr-layout > aside.npr-sidebar
 *   + .npr-resize + section.npr-reader`），所以布局 CSS 与窗口拖动区完全共用。
 *   **顶栏必须自带 `[data-window-drag]`** —— 否则在日记页按住空白处拖不动窗口
 *   （0.9.8 / 0.28.3 两次同款事故，见 memory §〇 第 94 条）。
 *
 * ★ 两个入口，同一页：侧栏第三个 tab 进来（默认灵感速记），或者**在书里点
 *   「写读后感」**进来（`intent = { module, bookId, bookTitle, ext }`）。
 *
 * ★ 数据全部走 HTTP（`diary-api.js`），不走 Remote：日记是文件，翻页/搜一句都是读盘。
 *
 * ★ 私密条目**不给「AI 整理」**：宿主的 `setDiaryContext` 读的是公开那半边，
 *   按钮能点的话模型看到的会是同一天的另一段内容。这是边界，不是没做。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeHtml } from '../host/sanitize.js';
import { markdownToHtml } from '../host/markdown.js';
import {
  DIARY_MODULES, MOODS, REFLECTION_TEMPLATE, dateKey, monthKeyOf, normalizeMood, parseMonthKey,
  parseTags, shiftMonth,
} from '../diary-format.js';
import {
  appendDiaryEntry, downloadDiaryBundle, fetchDiaryBook, fetchDiaryDay, fetchDiaryExport,
  fetchDiaryMonth, fetchDiarySecret, fetchDiaryStats, fetchDiaryTags, fetchDiaryTimeline,
  removeDiaryEntry, revealDiaryFolder, searchDiary,
} from './diary-api.js';
import { fetchAnnotations, fetchBooks, fetchStates } from './library-api.js';
import { DiaryCalendar } from './DiaryCalendar.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import { Icon } from './icons.jsx';

/** 一条正文渲染成 HTML。与译文同一条路（markdown → sanitize），不自造渲染器。 */
function renderBody(body) {
  const text = typeof body === 'string' ? body : '';
  if (text.trim() === '') return '';
  try {
    return sanitizeHtml(markdownToHtml(text));
  } catch {
    // 渲染失败就退回纯文本（`pre-wrap` 由 CSS 保证换行）—— 日记不能因为一段
    // 奇怪的 markdown 就整条消失。
    return '';
  }
}

/** 这一天的标题：今天 / 昨天 / 完整日期。 */
function dayLabel(date, today) {
  if (date === today) return '今天';
  const yesterday = new Date(`${today}T00:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date === dateKey(yesterday)) return '昨天';
  const [, month, day] = date.split('-');
  return `${Number(month)} 月 ${Number(day)} 日`;
}

/**
 * 一条记录在界面上的唯一键。
 * ★ 必须是 `scope + index` 的组合：公开与私密是两个文件、各有自己的 0 号条目，
 *   只用下标会让同一天的公开 0 号与私密 0 号互相串（两个「确认删除」同时亮起来）。
 */
function entryKey(entry) {
  return `${entry?.scope ?? 'public'}-${entry?.index ?? 0}`;
}

/** 一条记录/一天的第一个心情（没有就空串）。老版本的 emoji 会在这里被换成当前这版。 */
function firstMood(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return normalizeMood(value);
  }
  return '';
}

/**
 * 「AI 整理这一天」的提示词。
 *
 * ★ **不追加回去**（0.32.0 改的）。旧提示词让模型 `diary_append` 一条整理稿到
 *   **同一天**，于是下一次「整理今天」会把上一次的整理稿当成原材料再整理一遍 ——
 *   越滚越不像自己写的，而且原文与整理稿在同一个文件里长得一样，用户分不清哪条是
 *   自己写的。整理稿只在这里给用户看，要不要留由他自己决定。
 */
const AI_DAY_PROMPT = [
  '帮我整理**今天这一整天**的记录（上下文里给了这一天所有的条目，不是某一条）。',
  '保留我的原意和语气，把没说清的地方说清楚，不要编我没写过的事。',
  '几条说的是同一件事就并成一条；只有半句的碎片可以只留一句更准的话。',
  '整理稿直接给我看，**不要**写回日记 —— 我自己决定要不要留。',
  '原文不要动。',
].join('\n');

/** 读后感按篇整理：一篇就是一整篇文档，和「灵感按天整理」不是同一件事。 */
const AI_ENTRY_PROMPT = [
  '帮我整理上面这一篇读后感（上下文里标了「本轮处理对象」的那一条）。',
  '保留我的原意和语气，把没说清的地方说清楚，不要编我没写过的事。',
  '整理稿直接给我看，**不要**写回日记。原文不要动。',
].join('\n');

const MODULE_BY_VALUE = new Map(DIARY_MODULES.map((item) => [item.value, item]));

/**
 * 五档心情。灵感与私密两个模块共用。
 *
 * ★ 抽成组件而不是复制两遍：改一次配色就得记得改两处，而「只改了一处」在界面上
 *   表现为「两个模块的心情按钮长得不一样」—— 这种错没人会报，但每用一次都别扭。
 */
function MoodRow({ value, onChange, label }) {
  return (
    <div className="npr-diary-moodrow" role="group" aria-label={label}>
      {MOODS.map((item) => (
        <button key={item.emoji} type="button" data-tone={item.tone}
          aria-pressed={value === item.emoji} aria-label={item.label} title={item.label}
          onClick={() => onChange(value === item.emoji ? '' : item.emoji)}>
          <span className="npr-diary-moodface" aria-hidden="true">{item.emoji}</span>
          <span className="npr-diary-moodname">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 时间轴里「已经挂在某本书上」的灵感，按书名归拢。
 *
 * ★ 按 `source` 而不是 `meta.book` 分组：`source` 是**人可读**的（`《深度工作》· 第 3 章`），
 *   `meta.book` 是书架内部 id，书单被 `BOOKS_PAGE_LIMIT` 截断时前端根本映射不出书名。
 *   两者在「按 L 记灵感」时是同时写入的，用哪个都不丢信息，但只有 `source` 能直接显示。
 */
function linkedBooks(days) {
  const map = new Map();
  for (const day of days) {
    for (const entry of day.entries ?? []) {
      if (entry.scope !== 'public' || entry.kind === '读后感' || !entry.source) continue;
      const title = (/^《([^》]+)》/.exec(entry.source)?.[1]) ?? entry.source;
      const cell = map.get(title) ?? { title, count: 0, last: day.date };
      cell.count += 1;
      if (day.date > cell.last) cell.last = day.date;
      map.set(title, cell);
    }
  }
  return [...map.values()].sort((left, right) => (
    right.last.localeCompare(left.last) || right.count - left.count || left.title.localeCompare(right.title)
  ));
}

export function DiaryApp({ onExit, notify, api, SessionProvider, renderSlot, intent }) {
  const today = useMemo(() => dateKey(), []);
  /**
   * 当前模块。默认「灵感速记」—— 它是最轻的那个，也是打开日记时最常做的事。
   *
   * ★ 带 `intent` 进来时**直接落到那一块**：从书里点「写读后感」走的就是这条，
   *   用户已经在读一本书了，进来还要再选一次书是多余的一步。
   *   白名单校验（`DIARY_MODULES.some`）而不是直接赋值：外层传错一个值不能让
   *   这一页落到一个 `mod` 为 `undefined` 的模块上（下面 `mod.kind` 会当场炸）。
   */
  const [moduleValue, setModuleValue] = useState(() => (
    DIARY_MODULES.some((item) => item.value === intent?.module) ? intent.module : 'inspiration'
  ));
  const mod = MODULE_BY_VALUE.get(moduleValue) ?? DIARY_MODULES[0];

  const [selected, setSelected] = useState(today);
  const [month, setMonth] = useState(() => {
    const parsed = parseMonthKey(today.slice(0, 7));
    return parsed ?? { year: new Date().getFullYear(), month0: new Date().getMonth() };
  });
  const [marks, setMarks] = useState({ days: {}, publicDays: {}, privateDays: {}, moods: {}, total: 0 });
  const [day, setDay] = useState({ date: today, exists: false, entries: [], chars: 0, publicCount: 0, privateCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [draft, setDraft] = useState('');
  const [mood, setMood] = useState('');
  const [secret, setSecret] = useState({ mode: '', error: '' });
  const [saving, setSaving] = useState(false);

  const [busyKey, setBusyKey] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [confirmKey, setConfirmKey] = useState('');

  const [search, setSearch] = useState({ open: false, query: '', hits: [], scanned: 0, truncated: false, busy: false });
  const [tagIndex, setTagIndex] = useState({ tags: [], busy: false });
  const [timeline, setTimeline] = useState({ days: [], truncated: false, busy: false });

  // ---- 读后感工作台 -------------------------------------------------------
  const [books, setBooks] = useState({ items: [], total: 0, truncated: false, busy: false, error: '' });
  /** `{ [bookId]: { state, page, pages, at } }` —— 读后感门禁的判据就在这里面。 */
  const [bookStates, setBookStates] = useState({});
  const [bookQuery, setBookQuery] = useState('');
  const [book, setBook] = useState(null);
  const [bookEntries, setBookEntries] = useState({ items: [], busy: false });
  const [annotations, setAnnotations] = useState({ items: [], busy: false, error: '' });
  const [refDraft, setRefDraft] = useState('');

  const [exportArmed, setExportArmed] = useState(false);
  const [listWidth, setListWidth] = useState(() => Number(localStorage.getItem('npr.diaryListWidth')) || 268);
  const [chat, setChat] = useState(null);
  const [chatError, setChatError] = useState('');
  const [stats, setStats] = useState(null);

  const savingRef = useRef(false);
  const aiRef = useRef(false);
  const chatRef = useRef(null);
  const draftRef = useRef(null);
  const refRef = useRef(null);

  const monthKey = monthKeyOf(month.year, month.month0);

  async function loadMonth(target = monthKey) {
    try {
      const payload = await fetchDiaryMonth(target);
      setMarks({
        days: payload.days ?? {},
        publicDays: payload.publicDays ?? {},
        privateDays: payload.privateDays ?? {},
        moods: payload.moods ?? {},
        total: payload.total ?? 0,
      });
      if (payload.privateError) setError(`有私密日记解不开：${payload.privateError}`);
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function loadDay(target = selected) {
    setLoading(true);
    setError('');
    try {
      const payload = await fetchDiaryDay(target);
      setDay({
        date: payload.date ?? target,
        exists: payload.exists === true,
        entries: payload.entries ?? [],
        chars: payload.chars ?? 0,
        publicCount: payload.publicCount ?? 0,
        privateCount: payload.privateCount ?? 0,
      });
    } catch (cause) {
      setError(cause.message);
      setDay({ date: target, exists: false, entries: [], chars: 0, publicCount: 0, privateCount: 0 });
    } finally {
      setLoading(false);
    }
  }

  async function loadTags() {
    setTagIndex((current) => ({ ...current, busy: true }));
    try {
      const payload = await fetchDiaryTags();
      setTagIndex({ tags: payload.tags ?? [], busy: false });
    } catch (cause) {
      setError(cause.message);
      setTagIndex((current) => ({ ...current, busy: false }));
    }
  }

  async function loadTimeline() {
    setTimeline((current) => ({ ...current, busy: true }));
    try {
      const payload = await fetchDiaryTimeline({ limit: 30 });
      setTimeline({ days: payload.days ?? [], truncated: payload.truncated === true, busy: false });
      if (payload.privateError) setError(`有私密日记解不开：${payload.privateError}`);
    } catch (cause) {
      setError(cause.message);
      setTimeline((current) => ({ ...current, busy: false }));
    }
  }

  /**
   * 书单 + 阅读状态一起拉。
   *
   * ★ 必须一起：读后感只对**读完**的书开放，而「读完」这个判据在 `/state` 里、
   *   不在 `/books` 里。分两次拉就会出现「书单已到、状态还没到」的一帧 ——
   *   那一帧里所有书都按「未读完」画成禁用，用户看到的是「我的书全灰了」。
   */
  async function loadBooks() {
    setBooks((current) => ({ ...current, busy: true, error: '' }));
    try {
      const [payload, states] = await Promise.all([
        fetchBooks(),
        fetchStates().catch(() => ({})),
      ]);
      setBooks({
        items: (payload.books ?? []).map((item) => ({
          id: item.id, title: item.title || item.filename || item.id, ext: item.ext,
        })),
        total: payload.total ?? 0,
        truncated: payload.truncated === true,
        busy: false,
        error: '',
      });
      setBookStates(states ?? {});
    } catch (cause) {
      setBooks({ items: [], total: 0, truncated: false, busy: false, error: cause.message });
    }
  }

  /** 一本书读完没有。认不出的 id 一律按「未读完」—— 宁可挡住，不可放行。 */
  const stateOf = (id) => bookStates[id]?.state ?? 'unread';

  /**
   * 打开一本书（读后感工作台）。
   *
   * ★ **只对读完的书开放**（用户 2026-10-27：「这一步分一个非常重要的已经标记为读完的书，
   *   只有读完的书才可以写读后感」）。所以这里有两道闸：
   *   ① 侧栏把书分两组、未读完的那组 `disabled`（看得见为什么点不动）；
   *   ② 这个函数本身再判一次 —— 从书里点「写读后感」进来时 `openBook` 是直接调的，
   *      没有经过侧栏那道 UI 闸。只做 ① 的话，从阅读器进来照样能写。
   */
  async function openBook(target) {
    const status = stateOf(target.id);
    setBook({ ...target, readable: status === 'read' });
    setBookEntries({ items: [], busy: true });
    setAnnotations({ items: [], busy: true, error: '' });
    // 模板只在**还没写过**时预填，否则会覆盖用户已经改过的正文。
    setRefDraft((current) => (current.trim() === '' ? REFLECTION_TEMPLATE : current));
    try {
      const payload = await fetchDiaryBook(target.id);
      setBookEntries({ items: payload.entries ?? [], busy: false });
    } catch (cause) {
      setError(cause.message);
      setBookEntries({ items: [], busy: false });
    }
    try {
      const items = await fetchAnnotations(target.id);
      setAnnotations({ items, busy: false, error: '' });
    } catch (cause) {
      // 划线取不到不该让整块读后感用不了：书可能还没打开过、也可能没有划线。
      setAnnotations({ items: [], busy: false, error: cause.message });
    }
  }

  useEffect(() => { void loadMonth(monthKey); }, [monthKey]);
  useEffect(() => { void loadDay(selected); }, [selected]);
  useEffect(() => { fetchDiaryStats().then(setStats).catch(() => {}); }, [day.chars, day.privateCount]);

  /**
   * 从书里点「写读后感」过来：**直接打开那本书**。
   *
   * ★ 不要求它在书单里 —— 书架会被 `BOOKS_PAGE_LIMIT` 截断（本机 2634 本），
   *   而 `/book/:id` 只认 id，截断之外的书照样读得到。所以这里用 intent 自带的
   *   `title` / `ext` 拼一个最小 book 对象，不去书单里找。
   * ★ 但「读完没有」必须先问清楚：`bookStates` 可能还是空的（书单还没拉回来），
   *   所以这里**先拉一次 states**，再 openBook。不这么做的话，从阅读器点进来会
   *   因为「状态未到」被判成未读完 —— 而用户刚刚在书里点过「标记读完」。
   * ★ 依赖只写 `intent?.bookId`（原始值）：外层每次渲染都可能传一个新对象，
   *   依赖对象身份会让这条 effect 每渲染都跑一次 —— 每跑一次就多一轮读盘。
   */
  useEffect(() => {
    if (!intent?.bookId) return;
    setModuleValue('reflection');
    let alive = true;
    (async () => {
      try {
        const states = await fetchStates();
        if (alive) setBookStates(states ?? {});
      } catch { /* 状态取不到就按未读完处理：门禁宁可挡住 */ }
      if (!alive) return;
      void openBook({ id: intent.bookId, title: intent.bookTitle || intent.bookId, ext: intent.ext ?? '' });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.bookId]);

  // 模块切换时才拉它自己的数据（不在切模块时把所有东西都拉一遍）。
  useEffect(() => {
    if (moduleValue === 'inspiration') { void loadTags(); void loadTimeline(); }
    if (moduleValue === 'private') void loadMonth(monthKey);
    if (moduleValue === 'reflection') void loadBooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleValue]);

  // 关掉面板时把会话还回去，否则它会一直挂着一个 retain。
  useEffect(() => () => { chatRef.current?.release?.(); }, []);

  async function refresh() {
    await loadDay(selected);
    await loadMonth(monthKey);
    if (moduleValue === 'inspiration') await Promise.all([loadTags(), loadTimeline()]);
    if (moduleValue === 'reflection' && book) {
      try {
        const payload = await fetchDiaryBook(book.id);
        setBookEntries({ items: payload.entries ?? [], busy: false });
      } catch { /* 上面已经刷过当天，这里失败只影响这本书的列表 */ }
    }
  }

  const pick = (date) => {
    setSelected(date);
    setConfirmKey('');
    const parsed = parseMonthKey(date.slice(0, 7));
    if (parsed && (parsed.year !== month.year || parsed.month0 !== month.month0)) setMonth(parsed);
  };

  const jump = (date) => {
    pick(date);
    setSearch((current) => ({ ...current, open: false }));
  };

  /** 三个模块共用一个保存动作，差别只有 `kind` / `vis` / 正文来源。 */
  async function save(body, { kind, vis, source = '', meta = {} } = {}) {
    if (savingRef.current) return false;
    if (!body.trim()) { draftRef.current?.focus(); return false; }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await appendDiaryEntry({
        date: moduleValue === 'reflection' ? today : selected,
        kind: kind ?? mod.kind,
        source,
        body,
        meta,
        vis: vis ?? mod.vis,
      });
      await refresh();
      return true;
    } catch (cause) {
      setError(cause.message);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function saveQuick() {
    const ok = await save(draft, { meta: { mood } });
    if (!ok) return;
    setDraft('');
    setMood('');
    notify?.(mod.vis === 'private' ? '已记下这一条（私密，本地加密）' : '已记下这一条');
  }

  async function saveReflection() {
    if (!book) { setError('先在左边选一本书'); return; }
    if (!book.readable) { setError(`《${book.title}》还没标记读完，读后感只对读完的书开放`); return; }
    const ok = await save(refDraft, {
      kind: '读后感',
      vis: 'public',
      source: `《${book.title}》`,
      meta: { book: book.id },
    });
    if (!ok) return;
    setRefDraft(REFLECTION_TEMPLATE);
    notify?.(`已把《${book.title}》的读后感记下来`);
  }

  async function removeAt(entry) {
    const key = entryKey(entry);
    if (busyKey !== '') return;
    setBusyKey(key);
    setError('');
    try {
      // ★ 必须带 `scope`：公开与私密是两个文件、各有自己的序号。
      await removeDiaryEntry(entry.date ?? selected, entry.index, entry.scope ?? 'public');
      setConfirmKey('');
      await refresh();
      notify?.('已删掉这一条');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusyKey('');
    }
  }

  /**
   * 切到「私密日记」模块时**显式**取一次密钥状态。
   *
   * ★ 这是一次明确的用户动作，所以可以碰钥匙串；页脚那种高频路径不许碰。
   *   取不到要说出来：`mode: 'file'` 意味着「防得住拷走和同步，防不住有人用你这台
   *   已解锁的 Mac 打开」。
   */
  useEffect(() => {
    if (moduleValue !== 'private') return;
    let alive = true;
    fetchDiarySecret()
      .then((status) => { if (alive) setSecret({ mode: status.mode ?? '', error: status.error ?? '' }); })
      .catch((cause) => { if (alive) setSecret({ mode: 'error', error: cause.message }); });
    return () => { alive = false; };
  }, [moduleValue]);

  /**
   * 「AI 整理这一天」。
   *
   * ★ `setDiaryContext` **不传 `target`** —— 那是整天模式的开关（见 `diaryContext`：
   *   `target === null` 时开场白直接写「处理对象是这一天的日记整体」）。
   *   传了 `target` 就退回「一条一条整理」，正是用户 2026-10-27 否掉的做法。
   */
  async function tidyDay() {
    if (aiRef.current) return;
    aiRef.current = true;
    setAiKey('day');
    setChatError('');
    let acquired = null;
    try {
      const workspaceId = api.defaultChatWorkspace?.();
      if (!workspaceId) throw new Error('先在 Harness 里打开一个工作区，再回来整理');
      acquired = await api.openChat({ workspaceId });
      await api.setDiaryContext({ sessionId: acquired.sessionId, date: selected });
      chatRef.current?.release?.();
      chatRef.current = acquired;
      setChat(acquired);
      acquired = null;
      await chatRef.current.sendPrompt(AI_DAY_PROMPT);
    } catch (cause) {
      acquired?.release?.();
      setChatError(cause?.message ?? String(cause));
    } finally {
      aiRef.current = false;
      setAiKey('');
    }
  }

  /** 读后感按篇整理（一篇读后感本身就是一整篇文档，不存在「按天整理」）。 */
  async function tidyEntry(entry) {
    const key = entryKey(entry);
    if (aiRef.current) return;
    aiRef.current = true;
    setAiKey(key);
    setChatError('');
    let acquired = null;
    try {
      const workspaceId = api.defaultChatWorkspace?.();
      if (!workspaceId) throw new Error('先在 Harness 里打开一个工作区，再回来整理');
      acquired = await api.openChat({ workspaceId });
      await api.setDiaryContext({ sessionId: acquired.sessionId, date: entry.date ?? selected, target: entry.index });
      chatRef.current?.release?.();
      chatRef.current = acquired;
      setChat(acquired);
      acquired = null;
      await chatRef.current.sendPrompt(AI_ENTRY_PROMPT);
    } catch (cause) {
      acquired?.release?.();
      setChatError(cause?.message ?? String(cause));
    } finally {
      aiRef.current = false;
      setAiKey('');
    }
  }

  function closeChat() {
    chatRef.current?.release?.();
    chatRef.current = null;
    setChat(null);
    setChatError('');
  }

  async function runSearch(query) {
    if (query.trim() === '') { setSearch((current) => ({ ...current, hits: [], scanned: 0, truncated: false })); return; }
    setSearch((current) => ({ ...current, busy: true }));
    try {
      const payload = await searchDiary(query, 40);
      setSearch((current) => ({ ...current, hits: payload.hits ?? [], scanned: payload.scanned ?? 0, truncated: payload.truncated === true, busy: false }));
    } catch (cause) {
      setError(cause.message);
      setSearch((current) => ({ ...current, busy: false }));
    }
  }

  /** 点一个标签 = 搜 `#标签`（宿主侧的搜索就是正文子串，标签本来就在正文里）。 */
  function searchTag(tag) {
    const query = `#${tag}`;
    setSearch((current) => ({ ...current, open: true, query }));
    void runSearch(query);
  }

  async function reveal() {
    try {
      const result = await revealDiaryFolder();
      notify?.(`已打开 ${result?.dir ?? '日记文件夹'}`);
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function exportAll() {
    try {
      const payload = await fetchDiaryExport();
      if (!payload.total) { notify?.('还没有日记可以导出'); return; }
      downloadDiaryBundle(payload.files, today);
      notify?.(`已导出 ${payload.total} 天${payload.skippedPrivate > 0 ? `（私密 ${payload.skippedPrivate} 天没导出）` : ''}`);
    } catch (cause) {
      setError(cause.message);
    }
  }

  /**
   * 连私密一起导出。**两次点击**：第一次只是「上膛」。
   * ★ 不能一次点完：那条路把明文写进浏览器下载目录，而那个目录会被 iCloud /
   *   备份 / 剪贴板同步到别处 —— 正好是加密层要防的第一件事。
   */
  async function exportWithPrivate() {
    if (!exportArmed) { setExportArmed(true); return; }
    setExportArmed(false);
    try {
      const payload = await fetchDiaryExport({ includePrivate: true });
      if (!payload.total) { notify?.('还没有日记可以导出'); return; }
      downloadDiaryBundle(payload.files, today);
      notify?.(`已导出 ${payload.total} 天（含私密明文）`
        + `${payload.skippedPrivate > 0 ? `，另有 ${payload.skippedPrivate} 天解不开` : ''}`);
    } catch (cause) {
      setError(cause.message);
    }
  }

  /** 把一条划线引用进读后感正文（插在光标处，包成 Markdown 引用块）。 */
  function quoteAnnotation(item) {
    const page = Number.isInteger(item.page) ? `（第 ${item.page} 页）` : '';
    const snippet = `> ${String(item.quote ?? '').replace(/\n+/g, ' ').trim()}${page}\n\n`;
    const textarea = refRef.current;
    const at = textarea?.selectionStart ?? refDraft.length;
    const next = `${refDraft.slice(0, at)}${snippet}${refDraft.slice(at)}`;
    setRefDraft(next);
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = at + snippet.length;
      textarea.selectionEnd = at + snippet.length;
    });
  }

  const startDrag = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    let width = listWidth;
    const move = (moveEvent) => {
      width = Math.round(Math.min(Math.max(listWidth + moveEvent.clientX - startX, 220), 420));
      setListWidth(width);
    };
    const up = () => {
      localStorage.setItem('npr.diaryListWidth', String(width));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- 派生数据 ---------------------------------------------------------

  /** 灵感模块只显示「灵感」（老数据里的「书摘」也算灵感流，别让它消失）。 */
  const inspirationEntries = day.entries.filter((entry) => entry.scope === 'public' && entry.kind !== '读后感');
  const privateEntries = day.entries.filter((entry) => entry.scope === 'private');
  const visibleEntries = moduleValue === 'private' ? privateEntries : inspirationEntries;

  /** ★ 只数**私密**那一边。用合计会让私密日历上的点跟着灵感一起亮（用户报的就是这个）。 */
  const privateDays = marks.privateDays ?? {};
  const writtenDays = Object.entries(privateDays)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[0].localeCompare(left[0]));

  /** `date → 1..5`，给日历上那粒点上色。没记过心情的日期没有键。 */
  const privateTones = useMemo(() => {
    const out = {};
    for (const [date, cell] of Object.entries(marks.moods ?? {})) {
      if (cell?.private) out[date] = cell.private;
    }
    return out;
  }, [marks.moods]);

  /** 灵感侧栏的「最近写过」：只给日期 + 条数 + 那天第一个心情，不再抄一遍正文。 */
  const recentDays = timeline.days
    .map((item) => {
      const ideas = (item.entries ?? []).filter((entry) => entry.kind !== '读后感' && entry.scope === 'public');
      return { date: item.date, count: ideas.length, mood: firstMood(...ideas.map((entry) => entry.mood)) };
    })
    .filter((item) => item.count > 0);

  const linked = linkedBooks(timeline.days);

  const filteredBooks = books.items.filter((item) => (
    bookQuery.trim() === '' || item.title.toLowerCase().includes(bookQuery.trim().toLowerCase())
  ));
  const readBooks = filteredBooks.filter((item) => stateOf(item.id) === 'read');
  const unreadBooks = filteredBooks.filter((item) => stateOf(item.id) !== 'read');

  /**
   * 书籍档案卡上的数。**全部来自已经在手的数据**，打开一本书不额外多读一次盘。
   * ★ 「摘录笔记」= 划线里**写过 note 的**那些：只有 quote 的是划线，加了 note 才是笔记。
   *   这两个数在界面上必须分开，否则「划线 12」会让人以为写了 12 条笔记。
   */
  const noteCount = annotations.items.filter((item) => String(item.note ?? '').trim() !== '').length;
  const reflectionChars = bookEntries.items.reduce(
    (sum, entry) => sum + String(entry.body ?? '').replace(/\s/g, '').length,
    0,
  );
  const readLabel = bookStates[book?.id]?.pages
    ? `${bookStates[book.id].page ?? 1} / ${bookStates[book.id].pages}`
    : '未开始';

  /** 顶栏的两行字：一级是「哪天 / 哪本书」，二级是这一页的事实。 */
  const headTitle = moduleValue === 'reflection'
    ? (book ? `《${book.title}》` : '读后感')
    : dayLabel(selected, today);
  const headSub = moduleValue === 'reflection'
    ? (book
      ? [book.readable ? '已读完' : '还没读完', `${annotations.items.length} 条划线`, `${bookEntries.items.length} 篇读后感`].join(' · ')
      : '只对标记为「读完」的书开放')
    : [
      selected,
      `${visibleEntries.length} 条`,
      `${day.chars} 字`,
      moduleValue === 'private' ? '本地加密' : '',
    ].filter(Boolean).join(' · ');

  const showSearchResults = search.open && search.query.trim() !== '';

  return (
    <div className={`npr-workarea${chat ? ' has-companion' : ''}`}>
      <div className="npr-layout" style={{ '--npr-list-width': `${listWidth}px` }}>
        <aside className="npr-sidebar">
          {/* ★ 这一条 `data-window-drag` 是**布局必需**：没有它，在日记页按住空白处拖不动窗口。 */}
          <div className="npr-sidebar-toolbar" data-window-drag>
            <ViewSwitch mode="diary" onChange={(next) => { if (next !== 'diary') onExit?.(next); }} showLibrary />
            <button type="button" className="npr-icon" title="搜索日记" aria-label="搜索日记"
              onClick={() => setSearch((current) => ({ ...current, open: !current.open }))}><Icon name="search" /></button>
            <button type="button" className="npr-icon" title="打开日记文件夹" aria-label="打开日记文件夹" onClick={() => void reveal()}><Icon name="folder" /></button>
            <button type="button" className="npr-icon" title="导出全部日记（单文件 Markdown）" aria-label="导出全部日记" onClick={() => void exportAll()}><Icon name="download" /></button>
          </div>

          {/* 三个功能模块 —— 这是这一页的主结构，不是「条目类型」。 */}
          <div className="npr-diary-modes" role="group" aria-label="日记功能">
            {DIARY_MODULES.map((item) => (
              <button key={item.value} type="button" aria-pressed={moduleValue === item.value}
                onClick={() => setModuleValue(item.value)}>{item.label}</button>
            ))}
          </div>

          <div className={`npr-search-box${search.open ? '' : ' is-hidden'}`}>
            <input type="search" aria-label="搜索日记" placeholder="搜一句话、一个名字…" value={search.query}
              onChange={(event) => { const value = event.target.value; setSearch((current) => ({ ...current, query: value })); void runSearch(value); }}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setSearch((current) => ({ ...current, open: false, query: '', hits: [] })); } }} />
          </div>
          <div className={`npr-status${error ? ' is-error' : ''}`} role="status" aria-live="polite">{error}</div>

          {showSearchResults ? (
            <div className="npr-list">
              {search.busy && <div className="npr-empty">正在找…</div>}
              {!search.busy && search.hits.length === 0 && (
                <div className="npr-empty">
                  <p>日记里没有提到「{search.query}」。</p>
                  <p>在最近 {search.scanned} 天里找过{search.truncated ? '，更早的没有看' : ''}。</p>
                </div>
              )}
              {search.hits.map((hit) => (
                <button key={`${hit.date}-${hit.scope}-${hit.index}`} type="button" className="npr-diary-hit"
                  onClick={() => jump(hit.date)}>
                  <span className="npr-diary-hit-meta">
                    {hit.date} · {hit.time} · {hit.kind}{hit.scope === 'private' ? ' · 私密' : ''}
                  </span>
                  <span className="npr-diary-hit-text">{hit.snippet}</span>
                </button>
              ))}
            </div>
          ) : moduleValue === 'inspiration' ? (
            /*
             * 灵感侧栏 = 三块**检索器**，不是一份内容列表。
             *
             * ★ 0.31.0 这里是一份「最近 30 天、每天每条的时间 + 正文前 160 字」。
             *   那是把右边的正文抄了一遍：既没有提供「按标签检索」，也没有提供
             *   「按时间轴检索」—— 它只提供了「按日期跳转」，却占满了整栏。
             *   用户 2026-10-27 的原话是「实在是不符合常理」，说的就是这个。
             */
            <div className="npr-diary-panel">
              <section className="npr-diary-sect">
                <h3 className="npr-diary-sect-head">标签</h3>
                {tagIndex.busy && <p className="npr-diary-sect-note">正在数标签…</p>}
                {!tagIndex.busy && tagIndex.tags.length === 0 && (
                  <p className="npr-diary-sect-note">正文里写 #灵感 这样的词，它就会出现在这里。</p>
                )}
                <div className="npr-diary-cloud">
                  {tagIndex.tags.slice(0, 24).map((item) => (
                    <button key={item.tag} type="button" className="npr-diary-tagchip"
                      title={`${item.count} 次，最后用在 ${item.last}`}
                      onClick={() => searchTag(item.tag)}>
                      <span>#{item.tag}</span>
                      <span className="npr-diary-tagcount">{item.count}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="npr-diary-sect">
                <h3 className="npr-diary-sect-head">最近写过</h3>
                {timeline.busy && <p className="npr-diary-sect-note">正在读…</p>}
                {!timeline.busy && recentDays.length === 0 && (
                  <p className="npr-diary-sect-note">还没有灵感。右边写一句就行。</p>
                )}
                {recentDays.map((item) => (
                  <button key={item.date} type="button"
                    className={`npr-diary-dayrow${item.date === selected ? ' npr-selected' : ''}`}
                    aria-pressed={item.date === selected} onClick={() => jump(item.date)}>
                    <span className="npr-diary-dayrow-date">{dayLabel(item.date, today)}</span>
                    {item.mood && <span className="npr-diary-dayrow-mood" aria-hidden="true">{item.mood}</span>}
                    <span className="npr-diary-dayrow-count">{item.count} 条</span>
                  </button>
                ))}
                {timeline.truncated && <p className="npr-diary-sect-note">只看了最近 {timeline.days.length} 天。</p>}
              </section>

              {linked.length > 0 && (
                <section className="npr-diary-sect">
                  <h3 className="npr-diary-sect-head">挂在书上</h3>
                  <p className="npr-diary-sect-note">读书时按 L 记的灵感，自动挂到那本书上。</p>
                  {linked.map((item) => (
                    <button key={item.title} type="button" className="npr-diary-dayrow"
                      title={`《${item.title}》· 最近一条在 ${item.last}`}
                      onClick={() => jump(item.last)}>
                      <span className="npr-diary-dayrow-date">《{item.title}》</span>
                      <span className="npr-diary-dayrow-count">{item.count} 条</span>
                    </button>
                  ))}
                </section>
              )}
            </div>
          ) : moduleValue === 'private' ? (
            <div className="npr-diary-panel">
              <DiaryCalendar year={month.year} month0={month.month0} marks={privateDays} tones={privateTones}
                selected={selected} today={today}
                onPick={pick} onShift={(delta) => setMonth(shiftMonth(month.year, month.month0, delta))} onToday={() => pick(today)} />
              <section className="npr-diary-sect">
                <h3 className="npr-diary-sect-head">这个月</h3>
                {writtenDays.length === 0 && <p className="npr-diary-sect-note">这个月还没有私密日记。</p>}
                {writtenDays.map(([date, count]) => {
                  const tone = marks.moods?.[date]?.private;
                  return (
                    <button key={date} type="button" className={`npr-diary-dayrow${date === selected ? ' npr-selected' : ''}`}
                      aria-pressed={date === selected} onClick={() => pick(date)}>
                      <span className="npr-diary-dayrow-date">{dayLabel(date, today)}</span>
                      {tone > 0 && (
                        <span className="npr-diary-dayrow-mood" aria-hidden="true">{MOODS.find((item) => item.tone === tone)?.emoji}</span>
                      )}
                      <span className="npr-diary-dayrow-count">{count} 条</span>
                    </button>
                  );
                })}
              </section>
            </div>
          ) : (
            <div className="npr-diary-panel">
              <div className="npr-search-box">
                <input type="search" aria-label="找一本书" placeholder="找一本书…" value={bookQuery}
                  onChange={(event) => setBookQuery(event.target.value)} />
              </div>
              {books.busy && <p className="npr-diary-sect-note">正在读书架…</p>}
              {!books.busy && books.error !== '' && <p className="npr-diary-sect-note is-error">{books.error}</p>}

              {!books.busy && books.error === '' && (
                <section className="npr-diary-sect">
                  <h3 className="npr-diary-sect-head">读完的<span className="npr-diary-sect-badge">{readBooks.length}</span></h3>
                  {readBooks.length === 0 && (
                    <p className="npr-diary-sect-note">还没有读完的书。在书架里读完一本、点「标记读完」，它就会出现在这里。</p>
                  )}
                  {readBooks.map((item) => (
                    <button key={item.id} type="button"
                      className={`npr-diary-dayrow${book?.id === item.id ? ' npr-selected' : ''}`}
                      aria-pressed={book?.id === item.id} title={item.title}
                      onClick={() => void openBook(item)}>
                      <span className="npr-diary-dayrow-date">{item.title}</span>
                      <span className="npr-diary-dayrow-count">{item.ext}</span>
                    </button>
                  ))}
                </section>
              )}

              {!books.busy && books.error === '' && unreadBooks.length > 0 && (
                <section className="npr-diary-sect is-muted">
                  <h3 className="npr-diary-sect-head">还没读完<span className="npr-diary-sect-badge">{unreadBooks.length}</span></h3>
                  <p className="npr-diary-sect-note">读后感只对读完的书开放 —— 读完并标记之后才能写。</p>
                  {unreadBooks.map((item) => (
                    <button key={item.id} type="button" className="npr-diary-dayrow" disabled
                      title={`《${item.title}》还没标记读完`}>
                      <span className="npr-diary-dayrow-date">{item.title}</span>
                      <span className="npr-diary-dayrow-count">未读完</span>
                    </button>
                  ))}
                </section>
              )}

              {!books.busy && books.error === '' && filteredBooks.length === 0 && (
                <p className="npr-diary-sect-note">书架里没有匹配的书。</p>
              )}
              {books.truncated && (
                <p className="npr-diary-sect-note">书架只列出了前 {books.items.length} 本（共 {books.total} 本），用上面的搜索框找。</p>
              )}
            </div>
          )}
        </aside>
        <div className="npr-resize" role="separator" aria-orientation="vertical" onPointerDown={startDrag}
          onDoubleClick={() => { setListWidth(268); localStorage.setItem('npr.diaryListWidth', '268'); }} />
        <section className="npr-reader npr-diary-reader">
          {/* 右侧整块也要一条拖动区：三种模块下，面板顶部都是同一条线。 */}
          <div className="npr-book-toolbar" data-window-drag>
            <div className="npr-diary-head">
              <h1 className="npr-diary-h1">{headTitle}</h1>
              <p className="npr-diary-sub">{headSub}</p>
            </div>
            {/* ★ 「AI 整理这一天」是**日期栏上的一个动作**，不是每一条上的按钮。
                用户 2026-10-27：「AI 整理是整理当天的全部记录，不是一条记录一个 AI 整理」。
                私密模块没有它 —— 模型读不到私密那半边（见文件头）。 */}
            {moduleValue === 'inspiration' && (
              <button type="button" className="npr-diary-ai" disabled={aiKey !== '' || inspirationEntries.length === 0}
                title={inspirationEntries.length === 0 ? '今天还没有可整理的灵感' : '把今天所有灵感一起交给 AI 整理'}
                onClick={() => void tidyDay()}>
                <Icon name="wand-sparkles" size={13} />
                <span>{aiKey === 'day' ? '正在打开…' : 'AI 整理这一天'}</span>
              </button>
            )}
          </div>

          <div className="npr-diary-main">
            <div className="npr-diary-scroll">
              {/* 正文宽度约束：一行 70 个汉字没人读得下去。40em ≈ 600px ≈ 40 个汉字。 */}
              <div className="npr-diary-sheet">
                {/* ---- 写入口：三种模块三种形态 ------------------------------ */}
                {moduleValue === 'inspiration' && (
                  <section className="npr-diary-write">
                    <textarea ref={draftRef} className="npr-diary-input npr-diary-input-quick" value={draft} aria-label="灵感"
                      placeholder="这一刻想到什么？写 #标签 可以自动归类。"
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void saveQuick(); } }} />
                    <MoodRow value={mood} onChange={setMood} label="此刻的心情" />
                    <div className="npr-diary-writefoot">
                      <span className="npr-diary-foot-hint">{draft.replace(/\s/g, '').length} 字 · ⌘/Ctrl + Enter</span>
                      <button type="button" className="npr-diary-save" onClick={() => void saveQuick()} disabled={saving || draft.trim() === ''}>
                        {saving ? '正在保存…' : '记下来'}
                      </button>
                    </div>
                  </section>
                )}

                {moduleValue === 'private' && (
                  <section className="npr-diary-write">
                    <textarea ref={draftRef} className="npr-diary-input" value={draft} aria-label="私密日记"
                      placeholder="这一页只留在本机，写进加密文件。"
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void saveQuick(); } }} />
                    <MoodRow value={mood} onChange={setMood} label="今天的心情" />
                    <div className="npr-diary-writefoot">
                      <span className="npr-diary-foot-hint">{draft.replace(/\s/g, '').length} 字 · ⌘/Ctrl + Enter</span>
                      <button type="button" className="npr-diary-save" onClick={() => void saveQuick()} disabled={saving || draft.trim() === ''}>
                        {saving ? '正在保存…' : '记下来'}
                      </button>
                    </div>
                    {/* 加密说明只在**出错**时展开；正常态收成一行 —— 它每次都在，
                        常驻三行会把写日记的地方挤掉。
                        ★ 不带 🔒 之类的 emoji：这一行是 11px 的辅助说明，
                          彩色 emoji 在这个尺寸下只剩一个说不清颜色的色块
                          （用户上一轮刚说过「emoji 很不明显」）。
                          左边那道竖线 + 淡底已经把「这是一条旁注」表达完了。 */}
                    <p className={`npr-diary-secret${secret.error ? ' is-error' : ''}`} role="status">
                      {secret.error
                        ? `密钥不可用：${secret.error}`
                        : secret.mode === 'file'
                          ? '密钥在本地文件里：防得住拷走与网盘同步，防不住有人用这台已解锁的 Mac 打开。'
                          : '写进 private/ 下的加密文件（AES-256-GCM），密钥在登录钥匙串里。私密条目不进模型。'}
                    </p>
                  </section>
                )}

                {moduleValue === 'reflection' && (
                  book ? (
                    book.readable ? (
                      <section className="npr-diary-write">
                        {/* 书籍档案卡：这本书读过多少、划过多少、写过多少。五个数全部是
                            已有的计量，没有为它新加任何埋点。 */}
                        <div className="npr-diary-dossier" role="group" aria-label="这本书的档案">
                          <span className="npr-diary-dossier-cell">
                            <strong>{annotations.items.length}</strong><span>划线</span>
                          </span>
                          <span className="npr-diary-dossier-cell">
                            <strong>{noteCount}</strong><span>摘录笔记</span>
                          </span>
                          <span className="npr-diary-dossier-cell">
                            <strong>{bookEntries.items.length}</strong><span>读后感</span>
                          </span>
                          <span className="npr-diary-dossier-cell">
                            <strong>{reflectionChars}</strong><span>字</span>
                          </span>
                          <span className="npr-diary-dossier-cell"
                            title="来自书架的阅读进度。插件没有计时器，所以这里没有「阅读时长」这一格。">
                            <strong>{readLabel}</strong><span>读到</span>
                          </span>
                        </div>
                        <textarea ref={refRef} className="npr-diary-input npr-diary-input-tall" value={refDraft} aria-label="读后感"
                          placeholder="一句话总结、核心收获、行动指南、金句摘录 —— 或者就写你想写的。"
                          onChange={(event) => setRefDraft(event.target.value)}
                          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void saveReflection(); } }} />
                        <div className="npr-diary-writefoot">
                          <span className="npr-diary-foot-hint">
                            {refDraft.replace(/\s/g, '').length} 字
                          </span>
                          <button type="button" className="npr-diary-linkish" onClick={() => setRefDraft(REFLECTION_TEMPLATE)}>套用模板</button>
                          <button type="button" className="npr-diary-linkish" onClick={() => setRefDraft('')}>清空</button>
                          <button type="button" className="npr-diary-save" onClick={() => void saveReflection()} disabled={saving || refDraft.trim() === ''}>
                            {saving ? '正在保存…' : '记下来'}
                          </button>
                        </div>
                      </section>
                    ) : (
                      <div className="npr-diary-blocked">
                        <p><strong>《{book.title}》还没标记读完。</strong></p>
                        <p>读后感只对读完的书开放 —— 回到书架，读完并点顶部那颗「标记读完」，再回来这里写。</p>
                      </div>
                    )
                  ) : (
                    <div className="npr-diary-blank">
                      <p>先在左边选一本书。</p>
                      <p>左边只列**读完**的书 —— 没读完的书，左边是灰的。</p>
                      <p>也可以反过来：在书里读着读着，点顶部那颗「写读后感」，直接带着这本书落到这一页。</p>
                    </div>
                  )
                )}

                {/* ---- 条目列表 --------------------------------------------- */}
                {moduleValue !== 'reflection' && (
                  <>
                    {loading && <div className="npr-empty">正在读这一天…</div>}
                    {!loading && visibleEntries.length === 0 && (
                      <div className="npr-diary-blank">
                        <p>{moduleValue === 'private' ? '这一天还没有私密日记。' : '这一天还没有灵感。'}</p>
                        <p>{moduleValue === 'private'
                          ? '上面写一句就行。私密的只留在本机，不同步、不进模型。'
                          : '上面写一句就行 —— 灵感多半是半句话。'}</p>
                      </div>
                    )}
                    {visibleEntries.map((entry) => {
                      const html = renderBody(entry.body);
                      const tags = parseTags(entry.body);
                      const privateSide = entry.scope === 'private';
                      const key = entryKey(entry);
                      const entryMood = firstMood(entry.meta?.mood);
                      return (
                        <article className="npr-diary-entry" key={key}>
                          <header className="npr-diary-entry-head">
                            <span className="npr-diary-time">{entry.time}</span>
                            {/* 只在**类型与模块不一致**时标出来：0.30 写过「书摘」的老条目
                                会落在灵感流里，标一下才不会被误读成普通灵感。 */}
                            {entry.kind !== mod.kind && <span className="npr-diary-kind">{entry.kind}</span>}
                            {entryMood && (
                              <span className="npr-diary-mood" title="这一条记下的心情">{entryMood}</span>
                            )}
                            {privateSide && <span className="npr-diary-lock" title="私密：本地加密存储">私密</span>}
                            {entry.source && <span className="npr-diary-source-tag" title={entry.source}>引自 {entry.source}</span>}
                            <span className="npr-diary-entry-actions">
                              {confirmKey === key ? (
                                <button type="button" className="npr-diary-action is-danger" disabled={busyKey !== ''}
                                  onClick={() => void removeAt(entry)}>
                                  {busyKey === key ? '正在删除…' : '确认删除'}
                                </button>
                              ) : (
                                <button type="button" className="npr-diary-action" title="删掉这一条" aria-label="删掉这一条"
                                  onClick={() => setConfirmKey(key)}><Icon name="trash-2" size={13} /></button>
                              )}
                            </span>
                          </header>
                          {html
                            ? <div className="npr-diary-body" dangerouslySetInnerHTML={{ __html: html }} />
                            : <p className="npr-diary-body npr-diary-body-plain">{entry.body}</p>}
                          {tags.length > 0 && (
                            <div className="npr-diary-tagrow">
                              {tags.map((tag) => (
                                <button key={tag} type="button" className="npr-diary-tag"
                                  title={`找所有带 #${tag} 的日记`} onClick={() => searchTag(tag)}>#{tag}</button>
                              ))}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </>
                )}

                {moduleValue === 'reflection' && book && (
                  <>
                    {bookEntries.busy && <div className="npr-empty">正在读这本书的读后感…</div>}
                    {!bookEntries.busy && bookEntries.items.length === 0 && (
                      <div className="npr-diary-blank"><p>这本书还没有读后感。</p></div>
                    )}
                    {bookEntries.items.map((entry) => {
                      const html = renderBody(entry.body);
                      const key = entryKey(entry);
                      const entryMood = firstMood(entry.mood);
                      return (
                        <article className="npr-diary-entry" key={`${entry.date}-${key}`}>
                          <header className="npr-diary-entry-head">
                            <span className="npr-diary-time">{entry.date} {entry.time}</span>
                            {entryMood && <span className="npr-diary-mood" title="写这一篇时的心情">{entryMood}</span>}
                            <span className="npr-diary-entry-actions">
                              <button type="button" className="npr-diary-action" title="让 AI 整理这一篇" disabled={aiKey !== ''}
                                onClick={() => void tidyEntry(entry)}>
                                {aiKey === key ? '正在打开…' : 'AI 整理这一篇'}
                              </button>
                              {confirmKey === key ? (
                                <button type="button" className="npr-diary-action is-danger" disabled={busyKey !== ''}
                                  onClick={() => void removeAt(entry)}>
                                  {busyKey === key ? '正在删除…' : '确认删除'}
                                </button>
                              ) : (
                                <button type="button" className="npr-diary-action" title="删掉这一篇" aria-label="删掉这一篇"
                                  onClick={() => setConfirmKey(key)}><Icon name="trash-2" size={13} /></button>
                              )}
                            </span>
                          </header>
                          {html
                            ? <div className="npr-diary-body" dangerouslySetInnerHTML={{ __html: html }} />
                            : <p className="npr-diary-body npr-diary-body-plain">{entry.body}</p>}
                        </article>
                      );
                    })}
                  </>
                )}

                {stats && (
                  <p className="npr-diary-foot">
                    日记共 {stats.days} 天{stats.privateDays > 0 ? `（私密 ${stats.privateDays} 天）` : ''} · {(stats.bytes / 1024).toFixed(0)} KB · 存在 {stats.root}
                    {stats.privateDays > 0 && (
                      <button type="button" className="npr-diary-linkish" onClick={() => void exportWithPrivate()}>
                        {exportArmed ? '再点一次：明文会写进下载目录' : '连私密一起导出'}
                      </button>
                    )}
                  </p>
                )}
              </div>
            </div>

            {/* 读后感工作台的划线侧栏：这一整块只在这个模块出现。 */}
            {moduleValue === 'reflection' && book && (
              <aside className="npr-diary-marks" aria-label="这本书的划线">
                <header className="npr-diary-marks-head">
                  <strong>划线</strong>
                  <span>{annotations.items.length} 条</span>
                </header>
                {annotations.busy && <div className="npr-empty">正在读划线…</div>}
                {!annotations.busy && annotations.error !== '' && (
                  <div className="npr-empty"><p>划线取不到：{annotations.error}</p></div>
                )}
                {!annotations.busy && annotations.error === '' && annotations.items.length === 0 && (
                  <div className="npr-empty"><p>这本书还没有划线。</p><p>在书里选中一段就能划线。</p></div>
                )}
                {annotations.items.map((item) => (
                  <div className="npr-diary-mark" key={item.id ?? `${item.page}-${item.start}`}>
                    <p className="npr-diary-mark-quote">{item.quote}</p>
                    {item.note && <p className="npr-diary-mark-note">{item.note}</p>}
                    <div className="npr-diary-mark-foot">
                      <span>{Number.isInteger(item.page) ? `第 ${item.page} 页` : ''}</span>
                      <button type="button" className="npr-diary-action" disabled={!book.readable}
                        onClick={() => quoteAnnotation(item)}>引用</button>
                    </div>
                  </div>
                ))}
              </aside>
            )}
          </div>
        </section>
      </div>

      {chat && (
        <aside className="npr-companion" aria-label="AI 整理">
          <header className="npr-companion-header">
            <strong>AI 整理</strong>
            <button type="button" className="npr-icon" title="关闭" aria-label="关闭 AI 整理" onClick={closeChat}><Icon name="x" /></button>
          </header>
          <div className="npr-companion-context">
            <strong>{dayLabel(selected, today)}</strong>
            <small>上下文引用的是这一天的全部记录；整理稿只在这里给你看，不会写回日记。</small>
          </div>
          {chatError && <div className="npr-companion-error" role="alert"><strong>没能开始整理</strong><p>{chatError}</p></div>}
          {SessionProvider && (
            <div className="npr-native-chat">
              <SessionProvider session={chat.reference}>{renderSlot('npie-reader.chat', {})}</SessionProvider>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
