import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOOK_TINTS, FONTS, fontStack, nextBookTint, normalizeBookTint, READING_DEFAULTS, TEXT_WIDTHS, THEMES, validateSettings } from '../src/reading-settings.js';
import { BOOK_SOURCES_MAX, LIBRARY_PATH_DEFAULT, sourceListId } from '../src/library.js';

describe('READING_DEFAULTS', () => {
  it('is a complete, valid settings object', () => {
    assert.deepEqual(validateSettings(READING_DEFAULTS), READING_DEFAULTS);
    assert.equal(READING_DEFAULTS.readingTheme, 'auto');
    assert.equal(READING_DEFAULTS.defaultVersion, 'original');
    assert.equal(READING_DEFAULTS.showImages, true);
  });

  it('only offers themes and widths that the CSS can actually render', () => {
    for (const theme of Object.keys(THEMES)) {
      assert.ok(THEMES[theme] === null || (Array.isArray(THEMES[theme]) && THEMES[theme].length === 2), theme);
    }
    assert.ok(Object.hasOwn(THEMES, 'auto'), 'auto must stay a real key so validateSettings accepts it');
    for (const width of TEXT_WIDTHS) {
      assert.ok(Number.isInteger(width.value) && width.value >= 28 && width.value <= 44, String(width.value));
      assert.equal(typeof width.label, 'string');
    }
  });
});

describe('validateSettings', () => {
  it('keeps known keys and silently drops unknown ones', () => {
    assert.deepEqual(validateSettings({ fontSize: 20, nonsense: 1 }), { fontSize: 20 });
    assert.deepEqual(validateSettings({}), {});
  });

  it('rejects a non-object patch, while "no patch" means an empty one', () => {
    for (const bad of [null, 'x', 42, true, []]) {
      assert.throws(() => validateSettings(bad), /设置必须是对象/, String(bad));
    }
    // `undefined` is indistinguishable from "no argument" in JS, and the default
    // parameter deliberately maps it to an empty patch (= change nothing). Listing
    // it under "must throw" is wrong: it can never throw.
    assert.deepEqual(validateSettings(undefined), {});
    assert.deepEqual(validateSettings(), {});
  });

  it('requires booleans for the toggles', () => {
    assert.deepEqual(validateSettings({ aiAssist: false, showImages: true }), { aiAssist: false, showImages: true });
    assert.throws(() => validateSettings({ aiAssist: 'yes' }), /aiAssist 必须是布尔值/);
    assert.throws(() => validateSettings({ showImages: 1 }), /showImages 必须是布尔值/);
    // autoTranslate 一开就会调模型（计费行为），所以类型也必须卡死：
    // 把字符串 'false' 当成真值收下，等于用户以为关了、其实一直在花钱。
    assert.deepEqual(validateSettings({ autoTranslate: true }), { autoTranslate: true });
    assert.deepEqual(validateSettings({ autoTranslate: false }), { autoTranslate: false });
    for (const bad of ['true', 'false', 1, 0, null, {}]) {
      assert.throws(() => validateSettings({ autoTranslate: bad }), /autoTranslate 必须是布尔值/, String(bad));
    }
  });

  it('★ 英文自动翻译默认是关的', () => {
    // 默认替用户打开一个计费行为不合适。这条断言是防「顺手改成 true」的。
    assert.equal(READING_DEFAULTS.autoTranslate, false);
  });

  it('rejects unknown themes, fonts and versions', () => {
    assert.throws(() => validateSettings({ readingTheme: 'neon' }), /无效阅读主题/);
    assert.throws(() => validateSettings({ readingFont: 'comic-sans' }), /无效字体/);
    assert.throws(() => validateSettings({ defaultVersion: 'podcast' }), /无效默认版本/);
  });

  /**
   * 书页配色（`bookTint`）是**另一个设置项**，不是 `readingTheme` 的别名：
   * 后者换的是排版出来的 HTML 正文的纸色，而电子书是一张位图，改纸色对它无效。
   * 合并成一个的话，用户在文章里选「纸张」、打开 PDF 却毫无变化 —— 看起来就是坏了。
   */
  it('★ 书页配色：三档合法值，其余一律报错（不静默改成原色）', () => {
    assert.equal(READING_DEFAULTS.bookTint, 'paper');
    for (const tint of ['paper', 'sepia', 'night']) {
      assert.deepEqual(validateSettings({ bookTint: tint }), { bookTint: tint }, tint);
    }
    // 反向对照：`readingTheme` 的值不能顺着溜进 `bookTint`（两套取值完全不同）。
    for (const bad of ['dark', 'black', 'sage', 'auto', '', null, 1]) {
      assert.throws(() => validateSettings({ bookTint: bad }), /无效书页配色/, String(bad));
    }
  });

  it('★ 配色轮转：原色 → 护眼 → 薄荷 → 夜间 → 原色，未知值先归一到原色', () => {
    assert.equal(nextBookTint('paper'), 'sepia');
    assert.equal(nextBookTint('sepia'), 'mint');
    assert.equal(nextBookTint('mint'), 'night');
    assert.equal(nextBookTint('night'), 'paper');
    // 坏值不能把界面卡在「既不原色也不护眼」的中间态。
    assert.equal(normalizeBookTint('neon'), 'paper');
    assert.equal(normalizeBookTint(undefined), 'paper');
    assert.equal(nextBookTint('neon'), 'sepia');
  });

  it('enforces numeric ranges instead of clamping silently', () => {
    assert.deepEqual(validateSettings({ fontSize: 14, lineHeight: 1.5, textWidth: 28 }), { fontSize: 14, lineHeight: 1.5, textWidth: 28 });
    assert.deepEqual(validateSettings({ fontSize: 32, lineHeight: 2.4, textWidth: 44 }), { fontSize: 32, lineHeight: 2.4, textWidth: 44 });
    for (const bad of [{ fontSize: 13 }, { fontSize: 33 }, { lineHeight: 1.4 }, { lineHeight: 2.5 }, { textWidth: 27 }, { textWidth: 45 }]) {
      assert.throws(() => validateSettings(bad), /超出范围/, JSON.stringify(bad));
    }
    assert.throws(() => validateSettings({ fontSize: '20' }), /超出范围/);
    assert.throws(() => validateSettings({ fontSize: NaN }), /超出范围/);
  });

  it('caps the custom font name', () => {
    assert.deepEqual(validateSettings({ customFont: 'LXGW WenKai' }), { customFont: 'LXGW WenKai' });
    assert.deepEqual(validateSettings({ customFont: '' }), { customFont: '' });
    assert.throws(() => validateSettings({ customFont: 'x'.repeat(101) }), /最长 100 字符/);
    assert.throws(() => validateSettings({ customFont: 7 }), /最长 100 字符/);
  });

  it('leaves a rejected patch unapplied (throws instead of returning a partial object)', () => {
    assert.throws(() => validateSettings({ fontSize: 20, readingTheme: 'neon' }), /无效阅读主题/);
  });

  // ---- 书架（电子书）两个字段 -------------------------------------------
  it('★ bookshelf 是布尔开关，默认开', () => {
    assert.equal(READING_DEFAULTS.bookshelf, true);
    assert.deepEqual(validateSettings({ bookshelf: false }), { bookshelf: false });
    assert.deepEqual(validateSettings({ bookshelf: true }), { bookshelf: true });
    for (const bad of ['yes', 1, 0, null]) {
      assert.throws(() => validateSettings({ bookshelf: bad }), /bookshelf 必须是布尔值/, String(bad));
    }
  });

  it('★ libraryPath 默认是空串 —— 由宿主展开成**插件数据目录**（真值在共用模块里）', () => {
    // 这条断言盯的是「默认值只有一个来源」：它必须等于 `src/library.js` 里的常量，
    // 而不是 `reading-settings.js` 里另抄的一份 —— 两处各写一遍会悄悄漂开，
    // 症状是「设置页显示的默认路径」与「实际去读的路径」不是同一个。
    assert.equal(READING_DEFAULTS.libraryPath, LIBRARY_PATH_DEFAULT);
    // 空串 = 插件数据目录，不是用户机器上的某个绝对路径（否则别人装完书架一定是空的）。
    assert.equal(LIBRARY_PATH_DEFAULT, '');
    assert.equal(LIBRARY_PATH_DEFAULT.includes('~'), false);
  });

  it('★ bookSources 默认是**空数组** —— 它是有意义的状态，界面据此引导去配书源', () => {
    assert.deepEqual(READING_DEFAULTS.bookSources, []);
    // 反向对照：默认值不能是 null / undefined。界面会直接 `.map()` 它。
    assert.equal(Array.isArray(READING_DEFAULTS.bookSources), true);
  });

  it('★ bookSources：数组里的非法**条目**丢掉不报错 —— 别把整份设置一起卡住', () => {
    // 一条手滑写坏的书源不该让阅读外观、订阅服务这些毫不相干的设置也存不进去 ——
    // 用户根本看不出问题出在书源那一行。
    assert.deepEqual(validateSettings({ bookSources: [{ kind: 'bogus', path: '/a' }] }), { bookSources: [] });
    // 规则是「一条源产出一份书单」：合法条目出来时 id（书单文件名）与 name（书单名）都已就位。
    assert.deepEqual(validateSettings({ bookSources: [{ kind: 'local', path: '/a' }, 'nope', null, 42] }), {
      bookSources: [{ id: sourceListId('local', '/a'), kind: 'local', path: '/a', name: 'a' }],
    });
    // 反向对照：**同时**出现别的字段时，别的字段必须照常生效 —— 这才是「丢坏行」
    // 与「整份设置被连带卡住」的区别。
    assert.deepEqual(
      validateSettings({ bookSources: [{ kind: 'bogus', path: '/a' }], fontSize: 20 }),
      { bookSources: [], fontSize: 20 },
    );
    // 但「**字段本身**不是数组」是另一回事：那是类型写错了（同 libraryPath 传数字），
    // 报一句明确的错比静默把用户配好的书源清空安全。
    for (const bad of [null, 'x', 42, {}]) {
      assert.throws(() => validateSettings({ bookSources: bad }), /书源必须是数组/, String(bad));
    }
  });

  it('bookSources：合法条目按共用模块的判据规范化（trim / 去重 / 限长 / 补 id 与名字）', () => {
    assert.deepEqual(validateSettings({ bookSources: [{ kind: 'pan', path: '  /我的资源/电子书  ' }] }), {
      bookSources: [
        {
          id: sourceListId('pan', '/我的资源/电子书'),
          kind: 'pan',
          path: '/我的资源/电子书',
          name: '网盘 · 电子书',
        },
      ],
    });
    assert.deepEqual(
      validateSettings({ bookSources: [{ kind: 'local', path: '/a' }, { kind: 'local', path: '/a' }] }),
      { bookSources: [{ id: sourceListId('local', '/a'), kind: 'local', path: '/a', name: 'a' }] },
    );
    // 超过上限的直接截断（BOOK_SOURCES_MAX = 32）。
    const many = Array.from({ length: 40 }, (unused, index) => ({ kind: 'local', path: `/d${index}` }));
    assert.equal(validateSettings({ bookSources: many }).bookSources.length, BOOK_SOURCES_MAX);
  });

  it('★ libraryListIds 接受字符串数组；坏 id 丢掉，非数组报错', () => {
    const id = sourceListId('local', '/a');
    assert.deepEqual(validateSettings({ libraryListIds: [id] }), { libraryListIds: [id] });
    // 重复 / 两侧空格都在共用模块里收敛。
    assert.deepEqual(validateSettings({ libraryListIds: [id, id, ` ${id} `] }), { libraryListIds: [id] });
    // 坏 id 丢掉（形状不合法），不把整份设置卡死。
    assert.deepEqual(validateSettings({ libraryListIds: [id, '', '有中文'] }), { libraryListIds: [id] });
    // 空数组是**有意义**的状态：「一份都不载入」。
    assert.deepEqual(validateSettings({ libraryListIds: [] }), { libraryListIds: [] });
    // 反向对照：字段本身写错类型要报错，而不是静默清空用户勾好的载入选择。
    for (const bad of [null, 'x', 42, {}]) {
      assert.throws(() => validateSettings({ libraryListIds: bad }), /已载入书单必须是数组/, String(bad));
    }
  });

  it('libraryPath 接受字符串；空串表示「回到默认」而不是错误', () => {
    assert.deepEqual(validateSettings({ libraryPath: '/tmp/books.json' }), { libraryPath: '/tmp/books.json' });
    assert.deepEqual(validateSettings({ libraryPath: '~/x/books.json' }), { libraryPath: '~/x/books.json' });
    assert.deepEqual(validateSettings({ libraryPath: '' }), { libraryPath: '' });
    assert.deepEqual(validateSettings({ libraryPath: '   ' }), { libraryPath: '   ' });
  });

  it('★ libraryPath 拒绝过长与非字符串；`\\0` 一律拒（路径里不可能合法出现）', () => {
    // 断言消息文本，不写字段名：校验里「类型不对」与「过长」共用一句话
    // （`typeof value !== 'string' || value.length > 500`），所以匹配 `/libraryPath/`
    // 会永远不成立 —— 那是一条「看着在测、其实测的是别的东西」的假绿。
    assert.throws(() => validateSettings({ libraryPath: 'x'.repeat(501) }), /书单路径最长 500 字符/, '过长');
    for (const bad of [7, null, true, {}]) {
      assert.throws(() => validateSettings({ libraryPath: bad }), /书单路径最长 500 字符/, String(bad));
    }
    // NUL 是路径注入的经典入口（C 层会在这里截断），而且任何合法路径都不会有它。
    assert.throws(() => validateSettings({ libraryPath: '/tmp/a\u0000b.json' }), /不能包含空字符/);
    // 反向对照：正好 500 字符是**合法**的（边界不许误杀）。
    assert.equal(validateSettings({ libraryPath: 'x'.repeat(500) }).libraryPath.length, 500);
  });
});

describe('fontStack', () => {
  it('resolves each named font to its stack', () => {
    for (const key of Object.keys(FONTS)) {
      assert.equal(typeof fontStack({ readingFont: key }), 'string');
      assert.ok(fontStack({ readingFont: key }).length > 0, key);
    }
    assert.equal(fontStack({ readingFont: 'serif' }), FONTS.serif.family);
  });

  it('quotes a custom device font name and keeps a serif fallback', () => {
    const stack = fontStack({ readingFont: 'custom', customFont: 'LXGW WenKai' });
    assert.equal(stack, `"LXGW WenKai",${FONTS.serif.family}`);
  });

  it('escapes the custom font name so it cannot break out of the CSS string', () => {
    // 载荷文本（`color:red`）**本来就会留在输出里** —— 它被转义进同一个 CSS 字符串
    // token，无法终止 `font-family` 声明。所以判据不是「文本不存在」（那样会误报），
    // 而是「这个 token 能不能原样解回载荷」。别把这条改回 includes('color:red')。
    const suffix = `,${FONTS.serif.family}`;

    for (const evil of ['x";color:red;/*', 'a\\', 'b\nc']) {
      const stack = fontStack({ readingFont: 'custom', customFont: evil });
      assert.ok(stack.endsWith(suffix), stack);

      const quoted = stack.slice(0, -suffix.length);
      // 一个判据同时覆盖两个逃逸方向：内层裸引号（提前闭合字符串）与奇尾反斜杠
      // （转义掉收尾引号、把后续声明一起吞进字符串）。
      assert.equal(JSON.parse(quoted), evil);

      // 反向对照组：朴素的 `"${name}"` 必须解不开，否则这条断言没有牙。
      assert.throws(() => JSON.parse(`"${evil}"`), SyntaxError, `control group must break: ${JSON.stringify(evil)}`);
    }
  });

  it('falls back to serif for a blank or unknown font', () => {
    assert.equal(fontStack({ readingFont: 'custom', customFont: '   ' }), FONTS.serif.family);
    assert.equal(fontStack({ readingFont: 'custom' }), FONTS.serif.family);
    assert.equal(fontStack({ readingFont: 'nope' }), FONTS.serif.family);
    assert.equal(fontStack({}), FONTS.serif.family);
  });
});
