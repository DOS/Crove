// HTTP face of crove-extract. One endpoint: POST /extract?kind=<einvoice_xml|pdf_text|mime> with the raw bytes
// as the body; the answer is the JSON of @crove/extract-contract. Only the worker calls it, over an internal
// network; the service holds no credentials, so it has nothing to authenticate with and nothing to leak.
import { Hono, type Context } from 'hono';
import {
  EXTRACT_ERROR_STATUS,
  EXTRACT_TIMING,
  maxRequestBytes,
  zExtractKind,
  type ExtractKind,
  type ExtractResponse,
} from '@crove/extract-contract';
import { failure } from './parse.ts';
import { DEFAULT_SANDBOX, runSandboxed, type SandboxOptions } from './sandbox.ts';

// `signal` aborts when the caller disconnects; the parser process is then killed.
export type Runner = (kind: ExtractKind, bytes: Uint8Array, signal: AbortSignal) => Promise<ExtractResponse>;

export interface ExtractAppOptions {
  sandbox?: SandboxOptions;
  // Parser processes at a time; each may use up to sandbox.maxHeapMb (1 vCPU, 1 GiB: one at a time).
  concurrency?: number;
  // Requests that may wait for a free slot; beyond that the answer is 503 busy and the worker retries. A waiting
  // request holds no body yet (it is read once the slot is free), and leaves the queue when its caller gives up.
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

// At most `concurrency` tasks run; up to `maxQueue` wait in order. A finished task hands its slot straight to the
// next waiter, so a new request can never slip in between. A waiter whose caller gives up leaves the queue.
export function createLimiter(concurrency: number, maxQueue: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async <T>(signal: AbortSignal, task: () => Promise<T>): Promise<T | 'busy' | 'aborted'> => {
    if (active < concurrency) {
      active += 1;
    } else {
      if (waiting.length >= maxQueue || signal.aborted) return signal.aborted ? 'aborted' : 'busy';
      const granted = await new Promise<boolean>((resolve) => {
        const resume = () => {
          signal.removeEventListener('abort', leave);
          resolve(true);
        };
        const leave = () => {
          const index = waiting.indexOf(resume);
          if (index >= 0) waiting.splice(index, 1);
          resolve(false);
        };
        waiting.push(resume);
        signal.addEventListener('abort', leave, { once: true });
      });
      if (!granted) return 'aborted';
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export function createExtractApp(options: ExtractAppOptions = {}) {
  const sandbox = options.sandbox ?? DEFAULT_SANDBOX;
  const run: Runner = options.run ?? ((kind, bytes, signal) => runSandboxed(kind, bytes, sandbox, signal));
  const limit = createLimiter(options.concurrency ?? EXTRACT_TIMING.concurrency, options.maxQueue ?? EXTRACT_TIMING.maxQueue);
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/extract', async (c) => {
    const kind = zExtractKind.safeParse(c.req.query('kind'));
    if (!kind.success) return answer(c, failure('bad_request', 'kind must be one of einvoice_xml, pdf_text, mime'));
    const max = maxRequestBytes(kind.data);
    const tooLarge = failure('too_large', `input is larger than ${max} bytes`);
    const declared = Number(c.req.header('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > max) return answer(c, tooLarge);
    // The body is read only once a slot is free, so waiting requests hold no bytes in memory.
    const signal = c.req.raw.signal;
    const result = await limit(signal, async () => {
      const bytes = await readBody(c.req.raw, max);
      if (!bytes) return tooLarge;
      if (bytes.byteLength === 0) return failure('invalid', 'Tệp rỗng');
      return run(kind.data, bytes, signal);
    });
    if (result === 'busy') return answer(c, failure('busy', 'all parser slots are busy'));
    // Nobody reads this answer; the caller has gone.
    if (result === 'aborted') return answer(c, failure('internal', 'caller went away'));
    return answer(c, result);
  });

  app.notFound((c) => answer(c, failure('bad_request', 'not found')));
  app.onError((error, c) => {
    console.error('[extract]', error instanceof Error ? error.message : error);
    return answer(c, failure('internal', 'internal error'));
  });
  return app;
}
