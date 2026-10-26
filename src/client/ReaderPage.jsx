/**
 * dsh-npie-reader reader panel. A compact channel toolbar, inline filter
 * pills, list rows with source/date, title, excerpt and thumbnail, and a
 * sticky reader toolbar with the reading-version select.
 *
 * Visual parameters come from DSH design tokens (`--dsw-*`); the plugin accent
 * goes through `var(--npc-brand, …)` so the NPIE theme can restyle it, and text
 * or fills that carry white text use the darker `--npc-brand-dark` variant.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeHtml } from '../host/sanitize.js';
import { markdownToHtml } from '../host/markdown.js';
import { READING_DEFAULTS, fontStack } from '../reading-settings.js';
import { effectiveModelLabel } from '../ai-model.js';
import { Icon } from './icons.jsx';
import { ChannelPicker, ChannelMark } from './ChannelPicker.jsx';
import { ReadingAppearance } from './ReadingAppearance.jsx';
import { SettingsPage } from './SettingsPage.jsx';
import { resolveReadingVersion, shouldAutoTranslate } from './reading-version.js';
import { Discover } from './Discover.jsx';
import { MediaDock } from './MediaDock.jsx';
import { quoteRange, selectedPassage } from './selection.js';
import { AskArticle } from './AskArticle.jsx';
import { articleAudioUrl } from '../media.js';
import { formatDay, formatFullDay } from './format-time.js';
import { printArticle } from './print-article.js';
import { channelAfterAdd, channelFailure, countFeeds, emptyListMessage, resolveChannel } from './channel-route.js';
import { staleNotice } from './source-health.js';
import { AddFeedDialog } from './dialogs.jsx';
import { groupNamesOf } from './groups.js';
import { LibraryApp } from './LibraryApp.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import REFINEMENTS from './refinements.css';

const PANEL_CSS = `
.npr-root{--npr-bg:var(--dsw-alias-bg-base);--npr-bg-2:var(--dsw-alias-bg-layer-1);--npr-fg:var(--dsw-alias-label-primary);--npr-muted:var(--dsw-alias-label-secondary);--npr-faint:var(--dsw-alias-label-tertiary);--npr-border:var(--dsw-alias-border-l1);--npr-border-strong:var(--dsw-alias-border-l2);--npr-hover:var(--dsw-alias-interactive-bg-hover);--npr-accent:var(--npc-brand,var(--dsw-alias-brand-primary));--npr-accent-strong:var(--npc-brand-dark,var(--dsw-alias-brand-primary));--npr-scrim:var(--dsw-alias-bg-mask-1);/* 伴读对话容器专用：refinements.css 里那块「把宿主 --dsw-* 令牌改写成阅读主题色」的覆写引用了它们。
   ★ 这两个变量以前**从来没被定义过**。后果不是「覆写不生效」，而是更糟的一种：在自定义属性里引用一个未定义的 var()，
   该声明会变成 guaranteed-invalid ⇒ 解析成**空值**，而 .npr-companion 上那条 --dsw-alias-bg-base 又被它**覆写**了，
   于是宿主原生对话卡片（它靠 var(--dsw-alias-bg-base) 画底）在整个子树里底色变成透明、边框消失。
   实测：伴读里所有卡片没有底色，而源码 grep、打包、类型检查全绿。
   ⇒ 教训写在这里：**绝不能留一个引用了不存在变量的声明块**，它的失败方式是静默把别人的变量置空。 */--npr-chat-bg:var(--npr-bg);--npr-chat-fg:var(--npr-fg);--npr-elevation:var(--dsw-elevation-panel,var(--dsw-shadow-lv3));--npr-surface:var(--dsw-alias-bg-layer-3);--npr-font-size:19px;--npr-line-height:1.9;--npr-article-width:804px;--npr-list-width:300px;display:flex;flex-direction:column;height:100%;min-width:0;padding:0;color:var(--npr-fg);background:var(--npr-bg);outline:none;container-type:inline-size}
/* ★ 阅读主题（纸色）与宿主主题是**两根独立的轴**。纸色主题回答的是「这张纸是什么颜色」，
   宿主主题回答的是「外面那圈界面是深是浅」—— 两者可以任意组合，必须正交。

   所以一旦选定纸色，这一整套语义色就必须从**纸自己的两色**派生，不能继续挂在 --dsw-* 上。
   反例（修之前的实测值）：宿主深色 + 纸色 light 时，宿主那套浅灰文字压在纸上，
   摘要对比度 **2.64**、日期 **4.14** —— 11–13px 的字根本读不清。

   比例不是拍脑袋定的：以余量最小的 paper(#f5efdf / #40382e，整幅只有约 10:1)为基准，
   把「正文 / 次要 / 更次要」三级摊在 [4.5, 10] 这段区间里 ⇒ 100% / 84% / 74%。
   本项目对 11–12px 小字一贯按 4.5 收口（见 refinements.css 里「警告色实测 2.15」那段）。

   ★ 只用 color-mix 就地算，**刻意不多出四个需要跟主题同步维护的变量**：
   多一个变量就多一处会漂移的地方，而漂移的表现恰好是「某个主题下字看不清」。 */
.npr-root[data-reading-theme]:not([data-reading-theme=auto]){--npr-muted:color-mix(in srgb,var(--npr-fg) 84%,var(--npr-bg));--npr-faint:color-mix(in srgb,var(--npr-fg) 74%,var(--npr-bg));--npr-border:color-mix(in srgb,var(--npr-fg) 12%,var(--npr-bg));--npr-border-strong:color-mix(in srgb,var(--npr-fg) 20%,var(--npr-bg));--npr-hover:color-mix(in srgb,var(--npr-fg) 6%,var(--npr-bg))}
.npr-root{min-height:0;overflow:hidden}.npr-root button,.npr-root input,.npr-root select,.npr-root textarea{-webkit-app-region:no-drag}
/* 窗口拖动区：主面板页面**自己**负责声明，宿主只在打了 data-window-drag 的行上开拖动。
   宿主桌面端 base.css 里与拖动有关的规则一共四条（从 app.asar 里读出来的）：
     html[data-platform=darwin] [data-window-drag]{-webkit-app-region:drag}
     html[data-platform=darwin] [data-window-drag-recall]{-webkit-app-region:no-drag}
     html[data-platform=darwin] body>:not(#root){-webkit-app-region:no-drag}
     html[data-platform=darwin] :is(button,a,input,select,textarea,summary,
       [contenteditable=true],[tabindex],[role=dialog],[role=menu],…){-webkit-app-region:no-drag}
   ★★ 关键：Chromium 先把 drag 矩形求并、再把 no-drag 矩形**求差**，不是「取最内层」。
   所以只要**任何祖先**命中最后那条 no-drag 选择器，它的整块矩形就会把子元素的 drag
   区域**减没** —— 标记一个不少、源码 grep 全绿，拖动却完全失效。
   本插件踩过的坑就是根节点上的 tabIndex={0}（见 JSX 里那段注释）。
   行的空白段可拖，控件保持可点：宿主全局把 button/a/input/select/… 都设成 no-drag。
   ★ 本段在模板串里：注释里**绝对不能出现反引号**，否则会提前闭合模板串。
   ★★ 这条不是理论 —— 0.6.0 第一版就在这里踩了：注释里用反引号写了
   .npr-book-toolbar 与 [data-window-drag]，模板串在第一个反引号处闭合，
   后面那段被解析成「模板串 .npr **减去** book **减去** toolbar」这样一个
   **语法合法**的表达式。于是 esbuild 正常打包、659 个测试全绿，真机上插件一加载就
   ReferenceError: book is not defined ⇒ 整个 DSH 起不来。
   ⇒ 注释里要点名标识符就**别用反引号**，直接用「」或裸写。真跑客户端 factory 的
   守卫见 test/client-runtime.test.mjs（那个用例会真的执行产物，不是查字符串）。
   ★ 三条拖动行都要在这里点名：.npr-book-toolbar 是书架那半边的（电子书阅读器）。
     漏掉它不会报错 —— 它还能靠宿主那条全局 [data-window-drag] 规则拖 —— 但那就等于
     放弃了「宿主改版时插件不会**静默**失去拖动」这个唯一的保险，而且三行里两行有、一行
     没有，读代码的人会以为那是故意的。 */
.npr-root .npr-sidebar-toolbar,.npr-root .npr-reader-toolbar,.npr-root .npr-book-toolbar{-webkit-app-region:drag}
.npr-root :focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--npr-accent));outline-offset:2px}.npr-root *{box-sizing:border-box}
.npr-workarea{display:flex;flex:1;min-height:0;min-width:0}.npr-workarea>.npr-layout{min-width:0}.npr-workarea.has-companion>.npr-layout{grid-template-columns:minmax(0,1fr)}.npr-workarea.has-companion>.npr-layout>.npr-sidebar,.npr-workarea.has-companion>.npr-layout>.npr-resize{display:none}.npr-workarea.has-companion .npr-reader{display:block}.npr-companion-divider{flex:0 0 6px;cursor:col-resize;touch-action:none;background:var(--npr-border);z-index:4}.npr-companion-divider:hover,.npr-companion-divider:focus-visible,.npr-companion-divider[data-dragging=true]{background:var(--npr-accent)}.npr-companion{width:var(--npr-companion-width,44%);flex:0 0 var(--npr-companion-width,44%);min-width:0;max-width:none;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.npr-companion-header{display:flex;align-items:center;gap:8px;padding:8px 12px;flex-shrink:0}.npr-companion-header strong{flex:1}.npr-companion-context{padding:8px 12px;border-bottom:1px solid var(--npr-border);font-size:12px;flex-shrink:0}.npr-companion-context strong,.npr-companion-context small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.npr-companion-context blockquote{max-height:70px;overflow:auto;margin:6px 0;white-space:pre-wrap}.npr-companion-loading,.npr-companion-error{padding:16px;font-size:13px;color:var(--dsw-alias-label-secondary)}.npr-companion-error{color:var(--dsw-alias-state-error-primary)}.npr-companion-error button{margin-left:8px}.npr-native-chat{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}.npr-native-chat>[data-conversation-content]{flex:1;min-height:0}@container (max-width:700px){.npr-workarea.has-companion{flex-direction:column}.npr-workarea.has-companion>.npr-layout{flex:1;min-height:180px}.npr-companion-divider{flex-basis:6px;width:100%;cursor:row-resize}.npr-companion{width:100%;flex:0 0 var(--npr-companion-width,50%);min-width:0;max-width:none;min-height:180px}}

.npr-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.npr-layout{flex:1;min-height:0;display:grid;grid-template-columns:min(var(--npr-list-width),calc(100cqw - 330px)) 1px minmax(0,1fr)}
.npr-sidebar{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--npr-bg-2)}
.npr-sidebar-toolbar{display:flex;align-items:center;gap:2px;height:44px;flex-shrink:0;padding:5px 8px 5px 12px}
.npr-root .npr-channel{min-width:0;flex:1;display:flex;align-items:center;justify-content:flex-start;gap:7px;padding:4px 0;height:32px;border:0;background:transparent;color:var(--npr-fg);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.npr-root .npr-channel:hover{color:var(--npr-accent)}
.npr-channel-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.npr-channel-label + svg{flex:0 0 auto;color:var(--npr-muted)}
.npr-filters{display:flex;gap:4px;align-items:center;padding:0 12px 8px}
.npr-root .npr-filters button{height:26px;padding:2px 10px;font:inherit;font-size:11px;color:var(--npr-muted);background:transparent;border:0;border-radius:5px;cursor:pointer}
.npr-root .npr-filters button[aria-pressed=true]{background:var(--npr-hover);color:var(--npr-fg)}
/* ★ 设置齿轮在**工具栏**里（2026-10-23 用户定），不在筛选 chip 行里：
   它是「整个插件」的动作，而那一排 chip 是「对当前列表做一个筛选」——
   挂在 chip 行最右会被读成「筛选器的第四个选项」。margin-left:auto 把它推到最右；
   刷新按钮因此不再吃 auto（删掉了它在 refinements 里那条 margin-left:auto），
   否则两个按钮争同一个空档，齿轮只能贴着刷新。 */
.npr-sidebar-toolbar .npr-settings-button{margin-left:auto;display:inline-flex;align-items:center;justify-content:center}
.npr-search-box{padding:0 12px 10px}
.npr-search-box input{width:100%;height:30px;font:inherit;font-size:12px;color:var(--npr-fg);background:var(--npr-bg);border:.5px solid var(--npr-border-strong);border-radius:6px;padding:0 9px}
.npr-search-box.is-hidden{display:none}
.npr-status{padding:8px 12px;font-size:12px;color:var(--npr-muted);line-height:1.6}
.npr-status:empty{display:none}
.npr-status.is-error{color:var(--dsw-alias-state-error-primary)}
.npr-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.npr-root button.npr-entry{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;align-items:start;width:100%;text-align:left;height:auto;white-space:normal;border:0;border-radius:0;background:transparent;color:var(--npr-fg);padding:12px 16px 13px 22px;cursor:pointer;font:inherit}
.npr-root button.npr-entry:not(:has(.npr-entry-thumb)){grid-template-columns:minmax(0,1fr)}
.npr-root button.npr-entry::after{content:'';position:absolute;bottom:0;left:22px;right:16px;height:1px;background:var(--npr-border);opacity:.6}
.npr-root button.npr-entry:hover{background:var(--npr-hover)}
.npr-root button.npr-entry.npr-selected{background:var(--npr-hover);box-shadow:inset 2px 0 0 var(--npr-accent)}
.npr-entry-copy{display:contents}
.npr-entry-meta{grid-column:1 / -1;display:flex;align-items:center;gap:8px;min-width:0;color:var(--npr-muted);font-size:12px;line-height:16px}
.npr-source-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1;font-weight:500}
.npr-date{order:1;margin-left:auto;color:var(--npr-faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.npr-entry-title{grid-column:1;min-width:0;display:flex;align-items:baseline;gap:6px;margin-top:5px}
.npr-unread-dot,.npr-read-dot{flex-shrink:0;width:6px;height:6px;border-radius:50%;background:var(--npr-accent);position:absolute;left:9px;margin-top:8px}
.npr-read-dot{background:transparent}
.npr-entry h3{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--npr-fg);overflow-wrap:anywhere;flex:1;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.npr-entry.npr-no-summary h3{-webkit-line-clamp:3}
.npr-entry.npr-read h3{font-weight:400;opacity:.78}
.npr-entry.npr-read .npr-summary{color:var(--npr-faint)}
.npr-bookmarked{display:inline-flex;align-items:center;color:var(--npr-muted)}
.npr-bookmarked svg{width:12px;height:12px;fill:currentColor}
.npr-summary{grid-column:1;min-width:0;margin:4px 0 0;color:var(--npr-muted);font-size:13px;line-height:20px;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.npr-entry-thumb{grid-column:2;grid-row:2 / span 2;margin-top:7px;width:64px;height:64px;overflow:hidden;border-radius:6px;background:var(--npr-border)}
.npr-entry-thumb img{width:100%;height:100%;display:block;object-fit:cover}
.npr-empty{padding:30px 20px;text-align:center;color:var(--npr-muted);line-height:1.8;font-size:13px}
.npr-empty p{margin:0}
.npr-empty button{margin-top:10px}
.npr-empty-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:10px}
.npr-empty-actions button{margin-top:0}
.npr-root .npr-more{display:block;margin:16px auto 24px;padding:6px 14px;font:inherit;font-size:12px;color:var(--npr-muted);background:transparent;border:.5px solid var(--npr-border-strong);border-radius:6px;cursor:pointer}
.npr-root .npr-more:hover{background:var(--npr-hover)}
.npr-resize{position:relative;background:var(--npr-border);z-index:4;cursor:col-resize;touch-action:none}
.npr-resize::after{content:'';position:absolute;left:-4px;top:0;bottom:0;width:9px}
.npr-resize:hover{background:var(--npr-border-strong)}
.npr-reader{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;position:relative;outline:none;background:var(--npr-bg)}
.npr-reader-toolbar{display:flex;align-items:center;gap:6px;height:44px;padding:5px 12px;position:sticky;top:0;background:var(--npr-bg);z-index:3}
.npr-version-switch{display:inline-flex;align-items:center;gap:3px;height:30px;padding:0 7px;border:1px solid var(--npr-border);border-radius:999px;background:var(--npr-bg-2);color:var(--npr-muted);font-size:12px;white-space:nowrap}.npr-version-switch span{font-size:11px}.npr-root .npr-mode-select{appearance:none;border:0;background:transparent;width:auto;max-width:110px;padding:3px 1px;height:26px;font:inherit;font-size:12px;color:var(--npr-fg);cursor:pointer;outline:none}.npr-version-switch:focus-within{outline:1px solid var(--npr-accent);outline-offset:1px}
.npr-root .npr-mode-select:disabled{opacity:.6;cursor:default}
.npr-reader-nav{display:flex;gap:0;margin-left:10px}
.npr-actions{display:flex;align-items:center;gap:2px;margin-left:auto;position:relative}
.npr-root .npr-icon{display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;width:32px;height:32px;padding:7px;border:0;border-radius:5px;background:transparent;color:var(--npr-muted);cursor:pointer}
.npr-root .npr-icon:hover{color:var(--npr-fg);background:var(--npr-hover)}
.npr-root .npr-icon svg{width:17px;height:17px}
.npr-root .npr-icon.is-active svg{fill:currentColor}
.npr-root .npr-icon.is-loading svg{animation:npr-spin 1.2s linear infinite}
@keyframes npr-spin{to{transform:rotate(360deg)}}
.npr-root.npr-focus .npr-layout{grid-template-columns:minmax(0,1fr)}
.npr-root.npr-focus .npr-sidebar,.npr-root.npr-focus .npr-resize{display:none}
.npr-article{max-width:var(--npr-article-width);margin:0 auto;padding:30px clamp(24px,5%,60px) 90px}
.npr-article-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-bottom:14px;color:var(--npr-muted);font-size:12px;line-height:1.6}
.npr-article-head .npr-mode-chip{padding:1px 7px;border:.5px solid var(--npr-border-strong);border-radius:999px;font-size:11px}
.npr-article h1{font-size:clamp(24px,2.5cqw,32px);line-height:1.5;letter-spacing:-.025em;margin:0 0 26px;overflow-wrap:anywhere;font-weight:600;text-wrap:balance;font-family:var(--npr-font-family)}
.npr-article h1 a{color:inherit;text-decoration:none}
.npr-article h1 a:hover{text-decoration:underline;text-underline-offset:.15em}
.npr-prose{font-family:var(--npr-font-family);font-size:var(--npr-font-size);line-height:var(--npr-line-height);overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
.npr-prose p{margin:1.1em 0}
.npr-prose h2{margin:1.8em 0 .7em;font-size:1.3em;line-height:1.6}
.npr-prose h3{margin:1.6em 0 .6em;font-size:1.12em}
.npr-prose img{display:block;max-width:100%;height:auto;border-radius:6px;margin:1.2em 0}
.npr-prose pre{overflow:auto;padding:16px;border-radius:6px;background:var(--npr-bg-2);font-size:13px;line-height:1.6}
.npr-prose pre,.npr-prose code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.npr-prose blockquote{margin:1.4em 0;padding:16px 20px;border:0;background:var(--npr-bg-2);border-radius:6px}
.npr-prose table{display:block;overflow:auto;border-collapse:collapse;max-width:100%}
.npr-prose td,.npr-prose th{border:1px solid var(--npr-border);padding:8px}
.npr-prose a{color:var(--npr-accent-strong);text-underline-offset:3px}
.npr-root[data-images=false] .npr-prose img{display:none}
.npr-missing{margin-top:24px;padding:22px;border:1px dashed var(--npr-border-strong);border-radius:10px;text-align:center;color:var(--npr-muted);font-size:13px;line-height:1.8}
.npr-translating{display:flex;align-items:center;gap:8px;margin-top:14px;padding:9px 12px;border:.5px solid var(--npr-border-strong);border-radius:9px;background:var(--npr-hover);color:var(--npr-muted);font-size:12px;line-height:1.6}
.npr-translating svg{flex:none;animation:npr-spin 1.4s linear infinite}
.npr-translating button{margin-left:auto;flex:none;padding:3px 9px;font:inherit;font-size:11px;color:var(--npr-muted);background:transparent;border:.5px solid var(--npr-border-strong);border-radius:6px;cursor:pointer}
.npr-translating button:hover{background:var(--npr-bg);color:var(--npr-fg)}
@keyframes npr-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.npr-translating svg{animation:none}}
/* 「这次只翻了一部分」。与上面那条进度条**分开**：那条是「正在进行」，
   这条是「已经完成了，但没做全」—— 混用同一种样式会让「进行中」和
   「做了一半」看起来一样。没有动画：它不是一个正在进行的状态。
   文字用 --npr-fg 而不是品牌色：品牌色在浅色底上当正文对比度不够（本项目记过这条）。 */
.npr-translation-partial{display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding:9px 12px;border:.5px solid color-mix(in srgb, var(--npr-accent) 45%, var(--npr-border));border-radius:9px;background:color-mix(in srgb, var(--npr-accent) 8%, var(--npr-bg));color:var(--npr-fg);font-size:12px;line-height:1.6}
.npr-translation-partial svg{flex:none;margin-top:2px;color:var(--npr-accent-strong)}
.npr-welcome{width:min(100%,440px);margin:clamp(48px,14vh,160px) auto 48px;padding:0 28px;text-align:left}
.npr-welcome-brand{font-size:10px;font-weight:600;letter-spacing:.2em;color:var(--npr-faint);margin-bottom:28px}
.npr-welcome h2{font-family:var(--npr-font-family);font-size:clamp(25px,3vw,34px);font-weight:400;letter-spacing:.02em;line-height:1.5;margin:0 0 12px;color:var(--npr-fg)}
.npr-welcome-intro{font-size:13px;line-height:1.8;color:var(--npr-muted);margin:0}
/* 说明文字分成三段（书架 / 怎么开始 / 能干什么）：段间留 12px，比行距 23px 的一半多一点，
   读起来是「三块」而不是「一大段被切开」—— 断句靠间距，不靠标点。 */
.npr-welcome-intro + .npr-welcome-intro{margin-top:12px}
/* 「阅读」这种界面标签是**一个词**，不能让换行把它劈成「阅 / 读」—— 中文可以在任意字之间断行，
   而四个字的标签被劈开就认不出来了。只包标签本身，不包整句（整句 nowrap 会顶破 440px 版心）。 */
.npr-welcome-intro .npr-keep{white-space:nowrap}
.npr-welcome-keys{display:flex;flex-wrap:wrap;gap:18px;margin-top:44px;color:var(--npr-faint);font-size:10px}
.npr-welcome-keys > span{display:flex;align-items:center;gap:5px}
.npr-welcome-keys kbd{font:inherit;font-size:10px}
.npr-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--npr-surface);border:.5px solid var(--npr-border-strong);color:var(--dsw-alias-label-primary);border-radius:10px;padding:8px 16px;font-size:13px;box-shadow:var(--npr-elevation);z-index:60}
.npr-toast.is-error{color:var(--dsw-alias-state-error-primary)}
.npr-menu{position:absolute;top:36px;right:0;min-width:210px;padding:5px;background:var(--npr-surface);border:.5px solid var(--npr-border-strong);border-radius:10px;box-shadow:var(--npr-elevation);z-index:20;display:flex;flex-direction:column}
.npr-menu button{display:flex;align-items:center;gap:9px;padding:7px 10px;font:inherit;font-size:13px;text-align:left;color:var(--npr-fg);background:transparent;border:0;border-radius:6px;cursor:pointer}
.npr-menu button:hover:not(:disabled){background:var(--npr-hover)}
.npr-menu button:disabled{opacity:.45;cursor:default}
.npr-menu hr{margin:5px 4px;border:0;border-top:.5px solid var(--npr-border)}
.npr-modal-backdrop{position:fixed;inset:0;background:var(--npr-scrim);display:flex;align-items:center;justify-content:center;z-index:55}
.npr-modal{width:min(480px,92vw);max-height:86vh;display:flex;flex-direction:column;gap:10px;padding:18px;background:var(--npr-surface);border:.5px solid var(--npr-border-strong);border-radius:14px;color:var(--dsw-alias-label-primary);overflow:auto}
.npr-modal.is-wide{width:min(620px,94vw)}
.npr-modal h2{margin:0;font-size:15px}
.npr-modal input[type=text],.npr-modal input[type=url],.npr-modal input:not([type]),.npr-modal select,.npr-modal textarea{width:100%;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px}
.npr-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.npr-modal-actions button{padding:6px 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer}
.npr-settings-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--npr-scrim)}
.npr-settings-page{width:min(820px,100%);height:min(780px,100%);min-height:0;display:flex;flex-direction:column;border:1px solid var(--npr-border);border-radius:14px;background:var(--npr-surface);color:var(--npr-fg);box-shadow:var(--npr-elevation);overflow:hidden}
.npr-settings-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 10px}.npr-settings-head>div{display:flex;align-items:baseline;gap:9px}.npr-settings-head strong{font-size:18px}.npr-settings-head span{font-size:12px;color:var(--npr-muted)}
.npr-settings-tabs{display:flex;gap:4px;padding:0 16px 10px;border-bottom:1px solid var(--npr-border)}.npr-settings-tabs button{border:0;border-radius:7px;background:transparent;color:var(--npr-muted);padding:7px 14px;font:inherit;cursor:pointer}.npr-settings-tabs button[aria-current=page]{background:var(--npr-bg-2);color:var(--npr-fg);font-weight:600}
.npr-settings-content{flex:1;min-height:0;overflow:auto;padding:18px 22px}.npr-settings-content section{display:flex;flex-direction:column;gap:14px}.npr-settings-content h3{font-size:14px;margin:8px 0 0}.npr-settings-content p{line-height:1.6}.npr-settings-content .npr-reading-settings-fields{max-width:500px}.npr-settings-content .npr-reading-setting{grid-template-columns:110px minmax(0,1fr) 54px}.npr-settings-content .npr-reading-reset{max-width:500px;margin-top:0}
.npr-settings-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:55px;padding:10px 20px;border-top:1px solid var(--npr-border);font-size:12px;color:var(--npr-muted)}.npr-settings-footer button{border:0;border-radius:7px;background:var(--npr-accent-strong);color:white;padding:7px 14px;font:inherit;cursor:pointer}.npr-settings-footer button:disabled{opacity:.5;cursor:default}
@container (max-width:560px){.npr-settings-backdrop{padding:0}.npr-settings-page{width:100%;height:100%;border-radius:0}.npr-settings-content{padding:16px}.npr-settings-content .npr-reading-setting{grid-template-columns:80px minmax(0,1fr) 50px}}
.npr-reading-settings{position:absolute;z-index:5;top:100%;right:12px;max-height:calc(100vh - 180px);overflow:auto;width:300px;max-width:calc(100vw - 32px);padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--npr-surface);color:var(--dsw-alias-label-primary);box-shadow:var(--npr-elevation)}
.npr-reading-settings-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.npr-reading-settings-head strong{font-size:14px}
.npr-reading-settings-head button{padding:4px 10px;font:inherit;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:inherit;cursor:pointer}
.npr-reading-settings-fields{display:grid;gap:12px}
.npr-reading-setting{display:grid;grid-template-columns:72px minmax(0,1fr) 54px;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.npr-reading-setting select,.npr-reading-setting input{grid-column:2/-1;min-width:0;font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px}
.npr-reading-setting select{width:100%;height:32px;appearance:auto}.npr-reading-setting output{white-space:nowrap;grid-column:3;grid-row:1;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.npr-reading-setting input[type=range]{grid-row:2;padding:0;border:0;background:transparent}
.npr-reading-setting-check{grid-template-columns:84px auto}
.npr-reading-setting-check input{grid-column:2;justify-self:start}
.npr-reading-reset{width:100%;margin-top:14px;padding:6px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;cursor:pointer}
.npr-channel-backdrop{position:fixed;inset:0;z-index:58;background:var(--npr-scrim);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
.npr-channel-picker{width:min(430px,92vw);max-height:520px;display:flex;flex-direction:column;padding:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--npr-surface);color:var(--dsw-alias-label-primary);box-shadow:var(--npr-elevation);overflow:hidden}
.npr-channel-top{display:flex;gap:6px;align-items:center;margin-bottom:8px}
.npr-channel-top input[type=search]{flex:1;height:36px;font:inherit;font-size:13px;color:inherit;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px}
.npr-channel-manage{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 10px;font:inherit;font-size:12px;color:inherit;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;white-space:nowrap}
.npr-channel-options{overflow-y:auto;overscroll-behavior:contain;min-height:0}
.npr-channel-section{padding:14px 10px 5px;color:var(--dsw-alias-label-secondary);font-size:11px}
.npr-channel-option-wrap{display:flex;align-items:center;border-radius:6px}
.npr-channel-option{display:flex;align-items:center;gap:9px;min-width:0;flex:1;padding:7px 10px;min-height:36px;text-align:left;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.npr-channel-option:hover{background:var(--dsw-alias-bg-layer-2)}
.npr-channel-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.npr-channel-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.npr-channel-subtitle{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.npr-channel-check{display:flex;flex-shrink:0;color:var(--npr-accent)}
.npr-channel-empty{padding:22px 12px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:13px}
.npr-channel-close{align-self:flex-end;margin-top:6px;padding:5px 12px;font:inherit;font-size:12px;color:inherit;background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;cursor:pointer}
.npr-btn{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;text-decoration:none}
.npr-btn:hover{background:var(--npr-hover)}
.npr-btn:disabled{opacity:.5;cursor:default}
.npr-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.npr-dialog-backdrop{position:fixed;inset:0;background:var(--npr-scrim);display:flex;align-items:center;justify-content:center;z-index:57}
.npr-dialog{background:var(--npr-surface);border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px;width:min(480px,92vw);max-height:86vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}
.npr-dialog h3{margin:0;font-size:15px}
.npr-dialog input,.npr-dialog select,.npr-dialog textarea{width:100%;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px}
.npr-dialog fieldset{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;display:grid;gap:8px}
.npr-dialog.npr-discover{width:min(720px,calc(100vw - 32px));height:min(740px,calc(100vh - 56px));max-height:none;padding:0;gap:0;overflow:hidden;border-radius:16px;box-shadow:var(--npr-elevation)}
.npr-discover-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:23px 26px 16px;flex:none}
.npr-discover-head h3{font-size:19px;line-height:1.4;font-weight:650}
.npr-discover-head p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.npr-discover-head .npr-icon{margin:-4px -6px 0 0;flex:none}
.npr-discover-filters{padding:0 26px 8px;flex:none}
.npr-discover-search{display:flex;align-items:center;gap:9px;height:40px;padding:0 12px;background:var(--dsw-alias-bg-layer-2);border:1px solid transparent;border-radius:9px;color:var(--dsw-alias-label-secondary)}
.npr-discover-search:focus-within{border-color:var(--npr-accent)}
.npr-discover-search svg{width:16px;height:16px;flex:none}
.npr-dialog .npr-discover-search input{min-width:0;width:100%;height:100%;padding:0;border:0;background:transparent;outline:0;font-size:13px}
.npr-discover-categories{display:flex;gap:6px;align-items:center;overflow-x:auto;padding:14px 0 10px}
.npr-discover-categories button{white-space:nowrap;border:0;border-radius:7px;padding:6px 11px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.npr-discover-categories button:hover{background:var(--dsw-alias-bg-layer-2)}
.npr-discover-categories button.active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.npr-discover-filter-line{height:30px;display:flex;justify-content:space-between;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.npr-dialog .npr-discover-filter-line select{width:auto;max-width:180px;padding:3px 24px 3px 8px;font-size:12px;border:0;background:transparent;cursor:pointer}
.npr-discover-filter-line select:disabled{opacity:.45;cursor:default}
.npr-discover-results{overflow-y:auto;min-height:0;flex:1;padding:0 26px}
.npr-discover-row{display:flex;align-items:center;gap:12px;min-height:68px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.npr-discover-avatar{display:grid;place-items:center;width:36px;height:36px;flex:none;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:15px;font-weight:600}
.npr-discover-info{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}
.npr-discover-info strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}
.npr-discover-info>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.npr-discover-dot{padding:0 2px}
.npr-discover-add{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;min-width:72px;height:30px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.npr-discover-add:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.npr-discover-add:disabled{opacity:.5;cursor:default}
.npr-discover-add svg{width:13px;height:13px}
.npr-discover-more{display:block;margin:14px auto 18px;padding:6px 14px;border:0;background:transparent;color:var(--npr-accent-strong);font:inherit;font-size:12px;cursor:pointer}
.npr-discover-empty{padding:72px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.npr-discover-foot{flex:none;display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between;border-top:.5px solid var(--dsw-alias-border-l1);padding:10px 26px 14px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.npr-discover-foot a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.npr-discover-message{width:100%;padding:4px 0;color:var(--dsw-alias-label-primary);font-size:12px}
.npr-discover-head-actions{display:flex;align-items:center;gap:6px;flex:none}
/* 「转 RSS 服务」配置块。2026-10-08 从探索页的「添加信息源」表单里搬到这里命名空间下，
   因为它现在挂在设置页的「订阅管理」里，不再属于探索页。 */
.npr-service{margin-top:10px;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.npr-service-lead{margin:0 0 8px;font-size:11px;line-height:1.65}
.npr-service-row{display:flex;gap:8px;align-items:center}
.npr-service-row input{flex:1;min-width:0}
.npr-service-row button{flex:none;height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.npr-service-row button:hover:not(:disabled){background:var(--npr-hover)}
.npr-service-row button:disabled{opacity:.45;cursor:default}
.npr-service-probe{margin-top:8px;font-size:11px;line-height:1.6}
.npr-service-probe.is-unreachable{color:var(--dsw-alias-state-error-primary)}
.npr-service-note{margin:8px 0 0;font-size:11px;line-height:1.65}
.npr-service-note code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-base);font-size:11px}
.npr-service-note .npr-linkish{margin-left:8px}
.npr-linkish{border:0;background:transparent;padding:0;color:var(--npr-accent-strong);font:inherit;font-size:11px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.npr-discover-provenance{display:flex;align-items:flex-start;gap:6px;padding:2px 0 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.55}
.npr-discover-provenance svg{width:14px;height:14px;flex:none;margin-top:1px}
.npr-discover-drop{display:grid;place-items:center;width:30px;height:30px;flex:none;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.npr-discover-drop:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.npr-discover-drop:disabled{opacity:.45;cursor:default}
.npr-discover-drop svg{width:15px;height:15px}
.npr-discover-restore{border:0;background:transparent;padding:0;color:var(--npr-accent-strong);font:inherit;font-size:11px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.npr-discover-restore:disabled{opacity:.45;cursor:default}
@media (max-width:600px){.npr-dialog.npr-discover{height:calc(100vh - 30px)}.npr-discover-head{padding:18px 18px 13px}.npr-discover-filters{padding:0 18px 6px}.npr-discover-results{padding:0 18px}.npr-discover-foot{padding:10px 18px}.npr-discover-avatar{width:32px;height:32px}.npr-discover-row{gap:9px}}
.npr-root{position:relative}.npr-root[data-titlebar=true]{padding-top:40px}.npr-root[data-titlebar=true]::before{content:"";position:absolute;top:0;left:0;right:0;height:38px;-webkit-app-region:drag}.npr-reading-settings{flex-shrink:0}.npr-reading-setting select{color:var(--dsw-alias-label-primary);padding-right:22px}.npr-reading-setting input[type=range]{width:100%;height:20px}.npr-reader-toolbar{height:auto;min-height:44px;flex-wrap:wrap}.npr-reader-nav{margin-left:0}.npr-mode-select{flex-shrink:0}
@container (max-width:700px){.npr-layout{grid-template-columns:min(240px,42cqw) 1px minmax(0,1fr)}.npr-article{padding:20px 18px 70px}.npr-actions{margin-left:0}.npr-reading-settings{position:fixed;right:12px;top:70px}.npr-entry-thumb{width:44px;height:44px}.npr-root button.npr-entry{padding:10px 10px 10px 18px}.npr-reader-toolbar{gap:2px;padding:4px}.npr-root .npr-icon{width:28px;height:28px;padding:5px}}
@container (max-width:460px){.npr-layout{grid-template-columns:minmax(0,1fr)}.npr-reader{display:none}.npr-root.npr-focus .npr-reader{display:block}.npr-resize{display:none}}
@media (prefers-reduced-motion: reduce){.npr-root *,.npr-root *::before,.npr-root *::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important;scroll-behavior:auto !important}}

`;

const VERSION_LABELS = { original: '原文', translation: '译文', rewrite: '改写' };
const FALLBACK_READING = { ...READING_DEFAULTS };

/**
 * 「正在重新生成」进度条。
 *
 * ★ 为什么必须有它
 * ----------------
 * 「更多操作 → 重新生成译文」走 `generate(kind, true)`，它确实把 `generating` 置上了，
 * 但正文区**唯一的进度提示活在 `npr-missing` 那个分支里**，而那个分支只在 `bodyHtml`
 * 为空（版本缺失）时才渲染。于是**手动重新生成一篇已经存在的译文时，整个生成期间
 * 界面一动不动**：旧译文照旧显示，没有任何「正在进行」的迹象。
 *
 * 真机代价（2026-10-12）：一篇 21k 字符的译文要跑约 4 分钟（点下去 17:25 → 写盘 17:29）。
 * 用户盯着一个毫无变化的界面，结论只能是「点了没用 / 还是老样子」——
 * 修复本身是好的，却因为**没有反馈**被判成没生效。
 *
 * 所以把它做成一条独立状态条，与 `npr-missing` 那条**互斥**：
 * 有正文（旧版本）时走这条，没正文时走那条，不会出现两条同时挂着。
 * 这条互斥规则写进组件本身（`hasBody`），而不是留在 JSX 的条件里 ——
 * 否则它就落在真渲染断言够不到的地方。
 *
 * @param {{kind?: 'original'|'translation'|'rewrite', hasBody?: boolean}} props
 *   `kind` 传 `selected.generating`；`hasBody` 传正文区当前有没有内容可显示。
 */
export function RegeneratingNotice({ kind, hasBody = false }) {
  if (!kind || !hasBody) return null;
  return (
    <div className="npr-translating" role="status">
      <Icon name="refresh-cw" size={14} />
      <span>正在重新生成{VERSION_LABELS[kind]}…生成期间显示的是当前版本，完成后会自动切过去（通常要几分钟）</span>
    </div>
  );
}

/**
 * 「这次只翻了一部分」的文案（2026-10-25）。
 *
 * ★ 为什么必须有它
 * ----------------
 * 保结构翻译是**逐段编号回填**的：模型漏掉的那几段，`applyTranslations` 会
 * **保留英文原文**（这是对的安全底线 —— 宁可没翻，也不能把译文塞错位置）。
 * 于是用户看到的是一篇**中英混排**的文章。
 *
 * 而宿主其实**算出来了**「这次翻了多少段」（`coverage`），一路传到客户端 ——
 * 然后没有任何地方显示它（2026-10-25 审查发现：`src/client` 里 `coverage` 零命中）。
 * 结果是：用户看到中英混排，只会得出「这翻译质量真差」，
 * **不会知道「其实只翻了 60%，再点一次可能就全了」**。
 *
 * ★ 判据
 * ------
 * - 只在**正在看译文**时说（在原文 / 改写视图里提这件事纯属干扰）；
 * - `coverage` 缺失（2026-10-14 之前的存量译文没有这个字段）⇒ 不说 ——
 *   没有数据就闭嘴，不要拿 0 去吓人；
 * - 全覆盖 ⇒ 不说（说「全部翻完了」是噪音，正文本身就是证据）。
 *
 * @param {{active?: string, coverage?: {total?: number, done?: number}}} [props]
 * @returns {string} 空串 = 不显示
 */
export function partialTranslationHint({ active, coverage } = {}) {
  if (active !== 'translation') return '';
  const total = Number(coverage?.total);
  const done = Number(coverage?.done);
  if (!Number.isFinite(total) || total <= 0) return '';
  if (!Number.isFinite(done) || done < 0) return '';
  if (done >= total) return '';
  const percent = Math.round((done / total) * 100);
  const missing = total - done;
  if (done === 0) {
    return `这次一段都没翻成功（共 ${total} 段），正文仍是原文 —— 点「重新生成译文」再试一次。`;
  }
  return `这次只翻了 ${percent}%（${done}/${total} 段）。模型漏掉的 ${missing} 段保留了原文 —— 点「重新生成译文」再试一次通常就补上了。`;
}

/**
 * 上面那条文案的渲染壳。
 *
 * ★ 抽成组件而不是写进 JSX 的条件里：条件写进 JSX 之后，「什么情况下不该出现」
 *   就只能靠读源码字符串下结论 —— 而字符串断言答不了「这段代码跑不跑得到」。
 *   抽出来之后它和 `RegeneratingNotice` 一样可以被**真渲染**（见
 *   `test/reader-status-notice.test.mjs`）。
 *
 * @param {{active?: string, coverage?: object}} props
 */
export function PartialTranslationNotice({ active, coverage } = {}) {
  const hint = partialTranslationHint({ active, coverage });
  if (hint === '') return null;
  return (
    <div className="npr-translation-partial" role="status">
      <Icon name="info" size={14} />
      <span>{hint}</span>
    </div>
  );
}

/**
 * 「更多操作」里「重新生成 X」那一条的文案。
 *
 * ★ 为什么文案也要跟着变
 * ----------------------
 * 这一条在生成期间是 `disabled` 的（`selected?.generating` 非空），但**光置灰不够**：
 * 用户重开菜单只会看到一个「不能点、又没说为什么」的条目。
 * 生成的是哪一版，必须写在文案里 —— 而且**要写 `generating` 那一版**，
 * 不能写当前正在看的 `active`：在「原文」视图里重新生成「译文」时，两者不是同一版。
 *
 * @param {{active?: string, generating?: string}} props
 */
export function regenerateMenuLabel({ active, generating }) {
  if (generating) return `正在重新生成${VERSION_LABELS[generating]}…`;
  return `重新生成${VERSION_LABELS[active]}`;
}

/**
 * 「更多操作」里「抓取原文全文」/「重新加载文章」两条的文案。
 *
 * ★ 为什么光置灰不够（与 `regenerateMenuLabel` 同一条理由）
 * --------------------------------------------------------
 * 这两条点下去**菜单立刻关掉**（所有菜单项都是这个行为，用户 2026-10-13 明确选了
 * 「与『重新生成译文』一致」）。于是操作期间重开菜单的人只会看到一个
 * 「不能点、又没说为什么」的条目 —— 必须把「正在做什么」写进文案里。
 *
 * @param {string} label 平时显示的文案，如「抓取原文全文」
 * @param {boolean} busy 这条操作是否正在跑
 */
export function busyMenuLabel(label, busy) {
  return busy ? `正在${label}…` : label;
}

/**
 * 「更多操作」里那两条**只对原文有意义**的条目的可见性（2026-10-13 用户要求）。
 *
 * ★ 为什么抽成纯函数
 * ------------------
 * 写死在 JSX 条件里的话，「译文视图下这两条到底该不该出现」就只能靠读源码字符串
 * 下结论 —— 而字符串断言答不了「这段代码跑不跑得到」。抽出来之后它是**可执行**的：
 * 各种 `active` 取值可以直接喂进去，把策略钉死（与 `regenerateMenuLabel` 同一条路）。
 *
 * ★ 判据
 * ------
 * - 「抓取原文全文」补的是**原文正文**、「重新加载文章」重读的也是**原文那一份**
 *   ⇒ 只在「原文」版本下出现；
 * - 「重新生成 X」正相反，它只对译文 / 改写有意义 ⇒ 只在非原文时出现；
 * - **`undefined` / 未知取值一律算「非原文」** —— 宁可少一条，也不要在版本还没解析
 *   出来的时候冒出一条「点了不知道会发生什么」的条目。
 *
 * @param {{active?: string}} props 阅读区当前版本（`original` / `translation` / `rewrite`）
 */
export function menuItemVisibility({ active } = {}) {
  const original = active === 'original';
  return { fetchFullText: original, reloadArticle: original, regenerate: !original };
}

/**
 * 阅读区标题行显示什么。
 *
 * ★ 为什么不能一律用 `article.title`
 * --------------------------------
 * 译文 / 改写**自带一个中文标题**（`versions[kind].title`，由宿主从模型输出的
 * 第一行 `# …` 抽出来）。而正文里那个 H1 已经在生成时被 `withoutLeadingTitle`
 * 去掉了 —— 标题行不认这个字段的话，中文标题就整个丢了，用户看到的标题
 * 永远是英文原标题（实测用户截图就是这样）。
 *
 * 原文视图没有版本标题，仍旧用文章自己的（`titleZh` 优先，订阅源可能自带）。
 *
 * @param {{active?: string, versions?: object, article?: object}} props
 */
export function readerTitle({ active, versions, article }) {
  if (active !== undefined && active !== 'original') {
    const title = versions?.[active]?.title;
    if (typeof title === 'string' && title.trim() !== '') return title.trim();
  }
  return article?.titleZh ?? article?.title ?? '';
}

/**
 * 正文 HTML —— **返回的已经是可以直接塞进 DOM 的成品**（渲染侧不再 sanitize）。
 *
 * ★ 为什么 sanitize 在这里而不是渲染处
 * ------------------------------------
 * `sanitizeHtml` 对**已转义的 `&` 会再转一层**（实测 `&amp;quot;` →
 * `&amp;amp;quot;` → `&amp;amp;amp;quot;`，不幂等）。保结构译文在**生成时**已经
 * sanitize 过，渲染时若再来一次，译文就会比原文多出可见的 `&amp;` 字面量。
 *
 * ⇒ 三条分支各自只 sanitize 一次：
 *     原文    `sanitizeHtml(article.html)`
 *     新译文  **直接用**（生成时已 sanitize，结构与原文完全相同）
 *     旧译文  `sanitizeHtml(markdownToHtml(旧 markdown))`
 *
 * ★ 抽成纯函数是为了能被**真跑**：它有三个分支，而「分支走错」在界面上只表现为
 *   「排版有点怪」，靠肉眼看不出来（见 `test/reader-body-render.test.mjs`）。
 *
 * @param {{active?: string, articleHtml?: string, version?: object, baseUrl?: string}} props
 */
export function readerBodyHtml({ active, articleHtml, version, baseUrl } = {}) {
  if (active === undefined || active === 'original') return sanitizeHtml(articleHtml ?? '', { baseUrl });
  // 保结构译文**本身就是 HTML**：结构与原文完全相同，只有文字换成了中文。
  if (version?.html) return version.html;
  // 没有 `html` 的是 2026-10-14 之前生成的旧译文，回退到 Markdown 渲染 ——
  // 存量译文因此不必重新生成也照常能看。
  const markdown = version?.markdown;
  return markdown ? sanitizeHtml(markdownToHtml(markdown), { baseUrl }) : '';
}

/**
 * 「更多操作」下拉：点菜单外面就关掉。
 *
 * ★ 为什么抽成独立函数，而不是把逻辑写在 useEffect 里
 * ----------------------------------------------------
 * 这里有两个**一写错就静默失效**的细节，必须能被断言钉住：
 *
 *   ① **触发器本身要排除**。⋯ 按钮的 onClick 是 `setMenuOpen(open => !open)`。
 *      如果 pointerdown 先把菜单关掉、紧接着 onClick 又把它翻回来，菜单就**永远关不掉** ——
 *      用户看到的是「点了 ⋯ 没反应」，而且不报错。
 *
 *   ② **菜单本身要排除**。用 pointerdown 关闭时，若把菜单也算作「外面」，
 *      菜单会在 **pointerdown 阶段**就卸载，随后的 click 落在已经消失的按钮上 ⇒
 *      **点任何一条菜单项都什么都不做**（比「关不掉」更严重）。
 *
 * 所以判据独立成这个函数，用真 DOM 桩真跑断言（`test/reader-menu-dismiss.test.mjs`）——
 * 这两个坑都靠「源码里写了 `contains`」这种字符串断言看不出来。
 *
 * ★ 监听器挂在 `document` 上且用**捕获阶段**：宿主 UI 里任何一处 `stopPropagation`
 *   都不该让我们自己的菜单关不掉。
 *
 * @param {EventTarget} doc 真实调用时是 `document`
 * @param {{menu?: Node|null, trigger?: Node|null, close: () => void}} options
 * @returns {() => void} 卸载函数。★ 移除时的捕获标志**必须与添加时一致**，
 *   否则监听器会留在 document 上（菜单每开一次多一个，且旧的还指向过期的 ref）。
 */
export function attachMenuDismiss(doc, { menu, trigger, close }) {
  const onPointerDown = (event) => {
    const target = event?.target;
    if (!target) return;
    if (menu?.contains?.(target)) return;
    if (trigger?.contains?.(target)) return;
    close();
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  return () => doc.removeEventListener('pointerdown', onPointerDown, true);
}

let stylesReady = false;
function ensureStyles() {
  if (stylesReady) return;
  stylesReady = true;
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-npie-reader';
  style.textContent = PANEL_CSS + REFINEMENTS;
  document.head.appendChild(style);
}

/** Sidebar entry icon; receives {size, active} from the host sidebar. */
export function ReaderIcon({ size = 18, active = false }) {
  return (
    <span style={{ color: active ? 'var(--npc-brand, var(--dsw-alias-brand-primary))' : 'inherit', display: 'inline-flex', alignItems: 'center' }}>
      <Icon name="rss" size={size} strokeWidth={1.8} />
    </span>
  );
}

export function ReaderPage({ api, SessionProvider, renderSlot }) {
  /**
   * 视图模式：`feeds`（订阅）或 `library`（书架）。
   *
   * 记在 localStorage 里：用户切到书架往往就是「接下来一段时间都读书」，
   * 每次重开面板都掉回订阅会很难受。书架被设置关掉时强制回 `feeds`。
   */
  const [mode, setMode] = useState(() => (localStorage.getItem('npr.mode') === 'library' ? 'library' : 'feeds'));
  const [channels, setChannels] = useState([]);
  const [channel, setChannel] = useState(() => localStorage.getItem('npr.channel') || 'feeds:all');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState({ entries: [], hasMore: false, nextCursor: undefined });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState(undefined);
  const [toast, setToast] = useState(undefined);
  const [dialog, setDialog] = useState(undefined);
  const [settingsEntry, setSettingsEntry] = useState({ tab: 'reading', addPrompt: false });
  /**
   * 被用户点掉过的「源已陈旧」提示，存的是**签名**（标题 + 源名单）而不是布尔。
   *
   * 存签名的理由：用户关掉的是**这一批**源，不是这个功能本身。以后又有源陈旧了
   * （名单变了 ⇒ 签名变了），提示应该重新出现 —— 存布尔会让这个功能静默失效。
   */
  const [dismissedNotice, setDismissedNotice] = useState(() => localStorage.getItem('npr.staleNotice') || '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState(null);
  // 侧栏「+」的下拉：把「添加自己的订阅源」提到一级入口。以前它只藏在探索页的搜索框里
  // （要先粘一个目录外的地址才会冒出来），用户根本不知道有这个能力。
  const [addMenu, setAddMenu] = useState(null);
  const [showAddFeed, setShowAddFeed] = useState(false);
  useEffect(() => { if (dialog) { setPickerOpen(false); setAddMenu(null); } }, [dialog]);
  const openPicker = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(480, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 580));
    setPickerAnchor({ left, top });
    setPickerOpen(true);
  };
  const openAddMenu = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 236;
    // 下边界按**实际高度**收：菜单多了「选择频道」一条，原来那个 210 会让它从窗口底部
    // 探出去一截（4 × 约 54px + 上下内边距）。多留一点余量，别再按条目数心算。
    setAddMenu({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 248)),
    });
  };
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reading, setReading] = useState(FALLBACK_READING);
  /**
   * 「这次实际会用哪个模型」—— 阅读区那两处写着模型名的字样用（自动翻译的状态条、
   * 缺内容时的「生成」按钮）。
   *
   * ★ 为什么必须问宿主，而不是本地读设置里那个 `aiModel`：
   *   设置**留空**时用的是 Harness 默认模型，它的名字只在宿主那边（`agentDefaultModel`）。
   *   而设置**非空**时，真正要显示的是设置里那个模型 —— 无脑写「Harness 默认模型」
   *   在用户把翻译压到便宜模型上之后会**一直说错**，且说的是确定的话。
   *   ⇒ 取值与判据都在共用模块 `../ai-model.js` 里，与生成路径同源。
   *
   * 只读、不发网络请求（与设置页那个会遍历 provider 的 `listAiModels` 不是一回事）。
   * 读不到就保持 `null` ⇒ 文案退回**不含模型名**的说法，绝不编一个名字出来。
   */
  const [modelInfo, setModelInfo] = useState(null);
  const [listWidth, setListWidth] = useState(() => Number(localStorage.getItem('npr.listWidth')) || 300);
  const [askContext, setAskContext] = useState(null);
  const activeChannelRef = useRef(channel);
  activeChannelRef.current = channel;
  /**
   * `reading` 的镜像。
   *
   * ★ 必须走 ref：下面「恢复上次阅读位置」那个 effect 的依赖是 `[]`，它拿到的是
   *   **首渲染**的 `openArticle` 闭包，里面的 `reading` 还是 `FALLBACK_READING`。
   *   自动翻译的开关正是从 `reading` 上读的 —— 直接读 state 的话，用户开着
   *   「英文原文自动翻译」重启应用、恢复到上次那篇英文文章时，翻译**不会触发**，
   *   而且没有任何报错（开关看着是开的）。
   */
  const readingRef = useRef(reading);
  readingRef.current = reading;
  const automaticRefresh = useRef(new Map());
  /** `refreshing` 的镜像：定时器闭包里读 state 会拿到过期值，防重入必须走 ref。 */
  const refreshingRef = useRef(false);
  /**
   * 「更多操作」里「抓取原文全文」与「重新加载文章」的忙碌态（2026-10-13 用户报）。
   *
   * ★ 为什么要它
   * ------------
   * 「抓取原文全文」要真去原文页抓（几秒到十几秒），「重新加载文章」要重读一遍。
   * 以前这两条点下去**没有任何反馈**：菜单立刻关掉、界面一动不动，用户只能重开菜单
   * 再点一次 —— 于是同一篇被同时抓两次。现在照「重新生成译文」那一条的做法：
   * **操作期间这条 `disabled`**、文案改成「正在…」，重开菜单一眼能看出它还在跑。
   *
   * ★ 两条**各自独立**（用户明确要求）：一条在跑不影响另一条 —— 它们不是同一件事，
   *   一条要联网去原文页，一条只重读本地已有的正文。
   *
   * ★ 为什么还要一对 ref 镜像
   * -------------------------
   * `disabled` 只能挡住「重开菜单之后再点」。菜单点一下就关，而**同一次快速双击**的
   * 第二下可能落在 DOM 还没更新的那一帧上 ⇒ 光靠 state 挡不住。ref 在同一 tick 里
   * 就生效 —— 与上面 `refreshingRef` 是同一个理由。
   */
  const [fetchingFullText, setFetchingFullText] = useState(false);
  const [reloadingArticle, setReloadingArticle] = useState(false);
  const fetchingFullTextRef = useRef(false);
  const reloadingArticleRef = useRef(false);
  const [passage, setPassage] = useState(null);
  const selectionSerial = useRef(0);
  const proseRef = useRef();
  const rootRef = useRef();
  const workareaRef = useRef();
  const companionDrag = useRef(false);
  const [companionWidth, setCompanionWidth] = useState(() => { const saved = Number(localStorage.getItem('npr.companionWidth')); return Number.isFinite(saved) && saved >= 25 && saved <= 75 ? saved : 44; });
  const companionWidthRef = useRef(companionWidth);
  useEffect(() => { const root = rootRef.current; if (!root) return; const update = () => { const r = root.getBoundingClientRect(); root.dataset.titlebar = String(window.location.protocol === 'dsh-app:' && /Mac/.test(navigator.platform) && r.left < 110 && r.top < 45); }; update(); if (!globalThis.ResizeObserver) return; const observer = new ResizeObserver(update); observer.observe(root); return () => observer.disconnect(); }, []);
  // ★ 这里曾经在每次选中时写 `npr.view.<频道>`（`{key, active}`），供「打开面板回到上次
  //   那篇」读回来。那条恢复 2026-10-26 删了（理由见下面 `openArticle` 之后那段注释），
  //   写也就一起删 —— 只写不读的持久化会让人以为还有人在用，下次又照着它加回去。
  //   老用户 localStorage 里那几条记录**不动**：没人读，留着无害，专门去清理反而多一次写盘。

  useEffect(() => { setPassage(null); }, [selected?.article?.key]);
  useEffect(() => {
    const highlights = globalThis.CSS?.highlights;
    const HighlightType = globalThis.Highlight;
    if (!highlights || !HighlightType) return;
    const range = passage && proseRef.current ? quoteRange(proseRef.current, passage) : null;
    if (range) highlights.set('npr-reading-selection', new HighlightType(range));
    else highlights.delete('npr-reading-selection');
    return () => highlights.delete('npr-reading-selection');
  }, [passage, selected?.article?.key, selected?.active]);

  const toastTimer = useRef();
  const pageRequest = useRef(0);
  const articleRequest = useRef(0);
  const searchInput = useRef();
  /** 「更多操作」菜单本身 —— 判断这次 pointerdown 算不算「点在外面」。 */
  const menuRef = useRef();
  /** ⋯ 那个按钮 —— **必须**和菜单一起排除，否则菜单永远关不掉（见 `attachMenuDismiss`）。 */
  const menuButtonRef = useRef();

  /**
   * 点菜单外面就把它关掉。判据与两个坑都在 `attachMenuDismiss` 的注释里。
   * 只在菜单开着时挂监听 —— 关着的时候不该在 document 上留东西。
   */
  useEffect(() => {
    if (!menuOpen) return undefined;
    return attachMenuDismiss(document, {
      menu: menuRef.current,
      trigger: menuButtonRef.current,
      close: () => setMenuOpen(false),
    });
  }, [menuOpen]);

  const notify = (message, isError = false) => {
    setToast({ message, isError });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), isError ? 4200 : 2400);
  };

  const run = async (promise, { errorPrefix = '操作失败' } = {}) => {
    try { return await promise; } catch (error) {
      notify(`${errorPrefix}：${error?.message ?? String(error)}`, true);
      return undefined;
    }
  };

  const applyReading = async (patch) => {
    const next = { ...reading, ...patch };
    setReading(next);
    await run(api.saveSettings(patch), { errorPrefix: '保存阅读设置失败' });
  };

  useEffect(() => {
    const readReading = () => { void api.getSettings()
      .then((result) => setReading({ ...FALLBACK_READING, ...result.settings }))
      .catch(() => {}); };
    /**
     * ★ 模型名必须跟设置**一起**重读：用户在设置里换了翻译模型之后，阅读区那两处
     *   字样要当场改口。只重读 `reading` 的话，界面会继续显示**上一个**模型 ——
     *   而那是确定的话，用户没有理由怀疑它已经过期。
     */
    const readModelInfo = () => { void api.aiModelInfo()
      .then((result) => setModelInfo(result ?? null))
      .catch(() => setModelInfo(null)); };
    readReading();
    readModelInfo();
    const reload = () => { readReading(); readModelInfo(); };
    window.addEventListener('npr-settings-changed', reload);
    return () => window.removeEventListener('npr-settings-changed', reload);
  }, [api]);

  /** 那两处字样要显示的模型名；拿不到具体模型时是不含模型名的兜底说法。 */
  const modelLabel = effectiveModelLabel(modelInfo);

  const loadChannels = async () => {
    const data = await run(api.listChannels(), { errorPrefix: '读取频道失败' });
    if (data) setChannels(data.channels);
    return data?.channels ?? [];
  };

  const loadPage = async (cursor, replace = true) => {
    const request = ++pageRequest.current;
    if (replace) setLoading(true); else setLoadingMore(true);
    setPageError('');
    try {
      const data = await api.listEntries({ channel, filter, search: query || undefined, cursor });
      if (request !== pageRequest.current) return;
      if (!data || !Array.isArray(data.entries)) throw new Error('阅读服务返回了无效的文章列表');
      setPage((previous) => (replace ? data : {
        entries: [...previous.entries, ...data.entries.filter((entry) => !previous.entries.some((seen) => seen.key === entry.key))],
        hasMore: data.hasMore,
        nextCursor: data.nextCursor,
      }));
    } catch (error) {
      if (request === pageRequest.current) setPageError(error?.message ?? String(error));
    } finally {
      if (request === pageRequest.current) { setLoading(false); setLoadingMore(false); }
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      ensureStyles();
      const loaded = await loadChannels();
      if (cancelled) return;
      if (!loaded.some((item) => item.total > 0)) {
        setRefreshing(true);
        await run(api.refresh(undefined), { errorPrefix: '首次刷新失败' });
        setRefreshing(false);
        await loadChannels();
        if (!cancelled) await loadPage(undefined, true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('npr.channel', channel);
    setPage({ entries: [], hasMore: false, nextCursor: undefined });
    void loadPage(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, filter, query]);

  // 宿主频道清单变了以后，当前频道可能已经不存在：订阅被退订了，或者 localStorage 里
  // 存着上一版的频道 id。此时不回落，界面会永久停在「一篇文章都不显示」上，
  // 而且用户看不出为什么 —— 这就是「打开侧边栏一篇文章都不显示」的一个成因。
  useEffect(() => {
    const fallback = resolveChannel(channel, channels);
    if (fallback) setChannel(fallback);
  }, [channels, channel]);

  useEffect(() => {
    const entry = channels.find((item) => item.key === channel);
    if (!entry || (entry.total > 0 && (channel === 'all' || channel === 'feeds:all'))) return;
    const last = automaticRefresh.current.get(channel) ?? 0;
    if (Date.now() - last < (entry.total > 0 ? 15 * 60_000 : 60_000)) return;
    automaticRefresh.current.set(channel, Date.now());
    let cancelled = false;
    setRefreshing(true);
    void api.refresh(channel).then((outcome) => {
      if (cancelled || activeChannelRef.current !== channel) return;
      return Promise.all([loadChannels(), loadPage(undefined, true)]).then(() => {
        if (outcome?.error) setPageError(outcome.error);
      });
    }).catch((error) => {
      if (!cancelled && activeChannelRef.current === channel) setPageError(error?.message ?? String(error));
    }).finally(() => setRefreshing(false));
    return () => { cancelled = true; };
    // Show cached articles immediately, then refresh a scoped channel in the background.
  }, [channel, channels]);

  /**
   * 英文原文自动翻译成中文。
   *
   * 用户要的是「**原文直接**变成中文」，而不是在 AI 伴读框里打一句 prompt 让它翻 ——
   * 后者每次都要人来问，而且译文只活在对话里，不进阅读区、不能被选中、不能打印。
   *
   * 触发判据全在 `shouldAutoTranslate`（`./reading-version.js`）：设置开着 +
   * 宿主判定的语种是 en + 这篇还没有中文版本 + 原文确实有正文。四缺一就不动。
   */
  const autoTranslate = async (key, request) => {
    setSelected((current) => (current?.article?.key === key ? { ...current, translating: true } : current));
    const version = await run(api.generateVersion(key, 'translation'), { errorPrefix: '自动翻译失败' });
    // 生成期间用户可能已经翻到别的文章了；那样就别把结果贴回当前这篇。
    if (request !== undefined && request !== articleRequest.current) return;
    setSelected((current) => {
      if (current?.article?.key !== key) return current;
      if (!version) return { ...current, translating: false };
      return {
        ...current,
        translating: false,
        // 直接把阅读区切到译文 —— 用户要的就是「打开就是中文」。
        active: 'translation',
        versions: { ...current.versions, translation: { ...version, available: true } },
      };
    });
    if (version) notify('原文是英文，已自动生成中文版本');
  };

  const openArticle = async (key, restoreVersion) => {
    const request = ++articleRequest.current;
    setSelected({ loading: true, key });
    setPassage(null);
    const root = rootRef.current;
    if (root && root.clientWidth > 0 && root.clientWidth < 460) setFocused(true);
    const data = await run(api.getArticle(key), { errorPrefix: '读取正文失败' });
    if (request !== articleRequest.current) return;
    if (!data) { setSelected({ error: true, key }); return; }
    setSelected({ ...data, article: { ...data.article, read: true }, active: resolveReadingVersion(restoreVersion || reading.defaultVersion, data) });
    rootRef.current?.querySelector('.npr-reader')?.scrollTo?.({ top: 0 });
    if (shouldAutoTranslate(readingRef.current, data)) void autoTranslate(key, request);
    if (data.article?.read === false) {
      void api.setRead([key], true).catch(e => notify(e.message, true));
      setPage((previous) => ({ ...previous, entries: previous.entries.map((entry) => (entry.key === key ? { ...entry, read: true } : entry)) }));
    }
  };

  /** 强制去原文页抓全文：订阅源只给摘要时的手动补全入口。 */
  const fetchFullText = async (key) => {
    if (fetchingFullTextRef.current) return;
    fetchingFullTextRef.current = true;
    setFetchingFullText(true);
    try {
      const result = await run(api.fetchFullText(key), { errorPrefix: '抓取原文全文失败' });
      if (!result) return;
      notify(`已抓取原文全文（${result.chars} 字）`);
      await openArticle(key, active);
    } finally {
      fetchingFullTextRef.current = false;
      setFetchingFullText(false);
    }
  };

  /**
   * 菜单里「重新加载文章」：重读当前这篇，带忙碌态。
   *
   * ★ 必须把**当前版本**一起传下去（`openArticle(key, active)`）。以前这里传的是
   *   `undefined`，`resolveReadingVersion` 于是退回 `reading.defaultVersion` ——
   *   在「原文」视图里点「重新加载文章」，只要设置里的默认版本是译文，**视图会跳走**。
   *   这一条现在只出现在原文视图，跳走就更说不通了。
   */
  const reloadArticle = async (key) => {
    if (reloadingArticleRef.current) return;
    reloadingArticleRef.current = true;
    setReloadingArticle(true);
    try {
      await openArticle(key, active);
    } finally {
      reloadingArticleRef.current = false;
      setReloadingArticle(false);
    }
  };

  /**
   * 这里**曾经**有一条「面板打开时回到上次那篇」（`npr.view.<频道>`），2026-10-26 删掉。
   *
   * 用户连着报两次：① 从「书」切回来落在上一篇；② 从侧边栏点「阅读器」进来直接打开了
   * 第一条 RSS。第二个才是原话里的「每次进来」，而它跟切模式无关 —— 是这一条恢复。
   *
   * 删掉的理由不止「用户不想要」：面板一打开就 `openArticle`，而 `openArticle` 里挂着
   * 「英文自动生成中文版本」。于是**打开一个面板 = 替你花一次模型调用**，而那时用户
   * 连列表都还没看。想继续读，点一下那一行就行 —— 那一下是用户做的决定。
   *
   * ★ 不要把它加回来当「贴心功能」：这条恢复和「自动翻译」是一个按钮的两面。
   *   `test/reader-mode-switch.test.mjs` 里有一条结构性判据守着「effect 里不许自动
   *   打开文章」，加回来会直接判红。
   */

  const refresh = async (target) => {
    // 防重入：定时器与手动点按可能撞在一起。两路刷新并发会把「订阅源 N 个」
    // 这类提示叠成好几条，也会让同一个源被同时抓两次。
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const outcome = await run(api.refresh(target), { errorPrefix: '刷新失败' });
    setRefreshing(false);
    refreshingRef.current = false;
    if (outcome) {
      const bits = [];
      // ★ 界面这里也要分开报。以前只显示「订阅源 3 个，新增 0 篇」——三个源全挂了
      //   和三个源都正常但确实没新内容，用户看到的是同一句话。失败必须显式出现。
      if (outcome.feeds !== undefined) {
        bits.push(outcome.failed
          ? `订阅源 ${outcome.ok} 个成功、${outcome.failed} 个失败`
          : `订阅源 ${outcome.feeds} 个`);
      }
      if (outcome.entries !== undefined) bits.push(`新增 ${outcome.entries} 篇`);
      if (outcome.failures?.length) bits.push(`首个失败：${outcome.failures[0].name}`);
      notify(bits.length > 0 ? `已刷新：${bits.join('，')}` : '已刷新');
    }
    await Promise.all([loadChannels(), loadPage(undefined, true)]);
  };

  // 定时自动刷新：面板开着时每 15 分钟拉一次，窗口重新获得焦点时也拉一次。
  // 在此之前只有四个触发点（首开 / 切频道 / 手点 / 加订阅），用户不动它就永远不更新。
  // `refresh` 每次渲染都是新函数，所以走 ref 取最新的一份，别把 effect 挂到它上面。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const AUTO_REFRESH_MS = 15 * 60_000;
    const tick = () => {
      if (document.hidden) return;          // 后台标签页不刷，省流量也省源站配额
      void refreshRef.current(activeChannelRef.current);
    };
    const timer = setInterval(tick, AUTO_REFRESH_MS);
    window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
  }, []);

  const toggleFavorite = async (key, favorite) => {
    const result = await run(api.setFavorite(key, !favorite), { errorPrefix: '收藏失败' }); if (!result) return;
    setPage((previous) => ({ ...previous, entries: previous.entries.map((entry) => (entry.key === key ? { ...entry, favorite: !favorite } : entry)) }));
    if (selected?.article?.key === key) setSelected((current) => ({ ...current, article: { ...current.article, favorite: !favorite } }));
  };

  const setRead = async (key, read) => {
    const result = await run(api.setRead([key], read), { errorPrefix: '标记失败' }); if (!result) return;
    setPage((previous) => ({ ...previous, entries: previous.entries.map((entry) => (entry.key === key ? { ...entry, read } : entry)) }));
    if (selected?.article?.key === key) setSelected((current) => ({ ...current, article: { ...current.article, read } }));
  };

  /**
   * 生成一个中文版本；`force` = 丢掉缓存重新生成。
   *
   * ★ 「重新生成」必须走菜单，不能靠正文区那个按钮：它只在版本**缺失**
   *   （`bodyHtml` 为空）时渲染，译文一旦生成过就再也不出现。于是改进了正文结构或
   *   插图判据之后，存量文章永远看不到效果 —— 只能去手改数据文件。
   */
  const generate = async (kind, force = false) => {
    const key = selected?.article?.key;
    if (!key) return;
    setSelected((current) => ({ ...current, generating: kind }));
    const version = await run(api.generateVersion(key, kind, force), { errorPrefix: force ? '重新生成失败' : '生成失败' });
    setSelected((current) => {
      if (current?.article?.key !== key) return current;
      return { ...current, generating: undefined, ...(version ? {
        active: kind, versions: { ...current.versions, [kind]: { ...version, available: true } },
      } : {}) };
    });
    if (version) notify(force ? `已重新生成${VERSION_LABELS[kind]}` : '已载入 Harness 生成版本');
  };

  const navigate = (direction) => {
    const index = page.entries.findIndex((entry) => entry.key === selected?.article?.key);
    const target = page.entries[index < 0 ? 0 : index + direction];
    if (target) void openArticle(target.key);
  };

  const startDrag = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    let width = listWidth;
    const move = (moveEvent) => {
      width = Math.round(Math.min(Math.max(startX === 0 ? 300 : (listWidth + moveEvent.clientX - startX), 220), 520));
      setListWidth(width);
    };
    const up = () => {
      localStorage.setItem('npr.listWidth', String(width));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    // 书架模式下这些快捷键不该生效：j/k 在那边是翻页而不是「上/下一篇文章」，
    // 让它们同时响应两套语义，用户会看到列表在他看不见的地方被选中。
    if (mode === 'library') return undefined;
    const onKey = (event) => {
      if (dialog || pickerOpen || askContext || appearanceOpen || menuOpen || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (event.key === 'j' || event.key === 'k') { event.preventDefault(); navigate(event.key === 'j' ? 1 : -1); }
      else if (event.key === '[' || event.key === 'f') { event.preventDefault(); setFocused((current) => !current); }
      else if (event.key === '/') { event.preventDefault(); setSearchOpen(true); setTimeout(() => searchInput.current?.focus(), 0); }
      else if (event.key === 'Escape') { setFocused(false); setSearchOpen(false); setQuery(''); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog, pickerOpen, askContext, appearanceOpen, menuOpen, page.entries, selected?.article?.key, mode]);

  // 模式落盘 + 书架被设置关掉时强制回订阅。
  // ★ 关掉书架必须**同时**把用户从书架里请出去：只把入口按钮藏掉的话，
  //   上一次停在书架的会话重开后会落在一个再也切不回去的视图里。
  useEffect(() => {
    if (reading.bookshelf === false && mode === 'library') { setMode('feeds'); return; }
    localStorage.setItem('npr.mode', mode);
  }, [mode, reading.bookshelf]);

  /**
   * 进书架页就把「专注阅读」关掉。
   *
   * ★ 0.20.1 的真机症状（用户 2026-10-23 报）：从宿主侧栏打开阅读器、点侧栏的「阅读」，
   *   书架**左侧那份书单不见了**，只剩中间那块欢迎页；同一个面板换一次视图又正常。
   *
   * ★ 根因是一条「状态跨模式泄漏」，不是布局算错：
   *   ① 面板打开时 `mode` 从 localStorage 恢复成 `library`；
   *   ② 同一时刻还有一处「自动打开上次那篇文章」（见下面 `npr.view.*` 的恢复）；
   *   ③ 而 `openArticle` 里有一条「面板宽度 < 460 就自动进专注模式」—— 面板刚挂载
   *      那一帧宽度还没铺开，于是 `focused` 变成 true；
   *   ④ `focused` 只体现在 `.npr-root` 的类名上，**不区分当前是哪一页**，而
   *      `.npr-root.npr-focus .npr-sidebar{display:none}` 会把书架自己的书单也一起藏掉。
   *   ⇒ 书架页里没有任何「显示列表」的按钮（那条只在订阅页的阅读区工具栏上），
   *     用户看到的就是「列表栏没了」，而且找不到入口把它叫回来。
   *
   * ★ 两道闸都要有，缺一条都还会漏：
   *   ① 类名按 `mode === 'feeds'` 才算（见 render 里那行）—— 这一道保证「画不出来」；
   *   ② 这里把状态本身复位 —— 否则回到订阅页时会突然一次「专注」，用户会以为点了什么。
   *
   * ★ 同一处还要**取消选中**（2026-10-26 用户报）：读到一半切去书架、再切回来，
   *   阅读区会直接落在上一篇文章上；那篇是英文时会连带把译文也摆出来 ——
   *   用户的原话是「这不是我想的」。切模式回来应当是**初始态**：
   *   右侧是「订阅你关注的作者」那张欢迎页，列表里没有任何一行被选中。
   *
   *   `selected` 挂在 ReaderPage 上（不是订阅页那棵子树），所以切走再回来它**还在** ——
   *   这才是「自动选中第一条」的真身；恢复上次阅读只发生在面板挂载，与此无关。
   *
   *   下面的模式守卫用「先复位专注、不是书架就返回」的写法，是为了让复位专注那一行
   *   保持独立可读（`test/reader-focus-scope.test.mjs` 逐字守着它）。
   */
  useEffect(() => {
    if (mode === 'library') setFocused(false);
    if (mode !== 'library') return;
    // 还在路上的正文请求要作废：它回来时会把刚清掉的 selected 又填上。
    articleRequest.current += 1;
    setSelected(undefined);
    setPassage(null);
    // 伴读是绑在「某一篇文章」上的；选中都没了，它挂在空白的阅读区上只会显示旧上下文。
    setAskContext(null);
  }, [mode]);

  const activeArticle = selected && !selected.loading ? selected : undefined;
  const versions = activeArticle?.versions;
  const active = activeArticle?.active ?? 'original';
  /** 「更多操作」里三条与版本相关的条目的可见性。策略在 `menuItemVisibility` 里（可测）。 */
  const menuItems = menuItemVisibility({ active });
  const audioUrl = articleAudioUrl(activeArticle?.article);
  const currentChannel = channels.find((item) => item.key === channel);
  // 正文 HTML 的决策在 `readerBodyHtml` 里（纯函数，可被真跑）：
  // 原文 → sanitize(article.html)；新译文 → 直接用生成时 sanitize 过的 HTML；
  // 旧译文 → sanitize(markdownToHtml(markdown))。
  const bodyHtml = useMemo(() => (activeArticle
    ? readerBodyHtml({
      active,
      articleHtml: activeArticle.html,
      version: versions?.[active],
      baseUrl: activeArticle.article?.url,
    })
    : ''), [activeArticle, active, versions]);
  // 标题行：译文 / 改写用它们自己的中文标题（正文里的 H1 已在生成时被去掉）。
  const title = readerTitle({ active, versions, article: activeArticle?.article });
  useEffect(() => { if (askContext && activeArticle?.article) setAskContext(previous => ({ ...previous, key: activeArticle.article.key, title: activeArticle.article.titleZh || activeArticle.article.title, version: active, selection: previous.key === activeArticle.article.key && previous.version === active ? previous.selection : '', quoteId: previous.key === activeArticle.article.key && previous.version === active ? previous.quoteId : undefined })); }, [activeArticle?.article?.key, active]);
  const openCompanion = (quote = '') => { if (!activeArticle) return; setFocused(false); setAskContext({ key: activeArticle.article.key, title: activeArticle.article.titleZh || activeArticle.article.title, version: active, selection: quote, quoteId: quote ? ++selectionSerial.current : undefined }); };
  const selectChannel = (key) => { if (key === channel) return; articleRequest.current++; setAskContext(null); setFocused(false); setSelected(undefined); setPassage(null); setFilter('all'); setQuery(''); setChannel(key); };
  /**
   * 订阅成功之后的落点。以前这里只重读频道清单、视图一动不动，于是「订阅了却看不到
   * 新源」与「停在一个源上，另一个源怎么都不出现」两件事同时成立。
   * 现在：停在聚合频道上就不动视图（新源的文章本来就会进列表）；停在具体源或分组上就
   * 切回「我的订阅」，让新旧订阅的内容同时可见。
   */
  const onSubscriptionAdded = async (added) => {
    await loadChannels();
    const label = added?.name ? `「${added.name}」` : '';
    const next = channelAfterAdd(channel);
    if (next) {
      selectChannel(next);
      notify(`已订阅${label}，已切回「我的订阅」`);
      return;
    }
    // 视图不动，但列表必须重读一遍：新源的文章在 addSubscription 时就已经抓回来了，
    // 不重读就还是「订阅成功了却看不见文章」。
    await loadPage(undefined, true);
    notify(`已订阅${label}`);
  };
  const captureSelection = () => { const found = selectedPassage(proseRef.current); if (found?.quote === passage?.quote) return; setPassage(found); if (found) openCompanion(found.quote); };
  const theme = reading.readingTheme && reading.readingTheme !== 'auto' ? reading.readingTheme : null;
  const feedCount = countFeeds(channels);
  const emptyFailure = channelFailure(channel, channels);
  const sourceNotice = staleNotice(channel, channels);
  // 用户点掉过**这一批**源就不再出现；源集合变了（key 变了）会重新提示。
  const showSourceNotice = sourceNotice !== null && sourceNotice.key !== dismissedNotice;
  const THEME_COLORS = { light: ['#ffffff', '#202124'], paper: ['#f5efdf', '#40382e'], sage: ['#e8eee3', '#29382c'], mist: ['#e7edf2', '#293741'], dark: ['#252525', '#dedede'], black: ['#090909', '#cccccc'] };

  return (
    // ★ 这里**绝不能**再写 tabIndex：宿主桌面端 base.css 有一条
    //   `html[data-platform=darwin] :is(…,[tabindex],…){-webkit-app-region:no-drag}`，
    //   而 Chromium 是把 no-drag 矩形从 drag 矩形里**做差**的（不是「取最内层」）。
    //   根节点一带 tabindex，整块面板就成了一个 no-drag 矩形，把两条工具栏的
    //   data-window-drag **整块减掉** ⇒ 拖动永久失效，而源码里标记一个不少（假绿）。
    //   键盘快捷键走 window 级监听（见下面的 onKey effect），不依赖焦点，去掉无副作用。
    <div ref={rootRef} className={`npr-root${focused && mode === 'feeds' ? ' npr-focus' : ''}`} data-images={String(reading.showImages !== false)} data-reading-theme={theme ?? 'auto'}
      style={{
        '--npr-list-width': `${listWidth}px`,
        '--npr-font-size': `${reading.fontSize}px`,
        '--npr-line-height': reading.lineHeight,
        '--npr-article-width': `${reading.fontSize * reading.textWidth + 120}px`,
        '--npr-font-family': fontStack(reading),
        ...(theme ? { '--npr-bg': THEME_COLORS[theme][0], '--npr-bg-2': THEME_COLORS[theme][0], '--npr-fg': THEME_COLORS[theme][1] } : {}),
      }}>
      {mode === 'library' ? (
        // 书架整块换掉工作区。它自带同构的 `.npr-workarea > .npr-layout` 骨架，
        // 所以布局 CSS 与窗口拖动区（`.npr-sidebar-toolbar[data-window-drag]`）
        // 两边完全共用，不需要在这里额外铺一套。
        <LibraryApp reading={reading} onExit={() => setMode('feeds')} notify={notify}
          api={api} SessionProvider={SessionProvider} renderSlot={renderSlot} />
      ) : (
      <div ref={workareaRef} style={{ '--npr-companion-width': `${companionWidth}%` }} className={`npr-workarea${askContext ? ' has-companion' : ''}`}><div className="npr-layout">
        <aside className="npr-sidebar">
          <div className="npr-sidebar-toolbar" data-window-drag>
            <ViewSwitch mode="feeds" onChange={setMode} showLibrary={reading.bookshelf !== false} />
            <button type="button" className="npr-channel" aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={openPicker}>
              <ChannelMark channel={currentChannel ?? { key: 'feeds:all', name: '我的订阅' }} size={26} />
              <span className="npr-channel-label">{currentChannel?.name ?? '我的订阅'}</span>
              <Icon name="chevron-down" size={13} />
            </button>
            <button type="button" className="npr-icon" title="添加订阅源" aria-label="添加订阅源" aria-haspopup="menu" aria-expanded={Boolean(addMenu)} onClick={openAddMenu}><Icon name="plus" /></button>
            <button type="button" className="npr-icon" title="搜索" aria-label="搜索" onClick={() => { setSearchOpen((open) => !open); setTimeout(() => searchInput.current?.focus(), 0); }}><Icon name="search" /></button>
            <button type="button" className={`npr-icon${refreshing ? ' is-loading' : ''}`} title="刷新" aria-label="刷新" onClick={() => void refresh(channel)}><Icon name="refresh-cw" /></button>
            {/* ★ 设置齿轮在工具栏**最右端**（2026-10-23 用户定，见 PANEL_CSS 里那条说明）。
                它从 0.20.1 之前的「筛选 chip 行最右」搬到这里：chip 行是「筛当前列表」，
                而这个按钮管的是整个插件，混在一排 chip 末尾会被当成筛选器的第四个选项。 */}
            <button type="button" className="npr-icon npr-settings-button" title="插件设置" aria-label="插件设置" onClick={() => setDialog('settings')}><Icon name="settings" size={17} /></button>
          </div>
          <div className="npr-filters" role="group">
            {[['all', '全部'], ['unread', '未读'], ['favorites', '收藏']].map(([value, label]) => (
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <div className={`npr-search-box${searchOpen ? '' : ' is-hidden'}`}>
            <input ref={searchInput} type="search" aria-label="搜索文章" placeholder="搜索已加载的文章…" value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setSearchOpen(false); setQuery(''); } }} />
          </div>
          <div className={`npr-status${pageError ? ' is-error' : ''}`} role="status" aria-live="polite">
            {pageError ? pageError : ''}
          </div>
          {sourceNotice && showSourceNotice && (
            <div className="npr-notice" role="status">
              <Icon name="info" size={13} />
              {/* 明细（哪些源、为什么）挪进 title：一行装不下，但它按需可查。 */}
              <span className="npr-notice-text" title={sourceNotice.detail}>{sourceNotice.title}</span>
              {channel !== 'feeds:all' && (
                <button type="button" className="npr-notice-link" onClick={() => selectChannel('feeds:all')}>查看订阅</button>
              )}
              <button type="button" className="npr-notice-close" aria-label="不再提示" title="不再提示"
                onClick={() => {
                  localStorage.setItem('npr.staleNotice', sourceNotice.key);
                  setDismissedNotice(sourceNotice.key);
                }}><Icon name="x" size={13} /></button>
            </div>
          )}
          <div className="npr-list">
            {pageError && <div className="npr-empty"><button type="button" onClick={() => void loadPage(undefined, true)}>重试</button></div>}
            {!pageError && loading && page.entries.length === 0 && <div className="npr-empty">正在加载…</div>}
            {!pageError && !loading && page.entries.length === 0 && (
              <div className="npr-empty">
                <p>{emptyListMessage({ filter, refreshing, channel, channels })}</p>
                {(emptyFailure || feedCount === 0) && (
                  <div className="npr-empty-actions">
                    {emptyFailure && <button type="button" onClick={() => void refresh(channel)}>重试</button>}
                    {emptyFailure && <button type="button" onClick={() => selectChannel('feeds:all')}>查看我的订阅</button>}
                    {!emptyFailure && <button type="button" onClick={() => setDialog('discover')}>探索订阅源</button>}
                  </div>
                )}
              </div>
            )}
            {page.entries.map((entry) => (
              <button key={entry.key} type="button" className={`npr-entry${selected?.article?.key === entry.key ? ' npr-selected' : ''}${entry.read ? ' npr-read' : ''}${entry.summary ? '' : ' npr-no-summary'}`}
                aria-pressed={selected?.article?.key === entry.key} onClick={() => void openArticle(entry.key)}>
                <span className="npr-entry-copy">
                  <span className="npr-entry-meta">
                    <span className="npr-source-name">{entry.channelName || channels.find((item) => item.key === entry.channelKey)?.name || currentChannel?.name}</span>
                    <span className="npr-date">{formatDay(entry.publishedAt)}</span>
                  </span>
                  <span className="npr-entry-title">
                    <span className={entry.read ? 'npr-read-dot' : 'npr-unread-dot'} aria-hidden="true" />
                    <span className="npr-visually-hidden">{entry.read ? '已读' : '未读'}</span>
                    <h3>{entry.titleZh ?? entry.title}</h3>
                    {entry.favorite && <span className="npr-bookmarked"><Icon name="bookmark" size={12} /></span>}
                  </span>
                  {entry.summary && <p className="npr-summary">{entry.summary}</p>}
                </span>
                {entry.image && <span className="npr-entry-thumb"><img src={entry.image} alt="" loading="lazy" referrerPolicy="no-referrer" /></span>}
              </button>
            ))}
            {page.hasMore && page.nextCursor && (
              <button type="button" className="npr-more" disabled={loadingMore} onClick={() => void loadPage(page.nextCursor, false)}>
                {loadingMore ? '加载中…' : '加载更早文章'}
              </button>
            )}
          </div>
        </aside>
        <div className="npr-resize" role="separator" aria-orientation="vertical" onPointerDown={startDrag}
          onDoubleClick={() => { setListWidth(300); localStorage.setItem('npr.listWidth', '300'); }} />
        {/* 同样不能带 tabIndex：`.npr-reader-toolbar` 就在这个 section 里面，
            祖先一旦命中宿主的 `[tabindex]` no-drag，工具栏的拖动区会被做差减掉。 */}
        <section className="npr-reader">
          {selected?.loading ? (
            <div className="npr-article-loading" role="status" aria-label="正在加载文章">
              <div className="npr-reader-toolbar npr-skeleton-toolbar" aria-hidden="true"><span className="npr-skeleton npr-skeleton-icon" /><span className="npr-skeleton npr-skeleton-pill" /><span className="npr-skeleton npr-skeleton-icon" /><span className="npr-skeleton npr-skeleton-icon" /></div>
              <div className="npr-article npr-article-skeleton" aria-hidden="true">
                <div className="npr-skeleton npr-skeleton-meta" /><div className="npr-skeleton npr-skeleton-title" /><div className="npr-skeleton npr-skeleton-title short" />
                <div className="npr-skeleton-paragraph"><div className="npr-skeleton" /><div className="npr-skeleton" /><div className="npr-skeleton" /></div>
                <div className="npr-skeleton-paragraph"><div className="npr-skeleton" /><div className="npr-skeleton" /><div className="npr-skeleton" /></div>
                <div className="npr-skeleton-paragraph"><div className="npr-skeleton" /><div className="npr-skeleton" /></div>
              </div>
              <span className="npr-visually-hidden">正在加载文章…</span>
            </div>
          ) : selected?.error ? (
            <div className="npr-article-load-error" role="alert"><Icon name="file-check" size={22} /><h2>文章暂时无法打开</h2><p>请重试读取这篇文章。</p><button type="button" onClick={() => void openArticle(selected.key)}>重新加载</button></div>
          ) : !activeArticle ? (
            <div className="npr-welcome">
              <div className="npr-welcome-brand">NPIE READER</div>
              <h2>订阅你关注的作者</h2>
              <p className="npr-welcome-intro">
                左侧是频道与文章列表：全部、未读、收藏可切换；点击标题开始阅读。译文与改写缺失时，用 Harness 当前模型补全。
              </p>
              <div className="npr-welcome-keys">
                {[['J / K', '上一篇 / 下一篇'], ['[', '专注阅读'], ['/', '搜索文章']].map(([key, label]) => (
                  <span key={key}><kbd>{key}</kbd><span>{label}</span></span>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="npr-reader-toolbar" data-window-drag>
                <button type="button" className="npr-icon" title={askContext ? '选择频道' : focused ? '显示列表' : '专注阅读'} aria-label={askContext ? '选择频道' : focused ? '显示列表' : '专注阅读'}
                  onClick={(event) => askContext ? openPicker(event) : setFocused((current) => !current)}><Icon name={askContext ? 'panel-left-open' : focused ? 'panel-left-open' : 'panel-left-close'} /></button>
                <label className="npr-visually-hidden" htmlFor="npr-mode">阅读版本</label>
                <div className="npr-version-switch"><span aria-hidden="true">版本</span><select id="npr-mode" className="npr-mode-select" value={active} onChange={(event) => { setPassage(null); setSelected((current) => ({ ...current, active: event.target.value })); }}>
                  {['original', 'translation', 'rewrite'].map((kind) => {
                    const available = kind === 'original' || versions?.[kind]?.available;
                    return <option key={kind} value={kind}>{VERSION_LABELS[kind]}{available ? '' : '（缺失）'}</option>;
                  })}
                </select><Icon name="chevron-down" size={12} /></div>
                <div className="npr-reader-nav">
                  <button type="button" className="npr-icon" title="上一篇" aria-label="上一篇" onClick={() => navigate(-1)}><Icon name="chevron-up" /></button>
                  <button type="button" className="npr-icon" title="下一篇" aria-label="下一篇" onClick={() => navigate(1)}><Icon name="chevron-down" /></button>
                </div>
                <div className="npr-actions">
                  <button type="button" className={`npr-icon${activeArticle.article.favorite ? ' is-active' : ''}`}
                    title={activeArticle.article.favorite ? '取消收藏' : '收藏'} aria-label="收藏" aria-pressed={Boolean(activeArticle.article.favorite)}
                    onClick={() => void toggleFavorite(activeArticle.article.key, activeArticle.article.favorite)}><Icon name="bookmark" /></button>
                  <button type="button" className="npr-icon" title={activeArticle.article.read ? '标记未读' : '标记已读'} aria-label="标记已读状态"
                    aria-pressed={Boolean(activeArticle.article.read)} onClick={() => void setRead(activeArticle.article.key, !activeArticle.article.read)}>
                    <Icon name={activeArticle.article.read ? 'circle-check' : 'circle'} />
                  </button>
                  <button type="button" className="npr-icon" title="AI 伴读" aria-label="AI 伴读" onClick={() => openCompanion(passage?.quote ?? '')}><Icon name="wand-sparkles" /></button>
                  <button type="button" className="npr-icon" title="更多操作" aria-label="更多操作"
                    aria-haspopup="menu" aria-expanded={menuOpen} ref={menuButtonRef}
                    onClick={() => setMenuOpen((open) => !open)}><Icon name="ellipsis" /></button>
                  {menuOpen && (
                    <div className="npr-menu" role="menu" ref={menuRef}>
                      <button type="button" onClick={() => { setMenuOpen(false); setAppearanceOpen(true); }}><Icon name="type" size={15} />阅读设置</button>
                      <button type="button" onClick={() => { setMenuOpen(false); openCompanion(passage?.quote ?? ''); }}><Icon name="wand-sparkles" size={15} />问 AI</button>
                      <hr />
                      {activeArticle.article.url && <button type="button" onClick={() => { setMenuOpen(false); window.open(activeArticle.article.url, '_blank', 'noopener,noreferrer'); }}><Icon name="globe" size={15} />打开原文</button>}
                      <button type="button" onClick={() => { setMenuOpen(false); try { printArticle({ title: activeArticle.article.title, url: activeArticle.article.url, version: VERSION_LABELS[active], html: bodyHtml }); } catch (error) { notify(`打印失败：${error?.message ?? String(error)}`, true); } }}><Icon name="file-check" size={15} />打印 / 存为 PDF</button>
                      {/* 这两条只对**原文**有意义，所以只在「原文」版本下出现（用户 2026-10-13 要求）：
                          「抓取原文全文」补的是原文正文，「重新加载文章」重读的也是原文那一份。
                          切到译文 / 改写之后它们既看不到效果、又占着位置 ⇒ 一律不渲染。
                          ★ 操作期间各自 `disabled`（两条**互不影响**），文案改成「正在…」——
                            菜单点一下就关，重开菜单时这条必须能自证「还在跑」。 */}
                      {menuItems.fetchFullText && (
                        <button type="button" disabled={fetchingFullText}
                          onClick={() => { setMenuOpen(false); void fetchFullText(activeArticle.article.key); }}>
                          <Icon name="download" size={15} />{busyMenuLabel('抓取原文全文', fetchingFullText)}
                        </button>
                      )}
                      {menuItems.regenerate && (
                        <button type="button" disabled={Boolean(selected?.generating)}
                          onClick={() => { setMenuOpen(false); void generate(active, true); }}>
                          <Icon name="refresh-cw" size={15} />{regenerateMenuLabel({ active, generating: selected?.generating })}
                        </button>
                      )}
                      {menuItems.reloadArticle && (
                        <button type="button" disabled={reloadingArticle}
                          onClick={() => { setMenuOpen(false); void reloadArticle(activeArticle.article.key); }}>
                          <Icon name="refresh-cw" size={15} />{busyMenuLabel('重新加载文章', reloadingArticle)}
                        </button>
                      )}
                      <button type="button" onClick={() => { setMenuOpen(false); setDialog('settings'); }}><Icon name="settings" size={15} />插件设置</button>
                      <button type="button" onClick={(event) => { setMenuOpen(false); openPicker(event); }}><Icon name="rss" size={15} />选择频道</button>
                    </div>
                  )}
                  {appearanceOpen && <ReadingAppearance settings={reading} onChange={applyReading} onClose={() => setAppearanceOpen(false)} />}
                </div>
              </div>
              <article className="npr-article">
                <div className="npr-article-head">
                  {activeArticle.article.channelName && <span>{activeArticle.article.channelName}</span>}
                  {activeArticle.article.publishedAt && <span>{formatFullDay(activeArticle.article.publishedAt)}</span>}
                  {activeArticle.article.author && <span>{activeArticle.article.author}</span>}
                  <span className="npr-mode-chip">{VERSION_LABELS[active]}</span>
                  {activeArticle.article.bodyMissing && <span title="订阅源只提供摘要，且没能从原文页抓到全文；可在「更多操作」里手动抓取">仅摘要</span>}
                </div>
                <h1>
                  {activeArticle.article.url
                    ? <a href={activeArticle.article.url} target="_blank" rel="noopener noreferrer">{title}</a>
                    : title}
                </h1>
                {audioUrl && <MediaDock key={activeArticle.article.key} episode={{ ...activeArticle.article, audio: audioUrl }} />}
                {selected?.translating && (
                  <div className="npr-translating" role="status">
                    <Icon name="refresh-cw" size={14} />
                    <span>原文是英文，正在用 {modelLabel} 翻译成中文…</span>
                    <button type="button" title="关掉之后不再自动翻译英文原文；已有的中文版本不受影响"
                      onClick={() => void applyReading({ autoTranslate: false })}>以后不自动翻译</button>
                  </div>
                )}
                {/* 手动「重新生成」的进度条。正文还在（显示的是旧版本），所以
                    npr-missing 那条不会渲染 —— 没有这条的话生成期间界面毫无动静。 */}
                <RegeneratingNotice kind={selected?.generating} hasBody={Boolean(bodyHtml)} />
                {/* ★ 译文只翻了一部分时必须说出来。模型漏掉的段落会保留英文原文
                    （安全底线），于是正文是中英混排 —— 不解释一句，用户只会得出
                    「翻译质量真差」，不会知道「再点一次可能就全了」。 */}
                <PartialTranslationNotice active={active} coverage={versions?.translation?.coverage} />
                {bodyHtml
                  ? <div ref={proseRef} className="npr-prose" onMouseUp={captureSelection} onKeyUp={captureSelection} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
                  : (
                    <div className="npr-missing">
                      这个版本还没有内容。
                      {active !== 'original' && (
                        <>
                          <br />
                          <button type="button" className="npr-more" style={{ display: 'inline-block' }}
                            disabled={selected?.generating === active} onClick={() => void generate(active)}>
                            {selected?.generating === active ? '生成中…' : `用 ${modelLabel} 生成`}
                          </button>
                        </>
                      )}
                    </div>
                  )}
              </article>
            </>
          )}
        </section>
      </div>
      {askContext && <div className="npr-companion-divider" role="separator" aria-label="调整文章与伴读宽度" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={companionWidth} tabIndex={0}
        onPointerDown={event => { event.preventDefault(); companionDrag.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.dragging = 'true'; }}
        onPointerMove={event => { if (!companionDrag.current) return; const area = workareaRef.current; const rect = area?.getBoundingClientRect(); if (!rect) return; const vertical = getComputedStyle(area).flexDirection === 'column'; const total = vertical ? rect.height : rect.width; const span = vertical ? rect.bottom - event.clientY : rect.right - event.clientX; const minimum = Math.min(320, total * .3); const amount = Math.max(minimum, Math.min(span, total - minimum)); companionWidthRef.current = Math.round(amount / total * 100); setCompanionWidth(companionWidthRef.current); }}
        onPointerUp={event => { companionDrag.current = false; event.currentTarget.dataset.dragging = 'false'; localStorage.setItem('npr.companionWidth', String(companionWidthRef.current)); }}
        onPointerCancel={event => { companionDrag.current = false; event.currentTarget.dataset.dragging = 'false'; }}
        onKeyDown={event => { const step = event.shiftKey ? 10 : 2; if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const next = Math.max(25, Math.min(75, companionWidth + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? step : -step))); companionWidthRef.current = next; setCompanionWidth(next); localStorage.setItem('npr.companionWidth', String(next)); } }}
        onDoubleClick={() => { companionWidthRef.current = 44; setCompanionWidth(44); localStorage.setItem('npr.companionWidth', '44'); }} />}
      {askContext && <AskArticle api={api} context={askContext} onClearSelection={() => { setPassage(null); window.getSelection()?.removeAllRanges(); setAskContext(previous => previous ? { ...previous, selection: '', quoteId: undefined } : previous); }} SessionProvider={SessionProvider} renderSlot={renderSlot} onClose={() => setAskContext(null)} onManagePrompts={() => { setSettingsEntry({ tab: 'prompts', addPrompt: true }); setDialog('settings'); }} />}
      </div>
      )}
      {pickerOpen && !dialog && (
        <ChannelPicker channels={channels} current={channel} anchor={pickerAnchor} onClose={() => setPickerOpen(false)}
          onSelect={selectChannel} onManage={() => { setPickerOpen(false); setSettingsEntry({ tab: 'sources', addPrompt: false }); setDialog('settings'); }} />
      )}
      {dialog === 'discover' && <Discover api={api} onClose={() => setDialog(undefined)} onAdded={onSubscriptionAdded} onRead={(key) => { setDialog(undefined); selectChannel(key); }} />}
      {/* 分组候选直接从频道清单里取：`kind:'feed'` 的频道带 `group` 字段，
          分组频道与「全部」频道都没有 —— 所以不用为了一份分组名再拉一次订阅列表。 */}
      {showAddFeed && <AddFeedDialog api={api} groups={groupNamesOf(channels)} onClose={() => setShowAddFeed(false)} onDone={onSubscriptionAdded} notify={notify} />}
      {addMenu && (
        <>
          <div className="npr-addmenu-backdrop" onClick={() => setAddMenu(null)} />
          <div className="npr-addmenu" style={{ left: addMenu.left, top: addMenu.top }} role="menu" aria-label="订阅菜单">
            <button type="button" role="menuitem" onClick={() => { setAddMenu(null); setShowAddFeed(true); }}>
              <Icon name="plus" size={15} />
              <span>粘贴订阅地址<small>RSS / Atom，支持一次粘多个</small></span>
            </button>
            <button type="button" role="menuitem" onClick={() => { setAddMenu(null); setDialog('discover'); }}>
              <Icon name="rss" size={15} />
              <span>浏览推荐源<small>Newsletter · 独立博客</small></span>
            </button>
            <button type="button" role="menuitem" onClick={() => { setAddMenu(null); setSettingsEntry({ tab: 'sources', addPrompt: false }); setDialog('settings'); }}>
              <Icon name="settings" size={15} />
              <span>管理订阅<small>分组、改名、换源、导入 OPML</small></span>
            </button>
            {/* 「切换频道」原先只在「更多操作」里（阅读区 ⋯ 菜单，要先进一篇文章才看得到）。
                用户在列表页想换频道时没有入口，所以这里也放一份。
                ★ 必须把 event 传下去：`openPicker` 用 `currentTarget` 的 rect 定位弹层，
                  不传 event 的话锚点算不出来，弹层会掉到左上角。 */}
            <button type="button" role="menuitem" onClick={(event) => { setAddMenu(null); openPicker(event); }}>
              <Icon name="book-open" size={15} />
              <span>选择频道<small>按分组与单个订阅源筛选</small></span>
            </button>
          </div>
        </>
      )}
      {dialog === 'settings' && <SettingsPage api={api} initialTab={settingsEntry.tab} startAddingPrompt={settingsEntry.addPrompt} onSubscriptionsChanged={onSubscriptionAdded} onClose={() => { setDialog(undefined); setSettingsEntry({ tab: 'reading', addPrompt: false }); void loadChannels(); }} notify={notify} />}
      {toast && <div role="status" aria-live="polite" className={`npr-toast${toast.isError ? ' is-error' : ''}`}>{toast.message}</div>}
    </div>
  );
}
