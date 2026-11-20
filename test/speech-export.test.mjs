/**
 * A5「按节导出 MP3」判据。
 *
 * ★ 真跑为主：MP3 夹具逐字节核、状态机真跑两段式 / 取消 / 失败续跑 / 并发。
 *   静态断言只守「FAB 第 8 槽接上了」和「没有全书入口」这两件。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  EXPORT_MAX_BYTES, CHARS_PER_MINUTE, planSpeechExport, exportQuote,
  safeFileName, findFrameSync, skipId3v2, trimId3v1, extractAudioFrames,
  concatMp3, scanMp3,
} from '../src/speech-export.js';
import {
  createEbookExport, fetchExportChunk, downloadBytes, exportHint, exportLabel,
} from '../src/client/ebook-export.js';
import { speechChunksForReading } from '../src/client/article-speech.js';
import { estimateSpeechCost } from '../src/speech.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const exportSource = read('src/speech-export.js');
const bookSource = stripComments(read('src/client/BookEbook.jsx'));
const clientSource = stripComments(read('src/client/ebook-export.js'));

const tick = async (times = 4) => {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
};

/* ── MP3 夹具 ─────────────────────────────────────────────────────────
 * 合法帧头：FF E2 90 00 —— 高 3 位置位（同步）、version=0、layer=1、
 * bitrate=9、sampleRate=0，全部通过 findFrameSync 的伪同步排除。
 */
const FRAME = Uint8Array.from([0xff, 0xe2, 0x90, 0x00, 1, 2, 3, 4]);

function frame(tag) {
  const out = Uint8Array.from(FRAME);
  out[4] = tag;
  return out;
}
function id3v2(size = 10, flags = 0) {
  const head = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, flags, 0, 0, 0, size]);
  // 声明了 footer 标志就得真有那 10 字节，否则 skipId3v2 的 Math.min 会夹到文件尾。
  const body = new Uint8Array(size + ((flags & 0x10) !== 0 ? 10 : 0));
  return new Uint8Array([...head, ...body]);
}
function id3v1() {
  const tail = new Uint8Array(128);
  tail.set([0x54, 0x41, 0x47]); // TAG
  return tail;
}
const joinBytes = (...parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

const PLAN = {
  ok: true, error: '', text: '第一句。第二句。第三句。',
  voice: 'claire', speed: 1, filename: '测试书-第3节.mp3',
  cost: 0.01, minutes: 1, chars: 12,
};

function harness({ plan = PLAN, concurrency = 2, fetchImpl } = {}) {
  const calls = [];
  const downloads = [];
  const notices = [];
  const states = [];
  const controller = createEbookExport({
    planOf: () => ({ ...plan }),
    chunkOf: text => text.split(/(?<=。)/).filter(part => part !== ''),
    fetchChunk: fetchImpl ?? (async (text, options) => {
      calls.push({ text, options });
      return { bytes: frame(calls.length), cached: false, billedBytes: 30 };
    }),
    download: (bytes, filename) => downloads.push({ bytes, filename }),
    notify: (message, isError) => notices.push({ message, isError: isError === true }),
    onState: (phase, info) => states.push({ phase, ...info }),
    concurrency,
  });
  return { controller, calls, downloads, notices, states };
}

describe('A5 · 计划：按章不按本、事前报价、上限硬拦', () => {
  it('★ 整本（19 万字）被拒，且说清「别一次导出整本书」', () => {
    const whole = '书'.repeat(190000);
    const plan = planSpeechExport(whole, { cloudConfigured: true });
    assert.equal(plan.ok, false);
    assert.match(plan.error, /整本书/);
    assert.match(plan.error, /字节计费/);
    assert.equal(estimateSpeechCost(whole) > 20, true, '夹具得真是一笔可观的钱');
  });

  it('空正文 / 没配 Key 都不发请求，且给的是能自救的话', () => {
    assert.match(planSpeechExport('  ', { cloudConfigured: true }).error, /没有可导出的正文/);
    assert.match(planSpeechExport(PLAN.text, { cloudConfigured: false }).error, /设置 → 朗读/);
  });

  it('正常一节：费用与共用层同源、时长按 240 字/分钟、文件名带节号', () => {
    const text = '正文。'.repeat(500);
    const plan = planSpeechExport(text, { title: '三体/第一卷', page: 7, cloudConfigured: true });
    assert.equal(plan.ok, true);
    assert.equal(plan.error, '');
    assert.equal(plan.cost, estimateSpeechCost(text));
    assert.equal(plan.minutes, Math.max(1, Math.ceil(plan.chars / CHARS_PER_MINUTE)));
    assert.equal(plan.filename, '三体第一卷-第7节.mp3');
    assert.match(exportQuote(plan), /最多/);
    assert.match(exportQuote(plan), /不重复收费/);
  });

  it('上限可注入（测试与将来调价用），文件名洗掉路径与非法字符', () => {
    const plan = planSpeechExport('很短', { cloudConfigured: true, maxBytes: 3 });
    assert.equal(plan.ok, false);
    assert.match(plan.error, /上限/);
    assert.equal(safeFileName('  a\\b:c*?d"e<f>g|h  ', 2), 'abcdefgh-第2节.mp3');
    assert.equal(safeFileName('', 0), '电子书-第1节.mp3');
    assert.equal(EXPORT_MAX_BYTES, 36 * 1024);
  });
});

describe('A5 · MP3 无损拼接（逐字节核）', () => {
  it('★ 按比特位找同步头：只判 0xff 会把 ID3 里的字节当帧', () => {
    assert.equal(findFrameSync(FRAME), 0);
    assert.equal(findFrameSync(joinBytes(Uint8Array.from([9, 9]), FRAME)), 2);
    assert.equal(findFrameSync(Uint8Array.from([0xff, 0x00, 0x90, 0x00])), -1);
    assert.equal(findFrameSync(Uint8Array.from([0xff, 0xe0, 0x90, 0x00])), -1, 'layer=0 是非法层');
    assert.equal(findFrameSync(Uint8Array.from([0xff, 0xe2, 0x00, 0x00])), -1, 'bitrate=0 非法');
    assert.equal(findFrameSync(Uint8Array.from([0xff, 0xe2, 0x9c, 0x00])), -1, 'sampleRate=3 非法');
  });

  it('ID3v2 用同步安全整数算长度，footer 标志要加 10 字节', () => {
    const plain = id3v2(10);
    assert.equal(skipId3v2(plain), 20);
    assert.equal(skipId3v2(id3v2(10, 0x10)), 30);
    assert.equal(skipId3v2(FRAME), 0);
    assert.equal(skipId3v2(new Uint8Array(3)), 0);
  });

  it('尾部 ID3v1 被剁掉，正常音频字节不动', () => {
    assert.equal(trimId3v1(joinBytes(FRAME, id3v1())).length, FRAME.length);
    assert.equal(trimId3v1(FRAME).length, FRAME.length);
  });

  it('extractAudioFrames 同时剥首尾元数据，中间原样保留', () => {
    const part = joinBytes(id3v2(10), frame(7), id3v1());
    const frames = extractAudioFrames(part);
    assert.deepEqual([...frames], [...frame(7)]);
    assert.deepEqual([...extractAudioFrames(new Uint8Array([1, 2, 3]))], []);
  });

  it('★ 3 块（带 ID3v2 / 无标签 / 带 ID3v1）拼接：字节不丢、中间不夹标签', () => {
    const parts = [
      joinBytes(id3v2(10), frame(1), id3v1()),
      frame(2),
      joinBytes(frame(3), id3v1()),
    ];
    const expected = parts.map(extractAudioFrames).reduce((sum, p) => sum + p.length, 0);
    const merged = concatMp3(parts);
    assert.equal(merged.length, expected, '无损拼接不许丢字节，也不许塞静音');
    assert.deepEqual([...merged], [...joinBytes(frame(1), frame(2), frame(3))]);
    assert.equal(findFrameSync(merged), 0, '开头不是帧 = 标签被留在最前面了');
    assert.equal(scanMp3(merged).firstSyncAt, 0);
    // scanMp3 数的是「首个同步头之后的同步点」，3 块拼起来是 2 个。
    assert.equal(scanMp3(merged).frames, 2);
    assert.equal(merged.includes(0x49), false, '夹了 ID3 的 I');
  });

  it('一块也解析不出帧时退化为原样相接，至少不丢数据', () => {
    const a = Uint8Array.from([1, 2, 3]);
    const b = Uint8Array.from([4, 5]);
    assert.deepEqual([...concatMp3([a, b])], [1, 2, 3, 4, 5]);
    assert.equal(concatMp3([]).length, 0);
  });
});

describe('A5 · 状态机：两段式、取消、失败续跑、只下载一次', () => {
  it('★ 第一次点只报价，一个请求都不发', () => {
    const t = harness();
    t.controller.toggle();
    assert.equal(t.controller.phase, 'confirming');
    assert.equal(t.calls.length, 0);
    assert.equal(t.downloads.length, 0);
    assert.match(t.notices[0].message, /最多/);
    assert.match(t.notices[0].message, /再点一次/);
  });

  it('★ 第二次点才合成，全部成功后只下载一次、文件名来自计划', async () => {
    const t = harness();
    t.controller.toggle();
    t.controller.toggle();
    await tick();
    assert.equal(t.calls.length, 3);
    assert.equal(t.downloads.length, 1);
    assert.equal(t.downloads[0].filename, PLAN.filename);
    assert.equal(t.downloads[0].bytes.length, 3 * FRAME.length);
    assert.equal(t.controller.phase, 'idle');
    assert.match(t.notices.at(-1).message, /实际计费/);
  });

  it('plan 不 ok 时一次请求都不发（没配 Key / 超上限）', () => {
    const t = harness({ plan: { ...PLAN, ok: false, error: '没有 Key' } });
    t.controller.toggle();
    t.controller.toggle();
    assert.equal(t.calls.length, 0);
    assert.equal(t.downloads.length, 0);
    assert.equal(t.notices[0].isError, true);
  });

  it('★ 取消不落半个文件，且已经合成的块留在内存', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let active = 0;
    const t = harness({
      fetchImpl: async (text, options) => {
        active += 1;
        await gate;
        return { bytes: frame(active), cached: false, billedBytes: 0 };
      },
    });
    t.controller.toggle();
    t.controller.toggle();
    await tick(2);
    assert.equal(t.controller.phase, 'working');
    t.controller.cancel();
    release();
    await tick();
    assert.equal(t.downloads.length, 0, '取消还写了文件 = 播放器里会有半个 mp3');
    assert.equal(t.controller.phase, 'idle');
    assert.match(t.notices.at(-1).message, /没有生成文件/);
  });

  it('★ 失败保留已合成块，续跑只补没拿到的（不从头再来）', async () => {
    let recovered = false;
    const t = harness({
      fetchImpl: async (text) => {
        t.calls.push({ text });
        if (text.includes('第二') && !recovered) throw new Error('网络断了');
        return { bytes: frame(text.charCodeAt(1)), cached: false, billedBytes: 0 };
      },
    });
    t.controller.toggle();
    t.controller.toggle();
    await tick();
    assert.equal(t.controller.phase, 'failed');
    assert.equal(t.downloads.length, 0);
    assert.match(t.notices.at(-1).message, /已经合成的块留着/);

    const before = t.calls.length;
    recovered = true;
    t.controller.toggle();
    await tick();
    const resumed = t.calls.slice(before).map(call => call.text);
    assert.ok(!resumed.some(text => text.includes('第一')), '把已合成的第一块又请求了一遍');
    assert.ok(resumed.some(text => text.includes('第二')));
    assert.ok(resumed.some(text => text.includes('第三')));
    assert.equal(t.downloads.length, 1);
  });

  it('并发受限：同时在途不超过 concurrency', async () => {
    let active = 0;
    let max = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const t = harness({
      concurrency: 2,
      fetchImpl: async (text) => {
        t.calls.push({ text });
        active += 1;
        max = Math.max(max, active);
        await gate;
        active -= 1;
        return { bytes: frame(1), cached: false, billedBytes: 0 };
      },
    });
    t.controller.toggle();
    t.controller.toggle();
    await tick(2);
    assert.equal(max, 2);
    release();
    await tick();
    assert.equal(t.downloads.length, 1);
  });

  it('全部命中缓存时如实说「没有产生新的费用」', async () => {
    const t = harness({
      fetchImpl: async (text) => { t.calls.push({ text }); return { bytes: frame(2), cached: true, billedBytes: 0 }; },
    });
    t.controller.toggle();
    t.controller.toggle();
    await tick();
    assert.match(t.notices.at(-1).message, /没有产生新的费用/);
  });

  it('导出提示与按钮文案随阶段变，且不会把「确认」说成「已完成」', () => {
    assert.equal(exportLabel('idle'), '导出本节');
    assert.equal(exportLabel('confirming'), '确认导出');
    assert.equal(exportLabel('working'), '取消导出');
    assert.equal(exportLabel('failed'), '接着导出');
    assert.match(exportHint({ phase: 'working', done: 2, total: 5 }), /2\/5/);
    assert.match(exportHint({ phase: 'confirming' }), /一个字节都还没发/);
  });

  it('dispose 后不再响应点击（翻页 / 换书停掉旧节）', () => {
    const t = harness();
    t.controller.dispose();
    t.controller.toggle();
    assert.equal(t.calls.length, 0);
    assert.equal(t.notices.length, 0);
  });
});

describe('A5 · HTTP 与下载两条边（真跑，注入环境）', () => {
  it('fetchExportChunk 带回计费头，错误文案用宿主原话', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: key => ({ 'x-speech-cached': '1', 'x-speech-billed-bytes': '321' })[key] ?? null },
      arrayBuffer: async () => FRAME.buffer.slice(0),
    });
    try {
      const result = await fetchExportChunk('/api/speech', '你好', { voice: 'claire', speed: 1, signal: undefined });
      assert.equal(result.cached, true);
      assert.equal(result.billedBytes, 321);
      assert.equal(result.bytes.length, FRAME.length);
    } finally { globalThis.fetch = original; }

    globalThis.fetch = async () => ({
      ok: false, status: 402, json: async () => ({ error: '余额不足' }),
    });
    try {
      await assert.rejects(() => fetchExportChunk('/api/speech', '你好', {}), /余额不足/);
    } finally { globalThis.fetch = original; }
  });

  it('downloadBytes 真跑：文件名、mime、释放 URL', () => {
    const made = [];
    const revoked = [];
    const fakeDoc = {
      body: { appendChild: () => {} },
      createElement: () => ({ click() {}, remove() {}, set href(v) { this._href = v; }, get href() { return this._href; } }),
    };
    const fakeUrl = {
      createObjectURL: (blob) => { made.push(blob); return 'blob:fake'; },
      revokeObjectURL: (href) => revoked.push(href),
    };
    const href = downloadBytes('书-第1节.mp3', FRAME, {
      document: fakeDoc, url: fakeUrl, Blob: class { constructor(parts, options) { this.parts = parts; this.options = options; } },
      schedule: fn => fn(),
    });
    assert.equal(href, 'blob:fake');
    assert.equal(made[0].options.type, 'audio/mpeg');
    assert.deepEqual(revoked, ['blob:fake']);
  });
});

describe('A5 · 接线守卫：A4 在前、只有当前节、FAB 第 8 槽', () => {
  it('★ 导出链路经过 speechChunksForReading（否则导出的音频会批量读错多音字）', () => {
    assert.match(clientSource, /speechChunksForReading\(/);
    assert.match(clientSource, /isPronunciationEnabled\(storage\)/);
    const chunks = speechChunksForReading('他把行李放在重庆。', 300, true);
    assert.equal(chunks.join(''), '他把行理放在崇庆。');
  });

  it('计划里只读当前节文本，没有「全书 / 所有节」入口', () => {
    assert.match(bookSource, /useEbookExport\(\{/);
    assert.match(bookSource, /text: sectionText/);
    assert.doesNotMatch(clientSource, /sections|bookText|allSections/);
    assert.match(exportSource, /EXPORT_MAX_BYTES = 36 \* 1024/);
  });

  it('FAB 第 8 槽真绑到 toggle，图标用静态 name', () => {
    assert.match(bookSource, /import \{ useEbookExport \} from '\.\/ebook-export\.js'/);
    // 0.76.1 加了「语速」第 7 槽（紧跟「听本节」），总数 9；导出顺延到第 8 槽（index 7）。
    assert.match(bookSource, /fabStack\(\{ count: 9,/);
    assert.match(bookSource, /style=\{slotStyle\(7\)\}/);
    assert.match(bookSource, /onClick=\{ebookExport\.toggle\}/);
    assert.match(bookSource, /title=\{ebookExport\.hint\}/);
    assert.match(bookSource, /<Icon name="download" size=\{16\} \/>/);
  });

  it('MIT 移植保留原作者署名', () => {
    assert.match(exportSource, /MIT/);
    assert.match(exportSource, /Copyright \(c\) 2026 Zanbin Xu/);
  });
});
