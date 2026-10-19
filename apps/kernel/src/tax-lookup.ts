// The public tax registry lookup behind onboarding by tax code (issue #324): the name and address a tax code (MST) is
// registered under, to prefill a new org. Off unless TAX_CODE_LOOKUP_URL is set, since it sends the tax codes users
// type to that provider; a self-hoster opts in. The URL is a template with {taxCode}, and the answer has the VietQR
// business shape, {"code": "00", "data": {"name": ..., "address": ...}}, which https://api.vietqr.io/v2/business/{taxCode}
// serves. Any other code means the registry does not know the tax code.
//
// Only a normalized tax code reaches the provider (digits and at most one hyphen), with a timeout, no redirect and a
// capped answer. Answers are cached in this process for a day, found and not found alike, so a retry or a second
// lookup of the same client does not call the provider again; failures are not cached. Requests that reach the
// provider are limited per user and per process (RATE_LIMITED, 429): a person adds a few clients a minute, and a
// flood from one account must not get this server's address blocked at the provider.
import { normalizeTaxCode } from '@crove/kernel-contract';
import { DomainError } from '@crove/kernel-runtime';
import { z } from 'zod';
import { RateLimiter } from './rate-limit.ts';

export interface TaxRegistryEntry {
  taxCode: string;
  name: string;
  address: string | null;
}

export interface TaxCodeLookup {
  // `requester` keys the per-user limit (the signed-in user's id). Throws DomainError INVALID_TAX_CODE,
  // TAX_CODE_NOT_FOUND, TAX_LOOKUP_UNAVAILABLE or RATE_LIMITED.
  lookup(taxCode: string, requester: string): Promise<TaxRegistryEntry>;
}

export interface TaxCodeLookupOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  // Codes kept in the cache at most (default 2,000), and for how long (default a day).
  cacheSize?: number;
  cacheMs?: number;
  // Provider requests one user may cause a minute (default 20), and the whole process (default 120).
  perUserPerMinute?: number;
  perMinute?: number;
  now?: () => number;
}

// The longest answer read; a registry entry is well under 2 KiB.
const MAX_ANSWER_BYTES = 64 * 1024;
// The org name's limit (org.create) and the address's (kernel.org.set_address).
const MAX_NAME = 200;
const MAX_ADDRESS = 500;

const answer = z.object({
  code: z.string(),
  data: z.object({ name: z.string(), address: z.string().nullish() }).nullish(),
});

// One line, no control characters, cut to `max` (a registry name or address longer than that is cut, not refused).
function oneLine(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = value.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return text === '' ? null : text.slice(0, max).trim();
}

const notFound = (taxCode: string) => new DomainError('TAX_CODE_NOT_FOUND', 404, `Không tìm thấy mã số thuế ${taxCode} trong dữ liệu tra cứu; hãy nhập tên và địa chỉ`);
const unavailable = () => new DomainError('TAX_LOOKUP_UNAVAILABLE', 503, 'Dịch vụ tra cứu mã số thuế không phản hồi; hãy nhập tên và địa chỉ, hoặc thử lại sau');

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createTaxCodeLookup(urlTemplate: string, options: TaxCodeLookupOptions = {}): TaxCodeLookup {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const cacheSize = options.cacheSize ?? 2000;
  const cacheMs = options.cacheMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  // Logged on failures instead of the URL, which may carry a provider key.
  const providerHost = new URL(urlTemplate.replace('{taxCode}', '0100109106')).host;
  const perUser = new RateLimiter({ perMinute: options.perUserPerMinute ?? 20, maxKeys: 10_000, now });
  const overall = new RateLimiter({ perMinute: options.perMinute ?? 120, now });
  // Insertion order is age order: the first key is the oldest, dropped when the cache is full.
  const cache = new Map<string, { at: number; entry: TaxRegistryEntry | null }>();
  // Concurrent lookups of one code share one request.
  const inFlight = new Map<string, Promise<TaxRegistryEntry | null>>();

  const ask = async (taxCode: string): Promise<TaxRegistryEntry | null> => {
    let text: string;
    try {
      const response = await doFetch(urlTemplate.replace('{taxCode}', encodeURIComponent(taxCode)), {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      text = await readCapped(response);
    } catch (error) {
      console.error(`[tax-lookup] ${providerHost} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw unavailable();
    }
    let parsed: z.infer<typeof answer>;
    try {
      parsed = answer.parse(JSON.parse(text));
    } catch {
      console.error('[tax-lookup] the provider answered in an unexpected shape');
      throw unavailable();
    }
    const name = parsed.code === '00' ? oneLine(parsed.data?.name, MAX_NAME) : null;
    if (!name) return null;
    return { taxCode, name, address: oneLine(parsed.data?.address, MAX_ADDRESS) };
  };

  return {
    async lookup(raw, requester) {
      const taxCode = normalizeTaxCode(raw);
      if (!taxCode) throw new DomainError('INVALID_TAX_CODE', 422, 'Mã số thuế không hợp lệ: 10 chữ số, 10 chữ số kèm 3 chữ số đơn vị phụ thuộc, hoặc 12 chữ số');
      const cached = cache.get(taxCode);
      if (cached && now() - cached.at < cacheMs) {
        if (!cached.entry) throw notFound(taxCode);
        return cached.entry;
      }
      let pending = inFlight.get(taxCode);
      if (!pending) {
        // Only a request that reaches the provider spends from the limits; a cached answer or a shared one does not.
        // The user's own limit first, so a refused user spends nothing from everyone's.
        if (!perUser.take(requester).allowed || !overall.take('all').allowed) {
          throw new DomainError('RATE_LIMITED', 429, 'Bạn tra cứu mã số thuế quá nhiều lần, hãy thử lại sau ít phút');
        }
        pending = ask(taxCode).finally(() => inFlight.delete(taxCode));
        inFlight.set(taxCode, pending);
      }
      const entry = await pending;
      cache.delete(taxCode);
      if (cache.size >= cacheSize) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(taxCode, { at: now(), entry });
      if (!entry) throw notFound(taxCode);
      return entry;
    },
  };
}
