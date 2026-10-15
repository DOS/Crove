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
  // Body read limits once the slot is free (EXTRACT_TIMING by default; tests shorten them).
  bodyIdleTimeoutMs?: number;
  bodyTimeoutMs?: number;
  // Replaces the parser process (tests of the HTTP layer only).
  run?: Runner;
}

function answer(c: Context, result: ExtractResponse) {
  return c.json(result, result.ok ? 200 : EXTRACT_ERROR_STATUS[result.code]);
}

// Why a body read ended without a body: larger than allowed, the caller went away, nothing arrived for the idle
// limit, or the whole read took longer than its deadline.
export type BodyFailure = 'too_large' | 'aborted' | 'idle' | 'deadline';

export interface BodyLimits {
  maxBytes: number;
  idleTimeoutMs: number;
  timeoutMs: number;
}

// Reads at most `maxBytes` bytes. A declared length over the limit is refused before anything is read, and a body
// without a length is cut off as soon as it passes the limit. A caller that stops sending holds its slot only
// until the first of: it disconnects (the abort ends the read even if the body stream itself never errors),
// nothing arrives for `idleTimeoutMs`, or the read has taken `timeoutMs` in all.
export async function readBody(request: Request, limits: BodyLimits, signal: AbortSignal): Promise<Uint8Array | BodyFailure> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limits.maxBytes) return 'too_large';
  if (signal.aborted) return 'aborted';
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  let ended: 'idle' | 'deadline' | null = null;
  const end = (reason: 'idle' | 'deadline') => {
    ended ??= reason;
    void reader.cancel().catch(() => {});
  };
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  const deadline = setTimeout(() => end('deadline'), limits.timeoutMs);
  let idle = setTimeout(() => end('idle'), limits.idleTimeoutMs);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // A cancelled read ends like a finished body; what arrived is incomplete and never parsed.
      if (ended) return ended;
      if (signal.aborted) return 'aborted';
      if (done) break;
      clearTimeout(idle);
      idle = setTimeout(() => end('idle'), limits.idleTimeoutMs);
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await reader.cancel().catch(() => {});
        return 'too_large';
      }
      chunks.push(value);
    }
  } catch (error) {
    if (ended) return ended;
    if (signal.aborted) return 'aborted';
    throw error;
  } finally {
    clearTimeout(idle);
    clearTimeout(deadline);
    signal.removeEventListener('abort', onAbort);
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
  const idleTimeoutMs = options.bodyIdleTimeoutMs ?? EXTRACT_TIMING.bodyIdleTimeoutMs;
  const timeoutMs = options.bodyTimeoutMs ?? EXTRACT_TIMING.bodyTimeoutMs;
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
      const bytes = await readBody(c.req.raw, { maxBytes: max, idleTimeoutMs, timeoutMs }, signal);
      if (bytes === 'aborted') return 'aborted' as const;
      if (bytes === 'too_large') return tooLarge;
      // A stalled or slow body is a failure of the call, not of the file: the worker retries it.
      if (bytes === 'idle') return failure('bad_request', `request body sent nothing for ${idleTimeoutMs} ms`);
      if (bytes === 'deadline') return failure('bad_request', `request body took longer than ${timeoutMs} ms`);
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
