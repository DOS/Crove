// HTTP face of crove-extract. One endpoint: POST /extract?kind=<einvoice_xml|pdf_text|mime> with the raw bytes
// as the body; the answer is the JSON of @crove/extract-contract. Only the worker calls it, over an internal
// network; the service holds no credentials, so it has nothing to authenticate with and nothing to leak.
import { Hono, type Context } from 'hono';
import {
  EXTRACT_ERROR_STATUS,
  maxRequestBytes,
  zExtractKind,
  type ExtractKind,
  type ExtractResponse,
} from '@crove/extract-contract';
import { failure } from './parse.ts';
import { DEFAULT_SANDBOX, runSandboxed, type SandboxOptions } from './sandbox.ts';

export type Runner = (kind: ExtractKind, bytes: Uint8Array) => Promise<ExtractResponse>;

export interface ExtractAppOptions {
  sandbox?: SandboxOptions;
  // Parser processes at a time; each may use up to sandbox.maxHeapMb (1 vCPU, 1 GiB: one at a time).
  concurrency?: number;
  // Requests that may wait for a free slot; beyond that the answer is 503 busy and the worker retries.
  maxQueue?: number;
  // Replaces the parser process (tests of the HTTP layer only).
  run?: Runner;
}

function answer(c: Context, result: ExtractResponse) {
  return c.json(result, result.ok ? 200 : EXTRACT_ERROR_STATUS[result.code]);
}

// Reads at most `max` bytes; null when the body is larger. A declared length over the limit is refused before
// anything is read, and a body without a length is cut off as soon as it passes the limit.
async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function createLimiter(concurrency: number, maxQueue: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T | null> => {
    if (active >= concurrency) {
      if (waiting.length >= maxQueue) return null;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function createExtractApp(options: ExtractAppOptions = {}) {
  const sandbox = options.sandbox ?? DEFAULT_SANDBOX;
  const run: Runner = options.run ?? ((kind, bytes) => runSandboxed(kind, bytes, sandbox));
  const limit = createLimiter(options.concurrency ?? 1, options.maxQueue ?? 8);
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/extract', async (c) => {
    const kind = zExtractKind.safeParse(c.req.query('kind'));
    if (!kind.success) return answer(c, failure('bad_request', 'kind must be one of einvoice_xml, pdf_text, mime'));
    const max = maxRequestBytes(kind.data);
    const bytes = await readBody(c.req.raw, max);
    if (!bytes) return answer(c, failure('too_large', `input is larger than ${max} bytes`));
    if (bytes.byteLength === 0) return answer(c, failure('invalid', 'Tệp rỗng'));
    const result = await limit(() => run(kind.data, bytes));
    return answer(c, result ?? failure('busy', 'all parser slots are busy'));
  });

  app.notFound((c) => answer(c, failure('bad_request', 'not found')));
  app.onError((error, c) => {
    console.error('[extract]', error instanceof Error ? error.message : error);
    return answer(c, failure('internal', 'internal error'));
  });
  return app;
}
