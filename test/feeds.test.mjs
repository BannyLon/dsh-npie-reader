import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildOpml, excerptOf, FEED_LIMITS, hashKey, parseFeed, parseOpml } from '../src/host/feeds.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>Test Feed &amp; More</title>
  <link>https://example.com/</link>
  <description>A test feed</description>
  <item>
    <title>First post</title>
    <link>https://example.com/first</link>
    <guid isPermaLink="false">post-1</guid>
    <pubDate>Wed, 24 Sep 2025 08:00:00 GMT</pubDate>
    <description><![CDATA[<p>Hello <b>world</b> <script>alert(1)</script></p>]]></description>
    <content:encoded><![CDATA[<p>Full <em>content</em> here <a href="/relative">link</a> <img src="x" onerror="alert(2)"></p>]]></content:encoded>
    <media:thumbnail url="https://example.com/thumb.jpg"/>
  </item>
  <item>
    <title>Second</title>
    <link>https://example.com/second</link>
    <guid>post-2</guid>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <link rel="alternate" href="https://atom.example.org/"/>
  <subtitle>Subtitle here</subtitle>
  <entry>
    <title>Atom entry</title>
    <id>tag:atom.example.org,2025:1</id>
    <link rel="alternate" href="https://atom.example.org/one"/>
    <updated>2025-09-24T08:00:00Z</updated>
    <author><name>Ada</name></author>
    <content type="html">&lt;p&gt;Atom body&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.org/">
    <title>RDF Feed</title>
    <link>https://rdf.example.org/</link>
  </channel>
  <item rdf:about="https://rdf.example.org/one">
    <title>RDF item</title>
    <link>https://rdf.example.org/one</link>
    <dc:creator>Grace</dc:creator>
  </item>
</rdf:RDF>`;

describe('parseFeed', () => {
  it('normalizes RSS 2.0 and strips scripts from the body', () => {
    const parsed = parseFeed(RSS, 'https://example.com/feed.xml');
    assert.equal(parsed.title, 'Test Feed & More');
    assert.equal(parsed.link, 'https://example.com/');
    assert.equal(parsed.description, 'A test feed');
    assert.equal(parsed.entries.length, 2);

    const [first] = parsed.entries;
    assert.equal(first.title, 'First post');
    assert.equal(first.url, 'https://example.com/first');
    assert.equal(first.publishedAt, '2025-09-24T08:00:00.000Z');
    assert.ok(first.html.includes('Full <em>content</em>'), 'content:encoded wins over description');
    assert.ok(!first.html.includes('<script'), 'script tag removed');
    assert.ok(!first.html.includes('alert(1)'), 'script body removed, not just the tag');
    assert.ok(!first.html.includes('onerror'), 'event handler attribute removed');
    assert.equal(first.image, 'https://example.com/thumb.jpg', 'media:thumbnail becomes the entry image');
    assert.match(first.key, /^feed:[0-9a-f]{32}$/);
  });

  it('resolves relative links against the entry URL', () => {
    const [first] = parseFeed(RSS, 'https://example.com/feed.xml').entries;
    assert.ok(first.html.includes('href="https://example.com/relative"'), first.html);
  });

  it('normalizes Atom, including author and updated time', () => {
    const parsed = parseFeed(ATOM, 'https://atom.example.org/feed.xml');
    assert.equal(parsed.title, 'Atom Feed');
    assert.equal(parsed.link, 'https://atom.example.org/');
    assert.equal(parsed.description, 'Subtitle here');
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].author, 'Ada');
    assert.equal(parsed.entries[0].url, 'https://atom.example.org/one');
    assert.equal(parsed.entries[0].publishedAt, '2025-09-24T08:00:00.000Z');
    assert.ok(parsed.entries[0].html.includes('Atom body'));
  });

  it('normalizes RSS 1.0 (RDF), whose <item> is a sibling of <channel>', () => {
    const parsed = parseFeed(RDF, 'https://rdf.example.org/feed.xml');
    assert.equal(parsed.title, 'RDF Feed');
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].author, 'Grace', 'dc:creator is read');
  });

  it('falls back to the feed URL when the channel has no title', () => {
    const bare = '<rss version="2.0"><channel><item><title>x</title><link>https://a.example/x</link></item></channel></rss>';
    assert.equal(parseFeed(bare, 'https://a.example/feed.xml').title, 'https://a.example/feed.xml');
  });

  it('rejects documents that are neither RSS nor Atom', () => {
    assert.throws(() => parseFeed('<html><body>nope</body></html>', 'https://x.example/'), /no channel\/entry records/);
  });

  it('keeps entry ids stable for the same feed URL and guid', () => {
    const a = parseFeed(RSS, 'https://example.com/feed.xml').entries.map((entry) => entry.key);
    const b = parseFeed(RSS, 'https://example.com/feed.xml').entries.map((entry) => entry.key);
    const other = parseFeed(RSS, 'https://other.example/feed.xml').entries.map((entry) => entry.key);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, other, 'a different feed URL yields different keys');
  });

  it('caps how much body text one feed may contribute', () => {
    const items = Array.from({ length: 80 }, (_, index) => `<item><title>t${index}</title><link>https://a.example/${index}</link><description>${'x'.repeat(2000)}</description></item>`).join('');
    const parsed = parseFeed(`<rss version="2.0"><channel><title>Big</title>${items}</channel></rss>`, 'https://a.example/feed.xml');
    assert.ok(parsed.entries.length <= FEED_LIMITS.maxEntriesKept, `kept ${parsed.entries.length}`);
  });
});

describe('excerptOf', () => {
  it('flattens markup and caps the length', () => {
    assert.equal(excerptOf('<p>Hello <b>world</b></p>'), 'Hello world');
    assert.equal(excerptOf('<p>a</p><script>bad()</script><p>b</p>'), 'a b');
    const long = excerptOf(`<p>${'word '.repeat(100)}</p>`, 20);
    // 截断在词边界收尾：slice(0,20) = 'word word word word ' → trimEnd 后 19 字 + '…'
    assert.equal(long, 'word word word word…');
  });
});

describe('parseOpml / buildOpml', () => {
  const OPML = `<?xml version="1.0"?>
<opml version="2.0"><head><title>subs</title></head><body>
  <outline text="Tech">
    <outline type="rss" text="One" xmlUrl="https://one.example/feed"/>
    <outline text="Nested">
      <outline type="rss" text="Two" xmlUrl="https://two.example/feed"/>
    </outline>
  </outline>
  <outline type="rss" text="No group" xmlUrl="https://three.example/feed"/>
  <outline type="rss" text="Duplicate" xmlUrl="https://one.example/feed"/>
  <outline type="rss" text="Unsafe" xmlUrl="javascript:alert(1)"/>
</body></opml>`;

  it('flattens nested outlines into slash paths and drops unsafe URLs', () => {
    const entries = parseOpml(OPML);
    assert.deepEqual(entries, [
      { url: 'https://one.example/feed', name: 'One', group: 'Tech' },
      { url: 'https://two.example/feed', name: 'Two', group: 'Tech / Nested' },
      { url: 'https://three.example/feed', name: 'No group', group: undefined },
    ]);
  });

  it('round-trips through buildOpml without losing group structure', () => {
    const xml = buildOpml([
      { name: 'One', url: 'https://one.example/feed', group: 'Tech' },
      { name: 'Two', url: 'https://two.example/feed' },
    ]);
    assert.match(xml, /<opml version="2.0">/);
    assert.match(xml, /<outline text="Tech">/);
    assert.deepEqual(parseOpml(xml), [
      { url: 'https://one.example/feed', name: 'One', group: 'Tech' },
      { url: 'https://two.example/feed', name: 'Two', group: undefined },
    ]);
  });

  it('escapes XML metacharacters in names and URLs', () => {
    const xml = buildOpml([{ name: 'A & B <c>', url: 'https://x.example/feed?a=1&b=2' }]);
    assert.ok(!/<outline type="rss" text="A & B/.test(xml), 'ampersand must be escaped');
    assert.match(xml, /text="A &amp; B &lt;c&gt;"/);
    assert.match(xml, /xmlUrl="https:\/\/x\.example\/feed\?a=1&amp;b=2"/);
  });
});

describe('hashKey', () => {
  it('is 32 hex chars and separates its parts unambiguously', () => {
    assert.match(hashKey('a'), /^[0-9a-f]{32}$/);
    assert.equal(hashKey('a', 'b'), hashKey('a', 'b'));
    assert.notEqual(hashKey('ab'), hashKey('a', 'b'), 'a NUL separator prevents concatenation collisions');
  });
});
