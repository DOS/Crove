// Google Business Profile posts (#709), written from Google's Business Profile APIs docs (localPosts on My Business
// v4, accounts and locations on the Account Management and Business Information APIs). It uses the deployment's Google
// Cloud project (CHANNEL_GOOGLE_CLIENT_ID and CHANNEL_GOOGLE_CLIENT_SECRET, as YouTube does); Google answers these APIs
// only once the project's Basic API Access request is approved (a verified profile, active 60 days, with a website),
// so the deployment turns the channel on with CHANNEL_GOOGLE_BUSINESS=true.
//
// Connect: Google's consent screen for business.manage with offline access; one connection per location the account
// manages (accounts/<a>/locations/<l>, the location's title as its name). The access token lives an hour and the
// refresh schedule renews it.
// Publish: one localPost: a standard post with an optional call to action (the post's link as its URL; CALL needs
// none), an event (title, start and end) or an offer (an event's schedule plus a coupon code, terms and a redeem link);
// one photo at most, which Google fetches from its URL. Product posts cannot be made through the API. The answer
// names the post; an unclear answer is checked by listing the location's newest posts, matched by text and time.
// Remove (#1138): DELETE https://mybusiness.googleapis.com/v4/{name} of the localPost, with the same business.manage grant.
import type { ConnectedAccount, Publisher, PublishInput, PublishResult, ReconcileInput, ReconcileResult, Refresher, RemoveInput, RemoveResult, RetrySafety } from './index.ts';
import { removeResult } from './comment.ts';
import { allowlistedFetch, ConnectorError, type AuthorizeInput, type ExchangeInput, type Fetch, type OAuthConnector } from './oauth.ts';
import type { AccountMetricsInput, AccountMetricsResult } from './index.ts';
import { PERFORMANCE_DAYS, type DailyPerformance, type PerformanceName } from './performance.ts';

export const GOOGLE_BUSINESS_HOSTS = ['oauth2.googleapis.com', 'mybusinessaccountmanagement.googleapis.com', 'mybusinessbusinessinformation.googleapis.com', 'mybusiness.googleapis.com', 'businessprofileperformance.googleapis.com'] as const;
export const GOOGLE_BUSINESS_SCOPES = ['https://www.googleapis.com/auth/business.manage'] as const;
export const GBP_CTA_TYPES = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'] as const;
export type GbpCtaType = (typeof GBP_CTA_TYPES)[number];
export const GBP_TOPICS = ['STANDARD', 'EVENT', 'OFFER'] as const;
export type GbpTopic = (typeof GBP_TOPICS)[number];
// The languages a post may be written in (#730); Vietnamese when the post does not say.
export const GBP_LANGUAGES = ['vi', 'en', 'zh', 'ja', 'ko'] as const;
export type GbpLanguage = (typeof GBP_LANGUAGES)[number];
export const GBP_SUMMARY_MAX = 1500;
export const GBP_EVENT_TITLE_MAX = 58;
const LOCATION = /^accounts\/\d{1,32}\/locations\/\d{1,32}$/;
// Pages of 100 locations read per account when connecting (a chain of up to 1,000 places).
const MAX_LOCATION_PAGES = 10;
const POST_NAME = /^accounts\/\d{1,32}\/locations\/\d{1,32}\/localPosts\/[A-Za-z0-9_-]{1,128}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;
const PAGE_SIZE = 50;

export interface GoogleBusinessAppConfig {
  clientId: string;
  clientSecret: string;
}

export class GoogleBusinessError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, body: Record<string, unknown> | null) {
    const error = body?.error;
    const nested = error !== null && typeof error === 'object' ? (error as { message?: unknown; status?: unknown; details?: { reason?: unknown }[] }) : null;
    const message = typeof nested?.message === 'string' ? nested.message : typeof body?.error_description === 'string' ? body.error_description : `Google answered ${status}`;
    super(message);
    this.name = 'GoogleBusinessError';
    this.status = status;
    const reason = nested?.details?.find((d) => typeof d?.reason === 'string')?.reason ?? nested?.status ?? (typeof error === 'string' ? error : undefined);
    this.reason = typeof reason === 'string' ? reason : undefined;
  }
}

export interface GoogleBusinessSecret {
  accessToken: string;
  refreshToken: string;
}

export function googleBusinessSecretOf(secret: string): GoogleBusinessSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<GoogleBusinessSecret>;
    return typeof s.accessToken === 'string' && s.accessToken && typeof s.refreshToken === 'string' && s.refreshToken ? { accessToken: s.accessToken, refreshToken: s.refreshToken } : null;
  } catch {
    return null;
  }
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

class GoogleBusinessClient {
  private readonly fetch: Fetch;
  private readonly app: GoogleBusinessAppConfig;

  constructor(app: GoogleBusinessAppConfig, fetchImpl?: Fetch) {
    if (!/^[0-9]{6,32}-[A-Za-z0-9_-]{8,64}\.apps\.googleusercontent\.com$/.test(app.clientId)) throw new Error('invalid Google client id');
    if (!app.clientSecret) throw new Error('missing Google client secret');
    this.app = app;
    this.fetch = allowlistedFetch(GOOGLE_BUSINESS_HOSTS, fetchImpl);
  }

  get clientId(): string {
    return this.app.clientId;
  }

  async token(form: Record<string, string>): Promise<TokenAnswer> {
    const response = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...form }).toString(),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json) throw new GoogleBusinessError(response.status, json);
    return json as TokenAnswer;
  }

  async call<T>(method: 'GET' | 'POST' | 'DELETE', url: string, token: string, json?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (json !== undefined) headers['content-type'] = 'application/json; charset=UTF-8';
    const response = await this.fetch(url, { method, headers, signal: AbortSignal.timeout(30_000), ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw new GoogleBusinessError(response.status, body);
    return (body ?? {}) as T;
  }
}

const expiryOf = (a: TokenAnswer, now = Date.now()) => {
  const seconds = Number(a.expires_in);
  return new Date(now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000);
};

function connectorError(error: unknown, codeStep = false): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof GoogleBusinessError) {
    if (codeStep && error.reason === 'invalid_grant') return new ConnectorError('invalid_grant', 'Google refused the authorization code', error.reason);
    // A project Google has not approved for these APIs answers 403 (or 429 with a quota of 0).
    return new ConnectorError(error.status === 403 || error.status === 429 ? 'denied' : 'provider', error.message, error.reason ?? String(error.status));
  }
  return new ConnectorError('provider', `Google could not be reached: ${error instanceof Error ? `${error.name}: ${error.message}` : typeof error}`);
}

export class GoogleBusinessConnector implements OAuthConnector {
  readonly provider = 'google_business' as const;
  readonly pkce = true;
  private readonly client: GoogleBusinessClient;

  constructor(app: GoogleBusinessAppConfig, fetchImpl?: Fetch) {
    this.client = new GoogleBusinessClient(app, fetchImpl);
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.client.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_BUSINESS_SCOPES.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    if (input.codeChallenge) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  // One connection per location of every account the person manages.
  async exchange(input: ExchangeInput, now = Date.now()): Promise<ConnectedAccount[]> {
    const answer = await this.client
      .token({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}) })
      .catch((error: unknown) => {
        throw connectorError(error, true);
      });
    if (typeof answer.access_token !== 'string' || !answer.access_token) throw new ConnectorError('provider', 'Google answered without an access token');
    if (typeof answer.refresh_token !== 'string' || !answer.refresh_token) throw new ConnectorError('provider', 'Google answered without a refresh token');
    const granted = typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : [];
    if (!GOOGLE_BUSINESS_SCOPES.every((s) => granted.includes(s))) throw new ConnectorError('denied', 'Google did not grant the Business Profile permission Crove needs', 'MISSING_PERMISSION');
    const token = answer.access_token;
    const accounts = await this.client.call<{ accounts?: { name?: unknown }[] }>('GET', `https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20`, token).catch((error: unknown) => {
      throw connectorError(error);
    });
    const secret = JSON.stringify({ accessToken: token, refreshToken: answer.refresh_token } satisfies GoogleBusinessSecret);
    const out: ConnectedAccount[] = [];
    for (const account of accounts.accounts ?? []) {
      const name = typeof account.name === 'string' && /^accounts\/\d{1,32}$/.test(account.name) ? account.name : null;
      if (!name) continue;
      // Every location the account manages, 100 a page, up to MAX_LOCATION_PAGES pages.
      const locations: { name?: unknown; title?: unknown }[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_LOCATION_PAGES; page++) {
        type LocationPage = { locations?: { name?: unknown; title?: unknown }[]; nextPageToken?: unknown };
        const answer: LocationPage = await this.client
          .call<LocationPage>(
            'GET',
            `https://mybusinessbusinessinformation.googleapis.com/v1/${name}/locations?readMask=name,title&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
            token,
          )
          .catch((error: unknown) => {
            throw connectorError(error);
          });
        locations.push(...(answer.locations ?? []));
        pageToken = typeof answer.nextPageToken === 'string' && answer.nextPageToken ? answer.nextPageToken : null;
        if (!pageToken) break;
      }
      for (const location of locations) {
        const id = typeof location.name === 'string' && /^locations\/\d{1,32}$/.test(location.name) ? `${name}/${location.name}` : null;
        if (!id) continue;
        const title = typeof location.title === 'string' && location.title.trim() ? location.title.trim() : id;
        out.push({ provider: 'google_business', externalAccountId: id, displayName: title.slice(0, 200), scopes: granted, expiresAt: expiryOf(answer, now), secret });
      }
    }
    if (out.length === 0) throw new ConnectorError('denied', 'This Google account manages no Business Profile location', 'NO_LOCATION');
    return out;
  }
}

// Renews the hour-long access token a quarter of an hour before it expires; Google keeps the refresh token.
export class GoogleBusinessRefresher implements Refresher {
  readonly provider = 'google_business' as const;
  readonly horizonSeconds = 15 * 60;
  private readonly client: GoogleBusinessClient;

  constructor(app: GoogleBusinessAppConfig, fetchImpl?: Fetch) {
    this.client = new GoogleBusinessClient(app, fetchImpl);
  }

  async refresh(secret: string): Promise<{ secret: string; expiresAt: Date | null } | { refused: string } | { failed: string }> {
    const s = googleBusinessSecretOf(secret);
    if (!s) return { refused: 'NO_REFRESH_TOKEN' };
    try {
      const answer = await this.client.token({ grant_type: 'refresh_token', refresh_token: s.refreshToken });
      if (typeof answer.access_token !== 'string' || !answer.access_token) return { failed: 'NO_ACCESS_TOKEN' };
      const next: GoogleBusinessSecret = { accessToken: answer.access_token, refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : s.refreshToken };
      return { secret: JSON.stringify(next), expiresAt: expiryOf(answer) };
    } catch (error) {
      if (error instanceof GoogleBusinessError && error.reason === 'invalid_grant') return { refused: 'invalid_grant' };
      return { failed: error instanceof GoogleBusinessError ? (error.reason ?? String(error.status)) : 'NETWORK' };
    }
  }
}

function publishResult(error: unknown): PublishResult {
  if (!(error instanceof GoogleBusinessError)) return { kind: 'unknown', code: 'NETWORK' };
  const code = error.reason ?? `HTTP_${error.status}`;
  if (error.status >= 500 || error.status < 400) return { kind: 'unknown', code, message: error.message };
  if (error.status === 401) return { kind: 'rejected', error: 'token_expired', code, message: error.message, httpStatus: error.status };
  if (error.status === 429) return { kind: 'rejected', error: 'rate_limited', code, message: error.message, httpStatus: error.status };
  if (error.status === 403) return { kind: 'rejected', error: 'permission', code, message: error.message, httpStatus: error.status };
  return { kind: 'rejected', error: 'bad_request', code, message: error.message, httpStatus: error.status };
}

// A post's Business Profile settings (`settings.gbp`): its topic, call to action, event and offer.
export interface GbpSettings {
  topic: GbpTopic;
  language: GbpLanguage;
  cta: GbpCtaType | null;
  event: { title: string; startDate: string; startTime: string | null; endDate: string; endTime: string | null } | null;
  offer: { couponCode: string | null; terms: string | null } | null;
}

// null: settings Google would refuse (an unknown topic or action, an event without its title or dates, an offer
// without an event's dates).
export function gbpSettingsOf(settings: Readonly<Record<string, unknown>>): GbpSettings | null {
  const raw = settings.gbp;
  if (raw === undefined || raw === null) return { topic: 'STANDARD', language: 'vi', cta: null, event: null, offer: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  const topic = g.topic === undefined ? 'STANDARD' : GBP_TOPICS.find((t) => t === g.topic);
  const cta = g.cta === undefined || g.cta === null ? null : (GBP_CTA_TYPES.find((c) => c === g.cta) ?? undefined);
  const language = g.language === undefined || g.language === null ? 'vi' : GBP_LANGUAGES.find((l) => l === g.language);
  if (!topic || cta === undefined || !language) return null;
  let event: GbpSettings['event'] = null;
  if (topic !== 'STANDARD') {
    const e = (g.event ?? {}) as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : null);
    const time = (v: unknown) => (v === undefined || v === null || v === '' ? null : typeof v === 'string' && TIME.test(v) ? v : undefined);
    const startDate = day(e.startDate);
    const endDate = day(e.endDate);
    const startTime = time(e.startTime);
    const endTime = time(e.endTime);
    if (!startDate || !endDate || endDate < startDate || startTime === undefined || endTime === undefined) return null;
    // An offer's title is the offer's own; an event needs one.
    if (topic === 'EVENT' && (!title || [...title].length > GBP_EVENT_TITLE_MAX)) return null;
    if ([...title].length > GBP_EVENT_TITLE_MAX) return null;
    event = { title, startDate, startTime, endDate, endTime };
  }
  let offer: GbpSettings['offer'] = null;
  if (topic === 'OFFER') {
    const o = (g.offer ?? {}) as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    offer = { couponCode: text(o.couponCode, 58), terms: text(o.terms, 5000) };
  }
  return { topic, language, cta, event, offer };
}

const dateOf = (day: string) => {
  const m = DAY.exec(day) as RegExpExecArray;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};
const timeOf = (t: string | null) => {
  if (!t) return undefined;
  const m = TIME.exec(t) as RegExpExecArray;
  return { hours: Number(m[1]), minutes: Number(m[2]), seconds: 0, nanos: 0 };
};

export class GoogleBusinessPublisher implements Publisher {
  readonly provider = 'google_business' as const;
  // A localPost has no idempotency key: an unclear answer is checked against the location's posts.
  readonly publishSafety: RetrySafety = 'reconcile_only';
  private readonly client: GoogleBusinessClient;

  constructor(app: GoogleBusinessAppConfig, fetchImpl?: Fetch) {
    this.client = new GoogleBusinessClient(app, fetchImpl);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const s = googleBusinessSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!LOCATION.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_LOCATION' };
    const g = gbpSettingsOf(input.settings);
    if (!g) return { kind: 'rejected', error: 'bad_request', code: 'GBP_SETTINGS_INVALID' };
    const summary = input.content.body.trim();
    if ([...summary].length > GBP_SUMMARY_MAX) return { kind: 'rejected', error: 'bad_request', code: 'TEXT_TOO_LONG' };
    const media = input.content.media;
    if (media.length > 1 || media.some((m) => !m.mime.startsWith('image/'))) return { kind: 'rejected', error: 'bad_request', code: 'ONE_PHOTO_AT_MOST' };
    const link = input.content.linkUrl;
    if (g.cta && g.cta !== 'CALL' && !link) return { kind: 'rejected', error: 'bad_request', code: 'CTA_NEEDS_LINK' };
    let photo: string | null = null;
    if (media[0]) {
      photo = await input.mediaUrl(media[0].fileId).catch(() => null);
      if (!photo) return { kind: 'rejected', error: 'bad_request', code: 'MEDIA_URL_UNAVAILABLE' };
    }
    const body = {
      languageCode: g.language,
      summary,
      topicType: g.topic,
      ...(g.cta ? { callToAction: { actionType: g.cta, ...(g.cta === 'CALL' ? {} : { url: link }) } } : {}),
      ...(photo ? { media: [{ mediaFormat: 'PHOTO', sourceUrl: photo }] } : {}),
      ...(g.event
        ? {
            event: {
              ...(g.event.title ? { title: g.event.title } : {}),
              schedule: {
                startDate: dateOf(g.event.startDate),
                endDate: dateOf(g.event.endDate),
                ...(g.event.startTime ? { startTime: timeOf(g.event.startTime) } : {}),
                ...(g.event.endTime ? { endTime: timeOf(g.event.endTime) } : {}),
              },
            },
          }
        : {}),
      ...(g.offer ? { offer: { ...(g.offer.couponCode ? { couponCode: g.offer.couponCode } : {}), ...(g.offer.terms ? { termsConditions: g.offer.terms } : {}), ...(link ? { redeemOnlineUrl: link } : {}) } } : {}),
    };
    let answer: { name?: unknown; searchUrl?: unknown };
    try {
      answer = await this.client.call('POST', `https://mybusiness.googleapis.com/v4/${input.externalAccountId}/localPosts`, s.accessToken, body);
    } catch (error) {
      return publishResult(error);
    }
    const name = typeof answer.name === 'string' && POST_NAME.test(answer.name) ? answer.name : null;
    if (!name) return { kind: 'unknown', code: 'NO_POST_NAME' };
    const url = typeof answer.searchUrl === 'string' && answer.searchUrl.startsWith('https://') ? answer.searchUrl : null;
    return { kind: 'accepted', externalId: name, url };
  }

  // Deletes the local post (#1138): DELETE /v4/{accounts/*/locations/*/localPosts/*}, answered with an empty object,
  // under business.manage as publishing. Google answers NOT_FOUND (404) for a post it no longer has: gone already.
  async remove(input: RemoveInput): Promise<RemoveResult> {
    const s = googleBusinessSecretOf(input.secret);
    if (!s) return { kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' };
    if (!LOCATION.test(input.externalAccountId)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_LOCATION' };
    // Only a post of this location.
    if (!POST_NAME.test(input.externalId) || !input.externalId.startsWith(`${input.externalAccountId}/localPosts/`)) return { kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' };
    try {
      await this.client.call('DELETE', `https://mybusiness.googleapis.com/v4/${input.externalId}`, s.accessToken);
      return { kind: 'removed' };
    } catch (error) {
      if (error instanceof GoogleBusinessError && error.status === 404) return { kind: 'removed' };
      return removeResult(publishResult(error));
    }
  }

  // The location's newest posts, matched by their text within the call's time window.
  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const s = googleBusinessSecretOf(input.secret);
    if (!s || !LOCATION.test(input.externalAccountId)) return { found: 'unknown' };
    const summary = input.content.body.trim();
    try {
      const list = await this.client.call<{ localPosts?: { name?: unknown; summary?: unknown; createTime?: unknown; searchUrl?: unknown }[] }>(
        'GET',
        `https://mybusiness.googleapis.com/v4/${input.externalAccountId}/localPosts?pageSize=${PAGE_SIZE}`,
        s.accessToken,
      );
      for (const p of list.localPosts ?? []) {
        const at = typeof p.createTime === 'string' ? Date.parse(p.createTime) : Number.NaN;
        if (typeof p.name !== 'string' || !POST_NAME.test(p.name) || typeof p.summary !== 'string' || p.summary.trim() !== summary) continue;
        if (!(at >= input.after.getTime() - 60_000 && at <= input.before.getTime() + 60_000)) continue;
        return { found: true, externalId: p.name, url: typeof p.searchUrl === 'string' && p.searchUrl.startsWith('https://') ? p.searchUrl : null };
      }
      return { found: false };
    } catch {
      return { found: 'unknown' };
    }
  }

  // The location's performance (#1477), from the Business Profile Performance API:
  // GET https://businessprofileperformance.googleapis.com/v1/locations/{l}:fetchMultiDailyMetricsTimeSeries with the
  // daily metrics and an inclusive date range, under business.manage as publishing. Each value is an int64 string, left
  // out on a day it is zero. Google gives these days late (3 to 4, its Merchant Center help says) and may still change a
  // recent day, so each read asks for the PERFORMANCE_DAYS days up to yesterday (UTC) and the caller keeps the latest
  // read of each day. Profile views are the four BUSINESS_IMPRESSIONS_* series summed. A location has no followers.
  // 401: the token is refused; 403: the permission is (the project or the location not allowed), unless it is a
  // quota; a quota (429), an outage or a malformed answer is no answer, tried again the next day.
  async accountMetrics(input: AccountMetricsInput): Promise<AccountMetricsResult> {
    const s = googleBusinessSecretOf(input.secret);
    if (!s) return { refused: 'token_expired' };
    if (!LOCATION.test(input.externalAccountId)) return null;
    const location = input.externalAccountId.slice(input.externalAccountId.indexOf('/locations/') + 1);
    const end = new Date(Date.now() - 86_400_000);
    const start = new Date(end.getTime() - (PERFORMANCE_DAYS - 1) * 86_400_000);
    const query = new URLSearchParams();
    for (const metric of Object.keys(GBP_DAILY_METRICS)) query.append('dailyMetrics', metric);
    for (const [key, at] of [['start_date', start], ['end_date', end]] as const) {
      query.set(`dailyRange.${key}.year`, String(at.getUTCFullYear()));
      query.set(`dailyRange.${key}.month`, String(at.getUTCMonth() + 1));
      query.set(`dailyRange.${key}.day`, String(at.getUTCDate()));
    }
    let answer: { multiDailyMetricTimeSeries?: unknown };
    try {
      answer = await this.client.call('GET', `https://businessprofileperformance.googleapis.com/v1/${location}:fetchMultiDailyMetricsTimeSeries?${query.toString()}`, s.accessToken);
    } catch (error) {
      if (!(error instanceof GoogleBusinessError)) return null;
      if (error.status === 401) return { refused: 'token_expired' };
      if (error.status === 403 && !/quota|rate_?limit|resource_exhausted/i.test(error.reason ?? '')) return { refused: 'permission' };
      return null;
    }
    const performance = performanceOf(answer.multiDailyMetricTimeSeries, utcDayOf(start), utcDayOf(end));
    return performance ? { followers: null, performance } : null;
  }
}

// The daily metrics read for a location's performance (#1477), and the figure each counts towards.
const GBP_DAILY_METRICS: Readonly<Record<string, PerformanceName>> = {
  CALL_CLICKS: 'calls',
  BUSINESS_DIRECTION_REQUESTS: 'directions',
  WEBSITE_CLICKS: 'websiteClicks',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'views',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'views',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'views',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'views',
};
const utcDayOf = (at: Date) => at.toISOString().slice(0, 10);
const COUNT = /^\d{1,15}$/;

// The figures per day of a fetchMultiDailyMetricsTimeSeries answer, within [first, last]; a day any series gives is
// kept with all four figures (a value left out is zero). null when the answer is not that shape.
function performanceOf(raw: unknown, first: string, last: string): DailyPerformance | null {
  if (!Array.isArray(raw)) return raw === undefined ? {} : null;
  const out: DailyPerformance = {};
  for (const multi of raw as { dailyMetricTimeSeries?: unknown }[]) {
    const series = multi?.dailyMetricTimeSeries;
    if (!Array.isArray(series)) return null;
    for (const one of series as { dailyMetric?: unknown; dailySubEntityType?: unknown; timeSeries?: { datedValues?: unknown } }[]) {
      const name = typeof one?.dailyMetric === 'string' ? GBP_DAILY_METRICS[one.dailyMetric] : undefined;
      // A breakdown (by day of week or hour) would count the same people twice; only the plain series counts.
      if (!name || one.dailySubEntityType !== undefined) continue;
      const values = one.timeSeries?.datedValues ?? [];
      if (!Array.isArray(values)) return null;
      for (const v of values as { date?: { year?: unknown; month?: unknown; day?: unknown }; value?: unknown }[]) {
        const { year, month, day } = v?.date ?? {};
        if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) continue;
        const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (key < first || key > last) continue;
        if (v.value !== undefined && (typeof v.value !== 'string' || !COUNT.test(v.value))) return null;
        const figures = (out[key] ??= { calls: 0, directions: 0, websiteClicks: 0, views: 0 });
        figures[name] += v.value === undefined ? 0 : Number(v.value);
      }
    }
  }
  return out;
}
