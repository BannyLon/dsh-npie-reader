/**
 * 「删掉这一天」的确认框（0.75.0）。
 *
 * 用户 2026-11-11：「我需要一个删除某天的全部记录」。
 *
 * ★ 为什么单独一个文件而不是写在 `DiaryApp.jsx` 里：
 *   `DiaryApp` 有 3800 行，在它里面新加的分支 SSR 冒烟跑不到（`wipe.open` 初值是
 *   `false`，那段 JSX 永远不执行）—— 而「某个 `const` 在声明之前被读」这类错误
 *   恰恰只在真的渲染时才会炸（0.47.0 就这么发出去过一次，131 条源码判据全绿，
 *   用户只看到白屏）。抽成受 props 驱动的组件，才能在测试里直接渲染它。
 *
 * ★ 为什么与便签上那种「原地变成确认删除」不同：那套做法适合「撕掉这一张」——
 *   代价是重写一句话。删一整天的代价是一天全没了，重量不同，确认也得不同：
 *   这里必须**逐条列出会少什么**（时间 + 类型 + 摘要），再给一个明确的红色动作。
 *   只写「共 4 条」没有信息量，用户想确认的恰恰是「那条有用的会不会被一起删」。
 *
 * ★ 读后感会被列出来并单独标一句：它和灵感存在同一个 `daily/*.md` 里
 *   （`kind: '读后感'`），删这一天的公开记录必然连它一起走；不说，就是删完才发现。
 *
 * ★ 文案里写明落点 `diary/_trash/`：这个动作可逆，而「可逆」必须写在按钮旁边，
 *   不能等用户来问「还能不能找回」。
 */
import { Modal } from './dialogs.jsx';
import { plainSnippet } from './diary-lines.js';

/**
 * @param {object} props
 * @param {string} props.date - 要删的那一天（`YYYY-MM-DD`）。
 * @param {'public'|'private'} props.side - 删哪一半。标题会跟着变。
 * @param {Array<object>} props.entries - 这一天将要被删掉的条目（`time` / `kind` / `body`）。
 * @param {number} [props.chars] - 合计字数。不给就不显示，不在这里自己算。
 * @param {number} [props.reflections] - 其中读后感的篇数（>0 才提醒）。
 * @param {boolean} [props.busy] - 请求飞行中：两个按钮都禁用，框不许关。
 * @param {string} [props.error] - 失败原因。**留在框里**，不要关掉框再报错。
 * @param {() => void} props.onCancel
 * @param {() => void} props.onConfirm
 */
export function WipeDayDialog({
  date, side, entries, chars = 0, reflections = 0,
  busy = false, error = '', onCancel, onConfirm,
}) {
  const list = Array.isArray(entries) ? entries : [];
  return (
    <Modal label="删掉这一天的全部记录" onClose={() => { if (!busy) onCancel?.(); }}>
      <h2>删掉 {date} 这一天的全部{side === 'private' ? '私密' : ''}记录？</h2>
      <p className="npr-wipe-lead">
        {list.length} 条 · {chars} 字
        {reflections > 0 && <span className="npr-wipe-flag">其中 {reflections} 篇读后感</span>}
      </p>
      <ul className="npr-wipe-list">
        {list.map((entry, index) => (
          <li key={`${entry.scope ?? 'public'}-${entry.index ?? index}`}>
            <span className="npr-wipe-when">{entry.time}</span>
            <span className="npr-wipe-kind">{entry.kind}</span>
            {/* ★ 摘要单行省略：确认框是用来「认出是哪一条」的，不是用来读全文的。
                `plainSnippet` 会把图片地址剥成「［图片］」—— 只有一张图的灵感
                因此也有标题，而不是一行空白。 */}
            <span className="npr-wipe-text">{plainSnippet(entry.body) || '（没有正文）'}</span>
          </li>
        ))}
      </ul>
      <p className="npr-wipe-note">
        这一天会从便签墙消失。文件不会被销毁 —— 它移到 <code>diary/_trash/</code>，
        想找回时从那里拿回来。图不会跟着删。
      </p>
      {error !== '' && <p className="npr-wipe-error" role="alert">{error}</p>}
      <div className="npr-modal-actions">
        <button type="button" disabled={busy} onClick={() => onCancel?.()}>取消</button>
        {/* ★ 按钮文案把条数说出来（「删掉这 4 条」）：动作与后果在同一行，
            比一个孤零零的「确定」更难误点。 */}
        <button type="button" className="npr-wipe-go" disabled={busy || list.length === 0}
          onClick={() => onConfirm?.()}>
          {busy ? '正在删…' : `删掉这 ${list.length} 条`}
        </button>
      </div>
    </Modal>
  );
}
