/**
 * 「这一集听到哪儿了」的本地记忆。
 *
 * ★ 为什么放 `localStorage` 而不是 `data.json`：播放位置每 5 秒变一次，而
 *   `data.json` 是**整份重写**（现在 8 MB）—— 一边听一边每 5 秒写 8 MB，
 *   是明确的性能悬崖。位置丢了只是「从头再听」，代价远小于把主数据文件写坏。
 * ★ 为什么不用宿主的文件存储：那要多一条路由、多一次 IPC，而收益只是「换台机器
 *   能接着听」—— 音频地址本身就在订阅源里，换机器的用户本来也要重新打开这一集。
 *
 * ★ 所有读写都吞异常：`localStorage` 在隐私模式/配额满时会**抛错**，而
 *   「记不住进度」绝不能升级成「播不了」。
 */

/** 键前缀。带上它，将来要清理这类记忆时能一把扫掉。 */
export const PROGRESS_PREFIX = 'npr.audio.';

/** 倍速档位。1 在中间：界面上左右各两档，符合「默认正常」的直觉。 */
export const RATE_CHOICES = Object.freeze([0.75, 1, 1.25, 1.5, 1.75, 2]);

/** 存进 localStorage 的键名。 */
export function progressKey(key) {
  return `${PROGRESS_PREFIX}${String(key ?? '')}`;
}

/**
 * 读到 `{ t, rate }`；没有/坏掉时给 `{ t: 0, rate: 1 }`。
 *
 * ★ 一定要校验 `rate`：它会被直接赋给 `element.playbackRate`，一个被改坏的
 *   `"abc"` 会让赋值静默无效（浏览器不抛错，只是继续用旧值），于是「倍速选了没反应」。
 */
export function readProgress(storage, key) {
  const fallback = { t: 0, rate: 1 };
  if (!storage || typeof key !== 'string' || key === '') return fallback;
  let raw;
  try {
    raw = storage.getItem(progressKey(key));
  } catch {
    return fallback;
  }
  if (typeof raw !== 'string' || raw === '') return fallback;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const t = Number(data?.t);
  const rate = Number(data?.rate);
  return {
    t: Number.isFinite(t) && t > 0 ? t : 0,
    // 只认档位表里的值：表外的数字（比如手工改成 3 倍）一律回到 1。
    rate: RATE_CHOICES.includes(rate) ? rate : 1,
  };
}

/**
 * 写回进度。返回是否写成功（判据要能区分「存了」和「静默失败」）。
 */
export function saveProgress(storage, key, { t, rate } = {}) {
  if (!storage || typeof key !== 'string' || key === '') return false;
  const time = Number(t);
  if (!Number.isFinite(time) || time < 0) return false;
  const speed = RATE_CHOICES.includes(Number(rate)) ? Number(rate) : 1;
  try {
    storage.setItem(progressKey(key), JSON.stringify({ t: Math.round(time * 10) / 10, rate: speed }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 恢复时该跳到哪一秒。
 *
 * ★ 三条边界都是实测会遇到的：
 *   ① 存的位置比总时长还靠后（换了一版音频、或上次在结尾关掉）⇒ 从头；
 *   ② 剩不到 5 秒 ⇒ 从头（否则一播放就结束，用户以为文件坏了）；
 *   ③ 3 秒以内 ⇒ 不恢复（几乎等于从头，跳一下只会让开头被削掉）。
 *
 * @param {{ t: number, rate: number }} saved
 * @param {number} duration - 总时长（秒），未知时给 0。
 */
export function resumeAt(saved, duration) {
  const time = Number(saved?.t);
  const total = Number(duration);
  if (!Number.isFinite(time) || time <= 3) return 0;
  if (Number.isFinite(total) && total > 0 && time > total - 5) return 0;
  return time;
}
