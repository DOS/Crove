import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, zExtractedFeed } from '@crove/extract-contract';
import { FeedError, readFeed } from '../src/feed.ts';
import { parse } from '../src/parse.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Tiệm Bánh &amp; Cà Phê</title>
    <link>https://tiembanh.example/</link>
    <item>
      <title>Bánh mùa thu đã về</title>
      <link>https://tiembanh.example/bai/banh-mua-thu</link>
      <guid isPermaLink="false">post-102</guid>
      <pubDate>Mon, 19 Oct 2026 08:00:00 +0700</pubDate>
      <description><![CDATA[<p>Ba loại bánh <b>mới</b> cho mùa thu &amp; Trung thu.</p><img src="https://tiembanh.example/anh/thu.jpg">]]></description>
    </item>
    <item>
      <title>Ưu đãi 20/10</title>
      <link>https://tiembanh.example/bai/uu-dai-20-10</link>
      <description>Giảm 20% &#8211; chỉ hôm nay</description>
      <media:content url="https://cdn.example/uu-dai.jpg" medium="image"/>
    </item>
    <item><description>Không tiêu đề, không liên kết</description></item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Nhật ký cửa hàng</title>
  <entry>
    <title>Khai trương chi nhánh mới</title>
    <link rel="alternate" href="https://shop.example/khai-truong"/>
    <link rel="edit" href="https://shop.example/edit/1"/>
    <id>tag:shop.example,2026:1</id>
    <published>2026-10-18T09:30:00Z</published>
    <summary type="html">&lt;p&gt;Mời bạn ghé chơi&lt;/p&gt;</summary>
  </entry>
</feed>`;

describe('feeds (#708)', () => {
  it('reads an RSS feed: titles, links, keys, dates, plain summaries and images', () => {
    const feed = readFeed(bytes(RSS));
    expect(zExtractedFeed.parse(feed)).toEqual(feed);
    expect(feed.title).toBe('Tiệm Bánh & Cà Phê');
    expect(feed.items).toEqual([
      {
        key: 'post-102',
        title: 'Bánh mùa thu đã về',
        link: 'https://tiembanh.example/bai/banh-mua-thu',
        publishedAt: '2026-10-19T01:00:00.000Z',
        summary: 'Ba loại bánh mới cho mùa thu & Trung thu.',
        image: 'https://tiembanh.example/anh/thu.jpg',
      },
      { key: 'https://tiembanh.example/bai/uu-dai-20-10', title: 'Ưu đãi 20/10', link: 'https://tiembanh.example/bai/uu-dai-20-10', publishedAt: null, summary: 'Giảm 20% – chỉ hôm nay', image: 'https://cdn.example/uu-dai.jpg' },
    ]);
  });

  it('reads an Atom feed, taking the alternate link', () => {
    const feed = readFeed(bytes(ATOM));
    expect(feed).toEqual({
      title: 'Nhật ký cửa hàng',
      items: [{ key: 'tag:shop.example,2026:1', title: 'Khai trương chi nhánh mới', link: 'https://shop.example/khai-truong', publishedAt: '2026-10-18T09:30:00.000Z', summary: 'Mời bạn ghé chơi', image: null }],
    });
  });

  it('refuses DOCTYPE and entities, non-feeds and garbage; keeps only web links', () => {
    expect(() => readFeed(bytes('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><rss><channel><title>&a;</title></channel></rss>'))).toThrow(FeedError);
    expect(() => readFeed(bytes('<html><body>trang web</body></html>'))).toThrow(FeedError);
    const sneaky = readFeed(bytes('<rss><channel><item><title>x</title><link>javascript:alert(1)</link><guid>g</guid></item></channel></rss>'));
    expect(sneaky.items).toEqual([{ key: 'g', title: 'x', link: null, publishedAt: null, summary: null, image: null }]);
  });

  it('caps the items and the texts', () => {
    const many = `<rss><channel><title>${'t'.repeat(400)}</title>${Array.from({ length: 80 }, (_, i) => `<item><title>Bài ${i}</title><link>https://b.example/${i}</link><description>${'x'.repeat(1500)}</description></item>`).join('')}</channel></rss>`;
    const feed = readFeed(bytes(many));
    expect(feed.items).toHaveLength(EXTRACT_LIMITS.maxFeedItems);
    expect(feed.title).toHaveLength(EXTRACT_LIMITS.maxFeedTitleChars);
    expect(feed.items[0]?.summary).toHaveLength(EXTRACT_LIMITS.maxFeedSummaryChars);
    expect(zExtractedFeed.safeParse(feed).success).toBe(true);
  });

  it('answers through the sandbox dispatcher, and refuses what it cannot read as invalid', async () => {
    expect(await parse('feed', bytes(ATOM))).toMatchObject({ ok: true, kind: 'feed', feed: { title: 'Nhật ký cửa hàng' } });
    expect(await parse('feed', bytes('không phải xml'))).toMatchObject({ ok: false, code: 'invalid' });
  });
});
