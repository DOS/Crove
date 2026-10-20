// A blog's feed for Social drafts (#708): RSS 2.0 or Atom, read in the sandbox like every other untrusted file. Entity
// expansion is off and DOCTYPE or ENTITY declarations are refused before parsing; the five XML entities and numeric
// character references are decoded afterwards, by hand, in text only. What comes back is the feed's title and its
// newest items (key, title, link, date, a plain-text summary and an image), each capped; the worker checks them again.
import { XMLParser } from 'fast-xml-parser';
import { EXTRACT_LIMITS, type ExtractedFeed } from '@crove/extract-contract';

export class FeedError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  isArray: (name) => ['item', 'entry', 'link', 'content', 'thumbnail', 'enclosure'].includes(name),
});

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (all, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return NAMED[ref.toLowerCase()] ?? all;
  });
}

// An element's text: a string, or the #text of an element with attributes.
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isNode(value) && typeof value['#text'] === 'string') return value['#text'];
  return '';
}

// Only what is a tag (a letter, / or ! after the <), so a text's own "a < b" stays.
const stripTags = (html: string) => html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[/!]?[a-z][^>]*>/gi, ' ');

// HTML of a description as plain text: tags dropped before and after decoding (a feed may hold its HTML as it is, in
// CDATA, or escaped once), entities decoded, spaces folded.
function plain(html: string): string {
  return decode(stripTags(decode(stripTags(html))))
    .replace(/\s+/g, ' ')
    .trim();
}

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const webUrl = (value: string): string | null => {
  const url = value.trim();
  return /^https?:\/\/[^\s]+$/i.test(url) && url.length <= 2000 ? url : null;
};
const isoOf = (value: string): string | null => {
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// The first image an item names: media:content or media:thumbnail, an image enclosure, or an <img> in its HTML.
function imageOf(item: Node, html: string): string | null {
  for (const m of [...list(item.content), ...list(item.thumbnail)]) {
    if (isNode(m) && typeof m['@url'] === 'string' && (m['@medium'] === undefined || m['@medium'] === 'image')) {
      const url = webUrl(decode(m['@url']));
      if (url) return url;
    }
  }
  for (const e of list(item.enclosure)) {
    if (isNode(e) && typeof e['@url'] === 'string' && typeof e['@type'] === 'string' && e['@type'].startsWith('image/')) {
      const url = webUrl(decode(e['@url']));
      if (url) return url;
    }
  }
  const img = /<img[^>]+src=["']([^"']+)["']/i.exec(decode(html));
  return img?.[1] ? webUrl(decode(img[1])) : null;
}

export function readFeed(bytes: Uint8Array): ExtractedFeed {
  const xml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new FeedError('Nguồn tin chứa DOCTYPE/ENTITY, bị từ chối');
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch {
    throw new FeedError('Không đọc được nguồn tin');
  }
  const L = EXTRACT_LIMITS;
  const rss = isNode(doc.rss) ? doc.rss : isNode(doc.RDF) ? doc.RDF : null;
  const atom = isNode(doc.feed) ? doc.feed : null;
  if (!rss && !atom) throw new FeedError('Đây không phải nguồn tin RSS hay Atom');
  const items: ExtractedFeed['items'] = [];
  let title: string | null = null;
  if (rss) {
    const channel = isNode(rss.channel) ? rss.channel : rss;
    title = cap(plain(textOf(channel.title)), L.maxFeedTitleChars) || null;
    const entries = [...list(channel.item), ...list(rss.item)];
    for (const raw of entries) {
      if (!isNode(raw) || items.length >= L.maxFeedItems) continue;
      const link = webUrl(decode(textOf(list(raw.link)[0])));
      const guid = decode(textOf(raw.guid)).trim();
      const html = textOf(raw.description) || textOf(raw.encoded);
      const itemTitle = cap(plain(textOf(raw.title)), L.maxFeedTitleChars);
      const key = cap(guid || link || itemTitle, L.maxStringChars);
      if (!key || (!link && !itemTitle)) continue;
      items.push({ key, title: itemTitle || null, link, publishedAt: isoOf(textOf(raw.pubDate) || textOf(raw.date)), summary: cap(plain(html), L.maxFeedSummaryChars) || null, image: imageOf(raw, html) });
    }
  } else if (atom) {
    title = cap(plain(textOf(atom.title)), L.maxFeedTitleChars) || null;
    for (const raw of list(atom.entry)) {
      if (!isNode(raw) || items.length >= L.maxFeedItems) continue;
      const links = list(raw.link).filter(isNode);
      const alternate = links.find((l) => l['@rel'] === undefined || l['@rel'] === 'alternate') ?? links[0];
      const link = alternate && typeof alternate['@href'] === 'string' ? webUrl(decode(alternate['@href'])) : null;
      const html = textOf(raw.summary) || textOf(list(raw.content)[0]);
      const itemTitle = cap(plain(textOf(raw.title)), L.maxFeedTitleChars);
      const key = cap(decode(textOf(raw.id)).trim() || link || itemTitle, L.maxStringChars);
      if (!key || (!link && !itemTitle)) continue;
      items.push({ key, title: itemTitle || null, link, publishedAt: isoOf(textOf(raw.published) || textOf(raw.updated)), summary: cap(plain(html), L.maxFeedSummaryChars) || null, image: imageOf(raw, html) });
    }
  }
  return { title, items };
}
