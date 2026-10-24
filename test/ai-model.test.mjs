/**
 * 「翻译用哪个模型」这个设置项。
 *
 * ★ 这一组用例守的是一个**花钱**的行为，所以两个方向都要钉死：
 *   - 用户选了模型，却因为编码/解析不一致**静默回退**到默认模型 ⇒
 *     他以为在用免费模型，实际一直在花默认模型的钱，且没有任何报错（只有账单能看出来）；
 *   - 用户没选模型（或选了「跟随默认」），却被塞了一个别的模型 ⇒
 *     行为和他看到的设置不一致。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AI_MODEL_DEFAULT, AI_MODEL_SOURCE, aiModelOptions, describeModelCatalog, effectiveModelLabel,
  formatAiModel, isValidAiModel, parseAiModel, resolveAiModelInfo,
} from '../src/ai-model.js';
import { READING_DEFAULTS, validateSettings } from '../src/reading-settings.js';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { aiModelInUse, generateRewrite, generateTranslation, imageKey, listAiModels } from '../src/host/ai.js';
import { stripComments } from '../scripts/strip-comments.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

const OK_CHUNKS = [{ type: 'text-delta', text: '# 译文\n\n正文' }, { type: 'finish', reason: { kind: 'stop' } }];

describe('parseAiModel / formatAiModel', () => {
  test('空值 = 跟随默认模型', () => {
    for (const value of ['', '   ', undefined, null, 42, {}]) {
      assert.equal(parseAiModel(value), null, JSON.stringify(value));
    }
  });

  test('★ 按**第一个**斜杠切：模型 id 自己可能带斜杠', () => {
    // 按最后一个斜杠切会得到 provider=`openrouter/anthropic` —— 一个不存在的 provider。
    assert.deepEqual(parseAiModel('openrouter/anthropic/claude-sonnet-4'),
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });
    assert.deepEqual(parseAiModel('deepseek/deepseek-chat'), { provider: 'deepseek', model: 'deepseek-chat' });
  });

  test('残缺的取值解析不出来（宁可报错，别猜一个 provider 出来）', () => {
    for (const value of ['deepseek', '/model', 'provider/', 'a b/c', 'a/b c']) {
      assert.equal(parseAiModel(value), null, value);
    }
  });

  test('编解码互为逆运算', () => {
    for (const value of ['deepseek/deepseek-chat', 'openrouter/anthropic/claude-sonnet-4']) {
      assert.equal(formatAiModel(parseAiModel(value)), value);
    }
    assert.equal(formatAiModel(null), AI_MODEL_DEFAULT);
    assert.equal(formatAiModel({ provider: 'x' }), AI_MODEL_DEFAULT);
  });

  test('★ isValidAiModel 与 parseAiModel 同源（两处各写一遍会静默失配）', () => {
    const samples = ['', '   ', 'deepseek/deepseek-chat', 'openrouter/anthropic/claude', 'deepseek', '/x', 'x/', 'a b/c', 'x'.repeat(201)];
    for (const value of samples) {
      const expected = value.trim() === '' || parseAiModel(value) !== null;
      const byLength = value.length <= 200;
      assert.equal(isValidAiModel(value), expected && byLength, JSON.stringify(value));
    }
    assert.equal(isValidAiModel(42), false);
  });
});

describe('aiModelOptions / describeModelCatalog', () => {
  test('把 provider 与模型整成下拉框的形状，取值走 formatAiModel', () => {
    const options = aiModelOptions({
      providers: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }, { id: 'reasoner' }] }],
    });
    assert.deepEqual(options, [{
      id: 'deepseek',
      label: 'DeepSeek',
      models: [{ value: 'deepseek/chat', label: 'Chat' }, { value: 'deepseek/reasoner', label: 'reasoner' }],
    }]);
  });

  test('脏数据不抛错，也不造出空取值', () => {
    const options = aiModelOptions({ providers: [null, { name: '没有 id' }, { id: 'ok', models: [null, {}, { id: '' }, { id: 'real' }] }] });
    assert.deepEqual(options, [{ id: 'ok', label: 'ok', models: [{ value: 'ok/real', label: 'real' }] }]);
    assert.deepEqual(aiModelOptions(undefined), []);
    assert.deepEqual(aiModelOptions({}), []);
  });

  test('★ 三种「没得选」要说不同的话（修法完全不同）', () => {
    assert.equal(describeModelCatalog(null), '正在读取可用模型…');
    assert.match(describeModelCatalog({ providers: [] }), /还没有注册任何模型 provider/);
    assert.match(describeModelCatalog({ providers: [{ id: 'p', models: [] }] }), /API key 还没配/);
    assert.match(describeModelCatalog({ providers: [], error: 'boom' }), /读不到模型列表：boom/);
    assert.match(describeModelCatalog({ providers: [{ id: 'p', models: [{ id: 'm' }] }] }), /共 1 个模型可选/);
  });
});

describe('设置项接线', () => {
  test('默认跟随 Harness 默认模型（空串），不是某个写死的模型', () => {
    assert.equal(READING_DEFAULTS.aiModel, AI_MODEL_DEFAULT);
    assert.equal(READING_DEFAULTS.aiModel, '');
  });

  test('★ 电子书解读是**另一个**设置项，默认同样跟随默认模型', () => {
    // 两者必须是两个键：解读是「一本书几十次调用」，翻译是「一篇一次」。
    // 合成一个的话，用户没法「翻译用好模型、解读用免费模型」—— 而那正是他要的。
    assert.equal(READING_DEFAULTS.digestModel, AI_MODEL_DEFAULT);
    assert.deepEqual(validateSettings({ digestModel: 'p/m' }), { digestModel: 'p/m' });
    assert.deepEqual(validateSettings({ digestModel: '' }), { digestModel: '' });
  });

  test('validateSettings 接受合法取值、拒绝残缺取值', () => {
    assert.deepEqual(validateSettings({ aiModel: 'deepseek/deepseek-chat' }), { aiModel: 'deepseek/deepseek-chat' });
    assert.deepEqual(validateSettings({ aiModel: '' }), { aiModel: '' });
    for (const bad of ['deepseek', '/x', 'x/', 42, null, 'x'.repeat(201)]) {
      assert.throws(() => validateSettings({ aiModel: bad }), /必须形如 provider\/model/, String(bad));
    }
  });

  test('★ 两个模型设置项走**同一个**判据（错误文案里带自己的键名）', () => {
    // 判据若各写一份，改了一处就会漏另一处：症状是「设置页存下来了、宿主解析成 null」
    // ⇒ 静默回退到默认模型，而用户以为自己在用免费模型。
    for (const key of ['aiModel', 'digestModel']) {
      for (const bad of ['deepseek', '/x', 'x/', 42, null, 'x'.repeat(201)]) {
        // ★ 不加 `^` 锚点：`assert.throws` 比对的是 `String(error)`，它带着 `Error: ` 前缀。
        assert.throws(() => validateSettings({ [key]: bad }), new RegExp(`${key} 必须形如`), `${key}=${String(bad)}`);
      }
      assert.deepEqual(validateSettings({ [key]: 'p/m' }), { [key]: 'p/m' });
    }
  });
});

describe('生成时真的用了设置里那个模型', () => {
  test('★ 设置了就用它，不用默认模型', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: OK_CHUNKS });
    await generateTranslation(ctx, { title: 'T', html: '<p>x</p>' }, { model: 'free-provider/free-model' });
    assert.equal(state.llmCalls.length, 1);
    assert.equal(state.llmCalls[0].provider, 'free-provider');
    assert.equal(state.llmCalls[0].model, 'free-model');
  });

  test('★ 没设置（空串/省略）就跟随 Harness 默认模型', async () => {
    for (const options of [{ model: '' }, {}]) {
      const { ctx, state } = createFakeContext({ llmChunks: OK_CHUNKS, modelSelection: { provider: 'default-p', model: 'default-m' } });
      await generateTranslation(ctx, { title: 'T', html: '<p>x</p>' }, options);
      assert.equal(state.llmCalls[0].provider, 'default-p');
      assert.equal(state.llmCalls[0].model, 'default-m');
    }
  });

  test('★ 取值读不出来时**报错**，绝不静默回退到默认模型', async () => {
    // 静默回退的症状是「用户以为在用免费模型，其实一直在花默认模型的钱」，
    // 没有任何报错 —— 只有账单能看出来。
    const { ctx, state } = createFakeContext({ llmChunks: OK_CHUNKS });
    await assert.rejects(
      () => generateTranslation(ctx, { title: 'T', html: '<p>x</p>' }, { model: 'deepseek' }),
      /读不出来.*provider\/model/,
    );
    assert.equal(state.llmCalls.length, 0, '解析失败时不该发起任何模型调用');
  });
});

describe('插图兜底：模型丢了图片，确定性补回', () => {
  // 提示词管不住模型：长文里模型容易「顺手总结掉」图片行。生成结果要过一遍
  // 确定性核对 —— 原文有、译文没有的 URL 追加到文末。2026-10-09 用户报
  // 「原文图文并茂、译文图片全没了」，根因是模型压根没见过图（见 article-context），
  // 这一层兜底保证即便以后提示词再失效，图片也不会凭空消失。
  const IMG = 'https://example.com/diagram.png';
  const ARTICLE = { title: 'T', html: `<p>a</p><img src="${IMG}" alt="fig"><p>b</p>` };

  test('★ 译文丢了图片 → 追加到文末补回', async () => {
    const { ctx } = createFakeContext({ llmChunks: OK_CHUNKS }); // 模型输出里没有任何图片
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    assert.ok(result.markdown.includes(`![原文插图](${IMG})`), result.markdown);
    assert.ok(result.markdown.includes('---'), '补回的图要与正文分隔开');
  });

  test('译文保留了图片 → 原样通过，不追加', async () => {
    const chunks = [{ type: 'text-delta', text: `# 译文\n\n看图：\n\n![fig](${IMG})\n\n完` }, { type: 'finish', reason: { kind: 'stop' } }];
    const { ctx } = createFakeContext({ llmChunks: chunks });
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    assert.equal((result.markdown.match(/diagram\.png/g) ?? []).length, 1, result.markdown);
    assert.ok(!result.markdown.includes('原文插图'));
  });

  test('原文没有插图 → 什么都不追加', async () => {
    const { ctx } = createFakeContext({ llmChunks: OK_CHUNKS });
    const result = await generateTranslation(ctx, { title: 'T', html: '<p>x</p>' }, { model: 'p/m' });
    // 开头的 H1 归 `title`，正文里不再留一份（阅读区自己渲染标题行）。
    assert.equal(result.title, '译文');
    assert.equal(result.markdown, '正文');
  });

  test('喂给模型的上下文里带图片行（否则模型想留图也无从留起）', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: OK_CHUNKS });
    await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    const userText = state.llmCalls[0].messages.map((m) => m.content?.map((c) => c.text ?? '').join('') ?? '').join('\n');
    assert.ok(userText.includes(`![fig](${IMG})`), userText.slice(-400));
  });

  test('改写同样兜底', async () => {
    const { ctx } = createFakeContext({ llmChunks: OK_CHUNKS });
    const result = await generateRewrite(ctx, ARTICLE, { model: 'p/m' });
    assert.ok(result.markdown.includes(`![原文插图](${IMG})`), result.markdown);
  });
});

describe('插图校正：模型抄错了 URL 参数', () => {
  // 实测用户那篇 SageMaker 文章：模型把 URL 里的 `q_auto:good` 抄成了 `q_2A`
  // （前者 HTTP 200、后者 HTTP 404）。旧判据是整串 `markdown.includes(url)`，
  // **一个字符之差**就让 22 张图全部被判「缺失」—— 连模型明明写在正文里的那 11 张
  // 也一起被追加到文末。用户看到的就是「正文里一张图都没有，图片全在文末」。
  const CDN = 'https://cdn.example.com/fetch/w_1456,q_auto:good,fl_progressive:steep/img-abc123.png';
  const TYPO = 'https://cdn.example.com/fetch/w_1456,q_2A,fl_progressive:steep/img-abc123.png';
  const ARTICLE = { title: 'T', html: `<p>a</p><img src="${CDN}" alt="fig"><p>b</p>` };
  const reply = (markdown) => [{ type: 'text-delta', text: markdown }, { type: 'finish', reason: { kind: 'stop' } }];

  test('★ 按图片身份校正回原文 URL，不重复追加', async () => {
    const { ctx } = createFakeContext({ llmChunks: reply(`# 译文\n\n看图：\n\n![fig](${TYPO})\n\n完`) });
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    assert.equal((result.markdown.match(/img-abc123\.png/g) ?? []).length, 1, result.markdown);
    assert.ok(result.markdown.includes(`![fig](${CDN})`), 'URL 要换回原文那份');
    assert.ok(!result.markdown.includes('原文插图'), '已经写了的图不该再补一份到文末');
  });

  test('★ 反向对照：整串 URL 精确匹配的旧判据会把它判成「缺失」', () => {
    const naiveMissing = (markdown, urls) => urls.filter((url) => !markdown.includes(url));
    assert.deepEqual(naiveMissing(`![f](${TYPO})`, [CDN]), [CDN], '旧判据：判成缺失 ⇒ 重复追加到文末');
    assert.equal(imageKey(TYPO), imageKey(CDN), '新判据：按图片身份是同一张');
  });

  test('模型写的不是本文的图（外链、表情）→ 原样留着，本文的图照旧补齐', async () => {
    const { ctx } = createFakeContext({ llmChunks: reply('# 译文\n\n![表情](https://cdn.example.com/emoji.png)\n\n正文') });
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    assert.ok(result.markdown.includes('https://cdn.example.com/emoji.png'), '外链不许被改掉');
    assert.ok(result.markdown.includes(`![原文插图](${CDN})`), '本文那张仍然要补');
  });

  test('imageKey：query 与 hash 不参与身份（同一张图的转换参数本来就会变）', () => {
    assert.equal(imageKey('https://e/a.png?w=100'), imageKey('https://e/a.png?w=900'));
    assert.equal(imageKey('https://e/a.png#x'), 'a.png');
    assert.equal(imageKey(''), '');
    assert.equal(imageKey(undefined), '');
  });

  test('imageKey：编码口径与 articleImages 对齐（否则带空格的 URL 会算成两张）', () => {
    assert.equal(imageKey('https://e/a b(1).png'), imageKey('https://e/a%20b%281%29.png'));
  });
});

describe('链接还原：占位符换回真 URL', () => {
  // 2026-10-13：译文里所有链接都退化成纯文本（原文有橙色链接、译文没有）。
  // 修法是让 URL **完全不经过模型** —— 正文里放 `[文字]({{L0}})` 占位符，
  // 生成之后由 `restoreLinks` 换回真 URL。理由见 `sanitize.js` 的 `htmlToText`。
  const LINKED = { title: 'T', html: '<p>看 <a href="https://e.org/a?x=1&amp;y=2">这个</a></p>' };
  const reply = (markdown) => [{ type: 'text-delta', text: markdown }, { type: 'finish', reason: { kind: 'stop' } }];

  test('★ 喂给模型的正文里是**占位符**，真 URL 一次都不出现', async () => {
    const { ctx, state } = createFakeContext({ llmChunks: OK_CHUNKS });
    await generateTranslation(ctx, LINKED, { model: 'p/m' });
    const userText = state.llmCalls[0].messages
      .map((m) => m.content?.map((c) => c.text ?? '').join('') ?? '').join('\n');
    assert.ok(userText.includes('[这个]({{L0}})'), userText.slice(-300));
    assert.ok(!userText.includes('https://e.org/a?x=1'), '真 URL 不该出现在提示词里');
  });

  test('★ 模型原样保留占位符 → 译文里是**真链接**（去掉 restoreLinks 这一步这条会红）', async () => {
    const { ctx } = createFakeContext({ llmChunks: reply('# 译文\n\n看 [这个]({{L0}})') });
    const result = await generateTranslation(ctx, LINKED, { model: 'p/m' });
    assert.ok(result.markdown.includes('[这个](https://e.org/a?x=1&y=2)'), result.markdown);
    assert.ok(!result.markdown.includes('{{'), '不该有占位符残留');
  });

  test('★ 模型把占位符弄丢了 → 链接退化成纯文本，但绝不写出一个假链接', async () => {
    const { ctx } = createFakeContext({ llmChunks: reply('# 译文\n\n看 这个') });
    const result = await generateTranslation(ctx, LINKED, { model: 'p/m' });
    assert.equal(result.markdown, '看 这个');
  });
});

describe('去掉正文开头那个 H1', () => {
  // 提示词要求模型「第一行输出 `# <中文标题>`」，那是为了 `titleFromMarkdown` 抽得到
  // 标题。但阅读区**自己会渲染标题行**（`readerTitle`），两处都留就是
  // 「译文视图里标题出现两次」—— 实测用户截图：英文原标题一行、中文 H1 又一行。
  const reply = (markdown) => [{ type: 'text-delta', text: markdown }, { type: 'finish', reason: { kind: 'stop' } }];
  const ARTICLE = { title: 'T', html: '<p>x</p>' };

  test('★ 标题进 title，正文里不再重复', async () => {
    const { ctx } = createFakeContext({ llmChunks: reply('# 中文标题\n\n正文第一段\n\n正文第二段') });
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    assert.equal(result.title, '中文标题');
    assert.equal(result.markdown, '正文第一段\n\n正文第二段');
  });

  test('★ 正文里的其它标题不动（只去开头那一个）', async () => {
    const { ctx } = createFakeContext({ llmChunks: reply('# 大标题\n\n## 小节\n\n正文') });
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    assert.equal(result.markdown, '## 小节\n\n正文');
  });

  test('★ 整篇只有一个标题时不清空正文（宁可重复，也不要给一篇空白）', async () => {
    const { ctx } = createFakeContext({ llmChunks: reply('# 只有标题') });
    const result = await generateTranslation(ctx, ARTICLE, { model: 'p/m' });
    assert.equal(result.markdown, '# 只有标题');
  });
});

/**
 * 「这次实际会用哪个模型」—— 阅读页那两处字样（自动翻译的状态条、缺内容时的
 * 「生成」按钮）显示的就是它。
 *
 * ★ 这一组守的是「**不说确定的假话**」：
 *   界面上一旦写着某个模型名，用户就会当成事实。所以两件事都要钉死：
 *   - 显示的那个名字，必须**等于**这次真会调用的 provider · model（不是「默认模型」四个字）；
 *   - 拿不到名字时，退回**不含模型名**的说法，绝不编一个出来、也绝不把
 *     「设置里的值读不出来」说成「跟随 Harness 默认模型」。
 */
describe('effectiveModelLabel / resolveAiModelInfo', () => {
  const DEFAULT_SELECTION = { provider: 'ling', model: 'Ling-3.1-flash' };
  const neverAsked = () => { throw new Error('设置里指定了模型时，不该去问默认模型'); };

  test('设置里指定了模型 → 显示它，且根本不去问默认模型', () => {
    const info = resolveAiModelInfo('agnes-ai/agnes-2.5-flash', neverAsked);
    assert.equal(info.source, AI_MODEL_SOURCE.SETTINGS);
    assert.deepEqual(info.model, { provider: 'agnes-ai', model: 'agnes-2.5-flash' });
    assert.equal(effectiveModelLabel(info), 'agnes-ai · agnes-2.5-flash');
  });

  test('设置留空 → 显示问到的 Harness 默认模型名', () => {
    const info = resolveAiModelInfo('', () => DEFAULT_SELECTION);
    assert.equal(info.source, AI_MODEL_SOURCE.DEFAULT);
    assert.equal(effectiveModelLabel(info), 'ling · Ling-3.1-flash');
  });

  test('★ 问不到默认模型时退回「Harness 默认模型」，绝不编一个名字出来', () => {
    const info = resolveAiModelInfo('', () => { throw new Error('no agentDefaultModel service'); });
    assert.equal(info.source, AI_MODEL_SOURCE.UNAVAILABLE);
    assert.equal(info.model, null);
    const label = effectiveModelLabel(info);
    assert.equal(label, 'Harness 默认模型');
    assert.doesNotMatch(label, /·/, '拿不到模型时不许出现「provider · model」的形状');
  });

  test('★ 默认模型给的是半截选择（缺 model）→ 也算取不到，不显示半截名字', () => {
    // 默认模型那边给出 `{provider:'ling'}` 时，如果原样显示会得到「ling · undefined」——
    // 一个**看起来像模型名**的东西。所以绕一圈 `formatAiModel` 把它判成取不到。
    for (const half of [{ provider: 'ling' }, { model: 'Ling-3.1-flash' }, {}, null]) {
      const info = resolveAiModelInfo('', () => half);
      assert.equal(info.source, AI_MODEL_SOURCE.UNAVAILABLE, JSON.stringify(half));
      assert.equal(info.model, null, JSON.stringify(half));
      assert.equal(effectiveModelLabel(info), 'Harness 默认模型');
    }
  });

  test('★ 设置里的值读不出来 → 说「AI 模型」，**不能**说「Harness 默认模型」', () => {
    // 这个状态生成会**报错**（`selectionFor` 会抛），不是回退到默认模型。
    // 在这里说「Harness 默认模型」是一句确定的假话：用户会以为「反正能跑」。
    const info = resolveAiModelInfo('deepseek', () => DEFAULT_SELECTION);
    assert.equal(info.source, AI_MODEL_SOURCE.INVALID);
    assert.equal(info.model, null);
    const label = effectiveModelLabel(info);
    assert.equal(label, 'AI 模型');
    assert.doesNotMatch(label, /Harness/, '读不出来的取值不是「跟随默认」');
    assert.doesNotMatch(label, /·/);
  });

  test('拿不到 info（还在读 / 读失败）→ 兜底说法，且不含模型名', () => {
    for (const value of [null, undefined, {}, 'boom', 42]) {
      const label = effectiveModelLabel(value);
      assert.equal(label, 'AI 模型', JSON.stringify(value));
      assert.doesNotMatch(label, /·/, JSON.stringify(value));
    }
  });

  test('非字符串取值与空白串同判（与 selectionFor 同源）', () => {
    for (const value of ['', '   ', undefined, null, 42, {}]) {
      const info = resolveAiModelInfo(value, () => DEFAULT_SELECTION);
      assert.equal(info.source, AI_MODEL_SOURCE.DEFAULT, JSON.stringify(value));
      assert.equal(info.value, '', '归一之后的取值是空串 —— 它就是「跟随默认」的意思');
    }
  });
});

/**
 * ★ 这一组是上面那组的**牙齿**。
 *
 * 上面那些用例只能证明「文案长得对」；这一组拿**真的调用记录**来比：
 * 界面要显示的那个名字，必须与这次生成真的发给 `ctx.llm` 的 provider / model 一致。
 * 两处各写一遍判据（界面用一套、生成用另一套）时，这一组会红，而上面那组全绿。
 */
describe('★ 界面上的模型名 === 生成时真用的那个模型', () => {
  const SELECTION = { provider: 'default-p', model: 'default-m' };
  const CASES = [
    ['设置里指定了模型', 'free-provider/free-model'],
    ['设置留空，跟随默认', ''],
  ];

  for (const [label, value] of CASES) {
    test(`${label}：标签 === 实际调用的 provider · model`, async () => {
      const { ctx, state } = createFakeContext({ llmChunks: OK_CHUNKS, modelSelection: SELECTION });
      await generateTranslation(ctx, { title: 'T', html: '<p>x</p>' }, { model: value });
      assert.equal(state.llmCalls.length, 1);
      const used = state.llmCalls[0];
      const shown = effectiveModelLabel(aiModelInUse(ctx, value));
      assert.equal(shown, `${used.provider} · ${used.model}`);
    });
  }

  test('两种取值显示的是**不同**的模型（不是都退回默认）', () => {
    const { ctx } = createFakeContext({ modelSelection: SELECTION });
    const whenSet = effectiveModelLabel(aiModelInUse(ctx, 'free-provider/free-model'));
    const whenEmpty = effectiveModelLabel(aiModelInUse(ctx, ''));
    assert.notEqual(whenSet, whenEmpty);
    assert.equal(whenSet, 'free-provider · free-model');
    assert.equal(whenEmpty, 'default-p · default-m');
  });
});

describe('listAiModels', () => {
  test('列出 provider 与模型，并带上 Harness 当前默认模型', async () => {
    const { ctx } = createFakeContext({ modelSelection: { provider: 'test-provider', model: 'test-model' } });
    const result = await listAiModels(ctx);
    assert.deepEqual(result.current, { provider: 'test-provider', model: 'test-model' });
    assert.deepEqual(aiModelOptions(result), [{ id: 'test-provider', label: 'Test Provider', models: [{ value: 'test-provider/test-model', label: 'Test Model' }] }]);
  });

  test('★ 单个 provider 报错不拖垮整张列表（否则用户会得到一个空下拉框）', async () => {
    const { ctx } = createFakeContext({
      modelCatalog: { providers: [{ id: 'broken', name: 'Broken', error: 'API key 没配' }, { id: 'fine', name: 'Fine', models: [{ id: 'm' }] }] },
    });
    const result = await listAiModels(ctx);
    const options = aiModelOptions(result);
    assert.equal(options.length, 2);
    assert.equal(options[0].error, 'API key 没配');
    assert.equal(options[0].models.length, 0);
    assert.deepEqual(options[1].models, [{ value: 'fine/m', label: 'm' }]);
    assert.match(describeModelCatalog(result), /共 1 个模型可选/);
  });

  test('没有 llm 服务时如实返回空，不抛错（设置页要能渲染）', async () => {
    const result = await listAiModels({ get: () => undefined });
    assert.deepEqual(result.providers, []);
    assert.equal(result.error, 'no llm service');
  });
});

describe('接线：所有生成入口都从同一个地方取模型', () => {
  const host = readFileSync(join(pluginRoot, 'src', 'host', 'service.js'), 'utf8');
  const client = readFileSync(join(pluginRoot, 'src', 'client', 'SettingsPage.jsx'), 'utf8');
  const reader = readFileSync(join(pluginRoot, 'src', 'client', 'ReaderPage.jsx'), 'utf8');

  test('★ 宿主里没有第二处直接调 agentDefaultModel 的生成路径', () => {
    // 漏掉一处就会出现「英文自动翻译走免费模型、手动点『生成』走默认模型」
    // 这种自相矛盾的行为，而两处各自的代码看起来都对。
    assert.match(host, /aiModel\(\)\s*\{[\s\S]*?settings\.aiModel/, '缺少统一的取值方法');
    assert.equal((host.match(/generateStructuredTranslation\(|generateRewrite\(/g) ?? []).length, 2, '生成入口应该只有一处分支');
    // ★ 旧 Markdown 翻译路径不该还在 service.js 里被调用 —— 两条并存就会出现
    //   「有的文章走新路径、有的走旧路径」，而两边各自看起来都对。
    assert.ok(!/generateTranslation\(/.test(host), 'service.js 里不该再调旧的 generateTranslation');
    assert.match(host, /\{ model: this\.aiModel\(\) \}/, '生成时没有把设置传下去');
  });

  test('设置页有下拉框，且读的是宿主的模型目录', () => {
    assert.match(client, /api\.listAiModels\(\)/);
    assert.match(client, /describeModelCatalog\(aiModels\)/);
    assert.match(client, /className="npr-ai-model"/);
    assert.match(client, /change\(\{ aiModel: event\.target\.value \}\)/);
  });

  test('★ 电子书解读那个模型也有自己的下拉框，且写的是 digestModel', () => {
    // 面板里那个下拉框写回的是**同一个**设置项（`digestModel`），否则「在阅读器里
    // 换的模型」和「设置页里看到的模型」会各说一套。
    assert.match(client, /change\(\{ digestModel: event\.target\.value \}\)/);
    const panel = readFileSync(join(pluginRoot, 'src', 'client', 'BookDigestPanel.jsx'), 'utf8');
    assert.match(panel, /onModelChange\?\.\(event\.target\.value\)/, '目录面板的模型下拉框没有接上');
    assert.match(panel, /aiModelOptions\(modelCatalog\)/, '目录面板没有用同一份模型目录判据');
    // 宿主侧：解读入口必须能从设置里取到它，且不再复用翻译那个。
    assert.match(host, /digestModel\(\)\s*\{[\s\S]*?settings\.digestModel/, '宿主没有 digestModel() 取值方法');
    assert.match(host, /\{ model: modelValue, signal \}/, '解读生成没有把选中的模型传下去');
  });

  test('★ 已保存的取值不在列表里时必须说出来（否则 select 会静默跳回第一项）', () => {
    assert.match(client, /missingModels/);
    assert.match(client, /不在当前读到的模型列表里/);
  });

  test('★ 阅读页两处字样用的是宿主报回来的真实模型名', () => {
    // ★ 这是**源码字符串**断言：它只能证明「接了线」，答不了「跑起来对不对」。
    //   真正会跑的那一半（取值 + 文案 + 与生成路径同源）在上面
    //   `effectiveModelLabel` / `aiModelInUse` 的用例里；而「方法名有没有接错」
    //   由 `test/service.test.mjs` 的跨半区契约用例兜住（那里比对宿主导出的
    //   方法集与客户端 descriptor，两半区差一个就红）。
    const code = stripComments(reader); // 注释里抄着旧文案，不算「还在用」
    assert.match(code, /api\.aiModelInfo\(\)/, '阅读页没有去问「这次实际用哪个模型」');
    assert.match(code, /effectiveModelLabel\(modelInfo\)/, '阅读页没有用共用判据生成文案');
    assert.doesNotMatch(code, /Harness 默认模型/,
      '阅读页里不该再出现这个词 —— 设置里指定了模型时它说的是假话');
    assert.match(code, /正在用\s*\{modelLabel\}\s*翻译成中文/, '自动翻译的状态条没改');
    assert.match(code, /`用 \$\{modelLabel\} 生成`/, '「生成」按钮没改');
  });

  test('★ 设置变更时同步重读模型名（否则改完模型要重开面板才刷新）', () => {
    // 阅读页里开着设置弹窗，改完模型按保存 ⇒ 那两处字样必须当场改口。
    // 只重读 `reading` 的话界面会继续显示**上一个**模型，而那是确定的话。
    const reload = /const reload = \(\) => \{([^}]*)\}/.exec(reader);
    assert.ok(reload, '找不到设置变更事件里的 reload');
    assert.match(reload[1], /readReading\(\)/, 'reload 没有重读阅读设置');
    assert.match(reload[1], /readModelInfo\(\)/, 'reload 没有重读模型名 —— 改完模型要重开面板才刷新');
  });
});
