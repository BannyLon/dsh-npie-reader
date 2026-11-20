/**
 * dsh-npie-reader client half: mounts the `rss` Remote namespace and registers
 * the reading panel (sidebar icon + `main` page). Built into a single
 * `window.__ModuleLoader__` bundle; react / react-dom stay external.
 */
import { NativeConversation } from './NativeConversation.jsx';
import { nativeChatBridge } from './native-chat.js';
import { BRAND_TITLE } from './brand.js';
import { ReaderIcon } from './ReaderPage.jsx';
import { ReaderPanel } from './ReaderBoundary.jsx';

const PLUGIN_ID = 'dsh-npie-reader';
export const PANEL_ID = 'npie-reader';

/** Duck-typed codec stub: the client never parses payloads, it forwards JSON. */
const codec = () => ({
  mode: 'strict',
  typeSymbol: `${PLUGIN_ID}#json`,
  create: () => ({ parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) }),
});

function method(method, params = true) {
  return {
    id: `${PLUGIN_ID}#rss/${method}`,
    service: 'rss',
    namespace: 'rss',
    method,
    invocation: { kind: 'direct' },
    ...(params ? { parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec() }] } : { parameters: [] }),
    result: { mode: 'src-json' },
    cancellation: { parameter: 'signal' },
  };
}

const TYPERT_REMOTE = {
  package: PLUGIN_ID,
  descriptors: [
    method('listChannels', false),
    method('listEntries'),
    method('searchArticles'),
    method('getArticle'),
    method('getTranscript'),
    method('getTranscriptTranslation'),
    method('translateTranscriptBatch'),
    /*
     * ★ `false` 不能省：`method()` 默认声明 1 个必填 `request`，而 `asrStatus()` 是唯一
     *   不需要任何业务参数的识别方法。写漏了运行时才炸，且只在用户点「本机识别」时炸：
     *   `client api: rss/asrStatus expected 1 business argument(s) plus an optional
     *   AbortSignal, got 0` —— 构建、启动、契约快照全是绿的。
     */
    method('asrStatus', false),
    method('prepareAsr'),
    method('startTranscription'),
    method('transcriptionStatus'),
    method('cancelTranscription'),
    /* 0.84.0：AI 导读（带时间戳）与平台链接解析。 */
    method('episodeDigest'),
    method('resolveSubscription'),
    /*
     * ★ `entryMeta` 一直是「宿主导出了、客户端没声明」的状态（0.60.0 补上）。
     *   症状是日记里那张「这条灵感记在哪篇文章下」的小卡片**永远显示不出来**：
     *   `DiaryApp` 调 `api.entryMeta()` 前先判 `typeof === "function"`，而 descriptor
     *   缺失时它确实不是函数 ⇒ 一路静默 return，不报错、不空白、只是不显示。
     *   这类「两半区各写一份清单」的漂移只能靠 `test/service.test.mjs` 里那条
     *   「客户端声明的集合 === 宿主导出的集合」抓住，所以顺手把那份快照也补齐。
     * ★ 上面这段注释里**不能出现单引号字符串**：那条测试是把 `descriptors: [` 到
     *   数组结尾之间所有单引号内容当方法名的，注释里写一个就会被算进清单。
     */
    method('entryMeta'),
    method('fetchFullText'),
    method('getVersionContent'),
    method('generateVersion'),
    method('refresh'),
    method('listSubscriptions', false),
    method('addSubscription'),
    method('removeSubscription'),
    method('updateSubscription'),
    method('backfillSubscription'),
    method('opmlPreview'),
    method('opmlImport'),
    method('opmlExport', false),
    method('listCatalog', false),
    method('addCatalogSource'),
    method('removeCatalogSource'),
    method('setCatalogHidden'),
    method('setCatalogService'),
    method('probeCatalogService'),
    method('setRead'),
    method('setFavorite'),
    method('setHidden'),
    method('getSettings', false),
    method('saveSettings'),
    method('saveAsrConfig'),
    method('listAiModels', false),
    method('aiModelInfo', false),
    ...['prepareChat', 'setReadingContext', 'setBookContext', 'setDiaryContext'].map(name => method(name)),
  ],
};

export const inject = ['slots', 'layout', 'remote'];

/**
 * Register the reader panel.
 * @param ctx - browser Cordis root with slots/layout/remote services.
 */
export async function apply(ctx) {
  try {
    await ctx.remote.$mount(TYPERT_REMOTE);
  } catch (error) {
    ctx.logger?.error?.('dsh-npie-reader: failed to mount the rss Remote namespace: %o', error);
    throw error;
  }

  // Mounting publishes the namespace; it does not grant this context access.
  // Wait in a child fiber so the provider can mount before its consumer starts.
  ctx.inject(['remote.rss'], (child) => registerReader(child));
}

function registerReader(ctx) {
  const call = async (name, ...args) => {
    const namespace = ctx.remote.rss;
    if (!namespace || typeof namespace[name] !== 'function') {
      throw new Error('阅读服务未就绪，请稍后重试');
    }
    const result = await namespace[name](...args);
    if (result.ok) return result.value;
    throw result.error;
  };

  const api = {
    ...nativeChatBridge(ctx),
    prepareChat: (params) => call('prepareChat', params),
    setReadingContext: (params) => call('setReadingContext', params),
    setBookContext: (params) => call('setBookContext', params),
    setDiaryContext: (params) => call('setDiaryContext', params),
    listChannels: () => call('listChannels'),
    listEntries: (params) => call('listEntries', params),
    searchArticles: (params) => call('searchArticles', params),
    getArticle: (key) => call('getArticle', { key }),
    /**
     * 单集字幕（P0）。`refresh` 是「忽略缓存重抓」—— 只由面板上的「重新获取」传 true。
     * 默认 false 时宿主可能仍会抓一次（本地没缓存才有意义），那属于首次获取。
     */
    getTranscript: (key, refresh) => call('getTranscript', { key, refresh: refresh === true }),
    /**
     * 字幕中文层：读缓存（不发模型）+ 翻一批（客户端循环驱动进度）。
     *
     * ★ `start` 是**段落下标**，不是秒数：宿主按段落切，客户端只知道第几段。
     *   传秒数会让两边各算一次「第 3 段从哪开始」，而这类漂移在界面上看不出来。
     */
    getTranscriptTranslation: (key) => call('getTranscriptTranslation', { key }),
    translateTranscriptBatch: (key, start, refresh) => call('translateTranscriptBatch',
      { key, start: Number(start) || 0, refresh: refresh === true }),
    /**
     * 本机识别（0.82.0）：能给一集做出字幕，而不只是「从订阅源抓」。
     *
     * ★ 五个方法分成两组，因为它们回答的是两个问题：
     *   `asrStatus` / `prepareAsr` 是「这台机器能不能识别」（全局，一份引擎与模型）；
     *   `startTranscription` / `transcriptionStatus` / `cancelTranscription` 是
     *   「这一集识别到哪了」（按集）。合成一个方法会让「换一集」时看不到进度。
     */
    asrStatus: () => call('asrStatus'),
    /**
     * 准备识别环境（0.84.0 起带 `engine`：`qwen` / `whisper` / `cloud`）。
     *
     * ★ 第二个参数不传时由宿主按设置与本机情况决定（`resolveAsrEngine`），
     *   客户端不需要知道「这台机器有 Ollama 还是有 ffmpeg」。
     */
    prepareAsr: (modelId, engine) => call('prepareAsr', { modelId, engine }),
    startTranscription: (key, modelId, engine) => call('startTranscription', { key, modelId, engine }),
    transcriptionStatus: (key) => call('transcriptionStatus', { key }),
    cancelTranscription: (key) => call('cancelTranscription', { key }),
    /**
     * AI 导读。第三参数 `generate` 决定「只读缓存」还是「真生成」：
     *   `api.episodeDigest(key, false, false)` → 读缓存（进面板时调，绝不花钱）
     *   `api.episodeDigest(key, true, true)`   → 重新生成（只有用户点按钮时才这样调）
     * ★ 不做成两个前端方法（`readDigest` / `episodeDigest`）：宿主只有一个方法，
     *   前端起两个名字会让「跨半区契约」出现一个查不到对应关系的一对多，
     *   而那条守卫正是为了防止这种漂移。
     */
    episodeDigest: (key, refresh, generate) => call('episodeDigest',
      { key, refresh: refresh === true, generate: generate === true }),
    /**
     * 平台链接 → 真 feed（只解析、不落盘）。界面在「添加」之前调它，把会订到
     * 哪个 feed 给用户看一眼；失败时返回 `{ error, code }` 而不是抛（见 service）。
     */
    resolveSubscription: (url) => call('resolveSubscription', { url }),
    fetchFullText: (key) => call('fetchFullText', { key }),
    generateVersion: (key, kind, force) => call('generateVersion', { key, kind, force }),
    refresh: (channel) => call('refresh', { channel }),
    addSubscription: (params) => call('addSubscription', params),
    removeSubscription: (id) => call('removeSubscription', { id }),
    listSubscriptions: () => call('listSubscriptions'),
    updateSubscription: (params) => call('updateSubscription', params),
    backfillSubscription: (params) => call('backfillSubscription', params),
    opmlPreview: (params) => call('opmlPreview', params),
    opmlImport: (xml, urls) => call('opmlImport', { xml, urls }),
    opmlExport: () => call('opmlExport'),
    listCatalog: () => call('listCatalog'),
    addCatalogSource: (params) => call('addCatalogSource', params),
    removeCatalogSource: (id) => call('removeCatalogSource', { id }),
    setCatalogHidden: (url, hidden) => call('setCatalogHidden', { url, hidden }),
    setCatalogService: (base) => call('setCatalogService', { base }),
    probeCatalogService: (base) => call('probeCatalogService', { base }),
    setRead: (keys, read) => call('setRead', { keys, read }),
    setFavorite: (key, favorite) => call('setFavorite', { key, favorite }),
    setHidden: (key, hidden) => call('setHidden', { key, hidden }),
    getSettings: () => call('getSettings'),
    saveSettings: (patch) => call('saveSettings', { patch }),
    /** 云端识别的 Key 单独写（见宿主的 `saveAsrConfig`：它不回显 Key）。 */
    saveAsrConfig: (apiKey) => call('saveAsrConfig', { apiKey }),
    listAiModels: () => call('listAiModels'),
    aiModelInfo: () => call('aiModelInfo'),
  };

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    children: { 'npie-reader.chat': { kind: 'single', scope: 'session' } },
    inject: () => ({ api }),
  }, ReaderPanel));
  ctx.slots.inject('npie-reader.chat', () => ctx.slots.register({ name: 'npie-reader.chat' }, NativeConversation));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 15,
    // 侧栏那一行写**中英名**：宿主给面板标题留了省略号（`.panelTitle` 是
    // `text-overflow: ellipsis`），260px 宽的侧栏放得下「澄境 | Limina」。
    // 不写成「阅读器」——「阅读器」是这一屏的功能，不是这个插件的名字。
    label: BRAND_TITLE,
  }, ReaderIcon));
}
