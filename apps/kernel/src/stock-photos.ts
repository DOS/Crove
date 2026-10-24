// Stock photos from Pexels in the Social media library and the composer (#1106), on when the deployment sets
// MEDIA_PEXELS_API_KEY. The API is the only party that talks to Pexels: the key never reaches a browser, and neither
// does a request to Pexels, since thumbnails come back as data: URLs (the app's Content-Security-Policy loads images
// from the app's own origin only).
//
// Search: GET https://api.pexels.com/v1/search with the key in the Authorization header (guardedRequest, which follows
// no redirect, so the key never goes to another host). Save: the photo is read again from Pexels by its id
// (GET /v1/photos/:id), so its credit and its image address come from Pexels, never from the browser. The image is
// fetched through the egress guard from Pexels' image host only (the host is checked before the fetch, no redirect is
// followed, and the answer is refused past the upload limit), its type read from the bytes (JPEG, PNG or WebP), then
// stored and recorded like an uploaded image (image-ingest.ts, shared with the CSV import's image URLs, #1258;
// social.media.save_stock: kernel.file.ingest with source 'social', and the credit in crove_social.media_attribution).
//
// Pexels allows 200 requests an hour per key (https://www.pexels.com/api/documentation/), and every org of the
// deployment shares the key. So a member gets a few searches and saves a minute, an org at most a third of the
// deployment's hour, and the deployment stays under Pexels' hour, in this process's memory like the AI drafting
// budget (ai-draft-limit.ts): one busy org never leaves the others without stock photos. Pexels' own refusal (429)
// is passed on as "busy", never worked around.
import { MAX_UPLOAD_BYTES, STOCK_PHOTO_SIZES } from '@crove/kernel-contract';
import { DomainError, EgressError, guardedFetch, guardedRequest, type BlobStore, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { PEXELS_IMAGE_HOST, STOCK_ALT_MAX, STOCK_NAME_MAX, pexelsImageUrl, pexelsPageUrl, stockText, type StockCredit } from '@crove/mod-social';
import { photoType, storePhoto } from './image-ingest.ts';
import { RateLimiter } from './rate-limit.ts';

export const PEXELS_API = 'https://api.pexels.com/v1';
const API_TIMEOUT_MS = 8000;
// A search answer of 40 photos is about 40 KB.
const API_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 30_000;
const THUMB_TIMEOUT_MS = 5000;
// Pexels' tiny copies are 10 to 20 KB, so 40 of them stay a small answer.
const THUMB_MAX_BYTES = 64 * 1024;
const THUMBS_AT_ONCE = 6;
// No thumbnail is started after this; the rest show the photo's colour.
const THUMBS_DEADLINE_MS = 10_000;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp;q=0.9';
export const STOCK_PER_PAGE = 24;

export type StockPhotoSize = (typeof STOCK_PHOTO_SIZES)[number];
type SrcKey = StockPhotoSize | 'tiny';

// A photo as Pexels gave it, kept only when its links are Pexels' own; image addresses only on Pexels' image host.
export interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  pageUrl: string;
  photographer: string;
  photographerUrl: string;
  alt: string | null;
  avgColor: string | null;
  src: Partial<Record<SrcKey, string>>;
}

export interface StockSearchInput {
  query: string;
  page?: number | undefined;
  perPage?: number | undefined;
  orientation?: 'landscape' | 'portrait' | 'square' | undefined;
  locale?: 'vi-VN' | 'en-US' | undefined;
}

export interface StockSearchResult {
  photos: (Omit<PexelsPhoto, 'src'> & { thumb: string | null })[];
  page: number;
  total: number;
  more: boolean;
}

export interface StockSaved {
  fileId: string;
  duplicate: boolean;
  credited: boolean;
  filename: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  altText: string | null;
}

export type StockTicket = { allowed: true } | { allowed: false; retryAfterSeconds: number };

// A RateLimiter over an hour: its minute is an hour of real time, so its wait is 60 times longer. The CSV import's
// image URLs (#1258, media-urls.ts) use it too.
export class HourLimiter {
  private readonly limiter: RateLimiter;

  constructor(perHour: number, now: () => number) {
    this.limiter = new RateLimiter({ perMinute: perHour, now: () => now() / 60 });
  }

  peek(key: string): StockTicket {
    return this.ticket(this.limiter.peek(key));
  }

  take(key: string): StockTicket {
    return this.ticket(this.limiter.take(key));
  }

  private ticket(decision: { allowed: boolean; retryAfterSeconds: number }): StockTicket {
    return decision.allowed ? { allowed: true } : { allowed: false, retryAfterSeconds: decision.retryAfterSeconds * 60 };
  }
}

// Searches and saves of a member (per org) and of an org a minute, of an org an hour, and of the whole deployment an
// hour (under Pexels' 200 for the shared key).
export class StockPhotoBudget {
  private readonly users: RateLimiter;
  private readonly orgs: RateLimiter;
  private readonly orgHours: HourLimiter;
  private readonly deployment: HourLimiter;

  constructor(options: { perUserPerMinute?: number; perOrgPerMinute?: number; perOrgPerHour?: number; perDeploymentPerHour?: number; now?: () => number } = {}) {
    const now = options.now ?? Date.now;
    this.users = new RateLimiter({ perMinute: options.perUserPerMinute ?? 20, now });
    this.orgs = new RateLimiter({ perMinute: options.perOrgPerMinute ?? 60, now });
    this.orgHours = new HourLimiter(options.perOrgPerHour ?? 60, now);
    this.deployment = new HourLimiter(options.perDeploymentPerHour ?? 180, now);
  }

  take(orgId: string, userId: string): StockTicket {
    const key = `${orgId}:${userId}`;
    // Both looked at before either is spent: a request the org's budget refuses costs the member nothing.
    const user = this.users.peek(key);
    if (!user.allowed) return { allowed: false, retryAfterSeconds: user.retryAfterSeconds };
    const org = this.orgs.peek(orgId);
    if (!org.allowed) return { allowed: false, retryAfterSeconds: org.retryAfterSeconds };
    const orgHour = this.orgHours.peek(orgId);
    if (!orgHour.allowed) return orgHour;
    const deployment = this.deployment.peek('');
    if (!deployment.allowed) return deployment;
    const takenUser = this.users.take(key);
    if (!takenUser.allowed) return { allowed: false, retryAfterSeconds: takenUser.retryAfterSeconds };
    const takenOrg = this.orgs.take(orgId);
    if (!takenOrg.allowed) return { allowed: false, retryAfterSeconds: takenOrg.retryAfterSeconds };
    const takenHour = this.orgHours.take(orgId);
    if (!takenHour.allowed) return takenHour;
    return this.deployment.take('');
  }
}

export interface StockPhotosOptions {
  apiKey: string;
  // Where the saved images are written, the store uploads use.
  store: BlobStore;
  budget?: StockPhotoBudget;
  // Tests only: recorded answers in place of Pexels.
  request?: typeof guardedRequest;
  fetch?: typeof guardedFetch;
}

export interface StockPhotos {
  readonly provider: 'pexels';
  readonly budget: StockPhotoBudget;
  search(input: StockSearchInput): Promise<StockSearchResult>;
  save(runtime: Runtime, actor: UserActor, orgId: string, input: { photoId: number; size?: StockPhotoSize | undefined }): Promise<StockSaved>;
}

const unavailable = () => new DomainError('STOCK_PHOTOS_UNAVAILABLE', 503, 'Pexels đang không trả lời, hãy thử lại sau ít phút');
const refused = () => new DomainError('STOCK_PHOTO_REFUSED', 422, 'Pexels trả về địa chỉ ngoài Pexels cho ảnh này, nên ảnh không được tải về');

const positiveInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

// One photo of a Pexels answer, or null when its page or its photographer's page is not on pexels.com.
export function parsePexelsPhoto(raw: unknown): PexelsPhoto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = positiveInt(r.id);
  const width = positiveInt(r.width);
  const height = positiveInt(r.height);
  const pageUrl = pexelsPageUrl(r.url);
  const photographerUrl = pexelsPageUrl(r.photographer_url);
  if (id === null || width === null || height === null || !pageUrl || !photographerUrl) return null;
  const src: Partial<Record<SrcKey, string>> = {};
  const given = typeof r.src === 'object' && r.src !== null ? (r.src as Record<string, unknown>) : {};
  for (const key of [...STOCK_PHOTO_SIZES, 'tiny'] as const) {
    const url = pexelsImageUrl(given[key]);
    if (url) src[key] = url;
  }
  const avg = typeof r.avg_color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(r.avg_color) ? r.avg_color : null;
  return { id, width, height, pageUrl, photographer: stockText(r.photographer, STOCK_NAME_MAX) ?? 'Pexels', photographerUrl, alt: stockText(r.alt, STOCK_ALT_MAX), avgColor: avg, src };
}

export function createPexels(options: StockPhotosOptions): StockPhotos {
  const request = options.request ?? guardedRequest;
  const fetchImage = options.fetch ?? guardedFetch;
  const budget = options.budget ?? new StockPhotoBudget();

  async function api(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    let answer;
    try {
      answer = await request(`${PEXELS_API}${path}${qs ? `?${qs}` : ''}`, { method: 'GET', headers: { authorization: options.apiKey } }, { timeoutMs: API_TIMEOUT_MS, maxBytes: API_MAX_BYTES, overLimit: 'fail', accept: 'application/json' });
    } catch (error) {
      if (error instanceof EgressError) {
        console.warn(`[pexels] the API did not answer: ${error.code}`);
        throw unavailable();
      }
      throw error;
    }
    if (answer.status === 429) throw new DomainError('STOCK_PHOTOS_BUSY', 429, 'Pexels đang giới hạn số lượt tìm ảnh, hãy thử lại sau', { retryAfterSeconds: 60 });
    if (answer.status === 404) throw new DomainError('STOCK_PHOTO_NOT_FOUND', 404, 'Không tìm thấy ảnh này trên Pexels');
    if (answer.status === 401 || answer.status === 403) {
      console.warn('[pexels] the API refused the key (MEDIA_PEXELS_API_KEY)');
      throw unavailable();
    }
    if (answer.status < 200 || answer.status >= 300) {
      console.warn(`[pexels] the API answered ${answer.status}`);
      throw unavailable();
    }
    try {
      return JSON.parse(answer.body.toString('utf8')) as unknown;
    } catch {
      console.warn('[pexels] the API answer is not JSON');
      throw unavailable();
    }
  }

  // An image on Pexels' image host, at most maxBytes, of a type a post takes. The host is checked before the fetch and
  // again on the answer; a redirect is refused, whatever its target.
  async function image(raw: string, maxBytes: number, timeoutMs: number): Promise<{ bytes: Buffer; type: string }> {
    const url = pexelsImageUrl(raw);
    if (!url) throw refused();
    let answer;
    try {
      answer = await fetchImage(url, { timeoutMs, maxBytes, overLimit: 'fail', maxRedirects: 0, accept: IMAGE_ACCEPT });
    } catch (error) {
      if (error instanceof EgressError) {
        if (error.code === 'too_large') throw new DomainError('TOO_LARGE', 413, `Ảnh này lớn hơn ${Math.round(maxBytes / (1024 * 1024))} MB; hãy chọn cỡ nhỏ hơn`);
        if (error.code === 'redirects' || error.code === 'blocked' || error.code === 'invalid_url') throw refused();
        console.warn(`[pexels] the image did not download: ${error.code}`);
        throw unavailable();
      }
      throw error;
    }
    if (new URL(answer.url).hostname !== PEXELS_IMAGE_HOST) throw refused();
    if (answer.status !== 200) {
      console.warn(`[pexels] the image host answered ${answer.status}`);
      throw unavailable();
    }
    const type = photoType(answer.body, answer.contentType, true);
    if (!type) throw new DomainError('UNSUPPORTED_TYPE', 415, 'Pexels không trả về ảnh JPG, PNG hoặc WEBP cho ảnh này');
    return { bytes: answer.body, type };
  }

  // Small copies for the results grid, a few at a time; one that fails is left out (the grid shows the photo's colour).
  async function thumbs(photos: PexelsPhoto[]): Promise<(string | null)[]> {
    const out: (string | null)[] = photos.map(() => null);
    let next = 0;
    const until = Date.now() + THUMBS_DEADLINE_MS;
    const worker = async () => {
      while (next < photos.length && Date.now() < until) {
        const i = next++;
        const src = photos[i]?.src.tiny;
        if (!src) continue;
        try {
          const { bytes, type } = await image(src, THUMB_MAX_BYTES, THUMB_TIMEOUT_MS);
          out[i] = `data:${type};base64,${bytes.toString('base64')}`;
        } catch {
          out[i] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(THUMBS_AT_ONCE, photos.length) }, worker));
    return out;
  }

  return {
    provider: 'pexels',
    budget,
    async search(input) {
      const page = input.page ?? 1;
      const perPage = input.perPage ?? STOCK_PER_PAGE;
      const query: Record<string, string> = { query: input.query, page: String(page), per_page: String(perPage) };
      if (input.orientation) query.orientation = input.orientation;
      if (input.locale) query.locale = input.locale;
      const answer = (await api('/search', query)) as Record<string, unknown> | null;
      const list = Array.isArray(answer?.photos) ? answer.photos : [];
      // A photo whose links are not Pexels' own is left out.
      const photos = list.map(parsePexelsPhoto).filter((p): p is PexelsPhoto => p !== null);
      const small = await thumbs(photos);
      const total = positiveInt(answer?.total_results) ?? 0;
      return {
        photos: photos.map(({ src: _src, ...p }, i) => ({ ...p, thumb: small[i] ?? null })),
        page,
        total,
        more: typeof answer?.next_page === 'string' && answer.next_page !== '',
      };
    },
    async save(runtime, actor, orgId, input) {
      const size = input.size ?? 'large2x';
      const photo = parsePexelsPhoto(await api(`/photos/${input.photoId}`));
      // Its credit could not link back to Pexels, or Pexels gave it under another id.
      if (!photo || photo.id !== input.photoId) throw refused();
      const src = photo.src[size];
      if (!src) throw refused();
      const { bytes, type } = await image(src, MAX_UPLOAD_BYTES, IMAGE_TIMEOUT_MS);
      const file = await storePhoto(options.store, orgId, bytes, type, `pexels-${photo.id}`);
      const credit: StockCredit = { provider: 'pexels', externalId: String(photo.id), photographer: photo.photographer, photographerUrl: photo.photographerUrl, sourceUrl: photo.pageUrl, altText: photo.alt };
      const saved = await runtime.execute<{ fileId: string; duplicate: boolean; credited: boolean }>('social.media.save_stock', { file, credit }, { actor, orgId });
      return { ...saved, filename: file.filename, mime: type, sizeBytes: bytes.byteLength, width: file.imageWidth ?? null, height: file.imageHeight ?? null, altText: photo.alt };
    },
  };
}
