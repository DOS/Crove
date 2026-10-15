import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, LocalDiskStore, inboundKey, newInboundBlobId, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const SECRET = 'x'.repeat(32);

describe('configuration guards', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth' };

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

  // ADR-0028 section 1 and 3.
  it('refuses to boot without an issuer', () => {
    expect(() => loadConfig({ ...base, AUTH_ISSUER: undefined })).toThrow(/AUTH_ISSUER/);
    expect(() => loadConfig({ ...base, AUTH_ISSUER: '  ' })).toThrow(/AUTH_ISSUER/);
  });

  it('never resolves the session check to "no check" by default', () => {
    expect(loadConfig({ ...base, AUTH_UPSTREAM_URL: 'http://auth:9999' }).AUTH_SESSION_CHECK).toBe('db');
    expect(loadConfig(base).AUTH_SESSION_CHECK).toBe('events');
    expect(loadConfig({ ...base, AUTH_SESSION_CHECK: 'off' }).AUTH_SESSION_CHECK).toBe('off');
    expect(() => loadConfig({ ...base, AUTH_SESSION_CHECK: 'maybe' })).toThrow(/AUTH_SESSION_CHECK/);
  });

  it('accepts the session check and MFA step-up turned off on localhost only', () => {
    const publicUrl = { ...base, PUBLIC_URL: 'https://books.example.com' };
    expect(() => loadConfig({ ...publicUrl, AUTH_SESSION_CHECK: 'off' })).toThrow(/AUTH_SESSION_CHECK=off/);
    expect(() => loadConfig({ ...publicUrl, AUTH_STEP_UP: 'off' })).toThrow(/AUTH_STEP_UP=off/);
    expect(loadConfig(publicUrl).AUTH_STEP_UP).toBe('required');
    expect(loadConfig({ ...base, AUTH_STEP_UP: 'off' }).AUTH_STEP_UP).toBe('off');
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
      AUTH_ISSUER: 'crove-auth',
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

describe('inbound email on the API', () => {
  const INBOUND_SECRET = 'y'.repeat(32);
  let touched: string[] = [];
  // What the enqueue definer answers: true (queued), false (already pending) or an error.
  let enqueue: () => boolean = () => true;
  const app = createHttpApp({
    config: loadConfig({
      DATABASE_URL: 'postgres://localhost/x',
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: 'crove-auth',
      INBOUND_DOMAIN: 'in.test',
      INBOUND_SECRET,
      WEB_DIST: '/nonexistent',
    }),
    runtime: {
      orgless: async () => {
        touched.push('enqueue');
        return enqueue();
      },
    } as unknown as Runtime,
    store: {
      put: async (key: string) => {
        touched.push(key);
      },
      get: async () => new Uint8Array(),
      delete: async (key: string) => {
        touched.push(`delete ${key}`);
      },
    },
    authenticate: async () => {
      throw new Error('not used');
    },
    pool: {} as pg.Pool,
    aiEnabled: false,
  });
  const deliver = (headers: Record<string, string>, body = 'Subject: x\r\n\r\nhello') =>
    app.request('/api/inbound/email', { method: 'POST', headers, body });

  it('stores and enqueues the raw message and answers 202, without parsing it', async () => {
    touched = [];
    const response = await deliver({ authorization: `Bearer ${INBOUND_SECRET}`, 'x-crove-recipient': `${'a'.repeat(24)}@in.test` });
    expect(response.status).toBe(202);
    expect(touched).toEqual([expect.stringMatching(/^inbound\/[0-9a-f]{64}$/), 'enqueue']);
  });

  it('deletes its blob again when the message is already pending or the backlog is full', async () => {
    const headers = { authorization: `Bearer ${INBOUND_SECRET}` };
    try {
      touched = [];
      enqueue = () => false;
      expect((await deliver(headers)).status).toBe(202);
      expect(touched).toEqual([expect.stringMatching(/^inbound\//), 'enqueue', `delete ${touched[0]}`]);

      touched = [];
      enqueue = () => {
        throw new DomainError('OVERLOADED', 503, 'busy');
      };
      const response = await deliver(headers);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'OVERLOADED' });
      expect(touched).toEqual([expect.stringMatching(/^inbound\//), 'enqueue', `delete ${touched[0]}`]);
    } finally {
      enqueue = () => true;
    }
  });

  it('refuses a wrong secret, an empty body and a malformed address before storing anything', async () => {
    touched = [];
    expect((await deliver({ authorization: 'Bearer nope' })).status).toBe(401);
    expect((await deliver({ authorization: `Bearer ${INBOUND_SECRET}` }, '')).status).toBe(400);
    expect((await deliver({ authorization: `Bearer ${INBOUND_SECRET}`, 'x-crove-recipient': 'not-a-token@in.test' })).status).toBe(404);
    expect(touched).toEqual([]);
  });

  it('keeps raw messages under their own key scheme on local disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crove-store-'));
    try {
      const store = new LocalDiskStore(root);
      const bytes = new TextEncoder().encode('raw message');
      const key = inboundKey(newInboundBlobId());
      await store.put(key, bytes);
      expect(await store.get(key)).toEqual(bytes);
      await store.delete(key);
      await expect(store.get(key)).rejects.toThrow();
      await expect(store.delete(key)).resolves.toBeUndefined();
      await expect(store.put('inbound/../escape', bytes)).rejects.toThrow(/invalid storage key/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
