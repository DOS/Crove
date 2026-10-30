// Error mapping against a local fake endpoint, through the real AI SDK client, so the statuses the live
// conformance suite cannot trigger on demand (429, 5xx) are covered in every CI run.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateText, NoObjectGeneratedError } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiDocumentFailure, chatModel, classifyAiError, type AiErrorInfo } from '../src/index.ts';

let server: Server;
let baseURL: string;
const hits = new Map<string, number>();

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // The model name picks the answer: "status-429" answers 429, "slow" never answers in time.
      const model = (req.headers['x-test-model'] as string | undefined) ?? '';
      hits.set(model, (hits.get(model) ?? 0) + 1);
      if (model === 'slow') return void setTimeout(() => res.end(), 2_000);
      const status = Number(model.replace('status-', ''));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (status === 429) Object.assign(headers, { 'retry-after-ms': '1' });
      res.writeHead(status, headers).end(JSON.stringify({ error: { message: `fake ${status}`, type: 'test' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function failure(model: string, options: { maxRetries?: number; timeoutMs?: number; url?: string } = {}): Promise<AiErrorInfo> {
  return classifyAiError(await thrown(model, options));
}

async function thrown(model: string, options: { maxRetries?: number; timeoutMs?: number; url?: string } = {}): Promise<unknown> {
  try {
    await generateText({
      model: chatModel({ baseURL: options.url ?? baseURL, apiKey: 'test-key', model }),
      prompt: 'ping',
      headers: { 'x-test-model': model },
      maxRetries: options.maxRetries ?? 0,
      ...(options.timeoutMs ? { abortSignal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('AI error mapping', () => {
  it.each([
    ['status-401', { kind: 'auth', retryable: false, status: 401 }],
    ['status-403', { kind: 'auth', retryable: false, status: 403 }],
    ['status-429', { kind: 'rate_limit', retryable: true, status: 429, retryAfterMs: 1 }],
    ['status-500', { kind: 'unavailable', retryable: true, status: 500 }],
    ['status-503', { kind: 'unavailable', retryable: true, status: 503 }],
    ['status-501', { kind: 'invalid_request', retryable: false, status: 501 }],
    ['status-400', { kind: 'invalid_request', retryable: false, status: 400 }],
    ['status-404', { kind: 'invalid_request', retryable: false, status: 404 }],
  ] as const)('maps %s', async (model, want) => {
    expect(await failure(model)).toMatchObject(want);
  });

  it('looks through the SDK retries to the last answer', async () => {
    hits.delete('status-429');
    expect(await failure('status-429', { maxRetries: 2 })).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(hits.get('status-429')).toBe(3);
  });

  it('does not retry an auth failure', async () => {
    hits.delete('status-401');
    expect(await failure('status-401', { maxRetries: 2 })).toMatchObject({ kind: 'auth' });
    expect(hits.get('status-401')).toBe(1);
  });

  it('maps a timeout and an unreachable endpoint', async () => {
    expect(await failure('slow', { timeoutMs: 100 })).toMatchObject({ kind: 'timeout', retryable: true, status: null });
    expect(await failure('status-200', { url: 'http://127.0.0.1:1/v1' })).toMatchObject({ kind: 'network', retryable: true, status: null });
  });

  it('maps anything else to unknown', () => {
    expect(classifyAiError(new Error('boom'))).toEqual({ kind: 'unknown', retryable: false, status: null, retryAfterMs: null });
  });

  it('tells a document the AI refuses from a reading service that fails (#1998)', async () => {
    // The document's failure: the endpoint rejects the request itself, or the answer never fits the schema.
    expect(aiDocumentFailure(await thrown('status-400'))).toBe(true);
    expect(aiDocumentFailure(await thrown('status-404'))).toBe(true);
    const unfit = new NoObjectGeneratedError({
      text: '{}',
      response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never,
      finishReason: 'stop',
    });
    expect(aiDocumentFailure(unfit)).toBe(true);
    // The service's: auth, rate limit, an endpoint down, network, timeout, and errors that are not the AI's.
    expect(aiDocumentFailure(await thrown('status-401'))).toBe(false);
    expect(aiDocumentFailure(await thrown('status-429', { maxRetries: 1 }))).toBe(false);
    expect(aiDocumentFailure(await thrown('status-503'))).toBe(false);
    expect(aiDocumentFailure(await thrown('status-200', { url: 'http://127.0.0.1:1/v1' }))).toBe(false);
    expect(aiDocumentFailure(new Error('sandbox down'))).toBe(false);
    expect(aiDocumentFailure(undefined)).toBe(false);
  });
});
