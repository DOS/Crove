// The worker's crove-extract client: every answer is untrusted, so anything malformed, oversized, for the wrong
// kind or late is refused with ExtractServiceError (retried by the job); file-caused failures come back typed.
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMITS, ExtractServiceError, createExtractClient, type ExtractClient } from '../src/index.ts';

const invoice = {
  source: 'einvoice_xml',
  invoiceType: null,
  template: '1',
  series: 'C26TAB',
  number: '1234',
  issueDate: '2026-09-15',
  currency: 'VND',
  exchangeRate: null,
  paymentMethod: null,
  seller: { name: 'Seller', taxCode: '0102030406', address: null, email: null, phone: null },
  buyer: { name: 'Buyer', taxCode: null, address: null, email: null, phone: null },
  lines: [
    { lineNo: 1, nature: 'goods', code: null, description: 'x', unit: null, quantity: '1', unitPrice: '100', amount: '100', vatRate: '10%' },
  ],
  taxBreakdown: [],
  subtotal: '100',
  vatTotal: '10',
  total: '110',
  totalInWords: null,
  taxAuthorityCode: null,
  hasSignature: false,
};

type Seen = { url: string; init: RequestInit | undefined };

function clientAnswering(body: unknown, status = 200, options: { maxResponseBytes?: number; headers?: Record<string, string> } = {}) {
  const seen: Seen[] = [];
  const client = createExtractClient({
    url: 'http://crove-extract:8090',
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    fetch: async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...options.headers },
      });
    },
  });
  return { client, seen };
}

const bytes = new TextEncoder().encode('<HDon/>');

async function serviceError(client: ExtractClient, kind: 'einvoice_xml' | 'pdf_text' | 'mime' = 'einvoice_xml') {
  const error = await client.extract(kind, bytes).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExtractServiceError);
  return error as ExtractServiceError;
}

describe('crove-extract client', () => {
  it('posts the raw bytes for one kind, refuses redirects and returns a validated result', async () => {
    const { client, seen } = clientAnswering({ ok: true, kind: 'einvoice_xml', invoice });
    const result = await client.extract('einvoice_xml', bytes);
    expect(result).toMatchObject({ ok: true, invoice: { total: '110' } });
    expect(seen[0]?.url).toBe('http://crove-extract:8090/extract?kind=einvoice_xml');
    expect(seen[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Uint8Array(seen[0]?.init?.body as ArrayBuffer)).toEqual(bytes);
  });

  it('accepts the invoice a replacement or an adjustment corrects, and refuses a malformed one (#916)', async () => {
    const related = { kind: 'replacement', template: '1', series: 'C26TAB', number: '1200', issueDate: '2026-09-01', note: null };
    const { client } = clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, related } });
    expect(await client.extract('einvoice_xml', bytes)).toMatchObject({ ok: true, invoice: { related } });
    for (const bad of [{ ...related, kind: 'cancel' }, { ...related, extra: 'x' }, { ...related, number: 1200 }]) {
      const answer = clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, related: bad } });
      expect((await serviceError(answer.client)).reason).toBe('malformed');
    }
  });

  it('returns failures caused by the file as typed results', async () => {
    const { client } = clientAnswering({ ok: false, code: 'invalid', message: 'XML chứa DOCTYPE/ENTITY, bị từ chối' }, 422);
    expect(await client.extract('einvoice_xml', bytes)).toEqual({ ok: false, code: 'invalid', message: 'XML chứa DOCTYPE/ENTITY, bị từ chối' });
    const { client: timeout } = clientAnswering({ ok: false, code: 'timeout', message: 'slow' }, 422);
    expect(await timeout.extract('pdf_text', bytes)).toMatchObject({ code: 'timeout' });
  });

  it('refuses a file over the limit without calling the service', async () => {
    const { client, seen } = clientAnswering({ ok: true, kind: 'pdf_text', text: '', pages: 0 });
    expect(await client.extract('pdf_text', new Uint8Array(EXTRACT_LIMITS.maxFileBytes + 1))).toMatchObject({ ok: false, code: 'too_large' });
    expect(seen).toHaveLength(0);
  });

  it('throws on service failures, so the job is retried', async () => {
    expect((await serviceError(clientAnswering({ ok: false, code: 'busy', message: 'busy' }, 503).client)).reason).toBe('unavailable');
    expect((await serviceError(clientAnswering({ ok: false, code: 'internal', message: 'x' }, 500).client)).reason).toBe('unavailable');
    const unreachable = createExtractClient({
      url: 'http://crove-extract:8090',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect((await serviceError(unreachable)).reason).toBe('unreachable');
  });

  it('rejects malformed answers: not JSON, unknown keys, wrong types, oversized fields, wrong kind or status', async () => {
    const malformed = [
      clientAnswering('<html>proxy error</html>', 502),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, injected: 'x' } }),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, total: 110 } }),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, total: '1e9' } }),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, number: 'x'.repeat(EXTRACT_LIMITS.maxStringChars + 1) } }),
      clientAnswering({ ok: true, kind: 'pdf_text', text: 'x', pages: 1 }),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice }, 201),
      clientAnswering({ ok: false, code: 'invalid', message: 'x' }, 200),
      clientAnswering({ ok: false, code: 'invalid', message: 'x'.repeat(EXTRACT_LIMITS.maxErrorChars + 1) }, 422),
    ];
    for (const { client } of malformed) expect((await serviceError(client)).reason).toBe('malformed');
    const badAttachment = clientAnswering({
      ok: true,
      kind: 'mime',
      email: { messageId: null, from: null, subject: null, deliveredTo: null, to: [], attachments: [{ filename: 'a', content: 'not base64!' }] },
    });
    expect((await serviceError(badAttachment.client, 'mime')).reason).toBe('malformed');
  });

  it('rejects an answer over the size limit, declared or streamed', async () => {
    const declared = clientAnswering({ ok: true, kind: 'einvoice_xml', invoice }, 200, { maxResponseBytes: 64 });
    expect((await serviceError(declared.client)).reason).toBe('response_too_large');
    const streamed = createExtractClient({
      url: 'http://crove-extract:8090',
      maxResponseBytes: 1024,
      fetch: async () => {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            if (sent > 1000) controller.close();
            else controller.enqueue(new Uint8Array(512).fill(0x20));
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    expect((await serviceError(streamed)).reason).toBe('response_too_large');
  });

  it('gives up at the time limit', async () => {
    const hanging = createExtractClient({
      url: 'http://crove-extract:8090',
      timeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    const started = Date.now();
    const error = await serviceError(hanging);
    expect(error.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('accepts only http(s) URLs', () => {
    expect(() => createExtractClient({ url: 'file:///etc/passwd' })).toThrow(/http/);
  });
});

// #2119: the worker runs several extract jobs at once; the client never has more calls in flight than its slots.
describe('crove-extract client concurrency (#2119)', () => {
  function slowClient(concurrency: number | undefined) {
    const state = { inFlight: 0, max: 0, calls: 0 };
    const client = createExtractClient({
      url: 'http://crove-extract:8090',
      ...(concurrency === undefined ? {} : { concurrency }),
      fetch: async () => {
        state.calls += 1;
        state.inFlight += 1;
        state.max = Math.max(state.max, state.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        state.inFlight -= 1;
        return new Response(JSON.stringify({ ok: false, code: 'invalid', message: 'x' }), { status: 422, headers: { 'content-type': 'application/json' } });
      },
    });
    return { client, state };
  }

  it.each([
    [undefined, 1],
    [1, 1],
    [3, 3],
    [8, 8],
  ])('keeps at most its slots in flight and uses them all (concurrency %s)', async (concurrency, slots) => {
    const { client, state } = slowClient(concurrency);
    expect(client.concurrency).toBe(slots);
    const results = await Promise.all(Array.from({ length: slots * 3 + 1 }, () => client.extract('einvoice_xml', bytes)));
    expect(results).toHaveLength(slots * 3 + 1);
    expect(state.calls).toBe(slots * 3 + 1);
    expect(state.max).toBe(slots);
  });

  it('gives a slot back after a failed call, so one failure cannot stall the rest', async () => {
    let n = 0;
    const client = createExtractClient({
      url: 'http://crove-extract:8090',
      concurrency: 1,
      fetch: async () => {
        n += 1;
        if (n === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ ok: false, code: 'invalid', message: 'x' }), { status: 422, headers: { 'content-type': 'application/json' } });
      },
    });
    const [first, second] = await Promise.allSettled([client.extract('einvoice_xml', bytes), client.extract('einvoice_xml', bytes)]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });

  it('refuses a concurrency that is not a whole number of at least 1', () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) expect(() => createExtractClient({ url: 'http://crove-extract:8090', concurrency })).toThrow(/concurrency/);
  });
});
