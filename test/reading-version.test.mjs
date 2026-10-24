import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveReadingVersion, shouldAutoTranslate } from '../src/client/reading-version.js';

const article = (html, translation, rewrite) => ({
  html,
  versions: {
    translation: { available: Boolean(translation), markdown: translation },
    rewrite: { available: Boolean(rewrite), markdown: rewrite },
  },
});

describe('resolveReadingVersion', () => {
  it('falls back to the original when the preferred version is missing', () => {
    assert.equal(resolveReadingVersion('rewrite', article('<p>Original</p>', '', '')), 'original');
    assert.equal(resolveReadingVersion('rewrite', article('', '', '')), 'original');
  });

  it('uses the next available version before giving up', () => {
    assert.equal(resolveReadingVersion('rewrite', article('<p>Original</p>', '译文', '')), 'translation');
    assert.equal(resolveReadingVersion('translation', article('<p>Original</p>', '', '改写')), 'rewrite');
  });

  it('keeps the preferred version when it is present', () => {
    assert.equal(resolveReadingVersion('rewrite', article('<p>Original</p>', '译文', '改写')), 'rewrite');
  });

  it('treats whitespace-only content as missing', () => {
    assert.equal(resolveReadingVersion('rewrite', article('<p>Original</p>', '', '  ')), 'original');
    assert.equal(resolveReadingVersion('rewrite', article('   ', '', '改写')), 'rewrite');
  });

  it('ignores a stored version name the reader no longer knows', () => {
    // localStorage 里可能残留旧版本的取值；不能因此把页面卡在空白态。
    assert.equal(resolveReadingVersion('unknown', article('<p>Original</p>', '', '')), 'original');
    assert.equal(resolveReadingVersion(undefined, article('<p>Original</p>', '', '改写')), 'rewrite');
    assert.equal(resolveReadingVersion(null, article('', '译文', '')), 'translation');
  });

  it('requires versions[].available, not just non-empty markdown', () => {
    // 只带 markdown 但没有 available 标记的版本视为不可读，避免渲染出半截内容。
    assert.equal(resolveReadingVersion('rewrite', {
      html: '<p>Original</p>',
      versions: { rewrite: { markdown: '改写' } },
    }), 'original');
  });
});

describe('shouldAutoTranslate', () => {
  /** 一篇「该被自动翻译」的英文文章 —— 所有反向对照都只改它一个字段。 */
  const english = {
    article: { language: 'en' },
    html: '<p>Hello world</p>',
    versions: { translation: { available: false } },
  };
  const on = { autoTranslate: true };

  it('四项都满足 ⇒ 翻', () => {
    assert.equal(shouldAutoTranslate(on, english), true);
  });

  it('★ 开关关着 ⇒ 不翻（默认值就是关的，因为是计费行为）', () => {
    assert.equal(shouldAutoTranslate({ autoTranslate: false }, english), false);
    assert.equal(shouldAutoTranslate({}, english), false);
    assert.equal(shouldAutoTranslate(undefined, english), false);
    // 反向对照：只有真的 `true` 才算开，别把字符串/数字当真值收下。
    assert.equal(shouldAutoTranslate({ autoTranslate: 'true' }, english), false);
    assert.equal(shouldAutoTranslate({ autoTranslate: 1 }, english), false);
  });

  it('★ 语种不是 en ⇒ 不翻（中文不必翻、日文不能当英文直译）', () => {
    for (const language of ['zh', 'other', 'unknown', undefined]) {
      assert.equal(shouldAutoTranslate(on, { ...english, article: { language } }), false, `language=${language} 不该触发翻译`);
    }
  });

  it('★ 已经有中文版本 ⇒ 不重翻（别把订阅源自带的译文覆盖掉）', () => {
    assert.equal(shouldAutoTranslate(on, { ...english, versions: { translation: { available: true, markdown: '译文' } } }), false);
  });

  it('★ 原文没有正文 ⇒ 不翻（生成出来只会是一篇空转的译文）', () => {
    assert.equal(shouldAutoTranslate(on, { ...english, html: '' }), false);
    assert.equal(shouldAutoTranslate(on, { ...english, html: '   ' }), false);
    assert.equal(shouldAutoTranslate(on, { ...english, html: undefined }), false);
  });

  it('缺字段一律不翻，且不抛错（页面刚挂载时 payload 可能还不完整）', () => {
    assert.equal(shouldAutoTranslate(on, undefined), false);
    assert.equal(shouldAutoTranslate(on, {}), false);
    assert.equal(shouldAutoTranslate(on, { article: {} }), false);
  });
});

describe('接线：自动翻译真的被接上去了', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const clientDir = join(here, '..', 'src', 'client');
  const reader = readFileSync(join(clientDir, 'ReaderPage.jsx'), 'utf8');
  const settings = readFileSync(join(clientDir, 'SettingsPage.jsx'), 'utf8');
  const host = readFileSync(join(here, '..', 'src', 'host', 'service.js'), 'utf8');

  it('ReaderPage 用共用判据决定要不要翻，并且真的调了生成', () => {
    assert.match(reader, /shouldAutoTranslate\(/, 'ReaderPage 没有用共用判据');
    assert.match(reader, /api\.generateVersion\(key, 'translation'\)/, 'ReaderPage 没有真的去生成译文');
  });

  it('★ ReaderPage 读的是 readingRef，不是首渲染闭包里的 reading', () => {
    // 「恢复上次阅读位置」那个 effect 依赖是 []，它拿到的是首渲染的 openArticle。
    // 直接读 state 的话，开着开关重启应用、恢复到上次那篇英文文章时翻译不触发，
    // 而且没有任何报错 —— 开关看着是开的。
    assert.match(reader, /shouldAutoTranslate\(readingRef\.current, data\)/);
    assert.doesNotMatch(reader, /shouldAutoTranslate\(reading, data\)/);
    assert.match(reader, /const readingRef = useRef\(reading\)/, '缺少 readingRef 镜像');
  });

  it('设置页有开关，且默认不是「开」', () => {
    assert.match(settings, /autoTranslate: event\.target\.checked/);
    assert.match(settings, /checked=\{settings\.autoTranslate === true\}/);
    const defaults = readFileSync(join(here, '..', 'src', 'reading-settings.js'), 'utf8');
    assert.match(defaults, /autoTranslate: false/, '默认必须是关的 —— 开了就是替用户花模型的钱');
  });

  it('★ 宿主给文章打上 language（客户端只读结论，不自己再判一遍）', () => {
    assert.match(host, /language: articleLanguage\(article\)/);
    assert.match(host, /from '\.\.\/language\.js'/);
  });
});
