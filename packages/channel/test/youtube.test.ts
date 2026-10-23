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

describe('YouTubePublisher first comment (#791)', () => {
  const comment = { externalAccountId: CHANNEL, secret: SECRET, externalId: 'dQw4w9WgXcQ', text: 'Đặt bánh tại https://example.com/a', callKey: 'call-c1' };

  it('asks for the comment scope without requiring it, and posts a top-level comment on the video', async () => {
    const connector = new YouTubeConnector(APP, google({}).fetchImpl);
    const url = new URL(connector.authorizeUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null }));
    expect(url.searchParams.get('scope')?.split(' ')).toContain('https://www.googleapis.com/auth/youtube.force-ssl');
    const { fetchImpl, calls } = google({ 'POST www.googleapis.com/youtube/v3/commentThreads': [{ body: { id: 'UgzComment1', snippet: {} } }] });
    expect(await new YouTubePublisher(APP, fetchImpl).comment(comment)).toEqual({ kind: 'accepted', externalId: 'UgzComment1' });
    expect(calls[0]?.url.searchParams.get('part')).toBe('snippet');
    expect(calls[0]?.body).toEqual({ snippet: { channelId: CHANNEL, videoId: 'dQw4w9WgXcQ', topLevelComment: { snippet: { textOriginal: comment.text } } } });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ya29.token-1');
  });

  it('tells a grant without the comment scope, comments turned off and a lost answer apart', async () => {
    const scope = google({ 'POST www.googleapis.com/youtube/v3/commentThreads': [{ status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } } }] });
    expect(await new YouTubePublisher(APP, scope.fetchImpl).comment(comment)).toMatchObject({ kind: 'rejected', error: 'permission', code: 'RECONNECT_FOR_COMMENTS' });
    const off = google({ 'POST www.googleapis.com/youtube/v3/commentThreads': [{ status: 403, body: { error: { code: 403, message: 'Comments are disabled.', errors: [{ reason: 'commentsDisabled' }] } } }] });
    expect(await new YouTubePublisher(APP, off.fetchImpl).comment(comment)).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'COMMENTS_DISABLED' });
    const lost = google({ 'POST www.googleapis.com/youtube/v3/commentThreads': [{ status: 503, body: { error: { message: 'Backend Error', errors: [{ reason: 'backendError' }] } } }] });
    expect(await new YouTubePublisher(APP, lost.fetchImpl).comment(comment)).toMatchObject({ kind: 'unknown' });
    expect(await new YouTubePublisher(APP, google({}).fetchImpl).comment({ ...comment, externalId: 'not a video' })).toMatchObject({ kind: 'rejected', code: 'BAD_POST_ID' });
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

  it('sends the category, tags and audience the person chose (#905)', async () => {
    const { fetchImpl, calls } = google({
      'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, headers: { location: SESSION } }],
      'PUT www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, body: { id: 'dQw4w9WgXcQ' } }],
    });
    const settings = { privacy: 'public', categoryId: '26', madeForKids: true, tags: ['bánh mì', ' Sài Gòn ', '', 'ẩm <thực>', 7] };
    expect(await new YouTubePublisher(APP, fetchImpl).publish(input({ settings }))).toMatchObject({ kind: 'accepted', externalId: 'dQw4w9WgXcQ' });
    // Tags keep their Vietnamese marks; each is trimmed, an empty one or one that is not text is dropped.
    expect(calls[0]?.body).toEqual({
      snippet: { title: 'Khai trương chi nhánh', description: 'Video khai trương mới\n\nhttps://example.com/a', categoryId: '26', tags: ['bánh mì', 'Sài Gòn', 'ẩm thực'] },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: true, embeddable: true },
    });
  });

  it('discloses altered or synthetic content as status.containsSyntheticMedia, only when on (#1078)', async () => {
    const { fetchImpl, calls } = google({
      'POST www.googleapis.com/upload/youtube/v3/videos': [
        { status: 200, headers: { location: SESSION } },
        { status: 200, headers: { location: SESSION } },
      ],
      'PUT www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, body: { id: 'dQw4w9WgXcQ' } }, { status: 200, body: { id: 'dQw4w9WgXcR' } }],
    });
    const publisher = new YouTubePublisher(APP, fetchImpl);
    expect(await publisher.publish(input({ settings: { privacy: 'public', syntheticMedia: true } }))).toMatchObject({ kind: 'accepted' });
    expect(calls[0]?.url.searchParams.get('part')).toBe('snippet,status');
    expect(calls[0]?.body).toEqual({
      snippet: { title: 'Khai trương chi nhánh', description: 'Video khai trương mới\n\nhttps://example.com/a', categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, embeddable: true, containsSyntheticMedia: true },
    });
    // Off, or not true or false, sends no disclosure: the body a variant saved before #1078 always sent.
    await publisher.publish(input({ settings: { privacy: 'public', syntheticMedia: 'yes' } }));
    expect(calls[2]?.body).toEqual({
      snippet: { title: 'Khai trương chi nhánh', description: 'Video khai trương mới\n\nhttps://example.com/a', categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, embeddable: true },
    });
  });

  it('keeps the old defaults for a variant saved without the video details: category 22, not made for kids, no tags', async () => {
    const { fetchImpl, calls } = google({
      'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, headers: { location: SESSION } }],
      'PUT www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, body: { id: 'dQw4w9WgXcQ' } }],
    });
    await new YouTubePublisher(APP, fetchImpl).publish(input({ settings: { categoryId: 'music', madeForKids: 'yes', tags: 'bánh mì' } }));
    const sent = calls[0]?.body as { snippet: Record<string, unknown>; status: Record<string, unknown> };
    expect(sent.snippet.categoryId).toBe('22');
    expect(sent.snippet).not.toHaveProperty('tags');
    expect(sent.status.selfDeclaredMadeForKids).toBe(false);
  });

  it('sets an image cover as the thumbnail after the upload, read before anything is sent (#642)', async () => {
    const { fetchImpl, calls } = google({
      'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, headers: { location: SESSION } }],
      'PUT www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, body: { id: 'dQw4w9WgXcQ' } }],
      'POST www.googleapis.com/upload/youtube/v3/thumbnails/set': [{ status: 200, body: { items: [{ default: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg' } }] } }],
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const read: string[] = [];
    const readMedia = async (fileId: string) => {
      read.push(fileId);
      return fileId === 'c-1' ? png : new Uint8Array([0, 0, 1]);
    };
    expect(await new YouTubePublisher(APP, fetchImpl).publish(input({ readMedia, settings: { cover: { fileId: 'c-1' } } }))).toMatchObject({ kind: 'accepted', externalId: 'dQw4w9WgXcQ' });
    expect(read).toEqual(['f-1', 'c-1']);
    expect(calls.map((c) => c.route)).toEqual(['POST www.googleapis.com/upload/youtube/v3/videos', 'PUT www.googleapis.com/upload/youtube/v3/videos', 'POST www.googleapis.com/upload/youtube/v3/thumbnails/set']);
    expect(calls[2]?.url.searchParams.get('videoId')).toBe('dQw4w9WgXcQ');
    expect(calls[2]?.headers.get('content-type')).toBe('image/png');
  });

  it('keeps an uploaded video accepted when YouTube refuses its thumbnail', async () => {
    const { fetchImpl, calls } = google({
      'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, headers: { location: SESSION } }],
      'PUT www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, body: { id: 'dQw4w9WgXcQ' } }],
      'POST www.googleapis.com/upload/youtube/v3/thumbnails/set': [{ status: 403, body: { error: { message: 'The authenticated user does not have permissions to upload and set custom video thumbnails.', errors: [{ reason: 'forbidden' }] } } }],
    });
    expect(await new YouTubePublisher(APP, fetchImpl).publish(input({ settings: { cover: { fileId: 'c-1' } } }))).toEqual({ kind: 'accepted', externalId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(calls[2]?.headers.get('content-type')).toBe('image/jpeg');
  });

  it('posts nothing with a frame cover, which the Data API cannot set, or a cover image it cannot read', async () => {
    const none = google({});
    expect(await new YouTubePublisher(APP, none.fetchImpl).publish(input({ settings: { cover: { atMs: 1000 } } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' });
    const unreadable = async (fileId: string) => {
      if (fileId === 'c-1') throw new Error('gone');
      return new Uint8Array([0, 0, 1]);
    };
    expect(await new YouTubePublisher(APP, none.fetchImpl).publish(input({ readMedia: unreadable, settings: { cover: { fileId: 'c-1' } } }))).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(none.calls).toHaveLength(0);
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
describe('YouTubePublisher playlists (#1018)', () => {
  const SALE = 'PLabcdefghijklmnopqrstuvwxyz012345';
  const GONE = 'PL0123456789abcdef';
  const item = (playlistId: string) => ({ externalAccountId: CHANNEL, secret: SECRET, externalId: 'dQw4w9WgXcQ', playlistId, callKey: `call-${playlistId}` });
  const notFound = { status: 404, body: { error: { code: 404, message: 'Playlist not found.', errors: [{ reason: 'playlistNotFound' }] } } };

  it('uploads the video, then puts it into each playlist with its own insert', async () => {
    const { fetchImpl, calls } = google({
      'POST www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, headers: { location: SESSION } }],
      'PUT www.googleapis.com/upload/youtube/v3/videos': [{ status: 200, body: { id: 'dQw4w9WgXcQ', status: { uploadStatus: 'uploaded' } } }],
      'POST www.googleapis.com/youtube/v3/playlistItems': [{ body: { kind: 'youtube#playlistItem', id: 'UExpdGVtMQ' } }, { body: { kind: 'youtube#playlistItem', id: 'UExpdGVtMg' } }],
    });
    const publisher = new YouTubePublisher(APP, fetchImpl);
    // The playlists are not part of the upload: its metadata is what it always was.
    expect(await publisher.publish(input({ settings: { youtube: { playlistIds: [SALE, GONE] } } }))).toMatchObject({ kind: 'accepted', externalId: 'dQw4w9WgXcQ' });
    expect(calls[0]?.body).toEqual({
      snippet: { title: 'Khai trương chi nhánh', description: 'Video khai trương mới\n\nhttps://example.com/a', categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, embeddable: true },
    });
    expect(await publisher.playlist(item(SALE))).toEqual({ kind: 'accepted', externalId: 'UExpdGVtMQ' });
    expect(await publisher.playlist(item(GONE))).toEqual({ kind: 'accepted', externalId: 'UExpdGVtMg' });
    expect(calls.map((c) => c.route)).toEqual([
      'POST www.googleapis.com/upload/youtube/v3/videos',
      'PUT www.googleapis.com/upload/youtube/v3/videos',
      'POST www.googleapis.com/youtube/v3/playlistItems',
      'POST www.googleapis.com/youtube/v3/playlistItems',
    ]);
    expect(calls[2]?.url.searchParams.get('part')).toBe('snippet');
    expect(calls[2]?.body).toEqual({ snippet: { playlistId: SALE, resourceId: { kind: 'youtube#video', videoId: 'dQw4w9WgXcQ' } } });
    expect(calls[3]?.body).toEqual({ snippet: { playlistId: GONE, resourceId: { kind: 'youtube#video', videoId: 'dQw4w9WgXcQ' } } });
    expect(calls[2]?.headers.get('authorization')).toBe('Bearer ya29.token-1');
  });

  it("tells a deleted playlist, a grant without the scope, another channel's playlist and a lost answer apart", async () => {
    const gone = google({ 'POST www.googleapis.com/youtube/v3/playlistItems': [notFound] });
    expect(await new YouTubePublisher(APP, gone.fetchImpl).playlist(item(GONE))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'PLAYLIST_NOT_FOUND' });
    const scope = google({ 'POST www.googleapis.com/youtube/v3/playlistItems': [{ status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } } }] });
    expect(await new YouTubePublisher(APP, scope.fetchImpl).playlist(item(SALE))).toMatchObject({ kind: 'rejected', error: 'permission', code: 'RECONNECT_FOR_PLAYLISTS' });
    const theirs = google({ 'POST www.googleapis.com/youtube/v3/playlistItems': [{ status: 403, body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'playlistItemsNotAccessible' }] } } }] });
    expect(await new YouTubePublisher(APP, theirs.fetchImpl).playlist(item(SALE))).toMatchObject({ kind: 'rejected', error: 'permission', code: 'PLAYLIST_NOT_ALLOWED' });
    const quota = google({ 'POST www.googleapis.com/youtube/v3/playlistItems': [{ status: 403, body: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } }] });
    expect(await new YouTubePublisher(APP, quota.fetchImpl).playlist(item(SALE))).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
    const lost = google({ 'POST www.googleapis.com/youtube/v3/playlistItems': [{ status: 503, body: { error: { message: 'Backend Error', errors: [{ reason: 'backendError' }] } } }] });
    expect(await new YouTubePublisher(APP, lost.fetchImpl).playlist(item(SALE))).toMatchObject({ kind: 'unknown' });
    // Nothing is sent for a video or a playlist id that is not one, or without a token.
    const none = google({});
    expect(await new YouTubePublisher(APP, none.fetchImpl).playlist({ ...item(SALE), externalId: 'not a video' })).toMatchObject({ kind: 'rejected', code: 'BAD_POST_ID' });
    expect(await new YouTubePublisher(APP, none.fetchImpl).playlist(item('UUabcdefghijklmnopqrstuv'))).toMatchObject({ kind: 'rejected', code: 'BAD_PLAYLIST_ID' });
    expect(await new YouTubePublisher(APP, none.fetchImpl).playlist({ ...item(SALE), secret: 'nope' })).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(none.calls).toEqual([]);
  });

  it("lists the channel's own playlists for the composer, page by page, and tells a dead token from an outage", async () => {
    const { fetchImpl, calls } = google({
      'GET www.googleapis.com/youtube/v3/playlists': [
        { body: { items: [{ id: SALE, snippet: { title: ' Khuyến mãi tháng 10 ' } }, { id: GONE, snippet: {} }, { id: 'not a playlist', snippet: { title: 'x' } }], nextPageToken: 'CDIQAA' } },
        { body: { items: [{ id: SALE, snippet: { title: 'again' } }] } },
      ],
    });
    expect(await new YouTubePublisher(APP, fetchImpl).playlists({ secret: SECRET })).toEqual({ playlists: [{ id: SALE, title: 'Khuyến mãi tháng 10' }, { id: GONE, title: GONE }] });
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ part: 'snippet', mine: 'true', maxResults: '50' });
    expect(Object.fromEntries(calls[1]?.url.searchParams ?? [])).toEqual({ part: 'snippet', mine: 'true', maxResults: '50', pageToken: 'CDIQAA' });
    expect(calls).toHaveLength(2);
    const dead = google({ 'GET www.googleapis.com/youtube/v3/playlists': [{ status: 401, body: { error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } } }] });
    expect(await new YouTubePublisher(APP, dead.fetchImpl).playlists({ secret: SECRET })).toEqual({ refused: 'token_expired' });
    const down = google({ 'GET www.googleapis.com/youtube/v3/playlists': [{ status: 503, body: {} }] });
    expect(await new YouTubePublisher(APP, down.fetchImpl).playlists({ secret: SECRET })).toBeNull();
  });
});

describe('YouTubePublisher options for the composer (#1030, #1131)', () => {
  const PLAYLISTS = 'GET www.googleapis.com/youtube/v3/playlists';
  const list = (fetchImpl: Fetch, over: { externalAccountId?: string; kind?: 'youtube_playlist' | 'pinterest_section'; secret?: string } = {}) =>
    new YouTubePublisher(APP, fetchImpl).options({ externalAccountId: over.externalAccountId ?? CHANNEL, secret: over.secret ?? SECRET, kind: over.kind ?? 'youtube_playlist' });
  // The nth playlist of the channel, as YouTube writes its id.
  const playlist = (n: number) => `PL${String(n).padStart(16, '0')}`;

  it("lists the channel's playlists by name, following the page token, with names cleaned", async () => {
    const { fetchImpl, calls } = google({
      [PLAYLISTS]: [
        { body: { kind: 'youtube#playlistListResponse', items: [{ id: playlist(1), snippet: { title: 'Khuyến\u200b mãi\ntháng 10' } }, { id: playlist(2), snippet: { title: '   ' } }], nextPageToken: 'CAIQAA' } },
        { body: { kind: 'youtube#playlistListResponse', items: [{ id: playlist(3), snippet: { title: 'Thực đơn <mới>' } }] } },
      ],
    });
    expect(await list(fetchImpl)).toEqual({
      options: [
        { id: playlist(1), name: 'Khuyến mãi tháng 10' },
        { id: playlist(2), name: playlist(2) },
        // YouTube's text, kept as text; the composer shows it as text.
        { id: playlist(3), name: 'Thực đơn <mới>' },
      ],
    });
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer ya29.token-1', 'Bearer ya29.token-1']);
    expect(calls[1]?.url.searchParams.get('pageToken')).toBe('CAIQAA');
  });

  it('stops at 500 playlists, ten pages of 50', async () => {
    const pages = Array.from({ length: 11 }, (_, p) => ({ body: { items: Array.from({ length: 50 }, (_, i) => ({ id: playlist(p * 50 + i), snippet: { title: `List ${p * 50 + i}` } })), nextPageToken: `page-${p + 1}` } }));
    const { fetchImpl, calls } = google({ [PLAYLISTS]: pages });
    const answer = await list(fetchImpl);
    expect(answer && 'options' in answer ? answer.options.length : 0).toBe(500);
    expect(calls).toHaveLength(10);
  });

  it('tells a dead token, a refusal, a gone channel, a spent quota and an outage apart', async () => {
    const error = (status: number, reason: string) => ({ status, body: { error: { code: status, message: reason, errors: [{ reason }] } } });
    const cases: [Answer, unknown][] = [
      [error(401, 'authError'), { refused: 'token_expired' }],
      [error(403, 'insufficientPermissions'), { refused: 'permission' }],
      [error(404, 'channelNotFound'), { refused: 'not_found' }],
      [error(403, 'quotaExceeded'), null],
      [error(429, 'rateLimitExceeded'), null],
      [{ status: 503, body: {} }, null],
      [{ body: { items: 'not a list' } }, null],
    ];
    for (const [answer, expected] of cases) expect(await list(google({ [PLAYLISTS]: [answer] }).fetchImpl)).toEqual(expected);
    // A failure on a later page keeps none of the earlier ones.
    const later = google({ [PLAYLISTS]: [{ body: { items: [{ id: playlist(1), snippet: { title: 'A' } }], nextPageToken: 'next' } }, { status: 503, body: {} }] });
    expect(await list(later.fetchImpl)).toBeNull();
  });

  it('asks nothing for a secret it cannot read, another kind of list or a malformed channel id', async () => {
    const { fetchImpl, calls } = google({});
    expect(await list(fetchImpl, { secret: '{}' })).toEqual({ refused: 'token_expired' });
    expect(await list(fetchImpl, { kind: 'pinterest_section' })).toEqual({ refused: 'not_found' });
    expect(await list(fetchImpl, { externalAccountId: 'not a channel' })).toEqual({ refused: 'not_found' });
    expect(calls).toEqual([]);
  });
});

describe('YouTube playlists picked from the list go in as pasted ones (#1131)', () => {
  it('puts the video into a listed playlist with the insert as before, and still refuses one deleted since', async () => {
    const SALE = 'PLabcdefghijklmnopqrstuvwxyz012345';
    const { fetchImpl, calls } = google({
      'GET www.googleapis.com/youtube/v3/playlists': [{ body: { items: [{ id: SALE, snippet: { title: 'Khuyến mãi' } }] } }],
      'POST www.googleapis.com/youtube/v3/playlistItems': [
        { body: { kind: 'youtube#playlistItem', id: 'UExpdGVtMQ' } },
        { status: 404, body: { error: { code: 404, message: 'Playlist not found.', errors: [{ reason: 'playlistNotFound' }] } } },
      ],
    });
    const publisher = new YouTubePublisher(APP, fetchImpl);
    const listed = await publisher.options({ externalAccountId: CHANNEL, secret: SECRET, kind: 'youtube_playlist' });
    const picked = listed && 'options' in listed ? (listed.options[0]?.id as string) : '';
    expect(picked).toBe(SALE);
    const item = { externalAccountId: CHANNEL, secret: SECRET, externalId: 'dQw4w9WgXcQ', playlistId: picked, callKey: 'call-1' };
    expect(await publisher.playlist(item)).toEqual({ kind: 'accepted', externalId: 'UExpdGVtMQ' });
    expect(calls[1]?.body).toEqual({ snippet: { playlistId: SALE, resourceId: { kind: 'youtube#video', videoId: 'dQw4w9WgXcQ' } } });
    expect(await publisher.playlist(item)).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'PLAYLIST_NOT_FOUND' });
  });
});

describe('YouTube remove (#1137)', () => {
  const VIDEO = 'dQw4w9WgXcQ';
  const DELETE = 'DELETE www.googleapis.com/youtube/v3/videos';
  const remove = (fetchImpl: Fetch, externalId = VIDEO) => new YouTubePublisher(APP, fetchImpl).remove({ externalAccountId: CHANNEL, secret: SECRET, externalId });
  const refusal = (status: number, reason: string, message: string) => ({ status, body: { error: { code: status, message, errors: [{ reason }] } } });

  it('deletes the video with the channel token (204, no body)', async () => {
    const { fetchImpl, calls } = google({ [DELETE]: [{ status: 204 }] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
    expect(calls.map((c) => [c.route, c.url.searchParams.get('id'), c.headers.get('authorization')])).toEqual([[DELETE, VIDEO, 'Bearer ya29.token-1']]);
  });

  it('counts a video YouTube no longer has as removed', async () => {
    const { fetchImpl } = google({ [DELETE]: [refusal(404, 'videoNotFound', 'The video identified by the id parameter could not be found.')] });
    expect(await remove(fetchImpl)).toEqual({ kind: 'removed' });
  });

  it('tells a grant without the force-ssl scope, a refused delete, a dead token and a spent quota apart', async () => {
    const scope = google({ [DELETE]: [refusal(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.')] });
    expect(await remove(scope.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'permission', code: 'RECONNECT_FOR_REMOVE' });
    const forbidden = google({ [DELETE]: [refusal(403, 'forbidden', 'The video cannot be deleted.')] });
    expect(await remove(forbidden.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'permission', code: 'forbidden' });
    const expired = google({ [DELETE]: [refusal(401, 'authError', 'Invalid Credentials')] });
    expect(await remove(expired.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    const quota = google({ [DELETE]: [refusal(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.')] });
    expect(await remove(quota.fetchImpl)).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: 'quotaExceeded' });
  });

  it('leaves an outage unclear, and calls nothing for a malformed id or a missing token', async () => {
    const down = google({ [DELETE]: [refusal(503, 'backendError', 'Backend Error')] });
    expect(await remove(down.fetchImpl)).toEqual({ kind: 'unknown', code: 'backendError' });
    const none = google({});
    expect(await remove(none.fetchImpl, 'not-a-video-id')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await new YouTubePublisher(APP, none.fetchImpl).remove({ externalAccountId: CHANNEL, secret: '{}', externalId: VIDEO })).toEqual({ kind: 'rejected', error: 'token_expired', code: 'NO_ACCESS_TOKEN' });
    expect(none.calls).toHaveLength(0);
  });
});
