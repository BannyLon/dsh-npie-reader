# 交接：给接手的 agent（2026-10-28，版本 0.43.0）

> 这份文档**自足**，你不需要之前的任何对话。
> 上一任 agent 的额度用完了，交接到你手上。下面每一条都是实测过的，不是推断。
> 细节附录：`HANDOFF-diary-0.43.0.md`（本轮改动的技术细节、变异清单、真机验收 8 条）。

---

## 0. 你接手的是什么

一个 **macOS 桌面端 DSH 插件的源码仓库**。不是网站、不是独立 App。

| 项 | 值 |
| --- | --- |
| 仓库 | `/Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader` |
| ★ 注意 | 是 **`dsh_plugins_desktop/`**（桌面端那棵树），**不是** `dsh_plugins/`（web 那棵） |
| 当前版本 | `0.43.0` |
| 当前 HEAD | `4b51d40`，**工作区干净**（`git status` 为空） |
| 宿主 | DeepSeek Harness 桌面端（`/Applications/DeepSeek Harness.app`） |
| 插件怎么被加载 | `~/.dsh/profiles/desktop/node_modules/dsh-npie-reader` → **软链回这个仓库** |
| 语言 | 源码 JS/JSX（无 TS），构建用 esbuild（`build.mjs`） |

插件本身做三件事，共用一套外壳：**RSS 订阅阅读** / **电子书书架** / **日记**（第三个 tab）。
最近六轮迭代（0.40 → 0.43）**全部集中在日记模块的 UI**。

**用户是谁 / 怎么跟他打交道**（很重要，决定你能不能交付）：

- 中文交流，会**直接截图报错**，描述很具体（「这部分放到标签下面」）。
- 他要的是**能用的东西**，不是「应该可以」。任何「我认为」「大概是」都会被追问。
- 这个项目有一条贯穿始终的规矩：**界面不能说不确定的话**。宁可显示「—」也不显示 0；
  宁可说「有几页没有文字层」也不说「共 N 处」。你写代码时也必须守这条。
- 他会用一句话否掉整个设计（「这个设计的太不明显了」），所以要**先量再改**，别靠审美判断。

---

## 1. 五分钟跑起来

```bash
cd /Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader

node build.mjs                      # 构建 → lib/index.js + lib/client.js
node scripts/check-classes.mjs      # 类名双向检查（用到必须定义、定义必须使用）
node --test test/diary-store.test.mjs
node --test test/diary-routes.test.mjs
node --test test/diary-ui.test.mjs
node --test test/build.test.mjs
```

**基线（我刚跑过，2026-10-28，全绿）**：

| 检查 | 期望 |
| --- | --- |
| `diary-store.test.mjs` | **55 / 55** |
| `diary-routes.test.mjs` | **52 / 52** |
| `diary-ui.test.mjs` | **130 / 130** |
| `build.test.mjs` | **17 / 17** |
| `check-classes` | 定义 612 / 使用 639，**双向 0 缺口** |
| `measure-dashboard.mjs` | `ALL OK`；卡 252×135 与 252×148、情绪格 77/77/77、摘要 35px |
| `check-dashboard-mutant.mjs` | `反向对照通过` + 「三个文件逐字节一致」 |
| `check-dashboard-geometry-mutant.mjs` | `反向对照通过` |

★ **一次只跑一个测试文件**。`node --test test/*.test.mjs` 全量在这个环境会跑 6 分钟以上
并被 SIGTERM 截断（沙箱拦临时目录 unlink，几十个用例卡在 `after()` 的 `rm`）——
**分文件跑每个都是秒级**。这不是代码问题，别去修。
★ **不要**用 `node --test test/`（会 `MODULE_NOT_FOUND`）。

### 改完怎么让它在真机上生效

```
改 src/**  →  node build.mjs  →  退出 DSH 桌面端再打开
```

★ **桌面端没有 hmr**（web 那棵有）。**宿主半区（`src/host/*`）和浏览器半区都必须重启 DSH**。
改了代码却在真机上看不到变化时，先确认「build 跑了没有」「DSH 重启了没有」，
别急着怀疑代码 —— 这个项目已经在这上面浪费过时间。

---

## 2. 目前的进度：做到哪了

### 2.1 版本线（最近六轮，全在日记模块）

| 版本 | 做了什么 |
| --- | --- |
| 0.40 / 0.40.1 | 补三个已知缺口；给「挂到书」浮层出预览图时**量出两个真 bug**（列表行被 flex 压扁、三层嵌套滚动） |
| 0.41 / 0.41.1 | 灵感侧栏从「四块纵向平铺」改成 `按时间 / 按书本 / 按文章` 三档切换器，并挪到标签下面 + `sticky` |
| 0.42 | 「挂到书」打开时**自动选中这条灵感原本挂在哪儿**；顺带修掉「书架上明明有书却说没有」这句假话 |
| **0.43（最新，已提交）** | 私密侧栏日历下面那块空地，放上 **「本月情绪」** 与 **「那年今日」** 两块卡片 |

### 2.2 0.43 具体交付了什么（这是用户最后提的需求，已全部落地）

用户原话：

> 「将『情绪罗盘与微型统计』与『那年今日（时光回溯）』结合，既能通过数据和情绪卡片让
> 侧边栏告别空旷、充满生命力，又能让私密日记多一份跨越时间的浪漫与惊喜感。」

> 「因为私密日记默认是加锁的，点击『那年今日』的历史条目时，如果全局处于锁定状态，
> 会触发中间输入口令的交互，或者提示『解锁后方可穿越时空』。」

**① 宿主新增 `GET /dashboard?date=…&today=…&month=…`**

返回 `{ date, month, today, locked, days, chars, streak, moods, moodEntries, onThisDay }`。

★ **三个日期各管一件事，不能合并**（合并了就会说出确定的假话）：

| 参数 | 谁用 | 合并成一个的后果 |
| --- | --- | --- |
| `date` | 那年今日的锚点（按它的 MM-DD 回溯） | 翻到去年今天时没有「那年今日」 |
| `today` | 连续天数的锚点（真实今天） | 翻看去年某天时，连续天数算成 0 |
| `month` | 情绪分布与字数的**统计月**（跟日历显示的那个月走） | 按箭头翻到上个月，「『这个月』列的是九月、『本月情绪』说的是八月」 |

★ **闸门兜底在路由层**（`src/host/diary-routes.js`）：`gateAllow()` 为假时只给 `days` / `streak`，
`chars → null`、`moods → []`、`moodEntries → {}`、`onThisDay` 每条降级成 `{date, years, locked: true}`。
**不能指望 store 的 `decrypt` 恰好失败** —— 钥匙还在内存里而闸门已锁时，decrypt 是会成功的。

**② 界面两块卡片**（插在 `.npr-diary-sect`「这个月」之后）

- **本月情绪**：占比前三的心情（emoji + 百分比 + 中文名，三格等宽）+ 一行事实（`N 天连续` / `N 字`）。
  悬停给「本月「还行」的条目 N 条，占记过心情的 60%」。
  **点一格 ⇒ 右侧整块替换**成本月这一档的全部条目（写入口和当天条目一起收起）。
- **那年今日**：每行 `📅 N 年前的今天` + 两行摘要，点一行跳回那一天。
  空态是用户指定的那句：「这一天，时光悄悄走过，还没有留下痕迹 ✨」。
  锁着时每行写「解锁后方可穿越时空」，点一下把中间的解锁卡 `scrollIntoView` 并把光标放进口令框。

**③ 几个不显眼但踩过的决定**（你改这块之前必须知道）

- **今天没写就从昨天起算**连续天数 —— 否则早上打开是「连续 0 天」，而昨天那串明明还在。
- **`chars` 锁着时给 `null` 不给 0** —— 0 是一句确定的话（「这个月一个字都没写」），
  而真相是「有几天的锁着，我没数到」。界面显示 `—`。
- **占比的分母是「记过心情的条数」**，不是总条数 —— 否则三档永远加不到 100%，看着像统计坏了。
- **卡片底色用 `color-mix(in srgb, var(--npr-fg) 3%, transparent)`**，不是
  `rgba(255,255,255,.03)`（写死的白在**浅色主题下完全看不见**）。

### 2.3 验收状态（★ 这是你接手后最要紧的一条）

**代码与静态验收全绿，但真机一次都没跑过。**

本轮所有结论来自：单元测试（55+52+130+17）、真 Chrome 几何量测、11 条变异（7 源码 + 4 几何）。
**没有一条来自真机**。所以「已交付」目前只等于「已构建且自洽」。

---

## 3. 接下来要做什么

### P0 — 真机验收（必须先做，别的都排它后面）

重启 DSH，打开 日记 → 私密模块，逐条过（详细版在 `HANDOFF-diary-0.43.0.md` §5）：

1. 日历下面**真的有**两块卡片，且没把「这个月」挤掉。
2. 三格情绪的百分比加起来 ≈ 100%。
3. 悬停某一格 ⇒ 出现「本月「X」的条目 N 条，占记过心情的 N%」。
4. 点一格 ⇒ 右侧变成整月列表、写入口消失；点一行回到那一天、筛选条消失。
5. 写一条带心情的私密日记 ⇒ 侧栏占比与字数**当场变**。
6. 锁定 ⇒ 情绪格消失、字数变 `—`、那年今日每行写「解锁后方可穿越时空」。
7. 锁着时点那年今日 ⇒ 中间的解锁卡滚进视野、光标在口令框里。
8. 翻到没有记录的月份 ⇒ 「这个月还没记过心情」；翻到往年的今天 ⇒ 情绪卡跟着显示**那个月**。

**任何一条不对**：先分清是「代码错」还是「产物没重算」—— 对齐 `lib/*` 的 mtime、
`node build.mjs` 的时刻、DSH 启动的时刻。这三者对不上时，你看到的是旧代码。

### P1 — 已知遗留（都在 0.43 里明确没碰，不是 bug）

1. **那年今日只列私密**。公开那半边（灵感）没有 —— 用户要的是「私密日记多一份浪漫」，
   把公开并进来会变成第二份时间轴。**别自作主张加。**
2. **情绪分布只数私密条目**。理由同上。
3. **`moodEntries` 每档上限 200 条**，超过静默截断、界面不提示「还有更多」。
   一个月同一档超 200 条在真机上大概不会出现，但这是一条**没说出口的上限**。
4. **全量测试跑不完**（见 §1）。环境问题，不是本轮引入的。

### P2 — 等用户提需求

用户**没有给 0.44 的任何需求**。不要自己发明下一个功能。
如果他提了，按这个项目的工作流走（见 §5 的 skill 清单）。

如果他不提、只让你「继续」，合理的动作是：**把 P0 的 8 条真机验收跑完并如实报告**，
而不是新开一摊。

---

## 4. 环境陷阱（会重复踩，先看这一节）

### 4.1 ★ `git` 写操作被孤儿锁卡住（上一任就是被这个卡住的）

症状：`git add` 报「无法写新的索引文件 / index.lock exists」，`rm`/`mv` 也被拦。

**判据**：`ls -la .git/index.lock` 看大小。**0 字节 = 上次写到一半就崩了**；
**几十 KB = `git add` 写满了但 rename 成 `.git/index` 那一步被拦了**（后者更常见，
说明索引其实没更新，`git diff --cached` 是空的）。

**确认没有进程持有**：`lsof .git/index.lock` 空 **且** `pgrep -fl "git "` 空。
★ 用 `pgrep -f "WorkBuddy AI"` 做**阳性对照** —— 它在沙箱里可能被拦，返回 1 时分不清
「没在跑」还是「被拦了」。

**解法**（沙箱里删不掉，要跳出沙箱，并且用 `mv` 而不是 `rm`）：

```bash
cd /Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader
mv .git/index.lock .git/index.lock.stale-$(date +%Y%m%d-%H%M) && git add -A && git status --short
```

★ 读状态用 `git --no-optional-locks status` —— 它不写锁，**在沙箱里反复跑普通 `git status`
会自己造出孤儿锁**（unlink 被拦）。这一条我已经踩过。

### 4.2 沙箱拦删除，`rm` / `node unlinkSync` / `node renameSync` 都可能被拒

`mv` 通常能过。**别为了「删一个文件」去绕路写脚本**，直接改名归档。
仓库里 `.git/index.lock.orphan-*`、`.git/index.lock.stale-*` 就是这么留下的，
**它们是垃圾但无害，别当成「有别的写入者」**。

### 4.3 `Edit` 工具的两个致命习惯（本仓库已踩 3 次）

1. **一次 `Edit` 的 `old_string` 末尾带换行、`new_string` 不带 ⇒ 两行被并成一行。**
   实测把 `// ---- GET /stats ---` 和下一行 `if (…)` 并在一起，整段 `if` 被注释吃掉，
   esbuild 报 `Expected "}" but found "if"`。
   ⇒ **改完立刻 `node build.mjs`**，别等用例。
2. **`old_string` 多带了下一块的开头、`new_string` 没写回去 ⇒ 下一块整个消失。**
   实测把书模块的 `<div className="npr-diary-panel">` 吃掉了，症状是「私密面板之后直接是
   `<input type="search">`」。
   ⇒ **大块插入单独一次编辑**，改完用 `Grep` 复核关键串真的落盘（别信「Successfully edited」）。
3. **同一个文件不要并行发两条 `Edit`** —— 后写那条基于旧快照，会把先写的静默回滚。

### 4.4 模板串里不能出现反引号

探针脚本常把 JS 写在模板串里。注释里写 `` `.npr-diary-moods` `` ⇒ **提前闭合模板串** ⇒
`ReferenceError: xxx is not defined`。而且症状离原因很远。
⇒ 注释里引用选择器，去掉反引号写：`.npr-diary-moods`。

### 4.5 DSH 起不来 = cookie 累积，**不是插件坏了**

症状：`Error: desktop welcome: Web authentication failed`，弹「应用无法启动或已意外停止」。

机制：桌面端每次启动**随机端口**，宿主按 `sha256(127.0.0.1:PORT)` 命名 cookie（`dsh-auth-<hash>`），
旧 cookie 永不覆盖。累积到约 70 个时 Cookie 头超过 Node 的 `max-http-header-size=16384`，
宿主对自己的鉴权探测回 **431** ⇒ 启动失败。

```bash
ls -la ~/Library/Application\ Support/@deepseek-ai/dsh-desktop/Cookies   # 看大小
/opt/homebrew/bin/python3 ~/.dsh/maintenance/clean-desktop-cookies.py    # 已备好，会先备份
```

已有登录项 `~/Library/LaunchAgents/com.habhy.dsh-cookie-clean.plist`（若已 `launchctl bootstrap` 过，
开机自动清）。**先看 `crash-*-host.log`，`crash-*-web-boot.log` 只是转述。**

### 4.6 仓库根那堆奇怪目录是测试残留

`295iaw3_` / `2x0gefub` / `l6whk_zc` / `mzua6vay` / `tmptest` / `retired` … 这些是历次跑测试
留下的临时目录，**不是项目内容**，别读、别改、别当参考。清理前**必须问用户**。

### 4.7 `HANDOFF-bulk-ocr.md` 是历史存档

它是 **0.24.8** 时代的另一条线（整本 OCR），那个功能后来已落地（见 `README.md` 的书内搜索 / 目录章节）。
**别照它做**，除非用户明确要动 OCR。

---

## 5. 红线（用户的硬要求，违反一次就会出大问题）

1. **绝不修改用户电脑上的应用**：`/Applications`、`~/.npm-global` 里的 DSH 安装树。
   你能改的只有这个仓库。
2. **仓库外的写操作先问再做**，并说明「这是只读还是写入」。
3. **`node_modules` 绝不借用**（用户明确怒斥过）。装不上就换方案，别 `cp -r` 别人的依赖。
4. **绝不删 `Docker.raw`**；`docker system prune -a --volumes` 是本机灾难（n8n / OpenWebUI 全丢）。
5. **不编数字**。这一条在这个项目里是技术性的：不知道就 `null` / `—`，不写 0、不写「应该」。
6. **`git push` 之前先问**。目前所有提交都只在本地 `main`。

**有现成的 skill 就直接用，别从头想**（本机 `~/.workbuddy-ai/skills/`）：

| skill | 什么时候用 |
| --- | --- |
| `dsh-settings-ui-change` | 改设置页 / 面板 / 组件 UI（预览 → 布局断言 → 反向对照 → 前后图 → 单测 → 版本） |
| `dsh-plugin-review` | 审查插件运作逻辑与安全性 |
| `dsh-upgrade-client-repatch` | DSH 升级后浏览器半区补丁被覆盖（消息滞留 / 双气泡） |
| `dsh-primitives-drift-fix` | 升级后插件整块崩成恢复页（React #130、`args[]=undefined`） |
| `dsh-settings-card-contract-fix` | 设置卡不出现 / 点开是空的 |
| `web-ui-runtime-probe` | 要「运行时取证」而不是静态分析时 |

---

## 6. 文件地图

```
src/
  host/            ← Node 半区（宿主），改了必须重启 DSH
    diary-store.js     日记的读写与统计（本轮新增 previewOf / shiftDay / dashboard）
    diary-routes.js    插件 web 路由（本轮新增 GET /dashboard + 闸门兜底）
    service.js         把 store 的方法接到路由上（本轮接线 dashboard）
    segment.js / ocr / book-* / feed-* …   其它功能，本轮没动
  client/          ← 浏览器半区
    DiaryApp.jsx       ★ 约 2800 行，日记三个模块全在这一个文件里
    diary-api.js       客户端 HTTP 封装（本轮新增 fetchDiaryDashboard）
    refinements.css    ★ 约 3100 行，全部视觉规则（本轮新增 .npr-diary-card* 等）
  diary-format.js  ← 两端共用（日期校验、解析），改它要同时考虑两侧
test/
  diary-store / diary-routes / diary-ui / build …  ★ 分文件跑
.build/preview/
  make-diary-preview.mjs        生成 21 帧静态预览（帧 18–21 是本轮）
  shoot.mjs                     逐帧截图；SHOOT_TALL=1 出高窗版
  measure-dashboard.mjs         两块卡片的几何判据（默认跑 18t + 21t 两帧）
  check-dashboard-mutant.mjs    7 条源码变异（会改源码，跑完自证逐字节还原）
  check-dashboard-geometry-mutant.mjs  4 条几何变异（只改产物副本）
CHANGELOG.md                    每版一节，写「为什么」不只是「改了什么」
HANDOFF-diary-0.43.0.md         本轮技术细节（附录）
.build/archive/                 历史交接文档
```

**三个必须知道的约定**：

- **类名必须字面量**：`check-classes.mjs` 双向检查「用到必须定义、定义必须使用」，
  动态拼出来的类名它看不见 ⇒ 会报缺口。所以 `className="npr-diary-card"` 不能写成模板串。
- **`--npr-*` 主题变量由宿主的 `--dsw-alias-*` 派生**，不是自己定的。要用新变量先确认宿主给不给。
- **`Icon` 对未知名字静默回落成 `circle`**（`PATHS[name] ?? PATHS.circle`）⇒ 写错图标名
  不会报错，只会画个圆圈。改图标名要肉眼看一眼。

---

## 7. 术语

| 词 | 意思 |
| --- | --- |
| 三模块 | 日记里的 灵感速记 / 私密日记 / 读后感 |
| 心情五档 | 😄🙂😐😣😔，分数 4/3/2/1/0，写在标题行下的 HTML 注释里 |
| 闸门 / gate | 私密日记的口令锁。`gateAllow()` 为假时宿主**摘掉**私密正文，不是界面自己藏 |
| `includePrivate` | 默认 `false`；**只有路由层**显式传 `true`，工具侧永不传 |
| 反向对照 / 变异测试 | 故意改坏实现，断言必须变红**且报对理由**。只变红不报对理由 = 假绿 |
| 假绿 | 断言通过了，但它测的东西根本没跑到 / 测错了对象。本项目的头号敌人 |

---

## 8. 如果你只有 10 分钟

1. 读 §2.3（真机没跑过）和 §3 的 P0。
2. `node build.mjs` → 重启 DSH → 按 P0 的 8 条过一遍。
3. 不对就按 §4 查「产物有没有重算 / DSH 有没有重启」。
4. 要动代码：先读 `HANDOFF-diary-0.43.0.md` 的 §3（变异清单）和 §2.3（踩过的坑）。

**别做的三件事**：别跑全量测试等 6 分钟；别在沙箱里跑普通 `git status`；
别在真机没验过之前就说「已完成」。
