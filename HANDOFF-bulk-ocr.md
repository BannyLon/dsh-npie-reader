# 交接：整本 OCR —— 让扫描版电子书也能「逐章解读」

> 给接手的 agent：这份文档是自足的。你不需要之前的对话。
> 仓库：`/Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader`
> 版本基线：**0.24.8**（提交 `6a7d3f4`），`npm test` 当前 **1937 全绿**。

---

## 0. 一句话目标

现在扫描版 PDF 只能「一页一页读 + 伴读」。要做的是：**抽取整本时，遇到没有文字层的页，
用同一套本地 Vision OCR 补上**，然后走**完全不变**的切章 + 逐章解读链。

一句话判据：**一本 387 页的扫描书，点一次「抽取目录」，5 分钟后能生成第 1 章的解读。**

---

## 1. 为什么这件事比「支持 EPUB」更值得做（数据，别跳过）

| 项 | 数字 |
| --- | --- |
| 书架总书数 | 2637 |
| 非 PDF（epub/mobi/azw3/docx/txt） | **31 本（1.2%）** |
| 扫描版（无文字层） | 用户原话「90% 都是扫描电子书」；真机 32 本抽样里 9 本（28%） |
| 单页 OCR 实测 | **0.6–0.8 秒**（冷启动 26–29 秒，只发生一次） |
| 整本 400 页 | **约 5 分钟，零费用，不联网** |
| 全库 2370 本 | 约 197 小时 ⇒ 整库不可行，**单本完全可行** |

⇒ 这 90% 的书现在**全都跑不了「逐章解读」**，而那正是这个插件最核心的功能。
EPUB 只有 15 本，TXT 只有 1 本。

---

## 2. 环境与命令

```bash
cd /Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader
node build.mjs                 # 产出 lib/index.js（host）+ lib/client.js（client）
npm test                       # 1937 个用例
npm run verify:ocr-live <图>   # 真机 OCR 探针（不进 npm test，冷启动要 26–29 秒）
```

- Node：`/Users/habhy/.workbuddy-ai/binaries/node/versions/22.22.2-6/bin/node`（或系统 node 均可）
- 数据目录：`~/.dsh/storages/dsh-npie-reader/`（`digests/<bookId>/`）
- ★ **桌面端没有 hmr**：改完宿主半区必须**退出并重开 App**，刷新窗口不够
  （`~/.dsh/profiles/desktop/cordis.patch.yml:147` 自己写着这条）。
- ★ 本机沙箱：`bash` 里 `grep` 会静默返回空（用 Grep 工具）；`git add` 常被拦
  （索引删不掉）⇒ 提交交给用户终端；`rm`/`unlink` 间歇性被拦。

---

## 3. 已经有的东西（**别重写**）

### 宿主

| 文件 | 作用 |
| --- | --- |
| `src/host/ocr-vision.js` | 67 行 JXA，`VNRecognizeTextRequest` 调 macOS Vision。**不参与打包**，`osascript` 直接按路径读它 |
| `src/host/ocr.js` | `sniffImageExt`（只看 magic）/ `decodeImagePayload`（自己校验 base64）/ `createOcrRunner({ scriptPath, platform, exec, timeoutMs, log })` ⇒ `{ supported, unavailableReason, recognize(buffer) }`。PNG/JPEG、上限 4 MB、超时 60 s |
| `src/host/service.js` | `ocrScriptCandidates(here)` / `resolveOcrScript()` —— ★ 按**两种运行形态**探测：未打包 `here=src/host`、打包后 `here=lib`（只退一级）。`this.ocrRunner` 在构造函数里造一次 |
| `src/host/library-routes.js` | `GET /ocr?bookId=&page=` 读缓存；`POST /ocr` 收 `{ bookId, page, image }`（data URL 或裸 base64）⇒ `{ ok, page, text, lines, ms, chars, saved }`。**只收位图、不收路径** |
| `src/host/digest-store.js` | `ocr.json` 一页一条 `{ text, at, ms }`，上限 3000 页/本，按 `at` 淘汰。★ **坏了自愈**（`readOcr` 单独 catch，当空缓存） |

### 客户端

| 文件 | 作用 |
| --- | --- |
| `src/client/library-api.js` | `ocrBookPage(bookId, page, image)`（超时 120 s，必须比宿主 60 s 长）、`fetchOcrPage(bookId, page)` |
| `src/client/BookReader.jsx` | `runOcr`（约 992 行）：`doc.getPage` → `getViewport({scale: 200/72})` → **先填白底** → `toDataURL('image/jpeg', 0.85)` → `ocrBookPage`。自动识别 effect 在 700 ms 防抖后跑 `quiet: true` |

**关键契约**：`pages.jsonl` 每行 `{ page, lines: string[] }`；`meta.task = { state, cursor }`，
`cursor` 按已落盘的最大页号前进。

---

## 4. 要改的地方（按这个顺序）

### 4.1 把「渲染一页成 200 DPI JPEG」抽成纯函数

现在这段内联在 `BookReader.runOcr` 里。抽到新文件 `src/client/book-ocr.js`：

```js
export async function renderPageForOcr(doc, pageNo, { dpi = 200, quality = 0.85 } = {})
  // → dataURL（'image/jpeg'）
```

**必须原样保留**：`scale: dpi / 72`、`fillStyle = '#ffffff'` + `fillRect` 填满、
`toDataURL('image/jpeg', quality)`。
`BookReader.runOcr` 改成调它 —— **行为一个字都不变**，既有测试必须全绿。

### 4.2 `extractBookPages` 加 OCR 兜底

文件 `src/client/book-digest.js:85-121`。当前循环体：

```js
const lines = extractPageLines(content?.items);
try { page.cleanup?.(); } catch {}
if (lines.length === 0) emptyPages += 1;
batch.push({ page: pageNo, lines });
```

改成（`lines` 要变成 `let`）：

```js
let lines = extractPageLines(content?.items);
let source = 'text';
if (lines.length === 0 && typeof ocrPage === 'function') {
  if (signal?.aborted === true) throw abortError();
  try {
    const text = await ocrPage(pageNo);          // 返回 '' = 这一页认不出
    if (typeof text === 'string' && text.trim() !== '') {
      lines = text.split('\n');
      source = 'ocr';
      ocrPages += 1;
    }
  } catch {
    ocrFailed += 1;                              // ★ 单页失败**不许中断整本**
  }
}
if (lines.length === 0) emptyPages += 1;
batch.push({ page: pageNo, lines, source });
```

- ★ `ocrPage` 必须是**注入的回调**，不要在这个模块里 import `library-api` ——
  `book-digest.js` 现在可以脱离网络被单测，别破坏这一点。
- 返回值加 `{ ocrPages, ocrFailed }`。
- `onProgress({ done, total, page, ocr })` —— 让 UI 能显示「正在识别第 N 页」。

### 4.3 `startDigest` 接线

`src/client/BookReader.jsx:1224-1277`。给 `extractBookPages` 多传一个：

```js
ocrPage: async (pageNo) => {
  const image = await renderPageForOcr(doc, pageNo);
  const result = await ocrBookPage(book.id, pageNo, image);
  return typeof result.text === 'string' ? result.text : '';
},
```

- 抽完的 `notify` 要如实说：「已抽出 N 章（其中 M 页由本机识别，K 页认不出）」。
- `saveBookState(book.id, { scanned: result.mode === 'scanned' })` 保持不动 ——
  OCR 补齐后 `mode` 不再是 `scanned`，标记会自动清掉。

### 4.4 让「来源」可见（**不许把 OCR 文字冒充文字层**）

1. `library-routes.js:744-757` 的 `clean` 映射里透传 `source`（只认 `'ocr'`，
   其余一律归 `'text'`）。
2. `segment.js` 的 `stats` 加 `ocrPages`（数 `source === 'ocr'` 的页）。
3. `digest-prompt.js`：逐章解读的提示词里**加一句** ——
   「本章文字来自本机 OCR，可能有个别错字；引用原文时不要臆补，拿不准就概括。」
   （这一句很关键：OCR 错字会变成 AI「引用的错原文」。）
4. `BookDigestPanel.jsx` 抽完显示：「其中 N 页由本机识别，个别字可能不准」。

### 4.5 UI：先说清代价再开始

`src/client/BookDigestPanel.jsx`：

- `book.scanned === true` 时，按钮文案从「抽取目录」改成「整本识别并抽目录」，
  旁边写「本机识别，约 5 分钟 / 400 页，不联网、不花钱」。
- 抽取中显示「正在识别第 N / 400 页」，不要只给一个进度条。
- ★ 5 分钟没有反馈 = 用户以为卡死。进度必须逐页动。

---

## 5. 三条最容易踩的坑

1. **`pages.jsonl` 是断点续跑凭据**（`meta.task.cursor` 按它前进）。OCR 页也必须写进它，
   形状**完全一致** `{ page, lines }`。**不要**把整本塞进 `ocr.json` —— 那个是「随手认一页」
   的缓存，上限 3000 页、按时间淘汰，语义完全不同。
2. **`SCANNED_RATIO = 0.2`**（`segment.js:32`）：`textRatio < 0.2` 就判 scanned、
   直接返回空章节。OCR 补上文字后自然越过这条线 —— **不要改这个阈值**，
   它管的是「文字版里夹杂几页图」的正常容忍度。
3. **桌面端没有 hmr**：改完必须退出并重开 App。改完发现「没生效」先想到这条，
   别去重新诊断代码。

---

## 6. 验收

### 单测（`npm test`，基线 1937 全绿）

- `book-digest.test.mjs`：
  - 有 `ocrPage` 且 `lines.length === 0` ⇒ 用它返回的文本；
  - **没给 `ocrPage` ⇒ 行为与现在完全一致**（反向对照，防回归）；
  - `ocrPage` 抛错 ⇒ 这一页当空、循环继续、`ocrFailed` 加一；
  - `ocrPage` 返回 `''` ⇒ 这一页仍算 empty，`ocrFailed` **不**加一。
- 新增 `book-ocr.test.mjs`：`renderPageForOcr` 的调用形状（`scale = dpi/72`、
  白底 `fillRect`、`toDataURL('image/jpeg'`）。
- `library-routes.test.mjs`：`/pages` 透传 `source`；不传时默认 `'text'`；
  `source: 'image'` 这种脏值被归一成 `'text'`。
- `segment.test.mjs`：`stats.ocrPages` 计数正确；OCR 页让 `mode` 从 `scanned`
  变成正常分段（构造 100 页、90 页空 + 10 页 OCR 文本，`textRatio` 仍 < 0.2 时要
  **明确它还是 scanned** —— 这条要想清楚再写，别让它变成假绿）。

### 真机

```bash
npm run verify:ocr-live <任意带中文的图>   # 先确认 Vision 链路没坏
```

然后拿用户的《如何阅读一本书》（387 页、`textRatio = 0`）走完整流程：
抽取 → 看是否出章节 → 生成 1 章解读 → **回原文对一下错字率**（这是唯一能证明
「解读有没有被 OCR 错字带偏」的方法）。

### 判据纪律（这个仓库反复踩的）

- 反向对照要落在**真源码的变异体**上，不要断言一个手写字面量（那样永远是绿的）。
- 「集合基数」与「集合内性质」写进**同一条**断言。
- 新增类名要过 `scripts/check-classes.mjs`；新增图标名要过 `test/icons.test.mjs`
  （`Icon` 找不到名字会**静默**画成圆圈）。
- ★ **不许借 `node_modules`**（用户明确怒斥过）。要解压之类的自己写。
- ★ 改了 `BookReader` 就要跑 `test/book-hooks-render.test.mjs`（真渲染一次）：
  hook 的依赖数组是**渲染期**求值的，把 `const` 声明写在 `useEffect` 之后就是
  `Cannot access 'X' before initialization` ⇒ 整个阅读页白屏。0.20.6 和 0.24.8
  各踩过一次。

---

## 7. 收尾

1. 版本号 → **0.25.0**（`package.json`）。
2. `CHANGELOG.md` 加一节（这个仓库的风格：先写用户原话与根因，再写判断依据）。
3. `README.md`「边界与已知限制」里那条「**扫描版读不了**」要改成分层说法：
   阅读/伴读 = 按页自动识别；逐章解读 = 整本识别（约 5 分钟/400 页）。
4. `npm test` 全绿后，在 `.workbuddy-ai/memory/YYYY-MM-DD.md` 记一笔
   （只记「为什么这么做」和踩到的坑，不记流水账）。
5. 提交（沙箱里 `git add` 可能被拦，交给用户终端）：

```bash
cd /Users/habhy/Documents/NPIE-program/dsh_plugins_desktop/dsh-npie-reader \
  && rm -f .git/index.lock .git/index.lock.orphan-* \
  && git add -A && git commit -F <提交信息文件>
```

---

## 附：如果用户改主意，另外两个选项的真实成本

| 选项 | 本数 | 成本 | 关键工作 |
| --- | --- | --- | --- |
| EPUB | 15（1.2%） | 2–3 天 | ZIP 解包（**自带 fflate，不借 node_modules**）→ `container.xml` → OPF spine/manifest → `nav.xhtml`/`toc.ncx` 出目录 → XHTML 渲染（图片路径重写、样式隔离、外链拦截）。**价值**：文字原生，`pages.jsonl` / 目录 / 解读 / 划选整条链可直接复用 |
| TXT | 1 | 半天 | 编码嗅探（GB18030 / Big5 / UTF-8 / BOM，**不能只当 UTF-8 读**）；无目录，只能按空行/字数切 |

**不要做 KFX**（0 本、专有容器 + DRM）；MOBI/AZW3 若要支持，先只做「纯文本 + 章节」抽取
（不还原排版），否则性价比不如直接指路 calibre 转 EPUB。
