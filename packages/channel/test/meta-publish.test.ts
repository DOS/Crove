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
  content: { body: '  Khai trương chi nhánh mới!  ', title: null, linkUrl: 'https://example.com/khai-truong', media: [] },
  readMedia: async () => {
    throw new Error('no media in this test');
  },
  mediaUrl: async () => null,
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

  it('uploads a video to the Page through the video host, with the text and link as its description', async () => {
    const bodies: FormData[] = [];
    const urls: URL[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      urls.push(new URL(url));
      if (init?.body instanceof FormData) bodies.push(init.body);
      return new Response(JSON.stringify({ id: '555666777' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const publisher = new FacebookPagePublisher(APP, fetchImpl);
    expect(publisher.callTimeoutMs).toBeGreaterThan(300_000);
    expect(publisher.callTimeoutMs).toBeLessThan(600_000);
    const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 4, altText: null };
    const result = await publisher.publish(input({ content: { ...input().content, media: [clip] }, readMedia: async () => new Uint8Array([0, 0, 0, 1]) }));
    expect(result).toEqual({ kind: 'accepted', externalId: `${PAGE}_555666777`, url: `https://www.facebook.com/${PAGE}/videos/555666777` });
    expect(urls.map((u) => `${u.host}${u.pathname}`)).toEqual([`graph-video.facebook.com/v24.0/${PAGE}/videos`]);
    const sent = bodies[0] ?? new FormData();
    expect(sent.get('description')).toBe('Khai trương chi nhánh mới!\n\nhttps://example.com/khai-truong');
    expect(sent.get('published')).toBe('true');
    expect((sent.get('source') as Blob).type).toBe('video/mp4');
  });

  it('treats an unclear video upload as unknown, a refused one as rejected, and an unreadable file as nothing sent', async () => {
    const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 4, altText: null };
    const withClip = (over: Partial<PublishInput> = {}) => input({ content: { ...input().content, media: [clip] }, readMedia: async () => new Uint8Array([1]), ...over });
    expect((await fake({ status: 500, body: { error: { message: 'Service unavailable', code: 2 } } }).publisher.publish(withClip())).kind).toBe('unknown');
    expect((await fake(new TypeError('fetch failed')).publisher.publish(withClip())).kind).toBe('unknown');
    expect(await fake(graphError(400, 100, 'Invalid video')).publisher.publish(withClip())).toMatchObject({ kind: 'rejected', error: 'bad_request' });
    const none = fake({ body: {} });
    expect(
      await none.publisher.publish(
        withClip({
          readMedia: async () => {
            throw new Error('gone');
          },
        }),
      ),
    ).toMatchObject({ kind: 'rejected', code: 'MEDIA_UNREADABLE' });
    expect(await none.publisher.publish(withClip({ content: { ...input().content, media: [clip, clip] } }))).toMatchObject({ kind: 'rejected', code: 'ONE_VIDEO_REQUIRED' });
    expect(none.calls).toHaveLength(0);
  });

  it('refuses a video cover, which Crove does not send to a Page, with nothing posted (#642)', async () => {
    const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 4, altText: null };
    const none = fake({ body: { id: '555666777' } });
    for (const cover of [{ atMs: 1000 }, { fileId: 'c-1' }]) {
      const withCover = input({ content: { ...input().content, media: [clip] }, readMedia: async () => new Uint8Array([1]), settings: { cover } });
      expect(await none.publisher.publish(withCover)).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'COVER_NOT_SUPPORTED' });
    }
    expect(none.calls).toHaveLength(0);
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
    expect(await publisher.publish(input({ content: { body: ' ', title: null, linkUrl: null, media: [] } }))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'EMPTY_POST' });
    expect(calls).toHaveLength(0);
  });
});

describe('FacebookPagePublisher.reconcile', () => {
  const window: ReconcileInput = {
    externalAccountId: PAGE,
    secret: SECRET,
    callKey: 'call-1',
    contentHash: `sha256:${'0'.repeat(64)}`,
    content: { body: 'Khai trương chi nhánh mới!', title: null, linkUrl: null, media: [] },
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
    expect(await publisher.reconcile({ ...window, content: { body: '', title: null, linkUrl: 'https://example.com', media: [] } })).toEqual({ found: 'unknown' });
    expect(calls).toHaveLength(0);
  });
});

describe('FacebookPagePublisher with images', () => {
  // Answers in order; records what was asked, with multipart fields.
  function sequence(answers: { status?: number; body: unknown }[]) {
    const calls: { path: string; form: URLSearchParams; multipart: FormData | null }[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      calls.push({
        path: new URL(input).pathname,
        form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
        multipart: init?.body instanceof FormData ? init.body : null,
      });
      const answer = answers.shift() ?? { status: 500, body: { error: { message: 'no more answers', code: 1 } } };
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, publisher: new FacebookPagePublisher(APP, fetchImpl) };
  }
  const media = [
    { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 3, altText: null },
    { fileId: 'f-2', mime: 'image/png', sizeBytes: 3, altText: 'Mặt tiền' },
  ];
  const withMedia = (readMedia: PublishInput['readMedia']) => input({ content: { body: 'Ảnh khai trương', title: null, linkUrl: 'https://example.com/a', media }, readMedia });

  it('uploads each image unpublished, then posts once with the photos attached and the link in the text', async () => {
    const { calls, publisher } = sequence([{ body: { id: 'photo-1' } }, { body: { id: 'photo-2' } }, { body: { id: `${PAGE}_7` } }]);
    const read: string[] = [];
    const result = await publisher.publish(withMedia(async (fileId) => (read.push(fileId), new Uint8Array([1, 2, 3]))));
    expect(result).toEqual({ kind: 'accepted', externalId: `${PAGE}_7`, url: `https://www.facebook.com/${PAGE}_7` });
    expect(read).toEqual(['f-1', 'f-2']);
    expect(calls.map((c) => c.path)).toEqual([`/v24.0/${PAGE}/photos`, `/v24.0/${PAGE}/photos`, `/v24.0/${PAGE}/feed`]);
    expect(calls[0]?.multipart?.get('published')).toBe('false');
    const source = calls[1]?.multipart?.get('source');
    expect(source instanceof Blob ? source.type : null).toBe('image/png');
    expect(Object.fromEntries(calls[2]?.form ?? [])).toEqual({
      message: 'Ảnh khai trương\n\nhttps://example.com/a',
      attached_media: JSON.stringify([{ media_fbid: 'photo-1' }, { media_fbid: 'photo-2' }]),
    });
  });

  it('gives each described photo its alt text, cut to 1000 characters, and leaves the others to Facebook (#790)', async () => {
    const { calls, publisher } = sequence([{ body: { id: 'photo-1' } }, { body: { id: 'photo-2' } }, { body: { id: `${PAGE}_7` } }]);
    const described = [
      { ...(media[0] as PublishInput['content']['media'][number]), altText: `Bánh mới ${'b'.repeat(1200)}` },
      { ...(media[1] as PublishInput['content']['media'][number]), altText: null },
    ];
    await publisher.publish(input({ content: { body: 'Ảnh', title: null, linkUrl: null, media: described }, readMedia: async () => new Uint8Array([1]) }));
    expect(String(calls[0]?.multipart?.get('alt_text_custom'))).toHaveLength(1000);
    expect(calls[1]?.multipart?.has('alt_text_custom')).toBe(false);
  });

  it('puts the link in a photo post once when the text already holds it', async () => {
    const { calls, publisher } = sequence([{ body: { id: 'photo-1' } }, { body: { id: `${PAGE}_8` } }]);
    const one = input({ content: { body: 'Xem https://example.com/a nhé', title: null, linkUrl: 'https://example.com/a', media: [media[0]!] }, readMedia: async () => new Uint8Array([1]) });
    expect((await publisher.publish(one)).kind).toBe('accepted');
    expect(Object.fromEntries(calls[1]?.form ?? []).message).toBe('Xem https://example.com/a nhé');
  });

  it('finds a post with photos and a link again by the text it was sent with', async () => {
    const { publisher } = sequence([{ body: { data: [{ id: `${PAGE}_7`, message: 'Ảnh khai trương\n\nhttps://example.com/a', permalink_url: 'https://www.facebook.com/p/7' }] } }]);
    const found = await publisher.reconcile({
      externalAccountId: PAGE,
      secret: SECRET,
      callKey: 'call-1',
      contentHash: `sha256:${'0'.repeat(64)}`,
      content: { body: 'Ảnh khai trương', title: null, linkUrl: 'https://example.com/a', media },
      after: new Date(Date.now() - 600_000),
      before: new Date(),
    });
    expect(found).toEqual({ found: true, externalId: `${PAGE}_7`, url: 'https://www.facebook.com/p/7' });
  });

  it('posts nothing when an image cannot be read or a photo upload fails', async () => {
    const unreadable = sequence([]);
    expect(await unreadable.publisher.publish(withMedia(async () => Promise.reject(new Error('sha256 mismatch'))))).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'MEDIA_UNREADABLE' });
    expect(unreadable.calls).toHaveLength(0);
    const down = sequence([{ body: { id: 'photo-1' } }, { status: 500, body: { error: { message: 'Service temporarily unavailable', code: 2 } } }]);
    expect(await down.publisher.publish(withMedia(async () => new Uint8Array([1])))).toMatchObject({ kind: 'rejected', error: 'transient' });
    expect(down.calls.map((c) => c.path)).toEqual([`/v24.0/${PAGE}/photos`, `/v24.0/${PAGE}/photos`]);
  });
});

describe('FacebookPagePublisher.metrics', () => {
  it('reads reactions, comments and shares of a Page post', async () => {
    const { calls, publisher } = fake({ body: { reactions: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } }, shares: { count: 2 } } });
    expect(await publisher.metrics({ externalAccountId: PAGE, secret: SECRET, externalId: `${PAGE}_42` })).toEqual({ metrics: { reactions: 12, comments: 3, shares: 2 } });
    expect(calls[0]?.url.pathname).toBe(`/v24.0/${PAGE}_42`);
    expect(calls[0]?.url.searchParams.get('fields')).toContain('reactions.summary(total_count)');
  });

  it('counts no shares as zero, tells a deleted post and a dead token apart from an outage', async () => {
    expect(await fake({ body: { reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } } } }).publisher.metrics({ externalAccountId: PAGE, secret: SECRET, externalId: `${PAGE}_42` })).toEqual({
      metrics: { reactions: 0, comments: 0, shares: 0 },
    });
    const gone = { status: 400, body: { error: { message: 'Object does not exist', type: 'GraphMethodException', code: 100, error_subcode: 33 } } };
    expect(await fake(gone).publisher.metrics({ externalAccountId: PAGE, secret: SECRET, externalId: `${PAGE}_42` })).toEqual({ refused: 'gone' });
    // Code 100 without subcode 33 is a permission or field problem, not a deleted post.
    expect(await fake(graphError(400, 100, 'Requires pages_read_engagement')).publisher.metrics({ externalAccountId: PAGE, secret: SECRET, externalId: `${PAGE}_42` })).toBeNull();
    expect(await fake(graphError(400, 190)).publisher.metrics({ externalAccountId: PAGE, secret: SECRET, externalId: `${PAGE}_42` })).toEqual({ refused: 'token_expired' });
    expect(await fake(graphError(500, 2)).publisher.metrics({ externalAccountId: PAGE, secret: SECRET, externalId: `${PAGE}_42` })).toBeNull();
  });
});

// Several answers by route, for the multi-step Story and Reel endpoints (#644).
function routed(routes: Record<string, { status?: number; body: unknown }[]>) {
  const calls: { route: string; host: string; form: URLSearchParams; headers: Headers; bytes: number }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/v24.0', '')}`;
    const body = init?.body;
    calls.push({
      route,
      host: url.host,
      form: new URLSearchParams(typeof body === 'string' ? body : ''),
      headers: new Headers(init?.headers),
      bytes: body instanceof Uint8Array ? body.byteLength : 0,
    });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { message: `no answer for ${route}`, code: 1 } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, publisher: new FacebookPagePublisher(APP, fetchImpl) };
}

describe('FacebookPagePublisher Stories and Reels (#644)', () => {
  const photo = { fileId: 'f-1', mime: 'image/jpeg', sizeBytes: 3, altText: null };
  const clip = { fileId: 'v-1', mime: 'video/mp4', sizeBytes: 5, altText: null };
  const read = async () => new Uint8Array([1, 2, 3, 4, 5]);

  it('makes a photo Story from an unpublished photo, sending no text', async () => {
    const { calls, publisher } = routed({
      [`POST /${PAGE}/photos`]: [{ body: { id: '5551' } }],
      [`POST /${PAGE}/photo_stories`]: [{ body: { success: true, post_id: '7771' } }],
    });
    const result = await publisher.publish(input({ content: { body: 'Không gửi', title: null, linkUrl: null, media: [photo] }, readMedia: read, settings: { postType: 'story' } }));
    expect(result).toEqual({ kind: 'accepted', externalId: `${PAGE}_7771`, url: `https://www.facebook.com/${PAGE}_7771` });
    expect(calls.map((c) => c.route)).toEqual([`POST /${PAGE}/photos`, `POST /${PAGE}/photo_stories`]);
    expect(Object.fromEntries(calls[1]?.form ?? [])).toEqual({ photo_id: '5551' });
  });

  it('starts a video Story, uploads its bytes to the upload host by the id Meta gave, and finishes it', async () => {
    const { calls, publisher } = routed({
      [`POST /${PAGE}/video_stories`]: [{ body: { video_id: '8881', upload_url: 'https://evil.example/steal' } }, { body: { success: true, post_id: `${PAGE}_9991` } }],
      'POST /video-upload/8881': [{ body: { success: true } }],
    });
    const result = await publisher.publish(input({ content: { body: '', title: null, linkUrl: null, media: [clip] }, readMedia: read, settings: { postType: 'story' } }));
    expect(result).toEqual({ kind: 'accepted', externalId: `${PAGE}_9991`, url: `https://www.facebook.com/${PAGE}_9991` });
    expect(calls.map((c) => [c.route, c.host])).toEqual([
      [`POST /${PAGE}/video_stories`, 'graph.facebook.com'],
      ['POST /video-upload/8881', 'rupload.facebook.com'],
      [`POST /${PAGE}/video_stories`, 'graph.facebook.com'],
    ]);
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({ upload_phase: 'start' });
    expect(calls[1]?.headers.get('authorization')).toBe('OAuth page-token-1');
    expect(calls[1]?.headers.get('offset')).toBe('0');
    expect(calls[1]?.headers.get('file_size')).toBe('5');
    expect(calls[1]?.bytes).toBe(5);
    expect(Object.fromEntries(calls[2]?.form ?? [])).toEqual({ upload_phase: 'finish', video_id: '8881' });
  });

  it('publishes a Reel with the text as its description, named by its video id', async () => {
    const { calls, publisher } = routed({
      [`POST /${PAGE}/video_reels`]: [{ body: { video_id: '4441' } }, { body: { success: true } }],
      'POST /video-upload/4441': [{ body: { success: true } }],
    });
    const result = await publisher.publish(input({ content: { body: 'Reel khai trương', title: null, linkUrl: null, media: [clip] }, readMedia: read, settings: { postType: 'reel' } }));
    expect(result).toEqual({ kind: 'accepted', externalId: `${PAGE}_4441`, url: 'https://www.facebook.com/reel/4441' });
    expect(Object.fromEntries(calls[2]?.form ?? [])).toEqual({ upload_phase: 'finish', video_id: '4441', video_state: 'PUBLISHED', description: 'Reel khai trương' });
  });

  it('posts nothing when a step before the last fails, and calls the last answer unclear when Meta does not confirm', async () => {
    // The upload refused: nothing was published, a failure to retry.
    const upload = routed({ [`POST /${PAGE}/video_reels`]: [{ body: { video_id: '4442' } }], 'POST /video-upload/4442': [{ status: 500, body: { error: { message: 'oops', code: 1 } } }] });
    expect(await upload.publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [clip] }, readMedia: read, settings: { postType: 'reel' } }))).toMatchObject({ kind: 'rejected', error: 'transient' });
    expect(upload.calls.filter((c) => c.route === `POST /${PAGE}/video_reels`)).toHaveLength(1);
    // The finish answered without success: unknown, for reconcile.
    const finish = routed({ [`POST /${PAGE}/video_reels`]: [{ body: { video_id: '4443' } }, { body: {} }], 'POST /video-upload/4443': [{ body: { success: true } }] });
    expect(await finish.publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [clip] }, readMedia: read, settings: { postType: 'reel' } }))).toEqual({ kind: 'unknown', code: 'REEL_NOT_CONFIRMED' });
    // A bad video id from start: never sent anywhere.
    const odd = routed({ [`POST /${PAGE}/video_stories`]: [{ body: { video_id: '../x' } }] });
    expect(await odd.publisher.publish(input({ content: { body: '', title: null, linkUrl: null, media: [clip] }, readMedia: read, settings: { postType: 'story' } }))).toMatchObject({ kind: 'rejected', code: 'NO_VIDEO_ID' });
    expect(odd.calls).toHaveLength(1);
  });

  it('refuses a Story of two images, a Reel of a photo and an unknown type before calling Meta, and never reconciles them by text', async () => {
    const { calls, publisher } = routed({});
    expect(await publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [photo, photo] }, settings: { postType: 'story' } }))).toMatchObject({ code: 'STORY_ONE_MEDIA' });
    expect(await publisher.publish(input({ content: { body: 'x', title: null, linkUrl: null, media: [photo] }, settings: { postType: 'reel' } }))).toMatchObject({ code: 'REEL_ONE_VIDEO' });
    expect(await publisher.publish(input({ settings: { postType: 'live' } }))).toMatchObject({ code: 'POST_TYPE_NOT_SUPPORTED' });
    expect(calls).toEqual([]);
    const window = { after: new Date(), before: new Date() };
    for (const postType of ['story', 'reel']) {
      const asked: ReconcileInput = { externalAccountId: PAGE, secret: SECRET, callKey: 'k', contentHash: 'h', content: { body: 'x', title: null, linkUrl: null, media: [clip] }, settings: { postType }, ...window };
      expect(await publisher.reconcile(asked)).toEqual({ found: 'unknown' });
    }
    expect(calls).toEqual([]);
  });
});
describe('FacebookPagePublisher.remove (#1137)', () => {
  const POST = `${PAGE}_42`;
  const DELETE = `DELETE /${POST}`;
  const READ = `GET /${POST}`;
  const remove = (publisher: FacebookPagePublisher, externalId = POST) => publisher.remove({ externalAccountId: PAGE, secret: SECRET, externalId });
  const gone = { status: 400, body: { error: { message: 'Unsupported delete request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation', type: 'GraphMethodException', code: 100, error_subcode: 33 } } };

  it('deletes the Page post with the Page token', async () => {
    const { calls, publisher } = routed({ [DELETE]: [{ body: { success: true } }] });
    expect(await remove(publisher)).toEqual({ kind: 'removed' });
    expect(calls.map((c) => [c.route, c.host, c.headers.get('authorization')])).toEqual([[DELETE, 'graph.facebook.com', 'Bearer page-token-1']]);
  });

  it('counts a post Meta no longer has as removed once a read of it says the same', async () => {
    const { calls, publisher } = routed({ [DELETE]: [gone], [READ]: [{ status: 400, body: { error: { message: 'Object does not exist', type: 'GraphMethodException', code: 100, error_subcode: 33 } } }] });
    expect(await remove(publisher)).toEqual({ kind: 'removed' });
    expect(calls.map((c) => c.route)).toEqual([DELETE, READ]);
  });

  it('maps a post Meta keeps, a missing permission, a dead token and a rate limit to clear refusals', async () => {
    const kept = routed({ [DELETE]: [gone], [READ]: [{ body: { id: POST } }] });
    expect(await remove(kept.publisher)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'FACEBOOK_CANNOT_DELETE' });
    expect(await remove(routed({ [DELETE]: [graphError(403, 200, 'Requires pages_manage_posts')] }).publisher)).toMatchObject({ kind: 'rejected', error: 'permission', code: '200' });
    expect(await remove(routed({ [DELETE]: [graphError(400, 190, 'Error validating access token')] }).publisher)).toMatchObject({ kind: 'rejected', error: 'token_expired', code: '190' });
    expect(await remove(routed({ [DELETE]: [graphError(400, 32, 'Page request limit reached')] }).publisher)).toMatchObject({ kind: 'rejected', error: 'rate_limited' });
  });

  it('leaves an outage, a lost answer and an unconfirmed delete unclear', async () => {
    expect(await remove(routed({ [DELETE]: [graphError(500, 2, 'Service temporarily unavailable')] }).publisher)).toMatchObject({ kind: 'unknown', code: '2' });
    expect(await remove(fake(new TypeError('fetch failed')).publisher)).toEqual({ kind: 'unknown', code: 'NETWORK' });
    expect(await remove(routed({ [DELETE]: [{ body: { success: false } }] }).publisher)).toEqual({ kind: 'unknown', code: 'NOT_DELETED' });
    // The read after "does not exist" did not answer: the post may still be up.
    expect(await remove(routed({ [DELETE]: [gone], [READ]: [graphError(500, 1, 'An unknown error occurred')] }).publisher)).toEqual({ kind: 'unknown', code: 'DELETE_UNCONFIRMED' });
  });

  it('sends only a post id of the connected Page, and nothing without a Page token', async () => {
    const { calls, publisher } = routed({});
    expect(await remove(publisher, '42')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await remove(publisher, '999888777_42')).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await remove(publisher, `${PAGE}_42/comments`)).toEqual({ kind: 'rejected', error: 'bad_request', code: 'BAD_POST_ID' });
    expect(await publisher.remove({ externalAccountId: PAGE, secret: '{}', externalId: POST })).toEqual({ kind: 'rejected', error: 'token_expired', code: 'NO_PAGE_TOKEN' });
    expect(calls).toEqual([]);
  });
});
