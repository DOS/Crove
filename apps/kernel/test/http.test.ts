import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_HEADER } from '@crove/kernel-contract';
import {
  BlobConflictError,
  BlobNotFoundError,
  BlobStoreAccessError,
  DomainError,
  LocalDiskStore,
  inboundKey,
  newInboundBlobId,
  type BlobStore,
  type Runtime,
} from '@crove/kernel-runtime';
import type { AuthUser } from '../src/auth.ts';
import { assertExportKey, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';

const SECRET = 'x'.repeat(32);
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));

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
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1' })).not.toThrow();
  });

  // ADR-0028 section 1 and 3.
  it('refuses to boot without an issuer', () => {
    expect(() => loadConfig({ ...base, AUTH_ISSUER: undefined })).toThrow(/AUTH_ISSUER/);
    expect(() => loadConfig({ ...base, AUTH_ISSUER: '  ' })).toThrow(/AUTH_ISSUER/);
  });

  // Plan Decision 12, ADR-0031.
  it('enables every module by default, always keeps kernel and refuses an unknown module', () => {
    expect(loadConfig(base).CROVE_MODULES).toEqual(['kernel', 'finance']);
    expect(loadConfig({ ...base, CROVE_MODULES: '  ' }).CROVE_MODULES).toEqual(['kernel', 'finance']);
    expect(loadConfig({ ...base, CROVE_MODULES: 'kernel' }).CROVE_MODULES).toEqual(['kernel']);
    expect(loadConfig({ ...base, CROVE_MODULES: ' Finance ' }).CROVE_MODULES).toEqual(['kernel', 'finance']);
    expect(loadConfig({ ...base, CROVE_MODULES: 'finance,kernel' }).CROVE_MODULES).toEqual(['kernel', 'finance']);
    expect(() => loadConfig({ ...base, CROVE_MODULES: 'kernel,crm' })).toThrow(/CROVE_MODULES \(unknown module\(s\) crm; available: kernel, finance\)/);
  });

  it('never resolves the session check to "no check" by default', () => {
    expect(loadConfig({ ...base, AUTH_UPSTREAM_URL: 'http://auth:9999' }).AUTH_SESSION_CHECK).toBe('db');
    // Crove Cloud: no bundled Supabase Auth, so the verified token plus Crove's records, and a live check for R3.
    expect(loadConfig(base).AUTH_SESSION_CHECK).toBe('jwt');
    expect(loadConfig({ ...base, AUTH_UPSTREAM_URL: 'http://auth:9999', AUTH_SESSION_CHECK: 'jwt' }).AUTH_SESSION_CHECK).toBe('jwt');
    expect(loadConfig({ ...base, AUTH_SESSION_CHECK: 'off' }).AUTH_SESSION_CHECK).toBe('off');
    expect(() => loadConfig({ ...base, AUTH_SESSION_CHECK: 'maybe' })).toThrow(/AUTH_SESSION_CHECK/);
    // The events adapter (DOS ID lifecycle events) is not a mode until a later refinement builds it.
    expect(() => loadConfig({ ...base, AUTH_SESSION_CHECK: 'events' })).toThrow(/AUTH_SESSION_CHECK/);
  });

  // ADR-0028 section 5: on a public URL, jwt needs an Auth URL for the R3 live check.
  it('refuses jwt on a public URL without an Auth URL for the R3 live check', () => {
    const publicUrl = { ...base, PUBLIC_URL: 'https://books.example.com' };
    expect(() => loadConfig(publicUrl)).toThrow(/PUBLIC_AUTH_URL/);
    expect(() => loadConfig({ ...publicUrl, AUTH_SESSION_CHECK: 'jwt' })).toThrow(/PUBLIC_AUTH_URL/);
    expect(loadConfig({ ...publicUrl, PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1' }).AUTH_SESSION_CHECK).toBe('jwt');
    expect(loadConfig({ ...publicUrl, AUTH_UPSTREAM_URL: 'http://auth:9999' }).AUTH_SESSION_CHECK).toBe('db');
    // Hosted Supabase answers only with the publishable key; without it every R3 would be a confusing 401.
    const hosted = { ...publicUrl, PUBLIC_AUTH_URL: 'https://example.supabase.co/auth/v1' };
    expect(() => loadConfig(hosted)).toThrow(/PUBLIC_AUTH_ANON_KEY/);
    expect(loadConfig({ ...hosted, PUBLIC_AUTH_ANON_KEY: 'publishable' }).AUTH_SESSION_CHECK).toBe('jwt');
  });

  it('accepts the session check and MFA step-up turned off on localhost only', () => {
    const publicUrl = { ...base, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1' };
    expect(() => loadConfig({ ...publicUrl, AUTH_SESSION_CHECK: 'off' })).toThrow(/AUTH_SESSION_CHECK=off/);
    expect(() => loadConfig({ ...publicUrl, AUTH_STEP_UP: 'off' })).toThrow(/AUTH_STEP_UP=off/);
    expect(loadConfig(publicUrl).AUTH_STEP_UP).toBe('required');
    expect(loadConfig({ ...base, AUTH_STEP_UP: 'off' }).AUTH_STEP_UP).toBe('off');
  });

  // #212: org exports are sealed at rest on every public deployment; a key must be 32 bytes.
  it('requires a well-formed export key to serve a public URL', () => {
    const publicUrl = { ...base, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1' };
    expect(() => assertExportKey(loadConfig(publicUrl))).toThrow(/EXPORT_ENCRYPTION_KEY/);
    expect(() => assertExportKey(loadConfig(base))).not.toThrow();
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(() => assertExportKey(loadConfig({ ...publicUrl, EXPORT_ENCRYPTION_KEY: key }))).not.toThrow();
    expect(() => assertExportKey(loadConfig({ ...publicUrl, EXPORT_ENCRYPTION_KEY: 'ab'.repeat(32) }))).not.toThrow();
    expect(() => loadConfig({ ...base, EXPORT_ENCRYPTION_KEY: 'too-short' })).toThrow(/32 random bytes/);
    expect(() => loadConfig({ ...base, EXPORT_ENCRYPTION_KEY: key, EXPORT_ENCRYPTION_KEY_PREVIOUS: `${'cd'.repeat(32)}, nope` })).toThrow(/32 random bytes/);
    expect(() => loadConfig({ ...base, EXPORT_RETENTION_DAYS: '30' })).toThrow(/EXPORT_RETENTION_DAYS/);
    expect(loadConfig(base).EXPORT_RETENTION_DAYS).toBe(35);
  });

  // #117: on by default (direct connections); off only behind a transaction-mode pooler.
  it('resets pooled sessions on release unless DB_RESET_ON_RELEASE=false', () => {
    expect(loadConfig(base).DB_RESET_ON_RELEASE).toBe('true');
    expect(loadConfig({ ...base, DB_RESET_ON_RELEASE: 'false' }).DB_RESET_ON_RELEASE).toBe('false');
    expect(() => loadConfig({ ...base, DB_RESET_ON_RELEASE: 'no' })).toThrow(/DB_RESET_ON_RELEASE/);
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
      runtime: { installed: () => true, modules: () => ['kernel', 'finance'] } as unknown as Runtime,
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
      installed: () => true,
      modules: () => ['kernel', 'finance'],
      orgless: async () => {
        touched.push('enqueue');
        return enqueue();
      },
    } as unknown as Runtime,
    store: {
      put: async (key: string) => {
        touched.push(key);
        return 'content:test';
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

describe('store errors on the file routes', () => {
  const user: AuthUser = { userId: randomUUID(), email: 'owner@example.com', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null };
  const orgId = randomUUID();
  const storageKey = `org/${orgId}/${'a'.repeat(64)}`;
  const headers = { authorization: 'Bearer t', [ORG_HEADER]: 'acme' };
  let failure: Error = new Error('unset');
  const failing: BlobStore = {
    put: async () => {
      throw failure;
    },
    get: async () => {
      throw failure;
    },
    delete: async () => undefined,
  };
  const app = createHttpApp({
    config: loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' }),
    runtime: {
      installed: () => true,
      modules: () => ['kernel', 'finance'],
      forUser: async () => [{ orgId, slug: 'acme', name: 'Acme', role: 'owner' }],
      query: async () => ({ filename: 'hd.xml', content_type: 'application/xml', storage_key: storageKey }),
    } as unknown as Runtime,
    store: failing,
    authenticate: async () => user,
    pool: {} as pg.Pool,
    aiEnabled: false,
  });
  const download = () => app.request(`/api/files/${randomUUID()}`, { headers });
  const upload = () => {
    const form = new FormData();
    form.append('file', new File([FIXTURE], 'hd.xml', { type: 'application/xml' }));
    return app.request('/api/files', { method: 'POST', body: form, headers });
  };

  it('answers 404 for a missing blob and 409 for a key that holds other bytes', async () => {
    failure = new BlobNotFoundError(storageKey);
    const missing = await download();
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: 'NOT_FOUND', message: 'Không tìm thấy tệp' });

    failure = new BlobConflictError(storageKey);
    const conflict = await upload();
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: 'CONFLICT', message: 'Tệp đã tồn tại với nội dung khác' });
  });

  it('keeps other store failures, such as a refused read, a 500 without details', async () => {
    failure = new BlobStoreAccessError('crove-files', storageKey, new Error('AccessDenied'));
    const denied = await download();
    expect(denied.status).toBe(500);
    expect(await denied.json()).toEqual({ code: 'INTERNAL', message: 'Lỗi hệ thống' });
  });
});
