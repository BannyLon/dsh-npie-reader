# 澄境 | Limina

**阅人际，留寸心。** *Glean the World, Guard the Heart.*

装在 DeepSeek Harness 桌面端的阅读器：订阅你信得过的作者，读原文或中文版本，
把电子书读下去、听下去，然后把当前这一页丢给 Harness 里的模型接着问。

零第三方后端 —— 订阅自包含，书架只读**你自己配的源**（本机目录或你自己的网盘）。

`MIT` · 25 个 agent 工具 · 全部数据在本机

---

## 能做什么

| 模块 | 说明 | 细节 |
| --- | --- | --- |
| **订阅** | RSS 2.0 / Atom / RDF，最多 100 个源；分组、补全历史、停更标记 | [订阅与信息源](docs/features.md#订阅与信息源) |
| **阅读** | 正文净化、六种纸色、字号 / 行高 / 版心可调、大纲、⌘F 搜索 | [阅读体验](docs/features.md#阅读体验) |
| **翻译** | 原文 / 双语 / 中文三态；字幕走 Google 优先，剩下的交给模型 | [翻译与对照](docs/features.md#翻译与对照) |
| **听** | 播客单集边听边跟字幕；电子书朗读；没字幕可**本机识别**（音频不出本机） | [播客、字幕与语音](docs/features.md#播客字幕与语音) |
| **电子书** | PDF 按原版式；EPUB / MOBI / AZW3 / AZW / TXT 重排；目录、书内搜索、划线笔记 | [电子书](docs/features.md#电子书) |
| **解读与导出** | 抽正文 → 切章 → 逐章中文解读；整本导出成 agent 可按需加载的 skill 包 | [电子书](docs/features.md#电子书) |
| **日记** | 第三个 tab，一天一篇；灵感速记 `L`；私密条目独立加密、不进模型 | [日记与灵感](docs/features.md#日记与灵感) |
| **论文** | 第四个 tab：导入、摘要、找相关、页级翻译、引用 | [论文](docs/features.md#论文) |
| **给 agent 用** | 25 个工具：`rss_*` / `book_*` / `diary_*` / `paper_*` | [Agent 能力](docs/agent-tools.md) |

## 安装

插件装进 **DeepSeek Harness 桌面端**。`desktop` profile 由 Electron App 独占管理，
命令行 `dsh plugin --profile desktop …` 一律被拒 —— **用 GUI 装**。

1. 把仓库 clone 到本机任意目录，记下它的绝对路径；
2. 侧栏点 **「插件」**；
3. **「添加插件」** → 粘贴那个绝对路径 → **「立即启用」**；
4. **完全退出 App（`Cmd+Q`）再打开**，回到面板强刷 `Cmd+Shift+R`。

第 4 步不能省：插件在 Host 半区注册服务与本机 HTTP 路由，不重启不生效。
装好后日志出现 `dsh-npie-reader: service started`，侧栏出现「阅读器」入口。

细节（`link:` 前缀、对账机制、`failed to import` 排查）见
[安装与启动细节](docs/development.md#安装与启动细节)。

## 开发

```bash
npm install
npm run build     # lib/ 不入库，发布前现建
npm test          # 单元测试
npm run verify    # 构建 + 单测 + 契约守卫
```

带真 Chrome 的视觉 / 布局检查需要本机浏览器，单独跑 `npm run verify:all`。
完整命令、守卫脚本与内部契约见 [开发](docs/development.md)。

## 已知边界

- **不抓公众号**：做不到，只能读你自己搭的转 RSS 服务。
- **电子书不还原图片与原版式**（EPUB / MOBI / AZW3），要原版式请先转 PDF。
- **云端语音识别会上传音频**，界面上明说；本机识别则不出本机。
- **翻译与解读只用 Harness 当前选中的模型**，插件不代付、不代理。

做不到的、故意不做的、已知没解决的，全部列在 [边界与已知限制](docs/limits.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [功能详解](docs/features.md) | 48 项功能的完整说明，以及每一项「为什么这么做」 |
| [Agent 能力](docs/agent-tools.md) | 工具语义、时间窗、检索闸门、内置目录取舍 |
| [设计笔记](docs/design-notes.md) | 已修正的缺陷：现象 / 根因 / 修法 / 守卫用例 |
| [开发](docs/development.md) | 构建、测试、守卫脚本、契约、数据位置、安装细节 |
| [边界与限制](docs/limits.md) | 做不到的、故意不做的、已知没解决的 |
| [CHANGELOG](CHANGELOG.md) | 逐版本变更 |

## 许可

MIT（`Copyright (c) 2026 Banny`）。第三方组件的许可与版权行见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：pdf.js（Apache-2.0）、
Milkdown（MIT）、agentero motif（MIT）、chinese-independent-blogs（MIT）、shuting（MIT）。
