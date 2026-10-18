// What each channel accepts (Social plan §3.6). The same data drives the composer's validation and preview and the
// adapters' own checks. Values come from the platforms' docs as summarized in docs/plan/social-research.md §4; a
// value marked "unverified" there is marked here too and is rechecked when the adapter is built (plan §6). Text
// limits of Facebook, Instagram and LinkedIn are the values Postiz enforces (research §2), not a platform doc.

export const PROVIDERS = [
  'sandbox',
  'facebook_page',
  'instagram',
  'zalo_oa',
  'tiktok',
  'youtube',
  'threads',
  'linkedin',
  'x',
  'bluesky',
] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export type MediaKind = 'image' | 'video';

// How a platform counts text against its limit. Text is NFC-normalized first, so Vietnamese typed with combining
// marks (NFD) counts the same as precomposed text.
// - utf16: UTF-16 code units (JavaScript string length), as TikTok counts "runes".
// - codepoints: Unicode code points.
// - graphemes: user-perceived characters (Bluesky).
// - bytes: UTF-8 bytes (YouTube descriptions).
// - weighted: X's count (twitter-text v3): characters up to U+10FF and a few punctuation ranges count one, any other
//   character counts two (Vietnamese letters with a tone mark, U+1EA0 to U+1EF9, among them), an emoji counts two
//   however many code points it has, and a link counts 23 whatever its length.
export type CountMode = 'utf16' | 'codepoints' | 'graphemes' | 'bytes' | 'weighted';

export interface TextRule {
  // null: the platform documents no limit we know of.
  max: number | null;
  count: CountMode;
  required: boolean;
}

export interface MediaRule {
  min: number;
  max: number;
  kinds: readonly MediaKind[];
  // false: a post carries images or one video, never both.
  mixed: boolean;
  // At most this many videos in one post.
  maxVideos: number;
  // Allowed image MIME types; empty means any image type.
  imageTypes: readonly string[];
  maxImageBytes: number | null;
  maxVideoBytes: number | null;
  maxVideoSeconds: number | null;
}

export interface ChannelCapabilities {
  provider: Provider;
  body: TextRule;
  // Platforms with a separate title (YouTube video title, Zalo OA article title); null when there is none.
  title: TextRule | null;
  media: MediaRule;
  // Links allowed in the body; null when the platform sets no limit.
  maxLinks: number | null;
  // The platform builds a link preview from the URL itself (otherwise the adapter supplies title and image).
  scrapesLinkPreview: boolean;
  // Facts below rest on an unverified source (research [U]); the adapter PR checks them against current docs.
  unverified: readonly string[];
}

const MB = 1024 * 1024;
const ANY_IMAGE: readonly string[] = [];

// The channels whose Crove adapter posts video today (#410). A platform may take video while its adapter does not yet:
// the composer says so instead of letting a video fail at publish time. Each adapter that learns video joins here.
// The channels whose platform takes photos but whose Crove adapter posts only video (TikTok's photo mode is not built).
export const VIDEO_ONLY_ADAPTERS: ReadonlySet<Provider> = new Set<Provider>(['tiktok']);

export const VIDEO_READY: ReadonlySet<Provider> = new Set<Provider>(['sandbox', 'youtube', 'tiktok', 'instagram', 'facebook_page']);

export const CAPABILITIES: Readonly<Record<Provider, ChannelCapabilities>> = {
  // No network: publishes into a local table so the whole flow runs offline and in tests (plan §3.5).
  sandbox: {
    provider: 'sandbox',
    body: { max: 1000, count: 'codepoints', required: false },
    title: null,
    media: { min: 0, max: 4, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: 8 * MB, maxVideoBytes: 100 * MB, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: true,
    unverified: [],
  },
  facebook_page: {
    provider: 'facebook_page',
    body: { max: 63206, count: 'utf16', required: false },
    title: null,
    media: { min: 0, max: 10, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: null, maxVideoBytes: null, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: true,
    unverified: ['body.max', 'media.max'],
  },
  instagram: {
    provider: 'instagram',
    body: { max: 2200, count: 'utf16', required: false },
    title: null,
    // A Reel runs up to 15 minutes and 300 MB (Meta's Reels specs); a carousel mixes images and videos.
    media: { min: 1, max: 10, kinds: ['image', 'video'], mixed: true, maxVideos: 10, imageTypes: ['image/jpeg'], maxImageBytes: null, maxVideoBytes: 300 * MB, maxVideoSeconds: 900 },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: ['body.max'],
  },
  zalo_oa: {
    provider: 'zalo_oa',
    body: { max: null, count: 'codepoints', required: true },
    title: { max: 150, count: 'codepoints', required: true },
    media: { min: 1, max: 1, kinds: ['image'], mixed: false, maxVideos: 0, imageTypes: ANY_IMAGE, maxImageBytes: 1 * MB, maxVideoBytes: null, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: ['media.min', 'media.max'],
  },
  // TikTok values: Content Posting API reference, media transfer guide and photo post reference (research §4).
  tiktok: {
    provider: 'tiktok',
    body: { max: 2200, count: 'utf16', required: false },
    title: null,
    media: { min: 1, max: 35, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: null, maxVideoBytes: 4096 * MB, maxVideoSeconds: 600 },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: [],
  },
  youtube: {
    provider: 'youtube',
    body: { max: 5000, count: 'bytes', required: false },
    title: { max: 100, count: 'codepoints', required: true },
    media: { min: 1, max: 1, kinds: ['video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: null, maxVideoBytes: null, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: ['title.count'],
  },
  threads: {
    provider: 'threads',
    body: { max: 500, count: 'codepoints', required: false },
    title: null,
    media: { min: 0, max: 20, kinds: ['image', 'video'], mixed: true, maxVideos: 20, imageTypes: ['image/jpeg', 'image/png'], maxImageBytes: 8 * MB, maxVideoBytes: 1024 * MB, maxVideoSeconds: 300 },
    maxLinks: 5,
    scrapesLinkPreview: true,
    unverified: ['body.count'],
  },
  linkedin: {
    provider: 'linkedin',
    body: { max: 3000, count: 'utf16', required: false },
    title: null,
    media: { min: 0, max: 20, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: null, maxVideoBytes: 500 * MB, maxVideoSeconds: 1800 },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: ['body.max', 'media.max'],
  },
  x: {
    // 280 for accounts without X Premium. Text is optional when the post has media (POST /2/tweets).
    provider: 'x',
    body: { max: 280, count: 'weighted', required: false },
    title: null,
    // Up to 4 images or one video; 5 MB per image (X media upload). Video waits for the chunked upload.
    media: { min: 0, max: 4, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], maxImageBytes: 5 * MB, maxVideoBytes: null, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: true,
    unverified: [],
  },
  bluesky: {
    provider: 'bluesky',
    body: { max: 300, count: 'graphemes', required: false },
    title: null,
    // Images only until video posts are built (#396); 1 MB per image is Bluesky's own blob limit.
    media: { min: 0, max: 4, kinds: ['image'], mixed: false, maxVideos: 0, imageTypes: ANY_IMAGE, maxImageBytes: 1_000_000, maxVideoBytes: null, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: false,
    // Bluesky also caps post text in bytes.
    unverified: ['body.max'],
  },
};

let segmenter: Intl.Segmenter | null = null;

export function countText(text: string, mode: CountMode): number {
  const s = text.normalize('NFC');
  switch (mode) {
    case 'utf16':
      return s.length;
    case 'codepoints': {
      let n = 0;
      for (const _ of s) n++;
      return n;
    }
    case 'graphemes': {
      segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      let n = 0;
      for (const _ of segmenter.segment(s)) n++;
      return n;
    }
    case 'bytes':
      return new TextEncoder().encode(s).length;
    case 'weighted':
      return weightedCount(s);
  }
}

// twitter-text v3's ranges that count one; everything else counts two.
const LIGHT_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const X_LINK_LENGTH = 23;
// An emoji as X sees one: a pictograph above U+10FF (so a bare © or ® counts one), one with the emoji
// presentation selector, a flag or a keycap.
const EMOJI = /[\u{1100}-\u{10FFFF}](?<=\p{Extended_Pictographic})|\p{Extended_Pictographic}\uFE0F|\p{Regional_Indicator}|\u20E3/u;

function weightedCount(nfc: string): number {
  let n = 0;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  // Every link counts as a t.co link; the text between links counts per character.
  for (const part of nfc.split(X_LINK)) {
    if (part === undefined) continue;
    for (const { segment } of segmenter.segment(part)) {
      if (EMOJI.test(segment)) {
        n += 2;
        continue;
      }
      for (const ch of segment) {
        const cp = ch.codePointAt(0) ?? 0;
        n += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
      }
    }
  }
  return n + (nfc.match(X_LINK)?.length ?? 0) * X_LINK_LENGTH;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/giu;
// A link as X finds one: with a scheme, or a host name without one (crove.vn/gia). X knows every TLD; this list holds
// the common ones, so "TP.HCM" stays text, and a bare link on a rarer TLD counts its own length (X then refuses an
// over-long post at publish, never silently).
const BARE_TLDS = 'com|net|org|vn|io|co|ai|app|dev|me|info|biz|xyz|shop|store|online|site|tech|asia|edu|gov|us|uk|jp|sg|tv|ly|gg|link';
// Punctuation that ends a sentence after a link is not part of it, as for X.
const X_LINK = new RegExp(`\\bhttps?:\\/\\/[^\\s<>"']*[^\\s<>"'.,!?;:)\\]]|(?<![@\\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${BARE_TLDS})\\b(?:\\/(?:[^\\s<>"']*[^\\s<>"'.,!?;:)\\]])?)?`, 'giu');

export function countLinks(text: string): number {
  return text.match(URL_PATTERN)?.length ?? 0;
}
