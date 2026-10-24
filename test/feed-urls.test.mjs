/**
 * 粘贴订阅地址的切分单测。
 *
 * 这块的失败模式是**静默的**：一次粘 20 个地址，切错一个就少订一个，
 * 界面上只会显示「将订阅 19 个地址」，用户根本不知道少了哪个。
 * 所以每个判据都配了反向对照 —— 尤其是「忽略了多少行」这个计数，
 * 它既是给用户看的说明，也是「我没悄悄丢掉东西」的唯一凭据。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { httpFeedUrls, parseFeedUrls } from '../src/client/feed-urls.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'src', 'client');

describe('parseFeedUrls 切分', () => {
  test('一行一个地址（用户最常用的粘贴方式）', () => {
    const text = ['https://a.example/feed.xml', 'https://b.example/atom.xml', 'https://c.example/rss'].join('\n');
    assert.deepEqual(parseFeedUrls(text), [
      'https://a.example/feed.xml',
      'https://b.example/atom.xml',
      'https://c.example/rss',
    ]);
  });

  test('逗号 / 分号 / 空白都当分隔符', () => {
    assert.deepEqual(parseFeedUrls('https://a.example/f,https://b.example/f'), ['https://a.example/f', 'https://b.example/f']);
    assert.deepEqual(parseFeedUrls('https://a.example/f; https://b.example/f'), ['https://a.example/f', 'https://b.example/f']);
    // 反向对照：制表符分隔必须也认，否则从表格里复制一列地址会拼成一个巨大的假地址。
    assert.deepEqual(parseFeedUrls('https://a.example/f\thttps://b.example/f'), ['https://a.example/f', 'https://b.example/f']);
  });

  test('# 开头的整行、以及行内 # 之后的内容都忽略（订阅清单里常见）', () => {
    const text = ['# 我常看的', 'https://a.example/feed.xml', '# 待定', 'https://b.example/feed.xml'].join('\n');
    assert.deepEqual(parseFeedUrls(text), ['https://a.example/feed.xml', 'https://b.example/feed.xml']);
    // 反向对照：注释行必须**完全不计入**结果，否则它们会被算成「被忽略的非 http 行」，
    // 界面上就会凭空多出一句「已忽略 2 行不是 http(s) 地址」。
    const { urls, ignored } = httpFeedUrls(text);
    assert.equal(urls.length, 2);
    assert.equal(ignored, 0);

    // 反向对照（这一条是本模块修过的真实缺陷）：`# 我常看的` 若按空白切成 token 逐个判断，
    // `#` 被丢掉、`我常看的` 却会活下来，变成一个看着像地址的东西。
    assert.deepEqual(parseFeedUrls('# 我常看的博客'), []);
    assert.deepEqual(parseFeedUrls('https://a.example/f  # 我的博客'), ['https://a.example/f']);
    // 反向对照：# 只在自己是 token 开头时才断；URL 片段里的 # 不能误伤。
    assert.deepEqual(parseFeedUrls('https://a.example/f#section'), ['https://a.example/f#section']);
  });

  test('去重且保持首次出现的顺序', () => {
    const text = ['https://b.example/f', 'https://a.example/f', 'https://b.example/f'].join('\n');
    assert.deepEqual(parseFeedUrls(text), ['https://b.example/f', 'https://a.example/f']);
  });

  test('空输入与纯空白返回空数组，不返回 [""]', () => {
    assert.deepEqual(parseFeedUrls(''), []);
    assert.deepEqual(parseFeedUrls('   \n\t  '), []);
    assert.deepEqual(parseFeedUrls(undefined), []);
    assert.deepEqual(parseFeedUrls(null), []);
    // 反向对照：这是最容易写错的一处 —— 用 split 后不过滤空串，会得到一个 '' ，
    // 界面就会显示「将订阅 1 个地址」，点下去却什么都没订。
    assert.equal(parseFeedUrls('\n\n').length, 0);
  });

  test('首尾空白被去掉', () => {
    assert.deepEqual(parseFeedUrls('  https://a.example/f  \n'), ['https://a.example/f']);
  });

  test('20 个地址一个不少（一次粘贴的真实规模）', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `https://feed${i}.example/rss.xml`);
    const urls = parseFeedUrls(lines.join('\n'));
    assert.equal(urls.length, 20);
    assert.equal(urls[19], 'https://feed19.example/rss.xml');
    // 反向对照：漏一个就说明分隔或去重把合法地址吃掉了。
    assert.equal(new Set(urls).size, 20);
  });
});

describe('httpFeedUrls 过滤与计数', () => {
  test('http 与 https 都留下', () => {
    const { urls, ignored } = httpFeedUrls(['http://a.example/f', 'https://b.example/f'].join('\n'));
    assert.deepEqual(urls, ['http://a.example/f', 'https://b.example/f']);
    assert.equal(ignored, 0);
    // 反向对照：大小写不同的 scheme 也得认（用户从网页复制时常带大写）。
    assert.equal(httpFeedUrls('HTTPS://A.example/F').urls.length, 1);
  });

  test('非 http(s) 一律忽略，并把条数如实报出来', () => {
    const text = [
      'https://a.example/f',
      'ftp://b.example/f',
      'feed://c.example/f',
      'mailto:someone@example.com',
      'a.example/feed.xml',
    ].join('\n');
    const { urls, ignored } = httpFeedUrls(text);
    assert.deepEqual(urls, ['https://a.example/f']);
    // 反向对照：ignored 必须正好是 4。写成 `all.length - urls.length` 之外的花样
    // （比如按行数算）就会在这里露出来。
    assert.equal(ignored, 4);
  });

  test('注释不计入 ignored，非 http 才计入', () => {
    const text = ['# 注释', 'https://a.example/f', '不是地址'].join('\n');
    const { urls, ignored } = httpFeedUrls(text);
    assert.equal(urls.length, 1);
    assert.equal(ignored, 1);
  });
});

describe('接线', () => {
  test('对话框从 feed-urls.js 取用，而不是自带一份副本', () => {
    const source = readFileSync(join(clientDir, 'dialogs.jsx'), 'utf8');
    assert.match(source, /import \{ httpFeedUrls \} from '\.\/feed-urls\.js';/);
    // 反向对照：本地再定义一份 parseFeedUrls 就会和模块各走各的，
    // 单测覆盖的是模块，跑起来的却是副本 —— 断言全绿而线上照旧出错。
    assert.doesNotMatch(source, /export function parseFeedUrls/);
    assert.doesNotMatch(source, /const all = parseFeedUrls\(/);
  });
});
