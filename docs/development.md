# 开发

> 构建、测试、守卫脚本与内部契约。

---

```bash
npm install
npm run build      # 产出 lib/index.js（host 半区）+ lib/client.js（client 半区）
npm test           # 175 个测试文件 / 4072 条用例，node --test（含一次真构建 + 一次真执行客户端产物 + 一次真渲染组件）
npm run contract   # 与 DSH 宿主的契约守卫，0 ERROR 才算过
npm run check      # build + test + contract（走汇总器，不再 `&&` 短路）
npm run verify     # 9 项门禁**全跑 + 汇总**：上面三项 + 类名 / 对比度 / 菜单禁用态 /
                   # Esc 三层顺序 / 删划线二次确认 / 打包守卫。日志落 test/.build/verify/
npm run verify:all # 再加 5 个重型门禁（侧栏几何 / 书页几何 / 阅读区 / 技能包变异 / 真机 OCR）
npm run verify:list # 列出门禁清单，标明哪些是默认、哪些是重型
npm run verify:pack # 只跑打包守卫：真 `npm pack` → 解包 → 14 项断言（约 30 秒）
npm run verify:pack:self-check  # 反向对照：故意改坏 files（3 个变异体），守卫必须全部变红

npm run verify:layout   # 侧栏的真几何：真 Chrome 量像素（没装 Chrome 时以 2 退出，不静默跳过）
npm run verify:book-layout  # 书页区的真几何：目录在左 / 伴读在右 / 浮层不压工具栏 / 导出块不挤列表（同样需要 Chrome）
npm run verify:transcript-layout  # 单集播放条 + 字幕面板的真几何（720 / 420 两档宽度），七条判据 +
                                  # **四条反向对照**：按钮拉成整行宽 / 标题被挤成竖排 / 右端整组被拆开 /
                                  # 进度条被塞回控制区一行，每条都必须把对应判据打红 —— 任一没红就说明那条判据是假的
                                  # `--shot <file.html>` 可导出夹具给人眼复核（配合 Chrome `--screenshot`）
npm run verify:listen-view  # 收听视图：正文/标题整块 `display:none`、播放条与字幕仍在、列表吃满高度
                            # **两条反向对照**：`data-listen="false"` 时正文必须回来（证明显隐由数据驱动）、
                            # 把 refinements.css 里那条隐藏规则删掉后必须变红（证明判据读的是这份 CSS）
npm run verify:read-tabs    # 文章 / 字幕 / 导读 三选一 + 播客朗读禁用（0.84.6）：真 Chrome 量三态显隐、
                            # 互斥、播放器常驻、播放条在 tab 上方、下划线只在选中项、
                            # tab 无胶囊底座、禁用态 computed style；★ 顶部两态逐项相等：
                            # 标题字号/行高/字距/字重/字体/margin、元信息行字号/颜色/间距、
                            # 元信息→标题与标题→播放条的几何距离、左右边缘（共 14 项 × 两态）；
                            # **六条反向对照**：摘掉放行规则 / 摘掉默认隐藏规则 / 摘掉 :disabled
                            # 规则 / 把下划线改成透明 / 把标题共用规则拆回单选择器 /
                            # 把收听头旧样式写回去，每条都必须把对应判据打红
npm run verify:layout:all   # 上面四套几何一起跑（★ 走 `--all`：这几项都在**重型**表里，
                            # 只写 `--only` 会一项都选不到、直接以「没有匹配的门禁」退出 1）
npm run verify:book-skill-mutants  # 15 个变异体：把「导出 skill 包」那一层的判据逐条打掉，确认用例真的变红
                                   # ★ 先跑一遍「不带变异」的基线，基线红的文件整组跳过并写明原因
                                   # 退出码：0 = 全部抓住 · 1 = 有漏网的 · 2 = 有变异体没验证（不是通过）
                                   # ★★ 它跑的时候会**原地改写源码**。这期间不要 `npm run build`：
                                   #    build.mjs 有两道闸（日志 running 拒绝构建 + 构建后扫变异体特征串），
                                   #    但闸门只是最后一道防线 —— 别指望它替你把产物修好。

npm run verify:build-guard        # 反向对照：把 writeSkill 那行真删换成 `void dir;`，构建**必须**被拒绝
                                   # 退出码：0 = 闸门有牙 · 1 = 闸门失效（构建照常通过）· 2 = 锚点没了

npm run verify:escape             # Esc 的三层顺序：真 Chrome + 真 React 组件 + 真 KeyboardEvent。

npm run verify:ocr-live <图片路径>  # 本地 OCR 的真机探针：脚本路径真的存在 + 真的能认出字。
                                   # **不进 npm test** —— Vision 冷启动要加载模型，实测 26–29 秒
                                   # （热启动 0.5–0.8 秒）。单元测试里 `exec` 是注入的，
                                   # 它证明不了「osascript -l JavaScript 这条路真的通」。
                                   # 不传参数时打印用法并退出 0。
                                   # 验「关下拉菜单不连坐对话框」「Esc 不穿到 window 把设置页一起关掉」
                                   # 「焦点在表单外时不抢 Esc」。含 2 条反向对照（把 document 改成 window、
                                   # 把捕获改成冒泡，都必须变红）。
npm run verify:mark-delete        # 删划线的二次确认：真 Chrome 点两次，验「第一次点击不许删」
                                   # 「确认态只属于被点的那一行」「4 秒后自己复位」。含 1 条反向对照。

node scripts/catalog-health.mjs --limit 40       # 目录体检（小样本先验）
node scripts/catalog-health.mjs                  # 全量抓一遍（两类目录），写 src/data/catalog-health.json
node scripts/catalog-health.mjs --only Newsletter # 只重测一类（几十秒），其余条目原样保留

node scripts/prune-catalog.mjs               # 对「探不通」的降并发复检，出删除计划（不动目录）
node scripts/prune-catalog.mjs --apply       # 按计划裁剪内置目录（先备份到 /tmp，被删的 Newsletter 源先归档）
```

**仓库在 git 下**（0.24.4 起，`git init -b main`，首个提交 `e83ddcf` 是 v0.24.3 基线）。
`.gitignore` 只挡**会变的东西** —— `lib/`（`prepack` 重建）、`test/.build/`（每次重新生成）、
`test/.tmp/`（`mkdtemp` 落点）、`.build/`（出图草稿）、`probe-*/`（探测会话残留），
每条都写了理由。★ 本机专用的「8 字符随机名」规则在 `.git/info/exclude`、**不进共享的
`.gitignore`**：`[a-z0-9_]{8}` 这条模式太宽，写进共享文件会误伤将来任何 8 字符的源文件/目录。

> 体检脚本会**打网络**（每个源一次 GET）但**不碰你的订阅数据**。产出的快照**按类别记测量时间**
> （`checkedAt`），界面用其中**最旧**的那一类判断「过期没有」—— 只重测了一类却报「刚体检过」，
> 就等于拿另一类的过期数据冒充现状。不标日期的测量结果会变成假话。
>
> `prune-catalog.mjs --apply` **拒绝在没有复检记录的快照上执行**：直接按一轮并发抓取的结果
> 删数据，会把「当时被限流」的活源一起删掉，而删掉就没了。
> 删除记录写回各自目录的 `pruned` 与体检快照，并把快照顶层的计数**重算成裁剪后的口径** ——
> 留着裁剪前的计数就是一份自相矛盾的快照。**这一轮一条都没删时，`pruned` 一个字都不改**
> （原样重写会把「上一次真的删了什么」改成「404 → 404」，历史没了、断言也判红）。

### 契约守卫（`scripts/check-host-contract.mjs`）

零依赖。它检查的每一项，对应的错误在运行期**都不报错**：

1. **插槽名** —— 注册到宿主从未声明的插槽，`ctx.slots.inject` 只是永远等不到声明，贡献**无声消失**。
   判据是宿主安装树里 `interface SlotMap` / `interface SlotFactoryMap` 的声明正文，不是字符串 grep。
2. **宿主 DOM 锚点 / CSS Module 类名片段** —— 选择器写错一个字，规则静默不生效。
3. **`dsh.client.inject` 预加载清单** —— 包名拼错 ⇒ 某个能力时有时无。
4. **版本声明纪律** —— `peerDependencies` 不得含 `@deepseek-ai/dsh-*`；`dsh.engines.dsh` 必须是宽松范围。
   `engines.node` 声明**运行时**下限：`>=18`（来自 `AbortSignal.timeout` 的 17.3 与 `structuredClone` 的 17，
   取 LTS 边界）。没有这个字段时，旧 Node 上的症状是「语法全过、API 不存在」，报错点离原因很远。
5. **挂载行契约** —— `cordis.patch.yml` 的行 `name` 必须等于包名。
6. **构建产物** —— 宿主产物会被**真的 `import()`**，并要求导出 `apply`（或 default）与 `inject`；
   ModuleLoader id 与包名一致；react 保持外置（否则会出现两份 react）。
7. **`--dsw-*` 令牌** —— 令牌名写错会让整条声明失效（症状是「hover 没反应」），判据是宿主主题包自己的令牌表。
8. **Host 半区依赖** —— 静态导入未声明的 `@deepseek-ai/*` 包，真机上整个插件 `failed to import`
   （测试若用 esbuild 替身，会把这种错误伪装成绿灯）。

守卫的**牙**由 `test/contract-guard.test.mjs` 证明：它自建一棵最小假宿主树，用 14 条变异逐条制造守卫
声称能抓到的错误（**含宿主侧变异** —— 把插槽声明删掉、把令牌删掉、把锚点改名），要求守卫确实以 1 退出。

> `--strict` 下「跳过项」也算失败。找不到宿主安装树时用 `DSH_INSTALL_ROOT=<path>` 指定。

### 打包守卫（`scripts/check-pack.mjs`）

`npm test` 证明的是「源码里的逻辑对」；这一条证明的是「**装到用户机器上的那包东西**对」。
中间那一步（`files` 白名单 / glob / `.npmignore`）此前没有任何判据，代价是 **0.20 的真实事故**：

> `src/host/ocr-vision.js` 是 `osascript` **直接读**的 JXA 脚本（不进 bundle）。它一度不在
> `package.json → files` 里 ⇒ 源码正常、单测全绿、`npm run dev` 好用，装到用户机器上
> 「扫描识别」永远失败，界面上只有一句 `osascript: …/lib/ocr-vision.js: No such file or directory`。

做法：真 `npm pack`（`--ignore-scripts`，约 30 秒）→ 解包 → 14 项断言。

**★ 判据从代码里问出来，不在这里抄清单。** 路径是拼出来的
（`joinPath(here, '..', 'src', 'host', 'ocr-vision.js')`），产物里根本没有这个整串 ——
实测 `lib/index.js` 里只有 `'..'`、`'src'`、`'host'`、`'ocr-vision.js'` 四段，grep 必然漏报。
所以守卫直接 `import` 源码、**真调** `resolvePdfjsRoot()` / `ocrScriptCandidates()`
（两种运行形态各算一遍候选表），再逐条比对包里的实际文件。抄一份清单的结果只会是：
代码改了、清单没改，守卫从此变成安慰剂。

判的是**双向**：

| 方向 | 判据 | 漏了会怎样 |
| --- | --- | --- |
| 缺 | 源码树里的运行时文件必须全在包里 | 用户装上就坏（上面那 0.20） |
| 多 | 包里每个文件都要说得清为什么在（运行时 / 文档 / 配置 / 署名） | 体积；以及「改了不起作用」（改包里的数据文件，实际生效的是内联副本） |

另外几条只在这一步才看得见的：`vendor/` **全树一致**（pdf.js 按 PDF 里写的名字请求
`cmaps/<x>.bcmap`，名字事先不知道，抽查没用）；`lib/` 里不许有入口没点名的产物
（`build.mjs` 只 `mkdirSync(lib)`、**不清理**，旧产物会被一起发出去）；产物新鲜度
（`src/` 比 `lib/` 新 ⇒ 现在打出来的包不含这次改动）。

**牙**：`npm run verify:pack:self-check` 用 3 个变异体（去掉 `vendor/**/*`、去掉
`src/host/ocr-vision.js`、把 `src/data/*.json` 加回去）要求守卫**全部**变红，跑完还原并自检
md5。守卫坏掉的样子和「一切正常」长得一模一样 —— 它会一直打印 OK，只有变异体能区分这两件事。

> `src/data/*.json` **不进包**：它们由 `Discover.jsx` 静态 import，构建期已内联进
> `lib/client.js`。守卫里有一条**内联自证**（三份目录数据首条内容必须出现在包里的
> `client.js` 里），所以「删掉这条白名单」是有据可依的，而不是「看起来没用就删」。

### 浏览器半区的产物守卫（`test/build.test.mjs` + `test/client-runtime.test.mjs` + `test/book-view.test.mjs` + `test/book-companion.test.mjs`）

上面那 8 组问的是**宿主**半区。**浏览器**半区另有几条，症状同样是「不报错、只是坏掉」：

- **不许出现任何 Node 内建模块**（`node:fs` / `node:path` / `node:os` / `node:url`…）。
  ★ **源码干净不代表打包后干净**：一个间接 import 就能把 shim 拖进来，而它**不会报错**，
  只会在真机上以某种说不清的方式炸。同样禁止漏进来的还有宿主侧的标识符
  （`createPanReader` / `readLibraryIndex`）。
- **pdf.js 必须保持动态导入**（`import(pdfjsAsset("pdf.mjs"))`）。一旦被内联，
  bundle 会从 516 KB 涨到 1 MB 以上 —— 所以断言里同时钉了写法、钉了「产物里不许出现
  pdf.js 源码的标记」，并给了一个体量上限兜底。
- ★★ **产物必须真的被执行一次**（`test/client-runtime.test.mjs`）。
  这是 0.6.1 补上的那条 —— 在它之前，659 个用例里**浏览器半区一次都没真跑过**：
  宿主半区有契约守卫真的 `import()` 它，浏览器半区却只被「查字符串」覆盖。
  0.6.0 因此带着一个致命缺陷发出去：`ReaderPage.jsx` 的 CSS 模板串注释里出现了
  **未转义的反引号**，模板串提前闭合，后面那段被解析成
  「模板串 .npr **减去** book **减去** toolbar」这样一个**语法完全合法**的表达式
  ⇒ esbuild 打包成功、字符串断言全绿、构建守卫也过（它**不是**语法错误），
  真机上插件一加载就 `ReferenceError: book is not defined` ⇒ **整个 DSH 桌面端起不来**。
  ⇒ 唯一有效的判据就是**在 `node:vm` 里造个假浏览器，真的跑一遍**：
  先跑顶层、再调 `factory(require)`、再调 `apply(ctx)`。
  另配一条静态判据：client 源码里每个模板串内部的 CSS 注释必须**有开头有结尾**
  （提前闭合的指纹就是「有 `/*` 没有 `*/`」），并带**假阳性对照** ——
  `src/range.js` 里 416 用的 `` `bytes */${size}` `` 是合法写法，不能被误报。
  假阳性的代价是「下一次真出问题时没人信这条守卫」，比漏报更糟。
  ★ 同一形态 0.5.0 也踩过一次，那次是**语法错误**（构建会红）；
  「构建必须过」这道守卫对**语法合法的错表达式**结构上无效。
- **纯判据要单独被测，而且每条都要有反向对照**（`test/book-view.test.mjs`，33 条）。
  阅读器的缩放 / 翻页 / 键盘三块逻辑抽成 `src/client/book-view.js`（零 DOM、零 React）。
  光写正例等于把当前实现抄了一遍 —— 所以每条都配一个「看起来同样合理的错实现」：
  「朴素的一律按宽度」（适应窗口就永远比适宽更大）、「滚轮一律翻页」（适宽模式下
  一滚就跳页，下半页永远看不到）、「去掉元素守卫」（在输入框里按方向键会把书翻走）。
  另有一条断言 `readerCommand` **不认 `r`**：`w`/`p`/`a` 换的是**可见且可逆**的界面状态，
  而「标记读完」是**持久化状态变更**，误触会在书架上留下一条假的「已读完」。
- ★★ **组件也要真的渲染一次、按钮也要真的点一次**（`test/library-bookrow-render.test.mjs`，0.9.4）。
  `bookRowView`（决定一行有哪些动作）与 `LibraryApp.jsx` 的 `runners`（决定动作点下去调用谁）
  之间只有**一个字符串**（`kind`）连着 —— `kind` 写错、或 `runners` 少一个键，症状是
  **点了什么都不发生**：不抛异常、不报错、源码字符串断言全绿。
  ⇒ 用与 `build.mjs` 同配置的 esbuild 在内存里打包 `BookRow`（`write: false`），在 `node:vm`
  里加载，直接调用组件函数拿到元素树，遍历出按钮并**真的调用** `onClick`，看哪个回调被调到。
  `BookRow` 的返回值是普通对象树，所以**不需要 jsdom、也不需要 renderer**。
  反向对照走 esbuild 的 `onLoad` 插件**改真源码**：`runners[action.kind]` → `runners.drop`
  必须让「移出」变成弃读，`actions.map(` → `slice(0, 1).map(` 必须只剩一个按钮。
- **顺序对 ≠ 位置对**（`scripts/check-library-sidebar-layout.mjs`，用真 Chrome 量像素）。
  源码里搜索框排在筛选条后面，只说明**文档顺序**对；`order` / `flex-direction: *-reverse` /
  `position: absolute` 都能让**画出来的位置**与文档顺序分叉，而且**都不报错**
  （本项目为「文本层算术断言失明」踩过一次：`order: .5` 被静默丢弃、computed 仍是 0）。
  ⇒ 判据钉的是**几何关系**（「块外间距 > 块内间距」「两枚胶囊之间 = 6px 而正文↔首枚 = 2px」
  「分类与搜索框同一行」「排序与结果行同一行、且已离开分类那一行」），不是某个 `padding`
  的取值；量的是**画出来的边**，不是容器的盒边。
  ★ **「同一行」一律比中线** `(top + bottom) / 2`：`align-items: center` 会把 19px 的文字
  与 28px 的控件各自居中，比 `top` 会量出 4px 的假差距。
  ★ 0.9.5 的网格用**具名区域**摆放、0.9.6 的 flex 行按 **DOM 顺序**摆放 ——
  两种布局都**不能**靠「顺序写对了」就以为画面对了（网格不看顺序，flex 行会被
  `order` / `*-reverse` 反掉，都不报错）⇒ 「读序 = 画序」在源码级单钉一条
  （`test/library-app.test.mjs` 判据 ⑤，0.9.6 另加 ⑧ 管「行内谁在前」），
  几何级另钉「谁跟谁同一行」—— 一个量文本、一个量像素，两条都要。
  反向对照把**同一组判据的原式**喂给旧结构 / 抵消掉那条 CSS 的同款行，必须失败
  —— 0.9.5 判据 ③ 第一版写成「排序在搜索框下面」，**旧结构同样成立**、对照永远失败，
  当场被戳穿后改成「排序**离开了分类那一行**」（见 CHANGELOG）。
  顺带出「0.9.4 三行 / 0.9.5 两行 / 0.9.4 弃读行」对照图，出图后**自证 PNG 宽高** = 量测视口 × 2
  —— 本项目踩过「交付图被另一次调用静默换成更矮的裁切」。没有 Chrome 时以 **2** 退出，绝不静默跳过。
  ★ **「同一列共用列宽」是网格的结构性质，调不出来**（0.9.6）：`1fr 1fr` 里分类与排序同在右列
  ⇒ 排序的宽度下限 = 分类的宽度，换 `max-content` 也一样（右列会按分类定）。
  ⇒ 想「一个按内容定宽、另一个独立伸缩」，只能拆成**两条独立的 flex 行**；
  源码级对应判据 ⑦（块里必须正好两条 `.npr-lib-row`）与 ⑧（每行「伸缩项在前、下拉在后」），
  各自的对照喂「并回一条」（= 0.9.5 的共用列形状）与「行内对调」。
  ★ **反向对照的锚点别抄缩进**：0.9.6 把排序那行从 12 空格挪到 14 空格，一条抄死缩进的对照
  当场失效 —— 红的是锚点、不是判据，白跑一趟。改成**空白无关**的正则锚点。
  ★ **模板串的「尾部哨兵」必须覆盖全部模板**：注释里一个反引号就会把外层模板串提前收掉，
  而且**有时语法仍然合法**（退化成一条减法链）⇒ 构建能过、用例全绿、App 起不来。
  本项目已栽 5 次，所以哨兵表（`TEMPLATE_SENTINELS`）覆盖全部 8 个 CSS/HTML 模板。
- **跨半区的字段名本身就是契约**（`test/book-companion.test.mjs`）。
  `setBookContext` 的请求字段在客户端与宿主两处各写一遍 ⇒ 改一个名字**不会报错**，
  只会让伴读面板把 `undefined` 一路传下去。用例从两边源码各取一份字段清单做**逐字比对**。
  ★ 取宿主那份时**不能从形参里找** —— 形参叫 `request`，里面当然没有 `const {`，
  那种写法会变成**恒真式**，正是「两侧一致」最容易变成假绿的方式；
  要从 `const {` 直接切片。同组还断言三件槽位设施（`api` / `SessionProvider` / `renderSlot`）
  逐层传到 `BookCompanion`（少传一层 ⇒ 伴读面板静默不渲染），
  以及伴读面板**不在拖动行的祖先链上**（否则整条工具栏的拖动区被减掉）。
- ★ **界面上的名字必须与「真正决定行为的那个函数」同源**（`test/ai-model.test.mjs`，0.9.7）。
  阅读页那句「正在用 Harness 默认模型翻译成中文…」是**无条件**写的，而设置项 `aiModel`
  非空时生成**根本不走**默认模型 ⇒ 界面在说一句**确定**的话，用户没有理由怀疑它错。
  这类错的形态与「静默回退」正好相反：不是不报错，而是**说得很确定**。
  ⇒ 取值与文案都进共用模块（`src/ai-model.js`），判据与宿主的 `selectionFor` 同源；
  四个状态（设置里指定 / 跟随默认且问到了名字 / 跟随默认但问不到 / 设置值读不出来）
  **分开**，最后一种**不许**说成「Harness 默认模型」（它会报错，不是回退到默认）。
  拿不到具体模型名时一律退回**不含模型名**的说法，绝不编一个名字出来。
  ⇒ 最有牙的判据是**跨路径对照**：把「界面要显示的名字」与「这次生成真的发给 `ctx.llm`
  的 `provider` / `model`」比相等 —— 「文案长得对」的那些用例全绿时，只有它抓得到错位。
  ⇒ 顺带：读模型名的接口必须**只读、不发网络请求**（`listAiModels` 会遍历**所有**
  provider 逐个 `listModels`，可能真的去问远端、8s 超时），所以它是**独立的一个方法**，
  而不是复用那个 —— 有断言钉住「调用期间一次 fetch 都没发」。

### `Range` 的三态解析（`test/range.test.mjs`）

书架取字节的入口是 HTTP `Range`，而它有三种必须**分开**的结果 —— 合成一句
「取不到」就等于把「客户端要错了」和「服务端该回 416」混为一谈：

- **合法区间** → 206 + `Content-Range`。★ 这组的核心是**差一格的两条用例**：
  `bytes=999-`（最后一字节）**合法**，而 `bytes=1000-`（正好越界一格）必须 **416**；
- **语法错 / 多区间** → 拒绝（多区间会让响应变成 `multipart/byteranges`，
  pdf.js 那边收不了）；
- **批不变量** `0 ≤ start ≤ end ≤ size-1`，且逐条配反向对照。

`mimeForExtension` 认不出来时回退 `application/octet-stream`，**绝不返回 `undefined`**
（`writeHead` 会静默丢掉这个头，客户端就只能靠猜）。

### 注释剥离器（`scripts/strip-comments.mjs`）

第 1、2、7 组检查问的都是「**代码里**有没有出现这个 token」，而**注释里出现的 token 不是使用**。
本项目为此**踩了两次同一个坑**，两次的症状都是「守卫在骂文档写得太详细，而不是代码有错」：

1. `test/window-drag.test.mjs` 的文件头注释里抄着宿主规则原文（含 `[tabindex]` 与 `-recall`）
   ⇒ `doesNotMatch` 变红；
2. `check-host-contract.mjs` 因为 `ReaderPage.jsx` 的 CSS 注释里抄了
   `html[data-platform=darwin] [data-window-drag-recall]{…}`，把 `data-platform` 与
   `data-window-drag-recall` 当成「客户端用到的锚点」，报「没有归属登记」。

⇒ 两次的修法都是**先剥注释、再扫描**，所以抽成一个模块，一处修、两处用。

它不能图省事全局剥 —— 两个反例都在本仓库里：`src/host/service.js` 的 accept 头字符串里含
「斜杠紧跟星号」序列（全局剥块注释会从那里一路吃到大段真代码），`src/client/feed-urls.js`
的正则字面量里含转义斜杠。所以它区分代码位置与字符串 / 模板串 / 正则字面量内部，
并且**模板串里按 CSS 的注释语法剥**（本项目把 CSS 写在反引号里，那条注释必须被剥掉，
否则第 2 个坑依旧）。`test/strip-comments.test.mjs` 用本仓库里的**真实样本**正反两面钉住它 ——
它是**守卫的守卫**，多剥一点就会让上层断言静默变瞎。

### 两端共用的判据模块

凡是「宿主判一次、客户端只读结论」的判断，都抽成 `src/` 下的**无依赖模块**，
由两个半区一起 import。理由是同一条：**判据写两遍 ⇒ 两个结论对不上，而两边各自的单测都是绿的**。

| 模块 | 判什么 | 为什么不能各写一遍 |
| --- | --- | --- |
| `src/annotation-relocate.js` | 划线在「换过正文」之后还算不算数：`none` / `missing` / `ambiguous` | 宿主用它把旧标注投影到新正文，客户端用它决定「画不画、为什么没画」。各写一遍就是「面板说找到了、正文里一个字没画」，而两边单测都是绿的 |
| `src/language.js` | 原文语种（`zh` / `en` / `other` / `unknown`） | 各写一遍 ⇒ 「界面说英文、工具说中文」，而界面照 `en` 去调模型、工具照 `zh` 说不必翻 |
| `src/ai-model.js` | 翻译模型的取值编码与解析 | 编码写两遍 ⇒ 设置页存下来的值宿主解析不出来 ⇒ 静默回退到默认模型（用户以为在用免费模型，其实在花钱） |
| `src/reading-settings.js` | 设置项的默认值、取值域与校验 | 校验与解析不同源 ⇒ 「设置页说合法、宿主解析成 null」 |
| `src/library.js` | 书架的共用判据：书 id 合法性、扩展名归一、可渲染判定、阅读状态、路由前缀、分页上限 | 各写一遍 ⇒ 宿主按「可渲染」放行、客户端按自己那份判成「暂不支持」（或反过来：界面列得出来、点开 404）。它被**两个半区同时 import**，所以结构上不许出现任何运行环境专属 API（`node:*` / `document` / `fetch`）—— 有一条断言盯着这件事，且**先剥注释再扫**（这个文件自己的头注释里就写着 `node:*` 这些词） |

`test/language.test.mjs` / `test/ai-model.test.mjs` 各带一条**交叉断言**：
宿主源码里必须 import 这个模块，且**不得**再出现自己算一遍的痕迹
（例如 `service.js` 里不许出现 `CJK_RATIO_THRESHOLD` 或汉字码点区间）。

> 书架那条 **`Range` 解析（`src/range.js`）不进这张表**：它只被宿主半区的路由用，
> 客户端只负责**发出** `Range` 头。这类「单侧用」的判据留在它自己那一侧就行，
> 强行共用反而会让浏览器半区拖进用不上的东西。

### ★ 书架取字节：为什么不能用 `getDocument({ url })`

**本轮最值得记下来的一条。** 本插件这版 pdf.js（6.4.299）里
`validateRangeRequestCapabilities()` **硬要求 `Content-Length`**：

```js
const s = parseInt(responseHeaders.get("Content-Length"), 10);
if (!Number.isInteger(s)) return r;      // ← 没有它，直接判定「不支持 Range」
```

而桌面端把 renderer 的请求转发给宿主时会**扣掉**这个头
（`app.asar` 里 `forwardWebRequest` 的 `WITHHELD_RESPONSE_HEADERS` 含 `content-length`）。
于是**任何**「给 pdf.js 一个 URL 让它自己去取」的路都会静默退化成
**把整本拖下来** —— 一本 290 MB 的书就是灾难，而且**一声不吭**（只有流量和耗时会说话）。

`PDFNetworkStream` 那条路也走不通：它要求 `isHttp = /https?:/.test(url.protocol)`，
自定义协议 `dsh-app://` 进不去。

⇒ 字节必须由**客户端自己取**、自己喂给 pdf.js，用 **`PDFDataRangeTransport`**
（长度由我们显式给出，pdf.js 完全不看响应头，那条退化路径根本不存在）。
取字节的通道是本机 HTTP + `Range`，和用户已有那份阅读器同一条路。

`test/pdfjs-vendor.test.mjs` 把这条依据钉成了**可执行**的断言（真装载 pdf.js 跑，
不是 grep 版本号）：`onDataRange` 在传输流建好之前调用会抛
`TypeError: this[#Ks] is not a function`；`requestDataRange` 在基类上是抽象的。
—— 顺带发现 `src/client/pdfjs.js` 里那段注释写的是**老版本**的机制
（`_rangeReaders` + `util_assert`，6.4.299 已改成私有回调 `#Ks`），一并改正。

**取字节这一层另有两条硬约束（0.24.4 加的，`test/library-api-range.test.mjs` 钉住）**：

- **只收 206，200 一律当失败**。以前 `206 || 200` 都收 —— 而 200 意味着「服务端忽略了
  `Range`、把整个文件返回来了」。那段字节会被当成「从 `begin` 开始的这一片」喂给 pdf.js：
  长度对不上时报的是**解析错误**（离真实原因十万八千里），对得上时更糟 ——
  **整本书被当成第一页**，翻页全乱。宁可在这里报一句人话。
- **有超时**。以前只接外部 signal（pdf.js 取消时才有），网络卡住就永远挂着，用户看到的
  是「这本书一直在转圈」，而代码里没有任何一处会放弃。★ 超时与外部取消是**两个方向**的
  取消，必须分开报错：一个是「太慢」，一个是「用户不要了」—— 后者被说成超时是误导。
- 顺带校验 `content-range` 的**起点**：宿主自己实现的 `contentRange()` 一定对得上，
  这条守的是「以后换成别的取字节通道」时不会静默喂错段。

> 同类纪律：**封顶探测里 `content-length` 必须报真实大小**。pdf.js 先发一个不带 `Range`
> 的请求看 `Accept-Ranges` 与文件大小，拿到响应头就把响应丢掉、改用 Range 请求。
> 把它压到 256 KB 后，实测打开一本 357 页的书从 62 秒 / 3.3 MB 降到 9 秒 / 0.5 MB。
> 但头里报的必须是全书大小（客户端靠它算偏移），所以用例**同时**断言
> 「`content-length` == 真实大小」与「body 长度 == 封顶值」——
> 只断言其中一个，等于给「两者不一致」发合格证。小于 512 KB 的文件**绝不封顶**。
>
> 另：**并发请求的顺序不是契约**，拼出来的字节才是。跨块那条用例一开始断言了请求顺序，
> 得到一个「跑得快就绿、跑得慢就红」的用例 —— 改成断言内容 + 集合。

### 拖动区的祖先检查（`test/window-drag.test.mjs`）

窗口拖动这类故障的特点是**标记全对却完全不动**，所以断言分两层：

1. 标记层：**五条**工具栏（订阅两条 `npr-sidebar-toolbar` / `npr-reader-toolbar`，
   书架三条 `npr-sidebar-toolbar` / `npr-book-toolbar`×2）都有 `data-window-drag`，
   CSS 里也显式声明了 `drag`，控件仍是 `no-drag`，且**绝不能**误用语义相反的
   `data-window-drag-recall`；
   ★ 书架那三条里 `npr-book-toolbar` **出现两次**、缺一不可：选中书时由 `BookReader`
   渲染（带书名 / 页码 / 缩放），没选中时由 `LibraryApp` 补一条空条。少了后者，
   「书架页 + 一本都没点开」这个状态下面板右侧整块就没有拖动区（0.9.8 用户报的
   「这个状态下这一侧不能拖动」）。那一条用**真渲染**断言（`react-dom/server` 渲染
   `LibraryApp`，`books` 为空即该状态），不是源码字符串断言 —— 后者答不了
   「这个 `&&` 真的成立吗」；
2. **祖先层**：五条拖动行的整条祖先链都不许命中宿主的 no-drag 选择器
   （`[tabindex]` / `role=*` / `<button>` 等）。0.5.0 的真机故障就在这一层。
   书架那两个文件还额外断言「**一个 `tabIndex` 都没有**」—— 新加的祖先最容易顺手带上它，
   而祖先一带上，拖动区会被**整块减掉**；
3. 判据清单本身要和**真机 `app.asar` 里的规则正文**交叉核对，免得清单被手抄成一句空话；
   并用**纯函数** `noDragReason` 喂已知会坏的样本做反向对照，证明它会变红。
4. ★ **每条行都要点名自己的来源文件**。`npr-sidebar-toolbar` 在订阅页与书架页**同名**，
   而定位方式是按源码文本找开标签 —— 不写文件，就会拿 B 文件里的同名类去查 A 文件的祖先，
   于是「查了个寂寞，还全绿」。这条守卫做过**变异测试**：给书架的 `.npr-sidebar`
   加一个 `tabIndex={0}`，两条独立断言同时变红。

### 面板高度链（`test/book-layout.test.mjs`）

书架那半边的高度链是 `.npr-reader` → `.npr-book{flex:1}` → `.npr-book-main{flex:1}`
→ `.npr-book-stage`，**它只有在 flex 上下文里才成立**。所以书那一半的 `<section>`
必须同时带 `npr-reader-book`（CSS 里配 `display:flex;flex-direction:column`），
而订阅那半边**不能**加 —— 订阅要靠 `.npr-reader` 自己的 `overflow:auto` 滚整篇文章。

★ 这条链**坏掉不会有任何报错**：构建过、730 个用例全绿，只是「适应窗口」按钮点了
没反应、面板下面空出一大块。它已经真的坏过一次（0.6.1），真机实测见 CHANGELOG。

守卫钉的是**判据与配对**，不是像素：

| 判据 | 为什么 |
| --- | --- |
| JSX 里那个类名在**同一个** `<section>` 上 | 按 `{} [] ()` 深度扫开标签，**不靠「最近的 `<`」** —— `.npr-reader` 跨行、里面有 `style={{…}}`，随手一截会截在属性中间，「标签里有没有那个类名」就可能因为**截断**而假绿 |
| CSS 那条规则的形状（`display:flex` + `flex-direction:column`） | 少任一半，下面三条 `flex:1` 就都是死代码 |
| 居中靠画布的 `margin:auto`，**不能**靠容器的 `justify-content:center` | 容器是滚动容器，后者在内容比它大时会让**起始边永远滚不到**（页面比面板宽时左边一截看不见） |
| 取规则体时，同选择器的**多条**规则要合并看 | `.npr-book-stage` 在 `@container` 里还有一条窄面板兜底，只认第一条会假绿 |

每条都配**反向对照**：把 0.6.1 那份坏配置喂给同一套判据，要求变红 ——
否则这些断言只是把当前实现抄了一遍。

### 阅读器的两层操作（`scripts/check-book-reading-chrome.mjs`）

0.23.0 把操作分成两层：**顶部胶囊装开关、右下角圆按钮装调档**。点开后按钮**向上
摊开一列**：每格是「圆形图标 + 左侧文字标签」，一条细导轨把它们串起来。
这类改动的坏法全都「构建全绿、单测全绿」，所以判据按**九个方向**铺开：

| 方向 | 判据 | 为什么 |
| --- | --- | --- |
| **分工** | 顶部 `.npr-book-chrome` 块里恰好 6 个 `npr-book-pill-item`；右下角 `.npr-book-fab` 块里恰好 7 个 `npr-book-fab-slot`；两边互不串味；开合只认 `.is-open`，`:hover` 展开那条 CSS 已 **0 处** | 数的是**源文本**而不是夹具 —— 夹具是我按理解写的，拿它核分工等于自问自答（我把 13 项全塞进浮动按钮时，夹具也会跟着塞 13 项，「恰好 13 格」照样全绿） |
| **顶部** | 只剩 10px 透明拖动条且铺满宽度；元信息行底边不越过舞台顶边、只有一行、**不含书名**；胶囊在顶部、左右留白差 ≤ 2px、装得下、不被裁 | 浮层版压住元信息行的地方连划选都点不到；拖动条 0 高度就拿不到命中测试，窗口拖不动 |
| **浮动列** | 收起态 7 格 `visibility:hidden` + `opacity:0` + `pointer-events:none`，且**收回到按钮圆心**（≤ 1.2px）、缩到 0.6 倍；展开态**全部在按钮正上方**、等距（各段互差 ≤ 1px）、逐格与 `fabStack` 理论位置一致（≤ 1.2px）、任意两格不叠、全在面板内、最上格不压胶囊、最下格紧贴按钮 | 只写 `opacity:0` 的话 7 块看不见的圆片盖在书页右下角，划选到那儿就断；「竖直一列」只有逐格比对理论位置才量得出来 |
| **交互** | **悬停按钮就展开**（不用点）；指针停在按钮与第一格之间的**空隙**里 90ms 仍展开；走到最上格仍展开；移开 90ms 仍展开（宽限期存在）、420ms 才收起；点击入口仍成立（触屏 / 键盘） | 0.23.0 把「空隙里 `:hover` 会掉」错读成「悬停不成立」而删掉了悬停。正解是**宽限期 220ms**：横穿 8px 只要 30–80ms。这条判据量的是**生产代码的 `createFabHover`**（esbuild 内联进夹具），不是另抄一份「pointerenter → 加类」 |
| **自适应** | 420×420：贴角 10px、直径自动缩到 36.3、仍不叠、标签仍不越界、最上格不压胶囊；240 高只钉「收缩生效 + 不叠」 | 预算要扣掉**顶部预留**（胶囊 + 元信息）：不扣的话 420 高的面板里最上面那格压住胶囊 15px，而它 `z-index` 更高，被盖住的胶囊按钮点不到 |
| **沉浸** | 元信息行 `display: none`；**胶囊不消失**，而是 `absolute` + `translateY(-100%)` 收起（不占位），鼠标移到顶部那条 10px 拖动条上滑出、可点、移开又收起，且**滑出时不顶下书页**（`stage.top` 与收起态差 ≤ 1px）、**胶囊顶不压进拖动条**（≥ 10px，否则它的按钮会在拖动区里挖洞、窗口拖不动）；**FAB 常驻可见**（不再有沉浸态规则）；书架列与分隔条 `display: none`、阅读区吃满工作区宽 | 沉浸要收的是**占位与干扰**，不是控件本身 —— 0.24.6 之前把胶囊 `display:none`、把 FAB 设成透明，用户原话「应该存在啊」。热区**复用 `.npr-book-toolbar`**（宿主窗口拖动区，`data-window-drag`、10px 铺满宽度），不新加绝对定位的 div，否则会把拖动区盖住、窗口拖不动；收起时必须 `pointer-events: none`，否则挡住书页顶部的划选 |
| **全屏** | 全屏 API **只许出现在 `toggleFullscreen` 里**，`toggleImmersive` 函数体里一个全屏字样都没有，且全文**没有** `fullscreenchange` 监听 | 全屏是用户对**窗口**的决定，沉浸是「我想安静读一页」—— 两个状态机缠在一起过（0.22.0）：进沉浸自动全屏、Esc 被全屏接管、再靠 `fullscreenchange` 反同步。0.24.2 全删；0.24.6 因为「⌃⌘F 提示是假话」把全屏**作为独立入口**加回来，判据从「一个都不许有」收紧成「只许在这个入口里」—— 守的还是同一件事 |
| **层级** | 配色面板中心与底部色块行各取一点，`elementFromPoint` 必须命中面板自己 | 这一条是**看截图才发现**的：`.npr-book-pill` 的 `backdrop-filter` 会创建栈上下文，面板的 `z-index: 50` 只被关在胶囊内部，元信息行（后绘制）把它整个盖住 —— 几何全对，面板却看不见 |
| **阅读区定位** | 开着伴读（右侧 348px）时，按钮距**书页区**右/下各 14px、整颗在书页区内、展开的 7 格也不越界 | 按钮钉在 `.npr-book` 上时，一开伴读就跑到伴读的角上，看着像伴读的按钮。正解是多加一层 `.npr-book-view` 当定位基准 —— **不能放进舞台**，那是 `overflow:auto` 的滚动容器，绝对定位子节点会跟着内容滚走 |
| **纸色覆盖** | 覆盖层与画布**完全重合**、不吃点击、`mix-blend-mode: multiply`；护眼 r>g>b、薄荷 g 最大；原色与夜间两档透明 | PDF 是位图：只给画布加 `filter: sepia()` 时白纸乘出来仍是白。压一层 multiply 才是「白纸 × 米黄 = 米黄、黑字 ≈ 黑字」；普通半透明覆盖会把黑字一起提亮 |

反向对照 19 组，只改 CSS 不改结构：拖动条改回 44px（①）、元信息行挪进舞台（②）、
胶囊挪到底部（③）、FAB 挪到左上角（⑤）、列强制常显（⑥）、7 格偏移清零（⑧⑨）、
整列推出去（⑫）、标签藏掉（⑫）、**宽限期改成 0**（⑭）、**摘掉悬停监听**（⑭）、
**阅读区那层退回 static**（㉓）、**覆盖层改透明**（㉔）、直径写死不跟随收缩（⑯）、
沉浸时保留书架列（⑱）、胶囊退回 `static`（㉑）、**沉浸时胶囊不滑出**（0.24.6）、
**沉浸时 FAB 再藏起来**（0.24.6）、**滑出时胶囊贴回 y=0**（0.24.6）。
每组都必须把对应那条判据弄红。运行：`npm run verify:book-reading`。

★ 两条「反向对照自己先假绿」的实测教训（都写进了脚本注释）：
① **空隙坐标必须在展开态量** —— 收起时 7 格全叠在按钮位置，算出来的「空隙」落在按钮内部，
指针一次都没离开，「宽限期 0 也能撑住」；
② **`display:none` 读不到透明** —— 元素一旦 `display:none`，`getComputedStyle` 仍返回
**声明值** `rgb(247,236,214)`，判据永远看不到「覆盖层不起作用」。

### 阅读器的**真渲染**守卫（`test/book-hooks-render.test.mjs`）

0.20.6 的「打开就白屏」是 `Cannot access 'toggleImmersive' before initialization`：
两个 `useCallback` 声明在键盘 `useEffect` 之后，而 effect 的**依赖数组在渲染期求值** ⇒
TDZ。当时 900+ 条用例全绿，因为浏览器半区的守卫用的是**桩 React**（只验证模块体能跑完），
其余断言都在读源码字符串 —— 而「声明顺序」在字符串层面完全合法。

这个文件把 `BookReader` 真的渲染一次（真 `react` + `react-dom/server`，esbuild 在内存里
打一份只导出它的测试入口），并配一条**反向对照**：同样形状的坏组件必须抛
`before initialization`。判据只有一句 —— 「渲染一次不抛」—— 但它拦的是一整类错误。

### 划线 / 笔记的三条边界（`src/host/annotation-store.js` + `src/client/annotations.js`）

| 边界 | 为什么 |
|---|---|
| 存 `annotations/<bookId>.json`，不进 `data.json`、不进 `digests/` | 前者是全量重写（划一条线重写 8 MB），后者会被「重新解读」整本删掉 |
| 每本书一条**写队列** | 划线是连点两下的高频操作，读-改-写不串行就会静默丢条目 |
| 锚是**页内字符偏移 + 摘录**，不是坐标 | 坐标随缩放/适宽变化；渲染时用 Range 重量矩形，缩放后自然跟着走 |
| 高亮层 `pointer-events: none` | 它一旦能接点击，划过线的文字就再也拖选不了（拖选是划下一条的入口） |
| 选区偏移在**气泡出现时**量好 | 点按钮时 `mousedown` 已经把选区收掉了，`onClick` 里再取 `getSelection()` 常常是空的 |
| 重排电子书换成**块偏移**（`src/client/ebook-marks.js`） | 重排正文里块与块之间隔着元素边界，数文本节点会多算；块区间 = 非空块用 `\n` 串起来，与伴读读到的正文同一基准 |

`test/annotation-store.test.mjs` 覆盖原子写 / 并发 / 坏 JSON 备份 / 路径穿越；
`test/annotations.test.mjs` 覆盖规范化、重复判定、节点切分（`slicesOf`），
以及两条样式契约（`pointer-events: none`、夜间 `mix-blend-mode: screen`）；
`test/ebook-marks.test.mjs` 覆盖电子书的块区间 / 裁剪 / 碎片切分（含 5 条反向对照）；
`scripts/check-book-reading-chrome.mjs` 在真 Chrome 里量面板宽度与溢出。

### 阅读器的打开与缓存契约（`src/client/pdfjs.js`）

**一条铁律：销毁入口只有 loading task，不是 `task.promise` 解出来的文档代理。**

pdf.js 6.4.299 的 `PDFDocumentProxy` 上**没有 `destroy`**（真跑实测；旧版本有，
所以这是照着旧文档写就会踩的坑）。而它踩下去的报错方式特别恶劣 ——
cleanup 在 React 提交阶段同步抛 `TypeError`，被 Error Boundary 接住，用户看到的是
「阅读器页面加载失败」，真正的原因（一行清理代码）完全看不出来。所以：

| 事情 | 谁负责 |
| --- | --- |
| 装载 pdf.js | `loadPdfjs()`（只装一次，失败**不缓存** —— 否则「重试」永远拿到同一个 rejection） |
| 取字节 | `fetchBookRange` → `PDFDataRangeTransport.requestDataRange` |
| **文档的生命周期** | `openCachedBook` 的会话级缓存（LRU 3 本，**独立于任何组件**） |
| **销毁** | `destroyEntry()`：`entry.task ?? entry.doc?.loadingTask`，并**全程吞错** |

缓存有三个不显眼但必要的决定：

- 键是 `bookId + 字节数`：书被换过文件时必须重新解析；
- 中止信号是**条目自己的** `AbortController`：文档必须活得比组件久，否则复用时
  传输层已被 abort、取不到字节（缓存会变成一个看起来命中、实际用不了的坑）；
- 错误回调跟着**最后一次**调用方走：上一个组件可能已经卸载了。

守卫：`test/book-render.test.mjs`（源码级 + 坏实现反向对照）、
`test/pdfjs-cache.test.mjs`（行为级，夹具**刻意不给文档代理配 `destroy`**，
否则「实现错写成 `doc.destroy()`」的版本会假绿）。

### 阅读器的缩放与翻页契约（`src/client/book-view.js`）

判据全部抽成纯函数，界面只负责接线。下面每条都是「写错了不报错、只是用起来不对」：

- **量宽度用 `clientWidth`，不用 `getBoundingClientRect().width`**。舞台是滚动容器，
  后者**包含滚动条** —— 用它算可用宽度会多出一整条滚动条的宽度，页面于是永远略宽于可视区。
  同时读 `getComputedStyle` 的 padding 把它减掉，并保证结果**永远不小于 1**
  （0 会让 `scale` 变成 0，页面直接消失）。
- **由 `ResizeObserver` 驱动测量**。渲染 effect 的依赖里**没有「窗口尺寸」**，
  所以窗口一变页面根本不会重算 —— 那正是「自适应不生效」的真身，而不是缩放算错了。
- **「适应窗口」= 整页可见 + 居中**，判据是 `min(宽比, 高比)`。所以在**窄面板**里它
  可能算出来**和「适宽」一样的尺寸**（宽度是更紧的约束）—— 那时用户看到的变化是
  页面**垂直居中**（上下留白相等），不是「按钮没反应」。
- ★ **判据要拿到真高度，舞台就不能是自指量**：`contentBox()` 读的是舞台，
  而舞台高度若由「里面的画布撑出来」，那么 `min(宽比, 高比)` 永远算得出「正好放得下」
  ⇒ 切「适应窗口」页面尺寸一动不动。**它曾经真的这样坏过**，根因不在这几个函数里，
  见下方「面板高度链」。
- **`scrollbar-gutter: stable`**。滚动条出现 / 消失会改变 `clientWidth`，
  没有它「适应宽度」会在「有滚动条」与「无滚动条」之间来回微调，看起来像抖动。
- **拖动期间跟手、停手后清晰**：只改画布**显示尺寸**（纯 CSS，一帧内完成，略糊但跟手），
  停手 160 ms 后补一次清晰渲染。**换页走 `immediate`** —— 换页也等 160 ms 会像「按了没反应」。
- **滚轮三态**（`wheelIntent()` 按滚动位置分流）：页面滚得动就滚，**滚到边界那一下才翻页**；
  页面滚不动（整页适应窗口）时上下都是翻页。★ 缺了这条分流，适宽模式下**一滚就跳页，
  下半页永远看不到**。另加累计阈值 + 冷却时间对付触控板的惯性滚动。
- **React 合成 `onWheel` 是「被动」监听**，`preventDefault()` 在里面**无效** ⇒
  必须用原生 `addEventListener('wheel', …, { passive: false })`。
- **键盘守卫三条，顺序不能换**：修饰键 → 元素类型（input / textarea / select / button /
  summary / option）→ `isContentEditable`。★ 少任一条都会「输入框里打不了字」
  或「聊天框里按方向键把书翻走了」；而 Harness 的原生输入框**不一定是 textarea**，
  所以只判 `tagName` 不够。
- ★ **`⌃⌘F` / `F11` 是唯一站在「修饰键」守卫前面的分支**（0.24.6）。`readerCommand()`
  的第一行就是「任何修饰键 ⇒ `NO_COMMAND`」，所以 0.24.2 那句「要全屏按 ⌃⌘F」的提示
  是一句**假话**：没人处理、也没人 `preventDefault`，按下去完全没反应。修法是在
  `readerCommand` **之前**插一个显式分支 —— 不是把 ⌃⌘F 塞进那个函数，那等于先拆掉
  「修饰键一律不认」这条规则（它挡的是「按 ⌘C 复制被当成命令 C」）。
- **伴读上下文与文章伴读写同一个落点**（`companionContexts[sessionId]`）⇒ 宿主那条
  `systemPrompt` 注入通道**一个字都没改**。`setBookContext` 只 `touch()`（500 ms 去抖）
  **不 `flush()`**：翻页会频繁触发，而 `flush()` 是全量重写整个 `data.json`。
- **`setBookContext` 的 `page` / `pages` / `text` 刻意不设默认值**。字段名写错时，
  有默认值的实现会把它们兜成 `0` 与空串，模型于是看到「第 0 页，这一页没有文字」
  这样**看起来很确定**的假话。宁可当场抛错。
- **`inert` 必须由 ref 直接设，不走 React prop**：React 18 与 19 对布尔 `inert` 的处理不同，
  写成 prop 会在升级时**静默失效**（同步未完成时用户还能往面板里打字，上下文却是旧的）。
- **列的圆心对齐靠 `margin` 负半宽，不是 `translate(-50%,-50%)`**（`fabStack` + CSS）。
  `.npr-book-fab-list` 是 `right/bottom` 定出来的一个 **0×0 原点**，每格写
  `left/top: 0` 再用 `margin: calc(var(--npr-fab-size) / -2)` 把**圆心**对到原点上；
  收起态的 `scale(.6)` 以中心为原点 ⇒ 圆心不动，7 格是从一个点里长出来的。
  不用 `translate` 是因为它已被出场位移与收起缩放占满，再写一次会互相覆盖。
  `fabStack` 里 `+ 0` 把 `-0` 归一成 `0`：`translate(0px -0px)` 合法，但读日志时很刺眼。
- ★ **竖直列的预算必须先扣掉顶部预留**（`fabStack` 的 `top`）。整列从按钮往上排，
  能用的高度是 `面板高 − FAB_MARGIN − FAB_BUTTON_SIZE − topInset`，先压间隙、
  压不下去再缩直径（下限 26px），`size` 随位置一起回传给 CSS 的 `--npr-fab-size`
  —— 只给位置不给尺寸，矮面板里 26px 的圆心距配 38px 的圆就是糊成一串。
  `topInset` = 舞台顶 − 面板顶（拖动条 + 胶囊 + 元信息行）：不扣它，420 高的面板里
  最上面那格会**压住胶囊 15px**，而 FAB 的 `z-index` 比胶囊高，被盖住的胶囊点不到。
  拿窗口高算也不行，舞台上还压着划线面板与伴读。
  尺寸也不是窗口尺寸的函数：**两条几何关系各有反向对照** —— `gap: 0` 时相邻圆心距
  恰好等于直径（「≥」只是勉强成立）、`bend: 0` 时整列完全垂直。
- ★ **开合只认 `.is-open` 这一个类，但入口有两个：悬停与点击**（0.24.3）。
  - 悬停走 `pointerenter` / `pointerleave`（挂在 `.npr-book-fab` 上，**不是** CSS `:hover`）：
    这两个事件只在「进入 / 离开整棵子树」时触发，按钮 → 格子、格子 → 格子都不会误收。
  - **离开后有 220ms 宽限期**（`FAB_HOVER_GRACE`）：按钮与第一格之间必定有空隙，
    横穿它要 30–80ms，而「真的想离开」晚 220ms 毫无感觉。
    ★ 0.23.0 观察到空隙是真的，但把结论下成「悬停在这个几何里不成立」而改成纯点击 ——
    那是**观察对、结论错**：缺的是宽限期。
  - **点击保留**：触屏没有 hover、键盘要 Tab 到按钮再回车，它们是「钉住 / 收起」的显式开关。
    两条路径共用同一个 `.is-open`，`transition-delay` 用 `--npr-fab-i` 做逐格错开。
  - 状态机是纯函数 `createFabHover()`（可注入定时器），`test/book-view.test.mjs` 用
    假定时器真跑；几何判据用**真鼠标事件**：悬停即展开 → 停在空隙里 90ms 仍开 →
    移开 90ms 仍开 → 420ms 收起。
- ★ **按钮钉的是「阅读区」不是「整个面板」**（0.24.3）：舞台与按钮都放进 `.npr-book-view`
  （`flex: 1`，不滚、不画东西），按钮的 `position: absolute` 以它为基准。
  不能直接放进 `.npr-book-stage` —— 那是 `overflow: auto` 的滚动容器，
  绝对定位子节点会跟着内容滚走（往下翻两页按钮就没了）。

---

## 数据位置

```
~/.dsh/storages/dsh-npie-reader/
├── data.json        订阅、书架进度、译文与改写（本插件唯一的「文档」）
├── lists.json       书单清单：id / 份数 / 生成时间
├── lists/           每份书单的书条目，**一条书源 = 一份**
│   └── <sourceId>.json
├── books.json       旧版合并书单，只在升级时被读一次
├── pan-app.json     百度网盘 AppKey / SecretKey
├── pan-token.json   百度网盘授权 token
├── transcripts/     播客字幕（0.79.0），**一集一个文件**：文件名是 key 的 sha256 前 32 位
│   └── <hash>.json  `{ v, key, source: { url, type }, format, fetchedAt, segments: [{ start, end, text }] }`
├── asr/             本机识别（0.82.0）：引擎 / 模型 / 临时 WAV，**删掉这个目录就等于卸载**
│   ├── crispasr-<版本>/     解压后的引擎（17.8 MB 包，27 MB 落地）
│   ├── models/              ggml-*.bin（默认 small，181 MB）
│   └── tmp/                 整段 WAV（16 kHz 单声道，用完即删）+ 每片的识别 JSON
├── annotations/     划线 / 笔记，**一本一个文件**（不与 digests 同目录：那个会被「重新解读」整本删掉）
│   └── <bookId>.json    `{ version, bookId, items: [{ id, page, start, end, quote, note, tone, … }] }`
├── diary/           日记（0.30.0），**与你的 Obsidian 库零耦合**
│   ├── daily/
│   │   └── YYYY-MM-DD.md   一天一篇：frontmatter + `## HH:MM 类型 · 来源` 分条
│   ├── private/            私密日记（0.31.0）：**磁盘上只有密文**
│   │   └── YYYY-MM-DD.md.enc   `{ v, iv, tag, data }` 的 AES-256-GCM 信封
│   └── secret.key          只在钥匙串不可用时出现（0600）—— 它出现就意味着「防拷走、不防本机」
└── digests/         电子书目录的抽取产物，**一本一个目录**
    └── <bookId>/
        ├── meta.json      章节数 / 分段方式 / 抽取任务进度（断点续抽靠它）
        ├── outline.json   目录树（章节标题 + 起止页 + 是否分卷页）
        ├── pages.jsonl    逐页文本，**追加写**（断电最多丢最后一行）
        ├── text/chNN.txt  每章一份正文
        └── digest/chNN.json  每章一份解读（`summary` / `points` / `terms`）

~/.dsh/storages/dsh-npie-reader/skills/     导出的 skill 包（0.20.0）
└── <slug>/        中文书名回退成 book-<bookId>（不做拼音）
    ├── SKILL.md         索引层：frontmatter + 怎么用 + 章节索引表
    ├── chapters/chNN.md 一章一份，**问到才读**
    ├── glossary.md      术语与人名，**每条带章号**
    ├── patterns.md      跨章：写法 / 结构（没做综合时是「原样摘录」并明说）
    ├── cheatsheet.md    跨章：速查
    └── skill.json       机器可读元数据
```

★ **导出包刻意放在插件自己的数据目录里，不往 `~/.claude/skills` 之类的位置写** ——
那是「用户机器上的别的东西」，本项目对仓库外的写操作一律先问。界面把绝对路径显示
出来，用户自己决定要不要拷过去。

目录由 `resolveDshHome()` 决定（显式配置 > `$DSH_HOME` > `~/.dsh`），**每次现读环境变量** ——
改了 `DSH_HOME` 立刻生效，不需要重启进程。

`data.json` 按**原子写**（临时文件 + rename），500 ms 去抖。文档损坏时**拒绝覆盖**并抛错，不会静默重置。
同一份文件里还放着**书架进度**（`library.states`）与首次导入来源（`library.importedFrom`）。
★ 你那份 `ebook-sorter/data/reading.json` 若被指为导入源，插件**只读一次**、**绝不回写** ——
两个写入者共写同一份文件只会互相覆盖（见「边界与已知限制」）。

★ **电子书正文绝不进 `data.json`**：那份是**全量重写**（一次写整个文档），一本 300 页书的
正文放进去就是「翻一页重写两兆」。所以抽取产物全部落在 `digests/<bookId>/` 下的独立文件里，
抽取中间态用 `pages.jsonl`（**追加**写，断电最多丢最后一行）。`bookId` 进路径前先过
`isBookId()` 白名单，不做「拼一下试试」。删掉 `digests/` 只是丢掉目录与解读，书本身与阅读进度不受影响 ——
下次点「目录」会重新抽一遍（解读要再点一次「生成」；那一步**花钱**，所以不自动重跑）。

★ **日记也不进 `data.json`**，而且**不进你的 Obsidian 库**（0.30.0）。两条理由各管一头：

- 不进 `data.json`：那份是**全量重写**。日记是要写十年的东西，一次追加就让整个 9 MB
  文档重写一遍，而且任何一次「文档损坏」都会连带把日记一起赌进去。
- 不进 Obsidian 库：你的库有**自己的结构**（`Daily/` 的命名、模板、插件、同步）。插件往里
  写文件就等于「两个写入者共写一个目录」，而哪天插件的命名变了，那些文件就变成库里的垃圾。
  所以日记**只写插件自己的目录**，由你决定要不要拷走（界面上有「打开文件夹」与
  「导出（按当前模块）」两个出口）。

一天一篇（而不是一条一篇）是**刻意的**：一条一篇会得到一个几千文件的目录，而且
「今天写了什么」这个最常见的查询变成 N 次读盘。一天一篇 + 内部 `## HH:MM` 分条，
既保留了逐条的时间与类型，也保留了「这一天」这个整体。★ 追加是**纯字符串拼接**：
旧内容逐字节保留，连你手改过的缩进、空行、自己的 `##` 小标题都不会被重排。

这些文件都是**原子写 + 600 权限**（临时文件 + `rename`）。其中
`pan-app.json` 与 `pan-token.json` 装着能读遍你整个网盘的东西，
所以**绝不打回浏览器**：`GET /pan/status` 只回一个掩码后的 AppKey 预览（`前6…后4`），
测试连字段名一起守（`test/pan-auth.test.mjs`）。`lists.json` 与 `lists/` 下的每份书单
都只是索引，但里面的路径与书名同样是隐私，所以给同一档权限。

**你自己填的云端语音 / 识别 API key 落在 `data.json` 的 `settings` 里**（同样是 600），
**不在**系统钥匙串 —— 与网盘凭证同一档处理。只有私密日记的密钥进钥匙串，因为它是
「解密内容」用的，泄露就等于所有私密日记被读走；而 API key 泄露的后果是「别人花你的
额度」，量级不同，所以不额外加一层。要换机器时，`data.json` 拷过去 key 就跟着过去了。

> **续期结果会写回，但写入者只有一个**（0.18.1 起）。access_token 过期时 `pan.js` 用
> refresh_token 续期，新 token 交给 `panAuth.saveToken` 落盘（先读旧文件再合并，
> 未知字段原样透传），`pan.js` 自己**不碰**这个文件 —— 两个写入者共写才会互相覆盖。
> 而「不写回」的代价更大：百度每次续期都**换发**新的 refresh_token、旧的当场作废，
> 只留内存的话进程一重启手里就只剩一个作废的，之后每次续期都报
> `refresh token has been used`，用户被迫每 30 天手动重新授权一次 —— 而这正是
> refresh_token 本该免掉的事。续期请求还会**单飞**（并发共用同一次刷新），
> 否则 pdf.js 同时要几段字节时，第二个请求必然拿到「已被使用」。

---

## 安装与启动细节

**用 GUI 装，不要用命令行。** 内核对 `desktop` profile 是 Electron App 独占管理，
`dsh plugin --profile desktop …` 一律被拒（`dsh/lib/bin.js:36`）：

```
error: profile "desktop" is managed exclusively by the Electron application
```

### 步骤

0. 先把源码放到本机任意目录（`git clone` 或下载 Release 压缩包都行），
   记下这个目录的绝对路径。下文 `/你的路径/dsh-npie-reader` 就指它。
1. 左侧栏点 **「插件」**（不在设置里）。
2. 点 **「添加插件」**，粘贴上一步那个绝对路径：

   ```
   /你的路径/dsh-npie-reader
   ```

   `link:` 前缀可省。安装面板接受本地绝对路径：`dsh-plugin-manager` 的
   `parseInstallSpec` 把绝对路径判为 `kind: 'path'`，走本机软链，不联网、不查注册表。
3. 安装完成后点 **「立即启用」**。
4. **完全退出 App（`Cmd+Q`）再打开**，然后浏览器强刷 `Cmd+Shift+R`。
   Host 半区有改动时必须重启：本插件在 Host 半区注册 `rss` 服务、25 个 agent 工具，
   以及书架的本机 HTTP 路由。

这一步同时完成三件事：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 增加
   `"dsh-npie-reader": "link:/你的路径/dsh-npie-reader"`；
2. `~/.dsh/profiles/desktop/node_modules/` 下建立软链；
3. `dsh.profile.bundles` 追加 `dsh-npie-reader`。

> 第 3 步**不需要手工做**。装完后 DSH 会跑一次对账（`dsh-plugin-manager` 的 `reconcile()`）：
> 凡是**本次新装**且**声明了 `dsh.bundle`** 的直接依赖，都会被自动追加进 `bundles`；
> 没声明 `dsh.bundle` 的会打一行 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`
> 并被跳过。本插件在 `package.json` 里声明了 `dsh.bundle.patch`，所以会被自动挂上。
>
> 反过来说：**光手工改 `package.json` 是没用的** —— 插件还要在
> `~/.dsh/profiles/desktop/node_modules/` 下有软链才能被解析到，那一步由 pnpm 建立。

### 预期现象

- 日志出现 `dsh-npie-reader: service started`；
- 左侧栏出现「阅读器」入口（图标 `rss`，order 15）；
- 侧栏「插件」里 `dsh-npie-reader` 不标「异常」，设置里出现阅读外观等配置项。

### 如果启动报 `failed to import`

Host 半区出现了解析不到的宿主内部包。本插件的 Host 半区**必须零宿主内部包依赖**：
外部 `link:` 插件在 Node 的解析链上拿不到 `@deepseek-ai/dsh-*` —— 桌面端把它们放在 App 的
asar 里（`app.asar` → `dsh/node_modules/@deepseek-ai/…`），profile 的 `node_modules` 里没有。
需要宿主能力时走 `ctx` 服务，或像 `src/host/typert-lite.js` 那样本地复刻协议契约。

`npm run contract` 的第 8 组检查会拦住这类改动；测试也不再用替身掩盖它。
