/**
 * A4「发音修正词典」判据。
 *
 * ★ 绝大多数断言是**真跑**：逐条替换、最长匹配、替换结果不二次参与、
 *   真跑 createCloudPlayer / fetchCloudAudio 看送出去的到底是哪串字。
 *   静态断言只用来守两件静态的事：四条播放路径有没有全接上、缓存键口径
 *   有没有被改坏 —— 这两件没法靠一次运行证明「没有第二条漏网路径」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  PRONUNCIATION_KEY, PRONUNCIATION_RULES, isPronunciationEnabled,
  applyPronunciation, findAppliedRules,
} from '../src/speech-pronunciation.js';
import { speechChunks, speechChunksForReading } from '../src/client/article-speech.js';
import { ebookSpeechPlan, createLocalEngine } from '../src/client/ebook-speech.js';
import { createCloudPlayer, fetchCloudAudio } from '../src/client/speech-engine.js';
import { speechBytes, estimateSpeechCost } from '../src/speech.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const pronSource = read('src/speech-pronunciation.js');
const readerSource = stripComments(read('src/client/ReaderPage.jsx'));
const ebookSource = stripComments(read('src/client/ebook-speech.js'));
const articleSource = stripComments(read('src/client/article-speech.js'));
const settingsSource = stripComments(read('src/client/SpeechSettings.jsx'));
const hostSpeechSource = stripComments(read('src/host/speech.js'));
const engineSource = stripComments(read('src/client/speech-engine.js'));
const bookSource = stripComments(read('src/client/BookEbook.jsx'));

const TEXT = '他把行李放在重庆，会计在厦门等处理。';
const FIXED = '他把行理放在崇庆，快计在夏门等楚理。';
const CHINESE_VOICES = [{ name: 'Tingting', lang: 'zh-CN', localService: true }];

const storageOf = (value) => ({
  getItem: (key) => (key === PRONUNCIATION_KEY ? value : null),
  setItem: () => {},
});

describe('A4 · 词表本身：等长、命中、不误伤', () => {
  it('每条规则 from/to 字数相同 —— 不等长就会挪动块边界', () => {
    for (const rule of PRONUNCIATION_RULES) {
      assert.equal([...rule.to].length, [...rule.from].length, `${rule.from} → ${rule.to} 不等长`);
    }
  });

  it('每条规则真的改了字，且只含汉字（不误伤英文/数字/标点）', () => {
    for (const rule of PRONUNCIATION_RULES) {
      assert.notEqual(rule.to, rule.from, `${rule.from} 是条空规则`);
      assert.match(rule.from, /^[\u4e00-\u9fa5]+$/);
      assert.match(rule.to, /^[\u4e00-\u9fa5]+$/);
    }
    assert.equal(PRONUNCIATION_RULES.length, 19, '词表条目数变了，设置页与文档要一起核');
  });

  it('19 条逐条真跑：整词输入必须精确得到 to', () => {
    for (const rule of PRONUNCIATION_RULES) {
      assert.equal(applyPronunciation(rule.from), rule.to, `${rule.from} 没被替换`);
    }
  });

  it('一段正文里只改该改的字，其余逐字不变', () => {
    assert.equal(applyPronunciation(TEXT), FIXED);
    assert.equal(applyPronunciation('2026 年的 AI，和 3 个人。'), '2026 年的 AI，和 3 个人。',
      '英文数字被改了 = 匹配范围没收住');
  });

  it('UTF-8 字节数与报价都不变（等长同音替换的前提）', () => {
    assert.equal(speechBytes(applyPronunciation(TEXT)), speechBytes(TEXT));
    assert.equal(estimateSpeechCost(applyPronunciation(TEXT)), estimateSpeechCost(TEXT));
  });

  it('空值 / 非字符串 / 空规则表一律原样返回，不抛', () => {
    assert.equal(applyPronunciation(''), '');
    assert.equal(applyPronunciation(undefined), '');
    assert.equal(applyPronunciation(null), '');
    assert.equal(applyPronunciation(TEXT, []), TEXT);
    assert.equal(applyPronunciation(TEXT, null), TEXT);
  });

  it('findAppliedRules 只报真正命中的词条', () => {
    assert.deepEqual(findAppliedRules(TEXT).map(r => r.from),
      ['行李', '重庆', '厦门', '会计', '处理']);
    assert.deepEqual(findAppliedRules('今天天气很好'), []);
  });
});

describe('A4 · 扫描算法：最长匹配 + 替换结果不二次参与', () => {
  it('★ 最长匹配优先：「重庆市」按长规则走，不是先切「重庆」', () => {
    const rules = [
      { from: '重庆', to: 'A' },
      { from: '重庆市', to: 'B' },
    ];
    assert.equal(applyPronunciation('去重庆市开会', rules), '去B开会');
    assert.equal(applyPronunciation('行李袋很重'), '行理袋很重',
      '内置表里「行李袋」必须先于「行李」命中');
  });

  it('★ 替换结果不再参与后续匹配（A→B 不许再变 C）', () => {
    const rules = [{ from: '甲', to: '乙' }, { from: '乙', to: '丙' }];
    assert.equal(applyPronunciation('甲', rules), '乙');
    assert.equal(applyPronunciation('甲甲', rules), '乙乙', '输出被回扫了 → 会变成丙丙');
    // 「甲乙」里的乙是**原文**命中乙→丙，本来就该变；别拿它当二次替换的证据。
    assert.equal(applyPronunciation('甲乙', rules), '乙丙');
    assert.equal(applyPronunciation('重庆', [{ from: '重庆', to: '崇庆' }, { from: '崇庆', to: '错' }]), '崇庆');
  });

  it('内置表的替换结果不会撞上另一条内置规则', () => {
    for (const rule of PRONUNCIATION_RULES) {
      const second = findAppliedRules(rule.to);
      assert.equal(second.length, 0, `${rule.to} 又被 ${second.map(r => r.from).join('/')} 命中了`);
    }
  });

  it('相邻命中互不吞字：连着两个词都改对', () => {
    assert.equal(applyPronunciation('重庆会计'), '崇庆快计');
  });
});

describe('A4 · 开关：默认开、坏值不抛、关掉等于原文', () => {
  it('没有 storage / 没有这个键 ⇒ 默认开', () => {
    assert.equal(isPronunciationEnabled(null), true);
    assert.equal(isPronunciationEnabled(undefined), true);
    assert.equal(isPronunciationEnabled(storageOf(null)), true);
    assert.equal(isPronunciationEnabled({ getItem: () => { throw new Error('隐私模式'); } }), true);
  });

  it('显式关掉的几种写法都认；坏值回落默认开', () => {
    for (const value of ['off', 'OFF', ' off ', '0', 'false']) {
      assert.equal(isPronunciationEnabled(storageOf(value)), false, `${value} 没关掉`);
    }
    for (const value of ['on', 'true', '1', 'garbage']) {
      assert.equal(isPronunciationEnabled(storageOf(value)), true, `${value} 被误判成关`);
    }
  });

  it('关掉后 speechChunksForReading 与裸切块逐块完全相同', () => {
    const text = `${TEXT}第二句！第三句？`;
    assert.deepEqual(speechChunksForReading(text, 10, false), speechChunks(text, 10));
    assert.deepEqual(speechChunksForReading(text, 10, true), speechChunks(FIXED + '第二句！第三句？', 10));
  });
});

describe('A4 · 切块前置变换：块边界不动、跨块词不漏', () => {
  it('真跑：变换在切块之前，含词文本得到修正后的块', () => {
    const chunks = speechChunksForReading(TEXT, 600, true);
    assert.equal(chunks.join(''), FIXED);
    assert.ok(!chunks.join('').includes('行李'));
  });

  it('★ 块数与每块长度完全一致（等长替换不挪边界）', () => {
    const text = '他把行李放在重庆。会计在厦门等处理。重复一遍，行李袋也要念对。';
    for (const limit of [5, 8, 13, 600]) {
      const plain = speechChunks(text, limit);
      const fixed = speechChunksForReading(text, limit, true);
      assert.equal(fixed.length, plain.length, `limit=${limit} 块数变了`);
      assert.deepEqual(fixed.map(chunk => chunk.length), plain.map(chunk => chunk.length));
    }
  });

  it('★ 硬切把一个词切开时，变换发生在切之前所以不漏', () => {
    // limit=2 会把「行李」从中间切成「甲行 | 李乙」；切完再逐块变换就会漏。
    const plain = speechChunks('甲行李乙', 2);
    assert.deepEqual(plain, ['甲行', '李乙'], '夹具没制造出跨块词，这条判据会假绿');
    const chunks = speechChunksForReading('甲行李乙', 2, true);
    assert.ok(chunks.join('').includes('行理'), '跨块边界的词漏了');
  });
});

describe('A4 · 缓存键链路：送合成的文本就是键里的 text', () => {
  it('★ 真跑 fetchCloudAudio：body.text 原样送出，没有被二次改写', async () => {
    const original = globalThis.fetch;
    let body = null;
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, blob: async () => ({ tag: 'fake-mp3' }) };
    };
    try {
      const blob = await fetchCloudAudio('/api/test/speech', FIXED, { voice: 'claire', speed: 1, signal: undefined });
      assert.equal(blob.tag, 'fake-mp3');
      assert.equal(body.text, FIXED);
      assert.equal(body.voice, 'claire');
    } finally { globalThis.fetch = original; }
  });

  it('★ 真跑 createCloudPlayer：fetchAudio 收到的是修正后的那一块', async () => {
    const originals = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = () => 'blob:fake';
    URL.revokeObjectURL = () => {};
    const seen = [];
    const audio = {
      pause() {}, removeAttribute() {}, load() {},
      addEventListener() {}, play: async () => {}, src: '',
    };
    try {
      const player = createCloudPlayer({
        createAudio: () => audio,
        fetchAudio: async (text) => { seen.push(text); return {}; },
      });
      player.play(speechChunksForReading(TEXT, 600, true), { voice: 'claire', speed: 1 });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(seen, [FIXED], '送到宿主的不是变换后文本');
    } finally {
      URL.createObjectURL = originals.create;
      URL.revokeObjectURL = originals.revoke;
    }
  });

  it('宿主的缓存键直接用收到 text，且没有对 text 做二次变换', () => {
    assert.match(hostSpeechSource, /const key = cacheKeyOf\(\{ model: SILICON_MODEL, voice, speed, text \}\)/);
    assert.doesNotMatch(hostSpeechSource, /applyPronunciation/);
    assert.match(engineSource, /fetchAudio\(target\.chunks\[index\]/);
    assert.match(engineSource, /body: JSON\.stringify\(\{ text, voice, speed \}\)/);
  });

  it('★ 本机引擎真跑：utterance 里的字也是修正后的', () => {
    const spoken = [];
    const synth = {
      spoken,
      getVoices: () => CHINESE_VOICES,
      speak(utter) { this.spoken.push(utter); },
      pause() {}, resume() {}, cancel() {},
    };
    const engine = createLocalEngine({
      synth,
      makeUtterance: chunk => ({ text: chunk }),
    });
    engine.play(speechChunksForReading(TEXT, 600, true), { voice: CHINESE_VOICES[0], speed: 1 });
    assert.equal(spoken[0].text, FIXED);
    engine.stop();
  });
});

describe('A4 · 四条播放路径全接上（只改一道门就会静默漏一条）', () => {
  it('文章云端 + 文章本机都走 speechChunksForReading，且没有裸切块', () => {
    assert.equal([...readerSource.matchAll(/speechChunksForReading\(/g)].length, 2);
    assert.doesNotMatch(readerSource, /speechChunks\(/);
    assert.equal([...readerSource.matchAll(/isPronunciationEnabled\(localStorage\)/g)].length, 2);
  });

  it('电子书云端 + 电子书本机都走 speechChunksForReading，且没有裸切块', () => {
    assert.equal([...ebookSource.matchAll(/speechChunksForReading\(/g)].length, 2);
    assert.doesNotMatch(ebookSource, /speechChunks\(/);
    assert.match(ebookSource, /pronunciation: isPronunciationEnabled\(storage\)/);
  });

  it('★ 真跑 ebookSpeechPlan：云端与本机两条路都带上了开关', () => {
    const cloud = ebookSpeechPlan(TEXT, {
      voiceValue: 'cloud:claire', cloudConfigured: true, pronunciation: true,
    });
    assert.equal(cloud.error, '');
    assert.equal(cloud.chunks.join(''), FIXED);

    const cloudOff = ebookSpeechPlan(TEXT, {
      voiceValue: 'cloud:claire', cloudConfigured: true, pronunciation: false,
    });
    assert.equal(cloudOff.chunks.join(''), TEXT);

    const local = ebookSpeechPlan(TEXT, {
      voiceValue: 'local:Tingting', voices: CHINESE_VOICES, pronunciation: true,
    });
    assert.equal(local.error, '');
    assert.equal(local.chunks.join(''), FIXED);

    const localOff = ebookSpeechPlan(TEXT, {
      voiceValue: 'local:Tingting', voices: CHINESE_VOICES, pronunciation: false,
    });
    assert.equal(localOff.chunks.join(''), TEXT);
  });

  it('默认参数下 ebookSpeechPlan 也开（调用方忘传不会静默失效）', () => {
    const plan = ebookSpeechPlan(TEXT, { voiceValue: 'cloud:claire', cloudConfigured: true });
    assert.equal(plan.chunks.join(''), FIXED);
  });

  it('切块逻辑只有一份：article-speech.js 里定义，其余模块不自己切', () => {
    assert.match(articleSource, /export function speechChunks\(text, maxLength = 600\)/);
    assert.match(articleSource, /return speechChunks\(enabled \? applyPronunciation\(source\) : source, maxLength\)/);
    assert.doesNotMatch(readerSource, /export function speechChunks/);
    assert.doesNotMatch(ebookSource, /export function speechChunks/);
  });
});

describe('A4 · 正文不受影响 + 设置页开关 + 合规', () => {
  it('★ 显示层没有一处调用发音变换', () => {
    assert.doesNotMatch(readerSource, /applyPronunciation\(/);
    assert.doesNotMatch(bookSource, /applyPronunciation\(/);
    assert.match(readerSource, /proseRef\.current\?\.innerText/);
    assert.match(bookSource, /blocksToText\(section\.blocks\)/);
  });

  it('设置页有开关、写的是同一个 key、默认开', () => {
    assert.match(settingsSource, /type="checkbox"/);
    assert.match(settingsSource, /aria-label="念准多音字"/);
    assert.match(settingsSource, /PRONUNCIATION_KEY/);
    assert.match(settingsSource, /isPronunciationEnabled\(globalThis\.localStorage\)/);
    // 0.76.2 把「（默认开）」从标题挪进了说明第一句：标题只留词名，默认值写在
    // 用户会先读到的那句里。判据守的是「文案必须说清默认值」，不是那句话的位置。
    assert.match(settingsSource, /默认打开/);
    assert.match(settingsSource, /重新合成一次/);
    // 开关必须是设置页那套 `.npr-switch`，不是裸 checkbox：裸的会跟着系统
    // 渲染成蓝底白勾，与同一屏其他开关不是一种东西。
    assert.match(settingsSource, /className="npr-switch"/);
  });

  it('MIT 移植保留原作者署名（署名是硬要求，与许可类型无关）', () => {
    assert.match(pronSource, /MIT/);
    assert.match(pronSource, /Copyright \(c\) 2026 Zanbin Xu/);
  });
});
