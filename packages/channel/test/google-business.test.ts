// Google Business Profile against recorded answers (shapes from Google's Business Profile APIs docs); no live call.
import { describe, expect, it } from 'vitest';
import { GoogleBusinessConnector, GoogleBusinessPublisher, GoogleBusinessRefresher, gbpSettingsOf, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { clientId: '123456789-testclientid0001.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
const SECRET = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
const REDIRECT = 'https://crove.example/channels/oauth/google_business/callback';
const LOCATION = 'accounts/1001/locations/2002';

function google(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; body: unknown; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const raw = init?.body;
    const headers = new Headers(init?.headers);
    calls.push({ route, auth: headers.get('authorization'), body: typeof raw === 'string' ? (headers.get('content-type')?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : raw });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { code: 500, message: `no answer for ${route}`, status: 'INTERNAL' } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: LOCATION,
  secret: SECRET,
  content: { body: 'Bánh mới đã về, ghé tiệm nhé!', title: null, linkUrl: 'https://tiembanh.example/', media: [] },
  readMedia: async () => new Uint8Array(),
  mediaUrl: async (fileId) => `https://bucket.example/${fileId}`,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});
const POSTED = { name: `${LOCATION}/localPosts/abc123`, searchUrl: 'https://local.google.com/place?id=1&use=posts&lpsid=abc123' };

describe('GoogleBusinessConnector', () => {
  it('asks for business.manage offline and connects each location the account manages', async () => {
    const { fetchImpl, calls } = google({
      'POST oauth2.googleapis.com/token': [{ body: { access_token: 'ya29.token-1', refresh_token: '1//refresh-1', expires_in: 3599, scope: 'https://www.googleapis.com/auth/business.manage' } }],
      'GET mybusinessaccountmanagement.googleapis.com/v1/accounts': [{ body: { accounts: [{ name: 'accounts/1001' }, { name: 'not-an-account' }] } }],
      'GET mybusinessbusinessinformation.googleapis.com/v1/accounts/1001/locations': [{ body: { locations: [{ name: 'locations/2002', title: 'Tiệm Bánh Quận 1' }, { name: 'locations/2003', title: 'Tiệm Bánh Thủ Đức' }] } }],
    });
    const connector = new GoogleBusinessConnector(APP, fetchImpl);
    const url = new URL(connector.authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: 'cc' }));
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/business.manage');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const accounts = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: 'v' }, 1_000_000);
    expect(accounts.map((a) => [a.externalAccountId, a.displayName])).toEqual([
      ['accounts/1001/locations/2002', 'Tiệm Bánh Quận 1'],
      ['accounts/1001/locations/2003', 'Tiệm Bánh Thủ Đức'],
    ]);
    expect(accounts[0]).toMatchObject({ provider: 'google_business', secret: SECRET, expiresAt: new Date(1_000_000 + 3_599_000) });
    expect(calls[0]?.body).toMatchObject({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v' });
    expect(calls[2]?.auth).toBe('Bearer ya29.token-1');
  });

  it('refuses a grant without the permission, an account with no location, and a project Google has not approved', async () => {
    const narrow = google({ 'POST oauth2.googleapis.com/token': [{ body: { access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: 'openid' } }] });
    await expect(new GoogleBusinessConnector(APP, narrow.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
    const token = { body: { access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: 'https://www.googleapis.com/auth/business.manage' } };
    const empty = google({ 'POST oauth2.googleapis.com/token': [token], 'GET mybusinessaccountmanagement.googleapis.com/v1/accounts': [{ body: {} }] });
    await expect(new GoogleBusinessConnector(APP, empty.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied', code: 'NO_LOCATION' });
    const unapproved = google({ 'POST oauth2.googleapis.com/token': [token], 'GET mybusinessaccountmanagement.googleapis.com/v1/accounts': [{ status: 429, body: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } }] });
    await expect(new GoogleBusinessConnector(APP, unapproved.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied' });
  });
});

describe('GoogleBusinessRefresher', () => {
  it('renews the access token and tells a revoked grant from an outage', async () => {
    const ok = google({ 'POST oauth2.googleapis.com/token': [{ body: { access_token: 'ya29.token-2', expires_in: 3599 } }] });
    expect(await new GoogleBusinessRefresher(APP, ok.fetchImpl).refresh(SECRET)).toMatchObject({ secret: JSON.stringify({ accessToken: 'ya29.token-2', refreshToken: '1//refresh-1' }) });
    const dead = google({ 'POST oauth2.googleapis.com/token': [{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }] });
    expect(await new GoogleBusinessRefresher(APP, dead.fetchImpl).refresh(SECRET)).toEqual({ refused: 'invalid_grant' });
  });
});

describe('GoogleBusinessPublisher', () => {
  const route = `POST mybusiness.googleapis.com/v4/${LOCATION}/localPosts`;

  it('posts an update with a call to action and a photo', async () => {
    const { fetchImpl, calls } = google({ [route]: [{ body: POSTED }] });
    const media = [{ fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 50_000, altText: null }];
    const result = await new GoogleBusinessPublisher(APP, fetchImpl).publish(input({ content: { ...input().content, media }, settings: { gbp: { topic: 'STANDARD', cta: 'ORDER' } } }));
    expect(result).toEqual({ kind: 'accepted', externalId: POSTED.name, url: POSTED.searchUrl });
    expect(calls[0]?.body).toEqual({
      languageCode: 'vi',
      summary: 'Bánh mới đã về, ghé tiệm nhé!',
      topicType: 'STANDARD',
      callToAction: { actionType: 'ORDER', url: 'https://tiembanh.example/' },
      media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://bucket.example/f-1' }],
    });
  });

  it('posts an event and an offer with their schedule, and a call without a link', async () => {
    const { fetchImpl, calls } = google({ [route]: [{ body: POSTED }, { body: POSTED }] });
    const publisher = new GoogleBusinessPublisher(APP, fetchImpl);
    const event = { title: 'Đêm nhạc Trung thu', startDate: '2026-09-25', startTime: '18:30', endDate: '2026-09-25', endTime: '21:00' };
    expect((await publisher.publish(input({ content: { ...input().content, linkUrl: null }, settings: { gbp: { topic: 'EVENT', cta: 'CALL', event } } }))).kind).toBe('accepted');
    expect(calls[0]?.body).toMatchObject({
      topicType: 'EVENT',
      callToAction: { actionType: 'CALL' },
      event: { title: 'Đêm nhạc Trung thu', schedule: { startDate: { year: 2026, month: 9, day: 25 }, startTime: { hours: 18, minutes: 30, seconds: 0, nanos: 0 }, endDate: { year: 2026, month: 9, day: 25 }, endTime: { hours: 21, minutes: 0, seconds: 0, nanos: 0 } } },
    });
    expect(await publisher.publish(input({ settings: { gbp: { topic: 'OFFER', event: { startDate: '2026-11-11', endDate: '2026-11-12' }, offer: { couponCode: 'SALE1111', terms: 'Áp dụng cho đơn từ 200.000đ' } } } }))).toMatchObject({ kind: 'accepted' });
    expect(calls[1]?.body).toMatchObject({ topicType: 'OFFER', event: { schedule: { startDate: { year: 2026, month: 11, day: 11 }, endDate: { year: 2026, month: 11, day: 12 } } }, offer: { couponCode: 'SALE1111', termsConditions: 'Áp dụng cho đơn từ 200.000đ', redeemOnlineUrl: 'https://tiembanh.example/' } });
  });

  it('refuses what Google would before any call, and maps its answers', async () => {
    const none = google({});
    const publisher = new GoogleBusinessPublisher(APP, none.fetchImpl);
    expect(await publisher.publish(input({ settings: { gbp: { topic: 'EVENT', event: { title: '', startDate: '2026-09-25', endDate: '2026-09-25' } } } }))).toMatchObject({ code: 'GBP_SETTINGS_INVALID' });
    expect(await publisher.publish(input({ settings: { gbp: { topic: 'PRODUCT' } } }))).toMatchObject({ code: 'GBP_SETTINGS_INVALID' });
    expect(await publisher.publish(input({ content: { ...input().content, linkUrl: null }, settings: { gbp: { cta: 'SHOP' } } }))).toMatchObject({ code: 'CTA_NEEDS_LINK' });
    expect(await publisher.publish(input({ content: { ...input().content, body: 'x'.repeat(1501) } }))).toMatchObject({ code: 'TEXT_TOO_LONG' });
    expect(await publisher.publish(input({ content: { ...input().content, media: [{ fileId: 'v', mime: 'video/mp4', sizeBytes: 1, altText: null }] } }))).toMatchObject({ code: 'ONE_PHOTO_AT_MOST' });
    expect(await publisher.publish(input({ externalAccountId: 'locations/1' }))).toMatchObject({ code: 'BAD_LOCATION' });
    expect(none.calls).toHaveLength(0);
    const refused = google({ [route]: [{ status: 401, body: { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } } }, { status: 503, body: {} }] });
    const p = new GoogleBusinessPublisher(APP, refused.fetchImpl);
    expect(await p.publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(await p.publish(input())).toMatchObject({ kind: 'unknown' });
  });

  it('finds a post that went through by its text and time', async () => {
    const now = new Date();
    const { fetchImpl } = google({
      [`GET mybusiness.googleapis.com/v4/${LOCATION}/localPosts`]: [{ body: { localPosts: [{ name: `${LOCATION}/localPosts/other`, summary: 'Bài khác', createTime: now.toISOString() }, { ...POSTED, summary: 'Bánh mới đã về, ghé tiệm nhé!', createTime: now.toISOString() }] } }],
    });
    const reconcile = { ...input(), after: new Date(now.getTime() - 60_000), before: new Date(now.getTime() + 1_000) };
    expect(await new GoogleBusinessPublisher(APP, fetchImpl).reconcile(reconcile)).toEqual({ found: true, externalId: POSTED.name, url: POSTED.searchUrl });
  });

  it('reads its settings as the module writes them', () => {
    expect(gbpSettingsOf({})).toEqual({ topic: 'STANDARD', cta: null, event: null, offer: null });
    expect(gbpSettingsOf({ gbp: { topic: 'EVENT', event: { title: 'x', startDate: '2026-01-02', endDate: '2026-01-01' } } })).toBeNull();
    expect(gbpSettingsOf({ gbp: 'yes' })).toBeNull();
  });
});
