/** Reading appearance: shared defaults, options, and validation for both halves. */
import { AI_MODEL_DEFAULT, isValidAiModel } from './ai-model.js';
import { LIBRARY_PATH_DEFAULT, normalizeBookSources, normalizeLibraryListIds } from './library.js';

export const READING_DEFAULTS = {
  readingTheme: 'auto',
  readingFont: 'serif',
  customFont: '',
  fontSize: 19,
  lineHeight: 1.9,
  textWidth: 36,
  defaultVersion: 'original',
  showImages: true,
  /**
   * 英文原文自动翻译成中文。
   *
   * ★ 默认 **false**：这一项一开就会**花模型的钱**（每次打开一篇英文文章都调一次
   *   LLM）。默认替用户打开一个计费行为不合适，所以让它在设置页里显式打开。
   *   打开之后，界面上就不再需要「在伴读框里打一句 prompt 让它翻译」这种绕路。
   *
   * 只在原文被判为**英文**（`src/language.js` → `en`）且该篇还没有中文版本时触发；
   * 中文原文、日文/韩文原文、语种样本不足，都什么都不做。
   */
  autoTranslate: false,
  /**
   * 翻译 / 改写用哪个模型。
   *
   * `''` = 跟随 Harness 的默认模型；否则是 `'<provider>/<model>'`。
   * 存在的理由：翻译是**量大、重复、对模型智力要求低**的活 —— 用户会想把它压到
   * 一个便宜的（甚至是免费的）模型上，而不是烧默认模型。取值形态与解析见
   * `src/ai-model.js`（两端共用一份判据）。
   */
  aiModel: AI_MODEL_DEFAULT,
  /**
   * 电子书**逐章解读**用哪个模型（取值形态与 `aiModel` 完全相同）。
   *
   * ★ 为什么不复用 `aiModel`：两者的**代价结构完全不同**。翻译是「一篇一次」，
   *   解读是「一本书 N 章 × 每章几万字」，同一本书跑一次可能几十次调用。用户会
   *   很自然地想「翻译用好模型、解读先拿免费的跑一遍看看」，合成一个设置就必然
   *   牺牲其中一个。默认同样留空 = 跟随 Harness 默认模型（不在用户不知情时计费）。
   */
  digestModel: AI_MODEL_DEFAULT,
  /**
   * 书架：**外部**书单文件的位置（`~` 会被展开成主目录）。**留空 = 不用外部书单。**
   *
   * 这是「我已经有一份整理了很久的书单」那条路，与插件自己生成的书单**并列**
   * （两边都载入时合并、按 id 去重），不是替代关系。
   *
   * ★ 只**读**这个文件。「生成书单」永远只写插件数据目录，**绝不写这里指向的文件**
   *   —— 它可能是用户整理了很久的书单，覆盖掉不可逆（见 `host/library.js` 的四条边界）。
   *   阅读进度也不写回它，见 `store.js` 里 `library` 的说明。
   */
  libraryPath: LIBRARY_PATH_DEFAULT,
  /**
   * 载入哪几份**插件自己生成**的书单（`bookSources` 里每条源对应一份）。
   *
   * ★ 与 `libraryPath` 是两个方向的两件事：那个是「外面那份文件」，这个是「我们自己
   *   扫出来的那几份」。分开存而不是合成一个列表，是因为它们的**写入者不同** ——
   *   前者由用户手打路径、后者由扫描产出。合在一起后，「生成书单」这一步就得顺手
   *   改用户的配置，而那是"你没有让我改"的那类越权。
   *
   * 空数组是**有意义的状态**：一份都没载入 ⇒ 书架只显示外部书单（或空）。界面据此提示。
   */
  libraryListIds: [],
  /**
   * 书源：从哪里扫出书单。`[{ id, kind: 'local' | 'pan', path, name }]`。
   *
   * 空数组是**有意义的状态** —— 它表示「还没配任何书源」。界面据此引导用户去配，
   * 而不是显示一个空书架让他以为自己的书丢了。
   *
   * ★ 每条源对应**一份书单**（`lists/<id>.json`），所以这个列表同时也是
   *   「第二步要生成哪几份」和「第三步可以载入哪几份」的清单。
   */
  bookSources: [],
  /** 是否在阅读器里显示「书架」分页。关掉之后只有订阅，界面回到 0.5.0 的样子。 */
  bookshelf: true,
  /**
   * 电子书（PDF）书页的配色：`paper` 原色 / `sepia` 护眼 / `mint` 薄荷 / `night` 夜间。
   *
   * ★ 为什么不能复用上边那个 `readingTheme`：那一套换的是**排版出来**的 HTML 正文的
   *   纸色与字色；电子书是一张**位图**（pdf.js 画出来的画布），改 CSS 背景色对它
   *   毫无作用。位图只能整层染色/反色（`filter`），是另一条完全不同的实现路径，
   *   所以也必须是另一个设置项 —— 否则用户在文章里选「纸张」，打开 PDF 却毫无变化，
   *   只会认为这个设置坏了。
   */
  bookTint: 'paper',
  /**
   * 书页亮度（0.7 – 1.3，1 = 不调）。
   *
   * ★ 为什么单独一个设置项而不是并进 `bookTint`：色温和明度是**两件事** ——
   *   米黄纸在正午显得脏、夜里又不够暗，用户会想要「颜色不变、只要再暗一点」。
   *   合并成一个枚举就得给出「米黄偏暗」「米黄很暗」这种组合爆炸。
   * ★ 与 `bookTint` 一样只作用于**位图**（`filter`），HTML 正文有它自己的 `readingTheme`。
   */
  bookBrightness: 1,
};

/**
 * 「阅读外观」面板里**真正渲染出来**的字段。
 *
 * ★ 存在的理由（2026-10-25 实测的数据丢失）：那个面板的「恢复默认」原来提交的是
 *   `{ ...READING_DEFAULTS }` —— 整份默认值。而宿主 `saveSettings` 是
 *   `Object.assign(settings, validateSettings(patch))`，**整份覆盖**。
 *   于是用户在「⋯ → 阅读设置」里点一下「恢复默认」，本意只想把字号主题复原，
 *   实际连带清空了 `bookSources`（书源）、`libraryListIds`（载入哪几份书单）、
 *   `libraryPath`（外部书单路径）、`aiModel` / `digestModel`（翻译与解读模型）。
 *   复现脚本实测：点一次之后 `bookSources: []`、`libraryPath: ''` —— 书架当场变空，
 *   而界面只会显示「保存成功」。
 *
 * ★ 为什么按「面板渲染了什么」来划线，而不是按「哪些字段危险」：后者是一份会过期的
 *   黑名单（`settings-patch.js` 的文件头解释过同一件事）。这里的判据是**用户在这一屏
 *   能看见的东西** —— 看不见的字段，这个按钮就没有资格去动。
 */
export const APPEARANCE_KEYS = Object.freeze([
  'readingFont', 'customFont', 'fontSize', 'lineHeight', 'textWidth',
  'readingTheme', 'defaultVersion', 'showImages',
]);

/**
 * 「恢复默认」该提交的 patch：只含 {@link APPEARANCE_KEYS}。
 *
 * @returns 只含外观字段的默认值对象 —— 与 `READING_DEFAULTS` 同源，不另抄一份取值。
 */
export function appearanceDefaults() {
  return Object.fromEntries(APPEARANCE_KEYS.map((key) => [key, READING_DEFAULTS[key]]));
}

/** Theme id -> [background, foreground]; `auto` follows the host theme. */
export const THEMES = {
  auto: null, light: ['#ffffff', '#202124'], paper: ['#f5efdf', '#40382e'], sage: ['#e8eee3', '#29382c'],
  mist: ['#e7edf2', '#293741'], dark: ['#252525', '#dedede'], black: ['#090909', '#cccccc'],
};

/**
 * 电子书书页的配色档位（`bookTint`）。
 *
 * ★ 四档而不是一个「护眼开关」：夜里读 PDF 时白底会刺眼，米黄底在白天读起来
 *   又显得发灰，而长时间读纯白会觉得晃眼 —— 用户要的是「现在这个环境适合哪种」，
 *   「开 / 关」表达不了这件事。
 * ★ `mint`（薄荷绿）与文章主题里的 `sage` 是一路的护眼色，但**不能共用**：
 *   那套是给 HTML 正文的纸色，这套是给位图的滤镜（见下面 `bookTint` 的说明）。
 * ★ 顺序就是按钮的轮转顺序（原色 → 护眼 → 薄荷 → 夜间 → 原色），所以用对象而
 *   不是数组：键同时是 CSS 的属性值（`data-tint="…"`），一处定义两边取用。
 */
export const BOOK_TINTS = { paper: '原色', sepia: '护眼', mint: '薄荷', night: '夜间' };

/** 轮转到下一档。未知值先归一到 `paper`，再往后走一格。 */
export function nextBookTint(value) {
  const keys = Object.keys(BOOK_TINTS);
  const at = keys.indexOf(normalizeBookTint(value));
  return keys[(at + 1) % keys.length];
}

/** 合法值一律落到 `paper`（宁可回到原色，也不要把书页染成一片黑）。 */
export function normalizeBookTint(value) {
  return Object.hasOwn(BOOK_TINTS, value) ? value : 'paper';
}

/** 亮度的合法区间与步长（滑杆与校验共用一份，避免「滑杆能拖到 0.5、宿主拒收」）。 */
export const BOOK_BRIGHTNESS = Object.freeze({ min: 0.7, max: 1.3, step: 0.05 });

/** 亮度落到合法区间；非数字一律回 1（不调）。 */
export function normalizeBookBrightness(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  const { min, max } = BOOK_BRIGHTNESS;
  return Math.min(max, Math.max(min, Math.round(number * 100) / 100));
}

export const FONTS = {
  serif: { label: '宋体', family: '"Songti SC","Noto Serif CJK SC",Georgia,serif' },
  sans: { label: '黑体', family: 'system-ui,"PingFang SC","Noto Sans CJK SC",sans-serif' },
  sourceHanSerif: { label: '思源宋体', family: '"Source Han Serif SC","Noto Serif CJK SC","Songti SC",serif' },
  sourceHanSans: { label: '思源黑体', family: '"Source Han Sans SC","Noto Sans CJK SC","PingFang SC",sans-serif' },
  wenkai: { label: '霞鹜文楷', family: '"LXGW WenKai","Kaiti SC",serif' },
  zhenkai: { label: '朱雀仿宋', family: '"Zhuque Fangsong","Fangsong","STFangsong",serif' },
  custom: { label: '自选设备字体', family: 'serif' },
};

export const TEXT_WIDTHS = [
  { value: 28, label: '窄 · 28 字' },
  { value: 32, label: '偏窄 · 32 字' },
  { value: 36, label: '适中 · 36 字' },
  { value: 40, label: '偏宽 · 40 字' },
  { value: 44, label: '宽 · 44 字' },
];

/** Resolve the CSS font stack for one settings object. */
export function fontStack(settings) {
  if (settings.readingFont === 'custom') {
    const name = String(settings.customFont ?? '').trim();
    return name ? `${JSON.stringify(name)},${FONTS.serif.family}` : FONTS.serif.family;
  }
  return (FONTS[settings.readingFont] ?? FONTS.serif).family;
}

export function validateSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是对象');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (['aiAssist', 'showImages', 'fullText', 'autoTranslate', 'bookshelf'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    } else if (key === 'libraryPath') {
      // 空值 = 回到插件数据目录（而不是「没有书单」）。用户想清空输入框时不该报错。
      if (typeof value !== 'string' || value.length > 500) throw new Error('书单路径最长 500 字符');
      if (value.includes('\0')) throw new Error('书单路径不能包含空字符');
    } else if (key === 'bookSources') {
      /**
       * ★ 非法条目**丢掉**、不报错。
       *
       * 用户在界面上删到一半、或者直接手改设置文件写坏一行时，不该让**整份设置**
       * 存不进去 —— 那会连带把阅读外观、订阅服务这些毫不相干的设置一起卡住，
       * 而用户根本看不出问题出在书源那一行。
       *
       * 规范化只在这里有一份实现（`normalizeBookSources`，共用模块），所以
       * 界面、宿主、测试看到的是同一套「什么叫一条合法书源」。
       */
      if (!Array.isArray(value)) throw new Error('书源必须是数组');
      result[key] = normalizeBookSources(value);
      continue;
    } else if (key === 'libraryListIds') {
      // 与 `bookSources` 同一条理由：坏 id 丢掉、不报错。见 `normalizeLibraryListIds`
      // 顶部那段「为什么不校验 id 是否存在」。
      if (!Array.isArray(value)) throw new Error('已载入书单必须是数组');
      result[key] = normalizeLibraryListIds(value);
      continue;
    } else if (key === 'readingTheme') {
      if (!Object.hasOwn(THEMES, value)) throw new Error('无效阅读主题');
    } else if (key === 'bookTint') {
      // ★ 不在这里走 `normalizeBookTint` 的「静默修正」：手改设置文件写错一档时，
      //   报错比悄悄回到原色好 —— 后者会让用户以为「我明明设了夜间，怎么又白了」。
      if (!Object.hasOwn(BOOK_TINTS, value)) throw new Error('无效书页配色');
    } else if (key === 'bookBrightness') {
      // 同一条纪律：越界**报错**，不悄悄夹到边界上。亮度夹错了，用户会以为滑杆坏了。
      if (typeof value !== 'number' || !Number.isFinite(value)
        || value < BOOK_BRIGHTNESS.min || value > BOOK_BRIGHTNESS.max) {
        throw new Error(`书页亮度必须在 ${BOOK_BRIGHTNESS.min} – ${BOOK_BRIGHTNESS.max} 之间`);
      }
    } else if (key === 'readingFont') {
      if (!Object.hasOwn(FONTS, value)) throw new Error('无效字体');
    } else if (key === 'defaultVersion') {
      if (!['original', 'translation', 'rewrite'].includes(value)) throw new Error('无效默认版本');
    } else if (key === 'customFont') {
      if (typeof value !== 'string' || value.length > 100) throw new Error('自选字体名最长 100 字符');
    } else if (key === 'aiModel' || key === 'digestModel') {
      // ★ 判据与 `parseAiModel` 同源（都走 `isValidAiModel`）。两处各写一遍的话，
      //   会出现「设置页存下来了、宿主解析成 null」⇒ 静默回退到默认模型，
      //   用户以为在用免费模型，其实一直在花默认模型的钱。
      //   `digestModel` 走**同一个分支**而不是抄一份：两个设置项的取值形态与判据
      //   本来就是同一件事，抄一份就会在改判据时漏掉一个。
      if (!isValidAiModel(value)) throw new Error(`${key} 必须形如 provider/model，或留空表示跟随默认`);
    } else if (['fontSize', 'lineHeight', 'textWidth'].includes(key)) {
      const ranges = { fontSize: [14, 32], lineHeight: [1.5, 2.4], textWidth: [28, 44] };
      const [min, max] = ranges[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 超出范围`);
    } else continue;
    result[key] = value;
  }
  return result;
}
