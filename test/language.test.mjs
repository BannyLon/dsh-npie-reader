/**
 * 原文语种判定。
 *
 * ★ 这一组用例真正要守的不是「算法准不准」，而是**两个方向都不能出错**：
 *
 *   - 把中文判成英文 ⇒ 每次打开中文文章都自动调一次模型翻译，白花钱、还慢。
 *     最容易漏的反例是**中文文章里夹英文术语 / 代码 / 大量 HTML 标签**。
 *   - 把日文判成英文 ⇒ 拿日文当英文直译成中文，产出一篇读起来像机器坏了的文章。
 *
 * ★ 还有一个「宁可不动」的方向：样本太短就返回 `unknown`。短标题（`Hello`）
 *   不足以判语种，硬判等于让界面凭一个词就替用户决定花不花模型的钱。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CJK_RATIO_THRESHOLD, LEAD_CHARS, MIN_SAMPLE, articleLanguage, detectLanguage, stripMarkup } from '../src/language.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..');

/** 造一段够长的英文正文（超过 MIN_SAMPLE）。 */
const EN_BODY = 'DeepSeek released a new harness that lets third-party plugins register agent tools. '
  + 'The plugin exposes a manifest, and the host resolves it at activation time. '
  + 'Everything runs locally, and the reader caches the generated Chinese version on disk.';

/** 造一段够长的中文正文。 */
const ZH_BODY = '这篇文章讨论的是第三方插件如何向宿主注册 agent 工具。插件先声明清单，宿主在激活阶段解析它。'
  + '整条链路都在本机运行，阅读器会把生成好的中文版本缓存在磁盘上，下次打开就不用再调一次模型。';

describe('stripMarkup', () => {
  test('剥掉标签、script 与 style，留下可读文本', () => {
    assert.equal(stripMarkup('<p>你好</p>').trim(), '你好');
    assert.equal(stripMarkup('<script>var a = 1;</script>正文').trim(), '正文');
    assert.equal(stripMarkup('<style>.a{color:red}</style>正文').trim(), '正文');
    assert.equal(stripMarkup('<!-- 注释 -->正文').trim(), '正文');
  });
});

describe('detectLanguage', () => {
  test('纯英文 ⇒ en；纯中文 ⇒ zh', () => {
    assert.equal(detectLanguage(EN_BODY), 'en');
    assert.equal(detectLanguage(ZH_BODY), 'zh');
  });

  test('★ 反向对照：中文文章里夹英文术语、代码与 URL，仍然是 zh', () => {
    // 这是最容易判错的一类：术语与代码全是拉丁字母。
    const mixed = `${ZH_BODY} 例如 useEffect、npm install、JSON.stringify 这些写法，`
      + '以及 https://github.com/deepseek-ai/dsh 这个仓库地址，都不该让整篇被判成英文。'
      + '再补一句：RNN、LSTM、Transformer、Attention、Token、Prompt、Agent、Tool、Manifest。';
    assert.equal(detectLanguage(mixed), 'zh');
  });

  test('★ 反向对照：中文正文包在大量 HTML 标签里，仍然是 zh', () => {
    // 标签名与属性全是拉丁字母，不剥标签就会把中文文章判成英文 ——
    // 后果是每次打开都自动调一次模型翻译。
    const html = `<div class="article-wrapper"><article class="post"><h1>标题</h1><p>${ZH_BODY}</p>`
      + '<p><a href="https://example.com/very/long/path" target="_blank" rel="noopener noreferrer">链接</a></p>'
      + '<figure><img src="https://cdn.example.com/a/b/c.png" alt="illustration" width="1200" height="630" /></figure>'
      + '</article></div>';
    assert.equal(detectLanguage(html), 'zh');
  });

  test('★ 反向对照：日文不当英文（拿日文直译成中文会产出坏文章）', () => {
    const ja = 'この記事では、サードパーティのプラグインがどのようにしてホストにエージェントツールを登録するのかを説明します。'
      + 'プラグインはまずマニフェストを宣言し、ホストは起動時にそれを解決します。すべてローカルで動作します。';
    assert.equal(detectLanguage(ja), 'other');
    // 韩文同理。
    assert.equal(detectLanguage('이 글에서는 서드파티 플러그인이 호스트에 에이전트 도구를 등록하는 방법을 설명합니다. '
      + '플러그인은 먼저 매니페스트를 선언하고 호스트는 활성화 단계에서 이를 해석합니다.'), 'other');
  });

  test('★ 样本太短 ⇒ unknown，不猜（别凭一个词就替用户决定花模型的钱）', () => {
    assert.equal(detectLanguage('Hello'), 'unknown');
    assert.equal(detectLanguage('RSS 更新'), 'unknown');
    assert.equal(detectLanguage(''), 'unknown');
    assert.equal(detectLanguage(undefined), 'unknown');
    assert.equal(detectLanguage(null), 'unknown');
    // 边界：刚好差一个字符就该是 unknown。
    assert.equal(detectLanguage('a'.repeat(MIN_SAMPLE - 1)), 'unknown');
    assert.equal(detectLanguage('a'.repeat(MIN_SAMPLE)), 'en');
  });

  test('汉字占比的边界按阈值判（不靠「看着像」）', () => {
    // 阈值本身是常量，用例跟着常量走，免得改了阈值用例静默失配。
    const latin = 'a'.repeat(100);
    const cjkAtThreshold = '汉'.repeat(Math.round(100 * CJK_RATIO_THRESHOLD / (1 - CJK_RATIO_THRESHOLD)));
    assert.equal(detectLanguage(latin + cjkAtThreshold), 'zh');
    assert.equal(detectLanguage(latin + '汉'.repeat(1)), 'en');
  });
});

describe('articleLanguage', () => {
  test('标题太短时靠正文定论', () => {
    assert.equal(articleLanguage({ title: 'DeepSeek V3', html: `<p>${EN_BODY}</p>` }), 'en');
    assert.equal(articleLanguage({ title: '插件注册', html: `<p>${ZH_BODY}</p>` }), 'zh');
  });

  test('★ 不看 titleZh：原文是英文、源另给了中文标题 ⇒ 仍判 en', () => {
    // 这类文章恰恰最需要自动翻译；把 titleZh 算进样本会把它拉向 zh。
    const article = { title: 'How plugins register agent tools', titleZh: '插件如何注册 agent 工具', html: `<p>${EN_BODY}</p>` };
    assert.equal(articleLanguage(article), 'en');
  });

  test('没有文章 / 没有正文 ⇒ unknown', () => {
    assert.equal(articleLanguage(null), 'unknown');
    assert.equal(articleLanguage(undefined), 'unknown');
    assert.equal(articleLanguage({ title: 'Hello' }), 'unknown');
  });
});

describe('两端共用同一份判据', () => {
  test('★ 宿主与客户端都不许自己再写一遍阈值', () => {
    // 各写一遍 ⇒ 「界面说英文、工具说中文」，而两边单测都是绿的。
    const host = readFileSync(join(pluginRoot, 'src', 'host', 'service.js'), 'utf8');
    assert.match(host, /from '\.\.\/language\.js'/, '宿主没有用共用判据');
    // 反向对照：宿主里不该出现自己算占比的痕迹。
    assert.doesNotMatch(host, /CJK_RATIO_THRESHOLD|\\u4e00-\\u9fff/, '宿主自己又写了一遍语种判据');
  });
});

/**
 * ★ 这一组是**真机上出过的事**：打开一篇中文文章，界面却说「原文是英文，
 *   正在用 xxx 翻译成中文…」，并且真的去调了模型。
 *
 *   形状是「开头一篇中文精读 + 后面附整篇英文播客逐字稿」。整篇算下来汉字占比
 *   只有 8.5%（正文被截到 20 万字符），低于阈值 ⇒ 判 en。而读者先读到的是中文。
 */
describe('★ 只看开头读到的部分（LEAD_CHARS）', () => {
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
  const LATIN_RE = /[A-Za-z]/g;
  const ratio = (text) => {
    const cjk = (text.match(CJK_RE) ?? []).length;
    const latin = (text.match(LATIN_RE) ?? []).length;
    return cjk + latin === 0 ? 0 : cjk / (cjk + latin);
  };

  test('中文精读 + 后面附整篇英文逐字稿 ⇒ zh（真机复现）', () => {
    const digest = `<p>${ZH_BODY}</p>`.repeat(6);
    const transcript = `<p>${EN_BODY}</p>`.repeat(40);
    const html = `<article>${digest}${transcript}</article>`;
    // ★ 先把「整篇算下来确实是英文占优」证出来 —— 不然这条用例证明不了任何事，
    //   旧判据在这份输入上本来就是 en，断言 zh 才有意义。
    assert.ok(
      ratio(stripMarkup(html)) < CJK_RATIO_THRESHOLD,
      `整篇汉字占比 ${ratio(stripMarkup(html)).toFixed(3)} 应低于阈值 ${CJK_RATIO_THRESHOLD}`,
    );
    // 读者先读到的是中文 ⇒ 判 zh，不该自动翻译、更不该说「原文是英文」。
    assert.equal(detectLanguage(html), 'zh');
  });

  test('反向对照：真英文长文不会被判成中文', () => {
    const article = { title: 'Norman Ohler: Hitler, Nazis, Drugs, WWII', html: `<p>${EN_BODY}</p>`.repeat(30) };
    assert.equal(articleLanguage(article), 'en');
  });

  test('窗口之外的内容不参与判定（前 2000 字符是拉丁字母、后面全是汉字 ⇒ en）', () => {
    // 去掉截断这条就会变 zh —— 这条用例专门盯「窗口真的生效了」。
    assert.equal(detectLanguage('a'.repeat(LEAD_CHARS) + '汉'.repeat(5000)), 'en');
  });

  test('有意的取舍：开头整段英文、中文在后 ⇒ 仍判 en（宁可多翻一次，也别对中文文章说它是英文）', () => {
    const html = `<p>${EN_BODY}</p>`.repeat(20) + `<p>${ZH_BODY}</p>`.repeat(20);
    assert.equal(detectLanguage(html), 'en');
  });

  test('短文章（不足一个窗口）行为不变', () => {
    assert.equal(detectLanguage(`<p>${ZH_BODY}</p>`), 'zh');
    assert.equal(detectLanguage(`<p>${EN_BODY}</p>`), 'en');
  });
});
