// Image URLs of the Social CSV import (#1258), as Publer's and Buffer's sheets take public media URLs. The API fetches
// each one, never the browser, through the egress guard (public addresses only: every DNS answer of every hop is
// checked and the connection pinned to the checked address, so a private, loopback or link-local address is refused),
// https only (an http URL, or a redirect that ends on http, is refused), at most MAX_UPLOAD_BYTES, and a JPEG, PNG or
// WEBP by its bytes. The image is then stored like an upload with source 'social' (image-ingest.ts, as Pexels photos
// are, #1106), so it lands in the media library and the import attaches it by its file id; bytes the org already holds
// as an accounting document are refused (FILE_IS_DOCUMENT). Each refused URL says why, for the row preview.
//
// A member fetches at most perUserPerMinute URLs a minute and an org perOrgPerHour an hour, in this process's memory
// like the stock photo budget; a member runs one batch at a time and the process two, each fetching two images at
// once, so at most four images are held in memory at once.
import { MAX_UPLOAD_BYTES, type SOCIAL_MEDIA_URL_PROBLEMS } from '@crove/kernel-contract';
import { DomainError, EgressError, guardedFetch, type BlobStore, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { ConcurrencyLimiter } from './concurrency.ts';
import { photoType, storePhoto } from './image-ingest.ts';
import { RateLimiter } from './rate-limit.ts';
import { HourLimiter } from './stock-photos.ts';

const IMAGE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const FETCHES_AT_ONCE = 2;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp;q=0.9,image/*;q=0.5';
export const MEDIA_URL_MAX_LENGTH = 2000;

export type MediaUrlProblem = (typeof SOCIAL_MEDIA_URL_PROBLEMS)[number];

export interface MediaUrlResult {
  url: string;
  file: { fileId: string; filename: string; mime: string; sizeBytes: number; durationMs: null; width: number | null; height: number | null } | null;
  problem: MediaUrlProblem | null;
  retryAfterSeconds?: number;
}

// URLs a member (per org) may fetch a minute, and an org an hour.
export class MediaUrlBudget {
  private readonly users: RateLimiter;
  private readonly orgs: HourLimiter;

  constructor(options: { perUserPerMinute?: number; perOrgPerHour?: number; now?: () => number } = {}) {
    const now = options.now ?? Date.now;
    this.users = new RateLimiter({ perMinute: options.perUserPerMinute ?? 120, now });
    this.orgs = new HourLimiter(options.perOrgPerHour ?? 2000, now);
  }

  take(orgId: string, userId: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const key = `${orgId}:${userId}`;
    // Both looked at before either is spent, as for stock photos.
    const user = this.users.peek(key);
    if (!user.allowed) return { allowed: false, retryAfterSeconds: user.retryAfterSeconds };
    const org = this.orgs.peek(orgId);
    if (!org.allowed) return org;
    const takenUser = this.users.take(key);
    if (!takenUser.allowed) return { allowed: false, retryAfterSeconds: takenUser.retryAfterSeconds };
    return this.orgs.take(orgId);
  }
}

export interface MediaUrlsOptions {
  // Where the images are written, the store uploads use.
  store: BlobStore;
  budget?: MediaUrlBudget;
  slots?: ConcurrencyLimiter;
  // Tests only: recorded answers (or the guard with a recorded resolver) in place of the network.
  fetch?: typeof guardedFetch;
}

export interface MediaUrls {
  fetch(runtime: Runtime, actor: UserActor, orgId: string, urls: readonly string[]): Promise<{ results: MediaUrlResult[] }>;
}

// The URL as the guard is asked for it: absolute https with a host, no user name or password, at most 2000 characters.
export function mediaUrl(raw: string): URL | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > MEDIA_URL_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url;
}

// The library name of an image from its URL: the last part of its path, decoded, as one line of text with no ";" (the
// import's separator), else the host. safeFilename gives it the extension of its type.
export function urlFileName(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // Kept as written.
  }
  const clean = [...name.normalize('NFC')]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === ';' || ch === ',' ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || url.hostname;
}

function refusal(error: EgressError): MediaUrlProblem {
  if (error.code === 'invalid_url') return 'MEDIA_URL_INVALID';
  if (error.code === 'blocked') return 'MEDIA_URL_BLOCKED';
  if (error.code === 'too_large') return 'MEDIA_URL_TOO_LARGE';
  return 'MEDIA_URL_UNREACHABLE';
}

export function createMediaUrls(options: MediaUrlsOptions): MediaUrls {
  const fetchImage = options.fetch ?? guardedFetch;
  const budget = options.budget ?? new MediaUrlBudget();
  const slots = options.slots ?? new ConcurrencyLimiter({ total: 2, perKey: 1 });

  async function one(runtime: Runtime, actor: UserActor, orgId: string, raw: string): Promise<MediaUrlResult> {
    const refused = (problem: MediaUrlProblem, retryAfterSeconds?: number): MediaUrlResult => ({ url: raw, file: null, problem, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
    const url = mediaUrl(raw);
    if (!url) return refused('MEDIA_URL_INVALID');
    const ticket = budget.take(orgId, actor.userId);
    if (!ticket.allowed) return refused('MEDIA_URL_BUSY', ticket.retryAfterSeconds);
    let answer;
    try {
      answer = await fetchImage(url.toString(), { timeoutMs: IMAGE_TIMEOUT_MS, maxBytes: MAX_UPLOAD_BYTES, overLimit: 'fail', maxRedirects: MAX_REDIRECTS, accept: IMAGE_ACCEPT });
    } catch (error) {
      if (error instanceof EgressError) return refused(refusal(error));
      // Anything else the fetch throws (a reset socket, a resolver failure) is this URL's problem only: the batch's
      // other URLs still answer. The detail stays in the server's log, never in the answer.
      console.warn(`[media-urls] an image fetch failed: ${error instanceof Error ? error.name : typeof error}`);
      return refused('MEDIA_URL_UNREACHABLE');
    }
    // Every hop went through the guard; the one that answered must be https too.
    if (new URL(answer.url).protocol !== 'https:') return refused('MEDIA_URL_INVALID');
    if (answer.status !== 200) return refused('MEDIA_URL_UNREACHABLE');
    const type = photoType(answer.body, answer.contentType, false);
    if (!type) return refused('MEDIA_URL_NOT_IMAGE');
    const file = await storePhoto(options.store, orgId, answer.body, type, urlFileName(url));
    try {
      const { fileId } = await runtime.execute<{ fileId: string }>('kernel.file.ingest', { ...file, source: 'social' }, { actor, orgId });
      return { url: raw, file: { fileId, filename: file.filename, mime: type, sizeBytes: file.sizeBytes, durationMs: null, width: file.imageWidth ?? null, height: file.imageHeight ?? null }, problem: null };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'FILE_IS_DOCUMENT') return refused('MEDIA_URL_DOCUMENT');
      throw error;
    }
  }

  return {
    async fetch(runtime, actor, orgId, urls) {
      const release = slots.tryAcquire(actor.userId);
      if (!release) throw new DomainError('MEDIA_URLS_BUSY', 503, 'Máy chủ đang tải nhiều ảnh; hãy thử lại sau vài giây', { retryAfterSeconds: 5 });
      try {
        const results: MediaUrlResult[] = [];
        let next = 0;
        const worker = async () => {
          while (next < urls.length) {
            const i = next++;
            results[i] = await one(runtime, actor, orgId, urls[i] as string);
          }
        };
        await Promise.all(Array.from({ length: Math.min(FETCHES_AT_ONCE, urls.length) }, worker));
        return { results };
      } finally {
        release();
      }
    },
  };
}
