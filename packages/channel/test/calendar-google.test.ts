// SPDX-License-Identifier: AGPL-3.0-only
// Google Calendar free/busy against recorded answers (shapes from Google's Calendar API and OAuth docs); no live call.
import { describe, expect, it } from 'vitest';
import { ConnectorError, GOOGLE_CALENDAR_FREEBUSY_SCOPE, GoogleCalendarAdapter, googleCalendarSecretOf, type Fetch } from '../src/index.ts';

const APP = { clientId: '123456789-testclientid0001.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
const SECRET = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
const REDIRECT = 'https://ludy.example/calendar/oauth/google_calendar/callback';

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

describe('GoogleCalendarAdapter', () => {
  it('asks only for the free/busy scope and the email, offline, with PKCE', () => {
    const url = new URL(new GoogleCalendarAdapter(APP).authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', GOOGLE_CALENDAR_FREEBUSY_SCOPE]);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('refuses to start without both halves of the app', () => {
    expect(() => new GoogleCalendarAdapter({ clientId: '', clientSecret: 'x' })).toThrow();
    expect(() => new GoogleCalendarAdapter({ clientId: APP.clientId, clientSecret: '' })).toThrow();
  });

  it('connects the account whose email Google verified, with its tokens and expiry', async () => {
    const { fetchImpl, calls } = google({
      'POST oauth2.googleapis.com/token': [{ body: { access_token: 'ya29.token-1', refresh_token: '1//refresh-1', expires_in: 3599, scope: `openid email ${GOOGLE_CALENDAR_FREEBUSY_SCOPE}` } }],
      'GET www.googleapis.com/oauth2/v3/userinfo': [{ body: { email: 'Lan.Nguyen@Gmail.test', email_verified: true } }],
    });
    const now = Date.parse('2026-11-01T00:00:00Z');
    const account = await new GoogleCalendarAdapter(APP, fetchImpl).exchange({ code: 'code-1', redirectUri: REDIRECT, codeVerifier: 'v'.repeat(50) }, now);
    expect(account).toMatchObject({ externalAccount: 'lan.nguyen@gmail.test', displayName: 'lan.nguyen@gmail.test', expiresAt: new Date(now + 3599_000) });
    expect(googleCalendarSecretOf(account.secret)).toEqual({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
    expect(calls[0]?.body).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(50), client_id: APP.clientId });
    expect(calls[1]?.auth).toBe('Bearer ya29.token-1');
  });

  it('refuses a grant without the calendar permission, without a refresh token, or without a verified email', async () => {
    const exchange = (token: object, info: object = { email: 'a@b.test', email_verified: true }) =>
      new GoogleCalendarAdapter(APP, google({ 'POST oauth2.googleapis.com/token': [{ body: token }], 'GET www.googleapis.com/oauth2/v3/userinfo': [{ body: info }] }).fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null });
    await expect(exchange({ access_token: 'a', refresh_token: 'r', scope: 'openid email' })).rejects.toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
    await expect(exchange({ access_token: 'a', scope: `openid email ${GOOGLE_CALENDAR_FREEBUSY_SCOPE}` })).rejects.toBeInstanceOf(ConnectorError);
    await expect(exchange({ access_token: 'a', refresh_token: 'r', scope: GOOGLE_CALENDAR_FREEBUSY_SCOPE }, { email: 'a@b.test', email_verified: false })).rejects.toMatchObject({ kind: 'denied', code: 'NO_EMAIL' });
  });

  it('maps a refused code to invalid_grant without putting the code or a token in the error', async () => {
    const { fetchImpl } = google({ 'POST oauth2.googleapis.com/token': [{ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } }] });
    const failure = await new GoogleCalendarAdapter(APP, fetchImpl).exchange({ code: 'secret-code', redirectUri: REDIRECT, codeVerifier: null }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: 'invalid_grant' });
    expect(String((failure as Error).message)).not.toContain('secret-code');
  });

  it('renews the access token and keeps the refresh token unless Google rotates it; a revoked grant is refused', async () => {
    const { fetchImpl, calls } = google({
      'POST oauth2.googleapis.com/token': [
        { body: { access_token: 'ya29.token-2', expires_in: 3599 } },
        { body: { access_token: 'ya29.token-3', refresh_token: '1//refresh-2', expires_in: 3599 } },
        { status: 400, body: { error: 'invalid_grant' } },
        { status: 503, body: { error: { code: 503, message: 'unavailable', status: 'UNAVAILABLE' } } },
      ],
    });
    const adapter = new GoogleCalendarAdapter(APP, fetchImpl);
    const first = await adapter.refresh(SECRET);
    expect('secret' in first && googleCalendarSecretOf(first.secret)).toEqual({ accessToken: 'ya29.token-2', refreshToken: '1//refresh-1' });
    const second = await adapter.refresh(SECRET);
    expect('secret' in second && googleCalendarSecretOf(second.secret)).toEqual({ accessToken: 'ya29.token-3', refreshToken: '1//refresh-2' });
    expect(await adapter.refresh(SECRET)).toEqual({ refused: 'invalid_grant' });
    expect(await adapter.refresh(SECRET)).toEqual({ failed: 'UNAVAILABLE' });
    expect(await adapter.refresh('not json')).toEqual({ refused: 'NO_REFRESH_TOKEN' });
    expect(calls[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: '1//refresh-1' });
  });

  it('asks free/busy for the primary calendar and keeps only start and end', async () => {
    const { fetchImpl, calls } = google({
      'POST www.googleapis.com/calendar/v3/freeBusy': [
        {
          body: {
            calendars: {
              primary: {
                busy: [
                  { start: '2026-11-03T02:00:00Z', end: '2026-11-03T03:30:00Z', summary: 'must never be read' },
                  { start: 'garbage', end: '2026-11-03T05:00:00Z' },
                  { start: '2026-11-03T06:00:00Z', end: '2026-11-03T06:00:00Z' },
                ],
              },
            },
          },
        },
      ],
    });
    const from = new Date('2026-11-03T00:00:00Z');
    const to = new Date('2027-01-02T00:00:00Z');
    const answer = await new GoogleCalendarAdapter(APP, fetchImpl).busy(SECRET, from, to);
    expect(answer).toEqual({ busy: [{ start: '2026-11-03T02:00:00.000Z', end: '2026-11-03T03:30:00.000Z' }] });
    expect(calls[0]?.body).toEqual({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] });
    expect(calls[0]?.auth).toBe('Bearer ya29.token-1');
  });

  it('reports a dead token as refused and anything else as a passing failure', async () => {
    const run = (route: { status?: number; body: unknown }) => new GoogleCalendarAdapter(APP, google({ 'POST www.googleapis.com/calendar/v3/freeBusy': [route] }).fetchImpl).busy(SECRET, new Date(0), new Date(1000));
    expect(await run({ status: 401, body: { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } } })).toEqual({ refused: 'invalid_token' });
    expect(await run({ status: 403, body: { error: { code: 403, message: 'quota', errors: [{ reason: 'rateLimitExceeded' }] } } })).toEqual({ failed: 'rateLimitExceeded' });
    expect(await run({ body: { calendars: { primary: { errors: [{ reason: 'notFound' }] } } } })).toEqual({ failed: 'NO_FREEBUSY' });
    expect(await run({ body: {} })).toEqual({ failed: 'NO_FREEBUSY' });
  });

  it('revokes the whole grant with the refresh token, and counts a grant Google no longer knows as revoked', async () => {
    const { fetchImpl, calls } = google({
      'POST oauth2.googleapis.com/revoke': [{ body: {} }, { status: 400, body: { error: 'invalid_token', error_description: 'Token expired or revoked' } }, { status: 503, body: { error: 'backendError' } }, { status: 400, body: { error: 'invalid_request' } }],
    });
    const adapter = new GoogleCalendarAdapter(APP, fetchImpl);
    expect(await adapter.revoke(SECRET)).toEqual({ revoked: true });
    expect(calls[0]?.body).toEqual({ token: '1//refresh-1' });
    expect(await adapter.revoke(SECRET)).toEqual({ revoked: true });
    expect(await adapter.revoke(SECRET)).toEqual({ failed: 'backendError' });
    expect(await adapter.revoke(SECRET)).toEqual({ failed: 'invalid_request' });
    // A secret with no token has nothing to revoke.
    expect(await adapter.revoke('not json')).toEqual({ revoked: true });
    expect(calls).toHaveLength(4);
  });

  it('answers a revoke it could not make as a passing failure', async () => {
    const down: Fetch = async () => {
      throw new Error('connection reset');
    };
    expect(await new GoogleCalendarAdapter(APP, down).revoke(SECRET)).toEqual({ failed: 'NETWORK' });
  });

  it('talks only to Google, over https, and follows no redirect', async () => {
    let called = '';
    const hostile: Fetch = async (input) => {
      called = input;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    };
    const answer = await new GoogleCalendarAdapter(APP, hostile).busy(SECRET, new Date(0), new Date(1000));
    expect(called).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(answer).toMatchObject({ failed: expect.any(String) });
  });
});
