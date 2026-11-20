/**
 * dsh-npie-reader reader panel. A compact channel toolbar, inline filter
 * pills, list rows with source/date, title, excerpt and thumbnail, and a
 * sticky reader toolbar with the reading-version select.
 *
 * Visual parameters come from DSH design tokens (`--dsw-*`); the plugin accent
 * goes through `var(--npc-brand, …)` so the NPIE theme can restyle it, and text
 * or fills that carry white text use the darker `--npc-brand-dark` variant.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeHtml } from '../host/sanitize.js';
import { markdownToHtml } from '../host/markdown.js';
import { READING_DEFAULTS, fontStack } from '../reading-settings.js';
import { effectiveModelLabel } from '../ai-model.js';
import { Icon } from './icons.jsx';
import { BRAND_TITLE, SLOGAN_EN, SLOGAN_ZH } from './brand.js';
import { ChannelPicker, ChannelMark } from './ChannelPicker.jsx';
import { ReadingAppearance } from './ReadingAppearance.jsx';
import { SettingsPage } from './SettingsPage.jsx';
import { resolveReadingVersion, shouldAutoTranslate } from './reading-version.js';
import { buildContrastHtml, contrastReadable } from './contrast-view.js';
import { activeIndex, outlineOf, scrollTarget } from './article-outline.js';
import {
  pickVoice, speechChunks, speechChunksForReading, SPEECH_RATES, SPEECH_SAMPLE,
  SPEECH_VOICE_KEY, SPEECH_RATE_KEY, SPEECH_PREFS_EVENT,
  speechVoiceGroups, activeSpeechVoiceValue, writeSpeechPrefs,
} from './article-speech.js';
import { isPronunciationEnabled } from '../speech-pronunciation.js';
import {
  SPEECH_API_PREFIX, SPEECH_CLOUD_CHUNK,
  parseSpeechVoice,
} from '../speech.js';
import { createCloudPlayer, fetchCloudAudio } from './speech-engine.js';
import { articleToMarkdown, downloadText, markdownFileName } from './article-markdown.js';
import { Discover } from './Discover.jsx';
import { MediaDock } from './MediaDock.jsx';
import { TranscriptPanel, nextLang } from './TranscriptPanel.jsx';
import { EpisodeDigest } from './EpisodeDigest.jsx';
import { runTranscriptTranslation, translatedCount } from './transcript-translation.js';
import { quoteRange, selectedPassage } from './selection.js';
import { selectionBarPlacement } from './selection-bar.js';
import { AskArticle } from './AskArticle.jsx';
import { articleAudioUrl } from '../media.js';
import { formatDay, formatFullDay } from './format-time.js';
import { printArticle } from './print-article.js';
import { placeRowMenu, rowMenuItems } from './row-menu.js';
import { channelAfterAdd, channelFailure, countFeeds, emptyListMessage, resolveChannel } from './channel-route.js';
import { readChannelState, saveChannelState } from './channel-state.js';
import { appendDiaryEntry } from './diary-api.js';
import { excerptEntry } from './excerpt.js';
import { dateKey } from '../diary-format.js';
import { staleNotice } from './source-health.js';
import { AddFeedDialog } from './dialogs.jsx';
import { groupNamesOf } from './groups.js';
import { LibraryApp } from './LibraryApp.jsx';
import { PapersApp } from './PapersApp.jsx';
import { DiaryApp } from './DiaryApp.jsx';
import { QuickCapture } from './QuickCapture.jsx';
import { seedBlock } from './quick-draft.js';
import { ViewSwitch } from './ViewSwitch.jsx';
import {
  SIDEBAR_MIN_WIDTH, SIDEBAR_WIDTH,
  clampSidebarWidth, readSidebarWidth, saveSidebarWidth,
} from './sidebar-width.js';
import REFINEMENTS from './refinements.css';
import { attachMenuDismiss } from './menu-dismiss.js';

/**
 * 首帧要恢复的「浏览状态」（筛选 / 搜索词）。
 *
 * ★ 必须**缓存**：面板每次重渲染都会走到取初始值的地方，而 `localStorage.getItem`
 *   + `JSON.parse` 放在渲染路径上就是每次滚动都解析一遍 JSON。这里只读一次 ——
 *   同一个面板实例（`kind: 'single'`）只有一个首帧。
 */
let bootBrowse;
function initialBrowseState() {
  if (bootBrowse === undefined) {
    bootBrowse = readChannelState(localStorage.getItem('npr.channel') || 'feeds:all', localStorage);
  }
  return bootBrowse;
}

const PANEL_CSS = `.npr-root{--npr-bg:var(--dsw-alias-bg-base);--npr-bg-2:var(--dsw-alias-bg-layer-1);--npr-fg:var(--dsw-alias-label-primary);--npr-muted:var(--dsw-alias-label-secondary);--npr-faint:var(--dsw-alias-label-tertiary);--npr-border:var(--dsw-alias-border-l1);--npr-border-strong:var(--dsw-alias-border-l2);--npr-hover:var(--dsw-alias-interactive-bg-hover);--npr-accent:var(--npc-brand,var(--dsw-alias-brand-primary));--npr-accent-strong:var(--npc-brand-dark,color-mix(in srgb,var(--dsw-alias-brand-primary) 74%,#000));--npr-scrim:var(--dsw-alias-bg-mask-1);/* 伴读对话容器专用：refinements.css 里那块「把宿主 --dsw-* 令牌改写成阅读主题色」的覆写引用了它们。
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
/* ★★ 侧边栏的**宽度下限**（0.45.2）—— 一个数，三处用：这条 grid、@container 里那条、
   以及 sidebar-width.js 里四个视图共用的拖动 / 首屏夹取。
   256px 是**量出来的**（.build/preview/measure-sidebar-min.mjs，真 Chrome）：
     · 工具栏要 240px 才放得下（三档视图开关 88 + 四颗图标 4×28 + 内外边距与间距 30；
       频道按钮在窄处自己缩到 0，所以它不参与这道门槛）；
     · 筛选条四颗 chip 要 244px 才不换行（「已隐藏 1」）；
     · 两位数的计数「已隐藏 12」要 252px。
   用户第一次报障时侧边栏是 220px（那是拖动下限）—— 换行与齿轮被裁两条全中；
   他自己拖到 251px 时看着就对了（那张「这样才对」的截图）。取 256：比 252 多 4px 余量。
   ★ 三位数（「已隐藏 123」）仍会换行 —— 那是设计好的兜底（换行不等于裁字），不是缺陷。 */
.npr-root{--npr-sidebar-min:256px}
.npr-layout{flex:1;min-height:0;display:grid;grid-template-columns:max(var(--npr-sidebar-min),min(var(--npr-list-width),calc(100cqw - 330px))) 1px minmax(0,1fr)}
.npr-sidebar{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--npr-bg-2)}
.npr-sidebar-toolbar{display:flex;align-items:center;gap:2px;height:44px;flex-shrink:0;padding:5px 8px 5px 12px}
.npr-root .npr-channel{min-width:0;flex:1;display:flex;align-items:center;justify-content:flex-start;gap:7px;padding:4px 0;height:32px;border:0;background:transparent;color:var(--npr-fg);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.npr-root .npr-channel:hover{color:var(--npr-accent)}
.npr-channel-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.npr-channel-label + svg{flex:0 0 auto;color:var(--npr-muted)}
.npr-filters{display:flex;align-items:center;gap:2px;margin:0 var(--npr-tab-inset,12px) 8px;padding:0 0 8px;background:transparent;border:0}
/* 几何走 refinements.css 的「切换控件」那一节（0.44.6）：这里是**兜底值**，样式表没加载
   时筛选条也还是 26 / 6 / 13 那一套。两处写的是同一组数字 —— 这是有意为之：
   一致靠的是「同源变量」，不是靠谁比谁后加载赢一次层叠。
   ★ 筛选条是**二级**：没有槽（不画底座），宽度按文案走 —— 用户 2026-10-28 明确
     「这部分不要统一，因为这部分是下一级，还保持原来的样子」。
   ★ hover **只改字色**：无槽时若再画一块底色，就与「选中块」撞脸（截图里两块并排亮着）。
   ★ 注释里一个反引号都不能有：这段在**模板字符串内部**，反引号会提前闭合它。 */
.npr-root .npr-filters button{height:var(--npr-tab-h,26px);padding:0 10px;font:inherit;font-size:var(--npr-tab-font,13px);font-weight:400;color:var(--npr-muted);background:transparent;border:0;border-radius:var(--npr-tab-r,6px);cursor:pointer}
.npr-root .npr-filters button:hover{color:var(--npr-fg);background:transparent}
.npr-root .npr-filters button[aria-pressed=true]{background:var(--npr-tab-track,color-mix(in srgb,var(--npr-fg) 8%,var(--npr-bg)));color:var(--npr-fg);font-weight:600}
/* 一级筛选（RSS 阅读页的 全部/未读/收藏）：与分页、日记三模块同一套 —— 有底座、等分。
   这一页没有页面切换器，它自己就是顶层；书架页那条二级筛选仍然无底座、按文案定宽。 */
.npr-root .npr-filters.npr-filters-primary{gap:var(--npr-tab-pad,2px);padding:var(--npr-tab-pad,2px);border:1px solid transparent;border-radius:8px;background:var(--npr-tab-track,color-mix(in srgb,var(--npr-fg) 8%,var(--npr-bg)));flex-wrap:wrap}
/* ★ min-width:max-content 加 flex-wrap（0.45.1）：四颗 chip 是**等分**的（flex:1 1 0），
   但等分到装不下时，原来的 min-width:0 会让文字被裁 —— 用户截图里「已隐藏 1」的数字
   只露出半个。改成「最小就是内容宽」，装不下时**换行**（wrap），一个字都不裁。
   宽侧边栏下这一对属性完全不起作用（放得下就不换行、内容宽本来就小于等分宽）。
   ★ 这段在模板串里，注释里一个反引号都不能写。 */
.npr-root .npr-filters.npr-filters-primary button{flex:1 1 0;min-width:max-content}
.npr-root .npr-filters.npr-filters-primary button:hover{background:var(--npr-hover,color-mix(in srgb,var(--npr-fg) 6%,var(--npr-bg)))}
.npr-root .npr-filters.npr-filters-primary button[aria-pressed=true]{background:var(--npr-tab-thumb,var(--npr-bg));box-shadow:0 1px 2px rgba(0,0,0,.06)}
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
.npr-actions{display:flex;align-items:center;gap:4px;margin-left:auto;position:relative}
.npr-root .npr-icon{display:inline-flex;flex-shrink:0;position:relative;align-items:center;justify-content:center;width:32px;height:32px;padding:7px;border:0;border-radius:5px;background:transparent;color:var(--npr-muted);cursor:pointer}
/* 0.84.8：工具栏 7 颗图标等宽等重连排，读起来是一团，用户看不出「收藏/已读」「问 AI/朗读」
   「大纲/设置/更多」其实是三件事。用一条极细的竖线把它们分成三组，不加分组标题、
   不挪动任何入口的可达性（收进菜单会让常用动作多点一次）。 */
.npr-actions .npr-icon[data-sep]{margin-left:5px}
.npr-actions .npr-icon[data-sep]::before{content:'';position:absolute;left:-4px;top:50%;width:1px;height:16px;transform:translateY(-50%);background:var(--npr-border-strong);pointer-events:none}
.npr-root .npr-icon:hover{color:var(--npr-fg);background:var(--npr-hover)}
/* ★ 0.84.1：带音频的播客把朗读按钮 disabled 之后，**必须画成灰的**。
   只给 disabled 属性、却留着 hover 高亮，就是本项目记过好几次的「看着能点、点了没反应」。
   :disabled:hover 要单独写一条：只写 :disabled 会被上面那条 .npr-icon:hover 盖掉底色。 */
.npr-root .npr-icon:disabled{opacity:.38;cursor:not-allowed}
.npr-root .npr-icon:disabled:hover{background:transparent;color:var(--npr-muted)}
.npr-root .npr-icon svg{width:17px;height:17px}
.npr-root .npr-icon.is-active svg{fill:currentColor}
.npr-root .npr-icon.is-loading svg{animation:npr-spin 1.2s linear infinite}
@keyframes npr-spin{to{transform:rotate(360deg)}}
.npr-root.npr-focus .npr-layout{grid-template-columns:minmax(0,1fr)}
.npr-root.npr-focus .npr-sidebar,.npr-root.npr-focus .npr-resize{display:none}
.npr-article{max-width:var(--npr-article-width);margin:0 auto;padding:30px clamp(24px,5%,60px) 90px}
/* ★ 0.84.6：元信息行两种态共用一条规则。以前收听头另写 11.5px / faint / gap 8，
   切 tab 时整行字会缩小、颜色变淡 —— 用户要的是「除了内容，其它全一样」。 */
.npr-article-head,.npr-listen-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:0 0 14px;color:var(--npr-muted);font-size:12px;line-height:1.6}
.npr-article-head .npr-mode-chip,.npr-listen-meta .npr-mode-chip{padding:1px 7px;border:.5px solid var(--npr-border-strong);border-radius:999px;font-size:11px}
/* ★ 0.84.3 起标题排版**一条规则、两个选择器**；0.84.6 把 margin 也并进来。
   文章态用 .npr-article > h1，字幕/导读态用 .npr-listen-head h1（另一处 h1，
   正文那颗被 data-listen 隐掉）。以前收听头另写 21px/1.35 + margin 0，
   用户一眼看出切 tab 标题变小、离播放条的间距也变窄 —— 两份写法必然漂移。 */
.npr-article > h1,.npr-listen-head h1{font-size:clamp(24px,2.5cqw,32px);line-height:1.5;letter-spacing:-.025em;overflow-wrap:anywhere;font-weight:600;text-wrap:balance;font-family:var(--npr-font-family);margin:0 0 26px}
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
/* 双语对照（0.57.0）：译文块用**一条细竖线 + 略淡的字**与原文分开。
   ★ 不换纸色、不加底色：正文区已经有六种纸色主题，再叠一层背景就会和主题打架，
     而「哪一句是译文」用一条线与字色差已经说得清。 */
.npr-prose .npr-ct-zh{color:var(--npr-muted);padding-left:12px;border-left:2px solid color-mix(in srgb, var(--npr-accent) 35%, var(--npr-border));font-size:.96em}
.npr-prose p.npr-ct-zh,.npr-prose figcaption.npr-ct-zh,.npr-prose dd.npr-ct-zh{margin:.25em 0 1.1em}
.npr-prose h1.npr-ct-zh,.npr-prose h2.npr-ct-zh,.npr-prose h3.npr-ct-zh,.npr-prose h4.npr-ct-zh{margin:.3em 0 .7em}
.npr-prose blockquote.npr-ct-zh{margin:.4em 0 1.3em}
.npr-prose li>.npr-ct-zh,.npr-prose td>.npr-ct-zh,.npr-prose th>.npr-ct-zh{margin:.3em 0 .1em;font-size:.94em}
.npr-ct-split{border:0;border-top:1px solid var(--npr-border);margin:2em 0 1.4em}
.npr-root[data-images=false] .npr-prose img{display:none}
/* ---- 文章大纲（0.44）----
   浮在阅读区右上，**不挤压正文**：挤压会让 prose 重排、正在读的那一行跳走 ——
   目录本来就是用来定位的，先把它自己的副作用去掉。
   宽度 232px：标题超过 44 字在 JS 里就截断了，这个宽度刚好放得下两行以内。 */
.npr-outline-toggle[aria-expanded="true"]{background:var(--npr-hover);color:var(--npr-fg)}
.npr-outline-slot{position:sticky;top:52px;height:0;z-index:6}
.npr-outline{position:absolute;top:0;right:18px;width:232px;max-height:min(62vh,520px);display:flex;flex-direction:column;border:1px solid var(--npr-border);border-radius:10px;background:var(--npr-bg);box-shadow:0 10px 28px rgba(0,0,0,.16);overflow:hidden}
.npr-outline-head{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:6px 6px 6px 12px;border-bottom:1px solid var(--npr-border);font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--npr-faint)}
.npr-outline-head .npr-icon{width:24px;height:24px;padding:4px}
.npr-outline-list{flex:1 1 auto;margin:0;padding:4px;overflow:auto;list-style:none}
.npr-outline-list li{margin:0}
.npr-outline-list button{display:block;width:100%;padding:4px 8px;border:0;border-radius:5px;background:transparent;color:var(--npr-muted);font:inherit;font-size:12.5px;line-height:1.5;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.npr-outline-list button:hover{background:var(--npr-hover);color:var(--npr-fg)}
.npr-outline-list button.is-current{color:var(--npr-accent-strong);background:color-mix(in srgb,var(--npr-accent) 9%,transparent);font-weight:600}
.npr-outline-list li[data-level="2"] button{padding-left:20px}
.npr-outline-list li[data-level="3"] button{padding-left:32px;font-size:12px}
.npr-outline-list li[data-level="4"] button{padding-left:44px;font-size:12px;color:var(--npr-faint)}
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
/* 品牌行现在写的是「澄境 | Limina」——**中英混排**。原来那套 10px / letter-spacing:.2em
   是给纯大写英文（NPIE READER）调的：同样的字距套到两个汉字上，会把「澄境」拉成
   「澄 境」，像两处打字错误。11px + .1em 让中文两字仍是一个词，英文也不糊在一起。 */
.npr-welcome-brand{font-size:11px;font-weight:600;letter-spacing:.1em;color:var(--npr-faint);margin-bottom:28px}
.npr-welcome h2{font-family:var(--npr-font-family);font-size:clamp(25px,3vw,34px);font-weight:400;letter-spacing:.02em;line-height:1.5;margin:0 0 12px;color:var(--npr-fg)}
/* 英文 slogan 贴着 h2（-4px 抵掉一部分标题下边距，净距 8px），但离正文远（22px）：
   它属于**标题**那一组，不属于下面三段说明。
   颜色用 --npr-muted 而不是 --npr-faint：11.5px 的拉丁小字在 faint 档只有约 3.9:1。 */
.npr-welcome-slogan-en{margin:-4px 0 22px;font-size:11.5px;letter-spacing:.06em;line-height:1.6;color:var(--npr-muted)}
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
.npr-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:var(--npr-surface);border:.5px solid var(--npr-border-strong);color:var(--dsw-alias-label-primary);border-radius:10px;padding:8px 16px;font-size:13px;box-shadow:var(--npr-elevation);z-index:60}
.npr-toast.is-error{color:var(--dsw-alias-state-error-primary)}
/* 撤销按钮：用品牌色文字 + 一点点底色，和提示文字分得开，但**不做成实心按钮** ——
   实心块会把这条提示读成「确认/取消」对话框，而它只是一句话加一个后悔的机会。 */
.npr-toast-action{padding:2px 8px;font:inherit;font-size:12.5px;font-weight:600;color:var(--npr-accent-strong);background:var(--npr-hover);border:0;border-radius:6px;cursor:pointer}
.npr-toast-action:hover{background:var(--npr-border-strong)}
/* 选中文本后浮在选区上方的操作条（0.45.0）。
   ★ 用 position:fixed 而不是 absolute：选区可能在滚动容器里，absolute 会跟着内容走。
   ★ 按钮样式逐条写死：宿主的全局 button 规则会把它撑成整行（和 .npr-menu button 同一个理由）。
   ★ 这段在模板串里，注释里不能出现反引号。 */
.npr-selection-bar{position:fixed;z-index:70;display:flex;align-items:center;gap:2px;padding:3px;background:var(--npr-surface);border:.5px solid var(--npr-border-strong);border-radius:9px;box-shadow:var(--npr-elevation);transform:translateX(-50%)}
.npr-selection-bar button{display:flex;align-items:center;gap:5px;padding:4px 9px;font:inherit;font-size:12.5px;color:var(--npr-fg);background:transparent;border:0;border-radius:6px;cursor:pointer;white-space:nowrap}
.npr-selection-bar button:hover{background:var(--npr-hover)}
.npr-selection-bar button.is-primary{color:var(--npr-accent-strong);font-weight:600}
.npr-menu{position:absolute;top:36px;right:0;min-width:210px;padding:5px;background:var(--npr-surface);border:.5px solid var(--npr-border-strong);border-radius:10px;box-shadow:var(--npr-elevation);z-index:20;display:flex;flex-direction:column}
.npr-menu button{display:flex;align-items:center;gap:9px;padding:7px 10px;font:inherit;font-size:13px;text-align:left;color:var(--npr-fg);background:transparent;border:0;border-radius:6px;cursor:pointer}
.npr-menu button:hover:not(:disabled){background:var(--npr-hover)}
.npr-menu button:disabled{opacity:.45;cursor:default}
.npr-menu hr{margin:5px 4px;border:0;border-top:.5px solid var(--npr-border)}
/* 语速那一行。★ 选择器必须带 .npr-menu 前缀：.npr-menu button 是 flex + 7px 内边距，
   直接写 .npr-menu-seg button 会被它压过去，四颗档位会各自撑成一整行。
   ★ 这段在模板串里，注释里不能出现反引号。 */
.npr-menu-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 10px 7px;font-size:12px;color:var(--npr-muted)}
.npr-menu .npr-menu-seg{display:flex;gap:2px;padding:2px;border-radius:6px;background:var(--npr-hover)}
.npr-menu .npr-menu-seg button{padding:2px 7px;font-size:11.5px;border-radius:4px;color:var(--npr-muted);background:transparent}
.npr-menu .npr-menu-seg button.is-on{background:var(--npr-bg);color:var(--npr-fg);font-weight:600}
/* 朗读声音那一行（0.54.0）。与「朗读语速」**同一种形态**（标签左、控件右）：
   同一个菜单里两行控件，一行上下叠、一行左右排，会被读成「两种东西」。
   ★ 标签不许被压：下拉的固有宽度由最长那个 option 决定，标签若参与压缩，
     「朗读声音」会被折成两行。
   ★ 试听按钮要压住 .npr-menu button 那条基础样式（flex + 7px 内边距），
     所以选择器带 .npr-menu 前缀（特异度 0,2,0 > 0,1,1）。
   ★ 这段在模板串里，注释里不能出现反引号。 */
.npr-menu-label{flex:0 0 auto;white-space:nowrap}
.npr-menu-pick{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:1 1 auto;min-width:0}
.npr-menu .npr-menu-select{flex:1 1 auto;min-width:0;height:26px;padding:0 6px;font:inherit;font-size:11.5px;color:var(--npr-fg);background:var(--npr-bg);border:.5px solid var(--npr-border-strong);border-radius:6px}
.npr-menu .npr-menu-test{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 9px;font:inherit;font-size:11.5px;color:var(--npr-fg);background:var(--npr-hover);border:0;border-radius:6px;cursor:pointer}
.npr-menu .npr-menu-test:hover:not(:disabled){background:var(--npr-border)}
.npr-menu .npr-menu-test:disabled{opacity:.45;cursor:default}
.npr-menu-hint{font-size:11px;line-height:1.5;color:var(--npr-faint)}
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
.npr-reading-setting-check .npr-switch{grid-column:2;justify-self:start}
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
@container (max-width:700px){.npr-layout{grid-template-columns:clamp(var(--npr-sidebar-min),42cqw,300px) 1px minmax(0,1fr)}.npr-article{padding:20px 18px 70px}.npr-actions{margin-left:0}.npr-reading-settings{position:fixed;right:12px;top:70px}.npr-entry-thumb{width:44px;height:44px}.npr-root button.npr-entry{padding:10px 10px 10px 18px}.npr-reader-toolbar{gap:2px;padding:4px}.npr-root .npr-icon{width:28px;height:28px;padding:5px}
/* ★ 侧边栏在窄面板里要**自己收**（0.45.1）。原来这条是 min(240px,42cqw) —— 没有下限：
   面板 500px 时 42cqw = 210px，而工具栏那一行的固定项就要 238px（三档视图开关 88 +
   频道按钮 46 + 四颗图标 112 + 间距 10 + 内边距 20），于是最右那颗设置齿轮被裁掉半个、
   筛选条「已隐藏 1」的数字也被切 —— 用户 2026-10-28 的截图就是这个。
   三件事一起做：① 列宽一个下限（0.45.2 起是 --npr-sidebar-min = 256px，见 .npr-layout
   上面那段说明；0.45.1 曾用 232px，那只够「不溢出」，不够「不换行」），
   ② 工具栏在窄面板里收紧（图标 28→24、间距 2→0、右内边距 8→4），
   ③ 筛选 chip 的内边距 10→8。
   ★ 不用 @container 量侧边栏自己：.npr-sidebar 一旦设 container-type，它内部**所有**
     无名的 @container (max-width:700px) 规则会改按侧边栏宽度求值 —— 那些规则本来是
     量面板的，会集体误触发（本项目 10+ 条断点全靠无名查询）。
   ★ 这段在模板串里，注释里一个反引号都不能写。 */
.npr-root .npr-sidebar-toolbar{gap:0;padding:5px 4px 5px 10px}
.npr-root .npr-sidebar-toolbar .npr-icon{width:24px;height:24px;padding:4px}
.npr-root .npr-filters.npr-filters-primary button{padding:0 8px}}
@container (max-width:460px){.npr-layout{grid-template-columns:minmax(0,1fr)}.npr-reader{display:none}.npr-root.npr-focus .npr-reader{display:block}.npr-resize{display:none}}
@media (prefers-reduced-motion: reduce){.npr-root *,.npr-root *::before,.npr-root *::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important;scroll-behavior:auto !important}}

`;

const VERSION_LABELS = { original: '原文', translation: '译文', contrast: '对照', rewrite: '改写' };

/**
 * 阅读页三选一选项卡（0.84.1，用户 2026-11-18 要求「文章 / 字幕 / 导读」）。
 *
 * ★ id 同时是 `data-read-tab` 的取值与 CSS 选择器的一部分，判据逐项断言这三个 id
 *   与这三段中文 —— 不要改成从别处拼出来的标签。
 * ★ 只有带音频的条目才渲染：普通文章没有字幕，也没有可跳回原话的导读。
 */
const READ_TABS = Object.freeze([
  { id: 'article', label: '文章' },
  { id: 'transcript', label: '字幕' },
  { id: 'digest', label: '导读' },
]);

/**
 * 版本下拉里的**顺序**。
 *
 * ★ 「对照」排在译文之后而不是最后：它读的是译文那份数据，用户的心理顺序是
 *   「原文 → 译文 → 对照 → 改写」—— 把对照甩到改写后面，等于让一个新功能
 *   藏在另一个功能的后面。
 */
const VERSION_ORDER = ['original', 'translation', 'contrast', 'rewrite'];
const FALLBACK_READING = { ...READING_DEFAULTS };
/**
 * 侧边栏宽度下限（px）—— **必须**与 `PANEL_CSS` 里的 `--npr-sidebar-min` 是同一个数。
 *
 * 0.71.0 起数值的唯一来源在 `sidebar-width.js`（四个视图共用），这里只是转出给
 * `test/sidebar-narrow.test.mjs` 那条「CSS 变量 === JS 常数」的契约断言用。
 * CSS 那条管「面板宽度算出来的列宽」，常数管「拖动与首屏读回」—— 两条路径写岔
 * 就会出现「拖到 220 不换行、但窗口一缩就换行」这种只在一条路径上复现的怪状态。
 *
 * ★ 256 是量出来的，依据写在 `PANEL_CSS` 里那段注释（工具栏 240 / 单行 chip 244 /
 *   两位数计数 252）。
 */
export { SIDEBAR_MIN_WIDTH };

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
  // 「对照」读的也是同一份译文：漏翻的段落在对照视图里表现为**只有原文、没有中文**，
  // 同样需要一个解释，否则用户会以为对照功能坏了。
  if (active !== 'translation' && active !== 'contrast') return '';
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
 * 「这次只能整篇上下对照」的说明（0.57.0）。
 *
 * ★ 为什么必须说这一句
 * --------------------
 * 逐段交错的前提是**译文与原文结构完全相同**。2026-10-14 之前生成的译文走的是
 * 「HTML → Markdown → 模型 → Markdown」，结构早就变了，只能退成「上原文、下译文」。
 * 不说的话，用户看到一篇没有交错的文章，会以为对照功能没做出来 ——
 * 而实际上该重做的是那份旧译文（点「重新生成译文」即可）。
 *
 * @param {{mode?: string}} props `buildContrastHtml` 的 mode
 */
export function ContrastStackedNotice({ mode } = {}) {
  if (mode !== 'stacked') return null;
  return (
    <div className="npr-translation-partial" role="status">
      <Icon name="info" size={14} />
      <span>这份译文是旧格式生成的，段落结构和原文对不上，只能整篇上下对照（上面原文、下面译文）。点「重新生成译文」就会变成逐段对照。</span>
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
  /**
   * ★ 「对照」底下没有自己的产物 —— 它渲染的是译文那份数据。
   *   写成「重新生成对照」会让用户以为要点一下才会出现对照版，
   *   而真正要重建的是译文。所以这里先把视图映回它依赖的版本。
   */
  const kind = (value) => (value === 'contrast' ? 'translation' : value);
  if (generating) return `正在重新生成${VERSION_LABELS[kind(generating)]}…`;
  return `重新生成${VERSION_LABELS[kind(active)]}`;
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
 * ★ 判据本体已抽到零依赖的 menu-dismiss.js（连同两个静默失效的坑与 JSDoc）。
 *   论文页「+」菜单、阅读页「翻译」下拉都要复用它；它们若从本文件取，会绕出
 *   `ReaderPage → LibraryApp/PapersApp → BookReader/PapersApp → ReaderPage` 的环，
 *   并把本文件的 refinements.css 拖进「只渲染 BookReader」的测试 bundle。
 *
 * ★ 这里保留一次**转发导出**：`test/reader-menu-dismiss.test.mjs` 从本文件取函数
 *   真跑，接线断言也读本文件的 effect。转发不复制逻辑，判据仍只有一份。
 */
export { attachMenuDismiss } from './menu-dismiss.js';

let stylesReady = false;
/**
 * 把 `PANEL_CSS + REFINEMENTS` 注入一次。
 *
 * ★ 0.35.0 起 **导出**它：日记页的空状态借用了 `.npr-welcome*` 那一组类（版式与
 *   「阅读」页统一），而它们定义在 `PANEL_CSS` 里。如果用户直接落到日记 tab、
 *   ReaderPage 还没挂载过，那组样式就不在文档里 —— 空状态会退化成一堆无样式的文字，
 *   而且**不报错**。所以日记页自己也要保证一次注入。
 */
export function ensureStyles() {
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
   * 主视图：`feeds`（订阅）/ `library`（书）/ `diary`（日记）。
   *
   * ★★ 0.56.3 起**每次打开插件都落在订阅**，不再从 `localStorage` 恢复。
   *
   *   用户 2026-10-30：「点击这个按钮打开插件时，自动默认到 rss 阅读这个功能页」。
   *   当时他刚在看私密日记，再点侧栏那个入口，进来看到的还是日记那一屏 ——
   *   从他的角度看就是「点了这个图标，打开的不是它该有的那一页」。
   *
   *   那个图标的标签是「澄境 | Limina」，它代表**整个插件**，不是某一个功能页。
   *   点它应该看到正门，而不是上次待过的某一间屋。想接着看，进来再点一下
   *   「书」/「日记」—— 一次点击，比「打开后先找自己在哪儿」便宜。
   *
   * ★ 顺带把 `localStorage.setItem('npr.mode')` 一起删了：只写不读的键会在存储里
   *   留一个「看起来有用」的假线索，下一个人（包括我自己）会照着它写出错误推断。
   *
   * ★ 这条改过一次方向，记在这里：0.45 时写的是「逐个列出已知值」的白名单
   *   （`saved === 'library' || saved === 'diary'`），防的是三元把 `'diary'` 静默吞成
   *   `'feeds'`。现在整条恢复逻辑都没了，那个坑也就不存在了 —— 别再照着旧注释
   *   把恢复加回来。
   */
  const [mode, setMode] = useState('feeds');
  const [channels, setChannels] = useState([]);
  const [channel, setChannel] = useState(() => localStorage.getItem('npr.channel') || 'feeds:all');
  /* 筛选 / 搜索词按**频道**记（0.44.9）。首帧就取回来，否则打开面板会先按「全部」
   * 发一次请求、再被恢复的筛选覆盖成第二次请求 —— 用户看到列表闪一下。 */
  const boot = initialBrowseState();
  const [filter, setFilter] = useState(boot.filter);
  const [query, setQuery] = useState(boot.query);
  const [searchOpen, setSearchOpen] = useState(boot.query !== '');
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
  /** 灵感浮层（`L` 键）。挂在 ReaderPage 而不是日记页：订阅与书架两种阅读场景共用一份。 */
  const [quickOpen, setQuickOpen] = useState(false);
  /**
   * 按 `L` 那一刻**正文里的选区**（已经转成 `> 引用` 块，空串 = 没选）。
   *
   * ★ 必须在打开浮层（`setQuickOpen`）之前快照：textarea 一拿到焦点，浏览器就把正文的
   *   选区折叠掉，`captureSelection` 随即把 `passage` 清成 `null`。等浮层渲染时再读，
   *   十次有十次已经空了。
   * ★ 存成字符串而不是存整个 `passage`：浮层只需要正文，不需要那条 passage 的
   *   `articleKey` / `quoteId`（那是「摘录」链路要的，两件事别混）。
   */
  const [quickSeed, setQuickSeed] = useState('');
  /**
   * 书架正在读的那本书 / 第几页 / 第几章 —— 灵感速记用它写 `meta`（「灵感流转」）。
   *
   * ★ 由 `LibraryApp` 上报、离开书架时由它清空（见那边的两条 effect）。
   *   在这里自己从 `localStorage` 之类的地方推是推不出来的：章节只有阅读器知道。
   */
  const [readingCtx, setReadingCtx] = useState(null);
  /**
   * 「带着某本书进日记」的一次性意图（阅读页「读完」那一行右边点「写读后感」）。
   *
   * ★ 为什么状态放在这一层：切 tab 的权力只在这里（`mode`）。书架与日记都只是
   *   它的子视图，谁都不能把另一个子视图挂上去。
   * ★ 对象里带 `at`：目前 `DiaryApp` 每次切回来都会**重新挂载**，所以严格说不需要它；
   *   留着是因为将来若把日记改成常驻（不卸载），只比 `bookId` 的话「同一本书再点
   *   一次」是一个相同的值 ⇒ effect 不跑 ⇒ 点了没反应，而且不会有任何报错。
   */
  const [diaryIntent, setDiaryIntent] = useState(null);
  /**
   * 「写读后感」——入口只有一处：阅读页「读完」那一行（0.44.3 起）。
   *
   * ★ 阅读器顶部的胶囊里**没有**这颗按钮（用户 2026-10-28 明确要求删掉）：写读后感
   *   是「这本书读完了」的后续动作，属于读完那个名单，不属于「正在读的这本书」。
   * ★ **先记意图、再切视图**：反过来的话 `DiaryApp` 挂载那一刻 `intent` 还是
   *   `null`，它会落在默认的灵感模块上；而那条 effect 的依赖是 `intent?.bookId`，
   *   挂载后不会再变 ⇒ 用户点了「写读后感」却停在灵感速记，且没有任何提示。
   * ★ 只往上传 id / 书名 / 后缀三样：书名是给 `DiaryApp` 在书单被截断（2634 本）
   *   时拼一个最小 book 对象用的，不是用来在书单里找它。
   */
  const writeReflection = (book) => {
    if (!book?.id) return;
    setDiaryIntent({
      module: 'reflection',
      bookId: book.id,
      bookTitle: book.title ?? '',
      ext: book.ext ?? '',
      at: Date.now(),
    });
    setMode('diary');
  };
  /**
   * 「带着一本书进书架」的一次性意图 —— 日记页点「挂在书上」的那一行走过来。
   *
   * ★ 方向与 `writeReflection` 相反，理由同一条：切视图的权力只在 `mode` 这一层。
   * ★ 带 `page`：用户点的是「我在这本书第 19 页记的那条灵感」，落在一本书的第 1 页
   *   等于没有回到现场。阅读器用 `initialPage` 落位，**不改这本书的进度**。
   * ★ 带 `at`：同一本书再点一次也要重新定位（值相同的话 effect 不跑，点了没反应）。
   */
  const [libraryIntent, setLibraryIntent] = useState(null);
  const openBookFromDiary = ({ bookId, page }) => {
    if (!bookId) return;
    setLibraryIntent({ bookId, page: Number.isInteger(page) ? page : null, at: Date.now() });
    setMode('library');
  };
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
  /**
   * 列表行的右键菜单（0.45.4）。
   *
   * `{ key, left, top }`：`key` 是哪一篇，`left/top` 是**已经夹进视口**的坐标
   * （算法在 `row-menu.js` 的 `placeRowMenu` 里，可被真跑）。
   *
   * ★ 不存整条 entry：列表会刷新（标记已读、隐藏、加载更早），存下来的那份就成了
   *   陈旧副本 —— 隐藏之后菜单里的「隐藏/恢复」会按旧值渲染。需要时从
   *   `page.entries` 现取，取不到就整张菜单不渲染（那篇已被筛掉了）。
   */
  const [rowMenu, setRowMenu] = useState(null);
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
  /* ★ 首屏读回也要夹（0.45.2）：老用户的 localStorage 里存着 220（旧拖动下限），
     不夹的话「一打开就是换行 + 齿轮被裁」，而用户根本没拖过 —— 那是最难自查的一类。 */
  // 四个视图共用一个默认值与一个 key；旧 RSS key 的迁移在 readSidebarWidth() 里。
  const [listWidth, setListWidth] = useState(readSidebarWidth);
  const [askContext, setAskContext] = useState(null);
  const activeChannelRef = useRef(channel);
  activeChannelRef.current = channel;
  /**
   * `reading` 的镜像。
   *
   * ★ 必须走 ref：`openArticle` 是 async 的，`shouldAutoTranslate` 在
   *   `await api.getArticle()` **之后**才读这个开关。若直接读闭包里的 `reading`，
   *   拿到的是「点开这篇那一刻」的旧值 —— 用户刚改过默认版本时按旧值判断，
   *   自动翻译可能**不按最新设置触发**，且没有任何报错（开关看着是开的）。
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
  /** 选中文本后浮在选区上方的那条操作栏：`{ top, left }`；`null` = 不显示。 */
  const [selectionBar, setSelectionBar] = useState(null);
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

  useEffect(() => { setPassage(null); setSelectionBar(null); }, [selected?.article?.key]);
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
  /** 上一次「已同步过浏览状态」的频道（`channel` 变了才去读 localStorage）。 */
  const browseSync = useRef('');
  /**
   * 列表里**现在摆着的是哪个频道**的文章。
   *
   * ★ 只用来回答一件事：这次 effect 是「换频道」还是「换筛选 / 搜索词」。
   *   前者必须清空（否则会短暂显示另一个源的文章），后者**不许清空** ——
   *   用户 2026-11-11：「点击『全部』『未读』…… 切换的时候，会闪一下。」
   *   闪的就是这条 effect 里的 `setPage({ entries: [] })`，见下面那段注释。
   */
  const listedChannel = useRef('');
  /** 待还原的列表滚动位置；`null` = 没有待还原的。 */
  const pendingListScroll = useRef(null);
  /** 列表容器本身（记滚动位置）。 */
  const listRef = useRef();
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

  /**
   * 底部一条提示。
   *
   * @param {string} message
   * @param {boolean} [isError]
   * @param {{label: string, onClick: () => void} | Array<{label: string, onClick: () => void}>} [action]
   *   挂按钮（撤销 / 查看）。**可以是数组**（0.72.0）：灵感速记的回执同时给
   *   「撤销」和「去看看」，只有一颗时用户要么撤销要么去看，做不了第二个。
   *
   * ★ 带按钮的提示**要活得更久**（8s vs 2.4s）：2400ms 是「扫一眼就走」的时长，
   *   而「撤销」要求用户读完那句话之后再做一个决定 —— 按原时长，按钮在他找到
   *   鼠标之前就消失了，等于没给撤销。多一颗按钮不延长时长：8s 已经够读完一句话。
   */
  const notify = (message, isError = false, action) => {
    setToast({ message, isError, action });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), isError ? 4200 : action ? 8000 : 2400);
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
        // ★ 追加页也要带上它：漏了的话「加载更早文章」之后「已隐藏 N」的入口会
        //   在界面上凭空消失（`undefined > 0` 为 false），而文章其实还藏着。
        hiddenCount: data.hiddenCount,
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
    /*
     * ★ 换频道 vs 换筛选 —— 两者的「旧列表还能不能留」是相反的。
     *
     * 这里原来不分情况，一律 `setPage({ entries: [] })` 再请求。换筛选时那一帧
     * 就是用户 2026-11-11 说的「闪一下」：列表整块消失 → 「正在加载…」→ 新列表，
     * 三帧里换两次内容。顺着它还带走了两样东西 ——
     *   ① 列表滚动位置归零（内容回来时从顶上开始）；
     *   ② `page.hiddenCount` 变 `undefined` ⇒ `hiddenCount > 0` 为 false ⇒
     *      「已隐藏 N」那颗 chip 消失，底座里从 4 颗变 3 颗、等分宽度重算，
     *      整排 chip 左右跳一下，再随数据回来跳回去 —— 这一下比列表更晃眼。
     *
     * 换筛选 / 换搜索词是**同一批数据的另一种取法**，旧条目在被替换前仍然可用
     * （本地宿主通常几十毫秒就回），保留它只是「内容原地替换」，不会亮出一块空白。
     * 换频道才是「换一整个世界」，那一条继续清空。
     */
    if (listedChannel.current !== channel) {
      listedChannel.current = channel;
      setPage({ entries: [], hasMore: false, nextCursor: undefined });
    }
    /* 切到一个新频道时，先把**这个源自己**的筛选 / 搜索词装回去。
     *
     * ★ 恢复完立刻 `return`，这一轮**不发请求**：`setFilter` 是异步的，此刻
     *   `loadPage` 里读到的还是旧值 —— 发了就是「用 A 源的筛选去查 B 源」，
     *   再被下一轮用正确的值覆盖成第二次请求（列表闪一下、白跑一趟）。
     *   下一轮渲染时值已经变了，effect 自然重跑，只发一次。
     * ★ 值没变时（比如这个源上次就停在「全部」）直接往下走，不多一轮。 */
    if (browseSync.current !== channel) {
      browseSync.current = channel;
      const saved = readChannelState(channel, localStorage);
      if (saved.filter !== filter || saved.query !== query) {
        setFilter(saved.filter);
        setQuery(saved.query);
        setSearchOpen(saved.query !== '');
        return;
      }
      // 列表滚动位置等这一页渲染完再还原（`pendingListScroll` 由下面的 effect 消费）
      pendingListScroll.current = saved.scroll;
    }
    saveChannelState(channel, { filter, query }, localStorage);
    void loadPage(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, filter, query]);

  /* 列表滚动位置，按频道记（0.44.9）。
   *
   * ★ 这里存**像素**，正文那侧存**比例** —— 不是不一致，是两处的变化源不同：
   *   正文字号 / 版心宽度可调、窗口宽度会变，同一个段落落在完全不同的 scrollTop 上，
   *   只能存比例；而列表的行高由固定的字号和两行截断决定，同一个源的行布局稳定，
   *   像素更准（比例会把「滚到第 12 条」换算成第 11.4 条）。
   * ★ 还原时机是「这一页渲染完」而不是「请求返回」：请求返回时 DOM 里还是上一批条目，
   *   此刻设 scrollTop 会被随后的渲染重置成 0。 */
  useEffect(() => {
    if (pendingListScroll.current === null) return;
    const list = listRef.current;
    if (!list || page.entries.length === 0) return;
    list.scrollTop = pendingListScroll.current;
    pendingListScroll.current = null;
  }, [page.entries]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    let timer = 0;
    const flush = () => {
      timer = 0;
      // 还有待还原的位置时**不写**：这一刻的 scrollTop 是「列表刚被清空」的 0，
      // 写下去就把用户上次的位置抹了（下一次进来永远在顶上）。
      if (pendingListScroll.current !== null) return;
      saveChannelState(channel, { scroll: list.scrollTop }, localStorage);
    };
    const onScroll = () => { if (timer === 0) timer = setTimeout(flush, 300); };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      list.removeEventListener('scroll', onScroll);
      // 切频道前把最后一次滚动落下来：cleanup 里捕获的 `channel` 正是**旧**频道。
      if (timer !== 0) { clearTimeout(timer); flush(); }
    };
  }, [channel]);

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
    // ★ 打开即回顶（0.84.5），不恢复上次读到的位置。放在 setSelected 之后：
    //   早一步滚的是上一篇的旧 scroller，新正文一渲染又停在中间。
    rootRef.current?.querySelector('.npr-reader')?.scrollTo?.({ top: 0 });
    if (shouldAutoTranslate(readingRef.current, data)) void autoTranslate(key, request);
    if (data.article?.read === false) {
      void api.setRead([key], true).catch(e => notify(e.message, true));
      setPage((previous) => ({ ...previous, entries: previous.entries.map((entry) => (entry.key === key ? { ...entry, read: true } : entry)) }));
    }
  };

  /**
   * 日记页点「挂在文章上」的那一行 → 打开那一篇。
   *
   * ★ **先 `openArticle` 再切视图**：`openArticle` 只写自己的状态、不依赖订阅视图
   *   已经挂载（它不碰 DOM，除了 `rootRef` 上那次可选的滚动）。反过来的话，切过去
   *   会先闪一下上一篇 —— 用户点的是一篇，看到的是另一篇。
   * ★ 定义在 `openArticle` 之后，而不是跟 `openBookFromDiary` 放在一起：`const` 在
   *   初始化之前是死区，放在前面只能靠「反正点击时已经初始化了」这种巧合过关。
   */
  const openArticleFromDiary = (key) => {
    if (!key) return;
    void openArticle(key);
    setMode('feeds');
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
   * 隐藏一篇（可撤销）。
   *
   * ★ 为什么叫「隐藏」而不是「删除」：那条文章是**源站的内容**，删了下次刷新会自己
   *   回来 —— 用户看到刚清掉的文章又出现在列表里，只会觉得这个按钮没生效。真正
   *   能删的只有本地的正文缓存，而删缓存换来的是「再打开要重抓」。所以语义定成
   *   「我不再想看到它」，落在宿主的 `hidden` 里，列表和搜索都不再返回。
   * ★ 撤销用 `notify` 上那颗按钮，而不是弹确认框：确认框挡在**动作之前**，
   *   每次都多一次点击；撤销放在动作之后，只在真的点错时才付出成本。
   * ★ 恢复的兜底入口是「已隐藏」筛选 —— 提示条 8 秒后消失，用户十分钟后才后悔
   *   也得找得回来。只给 toast 的撤销等于没给。
   */
  const hideArticle = async (key) => {
    if (!key) return;
    const result = await run(api.setHidden(key, true), { errorPrefix: '隐藏失败' });
    if (!result || result.hidden !== true) return;
    setPage((previous) => ({
      ...previous,
      entries: previous.entries.filter((entry) => entry.key !== key),
      hiddenCount: (previous.hiddenCount ?? 0) + 1,
    }));
    // 正在读的就是这篇 ⇒ 清掉右侧，否则列表里已经没有它、阅读区还开着 ——
    // 再点「上一篇 / 下一篇」会从一个不存在的起点算起。
    if (selected?.article?.key === key) { setSelected(undefined); setPassage(null); }
    notify('已隐藏这篇文章', false, { label: '撤销', onClick: () => void unhideArticle(key) });
  };

  /** 撤销隐藏。重新拉一页而不是本地插回去：插回去要自己算它该排在第几篇。 */
  const unhideArticle = async (key) => {
    if (!key) return;
    const result = await run(api.setHidden(key, false), { errorPrefix: '恢复失败' });
    if (!result || result.hidden !== false) return;
    await loadPage(undefined, true);
    notify('已恢复这篇文章');
  };

  /**
   * 列表行的右键菜单：**对着某一篇**弹在鼠标处（0.45.4，用户要求）。
   *
   * ★ 为什么是右键而不是每行一颗「…」：侧栏只有 256–320px，每行再加一个常驻控件
   *   会把标题挤到 130px 以下（0.45.3 刚为封面位量过这个数）；而悬停才出现的按钮
   *   与右键**在发现成本上是一回事**，后者还不动版式。用户在三个选项里选了右键。
   * ★ `preventDefault` 是必须的：宿主是一个 Electron 页面，不拦掉会弹出系统菜单
   *   （「重新加载 / 检查元素 / 打印整个窗口」），两层菜单同时出现。
   * ★ 坐标先夹进视口（`placeRowMenu`）：右键可能落在列表最后一行、贴着窗口右下角，
   *   不夹的话菜单有一半在窗口外 —— 而它不会报错，只是「点不到」。
   */
  const openRowMenuAt = (x, y, entry) => {
    if (!entry?.key) return;
    const spot = placeRowMenu({
      x, y,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    });
    setRowMenu({ key: entry.key, left: spot.left, top: spot.top });
  };
  const openRowMenu = (event, entry) => {
    event.preventDefault();
    event.stopPropagation();
    openRowMenuAt(event.clientX, event.clientY, entry);
  };

  /**
   * 执行右键菜单里的一项。
   *
   * ★ 打印 / 导出**不先把文章打开**（那是 `openArticle` 干的活，它会顺手把这篇标成
   *   已读）。这里只 `getArticle` 取正文：用户在列表里右键一篇没读过的文章导出
   *   Markdown，不该因此把它变成已读 —— 那是两件事。
   * ★ 版本取 `reading.defaultVersion`，与 `openArticle` 同一条规则：导出 / 打印的是
   *   「你下次打开它会看到的那一版」，不是写死的原文。
   * ★ 隐藏走 `hideArticle`（带撤销 toast、并从当前页摘掉），不另写一份：同一个动作
   *   两处实现，行为迟早会漂。
   */
  const runRowAction = async (kind, key) => {
    setRowMenu(null);
    if (!key) return;
    if (kind === 'hide') { await hideArticle(key); return; }
    if (kind === 'unhide') { await unhideArticle(key); return; }
    const data = await run(api.getArticle(key), { errorPrefix: '读取正文失败' });
    if (!data?.article) return;
    const version = resolveReadingVersion(reading.defaultVersion, data);
    const html = readerBodyHtml({
      active: version,
      articleHtml: data.html,
      version: data.versions?.[version],
      baseUrl: data.article?.url,
    });
    const title = readerTitle({ active: version, versions: data.versions, article: data.article });
    if (kind === 'print') {
      try {
        printArticle({ title, url: data.article?.url, version: VERSION_LABELS[version], html });
      } catch (error) {
        notify(`打印失败：${error?.message ?? String(error)}`, true);
      }
      return;
    }
    try {
      downloadText(markdownFileName(title, data.article?.publishedAt), articleToMarkdown({
        title,
        url: data.article?.url,
        author: data.article?.author,
        publishedAt: data.article?.publishedAt,
        version: VERSION_LABELS[version],
        html,
      }));
      notify('已导出 Markdown');
    } catch (error) {
      notify(`导出失败：${error?.message ?? String(error)}`, true);
    }
  };

  /**
   * 右键菜单的关闭：点外面、按 Esc、滚动、改窗口大小。
   *
   * ★ 四条都要有，缺一条就是一个「关不掉的浮层」：
   *   · 点外面 —— 菜单挂在列表旁边而不是 modal 里，没有遮罩层替它接这一下；
   *   · Esc —— 键盘用户唯一的退路（右键菜单本来就不是键盘可达的，所以下面
   *     还补了 Shift+F10 / 菜单键，见行上的 `onKeyDown`）；
   *   · 滚动 —— 菜单是 `position: fixed`，列表滚走之后它会**浮在别的文章上**，
   *     而它上面写着的还是原来那一篇；
   *   · resize —— 夹取算的是按下那一刻的视口。
   * ★ 用 `pointerdown` 而不是 `click`：在别处按下时就该收，等到 click 会先让
   *   那一次点击落到下面的元素上（右键另一行时尤其明显）。
   */
  useEffect(() => {
    if (!rowMenu) return undefined;
    const close = () => setRowMenu(null);
    const onPointerDown = (event) => {
      if (event.target?.closest?.('.npr-rowmenu')) return;
      close();
    };
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [rowMenu]);

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
      /* 夹取与持久化都走共用模块（0.71.0）：下限仍是量出来的 256，
         上限 520；原来写死 220 会让用户把自己拖进「chip 换行 + 齿轮被裁」。 */
      width = clampSidebarWidth(startX === 0 ? SIDEBAR_WIDTH : (listWidth + moveEvent.clientX - startX));
      setListWidth(width);
    };
    const up = () => {
      saveSidebarWidth(width);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => {
    // 非订阅视图里这些快捷键不该生效：j/k 在书里是翻页、在日记里是「切到上/下一天」，
    // 让它们同时响应两套语义，用户会看到列表在他看不见的地方被选中。
    if (mode !== 'feeds') return undefined;
    const onKey = (event) => {
      if (dialog || pickerOpen || askContext || appearanceOpen || menuOpen || rowMenu || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (event.key === 'j' || event.key === 'k') { event.preventDefault(); navigate(event.key === 'j' ? 1 : -1); }
      else if (event.key === '[' || event.key === 'f') { event.preventDefault(); setFocused((current) => !current); }
      else if (event.key === '/') { event.preventDefault(); setSearchOpen(true); setTimeout(() => searchInput.current?.focus(), 0); }
      else if (event.key === 'Escape') { setFocused(false); setSearchOpen(false); setQuery(''); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog, pickerOpen, askContext, appearanceOpen, menuOpen, rowMenu, page.entries, selected?.article?.key, mode]);

  /**
   * `L` = 灵感速记浮层（2026-10-26，用户明确要的「读 RSS 或电子书时随时按 L」）。
   *
   * ★ **独立于上面那个快捷键 effect**：那一条在 `mode !== 'feeds'` 时直接返回，
   *   而 `L` 在书架里也要能用。合在一起写会让「书里按 L 没反应」变成一个只有
   *   真机才发现的洞。
   * ★ 书架里也不交给 `readerCommand`：那个函数是「书页的翻页/缩放」表，
   *   把 `l` 加进去会顺带 `preventDefault()`，而这里要的正是让它继续冒泡到 window。
   * ★ 日记页不响应：那儿本来就有一个输入框，再弹一层浮层只会挡住它。
   * ★ 任何弹层打开时都不响应：用户正在跟那个弹层交互，突然多一层盖上来 = 丢失输入。
   */
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'l' && event.key !== 'L') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (mode === 'diary') return;
      if (dialog || pickerOpen || askContext || appearanceOpen || menuOpen || rowMenu || addMenu || showAddFeed) return;
      if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      event.preventDefault();
      // 有选区就把这段正文带进浮层（0.72.0 P1）。分工见 `seedBlock` 的注释：
      // 「摘录到灵感」= 不编辑直接存；`L` = 带进来接着写。
      setQuickSeed(seedBlock(passage?.quote));
      setQuickOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, dialog, pickerOpen, askContext, appearanceOpen, menuOpen, rowMenu, addMenu, showAddFeed]);

  // 书架被设置关掉时强制回订阅。
  // ★ 关掉书架必须**同时**把用户从书架里请出去：只把入口按钮藏掉的话，
  //   用户在设置里关掉书架的那一刻会停在一个再也切不回去的视图里。
  // ★ 这里不再往 localStorage 写 `npr.mode`（0.56.3）：初值恒为 `feeds`，
  //   写下去也没人读，见 `useState('feeds')` 那一段。
  useEffect(() => {
    if (reading.bookshelf === false && mode === 'library') { setMode('feeds'); return; }
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
   *   右侧是「只读你选的，读懂每一篇」那张欢迎页，列表里没有任何一行被选中。
   *
   *   `selected` 挂在 ReaderPage 上（不是订阅页那棵子树），所以切走再回来它**还在** ——
   *   这才是「自动选中第一条」的真身；恢复上次阅读只发生在面板挂载，与此无关。
   *
   *   下面的模式守卫用「先复位专注、不是书架就返回」的写法，是为了让复位专注那一行
   *   保持独立可读（`test/reader-focus-scope.test.mjs` 逐字守着它）。
   */
  useEffect(() => {
    if (mode === 'library') setFocused(false);
    // ★ 日记页同样要复位（2026-10-26）。它也不带订阅那一列，专注状态留着只有一个后果：
    //   从日记切回订阅时莫名「专注」一次。★ 这一行必须**另起**，不能并进上面那条 ——
    //   `test/reader-focus-scope.test.mjs` 逐字守着 `if (mode === 'library') setFocused(false)`
    //   那一句（并进去会让它红，而它守的正是「书架页的书单被藏掉」那次真机事故）。
    if (mode === 'diary') setFocused(false);
    // ★ 论文页同理（2026-11-06）。它也不带订阅那一列，专注状态留着只会让
    //   「从论文切回订阅」时莫名专注一次。
    if (mode === 'paper') setFocused(false);
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
  /**
   * 「对照」是**派生视图**，没有自己的产物：译文不在了（换文章、被清缓存、
   * 上次读的这篇本来就没译过），它就必须当场退回原文 —— 否则版本下拉里
   * 那个值会落在一个不存在的选项上（React 报 value 不匹配，界面显示空白）。
   */
  const translationReady = contrastReadable(versions);
  const remembered = activeArticle?.active ?? 'original';
  const active = remembered === 'contrast' && !translationReady ? 'original' : remembered;
  /** 「更多操作」里三条与版本相关的条目的可见性。策略在 `menuItemVisibility` 里（可测）。 */
  const menuItems = menuItemVisibility({ active });
  const audioUrl = articleAudioUrl(activeArticle?.article);
  /**
   * 单集字幕（P0）。
   *
   * ★ 只有**带音频的条目**才去取字幕：播客的 `<podcast:transcript>` 与音频是一对，
   *   而普通文章没有音频，取字幕只会白跑一次请求。
   * ★ `transcriptRequest` 是「作废票」：用户连着点两集时，先发的那次请求可能后回来，
   *   回来时 `activeArticle` 已经换了。不判票号的话，界面会把**上一集**的字幕挂到
   *   这一集下面 —— 而且看起来完全正常（都是英文、都有时间戳）。
   * ★ 接口缺失（旧宿主）时落到 `empty`，面板会说「这期没有字幕」，不会一直转圈。
   */
  const audioKey = audioUrl ? activeArticle?.article?.key ?? '' : '';
  const [audioController, setAudioController] = useState(null);
  const [transcript, setTranscript] = useState({ status: 'idle', data: null, error: '' });
  const transcriptRequest = useRef(0);
  /**
   * 字幕中文层（P0 的翻译）。
   *
   * ★ `translations` 是**与 paragraphs 等长**的字符串数组，空串表示「这段还没译」。
   *   不另存「已译集合」：两套结构一定会漂移，而漂移的表现是「某几段永远显示英文」
   *   —— 用户会以为是模型漏翻。
   * ★ `translationTicket` 与 `transcriptRequest` 是两个票号，别合并：换集时字幕
   *   可能要重抓，而翻译可能正在跑；一个票号管两件事，切集时必然有一边作废不了。
   */
  const [translation, setTranslation] = useState({ status: 'idle', translations: [], total: 0, done: false, error: '' });
  const translationTicket = useRef(0);
  /**
   * 本机识别（0.82.0）：订阅源没字幕时，用本机模型把音频转成字幕。
   *
   * ★ 状态放在这一层而不是面板里：面板会随「收听视图」开关**卸载**（`listenMode`
   *   为 false 时它不在树上）。识别一集要几分钟，状态跟着面板一起没了的话，
   *   用户切回文章再切回来，进度就归零 —— 而后台其实还在跑。
   * ★ `asrTicket` 与另外两个票号分开：「换集」要作废识别轮询，但字幕抓取与翻译
   *   各有可能正在跑；共用票号会让换集时只作废其中一件。
   */
  const [asr, setAsr] = useState({
    status: 'idle', progress: 0, stage: '', done: 0, total: 0, segments: 0, error: '', preview: [], sizeMb: 0,
    /**
     * 环境探测结果（缺哪一件）。`undefined` = 还没问过，与「问过、都不缺」要分开：
     * 前者不能显示「都就绪」，后者不该显示「检查中」。
     */
    missing: undefined,
  });
  const asrTicket = useRef(0);
  /**
   * AI 导读（0.84.0）。
   *
   * ★ 「读缓存」与「生成」是**两条独立的路**（`episodeDigest(key, false, false)` /
   *   进收听视图时只读缓存，绝不顺手生成 —— 否则用户只是切过去听个响，就白花一次
   *   模型调用，而他并没有点任何按钮。
   * ★ `focus` 是「跳到第几秒」的**令牌**（带自增 token）：同一个时间戳连点两次也要
   *   重新滚一次，只传秒数的话第二次点击 props 没变、effect 不跑，看起来像「点了没反应」。
   */
  const [digest, setDigest] = useState({ status: 'idle', data: null, error: '', cached: false });
  const digestTicket = useRef(0);
  const [focus, setFocus] = useState({ at: 0, token: 0 });
  /**
   * 「双语」是**播放条与字幕面板共用**的一个开关，所以状态必须放在这一层。
   *
   * ★ 两边各存一份的结果是可预见的：播放条按下去，面板里还是英文，用户会以为
   *   那个按钮没生效（而它其实生效了，只是作用在另一个地方）。
   * ★ 译完自动开一次（`autoZh`）：用户点「译成中文」的意图就是「我想看中文」，
   *   译好了还要再点一次「显示中文」是多余的一步。但只自动开一次 —— 他手动
   *   关掉之后，下一次分批回来不该再把他推回去。
   */
  const [langMode, setLangMode] = useState('source');
  const autoZh = useRef(false);
  const zhReady = translatedCount(translation.translations);
  useEffect(() => {
    if (zhReady > 0 && !autoZh.current) {
      autoZh.current = true;
      // 译完自动进「双语」：用户点「译成中文」是想听懂，不是想把原文藏起来。
      // 只推一次 —— 他手动切回「原文」之后，下一批译文回来不该再把他推回去。
      setLangMode((mode) => (mode === 'source' ? 'both' : mode));
    }
    if (zhReady === 0) autoZh.current = false;
  }, [zhReady]);
  const cycleLang = useCallback(() => setLangMode((mode) => nextLang(mode)), []);
  /**
   * 「收听视图」开关（0.81.0）。
   *
   * ★ 为什么字幕要**离开正文那一页**：一集 120 段字幕常驻在文章里，等于把正文
   *   挤到屏幕外 —— 「读」和「听」是两种任务，同时摆在一条竖排里谁都不好用。
   *   参考 SubCast 的单集页：标题 + 播放器 + 一屏字幕，正文另有一页。
   * ★ 实现上**不卸载播放器**：`<audio>` 一旦卸载就等于换了一个播放器，位置回到
   *   0 秒、正在听的那一段也就丢了。所以播放条留在文章容器里的固定位置，切视图
   *   只给容器加 `data-listen` / `data-read-tab`，让 CSS 把该隐的隐掉；
   *   `audio` 元素从头到尾是同一个。
   * ★ 0.84.1 起是**三态互斥**：文章 / 字幕 / 导读。`data-listen` 仍表示「不在文章视图」
   *   （正文要不要隐），`data-read-tab` 决定字幕与导读哪一块可见 —— 两者必须从**同一个**
   *   状态派生，各存一份就会漂出「正文藏了、两块面板也全藏」的空白页。
   */
  const [readTab, setReadTab] = useState('article');
  const listenMode = readTab !== 'article';

  const loadTranscript = useCallback(async ({ refresh = false } = {}) => {
    if (audioKey === '') {
      setTranscript({ status: 'idle', data: null, error: '' });
      return;
    }
    if (typeof api?.getTranscript !== 'function') {
      setTranscript({ status: 'empty', data: null, error: '' });
      return;
    }
    transcriptRequest.current += 1;
    const ticket = transcriptRequest.current;
    setTranscript((previous) => ({ status: 'loading', data: previous.data, error: '' }));
    try {
      const result = await api.getTranscript(audioKey, refresh);
      if (ticket !== transcriptRequest.current) return;
      const data = result?.transcript ?? null;
      setTranscript(data ? { status: 'ready', data, error: '' } : { status: 'empty', data: null, error: '' });
    } catch (error) {
      if (ticket !== transcriptRequest.current) return;
      setTranscript({ status: 'error', data: null, error: error?.message ?? String(error) });
    }
  }, [api, audioKey]);

  /**
   * 出现「这期没有字幕」时顺手探一次本机环境（0.82.0）。
   *
   * ★ 为什么不是挂载时就探：探测要遍历 PATH 与几个目录，属冷启动开销。只有真的
   *   撞上「没字幕」才需要知道「能不能自己识别」。
   * ★ 探到 `missing` 之后才谈得上「先补哪一步」：缺 ffmpeg 时下 181 MB 模型也
   *   没用，界面得直接说清，而不是让用户点一次按钮吃一次 409。
   */
  useEffect(() => {
    if (transcript.status !== 'empty' || audioKey === '') return undefined;
    if (typeof api?.asrStatus !== 'function') return undefined;
    let cancelled = false;
    api.asrStatus().then((status) => {
      if (cancelled) return;
      setAsr((previous) => ({
        ...previous,
        missing: Array.isArray(status?.missing) ? status.missing : [],
        /**
         * 要下载多少：qwen 那条是 1.0 GB，whisper 按选中的模型算。
         * ★ 原来只查 `catalog`（whisper 的模型表），装了 Ollama 的环境会显示
         *   「约 181 MB」—— 而实际要下的是 1 GB，用户等到一半发现体积不对。
         */
        sizeMb: status?.engineChoice === 'qwen'
          ? (status?.ollama?.recommend?.sizeMb ?? 1024)
          : (status?.catalog?.find((item) => item.id === status.defaultModel)?.sizeMb ?? 0),
        engine: status?.engineChoice ?? '',
        reason: status?.reason ?? '',
      }));
    }).catch(() => {
      // 探测失败不拦截手动开始：真正的原因会在开始时以具体文案报出来。
    });
    return () => { cancelled = true; };
  }, [api, audioKey, transcript.status]);

  /**
   * 本机识别：准备环境 → 启动 → 轮询到结束（0.82.0）。
   *
   * ★ 为什么是「轮询」而不是等一个长请求返回：一集 1–3 小时，识别要几分钟到十几分钟。
   *   做成一个 Remote 调用的话，界面在整段时间里没有任何进展，用户分不清「在跑」
   *   与「卡死」，也没法在中途停下。
   * ★ 为什么准备阶段也要轮询：模型 181 MB，在慢网络上要几分钟。`prepareAsr` 立刻
   *   返回并在后台下载，进度只能靠轮询读 `setup.progress`。
   * ★ 每轮都先查 `alive()`：换集或关面板后，已经在飞的那次请求回来不该再写状态 ——
   *   否则用户会看到「新的一集」带着「上一集 3/12 片」的进度条。
   */
  const transcribe = useCallback(async () => {
    if (audioKey === '' || typeof api?.asrStatus !== 'function') return;
    asrTicket.current += 1;
    const ticket = asrTicket.current;
    const alive = () => ticket === asrTicket.current;
    const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    try {
      let status = await api.asrStatus();
      if (!alive()) return;
      const sizeMb = status.engineChoice === 'qwen'
        ? (status.ollama?.recommend?.sizeMb ?? 1024)
        : (status.catalog?.find((item) => item.id === status.defaultModel)?.sizeMb ?? 0);
      setAsr((previous) => ({
        ...previous,
        status: 'preparing',
        progress: 0,
        stage: status.engineChoice === 'qwen' ? 'model' : 'engine',
        error: '',
        sizeMb,
        engine: status.engineChoice ?? '',
        reason: status.reason ?? '',
      }));
      if (!status.ready) {
        // ★ 引擎由宿主决定（qwen / whisper / cloud），客户端不猜：它对「这台机器
        //   装了 Ollama 还是有 ffmpeg」一无所知，猜错就会去下 1 GB 的模型。
        await api.prepareAsr(status.defaultModel || '', status.engineChoice);
        for (;;) {
          await wait(1200);
          if (!alive()) return;
          status = await api.asrStatus();
          if (!alive()) return;
          setAsr((previous) => ({
            ...previous,
            status: 'preparing',
            progress: status.setup?.progress ?? 0,
            stage: status.setup?.stage ?? '',
          }));
          if (status.setup?.status === 'ready') break;
          if (status.setup?.status === 'error') throw new Error(status.setup.error || '下载没成功');
        }
      }
      const job = await api.startTranscription(audioKey, status.defaultModel || '', status.engineChoice);
      if (!alive()) return;
      setAsr((previous) => ({
        ...previous,
        status: 'running',
        done: job.done ?? 0,
        total: job.total ?? 0,
        segments: job.segments ?? 0,
        preview: job.preview ?? [],
        engine: job.engine ?? previous.engine,
        error: '',
      }));
      for (;;) {
        await wait(1200);
        if (!alive()) return;
        const now = await api.transcriptionStatus(audioKey);
        if (!alive()) return;
        setAsr((previous) => ({
          ...previous,
          status: 'running',
          done: now.done ?? 0,
          total: now.total ?? 0,
          segments: now.segments ?? 0,
          preview: now.preview ?? [],
        }));
        if (now.status === 'done') {
          // 完成后**重读一遍字幕**（走缓存，不联网）：宿主刚落盘，这一读就把面板换成正文。
          await loadTranscript();
          return;
        }
        if (now.status === 'cancelled') {
          setAsr((previous) => ({ ...previous, status: 'cancelled' }));
          return;
        }
        if (now.status === 'error') throw new Error(now.error || '识别失败');
      }
    } catch (error) {
      if (!alive()) return;
      setAsr((previous) => ({ ...previous, status: 'error', error: error?.message ?? String(error) }));
    }
  }, [api, audioKey, loadTranscript]);

  /** 停掉识别。宿主侧停止失败也不用提示：那一轮的轮询会自己走到 `cancelled`。 */
  const cancelTranscribe = useCallback(async () => {
    if (audioKey === '' || typeof api?.cancelTranscription !== 'function') return;
    try {
      await api.cancelTranscription(audioKey);
    } catch {
      // 宿主已经结束这个任务时这里会报错，而用户要的结果（别再跑）已经达成。
    }
  }, [api, audioKey]);

  /**
   * 读一次导读缓存（**不生成**）。
   *
   * ★ 只在有字幕时调：没字幕时宿主会回 `no-transcript`，那也要显示出来（用户才知道
   *   「不是没做，是还没有字幕」），所以这里不提前 return，让宿主给结论。
   */
  const loadDigest = useCallback(async () => {
    if (audioKey === '' || typeof api?.episodeDigest !== 'function') return;
    const ticket = digestTicket.current + 1;
    digestTicket.current = ticket;
    const alive = () => ticket === digestTicket.current;
    try {
      // 第三个参数 `false` = 只读缓存，不生成。进面板时必须是这个调用。
      const result = await api.episodeDigest(audioKey, false, false);
      if (!alive()) return;
      if (result?.digest) {
        setDigest({ status: 'ready', data: result.digest, error: '', cached: result.cached === true });
        return;
      }
      const reason = result?.reason ?? '';
      if (reason === 'no-transcript') setDigest({ status: 'no-transcript', data: null, error: '', cached: false });
      else if (reason === 'too-short') setDigest({ status: 'too-short', data: null, error: '', cached: false });
      else setDigest({ status: 'idle', data: null, error: '', cached: false });
    } catch {
      // 读缓存失败不该弹错：真正需要报错的是「生成」那一步。
      if (alive()) setDigest({ status: 'idle', data: null, error: '', cached: false });
    }
  }, [api, audioKey]);

  /** 生成导读（**只有用户点按钮时才走这里**，会调用一次模型）。 */
  const generateDigest = useCallback(async () => {
    if (audioKey === '' || typeof api?.episodeDigest !== 'function') return;
    const ticket = digestTicket.current + 1;
    digestTicket.current = ticket;
    const alive = () => ticket === digestTicket.current;
    setDigest((previous) => ({ ...previous, status: 'loading', error: '' }));
    try {
      const result = await api.episodeDigest(audioKey, true, true);
      if (!alive()) return;
      if (result?.digest) {
        setDigest({ status: 'ready', data: result.digest, error: '', cached: false });
        return;
      }
      const reason = result?.reason ?? '';
      if (reason === 'no-transcript') setDigest({ status: 'no-transcript', data: null, error: '', cached: false });
      else if (reason === 'too-short') setDigest({ status: 'too-short', data: null, error: '', cached: false });
      else setDigest({ status: 'error', data: null, error: '模型没有返回内容，稍后再试', cached: false });
    } catch (error) {
      if (alive()) setDigest({ status: 'error', data: null, error: error?.message ?? String(error), cached: false });
    }
  }, [api, audioKey]);

  /**
   * 导读里点时间戳：音频跳过去，字幕滚到那一段。
   *
   * ★ 三件事必须一起做：切到字幕 tab、seek、滚动高亮。缺切页时字幕还是
   *   display:none，滚动等于没做；只 seek 不滚动，用户看不到「跳到了哪一句」；
   *   只滚动不 seek，「点时间戳」就退化成书签。`play: true` 是刻意的：点时间戳的
   *   意图是「从这句开始听」。
   */
  const jumpToTime = useCallback((seconds) => {
    // ★ 三选一 tab 之后必须切到字幕页：时间戳按钮长在导读面板里，而字幕面板
    //   在同一时刻是 display:none —— 对隐藏元素调 scrollIntoView 什么也不会发生，
    //   用户只听到声音跳了、却看不到跳到了哪一句。只 seek 不切页等于把
    //   「点时间戳跳回原话」砍掉了一半。
    setReadTab('transcript');
    audioController?.seek?.(seconds, { play: true });
    setFocus((previous) => ({ at: seconds, token: previous.token + 1 }));
  }, [audioController]);

  /**
   * 进入收听视图且拿到字幕之后，读一次导读缓存。
   *
   * ★ 依赖里只放 `transcript.status`（不放假数据对象）：前者是枚举，后者每次渲染
   *   都是新引用，会让这个 effect 每帧重发一次请求。
   */
  useEffect(() => {
    if (!listenMode || audioKey === '' || transcript.status !== 'ready') return;
    void loadDigest();
  }, [listenMode, audioKey, transcript.status, loadDigest]);

  useEffect(() => {
    // 换集时**不要**在这里 `setAudioController(null)`。
    //
    // ★ 踩过的坑（2026-11-17 实测）：React 在 commit 阶段**先跑子组件的 effect、
    //   再跑父组件的 effect**。所以「MediaDock 发布控制器 → TranscriptPanel 订阅 →
    //   父组件把它清成 null」这个顺序是必然发生的；而父组件这次写入不会再触发
    //   MediaDock 的 effect 重跑（它的依赖只有 key），于是控制器**永久是 null**。
    //   表现：字幕不跟着高亮、点段落也不跳，但播放条一切正常 —— 看起来像
    //   「字幕面板没接上时间」，实际是被自己人清掉了。
    // ★ 清理仍然有人做：`MediaDock` 卸载时（换集 / 音频地址变空）在自己的
    //   effect cleanup 里 `onController(null)`，那一次发生在**新子组件 effect 之前**，
    //   不会被谁覆盖。所有权归发布者，才不会被时序咬。
    // ★ 换集时退出收听视图：新的一集可能根本没有音频，留在收听页只会看到
    //   一个空壳（而且播放条已经换成了另一个播放器）。
    setReadTab('article');
    // 换集时作废正在跑的识别轮询，并把面板上的进度清掉。任务本身留在宿主里继续跑
    // （用户可能只是切到另一集看一眼），但这一页不能再显示上一集的「3/12 片」。
    asrTicket.current += 1;
    setAsr({ status: 'idle', progress: 0, stage: '', done: 0, total: 0, segments: 0, error: '', preview: [], sizeMb: 0 });
    // 导读同理：作废在飞的读取/生成，并清空上一集的内容（否则会看到「新的一集」
    // 顶着上一集的章节与时间戳，点下去跳到的是另一集的位置）。
    digestTicket.current += 1;
    setDigest({ status: 'idle', data: null, error: '', cached: false });
    setFocus({ at: 0, token: 0 });
    void loadTranscript();
  }, [loadTranscript]);

  /**
   * 读已经译好的字幕（纯读盘，不发模型）。
   *
   * ★ 挂载就读：用户上次译过的集子，重开应当直接是中文，而不是再点一次「译成中文」
   *   再等两分钟 —— 那样缓存等于没有。
   * ★ 接口缺失（旧宿主）时静默：用户没做错任何事，弹一个错只会让他困惑。
   */
  const loadCachedTranslation = useCallback(async () => {
    if (audioKey === '' || typeof api?.getTranscriptTranslation !== 'function') return;
    const ticket = translationTicket.current;
    try {
      const result = await api.getTranscriptTranslation(audioKey);
      if (ticket !== translationTicket.current) return;
      const texts = Array.isArray(result?.translations) ? result.translations : [];
      if (translatedCount(texts) === 0) return;
      setTranslation({
        status: 'ready',
        translations: texts,
        total: Number.isFinite(result?.total) ? result.total : texts.length,
        done: result?.done === true,
        error: '',
      });
    } catch {
      // 旧宿主没有这个方法：当作「没译过」。
    }
  }, [api, audioKey]);

  /**
   * 逐个批次翻到完。
   *
   * ★ 恒从 0 起，不记「上次翻到第几段」：宿主每批都会读盘上的译文、跳过已译段，
   *   所以「继续翻」与「从头翻」是同一条代码路径。多几次本地读盘，换来的是
   *   **没有第二种要对齐的状态** —— 那种状态一旦偏一段，中文就会整体错位。
   */
  const translate = useCallback(async () => {
    if (audioKey === '' || typeof api?.translateTranscriptBatch !== 'function') return;
    translationTicket.current += 1;
    const ticket = translationTicket.current;
    setTranslation((previous) => ({ ...previous, status: 'loading', error: '' }));
    try {
      const result = await runTranscriptTranslation({
        api,
        key: audioKey,
        start: 0,
        isCancelled: () => ticket !== translationTicket.current,
        onProgress: ({ translations, total, done }) => {
          if (ticket !== translationTicket.current) return;
          setTranslation({ status: 'loading', translations, total, done, error: '' });
        },
      });
      if (ticket !== translationTicket.current || result === null) return;
      setTranslation({ status: 'ready', translations: result.translations, total: result.total, done: result.done, error: '' });
    } catch (error) {
      if (ticket !== translationTicket.current) return;
      setTranslation((previous) => ({ ...previous, status: 'error', error: error?.message ?? String(error) }));
    }
  }, [api, audioKey]);

  useEffect(() => {
    // 作废上一集正在跑的翻译循环：它回来时会把上一集的中文挂到这一集下面。
    translationTicket.current += 1;
    setTranslation({ status: 'idle', translations: [], total: 0, done: false, error: '' });
    void loadCachedTranslation();
  }, [loadCachedTranslation]);

  const currentChannel = channels.find((item) => item.key === channel);
  // 正文 HTML 的决策在 `readerBodyHtml` 里（纯函数，可被真跑）：
  // 原文 → sanitize(article.html)；新译文 → 直接用生成时 sanitize 过的 HTML；
  // 旧译文 → sanitize(markdownToHtml(markdown))。
  /**
   * 对照视图的产物在 `buildContrastHtml` 里（纯函数，可被真跑）。
   *
   * ★ 只在**真的选了对照**时才算：别的视图不该为它多付一次 HTML 扫描。
   * ★ 译文取的是 `readerBodyHtml('translation')` —— 旧译文（只有 markdown 的那批）
   *   也走同一条路，于是「旧译文能不能逐段对照」由 `buildContrastHtml` 的**结构比对**
   *   决定（对不上就退成整篇上下），而不是在这里靠字段猜一遍 —— 猜的判据一定会漂移。
   */
  const contrast = useMemo(() => {
    if (active !== 'contrast' || !activeArticle) return null;
    const baseUrl = activeArticle.article?.url;
    return buildContrastHtml({
      articleHtml: readerBodyHtml({ active: 'original', articleHtml: activeArticle.html, baseUrl }),
      translatedHtml: readerBodyHtml({
        active: 'translation',
        articleHtml: activeArticle.html,
        version: versions?.translation,
        baseUrl,
      }),
    });
  }, [activeArticle, active, versions]);

  const bodyHtml = useMemo(() => {
    if (!activeArticle) return '';
    if (active === 'contrast') return contrast?.html ?? '';
    return readerBodyHtml({
      active,
      articleHtml: activeArticle.html,
      version: versions?.[active],
      baseUrl: activeArticle.article?.url,
    });
  }, [activeArticle, active, versions, contrast]);
  // 标题行：译文 / 改写用它们自己的中文标题（正文里的 H1 已在生成时被去掉）。
  const title = readerTitle({ active, versions, article: activeArticle?.article });

  /**
   * 导出当前这一版为 Markdown。
   *
   * ★ 导出的是**屏幕上这一版**（`bodyHtml` + `title`），不是原始 feed：用户在读译文，
   *   点「导出」却拿到英文原文，是这次操作里最容易搞错的地方。
   * ★ 文件名里的日期取 `publishedAt` 而不是「今天」：导出的是一篇有发布时间的文章，
   *   按导出时间命名会让同一篇导出两次得到两个文件，看不出哪个是新的。
   */
  const exportMarkdown = () => {
    const article = activeArticle?.article;
    if (!article) return;
    try {
      const text = articleToMarkdown({
        title,
        url: article.url,
        author: article.author,
        publishedAt: article.publishedAt,
        version: VERSION_LABELS[active],
        html: bodyHtml,
      });
      downloadText(markdownFileName(title, article.publishedAt), text);
      notify('已导出 Markdown');
    } catch (error) {
      notify(`导出失败：${error?.message ?? String(error)}`, true);
    }
  };

  /**
   * 把**选中的那一段**摘进「灵感速记」（0.44.9）。
   *
   * ★ 与「灵感速记（L）」的分工：速记记的是**你自己想的话**，摘录记的是**原文里
   *   那一段**。以前想留一句原文，只能先选中 → 唤起 AI 伴读 → 从对话里复制 → 再按 L
   *   粘一遍，四步；而且中间那一步会顺手把 AI 的回答也带进来。
   * ★ 落到**灵感**而不是新开一个「摘录」类型：`ENTRY_KINDS` 是白名单
   *   （`灵感 / 日记 / 读后感`），自造类型会被宿主**静默**改成「灵感」——
   *   而 `src/diary-format.js` 里本来就写着「金句摘录属于读后感模板的一部分，
   *   不是一种条目类型」。所以这里用 `kind: '灵感'`，靠 `source` 开头的「摘录」
   *   在标题行上区分来源（见 `excerpt.js`）。
   * ★ `meta.article` 存文章的 key：日记里那条因此能反查到是哪一篇（`normalizeMeta`
   *   白名单认这个字段，见 `src/diary-format.js`）。`source` 是**给人看**的那一行，
   *   两个都写、各管一头。
   * ★ 没选中就明说，而不是静默失败：菜单项在没选中时是条件渲染的，但程序路径
   *   仍可能走到这里 —— 点了什么都不发生是最难查的一种。
   */
  const excerptToDiary = async () => {
    const entry = excerptEntry({
      quote: passage?.quote,
      title,
      channelName: activeArticle?.article?.channelName,
      articleKey: activeArticle?.article?.key,
      date: dateKey(),
    });
    if (!entry) { notify('先在正文里选中一段文字，再摘录', true); return; }
    try {
      await appendDiaryEntry(entry);
      /* ★ 必须说清**写到了哪个模块**：日记页有三个模块，摘录进的是「灵感速记」
       *   （公开那一侧）。只说「已摘录到日记」，用户去「私密日记」里找就会看到
       *   「今天 0 条」，然后合理地认为这个功能坏了 —— 0.44.9 第一版就是这样。
       * ★ 顺手给一颗「去看看」：把「去哪儿看」从一句话变成一个动作。 */
      notify('已摘录到「灵感速记」', false, { label: '去看看', onClick: () => setMode('diary') });
    } catch (error) {
      notify(`摘录失败：${error?.message ?? String(error)}`, true);
    }
  };

  /* ---- 打开文章一律回顶（0.84.5）--------------------------------------
   * 0.44.9 起这里存过「读到哪」（`npr.pos.*`）并在下次打开时按比例滚回去。
   * 用户 2026-11-18 明确要求：每次从侧边栏点文章都从头开始 —— 点开一篇播客
   * 精读却落在上一回读到的末尾，看起来像「打开错了文章」。
   * ★ 整条链路一起撤：读取 effect、滚动写盘 effect、`read-position.js` 模块和
   *   它的测试都删掉。只留写入不读等于埋一条死持久化，下次又会被当成功能加回来。
   *   老用户 localStorage 里的 `npr.pos.*` 不动：没人读了，专门清理反而多一次写盘。
   * ★ 回顶动作在 `openArticle` 里、拿到正文后立刻做；这里不再有任何回滚逻辑。
   */

  /* ---- 文章大纲（0.44）------------------------------------------------
   * ★ 标题从**渲染后的 DOM** 里取，不从 HTML 字符串里正则匹配：`sanitizeHtml` 会丢掉
   *   它不认识的标签与属性，正则数出来的标题可能根本不在页面上；译文 / 改写两条路径
   *   的标签结构也不一样。DOM 是唯一的真相。
   * ★ 每次 `bodyHtml` 变化都重扫：切版本会整块重建 DOM，旧 id 全部作废 ——
   *   不重扫就会出现「点目录没反应」，而且不报错。
   */
  const [outline, setOutline] = useState([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineActive, setOutlineActive] = useState(-1);
  useEffect(() => {
    const host = proseRef.current;
    if (!host) { setOutline([]); setOutlineActive(-1); return; }
    const nodes = [...host.querySelectorAll('h1, h2, h3, h4')];
    const next = outlineOf(nodes);
    // ★ 用 data 属性当锚点，不用 id：`id` 会被类名检查脚本当成类名（`npr-h-` 报缺口），
    //   而 id 还可能和文章自带的锚点撞名 —— data 属性两边都不占。
    // ★ 按 `at`（输入下标）打回节点，不是按目录下标：中间夹着空标题时两者不相等。
    next.forEach((item) => { nodes[item.at].dataset.outline = item.key; });
    setOutline(next);
    setOutlineActive(next.length ? 0 : -1);
    // 换文章 / 换版本时收起：继续开着会让人以为看的是上一版的目录
    setOutlineOpen(false);
  }, [bodyHtml]);

  /** 滚动跟踪：当前读到哪一节。用 rAF 节流，scroll 事件本身是高频的。 */
  useEffect(() => {
    const host = proseRef.current;
    const scroller = host?.closest('.npr-reader');
    if (!host || !scroller || outline.length === 0) return undefined;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top;
      // 每个标题相对滚动容器顶部的距离 —— 判定「读到哪一节」的策略在 activeIndex 里
      const tops = outline.map((item) => {
        const node = host.querySelector(`[data-outline="${item.key}"]`);
        return node ? node.getBoundingClientRect().top - top : Infinity;
      });
      setOutlineActive(activeIndex(tops));
    };
    const onScroll = () => { if (frame === 0) frame = requestAnimationFrame(sync); };
    sync();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroller.removeEventListener('scroll', onScroll); if (frame !== 0) cancelAnimationFrame(frame); };
  }, [outline]);

  /* ---- 朗读（0.44）----------------------------------------------------
   * ★ 只做「播 / 暂停 / 继续 / 停 / 变速」，**不做逐句高亮**：高亮要把正文切成
   *   一句一个 span，而正文是 dangerouslySetInnerHTML 塞进去的 —— 切一次整棵子树
   *   重建，滚动位置会跳、选中会丢、划线也失效。用「好看」换掉「能好好读」不划算。
   * ★ 一次 speak() 只喂一块（speechChunks 切好的）：Chromium 对超长 utterance 会
   *   静默截断，用户听完开头就静音、还以为读完了。
   */
  const [speaking, setSpeaking] = useState(false);
  const [speechRate, setSpeechRate] = useState(() => {
    const saved = Number(localStorage.getItem(SPEECH_RATE_KEY));
    return SPEECH_RATES.some((item) => item.rate === saved) ? saved : 1;
  });
  const speechRun = useRef(null);
  // ★ 语速用 ref 读，不用 state 闭包：speakAt 是在 toggleSpeech 里创建的一次性闭包，
  //   它捕获的 speechRate 是**点击那一刻**的值 —— 播放中改语速要等下一篇才生效，
  //   而用户会以为「改了没用」。
  const speechRateRef = useRef(speechRate);
  useEffect(() => { speechRateRef.current = speechRate; }, [speechRate]);

  /**
   * 可用的语音列表（0.54.0）。
   *
   * ★ `getVoices()` 在 Chromium 里**首次调用常常返回空数组**，要等 `voiceschanged`
   *   才填好。所以这里既读一次、也订阅一次 —— 只读不订阅的话，先打开面板再点朗读，
   *   下拉里永远是「这台机器没有中文语音」，而实际上只是还没加载完。
   * ★ 卸载时解绑：`speechSynthesis` 是全局对象，监听器不摘会累积（每次进出阅读页
   *   多一个，且都指向已卸载组件的 setState）。
   */
  const [voices, setVoices] = useState(() => globalThis.speechSynthesis?.getVoices?.() ?? []);
  useEffect(() => {
    const synth = globalThis.speechSynthesis;
    if (!synth) return undefined;
    const sync = () => setVoices(synth.getVoices());
    sync();
    synth.addEventListener('voiceschanged', sync);
    return () => synth.removeEventListener('voiceschanged', sync);
  }, []);

  /**
   * 云端朗读的可用状态（0.55.0）。
   *
   * `null` = 还在问宿主。问不到（宿主没挂上那条路由 / 插件被禁）时落成
   * `{ configured: false }` —— **不报错**：系统语音仍然能用，云端只是「还没配」。
   * ★ 监听 `npr-settings-changed`：用户在设置页填完 Key 回到阅读页，下拉里必须
   *   立刻多出那组云端音色。不监听的话要重开面板才看得到，而用户会以为没保存成功。
   */
  const [cloud, setCloud] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch(`${SPEECH_API_PREFIX}/config`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => { if (!cancelled) setCloud(body?.ok === true ? body : { configured: false, voices: [] }); })
        .catch(() => { if (!cancelled) setCloud({ configured: false, voices: [] }); });
    };
    load();
    window.addEventListener('npr-settings-changed', load);
    return () => { cancelled = true; window.removeEventListener('npr-settings-changed', load); };
  }, []);

  /**
   * 用户选的音色。空串 = 没选过，按 `pickVoice` 自动挑。
   *
   * ★ 0.55.0 起存的是**带引擎前缀**的值（`local:Tingting` / `cloud:claire`）。
   *   0.54.0 存下的裸名字由 `parseSpeechVoice` 兼容成「本机语音」——
   *   不做兼容的话，升级后用户上次选的音色会静默失效，而界面看不出任何异常。
   */
  const [speechVoice, setSpeechVoice] = useState(() => localStorage.getItem(SPEECH_VOICE_KEY) ?? '');
  // 与语速同理：toggleSpeech 里那个闭包捕获的是点击那一刻的值，用 ref 才能即时生效
  const speechVoiceRef = useRef(speechVoice);
  useEffect(() => { speechVoiceRef.current = speechVoice; }, [speechVoice]);

  /**
   * 设置页也会改这两个值（0.76.1 起「朗读声音 / 语速」进了设置页）。
   *
   * ★ 本组件不会因此重新挂载 ⇒ state 恒旧：下拉还显示旧音色、语速按钮还亮着旧档，
   *   而 `toggleSpeech` 里的 ref 已经指向新值 —— 界面与实际打架，且两处都不报错。
   * ★ 为什么连 `npr-settings-changed` 一起听：那是设置页保存 Key 时派发的老事件，
   *   顺手也会用到它；`SPEECH_PREFS_EVENT` 是专门为偏好改动加的，语义更窄。
   * ★ `storage` 事件只在**别的窗口**改动时触发，本窗口内改不触发 —— 所以不能只靠它。
   */
  useEffect(() => {
    const sync = () => {
      setSpeechVoice(localStorage.getItem(SPEECH_VOICE_KEY) ?? '');
      const saved = Number(localStorage.getItem(SPEECH_RATE_KEY));
      setSpeechRate(SPEECH_RATES.some((item) => item.rate === saved) ? saved : 1);
    };
    window.addEventListener(SPEECH_PREFS_EVENT, sync);
    window.addEventListener('npr-settings-changed', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SPEECH_PREFS_EVENT, sync);
      window.removeEventListener('npr-settings-changed', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  /**
   * 下拉里的两组选项。
   *
   * ★ 云端排前面：用户的抱怨是「本机的都不自然」，那一组是他已经试遍的。
   * ★ 没配 Key 时**不列出云端音色**（而不是列出来点了报错）：一个能选但选完就报
   *   「没填 Key」的下拉，比一个明确写着「去设置里填 Key」的提示更让人恼火。
   */
  const voiceGroups = useMemo(() => speechVoiceGroups({ voices, cloud }), [voices, cloud]);

  /**
   * 下拉里要显示的那一项。
   *
   * ★ 用户没选过时显示 `pickVoice` 自动挑中的那个，而不是空 —— 否则下拉是空值，
   *   用户以为「没选就没在用」，而实际上朗读一直在用某个音色。
   * ★ 选过云端、但 Key 后来被清空时返回空串，界面上会补一条「云端音色（未配置）」
   *   的禁用项：如实说明「你选的那个现在用不了」，而不是悄悄跳到本机语音。
   */
  const activeVoiceValue = useMemo(
    () => activeSpeechVoiceValue({ value: speechVoice, voices, cloud }),
    [speechVoice, voices, cloud],
  );

  /**
   * 云端播放器（0.55.0）。两个实例、各自一个 `<audio>`：
   *   - `mainCloudPlayer()` 负责「朗读这篇」
   *   - `previewCloudPlayer()` 负责「试听」
   *
   * ★ 为什么不共用一个：共用时点一下试听会把「朗读这篇」的进度冲掉，而试听结束时
   *   那声 `idle` 会把工具条那颗三角熄灭 —— 文章其实还在念。
   * ★ 为什么懒建（在点击时建）而不是渲染时建：`createCloudPlayer` 会造一个
   *   `<audio>` 元素，渲染期造元素是副作用；而且每次重渲染都造一个的话，上一个
   *   还在响的元素就没人能停了。
   */
  const mainPlayerRef = useRef(null);
  const previewPlayerRef = useRef(null);
  const cloudDeps = () => ({
    fetchAudio: (text, options) => fetchCloudAudio(SPEECH_API_PREFIX, text, options),
  });
  const mainCloudPlayer = () => {
    if (mainPlayerRef.current === null) {
      mainPlayerRef.current = createCloudPlayer({
        ...cloudDeps(),
        onState: (state) => setSpeaking(state === 'playing'),
        onError: (error) => { setSpeaking(false); notify(error.message, true); },
      });
    }
    return mainPlayerRef.current;
  };
  const previewCloudPlayer = () => {
    if (previewPlayerRef.current === null) {
      previewPlayerRef.current = createCloudPlayer({
        ...cloudDeps(),
        // 试听不改 speaking：它不是「朗读这篇」
        onState: () => {},
        onError: (error) => notify(error.message, true),
      });
    }
    return previewPlayerRef.current;
  };

  /**
   * 试听：用当前选中的音色念一小段。
   * ★ 先 `cancel()`：不取消的话连点两下试听会排队，第二段在第一段之后才响，
   *   用户以为按钮没反应。
   * ★ 试听**不改** `speaking` 状态：它不是「朗读这篇」，把工具条那颗三角点亮
   *   会让用户以为文章在念。
   * ★ 云端那条路会**真的花几分钱**（一次试听约 40 字节 × 0.05/千字节，几厘），
   *   所以按钮上不写「免费」，界面上也不暗示免费。
   */
  const previewVoice = () => {
    const parsed = parseSpeechVoice(speechVoiceRef.current);
    if (parsed.engine === 'siliconflow') {
      if (cloud?.configured !== true) { notify('云端朗读还没填 API Key', true); return; }
      previewCloudPlayer().play([SPEECH_SAMPLE], { voice: parsed.voice, speed: speechRateRef.current });
      return;
    }
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') {
      notify('这个环境不支持朗读（没有语音合成能力）', true);
      return;
    }
    const picked = pickVoice(synth.getVoices(), parsed.voice);
    if (!picked) { notify('这台机器没有中文语音，中文文章读不了', true); return; }
    synth.cancel();
    const utter = new globalThis.SpeechSynthesisUtterance(SPEECH_SAMPLE);
    utter.lang = picked.lang;
    utter.rate = speechRateRef.current;
    const voice = synth.getVoices().find((item) => item.name === picked.name);
    if (voice) utter.voice = voice;
    synth.speak(utter);
  };

  /**
   * 换音色。正在朗读时先停 —— 声音中途换掉会让人以为出了故障。
   *
   * ★ 参数是下拉项**完整的 value**（带引擎前缀），不是裸名字：0.55.0 起一个下拉里
   *   同时装着本机语音与云端音色，裸名字分不出该走哪条路。
   */
  const chooseVoice = (value) => {
    setSpeechVoice(value);
    // 写 + 广播同一处完成（`writeSpeechPrefs`）：电子书页和设置页要知道换了音色。
    writeSpeechPrefs(localStorage, { voice: value });
    const cloudPlaying = mainPlayerRef.current !== null && mainPlayerRef.current.active;
    if (cloudPlaying || speaking || globalThis.speechSynthesis?.speaking) {
      stopSpeech();
      notify('已换音色，重新点朗读开始');
    }
  };

  const stopSpeech = () => {
    if (speechRun.current) speechRun.current.cancelled = true;
    speechRun.current = null;
    globalThis.speechSynthesis?.cancel();
    // ★ 只停**存在**的播放器：`stopSpeech` 会在换篇/卸载的 cleanup 里被调用，
    //   那时懒建的播放器可能还没造出来 —— 为了停它而造一个，等于每换一篇文章
    //   就凭空多一个 `<audio>`。
    if (mainPlayerRef.current !== null) mainPlayerRef.current.stop();
    if (previewPlayerRef.current !== null) previewPlayerRef.current.stop();
    setSpeaking(false);
  };

  const toggleSpeech = () => {
    // ★ 带音频的播客单集不提供「朗读这篇文章」：它已经有真人音频了，再合成一遍
    //   只会让两条声音抢同一个场景（而且合成的是文字稿，根本不是这一集）。
    //   按钮本身已 disabled，这里再挡一次是防别的入口（快捷键 / 旧调用点）误触发。
    if (audioUrl) { notify('这一集自带音频，直接用播放条收听就好', true); return; }
    // ★ 读 ref 而不是 localStorage：换音色后同一会话内立刻生效，不用重开面板
    const parsed = parseSpeechVoice(speechVoiceRef.current);

    if (parsed.engine === 'siliconflow') {
      if (cloud?.configured !== true) {
        notify('云端朗读还没填 API Key。到「设置 → 朗读」里填一个硅基流动的 Key。', true);
        return;
      }
      const player = mainCloudPlayer();
      // 已经在念：点一下暂停；暂停中：点一下继续
      if (player.active) {
        if (speaking) { player.pause(); setSpeaking(false); } else { player.resume(); setSpeaking(true); }
        return;
      }
      const chunks = speechChunksForReading(proseRef.current?.innerText ?? '', SPEECH_CLOUD_CHUNK,
        isPronunciationEnabled(localStorage));
      if (chunks.length === 0) { notify('这篇没有可朗读的正文'); return; }
      player.play(chunks, { voice: parsed.voice, speed: speechRateRef.current });
      return;
    }

    const synth = globalThis.speechSynthesis;
    if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') {
      notify('这个环境不支持朗读（没有语音合成能力）', true);
      return;
    }
    // 已经在念：点一下暂停；暂停中：点一下继续
    if (synth.speaking && !synth.paused) { synth.pause(); setSpeaking(false); return; }
    if (synth.paused) { synth.resume(); setSpeaking(true); return; }
    const chunks = speechChunksForReading(proseRef.current?.innerText ?? '', 600,
      isPronunciationEnabled(localStorage));
    if (chunks.length === 0) { notify('这篇没有可朗读的正文'); return; }
    const picked = pickVoice(synth.getVoices(), parsed.voice);
    // 没有中文语音就明说，不退回英语：那会把中文念成噪音，比不念更糟
    if (!picked) { notify('这台机器没有中文语音，中文文章读不了', true); return; }
    const run = { cancelled: false };
    speechRun.current = run;
    const speakAt = (at) => {
      if (run.cancelled) return;
      if (at >= chunks.length) { setSpeaking(false); speechRun.current = null; return; }
      const utter = new globalThis.SpeechSynthesisUtterance(chunks[at]);
      utter.lang = picked.lang;
      utter.rate = speechRateRef.current;
      const voice = synth.getVoices().find((item) => item.name === picked.name);
      if (voice) utter.voice = voice;
      utter.onend = () => speakAt(at + 1);
      utter.onerror = () => { if (!run.cancelled) { setSpeaking(false); speechRun.current = null; } };
      synth.speak(utter);
    };
    setSpeaking(true);
    speakAt(0);
  };

  // 换文章 / 换版本必须停：上一篇会继续念，而屏幕上已经是另一篇
  useEffect(() => () => stopSpeech(), [selected?.article?.key, active]);

  /**
   * 跳到某一节。
   * ★ 不用 `scrollIntoView`：它会把**外层所有**可滚动祖先一起滚（宿主的页面容器也在
   *   其中），滚完左侧列表也跟着跳，用户会以为点错了。自己算差值只动这一格。
   */
  const jumpToHeading = (key) => {
    const host = proseRef.current;
    const node = host?.querySelector(`[data-outline="${key}"]`);
    const scroller = host?.closest('.npr-reader');
    if (!node || !scroller) return;
    // 差值算法在 scrollTarget 里（纯函数、可测）—— 算错了不报错，只会滚到别处
    const top = scrollTarget(scroller.scrollTop, node.getBoundingClientRect().top, scroller.getBoundingClientRect().top);
    scroller.scrollTo({ top, behavior: 'smooth' });
  };
  useEffect(() => { if (askContext && activeArticle?.article) setAskContext(previous => ({ ...previous, key: activeArticle.article.key, title: activeArticle.article.titleZh || activeArticle.article.title, version: active, selection: previous.key === activeArticle.article.key && previous.version === active ? previous.selection : '', quoteId: previous.key === activeArticle.article.key && previous.version === active ? previous.quoteId : undefined })); }, [activeArticle?.article?.key, active]);
  const openCompanion = (quote = '') => { if (!activeArticle) return; setFocused(false); setAskContext({ key: activeArticle.article.key, title: activeArticle.article.titleZh || activeArticle.article.title, version: active, selection: quote, quoteId: quote ? ++selectionSerial.current : undefined }); };
  // ★ 不再重置 `filter` / `query`：它们是**按频道**记的（见 `channel-state.js`），
  //   切过去由加载 effect 装回那个源自己的那一份。在这里清成默认值，等于每次切源
  //   都先把状态擦掉再恢复 —— 顺序稍一错就永远恢复不回来。
  const selectChannel = (key) => { if (key === channel) return; articleRequest.current++; setAskContext(null); setFocused(false); setSelected(undefined); setPassage(null); setChannel(key); };
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
  /**
   * 选中文本之后做什么（`onMouseUp` / `onKeyUp`）。
   *
   * ★ 0.45.0 改了交互：以前**一选中就自动打开右侧 AI 伴读面板**。后果有两个：
   *   ① 面板一开，`.npr-layout` 从两列变成单列（`has-companion`），正文区整体变宽 ——
   *      用户刚选中的那一段**在屏幕上跳了一下**，浮出来的操作条也会锚在旧坐标上；
   *   ② 只是想把一句话记下来的用户，每次都要先关掉一个面板。
   *   现在改成在选区上方浮一条小工具条（「摘录到灵感」/「问 AI」），点「问 AI」才开面板。
   * ★ 定位用 `quoteRange`（高亮那套已经验证过的 range 重建），不是 `window.getSelection()`：
   *   后者在 `onKeyUp` 那条路径上（用键盘扩选）已经不稳定。
   */
  const captureSelection = () => {
    const found = selectedPassage(proseRef.current);
    if (!found) { setPassage(null); setSelectionBar(null); return; }
    if (found.quote === passage?.quote && selectionBar) return;
    setPassage(found);
    // 伴读面板**已经开着**时跟随新选区：布局早就两列了，不存在「跳一下」的问题，
    // 而此刻用户的意图明显是「就这段问 AI」。面板没开则只浮工具条，等用户自己点。
    if (askContext) openCompanion(found.quote);
    const range = proseRef.current ? quoteRange(proseRef.current, found) : null;
    const rect = range?.getBoundingClientRect?.();
    // 定位规则全在 selectionBarPlacement 里（上方放不下翻下方 / 左右夹进窗口），
    // 那四条边界在组件里写就只能靠肉眼碰，抽出去才能喂矩形断言。
    setSelectionBar(selectionBarPlacement(rect ?? null, window));
  };

  /* 操作条的收起条件：点外面 / 滚动 / Esc。三条都要有 ——
   * 滚动不收起的话它会停在半空，看着像贴在别的内容上。 */
  useEffect(() => {
    if (!selectionBar) return undefined;
    const hide = () => setSelectionBar(null);
    const onDown = (event) => {
      // 点工具条自己不算「点外面」：漏掉这一条，按钮会在 click 之前就被卸载
      if (event.target?.closest?.('.npr-selection-bar')) return;
      hide();
    };
    const onKey = (event) => { if (event.key === 'Escape') hide(); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [selectionBar]);
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
        <LibraryApp reading={reading} onExit={(next) => setMode(next === 'diary' || next === 'paper' ? next : 'feeds')} notify={notify}
          api={api} SessionProvider={SessionProvider} renderSlot={renderSlot}
          onWriteReflection={writeReflection} onReadingContext={setReadingCtx} intent={libraryIntent}
          onIntentDone={() => setLibraryIntent(null)} />
      ) : mode === 'paper' ? (
        /* 论文（2026-11-06）。它自带同一套 `.npr-workarea > .npr-layout` 骨架，
           所以布局与窗口拖动区两边共用；阅读器那一半直接复用 `BookReader`。 */
        <PapersApp reading={reading} onExit={(next) => setMode(next === 'library' || next === 'diary' ? next : 'feeds')}
          notify={notify} api={api} SessionProvider={SessionProvider} renderSlot={renderSlot} />
      ) : mode === 'diary' ? (
        // 日记同理：自带同一套骨架 + 自己的 `[data-window-drag]` 顶栏。
        // ★ 它**不**接收 `onExit={() => setMode('feeds')}` 那种无参回调 —— 三个视图之后，
        //   「离开」有两个方向，回调必须带目标。
        <DiaryApp reading={reading} onExit={(next) => setMode(next === 'library' || next === 'paper' ? next : 'feeds')} notify={notify}
          api={api} SessionProvider={SessionProvider} renderSlot={renderSlot}
          intent={diaryIntent} onOpenBook={openBookFromDiary} onOpenArticle={openArticleFromDiary} />
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
          {/* ★ 这条筛选是**一级**（2026-10-28 用户定）：RSS 阅读页没有「阅读/书架」那样的
              页面切换器（左侧是图标视图开关），所以「全部/未读/收藏」就是这一页的顶层层级 ——
              它要**有底座**，和 icon 开关、日记三模块同一套结构。
              书架页那条 全部/在读/读完/弃读 在「阅读/书架」下面，是**二级**，保持无底座。
              两者共用 `.npr-filters`，差别只由 `npr-filters-primary` 这一个修饰类表达 ——
              「层级」是这一行字的位置属性，写在 JSX 里比在 CSS 里靠父子选择器去猜可靠。 */}
          <div className="npr-filters npr-filters-primary" role="group">
            {[['all', '全部'], ['unread', '未读'], ['favorites', '收藏']].map(([value, label]) => (
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
            ))}
            {/* 「已隐藏」是**恢复入口**，只在真的有东西藏着（或正停在这一档）时出现：
                常驻的话，99% 的用户看到的是一个点开永远是空列表的第四个 chip。
                ★ 判据带上 `filter === 'hidden'`：在「已隐藏」里恢复掉最后一篇之后
                  `hiddenCount` 归零，只按计数判断会让 chip 连同当前选中态一起消失，
                  用户会以为「我刚才点的那个筛选没了」。 */}
            {(page.hiddenCount > 0 || filter === 'hidden') && (
              <button type="button" aria-pressed={filter === 'hidden'} onClick={() => setFilter('hidden')}>
                已隐藏{page.hiddenCount > 0 ? ` ${page.hiddenCount}` : ''}
              </button>
            )}
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
          <div className="npr-list" ref={listRef}>
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
                aria-pressed={selected?.article?.key === entry.key} onClick={() => void openArticle(entry.key)}
                /* 右键 = 这一篇的操作菜单（打印 / 导出 Markdown / 隐藏）。见 `openRowMenu`。 */
                onContextMenu={(event) => openRowMenu(event, entry)}
                /* ★ 键盘等价物：菜单键与 Shift+F10 是 Windows / Linux 上「上下文菜单」的
                   标准键位，macOS 没有这习惯但也不会误触。右键菜单本身**不可 Tab 到达**，
                   没有这一条的话，键盘用户永远拿不到这三项 —— 而它们不是装饰，
                   「隐藏这篇文章」是这一页唯一能把它从列表里去掉的手段。 */
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    const box = event.currentTarget.getBoundingClientRect();
                    openRowMenuAt(box.left + 24, box.top + 28, entry);
                  }
                }}>
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
          {/*
            列表行的右键菜单（0.45.4）。

            ★ 挂在 `.npr-list` **外面**、`aside` 里面：`.npr-list` 是 `overflow: auto`
              的滚动容器，虽然 `position: fixed` 本来就不受它裁切，但放在里面会让
              「滚动时菜单跟着滚」这一类误解永远存在。放外面还有一个实际好处 ——
              `document` 上那条 `scroll` 监听只用来收菜单，逻辑简单。
            ★ 菜单项从 `rowMenuItems(entry)` 取，`entry` **现从 `page.entries` 查**：
              查不到就整张不渲染（那篇在菜单打开期间被隐藏 / 被搜掉了，弹一个
              指向已不存在文章的菜单只会让人点了没反应）。
            ★ `role="menu"` + 每项 `role="menuitem"`：右键菜单对读屏器是「一个菜单」，
              不是「三个散落的按钮」。焦点不主动抢（右键时焦点本来就还在列表里），
              所以不做 focus trap —— 它没有遮罩、按 Esc 就退，抢焦点反而会让
              键盘用户的当前位置丢失。
          */}
          {rowMenu && (() => {
            const entry = page.entries.find((item) => item.key === rowMenu.key);
            if (!entry) return null;
            return (
              <div className="npr-menu npr-rowmenu" role="menu" aria-label="文章操作"
                style={{ left: `${rowMenu.left}px`, top: `${rowMenu.top}px` }}>
                {rowMenuItems(entry).map((item) => (
                  <button key={item.kind} type="button" role="menuitem"
                    onClick={() => void runRowAction(item.kind, rowMenu.key)}>
                    <Icon name={item.icon} size={15} />
                    {item.label}
                  </button>
                ))}
              </div>
            );
          })()}
        </aside>
        <div className="npr-resize" role="separator" aria-orientation="vertical" onPointerDown={startDrag}
          onDoubleClick={() => { setListWidth(saveSidebarWidth(SIDEBAR_WIDTH)); }} />
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
            <>
              {/* ★ 没选中文章时也要有一条窗口拖动行（0.28.3）：选中文章时顶部是
                  `.npr-reader-toolbar`，而欢迎页这个分支里**一个拖动行都没有** ——
                  面板右侧整块（约 68% 宽）在空白处按住鼠标，窗口纹丝不动
                  （用户 2026-10-26 报的「在 rss 阅读界面不能鼠标移动窗口」）。
                  侧栏那条 44px 工具栏远在另一头，且中间被按钮切成几段，踩不准。
                  类名与高度跟书架欢迎页（LibraryApp 0.9.8）**完全一致**，所以选中 /
                  未选中两种状态下，面板顶部都是同一条 44px 的线。 */}
              <div className="npr-book-toolbar" data-window-drag />
              <div className="npr-welcome">
                <div className="npr-welcome-brand">{BRAND_TITLE}</div>
                <h2>{SLOGAN_ZH}</h2>
                {/* 英文 slogan 是**副标**：字号与行距都往下压一档，颜色用 --npr-faint。
                    与 h2 同级而不是塞进 h2 的 span —— 中英混排在同一行会在中文句号后
                    留下一个空档，读起来像排版事故。 */}
                <p className="npr-welcome-slogan-en">{SLOGAN_EN}</p>
                {/* 两段按「怎么读」/「怎么读懂」分：第一段只讲这一屏能看到的操作，
                    第二段讲模型补什么。合成一段会有五个分句、三处转折，读起来像说明书。 */}
                <p className="npr-welcome-intro">
                  左侧只有你订阅的源与分组，全部 / 未读 / 收藏随时筛；点标题开始读。
                </p>
                <p className="npr-welcome-intro">
                  英文原文可自动配译文，缺的版本按需生成；选中一段能唤起 AI 伴读，读的就是这一篇。
                </p>
                <div className="npr-welcome-keys">
                  {[['J / K', '上一篇 / 下一篇'], ['[', '专注阅读'], ['/', '搜索文章']].map(([key, label]) => (
                    <span key={key}><kbd>{key}</kbd><span>{label}</span></span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="npr-reader-toolbar" data-window-drag>
                <button type="button" className="npr-icon" title={askContext ? '选择频道' : focused ? '显示列表' : '专注阅读'} aria-label={askContext ? '选择频道' : focused ? '显示列表' : '专注阅读'}
                  onClick={(event) => askContext ? openPicker(event) : setFocused((current) => !current)}><Icon name={askContext ? 'panel-left-open' : focused ? 'panel-left-open' : 'panel-left-close'} /></button>
                <label className="npr-visually-hidden" htmlFor="npr-mode">阅读版本</label>
                <div className="npr-version-switch"><span aria-hidden="true">版本</span><select id="npr-mode" className="npr-mode-select" value={active} onChange={(event) => { setPassage(null); setSelected((current) => ({ ...current, active: event.target.value })); }}>
                  {VERSION_ORDER.filter((kind) => kind !== 'contrast' || translationReady).map((kind) => {
                    /**
                     * ★ 「对照」没有 `versions.contrast` —— 直接查 `versions[kind]`
                     *   会让它永远显示「（缺失）」，把一个能用的功能标成不可用。
                     */
                    const available = kind === 'original'
                      || (kind === 'contrast' ? translationReady : versions?.[kind]?.available);
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
                  <button type="button" className="npr-icon" data-sep="1" title="AI 伴读" aria-label="AI 伴读" onClick={() => openCompanion(passage?.quote ?? '')}><Icon name="wand-sparkles" /></button>
                  {/* 带音频的播客单集：朗读**灰掉并说明原因**（0.84.1）。
                      之前是「看着能点、点了会冒出第二条声音」；disabled 只是属性，
                      视觉上还得靠 .npr-icon:disabled 那两条规则才看得出是灰的。 */}
                  <button type="button" className="npr-icon"
                    title={audioUrl ? '这一集自带音频，用播放条收听（不需要朗读）' : (speaking ? '暂停朗读' : '朗读这篇文章')}
                    aria-label={audioUrl ? '朗读已禁用：这一集自带音频' : (speaking ? '暂停朗读' : '朗读这篇文章')}
                    aria-pressed={speaking} disabled={Boolean(audioUrl)}
                    onClick={toggleSpeech}><Icon name={speaking ? 'pause' : 'play'} /></button>
                  {/* 大纲：没有标题时**禁用并说明为什么** —— 点了什么都不发生的按钮
                      就是「看起来像功能」（本项目记过好几次）。
                      ★ 图标从 `type`（大写 T）换成 `list-tree`：T 在中文界面里只读得出
                        「字体 / 字号」，用户 2026-10-28 直接把它当阅读设置点了。 */}
                  <button type="button" className="npr-icon npr-outline-toggle" data-sep="1"
                    title={outline.length ? '文章大纲' : '这篇没有小标题，没有大纲'}
                    aria-label="文章大纲" aria-expanded={outlineOpen} disabled={outline.length === 0}
                    onClick={() => setOutlineOpen((current) => !current)}><Icon name="list-tree" /></button>
                  {/* 阅读设置：T 这个字形就是「字体」的通用符号，直接开阅读设置浮层
                      （用户 2026-10-28 要求）。以前它藏在「更多操作」里，要点两次。 */}
                  <button type="button" className="npr-icon" title="阅读设置" aria-label="阅读设置"
                    aria-expanded={appearanceOpen} onClick={() => setAppearanceOpen((open) => !open)}><Icon name="type" /></button>
                  <button type="button" className="npr-icon" title="更多操作" aria-label="更多操作"
                    aria-haspopup="menu" aria-expanded={menuOpen} ref={menuButtonRef}
                    onClick={() => setMenuOpen((open) => !open)}><Icon name="ellipsis" /></button>
                  {/* ★ 0.84.7：这里降级成 `group`，不是 `menu`。
                      之前写了 `role="menu"` 却没有任何 `menuitem`、没有方向键、
                      也没有 roving focus —— 读屏会宣布「菜单」，然后按 Tab 逐个走，
                      用户的预期（方向键切换、Esc 关闭）全部落空。真正的菜单语义
                      见上面右键菜单那处（`role="menu"` + 每项 `menuitem`）。
                      要么做全、要么不承诺，中间态比不做更糟。 */}
                  {menuOpen && (
                    <div className="npr-menu" role="group" aria-label="更多操作" ref={menuRef}>
                      <button type="button" onClick={() => { setMenuOpen(false); setAppearanceOpen(true); }}><Icon name="type" size={15} />阅读设置</button>
                      <button type="button" onClick={() => { setMenuOpen(false); openCompanion(passage?.quote ?? ''); }}><Icon name="wand-sparkles" size={15} />问 AI</button>
                      {/* ★ 只在**真的有选中**时才渲染，而不是常驻 + `disabled`：
                          本项目已经栽过「有 disabled 属性但看不出灰」的跟头（点了没反应）。
                          条件渲染没有这个风险，代价是「没选中时看不见它」—— 而没选中时
                          它也做不了任何事。 */}
                      {passage?.quote && (
                        <button type="button" onClick={() => { setMenuOpen(false); void excerptToDiary(); }}>
                          <Icon name="highlighter" size={15} />摘录到灵感
                        </button>
                      )}
                      <hr />
                      {activeArticle.article.url && <button type="button" onClick={() => { setMenuOpen(false); window.open(activeArticle.article.url, '_blank', 'noopener,noreferrer'); }}><Icon name="globe" size={15} />打开原文</button>}
                      <button type="button" onClick={() => { setMenuOpen(false); try { printArticle({ title: activeArticle.article.title, url: activeArticle.article.url, version: VERSION_LABELS[active], html: bodyHtml }); } catch (error) { notify(`打印失败：${error?.message ?? String(error)}`, true); } }}><Icon name="file-check" size={15} />打印 / 存为 PDF</button>
                      {/* 和「打印」并排：一个给人看（PDF），一个给人改（Markdown）。
                          只给 PDF 的话，想拿去做笔记只能重排一遍。 */}
                      <button type="button" onClick={() => { setMenuOpen(false); exportMarkdown(); }}><Icon name="download" size={15} />导出 Markdown</button>
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
                          onClick={() => { setMenuOpen(false); void generate(active === 'contrast' ? 'translation' : active, true); }}>
                          <Icon name="refresh-cw" size={15} />{regenerateMenuLabel({ active, generating: selected?.generating })}
                        </button>
                      )}
                      {menuItems.reloadArticle && (
                        <button type="button" disabled={reloadingArticle}
                          onClick={() => { setMenuOpen(false); void reloadArticle(activeArticle.article.key); }}>
                          <Icon name="refresh-cw" size={15} />{busyMenuLabel('重新加载文章', reloadingArticle)}
                        </button>
                      )}
                      <hr />
                      {/* 朗读声音（0.54.0 起有入口，0.55.0 起含云端音色）。
                          在此之前界面上**没有任何选择入口**：pickVoice 取「第一个
                          zh-CN 本地语音」，用户既不知道自己在听谁、也换不掉。
                          用户 2026-10-30：「现在的朗读效果非常差，非常机械声」；
                          试遍 20 条系统语音之后的结论是「没有一个读起来自然的」——
                          那是采样拼接式合成的上限，所以 0.55.0 加了云端这一组。
                          ★ 放在语速上面：音色对「像不像人」的影响远大于语速。
                          ★ 两组用 <optgroup> 分开、不混在一个平铺清单里：本机那组
                            是免费的、云端那组按字计费，混在一起用户没法判断自己在
                            花谁的钱。
                          ★ 没有中文语音时**不禁用一个空下拉**：换成一行说明。 */}
                      <div className="npr-menu-row" role="group" aria-label="朗读声音">
                        {voiceGroups.local.length > 0 || voiceGroups.remote.length > 0 ? (
                          <>
                            <span className="npr-menu-label">朗读声音</span>
                            <div className="npr-menu-pick">
                              <select className="npr-menu-select" aria-label="朗读声音"
                                value={activeVoiceValue}
                                onChange={(event) => chooseVoice(event.target.value)}>
                                {/* ★ 选过云端音色、但 Key 后来被清空时必须**如实说出来**：
                                    否则 <select> 会静默跳到第一项（某个本机语音），用户看到的是
                                    「我选的温柔女声变成了婷婷」，而设置里那个值其实还在。 */}
                                {activeVoiceValue === '' && (
                                  <option value="" disabled>（当前选的音色现在用不了）</option>
                                )}
                                {voiceGroups.remote.length > 0 && (
                                  <optgroup label="云端 · 更自然（按字数计费）">
                                    {voiceGroups.remote.map((item) => (
                                      <option key={item.value} value={item.value}>{item.label}</option>
                                    ))}
                                  </optgroup>
                                )}
                                {voiceGroups.local.length > 0 && (
                                  <optgroup label="本机语音（免费 · 离线）">
                                    {voiceGroups.local.map((item) => (
                                      <option key={item.value} value={item.value}>{item.label}</option>
                                    ))}
                                  </optgroup>
                                )}
                              </select>
                              <button type="button" className="npr-menu-test" onClick={previewVoice}>试听</button>
                            </div>
                          </>
                        ) : (
                          <span className="npr-menu-hint">这台机器没有中文语音，也还没配云端朗读。系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，下载一个中文声音；或者到「设置 → 朗读」里填一个硅基流动的 API Key。</span>
                        )}
                      </div>
                      {/* ★ 这条说明放在**下面单独一行**，不塞进上面那个 flex 行：
                          那一行是「标签 + 控件」的固定形态，多一段长文字会把下拉挤成
                          几个像素宽（0.54.0 量过：菜单总宽 293px，下拉只剩 158px）。 */}
                      {voiceGroups.remote.length === 0 && voiceGroups.local.length > 0 && (
                        <div className="npr-menu-row" role="note">
                          <span className="npr-menu-hint">
                            这些是本机语音 —— 机器味就是它们给的。想换更自然的声音：设置 → 朗读 → 填一个硅基流动 API Key，这里会多出一组云端音色（按字数计费）。
                          </span>
                        </div>
                      )}
                      {/* 语速放在「更多」里而不是工具条上：它是一周改一次的东西，
                          而工具条上每一颗按钮都在抢宽度（窄窗口下会先把文字砍掉）。 */}
                      <div className="npr-menu-row" role="group" aria-label="朗读语速">
                        <span>朗读语速</span>
                        <div className="npr-menu-seg">
                          {SPEECH_RATES.map((item) => (
                            <button key={item.rate} type="button"
                              className={item.rate === speechRate ? 'is-on' : ''}
                              aria-pressed={item.rate === speechRate}
                              onClick={() => { setSpeechRate(item.rate); writeSpeechPrefs(localStorage, { rate: item.rate }); }}>
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <hr />
                      {/* 隐藏 / 恢复是**同一个位置的两态**，不是两条并列的菜单项：
                          并列的话，「已隐藏」列表里点开一篇，菜单里会出现一个对这篇
                          毫无意义的「隐藏这篇文章」。
                          ★ 不叫「删除」：feed 里那条是源站的内容，删了下次刷新会回来，
                            叫删除会让用户以为它再也不会出现。 */}
                      {activeArticle.article.hidden ? (
                        <button type="button" onClick={() => { setMenuOpen(false); void unhideArticle(activeArticle.article.key); }}>
                          <Icon name="eye-off" size={15} />恢复这篇文章
                        </button>
                      ) : (
                        <button type="button" onClick={() => { setMenuOpen(false); void hideArticle(activeArticle.article.key); }}>
                          <Icon name="eye-off" size={15} />隐藏这篇文章
                        </button>
                      )}
                      <hr />
                      <button type="button" onClick={() => { setMenuOpen(false); setDialog('settings'); }}><Icon name="settings" size={15} />插件设置</button>
                      <button type="button" onClick={(event) => { setMenuOpen(false); openPicker(event); }}><Icon name="rss" size={15} />选择频道</button>
                    </div>
                  )}
                  {appearanceOpen && <ReadingAppearance settings={reading} onChange={applyReading} onClose={() => setAppearanceOpen(false)} />}
                </div>
              </div>
              {/* 大纲槽：height:0 的 sticky 元素 —— 不占正文高度，但随滚动固定在视野里。
                  ★ 不能直接 absolute 挂在 .npr-reader 上：那是 overflow:auto 的滚动容器，
                    absolute 子元素会跟着内容一起滚走，读两屏目录就没了。 */}
              <div className="npr-outline-slot">
                {outlineOpen && outline.length > 0 && (
                  <nav className="npr-outline" aria-label="文章大纲">
                    <div className="npr-outline-head">
                      <span>大纲</span>
                      <button type="button" className="npr-icon" title="收起大纲" aria-label="收起大纲"
                        onClick={() => setOutlineOpen(false)}><Icon name="x" size={13} /></button>
                    </div>
                    <ol className="npr-outline-list">
                      {outline.map((item, index) => (
                        <li key={item.key} data-level={Math.min(item.level, 4)}>
                          <button type="button" className={index === outlineActive ? 'is-current' : ''}
                            title={item.full} aria-current={index === outlineActive ? 'location' : undefined}
                            onClick={() => jumpToHeading(item.key)}>{item.text}</button>
                        </li>
                      ))}
                    </ol>
                  </nav>
                )}
              </div>
              <article className="npr-article"
                data-listen={listenMode && audioUrl ? 'true' : 'false'}
                data-read-tab={audioUrl ? readTab : 'article'}>
                {/*
                  收听视图的头部（0.81.0）。放在 article **最前面** 是有意的：切到收听
                  之后顺序就是「返回 + 标题 → 播放条 → 字幕」，而播放条本身在下面原来
                  的位置没动 —— 不动它，`<audio>` 才不会因为换了一份兄弟树而被重建。
                */}
                {/*
                  ★ 0.84.7：两套头部的**内容**必须一致。上一轮只统一了字号 / 间距，
                    切到字幕 / 导读时作者、版本 chip、「仅摘要」会整块消失，标题
                    还丢了原文链接 —— 看起来像「同一篇文章换了个人写的头」。
                    现在两边用同一份字段，唯一允许的差别是收听态多一个「N 段字幕」。
                  ★ 三态互斥：收听态**不渲染**另一套头，DOM 里不留一份被 CSS 隐藏的副本。
                */}
                {listenMode && audioUrl ? (
                  <header className="npr-listen-head" data-listen-keep="true">
                    <div className="npr-listen-meta">
                      {activeArticle.article.channelName && <span>{activeArticle.article.channelName}</span>}
                      {activeArticle.article.publishedAt && <span>{formatFullDay(activeArticle.article.publishedAt)}</span>}
                      {activeArticle.article.author && <span>{activeArticle.article.author}</span>}
                      <span className="npr-mode-chip">{VERSION_LABELS[active]}</span>
                      {activeArticle.article.bodyMissing && <span title="订阅源只提供摘要，且没能从原文页抓到全文；可在「更多操作」里手动抓取">仅摘要</span>}
                      {transcript.data?.paragraphs?.length ? <span>{transcript.data.paragraphs.length} 段字幕</span> : null}
                    </div>
                    <h1>
                      {activeArticle.article.url
                        ? <a href={activeArticle.article.url} target="_blank" rel="noopener noreferrer">{title}</a>
                        : title}
                    </h1>
                  </header>
                ) : (
                  <>
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
                  </>
                )}
                {/* 播放器在上、选项卡在下（0.84.2）。用户拿「播放条在上、下划线 tab
                    在下」的截图做参考：tab 夹在标题与播放条之间时，它离自己控制的内容
                    太远，而且胶囊按钮与播放条挤在一起像一组控件。
                    ★ 两块都带 `data-listen-keep`：切到字幕/导读时 CSS 会隐掉 article 里
                      所有没有 keep 的直接子元素，选项卡和播放器必须留着。
                    ★ 只在有音频时出现：普通文章没有字幕与导读，多给两个 tab 只会
                      多出两个点进去是空的按钮。 */}
                {audioUrl && (
                  <div className="npr-dock-slot" data-listen-keep="true">
                    <MediaDock
                      key={activeArticle.article.key}
                      episode={{ ...activeArticle.article, audio: audioUrl }}
                      onController={setAudioController}
                    />
                  </div>
                )}
                {audioUrl && (
                  <div className="npr-readtabs" data-listen-keep="true" role="group" aria-label="阅读内容">
                    {READ_TABS.map((tab) => (
                      <button type="button" key={tab.id}
                        aria-pressed={readTab === tab.id}
                        onClick={() => setReadTab(tab.id)}>{tab.label}</button>
                    ))}
                  </div>
                )}
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
                <ContrastStackedNotice mode={active === 'contrast' ? contrast?.mode : undefined} />
                {bodyHtml
                  ? <div ref={proseRef} className="npr-prose" onMouseUp={captureSelection} onKeyUp={captureSelection} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
                  : (
                    <div className="npr-missing">
                      这个版本还没有内容。
                      {/* ★ 只给**真能生成**的版本这个按钮。「对照」是派生视图，
                          没有「生成对照」这条路径 —— 把它放进来会点出一个
                          宿主不认识的 kind。 */}
                      {(active === 'translation' || active === 'rewrite') && (
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
                {/*
                  收听视图的字幕区（0.81.0）。挂在 article **末尾**：上面那些正文、
                  提示条在 `data-listen="true"` 时被 CSS 隐掉，于是视觉顺序就是
                  「标题 → 播放条 → 字幕」，DOM 顺序却不影响播放条的位置。
                */}
                {listenMode && audioUrl && (
                  <div className="npr-listen-body" data-listen-keep="true">
                    {/*
                      ★ 0.84.1：导读与字幕**都常驻**，靠 `data-read-tab` + CSS 二选一显隐。
                        之前是「导读压在 120 段字幕上面」的一长页，用户要的是选项卡；
                        但不能改成条件渲染 —— 那会在切 tab 时卸掉 TranscriptPanel，
                        它订阅着 `audioController`，重建一次字幕高亮就要重新接一遍。
                      ★ `data-read-panel` 的取值与 READ_TABS 的 id 同源。
                    */}
                    <div className="npr-readpanel" data-read-panel="digest">
                      <EpisodeDigest
                        state={digest}
                        onGenerate={() => void generateDigest()}
                        onJump={jumpToTime}
                      />
                    </div>
                    <div className="npr-readpanel" data-read-panel="transcript">
                      <TranscriptPanel
                        transcript={transcript.data}
                        status={transcript.status}
                        error={transcript.error}
                        controller={audioController}
                        translation={translation}
                        onTranslate={() => void translate()}
                        langMode={langMode}
                        onCycleLang={cycleLang}
                        standalone
                        asr={asr}
                        onTranscribe={() => void transcribe()}
                        onCancelTranscribe={() => void cancelTranscribe()}
                        onFetch={() => void loadTranscript({ refresh: true })}
                        focus={focus}
                      />
                    </div>
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
          {/* 这里**保持** `role="menu"`：子项确实都带 `menuitem`（0.84.7 核对过）。
              与「更多操作」那处不同 —— 那个菜单的按钮全是裸 `<button>`，
              没有任何菜单语义，才降级成 `group`。 */}
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
      {/* 灵感浮层：订阅页与书架页共用一份。日记页不挂（那儿本来就有一个输入框）。
          ★ 上下文**两边都给**（0.38）：用户 2026-10-27 问「那如果是在阅读 RSS 时
            创建的灵感怎么办？挂在书上的意义？」—— 意义是**回到现场**，与「是不是书」
            无关。以前只有书架页给 `readingCtx`，订阅页按 `L` 记的灵感连来源都没有，
            于是在日记里既回不去那篇文章，也不在任何分组里出现。 */}
      {mode !== 'diary' && <QuickCapture open={quickOpen}
        onClose={() => { setQuickOpen(false); setQuickSeed(''); }}
        notify={notify}
        onOpenDiary={() => setMode('diary')}
        seed={quickSeed}
        context={mode === 'library' ? readingCtx : (activeArticle?.article ? {
          articleKey: activeArticle.article.key,
          articleTitle: readerTitle({ active, versions: activeArticle.versions, article: activeArticle.article }),
          channel: activeArticle.article.channelName ?? '',
        } : null)} />}
      {/* 选中文本后浮在选区上方的操作条。
          ★ `onPointerDown` 上 preventDefault：不这么做的话，按下按钮这一下会把
            选区折叠掉 —— 有的浏览器随即清掉 selection，`passage` 虽然还在 state 里，
            但用户会看到选中高亮在点下去的瞬间消失，像「点了个空」。 */}
      {selectionBar && passage?.quote && (
        <div className="npr-selection-bar" role="toolbar" aria-label="选中文字的操作"
          style={{ top: `${selectionBar.top}px`, left: `${selectionBar.left}px` }}
          onPointerDown={(event) => event.preventDefault()}>
          <button type="button" className="is-primary"
            onClick={() => { setSelectionBar(null); void excerptToDiary(); }}>
            <Icon name="highlighter" size={14} />摘录到灵感
          </button>
          <button type="button"
            onClick={() => { setSelectionBar(null); openCompanion(passage.quote); }}>
            <Icon name="wand-sparkles" size={14} />问 AI
          </button>
        </div>
      )}
      {/* 提示条。`toast.action` 存在时多出按钮（撤销 / 查看）—— 它自己会关掉这条提示
          再执行，否则「点了撤销、提示还挂着」会让人以为没生效。
          ★ `action` 可以是数组（见 `notify`）：灵感速记的回执同时给「撤销 / 去看看」。
            这里统一折成数组再画，调用点多传一颗不需要改上面任何一处。 */}
      {toast && (
        <div role="status" aria-live="polite" className={`npr-toast${toast.isError ? ' is-error' : ''}`}>
          <span>{toast.message}</span>
          {(Array.isArray(toast.action) ? toast.action : toast.action ? [toast.action] : []).map((item) => (
            <button key={item.label} type="button" className="npr-toast-action"
              onClick={() => { setToast(undefined); clearTimeout(toastTimer.current); item.onClick(); }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
