// YouTube against recorded answers (shapes from the YouTube Data API v3 and Google OAuth docs); no live call.
import { describe, expect, it } from 'vitest';
import { YouTubeConnector, YouTubePublisher, YouTubeRefresher, clipBytes, clipCodepoints, newOAuthAttempt, type Fetch, type PublishInput } from '../src/index.ts';

const APP = { clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const SECRET = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
const REDIRECT = 'https://crove.example/channels/oauth/youtube/callback';
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xyz';

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
function google(routes: Record<string, Answer[]>) {
  const calls: { route: string; headers: Headers; body: unknown; url: URL }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    calls.push({ route, headers, url, body: typeof raw === 'string' ? (headers.get('content-type')?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : raw });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, errors: [{ reason: 'backendError' }] } } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json', ...answer.headers } });
  };
  return { calls, fetchImpl };
}

const video = { fileId: 'f-1', mime: 'video/mp4', sizeBytes: 3, altText: null };
const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: CHANNEL,
  secret: SECRET,
  content: { body: 'Video khai trương <mới>', title: 'Khai trương chi nhánh', linkUrl: 'https://example.com/a', media: [video] },
  readMedia: async () => new Uint8Array([0, 0, 1]),
  mediaUrl: async () => null,
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});

describe('YouTubeConnector', () => {
  it('asks for upload with offline access and PKCE, and connects the channel with its refresh token', async () => {
    const { fetchImpl, calls } = google({
      'POST oauth2.googleapis.com/token': [{ body: { access_token: 'ya29.token-1', refresh_token: '1//refresh-1', expires_in: 3599, scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' } }],
      'GET www.googleapis.com/youtube/v3/channels': [{ body: { items: [{ id: CHANNEL, snippet: { title: 'Tiệm Bánh B' } }] } }],
    });
    const connector = new YouTubeConnector(APP, fetchImpl);
    const attempt = newOAuthAttempt(true);
    const url = new URL(connector.authorizeUrl({ state: attempt.state, redirectUri: REDIRECT, codeChallenge: attempt.codeChallenge }));
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ access_type: 'offline', prompt: 'consent', code_challenge_method: 'S256', code_challenge: attempt.codeChallenge });
    const [account] = await connector.exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: attempt.codeVerifier }, 1_000_000);
    expect(account).toMatchObject({ provider: 'youtube', externalAccountId: CHANNEL, displayName: 'Tiệm Bánh B', secret: SECRET, expiresAt: new Date(1_000_000 + 3_599_000) });
    expect(calls[0]?.body).toMatchObject({ grant_type: 'authorization_code', code: 'c', code_verifier: attempt.codeVerifier, client_id: APP.clientId });
  });

  it('refuses an account without a channel, a grant without upload, and a used code', async () => {
    const token = { body: { access_token: 't', refresh_token: 'r', expires_in: 3599, scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' } };
    const none = google({ 'POST oauth2.googleapis.com/token': [token], 'GET www.googleapis.com/youtube/v3/channels': [{ body: { items: [] } }] });
    await expect(new YouTubeConnector(APP, none.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied', code: 'NO_CHANNEL' });
    const narrow = google({ 'POST oauth2.googleapis.com/token': [{ body: { ...token.body, scope: 'https://www.googleapis.com/auth/youtube.readonly' } }] });
    await expect(new YouTubeConnector(APP, narrow.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'denied' });
    const used = google({ 'POST oauth2.googleapis.com/token': [{ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } }] });
    await expect(new YouTubeConnector(APP, used.fetchImpl).exchange({ code: 'used', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'invalid_grant' });
    // A wrong client secret is the deployment's to fix, not a refused code.
    const misconfigured = google({ 'POST oauth2.googleapis.com/token': [{ status: 401, body: { error: 'invalid_client', error_description: 'Unauthorized' } }] });
    await expect(new YouTubeConnector(APP, misconfigured.fetchImpl).exchange({ code: 'c', redirectUri: REDIRECT, codeVerifier: null })).rejects.toMatchObject({ kind: 'provider', code: 'invalid_client' });
  });
});

describe('clipping', () => {
  it('cuts a description by UTF-8 bytes and a title by characters, never inside one', () => {
    const viet = 'ệ'.repeat(2000);
    expect(new TextEncoder().encode(clipBytes(viet, 5000)).length).toBe(4998);
    expect(clipBytes('abc', 5000)).toBe('abc');
    expect(clipCodepoints('😀'.repeat(101), 100)).toBe('😀'.repeat(100));
  });
});

describe('YouTubeRefresher', () => {
  it('renews the hour-long token a quarter of an hour ahead, keeping the refresh token, and tells a revoked grant from an outage', async () => {
    const ok = google({ 'POST oauth2.googleapis.com/token': [{ body: { access_token: 'ya29.token-2', expires_in: 3599 } }] });
    const refresher = new YouTubeRefresher(APP, ok.fetchImpl);
    expect(refresher.horizonSeconds).toBe(900);
    expect(await refresher.refresh(SECRET)).toMatchObject({ secret: JSON.stringify({ accessToken: 'ya29.token-2', refreshToken: '1//refresh-1' }) });
    expect(ok.calls[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: '1//refresh-1' });
    const revoked = google({ 'POST oauth2.googleapis.com/token': [{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }] });
    expect(await new YouTubeRefresher(APP, revoked.fetchImpl).refresh(SECRET)).toEqual({ refused: 'invalid_grant' });
    const down = google({ 'POST oauth2.googleapis.com/token': [{ status: 503, body: {} }] });
    expect(await new YouTubeRefresher(APP, down.fetchImpl).refresh(SECRET)).toEqual({ failed: '503' });
  });
});

describe('YouTubePublisher', () => {
  it('opens a resumable session with the metadata, then sends the bytes once', async () => {
    const { fetchImpl, calls } = google({
      'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, headers: { location: SESSION } }],
      'PUT www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, body: { id: 'dQw4w9WgXcQ', status: { uploadStatus: 'uploaded' } } }],
    });
    // An upload has longer than the job's default to finish, and less than the job's stale limit (600 s).
    expect(new YouTubePublisher(APP, fetchImpl).callTimeoutMs).toBeGreaterThan(300_000);
    expect(new YouTubePublisher(APP, fetchImpl).callTimeoutMs).toBeLessThan(600_000);
    expect(await new YouTubePublisher(APP, fetchImpl).publish(input({ settings: { privacy: 'unlisted' }, content: { ...input().content, title: 'Khai trương <chi nhánh>' } }))).toEqual({ kind: 'accepted', externalId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(calls[0]?.url.searchParams.get('uploadType')).toBe('resumable');
    expect(calls[0]?.body).toEqual({
      snippet: { title: 'Khai trương chi nhánh', description: 'Video khai trương mới\n\nhttps://example.com/a', categoryId: '22' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, embeddable: true },
    });
    expect(calls[1]?.url.searchParams.get('upload_id')).toBe('xyz');
    expect(calls[1]?.headers.get('content-type')).toBe('video/mp4');
  });

  it('posts nothing without one video or a title, and waits out the daily quota', async () => {
    const none = google({});
    expect(await new YouTubePublisher(APP, none.fetchImpl).publish(input({ content: { body: 'x', title: 'T', linkUrl: null, media: [] } }))).toMatchObject({ code: 'ONE_VIDEO_REQUIRED' });
    expect(await new YouTubePublisher(APP, none.fetchImpl).publish(input({ content: { body: 'x', title: ' ', linkUrl: null, media: [video] } }))).toMatchObject({ code: 'TITLE_REQUIRED' });
    expect(none.calls).toHaveLength(0);
    const quota = google({ 'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 403, body: { error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } } }] });
    expect(await new YouTubePublisher(APP, quota.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'quotaExceeded' });
  });

  it('treats a failed byte transfer as unknown and finds the video among the latest uploads', async () => {
    const { fetchImpl } = google({
      'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, headers: { location: SESSION } }],
      'PUT www.googleapis.com/upload/youtube/v3/videos': [{ status: 503, body: {} }],
      'GET www.googleapis.com/youtube/v3/playlistItems': [
        {
          body: {
            items: [
              // The same title in the window, another video: an earlier post repeated with other text.
              { snippet: { title: 'Khai trương chi nhánh', description: 'Bài cũ', publishedAt: new Date().toISOString(), resourceId: { videoId: 'zyxwvutsrqp' } } },
              { snippet: { title: 'Khai trương chi nhánh', description: 'Video khai trương mới\r\n\r\nhttps://example.com/a', publishedAt: new Date().toISOString(), resourceId: { videoId: 'abcdefghijk' } } },
            ],
          },
        },
      ],
    });
    const publisher = new YouTubePublisher(APP, fetchImpl);
    expect((await publisher.publish(input())).kind).toBe('unknown');
    const found = await publisher.reconcile({ externalAccountId: CHANNEL, secret: SECRET, callKey: 'call-1', contentHash: input().contentHash, content: input().content, after: new Date(Date.now() - 60_000), before: new Date() });
    expect(found).toEqual({ found: true, externalId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  });

  it('finds a video without a description when YouTube leaves the field out', async () => {
    const { fetchImpl } = google({
      'GET www.googleapis.com/youtube/v3/playlistItems': [{ body: { items: [{ snippet: { title: 'Khai trương chi nhánh', publishedAt: new Date().toISOString(), resourceId: { videoId: 'abcdefghijk' } } }] } }],
    });
    const content = { body: '', title: 'Khai trương chi nhánh', linkUrl: null, media: [video] };
    const found = await new YouTubePublisher(APP, fetchImpl).reconcile({ externalAccountId: CHANNEL, secret: SECRET, callKey: 'call-1', contentHash: input().contentHash, content, after: new Date(Date.now() - 60_000), before: new Date() });
    expect(found).toMatchObject({ found: true, externalId: 'abcdefghijk' });
  });

  it('maps a dead token while opening the session to token_expired, with nothing sent', async () => {
    const dead = google({ 'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 401, body: { error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } } }] });
    expect(await new YouTubePublisher(APP, dead.fetchImpl).publish(input())).toMatchObject({ kind: 'rejected', error: 'token_expired' });
  });
});

describe('YouTubePublisher metrics', () => {
  const at = { externalAccountId: CHANNEL, secret: SECRET, externalId: 'dQw4w9WgXcQ' };

  it('reads views, likes and comments, and leaves out a hidden like count', async () => {
    const { fetchImpl, calls } = google({
      'GET www.googleapis.com/youtube/v3/videos': [
        { body: { items: [{ id: 'dQw4w9WgXcQ', statistics: { viewCount: '1520', likeCount: '87', favoriteCount: '0', commentCount: '12' } }] } },
        { body: { items: [{ id: 'dQw4w9WgXcQ', statistics: { viewCount: '1600', commentCount: '13' } }] } },
      ],
    });
    const publisher = new YouTubePublisher(APP, fetchImpl);
    expect(await publisher.metrics(at)).toEqual({ metrics: { views: 1520, reactions: 87, comments: 12 } });
    expect(calls[0]?.url.searchParams.get('part')).toBe('statistics');
    expect(calls[0]?.url.searchParams.get('id')).toBe('dQw4w9WgXcQ');
    expect(await publisher.metrics(at)).toEqual({ metrics: { views: 1600, comments: 13 } });
  });

  it('tells a deleted video and a dead token from an outage', async () => {
    const gone = google({ 'GET www.googleapis.com/youtube/v3/videos': [{ body: { items: [] } }] });
    expect(await new YouTubePublisher(APP, gone.fetchImpl).metrics(at)).toEqual({ refused: 'gone' });
    const dead = google({ 'GET www.googleapis.com/youtube/v3/videos': [{ status: 401, body: { error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } } }] });
    expect(await new YouTubePublisher(APP, dead.fetchImpl).metrics(at)).toEqual({ refused: 'token_expired' });
    const down = google({ 'GET www.googleapis.com/youtube/v3/videos': [{ status: 503, body: {} }] });
    expect(await new YouTubePublisher(APP, down.fetchImpl).metrics(at)).toBeNull();
    expect(await new YouTubePublisher(APP, down.fetchImpl).metrics({ ...at, externalId: 'not a video id' })).toEqual({ refused: 'gone' });
  });
});