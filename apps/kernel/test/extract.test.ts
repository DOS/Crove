// The worker side of crove-extract (External-tenant gate T12): configuration, and how an inbound email is handed
// to the sandbox instead of being parsed here.
import { describe, expect, it } from 'vitest';
import { EXTRACT_LIMIT_RETRIES, ExtractServiceError, type ExtractClient } from '@crove/extract-contract';
import { DomainError, inboundKey, sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { processInboundEmail } from '../src/inbound.ts';

const BASE = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth' };

describe('EXTRACT_URL', () => {
  it('is an http(s) URL; a bad value is named by field, never echoed', () => {
    expect(loadConfig({ ...BASE, EXTRACT_URL: 'http://crove-extract:8090' }).EXTRACT_URL).toBe('http://crove-extract:8090');
    expect(loadConfig(BASE).EXTRACT_URL).toBeUndefined();
    const bad = () => loadConfig({ ...BASE, EXTRACT_URL: 'file:///var/run/secret-path' });
    expect(bad).toThrow(/EXTRACT_URL/);
    expect(bad).not.toThrow(/secret-path/);
  });
});

describe('inbound email through crove-extract', () => {
  const raw = new TextEncoder().encode('From: a@b.c\r\nSubject: x\r\n\r\nbody');
  const job = { blobId: 'a'.repeat(64), sha256: sha256Hex(raw), sizeBytes: raw.byteLength, recipient: `${'0'.repeat(24)}@in.test` };
  const store = {
    get: async (key: string) => {
      if (key !== inboundKey(job.blobId)) throw new Error('unexpected key');
      return raw;
    },
  } as unknown as BlobStore;
  // Nothing reaches the database when the sandbox does not return a readable message.
  const runtime = {
    orgless: async () => {
      throw new Error('must not resolve the org');
    },
  } as unknown as Runtime;
  const deps = (extract: ExtractClient) => ({ runtime, store, domain: 'in.test', extract });

  it('sends the raw message to the sandbox and drops one it cannot read', async () => {
    const seen: Array<{ kind: string; bytes: Uint8Array }> = [];
    const extract: ExtractClient = {
      extract: async (kind, bytes) => {
        seen.push({ kind, bytes });
        return { ok: false, code: 'invalid', message: 'Không đọc được thư điện tử' } as never;
      },
    };
    const error = await processInboundEmail(deps(extract), job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    // 422: dropped by the worker, not retried.
    expect(error).toMatchObject({ code: 'UNREADABLE_MESSAGE', status: 422 });
    expect(seen).toEqual([{ kind: 'mime', bytes: raw }]);
  });

  it('retries a message that hit a time or memory limit once, then drops it so it cannot hold the parser slot', async () => {
    expect(EXTRACT_LIMIT_RETRIES).toBe(1);
    for (const code of ['timeout', 'memory'] as const) {
      const extract: ExtractClient = { extract: async () => ({ ok: false, code, message: 'limit' }) as never };
      const first = await processInboundEmail(deps(extract), job, 0).catch((e: unknown) => e);
      // Not a DomainError: the worker drops only DomainErrors below 500, so this attempt is retried.
      expect(first).toBeInstanceOf(Error);
      expect(first).not.toBeInstanceOf(DomainError);
      const second = await processInboundEmail(deps(extract), job, 1).catch((e: unknown) => e);
      expect(second).toBeInstanceOf(DomainError);
      expect(second).toMatchObject({ code: 'UNREADABLE_MESSAGE', status: 422 });
    }
  });

  it('lets a sandbox failure through, so the job is retried and the message kept', async () => {
    const extract: ExtractClient = {
      extract: async () => {
        throw new ExtractServiceError('unreachable', 'crove-extract is unreachable');
      },
    };
    await expect(processInboundEmail(deps(extract), job)).rejects.toBeInstanceOf(ExtractServiceError);
  });
});
