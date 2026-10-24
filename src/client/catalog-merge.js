/**
 * 把「内置目录」和「用户自己的目录」合成探索页要用的那一份，并给出每类的来源说明。
 *
 * 为什么要有这一层：内置目录原本是**写死的** —— 用户看到一堆不认识的源，不知道它们
 * 从哪来、也改不了。现在的约定是：
 *   - 内置目录 = **只读默认值**，可以隐藏（`hidden` 里记 url），不能改；
 *   - 想改就自己加一条（`sources`），并且分类名是**自由文本**，不限定内置那几类。
 * 这样插件升级换掉内置目录时，用户自己加的东西不会被冲掉，内置目录也能继续更新。
 */

/**
 * 内置分类，只用来定分类按钮的**顺序**；分类集合本身是动态的。
 *
 * ★ 2026-10-08 起只剩两类：原先的「精选作者 / 微信公众号 / 播客」整类撤掉
 *   （数据来源没法对用户交代清楚），撤掉的清单与原因见仓库根的 `retired/README.md`。
 */
export const BUILTIN_CATEGORIES = ['Newsletter', '独立博客'];

/**
 * 用户新增条目时没填分类就用这个。
 *
 * ★ 这个默认值在**两个半区各写了一份**：这里是客户端口径，宿主半区是
 *   `src/host/service.js` 的 `addCatalogSource` 里的字面量。两边必须一致，
 *   否则「加进来落在哪个分类」会跟着调用方不同而不同。
 *   `test/catalog-merge.test.mjs` 有一条断言把两者钉在一起。
 */
export const DEFAULT_CUSTOM_CATEGORY = '我的源';

/**
 * 每类推荐源的**来源说明**。用户的原话是「只有说明了独立博客是用的第三方独立博客目录」——
 * 其余几类当时一个字都没说，而它们恰恰是最容易失效的（第三方代理 / 第三方 RSSHub）。
 * 那几类现在整类撤掉了，所以这里只剩两条：能对用户交代清楚来源的。
 */
const PROVENANCE = {
  Newsletter: '来自一份公开的 AI 电子报清单（嗯哌AI《我订了上百个，最后只留下这 16 个》），逐条实测过：这里 9 个能直接抓到 feed，其中几个的地址和官网长得不一样（The Batch 在官网路径下没有 feed；Daily Dose of DS 得走自己的自定义域，它订阅页所在的 substack 子域在本机取不到）。同一份清单里另外 6 个没有收录 —— 3 个 Substack 源在本机网络下不可达（它们其实有 feed，是被拦了），1 个被反爬拦截，2 个平台根本没开 feed。另有 2 个（TLDR AI、Daily Dose of DS）是后来单独补的，同样逐条实测通过；The Neuron 试过但已摘除 —— feed 抓得到、正文永远抓不到；还有 2 条（AI Valley、Grace Leung）停更超过一年，已按 365 天删除线裁掉并存档在 retired/。',
  独立博客: '来自 timqian/chinese-independent-blogs（MIT 许可）。',
};

/**
 * @param {string} category
 * @param {{ revision?: string, pruned?: { from?: number, to?: number, rule?: string } }} [context]
 * @returns {string} 该类推荐源的来源说明；用户自建的分类返回「你自己添加的」。
 */
export function provenanceOf(category, { revision, pruned } = {}) {
  const text = PROVENANCE[category];
  if (text === undefined) return '你自己添加的信息源。';
  if (category !== '独立博客') return text;
  // ★ `revision` 只说「从源目录哪个 commit 同步」，**不等于**「这份清单还是源目录全量」。
  // 裁剪过就必须说出来，否则那句话会让人以为目录被莫名缩水了。
  const parts = [text];
  if (revision) parts.push(`同步自 revision ${revision.slice(0, 8)}。`);
  if (pruned?.from && pruned?.to) {
    parts.push(`其中 ${pruned.from - pruned.to} 条经实测剔除（${pruned.rule ?? '探不通或长期未更新'}），现留 ${pruned.to} 条 —— 删掉的是抓不到或早已停更的，不是你的订阅。`);
  }
  return parts.join('');
}

/**
 * 合成目录。
 * - 用户自己加的排在最前（他要找的多半是自己刚加的那个）；
 * - 内置条目里被隐藏的、以及 url 与自定义条目重复的，都剔除 ——
 *   否则同一个地址会出现两行，一行能删一行不能，用户没法理解。
 */
export function mergeCatalog({ builtin, sources, hidden } = {}) {
  const hiddenSet = new Set(hidden ?? []);
  const custom = (sources ?? []).filter((item) => item && item.url).map((item) => ({ ...item, custom: true }));
  const customUrls = new Set(custom.map((item) => item.url));
  const kept = (builtin ?? []).filter((item) => item && item.url && !hiddenSet.has(item.url) && !customUrls.has(item.url));
  return [...custom, ...kept];
}

/**
 * 分类按钮的取值：`全部` + 内置几类（保持固定顺序）+ 用户自己用到的分类（按出现顺序）。
 * ★ 不写死内置那几类 —— 用户加一个「行业观察」分类，按钮就得跟着长出来。
 */
export function catalogCategories(entries, { builtinCategories = BUILTIN_CATEGORIES } = {}) {
  const ordered = [];
  for (const name of builtinCategories) if (!ordered.includes(name)) ordered.push(name);
  for (const entry of entries ?? []) {
    const name = (entry?.category ?? '').trim();
    if (name !== '' && !ordered.includes(name)) ordered.push(name);
  }
  return ['全部', ...ordered];
}

/** 有多少条是用户自己加的（界面要说清「哪些是我的、哪些是插件给的」）。 */
export function countCustom(entries) {
  return (entries ?? []).filter((entry) => entry?.custom === true).length;
}
