/**
 * 「用哪个模型做翻译 / 改写」这个设置的取值形态 —— **宿主半区与客户端半区共用**。
 *
 * 取值是一个字符串：
 *   `''`                  → 跟随 Harness 的默认模型（`agentDefaultModel`）
 *   `'<provider>/<model>'` → 用指定模型
 *
 * ★ 为什么是「一个字符串」而不是 `{ provider, model }` 对象：
 *   设置项要经过 `validateSettings`、落进本机数据文件、还要能在设置页的下拉框里
 *   当 `<option value>` 用。一个字符串在这三处都是天然形态；对象要在每处各写一遍
 *   序列化，多出三处可以写歪的地方。
 *
 * ★ 为什么按**第一个** `/` 切，而不是最后一个：
 *   模型 id 自己可能带斜杠（`anthropic/claude-sonnet-4`、`meta-llama/llama-3-70b`），
 *   而 provider id 不带。按最后一个 `/` 切会把 `openrouter/anthropic/claude` 切成
 *   provider=`openrouter/anthropic` —— 一个不存在的 provider，然后静默回退到默认模型，
 *   用户以为自己在用免费模型，其实一直在花默认模型的钱。
 */

/** 跟随 Harness 默认模型的取值。 */
export const AI_MODEL_DEFAULT = '';

/**
 * 解析设置取值。
 * @param {unknown} value
 * @returns {{provider: string, model: string}|null} `null` = 跟随默认模型
 */
export function parseAiModel(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const at = text.indexOf('/');
  if (at <= 0 || at === text.length - 1) return null;
  const provider = text.slice(0, at);
  const model = text.slice(at + 1);
  if (/\s/.test(text)) return null;
  return { provider, model };
}

/** 把一对 provider/model 编回设置取值（`listAiModels` 的结果也走这里，保证两边同源）。 */
export function formatAiModel(selection) {
  if (!selection?.provider || !selection?.model) return AI_MODEL_DEFAULT;
  return `${selection.provider}/${selection.model}`;
}

/**
 * 这个取值能不能被接受。
 *
 * ★ 判据是「空串或能解析」，**不是**「看起来像 provider/model」——
 *   前者才和 `parseAiModel` 的判据同源。两处各写一遍会出现
 *   「设置页说合法、宿主解析成 null」⇒ 静默回退到默认模型。
 */
export function isValidAiModel(value) {
  if (typeof value !== 'string') return false;
  if (value.length > 200) return false;
  return value.trim() === '' || parseAiModel(value) !== null;
}

/**
 * 「这次实际会用哪个模型」的取值来源。
 *
 * ★ 四个状态**必须分开**，因为它们的修法完全不同，而界面上它们都可能表现为
 *   「没有模型名」：
 *   - `settings`    设置里指定了模型 ⇒ 这次就用它；
 *   - `default`     设置留空 ⇒ 跟随 Harness 默认模型（名字已经问到了）；
 *   - `unavailable` 跟随默认，但问不到默认是哪个（服务没注册 / 还没选模型）；
 *   - `invalid`     设置里那个值**读不出来** ⇒ 生成会**报错**，不是回退到默认模型。
 */
export const AI_MODEL_SOURCE = {
  SETTINGS: 'settings',
  DEFAULT: 'default',
  UNAVAILABLE: 'unavailable',
  INVALID: 'invalid',
};

/**
 * 拿不到具体模型名时的兜底说法。
 *
 * ★ `invalid` 与另外两个**必须说不同的话**：`invalid` 的配置**不是**「跟随默认」
 *   （它会报错），在那里说「Harness 默认模型」就是一句确定的假话。
 */
const AI_MODEL_FALLBACK_LABEL = {
  [AI_MODEL_SOURCE.DEFAULT]: 'Harness 默认模型',
  [AI_MODEL_SOURCE.UNAVAILABLE]: 'Harness 默认模型',
  [AI_MODEL_SOURCE.INVALID]: 'AI 模型',
};

/**
 * 造「这次实际会用哪个模型」—— **宿主半区造、客户端半区读**，形状只写一遍。
 *
 * ★ 与宿主 `selectionFor`（真正决定用哪个模型的那个函数）**同一份判据**：
 *   `parseAiModel` + `defaultSelection`。两处各写一遍会出现「界面说 A、实际用 B」——
 *   而且界面说的是**确定的话**（不是「不知道」），用户没有理由怀疑。
 *
 * @param {unknown} value 设置项 `aiModel` 的取值（`''` = 跟随 Harness 默认模型）
 * @param {() => ({provider: string, model: string})} getDefault 取 Harness 默认模型；取不到时**抛错**
 * @returns {{value: string, source: string, model: {provider: string, model: string}|null}}
 */
export function resolveAiModelInfo(value, getDefault) {
  // 非字符串（用户手改了数据文件）与空白串一样按「跟随默认」处理 —— 与 `selectionFor` 同判据。
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    try {
      // 绕一圈 `formatAiModel` → `parseAiModel`，是为了让「这里认下来的形状」
      // 与「从设置串里解析出来的形状」**同源**：默认模型那边如果给出一个
      // 缺 provider / 缺 model 的选择，`formatAiModel` 会给出空串 ⇒ 判为取不到，
      // 而不是把半截选择原样显示出来。
      const parsed = parseAiModel(formatAiModel(getDefault()));
      return parsed
        ? { value: text, source: AI_MODEL_SOURCE.DEFAULT, model: parsed }
        : { value: text, source: AI_MODEL_SOURCE.UNAVAILABLE, model: null };
    } catch {
      return { value: text, source: AI_MODEL_SOURCE.UNAVAILABLE, model: null };
    }
  }
  const parsed = parseAiModel(text);
  return parsed
    ? { value: text, source: AI_MODEL_SOURCE.SETTINGS, model: parsed }
    : { value: text, source: AI_MODEL_SOURCE.INVALID, model: null };
}

/**
 * 把上面的结果整成一句能直接塞进界面的说法。
 *
 * ★ 拿不到具体模型名时返回**不含模型名**的兜底说法，绝不编一个名字出来 ——
 *   这是这个函数存在的全部理由：界面上写着某个模型名，用户就会当成事实。
 *
 * @param {unknown} info `resolveAiModelInfo` 的返回值；拿不到（还在读 / 读失败）时传 null
 * @returns {string}
 */
export function effectiveModelLabel(info) {
  const provider = info?.model?.provider;
  const model = info?.model?.model;
  if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
    return `${provider} · ${model}`;
  }
  return AI_MODEL_FALLBACK_LABEL[info?.source] ?? 'AI 模型';
}

/**
 * 把宿主 `listAiModels` 的结果整成下拉框能直接渲染的形状。
 *
 * 取值用 `formatAiModel` 生成 —— 和「读设置」那一侧同一个编码函数。
 * 两处各拼一遍 `provider + '/' + model` 的话，改编码规则时必漏一处。
 *
 * @param {unknown} result
 * @returns {Array<{id: string, label: string, error?: string, models: Array<{value: string, label: string}>}>}
 */
export function aiModelOptions(result) {
  const providers = Array.isArray(result?.providers) ? result.providers : [];
  return providers
    .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
    .map((entry) => ({
      id: entry.id,
      label: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
      ...(entry.error ? { error: String(entry.error) } : {}),
      models: (Array.isArray(entry.models) ? entry.models : [])
        .filter((model) => model && typeof model.id === 'string' && model.id !== '')
        .map((model) => ({
          value: formatAiModel({ provider: entry.id, model: model.id }),
          label: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        })),
    }));
}

/**
 * 下拉框下面那行说明。
 *
 * ★ 三种「没得选」要分开说，因为它们的**修法完全不同**：
 *   还在读 / 宿主没注册 provider / provider 有但模型列表是空的（多半是 key 没配）。
 *   一律说「暂无可用模型」的话，用户不知道下一步该去哪儿做什么。
 */
export function describeModelCatalog(result) {
  if (!result) return '正在读取可用模型…';
  const providers = aiModelOptions(result);
  const total = providers.reduce((sum, entry) => sum + entry.models.length, 0);
  if (total > 0) return `共 ${total} 个模型可选`;
  if (result.error) return `读不到模型列表：${result.error}`;
  if (providers.length === 0) return '宿主还没有注册任何模型 provider —— 先在 Harness 里配好模型，再回来选。';
  return `读到 ${providers.length} 个 provider，但一个模型都没读到 —— 多半是它的 API key 还没配。`;
}
