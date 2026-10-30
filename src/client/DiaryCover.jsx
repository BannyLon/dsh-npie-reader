/**
 * 日记页的**开场说明页**：灵感速记「寸心拾遗 · 思想原点」、私密日记「私密日记 · 只在本机」。
 *
 * ★ 两张共用同一个外壳 `DiaryStartpage`（版式 + 按下即退场 + 键盘可达），内容各写各的 ——
 *   它们说的是两件事。抽成外壳而不是照抄一份：0.53.0 把版式从书架欢迎页抄过来时
 *   已经吃过一次亏（改字号只改一处，同一页里两块文案就对不齐了）。
 *
 * ★ 类名是 `.npr-diary-startpage`，**不能叫 `.npr-diary-cover`** —— 那个名字已经被
 *   书封面缩略图（`BookCover.jsx`）占了，同名会让这个开场页继承书封面的灰罩底色、
 *   圆角和 1px 描边（症状就是「背景颜色和周围不统一」）。
 *
 * ★ 整块是一个 `role="button"`：按下左键（`pointerdown`，不是 `click`）就退场。
 *   用 pointerdown 是因为用户 2026-10-29 的原话是「按下鼠标左键动画消失」——
 *   按下即走，不用等抬起；`click` 还要求指针不移动，按住再松手就不灵了。
 * ★ 键盘也给同一条路（Enter / Space）：一张只能用鼠标开场的页面，键盘用户进不去。
 *
 * ★ 说明页**没有顶栏**：上面一个可操作的对象都没有，顶上再挂一行「这是什么」，
 *   只是把下面这几段再说一遍（`headVisible()` 里 `cover` 一为真就返回 false）。
 */
import { BRAND_TITLE } from './brand.js';

/**
 * 开场页的外壳：版式 + 「按下就走」。
 *
 * @param {object} props
 * @param {boolean} props.leaving 退场动画进行中（此时不再接受第二次按下）。
 * @param {string} props.label 无障碍名称（读屏软件念的那一句）。
 * @param {() => void} props.onEnter 开始。
 * @param {import('react').ReactNode} props.children 页里的内容。
 */
function DiaryStartpage({ leaving, label, onEnter, children }) {
  const start = (event) => {
    if (leaving) return;
    // 按下就拦掉默认行为：不选中文字、不触发后面的 click —— 否则一次按下会
    // 先选中半个标题、再触发一次「进入」，看起来像闪了一下。
    event.preventDefault();
    onEnter();
  };
  return (
    <div
      className={`npr-diary-startpage${leaving ? ' is-leaving' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onPointerDown={(event) => { if (event.button === 0) start(event); }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') start(event); }}>
      {children}
    </div>
  );
}

/**
 * 灵感速记的开场页。
 *
 * @param {object} props
 * @param {boolean} props.leaving 退场动画进行中。
 * @param {number} props.days 已经记过多少天。
 * @param {number} props.tags 用过的标签数。
 * @param {number} props.bytes 正文字节数。
 * @param {() => void} props.onEnter 开始记录。
 */
export function DiaryCover({ leaving, days, tags, bytes, onEnter }) {
  return (
    <DiaryStartpage leaving={leaving} label="开始记录灵感" onEnter={onEnter}>
      <div className="npr-welcome">
        <div className="npr-welcome-brand">{BRAND_TITLE}</div>
        <h2>寸心拾遗 · 思想原点</h2>
        <p className="npr-welcome-intro">
          左边是一条<strong>按天</strong>的时间线，还有你用过的标签；点一天展开那天记的几句，
          点标签只看那个话题。
        </p>
        <p className="npr-welcome-intro">
          想到什么就写什么 —— 一句话、半句诗、一个词都算。
          <span className="npr-keep"><kbd>⌘</kbd> / <kbd>Ctrl</kbd> + <kbd>Enter</kbd></span> 就收起来，
          不用起标题。
        </p>
        <p className="npr-welcome-intro">
          写下的存在本机 <code>diary/</code> 下的 Markdown，一天一篇；想让 AI 把今天的几条
          并成一段，用顶上那个「AI 整理这一天」。
        </p>
        <div className="npr-welcome-keys">
          <span>已记 {days} 天</span>
          <span>{tags} 个标签</span>
          <span>{bytes}</span>
        </div>
        <p className="npr-diary-startpage-hint">点一下，开始写第一句</p>
      </div>
    </DiaryStartpage>
  );
}

/**
 * 私密日记的开场页（0.56.2）。
 *
 * ★ 用户 2026-10-30：「私密日记的说明页和灵感开场页操作一样，就是鼠标点一下消失，
 *   出现解锁页面。」——所以它不是一块提示，是**一道门**：按下去就退到后面那一屏，
 *   锁着时看到的是口令卡，解开之后是当天的那几页。
 * ★ 三段的顺序与灵感那张一致：**先说这一屏看得见什么 → 再说动作 → 最后说落点**。
 *   这里没有「功能清单」，也不写宿主 / 目录结构这类内部词（除了那个删了能重设口令的
 *   `diary/gate.json` —— 那是用户自己会去找的文件，得写出来）。
 * ★ 统计只报**天数**与**字节**，不报条数与字数：上锁时宿主根本不给正文，
 *   报「0 条 · 0 字」是假话（见 `footDays` / `footBytes` 那段注释）。
 *
 * @param {object} props
 * @param {boolean} props.leaving 退场动画进行中。
 * @param {number} props.days 私密日记记过多少天。
 * @param {string} props.bytes 私密正文字节数（已经格式化，取不到时是 `—`）。
 * @param {() => void} props.onEnter 进入私密日记。
 */
export function PrivateCover({ leaving, days, bytes, onEnter }) {
  return (
    <DiaryStartpage leaving={leaving} label="进入私密日记" onEnter={onEnter}>
      <div className="npr-welcome">
        <div className="npr-welcome-brand">{BRAND_TITLE}</div>
        <h2>私密日记 · 只在本机</h2>
        <p className="npr-welcome-intro">
          左边按天排，点一天看那天写的几行。这里的东西<strong>不同步、不进模型</strong>，
          也不会混进灵感那一边。
        </p>
        <p className="npr-welcome-intro">
          文件本身就是密文，密钥在这台机器的登录钥匙串里；这一页另有一道口令 ——
          它不参与加密，只决定「谁能翻开这一页」。
        </p>
        <p className="npr-welcome-intro">
          第一次进来先设一道口令。忘了也不会丢日记：删掉 <code>diary/gate.json</code>
          就能重设，文字还在。
        </p>
        <div className="npr-welcome-keys">
          <span>已记 {days} 天</span>
          <span>{bytes}</span>
        </div>
        <p className="npr-diary-startpage-hint">点一下，进入私密日记</p>
      </div>
    </DiaryStartpage>
  );
}
