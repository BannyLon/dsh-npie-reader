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
import { pickVoice, speechChunks, SPEECH_RATES } from '../src/client/article-speech.js';
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
