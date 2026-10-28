/**
 * 日记编辑器的第三方底座：Milkdown 7（markdown 原生，ProseMirror 内核）。
 *
 * ★ 为什么是它，而不是更出名的几个（2026-10-27 用户第三次要求「去 GitHub 找一个好的」）：
 *
 *   用户的原话是「比如 stars 在 50000 以上的文本编辑器」。这个门槛在**可嵌入的
 *   编辑器库**里并不存在 —— 按 GitHub API 实测（当天）：
 *     quilljs/quill            47,374   WYSIWYG，HTML 输出
 *     microsoft/monaco-editor  46,897   代码编辑器（VS Code 那个），2 MB+
 *     codex-team/editor.js     31,977   块编辑器，JSON 输出
 *     facebook/lexical         23,987   WYSIWYG，HTML 输出
 *     wangeditor-team/wangEditor 18,356
 *     tinymce/tinymce          16,320
 *     Milkdown/milkdown        12,020   markdown 原生
 *   5 万以上的仓库（AppFlowy / AFFiNE / Joplin / Logseq）全是**完整应用**，不是库。
 *   所以真正的选择标准不是 stars，而是「它能不能保住我们的存储格式」：
 *   日记是**一天一个 .md 文件**，人可以拿编辑器直接打开读写。用 Quill / Lexical
 *   这类 HTML 编辑器，存回去要先 HTML→Markdown（turndown），一次往返就可能改掉
 *   用户写的 `#标签`、`---` 分隔线、空行。Milkdown 两头都是 markdown（remark 解析、
 *   remark 序列化），往返损耗最小 —— 这才是选它的理由。
 *
 * ★ 为什么这个文件单独打包、不进 `lib/client.js`：见 `src/library.js` 里
 *   `EDITOR_VENDOR_PREFIX` 的注释（体积闸 + 按需下载），与 pdf.js 同一条路。
 * ★ 这份产物**不依赖 react**（用的是 Milkdown 的 vanilla API），所以宿主那边
 *   直接 `import()` 一个 URL 就能跑，不需要模块解析器帮它找 react。
 */

import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core';
import {
  commonmark,
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  insertHrCommand,
} from '@milkdown/kit/preset/commonmark';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { replaceAll, getMarkdown, callCommand } from '@milkdown/kit/utils';

/**
 * 工具栏按钮 → Milkdown 命令。
 *
 * ★ 只映射**所见即所得里成立**的四个：粗体、斜体、小标题、列表、引用、分隔线。
 *   「标签」(`#` 前缀) 在这个编辑器里没有对应命令 —— 它插入的是纯文本 `#`，
 *   用户直接打字一样快，所以工具栏在富文本模式下不显示它（见 DiaryComposer）。
 * ★ 每个命令都包 try/catch：命令名对不上时应该是「这个按钮没反应」，
 *   而不是把整个编辑器抛崩 —— 后者会连带把用户正在写的内容一起带走。
 */
const COMMAND_MAP = {
  bold: toggleStrongCommand,
  italic: toggleEmphasisCommand,
  list: wrapInBulletListCommand,
  quote: wrapInBlockquoteCommand,
  rule: insertHrCommand,
};

/**
 * 在 `root` 里挂一个编辑器。
 *
 * @param {object} options
 * @param {HTMLElement} options.root - 挂载点（一个空的 div）。
 * @param {string} [options.value] - 初始 markdown。
 * @param {(markdown: string) => void} [options.onUpdate] - 每次内容变化（已去抖前的原文）。
 * @returns {Promise<{ destroy: () => void, setMarkdown: (md: string) => void, getMarkdown: () => string, focus: () => void }>}
 *
 * ★ `onUpdate` 只在**内容真的变了**时回调：`setMarkdown` 是我们自己写进去的，
 *   不该反过来通知一次 —— 否则「套用模板」会触发一轮「用户编辑」，
 *   上层拿到的 markdown 和被写进去的不一定逐字相同（序列化会规范化），
 *   于是一个点的按钮变成一次静默改写。
 */
export async function createDiaryEditor(options) {
  const root = options.root;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  let last = typeof options.value === 'string' ? options.value : '';
  /** 我们自己写进去的时候为 true —— 期间的变化回调一律吞掉。 */
  let quiet = false;

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, last);
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (quiet) return;
        if (markdown === last) return;
        last = markdown;
        onUpdate(markdown);
      });
    })
    .use(commonmark)
    .use(history)
    .use(listener)
    .create();

  return {
    destroy() {
      try {
        editor.destroy();
      } catch {
        /* 已经销毁过：React 严格模式下 effect 会跑两遍，这里不该抛。 */
      }
    },
    setMarkdown(markdown) {
      const next = typeof markdown === 'string' ? markdown : '';
      if (next === last) return;
      last = next;
      quiet = true;
      try {
        editor.action(replaceAll(next));
      } finally {
        // `replaceAll` 是同步的，但 listener 可能在同一拍里排队；
        // 用一个微任务再放开，确保这一轮的回调已经被吞掉。
        queueMicrotask(() => { quiet = false; });
      }
    },
    getMarkdown() {
      return editor.action(getMarkdown());
    },
    /**
     * 跑一条格式命令（工具栏用）。`id` 见上面的 `COMMAND_MAP`。
     * 未知 id 与命令执行失败都只是「没反应」，不抛 —— 理由见 `COMMAND_MAP` 上的注释。
     */
    run(id) {
      try {
        if (id === 'h2') {
          editor.action(callCommand(wrapInHeadingCommand.key, 2));
          return;
        }
        const command = COMMAND_MAP[id];
        if (command) editor.action(callCommand(command.key));
      } catch {
        /* 命令不可用：保持原样。 */
      }
    },
    focus() {
      const editable = root.querySelector('.ProseMirror');
      if (editable && typeof editable.focus === 'function') editable.focus();
    },
    /**
     * 在光标处插入一段 markdown（划线的「引用」与拖拽都走这里）。
     *
     * ★ 为什么必须有这个方法：上层拿到的只是 markdown 字符串，**不知道光标在哪**。
     *   没有它的话，「引用」只能追加到正文末尾 —— 用户选中第三段去点引用，
     *   引用块却跑到最后一页，那是一次静默的失败（看上去像「位置随机」）。
     * ★ `coords` 是拖拽落点的屏幕坐标。`posAtCoords` 拿不到位置时退回当前选区，
     *   而不是静默什么都不做。
     * ★ 全程吞错并返回 `false`：编辑器内部状态异常时，上层还有「textarea 退路」，
     *   不该让一次插入把整块写作区炸掉。
     */
    insert(markdown, coords) {
      const text = typeof markdown === 'string' ? markdown : '';
      if (text === '') return false;
      try {
        const view = editor.ctx.get(editorViewCtx);
        let at = view.state.selection.from;
        if (coords && Number.isFinite(coords.x) && Number.isFinite(coords.y)) {
          try {
            const found = view.posAtCoords({ left: coords.x, top: coords.y });
            if (found && Number.isInteger(found.pos)) at = found.pos;
          } catch {
            /* 落点算不出来就用光标位置 */
          }
        }
        view.dispatch(view.state.tr.insertText(text, at));
        view.focus();
        return true;
      } catch {
        return false;
      }
    },
  };
}
