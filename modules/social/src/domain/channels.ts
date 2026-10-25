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
  'pinterest',
  'discord',
  'wordpress',
  // A LinkedIn Company Page the member administers (#1077).
  'linkedin_page',
] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

// A document (#1119) is a PDF a channel shows as a document of pages (a LinkedIn carousel); only LinkedIn posts one.
export type MediaKind = 'image' | 'video' | 'document';
export const DOCUMENT_TYPES: readonly string[] = ['application/pdf'];
// A post file is a video, a document or an image, by its type (the server read it from the bytes).
export const mediaKindOf = (mime: string): MediaKind => (mime.startsWith('video/') ? 'video' : DOCUMENT_TYPES.includes(mime.toLowerCase()) ? 'document' : 'image');

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
  // Allowed video MIME types, where the channel takes fewer than Crove uploads (MP4 and QuickTime); absent means any.
  videoTypes?: readonly string[];
  // A document's size cap, where kinds takes documents (#1119). A document is always the post's only file.
  maxDocumentBytes?: number;
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
// How much alt text each channel's Crove adapter sends (#790, #801), in characters, the smallest over its media kinds
// (Bluesky cuts a video's at 1000): the adapters cut a longer one. A channel missing here sends no alt text, or none
// Crove cuts. An AI suggestion (#1121) keeps within the smallest of the chosen channels.
export const ALT_TEXT_LIMITS: Readonly<Partial<Record<Provider, number>>> = {
  x: 1000,
  facebook_page: 1000,
  instagram: 1000,
  threads: 1000,
  bluesky: 1000,
  mastodon: 1500,
  linkedin: 4086,
  linkedin_page: 4086,
  pinterest: 500,
  discord: 1024,
  wordpress: 1000,
};

// The smallest alt-text limit of these channels; null when none of them has one.
export function strictestAltTextLimit(providers: readonly string[]): number | null {
  const limits = providers.flatMap((p) => (isProvider(p) && ALT_TEXT_LIMITS[p] !== undefined ? [ALT_TEXT_LIMITS[p] as number] : []));
  return limits.length === 0 ? null : Math.min(...limits);
}

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
  linkedin_page: 'text',
  x: 'text',
  bluesky: 'text',
  // The link goes as the call to action's URL (or an offer's redeem link), never in the text.
  google_business: 'apart',
  telegram: 'text',
  mastodon: 'text',
  // The pin leads to the link itself (#798).
  pinterest: 'apart',
  discord: 'text',
  // A paragraph of its own after the text (#833).
  wordpress: 'text',
};

// The link as a whole: followed by the end, a space, or sentence punctuation and then the end or a space (the
// adapters' holdsLink in @crove/channel, which the browser cannot import).
export function holdsLink(text: string, link: string): boolean {
  for (let i = text.indexOf(link); i !== -1; i = text.indexOf(link, i + 1)) {
    if (/^[.,!?;:)\]]*(?:\s|$)/.test(text.slice(i + link.length))) return true;
  }
  return false;
}

// The text an adapter sends for this body and link. settings: the variant's, whose link card (#1498) carries the link
// apart from the text on LinkedIn and Bluesky.
export function sentText(provider: Provider, body: string, linkUrl: string | null | undefined, mediaCount: number, settings?: Readonly<Record<string, unknown>>): string {
  const link = linkUrl?.trim();
  const placement = LINK_PLACEMENT[provider];
  if (!link || placement === 'apart' || (placement === 'text_with_media' && mediaCount === 0) || carriesLinkCard(provider, settings, link, mediaCount)) return body;
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
  // A page comments under its own post as the page (#1077), with the member's limit.
  linkedin_page: { max: 1250, count: 'utf16', required: false },
  x: { max: 280, count: 'weighted', required: false },
  bluesky: { max: 300, count: 'graphemes', required: false, maxBytes: 3000 },
  mastodon: { max: 500, count: 'codepoints', required: false },
  // A top-level comment on the video (#791), up to 10000 characters.
  youtube: { max: 10000, count: 'codepoints', required: false },
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
  // A top-level comment on the video (#791), up to 10000 characters.
  youtube: { max: 10000, count: 'codepoints', required: false },
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
// The channels whose status check can itself publish (#946): Instagram and Threads upload a container first and post it
// (media_publish, threads_publish) in the status check that finds it processed. Every other adapter's status check only
// reads (TikTok and Zalo OA publish on their own), so a publishing hold stops only these.
export const STATUS_PUBLISHES: ReadonlySet<Provider> = new Set<Provider>(['instagram', 'threads']);
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

// Polls and topic tags (#711), in the variant's settings, on the channels that take them (Threads, and X for polls since
// #948): `settings.poll` is { options: 2 to 4 strings of 1 to 25 characters } on a post without media; on X it also has
// a length (`durationMinutes`, 5 minutes to 7 days, a day when unsaid; POST /2/tweets poll.duration_minutes), where a
// Threads poll always runs a day. `settings.topicTag` is one tag of 1 to 50 characters with no period or ampersand (a
// leading # is dropped). The Threads and X adapters read the same shapes. Options count in code points (X's schema
// maxLength, Threads' text count).
//
// Mastodon, Telegram and LinkedIn (#1118) read the same `settings.poll`, with what each platform adds:
// - Mastodon (POST /api/v1/statuses poll[options][], poll[expires_in], poll[multiple], poll[hide_totals]): the status
//   text is the question; 2 to 4 options of up to 50 characters and 5 minutes to about a month (mastodon.social's
//   GET /api/v2/instance configuration.polls, which the adapter reads again from the account's own instance before it
//   posts); `multiple` lets a voter pick several, `hideTotals` hides the counts until the poll ends; a day when unsaid.
// - Telegram (sendPoll): the post's text, link included, is the question (1 to 300 characters), so the poll is the post,
//   one message, with its buttons, silence and pin as any post; 2 to 12 options of up to 100 characters (Telegram also
//   takes one, Crove asks for two like every channel); `durationMinutes` up to 43,800 (open_period, 5 to 2,628,000
//   seconds), open until stopped in Telegram when unsaid; `multiple` (allows_multiple_answers) and `hideTotals`
//   (hide_results_until_closes). Always anonymous, Telegram's default: the docs do not say a channel takes a public
//   poll, so Crove offers none.
// - LinkedIn, member and Company Page (Posts API content.poll): a question of its own (`question`, 1 to 140
//   characters), the post's text staying its commentary; 2 to 4 options of up to 30 characters; 1, 3, 7 or 14 days
//   (settings.duration ONE_DAY, THREE_DAYS, SEVEN_DAYS, FOURTEEN_DAYS), a week when unsaid; one answer per voter.
// Every poll goes on a post without images or video: Mastodon and LinkedIn refuse both together, and Crove sends a
// Telegram poll without media.
export interface PollRule {
  minOptions: number;
  maxOptions: number;
  maxChars: number;
  // How an option is counted; code points when unsaid.
  count?: CountMode;
  // The poll's length in whole minutes, on channels that take one; absent where the platform sets it. default null: an
  // unsaid length leaves the poll open until it is stopped (Telegram). choices: the only lengths the platform takes.
  duration?: { min: number; max: number; default: number | null; choices?: readonly number[] };
  // Voters may pick several options (`settings.poll.multiple`), and the counts may stay hidden until the poll ends
  // (`settings.poll.hideTotals`).
  multiple?: boolean;
  hideTotals?: boolean;
  // A question of its own (`settings.poll.question`, required); without it the post's text is the question.
  question?: { maxChars: number; count: CountMode };
  // The post's text as the question has its own limit (Telegram): 1 to maxChars, counted as the channel's text.
  textAsQuestion?: { maxChars: number };
}
// The member's and the page's polls go through the same Posts API.
const LINKEDIN_POLL: PollRule = {
  minOptions: 2,
  maxOptions: 4,
  maxChars: 30,
  count: 'utf16',
  duration: { min: 1440, max: 20_160, default: 10_080, choices: [1440, 4320, 10_080, 20_160] },
  question: { maxChars: 140, count: 'utf16' },
};
export const POLL_RULES: Readonly<Partial<Record<Provider, PollRule>>> = {
  threads: { minOptions: 2, maxOptions: 4, maxChars: 25 },
  x: { minOptions: 2, maxOptions: 4, maxChars: 25, duration: { min: 5, max: 10_080, default: 1440 } },
  mastodon: { minOptions: 2, maxOptions: 4, maxChars: 50, duration: { min: 5, max: 43_829, default: 1440 }, multiple: true, hideTotals: true },
  telegram: { minOptions: 2, maxOptions: 12, maxChars: 100, count: 'utf16', duration: { min: 1, max: 43_800, default: null }, multiple: true, hideTotals: true, textAsQuestion: { maxChars: 300 } },
  linkedin: LINKEDIN_POLL,
  linkedin_page: LINKEDIN_POLL,
};

// A choice of a variant's poll (`multiple`, `hideTotals`): false when unsaid, 'invalid' when it is not true or false.
export function pollFlagOf(settings: Readonly<Record<string, unknown>> | undefined, key: 'multiple' | 'hideTotals'): boolean | 'invalid' {
  const poll = settings?.poll;
  if (!poll || typeof poll !== 'object') return false;
  const value = (poll as Record<string, unknown>)[key];
  if (value === undefined || value === null) return false;
  return typeof value === 'boolean' ? value : 'invalid';
}

// The poll's own question, trimmed: null when unsaid, 'invalid' when it is not text.
export function pollQuestionOf(settings: Readonly<Record<string, unknown>> | undefined): string | null | 'invalid' {
  const poll = settings?.poll;
  if (!poll || typeof poll !== 'object') return null;
  const value = (poll as { question?: unknown }).question;
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value.trim() : 'invalid';
}

// The poll's length in a variant's settings: null when unsaid, 'invalid' when it is not a whole number of minutes.
export function pollDurationOf(settings: Readonly<Record<string, unknown>> | undefined): number | null | 'invalid' {
  const poll = settings?.poll;
  if (!poll || typeof poll !== 'object') return null;
  const value = (poll as { durationMinutes?: unknown }).durationMinutes;
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) ? value : 'invalid';
}

// Who may reply to an X post (#948), in `settings.replySettings`: everyone (the default, sent as nothing), the accounts
// the poster follows, or the people the post mentions (POST /2/tweets reply_settings). The adapter reads the same value.
export const X_REPLY_SETTINGS = ['everyone', 'following', 'mentionedUsers'] as const;
export type XReplySetting = (typeof X_REPLY_SETTINGS)[number];
// Threads (#983) reads the same field with the same meanings, plus the poster's followers; its adapter maps them to
// reply_control (accounts_you_follow, mentioned_only, followers_only) on the published container, everyone sent as nothing.
export const THREADS_REPLY_SETTINGS = ['everyone', 'following', 'mentionedUsers', 'followers'] as const;
export type ReplySetting = (typeof THREADS_REPLY_SETTINGS)[number];
// The reply settings each channel takes, everyone first (the default).
export const REPLY_SETTINGS: Readonly<Partial<Record<Provider, readonly ReplySetting[]>>> = { x: X_REPLY_SETTINGS, threads: THREADS_REPLY_SETTINGS };
// A variant's reply setting when it is one its channel takes and not everyone, else null (for the preview).
export function replySettingOf(provider: string, settings: Readonly<Record<string, unknown>> | undefined): Exclude<ReplySetting, 'everyone'> | null {
  const allowed = isProvider(provider) ? REPLY_SETTINGS[provider] : undefined;
  const value = settings?.replySettings;
  return allowed && value !== 'everyone' && (allowed as readonly unknown[]).includes(value) ? (value as Exclude<ReplySetting, 'everyone'>) : null;
}
// Bluesky (#1102) reads the same field with the same names, plus nobody, and several of mentionedUsers, following and
// followers may combine as a list (Bluesky's threadgate allows any of its rules together). `settings.quotes: false`
// turns quote posts off (a postgate); on is the default and is not stored. Both are written after the post, by the
// gate step, on the thread's first post: its threadgate covers every reply of the thread, its postgate that post.
export const BLUESKY_REPLY_RULES = ['mentionedUsers', 'following', 'followers'] as const;
export type BlueskyReplyRule = (typeof BLUESKY_REPLY_RULES)[number];
// The choices the composer offers, everyone first (the default); the rules may also be picked together.
export const BLUESKY_REPLY_SETTINGS = ['everyone', 'nobody', ...BLUESKY_REPLY_RULES] as const;
const isBlueskyRule = (v: unknown): v is BlueskyReplyRule => typeof v === 'string' && (BLUESKY_REPLY_RULES as readonly string[]).includes(v);
// Who may reply to a Bluesky post: null for everyone (unsaid or 'everyone'), 'nobody', the rules (in
// BLUESKY_REPLY_RULES order) from one name or a list of distinct names, 'invalid' for anything else.
export function blueskyRepliesOf(settings: Readonly<Record<string, unknown>> | undefined): BlueskyReplyRule[] | 'nobody' | null | 'invalid' {
  const value = settings?.replySettings;
  if (value === undefined || value === 'everyone') return null;
  if (value === 'nobody') return 'nobody';
  if (isBlueskyRule(value)) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every(isBlueskyRule) && new Set(value).size === value.length) return BLUESKY_REPLY_RULES.filter((r) => value.includes(r));
  return 'invalid';
}
// Whether a variant turns quote posts off; anything but false leaves them on (validation refuses a non-boolean).
export const blueskyQuotesOff = (settings: Readonly<Record<string, unknown>> | undefined): boolean => settings?.quotes === false;
// Whether a Bluesky variant asks for a gate the gate step writes after the post: replies limited or quotes off.
export function wantsBlueskyGate(provider: string, settings: Readonly<Record<string, unknown>> | undefined): boolean {
  if (provider !== 'bluesky' || (settings?.quotes !== undefined && typeof settings.quotes !== 'boolean')) return false;
  const replies = blueskyRepliesOf(settings);
  return replies !== 'invalid' && (replies !== null || blueskyQuotesOff(settings));
}
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
// (YYYY-MM-DD, times HH:MM optional) for events and offers, an offer's coupon code and terms, and the post's language. The adapter's
// gbpSettingsOf in @crove/channel reads the same shape.
export const GBP_TOPICS = ['STANDARD', 'EVENT', 'OFFER'] as const;
export const GBP_CTAS = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'] as const;
export type GbpTopic = (typeof GBP_TOPICS)[number];
export type GbpCta = (typeof GBP_CTAS)[number];
// The post's language (#730), Vietnamese when unsaid.
export const GBP_LANGUAGES = ['vi', 'en', 'zh', 'ja', 'ko'] as const;
export type GbpLanguage = (typeof GBP_LANGUAGES)[number];
export interface Gbp {
  topic: GbpTopic;
  language: GbpLanguage;
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
    language: (GBP_LANGUAGES as readonly unknown[]).includes(g.language) ? (g.language as GbpLanguage) : 'vi',
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
// Data API has no way to pick one. A Facebook Page video takes an image (`thumb` on /{page-id}/videos, #1499), on a
// feed video only: Meta's Reels publishing takes no cover (REEL_COVER_REFUSED). The other channels take none yet.
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
  // A video pin's cover is a frame of the video (#813).
  pinterest: ['frame'],
  // A Zalo OA video article's thumbnail is an image Zalo fetches by URL (#1429).
  zalo_oa: ['image'],
  // A Page video's thumbnail, sent in the upload (#1499); feed videos only.
  facebook_page: ['image'],
};
// The channels whose Reels take no cover through the API although their feed videos do (#1499): Meta's Reels
// publishing documents no cover parameter, and setting one afterwards (/{video-id}/thumbnails) needs
// pages_read_user_content, which Crove does not ask for. The member changes it in Facebook instead.
export const REEL_COVER_REFUSED: ReadonlySet<Provider> = new Set<Provider>(['facebook_page']);
// A title on the video posts of a channel that has none otherwise (#1499): a Facebook Page video (one video, a feed
// post) and a Reel take the post's title (`title` on /{page-id}/videos and on the Reel's finish step); its text and
// photo posts and its Stories take none. Optional. Meta documents no length: 255 is Crove's cap [unverified],
// counted in UTF-16 as Facebook counts the post's text.
export const VIDEO_TITLE_RULES: Readonly<Partial<Record<Provider, TextRule>>> = {
  facebook_page: { max: 255, count: 'utf16', required: false },
};
// The title rule of a variant's video post (#1499), or null when the variant is not one (a text or photo post, a
// Story) or its channel gives video posts no title of their own.
export function videoTitleRule(provider: Provider, settings: Readonly<Record<string, unknown>> | undefined, media: readonly { kind: MediaKind }[]): TextRule | null {
  const rule = VIDEO_TITLE_RULES[provider];
  if (!rule) return null;
  const type = postTypeOf(settings);
  if (type === 'reel') return rule;
  return type === 'feed' && media.length === 1 && media[0]?.kind === 'video' ? rule : null;
}
// The channels whose video post cannot go out without a cover (#1429): a Zalo OA video article needs its thumbnail.
export const COVER_REQUIRED: ReadonlySet<Provider> = new Set<Provider>(['zalo_oa']);
// How a TikTok variant goes out (#903), in `settings.tiktokMode`: posted at once (direct, the default, so variants
// saved before #903 behave as they did), or sent to the creator's TikTok inbox as a draft they finish and post in the
// TikTok app (inbox). Inbox mode takes no privacy level, interaction settings or cover: the creator picks them in
// TikTok. The adapter's tiktokModeOf in @crove/channel reads the same value.
export const TIKTOK_MODES = ['direct', 'inbox'] as const;
export type TikTokMode = (typeof TIKTOK_MODES)[number];
// The mode in a variant's settings; null when it is set to something else.
export function tiktokModeOf(settings: Readonly<Record<string, unknown>> | undefined): TikTokMode | null {
  const value = settings?.tiktokMode;
  if (value === undefined || value === null) return 'direct';
  return (TIKTOK_MODES as readonly unknown[]).includes(value) ? (value as TikTokMode) : null;
}

// A permission the variant needs on its connection beyond what every post of its channel needs, by the scope the
// platform names it with (#903): TikTok's inbox upload needs video.upload, which connections made before Crove asked
// for it lack. The publisher checks it against the scopes stored with the connection before calling the platform.
export function scopeNeeded(provider: Provider, settings: Readonly<Record<string, unknown>> | undefined): string | null {
  return provider === 'tiktok' && tiktokModeOf(settings) === 'inbox' ? 'video.upload' : null;
}

// TikTok's commercial content and AI labels (#1078), in `settings.tiktok`: { commercial?, yourBrand?, brandedContent?,
// aiGenerated? }, each true when on and not stored when off, so a variant saved before keeps its content hash and the
// init body it always sent. commercial is the disclosure turned on, which needs yourBrand (promoting yourself or your
// own business, labelled "Promotional content"), brandedContent (promoting another brand or a third party, labelled
// "Paid partnership"), or both; aiGenerated asks TikTok for its AI-generated label. Branded content cannot be "only
// me" (SELF_ONLY), and a draft sent to the TikTok app takes none of them. The adapter's tiktokDisclosureOf in
// @crove/channel reads the same value.
export interface TikTokDisclosure {
  commercial: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  aiGenerated: boolean;
}
export const TIKTOK_DISCLOSURE_KEYS = ['commercial', 'yourBrand', 'brandedContent', 'aiGenerated'] as const;
// The disclosure in a variant's settings: null when there is none, 'invalid' when settings.tiktok is not an object of
// those true-or-false keys. yourBrand or brandedContent counts as the disclosure turned on.
export function tiktokDisclosureOf(settings: Readonly<Record<string, unknown>> | undefined): TikTokDisclosure | 'invalid' | null {
  const raw = settings?.tiktok;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.entries(r).some(([k, v]) => !(TIKTOK_DISCLOSURE_KEYS as readonly string[]).includes(k) || typeof v !== 'boolean')) return 'invalid';
  const yourBrand = r.yourBrand === true;
  const brandedContent = r.brandedContent === true;
  return { commercial: r.commercial === true || yourBrand || brandedContent, yourBrand, brandedContent, aiGenerated: r.aiGenerated === true };
}

// Telegram's silent and pinned posts (#982), in `settings.telegram`: { silent?: true, pin?: true, buttons? }. silent
// sends the post without a sound (the adapter reads the same value); pin pins it to the top of the channel once it is
// out, as a step of its own (pin.ts). Neither is stored when off, so a variant saved before keeps its content hash.
// buttons are the link buttons under the post (#1017), read by telegramButtonsOf.
export interface TelegramOptions {
  silent: boolean;
  pin: boolean;
}
// The options in a variant's settings: null when there are none, 'invalid' when they are not an object of those
// true-or-false keys and the buttons (whose own shape telegramButtonsOf checks).
export function telegramOptionsOf(settings: Readonly<Record<string, unknown>> | undefined): TelegramOptions | 'invalid' | null {
  const raw = settings?.telegram;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  const flag = (v: unknown) => v === undefined || typeof v === 'boolean';
  if (Object.keys(r).some((k) => k !== 'silent' && k !== 'pin' && k !== 'buttons') || !flag(r.silent) || !flag(r.pin)) return 'invalid';
  return { silent: r.silent === true, pin: r.pin === true };
}

// Link buttons under a Telegram post (#1017), in `settings.telegram.buttons`: rows of buttons, each a label (`text`)
// and an https link (`url`), sent as the message's inline keyboard. At most TELEGRAM_BUTTON_ROWS_MAX rows of
// TELEGRAM_BUTTONS_PER_ROW_MAX, a label of at most TELEGRAM_BUTTON_TEXT_MAX characters; an album (a media group) takes
// none, as Telegram puts no keyboard on one. The adapter in @crove/channel names the same limits. Not stored without
// a button, so a variant saved before keeps its content hash.
export const TELEGRAM_BUTTON_ROWS_MAX = 3;
export const TELEGRAM_BUTTONS_PER_ROW_MAX = 3;
export const TELEGRAM_BUTTON_TEXT_MAX = 64;
// The longest link a button carries, as for a short link's target.
export const TELEGRAM_BUTTON_URL_MAX = 2048;
export interface TelegramButton {
  text: string;
  url: string;
}
// The buttons in a variant's settings: null when there are none, 'invalid' when they are not a list of rows, each a
// list of { text, url } with both text. Their number, labels and links are validation's to check.
export function telegramButtonsOf(settings: Readonly<Record<string, unknown>> | undefined): TelegramButton[][] | 'invalid' | null {
  const raw = settings?.telegram;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const buttons = (raw as Record<string, unknown>).buttons;
  if (buttons === undefined) return null;
  if (!Array.isArray(buttons) || buttons.length === 0) return 'invalid';
  const rows: TelegramButton[][] = [];
  for (const row of buttons as unknown[]) {
    if (!Array.isArray(row) || row.length === 0) return 'invalid';
    const out: TelegramButton[] = [];
    for (const b of row as unknown[]) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) return 'invalid';
      const r = b as Record<string, unknown>;
      if (Object.keys(r).some((k) => k !== 'text' && k !== 'url') || typeof r.text !== 'string' || typeof r.url !== 'string') return 'invalid';
      out.push({ text: r.text, url: r.url });
    }
    rows.push(out);
  }
  return rows;
}
// Whether a button's link is one Telegram opens as a web page: https, with a host, no spaces, at most
// TELEGRAM_BUTTON_URL_MAX characters. javascript:, plain http and tg: links are refused, and so are links with a user
// name or password, control characters or invisible marks.
export function isButtonUrl(url: string): boolean {
  if (url.length > TELEGRAM_BUTTON_URL_MAX || !/^https:\/\/[^\s]+$/i.test(url) || hasHiddenChars(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
// C0 controls, DEL, zero-width and direction marks, line and paragraph separators, the byte order mark.
function hasHiddenChars(url: string): boolean {
  return [...url].some((ch) => {
    const c = ch.codePointAt(0) as number;
    return c < 0x20 || c === 0x7f || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0xfeff;
  });
}
// The settings with every button's link passed through `map` (UTM tags, a short link); as they are without buttons.
export function mapTelegramButtonUrls(settings: Record<string, unknown>, map: (url: string) => string): Record<string, unknown> {
  const rows = telegramButtonsOf(settings);
  if (rows === null || rows === 'invalid') return settings;
  const telegram = settings.telegram as Record<string, unknown>;
  return { ...settings, telegram: { ...telegram, buttons: rows.map((row) => row.map((b) => ({ text: b.text, url: map(b.url) }))) } };
}
// The scope a Telegram connection carries when its bot may pin in the channel (TELEGRAM_PIN_SCOPE in @crove/channel,
// read at connect): the editor greys the pin out without it.
export const TELEGRAM_PIN_SCOPE = 'can_pin_messages';

// Discord forum posts and threads (#1103), in `settings.discord`: { forum?: true, threadName?, tags?, threadId? }. A
// webhook's channel type cannot be read with the webhook alone, so the person posting marks a forum (or media)
// channel's webhook: forum posts the variant as a new forum post named threadName, else the post's title, else the
// text's first line (cut to DISCORD_THREAD_NAME_MAX), with the forum's tag ids; threadId posts into an existing thread
// instead. Absent is a message in the webhook's channel, as before. The adapter's discordOptionsOf in @crove/channel
// reads the same shape and names the same limits.
export const DISCORD_THREAD_NAME_MAX = 100;
export const DISCORD_TAGS_MAX = 5;
const DISCORD_ID = /^\d{17,20}$/;
export const isDiscordId = (id: string): boolean => DISCORD_ID.test(id);
export interface DiscordOptions {
  forum: boolean;
  // As typed; validateVariant checks each value.
  threadName: string | null;
  tags: string[];
  threadId: string | null;
}
// The options in a variant's settings: null when there are none, 'invalid' when they are not an object of those keys
// with a true-or-false forum, a text name and thread id, and a list of texts as tags.
export function discordOptionsOf(settings: Readonly<Record<string, unknown>> | undefined): DiscordOptions | 'invalid' | null {
  const raw = settings?.discord;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'forum' && k !== 'threadName' && k !== 'tags' && k !== 'threadId')) return 'invalid';
  if ((r.forum !== undefined && typeof r.forum !== 'boolean') || (r.threadName !== undefined && typeof r.threadName !== 'string') || (r.threadId !== undefined && typeof r.threadId !== 'string')) return 'invalid';
  if (r.tags !== undefined && (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== 'string'))) return 'invalid';
  return { forum: r.forum === true, threadName: (r.threadName as string | undefined) ?? null, tags: (r.tags as string[] | undefined) ?? [], threadId: (r.threadId as string | undefined) ?? null };
}
// Whether a Discord variant goes out as a new forum post, which takes the post's title as its name.
export const isDiscordForum = (provider: string, settings: Readonly<Record<string, unknown>> | undefined): boolean => {
  if (provider !== 'discord') return false;
  const options = discordOptionsOf(settings);
  return options !== null && options !== 'invalid' && options.forum;
};
// At most `max` UTF-16 code units, never ending on half of a surrogate pair.
function cutUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd();
}
// A forum post's name as the adapter sends it: the one given, else the post's title, else the first line of its text,
// cut to Discord's limit; '' when there is none (files alone, with no title).
export function discordThreadName(own: string | null, title: string | null, text: string): string {
  const name = own?.trim() || title?.trim() || (text.split('\n').find((line) => line.trim() !== '') ?? '').trim();
  return cutUtf16(name.replace(/\s+/g, ' '), DISCORD_THREAD_NAME_MAX);
}

// What social.publish.record stores as a published variant's note (error_code, with no error kind) when the platform
// took the post as a draft in its own app (#903): not public yet and with no post id, so it is never read as out.
export const SENT_TO_APP = 'SENT_TO_APP';
// The same for a WordPress post kept on the site as a draft, or pending an editor's review (#981): on the site with an
// id, but not public, so it is recorded with no post id or address and never read as out.
export const WORDPRESS_DRAFT = 'WORDPRESS_DRAFT';
export const WORDPRESS_PENDING = 'WORDPRESS_PENDING';
// Every note of a published variant that is not public yet.
export const NOT_PUBLIC_NOTES: readonly string[] = [SENT_TO_APP, WORDPRESS_DRAFT, WORDPRESS_PENDING];

// WordPress options (#981), in `settings.wordpress`: category and tag names, an excerpt and a status. The adapter's
// wordpressOptionsOf in @crove/channel reads the same shape.
export const WORDPRESS_STATUSES = ['publish', 'draft', 'pending'] as const;
export type WordPressStatus = (typeof WORDPRESS_STATUSES)[number];
// The status a WordPress variant asks for: publish when it names none; null when it names one WordPress would not take.
export function wordpressStatusOf(settings: Readonly<Record<string, unknown>> | undefined): WordPressStatus | null {
  const raw = settings?.wordpress;
  const status = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { status?: unknown }).status : undefined;
  if (status === undefined || status === null) return 'publish';
  return (WORDPRESS_STATUSES as readonly unknown[]).includes(status) ? (status as WordPressStatus) : null;
}
export const WORDPRESS_CATEGORIES_MAX = 10;
export const WORDPRESS_TAGS_MAX = 20;
export const WORDPRESS_EXCERPT_MAX = 500;
// WordPress keeps a term's name in a 200-character column.
export const WORDPRESS_TERM_MAX = 200;

// YouTube refuses a thumbnail over 2 MB (thumbnails.set); Zalo an article image over 1 MB, a video article's thumbnail
// among them (#1429).
// Facebook documents no size for a video's `thumb` (#1499): 10 MB, the limit of its thumbnails edge, is the cap
// [unverified].
export const COVER_IMAGE_MAX_BYTES: Readonly<Partial<Record<Provider, number>>> = { youtube: 2 * 1024 * 1024, zalo_oa: 1024 * 1024, facebook_page: 10 * 1024 * 1024 };

// A LinkedIn document's title (#1119), `settings.linkedin.documentTitle`: 1 to DOCUMENT_TITLE_MAX characters once
// trimmed, counted as LinkedIn counts its text. Unsaid, the adapter sends the post's title or the file's name. The
// adapter's linkedinDocumentTitleOf in @crove/channel reads the same shape and limit (LinkedIn's docs give none; 58 is
// the one schedulers that post documents hold to).
export const DOCUMENT_TITLE_MAX = 58;
export const DOCUMENT_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['linkedin', 'linkedin_page']);
export function documentTitleOf(settings: Readonly<Record<string, unknown>> | undefined): string | null | 'invalid' {
  const linkedin = settings?.linkedin;
  if (linkedin === undefined || linkedin === null) return null;
  if (typeof linkedin !== 'object' || Array.isArray(linkedin)) return 'invalid';
  const title = (linkedin as { documentTitle?: unknown }).documentTitle;
  if (title === undefined || title === null) return null;
  if (typeof title !== 'string') return 'invalid';
  const trimmed = title.trim();
  const size = trimmed.normalize('NFC').length;
  return size < 1 || size > DOCUMENT_TITLE_MAX ? 'invalid' : trimmed;
}

// Link cards (#1498), in `settings.linkCard`: { title, description?, thumbFileId? }. LinkedIn (member and page) and
// Bluesky build no preview from a link (scrapesLinkPreview false), so a link post there goes out with the card the
// member kept: the composer prefills it from the link preview it fetched (#641) and the member edits it, and its image
// is one of the org's Social uploads, never the fetched page image. A card goes on a link post with no media (LinkedIn's
// content.article and Bluesky's app.bsky.embed.external are the post's one content, so images win), and then the link
// is not added to the text. The title (1 to 200 characters) and description (at most 300) are Crove's caps, as neither
// platform documents one [unverified]; Bluesky takes a thumbnail of at most 1,000,000 bytes. The adapters' linkCardOf
// in @crove/channel reads the same shape and limits.
export const LINK_CARD_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['linkedin', 'linkedin_page', 'bluesky']);
export const LINK_CARD_TITLE_MAX = 200;
export const LINK_CARD_DESCRIPTION_MAX = 300;
export const LINK_CARD_THUMB_TYPES: readonly string[] = ['image/jpeg', 'image/png'];
export const LINK_CARD_THUMB_MAX_BYTES: Readonly<Partial<Record<Provider, number>>> = { bluesky: 1_000_000 };
export interface LinkCard {
  title: string;
  // '' when the card has none.
  description: string;
  thumbFileId: string | null;
}
// Counted in code points of the NFC form, a Vietnamese letter with its marks as one.
export const linkCardSize = (text: string): number => countText(text, 'codepoints');
// The card in a variant's settings, trimmed: null when there is none, 'invalid' when it is not an object of those keys
// with a title of 1 to LINK_CARD_TITLE_MAX characters, a description of at most LINK_CARD_DESCRIPTION_MAX and a file id.
export function linkCardOf(settings: Readonly<Record<string, unknown>> | undefined): LinkCard | 'invalid' | null {
  const raw = settings?.linkCard;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'title' && k !== 'description' && k !== 'thumbFileId')) return 'invalid';
  if (typeof r.title !== 'string' || (r.description !== undefined && typeof r.description !== 'string') || (r.thumbFileId !== undefined && (typeof r.thumbFileId !== 'string' || r.thumbFileId === ''))) return 'invalid';
  const title = r.title.trim();
  const description = (r.description as string | undefined)?.trim() ?? '';
  if (linkCardSize(title) < 1 || linkCardSize(title) > LINK_CARD_TITLE_MAX || linkCardSize(description) > LINK_CARD_DESCRIPTION_MAX) return 'invalid';
  return { title, description, thumbFileId: (r.thumbFileId as string | undefined)?.toLowerCase() ?? null };
}
// The file id of a valid card's image, or null.
export function linkCardThumbOf(settings: Readonly<Record<string, unknown>> | undefined): string | null {
  const card = linkCardOf(settings);
  return card && card !== 'invalid' ? card.thumbFileId : null;
}
// Whether a variant goes out with its link card: a channel that takes one, a valid card, a link and no media.
export function carriesLinkCard(provider: Provider, settings: Readonly<Record<string, unknown>> | undefined, linkUrl: string | null | undefined, mediaCount: number): boolean {
  if (!LINK_CARD_PROVIDERS.has(provider) || mediaCount > 0 || !linkUrl?.trim()) return false;
  const card = linkCardOf(settings);
  return card !== null && card !== 'invalid';
}

// The channels whose Crove adapter posts video today (#410). A platform may take video while its adapter does not yet:
// the composer says so instead of letting a video fail at publish time. Each adapter that learns video joins here.
export const VIDEO_READY: ReadonlySet<Provider> = new Set<Provider>(['sandbox', 'youtube', 'tiktok', 'instagram', 'facebook_page', 'threads', 'x', 'linkedin', 'linkedin_page', 'telegram', 'mastodon', 'bluesky', 'pinterest', 'discord', 'zalo_oa']);

// The channels whose Crove adapter takes a published post down (#860, #1137, #1138; Zalo OA's article/remove, #1430);
// the others answer REMOVE_NOT_SUPPORTED until their adapter learns it. Telegram lets a bot delete a channel post only
// within 48 hours of it. Threads stays out: its delete endpoint needs the threads_delete permission, which Crove's
// Threads connect does not ask for.
export const REMOVE_READY: ReadonlySet<Provider> = new Set<Provider>(['sandbox', 'bluesky', 'mastodon', 'telegram', 'discord', 'x', 'facebook_page', 'youtube', 'linkedin', 'linkedin_page', 'pinterest', 'wordpress', 'google_business', 'zalo_oa']);

// The channels whose Crove adapter corrects a published post's text (#1223): Facebook Pages (`POST /{page-post-id}`),
// LinkedIn members and pages (a PARTIAL_UPDATE of the commentary), Mastodon (`PUT /api/v1/statuses/:id`), Telegram
// (`editMessageText`, `editMessageCaption`), Discord (editing the webhook's message) and Zalo OA (`article/update`
// with the whole article, its cover and images sent again, #1430), YouTube (`videos.update` of the snippet, read first
// and sent back whole, with the force-ssl scope), Google Business (`localPosts.patch` of the summary alone) and
// WordPress (`POST /wp/v2/posts/:id` of the text, its title and images kept; #1474). Instagram, Threads, Bluesky, X and
// TikTok have no edit Crove can make and answer EDIT_NOT_SUPPORTED. Pinterest stays out: it is not confirmed that its
// pin update works without boards:write, which Crove's Pinterest connect does not ask for.
export const EDIT_READY: ReadonlySet<Provider> = new Set<Provider>(['sandbox', 'facebook_page', 'linkedin', 'linkedin_page', 'mastodon', 'telegram', 'discord', 'zalo_oa', 'youtube', 'google_business', 'wordpress']);

// Why a published variant's text cannot be corrected (#1223), or null when it can: the channel has no edit
// ('provider'), the post is a poll, whose question or options no edit may change without resetting its votes ('poll'),
// or a Story or a Reel, whose text no edit reaches ('post_type'), as a Facebook video's description ('video') and a
// Zalo video article (#1429), whose video_id Crove does not keep to send again ('video'), or a WordPress post kept on
// the site as a draft or pending review, which has no public post to correct ('draft', #1474). Any YouTube video,
// a Short included, takes an edit of its description. The adapters refuse the same before any call.
export type EditRefusal = 'provider' | 'poll' | 'post_type' | 'video' | 'draft';
export function editRefusal(provider: string, settings: Readonly<Record<string, unknown>>, mediaKinds: readonly MediaKind[]): EditRefusal | null {
  if (!isProvider(provider) || !EDIT_READY.has(provider)) return 'provider';
  if (settings.poll !== undefined && settings.poll !== null) return 'poll';
  if (postTypeOf(settings) !== 'feed') return 'post_type';
  if ((provider === 'facebook_page' || provider === 'zalo_oa') && mediaKinds.includes('video')) return 'video';
  if (provider === 'wordpress' && wordpressStatusOf(settings) !== 'publish') return 'draft';
  return null;
}

// A post that comes down by itself (#861): `settings.removeAt`, a full ISO 8601 time with Z or an offset, on a channel
// in REMOVE_READY. It must be at least REMOVE_AT_MIN_GAP_MS and at most the channel's window (REMOVE_WINDOW_MS, else
// REMOVE_AT_MAX_MS) after the time the post goes out. The commands check that where the time becomes known (a time, a
// queue slot, a retry now); the worker's sweep checks it again against the time the post really went out, which a rate
// limit, a paused channel or a queue edit can move, and leaves a post outside it up. The same pattern guards the
// database's crove_social.remove_at_of.
export const REMOVE_AT_MIN_GAP_MS = 5 * 60_000;
// The furthest a takedown may be planned, so stale or far values never stay in the worker's scan.
export const REMOVE_AT_MAX_MS = 365 * 24 * 3_600_000;
// How long after a post the platform still lets Crove take it down, where it limits that: Telegram lets a bot delete a
// channel post within 48 hours only.
export const REMOVE_WINDOW_MS: Readonly<Partial<Record<Provider, number>>> = { telegram: 48 * 3_600_000 };
// The furthest a takedown may come after the post on this channel.
export const removeWindowMs = (provider: string): number => Math.min(isProvider(provider) ? (REMOVE_WINDOW_MS[provider] ?? REMOVE_AT_MAX_MS) : REMOVE_AT_MAX_MS, REMOVE_AT_MAX_MS);
const REMOVE_AT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

// The planned takedown in a variant's settings, as an ISO instant in UTC; null when there is none, 'invalid' when it is
// not a real calendar time in that form.
export function removeAtOf(settings: Readonly<Record<string, unknown>> | undefined): string | 'invalid' | null {
  const value = settings?.removeAt;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'invalid';
  const m = REMOVE_AT.exec(value);
  if (!m) return 'invalid';
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Date.parse rolls 31 February over into March; the database refuses it.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return 'invalid';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'invalid';
}

// Whether a variant's planned takedown fits the time it goes out: null when it does (or there is none, or it is
// malformed, which validation names); too_soon under REMOVE_AT_MIN_GAP_MS after it; too_late past the channel's window,
// with that window in hours.
export function removeAtFit(provider: string, settings: Readonly<Record<string, unknown>> | undefined, publishAt: Date): { problem: 'too_soon' } | { problem: 'too_late'; hours: number } | null {
  const at = removeAtOf(settings);
  if (at === null || at === 'invalid') return null;
  const t = Date.parse(at);
  if (t < publishAt.getTime() + REMOVE_AT_MIN_GAP_MS) return { problem: 'too_soon' };
  const window = removeWindowMs(provider);
  if (t > publishAt.getTime() + window) return { problem: 'too_late', hours: Math.round(window / 3_600_000) };
  return null;
}

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
  // Zalo OA values: the article/create reference (developers.zalo.me, OA content API). The cover is required, so one
  // image at least; the docs set no image count, and 10 is Crove's cap (#943): the first image is the cover, the others
  // follow the text as image blocks. Every image file is 1 MB at most. A video article (#1429) is one video alone, MP4
  // (Zalo takes MP4 and AVI; Crove uploads MP4 and QuickTime) of up to 50 MB, with no length limit in the docs, and
  // needs a cover image as its thumbnail (COVER_REQUIRED).
  zalo_oa: {
    provider: 'zalo_oa',
    body: { max: null, count: 'codepoints', required: true },
    title: { max: 150, count: 'codepoints', required: true },
    media: { min: 1, max: 10, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: 1 * MB, maxVideoBytes: 50 * MB, maxVideoSeconds: null, videoTypes: ['video/mp4'] },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: [],
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
    media: { min: 0, max: 20, kinds: ['image', 'video', 'document'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: null, maxVideoBytes: 500 * MB, maxVideoSeconds: 1800, maxDocumentBytes: 100 * MB },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: ['body.max', 'media.max'],
  },
  // A Company Page posts through the same Posts, Images, Videos and Documents APIs as the member (#1077), so the same
  // limits. A document (#1119) is one PDF of at most 100 MB (LinkedIn's limit; the library holds at most 25 MB).
  linkedin_page: {
    provider: 'linkedin_page',
    body: { max: 3000, count: 'utf16', required: false },
    title: null,
    media: { min: 0, max: 20, kinds: ['image', 'video', 'document'], mixed: false, maxVideos: 1, imageTypes: ANY_IMAGE, maxImageBytes: null, maxVideoBytes: 500 * MB, maxVideoSeconds: 1800, maxDocumentBytes: 100 * MB },
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
    // Up to 4 images (1 MB each, Bluesky's blob limit) or one MP4 of up to 3 minutes and 100 MB, through Bluesky's
    // video service (#455).
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
  // Pinterest (#798): a pin's title of 100 characters and description of 800, saved to a board; one image or a
  // carousel of 2 to 5, JPEG or PNG (kept to 10 MB each, sent in the request); or one MP4 or MOV video pin (#813).
  pinterest: {
    provider: 'pinterest',
    body: { max: 800, count: 'codepoints', required: false },
    title: { max: 100, count: 'codepoints', required: false },
    media: { min: 1, max: 5, kinds: ['image', 'video'], mixed: false, maxVideos: 1, imageTypes: ['image/jpeg', 'image/png'], maxImageBytes: 10 * MB, maxVideoBytes: 100 * MB, maxVideoSeconds: 900 },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: ['media.max'],
  },
  // Discord channels (#832), posted to through a webhook: a message of 2,000 characters (counted in UTF-16, never under
  // Discord's own count) and up to 10 images and videos uploaded with the call, 10 MB each and 25 MB for the whole
  // message (the adapter checks the sum). Discord shows the link's preview itself.
  discord: {
    provider: 'discord',
    body: { max: 2000, count: 'utf16', required: false },
    title: null,
    media: { min: 0, max: 10, kinds: ['image', 'video'], mixed: true, maxVideos: 10, imageTypes: ['image/jpeg', 'image/png', 'image/webp'], maxImageBytes: 10 * MB, maxVideoBytes: 10 * MB, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: true,
    unverified: [],
  },
  // WordPress (#833): a blog post through the site's REST API. WordPress sets no length on a post; 100,000 characters is
  // Crove's own cap. The title is the post's own or the text's first line; up to 10 images (JPEG, PNG, WebP or GIF, kept
  // to 10 MB each, as many hosts cap uploads near there) go to the media library and after the text, the first as the
  // featured image. No video.
  wordpress: {
    provider: 'wordpress',
    body: { max: 100_000, count: 'codepoints', required: true },
    title: { max: 200, count: 'codepoints', required: false },
    media: { min: 0, max: 10, kinds: ['image'], mixed: false, maxVideos: 0, imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], maxImageBytes: 10 * MB, maxVideoBytes: null, maxVideoSeconds: null },
    maxLinks: null,
    scrapesLinkPreview: false,
    unverified: [],
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
// Who sees a LinkedIn post (#983), in the same `settings.visibility`: public (the default, sent as PUBLIC as before),
// connections (CONNECTIONS, the member's 1st-degree network) or loggedIn (LOGGED_IN, signed-in members). Crove posts as
// the member, so all three apply. The adapter maps the same values.
export const LINKEDIN_VISIBILITY = ['public', 'connections', 'loggedIn'] as const;
export type LinkedInVisibility = (typeof LINKEDIN_VISIBILITY)[number];
// A Company Page (#1077) has no connections, so its post is public or for signed-in members only.
export const LINKEDIN_PAGE_VISIBILITY = ['public', 'loggedIn'] as const;
// The visibility values a LinkedIn provider takes, or null for any other provider.
export function linkedinVisibilities(provider: string): readonly LinkedInVisibility[] | null {
  return provider === 'linkedin' ? LINKEDIN_VISIBILITY : provider === 'linkedin_page' ? LINKEDIN_PAGE_VISIBILITY : null;
}
export const CONTENT_WARNING_MAX = 500;

// YouTube video details (#905), read by the adapter in the same shapes: the audience (`settings.madeForKids`, a
// boolean; absent is not made for kids, as for every variant saved before it could be chosen), the category
// (`settings.categoryId`, one of YouTube's assignable video categories, absent is 22, People & Blogs) and the tags
// (`settings.tags`, a list of strings), and since #1078 whether it holds realistic altered or synthetic content
// (`settings.syntheticMedia`, true when on and not stored when off; sent as status.containsSyntheticMedia). Paid product
// placement is not settable through the Data API's videos.insert, so it is declared in YouTube Studio. The categories are the ones videoCategories.list marks assignable; YouTube
// has kept them unchanged for years, so they are a fixed list rather than a call.
export const YOUTUBE_CATEGORIES = ['1', '2', '10', '15', '17', '19', '20', '22', '23', '24', '25', '26', '27', '28', '29'] as const;
export type YouTubeCategory = (typeof YOUTUBE_CATEGORIES)[number];
export const YOUTUBE_DEFAULT_CATEGORY: YouTubeCategory = '22';
export const YOUTUBE_TAGS_MAX = 500;

// The tags as YouTube counts them against its 500 characters: each tag's characters, a comma between tags, and the
// quotes YouTube puts around a tag that holds a space ("Foo Baz" is nine characters, Foo-Baz seven). Each tag is
// counted trimmed, as the adapter sends it; a Vietnamese letter with its marks is one character.
export function youtubeTagsLength(tags: readonly string[]): number {
  return tags.reduce((n, tag, i) => {
    const t = tag.trim();
    return n + countText(t, 'codepoints') + (/\s/.test(t) ? 2 : 0) + (i > 0 ? 1 : 0);
  }, 0);
}

// The tags in a variant's settings: null when there are none, 'invalid' when the value is not a list of strings.
export function youtubeTagsOf(settings: Readonly<Record<string, unknown>> | undefined): string[] | 'invalid' | null {
  const value = settings?.tags;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return 'invalid';
  return value.length > 0 ? (value as string[]) : null;
}

// YouTube playlists (#1018), in `settings.youtube`: { playlistIds: [...] }, the channel's own playlists the video goes
// into once it is out, each as its own step after the post (playlists.ts), so a refused insert leaves the video
// published. At most YOUTUBE_PLAYLISTS_MAX. Not stored when empty, so a variant saved before keeps its content hash.
export const YOUTUBE_PLAYLISTS_MAX = 5;
// A playlist a channel made itself (YOUTUBE_PLAYLIST_ID in @crove/channel, which sends it): PL and 16 or 32 more characters.
export const YOUTUBE_PLAYLIST_ID = /^PL[A-Za-z0-9_-]{16,32}$/;

// The playlist ids in a variant's settings: null when there are none, 'invalid' when settings.youtube is not an object
// holding only playlistIds, a list of distinct playlist ids. More than the maximum is returned as is, for validation to
// count.
export function youtubePlaylistsOf(settings: Readonly<Record<string, unknown>> | undefined): string[] | 'invalid' | null {
  const raw = settings?.youtube;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'playlistIds')) return 'invalid';
  const ids = r.playlistIds;
  if (ids === undefined) return null;
  if (!Array.isArray(ids) || ids.length > 50 || !ids.every((id) => typeof id === 'string' && YOUTUBE_PLAYLIST_ID.test(id))) return 'invalid';
  if (new Set(ids).size !== ids.length) return 'invalid';
  return ids.length > 0 ? (ids as string[]) : null;
}

// The playlist id in what a person pastes: the id itself, or a YouTube link that names it (youtube.com/playlist?list=,
// a watch link with &list=, youtu.be or m.youtube.com). null when it names no playlist a channel made.
export function youtubePlaylistIdFrom(text: string): string | null {
  const t = text.trim();
  if (YOUTUBE_PLAYLIST_ID.test(t)) return t;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return null;
  const list = url.searchParams.get('list');
  return list && YOUTUBE_PLAYLIST_ID.test(list) ? list : null;
}

// The Pinterest board section a pin goes into (#1120): settings.pinterest.sectionId, one of the board's sections as the
// composer listed them (PINTEREST_SECTION_ID in @crove/channel, which sends it and checks it against the board again).
// Not stored without one, so a variant saved before keeps its content hash.
export const PINTEREST_SECTION_ID = /^\d{1,32}$/;

// The section id in a variant's settings: null when there is none, 'invalid' when settings.pinterest is not an object
// holding only a section id.
export function pinterestSectionOf(settings: Readonly<Record<string, unknown>> | undefined): string | 'invalid' | null {
  const raw = settings?.pinterest;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'sectionId')) return 'invalid';
  if (r.sectionId === undefined) return null;
  return typeof r.sectionId === 'string' && PINTEREST_SECTION_ID.test(r.sectionId) ? r.sectionId : 'invalid';
}

// The channels whose composer lists options to pick from (#1120), and what each lists: a board's sections, a YouTube
// channel's playlists and a WordPress site's categories and tags (#1131). One list per channel.
export const CHANNEL_OPTION_KIND_OF: Readonly<Partial<Record<Provider, 'pinterest_section' | 'youtube_playlist' | 'wordpress_term'>>> = {
  pinterest: 'pinterest_section',
  youtube: 'youtube_playlist',
  wordpress: 'wordpress_term',
};

// Instagram people (#796): up to 3 collaborators (`settings.collaborators`, on feed posts and Reels; each must accept
// the invitation in Instagram) and up to 20 people tagged on the first image (`settings.userTags`, image posts only).
// Usernames as Instagram writes them, without the @. The adapter reads the same shapes.
export const IG_COLLABORATORS_MAX = 3;
export const IG_USER_TAGS_MAX = 20;
export const IG_USERNAME = /^[a-z0-9._]{1,30}$/;

// An Instagram caption's caps besides its 2,200 characters (#1190; Meta's IG User Media reference: "Maximum 2200
// characters, 30 hashtags, and 20 @ tags"), counted in the caption as it is sent (with the signature). Each place
// counts: a tag written twice is two.
export const IG_HASHTAGS_MAX = 30;
export const IG_MENTIONS_MAX = 20;
// A hashtag: # and a word, not inside a word or an HTML entity; an @ tag: @ and an Instagram username, not inside a
// word or an email address.
const CAPTION_HASHTAG = /(?<![\p{L}\p{N}_&#])#[\p{L}\p{M}\p{N}_]+/gu;
const CAPTION_MENTION = /(?<![\p{L}\p{N}_.@])@[A-Za-z0-9._]{1,30}/gu;
export const captionHashtags = (text: string): number => [...text.normalize('NFC').matchAll(CAPTION_HASHTAG)].length;
export const captionMentions = (text: string): number => [...text.normalize('NFC').matchAll(CAPTION_MENTION)].length;

// The usernames in settings[key]: null when there are none, 'invalid' when the value is not a list of usernames.
export function instagramPeopleOf(settings: Readonly<Record<string, unknown>> | undefined, key: 'collaborators' | 'userTags'): string[] | 'invalid' | null {
  const value = settings?.[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 50 || !value.every((v) => typeof v === 'string' && IG_USERNAME.test(v))) return 'invalid';
  const names = [...new Set(value as string[])];
  return names.length > 0 ? names : null;
}

// Where an Instagram Reel shows (#1019), in `settings.instagram`: { reelFeed, trialGraduation? }. feed (the default, not
// stored) shows it in the feed and on the profile grid as before (share_to_feed true); reels_only keeps it to the Reels
// tab, off the grid (share_to_feed false); trial makes it a trial Reel, shown to people who do not follow the account
// first (trial_params), which goes to followers once graduated: by hand in the Instagram app (manual, the default) or by
// Instagram when it does well (performance). Only a Reel takes it, never a Story, an image or a carousel. The adapter's
// instagramReelFormOf in @crove/channel reads the same shape.
export const IG_REEL_FEEDS = ['feed', 'reels_only', 'trial'] as const;
export type InstagramReelFeed = (typeof IG_REEL_FEEDS)[number];
export const IG_TRIAL_GRADUATIONS = ['manual', 'performance'] as const;
export type InstagramTrialGraduation = (typeof IG_TRIAL_GRADUATIONS)[number];
export interface InstagramReelOptions {
  reelFeed: InstagramReelFeed;
  // Set only on a trial Reel.
  trialGraduation: InstagramTrialGraduation | null;
}

// The Reel options in a variant's settings: null when there are none, 'invalid' when settings.instagram is not an
// object of those two keys with known values, or names a graduation on a Reel that is not a trial.
export function instagramReelOf(settings: Readonly<Record<string, unknown>> | undefined): InstagramReelOptions | 'invalid' | null {
  const raw = settings?.instagram;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'reelFeed' && k !== 'trialGraduation')) return 'invalid';
  const feed = r.reelFeed === undefined ? 'feed' : r.reelFeed;
  if (!(IG_REEL_FEEDS as readonly unknown[]).includes(feed)) return 'invalid';
  const graduation = r.trialGraduation;
  if (graduation !== undefined && (feed !== 'trial' || !(IG_TRIAL_GRADUATIONS as readonly unknown[]).includes(graduation))) return 'invalid';
  return { reelFeed: feed as InstagramReelFeed, trialGraduation: feed === 'trial' ? ((graduation as InstagramTrialGraduation | undefined) ?? 'manual') : null };
}

// Whether a variant's post is an Instagram Reel: one video, not a Story (a feed post of one video goes out as a Reel).
export function isInstagramReel(media: readonly { kind: MediaKind }[], settings: Readonly<Record<string, unknown>> | undefined): boolean {
  return media.length === 1 && media[0]?.kind === 'video' && postTypeOf(settings) !== 'story';
}

// Whether a Reel stays off the profile grid (#1019): kept to the Reels tab, or a trial Reel (which reaches followers
// only once graduated, and Crove does not learn when). The grid preview leaves these out.
export function instagramReelOffGrid(settings: Readonly<Record<string, unknown>> | undefined): boolean {
  const options = instagramReelOf(settings);
  return options !== null && options !== 'invalid' && options.reelFeed !== 'feed';
}

// Publishing limits Crove counts itself (#775, plan §3.6: "Rate limits and quotas tracked per app and per account"),
// for the channels whose API has no quota endpoint: how many posts one account may make in a window. Instagram and
// Threads read their own quota from the platform (#743). The numbers are the platforms' documented per-account limits,
// kept a little under where they are approximate: TikTok about 15 posts a day per creator, YouTube's 100 uploads a day,
// X 100 posts per 15 minutes per user, LinkedIn 150 member posts a day (a page's posts count against its member's).
export interface PublishLimit {
  count: number;
  windowMs: number;
}
export const PUBLISH_LIMITS: Readonly<Partial<Record<Provider, PublishLimit>>> = {
  tiktok: { count: 15, windowMs: 24 * 3_600_000 },
  youtube: { count: 100, windowMs: 24 * 3_600_000 },
  x: { count: 100, windowMs: 15 * 60_000 },
  linkedin: { count: 150, windowMs: 24 * 3_600_000 },
  linkedin_page: { count: 150, windowMs: 24 * 3_600_000 },
};

// Providers whose accounts post with one person's token and share that person's limit (#1096): every LinkedIn Company
// Page posts with the token of the member who connected it, and LinkedIn counts the member's daily calls across their
// own channel and all their pages. Such a limit counts the posts of every channel of these providers in the org that the
// same member connected (connected_by; a reconnect by another member moves the channel, and its past posts, to them).
// The member's channels in other orgs are not seen, so a member who posts there too may still meet LinkedIn's 429,
// which waits as any rate limit does.
export const SHARED_LIMIT_PROVIDERS: Readonly<Partial<Record<Provider, readonly Provider[]>>> = {
  linkedin: ['linkedin', 'linkedin_page'],
  linkedin_page: ['linkedin', 'linkedin_page'],
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

// Media a channel fetches by URL (#772): on a deployment whose storage hands out no public file URLs (local disk), these
// cannot go out, so the composer says so before the post is submitted. Instagram takes a Reel or a video Story without
// one (Crove uploads the bytes), but not images, carousels or a cover image; Threads, Google Business, Zalo OA (its
// images, and a video article's cover image, #1429) and TikTok photos are fetched by URL always.
export function needsPublicUrls(provider: Provider, media: readonly { kind: MediaKind }[], settings?: Readonly<Record<string, unknown>>): boolean {
  if (media.length === 0) return false;
  switch (provider) {
    case 'instagram': {
      const cover = coverOf(settings);
      return media.length > 1 || media[0]?.kind === 'image' || (cover !== null && 'fileId' in cover);
    }
    case 'threads':
    case 'google_business':
    case 'zalo_oa':
      return true;
    case 'tiktok':
      return media.some((m) => m.kind === 'image');
    default:
      return false;
  }
}
