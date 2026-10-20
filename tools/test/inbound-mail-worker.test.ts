import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import worker, { relay } from '../inbound-mail/worker.js';

// A fake kernel: records each request and answers with the next queued status and body.
type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };
const seen: Seen[] = [];
let answer: { status: number; body?: unknown; location?: string } = { status: 202 };
let server: Server;
let kernelUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.location ? { location: answer.location } : {}) });
      res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  kernelUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const SECRET = 'y'.repeat(32);
// Bytes that are not valid UTF-8 and CRLF line ends: the relay must pass them on unchanged.
const RAW = Buffer.concat([Buffer.from('From: a@example.com\r\nTo: x@inbound.example.com\r\nSubject: hoa don\r\n\r\n'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a])]);

function message(to: string) {
  const rejected: string[] = [];
  return {
    to,
    raw: new Blob([RAW]).stream(),
    setReject: (reason: string) => void rejected.push(reason),
    rejected,
  };
}

describe('inbound mail relay (tools/inbound-mail/worker.js)', () => {
  it('posts the raw message with the secret and the envelope recipient', async () => {
    seen.length = 0;
    answer = { status: 202, body: { accepted: true, sha256: 'x' } };
    for (const to of ['0123456789abcdef01234567@inbound.example.com', `bounce+${'ab'.repeat(24)}@inbound.example.com`]) {
      const m = message(to);
      await expect(relay(m, { KERNEL_URL: kernelUrl, INBOUND_SECRET: SECRET })).resolves.toBe('accepted');
      expect(m.rejected).toEqual([]);
    }
    expect(seen).toHaveLength(2);
    for (const [i, to] of ['0123456789abcdef01234567@inbound.example.com', `bounce+${'ab'.repeat(24)}@inbound.example.com`].entries()) {
      const req = seen[i]!;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/inbound/email');
      expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(req.headers['x-crove-recipient']).toBe(to);
      expect(req.headers['content-type']).toBe('message/rfc822');
      expect(req.body.equals(RAW)).toBe(true);
    }
  });

  it('keeps a path on KERNEL_URL out of the endpoint, and the default export relays too', async () => {
    seen.length = 0;
    answer = { status: 202, body: { accepted: true } };
    await worker.email(message('0123456789abcdef01234567@inbound.example.com'), { KERNEL_URL: `${kernelUrl}/app/`, INBOUND_SECRET: SECRET });
    expect(seen[0]?.url).toBe('/api/inbound/email');
  });

  it('rejects the message on a 4xx with a plain reason', async () => {
    const cases: [number, unknown, string][] = [
      [404, { code: 'UNKNOWN_RECIPIENT', message: 'Địa chỉ nhận không hợp lệ' }, 'Unknown recipient'],
      [413, { code: 'TOO_LARGE', message: 'Thư vượt quá 40 MB' }, 'Message too large (40 MB limit)'],
      [400, { code: 'EMPTY_MESSAGE' }, 'Empty message'],
      [422, { code: 'SOMETHING_NEW' }, 'Refused by Crove (SOMETHING_NEW)'],
      [413, undefined, 'Refused by Crove (HTTP_413)'],
    ];
    for (const [status, body, reason] of cases) {
      answer = { status, body };
      const m = message('ffffffffffffffffffffffff@inbound.example.com');
      await expect(relay(m, { KERNEL_URL: kernelUrl, INBOUND_SECRET: SECRET })).resolves.toBe('rejected');
      expect(m.rejected).toEqual([reason]);
    }
  });

  it('throws on a 5xx, a wrong secret, a busy kernel or a redirect, so the sender retries', async () => {
    const cases: { status: number; body?: unknown; location?: string }[] = [
      { status: 503, body: { code: 'INBOUND_BACKLOG' } },
      { status: 500, body: { code: 'INTERNAL' } },
      { status: 401, body: { code: 'UNAUTHENTICATED' } },
      { status: 429 },
      { status: 308, location: 'https://elsewhere.example.com/api/inbound/email' },
    ];
    for (const c of cases) {
      answer = c;
      seen.length = 0;
      const m = message('0123456789abcdef01234567@inbound.example.com');
      await expect(relay(m, { KERNEL_URL: kernelUrl, INBOUND_SECRET: SECRET })).rejects.toThrow(`${c.status}`);
      expect(m.rejected).toEqual([]);
      expect(seen).toHaveLength(1);
    }
  });

  it('throws on a network error', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const m = message('0123456789abcdef01234567@inbound.example.com');
    await expect(relay(m, { KERNEL_URL: `http://127.0.0.1:${port}`, INBOUND_SECRET: SECRET })).rejects.toThrow();
    expect(m.rejected).toEqual([]);
  });

  it('refuses to send the secret without settings or over plain http to another host', async () => {
    seen.length = 0;
    const m = message('0123456789abcdef01234567@inbound.example.com');
    await expect(relay(m, { KERNEL_URL: kernelUrl })).rejects.toThrow('INBOUND_SECRET');
    await expect(relay(m, { INBOUND_SECRET: SECRET })).rejects.toThrow('KERNEL_URL');
    await expect(relay(m, { KERNEL_URL: 'http://crove.example.com', INBOUND_SECRET: SECRET })).rejects.toThrow('https');
    expect(seen).toEqual([]);
  });
});
