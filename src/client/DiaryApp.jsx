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
 * ★ 两个入口，同一页：侧栏第三个 tab 进来（默认灵感速记），或者**在「阅读 → 读完」
 *   那一行点「写读后感」**进来（`intent = { module, bookId, bookTitle, ext }`）。
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
  parseSource, parseTags, shiftMonth, stampLabel,
} from '../diary-format.js';
import {
  appendDiaryEntry, downloadDiaryBundle, fetchDiaryBook, fetchDiaryDashboard, fetchDiaryDay, fetchDiaryExport,
  fetchDiaryGate, fetchDiaryMonth, fetchDiarySecret, fetchDiarySource, fetchDiaryStats, fetchDiaryTags, fetchDiaryTimeline,
  fetchReflectionIndex,
  lockDiaryGate, removeDiaryEntry, revealDiaryFolder, searchDiary, setupDiaryGate, unlockDiaryGate,
} from './diary-api.js';
import { fetchAnnotations, fetchBooks, fetchStates } from './library-api.js';
import { BOOK_STATE_LABELS, hasFinished } from '../library.js';
import { coverGlyph, coverHue } from './book-cover.js';
import { entryOrigin, originIcon, originJumpLabel, originMissNote, originTarget } from './diary-origin.js';
import { entryLines } from './diary-lines.js';
import { placeRowMenu } from './row-menu.js';
import { BookCover } from './BookCover.jsx';
import { DiaryCalendar } from './DiaryCalendar.jsx';
import { DiaryComposer } from './DiaryComposer.jsx';
import { formatExt } from './book-cover.js';
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

/**
 * ISO 时间串 → `YYYY-MM-DD`。不是合法时间就空串。
 * ★ 订阅源的 `publishedAt` 是 ISO（`toISOString()`），而 `stampLabel` 认的是
 *   `YYYY-MM-DD`：直接喂 ISO 会原样印出 `2026-10-28T09:12:33.000Z`。
 */
function isoDay(iso) {
  const date = new Date(typeof iso === 'string' ? iso : '');
  if (Number.isNaN(date.getTime())) return '';
  return dateKey(date);
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
 * 出处卡片的外框尺寸。
 *
 * ★ 写死而不是量 DOM：卡片要在**第一次出现**时就摆对位置，而那一刻它还没渲染。
 *   宽度与 `refinements.css` 里 `.npr-diary-pop` 的 `width` 必须同值 ——
 *   判据 `test/diary-origin.test.mjs` 会读 CSS 核对这一对数字。
 * ★ 0.47 从 248 加宽到 300：卡片多了封面、标题、摘要（0.46 只有三行字）。
 *   300 是「能放下两行摘要」与「不把 320px 的右栏盖住」之间的那个数。
 * ★ 高度是**估算**（封面 60 + 标题两行 40 + 摘要两行 36 + 时间 20 + 按钮 30 +
 *   内边距 24 ≈ 210）：它只参与「别被窗口底边切掉」的夹取，估大一点比估小安全。
 */
const ORIGIN_POP_W = 300;
const ORIGIN_POP_H = 214;

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
 * 侧栏时间轴一次取几天。
 *
 * ★ 后端 `timeline({ limit })` 的上限是 `TIMELINE_DAY_LIMIT`（60），默认 30。
 *   这里显式写 30 而不是靠默认值：它是**翻页的步长**，界面要拿它算「再往前多少天」，
 *   两端各靠一次默认值迟早会漂开。
 * ★ 用户 2026-10-27 的诉求是「支持通过时间轴或标签快速检索」——
 *   只给最近 30 天且没有出口，等于把更早的记录藏起来。
 */
const TIMELINE_PAGE = 30;

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
 * 一条记录的 `source` 归一成一个**可分组**的键（= 给人看的那串书名 / 文章名）。
 *
 * ★ 解析规则（切 ` · `、剥重复书名号）在 `diary-format.js` 的 `parseSource()` 里 ——
 *   因为写入侧（`QuickCapture`）也要用同一套判断，两边各写一份必然漂开。
 * ★ 空串表示「没有来源」：这类灵感不进任何分组，也不该被硬塞一个「未分类」。
 */
function sourceKey(source) {
  return parseSource(source)?.label ?? '';
}

export function DiaryApp({
  onExit, notify, api, SessionProvider, renderSlot, intent, onOpenBook, onOpenArticle,
}) {
  const today = useMemo(() => dateKey(), []);
  /**
   * 当前模块。默认「灵感速记」—— 它是最轻的那个，也是打开日记时最常做的事。
   *
   * ★ 带 `intent` 进来时**直接落到那一块**：读完那一行点「写读后感」走的就是这条，
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
  /**
   * 私密侧栏那两块卡片的数据（`/dashboard`）。
   *
   * ★ 与 `marks` **分开存**：`marks` 是日历的点（每次翻月都要），`dash` 是侧栏的统计
   *   （情绪分布 / 连续天数 / 那年今日）。合成一个会让「翻月」顺手把连续天数也重算一遍，
   *   而那个数其实与月份无关。
   * ★ `locked` 是**宿主量出来的**，不是这里猜的：锁着时 `chars` 是 `null`（不是 0），
   *   `moods` 是空数组。把 `null` 当 0 显示会说出「本月写了 0 字」这种确定的假话。
   */
  const [dash, setDash] = useState({
    busy: true, locked: false, days: 0, chars: null, streak: 0,
    moods: [], moodEntries: {}, onThisDay: [], error: '',
  });
  /**
   * 点中的那一档情绪（1..5，`null` = 没筛）。
   *
   * ★ 它**不改 `linkKey`**：那个是「按来源收窄**这一天**」，这里是「把**整月**摊成一张
   *   列表」。共用同一个变量会让两个筛选互相清掉对方，而且清空按钮不知道该清哪个。
   */
  const [moodFilter, setMoodFilter] = useState(null);
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
  /**
   * 侧栏「挂在书上 / 挂在文章上」点开的那一个来源（`sourceKey()` 的返回值，空 = 不筛）。
   *
   * ★ 这个状态存在的理由就是用户说的「点击不对应」：点一行书名只 `jump(日期)`，
   *   那一天若有七条，跳过去看到的还是原来那一屏 —— 日期变了，但没有任何东西
   *   对应上刚才点的那个书名。所以点一行必须同时把列表**收窄**成那个来源，
   *   并给出「现在只显示挂在《X》上的 · 全部」这条出口。
   */
  /**
   * 正开着「出处」浮层的那个锚点（`null` = 关着）。
   *
   * ★ 存的是**算好的坐标**而不是按钮节点：浮层是 `position: fixed`，而日记页能
   *   上下滚 —— 拿节点去量，滚动之后要么量到一个已经不在这儿的按钮，要么每次滚动
   *   都要重量一遍。打开那一下算一次，滚动就关掉（见下面那个 effect）。
   */
  const [originPop, setOriginPop] = useState(null);
  /**
   * 卡片里那段「这篇文章是什么」：`{ busy, entry, error }`。
   *
   * ★ 只有文章才有（书的封面/书名/章节在日记条目里就带齐了）。走
   *   `api.entryMeta()`，**不是** `api.getArticle()` —— 后者会去原文页抓正文，
   *   为了显示一张出处卡片发一个网络请求，慢且可能失败。
   * ★ `error` 单独存：取不到（订阅源里的 key 已经失效）和「还没取完」要分开，
   *   前者该说「这篇已经不在订阅里了」，后者只说「正在读…」。
   */
  const [originMeta, setOriginMeta] = useState({ busy: false, entry: null, error: '' });
  /** 连开两张卡片时，只让最后那张的数据落地（先发后至会把 A 的摘要贴到 B 上）。 */
  const originLoadRef = useRef(0);
  const [timeline, setTimeline] = useState({ days: [], truncated: false, busy: false, more: false });

  // ---- 读后感工作台 -------------------------------------------------------
  const [books, setBooks] = useState({ items: [], total: 0, truncated: false, busy: false, error: '' });
  /** `{ [bookId]: { state, page, pages, at } }` —— 读后感门禁的判据就在这里面。 */
  const [bookStates, setBookStates] = useState({});
  const [bookQuery, setBookQuery] = useState('');
  /**
   * 哪几本书写过读后感：`{ [bookId]: { count, last } }`（0.48）。
   *
   * ★ 侧栏那份名单是「读完过」的书，写过读后感的只是其中一部分 —— 用户
   *   2026-10-29 要的「区分」就是这件事。取不到时**整列不标**（`ready: false`），
   *   而不是把每本都标成「待写」：那会把「宿主没接上」说成「你一篇都没写过」。
   */
  const [reflections, setReflections] = useState({ map: {}, ready: false, error: '' });
  /** 名单上的筛选：`all` 全部 / `written` 写过 / `blank` 还没写过。 */
  const [shelfFilter, setShelfFilter] = useState('all');
  const [book, setBook] = useState(null);
  const [bookEntries, setBookEntries] = useState({ items: [], busy: false });
  const [annotations, setAnnotations] = useState({ items: [], busy: false, error: '' });
  /**
   * 右栏「划线」是否展开。
   *
   * ★ 用户 2026-10-28：「读后感这部分，划线侧边栏应该可以收缩起来，写读后感的
   *   区域自适应」。收起之后正文列（`.npr-diary-flow`）是 `flex: 1`，会自己把
   *   让出来的 266px 全部吃掉 —— 「自适应」不需要另写一条宽度计算。
   * ★ 收起**不是整块消失**，而是留一条 34px 的窄轨（`chevron-left` + 竖排
   *   「划线 N」）。这一页没有第二个「打开划线」的入口（不像阅读页还有工具栏
   *   按钮），整块消失就变成「收起来之后叫不回来」。
   * ★ 默认**展开**：划线是写读后感的主要素材（拖拽与「引用」都从这儿取），
   *   默认收起等于把主路径藏起来；收起是「我要专心写」时才主动做的事。
   * ★ 存 localStorage 而不是纯内存：与 `npr.diaryListWidth` / `npr.companionWidth`
   *   同属「这台机器上的界面偏好」，重开面板不该复位。
   * ★ 名字带 `Panel` 是为了和日记自己的 `marks`（日历上那些有标记的日子）
   *   分开 —— 两个 `marks` 只差一个单词，改错一次就是「点划线栏把日历清了」。
   */
  const [marksPanelOpen, setMarksPanelOpen] = useState(
    () => localStorage.getItem('npr.diaryMarksOpen') !== '0',
  );
  const setMarksPanel = (next) => {
    setMarksPanelOpen(next);
    localStorage.setItem('npr.diaryMarksOpen', next ? '1' : '0');
  };
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
  /**
   * 侧栏时间轴里展开的那一天（同一次只展开一天）。
   *
   * ★ 0.47.4 起默认就是**今天**：用户 2026-10-29「时间轴上自动展开当天的」。
   *   原来初值是空串，打开灵感页先看到一排「今天／昨天／10-27」的日期条 ——
   *   还得再点一下才能知道自己今早写了什么，而「今天」几乎总是用户第一眼要找的。
   * ★ 用初值而不是 effect：effect 会在每次 `timeline` 重载后把用户**手动收起**的
   *   今天又摊开，等于这个折叠按钮时灵时不灵。今天没有条目时它自然什么也不画
   *   （`recentDays` 里没有这一项），不需要额外判断。
   */
  const [openDay, setOpenDay] = useState(today);
  /**
   * 「只看一个来源」（0.47）。`null` = 全部。
   *
   * ★ 侧栏**只有一条时间轴**，聚合不再是第三个选项卡，而是时间轴的**一次收窄**：
   *   数据换了来源，渲染一行都不换（`bySource()` 返回的 `days` 与时间轴同形）。
   *   用户 2026-10-29：「左边栏不应该分三个选项卡，而应该只有按时间的时间轴……
   *   只是时间轴上的条目做个区分」。而「这本书我记了什么」并没有消失 ——
   *   它从出处卡片进来，带着「你现在只看一个来源」那一条可关的横条。
   * ★ 不持久化：它是**一次提问的答案**，不是一档常驻视图。切模块就收回。
   */
  const [sourceScope, setSourceScope] = useState(null);
  /** 来源收窄时的时间轴数据（`bySource()`，与 `timeline.days` 同形）。 */
  const [sourceDays, setSourceDays] = useState({ days: [], total: 0, busy: false, error: '' });
  /**
   * 右侧列表按来源收窄用的键。
   *
   * ★ 从 `sourceScope` **派生**，不另存一份状态：两处各存一个布尔/字符串，
   *   迟早会出现「侧栏已经回到全部、右边还在筛」那种半截状态 —— 而那时
   *   用户看到的是「这一天的灵感少了几条」，找不到原因。
   * ★ 必须声明在 `sourceScope` **之后**：`const` 有暂时性死区，挪到前面会直接
   *   抛 `Cannot access 'sourceScope' before initialization`（0.47.0 首版就是这样，
   *   整个日记页白屏）。
   */
  const linkKey = sourceScope === null ? '' : sourceScope.label;
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
  /**
   * 读后感编辑器的「在光标处插入」入口（由 `DiaryComposer` 填进来）。
   *
   * ★ 为什么不是直接用 `refRef`（textarea 的 ref）：富文本模式下根本没有 textarea，
   *   `refRef.current` 是 `null` ⇒ 旧实现把 `at` 退回 `refDraft.length`，
   *   于是「引用」永远追加到正文末尾。用户点的是「引到这一段」，结果跑到最后一页 ——
   *   这是个静默的错位，不是「还没做」。
   */
  const insertRef = useRef(null);
  /**
   * 正文里是否已经带着模板的四个小标题。
   *
   * ★ 不用 `refDraft.trim() !== ''` 判断：那样「写了两句话再套模板」和
   *   「已经套过又点一次」长得一模一样 —— 而后者会把四个标题**再插一遍**，
   *   正文里于是出现两套「## 一句话总结」。按钮现在按这个标志变成「已套用」并禁用。
   */
  const refTemplated = refDraft.includes('## 一句话总结');
  /** 中间那张解锁卡。侧栏「那年今日」锁着时把人带到这里（见 `askUnlock`）。 */
  const gateRef = useRef(null);

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

  /**
   * 私密侧栏那两块卡片：本月情绪 / 连续天数 / 本月字数 / 那年今日。
   *
   * ★ 失败时**不清空**上一次的数（网络抖一下就变成三行「—」比留着旧数更糟），
   *   但也绝不把旧数当成新数 —— 所以 `error` 单独记，界面在旁边写一句「刚才没读上来」。
   * ★ 只在私密模块里发这个请求：`/dashboard` 读的是私密目录，别的模块没有这个语义。
   */
  async function loadDash() {
    if (moduleValue !== 'private') return;
    try {
      const payload = await fetchDiaryDashboard({ date: selected, today, month: monthKey });
      setDash({
        busy: false,
        locked: payload.locked === true,
        days: payload.days ?? 0,
        // ★ `chars` 锁着时是 **null**（不是 0）。留着 null，界面才能说「上锁了」而不是「0 字」。
        chars: typeof payload.chars === 'number' ? payload.chars : null,
        streak: payload.streak ?? 0,
        moods: Array.isArray(payload.moods) ? payload.moods : [],
        moodEntries: payload.moodEntries ?? {},
        onThisDay: Array.isArray(payload.onThisDay) ? payload.onThisDay : [],
        error: '',
      });
    } catch (cause) {
      setDash((current) => ({ ...current, busy: false, error: cause.message }));
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
      const payload = await fetchDiaryTimeline({ limit: TIMELINE_PAGE });
      setTimeline({ days: payload.days ?? [], truncated: payload.truncated === true, busy: false, more: false });
      if (payload.privateError) setError(`有私密日记解不开：${payload.privateError}`);
    } catch (cause) {
      setError(cause.message);
      setTimeline((current) => ({ ...current, busy: false }));
    }
  }

  /**
   * 「加载更早」：从当前**最早那一天**往前再取一页，追加在下面。
   *
   * ★ 游标用日期，不用「已加载 N 天」。后端是 `date < before`，中间隔着没写日记的日子
   *   也照样对得上；用条数当 offset 会在这种空档上错位，而且错得很安静。
   * ★ 追加按 `date` 去重：重复键会让 React 报 key 冲突，侧栏还会多出一行同一天。
   *   后端理论上不会跨页重复给同一天，但去重是**幂等**的保险，成本是一张 Set。
   * ★ 只有「这次真的拿到了新的天」才把 `truncated` 传下去。拿到 0 天却仍写着
   *   「还有更早」的话，按钮会永远停在那里，点一次什么也不发生 —— 那是死按钮。
   */
  async function loadMoreTimeline() {
    if (timeline.more || timeline.busy) return;
    const oldest = timeline.days[timeline.days.length - 1]?.date;
    if (!oldest) return;
    setTimeline((current) => ({ ...current, more: true }));
    try {
      const payload = await fetchDiaryTimeline({ limit: TIMELINE_PAGE, before: oldest });
      setTimeline((current) => {
        const seen = new Set(current.days.map((day) => day.date));
        const added = (payload.days ?? []).filter((day) => !seen.has(day.date));
        return {
          days: [...current.days, ...added],
          truncated: added.length > 0 && payload.truncated === true,
          busy: false,
          more: false,
        };
      });
      if (payload.privateError) setError(`有私密日记解不开：${payload.privateError}`);
    } catch (cause) {
      setError(cause.message);
      setTimeline((current) => ({ ...current, more: false }));
    }
  }

  /**
   * 书单 + 阅读状态 + 读后感索引一起拉。
   *
   * ★ 必须一起：读后感只对**读完**的书开放，而「读完」这个判据在 `/state` 里、
   *   不在 `/books` 里。分两次拉就会出现「书单已到、状态还没到」的一帧 ——
   *   那一帧里所有书都按「未读完」画成禁用，用户看到的是「我的书全灰了」。
   *
   * ★ `size` **必须原样带过来**（0.48 修）。封面只有两条真来源：EPUB 走宿主解包
   *   （只认 id），PDF 走客户端 pdf.js 渲染第一页 —— 而 `pdfCoverDataUrl()` 的
   *   第一件事是 `Number(book.size) > 0`，没有体积就直接抛错、回落到生成式封面。
   *   0.47 这里只留了 `{ id, title, ext }`，于是**同一条书在阅读页有真封面、
   *   在读后感侧栏是首字方块**（用户 2026-10-29 的原话：「为什么在电子书阅读
   *   这里可以获取到」）。阅读页把整条原始记录直接给了 `BookCover`，差别只在这。
   */
  async function loadBooks() {
    setBooks((current) => ({ ...current, busy: true, error: '' }));
    try {
      const [payload, states, index] = await Promise.all([
        fetchBooks(),
        fetchStates().catch(() => ({})),
        // 索引取不到不该让整份书单打不开：它只决定「标不标已写」。
        fetchReflectionIndex().catch(() => null),
      ]);
      setBooks({
        items: (payload.books ?? []).map((item) => ({
          id: item.id,
          title: item.title || item.filename || item.id,
          ext: item.ext,
          // 封面的两条真来源都要它（PDF 渲染首屏 / 缓存键 `id::size`）。
          size: Number(item.size) || 0,
          filename: item.filename,
        })),
        total: payload.total ?? 0,
        truncated: payload.truncated === true,
        busy: false,
        error: '',
      });
      setBookStates(states ?? {});
      applyReflectionIndex(index);
    } catch (cause) {
      setBooks({ items: [], total: 0, truncated: false, busy: false, error: cause.message });
    }
  }

  /** 把 `/reflections` 的回包包成 `bookId → { count, last }`；`null` = 这一轮没取到。 */
  function applyReflectionIndex(payload) {
    if (payload === null || payload === undefined) {
      // 保留上一次的表：写完一篇再刷新时，宿主偶发失败不该把标好的「已写」擦掉。
      setReflections((current) => ({ ...current, error: '读后感索引暂时取不到' }));
      return;
    }
    const map = {};
    for (const row of payload.books ?? []) {
      if (typeof row?.id === 'string' && row.id !== '') map[row.id] = { count: Number(row.count) || 0, last: row.last ?? '' };
    }
    setReflections({ map, ready: true, error: '' });
  }

  /** 单独刷新读后感索引（写完 / 删完一篇时用，不重拉整份书单）。 */
  async function reloadReflections() {
    try {
      applyReflectionIndex(await fetchReflectionIndex());
    } catch (cause) {
      setReflections((current) => ({ ...current, error: cause.message }));
    }
  }

  /** 一本书当前的状态名（`unread` / `reading` / `read` / `dropped`）。认不出的 id 按未读。 */
  const stateNameOf = (id) => (bookStates[id]?.state ?? 'unread');

  /**
   * 这本书**读完过没有**（0.44.3）。
   *
   * ★ 判据不是 `stateNameOf(id) === 'read'`：用户点「重新阅读」之后那本书回到「在读」，
   *   可他写过的读后感还在磁盘上 —— 入口跟着状态一起消失，就是「内容还在、门没了」
   *   （用户 2026-10-28：「如果用户又点击了重新阅读，那么读后感的列表下不应该消失」）。
   * ★ 判据本身在 `library.js` 的 `hasFinished` 里，宿主与这里共用一份 —— 这个页面上
   *   「哪本书算读完过」只有一套说法。
   */
  const finishedOf = (id) => hasFinished(bookStates[id]);

  /**
   * 打开一本书（读后感工作台）。
   *
   * ★ **只对读完（过）的书开放**（用户 2026-10-27：「这一步分一个非常重要的已经
   *   标记为读完的书，只有读完的书才可以写读后感」）。所以这里有两道闸：
   *   ① 侧栏只列 `finishedOf` 为真的书（没读过的根本不出现，点了也进不来）；
   *   ② 这个函数本身再判一次 —— 从阅读页「读完」那一行点「写读后感」进来时
   *      `openBook` 是直接调的（见 ReaderPage 的 `writeReflection`），没有经过侧栏
   *      那道 UI 闸。只做 ① 的话，从外面进来照样能写。
   * ★ 0.44.3：「读完」改成「读完过」（`hasFinished`）—— 点过「重新阅读」的书仍然
   *   开得进来，否则它会出现在侧栏里却点不动（那正是「看起来像功能」）。
   */
  async function openBook(target) {
    const finished = finishedOf(target.id);
    setBook({ ...target, readable: finished });
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
  /*
   * 私密侧栏那两块卡片。四种变化都会让它的数不再成立：翻月（统计月变了）、
   * 换天（那年今日的锚点变了）、解锁/上锁（宿主给不给内容变了）、切模块。
   * ★ 不能只挂在 `monthKey` 上 —— 那会让「翻到去年今天」还显示今年的统计。
   */
  useEffect(() => {
    if (moduleValue === 'private') void loadDash();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleValue, monthKey, selected, gate.unlocked]);
  useEffect(() => { fetchDiaryStats().then(setStats).catch(() => {}); }, [day.chars, day.privateCount]);

  /**
   * 从「阅读 → 读完」那一行的「写读后感」过来：**直接打开那本书**。
   *
   * ★ 不要求它在书单里 —— 书架会被 `BOOKS_PAGE_LIMIT` 截断（本机 2634 本），
   *   而 `/book/:id` 只认 id，截断之外的书照样读得到。所以这里用 intent 自带的
   *   `title` / `ext` 拼一个最小 book 对象，不去书单里找。
   * ★ 但「读完没有」必须先问清楚：`bookStates` 可能还是空的（书单还没拉回来），
   *   所以这里**先拉一次 states**，再 openBook。不这么做的话，从阅读页点进来会
   *   因为「状态未到」被判成没读完 —— 而用户刚刚在那边点过「标记读完」，
   *   或者早就读完了、只是点了「重新阅读」（那种书靠 `finishedAt` 仍然算读完过）。
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
    // 「只看本月某一档情绪」也是这一页的临时视图：切走再回来应该落在今天，
    // 而不是落在一张三天前的筛选列表上。
    setMoodFilter(null);
    // 来源收窄同理：它是「对这个来源的一次提问」，换模块就不该还留着。
    setSourceScope(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleValue]);

  /**
   * 来源收窄时的时间轴数据。
   *
   * ★ 依赖写 `scopeBook / scopeArticle` 两个**原始值**，不写 `sourceScope` 对象：
   *   对象每次渲染都是新的（`setSourceScope({...})`），写对象会让这个 effect
   *   在每次父组件渲染时重跑一遍全盘扫描 —— 而结果一个字都不会变。
   * ★ 关掉收窄时把数据也清掉：留着它，「回到全部」那一下会先用旧数据闪一下，
   *   而那份旧数据里只有某一个来源的几天。
   */
  const scopeBook = sourceScope?.kind === 'book' ? sourceScope.id : '';
  const scopeArticle = sourceScope?.kind === 'article' ? sourceScope.id : '';
  useEffect(() => {
    if (scopeBook === '' && scopeArticle === '') {
      setSourceDays({ days: [], total: 0, busy: false, error: '' });
      return undefined;
    }
    let alive = true;
    setSourceDays({ days: [], total: 0, busy: true, error: '' });
    (async () => {
      try {
        const payload = await fetchDiarySource({ book: scopeBook, article: scopeArticle });
        if (!alive) return;
        setSourceDays({
          days: payload.days ?? [],
          total: payload.total ?? 0,
          busy: false,
          error: '',
        });
      } catch (cause) {
        if (!alive) return;
        setSourceDays({ days: [], total: 0, busy: false, error: cause.message });
      }
    })();
    return () => { alive = false; };
  }, [scopeBook, scopeArticle]);

  /*
   * 出处浮层的四条关闭路径：Esc、点外面（遮罩）、滚动、改窗口大小。
   * ★ 滚动必须关：浮层是 `fixed`，列表一滚它就浮在**别的**条目上面，
   *   而它说的还是刚才那一条 —— 「点错条目」就是这么来的。
   *   捕获阶段收：滚动发生在内部容器（`.npr-diary-panel`）上，冒泡到不了 window。
   */
  useEffect(() => {
    if (!originPop) return undefined;
    const close = () => setOriginPop(null);
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [originPop]);

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
    // 写完 / 删完，侧栏的「本月 N 字」「连续 N 天」「情绪占比」都变了。
    if (moduleValue === 'private') await loadDash();
    if (moduleValue === 'reflection' && book) {
      try {
        const payload = await fetchDiaryBook(book.id);
        setBookEntries({ items: payload.entries ?? [], busy: false });
      } catch { /* 上面已经刷过当天，这里失败只影响这本书的列表 */ }
      // 刚写完 / 删完一篇，「已写 / 待写」那枚标记（和筛选条上的数）就变了。
      await reloadReflections();
    }
  }

  /**
   * 换一天。
   *
   * ★ 换天**不再**清掉来源收窄（0.47）。它现在是一条显式的横条，看得见、点得掉，
   *   所以「换了天就悄悄失效」反而会让人以为横条坏了。0.46 及之前它是个隐形的
   *   字符串状态，才必须靠 `pick()` 顺手清空来兜底（用户当时抱怨的正是
   *   「点击时间轴的条目就回不去了」）。
   */
  const pick = (date) => {
    setSelected(date);
    setConfirmKey('');
    /* 换一天时把「刚才定位到哪一条」和「展开了更早的」都收回：
       这两件事都是**对这一页**的临时状态，带到下一页只会让人以为没点对。
       `jump()` 是 pick + setFocusKey，同一个事件里后者生效（React 批处理，顺序即结果）。 */
    setFocusKey('');
    setDayAll(false);
    // 情绪筛选也是「对着这个月的一档情绪」的临时视图 —— 换了天就该失效，
    // 否则点进去看到的是那一天，而顶部还写着「只看本月 😄」。
    setMoodFilter(null);
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
   * 打开「这条灵感是从哪儿记的」浮层。
   *
   * 用户 2026-10-29 的原话：「如果是在 RSS 阅读期间按 L 添加的灵感，那这条点击
   * 书籍图标弹出的是什么时间、在哪篇文章下记录的这条灵感，并有一个直接跳转到
   * 这篇文章的按钮」。⇒ 这颗图标现在是**出处**，不是「挂到书上」。
   *
   * ★ 没有出处（直接在灵感页手记的那条）时**根本不渲染这颗图标** —— 同一个提法：
   *   「如果我直接在灵感页记录下的灵感，就没必要去往文章上挂，也就是说就不应该有
   *   这个书籍按钮显示」。判据在 `entryOrigin()`，不散在 JSX 里。
   * ★ 坐标在**打开的那一下**算好（右对齐到按钮右缘，见 `placeRowMenu`），
   *   而不是把按钮节点存下来每次渲染重量：日记页能滚，量一个已经滚走的按钮
   *   会把浮层贴到一个不存在的位置上。
   */
  function openOrigin(event, origin) {
    if (!origin) return;
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const spot = placeRowMenu({
      // ★ 0.46 是**右对齐**（`box.right - 宽度`），因为那时卡片只有 248 宽、贴着
      //   右端那颗图标才不别扭。现在卡片 300 宽，右对齐会被窗口右缘推回去、
      //   离来源那条 chip 越来越远 —— 改成贴 chip 的**左缘**，让它看起来是从
      //   那句话上「长出来」的。
      x: box.left,
      y: box.bottom + 6,
      width: ORIGIN_POP_W,
      height: ORIGIN_POP_H,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setOriginPop({ ...origin, left: spot.left, top: spot.top });
    void loadOriginCard(origin);
  }

  /**
   * 卡片里那段「这篇文章是什么」。
   *
   * ★ 书的封面来自**书架那一份**（`BookCover` 需要 `ext` 才能画真封面），
   *   而灵感模块平时不拉书架 —— 所以这里补一次，且只在需要时拉：
   *   为了画一张卡片去拉整个书架，等于每次打开灵感页都多一次请求。
   */
  async function loadOriginCard(origin) {
    const token = originLoadRef.current + 1;
    originLoadRef.current = token;
    if (origin.kind !== 'article') {
      setOriginMeta({ busy: false, entry: null, error: '' });
      if (books.items.length === 0 && !books.busy) void loadBooks();
      return;
    }
    if (origin.articleKey === '' || typeof api?.entryMeta !== 'function') {
      setOriginMeta({ busy: false, entry: null, error: '' });
      return;
    }
    setOriginMeta({ busy: true, entry: null, error: '' });
    try {
      const payload = await api.entryMeta(origin.articleKey);
      if (originLoadRef.current !== token) return;
      setOriginMeta({ busy: false, entry: payload?.entry ?? null, error: '' });
    } catch (cause) {
      if (originLoadRef.current !== token) return;
      setOriginMeta({ busy: false, entry: null, error: cause.message });
    }
  }

  /**
   * 「这个来源的全部灵感」—— 把时间轴收窄，不另开视图。
   *
   * ★ 先关卡片再收窄：卡片挂在条目上，条目属于「全部」那一份列表；列表一换，
   *   它对应的那条就不在了，而卡片还贴在屏幕上说着它。
   * ★ 同时展开的那一天也收回：收窄后日期集合变了，`openDay` 指着一个不在列表里的
   *   日期会让「哪几天是展开的」变成随机状态。
   */
  function openOriginScope() {
    if (originPop === null) return;
    const scope = {
      kind: originPop.kind,
      id: originScopeId,
      label: originPop.label,
      title: originPop.title,
    };
    setOriginPop(null);
    if (scope.id === '') return;
    setOpenDay('');
    setSourceScope(scope);
  }

  /**
   * 浮层里那颗「打开这本书 / 跳到这篇文章」。
   *
   * ★ 关浮层**先于**跳转：跳走的是整页（阅读器 / 书架），浮层留在原地只会
   *   在回来时还贴在屏幕上，而它对应的那条已经不一定是当前这一页了。
   * ★ 宿主没给回调（夹具、别的外壳）时这颗按钮不渲染 —— 见 `canOriginJump`。
   *   画一颗点了没反应的按钮比不画更糟。
   */
  function jumpOrigin(item) {
    const target = originTarget(item);
    setOriginPop(null);
    if (target === null) return;
    if (target.kind === 'book' && typeof onOpenBook === 'function') {
      onOpenBook({ bookId: target.bookId, title: target.title, page: target.page, chapter: target.chapter });
      return;
    }
    if (target.kind === 'article' && typeof onOpenArticle === 'function') {
      onOpenArticle(target.key);
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
    // 上锁时把「只看本月某一档情绪」也收掉：那张列表里全是宿主刚摘掉的正文摘要，
    // 留着它等于让「已上锁」和满屏摘要同框。
    setMoodFilter(null);
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

  /** 退出检索：连查询词一起清掉，侧栏回到「标签 + 时间轴」。 */
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

  /**
   * 一条划线要插进正文的那段 markdown。
   *
   * ★ 抽成函数是为了让「点引用」与「拖进编辑器」**插入逐字节相同的文本**。
   *   两处各拼一次的话，页码括号、结尾空行迟早会长得不一样（而用户会以为是
   *   「拖进去的和点进去的不是同一条」）。
   */
  function quoteSnippet(item) {
    const page = Number.isInteger(item.page) ? `（第 ${item.page} 页）` : '';
    return `> ${String(item.quote ?? '').replace(/\n+/g, ' ').trim()}${page}\n\n`;
  }

  /** 把一条划线引用进读后感正文（插在光标处，包成 Markdown 引用块）。 */
  function quoteAnnotation(item) {
    const snippet = quoteSnippet(item);
    if (insertRef.current) {
      insertRef.current(snippet, null);
      return;
    }
    // 编辑器还没挂上（或这一页还没打开）时的退路：追加到末尾，至少不会丢。
    setRefDraft((current) => `${current}${snippet}`);
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
  /**
   * 侧栏点了「挂在《X》上」之后，列表收窄成这个来源的那几条。
   *
   * ★ 收窄只作用在**列表**上（`listEntries`），不改 `visibleEntries`：顶栏的
   *   「7 条」说的是这一天的总量，跟着筛会让人以为这一天的记录变少了。
   * ★ 收窄之后仍然可能为 0（换到别的天、那天没有挂在这个来源上的）—— 那时由
   *   空状态说清楚「这一天没有挂在《X》上的」，而不是让列表静静空着。
   */
  const listEntries = linkKey === ''
    ? visibleEntries
    : visibleEntries.filter((entry) => sourceKey(entry.source) === linkKey);

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

  /**
   * 侧栏「本月情绪」那三格：占比最高的三档 + 各自占多少。
   *
   * ★ 分母是**记过心情的条数**，不是「这个月写了多少条」：没选心情的条目不进分布，
   *   拿总条数当分母会让三档加起来永远不到 100%，看起来像统计坏了。
   * ★ 只留前三档。五档全铺在 268px 里会变成五个几乎等宽的小方块，
   *   而「这个月主要是开心，其次一般」这句话用三格就说得完。
   */
  const dashMoods = useMemo(() => {
    const total = dash.moods.reduce((sum, cell) => sum + (cell.count ?? 0), 0);
    return dash.moods.slice(0, 3).map((cell) => {
      const meta = MOODS.find((item) => item.score === cell.score) ?? null;
      return {
        score: cell.score,
        count: cell.count ?? 0,
        share: total > 0 ? Math.round(((cell.count ?? 0) / total) * 100) : 0,
        emoji: meta?.emoji ?? '·',
        label: meta?.label ?? '未知',
      };
    });
  }, [dash.moods]);

  /** 点中的那一档情绪在右侧要摊开的那几行（宿主已经按日期倒序给好了）。 */
  const moodRows = moodFilter === null ? [] : (dash.moodEntries?.[String(moodFilter)] ?? []);
  const moodMeta = moodFilter === null ? null : (MOODS.find((item) => item.score === moodFilter) ?? null);

  /**
   * 「那年今日」被点了一下，但这一页还锁着。
   *
   * ★ 不自己画一个口令框：中间那块解锁卡已经在那儿了（`.npr-gate`），
   *   再弹一个就是两处入口、两套错误提示。这里做的是**把人带到那一个**，
   *   并把光标放进输入框 —— 用户点一下就能开始输。
   */
  function askUnlock() {
    const box = gateRef.current;
    if (!box) return;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.querySelector('input')?.focus();
  }

  /**
   * 时间轴当下要铺的那份数据：来源收窄时换成 `bySource()`，否则就是普通时间轴。
   *
   * ★ 两者**同形**（`days[{date, entries[]}]`），所以这里是 `const` 换数据源，
   *   而不是换渲染 —— 聚合视图之所以不该是第三个选项卡，就是为了不出现第二套
   *   条目样式与第二套排序（0.47 之前「按书本」两样都有）。
   * ★ 必须排在 `recentDays` **之前**：`const` 有暂时性死区，下面再引用它就是白屏。
   */
  const timelineDays = sourceScope === null ? timeline.days : sourceDays.days;
  const timelineBusy = sourceScope === null ? timeline.busy : sourceDays.busy;

  /** 灵感侧栏的「时间轴」：日期 + 条数 + **当天的条目**（点开才展开，见 openDay）。 */
  const recentDays = timelineDays
    .map((item) => {
      const ideas = (item.entries ?? []).filter((entry) => entry.kind !== '读后感' && entry.scope === 'public');
      return { date: item.date, count: ideas.length, entries: ideas };
    })
    .filter((item) => item.count > 0);

  /** 书架那份：书名 → `ext`（决定这本书画真封面还是生成封面）。 */
  const bookById = new Map(books.items.map((item) => [item.id, item]));
  /** 出处卡片上那块封面用的书；找不到就是 `null`（卡片改画首字块，不留空框）。 */
  const originBook = originPop?.kind === 'book' ? (bookById.get(originPop.bookId) ?? null) : null;
  /**
   * 出处卡片的三行字：标题 / 出处元信息 / 摘要。
   *
   * ★ 标题**优先用订阅源那条**（`titleZh || title`），退回到日记里记下的那串：
   *   记灵感时写进 `source` 的可能是个截断过的标题，而 `entryMeta()` 给的是完整的。
   * ★ 章节页码只在**确实是整数**时印出来：0.30 的老条目没有这两个字段，
   *   印一个 `第 0 章` 是在编造。
   */
  const originEntry = originMeta.entry;
  const originCardTitle = originPop === null
    ? ''
    : (originPop.kind === 'article'
      ? (originEntry?.titleZh || originEntry?.title || originPop.title)
      : originPop.title);
  const originCardMeta = (() => {
    if (originPop === null) return '';
    if (originPop.kind === 'book') {
      const bits = [];
      if (Number.isInteger(originPop.chapter) && originPop.chapter > 0) bits.push(`第 ${originPop.chapter} 章`);
      if (Number.isInteger(originPop.page) && originPop.page > 0) bits.push(`第 ${originPop.page} 页`);
      return bits.join(' · ');
    }
    if (originEntry === null) return '';
    const bits = [];
    if (originEntry.channelName) bits.push(originEntry.channelName);
    if (originEntry.author) bits.push(originEntry.author);
    const day = isoDay(originEntry.publishedAt);
    if (day !== '') bits.push(`${stampLabel(day, '', today)}发布`);
    return bits.join(' · ');
  })();
  const originCardSummary = originPop?.kind === 'article' ? (originEntry?.summary ?? '') : '';
  /** 聚合视图的入口要的那个 id（老条目只有书名，没有 id 就点不进聚合）。 */
  const originScopeId = originPop === null
    ? ''
    : (originPop.kind === 'book' ? originPop.bookId : originPop.articleKey);

  /**
   * 出处浮层里那颗「去现场」按钮该不该出现。
   *
   * ★ 要两件事同时成立：这条**有 id**（老条目只有书名），且**宿主给了回调**。
   *   少一个就画出一颗点了没反应的按钮 —— 比不画更糟，用户会以为功能坏了。
   *   跳不了时浮层里换成一句解释（`originMissNote`），不是静静少一个按钮。
   */
  const originJump = originPop ? originTarget(originPop) : null;
  const canOriginJump = originJump !== null
    && (originJump.kind === 'book'
      ? typeof onOpenBook === 'function'
      : typeof onOpenArticle === 'function');
  /**
   * 跳不了时到底是哪一种：**没记下 id**，还是**宿主没接上**。
   *
   * ★ 0.47 把两者都写成「这本书已经不在书架上了」—— 用户 2026-10-29 在书还开着
   *   的时候看到这句，直接判成 bug。文案必须按真实原因说。
   */
  const originMissReason = originJump === null ? 'missing-id' : 'no-host';

  const filteredBooks = books.items.filter((item) => (
    bookQuery.trim() === '' || item.title.toLowerCase().includes(bookQuery.trim().toLowerCase())
  ));
  const readBooks = filteredBooks.filter((item) => finishedOf(item.id));

  /**
   * 名单上的「已写 / 待写」（0.48）。
   *
   * ★ 判据只有一条：`reflections.map[id].count > 0`。**不**用「点开这本书有没有
   *   条目」——那是 N 次读盘，而这里要给的是一个能一眼扫过去的标记。
   * ★ `ready === false`（索引没取到）时不算「待写」：把「查不到」写成「你一篇都
   *   没写过」是确定的假话。这时筛选条不出现，卡片也不挂标记。
   */
  const shelfMeta = (item) => {
    const row = reflections.map[item.id];
    return row === undefined ? null : row;
  };
  const writtenBooks = readBooks.filter((item) => (shelfMeta(item)?.count ?? 0) > 0);
  const blankBooks = readBooks.filter((item) => shelfMeta(item) === null);
  const shelfBooks = shelfFilter === 'written' ? writtenBooks
    : (shelfFilter === 'blank' ? blankBooks : readBooks);
  const shelfChips = [
    { key: 'all', label: '全部', count: readBooks.length },
    { key: 'written', label: '写过', count: writtenBooks.length },
    { key: 'blank', label: '待写', count: blankBooks.length },
  ];

  /**
   * 书籍档案卡上的数。**全部来自已经在手的数据**，打开一本书不额外多读一次盘。
   * ★ 「摘录笔记」= 划线里**写过 note 的**那些：只有 quote 的是划线，加了 note 才是笔记。
   *   这两个数在界面上必须分开，否则「划线 12」会让人以为写了 12 条笔记。
   */
  const noteCount = annotations.items.filter((item) => String(item.note ?? '').trim() !== '').length;

  /**
   * 页脚那句「东西在哪」——**按当前模块挑自己的那份**。
   *
   * ★ 以前直接印合计：`日记共 4 天（私密 1 天）· 5 KB`。于是灵感模块底部也会报
   *   私密的天数、把私密的密文算进字节里，再挂一个导出私密明文的按钮。
   *   用户 2026-10-27 的原话：「这个数据怎么还在灵感这里出现」。
   * ⇒ 灵感只报灵感的天数与字节、指到 `root`；私密只报私密的、指到 `root/private`。
   *   至于「导出私密明文」那个入口，它属于私密模块 —— 灵感页里不需要它，
   *   顶栏那个导出按钮已经管了「导出全部日记」。
   */
  const footPrivate = moduleValue === 'private';
  const footDays = footPrivate ? (stats?.privateDays ?? 0) : (stats?.publicDays ?? 0);
  const footBytes = footPrivate ? (stats?.privateBytes ?? 0) : (stats?.publicBytes ?? 0);
  const footWhere = footPrivate ? `${stats?.root ?? ''}/private` : (stats?.root ?? '');
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
  const entriesShown = dayAll ? listEntries : listEntries.slice(-DAY_PREVIEW);
  const entriesHidden = Math.max(0, listEntries.length - entriesShown.length);
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
      /* `--npr-list-width` 也提到这一层：AI 面板的宽度上限要在**这里**算
         （「正文至少留 340px」得先扣掉导航那 268px），而它原来只写在 `.npr-layout`
         的 inline style 上 —— 那是兄弟节点，面板读不到。 */
      style={{ '--npr-companion-width': `${companionWidth}%`, '--npr-list-width': `${listWidth}px` }}>
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
             * 灵感侧栏 = 一条时间轴 + 一个标签云。
             *
             * ★ 0.47 之前这里是「按时间 / 按书本 / 按文章」三档切换器。用户 2026-10-29
             *   推翻了它：「不应该分三个选项卡……而应该只有按时间的时间轴，不管是在
             *   RSS 文章阅读期间还是在读电子书期间按 L 创建的灵感还是在灵感专题页下记录
             *   的灵感都显示在这条时间轴上」。那三档不是三个视图，是同一份数据的三种排法；
             *   而「按书本」还换掉了一整套行结构 —— 同一个问题有两套排序、两套条目样式。
             * ★ 聚合（这本书 / 这篇文章的全部灵感）现在是时间轴的**一次收窄**：入口在
             *   出处卡片里，出口是这一栏顶上那条带 ✕ 的横条。换数据源，不换渲染。
             * ★ 0.31.0 这里是一份「最近 30 天、每天每条的时间 + 正文前 160 字」，那是把
             *   右边的正文抄了一遍 —— 用户 2026-10-27 的原话是「实在是不符合常理」。
             */
            <div className="npr-diary-panel">
              <section className="npr-diary-sect">
                <h2 className="npr-diary-sect-head"><Icon name="tag" size={12} />标签
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

              {/*
               * 「只看一个来源」的横条（0.47）。**只在收窄时出现** —— 默认态这一栏
               * 一个筛选控件都没有，用户 2026-10-29 要的正是这个：「不应该分三个
               * 选项卡，而应该只有按时间的时间轴」。
               * ★ 它承担两件事：告诉用户「现在不是全部」，以及给一条明确的退路。
               *   少了前一件，用户会以为自己的灵感变少了（这正是选项卡时代的病）；
               *   少了后一件，就变成了「进去了出不来」。
               */}
              {sourceScope !== null && (
                <div className={`npr-diary-scope${sourceScope.kind === 'book' ? ' is-book' : ' is-article'}`}>
                  <Icon name={originIcon(sourceScope)} size={12} />
                  <span className="npr-diary-scope-title" title={sourceScope.title}>{sourceScope.title}</span>
                  <span className="npr-diary-scope-count">
                    {sourceDays.busy ? '正在数…' : `全部 ${sourceDays.total} 条`}
                  </span>
                  <button type="button" className="npr-diary-scope-close" aria-label="回到全部灵感"
                    title="回到全部灵感" onClick={() => setSourceScope(null)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              )}

              <section className="npr-diary-sect">
                {/*
                 * ★ 0.47.3：标题叫「你的灵感时间线」，并且用 `is-lead` 抬成这一栏的主标题。
                 *   用户 2026-10-29：「这个时间轴明显一些，名称重新创意，比如你的灵感时间线
                 *   之类的」。原来 12px/600 和它统辖的日期行（12.5px）几乎同号 ——
                 *   标题比内容还小，当然不像标题。层级靠**字号 + 品牌色图标块**拉开，
                 *   不靠再压一层底色：侧栏里已经全是灰条，再加块状会碎。
                 */}
                <h2 className="npr-diary-sect-head is-lead">
                  <span className="npr-diary-sect-mark"><Icon name="clock" size={12} /></span>
                  你的灵感时间线
                </h2>
                {timelineBusy && <p className="npr-diary-sect-note">正在读…</p>}
                {!timelineBusy && recentDays.length === 0 && (
                  <p className="npr-diary-sect-note">
                    {sourceScope === null
                      ? '还没有灵感。右边写一句就行。'
                      : sourceDays.error !== '' ? sourceDays.error : '这个来源下还没有灵感。'}
                  </p>
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
                            {item.entries.map((entry) => {
                              /*
                               * ★ 0.47.4：一条灵感分两层显示（首句当标题、余下当摘要）。
                               *   判断在 `entryLines()` 里 —— 它决定「这条有几行」，
                               *   写进 JSX 的三元里就没法写判据了。
                               *   `title` 属性仍留全文预览：两行摘要放不下的时候，
                               *   鼠标停一下还能读到 160 字。
                               */
                              const lines = entryLines(entry.preview);
                              return (
                                <li key={entryKey(entry)}>
                                  {/* 这一项是不是「刚被点过的那一条」——右侧正文里同一条也在高亮，
                                      两处同时亮才叫「对应」。只亮右边的话，用户得自己在一屏里找。 */}
                                  <button type="button"
                                    className={`npr-diary-dayitem${focusKey === entryKey(entry) ? ' is-focus' : ''}`}
                                    aria-current={focusKey === entryKey(entry) ? 'true' : undefined}
                                    title={`${entry.time} ${entry.preview}`}
                                    onClick={() => jump(item.date, entryKey(entry))}>
                                    <span className="npr-diary-dayitem-time">{entry.time}</span>
                                    <span className="npr-diary-dayitem-body">
                                      <span className="npr-diary-dayitem-title">{lines.title}</span>
                                      {lines.rest !== '' && (
                                        <span className="npr-diary-dayitem-rest">{lines.rest}</span>
                                      )}
                                    </span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/*
                 * 「加载更早」：0.39 之前这里只有一句「只看了最近 N 天。」——
                 * 用户看得到「还有更早的」，却没有任何办法把它们调出来。
                 * ★ 数字必须印在按钮上：只说「加载更早」，用户不知道还差多少；
                 *   而 `truncated` 只说明「还有」，不说明「还有几天」。
                 * ★ 禁用态给的是「正在读…」而不是灰掉不动 —— 一次翻页要读 30 个文件，
                 *   在慢盘上能到几百毫秒，没有文字的话那一下像没点中。
                 */}
                {/* 收窄时不翻页：`bySource()` 已经是全部，「加载更早」在这里是假的。 */}
                {sourceScope === null && timeline.truncated && (
                  <button type="button" className="npr-diary-dayload"
                    disabled={timeline.more || timeline.busy}
                    onClick={() => void loadMoreTimeline()}>
                    {timeline.more
                      ? '正在读更早的记录…'
                      : `加载更早 · 目前只显示最近 ${timeline.days.length} 天`}
                  </button>
                )}
              </section>

            </div>
          ) : moduleValue === 'private' ? (
            <div className="npr-diary-panel">
              <DiaryCalendar year={month.year} month0={month.month0} marks={privateDays} tones={privateTones}
                selected={selected} today={today}
                onPick={pick} onShift={(delta) => setMonth(shiftMonth(month.year, month.month0, delta))} onToday={() => pick(today)} />
              <section className="npr-diary-sect">
                <h2 className="npr-diary-sect-head"><Icon name="calendar" size={12} />这个月</h2>
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

              {/* ---- 本月情绪与足迹 ------------------------------------------
                  日历下面这块原本一直空着（268px 宽、半屏高）。放两块卡片：
                  上面是「这个月的心情长什么样」，下面是「去年的今天写过什么」。
                  ★ 两块都做成卡片（微边框 + 比侧栏深一档的底），与上面的日历、
                    「这个月」列表形成分界 —— 不然它们看起来像同一张列表的续行。 */}
              <section className="npr-diary-card" aria-label="本月情绪与足迹">
                <h2 className="npr-diary-card-head"><Icon name="sparkles" size={12} />本月情绪</h2>
                {dash.busy && <p className="npr-diary-card-note">正在数这个月…</p>}
                {/*
                  * ★ 锁着时**不假装**「这个月没有心情」：宿主确实没给，但那是权限问题
                  *   不是数据问题。所以这里说的是「解锁后才看得到」，而连续天数照常显示
                  *   （它只靠文件名，宿主锁着也给）。
                  */}
                {!dash.busy && dash.locked && (
                  <p className="npr-diary-card-note">上锁时只数天数。心情分布与字数要解锁后才看得到。</p>
                )}
                {!dash.busy && !dash.locked && dashMoods.length === 0 && (
                  <p className="npr-diary-card-note">这个月还没记过心情。写的时候点一个表情，这里就长出来了。</p>
                )}
                {!dash.busy && !dash.locked && dashMoods.length > 0 && (
                  <div className="npr-diary-moods">
                    {dashMoods.map((cell) => (
                      <button
                        key={cell.score}
                        type="button"
                        className={`npr-diary-mood${moodFilter === cell.score ? ' is-on' : ''}`}
                        aria-pressed={moodFilter === cell.score}
                        title={`本月「${cell.label}」的条目 ${cell.count} 条，占记过心情的 ${cell.share}%`}
                        onClick={() => setMoodFilter((current) => (current === cell.score ? null : cell.score))}>
                        <span className="npr-diary-mood-emoji" aria-hidden="true">{cell.emoji}</span>
                        <span className="npr-diary-mood-share">{cell.share}%</span>
                        <span className="npr-diary-mood-label">{cell.label}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="npr-diary-facts">
                  <span className="npr-diary-fact" title="从今天往前连着写了多少天。今天还没写就从昨天起算 —— 一个还没到的日子不该把已有的记录判成断了。">
                    <strong>{dash.streak}</strong> 天连续
                  </span>
                  <span className="npr-diary-fact" title={dash.chars === null ? '上锁时不显示字数。' : '这个月私密日记的正文字数，不含时间戳与元信息。'}>
                    <strong>{dash.chars === null ? '—' : dash.chars}</strong> 字
                  </span>
                </div>
                {dash.error !== '' && <p className="npr-diary-card-note is-error">刚才没读上来：{dash.error}</p>}
              </section>

              {/* ---- 那年今日 ------------------------------------------------
                  ★ 只列**更早年份**的同月同日，最多 5 条：今天写的日记不是「那年今日」。
                  ★ 摘要由宿主给（60 字）。侧栏放不下正文，点一行才回到那一天。 */}
              <section className="npr-diary-card" aria-label="那年今日">
                <h2 className="npr-diary-card-head"><Icon name="clock" size={12} />那年今日</h2>
                {dash.busy && <p className="npr-diary-card-note">正在翻旧账…</p>}
                {!dash.busy && dash.onThisDay.length === 0 && (
                  <p className="npr-diary-card-note">这一天，时光悄悄走过，还没有留下痕迹 ✨</p>
                )}
                {!dash.busy && dash.onThisDay.map((cell) => (
                  <button
                    key={cell.date}
                    type="button"
                    className={`npr-diary-echo${cell.locked ? ' is-locked' : ''}`}
                    title={cell.locked ? '解锁后方可穿越时空' : `回到 ${cell.date}${cell.time ? ` ${cell.time}` : ''}`}
                    onClick={() => (cell.locked ? askUnlock() : pick(cell.date))}>
                    <span className="npr-diary-echo-when">📅 {cell.years} 年前的今天</span>
                    <span className="npr-diary-echo-text">
                      {cell.locked ? '解锁后方可穿越时空' : (cell.preview || '（那天没有留下正文）')}
                    </span>
                  </button>
                ))}
              </section>
            </div>
          ) : (
            <div className="npr-diary-panel">
              {/* ★ 这是一个**输入框**，不是一条注记（用户 2026-10-29：「下面这个既是
                  说明标签又是搜索框对吗？搜索框太不明显了」）。
                  旧版本两处一起把人骗了：placeholder 写成「只列出标记为读完的书…」
                  （那是说明语，不是「要我输入什么」），外形又只有一块 4% 淡底、
                  没有描边也没有搜索图标。现在：placeholder 只剩搜索语，
                  框本体长出描边 + 放大镜，有内容时右边给一个清空按钮。 */}
              <div className="npr-search-box npr-diary-shelfsearch">
                <div className="npr-diary-searchfield">
                  <Icon name="search" size={13} className="npr-diary-searchicon" />
                  <input type="search" aria-label="搜书名" placeholder="搜书名…" value={bookQuery}
                    onChange={(event) => setBookQuery(event.target.value)} />
                  {bookQuery !== '' && (
                    <button type="button" className="npr-diary-searchclear" aria-label="清空搜索"
                      title="清空" onClick={() => setBookQuery('')}>
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </div>
              </div>
              {books.busy && <p className="npr-diary-sect-note">正在读书架…</p>}
              {!books.busy && books.error !== '' && <p className="npr-diary-sect-note is-error">{books.error}</p>}

              {!books.busy && books.error === '' && (
                <section className="npr-diary-sect">
                  {/* ★ 这个名单的取向是「**读完过**」，不是「此刻状态是读完」：点过
                      「重新阅读」的书仍然留在里面（用户 2026-10-28 的要求），
                      卡片上会挂一枚「在读」/「弃读」的小牌子把那件事说清楚 ——
                      否则一份叫「读完过」的名单里躺着一本在读的书，就是一句假话。 */}
                  <h2 className="npr-diary-sect-head is-lead">
                    <span className="npr-diary-sect-mark"><Icon name="book-open" size={13} /></span>
                    思想留白 · 拾遗
                    <span className="npr-diary-sect-badge">{readBooks.length}</span>
                  </h2>
                  {/* ★ 「已写 / 待写」不是一个装饰标签（0.48）。这份名单里本来就混着
                      两件事：书读完了、以及读后感写了没有 —— 不分开看，用户只能一本
                      一本点进去才知道哪些还欠着。筛选条只在索引取到时出现：取不到时
                      三个数字都是假的，宁可不画。 */}
                  {reflections.ready && readBooks.length > 0 && (
                    <div className="npr-diary-shelffilter" role="group" aria-label="按读后感筛选">
                      {shelfChips.map((chip) => (
                        <button key={chip.key} type="button"
                          className={`npr-diary-shelfchip${shelfFilter === chip.key ? ' is-on' : ''}`}
                          aria-pressed={shelfFilter === chip.key}
                          onClick={() => setShelfFilter(chip.key)}>
                          {chip.label}
                          <span className="npr-diary-shelfchip-n">{chip.count}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* 索引取不到时**说一句**，不是静静少几枚标记：用户看到的会是
                      「上次标着 3 篇，今天没了」，而他没有任何线索。 */}
                  {!reflections.ready && reflections.error !== '' && (
                    <p className="npr-diary-sect-note">读后感索引暂时取不到，这一轮先不标「已写 / 待写」：{reflections.error}</p>
                  )}
                  {readBooks.length === 0 && (
                    <p className="npr-diary-sect-note">还没有读完的书。到「阅读 → 读完」点那本书右边的「写读后感」，或者在书里读完点「标记读完」，它就会出现在这里。</p>
                  )}
                  {readBooks.length > 0 && shelfBooks.length === 0 && (
                    <p className="npr-diary-sect-note">
                      {shelfFilter === 'written'
                        ? '读过的书里，还没有一本留下读后感。挑一本打开，从右侧的模板开始写。'
                        : '这一档里没有书。'}
                    </p>
                  )}
                  {/*
                    * ★ 两列封面网格，不是单行列表：用户 2026-10-28 的原话是
                    *   「把密密麻麻的单行文本列表改成两列式、带封面的卡片网格，
                    *   让侧栏有实体书房的氛围」。
                    * ★ 封面只有两条真来源（EPUB 内嵌 / PDF 第一页），其余**生成** ——
                    *   见 `book-cover.js` 顶部：书架索引里没有 cover 字段，
                    *   所以「没有封面图就画一个」不是偷懒，是唯一诚实的做法。
                    *   0.48 修的是另一件事：那条 PDF 路径本来就能走通，是这里把
                    *   `size` 弄丢了（见 `loadBooks`），于是有真封面的书也被画成了方块。
                    */}
                  <div className="npr-diary-shelf">
                    {shelfBooks.map((item) => {
                      const name = stateNameOf(item.id);
                      const flag = name === 'read' ? '' : (BOOK_STATE_LABELS[name] ?? '');
                      const written = shelfMeta(item)?.count ?? 0;
                      /* 悬停说明把三件事串起来：书名 · 状态（如果已不是在读）· 写没写。
                         卡片上放不下的那句「读后感还在」，就落在 title 里。 */
                      const tip = [item.title];
                      if (flag !== '') tip.push(`${flag} —— 读后感还在`);
                      if (reflections.ready) tip.push(written > 0 ? `写过 ${written} 篇读后感` : '还没写过读后感');
                      return (
                        <button key={item.id} type="button"
                          className={`npr-diary-shelfcard${book?.id === item.id ? ' npr-selected' : ''}`}
                          aria-pressed={book?.id === item.id}
                          title={tip.join(' · ')}
                          onClick={() => void openBook(item)}>
                          <BookCover book={item} />
                          <span className="npr-diary-shelfcard-title">{item.title}</span>
                          <span className="npr-diary-shelfcard-meta">
                            <span className="npr-diary-shelfcard-ext">{formatExt(item.ext)}</span>
                            {flag !== '' && <span className="npr-diary-shelfcard-flag">{flag}</span>}
                            {/* 已写 / 待写：一枚就够，别在卡片上排三个胶囊（两列网格
                                每格约 110px，第三个一定会换行成孤儿）。 */}
                            {reflections.ready && (written > 0
                              ? <span className="npr-diary-shelfcard-mark is-written">{written} 篇</span>
                              : <span className="npr-diary-shelfcard-mark is-blank">待写</span>)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {/*
               * ★ 这里原本还有一块「还没读完（2636）」的列表。用户 2026-10-27：
               *   「读后感只显示标记完成的书，不显示未读完的书」。
               *   这一栏的用途是「解释为什么点不动」，但代价是把整个书架摊在侧栏里 ——
               *   2636 行既压掉了真正要选的那 1 本，也让「这里能做什么」变得不可读。
               *   门禁本身不受影响：`openBook` 与 `finishedOf` 仍然挡住没读完的书，
               *   而外部进来的那条路（阅读页「读完」行的「写读后感」）本来就只出现在
               *   读完的书上（见 `bookRowView` 的 read 分支）。
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
              {/* ★ `hasDock` 是这块的闸：读后感「还没选书 / 没读完」时上面**不该有**
                  一个空着的写作坞（会留下一条 24px 的空白带 + 一条边线，看起来像
                  加载失败的占位）。判据写在 `hasDock` 里，三种模块各有一道闸。 */}
              {hasDock && (
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
                {moduleValue === 'private' && (gate.available === false || gate.unlocked) && moodFilter === null && (
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
                  <section className="npr-diary-write is-paper">
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
                      insertRef={insertRef}
                      maxHeight={300}
                      placeholder="写下这本书留给你的东西。"
                      /*
                       * 模板条从底栏挪到编辑器上方：它是这一页的「结构」，不是
                       * 「保存/清空」那一类的动作。底栏留三个动作会让人以为三件
                       * 事同级 —— 而「清空」和「记下来」本来就不该同级。
                       */
                      header={(
                        <div className="npr-diary-tplbar">
                          <span className="npr-diary-tplbar-label">结构化读后感模板</span>
                          <button type="button" className="npr-diary-tplbtn" disabled={refTemplated}
                            title={refTemplated
                              ? '正文里已经有这四个小标题了。想恢复结构，把它们补回来即可 —— 再点一次会把模板重复插一遍。'
                              : '把「一句话总结 / 核心收获 / 行动指南 / 金句摘录」四个小标题填进正文'}
                            onClick={() => setRefDraft((current) => (current.trim() === '' ? REFLECTION_TEMPLATE : `${current.replace(/\s+$/, '')}\n\n${REFLECTION_TEMPLATE}`))}>
                            {refTemplated ? '已套用' : '套用模板'}
                          </button>
                        </div>
                      )}
                      actions={(
                        <button type="button" className="npr-diary-linkish is-danger" onClick={() => setRefDraft('')}>清空</button>
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
                    </div>                  ) : (
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
                        左边只列<strong>读完过</strong>的书。没读完的不在里面 ——
                        读后感是读完之后的事，不是阅读进度的一部分。读完之后又点了
                        「重新阅读」的书仍然留在里面：它写过的读后感不会因为再读一遍就消失。
                      </p>
                      <p className="npr-welcome-intro">
                        点左边任意一本，右边就是写给它的地方。写下的这一页会记住书名、
                        章节和页码，以后翻这本，还找得到当时写在哪里。
                      </p>
                      <p className="npr-welcome-intro">
                        也可以从那边过来：「阅读 → 读完」里每本书右边都有一颗
                        「<strong>写读后感</strong>」，点它就直接带着这本书落到这一页。
                      </p>
                      <div className="npr-welcome-keys">
                        <span>读完 {readBooks.length} 本</span>
                        <span>书架共 {books.total} 本</span>
                      </div>
                    </div>
                  )
                )}

                {/* ---- 只看本月某一档情绪 --------------------------------------
                    ★ 这块**替换**掉「这一天的条目」，不是叠在它上面：用户点的是
                      「本月 😄 的所有日记」，那是一个跨天的列表，与「这一天写了什么」
                      是两件事。两块同时在场，人会以为下面那堆也属于这个筛选。
                    ★ 点一行就回到那一天 —— 想改哪一条都能在那边改，这里只负责找。 */}
                {moodFilter !== null && (
                  <section className="npr-diary-moodview" aria-label="本月这一档情绪">
                    <div className="npr-diary-filterbar">
                      <span className="npr-diary-filterbar-text">
                        只看本月 <b>{moodMeta?.emoji} {moodMeta?.label}</b> · {moodRows.length} 条
                      </span>
                      <button type="button" className="npr-diary-filterbar-clear" onClick={() => setMoodFilter(null)}>全部</button>
                    </div>
                    {moodRows.length === 0 && (
                      <div className="npr-diary-blank">
                        <p>这个月已经没有这一档的记录了。</p>
                        <p>可能是刚删掉，或者换了一个月。点上面的「全部」回到这一天。</p>
                      </div>
                    )}
                    {moodRows.map((row, at) => (
                      <button
                        key={`${row.date}-${at}`}
                        type="button"
                        className="npr-diary-echo is-row"
                        title={`回到 ${row.date}${row.time ? ` ${row.time}` : ''}`}
                        onClick={() => pick(row.date)}>
                        <span className="npr-diary-echo-when">{dayLabel(row.date, today)} · {row.time}</span>
                        <span className="npr-diary-echo-text">{row.preview || '（没有正文）'}</span>
                      </button>
                    ))}
                  </section>
                )}

                {/* ---- 条目列表 --------------------------------------------- */}
                {moduleValue !== 'reflection' && moodFilter === null && (
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
                      <section className="npr-gate" aria-label="私密日记已上锁" ref={gateRef}>
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
                    {!loading && listEntries.length === 0 && (
                      linkKey !== '' ? (
                        <div className="npr-diary-blank">
                          <p>这一天没有记自这个来源的灵感。</p>
                          <p>侧栏那条横条统计的是<strong>所有天</strong>；换到有记录的那一天，或者点它右端的 ✕ 回到全部。</p>
                        </div>
                      ) : (
                        <div className="npr-diary-blank">
                          <p>{moduleValue === 'private' ? '这一天还没有私密日记。' : '这一天还没有灵感。'}</p>
                          <p>{moduleValue === 'private'
                            ? '上面写一句就行。私密的只留在本机，不同步、不进模型。'
                            : '上面写一句就行 —— 灵感多半是半句话。'}</p>
                        </div>
                      )
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
                      /*
                       * 这一条的**出处**（0.47：从一颗 13px 图标改成带字的 chip）。
                       * ★ 判据在 `entryOrigin()` 里，不散在这里写三元：它决定「有没有那颗
                       *   图标」，而错了在界面上看不出来（多一颗点了没内容的 / 少一颗该有的）。
                       * ★ 私密条目一律不给：私密那半边不进 `timeline()`，也不按来源组织，
                       *   给出处只会多一颗点了没地方去的按钮。
                       */
                      const origin = privateSide ? null : entryOrigin(entry, entry.date ?? selected);
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
                            {/*
                              * 出处 chip（0.47）。
                              *
                              * ★ 0.46 是一个 13px 的图标按钮，藏在右侧动作列里 —— 用户的
                              *   判词是「这个图标点击就可以弹出…」但没人知道那颗图标是什么，
                              *   而且 13px 在 268px 的栏里不好点。现在它是**带字的**：
                              *   图标 + 出处标题，一眼能看出「这条是在哪儿记的」。
                              * ★ 没有出处（灵感页手记的那条）**整颗不渲染**。空格本身就是
                              *   第三态，不需要再加一枚「手记」标记 —— 用户 2026-10-29：
                              *   「如果我直接在灵感页记录下的灵感……就不应该有这个书籍按钮显示」。
                              * ★ 底色与图标是**同一个信息**（书=琥珀 / 文章=蓝）：整行铺底色会
                              *   和 `is-focus` 的高亮叠成第三种颜色，而来源是属性、不是状态。
                              */}
                            {origin !== null && (
                              <button type="button"
                                className={`npr-diary-origin${origin.kind === 'book' ? ' is-book' : ' is-article'}`}
                                title={`${origin.source} · 点开看出处`}
                                onClick={(event) => openOrigin(event, origin)}>
                                <Icon name={originIcon(origin)} size={12} />
                                <span className="npr-diary-origin-name">{origin.title}</span>
                              </button>
                            )}
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
                    {/*
                      * ★ 用户 2026-10-28：「将原先下方碎裂的『历史记下一篇』卡片合并为
                      *   单篇完整的卡片式长文」。原来每一篇都是一张独立的
                      *   `.npr-diary-entry`（各有上边框），三篇以上就是三张卡片的堆叠，
                      *   读起来像三条通知，而不是「这本书我一直在写」。
                      * ★ **只并渲染，不并数据**：存储仍然是一天一篇的 .md。
                      *   真合并会改掉导出、按天检索与标签索引的语义 —— 那是另一件事，
                      *   也是用户明确没要的那件。
                      * ★ 分隔用虚线而不是实线：实线是「另一张卡片」的语言，
                      *   虚线是「同一篇里的下一段」。
                      */}
                    {bookEntries.items.length > 0 && (
                      <article className="npr-diary-entry npr-diary-longform">
                        {bookEntries.items.map((entry) => {
                          const html = renderBody(entry.body);
                          const key = entryKey(entry);
                          const entryMood = firstMood(entry.mood);
                          return (
                            <section className="npr-diary-part" key={`${entry.date}-${key}`}>
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
                            </section>
                          );
                        })}
                      </article>
                    )}
                  </>
                )}

                {/*
                  * ★ 这条页脚只属于「灵感 / 私密」这两个各自的模块，**不能进读后感**：
                  *   用户 2026-10-27 的截图里，读后感模块底部挂着「日记共 4 天 · 存在 /Users/…」
                  *   —— 他在看一本书的读后感，却被报了日记的天数与磁盘路径。
                  * ★ 2026-10-27 第二次反馈：进了灵感模块，它又印「日记共 4 天（私密 1 天）」。
                  *   同一个 `<p>` 覆盖三个模块就必然在其中两个里是错的，所以现在是
                  *   「哪个模块报哪个模块的数」（见 `footDays` / `footBytes` / `footWhere`）。
                  * ★ 一份都还没有时不印：「灵感共 0 天 · 0 KB」只是噪音。
                  */}
                {stats && moduleValue !== 'reflection' && footDays > 0 && (
                  <p className="npr-diary-foot">
                    {footPrivate ? '私密' : '灵感'}共 {footDays} 天 · {(footBytes / 1024).toFixed(0)} KB · 存在 {footWhere}
                    {footPrivate && gate.unlocked && (
                      <button type="button" className="npr-diary-linkish" onClick={() => void exportWithPrivate()}>
                        {exportArmed ? '再点一次：明文会写进下载目录' : '导出私密明文'}
                      </button>
                    )}
                  </p>
                )}
                </div>
              </div>
            </div>

            {/*
              * 读后感工作台的划线侧栏：这一整块只在这个模块出现。
              * ★ 用户 2026-10-28：「划线侧边栏应该可以收缩起来，写读后感的区域自适应」。
              *   收起之后**留一条 34px 的窄轨**，而不是整块消失 —— 理由见
              *   `marksPanelOpen` 上面那段：这一页没有第二个「打开划线」的入口。
              *   「写读后感区域自适应」不用另算宽度：正文列是 `flex: 1`，
              *   划线栏一让位，它就自己把让出来的 266px 全吃掉。
              * ★ 收起态**不渲染**列表，而不是用 CSS 藏起来：几百条划线留在 DOM 里
              *   看不见却还在，拖拽事件、`Range` 量测、读屏软件都还会摸到它。
              */}
            {moduleValue === 'reflection' && book && (
              <aside className={`npr-diary-marks${marksPanelOpen ? '' : ' is-collapsed'}`}
                aria-label={marksPanelOpen ? '这本书的划线' : '划线（已收起）'}>
                {marksPanelOpen ? (
                  <>
                    <header className="npr-diary-marks-head">
                      <strong>划线</strong>
                      <span>{annotations.items.length} 条</span>
                      {/* 箭头朝右 = 往右让位；与收起态那个朝左的箭头互为镜像。 */}
                      <button type="button" className="npr-diary-marks-toggle"
                        title="收起划线，让写读后感的地方更宽" aria-label="收起划线面板"
                        aria-expanded="true" onClick={() => setMarksPanel(false)}>
                        <Icon name="chevron-right" size={14} />
                      </button>
                    </header>
                    {annotations.busy && <div className="npr-empty">正在读划线…</div>}
                    {!annotations.busy && annotations.error !== '' && (
                      <div className="npr-empty"><p>划线取不到：{annotations.error}</p></div>
                    )}
                    {!annotations.busy && annotations.error === '' && annotations.items.length === 0 && (
                      <div className="npr-empty"><p>这本书还没有划线。</p><p>在书里选中一段就能划线。</p></div>
                    )}
                    {annotations.items.map((item) => (
                      <div className="npr-diary-mark" key={item.id ?? `${item.page}-${item.start}`}
                        /*
                         * ★ 整张卡可拖：用户 2026-10-28 要的是「边看划线边写」——
                         *   拖拽比「先找光标再点引用」少两个动作。
                         * ★ `text/plain` 里放的就是插入正文的那段 markdown（与「引用」
                         *   按钮同一份，见 `quoteSnippet`），所以拖到别处（例如聊天框）
                         *   也仍然是一段可读的引用，而不是一串 JSON。
                         */
                        draggable
                        onDragStart={(event) => {
                          const snippet = quoteSnippet(item);
                          event.dataTransfer.setData('text/plain', snippet);
                          event.dataTransfer.effectAllowed = 'copy';
                        }}
                        title="拖进右边的编辑框，或点「引用」插到光标处">
                        <p className="npr-diary-mark-quote">{item.quote}</p>
                        {item.note && <p className="npr-diary-mark-note">{item.note}</p>}
                        <div className="npr-diary-mark-foot">
                          <span>{Number.isInteger(item.page) ? `第 ${item.page} 页` : ''}</span>
                          <button type="button" className="npr-diary-action" disabled={!book.readable}
                            title="插到正文的光标处（Markdown 引用块）"
                            onClick={() => quoteAnnotation(item)}>引用</button>
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  /*
                   * 窄轨。**计数留在轨上**：收起之后还要能看出「这本书到底有没有划线」
                   * —— 一条都没有的话，用户没必要为它展开一次。
                   * 整条轨就是一个按钮（而不是「图标可点、空白不可点」）：
                   * 34px 宽的靶子本来就小，再切一半就更容易点空。
                   * ★ 文案用 `划线·12` 而不是 `划线 12`：空格在竖排 + `text-orientation:
                   *   upright` 下会占掉整整一个「字」的高度，于是「线」和「1」之间空出
                   *   一格半，看着像漏了一个字。间隔点只占半个字，读起来是
                   *   「划线 · 12」一条完整的标签。
                   */
                  <button type="button" className="npr-diary-marks-rail"
                    title={`展开划线面板（${annotations.items.length} 条）`}
                    aria-label="展开划线面板" aria-expanded="false"
                    onClick={() => setMarksPanel(true)}>
                    <Icon name="chevron-left" size={14} />
                    <span className="npr-diary-marks-rail-label">划线·{annotations.items.length}</span>
                  </button>
                )}
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
      {/*
        * 「出处」浮层（0.46 起，0.47 换成「封面 + 摘要」的卡片）。挂在
        * `.npr-diary-workarea` 上、`position: fixed`，坐标在打开那一下算好（见 `openOrigin`）。
        * ★ 不是模态窗：它只说三件事（何时 / 出处 / 去现场），盖住整页就太重了 ——
        *   用户点开只是想确认「这条是我在哪篇里写的」。所以只有一层很淡的遮罩，
        *   点外面 / Esc / 滚动都关掉。
        */}
      {originPop && (
        <>
          <div className="npr-diary-pop-backdrop" onClick={() => setOriginPop(null)} />
          <div className={`npr-diary-pop is-${originPop.kind}`} role="dialog"
            aria-label={originPop.kind === 'book' ? '这条灵感记在哪本书里' : '这条灵感记在哪篇文章下'}
            style={{ left: originPop.left, top: originPop.top }}>
            {/*
              * 封面 + 标题 + 元信息（0.47）。
              * ★ 用户 2026-10-29：「文章的封面，文章的核心信息简介，什么时间在这篇文章下
              *   创建，跳转到该文章等等内容」。三样都在这儿：封面（书取书架那一份，
              *   文章取 `entry.image`）、标题两行、下面那段摘要。
              * ★ 没有封面图**不留空框**：用同一套生成封面（首字 + 书名哈希的色相），
              *   与书架上「没有封面的书」长得一样 —— 它们本来都是「只有名字的来源」。
              */}
            <div className="npr-diary-pop-top">
              <span className="npr-diary-pop-cover" aria-hidden="true">
                {originPop.kind === 'book'
                  ? (originBook !== null
                    ? <BookCover book={originBook} />
                    : (
                      <span className="npr-diary-pop-tile"
                        style={{ '--npr-cover-h': String(coverHue(originPop.title)) }}>
                        {coverGlyph(originPop.title)}
                      </span>
                    ))
                  : (originEntry?.image
                    ? <img className="npr-diary-pop-img" src={originEntry.image} alt="" />
                    : (
                      <span className="npr-diary-pop-tile"
                        style={{ '--npr-cover-h': String(coverHue(originCardTitle)) }}>
                        {coverGlyph(originCardTitle)}
                      </span>
                    ))}
              </span>
              <span className="npr-diary-pop-text">
                <span className="npr-diary-pop-title" title={originCardTitle}>{originCardTitle}</span>
                {originCardMeta !== '' && <span className="npr-diary-pop-meta">{originCardMeta}</span>}
                <span className="npr-diary-pop-when">
                  <Icon name="clock" size={11} />
                  {/* 完整年月日 + 时刻：这里问的就是「什么时候记的」，
                      `stampLabel` 的今天/昨天缩写在这个问题下反而含糊。 */}
                  记于 {originPop.date} {originPop.time}
                </span>
              </span>
            </div>
            {originPop.kind === 'article' && originMeta.busy && (
              <p className="npr-diary-pop-note">正在读这篇文章的信息…</p>
            )}
            {originCardSummary !== '' && (
              <p className="npr-diary-pop-summary">{originCardSummary}</p>
            )}
            {originPop.kind === 'article' && !originMeta.busy && originEntry === null && (
              <p className="npr-diary-pop-note">{originMeta.error !== ''
                ? `这篇文章的信息没读出来：${originMeta.error}`
                : '这篇文章已经不在订阅里了，只能看这条灵感的出处。'}</p>
            )}
            <div className="npr-diary-pop-foot">
              {canOriginJump ? (
                <button type="button" className="npr-diary-pop-jump" onClick={() => jumpOrigin(originPop)}>
                  {originJumpLabel(originPop)} ›
                </button>
              ) : (
                <p className="npr-diary-pop-note">{originMissNote(originPop, originMissReason)}</p>
              )}
              {/*
                * 聚合视图的**唯一**入口（0.47）。侧栏不设「按书本 / 按文章」——
                * 那三档是同一份数据的三种排法，把它们做成并列的选项卡，用户
                * 就得先学会「我现在在哪一档」。这里点一下，时间轴原地收窄，
                * 顶上出现一条可关的横条：入口与出口都在**你正站的地方**。
                */}
              {originScopeId !== '' && (
                <button type="button" className="npr-diary-pop-more" onClick={openOriginScope}>
                  {originPop.kind === 'book' ? '这本书的全部灵感' : '这篇文章的全部灵感'} ›
                </button>
              )}
            </div>
          </div>
        </>
      )}

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
            /* ★ 面板打开时导航栏**还在**（用户 2026-10-27：「为什么打开 AI 整理左侧边栏
               就关闭了呢」），所以「正文至少留多宽」得先把侧栏占的那 268px 扣掉。
               不扣的话拖到底会让面板吃掉导航的位置，正文被压成一条缝 —— 上一版正是靠
               **藏起导航**绕开这件事，而那只是把「正文太窄」换成了「导航没了」。
               量真实宽度而不是读常量：侧栏本身可以拖。 */
            const nav = vertical ? 0 : (area.querySelector('.npr-diary-nav')?.getBoundingClientRect().width ?? 0);
            const room = Math.max(0, total - nav);
            /*
             * ★ 「正文区（正文列 + 划线栏）至少留多宽」= 480，与 refinements.css 里
             *   `.npr-diary-companion` 的 `calc(100% - var(--npr-list-width) - 480px)`
             *   **同一个数**。0.44.0 这里是 340，而 0.44.1 给正文列加了 320px 下限后，
             *   340 − 320 只剩 20px 给划线栏 —— 两个数必须一起改。
             * ★ `panelFloor` 是面板自己的下限，与上面那个保留量是两件事，只是 0.44.0
             *   之前共用了一个变量（`minimum`），看起来像同一个数其实是两个意思。
             */
            const READER_FLOOR = 480;
            const panelFloor = Math.min(320, room * 0.42);
            const amount = Math.max(panelFloor, Math.min(span, room - READER_FLOOR));
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
