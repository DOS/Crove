// Listing an account's own recent posts (#1054) against recorded Graph API answers (shapes from Meta's docs for
// /{page-id}/published_posts and /{ig-user-id}/media); no live call.
import { describe, expect, it } from 'vitest';
import { FacebookPagePublisher, graphTime, InstagramPublisher, pagingCursor, platformLink, RECENT_POSTS_MAX, recentSince, type Fetch } from '../src/index.ts';

// Answers per "METHOD host/path" in order; records each call.
function routes(answers: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; query: URLSearchParams; authorization: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    calls.push({ route, query: url.searchParams, authorization: new Headers(init?.headers).get('authorization') });
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
    expect(pagingCursor('a&b=c')).toBeNull();
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
