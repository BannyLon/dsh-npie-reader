/**
 * 本机语音识别（0.82.0）—— 引擎探测、提示词、结果解析、幻觉过滤。
 *
 * 这一层的判据都在**纯函数**上，因为真正的识别跑在子进程里、依赖 181 MB 的模型，
 * 不适合放进每次 `npm test`。但纯函数恰恰是出错时最难发现的部分：
 *
 *   ① 提示词里「用简体」必须在前、专名必须在后（Whisper 的 prompt 只在**末尾**
 *      权重最大，写反了等于专名被截掉，识别照样能跑、只是名字一直错）；
 *   ② 结果解析必须以 `offsets`（毫秒）为准，不能去解析 `timestamps` 字符串
 *      —— 两者只要有一处口径不同，字幕就会整体偏移；
 *   ③ 幻觉过滤必须**放过长句**：包含「订阅」但说了 40 个字的那一段是真话，
 *      删掉它比留一句幻觉更糟。
 *
 * ★ 每条守卫都配了反向对照（把实现改坏就得红），否则「空数组等于空数组」也能过。
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  ASR_MODELS,
  AsrError,
  buildPrompt,
  cleanCues,
  ensureModel,
  fetchToFile,
  findExecutable,
  modelPathOf,
  parseRecognizerJson,
  probeAsr,
  recognizeSlice,
  toWav,
  writeSilentWav,
} from '../src/host/asr.js';

/** 每次新建目录，避免并行用例互相看到对方的假引擎。 */
async function tempDir(label) {
  return await mkdtemp(join(tmpdir(), `npr-asr-${label}-`));
}

describe('buildPrompt', () => {
  it('简体引导在开头，标题与节目名在结尾', () => {
    const prompt = buildPrompt({ title: 'HF0 与 OpenRouter 早期故事', show: '硅谷101' });
    assert.ok(prompt.startsWith('以下是普通话的句子'), prompt);
    assert.ok(prompt.includes('HF0'), prompt);
    assert.ok(prompt.trimEnd().endsWith('。'), prompt);
    // ★ 反向对照：标题必须在「简体引导」之后。写反了专名会被 prompt 预算截掉。
    assert.ok(prompt.indexOf('HF0') > prompt.indexOf('以下是普通话的句子'), prompt);
  });

  it('长度不超过 160 字，且截断时先丢显示名而不是标题', () => {
    const long = '非常长的节目标题'.repeat(20);
    const prompt = buildPrompt({ title: long, show: '硅谷101' });
    assert.ok([...prompt].length <= 160, `长度 ${[...prompt].length}`);
    // 标题被截时尾巴上仍是标题的开头（说明丢的是 show，不是 title）。
    assert.ok(prompt.includes('非常长的节目标题'), prompt);
  });

  it('英文音频不带简体引导', () => {
    const prompt = buildPrompt({ title: 'Lex Fridman', show: 'Lex', language: 'en' });
    assert.ok(!prompt.includes('简体'), prompt);
    assert.ok(prompt.includes('Lex Fridman'), prompt);
  });

  it('没有任何元信息时返回简体引导本身（不为空串）', () => {
    // ★ 空提示词会让 whisper 回到默认的繁体输出，所以这句不能省。
    assert.notEqual(buildPrompt({}).trim(), '');
  });
});

describe('parseRecognizerJson', () => {
  it('offsets 是毫秒，转成秒', () => {
    const raw = JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 1280 }, text: 'Alex是美国人' },
        { offsets: { from: 30000, to: 31800 }, text: '一个在顶楼' },
      ],
    });
    const cues = parseRecognizerJson(raw);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].end, 1.28);
    assert.equal(cues[1].start, 30);
  });

  it('缺 to 时给一个能读的默认时长，而不是 NaN', () => {
    const cues = parseRecognizerJson(JSON.stringify({ transcription: [{ offsets: { from: 5000 }, text: 'x' }] }));
    assert.equal(cues[0].start, 5);
    assert.ok(Number.isFinite(cues[0].end) && cues[0].end > cues[0].start);
  });

  it('空文本与缺 offsets 的条目被丢掉', () => {
    const cues = parseRecognizerJson(JSON.stringify({
      transcription: [{ offsets: { from: 0, to: 100 }, text: '   ' }, { text: '没有 offsets' }],
    }));
    assert.deepEqual(cues, []);
  });

  it('坏 JSON 报 AsrError 而不是 SyntaxError', () => {
    // ★ 路由层靠 `code` 决定文案；裸 SyntaxError 会变成「未知错误」。
    assert.throws(() => parseRecognizerJson('{oops'), (error) => error instanceof AsrError && error.code === 'ASR_BAD_JSON');
  });
});

describe('cleanCues', () => {
  const cue = (start, end, text) => ({ start, end, text });

  it('删掉 whisper 在静音处编出来的短句', () => {
    const cues = cleanCues([
      cue(0, 1.5, '谢谢观看'),
      cue(1.5, 3, '请不吝点赞'),
      cue(3, 6, '今天我们聊聊开源模型'),
      cue(6, 7.5, 'Subtitles by Amara.org'),
    ]);
    assert.deepEqual(cues.map((item) => item.text), ['今天我们聊聊开源模型']);
  });

  it('长句里出现「订阅」是真话，必须保留', () => {
    // ★ 反向对照：只按关键词删就会把这段真话删掉。
    const long = '如果你觉得这期节目有用，欢迎在苹果播客和小宇宙订阅我们的节目，也欢迎把它转发给需要的朋友，我们每周三更新。';
    const cues = cleanCues([cue(0, 12, long)]);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, long);
  });

  it('纯音乐标记被丢掉，句子中间的 ♪ 只去掉符号', () => {
    const cues = cleanCues([
      cue(0, 2, '[Music]'),
      cue(2, 4, '♪♪'),
      cue(4, 6, '♪ 我们开始吧 ♪'),
    ]);
    assert.deepEqual(cues.map((item) => item.text), ['我们开始吧']);
  });

  it('相邻重复只留一条（模型卡住时会连着吐两遍）', () => {
    const cues = cleanCues([
      cue(0, 2, '这是同一句话'),
      cue(2, 4, '这是同一句话'),
      cue(4, 6, '下一句'),
    ]);
    assert.deepEqual(cues.map((item) => item.text), ['这是同一句话', '下一句']);
  });

  it('保留时间轴，不做重排', () => {
    const cues = cleanCues([cue(10, 12, '甲'), cue(12, 14, '乙')]);
    assert.deepEqual(cues, [{ start: 10, end: 12, text: '甲' }, { start: 12, end: 14, text: '乙' }]);
  });
});

describe('probeAsr', () => {
  it('空目录报告缺引擎与模型（ffmpeg 另算）', async () => {
    const dir = await tempDir('empty');
    const probe = await probeAsr({ dataDir: dir });
    assert.equal(probe.engine.ok, false);
    assert.equal(probe.models.length, 0);
    assert.equal(probe.ready, false);
    assert.ok(probe.missing.includes('engine'));
    assert.ok(probe.missing.includes('model'));
  });

  it('插件目录里放了可执行引擎与模型文件后，三项就位', async () => {
    const dir = await tempDir('ready');
    const engineDir = join(dir, 'asr', `crispasr-${(await import('../src/host/asr.js')).ASR_ENGINE.version}`);
    await mkdir(engineDir, { recursive: true });
    const bin = join(engineDir, 'crispasr');
    await writeFile(bin, '#!/bin/sh\nexit 0\n');
    await chmod(bin, 0o755);
    const modelsDir = join(dir, 'asr', 'models');
    await mkdir(modelsDir, { recursive: true });
    // probeAsr 只看「> 1 MB」，所以这里写一块够大的内容，而不是真的模型。
    await writeFile(join(modelsDir, ASR_MODELS[0].file), Buffer.alloc(2 * 1024 * 1024));
    const probe = await probeAsr({ dataDir: dir });
    assert.equal(probe.engine.ok, true, JSON.stringify(probe.engine));
    assert.equal(probe.engine.path, bin);
    assert.deepEqual(probe.models.map((model) => model.id), ['base']);
    // ffmpeg 在某台机器上没有时这一轮仍然成立：那一条单独由 missing 报。
    assert.equal(probe.ready, probe.ffmpeg.ok);
  });

  it('findExecutable 认得带路径的名字，也认 PATH 里的名字', async () => {
    const dir = await tempDir('bin');
    const path = join(dir, 'tool');
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    await chmod(path, 0o755);
    assert.equal(await findExecutable([path], []), path);
    assert.equal(await findExecutable(['definitely-not-here-xyz'], [dir]), '');
  });
});

describe('writeSilentWav', () => {
  it('写出来的 WAV 头自洽（RIFF/WAVE/data 长度）', async () => {
    const dir = await tempDir('wav');
    const path = join(dir, 'a.wav');
    await writeSilentWav(path, 0.5);
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.readUInt32LE(4), buf.length - 8);
    assert.equal(buf.readUInt32LE(24), 16000);
    assert.equal(buf.readUInt32LE(40), buf.length - 44);
  });
});

/**
 * 假引擎：把收到的参数原样记到 `<of>.args`，再写一份识别结果到 `<of>.json`。
 *
 * ★ 为什么要这个假件：`recognizeSlice` 的正误全在**参数**上（`-sp` 少一个，
 *   时间轴就退化成「整片一条」；`-ot` 少一个，第二片的时间戳从 0 重新开始）。
 *   这些都不会让进程报错，只会让字幕悄悄错位 —— 只有把参数抓下来才能断言。
 */
const FAKE_ENGINE = `#!/bin/sh
of=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-of" ]; then of="$a"; fi
  prev="$a"
done
printf '%s\\n' "$@" > "$of.args"
printf '{"transcription":[{"offsets":{"from":300000,"to":301500},"text":"这一段是真话"},{"offsets":{"from":301500,"to":303000},"text":"谢谢观看"}]}' > "$of.json"
`;

async function fakeEngine(dir) {
  const path = join(dir, 'fake-engine');
  await writeFile(path, FAKE_ENGINE);
  await chmod(path, 0o755);
  return path;
}

describe('recognizeSlice', () => {
  it('把 -ot / -d / -sp / --prompt 都传给引擎，并按 offsets 出时间轴', async () => {
    const dir = await tempDir('slice');
    const bin = await fakeEngine(dir);
    const outDir = join(dir, 'out');
    const cues = await recognizeSlice({
      bin,
      model: '/nonexistent.bin',
      wav: '/nonexistent.wav',
      startMs: 300000,
      durationMs: 300000,
      language: 'auto',
      prompt: '以下是普通话的句子，用简体中文转写。硅谷101。',
      outDir,
    });
    // 假引擎不回显，所以断言只能看参数文件。
    const args = (await readFile(join(outDir, 'slice-300.args'), 'utf8')).trim().split('\n');
    assert.ok(args.includes('-ot') && args[args.indexOf('-ot') + 1] === '300000', args.join(' '));
    assert.ok(args.includes('-d') && args[args.indexOf('-d') + 1] === '300000', args.join(' '));
    // ★ 反向对照：`-sp` 掉了的话引擎会把整片吐成一条，高亮与点句跳转全失效。
    assert.ok(args.includes('-sp'), '缺 -sp：\n' + args.join(' '));
    assert.ok(args.includes('--prompt'), '缺 --prompt：\n' + args.join(' '));
    assert.equal(args[args.indexOf('--prompt') + 1], '以下是普通话的句子，用简体中文转写。硅谷101。');
    // 幻觉句（1.5 秒的「谢谢观看」）在这一层就被清掉。
    assert.deepEqual(cues.map((cue) => cue.text), ['这一段是真话']);
    assert.equal(cues[0].start, 300);
  });

  it('输出目录不存在时自己建（引擎会静默不写文件）', async () => {
    const dir = await tempDir('slice-mkdir');
    const bin = await fakeEngine(dir);
    const outDir = join(dir, 'deep', 'nested', 'out');
    const cues = await recognizeSlice({ bin, model: 'm', wav: 'w', startMs: 0, durationMs: 60000, outDir });
    assert.equal(cues.length, 1);
  });

  it('引擎非零退出时报 ASR_SPAWN，并带上 stderr 尾部', async () => {
    const dir = await tempDir('slice-fail');
    const bin = join(dir, 'bad');
    await writeFile(bin, '#!/bin/sh\necho "ggml_backend_load: no such file" >&2\nexit 3\n');
    await chmod(bin, 0o755);
    await assert.rejects(
      () => recognizeSlice({ bin, model: 'm', wav: 'w', startMs: 0, durationMs: 1000, outDir: join(dir, 'o') }),
      (error) => error instanceof AsrError && error.code === 'ASR_SPAWN' && /no such file/.test(error.message),
    );
  });
});

describe('toWav', () => {
  it('没有 ffmpeg 时给 501 ASR_NO_FFMPEG，而不是去 spawn 一个空命令', async () => {
    const dir = await tempDir('no-ffmpeg');
    await assert.rejects(
      () => toWav({ ffmpeg: '', url: 'http://example.org/a.mp3', outPath: join(dir, 'a.wav') }),
      (error) => error instanceof AsrError && error.status === 501 && error.code === 'ASR_NO_FFMPEG',
    );
  });
});

/**
 * 断点续传：这是「下了十分钟又归零」的唯一防线。
 *
 * ★ 两个方向都要测：服务端**认** Range（续上）与**不认** Range（退回全量重写）。
 *   只测前者的话，「服务端忽略 Range 但代码仍以追加模式打开」会把文件写成
 *   「前半段 + 后半段 + 完整内容」—— 长度多出一截，模型加载时报的是
 *   「magic 不对」，用户看到的是「识别引擎崩溃」。
 */
describe('fetchToFile 断点续传', () => {
  const body = Buffer.from('0123456789abcdefghij'); // 20 字节

  async function serve({ honorRange }) {
    const ranges = [];
    /** 分两次写、中间隔 30ms：合成一个 chunk 的话进度只有一个采样点，看不出从哪起算。 */
    const writeTwo = (response, rest) => {
      const half = Math.ceil(rest.length / 2);
      response.write(rest.subarray(0, half));
      setTimeout(() => response.end(rest.subarray(half)), 30);
    };
    const server = http.createServer((request, response) => {
      const range = request.headers.range ?? '';
      ranges.push(range);
      const match = /^bytes=(\d+)-$/.exec(range);
      if (honorRange && match) {
        const from = Number(match[1]);
        const rest = body.subarray(from);
        response.writeHead(206, {
          'content-length': String(rest.length),
          'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
        });
        writeTwo(response, rest);
        return;
      }
      response.writeHead(200, { 'content-length': String(body.length) });
      writeTwo(response, body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return { url: `http://127.0.0.1:${port}/f.bin`, ranges, close: () => new Promise((r) => server.close(r)) };
  }

  it('服务端认 Range：从半截处续上，最终文件完整', async () => {
    const { url, ranges, close } = await serve({ honorRange: true });
    const dir = await tempDir('resume');
    const target = join(dir, 'model.bin');
    await writeFile(`${target}.part`, body.subarray(0, 8));
    const progress = [];
    try {
      const written = await fetchToFile(url, target, { onProgress: (ratio) => progress.push(ratio) });
      assert.equal(written, body.length);
      assert.equal((await readFile(target)).toString(), body.toString());
      assert.deepEqual(ranges, ['bytes=8-']);
      // ★ 反向对照：进度若从 8/20 重算，第一个采样点会落在 0.4 以下 —— 用户看到的
      //   是「续传」但进度从头开始跳。
      assert.ok(progress[0] > 0.4 && progress[0] < 1, `首个进度 ${progress[0]}`);
      assert.equal(progress.at(-1), 1);
    } finally {
      await close();
    }
  });

  it('服务端不认 Range（回 200 全量）：从零重写，不追加成两倍长', async () => {
    const { url, close } = await serve({ honorRange: false });
    const dir = await tempDir('resume-no-range');
    const target = join(dir, 'model.bin');
    await writeFile(`${target}.part`, body.subarray(0, 8));
    const progress = [];
    try {
      await fetchToFile(url, target, { onProgress: (ratio) => progress.push(ratio) });
      assert.equal((await readFile(target)).toString(), body.toString());
      // ★ 反向对照：仍是追加模式的话这里会是 28 字节。
      assert.equal((await stat(target)).size, body.length);
      // ★ 反向对照：`have` 没归零的话首个采样点会从 0.4 起跳（(8+10)/20 = 0.9）。
      assert.ok(progress[0] <= 0.6, `首个进度 ${progress[0]}`);
    } finally {
      await close();
    }
  });

  it('HTTP 错误码抛 ASR_DOWNLOAD，不留下目标文件', async () => {
    const server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const dir = await tempDir('download-404');
    const target = join(dir, 'm.bin');
    try {
      await assert.rejects(
        () => fetchToFile(`http://127.0.0.1:${port}/m.bin`, target),
        (error) => error instanceof AsrError && error.code === 'ASR_DOWNLOAD',
      );
      await assert.rejects(() => stat(target), /ENOENT/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('modelPathOf / ensureModel', () => {
  it('已有可用路径时直接指过去，不再联网下载', async () => {
    const dir = await tempDir('model');
    const modelsDir = join(dir, 'asr', 'models');
    await mkdir(modelsDir, { recursive: true });
    const path = join(modelsDir, ASR_MODELS[1].file);
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024));
    const probe = await probeAsr({ dataDir: dir });
    assert.equal(modelPathOf(probe, 'small'), path);
    // 要一个不在本机的型号时报空串（调用方据此提示「先下模型」），不是随便给一个。
    assert.equal(modelPathOf(probe, 'turbo'), '');
    // 传空串时落到默认型号。
    assert.equal(modelPathOf(probe, ''), path);
    // ensureModel 走「已存在」分支：不下载、不报错。
    assert.equal(await ensureModel({ dataDir: dir, modelId: 'small' }), path);
  });
});

/**
 * 宿主那段「识别一集」的字段口径。
 *
 * ★ 为什么要在测试里读源码：提示词里少一个节目名**不会报错**，`buildPrompt` 会
 *   安静地少一段，Whisper 的专名纠正随之失效 —— 表现是「人名地名一直错」，
 *   而错误现场离这一行有十万八千里。条目上真实的字段是 `channelName`
 *   （`refresh` 时由订阅源标题灌进去），不是 `showName`。
 */
describe('与宿主字段口径一致', () => {
  it('提示词的节目名取自 entry.channelName', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, '..', 'src', 'host', 'service.js'), 'utf8');
    assert.ok(source.includes('entry.channelName'), '提示词没取 channelName');
    assert.equal(source.includes('entry.showName'), false, 'entry 上没有 showName 这个字段');
  });
});

