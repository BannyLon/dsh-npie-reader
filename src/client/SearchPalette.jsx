/**
 * 跨源检索面板（0.88.0）。
 *
 * 一次查四处的意义：用户记得「我在哪儿看过信任是怎么被定价的」，但记不清是在
 * 一篇订阅文章、一本书、一篇论文，还是自己写的日记里。分四个搜索框，等于让他
 * 自己挨个试 —— 而他要的只是「带我回那一处」。
 *
 * ★ 为什么是**浮层 + ⌘K**，而不是把左侧那颗放大镜改成跨源：
 *   那颗放大镜的语义是「在当前列表里筛」。改成跨源之后，用户在订阅列表里按搜索
 *   会得到书和论文 —— 列表没变、内容全不是他要的。两个动作必须是两个入口。
 *
 * ★ 为什么键盘是**扁平**上下移动（跨组），而不是组内上下：
 *   分组只是视觉归类。如果 ↑↓ 出不了组，用户在「订阅 3 条」里按到底就停了，
 *   而他其实想看看日记里有没有 —— 那一刻没有任何提示告诉他下面还有。
 *
 * ★ 失败要**分开说**：宿主回的是「订阅这次没搜到（原因）」这种分组备注，面板
 *   原样显示在那一组的标题旁边。合并成一句「搜索失败」，用户就分不清是没结果
 *   还是没搜成 —— 而这两件事的下一步完全不同。
 *
 * ★ 取数（`SearchPalette`）与画面（`PaletteView`）分开，理由同 `WeeklyReport`：
 *   画面要能被 `renderToStaticMarkup` 直接渲染，否则测「文案与结构在不在」就得
 *   先把 `useEffect` + `fetch` 搬进测试环境。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons.jsx';

/** 输入防抖。250ms 是「停手就搜」与「别每敲一个字打一次全部数据源」的折中。 */
const DEBOUNCE_MS = 250;

/** 每一组标题右边那句「还有 N 条」。 */
function groupBadge(group) {
  const bits = [];
  if (group.total > 0) bits.push(`${group.total} 条`);
  if (group.hidden > 0) bits.push(`另有 ${group.hidden} 条未显示`);
  return bits.join(' · ');
}

/**
 * 面板的**画面**：输入框 + 四组结果 + 键盘高亮。
 *
 * 全部状态从外面来 —— 这样它可以在测试里被静态渲染。
 */
export function PaletteView({
  query, data, busy, error, active, placeholder, inputRef, onQuery, onKeyDown, onPick, onClose,
}) {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const showEmpty = data !== null && data.total === 0 && !busy && String(query ?? '').trim() !== '';
  // 扁平游标：分组只是视觉归类，键盘跨组走（见文件头）。
  let cursor = -1;

  return (
    <div className="npr-palette-scrim" role="presentation" onPointerDown={(event) => {
      // 点遮罩关闭。判 `target === currentTarget`：面板内部的点击不该冒到这里。
      if (event.target === event.currentTarget) onClose?.();
    }}>
      <div className="npr-palette" role="dialog" aria-modal="true" aria-label="跨源检索">
        <div className="npr-palette-head">
          <Icon name="search" size={15} />
          <input ref={inputRef} type="search" value={query ?? ''} placeholder={placeholder}
            aria-label="跨源检索" onChange={(event) => onQuery?.(event.target.value)} onKeyDown={onKeyDown} />
          {busy ? <span className="npr-palette-busy" role="status">搜索中…</span> : null}
          <button type="button" className="npr-palette-esc" title="关闭（Esc）" onClick={() => onClose?.()}>Esc</button>
        </div>

        {error !== '' && error !== undefined && error !== null ? (
          <p className="npr-palette-error" role="alert">{error}</p>
        ) : null}

        <div className="npr-palette-body">
          {String(query ?? '').trim() === '' ? (
            <p className="npr-palette-hint">
              输入一个词，四处一起找：订阅里的文章、书里的章节、论文、还有你写过的日记。
            </p>
          ) : null}

          {showEmpty ? (
            <p className="npr-palette-hint">
              「{String(query ?? '').trim()}」四处都没有。换个短一点的词试试 —— 中文不切词，短词更容易命中。
            </p>
          ) : null}

          {groups.map((group) => (
            group.hits.length === 0 && !group.note ? null : (
              <section key={group.kind} className="npr-palette-group">
                <header>
                  <h3>{group.label}</h3>
                  <span>{groupBadge(group)}</span>
                </header>
                {group.note ? <p className="npr-palette-note">{group.note}</p> : null}
                {group.hits.map((hit) => {
                  cursor += 1;
                  const index = cursor;
                  return (
                    <button key={hit.id} type="button"
                      className={`npr-palette-hit${index === active ? ' is-active' : ''}`}
                      aria-current={index === active ? 'true' : undefined}
                      onMouseEnter={() => onPick?.(null, index)}
                      onClick={() => onPick?.(hit.jump, index)}>
                      <span className="npr-palette-hit-title">{hit.title || hit.sub || '（无标题）'}</span>
                      {hit.sub ? <span className="npr-palette-hit-sub">{hit.sub}</span> : null}
                      {hit.snippet ? <span className="npr-palette-hit-snippet">{hit.snippet}</span> : null}
                      {/* 双链：「你在它下面写过 2 条」。这是这一页与「四个搜索框」的差别。 */}
                      {hit.links?.notes > 0 ? (
                        <span className="npr-palette-hit-link" title="你在它下面写过的条数">
                          写过 {hit.links.notes} 条
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </section>
            )
          ))}

          {data?.total > 0 ? (
            <p className="npr-palette-foot">
              共 {data.total} 条 · ↑↓ 选择 · ↵ 打开 · Esc 关闭
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 取数 + 键盘状态。 */
export function SearchPalette({ open, onClose, api, onJump, placeholder = '搜订阅、书、论文、日记…' }) {
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 扁平索引：↑↓ 用它，跨组移动。 */
  const [active, setActive] = useState(0);
  const ticket = useRef(0);
  const timer = useRef(0);
  const input = useRef(null);

  /** 打开时清空 + 把焦点放到输入框（下次打开是一张干净的面板，而不是残影）。 */
  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setData(null);
    setError('');
    setActive(0);
    // `setTimeout` 而不是直接 focus：这一帧浮层还在 `display:none` 到 `flex` 之间，
    // 直接 focus 在某些 Electron 版本上会被丢掉（面板开着但打字没进去）。
    const at = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(at);
  }, [open]);

  const run = useCallback(async (text) => {
    const needle = text.trim();
    if (needle === '') { setData(null); setBusy(false); setError(''); return; }
    const mine = ticket.current + 1;
    ticket.current = mine;
    setBusy(true);
    setError('');
    try {
      const result = await api.searchAll({ query: needle, limit: 5 });
      if (ticket.current !== mine) return;
      setData(result);
      setActive(0);
    } catch (failure) {
      if (ticket.current !== mine) return;
      setError(failure?.message ?? String(failure));
      setData(null);
    } finally {
      if (ticket.current === mine) setBusy(false);
    }
  }, [api]);

  // 输入防抖。关面板时清掉计时器，避免「面板关了还打一次全部数据源」。
  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void run(query); }, DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [open, query, run]);

  /** 四条分组拍平成一条可导航的列表。 */
  const flat = useMemo(() => {
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    return groups.flatMap((group) => group.hits.map((hit) => hit));
  }, [data]);

  useEffect(() => {
    if (active >= flat.length) setActive(flat.length === 0 ? 0 : flat.length - 1);
  }, [active, flat.length]);

  if (!open) return null;

  const jump = (target) => {
    if (!target) return;
    onJump?.(target);
    onClose?.();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); return; }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (flat.length === 0 ? 0 : Math.min(current + 1, flat.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      jump(flat[active]?.jump);
    }
  };

  return (
    <PaletteView
      query={query} data={data} busy={busy} error={error} active={active} placeholder={placeholder}
      inputRef={input}
      onQuery={setQuery} onKeyDown={onKeyDown}
      onPick={(target, index) => {
        // `target === null` 是鼠标悬停：只移动高亮，不跳转。
        if (target === null || target === undefined) { if (Number.isInteger(index)) setActive(index); return; }
        jump(target);
      }}
      onClose={onClose}
    />
  );
}
