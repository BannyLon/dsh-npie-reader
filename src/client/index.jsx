/**
 * dsh-npie-reader client half: mounts the `rss` Remote namespace and registers
 * the reading panel (sidebar icon + `main` page). Built into a single
 * `window.__ModuleLoader__` bundle; react / react-dom stay external.
 */
import { NativeConversation } from './NativeConversation.jsx';
import { nativeChatBridge } from './native-chat.js';
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
    label: '阅读器',
  }, ReaderIcon));
}
