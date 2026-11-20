# 第三方组件归属 / Third-Party Notices

dsh-npie-reader 自身的代码以 MIT 发布（见 `LICENSE`）。本文件列出随仓库分发、
或被打包进产物的第三方组件及其许可。

维护方式：新增第三方依赖时在下面加一节；`vendor/` 下的产物必须同时放入对应的许可文件。

---

## 1. pdf.js 6.4.299

- 位置：`vendor/pdfjs/`
- 许可：Apache License 2.0
- 版权：Copyright 2024 Mozilla Foundation
- 许可正文：`vendor/pdfjs/pdf.mjs` 与 `vendor/pdfjs/pdf.worker.mjs` 文件头的 `@licstart` 块；
  `vendor/pdfjs/wasm/LICENSE_JBIG2`、`LICENSE_QCMS`、`LICENSE_OPENJPEG`
- 升级方式：见 `vendor/pdfjs/README.md`

## 2. Milkdown 7.22.3

- 位置：`vendor/editor/editor.mjs`（由 `src/vendor/editor-entry.js` 经 esbuild 打包）
- 来源包：`@milkdown/kit`（devDependency）
- 许可：MIT
- 版权：Copyright (c) 2020-present Mirone
- 许可正文：`vendor/editor/LICENSE`

## 3. agentero motif（页级排版算法）

- 位置：`src/client/paper-reflow/`
- 许可：MIT
- 版权：Copyright (c) 2026 poco-ai
- 许可正文：`src/client/paper-reflow/MOTIF-LICENSE.txt`
- 说明：移植的是排版算法本身；适配层、字体度量与阅读顺序实现为本仓库自有代码。

## 4. chinese-independent-blogs（内置订阅目录）

- 位置：`vendor/chinese-independent-blogs/`
- 许可：MIT
- 版权：Copyright (c) 2019 Tim Qian
- 许可正文：`vendor/chinese-independent-blogs/LICENSE`
- 说明：仅包含目录数据（站点名 / URL / 分类），不含其站点内容。

## 5. shuting（多音字词典与 MP3 拼接判据）

- 位置：`src/speech-pronunciation.js`（多音字词表与「一次扫描 + 最长匹配」判据）、
  `src/speech-export.js`（`src/core/mp3.ts` 的「剥 ID3 + 按比特位找同步头 + 原样相接」判据）
- 许可：MIT
- 版权：Copyright (c) 2026 Zanbin Xu
- 移植范围：只搬词条与判据，未搬其用户自定义词典，也未搬整本一键导出
- 许可正文：

```text
MIT License

Copyright (c) 2026 Zanbin Xu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 不属于本仓库的引用

- **dalibre**：仅在 `CHANGELOG.md` 中作为「功能可移植性评估」的参考对象被提及，
  本仓库不包含其任何代码。
- **calibre**：仅在测试用例注释中出现，用于描述 calibre 生成的电子书结构特征。
