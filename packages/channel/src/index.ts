// Channel providers (ADR-0025 decision 3, Social plan §3.6). The kernel keeps connections and sealed tokens; a
// provider knows how to connect an account and, from later steps on, how to publish, reconcile and read metrics.
// Each capability is its own small interface, added by the step that first needs it.
import { randomBytes } from 'node:crypto';
import type { PostType } from './post-type.ts';
import type { ChannelOptionsInput, ChannelOptionsResult } from './options.ts';
import type { Audience } from './audience.ts';

export * from './oauth.ts';
export * from './text.ts';
export * from './meta.ts';
export * from './instagram.ts';
export * from './zalo.ts';
export * from './bluesky.ts';
export * from './threads.ts';
export * from './linkedin.ts';
export * from './google-business.ts';
export * from './telegram.ts';
export * from './mastodon.ts';
export * from './youtube.ts';
export * from './tiktok.ts';
export * from './x.ts';
export * from './pinterest.ts';
export * from './discord.ts';
export * from './wordpress.ts';
export * from './comment.ts';
export * from './cover.ts';
export * from './post-type.ts';
export * from './recent.ts';
export * from './audience.ts';
export * from './options.ts';

export const CHANNEL_PROVIDERS = [
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
  // LinkedIn Company Pages (#1077), with the LinkedIn app once it has the Community Management API.
  'linkedin_page',
] as const;
export type ChannelProviderId = (typeof CHANNEL_PROVIDERS)[number];

export function isChannelProvider(value: string): value is ChannelProviderId {
  return (CHANNEL_PROVIDERS as readonly string[]).includes(value);
}

// An account a provider connected, with the tokens the kernel seals. `secret` never leaves the server: the
// caller seals it with the credential broker and drops it.
export interface ConnectedAccount {
  provider: ChannelProviderId;
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  // When the access token expires, if the provider says; null when it does not expire on a timer.
  expiresAt: Date | null;
  secret: string;
}

// The offline sandbox (Social plan §3.5): no network, so the whole flow runs on a laptop and in tests. Its token is
// random, and it is sealed and stored like any other, so the credential path is exercised end to end. The account
// id derives from a caller-chosen key, so connecting again with the same key reconnects the same account.
export const sandbox = {
  id: 'sandbox' as const,
  connect(input: { key: string; displayName: string }): ConnectedAccount {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(input.key)) throw new Error('invalid sandbox account key');
    return {
      provider: 'sandbox',
      externalAccountId: `sandbox-${input.key.toLowerCase()}`,
      displayName: input.displayName,
      scopes: ['publish'],
      expiresAt: null,
      secret: JSON.stringify({ accessToken: `sbx_${randomBytes(24).toString('base64url')}` }),
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Publishing (Social plan §3.4 and §3.6, step S4). The publish job runs each provider step at most once per attempt
// unless the step is safe to repeat, so every step declares how it behaves when repeated:
// - safe: nothing visible happens (for example creating an Instagram container);
// - idempotent: the provider dedupes a repeat (Bluesky's client-chosen record key);
// - reconcile_only: the provider can be asked whether it went through;
// - never: no way to ask; an unknown outcome goes to a human.
export type RetrySafety = 'safe' | 'idempotent' | 'reconcile_only' | 'never';

export const PUBLISH_ERROR_KINDS = ['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown'] as const;
export type PublishErrorKind = (typeof PUBLISH_ERROR_KINDS)[number];

// An image of the post, by file. The bytes come from `PublishInput.readMedia`, which reads the exact stored version
// and checks its hash.
export interface PublishMedia {
  fileId: string;
  mime: string;
  sizeBytes: number;
  altText: string | null;
  // A video's length, read at upload; null or absent for images and videos uploaded before durations were read.
  durationSeconds?: number | null;
}

export interface PublishContent {
  body: string;
  title: string | null;
  linkUrl: string | null;
  media: readonly PublishMedia[];
}

export interface PublishInput {
  externalAccountId: string;
  // The opened credential (the provider's own JSON); never logged or stored by the adapter.
  secret: string;
  content: PublishContent;
  // The bytes of one of content.media; throws when the file cannot be read. An adapter reads every image before its
  // first visible call, so a read failure is a rejection with nothing posted.
  readMedia(fileId: string): Promise<Uint8Array>;
  // A short-lived public URL for one of content.media, for platforms that fetch images themselves (Instagram); null
  // when the deployment's storage cannot hand one out (local disk).
  mediaUrl(fileId: string): Promise<string | null>;
  // The name one of content.media was uploaded under, for a platform that shows it (a LinkedIn document's title when
  // the post gives none, #1119); null when unknown. Absent in callers that have no names.
  mediaName?(fileId: string): Promise<string | null>;
  // The variant's provider settings; a video's cover (#642) is `settings.cover`, read with videoCoverOf. readMedia and
  // mediaUrl also serve a cover image's file.
  settings: Record<string, unknown>;
  // The external_call key of this step: unique per attempt, so a provider with idempotency keys can use it.
  callKey: string;
  // sha256:<hex> of the variant's effective content, for reconciling.
  contentHash: string;
}

// What a provider answered. `rejected` means nothing was posted; anything the adapter cannot tell apart from a post
// that went through is `unknown`. An adapter returns these and never throws for a platform answer; a throw is
// treated as `unknown`.
export type PublishResult =
  // sentToApp: the platform took the post as a draft that the account finishes and posts in the platform's own app
  // (TikTok's inbox upload, #903). It is not public yet and has no post id: externalId is the platform's tracking id.
  // draft: the site keeps the post unpublished, as a draft or pending an editor's review (WordPress, #981); it is not
  // public, has no address, and is recorded like the inbox draft. externalId is the site's post id.
  | { kind: 'accepted'; externalId: string; url: string | null; sentToApp?: true; draft?: 'draft' | 'pending' }
  // Accepted, still processing on the platform (an Instagram container, a Zalo article): check again later.
  | { kind: 'pending'; externalRef: string; checkAfterSeconds: number }
  | { kind: 'rejected'; error: Exclude<PublishErrorKind, 'unknown'>; code?: string; message?: string; httpStatus?: number; retryAt?: Date }
  | { kind: 'unknown'; code?: string; message?: string };

export interface StatusInput {
  externalAccountId: string;
  secret: string;
  externalRef: string;
}

export interface ReconcileInput {
  externalAccountId: string;
  secret: string;
  callKey: string;
  contentHash: string;
  content: PublishContent;
  // The variant's provider settings (its post type, #644): a Story or a Reel cannot be matched by its text.
  settings?: Readonly<Record<string, unknown>>;
  // The window the post would have appeared in.
  after: Date;
  before: Date;
}

// found: the post is on the platform (draft: kept unpublished there, as in PublishResult); missing: it is not; unknown:
// the provider cannot be asked or did not answer.
export type ReconcileResult = { found: true; externalId: string; url: string | null; draft?: 'draft' | 'pending' } | { found: false } | { found: 'unknown' };

// Renews a connection's tokens before they expire (providers with short-lived tokens and refresh tokens, such as Zalo
// OA). refused: the provider turned the refresh down and the connection needs reconnecting; failed: try again later.
export interface Refresher {
  readonly provider: ChannelProviderId;
  // How long before expiry to renew (6 hours when unset): long-lived tokens are renewed days ahead.
  readonly horizonSeconds?: number;
  refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }>;
}

// What a platform reports for a published post (Social plan S8). Counts use these names whatever the platform calls
// them; a count the platform does not report is left out, never zero. Anything else goes in extra.
export const POST_METRIC_NAMES = ['impressions', 'reach', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'views'] as const;
// What a Story reports besides (#1082, Instagram's Story insights): replies, the taps forward and back, the exits and the
// swipes to the next story (its navigation), the follows it brought and the profile visits from it.
export const STORY_METRIC_NAMES = ['replies', 'tapsForward', 'tapsBack', 'exits', 'nextStory', 'follows', 'profileVisits'] as const;
// What a Reel reports besides (#1147, Instagram's Reels insights), in milliseconds: the average time a play lasted and
// the time it was played in all, replays included.
export const REEL_METRIC_NAMES = ['avgWatchTimeMs', 'totalWatchTimeMs'] as const;
// The names that are an average per post, not a count: a sum over posts means nothing, so totals leave them out.
export const AVERAGE_METRIC_NAMES: readonly string[] = ['avgWatchTimeMs'];
export const METRIC_NAMES = [...POST_METRIC_NAMES, ...STORY_METRIC_NAMES, ...REEL_METRIC_NAMES] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
export interface MetricsInput {
  externalAccountId: string;
  secret: string;
  externalId: string;
  // The variant's post type when it is not a feed post (#1082): a Story is asked for the Story metrics, a Reel for its
  // watch time besides (#1147).
  postType?: PostType;
}
export type MetricsResult = { metrics: Partial<Record<MetricName, number>>; extra?: Record<string, unknown> } | { refused: 'token_expired' | 'gone' } | null;

// What a platform says about a connected account itself (#645): its followers (subscribers on YouTube), and the people
// it reached over the last day where the platform gives that. null: no answer worth keeping (a network failure, a
// malformed answer); refused: the token or the permission was refused.
// audience (#1146): asked for only when the input says so (the sweep does once a week). Instagram and Threads answer
// with who follows the account, or null when they give nothing (under 100 followers, no insights permission on an
// older connection); the followers are reported all the same. Absent: not asked, or the platform has no such thing.
export interface AccountMetricsInput {
  externalAccountId: string;
  secret: string;
  audience?: boolean;
}
export type AccountMetricsResult = { followers: number | null; reach?: number | null; audience?: Audience | null } | { refused: 'token_expired' | 'permission' } | null;

// The posts an account published itself, outside Crove (#1054), so the Metrics tab and the client report can count
// every post of the account when asked. since: how far back, clamped to RECENT_POSTS_MAX_DAYS before now. null: no
// answer worth keeping; refused: the token or the permission was refused. The caller drops the posts Crove published.
// The bounds and helpers are in recent.ts.
export interface RecentPostsInput {
  externalAccountId: string;
  secret: string;
  since: Date;
}
export interface RecentPost {
  // The platform's id of the post, in the shape publish answers and metrics reads.
  externalId: string;
  // The post's text as the platform gives it ('' without one); the caller bounds it.
  text: string;
  // The post's page on the platform: https on the platform's own host, else null.
  permalink: string | null;
  publishedAt: Date;
}
export type RecentPostsResult = { posts: RecentPost[] } | { refused: 'token_expired' | 'permission' } | null;

// A first comment under a published post (#587, #609): a comment where the platform has comments (LinkedIn, Facebook
// Pages, Instagram), a reply in the post's thread where it has none (X, Bluesky, Threads). The comment never touches
// the post; a failure leaves it as it is.
export interface CommentInput {
  externalAccountId: string;
  secret: string;
  // The published post's id, as publish returned it; for a thread's part (#742), the part it answers.
  externalId: string;
  // A thread's part: the thread's first post, where the platform names it in a reply (Bluesky's root).
  rootExternalId?: string;
  text: string;
  // The external_call key of this comment.
  callKey: string;
}
// A repost of the account's own published post (#773): a retweet on X, a repost on Threads and Bluesky, a boost on
// Mastodon. It answers like a comment: the repost's own id when accepted.
export interface RepostInput {
  externalAccountId: string;
  secret: string;
  // The published post's id, as publish returned it.
  externalId: string;
  // The external_call key of this repost.
  callKey: string;
}

// Pinning the account's own published post to the top of its chat (#982, Telegram). It answers like a comment: the
// pinned message's id when accepted. silent: the post went out without a sound, and so does the pin.
export interface PinInput {
  externalAccountId: string;
  secret: string;
  // The published post's id, as publish returned it (an album's first message).
  externalId: string;
  silent: boolean;
  // The external_call key of this pin.
  callKey: string;
}

// Adding the account's own published video to one of its playlists (#1018, YouTube). It answers like a comment: the
// playlist item's id when accepted.
export interface PlaylistInput {
  externalAccountId: string;
  secret: string;
  // The published video's id, as publish returned it.
  externalId: string;
  // The channel's own playlist the video goes into.
  playlistId: string;
  // The external_call key of this insert.
  callKey: string;
}

// Who may reply to and quote the account's own published post (#1102, Bluesky's threadgate and postgate records). It
// answers like a comment: the id of a gate record when accepted. settings: the variant's, which name the gates.
export interface GateInput {
  externalAccountId: string;
  secret: string;
  // The published post's id, as publish returned it (a thread's first post).
  externalId: string;
  settings: Readonly<Record<string, unknown>>;
  // The external_call key of this step.
  callKey: string;
}

export type CommentResult =
  | { kind: 'accepted'; externalId: string }
  | { kind: 'rejected'; error: Exclude<PublishErrorKind, 'unknown'>; code?: string; message?: string }
  | { kind: 'unknown'; code?: string; message?: string };

// Taking a published post down from its platform (#860). A post the platform no longer has (404, 410) counts as
// removed, so asking twice is harmless.
export interface RemoveInput {
  externalAccountId: string;
  secret: string;
  // The published post's id, as publish returned it.
  externalId: string;
  settings?: Readonly<Record<string, unknown>>;
}
// rejected: the post is still up (the platform refused, or nothing reached it); unknown: it may or may not be gone.
export type RemoveResult =
  | { kind: 'removed' }
  | { kind: 'rejected'; error: Exclude<PublishErrorKind, 'unknown'>; code?: string; message?: string; retryAt?: Date }
  | { kind: 'unknown'; code?: string };

// Correcting a published post's text on its platform (#1223). content: the post as it goes out after the edit, built
// as for publishing (the new text with its signature, the link with its UTM tags or short link, and the media it went
// out with, by file, never read again); only the text changes on the platform, and the adapter keeps everything else
// the post has there (its media, buttons, content warning, thread). Text only: a poll, a Story or a Reel is refused
// before any call. The same text twice is harmless, so an edit may be asked again after a failed or unclear one.
export interface EditInput {
  externalAccountId: string;
  secret: string;
  // The published post's id, as publish returned it.
  externalId: string;
  content: PublishContent;
  settings: Readonly<Record<string, unknown>>;
  // The external_call key of this edit.
  callKey: string;
}
// edited: the platform confirmed the new text; rejected: the post shows what it showed before; unknown: it may show
// either.
export type EditResult =
  | { kind: 'edited' }
  | { kind: 'rejected'; error: Exclude<PublishErrorKind, 'unknown'>; code?: string; message?: string }
  | { kind: 'unknown'; code?: string };

export interface Publisher {
  readonly provider: ChannelProviderId;
  readonly publishSafety: RetrySafety;
  // How long one call may take (a video upload takes minutes); the job's default when absent. It stays above the
  // adapter's own fetch timeout, so the adapter classifies its own abort, and under PUBLISH_STALE_SECONDS.
  readonly callTimeoutMs?: number;
  publish(input: PublishInput): Promise<PublishResult>;
  // A code for variant settings this deployment's adapter cannot send (#903: TikTok's inbox mode without
  // CHANNEL_TIKTOK_INBOX), or null. The job asks before anything else, so such a variant fails with nothing sent
  // instead of waiting on a permission its connection could never get.
  refusal?(settings: Readonly<Record<string, unknown>>): string | null;
  // Two-phase providers: where a pending post stands.
  status?(input: StatusInput): Promise<PublishResult>;
  // Providers that can be asked whether an earlier call went through.
  reconcile?(input: ReconcileInput): Promise<ReconcileResult>;
  // Providers that report how a post did: null when the platform did not answer (try again later), refused when the
  // token no longer works or the post is gone.
  metrics?(input: MetricsInput): Promise<MetricsResult>;
  // Providers that report an account's followers (#645), read once a day.
  accountMetrics?(input: AccountMetricsInput): Promise<AccountMetricsResult>;
  // Providers that list the account's own recent posts (#1054), so posts published outside Crove can be counted.
  listRecentPosts?(input: RecentPostsInput): Promise<RecentPostsResult>;
  // Providers that post a first comment (#587). Never retried by itself: an unclear answer goes to a person.
  comment?(input: CommentInput): Promise<CommentResult>;
  // Providers that repost the account's own post (#773). Never retried by itself, like a comment.
  repost?(input: RepostInput): Promise<CommentResult>;
  // Providers that pin a published post (#982). Never retried by itself, like a comment.
  pin?(input: PinInput): Promise<CommentResult>;
  // Providers that limit who may reply to or quote a published post with records of their own (#1102, Bluesky). Never
  // retried by itself, like a comment.
  gate?(input: GateInput): Promise<CommentResult>;
  // Providers that add a published video to playlists (#1018), one call a playlist. Never retried by itself, like a comment.
  playlist?(input: PlaylistInput): Promise<CommentResult>;
  // Providers that take a published post down (#860), when a person asks.
  remove?(input: RemoveInput): Promise<RemoveResult>;
  // Providers that correct a published post's text (#1223), when a person asks. Never retried by itself.
  edit?(input: EditInput): Promise<EditResult>;
  // Providers whose channel offers options to pick from in the composer (#1120), read by the worker only.
  options?(input: ChannelOptionsInput): Promise<ChannelOptionsResult>;
}

interface SandboxPost {
  id: string;
  callKey: string;
  contentHash: string;
  body: string;
  at: Date;
}

// The sandbox platform: posts live in this process's memory, per account. A worker restart forgets them, so a post
// whose result was lost in a crash cannot be found again and goes to a human, as on a platform that cannot be asked.
export class SandboxPublisher implements Publisher {
  readonly provider = 'sandbox' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly accounts = new Map<string, SandboxPost[]>();

  // A comment on a post the sandbox holds, or a reply to one of its comments (a thread's part, #742), kept beside it.
  readonly comments: { postId: string; text: string; callKey: string; id: string; rootId?: string }[] = [];

  // A repost of a post the sandbox holds, kept beside it (#773).
  readonly reposts: { postId: string; callKey: string; id: string }[] = [];

  async repost(input: RepostInput): Promise<CommentResult> {
    const accessToken = (JSON.parse(input.secret) as { accessToken?: unknown }).accessToken;
    if (typeof accessToken !== 'string' || !accessToken.startsWith('sbx_')) return { kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' };
    if (!(this.accounts.get(input.externalAccountId) ?? []).some((p) => p.id === input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'NO_SUCH_POST' };
    const id = `sbx_repost_${randomBytes(9).toString('base64url')}`;
    this.reposts.push({ postId: input.externalId, callKey: input.callKey, id });
    return { kind: 'accepted', externalId: id };
  }

  async comment(input: CommentInput): Promise<CommentResult> {
    const accessToken = (JSON.parse(input.secret) as { accessToken?: unknown }).accessToken;
    if (typeof accessToken !== 'string' || !accessToken.startsWith('sbx_')) return { kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' };
    const posts = this.accounts.get(input.externalAccountId) ?? [];
    const onPost = posts.some((p) => p.id === input.externalId);
    const onReply = this.comments.some((c) => c.id === input.externalId) && posts.some((p) => p.id === input.rootExternalId);
    if (!onPost && !onReply) return { kind: 'rejected', error: 'bad_request', code: 'NO_SUCH_POST' };
    const id = `sbx_comment_${randomBytes(9).toString('base64url')}`;
    this.comments.push({ postId: input.externalId, text: input.text, callKey: input.callKey, id, ...(input.rootExternalId ? { rootId: input.rootExternalId } : {}) });
    return { kind: 'accepted', externalId: id };
  }
  async publish(input: PublishInput): Promise<PublishResult> {
    const accessToken = (JSON.parse(input.secret) as { accessToken?: unknown }).accessToken;
    if (typeof accessToken !== 'string' || !accessToken.startsWith('sbx_')) return { kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' };
    const id = `sbx_post_${randomBytes(9).toString('base64url')}`;
    const posts = this.accounts.get(input.externalAccountId) ?? [];
    posts.push({ id, callKey: input.callKey, contentHash: input.contentHash, body: input.content.body, at: new Date() });
    this.accounts.set(input.externalAccountId, posts);
    return { kind: 'accepted', externalId: id, url: null };
  }

  // Takes the post off the sandbox (#860); one it no longer holds is gone already.
  async remove(input: RemoveInput): Promise<RemoveResult> {
    const accessToken = (JSON.parse(input.secret) as { accessToken?: unknown }).accessToken;
    if (typeof accessToken !== 'string' || !accessToken.startsWith('sbx_')) return { kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' };
    const posts = this.accounts.get(input.externalAccountId) ?? [];
    this.accounts.set(input.externalAccountId, posts.filter((p) => p.id !== input.externalId));
    return { kind: 'removed' };
  }

  // Changes the text of a post the sandbox holds (#1223); one it no longer holds cannot be edited.
  async edit(input: EditInput): Promise<EditResult> {
    const accessToken = (JSON.parse(input.secret) as { accessToken?: unknown }).accessToken;
    if (typeof accessToken !== 'string' || !accessToken.startsWith('sbx_')) return { kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' };
    const post = (this.accounts.get(input.externalAccountId) ?? []).find((p) => p.id === input.externalId);
    if (!post) return { kind: 'rejected', error: 'bad_request', code: 'NO_SUCH_POST' };
    post.body = input.content.body;
    return { kind: 'edited' };
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const post = (this.accounts.get(input.externalAccountId) ?? []).find((p) => p.callKey === input.callKey || (p.contentHash === input.contentHash && p.at >= input.after && p.at <= input.before));
    return post ? { found: true, externalId: post.id, url: null } : { found: false };
  }

  // Counts that grow with the post's age, so the local demo shows something.
  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const post = [...this.accounts.values()].flat().find((p) => p.id === input.externalId);
    if (!post) return { refused: 'gone' };
    const hours = Math.max(0, Math.floor((Date.now() - post.at.getTime()) / 3_600_000));
    return { metrics: { impressions: 40 + hours * 12, reach: 30 + hours * 9, reactions: 3 + hours, comments: Math.floor(hours / 3), shares: Math.floor(hours / 6) } };
  }

  // What the sandbox platform shows for an account (tests and the local demo).
  posts(externalAccountId: string): readonly SandboxPost[] {
    return this.accounts.get(externalAccountId) ?? [];
  }
}
