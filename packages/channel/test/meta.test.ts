// The Facebook Page connector against recorded Graph API answers (shapes from Meta's docs); no live call.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allowlistedFetch, ConnectorError, FacebookPageConnector, newOAuthAttempt, oauthStateHash, type Fetch } from '../src/index.ts';

const APP = { appId: '1234567890', appSecret: 'test-app-secret-not-real' };
const REDIRECT = 'https://crove.example/channels/oauth/facebook_page/callback';

interface Seen {
  url: URL;
  method: string;
  authorization: string | null;
  form: URLSearchParams;
}

// Answers by path (and `after` cursor for the accounts list); records what was asked.
function graphFake(answers: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    seen.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization'), form });
    const grant = form.get('grant_type');
    const after = url.searchParams.get('after');
    const key = `${url.pathname}${grant ? `#${grant}` : ''}${after ? `@${after}` : ''}`;
    const answer = answers[key];
    if (!answer) return new Response(JSON.stringify({ error: { message: `no fake for ${key}`, code: 1 } }), { status: 500 });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}

const happy = {
  '/v24.0/oauth/access_token': { body: { access_token: 'short-user-token', token_type: 'bearer', expires_in: 5183 } },
  '/v24.0/oauth/access_token#fb_exchange_token': { body: { access_token: 'long-user-token', token_type: 'bearer', expires_in: 5183944 } },
  '/v24.0/me/permissions': {
    body: {
      data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'pages_manage_posts', status: 'granted' },
        { permission: 'pages_read_engagement', status: 'granted' },
        { permission: 'pages_manage_engagement', status: 'granted' },
        { permission: 'public_profile', status: 'granted' },
      ],
    },
  },
  '/v24.0/me/accounts': {
    body: {
      data: [
        { id: '111', name: 'Quán Cà Phê A', access_token: 'page-token-111', tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'] },
        { id: '222', name: 'Trang chỉ kiểm duyệt', access_token: 'page-token-222', tasks: ['MODERATE'] },
      ],
      paging: { cursors: { before: 'b1', after: 'c1' }, next: 'https://graph.facebook.com/v24.0/me/accounts?after=c1' },
    },
  },
  '/v24.0/me/accounts@c1': {
    body: { data: [{ id: '333', name: 'Tiệm Bánh B', access_token: 'page-token-333', tasks: ['CREATE_CONTENT'] }], paging: { cursors: { before: 'b2', after: 'c2' } } },
  },
};

describe('FacebookPageConnector', () => {
  it('builds the dialog URL with the state, redirect and Page scopes, without PKCE', () => {
    const connector = new FacebookPageConnector(APP);
    expect(connector.pkce).toBe(false);
    const url = new URL(connector.authorizeUrl({ state: 'st', redirectUri: REDIRECT, codeChallenge: null }));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.facebook.com/v24.0/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP.appId,
      redirect_uri: REDIRECT,
      state: 'st',
      response_type: 'code',
      scope: 'pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement',
      auth_type: 'rerequest',
    });
  });

  it('exchanges the code for every Page the user may post to, with its Page token', async () => {
    const { seen, fetchImpl } = graphFake(happy);
    const accounts = await new FacebookPageConnector(APP, fetchImpl).exchange({ code: 'the-code', redirectUri: REDIRECT, codeVerifier: null });
    expect(accounts).toEqual([
      { provider: 'facebook_page', externalAccountId: '111', displayName: 'Quán Cà Phê A', scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement'], expiresAt: null, secret: JSON.stringify({ accessToken: 'page-token-111' }) },
      { provider: 'facebook_page', externalAccountId: '333', displayName: 'Tiệm Bánh B', scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement'], expiresAt: null, secret: JSON.stringify({ accessToken: 'page-token-333' }) },
    ]);
    // The code goes to the token endpoint with the same redirect; user tokens travel in the header, never the URL,
    // with appsecret_proof.
    // The code and the app secret go in a POST body, never in a URL.
    expect(seen[0]).toMatchObject({ method: 'POST' });
    expect(seen[0]?.form.get('code')).toBe('the-code');
    expect(seen[0]?.form.get('redirect_uri')).toBe(REDIRECT);
    for (const s of seen) expect(s.url.toString()).not.toContain(APP.appSecret);
    for (const s of seen.slice(2)) {
      expect(s.url.toString()).not.toContain('long-user-token');
      expect(s.authorization).toBe('Bearer long-user-token');
      expect(s.url.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', APP.appSecret).update('long-user-token').digest('hex'));
    }
    expect(seen.every((s) => s.url.hostname === 'graph.facebook.com')).toBe(true);
  });

  it('maps a refused code to invalid_grant and a missing permission to denied', async () => {
    const refused = graphFake({ '/v24.0/oauth/access_token': { status: 400, body: { error: { message: 'This authorization code has been used.', type: 'OAuthException', code: 100, error_subcode: 36009 } } } });
    await expect(new FacebookPageConnector(APP, refused.fetchImpl).exchange({ code: 'used', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    // A rate limit or a wrong app secret is not the user's code.
    const limited = graphFake({ '/v24.0/oauth/access_token': { status: 400, body: { error: { message: 'Application request limit reached', type: 'OAuthException', code: 4 } } } });
    await expect(new FacebookPageConnector(APP, limited.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'provider' });

    const partial = graphFake({ ...happy, '/v24.0/me/permissions': { body: { data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'declined' }] } } });
    const error = await new FacebookPageConnector(APP, partial.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ kind: 'denied', code: 'MISSING_PERMISSION' });
    expect((error as Error).message).not.toContain('token');
  });

  it('connects a Page without the first-comment permission when Meta holds it back (#609)', async () => {
    const declined = graphFake({
      ...happy,
      '/v24.0/me/permissions': {
        body: {
          data: [
            { permission: 'pages_show_list', status: 'granted' },
            { permission: 'pages_manage_posts', status: 'granted' },
            { permission: 'pages_read_engagement', status: 'granted' },
            { permission: 'pages_manage_engagement', status: 'declined' },
          ],
        },
      },
    });
    const accounts = await new FacebookPageConnector(APP, declined.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null });
    expect(accounts.map((a) => a.scopes)).toEqual([
      ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
      ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
    ]);
  });

  it('turns a Graph outage into a provider error', async () => {
    const down = graphFake({ ...happy, '/v24.0/me/accounts': { status: 503, body: { error: { message: 'Service temporarily unavailable', code: 2 } } } });
    await expect(new FacebookPageConnector(APP, down.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'provider' });
  });

  it('refuses a malformed app id or Graph version', () => {
    expect(() => new FacebookPageConnector({ ...APP, appId: 'abc' })).toThrow();
    expect(() => new FacebookPageConnector({ ...APP, graphVersion: '24' })).toThrow();
  });
});

describe('OAuth helpers', () => {
  it('makes a 43-character state, its sha256 hash, and an S256 PKCE pair when asked', () => {
    const plain = newOAuthAttempt(false);
    expect(plain.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(plain.stateHash).toBe(oauthStateHash(plain.state));
    expect(plain.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plain).toMatchObject({ codeVerifier: null, codeChallenge: null });
    const pkce = newOAuthAttempt(true);
    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps requests on the allowlisted https hosts and does not follow redirects', async () => {
    const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const guarded = allowlistedFetch(['graph.facebook.com'], async (url, init) => {
      calls.push({ url, redirect: init?.redirect });
      return new Response('{}');
    });
    await guarded('https://graph.facebook.com/v24.0/me');
    await expect(guarded('https://evil.example/v24.0/me')).rejects.toThrow(/not allowed/);
    await expect(guarded('http://graph.facebook.com/v24.0/me')).rejects.toThrow(/not allowed/);
    expect(calls).toEqual([{ url: 'https://graph.facebook.com/v24.0/me', redirect: 'manual' }]);
  });
});
