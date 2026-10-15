// crove-extract through a real HTTP server (@hono/node-server), as in the image: a caller that goes away aborts
// c.req.raw.signal, which kills its parse or drops it from the queue, and a caller that holds the single parser
// slot with a body it never finishes sending frees the slot when it disconnects.
import { connect, type AddressInfo, type Socket } from 'node:net';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { zExtractResponse, type ExtractResponse } from '@crove/extract-contract';
import { createExtractApp, type ExtractAppOptions, type Runner } from '../src/server.ts';

const FIXTURE = new TextEncoder().encode('<HDon/>');
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function start(options: ExtractAppOptions): Promise<string> {
  const app = createExtractApp(options);
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => resolve({ server: s, port: info.port }));
  });
  stops.push(
    () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}`;
}

async function post(url: string, body: Uint8Array<ArrayBuffer> = FIXTURE): Promise<{ status: number; result: ExtractResponse }> {
  const response = await fetch(`${url}/extract?kind=einvoice_xml`, { method: 'POST', body, headers: { 'content-type': 'application/xml' } });
  return { status: response.status, result: zExtractResponse.parse(await response.json()) };
}

// A raw HTTP client: sends the request line, headers and only `sent` bytes of a body declared `declared` bytes long.
function partialRequest(url: string, declared: number, sent: Uint8Array): Promise<Socket> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(
        `POST /extract?kind=einvoice_xml HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/xml\r\nContent-Length: ${declared}\r\n\r\n`,
      );
      socket.write(sent, () => resolve(socket));
    });
    socket.on('error', reject);
  });
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries until the check holds or the time is up; the server notices a disconnect asynchronously.
async function eventually<T>(check: () => Promise<T>, ok: (value: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (ok(value) || Date.now() > deadline) return value;
    await tick(50);
  }
}

const quick: ExtractResponse = { ok: false, code: 'invalid', message: 'quick' };

describe('crove-extract over HTTP', () => {
  it('aborts the parse when the caller disconnects, and the slot serves the next request', async () => {
    let aborted = 0;
    let calls = 0;
    const run: Runner = (_kind, _bytes, signal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(quick);
      // The first parse runs until its caller goes away, as runSandboxed does (it kills the process then).
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted += 1;
          resolve({ ok: false, code: 'internal', message: 'caller went away' });
        });
      });
    };
    const url = await start({ run, concurrency: 1, maxQueue: 0 });
    const caller = new AbortController();
    const first = fetch(`${url}/extract?kind=einvoice_xml`, { method: 'POST', body: FIXTURE, signal: caller.signal }).catch((e: unknown) => e);
    await eventually(async () => calls, (n) => n === 1);
    expect(await post(url)).toMatchObject({ status: 503, result: { code: 'busy' } });
    caller.abort();
    await first;
    await eventually(async () => aborted, (n) => n === 1);
    expect(aborted).toBe(1);
    expect(await eventually(() => post(url), (r) => r.status !== 503)).toMatchObject({ status: 422, result: quick });
  });

  it('frees the single slot when a caller that sends its body slowly disconnects', async () => {
    let calls = 0;
    const run: Runner = async () => {
      calls += 1;
      return quick;
    };
    const url = await start({ run, concurrency: 1, maxQueue: 0 });
    // Declares 1 MB, sends 10 bytes and then nothing: the slot waits on the body.
    const slow = await partialRequest(url, 1024 * 1024, new Uint8Array(10));
    expect(await eventually(() => post(url), (r) => r.status === 503)).toMatchObject({ status: 503, result: { code: 'busy' } });
    await tick(200);
    expect(await post(url)).toMatchObject({ status: 503 });
    slow.destroy();
    expect(await eventually(() => post(url), (r) => r.status !== 503)).toMatchObject({ status: 422, result: quick });
    // The slow request never reached a parser.
    expect(calls).toBe(1);
  });

  it('drops a queued caller that disconnects before its turn, freeing its queue place', async () => {
    const run: Runner = async () => quick;
    const url = await start({ run, concurrency: 1, maxQueue: 1 });
    const holder = await partialRequest(url, 1024 * 1024, new Uint8Array(10));
    await tick(100);
    // Waits in the queue; its body is not read until it gets the slot.
    const waiter = await partialRequest(url, FIXTURE.byteLength, FIXTURE);
    expect(await eventually(() => post(url), (r) => r.status === 503)).toMatchObject({ status: 503 });
    waiter.destroy();
    await tick(300);
    // The queue place is free again: this request waits instead of being refused, and runs once the holder goes.
    const queued = post(url);
    await tick(200);
    holder.destroy();
    expect(await queued).toMatchObject({ status: 422, result: quick });
  });
});

describe('crove-extract body read', () => {
  it('ends a stalled body read on abort even when the body stream never errors', async () => {
    let calls = 0;
    const run: Runner = async () => {
      calls += 1;
      return quick;
    };
    const app = createExtractApp({ run, concurrency: 1, maxQueue: 0 });
    // Sends a few bytes and then nothing, forever; only the abort can end the read.
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
      },
    });
    const caller = new AbortController();
    const pending = app.fetch(
      new Request('http://extract.test/extract?kind=einvoice_xml', { method: 'POST', body: stalled, duplex: 'half', signal: caller.signal } as RequestInit),
    );
    await tick(50);
    const busy = await app.request('/extract?kind=einvoice_xml', { method: 'POST', body: FIXTURE });
    expect(busy.status).toBe(503);
    caller.abort();
    expect(zExtractResponse.parse(await (await pending).json())).toMatchObject({ code: 'internal', message: 'caller went away' });
    const next = await app.request('/extract?kind=einvoice_xml', { method: 'POST', body: FIXTURE });
    expect(next.status).toBe(422);
    expect(calls).toBe(1);
  });
});
