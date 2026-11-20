# retired —— 撤下但没丢掉的东西

这个目录**不参与构建、不被任何代码 import**，只保留「撤下的清单原文」：

- **为什么留**：数据撤掉了，但「原来有哪些、为什么撤」要能核对。`test/catalog-merge.test.mjs`
  有断言要求这些文件必须在；体检裁掉停更条目时，也必须先归档到这里再删。
- **为什么不直接删**：删掉等于把撤下的理由一起删了 —— 下次有人发现某个源不见了，只能猜。

撤下的理由**不都是同一个**：

- 第 1–3 节：**数据来源没法对用户交代清楚**。用户 2026-10-08 的原话是
  「在数据源不明了的情况下我建议先删除」。
- 第 4 节：**源还在、只是停更太久**，被删除线自动裁掉（2026-10-09 起）。

想恢复就照下面的原文抄回去，别凭记忆重写。

---

## 1. 精选作者（7 条）

原先内联在 `src/client/Discover.jsx` 的 `featured` 常量里，`category: '精选作者'`。
撤下的理由：它是**插件手写清单**，不是从任何公开目录同步的 —— 也就是「来源」就是作者自己，
用户没法核对，也没法跟着上游更新。

```js
const featured = [
  ['潮流周刊 · Tw93', 'https://weekly.tw93.fun/rss.xml'],
  ['阮一峰的网络日志', 'https://www.ruanyifeng.com/blog/atom.xml'],
  ['云风', 'https://blog.codingnow.com/atom.xml'],
  ['和菜头', 'https://www.hecaitou.com/feeds/posts/default?alt=rss'],
  ['张鑫旭', 'https://www.zhangxinxu.com/wordpress/feed/'],
  ['小众软件', 'https://www.appinn.com/feed/'],
  ['月光博客', 'https://www.williamlong.info/rss.xml'],
].map(([name, url]) => ({ name, url, category: '精选作者' }));
```

（更早还撤过 `Reorx`（最新 2026-02-11，滞后 238 天）与 `pseudoyu`（最新 2026-06-06，滞后 123 天）。）

## 2. 微信公众号（7 条）

原先内联在 `src/client/Discover.jsx` 的 `wechat` 常量里，`category: '微信公众号'`。
撤下的理由：公众号没有官方 RSS，这些条目**全部经同一个第三方代理**
（`rss.t5t6.com`，一个个人 FreshRSS 实例、白名单制），代理一停就一起死；
2026-10-08 实测这些源的最新一篇全部停在 9/18–9/20。

```js
const wechat = [
  ['葬AI', '3988614169'], ['AGENT橘', '3903697567'],
  ['赛博禅心', '3934419561'], ['数字生命卡兹克', '3223096120'], ['晚点LatePost', '3572959446'],
  ['新智元', '3271041950'], ['elsewhere别处发生', '3635075805'],
].map(([name, id]) => ({ name, url: `https://rss.t5t6.com/weread/MP_WXS_${id}.xml`, category: '微信公众号', note: '第三方代理' }));
```

## 3. 播客（11 条）

数据文件原在 `src/data/podcast-feeds.json`，已移到本目录同名文件，`category: '播客'`。
撤下的理由：多数条目经**第三方 RSSHub 实例**（`rsshub.bestblogs.dev`）转小宇宙节目 ——
同样是一个别人的服务器，随时会没；实测 73 条里 61 条探不通。

恢复办法：把 `podcast-feeds.json` 移回 `src/data/`，在 `Discover.jsx` 里重新 import 并
`map(entry => ({ ...entry, category: '播客' }))`，再把 `'播客'` 加回
`src/client/catalog-merge.js` 的 `BUILTIN_CATEGORIES` 与 `PROVENANCE`，
并在 `scripts/catalog-health.mjs` / `scripts/prune-catalog.mjs` 里恢复对它的抓取与裁剪。

## 4. Newsletter 停更超一年被裁掉的源（2 条，2026-10-09）

数据文件：`retired/newsletter-feeds-retired.json`（`removed` 数组，由 `prune-catalog.mjs`
**自动追加**，带原条目的全部字段 + `removedAt` + `reason`）。

用户 2026-10-09 的要求是「给 Newsletter 也接上体检，停更一年的直接删掉吧」。
这一目录从那天起进体检（`category: 'Newsletter'`），删除线 **365 天**
（比独立博客那条 90 天宽 —— 这十来条是**逐条实测手写**出来的，没有 upstream 可以重新同步，
删掉就是永久丢失，所以被删的条目**先归档再删**）：

| 名字 | 地址 | 最新一篇 | 裁掉时已停更 |
| --- | --- | --- | --- |
| AI Valley | `https://aivalley.ai/feed/` | 2024-12-07 | 670 天 |
| Grace Leung | `https://www.graceleung.com/feed` | 2024-10-11 | 727 天 |

★ 两条的 feed **都是好的**（2026-10-09 实测 HTTP 200、能解析出条目），被删的原因是**停更**，
不是抓不到 ⇒ 所以它们在这里，而**不**在 `newsletter-feeds.json` 的 `unavailable` 里
（后者记的是「当初就没收录」，比如被墙 / 被反爬 / 平台没开 feed）。

恢复办法：把 `removed` 里的条目抄回 `src/data/newsletter-feeds.json` 的 `items` 数组，
顺手把 `verifiedAt` 改成当天（否则下次跑体检，它们会因为同一个删除线**再被裁一遍**）。

---

## 顺带撤下的 UI（不是数据）

「**+ 添加信息源**」按钮与它展开的内联表单（含分类快选、转 RSS 说明）也已从探索页撤掉。
相关能力**没有删**，只是少了入口：

- `api.addCatalogSource` / `api.removeCatalogSource` / `api.setCatalogHidden` 仍在，宿主半区
  `service.js` 的对应方法也仍在 —— 老版本 store 里已经存在的用户自建条目照样能列出、能删；
- 「转 RSS 服务」配置（`setCatalogService` / `probeCatalogService` + `catalog.service.base`）
  仍在宿主半区，`src/client/service-probe.js` 也保留着，等它有了新的落点再接上界面。
