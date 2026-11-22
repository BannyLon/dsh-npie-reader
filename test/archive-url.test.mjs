/**
 * 0.87.0：订阅条目去重键。
 *
 * 守的是一条**不报错**的缺陷：同一篇文章从不同渠道进来（Twitter / 微博 / 站内），
 * 链接上带的追踪参数不同，旧实现把整个 query 原样拼进 key，于是列表里出现两条
 * 一模一样的文章。用户只会觉得「这插件有 bug」，而日志里什么都没有。
 *
 * 反向对照必须一起写：真的不同的页面**不能**被合成一条，否则就是「去重太狠，
 * 文章消失」—— 那是比重复更难发现的问题。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeEntryUrl } from '../src/host/archive.js';

describe('0.87.0：订阅去重键', () => {
  it('★ 只有追踪参数不同 ⇒ 同一个键', () => {
    const base = 'https://example.com/post/abc';
    const variants = [
      `${base}?utm_source=twitter&utm_medium=social`,
      `${base}?utm_source=weibo`,
      `${base}?fbclid=xyz`,
      `${base}?spm=a1z.123&scm=456`,
      `${base}?ref_src=twsrc%5Etfw`,
      `${base}?mc_cid=1&mc_eid=2`,
    ];
    for (const url of variants) {
      assert.equal(normalizeEntryUrl(url), normalizeEntryUrl(base),
        `追踪参数没被剥掉：${url}`);
    }
  });

  it('★ http / https、www / 非 www、尾斜杠、hash 都算同一篇', () => {
    const key = normalizeEntryUrl('https://example.com/post/abc');
    for (const url of [
      'http://example.com/post/abc',
      'https://www.example.com/post/abc',
      'http://www.example.com/post/abc/',
      'https://example.com/post/abc#section-2',
      'https://EXAMPLE.com/post/abc',
    ]) {
      assert.equal(normalizeEntryUrl(url), key, `同一条目算成了两篇：${url}`);
    }
  });

  it('有语义的参数必须保留 —— 不能把 `?id=` 也剥掉', () => {
    const a = normalizeEntryUrl('https://example.com/post?id=1');
    const b = normalizeEntryUrl('https://example.com/post?id=2');
    assert.notEqual(a, b, '把内容参数剥掉了 ⇒ 不同的文章会被当成同一篇');
    assert.equal(a, 'https://example.com/post?id=1');
  });

  it('追踪参数与内容参数混在一起时，只剥追踪参数', () => {
    const url = 'https://example.com/post?id=42&utm_source=x&page=2';
    assert.equal(normalizeEntryUrl(url), 'https://example.com/post?id=42&page=2');
  });

  it('★ 反向对照：不同路径 / 路径大小写不同 ⇒ 必须是两个键', () => {
    assert.notEqual(
      normalizeEntryUrl('https://example.com/post/abc'),
      normalizeEntryUrl('https://example.com/post/def'),
      '不同文章被当成同一篇 —— 用户会看到「文章消失」',
    );
    assert.notEqual(
      normalizeEntryUrl('https://example.com/Post/ABC'),
      normalizeEntryUrl('https://example.com/post/abc'),
      '路径被 lowercase 了 —— 大小写敏感的站点会丢文章',
    );
  });

  it('反向对照：不同站点同一路径不能撞', () => {
    assert.notEqual(
      normalizeEntryUrl('https://a.example.com/post/1'),
      normalizeEntryUrl('https://b.example.com/post/1'),
    );
  });

  it('不是 URL 就原样 trim，不抛错', () => {
    assert.equal(normalizeEntryUrl('  not a url  '), 'not a url');
    assert.equal(normalizeEntryUrl(undefined), '');
  });
});
