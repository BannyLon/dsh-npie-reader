/**
 * 书架阅读器的判据：自适应缩放、滚轮翻页、键盘命令、页文本抽取。
 *
 * 这个文件存在的理由：这四件事都是「看起来对、错得很隐蔽」的类型 ——
 * 缩放算错只是页面缩在中间，滚轮规则写错要用户滚到页底才发现「下半页看不到」，
 * 键盘守卫漏一条要等有人在搜索框里打不出 `w`。它们全是纯函数，所以能在这里
 * 用真实取值钉住，并**每一条都配反向对照**：喂一个已知会坏的实现，证明判据会变红。
 * 没有反向对照的断言只是把当前实现抄了一遍（本项目在记忆里记过这一条）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FAB_BEND, FAB_BUTTON_SIZE, FAB_HOVER_GRACE, FAB_MARGIN, FAB_SLOT_GAP, FAB_SLOT_SIZE,
  FIT_PAGE, FIT_WIDTH, NO_COMMAND, SCALE_MAX, ZOOM_MAX, ZOOM_MIN,
  clampZoom, contentBox, createFabHover, displayScale, extractPageText, fabStack, fitScale,
  readerCommand, stepZoom, wheelIntent,
} from '../src/client/book-view.js';

/** A4 竖版在 scale=1 下的尺寸（pdf.js 的 viewport 单位）。 */
const A4 = { width: 595, height: 842 };

describe('contentBox：舞台可用内容区', () => {
  it('两个方向都减掉 padding', () => {
    assert.deepEqual(
      contentBox({ clientWidth: 600, clientHeight: 400, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12 }),
      { width: 568, height: 376 },
    );
  });

  it('没有 padding 时原样返回', () => {
    assert.deepEqual(contentBox({ clientWidth: 300, clientHeight: 200 }), { width: 300, height: 200 });
  });

  it('★ 永远不小于 1：面板还没显示时读到 0，负宽度会让缩放算出负数', () => {
    // 负的 box 会一路传到 `getViewport({ scale })`，症状是空白页 + 一个说不清来路的报错。
    // 所以这里要的是「夹住」而不是「如实报错」。
    assert.deepEqual(contentBox({ clientWidth: 0, clientHeight: 0 }), { width: 1, height: 1 });
    assert.deepEqual(contentBox({ clientWidth: 10, clientHeight: 10, paddingLeft: 40, paddingRight: 40 }), { width: 1, height: 10 });
    assert.deepEqual(contentBox(), { width: 1, height: 1 });
  });
});

describe('fitScale：两种缩放基准', () => {
  it('适宽 = 可用宽度 ÷ 页面宽度', () => {
    const scale = fitScale({ mode: FIT_WIDTH, box: { width: 600, height: 400 }, base: A4 });
    assert.ok(Math.abs(scale - 600 / 595) < 1e-9, String(scale));
  });

  it('适应窗口取宽高两个方向的**较小值**，所以整页一定看得见', () => {
    const scale = fitScale({ mode: FIT_PAGE, box: { width: 600, height: 400 }, base: A4 });
    assert.ok(Math.abs(scale - 400 / 842) < 1e-9, String(scale));
    assert.ok(400 / 842 < 600 / 595);
  });

  it('★ 适应窗口永远不会比适宽更大（否则「整页可见」这条承诺就是假的）', () => {
    // 宽而矮的面板（笔记本横屏）是这条最容易翻车的形态。
    const boxes = [
      { width: 600, height: 400 }, { width: 1200, height: 700 },
      { width: 300, height: 900 }, { width: 900, height: 900 },
    ];
    for (const box of boxes) {
      const width = fitScale({ mode: FIT_WIDTH, box, base: A4 });
      const page = fitScale({ mode: FIT_PAGE, box, base: A4 });
      assert.ok(page <= width + 1e-9, `box ${JSON.stringify(box)}: page ${page} > width ${width}`);
    }
  });

  it('拿不到舞台或页面尺寸时返回 0（调用方据此跳过渲染）', () => {
    assert.equal(fitScale({ mode: FIT_WIDTH, box: null, base: A4 }), 0);
    assert.equal(fitScale({ mode: FIT_WIDTH, box: { width: 600, height: 400 }, base: null }), 0);
    assert.equal(fitScale({ mode: FIT_WIDTH, box: { width: 0, height: 0 }, base: A4 }), 0);
    assert.equal(fitScale({ mode: FIT_WIDTH, box: { width: 600, height: 400 }, base: { width: 0, height: 842 } }), 0);
  });

  it('夹在绝对上下限之间（小页不会被放大成巨幅位图）', () => {
    const scale = fitScale({ mode: FIT_WIDTH, box: { width: 8000, height: 8000 }, base: { width: 10, height: 10 } });
    assert.equal(scale, SCALE_MAX);
  });

  it('反向对照：朴素的「一律按宽度」实现在适应窗口下会变红', () => {
    // 这就是第一版的行为 —— 只有「适宽」一条路。喂同一个输入，它给不出适页的答案。
    const naive = (box, base) => box.width / base.width;
    const box = { width: 600, height: 400 };
    assert.notEqual(naive(box, A4), fitScale({ mode: FIT_PAGE, box, base: A4 }));
  });
});

describe('displayScale：基准 × 手动倍数', () => {
  it('倍数为 1 时等于基准', () => {
    const box = { width: 600, height: 400 };
    assert.equal(displayScale({ mode: FIT_PAGE, box, base: A4, zoom: 1 }), fitScale({ mode: FIT_PAGE, box, base: A4 }));
  });

  it('倍数是乘上去的', () => {
    const box = { width: 600, height: 400 };
    const base = fitScale({ mode: FIT_WIDTH, box, base: A4 });
    assert.ok(Math.abs(displayScale({ mode: FIT_WIDTH, box, base: A4, zoom: 2 }) - base * 2) < 1e-9);
  });

  it('基准算不出来时仍然是 0（不能靠倍数把 0 救回来）', () => {
    assert.equal(displayScale({ mode: FIT_WIDTH, box: null, base: A4, zoom: 3 }), 0);
  });
});

describe('clampZoom / stepZoom', () => {
  it('夹在倍数区间里', () => {
    assert.equal(clampZoom(0.1), ZOOM_MIN);
    assert.equal(clampZoom(99), ZOOM_MAX);
    assert.equal(clampZoom(1.5), 1.5);
  });

  it('非有限值一律退回 1（不是 0，0 会让页面消失；也不是上限，跳到 300% 同样莫名其妙）', () => {
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(clampZoom(undefined), 1);
    assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
    assert.equal(clampZoom(Number.NEGATIVE_INFINITY), 1);
  });

  it('★ 步进结果是「干净的两位小数」，界面上不会出现 120.00000000000001%', () => {
    // 直接 `value + 0.2` 会累积浮点噪声；这里钉住 1 → 1.2 的精确值。
    assert.equal(stepZoom(1, 1), 1.2);
    assert.equal(stepZoom(1.2, -1), 1);
    assert.equal(stepZoom(2.9, 1), ZOOM_MAX);
    assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
  });
});

describe('wheelIntent：滚轮该滚还是该翻页', () => {
  const scrollable = { scrollTop: 300, scrollHeight: 2000, clientHeight: 500 };

  it('页面还滚得动时，中间的滚轮是滚动（★ 否则下半页永远看不到）', () => {
    assert.equal(wheelIntent({ deltaY: 100, ...scrollable }), 'scroll');
    assert.equal(wheelIntent({ deltaY: -100, ...scrollable }), 'scroll');
  });

  it('滚到底之后再往下 = 下一页；滚到顶之后再往上 = 上一页', () => {
    assert.equal(wheelIntent({ deltaY: 100, scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 }), 'next');
    assert.equal(wheelIntent({ deltaY: -100, scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }), 'prev');
  });

  it('页面滚不动（整页适应窗口 / 这一页本来就矮）时，上下都是翻页', () => {
    const flat = { scrollTop: 0, scrollHeight: 400, clientHeight: 500 };
    assert.equal(wheelIntent({ deltaY: 100, ...flat }), 'next');
    assert.equal(wheelIntent({ deltaY: -100, ...flat }), 'prev');
  });

  it('横向滚轮（deltaY 为 0）不翻页', () => {
    assert.equal(wheelIntent({ deltaY: 0, ...scrollable }), 'scroll');
  });

  it('反向对照：「滚轮一律翻页」的朴素实现在第一条上就变红', () => {
    const naive = (deltaY) => (deltaY > 0 ? 'next' : 'prev');
    assert.equal(naive(100), 'next');
    assert.notEqual(naive(100), wheelIntent({ deltaY: 100, ...scrollable }));
  });
});

describe('readerCommand：键盘映射与守卫', () => {
  const command = (key, extra = {}) => readerCommand({ key, ...extra });

  it('四个方向键都翻页（用户要的就是「上下左右」）', () => {
    assert.equal(command('ArrowRight'), 'next');
    assert.equal(command('ArrowDown'), 'next');
    assert.equal(command('ArrowLeft'), 'prev');
    assert.equal(command('ArrowUp'), 'prev');
  });

  it('翻页键、首末页、缩放、基准、伴读', () => {
    assert.equal(command('PageDown'), 'next');
    assert.equal(command(' '), 'next');
    assert.equal(command('PageUp'), 'prev');
    assert.equal(command('Home'), 'first');
    assert.equal(command('End'), 'last');
    assert.equal(command('+'), 'zoomIn');
    assert.equal(command('-'), 'zoomOut');
    assert.equal(command('w'), 'fitWidth');
    assert.equal(command('p'), 'fitPage');
    assert.equal(command('a'), 'companion');
  });

  /**
   * `i`（沉浸）/ `n`（配色轮转）与 `w`/`p`/`a` 同一档：换的是**可见且可逆**的
   * 界面状态，按错了立刻看得出来、也不会持久化任何「读完」之类的记录。
   * 而 `Escape` 刻意**不**进这张表：它的语义是「退出当前模态」，由组件按状态处理 ——
   * 一个全局的「Esc 一律退出沉浸」会把输入法 / 读屏自己关弹层的 Esc 也吃掉。
   */
  it('沉浸（i）与配色（n）可以给单字母；Esc 仍不接管', () => {
    assert.equal(command('i'), 'immersive');
    assert.equal(command('I'), 'immersive');
    assert.equal(command('n'), 'tint');
    assert.equal(command('N'), 'tint');
    assert.equal(command('Escape'), NO_COMMAND);
    // 守卫同样适用：在页码输入框里按 i 不该进沉浸。
    assert.equal(command('i', { tagName: 'input' }), NO_COMMAND);
    assert.equal(command('n', { contentEditable: true }), NO_COMMAND);
    assert.equal(command('i', { metaKey: true }), NO_COMMAND);
  });

  it('★ 输入类元素里一个键都不拦（否则搜索框里打不出 w / p）', () => {    for (const tagName of ['input', 'INPUT', 'textarea', 'select', 'button', 'summary', 'option']) {
      assert.equal(command('w', { tagName }), NO_COMMAND, tagName);
      assert.equal(command('ArrowRight', { tagName }), NO_COMMAND, tagName);
    }
  });

  it('★ 内容可编辑的框里也不拦（Harness 的输入框不一定是 textarea）', () => {
    // 只判标签名会漏掉 contenteditable 的输入框 —— 症状是「在聊天框里按方向键把书翻走了」。
    assert.equal(command('ArrowRight', { contentEditable: true }), NO_COMMAND);
    assert.equal(command('a', { contentEditable: true }), NO_COMMAND);
  });

  it('带修饰键的组合一律放行（⌘/Ctrl/Alt 有自己的用途）', () => {
    assert.equal(command('ArrowRight', { metaKey: true }), NO_COMMAND);
    assert.equal(command('ArrowRight', { ctrlKey: true }), NO_COMMAND);
    assert.equal(command('ArrowRight', { altKey: true }), NO_COMMAND);
    assert.equal(command('w', { ctrlKey: true }), NO_COMMAND);
  });

  it('★ 没有「标记读完」的单字母快捷键：持久化操作必须靠一次明确的点击', () => {
    // 误触 'r' 会在书架上留下一本假的「已读完」，而用户不会想到是自己按到了字母。
    assert.equal(command('r'), NO_COMMAND);
    assert.equal(command('R'), NO_COMMAND);
  });

  it('不认识的键返回 NO_COMMAND（不吞掉别人的快捷键）', () => {
    for (const key of ['Escape', 'Enter', 'Tab', 'F5', 'x', '1']) {
      assert.equal(command(key), NO_COMMAND, key);
    }
  });

  it('反向对照：去掉元素守卫的实现在第一条上就变红', () => {
    const naive = (key) => (key === 'ArrowRight' ? 'next' : NO_COMMAND);
    assert.equal(naive('ArrowRight'), 'next');
    assert.notEqual(naive('ArrowRight'), readerCommand({ key: 'ArrowRight', tagName: 'input' }));
  });
});

describe('extractPageText：pdf.js 文本游程 → 一段可读文字', () => {
  const items = (...runs) => runs.map((str) => ({ str }));

  it('游程之间补空格（直接拼接会把两个词粘成一个不存在的词）', () => {
    assert.equal(extractPageText(items('Hello', 'world')), 'Hello world');
    assert.equal(extractPageText(items('推荐序二', '在工作中体会生命的精彩')), '推荐序二 在工作中体会生命的精彩');
  });

  it('游程自带的空白被归一，不会出现双空格', () => {
    assert.equal(extractPageText(items('Hello ', ' world', '\n\n', 'again')), 'Hello world again');
  });

  it('空输入 / 非字符串项不炸', () => {
    assert.equal(extractPageText([]), '');
    assert.equal(extractPageText(undefined), '');
    assert.equal(extractPageText([{ str: '' }, null, { nope: 1 }, { str: 'x' }]), 'x');
  });

  it('★ 扫描版（没有任何文字项）返回空串 —— 调用方据此如实说「这一页看不到文字」', () => {
    assert.equal(extractPageText(items('', '   ', '')), '');
  });

  it('超长时截断（一页的文字要进 prompt，不能无上限）', () => {
    const long = extractPageText(items('a'.repeat(500)), { limit: 100 });
    assert.equal(long.length, 100);
    assert.equal(extractPageText(items('a'.repeat(500)), { limit: 1000 }).length, 500);
  });

  it('反向对照：直接 join("") 的实现会把上面第一条粘成 HelloWorld', () => {
    const naive = (list) => list.map((item) => item.str).join('');
    assert.equal(naive(items('Hello', 'world')), 'Helloworld');
    assert.notEqual(naive(items('Hello', 'world')), extractPageText(items('Hello', 'world')));
  });
});


/**
 * 右下角「向上摊开的一列」（0.23.0，取代 0.22.0 的圆弧扇出）。
 *
 * 为什么值得单测：这条算术错了**不会报错**，只会让某一格压在另一格身上、或者整列
 * 顶到胶囊上 —— 而重叠与溢出的部分都点不到。真 Chrome 那边还有一份几何判据
 * （量真实矩形的圆心距与标签宽度），两边必须给出同一个形态。
 *
 * ★ 0.22.0 那版是 `fabArc` + `fabRadius`（圆心在按钮上、7 格沿 90° 弧扇开）。
 *   用户实测两件事：**丑**（7 个没有文字的光圆片挤在书页右下角）、**点不到**
 *   （鼠标从按钮移向格子时经过空隙，`:hover` 掉了整列当场回收）。所以形态换成
 *   竖排 + 文字标签，展开也从 hover 改成点击。
 */
describe('fabStack：向上摊开的一列', () => {
  it('默认 7 格、全部在按钮**正上方**，横向只朝左让一点', () => {
    const stack = fabStack({ count: 7, height: 820 });
    assert.equal(stack.length, 7);
    for (const slot of stack) {
      assert.ok(slot.y < 0, `y=${slot.y} 不该跑到按钮下边`);
      assert.ok(slot.x <= 0.001 && slot.x >= -FAB_BEND - 0.001, `x=${slot.x} 超出弧度上限`);
    }
  });

  it('★ 竖直等距：相邻两格圆心距 = 格宽 + 间隙（同一根带子）', () => {
    const stack = fabStack({ count: 7, height: 820 });
    for (let i = 1; i < stack.length; i += 1) {
      const step = Math.hypot(stack[i].x - stack[i - 1].x, stack[i].y - stack[i - 1].y);
      assert.ok(step >= FAB_SLOT_SIZE, `第 ${i - 1}/${i} 格圆心距 ${step.toFixed(1)} < ${FAB_SLOT_SIZE}`);
      assert.ok(step <= FAB_SLOT_SIZE + FAB_SLOT_GAP + 0.6, `第 ${i - 1}/${i} 格间隙过大：${step.toFixed(1)}`);
    }
  });

  it('最下面那格紧贴按钮：圆心距 = 按钮半径 + 间隙 + 半格', () => {
    const stack = fabStack({ count: 7, height: 820 });
    const last = stack[stack.length - 1];
    const expected = FAB_BUTTON_SIZE / 2 + FAB_SLOT_GAP + FAB_SLOT_SIZE / 2;
    assert.ok(Math.abs(Math.abs(last.y) - expected) < 0.2, `实测 ${Math.abs(last.y)} 期望 ${expected}`);
    // 弧度在最后一格归零：贴着按钮的那一格必须正对着它。
    assert.ok(Math.abs(last.x) < 0.2, '最下面那格应当在正上方');
  });

  it('★ 整列不顶出面板顶：最上面那格的边缘留在可用空间里', () => {
    // 圆心距面板底 = `FAB_MARGIN + 按钮半径`（按钮 `bottom: 14px`、直径 44）。
    const centerFromBottom = FAB_MARGIN + FAB_BUTTON_SIZE / 2;
    for (const [height, label] of [[820, '常规'], [600, '居中'], [460, '矮'], [380, '更矮'], [240, '极矮']]) {
      const stack = fabStack({ count: 7, height });
      const topEdge = stack[0].y - stack[0].size / 2;
      const fromTop = height - centerFromBottom + topEdge;
      assert.ok(fromTop >= -0.5, `${label}面板 height=${height}：最上面距顶 ${fromTop.toFixed(1)}px（越界）`);
      assert.ok(stack.every((slot) => slot.size >= 26), `${label}面板：直径缩过头`);
    }
  });

  it('★ 尺寸与位置同源：直径缩了，相邻圆心距跟着缩，不会叠', () => {
    const tight = fabStack({ count: 7, height: 240 });
    assert.ok(tight[0].size < FAB_SLOT_SIZE, `直径应当缩到 < ${FAB_SLOT_SIZE}，实测 ${tight[0].size}`);
    for (let i = 1; i < tight.length; i += 1) {
      const step = Math.hypot(tight[i].x - tight[i - 1].x, tight[i].y - tight[i - 1].y);
      assert.ok(step >= tight[i].size - 0.01, `第 ${i} 格圆心距 ${step.toFixed(1)} < 直径 ${tight[i].size}`);
    }
  });

  it('只有 1 格时不除零', () => {
    const one = fabStack({ count: 1, height: 700 });
    assert.equal(one.length, 1);
    assert.equal(one[0].x, 0);
    assert.ok(Number.isFinite(one[0].y));
    assert.equal(one[0].size, FAB_SLOT_SIZE);
  });

  it('高度 / 尺寸非法都不炸，且不返回 NaN', () => {
    for (const height of [0, -10, Number.NaN, undefined]) {
      const stack = fabStack({ count: 7, height });
      assert.equal(stack.length, 7);
      for (const slot of stack) {
        assert.ok(Number.isFinite(slot.x) && Number.isFinite(slot.y), `height=${height}`);
        assert.ok(Number.isFinite(slot.size) && slot.size > 0, `height=${height}`);
      }
    }
  });

  it('反向对照：间隙写死 0 时圆心距**恰好等于**格宽（判据「≥」只是勉强成立）', () => {
    const flat = fabStack({ count: 7, height: 820, gap: 0 });
    const step = Math.abs(flat[1].y - flat[0].y);
    assert.ok(Math.abs(step - FAB_SLOT_SIZE) < 0.2, `实测 ${step.toFixed(1)}`);
    // 同时钉住默认间隙 > 0：默认值一旦变成 0，界面就是一串贴在一起的圆。
    assert.ok(FAB_SLOT_GAP > 0);
  });

  it('反向对照：弧度 0 时整列完全垂直（`--npr-fab-x` 退化成 0）', () => {
    for (const slot of fabStack({ count: 7, height: 820, bend: 0 })) assert.equal(slot.x, 0);
    assert.ok(FAB_BEND > 0);
  });
});

/**
 * 假定时器：可推进、可撤销、**从 0 开始编号**。
 * ★ 从 0 编号是刻意的 —— 生产 `setTimeout` 从 1 开始，但注入点没有这个保证；
 *   用 0 当哨兵的实现会在这里当场暴露（`if (timer)` 判不出 0）。
 */
function fakeClock() {
  let now = 0;
  let seq = -1;
  const timers = new Map();
  const api = {
    setTimer(fn, delay) {
      const id = ++seq;
      timers.set(id, { fn, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** 推进 ms，按到期顺序执行（含推进过程中新排进来的）。 */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (pick === null || t.at < pick[1].at)) pick = [id, t];
        }
        if (pick === null) break;
        timers.delete(pick[0]);
        now = pick[1].at;
        pick[1].fn();
      }
      now = target;
    },
    get pending() {
      return timers.size;
    },
  };
  return api;
}

describe('createFabHover：悬停展开的状态机（0.24.3）', () => {
  /** 建一个把开合记进数组的实例，返回 { hover, clock, log }。 */
  function build(opts = {}) {
    const clock = fakeClock();
    const log = [];
    const hover = createFabHover({
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onOpen: () => log.push('open'),
      onClose: () => log.push('close'),
      ...opts,
    });
    return { hover, clock, log };
  }

  it('进入立刻开 —— 不等定时器（用户诉求「鼠标移到图标上就弹出」）', () => {
    const { hover, log } = build();
    hover.enter();
    assert.deepEqual(log, ['open']);
  });

  it('离开**不立刻**收：宽限期没到之前一个字都不许动', () => {
    const { hover, clock, log } = build({ grace: 220 });
    hover.enter();
    hover.leave();
    clock.advance(219);
    assert.deepEqual(log, ['open'], '219ms 就收了 —— 空隙里横穿的那几十毫秒根本走不完');
    clock.advance(1);
    assert.deepEqual(log, ['open', 'close']);
  });

  it('宽限期内回来 ⇒ 取消收，之后也不再收（这是「越过空隙」的全部秘密）', () => {
    const { hover, clock, log } = build({ grace: 220 });
    hover.enter();
    hover.leave();      // 走进空隙
    clock.advance(60);  // 60ms 后到达第一格
    hover.enter();      // 进入子树
    clock.advance(2000);
    assert.deepEqual(log, ['open', 'open'], '宽限期没被取消：回来之后又被自己收掉了');
    assert.equal(clock.pending, 0, '还留着一个定时器');
  });

  it('连续离开只安排一个定时器，且只收一次', () => {
    const { hover, clock, log } = build({ grace: 220 });
    hover.enter();
    hover.leave();
    hover.leave();
    hover.leave();
    assert.equal(clock.pending, 1, `排了 ${clock.pending} 个定时器`);
    clock.advance(500);
    assert.deepEqual(log, ['open', 'close']);
  });

  it('★ 定时器 id 为 0 时也必须能取消（哨兵不能用 0）', () => {
    // 这个假时钟第一个 id 就是 0；用 `if (timer)` 判断的实现会漏掉它。
    const { hover, clock, log } = build({ grace: 220 });
    hover.leave();
    assert.equal(clock.pending, 1);
    hover.enter();      // 应取消那个 id=0 的定时器
    assert.equal(clock.pending, 0, 'id=0 的定时器没被清掉');
    clock.advance(2000);
    assert.deepEqual(log, ['open'], '被一个早该作废的 close 收掉了');
  });

  it('cancel() 之后不再回调（卸载时用，不能往已卸载的组件里 setState）', () => {
    const { hover, clock, log } = build({ grace: 220 });
    hover.enter();
    hover.leave();
    hover.cancel();
    clock.advance(2000);
    assert.deepEqual(log, ['open']);
    assert.equal(clock.pending, 0);
  });

  it('默认宽限期就是 FAB_HOVER_GRACE，且足够横穿一道空隙', () => {
    const { hover, clock, log } = build();  // 不传 grace
    hover.leave();
    clock.advance(FAB_HOVER_GRACE - 1);
    assert.deepEqual(log, []);
    clock.advance(1);
    assert.deepEqual(log, ['close']);
    // 下限 100ms：横穿 8px 空隙慢手也就 80ms；低于这个数必然闪断。
    assert.ok(FAB_HOVER_GRACE >= 100 && FAB_HOVER_GRACE <= 400, `实测 ${FAB_HOVER_GRACE}`);
  });

  it('反向对照：grace 写 0 ⇒ 离开立刻收（判据「空隙里不许收」确实在量 grace）', () => {
    const { hover, clock, log } = build({ grace: 0 });
    hover.enter();
    hover.leave();
    clock.advance(0);
    assert.deepEqual(log, ['open', 'close']);
  });

  it('反向对照：去掉 cancel ⇒ 宽限期内回来也会被收掉（证明上一条不是白写的）', () => {
    // 手写一个「忘了 cancel」的坏实现，跑同一个场景，必须出现 close。
    const clock = fakeClock();
    const log = [];
    let timer = null;
    const bad = {
      enter() { log.push('open'); },      // ← 少了 cancel()
      leave() { timer = clock.setTimer(() => { log.push('close'); }, 220); },
    };
    bad.enter();
    bad.leave();
    clock.advance(60);
    bad.enter();
    clock.advance(2000);
    assert.deepEqual(log, ['open', 'open', 'close'], '坏实现居然没被收 —— 那这条判据量不到东西');
    assert.ok(timer !== null);
  });
});
