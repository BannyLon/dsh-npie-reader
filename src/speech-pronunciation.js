/**
 * 发音修正词典（只改送进语音引擎的字，不改屏幕上看到的正文）。
 *
 * 解决的问题：中文多音字在缺少上下文时会被合成引擎读错，典型是「行李」念成
 * háng lǐ、「重庆」念成 zhòng qìng、「会计」念成 huì jì。同音字替换不依赖
 * 引擎的 SSML/注音能力，本机 speechSynthesis 与云端 CosyVoice2 都吃这一套。
 *
 * ★ 这里是**共用层零依赖纯函数**：宿主与客户端都不 import node 模块，测试可以
 *   直接真跑。词表与「一次扫描 + 最长匹配」的做法参考 shuting（MIT，
 *   Copyright (c) 2026 Zanbin Xu），只搬词条与判据，没搬它的用户自定义词典。
 *
 * ── 三条不能破的约束 ──────────────────────────────────────────────────
 *   1. **只改朗读文本**：显示层读的是 proseRef.innerText / blocksToText，
 *      从没经过这里。划线、笔记、搜索、导出的原文一律不受影响。
 *   2. **替换必须等长**：to 与 from 字数相同，于是分块边界、UTF-8 字节数、
 *      计费估算全部不变；不等长的词会让 chunk 末尾被硬切开。
 *   3. **变换必须发生在送合成之前**：宿主的缓存键是
 *      cacheKeyOf({ model, voice, speed, text })，text 就是客户端发来的那串。
 *      在客户端先变换，键天然落在变换后文本上，不必改宿主一行 ——
 *      反过来（宿主收到原文再变换）会让「换没换词典」共用同一份旧缓存。
 *
 * 词表刻意只收「默认读音容易错、且错得明显」的高置信度词条。有几类没收：
 * 有义项歧义的（「落下」多数时候读 luò，改成 là 反而是错的）、默认读音本来就
 * 对的（「旅行」「差别」，替换了也没听感收益）、以及需要全书语境判断的人名。
 */

export const PRONUNCIATION_KEY = 'npr.speechPronunciation';

/**
 * 内置词条（目前 19 条）。note 只给设置页与人看，不参与匹配。
 *
 * ★ 「行李袋」排在「行李」前面只是可读；真正的优先级由 applyPronunciation
 *   按首字分组后按长度降序决定，与这里的书写顺序无关。
 */
export const PRONUNCIATION_RULES = Object.freeze([
  // 行 xíng / háng
  { from: '行李袋', to: '行理袋', note: '行李读 xíng，不是 háng' },
  { from: '行李', to: '行理', note: '行李读 xíng，不是 háng' },
  // 重 chóng / zhòng
  { from: '重庆', to: '崇庆', note: '重庆读 chóng' },
  // 厦 xià / shà
  { from: '厦门', to: '夏门', note: '厦门读 xià' },
  // 会 kuài / huì
  { from: '会计', to: '快计', note: '会计读 kuài' },
  // 单 chán（单于）
  { from: '单于', to: '蝉于', note: '单于读 chán' },
  // 蕃 bō（吐蕃）
  { from: '吐蕃', to: '吐播', note: '吐蕃读 bō' },
  // 秘 bì（秘鲁）
  { from: '秘鲁', to: '必鲁', note: '秘鲁读 bì' },
  // 佛 fú（仿佛）
  { from: '仿佛', to: '仿弗', note: '仿佛读 fú' },
  // 龟 jūn（龟裂）
  { from: '龟裂', to: '军裂', note: '龟裂读 jūn' },
  // 阿 ē（阿胶）
  { from: '阿胶', to: '婀胶', note: '阿胶读 ē' },
  // 塞 sè（堵塞）
  { from: '堵塞', to: '堵色', note: '堵塞读 sè' },
  // 处 chǔ
  { from: '处理', to: '楚理', note: '处理读 chǔ' },
  { from: '处分', to: '楚分', note: '处分读 chǔ' },
  // 给 jǐ
  { from: '给予', to: '己予', note: '给予读 jǐ' },
  // 系 jì
  { from: '系鞋带', to: '记鞋带', note: '系鞋带读 jì' },
  // 提 dī
  { from: '提防', to: '低防', note: '提防读 dī' },
  // 泊 pō
  { from: '湖泊', to: '湖坡', note: '湖泊读 pō' },
  // 六 lù（六安）
  { from: '六安', to: '陆安', note: '六安读 lù' },
]);

/**
 * 开关。默认**开**，只有显式存了 off / 0 / false 才关。
 *
 * ★ 没有 storage（测试、隐私模式）或读到坏值一律回落到默认，不抛：
 *   朗读按钮不该因为一个偏好键坏掉就整个点不动。
 */
export function isPronunciationEnabled(storage) {
  let raw;
  try { raw = storage?.getItem?.(PRONUNCIATION_KEY); } catch { return true; }
  if (raw === null || raw === undefined) return true;
  const value = String(raw).trim().toLowerCase();
  return value !== 'off' && value !== '0' && value !== 'false';
}

/**
 * 应用发音修正：单次从左到右扫描，每个位置尝试最长匹配。
 *
 * ★ 命中后直接把替换文本写进结果并跳过整段，**替换结果不再参与后续匹配** ——
 *   否则 A→B 又撞上 B→C，读音会二次跑偏。这条与词表要不要收「崇」这类字
 *   是同一件事，不能靠「词表里没有重叠」来侥幸。
 *
 * @param {string} text
 * @param {ReadonlyArray<{from: string, to: string}>} [rules]
 * @returns {string}
 */
export function applyPronunciation(text, rules = PRONUNCIATION_RULES) {
  const source = String(text ?? '');
  const list = Array.isArray(rules) ? rules.filter(rule => rule && rule.from && typeof rule.to === 'string') : [];
  if (source === '' || list.length === 0) return source;

  // 按首字分组，避免每个位置都遍历整张表；组内按长度降序 = 最长匹配优先。
  const byFirst = new Map();
  for (const rule of list) {
    const first = rule.from[0];
    const group = byFirst.get(first);
    if (group) group.push(rule);
    else byFirst.set(first, [rule]);
  }
  for (const group of byFirst.values()) group.sort((a, b) => b.from.length - a.from.length);

  let out = '';
  let at = 0;
  while (at < source.length) {
    const candidates = byFirst.get(source[at]);
    let matched = null;
    if (candidates) {
      for (const rule of candidates) {
        if (source.startsWith(rule.from, at)) { matched = rule; break; }
      }
    }
    if (matched) {
      out += matched.to;
      at += matched.from.length;
    } else {
      out += source[at];
      at += 1;
    }
  }
  return out;
}

/** 这段文本命中了哪些词条（设置页说明与排查用，不参与合成）。 */
export function findAppliedRules(text, rules = PRONUNCIATION_RULES) {
  const source = String(text ?? '');
  return rules.filter(rule => rule?.from && source.includes(rule.from));
}
