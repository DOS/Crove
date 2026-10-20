// The egress guard (plan §7.7, #641): which addresses count as public, which URLs pass, and fetches against a local
// server that only the test allows (the guard itself refuses 127.0.0.1).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EgressError, egressFetch, egressTarget, guardedFetch, guardedRequest, isPublicAddress, type EgressOptions } from '../src/egress.ts';

describe('isPublicAddress', () => {
  it('refuses private, loopback, link-local, metadata, shared and reserved IPv4 ranges', () => {
    for (const a of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '142.250.72.14']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses IPv6 loopback, unique local, link-local, mapped, translated and documentation ranges', () => {
    for (const a of ['::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2002:a00:1::1', '2001:0:4136::1']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses what is not an address', () => {
    expect(isPublicAddress('localhost')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('egressTarget', () => {
  it('takes absolute http and https URLs on their default ports, without credentials', () => {
    expect(egressTarget('https://example.com/a?b=1').toString()).toBe('https://example.com/a?b=1');
    expect(egressTarget('http://example.com:80/').toString()).toBe('http://example.com/');
    for (const bad of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'javascript:alert(1)', 'https://user:pw@example.com/', 'https://example.com:8443/', 'http://example.com:22/', '/relative', 'not a url']) {
      expect(() => egressTarget(bad), bad).toThrow(EgressError);
    }
  });
});

describe('guardedFetch', () => {
  let server: Server;
  let base = '';
  const held = { closed: false };
  const local: Partial<EgressOptions> = { allowed: (a) => a === '127.0.0.1', anyPort: true };
  const opts = (o: Partial<EgressOptions> = {}): EgressOptions => ({ timeoutMs: 2000, maxBytes: 1024, overLimit: 'truncate', ...local, ...o });

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? '/';
      if (path === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Xin chào</title></head></html>');
      } else if (path === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(5000));
      } else if (path === '/redirect') {
        res.writeHead(302, { location: '/page' });
        res.end();
      } else if (path === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (path === '/inside') {
        res.writeHead(301, { location: 'http://10.0.0.1/admin' });
        res.end();
      } else if (path === '/metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      } else if (path === '/file') {
        res.writeHead(302, { location: 'file:///etc/passwd' });
        res.end();
      } else if (path === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end('not really gzip');
      } else if (path === '/redirect-hold') {
        // A redirect whose body never ends.
        req.socket.once('close', () => (held.closed = true));
        res.writeHead(302, { location: '/page', 'content-type': 'text/plain' });
        res.write('x');
      } else if (path === '/slow') {
        // Never answers.
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (error) {
      return error instanceof EgressError ? error.code : String(error);
    }
  };

  it('fetches a page and follows a redirect to the same host', async () => {
    const page = await guardedFetch(`${base}/redirect`, opts());
    expect(page).toMatchObject({ status: 200, url: `${base}/page`, truncated: false, contentType: 'text/html; charset=utf-8' });
    expect(page.body.toString('utf8')).toContain('Xin chào');
  });

  it('refuses the local server without the test allowance, by literal address and by a name that resolves to it', async () => {
    expect(await code(guardedFetch(`${base}/page`, { timeoutMs: 2000, maxBytes: 1024, overLimit: 'truncate', anyPort: true }))).toBe('blocked');
    const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
    expect(await code(guardedFetch('http://intranet.example/', { timeoutMs: 2000, maxBytes: 1024, overLimit: 'truncate', resolve }))).toBe('blocked');
    // A name with one public and one private answer is refused as a whole.
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    expect(await code(guardedFetch('http://mixed.example/', { timeoutMs: 2000, maxBytes: 1024, overLimit: 'truncate', resolve: mixed }))).toBe('blocked');
    expect(await code(guardedFetch('http://[::1]/', { timeoutMs: 2000, maxBytes: 1024, overLimit: 'truncate' }))).toBe('blocked');
  });

  it('checks every redirect: inside addresses, metadata and other schemes are refused', async () => {
    expect(await code(guardedFetch(`${base}/inside`, opts()))).toBe('blocked');
    expect(await code(guardedFetch(`${base}/metadata`, opts()))).toBe('blocked');
    expect(await code(guardedFetch(`${base}/file`, opts()))).toBe('invalid_url');
    expect(await code(guardedFetch(`${base}/loop`, opts()))).toBe('redirects');
  });

  it('closes the connection of a redirect that keeps it open', async () => {
    await guardedFetch(`${base}/redirect-hold`, opts());
    await new Promise((r) => setTimeout(r, 100));
    expect(held.closed).toBe(true);
  });

  it('cuts a body at the limit, or refuses it', async () => {
    const cut = await guardedFetch(`${base}/big`, opts());
    expect(cut.truncated).toBe(true);
    expect(cut.body.length).toBe(1024);
    expect(await code(guardedFetch(`${base}/big`, opts({ overLimit: 'fail' })))).toBe('too_large');
  });

  it('gives up at the deadline, and refuses a compressed answer', async () => {
    const started = Date.now();
    expect(await code(guardedFetch(`${base}/slow`, opts({ timeoutMs: 300 })))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await code(guardedFetch(`${base}/gzip`, opts()))).toBe('encoding');
    const never = () => new Promise<{ address: string; family: number }[]>(() => {});
    expect(await code(guardedFetch('http://slow-dns.example/', { timeoutMs: 200, maxBytes: 1024, overLimit: 'truncate', resolve: never }))).toBe('timeout');
    const fails = () => Promise.reject(new Error('ENOTFOUND'));
    expect(await code(guardedFetch('http://nowhere.example/', { timeoutMs: 200, maxBytes: 1024, overLimit: 'truncate', resolve: fails }))).toBe('dns');
  });
});

// Requests with a method, headers and a body (#748), through the same guard.
describe('guardedRequest and egressFetch', () => {
  let server: Server;
  let base = '';
  const opts = (o: Partial<EgressOptions> = {}): EgressOptions => ({ timeoutMs: 2000, maxBytes: 1024, overLimit: 'fail', allowed: (a) => a === '127.0.0.1', anyPort: true, ...o });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(307, { location: 'http://10.0.0.1/steal' });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization ?? null, type: req.headers['content-type'] ?? null, encoding: req.headers['accept-encoding'] ?? null, length: req.headers['content-length'] ?? null, body: Buffer.concat(chunks).toString('utf8') }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends the method, the headers and the body, with the length and encoding the guard sets', async () => {
    const answer = await guardedRequest(`${base}/statuses`, { method: 'POST', headers: { Authorization: 'Bearer t', 'Accept-Encoding': 'gzip', 'Content-Length': '1' }, body: Buffer.from('{"a":1}') }, opts());
    expect(answer.status).toBe(201);
    expect(JSON.parse(answer.body.toString('utf8'))).toEqual({ method: 'POST', auth: 'Bearer t', type: null, encoding: 'identity', length: '7', body: '{"a":1}' });
  });

  it('never follows a redirect with the request, and refuses what the guard refuses', async () => {
    expect((await guardedRequest(`${base}/moved`, { method: 'POST', headers: { authorization: 'Bearer t' } }, opts())).status).toBe(302);
    // Headers that would change where or how the request goes are dropped.
    const sent = await guardedRequest(`${base}/statuses`, { method: 'POST', headers: { Host: 'metadata.internal', 'Transfer-Encoding': 'chunked', Connection: 'upgrade', Upgrade: 'websocket' }, body: Buffer.from('x') }, opts());
    expect(JSON.parse(sent.body.toString('utf8'))).toMatchObject({ method: 'POST', length: '1', body: 'x' });
    await expect(guardedRequest('http://10.0.0.1/', { method: 'POST' }, { timeoutMs: 2000, maxBytes: 1024, overLimit: 'fail', anyPort: true })).rejects.toMatchObject({ code: 'blocked' });
    await expect(guardedRequest(`${base}/statuses`, { method: 'POST' }, { timeoutMs: 2000, maxBytes: 1024, overLimit: 'fail', anyPort: true })).rejects.toMatchObject({ code: 'blocked' });
  });

  it('is a fetch for adapters: JSON and FormData bodies, https only unless allowed', async () => {
    const plain = egressFetch(opts({ httpsOnly: false } as Partial<EgressOptions>));
    const json = await plain(`${base}/statuses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: JSON.stringify({ status: 'Xin chào' }) });
    expect(json.status).toBe(201);
    expect(await json.json()).toMatchObject({ method: 'POST', type: 'application/json', body: '{"status":"Xin chào"}' });
    const form = new FormData();
    form.append('description', 'Ảnh');
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');
    const multipart = (await (await plain(`${base}/media`, { method: 'POST', body: form })).json()) as { type: string; body: string };
    expect(multipart.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(multipart.body).toContain('name="description"');
    expect(multipart.body).toContain('filename="a.png"');
    await expect(egressFetch(opts())(`${base}/statuses`)).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(plain(`${base}/x`, { method: 'PATCH' })).rejects.toMatchObject({ code: 'invalid_url' });
  });
});
