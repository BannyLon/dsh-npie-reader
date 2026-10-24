import { useEffect, useRef, useState } from 'react';

export function OpmlImport({ api, onDone, onCancel }) {
  const box = useRef(null);
  const [xml, setXml] = useState('');
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async (fn) => {
    setBusy(true); setMessage('');
    try { await fn(); } catch (error) { setMessage(error?.message ?? String(error)); }
    finally { setBusy(false); }
  };
  /*
   * ★ Esc 收起这块**内联**表单，关键是别让它冒泡到设置页：设置页在 `window` 上
   *   挂了「Esc = 关闭整页」，而这里可能已经选好了一串待导入的源。不拦的话，用户
   *   按 Esc 想退出导入，结果整个设置页关掉、已选的条目一起丢 —— 这是本轮要修的
   *   那个 bug（它以前根本没有 Esc 处理，Esc 直接穿到 window）。
   * ★ 只在焦点位于本表单内时响应（`box.contains`）：它不像模态那样独占交互，
   *   用户在设置页别处按 Esc 时，这里不该把事件吃掉。
   * ★ 导入进行中（`busy`）不响应：中途收起会让人以为没导进去。
   */
  useEffect(() => {
    const escape = (event) => {
      if (event.key !== 'Escape' || busy) return;
      if (!box.current?.contains(event.target)) return;
      event.stopPropagation();
      onCancel?.();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [busy, onCancel]);
  const inspect = (params) => run(async () => {
    const result = await api.opmlPreview(params);
    setPreview(result);
    setSelected(result.entries.filter((entry) => !entry.duplicate).map((entry) => entry.url));
  });
  const reset = () => { setPreview(null); setSelected([]); };
  const visible = preview?.entries.filter((entry) => `${entry.name} ${entry.group ?? ''} ${entry.url}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <fieldset className="npr-opml-import" disabled={busy} ref={box}>
    <legend>导入 OPML</legend>
    <input type="file" aria-label="选择 OPML 文件" accept=".opml,.xml,text/xml" onChange={(e) => {
      const file = e.target.files?.[0];
      if (file) void run(async () => {
        if (file.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB');
        const text = await file.text(); setXml(text); reset();
      });
    }} />
    <textarea aria-label="OPML 内容" placeholder="粘贴 OPML，或选择文件" rows={4} value={xml} onChange={(e) => { setXml(e.target.value); reset(); }} />
    <button type="button" className="npr-btn" disabled={!xml.trim()} onClick={() => void inspect({ xml })}>预览内容</button>
    <input aria-label="OPML 地址" placeholder="https://example.org/subscriptions.opml" value={url} onChange={(e) => { setUrl(e.target.value); reset(); }} />
    <button type="button" className="npr-btn" disabled={!url.trim()} onClick={() => void inspect({ url: url.trim() })}>从地址预览</button>
    {preview && <>
      <input aria-label="筛选导入订阅" placeholder="筛选名称、分组、地址" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="npr-row">
        <button type="button" className="npr-btn" onClick={() => setSelected(visible.filter((entry) => !entry.duplicate).map((entry) => entry.url))}>选择筛选结果</button>
        <button type="button" className="npr-btn" onClick={() => setSelected([])}>清空选择</button>
      </div>
      <div className="npr-opml-results">{visible.map((entry) => <label key={entry.url}>
        <input type="checkbox" disabled={entry.duplicate} checked={selected.includes(entry.url)} onChange={(e) => setSelected(e.target.checked ? [...selected,entry.url] : selected.filter((url) => url !== entry.url))} />
        {entry.name || entry.url} {entry.group && ` · ${entry.group}`} {entry.duplicate && '（已订阅）'}
      </label>)}</div>
      <button type="button" className="npr-btn" disabled={!selected.length} onClick={() => void run(async () => {
        const result = await api.opmlImport(preview.xml, selected);
        setMessage(`已导入 ${result.added} 项，跳过 ${result.skipped} 项。进入频道后会自动获取文章。`);
        reset(); await onDone();
      })}>导入所选（{selected.length}）</button>
    </>}
    {busy && <div role="status">处理中…</div>}
    {message && <div role="status">{message}</div>}
  </fieldset>;
}
