#!/usr/bin/env node
/**
 * strip-comments.mjs —— 把 JS / JSX / CSS 源码里的注释替换成等长空格（保留换行）。
 *
 * ★ 为什么需要一个**字符串感知**的剥离器，而不是一行 `replace(/\/\/.*$/gm, '')`：
 *
 *   静态守卫（`check-host-contract.mjs`、`test/window-drag.test.mjs`）的判据形如
 *   「代码里有没有出现 X」「代码里绝不能出现 Y」。而**注释里出现的 X 不是使用**。
 *   本项目为此踩过两次，症状都是**守卫报的是文档写得太详细，而不是代码有错**：
 *
 *     1. `test/window-drag.test.mjs`：文件头注释里抄着宿主规则原文（含 `[tabindex]`
 *        与 `-recall` 字样）⇒ `doesNotMatch` 变红。
 *     2. `scripts/check-host-contract.mjs`：`ReaderPage.jsx` 的 CSS 注释里抄了
 *        `html[data-platform=darwin] [data-window-drag-recall]{…}` ⇒ 锚点扫描把
 *        `data-platform` / `data-window-drag-recall` 当成「客户端用到的锚点」，
 *        报「没有归属登记」。
 *
 *   两次的修法都一样：**先剥注释，再扫描**。所以抽成一个模块，一处修、两处用。
 *
 * ★ 为什么不能图省事全局剥（实测过的两个反例，都在本仓库里）：
 *   - `src/host/service.js` 的 accept 头字符串里含「斜杠紧跟星号」的序列
 *     （`…;q=0.9,` 后面接 `*` 再接 `/` 再接 `*`）⇒ 全局剥块注释会从那里一路吃到
 *     下一个块注释收尾符，**静默吃掉大段真代码**。
 *   - `src/client/feed-urls.js` 里的正则字面量含**转义斜杠**（`^https?` 后面接
 *     `:\/\/`）⇒ 不认正则字面量就会把它当成行注释的起点。
 *   ⇒ 必须区分「代码位置」与「字符串 / 模板串 / 正则字面量内部」。
 *
 * ★ 模板串的特殊处理（本项目的关键一条）：
 *   本项目把 CSS 写在反引号模板串里（`const PANEL_CSS = \`…\``），而 CSS 的注释
 *   语法就是「斜杠星号 … 星号斜杠」—— 那条注释**必须被剥掉**，否则上面第 2 个坑
 *   依然存在。所以模板串内部按 CSS 的注释语法处理：
 *     - 「斜杠星号 … 星号斜杠」→ 剥掉（它是 CSS 注释）；
 *     - `//` → **不**剥（模板串里的 `//` 几乎只可能是 URL，且 CSS 没有这种注释）。
 *   `${…}` 里的内容回到代码模式，所以嵌套的模板串 / 字符串 / 正则都能正确处理。
 *
 * ★ 已知边界（诚实标注，别当它没有）：
 *   - JSX 的**裸文本**（`<span>看 http://x</span>`）既不是字符串也不是注释。
 *     这里靠「`//` 的前一个字符是 `:` 就不算注释」这条规则兜住 URL；其它形态的
 *     裸文本里出现 `//` 会被当注释截断。本项目实测无此形态。
 *   - 不做完整 JS 词法分析（不做 ASI 推断、不处理 JSX 与 JS 的模式差异）。
 *     判据是「够用且可验证」：`test/strip-comments.test.mjs` 用本仓库里的**真实
 *     样本**正反两面钉住它。
 */

/** 正则字面量可能出现的起始位置：这些符号之后的 `/` 是正则，不是除号。 */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>']);

/**
 * 剥掉注释，用等长空格替换（保留换行 ⇒ 行号、列号都还对得上）。
 *
 * @param {string} source
 * @param {{ collapse?: boolean }} [options]
 *   `collapse: true` ⇒ 注释**不占位**（直接丢弃）。
 *   ★ 为什么需要它：默认的「等长空格」是为了守住偏移，代价是长度不变；
 *   而 `test/build.test.mjs` 那条体积闸要量的是「运行期真正需要的字节数」，
 *   注释在浏览器里一个字符都不执行。用默认模式量体积等于**什么都没量到**。
 * @returns {string}
 */
export function stripComments(source, { collapse = false } = {}) {
  const out = [];
  const n = source.length;
  let i = 0;
  /** 上一个「有意义的」代码字符（跳过空白），用来判断 `/` 是不是正则开头。 */
  let prev = '';
  /** 模式栈：`code`（JS 代码位置）或 `template`（反引号串内部）。 */
  const stack = ['code'];

  const push = (ch) => {
    out.push(ch);
    if (!/\s/.test(ch)) prev = ch;
  };
  /** 把 `[i, end)` 替换成空格（或整段丢弃），换行原样保留。 */
  const blankTo = (end) => {
    for (; i < end; i += 1) {
      if (collapse) {
        if (source[i] !== '\n') continue;
        out.push('\n');
        continue;
      }
      out.push(source[i] === '\n' ? '\n' : ' ');
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // ---- 模板串内部：按 CSS 的注释语法剥 ----
    if (stack[stack.length - 1] === 'template') {
      if (ch === '\\') {
        push(ch);
        if (i + 1 < n) push(source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '`') { push(ch); i += 1; stack.pop(); continue; }
      if (ch === '$' && next === '{') { push(ch); push(next); i += 2; stack.push('code'); continue; }
      if (ch === '/' && next === '*') {
        const at = source.indexOf('*/', i + 2);
        blankTo(at === -1 ? n : at + 2);
        continue;
      }
      push(ch);
      i += 1;
      continue;
    }

    // ---- 代码位置 ----

    // 行注释。`prev !== ':'` 是为了放过裸文本里的 `http://`（见文件头的已知边界）。
    if (ch === '/' && next === '/' && prev !== ':') {
      const at = source.indexOf('\n', i);
      blankTo(at === -1 ? n : at);
      continue;
    }

    // 块注释。
    if (ch === '/' && next === '*') {
      const at = source.indexOf('*/', i + 2);
      blankTo(at === -1 ? n : at + 2);
      continue;
    }

    // 模板串：进入 template 模式（内部的 CSS 注释由上面那条分支处理）。
    if (ch === '`') { push(ch); i += 1; stack.push('template'); continue; }

    // 普通字符串：整体照抄，内部的 `//` 与「斜杠星号」都不是注释。
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === ch) { j += 1; break; }
        if (source[j] === '\n') break; // 不跨行：未闭合串交给构建器报错，别在这里猜
        j += 1;
      }
      for (; i < j; i += 1) push(source[i]);
      continue;
    }

    // 正则字面量：整体照抄，内部的转义斜杠不会被误判成 `//`。
    if (ch === '/' && (prev === '' || REGEX_PRECEDERS.has(prev))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { j += 1; closed = true; break; }
        else if (c === '\n') break; // 正则不跨行 ⇒ 认错了，退回普通字符
        j += 1;
      }
      if (!closed) { push(ch); i += 1; continue; }
      for (; i < j; i += 1) push(source[i]);
      continue;
    }

    // 从 `${…}` 里退出来：把 code 模式弹掉，回到外层模板串。
    if (ch === '}' && stack.length > 1 && stack[stack.length - 2] === 'template') {
      push(ch);
      i += 1;
      stack.pop();
      continue;
    }

    push(ch);
    i += 1;
  }

  return out.join('');
}
