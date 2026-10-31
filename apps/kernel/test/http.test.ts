import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DIRECT_UPLOAD_MAX_BYTES, MAX_UPLOAD_BYTES, ORG_HEADER } from '@crove/kernel-contract';
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
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { assertExportKey, assertSplitRoles, extractConcurrency, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { secretMatches } from '../src/inbound.ts';
import { buildZip } from '../../extract/test/zip-fixture.ts';

const SECRET = 'x'.repeat(32);
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));

describe('configuration guards', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth' };

  it('refuses a short JWT secret', () => {
    expect(() => loadConfig({ ...base, AUTH_JWT_SECRET: 'short' })).toThrow(/32 characters/);
  });

  // #1214: the previous inbound secret of a rotation follows the current one's rules, and the errors carry neither value.
  it('takes a previous inbound secret only with a current one, as long, different and not a sample value', () => {
    const current = 'c'.repeat(32);
    const previous = 'p'.repeat(32);
    expect(loadConfig({ ...base, INBOUND_SECRET: current, INBOUND_SECRET_PREVIOUS: previous }).INBOUND_SECRET_PREVIOUS).toBe(previous);
    expect(loadConfig({ ...base, INBOUND_SECRET: current, INBOUND_SECRET_PREVIOUS: '' }).INBOUND_SECRET_PREVIOUS).toBeUndefined();
    const refusal = (env: Record<string, string>) => {
      try {
        loadConfig({ ...base, ...env });
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(current);
        expect(message).not.toContain(previous);
        return message;
      }
      return null;
    };
    expect(refusal({ INBOUND_SECRET_PREVIOUS: previous })).toBe('INBOUND_SECRET_PREVIOUS is set without INBOUND_SECRET');
    expect(refusal({ INBOUND_SECRET: current, INBOUND_SECRET_PREVIOUS: 'p'.repeat(31) })).toBe('INBOUND_SECRET_PREVIOUS must be at least 32 characters');
    expect(refusal({ INBOUND_SECRET: current, INBOUND_SECRET_PREVIOUS: current })).toBe('INBOUND_SECRET_PREVIOUS must differ from INBOUND_SECRET');
    expect(refusal({ INBOUND_SECRET: current, INBOUND_SECRET_PREVIOUS: 'change-me-to-a-long-random-string-0123456789' })).toBe('INBOUND_SECRET_PREVIOUS still has a sample value');
  });

  it('allows sample secrets and autoconfirm on localhost only', () => {
    const local = { ...base, AUTH_JWT_SECRET: 'local-only-jwt-secret-change-me-0123456789', AUTH_AUTOCONFIRM: 'true' };
    expect(() => loadConfig(local)).not.toThrow();
    expect(() => loadConfig({ ...local, PUBLIC_URL: 'https://books.example.com' })).toThrow(/sample value/);
    expect(() => loadConfig({ ...base, AUTH_AUTOCONFIRM: 'true', PUBLIC_URL: 'https://books.example.com' })).toThrow(/AUTH_AUTOCONFIRM/);
    // The sandbox bank feed (ADR-0039): made-up bank lines, never on a deployment others reach.
    expect(() => loadConfig({ ...base, BANK_FEED_SANDBOX: 'true' })).not.toThrow();
    expect(() => loadConfig({ ...base, BANK_FEED_SANDBOX: 'true', PUBLIC_URL: 'https://books.example.com' })).toThrow(/BANK_FEED_SANDBOX/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1' })).not.toThrow();
  });

  // #2118: docker-compose.yml falls back to published passwords for an unset one; on a public URL the kernel refuses them.
  it('refuses a sample database password on a public PUBLIC_URL, naming the setting and never the value', () => {
    const publicBase = { ...base, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1' };
    const sample = (name: string, password: string) => ({ ...publicBase, [name]: `postgres://crove_x:${password}@db:5432/postgres` });
    for (const name of ['DATABASE_URL', 'WORKER_DATABASE_URL', 'ADMIN_DATABASE_URL', 'DATABASE_LISTEN_URL']) {
      for (const password of ['local-app-password', 'local-worker-password', 'local-postgres-password', 'change-me-app', 'my-Change-Me-pass', '%63hange-me-worker', 'change%2Dme-app']) {
        let message = '';
        try {
          loadConfig(sample(name, password));
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message, `${name} ${password}`).toContain(`${name} carries a database password shipped in .env.example or docker-compose.yml`);
        expect(message).not.toContain(password);
      }
      expect(() => loadConfig(sample(name, 'r4nd0m-Pa55-0123456789abcdef'))).not.toThrow();
    }
    // The password may also come as a query parameter, which node-postgres reads.
    expect(() => loadConfig({ ...publicBase, DATABASE_URL: 'postgres://crove_app@db:5432/postgres?password=local-app-password' })).toThrow(/DATABASE_URL carries a database password/);
    // Locally the compose fallbacks are the documented default.
    expect(() => loadConfig({ ...base, DATABASE_URL: 'postgres://crove_app:local-app-password@db:5432/postgres' })).not.toThrow();
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'http://localhost:8080', DATABASE_URL: 'postgres://crove_app:local-app-password@db:5432/postgres' })).not.toThrow();
    // No password in the URL, or no URL at all (the connection fails on its own later), is not a sample password.
    expect(() => loadConfig({ ...publicBase, DATABASE_URL: 'postgres://localhost/x' })).not.toThrow();
  });

  // #2118: a missing compose.pilot.yml or a stray profile must not silently run the API on the worker's login.
  it('starts the all role on a public PUBLIC_URL only with CROVE_ALLOW_ALL_IN_ONE=true', () => {
    const publicConfig = (extra: Record<string, string> = {}) => loadConfig({ ...base, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1', ...extra });
    expect(() => assertSplitRoles(publicConfig(), 'all')).toThrow(/CROVE_ALLOW_ALL_IN_ONE=true/);
    expect(() => assertSplitRoles(publicConfig({ CROVE_ALLOW_ALL_IN_ONE: 'false' }), 'all')).toThrow(/separate processes/);
    expect(() => assertSplitRoles(publicConfig({ CROVE_ALLOW_ALL_IN_ONE: '' }), 'all')).toThrow(/separate processes/);
    expect(() => assertSplitRoles(publicConfig({ CROVE_ALLOW_ALL_IN_ONE: 'true' }), 'all')).not.toThrow();
    for (const role of ['api', 'worker'] as const) expect(() => assertSplitRoles(publicConfig(), role)).not.toThrow();
    // A laptop needs no opt-in.
    expect(() => assertSplitRoles(loadConfig(base), 'all')).not.toThrow();
    expect(() => loadConfig({ ...base, CROVE_ALLOW_ALL_IN_ONE: 'yes' })).toThrow(/CROVE_ALLOW_ALL_IN_ONE/);
  });

  // #2133: keeping the worker's all-org login out of the API does not rest on how the container was composed.
  it('refuses the api role on a public PUBLIC_URL when it holds WORKER_DATABASE_URL, and only then', () => {
    const worker = { WORKER_DATABASE_URL: 'postgres://crove_worker:worker-ref@db:5432/postgres' };
    const publicConfig = (extra: Record<string, string> = {}) => loadConfig({ ...base, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1', ...extra });
    expect(() => assertSplitRoles(publicConfig(worker), 'api')).toThrow(/api role must not hold WORKER_DATABASE_URL/);
    // The message names the setting and never its value.
    expect(() => assertSplitRoles(publicConfig(worker), 'api')).not.toThrow(/worker-ref/);
    // Without it, and for the worker (which needs it), nothing is refused; an empty value (a compose `${VAR:-}`) is unset.
    expect(() => assertSplitRoles(publicConfig(), 'api')).not.toThrow();
    expect(() => assertSplitRoles(publicConfig({ WORKER_DATABASE_URL: '' }), 'api')).not.toThrow();
    expect(() => assertSplitRoles(publicConfig(worker), 'worker')).not.toThrow();
    // The all role has it by design (the opt-in above governs it); a laptop's api may hold it.
    expect(() => assertSplitRoles(publicConfig({ ...worker, CROVE_ALLOW_ALL_IN_ONE: 'true' }), 'all')).not.toThrow();
    expect(() => assertSplitRoles(loadConfig({ ...base, ...worker }), 'api')).not.toThrow();
    expect(() => assertSplitRoles(loadConfig({ ...base, ...worker, PUBLIC_URL: 'http://127.0.0.1:8080' }), 'api')).not.toThrow();
  });

  // #2119: how many extract jobs the worker runs at once, and how often an AI call is sent again.
  it('runs up to 4 extract jobs at once, never more than the sandbox has slots, and bounds the AI retries', () => {
    const sandbox = { EXTRACT_URL: 'http://crove-extract:8090' };
    // Without a word about the sandbox's slots, one job at a time, as the sandbox's own default of one slot allows.
    expect(loadConfig(base).EXTRACT_CONCURRENCY).toBe(1);
    expect(extractConcurrency(loadConfig(base))).toBe(1);
    // docker compose gives both 4; a blank value (a compose `${VAR:-}`) is unset.
    expect(extractConcurrency(loadConfig({ ...base, EXTRACT_CONCURRENCY: '4' }))).toBe(4);
    expect(extractConcurrency(loadConfig({ ...base, EXTRACT_WORKER_CONCURRENCY: '', EXTRACT_CONCURRENCY: '4' }))).toBe(4);
    expect(extractConcurrency(loadConfig({ ...base, EXTRACT_WORKER_CONCURRENCY: '', EXTRACT_CONCURRENCY: '' }))).toBe(1);
    // More slots than 4 do not raise the default; fewer lower it; the setting goes down for the AI provider's rate limit.
    expect(extractConcurrency(loadConfig({ ...base, EXTRACT_CONCURRENCY: '8' }))).toBe(4);
    expect(extractConcurrency(loadConfig({ ...base, EXTRACT_CONCURRENCY: '2' }))).toBe(2);
    expect(extractConcurrency(loadConfig({ ...base, EXTRACT_WORKER_CONCURRENCY: '1', EXTRACT_CONCURRENCY: '4' }))).toBe(1);
    expect(extractConcurrency(loadConfig({ ...base, EXTRACT_WORKER_CONCURRENCY: '8', EXTRACT_CONCURRENCY: '8' }))).toBe(8);
    // Never past the slots: refused where the sandbox is used.
    expect(() => loadConfig({ ...base, ...sandbox, EXTRACT_WORKER_CONCURRENCY: '5', EXTRACT_CONCURRENCY: '4' })).toThrow(/must not exceed EXTRACT_CONCURRENCY/);
    expect(() => loadConfig({ ...base, ...sandbox, EXTRACT_WORKER_CONCURRENCY: '2' })).toThrow(/must not exceed EXTRACT_CONCURRENCY/);
    // The API resets EXTRACT_URL, so a stray value there never stops it.
    expect(() => loadConfig({ ...base, EXTRACT_WORKER_CONCURRENCY: '5', EXTRACT_CONCURRENCY: '4' })).not.toThrow();
    for (const bad of ['0', '9', '2.5', 'many']) {
      expect(() => loadConfig({ ...base, EXTRACT_WORKER_CONCURRENCY: bad }), bad).toThrow(/EXTRACT_WORKER_CONCURRENCY/);
      expect(() => loadConfig({ ...base, EXTRACT_CONCURRENCY: bad }), bad).toThrow(/EXTRACT_CONCURRENCY/);
    }
    expect(loadConfig(base).AI_MAX_RETRIES).toBe(1);
    expect(loadConfig({ ...base, AI_MAX_RETRIES: '' }).AI_MAX_RETRIES).toBe(1);
    expect(loadConfig({ ...base, AI_MAX_RETRIES: '0' }).AI_MAX_RETRIES).toBe(0);
    for (const bad of ['-1', '6', '1.5', 'x']) expect(() => loadConfig({ ...base, AI_MAX_RETRIES: bad }), bad).toThrow(/AI_MAX_RETRIES/);
  });

  // ADR-0028 section 1 and 3.
  it('refuses to boot without an issuer', () => {
    expect(() => loadConfig({ ...base, AUTH_ISSUER: undefined })).toThrow(/AUTH_ISSUER/);
    expect(() => loadConfig({ ...base, AUTH_ISSUER: '  ' })).toThrow(/AUTH_ISSUER/);
  });

  // Plan Decision 12, ADR-0031.
  it('enables every module by default, always keeps kernel and refuses an unknown module', () => {
    expect(loadConfig(base).CROVE_MODULES).toEqual(['kernel', 'finance', 'social', 'crm', 'notes']);
    expect(loadConfig({ ...base, CROVE_MODULES: '  ' }).CROVE_MODULES).toEqual(['kernel', 'finance', 'social', 'crm', 'notes']);
    expect(loadConfig({ ...base, CROVE_MODULES: ',' }).CROVE_MODULES).toEqual(['kernel', 'finance', 'social', 'crm', 'notes']);
    expect(loadConfig({ ...base, CROVE_MODULES: ' , ,' }).CROVE_MODULES).toEqual(['kernel', 'finance', 'social', 'crm', 'notes']);
    expect(loadConfig({ ...base, CROVE_MODULES: 'kernel' }).CROVE_MODULES).toEqual(['kernel']);
    expect(loadConfig({ ...base, CROVE_MODULES: ' Finance ' }).CROVE_MODULES).toEqual(['kernel', 'finance']);
    expect(loadConfig({ ...base, CROVE_MODULES: 'finance,kernel' }).CROVE_MODULES).toEqual(['kernel', 'finance']);
    expect(() => loadConfig({ ...base, CROVE_MODULES: 'kernel,service' })).toThrow(/CROVE_MODULES \(unknown module\(s\) service; available: kernel, finance, social, crm, notes\)/);
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

  // #375: a provider sends the OAuth code to PUBLIC_URL/channels/oauth/<provider>/callback.
  it('refuses a public plain-http PUBLIC_URL when a channel OAuth app is set', () => {
    const meta = { CHANNEL_META_APP_ID: '1234567890', CHANNEL_META_APP_SECRET: 'meta-secret-0123456789abcdef' };
    const auth = { PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1' };
    expect(() => loadConfig({ ...base, ...auth, ...meta, PUBLIC_URL: 'http://books.example.com' })).toThrow(/must be https/);
    expect(loadConfig({ ...base, ...auth, PUBLIC_URL: 'http://books.example.com' }).PUBLIC_URL).toBe('http://books.example.com');
    expect(loadConfig({ ...base, ...auth, ...meta, PUBLIC_URL: 'https://books.example.com' }).CHANNEL_META_APP_ID).toBe('1234567890');
    expect(loadConfig({ ...base, ...meta }).CHANNEL_META_APP_ID).toBe('1234567890');
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

  // #310: the app's feedback and support link is an https: page or a mailto: address; unset hides it.
  it('accepts an https: or mailto: SUPPORT_URL and refuses any other', () => {
    expect(loadConfig(base).SUPPORT_URL).toBeUndefined();
    expect(loadConfig({ ...base, SUPPORT_URL: '  ' }).SUPPORT_URL).toBeUndefined();
    expect(loadConfig({ ...base, SUPPORT_URL: ' https://chat.example.com/g/pilot ' }).SUPPORT_URL).toBe('https://chat.example.com/g/pilot');
    expect(loadConfig({ ...base, SUPPORT_URL: 'mailto:support@example.com' }).SUPPORT_URL).toBe('mailto:support@example.com');
    for (const url of ['http://chat.example.com', 'javascript:alert(1)', 'data:text/html,x', 'support@example.com', 'https://']) {
      expect(() => loadConfig({ ...base, SUPPORT_URL: url }), url).toThrow(/SUPPORT_URL/);
    }
    for (const url of ['mailto:', 'mailto:?subject=Crove']) {
      expect(() => loadConfig({ ...base, SUPPORT_URL: url }), url).toThrow(/SUPPORT_URL \(a mailto: link needs an address\)/);
    }
  });

  it('hands SUPPORT_URL to the app through /api/config, or null', async () => {
    const config = async (env: Record<string, string>) => {
      const app = createHttpApp({
        config: loadConfig({ ...base, WEB_DIST: '/nonexistent', ...env }),
        runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
        store: {} as BlobStore,
        authenticate: async () => {
          throw new Error('not used');
        },
        pool: {} as pg.Pool,
        aiEnabled: false,
      });
      return ((await (await app.request('/api/config')).json()) as { supportUrl: unknown }).supportUrl;
    };
    expect(await config({})).toBeNull();
    expect(await config({ SUPPORT_URL: 'mailto:support@example.com' })).toBe('mailto:support@example.com');
  });

  // #688: the terms of service and privacy notice linked at sign-up and invite acceptance are https: pages.
  it('accepts https: TERMS_URL and PRIVACY_URL only, and hands them to the app or null', async () => {
    for (const name of ['TERMS_URL', 'PRIVACY_URL'] as const) {
      expect(loadConfig(base)[name]).toBeUndefined();
      expect(loadConfig({ ...base, [name]: ' ' })[name]).toBeUndefined();
      expect(loadConfig({ ...base, [name]: ' https://crove.example.com/legal/terms ' })[name]).toBe('https://crove.example.com/legal/terms');
      for (const url of ['http://crove.example.com/terms', 'javascript:alert(1)', 'mailto:legal@example.com', 'data:text/html,x', '/terms', 'https://']) {
        expect(() => loadConfig({ ...base, [name]: url }), `${name}=${url}`).toThrow(new RegExp(name));
      }
    }
    const app = (env: Record<string, string>) =>
      createHttpApp({
        config: loadConfig({ ...base, WEB_DIST: '/nonexistent', ...env }),
        runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
        store: {} as BlobStore,
        authenticate: async () => {
          throw new Error('not used');
        },
        pool: {} as pg.Pool,
        aiEnabled: false,
      });
    const read = async (env: Record<string, string>) =>
      (await (await app(env).request('/api/config')).json()) as { termsUrl: unknown; privacyUrl: unknown };
    expect(await read({})).toMatchObject({ termsUrl: null, privacyUrl: null });
    expect(await read({ TERMS_URL: 'https://crove.example.com/terms', PRIVACY_URL: 'https://crove.example.com/privacy' })).toMatchObject({
      termsUrl: 'https://crove.example.com/terms',
      privacyUrl: 'https://crove.example.com/privacy',
    });
  });

  // #1040: the product name users see is one setting, "Ludy" when unset (#1683), plain text only.
  it('validates BRAND_NAME and hands it to the app, "Ludy" when unset', async () => {
    expect(loadConfig(base).BRAND_NAME).toBe('Ludy');
    expect(loadConfig({ ...base, BRAND_NAME: ' ' }).BRAND_NAME).toBe('Ludy');
    expect(loadConfig({ ...base, BRAND_NAME: ' Tên Mới ' }).BRAND_NAME).toBe('Tên Mới');
    expect(loadConfig({ ...base, BRAND_NAME: "Sổ Xanh & Co's (VN)" }).BRAND_NAME).toBe("Sổ Xanh & Co's (VN)");
    expect(loadConfig({ ...base, BRAND_NAME: 'x'.repeat(40) }).BRAND_NAME).toHaveLength(40);
    for (const name of ['x'.repeat(41), '<b>Crove</b>', '{brand}', 'A "quoted" name', 'Line\nbreak', '-dash first', 'a/b', 'mail@example.com']) {
      expect(() => loadConfig({ ...base, BRAND_NAME: name }), name).toThrow(/BRAND_NAME/);
    }
    const read = async (env: Record<string, string>) => {
      const app = createHttpApp({
        config: loadConfig({ ...base, WEB_DIST: '/nonexistent', ...env }),
        runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
        store: {} as BlobStore,
        authenticate: async () => {
          throw new Error('not used');
        },
        pool: {} as pg.Pool,
        aiEnabled: false,
      });
      return ((await (await app.request('/api/config')).json()) as { brandName: unknown }).brandName;
    };
    expect(await read({})).toBe('Ludy');
    expect(await read({ BRAND_NAME: 'Tên Mới' })).toBe('Tên Mới');
  });

  // #1691: the installed app is named after the configured brand; every other field of the app's manifest stays.
  it('serves the install manifest under BRAND_NAME, "Ludy" when unset, and the other assets as files', async () => {
    const source = readFileSync(new URL('../../app/public/assets/manifest.webmanifest', import.meta.url), 'utf8');
    const dist = await mkdtemp(join(tmpdir(), 'crove-manifest-'));
    try {
      await mkdir(join(dist, 'assets'));
      writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Ludy</title>');
      writeFileSync(join(dist, 'assets', 'manifest.webmanifest'), source);
      writeFileSync(join(dist, 'assets', 'app.js'), 'export {};\n');
      const serve = (env: Record<string, string>) =>
        createHttpApp({
          config: loadConfig({ ...base, WEB_DIST: dist, ...env }),
          runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
          store: {} as BlobStore,
          authenticate: async () => {
            throw new Error('not used');
          },
          pool: {} as pg.Pool,
          aiEnabled: false,
        });
      const { name: _name, short_name: _short, ...rest } = JSON.parse(source) as Record<string, unknown>;
      for (const [env, brand] of [[{}, 'Ludy'], [{ BRAND_NAME: "Sổ Xanh & Co's" }, "Sổ Xanh & Co's"]] as const) {
        const response = await serve(env).request('/assets/manifest.webmanifest');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/manifest+json');
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(await response.json()).toEqual({ ...rest, name: brand, short_name: brand });
      }
      // HEAD answers like GET; another method goes on to the static route, as before.
      const branded = serve({ BRAND_NAME: 'Tên Mới' });
      const head = await branded.request('/assets/manifest.webmanifest', { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe('application/manifest+json');
      expect((await branded.request('/assets/manifest.webmanifest', { method: 'POST' })).headers.get('content-type')).not.toBe('application/manifest+json');
      // The other static files are still the files themselves.
      const script = await branded.request('/assets/app.js');
      expect(script.status).toBe(200);
      expect(await script.text()).toBe('export {};\n');
      // A build without the manifest, or with one that is not JSON: the static route answers as before, nothing breaks.
      for (const broken of [null, '{ not json']) {
        await rm(join(dist, 'assets', 'manifest.webmanifest'), { force: true });
        if (broken !== null) writeFileSync(join(dist, 'assets', 'manifest.webmanifest'), broken);
        const response = await serve({ BRAND_NAME: 'Tên Mới' }).request('/assets/manifest.webmanifest');
        expect(response.status, String(broken)).not.toBe(500);
        expect(response.headers.get('cache-control'), String(broken)).not.toBe('no-cache');
        if (broken !== null) expect(await response.text()).toBe(broken);
      }
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

// #892: the deploy's smoke test reads the build and the migrations missing from the ledger.
describe('GET /version', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crove-version-'));
    for (const name of ['20260101000000_crove_kernel_first.sql', '20260102000000_crove_kernel_second.sql']) writeFileSync(join(dir, name), 'SELECT 1;\n');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const app = (env: Record<string, string>, pool: Partial<pg.Pool>) =>
    createHttpApp({
      config: loadConfig({ ...base, MIGRATIONS_DIR: dir, ...env }),
      runtime: { installed: () => true, modules: () => ['kernel'] } as unknown as Runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('not used');
      },
      pool: pool as pg.Pool,
      aiEnabled: false,
    });
  const ledger = (versions: string[]) => {
    const released = { count: 0 };
    const pool = {
      connect: async () => ({ query: async () => ({ rows: versions.map((version) => ({ version })) }), release: () => void (released.count += 1) }),
    } as unknown as Partial<pg.Pool>;
    return { pool, released };
  };

  it('answers the build and the committed migrations the ledger lacks, without a token', async () => {
    const full = ledger(['20260101000000', '20260102000000']);
    const answer = await app({ CROVE_BUILD: '0123456789abcdef0123456789abcdef01234567' }, full.pool).request('/version');
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ build: '0123456789abcdef0123456789abcdef01234567', migrationsMissing: [] });
    expect(full.released.count).toBe(1);

    const behind = await app({}, ledger(['20260101000000']).pool).request('/version');
    expect(await behind.json()).toEqual({ build: 'dev', migrationsMissing: ['20260102000000_crove_kernel_second.sql'] });
  });

  it('answers 503 with the build when the database cannot be reached or the ledger read fails', async () => {
    const down = await app({ CROVE_BUILD: 'v1.2.3' }, { connect: async () => Promise.reject(new Error('refused')) } as unknown as Partial<pg.Pool>).request('/version');
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ build: 'v1.2.3', migrationsMissing: null });
    const lost = Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
    const dropped = { connect: async () => ({ query: async () => Promise.reject(lost), release: () => undefined }) } as unknown as Partial<pg.Pool>;
    const midway = await app({ CROVE_BUILD: 'v1.2.3' }, dropped).request('/version');
    expect(midway.status).toBe(503);
    expect(await midway.json()).toEqual({ build: 'v1.2.3', migrationsMissing: null });
    // A database no migration has run on misses every migration.
    const fresh = Object.assign(new Error('relation "crove_meta.schema_migrations" does not exist'), { code: '42P01' });
    const empty = { connect: async () => ({ query: async () => Promise.reject(fresh), release: () => undefined }) } as unknown as Partial<pg.Pool>;
    expect(await (await app({}, empty).request('/version')).json()).toEqual({
      build: 'dev',
      migrationsMissing: ['20260101000000_crove_kernel_first.sql', '20260102000000_crove_kernel_second.sql'],
    });
  });

  it('takes a build id of letters, digits, dot, dash and underscore only', () => {
    expect(loadConfig({ ...base, CROVE_BUILD: ' ' }).CROVE_BUILD).toBeUndefined();
    for (const bad of ['a b', '<script>', 'x'.repeat(65)]) expect(() => loadConfig({ ...base, CROVE_BUILD: bad }), bad).toThrow(/CROVE_BUILD/);
  });
});

// A compact JWS with this payload (a JSON value, or raw text) and a dummy signature: the proxy decodes, never verifies.
function jws(payload: unknown, raw = false): string {
  const part = (text: string) => Buffer.from(text).toString('base64url');
  return `${part('{"alg":"HS256","typ":"JWT"}')}.${part(raw ? String(payload) : JSON.stringify(payload))}.${part('signature')}`;
}

describe('auth proxy', () => {
  let upstream: Server;
  let seen: { path: string; headers: IncomingHttpHeaders } | null = null;
  let reserved = 0;
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
      emailLimiter: {
        reserve: async () => {
          reserved += 1;
          return { allowed: true, reservation: 'slot' };
        },
        release: async () => {},
      },
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
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', 'sb-forwarded-for': '1.2.3.4' },
      body: '{}',
    });
    const response = await app.fetch(request, { incoming: { socket: { remoteAddress: '203.0.113.9' } } });
    expect(response.status).toBe(200);
    expect(seen?.path).toBe('/token?grant_type=password');
    expect(seen?.headers['x-real-ip']).toBe('203.0.113.9');
    expect(seen?.headers['x-forwarded-for']).toBeUndefined();
    expect(seen?.headers['sb-forwarded-for']).toBeUndefined();
  });

  // Issue #277: Supabase Auth authenticates /user, /logout, /reauthenticate and /factors with the user's access token
  // and accepts the tokens its OAuth server issues to third-party clients there; the proxy refuses them (same rule as
  // the kernel's verifier, issue #272).
  describe('tokens issued to OAuth clients', () => {
    const now = Math.floor(Date.now() / 1000);
    const browser = {
      iss: 'http://localhost:8080/auth/v1',
      aud: 'authenticated',
      sub: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      exp: now + 900,
      role: 'authenticated',
      email: 'user@example.com',
      session_id: '2d0c6f1e-5b7a-4c3d-9e8f-1a2b3c4d5e6f',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: now }],
    };
    const oauthAmr = [{ method: 'oauth_provider/authorization_code', timestamp: now }];
    const refused: Array<[string, string]> = [
      ['a client_id and scope as the OAuth server issues them', `Bearer ${jws({ ...browser, client_id: randomUUID(), scope: 'openid email', amr: oauthAmr })}`],
      ['a client_id with a browser amr', `Bearer ${jws({ ...browser, client_id: randomUUID() })}`],
      ['an empty client_id', `Bearer ${jws({ ...browser, client_id: '' })}`],
      ['a null client_id', `Bearer ${jws({ ...browser, client_id: null })}`],
      ['the OAuth amr without client_id (MFA verify on the OAuth session)', `Bearer ${jws({ ...browser, aal: 'aal2', amr: [{ method: 'totp', timestamp: now }, ...oauthAmr] })}`],
      ['the OAuth amr as a bare string', `Bearer ${jws({ ...browser, amr: ['oauth_provider/authorization_code'] })}`],
      ['a lower-case scheme and extra spaces', `bearer   ${jws({ ...browser, client_id: randomUUID() })}  `],
    ];
    const routes: Array<[string, string, string | undefined]> = [
      ['GET', '/user', undefined],
      ['PUT', '/user', '{"email":"attacker@example.com"}'],
      ['POST', '/logout?scope=global', undefined],
      ['GET', '/reauthenticate', undefined],
      ['POST', '/factors', '{"factor_type":"totp"}'],
      ['POST', '/factors/8f0c7b1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/challenge', '{}'],
      ['POST', '/factors/8f0c7b1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/verify', '{"challenge_id":"x","code":"123456"}'],
      ['DELETE', '/factors/8f0c7b1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', undefined],
      ['POST', '/token?grant_type=password', '{}'],
    ];
    // What the fake upstream last saw (a function, so TypeScript does not narrow `seen` to null after a reset).
    const observed = () => seen;
    const send = (method: string, path: string, authorization: string, body?: string) =>
      app.request(`/auth/v1${path}`, { method, headers: { authorization, 'content-type': 'application/json' }, body: body ?? null });

    for (const [label, authorization] of refused) {
      it(`refuses ${label} on every forwarded route, before upstream and the email budget`, async () => {
        const token = authorization.trim().split(/\s+/)[1] ?? '';
        const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
        try {
          for (const [method, path, body] of routes) {
            seen = null;
            reserved = 0;
            const response = await send(method, path, authorization, body);
            expect(response.status, `${method} ${path}`).toBe(401);
            const text = await response.text();
            expect(JSON.parse(text)).toEqual({ code: 401, error_code: 'OAUTH_CLIENT_TOKEN_REFUSED', msg: expect.any(String) });
            expect(text).not.toContain(token);
            expect(observed(), `${method} ${path} reached upstream`).toBeNull();
            expect(reserved).toBe(0);
          }
          for (const log of logs) expect(log).not.toHaveBeenCalled();
        } finally {
          for (const log of logs) log.mockRestore();
        }
      });
    }

    it('forwards browser tokens unchanged', async () => {
      const tokens = [
        `Bearer ${jws(browser)}`,
        `Bearer ${jws({ ...browser, aal: 'aal2', amr: [{ method: 'totp', timestamp: now }, { method: 'password', timestamp: now }] })}`,
        `Bearer ${jws({ ...browser, amr: [{ method: 'oauth', provider: 'google', timestamp: now }] })}`,
        `Bearer ${jws({ ...browser, amr: [{ method: 'otp', timestamp: now }], is_anonymous: false })}`,
        // The anon key auth-js sends before sign-in.
        `Bearer ${jws({ iss: 'supabase', role: 'anon', exp: now + 3600 })}`,
      ];
      for (const authorization of tokens) {
        for (const [method, path, body] of routes) {
          seen = null;
          const response = await send(method, path, authorization, body);
          expect(response.status, `${method} ${path}`).toBe(200);
          expect(observed()?.path).toBe(path);
          expect(observed()?.headers.authorization).toBe(authorization);
        }
      }
    });

    it('forwards malformed tokens unchanged, for Supabase Auth to reject', async () => {
      const malformed = [
        'Bearer not-a-jwt',
        `Bearer ${jws('{"client_id":"x"', true)}`,
        `Bearer ${jws(['client_id'])}`,
        `Bearer ${jws('null', true)}`,
        `Bearer ${jws({ client_id: 'x' }).split('.').slice(0, 2).join('.')}`,
        `Bearer ${jws({ client_id: 'x' })}.extra.parts`,
        `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}..sig`,
        `Bearer ${jws({ client_id: 'x' })} trailing`,
        `Basic ${Buffer.from('user:pass').toString('base64')}`,
        `Token ${jws({ client_id: 'x' })}`,
      ];
      for (const authorization of malformed) {
        seen = null;
        const response = await send('GET', '/user', authorization);
        expect(response.status, authorization).toBe(200);
        expect(observed()?.headers.authorization).toBe(authorization);
      }
    });
  });
});

describe('inbound email on the API', () => {
  const INBOUND_SECRET = 'y'.repeat(32);
  // A rotation under way (#1214): the old value the mail worker may still send.
  const INBOUND_SECRET_PREVIOUS = 'w'.repeat(32);
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
      INBOUND_SECRET_PREVIOUS,
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

  it('accepts the current and the previous secret during a rotation, and refuses any other value (#1214)', async () => {
    const recipient = { 'x-crove-recipient': `${'a'.repeat(24)}@in.test` };
    for (const secret of [INBOUND_SECRET, INBOUND_SECRET_PREVIOUS]) {
      touched = [];
      expect((await deliver({ authorization: `Bearer ${secret}`, ...recipient })).status).toBe(202);
      expect(touched).toHaveLength(2);
    }
    touched = [];
    for (const wrong of ['v'.repeat(32), INBOUND_SECRET.slice(1), `${INBOUND_SECRET}y`, `${INBOUND_SECRET}${INBOUND_SECRET_PREVIOUS}`, '']) {
      expect((await deliver({ authorization: `Bearer ${wrong}`, ...recipient })).status, wrong).toBe(401);
    }
    expect((await deliver({ authorization: INBOUND_SECRET, ...recipient })).status).toBe(401);
    expect((await deliver(recipient)).status).toBe(401);
    expect(touched).toEqual([]);
  });

  it('compares every secret, over digests of one length (#1214)', () => {
    expect(secretMatches(`Bearer ${INBOUND_SECRET}`, [INBOUND_SECRET])).toBe(true);
    expect(secretMatches(`Bearer ${INBOUND_SECRET_PREVIOUS}`, [INBOUND_SECRET, INBOUND_SECRET_PREVIOUS])).toBe(true);
    expect(secretMatches(`Bearer ${INBOUND_SECRET_PREVIOUS}`, [INBOUND_SECRET])).toBe(false);
    expect(secretMatches(undefined, [INBOUND_SECRET])).toBe(false);
    expect(secretMatches('Bearer ', [INBOUND_SECRET])).toBe(false);
    expect(secretMatches(`Bearer ${INBOUND_SECRET}`, [])).toBe(false);
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

describe('ZIP uploads (bulk intake, #314)', () => {
  const user: AuthUser = { userId: randomUUID(), email: 'member@example.com', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null };
  const orgId = randomUUID();
  const headers = { authorization: 'Bearer t', [ORG_HEADER]: 'acme' };
  const stored = new Map<string, Uint8Array>();
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const store: BlobStore = {
    put: async (key, bytes) => {
      stored.set(key, bytes);
      return undefined as unknown as string;
    },
    get: async () => {
      throw new BlobNotFoundError('x');
    },
    delete: async () => undefined,
  };
  const app = createHttpApp({
    config: loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' }),
    runtime: {
      installed: () => true,
      modules: () => ['kernel', 'finance'],
      forUser: async () => [{ orgId, slug: 'acme', name: 'Acme', role: 'member' }],
      execute: async (name: string, input: Record<string, unknown>) => {
        executed.push({ name, input });
        return { fileId: randomUUID(), duplicate: false };
      },
    } as unknown as Runtime,
    store,
    authenticate: async () => user,
    pool: {} as pg.Pool,
    aiEnabled: false,
  });
  const post = (bytes: Uint8Array<ArrayBuffer>, name: string, purpose?: string) => {
    const form = new FormData();
    if (purpose) form.append('purpose', purpose);
    form.append('file', new File([bytes], name, { type: 'application/octet-stream' }));
    return app.request('/api/files', { method: 'POST', body: form, headers });
  };
  const zip = buildZip([{ name: 'hd-001.xml', data: FIXTURE }]);

  it('stores a ZIP of documents as a file for the worker to open, by its content', async () => {
    const response = await post(zip, 'Thang 10.ZIP');
    expect(response.status).toBe(200);
    const ingest = executed.at(-1);
    expect(ingest?.name).toBe('kernel.file.ingest');
    expect(ingest?.input).toMatchObject({ contentType: 'application/zip', filename: 'Thang 10.zip', source: 'upload', sizeBytes: zip.byteLength });
    expect(stored.get(String(ingest?.input.storageKey))).toEqual(zip);
  });

  it('refuses a ZIP as a Social image, and other archives as documents', async () => {
    const count = executed.length;
    const social = await post(zip, 'anh.zip', 'social');
    expect(social.status).toBe(415);
    const rar = await post(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x01]), 'thang-10.rar');
    expect(rar.status).toBe(415);
    expect(await rar.json()).toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    expect(executed.length).toBe(count);
  });
});

describe('uploads through the kernel (#432)', () => {
  const MiB = 1024 * 1024;
  const user: AuthUser = { userId: randomUUID(), email: 'member@example.com', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null };
  const orgId = randomUUID();
  const headers = { authorization: 'Bearer t', [ORG_HEADER]: 'acme' };
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' });
  const executed: string[] = [];
  const runtime = {
    installed: () => true,
    modules: () => ['kernel', 'finance'],
    forUser: async () => [{ orgId, slug: 'acme', name: 'Acme', role: 'member' }],
    execute: async (name: string) => {
      executed.push(name);
      return { fileId: randomUUID(), duplicate: false };
    },
  } as unknown as Runtime;
  // Each put waits for the test to let it through while `hold` is set, so a request can be kept in flight.
  let hold: Promise<void> | null = null;
  const stored: string[] = [];
  const store = (presigned: boolean): BlobStore => ({
    put: async (key) => {
      await hold;
      stored.push(key);
      return undefined as unknown as string;
    },
    get: async () => {
      throw new BlobNotFoundError('x');
    },
    delete: async () => undefined,
    // Only its presence matters here: the store takes presigned uploads.
    ...(presigned ? { direct: {} as NonNullable<BlobStore['direct']> } : {}),
  });
  const appWith = (presigned: boolean, slots?: { directUploads?: ConcurrencyLimiter; largeUploads?: ConcurrencyLimiter }) =>
    createHttpApp({ config, runtime, store: store(presigned), authenticate: async () => user, pool: {} as pg.Pool, aiEnabled: false, ...slots });
  const pdf = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set(new TextEncoder().encode('%PDF-1.4\n'));
    return bytes;
  };
  const png = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes;
  };
  // The multipart body with its length, as browsers send it (a FormData body alone has no Content-Length here).
  async function post(app: ReturnType<typeof createHttpApp>, bytes: Uint8Array<ArrayBuffer>, name: string, purpose = 'document', withLength = true) {
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', new File([bytes], name, { type: 'application/octet-stream' }));
    if (!withLength) return app.request('/api/files', { method: 'POST', body: form, headers });
    const encoded = new Response(form);
    // Read before the body: Bun drops a Response's generated multipart content type once its body has been read (#768).
    const contentType = encoded.headers.get('content-type') ?? '';
    const body = new Uint8Array(await encoded.arrayBuffer());
    return app.request('/api/files', {
      method: 'POST',
      body,
      headers: { ...headers, 'content-type': contentType, 'content-length': String(body.byteLength) },
    });
  }

  it('takes a document of at most 4 MB when the store takes presigned uploads, and refuses a larger one before storing it', async () => {
    const app = appWith(true);
    expect((await post(app, pdf(DIRECT_UPLOAD_MAX_BYTES), 'hd.pdf')).status).toBe(200);
    const count = executed.length;
    const blobs = stored.length;
    const refused = await post(app, pdf(DIRECT_UPLOAD_MAX_BYTES + 1), 'lon.pdf');
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ code: 'TOO_LARGE', message: 'lon.pdf lớn hơn 4 MB; máy chủ này nhận tệp lớn qua kho lưu trữ (POST /api/files/uploads)' });
    expect(executed.length).toBe(count);
    expect(stored.length).toBe(blobs);
  });

  it('checks membership before a slot is taken, so a stranger to the org holds none', async () => {
    const directUploads = new ConcurrencyLimiter({ total: 1 });
    const app = appWith(true, { directUploads });
    const form = new FormData();
    form.append('file', new File([pdf(1024)], 'a.pdf'));
    const refused = await app.request('/api/files', { method: 'POST', body: form, headers: { ...headers, [ORG_HEADER]: 'other-org', 'content-length': '2048' } });
    expect([403, 404]).toContain(refused.status);
    expect(directUploads.inUse).toBe(0);
  });

  it('keeps the other limits: documents up to 25 MB on a store without presigned uploads, Social images with them', async () => {
    expect((await post(appWith(false), pdf(5 * MiB), 'hd.pdf')).status).toBe(200);
    expect((await post(appWith(true), png(5 * MiB), 'anh.png', 'social')).status).toBe(200);
    const tooLarge = await post(appWith(false), pdf(MAX_UPLOAD_BYTES + 1), 'lon.pdf');
    expect(tooLarge.status).toBe(413);
  });

  it('holds a direct-upload slot per body and answers 503 UPLOAD_BUSY with Retry-After when they are all taken', async () => {
    const directUploads = new ConcurrencyLimiter({ total: 1 });
    const app = appWith(true, { directUploads });
    let open = () => {};
    hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = post(app, pdf(1024), 'a.pdf');
    await vi.waitFor(() => expect(directUploads.inUse).toBe(1));
    const busy = await post(app, pdf(1024), 'b.pdf');
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('3');
    expect(await busy.json()).toMatchObject({ code: 'UPLOAD_BUSY' });
    open();
    hold = null;
    expect((await first).status).toBe(200);
    expect(directUploads.inUse).toBe(0);
    expect((await post(app, pdf(1024), 'b.pdf')).status).toBe(200);
    expect(directUploads.inUse).toBe(0);
  });

  it('gives a body without a length a large slot, taken before the body is read', async () => {
    const directUploads = new ConcurrencyLimiter({ total: 4 });
    const largeUploads = new ConcurrencyLimiter({ total: 1, perKey: 1 });
    const app = appWith(false, { directUploads, largeUploads });
    let open = () => {};
    hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = post(app, pdf(1024), 'a.pdf', 'document', false);
    await vi.waitFor(() => expect(largeUploads.inUse).toBe(1));
    expect(directUploads.inUse).toBe(0);
    expect((await post(app, pdf(1024), 'b.pdf', 'document', false)).status).toBe(503);
    open();
    hold = null;
    expect((await first).status).toBe(200);
    // A body with its length takes a direct-upload slot.
    expect((await post(app, pdf(1024), 'c.pdf')).status).toBe(200);
    expect(largeUploads.inUse + directUploads.inUse).toBe(0);
  });
});
