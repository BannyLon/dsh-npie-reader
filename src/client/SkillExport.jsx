/**
 * 「导出成技能包」—— 目录面板底部那一小块。
 *
 * ★ 这一块存在的理由，是用户 2026-10-23 那句质疑：
 *   「这个 skill 最强的是把一本书变成一个 skill，现在我们费劲增加的功能和伴读
 *     也没什么区别，只是批量解读。有必要做这个功能吗」
 *   逐章解读本身确实只是「批量解读」。把它变成**能被 agent 按需加载的 skill 包**
 *   之后，它才和伴读有了区别：伴读只看得到当前这一页，而这个包让模型能回答
 *   「第 7 章那个论点在第 12 章被推翻了吗」——跨章，且查询成本与答案成正比。
 *
 * ★ 三条文案纪律：
 *   1. **导出不花钱要说出来**。「导出」这个词在别处常常意味着一次模型调用，
 *      而这里默认是纯拼装（已有的解读换个形状）。不写清楚，用户不敢点。
 *   2. **花了钱的那一步要单独标出来**。「跨章综合」是唯一一次额外调用，
 *      所以它必须自己带价签（「多 1 次模型调用」），不能混在默认路径里。
 *   3. **导出的东西不会自动被谁用上**。它是一个普通目录，不会自己装进任何
 *      agent 的 skills 目录 —— 用户需要知道「还要拷一次」。
 *
 * ★ 异步忙碌态三件套（本项目已踩过的坑）：
 *   `finally` 复位 · `ref` 挡同帧双击（`disabled` 在同一帧里还没生效）·
 *   置灰必须配「正在…」文案（否则用户看到的是一个点不动的按钮，不知道在等什么）。
 *
 * ★★ 0.20.1：用户截图说「这个设计的太不明显了」。诊断下来不是配色问题，是**层级反了**：
 *   ① 最显眼的控件是那个占满剩余宽度的**下拉框**，而真正要点的「导出」只是一圈
 *      1px 描边 ⇒ 视线落在「选什么」而不是「做什么」。改：实心主按钮 + 下拉退回 30px。
 *   ② 折叠态只有一行术语（「导出成技能包」），不说点了会得到什么 ⇒ 补副标题。
 *   ③ `<details>` 的三角被 `list-style:none` 去掉了，于是折叠态**没有任何**展开线索
 *      ⇒ 自己补一个会转的 chevron。
 *   ⇒ 通用判据：一个动作区「不明显」，先量**视觉重量落在哪个控件上**，
 *     再问「不点开的人能不能看懂这一块是干什么的」。
 *
 * ★★ 0.24.0（用户：「还能再往上做三档，试一试吧」）：
 *   ① **入口**。0.20.1 解决了「点开之后看不看得懂」，但这一块仍然在目录面板的
 *      **最底下** —— 要先想到「打开目录」、再滚到底才看得见。
 *   ② **一键复制路径**。「已导出 …/skills/book-labc」原来只是纯文本，
 *      而下一步（拷到 agent 的 skills 目录）必然要用到完整路径。
 *   ③ **包体积**。`2/3 章` 说的是覆盖度，没说这份包有多大；而 `SKILL.md` 是
 *      **每次都进上下文**的那一份，它的体积才是用户在意的数字。
 *      ★ 统计行**复用**原来那行 hint，不新增一行：展开态在 306px 栏里只剩
 *        ~19px 余量，多一行就把导出按钮顶出面板（0.20.1 已经踩过一次）。
 *
 * ★★ 0.24.1（用户：「把导出放在菜单条毫无意义……还不如在生成解读右边放一个
 *    book-to-skill 的按钮」）：
 *   0.24.0 的入口放错了地方 —— 顶部胶囊那组是**视图开关**（伴读 / 划线 / 配色 / 沉浸），
 *   把一个**产出动作**塞进去，视觉同级就被读成语义同级；而且它离产出太远：用户
 *   在面板里刚看到「已解读 59/59」，手却要回到顶部去点一个跟「划线」平级的开关。
 *   ⇒ 入口搬到「生成解读」右边，并且**没有解读时不可点**（技能包的内容就是那些
 *   解读，一章都没有时导出只会产出一个空索引）。这一块仍然是唯一的导出实现。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { fetchSkillStatus, postExportSkill } from './library-api.js';

/** 书型下拉。`auto` 是默认值：按正文猜，并把依据写进 SKILL.md。 */
const PROFILE_OPTIONS = [
  { value: 'auto', label: '自动判断（按正文）' },
  { value: 'technical', label: '技术书 / 工具书' },
  { value: 'fiction', label: '小说 / 叙事' },
  { value: 'nonfiction', label: '非虚构 / 论述' },
];

/** 把绝对路径压成「最后两段」，完整路径放 `title` 里。306px 放不下绝对路径。 */
function shortDir(dir) {
  const parts = String(dir ?? '').split('/').filter(Boolean);
  if (parts.length <= 2) return dir;
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * 把元素滚进它**最近的滚动容器**的视野 —— 只动那个容器，不碰页面。
 *
 * ★ 为什么不用 `scrollIntoView`：它会把**所有**可滚祖先一起滚，包括页面本身，
 *   于是阅读区跟着跳一下（`BookDigestPanel` 里为同一件事记过一条）。
 *   这里用两个 rect 算差值，只改 `scrollTop`，被谁滚就只滚谁。
 * ★ 找不到滚动容器就什么都不做：说明这块本来就整屏可见，硬滚反而把它推走。
 */
function revealInScrollable(node, margin = 8) {
  let parent = node.parentElement;
  while (parent !== null) {
    const style = getComputedStyle(parent);
    const scrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll')
      && parent.scrollHeight > parent.clientHeight + 1;
    if (scrollable) {
      const box = node.getBoundingClientRect();
      const view = parent.getBoundingClientRect();
      if (box.bottom > view.bottom - margin) {
        parent.scrollTop += box.bottom - view.bottom + margin;
      } else if (box.top < view.top + margin) {
        parent.scrollTop -= view.top - box.top + margin;
      }
      return;
    }
    parent = parent.parentElement;
  }
}

/** 字节说成人话。skill 包通常几十到几百 KB，所以 KB 那一档保留一位小数。 */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 行数说成人话：四位数以上用 `k`，否则这一行在 306px 里放不下别的信息。 */
function humanLines(lines) {
  if (!Number.isFinite(lines) || lines <= 0) return '0 行';
  if (lines < 1000) return `${lines} 行`;
  return `${(lines / 1000).toFixed(1)}k 行`;
}

export function SkillExport({ bookId, digested = 0, modelValue = '', onNotify, runSignal = 0 }) {
  const [profile, setProfile] = useState('auto');
  const [synthesize, setSynthesize] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 同帧双击的闸。`disabled` 在 React 里要到下一帧才生效。 */
  const busyRef = useRef(false);
  const [last, setLast] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const detailsRef = useRef(null);
  const copyTimer = useRef(null);
  /** 已经处理过的 `runSignal` 值 —— 保证「一次点击只导一次」。 */
  const signalRef = useRef(0);

  // 打开面板时读一次「上次导出」—— 否则用户不知道这个功能已经用过了。
  useEffect(() => {
    let alive = true;
    if (typeof bookId !== 'string' || bookId === '') return undefined;
    fetchSkillStatus(bookId)
      .then((record) => { if (alive) setLast(record); })
      // 读不到就当没导出过：这一行是信息，不该变成一条红字。
      .catch(() => {});
    return () => { alive = false; };
  }, [bookId]);

  // 定时器要清：面板关掉时组件卸载，回调落在已卸载的组件上会报 warning。
  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  const run = useCallback(async () => {
    if (busyRef.current) return;
    if (digested === 0) {
      onNotify?.('这本书还没有任何一章解读过 —— 导出的内容就是那些解读，先在上面生成');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await postExportSkill(bookId, {
        profile,
        synthesize,
        ...(modelValue === '' ? {} : { model: modelValue }),
      });
      /*
       * ★ 导出后**重新读一次状态**，而不是直接用 POST 的返回。
       *   原因：POST 只回文件名（`files: [...keys]`），没有体积和行数 —— 而「这份包
       *   多大、SKILL.md 多沉」正是用户接着要判断的事（要不要整包拷过去）。
       *   读失败就退回 POST 的返回：统计行缺一块可以忍，「已导出」这一行不能因为
       *   一次读失败而消失（那会让用户以为导出没成）。
       */
      const fresh = await fetchSkillStatus(bookId).catch(() => null);
      setLast(fresh ?? {
        slug: result.slug,
        dir: result.dir,
        profile: result.profile,
        synthesized: result.synthesized,
        stats: result.stats,
        generatedAt: new Date().toISOString(),
      });
      // ★ 综合失败**不是**导出失败：包已经写好了，只是那两页是摘录。
      //   用 `notify`（信息）而不是 `error`（红字），否则用户以为整个导出白做了。
      if (result.synthesisError) {
        onNotify?.(`已导出，但跨章综合失败：${result.synthesisError}（两页横向文件退回原样摘录）`);
      } else {
        onNotify?.(`已导出到 ${shortDir(result.dir)}`);
      }
    } catch (err) {
      setError(err?.message ?? '导出失败');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bookId, digested, profile, synthesize, modelValue, onNotify]);

  /*
   * 目录面板里那颗「book-to-skill」（`BookDigestPanel`）被点时：摊开这一块 +
   * 滚进视野 + 直接跑一次导出。
   *
   * ★ 必须写在 `run` **之后**：依赖数组在渲染时求值，写在 `const run` 前面会
   *   撞上暂时性死区（`ReferenceError: Cannot access 'run' before initialization`）。
   * ★ 依赖里带 `run` 是**故意的**：它每次渲染都换引用，而 `signalRef` 保证
   *   「同一个信号只跑一次」—— 否则改一下书型下拉框就会重新导出一次。
   * ★ 用 `ref` 改 `<details>.open` 而不是自己存一份 state：展开/收起是浏览器的语义，
   *   `[open]` 属性同时是 CSS 的挂钩（chevron 旋转、副标题收起都靠它）。两个真相
   *   迟早出现「点开了但箭头没转」。
   * ★ 不滚动的话这颗按钮看起来**什么都没发生**：导出块长在面板最底下，章节列表一长
   *   它就在视野外。只滚**最近的滚动容器** —— 不能用 `scrollIntoView`，它会把整个
   *   页面一起滚，阅读区跟着跳（`BookDigestPanel` 里记过同一条）。
   */
  useEffect(() => {
    if (!(runSignal > 0)) return;
    if (signalRef.current === runSignal) return;
    signalRef.current = runSignal;
    const node = detailsRef.current;
    if (node !== null) {
      node.open = true;
      revealInScrollable(node);
    }
    run();
  }, [runSignal, run]);

  /** 复制**完整**路径（不是界面上那个缩短版）：下一步必然是 `cp -r` 它。 */
  const copyDir = useCallback(async () => {
    const dir = typeof last?.dir === 'string' ? last.dir : '';
    if (dir === '') return;
    try {
      await navigator.clipboard.writeText(dir);
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
      onNotify?.('已复制技能包的完整路径');
    } catch {
      // Electron 在窗口失焦 / 权限被撤时会拒。如实说，不假装成功。
      onNotify?.('复制失败：剪贴板不可用，请手动选中路径');
    }
  }, [last, onNotify]);

  /** 包内文件清单（宿主现读盘给的）。旧包没有这一项 —— 那就什么都不显示。 */
  const files = useMemo(() => (Array.isArray(last?.files) ? last.files : []), [last]);

  /**
   * 统计行：`SKILL.md 4.2 KB · 24 个文件 · 128 KB · 3.1k 行`。
   * ★ `SKILL.md` 单独拎出来，因为它是**每次都在上下文里**的那一份 —— 其余文件
   *   agent 只在需要时才读。把两者混成一个总数，用户就看不出「索引本身有多沉」。
   */
  const statLine = useMemo(() => {
    if (files.length === 0) return '';
    const totalBytes = files.reduce((sum, file) => sum + (Number.isFinite(file.bytes) ? file.bytes : 0), 0);
    const totalLines = files.reduce((sum, file) => sum + (Number.isFinite(file.lines) ? file.lines : 0), 0);
    const index = files.find(file => file.path === 'SKILL.md');
    const parts = [];
    if (index !== undefined) parts.push(`SKILL.md ${humanBytes(index.bytes)}`);
    parts.push(`${files.length} 个文件`);
    parts.push(`${humanBytes(totalBytes)} · ${humanLines(totalLines)}`);
    return parts.join(' · ');
  }, [files]);

  /** 统计行的 tooltip：逐个文件列出来。太长就截断，别做一个两屏高的提示。 */
  const filesTitle = useMemo(() => {
    if (files.length === 0) return undefined;
    const shown = files.slice(0, 14).map(file => `${file.path}  ${humanBytes(file.bytes)} · ${humanLines(file.lines)}`);
    if (files.length > 14) shown.push(`…还有 ${files.length - 14} 个`);
    return shown.join('\n');
  }, [files]);

  /*
   * 展开体里那行小字。三种内容按优先级选，**不新增行**：
   *   ① 勾了跨章综合 ⇒ 必须报「会多一次调用」（花钱的警告不能被统计行盖掉）；
   *   ② 有统计 ⇒ 显示体积；
   *   ③ 都没有 ⇒ 默认的「不花钱」说明。
   */
  const hint = synthesize
    ? '勾了跨章综合：导出时会多一次模型调用'
    : statLine !== '' ? statLine : '默认只拼装已有解读：不调模型、不花钱';

  return (
    /*
     * ★ 默认**折叠**，这是量出来的结论，不是审美：这一块展开后有六行内容，
     *   在 306px 的栏里实测高 **210px**，而目录面板（小窗口）只有 401px 高 ——
     *   它会把自己和章节列表一起撑爆：列表被压到 **12px**、导出块自己溢出面板 57px。
     *   折叠后它只占一行，列表还剩 3 行多。
     *   `<details>` 而不是自己写 state：展开/收起是浏览器给的语义，键盘、
     *   屏幕阅读器、`open` 属性都是现成的，自己写要补一堆。
     */
    <details className="npr-skill" ref={detailsRef}>
      {/*
       * ★ 这里原来还挂着一个 `npr-skill-head` 类名 —— 它**没有任何 CSS 规则**
       *   （summary 的样式全由 `.npr-skill > summary` 提供），于是 `check-classes`
       *   从 0.20.1 起每次都报「用到但未定义」并 exit 1，一红红了三十几个版本。
       *   一道**永远红**的门禁等于没有门禁：真出现新漏洞时没人会去看它。
       *   冗余属性直接删掉，而不是塞进白名单 —— 白名单是给「有意保留的语义钩子」的。
       */}
      <summary
        title="把已解读的章节拼成 SKILL.md（索引）+ 每章一个文件 + 术语表，让 agent 按需读某一章">
        <span className="npr-skill-icon"><Icon name="layers-3" size={13} /></span>
        {/*
         * ★★ 副标题必须在**折叠态**就可见。折叠才是默认状态 —— 把「点了会得到什么」
         *   只写进展开体，等于只讲给已经点开的人听，而没点开的人永远不知道。
         *   0.20.1 用户原话：「这个设计的太不明显了」——「不明显」的一半是**看不懂**。
         */}
        <span className="npr-skill-text">
          <span className="npr-skill-title">导出成技能包</span>
          <span className="npr-skill-sub">索引 + 每章一份 + 术语表，agent 按需读</span>
        </span>
        {/* 折叠时也要能看出「已经导出过了」—— 否则用户每次都要展开确认一次。 */}
        {last !== null && <span className="npr-skill-badge">已导出</span>}
        {/* ★ 展开指示器：`<details>` 去掉默认三角之后，折叠态里**没有任何**视觉线索
            说明「这块能点开」。有它才读得出「这里还有东西」。 */}
        <Icon name="chevron-down" size={13} className="npr-skill-chev" />
      </summary>

      <div className="npr-skill-body">
        <div className="npr-skill-row">
          <select className="npr-skill-profile" aria-label="这本书是什么类型"
            value={profile} disabled={busy}
            onChange={(event) => setProfile(event.target.value)}>
            {PROFILE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button type="button" className="npr-skill-go" disabled={busy} onClick={run}>
            <Icon name="download" size={13} />
            <span>{busy ? '正在导出…' : '导出'}</span>
          </button>
        </div>

        {/* ★ 唯一花钱的开关，价签写在它自己身上。 */}
        <label className="npr-skill-synth" title="默认只拼装已有解读，不调模型">
          <input type="checkbox" checked={synthesize} disabled={busy}
            onChange={(event) => setSynthesize(event.target.checked)} />
          <span>跨章综合（+1 次调用）</span>
        </label>
        {/*
         * ★ 展开体里**只放控件，不放说明文字**。这是量出来的：三行说明在 306px
         *   的栏里要占 60px，而小窗口的目录面板只有 401px —— 展开后整块 181px，
         *   底边比面板底还低 29px，导出按钮被裁在外面（点不到，也没有滚动条）。
         *   说明改挂 `title`，并且只留**一行**状态相关的短句。
         */}
        {/*
         * ★ 这一行原来写「不调模型，不花钱」，紧贴在勾选框下面 ⇒ 被读成
         *   **那个勾选框的注解**（而勾选框恰恰是唯一花钱的选项）。
         *   加「默认」二字并写明「只拼装已有解读」，它才明确指向整次导出。
         * ★ 0.24.0：导出过之后这一行换成包体积统计（`title` 里逐个文件列）。
         *   换内容而不是加一行 —— 展开态只剩 ~19px 余量，加一行就把按钮顶出去。
         */}
        <small className="npr-skill-hint" title={filesTitle}>{hint}</small>

        {error !== '' && (
          <div className="npr-skill-error" role="alert">
            <strong>没有导出</strong>
            <p>{error}</p>
          </div>
        )}

        {last !== null && (
          <div className="npr-skill-last"
            title={`${last.dir ?? ''}\n它是独立目录，不会自动装进任何 agent —— 要用就整个拷到那个 agent 的 skills 目录。`}>
            <Icon name="circle-check" size={12} />
            <span className="npr-skill-last-text">
              已导出 <code>{shortDir(last.dir)}</code>
              {last.stats ? ` · ${last.stats.digested}/${last.stats.chapters} 章` : ''}
              {last.synthesized ? ' · 含综合' : ''}
            </span>
            {/*
             * 复制按钮是这一行里的**第二个热区**，与那行文字平级（不是把整行做成按钮）：
             * 整行可点会把「读路径」和「复制」绑在一起 —— 用户想选中间某一段路径时
             * 一按就复制了整串。
             */}
            <button type="button" className={`npr-skill-copy${copied ? ' is-ok' : ''}`}
              title={copied ? '已复制完整路径' : '复制完整路径（拷到 agent 的 skills 目录时用）'}
              aria-label="复制技能包的完整路径" onClick={copyDir}>
              <Icon name={copied ? 'circle-check' : 'copy'} size={12} />
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
