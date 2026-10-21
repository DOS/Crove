// Cutting a feed read at the size limit back to its last whole item (#708).
import { describe, expect, it } from 'vitest';
import { wholeItems } from '../src/feeds.ts';

const cut = (s: string) => wholeItems(Buffer.from(s, 'utf8'))?.toString('utf8') ?? null;

describe('wholeItems', () => {
  it('keeps an RSS feed up to its last whole item, even when the cut falls inside a CDATA section', () => {
    const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>Tiệm Bánh</title><item><title>Một</title></item><item><title>Hai</title><description><![CDATA[<p>Bánh mì';
    expect(cut(rss)).toBe('<?xml version="1.0"?><rss version="2.0"><channel><title>Tiệm Bánh</title><item><title>Một</title></item></channel></rss>');
  });

  it('keeps an Atom feed up to its last whole entry, and an RSS 1.0 feed up to its last item', () => {
    expect(cut('<feed xmlns="http://www.w3.org/2005/Atom"><title>B</title><entry><id>1</id></entry><entry><id>2</id><content>cut')).toBe('<feed xmlns="http://www.w3.org/2005/Atom"><title>B</title><entry><id>1</id></entry></feed>');
    expect(cut('<rdf:RDF xmlns:rdf="r"><channel/><item><title>1</title></item><item>')).toBe('<rdf:RDF xmlns:rdf="r"><channel/><item><title>1</title></item></rdf:RDF>');
  });

  it('gives up on a part with no whole item, or on something that is not a feed', () => {
    expect(cut('<rss><channel><title>B</title><item><title>cut')).toBeNull();
    expect(cut('<html><body><item></item>')).toBeNull();
  });
});
