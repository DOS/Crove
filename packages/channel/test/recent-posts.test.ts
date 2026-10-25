// Listing an account's own recent posts (#1054, #1431) against recorded answers (shapes from Meta's docs for
// /{page-id}/published_posts, /{ig-user-id}/media and /{threads-user-id}/threads, the YouTube Data API's channels.list
// and playlistItems.list, and Zalo's article/getslice); no live call.
import { describe, expect, it } from 'vitest';
import { FacebookPagePublisher, graphTime, InstagramPublisher, pagingCursor, platformLink, RECENT_POSTS_MAX, recentSince, ThreadsPublisher, YouTubePublisher, ZaloOaPublisher, type Fetch } from '../src/index.ts';

// Answers per "METHOD host/path" in order; records each call.
function routes(answers: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; query: URLSearchParams; authorization: string | null; headers: Headers }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    const headers = new Headers(init?.headers);
    calls.push({ route, query: url.searchParams, authorization: headers.get('authorization'), headers });
    const answer = answers[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, code: 1 } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

const META = { appSecret: 'test-app-secret-not-real' };
const DAY = 86_400_000;
const iso = (ago: number) => new Date(Date.now() - ago).toISOString().replace(/\.\d{3}Z$/, '+0000');

describe('recent posts helpers', () => {
  it('clamps since to 30 days back and never past now', () => {
    const now = new Date('2026-10-22T00:00:00Z');
    expect(recentSince(new Date('2026-01-01T00:00:00Z'), now).toISOString()).toBe('2026-09-22T00:00:00.000Z');
    expect(recentSince(new Date('2026-10-20T00:00:00Z'), now).toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(recentSince(new Date('2027-01-01T00:00:00Z'), now).toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(recentSince(new Date(Number.NaN), now).toISOString()).toBe('2026-09-22T00:00:00.000Z');
  });

  it('reads Graph times with or without a colon in the offset', () => {
    expect(graphTime('2026-10-20T08:00:00+0000')?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
    expect(graphTime('2026-10-20T15:00:00+07:00')?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
    expect(graphTime('yesterday')).toBeNull();
    expect(graphTime(1700000000)).toBeNull();
  });

  it('keeps a permalink only on https and the platform host', () => {
    expect(platformLink('https://www.facebook.com/111_222', ['facebook.com'])).toBe('https://www.facebook.com/111_222');
    expect(platformLink('https://facebook.com/111_222', ['facebook.com'])).toBe('https://facebook.com/111_222');
    expect(platformLink('http://www.facebook.com/111_222', ['facebook.com'])).toBeNull();
    expect(platformLink('https://evil-facebook.com/x', ['facebook.com'])).toBeNull();
    expect(platformLink('https://facebook.com.evil.example/x', ['facebook.com'])).toBeNull();
    expect(platformLink('https://user:pw@www.facebook.com/x', ['facebook.com'])).toBeNull();
    expect(platformLink('javascript:alert(1)', ['facebook.com'])).toBeNull();
    expect(platformLink(`https://www.facebook.com/${'a'.repeat(2000)}`, ['facebook.com'])).toBeNull();
    expect(platformLink(42, ['facebook.com'])).toBeNull();
  });

  it('accepts only bounded opaque cursors', () => {
    expect(pagingCursor('QVFIUmJ4ZAz1')).toBe('QVFIUmJ4ZAz1');
    expect(pagingCursor('QVFI/UmJ4+ZAz1==')).toBe('QVFI/UmJ4+ZAz1==');
    expect(pagingCursor('a&b=c')).toBeNull();
    expect(pagingCursor('a b')).toBeNull();
    expect(pagingCursor('a?b#c')).toBeNull();
    expect(pagingCursor('x'.repeat(1025))).toBeNull();
    expect(pagingCursor(undefined)).toBeNull();
  });
});

describe('FacebookPagePublisher.listRecentPosts', () => {
  const page = '111222333';
  const secret = JSON.stringify({ accessToken: 'page-token-1' });
  const path = `GET graph.facebook.com/v24.0/${page}/published_posts`;

  it('pages through the Page posts with the after cursor and stops at the first post older than since', async () => {
    const { calls, fetchImpl } = routes({
      [path]: [
        {
          body: {
            data: [
              { id: `${page}_901`, message: 'Khai trương chi nhánh mới', created_time: iso(DAY), permalink_url: `https://www.facebook.com/${page}_901` },
              { id: `${page}_900`, created_time: iso(2 * DAY), permalink_url: 'http://www.facebook.com/insecure' },
              { id: 'bad id', message: 'skipped', created_time: iso(2 * DAY) },
              { id: `${page}_899`, message: 'no date' },
            ],
            paging: { cursors: { before: 'b1', after: 'QVFIUmNext1' }, next: `https://graph.facebook.com/v24.0/${page}/published_posts?after=QVFIUmNext1` },
          },
        },
        {
          body: {
            data: [
              { id: `${page}_898`, message: 'Tuần trước', created_time: iso(5 * DAY), permalink_url: `https://www.facebook.com/${page}_898` },
              { id: `${page}_700`, message: 'Quá cũ', created_time: iso(40 * DAY), permalink_url: `https://www.facebook.com/${page}_700` },
            ],
            paging: { cursors: { before: 'b2', after: 'QVFIUmNext2' }, next: `https://graph.facebook.com/v24.0/${page}/published_posts?after=QVFIUmNext2` },
          },
        },
      ],
    });
    const result = await new FacebookPagePublisher(META, fetchImpl).listRecentPosts({ externalAccountId: page, secret, since: new Date(Date.now() - 90 * DAY) });
    expect(result && 'posts' in result ? result.posts.map((p) => [p.externalId, p.text, p.permalink]) : result).toEqual([
      [`${page}_901`, 'Khai trương chi nhánh mới', `https://www.facebook.com/${page}_901`],
      [`${page}_900`, '', null],
      [`${page}_898`, 'Tuần trước', `https://www.facebook.com/${page}_898`],
    ]);
    // Two pages, then the post older than 30 days ended the listing.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.authorization).toBe('Bearer page-token-1');
    expect(calls[0]?.query.get('fields')).toBe('id,message,created_time,permalink_url');
    expect(calls[0]?.query.get('after')).toBeNull();
    expect(calls[1]?.query.get('after')).toBe('QVFIUmNext1');
    // since is clamped to 30 days back whatever the caller asked.
    const since = Number(calls[0]?.query.get('since')) * 1000;
    expect(Math.abs(since - (Date.now() - 30 * DAY))).toBeLessThan(60_000);
    // The token never travels in the address.
    expect(calls.every((c) => !c.query.has('access_token'))).toBe(true);
  });

  it('stops without a next page and at the post cap', async () => {
    const one = routes({ [path]: [{ body: { data: [{ id: `${page}_1`, message: 'a', created_time: iso(DAY) }], paging: { cursors: { after: 'c1' } } } }] });
    const result = await new FacebookPagePublisher(META, one.fetchImpl).listRecentPosts({ externalAccountId: page, secret, since: new Date(0) });
    expect(result && 'posts' in result ? result.posts.length : result).toBe(1);
    expect(one.calls).toHaveLength(1);
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `${page}_${1000 + i}`, message: 'x', created_time: iso(DAY) }));
    const full = routes({ [path]: Array.from({ length: 10 }, (_, i) => ({ body: { data: many, paging: { cursors: { after: `c${i}` }, next: 'more' } } })) });
    const capped = await new FacebookPagePublisher(META, full.fetchImpl).listRecentPosts({ externalAccountId: page, secret, since: new Date(0) });
    expect(capped && 'posts' in capped ? capped.posts.length : capped).toBe(RECENT_POSTS_MAX);
    expect(full.calls).toHaveLength(5);
  });

  it('says when the token or permission is refused, has no answer on a failure, and keeps what came before a later failure', async () => {
    const refused = routes({
      [path]: [
        { status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190, error_subcode: 463 } } },
        { status: 403, body: { error: { message: 'Requires pages_read_engagement', code: 10 } } },
        { status: 500, body: { error: { message: 'An unknown error occurred', code: 1 } } },
      ],
    });
    const fb = new FacebookPagePublisher(META, refused.fetchImpl);
    const input = { externalAccountId: page, secret, since: new Date(0) };
    expect(await fb.listRecentPosts(input)).toEqual({ refused: 'token_expired' });
    expect(await fb.listRecentPosts(input)).toEqual({ refused: 'permission' });
    expect(await fb.listRecentPosts(input)).toBeNull();
    expect(await fb.listRecentPosts({ ...input, secret: '{}' })).toEqual({ refused: 'token_expired' });
    expect(await fb.listRecentPosts({ ...input, externalAccountId: '../me' })).toBeNull();
    const later = routes({
      [path]: [{ body: { data: [{ id: `${page}_5`, message: 'kept', created_time: iso(DAY) }], paging: { cursors: { after: 'c1' }, next: 'more' } } }, { status: 500, body: {} }],
    });
    const partial = await new FacebookPagePublisher(META, later.fetchImpl).listRecentPosts(input);
    expect(partial && 'posts' in partial ? partial.posts.map((p) => p.externalId) : partial).toEqual([`${page}_5`]);
  });
});

describe('InstagramPublisher.listRecentPosts', () => {
  const ig = '17841400000000001';
  const secret = JSON.stringify({ accessToken: 'page-token-1', pageId: '111' });
  const path = `GET graph.facebook.com/v24.0/${ig}/media`;

  it("lists the account's media with captions and permalinks, paged, newest first", async () => {
    const { calls, fetchImpl } = routes({
      [path]: [
        {
          body: {
            data: [
              { id: '18000000000000101', caption: 'Bộ sưu tập thu đông', timestamp: iso(DAY), permalink: 'https://www.instagram.com/p/AbC123/' },
              { id: '18000000000000100', timestamp: iso(3 * DAY), permalink: 'https://www.instagram.com.evil.example/p/x/' },
            ],
            paging: { cursors: { before: 'b', after: 'QVFIUig1' }, next: 'more' },
          },
        },
        { body: { data: [{ id: '18000000000000099', caption: 'Reel', timestamp: iso(6 * DAY), permalink: 'https://www.instagram.com/reel/XyZ/' }], paging: { cursors: { before: 'b2' } } } },
      ],
    });
    const result = await new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 }).listRecentPosts({ externalAccountId: ig, secret, since: new Date(Date.now() - 10 * DAY) });
    expect(result && 'posts' in result ? result.posts.map((p) => [p.externalId, p.text, p.permalink]) : result).toEqual([
      ['18000000000000101', 'Bộ sưu tập thu đông', 'https://www.instagram.com/p/AbC123/'],
      ['18000000000000100', '', null],
      ['18000000000000099', 'Reel', 'https://www.instagram.com/reel/XyZ/'],
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query.get('fields')).toBe('id,caption,timestamp,permalink');
    expect(calls[1]?.query.get('after')).toBe('QVFIUig1');
    expect(calls[0]?.authorization).toBe('Bearer page-token-1');
    // since as the caller asked, within 30 days.
    expect(Math.abs(Number(calls[0]?.query.get('since')) * 1000 - (Date.now() - 10 * DAY))).toBeLessThan(60_000);
  });

  it('refuses on an expired token or missing permission and has no answer on a failure', async () => {
    const { fetchImpl } = routes({
      [path]: [
        { status: 400, body: { error: { message: 'Session has expired', type: 'OAuthException', code: 190 } } },
        { status: 400, body: { error: { message: 'Application does not have permission', code: 10 } } },
        { status: 503, body: {} },
      ],
    });
    const publisher = new InstagramPublisher(META, fetchImpl, { waitMs: 0, pollMs: 0 });
    const input = { externalAccountId: ig, secret, since: new Date(0) };
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'token_expired' });
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'permission' });
    expect(await publisher.listRecentPosts(input)).toBeNull();
    expect(await publisher.listRecentPosts({ ...input, secret: JSON.stringify({ accessToken: 'x' }) })).toEqual({ refused: 'token_expired' });
  });
});

describe('ThreadsPublisher.listRecentPosts', () => {
  const user = '17841400000000777';
  const secret = JSON.stringify({ accessToken: 'threads-token-1' });
  const path = `GET graph.threads.net/v1.0/${user}/threads`;

  it("lists the profile's own posts with text and permalink, without reposts or replies, and stops at an older post", async () => {
    const { calls, fetchImpl } = routes({
      [path]: [
        {
          body: {
            data: [
              { id: '18100000000000010', media_type: 'TEXT_POST', text: 'Khai trương chi nhánh mới', timestamp: iso(DAY), permalink: 'https://www.threads.com/@quan.a/post/AbC1', is_reply: false },
              { id: '18100000000000009', media_type: 'REPOST_FACADE', timestamp: iso(DAY), permalink: 'https://www.threads.com/@other/post/XyZ' },
              { id: '18100000000000008', media_type: 'TEXT_POST', text: 'Cảm ơn bạn!', timestamp: iso(2 * DAY), is_reply: true },
              { id: '18100000000000007', media_type: 'IMAGE', timestamp: iso(3 * DAY), permalink: 'https://www.threads.net/@quan.a/post/AbC0' },
              { id: '18100000000000006', media_type: 'TEXT_POST', text: 'Trích dẫn', timestamp: iso(4 * DAY), permalink: 'https://threads.com.evil.example/p' },
              { id: 'not-a-number', media_type: 'TEXT_POST', text: 'bad id', timestamp: iso(4 * DAY) },
              { id: '18100000000000005', media_type: 'TEXT_POST', text: 'Quá cũ', timestamp: iso(40 * DAY) },
            ],
            paging: { cursors: { before: 'b', after: 'QVFIUnext' }, next: 'https://graph.threads.net/v1.0/next' },
          },
        },
      ],
    });
    const result = await new ThreadsPublisher(fetchImpl).listRecentPosts({ externalAccountId: user, secret, since: new Date(Date.now() - 90 * DAY) });
    expect(result && 'posts' in result ? result.posts.map((p) => [p.externalId, p.text, p.permalink]) : result).toEqual([
      ['18100000000000010', 'Khai trương chi nhánh mới', 'https://www.threads.com/@quan.a/post/AbC1'],
      ['18100000000000007', '', 'https://www.threads.net/@quan.a/post/AbC0'],
      ['18100000000000006', 'Trích dẫn', null],
    ]);
    const first = result && 'posts' in result ? result.posts[0] : undefined;
    expect(Math.abs((first?.publishedAt.getTime() ?? 0) - (Date.now() - DAY))).toBeLessThan(5000);
    // The post older than 30 days ended the listing.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe('Bearer threads-token-1');
    expect(calls[0]?.query.get('fields')).toBe('id,text,permalink,timestamp,media_type,is_reply');
    expect(calls[0]?.query.get('limit')).toBe('100');
    expect(Math.abs(Number(calls[0]?.query.get('since')) * 1000 - (Date.now() - 30 * DAY))).toBeLessThan(60_000);
    expect(calls.every((c) => !c.query.has('access_token'))).toBe(true);
  });

  it('reads on after a full page with a cursor, and stops on a short page or at the post cap', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: String(18100000000001000 + i), media_type: 'TEXT_POST', text: 'x', timestamp: iso(DAY) }));
    const { calls, fetchImpl } = routes({
      [path]: [{ body: { data: full, paging: { cursors: { after: 'QVFIUig1' } } } }, { body: { data: [{ id: '18100000000000001', text: 'cuối', timestamp: iso(2 * DAY) }], paging: { cursors: { after: 'QVFIUig2' } } } }],
    });
    const result = await new ThreadsPublisher(fetchImpl).listRecentPosts({ externalAccountId: user, secret, since: new Date(0) });
    expect(result && 'posts' in result ? result.posts.length : result).toBe(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.query.get('after')).toBe('QVFIUig1');
    const many = routes({ [path]: Array.from({ length: 10 }, (_, i) => ({ body: { data: full, paging: { cursors: { after: `c${i}` }, next: 'more' } } })) });
    const capped = await new ThreadsPublisher(many.fetchImpl).listRecentPosts({ externalAccountId: user, secret, since: new Date(0) });
    expect(capped && 'posts' in capped ? capped.posts.length : capped).toBe(RECENT_POSTS_MAX);
    expect(many.calls).toHaveLength(5);
  });

  it('marks an expired token, says a missing permission, has no answer on a failure, and keeps what came before a later failure', async () => {
    const { fetchImpl } = routes({
      [path]: [
        { status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } },
        { status: 403, body: { error: { message: 'Requires threads_basic', code: 10 } } },
        { status: 500, body: { error: { message: 'An unknown error occurred', code: 1 } } },
      ],
    });
    const publisher = new ThreadsPublisher(fetchImpl);
    const input = { externalAccountId: user, secret, since: new Date(0) };
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'token_expired' });
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'permission' });
    expect(await publisher.listRecentPosts(input)).toBeNull();
    expect(await publisher.listRecentPosts({ ...input, secret: '{}' })).toEqual({ refused: 'token_expired' });
    expect(await publisher.listRecentPosts({ ...input, externalAccountId: '../me' })).toBeNull();
    const full = Array.from({ length: 100 }, (_, i) => ({ id: String(18100000000002000 + i), text: 'x', timestamp: iso(DAY) }));
    const later = routes({ [path]: [{ body: { data: full, paging: { cursors: { after: 'c1' }, next: 'more' } } }, { status: 500, body: {} }] });
    const partial = await new ThreadsPublisher(later.fetchImpl).listRecentPosts(input);
    expect(partial && 'posts' in partial ? partial.posts.length : partial).toBe(100);
  });
});

describe('YouTubePublisher.listRecentPosts', () => {
  const app = { clientId: '123456789012-abcdefgh12345678.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
  const channel = 'UCabcdefghijklmnopqrstuv';
  const uploads = 'UUabcdefghijklmnopqrstuv';
  const secret = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
  const channels = 'GET www.googleapis.com/youtube/v3/channels';
  const items = 'GET www.googleapis.com/youtube/v3/playlistItems';
  const isoZ = (ago: number) => new Date(Date.now() - ago).toISOString();
  const item = (videoId: string, title: string, ago: number, extra: Record<string, unknown> = {}) => ({
    snippet: { title, description: '', publishedAt: isoZ(ago), resourceId: { kind: 'youtube#video', videoId } },
    contentDetails: { videoId, videoPublishedAt: isoZ(ago) },
    status: { privacyStatus: 'public' },
    ...extra,
  });
  const mine = { body: { items: [{ id: channel, contentDetails: { relatedPlaylists: { uploads } } }] } };

  it("lists the channel's uploads, Shorts too, newest first, paged, without private videos, and stops at an older upload", async () => {
    const { calls, fetchImpl } = routes({
      [channels]: [mine],
      [items]: [
        {
          body: {
            items: [
              item('aaaaaaaaaa1', 'Khai trương chi nhánh', DAY, { snippet: { title: 'Khai trương chi nhánh', description: 'Mời bạn ghé thăm', publishedAt: isoZ(DAY), resourceId: { videoId: 'aaaaaaaaaa1' } } }),
              item('bbbbbbbbbb2', 'Hậu trường #shorts', 2 * DAY),
              item('cccccccccc3', 'Chưa công khai', 3 * DAY, { status: { privacyStatus: 'private' } }),
              item('bad', 'Bad id', 3 * DAY),
            ],
            nextPageToken: 'CAUQAA',
          },
        },
        {
          body: {
            items: [
              item('dddddddddd4', 'Tuần trước', 6 * DAY),
              item('eeeeeeeeee5', 'Quá cũ', 40 * DAY),
              // Uploaded private 50 days ago and made public 5 days ago: counted from its publish time.
              item('ffffffffff6', 'Ra mắt muộn', 50 * DAY, { contentDetails: { videoId: 'ffffffffff6', videoPublishedAt: isoZ(5 * DAY) } }),
              // Past the grace: the listing ends here.
              item('gggggggggg7', 'Rất cũ', 130 * DAY),
            ],
            nextPageToken: 'CAoQAA',
          },
        },
      ],
    });
    const result = await new YouTubePublisher(app, fetchImpl).listRecentPosts({ externalAccountId: channel, secret, since: new Date(Date.now() - 90 * DAY) });
    expect(result && 'posts' in result ? result.posts.map((p) => [p.externalId, p.text, p.permalink]) : result).toEqual([
      ['aaaaaaaaaa1', 'Khai trương chi nhánh\n\nMời bạn ghé thăm', 'https://www.youtube.com/watch?v=aaaaaaaaaa1'],
      ['bbbbbbbbbb2', 'Hậu trường #shorts', 'https://www.youtube.com/watch?v=bbbbbbbbbb2'],
      ['dddddddddd4', 'Tuần trước', 'https://www.youtube.com/watch?v=dddddddddd4'],
      ['ffffffffff6', 'Ra mắt muộn', 'https://www.youtube.com/watch?v=ffffffffff6'],
    ]);
    const first = result && 'posts' in result ? result.posts[0] : undefined;
    expect(Math.abs((first?.publishedAt.getTime() ?? 0) - (Date.now() - DAY))).toBeLessThan(5000);
    // One unit for the channel, one per page; an upload older than the window plus its grace ended the listing.
    expect(calls.map((c) => c.route)).toEqual([channels, items, items]);
    expect(calls[0]?.query.get('part')).toBe('contentDetails');
    expect(calls[0]?.query.get('mine')).toBe('true');
    expect(calls[1]?.query.get('playlistId')).toBe(uploads);
    expect(calls[1]?.query.get('maxResults')).toBe('50');
    expect(calls[1]?.query.get('part')).toBe('snippet,contentDetails,status');
    expect(calls[1]?.query.get('pageToken')).toBeNull();
    expect(calls[2]?.query.get('pageToken')).toBe('CAUQAA');
    expect(calls.every((c) => c.authorization === 'Bearer ya29.token-1')).toBe(true);
  });

  it('marks an expired token, waits out a spent quota, says a missing permission, and keeps what came before a later failure', async () => {
    const quota = { status: 403, body: { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } };
    const expired = { status: 401, body: { error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } } };
    const { fetchImpl } = routes({
      [channels]: [
        expired,
        quota,
        { status: 403, body: { error: { message: 'forbidden', errors: [{ reason: 'forbidden' }] } } },
        { body: { items: [{ id: 'UCzzzzzzzzzzzzzzzzzzzzzz', contentDetails: { relatedPlaylists: { uploads: 'UUzzzzzzzzzzzzzzzzzzzzzz' } } }] } },
        mine,
      ],
      [items]: [expired],
    });
    const publisher = new YouTubePublisher(app, fetchImpl);
    const input = { externalAccountId: channel, secret, since: new Date(0) };
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'token_expired' });
    expect(await publisher.listRecentPosts(input)).toBeNull();
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'permission' });
    // Another channel than the connection's: nothing listed.
    expect(await publisher.listRecentPosts(input)).toBeNull();
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'token_expired' });
    expect(await publisher.listRecentPosts({ ...input, secret: '{}' })).toEqual({ refused: 'token_expired' });
    expect(await publisher.listRecentPosts({ ...input, externalAccountId: 'UC../x' })).toBeNull();
    const later = routes({ [channels]: [mine], [items]: [{ body: { items: [item('ffffffffff6', 'Giữ lại', DAY)], nextPageToken: 'CAUQAA' } }, quota] });
    const partial = await new YouTubePublisher(app, later.fetchImpl).listRecentPosts(input);
    expect(partial && 'posts' in partial ? partial.posts.map((p) => p.externalId) : partial).toEqual(['ffffffffff6']);
  });
});

describe('ZaloOaPublisher.listRecentPosts', () => {
  const app = { appId: '4318000000000000001', appSecret: 'test-zalo-secret-not-real' };
  const secret = JSON.stringify({ accessToken: 'zalo-access-1', refreshToken: 'zalo-refresh-1' });
  const slice = 'GET openapi.zalo.me/v2.0/article/getslice';
  const ok = (medias: unknown[], total = medias.length) => ({ body: { error: 0, message: 'Success', data: { medias, total } } });
  const article = (id: string, title: string, ago: number, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'normal',
    title,
    status: 'show',
    total_view: 1,
    total_share: 0,
    create_date: Date.now() - ago,
    update_date: Date.now() - ago,
    ...extra,
  });

  it('lists normal and video articles by creation time, newest first, paged by offset, without hidden ones', async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => article(`a${String(i).padStart(19, '0')}`, `Bài ${i}`, DAY + i * 60_000));
    page1[1] = article('39c07ccbe78e0ed0579f', 'Ưu đãi cuối tuần', DAY + 60_000, { link_view: 'https://oa.zalo.me/article/39c07ccbe78e0ed0579f' });
    page1[2] = article('39c07ccbe78e0ed05700', 'Bản nháp ẩn', DAY + 120_000, { status: 'hide' });
    page1[3] = article('39c07ccbe78e0ed05701', 'Liên kết lạ', DAY + 180_000, { link_view: 'https://zalo.me.evil.example/a' });
    const { calls, fetchImpl } = routes({
      [slice]: [
        ok(page1, 23),
        ok([article('b0000000000000000001', 'Tuần trước', 6 * DAY), article('b0000000000000000002', 'Không ngày', DAY, { create_date: 'hôm qua' }), article('b0000000000000000003', 'Quá cũ', 40 * DAY)], 23),
        ok([article('16ec49edd2a83bf662b', 'Video khai trương', 2 * DAY, { type: 'video', create_date: String(Date.now() - 2 * DAY) }), article('16ec49edd2a83bf6600', 'Video cũ', 50 * DAY, { type: 'video' })]),
      ],
    });
    const result = await new ZaloOaPublisher(app, fetchImpl).listRecentPosts({ externalAccountId: '1234567890', secret, since: new Date(Date.now() - 90 * DAY) });
    const posts = result && 'posts' in result ? result.posts : [];
    // 19 shown articles of the first page, one of the second, one video.
    expect(posts).toHaveLength(21);
    expect(posts.map((p) => p.externalId)).not.toContain('39c07ccbe78e0ed05700');
    expect(posts.find((p) => p.externalId === '39c07ccbe78e0ed0579f')).toMatchObject({ text: 'Ưu đãi cuối tuần', permalink: 'https://oa.zalo.me/article/39c07ccbe78e0ed0579f' });
    expect(posts.find((p) => p.externalId === '39c07ccbe78e0ed05701')?.permalink).toBeNull();
    expect(posts.slice(-2).map((p) => [p.externalId, p.text])).toEqual([
      ['16ec49edd2a83bf662b', 'Video khai trương'],
      ['b0000000000000000001', 'Tuần trước'],
    ]);
    expect(posts.every((p, i) => i === 0 || (posts[i - 1] as { publishedAt: Date }).publishedAt >= p.publishedAt)).toBe(true);
    expect(calls.map((c) => [c.query.get('type'), c.query.get('offset'), c.query.get('limit')])).toEqual([
      ['normal', '0', '20'],
      ['normal', '20', '20'],
      ['video', '0', '20'],
    ]);
    expect(calls.every((c) => c.headers.get('access_token') === 'zalo-access-1' && !c.query.has('access_token'))).toBe(true);
  });

  it('ends a slice at a page with nothing recent, whatever the total says', async () => {
    const old = Array.from({ length: 20 }, (_, i) => article(`c${String(i).padStart(19, '0')}`, 'Cũ', 40 * DAY + i));
    const { calls, fetchImpl } = routes({ [slice]: [ok(old, 500), ok([], 0)] });
    expect(await new ZaloOaPublisher(app, fetchImpl).listRecentPosts({ externalAccountId: '1', secret, since: new Date(0) })).toEqual({ posts: [] });
    expect(calls).toHaveLength(2);
  });

  it('marks an expired token, has no answer on a failure, and keeps the articles when the video slice fails', async () => {
    const { fetchImpl } = routes({
      [slice]: [
        { body: { error: -216, message: 'Access token is invalid' } },
        { status: 500, body: { error: -1, message: 'internal' } },
        ok([article('d0000000000000000001', 'Giữ lại', DAY)]),
        { status: 500, body: {} },
        ok([]),
        { body: { error: -124, message: 'Access token has expired' } },
      ],
    });
    const publisher = new ZaloOaPublisher(app, fetchImpl);
    const input = { externalAccountId: '1', secret, since: new Date(0) };
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'token_expired' });
    expect(await publisher.listRecentPosts(input)).toBeNull();
    const partial = await publisher.listRecentPosts(input);
    expect(partial && 'posts' in partial ? partial.posts.map((p) => p.externalId) : partial).toEqual(['d0000000000000000001']);
    expect(await publisher.listRecentPosts(input)).toEqual({ refused: 'token_expired' });
    expect(await publisher.listRecentPosts({ ...input, secret: '{}' })).toEqual({ refused: 'token_expired' });
  });
});
