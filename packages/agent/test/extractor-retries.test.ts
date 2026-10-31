// SPDX-License-Identifier: AGPL-3.0-only
// A document whose AI call keeps failing is sent at most 1 + maxRetries times (#2119), against a local fake endpoint
// through the real AI SDK client, so a failing document costs a known number of provider calls and its slot is not
// held for a retry storm.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvoiceExtractor } from '../src/index.ts';

let server: Server;
let baseURL: string;
let hits = 0;
const bodies: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits += 1;
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      // 429 and 5xx are what the SDK retries; retry-after-ms keeps the backoff at a millisecond.
      res
        .writeHead(Number((JSON.parse(bodies.at(-1) ?? '{}') as { model?: string }).model?.replace('status-', '')), { 'content-type': 'application/json', 'retry-after-ms': '1' })
        .end(JSON.stringify({ error: { message: 'fake failure', type: 'test' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  hits = 0;
  bodies.length = 0;
});

const extractor = (model: string, maxRetries?: number) => new InvoiceExtractor({ baseURL, apiKey: 'test-key', model, ...(maxRetries === undefined ? {} : { maxRetries }) });

describe('invoice reading retries (#2119)', () => {
  it.each([
    [0, 1],
    [1, 2],
    [3, 4],
  ])('sends a failing text call at most 1 + maxRetries times (maxRetries %i: %i calls)', async (maxRetries, calls) => {
    await expect(extractor('status-500', maxRetries).fromText('hóa đơn')).rejects.toThrow();
    expect(hits).toBe(calls);
  });

  it('bounds a photo the same way, and a rate limit too', async () => {
    await expect(extractor('status-429', 1).fromImage(new Uint8Array([1, 2, 3]), 'image/png')).rejects.toThrow();
    expect(hits).toBe(2);
  });

  it('does not repeat a call the provider refuses as wrong (4xx other than 408, 409, 429)', async () => {
    await expect(extractor('status-400', 3).fromText('hóa đơn')).rejects.toThrow();
    expect(hits).toBe(1);
  });

  it('keeps the SDK default of 2 retries when the setting is absent', async () => {
    await expect(extractor('status-500').fromText('hóa đơn')).rejects.toThrow();
    expect(hits).toBe(3);
  });
});
