// The tax authority's e-invoice portal, hoadondientu.gdt.gov.vn, as a buyer's lookup client (issue #325, ADR-0036).
// The portal has no published buyer API; these are the internal endpoints its own web app calls, as public open-source
// tools document them (docs/research/tax-portal-invoice-sync.md section 2.1, docs/integrations/tax-portal-sync.md).
// Nobody checked them against the live portal for this code: the first real use is a supervised trial.
//
// Rules this client keeps whatever the portal answers:
// - It talks to one fixed origin (TAX_PORTAL_URL is the operator's, never a tenant's), through the egress guard: one
//   deadline per request, a byte cap, no redirects, no cookies, no compression, and the default origin only on public
//   addresses.
// - It never solves a CAPTCHA: it fetches the image for a person and sends back what the person typed.
// - It never retries a login, and stops at the first rate limit or block page (HTTP 429, 403, or an HTML page served
//   with status 200) instead of retrying past it.
// - Every answer is untrusted input: JSON is parsed with numbers kept as their text, then checked with strict shapes;
//   an error never carries the portal's text, the password, the CAPTCHA answer or the token.
import { EgressError, guardedRequest, type EgressOptions, type EgressResponse, type GuardedRequest } from '@crove/kernel-runtime';
import { parseJsonKeepingNumbers, type PortalAnswer, type PortalCallError, type PortalQuery, type PortalXmlItem } from '@crove/mod-finance';
import { z } from 'zod';

// The portal's API origin. The 2026 redesign serves it under /api on the default port (older tools used port 30000).
export const TAX_PORTAL_DEFAULT_URL = 'https://hoadondientu.gdt.gov.vn/api';

const OFFICIAL_HOST = new URL(TAX_PORTAL_DEFAULT_URL).hostname;

// The portal's API base from configuration: an absolute http(s) URL without user name, password, query or fragment.
export function portalBase(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('the tax portal URL must be http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('the tax portal URL takes no credentials, query or fragment');
  return url;
}

// The real portal, by its parsed host name (a look-alike such as hoadondientu.gdt.gov.vn.example is not it).
export function isOfficialPortal(url: URL): boolean {
  return url.hostname.toLowerCase() === OFFICIAL_HOST;
}

// A test portal (TAX_PORTAL_URL other than the real one) only on a deployment that serves itself locally: the client's
// real portal password goes to whatever address is set, so a public deployment may not point it elsewhere.
export function testPortalAllowed(portalUrl: string, publicUrl: string): boolean {
  const portal = portalBase(portalUrl);
  if (isOfficialPortal(portal)) return portal.protocol === 'https:';
  const host = new URL(publicUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.test');
}

export class TaxPortalError extends Error {
  readonly kind: PortalCallError;
  constructor(kind: PortalCallError) {
    super(`tax portal: ${kind}`);
    this.name = 'TaxPortalError';
    this.kind = kind;
  }
}

export interface TaxPortalClient {
  readonly origin: string;
  // A fresh CAPTCHA: the portal's key for it and its SVG image.
  captcha(): Promise<{ key: string; svg: string }>;
  // The portal's session token for these credentials; throws TaxPortalError WRONG_CAPTCHA, WRONG_PASSWORD,
  // ACCOUNT_LOCKED, RATE_LIMITED, BLOCKED, UNAVAILABLE or BAD_ANSWER.
  login(username: string, password: string, captcha: { key: string; answer: string }): Promise<string>;
  // Every purchase invoice dated in [from, to] (YYYY-MM-DD), one month of the range at a time, every query and page.
  purchaseInvoices(token: string, from: string, to: string): Promise<PortalAnswer[]>;
  // One invoice's signed XML as the portal serves it (a ZIP holding the XML, or the XML itself).
  invoiceXml(token: string, invoice: PortalXmlItem): Promise<Uint8Array>;
}

export interface TaxPortalOptions {
  // The API origin and path prefix; TAX_PORTAL_DEFAULT_URL unless the operator points it at a test portal.
  baseUrl?: string;
  timeoutMs?: number;
  pageSize?: number;
  // Pages read per query and month, and rows read in all, before the list is refused as too large.
  maxPages?: number;
  maxRows?: number;
  // The pause between two requests of one sync, so a sync never bursts at the portal.
  gapMs?: number;
  // Tests: the request function (the egress guard by default).
  request?: (url: string, request: GuardedRequest, options: EgressOptions) => Promise<EgressResponse>;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CAPTCHA_BYTES = 200 * 1024;
const MAX_XML_BYTES = 5 * 1024 * 1024;

// Which list queries a sync runs, in order (PortalQuery in @crove/mod-finance): purchase invoices with a tax authority
// code (ttxly 5), received without a code (6), from cash registers on the main endpoint (8), and the cash register
// endpoint itself.
const QUERIES: ReadonlyArray<{ query: PortalQuery; path: string; filter: string | null }> = [
  { query: 'purchase_5', path: '/query/invoices/purchase', filter: 'ttxly==5' },
  { query: 'purchase_6', path: '/query/invoices/purchase', filter: 'ttxly==6' },
  { query: 'purchase_8', path: '/query/invoices/purchase', filter: 'ttxly==8' },
  { query: 'sco', path: '/sco-query/invoices/purchase', filter: null },
];

const zCaptcha = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), content: z.string().max(MAX_CAPTCHA_BYTES) });
const zToken = z.object({ token: z.string().regex(/^[A-Za-z0-9_.-]{16,8192}$/) });
const zPage = z.object({
  datas: z.array(z.unknown()).max(1000).optional(),
  data: z.array(z.unknown()).max(1000).optional(),
  total: z.union([z.string().regex(/^\d{1,9}$/), z.number().int().nonnegative()]).optional(),
});

// JSON with every number kept as the text the portal sent, so amounts never pass through a float.
export function parsePortalJson(body: Buffer): unknown {
  try {
    return parseJsonKeepingNumbers(body.toString('utf8'));
  } catch {
    throw new TaxPortalError('BAD_ANSWER');
  }
}

// Lower case without diacritics, for reading the class of a refusal (never kept or shown).
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

const isHtml = (r: EgressResponse) => (r.contentType ?? '').toLowerCase().includes('text/html') || /^\s*<(!doctype|html)/i.test(r.body.subarray(0, 64).toString('latin1'));

// The class of a failed answer from an endpoint that needs the session.
function failure(r: EgressResponse): TaxPortalError {
  if (r.status === 429) return new TaxPortalError('RATE_LIMITED');
  if (r.status === 401) return new TaxPortalError('SESSION_EXPIRED');
  if (r.status === 403 || (r.status === 200 && isHtml(r))) return new TaxPortalError('BLOCKED');
  if (r.status >= 500) return new TaxPortalError('UNAVAILABLE');
  return new TaxPortalError('BAD_ANSWER');
}

// dd/mm/yyyy from YYYY-MM-DD.
const vnDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// [from, to] cut at month ends: the portal searches about one month at a time.
export function monthRanges(from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let start = from;
  while (start <= to) {
    const [y, m] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const end = monthEnd < to ? monthEnd : to;
    out.push({ from: start, to: end });
    start = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  return out;
}

export function createTaxPortalClient(options: TaxPortalOptions = {}): TaxPortalClient {
  const base = portalBase(options.baseUrl ?? TAX_PORTAL_DEFAULT_URL);
  // The real portal is told apart by its parsed host name, exactly, never by a prefix of the URL text.
  const official = isOfficialPortal(base);
  if (official && base.protocol !== 'https:') throw new Error('the tax portal is reached over https only');
  const prefix = `${base.origin}${base.pathname.replace(/\/$/, '')}`;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 40;
  const maxRows = options.maxRows ?? 20_000;
  const gapMs = options.gapMs ?? 600;
  const request = options.request ?? guardedRequest;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // The official portal only on public addresses; a test portal the operator configured may be on a private network.
  const egress = (maxBytes: number): EgressOptions => ({ timeoutMs, maxBytes, overLimit: 'fail', anyPort: true, ...(official ? {} : { allowed: () => true }) });

  async function send(path: string, req: GuardedRequest, maxBytes: number): Promise<EgressResponse> {
    try {
      return await request(`${prefix}${path}`, req, egress(maxBytes));
    } catch (error) {
      if (error instanceof EgressError && error.code === 'too_large') throw new TaxPortalError('TOO_LARGE');
      // A refused address, a timeout, DNS or the network: the portal cannot be reached.
      throw new TaxPortalError('UNAVAILABLE');
    }
  }
  const authorized = (token: string): GuardedRequest => ({ method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${token}` } });

  return {
    origin: base.origin,

    async captcha() {
      const r = await send('/captcha', { method: 'GET', headers: { accept: 'application/json' } }, MAX_CAPTCHA_BYTES + 4096);
      if (r.status !== 200 || isHtml(r)) throw failure(r);
      const parsed = zCaptcha.safeParse(parsePortalJson(r.body));
      if (!parsed.success || !/^\s*<svg[\s>]/i.test(parsed.data.content)) throw new TaxPortalError('BAD_ANSWER');
      return { key: parsed.data.key, svg: parsed.data.content };
    },

    async login(username, password, captcha) {
      const body = Buffer.from(JSON.stringify({ username, password, cvalue: captcha.answer, ckey: captcha.key }), 'utf8');
      const r = await send('/security-taxpayer/authenticate', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body }, 64 * 1024);
      if (r.status === 200 && !isHtml(r)) {
        const parsed = zToken.safeParse(parsePortalJson(r.body));
        if (!parsed.success) throw new TaxPortalError('BAD_ANSWER');
        return parsed.data.token;
      }
      if ((r.status === 400 || r.status === 401) && !isHtml(r)) {
        // The refusal's words decide its class; they are read here and dropped.
        const words = fold(r.body.subarray(0, 4096).toString('utf8'));
        // A refusal that names the account or the password is a wrong password even when it also asks for a new CAPTCHA:
        // Crove's guard counts it then (fails closed).
        if (/bi khoa|tam khoa|locked/.test(words)) throw new TaxPortalError('ACCOUNT_LOCKED');
        if (/mat khau|password|ten dang nhap|tai khoan|username/.test(words)) throw new TaxPortalError('WRONG_PASSWORD');
        if (/captcha|ma xac (nhan|thuc)|ma kiem tra|ma bao ve/.test(words)) throw new TaxPortalError('WRONG_CAPTCHA');
        throw new TaxPortalError('WRONG_PASSWORD');
      }
      throw failure(r);
    },

    async purchaseInvoices(token, from, to) {
      const answers: PortalAnswer[] = QUERIES.map((q) => ({ query: q.query, rows: [] }));
      let rows = 0;
      let first = true;
      for (const range of monthRanges(from, to)) {
        for (const [i, q] of QUERIES.entries()) {
          const search = [`tdlap=ge=${vnDate(range.from)}T00:00:00`, `tdlap=le=${vnDate(range.to)}T23:59:59`, ...(q.filter ? [q.filter] : [])].join(';');
          for (let page = 0; ; page++) {
            if (page >= maxPages) throw new TaxPortalError('TOO_LARGE');
            if (!first) await sleep(gapMs);
            first = false;
            const r = await send(`${q.path}?sort=tdlap:desc,khmshdon:asc,shdon:desc&size=${pageSize}&page=${page}&search=${search}`, authorized(token), MAX_JSON_BYTES);
            if (r.status !== 200 || isHtml(r)) throw failure(r);
            const parsed = zPage.safeParse(parsePortalJson(r.body));
            if (!parsed.success) throw new TaxPortalError('BAD_ANSWER');
            const got = parsed.data.datas ?? parsed.data.data ?? [];
            rows += got.length;
            if (rows > maxRows) throw new TaxPortalError('TOO_LARGE');
            (answers[i] as PortalAnswer).rows.push(...got);
            const total = parsed.data.total === undefined ? null : Number(parsed.data.total);
            if (got.length < pageSize || (total !== null && (page + 1) * pageSize >= total)) break;
          }
        }
      }
      return answers;
    },

    async invoiceXml(token, invoice) {
      const params = new URLSearchParams({ nbmst: invoice.sellerTaxCode, khhdon: invoice.series, shdon: invoice.number, khmshdon: invoice.template ?? '1' });
      await sleep(gapMs);
      const r = await send(`/query/invoices/export-xml?${params.toString()}`, { method: 'GET', headers: { accept: '*/*', authorization: `Bearer ${token}` } }, MAX_XML_BYTES);
      // The portal answers 500 (or 404) for an invoice it has no XML for: that invoice's failure, not an outage.
      if ((r.status === 500 || r.status === 404) && !isHtml(r)) throw new TaxPortalError('BAD_ANSWER');
      if (r.status !== 200 || isHtml(r)) throw failure(r);
      return new Uint8Array(r.body);
    },
  };
}
