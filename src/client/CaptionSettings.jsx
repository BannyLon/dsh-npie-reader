import { useCallback, useEffect, useState } from 'react';
import { Icon } from './icons.jsx';

/**
 * 「字幕与识别」设置（0.84.0）。
 *
 * 这一屏回答两个问题，各占一张卡：
 *   ① 字幕**翻成中文**走哪条路（Google 免费 / 模型 / 自动）
 *   ② 没有字幕时**怎么识别**（本机 Qwen3-ASR / 本机 Whisper / 云端）
 *
 * ★ 单独成文件而不是塞进 `SettingsPage.jsx`：那已经有 450 行，再放两块表单 + 一段
 *   环境探测就没法读了。而且这两块有**自己的请求**（`asrStatus`）与自己的写盘
 *   （`saveAsrConfig`），跟设置页那份 `pageOwnedPatch` 快照是两套写入者。
 * ★ 状态一律从宿主读（`asrStatus`），**不在客户端猜**：这台机器有没有 Ollama、
 *   有没有 ffmpeg、Key 填没填，只有宿主知道。猜错的表现是「界面说就绪，一点就报错」。
 */
export function CaptionSettings({ api, settings, onChange, notify }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await api.asrStatus();
      setInfo(status);
      setError('');
    } catch (issue) {
      setInfo(null);
      setError(String(issue?.message ?? issue));
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveKey = async () => {
    setBusy(true);
    try {
      const result = await api.saveAsrConfig(keyDraft);
      setKeyDraft('');
      await refresh();
      notify?.(result?.configured ? '已保存云端识别的 Key' : '已清空云端识别的 Key');
    } catch (issue) {
      notify?.(`保存失败：${issue?.message ?? String(issue)}`, true);
    } finally {
      setBusy(false);
    }
  };

  const engine = settings.asrEngine ?? '';
  const provider = settings.asrCloudProvider ?? 'groq';
  const providers = info?.cloud?.providers ?? [];
  const qwen = info?.ollama ?? {};

  /** 选项后缀：把「这台机器上这条能不能用」直接写在名字后面。 */
  const tag = (ready, missing) => (ready ? ' ✓' : missing ? `（${missing}）` : '');

  return <>
    <div className="npr-settings-card">
      <div className="npr-settings-card-head">
        <h3>字幕翻译</h3>
        <p>把英文（或其它语言）的字幕逐句译成中文。翻好的段落会存下来，同一集不会重复花钱。</p>
      </div>
      <div className="npr-set-list">
        <div className="npr-settings-model-row">
          <div>
            <h4>用哪个引擎翻</h4>
            <p>
              <strong>Google 翻译</strong>是免费接口，一集只要几百毫秒；但它在国内网络下<strong>整个域名不通</strong>，
              所以默认是「先 Google，不通再用模型」。模型翻译更懂术语与口播语气，但要花额度。
            </p>
          </div>
          <span className="npr-set-field is-select">
            <select aria-label="字幕翻译引擎" value={settings.subtitleTranslateEngine ?? 'auto'}
              onChange={(event) => onChange({ subtitleTranslateEngine: event.target.value })}>
              <option value="auto">自动（先 Google，不通用模型）</option>
              <option value="google">只用 Google（不花模型额度）</option>
              <option value="model">只用模型</option>
            </select>
          </span>
        </div>
        <div className="npr-settings-model-row">
          <div>
            <h4>模型翻译用哪个模型</h4>
            <p>
              与「阅读体验 › AI 与正文抓取」里那个翻译模型是<strong>同一个设置项</strong>
              {settings.aiModel ? `：当前 ${settings.aiModel}` : '：当前跟随 Harness 默认模型'}。要换具体模型请到那一屏选（那里有完整列表）。
            </p>
          </div>
        </div>
        <p className="npr-settings-hint">
          Google 翻译走的是免费网页接口，稳定性不由我们保证；它失败时，「自动」会立刻改用模型，并在字幕面板上说明这次用的是哪条路。
        </p>
      </div>
    </div>

    <div className="npr-settings-card">
      <div className="npr-settings-card-head">
        <h3>没有字幕时怎么识别</h3>
        <p>中文播客几乎都不带字幕文件。识别一集 80 分钟的节目，本机大约 3 分钟。</p>
      </div>

      {error ? <p className="npr-settings-hint" role="alert">读不到本机识别环境：{error}</p> : null}

      <div className="npr-set-list">
        <div className="npr-settings-model-row">
          <div>
            <h4>识别引擎</h4>
            <p>自动：有 Ollama 就用本机 Qwen3-ASR，否则用插件自管的 Whisper。</p>
          </div>
          <span className="npr-set-field is-select">
            <select aria-label="识别引擎" value={engine} onChange={(event) => onChange({ asrEngine: event.target.value })}>
              <option value="">自动选择</option>
              <option value="qwen">
                本机 Qwen3-ASR 0.6B{tag(qwen.hasModel, qwen.running ? '缺模型' : 'Ollama 没运行')}
              </option>
              <option value="whisper">
                本机 Whisper{tag(info?.whisperReady, '缺 ffmpeg 或模型')}
              </option>
              <option value="cloud">
                云端识别{tag(info?.cloud?.configured, '未填 Key')}
              </option>
            </select>
          </span>
        </div>

        {/* 环境事实摆出来，不只给一个「就绪」：用户需要知道去补哪一步。 */}
        {info ? (
          <ul className="npr-cap-facts">
            <li data-ok={qwen.running === true ? 'yes' : 'no'}>
              <Icon name={qwen.running ? 'circle-check' : 'circle'} size={14} />
              Ollama {qwen.running ? `在运行（${qwen.base}）` : '没在运行，装上之后执行 ollama serve'}
            </li>
            <li data-ok={qwen.hasModel === true ? 'yes' : 'no'}>
              <Icon name={qwen.hasModel ? 'circle-check' : 'circle'} size={14} />
              {qwen.hasModel ? `本机模型已就位：${qwen.model}` : `还差模型 ${qwen.recommend?.name ?? 'qwen3-asr:0.6b'}（约 1.0 GB）`}
            </li>
            <li data-ok={info.ffmpeg?.ok ? 'yes' : 'no'}>
              <Icon name={info.ffmpeg?.ok ? 'circle-check' : 'circle'} size={14} />
              ffmpeg {info.ffmpeg?.ok ? '已安装（解码与切片用）' : '没找到 —— 终端执行 brew install ffmpeg'}
            </li>
            <li data-ok={info.cloud?.configured ? 'yes' : 'no'}>
              <Icon name={info.cloud?.configured ? 'circle-check' : 'circle'} size={14} />
              云端识别 {info.cloud?.configured ? `已配置：${info.cloud.providerName}` : '未填 Key'}
            </li>
          </ul>
        ) : null}

        <div className="npr-settings-model-row">
          <div>
            <h4>云端识别服务商</h4>
            <p>{providers.find((item) => item.id === provider)?.hint ?? '选一个服务商，再把它的 Key 填在下面。'}</p>
          </div>
          <span className="npr-set-field is-select">
            <select aria-label="云端识别服务商" value={provider}
              onChange={(event) => onChange({ asrCloudProvider: event.target.value, asrModel: '', asrBaseUrl: '' })}>
              {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </span>
        </div>

        <div className="npr-settings-model-row">
          <div>
            <h4>云端识别的 Key</h4>
            <p>
              {provider === 'doubao'
                ? '豆包要两个值：App ID 与 Access Token，按「appid:token」填。'
                : '只保存在本机的插件设置里，界面上不会回显完整值。'}
            </p>
          </div>
          <span className="npr-set-field">
            <input type="password" aria-label="云端识别的 API Key" placeholder={info?.cloud?.configured ? '已配置（留空 = 不修改）' : '粘贴 Key'}
              value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} autoComplete="off" spellCheck={false} />
            <button type="button" disabled={busy || keyDraft.trim() === ''} onClick={() => void saveKey()}>
              {busy ? '保存中…' : '保存'}
            </button>
          </span>
        </div>

        {provider === 'custom' || provider === 'siliconflow' ? (
          <div className="npr-settings-model-row">
            <div>
              <h4>接口地址与模型名</h4>
              <p>留空就用服务商的预设。自建服务填到 <code>/v1</code> 为止（例如 http://localhost:8080/v1）。</p>
            </div>
            <span className="npr-set-field">
              <input aria-label="云端识别接口地址" placeholder={info?.cloud?.base || 'https://…/v1'}
                value={settings.asrBaseUrl ?? ''} onChange={(event) => onChange({ asrBaseUrl: event.target.value })} />
              <input aria-label="云端识别模型名" placeholder={info?.cloud?.model || 'whisper-1'}
                value={settings.asrModel ?? ''} onChange={(event) => onChange({ asrModel: event.target.value })} />
            </span>
          </div>
        ) : null}

        <p className="npr-settings-hint">
          <strong>云端识别会上传音频。</strong>选它之前请确认这一集的内容可以离开本机。
          本机两条路（Qwen3-ASR / Whisper）都不会发出任何音频。
          {provider === 'doubao' ? ' 豆包那条路要音频有公网地址（播客托管本身满足）。' : ''}
        </p>
      </div>
    </div>
  </>;
}
