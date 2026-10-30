import { useEffect, useState } from 'react';
import { SPEECH_API_PREFIX, SILICON_PRICE_PER_KB } from '../speech.js';
import { fetchCloudAudio } from './speech-engine.js';

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

  /** 试听：真发一次合成请求，出声就说明 Key 通了。 */
  const preview = async () => {
    setBusy(true);
    setMessage('');
    const url = { value: '' };
    try {
      const blob = await fetchCloudAudio(SPEECH_API_PREFIX, '试听一下，2026 年的秋天，AI 让阅读变快了吗？', {
        voice: config?.voiceDefault ?? 'claire',
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

  const configured = config?.configured === true;
  // 单价的两个口径都由常量算出来，不在这里写死数字
  const perKChar = (SILICON_PRICE_PER_KB * 3).toFixed(2);

  return <div className="npr-settings-card">
    <div className="npr-settings-card-head">
      <h3>朗读用的云端语音</h3>
      <p>
        本机的中文语音是采样拼接式的，试遍所有音色也只有「机器味」。云端神经语音是生成式的，
        自然得多 —— 代价是按字数计费（{SILICON_PRICE_PER_KB} 元/千字节，一个汉字 3 字节，
        约 {perKChar} 元/千字）。
      </p>
    </div>
    <div className="npr-service">
      <p className="npr-service-lead">
        这里只存一个<strong>硅基流动</strong>的 API Key，它保存在本机插件数据目录里，
        只由插件宿主进程读取；插件不会把它发到任何其他地方（合成请求直接发往
        <code>api.siliconflow.cn</code>）。
        <a className="npr-linkish" href="https://cloud.siliconflow.cn/account/ak" target="_blank" rel="noreferrer">去硅基流动控制台拿 Key</a>
      </p>
      {config === null && <p role="status">正在读取配置…</p>}
      {config?.error && <p className="npr-settings-hint">读不到配置：{config.error}（宿主那条路由可能没挂上，重启 DSH 再试）</p>}
      {config !== null && !config?.error && <>
        <div className="npr-service-row">
          <input
            type="password"
            aria-label="硅基流动 API Key"
            placeholder={configured ? `已配置（${config.masked}），要换就粘一个新的` : '粘贴 API Key（sk- 开头的一串）'}
            value={draft}
            autoComplete="off"
            onChange={(event) => { setDraft(event.target.value); setMessage(''); }} />
          <button type="button" disabled={busy || draft.trim() === ''} onClick={() => void write(draft.trim())}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button type="button" disabled={busy || !configured} onClick={() => void preview()}>试听</button>
        </div>
        <p className="npr-service-note">
          {configured
            ? <>已配置：<code>{config.masked}</code> · 模型 <code>{config.model}</code>
                <button type="button" className="npr-linkish" disabled={busy} onClick={() => void write('')}>清空这个 Key</button></>
            : '还没配。填上之后，阅读页的朗读面板里会多出一组「云端 · 更自然」的音色。'}
        </p>
      </>}
      {message && <div className="npr-service-probe" role="status">{message}</div>}
      <p className="npr-service-note">
        音频会缓存在本机（同一篇文章同一音色只合成一次），所以重听、暂停后继续都不再花钱。
      </p>
    </div>
  </div>;
}
