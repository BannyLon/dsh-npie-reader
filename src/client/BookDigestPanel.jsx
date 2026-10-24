/**
 * 「本书目录 + 逐章解读」面板 —— 挂在**书页左边**（0.19.0 起；此前在右边）。
 *
 * ★ 与伴读面板**互斥占同一格**，不开第三列：阅读区的宽度是用户读正文用的，
 *   每多一列正文就窄一截（本项目已经因为「两列化之后每列变窄」踩过一次）。
 *   所以这一格在左、伴读也在左，两者不会同时出现。
 *
 * ★ 目录在**左**、正文在右，是电子书阅读器的通行摆法（也是用户提的要求）：
 *   视线从左上往下扫目录、再落到右边的正文，翻书时手不用跨过整页。
 *
 * ★ 五条文案纪律：
 *   1. **分段方式必须说清楚**。用户看到「19 章」会以为那就是书的目录，而实际上
 *      它可能是从目录页反查出来的、也可能是按 20 页硬切的。后者不能叫「章」。
 *   2. **扫描版要说「读不了」，不是「没有章节」**。这两种情况用户能做的事完全不同
 *      （前者要去 OCR，后者本来就没有章节）。
 *   3. **预检要报调用次数**。只写「可能需要一会儿」等于让用户闭眼刷卡。
 *   4. **跳过 ≠ 完成**。卷标题页这种没有正文的章标「略过」，不能算进「已解读」——
 *      否则「已解读 19/19」是一句确定的假话。
 *   5. **勾选数就是这次要花的钱**。按钮上的章数必须来自勾选，不是「待生成总数」；
 *      两个数字各算一遍，迟早出现「按钮说 3 章、勾了 5 个」。
 *
 * ★ 一个交互模型只能有一套：**点章节行 = 跳到那一页**（这是 0.17.0 就定下的），
 *   所以「看这一章的要点」必须是**另一个热区**（行右端的箭头），不能把行点击
 *   改成展开 —— 否则同一个位置在两版之间做两件不同的事，用户必然误解。
 *   0.19.0 加的勾选框是**第三个**热区，同样与行按钮是**兄弟**而不是嵌套：
 *   `<button>` 里套 `<input type="checkbox">` 是非法结构，点击归属在真机上也不确定。
 *
 * ★ 解读正文**不在这里渲染**（0.19.0 起）。306px 的栏里塞一段「总述 + 要点 +
 *   术语」，会把目录挤走大半，而用户本来是「一边看目录、一边看这章讲什么」。
 *   正文改由 `DigestCard.jsx` 浮在阅读区上。
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { aiModelOptions } from '../ai-model.js';
import { planDigestRun, planSelection } from './book-digest.js';
import { SkillExport } from './SkillExport.jsx';

/** 分段方式的用户话术。`window` 与 `scanned` 必须区别于「真章节」。 */
const MODE_LABEL = {
  outline: '来自这本书的 PDF 书签目录',
  toc: '来自书的目录页（按标题在正文里定位）',
  heading: '按章节标题识别',
  window: '这本书没有可识别的章节，按页分段',
  scanned: '扫描版：没有文字层',
};

/** 一段话说明「这些章节是从哪来的」，给 `title` 提示用。 */
const MODE_HINT = {
  outline: '页码直接取自 PDF 内置书签，最准确。',
  toc: '从书前的目录页读出条目标题，再在正文里反查起始页。',
  heading: '页面首行匹配「第 N 章 / Chapter N」这类标记。',
  window: '没有找到章节结构，按固定页数切开 —— 这里的「第 12–28 页」不是章名。',
  scanned: '整本都是图片，没有可抽取的文字。需要先做 OCR 才能解读。',
};

/** 章节状态的徽章文案。`pending` 刻意没有徽章（没开始就是常态，不该占位置）。 */
const STATUS_LABEL = {
  running: '生成中',
  failed: '失败',
  skipped: '略过',
  stale: '已过期',
};

/** 把字数说成人话（预检那一行用）。 */
function humanChars(chars) {
  if (!Number.isFinite(chars) || chars <= 0) return '0 字';
  if (chars < 10000) return `${Math.round(chars / 1000)} 千字`;
  return `${(chars / 10000).toFixed(1)} 万字`;
}

export function BookDigestPanel({
  book, meta, outline, job, currentPage,
  generating = false, expandedN = 0,
  selected = null, onToggleSelect, onSelectAll, onSelectNone,
  modelValue = '', modelCatalog = null, onModelChange,
  onStart, onClose, onJump, onRebuild,
  onGenerate, onStop, onToggleChapter, onNotify,
}) {
  const listRef = useRef(null);
  const activeRef = useRef(null);
  /**
   * 「现在就导出技能包」的信号（0 = 没请求过）。
   *
   * ★ 0.24.1：入口从**工具栏胶囊**搬到这一排（`生成解读` 右边）。用户原话：
   *   「把导出放在菜单条毫无意义……还不如在生成解读右边放一个 book-to-skill 的按钮」。
   *   胶囊那一格的问题不是位置不准，是**它离产出太远**：用户在目录面板里看到
   *   「已解读 59/59」，想把它变成技能包，眼睛在这一屏、手却要回到顶部去点一个
   *   跟「伴读 / 划线」平级的开关 —— 那组开关的语义是「切换视图」，不是「产出一个东西」。
   *
   * ★ 用**递增计数器**而不是布尔：布尔在「已经导出过、再点一次」时不会触发任何变化，
   *   用户会觉得按钮坏了。计数器每次 +1，`SkillExport` 的 effect 就会重新跑一遍。
   */
  const [skillSignal, setSkillSignal] = useState(0);

  // 打开面板时把当前章滚进视野。不用 `scrollIntoView`（它会把**整个页面**一起滚，
  // 阅读区跟着跳一下）—— 只调列表容器的 scrollTop。
  useEffect(() => {
    const list = listRef.current;
    const active = activeRef.current;
    if (!list || !active) return;
    const top = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
    list.scrollTop = Math.max(0, top);
  }, [outline]);

  const chapters = Array.isArray(outline) ? outline : [];
  const mode = meta?.mode ?? '';
  const isPan = book?.source === 'pan';
  const extracting = job?.running === true;
  const busy = extracting || generating;
  const plan = planDigestRun(meta);
  const done = plan.done;
  // ★ `selected == null` 时按「所有待生成的章」算，与 `BookReader` 的默认值**同源**
  //   （都来自 `planDigestRun`）。让调用方忘了传时面板自己也不会退化成「0 章可选」。
  const picked = new Set(selected ?? plan.todoN);
  const chosen = planSelection(meta, picked);
  const statusOf = (n) => meta?.chapters?.find(chapter => chapter.n === n)?.status;
  const errorOf = (n) => meta?.chapters?.find(chapter => chapter.n === n)?.error ?? '';
  const activeN = chapters.find(chapter => currentPage >= chapter.startPage && currentPage <= chapter.endPage)?.n ?? 0;
  // 这一次会跑哪几章（按勾选）。进度条与「这一批」计数都用它。
  const runTotal = Number.isFinite(meta?.task?.digestRunTotal) ? meta.task.digestRunTotal : 0;
  const runDone = Number.isFinite(meta?.task?.digestRunDone) ? meta.task.digestRunDone : 0;

  /**
   * 生成按钮上的字。
   *
   * ★ 三种情况必须说不同的话：勾中的章**全都没解读过**（生成）、**已经有一部分**
   *   （继续）、**全都解读过**（重做）。第三种是最贵的误会 —— 用户点「继续生成」，
   *   期待的是补上没做的，结果把已经花钱生成过的几章重跑一遍。
   */
  const generateLabel = chosen.count === 0
    ? '生成解读'
    : chosen.allDone
      ? `重新生成（${chosen.count} 章）`
      : done > 0 ? `继续生成（${chosen.count} 章）` : `生成解读（${chosen.count} 章）`;

  const models = aiModelOptions(modelCatalog);
  const defaultModelLabel = modelCatalog?.current
    ? `${modelCatalog.current.provider} · ${modelCatalog.current.model}`
    : '';
  // 「全选」= 勾上**这一次所有待生成的章**（`plan.todoN`），不是「勾上全书」：
  // 勾上已经解读过的章意味着重跑它们、再花一次钱，不该由一个「全选」按钮替用户做这个决定。
  const allTodoPicked = plan.todoN.length > 0 && plan.todoN.every(n => picked.has(n));
  /**
   * 还有没有「待生成」的章可勾。
   *
   * ★ 少了这个判据就是一个**假可点**的按钮：整本都解读完之后 `todoN` 是空集，
   *   而 `allTodoPicked` 的前置条件 `todoN.length > 0` 让它是 `false` ⇒「全选」
   *   保持高亮可点，点下去 `setSelectedN([])` 什么都不会变。用户看到的正是
   *   「全部解读完了，全选/全不选按不动」—— 而按钮一点也不灰，于是合理怀疑是坏了。
   *   可选集合为空 ⇒ 就该灰掉，并在 title 里说清楚「要重做某一章，直接勾它」。
   */
  const hasTodo = plan.todoN.length > 0;

  return (
    <aside className="npr-companion npr-book-digest" aria-label="本书目录">
      <header className="npr-companion-header">
        <Icon name="bookmark" size={14} />
        <strong>本书目录</strong>
        {chapters.length > 0 && (
          <button type="button" className="npr-icon" title="重新抽取（书换过文件时用）" aria-label="重新抽取"
            disabled={busy} onClick={onRebuild}><Icon name="refresh-cw" /></button>
        )}
        <button type="button" className="npr-icon" title="收起目录" aria-label="收起目录" onClick={onClose}><Icon name="x" /></button>
      </header>

      <div className="npr-companion-context">
        <strong title={book.title}>{book.title}</strong>
        <small>
          {extracting
            ? `正在抽取 ${job.done}/${job.total} 页…`
            : chapters.length > 0
              ? `${chapters.length} 章${meta?.pageCount ? ` · 共 ${meta.pageCount} 页` : ''}`
              : '还没有目录'}
        </small>
      </div>

      {extracting && (
        <div className="npr-digest-progress" role="status">
          <div className="npr-digest-bar"><i style={{ width: `${Math.round((job.done / Math.max(1, job.total)) * 100)}%` }} /></div>
          <small>{job.phase === 'segment' ? '正在切分章节…' : `抽取中 ${job.done}/${job.total}`}</small>
        </div>
      )}

      {job?.error && (
        <div className="npr-companion-error" role="alert">
          <strong>没有抽出目录</strong>
          <p>{job.error}</p>
          <button type="button" onClick={onStart}>重试</button>
        </div>
      )}

      {mode === 'scanned' && (
        <div className="npr-digest-empty" role="status">
          <Icon name="file-check" size={20} />
          <p>这本书是扫描版 —— 整本都是图片，没有可抽取的文字。</p>
          {/*
            ★ 「网盘书」与「本地书」的下一步**不是同一件事**：网盘上那份改不了，必须
              下载 → OCR → 作为「本地书源」加回来。以前这里只有一句「给它加一层文字，
              再重新打开」，网盘书的用户照做会卡在「我到底改的是哪个文件」。
          */}
          <small>
            {isPan
              ? '要用它做解读，得先在本地给它加一层文字（OCR，比如 ocrmypdf）：把这本书下载下来 → OCR → 再把 OCR 后的 PDF 作为「本地书源」加进来。网盘上那份没法原地改。'
              : '要用它做解读，得先拿 OCR 工具（比如 ocrmypdf）给这个文件加一层文字，再重新打开。'}
          </small>
        </div>
      )}

      {chapters.length === 0 && !extracting && mode !== 'scanned' && (
        <div className="npr-digest-empty" role="status">
          <Icon name="bookmark" size={20} />
          <p>还没有抽取这本书的目录。</p>
          <small>抽取只在本机做，不调用模型、不花钱。抽完才能知道这本书有几章。</small>
          <button type="button" className="npr-digest-start" onClick={onStart}>
            <Icon name="bookmark" size={14} /><span>抽取目录</span>
          </button>
        </div>
      )}

      {chapters.length > 0 && (
        <>
          <div className="npr-digest-mode" title={MODE_HINT[mode] ?? ''}>
            <Icon name="info" size={12} />
            <span>{MODE_LABEL[mode] ?? '未知来源'}</span>
          </div>

          {/* ---- 生成解读：勾选 → 预检 → 进度 ---- */}
          {generating ? (
            <div className="npr-digest-generate is-running" role="status">
              <div className="npr-digest-bar">
                {/* ★ 进度条量的是**这一批**（`digestRunDone/Total`），不是全书。
                    勾 2 章跑完时用全书口径画，条子会停在 2/19 一动不动 ——
                    用户看到的是「跑完了但条子没满」，只能自己猜。 */}
                <i style={{ width: `${Math.round(((runTotal > 0 ? runDone : done) / Math.max(1, runTotal > 0 ? runTotal : chapters.length)) * 100)}%` }} />
              </div>
              <div className="npr-digest-generate-line">
                <small>
                  {runTotal > 0
                    ? `这一批 ${runDone}/${runTotal} 章 · 全书已解读 ${done}/${chapters.length}`
                    : `已解读 ${done}/${chapters.length} 章`}
                </small>
                <button type="button" className="npr-digest-stop" onClick={onStop}>
                  <Icon name="x" size={12} /><span>停止</span>
                </button>
              </div>
              <small className="npr-digest-hint">生成在宿主后台跑，关掉这个面板也不会中断。</small>
            </div>
          ) : (
            <div className={`npr-digest-generate${chosen.count === 0 && plan.todo === 0 ? ' is-done' : ''}`}>
              <div className="npr-digest-select">
                {/* 计数文案随状态换：整本都解读完时「已选 0 章」是个**误导**——
                    它听起来像「你还没选」，而真实情况是「已经没有可选的章了」。
                    勾选框仍然在（那是重做单章的唯一入口），所以这里说「全部已解读」，
                    紧接着的提示会告诉用户勾上就是要重做。 */}
                <span className="npr-digest-select-count">
                  {chosen.count === 0 && !hasTodo
                    ? `全部 ${chapters.length} 章已解读`
                    : `已选 ${chosen.count} 章`}
                </span>
                <button type="button" className="npr-digest-link" onClick={onSelectAll}
                  disabled={!hasTodo || allTodoPicked}
                  title={hasTodo
                    ? '勾上这一次要生成的所有章节（已经解读过的不在其中）'
                    : '所有章节都解读过了。要重做哪一章，直接在下面目录里勾它'}>全选</button>
                <button type="button" className="npr-digest-link" onClick={onSelectNone}
                  disabled={chosen.count === 0}
                  title={chosen.count === 0 ? '现在没有勾选任何章节' : '清空勾选'}>全不选</button>
              </div>
              {/*
                * ★ 0.24.1：「book-to-skill」紧挨在「生成解读」右边，两者同一排。
                *   为什么放在这儿：这一排是用户**刚刚看完「已解读 59/59」**的地方，
                *   「把它变成技能包」是那句话最自然的下一步。放进顶部胶囊（0.24.0 的做法）
                *   等于把一个**产出动作**混进「伴读 / 划线 / 配色 / 沉浸」那组**视图开关**里 ——
                *   视觉同级会被读成语义同级。
                *
                * ★ 两个按钮**不同级**：左边是主按钮（accent 描边 + accent 字，会花钱跑模型），
                *   右边是次要动作（中性细描边 + muted 字，纯拼装不花钱）。
                *   靠视觉重量把「生成」与「拼装」分开 —— 做成同级会被读成「两个都要点一遍」。
                *
                * ★ 没有解读就**不能点**：技能包的内容就是已有的逐章解读，一章都没有时
                *   导出只会产出一个空索引 —— 那是最坏的结果（用户拿到一个「能装但没用」的包）。
                *   置灰必须配 title 说清为什么，否则用户只会觉得按钮坏了。
                */}
              <div className="npr-digest-actions">
                <button type="button" className="npr-digest-start" onClick={onGenerate}
                  disabled={extracting || chosen.count === 0}>
                  <Icon name="sparkles" size={14} />
                  <span>{generateLabel}</span>
                </button>
                <button type="button" className="npr-digest-skill"
                  disabled={done === 0}
                  onClick={() => setSkillSignal((value) => value + 1)}
                  title={done === 0
                    ? '还没有任何一章解读 —— 技能包就是把解读换个形状，先生成至少一章'
                    : `book-to-skill：把已解读的 ${done} 章拼成 SKILL.md（索引）+ 每章一份 + 术语表`}>
                  <Icon name="layers-3" size={13} />
                  <span>book-to-skill</span>
                </button>
              </div>
              {/* 预检：调用次数摆在最显眼处。只写「可能要一会儿」等于让用户闭眼刷卡。 */}
              {chosen.count > 0 ? (
                <small className="npr-digest-hint">
                  约 {humanChars(chosen.chars)}输入 · {chosen.calls} 次调用（最多 {chosen.maxCalls} 次，照抄重试会多一次）
                </small>
              ) : (
                <small className="npr-digest-hint">
                  {plan.todo === 0
                    ? '所有章节都解读过了。要重做某一章，先在目录里勾上它。'
                    : '先在上面勾选要解读的章节 —— 一本书几十章全跑一遍是很贵的。'}
                </small>
              )}
              {/* 已经有解读的章要能看到「多少好了」—— 否则「还剩 12 章」这句话
                  在「19 章里已好 7 章」和「一章都没好」两种情况下长得一模一样。 */}
              {done > 0 && (
                <small className="npr-digest-hint">
                  已解读 {done}/{chapters.length} 章
                  {plan.skipped > 0 ? ` · ${plan.skipped} 章没有正文，已略过` : ''}
                </small>
              )}
              {plan.failed > 0 && (
                <small className="npr-digest-hint is-warn">{plan.failed} 章上次失败，勾上再点一次会重试它们。</small>
              )}
              {/* ---- 这一次用哪个模型 ----
                  ★ 与设置页那个「翻译 / 改写用哪个模型」是**两个设置项**（`digestModel`
                    与 `aiModel`）：解读是一本书几十次调用，翻译是一篇一次，用户会想
                    给它们用不同的模型。这里选的值会写回 `digestModel`，下次打开还是它。 */}
              <label className="npr-digest-model">
                <span>模型</span>
                <select className="npr-ai-model" aria-label="这一次用哪个模型生成解读"
                  value={modelValue} disabled={modelCatalog === null}
                  onChange={(event) => onModelChange?.(event.target.value)}>
                  <option value="">跟随 Harness 默认模型{defaultModelLabel ? `（${defaultModelLabel}）` : ''}</option>
                  {models.map(entry => (entry.models.length > 0
                    ? <optgroup key={entry.id} label={entry.label}>
                        {entry.models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
                      </optgroup>
                    : <option key={entry.id} value={`__unavailable__${entry.id}`} disabled>
                        {entry.label}（没读到模型{entry.error ? `：${entry.error}` : ''}）
                      </option>))}
                </select>
              </label>
              {modelCatalog === null && <small className="npr-digest-hint">正在读取可用模型…</small>}
              {modelCatalog?.error && (
                <small className="npr-digest-hint is-warn">读不到模型列表：{modelCatalog.error}</small>
              )}
            </div>
          )}

          <ol className="npr-digest-list" ref={listRef}>
            {chapters.map(chapter => {
              const isActive = chapter.n === activeN;
              const status = statusOf(chapter.n);
              const expanded = expandedN === chapter.n;
              // 卷标题页（「上册」「第X部」）只占一页、正文两个字。它**仍然可点**
              // （跳过去看那一页是合理的），但不能显示成「p.6–6」—— 那看着像一章。
              const isSection = chapter.section === true;
              const canPeek = status === 'done';
              // 没正文的章勾了也不会生成（宿主会当场判 `skipped`）。与其让它「看着能勾、
              // 勾了没反应」，不如勾选框直接禁用并把原因写在 title 里。
              const selectable = status !== 'skipped' && status !== 'running' && !busy;
              const checked = picked.has(chapter.n);
              return (
                <li key={chapter.n} ref={isActive ? activeRef : null}
                  className={`npr-digest-item${expanded ? ' is-expanded' : ''}`}>
                  <div className="npr-digest-line">
                    {/* 勾选框是**第三个热区**，与行按钮平级（不能嵌进 button 里）。 */}
                    <input type="checkbox" className="npr-digest-check"
                      aria-label={`选择第 ${chapter.n} 章：${chapter.title}`}
                      title={status === 'skipped' ? '这一章没有正文，勾了也不会生成' : '勾上表示这一章要生成解读'}
                      checked={checked} disabled={!selectable}
                      onChange={() => onToggleSelect?.(chapter.n)} />
                    <button type="button"
                      className={`npr-digest-row${isActive ? ' is-active' : ''}${isSection ? ' is-section' : ''}`}
                      title={isSection ? `卷标题页（第 ${chapter.startPage} 页）` : `跳到第 ${chapter.startPage} 页`}
                      onClick={() => onJump(chapter.startPage)}>
                      <span className="npr-digest-n">{String(chapter.n).padStart(2, '0')}</span>
                      <span className="npr-digest-title">{chapter.title}</span>
                      {!isSection && <span className="npr-digest-page">p.{chapter.startPage}–{chapter.endPage}</span>}
                      {/* ★ `done` 用对勾、其它状态用文字徽章，是刻意的：
                          19 章混着 done / failed / pending 时，逐行状态正是要扫的东西；
                          给 running / failed / skipped / stale 都做了标记却漏掉最常见的
                          done，行上就会只剩「异常」，看不出「哪些已经好了」。 */}
                      {status === 'done' && !isSection && (
                        <span className="npr-digest-done" title="这一章已生成解读">
                          <Icon name="circle-check" size={12} />
                        </span>
                      )}
                      {STATUS_LABEL[status] !== undefined && (
                        <span className={`npr-digest-status is-${status}`}
                          title={status === 'failed' ? (errorOf(chapter.n) || '生成失败') : undefined}>
                          {STATUS_LABEL[status]}
                        </span>
                      )}
                    </button>
                    {/* 展开要点是**另一个热区**（兄弟，不嵌套）：点行永远是跳页。
                        ★ 正文渲染在阅读区上的浮层里（`DigestCard`），不在这个 306px 的
                          列表里 —— 见文件头。 */}
                    {canPeek && (
                      <button type="button" className="npr-digest-peek"
                        aria-expanded={expanded}
                        title={expanded ? '收起这一章的要点' : '看这一章的要点'}
                        onClick={() => onToggleChapter?.(chapter.n)}>
                        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {/* 导出放在**列表之后**：它是一次收尾动作，不是扫目录时会顺手点的东西。
              列表是 `flex: 1`，所以这一块稳定贴在面板底部，不随章数被推走。
              ★ 0.24.1：`runSignal` 是上面那颗「book-to-skill」递增的计数器 ——
                被点时这一块要自动摊开、滚进视野并跑一次导出（否则用户点完
                只会看到「什么都没发生」，因为这块长在列表最底下）。 */}
          <SkillExport
            bookId={book.id}
            digested={done}
            modelValue={modelValue}
            onNotify={onNotify}
            runSignal={skillSignal}
          />
        </>
      )}
    </aside>
  );
}
