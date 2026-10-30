/**
 * 朗读（0.44）。
 *
 * 这一层守的是「读出来对不对」的两条：**选哪个声音**、**怎么切块**。
 * 两条都真跑（不是读源码猜），因为它们的错法都不报错：
 *   - 选错声音 ⇒ 一篇中文用英语音素念成噪音，而按钮看起来完全正常；
 *   - 切错块 ⇒ Chromium 静默截断超长 utterance，用户听完开头就静音、以为读完了。
 *
 * ★ 高亮跟随**没有做**，理由写在 `article-speech.js` 的注释里（要切正文 DOM，
 *   会破坏滚动位置、选中与划线）。所以这里也没有对应断言 —— 不测没做的东西。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  pickVoice, speechChunks, SPEECH_RATES, chineseVoices, voiceRegion, SPEECH_SAMPLE,
} from '../src/client/article-speech.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const readerSource = stripComments(readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8'));

const voice = (name, lang, localService = true) => ({ name, lang, localService });

describe('0.44：朗读 —— 选哪个声音', () => {
  it('一个语音都没有 ⇒ null（不是抛错）', () => {
    assert.equal(pickVoice([]), null);
    assert.equal(pickVoice(undefined), null);
  });

  it('★ 一个中文语音都没有时返回 null，**不退回英语**', () => {
    const voices = [voice('Samantha', 'en-US'), voice('Daniel', 'en-GB')];
    assert.equal(pickVoice(voices), null,
      '退回了英语语音 —— 一篇中文会被英语音素念成噪音，比不念更糟');
  });

  it('按 zh-CN 优先', () => {
    const voices = [voice('Mei-Jia', 'zh-TW'), voice('Tingting', 'zh-CN')];
    assert.equal(pickVoice(voices).name, 'Tingting');
  });

  it('★ 同一语言里本机语音优先于在线语音', () => {
    const voices = [voice('云希（在线）', 'zh-CN', false), voice('Tingting', 'zh-CN', true)];
    assert.equal(pickVoice(voices).name, 'Tingting',
      '选了在线语音 —— 断网时静默不出声，用户会以为按钮坏了');
  });

  it('只有 zh-TW / zh-HK 时也能用（不因为不是 zh-CN 就放弃）', () => {
    assert.equal(pickVoice([voice('Mei-Jia', 'zh-TW')]).name, 'Mei-Jia');
  });

  it('用户上次选过的那个优先，即使它不是 zh-CN', () => {
    const voices = [voice('Tingting', 'zh-CN'), voice('Sinji', 'zh-HK')];
    assert.equal(pickVoice(voices, 'Sinji').name, 'Sinji');
  });

  it('★ 用户选过的那个不在了 ⇒ 回落到自动挑，不是返回 null', () => {
    const voices = [voice('Tingting', 'zh-CN')];
    assert.equal(pickVoice(voices, '已经卸载的声音').name, 'Tingting');
  });

  it('返回值只有三个字段（不把整个对象透传出去）', () => {
    const picked = pickVoice([{ name: 'A', lang: 'zh-CN', localService: true, voiceURI: 'x', extra: 1 }]);
    assert.deepEqual(Object.keys(picked).sort(), ['lang', 'localService', 'name']);
  });
});

describe('0.44：朗读 —— 怎么切块', () => {
  it('空文本给空数组', () => {
    assert.deepEqual(speechChunks(''), []);
    assert.deepEqual(speechChunks('   \n  '), []);
    assert.deepEqual(speechChunks(undefined), []);
  });

  it('短文本合成一块', () => {
    assert.deepEqual(speechChunks('今天天气很好。'), ['今天天气很好。']);
  });

  it('★ 按句末标点切，标点留在前一块', () => {
    // 上限 5 < 两句合起来的 8 ⇒ 一句一块（上限给 8 的话前两句会被合成一块，那是设计）
    const chunks = speechChunks('第一句。第二句！第三句？', 5);
    assert.deepEqual(chunks, ['第一句。', '第二句！', '第三句？'],
      '标点跑到下一块去了 —— 念出来会在句子中间断，而且没有停顿');
  });

  it('短句在上限内会合并（减少块数 = 减少块间停顿）', () => {
    assert.deepEqual(speechChunks('第一句。第二句！第三句？', 8), ['第一句。第二句！', '第三句？']);
  });

  it('空白折叠成一个空格', () => {
    // 句末标点后面那段空白被切掉了，所以两句之间**没有**空格 —— 念出来正好是一句接一句
    assert.deepEqual(speechChunks('  第一句。\n\n  第二句。  ', 100), ['第一句。第二句。']);
  });

  it('★ 超长单句硬切，不整段塞进去', () => {
    const long = '甲'.repeat(25);
    const chunks = speechChunks(long, 10);
    assert.equal(chunks.length, 3, '超长单句没切 —— Chromium 会静默截断，用户以为读完了');
    assert.equal(chunks.every((chunk) => chunk.length <= 10), true);
    assert.equal(chunks.join(''), long, '切的时候丢了字');
  });

  it('每块都不超过上限（混合长短句）', () => {
    const text = `${'短句。'.repeat(20)}${'长'.repeat(30)}。${'短句。'.repeat(20)}`;
    const chunks = speechChunks(text, 40);
    assert.equal(chunks.every((chunk) => chunk.length <= 40), true,
      `有块超过上限：${chunks.map((chunk) => chunk.length).join('/')}`);
    assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), '拼起来和原文不一致');
  });

  it('默认上限 600', () => {
    const text = '甲'.repeat(1300);
    const chunks = speechChunks(text);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 600);
  });

  it('语速档位单调递增，且不超出人耳能听的范围', () => {
    const rates = SPEECH_RATES.map((item) => item.rate);
    assert.deepEqual([...rates].sort((a, b) => a - b), rates, '档位不是递增的 —— 下拉框会看着乱');
    assert.equal(rates.every((rate) => rate >= 0.75 && rate <= 2), true,
      `语速超出 0.75–2：${rates.join('/')}`);
  });
});

describe('0.44：朗读 —— 组件接线（纯函数表达不了的部分）', () => {
  it('★ 没有 speechSynthesis 时说清为什么，而不是静默什么都不发生', () => {
    assert.match(readerSource, /speechSynthesis/);
    assert.match(readerSource, /这个环境不支持朗读|不支持朗读/,
      '没有语音合成能力时没有任何提示 —— 用户会反复点');
  });

  it('★ 切文章 / 切版本时停掉朗读', () => {
    // 源码里写的是可选链（宿主环境可能没有 speechSynthesis）
    assert.match(readerSource, /speechSynthesis\?\.cancel\(\)/,
      '切文章时没停 —— 上一篇文章会继续念，而屏幕上已经是另一篇');
  });

  it('用纯函数挑声音与切块，不把策略写在组件里', () => {
    assert.match(readerSource, /pickVoice\(/);
    assert.match(readerSource, /speechChunks\(/);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 0.54.0：能选音色
 *
 * 用户 2026-10-30：「现在的朗读效果非常差，非常机械声。有没有可能自定义朗读的模型。」
 * 查下来：用的是系统语音（没有「模型」可换），而代码只做「自动挑一个」——
 * `npr.speechVoice` **只被读过、全项目没有一处写它**，因为界面上没有入口能写。
 * 这一节守两件事：候选清单摊得对、界面真的把选择写下去了。
 * ══════════════════════════════════════════════════════════════════════ */

/** 真机上的形态：中文语音一大堆，婷婷同名两条（紧凑版 + 高音质版）。 */
const VOICES = [
  voice('Tingting', 'zh-CN'),
  voice('Tingting', 'zh-CN'),
  voice('Sandy', 'zh-CN'),
  voice('Meijia', 'zh-TW'),
  voice('Sinji', 'zh-HK'),
  voice('Xiaoxiao', 'zh-CN', false),
  voice('Daniel', 'en-GB'),
  voice('Kyoko', 'ja-JP'),
];

describe('0.54：音色清单 —— voiceRegion', () => {
  it('大陆 / 台湾 / 香港 / 新加坡 各自认得出', () => {
    assert.equal(voiceRegion('zh-CN'), '大陆');
    assert.equal(voiceRegion('zh_TW'), '台湾');
    assert.equal(voiceRegion('zh-HK'), '香港');
    assert.equal(voiceRegion('zh-SG'), '新加坡');
  });

  it('只写 zh 的落「中文」，不认识的落「其他」', () => {
    assert.equal(voiceRegion('zh'), '中文');
    assert.equal(voiceRegion('en-US'), '其他');
    assert.equal(voiceRegion(''), '其他');
    assert.equal(voiceRegion(undefined), '其他');
  });
});

describe('0.54：音色清单 —— chineseVoices', () => {
  it('只留中文语音', () => {
    const names = chineseVoices(VOICES).map((item) => item.name);
    assert.ok(!names.includes('Daniel'), '英语语音混进了中文清单');
    assert.ok(!names.includes('Kyoko'), '日语语音混进了中文清单');
  });

  /* ★ 真机上「婷婷」有两条同名同语言记录（紧凑版 + 高音质版）。不去重的话下拉里
     是两个一模一样的选项，用户点了另一个也听不出区别 —— 他不知道自己在切音质档。 */
  it('★ 同名同语言的两条合并成一条', () => {
    const ting = chineseVoices(VOICES).filter((item) => item.name === 'Tingting');
    assert.equal(ting.length, 1, `婷婷出现 ${ting.length} 次，应为 1 次`);
  });

  it('不同地区的同名音色不合并', () => {
    const rows = chineseVoices([voice('Tingting', 'zh-CN'), voice('Tingting', 'zh-TW')]);
    assert.equal(rows.length, 2);
  });

  it('按地区排：大陆 → 台湾 → 香港（默认选中项排第一）', () => {
    const regions = chineseVoices(VOICES).map((item) => item.region);
    const order = ['大陆', '台湾', '香港'];
    const seen = regions.map((r) => order.indexOf(r)).filter((i) => i >= 0);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `地区顺序乱了：${regions.join(' / ')}`);
  });

  it('★ 同区内本机语音排在在线语音前面', () => {
    const cn = chineseVoices(VOICES).filter((item) => item.region === '大陆');
    const firstOnline = cn.findIndex((item) => !item.localService);
    const lastLocal = cn.map((item) => item.localService).lastIndexOf(true);
    assert.ok(firstOnline === -1 || firstOnline > lastLocal, '在线语音排到了本机语音前面');
  });

  it('★ 在线语音在标签上写明「在线」（按量计费、断网没声）', () => {
    const online = chineseVoices(VOICES).find((item) => item.name === 'Xiaoxiao');
    assert.match(online.label, /在线/);
    const local = chineseVoices(VOICES).find((item) => item.name === 'Sandy');
    assert.doesNotMatch(local.label, /在线/);
  });

  it('空输入不炸', () => {
    assert.deepEqual(chineseVoices([]), []);
    assert.deepEqual(chineseVoices(null), []);
    assert.deepEqual(chineseVoices(undefined), []);
  });
});

describe('0.54：试听文本', () => {
  it('有标点、有数字，才听得出一段话的节奏', () => {
    assert.ok(SPEECH_SAMPLE.length >= 12);
    assert.match(SPEECH_SAMPLE, /[，。？！]/);
    assert.match(SPEECH_SAMPLE, /[0-9]/);
  });
});

describe('0.54：组件接线 —— 能选、能记住、换完立刻生效', () => {
  it('菜单里有朗读声音那一行，且用 chineseVoices 铺选项', () => {
    assert.match(readerSource, /aria-label="朗读声音"/, '菜单里没有朗读声音那一行');
    assert.match(readerSource, /className="npr-menu-select"/, '没有下拉');
    assert.match(readerSource, /chineseVoices\(voices\)/, '下拉没有用 chineseVoices 铺选项');
  });

  /* ★ 核心：这个 key 以前只读不写。断言必须落在 setItem 上 ——
     只断言「读了 npr.speechVoice」在 bug 版本里同样成立（那正是 bug 本身）。 */
  it('★ 选中后真的写进 localStorage', () => {
    assert.match(
      readerSource,
      /localStorage\.setItem\('npr\.speechVoice'/,
      '没有任何地方写 npr.speechVoice —— 偏好是死的，用户选了等于没选',
    );
  });

  it('★ 朗读时读的是 ref，不是 localStorage（换完立刻生效）', () => {
    assert.match(readerSource, /pickVoice\(synth\.getVoices\(\), speechVoiceRef\.current\)/);
    assert.doesNotMatch(
      readerSource,
      /pickVoice\(synth\.getVoices\(\), localStorage\.getItem\('npr\.speechVoice'\)/,
      '还在从 localStorage 现读 —— 同一会话里换音色要重开面板才生效',
    );
  });

  it('有试听入口，且试听不改「正在朗读」状态', () => {
    assert.match(readerSource, /className="npr-menu-test"[^>]*onClick=\{previewVoice\}/, '没有试听按钮');
    const preview = /const previewVoice = \(\) => \{([\s\S]*?)\n  \};/.exec(readerSource)?.[1] ?? '';
    assert.ok(preview.length > 0, '没找到 previewVoice 的实现（改名了？这条断言会静默失效）');
    assert.doesNotMatch(preview, /setSpeaking\(true\)/, '试听把工具条那颗三角点亮了 —— 用户会以为文章在念');
  });

  it('没有中文语音时给的是说明，不是一个点不动的灰下拉', () => {
    assert.match(readerSource, /npr-menu-hint/, '缺「去系统设置下载」的说明');
  });
});
