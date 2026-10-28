/**
 * 书架：左侧书单 + 右侧原版式阅读器。
 *
 * 侧栏分两页（用户 2026-10-08 定的模型，和订阅那半边的「目录 / 订阅」逐条对应）：
 *   - **书架**：网盘上的**全部**书（2634 本），按分类 / 书名 / 丛书筛；
 *   - **阅读**：只有用户自己挑过的书 —— 在书架里点书名右边的「阅读」把书加进来，
 *     这个动作就等于订阅（用户原话：「就类似于 RSS 的订阅」）。加进来之后，
 *     在读 / 读完 / 弃读 这几个状态才有意义，所以状态筛只在阅读页出现
 *     （「未读」不再单独成格：它和「在读」是同一条进度轴上的两格）。
 * 两个页面共用一条搜索框：它们是**同一批书**的两种视图，换页时把搜索词清掉只会
 * 让人以为「搜索坏了」。**来源/分类与排序下拉只在书架页**：阅读页里那两项几乎必然
 * 筛出 0 本（`scopes` 是整库的 8 个分类），而且列表只有两三行时排序没有用武之地
 * —— 控件一旦不显示，它对应的 state 也就**不许再参与筛选**（见 `visible`）。
 *
 * 结构与订阅那半边**逐块对应**（`.npr-workarea > .npr-layout > aside.npr-sidebar
 * + .npr-resize + section.npr-reader`），这样两边共用同一套布局 CSS，也共用同一套
 * 窗口拖动区 —— 桌面端面板的拖动是 `-webkit-app-region`，多造一层结构就多一次
 * 「拖动区被祖先的 no-drag 做差减掉」的机会（这个坑本项目踩过，见 ReaderPage 顶部注释）。
 *
 * ★ 书单的搜索/排序/筛选一律走 `src/library.js` 里那份**共用判据**，不在这里另写一遍：
 *   宿主返回的是全量书单，两处各写一套匹配规则时，界面上的结果和「点进去看到的书」
 *   会对不上，而且看不出是谁错了。
 * ★ 一行书的**徽章文字 / 按钮文字 / 能不能点开**也走共用判据（`bookRowView`）——
 *   理由同上，而且那张真值表在 `test/library.test.mjs` 里是**真跑**着测的。
 */
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  READING_STATE_FILTERS, addedBooks, applyStatePatch, bookRowView, bookScopes, countSources, filterBooks, formatBytes,
  isEbookExtension, libraryStats, normalizeState, parseScope, scopeValue, sourceLabelOf, sourceTotals, stateOf,
} from '../library.js';
import { Icon } from './icons.jsx';
import { BookReader } from './BookReader.jsx';
import { BookEbook } from './BookEbook.jsx';
import { SettingsPage } from './SettingsPage.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import { fetchBooks, fetchStates, reloadLibrary, saveBookState } from './library-api.js';
import { createPageProgress } from './page-progress.js';
import { SHELF_BATCH, shelfNextCount, shelfRenderCount } from './shelf-window.js';

/** 侧栏的两个分页，顺序即界面顺序：先看自己挑的书，再回书架挑。 */
const TABS = [['reading', '阅读'], ['shelf', '书架']];

/**
 * 书架页的筛选条。
 *
 * ★ 书架是**全部书**（2634 本），所以在这一页唯一有意义的筛法是「我加进来的那几本」。
 *   以前这一页没有筛选项，只有状态行报一句「已在阅读 2」—— **有数字、没入口**，
 *   用户看得见数不着，想再找那本书只能去 2634 本里翻。
 *
 * ★ 它和阅读页的状态筛是**两个维度**：这里筛的是 `added`（在不在阅读列表），
 *   阅读页筛的是 `state`（读得怎么样）。两页的 chip 条内容不同是刻意的，
 *   共用一条会把「在不在列表」与「读到哪儿」混成一个概念。
 *
 * ★ 阅读页那一组在 `src/library.js` 的 `READING_STATE_FILTERS` —— 界面与判据
 *   **共用同一份**，因为「在读」= 未开始 + 在读 这种分组写两遍必然漂移。
 */
const SHELF_FILTERS = [['', '全部'], ['added', '已加入阅读']];

const SORTS = [
  ['title', '按书名'],
  ['recent', '最近在读'],
  ['state', '按状态'],
  ['year', '按年份'],
  ['size', '按体积'],
];

/**
 * 阅读页的**固定**顺序（这一页没有排序下拉 —— 2026-10-09 用户定）。
 *
 * ★ 为什么不能「不显示控件、却继续按 `sort` 状态排」：那个 `sort` 是**两页共用**的
 *   一份 state —— 用户在书架页把它调成「按体积」，阅读页的列表就会莫名其妙跟着变，
 *   而阅读页**没有任何地方能看出这是排序造成的**，也**没有任何控件能改回来**。
 *   这与 0.9.0 修掉的「分类下拉只在书架页、却还在筛阅读页」是同一个缺陷类。
 * ★ 固定成「最近在读」：这一页的用途就是**接着读**，最近碰过的排最前。
 * ★ 取值必须是 `SORTS` 里真实存在的键 —— 写错时 `filterBooks` 会**静默**退回按书名
 *   （见它末尾的 `??` 兜底），界面上看不出任何异常，所以
 *   `test/library-app.test.mjs` 专门钉了这条。
 */
const READING_SORT = 'recent';

/** 翻页后多久落盘。太短会把每次翻页变成一次写盘，太长会丢掉「关掉就走」的那一次。 */
const SAVE_DEBOUNCE_MS = 1_200;

/**
 * 状态 → 徽章类名。
 *
 * ★ 刻意**不用** `npr-badge-${state}` 这种拼接：`scripts/check-classes.mjs` 是从
 *   字符串/模板字面量里收类名的，拼接出来的名字它只看到 `npr-badge-` 这个前缀，
 *   于是 CSS 里那四个 `.npr-badge-*` 全被判成「定义了但没人用」而报错。
 *   写成显式映射后，四个名字都真的出现在字面量里，交叉比对才有意义。
 */
const BADGE_CLASS = {
  unread: 'npr-badge-unread',
  reading: 'npr-badge-reading',
  read: 'npr-badge-read',
  dropped: 'npr-badge-dropped',
};

/**
 * 来源种类 → 徽章类名。
 *
 * ★ 同样写显式映射而不是拼接（理由与 `BADGE_CLASS` 一模一样：`check-classes.mjs`
 *   只从字面量收类名）。
 * ★ 三种而不是四种：`external` / `legacy` 在界面上都是「不是我自己配的那个目录」，
 *   用同一档颜色（`is-other`）够了 —— 它们各自的名字照样写在徽章文字里
 *   （「外部 · 外部书单」），分辨靠文字不靠颜色。多一档颜色只会让人以为那是第四种
 *   取字节方式，而实际只有两种（网盘 `fs_id` / 本地路径）。
 * ★ `is-local` 用强调色、`is-pan` 用中性底：本地目录是**用户自己机器上**的，
 *   扫一眼就能认出「这本不用联网」；网盘那一路是常态，不该天天喊。
 */
const SOURCE_CLASS = {
  local: 'is-local',
  pan: 'is-pan',
  external: 'is-other',
  legacy: 'is-other',
  other: 'is-other',
};

/**
 * 书架的一行（P1-5）。
 *
 * ★ 单独抽出来并包 `memo`，不是为了「整洁」：书架在真机上是 **2634 本**，
 *   而父组件每次输入（搜索框逐字）都会重建全部行。`memo` 之后，只有真正变了
 *   的那几行（选中态、加入态）才重渲染，其余只是被 diff 一下元素描述。
 *
 * ★ 两个前提，缺一个 `memo` 就是白写（两条都写在这里，因为改动它太容易了）：
 *   1. **传进来的必须是原始值**。`stateOf()` 每次都 `normalizeState()` 出一个
 *      **新对象**（见 `src/library.js`），把它当 prop 传下去，浅比较永远不等
 *      ⇒ 每行每次都会重渲染，`memo` 一点用没有。所以这里收的是
 *      `added` / `stateName` / `page` / `pages` 四个原始值。
 *   2. **回调的引用必须稳定**。`memo` 比的是 `Object.is`，父组件里一个内联箭头
 *      就能让所有行恒等于「props 变了」。所以四个回调全走 `useCallback` + ref
 *      （见 `openBook` / `restartBook` / `toggleAdded` / `dropBook`）。
 *
 * ★ 行本身仍然是一个 `div`、里面两个 `button`：`<button>` 里放 `<button>` 是非法
 *   HTML，浏览器会把它拆开，而且**各版本拆法不同**。
 *
 * ★ 徽章文字 / 按钮文字 / 能不能点开**都不在这里判断**，走 `bookRowView`（共用判据）：
 *   那张真值表在 `test/library.test.mjs` 里是**真跑**着测的；写在这里就只能靠源码
 *   字符串断言，而字符串断言答不了「这条分支跑不跑得到」。
 */
export const BookRow = memo(function BookRow({
  book, added, stateName, page, pages, scanned, selected, onReadingPage, onOpen, onToggle, onDrop, onRestart,
  /**
   * 「写完读后感」的去处（0.44.3）：**只有「读完」那一行**会把它画成按钮。
   * ★ `canReflect` 是布尔原始值、`onReflect` 必须来自 `useCallback`（同下面四个
   *   回调的理由）：`memo` 的浅比较经不起每次渲染新建的函数。
   * ★ 默认 `canReflect = false`：别的渲染装置（以及单测里直接调函数体的用例）
   *   没有这个去处，默认不给就等于默认不画一颗点了没反应的按钮。
   */
  canReflect = false, onReflect = null,
  /**
   * 来源徽章的三件属性（0.20.4）。
   * ★ 默认值**必须**是空串而不是 `undefined`：显隐判据是 `sourceLabel !== ''`，
   *   漏传时 `undefined !== ''` 为真 ⇒ 每一行都会多出一个**空胶囊**（有底色、没有字），
   *   而那看起来像「样式坏了」。调用方不传这个 prop 是合法用法（别的渲染装置、
   *   以及 `library-bookrow-render.test.mjs` 里直接调函数体的那些用例）。
   */
  sourceLabel = '', sourceKind = '', sourceTip = '',
}) {
  const view = bookRowView(book, { added, state: stateName, page, pages }, { onReadingPage, canReflect });

  /**
   * 每个动作点下去做什么。`kind` 由 `bookRowView` 给，这里只做「名字 → 回调」的翻译
   * —— 于是「按钮上写什么」与「点下去做什么」不可能对不上（写反了测试会红）。
   * ★ 0.9.4 起一行可以挂**两个**按钮（弃读 = 「+ 阅读」+「移出」），所以这是一张
   *   **表**，而不是「一次查表」。
   */
  const runners = {
    add: () => onToggle(book.id, true),
    remove: () => onToggle(book.id, false),
    drop: () => onDrop(book.id),
    restart: () => onRestart(book.id),
    // 写读后感要把**整本书**递出去（日记那边要 id / 书名 / 后缀三样），
    // 所以只有这一项不是「传 id」。
    reflect: () => onReflect?.(book),
  };

  /**
   * 行本身的类名。
   * ★ `inert` = 这一行**不可点开**（书架页整页都是；阅读页只有「读完」「弃读」两格）
   *   —— 它同时负责光标与「去掉 hover 高亮」，因为「看着能点、点了没反应」正是本项目
   *   最怕的形态。
   * ★ `dim` 只给「同一页里有的能点、有的不能点」那些格子（阅读页的「读完」「弃读」）：
   *   书架页整页都不可点，把 2634 个标题全压暗只会像坏了。
   *   ⇒ 阅读页上 `dim` 与 `openable` **恒好相反**（由 `bookRowView` 给，测试钉住）：
   *     两格不可点的行必须都压暗，只压一格会让「压暗」变成随机的。
   */
  const rowClass = ['npr-bookrow'];
  if (selected) rowClass.push('npr-selected');
  if (!view.openable) rowClass.push('npr-bookrow-inert');
  if (view.dim) rowClass.push('npr-bookrow-dim');

  return (
    <div className={rowClass.join(' ')}>
      <button type="button"
        className={`npr-bookrow-main${book.renderable ? '' : ' npr-bookrow-plain'}`}
        aria-pressed={selected} disabled={!view.openable}
        title={view.openHint === '' ? undefined : view.openHint}
        onClick={() => onOpen(book.id)}>
        <span className="npr-bookrow-title">{book.title}</span>
        <span className="npr-bookrow-meta">
          {/* 来源徽章（0.20.4）。★ 显隐**由调用方决定**（`sourceLabel === ''` ⇒ 不渲染），
              判据是「书单里有没有一条以上来源」—— 只有一条源时每行挂同一个徽章
              就是纯噪声，那正是状态徽章不给「未读」显示的同一条理由。
              ★ 文案（`网盘 · E书拾取`）来自 `sourceLabelOf`，与下面那个下拉的
              `<optgroup>` 出自同一个函数 ⇒ 徽章写「网盘 · E书拾取」而下拉里写
              别的名字这种事不可能发生。
              ★ `title` 给**这本书自己的路径**（网盘 `panPath` / 本地 `localPath`）：
              用户要区分的是「哪个目录」，而书单名可能同名（两个都叫「电子书」的
              本地目录完全可能）。
              ★ 位置在**状态徽章之前**：出处是身份，进度是状态，先读身份。 */}
          {sourceLabel !== '' && (
            <span className={`npr-bookrow-source ${SOURCE_CLASS[sourceKind] ?? SOURCE_CLASS.other}`}
              title={sourceTip}>{sourceLabel}</span>
          )}
          {/* 状态徽章只在**已加入**时出现：书架里 2634 本全是「未读」，
              每人一个灰牌子等于没有信息，先把「这是我的书」标出来才有意义。 */}
          {view.badgeText !== '' && (
            <span className={`npr-bookrow-badge ${BADGE_CLASS[view.badgeState] ?? BADGE_CLASS.unread}`}>{view.badgeText}</span>
          )}
          <span>{book.ext.toUpperCase() || '文件'}</span>
          <span>{formatBytes(book.size)}</span>
          {book.year > 0 && <span>{book.year}</span>}
          {!book.renderable && <span className="npr-bookrow-warn">暂不支持阅读</span>}
          {/* ★「扫描版」是**实测结论**，不是元数据：抽取目录时发现整本没有文字层。
              必须与「暂不支持阅读」分开说 —— 那本读不了，这本**读得了**，只是没有
              目录与逐章解读。混成一句会让人以为这本书打不开。
              只有真的探过的书才有这个标记（探测要下载整本，不可能 2634 本都探）。 */}
          {scanned && (
            <span className="npr-bookrow-scan" title="抽取目录时发现整本都是图片、没有文字层：目录与逐章解读不可用，阅读本身不受影响">扫描版·无文字层</span>
          )}
          {/* ★ 不可点开的行必须**当场说明原因**：`disabled` 的主按钮读屏器会跳过，
              只把原因塞进 `title` 等于没人看得到 —— 那就是「看起来不能用，
              但不知道为什么」。★ 书架页整页不可点、且**不需要**逐行解释（一整页行为
              一致），所以那边 `openHint` 是空串，这里连空 span 都不渲染 ——
              否则元信息行末尾会多出一个 7px 的空档。 */}
          {view.openHint !== '' && <span>{view.openHint}</span>}
        </span>
        {book.series !== '' && <span className="npr-bookrow-series">{book.series}</span>}
      </button>
      {/* 动作位有**两种元素形态**，因为它们本来就是两种东西：
          ① 有动作（+ 阅读 / 弃读 / 重新阅读 / 移出）⇒ `button`，可以是**两个**
             （弃读那一行：`+ 阅读` + `移出`，顺序由 `bookRowView` 给）；
          ② 没动作（书架页的「已开始阅读」）⇒ `span` —— 用户原话说的是**状态**，
             而一个点了没反应的按钮就是「看起来像功能」。
          ★ 两种形态**恰好互斥**（`actions` 与 `statusLabel` 有一个为空），
            由 `bookRowView` 保证、`test/library.test.mjs` 遍历断言。
          文案与语义见 `bookRowView`（那里是唯一一份）。 */}
      {/* ★ 多个动作**竖着排**（0.44.4）。用户 2026-10-28 带图的原话是「写读后感和
          重新阅读能否垂直排列」—— 并排时两枚胶囊在 268px 的侧栏里要吃掉 150px，
          书名被压到 106px，最后一枚还贴着行尾。竖排后整列只占最宽那枚的宽度
          （「写读后感」约 76px），省下的一半全还给书名。
          ★ 单动作（`+ 阅读`）也照样包一层：容器本身没有外观，包着不会多出一个盒子，
          而少一条「一个不包、两个才包」的条件，就不用担心哪天变成三个时忘了改。 */}
      {view.statusLabel !== null ? (
        <span className="npr-bookrow-status" title={view.statusLabel.title}>{view.statusLabel.text}</span>
      ) : (
        <span className="npr-bookrow-acts">
          {view.actions.map((action) => (
            <button key={action.kind} type="button" className={`npr-bookrow-action${added ? ' is-on' : ''}`}
              aria-label={action.label} title={action.title} onClick={runners[action.kind]}>
              {action.text}
            </button>
          ))}
        </span>
      )}
    </div>
  );
});

/**
 * 书架 / 阅读页。
 *
 * ★ `onWriteReflection` 只是**转交**：「读完」那一行的「写读后感」要跳到日记那个 tab，
 *   而 tab 是 `ReaderPage` 的状态 —— 这里只把书原样往上递，不自己切视图
 *   （切走之后本组件就卸载了，自己调自己的出口没有意义）。
 * ★ 0.44.3 起入口**只在这里**（阅读页「读完」筛下面的那一行）。阅读器顶部的胶囊里
 *   那颗已经删掉：用户 2026-10-28 的原话是「头部菜单条不应该有『写读后感』按钮入口」，
 *   理由也成立 —— 写读后感是「这本书读完了」的后续动作，它属于那个名单，
 *   不属于「正在读的这本书」的工具条。
 */
export function LibraryApp({
  reading, onExit, notify, api, SessionProvider, renderSlot, onWriteReflection, onReadingContext,
  /** 外面要打开的一本书（日记页「挂在书上」点进来的）：bookId + page + at。 */
  intent, onIntentDone,
}) {
  const [books, setBooks] = useState([]);
  const [source, setSource] = useState(null);
  /** 电子书伴读里点「+」要打开设置页的快捷提示词；模式与 ReaderPage 的 settingsEntry 相同。 */
  const [settingsEntry, setSettingsEntry] = useState({ open: false, tab: 'prompts', addPrompt: false });
  const [states, setStates] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /**
   * 搜索词**两页各一份**。
   *
   * ★ 用户实测（2026-10-23）：在书架搜「《译文名著文库》」→ 点「+ 阅读」→ 切到阅读页，
   *   那 4 本**全被一个看不见来源的词筛掉了**，统计条写着「1 / 5 本」，
   *   他的原话是「之前添加的阅读书不显示了呢」。搜索框里那个词就在眼前，但没人会想到
   *   「我换了一页，上一页的搜索词还在筛这一页」。
   * ★ 这与分类 / 排序当年那两次是**同一类缺陷**（0.9.0 修分类、0.9.1 修排序）：
   *   控件看不见、列表却被一个隐藏条件筛着。但那两次的解法是「在阅读页干脆不生效」
   *   （因为那两个控件在阅读页根本不渲染）；搜索不一样 —— 输入框两页都在，
   *   所以正确解法是**各记各的**，而不是关掉。
   */
  const [shelfQuery, setShelfQuery] = useState('');
  const [readingQuery, setReadingQuery] = useState('');
  /** 侧栏分页：`reading`（我挑的书）/ `shelf`（全部书）。 */
  const [tab, setTab] = useState('reading');
  const [stateFilter, setStateFilter] = useState('');
  /** 书架页的筛选（`''` = 全部 / `'added'` = 只看已加入「阅读」的）。见 `SHELF_FILTERS`。 */
  const [shelfFilter, setShelfFilter] = useState('');
  const [sort, setSort] = useState('title');
  /**
   * 书架页的「来源 / 分类」筛选，存成一个**复合值**（`scopeValue` / `parseScope`）。
   *
   * ★ 为什么不是一个 `topDir`（0.20.2 及之前就是）：`topDir` 是**相对该源**的第一层
   *   子目录（见 `book-source.js` 的 `topDirOf`），所以「系列丛书全套」在网盘和本地
   *   是**两个不同的集合**。只存目录名时界面只能按目录筛 ⇒ 选了「系列丛书全套」
   *   会把网盘的 1419 本与本地的 2 本混在一起，而用户 2026-10-23 的原话正是
   *   「分不清楚哪个是本地目录下的电子书，哪个是百度网盘的电子书」。
   *   来源与目录必须**成对**存、**成对**判（判据在 `filterBooks`，不在界面里）。
   * ★ 空串 = 两者都不过滤，也就是下拉第一项「全部来源」。
   */
  const [scope, setScope] = useState('');
  const [selectedId, setSelectedId] = useState('');
  /**
   * 阅读器是不是正处在沉浸态。
   *
   * ★ 提到这一层是因为书架列（`.npr-sidebar`）是阅读器的**祖先兄弟**：只有这一层
   *   改得动它的显隐。用户对沉浸的要求是「左边两列都不显示，只显示阅读页」。
   * ★ 换书时组件用 `key={book.id}` 重挂，阅读器会把自己的沉浸态复位成 `false`，
   *   并通过同一个回调把这里也同步回 `false` —— 所以不需要额外清理。
   */
  const [immersive, setImmersive] = useState(false);
  /**
   * 书架一次挂多少行（2026-10-25）。
   *
   * ★ 真机 2634 本时原来是**一次全画**：两万多个 DOM 节点，首屏要等它们全部建好。
   *   现在先挂 `SHELF_BATCH` 行，滚到附近再追加。判据在 `shelf-window.js` 里（可真跑）。
   * ★ 为什么不做「只画可视区」的虚拟滚动：书架行的标题是两行截断、元信息会换行，
   *   **行高不固定**；用固定行高去算位置，误差会累积成「滚到底看到空白 / 位置自己跳」。
   *   分批挂载零高度假设，代价只是滚到底时 DOM 会涨到全量 —— 而那时用户确实在看它们。
   */
  const [shelfShown, setShelfShown] = useState(SHELF_BATCH);
  const [listWidth, setListWidth] = useState(() => {
    const saved = Number(globalThis.localStorage?.getItem('npr.libListWidth'));
    return Number.isFinite(saved) && saved >= 220 && saved <= 520 ? saved : 320;
  });
  const searchRef = useRef(null);
  /**
   * 最新状态的镜像。
   *
   * ★ 卸载时的补写是**同步**发生的，而那时组件不会重渲染，闭包里的 `states`
   *   可能还是翻页之前的旧值。走 ref 才能保证「这本书是不是已经被标记读完」
   *   按**当下**的判断来（判断错了会把用户显式标记的「读完」改回「在读」）。
   */
  const statesRef = useRef(states);
  useEffect(() => { statesRef.current = states; }, [states]);
  /** 同理：`notify` 的引用会变，而下面的落盘器只造一次。 */
  const notifyRef = useRef(notify);
  useEffect(() => { notifyRef.current = notify; }, [notify]);

  const load = useCallback(async (mode = 'initial') => {
    setLoading(true);
    setError('');
    try {
      const body = mode === 'reload' ? await reloadLibrary() : await fetchBooks();
      setBooks(body.books ?? []);
      setSource(body.source ?? null);
      setStates(await fetchStates());
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load('initial'); }, [load]);

  /**
   * 翻页进度落盘器（P1-4）。
   *
   * ★ 逻辑本体在 `./page-progress.js`，不在这里。原因只有一个：它有一半是
   *   **卸载路径**，而卸载路径留在组件里就只能靠字符串断言守 —— 字符串断言
   *   答不了「这段代码跑不跑得到」。抽出去之后
   *   `test/page-progress.test.mjs` 可以用假计时器把那条路真的走一遍。
   */
  const progress = useRef(null);
  progress.current ??= createPageProgress({
    delayMs: SAVE_DEBOUNCE_MS,
    save: ({ id, page, pages }) => {
      // 已经标记读完的书不因为翻了一页就被改回「在读」—— 那是用户显式的判断。
      const current = stateOf(statesRef.current, id);
      const patch = { page, pages, ...(current.state === 'read' ? {} : { state: 'reading' }) };
      setStates((previous) => ({ ...previous, [id]: normalizeState({ ...stateOf(previous, id), ...patch, at: Date.now() }) }));
      return saveBookState(id, patch);
    },
    onError: (cause) => notifyRef.current?.(`阅读进度没能保存：${cause?.message ?? cause}`),
  });

  /**
   * 离开书架（切回订阅 / 关掉面板）时把**还没落盘的那次进度立刻写完**。
   *
   * ★ 以前这里只有一句 `clearTimeout(saveTimer.current)`，而上面的注释写的是
   *   「写完」—— **代码与注释相反**：定时器被清掉 ⇒ 那一次永远不写。症状是
   *   「翻页后 1.2 秒内切回订阅页 / 关掉面板，最后那一页的进度丢了」，
   *   而用户以为进度是自动存的（既没有提示，也没有报错）。
   *
   * ★ 这个 effect 必须**只挂载一次**（`[]`），一切会变的东西都走 ref：
   *   若把 `flush` 的依赖放进来，而某个依赖每次渲染都换引用，cleanup 就会
   *   每渲染一次执行一次 —— 于是每次翻页都立刻写盘，去抖等于没有。
   */
  useEffect(() => () => { progress.current?.flush(); }, []);

  const persist = useCallback(async (id, patch) => {
    // 先乐观更新本地，再落盘：等往返会让「读完」按钮按下去半天没反应。
    // ★ 用 `applyStatePatch`（与宿主写盘同一份）：这里自己拼 `{ ...state, ...patch }`
    //   会把「曾经读完过」这一刻丢掉 —— 标记读完紧接着点重新阅读时，读后感那一栏
    //   会当场少一本书，刷新后又回来。
    setStates((previous) => ({
      ...previous,
      [id]: applyStatePatch(stateOf(previous, id), patch),
    }));
    try {
      await saveBookState(id, patch);
    } catch (cause) {
      notify?.(`阅读进度没能保存：${cause?.message ?? cause}`);
    }
  }, [notify]);

  /** `persist` 的稳定镜像：下面两个回调要传给 `memo` 过的行，引用必须恒定。 */
  const persistRef = useRef(persist);
  useEffect(() => { persistRef.current = persist; }, [persist]);

  /**
   * 「写读后感」的稳定镜像（0.44.3）。
   *
   * ★ 外面给进来的 `onWriteReflection` 是 `ReaderPage` 里的一个**普通函数**，
   *   每次渲染都是新身份。直接把它当 prop 传给 `BookRow`，2634 行的 `memo`
   *   就全废了（P1-5 那两条前提里的第 2 条）。所以这里包一层零依赖的 `useCallback`，
   *   内部走 ref 取最新实现 —— 与 `persistRef` 同一个写法。
   * ★ 没有这个去处时 `canReflect` 为假，`bookRowView` 根本不排那颗按钮，
   *   所以这里的 ref 允许是 `null`（`onReflect?.()` 兜住）。
   */
  const reflectRef = useRef(onWriteReflection);
  useEffect(() => { reflectRef.current = onWriteReflection; }, [onWriteReflection]);
  const canReflect = typeof onWriteReflection === 'function';
  const reflectBook = useCallback((book) => { reflectRef.current?.(book); }, []);

  const onPageChange = useCallback((page, pages) => {
    const id = selectedId;
    if (id === '') return;
    progress.current?.note({ id, page, pages });
  }, [selectedId]);

  /**
   * 打开一本书。**只有 `openable: true` 的行会调到它**（主按钮 `disabled` 时浏览器
   * 不派发 click），也就是「未开始 / 在读」那两格。
   *
   * ★ 状态走 `statesRef`、落盘走 `persistRef`，自己**零依赖** —— 因为它要传给
   *   `memo` 过的行，引用必须恒定。一个每次渲染都新建的内联箭头会让所有行
   *   恒等于「props 变了」，`memo` 就白做了（P1-5）。
   * ★ `read` **一个字节都不写**：从书架点开一本已读完的书只是看一眼，不该把
   *   「读完」悄悄变成「在读」。要真的再读一遍得走 `restartBook`（那是显式动作）。
   * ★ 0.9.4 删掉了原来的 `dropped → reading` 那一支：弃读那一行现在**不可点开**
   *   （用户原话「弃读下的电子书也不能点击阅读」），恢复只能走它右边那个「+ 阅读」
   *   按钮 ⇒ 那条分支**永远跑不到**。留着它就是给死代码发合格证，而且会让人以为
   *   「点行还能恢复」。
   */
  const openBook = useCallback((id) => {
    setSelectedId(id);
    const current = stateOf(statesRef.current, id);
    if (current.state === 'unread') void persistRef.current(id, { state: 'reading' });
  }, []);

  /**
   * 从日记「挂在书上」点进来时要打开的那本 + 那一页。
   *
   * ★ 位置走阅读器的 `initialPage`，**不写进 `states`**：翻到那页 ≠「我现在读到
   *   第几页了」，用户看完直接关掉，原来的进度该原样留着。
   * ★ 用 `at` 当一次性触发键：同一本书再点一次 `bookId` 不变，只比 `id` 的话
   *   effect 不跑 —— 点了没反应，还不报错。
   * ★ 用完就通知外层清掉：不清的话，下次从订阅页切回书架（本组件重新挂载）
   *   `intent` 还是旧的，会**无缘无故再跳一次**。
   */
  const [openAt, setOpenAt] = useState(null);
  useEffect(() => {
    if (!intent?.bookId) return;
    const page = Number.isInteger(intent.page) && intent.page > 0 ? intent.page : null;
    setOpenAt({ id: intent.bookId, page });
    openBook(intent.bookId);
    onIntentDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.at]);

  /**
   * 那本书**不在书架上**时（换过书源 / 文件被删）把人送回日记。
   *
   * ★ 没有这一步的表现是：切到书架、右侧停在欢迎页，一句话都没有 —— 用户刚点了一个
   *   书名，得到一页「随心所阅，无界书房」，只会以为功能坏了。
   * ★ 必须等 `loading` 结束再判：书单还在路上时 `books` 是空的，那时判断等于
   *   把每本书都当成「不在」。
   */
  useEffect(() => {
    if (!openAt || loading) return;
    if (books.some((item) => item.id === openAt.id)) return;
    setOpenAt(null);
    notify('这本书已经不在书架上了，已留在日记里');
    onExit?.('diary');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAt, loading, books]);

  /**
   * 「重新阅读」：把一本已读完的书**放回「在读」**并打开。
   *
   * ★ 与 `openBook` 分开、而不是给它加个开关：两者**故意不同** —— `openBook` 对
   *   `read` 什么都不写（点开只是看一眼），`restartBook` 是用户明确说「我要再读一遍」
   *   ⇒ 必须改状态。混成一个函数时两者迟早互相覆盖（本项目踩过「一个标志位兼任
   *   两件事」的坑，症状是一条分支恒不可达）。
   * ★ 进度**不清零**：只在状态上回到「在读」，`page` 原样保留 —— 用户没要求丢掉
   *   「读到哪儿」，而这种丢弃不可逆。打开后停在原来那一页。
   * ★ 零依赖的理由同 `openBook`。
   */
  const restartBook = useCallback((id) => {
    setSelectedId(id);
    void persistRef.current(id, { state: 'reading' });
  }, []);

  /**
   * 加入 / 移出「阅读」。
   *
   * ★ 刻意**不**顺带改 `state`：移出只是「这本书我不打算在这页盯着了」，读到第几页、
   *   读完了没有都还留着 —— 哪天再点「阅读」加回来，进度还在原地。把两个维度绑在一起
   *   （移出就重置成未读）会让「手滑移出」变成一次不可逆的进度丢失。
   * ★ 零依赖的理由同 `openBook`。
   */
  const toggleAdded = useCallback((id, next) => { void persistRef.current(id, { added: next }); }, []);

  /**
   * 标记「弃读」。
   *
   * ★ 这是 `dropped` 的**第一条写入路径** —— 0.8.9 之前它一条都没有，于是「弃读」
   *   那个筛选点进去永远是 0 本（详见 CHANGELOG 0.8.9 的根因表）。
   * ★ 只改 `state`、**不动 `added`**：书留在阅读页的「弃读」筛下面，随时能找回来。
   *   用户的原话是「一旦移出是回到了书架上，因为书籍很多就很难找到」。
   * ★ 恢复路径是点标题打开（`openBook` 里有 `dropped → reading`），不需要另加按钮。
   * ★ 零依赖的理由同 `openBook`：它要传给 `memo` 过的行。
   */
  const dropBook = useCallback((id) => { void persistRef.current(id, { state: 'dropped' }); }, []);

  /** 只有在「阅读」页里，状态筛才有意义。 */
  const onReadingTab = tab === 'reading';

  /**
   * 当前这一页的搜索词。两页各记各的（见上面 `shelfQuery` / `readingQuery` 的说明）：
   * 换页不会把上一页的搜索词带过来，也不会把它弄丢。
   */
  const query = onReadingTab ? readingQuery : shelfQuery;
  const setQuery = onReadingTab ? setReadingQuery : setShelfQuery;

  /**
   * 书架的筛选条件（P1-5）。
   *
   * ★ 先 `useMemo` 成**一个对象**再交给 `useDeferredValue`，这两步都不能省：
   *   `useDeferredValue` 比的是 `Object.is`，每次渲染现造一个 `{ ... }` 会让它
   *   永远认为「值变了」⇒ 永远在推迟 ⇒ 列表可能一直停在旧值上（也可能来回抖），
   *   而输入框看起来一切正常 —— 这是最难查的那种「看起来没坏」。
   *
   * ★ `tab` **刻意不进来**：换页是一次明确的动作，应该立刻生效。而且它不会和
   *   `stateFilter` / `shelfFilter` 同时变（两排 chip 各自只在一页出现），所以不存在
   *   「一个用新值、一个用旧值」的错配。
   */
  const filters = useMemo(
    () => ({ query, stateFilter, shelfFilter, sort, scope }),
    [query, stateFilter, shelfFilter, sort, scope],
  );
  /**
   * 真机 2634 本，过滤 + 排序是同步的：搜索框每敲一个字都要跑一遍 2634 次匹配，
   * 再重建 2634 个行元素 —— 输入会明显发涩。
   *
   * `useDeferredValue` 让**输入框的值**保持同步（敲字立刻回显），把「拿这个值去
   * 过滤列表」降成一次可被打断的低优先更新：React 会在用户停下来之后再用新值
   * 渲染列表。行组件上的 `memo`（`BookRow`）再把没变的行整个跳过。
   */
  const shown = useDeferredValue(filters);
  /** 列表正显示着**上一轮**筛选的结果。只差一帧，所以不往提示文案里塞东西 ——
   *  但「一条都没有」那个空状态必须区分：那时说「没有符合的书」是假话。 */
  const filtering = shown !== filters;

  /**
   * 阅读页的书 = 已加入「阅读」的那些。
   *
   * ★ 单独一个 memo 而不是每处现算：**统计条必须和列表来自同一批**
   *   （见 `addedBooks` 的说明），否则会出现「3 / 3 本」配两行，数字与列表对不上。
   * ★ 0.9.0 曾在这里并进「有进度、但不在当前书单里」的**孤儿条目**。0.9.1 撤掉了：
   *   那 5 行没有可读凭据（`fsId` / `localPath` 全空），**点开必然失败**，用户的原话是
   *   「根本就不能直接阅读。建议直接删除」—— 一行「看得见却读不了」的条目比看不见
   *   更糟：它把「书单没对上」这件事伪装成了一个可以点的条目。
   *   正确的解法是按 `pan_path` 把它们**认回**书单（实测 5/5 命中），那是另一轮的事。
   *   状态表里那 5 条记录**一个字都没动**（本插件不替用户删数据），只是不再显示。
   */
  const readingList = useMemo(() => addedBooks(books, states), [books, states]);

  const visible = useMemo(() => {
    const group = READING_STATE_FILTERS.find((item) => item.value === shown.stateFilter);
    /**
     * ★ 来源与分类、以及排序**都只在书架页生效**：阅读页不显示这两个下拉
     *   （2026-10-09 用户定），而 `scope` / `sort` 都是**两页共用的一份 state** ——
     *   若在阅读页也照它们筛 / 排，就会出现「下拉看不见、列表却被一个隐藏条件筛着
     *   或排着」，而且照样能筛出必然为空的结果。这是「控件的内容与它作用的集合
     *   不对应」那类缺陷换了个方向（0.9.0 只修了分类那一半，排序那一半是 0.9.1 补的）。
     * ★ `listId` 与 `dir` 一起交给 `filterBooks`（而不是像 0.9.x 那样在结果上再
     *   `filter()` 一遍）：两者必须**成对**判，理由见 `filterBooks` 里那段说明。
     * ★ 两支都**写成三目**（而不是 `onReadingTab ? {} : parseScope(...)` 一次解构）：
     *   `test/library-app.test.mjs` 的「隐藏控件」判据是按 `onReadingTab ? A : shown.X`
     *   这个**形态**去读的（它要能看出「阅读页那一支有没有用到隐藏控件的 state」）。
     *   换成对象解构后那条判据读不出来，会报「判据失效」—— 而失效的判据比没有更糟。
     */
    const listId = onReadingTab ? '' : parseScope(shown.scope).listId;
    const dir = onReadingTab ? '' : parseScope(shown.scope).dir;
    const order = onReadingTab ? READING_SORT : shown.sort;
    return filterBooks(onReadingTab ? readingList : books, {
      query: shown.query,
      inReading: onReadingTab || shown.shelfFilter === 'added',
      state: onReadingTab ? (group?.states ?? null) : null,
      states,
      sort: order,
      listId,
      dir,
    });
  }, [books, readingList, shown, onReadingTab, states]);

  /**
   * 书架列表**分批挂载**（2026-10-25）。
   *
   * ★ 筛选条件一变就回到第一批：不回到第一批的话，用户滚到第 2000 行再改搜索词，
   *   新结果集会被一次性全画出来 —— 也就是说「分批」在最该生效的时刻失效了，
   *   而且看不出异常（列表本身是对的，只是卡）。
   *   用 `filters`（`useMemo` 出来的那个对象）当依赖：它的身份只在
   *   `query / stateFilter / shelfFilter / sort / scope` 真的变化时才变。
   */
  useEffect(() => { setShelfShown(SHELF_BATCH); }, [filters]);

  const shelfCount = shelfRenderCount({ total: visible.length, shown: shelfShown });
  const growShelf = useCallback(() => {
    setShelfShown((previous) => shelfNextCount({ total: visible.length, shown: previous }));
  }, [visible.length]);

  /**
   * ★ 这里**故意没有**「滚到底自动追加」的观察器（2026-10-25 真机反馈后删掉的）。
   *
   * 第一版接了一个 `IntersectionObserver`：滚到接近底部就自动 +120，同时把按钮
   * 当「观察器不可用时的兜底」。真机表现是「滚到底**从来**没出现过『显示更多
   * （还有 N 本）』，只要往下滚就一直有书」。这不是分批没生效 —— 恰恰是它**生效得
   * 太彻底**：每滚近一次就自动补一批，按钮刚被推进视口，就立刻被新挂的行推到下面去，
   * 用户一次也看不见它。于是「分批」在界面上**完全不可见**：既看不出有分批、也不知道
   * 还剩多少，还没法停下 —— DOM 一路涨到全量，正好把分批省下的东西又还回去了。
   *
   * ⇒ 现在只有**一个**入口：列表底部的「显示更多（还有 N 本）」按钮。
   *   看得见、按得动、按一次加一批、加到顶按钮自己消失。
   */

  /**
   * 「来源 ▸ 分类」下拉的选项（结构见 `bookScopes`：按来源分组、组内按分类）。
   *
   * ★ 来源按本数倒序：2634 本的主库排第一 —— 它是用户绝大多数时候要的那一档。
   * ★ 只有一条来源时这个下拉**仍然显示**（只是组里只有一组）：它是「分类」那个
   *   下拉的替代品，砍掉就等于砍掉分类筛选。
   */
  const scopes = useMemo(() => bookScopes(books), [books]);
  /**
   * 有**几条来源** —— 决定行内要不要挂来源徽章。
   *
   * ★ 只有一条源时不挂：2634 行每行一个同样的徽章等于噪声，也正是 `bookRowView`
   *   不给「未读」显示徽章的同一个理由（先把「这是我的书」标出来才有意义，
   *   而「所有书都来自同一个地方」不构成信息）。
   */
  const sourceCount = useMemo(() => countSources(books), [books]);
  /** 下拉的悬停说明：被截断时这是唯一能看到全称的地方。 */
  const scopeTitle = useMemo(() => {
    const parsed = parseScope(scope);
    if (parsed.listId === '') return '全部来源';
    const group = scopes.find((item) => item.id === parsed.listId);
    if (group === undefined) return '';
    return parsed.dir === '' ? group.label : `${group.label} / ${parsed.dir}`;
  }, [scope, scopes]);
  const shelfStats = useMemo(() => libraryStats(books, states), [books, states]);
  /**
   * 按书源分堆。放 `useMemo` 里不是为了省几个微秒 —— `books` 有 2600 多条，
   * 而欢迎页在「切换选中书 → 清空选中」时会重渲染，不缓存就每次白扫一遍。
   */
  const sourceStats = useMemo(() => sourceTotals(books), [books]);
  const readingStats = useMemo(() => libraryStats(readingList, states), [readingList, states]);
  const selected = books.find((book) => book.id === selectedId);

  /**
   * 当前这一章（`{ n, title } | null`）。**由阅读器上报**，本组件不自己算 ——
   * 目录只活在 `BookReader` / `BookEbook` 里，在这儿再算一份就是两份会漂开的实现。
   */
  const [chapter, setChapter] = useState(null);

  /**
   * 把「正在读哪本书、第几页、第几章」报给外层，最后落到灵感速记的 `meta`。
   *
   * ★ 传 `page` 而不只是 `bookId`：一条灵感挂到「第 5 章」和挂到「第 168 页」是
   *   两件事 —— 章节会随版本变，页码不会；两个都记下来，将来按书反查才有东西可对。
   * ★ `states` 在依赖里：翻页是去抖落盘的，进度一变这条就跟着重报，外层拿到的
   *   永远是「最后读到的位置」，不是打开这本书时的位置。
   */
  useEffect(() => {
    if (!selected) { onReadingContext?.(null); return; }
    const state = stateOf(states, selected.id);
    onReadingContext?.({
      bookId: selected.id,
      bookTitle: selected.title ?? '',
      page: Number.isInteger(state.page) ? state.page : 1,
      chapter,
    });
  }, [selected, states, chapter, onReadingContext]);

  /**
   * 离开书架（切去订阅 / 日记）时把上下文**清掉**。
   * ★ 不清的后果：在书里记了一条灵感，切回订阅读文章，再按 L —— 那条灵感会被挂到
   *   上一本书上，而界面上没有任何东西提示「你正在关联某本书」。
   */
  useEffect(() => () => onReadingContext?.(null), [onReadingContext]);

  const startDrag = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    let width = listWidth;
    const move = (moveEvent) => {
      width = Math.round(Math.min(Math.max(listWidth + moveEvent.clientX - startX, 220), 520));
      setListWidth(width);
    };
    const up = () => {
      globalThis.localStorage?.setItem('npr.libListWidth', String(width));
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  };

  const missing = source?.missing === true;
  /**
   * 两个页面各报各的数字。
   *
   * ★ 混用一个会立刻出现自相矛盾的界面：书架那 2634 本里「在读」永远是 5（用户那 5 本），
   *   于是书架页会显示「2634 本 · 在读 5」，而阅读页的列表里可能一本书都没有。所以
   *   书架页报「总数 + 已在阅读几本」，阅读页报「我加进来的几本 + 其中在读/读完几本」。
   */
  /**
   * ★ 「在读」的读数必须与「在读」那个筛选项**同一口径**（= 未开始 + 在读）。
   *   0.8.9 时这里报的是 `byState.reading`，而筛选项已经换成分组 —— 于是状态行
   *   会比筛出来的**少几本**。凡是「读数 + 入口」成对出现的地方，口径必须是同一份。
   * ★ 「弃读」只在非 0 时报：它是本轮才变活的状态，恒显示一个「弃读 0」只是噪声。
   */
  const readingInProgress = readingStats.byState.unread + readingStats.byState.reading;
  const listHint = loading ? '正在读书单…'
    : error !== '' ? error
      : onReadingTab
        ? `${visible.length} / ${readingStats.total} 本 · 在读 ${readingInProgress} · 读完 ${readingStats.byState.read}`
          + (readingStats.byState.dropped > 0 ? ` · 弃读 ${readingStats.byState.dropped}` : '')
        : `${visible.length} / ${shelfStats.total} 本 · 已在阅读 ${shelfStats.added}`;

  const emptyHint = books.length === 0
    ? '书单里没有可用的书。'
    : onReadingTab && readingList.length === 0
      ? '「阅读」还是空的。切到「书架」，点书名右边的「+ 阅读」把想读的书加进来；在这一页点书名就能取书阅读。'
      // ★ 延迟筛选期间「一条都没有」是**上一轮**的结果：这时说「没有符合当前筛选的书」
      //   是假话（新词还没用上）。差一帧也要说准，否则用户会以为搜索坏了。
      : filtering ? '正在筛选…' : '没有符合当前筛选的书。';

  return (
    /* ★ `is-book-immersive` 由阅读器回调打开：沉浸时书架这一列要整列收掉
       （用户 2026-10-23 第五轮：「左边两列都不显示，只显示阅读页」）。
       类必须挂在 `.npr-workarea` 上而不是 `.npr-layout` 里 —— CSS 要同时命中
       `.npr-sidebar` 与 `.npr-resize`，它们是 `.npr-layout` 的直接子级。 */
    <div className={`npr-workarea${immersive ? ' is-book-immersive' : ''}`}><div className="npr-layout" style={{ '--npr-list-width': `${listWidth}px` }}>
      <aside className="npr-sidebar">
        <div className="npr-sidebar-toolbar" data-window-drag>
          {/* ★ 0.30.0 起有三个视图：这里必须把**目标模式**转出去（`next !== 'library'`），
              不能再只判 `next === 'feeds'` —— 否则从书架点「日记」会被当成「什么都不做」，
              按钮点了没反应，而代码看起来完全正常。 */}
          <ViewSwitch mode="library" onChange={(next) => { if (next !== 'library') onExit?.(next); }} showLibrary />
          {/* ★ 搜索框 0.9.3 搬去了下面（见 `.npr-lib-controls`）：它和「全部分类 +
              按书名」是**同一个动作的三个参数**，挂在工具栏里反而紧挨着「重新读取
              书单」—— 那是**重新取数**，跟筛当前列表不是一回事。
              ★ 0.20.2 起 `npr-lib-refresh` **不再**吃 `margin-left: auto`：右端留给
              设置齿轮（订阅那半边同样把它挪进了工具栏）。理由见 PANEL_CSS 里
              `.npr-sidebar-toolbar .npr-settings-button` 那条说明。 */}
          <button type="button" className={`npr-icon npr-lib-refresh${loading ? ' is-loading' : ''}`} title="重新读取书单" aria-label="重新读取书单"
            onClick={() => void load('reload')}><Icon name="refresh-cw" /></button>
          {/* ★ 书架页原先**没有**设置入口：齿轮只长在订阅页的筛选行上，于是「我只用书架」
              的用户要配书源，得先切到订阅页才找得到那个按钮。
              落点与订阅页一致（工具栏最右端），打开时直接落在「电子书书架」那一页 ——
              从书架点设置的人要改的几乎必然是书源，让他再点一次左侧导航没有意义。 */}
          <button type="button" className="npr-icon npr-settings-button" title="插件设置" aria-label="插件设置"
            onClick={() => setSettingsEntry({ open: true, tab: 'library', addPrompt: false })}><Icon name="settings" /></button>
        </div>
        {/* 两个分页放在工具栏下面、筛选条上面：它是**换整页内容**的控件，
            和它下面那排「对当前列表做一个动作」的筛选按钮不是一回事（同 ViewSwitch
            的说明：视觉同级会被读成语义同级）。 */}
        <div className="npr-libtabs" role="group" aria-label="书架分页">
          {TABS.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>
          ))}
        </div>
        {/* 两页各有一条 chip 条，但筛的是**不同的维度**：阅读页筛 `state`
            （读得怎么样），书架页筛 `added`（在不在阅读列表）。以前书架页这一条
            是空的 —— 状态行报着「已在阅读 2」却没有入口，看得见数不着。 */}
        <div className="npr-filters" role="group" aria-label={onReadingTab ? '阅读状态' : '书架筛选'}>
          {onReadingTab
            ? READING_STATE_FILTERS.map(({ value, label }) => (
              <button key={value} type="button" aria-pressed={stateFilter === value}
                onClick={() => setStateFilter(value)}>{label}</button>
            ))
            : SHELF_FILTERS.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={shelfFilter === value}
                onClick={() => setShelfFilter(value)}>
                {value === 'added' ? `${label}（${shelfStats.added}）` : label}
              </button>
            ))}
        </div>
        {/* 搜索系统 + 结果行：**两行**，每行 =「一个可伸缩项 + 一个按内容定宽的下拉」
            （2026-10-09 用户给的设计稿；0.9.5 定两行、0.9.6 把两行**拆成互相独立**）。
            ★ 0.9.3 把搜索框从顶部工具栏搬到这里（用户原话：「顶部的输入搜索框建议
              移动到下面，与全部分类+按书名形成一个完整搜索系统」「我如果知道书的
              分类，就输入框输入书名的关键字，选择书的分类，然后搜索」）；0.9.5 再按
              用户的设计稿改成**两行**：`搜索框 │ 分类` / `结果行 │ 排序`。
              再上一版是**三行**（搜索框独占一行、分类+排序一行、结果一行），后两行右边
              都空着 —— 白占 35px 的书单高度。
            ★★ 0.9.6 为什么把「2×2 具名区域网格」换成**两个独立的 flex 行**：
              用户实测截图里 `2634 / 2634 本 · 已在阅读 3` **折成了两行**。
              根因是网格的**列是共享的**：右列要同时容下「分类」和「排序」，
              于是右列宽度 = 分类要的宽度。而分类的真实标签最长是
              「系列丛书全套（1419）」（实测 8 个分类里最长的那个，11px 字号下约 144px）
              —— 那几乎就是整列 146px。⇒ 只要两行共用列，**排序就不可能变窄**，
              结果行也拿不回那几十像素。所以两行必须各自独立定宽。
            ★ 现在每条行的结构是「可伸缩项 + 按内容定宽的下拉」：
                行 1 = 搜索框（`flex: 1 1 0`）│ 分类（`flex: 0 0 auto`）
                行 2 = 结果行（`flex: 1 1 0`）│ 排序（`flex: 0 0 auto`）
              ⇒ 排序缩到它自己内容那么宽（「最近在读」约 76px），结果行拿到剩下的
                全部（320px 侧栏下约 216px —— 真 Chrome 判据量着它必须单行）。
            ★ 两行独立**顺带**把 0.9.5 具名区域要解决的那个问题解决得更彻底：
              分类 / 排序在阅读页整块不渲染 —— 行是各自独立的 flex 容器，**根本不存在**
              「少一个元素、后面自动补位」这回事（网格的**自动摆放**才有那个风险，
              0.9.5 正是为此改用具名区域）。所以具名区域连同 `.is-single` 一起删掉了。
            ★ 四件仍是**一件事**：两个输入（词 / 类）+ 一个排序 + 它们的结果。
              块外 14px / 块内 6px 这个差是「它们是一套」唯一的视觉依据（真 Chrome 几何判据守着）。
            ★ 位置**两页一致**：阅读页没有分类 / 排序，两条行各自只剩一个可伸缩项，
              自然占满整行 —— 只在书架页做成两列的话，同一个输入框会在切页时**变宽变窄**。
            ★ 来源/分类与排序下拉**仍只在书架页**（2026-10-09 用户定：阅读页那个「最近在读」
              下拉也取消掉）。两条理由：
                ① 阅读页的列表只有两三本，而 `scopes` 是**整库**的分类（实测 8 项、计数
                   也是整库的）—— 选任何一项都几乎必然筛出 0 本；
                ② 一个控件不显示、它对应的 state 却还在生效，就是「控件看不见、列表
                   却被隐藏条件筛着 / 排着」。所以 `visible` 里阅读页那两项是**写死**的。
              两个 `label` 整块**不渲染**，而不是渲染空壳。
            ★ 结果行是这套控件的**输出**，不是另一件事。代价是它要交出自己原来独占一行
              时的内边距（`8px 12px`，定义在 ReaderPage 的 PANEL_CSS 里、阅读区也在用
              同一份），见 CSS。
            ★ DOM 顺序按「从上到下、从左到右」写（搜索框 → 分类 → 结果 → 排序）：
              两条行的读序与视觉顺序一致（`order` / `*-reverse` 会让两者分叉且不报错
              —— 本项目为它写过专门判据）。 */}
        <div className="npr-lib-controls">
          <div className="npr-lib-row">
            <input ref={searchRef} className="npr-lib-search" type="search"
              aria-label={onReadingTab ? '搜索阅读' : '搜索书架'}
              placeholder={onReadingTab ? '搜索我在读的书…' : '搜索书名 / 丛书…'}
              value={query} onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setQuery(''); } }} />
            {/* ★ 搜索词生效时**必须自己说出来**：统计条那句「1 / 5 本」在用户眼里
                只是一个数字，而「另外 4 本去哪了」没有任何地方回答。
                这颗 chip 同时是**清除入口** —— 找回来只需要点一下。 */}
            {query.trim() !== '' && (
              <button type="button" className="npr-lib-querychip"
                title="清除搜索，显示全部"
                onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
                <span>筛选：{query.trim()}</span><Icon name="x" size={11} />
              </button>
            )}
            {/* ★ 「来源」与「分类」**折叠成同一个下拉**（`<optgroup>` 分组），不是并列两个。
                两个理由：
                  ① 宽度：这一行是「搜索框（`flex: 1 1 0`）│ 下拉（按内容定宽）」，
                     320px 侧栏下再加一个控件，搜索框会被挤到 80px 上下 ——
                     而搜索框是这一页的主入口。
                  ② 语义：`topDir` 本来就是**相对该源**的第一层子目录，所以「分类」
                     离开「来源」根本不是一个确定的集合（见 `bookScopes` 的说明）。
                     分组恰好把这个关系画出来了。
                ★ `title` 是给截断用的：选项文字带上源名后可能超出行宽（CSS 里
                  `.npr-lib-dir select` 有 `max-width`），悬停才看得到全称。
                ★ 这条注释是 **JSX 注释**、且在条件外面：`test/library-app.test.mjs`
                  按 `!onReadingTab && (<label className="npr-lib-dir">` 这个形态判
                  「分类下拉只长在书架页」，中间夹一段普通注释会让它读不到（判据误报失效）。 */}
            {!onReadingTab && (
              <label className="npr-lib-dir"><span className="npr-visually-hidden">来源与分类</span>
                <select value={scope} title={scopeTitle} onChange={(event) => setScope(event.target.value)}>
                  <option value="">全部来源</option>
                  {scopes.map((group) => (
                    <optgroup key={group.id} label={`${group.label}（${group.total}）`}>
                      <option value={scopeValue(group.id)}>{group.label} · 全部（{group.total}）</option>
                      {group.dirs.map((folder) => (
                        <option key={folder.key} value={scopeValue(group.id, folder.key)}>
                          {group.label} · {folder.key}（{folder.count}）
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="npr-lib-row">
            <div className={`npr-status${error !== '' || missing ? ' is-error' : ''}`} role="status" aria-live="polite">{listHint}</div>
            {!onReadingTab && (
              <label className="npr-lib-sort"><span className="npr-visually-hidden">排序</span>
                <select value={sort} onChange={(event) => setSort(event.target.value)}>
                  {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
        {missing && (
          <div className="npr-notice" role="status">
            <Icon name="info" size={15} />
            <div className="npr-notice-body">
              <strong>没有找到书单文件</strong>
              <span>{source?.path}</span>
              <span>在插件设置的「电子书书架」里配好书源、点一下生成书单；或者把「当前读哪份书单」指到你已有的 books.json。</span>
            </div>
          </div>
        )}
        <div className="npr-list">
          {!loading && error === '' && visible.length === 0 && (
            <div className="npr-empty"><p>{emptyHint}</p></div>
          )}
          {/* ★ 传下去的是 `added` / `stateName` / `page` / `pages` 四个**原始值**，
              不是 `stateOf(...)` 那个每次都是新对象的状态 —— 后者会让 `memo` 的
              浅比较永远不等（P1-5）。四个回调必须来自 `useCallback`（引用恒定），
              理由同上。`onReadingPage` 决定「读完」那一行能不能点开（见 `bookRowView`）。 */}
          {visible.slice(0, shelfCount).map((book) => {
            const state = stateOf(states, book.id);
            /**
             * 来源徽章的三件属性**必须都是原始值**（字符串）。
             * ★ 不能把 `sourceLabelOf(book)` 返回的那个 `{ text, kind, name }` 对象
             *   直接当 prop 传：它每次渲染都是**新对象**，`memo` 的浅比较永远不等
             *   ⇒ 2634 行每敲一个字都全部重渲染（`BookRow` 顶部那两条前提里的第 1 条，
             *   0.9.x 在状态对象上踩过同一个坑）。
             * ★ `title` 拼「出处 + 这本书自己的路径」：书单名可能同名（两个都叫
             *   「电子书」的本地目录完全可能），真正能区分的只有路径。
             */
            const from = sourceCount > 1 ? sourceLabelOf(book) : null;
            const tip = from === null ? ''
              : [from.text, book.panPath || book.localPath].filter((item) => item !== '').join(' · ');
            return (
              <BookRow key={book.id} book={book} added={state.added} stateName={state.state}
                page={state.page} pages={state.pages} scanned={state.scanned} onReadingPage={onReadingTab}
                selected={book.id === selectedId}
                sourceLabel={from?.text ?? ''} sourceKind={from?.kind ?? ''} sourceTip={tip}
                canReflect={canReflect} onReflect={reflectBook}
                onOpen={openBook} onToggle={toggleAdded} onDrop={dropBook} onRestart={restartBook} />
            );
          })}
          {/* ★ 这个按钮是「第 121 本之后」**唯一**的入口，不是便利也不是兜底：
              自动加载已经删掉了（理由见上面那段注释），少了它就真的看不到后面的书。 */}
          {shelfCount < visible.length && (
            <button type="button" className="npr-more" onClick={growShelf}>
              显示更多（还有 {visible.length - shelfCount} 本）
            </button>
          )}
        </div>
      </aside>
      <div className="npr-resize" role="separator" aria-orientation="vertical" onPointerDown={startDrag}
        onDoubleClick={() => { setListWidth(320); globalThis.localStorage?.setItem('npr.libListWidth', '320'); }} />
      {/* `npr-reader-book` 是**布局必需**，不是装饰：`.npr-reader` 默认是普通块盒，
          而阅读器那半边的高度链要靠 `.npr-book{flex:1}` → `.npr-book-main{flex:1}` →
          舞台，块盒里这些 `flex` 全都是死代码，于是书页区的高度会变成**画布自己撑
          出来的高度**（自指），面板的真实高度一点没用上。后果有两个，都是肉眼可见的：
            ① 「适应窗口」永远算不出正确的可用高度 ⇒ 按钮点了没反应（实测 1047×1490
               的页面在 813 高的面板里，切模式后尺寸一模一样）；
            ② 面板下方空出一大块（实测书页区只占 473 / 734）。
          所以这一行类名删不得，`.npr-reader-book` 那条规则也删不得。 */}
      <section className="npr-reader npr-reader-book">
        {/* ★ 没选中书时也要有一条窗口拖动行（0.9.8）：BookReader 那条
            `.npr-book-toolbar` 只在**选中了书**时才存在，于是「书架页 + 一本都没点开」
            这个状态下，面板右侧整块（约 68% 宽）一个拖动区都没有 —— 在空白处按住
            鼠标，窗口纹丝不动（用户 2026-10-10 报的就是它）。侧栏那一条 44px 的工具栏
            远在另一头，帮不上忙。
            类名与高度跟 BookReader 那条**完全一致**（44px），所以选中 / 未选中两种
            状态下，面板顶部都是同一条线；drag 与祖先干净性由 test/window-drag.test.mjs
            统一守（同名 class 出现在两个文件里，那条守卫按文件指名道姓地查）。 */}
        {!selected && <div className="npr-book-toolbar" data-window-drag />}
        {selected ? (
          // `api` / `SessionProvider` / `renderSlot` 只是**转交**给阅读器里的 AI 伴读：
          // 伴读用的是 Harness 自己的对话，槽位设施在 `ReaderPage` 那一层才有。
          //
          // ★ 按格式分流到**两个组件**，不把电子书塞进 `BookReader` 里加个 if：
          //   PDF 那条链路是「位图 + 文字层 + 缩放 + 划线锚点」，重排那条是
          //   「块模型 + 字号 + 分节」，除了顶部的胶囊与右下角的浮动按钮，两者没有
          //   可复用的实现。塞进一个组件里会让 PDF 那边的 hook 顺序与电子书互相牵连
          //   （`BookReader` 在开始处就有大量 hook，任何提前 return 都在破坏规则），
          //   而分流之后两个组件各自的卸载重建由 `key` 保证。
          isEbookExtension(selected.ext) ? (
            <BookEbook key={selected.id} book={selected} states={states}
              initialPage={openAt?.id === selected.id ? openAt.page : null}
              notify={notify} onPageChange={onPageChange}
              onImmersiveChange={setImmersive}
              api={api} SessionProvider={SessionProvider} renderSlot={renderSlot}
              onManagePrompts={() => setSettingsEntry({ open: true, tab: 'prompts', addPrompt: false })}
              onChapter={setChapter}
              onFinished={() => void persist(selected.id, { state: 'read' })} />
          ) : (
            <BookReader key={selected.id} book={selected} reading={reading} states={states}
              initialPage={openAt?.id === selected.id ? openAt.page : null}
              notify={notify} onPageChange={onPageChange}
              onImmersiveChange={setImmersive}
              // 抽取目录时发现是扫描版 ⇒ 左栏那一行**当场**挂上标记，不等下次刷新。
              onScannedChange={(id, scanned) => setStates((previous) => ({
                ...previous,
                [id]: normalizeState({ ...stateOf(previous, id), scanned }),
              }))}
              api={api} SessionProvider={SessionProvider} renderSlot={renderSlot}
              onManagePrompts={() => setSettingsEntry({ open: true, tab: 'prompts', addPrompt: false })}
              onChapter={setChapter}
              onFinished={() => void persist(selected.id, { state: 'read' })} />          )
        ) : (
          <div className="npr-welcome">
            <div className="npr-welcome-brand">NPIE BOOKSHELF</div>
            {/*
              ★ 这里是**入口说明**，不是功能清单：一段只说一件事，三段讲完
                「两页各放什么 → 怎么开始读 → 打开后能干什么」。
                0.25.5 第一版把五件事（两页、书架是什么、+阅读、PDF 渲染、重排、断网）
                挤进一个自然段，用户的原话是「现在根本就看不懂」。
              ★ 不许出现 `pdf.js` / 重排 / 宿主 / 磁盘 这类内部词：读者不关心怎么实现，
                只关心「我点下去会发生什么」。
              ★ 标题是 slogan，不列数据源；列源的责任在第一段（本地目录 / 百度网盘 /
                外部书单）。守卫在 `test/library-app.test.mjs`（第一段缺「本地」即判红）。
            */}
            <h2>随心所阅，无界书房</h2>
            <p className="npr-welcome-intro">
              左边分两页：<strong>书架</strong>放全部的书（本地目录、百度网盘、外部书单里的都算），
              只看不读；<strong>阅读</strong>放你想读的。
            </p>
            <p className="npr-welcome-intro">
              想读哪本，到书架里点它右边的「<strong>+ 阅读</strong>」。加进来之后，
              在<span className="npr-keep">「阅读」页</span>点书名就打开了。
            </p>
            <p className="npr-welcome-intro">
              PDF 按原样显示；EPUB、MOBI、AZW3、TXT 会重新排版，能调字号、按目录跳、
              逐章生成解读。书存在本机的，断网也能读。
            </p>
            {/*
              ★ 这行先报**来源**（有几种源就几项，只有一种就只一项），再报**状态**。
                原来只有「书单 / 已在阅读 / 可阅读 / 总体积」四项，全是状态与总量 ——
                用户同时配了网盘和本地目录时，这行字里没有任何一处说得出「哪些书在哪儿」
                （用户 2026-10-25 的原话：「是不是根据用户添加的书源时时表达」）。
              ★ 「书单」「总体积」两项**撤掉**了：各源的本数之和就是书单总数、
                体积之和就是总体积，再列一遍等于让读者自己做加法，还把行撑到换行。
              ★ 「已在阅读」「可阅读」留着：它们与来源正交，换不出重复。
            */}
            <div className="npr-welcome-keys">
              {[
                ...sourceStats.map((source) => [source.label, `${source.total} 本 · ${formatBytes(source.bytes)}`]),
                ['已在阅读', `${shelfStats.added} 本`],
                ['可阅读', `${shelfStats.renderable} 本`],
              ].map(([key, label]) => (
                <span key={key}><kbd>{key}</kbd><span>{label}</span></span>
              ))}
            </div>
          </div>
        )}
      </section>
      {settingsEntry.open && <SettingsPage api={api} initialTab={settingsEntry.tab}
        startAddingPrompt={settingsEntry.addPrompt} notify={notify}
        onClose={() => setSettingsEntry({ open: false, tab: 'prompts', addPrompt: false })} />}
    </div></div>
  );
}
