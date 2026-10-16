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
export type CountMode = 'utf16' | 'codepoints' | 'graphemes' | 'bytes';

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
    media: { min: 1, max: 10, kinds: ['image', 'video'], mixed: true, maxVideos: 10, imageTypes: ['image/jpeg'], maxImageBytes: null, maxVideoBytes: null, maxVideoSeconds: null },
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
    // X weighs some characters double and counts every URL as 23; this simple count is a lower bound until the
    // adapter adds X's own counting.
    provider: 'x',
    body: { max: 280, count: 'codepoints', required: true },
    title: null,
    media: { min: 0, max: 4, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: null, maxVideoBytes: null, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: true,
    unverified: ['body.count'],
  },
  bluesky: {
    provider: 'bluesky',
    body: { max: 300, count: 'graphemes', required: false },
    title: null,
    media: { min: 0, max: 4, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: 1_000_000, maxVideoBytes: 50 * MB, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: false,
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
  }
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/giu;

export function countLinks(text: string): number {
  return text.match(URL_PATTERN)?.length ?? 0;
}
