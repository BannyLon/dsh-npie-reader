import { FONTS, TEXT_WIDTHS, THEMES, appearanceDefaults, fontStack } from '../reading-settings.js';
import { Icon } from './icons.jsx';

const THEME_OPTIONS = [
  ['auto', '跟随应用'], ['light', '明亮'], ['paper', '纸张'], ['sage', '青绿'],
  ['mist', '雾蓝'], ['dark', '深色'], ['black', '纯黑'],
];

const VERSION_OPTIONS = [['original', '原文'], ['translation', '译文'], ['rewrite', '改写']];

/**
 * 样张正文。两句自己写的，不引别人的书 —— 这是产品界面的一部分，
 * 引用一段名著会把「预览」变成「摘录」，用户会去追问这句话出自哪里。
 */
const SPECIMEN_TEXT = '夜里读书，灯不必太亮。字与字之间留一点空隙，眼睛才肯往下走。';
const SPECIMEN_TAIL = '一段文字的快慢，多半不是读出来的，是排出来的。';

const FONT_SIZE_RANGE = [14, 32];
const LINE_HEIGHT_RANGE = [1.5, 2.4];

/** 当前字体在界面上叫什么（自选字体优先显示用户自己填的名字）。 */
function fontTitle(settings) {
  if (settings.readingFont === 'custom') return (settings.customFont ?? '').trim() || '自选字体';
  return (FONTS[settings.readingFont] ?? FONTS.serif).label;
}

/** 滑杆已填充段占轨道的百分比：写进 `--npr-range-fill`，由 CSS 画渐变。 */
function fillOf(value, [min, max]) {
  const ratio = (Number(value) - min) / (max - min);
  return `${Math.min(100, Math.max(0, ratio * 100)).toFixed(2)}%`;
}

/**
 * 「排印样张」：用**当前选中的字体 / 字号 / 行距 / 版心 / 纸色**真渲染一段中文。
 *
 * ★ 为什么值得占掉设置页顶部 150px：这一屏的六项设置里，有五项**只影响阅读视图**，
 *   在设置页里原本没有任何可见后果 —— 用户调完字号要关掉弹窗、打开一篇文章才知道
 *   改成了什么。样张把「后果」搬到选择现场，并且版心宽度用 `em` 直接等于字数，
 *   量出来的是真值，不是示意图。
 * ★ 主题色走 `THEMES`（与阅读页同一份数据），不在这里另列一套色值：
 *   两处各写一份，迟早出现「设置里是米黄、读起来是浅灰」。
 */
export function ReadingSpecimen({ settings }) {
  const paper = settings.readingTheme === 'auto' ? null : THEMES[settings.readingTheme];
  const columns = Number(settings.textWidth) || 36;
  return <figure className={`npr-specimen${paper ? '' : ' is-auto'}`}
    aria-hidden="true"
    style={paper ? { background: paper[0], color: paper[1] } : undefined}>
    <div className="npr-specimen-meta">
      <span>样张</span>
      <span>{fontTitle(settings)} · {settings.fontSize}px · 行距 {Number(settings.lineHeight).toFixed(1)} · 版心 {columns} 字</span>
    </div>
    <div className="npr-specimen-body"
      style={{ fontFamily: fontStack(settings), fontSize: `${settings.fontSize}px`, lineHeight: String(settings.lineHeight), maxWidth: `${columns}em` }}>
      <p>{SPECIMEN_TEXT}</p>
      <p className="npr-specimen-tail">{SPECIMEN_TAIL}</p>
    </div>
  </figure>;
}

/**
 * 「恢复默认」只提交**这一屏看得见的字段**（`appearanceDefaults()`）。
 * 原先是 `set({ ...READING_DEFAULTS })` —— 那是整份默认值，而宿主是整份覆盖，
 * 于是点一下「恢复默认」会顺手清空书源、外部书单路径、翻译/解读模型。
 * 详见 `src/reading-settings.js` 里 `APPEARANCE_KEYS` 的注释。
 *
 * ★ 单独导出而不是内联在 `ReadingControls` 里：设置页把它放到卡片抬头右侧
 *   （与「文章外观」同一行），而阅读器的小浮层里它仍在底部。同一个动作、同一句文案，
 *   两处的位置不同是因为**容器不同** —— 页面上它属于整张卡，浮层里它属于面板底部。
 */
export function ReadingReset({ onChange }) {
  return <button type="button" className="npr-reading-reset" onClick={() => onChange(appearanceDefaults())}>
    <Icon name="refresh-cw" size={13} strokeWidth={1.7} />恢复默认
  </button>;
}

/** Shared controls for the quick popover and the full plugin settings page. */
export function ReadingControls({ settings, onChange, variant = 'compact' }) {
  const set = (patch) => onChange(patch);
  const page = variant === 'page';

  const reset = <ReadingReset onChange={onChange} />;

  if (!page) {
    return <>
      <div className="npr-reading-settings-fields">
        <label className="npr-reading-setting">
          <span>字体</span>
          <select value={settings.readingFont} onChange={(event) => set({ readingFont: event.target.value })}>
            {Object.entries(FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
          </select>
        </label>
        {settings.readingFont === 'custom' && (
          <label className="npr-reading-setting">
            <span>字体名</span>
            <input aria-label="自选字体名" value={settings.customFont ?? ''} placeholder="例如 LXGW WenKai"
              onChange={(event) => set({ customFont: event.target.value })} />
          </label>
        )}
        <label className="npr-reading-setting">
          <span>字号</span>
          <output>{settings.fontSize} px</output>
          <input type="range" min="14" max="32" step="1" value={settings.fontSize}
            onChange={(event) => set({ fontSize: Number(event.target.value) })} />
        </label>
        <label className="npr-reading-setting">
          <span>行距</span>
          <output>{settings.lineHeight.toFixed(1)} 倍</output>
          <input type="range" min="1.5" max="2.4" step="0.1" value={settings.lineHeight}
            onChange={(event) => set({ lineHeight: Number(event.target.value) })} />
        </label>
        <div className="npr-reading-setting">
          <span>版心宽度</span>
          <select aria-label="版心宽度" value={settings.textWidth} onChange={(event) => set({ textWidth: Number(event.target.value) })}>{TEXT_WIDTHS.map((width) => <option key={width.value} value={width.value}>{width.label}</option>)}</select>
        </div>
        <div className="npr-reading-setting">
          <span>阅读主题</span>
          <select aria-label="阅读主题" value={settings.readingTheme} onChange={(event) => set({ readingTheme: event.target.value })}>{THEME_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
        <div className="npr-reading-setting">
          <span>默认版本</span>
          <select aria-label="默认版本" value={settings.defaultVersion} onChange={(event) => set({ defaultVersion: event.target.value })}>{VERSION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
        <div className="npr-reading-setting npr-reading-setting-check">
          <span>文章图片</span>
          {/* 0.84.8：原来这里是原生 13px 复选框，设置页里同一个开关却是 34px 的 `.npr-switch`
              —— 同一件事两种控件，用户会以为紧凑面板里那个是小一号的另一个功能。 */}
          <label className="npr-switch"><input type="checkbox" aria-label="文章图片" checked={settings.showImages !== false} onChange={(event) => set({ showImages: event.target.checked })} /><span aria-hidden="true" /></label>
        </div>
      </div>
      {reset}
    </>;
  }

  /**
   * 设置页版：三段分组（排版 / 纸色 / 首屏），而不是六行等重平铺。
   *
   * ★ 分组不是装饰：字号、行距、版心是**同一件事的三个刻度**（它们一起决定
   *   一行的疏密），而纸色是另一件事，默认版本与图片又是第三件事。六行并排时，
   *   用户看不出「我调的是排版还是配色」，只能逐行读完标签。
   * ★ 每行右端都对齐同一个数值列（`tabular-nums`）：滑杆的位置读的是相对量，
   *   数字读的是绝对量，两者必须同屏，否则「我现在到底是多少号字」要靠猜。
   */
  return <>
    <div className="npr-reading-settings-fields">
      <section className="npr-set-group">
        <h4 className="npr-set-group-title">排版</h4>
        <label className="npr-reading-setting">
          <span className="npr-set-label">字体</span>
          <span className="npr-set-field is-select">
            <select value={settings.readingFont} onChange={(event) => set({ readingFont: event.target.value })}>
              {Object.entries(FONTS).map(([value, font]) => <option key={value} value={value}>{font.label}</option>)}
            </select>
          </span>
        </label>
        {settings.readingFont === 'custom' && (
          <label className="npr-reading-setting">
            <span className="npr-set-label">字体名</span>
            <span className="npr-set-field">
              <input aria-label="自选字体名" value={settings.customFont ?? ''} placeholder="例如 LXGW WenKai"
                onChange={(event) => set({ customFont: event.target.value })} />
            </span>
          </label>
        )}
        <label className="npr-reading-setting">
          <span className="npr-set-label">字号</span>
          <span className="npr-set-range">
            <input type="range" aria-label="正文字号" min={FONT_SIZE_RANGE[0]} max={FONT_SIZE_RANGE[1]} step="1"
              value={settings.fontSize} style={{ '--npr-range-fill': fillOf(settings.fontSize, FONT_SIZE_RANGE) }}
              onChange={(event) => set({ fontSize: Number(event.target.value) })} />
            <span className="npr-set-range-scale" aria-hidden="true"><span>{FONT_SIZE_RANGE[0]}</span><span>{FONT_SIZE_RANGE[1]}</span></span>
          </span>
          <output className="npr-set-value">{settings.fontSize}<small>px</small></output>
        </label>
        <label className="npr-reading-setting">
          <span className="npr-set-label">行距</span>
          <span className="npr-set-range">
            <input type="range" aria-label="正文行距" min={LINE_HEIGHT_RANGE[0]} max={LINE_HEIGHT_RANGE[1]} step="0.1"
              value={settings.lineHeight} style={{ '--npr-range-fill': fillOf(settings.lineHeight, LINE_HEIGHT_RANGE) }}
              onChange={(event) => set({ lineHeight: Number(event.target.value) })} />
            <span className="npr-set-range-scale" aria-hidden="true"><span>{LINE_HEIGHT_RANGE[0]}</span><span>{LINE_HEIGHT_RANGE[1]}</span></span>
          </span>
          <output className="npr-set-value">{Number(settings.lineHeight).toFixed(1)}<small>倍</small></output>
        </label>
        <div className="npr-reading-setting">
          <span className="npr-set-label">版心宽度</span>
          <div className="npr-segmented npr-width-options" role="group" aria-label="版心宽度">{TEXT_WIDTHS.map((width) => <button key={width.value} type="button" aria-pressed={settings.textWidth === width.value} onClick={() => set({ textWidth: width.value })}>{width.value}</button>)}</div>
        </div>
      </section>

      <section className="npr-set-group">
        <h4 className="npr-set-group-title">纸色</h4>
        <div className="npr-theme-options" role="group" aria-label="阅读主题">{THEME_OPTIONS.map(([value, label]) => <button key={value} type="button" aria-pressed={settings.readingTheme === value} onClick={() => set({ readingTheme: value })}><span className={`npr-theme-swatch${value === 'auto' ? ' npr-theme-swatch-auto' : ''}`} style={value === 'auto' ? undefined : { background: THEMES[value][0], color: THEMES[value][1] }}>{value === 'auto' ? <Icon name="monitor" size={16} strokeWidth={1.6} /> : '文'}</span><span className="npr-theme-label">{label}</span></button>)}</div>
      </section>

      <section className="npr-set-group">
        <h4 className="npr-set-group-title">首屏</h4>
        <div className="npr-reading-setting">
          <span className="npr-set-label">默认版本</span>
          <div className="npr-segmented" role="group" aria-label="默认版本">{VERSION_OPTIONS.map(([value, label]) => <button key={value} type="button" aria-pressed={settings.defaultVersion === value} onClick={() => set({ defaultVersion: value })}>{label}</button>)}</div>
        </div>
        <div className="npr-reading-setting npr-reading-setting-check">
          <span className="npr-set-label">文章图片</span>
          <span className="npr-set-note">关掉之后，正文只留文字。</span>
          <label className="npr-switch"><input type="checkbox" aria-label="文章图片" checked={settings.showImages !== false} onChange={(event) => set({ showImages: event.target.checked })} /><span aria-hidden="true" /></label>
        </div>
      </section>
    </div>
  </>;
}

/** Compact reader-toolbar popover. */
export function ReadingAppearance({ settings, onChange, onClose }) {
  return <div className="npr-reading-settings" role="dialog" aria-label="阅读设置">
    <div className="npr-reading-settings-head"><strong>阅读设置</strong><button type="button" onClick={onClose}>完成</button></div>
    <ReadingControls settings={settings} onChange={onChange} />
  </div>;
}
