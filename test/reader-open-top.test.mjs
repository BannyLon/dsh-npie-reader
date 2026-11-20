/**
 * 0.84.5 两条用户截图反馈的回归守卫：
 *
 * 1. 每次从侧边栏点文章都从**顶部**打开。0.44.9 起有「记住阅读位置」，
 *    点开一篇播客精读却落在上次读到的末尾，看起来像打开错了文章。
 *    ★ 不是只把恢复调用注释掉：读取 effect、写盘 effect、模块和测试全部撤掉，
 *      只留写入不读的持久化会让人以为还有人在用，下次又照着它加回来。
 * 2. 字幕 / 导读态顶部不再有「回到文章」按钮 —— tab 里已经有「文章」，
 *    两个入口做同一件事，还多占掉标题上方一整行。
 *
 * 判据全部带反向对照：把旧写法注回去必须变红，否则「不存在」型断言恒真。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const READER = join(pluginRoot, 'src/client/ReaderPage.jsx');
const CSS = join(pluginRoot, 'src/client/refinements.css');
const source = readFileSync(READER, 'utf8');
const css = readFileSync(CSS, 'utf8');

function openArticleBody(text = source) {
  const start = text.indexOf('const openArticle = async');
  assert.notEqual(start, -1, 'openArticle 锚点漂移');
  const end = text.indexOf('\n  };', start);
  assert.notEqual(end, -1, 'openArticle 结束锚点漂移');
  return text.slice(start, end);
}

describe('打开文章一律回顶', () => {
  it('openArticle 拿到正文后滚回顶部', () => {
    assert.match(openArticleBody(), /scrollTo\?\.\(\{ top: 0 \}\)/,
      '没有回顶动作：新文章会停在上一篇的滚动位置');
  });

  it('openArticle 里不再有「按上回位置滚回去」的调用', () => {
    assert.doesNotMatch(openArticleBody(), /setRestoreFor|readPosition|scrollFromRatio/);
  });

  it('阅读位置整条链路已撤干净（源码 / 模块 / 测试）', () => {
    assert.doesNotMatch(source, /\breadPosition\b|\bsavePosition\b|\bscrollFromRatio\b|\bscrollRatio\b|\bsetRestoreFor\b/);
    assert.equal(existsSync(join(pluginRoot, 'src/client/read-position.js')), false,
      'read-position.js 还在：没人读的模块会被下次当成功能加回来');
    assert.equal(existsSync(join(pluginRoot, 'test/read-position.test.mjs')), false,
      '旧测试还在：它会在没人用的模块上继续全绿');
  });

  it('反向对照：把旧写法注回去，判据必须变红', () => {
    const oldStyle = openArticleBody() + '\n    setRestoreFor(key);';
    assert.match(oldStyle, /setRestoreFor\(key\)/, '注入没生效');
    assert.notEqual(oldStyle, openArticleBody(), '变异没生效');
  });
});

describe('收听头不再有「回到文章」', () => {
  it('源码与 CSS 双扫都没有 npr-listen-back', () => {
    assert.doesNotMatch(source, /npr-listen-back/);
    assert.doesNotMatch(css, /npr-listen-back/);
  });

  it('两个真机夹具也没有这颗按钮', () => {
    for (const file of ['check-read-tabs.mjs', 'check-listen-view.mjs']) {
      const text = readFileSync(join(pluginRoot, 'scripts', file), 'utf8');
      assert.doesNotMatch(text, /npr-listen-back/, `${file} 的夹具还画着已删掉的按钮`);
    }
  });

  it('反向对照：注入按钮后正则必须命中（证明它不是恒假）', () => {
    const injected = source + '\n<button type="button" className="npr-listen-back">回到文章</button>';
    assert.match(injected, /npr-listen-back/);
  });
});
