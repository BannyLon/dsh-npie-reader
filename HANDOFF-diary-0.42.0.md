# 交接：日记三个模块（0.42.0）—— 代码与静态验收已完成，**只差真机**

> 自足的，不需要之前的对话。
> **仓库**：`/Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader`
> **注意是桌面端那棵树**（`dsh_plugins_desktop/`），不是 `dsh_plugins/`。
> **版本**：`0.42.0`。**git**：0.29–0.41.1 已全部提交，0.42 见 `git log`。
> **上一份交接**（`HANDOFF-diary-0.32.0.md`）已过期 10 个版本，挪到了 `.build/archive/`，**别再照它做**。

---

## 0. 一句话现状

用户对日记页提过的所有具体批评（版式、AI 整理粒度、两个侧栏、情绪 emoji、读后感门禁、
挂在书上、页脚串味、编辑器、写入口固定、记录密度、标签全量）**都已落地**。
0.40 补的是最后三个已知缺口 + 一批「文档和代码说反话」的修正；
0.40.1 是给「挂到书」浮层补预览图时**量出两个真 bug**（列表行被 flex 压扁、三层嵌套滚动）并修掉；
**0.41 是一次信息架构重构**：灵感侧栏从「四块纵向平铺」改成
`按时间 | 按书本 | 按文章` 三档切换器；0.41.1 把它挪到标签下面并加 `sticky`；
**0.42 让「挂到书」自动匹配这条原本挂在哪儿**，顺带修掉「书架上明明有书却说没有」——
`loadBooks()` 原来只在读后感页调，灵感页上浮层里那句是**确定的假话**。

**下一步只有一件事：重启 DSH，在真机上把这些过一遍。** 这一轮所有结论都来自
单元测试 + 静态预览，**真机一次都没跑过**。

---

## 1. 30 秒上手

```bash
cd /Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader

node build.mjs
node scripts/check-classes.mjs
node --test test/diary-*.test.mjs test/build.test.mjs test/client-runtime.test.mjs
```

0.42.0 实测期望值：

| 检查 | 期望 |
| --- | --- |
| 日记相关（8 个 `diary-*.test.mjs` + `build` + `client-runtime`） | **382 / 382 通过**（97 个 suite） |
| `check-classes` | 定义 **599** / 使用 **626**，**双向 0 缺口**，4 个白名单语义钩子 |
| 构建 | host **571.2 KB** / client **1166.2 KB** / vendor/editor 373.8 KB |
| 静态预览几何 | `node .build/preview/make-diary-preview.mjs && node .build/preview/measure.mjs` ⇒ `cols=268px 1px 911px`，标题与正文左缘差 **0** |
| **侧栏几何（0.41）** | `node .build/preview/measure-sidebar.mjs` ⇒ `ALL OK`：切换器 244×30、三档 79/79/79 铺满 240px 槽、面板 565px 可滚 565px、胶囊 x=215..234 / chevron 右缘 255 / 行右缘 263 |
| **切换器钉住（0.41.1）** | 同上脚本 ⇒ 打印 `滚动 277px 后：条顶 194 → 76（面板顶 76）`（按书本那帧是 319px）；不 sticky 时这里是 `-125` |
| **侧栏反向对照** | `node .build/preview/check-sidebar-mutant.mjs` ⇒ `反向对照通过`（**三条**变异各自变红且理由对） |
| 「挂到书」浮层几何 | `node .build/preview/measure-link.mjs` ⇒ `ALL OK`（**五帧**：卡片 464/536/463/464/482px 均装进 642px 画框、body 都不滚、行高 31px） |
| 浮层反向对照 | `node .build/preview/check-link-mutant.mjs` ⇒ `反向对照通过` |
| **自动匹配反向对照（0.42）** | `node .build/preview/check-linkpick-mutant.mjs` ⇒ `反向对照通过`（**四条源码变异**各自变红且理由对，跑完打印「源码已还原（逐字节一致）」） |

**不要**用 `node --test test/`（`MODULE_NOT_FOUND`），要 `test/*.test.mjs`。

---

## 2. 0.40 / 0.40.1 做了什么

### ① 「一键把灵感挂到书上」—— 入口补上了（P1-a）

用户原话里唯一没落地的那半句。0.31 只做了**捕获时**的自动关联（读书按 `L` 写
`meta.book/chapter/page`）；「我昨天随手记的一条，现在想挂到第 3 章」没有入口。

- 条目行多一颗「挂到书」→ 选书 →（可选）从目录挑一章 → 挂上去。
- **只对公开条目开**：侧栏「挂在书上」从 `timeline()` 建，而它默认不带私密。
- **目录点一下才读**（`askLinkOutline`）：网盘书要拉整本，超时 2 分钟，预加载会卡住界面。
- 电子书 `sections[]` / PDF `outline.chapters[]` 两套；都没有就明说「只能挂到整本」。
- 写 `source` + `meta` 两处；拼 `source` 用 `diary-format.js` 的 `sourceLabel()`（与 `parseSource` 同文件）。

**落点**：`DiaryApp.jsx` 的 `openLinkPick` / `pickLinkBook` / `askLinkOutline` / `applyLink` + 浮层 JSX；
`diary-api.js` 的 `patchDiaryEntry`；`diary-format.js` 的 `sourceLabel`；`refinements.css` 的 `.npr-diary-link*`。

### ② `PATCH` 被做成了 `PUT`（真缺陷）

`diary-routes.js` 顶部写「body 里给要改的字段」，但 `updateEntry` 强制要整条正文。
后果：只想补一个出处，却必须把用户原话再传一遍；中途别处改过正文就会被**静默**覆盖。

- 现在 `body` 可选（不传 = 保留原文），传了仍必须非空。
- 没选章时**整个 `chapter` 键都不传** —— `Number(null) === 0` 且 `0 >= 0`，
  传 null 会写出 `"chapter":0`，而 0 章不存在。

**落点**：`src/host/diary-store.js` 的 `updateEntry` / `append`。

### ③ 时间轴能往前翻（P1-c）

- 末尾原来只有「只看了最近 N 天。」—— 看得到还有更早的，却调不出来。
- 现在「加载更早 · 目前只显示最近 N 天」。游标用**日期**不用条数；追加按 date 去重；
  拿到 0 天就不再声称还有（否则是死按钮）。

**落点**：`DiaryApp.jsx` 的 `loadMoreTimeline` + `TIMELINE_PAGE`；`refinements.css` 的 `.npr-diary-dayload`。

### ④ `diary_append` 的类型回落不再静默（P1-d）

模型传「书摘」→ 静默存成「灵感」→ 回执不说 ⇒ 模型对用户说「我记成书摘了」。
现在 `append()` 回 `kind / kindAsked / kindFellBack`，回执点名三件事。
判据用**结果**（`asked !== entry.kind`），不在 `tools.js` 里再抄一份白名单。

### ⑤ 文档与代码对齐

README 曾明写「**没有** `diary_edit` / `diary_delete`，不是还没做，是**故意不给**」，
而 0.36 已按用户要求加了。同处「这三个工具」（实际 5 个）、「18 个 agent 工具」（实际 20 个）、
`package.json` 的「原文只追加不改写」、`reading-scope.js` 注释的「它只有 append」——全部改正。

★ 最阴的是最后一条：工具改了、提示词改了、注释没改。下一个接手的人照注释「修回去」，
就会把已经改好的能力又锁上。

### ⑥ 0.40.1：给浮层补图，然后量出两个真 bug

0.40 的「挂到书」浮层**从没进过任何一张预览图**（预览脚本是手写的静态近似，不渲染真 JSX）。
补了三帧（选完书 / 读过目录 / 没有目录）之后用真 Chrome 量 computed 值，抓到两个
**在缩略图里都长得像正常留白**的问题。两个都是 0.40 自己引入的。

1. **列表行被 flex 压扁**。列表是 `flex-direction: column` + `max-height: 190px` +
   `overflow: auto`，子项默认 `flex-shrink: 1` ⇒ 装不下时**行被压扁**而不是溢出滚动。
   10 本书压进 190px，每行只剩 18px，而文字行高 18.75px ⇒ 每行被垂直切掉半截。
   指纹：`scrollHeight === clientHeight`（永远滚不动）。
   修：`.npr-root .npr-diary-linkbook` 加 `flex: 0 0 auto`。
2. **三层嵌套滚动**。书列表 190 + 章列表 190 同时在场 ⇒ 内容 622px > 卡片上限 600px
   ⇒ `.npr-diary-modal-body` 自己溢出 30px。`overscroll-behavior: contain` 挡住链式传递
   ⇒ 章列表滚到底不会接着滚卡片，用户得把指针挪出去再滚（看着像「滚不动」）。
   修：章节列表打开时书列表收窄到 96px（`is-compact`）；同时「当前选择」那行**必须带书名**，
   否则选中的书被滚出视野就不知道在往哪本挂。

**落点**：`refinements.css` 的 `.npr-diary-linkbook` / `.npr-diary-linkbooks.is-compact`；
`DiaryApp.jsx` 浮层里 book 列表的条件 class 与 `.npr-diary-linkpicked`。

**判据落点**：`.build/preview/measure-link.mjs`（几何）+ `check-link-mutant.mjs`（两条变异
各自必须变红）。单测 +4 钉住「CSS 守卫还在 + class 是条件拼的 + 变异锚点没漂」。

---

## 2.5 0.41：灵感侧栏改成三档切换器（**这一轮的主体**）

### 为什么必须改（不是审美问题，是增长模型问题）

原来的侧栏是**四块纵向平铺**：标签 / 时间轴 / 挂在书上 / 挂在文章上。
用户原话：「时间轴无限拉长……侧边栏滚动会极其痛苦」、
「随着书本和文章越读越多，这两部分也会无限向下延伸，挤占空间」。

关键判断：**书和文章那两块的增长是单调的**——读一本多一行，永远不减少。
时间轴也在长（而且 0.40 刚给它加了「加载更早」）。三块抢同一条纵向空间，
谁最后被挤掉？**书和文章**——而那恰好是「我想按这本书找」时**唯一**能用的入口。
所以这不是「排得挤一点」，是这个布局在数据量上来后**会把最该在的功能挤没**。

### 改成了什么

侧栏顶部一颗胶囊分段控制器。★ 位置经过一次调整（0.41.1）：0.41.0 是「切换器在上、
标签在下」，用户当天就说「调下位置，[切换器] 这部分放到标签下面」⇒ 现在是
**标签 → 切换器 → 内容**，而切换器因此进了 `.npr-diary-panel`，改用
`position: sticky; top: 0` + 不透明底色（`--npr-bg-2`）钉住 —— 面板是 `overflow:auto`，
不钉的话「按书本」那串越读越长的列表会把切换器顶走，而它必须一直在。

```
⏱ 按时间   |   📖 按书本   |   📄 按文章
```

- `按时间`：原来的时间轴（含「加载更早」）。默认档。
- `按书本`：只铺书（`linkedBookRows`），**点一行就地展开它的灵感**。
  展开区里第二个按钮才是「打开这本书 ›」。
- `按文章`：同一套结构，数据换成 `linkedArticleRows`。
- 两段纵向长龙**整体删除**（`linkedBookRows.length > 0 && …` / `linkedArticleRows.length > 0 && …`），
  单测里加了 `doesNotMatch` 反向对照防止它回来。
- 标签**没有**变成第四档：它是**筛选器**，与「按什么浏览」正交（在「按书本」里也应该能按标签收窄）。
  做成第四档会让人以为「按标签」是并列的内容视图。

### 两个行为不压在同一个点击目标上

0.39 点一行 = 「回到那本书」是对的（因为 0.38 点书得到一页日记）。
但在「按书本」这个视图里，用户的问题是「这本书我想过什么」——
所以 0.41 里 **行点击 = 展开**，「打开这本书 ›」降级为展开区里的第二个按钮。
`canJump` 为假时（书已删 / 文章不在订阅里）不画死按钮，改成一句解释。

### 标题「立起来」+ 截断

- `.npr-diary-sect-head`：12px / `font-weight: 600` / 前置 12px 图标 / `border-bottom` 下分隔线。
- 长书名：`white-space: nowrap` + `text-overflow: ellipsis` + `title={bookTitle}` 悬停完整书名。
- 条数：`.npr-diary-srcount` 右对齐小胶囊（`border-radius: 999px` + `font-variant-numeric: tabular-nums`）。
- `icons.jsx` 补了 `clock` / `tag` 两个**真**图标 —— `Icon` 对未知名字**静默回落成 `circle`**
  （`const paths = PATHS[name] ?? PATHS.circle`），写错了界面上就是个圆圈，看着像设计如此。

### 落点与判据

**落点**：`DiaryApp.jsx` 的 `LINK_VIEWS` / `linkView` / `openSrcKey` / `linkViewRows` / `linkViewMeta` /
`linkedSources()` 里的 `entries` 累积与排序 + 切换器与来源区块 JSX；
`refinements.css` 的 `.npr-diary-views` / `.npr-diary-view` / `.npr-diary-src*` / `.npr-diary-sect-head`；
`icons.jsx` 的 `clock` / `tag`。

**判据落点**：`measure-sidebar.mjs`（7 条几何判据）+ `check-sidebar-mutant.mjs`（2 条变异）+
`test/diary-ui.test.mjs` 新增 `describe('0.41：灵感侧栏是一个切换器 + 当前那一档')` 7 条，
其中一条专门钉「图标名必须真的存在于 `icons.jsx`」。
预览夹具的 `icon()` 改成**从 `icons.jsx` 抽 PATHS**，未知名字直接抛 —— 夹具比真代码更狠，
因为真代码会静默画圆圈。

★ 一个量测教训：第一版两条变异**都没被抓住**（三档都是 3 个字 + 同尺寸图标，去掉 `flex:1`
宽度照样相等；去掉 `overflow:hidden` 后 `scrollWidth > clientWidth` 照样成立）。
改成「三档必须铺满整条槽（184 vs 240）」和「行高 ≤ 21 ⇒ 没换行」才真的有牙。

---

## 2.6 0.42：「挂到书」自动匹配这条原本挂在哪儿

用户原话：「本身是在阅读文章或者电子书时候通过『L』创建的灵感，在右边展示区域点击
『书籍』图标是不是自动匹配好文章或者电子书啊」，配图里浮层写着**「书架上没有匹配的书。」**，
而侧栏上明明白白挂着《译文名著文库》。

### ① 那句话是假话：书架压根没被拉过（真 bug）

`loadBooks()` 只在 `moduleValue === 'reflection'` 时调 ⇒ 灵感页上 `books.items` 是**空的**
⇒ 不管书架上有多少书，浮层都说「没有匹配的书」。**这不是「搜索没命中」，是「根本没搜」。**

- 打开浮层时补拉一次（`books.items.length === 0 && !books.busy` 才拉）。
- 空态拆成四种：`正在读书架…` / `读不到书架：<原因>` / `书架里没有名字带这几个字的书。` / `书架上还没有书。`

### ② 自动匹配：用 `meta.book` 精确对，不拿书名猜

按 `L` 记的时候 `QuickCapture` 已经写下了 `meta.book`（bookId）与 `meta.chapter`，
所以「这条挂在哪儿」是**已知的**：打开浮层就选中那本、章号填好，`从目录里挑一章` 仍要再点一次。

★ **不按书名模糊匹配**：两本书名常常只差一个译名（《九三年》/《九三年（叶尊译）》），
猜错了会把灵感挂到另一本书上，而界面看起来完全正常 —— 用户永远发现不了。

### ③ 两个「说清楚」的分支

- **书已不在书架**（移出书架 / 网盘书没进库）：不假装选中（会让人以为还能挑章），也不装作没挂过 ——
  摆出书名说明原本挂在哪，并**关掉**「从目录里挑一章」（目录按 `bookId` 读，书不在书架就读不到）。
- **原本挂在文章上**：挂到书会**换掉**它现在的出处，不是「加一个出处」，浮层里先说这句话。

**落点**：`DiaryApp.jsx` 的 `openLinkPick`（补拉书架 + 预填）、`linkPickedBook` / `linkPickedTitle` /
`linkOrphan` 三个派生值、浮层里的空态与提示文案。
**判据落点**：`test/diary-ui.test.mjs` 的 `describe('0.42：…')` 6 条 +
`.build/preview/check-linkpick-mutant.mjs` 4 条源码变异 + 预览 17 帧里的第 16/17 帧。

---

## 3. 已验证 / 未验证（**动手前先看这一节**）

### 已验证（可复现）

- 日记相关 **382 个用例全绿**（8 个 `diary-*.test.mjs` + `build` + `client-runtime`，见 §1）。
- 类名定义/使用双向 0 缺口（599 / 626）。
- 构建通过，体积见 §1。
- 新增断言做了**变异验证**（跑绿不算数），累计 10 次：
  - 追加→替换 ⇒ 红；去掉「拿到 0 天」守卫 ⇒ 红；`body` 改回必填 ⇒ 2 红。
  - 挖掉 `.is-compact` ⇒ 红（「三层嵌套滚动」）；挖掉 `flex: 0 0 auto` ⇒ 红（「行被压扁到 18px」）。
  - **0.41**：`flex: 1 1 0` → `0 0 auto` ⇒ 红（「三档没铺满整条槽（184 vs 240）」）；
    `nowrap` → `normal` ⇒ 红（「长书名没有被截断」）。
  - **0.41.1**：`position: sticky` → `static` ⇒ 红（「条顶 -125 vs 面板顶 76」）。
  - **0.42**（源码变异，`check-linkpick-mutant.mjs`）：不补拉书架 ⇒ 红；`meta.book` 置空 ⇒ 红；
    删掉 `linkOrphan` ⇒ 红；空态改回「书架上没有匹配的书」⇒ 红。
- 静态预览几何未回归：`cols=268px 1px 911px`、标题与正文左缘差 0。
- **「挂到书」浮层五帧已静态量过**（真 Chrome）：卡片 464 / 536 / 463 / 464 / 482px 均装进
  642px 画框、`body` 都不滚、行高 31px、书列表 190/317 与章列表 190/253 真滚。
- **0.41 侧栏几何已量过**（真 Chrome）：切换器 244×30、三档 79/79/79 铺满 240px 槽、
  面板 565px 可滚 565px（无横向溢出）、胶囊 x=215..234 / chevron 右缘 255 / 行右缘 263。
- **0.41.1 切换器「钉住」已量过**（真 Chrome，**真的滚了一下**）：面板压到 160px 逼出滚动条，
  滚 277px（按书本帧 319px）后条顶仍是 76 = 面板顶；不 sticky 时是 -125。
- **17 帧**逐帧出图，`m1`（按时间）、`m11`（按书本）、`m12`（按文章）、
  `m16`（打开就自动匹配）、`m17`（书不在书架）已目视确认。

### 未验证（**这就是接手后的第一件事**）

- **真机一次都没跑过。** 0.40 / 0.40.1 / 0.41 的所有视觉/交互结论都来自静态预览与源码断言。
- 预览**不能**替代真机的四处差异：
  1. 没有宿主，`--npr-*` 是手填的 `--dsw-alias-*` 派生的 —— **深色主题完全没看过**；
  2. 没有 Harness 对话面板，`has-companion` 分支没验过；
  3. 预览数据是写死的，真实的长书名、超长标签、几十条记录没试过
     （★ 这一条**已经咬过两次**：夹具只放 6 本书时列表恰好装得下，`flex-shrink` 那个
     bug 完全量不出来，加到 10 本才暴露；0.41 的侧栏夹具也是补到 10 本才量出胶囊位置）；
  4. **0.41 的交互一点没验**：视图切换的手感（点了之后侧栏是否「局部刷新」而不是整页跳）、
     二级展开是否顺手（点一行展开、再点收起）、`openSrcKey` 同时只开一个是不是符合预期、
     深色主题下胶囊切换器的对比度（`is-on` 用 `--npr-surface` 垫底 + 阴影）。
- 「挂到书」浮层**版式**已静态验证（含最挤的两列同屏），但**真机交互未验**：
  滚动是否顺手、`autoFocus` 关闭按钮会不会抢走搜索框焦点、Esc 是否关得掉。
- 宿主半区改了 `updateEntry` 的入参契约与 `append` 的返回值
  ⇒ **必须重启 DSH 才生效**（桌面端没有 `hmr`）。0.41 只动浏览器半区，理论上刷新即可，
  但桌面端 `client-hmr` 是否接管，按 §4 第 5 项一起看。

---

## 4. 接下来要做什么

### P0-1 重启 DSH，真机逐条验收

| # | 验收项 | 怎么算过 |
| --- | --- | --- |
| 1 | 三个模块切换 | 顶栏 h1、副标题、侧栏内容各自跟着换，不串数据 |
| 2 | 版式 | 标题与正文左缘目视对齐；建议 CDP 量一次 `getBoundingClientRect()`，差应为 0 |
| 3 | AI 整理 | 点日期栏那颗 → 带进去的是**整天**（不是前 8 条）；提示词里有「今天这一整天」 |
| 4 | 灵感侧栏 · 时间轴 | 标签点得动；时间轴展开当天；「加载更早」能翻出更早的天 |
| 5 | **视图切换器（0.41）** | 顺序是「标签 → 切换器 → 内容」；点「按书本」侧栏**局部**换成书列表（不是整页刷新/白屏）；**把侧栏往下滚到底，切换器还钉在顶上**；切回来默认档是「按时间」 |
| 6 | **二级展开（0.41 新）** | 点一本书就地展开它的灵感；再点收起；同时只开一个；展开区里「打开这本书 ›」能真跳；书已删时是一句解释而不是死按钮 |
| 7 | **长书名截断（0.41 新）** | 拿一本超长书名的书：单行省略号、不换行、悬停出完整书名；条数胶囊在**右侧**且不把标题挤变形 |
| 8 | **挂到书（0.40 + 0.42）** | 条目行那颗书图标 → **读书时按 L 记的那条，打开就该是选中状态、章号已填**（不用再搜书名）→ 选章（电子书 / PDF 各试一本）→ 挂上去 → 条目头出现「引自 …」且侧栏「按书本」里多一行；**书架上有书时绝不能出现「书架上没有匹配的书」** |
| 9 | **挂到书的失败路径（0.40）** | 选一本没抽过正文 / 没解读的书 → 明说「只能挂到整本」而不是空列表；网盘书点「从目录里挑一章」时界面有「正在读…」而不是卡死 |
| 10 | 私密日历 | 侧栏条数**只数私密**（在灵感里写一条，私密侧栏数字不能变） |
| 11 | 情绪 | 五档一眼能分；选中态染色；老数据 `😕` 显示成 `😣` 且日历上有色点 |
| 12 | 读后感门禁 | 侧栏「还没读完」点不动；从 PDF / EPUB 阅读器进来「写读后感」是灰的 |
| 13 | **深色主题** | **完全没看过**。重点看：选中日（fg 实心）、情绪染色、**胶囊切换器的 `is-on` 档**（`--npr-surface` 垫底 + 阴影在深底上还分不分得出） |

真机取证用 CDP（skill `web-ui-runtime-probe`）。`.build/preview/*` 只读本地 HTML，**不能**用来截真机。

### P1 可选（都不紧急）

- 「按书本」里还没有**标签收窄**（标签与视图是正交的，但现在只有「按时间」档能按标签筛）。
- 「按书本」展开的是「最近 N 条」，没有「这本书的全部灵感」页（`store.byBook` 目前只筛读后感，
  要用得先加 `kinds` 参数）。
- 读后感模板在 textarea 里显示原始 Markdown（`**一句话总结**`），写的时候满屏星号。
- 「最近写过」那行的心情 emoji 只有 12px，和情绪行不在一个量级。
- 书籍档案卡（`npr-diary-dossier`）五个数之间只有 18px 间距、没有分隔符。

---

## 5. 文件地图

| 文件 | 行数 | 管什么 |
| --- | --- | --- |
| `src/client/DiaryApp.jsx` | 2747 | **日记页全部**：三模块、写入口、侧栏（含 0.41 的视图切换器）、AI 整理、门禁、挂到书。改版式先看这里 |
| `src/client/DiaryCalendar.jsx` | 82 | 月历（`marks` 有没有条目 / `tones` 情绪分档） |
| `src/client/QuickCapture.jsx` | 141 | 读书 / 读文章时按 `L` 的浮层（灵感流转的**捕获端**） |
| `src/client/icons.jsx` | 97 | 图标表 `PATHS`（★ 未知名字静默回落成 `circle`） |
| `src/client/diary-api.js` | 219 | 客户端调宿主的那层封装（含 `patchDiaryEntry`） |
| `src/client/refinements.css` | 3051 | **日记样式在第 2347 行之后**；主题变量 `--npr-*` 在文件头 |
| `src/diary-format.js` | 501 | 两端共用：条目解析/序列化、`MOODS`、`parseSource` / `sourceLabel`、`LEGACY_KINDS` |
| `src/host/diary-store.js` | 744 | 存储：append / update / remove / listMonth / timeline / tags / search / byBook / export |
| `src/host/diary-routes.js` | 546 | HTTP 路由（含 `PATCH /day/:date/entry/:index`） |
| `src/host/diary-secret.js` | 229 | AES-256-GCM 分层加密（`private/*.md.enc`） |
| `src/host/tools.js` | — | `diary_*` 五个工具的 schema 与回执 |
| `src/reading-scope.js` | — | `diaryContext()`（AI 整理的上下文切片与权限说明） |
| `test/diary-ui.test.mjs` | 1480 | 日记页 UI 的源码断言（含 0.41 那 7 条） |
| `.build/preview/*.mjs` | — | **不是产品代码**，出静态预览与量几何（`.build/` 在 `.gitignore` 里） |

骨架是 `.npr-workarea > .npr-layout > aside.npr-sidebar + .npr-resize + section.npr-reader`，
**但网格列宽规则在 `src/client/ReaderPage.jsx` 的 `PANEL_CSS` 模板串里**，不在 `refinements.css`。

---

## 6. 红线（改之前必须知道）

1. **私密日记的内容不进模型。** `store` 的 `includePrivate` 默认 `false`；`diary_search` 不传、
   `diary_today` 走 `read` 不走 `readFull`、`diary_append` 没有 `vis` 参数。
   **这是边界不是遗漏**，别顺手加。
2. **`--npr-*` 全部由宿主的 `--dsw-alias-*` 派生**，别新造未定义的 `var(--x)` ——
   未定义的 `var()` 会让**整条声明**变成 guaranteed-invalid（空值），波及全部后代。
3. **`data-window-drag` 打在 `.npr-sidebar-toolbar` / `.npr-book-toolbar` 上**，
   且祖先不能有 `tabIndex` / `role=dialog` / `button`。另外 `window-drag.test.mjs` 用**精确匹配**
   `className="npr-book-toolbar"`，所以那个元素上**不能追加别的类名**。
4. **模板串 / JSX 注释里不能出现反引号**（会提前闭合模板串，得到语法合法的减法链，
   构建能过、用例全绿、App 起不来）。
5. **改 `refinements.css` 的日记段时，同特异度的覆盖规则位置就是语义** —— 源码顺序决定谁生效。
6. **`PATCH` 的 `body` 现在可选**。给「只改一个字段」用它是安全的；但**别把 `body: ''` 当清空**，
   那条路是删除，会被 `ENTRY_EMPTY` 拒掉。
7. **`Icon` 的图标名写错不报错**，界面上画成圆圈。加图标一律先确认 `icons.jsx` 里有这个名字，
   并让单测 / 夹具去钉（夹具的 `icon()` 已经会直接抛）。

---

## 7. 环境坑（**这几条能省你半天**）

1. **两棵插件树**：`dsh_plugins/`（web）与 `dsh_plugins_desktop/`（desktop）。本项目在**后者**。
   归属只认 profile 软链（`~/.dsh/profiles/desktop/node_modules/dsh-npie-reader` → 源码树）。
   桌面端**没有 `hmr`** ⇒ 宿主半区改动不热更，必须重启。
2. **全量测试在本沙箱里跑不完。**
   - 不加超时：跑完 148 个套件后**卡死**在 `book-tools` 之后，输出文件十几分钟零增长
     （沙箱把进程吊住，不报错）。
   - 加 `--test-timeout=45000` 分两段跑：约 91 条红，全是**文件级** suite 失败
     （钩子里删临时目录被拦，`code: 'EPERM'` / `failureType: 'hookFailed'`）。
     `diary-store` / `diary-tools` / `store` / `tools` / `pan-auth` 这些**单独跑全绿**。
   - ★ 判据不是「红了几条」，而是**改动前后失败清单是否逐条一致**。
3. **bash 的 `grep` 在本环境会静默返回空**（尤其 `\|` 交替式）。一律用 Grep 工具 + `ls`。
4. **`node --test test/` 会 `MODULE_NOT_FOUND`**，必须 `test/*.test.mjs`。
5. **构建产物里中文是 `\uXXXX`**，查字符串要同时查原文和两种转义。
6. 长任务别用前台 `sleep` 链（会被 SIGTERM 截断，exit 137），输出重定向到文件再读。
7. **`.git/index.lock` 会留下孤儿锁**（沙箱里跑 `git status` 也会造）。判据：0 字节 + 无进程持有
   ⇒ 用 `mv` 挪走（沙箱拦 `unlink` 但不拦 `mv`），别用 `rm`。
8. **`tmptest/` 是测试残渣**（133 个目录 / 9.3 MB），已加进 `.gitignore`，别提交。
9. **别用「一张巨图切 N 刀」出帧图**。0.41 之前是 2480×21150 ≈ 52MP 的整页截图按坐标切，
   第 11 帧起**顶端缺一截**（静默错位，不报错）。现在 `shoot.mjs` 是**逐帧一页一页截**
   （`frames/NN.html` → `mN.png`，1182×642 @2x），坐标不用算了。

---

## 8. 产物在哪

| 产物 | 路径 |
| --- | --- |
| 静态预览 HTML | `.build/preview/diary-preview.html` |
| 单帧 HTML（**17 帧**，出图 / 量几何的输入） | `.build/preview/frames/01.html` … `17.html` |
| 十七帧模块图 | `.build/preview/m1.png` … `m17.png`（2 倍图） |
| ↳ 帧号对照 | `m1` 按时间 · `m11` 按书本 · `m12` 按文章 · `m13`–`m15`「挂到书」三态（刚选完书 / 读过目录 / 没有目录）· **`m16` 打开就自动匹配 · `m17` 书不在书架** |
| 量几何（整体） | `node .build/preview/measure.mjs`（JSON：`cols` / 对齐 / 选中格 computed 值） |
| **量侧栏几何（0.41）** | `node .build/preview/measure-sidebar.mjs`（切换器 / 三档宽度 / 横向溢出 / 胶囊与行右缘 / **压扁面板滚到底后切换器是否还钉住**） |
| **侧栏反向对照** | `node .build/preview/check-sidebar-mutant.mjs`（挖掉 `flex` / `nowrap` / **`sticky`**，三条各自必须变红） |
| 量浮层几何 | `node .build/preview/measure-link.mjs`（**五帧** 13–17：卡片 / body / 两个列表 / 行高；末行打印判据） |
| **自动匹配反向对照（0.42）** | `node .build/preview/check-linkpick-mutant.mjs`（改的是**源码**：挂 SIGINT/SIGTERM 先还原，跑完逐字节比对原文件） |
| 浮层反向对照 | `node .build/preview/check-link-mutant.mjs`（挖掉两条 CSS 守卫，各自必须变红） |
| 出图 | `node .build/preview/shoot.mjs`（逐帧截图；自带「三列必须是三列」闸门） |
| 过期交接文档 | `.build/archive/HANDOFF-diary-0.32.0.md`（**别再照它做**） |
| 需求 / 调研 | `WorkBuddy_Test/dsh-npie-reader-日记功能_{需求推演,架构定稿,GitHub调研,GitHub二次调研}_20261026.md` |

★ **整个 `.build/` 在 `.gitignore` 里**（第 17 行），预览工具链与图都**不进版本库** ——
换台机器 clone 下来是没有这些的。它们只在这台机器上可复现。
`measure-sidebar.mjs` / `check-sidebar-mutant.mjs` 是 0.41 新加的；
`cut.mjs`（按 `frames.json` 裁 `m*.png`）在逐帧截图之后**已不再需要**，留着只作历史参考。

---

## 9. 建议的接手顺序

1. 跑 §1 三条命令 + 两条侧栏量测，确认 376 绿、类名 0 缺口、构建过、`ALL OK`。
2. 重启 DSH，按 §4 的 P0-1 表逐项过。**优先第 5/6/7 项（0.41 的切换器 / 二级展开 / 截断）
   和第 13 项深色主题** —— 它们是这一轮唯一没被任何测试覆盖到的部分；
   其次第 8/9 项（挂到书），那是上一轮遗留的。
3. 真机有问题就改，改完回到 §1 复跑（别只看图）。改 CSS 后**顺手补一条变异**，
   否则下一次「去掉这行样式」谁也不会发现。
4. 真机过了再做 P1，一次一个，每个都配用例 + 变异验证。
