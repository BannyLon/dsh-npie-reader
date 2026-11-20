/**
 * 朗读偏好：声音 / 语速（0.76.1，随手把两个入口从阅读页 ⋯ 菜单搬了一份到设置页）。
 *
 * 这里的判据全部真跑纯函数 + 假 storage / 假事件总线：
 * ★ 只断言「设置页里有 <select>」等于没断言 —— 真正会出错的是「三处各写一个键」
 *   （设置里换完，阅读页还在用旧的，两边界面都正常）、「写失败还照样广播」
 *   （别处重读后跳回旧值，用户以为设置没保存）、「没配 Key 却列出云端音色」
 *   （能选、选完报错）。这三件都只在参数与事件上看得出来。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  SPEECH_PREFS_EVENT, SPEECH_RATE_KEY, SPEECH_VOICE_KEY,
  activeSpeechVoiceValue, speechVoiceGroups, writeSpeechPrefs,
} from '../src/client/article-speech.js';
import { SPEECH_RATES } from '../src/client/article-speech.js';
import { CLOUD_PREFIX, LOCAL_PREFIX, SILICON_VOICES } from '../src/speech.js';

const LOCAL = (name) => `${LOCAL_PREFIX}${name}`;
const CLOUD = (id) => `${CLOUD_PREFIX}${id}`;

const ROOT = new URL('../src/client/', import.meta.url);
const read = (name) => readFileSync(new URL(name, ROOT), 'utf8');

/** 假 storage：记录每一次写。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const writes = [];
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); writes.push([key, String(value)]); },
    get writes() { return writes; },
    get map() { return map; },
  };
}

/** 假事件总线：只记事件名。 */
function fakeEnv() {
  const fired = [];
  return {
    Event: class { constructor(name) { this.type = name; } },
    dispatchEvent(event) { fired.push(event.type); },
    get fired() { return fired; },
  };
}

const localVoices = [
  { name: 'Tingting', lang: 'zh-CN', localService: true },
  { name: 'Meijia', lang: 'zh-TW', localService: true },
  { name: 'Samantha', lang: 'en-US', localService: true },
];

describe('声音下拉：两组分开，云端在前', () => {
  it('没配 Key 时不列出云端音色（能选但选完报错最恼火）', () => {
    const groups = speechVoiceGroups({ voices: localVoices, cloud: { configured: false } });
    assert.deepEqual(groups.remote, []);
    assert.equal(groups.local.length, 2, '只留中文语音，英文那条必须被过滤掉');
  });

  it('配了 Key 就列出全部云端音色，并标「· 云端」', () => {
    const groups = speechVoiceGroups({ voices: localVoices, cloud: { configured: true } });
    assert.equal(groups.remote.length, SILICON_VOICES.length);
    for (const item of groups.remote) assert.match(item.label, / · 云端$/);
    for (const item of groups.remote) assert.ok(item.value.startsWith(CLOUD_PREFIX), item.value);
  });

  it('★ 云端用下拉 value 里的引擎前缀，本机也一样：裸名字分不出该走哪条路', () => {
    const groups = speechVoiceGroups({ voices: localVoices, cloud: { configured: true } });
    for (const item of groups.local) assert.ok(item.value.startsWith(LOCAL_PREFIX), item.value);
    const values = [...groups.remote, ...groups.local].map((item) => item.value);
    assert.equal(new Set(values).size, values.length, '两个组里出现同一个 value = 下拉选中态会错位');
  });

  it('cloud 传 null（还没问到宿主）时只给本机，不炸', () => {
    const groups = speechVoiceGroups({ voices: localVoices, cloud: null });
    assert.deepEqual(groups.remote, []);
    assert.equal(groups.local.length, 2);
  });

  it('一个中文语音都没有时两组都是空（界面上要给出说明，不是空下拉）', () => {
    const groups = speechVoiceGroups({ voices: [{ name: 'Samantha', lang: 'en-US' }] });
    assert.deepEqual(groups, { local: [], remote: [] });
  });
});

describe('下拉当前项', () => {
  it('没选过时显示自动挑中的那个（否则下拉空着，用户以为没在用音色）', () => {
    const value = activeSpeechVoiceValue({ value: '', voices: localVoices });
    assert.equal(value, LOCAL('Tingting'), 'pickVoice 优先 zh-CN');
  });

  it('选过云端且 Key 还在 ⇒ 显示那个云端音色', () => {
    const value = activeSpeechVoiceValue({
      value: CLOUD('claire'), voices: localVoices, cloud: { configured: true },
    });
    assert.equal(value, CLOUD('claire'));
  });

  it('★ 选过云端但 Key 被清空 ⇒ 空串（界面补一条「用不了」的禁用项，不静默跳到本机）', () => {
    const value = activeSpeechVoiceValue({
      value: CLOUD('claire'), voices: localVoices, cloud: { configured: false },
    });
    assert.equal(value, '');
  });

  it('★ 0.54.0 存下的裸名字按本机语音兼容（升级后不许静默失效）', () => {
    const value = activeSpeechVoiceValue({ value: 'Tingting', voices: localVoices });
    assert.equal(value, LOCAL('Tingting'));
  });

  it('选过的本机语音不在了 ⇒ 回落到自动挑中的那个', () => {
    const value = activeSpeechVoiceValue({ value: LOCAL('Gone'), voices: localVoices });
    assert.equal(value, LOCAL('Tingting'));
  });
});

describe('写偏好：一把键、写失败不广播', () => {
  it('★ 两个键都写字符串，且与阅读页/电子书页共用同一把', () => {
    const storage = fakeStorage();
    const env = fakeEnv();
    assert.equal(writeSpeechPrefs(storage, { voice: CLOUD('anna'), rate: 1.3 }, env), true);
    assert.deepEqual(storage.writes, [
      [SPEECH_VOICE_KEY, CLOUD('anna')],
      [SPEECH_RATE_KEY, '1.3'],
    ]);
    assert.equal(SPEECH_VOICE_KEY, 'npr.speechVoice');
    assert.equal(SPEECH_RATE_KEY, 'npr.speechRate');
  });

  it('只改一项时不动另一项（否则单选语速会把音色抹掉）', () => {
    const storage = fakeStorage({ [SPEECH_VOICE_KEY]: LOCAL('Tingting') });
    writeSpeechPrefs(storage, { rate: 1.7 }, fakeEnv());
    assert.equal(storage.map.get(SPEECH_VOICE_KEY), LOCAL('Tingting'));
    assert.equal(storage.map.get(SPEECH_RATE_KEY), '1.7');
  });

  it('★ 写失败（隐私模式 / 配额满）返回 false 且**不广播**', () => {
    const env = fakeEnv();
    const broken = { setItem() { throw new Error('QuotaExceededError'); } };
    assert.equal(writeSpeechPrefs(broken, { rate: 1.3 }, env), false);
    assert.deepEqual(env.fired, [], '广播了就会让别处重读成旧值，用户以为「刚改的一刷新就回去了」');
  });

  it('没有 storage（宿主环境没有 localStorage）时返回 false，不抛', () => {
    assert.equal(writeSpeechPrefs(null, { rate: 1.3 }, fakeEnv()), false);
  });

  it('成功时派发的是 SPEECH_PREFS_EVENT 这一个名字', () => {
    const env = fakeEnv();
    writeSpeechPrefs(fakeStorage(), { rate: 1 }, env);
    assert.deepEqual(env.fired, [SPEECH_PREFS_EVENT]);
    assert.equal(SPEECH_PREFS_EVENT, 'npr-speech-prefs-changed');
  });

  it('环境里没有 Event 构造器时不算失败（值已经落盘）', () => {
    const noEventEnv = { dispatchEvent() { throw new Error('不该走到这') } };
    assert.equal(writeSpeechPrefs(fakeStorage(), { rate: 1 }, noEventEnv), true);
  });
});

describe('★ 防回归：三处不许各写一份键名', () => {
  const files = ['SpeechSettings.jsx', 'ReaderPage.jsx', 'ebook-speech.js'];

  it('来源文件里不再出现裸字面量 npr.speechVoice / npr.speechRate', () => {
    for (const name of files) {
      const source = read(name);
      // 定义点只在 article-speech.js，其余文件必须走常量。
      assert.doesNotMatch(source, /['"]npr\.speechVoice['"]/, `${name} 里手写了键名`);
      assert.doesNotMatch(source, /['"]npr\.speechRate['"]/, `${name} 里手写了键名`);
    }
  });

  it('定义点只有 article-speech.js 一处', () => {
    const source = read('article-speech.js');
    assert.match(source, /export const SPEECH_VOICE_KEY = 'npr\.speechVoice'/);
    assert.match(source, /export const SPEECH_RATE_KEY = 'npr\.speechRate'/);
  });

  it('★ 声音分组只有一份实现：阅读页不再自己 map 一遍', () => {
    const reader = read('ReaderPage.jsx');
    assert.match(reader, /speechVoiceGroups\(\{ voices, cloud \}\)/);
    assert.doesNotMatch(reader, /chineseVoices\(voices\)/, '阅读页又抄了一份分组逻辑');
    assert.match(reader, /activeSpeechVoiceValue\(\{ value: speechVoice, voices, cloud \}\)/);
  });

  it('★ 设置页真的接了那两组控件与试听（不是只加了文案）', () => {
    const settings = read('SpeechSettings.jsx');
    assert.match(settings, /aria-label="朗读声音"/);
    assert.match(settings, /aria-label="朗读语速"/);
    assert.match(settings, /SPEECH_RATES\.map/);
    assert.match(settings, /previewVoice/);
    assert.match(settings, /writeSpeechPrefs\(globalThis\.localStorage, \{ rate \}\)/);
  });

  it('★ 阅读页会听偏好变更事件（设置页改完，回来下拉必须跟着变）', () => {
    const reader = read('ReaderPage.jsx');
    assert.match(reader, /addEventListener\(SPEECH_PREFS_EVENT, sync\)/);
    assert.match(reader, /removeEventListener\(SPEECH_PREFS_EVENT, sync\)/);
  });

  it('语速档位仍然只有 SPEECH_RATES 一份', () => {
    assert.deepEqual(SPEECH_RATES.map((item) => item.label), ['慢', '正常', '快', '很快']);
  });
});

/**
 * 0.76.2 的**版式**判据。
 *
 * 这一轮用户的原话是「设置页 UI 也太丑了」。丑的具体形态是：八件事塞在一个
 * `.npr-service` 灰盒里、灰盒又套在白卡上、语速用橙色实心块。这些都不会让
 * 任何功能测试变红 —— 功能一直是对的。
 *
 * 所以这里守的不是「好不好看」（判不了），而是**当初为什么难看的那几个决定**
 * 有没有被悄悄改回去，以及两个只有真跑才会暴露的坑：
 *   · PANEL_CSS 给裸 button 兜了 `width: 100%`，进 grid 列会被拉成长条；
 *   · 状态圆点无差别地画在说明文字前，看着像一枚没勾选的单选。
 */
describe('0.76.2 · 朗读屏版式：分组、复用控件、危险动作分级', () => {
  const settings = read('SpeechSettings.jsx');
  const css = readFileSync(new URL('../src/client/refinements.css', import.meta.url), 'utf8');

  it('★ 不再用 .npr-service 灰盒把整块包起来（卡片套卡片）', () => {
    assert.doesNotMatch(settings, /className="npr-service"/, '灰盒回来了：整块又变成卡片里的卡片');
  });

  it('拆成三组：云端语音 / 朗读偏好 / 念准多音字', () => {
    const groups = settings.match(/className="npr-set-group"/g) ?? [];
    assert.equal(groups.length, 3, '分组数量变了 —— 一件事一组是这版的全部主张');
  });

  it('★ 语速用设置页的 .npr-segmented，不再自己画一套（旧类是橙块）', () => {
    assert.match(settings, /className="npr-segmented"/);
    assert.doesNotMatch(css, /\.npr-pref-seg/, '旧的橙色分段器样式还在，像是没删干净');
  });

  it('开关用 .npr-switch，不是裸 checkbox（裸的会跟系统渲成蓝底白勾）', () => {
    assert.match(settings, /className="npr-switch"/);
  });

  it('★ 按钮必须 width:auto —— PANEL_CSS 的 width:100% 会把 grid 里的按钮拉成长条', () => {
    for (const cls of ['npr-speech-save', 'npr-speech-test']) {
      const rule = new RegExp(`\\.npr-speech \\.${cls} \\{([^}]*)\\}`, 's').exec(css)?.[1] ?? '';
      assert.ok(rule.length > 0, `没找到 ${cls} 的规则`);
      assert.match(rule, /width: auto/, `${cls} 少了 width:auto，会被撑成一条横条`);
    }
  });

  it('★ 状态圆点只给真状态（.is-on/.is-off），纯说明文字不带点', () => {
    // 不锚死选择器顺序：要守的是「**凡**为 state 画 ::before 的选择器都带状态类」。
    // 第一版 CSS 给所有 state 都画了点，截图里「文章 · 电子书共用」前面那枚
    // 空心点看着像没勾选的单选。
    const hits = css.match(/[^\n{]*\.npr-speech-state[^\n{]*::before/g) ?? [];
    assert.ok(hits.length >= 2, `一条 state::before 都没找到（改名了？）实际 ${hits.length}`);
    for (const hit of hits) {
      assert.match(hit, /\.is-(on|off)/, `存在无条件的圆点：${hit.trim()}`);
    }
  });

  it('破坏性动作与链接分级：清空是灰字、hover 才显墨色', () => {
    assert.match(settings, /className="npr-linkish is-danger"/);
    assert.match(css, /\.npr-speech-meta \.npr-linkish\.is-danger \{[^}]*text-decoration: none/);
  });
});
