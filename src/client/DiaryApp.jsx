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
 * ★ 0.34（2026-10-27 第二轮真机反馈）改了四件事，都是「看起来在工作、其实没有」：
 *   ① `setDiaryContext(request = {})` 的**默认参数**让宿主的 typert 网关拒绝生成调用桩，
 *      于是「AI 整理这一天」点下去只回一句英文错误。签名去掉默认值即可（见 service.js）。
 *   ② 读后感页面底部挂着「日记共 4 天 · 存在 ~/.dsh/…」—— 同一个页脚覆盖了三个模块，
 *      就必然在其中一个里是错的。
 *   ③ 私密日记原来是**屏幕遮罩**：宿主解密、正文进 DOM、点一下就显示。用户原话
 *      「点击就能查看还有什么私密」。现在改成宿主侧口令闸门（`diary-gate.js`）。
 *   ④ 写入口重做成 `DiaryComposer`（工具栏 + 预览 + 自动长高），并去掉那圈绿色
 *      focus outline 与灰底盒子。
 *
 * ★ 私密条目**不给「AI 整理」**：宿主的 `setDiaryContext` 读的是公开那半边，
 *   按钮能点的话模型看到的会是同一天的另一段内容。这是边界，不是没做。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sanitizeHtml } from '../host/sanitize.js';
import { markdownToHtml } from '../host/markdown.js';
import {
  DIARY_MODULES, MOODS, REFLECTION_TEMPLATE, dateKey, monthKeyOf, normalizeMood, parseMonthKey,
  parseTags, shiftMonth,
} from '../diary-format.js';
import {
  appendDiaryEntry, downloadDiaryBundle, fetchDiaryBook, fetchDiaryDay, fetchDiaryExport,
  fetchDiaryGate, fetchDiaryMonth, fetchDiarySecret, fetchDiaryStats, fetchDiaryTags, fetchDiaryTimeline,
  lockDiaryGate, removeDiaryEntry, revealDiaryFolder, searchDiary, setupDiaryGate, unlockDiaryGate,
} from './diary-api.js';
import { fetchAnnotations, fetchBooks, fetchStates } from './library-api.js';
import { DiaryCalendar } from './DiaryCalendar.jsx';
import { DiaryComposer } from './DiaryComposer.jsx';
import { ensureStyles } from './ReaderPage.jsx';
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
 * 一条记录的正文：**最多三行**，多出来的收在「展开全文」后面。
 *
 * 用户 2026-10-27：「已留存的记录展示区域。设置个显示规则，每条内容最多显示三行，
 * 如果内容过多，就有一个展开更多的查看的窗口。」
 *
 * 为什么是「量出来」而不是「数字数」：
 *   - 数字数得先按显示宽度折行（600px 的栏里 15px 字 ≈ 40 字/行，窄一点就变了），
 *     而面板宽度是**可拖的**，同一个字数在不同宽度下是 3 行还是 4 行说不准；
 *   - CSS 的 `-webkit-line-clamp: 3` 直接按排版结果截，宽度怎么变都还是三行。
 *   所以截断交给 CSS，**「要不要给按钮」交给实测**（`scrollHeight > clientHeight`）。
 *   ★ 不做「字数不够就不 clamp」的判断：一条 60 字的记录在窄栏里可能就有四行了。
 * ★ `ResizeObserver` 是必需的：拖动侧栏、拖 AI 面板、切窗口都会改宽度，
 *   只测一次会留下「明明能放下却还给着展开按钮」的残留。
 */
function EntryBody({ html, text, onExpand }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => setOver(node.scrollHeight - node.clientHeight > 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [html, text]);

  return (
    <>
      {/*
        * 两个分支合成**一个元素**：clamp 用的是 `display:-webkit-box`，
        * 夹在一个外层容器上会连内层的块级子元素一起算，行数就不准了。
        */}
      <div
        ref={ref}
        className={`npr-diary-body npr-diary-clamp${html ? '' : ' npr-diary-body-plain'}`}
        {...(html ? { dangerouslySetInnerHTML: { __html: html } } : { children: text })} />
      {over && (
        <button type="button" className="npr-diary-more" onClick={onExpand}>
          展开全文
          <Icon name="chevron-down" size={12} />
        </button>
      )}
    </>
  );
}

/**
 * 「AI 整理这一天」的提示词。
 *
 * ★ **不要闷头写回**（0.32.0 的教训）。旧提示词让模型 `diary_append` 一条整理稿到
 *   **同一天**，于是下一次「整理今天」会把上一次的整理稿当成原材料再整理一遍 ——
 *   越滚越不像自己写的，而且原文与整理稿在同一个文件里长得一样，用户分不清哪条是
 *   自己写的。
 * ★ 但「不能写回」也是错的（2026-10-27 用户：「AI 整理为什么只能往灵感里追加新条目，
 *   不能改也不能删。我需要的是能改能删」）。现在工具侧有了 `diary_update` /
 *   `diary_delete`，所以这里改成**两步**：先给整理稿，等我点头再原地改。
 *   一句话说清「改哪几条、删哪几条」，不要追加一份副本。
 */
const AI_DAY_PROMPT = [
  '帮我整理**今天这一整天**的记录（上下文里给了这一天所有的条目，不是某一条）。',
  '保留我的原意和语气，把没说清的地方说清楚，不要编我没写过的事。',
  '几条说的是同一件事就并成一条；只有半句的碎片可以只留一句更准的话。',
  '先把整理稿给我看，并写清打算怎么落到日记里：哪一条用 diary_update 改写、哪几条用 diary_delete 删掉。',
  '我说「就这样」你再动手；不要追加一份新的副本 —— 原文要么被改，要么被删，不要在旁边多出一条。',
].join('\n');

/**
 * 面板里的快捷提示词 —— 与 AI 伴读那排胶囊同一个位置、同一个交互（点一下直接发）。
 *
 * ★ 第一条就是原来「AI 整理这一天」自动发出去的那句，所以「点按钮」这个动作
 *   并没有丢：只是从「打开就发」变成「看得见才发」。
 */
/**
 * 侧栏里**内联**铺几个标签。
 *
 * ★ 6 个是「一眼扫完、不用滚」的量：侧栏 268px 宽，三行 chips 就到头了。
 *   用户 2026-10-27 第三次追问「几千个标签怎么办」，问的其实不是「铺几个」——
 *   268px 的栏在任何阈值下都装不下几千个。所以内联只负责「最近在用的几个」，
 *   完整清单走 `全部 N 个 ›` 打开浮层（阅读区那么大，才放得下搜索 + 分组）。
 */
const TAG_SIDE = 6;

/**
 * 浮层里**不搜索时**最多铺多少个。
 *
 * 浮层是阅读区大小（约 900×600），一屏能放七十来个。3000 个全铺出来会让 DOM 变重、
 * 滚动变黏，而「找某一个」的正确路径是搜索框 —— 不是滚四十屏。搜索时不受这个上限约束：
 * 关键词已经把范围缩小了，再截断就等于「搜到了却不给你看」。
 */
const TAG_SHEET_MAX = 240;

/**
 * 一天的记录默认铺几条。
 *
 * ★ 一天 20 条按 93px/条 就是 3.2 屏，50 条是 8 屏。用户 2026-10-27 的原话：
 *   「如果记录的过多，是不是会拉长页面很长，要滚动好久，从使用体验上这是不是失败的设计」。
 *   10 条是「今天大概发生了什么」的量；更早的要专门去翻，所以给一条
 *   「更早还有 X 条」的显式入口，而不是让人一路滚到底。
 */
const DAY_PREVIEW = 10;

/**
 * 私密条目「看一次」多久之后自己收回。
 *
 * 30 秒：够读完一条（一条私密日记通常几行到十几行），又不至于长到「以为它一直开着」。
 * 这不是权限，是**遮挡的复位**：真正决定能不能看的仍然是口令闸门。
 */
const PEEK_MS = 30_000;

const AI_ENTRY_CHIPS = [
  { id: 'entry', title: '整理这一篇', body: AI_ENTRY_PROMPT },
  { id: 'cut', title: '砍掉一半', body: '这一篇里哪些话可以删掉而不损失信息？直接给删完的版本。' },
  { id: 'quote', title: '提炼一句', body: '用一句话说出这一篇真正想说的，不要套话。' },
];

const AI_DAY_CHIPS = [
  { id: 'tidy', title: '整理成一整天', body: AI_DAY_PROMPT },
  { id: 'three', title: '提炼三条', body: '把今天这几条压成三条，每条一句话，保留我的语气。' },
  { id: 'unfinished', title: '找出没写完的', body: '哪几条只写了一半、或者情绪到了但事情没说清楚？指出来，先不要替我补。' },
  { id: 'ask', title: '今天在想什么', body: '读完今天这几条，你觉得我今天在想什么？说结论，再给一句依据。' },
];

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
  /**
   * 标签浮层（`全部 N 个 ›` 打开的那一层）。
   *
   * ★ 0.35 的方案是「侧栏内联筛选 + 展开到 300」——用户 2026-10-27 又追问了一次，
   *   而且当时他只有 4 个标签，那套东西在 4 个时**完全不可见**，他根本没法验证它对不对。
   *   这本身就是信号：标签的「全量浏览」不该挤在 268px 的侧栏里等数据长大再出现。
   *   现在侧栏只留最近 `TAG_SIDE` 个，其余全部进浮层 —— 4 个和 4000 个，界面一模一样。
   */
  const [tagSheet, setTagSheet] = useState(false);
  /** 浮层里的搜索词。与侧栏无关，是**这一层**的缩小范围。 */
  const [tagSheetFind, setTagSheetFind] = useState('');
  /** 这一天的记录是不是展开了「更早的」那几条。换天要收回（见 `pick`）。 */
  const [dayAll, setDayAll] = useState(false);
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
  /** 面板开着但对话还没建好时也要能打开它（失败信息得有个地方落）。 */
  const [aiOpen, setAiOpen] = useState(false);
  /** 当前面板对着哪一篇读后感（`null` = 对这一天的灵感）。 */
  const [aiEntry, setAiEntry] = useState(null);
  /** 正在发送的那条快捷提示词（空串 = 没在发）。 */
  const [aiSending, setAiSending] = useState('');
  /** 对话区是不是还停在「开场空态」——决定要不要盖那张开场图。 */
  const [emptyChat, setEmptyChat] = useState(false);
  const [promptMount, setPromptMount] = useState(null);
  const chatRoot = useRef(null);
  /**
   * AI 整理的失败原因。
   *
   * ★ 必须与 `chatError` 分开：`chatError` 只在伴读面板**已经打开**时才渲染
   *   （`{chat && <aside className="npr-companion">}` 里面），而这条链路上
   *   任何一个前置步骤失败都会让 `chat` 保持 `null` —— 于是错误写进了状态、
   *   界面上什么都不出现，用户看到的是「点了没反应」。
   *   这个状态渲染在正文区顶部，**与伴读面板是否打开无关**。
   */
  const [aiError, setAiError] = useState('');
  /**
   * 时间轴上点了某一条之后要定位到的那一条（`date-scope-index`）。
   *
   * ★ 这个标记是**持续**的，不是「闪一下」：0.33 起它是 1.8 秒后自动褪掉，
   *   于是「滚过去」和「高亮消失」几乎同时发生 —— 用户在 2026-10-27 的截图里
   *   点完时间轴什么标注都看不到。现在它保留到下一条被点、或换天为止。
   */
  const [focusKey, setFocusKey] = useState('');
  /**
   * 同一条被**再次**点击时的序号。
   *
   * ★ 为什么需要它：`setFocusKey(same)` 是 no-op（React 对同值 bail out），
   *   于是「滚上去看了看、再点同一行想回来」什么都不会发生。序号变化才会重跑效果。
   */
  const [focusSeq, setFocusSeq] = useState(0);
  /**
   * 私密日记的口令闸门。
   *
   * ★ 这一层是**权限**，不是显示效果。`set: false` 表示还没设过口令；
   *   `unlocked: false` 时宿主根本不会把私密正文发过来（`body` 是空串），
   *   所以界面除了画解锁框以外没有别的选择 —— 它想「先渲染再遮住」也做不到。
   *   用户 2026-10-27：「私密日记点击就能查看还有什么私密，一定是只能本人查看啊。」
   */
  const [gate, setGate] = useState({ set: false, unlocked: false, available: true, busy: false, error: '', draft: '', confirm: '' });
  /**
   * 「解锁」与「摊开」是两件事。
   *
   * ★ 口令回答的是「你有没有权利看这一页」；它回答不了「此刻旁边有没有人」。
   *   所以解锁之后每条正文**仍然收着**，点「看这一条」才渲染，而且看完会自己收回去。
   *   用户 2026-10-27：「即使输入口令解锁后，展示在面板上的日记应该还不是明码，
   *   点击查看才可以明码，查看完就又不是明码。」
   * ★ 收起这件事不只靠计时器：切到别的条目、切模块、上锁，都要立刻收 —— 计时器
   *   只是最后一道保险，不该指望它。
   */
  const [peek, setPeek] = useState('');
  /** 正在看的那一条的计时器。用 ref 而不是 state：它不参与渲染。 */
  const peekTimer = useRef(0);
  /**
   * 「展开全文」那个阅读窗里放的是哪一条（`null` = 没开）。
   *
   * ★ 这里存的是**条目快照**而不是 `index`：快照不会因为列表重排、换天、
   *   删掉别的一条而指错行。窗口是只读的，没有理由跟着列表一起变。
   * ★ 私密条目也能展开，但**只在已经点开看的那一条上**（`veiled` 的不给按钮）：
   *   窗口不该成为绕过「逐条点开」的第二条路。上锁 / 超时会把窗口一起关掉。
   */
  const [expand, setExpand] = useState(null);
  /** 侧栏时间轴里展开的那一天（同一次只展开一天）。 */
  const [openDay, setOpenDay] = useState('');
  const [stats, setStats] = useState(null);
  /**
   * AI 面板的宽度（百分比），可拖动。
   *
   * ★ 用户 2026-10-27：「AI整理弹开的窗口应该是可调节宽度。」
   *   阅读页的伴读面板早就能拖（`.npr-companion-divider`），日记页漏了这条 ——
   *   于是同一套面板在两边行为不一样。这里补上，并且**共用同一个存储键**：
   *   「AI 侧栏多宽」是这台机器上的一项偏好，不该按页面分两套。
   */
  const [companionWidth, setCompanionWidth] = useState(() => {
    const saved = Number(localStorage.getItem('npr.companionWidth'));
    return Number.isFinite(saved) && saved >= 25 && saved <= 75 ? saved : 44;
  });
  const companionWidthRef = useRef(companionWidth);
  const companionDrag = useRef(false);
  const workareaRef = useRef(null);

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
    // 切模块 = 换了一页，正在「看一次」的那条必须立刻收回，不能跟着用户走。
    hidePeek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleValue]);

  // 组件卸载时把计时器收掉，别让它去 setState 一个已经不在的组件。
  useEffect(() => () => { if (peekTimer.current) clearTimeout(peekTimer.current); }, []);

  // 直接落到日记 tab 时，ReaderPage 可能还没挂载过 ⇒ 那份注入表还没进文档。
  // 读后感的空状态借用了其中的 `.npr-welcome*`，所以这里补一次（幂等）。
  useEffect(() => { ensureStyles(); }, []);

  /* 标签浮层开着时，Esc 关掉它 —— 与搜索框、伴读面板的 Esc 行为保持一致。 */
  useEffect(() => {
    if (!tagSheet) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setTagSheet(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tagSheet]);

  /* 「展开全文」的阅读窗同样吃 Esc —— 它盖住整块正文，没有别的出口。 */
  useEffect(() => {
    if (!expand) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setExpand(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expand]);

  // 关掉面板时把会话还回去，否则它会一直挂着一个 retain。
  useEffect(() => () => { chatRef.current?.release?.(); }, []);

  /**
   * 时间轴上点了某一条：等这一天的条目渲染完之后滚到它。
   *
   * ★ 高亮**不在这里褪**。0.33–0.35 写的是 `setTimeout(() => setFocusKey(''), 1800)`，
   *   平滑滚动还没落位、标注就开始消失了 —— 用户看到的就是「点了没有任何反应」。
   *   现在标注留到下一条被点或换天（`pick()` 里清）。
   * ★ 目标可能正被「更早还有 X 条」收着（默认只铺 `DAY_PREVIEW` 条），
   *   这时 DOM 里根本没有它 —— 先展开这一天，等下一次渲染再滚，否则会静默滚不动。
   */
  useEffect(() => {
    if (!focusKey) return undefined;
    const node = document.querySelector(`[data-diary-key="${focusKey}"]`);
    if (!node) {
      if (!dayAll) setDayAll(true);
      return undefined;
    }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return undefined;
  }, [focusKey, focusSeq, day, dayAll]);

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
    /* 换一天时把「刚才定位到哪一条」和「展开了更早的」都收回：
       这两件事都是**对这一页**的临时状态，带到下一页只会让人以为没点对。
       `jump()` 是 pick + setFocusKey，同一个事件里后者生效（React 批处理，顺序即结果）。 */
    setFocusKey('');
    setDayAll(false);
    // 换一天**不**重新上锁：锁是「这个人现在在这台机器前」这件事，不是「这一天」。
    // 换了天就掉锁会让连续翻阅十天的日记变成输十次口令。
    const parsed = parseMonthKey(date.slice(0, 7));
    if (parsed && (parsed.year !== month.year || parsed.month0 !== month.month0)) setMonth(parsed);
  };

  /**
   * 跳到某一天（可选：定位到当天某一条）。
   *
   * ★ 这里**不再关闭搜索框**。0.32.0 的 `jump()` 末尾写着 `setSearch(open:false)`，
   *   于是「点标签 → 出结果 → 点一条结果」的第二次点击会把搜索框连同关键词一起
   *   收掉，用户的原话是「为什么这个搜索框我一点击内容条它就消失」。
   *   导航和检索是两个独立的状态，不该互相打断：搜索框只由搜索按钮与 Esc 关。
   */
  const jump = (date, key = '') => {
    pick(date);
    if (key) {
      setFocusKey(key);
      // 序号每次都动：同一条再点一次也要滚回去（`setFocusKey` 同值是 no-op）。
      setFocusSeq((count) => count + 1);
    }
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
    // ★ 只有私密日记带情绪。灵感模块已经把情绪行去掉了，若还无条件传 `mood`，
    //   在私密里选过心情再切回灵感写一条，那条灵感会悄悄带上一个用户没选过的心情。
    const meta = moduleValue === 'private' && mood ? { mood } : {};
    const ok = await save(draft, { meta });
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
    if (moduleValue !== 'private') return undefined;
    let alive = true;
    fetchDiarySecret()
      .then((status) => { if (alive) setSecret({ mode: status.mode ?? '', error: status.error ?? '' }); })
      .catch((cause) => { if (alive) setSecret({ mode: 'error', error: cause.message }); });
    fetchDiaryGate()
      .then((status) => {
        if (!alive) return;
        setGate((current) => ({
          ...current,
          set: status.set === true,
          unlocked: status.unlocked === true,
          available: status.available !== false,
          error: '',
        }));
      })
      .catch((cause) => { if (alive) setGate((current) => ({ ...current, error: cause.message })); });
    // ★ **离开模块就上锁**。这是用户那句「只能本人查看」的落点：切到灵感或读后感
    //   之后，私密正文不该还挂在宿主内存里等着被人点回来。返回清理函数里发请求，
    //   不 await —— 组件已经在卸载路径上，等它等于把切换卡住。
    return () => {
      alive = false;
      void lockDiaryGate()
        .then(() => setGate((current) => ({ ...current, unlocked: false })))
        .catch(() => {});
    };
  }, [moduleValue]);

  /**
   * 打开「AI 整理」面板。
   *
   * ★ **只开面板 + 绑上下文，不自动提问**（0.34 改）。用户 2026-10-27：
   *   「AI 整理不是这样的，就入 AI 伴读一样，应该是针对今天的灵感记录打开这个窗口。」
   *   0.33 的行为是点一下就 `sendPrompt(AI_DAY_PROMPT)` —— 面板还没画出来，
   *   模型已经开始输出了，用户既没机会换个问法，也看不出上下文到底是哪一天。
   *   现在与 `AskArticle` 完全一致：先开面板、显示「上下文是今天 N 条」，
   *   想怎么问由下面那排快捷提示词或输入框决定。
   *
   * ★ `setDiaryContext` **不传 `target`** —— 那是整天模式的开关（见 `diaryContext`：
   *   `target === null` 时开场白直接写「处理对象是这一天的日记整体」）。
   */
  async function openAiPanel(entry = null) {
    if (aiRef.current) return;
    aiRef.current = true;
    setAiKey(entry ? entryKey(entry) : 'day');
    setAiError('');
    setChatError('');
    setAiEntry(entry);
    setAiOpen(true);
    let acquired = null;
    try {
      const workspaceId = api.defaultChatWorkspace?.();
      if (!workspaceId) throw new Error('Harness 里还没有打开工作区。先在左侧打开一个工作区，再回来点这颗按钮。');
      acquired = await api.openChat({ workspaceId });
      // ★ 读后感是「一篇」的上下文，所以带 `target`；灵感是「这一整天」，不带。
      await api.setDiaryContext(entry
        ? { sessionId: acquired.sessionId, date: entry.date ?? selected, target: entry.index }
        : { sessionId: acquired.sessionId, date: selected });
      chatRef.current?.release?.();
      chatRef.current = acquired;
      setChat(acquired);
      acquired = null;
    } catch (cause) {
      const message = cause?.message ?? String(cause);
      // 面板与横幅两处都写：面板可能根本没打开（失败发生在 openChat / setDiaryContext）。
      setChatError(message);
      setAiError(message);
      acquired?.release?.();
    } finally {
      aiRef.current = false;
      setAiKey('');
    }
  }

  /**
   * 发一条整理指令。**面板已经打开之后**才可能被调用（快捷提示词 / 用户自己打字）。
   * ★ 失败只写进面板内的 notice，不再往正文区顶部抛横幅 —— 那条横幅的用途是
   *   「点了没反应」，而这里失败时用户人就在面板前面。
   */
  async function sendAiPrompt(text) {
    if (!chatRef.current || aiSending !== '' || text.trim() === '') return;
    setAiSending(text);
    setChatError('');
    try {
      await chatRef.current.sendPrompt(text);
    } catch (cause) {
      const message = cause?.message ?? String(cause);
      setChatError(message.includes('已有草稿')
        ? '输入框里已经有草稿。先发出去或清空，再用快捷提示词。'
        : message);
    } finally {
      setAiSending('');
    }
  }

  function closeChat() {
    chatRef.current?.release?.();
    chatRef.current = null;
    setChat(null);
    setChatError('');
    setAiOpen(false);
    setAiEntry(null);
    setPromptMount(null);
    setEmptyChat(false);
  }

  /**
   * 面板里「对话是不是还空着」+「快捷提示词该插在哪」。
   *
   * ★ 抄的是 `AskArticle` 的做法（那边已经跑了一年）：宿主原生对话把输入框画在
   *   `[data-composer-seat]`，把提示词条 portal 到它**前面**，才是「在输入框上方」
   *   而不是在面板底部叠一层。`data-content-phase="hero"` 是宿主自己报的「还没开始
   *   聊」，用它决定要不要盖开场图，比数 DOM 里的消息节点稳。
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
      setEmptyChat(root.querySelector('[data-content-phase]')?.getAttribute('data-content-phase') === 'hero');
    };
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-content-phase'] });
    place();
    return () => { observer.disconnect(); mount.remove(); setPromptMount(null); setEmptyChat(false); };
  }, [chat, SessionProvider]);

  /** 设口令 / 解锁 / 上锁三件事共用一个提交口（表单 onsubmit 走这里）。 */
  async function submitGate(event) {
    event.preventDefault();
    if (gate.busy) return;
    const text = gate.draft;
    if (text.length < 4) { setGate((current) => ({ ...current, error: '口令至少 4 位' })); return; }
    if (!gate.set && text !== gate.confirm) { setGate((current) => ({ ...current, error: '两次输入不一致' })); return; }
    setGate((current) => ({ ...current, busy: true, error: '' }));
    try {
      if (gate.set) await unlockDiaryGate(text);
      else await setupDiaryGate(text);
      setGate((current) => ({ ...current, set: true, unlocked: true, busy: false, draft: '', confirm: '' }));
      await refresh();
      notify?.(gate.set ? '已解锁' : '口令设好了，这一页只有你知道怎么打开');
    } catch (cause) {
      setGate((current) => ({ ...current, busy: false, error: cause.message }));
    }
  }

  /** 手动上锁（离开模块时也会自动锁，这颗按钮是「我现在要起身了」）。 */
  /** 收掉正在看的那一条。幂等：没在看不做任何事。 */
  function hidePeek() {
    if (peekTimer.current) {
      clearTimeout(peekTimer.current);
      peekTimer.current = 0;
    }
    // 阅读窗里可能正摊着这一条的全文 —— 收起正文却不关窗，等于给了个后门。
    setExpand(null);
    setPeek((current) => (current === '' ? current : ''));
  }

  /** 点开一条；再点同一条就是收起。开别的条目会先把上一条收掉。 */
  function peekEntry(key) {
    if (peekTimer.current) {
      clearTimeout(peekTimer.current);
      peekTimer.current = 0;
    }
    if (peek === key) {
      setPeek('');
      setExpand(null);
      return;
    }
    setPeek(key);
    peekTimer.current = setTimeout(() => {
      peekTimer.current = 0;
      setPeek('');
      setExpand(null);
    }, PEEK_MS);
  }

  async function lockNow() {
    try {
      await lockDiaryGate();
    } catch { /* 宿主没接上闸门时不需要报错：本来就锁不住 */ }
    hidePeek();
    setGate((current) => ({ ...current, unlocked: false, draft: '', confirm: '' }));
    setDraft('');
    notify?.('私密日记已上锁');
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

  /**
   * 点一个标签 = 按 `#标签` 检索（宿主侧的搜索就是正文子串，标签本来就在正文里）。
   *
   * ★ 这里**不设 `open: true`**：点标签是「筛一下」，不是「开始搜索」。把输入框
   *   顶出来会让用户以为界面换了模式，而它其实只是换了个查询词。
   *   输入框只由 🔍 按钮与 Esc 控制（`searchTag` 与 `toggleSearch` 两个入口分开）。
   */
  function searchTag(tag) {
    const query = `#${tag}`;
    setSearch((current) => ({ ...current, open: false, query }));
    void runSearch(query);
  }

  /** 退出筛选：连查询词一起清掉，侧栏回到「标签 / 时间轴 / 挂在书上」三块检索器。 */
  function clearFilter() {
    setSearch((current) => ({ ...current, open: false, query: '', hits: [], scanned: 0, truncated: false }));
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

  /** 灵感侧栏的「时间轴」：日期 + 条数 + **当天的条目**（点开才展开，见 openDay）。 */
  const recentDays = timeline.days
    .map((item) => {
      const ideas = (item.entries ?? []).filter((entry) => entry.kind !== '读后感' && entry.scope === 'public');
      return { date: item.date, count: ideas.length, entries: ideas };
    })
    .filter((item) => item.count > 0);

  const linked = linkedBooks(timeline.days);

  const filteredBooks = books.items.filter((item) => (
    bookQuery.trim() === '' || item.title.toLowerCase().includes(bookQuery.trim().toLowerCase())
  ));
  const readBooks = filteredBooks.filter((item) => stateOf(item.id) === 'read');

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

  /**
   * ★ 搜索结果的显示**不再依赖 `open`**（输入框是否展开）。
   *
   * 0.34 之前两者绑死，于是「点侧栏标签」必须顺手把搜索框顶出来 ——
   * 用户的原话是「这换一句话、换一个名字的输入框是什么鬼东西，为什么三个
   * 功能页都有，而且是在灵感页点击标签之后出现的」。
   *
   * 拆开之后是两个动作：
   *   · **筛选**（点标签）：不展开输入框，只在结果上方给一条可清除的筛选条；
   *   · **搜索**（点 🔍 / ⌘F）：展开输入框，随时能改写关键词。
   * 两者共用同一份 `hits`，因为宿主侧本来就是同一次查询。
   */
  const showSearchResults = search.query.trim() !== '';

  /**
   * 侧栏里内联的那几个标签，与浮层里的「全量」。
   *
   * ★ 两者是**同一份数据**的两种取法，不是两套索引：侧栏取头部 `TAG_SIDE` 个
   *   （`tagIndex.tags` 本身已按「最后使用日期」倒序，见宿主的标签索引），浮层取全部。
   * ★ 浮层里**先搜再分页**：关键词命中时不受 `TAG_SHEET_MAX` 约束 ——
   *   搜到了却不给你看，比不搜更糟。
   * ★ 匹配用 `includes`（不区分大小写的子串）：中文标签不需要分词，而 `#` 不参与
   *   匹配 —— 用户输入 `灵感` 和 `#灵感` 应该是一回事。
   */
  const tagSide = tagIndex.tags.slice(0, TAG_SIDE);
  const tagSheetNeedle = tagSheetFind.trim().replace(/^#+/, '').toLowerCase();
  const tagSheetMatched = tagSheetNeedle === ''
    ? tagIndex.tags
    : tagIndex.tags.filter((item) => String(item.tag).toLowerCase().includes(tagSheetNeedle));
  const tagSheetShown = tagSheetNeedle === ''
    ? tagSheetMatched.slice(0, TAG_SHEET_MAX)
    : tagSheetMatched;
  const tagSheetHidden = Math.max(0, tagSheetMatched.length - tagSheetShown.length);

  /**
   * 这一天默认只铺最近 `DAY_PREVIEW` 条。
   *
   * ★ 取**尾部**（最近的）而不是头部：日记里绝大多数时候是「看看刚才写了什么」，
   *   早上的那条下午不需要一直占着屏幕。顺序本身不变 —— 展开不该让内容换个方向。
   * ★ 条数不够时 `slice(-n)` 返回全部，不需要额外的 if。
   */
  const entriesShown = dayAll ? visibleEntries : visibleEntries.slice(-DAY_PREVIEW);
  const entriesHidden = Math.max(0, visibleEntries.length - entriesShown.length);
  /**
   * 顶上那块「写入口」到底有没有东西可放。
   *
   * ★ 三种模块各有一道闸（灵感：恒有；私密：解锁才有；读后感：选中且读完的书才有）。
   *   不判这一下的话，读后感「还没选书」时顶上会挂一条 24px 的空白带 + 一条边线，
   *   看起来像块加载失败的占位。
   */
  const hasDock = moduleValue === 'inspiration'
    || (moduleValue === 'private' && (gate.available === false || gate.unlocked))
    || (moduleValue === 'reflection' && Boolean(book && book.readable));

  return (
    /*
     * ★ `has-companion` 从 `chat` 改成 `aiOpen || chat`：面板**一打开**就该占位置。
     *   原来要等对话建好才让位，于是点了「AI 整理」之后有一小段时间面板浮在最右边、
     *   正文没让位、分隔条也不存在 —— 拖都拖不了。与面板自己的渲染判据
     *   （`{aiOpen && <aside>}`）对齐。
     */
    <div ref={workareaRef}
      className={`npr-workarea npr-diary-workarea${aiOpen || chat ? ' has-companion' : ''}`}
      style={{ '--npr-companion-width': `${companionWidth}%` }}>
      {/* ★ `npr-diary-layout` / `npr-diary-nav` 两个类只用来把「AI 面板打开时收起
          导航」这条规则**限定在日记页**（见 refinements.css）。阅读页的行为不变。 */}
      <div className="npr-layout npr-diary-layout" style={{ '--npr-list-width': `${listWidth}px` }}>
        <aside className="npr-sidebar npr-diary-nav">
          {/* ★ 这一条 `data-window-drag` 是**布局必需**：没有它，在日记页按住空白处拖不动窗口。 */}
          <div className="npr-sidebar-toolbar" data-window-drag>
            <ViewSwitch mode="diary" onChange={(next) => { if (next !== 'diary') onExit?.(next); }} showLibrary />
            {/* ★ 收起搜索 = 退出检索，连查询词一起清掉。否则输入框没了、结果还在，
                用户既看不到自己搜的词，也没有地方改 —— 是一处走不出去的角落。 */}
            <button type="button" className="npr-icon" title="搜索日记" aria-label="搜索日记"
              onClick={() => setSearch((current) => (current.open
                ? { ...current, open: false, query: '', hits: [], scanned: 0, truncated: false }
                : { ...current, open: true }))}><Icon name="search" /></button>
            <button type="button" className="npr-icon" title="打开日记文件夹" aria-label="打开日记文件夹" onClick={() => void reveal()}><Icon name="folder" /></button>
            <button type="button" className="npr-icon" title="导出全部日记（单文件 Markdown）" aria-label="导出全部日记" onClick={() => void exportAll()}><Icon name="download" /></button>
          </div>

          {/* 三个功能模块 —— 这是这一页的主结构，不是「条目类型」。 */}
          <div className="npr-diary-modes" role="group" aria-label="日记功能">
            {DIARY_MODULES.map((item) => (
              <button key={item.value} type="button" aria-pressed={moduleValue === item.value}
                onClick={() => { setModuleValue(item.value); setMood(''); setAiError(''); setRevealed(new Set()); }}>{item.label}</button>
            ))}
          </div>

          <div className={`npr-search-box npr-diary-search${search.open ? '' : ' is-hidden'}`}>
            <input type="search" aria-label="搜索日记" placeholder="搜一句话、一个名字…" value={search.query}
              onChange={(event) => { const value = event.target.value; setSearch((current) => ({ ...current, query: value })); void runSearch(value); }}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setSearch((current) => ({ ...current, open: false, query: '', hits: [] })); } }} />
          </div>
          <div className={`npr-status${error ? ' is-error' : ''}`} role="status" aria-live="polite">{error}</div>

          {showSearchResults ? (
            <div className="npr-list">
              {/* 筛选态（输入框没展开）时，这条负责回答「列表为什么变了」并给出出口。
                  搜索态不显示：关键词就在输入框里，再说一遍是噪音。 */}
              {!search.open && (
                <div className="npr-diary-filterbar">
                  <span className="npr-diary-filterbar-text">
                    按 <b>{search.query}</b> 找到{search.busy ? '…' : ` ${search.hits.length} 条`}
                  </span>
                  <button type="button" className="npr-diary-filterbar-clear" onClick={clearFilter}>全部</button>
                </div>
              )}
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
                <h2 className="npr-diary-sect-head">标签
                  {tagIndex.tags.length > 0 && (
                    <span className="npr-diary-sect-badge">{tagIndex.tags.length}</span>
                  )}
                </h2>
                {tagIndex.busy && <p className="npr-diary-sect-note">正在数标签…</p>}
                {!tagIndex.busy && tagIndex.tags.length === 0 && (
                  <p className="npr-diary-sect-note">正文里写 #灵感 这样的词，它就会出现在这里。</p>
                )}
                {tagSide.length > 0 && (
                  <div className="npr-diary-cloud">
                    {tagSide.map((item) => (
                      <button key={item.tag} type="button" className="npr-diary-tagchip"
                        title={`${item.count} 次，最后用在 ${item.last}`}
                        onClick={() => searchTag(item.tag)}>
                        <span>#{item.tag}</span>
                        <span className="npr-diary-tagcount">{item.count}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/*
                 * ★ 侧栏**永远**只铺 `TAG_SIDE` 个，多的全在这个入口后面。
                 *   268px 宽在任何阈值下都装不下几千个标签 —— 0.35 的「内联筛选 + 展开 300」
                 *   是在往侧栏里塞更多东西，而用户 2026-10-27 第三次问的正是「这栏装不下」。
                 *   超过就出现入口；标签少时它不出现，因为那时根本没有什么可展开的。
                 */}
                {tagIndex.tags.length > TAG_SIDE && (
                  <button type="button" className="npr-diary-tagmore"
                    onClick={() => { setTagSheetFind(''); setTagSheet(true); }}>
                    全部 {tagIndex.tags.length} 个 ›
                  </button>
                )}
              </section>

              <section className="npr-diary-sect">
                <h2 className="npr-diary-sect-head">时间轴</h2>
                {timeline.busy && <p className="npr-diary-sect-note">正在读…</p>}
                {!timeline.busy && recentDays.length === 0 && (
                  <p className="npr-diary-sect-note">还没有灵感。右边写一句就行。</p>
                )}
                {/*
                 * ★ 点日期展开当天的时间轴。用户 2026-10-27：「侧边栏是不是要有时间轴啊，
                 *   比如点击今天，展开今天记录的时间轴」。
                 *   0.32.0 这里只给「日期 + 条数」，点一下直接跳走 —— 侧栏因此只剩
                 *   「哪几天写过」，回答不了「那天写了什么」，也就不是时间轴。
                 * ★ 同一次只展开一天：侧栏只有 268px，展开多天会把标签区挤出视野。
                 */}
                <div className="npr-diary-days">
                  {recentDays.map((item) => {
                    const open = openDay === item.date;
                    return (
                      <div key={item.date} className={`npr-diary-day${open ? ' is-open' : ''}`}>
                        <button type="button" aria-expanded={open}
                          className={`npr-diary-dayrow${item.date === selected ? ' npr-selected' : ''}`}
                          onClick={() => { pick(item.date); setOpenDay(open ? '' : item.date); }}>
                          <span className="npr-diary-dayrow-date">{dayLabel(item.date, today)}</span>
                          <span className="npr-diary-dayrow-count">{item.count} 条</span>
                          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
                        </button>
                        {open && (
                          <ul className="npr-diary-daylist">
                            {item.entries.map((entry) => (
                              <li key={entryKey(entry)}>
                                {/* 这一项是不是「刚被点过的那一条」——右侧正文里同一条也在高亮，
                                    两处同时亮才叫「对应」。只亮右边的话，用户得自己在一屏里找。 */}
                                <button type="button"
                                  className={`npr-diary-dayitem${focusKey === entryKey(entry) ? ' is-focus' : ''}`}
                                  aria-current={focusKey === entryKey(entry) ? 'true' : undefined}
                                  title={`${entry.time} ${entry.preview}`}
                                  onClick={() => jump(item.date, entryKey(entry))}>
                                  <span className="npr-diary-dayitem-time">{entry.time}</span>
                                  <span className="npr-diary-dayitem-text">{entry.preview}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
                {timeline.truncated && <p className="npr-diary-sect-note">只看了最近 {timeline.days.length} 天。</p>}
              </section>

              {linked.length > 0 && (
                <section className="npr-diary-sect">
                  <h2 className="npr-diary-sect-head">挂在书上</h2>
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
                <h2 className="npr-diary-sect-head">这个月</h2>
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
              <div className="npr-search-box npr-diary-search">
                <input type="search" aria-label="找一本书" placeholder="只列出标记为读完的书…" value={bookQuery}
                  onChange={(event) => setBookQuery(event.target.value)} />
              </div>
              {books.busy && <p className="npr-diary-sect-note">正在读书架…</p>}
              {!books.busy && books.error !== '' && <p className="npr-diary-sect-note is-error">{books.error}</p>}

              {!books.busy && books.error === '' && (
                <section className="npr-diary-sect">
                  <h2 className="npr-diary-sect-head">读完的<span className="npr-diary-sect-badge">{readBooks.length}</span></h2>
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

              {/*
               * ★ 这里原本还有一块「还没读完（2636）」的列表。用户 2026-10-27：
               *   「读后感只显示标记完成的书，不显示未读完的书」。
               *   这一栏的用途是「解释为什么点不动」，但代价是把整个书架摊在侧栏里 ——
               *   2636 行既压掉了真正要选的那 1 本，也让「这里能做什么」变得不可读。
               *   门禁本身不受影响：`openBook` 与 `stateOf` 仍然挡住未读完的书，
               *   从阅读器进来的入口也仍然是 disabled（见 BookReader / BookEbook）。
               */}

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
                onClick={() => void openAiPanel()}>
                <Icon name="wand-sparkles" size={13} />
                <span>{aiKey === 'day' ? '正在打开…' : 'AI 整理这一天'}</span>
              </button>
            )}
          </div>

          <div className="npr-diary-main">
            {/*
             * ★ 横幅与正文必须一起放进一个**纵向**的容器。
             *   `.npr-diary-main` 是 `display:flex`（行方向，因为读后感要「正文 + 划线」
             *   并排），直接把横幅塞进去，它会被排到正文**左边**变成一条竖条。
             */}
            <div className="npr-diary-flow">
              {/* AI 整理失败时的**唯一必现位置**：伴读面板可能压根没打开（见 aiError 的注释）。 */}
              {aiError && (
                <div className="npr-diary-alert" role="alert">
                  <span><strong>没能开始整理</strong>{aiError}</span>
                  <button type="button" className="npr-diary-alert-close" onClick={() => setAiError('')} aria-label="关闭提示"><Icon name="x" size={13} /></button>
                </div>
              )}
              {/*
                * 标签浮层：侧栏 `全部 N 个 ›` 打开的**全量**视图。
                *
                * ★ 为什么是浮层而不是「展开侧栏」：268px 的栏铺不出几千个标签，
                *   而这里用的是阅读区的整个面积（约 900×600）—— 一屏七十来个，
                *   加上搜索框，才算真的「装得下」。用户 2026-10-27 第三次追问的就是这件事。
                * ★ 点一个标签 = 筛选 + 关闭：浮层是「挑一个然后走」，不是「停在这里浏览」。
                */}
              {tagSheet && (
                <div className="npr-tagsheet" role="dialog" aria-modal="true" aria-label="全部标签">
                  <div className="npr-tagsheet-head">
                    <h3 className="npr-tagsheet-title">
                      全部标签
                      <span className="npr-diary-sect-badge">{tagIndex.tags.length}</span>
                    </h3>
                    <button type="button" className="npr-tagsheet-close" onClick={() => setTagSheet(false)}
                      aria-label="关闭标签面板"><Icon name="x" size={14} /></button>
                  </div>
                  <input className="npr-tagsheet-find" type="search" value={tagSheetFind}
                    autoFocus
                    placeholder={`在 ${tagIndex.tags.length} 个标签里找`}
                    aria-label="找标签"
                    onChange={(event) => setTagSheetFind(event.target.value)} />
                  {tagSheetNeedle !== '' && tagSheetMatched.length === 0 && (
                    <p className="npr-diary-sect-note">没有带「{tagSheetFind.trim()}」的标签。</p>
                  )}
                  <div className="npr-tagsheet-cloud">
                    {tagSheetShown.map((item) => (
                      <button key={item.tag} type="button" className="npr-diary-tagchip"
                        title={`${item.count} 次，最后用在 ${item.last}`}
                        onClick={() => { searchTag(item.tag); setTagSheet(false); }}>
                        <span>#{item.tag}</span>
                        <span className="npr-diary-tagcount">{item.count}</span>
                      </button>
                    ))}
                  </div>
                  {/* 截断了就要说：没搜索时最多铺 `TAG_SHEET_MAX` 个。 */}
                  {tagSheetHidden > 0 && (
                    <p className="npr-diary-sect-note">
                      还有 {tagSheetHidden} 个没铺开 —— 用上面的框缩小范围。
                    </p>
                  )}
                </div>
              )}
              {/*
                * ★★ 写入口**固定在顶上，不参与滚动**。
                *
                *   用户 2026-10-27：「记录灵感的部分是固定的不随滚动条滚动，另外已留存的
                *   记录展示区域…」—— 原来写入口和记录列表装在**同一个** `.npr-diary-scroll`
                *   里，往下翻十来条之后输入框就没了；想再记一句，得先滚回顶。
                *   速记这件事的动作顺序是「想到 → 写 → 再来一句」，写入口必须一直在手边。
                *
                *   现在把它拆成上下两块：
                *     `.npr-diary-dock`   —— 固定，只有写作区（内容少、高度稳定）
                *     `.npr-diary-scroll` —— 只滚记录
                *   两块各有一份 `.npr-diary-sheet`，所以宽度约束（600px 居中）和左右留白
                *   仍然完全对齐 —— 拆成两层最容易出的错就是上下两块的左边缘差几像素。
                *
                * ★ 读后感「还没选书 / 没读完」那两种状态**留在滚动区**：那两块不是写入口，
                *   是说明。把它们钉在顶上会占掉半屏，而且没有可写的东西。
                */}
              {/*
                * 「展开全文」的阅读窗。
                *
                * ★ 为什么是**窗口**而不是「就地展开」：用户抱怨的正是「拉长页面很长，
                *   要滚动好久」。就地展开等于把这条记录重新拉长一次，只是这次是他自己点的 ——
                *   读完还得再滚回来。窗口有固定高度和自己的滚动条，合上就回到原处，
                *   列表的行高永远不变。
                * ★ 窗口里放的是**快照**（`expand` 存的是条目本身），所以后台刷新、
                *   换天、删掉别的一条都不会让它指错条目。
                */}
              <div className="npr-diary-dock">
              <div className="npr-diary-sheet">
                {/* ---- 写入口：三种模块三种形态 ------------------------------ */}
                {moduleValue === 'inspiration' && (
                  /* ★ 灵感模块**没有情绪行**。用户 2026-10-27：「灵感不需要有情绪追踪」。
                     情绪追踪是私密日记本的能力，灵感是速记 —— 多一行五档情绪只会让
                     「写一句话」这件事变重。 */
                  <DiaryComposer
                    variant="quick"
                    value={draft}
                    onChange={setDraft}
                    onSubmit={() => void saveQuick()}
                    busy={saving}
                    inputRef={draftRef}
                    maxHeight={220}
                    placeholder="这一刻想到什么？"
                  />
                )}

                {/*
                  * ★ 私密模块的写入口**在锁着时不出现**：宿主此刻根本没把正文发过来，
                  *   给一个能写但看不到自己昨天写了什么的框，是在骗人。
                  *   `gate.available === false`（宿主没接闸门）时照常显示 —— 那种情况下
                  *   本来就没有口令这层，不该画一个点不动的锁。
                  */}
                {moduleValue === 'private' && (gate.available === false || gate.unlocked) && (
                  <section className="npr-diary-write">
                    <DiaryComposer
                      variant="private"
                      value={draft}
                      onChange={setDraft}
                      onSubmit={() => void saveQuick()}
                      busy={saving}
                      inputRef={draftRef}
                      maxHeight={260}
                      placeholder="这一页只留在本机。"
                      extra={<MoodRow value={mood} onChange={setMood} label="今天的心情" />}
                    />
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

                {moduleValue === 'reflection' && book && book.readable && (
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
                    <DiaryComposer
                      variant="reflection"
                      value={refDraft}
                      onChange={setRefDraft}
                      onSubmit={() => void saveReflection()}
                      busy={saving}
                      inputRef={refRef}
                      maxHeight={300}
                      placeholder="写下这本书留给你的东西。"
                      actions={(
                        <>
                          <button type="button" className="npr-diary-linkish" onClick={() => setRefDraft((current) => (current.trim() === '' ? REFLECTION_TEMPLATE : `${current.replace(/\s+$/, '')}\n\n${REFLECTION_TEMPLATE}`))}>
                            套用模板
                          </button>
                          <button type="button" className="npr-diary-linkish" onClick={() => setRefDraft('')}>清空</button>
                        </>
                      )}
                    />
                  </section>
                )}
              </div>
              </div>
              )}

              {/* ---- 记录区：只滚这一块 ------------------------------------ */}
              <div className="npr-diary-scroll">
              <div className="npr-diary-sheet">
                {/* 读后感的两种「还不能写」：留在滚动区（它们是说明，不是写入口）。 */}
                {moduleValue === 'reflection' && !(book && book.readable) && (
                  book ? (
                    <div className="npr-diary-blocked">
                      <p><strong>《{book.title}》还没标记读完。</strong></p>
                      <p>读后感只对读完的书开放 —— 回到书架，读完并点顶部那颗「标记读完」，再回来这里写。</p>
                    </div>
                  ) : (
                    /*
                     * ★ 空状态照抄「阅读」那一页的版式（`.npr-welcome` 那一组类，
                     *   样式来自 ReaderPage 的 PANEL_CSS，同一份注入表）。
                     *   用户 2026-10-27：「读后感这个页面的设计与阅读的风格统一」——
                     *   原来这里是三行等宽的说明文字，从左边缘一路铺过去，既没有标题
                     *   也没有落点，看起来像一条系统提示，而不是「一页还没开始的稿纸」。
                     */
                    <div className="npr-welcome">
                      <div className="npr-welcome-brand">NPIE REFLECTION</div>
                      <h2>读完的书，值得留一句</h2>
                      <p className="npr-welcome-intro">
                        左边只列<strong>读完</strong>的书。没读完的不在里面 ——
                        读后感是读完之后的事，不是阅读进度的一部分。
                      </p>
                      <p className="npr-welcome-intro">
                        点左边任意一本，右边就是写给它的地方。写下的这一页会记住书名、
                        章节和页码，以后翻这本，还找得到当时写在哪里。
                      </p>
                      <p className="npr-welcome-intro">
                        也可以反过来：在书里读着读着，点顶部那颗「<strong>写读后感</strong>」，
                        直接带着这本书落到这一页。
                      </p>
                      <div className="npr-welcome-keys">
                        <span>读完 {readBooks.length} 本</span>
                        <span>书架共 {books.total} 本</span>
                      </div>
                    </div>
                  )
                )}

                {/* ---- 条目列表 --------------------------------------------- */}
                {moduleValue !== 'reflection' && (
                  <>
                    {moduleValue === 'private' && gate.unlocked && privateEntries.length > 0 && (
                      <div className="npr-diary-gatebar">
                        <span>已解锁 · {privateEntries.length} 条私密</span>
                        <button type="button" className="npr-diary-action" onClick={() => void lockNow()}>锁定</button>
                      </div>
                    )}
                    {/*
                      * ★ 锁着的时候这里画**解锁卡**，而且只画它：`visibleEntries` 里私密
                      *   条目的 body 是空串（宿主摘掉的），画出来是一串空壳，比不画更糟。
                      */}
                    {moduleValue === 'private' && gate.available !== false && !gate.unlocked && (
                      <section className="npr-gate" aria-label="私密日记已上锁">
                        <div className="npr-gate-icon" aria-hidden="true"><Icon name="eye-off" size={20} /></div>
                        <h2>{gate.set ? '这一页上锁了' : '给私密日记设一道口令'}</h2>
                        <p>
                          {gate.set
                            ? '输入口令才能看。口令只在这台机器上校验，不出本机、不进模型。'
                            : '设一道只有你知道的口令。它不参与文件加密（文件本来就是密文），只决定「谁能翻开这一页」。'}
                        </p>
                        <form className="npr-gate-form" onSubmit={(event) => void submitGate(event)}>
                          <input
                            type="password"
                            autoComplete={gate.set ? 'current-password' : 'new-password'}
                            aria-label="口令"
                            placeholder={gate.set ? '口令' : '设一个口令（至少 4 位）'}
                            value={gate.draft}
                            autoFocus
                            onChange={(event) => setGate((current) => ({ ...current, draft: event.target.value, error: '' }))} />
                          {!gate.set && (
                            <input
                              type="password"
                              autoComplete="new-password"
                              aria-label="再输一次口令"
                              placeholder="再输一次"
                              value={gate.confirm}
                              onChange={(event) => setGate((current) => ({ ...current, confirm: event.target.value, error: '' }))} />
                          )}
                          <button type="submit" className="npr-gate-submit" disabled={gate.busy || gate.draft === ''}>
                            {gate.busy ? '正在校验…' : gate.set ? '解锁' : '设好并打开'}
                          </button>
                        </form>
                        {gate.error !== '' && <p className="npr-gate-error" role="alert">{gate.error}</p>}
                        <small>
                          {gate.set
                            ? '忘记口令不会丢日记：删掉 diary/gate.json 就能重设，文字还在。'
                            : '换了这台机器也没有：密钥在这台机器的登录钥匙串里。'}
                        </small>
                      </section>
                    )}
                    {loading && <div className="npr-empty">正在读这一天…</div>}
                    {!loading && visibleEntries.length === 0 && (
                      <div className="npr-diary-blank">
                        <p>{moduleValue === 'private' ? '这一天还没有私密日记。' : '这一天还没有灵感。'}</p>
                        <p>{moduleValue === 'private'
                          ? '上面写一句就行。私密的只留在本机，不同步、不进模型。'
                          : '上面写一句就行 —— 灵感多半是半句话。'}</p>
                      </div>
                    )}
                    {/*
                      * ★ 默认只铺最近 `DAY_PREVIEW` 条，更早的收在这一行后面。
                      *   用户 2026-10-27：「如果记录的过多，是不是会拉长页面很长，
                      *   要滚动好久，从使用体验上这是不是失败的设计」—— 是的。
                      *   但「这一天写了 27 条」这件事本身要说出来，所以这里印的是**还差多少**，
                      *   不是一句「展开更多」：没有数字的折叠等于把内容藏起来。
                      */}
                    {entriesHidden > 0 && (
                      <button type="button" className="npr-diary-daymore" onClick={() => setDayAll(true)}>
                        更早还有 {entriesHidden} 条 · 展开
                      </button>
                    )}
                    {entriesShown.map((entry) => {
                      const html = renderBody(entry.body);
                      const tags = parseTags(entry.body);
                      const privateSide = entry.scope === 'private';
                      const key = entryKey(entry);
                      const entryMood = firstMood(entry.meta?.mood);
                      /*
                       * ★ 私密条目现在**由宿主决定给不给正文**（见 `gate`）。
                       *   0.33 这里是「逐条遮罩 + 点击显示」，用户 2026-10-27 一针见血：
                       *   「点击就能查看还有什么私密」。遮罩只挡眼睛，不挡人 —— 真正该拦在
                       *   前面的是「你有没有权利看这一页」，而那件事只有宿主能判。
                       *   所以这里不再有 veiled：锁着时这一整块根本不会渲染（上面画的是解锁卡）。
                       */
                      const empty = privateSide && entry.body === '';
                      /*
                       * ★ 解锁了也不摊开。`privateSide` 的正文要先被点开才渲染 ——
                       *   渲染 = 把明文放进 DOM，而「看一眼就走」的场合（同事站在旁边）
                       *   需要的正是「默认不渲染」。收起有四个触发点：再点一次、切到
                       *   别的条目、切模块、上锁，外加 30 秒计时器兜底。
                       */
                      const veiled = privateSide && !empty && peek !== key;
                      return (
                        <article className={`npr-diary-entry${focusKey === key ? ' is-focus' : ''}`}
                          key={key} data-diary-key={key}
                          aria-current={focusKey === key ? 'true' : undefined}>
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
                          {empty
                            ? <p className="npr-diary-body npr-diary-body-plain">这一条还在锁里。</p>
                            : veiled
                              ? (
                                <button type="button" className="npr-diary-veil" onClick={() => peekEntry(key)}>
                                  <Icon name="eye-off" size={14} />
                                  <span>点开看这一条</span>
                                  <span className="npr-diary-veil-meta">{entry.body.length} 字 · 看完自己收起</span>
                                </button>
                              )
                              : <EntryBody html={html} text={entry.body} onExpand={() => setExpand(entry)} />}
                          {privateSide && !empty && !veiled && (
                            <button type="button" className="npr-diary-veil-close" onClick={hidePeek}>收起</button>
                          )}
                          {/* 标签是从正文里抽的 —— 收着的时候它同样是明文，必须一起藏。 */}
                          {!empty && !veiled && tags.length > 0 && (
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
                                onClick={() => void openAiPanel(entry)}>
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
                          <EntryBody html={html} text={entry.body} onExpand={() => setExpand(entry)} />
                        </article>
                      );
                    })}
                  </>
                )}

                {/*
                  * ★ 这条页脚只属于「日记」本身（灵感 / 私密），**不能进读后感**。
                  *   用户 2026-10-27 的截图里，读后感模块底部挂着
                  *   「日记共 4 天（私密 1 天）· 1 KB · 存在 /Users/…/diary 连私密一起导出」
                  *   —— 那是两个模块的数据串在了一起：他在看一本书的读后感，却被报了
                  *   日记的天数、磁盘路径，还给了一个导出日记的入口。同一个 `<p>` 覆盖了
                  *   三个模块，就必然在其中一个里是错的。
                  */}
                {stats && moduleValue !== 'reflection' && (
                  <p className="npr-diary-foot">
                    日记共 {stats.days} 天{stats.privateDays > 0 ? `（私密 ${stats.privateDays} 天）` : ''} · {(stats.bytes / 1024).toFixed(0)} KB · 存在 {stats.root}
                    {stats.privateDays > 0 && gate.unlocked && (
                      <button type="button" className="npr-diary-linkish" onClick={() => void exportWithPrivate()}>
                        {exportArmed ? '再点一次：明文会写进下载目录' : '连私密一起导出'}
                      </button>
                    )}
                  </p>
                )}
                </div>
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

      {/*
        * ★ 面板**只要点过就打开**（`aiOpen`），不等 `chat` 建好。
        *   0.33 的写法是 `{chat && <aside>}` —— 于是 `openChat` / `setDiaryContext`
        *   任何一步失败，用户看到的是「点了没反应」，而真正的原因被关在从未渲染的
        *   面板里。这与 AI 伴读的行为也不一致：伴读是先出面板、再在面板里报错。
        */}
      {/*
        * ★★ 「展开全文」的阅读窗挂在 **workarea** 上，不是正文流里。
        *   挂在 `.npr-diary-flow` 里的话，遮罩只盖住右侧阅读列，左边那一栏导航
        *   还是亮的 —— 看起来像遮罩没铺满，而不是「有一层窗口盖在上面」。
        *   为此 `.npr-diary-workarea` 加了 `position: relative`（见 refinements.css）；
        *   `.npr-workarea` 本身没有定位，直接挂 absolute 会跑到 `.npr-root` 上去。
        * ★ 窗口里放的是**快照**（`expand` 存的是条目本身），所以后台刷新、换天、
        *   删掉别的一条都不会让它指错条目。
        */}
      {expand && (
        <div className="npr-diary-modal" role="dialog" aria-modal="true" aria-label="完整这一条"
          onClick={() => setExpand(null)}>
          <div className="npr-diary-modal-card" onClick={(event) => event.stopPropagation()}>
            <header className="npr-diary-modal-head">
              <div className="npr-diary-modal-meta">
                <span className="npr-diary-time">{expand.time}</span>
                {expand.kind && <span className="npr-diary-kind">{expand.kind}</span>}
                {expand.scope === 'private' && <span className="npr-diary-lock">私密</span>}
                {expand.source && <span className="npr-diary-source-tag" title={expand.source}>引自 {expand.source}</span>}
              </div>
              <button type="button" className="npr-diary-modal-close" onClick={() => setExpand(null)}
                aria-label="关闭" autoFocus><Icon name="x" size={14} /></button>
            </header>
            <div className="npr-diary-modal-body">
              {renderBody(expand.body)
                ? <div className="npr-diary-body" dangerouslySetInnerHTML={{ __html: renderBody(expand.body) }} />
                : <p className="npr-diary-body npr-diary-body-plain">{expand.body}</p>}
            </div>
            {parseTags(expand.body).length > 0 && (
              <div className="npr-diary-tagrow npr-diary-modal-tags">
                {parseTags(expand.body).map((tag) => (
                  <button key={tag} type="button" className="npr-diary-tag"
                    title={`找所有带 #${tag} 的日记`}
                    onClick={() => { searchTag(tag); setExpand(null); }}>#{tag}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/*
        * ★ 面板宽度可拖（用户 2026-10-27：「AI整理弹开的窗口应该是可调节宽度」）。
        *   与阅读页的伴读面板同一套实现、**同一个存储键** —— 「AI 侧栏多宽」是这台
        *   机器上的一项偏好，不该按页面分两套。样式（`.npr-companion-divider`）在
        *   `PANEL_CSS` 里，`ensureStyles()` 已经保证它进了文档。
        * ★ 窄容器下 `.npr-workarea` 会变成纵向（CSS 容器查询），分隔条要跟着改成
        *   上下拖 —— 所以方向是**算出来的 flex-direction**，不是写死横竖。
        */}
      {aiOpen && (
        <div className="npr-companion-divider"
          role="separator" aria-label="调整日记与 AI 面板的宽度" aria-orientation="vertical"
          aria-valuemin={25} aria-valuemax={75} aria-valuenow={companionWidth} tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            companionDrag.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.dataset.dragging = 'true';
          }}
          onPointerMove={(event) => {
            if (!companionDrag.current) return;
            const area = workareaRef.current;
            const rect = area?.getBoundingClientRect();
            if (!rect) return;
            const vertical = getComputedStyle(area).flexDirection === 'column';
            const total = vertical ? rect.height : rect.width;
            const span = vertical ? rect.bottom - event.clientY : rect.right - event.clientX;
            const minimum = Math.min(320, total * 0.3);
            const amount = Math.max(minimum, Math.min(span, total - minimum));
            companionWidthRef.current = Math.round(amount / total * 100);
            setCompanionWidth(companionWidthRef.current);
          }}
          onPointerUp={(event) => {
            companionDrag.current = false;
            event.currentTarget.dataset.dragging = 'false';
            localStorage.setItem('npr.companionWidth', String(companionWidthRef.current));
          }}
          onPointerCancel={(event) => {
            companionDrag.current = false;
            event.currentTarget.dataset.dragging = 'false';
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 10 : 2;
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const next = Math.max(25, Math.min(75,
              companionWidth + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? step : -step)));
            companionWidthRef.current = next;
            setCompanionWidth(next);
            localStorage.setItem('npr.companionWidth', String(next));
          }}
          onDoubleClick={() => {
            companionWidthRef.current = 44;
            setCompanionWidth(44);
            localStorage.setItem('npr.companionWidth', '44');
          }} />
      )}
      {aiOpen && (
        <aside className="npr-companion npr-diary-companion" aria-label="AI 整理">
          <header className="npr-companion-header">
            <strong>{aiEntry ? 'AI 整理这一篇' : 'AI 整理'}</strong>
            <button className="npr-icon" title="换一个对话" aria-label="换一个对话"
              disabled={aiKey !== ''} onClick={() => { closeChat(); void openAiPanel(); }}>
              <Icon name="plus" />
            </button>
            <button className="npr-icon" title="关闭" aria-label="关闭 AI 整理" onClick={closeChat}><Icon name="x" /></button>
          </header>
          <div className="npr-companion-context">
            <strong>{aiEntry ? `${aiEntry.date ?? selected} · ${aiEntry.time}` : dayLabel(selected, today)}</strong>
            <small>
              {aiEntry
                ? '读后感 · 这一篇'
                : `${inspirationEntries.length} 条 · ${day.chars} 字 · 今天的全部灵感都在上下文里`}
            </small>
          </div>
          {chatError && (
            <div className="npr-companion-error" role="alert">
              <strong>没能开始整理</strong>
              <p>{chatError}</p>
              <button type="button" onClick={() => void openAiPanel()}>重试</button>
            </div>
          )}
          {!chat && !chatError && <div className="npr-companion-loading" role="status">正在打开对话…</div>}
          {chat && SessionProvider && (
            <div className="npr-native-chat" ref={chatRoot}>
              <SessionProvider session={chat.reference}>{renderSlot('npie-reader.chat', {})}</SessionProvider>
              {/*
                * 开场图：与 AI 伴读那张同一个位置、同一个构图（书 + 一句题头 + 一句正文）。
                * ★ 只在对话还是空的时候盖上去（宿主用 `data-content-phase="hero"` 报这件事）。
                */}
              {emptyChat && !chatError && (
                <div className="npr-companion-opening" aria-label="开始整理">
                  <div className="npr-companion-book" aria-hidden="true">
                    <svg viewBox="0 0 112 88" fill="none">
                      <path d="M56 72c-10-7-21-10-37-9V19c16-1 27 2 37 9 10-7 21-10 37-9v44c-16-1-27 2-37 9Z" />
                      <path d="M56 28v44M25 29c9 .3 17 2.5 24 6M25 38c9 .3 17 2.5 24 6M63 35c7-3.5 15-5.7 24-6M63 44c7-3.5 15-5.7 24-6" />
                      <path d="M11 68c18-3 33 0 45 9 12-9 27-12 45-9" />
                      <circle cx="77" cy="13" r="2.5" className="npr-companion-book-spark" />
                      <path d="M77 3v4M77 19v4M67 13h4M83 13h4" className="npr-companion-book-spark" />
                    </svg>
                  </div>
                  <span className="npr-companion-opening-label">与今天对坐片刻</span>
                  <h2>{aiEntry ? '这一篇，写完了吗？' : `${inspirationEntries.length} 条，一天。`}</h2>
                  <p>{aiEntry ? '可以让我把这段理顺，也可以只挑出没说完的那句。' : '要不要把它们理一理？'}<br />也可以直接问我：今天的你，在想什么。</p>
                </div>
              )}
            </div>
          )}
          {/*
            * 快捷提示词：与 AI 伴读同一套（portal 到宿主输入框上方那排胶囊）。
            * ★ 用 portal 而不是在面板底部再画一排按钮：宿主原生对话自己带输入框，
            *   在它下面再叠一排「发这个 / 发那个」会让两个发送区看起来都能用。
            */}
          {promptMount && createPortal(
            <div className="npr-companion-prompt-strip" role="group" aria-label="快捷提示词">
              <div className="npr-companion-prompt-scroll">
                {(aiEntry ? AI_ENTRY_CHIPS : AI_DAY_CHIPS).map((item) => (
                  <button key={item.id} type="button" className="npr-companion-prompt-ghost"
                    title={item.body} aria-label={`直接发送：${item.title}`}
                    disabled={aiSending !== ''} onClick={() => void sendAiPrompt(item.body)}>
                    {item.title}
                  </button>
                ))}
              </div>
            </div>, promptMount)}
        </aside>
      )}
    </div>
  );
}
