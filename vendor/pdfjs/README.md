# 内置 pdf.js

书架里 98.8% 的书是 PDF，阅读器直接用 pdf.js 渲染**原版版式**（不重排、不转文本）。

## 来源与版本

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/mozilla/pdf.js |
| 版本 | `pdfjsVersion = 6.4.299`（`pdfjsBuild = d0991a0d5`，文件头的 `@licstart` 块为 Copyright 2024 Mozilla Foundation） |
| 许可 | Apache License 2.0（见 `pdf.mjs` / `pdf.worker.mjs` 文件头，以及 `wasm/LICENSE_*`） |
| 目录来源 | 本机 `dsh_web/ebook-sorter/panel/vendor/pdfjs`（同一份，逐字复制） |

## 为什么整份内置（6.3 MB）而不是只放 `pdf.mjs`

- `cmaps/`（168 个）—— **中文 PDF 必需**。书架里全是中文文学书，没有 cmap 时
  用 Identity-H 编码的正文会整段渲染成空白或方块。
- `standard_fonts/`（14 个）—— 老书里大量「只嵌了字形名、没嵌字体」的 PDF，
  缺了它们会退化成难看的替代字体。
- `wasm/`（8 个）—— `openjpeg`（JPEG2000 图像，画册类）、`jbig2`（扫描件）、
  `qcms`（ICC 色彩）。`经典画册` 那一类没有它基本没法看。
- `pdf.worker.mjs` —— 解析放在 worker 里跑，否则打开一本 30 MB 的书会卡住整个界面。

## 怎么更新

从 https://github.com/mozilla/pdf.js/releases 取 `pdfjs-dist` 的 `legacy` 或标准
构建，把 `build/pdf.mjs`、`build/pdf.worker.mjs`、`cmaps/`、`standard_fonts/`、`wasm/`
整份替换掉即可。**替换后必须跑 `test/pdfjs-vendor.test.mjs`** —— 那个用例钉着
`PDFDataRangeTransport` 等导出名，以及版本字符串。上游一旦改了导出名（本插件用的
自定义 Range 传输正是靠它），阅读器会整块打不开，而这个用例会在**构建前**就变红。

## ★ 为什么必须用 `PDFDataRangeTransport`（而不是 `getDocument({ url })`）

这一版 pdf.js 的 `validateRangeRequestCapabilities()` 是**硬要求 `Content-Length`** 的：

```js
const s = parseInt(responseHeaders.get("Content-Length"), 10);
if (!Number.isInteger(s)) return r;          // ← 没有它就直接判定「不支持 Range」
```

而宿主把 renderer 的请求转发给本机服务时会**扣掉 `content-length`**
（Electron 的 `WITHHELD_RESPONSE_HEADERS`）。所以给 pdf.js 一个 URL 让它自己取，
它会判定「不支持 Range」，然后把**整本**拖下来 —— 一本 290 MB 的书就是灾难，
而且**没有任何报错**。走 `PDFDataRangeTransport` 时，长度由我们自己给
（`transport.length`），pdf.js 完全不看响应头，这条退化路径就不存在了。
