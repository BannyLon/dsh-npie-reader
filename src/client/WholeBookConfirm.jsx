/**
 * 「翻译全本」的确认卡（0.78.0）。
 *
 * 为什么要多这一步 ---------------------------------------------------------
 * 「翻译全本」不是一次点击，而是一个**几十次模型调用、可能跑一小时**的后台任务。
 * 以前它点下去直接开跑：界面只回一句「整本 0/37 页」，用户不知道该等多久、
 * 也不知道能不能中途停 —— 只能赌一把，赌输了就再也不点。
 *
 * 这张卡回答三个问题，一个不多：
 *   ① 要翻多少（总页数 / 已有译文 / 本次要翻）；
 *   ② 大约多久（有实测用实测，没有用量级区间，并**明确标出是哪一种**）；
 *   ③ 开始之后会发生什么（后台跑、可以继续读、随时能停、已译不丢）。
 *
 * ★ 估算必须分成「实测」与「量级估算」两种说法。混成一句「约 20 分钟」，
 *   用户会拿它当承诺；而第一次翻某本书时我们手里根本没数据。
 * ★ Esc 用**捕获阶段** + `stopPropagation`：阅读器与设置页在别处也挂了 Esc
 *   （「关闭整页」那条）。冒泡阶段处理的话，一次 Esc 会连阅读页一起退出去。
 * ★ 默认焦点落在「再想想」而不是「开始翻译」：这是一颗要花钱的按钮，
 *   键盘上随手一个回车不该把它按下去。
 */
import { useEffect, useRef } from 'react';
import { Icon } from './icons.jsx';
import {
  estimateWholeBook, formatDuration, PAGE_MS_RANGE, translatedPageCount, useWholeBookJob,
} from './paper-translation.js';

/** 「约 7 – 24 分钟」：范围只保留一个「约」，重复两次读起来像两个人说话。 */
function rangeText(minMs, maxMs) {
  const clean = (value) => formatDuration(value).replace(/^约\s*/, '');
  return `约 ${clean(minMs)} – ${clean(maxMs)}`;
}

export function WholeBookConfirm({ bookId, title, total, onConfirm, onCancel }) {
  /**
   * 订阅整本书的任务快照只为拿**实测速率**（`msPerPage`）。
   * ★ 弹窗是独立小组件，重渲染成本可以忽略；把它挂到 2900 行的 `BookReader`
   *   上就又是「每页进度让整棵阅读器重跑」那个老问题。
   */
  const job = useWholeBookJob(bookId);
  const pages = Math.max(0, Math.round(Number(total) || 0));
  const cached = Math.min(translatedPageCount(bookId), pages);
  const estimate = estimateWholeBook({ total: pages, cached, msPerPage: job.msPerPage });
  const nothingLeft = estimate.pages === 0;
  const cancelRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', onKey, true);
    cancelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className="npr-wtc-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="npr-wtc" role="dialog" aria-modal="true"
        aria-label={`确认翻译整本《${title}》`}>
        <div className="npr-wtc-head">
          <span className="npr-wtc-glyph" aria-hidden="true"><Icon name="languages" size={17} /></span>
          <div className="npr-wtc-heading">
            <h3>翻译整本《{title}》</h3>
            <p>逐页交给当前模型翻译，译文存在本机 —— 以后打开就是中文。</p>
          </div>
        </div>

        <dl className="npr-wtc-stats">
          <div>
            <dt>总页数</dt>
            <dd>{pages}</dd>
          </div>
          <div>
            <dt>已有译文</dt>
            <dd>{cached}</dd>
          </div>
          <div>
            <dt>本次要翻</dt>
            <dd className="is-accent">{estimate.pages}</dd>
          </div>
        </dl>

        <p className={`npr-wtc-eta${nothingLeft ? ' is-done' : ''}`}>
          <Icon name="clock" size={14} />
          <strong>
            {nothingLeft
              ? '这本书已经全部译完了'
              : rangeText(estimate.minMs, estimate.maxMs)}
          </strong>
          <small>
            {nothingLeft
              ? '想重新翻一遍，先在翻译菜单里「清除译文」'
              : estimate.measured
                // ★ 实测与估算必须分开说：这句话是「这个数字可信到什么程度」的声明。
                ? `按这本书上次的实测速度估算（每页约 ${Math.max(1, Math.round(job.msPerPage / 1000))} 秒）`
                : `按每页 ${Math.round(PAGE_MS_RANGE.min / 1000)}–${Math.round(PAGE_MS_RANGE.max / 1000)} 秒估算，跑起来后会按实测速度修正`}
          </small>
        </p>

        <ul className="npr-wtc-notes">
          <li><Icon name="book-open" size={13} /><span>开始后可以继续翻页阅读，任务在后台一页页跑，进度在右上角。</span></li>
          <li><Icon name="pause" size={13} /><span>随时能停。已经译好的页留在本机，下次只补没译的。</span></li>
          <li><Icon name="info" size={13} /><span>每页一次模型调用；页数多时它在后台会持续一段时间。</span></li>
        </ul>

        <div className="npr-wtc-foot">
          <button type="button" className="npr-wtc-cancel" ref={cancelRef} onClick={onCancel}>
            再想想
          </button>
          <button type="button" className="npr-wtc-go" disabled={nothingLeft}
            onClick={() => { if (!nothingLeft) onConfirm(); }}>
            {nothingLeft ? '已全部译完' : '开始翻译'}
          </button>
        </div>
      </div>
    </div>
  );
}
