// Instagram professional accounts through Facebook Login (S6.3, issue #373), written from Meta's Instagram Platform
// docs (content publishing). The account is the Instagram business account linked to a Facebook Page the user
// manages; calls use that Page's token, which has no expiry timer.
//
// Publishing is a container flow: one container per image or video (invisible; one video alone is a Reel, issue #437),
// a carousel container for several (images and videos mixed), a wait until
// Meta has fetched and processed them (status_code FINISHED), then media_publish, the one visible step. A container
// whose status_code is PUBLISHED went out already, so a check after a lost answer finds the post instead of posting
// again. Meta fetches each image from a public URL: deployments whose storage hands out presigned URLs (S3) can post
// images; others get MEDIA_URL_UNAVAILABLE with nothing posted. A Reel or a video Story goes up without one: its bytes
// are uploaded to the container (upload_type=resumable, #772).
import { createHash } from 'node:crypto';
import type { CommentInput, CommentResult, ConnectedAccount, MetricName, AccountMetricsInput, AccountMetricsResult, MetricsInput, MetricsResult, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, RetrySafety, StatusInput } from './index.ts';
import { commentResult } from './comment.ts';
import { videoCoverOf } from './cover.ts';
import { postTypeOf } from './post-type.ts';
import { Graph, GraphError, graphPublishResult, MetaLogin, type MetaAppConfig } from './meta.ts';
import type { AuthorizeInput, ExchangeInput, Fetch, OAuthConnector } from './oauth.ts';

// instagram_manage_insights: reach, saves, shares and views of the account's posts (S8 metrics);
// instagram_manage_comments: the first comment under the account's own post (#609).
export const INSTAGRAM_SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_insights'] as const;
// Asked for, not required: first comments (#609); an account connects without it and its comments fail with permission.
export const INSTAGRAM_COMMENT_SCOPES = ['instagram_manage_comments'] as const;
// How long a publish waits for Meta to process the containers before it reports the post as pending; with the creates it
// stays well inside the job's 60 second call timeout.
const WAIT_MS = 15_000;
const POLL_MS = 2_000;
// When the pipeline checks a pending post again.
const CHECK_AFTER_SECONDS = 30;
// How long the upload of one video's bytes may take (#772): a 100 MB file on a slow link.
const UPLOAD_MS = 300_000;
const NUMERIC_ID = /^\d{1,32}$/;

interface InstagramSecret {
  accessToken: string;
  pageId: string;
}

function secretOf(secret: string): InstagramSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<InstagramSecret>;
    return typeof s.accessToken === 'string' && s.accessToken && typeof s.pageId === 'string' ? { accessToken: s.accessToken, pageId: s.pageId } : null;
  } catch {
    return null;
  }
}

export class InstagramConnector implements OAuthConnector {
  readonly provider = 'instagram' as const;
  readonly pkce = false;
  private readonly login: MetaLogin;

  constructor(app: MetaAppConfig, fetchImpl?: Fetch) {
    this.login = new MetaLogin(app, INSTAGRAM_SCOPES, fetchImpl, INSTAGRAM_COMMENT_SCOPES);
  }

  authorizeUrl(input: AuthorizeInput): string {
    return this.login.authorizeUrl(input);
  }

  // Every Instagram business account linked to a Page the user may post on.
  async exchange(input: ExchangeInput): Promise<ConnectedAccount[]> {
    const { token, scopes } = await this.login.userToken(input);
    const accounts: ConnectedAccount[] = [];
    for (const row of await this.login.pages(token, 'id,name,access_token,tasks,instagram_business_account{id,username,name}')) {
      const ig = row.instagram_business_account;
      const tasks = Array.isArray(row.tasks) ? row.tasks : [];
      if (typeof row.id !== 'string' || !NUMERIC_ID.test(row.id) || typeof row.access_token !== 'string' || !row.access_token) continue;
      if (!ig || typeof ig.id !== 'string' || !NUMERIC_ID.test(ig.id) || !tasks.includes('CREATE_CONTENT')) continue;
      const handle = typeof ig.username === 'string' && ig.username ? `@${ig.username}` : typeof ig.name === 'string' && ig.name ? ig.name : `Instagram ${ig.id}`;
      accounts.push({
        provider: 'instagram',
        externalAccountId: ig.id,
        displayName: handle.slice(0, 200),
        scopes: [...scopes],
        expiresAt: null,
        secret: JSON.stringify({ accessToken: row.access_token, pageId: row.id } satisfies InstagramSecret),
      });
    }
    return accounts;
  }
}

interface IdAnswer {
  id?: unknown;
}
interface ContainerAnswer {
  status_code?: unknown;
}
interface MediaListAnswer {
  data?: { id?: unknown; caption?: unknown; timestamp?: unknown; permalink?: unknown }[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const captionOf = (content: { body: string }) => content.body.trim();
const isVideo = (m: { mime: string }) => m.mime.startsWith('video/');
// A pending post's reference: the container and a short hash of its caption, so a later status check can recognise the
// post the container became without the content.
const captionKey = (caption: string) => createHash('sha256').update(caption).digest('hex').slice(0, 16);
// A Story has no caption and is not listed with the account's media, so its reference carries this key instead: a
// published Story whose id was not answered cannot be found again, and is unknown.
const STORY_KEY = '0'.repeat(16);
const refOf = (container: string, caption: string, story = false) => `${container}.${story ? STORY_KEY : captionKey(caption)}`;
function parseRef(ref: string): { container: string; key: string } | null {
  const m = /^(\d{1,32})\.([0-9a-f]{16})$/.exec(ref);
  return m ? { container: m[1] as string, key: m[2] as string } : null;
}

// The account's publishing quota (plan §3.6): Instagram takes a limited number of posts in a rolling 24 hours (100
// today, Stories included). With none left the post waits and is tried again later, instead of failing in the middle
// of a publish. The API does not say when the quota frees, so the post is tried again every 2 hours; the publisher
// bounds these waits on their own (MAX_QUOTA_WAITS in modules/social), past the quota's rolling day.
export const QUOTA_RETRY_MS = 2 * 60 * 60 * 1000;

// Whether the quota answer says the account has nothing left; a quota that cannot be read says nothing.
export function quotaExhausted(answer: { data?: { quota_usage?: unknown; config?: { quota_total?: unknown } }[] } | null): boolean {
  const d = answer?.data?.[0];
  const usage = d?.quota_usage;
  const total = d?.config?.quota_total;
  return typeof usage === 'number' && typeof total === 'number' && total > 0 && usage >= total;
}

export class InstagramPublisher implements Publisher {
  readonly provider = 'instagram' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
  // A video uploaded by Crove (#772) takes minutes; the job waits as long as for the other video adapters.
  readonly callTimeoutMs = 420_000;
  private readonly graph: Graph;
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(app: Pick<MetaAppConfig, 'appSecret' | 'graphVersion'>, fetchImpl?: Fetch, timing: { waitMs?: number; pollMs?: number } = {}) {
    if (!app.appSecret) throw new Error('missing Meta app secret');
    this.graph = new Graph(app.appSecret, app.graphVersion, fetchImpl);
    this.waitMs = timing.waitMs ?? WAIT_MS;
    this.pollMs = timing.pollMs ?? POLL_MS;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_ACCOUNT_ID' };
    const media = input.content.media;
    if (media.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_REQUIRED' };
    // A presigned URL lives about a minute, so each is made right before the container that names it. The first one is
    // made before anything else: a deployment that cannot hand out URLs creates nothing.
    const urlOf = async (fileId: string) => {
      const url = await input.mediaUrl(fileId).catch(() => null);
      if (!url) throw new NoUrl();
      return url;
    };
    // A cover (#642) belongs to a Reel: a frame (thumb_offset, in milliseconds) or an image Meta fetches (cover_url).
    const cover = videoCoverOf(input.settings);
    const reel = media.length === 1 && isVideo(media[0] as { mime: string });
    // The post type (#644): a Story is one image or video, with no caption, cover or link; a Reel is one video.
    const type = postTypeOf(input.settings);
    if (type === null) return { kind: 'rejected', error: 'bad_request', code: 'POST_TYPE_NOT_SUPPORTED' };
    const story = type === 'story';
    if (story && media.length !== 1) return { kind: 'rejected', error: 'bad_request', code: 'STORY_ONE_MEDIA' };
    if (type === 'reel' && !reel) return { kind: 'rejected', error: 'bad_request', code: 'REEL_ONE_VIDEO' };
    if (cover && (!reel || story)) return { kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' };
    // Read before anything is created; a read that fails does not hold the post.
    const quota = await this.graph
      .call<Parameters<typeof quotaExhausted>[0]>('GET', `${input.externalAccountId}/content_publishing_limit`, { token: s.accessToken, params: { fields: 'quota_usage,config' } })
      .catch(() => null);
    if (quotaExhausted(quota)) return { kind: 'rejected', error: 'rate_limited', code: 'QUOTA_EXHAUSTED', retryAt: new Date(Date.now() + QUOTA_RETRY_MS) };
    const first = await input.mediaUrl((media[0] as { fileId: string }).fileId).catch(() => null);
    // Without a URL, a Reel or a video Story still goes: its bytes are uploaded to the container (#772). A cover image
    // is fetched by URL, so it still needs one.
    const uploaded = !first && reel && !(cover && !('atMs' in cover));
    if (!first && !uploaded) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
    // Read before anything is created: a file that cannot be read posts nothing.
    const bytes = uploaded ? await input.readMedia((media[0] as { fileId: string }).fileId).catch(() => null) : null;
    if (uploaded && !bytes) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' };
    const source = (video: boolean) => (uploaded ? { upload_type: 'resumable' } : video ? { video_url: first as string } : { image_url: first as string });
    const caption = story ? '' : captionOf(input.content);
    // Containers are invisible until published, so any failure while making them posted nothing.
    let container: string;
    try {
      if (story) {
        // A Story: Meta fetches the image or video from the URL; it takes no caption.
        container = await this.create(input.externalAccountId, s.accessToken, { media_type: 'STORIES', ...source(reel) });
      } else if (media.length === 1) {
        // One video is a Reel, shown in the feed too; Meta fetches it from the URL and processes it before publishing.
        const coverForm = !cover ? {} : 'atMs' in cover ? { thumb_offset: String(cover.atMs) } : { cover_url: await urlOf(cover.fileId) };
        const single = reel ? { media_type: 'REELS', ...source(true), share_to_feed: 'true', ...coverForm } : source(false);
        container = await this.create(input.externalAccountId, s.accessToken, { ...single, caption });
      } else {
        // A carousel may mix images and videos.
        const children: string[] = [];
        for (const [i, m] of media.entries()) {
          const url = i === 0 ? (first as string) : await urlOf(m.fileId);
          children.push(await this.create(input.externalAccountId, s.accessToken, { ...(isVideo(m) ? { media_type: 'VIDEO', video_url: url } : { image_url: url }), is_carousel_item: 'true' }));
        }
        container = await this.create(input.externalAccountId, s.accessToken, { media_type: 'CAROUSEL', children: children.join(','), caption });
      }
      // The bytes, to the container just made; still invisible, so a failed upload posted nothing.
      if (uploaded && bytes) await this.graph.uploadInstagram(container, s.accessToken, bytes, UPLOAD_MS);
    } catch (error) {
      if (error instanceof NoUrl) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
      const result = graphPublishResult(error);
      return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    }
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const state = await this.containerStatus(container, s.accessToken);
      const key = story ? STORY_KEY : captionKey(caption);
      if (state === 'FINISHED') return this.publishContainer(input.externalAccountId, s.accessToken, container, key);
      if (state === 'ERROR' || state === 'EXPIRED') return { kind: 'rejected', error: 'bad_request', code: `CONTAINER_${state}` };
      if (state === 'PUBLISHED') return this.findPublished(input.externalAccountId, s.accessToken, key, container);
      // Nothing is published yet, so a refused token here posted nothing.
      if (state === 'TOKEN_EXPIRED') return { kind: 'rejected', error: 'token_expired', code: '190' };
      if (Date.now() >= deadline) return { kind: 'pending', externalRef: refOf(container, caption, story), checkAfterSeconds: CHECK_AFTER_SECONDS };
      await sleep(this.pollMs);
    }
  }

  // A pending post: its container is processed now, still processing, or gone wrong; publishing happens here once.
  async status(input: StatusInput): Promise<PublishResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    const ref = parseRef(input.externalRef);
    if (!ref) return { kind: 'unknown', code: 'BAD_CONTAINER_REF' };
    const state = await this.containerStatus(ref.container, s.accessToken);
    switch (state) {
      case 'FINISHED': {
        // A media_publish that timed out may have gone through before the container shows it: look first.
        const already = await this.findPublished(input.externalAccountId, s.accessToken, ref.key, ref.container, true);
        if (already.kind === 'accepted') return already;
        // The caption is on the container; media_publish needs only its id.
        return this.publishContainer(input.externalAccountId, s.accessToken, ref.container, ref.key);
      }
      case 'PUBLISHED':
        return this.findPublished(input.externalAccountId, s.accessToken, ref.key, ref.container);
      case 'IN_PROGRESS':
        return { kind: 'pending', externalRef: input.externalRef, checkAfterSeconds: CHECK_AFTER_SECONDS };
      case 'TOKEN_EXPIRED':
        return { kind: 'rejected', error: 'token_expired', code: '190' };
      case 'ERROR':
      case 'EXPIRED':
        return { kind: 'rejected', error: 'bad_request', code: `CONTAINER_${state}` };
      default:
        return { kind: 'unknown', code: 'CONTAINER_STATUS_UNKNOWN' };
    }
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = secretOf(input.secret);
    if (!s || !NUMERIC_ID.test(input.externalAccountId)) return { found: 'unknown' };
    const caption = captionOf(input.content);
    // A Story has no caption and is not listed with the account's media (#644).
    if (!caption || postTypeOf(input.settings) === 'story') return { found: 'unknown' };
    try {
      const post = await this.recent(input.externalAccountId, s.accessToken, (p) => p.caption === caption && p.at >= input.after.getTime() - 60_000 && p.at <= input.before.getTime() + 60_000);
      return post ? { found: true, externalId: post.id, url: post.permalink } : { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }

  // A comment by the account under its own post (#609): `POST /{ig-media-id}/comments` with the Page token. It needs
  // instagram_manage_comments; an account connected before Crove asked for it is refused with a permission error and
  // comments again once it reconnects.
  async comment(input: CommentInput): Promise<CommentResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      const answer = await this.graph.call<IdAnswer>('POST', `${input.externalId}/comments`, { token: s.accessToken, form: { message: input.text } });
      if (typeof answer.id !== 'string' || !NUMERIC_ID.test(answer.id)) return { kind: 'unknown', code: 'NO_COMMENT_ID' };
      return { kind: 'accepted', externalId: answer.id };
    } catch (error) {
      // A Reel or carousel still being processed right after it went out takes no comment yet (code 9007, subcode
      // 2207027): nothing was posted, so the person can try again shortly.
      if (error instanceof GraphError && (error.code === 9007 || error.subcode === 2207027)) return { kind: 'rejected', error: 'transient', code: 'MEDIA_NOT_READY' };
      return commentResult(graphPublishResult(error));
    }
  }

  // Likes and comments are fields of the post; reach, saves, shares and views come from its insights, which need
  // instagram_manage_insights (an account connected before Crove asked for it has none) and exist only for posts made
  // after the account became professional. Without insights the plain counts are still reported.
  // The account's followers and yesterday's reach (#645). The reach needs instagram_manage_insights; an account
  // connected before Crove asked for it reports followers only.
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    const s = secretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!NUMERIC_ID.test(input.externalAccountId)) return null;
    let followers: number | null;
    try {
      const answer = await this.graph.call<{ followers_count?: unknown }>('GET', input.externalAccountId, { token: s.accessToken, params: { fields: 'followers_count' } });
      followers = count(answer.followers_count) ?? null;
    } catch (error) {
      const result = graphPublishResult(error);
      if (result.kind === 'rejected' && (result.error === 'token_expired' || result.error === 'permission')) return { refused: result.error };
      return null;
    }
    let reach: number | null = null;
    try {
      const insights = await this.graph.call<InsightsAnswer>('GET', `${input.externalAccountId}/insights`, { token: s.accessToken, params: { metric: 'reach', period: 'day' } });
      const values = insights.data?.find((row) => row.name === 'reach')?.values ?? [];
      reach = count(values.at(-1)?.value) ?? null;
    } catch {
      // No insights permission, or none yet: followers only.
    }
    return { followers, reach };
  }

  async metrics(input: MetricsInput): Promise<MetricsResult> {
    const s = secretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!NUMERIC_ID.test(input.externalId)) return { refused: 'gone' };
    const metrics: Partial<Record<MetricName, number>> = {};
    try {
      const answer = await this.graph.call<{ like_count?: unknown; comments_count?: unknown }>('GET', input.externalId, { token: s.accessToken, params: { fields: 'like_count,comments_count' } });
      const likes = count(answer.like_count);
      const comments = count(answer.comments_count);
      if (likes !== undefined) metrics.reactions = likes;
      if (comments !== undefined) metrics.comments = comments;
    } catch (error) {
      const result = graphPublishResult(error);
      if (result.kind === 'rejected' && result.error === 'token_expired') return { refused: 'token_expired' };
      if (error instanceof GraphError && error.code === 100 && error.subcode === 33) return { refused: 'gone' };
      return null;
    }
    try {
      const insights = await this.graph.call<InsightsAnswer>('GET', `${input.externalId}/insights`, { token: s.accessToken, params: { metric: 'reach,saved,shares,views' } });
      for (const row of insights.data ?? []) {
        const name = typeof row.name === 'string' ? INSIGHT_NAMES[row.name] : undefined;
        const value = count(row.values?.[0]?.value ?? row.total_value?.value);
        if (name && value !== undefined) metrics[name] = value;
      }
    } catch {
      // No insights for this post or this connection: the plain counts stand.
    }
    return { metrics };
  }

  private async create(account: string, token: string, form: Record<string, string>): Promise<string> {
    const answer = await this.graph.call<IdAnswer>('POST', `${account}/media`, { token, form });
    if (typeof answer.id !== 'string' || !NUMERIC_ID.test(answer.id)) throw new GraphError(502, { message: 'no container id', code: 1 });
    return answer.id;
  }

  private async containerStatus(container: string, token: string): Promise<string> {
    try {
      const answer = await this.graph.call<ContainerAnswer>('GET', container, { token, params: { fields: 'status_code' } });
      return typeof answer.status_code === 'string' ? answer.status_code : 'UNKNOWN';
    } catch (error) {
      const result = graphPublishResult(error);
      return result.kind === 'rejected' && result.error === 'token_expired' ? 'TOKEN_EXPIRED' : 'UNKNOWN';
    }
  }

  // key: the caption's captionKey, to recognise the post a published container became.
  private async publishContainer(account: string, token: string, container: string, key: string): Promise<PublishResult> {
    try {
      const answer = await this.graph.call<IdAnswer>('POST', `${account}/media_publish`, { token, form: { creation_id: container } });
      if (typeof answer.id !== 'string' || !answer.id) return { kind: 'unknown', code: 'NO_MEDIA_ID' };
      const permalink = await this.permalink(answer.id, token);
      return { kind: 'accepted', externalId: answer.id, url: permalink };
    } catch (error) {
      // Did it go out anyway? The container says so once Meta has published it.
      if ((await this.containerStatus(container, token)) === 'PUBLISHED') return this.findPublished(account, token, key, container);
      return graphPublishResult(error);
    }
  }

  // The post a published container became: the newest post with the same caption in the last day (Meta does not link
  // them back, and its listing may lag). Never a guess: no match is unknown. quiet: a miss is not worth reporting.
  private async findPublished(account: string, token: string, key: string, container: string, quiet = false): Promise<PublishResult> {
    // A Story is not listed with the account's media: never matched by guess.
    if (key === STORY_KEY) return { kind: 'unknown', code: quiet ? 'NOT_YET' : 'STORY_NOT_FOUND', message: `container ${container}` };
    const since = Date.now() - 86_400_000;
    try {
      const post = await this.recent(account, token, (p) => captionKey(p.caption) === key && !(p.at < since));
      return post ? { kind: 'accepted', externalId: post.id, url: post.permalink } : { kind: 'unknown', code: quiet ? 'NOT_YET' : 'PUBLISHED_NOT_FOUND', message: `container ${container}` };
    } catch {
      return { kind: 'unknown', code: 'PUBLISHED_NOT_FOUND' };
    }
  }

  private async recent(account: string, token: string, match: (p: { caption: string; at: number }) => boolean): Promise<{ id: string; permalink: string | null } | null> {
    const answer = await this.graph.call<MediaListAnswer>('GET', `${account}/media`, { token, params: { fields: 'id,caption,timestamp,permalink', limit: '25' } });
    for (const p of answer.data ?? []) {
      if (typeof p.id !== 'string') continue;
      const caption = typeof p.caption === 'string' ? p.caption.trim() : '';
      const at = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : Number.NaN;
      if (match({ caption, at })) return { id: p.id, permalink: typeof p.permalink === 'string' ? p.permalink : null };
    }
    return null;
  }

  private async permalink(id: string, token: string): Promise<string | null> {
    try {
      const answer = await this.graph.call<{ permalink?: unknown }>('GET', id, { token, params: { fields: 'permalink' } });
      return typeof answer.permalink === 'string' ? answer.permalink : null;
    } catch {
      return null;
    }
  }
}

class NoUrl extends Error {}

interface InsightsAnswer {
  data?: { name?: unknown; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[];
}
const INSIGHT_NAMES: Record<string, MetricName> = { reach: 'reach', saved: 'saves', shares: 'shares', views: 'views' };
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
