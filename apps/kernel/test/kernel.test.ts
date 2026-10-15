// The composition root (ADR-0030): which adapters main.ts wires by default, that an entrypoint can replace any
// port, and that a missing required port stops the boot. The end-to-end run of overridden ports is in
// kernel-composition.db.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { InvoiceExtractor, type InvoiceReader } from '@crove/agent';
import { LocalDiskStore, S3BlobStore, type BlobStore } from '@crove/kernel-runtime';
import type { AlertSink } from '../src/alert.ts';
import { loadConfig } from '../src/config.ts';
import { createKernel, defaultAdapters, selfHostBilling, type Billing, type IdentityPort, type KernelAdapters } from '../src/kernel.ts';
import { sendTestAlert, type ProberConfig } from '../src/prober.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' };

const fakeAi: InvoiceReader = { fromText: async () => null, fromImage: async () => null };

describe('defaultAdapters (the open-source wiring in main.ts)', () => {
  it('builds Supabase Auth identity from the session check setting', () => {
    const bundled = defaultAdapters(loadConfig({ ...BASE, AUTH_UPSTREAM_URL: 'http://auth:9999' }));
    expect(bundled.identity.sessions).toMatchObject({ mode: 'db', liveCheckForR3: false });
    // Self-host with the bundled Auth and the shared secret signs revoked sessions out upstream.
    expect(bundled.identity.revoker).not.toBeNull();

    const remote = defaultAdapters(loadConfig({ ...BASE, PUBLIC_AUTH_URL: 'http://localhost:9999' }));
    expect(remote.identity.sessions).toMatchObject({ mode: 'jwt', liveCheckForR3: true });
    expect(remote.identity.revoker).toBeNull();
    expect(typeof remote.identity.authenticator).toBe('function');
  });

  it('runs without AI until an OpenAI-compatible endpoint is configured', () => {
    expect(defaultAdapters(loadConfig(BASE)).ai).toBeNull();
    expect(defaultAdapters(loadConfig({ ...BASE, AI_BASE_URL: 'http://localhost:4000/v1' })).ai).toBeNull();
    const ai = defaultAdapters(loadConfig({ ...BASE, AI_BASE_URL: 'http://localhost:4000/v1', AI_MODEL: 'qwen' })).ai;
    expect(ai).toBeInstanceOf(InvoiceExtractor);
  });

  it('stores files on local disk by default and in S3 when configured', () => {
    expect(defaultAdapters(loadConfig(BASE)).storage).toBeInstanceOf(LocalDiskStore);
    expect(defaultAdapters(loadConfig({ ...BASE, STORAGE: 's3', S3_BUCKET: 'crove-files' })).storage).toBeInstanceOf(S3BlobStore);
  });

  it('leaves broker, connectors and billing to the no-op defaults', async () => {
    const config = loadConfig(BASE);
    const defaults = defaultAdapters(config);
    expect(defaults.broker).toBeUndefined();
    const kernel = createKernel(config, defaults);
    expect(kernel.adapters.identity).toBe(defaults.identity);
    expect(kernel.adapters.storage).toBe(defaults.storage);
    expect(kernel.adapters.connectors).toEqual([]);
    expect(kernel.adapters.billing).toBe(selfHostBilling);
    expect(await kernel.adapters.billing.entitlements('org')).toEqual(['full']);
    await expect(kernel.adapters.broker.credential('org', 'binding')).rejects.toMatchObject({ code: 'BROKER_NOT_CONFIGURED' });
  });
});

describe('createKernel', () => {
  it('uses an adapter an entrypoint passes instead of the default', () => {
    const config = loadConfig({ ...BASE, AI_BASE_URL: 'http://localhost:4000/v1', AI_MODEL: 'qwen' });
    const storage = {} as BlobStore;
    const billing: Billing = { entitlements: async () => ['finance'] };
    const kernel = createKernel(config, { ...defaultAdapters(config), ai: fakeAi, storage, billing, connectors: [{ id: 'bank' }] });
    expect(kernel.adapters.ai).toBe(fakeAi);
    expect(kernel.adapters.storage).toBe(storage);
    expect(kernel.adapters.billing).toBe(billing);
    expect(kernel.adapters.connectors).toEqual([{ id: 'bank' }]);
  });

  it('refuses to boot when a required port is missing, naming it', () => {
    const config = loadConfig(BASE);
    const { identity, storage } = defaultAdapters(config);
    expect(() => createKernel(config, { identity, storage } as unknown as KernelAdapters)).toThrow('createKernel: missing adapter(s) ai');
    expect(() => createKernel(config, {} as KernelAdapters)).toThrow('createKernel: missing adapter(s) identity, ai, storage');
    // null is an explicit "no AI", not a missing port.
    expect(() => createKernel(config, { identity, storage, ai: null })).not.toThrow();
    // Without a session source the runtime would skip the ADR-0028 check, so a partial identity port is refused too.
    const partial = { authenticator: identity.authenticator } as unknown as IdentityPort;
    expect(() => createKernel(config, { identity: partial, storage, ai: null })).toThrow(
      'createKernel: missing adapter(s) identity.sessions, identity.revoker',
    );
  });

  it('refuses to start a worker without its own login or the parsing sandbox', async () => {
    const noWorker = loadConfig(BASE);
    await expect(createKernel(noWorker, defaultAdapters(noWorker)).start('worker')).rejects.toThrow(/WORKER_DATABASE_URL is required/);
    const noExtract = loadConfig({ ...BASE, WORKER_DATABASE_URL: 'postgres://localhost/w' });
    await expect(createKernel(noExtract, defaultAdapters(noExtract)).start('all')).rejects.toThrow(/EXTRACT_URL is required/);
  });
});

describe('the alert port', () => {
  it('sends prober alerts to a sink an entrypoint passes instead of the webhook', async () => {
    const delivered: string[] = [];
    const sink: AlertSink = {
      describe: () => 'pager',
      deliver: async (alert) => {
        delivered.push(alert.kind);
        return { channel: 'webhook', ok: true };
      },
    };
    const config: ProberConfig = {
      databaseUrl: undefined,
      webhookUrl: 'https://hooks.example.test/x',
      instance: 'test',
      thresholds: { outboxAgeSeconds: 1, jobAgeSeconds: 1, heartbeatAgeSeconds: 1, deadLetters: 0 },
      deadLetterWindowSeconds: 60,
    };
    const fetch = vi.fn();
    const log = vi.fn();
    expect(await sendTestAlert(config, { sink, fetch, log })).toBe(0);
    expect(delivered).toEqual(['test']);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[prober] test alert sent to pager');
  });
});
