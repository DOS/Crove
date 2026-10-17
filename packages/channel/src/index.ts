// Channel providers (ADR-0025 decision 3, Social plan §3.6). The kernel keeps connections and sealed tokens; a
// provider knows how to connect an account and, from later steps on, how to publish, reconcile and read metrics.
// Each capability is its own small interface, added by the step that first needs it.
import { randomBytes } from 'node:crypto';

export * from './oauth.ts';
export * from './meta.ts';
export * from './instagram.ts';
export * from './zalo.ts';
export * from './bluesky.ts';
export * from './threads.ts';

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
  | { kind: 'accepted'; externalId: string; url: string | null }
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
  // The window the post would have appeared in.
  after: Date;
  before: Date;
}

// found: the post is on the platform; missing: it is not; unknown: the provider cannot be asked or did not answer.
export type ReconcileResult = { found: true; externalId: string; url: string | null } | { found: false } | { found: 'unknown' };

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
export const METRIC_NAMES = ['impressions', 'reach', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'views'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
export interface MetricsInput {
  externalAccountId: string;
  secret: string;
  externalId: string;
}
export type MetricsResult = { metrics: Partial<Record<MetricName, number>>; extra?: Record<string, unknown> } | { refused: 'token_expired' | 'gone' } | null;

export interface Publisher {
  readonly provider: ChannelProviderId;
  readonly publishSafety: RetrySafety;
  publish(input: PublishInput): Promise<PublishResult>;
  // Two-phase providers: where a pending post stands.
  status?(input: StatusInput): Promise<PublishResult>;
  // Providers that can be asked whether an earlier call went through.
  reconcile?(input: ReconcileInput): Promise<ReconcileResult>;
  // Providers that report how a post did: null when the platform did not answer (try again later), refused when the
  // token no longer works or the post is gone.
  metrics?(input: MetricsInput): Promise<MetricsResult>;
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

  async publish(input: PublishInput): Promise<PublishResult> {
    const accessToken = (JSON.parse(input.secret) as { accessToken?: unknown }).accessToken;
    if (typeof accessToken !== 'string' || !accessToken.startsWith('sbx_')) return { kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' };
    const id = `sbx_post_${randomBytes(9).toString('base64url')}`;
    const posts = this.accounts.get(input.externalAccountId) ?? [];
    posts.push({ id, callKey: input.callKey, contentHash: input.contentHash, body: input.content.body, at: new Date() });
    this.accounts.set(input.externalAccountId, posts);
    return { kind: 'accepted', externalId: id, url: null };
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
