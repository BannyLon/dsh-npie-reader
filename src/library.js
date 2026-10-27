/**
 * 书架：书条目与阅读状态的**共用判据**（宿主半区与浏览器半区 import 同一份）。
 *
 * 为什么必须共用：同一个判据在两处各写一遍 ⇒ 两个数字对不上。这里会立刻发生的是
 * 「按书名搜索」——宿主侧若按原始 `filename` 匹配、界面侧按清洗后的 `title` 匹配，
 * 用户搜一个书名会得到两套结果，而且谁也说不清哪套对。所以凡是「一个条目算不算
 * 命中 / 一个状态合不合法 / 一本书能不能读」这类判断，只在这个文件里有一份实现。
 *
 * 本文件**不许**出现 Node 或浏览器专属 API（`node:*`、`document`、`fetch`…）：
 * 两端都要 import 它。
 */

/** 阅读状态。与用户已有那份书单工具（ebook-sorter 的 `data/reading.json`）逐字一致。 */
export const BOOK_STATES = ['unread', 'reading', 'read', 'dropped'];

export const BOOK_STATE_LABELS = {
  unread: '未读',
  reading: '在读',
  read: '读完',
  dropped: '弃读',
};

/**
 * 阅读页状态筛的**分组**。
 *
 * ★ 这是界面与判据的**单一来源**：`LibraryApp` 只负责渲染，`filterBooks` 只负责按
 *   `states` 匹配。两处各写一遍时，界面上写着「在读」而判据只认 `state === 'reading'`
 *   —— 「加进来还没点开」的书（`state === 'unread'`）就会从「在读」里漏掉，
 *   而它们**恰恰是最该出现在在读列表里的**。
 *
 * ★ 四组的含义（2026-10-09 用户定的模型）：
 *   - 全部 = 已加入「阅读」的书；
 *   - 在读 = **未开始 + 在读**。原来的「未读」不是一个独立状态，它就是「进度 0 的
 *     在读」—— 进「阅读」页这个动作本身已经表示「我要读它」，再给一个叫「未读」的
 *     档会被读成「还没标要读」，而用户观察不到它（点标题那一刻就变 `reading` 了）。
 *   - 读完 = 用户按了「标记读完」；
 *   - 弃读 = 加了进来、但现在不打算读了（点「已在阅读」会落到这里，**可逆**：
 *     点标题打开就会回到「在读」）。
 *   四组互不重叠，合起来正好是「全部」。
 *
 * ★ `states: null` 表示「不过滤」。**别写成 `[]`** —— 那会让「全部」筛出 0 本。
 */
export const READING_STATE_FILTERS = [
  { value: '', label: '全部', states: null },
  { value: 'reading', label: '在读', states: ['unread', 'reading'] },
  { value: 'read', label: '读完', states: ['read'] },
  { value: 'dropped', label: '弃读', states: ['dropped'] },
];

/** 状态在界面上的固定顺序：在读 > 未读 > 读完 > 弃读。 */
const STATE_ORDER = { reading: 0, unread: 1, read: 2, dropped: 3 };

/** 一条阅读状态的缺省值。 */
export function emptyState() {
  return { state: 'unread', page: 0, pages: 0, at: 0, added: false, scanned: false };
}

/**
 * 「这本书在不在『阅读』里」。
 *
 * 侧栏分两页：**书架**是网盘上的全部书（2634 本），**阅读**只放用户自己挑过的书
 * —— 加进来的动作就等于订阅（用户的原话：「就类似于 RSS 的订阅」）。所以「在不在
 * 阅读里」是一件必须和「读到哪儿」分开记的事：都读过、但已经移出阅读的书不能让
 * 它继续占着阅读页；从没读过、只加进来的书必须留在里面。
 *
 * ★ 缺字段时按**已有进度**推，不是按「没有就算 false」：
 *   0.7.0 之前没有 `added` 字段，用户那 9 本在读、读完的书是真的在读 —— 直接判 false
 *   会让它们从「阅读」页里凭空消失，而用户看到的是「我的书不见了」。
 *   所以：**有进度 ⇒ 算已加入**；一旦字段真的存在（哪怕是显式的 `false`），
 *   就照它走 —— 退订必须真的能退掉，不能被这条兜底翻回来。
 */
function addedFlag(raw, state, page) {
  if (typeof raw.added === 'boolean') return raw.added;
  return state !== 'unread' || page > 0;
}

/** 书条目 id 的形态。与 ebook-sorter 的 `b00001` 一致，也允许别的字母数字 id。 */
const BOOK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isBookId(value) {
  return typeof value === 'string' && BOOK_ID_RE.test(value);
}

/**
 * 一次最多返回多少本书。
 *
 * 这不是「分页大小」而是**安全阀**：搜索、排序、按分类筛都在浏览器侧做（判据见本文件），
 * 所以界面需要**全量**书单才能给出正确的搜索结果 —— 只发前 N 条会让「搜不到某本书」
 * 变成一个假的结论。实测 2634 条序列化后约 0.9 MB，走本机协议是几毫秒的事。
 * 这个上限只用来挡住畸形数据把内存撑爆。
 */
export const BOOKS_PAGE_LIMIT = 5000;

/**
 * 书架 HTTP 面的路径前缀。
 *
 * ★ 宿主注册路由用它、浏览器半区拼 `fetch` 的相对路径也用它 —— 必须**同一份**。
 *   两边各写一遍字符串字面量时，改一边不改另一边不会报错，只会 404，
 *   而 404 在这条链路上的表现是「书架一直转圈」。
 */
export const LIBRARY_API_PREFIX = '/api/dsh-npie-reader/library';

/** 内置 pdf.js 的静态资源前缀（宿主按这个前缀发文件，客户端按它拼 URL）。 */
export const PDFJS_VENDOR_PREFIX = '/vendor/npie-reader/pdfjs';

/**
 * 日记编辑器的静态资源前缀。
 *
 * ★ 为什么编辑器要**单独发一份文件**、而不是打进 client bundle：它是第三方代码
 *   （Milkdown 7，markdown 原生），打包后约 373 KB。内联会把 `lib/client.js`
 *   顶过体积闸，而那道闸守的正是「有整个依赖被内联进来了」。pdf.js 走的是同一条路
 *   （动态 `import()` 一个宿主托管的文件），这里照抄，理由一致。
 * ★ 好处不只是体积：日记页不开就不下载，打开也是**按需**一次。
 */
export const EDITOR_VENDOR_PREFIX = '/vendor/npie-reader/editor';

/**
 * 书单索引文件的默认位置：**空串** = 用插件自己数据目录里的 `books.json`。
 *
 * ★ 这里刻意**不写死绝对路径**。0.7.1 之前它指向作者本机那份 ebook-sorter 书单
 *   （`~/Documents/NPIE-program/dsh_web/ebook-sorter/data/books.json`），后果是：
 *   任何人装完插件打开设置，第一眼看到的是**别人机器上**的路径，而且必然报
 *   「这个路径下没有书单文件」—— 他既不知道该填什么，也不知道书单从哪来。
 *
 * 空串由宿主解析成 `<dshHome>/storages/dsh-npie-reader/books.json`。写成「空 = 插件
 * 数据目录」而不是在这里拼绝对路径，是因为浏览器半区拿不到 `dshHome`（要 import
 * `node:os`），这条语义只能在共用模块里写一次、由两端各自兑现。
 *
 * ★ 这个常量必须住在**共用**模块里（而不是 `src/host/library.js`）：设置项的默认值
 *   两端都要用，而宿主那个模块 import 了 `node:fs` —— 浏览器半区跟着 import 它，
 *   整个客户端 bundle 就会被打进一堆 Node 内建模块的 shim。
 */
export const LIBRARY_PATH_DEFAULT = '';

/**
 * 书源的两种形态。
 *
 * `local` 是**本机目录**里的电子书，`pan` 是**百度网盘**上的。两种源产出的书单行
 * 形状不同（一个只有本地路径、一个有 fs_id），但**规范化之后是同一种书条目** ——
 * 界面、搜索、排序、分组都不需要知道这本书从哪来；只有「取字节」那一层要分派。
 */
export const BOOK_SOURCE_KINDS = ['local', 'pan'];

export const BOOK_SOURCE_LABELS = { local: '本地目录', pan: '百度网盘' };

/** 一条书源最多多长。防止畸形的超长路径把设置文件撑爆。 */
const BOOK_SOURCE_PATH_MAX = 500;

/** 书单名称最长多少。窄卡片里一行放得下才是目的，所以比路径短得多。 */
export const BOOK_LIST_NAME_MAX = 60;

/**
 * 取路径的末段做名字（`/Users/你/电子书` → `电子书`）。
 *
 * 为什么名字要能自动生成：用户配了 6 个目录，让他为每个目录手打一遍名字，等于
 * 逼他做一次**纯搬运**。目录名本来就是他会用的那个词。
 */
function lastSegment(path) {
  const parts = String(path ?? '').split(/[/\\]/).filter((part) => part !== '' && part !== '~');
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * 一条书源的默认名字。
 *
 * ★ 网盘那一侧**必须带前缀**：本地 `/电子书` 与网盘 `/电子书` 是两个不同的源，
 *   去掉前缀之后它们在界面上长得一模一样，用户改错一个就再也分不清哪个是哪个了。
 */
export function defaultSourceName(kind, path) {
  const text = String(path ?? '').trim();
  if (kind === 'pan') {
    const normalized = text.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (normalized === '' || normalized === '/') return '网盘 · 根目录';
    const segment = lastSegment(normalized);
    return segment === '' ? '网盘目录' : `网盘 · ${segment}`;
  }
  const segment = lastSegment(text);
  return segment === '' ? '本地目录' : segment;
}

/**
 * 一条书源的**稳定 id**。
 *
 * 用途有两处，两处都要求跨次稳定：
 *   1. 书单文件名（`lists/<id>.json`）—— 重新生成时覆盖同一份，而不是每点一次多一个文件；
 *   2. 「哪几份书单已载入」那个列表按 id 记 —— 换 id 等于把用户的载入选择清零。
 *
 * 所以**不能用数组下标**（删掉中间一条会让后面全部错位），也不能用时间戳。
 * 用 `kind + path` 的哈希：默认名字可以随便改，改名字不该动 id。
 */
export function sourceListId(kind, path) {
  return bookIdFromPath('s', `${String(kind ?? '')}\u0000${String(path ?? '').trim()}`);
}

/**
 * 规范化一条书源配置。返回 `undefined` 表示这条**不可用**（直接丢掉而不是报错：
 * 一条手滑写坏的行不该让整份设置存不进去）。
 *
 * @param raw - `{ kind, path, name? }`。`name` 缺省时由 `defaultSourceName` 推出；
 *   `id` 一律**现算**、不从入参取 —— 让外部塞一个 id 进来就等于允许两条配置指向
 *   同一份书单文件，而「哪几份已载入」是按 id 记的。
 */
export function normalizeBookSource(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const kind = String(raw.kind ?? '');
  if (!BOOK_SOURCE_KINDS.includes(kind)) return undefined;
  const path = String(raw.path ?? '').trim();
  if (path === '' || path.length > BOOK_SOURCE_PATH_MAX || path.includes('\0')) return undefined;
  const rawName = String(raw.name ?? '').trim().replace(/\s+/g, ' ');
  const name = rawName === '' || rawName.length > BOOK_LIST_NAME_MAX
    ? defaultSourceName(kind, path)
    : rawName;
  return { id: sourceListId(kind, path), kind, path, name };
}

/** 一份设置里最多允许多少条书源（挡住「把整个磁盘加进来」这类手滑）。 */
export const BOOK_SOURCES_MAX = 32;

/** 规范化整个书源列表：逐条过 `normalizeBookSource`、丢掉坏行、去重、限长。 */
export function normalizeBookSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const source = normalizeBookSource(raw);
    if (source === undefined) continue;
    // 同 kind + 同 path 只留一条：重复扫描同目录会产出重复 id，而 id 是进度的键。
    const key = `${source.kind}\u0000${source.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length >= BOOK_SOURCES_MAX) break;
  }
  return out;
}

/**
 * 规范化「哪几份书单已载入」。
 *
 * ★ 这里**不校验 id 是否存在**。校验了会把「先把几份书单载入、再去配书源」这个顺序
 *   变成不可能：用户删掉一条书源时，他勾过的那份书单会在同一次写操作里连 id 一起消失，
 *   于是「我只是想改个路径，怎么载入选择没了」。
 *   保留未知 id 的代价只是它在界面上不出现（找不到对应的清单条目），而这是可以自愈的。
 */
export function normalizeLibraryListIds(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const id = String(raw ?? '').trim();
    if (!isBookId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= BOOK_SOURCES_MAX) break;
  }
  return out;
}

/**
 * 由路径推出一个**跨次扫描稳定**的书 id。
 *
 * 为什么要稳定：阅读进度是按 id 记的（`store.data.library.states[id]`）。若 id 在每次
 * 重新扫描时变一个值，用户「重新生成书单」之后会发现**所有进度清零** —— 而这正是最
 * 需要保住的东西。
 *
 * 算法是两轮 FNV-1a 拼成 64 位（16 个十六进制字符）。单轮 32 位在 2 万本规模下
 * 按生日界约有 5% 概率撞一次，撞了会让两条不同的书拿到同一个 id（点哪一本变得不确定）；
 * 两轮后概率降到约 1e-11。
 *
 * `prefix` 区分来源（`l` 本地 / `p` 网盘），这样同一个路径在两种源下不会互相覆盖。
 */
export function bookIdFromPath(prefix, seed) {
  const text = String(seed ?? '');
  const fnv = (input, basis) => {
    let hash = basis >>> 0;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };
  const low = fnv(text, 0x811c9dc5).toString(16).padStart(8, '0');
  const high = fnv(`${text}\u0000npie`, 0x9e3779b1).toString(16).padStart(8, '0');
  return `${prefix}${high}${low}`;
}

/**
 * 能**重排阅读**的扩展名（正文由宿主解析成块模型，界面上重新排版）。
 *
 * ★ 为什么这份清单在 `library.js` 而不是 `host/ebook/index.js`：判「一本书读得了吗」
 *   发生在两处 —— 宿主侧（`renderable` 要不要置真、`ebookOf` 要不要接）和浏览器侧
 *   （`BookReader` 要不要挂 `BookEbook`）。两处各写一份清单，加一个格式时必然漏改
 *   一处，症状是「书架上写着能读，点进去说没接上」。所以只在这里有一份，
 *   `host/ebook/index.js` 从这里 import 再转出去。
 *
 * `.docx` **不在**里面：那是文档不是书，版式、批注、表格与「一章一节」的模型都对不上。
 */
export const EBOOK_EXTENSIONS = ['epub', 'mobi', 'azw3', 'azw', 'txt'];

/** 是否是能重排阅读的电子书格式。大小写与点号都容忍（`'.EPUB'` 也算）。 */
export function isEbookExtension(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/^\./, '');
  return EBOOK_EXTENSIONS.includes(text);
}

/**
 * 支持的扩展名。`pdf` 能**原版式**渲染，`EBOOK_EXTENSIONS` 里那几个能**重排**阅读、
 * 也能抽章解读；`docx` 只保留在书架上（标注「暂不支持」）。
 */
export const BOOK_EXTENSIONS = ['pdf', ...EBOOK_EXTENSIONS, 'docx'];

export function normalizeExtension(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/^\./, '');
  return BOOK_EXTENSIONS.includes(text) ? text : '';
}

/** 人类可读的体积。刻意不用 `Intl`：两端数字必须一致，而 `Intl` 会随环境变。 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit += 1; }
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unit]}`;
}

/**
 * 从文件名推书名：去掉扩展名与 ebook-sorter 扫盘时加的 `_20201020_174427` 时间后缀。
 *
 * 索引里本来就有 `title`，这里只是**索引缺字段时的兜底**。做成共用判据是因为
 * 「按书名搜索」要用到它 —— 两处各写一遍清洗规则，搜索结果就会不一致。
 */
export function titleFromFilename(filename) {
  const base = String(filename ?? '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return base.replace(/_\d{8}_\d{6}$/, '').replace(/[_\s]+$/, '').trim();
}

/**
 * 把索引里的一条原始记录规范化成界面/宿主共用的形状。
 *
 * 返回 `undefined` 表示这条记录**不可用**（没有合法 id）—— 宁可丢掉也不要造一个
 * 点进去必然报错的条目。**取不到字节**（既没有 `fs_id` 也没有本地路径）不算不可用：
 * 它仍然要出现在书架上（用户得知道它存在、在哪儿），只是标成读不了。
 *
 * @param raw - 索引里的一条记录。
 * @returns 规范化后的书条目，或 undefined。
 */
export function normalizeBook(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = String(raw.id ?? '');
  if (!isBookId(id)) return undefined;

  const filename = String(raw.filename ?? '');
  const size = Number(raw.size);
  const fsId = Number(raw.fs_id);
  // ★ 先各自规范化、再回退 —— 不能用 `raw.ext ?? 从文件名推`：`??` 只在 `null`/`undefined`
  //   时回退，`ext: ''` 会原样通过（空串不是 nullish）。那样一条「ext 空着但文件名带后缀」
  //   的记录会得到 `ext: ''` ⇒ 判成不可渲染、按扩展名筛选也筛不出来，而它其实是一本好 pdf。
  const extFromField = normalizeExtension(raw.ext);
  const ext = extFromField !== ''
    ? extFromField
    : normalizeExtension(filename.slice(filename.lastIndexOf('.') + 1));
  const title = String(raw.title ?? '').trim() || titleFromFilename(filename);
  const hasFsId = Number.isInteger(fsId) && fsId > 0;
  const year = Number(raw.year);
  /**
   * 本地路径。`abspath` 优先；只有**没有 `fs_id`**（= 它不可能是网盘书）时才退到 `relpath`。
   *
   * ★ 两道判断的理由：
   *   1. 支持 `relpath` 是必要的 —— 用户已有的 `scan-books.mjs`（本地扫描器）产出的
   *      相对路径就是它的唯一凭据。只认 `abspath` 的话，那份书单接进来会变成
   *      「看得见、打不开」，而原因藏在协议不匹配里，用户根本看不出来。
   *   2. 但**不能无条件**退到 `relpath`：`relpath` 在两个生成器里含义不同 ——
   *      本地扫描器写的是相对路径，网盘列表器写的却是**网盘路径**。无条件采用的话，
   *      一条带 `relpath` 的网盘书会被同时当成「有本地文件」，于是在取字节那一层
   *      去本地磁盘上找 `/我的资源/电子书/…`，报一句谁也看不懂的错。
   *      有 `fs_id` ⇒ 它是网盘书 ⇒ 本地路径只认 `abspath`（那是真信息：用户本地也存了一份）。
   */
  const localPath = String(raw.abspath ?? '').trim()
    || (hasFsId ? '' : String(raw.relpath ?? '').trim());

  return {
    id,
    title: title || filename || id,
    filename,
    ext,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    // `fsId` 是网盘取字节的唯一凭据；`localPath` 是本地取字节的凭据。两者都为空 ⇒
    // 这本书只看得到、读不了（`rawBook` 会给一句明确的话，而不是 404）。
    fsId: hasFsId ? fsId : 0,
    localPath,
    /**
     * 这本书从哪来。两个地方读它：取字节那一层靠它分派（`readBytes`），
     * 以及扫描版的 OCR 指引 —— 网盘书要先下载再 OCR，本地书改文件就行
     * （见 `BookDigestPanel` 里 `isPan` 那段）。
     */
    source: hasFsId ? 'pan' : (localPath === '' ? '' : 'local'),
    // 网盘上的绝对路径。目前**不用来取字节**（取字节靠 `fsId`），它的用途是
    // 「这本书本插件读不了」时把路径显示给用户 —— 让他能直接去网盘客户端里打开，
    // 而不是卡在一句「暂不支持」上。
    panPath: String(raw.pan_path ?? '').trim(),
    series: String(raw.series ?? '').trim(),
    year: Number.isInteger(year) && year > 0 ? year : 0,
    topDir: String(raw.top_dir ?? '').trim(),
    /**
     * 能不能**打开来读**：PDF 或重排电子书（EPUB/MOBI/AZW3/AZW/TXT），且**取得到字节**
     * （网盘有 fs_id，或本地有路径）。
     *
     * ★ 本地路径在这里只判「有没有」，不判「在不在允许的根目录内」—— 后者要看用户当前
     *   的书源配置，而这是个纯函数、拿不到配置。越界的本地书会在**打开时**被宿主拒掉
     *   并给一句明确的话；把它在这里悄悄标成「暂不支持」反而会让人以为格式不对。
     *
     * ★ 名字仍是 `renderable` 而不是 `readable`：`isReadable()` 已经占了后者，含意是
     *   「取得到字节」，比这里更宽（docx 取得到字节但读不了）。两者不能合并。
     */
    renderable: (ext === 'pdf' || EBOOK_EXTENSIONS.includes(ext)) && (hasFsId || localPath !== ''),
  };
}

/**
 * 这条记录能不能真的取到字节（网盘上有 fs_id，或本地有路径）。
 *
 * ★ 本地那一侧必须写成 `String(book.localPath ?? '').trim() !== ''`，不能写成
 *   `book.localPath !== ''`：后者在字段**缺失**时 `undefined !== ''` 为真 ——
 *   于是任何一份手写的、没有 `localPath` 的记录都会被判成「读得了」，
 *   然后在取字节那一层变成一句莫名其妙的失败（本文件的 `test` / `library-routes`
 *   各抓到过一次，都是这条）。缺失与空串在这里必须是同一个意思。
 */
export function isReadable(book) {
  if (!book) return false;
  return book.fsId > 0 || String(book.localPath ?? '').trim() !== '';
}

/** 规范化一个状态对象；任何不认识的值都退回「未读」，不抛错。 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  const state = BOOK_STATES.includes(raw.state) ? raw.state : 'unread';
  const page = Number(raw.page);
  const pages = Number(raw.pages);
  const at = Number(raw.at);
  const cleanPage = Number.isInteger(page) && page >= 0 ? page : 0;
  return {
    state,
    page: cleanPage,
    pages: Number.isInteger(pages) && pages > 0 ? pages : 0,
    at: Number.isFinite(at) && at > 0 ? at : 0,
    added: addedFlag(raw, state, cleanPage),
    /**
     * 这本书**实测**是扫描版（抽取目录时发现整本没有文字层）。
     *
     * ★ 为什么记在这里而不是每本书都去探一遍：探测要下载整本（见
     *   `scripts/probe-pdf-textlayer.mjs`），2634 本全探一遍是不可能的。
     *   所以只记「用户真的点过抽取、并且抽出来是空的」那些 —— 也就是**已知**的那些。
     *   未知 ≠ 不是扫描版，界面上不能把没标记的当成文字版。
     */
    scanned: raw.scanned === true,
  };
}

/** 读一本书的状态（缺省 = 未读）。 */
export function stateOf(states, id) {
  return normalizeState(states?.[id]);
}

/** 这本书在不在「阅读」里。**判据只这一份**：界面、统计、筛选都走它。 */
export function isAdded(states, id) {
  return stateOf(states, id).added === true;
}

/**
 * 「阅读」页的书 = 已加入的那些。
 *
 * 单独一个函数而不是在各个调用点写一遍 `.filter(...)`：阅读页的**书单**与它的
 * **统计条**（在读几本、读完几本）必须来自同一个集合，两处各筛一次迟早会漂移
 * —— 那种漂移在界面上表现为「数字和列表对不上」，而没人能一眼看出是谁错了。
 */
export function addedBooks(books, states = {}) {
  return books.filter((book) => isAdded(states, book.id));
}

/**
 * 「读到哪儿」的一句话。
 *
 * ★ **只有这一份**：徽章用它，以后的任何地方都用它 —— 同一个进度出现两种写法
 *   （「读到 125 / 327 页」与「125 / 327」）时，没人能一眼看出哪个是对的。
 * ★ 页数未知（`pages === 0`）时**不写分母**：`读到 125 / 0 页` 是一句假话。
 *   这与 `progressPercent` 的约定一致（页数未知返回 `null`，不返回 0）。
 */
export function readingProgressLabel(state) {
  const page = Number(state?.page);
  const pages = Number(state?.pages);
  if (!Number.isInteger(page) || page <= 0) return '未开始';
  return Number.isInteger(pages) && pages > 0 ? `读到 ${page} / ${pages} 页` : `读到 ${page} 页`;
}

/**
 * 一行书在界面上**全部会变的部分**：徽章文字、动作按钮、以及这一行本身能不能点开。
 *
 * ★ 为什么住在这里（而不是写在 `LibraryApp.jsx` 的 `? :` 嵌套里）：它是一张**真值表**，
 *   而真值表最适合用**真代码**跑着测 —— 写成组件内部的嵌套三元时，只能靠源码字符串
 *   断言，那答不了「这条分支跑不跑得到」（本项目给死代码发过合格证）。
 *   放这里以后，`test/library.test.mjs` 能把四个状态 × 两个页面逐个跑一遍。
 *
 * ★★ 两个页面的**职责根本不同**（用户 2026-10-09 的原话，逐字）：
 *   「阅读是点击电子书可以取书阅读，但是书架就是电子书的一个展示，不能点击电子书取书阅读。」
 *   ⇒ **书架页**：一行书**没有任何「取书阅读」动作**。点行本身什么都不发生；唯一的动作是
 *     「+ 阅读」（加入），加进来之后那个位置变成**状态标签**「已开始阅读」。
 *   ⇒ **阅读页**：**未开始 / 在读**那两格点行就是取书阅读；**读完 / 弃读**那两格点行
 *     什么都不发生，恢复只能走右边的按钮（「重新阅读」/「+ 阅读」）——
 *     这条也是用户定的：「点击应该不能有任何动作，只能点击『重新阅读』才可以」
 *     （读完）与「弃读下的电子书也不能点击阅读，……还应该有个『+ 阅读』按钮」（弃读）。
 *   ⇒ 所以**会打开书的动作**（`restart`）永远不出现在书架页 —— 这条由
 *     `test/library.test.mjs` 直接断言（书架页的 `kind` 只许是 `add`）。
 *   ⇒ 反过来说：**`openable: true` 蕴含「这一行确实会打开书」**，而 `restart` 只在
 *     `openable: false` 的行上出现 —— 于是「按钮是唯一入口」这件事是**结构上**成立的，
 *     不靠人记得。
 *
 * @param book - 规范化后的书条目（只用到 `title`）。
 * @param state - `normalizeState()` 之后的**状态对象**（不是 id）。
 * @param options.onReadingPage - 这一行是不是渲染在「阅读」页里。
 * @returns `{ badgeText, badgeState, actions, statusLabel, openable, openHint, dim }`
 *   - `actions`：右侧的**按钮**，**0–2 个**，按显示顺序，每项是 `{ kind, text, title, label }`；
 *   - `statusLabel`：右侧的**状态标签**（组件据此渲染 `span` 而不是 `button`），或 `null`；
 *   - ★ 两者**恰好有一个非空** —— 那个位置要么是动作、要么是状态，没有第三种形态。
 *     （`test/library.test.mjs` 有一条遍历断言钉住这个互斥关系。）
 */
export function bookRowView(book, state, options = {}) {
  const onReadingPage = options.onReadingPage === true;
  const title = String(book?.title ?? '');
  const added = state?.added === true;
  const name = BOOK_STATES.includes(state?.state) ? state.state : 'unread';

  /**
   * 徽章文字。
   *
   * ★ 「未读」**不再出现**：它和「在读」是同一条进度轴上的两格（都还没读完），而筛选条上
   *   这一格已经叫「在读」了 —— 同一本书在筛选项里叫「在读」、在徽章里叫「未读」是
   *   自相矛盾的。0.9.0 合并筛选条时漏掉了徽章这一处（用户 2026-10-09 指出的）。
   * ★ 进度写进**徽章本身**（用户原话：「『在读』标签应该是『在读+进度』」）：
   *   一行里只有一个地方说「读到哪儿」，而不是徽章说状态、旁边另挂一个数字。
   */
  const badgeText = (name === 'unread' || name === 'reading')
    ? `${BOOK_STATE_LABELS.reading} · ${readingProgressLabel(state)}`
    : BOOK_STATE_LABELS[name];

  /**
   * 未加入「阅读」：唯一的动作是**加入**。
   *
   * ★ 徽章不显示 —— 书架里 2634 本全是「未读」，每人一个灰牌子等于没有信息
   *   （见 LibraryApp.jsx 里徽章那一行的说明）。
   * ★ `openable: false` 在**两页都成立**：书架是展示（不能取书阅读），而阅读页里本来
   *   就不会出现「未加入」的行（它的列表就是 `addedBooks(...)`）。
   */
  if (!added) {
    return {
      badgeText: '',
      badgeState: name,
      actions: [{
        kind: 'add',
        text: '+ 阅读',
        title: '把这本书加进「阅读」页 —— 之后到那一页点书名取书阅读',
        label: `把《${title}》加进「阅读」`,
      }],
      statusLabel: null,
      openable: false,
      openHint: '',
      dim: false,
    };
  }

  /**
   * 书架页：**纯展示**。
   *
   * ★ 用户原话：「书架就是电子书的一个展示，不能点击电子书取书阅读」。所以这一页
   *   **不许有**任何会打开书的动作 —— 上一版这里的「重新阅读」正是踩了这条线。
   * ★ 已加入时那个位置是**状态标签**（`statusLabel`，组件据此渲染 `span`）而不是按钮：用户的原话是
   *   「『+ 阅读』就变为『已开始阅读』」——「已开始阅读」说的是**状态**，不是动作。
   *   组件因此对它渲染 `span` 而不是 `button`：一个点了没反应的按钮就是
   *   「看起来像功能」（本项目最怕的形态）。
   * ★ `dim: false`：**整页都不可点**，所以不需要把标题压暗 —— 压暗是给「同一页里
   *   有的能点、有的不能点」那种情况用的（阅读页的「读完」那一行）。
   */
  if (!onReadingPage) {
    return {
      badgeText,
      badgeState: name,
      actions: [],
      statusLabel: {
        text: '已开始阅读',
        title: '这本书已经在「阅读」页里 —— 书架只是展示，取书阅读请到「阅读」页',
      },
      openable: false,
      openHint: '',
      dim: false,
    };
  }

  /**
   * 已弃读：**两个**按钮 ——「+ 阅读」在前、「移出」在后；点这一行什么都不发生。
   *
   * ★ 用户 2026-10-09 的原话（逐字）：「阅读选项卡下，弃读下的电子书也不能点击阅读，
   *   除了『移出』按钮之外还应该有个『+ 阅读』按钮，点击即可再次阅读。」
   *   ⇒ 0.9.3 之前这一行是**可点开**的（点书名 = 重新开始阅读，走 `openBook` 里那条
   *     `dropped → reading`）。现在改成和「读完」同一套：**要恢复必须点按钮**，
   *     点行本身没有任何动作 —— 于是 `openBook` 里那条 `dropped` 分支成了**死代码**，
   *     已经删掉（留着它就是给死代码发合格证）。
   * ★ 「移出」仍在**最右**：上一版它就在那个位置，把新按钮插在它左边，用户的手不会
   *   因为这次改动而点到别的东西上；最右那格是破坏性动作，也不该让光标先落上去。
   * ★ `dim: true`：和「读完」同理 —— 同一页里「未开始 / 在读」都能点开、这两格不能，
   *   所以压暗才有信息量。**两格必须一致**：只压一格会让「压暗」变成随机的。
   */
  if (name === 'dropped') {
    return {
      badgeText,
      badgeState: name,
      actions: [
        {
          kind: 'restart',
          text: '+ 阅读',
          title: '把这本书放回「在读」并打开 —— 进度从上次停下的地方接着算',
          label: `把《${title}》放回「在读」并继续阅读`,
        },
        {
          kind: 'remove',
          text: '移出',
          title: '移出「阅读」回到书架 —— 阅读进度不会丢',
          label: `把《${title}》移出「阅读」`,
        },
      ],
      statusLabel: null,
      openable: false,
      openHint: '要再读，点右边的「+ 阅读」',
      dim: true,
    };
  }

  /**
   * 已读完：**按钮是唯一的入口**。
   *
   * ★ 用户 2026-10-09：「『读完』下面的电子书点击应该不能有任何动作，只能点击
   *   『重新阅读』才可以。」⇒ 这一行不可点开（`openable: false`），免得手滑把一本
   *   已经读完的书重新翻开。要再读一遍必须走「重新阅读」（它才写 `state`）。
   * ★ `dim: true`：同一页里别的行都能点，只有这一格不能 —— 所以标题压暗、去掉
   *   hover 高亮，让「这一格不一样」当场看得见。只加 `disabled` 是看不出来的
   *   （`.npr-bookrow-main` 的 `color` 是写死的）。
   */
  if (name === 'read') {
    return {
      badgeText,
      badgeState: name,
      actions: [{
        kind: 'restart',
        text: '重新阅读',
        title: '把这本书放回「在读」并打开 —— 进度从上次停下的地方接着算',
        label: `重新阅读《${title}》`,
      }],
      statusLabel: null,
      openable: false,
      /**
       * ★ 同时用作主按钮的 `title` **与元信息行里的可见提示** —— 不可点的行必须
       *   当场说明原因。只塞进 `title` 等于没人看得到：`disabled` 的主按钮读屏器
       *   直接跳过，鼠标事件也不派发（tooltip 不弹），那就是「看起来不能用，
       *   但不知道为什么」。
       */
      openHint: '要再读一遍，点右边的「重新阅读」',
      dim: true,
    };
  }

  /**
   * 未开始 / 在读：按钮 = 标记「弃读」。
   *
   * ★ 用户 2026-10-09 定的模型：这个按钮**不再**把书从阅读页拿掉，而是标记成「弃读」
   *   —— 书仍留在阅读页的「弃读」筛下面，随时能找回来。原来那个「一点就消失回 2634
   *   本里」的行为，用户的原话是「书籍很多就很难找到」。
   * ★ 文案也是交互承诺：`title` 必须说清「点下去会发生什么」，尤其这一态 ——
   *   它是**弃读**，不是移出；而且恢复**不再靠点行**（点行没反应），必须走右边那个
   *   「+ 阅读」。0.9.3 时这里还写着「点开就能恢复」，那句话现在**是假的**。
   */
  return {
    badgeText,
    badgeState: name,
    actions: [{
      kind: 'drop',
      text: '弃读',
      title: '标记「弃读」—— 书仍留在阅读页的「弃读」筛下面，随时能用「+ 阅读」恢复',
      label: `把《${title}》标记为「弃读」`,
    }],
    statusLabel: null,
    openable: true,
    openHint: '',
    dim: false,
  };
}

/** 状态排序权重，供「按状态排」用。 */
export function stateRank(state) {
  return STATE_ORDER[state] ?? STATE_ORDER.unread;
}

/**
 * 按书名 / 作者串 / 丛书名搜索。
 *
 * 三处都匹配是刻意的：用户记得的可能是书名，也可能是丛书名（「文化生活译丛」）。
 * 大小写不敏感，两侧都 trim（用户粘贴带空格是常态）。
 */
export function matchesQuery(book, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return true;
  const haystack = `${book.title}\n${book.filename}\n${book.series}`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * 过滤 + 排序。
 *
 * @param books - 规范化后的书条目数组。
 * @param options.query - 搜索词。
 * @param options.ext - 只看某个扩展名（空 = 全部）。
 * @param options.state - 只看某个阅读状态（空 = 全部）。
 * @param options.inReading - 只看「阅读」页里的书（已加入）；书架页传 false。
 * @param options.states - 状态表 `{ id: state }`。
 * @param options.sort - `title` | `size` | `year` | `state` | `recent`。
 * @returns 新的数组（不改入参）。
 */
export function filterBooks(books, options = {}) {
  const { query = '', ext = '', state = '', inReading = false, states = {}, sort = 'title', listId = '', dir = '' } = options;
  /**
   * `state` 同时接受**字符串**与**字符串数组**，以及「不过滤」的三种写法
   * （`''` / `null` / `undefined`）。
   *
   * ★ 数组是给「分组筛」用的：阅读页的「在读」= `['unread','reading']`
   *   （见 `READING_STATE_FILTERS`）。只认字符串时，分组筛只能由调用方先筛一遍
   *   —— 那就是把判据复制进界面，两处迟早漂移，而且漂移的方向恒是「界面上写着
   *   在读、列表里少了几本」。
   *
   * ★ `null` 必须与 `''` 一样算「不过滤」：`READING_STATE_FILTERS` 里「全部」那一组
   *   的 `states` 就是 `null`。**这条是本项目实测踩到的** —— 解构默认值 `state = ''`
   *   只在 `undefined` 时生效，显式的 `null` 会一路走到 `[null]`，于是「全部」筛出
   *   **0 本**（第一次跑探针时打出来的就是这个）。
   *
   * ★ 空数组 `[]` 与它们**不是一回事**：那是「一个状态都不要」，筛出 0 本。
   *   把「没选筛选」误写成「筛空」时，症状与上面那条一模一样，所以两者分开表达。
   */
  const wanted = (state === '' || state === null || state === undefined)
    ? null
    : (Array.isArray(state) ? state : [state]);
  const rows = books.filter((book) => {
    if (!matchesQuery(book, query)) return false;
    if (ext !== '' && book.ext !== ext) return false;
    if (inReading && !isAdded(states, book.id)) return false;
    if (wanted !== null && !wanted.includes(stateOf(states, book.id).state)) return false;
    /**
     * 来源 / 分类两维（2026-10-23）。
     *
     * ★ 为什么 `dir` 也要在这里判、而不是像 0.9.x 那样由调用方 `filter()` 一遍：
     *   `topDir` 是**相对该源**的第一层子目录（见 `book-source.js` 的 `topDirOf`），
     *   所以「系列丛书全套」在不同源下是**两个不同的集合** —— 只按 `topDir` 筛会把
     *   网盘的 1419 本和本地的 2 本混进同一个结果。来源与分类必须**成对**判，
     *   而「成对」这件事写两处必然漂移（一处判源、一处判目录时，界面上会显示
     *   「本地 · NPIE_Book」却列出网盘的书）。
     *
     * ★ 空串 = 不过滤。`listId` 为空时**不**把没有 `listId` 的书排除掉 ——
     *   老数据 / 外部书单可能没有戳，而「没选来源」本来就该看到全部。
     */
    if (listId !== '' && book.listId !== listId) return false;
    if (dir !== '' && book.topDir !== dir) return false;
    return true;
  });
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const compare = {
    title: (a, b) => collator.compare(a.title, b.title),
    size: (a, b) => b.size - a.size,
    year: (a, b) => (b.year || 0) - (a.year || 0) || collator.compare(a.title, b.title),
    state: (a, b) => stateRank(stateOf(states, a.id).state) - stateRank(stateOf(states, b.id).state)
      || collator.compare(a.title, b.title),
    // 最近在读：按 `at` 倒序，从没读过的排最后。
    recent: (a, b) => stateOf(states, b.id).at - stateOf(states, a.id).at || collator.compare(a.title, b.title),
  }[sort] ?? ((a, b) => collator.compare(a.title, b.title));
  return rows.sort(compare);
}

/** 按某个维度分组（用于书架的侧栏）。返回 `[{ key, label, count }]`，按条目数倒序。 */
export function groupBooks(books, dimension) {
  const field = { topDir: 'topDir', series: 'series', ext: 'ext', year: 'year' }[dimension];
  if (field === undefined) return [];
  const buckets = new Map();
  for (const book of books) {
    const raw = book[field];
    const key = raw === '' || raw === 0 ? '' : String(raw);
    if (key === '') continue;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

// ---------------------------------------------------------------------------
// 来源（这本书来自哪份书单）
// ---------------------------------------------------------------------------

/**
 * 来源类型 → 界面上那个前缀字。
 *
 * ★ 只有**四种**，因为 `bookSources` 只可能产出这四种：`local` / `pan` 是用户配的两个
 *   入口，`external` 是「外部书单」（那份只读的 books.json），`legacy` 是 0.7.x 那份
 *   合并书单。写第5种之前先问一句「它真的有独立的取字节通道吗」—— 没有就只是命名差异。
 */
export const SOURCE_KIND_LABELS = { local: '本地', pan: '网盘', external: '外部', legacy: '旧版' };

/**
 * 一本书的来源标签：`{ text, kind, name }`，没有来源信息时返回 `null`。
 *
 * ★ 文字由**类型 + 书单名**拼成（`网盘 · E书拾取`），不是只写类型 —— 用户可能有
 *   三个本地目录，只写「本地」等于什么都没说（用户 2026-10-23 报的就是这个：
 *   「分不清楚哪个是本地目录下的电子书，哪个是百度网盘的电子书」）。
 * ★ 名字本身已经带类型前缀时不重复（`外部书单` + `外部` 不该变成 `外部 · 外部书单`）。
 */
export function sourceLabelOf(book) {
  const kind = String(book?.listKind ?? '') || String(book?.source ?? '');
  const kindLabel = SOURCE_KIND_LABELS[kind] ?? '';
  const name = String(book?.listName ?? '').trim();
  if (name === '' && kindLabel === '') return null;
  let text = name === '' ? kindLabel : name;
  if (kindLabel !== '' && name !== '' && !name.startsWith(kindLabel)) text = `${kindLabel} · ${name}`;
  return { text, kind: kind === '' ? 'other' : kind, name };
}

/** 筛选值里的分隔符。用 `\u0000` 而不是 `|`：书单名里出现竖线的概率不为零。 */
const SCOPE_SEP = '\u0000';

/** 「来源 + 分类」拼成一个 `<select>` 的值。 */
export function scopeValue(listId, dir = '') {
  const id = String(listId ?? '');
  if (id === '') return '';
  const folder = String(dir ?? '');
  return folder === '' ? id : `${id}${SCOPE_SEP}${folder}`;
}

/** 反过来：把 `<select>` 的值拆成 `{ listId, dir }`。空串 = 两者都不过滤。 */
export function parseScope(value) {
  const text = String(value ?? '');
  if (text === '') return { listId: '', dir: '' };
  const [listId = '', dir = ''] = text.split(SCOPE_SEP);
  return { listId, dir };
}

/**
 * 给「来源 ▸ 分类」那个下拉准备选项数据：按来源分组、组内按分类（`topDir`）分组。
 *
 * ★ 为什么来源与分类**在同一个下拉里**、而不是并列两个：侧栏第二行是
 *   `结果行（flex:1）│ 排序（按内容定宽）`，320px 下再加第三个控件会把结果行挤到
 *   两行 —— 而「结果行必须单行」是 `scripts/check-library-sidebar-layout.mjs`
 *   判据 ⑬ 钉着的（真 Chrome 量出来的）。合在一个下拉里既不加控件，又顺带
 *   表达了「分类是相对某个源的」这层语义（`topDir` 本来就相对该源）。
 *
 * ★ 返回**嵌套**结构而不是拍平的选项数组：拍平属于渲染，写在这里会让「深度用几个
 *   全角空格」这种排版细节变成判据的一部分（而测试只想答「选哪一项筛出哪几本」）。
 * ★ 排序：来源按本数倒序（谁大谁是主库），组内分类同规则；分类为空的（直接放在源根下
 *   的书）不进 `dirs`，它们由「该源 - 全部」那一项覆盖。
 */
export function bookScopes(books) {
  const groups = new Map();
  for (const book of books ?? []) {
    const id = String(book?.listId ?? '');
    if (id === '') continue;
    const group = groups.get(id) ?? {
      id,
      label: sourceLabelOf(book)?.text ?? id,
      kind: String(book?.listKind ?? '') || String(book?.source ?? ''),
      total: 0,
      dirs: new Map(),
    };
    group.total += 1;
    const dir = String(book?.topDir ?? '');
    if (dir !== '') group.dirs.set(dir, (group.dirs.get(dir) ?? 0) + 1);
    groups.set(id, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .map((group) => ({
      id: group.id,
      label: group.label,
      kind: group.kind,
      total: group.total,
      dirs: [...group.dirs.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'zh-Hans-CN')),
    }));
}

/**
 * 有几个来源。
 *
 * ★ 界面上用它决定**行内要不要显示来源徽章**：只有一条源时，每行都挂同一个徽章
 *   等于给 2634 行加噪声（这正是 `bookRowView` 不给「未读」显示徽章的同一个理由）。
 */
export function countSources(books) {
  const ids = new Set();
  for (const book of books ?? []) {
    const id = String(book?.listId ?? '');
    if (id !== '') ids.add(id);
  }
  return ids.size;
}

/**
 * 按**书源**把书分成几堆：`[{ kind, label, total, bytes }]`，书多的排在前面。
 *
 * 欢迎页那行统计要说的是「我的书都在哪」，那是**来源**维度 —— 与 `libraryStats`
 * 的**状态**维度（已在阅读 / 可阅读）正交。原来只报状态，用户配了网盘又配了本地
 * 目录时，那行字里一个字的来源信息都没有。
 *
 * ★ 按 `kind` 聚合，不按书单名：一条源 = 一份书单，用户可能配了六七个目录，
 *   逐个列会把那行 chips 撑成三行；同类型下的明细在书架页的「来源」筛选里本来
 *   就给得到（`bookScopes` 已经把每个书单的书数算好了）。
 * ★ 标签用短的（本地 / 网盘），不用设置页那套（本地目录 / 百度网盘）：这行是
 *   10px 的小字，「本地目录」四个字会把后面的「本数 · 体积」挤到换行。
 * ★ `kind` 的取法与 `sourceLabelOf` 一致（先 `listKind` 后 `source`）—— 两处判据
 *   必须同源，否则同一本书在书行上写「网盘」、在统计里算进「其他」。
 */
export function sourceTotals(books) {
  const groups = new Map();
  for (const book of books ?? []) {
    const kind = String(book?.listKind ?? '') || String(book?.source ?? '');
    const key = kind === '' ? 'other' : kind;
    const group = groups.get(key)
      ?? { kind: key, label: SOURCE_KIND_LABELS[key] ?? '其他', total: 0, bytes: 0 };
    group.total += 1;
    // `size` 可能是 `undefined`（外部书单缺字段），`+=` 会立刻把整堆体积污染成 NaN。
    group.bytes += Number(book?.size) || 0;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

/**
 * 书架的统计条：总数、已加入「阅读」数、各状态数、可渲染数、总体积。
 *
 * ★ `total` 与 `byState` 都是**对传进来的这批书**算的 —— 传全量书单就是书架页要的
 *   数字，传 `addedBooks(...)` 就是阅读页要的数字（各状态数只在阅读页里有含义：
 *   「2634 本里 5 本在读」不是用户想看的，「我加进来的 9 本里 5 本在读」才是）。
 *   所以这里**不加** `onlyAdded` 之类的开关：两个页面各传各的集合，算术只有一份。
 */
export function libraryStats(books, states = {}) {
  const byState = Object.fromEntries(BOOK_STATES.map((state) => [state, 0]));
  let bytes = 0;
  let renderable = 0;
  let added = 0;
  for (const book of books) {
    const state = stateOf(states, book.id);
    byState[state.state] += 1;
    if (state.added) added += 1;
    bytes += book.size;
    if (book.renderable) renderable += 1;
  }
  return { total: books.length, added, byState, bytes, renderable };
}

/**
 * 把一份外部阅读状态（ebook-sorter 的 `reading.json` 形状）并进本插件的状态表。
 *
 * **只导入本插件里还没有的条目**：用户可能已经在那边读了 125 页，这边不该从第 1 页
 * 重来；但反过来，用户在这边读过的进度也不能被那边的旧进度盖掉。
 *
 * @param states - 本插件的状态表（会被读，不被改）。
 * @param external - 外部状态表 `{ id: { state, page, at, pages } }`。
 * @returns 合并后的**新**对象，以及导入了多少条。
 */
export function mergeImportedStates(states, external) {
  const merged = { ...states };
  let imported = 0;
  if (!external || typeof external !== 'object') return { states: merged, imported };
  for (const [id, raw] of Object.entries(external)) {
    if (!isBookId(id)) continue;
    if (merged[id] !== undefined) continue;
    const state = normalizeState(raw);
    if (state.state === 'unread' && state.page === 0 && state.at === 0) continue;
    // 导进来的一律算「已加入阅读」：那边有记录的书本来就是用户在读的书，
    // 让它们进了书架却不在阅读页里，等于用户一升上来就发现「我在读的书没了」。
    merged[id] = { ...state, added: true };
    imported += 1;
  }
  return { states: merged, imported };
}

/**
 * 阅读进度的百分比（0–100），拿不到页数时返回 null（**不返回 0** ——
 * 「不知道」与「0%」在界面上必须能区分，否则没解析出页数的书会一直显示「0%」）。
 */
export function progressPercent(state) {
  if (!state || !Number.isInteger(state.pages) || state.pages <= 0) return null;
  if (!Number.isInteger(state.page) || state.page <= 0) return 0;
  return Math.min(100, Math.round((state.page / state.pages) * 100));
}
