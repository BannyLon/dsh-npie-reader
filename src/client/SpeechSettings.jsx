import { useEffect, useMemo, useState } from 'react';
import {
  SPEECH_API_PREFIX, SILICON_PRICE_PER_KB, SILICON_VOICE_DEFAULT,
  parseSpeechVoice,
} from '../speech.js';
import { fetchCloudAudio } from './speech-engine.js';
import { PRONUNCIATION_KEY, PRONUNCIATION_RULES, isPronunciationEnabled } from '../speech-pronunciation.js';
import {
  SPEECH_VOICE_KEY, SPEECH_RATE_KEY, SPEECH_RATES,
  activeSpeechVoiceValue, speechVoiceGroups, writeSpeechPrefs,
} from './article-speech.js';

/** 试听用的那句话。两个试听按钮共用一份，免得「测 Key」和「试音色」念的不一样。 */
const PREVIEW_SENTENCE = '试听一下，2026 年的秋天，AI 让阅读变快了吗？';

/**
 * 「朗读」设置卡（0.55.0）。
 *
 * 这一屏只做一件事：**把云端朗读的 API Key 交给宿主**。
 *
 * ★ 为什么单独一个文件、而不是塞进 `SettingsPage.jsx`（已经 420 行）：这张卡有自己的
 *   三态（没读到 / 没配 / 已配）和自己的写入路由，塞进去会让那个文件的「保存设置」
 *   语义变得含糊 —— 那张卡的东西是**即时写盘**的，不跟着底部那个「保存设置」按钮走。
 * ★ 为什么界面上只显示掩码：`GET /speech/config` 只回 `maskApiKey()` 之后的形态。
 *   完整 Key 不出宿主进程 —— 这条边界写在 `service.js` 的 `publicSettings` 里。
 * ★ 为什么要给一个「试听」按钮：用户刚粘完 Key，最想知道的是「它到底能不能出声」。
 *   不给的话他得切回阅读页、打开面板、点试听 —— 而如果失败，他会以为 Key 没问题、
 *   是朗读功能坏了。
 */
export function SpeechSettings({ notify }) {
  /** `null` = 还在读；`{...}` = 读到了。 */
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  /** 发音修正开关存在浏览器本地，不进宿主配置：它只影响送合成的那串文本。 */
  const [pronEnabled, setPronEnabled] = useState(() => isPronunciationEnabled(globalThis.localStorage));

  /**
   * 朗读偏好（声音 / 语速）。0.76.1 从阅读页的 ⋯ 菜单搬上来一份。
   *
   * ★ 存的是**同一个 localStorage 键**，与阅读页、电子书页共用：这里是「偏好中心」，
   *   那两处是「就地快切」。两套各存一个键是最容易被忽略的串味 —— 用户在设置里
   *   选了云端音色，回阅读页还在用本机，而两边界面都看不出异常。
   * ★ 本机语音列表是异步填的（Chromium 首次 `getVoices()` 常返回空），所以要订阅
   *   `voiceschanged`；只读一次的话，先打开设置页的人会看到空下拉。
   */
  const [voices, setVoices] = useState(() => globalThis.speechSynthesis?.getVoices?.() ?? []);
  const [speechVoice, setSpeechVoice] = useState(
    () => globalThis.localStorage?.getItem?.(SPEECH_VOICE_KEY) ?? '',
  );
  const [speechRate, setSpeechRate] = useState(() => {
    const saved = Number(globalThis.localStorage?.getItem?.(SPEECH_RATE_KEY));
    return SPEECH_RATES.some((item) => item.rate === saved) ? saved : 1;
  });
  /** 偏好写入的反馈。与 Key 那条 message 分开：两者失败原因完全不同。 */
  const [prefNote, setPrefNote] = useState('');

  useEffect(() => {
    const synth = globalThis.speechSynthesis;
    if (!synth) return undefined;
    const sync = () => setVoices(synth.getVoices());
    sync();
    synth.addEventListener('voiceschanged', sync);
    return () => synth.removeEventListener('voiceschanged', sync);
  }, []);

  const voiceGroups = useMemo(
    () => speechVoiceGroups({ voices, cloud: config }),
    [voices, config],
  );
  /** 下拉里要显示的那一项（没选过时显示自动挑中的那个，而不是空）。 */
  const activeVoice = activeSpeechVoiceValue({ value: speechVoice, voices, cloud: config });

  /** 换声音：写盘 + 广播。写不进去（隐私模式）就如实说，下拉自动弹回旧项。 */
  const chooseVoice = (value) => {
    if (!writeSpeechPrefs(globalThis.localStorage, { voice: value })) {
      // 受控值不动 ⇒ 下拉立刻弹回原来那一项，和「没保存」是一致的
      setPrefNote('这个环境存不了设置（隐私模式 / 配额满），声音没改成。');
      return;
    }
    setSpeechVoice(value);
    setPrefNote('');
  };

  const chooseRate = (rate) => {
    if (!writeSpeechPrefs(globalThis.localStorage, { rate })) {
      setPrefNote('这个环境存不了设置（隐私模式 / 配额满），语速没改成。');
      return;
    }
    setSpeechRate(rate);
    setPrefNote('');
  };

  const load = async () => {
    try {
      const response = await fetch(`${SPEECH_API_PREFIX}/config`, { cache: 'no-store' });
      const body = await response.json();
      setConfig(body?.ok === true ? body : { configured: false });
    } catch (error) {
      setConfig({ configured: false, error: String(error?.message ?? error) });
    }
  };

  useEffect(() => { void load(); }, []);

  /**
   * 写入 / 清空 Key。
   *
   * ★ 成功后必须 `window.dispatchEvent(new Event('npr-settings-changed'))`：
   *   阅读页的朗读面板靠这个事件重新拉一次 `/config`。不派发的话，用户填完 Key
   *   回到阅读页，下拉里仍然没有云端音色 —— 他会认为「没保存成功」。
   */
  const write = async (value) => {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${SPEECH_API_PREFIX}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: value }),
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `保存失败（HTTP ${response.status}）`);
      setConfig(body);
      setDraft('');
      window.dispatchEvent(new Event('npr-settings-changed'));
      setMessage(value === '' ? '已清空 API Key' : '已保存。回阅读页打开朗读面板，声音下拉里会多出一组云端音色。');
    } catch (error) {
      setMessage(`保存失败：${error?.message ?? String(error)}`);
    } finally { setBusy(false); }
  };

  /** 测 Key：真发一次合成请求，出声就说明 Key 通了。固定用云端默认音色。 */
  const preview = async () => {
    setBusy(true);
    setMessage('');
    const url = { value: '' };
    try {
      const blob = await fetchCloudAudio(SPEECH_API_PREFIX, PREVIEW_SENTENCE, {
        voice: config?.voiceDefault ?? SILICON_VOICE_DEFAULT,
        speed: 1,
        signal: undefined,
      });
      url.value = URL.createObjectURL(blob);
      const audio = new Audio(url.value);
      await audio.play();
      setMessage('出声了就说明 Key 能用。');
    } catch (error) {
      setMessage(`试听失败：${error?.message ?? String(error)}`);
      notify?.(`试听失败：${error?.message ?? String(error)}`, true);
    } finally {
      setBusy(false);
      // ★ 延迟释放：立刻 revoke 会把还在播的那段掐掉
      setTimeout(() => { if (url.value !== '') URL.revokeObjectURL(url.value); }, 30_000);
    }
  };

  /**
   * 试听**当前选中的音色**（本机语音也能试）。
   *
   * ★ 与上面那个 `preview` 分工：那个验证「Key 通不通」，固定用云端默认音色；
   *   这个验证「我选的这个声音好不好听」。用户选本机音色时，前者帮不上忙 ——
   *   而设置页的声音下拉里同时装着两组，用户当然会想听一下再决定。
   */
  const previewVoice = async () => {
    const parsed = parseSpeechVoice(activeVoice || speechVoice);
    setBusy(true);
    setPrefNote('');
    if (parsed.engine === 'siliconflow') {
      const url = { value: '' };
      try {
        const blob = await fetchCloudAudio(SPEECH_API_PREFIX, PREVIEW_SENTENCE, {
          voice: parsed.voice || SILICON_VOICE_DEFAULT, speed: speechRate,
        });
        url.value = URL.createObjectURL(blob);
        const audio = new Audio(url.value);
        await audio.play();
        setPrefNote('正在用云端音色试听。');
      } catch (error) {
        setPrefNote(`试听失败：${error?.message ?? String(error)}`);
      } finally {
        setBusy(false);
        // ★ 延迟释放：立刻 revoke 会把还在播的那段掐掉
        setTimeout(() => { if (url.value !== '') URL.revokeObjectURL(url.value); }, 30_000);
      }
      return;
    }
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof globalThis.SpeechSynthesisUtterance !== 'function') {
      setBusy(false);
      setPrefNote('这个环境没有本机语音，只能试听云端音色。');
      return;
    }
    try {
      const utter = new globalThis.SpeechSynthesisUtterance(PREVIEW_SENTENCE);
      utter.lang = 'zh-CN';
      utter.rate = speechRate;
      const found = (synth.getVoices?.() ?? []).find((item) => item.name === parsed.voice);
      if (found) utter.voice = found;
      // 先 cancel：连点两次试听会叠着念（Chromium 的队列默认排队而不是替换）
      synth.cancel();
      synth.speak(utter);
      setPrefNote('正在用本机语音试听。');
    } catch (error) {
      setPrefNote(`试听失败：${error?.message ?? String(error)}`);
    } finally { setBusy(false); }
  };

  const configured = config?.configured === true;
  /** 配置读到了、且没报错 —— 输入框和按钮能不能用的唯一判据。 */
  const ready = config !== null && !config?.error;
  // 单价的两个口径都由常量算出来，不在这里写死数字
  const perKChar = (SILICON_PRICE_PER_KB * 3).toFixed(2);
  const hasVoiceOptions = voiceGroups.local.length > 0 || voiceGroups.remote.length > 0;

  /* 三段，一件事一组。
     ★ 0.76.1 及以前这里是一个 `.npr-service` 灰盒：Key、状态、缓存说明、声音、语速、
       多音字全在同一层，八件事一样重；灰盒还套在白卡上，正是本表别处批评过的
       「卡片套卡片」。
     ★ 现在只用设置页自己的语言：分组微标 + 细线（`.npr-set-group`）、自绘折角下拉
       （`.npr-set-field.is-select`）、灰槽浮白块（`.npr-segmented`）、开关
       （`.npr-switch`）。不新造视觉，也不再有橙色实心块。
     ★ 长解释收进 `<details>`：可见的只有「通没通 / 多少钱 / 怎么选」，点开才是
       「它凭什么不上传 / 词表长什么样」。 */
  return <div className="npr-settings-card npr-speech">
    {/* ① 云端语音：先回答「通没通」，再给输入口 */}
    <div className="npr-set-group">
      <p className="npr-set-group-title">
        云端语音
        <span className={`npr-speech-state ${configured ? 'is-on' : 'is-off'}`}>
          {config === null ? '读取中…' : configured ? '已连接' : '未配置'}
        </span>
      </p>
      {config?.error && (
        <p className="npr-settings-hint">
          读不到配置：{config.error}（宿主那条路由可能没挂上，重启 DSH 再试）
        </p>
      )}
      <div className="npr-speech-keyrow">
        <span className="npr-set-field npr-speech-key">
          <input
            type="password"
            aria-label="硅基流动 API Key"
            placeholder={configured ? '要换就粘一个新的 Key' : '粘贴 API Key（sk- 开头的一串）'}
            value={draft}
            autoComplete="off"
            disabled={!ready || busy}
            onChange={(event) => { setDraft(event.target.value); setMessage(''); }} />
        </span>
        <button type="button" className="npr-speech-save"
          disabled={!ready || busy || draft.trim() === ''}
          onClick={() => void write(draft.trim())}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="npr-speech-test"
          disabled={!ready || busy || !configured}
          onClick={() => void preview()}>
          {busy ? '测试中…' : '测 Key'}
        </button>
      </div>
      <p className="npr-speech-meta">
        {/* ★ 这一段必须包成**一个** span：里面的「·」和文字是多个文本节点，
            不包的话每个碎片都成了独立的 flex item，被 `gap` 各撑开 10px，
            整行凭空长出一截（第一版就是这样被挤到换行）。 */}
        <span>{configured
          ? <><code>{config?.masked}</code> · <code>{config?.model}</code> · 约 {perKChar} 元/千字</>
          : <>只存在本机插件目录，不上传别处 · 约 {perKChar} 元/千字</>}</span>
        <a className="npr-linkish" href="https://cloud.siliconflow.cn/account/ak" target="_blank" rel="noreferrer">去控制台拿 Key</a>
        {configured && (
          <button type="button" className="npr-linkish is-danger" disabled={busy} onClick={() => void write('')}>清空</button>
        )}
      </p>
      {message && <p className="npr-speech-probe" role="status">{message}</p>}
      <details className="npr-speech-more">
        <summary>Key 存在哪里，会不会重复计费</summary>
        <p>
          本机的中文语音是采样拼接式的，试遍所有音色也只有「机器味」；云端神经语音是生成式的，
          自然得多。代价是按字数计费（{SILICON_PRICE_PER_KB} 元/千字节，一个汉字 3 字节）。
        </p>
        <p>
          Key 保存在本机插件数据目录，只由插件宿主进程读取，合成请求直接发往
          <code>api.siliconflow.cn</code>，插件不会把它发到任何其他地方。
          合成出来的音频缓存在本机 —— 同一篇文章、同一音色、同一语速只合成一次，
          所以重听和「暂停后继续」都不再花钱。
        </p>
      </details>
    </div>

    {/* ② 朗读偏好：这里是**偏好中心**，阅读页的 ⋯ 菜单与电子书 FAB 的语速槽
        仍保留为「就地快切」（听着的时候想调，跳进来会先停播再重听）。
        三处读写同一把键，不会再出现「设置里选了 A、阅读页还在用 B」。 */}
    <div className="npr-set-group">
      <p className="npr-set-group-title">
        朗读偏好
        <span className="npr-speech-state">文章 · 电子书共用</span>
      </p>
      <div className="npr-speech-row">
        <span className="npr-speech-label">声音</span>
        {hasVoiceOptions ? <>
          <span className="npr-set-field is-select">
            <select aria-label="朗读声音"
              value={activeVoice}
              onChange={(event) => chooseVoice(event.target.value)}>
              {/* 选过云端音色、但 Key 后来被清空：如实说明，不静默跳到第一项 */}
              {activeVoice === '' && <option value="" disabled>（当前选的音色现在用不了）</option>}
              {voiceGroups.remote.length > 0 && (
                <optgroup label="云端 · 更自然（按字数计费）">
                  {voiceGroups.remote.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </optgroup>
              )}
              {voiceGroups.local.length > 0 && (
                <optgroup label="本机语音（免费 · 离线）">
                  {voiceGroups.local.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </span>
          <button type="button" className="npr-speech-test" disabled={busy} onClick={() => void previewVoice()}>试听</button>
        </> : (
          <p className="npr-settings-hint npr-speech-wide">
            这台机器没有中文语音，也还没配云端朗读。系统设置 → 辅助功能 → 朗读内容 →
            系统声音 → 管理声音，下载一个中文声音；或者在上面填一个硅基流动的 API Key。
          </p>
        )}
      </div>
      <div className="npr-speech-row npr-speech-row-rate" role="group" aria-label="朗读语速">
        <span className="npr-speech-label">语速</span>
        <div className="npr-segmented">
          {SPEECH_RATES.map((item) => (
            <button key={item.rate} type="button"
              aria-pressed={item.rate === speechRate}
              onClick={() => chooseRate(item.rate)}>
              {item.label}
            </button>
          ))}
        </div>
        <span className="npr-speech-value">{speechRate}×</span>
      </div>
      <p className="npr-speech-meta">
        改完立刻生效。语速不影响云端计费（按送去的文本字数算），但换语速后同一段会按新语速重新合成一次。
      </p>
      {prefNote && <p className="npr-speech-probe" role="status">{prefNote}</p>}
    </div>

    {/* ③ 念准多音字 */}
    <div className="npr-set-group">
      <p className="npr-set-group-title">念准多音字</p>
      <div className="npr-settings-toggle-row">
        <p className="npr-speech-toggle-note">
          默认打开。把「行李」「重庆」这类容易念错的词换成同音字再送进语音引擎（「行理」「崇庆」），
          屏幕上看到的正文、划线、笔记和导出一个字都不改。
        </p>
        <label className="npr-switch">
          <input
            type="checkbox"
            aria-label="念准多音字"
            checked={pronEnabled}
            onChange={(event) => {
              const next = event.target.checked;
              try { globalThis.localStorage?.setItem?.(PRONUNCIATION_KEY, next ? 'on' : 'off'); } catch { /* 隐私模式写不了，本次会话仍按界面状态走 */ }
              setPronEnabled(next);
              window.dispatchEvent(new Event('npr-settings-changed'));
            }} />
          <span />
        </label>
      </div>
      <details className="npr-speech-more">
        <summary>已收 {PRONUNCIATION_RULES.length} 条高把握的词</summary>
        <ul className="npr-speech-words">
          {PRONUNCIATION_RULES.map((rule) => (
            <li key={rule.from}><b>{rule.from}</b><span>→</span>{rule.to}</li>
          ))}
        </ul>
        <p>
          关掉之后，含这些词的段落第一次重听会重新合成一次，其他段落的缓存照旧命中；
          下次点朗读时生效。
        </p>
      </details>
    </div>
  </div>;
}
