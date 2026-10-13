import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const SECRET = 'x'.repeat(32);

describe('configuration guards', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET };

  it('refuses a short JWT secret', () => {
    expect(() => loadConfig({ ...base, AUTH_JWT_SECRET: 'short' })).toThrow(/32 characters/);
  });

  it('allows sample secrets and autoconfirm on localhost only', () => {
    const local = { ...base, AUTH_JWT_SECRET: 'local-only-jwt-secret-change-me-0123456789', AUTH_AUTOCONFIRM: 'true' };
    expect(() => loadConfig(local)).not.toThrow();
    expect(() => loadConfig({ ...local, PUBLIC_URL: 'https://books.example.com' })).toThrow(/sample value/);
    expect(() => loadConfig({ ...base, AUTH_AUTOCONFIRM: 'true', PUBLIC_URL: 'https://books.example.com' })).toThrow(/AUTH_AUTOCONFIRM/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://books.example.com' })).not.toThrow();
  });
});

describe('auth proxy', () => {
  let upstream: Server;
  let seen: { path: string; headers: IncomingHttpHeaders } | null = null;
  let app: ReturnType<typeof createHttpApp>;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = { path: req.url ?? '', headers: req.headers };
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = upstream.address() as AddressInfo;
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/x',
      AUTH_JWT_SECRET: SECRET,
      AUTH_UPSTREAM_URL: `http://127.0.0.1:${port}`,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({
      config,
      runtime: {} as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('does not expose the admin API', async () => {
    seen = null;
    const response = await app.request('/auth/v1/admin/users');
    expect(response.status).toBe(404);
    expect(seen).toBeNull();
  });

  it('forwards public endpoints with the client address from the socket, not from headers', async () => {
    const request = new Request('http://localhost/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' },
      body: '{}',
    });
    const response = await app.fetch(request, { incoming: { socket: { remoteAddress: '203.0.113.9' } } });
    expect(response.status).toBe(200);
    expect(seen?.path).toBe('/token?grant_type=password');
    expect(seen?.headers['x-real-ip']).toBe('203.0.113.9');
    expect(seen?.headers['x-forwarded-for']).toBeUndefined();
  });
});
