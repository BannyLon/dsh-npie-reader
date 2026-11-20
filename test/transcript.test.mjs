/**
 * 字幕的共用判据与格式解析（P0）。
 *
 * 这个文件守的是「**时间轴**」这件事本身：切段、跳转、高亮全都由它派生。
 * 它出错的方式很安静 —— 段落仍会显示、按钮仍会跳，只是跳偏了 1.2 秒，
 * 或者高亮永远慢一段。所以每条判据都配一个具体的秒数，而不是断「有没有」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  activeParagraphIndex, formatClock, isMostlyChinese, normalizeSegments, paragraphize,
  parseClock, transcriptRefOf, transcriptView,
} from '../src/transcript.js';
import { parsePodcastJson, parseSrt, parseTranscript, parseVtt } from '../src/host/transcript-parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = join(here, '..', 'src', 'transcript.js');

describe('formatClock / parseClock', () => {
  it('把秒格式化成 mm:ss，超过一小时才出现小时位', () => {
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(65), '01:05');
    // 59.9 秒仍然显示 00:59：字幕是「已经过去的时间」，向上取整会让它比声音快一秒。
    assert.equal(formatClock(59.9), '00:59');
    assert.equal(formatClock(3600), '1:00:00');
    assert.equal(formatClock(3725.4), '1:02:05');
  });

  it('非法输入给占位符，而不是负数或 NaN', () => {
    assert.equal(formatClock(-1), '--:--');
    assert.equal(formatClock(Number.NaN), '--:--');
    assert.equal(formatClock(undefined), '--:--');
  });

  it('认 VTT 的点号、SRT 的逗号与纯秒数三种写法', () => {
    assert.equal(parseClock('01:02:03.500'), 3723.5);
    assert.equal(parseClock('00:01,200'), 1.2);
    assert.equal(parseClock('62'), 62);
    assert.equal(parseClock('1:02.5'), 62.5);
    assert.equal(parseClock(''), undefined);
    assert.equal(parseClock('a:b'), undefined);
    assert.equal(parseClock('1:2:3:4'), undefined);
  });
});

describe('normalizeSegments', () => {
  it('丢掉时间轴不合法的条目，按起点排序，去掉同秒重复', () => {
    const out = normalizeSegments([
      { start: 10, end: 11, text: '  third   cue ' },
      { start: 1, end: 2, text: 'first' },
      // end <= start：音频里不可能存在，留着会让切段算法把两段并成一段。
      { start: 5, end: 5, text: 'zero length' },
      { start: Number.NaN, end: 3, text: 'no start' },
      { start: 1, end: 2, text: 'first' },
      { start: 3, end: 4, text: '   ' },
    ]);
    assert.deepEqual(out.map((item) => item.start), [1, 10]);
    assert.equal(out[1].text, 'third cue');
  });

  it('不是数组时给空数组（坏数据不该让面板崩）', () => {
    assert.deepEqual(normalizeSegments(undefined), []);
    assert.deepEqual(normalizeSegments('nope'), []);
  });
});

describe('paragraphize', () => {
  it('间隔够近就并成一段，远了就断开', () => {
    const merged = paragraphize([
      { start: 0, end: 1, text: 'hello' },
      { start: 1.5, end: 2, text: 'world' },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].text, 'hello world');
    assert.equal(merged[0].start, 0);
    assert.equal(merged[0].end, 2);

    const split = paragraphize([
      { start: 0, end: 1, text: 'hello' },
      // 间隔 4 秒 > 1.2 秒：留白是语义上的段落边界。
      { start: 5, end: 6, text: 'world' },
    ]);
    assert.equal(split.length, 2);
  });

  it('超过字数上限必须断段（否则一段挤进整个开场白）', () => {
    const long = 'word '.repeat(50).trim(); // 249 字
    const out = paragraphize([
      { start: 0, end: 5, text: long },
      { start: 5.2, end: 9, text: 'tail' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[1].text, 'tail');
  });

  it('句末且已经够长时断段，让「点一下跳转」的粒度落在句子边界', () => {
    const sentence = `${'a'.repeat(70)}.`;
    const out = paragraphize([
      { start: 0, end: 5, text: sentence },
      { start: 5.2, end: 9, text: 'next sentence' },
    ]);
    assert.equal(out.length, 2);
  });

  it('句末但很短时继续并段（一句一断读起来像电报）', () => {
    const out = paragraphize([
      { start: 0, end: 1, text: 'Yes.' },
      { start: 1.2, end: 2, text: 'I agree' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'Yes. I agree');
  });

  it('反向对照：把「句末断段」这条判据去掉，上面那条用例的期望必须变红', async () => {
    const source = readFileSync(SHARED, 'utf8');
    const from = 'closeEnough && fits && !shouldBreak';
    const to = 'closeEnough && fits';
    assert.ok(source.includes(from), `变异锚点没命中：${from}`);
    const mutated = source.replace(from, to);
    // 与实现同源的模块从 data URL 里加载：它没有相对 import，可以独立跑。
    const mod = await import(`data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`);
    const sentence = `${'a'.repeat(70)}.`;
    const out = mod.paragraphize([
      { start: 0, end: 5, text: sentence },
      { start: 5.2, end: 9, text: 'next sentence' },
    ]);
    // 去掉那条判据之后，这两句会被并成一段 —— 说明真实现的 2 段不是「碰巧」。
    assert.equal(out.length, 1, '变异后仍然断成两段，说明这条判据根本没有生效');
    assert.match(out[0].text, /next sentence$/);
  });
});

describe('activeParagraphIndex', () => {
  const paragraphs = [
    { start: 0, end: 2 },
    { start: 10, end: 12 },
    { start: 20, end: 22 },
  ];

  it('第一段之前不亮任何一段', () => {
    assert.equal(activeParagraphIndex(paragraphs, -1), -1);
    assert.equal(activeParagraphIndex([{ start: 5, end: 6 }], 4.9), -1);
  });

  it('停在句间空白里时保持上一段（全灭再亮读起来像接触不良）', () => {
    assert.equal(activeParagraphIndex(paragraphs, 5), 0);
    assert.equal(activeParagraphIndex(paragraphs, 11), 1);
  });

  it('播完之后停在最后一段，而不是回到开头', () => {
    assert.equal(activeParagraphIndex(paragraphs, 999), 2);
  });

  it('空列表与非数字时间给 -1', () => {
    assert.equal(activeParagraphIndex([], 3), -1);
    assert.equal(activeParagraphIndex(paragraphs, Number.NaN), -1);
  });
});

describe('transcriptRefOf', () => {
  it('只收带凭据之外的 https 地址，类型可缺省', () => {
    assert.deepEqual(
      transcriptRefOf({ transcript: { url: 'https://cdn.example/a.vtt', type: 'text/VTT' } }),
      { url: 'https://cdn.example/a.vtt', type: 'text/vtt' },
    );
    assert.deepEqual(transcriptRefOf({ transcript: { url: 'https://cdn.example/a.vtt' } }), { url: 'https://cdn.example/a.vtt', type: '' });
  });

  it('http、带账号、空值一律拒绝（这段地址来自第三方 feed）', () => {
    assert.equal(transcriptRefOf({ transcript: { url: 'http://cdn.example/a.vtt' } }), undefined);
    assert.equal(transcriptRefOf({ transcript: { url: 'https://u:p@cdn.example/a.vtt' } }), undefined);
    assert.equal(transcriptRefOf({ transcript: { url: '' } }), undefined);
    assert.equal(transcriptRefOf({}), undefined);
    assert.equal(transcriptRefOf(null), undefined);
  });
});

describe('transcriptView', () => {
  it('给出段数（原始 cue）与段落（合并后），两者不是同一个数', () => {
    const view = transcriptView({
      key: 'feed:1', format: 'vtt', fetchedAt: 1700000000000,
      source: { kind: 'feed' },
      segments: [
        { start: 0, end: 1, text: 'a' },
        { start: 1.2, end: 2, text: 'b' },
      ],
    });
    assert.equal(view.segments, 2);
    assert.equal(view.paragraphs.length, 1);
    assert.equal(view.format, 'vtt');
    assert.equal(view.source.kind, 'feed');
  });

  it('null 进 null 出（面板靠它判「这期没有字幕」）', () => {
    assert.equal(transcriptView(null), null);
    assert.equal(transcriptView(undefined), null);
  });
});

describe('格式解析', () => {
  const VTT = `WEBVTT

NOTE 这一段是注释，没有时间轴

00:00:01.000 --> 00:00:03.000 align:start position:0%
Hello <i>world</i>

00:00:03.200 --> 00:00:05.000
this is <00:00:03.500><c>a test</c>
`;

  const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,000 --> 00:00:06,000
第二行
接在下一行
`;

  it('VTT：跳过 NOTE，清掉内联标签与卡拉 OK 时间戳', () => {
    const segments = parseVtt(VTT);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].text, 'Hello world');
    assert.equal(segments[1].text, 'this is a test');
    assert.equal(segments[1].start, 3.2);
  });

  it('SRT：逗号时间戳、序号行、多行文本都要认', () => {
    const segments = parseSrt(SRT);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].start, 1);
    assert.equal(segments[1].text, '第二行 接在下一行');
  });

  it('Podcasting 2.0 JSON：秒为单位的 startTime/endTime，缺 endTime 用 +2 兜底', () => {
    const segments = parsePodcastJson(JSON.stringify({
      version: '1.0.0',
      segments: [
        { startTime: 0, endTime: 1.5, body: 'hello' },
        { startTime: 2, body: 'no end' },
      ],
    }));
    assert.equal(segments.length, 2);
    assert.equal(segments[1].end, 4);
  });

  it('类型缺失时按内容嗅探，三种格式都能认', () => {
    assert.equal(parseTranscript(VTT).format, 'vtt');
    assert.equal(parseTranscript(SRT).format, 'srt');
    assert.equal(parseTranscript('{"segments":[{"startTime":0,"endTime":1,"body":"x"}]}').format, 'json');
  });

  it('声明的类型与内容矛盾时以内容为准（把 JSON 声明成 text/vtt 是真实存在的坏 feed）', () => {
    const body = '{"segments":[{"startTime":0,"endTime":1,"body":"x"}]}';
    const parsed = parseTranscript(body, 'text/vtt');
    assert.equal(parsed.format, 'json');
    assert.equal(parsed.segments.length, 1);
  });

  it('空文件 / 认不出格式 / JSON 坏掉都要报出可区分的 code', () => {
    assert.throws(() => parseTranscript(''), (error) => error.code === 'TRANSCRIPT_FORMAT');
    assert.throws(() => parseTranscript('just words'), (error) => error.code === 'TRANSCRIPT_FORMAT');
    assert.throws(() => parseTranscript('{oops', 'application/json'), (error) => error.code === 'TRANSCRIPT_JSON');
    // 有 `-->` 但两行时间戳都不合法：能认出是 SRT，但一条都切不出来。
    assert.throws(() => parseTranscript('a --> b\ntext'), (error) => error.code === 'TRANSCRIPT_EMPTY');
  });
});

/**
 * 「这段本来就是中文吗」——翻译前用它决定要不要花钱。
 *
 * ★ 判错的两个方向代价不同：
 *   · 把中文误判成英文 ⇒ 再翻一遍，白花钱，还可能把「特斯拉」译成「Tesla 公司」；
 *   · 把英文误判成中文 ⇒ 这一段永远没有译文，用户看到一段英文夹在中文里，
 *     会以为「模型漏翻了这段」。
 *   所以判据必须双向都有用例，而不是只测「中文返回 true」。
 */
describe('isMostlyChinese', () => {
  it('整段中文（含标点）判成中文', () => {
    assert.equal(isMostlyChinese('我们今天聊一聊这个产品的定价策略，以及它为什么能留住用户。'), true);
    assert.equal(isMostlyChinese('好。'), true);
  });

  it('★ 英文里夹一个中文词仍然是英文（只判「有没有汉字」会在这里出错）', () => {
    assert.equal(isMostlyChinese('So the whole thing is basically a 谢谢 for listening, and that is it.'), false);
    assert.equal(isMostlyChinese('This is a podcast about building products.'), false);
  });

  it('中文口播里夹几个英文术语仍算中文', () => {
    assert.equal(isMostlyChinese('我们用 Node.js 和 TypeScript 写这个插件，主要考虑的是打包体积。'), true);
  });

  it('空串、纯标点、纯数字都不算中文', () => {
    assert.equal(isMostlyChinese(''), false);
    assert.equal(isMostlyChinese('…——！？'), false);
    assert.equal(isMostlyChinese('1:02:03'), false);
    assert.equal(isMostlyChinese(undefined), false);
  });

  it('反向对照：把比例判据换成「含有汉字」，上面那条英文用例必须翻成 true', () => {
    const hasCjkOnly = (text) => /[\u4e00-\u9fff]/.test(String(text ?? ''));
    const sample = 'So the whole thing is basically a 谢谢 for listening, and that is it.';
    assert.equal(hasCjkOnly(sample), true, '对照本身失效了：这条样本里确实有汉字');
    assert.equal(isMostlyChinese(sample), false, '比例判据没有挡住「英文夹汉字」');
  });
});
