// The Facebook Page publisher against recorded Graph answers (shapes from Meta's docs); no live call.
import { describe, expect, it } from 'vitest';
import { FacebookPagePublisher, type Fetch, type PublishInput, type ReconcileInput } from '../src/index.ts';

const APP = { appSecret: 'test-app-secret-not-real' };
const PAGE = '111222333';
const SECRET = JSON.stringify({ accessToken: 'page-token-1' });

interface Call {
  url: URL;
  method: string;
  form: URLSearchParams;
  authorization: string | null;
}

function fake(answer: { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    calls.push({
      url: new URL(input),
      method: init?.method ?? 'GET',
      form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, publisher: new FacebookPagePublisher(APP, fetchImpl) };
}

const input = (over: Partial<PublishInput> = {}): PublishInput => ({
  externalAccountId: PAGE,
  secret: SECRET,
  content: { body: '  Khai trương chi nhánh mới!  ', title: null, linkUrl: 'https://example.com/khai-truong' },
  settings: {},
  callKey: 'call-1',
  contentHash: `sha256:${'0'.repeat(64)}`,
  ...over,
});

const graphError = (status: number, code: number, message = 'Graph refused') => ({ status, body: { error: { message, type: 'OAuthException', code } } });

describe('FacebookPagePublisher.publish', () => {
  it('posts the message and link to the Page feed with the Page token', async () => {
    const { calls, publisher } = fake({ body: { id: `${PAGE}_987654321` } });
    expect(publisher.publishSafety).toBe('reconcile_only');
    expect(await publisher.publish(input())).toEqual({ kind: 'accepted', externalId: `${PAGE}_987654321`, url: `https://www.facebook.com/${PAGE}_987654321` });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/v24.0/${PAGE}/feed`);
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({ message: 'Khai trương chi nhánh mới!', link: 'https://example.com/khai-truong' });
    expect(calls[0]?.authorization).toBe('Bearer page-token-1');
    expect(calls[0]?.url.toString()).not.toContain('page-token-1');
  });

  it('maps Graph refusals to what the pipeline needs', async () => {
    const cases: [ReturnType<typeof graphError>, string][] = [
      [graphError(400, 190, 'Error validating access token'), 'token_expired'],
      [graphError(401, 2500, 'An active access token must be used'), 'token_expired'],
      [graphError(400, 200, 'Requires pages_manage_posts permission'), 'permission'],
      [graphError(403, 10), 'permission'],
      [graphError(400, 32, 'Page request limit reached'), 'rate_limited'],
      [graphError(400, 100, 'Invalid parameter'), 'bad_request'],
    ];
    for (const [answer, error] of cases) {
      const result = await fake(answer).publisher.publish(input());
      expect(result).toMatchObject({ kind: 'rejected', error, code: String(answer.body.error.code), httpStatus: answer.status });
    }
  });

  it('answers unknown when Meta may have posted: a 5xx, its unknown error, a duplicate, no id, a network failure', async () => {
    for (const answer of [graphError(500, 2, 'Service temporarily unavailable'), graphError(400, 1, 'An unknown error occurred'), graphError(400, 506, 'Duplicate status message'), { body: {} }, new TypeError('fetch failed')]) {
      expect((await fake(answer).publisher.publish(input())).kind).toBe('unknown');
    }
  });

  it('refuses locally without calling Meta: no Page token, a malformed Page id, an empty post', async () => {
    const { calls, publisher } = fake({ body: { id: 'x' } });
    expect(await publisher.publish(input({ secret: '{}' }))).toMatchObject({ kind: 'rejected', error: 'token_expired' });
    expect(await publisher.publish(input({ externalAccountId: '../me' }))).toMatchObject({ kind: 'rejected', error: 'bad_request' });
    expect(await publisher.publish(input({ content: { body: ' ', title: null, linkUrl: null } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' });
    expect(calls).toHaveLength(0);
  });
});

describe('FacebookPagePublisher.reconcile', () => {
  const window: ReconcileInput = {
    externalAccountId: PAGE,
    secret: SECRET,
    callKey: 'call-1',
    contentHash: `sha256:${'0'.repeat(64)}`,
    content: { body: 'Khai trương chi nhánh mới!', title: null, linkUrl: null },
    after: new Date('2026-10-18T02:00:00Z'),
    before: new Date('2026-10-18T02:10:00Z'),
  };

  it('finds the post by its message in the window', async () => {
    const { calls, publisher } = fake({
      body: {
        data: [
          { id: `${PAGE}_1`, message: 'Bài khác', created_time: '2026-10-18T02:03:00+0000' },
          { id: `${PAGE}_2`, message: 'Khai trương chi nhánh mới!', created_time: '2026-10-18T02:04:00+0000', permalink_url: `https://www.facebook.com/${PAGE}/posts/2` },
        ],
      },
    });
    expect(await publisher.reconcile(window)).toEqual({ found: true, externalId: `${PAGE}_2`, url: `https://www.facebook.com/${PAGE}/posts/2` });
    const asked = calls[0]?.url;
    expect(asked?.pathname).toBe(`/v24.0/${PAGE}/posts`);
    expect(asked?.searchParams.get('since')).toBe(String(Date.parse('2026-10-18T02:00:00Z') / 1000 - 60));
    expect(asked?.searchParams.get('until')).toBe(String(Date.parse('2026-10-18T02:10:00Z') / 1000 + 60));
  });

  it('answers missing when no post matches, and unknown when Meta cannot be asked or there is no message', async () => {
    expect(await fake({ body: { data: [] } }).publisher.reconcile(window)).toEqual({ found: false });
    expect(await fake(graphError(500, 2)).publisher.reconcile(window)).toEqual({ found: 'unknown' });
    const { calls, publisher } = fake({ body: { data: [] } });
    expect(await publisher.reconcile({ ...window, content: { body: '', title: null, linkUrl: 'https://example.com' } })).toEqual({ found: 'unknown' });
    expect(calls).toHaveLength(0);
  });
});
