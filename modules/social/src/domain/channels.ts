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
  'google_business',
  'telegram',
  'mastodon',
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
  // A second cap in UTF-8 bytes, besides the count (Bluesky: 300 graphemes and 3000 bytes, so a long run of emoji or
  // combined characters can be refused under 300).
  maxBytes?: number;
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

// The channels whose platform takes photos but whose Crove adapter posts only video. None since TikTok's photo posts
// (#710).
export const VIDEO_ONLY_ADAPTERS: ReadonlySet<Provider> = new Set<Provider>([]);

// A longer text where a channel's photo posts take one (#710): TikTok sends a photo post's text as its description,
// up to 4,000 characters, where a video's caption takes 2,200.
export const PHOTO_BODY_MAX: Readonly<Partial<Record<Provider, number>>> = { tiktok: 4000 };
// A shorter text where a channel's posts with media take one (#747): a Telegram caption is 1,024 characters, where a
// message's text is 4,096.
export const MEDIA_BODY_MAX: Readonly<Partial<Record<Provider, number>>> = { telegram: 1024 };

// Where each adapter puts the post's link, so the checks count the text the platform receives:
// - text: after a blank line at the end of the text, unless the text already holds it;
// - text_with_media: the same, but only when the post has media (a Facebook Page text post sends it as its own field);
// - apart: never in the text (a field of its own, an article paragraph, or not sent).
export type LinkPlacement = 'text' | 'text_with_media' | 'apart';
export const LINK_PLACEMENT: Readonly<Record<Provider, LinkPlacement>> = {
  sandbox: 'apart',
  facebook_page: 'text_with_media',
  instagram: 'apart',
  zalo_oa: 'apart',
  tiktok: 'text',
  youtube: 'text',
  threads: 'text',
  linkedin: 'text',
  x: 'text',
  bluesky: 'text',
  // The link goes as the call to action's URL (or an offer's redeem link), never in the text.
  google_business: 'apart',
  telegram: 'text',
  mastodon: 'text',
};

// The link as a whole: followed by the end, a space, or sentence punctuation and then the end or a space (the
// adapters' holdsLink in @crove/channel, which the browser cannot import).
export function holdsLink(text: string, link: string): boolean {
  for (let i = text.indexOf(link); i !== -1; i = text.indexOf(link, i + 1)) {
    if (/^[.,!?;:)\]]*(?:\s|$)/.test(text.slice(i + link.length))) return true;
  }
  return false;
}

// The text an adapter sends for this body and link.
export function sentText(provider: Provider, body: string, linkUrl: string | null | undefined, mediaCount: number): string {
  const link = linkUrl?.trim();
  const placement = LINK_PLACEMENT[provider];
  if (!link || placement === 'apart' || (placement === 'text_with_media' && mediaCount === 0)) return body;
  const text = body.trim();
  if (holdsLink(text, link)) return body;
  return [text, link].filter(Boolean).join('\n\n');
}

// The first comment each channel's Crove adapter posts after the post (#587, #609), and how its text is counted: a
// comment on LinkedIn, Facebook Pages and Instagram, a reply in the thread on X, Bluesky and Threads. Facebook,
// Instagram and Threads need a permission Crove asks for at connect time since #609; a connection made earlier is
// refused by the platform and comments once it reconnects. A channel missing here takes no first comment.
// Limits (#609): a Facebook comment message 8000 characters, an Instagram comment 2200 characters (its hashtag cap is
// not enforced reliably by the API, so it is not checked), a Threads reply 500 characters, counted as Threads post text.
export const COMMENT_RULES: Readonly<Partial<Record<Provider, TextRule>>> = {
  sandbox: { max: 1000, count: 'graphemes', required: false },
  facebook_page: { max: 8000, count: 'utf16', required: false },
  instagram: { max: 2200, count: 'utf16', required: false },
  threads: { max: 500, count: 'codepoints', required: false },
  linkedin: { max: 1250, count: 'utf16', required: false },
  x: { max: 280, count: 'weighted', required: false },
  bluesky: { max: 300, count: 'graphemes', required: false, maxBytes: 3000 },
  mastodon: { max: 500, count: 'codepoints', required: false },
};

// The first comment in a variant's settings, or null.
export function firstCommentOf(settings: Readonly<Record<string, unknown>> | undefined): string | null {
  const value = settings?.firstComment;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Thread posts (#742): on Threads, X and Bluesky a variant may go on in up to 9 more parts after its text, posted as a
// chain of replies to the account's own post (`settings.threadParts`, an array of strings). Each part is counted as a
// post of that channel. A thread takes no first comment: its first reply would be the comment.
export const THREAD_PARTS_MAX = 9;
export const THREAD_RULES: Readonly<Partial<Record<Provider, TextRule>>> = {
  sandbox: { max: 1000, count: 'graphemes', required: false },
  threads: { max: 500, count: 'codepoints', required: false },
  x: { max: 280, count: 'weighted', required: false },
  bluesky: { max: 300, count: 'graphemes', required: false, maxBytes: 3000 },
  mastodon: { max: 500, count: 'codepoints', required: false },
};

// The thread parts in a variant's settings, trimmed, or null when there are none. An entry that is not a string reads
// as empty, so validation names it.
export function threadPartsOf(settings: Readonly<Record<string, unknown>> | undefined): string[] | null {
  const value = settings?.threadParts;
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((part) => (typeof part === 'string' ? part.trim() : ''));
}

// Auto-replies on likes (#746): on the channels whose adapter both replies under its own post and reports likes
// (Facebook Pages, Threads, Bluesky, Mastodon; X and LinkedIn report no counts yet), a variant may carry one reply posted once the post has that many likes (`settings.autoReply`: { text, likes }). The
// reply is counted like a first comment there.
export const AUTO_REPLY_LIKES_MAX = 1_000_000;
export const AUTO_REPLY_RULES: Readonly<Partial<Record<Provider, TextRule>>> = {
  sandbox: COMMENT_RULES.sandbox as TextRule,
  facebook_page: COMMENT_RULES.facebook_page as TextRule,
  threads: COMMENT_RULES.threads as TextRule,
  bluesky: COMMENT_RULES.bluesky as TextRule,
  mastodon: COMMENT_RULES.mastodon as TextRule,
};

// Reposts when a post takes off (#773): on the channels whose adapter reposts the account's own post and reports likes
// (Threads, Bluesky, Mastodon; X reports no counts to Crove yet), a variant may carry one repost rule
// (`settings.repost`: { likes?, afterHours? }), at a like count, after some hours, or whichever comes first.
export const REPOST_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['sandbox', 'threads', 'bluesky', 'mastodon']);
export const REPOST_LIKES_MAX = 1_000_000;
// Metrics are read for 30 days after a post goes out.
export const REPOST_HOURS_MAX = 720;

// The repost rule in a variant's settings: null when there is none, 'invalid' when it is not an object with a whole like
// count from 1 to REPOST_LIKES_MAX and/or whole hours from 1 to REPOST_HOURS_MAX.
export function repostRuleOf(settings: Readonly<Record<string, unknown>> | undefined): { likes: number | null; afterHours: number | null } | 'invalid' | null {
  const value = settings?.repost;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const { likes, afterHours } = value as { likes?: unknown; afterHours?: unknown };
  const whole = (n: unknown, max: number) => (n === undefined || n === null ? null : typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max ? n : 'invalid');
  const l = whole(likes, REPOST_LIKES_MAX);
  const h = whole(afterHours, REPOST_HOURS_MAX);
  if (l === 'invalid' || h === 'invalid' || (l === null && h === null)) return 'invalid';
  return { likes: l, afterHours: h };
}

// The auto-reply in a variant's settings: null when there is none, 'invalid' when it is not { text, likes } with a
// text and a whole number of likes from 1 to AUTO_REPLY_LIKES_MAX.
export function autoReplyOf(settings: Readonly<Record<string, unknown>> | undefined): { text: string; likes: number } | 'invalid' | null {
  const value = settings?.autoReply;
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const { text, likes } = value as { text?: unknown; likes?: unknown };
  if (typeof text !== 'string' || !text.trim() || typeof likes !== 'number' || !Number.isInteger(likes) || likes < 1 || likes > AUTO_REPLY_LIKES_MAX) return 'invalid';
  return { text: text.trim(), likes };
}

// Polls and topic tags (#711), in the variant's settings, on the channels that take them (Threads): `settings.poll`
// is { options: 2 to 4 strings of 1 to 25 characters } on a post without media; `settings.topicTag` is one tag of 1 to 50
// characters with no period or ampersand (a leading # is dropped). The Threads adapter reads the same shapes.
export interface PollRule {
  minOptions: number;
  maxOptions: number;
  maxChars: number;
}
export const POLL_RULES: Readonly<Partial<Record<Provider, PollRule>>> = { threads: { minOptions: 2, maxOptions: 4, maxChars: 25 } };
export const TOPIC_TAG_RULES: Readonly<Partial<Record<Provider, { maxChars: number }>>> = { threads: { maxChars: 50 } };

// The poll's options, trimmed; null when there is none, 'invalid' when it is not { options: string[] }.
export function pollOptionsOf(settings: Readonly<Record<string, unknown>> | undefined): string[] | null | 'invalid' {
  const poll = settings?.poll;
  if (poll === undefined || poll === null) return null;
  const options = typeof poll === 'object' ? (poll as { options?: unknown }).options : undefined;
  if (!Array.isArray(options) || !options.every((o) => typeof o === 'string')) return 'invalid';
  return options.map((o: string) => o.trim());
}

// The topic tag as it is sent, without a leading #; null when there is none, false when it is not text (a tag may be
// any word, so no string marks a bad one).
export function topicTagOf(settings: Readonly<Record<string, unknown>> | undefined): string | null | false {
  const tag = settings?.topicTag;
  if (tag === undefined || tag === null) return null;
  return typeof tag === 'string' ? tag.trim().replace(/^#/, '') : false;
}

// Google Business Profile posts (#709), in the variant's settings (`settings.gbp`): a topic (a standard post, an event
// or an offer), an optional call to action (its URL is the post's link; CALL needs none), an event's title and dates
// (YYYY-MM-DD, times HH:MM optional) for events and offers, and an offer's coupon code and terms. The adapter's
// gbpSettingsOf in @crove/channel reads the same shape.
export const GBP_TOPICS = ['STANDARD', 'EVENT', 'OFFER'] as const;
export const GBP_CTAS = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'] as const;
export type GbpTopic = (typeof GBP_TOPICS)[number];
export type GbpCta = (typeof GBP_CTAS)[number];
export interface Gbp {
  topic: GbpTopic;
  cta: GbpCta | null;
  event: { title: string; startDate: string; startTime: string; endDate: string; endTime: string };
  offer: { couponCode: string; terms: string };
}
const asText = (v: unknown) => (typeof v === 'string' ? v : '');
// The settings as the composer edits them; null when they are not an object (an issue of their own).
export function gbpOf(settings: Readonly<Record<string, unknown>> | undefined): Gbp | null {
  const raw = settings?.gbp;
  const g = raw === undefined || raw === null ? {} : typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!g) return null;
  const e = (g.event && typeof g.event === 'object' ? g.event : {}) as Record<string, unknown>;
  const o = (g.offer && typeof g.offer === 'object' ? g.offer : {}) as Record<string, unknown>;
  return {
    topic: (GBP_TOPICS as readonly unknown[]).includes(g.topic) ? (g.topic as GbpTopic) : 'STANDARD',
    cta: (GBP_CTAS as readonly unknown[]).includes(g.cta) ? (g.cta as GbpCta) : null,
    event: { title: asText(e.title), startDate: asText(e.startDate), startTime: asText(e.startTime), endDate: asText(e.endDate), endTime: asText(e.endTime) },
    offer: { couponCode: asText(o.couponCode), terms: asText(o.terms) },
  };
}

// A video's cover (#642), in the variant's settings (`settings.cover`): a frame of the video, at a time in
// milliseconds from its start, or an image of the org (a file uploaded for Social, JPEG or PNG), by file id. The
// adapters' videoCoverOf in @crove/channel reads the same shape.
export type Cover = { atMs: number } | { fileId: string };
export type CoverKind = 'frame' | 'image';
export const COVER_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

export function coverOf(settings: Readonly<Record<string, unknown>> | undefined): Cover | null {
  const value = settings?.cover;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { atMs, fileId } = value as Record<string, unknown>;
  if (typeof atMs === 'number' && Number.isSafeInteger(atMs) && atMs >= 0 && fileId === undefined) return { atMs };
  if (typeof fileId === 'string' && fileId !== '' && atMs === undefined) return { fileId: fileId.toLowerCase() };
  return null;
}

export const coverKind = (cover: Cover): CoverKind => ('atMs' in cover ? 'frame' : 'image');

// What each channel's Crove adapter sends as a video's cover (#642); a channel missing here takes none. Instagram
// Reels take a frame (thumb_offset) or an image (cover_url); TikTok's direct post takes a frame
// (video_cover_timestamp_ms) and no uploaded image; YouTube takes an image (thumbnails.set) and no frame, since the
// Data API has no way to pick one. Facebook Page videos and the other channels take none from Crove yet.
// A channel's post type (#644), in the variant's settings (`settings.postType`): a feed post (the default), a Story or
// a Reel, on the channels whose adapter posts them. The adapters' postTypeOf in @crove/channel reads the same value.
// A Story is one image or video shown for a day: its text and link are not sent, and a video lasts at most a minute.
// A Reel is one video. A Story image is upright, about 9:16 (phone screens from 1:2.2 to 2:3 count).
export const POST_TYPES = ['feed', 'story', 'reel'] as const;
export type PostType = (typeof POST_TYPES)[number];
export const POST_TYPE_RULES: Readonly<Partial<Record<Provider, readonly PostType[]>>> = {
  // The offline test channel takes every type, so the composer can be tried end to end.
  sandbox: ['feed', 'story', 'reel'],
  instagram: ['feed', 'story', 'reel'],
  facebook_page: ['feed', 'story', 'reel'],
};
export const STORY_IMAGE = { minRatio: 0.45, maxRatio: 2 / 3 } as const;
export const STORY_MAX_VIDEO_SECONDS = 60;
// The longest Reel each platform takes through its API.
export const REEL_MAX_VIDEO_SECONDS: Readonly<Partial<Record<Provider, number>>> = { instagram: 900, facebook_page: 90 };

// The post type in a variant's settings; null when it is not one of POST_TYPES.
export function postTypeOf(settings: Readonly<Record<string, unknown>> | undefined): PostType | null {
  const value = settings?.postType;
  if (value === undefined || value === null) return 'feed';
  return (POST_TYPES as readonly unknown[]).includes(value) ? (value as PostType) : null;
}
// What an image must be for a channel to take it (#636): its shape (width / height) and its width in pixels, as the
// platforms' APIs refuse otherwise. Instagram's feed takes 4:5 to 1.91:1; Threads 1:10 to 10:1; both at least 320 wide.
// A channel without a rule takes any shape. Checked only when the image's size is known (read at upload).
export interface ImageRule {
  minRatio: number;
  maxRatio: number;
  minWidth: number;
}
export const IMAGE_RULES: Readonly<Partial<Record<Provider, ImageRule>>> = {
  instagram: { minRatio: 4 / 5, maxRatio: 1.91, minWidth: 320 },
  threads: { minRatio: 1 / 10, maxRatio: 10, minWidth: 320 },
};
// A shape within 1% of a bound counts as on it (1080 x 1350 is 4:5, a resize may land a pixel off).
export const RATIO_SLACK = 0.01;

export const COVER_RULES: Readonly<Partial<Record<Provider, readonly CoverKind[]>>> = {
  sandbox: ['frame', 'image'],
  instagram: ['frame', 'image'],
  tiktok: ['frame'],
  youtube: ['image'],
};
// YouTube refuses a thumbnail over 2 MB (thumbnails.set).
export const COVER_IMAGE_MAX_BYTES: Readonly<Partial<Record<Provider, number>>> = { youtube: 2 * 1024 * 1024 };

// The channels whose Crove adapter posts video today (#410). A platform may take video while its adapter does not yet:
// the composer says so instead of letting a video fail at publish time. Each adapter that learns video joins here.
export const VIDEO_READY: ReadonlySet<Provider> = new Set<Provider>(['sandbox', 'youtube', 'tiktok', 'instagram', 'facebook_page', 'threads', 'x', 'linkedin', 'telegram', 'mastodon']);

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
    // Page photos: JPEG, BMP, PNG, GIF or TIFF up to 4 MB (Graph API /{page-id}/photos); Meta lists no WEBP.
    media: { min: 0, max: 10, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff'], maxImageBytes: 4 * MB, maxVideoBytes: null, maxVideoSeconds: null },
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
    // A video alone, or 1 to 35 photos (JPEG or WebP, 20 MB each, #710).
    media: { min: 1, max: 35, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ['image/jpeg', 'image/webp'], maxImageBytes: 20 * MB, maxVideoBytes: 4096 * MB, maxVideoSeconds: 600 },
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
    // Up to 4 images or one video; 5 MB per image (X media upload); a video of up to 20 minutes for accounts without X
    // Premium (POST /2/tweets).
    media: { min: 0, max: 4, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], maxImageBytes: 5 * MB, maxVideoBytes: null, maxVideoSeconds: 1200 },
    maxLinks: null,
    scrapesLinkPreview: true,
    unverified: [],
  },
  bluesky: {
    provider: 'bluesky',
    body: { max: 300, count: 'graphemes', required: false, maxBytes: 3000 },
    title: null,
    // Up to 4 images (1 MB each, Bluesky's blob limit) or one video of up to 3 minutes and 100 MB; the Crove adapter
    // does not post video yet, so it stays out of VIDEO_READY.
    media: { min: 0, max: 4, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: 1_000_000, maxVideoBytes: 100 * MB, maxVideoSeconds: 180 },
    maxLinks: null,
    scrapesLinkPreview: false,
    // Bluesky also caps post text in bytes.
    unverified: ['body.max'],
  },
  // Google Business Profile (#709): localPosts' summary of 1,500 characters and one photo (JPEG or PNG, 10 KB to 5 MB);
  // no video through the API. The link goes as the call to action, an offer's redeem link, or not at all.
  google_business: {
    provider: 'google_business',
    body: { max: 1500, count: 'codepoints', required: false },
    title: null,
    media: { min: 0, max: 1, kinds: ['image'], mixed: false, maxVideos: 0, imageTypes: ['image/jpeg', 'image/png'], maxImageBytes: 5 * MB, maxVideoBytes: null, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: [],
  },
  // Telegram channels (#747): a message of 4,096 characters (UTF-16, as the Bot API counts), a caption of 1,024 with
  // media (MEDIA_BODY_MAX); one photo or video, or an album of 2 to 10 mixing them. Files are uploaded with the call:
  // photos up to 10 MB, videos up to 50 MB. Telegram shows the link's preview itself.
  telegram: {
    provider: 'telegram',
    body: { max: 4096, count: 'utf16', required: false },
    title: null,
    media: { min: 0, max: 10, kinds: ['image', 'video'], mixed: true, maxVideos: 10, imageTypes: ['image/jpeg', 'image/png', 'image/webp'], maxImageBytes: 10 * MB, maxVideoBytes: 50 * MB, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: true,
    unverified: [],
  },
  // Mastodon (#748): 500 characters on most instances (the adapter reads the instance's own limit before posting), up to
  // 4 images or one video; mainline Mastodon takes images up to 16 MB and videos up to 99 MB. Instances show the link's
  // preview card themselves. A content warning and the visibility are settings (MASTODON_SETTINGS).
  mastodon: {
    provider: 'mastodon',
    body: { max: 500, count: 'codepoints', required: false },
    title: null,
    media: { min: 0, max: 4, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], maxImageBytes: 16 * MB, maxVideoBytes: 99 * MB, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: true,
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

// Mastodon settings (#748): a content warning shown before the post (`settings.contentWarning`, up to 500 characters)
// and the visibility (`settings.visibility`: public, the default, or unlisted). The adapter reads the same shapes.
export const MASTODON_VISIBILITY = ['public', 'unlisted'] as const;
export const CONTENT_WARNING_MAX = 500;

// Publishing limits Crove counts itself (#775, plan §3.6: "Rate limits and quotas tracked per app and per account"),
// for the channels whose API has no quota endpoint: how many posts one account may make in a window. Instagram and
// Threads read their own quota from the platform (#743). The numbers are the platforms' documented per-account limits,
// kept a little under where they are approximate: TikTok about 15 posts a day per creator, YouTube's 100 uploads a day,
// X 100 posts per 15 minutes per user, LinkedIn 150 member posts a day.
export interface PublishLimit {
  count: number;
  windowMs: number;
}
export const PUBLISH_LIMITS: Readonly<Partial<Record<Provider, PublishLimit>>> = {
  tiktok: { count: 15, windowMs: 24 * 3_600_000 },
  youtube: { count: 100, windowMs: 24 * 3_600_000 },
  x: { count: 100, windowMs: 15 * 60_000 },
  linkedin: { count: 150, windowMs: 24 * 3_600_000 },
};

// When the next post may go out under a limit, given when the account's earlier posts in the window started: null when
// one may go now, else the time the oldest of the counted posts leaves the window.
export function limitWait(starts: readonly Date[], limit: PublishLimit, now: Date): Date | null {
  const since = now.getTime() - limit.windowMs;
  const inWindow = starts.map((d) => d.getTime()).filter((t) => t > since).sort((a, b) => a - b);
  if (inWindow.length < limit.count) return null;
  // The post that has to leave the window for one more to fit.
  const leaving = inWindow[inWindow.length - limit.count] as number;
  return new Date(leaving + limit.windowMs + 1000);
}
