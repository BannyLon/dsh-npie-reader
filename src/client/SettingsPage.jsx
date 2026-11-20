import { useEffect, useState } from 'react';
import { Icon } from './icons.jsx';
import { BRAND_TITLE, BRAND_ZH, SLOGAN_EN, SLOGAN_ZH } from './brand.js';
import { ReadingControls, ReadingSpecimen, ReadingReset } from './ReadingAppearance.jsx';
import { OpmlImport } from './OpmlImport.jsx';
import { SubscriptionManager } from './SubscriptionManager.jsx';
import { groupNamesOf } from './groups.js';
import { PromptManager } from './PromptManager.jsx';
import { AddFeedDialog } from './dialogs.jsx';
import { probeText } from './service-probe.js';
import { fetchBooks, reloadLibrary } from './library-api.js';
import { BookSources } from './BookSources.jsx';
import { CacheSettings } from './CacheSettings.jsx';
import { SpeechSettings } from './SpeechSettings.jsx';
import { CaptionSettings } from './CaptionSettings.jsx';
import { aiModelOptions, describeModelCatalog } from '../ai-model.js';
import { pageOwnedPatch } from './settings-patch.js';

const VERSION = typeof __NPIE_READER_VERSION__ === 'string' ? __NPIE_READER_VERSION__ : 'dev';

/**
 * 设置页的分类。
 * ★ 0.44.4 从「`[key, label, icon]` 三元组」改成对象：三元组只能靠**位置**记
 *   「第三项是图标」，读代码的人要多绕一层；而 `icons.test.mjs` 认的是
 *   「具名字段 + 字符串字面量」这种形态，三元组里那个名字它根本看不见。
 *   于是图标名打错只会静默兜底成 `circle`。
 * ★ 下面这条注释里**不要写成那个形态的样本**：测试扫的是源码原文，
 *   注释里的样本它一样会当成一个取值拿去核对（第一版就栽在这里）。
 */
const TABS = [
  { key: 'reading', label: '阅读体验', icon: 'book-open' },
  { key: 'library', label: '电子书书架', icon: 'layers-3' },
  { key: 'captions', label: '字幕与识别', icon: 'languages' },
  { key: 'speech', label: '朗读', icon: 'podcast' },
  { key: 'sources', label: '订阅管理', icon: 'rss' },
  { key: 'prompts', label: '快捷提示词', icon: 'sparkles' },
  { key: 'about', label: '关于', icon: 'info' },
];

/**
 * 「保存设置」提交什么：`pageOwnedPatch`（见 `./settings-patch.js`）。
 *
 * ★ 它**不在这里实现**，是因为这条判据必须能真跑 —— 组件是 JSX，node 的测试进程
 *   import 不了，只能退化成「源码里有没有某个字符串」，而那种断言答不了
 *   「这份 patch 会不会把别人刚写的数据盖掉」。缺陷的形状见那个模块的文件头。
 */

export function SettingsPage({ api, onClose, notify, onSubscriptionsChanged, initialTab = 'reading', startAddingPrompt = false }) {
  const [tab, setTab] = useState(initialTab);
  const [settings, setSettings] = useState(null);
  const [subscriptions, setSubscriptions] = useState([]);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  /**
   * 「转 RSS 服务」地址。2026-10-08 从探索页的「添加信息源」表单搬到这里 ——
   * 那个表单撤掉了，但这条能力（记住自建桥接服务的地址、检测它通不通）没删，
   * 只是换了个落点：它管的是「订阅怎么来」，本来就属于「订阅管理」。
   */
  const [serviceBase, setServiceBase] = useState('');
  const [serviceDraft, setServiceDraft] = useState('');
  const [serviceBusy, setServiceBusy] = useState(false);
  /** 上一次探活结果；`undefined` = 还没探过。 */
  const [probe, setProbe] = useState(undefined);
  /**
   * 「翻译用哪个模型」的下拉框数据。
   *
   * 三态必须分开，否则界面会说出确定的话但其实不知道：
   *   `null`      = 还在取（下拉框应显示「正在读取模型…」并禁用）
   *   `{providers}` = 取到了（可能是空列表 —— 那要如实说「一个都没读到」）
   *   `{error}`   = 取不到（要显示原因，而不是一个空下拉框）
   */
  const [aiModels, setAiModels] = useState(null);
  /**
   * 书架的索引状态。三态与 `aiModels` 同源，理由也一样：**「还没读到」与「读到了、
   * 但是空的」必须分开** —— 否则一本都没配的时候界面会说「书单是空的」，
   * 而真相是「索引文件没找到」，用户会去删书而不是去改路径。
   *
   *   `null`            = 还在读
   *   `{error}`         = 读失败（说原因）
   *   `{missing:true}`  = 文件不存在（说「去配路径」）
   *   `{total, source}` = 读到了（可能是 0 本）
   */
  const [libraryState, setLibraryState] = useState(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getSettings(), api.listSubscriptions()]).then(([preferences, feeds]) => {
      if (!cancelled) { setSettings(preferences.settings); setSubscriptions(feeds.subscriptions); }
    }).catch(error => { if (!cancelled) setMessage(`读取设置失败：${error?.message ?? String(error)}`); });
    // 目录与服务地址分开取：目录读失败不该让「订阅管理」整页变成打不开。
    void api.listCatalog().then((catalog) => {
      if (cancelled) return;
      const base = catalog?.service?.base ?? '';
      setServiceBase(base);
      setServiceDraft(base);
    }).catch(() => {});
    // 模型列表单独取：它要问宿主的 provider 注册表（可能含一次网络发现），
    // 慢或失败都不该让整页设置卡在「正在加载设置…」。
    void api.listAiModels()
      .then((result) => { if (!cancelled) setAiModels(result); })
      .catch((error) => { if (!cancelled) setAiModels({ providers: [], error: String(error?.message ?? error) }); });
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { cancelled = true; window.removeEventListener('keydown', onKey); };
  }, [api, onClose]);
  /**
   * 读一次书架索引状态（走宿主 HTTP，会真的去解析那份 1.8 MB 的 JSON）。
   *
   * ★ 依赖里**故意不写 `settings.libraryPath`**：输入框是「改了先存草稿、按保存才生效」
   *   的形态，把它写进依赖会让**每敲一个字符就发一次请求**去解析整份书单。
   *   所以刷新点只有两个：切到这一页时、以及按了「保存设置」之后（见 `save`）。
   */
  const readLibrary = async () => {
    setLibraryBusy(true);
    try {
      setLibraryState(await fetchBooks());
    } catch (error) {
      setLibraryState({ error: String(error?.message ?? error) });
    } finally { setLibraryBusy(false); }
  };
  useEffect(() => {
    if (tab !== 'library') return;
    void readLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上面 readLibrary 的说明
  }, [tab]);
  /** 丢掉宿主缓存重读（用户刚在自己的书单工具里整理完）。 */
  const reloadLibraryIndex = async () => {
    setLibraryBusy(true);
    setMessage('');
    try {
      const result = await reloadLibrary();
      setLibraryState(result);
      setMessage(`书单已重新载入：${result.total} 本`);
    } catch (error) { setMessage(`重新载入失败：${error?.message ?? String(error)}`); }
    finally { setLibraryBusy(false); }
  };
  /**
   * 第三步的「应用并重新载入」：**先存草稿、再重读**。
   *
   * ★ 顺序不能反，也不能只做后半步。`libraryPath` 是「改了先存草稿、按保存才生效」的
   *   形态（见上面 `readLibrary` 的说明），只重读的话用的是**磁盘上那个旧路径** ——
   *   而按钮写着「已应用」，用户会以为新路径生效了，然后在书架上找不到书。
   */
  const applyLibraryPath = async () => {
    await save();
    await reloadLibraryIndex();
  };
  const change = patch => setSettings(previous => ({ ...previous, ...patch }));
  /** Harness 当前默认模型（下拉框第一项的说明文字）。 */
  const defaultModelLabel = aiModels?.current
    ? `${aiModels.current.provider} · ${aiModels.current.model}`
    : '';
  /**
   * 已保存的取值不在当前列表里。
   *
   * ★ 这个判据存在的理由：`<select>` 的 `value` 找不到对应 `<option>` 时会**静默**
   *   跳到第一项，用户看到的是「我选的免费模型变成了默认模型」，而且设置文件里
   *   那个值其实还在 —— 一个纯粹由渲染细节造成的假象。所以这里主动把它说出来。
   */
  const modelChoices = new Set(aiModelOptions(aiModels).flatMap(entry => entry.models.map(model => model.value)));
  /**
   * 两个模型设置项（`aiModel` 翻译 / `digestModel` 电子书解读）各查一遍。
   *
   * ★ 合成一份清单而不是写两段 `if`：两者「读到的模型列表里没有这个值」的症状完全
   *   一样（下拉框静默跳到第一项），说明也应该一样。分开写迟早只改一处。
   */
  const missingModels = aiModels === null ? [] : [
    ['翻译 / 改写', settings?.aiModel],
    ['电子书解读', settings?.digestModel],
  ].filter(([, value]) => typeof value === 'string' && value !== '' && !modelChoices.has(value));
  const reloadSubscriptions = async () => {
    const list = await api.listSubscriptions();
    setSubscriptions(list.subscriptions);
  };
  /**
   * 订阅列表变了之后要做两件事：刷新本页清单，以及通知阅读页重算当前频道。
   * 少了第二件，从设置页新增的源会和从探索页新增的一样「订阅了却看不到」。
   */
  const afterSubscriptionsChanged = async (added) => {
    await reloadSubscriptions();
    await onSubscriptionsChanged?.(added);
  };
  const save = async () => {
    setSaving(true);
    try {
      // 只提交这一页拥有的字段：`bookSources` / `libraryListIds` 由 BookSources
      // 即时写盘，用这里的旧快照覆盖回去等于把用户刚加的书源抹掉（见 pageOwnedPatch）。
      const result = await api.saveSettings(pageOwnedPatch(settings));
      setSettings(result.settings);
      window.dispatchEvent(new Event('npr-settings-changed'));
      // 路径可能刚被改过，保存后必须重读一次状态 —— 否则界面还在说旧路径下的书单条数，
      // 而那个数字与「书架里实际能看到多少本」是两回事。
      if (tab === 'library') await readLibrary();
      setMessage('设置已保存');
    } catch (error) { setMessage(`保存失败：${error?.message ?? String(error)}`); }
    finally { setSaving(false); }
  };
  /** 保存「转 RSS 服务」地址；`thenProbe` 时顺手探一次活。 */
  const saveService = async (thenProbe) => {
    setServiceBusy(true);
    setMessage('');
    try {
      const next = await api.setCatalogService(serviceDraft);
      const base = next?.service?.base ?? '';
      setServiceBase(base);
      setServiceDraft(base);
      if (!thenProbe) { setMessage(base ? '已保存服务地址' : '已清空服务地址'); return; }
      const result = await api.probeCatalogService(base);
      setProbe(result);
      setMessage(probeText(result));
    } catch (error) { setMessage(`保存失败：${error?.message ?? String(error)}`); }
    finally { setServiceBusy(false); }
  };
  const exportOpml = async () => {
    try {
      const result = await api.opmlExport();
      const url = URL.createObjectURL(new Blob([result.xml], { type: 'text/xml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'npie-reader-subscriptions.opml';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setMessage(`导出失败：${error?.message ?? String(error)}`); }
  };
  return <div className="npr-settings-backdrop" onClick={onClose}>
    <section className="npr-settings-page" role="dialog" aria-modal="true" aria-label={`${BRAND_TITLE} 设置`} onClick={event => event.stopPropagation()}>
      {/* ★ 抬头用「一枚印章 + 一行标题 + 一行品牌」：原来那行是
          「澄境 | Limina │ 插件设置」，两段文字靠一条竖线分左右，谁也读不出
          哪个是产品、哪个是这一屏的名字。印章是中文语境里最省字的「署名」，
          也让这个弹窗和宿主自己的设置面板在气质上分开。 */}
      <header className="npr-settings-head">
        <div className="npr-settings-title">
          <span className="npr-settings-seal" aria-hidden="true">澄</span>
          <div><strong>插件设置</strong><span className="npr-settings-brand">{BRAND_TITLE}</span></div>
        </div>
        <button type="button" className="npr-icon" title="关闭设置" aria-label="关闭设置" onClick={onClose}><Icon name="x" /></button>
      </header>
      <div className="npr-settings-body">
        <nav className="npr-settings-tabs" aria-label="设置分类">
          <span className="npr-settings-nav-caption">设置</span>
          {TABS.map(({ key, label, icon }) => <button key={key} type="button" aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}><Icon name={icon} size={16} strokeWidth={1.7} />{label}</button>)}
          {/* 左栏底部原先空着 300px，看起来像没加载完。这里放的是**归属信息**
              （这是谁、哪一版），不是装饰 —— 设置页是用户唯一会想确认版本的地方。 */}
          <div className="npr-settings-nav-foot">
            <strong>{BRAND_ZH} · v{VERSION}</strong>
            <span>{SLOGAN_ZH}</span>
          </div>
        </nav>
        <main className="npr-settings-content">
          {!settings && <p role="status">{message || '正在加载设置…'}</p>}
          {settings && tab === 'reading' && <section aria-label="阅读设置">
            <div className="npr-settings-intro"><h2>阅读体验</h2><p>让文章以你喜欢的节奏和样式呈现。下面这块样张用的就是你此刻选中的字体与纸色。</p></div>
            {/* 样张在最上面：这一屏的六项设置里有五项**只影响阅读视图**，
                原先它们在设置页里没有任何可见后果 —— 调完字号得关掉弹窗、
                打开一篇文章才知道改成了什么。 */}
            <ReadingSpecimen settings={settings} />
            <div className="npr-settings-card npr-settings-reading-card">
              {/* 「恢复默认」放在抬头右侧而不是卡片末尾：它管的是**整张卡**的范围
                  （字体/字号/行距/版心/纸色/版本/图片），放在末尾时它会掉到「首屏」
                  那一组下面，看着像只重置最后两行。 */}
              <div className="npr-settings-card-head npr-settings-head-row">
                <div><h3>文章外观</h3><p>字体、版心与颜色只影响阅读视图。</p></div>
                <ReadingReset onChange={change} />
              </div>
              <ReadingControls settings={settings} onChange={change} variant="page" />
            </div>
            {/* ---- AI 与抓取：合成一张卡、五行 ----
                ★ 原先这里是四张**等重的卡**（AI 补全 / 解读模型 / 自动翻译 / 抓取全文）。
                  四张卡并排时，一个开关和「配一个模型」看起来一样重要，而实际上
                  前三行是同一件事的三个开关（要不要用 AI、用哪个、什么时候自动用）。
                ★ 顺序按「先总后分」：启用 → 翻译模型 → 解读模型 → 自动翻译 → 抓全文。 */}
            <div className="npr-settings-card">
              <div className="npr-settings-card-head">
                <h3>AI 与正文抓取</h3>
                <p>翻译是量大、重复、也不需要很强模型的活，可以单独压到一个便宜的（或免费的）模型上，不动你在 Harness 里选的默认模型。</p>
              </div>
              <div className="npr-set-list">
                <div className="npr-settings-toggle-row">
                  <div><h4>启用 AI 补全</h4><p>关掉之后，「生成中文版本」与「英文原文自动翻译」都会停用。</p></div>
                  <label className="npr-switch"><input type="checkbox" aria-label="AI 补全阅读版本" checked={settings.aiAssist !== false} onChange={event => change({ aiAssist: event.target.checked })} /><span aria-hidden="true" /></label>
                </div>
                <div className="npr-settings-model-row">
                  <div>
                    <h4>翻译 / 改写用哪个模型</h4>
                    <p>{describeModelCatalog(aiModels)}</p>
                  </div>
                  <span className="npr-set-field is-select">
                    <select className="npr-ai-model" aria-label="翻译与改写使用的模型" value={settings.aiModel ?? ''}
                      disabled={aiModels === null} onChange={event => change({ aiModel: event.target.value })}>
                      <option value="">跟随 Harness 默认模型{defaultModelLabel ? `（${defaultModelLabel}）` : ''}</option>
                      {aiModelOptions(aiModels).map(entry => (entry.models.length > 0
                        ? <optgroup key={entry.id} label={entry.label}>
                            {entry.models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
                          </optgroup>
                        : <option key={entry.id} value={`__unavailable__${entry.id}`} disabled>
                            {entry.label}（没读到模型{entry.error ? `：${entry.error}` : ''}）
                          </option>))}
                    </select>
                  </span>
                </div>
                {/* ★ 电子书解读单独一个模型，而不是复用上面那个：解读是「一本书 N 章 ×
                    每章几万字」，翻译是「一篇一次」。压到同一个模型上，必然有一边用错档。 */}
                <div className="npr-settings-model-row">
                  <div>
                    <h4>电子书解读用哪个模型</h4>
                    <p>逐章生成解读是这本书里最贵的一步（一本书几十次调用）。留空则跟随 Harness 默认模型；也可以把它压到一个便宜或免费的模型上。</p>
                  </div>
                  <span className="npr-set-field is-select">
                    <select className="npr-ai-model" aria-label="电子书解读使用的模型" value={settings.digestModel ?? ''}
                      disabled={aiModels === null} onChange={event => change({ digestModel: event.target.value })}>
                      <option value="">跟随 Harness 默认模型{defaultModelLabel ? `（${defaultModelLabel}）` : ''}</option>
                      {aiModelOptions(aiModels).map(entry => (entry.models.length > 0
                        ? <optgroup key={entry.id} label={entry.label}>
                            {entry.models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
                          </optgroup>
                        : <option key={entry.id} value={`__unavailable__${entry.id}`} disabled>
                            {entry.label}（没读到模型{entry.error ? `：${entry.error}` : ''}）
                          </option>))}
                    </select>
                  </span>
                </div>
                {/* ★ 已经存下的取值如果不在当前列表里，必须**显式说出来**。
                    不然 <select> 会静默跳到第一项「跟随默认」——用户看到的是「我选的免费模型
                    变成了默认模型」，却找不到任何解释，而设置文件里那个值其实还在。 */}
                {missingModels.map(([label, value]) => (
                  <p className="npr-settings-hint" key={label}>
                    已保存的{label}模型「{value}」不在当前读到的模型列表里。它会照旧被使用（列表可能只是没读全）；
                    想换掉就选一个别的，或选「跟随 Harness 默认模型」。
                  </p>
                ))}
                <div className="npr-settings-toggle-row">
                  <div><h4>英文原文自动翻译成中文</h4><p>打开后，打开一篇<strong>英文原文</strong>的文章时直接用 Harness 模型生成中文版本并显示，不需要在伴读框里打字让它翻。中文、日文/韩文原文不动；每篇只在没有中文版本时翻一次，之后走缓存。</p></div>
                  <label className="npr-switch"><input type="checkbox" aria-label="英文原文自动翻译成中文" checked={settings.autoTranslate === true} onChange={event => change({ autoTranslate: event.target.checked })} /><span aria-hidden="true" /></label>
                </div>
                <div className="npr-settings-toggle-row">
                  <div><h4>抓取原文全文</h4><p>订阅源只给摘要时，去原文页抽取正文。关闭后只显示订阅源自己提供的内容。</p></div>
                  <label className="npr-switch"><input type="checkbox" aria-label="抓取原文全文" checked={settings.fullText !== false} onChange={event => change({ fullText: event.target.checked })} /><span aria-hidden="true" /></label>
                </div>
              </div>
              <p className="npr-settings-hint">AI 伴读使用 Harness 的原生对话与默认工作区。模型可在右侧对话框中切换；解读模型也可以在阅读器的目录面板里临时换，那里换的结果会写回这里。</p>
            </div>
          </section>}
          {settings && tab === 'library' && <section aria-label="电子书书架设置">
            <div className="npr-settings-intro"><h2>电子书书架</h2><p>配好书源、生成书单，然后在插件里直接读原版式 PDF。</p></div>
            {/* 这一条是**页级开关**（管的是「阅读器里要不要出现书架这一页」），不属于三步里的
                任何一步。所以它刻意**不套卡片**：五张一样重的卡并排正是旧版看着乱的原因 ——
                一个全局开关和「配源」长得一样重，用户就看不出该先做哪个。 */}
            <div className="npr-lib-switch">
              <div><h3>在阅读器里显示书架入口</h3><p>关掉之后顶部就只剩「订阅」，书架这一页不再出现（已经记下的阅读进度不会丢）。</p></div>
              <label className="npr-switch"><input type="checkbox" aria-label="在阅读器里显示书架入口" checked={settings.bookshelf !== false} onChange={event => change({ bookshelf: event.target.checked })} /><span aria-hidden="true" /></label>
            </div>
            {/* 三步全在 BookSources 里：它有自己的状态与请求，塞进这个已经有 300 多行的文件里会没法读。
                「载入哪几份 / 外部书单路径」也归它 —— 那是第三步，把它切出去单独一张卡，
                第三步就断成两截了（`libraryPath` 走设置项的草稿 + 保存，见下面 `change`）。 */}
            <BookSources
              settings={settings}
              onSettingChange={change}
              libraryState={libraryState}
              libraryBusy={libraryBusy}
              onReload={applyLibraryPath}
              onIndexChanged={readLibrary}
              notify={notify} />
            {/* 「存储」放在三步**之后**：它是维护动作，不是配书流程的一步。
                放前面会让「配源 → 生成 → 载入」这三步被一个与流程无关的卡片打断。 */}
            <CacheSettings notify={notify} />
          </section>}
          {settings && tab === 'sources' && <section aria-label="订阅设置">
            <div className="npr-settings-intro"><h2>订阅管理</h2><p>添加订阅地址、整理分组，或迁移现有 OPML 清单。</p></div>
            <div className="npr-settings-card npr-settings-sources-card">
              <div className="npr-settings-card-head npr-settings-source-head">
                <div><h3>我的订阅</h3><p>{subscriptions.length} 个订阅源</p></div>
                <div className="npr-settings-source-actions">
                  <button type="button" onClick={() => setShowAdd(true)}><Icon name="plus" size={15} />添加订阅</button>
                  <button type="button" onClick={() => setShowImport(current => !current)} aria-expanded={showImport}><Icon name="upload" size={15} />导入 OPML</button>
                  <button type="button" onClick={() => void exportOpml()}><Icon name="download" size={15} />导出</button>
                </div>
              </div>
              {/* 分组下拉的候选与下面「订阅分组」那张清单**必须同源**（`groupNamesOf`），
                  否则会出现「下拉里没有某个分组、分组管理里却有」这种没法解释的差异。 */}
              {showAdd && <AddFeedDialog api={api} groups={groupNamesOf(subscriptions)} onClose={() => setShowAdd(false)} onDone={afterSubscriptionsChanged} notify={(text, isError) => { setMessage(text); if (isError) notify(text, true); }} />}
              {showImport && <div className="npr-settings-import"><OpmlImport api={api} onCancel={() => setShowImport(false)} onDone={async () => { await afterSubscriptionsChanged(); setShowImport(false); }} /></div>}
              <SubscriptionManager api={api} subscriptions={subscriptions} onChange={setSubscriptions} notify={(text, isError) => { setMessage(text); if (isError) notify(text, true); }} />
            </div>
            <div className="npr-settings-card">
              <div className="npr-settings-card-head">
                <h3>转 RSS 服务</h3>
                <p>如果你自己搭了一个把「没有 RSS 的源」转成 feed 的服务（wewe-rss / Wechat2RSS 之类），把它的地址记在这里。</p>
              </div>
              <div className="npr-service">
                <p className="npr-service-lead">
                  公众号这类源没有官方 RSS，也<strong>没有推送通道</strong>，所以任何「转 RSS」方案都只能定时去抓：
                  业界最好的水平是平均 6 小时、最慢 24 小时才收录 —— <strong>「实时」在这些源上不存在</strong>，
                  不是插件偷懒。抓取还要处理登录态与风控，那是一个独立服务的事，插件不内嵌（也内嵌不了），
                  也不保管你的任何后台凭证。
                </p>
                <div className="npr-service-row">
                  <input aria-label="转 RSS 服务地址" placeholder="服务地址（例如 http://localhost:4000）" value={serviceDraft} onChange={(event) => { setServiceDraft(event.target.value); setProbe(undefined); }} />
                  <button type="button" disabled={serviceBusy} onClick={() => void saveService(false)}>保存</button>
                  <button type="button" disabled={serviceBusy || serviceDraft.trim() === ''} onClick={() => void saveService(true)}>{serviceBusy ? '检测中…' : '保存并检测'}</button>
                </div>
                {probe && <div className={`npr-service-probe is-${probe.ok ? probe.kind : 'unreachable'}`} role="status">{probeText(probe)}</div>}
                <p className="npr-service-note">
                  这个地址只是<strong>记下来 + 探活</strong>，插件不会拿它去拼 feed 地址：真正的 feed 地址要你在服务后台里拿到后，
                  自己订阅进来（探索页的搜索框粘上地址即可，或在这里「添加订阅」）。
                </p>
                {serviceBase !== '' && (
                  <p className="npr-service-note">
                    已保存：<code>{serviceBase}</code>
                    <a className="npr-linkish" href={serviceBase} target="_blank" rel="noreferrer">在新窗口打开服务后台</a>
                    <span>（打不开就自己复制这个地址到浏览器）</span>
                  </p>
                )}
              </div>
            </div>
          </section>}
          {/*
            * 朗读这一屏**不依赖** `settings`：它的东西全部走 `POST /speech/config`
             * 即时写盘，不跟着底部那个「保存设置」按钮走（那张按钮提交的是
             * `pageOwnedPatch`，而 API Key 登记在 `LIVE_WRITTEN_SETTINGS` 里，
             * 本来就不会被它提交）。所以这里没有 `settings &&` 这个前置条件。
             */}
          {settings && tab === 'captions' && <section aria-label="字幕与识别设置">
            <div className="npr-settings-intro">
              <h2>字幕与识别</h2>
              <p>订阅源没给字幕时，用本机模型把这一集听写出来；字幕不是中文时，再逐句译成中文。</p>
            </div>
            <CaptionSettings
              api={api}
              settings={settings}
              onChange={change}
              notify={(text, isError) => { setMessage(text); if (isError) notify?.(text, true); }}
            />
          </section>}
          {tab === 'speech' && <section aria-label="朗读设置">
            <div className="npr-settings-intro"><h2>朗读</h2><p>本机语音免费、离线，但机械；云端神经语音自然得多，按字数计费。</p></div>
            <SpeechSettings notify={notify} />
          </section>}
          {tab === 'prompts' && <section aria-label="快捷提示词设置">
            <div className="npr-settings-intro"><h2>快捷提示词</h2><p>把常用的阅读提问放在手边。文章、电子书、论文三种伴读各自一套，互不影响。</p></div>
            <div className="npr-settings-card"><PromptManager notify={setMessage} startAdding={startAddingPrompt} scope="article" /></div>
            <div className="npr-settings-card"><PromptManager notify={setMessage} scope="book" /></div>
            <div className="npr-settings-card"><PromptManager notify={setMessage} scope="paper" /></div>
          </section>}
          {tab === 'about' && <section aria-label={`关于 ${BRAND_TITLE}`}>
            <div className="npr-settings-intro"><h2>关于 {BRAND_TITLE}</h2><p>为 DeepSeek Harness 打造的安静阅读空间。</p></div>
            <div className="npr-settings-card npr-settings-about-card">
              <div className="npr-settings-about-brand"><span>澄</span><div><h3>{BRAND_TITLE}</h3><p>版本 {VERSION} · MIT</p></div></div>
              <p className="npr-settings-about-slogan">{SLOGAN_ZH}<span>{SLOGAN_EN}</span></p>
              <p>订阅作者、读原文或中文版本、带着文章向 AI 追问。订阅、阅读数据与译文/改写都保存在本机 Harness 目录，不经过任何远程服务。</p>
            </div>
            <div className="npr-settings-card">
              <div className="npr-settings-card-head"><h3>许可与数据来源</h3><p>本插件以 MIT 许可发布，完整许可正文见仓库根目录的 LICENSE。</p></div>
              <div className="npr-settings-links">
                <a href="https://github.com/timqian/chinese-independent-blogs" target="_blank" rel="noopener noreferrer">独立博客目录（MIT）<Icon name="arrow-up-right" size={15} /></a>
              </div>
            </div>
          </section>}
        </main>
      </div>
      <footer className="npr-settings-footer">
        <span className="npr-settings-status" role="status">{message}</span>
        {(tab === 'reading' || tab === 'library' || tab === 'sources' || tab === 'captions') ? <button type="button" disabled={!settings || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button> : null}
      </footer>
    </section>
  </div>;
}
