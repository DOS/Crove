// The CSV import's image URLs (#1258) with recorded answers, never a real call: a fetch that throws something other
// than the guard's own refusal (a reset socket, a resolver failure) is that URL's problem only, and the other URLs of
// the batch still answer; the URL's file name comes from its path.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EgressError, LocalDiskStore, type EgressOptions, type EgressResponse, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { createMediaUrls, mediaUrl, urlFileName } from '../src/media-urls.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from('a recorded jpeg')]);
const ORG = '11111111-1111-4111-8111-111111111111';
const actor = { type: 'user', userId: '22222222-2222-4222-8222-222222222222' } as unknown as UserActor;

describe('image URLs of the CSV import (#1258)', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crove-media-urls-'));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('answers every URL of a batch when a fetch throws something unexpected, and logs no URL', async () => {
    const fetch = async (raw: string, _options: EgressOptions): Promise<EgressResponse> => {
      if (raw.includes('reset')) throw Object.assign(new Error('socket hang up at https://cdn.test/reset.jpg'), { code: 'ECONNRESET' });
      if (raw.includes('dns')) throw new TypeError('getaddrinfo EAI_AGAIN');
      if (raw.includes('blocked')) throw new EgressError('blocked', 'not a public address');
      return { url: raw, status: 200, contentType: 'image/jpeg', body: JPEG, truncated: false };
    };
    const executed: unknown[] = [];
    const runtime = {
      execute: async (name: string, input: unknown) => {
        executed.push([name, input]);
        return { fileId: '33333333-3333-4333-8333-333333333333', duplicate: false };
      },
    } as unknown as Runtime;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const urls = createMediaUrls({ store: new LocalDiskStore(dir), fetch });
      const { results } = await urls.fetch(runtime, actor, ORG, ['https://cdn.test/reset.jpg', 'https://cdn.test/ok.jpg', 'https://cdn.test/dns.jpg', 'https://cdn.test/blocked.jpg']);
      expect(results.map((r) => [r.url, r.problem, r.file?.fileId ?? null])).toEqual([
        ['https://cdn.test/reset.jpg', 'MEDIA_URL_UNREACHABLE', null],
        ['https://cdn.test/ok.jpg', null, '33333333-3333-4333-8333-333333333333'],
        ['https://cdn.test/dns.jpg', 'MEDIA_URL_UNREACHABLE', null],
        ['https://cdn.test/blocked.jpg', 'MEDIA_URL_BLOCKED', null],
      ]);
      expect(executed).toHaveLength(1);
      expect(executed[0]).toMatchObject(['kernel.file.ingest', { filename: 'ok.jpg', contentType: 'image/jpeg', source: 'social' }]);
      const logged = warn.mock.calls.flat().join('\n');
      expect(logged).toContain('[media-urls] an image fetch failed');
      expect(logged).not.toContain('cdn.test');
    } finally {
      warn.mockRestore();
    }
  });

  it('takes absolute https URLs without credentials only, and names the file from its path', () => {
    expect(mediaUrl('https://cdn.test/a.jpg')?.hostname).toBe('cdn.test');
    for (const bad of ['http://cdn.test/a.jpg', 'https://u:p@cdn.test/a.jpg', 'cdn.test/a.jpg', '', `https://cdn.test/${'a'.repeat(2000)}`]) expect(mediaUrl(bad), bad).toBeNull();
    expect(urlFileName(new URL('https://cdn.test/anh/b%C3%A1nh%3Bm%C3%AC%2C%0A1.jpeg?w=1'))).toBe('bánh mì 1.jpeg');
    expect(urlFileName(new URL('https://cdn.test/'))).toBe('cdn.test');
  });
});
