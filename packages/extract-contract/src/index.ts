// Wire contract of crove-extract, the parsing sandbox (plan §7.6, External-tenant gate T12): bytes in, JSON
// out. The sandbox and the worker share these limits and schemas. Everything the sandbox returns is untrusted:
// the worker validates it here with strict schemas (unknown keys, oversized strings and arrays are refused)
// and treats the result as tainted. This package holds no parser, so importing it never pulls one in.
import { z } from 'zod';

export const EXTRACT_KINDS = ['einvoice_xml', 'pdf_text', 'mime'] as const;
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
} as const;

export function maxRequestBytes(kind: ExtractKind): number {
  return kind === 'mime' ? EXTRACT_LIMITS.maxEmailBytes : EXTRACT_LIMITS.maxFileBytes;
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

export const EXTRACT_CLIENT_TIMEOUT_MS = 60_000;

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
