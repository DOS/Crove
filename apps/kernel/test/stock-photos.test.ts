// Stock photos from Pexels (#1106) with recorded answers, never a real call: the search sends the key to the API host
// only and maps its answer (photos whose links leave Pexels are dropped, thumbnails come back as data: URLs); the save
// reads the photo again by id, fetches the chosen size from Pexels' image host only (checked before the fetch, no
// redirect, the upload limit), refuses a non-image or an oversized answer, stores the bytes and hands the file and its
// credit to social.media.save_stock; Pexels' refusals become fixed answers; the budget counts per member and per org.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@crove/kernel-contract';
import { EgressError, LocalDiskStore, fileKey, sha256Hex, type EgressOptions, type EgressResponse, type GuardedRequest, type Runtime } from '@crove/kernel-runtime';
import { PEXELS_API, StockPhotoBudget, createPexels, parsePexelsPhoto } from '../src/stock-photos.ts';

// A low-entropy fake key: never a real one.
const KEY = 'pexelstestkeyaaaaaaaaaaaaaaaaaaaa';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('a recorded pexels jpeg')]);

const photo = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  width: 4000,
  height: 3000,
  url: `https://www.pexels.com/photo/ca-phe-sua-da-${id}/`,
  photographer: 'Nguyễn Văn A',
  photographer_url: 'https://www.pexels.com/@nguyen-van-a',
  photographer_id: 77,
  avg_color: '#7A5C3E',
  src: {
    original: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg`,
    large2x: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940`,
    large: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=650&w=940`,
    medium: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=350`,
    tiny: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280`,
  },
  liked: false,
  alt: 'Ly cà phê sữa đá\u0000 trên bàn gỗ',
  ...overrides,
});

const answer = (body: unknown, status = 200, contentType = 'application/json', url = 'https://api.pexels.com/'): EgressResponse => ({
  url,
  status,
  contentType,
  body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
  truncated: false,
});

interface Recorded {
  requests: { url: string; request: GuardedRequest; options: EgressOptions }[];
  fetches: { url: string; options: EgressOptions }[];
}

function recorder(api: (url: URL) => EgressResponse, image: (url: string, options: EgressOptions) => EgressResponse | Promise<EgressResponse> = (url) => answer(JPEG, 200, 'image/jpeg', url)) {
  const seen: Recorded = { requests: [], fetches: [] };
  return {
    seen,
    request: async (url: string, request: GuardedRequest, options: EgressOptions) => {
      seen.requests.push({ url, request, options });
      return api(new URL(url));
    },
    fetch: async (url: string, options: EgressOptions) => {
      seen.fetches.push({ url, options });
      return image(url, options);
    },
  };
}

// The runtime as the save sees it: the command it is asked to run, and what the command answers.
function fakeRuntime() {
  const executed: { name: string; input: any; options: unknown }[] = [];
  const runtime = {
    execute: async (name: string, input: unknown, options: unknown) => {
      executed.push({ name, input, options });
      return { fileId: '0190a0a0-0000-7000-8000-000000000001', duplicate: false, credited: true };
    },
  } as unknown as Runtime;
  return { runtime, executed };
}

const actor = { type: 'user' as const, userId: '0190a0a0-0000-7000-8000-0000000000aa', aal: 'aal1' as const };
const ORG = '0190a0a0-0000-7000-8000-0000000000bb';

describe('Pexels stock photos with recorded answers (#1106)', () => {
  let dir = '';
  let store: LocalDiskStore;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crove-pexels-'));
    store = new LocalDiskStore(dir);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('searches with the key on the API host only and maps the answer, dropping photos that link outside Pexels', async () => {
    const rec = recorder(() =>
      answer({
        total_results: 1234,
        page: 2,
        per_page: 24,
        photos: [photo(101), photo(102, { photographer_url: 'https://evil.example/@x' }), photo(103, { url: 'http://www.pexels.com/photo/103/' }), photo(104, { src: { tiny: 'https://evil.example/t.jpg' } })],
        next_page: 'https://api.pexels.com/v1/search/?page=3&per_page=24&query=c%C3%A0+ph%C3%AA',
      }),
    );
    const stock = createPexels({ apiKey: KEY, store, request: rec.request, fetch: rec.fetch });
    const result = await stock.search({ query: 'cà phê', page: 2, locale: 'vi-VN', orientation: 'portrait' });
    expect(rec.seen.requests).toHaveLength(1);
    const sent = rec.seen.requests[0];
    const url = new URL(sent?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${PEXELS_API}/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'cà phê', page: '2', per_page: '24', orientation: 'portrait', locale: 'vi-VN' });
    expect(sent?.request).toEqual({ method: 'GET', headers: { authorization: KEY } });
    expect(sent?.options).toMatchObject({ overLimit: 'fail' });
    expect(result.page).toBe(2);
    expect(result.total).toBe(1234);
    expect(result.more).toBe(true);
    // 102 and 103 link outside Pexels' pages; 104 keeps its links but has no thumbnail on the image host.
    expect(result.photos.map((p) => p.id)).toEqual([101, 104]);
    expect(result.photos[0]).toEqual({
      id: 101,
      width: 4000,
      height: 3000,
      pageUrl: 'https://www.pexels.com/photo/ca-phe-sua-da-101/',
      photographer: 'Nguyễn Văn A',
      photographerUrl: 'https://www.pexels.com/@nguyen-van-a',
      // Control characters dropped, one line of text.
      alt: 'Ly cà phê sữa đá trên bàn gỗ',
      avgColor: '#7A5C3E',
      thumb: `data:image/jpeg;base64,${JPEG.toString('base64')}`,
    });
    expect(result.photos[1]?.thumb).toBeNull();
    // Only the image host was fetched, for the one thumbnail on it, without following redirects.
    expect(rec.seen.fetches.map((f) => new URL(f.url).hostname)).toEqual(['images.pexels.com']);
    expect(rec.seen.fetches.every((f) => f.options.maxRedirects === 0 && f.options.overLimit === 'fail')).toBe(true);
    // The response carries no key.
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('saves a photo read again by id: the chosen size from the image host, stored, and handed to the command with its credit', async () => {
    const rec = recorder((url) => {
      expect(url.pathname).toBe('/v1/photos/101');
      return answer(photo(101));
    });
    const stock = createPexels({ apiKey: KEY, store, request: rec.request, fetch: rec.fetch });
    const { runtime, executed } = fakeRuntime();
    const saved = await stock.save(runtime, actor, ORG, { photoId: 101 });
    expect(rec.seen.fetches).toHaveLength(1);
    const fetched = rec.seen.fetches[0];
    expect(fetched?.url).toBe(photo(101).src.large2x);
    expect(fetched?.options).toMatchObject({ maxRedirects: 0, overLimit: 'fail', maxBytes: MAX_UPLOAD_BYTES });
    const sha = sha256Hex(JPEG);
    expect(executed).toEqual([
      {
        name: 'social.media.save_stock',
        input: {
          file: { filename: 'pexels-101.jpg', contentType: 'image/jpeg', sizeBytes: JPEG.byteLength, sha256: sha, storageKey: fileKey(ORG, sha), generation: expect.any(String) },
          credit: {
            provider: 'pexels',
            externalId: '101',
            photographer: 'Nguyễn Văn A',
            photographerUrl: 'https://www.pexels.com/@nguyen-van-a',
            sourceUrl: 'https://www.pexels.com/photo/ca-phe-sua-da-101/',
            altText: 'Ly cà phê sữa đá trên bàn gỗ',
          },
        },
        options: { actor, orgId: ORG },
      },
    ]);
    // The bytes are in the store under the file's key, as an upload's are.
    expect(Buffer.from(await store.get(fileKey(ORG, sha)))).toEqual(JPEG);
    expect(saved).toMatchObject({ fileId: '0190a0a0-0000-7000-8000-000000000001', filename: 'pexels-101.jpg', mime: 'image/jpeg', altText: 'Ly cà phê sữa đá trên bàn gỗ' });
  });

  it('refuses a src on another host before any fetch, and a credit that links outside Pexels', async () => {
    for (const bad of [
      photo(201, { src: { large2x: 'https://images.pexels.com.evil.example/p.jpg' } }),
      photo(202, { src: { large2x: 'http://images.pexels.com/p.jpg' } }),
      photo(203, { src: { large2x: 'https://169.254.169.254/latest/meta-data' } }),
      photo(204, { photographer_url: 'https://evil.example/@x' }),
      photo(205, { url: 'javascript:alert(1)' }),
    ]) {
      const rec = recorder(() => answer(bad));
      const { runtime, executed } = fakeRuntime();
      await expect(createPexels({ apiKey: KEY, store, request: rec.request, fetch: rec.fetch }).save(runtime, actor, ORG, { photoId: bad.id })).rejects.toMatchObject({ code: 'STOCK_PHOTO_REFUSED', status: 422 });
      expect(rec.seen.fetches).toEqual([]);
      expect(executed).toEqual([]);
    }
    // Pexels answering with another photo than the one asked for.
    const rec = recorder(() => answer(photo(999)));
    const { runtime } = fakeRuntime();
    await expect(createPexels({ apiKey: KEY, store, request: rec.request, fetch: rec.fetch }).save(runtime, actor, ORG, { photoId: 300 })).rejects.toMatchObject({ code: 'STOCK_PHOTO_REFUSED' });
  });

  it('refuses a redirect, an oversized answer and an answer that is not a JPEG, PNG or WebP image', async () => {
    const cases: [string, (url: string, o: EgressOptions) => EgressResponse, string, number][] = [
      [
        'redirect',
        () => {
          throw new EgressError('redirects', 'too many redirects');
        },
        'STOCK_PHOTO_REFUSED',
        422,
      ],
      [
        'too large',
        () => {
          throw new EgressError('too_large', 'the response is too large');
        },
        'TOO_LARGE',
        413,
      ],
      ['html', (url) => answer(Buffer.from('<!doctype html><title>x</title>'), 200, 'text/html', url), 'UNSUPPORTED_TYPE', 415],
      ['jpeg bytes, html type', (url) => answer(JPEG, 200, 'text/html', url), 'UNSUPPORTED_TYPE', 415],
      ['gif', (url) => answer(Buffer.from('GIF89a....'), 200, 'image/gif', url), 'UNSUPPORTED_TYPE', 415],
      ['pdf', (url) => answer(Buffer.from('%PDF-1.7 ...'), 200, 'application/pdf', url), 'UNSUPPORTED_TYPE', 415],
      ['answered from elsewhere', () => answer(JPEG, 200, 'image/jpeg', 'https://evil.example/p.jpg'), 'STOCK_PHOTO_REFUSED', 422],
      ['not found', (url) => answer(Buffer.from(''), 404, 'text/plain', url), 'STOCK_PHOTOS_UNAVAILABLE', 503],
    ];
    for (const [name, image, code, status] of cases) {
      const rec = recorder(() => answer(photo(301)), image);
      const { runtime, executed } = fakeRuntime();
      await expect(createPexels({ apiKey: KEY, store, request: rec.request, fetch: rec.fetch }).save(runtime, actor, ORG, { photoId: 301 }), name).rejects.toMatchObject({ code, status });
      expect(executed, name).toEqual([]);
    }
  });

  it('passes on Pexels refusals as fixed answers without the key or Pexels words in them', async () => {
    const cases: [number, string, number][] = [
      [429, 'STOCK_PHOTOS_BUSY', 429],
      [401, 'STOCK_PHOTOS_UNAVAILABLE', 503],
      [403, 'STOCK_PHOTOS_UNAVAILABLE', 503],
      [500, 'STOCK_PHOTOS_UNAVAILABLE', 503],
      [404, 'STOCK_PHOTO_NOT_FOUND', 404],
    ];
    for (const [given, code, status] of cases) {
      const rec = recorder(() => answer({ error: `key ${KEY} refused` }, given));
      const failure = await createPexels({ apiKey: KEY, store, request: rec.request, fetch: rec.fetch })
        .search({ query: 'bánh mì' })
        .catch((e: unknown) => e as { code: string; status: number; message: string });
      expect(failure).toMatchObject({ code, status });
      expect(String((failure as { message: string }).message)).not.toContain(KEY);
    }
    // The API host not answering, and an answer that is not JSON.
    const down = recorder(() => {
      throw new EgressError('timeout', 'took too long');
    });
    await expect(createPexels({ apiKey: KEY, store, request: down.request, fetch: down.fetch }).search({ query: 'x' })).rejects.toMatchObject({ code: 'STOCK_PHOTOS_UNAVAILABLE' });
    const garbled = recorder(() => answer(Buffer.from('<html>'), 200, 'text/html'));
    await expect(createPexels({ apiKey: KEY, store, request: garbled.request, fetch: garbled.fetch }).search({ query: 'x' })).rejects.toMatchObject({ code: 'STOCK_PHOTOS_UNAVAILABLE' });
  });

  it('reads a photo only with its own links on pexels.com and its images on the image host', () => {
    expect(parsePexelsPhoto(null)).toBeNull();
    expect(parsePexelsPhoto(photo(1, { id: -1 }))).toBeNull();
    expect(parsePexelsPhoto(photo(1, { photographer_url: 'https://pexels.com.evil.example/@a' }))).toBeNull();
    expect(parsePexelsPhoto(photo(1, { url: 'https://user:pw@www.pexels.com/photo/1/' }))).toBeNull();
    const kept = parsePexelsPhoto(photo(1, { photographer: '  ', alt: '', avg_color: 'red;background:url(x)', src: { original: 'https://images.pexels.com/photos/1/a.jpeg', large2x: 'https://images.pexels.com:8443/x.jpg' } }));
    expect(kept).toMatchObject({ photographer: 'Pexels', alt: null, avgColor: null, src: { original: 'https://images.pexels.com/photos/1/a.jpeg' } });
    expect(kept?.src.large2x).toBeUndefined();
  });

  it('gives a member a few requests a minute and an org a few more', () => {
    let now = 0;
    const budget = new StockPhotoBudget({ perUserPerMinute: 2, perOrgPerMinute: 3, now: () => now });
    expect(budget.take('org', 'a').allowed).toBe(true);
    expect(budget.take('org', 'a').allowed).toBe(true);
    expect(budget.take('org', 'a')).toMatchObject({ allowed: false });
    expect(budget.take('org', 'b').allowed).toBe(true);
    // The org's budget is spent: another member waits too, and is not charged for it.
    expect(budget.take('org', 'c')).toMatchObject({ allowed: false });
    expect(budget.take('other', 'c').allowed).toBe(true);
    now += 60_000;
    expect(budget.take('org', 'c').allowed).toBe(true);
  });

  it('keeps one org to its share of the hour and the deployment under the shared key', () => {
    let now = 0;
    const budget = new StockPhotoBudget({ perUserPerMinute: 100, perOrgPerMinute: 100, perOrgPerHour: 2, perDeploymentPerHour: 3, now: () => now });
    expect(budget.take('busy', 'a').allowed).toBe(true);
    expect(budget.take('busy', 'b').allowed).toBe(true);
    // The org's hour is spent; it waits about half an hour for one more, and the others still get theirs.
    const refused = budget.take('busy', 'c');
    expect(refused).toMatchObject({ allowed: false });
    expect(refused.allowed ? 0 : refused.retryAfterSeconds).toBe(30 * 60);
    expect(budget.take('quiet', 'd').allowed).toBe(true);
    // The deployment's hour is spent for every org.
    expect(budget.take('third', 'e')).toMatchObject({ allowed: false });
    now += 60 * 60_000;
    expect(budget.take('third', 'e').allowed).toBe(true);
  });
});
