// Instagram professional accounts through Facebook Login (S6.3, issue #373), written from Meta's Instagram Platform
// docs (content publishing). The account is the Instagram business account linked to a Facebook Page the user
// manages; calls use that Page's token, which has no expiry timer.
//
// Publishing is a container flow: one container per image (invisible), a carousel container for several, a wait until
// Meta has fetched and processed them (status_code FINISHED), then media_publish, the one visible step. A container
// whose status_code is PUBLISHED went out already, so a check after a lost answer finds the post instead of posting
// again. Meta fetches each image from a public URL: deployments whose storage hands out presigned URLs (S3) can post;
// others get MEDIA_URL_UNAVAILABLE with nothing posted.
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, RetrySafety, StatusInput } from './index.ts';
import { Graph, GraphError, graphPublishResult, MetaLogin, type MetaAppConfig } from './meta.ts';
import type { AuthorizeInput, ExchangeInput, Fetch, OAuthConnector } from './oauth.ts';

export const INSTAGRAM_SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'] as const;
// How long a publish waits for Meta to process the containers before it reports the post as pending.
const WAIT_MS = 20_000;
const POLL_MS = 2_000;
// When the pipeline checks a pending post again.
const CHECK_AFTER_SECONDS = 30;
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
    this.login = new MetaLogin(app, INSTAGRAM_SCOPES, fetchImpl);
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

export class InstagramPublisher implements Publisher {
  readonly provider = 'instagram' as const;
  readonly publishSafety: RetrySafety = 'reconcile_only';
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
    // Every URL first: nothing is created if one image cannot be offered to Meta.
    const urls: string[] = [];
    for (const m of media) {
      const url = await input.mediaUrl(m.fileId).catch(() => null);
      if (!url) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
      urls.push(url);
    }
    const caption = captionOf(input.content);
    // Containers are invisible until published, so any failure while making them posted nothing.
    let container: string;
    try {
      if (urls.length === 1) {
        container = await this.create(input.externalAccountId, s.accessToken, { image_url: urls[0] as string, caption });
      } else {
        const children: string[] = [];
        for (const url of urls) children.push(await this.create(input.externalAccountId, s.accessToken, { image_url: url, is_carousel_item: 'true' }));
        container = await this.create(input.externalAccountId, s.accessToken, { media_type: 'CAROUSEL', children: children.join(','), caption });
      }
    } catch (error) {
      const result = graphPublishResult(error);
      return result.kind === 'rejected' ? result : { kind: 'rejected', error: 'transient', ...(result.kind === 'unknown' && result.code ? { code: result.code } : {}) };
    }
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const state = await this.containerStatus(container, s.accessToken);
      if (state === 'FINISHED') return this.publishContainer(input.externalAccountId, s.accessToken, container, caption);
      if (state === 'ERROR' || state === 'EXPIRED') return { kind: 'rejected', error: 'bad_request', code: `CONTAINER_${state}` };
      if (state === 'PUBLISHED') return this.findPublished(input.externalAccountId, s.accessToken, caption, container);
      if (Date.now() >= deadline) return { kind: 'pending', externalRef: container, checkAfterSeconds: CHECK_AFTER_SECONDS };
      await sleep(this.pollMs);
    }
  }

  // A pending post: its container is processed now, still processing, or gone wrong; publishing happens here once.
  async status(input: StatusInput): Promise<PublishResult> {
    const s = secretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' };
    if (!NUMERIC_ID.test(input.externalRef)) return { kind: 'unknown', code: 'BAD_CONTAINER_ID' };
    const state = await this.containerStatus(input.externalRef, s.accessToken);
    switch (state) {
      case 'FINISHED':
        // The caption is on the container; media_publish needs only its id.
        return this.publishContainer(input.externalAccountId, s.accessToken, input.externalRef, null);
      case 'PUBLISHED':
        return this.findPublished(input.externalAccountId, s.accessToken, null, input.externalRef);
      case 'IN_PROGRESS':
        return { kind: 'pending', externalRef: input.externalRef, checkAfterSeconds: CHECK_AFTER_SECONDS };
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
    if (!caption) return { found: 'unknown' };
    try {
      const post = await this.recent(input.externalAccountId, s.accessToken, (p) => p.caption === caption && p.at >= input.after.getTime() - 60_000 && p.at <= input.before.getTime() + 60_000);
      return post ? { found: true, externalId: post.id, url: post.permalink } : { found: false };
    } catch {
      return { found: 'unknown' };
    }
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
    } catch {
      return 'UNKNOWN';
    }
  }

  private async publishContainer(account: string, token: string, container: string, caption: string | null): Promise<PublishResult> {
    try {
      const answer = await this.graph.call<IdAnswer>('POST', `${account}/media_publish`, { token, form: { creation_id: container } });
      if (typeof answer.id !== 'string' || !answer.id) return { kind: 'unknown', code: 'NO_MEDIA_ID' };
      const permalink = await this.permalink(answer.id, token);
      return { kind: 'accepted', externalId: answer.id, url: permalink };
    } catch (error) {
      // Did it go out anyway? The container says so once Meta has published it.
      if ((await this.containerStatus(container, token)) === 'PUBLISHED') return this.findPublished(account, token, caption, container);
      return graphPublishResult(error);
    }
  }

  // The post a published container became: the newest post with its caption (Meta does not link them back).
  private async findPublished(account: string, token: string, caption: string | null, container: string): Promise<PublishResult> {
    try {
      const post = await this.recent(account, token, (p) => caption === null || p.caption === caption);
      return post ? { kind: 'accepted', externalId: post.id, url: post.permalink } : { kind: 'unknown', code: 'PUBLISHED_NOT_FOUND', message: `container ${container}` };
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
