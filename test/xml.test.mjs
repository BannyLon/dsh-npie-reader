import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attrOf, childrenOf, decodeEntities, findAll, find, localName, parseXml, textOf, XmlParseError } from '../src/host/xml.js';

describe('parseXml', () => {
  it('builds a tree with namespace-prefixed tags kept verbatim', () => {
    const root = parseXml('<rss><channel><content:encoded>x</content:encoded></channel></rss>');
    const channel = find(root, 'channel');
    assert.ok(channel);
    assert.equal(textOf(find(root, 'encoded')), 'x', 'matched by local name');
    assert.equal(localName('content:encoded'), 'encoded');
    assert.equal(localName('TITLE'), 'title');
  });

  it('rejects DTD declarations outright (no entity expansion)', () => {
    assert.throws(() => parseXml('<!DOCTYPE rss [<!ENTITY x "boom">]><rss>&x;</rss>'), XmlParseError);
    assert.throws(() => parseXml('<!doctype rss><rss/>'), /DTD declarations are rejected/);
  });

  it('把「这个地址返回网页」和「真的 DTD」分开报，让报错指向该做的动作', () => {
    // 实测原文（2026-10-08，`windard.com/feed.xml` 只回 114 字节）：是个 JS 跳转页，
    // 根本不是 feed。两种都报「DTD declarations are rejected」会让用户去翻自己源里的
    // DOCTYPE —— 而真正该做的是换地址。
    const landing = '<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>';
    assert.throws(() => parseXml(landing), /返回的是网页（HTML），不是 feed/);

    // 反向对照：真 feed 里带 DOCTYPE 的写法仍须说「DTD 被拒」，不能被归成「这是网页」，
    // 否则安全检查会被一句更友好的文案悄悄替换掉。
    assert.throws(() => parseXml('<!DOCTYPE rss SYSTEM "rss.dtd"><rss/>'), /DTD declarations are rejected/);
    // 反向对照：没有 DOCTYPE 的正常 feed 一个都不许被这两条误伤。
    assert.ok(parseXml('<rss><channel/></rss>'));
  });

  it('resolves the five predefined entities and numeric references only', () => {
    assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
    assert.equal(decodeEntities('&#65;&#x41;'), 'AA');
    assert.equal(decodeEntities('&nbsp;'), '&nbsp;', 'unknown named entities stay literal');
    assert.equal(decodeEntities('&#0;'), '&#0;', 'control characters stay literal');
  });

  it('reads CDATA as text', () => {
    const root = parseXml('<a><![CDATA[<p>raw</p>]]></a>');
    assert.equal(textOf(find(root, 'a')), '<p>raw</p>');
  });

  it('keeps attributes and matches them by local name', () => {
    const root = parseXml('<rss><item><media:thumbnail url="https://e.org/t.jpg" medium="image"/></item></rss>');
    const thumb = find(root, 'thumbnail');
    assert.equal(attrOf(thumb, 'url'), 'https://e.org/t.jpg');
    assert.equal(attrOf(thumb, 'medium'), 'image');
    assert.equal(attrOf(thumb, 'missing'), undefined);
    assert.equal(attrOf(undefined, 'url'), undefined);
  });

  it('supports self-closing, quoted attributes with > inside, and single quotes', () => {
    const root = parseXml('<rss><item title=\'a>b\' other="x"/></rss>');
    const item = find(root, 'item');
    assert.equal(attrOf(item, 'title'), 'a>b');
    assert.equal(attrOf(item, 'other'), 'x');
    assert.equal(childrenOf(item, 'item').length, 0);
  });

  it('distinguishes direct children from all descendants', () => {
    const root = parseXml('<channel><title>Feed</title><item><title>Post</title></item></channel>');
    const channel = find(root, 'channel');
    assert.deepEqual(childrenOf(channel, 'title').map(textOf), ['Feed'], 'direct children only');
    assert.deepEqual(findAll(channel, 'title').map(textOf), ['Feed', 'Post'], 'descendants include the item title');
  });

  it('gives up on pathologically deep nesting instead of blowing the stack', () => {
    const deep = `${'<a>'.repeat(300)}x${'</a>'.repeat(300)}`;
    assert.throws(() => parseXml(deep), XmlParseError);
  });

  it('skips comments, processing instructions and the XML declaration', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><rss><channel><title>T</title></channel></rss>');
    assert.equal(textOf(find(root, 'title')), 'T');
  });
});
