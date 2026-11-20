/**
 * 电子书的「听本节」——**只接线，不造引擎**。
 *
 * ★ 这一层不实现任何合成、缓存、音色、计费：那些在 `../speech.js`（口径）、
 *   `speech-engine.js`（云端播放器）、`article-speech.js`（切块与本机选声音）里，
 *   文章阅读页已经跑了一年多。电子书与文章的唯一区别是**正文从哪来**：
 *   文章读 `proseRef.current.innerText`，电子书读 `blocksToText(section.blocks)`，
 *   两者都是纯文本，`speechChunks` 与 `createCloudPlayer.play(string[])` 原样可用。
 *
 * ★ 为什么把状态机单独抽成 `createEbookSpeech`（不依赖 React）：
 *   「无双声」「错误不吞」「切 tab 停播」这三件事留在 JSX 里就只能读源码断言。
 *   抽出来之后测试可以注入两个假引擎**真跑一遍**，这正是本项目反复吃的亏
 *   —— 存在性 ≠ 有效性。
 *
 * ── 读位 / 听位 ────────────────────────────────────────────────────────
 *   `page` 是**读位**（书架上恢复阅读用），听位单独存在 localStorage 的
 *   `npr.ebookListen.<bookId>`。控制器**从不写读位**：听着第 3 节、眼睛翻到
 *   第 9 节时，读位仍归翻页管，听位记住的是「上次听到第 3 节」。
 *   两者写成同一个值是最容易犯的错（shuting `ReaderView.tsx:384-387` 就犯了：
 *   注释写着互不干扰，代码里两组字段同时赋同一个 progress）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  pickVoice, speechChunksForReading, SPEECH_RATES,
  SPEECH_VOICE_KEY, SPEECH_RATE_KEY, SPEECH_PREFS_EVENT,
  writeSpeechPrefs,
} from './article-speech.js';
import { isPronunciationEnabled } from '../speech-pronunciation.js';
import {
  SPEECH_API_PREFIX, SPEECH_CLOUD_CHUNK, estimateSpeechCost,
  normalizeSpeechSpeed, parseSpeechVoice,
} from '../speech.js';
import { createCloudPlayer, fetchCloudAudio } from './speech-engine.js';

export const LISTEN_KEY_PREFIX = 'npr.ebookListen.';
/**
 * 朗读偏好的两个键**定义在 `article-speech.js`**（全插件唯一一份），这里只转发：
 * 设置页 / 阅读页 / 电子书页三处必须读写同一把键。
 */
export { SPEECH_VOICE_KEY, SPEECH_RATE_KEY, SPEECH_PREFS_EVENT };

/** 听位的存储键：按书分开，换书不会把上一本的听位带过来。 */
export function listenKey(bookId) {
  return `${LISTEN_KEY_PREFIX}${String(bookId ?? '')}`;
}

/**
 * 定时关闭的档位（分钟）。`0` = 不定时。
 *
 * ★ 档位固定而不是让用户填数字：睡前听书要的是「按一下就完」，弹个输入框
 *   问「多少分钟」在关灯之后根本点不准。15 分钟约一节、30 分钟约两节、
 *   60 分钟是一整章。
 */
export const SLEEP_STEPS = [0, 15, 30, 60];

/** 点一下换下一档：0 → 15 → 30 → 60 → 0。 */
export function nextSleepMinutes(current) {
  const at = SLEEP_STEPS.indexOf(Number(current));
  // 给了一个不在档位里的数（老版本存的值 / 手滑）⇒ 从第一档开始，不是回到「不定时」。
  if (at === -1) return SLEEP_STEPS[1];
  return SLEEP_STEPS[(at + 1) % SLEEP_STEPS.length];
}

/**
 * 语速档位：**只引用文章阅读页那一份**（`article-speech.js` 的 `SPEECH_RATES`）。
 *
 * ★ 不在本文件另写一份 `[0.85, 1, 1.3, 1.7]`：同一组档位手写两处，改一处忘另一处
 *   的结果是「文章页写着『很快』、电子书页写着『快』」，而两边读的是同一个
 *   localStorage 键 —— 界面互相打脸，代码本身却都对。
 */
export const SPEECH_RATE_STEPS = SPEECH_RATES;

/** 点一下换下一档：慢 → 正常 → 快 → 很快 → 慢。 */
export function nextSpeechRate(current, steps = SPEECH_RATE_STEPS) {
  const value = normalizeSpeechSpeed(current);
  const at = steps.findIndex((item) => item.rate === value);
  // 存着的老值不在档位里（比如手改过 localStorage）⇒ 从第一档开始，不是停在原地。
  if (at === -1) return steps[0].rate;
  return steps[(at + 1) % steps.length].rate;
}

/** 按钮上那个词。存着怪值时按「正常」显示 —— 与 `planOf` 实际用的 `|| 1` 一致。 */
export function speechRateLabel(rate, steps = SPEECH_RATE_STEPS) {
  const value = normalizeSpeechSpeed(rate);
  const found = steps.find((item) => item.rate === value);
  return found === undefined ? '' : found.label;
}

/**
 * 把一个任意数归到**档位上的值**：越界先 clamp，仍然不在档位里就回「正常」。
 *
 * ★ 读（`readSpeechRate`）和写（`applySpeechRate`）都过这一个函数。两边各写
 *   一份归一规则，就会出现「写进去的是 4、读出来的是 1」，而按钮标签与合成
 *   倍速各拿一个。
 */
function normalizeToStep(rate) {
  const value = normalizeSpeechSpeed(rate);
  return SPEECH_RATE_STEPS.some((item) => item.rate === value) ? value : 1;
}

/**
 * 从 localStorage 读语速。
 *
 * ★ 空值 / 越界 / **不在档位里**一律回到 1（「正常」）：这个值同时喂给
 *   `planOf`（真正合成时用的倍速）和按钮标签，必须同一口径。否则手改过
 *   localStorage 之后会出现「标签写着『正常』、实际按 4 倍念」。
 */
export function readSpeechRate(storage) {
  const raw = Number(storage?.getItem?.(SPEECH_RATE_KEY));
  return normalizeToStep(Number.isFinite(raw) && raw > 0 ? raw : 1);
}

/** 按钮上那句话。`0` 时说「定时」，其余说「N 分」。 */
export function sleepLabel(minutes) {
  const value = Math.max(0, Math.floor(Number(minutes) || 0));
  return value === 0 ? '定时' : `${value} 分`;
}

/**
 * 「换语速」这件事的全部判定，抽成纯函数以便真跑。
 *
 * ★ **正在听就先停**：语速是在 `player.play()` 那一刻交给引擎的（本机走
 *   `utter.rate`、云端走合成参数），播到一半改它不会变速 —— 不停的话用户
 *   点了「快」却听到原速，会认为按钮坏了。
 * ★ **停掉之后不自动续播**：云端缓存键是 `model+voice+speed+text` 的 sha1
 *   （`src/host/speech.js:53`），换了语速就是换了一把键，这一节必须重新合成、
 *   重新计费。自动重播等于「用户只点了一下语速，钱就花出去了」。
 *   这与「导出本节」先报价再动手是同一条原则：按钮不替用户花钱。
 * ★ 没在听的时候只改值、不弹提示：那是「预设」，不是一次操作的结果。
 *
 * @returns {{ rate: number, stopped: boolean, message: string }}
 *   `message === ''` 表示不需要打扰用户（没在听，或只是预设）。
 */
export function applySpeechRate({
  next, storage = null, controller = null, cloud = false, notify = () => {}, env = globalThis,
}) {
  const rate = normalizeToStep(next);
  // 写 + 广播：设置页与阅读页要跟着变（它们读的是同一把键）。
  writeSpeechPrefs(storage, { rate }, env);
  const stopped = controller !== null && controller.phase !== 'idle';
  if (stopped) controller.stop();
  if (!stopped) return { rate, stopped: false, message: '' };
  const message = `语速已改为「${speechRateLabel(rate)}」，朗读已停。`
    + '再点「听本节」按新语速从头听这一节'
    + (cloud ? '——云端会按新语速重新合成，这一段要重新计费。' : '。');
  notify(message);
  return { rate, stopped: true, message };
}

/**
 * 读听位。坏值 / 越界 / 没有 storage 一律回落到 `fallback`，**不抛**。
 * 老版本没有这个键 ⇒ 自然回落到当前读位，不需要迁移 data.json。
 */
export function readListenPage(storage, bookId, total, fallback = 1) {
  const raw = storage?.getItem?.(listenKey(bookId));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  if (Number.isInteger(total) && total > 0 && value > total) return fallback;
  return value;
}

/**
 * 「这一节该怎么念」——纯函数，所有会让人以为「按钮坏了」的分支都在这里显式给话。
 *
 * @returns {{ engine: 'cloud'|'local', voice: *, speed: number, chunks: string[], error: string }}
 *   `error !== ''` 时调用方必须把原话递给用户（**不许 `catch(() => undefined)` 吞掉**）。
 */
export function ebookSpeechPlan(text, {
  voiceValue = '', rate = 1, cloudConfigured = false, voices = [],
  cloudChunk = SPEECH_CLOUD_CHUNK, localChunk = 600, pronunciation = true,
} = {}) {
  const parsed = parseSpeechVoice(voiceValue);
  const speed = normalizeSpeechSpeed(rate);
  const source = String(text ?? '');

  if (parsed.engine === 'siliconflow') {
    // 没配 Key 时不许悄悄退回本机语音：用户选的就是那个音色，换掉等于骗他。
    if (!cloudConfigured) {
      return { engine: 'cloud', voice: null, speed, chunks: [],
        error: '云端朗读还没填 API Key。到「设置 → 朗读」里填一个硅基流动的 Key。' };
    }
    const chunks = speechChunksForReading(source, cloudChunk, pronunciation);
    if (chunks.length === 0) {
      return { engine: 'cloud', voice: null, speed, chunks: [], error: '这一节没有可朗读的正文' };
    }
    return { engine: 'cloud', voice: parsed.voice, speed, chunks, error: '' };
  }

  // 本机路：没有中文语音就明说，绝不退回英语（中文会被英语音素念成噪音）。
  const picked = pickVoice(voices, parsed.voice);
  if (picked === null) {
    return { engine: 'local', voice: null, speed, chunks: [],
      error: '这台机器没有中文语音，中文书读不了' };
  }
  const chunks = speechChunksForReading(source, localChunk, pronunciation);
  if (chunks.length === 0) {
    return { engine: 'local', voice: null, speed, chunks: [], error: '这一节没有可朗读的正文' };
  }
  return { engine: 'local', voice: picked, speed, chunks, error: '' };
}

/**
 * 本机 `speechSynthesis` 适配成与 `createCloudPlayer` **同样的五个方法**。
 *
 * ★ 为什么要适配：控制器只认一套接口，切换引擎时就不必写两份状态分支 ——
 *   两份分支正是「本机还在念、云端又开始念」这类双声的来源。
 * ★ 一次只 `speak()` 一块：Chromium 对超长 utterance 会静默截断，用户听完开头
 *   以为读完了。这条理由与 `ReaderPage.jsx:1915` 完全一致。
 */
export function createLocalEngine({ synth, makeUtterance, onState = () => {}, onError = () => {} }) {
  let run = null;
  return {
    play(chunks, { voice, speed }) {
      const token = { cancelled: false };
      run = token;
      const speakAt = (at) => {
        if (token.cancelled) return;
        if (at >= chunks.length) { run = null; onState('idle'); return; }
        let utter;
        try { utter = makeUtterance(chunks[at]); } catch (error) { run = null; onError(error); return; }
        utter.lang = voice?.lang ?? 'zh-CN';
        utter.rate = speed;
        const found = (synth.getVoices?.() ?? []).find(item => item.name === voice?.name);
        if (found) utter.voice = found;
        utter.onend = () => speakAt(at + 1);
        utter.onerror = () => {
          if (!token.cancelled) { run = null; onState('idle'); onError(new Error('这一段读不出来')); }
        };
        synth.speak(utter);
      };
      speakAt(0);
    },
    pause() { synth.pause?.(); },
    resume() { synth.resume?.(); },
    stop() {
      if (run !== null) run.cancelled = true;
      run = null;
      synth.cancel?.();
    },
    get active() { return run !== null; },
  };
}

/**
 * 与 React 无关的朗读状态机。两条引擎都注入，测试可以真跑。
 *
 * @param options.planOf - `(text) => plan`，由 `ebookSpeechPlan` 包一层当前设置。
 * @param options.onState - `(phase: 'idle'|'playing'|'paused') => void`
 * @param options.notify  - `(message, isError) => void`，错误文案的唯一出口。
 */
export function createEbookSpeech({
  getText, planOf, notify = () => {}, onState = () => {},
  cloud = null, local = null, storage = null, bookId = '',
  getPage = () => 1, onListenPage = () => {},
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
}) {
  let phase = 'idle';
  let engine = '';
  let disposed = false;
  /** 定时关闭的计时器与「还剩多少分钟」。两者必须同生同灭，否则标签会说谎。 */
  let timer = null;
  let sleepMinutes = 0;

  const setState = (next) => { phase = next; onState(next); };
  const active = () => (engine === 'cloud' ? cloud : engine === 'local' ? local : null);

  /** 两条路一起停 —— 只停当前那条，切换引擎时另一个还在响就是双声。 */
  function stop() {
    if (cloud !== null) cloud.stop();
    if (local !== null) local.stop();
    engine = '';
    if (phase !== 'idle') setState('idle');
  }

  /** 播完 / 播失败：回到 idle，但不碰听位（听的是哪一节已经记下了）。 */
  function finish() {
    engine = '';
    if (phase !== 'idle') setState('idle');
  }

  function fail(message) {
    stop();
    notify(message, true);
  }

  function toggle() {
    if (disposed) return;
    if (phase === 'playing') { active()?.pause(); setState('paused'); return; }
    if (phase === 'paused') { active()?.resume(); setState('playing'); return; }

    const plan = planOf(getText());
    if (plan.error !== '') { fail(plan.error); return; }
    const player = plan.engine === 'cloud' ? cloud : local;
    if (player === null) { fail('这个环境不支持朗读（没有语音合成能力）'); return; }

    // ★ 开播前先停两条：上一轮若因异常没走到 stop()，这里兜住，绝不叠声。
    stop();
    engine = plan.engine;

    // ★ 只写听位，不写读位。听位记的是「开始听的是哪一节」，翻页不会改它。
    const heard = getPage();
    onListenPage(heard);
    try { storage?.setItem?.(listenKey(bookId), String(heard)); } catch { /* 隐私模式下写不了，不影响听 */ }

    setState('playing');
    try { player.play(plan.chunks, { voice: plan.voice, speed: plan.speed }); } catch (error) {
      fail(error?.message ?? String(error));
    }
  }

  function clearSleepTimer() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  /**
   * 定时关闭。`0` 取消，其余是「从这一刻起 N 分钟后停」。
   *
   * ★ 计时从设定那一刻开始，**不等开播**：用户点「30 分」时本来就在听，
   *   要「再过 30 分钟」，不是「下一节开始后再数 30 分钟」。
   * ★ **重新点播放不重置计时**：否则每翻一页就续命，定时永远到不了。
   * ★ 到点时若已经在播完后的 idle 状态，就**静默清掉**、不弹提示 ——
   *   那时用户可能已经关灯躺下，一句「已停止朗读」只会把人吵醒。
   * ★ 不写 localStorage：定时是「这一次」的意图，重启后还按 30 分钟关掉
   *   更莫名其妙（且用户会怀疑插件在偷偷倒计时）。
   */
  function setSleep(minutes) {
    const value = Math.max(0, Math.floor(Number(minutes) || 0));
    clearSleepTimer();
    sleepMinutes = value;
    if (value === 0) return { minutes: 0 };
    timer = setTimer(() => {
      timer = null;
      sleepMinutes = 0;
      const wasPlaying = phase !== 'idle';
      stop();
      if (wasPlaying) notify(`定时 ${value} 分钟到了，已停止朗读`, false);
    }, value * 60_000);
    // 桌面端主进程里这个计时器不该拖住退出；浏览器里 `unref` 不存在，忽略即可。
    timer?.unref?.();
    return { minutes: value };
  }

  function dispose() { disposed = true; clearSleepTimer(); stop(); }

  return {
    toggle, stop, finish, dispose, setSleep,
    get phase() { return phase; },
    get engine() { return engine; },
    get sleepMinutes() { return sleepMinutes; },
  };
}

/**
 * React 薄封装：把设置、云端可用性、两种引擎接到状态机上，并负责**该停就停**。
 *
 * ★ 停播的三道门（缺一道就会「人已经翻走了，声音还在念上一节」）：
 *   ① 换节 / 换书；② 切到别的标签页（visibilitychange）；③ 组件卸载。
 *   只做 ③ 时，桌面端切 tab 不卸载组件，声音会一直响。
 */
export function useEbookSpeech({ bookId, page, text, total = 0, notify = () => {} }) {
  const storage = typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  const [phase, setPhase] = useState('idle');
  const [cloudOk, setCloudOk] = useState(false);
  const [voices, setVoices] = useState(() => globalThis.speechSynthesis?.getVoices?.() ?? []);
  const [listenPage, setListenPage] = useState(
    () => readListenPage(storage, bookId, total, page),
  );
  /** 定时关闭的档位（分钟）。0 = 没开。不持久化：这是「这一次」的意图。 */
  const [sleepMinutes, setSleepMinutes] = useState(0);
  /**
   * 语速。
   * ★ 与文章阅读页共用 `npr.speechRate` **同一个键**：在文章页调成「快」，
   *   进电子书就该还是「快」；在这里改完回文章页也一起变。两份各存一个键是
   *   最容易被忽略的串味 —— 用户会觉得「我明明调过」。
   */
  const [speechRate, setSpeechRateState] = useState(() => readSpeechRate(storage));

  // ★ 所有会被一次性闭包捕获的值都走 ref：点击那一刻创建的控制器不该锁死旧语速 /
  //   旧音色 / 旧正文，否则「播放中改语速没反应」「翻了页还在念旧节」。
  const latest = useRef({ text, page, total, cloudOk, voices });
  latest.current = { text, page, total, cloudOk, voices };
  const controllerRef = useRef(null);
  const cloudRef = useRef(null);
  const localRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${SPEECH_API_PREFIX}/config`, { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : null))
        .then(body => { if (!cancelled) setCloudOk(body?.configured === true); })
        .catch(() => { if (!cancelled) setCloudOk(false); });
    };
    load();
    globalThis.addEventListener?.('npr-settings-changed', load);
    return () => { cancelled = true; globalThis.removeEventListener?.('npr-settings-changed', load); };
  }, []);

  useEffect(() => {
    const synth = globalThis.speechSynthesis;
    if (!synth) return undefined;
    const sync = () => setVoices(synth.getVoices());
    sync();
    synth.addEventListener('voiceschanged', sync);
    return () => synth.removeEventListener('voiceschanged', sync);
  }, []);

  const ensureController = useCallback(() => {
    if (controllerRef.current !== null) return controllerRef.current;
    const synth = globalThis.speechSynthesis;
    const makeUtterance = (chunk) => new globalThis.SpeechSynthesisUtterance(chunk);

    if (synth && typeof globalThis.SpeechSynthesisUtterance === 'function') {
      localRef.current = createLocalEngine({
        synth, makeUtterance,
        onState: (next) => { if (next === 'idle') controllerRef.current?.finish(); },
        onError: (error) => { controllerRef.current?.finish(); notify(error?.message ?? String(error), true); },
      });
    }
    if (typeof Audio !== 'undefined') {
      cloudRef.current = createCloudPlayer({
        fetchAudio: (chunk, options) => fetchCloudAudio(SPEECH_API_PREFIX, chunk, options),
        onState: (next) => { if (next === 'idle') controllerRef.current?.finish(); },
        onError: (error) => { controllerRef.current?.finish(); notify(error.message, true); },
      });
    }

    controllerRef.current = createEbookSpeech({
      getText: () => latest.current.text,
      planOf: (value) => ebookSpeechPlan(value, {
        voiceValue: storage?.getItem?.(SPEECH_VOICE_KEY) ?? '',
        // ★ 与按钮标签同一个读者：`readSpeechRate` 会把不在档位里的值归到「正常」。
        rate: readSpeechRate(storage),
        cloudConfigured: latest.current.cloudOk,
        voices: latest.current.voices,
        pronunciation: isPronunciationEnabled(storage),
      }),
      notify,
      onState: setPhase,
      cloud: cloudRef.current,
      local: localRef.current,
      storage,
      bookId,
      getPage: () => latest.current.page,
      onListenPage: setListenPage,
    });
    return controllerRef.current;
  }, [bookId, notify, storage]);

  const toggle = useCallback(() => ensureController().toggle(), [ensureController]);
  const stop = useCallback(() => controllerRef.current?.stop(), []);

  /**
   * 定时关闭：`0` 取消，其余是「N 分钟后停」。
   * ★ 没在听的时候也允许设定：用户完全可以先定 30 分钟再点播放。
   */
  const sleep = useCallback((minutes) => {
    const value = Math.max(0, Math.floor(Number(minutes) || 0));
    setSleepMinutes(value);
    ensureController().setSleep(value);
  }, [ensureController]);

  /**
   * 语速会被**另一个页面**改（文章阅读页的 ⋯ 菜单写的是同一个键）。
   * 本组件不会因此重新挂载 ⇒ state 恒旧，而 `planOf` 是从 storage 现读的，
   * 于是出现「标签写着『正常』、实际念得很快」—— 界面说谎比报错更难查。
   * 翻页、窗口重新获得焦点、以及本页自己改完时都重读一次，两边才对得上。
   */
  useEffect(() => {
    const sync = () => setSpeechRateState(readSpeechRate(storage));
    sync();
    globalThis.addEventListener?.('focus', sync);
    globalThis.addEventListener?.('npr-speech-rate-changed', sync);
    return () => {
      globalThis.removeEventListener?.('focus', sync);
      globalThis.removeEventListener?.('npr-speech-rate-changed', sync);
    };
  }, [storage, page]);

  const changeRate = useCallback((next) => {
    const result = applySpeechRate({
      next,
      storage,
      controller: controllerRef.current,
      cloud: latest.current.cloudOk
        && parseSpeechVoice(storage?.getItem?.(SPEECH_VOICE_KEY) ?? '').engine === 'siliconflow',
      notify,
    });
    setSpeechRateState(result.rate);
  }, [notify, storage]);

  /**
   * 换书要把标签归零：控制器在 cleanup 里被 dispose（计时器随之清掉），
   * 但 `sleepMinutes` 这个 state 不会自己变 —— 不归零的话按钮还写着「30 分」，
   * 实际什么都不会发生。**依赖里不能带 `total`**：目录加载完也会改它，
   * 那会把用户刚设的定时顺手清掉。
   */
  useEffect(() => { setSleepMinutes(0); }, [bookId]);

  /**
   * ★ 换书 / 目录加载完要**重读听位**：`useState` 的初始化只在挂载时跑一次，
   *   不重读的话「上次听到第 N 节」会把上一本书的数字带过来，而界面毫无异常。
   * ★ 依赖里刻意**没有 page**：听位记的是「开始听的那一节」，翻页不该改它。
   */
  useEffect(() => {
    setListenPage(readListenPage(storage, bookId, total, latest.current.page));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, total, storage]);

  // ① 换节 / 换书：声音必须停在旧节上，不能跟着页面一起「念错」。
  useEffect(() => { stop(); }, [bookId, page, stop]);

  // ② 切 tab + ③ 卸载 / 换书。
  // ★ cleanup 必须依赖 bookId：控制器里存着 bookId，换书不重建的话，听位会被
  //   写进**上一本书**的 localStorage 键 —— 静默串味，比报错更难查。
  useEffect(() => {
    const onHidden = () => { if (globalThis.document?.hidden === true) stop(); };
    globalThis.document?.addEventListener?.('visibilitychange', onHidden);
    return () => {
      globalThis.document?.removeEventListener?.('visibilitychange', onHidden);
      controllerRef.current?.dispose();
      controllerRef.current = null;
      cloudRef.current = null;
      localRef.current = null;
    };
  }, [bookId, stop]);

  /** 按钮上的那句话。云端按字节计费，点之前就该知道这一节大约花多少。 */
  const hint = useMemo(() => {
    if (phase === 'playing') return '暂停朗读';
    if (phase === 'paused') return '继续朗读';
    const cloud = cloudOk && parseSpeechVoice(storage?.getItem?.(SPEECH_VOICE_KEY) ?? '').engine === 'siliconflow';
    if (!cloud) return `听这一节（本机语音，不花钱）· 上次听到第 ${listenPage} 节`;
    const cost = estimateSpeechCost(text);
    const money = cost < 0.01 ? '不到 1 分钱' : `约 ¥${cost.toFixed(2)}`;
    return `听这一节（云端${money}）· 上次听到第 ${listenPage} 节`;
  }, [phase, cloudOk, text, listenPage, storage]);

  return {
    phase, toggle, stop, sleep, sleepMinutes, listenPage, hint,
    speechRate, changeRate, rateText: speechRateLabel(speechRate),
  };
}
