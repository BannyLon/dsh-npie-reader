/**
 * 云端朗读的**播放引擎**（浏览器半区）。
 *
 * 为什么需要它，而不是「把整篇文章发给云端、拿回一个 mp3 丢给 `<audio>`」：
 *
 *   1. **首字延迟**。3000 字的文章整篇合成要好几秒，期间界面上什么都不发生，
 *      用户会以为按钮没反应。分块之后第一块几百毫秒就能出声。
 *   2. **失败只丢一块**。整篇一次请求，中途 500 就一个字都听不到；分块之后
 *      第 5 块失败，前 4 块已经听完了。
 *   3. **暂停/继续要落到"正在念的那一句"**。整篇一个 mp3 也能暂停，但那是
 *      「音频文件的暂停」，与「文章念到哪」无关。
 *
 * ★ 这个模块**不碰 `fetch` 也不碰 `Audio` 的实现**：两者都注入。原因是它有两件
 *   必须被真跑出来的行为 —— 「预取的那一块在 stop 之后不许再出声」和
 *   「一块失败要停在这里、不许跳过去继续念」—— 留在组件里就只能读源码断言。
 */

/**
 * @param {{
 *   fetchAudio: (text: string, options: { voice: string, speed: number, signal: AbortSignal }) => Promise<Blob>,
 *   createAudio?: () => HTMLAudioElement,
 *   onState?: (state: 'playing' | 'paused' | 'idle') => void,
 *   onError?: (error: Error) => void,
 * }} deps
 */
export function createCloudPlayer({ fetchAudio, createAudio, onState = () => {}, onError = () => {} }) {
  const audio = typeof createAudio === 'function' ? createAudio() : new Audio();

  /** 当前这一轮播放。`null` = 没在播。 */
  let run = null;

  function releaseUrls(target) {
    for (const url of target.urls) {
      try { URL.revokeObjectURL(url); } catch { /* 已经释放过 */ }
    }
    target.urls.clear();
  }

  /**
   * 收尾。
   *
   * ★ 必须 `removeAttribute('src')` + `load()`：只 `pause()` 的话，浏览器会继续
   *   预读那一段（在慢网络下白占带宽），而且下次 `src` 换成新值之前，旧的
   *   `currentTime` 还留着 —— 用户重新点朗读会从上一段的中间开始。
   */
  function teardown(target) {
    target.cancelled = true;
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch { /* 某些环境下 load() 会抛，不影响状态复位 */ }
    releaseUrls(target);
  }

  function fail(target, error) {
    // 已经被 stop / 换篇取消的那一轮，它的失败不该再冒出来打扰用户
    if (target.cancelled) return;
    teardown(target);
    if (run === target) run = null;
    onState('idle');
    onError(error instanceof Error ? error : new Error(String(error)));
  }

  /**
   * 取第 `index` 块的音频。同一块只取一次（预取与播放会同时要它）。
   */
  function fetchChunk(target, index) {
    const cached = target.blobs.get(index);
    if (cached !== undefined) return cached;
    const job = fetchAudio(target.chunks[index], {
      voice: target.options.voice,
      speed: target.options.speed,
      signal: target.controller.signal,
    });
    target.blobs.set(index, job);
    return job;
  }

  async function playAt(target, index) {
    if (target.cancelled) return;
    if (index >= target.chunks.length) {
      teardown(target);
      if (run === target) run = null;
      onState('idle');
      return;
    }
    target.index = index;
    // ★ 先要**当前**这一块，再顺手把下一块要起来：两件事的顺序不能反 ——
    //   反过来的话第一块要排在第二块之后，首字延迟平白多一次排队。
    //   两者都在 `await` 之前发起，所以是并行的。
    const current = fetchChunk(target, index);
    if (index + 1 < target.chunks.length) fetchChunk(target, index + 1).catch(() => {});
    let blob;
    try {
      blob = await current;
    } catch (error) {
      fail(target, error);
      return;
    }
    if (target.cancelled) return;
    const url = URL.createObjectURL(blob);
    target.urls.add(url);
    // 上一块的 URL 现在可以放了：音频已经换到新的 src
    for (const previous of target.urls) {
      if (previous !== url) {
        try { URL.revokeObjectURL(previous); } catch { /* 已释放 */ }
        target.urls.delete(previous);
      }
    }
    audio.src = url;
    try {
      await audio.play();
    } catch (error) {
      // ★ 这里最常见的失败是 autoplay 被拦（`NotAllowedError`）。不能静默吞掉：
      //   用户点的是「朗读」，什么声音都没有、也没有提示，他会以为功能坏了。
      fail(target, new Error(`播放被拦住了（${error?.name ?? '未知原因'}）。再点一次朗读按钮试试。`));
    }
  }

  audio.addEventListener('ended', () => {
    const target = run;
    if (target === null || target.cancelled) return;
    void playAt(target, target.index + 1);
  });

  audio.addEventListener('error', () => {
    const target = run;
    if (target === null || target.cancelled) return;
    fail(target, new Error('这一段音频放不出来（文件可能损坏）'));
  });

  return {
    /**
     * 从头播一批块。
     *
     * @param {string[]} chunks
     * @param {{ voice: string, speed: number }} options
     */
    play(chunks, options) {
      if (!Array.isArray(chunks) || chunks.length === 0) return;
      if (run !== null) {
        teardown(run);
        run = null;
      }
      const target = {
        chunks, options, index: -1, cancelled: false,
        controller: new AbortController(),
        urls: new Set(),
        blobs: new Map(),
      };
      run = target;
      onState('playing');
      void playAt(target, 0);
    },

    pause() {
      if (run === null) return;
      audio.pause();
      onState('paused');
    },

    resume() {
      if (run === null) return;
      void audio.play().then(() => onState('playing')).catch(() => {});
    },

    stop() {
      if (run !== null) {
        teardown(run);
        run = null;
      }
      onState('idle');
    },

    /** 正在播 / 暂停中（不是「有没有在念」—— 暂停也算「这一轮还在」）。 */
    get active() {
      return run !== null;
    },
  };
}

/**
 * 取一块云端音频。`POST /speech/synth` 回二进制。
 *
 * ★ 把**宿主**返回的错误文案原样抛出去：它已经是给人看的中文（「余额不足」
 *   「API Key 无效」），在这里再包一层只会把它盖成「请求失败」。
 */
export async function fetchCloudAudio(prefix, text, { voice, speed, signal }) {
  const response = await fetch(`${prefix}/synth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, voice, speed }),
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    let message = `合成失败（HTTP ${response.status}）`;
    try {
      const body = await response.json();
      if (typeof body?.error === 'string' && body.error !== '') message = body.error;
    } catch { /* 不是 JSON，就用状态码那句 */ }
    throw new Error(message);
  }
  return await response.blob();
}
