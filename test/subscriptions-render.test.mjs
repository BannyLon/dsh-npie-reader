/**
 * 订阅管理那一行的**浏览器半区**：真渲染（react-dom/server），不是读源码猜。
 *
 * 盯四件事，都是「看起来对、其实不对」的那类：
 *  1. 「补全历史」这个入口**只在可能被截断的源上出现**。挂在每一行上的话，
 *     用户只会看到一排看不懂的图标，而它真正的适用面是「feed 只给最新 N 条」。
 *  2. 三个纯图标按钮各自有 `aria-label`，并且提示气泡的样式真的存在 ——
 *     类名写错时按钮照样渲染，只是**悬停什么都没有**，那正是用户报的问题。
 *  3. 「补全中」这一行的界面必须**和空闲时长得不一样**（转圈 + 灰掉 + 行内进度）。
 *     只加 `disabled` 属性不算数：没有 `:disabled` 样式时它看着还是能点的。
 *  4. 「添加订阅」的分组框是**可选已有 + 可自定义**的形态，不是只能二选一的 `<select>`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import * as esbuild from 'esbuild';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(pluginRoot, 'test', '.build', 'subscriptions-render.cjs');

let pending;
function loadModule() {
  pending ??= (async () => {
    mkdirSync(dirname(outFile), { recursive: true });
    await esbuild.build({
      stdin: {
        contents: [
          `import React from 'react';`,
          `import { renderToStaticMarkup } from 'react-dom/server';`,
          `import { SubscriptionManager, SubscriptionRow, BackfillDialog, IconButton, canBackfill } from ${JSON.stringify(join(pluginRoot, 'src/client/SubscriptionManager.jsx'))};`,
          `import { AddFeedDialog, GroupMenu, GroupField } from ${JSON.stringify(join(pluginRoot, 'src/client/dialogs.jsx'))};`,
          `import { groupNamesOf } from ${JSON.stringify(join(pluginRoot, 'src/client/groups.js'))};`,
          `export { React, renderToStaticMarkup, SubscriptionManager, SubscriptionRow, BackfillDialog, IconButton, canBackfill, AddFeedDialog, GroupMenu, GroupField, groupNamesOf };`,
        ].join('\n'),
        resolveDir: pluginRoot,
        loader: 'js',
        sourcefile: 'subscriptions-render-entry.mjs',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      outfile: outFile,
      logLevel: 'warning',
    });
    return import(`${pathToFileURL(outFile).href}?v=${Date.now()}`);
  })();
  return pending;
}

const {
  React, renderToStaticMarkup, SubscriptionManager, SubscriptionRow, BackfillDialog, IconButton, canBackfill, AddFeedDialog, GroupMenu, groupNamesOf,
} = await loadModule();
const api = new Proxy({}, { get: () => async () => ({ subscriptions: [] }) });
const noop = () => {};

const render = (subscriptions) => renderToStaticMarkup(
  React.createElement(SubscriptionManager, { api, subscriptions, onChange: noop, notify: noop }),
);

const count = (html, needle) => html.split(needle).length - 1;

/** 两个图标各自独有的那一段 path —— 用它判断「渲染出来的到底是哪个图标」。 */
const LAYERS_PATH = 'm22 17.65-9.17 4.16';
const REFRESH_PATH = 'M21 3v5h-5';

const ROWS = [
  { id: 'feed:lex', name: 'Lex 中文精读', url: 'https://lex.qiaomu.ai/feed.xml', entryCount: 20 },
  { id: 'feed:big', name: '大源', url: 'https://big.test/feed', entryCount: 121 },
  { id: 'feed:done', name: '补过的源', url: 'https://done.test/feed', entryCount: 20, backfilledAt: 1_700_000_000_000 },
  { id: 'feed:checked', name: '查过没更多的源', url: 'https://checked.test/feed', entryCount: 12, backfillCheckedAt: 1_700_000_000_000 },
];

const row = (overrides = {}) => renderToStaticMarkup(React.createElement(SubscriptionRow, {
  sub: { id: 'feed:lex', name: 'Lex 中文精读', url: 'https://lex.qiaomu.ai/feed.xml', entryCount: 20 },
  busy: false,
  backfilling: false,
  selected: false,
  onToggle: noop,
  onBackfill: noop,
  onEdit: noop,
  onCopy: noop,
  ...overrides,
}));

describe('订阅行：补全历史入口的出现条件', () => {
  it('只在「条数少 + 没补过 + 没查过」的那一行出现', () => {
    const html = render(ROWS);
    assert.equal(count(html, 'aria-label="补全历史文章"'), 1, '4 行里只有 Lex 那行该有这个入口');
  });

  it('每一行都还有编辑与复制（入口收起来不等于动作没了）', () => {
    const html = render(ROWS);
    assert.equal(count(html, 'aria-label="编辑订阅"'), ROWS.length);
    assert.equal(count(html, 'aria-label="复制订阅地址"'), ROWS.length);
  });

  it('canBackfill 的三条边界', () => {
    assert.equal(canBackfill({ entryCount: 20 }), true);
    assert.equal(canBackfill({ entryCount: 100 }), false, '100 条及以上不提供');
    assert.equal(canBackfill({ entryCount: 20, backfilledAt: 1 }), false);
    assert.equal(canBackfill({ entryCount: 20, backfillCheckedAt: 1 }), false);
    assert.equal(canBackfill({}), true, '缺 entryCount 时按 0 处理，仍然提供');
  });

  it('补过的行标出「已补全历史」', () => {
    assert.equal(count(render(ROWS), '已补全历史'), 1);
  });
});

describe('订阅行：补全进行中的样子', () => {
  it('空闲时是三层方块图标、没有进度文案、没有 aria-busy', () => {
    const html = row();
    assert.ok(html.includes(LAYERS_PATH), '空闲时该是 layers-3');
    assert.ok(!html.includes(REFRESH_PATH), '空闲时不该出现转圈图标');
    assert.ok(!html.includes('正在读取站点目录'), '空闲时不该有进度文案');
    assert.ok(!html.includes('aria-busy'), '空闲时不该标 aria-busy');
    assert.ok(!html.includes('npr-icon-spin'), '空闲时不该转');
  });

  it('进行中：换成转圈图标、标 aria-busy、按钮 disabled、行内写出进度', () => {
    const html = row({ busy: true, backfilling: true });
    assert.ok(html.includes(REFRESH_PATH), '进行中必须换成 refresh-cw');
    assert.ok(html.includes('npr-icon-spin'), '进行中的图标要转起来');
    assert.ok(html.includes('aria-busy="true"'), '进行中要标 aria-busy（读屏也读得出来）');
    assert.ok(html.includes('正在读取站点目录'), '行内要写出「正在读取站点目录」，光变灰不够');
    assert.ok(html.includes('data-backfilling="true"'), '行上要留可断言的标记');
    // ★ 断言「按钮真的 disabled」必须落在**那一个按钮**上，不能只数整行里有几个 disabled：
    //   复选框在 busy 时也是 disabled，数总量会掩盖「补全按钮忘了禁用」。
    const button = html.match(/<button[^>]*aria-label="正在读取站点目录…"[^>]*>/)?.[0] ?? '';
    assert.ok(button.includes('disabled'), `补全按钮必须 disabled，实际拿到：${button}`);
  });

  it('进行中不再显示「补全历史文章」这个名字（否则读屏会说反话）', () => {
    const html = row({ busy: true, backfilling: true });
    assert.ok(!html.includes('aria-label="补全历史文章"'));
  });

  it('busy 时禁用的是会碰宿主的动作，不是全部', () => {
    const html = row({ busy: true, backfilling: true });
    for (const label of ['正在读取站点目录…', '编辑订阅']) {
      const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
      assert.ok(button.includes('disabled'), `${label} 在 busy 时也要禁用`);
    }
    // ★ 复制**故意不禁用**：它只写本地剪贴板、不碰宿主，探测跑十几秒的期间
    //   它是这一行里唯一还能用的动作。把它一起灰掉是「看起来整齐」的假一致。
    const copy = html.match(/<button[^>]*aria-label="复制订阅地址"[^>]*>/)?.[0] ?? '';
    assert.ok(copy.includes('disabled') === false, '复制不该随 busy 禁用');
  });

  /**
   * ★ 这一条是**结构性断言**，故意如此，并且要说明它测不到什么：
   *   上面那些渲染断言都建立在「调用方真的把 `backfilling` 传进来」之上，
   *   而 `startBackfill` 是组件内部的闭包 —— 静态渲染不会执行点击，够不着它。
   *   能靠渲染证明的只有「给了 backfilling 会长什么样」，接线的三行只能核对源码。
   *   ★ 最后那条最值得留：忘了在 `finally` 里清 id，那一行会**永远转圈**。
   */
  it('管理器把「正在补全的那个 id」接到行上（结构性）', () => {
    const source = readFileSync(join(pluginRoot, 'src/client/SubscriptionManager.jsx'), 'utf8');
    assert.match(source, /setBackfillingId\(sub\.id\)/, '开始补全时必须记下目标 id');
    assert.match(source, /backfilling=\{backfillingId === sub\.id\}/, '行必须按 id 匹配拿到 backfilling');
    assert.match(source, /finally\s*\{[^}]*setBackfillingId\(null\)/, '结束必须清掉，否则那一行永远转圈');
    assert.match(source, /backfillLock\.current/, '还要有单次闸门：disabled 挡不住同一帧的第二次点击');
  });
});

describe('图标提示', () => {
  it('提示气泡的样式真的存在，且是 fixed 定位（否则会被滚动容器裁掉）', () => {
    const css = readFileSync(join(pluginRoot, 'src/client/refinements.css'), 'utf8');
    assert.match(css, /\.npr-tip\s*\{[^}]*position:\s*fixed/, '.npr-tip 必须是 fixed 定位');
    assert.match(css, /\.npr-tip\s*\{[^}]*pointer-events:\s*none/, '提示不能吃掉鼠标事件，否则会自己把自己关掉');
  });

  it('三个图标按钮都有可读的名字（图标本身没有文字）', () => {
    const html = render([{ id: 'feed:a', name: 'A', url: 'https://a.test/feed', entryCount: 20 }]);
    for (const label of ['补全历史文章', '编辑订阅', '复制订阅地址']) {
      assert.ok(html.includes(`aria-label="${label}"`), `${label} 缺 aria-label`);
    }
  });

  it('补全弹窗把来源与条数写清楚', () => {
    const html = renderToStaticMarkup(React.createElement(BackfillDialog, {
      busy: false,
      onCancel: noop,
      onConfirm: noop,
      state: {
        sub: { name: 'Lex' },
        preview: {
          kind: 'archive',
          source: 'https://lex.qiaomu.ai/archive/',
          found: 506,
          added: 486,
          sample: [{ title: '精神病学、疯人院', publishedAt: '2026-09-16T00:00:00.000Z', url: 'https://lex.qiaomu.ai/ep/andrew-scull/' }],
        },
      },
    }));
    assert.ok(html.includes('站点归档页'));
    assert.ok(html.includes('506') && html.includes('486'));
    assert.ok(html.includes('补全 486 篇'));
  });

  it('落盘那一秒也要有话说（写 500 条不是瞬时的）', () => {
    const html = renderToStaticMarkup(React.createElement(BackfillDialog, {
      busy: true,
      onCancel: noop,
      onConfirm: noop,
      state: { sub: { name: 'Lex' }, preview: { kind: 'archive', source: 'https://lex.qiaomu.ai/archive/', found: 506, added: 486, sample: [] } },
    }));
    assert.ok(html.includes('正在写入'), 'busy 时确认按钮要改文案');
    assert.ok(!html.includes('补全 486 篇'), 'busy 时不该还写着「补全 486 篇」');
  });
});

describe('「补全中」的样式真的存在（没有样式时 disabled 等于没做）', () => {
  const css = readFileSync(join(pluginRoot, 'src/client/refinements.css'), 'utf8');

  it('订阅行的按钮有 :disabled 形态', () => {
    assert.match(css, /\.npr-subscription-actions button:disabled[^{]*\{[^}]*opacity/, '缺 :disabled 样式 ⇒ 看着能点、点了没反应');
  });

  it('转圈动画有定义，且尊重「减少动态效果」', () => {
    assert.match(css, /@keyframes npr-icon-spin/, '缺 npr-icon-spin 关键帧，图标不会动');
    assert.match(css, /prefers-reduced-motion[^{]*\{[^}]*\.npr-icon-spin/, '减少动效时至少要放慢，不能直接停（停掉就没有「正在干活」这个信号了）');
  });

  it('行内进度用的是中性色，不是错误红', () => {
    const block = css.match(/\.npr-subscription-copy \.npr-subscription-progress\s*\{[^}]*\}/)?.[0] ?? '';
    assert.ok(block, '缺 .npr-subscription-progress 样式，进度文案会继承 small 的错误红');
    assert.ok(block.includes('var(--npr-muted)'));
    assert.ok(!block.includes('state-error'), '进度不是错误，不能用错误色');
  });
});

describe('分组清单：两处必须同源', () => {
  it('去重、丢掉空值、按中文排序', () => {
    const items = [{ group: '技术' }, { group: '写作' }, { group: '技术' }, { group: undefined }, { group: '' }, {}];
    assert.deepEqual(groupNamesOf(items), ['技术', '写作'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
  });

  it('宿主频道对象可以直接喂进来（阅读页那侧靠这个，不用另拉订阅列表）', () => {
    const channels = [
      { key: 'all', kind: 'aggregate' },
      { key: 'group:技术', kind: 'aggregate', name: '技术' },
      { key: 'feed:a', kind: 'feed', group: '技术' },
      { key: 'feed:b', kind: 'feed' },
    ];
    assert.deepEqual(groupNamesOf(channels), ['技术'], '分组频道自己不带 group，不能被重复计入');
  });

  it('空输入不炸', () => {
    assert.deepEqual(groupNamesOf(undefined), []);
    assert.deepEqual(groupNamesOf([]), []);
  });
});

describe('添加订阅：分组是「可选的已有项 + 可自定义」', () => {
  const dialog = (groups) => renderToStaticMarkup(React.createElement(AddFeedDialog, {
    api, groups, onClose: noop, onDone: noop, notify: noop,
  }));
  const button = (html, label) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';

  it('分组框仍然是自由输入 —— 不是只能选的 <select>', () => {
    const html = dialog(['技术']);
    assert.ok(!html.includes('<select'), '换成 select 就把「新建分组」这条路堵死了');
    assert.ok(html.includes('aria-label="订阅分组"'), '分组框要在');
  });

  /**
   * ★ 这一条是**实测换来的**：`<input list>` + `<datalist>` 在 Chromium 里
   *   **只在输入框获得焦点时才画那个小箭头**，未聚焦时和普通文本框一模一样
   *   （用 Chrome headless 截了三态对照图确认）。而「看不出这里能点」正是要修的问题，
   *   所以这里断言的是「有一个常驻可见的按钮」，不是「有 datalist」。
   */
  it('有一个常驻可见的下拉按钮（不靠只在聚焦时才出现的原生箭头）', () => {
    const html = dialog(['技术', '写作']);
    const toggle = button(html, '从已有分组里选');
    assert.ok(toggle, '缺下拉按钮 ⇒ 用户看不出这里能选');
    assert.ok(!toggle.includes('disabled'), '有分组时按钮必须能点');
    assert.ok(html.includes('aria-expanded="false"'), '要交代展开状态');
    assert.ok(!html.includes('<datalist'), '不要再叠一个 datalist：两套交互模型会互相打架');
  });

  it('没有已有分组时按钮禁用，并如实说「输入一个就是新建」', () => {
    const html = dialog([]);
    const toggle = button(html, '还没有已有分组');
    assert.ok(toggle.includes('disabled'), '没有候选时按钮不能装作能点');
    assert.ok(html.includes('新建'), '没有分组时要说明「输入就是新建」');
    assert.ok(!html.includes('已有 0 个分组'), '不能出现「已有 0 个分组」这种空话');
  });

  it('有分组时提示行给出条数与用法', () => {
    assert.ok(dialog(['技术', '写作']).includes('已有 2 个分组'));
  });

  it('展开后的候选清单：一个分组一个按钮，当前值标出来', () => {
    const html = renderToStaticMarkup(React.createElement(GroupMenu, {
      id: 'npr-addfeed-groups', groups: ['技术', '写作', '播客'], value: '写作', onPick: noop,
    }));
    assert.equal(count(html, '<button'), 3, '三个分组三个按钮');
    assert.equal(count(html, 'aria-pressed="true"'), 1, '只有当前值算选中');
    const active = html.match(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)</)?.[1] ?? '';
    assert.equal(active, '写作');
    assert.ok(html.includes('id="npr-addfeed-groups"'));
  });

  it('候选清单的 id 与订阅管理里那个不同（设置页里两者同时挂载）', () => {
    const html = renderToStaticMarkup(React.createElement(GroupMenu, { id: 'npr-addfeed-groups', groups: ['技术'], value: '', onPick: noop }));
    assert.ok(html.includes('id="npr-addfeed-groups"'), '弹窗这侧用固定的 id');
    // 后半截是**故意的源码断言**：编辑订阅弹窗只在点了铅笔之后才挂载，静态渲染
    // 碰不到它，所以「两个 id 不同」只能在这里从源码核对。
    const source = readFileSync(join(pluginRoot, 'src/client/SubscriptionManager.jsx'), 'utf8');
    assert.ok(source.includes('npr-existing-groups'), '订阅管理的编辑弹窗仍用另一个 id');
    assert.ok(!source.includes('npr-addfeed-groups'), '订阅管理里不能借用弹窗的 id');
  });
});

describe('分组下拉的样式（位置错一点就等于没做）', () => {
  const css = readFileSync(join(pluginRoot, 'src/client/refinements.css'), 'utf8');
  const block = (selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`))?.[0] ?? '';

  it('候选清单是绝对定位且**向上**弹', () => {
    const menu = block('.npr-groupfield-menu');
    assert.ok(menu.includes('position: absolute'), '不浮起来就不像下拉');
    assert.ok(menu.includes('bottom:'), '必须向上弹：向下弹会被 .npr-modal 的 overflow:auto 裁掉');
    assert.ok(!menu.includes('top:'), '同时写 top 会把「向上」抵消掉');
    assert.ok(menu.includes('max-height'), '分组多时不能撑破弹窗');
  });

  it('下拉按钮禁用时有可见形态', () => {
    assert.match(css, /\.npr-groupfield-toggle:disabled\s*\{[^}]*opacity/, '缺 :disabled 样式 ⇒ 看着能点');
  });
});
