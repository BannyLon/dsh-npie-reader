/**
 * A1「听本节」：把已有 TTS 接到电子书正文的那一层接缝。
 *
 * ★ 这一套守的是**行为**，不是「文件里有没有这几个字」：
 *   两台假引擎真跑一遍状态机，才能抓到「本机还在念、云端又开始念」这种
 *   不报错、只出双声的错。静态断言只用来守「接线真的接上了」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  LISTEN_KEY_PREFIX, listenKey, readListenPage, ebookSpeechPlan,
  createEbookSpeech, createLocalEngine,
} from '../src/client/ebook-speech.js';
import { SPEECH_CLOUD_CHUNK } from '../src/speech.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client');
const speechSource = stripComments(readFileSync(join(root, 'ebook-speech.js'), 'utf8'));
const bookSource = stripComments(readFileSync(join(root, 'BookEbook.jsx'), 'utf8'));

const CHINESE_VOICES = [{ name: 'Tingting', lang: 'zh-CN', localService: true, label: '婷婷' }];

function fakeEngine(log, name) {
  return {
    plays: [],
    play(chunks, options) { log.push(`${name}:play`); this.plays.push({ chunks, options }); },
    pause() { log.push(`${name}:pause`); },
    resume() { log.push(`${name}:resume`); },
    stop() { log.push(`${name}:stop`); },
    get active() { return false; },
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

function setup(plan, { bookId = 'book-1', page = 3, storage = fakeStorage() } = {}) {
  const log = [];
  const notices = [];
  const cloud = fakeEngine(log, 'cloud');
  const local = fakeEngine(log, 'local');
  let listened = null;
  const controller = createEbookSpeech({
    getText: () => '第一句。第二句。',
    planOf: () => plan,
    notify: (message, isError) => notices.push({ message, isError }),
    onState: phase => log.push(`state:${phase}`),
    cloud, local, storage, bookId,
    getPage: () => page,
    onListenPage: value => { listened = value; },
  });
  return { log, notices, cloud, local, controller, storage, get listened() { return listened; } };
}

const OK_PLAN = {
  engine: 'local', voice: CHINESE_VOICES[0], speed: 1,
  chunks: ['第一句。', '第二句。'], error: '',
};

describe('A1 · 这一节该怎么念（纯函数）', () => {
  it('本机没有中文语音 ⇒ 明确报错，**不退回英语**', () => {
    const plan = ebookSpeechPlan('中文正文', { voices: [{ name: 'Samantha', lang: 'en-US' }] });
    assert.match(plan.error, /没有中文语音/);
    assert.equal(plan.chunks.length, 0);
  });

  it('选了云端但没配 Key ⇒ 报错，**不静默换成本机声音**', () => {
    const plan = ebookSpeechPlan('中文正文', {
      voiceValue: 'cloud:claire', cloudConfigured: false, voices: CHINESE_VOICES,
    });
    assert.match(plan.error, /API Key/);
    assert.equal(plan.engine, 'cloud');
    assert.equal(plan.chunks.length, 0);
  });

  it('空正文 ⇒ 说清「没有可朗读的正文」，不是静音也不抛错', () => {
    assert.match(ebookSpeechPlan('   \n  ', { voices: CHINESE_VOICES }).error, /没有可朗读的正文/);
    assert.match(ebookSpeechPlan('', { voiceValue: 'cloud:claire', cloudConfigured: true }).error,
      /没有可朗读的正文/);
  });

  it('云端按 SPEECH_CLOUD_CHUNK 切、本机按 600 切，两条都逐字拼得回原文', () => {
    const text = '天下大事，分久必合。'.repeat(300);
    const cloud = ebookSpeechPlan(text, { voiceValue: 'cloud:claire', cloudConfigured: true });
    const local = ebookSpeechPlan(text, { voices: CHINESE_VOICES });
    assert.equal(cloud.chunks.join(''), text);
    assert.equal(local.chunks.join(''), text);
    assert.ok(cloud.chunks.length > local.chunks.length, '云端块应该更短更多');
    assert.ok(cloud.chunks.every(chunk => chunk.length <= SPEECH_CLOUD_CHUNK));
  });

  it('语速夹在 [0.25, 4]，坏值回落 1', () => {
    assert.equal(ebookSpeechPlan('中文正文', { voices: CHINESE_VOICES, rate: 99 }).speed, 4);
    assert.equal(ebookSpeechPlan('中文正文', { voices: CHINESE_VOICES, rate: -3 }).speed, 0.25);
    assert.equal(ebookSpeechPlan('中文正文', { voices: CHINESE_VOICES, rate: 'abc' }).speed, 1);
  });

  it('裸名字兼容成 system（0.54.0 老设置不会静默失效）', () => {
    const plan = ebookSpeechPlan('中文正文', { voiceValue: 'Tingting', voices: CHINESE_VOICES });
    assert.equal(plan.engine, 'local');
    assert.equal(plan.voice.name, 'Tingting');
  });
});

describe('A1 · 听位：与读位分开，坏值自己兜住', () => {
  it('键按书分开、前缀稳定', () => {
    assert.equal(listenKey('b1'), `${LISTEN_KEY_PREFIX}b1`);
    assert.notEqual(listenKey('b1'), listenKey('b2'));
  });

  it('没有存过 / 坏值 / 超出总节数 ⇒ 一律回落到当前读位', () => {
    assert.equal(readListenPage(fakeStorage(), 'b1', 20, 7), 7);
    assert.equal(readListenPage(fakeStorage({ 'npr.ebookListen.b1': 'oops' }), 'b1', 20, 7), 7);
    assert.equal(readListenPage(fakeStorage({ 'npr.ebookListen.b1': '999' }), 'b1', 20, 7), 7);
    assert.equal(readListenPage(null, 'b1', 20, 7), 7);
  });

  it('合法值原样读回；total 未知时不夹（书还没加载完）', () => {
    assert.equal(readListenPage(fakeStorage({ 'npr.ebookListen.b1': '12' }), 'b1', 20, 7), 12);
    assert.equal(readListenPage(fakeStorage({ 'npr.ebookListen.b1': '12' }), 'b1', 0, 7), 12);
  });

  it('★ 开听只写听位，**控制器接口里根本没有写读位的口子**', () => {
    const store = fakeStorage();
    const t = setup(OK_PLAN, { page: 3, storage: store });
    t.controller.toggle();
    assert.equal(t.listened, 3);
    assert.equal(store.getItem(listenKey('book-1')), '3');
    // 判据不看「有没有调某个函数」，而是看模块里压根不存在那些写读位的名字：
    // 一旦有人图省事把听位直接写进 page，这条静态断言会立刻变红。
    assert.doesNotMatch(speechSource, /setPage\s*\(|saveBookState|onPageChange/);
  });
});

describe('A1 · 状态机：无双声 / 错误不吞 / 停播', () => {
  it('播 → 暂停 → 继续，只启动一次，暂停不重新合成', () => {
    const t = setup(OK_PLAN);
    t.controller.toggle();
    t.controller.toggle();
    t.controller.toggle();
    assert.equal(t.local.plays.length, 1, '暂停后又重新 play = 从头念，还会和旧音频叠声');
    assert.deepEqual(t.log.filter(x => x.endsWith(':play')), ['local:play']);
    assert.ok(t.log.includes('local:pause'));
    assert.ok(t.log.includes('local:resume'));
    assert.equal(t.controller.phase, 'playing');
  });

  it('★ 开播前先停**两条**引擎，绝不让本机与云端叠在一起', () => {
    const t = setup(OK_PLAN);
    t.controller.toggle();
    const firstPlay = t.log.indexOf('local:play');
    assert.ok(firstPlay > 0);
    assert.ok(t.log.slice(0, firstPlay).includes('cloud:stop'));
    assert.ok(t.log.slice(0, firstPlay).includes('local:stop'));
  });

  it('★ 同一控制器切换引擎，旧的那条先停（换音色不会出双声）', () => {
    let plan = OK_PLAN;
    const log = [];
    const cloud = fakeEngine(log, 'cloud');
    const local = fakeEngine(log, 'local');
    const controller = createEbookSpeech({
      getText: () => '正文',
      planOf: () => plan,
      cloud, local, storage: fakeStorage(), bookId: 'b1', getPage: () => 1,
    });
    controller.toggle();                                   // 本机
    assert.deepEqual(log.filter(x => x.endsWith(':play')), ['local:play']);
    controller.stop();
    plan = { ...OK_PLAN, engine: 'cloud', voice: 'claire' };
    controller.toggle();                                   // 换到云端
    assert.deepEqual(log.filter(x => x.endsWith(':play')), ['local:play', 'cloud:play']);
    const secondPlay = log.lastIndexOf('cloud:play');
    assert.ok(log.slice(0, secondPlay).includes('local:stop'), '换引擎前没停本机 = 两条一起响');
    assert.equal(controller.engine, 'cloud');
  });

  it('★ 错误文案原样递给用户且 isError=true，不吞、不静音启动', () => {
    const t = setup({ ...OK_PLAN, error: '云端朗读还没填 API Key' });
    t.controller.toggle();
    assert.equal(t.notices.length, 1);
    assert.equal(t.notices[0].message, '云端朗读还没填 API Key');
    assert.equal(t.notices[0].isError, true);
    assert.equal(t.log.filter(x => x.endsWith(':play')).length, 0);
    assert.equal(t.controller.phase, 'idle');
  });

  it('play 抛错也要说出来（不是 catch 里吞掉）', () => {
    const t = setup(OK_PLAN);
    t.local.play = () => { throw new Error('余额不足'); };
    t.controller.toggle();
    assert.equal(t.notices.at(-1).message, '余额不足');
    assert.equal(t.notices.at(-1).isError, true);
    assert.equal(t.controller.phase, 'idle');
  });

  it('stop / finish / dispose 都回到 idle；dispose 之后点不动', () => {
    const t = setup(OK_PLAN);
    t.controller.toggle();
    t.controller.stop();
    assert.equal(t.controller.phase, 'idle');
    t.controller.toggle();
    t.controller.finish();
    assert.equal(t.controller.phase, 'idle');
    t.controller.dispose();
    t.controller.toggle();
    assert.equal(t.controller.phase, 'idle');
    assert.equal(t.local.plays.length, 2, 'dispose 之后不该再启动');
  });

  it('★ storage 写不了（隐私模式）不影响听，不能把整条链路炸掉', () => {
    const t = setup(OK_PLAN, { storage: { setItem: () => { throw new Error('QuotaExceeded'); } } });
    assert.doesNotThrow(() => t.controller.toggle());
    assert.equal(t.controller.phase, 'playing');
    assert.equal(t.notices.length, 0);
  });
});

describe('A1 · 本机引擎真跑：一次一块、链式推进、stop 后不再出声', () => {
  function makeSynth() {
    return {
      spoken: [],
      getVoices: () => CHINESE_VOICES,
      speak(utter) { this.spoken.push(utter); },
      pause() {}, resume() {}, cancel() {},
    };
  }

  it('一次只 speak 一块，链式推进后逐字拼回原文', () => {
    const synth = makeSynth();
    const states = [];
    const engine = createLocalEngine({
      synth,
      makeUtterance: chunk => ({ text: chunk }),
      onState: state => states.push(state),
    });
    const chunks = ['第一句。', '第二句。', '第三句。'];
    engine.play(chunks, { voice: CHINESE_VOICES[0], speed: 1.5 });
    assert.equal(synth.spoken.length, 1, '一上来就全 speak 出去 = Chromium 会静默截断');
    for (let i = 1; i < chunks.length; i += 1) synth.spoken[i - 1].onend();
    assert.equal(synth.spoken.length, 3);
    assert.equal(synth.spoken.map(u => u.text).join(''), chunks.join(''), '拼回去不能丢字');
    assert.equal(synth.spoken[0].rate, 1.5);
    synth.spoken[2].onend();
    assert.deepEqual(states, ['idle']);
  });

  it('★ 念到第 2 块时 stop，再触发 onend 不许冒出第 3 块', () => {
    const synth = makeSynth();
    const engine = createLocalEngine({ synth, makeUtterance: chunk => ({ text: chunk }) });
    engine.play(['一', '二', '三'], { voice: CHINESE_VOICES[0], speed: 1 });
    synth.spoken[0].onend();
    assert.equal(synth.spoken.length, 2);
    engine.stop();
    synth.spoken[1].onend();
    assert.equal(synth.spoken.length, 2, 'stop 之后还在往后念 = 换页了声音没停');
  });
});

describe('A1 · 接线守卫：按钮真的接上了，且该停就停', () => {
  it('BookEbook.jsx 真的 import 并调用了 useEbookSpeech', () => {
    assert.match(bookSource, /import\s*\{[^}]*useEbookSpeech[^}]*\}\s*from\s*'\.\/ebook-speech\.js'/);
    assert.match(bookSource, /useEbookSpeech\(\{/);
  });

  it('★ FAB 里那颗按钮真的绑到 toggle，不只是定义了一个变量', () => {
    assert.match(bookSource, /onClick=\{ebookSpeech\.toggle\}/);
    assert.match(bookSource, /aria-label=\{ebookSpeech\.phase === 'playing' \? '暂停朗读' : '朗读这一节'\}/);
    assert.match(bookSource, /title=\{ebookSpeech\.hint\}/);
    assert.match(bookSource, /fabStack\(\{ count: 9,/, 'FAB 加了语速槽，槽位数量没跟着改会让最上面那颗按钮叠在前一颗上');
  });

  it('★ 语速槽真的绑到 changeRate（不是只画了一颗按钮）', () => {
    assert.match(bookSource, /import\s*\{[^}]*nextSpeechRate[^}]*\}\s*from\s*'\.\/ebook-speech\.js'/);
    assert.match(bookSource, /onClick=\{\(\) => ebookSpeech\.changeRate\(nextSpeechRate\(ebookSpeech\.speechRate\)\)\}/);
    assert.match(bookSource, /\{ebookSpeech\.rateText\}/, '标签必须显示当前倍速，不能只写死「语速」');
  });

  it('★ 三道停播门都在（换节 / 切 tab / 卸载），少一道就一直响', () => {
    assert.match(speechSource, /\[bookId, page, stop\]/);
    assert.match(speechSource, /'visibilitychange'/);
    assert.match(speechSource, /controllerRef\.current\?\.dispose\(\)/);
  });

  it('★ 换书重建控制器 + 重读听位（否则听位写进上一本书的键）', () => {
    assert.match(speechSource, /\}, \[bookId, stop\]\)/);
    assert.match(speechSource, /setListenPage\(readListenPage\(storage, bookId, total,/);
    assert.match(speechSource, /\}, \[bookId, total, storage\]\)/);
  });

  it('★ 事前报价接在按钮提示里（云端按字节计费，不能点完才知道）', () => {
    assert.match(speechSource, /estimateSpeechCost\(text\)/);
  });

  it('反向对照：判据本身会变红（喂一段肯定不匹配的样本）', () => {
    assert.doesNotMatch(stripComments('const x = 1;'), /useEbookSpeech/);
    assert.throws(() => assert.match(stripComments('const x = 1;'), /onClick=\{ebookSpeech\.toggle\}/));
  });
});
