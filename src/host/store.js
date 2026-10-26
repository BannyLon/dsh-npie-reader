/**
 * Durable plugin data: one JSON document under the harness home's storages
 * directory, written atomically with a short debounce. Read state, favorites,
 * AI-generated versions, and the recent-article cache live here — vault-free,
 * like the Obsidian plugin's own data.json.
 */
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { guardFs } from './disk-errors.js';

/** `$DSH_HOME` 环境变量名，与宿主 dsh-home-paths 一致。 */
const DSH_HOME_ENV = 'DSH_HOME';

function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 解析 Harness 主目录：显式配置 > `$DSH_HOME`（非空白）> `~/.dsh`，再取绝对路径。
 * 语义照抄宿主 `@deepseek-ai/dsh-home-paths`。不 import 它：外部 link 插件的
 * Host 半区在解析链上拿不到宿主内部包（见 typert-lite.js 顶部说明）。
 */
export function resolveDshHome(configured) {
  const fromEnv = process.env[DSH_HOME_ENV];
  const chosen = configured ?? (typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh'));
  return resolve(expandHomePath(chosen));
}

// 按需读过的文章正文缓存。实测每篇正文约 12 KB ⇒ 上限 400 时最坏约 5 MB，
// 而 flush() 是全量重写，再往上调会明显拖慢每次去抖保存。
const MAX_ARTICLE_BODIES = 400;
const MAX_READ_IDS = 5_000;

export function dataFilePath() {
  return join(resolveDshHome(), 'storages', 'dsh-npie-reader', 'data.json');
}

/**
 * 本插件的数据目录（`<dshHome>/storages/dsh-npie-reader`）。
 *
 * ★ 有意**不用**插件的安装目录（`…/dsh-npie-reader/data/`）：插件升级、重装、
 *   或者以只读方式安装时，安装目录会被覆盖或根本写不进去。这里跟着 `data.json`
 *   走 —— 插件本来就在这个目录读写，升级不会碰它。
 */
export function pluginDataDir() {
  return join(resolveDshHome(), 'storages', 'dsh-npie-reader');
}

/**
 * 插件**自己生成**的书单。
 *
 * ★ 生成永远只写这个目录，**绝不写用户指定的 `libraryPath`**：用户完全可能把
 *   `libraryPath` 指向自己那份整理了很久的书单（ebook-sorter 的 `data/books.json`），
 *   一路点下去把它覆盖掉是不可逆的。
 *
 * 布局（0.8.0 起，一条书源 = 一份书单）：
 *
 * ```
 * <数据目录>/
 *   lists.json          清单：每份书单的 id / 名字 / 源路径 / 本数 / 生成时间
 *   lists/
 *     s3f2a…9c1.json    一份书单的全部书条目（600 权限）
 *     s8b41…07e.json
 * ```
 *
 * ★ 为什么清单要单独一个文件，而不是每次去 `stat` 那 N 份书单：界面一打开就要
 *   「每份有多少本、什么时候生成的」，而书单本身可以有几 MB —— 为了拿两个数字
 *   去解析 N 份大 JSON，在网盘目录那一侧是几秒级的等待。
 */
export function bookListsDir() {
  return join(pluginDataDir(), 'lists');
}

/** 书单清单（元信息）。见 `bookListsDir` 的说明。 */
export function bookListsIndexPath() {
  return join(pluginDataDir(), 'lists.json');
}

/** 旧的那份「全部源合并成一份」的书单。只用于升级兜底，不再生成。 */
export function libraryIndexPath() {
  return join(pluginDataDir(), 'books.json');
}

/** 网盘应用凭证（AppKey / SecretKey）与授权 token。两者都按 600 权限写。 */
export function panAppPath() {
  return join(pluginDataDir(), 'pan-app.json');
}

export function panTokenPath() {
  return join(pluginDataDir(), 'pan-token.json');
}

/** 网盘块的落盘缓存目录（`pan.js` 写、也只它读）。
 *  放数据目录的原因：和 data.json / lists/ 同进退 —— 用户整个删掉数据目录，
 *  缓存也该一起消失，不会在别处留一份「看起来像数据」的副本。 */
export function panCacheDir() {
  return join(pluginDataDir(), 'pan-cache');
}

/** 0.7.1 及以前用的机器级凭证：由**另一个项目**（`ebook-sorter`）生成。 */
export function legacyPanAppPath() {
  return join(homedir(), '.baidu-pan-app.json');
}

export function legacyPanTokenPath() {
  return join(homedir(), '.baidu-pan-token.json');
}

/**
 * ★ 一次性把旧位置的网盘凭证**搬**进插件数据目录。
 *
 * 为什么是「搬一次」而不是「回落读取」：0.7.2 的决定是**凭证由插件自己管**，
 * 回落读取等于让别人装的插件读这台机器上的凭证 —— 那正是要断开的那条路。
 * 但直接断开的后果是老用户升级后**所有网盘书一次性打不开**，而症状只是前端的
 * 一句 `Failed to fetch`（见 `library-routes.js` 里那条「先发头」的注释），
 * 用户根本看不出是凭证没了。凭证文件其实就在这台机器上，所以搬一次最省事。
 *
 * 三条硬约束：
 * 1. **只在目标不存在时复制**（`COPYFILE_EXCL`）—— 绝不覆盖用户在插件里新授权的凭证；
 * 2. **源文件保留** —— 用户可能还在用那个项目，删了等于毁掉别人的数据；
 * 3. **失败不抛错** —— 凭证缺失的后果只是「网盘书读不了」，不该让整个服务起不来。
 *
 * @param options.log - 日志回调。
 * @param options.legacy - 覆盖旧位置（`{ app, token }` 两个绝对路径）。测试用；
 *   生产走默认的 `~/.baidu-pan-*.json`。
 * @returns 实际迁移了哪几样（只用于日志与测试断言）。
 */
export async function migrateLegacyPanCredentials({ log = () => {}, legacy = {} } = {}) {
  const pairs = [
    { from: legacy.app ?? legacyPanAppPath(), to: panAppPath(), what: '应用凭证' },
    { from: legacy.token ?? legacyPanTokenPath(), to: panTokenPath(), what: '授权 token' },
  ];
  const moved = [];
  for (const { from, to, what } of pairs) {
    // 先看源在不在。不在就**什么都不做** —— 连目标目录都不建，
    // 这样「从没用过那个项目」的用户不会被凭空多出一个空目录。
    try {
      await access(from);
    } catch {
      continue;
    }
    try {
      // 目标目录由本函数自己保证：`store.load()` 通常会先建出来，但迁移不该
      // 依赖那个时序（测试与将来的调用方都可能先调它）。
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } catch (error) {
      // EEXIST = 插件已经有一份 ⇒ 正常跳过，不记日志（每次启动都会走到这儿）。
      if (error.code !== 'EEXIST') {
        log(`[书架] 迁移旧网盘凭证失败（${what}）：${error.message}`);
      }
      continue;
    }
    // 源文件本来就是 600，这里显式再来一次；失败不影响可用性。
    await chmod(to, 0o600).catch(() => {});
    moved.push(what);
  }
  if (moved.length > 0) {
    log(`[书架] 已把旧位置的网盘${moved.join('与')}迁移进插件数据目录（源文件保留）。`);
  }
  return moved;
}

function defaults() {
  return {
    version: 1,
    settings: {
      aiAssist: true,
      showImages: true,
      fullText: true,
    },
    subscriptions: [],
    // 用户自己的「探索目录」。内置目录是**只读默认值**：可以隐藏（`hidden` 里存 url），
    // 但不能改；想改就自己加一条（`sources`）。这样插件升级换掉内置目录时，
    // 用户自己加的东西不会被冲掉，而内置目录也能继续更新。
    //
    // `service.base` = 用户自建的「公众号转 RSS」服务地址（wewe-rss / Wechat2RSS 之类）。
    // 插件**不抓公众号**（做不到，见 README「边界」），只负责记住这个地址、检测它通不通、
    // 并把用户从服务里复制出来的 feed 地址订阅进来。
    catalog: { sources: [], hidden: [], service: { base: '' } },
    articles: {},
    favorites: {},
    read: {},
    ai: {},
    recent: [],
    companionContexts: {},
    // 书架：**本插件自己的**阅读进度。
    //
    // 为什么不直接写用户那份书单工具（ebook-sorter）的 `reading.json`：那是**别的项目**
    // 的文件，本插件对它只有读的份（用户级记忆里的红线：仓库外写操作先问再做）。所以
    // 进度存在这里，另外在首次载入时从那边**只读导入**一次历史进度（`importedFrom` 记下
    // 是从哪个索引文件导的，换索引就重新导一次）。
    library: { states: {}, importedFrom: '' },
  };
}

export class RssStore {
  constructor(logger) {
    this.logger = logger;
    this.path = dataFilePath();
    this.data = defaults();
    this.saveTimer = undefined;
    this.saving = Promise.resolve();
    /**
     * 数据文件读不出来（坏 JSON / 读不动）时置位：**此后 `flush()` 一律拒绝写盘**。
     *
     * ★ 为什么这个标记是必需的，而不是「顺手加一个布尔」：
     *   `load()` 是在给 `this.data` 赋值**之前**抛的，所以抛完之后 `this.data` 还是
     *   构造函数里的 `defaults()`。而 `dispose()`（插件卸载时由 `ctx.effect` 的清理
     *   钩子调用）无条件走 `flush()` ⇒ **把用户那份坏文件覆盖成默认值**。用户所有
     *   订阅、收藏、已读、译文、书架进度全丢，而且唯一还能抢救的原始文件也被抹掉。
     *   而 `load()` 的报错文案与 `README.md` 都写着「refusing to overwrite it /
     *   拒绝覆盖」—— 修之前，那句话是**假的**。
     */
    this.corrupt = false;
    /** 坏在哪（只用于日志与界面提示，不参与判定）。 */
    this.corruptReason = '';
    /** 取证副本的路径（没能复制时是 undefined）。 */
    this.quarantinedTo = undefined;
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...defaults(), ...parsed };
      this.data.settings = { ...defaults().settings, ...(parsed.settings ?? {}) };
      // 嵌套对象要单独归一：`{...defaults(), ...parsed}` 只会整块覆盖，
      // 老版本数据里没有 `catalog` 时能靠默认值兜住，但**只写了一半**的 catalog
      // （比如只有 sources）会让 `hidden` 变成 undefined，后面 `.includes` 直接抛。
      this.data.catalog = {
        sources: Array.isArray(parsed.catalog?.sources) ? parsed.catalog.sources : [],
        hidden: Array.isArray(parsed.catalog?.hidden) ? parsed.catalog.hidden : [],
        // `service` 是后加的字段：老数据里没有它，而 `{...defaults(), ...parsed}` 是整块覆盖，
        // 不单独归一的话 `this.data.catalog.service` 会是 undefined ⇒ `.base` 直接抛。
        service: { base: typeof parsed.catalog?.service?.base === 'string' ? parsed.catalog.service.base : '' },
      };
      // 同上：`library` 是后加的字段，且 `states` 是嵌套对象 —— 不单独归一的话
      // 老数据升上来会得到 `this.data.library === undefined`，写进度时直接抛。
      this.data.library = {
        states: parsed.library?.states !== null && typeof parsed.library?.states === 'object' && !Array.isArray(parsed.library.states)
          ? parsed.library.states
          : {},
        importedFrom: typeof parsed.library?.importedFrom === 'string' ? parsed.library.importedFrom : '',
      };
      // 读成功就清掉上一次失败留下的标记：`load()` 可以被调多次（测试、以及将来的
      // 「用户手工修好文件后重载」），不清的话会一直拒绝写盘。
      this.corrupt = false;
      this.corruptReason = '';
      this.quarantinedTo = undefined;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.corrupt = true;
        this.corruptReason = String(error?.message ?? error);
        // 先留一份**取证副本**再抛。
        // ★ 为什么是「复制」而不是「改名挪走」：改名会让 `data.json` 消失，下一次
        //   启动就变成 ENOENT ⇒ 走「全新用户」分支 ⇒ 之后一切照常写入，用户再也
        //   看不到出过事、也不知道自己那份数据还在不在。复制让原文件**逐字节留在
        //   原地**，用户能自己打开检查、自己修。
        this.quarantinedTo = await quarantineCopy(this.path).catch(() => undefined);
        throw new Error('dsh-npie-reader: cannot read saved data; refusing to overwrite it', { cause: error });
      }
      this.data = defaults();
    }
  }

  /** Schedule a debounced atomic save (500 ms). */
  touch() {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch(() => {});
    }, 500);
  }

  /**
   * Write the document through a temp file + rename, serialized.
   *
   * ★ 读不出来时**一律不写**（见 `this.corrupt`）。这条闸门必须在这里、而不是在
   *   调用方：`flush()` 有三个入口（去抖 `touch()`、`dispose()`、`reset()`），
   *   把闸门放在调用方等于要维护三份判定 —— 漏掉任何一个，用户的数据就没了。
   *   放在这里，`dispose()` 天然安全：它照样被调用、照样什么都不做。
   */
  async flush() {
    if (this.corrupt) {
      // 不抛：`touch()` 那条路是 `void …catch(()=>{})`，抛了也没人看得见；
      // 而 `dispose()` 在插件卸载路径上，抛出去只会变成一条噪音日志。
      this.logger?.warn?.(
        'dsh-npie-reader: 数据文件读不出来（%s），本次**不写盘**，原文件保持原样。',
        this.corruptReason || 'unknown',
      );
      return;
    }
    this.saving = this.saving.catch(() => {}).then(async () => {
      try {
        // ★ 磁盘满 / 没权限时抛的是 `ENOSPC: no space left on device, write`。
        //   过一遍 `guardFs` 之后，日志和（经路由层转发到界面的）文案都是人话。
        await guardFs(async () => {
          await mkdir(dirname(this.path), { recursive: true });
          const temp = `${this.path}.${process.pid}.tmp`;
          await writeFile(temp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
          await rename(temp, this.path);
        }, '阅读进度和设置');
      } catch (error) {
        this.logger?.warn?.('dsh-npie-reader: 保存数据失败：%s', error?.message ?? String(error));
        throw error;
      }
    });
    return this.saving;
  }

  async dispose() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.flush();
  }

  // ---- read / favorites -------------------------------------------------

  markRead(keys, read) {
    for (const key of keys) {
      if (read) this.data.read[key] = Date.now();
      else delete this.data.read[key];
    }
    this.trimRead();
    this.touch();
  }

  trimRead() {
    const keys = Object.keys(this.data.read);
    if (keys.length <= MAX_READ_IDS) return;
    keys.sort((a, b) => this.data.read[a] - this.data.read[b]);
    for (const key of keys.slice(0, keys.length - MAX_READ_IDS)) delete this.data.read[key];
  }

  setFavorite(key, favorite, article) {
    if (favorite) this.data.favorites[key] = { savedAt: Date.now() };
    else delete this.data.favorites[key];
    this.touch();
  }

  isFavorite(key) {
    return this.data.favorites[key] !== undefined;
  }

  // ---- article cache ----------------------------------------------------

  putArticle(article) {
    const existing = this.data.articles[article.key];
    this.data.articles[article.key] = { ...article, fetchedAt: Date.now() };
    const recentIndex = this.data.recent.indexOf(article.key);
    if (recentIndex !== -1) this.data.recent.splice(recentIndex, 1);
    this.data.recent.push(article.key);
    this.trimArticles();
    this.touch();
    return existing;
  }

  getArticle(key) {
    return this.data.articles[key];
  }

  trimArticles() {
    const pinned = new Set([...Object.keys(this.data.favorites), ...this.data.recent.slice(-40)]);
    const keys = Object.keys(this.data.articles);
    if (keys.length <= MAX_ARTICLE_BODIES) return;
    const byFetch = keys.sort((a, b) => (this.data.articles[b].fetchedAt ?? 0) - (this.data.articles[a].fetchedAt ?? 0));
    for (const key of byFetch.slice(MAX_ARTICLE_BODIES)) {
      if (pinned.has(key)) continue;
      delete this.data.articles[key];
    }
    this.data.recent = this.data.recent.filter((key) => this.data.articles[key] !== undefined || pinned.has(key));
    this.touch();
  }

  // ---- AI versions ------------------------------------------------------

  putAiVersion(key, kind, version) {
    const record = this.data.ai[key] ?? {};
    record[kind] = version;
    this.data.ai[key] = record;
    this.touch();
  }

  getAiVersion(key, kind) {
    return this.data.ai[key]?.[kind];
  }

  // ---- subscriptions ----------------------------------------------------

  addSubscription(sub) {
    this.data.subscriptions.push(sub);
    this.touch();
  }

  removeSubscription(id) {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((sub) => sub.id !== id);
    this.touch();
    return this.data.subscriptions.length !== before;
  }

  findSubscriptionByUrl(url) {
    const normalized = url.replace(/\/+$/, '');
    return this.data.subscriptions.find((sub) => sub.url.replace(/\/+$/, '') === normalized);
  }

  subscriptionById(id) {
    return this.data.subscriptions.find((sub) => sub.id === id);
  }

  /** Find a personal-feed entry by its article key across all subscriptions. */
  findFeedEntry(key) {
    for (const sub of this.data.subscriptions) {
      const hit = (sub.entries ?? []).find((entry) => entry.key === key);
      if (hit) return hit;
    }
    return undefined;
  }

  // ---- catalog（用户自己的探索目录）--------------------------------------

  /** 内置目录是只读默认值：可隐藏、不可改；想改就自己加一条。 */
  listCatalog() {
    return { sources: this.data.catalog.sources, hidden: this.data.catalog.hidden, service: this.data.catalog.service };
  }

  /** 记住「转 RSS 服务」的基地址（空串 = 没配）。 */
  setCatalogService(base) {
    this.data.catalog.service = { base: typeof base === 'string' ? base : '' };
    this.touch();
    return this.data.catalog.service;
  }

  addCatalogSource(entry) {
    this.data.catalog.sources.push(entry);
    this.touch();
  }

  removeCatalogSource(id) {
    const before = this.data.catalog.sources.length;
    this.data.catalog.sources = this.data.catalog.sources.filter((item) => item.id !== id);
    this.touch();
    return this.data.catalog.sources.length !== before;
  }

  catalogSourceById(id) {
    return this.data.catalog.sources.find((item) => item.id === id);
  }

  /** 隐藏一条内置目录项（按 url 记，内置项没有稳定 id）。 */
  hideCatalogUrl(url) {
    if (!this.data.catalog.hidden.includes(url)) {
      this.data.catalog.hidden.push(url);
      this.touch();
    }
  }

  unhideCatalogUrl(url) {
    const before = this.data.catalog.hidden.length;
    this.data.catalog.hidden = this.data.catalog.hidden.filter((item) => item !== url);
    if (this.data.catalog.hidden.length !== before) this.touch();
  }

  /**
   * 「重来一遍」—— 全插件里**唯一**有意覆盖已有数据的路径。
   *
   * ★ 覆盖之前必须先留一份备份：这是不可逆操作，而用户点它的动机往往是「数据乱了」
   *   —— 恰恰是最不该把原文件丢掉的时候。备份失败也照常继续（备份是加分项，
   *   不是闸门），但会把失败写进日志。
   * ★ 顺带清掉 `corrupt`：用户要的就是「别管那份坏文件了」，不清的话 `flush()` 会
   *   拒绝写，`reset()` 变成一个静默无效的空操作 —— 那比不给这个按钮更糟。
   */
  async reset() {
    const backup = await backupBeforeOverwrite(this.path).catch((error) => {
      this.logger?.warn?.('dsh-npie-reader: 重置前备份失败（继续）：%s', String(error));
      return undefined;
    });
    if (backup !== undefined) {
      this.logger?.info?.(`dsh-npie-reader: 重置前已把原数据备份到 ${backup}`);
    }
    this.data = defaults();
    this.corrupt = false;
    this.corruptReason = '';
    this.quarantinedTo = undefined;
    await this.flush();
    return backup;
  }
}

/** 备份文件名里用的时间戳：`2026-10-09T16-40-12`（冒号在部分文件系统上不合法）。 */
function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

/**
 * 读不出来时留一份**取证副本** `data.json.corrupt-<时间戳>`。
 *
 * ★ 幂等：只在目录里**还没有** `.corrupt-*` 兄弟时复制。坏文件会一直坏着（我们拒绝
 *   覆盖），所以「每次启动都复制一份」等于往用户数据目录里灌垃圾。
 * ★ 失败**不抛**：调用方是 `load()` 的 catch，那里正在把原始错误往外传；这里再抛
 *   一个只会盖掉真正的病因（比如 EACCES 读不动，复制自然也读不动）。
 *
 * @returns 副本路径；没复制（已存在 / 复制失败）时 undefined。
 */
async function quarantineCopy(path) {
  const dir = dirname(path);
  const base = `${basename(path)}.corrupt-`;
  const entries = await readdir(dir);
  if (entries.some((name) => name.startsWith(base))) return undefined;
  const to = join(dir, `${base}${stamp()}`);
  await copyFile(path, to);
  return to;
}

/**
 * 覆盖之前留一份备份 `data.json.bak-<时间戳>`。
 *
 * 与 `quarantineCopy` 的区别是**不做幂等判断**：`reset()` 是用户主动按的，每次按
 * 都该有一份对应时刻的快照（上次 reset 之后用户可能又读了很多东西）。
 *
 * @returns 备份路径；源文件不存在时 undefined。
 */
async function backupBeforeOverwrite(path) {
  try {
    await access(path);
  } catch {
    return undefined;
  }
  const to = join(dirname(path), `${basename(path)}.bak-${stamp()}`);
  await copyFile(path, to);
  return to;
}

/** Remove the data file entirely (used by the reset-to-factory tool path). */
export async function deleteDataFile() {
  await rm(dataFilePath(), { force: true });
}

export { defaults as defaultData, MAX_ARTICLE_BODIES };
