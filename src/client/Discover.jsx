import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import blogCatalog from '../data/independent-blogs.json';
import catalogHealth from '../data/catalog-health.json';
import newsletterCatalog from '../data/newsletter-feeds.json';
import { catalogHealthOf, healthIndex, healthNotice } from './catalog-health.js';
import { catalogCategories, countCustom, mergeCatalog, provenanceOf } from './catalog-merge.js';
import { Icon } from './icons.jsx';

/**
 * AI 电子报（Newsletter）。**每一个地址都是逐条真实请求测过的**：HTTP 200、
 * 返回 XML、且至少有 1 个条目。所以这里没有「可能抓不到」的条目。
 *
 * ★ 2026-10-09 起这一类**也进体检**（`newsletter-feeds.json` 与独立博客共用一份
 *   `catalog-health.json`），所以每行同样会显示「最新一篇 N 天前」。
 *   收录时逐条测过 ≠ 一直新鲜：第一次体检就发现两条停在 2024 年，已按 365 天
 *   删除线裁掉。别凭「当初测过」就以为这层是多余的。
 *
 * ★ 其中几条的地址和官网长得不一样，别照官网猜：The Batch 在 `deeplearning.ai/the-batch/`
 *   下所有路径都是 404，真正的内容源在 `charonhub.deeplearning.ai/feed`；
 *   MIT 科技评论的 The Algorithm 专栏没有独立 feed，只有 AI 主题源；
 *   TLDR AI 在 API 路径 `tldr.tech/api/rss/ai`（官网那个 `tldr.tech/ai/rss` 是 404）；
 *   Daily Dose of DS 走自定义域 `blog.dailydoseofds.com/feed`（订阅页所在的
 *   `*.substack.com` 子域在本机被 DNS 污染 + TCP 阻断，别「顺手改回官网地址」）。
 *   同一份公众号清单里另外 6 个没有收录（3 个 Substack 源在本机网络下不可达、1 个被反爬拦、
 *   2 个平台没开 feed），另有 The Neuron 实测后摘除，原因都记在 `newsletter-feeds.json` 的 `unavailable` 里。
 */
const newsletters = newsletterCatalog.items.map((entry) => ({
  ...entry,
  category: 'Newsletter',
  note: entry.frequency,
}));

/**
 * 内置目录 = 只读默认值。用户可以隐藏，不能改。
 *
 * ★ 2026-10-08 起只剩两类。原先还有「精选作者 / 微信公众号 / 播客」，
 *   它们的**数据来源没法对用户交代清楚**（手写清单 / 个人 FreshRSS 代理 / 第三方 RSSHub），
 *   按用户要求整类撤掉。撤掉的那两份清单与原因记在仓库根的 `retired/README.md` 里，
 *   想恢复就照那里做 —— 别在这里凭记忆重抄一遍。
 */
const builtinCatalog = [
  ...newsletters,
  ...blogCatalog.items.map((entry) => ({ ...entry, category: '独立博客' })),
];
/**
 * 「全部主题」下拉的选项（纯函数，便于单测）。
 *
 * ★ 为什么不能直接 `[...new Set(tags)].sort()`
 * -----------------------------------------
 * 目录里 404 个独立博客自带 386 个不同标签，其中 289 个只有 1 个源在用
 * （`.NET`、`.net`、`C4droid`、`Galgame`、`Hermes`…）。直接丢进 `<select>` 再按字符码排序，
 * 用户看到的就是一屏「冷门技术栈」，而且 `.NET` / `.net` 还占两行 —— 2026-10-20 用户报障：
 * 「怎么会有这么多缓存内容」。它不是缓存，是目录标签的全集。
 *
 * 三条收敛规则：
 *   ① **只留至少 `minSources` 个源在用的标签** —— 长尾单个标签筛出来只有一行，没有筛选价值；
 *   ② **大小写/空白归一**（`.NET` 与 `.net` 合成一项）；
 *   ③ **按使用次数降序**，同频再按中文排序 —— 打开就先看到「编程 / 生活 / 技术 / 前端」。
 *
 * 还顺带**跟着当前分类走**：选 Newsletter 时不会列出一堆博客技术栈。
 *
 * @param {object[]} entries 当前可见的目录条目（已含隐藏过滤）。
 * @param {string} category 当前分类（`全部` = 不筛）。
 * @param {{ minSources?: number }} [options]
 * @returns {string[]} 可以直接渲染的标签文字，频次降序。
 */
export function topicOptions(entries, category = '全部', options = {}) {
  const minSources = options.minSources ?? 3;
  const counts = new Map();
  for (const entry of entries ?? []) {
    if (category && category !== '全部' && entry?.category !== category) continue;
    for (const raw of entry?.tags ?? []) {
      const label = String(raw ?? '').trim();
      const key = label.toLocaleLowerCase();
      if (!key) continue;
      const hit = counts.get(key);
      if (hit) hit.count += 1;
      else counts.set(key, { label, count: 1 });
    }
  }
  return [...counts.values()]
    .filter((item) => item.count >= minSources)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
    .map((item) => item.label);
}
const PAGE_SIZE = 40;

function feedHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

/**
 * 筛选条上「订阅分组」选项卡的**溢出判据**：几个放得下，要不要留「···」。
 *
 * ★ 为什么不能交给 CSS
 * --------------------
 * 这一行原本是 `overflow-x: auto`（分类多了可以横向滚）。但用户要的是
 * **「放不下就用三点代替」** —— 滚动条做不到这件事：滚动条把标签藏起来之后，
 * 用户根本不知道右边还有东西，也不会想到去拖。
 *
 * ★ 为什么不用「数汉字」估算
 * -------------------------
 * 中英文混排（`Lex Fridman播客`）一个字的宽度能差一倍，窗口宽度也不固定。
 * 所以宽度由调用方**实测**（离屏量一次，见 `Discover` 里的 `npr-discover-tab-measure`），
 * 这里只做纯算术 —— 好处是这段判断可以在没有 DOM 的地方单测（`test/discover-tabs.test.mjs`）。
 *
 * @param {number[]} widths 各分组标签的实测宽度（px），顺序即展示顺序。
 * @param {number} available 这一行**留给分组标签**的宽度（已扣掉左侧分类标签占位）。
 * @param {{ gap?: number, moreWidth?: number }} [options] 标签间距与「···」自身宽度。
 * @returns {number} 前 N 个标签可见；N 小于 total 时调用方要渲染「···」。
 */
export function groupTabCutoff(widths, available, options = {}) {
  const gap = options.gap ?? 6;
  const moreWidth = options.moreWidth ?? 46;
  if (!Array.isArray(widths) || widths.length === 0) return 0;
  if (!Number.isFinite(available) || available <= 0) return 0;
  let used = 0;
  let fit = 0;
  for (const width of widths) {
    // 每个标签前面都有一个 gap（含第一个，与这一行的 `gap` 布局一致，留一点余量）。
    if (used + width + gap > available) break;
    used += width + gap;
    fit += 1;
  }
  if (fit >= widths.length) return widths.length;
  // 放不下全部 ⇒ 必须给「···」腾出位置：从尾部往回让，直到它也放得下。
  while (fit > 0 && used + moreWidth + gap > available) {
    fit -= 1;
    used -= widths[fit] + gap;
  }
  return fit;
}

/**
 * 名字比对：分组名与目录分类名是不是**同一个东西**（忽略大小写与首尾空格）。
 *
 * ★ 为什么会存在「同名」
 * --------------------
 * 不是用户手滑 —— 是**插件自己造成的**：从推荐源订阅时，`add()` 会把 `group` 写成
 * 该条目的 `category`（见下方 `group: entry.custom ? undefined : entry.category`）。
 * 所以订了 10 条 Newsletter 目录源，就自动多出一个叫 `Newsletter` 的**订阅分组**，
 * 与目录分类同名同义。两者在筛选条上并排出现，看起来就是「列表重复了一项」。
 *
 * 结论：同名 ⇒ 合并成一个选项卡，不再单独渲染分组（用户 2026-10-20：「两个 newsletter
 * 不能合在一起吗？以后增加 newsletter 就放一个分组里。」）。
 */
export function sameName(a, b) {
  const left = String(a ?? '').trim().toLocaleLowerCase();
  const right = String(b ?? '').trim().toLocaleLowerCase();
  return left !== '' && left === right;
}

/**
 * 订阅源 url 的**去重键**：目录里的地址通常不带结尾斜杠，订阅时存下来的常常带
 * （`https://aivalley.ai/feed/` vs `https://aivalley.ai/feed`），直接比字符串会把
 * 同一个源算成两条 —— 合并后的选项卡里就会出现两行一模一样的内容。
 */
export function feedUrlKey(url) {
  return String(url ?? '').trim().replace(/\/+$/, '').toLocaleLowerCase();
}

/** 首帧量一次（字体可能还没就位），字体就绪后再量一次；SSR / 无 DOM 环境下退化成 useEffect。 */
const useMeasure = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * 「分类 + 同名分组」合并视图的行（纯函数，便于单测）。
 *
 * 合并的含义：点 `Newsletter` 这一个选项卡，看到的是**你自己 `Newsletter` 分组里的源**
 * 加上**目录里你还没订阅的 Newsletter**。
 *
 * ★ 为什么「我的」必须排在最前面（2026-10-20 返工）
 * ----------------------------------------------
 * 第一版只补了目录里没有的差集，其余交给目录顺序 —— 结果用户看到的是一屏**目录条目**
 * （The Rundown AI / The Keyword / … 按目录排序），和他自己分组里的顺序、行形态都不一样，
 * 他的结论是「你把我的 Newsletter 分组直接删了，里面加进来的源都没了」。
 * 东西其实一条没少，**排序把它们变成了另一个东西**。所以这里反过来：
 * 我的分组先整段列出（顺序就是他分组里的顺序），目录里剩下的未订阅源追加在后面。
 *
 * ★ 为什么用 `feedUrlKey` 去重
 * --------------------------
 * 目录地址常不带结尾斜杠、订阅存下来的带（`…/feed` vs `…/feed/`），
 * 直接比字符串会把同一个源画两遍（一条「已订阅」+ 一条「订阅」）。
 *
 * @param {{ category: string, matched: object[], subscribed: object[], groupNames: string[], needle?: string }} input
 * @returns {object[]} 合并后的行。「我的」那些已带 `subscription`，显示「阅读 / 已订阅」。
 */
export function mergeCategoryRows({ category, matched, subscribed, groupNames, needle = '' }) {
  const rows = matched ?? [];
  if (!category || category === '全部') return rows;
  const group = (groupNames ?? []).find((name) => sameName(name, category)) ?? '';
  if (!group) return rows;
  const hit = String(needle ?? '').toLocaleLowerCase();
  const mine = (subscribed ?? [])
    .filter((sub) => sameName(sub.group, group))
    .filter((sub) => !hit || `${sub.name} ${sub.url}`.toLocaleLowerCase().includes(hit))
    .map((sub) => ({ name: sub.name, url: sub.url, category: '我的订阅', custom: true, temporary: true, subscription: sub }));
  if (!mine.length) return rows;
  const mineKeys = new Set(mine.map((row) => feedUrlKey(row.url)));
  // 我的分组整段在前，目录里没订阅过的追加在后 —— 既保住「我的分组还在」的观感，
  // 又不会让这个选项卡变成只能看已订阅（目录新增的源仍然能在这里发现）。
  return [...mine, ...rows.filter((row) => !mineKeys.has(feedUrlKey(row.url)))];
}

/**
 * 推荐源的一行。
 *
 * 单独抽成组件是为了**能测**：`Discover` 的有状态逻辑（订阅列表来自 effect）在
 * 没有 DOM 的环境里跑不起来，而这一行才是「点哪个按钮会调到谁」的判据所在。
 * 现在可以拿 `renderToStaticMarkup` 直接渲染它（见 test/discover-row.test.mjs）。
 *
 * ★ 订阅分组**不在这里**显示 —— 它挪到了上面的筛选条上作为选项卡（用户 2026-10-20 校正）：
 *   分组是「筛选维度」，不是「每行的属性」。挂在行尾既挤掉了标题宽度，也没法拿来筛。
 */
export function DiscoverRow({ entry, subscription, state, busy, onAdd, onDrop, onRead }) {
  return <div className={`npr-discover-row${state.level === 'unknown' ? '' : ` is-${state.level}`}`}>
    <span className="npr-discover-avatar" aria-hidden="true">{entry.name.slice(0, 1)}</span>
    <div className="npr-discover-info"><strong>{entry.name}</strong><span title={entry.url}>{feedHost(entry.url)}<span className="npr-discover-dot"> · </span>{entry.category}{entry.note && <><span className="npr-discover-dot"> · </span>{entry.note}</>}{state.label && <><span className="npr-discover-dot"> · </span><span className={`npr-discover-health is-${state.level}`}>{state.label}</span></>}</span></div>
    <div className="npr-discover-actions">
      {subscription
        ? <><button type="button" className="npr-discover-read" aria-label={`阅读 ${entry.name}`} onClick={() => onRead(subscription.id)}>阅读</button><span className="npr-discover-subscribed">已订阅</span></>
        : <button type="button" className="npr-discover-add" disabled={Boolean(busy)} aria-label={`订阅 ${entry.name}`} onClick={() => onAdd(entry)}>{busy === entry.url ? '添加中…' : <><Icon name="plus" />订阅</>}</button>}
      {!entry.temporary && (
        <button type="button" className="npr-discover-drop" disabled={Boolean(busy)} onClick={() => onDrop(entry)}
          aria-label={entry.custom ? `从我的信息源里移除 ${entry.name}` : `从推荐列表里隐藏 ${entry.name}`}
          title={entry.custom ? '从我的信息源里移除（不影响已订阅的内容）' : '从推荐列表里隐藏（不影响已订阅的内容）'}>
          <Icon name={entry.custom ? 'trash-2' : 'eye-off'} size={15} />
        </button>
      )}
    </div>
  </div>;
}

export function Discover({ api, onClose, onAdded, onRead }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  /**
   * 当前选中的**订阅分组**（`''` = 没选）。
   *
   * 它和 `category` 是互斥的两个筛选维度：点分类就清分组、点分组就把分类退回「全部」。
   * 两者同时生效的话，「Newsletter 分类 + AI 动态 分组」会得到一个空列表 ——
   * 分类来自内置目录，分组来自用户自己的订阅，两个维度没有交集可言。
   */
  const [group, setGroup] = useState('');
  const [topic, setTopic] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [subscribed, setSubscribed] = useState([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  /** 「···」弹出的分组菜单的定位（null = 关着）。 */
  const [moreAnchor, setMoreAnchor] = useState(null);
  /** 筛选条实测出来的「放得下几个分组标签」。 */
  const [visibleGroupCount, setVisibleGroupCount] = useState(0);
  const tabsRef = useRef(null);
  const measureStripRef = useRef(null);
  /** 用户自己的目录：自己加的（历史数据）+ 隐藏掉的内置项。 */
  const [own, setOwn] = useState({ sources: [], hidden: [] });
  // 体检快照是构建期抓好的，整份只读一次；`healthNotice` 里的「现在」固定在挂载时，
  // 免得渲染过程中反复取时间导致同一屏里两个数字对不上。
  const health = useMemo(() => healthIndex(catalogHealth), []);
  const healthNote = useMemo(() => healthNotice(catalogHealth), []);
  useEffect(() => setLimit(PAGE_SIZE), [query, category, topic, group]);
  useEffect(() => {
    void api.listSubscriptions().then((result) => setSubscribed(result.subscriptions)).catch((error) => setMessage(error?.message ?? String(error)));
  }, [api]);
  useEffect(() => {
    // 目录与订阅分开取：目录读失败不该让整个面板变成「没有订阅源」。
    void api.listCatalog().then(setOwn).catch((error) => setMessage(error?.message ?? String(error)));
  }, [api]);
  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  // 「···」菜单开着时，Esc 只关菜单，不关整个对话框（捕获阶段先拿到事件）。
  useEffect(() => {
    if (!moreAnchor) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setMoreAnchor(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [moreAnchor]);

  const reloadCatalog = async () => {
    try { setOwn(await api.listCatalog()); }
    catch (error) { setMessage(error?.message ?? String(error)); }
  };

  const merged = useMemo(
    () => mergeCatalog({ builtin: builtinCatalog, sources: own.sources, hidden: own.hidden }),
    [own],
  );
  const categories = useMemo(() => catalogCategories(merged), [merged]);
  const customCount = countCustom(merged);
  /** 主题下拉只列当前分类下**至少 3 个源在用**的标签，频次降序（见 `topicOptions`）。 */
  const topics = useMemo(() => topicOptions(merged, category), [merged, category]);
  // 换了分类以后，原先选中的主题可能已经不在这个分类里了 —— 不清掉就会筛出 0 条，
  // 而下拉框显示的还是那个主题，用户只会以为"这个主题没有内容"。
  useEffect(() => {
    if (topic && !topics.some((tag) => sameName(tag, topic))) setTopic('');
  }, [topics, topic]);

  /**
   * 订阅分组名（去重、按中文排序）。
   *
   * 排序规则与设置页「订阅分组」那块保持一致（`localeCompare(…, 'zh-CN')`）——
   * 同一个列表在两处顺序不同会让人以为数据不一致。
   */
  const groupNames = useMemo(
    () => [...new Set(subscribed.map((sub) => sub.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [subscribed],
  );

  /**
   * **只渲染「独立」的分组**：与目录分类同名的分组不单独出选项卡。
   *
   * 同名不是巧合（见 `sameName`）：从推荐源订阅时 `group` 会被写成该条目的 `category`，
   * 于是「订了 Newsletter」必然长出一个叫 `Newsletter` 的分组。它和分类是同一批东西，
   * 再画一个选项卡就是重复；合并后的分类选项卡会把分组里的源一并列出来。
   */
  const standaloneGroups = useMemo(
    () => groupNames.filter((name) => !categories.some((cat) => sameName(cat, name))),
    [groupNames, categories],
  );

  /**
   * 当前选中的分类若有**同名分组**，这个选项卡就是「目录 + 我的分组」的合并视图
   * （`''` = 没有同名分组，纯目录分类）。
   */
  const mergedGroup = category === '全部' ? '' : groupNames.find((name) => sameName(name, category)) ?? '';

  /**
   * 筛选条的宽度分配：分类标签先占位，剩下的宽度按实测宽度切给分组标签。
   *
   * ★ 必须量不能估：中英混排（`Lex Fridman播客`）与窗口宽度都在变，
   *   估算的结果就是「有时候刚好切掉半个标签」。
   * ★ 离屏量（`npr-discover-tab-measure`）而不是量真实按钮：真实行里放不下的
   *   标签会被移除，第二次就量不到了 —— 那会在窗口拉宽时**加不回来**。
   */
  useMeasure(() => {
    const row = tabsRef.current;
    const strip = measureStripRef.current;
    if (!row || !strip) return undefined;
    const compute = () => {
      const probe = [...strip.children];
      const categoryWidth = probe.slice(0, categories.length)
        .reduce((sum, node) => sum + node.getBoundingClientRect().width, 0);
      const groupWidths = probe.slice(categories.length)
        .map((node) => node.getBoundingClientRect().width);
      const available = row.clientWidth - categoryWidth;
      setVisibleGroupCount(groupTabCutoff(groupWidths, available));
    };
    compute();
    // 字体换了宽度就变了（首帧可能还没就位）。
    void document.fonts?.ready?.then(compute).catch(() => {});
    const observer = new ResizeObserver(compute);
    observer.observe(row);
    return () => observer.disconnect();
  }, [categories, standaloneGroups]);

  /** 放得下的那些；**选中的那个必须始终可见**，否则用户点了「···」里的分组，标签反而消失。 */
  const visibleGroups = useMemo(() => {
    const shown = standaloneGroups.slice(0, visibleGroupCount);
    if (group && !shown.includes(group) && standaloneGroups.includes(group)) {
      return [...shown.slice(0, Math.max(0, shown.length - 1)), group];
    }
    return shown;
  }, [standaloneGroups, visibleGroupCount, group]);
  const hiddenGroups = useMemo(
    () => standaloneGroups.filter((name) => !visibleGroups.includes(name)),
    [standaloneGroups, visibleGroups],
  );

  const rows = useMemo(() => {
    const typed = query.trim();
    const needle = typed.toLocaleLowerCase();
    /**
     * 选中某个分组时，列表换成**这个分组下的已订阅源**。
     *
     * ★ 不是「在 413 条目录里再筛一次」：用户自己的分组里常常是目录外的源
     *   （今天这份数据里 `AI 动态` 的 2 个、`Lex Fridman播客` 的 1 个都不在目录里），
     *   那样点进去会得到一个空列表 —— 选项卡就成了死路。
     */
    if (group) {
      return subscribed
        .filter((sub) => sub.group === group && `${sub.name} ${sub.url}`.toLocaleLowerCase().includes(needle))
        .map((sub) => ({ name: sub.name, url: sub.url, category: '我的订阅', custom: true, temporary: true, subscription: sub }));
    }
    const matched = merged.filter((entry) => (category === '全部' || entry.category === category)
      && (!topic || entry.custom || (entry.tags ?? []).some((tag) => sameName(tag, topic)))
      && `${entry.name} ${entry.url} ${(entry.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(needle));
    /**
     * 与分类同名的分组**并进同一个选项卡**（见 `sameName` / `mergeCategoryRows`）：
     * 我的分组整段排在前，目录里尚未订阅的追加在后。
     */
    const inCategory = mergeCategoryRows({ category, matched, subscribed, groupNames, needle });
    // 粘贴的是一个目录里没有的 http(s) 地址时，把它当成待订阅的自定义源排在最前。
    // ★ 这是**现在唯一**的「订阅目录外地址」入口（2026-10-08 撤掉了「添加信息源」按钮），
    //   所以这条分支不能删：删了用户就没有任何办法订阅自己的源了。
    // `temporary` 不是摆设：这条没有 id、也没进过 store，给它渲染「移除」按钮就是
    // 一个点了会报错的假入口（`removeCatalogSource(undefined)`）。
    if (/^https?:\/\/\S+$/i.test(typed) && !merged.some((entry) => entry.url === typed)) {
      return [{ name: feedHost(typed), url: typed, category: '临时地址', custom: true, temporary: true }, ...inCategory];
    }
    return inCategory;
  }, [query, category, topic, merged, group, subscribed, groupNames]);

  const add = async (entry) => {
    setBusy(entry.url);
    setMessage('');
    try {
      // 自定义源不写死名称与分组：留空让服务端取 feed 自己的标题，并保持未分组。
      const result = await api.addSubscription({
        name: entry.custom ? undefined : entry.name,
        url: entry.url,
        group: entry.custom ? undefined : entry.category,
      });
      setSubscribed((current) => [...current, result]);
      setMessage(result.lastError ? `已添加，首次获取失败：${result.lastError}` : `已订阅 ${result.name ?? entry.name}`);
      // 把新订阅交回上层：它才知道当前视图是不是停在某个具体源上（那样新源根本看不见）。
      await onAdded(result);
    } catch (error) { setMessage(error?.message ?? String(error)); }
    finally { setBusy(''); }
  };

  /**
   * 用户加的自己删；内置的只能隐藏 —— 内置目录要能跟着插件升级更新。
   *
   * ★ 即使界面已经不再提供「添加信息源」，这条**也必须留着**：老版本的 store 里
   *   可能已经有用户自己加的条目，删不掉的话那些条目会永远留在列表里。
   */
  const dropEntry = async (entry) => {
    setBusy(entry.url);
    setMessage('');
    try {
      if (entry.custom) await api.removeCatalogSource(entry.id);
      else await api.setCatalogHidden(entry.url, true);
      await reloadCatalog();
      setMessage(entry.custom ? `已从你的信息源里移除「${entry.name}」` : `已隐藏内置的「${entry.name}」`);
    } catch (error) { setMessage(error?.message ?? String(error)); }
    finally { setBusy(''); }
  };

  const restoreHidden = async () => {
    setBusy('catalog');
    setMessage('');
    try {
      // 隐藏是「按 url 记」的，没有批量接口，这里逐条恢复。数量不会大（用户手动隐藏的）。
      for (const url of own.hidden) await api.setCatalogHidden(url, false);
      await reloadCatalog();
      setMessage('已恢复隐藏的内置信息源');
    } catch (error) { setMessage(error?.message ?? String(error)); }
    finally { setBusy(''); }
  };

  const provenanceText = group
    // 分组视图下列表已经不是「推荐目录」了，必须说清楚，否则会被当成目录少了一大批。
    ? `订阅分组「${group}」下的已订阅源（${subscribed.filter((sub) => sub.group === group).length} 个）。分组在「管理订阅 → 订阅分组」里维护。`
    : [
      category === '全部'
        ? `内置两类：Newsletter = 逐条实测过的 AI 电子报 · 独立博客 = Tim Qian 目录（MIT，已按实测剔除失效条目）。其中 ${customCount} 个源是你自己加的。`
        : provenanceOf(category, { revision: blogCatalog.revision, pruned: blogCatalog.pruned }),
      // 合并视图必须自己说出来，否则用户会以为「我的 Newsletter 分组不见了」。
      mergedGroup && `你的「${mergedGroup}」分组（${subscribed.filter((sub) => sameName(sub.group, mergedGroup)).length} 个源）排在前面，不再单独出标签；目录里还没订阅的接在后面。`,
    ].filter(Boolean).join(' ');

  return <div className="npr-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="npr-dialog npr-discover" role="dialog" aria-modal="true" aria-label="探索订阅">
      <header className="npr-discover-head">
        <div><h3>探索订阅</h3><p>找到感兴趣的内容，加入你的频道。</p></div>
        <div className="npr-discover-head-actions">
          <button type="button" className="npr-icon" aria-label="关闭探索" title="关闭" onClick={onClose}><Icon name="x" /></button>
        </div>
      </header>
      <div className="npr-discover-filters">
        <label className="npr-discover-search"><Icon name="search" /><input autoFocus aria-label="搜索推荐源" placeholder="搜索作者、电子报或 RSS 地址" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="npr-discover-categories" role="group" aria-label="推荐源分类与订阅分组" ref={tabsRef}>
          {categories.map((name) => <button key={name} type="button" className={!group && category === name ? 'active' : ''} aria-pressed={!group && category === name} onClick={() => { setGroup(''); setCategory(name); if (name !== '全部' && name !== '独立博客') setTopic(''); }}>{name}</button>)}
          {/* 这里只放**与目录分类不同名**的分组（`standaloneGroups`）。
              与分类同名的分组（用户几乎必然有一个 `Newsletter`：订阅时插件自动按分类建分组）
              不单独出标签，它的源并进同名分类那个选项卡里 —— 一排里只留一个 `Newsletter`。 */}
          {visibleGroups.map((name) => (
            <button key={`group:${name}`} type="button" className={`npr-discover-group-tab${group === name ? ' active' : ''}`}
              aria-pressed={group === name} title={`订阅分组：${name}`}
              onClick={() => { setGroup(group === name ? '' : name); setCategory('全部'); setTopic(''); }}>
              <Icon name="folder" size={12} />{name}
            </button>
          ))}
          {hiddenGroups.length > 0 && (
            <button type="button" className="npr-discover-group-more" aria-haspopup="menu" aria-expanded={Boolean(moreAnchor)}
              aria-label={`还有 ${hiddenGroups.length} 个订阅分组`} title={`还有 ${hiddenGroups.length} 个订阅分组`}
              onClick={(event) => {
                if (moreAnchor) { setMoreAnchor(null); return; }
                const rect = event.currentTarget.getBoundingClientRect();
                setMoreAnchor({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 232)), top: rect.bottom + 6 });
              }}>···</button>
          )}
        </div>
        {/* 离屏量宽度用的同一批标签（同 class、同字体）。真实行里放不下的会被移除，
            只量真实行的话，窗口拉宽之后那些标签就再也回不来了。 */}
        <div className="npr-discover-categories npr-discover-tab-measure" aria-hidden="true" ref={measureStripRef}>
          {categories.map((name) => <span key={name} className="npr-discover-tab">{name}</span>)}
          {standaloneGroups.map((name) => <span key={name} className="npr-discover-tab"><Icon name="folder" size={12} />{name}</span>)}
        </div>
        {moreAnchor && <>
          <div className="npr-discover-more-scrim" onClick={() => setMoreAnchor(null)} />
          <div className="npr-discover-more-menu" role="menu" aria-label="更多订阅分组" style={moreAnchor}>
            <div className="npr-discover-more-heading">订阅分组</div>
            {hiddenGroups.map((name) => (
              <button key={name} type="button" role="menuitem" className={group === name ? 'active' : ''}
                onClick={() => { setMoreAnchor(null); setGroup(name); setCategory('全部'); setTopic(''); }}>
                <Icon name="folder" size={14} />
                <span>{name}</span>
                <small>{subscribed.filter((sub) => sub.group === name).length} 个订阅源</small>
              </button>
            ))}
          </div>
        </>}
        <div className="npr-discover-provenance"><Icon name="info" size={14} /><span>{provenanceText}</span></div>
        <div className="npr-discover-filter-line">
          <span>{rows.length} 个结果</span>
          {/* 选项来自 `topicOptions`：只留 ≥3 个源在用的标签、按使用次数降序。
              没有可选标签的分类（如 Newsletter 的 9 条都没有 tags）直接禁用，
              否则点开只有一个「全部主题」，看着像坏了。 */}
          <select aria-label="主题标签" value={topic} onChange={(event) => setTopic(event.target.value)}
            disabled={Boolean(group) || topics.length === 0}
            title={topics.length ? `${topics.length} 个主题（只列至少 3 个源在用的）` : '当前分类没有主题标签'}>
            <option value="">全部主题</option>
            {topics.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        </div>
      </div>
      <div className="npr-discover-results">
        {rows.slice(0, limit).map((entry, index) => {
          // 分组视图里每行自带订阅对象（它们常常不在目录里，按 url 去 subscribed 里找也行，
          // 但直接带上省一次 O(n) 扫描，而且避免了「目录改了 url 就匹配不上」这类边角）。
          // 结尾斜杠会让精确比对落空（目录写 `…/feed`、订阅存下来的是 `…/feed/`），
          // 合并后的选项卡里这两类行并排，落空就会把已订阅的行画成「订阅」按钮。
          const subscription = entry.subscription ?? subscribed.find((sub) => sub.url === entry.url)
            ?? subscribed.find((sub) => feedUrlKey(sub.url) === feedUrlKey(entry.url));
          const state = entry.custom ? { level: 'unknown', label: '' } : catalogHealthOf(entry.url, health);
          return <DiscoverRow key={`${entry.url}:${index}`} entry={entry} subscription={subscription} state={state}
            busy={busy} onAdd={add} onDrop={dropEntry} onRead={onRead} />;
        })}
        {rows.length > limit && <button type="button" className="npr-discover-more" onClick={() => setLimit((current) => current + PAGE_SIZE)}>显示更多</button>}
        {!rows.length && <div className="npr-discover-empty">没有找到匹配的订阅源</div>}
      </div>
      <footer className="npr-discover-foot">
        {message && <div className="npr-discover-message" role="status">{message}</div>}
        <span>隐藏只影响这个推荐列表，已订阅的内容不受影响。要订阅目录外的地址，直接把 RSS / Atom 地址粘到上面的搜索框里。</span>
        {own.hidden.length > 0 && <button type="button" className="npr-discover-restore" disabled={Boolean(busy)} onClick={() => void restoreHidden()}>恢复隐藏的 {own.hidden.length} 个内置源</button>}
        {healthNote && <span className={`npr-discover-health-note${healthNote.expired ? ' is-expired' : ''}`}>{healthNote.text}</span>}
      </footer>
    </div>
  </div>;
}
