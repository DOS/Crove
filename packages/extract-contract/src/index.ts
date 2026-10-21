// Wire contract of crove-extract, the parsing sandbox (plan §7.6, External-tenant gate T12): bytes in, JSON
// out. The sandbox and the worker share these limits and schemas. Everything the sandbox returns is untrusted:
// the worker validates it here with strict schemas (unknown keys, oversized strings and arrays are refused)
// and treats the result as tainted. This package holds no parser, so importing it never pulls one in.
import { z } from 'zod';

// zip: a ZIP archive opened in the sandbox (bulk intake, issue #314); the entries come back as bytes and the worker
// files each one as a document of its own.
// portal_invoice_list: the purchase-invoice list exported from the tax authority's e-invoice portal as .xlsx (#465);
// the rows come back read and normalized, and the worker checks them again before they are stored.
// feed: a blog's RSS or Atom feed (#708); its newest items come back read and capped.
export const EXTRACT_KINDS = ['einvoice_xml', 'pdf_text', 'mime', 'zip', 'portal_invoice_list', 'dsn', 'html_meta', 'feed'] as const;
export type ExtractKind = (typeof EXTRACT_KINDS)[number];
export const zExtractKind = z.enum(EXTRACT_KINDS);

const MiB = 1024 * 1024;

export const EXTRACT_LIMITS = {
  // Files (e-invoice XML, PDF): the upload cap; the plan allows the worker to send at most 25 MB.
  maxFileBytes: 25 * MiB,
  // A raw inbound email: the API's cap on POST /api/inbound/email.
  maxEmailBytes: 40 * MiB,
  // Base64 grows an email by a third; anything bigger than this is not a valid answer.
  maxResponseBytes: 64 * MiB,
  // Text taken from a PDF; the AI prompt uses far less.
  maxTextChars: 200_000,
  maxStringChars: 2000,
  maxInvoiceLines: 10_000,
  maxTaxRows: 100,
  maxRecipients: 100,
  maxAttachments: 20,
  maxErrorChars: 500,
  maxPages: 100_000,
  // A ZIP archive (bulk intake, #314): at most this many entries (directories included) and this many bytes once
  // every entry is decompressed. Base64 grows the entries by a third, which still fits maxResponseBytes.
  maxArchiveEntries: 500,
  maxArchiveTotalBytes: 40 * MiB,
  // The tax portal's invoice list (#465): an .xlsx of at most this size, with at most this many invoice rows. The
  // portal searches about a month at a time, so a month of a small company's purchases is far below either.
  maxPortalListBytes: 10 * MiB,
  maxPortalListRows: 20_000,
  // A bounce report (DSN, #539): at most this many recipients are read.
  maxDsnRecipients: 20,
  // A web page for a link preview (#641): the worker sends at most its first bytes, enough for the head.
  maxHtmlBytes: 512 * 1024,
  maxPageTitleChars: 300,
  maxPageDescriptionChars: 1000,
  maxPageSiteChars: 200,
  // The page's main text (#779), for an AI draft written from it.
  maxPageTextChars: 4000,
  // A blog's feed (#708): at most this many bytes, of which the newest items come back.
  maxFeedBytes: 1024 * 1024,
  maxFeedItems: 50,
  maxFeedTitleChars: 300,
  maxFeedSummaryChars: 1000,
  // Rows of the sheet that were not read as invoices (a totals row, a row without a number), reported by number.
  maxPortalListSkipped: 1000,
} as const;

// Why the sandbox did not return an entry of an archive. The whole archive is refused instead (as invalid) when an
// entry name escapes the archive (an absolute path, a drive letter or a .. segment), entries overlap, it is ZIP64 or
// split, or it holds more entries or decompressed bytes than allowed.
export const ARCHIVE_REJECTIONS = ['encrypted', 'unsupported_method', 'nested_archive', 'too_large', 'corrupt'] as const;
export type ArchiveRejection = (typeof ARCHIVE_REJECTIONS)[number];

export function maxRequestBytes(kind: ExtractKind): number {
  if (kind === 'mime' || kind === 'dsn') return EXTRACT_LIMITS.maxEmailBytes;
  if (kind === 'portal_invoice_list') return EXTRACT_LIMITS.maxPortalListBytes;
  if (kind === 'html_meta') return EXTRACT_LIMITS.maxHtmlBytes;
  if (kind === 'feed') return EXTRACT_LIMITS.maxFeedBytes;
  return EXTRACT_LIMITS.maxFileBytes;
}

// too_large, timeout, memory and invalid are caused by the input: retrying gives the same answer.
// bad_request, busy and internal are failures of the call or the service and are worth a retry.
export const EXTRACT_ERROR_CODES = ['too_large', 'timeout', 'memory', 'invalid', 'bad_request', 'busy', 'internal'] as const;
export type ExtractErrorCode = (typeof EXTRACT_ERROR_CODES)[number];
export const INPUT_ERROR_CODES: readonly ExtractErrorCode[] = ['too_large', 'timeout', 'memory', 'invalid'];

const zText = z.string().max(EXTRACT_LIMITS.maxStringChars);
const zMoney = z.string().regex(/^-?\d{1,24}(\.\d{1,8})?$/, 'decimal string');

const zParty = z.strictObject({
  name: zText,
  taxCode: zText.nullable(),
  address: zText.nullable(),
  email: zText.nullable(),
  phone: zText.nullable(),
});

const zLine = z.strictObject({
  lineNo: z.number().int().positive().max(EXTRACT_LIMITS.maxInvoiceLines),
  nature: z.enum(['goods', 'promotion', 'discount', 'note']),
  code: zText.nullable(),
  description: zText,
  unit: zText.nullable(),
  quantity: zMoney.nullable(),
  unitPrice: zMoney.nullable(),
  amount: zMoney,
  vatRate: zText.nullable(),
});

// The shape of ParsedInvoice in @crove/l10n-vn for an e-invoice XML.
export const zExtractedInvoice = z.strictObject({
  source: z.literal('einvoice_xml'),
  invoiceType: zText.nullable(),
  template: zText.nullable(),
  series: zText,
  number: zText,
  issueDate: zText,
  currency: zText,
  exchangeRate: zMoney.nullable(),
  paymentMethod: zText.nullable(),
  seller: zParty,
  buyer: zParty,
  lines: z.array(zLine).max(EXTRACT_LIMITS.maxInvoiceLines),
  taxBreakdown: z
    .array(z.strictObject({ rate: zText, taxableAmount: zMoney, vatAmount: zMoney }))
    .max(EXTRACT_LIMITS.maxTaxRows),
  subtotal: zMoney,
  vatTotal: zMoney,
  total: zMoney,
  totalInWords: zText.nullable(),
  taxAuthorityCode: zText.nullable(),
  hasSignature: z.boolean(),
});
export type ExtractedInvoice = z.infer<typeof zExtractedInvoice>;

// The parts of a MIME message the worker uses. Attachments are the first maxAttachments parts, base64.
export const zExtractedEmail = z.strictObject({
  messageId: zText.nullable(),
  from: zText.nullable(),
  subject: zText.nullable(),
  deliveredTo: zText.nullable(),
  to: z.array(zText).max(EXTRACT_LIMITS.maxRecipients),
  attachments: z.array(z.strictObject({ filename: zText.nullable(), content: z.base64() })).max(EXTRACT_LIMITS.maxAttachments),
});
export type ExtractedEmail = z.infer<typeof zExtractedEmail>;

// A delivery status notification (RFC 3464, #539): each recipient's action and status code, and the Message-ID of the
// bounced mail when the report quotes its headers. No address or diagnostic text leaves the sandbox.
export const DSN_ACTIONS = ['failed', 'delayed', 'delivered', 'relayed', 'expanded'] as const;
// What a web page says about itself (#641): Open Graph first, then Twitter cards, then the HTML title and description.
// Text only, already decoded and trimmed; nothing here is ever sent to a platform.
export const zExtractedPage = z.strictObject({
  title: z.string().min(1).max(EXTRACT_LIMITS.maxPageTitleChars).nullable(),
  description: z.string().min(1).max(EXTRACT_LIMITS.maxPageDescriptionChars).nullable(),
  siteName: z.string().min(1).max(EXTRACT_LIMITS.maxPageSiteChars).nullable(),
  text: z.string().min(1).max(EXTRACT_LIMITS.maxPageTextChars).nullable(),
});
export type ExtractedPage = z.infer<typeof zExtractedPage>;

const zFeedUrl = z.string().regex(/^https?:\/\/\S+$/i).max(2000);
export const zExtractedFeed = z.strictObject({
  title: z.string().min(1).max(EXTRACT_LIMITS.maxFeedTitleChars).nullable(),
  items: z
    .array(
      z.strictObject({
        // The item's guid or id, else its link or title: what tells it from the others.
        key: z.string().min(1).max(EXTRACT_LIMITS.maxStringChars),
        title: z.string().min(1).max(EXTRACT_LIMITS.maxFeedTitleChars).nullable(),
        link: zFeedUrl.nullable(),
        publishedAt: z.iso.datetime().nullable(),
        summary: z.string().min(1).max(EXTRACT_LIMITS.maxFeedSummaryChars).nullable(),
        image: zFeedUrl.nullable(),
      }),
    )
    .max(EXTRACT_LIMITS.maxFeedItems),
});
export type ExtractedFeed = z.infer<typeof zExtractedFeed>;

export const zExtractedDsn = z.strictObject({
  originalMessageId: z
    .string()
    .regex(/^<[^<>\s]{3,253}>$/)
    .nullable(),
  recipients: z
    .array(
      z.strictObject({
        action: z.enum(DSN_ACTIONS),
        status: z
          .string()
          .regex(/^[245]\.\d{1,3}\.\d{1,3}$/)
          .nullable(),
      }),
    )
    .min(1)
    .max(EXTRACT_LIMITS.maxDsnRecipients),
});
export type ExtractedDsn = z.infer<typeof zExtractedDsn>;

// The file entries of a ZIP archive, in central directory order (directories and __MACOSX entries left out). name is
// the path inside the archive with / separators; sizeBytes is the decompressed size the archive declares, checked
// against the bytes for every returned entry. content is null exactly when the entry was rejected.
export const zExtractedArchive = z.strictObject({
  entries: z
    .array(
      z
        .strictObject({
          name: zText,
          sizeBytes: z.number().int().min(0).max(0xffff_ffff),
          content: z.base64().nullable(),
          rejected: z.enum(ARCHIVE_REJECTIONS).nullable(),
        })
        .refine((entry) => (entry.content === null) === (entry.rejected !== null), 'content is null exactly when the entry is rejected'),
    )
    .max(EXTRACT_LIMITS.maxArchiveEntries),
});
export type ExtractedArchive = z.infer<typeof zExtractedArchive>;

// The fields of the portal's invoice list Crove reads (#465). Required: the reader refuses a sheet whose header lacks
// any of them. The others are read when their column is there.
export const PORTAL_LIST_REQUIRED_FIELDS = ['sellerTaxCode', 'series', 'number', 'issueDate'] as const;
export const PORTAL_LIST_FIELDS = [
  ...PORTAL_LIST_REQUIRED_FIELDS,
  'template',
  'sellerName',
  'buyerTaxCode',
  'subtotal',
  'vatAmount',
  'total',
  'currency',
  'status',
  'checkResult',
] as const;
export type PortalListField = (typeof PORTAL_LIST_FIELDS)[number];

// Why a row of the sheet below the header was not read as an invoice.
export const PORTAL_LIST_SKIP_REASONS = ['no_tax_code', 'bad_tax_code', 'no_number', 'no_series', 'bad_date', 'bad_amount', 'too_long'] as const;
export type PortalListSkipReason = (typeof PORTAL_LIST_SKIP_REASONS)[number];

const zLocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zTaxCode = z.string().regex(/^\d{10}(-\d{3})?$|^\d{12}$/);

export const zExtractedPortalList = z.strictObject({
  sheetName: zText,
  // The sheet row holding the column headers, and which header each field was read from.
  headerRow: z.number().int().positive().max(1_048_576),
  columns: z
    .array(z.strictObject({ field: z.enum(PORTAL_LIST_FIELDS), header: zText }))
    .max(PORTAL_LIST_FIELDS.length),
  // What the sheet says about the lookup above the header, when it says it.
  listFrom: zLocalDate.nullable(),
  listTo: zLocalDate.nullable(),
  buyerTaxCode: zTaxCode.nullable(),
  rows: z
    .array(
      z.strictObject({
        rowNo: z.number().int().positive().max(1_048_576),
        sellerTaxCode: zTaxCode,
        sellerName: z.string().max(500),
        // The buyer's tax code on the row (the portal's list names both parties); null when the column is absent.
        buyerTaxCode: zTaxCode.nullable(),
        template: z.string().regex(/^[0-9A-Z]{1,11}$/).nullable(),
        series: z.string().min(1).max(20),
        number: z.string().min(1).max(20),
        issueDate: zLocalDate,
        currency: z.string().regex(/^[A-Z]{3}$/),
        subtotal: zMoney.nullable(),
        vatAmount: zMoney.nullable(),
        total: zMoney.nullable(),
        statusLabel: z.string().max(200).nullable(),
        checkResult: z.string().max(200).nullable(),
      }),
    )
    .max(EXTRACT_LIMITS.maxPortalListRows),
  skipped: z
    .array(z.strictObject({ rowNo: z.number().int().positive().max(1_048_576), reason: z.enum(PORTAL_LIST_SKIP_REASONS) }))
    .max(EXTRACT_LIMITS.maxPortalListSkipped),
  // Every row skipped, including those past maxPortalListSkipped that are not listed.
  skippedCount: z.number().int().min(0).max(1_048_576),
});
export type ExtractedPortalList = z.infer<typeof zExtractedPortalList>;

export const zExtractFailure = z.strictObject({
  ok: z.literal(false),
  code: z.enum(EXTRACT_ERROR_CODES),
  message: z.string().max(EXTRACT_LIMITS.maxErrorChars),
});
export type ExtractFailure = z.infer<typeof zExtractFailure>;

export const zExtractSuccess = z.discriminatedUnion('kind', [
  z.strictObject({ ok: z.literal(true), kind: z.literal('einvoice_xml'), invoice: zExtractedInvoice }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('pdf_text'),
    text: z.string().max(EXTRACT_LIMITS.maxTextChars),
    pages: z.number().int().min(0).max(EXTRACT_LIMITS.maxPages),
  }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('mime'), email: zExtractedEmail }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('zip'), archive: zExtractedArchive }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('portal_invoice_list'), list: zExtractedPortalList }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('dsn'), report: zExtractedDsn }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('html_meta'), page: zExtractedPage }),
  z.strictObject({ ok: z.literal(true), kind: z.literal('feed'), feed: zExtractedFeed }),
]);
export type ExtractSuccess = z.infer<typeof zExtractSuccess>;

export const zExtractResponse = z.union([zExtractSuccess, zExtractFailure]);
export type ExtractResponse = z.infer<typeof zExtractResponse>;
export type ExtractResult<K extends ExtractKind> = Extract<ExtractSuccess, { kind: K }> | ExtractFailure;

// HTTP status the sandbox uses for each failure code.
export const EXTRACT_ERROR_STATUS: Record<ExtractErrorCode, 400 | 413 | 422 | 500 | 503> = {
  too_large: 413,
  timeout: 422,
  memory: 422,
  invalid: 422,
  bad_request: 400,
  busy: 503,
  internal: 500,
};

// The worker's view of the sandbox.
export interface ExtractClient {
  extract<K extends ExtractKind>(kind: K, bytes: Uint8Array): Promise<ExtractResult<K>>;
}

export type ExtractServiceFailure = 'unreachable' | 'timeout' | 'unavailable' | 'response_too_large' | 'malformed';

// The sandbox could not give a trustworthy answer. Callers retry and, after the last attempt, record a failure.
// The message never carries response content.
export class ExtractServiceError extends Error {
  readonly reason: ExtractServiceFailure;
  constructor(reason: ExtractServiceFailure, message: string) {
    super(message);
    this.name = 'ExtractServiceError';
    this.reason = reason;
  }
}

export interface ExtractClientOptions {
  // Base URL of crove-extract, e.g. http://crove-extract:8090
  url: string;
  // The whole call, including waiting for a free parser slot (plan §7.6: 60 s).
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

// Timing shared by the service defaults and the client (plan §7.6: 60 s per call). A request can wait for every
// queued call ahead of it and then run its own; each one holds its slot while its body is read and then while it
// is parsed. The client allows for all of them plus time to send the answer: a queued request is never abandoned
// in the middle of its parse.
export const EXTRACT_TIMING = {
  parseTimeoutMs: 25_000,
  concurrency: 1,
  maxQueue: 1,
  // A body that sends nothing for this long ends with a typed failure and frees its slot.
  bodyIdleTimeoutMs: 2_000,
  // The whole body read, once the slot is free (25 MB or 40 MB over the internal network). A body that keeps
  // sending a byte now and then cannot hold the slot longer than this.
  bodyTimeoutMs: 3_000,
  // Sending the answer over the internal network.
  answerSlackMs: 4_000,
} as const;

export interface ExtractTiming {
  parseTimeoutMs: number;
  concurrency: number;
  maxQueue: number;
  bodyTimeoutMs: number;
  answerSlackMs: number;
}

// Worst case for one call: the calls queued ahead of it, then its own, each reading its body and parsing it.
export function worstCaseCallMs(timing: ExtractTiming): number {
  const slotMs = timing.bodyTimeoutMs + timing.parseTimeoutMs;
  return (Math.ceil(timing.maxQueue / timing.concurrency) + 1) * slotMs + timing.answerSlackMs;
}

export const EXTRACT_CLIENT_TIMEOUT_MS = 60_000;

// A timeout or memory answer can come from load as well as from the file, so a caller may retry it, but at most
// this many times for the same input: a hostile file must not hold the single parser slot again and again.
export const EXTRACT_LIMIT_RETRIES = 1;

async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new ExtractServiceError('response_too_large', 'crove-extract answer is larger than allowed');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ExtractServiceError('response_too_large', 'crove-extract answer is larger than allowed');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    throw new ExtractServiceError('malformed', 'crove-extract answer is not UTF-8');
  }
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function createExtractClient(options: ExtractClientOptions): ExtractClient {
  const base = new URL(options.url);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('EXTRACT_URL must be an http(s) URL');
  const endpoint = new URL('extract', base.href.endsWith('/') ? base.href : `${base.href}/`);
  const timeoutMs = options.timeoutMs ?? EXTRACT_CLIENT_TIMEOUT_MS;
  const maxResponse = options.maxResponseBytes ?? EXTRACT_LIMITS.maxResponseBytes;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async extract<K extends ExtractKind>(kind: K, bytes: Uint8Array): Promise<ExtractResult<K>> {
      if (bytes.byteLength > maxRequestBytes(kind)) {
        return { ok: false, code: 'too_large', message: 'file is larger than crove-extract accepts' };
      }
      const url = new URL(endpoint);
      url.searchParams.set('kind', kind);
      const signal = AbortSignal.timeout(timeoutMs);
      const timedOut = () => new ExtractServiceError('timeout', `crove-extract did not answer within ${timeoutMs} ms`);
      let text: string;
      let status: number;
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          body: requestBody(bytes),
          headers: { 'content-type': 'application/octet-stream' },
          // The sandbox must answer itself; a redirect would point the worker somewhere else.
          redirect: 'error',
          signal,
        });
        status = response.status;
        text = await readCapped(response, maxResponse);
      } catch (error) {
        if (error instanceof ExtractServiceError) throw error;
        if (signal.aborted) throw timedOut();
        throw new ExtractServiceError('unreachable', 'crove-extract is unreachable');
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ExtractServiceError('malformed', `crove-extract answered ${status} without JSON`);
      }
      const parsed = zExtractResponse.safeParse(json);
      if (!parsed.success) throw new ExtractServiceError('malformed', `crove-extract answer failed validation (${status})`);
      const result = parsed.data;
      if (result.ok) {
        if (status !== 200) throw new ExtractServiceError('malformed', `crove-extract answered ${status} with a result`);
        if (result.kind !== kind) throw new ExtractServiceError('malformed', 'crove-extract answered for another kind');
        return result as ExtractResult<K>;
      }
      if (status !== EXTRACT_ERROR_STATUS[result.code]) {
        throw new ExtractServiceError('malformed', `crove-extract answered ${status} for ${result.code}`);
      }
      if (!INPUT_ERROR_CODES.includes(result.code)) throw new ExtractServiceError('unavailable', `crove-extract failed: ${result.code}`);
      return result;
    },
  };
}
