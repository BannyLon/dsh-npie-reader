/**
 * 灵感模块的开场页：「寸心拾遗 · 思想原点」。
 *
 * ★ 类名是 `.npr-diary-startpage`，**不能叫 `.npr-diary-cover`** —— 那个名字已经被
 *   书封面缩略图（`BookCover.jsx`）占了，同名会让这个开场页继承书封面的灰罩底色、
 *   圆角和 1px 描边（症状就是「背景颜色和周围不统一」）。
 *
 * ★ 版式与书架的欢迎页（`LibraryApp` 的 `.npr-welcome`）**同一套类**，不是照着做的
 *   第二套：品牌行、标题、三段说明、底部统计、`margin: clamp(48px,14vh,160px) auto`
 *   全部复用。照抄一份的后果是两边会各自漂 —— 改字号只改一处，同一页里两块文案
 *   就对不齐了。
 * ★ 整块是一个 `role="button"`：按下左键（`pointerdown`，不是 `click`）就退场。
 *   用 pointerdown 是因为用户 2026-10-29 的原话是「按下鼠标左键动画消失」——
 *   按下即走，不用等抬起；`click` 还要求指针不移动，按住再松手就不灵了。
 * ★ 键盘也给同一条路（Enter / Space）：一张只能用鼠标开场的页面，键盘用户进不去。
 * ★ 三段说明的口吻跟书架那三段一致 —— **先说这一屏看得见什么，再说动作，最后说落点**，
 *   不列功能清单，也不写 `localStorage` / 宿主 / 目录结构这类内部词。
 */
import { BRAND_TITLE } from './brand.js';

/**
 * @param {object} props
 * @param {boolean} props.leaving 退场动画进行中（此时不再接受第二次按下）。
 * @param {number} props.days 已经记过多少天。
 * @param {number} props.tags 用过的标签数。
 * @param {number} props.bytes 正文字节数。
 * @param {() => void} props.onEnter 开始记录。
 */
export function DiaryCover({ leaving, days, tags, bytes, onEnter }) {
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
      aria-label="开始记录灵感"
      onPointerDown={(event) => { if (event.button === 0) start(event); }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') start(event); }}>
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
    </div>
  );
}
