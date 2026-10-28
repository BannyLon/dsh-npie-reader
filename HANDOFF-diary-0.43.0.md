# 交接：日记三个模块（0.43.0）—— 代码与静态验收已完成，**只差真机**

> 自足的，不需要之前的对话。
> **仓库**：`/Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader`
> **注意是桌面端那棵树**（`dsh_plugins_desktop/`），不是 `dsh_plugins/`。
> **版本**：`0.43.0`。**git**：0.29–0.42.0 已全部提交，0.43 见 `git log`。
> **上一份交接**（`.build/archive/HANDOFF-diary-0.42.0.md`）已被这份取代 —— 它的历史结论都
> 抄进了 `CHANGELOG.md` 的 0.42.0 一节，要考古看那里，别照它做。

---

## 0. 一句话现状

用户对日记页提过的所有具体批评**都已落地**。版本线：

- 0.40 / 0.40.1：补最后三个已知缺口；给「挂到书」浮层补预览图时**量出两个真 bug**
  （列表行被 flex 压扁、三层嵌套滚动）。
- 0.41 / 0.41.1：灵感侧栏从「四块纵向平铺」改成 `按时间 | 按书本 | 按文章` 三档切换器，
  并把它挪到标签下面 + `sticky`。
- 0.42：让「挂到书」自动匹配这条**原本挂在哪儿**，顺带修掉「书架上明明有书却说没有」。
- **0.43（本轮）：私密侧栏日历下面那块空地，放上「本月情绪」与「那年今日」。**

**下一步只有一件事：重启 DSH，在真机上把这些过一遍。** 这一轮所有结论都来自
单元测试 + 静态预览，**真机一次都没跑过**。

★ 桌面端**没有 hmr**，宿主半区（`src/host/*`）改动**必须重启 DSH** 才生效；
浏览器半区改了要重新 `node build.mjs`（桌面端也不热更）。

---

## 1. 30 秒上手

```bash
cd /Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader

node build.mjs
node scripts/check-classes.mjs
node --test test/diary-store.test.mjs
node --test test/diary-routes.test.mjs
node --test test/diary-ui.test.mjs
node --test test/build.test.mjs
```

★ **一次只跑一个文件**。这个环境里 `node --test test/*.test.mjs` 全量会跑成
6 分钟以上并被 SIGTERM 截断（沙箱对临时目录的 unlink 被拦，几十个用例各自卡在清理上），
**分文件跑每个都是秒级**。

0.43.0 实测期望值：

| 检查 | 期望 |
| --- | --- |
| `diary-store.test.mjs` | **55 / 55**（14 suite；含新增 `dashboard：本月情绪 + 那年今日` 6 条） |
| `diary-routes.test.mjs` | **52 / 52**（16 suite；含新增 `GET /dashboard` 5 条） |
| `diary-ui.test.mjs` | **130 / 130**（31 suite；含新增 `0.43：私密侧栏的「本月情绪」与「那年今日」` 9 条） |
| `build.test.mjs` | **17 / 17**（产物级：类名真的进了 `lib/client.js`） |
| `check-classes` | 定义 **612** / 使用 **639**，**双向 0 缺口**，4 个白名单语义钩子 |
| 构建 | host **576.7 KB** / client **1181.3 KB** / vendor/editor 373.8 KB |
| 预览帧数 | `node .build/preview/make-diary-preview.mjs` ⇒ **21 帧** + 3 张高窗单帧页 |
| **卡片几何（0.43）** | `node .build/preview/measure-dashboard.mjs` ⇒ `ALL OK`：卡宽 **252**（面板内容宽）、卡1 135px、卡2 148px、情绪格 **77/77/77**、摘要 **35px**（行高 17.25 × 2 行）、卡片底色盖上去差 **7/255** |
| **卡片反向对照（源码）** | `node .build/preview/check-dashboard-mutant.mjs` ⇒ `反向对照通过`（**7 条**变异各自变红且理由对，跑完打印「三个文件逐字节一致」） |
| **卡片反向对照（几何）** | `node .build/preview/check-dashboard-geometry-mutant.mjs` ⇒ `反向对照通过`（**4 条**变异） |
| 侧栏几何（0.41/0.41.1） | `node .build/preview/measure-sidebar.mjs` ⇒ `ALL OK`，打印 `滚动 277px 后：条顶 194 → 76（面板顶 76）` |
| 浮层几何（0.40.1/0.42） | `node .build/preview/measure-link.mjs` ⇒ `ALL OK`（五帧） |
| 浮层反向对照 | `node .build/preview/check-linkpick-mutant.mjs` ⇒ `反向对照通过` |

**不要**用 `node --test test/`（`MODULE_NOT_FOUND`），要 `test/*.test.mjs`。

---

## 2. 0.43 做了什么

用户原话：

> 「将『情绪罗盘与微型统计』与『那年今日（时光回溯）』结合，既能通过数据和情绪卡片让
> 侧边栏告别空旷、充满生命力，又能让私密日记多一份跨越时间的浪漫与惊喜感。」

> 「因为私密日记默认是加锁的，点击『那年今日』的历史条目时，如果全局处于锁定状态，
> 会触发中间输入口令的交互，或者提示『解锁后方可穿越时空』。」

### ① 宿主：`GET /dashboard?date&today&month`（新）

**不往 `listMonth` 里塞**：那个方法跑在**每一次翻月**上，不该为了侧栏去解密整月的正文。

返回 `{ date, month, today, locked, days, chars, streak, moods, moodEntries, onThisDay }`：

- `moods`：`[{ score, count }]`，按条数降序、同数按分档降序，**只数记过心情的条目**
  （没选心情的不进分布 —— 拿总条数当分母会让三档加起来永远不到 100%，看起来像统计坏了）。
- `moodEntries`：`{ '4': [{ date, time, preview }] }`，每档最多 200 条，`preview` 是压掉空白
  的前 60 字（侧栏 268px 放不下正文）。
- `streak`：**只靠文件名**数，所以锁着也照样给。★ **今天没写就从昨天起算** ——
  直接从今天数的话，早上打开会看到「连续 0 天」，而昨天那一串明明还在。
  跨月也照数（用例里 03-02 → 03-01 → 02-28 是 3 天）。
- `chars`：解不开时给 **`null`**（不知道），**不是 0**。0 是一句确定的话：
  「这个月一个字都没写」—— 而真实情况是「有几天的锁着，我没数到」。
- `onThisDay`：同一个「月-日」、**更早的年份**、最多 5 条，只取第一条的摘要。

★ **三个日期各有所指，不能合并成一个参数**：

| 参数 | 谁用 | 不传会怎样 |
| --- | --- | --- |
| `date` | 那年今日的锚点（按它的 MM-DD 回溯） | 翻到去年今天时没有「那年今日」 |
| `today` | 连续天数的锚点（真实今天） | 翻看去年某天时连续天数算成 0 |
| `month` | 情绪分布与字数的**统计月**（跟着日历显示的那个月走） | 按箭头翻到上个月却没点任何一天时，「『这个月』列的是九月、『本月情绪』说的是八月」 |

★ **闸门必须在路由层兜底**（`diary-routes.js`）：`gateAllow()` 为假时只给 `days` / `streak`，
`chars → null`、`moods → []`、`moodEntries → {}`、`onThisDay` 每条降级成
`{ date, years, locked: true }`。**不能指望 store 的 `decrypt` 恰好失败** ——
万一钥匙还在内存里而闸门已经锁上，decrypt 是会成功的。用例里那条反向对照就是
「同一个 store、同一个请求，只翻 `allow` 这一位」。

### ② 界面：两块卡片

**本月情绪**（`.npr-diary-card`，排在「这个月」之后）：

- 占比前三的心情：emoji + 百分比 + 中文名，三格等宽铺满。
- 悬停 Tooltip：「本月「还行」的条目 N 条，占记过心情的 60%」。
- 底下一排事实：`N 天连续` / `N 字`（锁着时字数显示 `—`）。
- **点一格 ⇒ 右侧整块替换**成本月这一档的列表（写入口和当天条目一起收起 ——
  两块同时在场，人会以为下面那堆也属于这个筛选）。点一行回到那一天。
- 退出筛选的四个入口：再点同一格 / 换天（`pick()`）/ 切模块 / 上锁（`lockNow()`）。

**那年今日**：

- 每行 `📅 N 年前的今天` + 两行摘要（`-webkit-line-clamp: 2`），点一行回到那一天。
- 空态照抄需求那句：「这一天，时光悄悄走过，还没有留下痕迹 ✨」。
- 锁着时那一行写「解锁后方可穿越时空」，点一下 `askUnlock()`：把中间的解锁卡
  `scrollIntoView` 并把光标放进 `input`（**不自己再画一个口令框** —— 中间那块已经在那儿了）。

★ 卡片底色用 `color-mix(in srgb, var(--npr-fg) 3%, transparent)`，**不是**
`rgba(255,255,255,.03)`：写死的白在浅色主题下**完全看不见**（白底 + 白 3%）。
`measure-dashboard.mjs` 那条判据算的是「盖上去之后肉眼差多少」（7/255），
不是比字符串 —— 比字符串的话 `color(srgb …)` 与 `rgb(…)` 永远不相等，断言恒绿。

### ③ 踩过的坑（都是自己踩的）

1. **编辑工具把两行并成一行**：一次 `Edit` 的 `old_string` 末尾带了换行、`new_string` 没带，
   结果 `// ---- GET /stats ---` 和 `if (parts.length === 1 …)` 并到同一行，
   整段 `if` 被注释吃掉 ⇒ esbuild 报 `Expected "}" but found "if"`。
   **改完立刻 `node build.mjs`**，别等用例。
2. **同一次 `Edit` 把下一块的 JSX 开头吃掉**：`old_string` 里多带了 `) : (` 之后那三行，
   `new_string` 没写回去 ⇒ 书模块的 `<div className="npr-diary-panel">` 整个消失。
   症状是「私密面板之后直接是 `<input type="search">`」。**大块插入要单独一次编辑**。
3. **模板串里的注释不能出现反引号**（第二次踩）：`measure-dashboard.mjs` 的探针写在
   模板串里，注释里写了 `` `.npr-diary-moods` `` ⇒ 提前闭合 ⇒ `ReferenceError: diary is not defined`。
4. **几何判据的夹具必须够长**：摘要截断那条，第一版夹具文字只有 28 字，在那个宽度下
   恰好两行 ⇒ 把 `line-clamp: 2` 改成 8 也**照样绿**。换成 60 字（真机上 `previewOf`
   给的就是 60 字）之后才量得出来。
5. **变异锚点要带上下文**：`-webkit-line-clamp: 2` 在 CSS 里不止一处，不带选择器上下文
   会改到别的元素上，然后那条「变异」静默什么都不做。

---

## 3. 反向对照清单（每条都必须变红且理由对）

### 源码变异（`.build/preview/check-dashboard-mutant.mjs`，7 条）

| # | 变异 | 期望报的理由 |
| --- | --- | --- |
| A | `dash.chars === null ? '—'` → `?? 0` | 字数没区分「不知道」与「0 字」 |
| B | 情绪格 `setMoodFilter(cell.score)`（点了收不回来） | 点情绪格没有切换筛选 |
| C | 筛选时不清当天条目 | 筛选时当天的条目列表还在 |
| D | 锁着的「那年今日」直接 `pick()` | 锁着的条目被点了没有分流 |
| E | `slice(0, 3)` → 全取 | 没有只取前三档 |
| F | 卡片底色写死 `rgba(255,255,255,.03)` | 卡片底色没有跟着主题走 |
| G | 连续天数从今天起算（`cursor = today`） | 今天还没写就被判成「断了」 |

★ 这个脚本改的是**源码**，所以信号安全：挂 `SIGINT`/`SIGTERM` 先还原再退出
（`finally` 不覆盖 SIGTERM —— 上一次就是那样把变异体留在盘上而 `npm test` 仍全绿），
跑完逐字节比对三个文件。

### 几何变异（`.build/preview/check-dashboard-geometry-mutant.mjs`，4 条）

改的是**产物副本** `frames/18t-mut.html`（源码一个字节不动）：底色透明 / 情绪格去掉
`flex: 1 1 0` / `line-clamp` 2→8 / 卡片外边距 8px→40px。

---

## 4. 预览与出图

```bash
node .build/preview/make-diary-preview.mjs      # → 21 帧 + 3 张高窗单帧页
SHOOT_TALL=1 node .build/preview/shoot.mjs      # → m01..m21.png + m18/m20/m21-tall.png
```

- 帧 1–17 是 0.40.1–0.42 的，**18–21 是本轮新增**：
  18 私密侧栏两张卡 / 19 点了「本月 😄」之后 / 20 那年今日空态 / 21 锁着时的侧栏。
- ★ **为什么要单独一档高度**（1182×900 的 `m18-tall.png`）：640px 画框里
  「日历 + 这个月 + 两张卡」放不下，第二张会被切在折线下面 —— 而真机上那块正是
  用户说的「日历下方那一整块富余空间」。所以高窗版**专门用来看两张卡一起在场**。
- ★ 高窗版文件名**必须不同**（`m18-tall.png` / `18t.html`）：同名文件被两种参数
  渲染出两种尺寸，任何一次「顺手跑一下默认模式」都会静默换掉交付图。
- `measure-sidebar.mjs` / `measure-link.mjs` 的帧号没变（新增帧都在末尾），
  但**它们量的是默认 640px 帧**，别拿高窗帧去喂。

---

## 5. 真机上要过的 8 件事

1. 私密模块：日历下面**真的有**两块卡片，且没把「这个月」挤掉。
2. 三格情绪的百分比加起来 ≈ 100%（记过心情的条目为分母）。
3. 悬停某一格 ⇒ 出现「本月「X」的条目 N 条，占记过心情的 N%」。
4. 点一格 ⇒ 右侧变成整月列表，写入口消失；点一行回到那一天，顶部筛选条消失。
5. 写一条带心情的私密日记 ⇒ 侧栏的占比与字数**当场变**（`refresh()` 里已接 `loadDash`）。
6. 锁定 ⇒ 情绪格消失、字数变 `—`、那年今日每行写「解锁后方可穿越时空」。
7. 锁着时点那年今日 ⇒ 中间的解锁卡滚到视野里、光标在口令框里。
8. 翻到没有记录的月份 ⇒ 情绪卡说「这个月还没记过心情」；翻到往年的今天 ⇒
   情绪卡跟着显示那个月（**不是**停在今天那个月）。

---

## 6. 关键文件

| 文件 | 本轮改了什么 |
| --- | --- |
| `src/host/diary-store.js` | 新增 `previewOf()` / `shiftDay()` / `dashboard()`；`chars` 锁着时给 `null` |
| `src/host/diary-routes.js` | 新增 `GET /dashboard`（含 `gateAllow()` 兜底降级） |
| `src/host/service.js` | 接线 `dashboard: options => this.diary.dashboard(options)` |
| `src/client/diary-api.js` | 新增 `fetchDiaryDashboard({ date, today, month })` |
| `src/client/DiaryApp.jsx` | `dash` / `moodFilter` 两个状态、`loadDash()`、两块卡片、整月列表、`askUnlock()` |
| `src/client/refinements.css` | `.npr-diary-card*` / `.npr-diary-moods` / `.npr-diary-mood*` / `.npr-diary-facts` / `.npr-diary-fact` / `.npr-diary-echo*` / `.npr-diary-moodview` |
| `test/diary-store.test.mjs` | `dashboard：本月情绪 + 那年今日` 6 条 |
| `test/diary-routes.test.mjs` | `GET /dashboard` 5 条（含「钥匙可用 + 闸门锁着」的反向对照） |
| `test/diary-ui.test.mjs` | `0.43：私密侧栏的「本月情绪」与「那年今日」` 9 条 |
| `.build/preview/make-diary-preview.mjs` | `dashCards()` / `privatePage()` / `gateSection` / 4 帧 / 高窗单帧页 |
| `.build/preview/shoot.mjs` | `SHOOT_TALL=1` 那一档 |
| `.build/preview/measure-dashboard.mjs` | 新（几何判据 9 条 × 两帧） |
| `.build/preview/check-dashboard-mutant.mjs` | 新（7 条源码变异） |
| `.build/preview/check-dashboard-geometry-mutant.mjs` | 新（4 条几何变异） |

---

## 7. 已知遗留（本轮没碰）

- **全量 `node --test test/*.test.mjs` 在这个环境里跑不完**（沙箱拦临时目录 unlink，
  几十个用例卡在 `after()` 的 `rm`）。**不是本轮引入的**：`book-lists` / `book-source` /
  `book-tools` 的 `EPERM: unlink` 与日记无关。分文件跑全绿。
- 那年今日只列**私密**。公开那半边（灵感）没有「那年今日」—— 用户要的是
  「私密日记多一份跨越时间的浪漫」，把公开也并进来会变成第二份时间轴。
- 情绪分布只数**私密**条目。理由同上。
- `moodEntries` 每档上限 200 条（超过就截断，界面不提示「还有更多」）——
  一个月同一档超过 200 条在真机上大概不会出现，但这是一条**没有说出口的上限**。
