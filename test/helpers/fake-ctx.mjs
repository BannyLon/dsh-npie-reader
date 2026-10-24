/**
 * 假 Cordis ctx + 假 fetch：让 RssService 能在没有 DSH 宿主的情况下跑起来。
 *
 * 只实现 service.js / ai.js / tools.js 真正会碰到的那几面：
 *   logger / tools.register / effect / inject(['systemPrompt'|'webServer']) / llm.stream /
 *   agentDefaultModel.currentSelection / webServer.register / reflect.get
 *
 * `inject` 的语义照抄 Cordis：回调收到一个**子作用域**，子作用域上才有被注入的服务。
 * 如果实现里把 `scope.systemPrompt` 写成 `ctx.systemPrompt`，这里会立刻暴露成
 * TypeError 而不是安静地拿到 undefined。
 */

/** 一次 `ctx.inject(names, cb)` 调用的记录，供测试断言「确实声明了依赖」。 */
export function createFakeContext(options = {}) {
  const {
    fetchPlan = [], fetchFallback, llmChunks = [],
    modelSelection = { provider: 'test-provider', model: 'test-model' },
    modelCatalog = { providers: [{ id: 'test-provider', name: 'Test Provider', models: [{ id: 'test-model', name: 'Test Model' }] }] },
  } = options;

  const state = {
    tools: [],
    systemPromptContributions: [],
    effects: [],
    injects: [],
    logs: [],
    provided: [],
    fetchCalls: [],
    llmCalls: [],
    /** 通过 `webServer.register` 挂上的路由（书架 HTTP 面）。 */
    webRoutes: [],
  };

  const pendingFetch = [...fetchPlan];

  state.fetch = async (url, init = {}) => {
    state.fetchCalls.push({ url: String(url), init });
    // 队列用于「每次调用响应不同」的用例；`fetchFallback` 用于「同一个 URL 会被反复取」
    // 的用例（addSubscription 自己取一次、refresh 再取一次）。把调用次数写死进计划表
    // 会让测试以「没有准备响应」的形式失败 —— 症状离原因很远。
    const next = pendingFetch.shift()
      ?? (typeof fetchFallback === 'function' ? fetchFallback(String(url), state.fetchCalls.length) : undefined);
    if (!next) throw new Error(`fetch 桩：没有为 ${url} 准备响应`);
    if (next.throw) throw next.throw;
    const body = next.body ?? '';
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      // 真 fetch 一定带 `url`（跟随重定向后的最终地址）。桩里省掉它会让
      // 「读 response.url」的代码静默拿到 undefined —— 那种偏差只会在真机上暴露。
      url: String(url),
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? next.contentType ?? 'application/xml' : null) },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      async text() {
        return typeof body === 'string' ? body : new TextDecoder().decode(bytes);
      },
    };
  };

  const llm = {
    stream(request) {
      state.llmCalls.push(request);
      const chunks = typeof llmChunks === 'function' ? llmChunks(request) : llmChunks;
      return (async function* generate() {
        for (const chunk of chunks) yield chunk;
      })();
    },
    /**
     * `listAiModels` 会问这两件事。默认给「一个 provider + 一个模型」，
     * 想测「一个 provider 都没注册」「模型列表是空的」「某个 provider 报错」
     * 就传 `options.modelCatalog` 覆盖 —— 那三种情况在设置页要说**不同**的话。
     */
    listProviders: () => modelCatalog.providers.map(({ models, error, ...info }) => info),
    listModels: async (provider) => {
      const entry = modelCatalog.providers.find((p) => p.id === provider);
      if (entry?.error) throw new Error(entry.error);
      return (entry?.models ?? []).map((m) => ({ provider, id: m.id, name: m.name ?? m.id }));
    },
  };

  const agentDefaultModel = {
    currentSelection: () => modelSelection,
  };

  const systemPrompt = {
    context(contribution) {
      state.systemPromptContributions.push(contribution);
      return () => {};
    },
  };

  /**
   * `webServer` 服务桩：`register(route)` 的语义照抄 `@deepseek-ai/dsh-host-webserver`
   * —— 收下一个 `WebRoute`（`{ kind: 'exact'|'prefix', path, handler }`）并返回注销用的 disposer。
   *
   * ★ 刻意**不**挂到 `ctx.webServer` 上（对比上面 `tools` / `llm` 那几行的待遇）：
   *   真实宿主里 `webServer` 不是本插件的 `static inject` 成员，只能从
   *   `ctx.inject(['webServer'], scope => …)` 的子作用域上拿到。桩照抄这个差别，
   *   才能让「把 `scope.webServer` 写成 `ctx.webServer`」当场变成 TypeError，
   *   而不是安静地变成一个在真机上永远挂不上的路由。
   */
  const webServer = {
    register(route) {
      const entry = { route, disposed: false };
      state.webRoutes.push(entry);
      return () => { entry.disposed = true; };
    },
  };

  const services = new Map([
    ['tools', { register: (tool) => { state.tools.push(tool); return () => {}; } }],
    ['llm', llm],
    ['agentDefaultModel', agentDefaultModel],
    ['systemPrompt', systemPrompt],
    ['webServer', webServer],
  ]);

  const ctx = {
    logger: {
      info: (...args) => state.logs.push(['info', ...args]),
      warn: (...args) => state.logs.push(['warn', ...args]),
      error: (...args) => state.logs.push(['error', ...args]),
      debug: (...args) => state.logs.push(['debug', ...args]),
    },
    tools: services.get('tools'),
    llm,
    agentDefaultModel,
    systemPrompt,
    get: (name) => services.get(name),
    reflect: {
      get(name, required = true) {
        const value = services.get(name);
        if (value === undefined && required) throw new Error(`unknown service: ${name}`);
        return value;
      },
      // 入口的 apply() 用 `ctx.reflect.provide('rss', service)` 注册服务，
      // 语义照抄 Cordis 的 ReflectService.provide（返回注销用的 disposer）。
      provide(name, value) {
        services.set(name, value);
        state.provided.push({ name, value });
        return () => services.delete(name);
      },
    },
    effect(fn, label) {
      state.effects.push({ label, dispose: fn() });
      return () => {};
    },
    inject(names, callback) {
      state.injects.push(names);
      // 子作用域：只有被点名的服务出现在上面（与 Cordis 一致）。
      const scope = {};
      for (const name of names) {
        if (services.has(name)) scope[name] = services.get(name);
      }
      scope.logger = ctx.logger;
      scope.get = ctx.get;
      scope.effect = ctx.effect;
      return callback(scope);
    },
  };

  return { ctx, state, services };
}

/** 最小 RSS 文档，供 addSubscription / refresh 用例使用。 */
export function rssDocument({ title = 'Test Feed', items = [] } = {}) {
  const itemXml = items.map((item) => `  <item>
    <title>${item.title}</title>
    <link>${item.link ?? 'https://example.org/post'}</link>
    <guid isPermaLink="false">${item.guid ?? item.title}</guid>
    <pubDate>${item.pubDate ?? 'Wed, 24 Sep 2025 08:00:00 GMT'}</pubDate>
    <description><![CDATA[${item.description ?? '<p>Body text</p>'}]]></description>
  </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${title}</title>
  <link>https://example.org/</link>
  <description>A test feed</description>
${itemXml}
</channel></rss>`;
}
