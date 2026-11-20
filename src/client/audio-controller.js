/**
 * 一个 `<audio>` 元素的**唯一控制面**。
 *
 * 为什么需要它，而不是让播放器与字幕面板各自去摸 DOM：
 * 两边都要「读当前时间 / 跳转」，各写一份 `element.currentTime` 的结果是两套节流、
 * 两套边界判定，于是「字幕高亮比声音慢半拍」这种问题只能在真机上撞见。
 *
 * ★ 这里**不认 React**：只收一个元素，收一个回调。所以在 `node:vm` 里塞一个假元素
 *   就能把「跳转越过总时长」这类边界真的跑出来（判据见 `test/media-dock.test.mjs`）。
 */

/** 高亮刷新的最小间隔（秒）。低于它就不通知：`timeupdate` 一秒四次，同一段会亮四次。 */
const EMIT_STEP_SECONDS = 0.15;

/**
 * 跳转的合法区间：不能为负，不能越过「可跳终点」。
 *
 * ★ 上界优先取 `seekable.end()`，`duration` 只作兜底（0.85.2）。
 *   `duration` 可以是**估算值**（moov 在尾部时要等取到尾部才更正），用一个偏大的
 *   上界会把目标放到浏览器实际跳不过去的位置，赋值被静默夹回 —— 用户看到的是
 *   「进度条拖到一半又弹回去」。`seekable` 是浏览器自己给的「允许放到哪儿」，
 *   用它与界面上的分母是同一个口径。
 */
function clampTime(element, seconds) {
  const target = Number(seconds);
  if (!Number.isFinite(target)) return 0;
  let upper = 0;
  try {
    const seekable = element.seekable;
    if (seekable && seekable.length > 0) {
      const end = Number(seekable.end(seekable.length - 1));
      if (Number.isFinite(end) && end > 0) upper = end;
    }
  } catch {
    // 取不到 `seekable` 就退到 duration。
  }
  if (upper <= 0) {
    const total = Number(element.duration);
    upper = Number.isFinite(total) && total > 0 ? total : Number.MAX_SAFE_INTEGER;
  }
  return Math.min(Math.max(target, 0), Math.max(upper - 0.25, 0));
}

/**
 * @param {HTMLAudioElement} element
 * @returns {{
 *   element: HTMLAudioElement,
 *   seek: (seconds: number, options?: { play?: boolean }) => number,
 *   nudge: (delta: number) => number,
 *   play: () => Promise<void>,
 *   pause: () => void,
 *   subscribe: (fn: (time: number) => void) => () => void,
 *   dispose: () => void,
 *   current: () => number,
 *   duration: () => number,
 * }}
 */
export function createAudioController(element) {
  if (element === null || typeof element !== 'object' || typeof element.addEventListener !== 'function') {
    throw new TypeError('audio-controller: 需要一个 audio 元素');
  }
  const listeners = new Set();
  let lastEmitted = Number.NaN;

  const emit = (force = false) => {
    const time = Number(element.currentTime);
    if (!Number.isFinite(time)) return;
    if (!force && Number.isFinite(lastEmitted) && Math.abs(time - lastEmitted) < EMIT_STEP_SECONDS) return;
    lastEmitted = time;
    for (const listener of listeners) {
      try {
        listener(time);
      } catch {
        // 订阅者自己的异常不该打断播放（也不该让其它订阅者收不到）。
      }
    }
  };

  const onTimeUpdate = () => emit(false);
  const onSeeked = () => emit(true);
  element.addEventListener('timeupdate', onTimeUpdate);
  element.addEventListener('seeked', onSeeked);

  /**
   * 还没落地的跳转目标（元数据没到的时候）。
   *
   * ★ 0.85.0：`preload="none"` + 用户还没点播放时，`readyState` 是 0。
   *   这时候给 `currentTime` 赋值，Chromium 抛 `InvalidStateError`。播客面板上
   *   「先拖进度条再播放」是最自然的动作之一，所以这条不是边角情况。
   */
  let pendingSeek = null;

  const onLoadedMetadata = () => {
    if (pendingSeek === null) return;
    const target = pendingSeek;
    pendingSeek = null;
    try {
      element.currentTime = target;
      emit(true);
    } catch {
      // 元数据到了还赋不上，说明这一集本身有问题；`error` 事件会另行报出来。
    }
  };
  element.addEventListener('loadedmetadata', onLoadedMetadata);

  const seek = (seconds, { play = true } = {}) => {
    const target = clampTime(element, seconds);
    /**
     * ★ 必须先 `load()` 再赋值（0.85.0）。
     *
     * `preload="none"` 时元素里还没有任何字节，`readyState === 0`。此时
     * `element.currentTime = t` 抛 `InvalidStateError`；原来这里裸赋值、调用方
     * 也没有 catch ⇒ 异常冒到 React 的事件回调里，`commitScrub` 后面的
     * `setScrubbing(null)` 不再执行 —— 滑块停在拖到的位置、音频却没跳。
     * 用户的感受就是「进度条拖不动」。
     *
     * `load()` 只是把请求发出去（同步返回），元数据到达后浏览器会自己按
     * 新的 `currentTime` 定位；万一仍赋不上（极短的竞态窗口），目标存进
     * `pendingSeek`，由 `loadedmetadata` 补一次。
     */
    if (element.readyState === 0 && typeof element.load === 'function') {
      try {
        element.load();
      } catch {
        // 加载失败会走 `error` 事件，这里不吞掉真正的原因。
      }
    }
    try {
      element.currentTime = target;
    } catch {
      pendingSeek = target;
    }
    // 跳到目标之后**立刻**通知一次：用户按的是「跳到 12:30」，高亮必须当场跟上，
    // 等下一个 `timeupdate` 才亮会让这一步看起来没生效。
    emit(true);
    if (play && typeof element.play === 'function') {
      // 自动播放可能被浏览器拒绝（没有用户手势时）。这不是错误，静默即可。
      Promise.resolve(element.play()).catch(() => {});
    }
    return target;
  };

  return {
    element,
    seek,
    /**
     * ★ 用闭包里的 `seek` 而不是 `this.seek`：界面上可能出现
     *   `const { nudge } = controller` 这种解构（按钮回调里很自然），
     *   那时 `this` 是 `undefined`，`nudge` 会抛 `Cannot read properties of undefined`。
     *   症状是「±15 秒按钮点了报错」，而 `seek` 本身好得很。
     */
    nudge(delta) {
      return seek(Number(element.currentTime) + Number(delta), { play: !element.paused });
    },
    play() {
      return Promise.resolve(element.play()).then(() => undefined).catch(() => undefined);
    },
    pause() {
      element.pause();
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      // 订阅当场给一次当前值：面板刚挂载时不该等到下一次 `timeupdate` 才高亮。
      // ★ 顺手把它记成「已经通知过的位置」，否则紧接着的一次 `timeupdate`（可能只差
      //   0.01 秒）会被当成新位置再通知一遍 —— 面板刚挂上就闪一下。
      const time = Number(element.currentTime);
      if (Number.isFinite(time)) {
        lastEmitted = time;
        listener(time);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      element.removeEventListener('timeupdate', onTimeUpdate);
      element.removeEventListener('seeked', onSeeked);
      element.removeEventListener('loadedmetadata', onLoadedMetadata);
      listeners.clear();
    },
    current() {
      return Number(element.currentTime) || 0;
    },
    duration() {
      return Number(element.duration) || 0;
    },
  };
}
