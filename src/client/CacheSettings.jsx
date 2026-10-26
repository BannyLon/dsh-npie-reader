/**
 * 设置页的「存储」卡（2026-10-25）。
 *
 * ── 为什么需要这张卡 ────────────────────────────────────────────────────
 *
 * 在这之前，插件在磁盘上攒东西的过程对用户是**完全不可见**的：解读缓存、
 * 网盘块缓存、`data.json.bak-*` 备份，三类加起来几十到几百 MB，界面上一个数字都没有。
 * 后果不是「不好看」，而是：
 *
 *   1. 用户不知道「清理」这件事存在，只能等磁盘满了才发现；
 *   2. 磁盘满的那一刻，界面上冒出的是 `ENOSPC: no space left on device` ——
 *      他既不知道是**这个插件**占的，也不知道该删什么。
 *
 * ⇒ 上限必须**看得见**（已用 / 上限），清理必须**点得到**，而且要说清楚
 *   「点这个按钮不会删掉我花钱生成的解读」—— 否则没人敢点。
 *
 * ── 三类缓存的区别（也是这张卡为什么分行显示）─────────────────────────
 *
 * | 类别 | 能不能重算 | 谁在管 |
 * | --- | --- | --- |
 * | 解读缓存 | 抽出的正文能重算，**解读不能**（要再调一次模型） | 512 MB 上限，超了自动清正文 |
 * | 网盘块缓存 | 能（重新下载） | 自己 1 GB 上限 + 整本淘汰，通常不用管 |
 * | 备份文件 | 就是垃圾 | 只留最近几份 |
 *
 * ★ 清理按钮只清「可重算的」那两类（正文 / OCR / 备份）。已生成的解读一个都不删：
 *   用户点的是「清理缓存」，不是「删掉我花过钱的解读」。要删解读得走「重新解读」，
 *   那里的文案会明确说会重新生成。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanCache, fetchCacheUsage } from './library-api.js';

export function CacheSettings({ notify = () => {} }) {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * ★ `busy` 挡不住**同一帧内的第二次点击**：`setBusy(true)` 要到下一帧才刷新闭包，
   *   两次点击在同一帧里都能读到 `false` ⇒ 会并发起两次清理（第二次在删的同时
   *   扫目录，数字会自相矛盾）。ref 是同步的，用它当闸门。
   *   （同 `BookReader` 的 `ocrBusyRef`，那条注释里记的是同一个坑。）
   */
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setUsage(await fetchCacheUsage());
      setError('');
    } catch (reason) {
      setError(String(reason?.message ?? reason));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clean = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNote('');
    try {
      const result = await cleanCache();
      if (result?.usage !== undefined && result.usage !== null) setUsage(result.usage);
      else await load();
      const freed = Number(result?.freed) || 0;
      const text = freed > 0
        ? `已清理，腾出 ${result.freedText ?? ''}`.trim()
        : '没有可清理的东西了（已生成的解读不参与清理）';
      setNote(text);
      notify(text);
      setError('');
    } catch (reason) {
      setError(String(reason?.message ?? reason));
    } finally {
      // 三件套的最后一件：无论成功失败都要复位，否则按钮会永久停在「正在清理…」。
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (usage === null) {
    return (
      <div className="npr-src-card">
        <p className="npr-src-sub">存储</p>
        {error === ''
          ? <p className="npr-src-hint" role="status">正在统计缓存占用…</p>
          : <p className="npr-src-hint is-bad" role="alert">{error}</p>}
      </div>
    );
  }

  const over = usage.over === true;
  return (
    <div className="npr-src-card">
      <p className="npr-src-sub">存储</p>
      <p className="npr-src-hint">
        解读缓存 <strong>{usage.digests?.text ?? '0 B'}</strong>
        {' / 上限 '}{usage.limitText ?? ''}
        {Number(usage.digests?.books) > 0 ? `（${usage.digests.books} 本）` : ''}
      </p>
      <p className="npr-src-hint">
        网盘块缓存 {usage.panCache?.text ?? '0 B'}
        {' · '}备份文件 {usage.backups?.text ?? '0 B'}
        {Number(usage.backups?.count) > 0 ? `（${usage.backups.count} 个）` : ''}
      </p>
      <p className="npr-src-hint">合计 {usage.totalText ?? '0 B'}。超过上限时会自动清掉最早那几本书抽出的正文，已生成的解读保留。</p>
      {over && (
        <p className="npr-src-hint is-bad" role="status">
          解读缓存已经超过上限：自动清理腾不出更多空间了（剩下的都是已生成的解读，不会自动删）。
        </p>
      )}
      {error !== '' && <p className="npr-src-hint is-bad" role="alert">{error}</p>}
      {note !== '' && <p className="npr-src-hint" role="status">{note}</p>}
      <div className="npr-src-actions">
        <button type="button" className="is-primary" disabled={busy} onClick={() => void clean()}>
          {busy ? '正在清理…' : '清理可重算的缓存'}
        </button>
      </div>
      <p className="npr-src-hint">清理只删「能从书上重新算出来的」东西（抽出的正文、扫描页识别结果、备份文件）。已生成的解读不动。</p>
    </div>
  );
}
