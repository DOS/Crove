// SPDX-License-Identifier: AGPL-3.0-only
// Two copies of one invoice read at the same moment end with exactly one flagged duplicate.found (#2137). Both readers are
// held after their lookup until the other has looked too, so neither can see the other's proposal there: only the check
// kernel.extraction.record makes again, under a lock on the invoice, can flag the second to record.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvoiceExtractor } from '@crove/agent';
import { createExtractApp } from '@crove/extract';
import { createDb, createPool, type Db } from '@crove/db';
import { createExtractClient, type ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import type { ParsedInvoice } from '@crove/l10n-vn';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('duplicate invoices read at the same time on PostgreSQL (#2137)', () => {
  const dbName = `crove_test_dupr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl: string;
  let pool: pg.Pool;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  let extract: ExtractClient;
  let owner = '';
  let orgA = '';
  let base: ParsedInvoice;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function upload(): Promise<string> {
    const bytes = randomBytes(64);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgA, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'hd.png', contentType: 'image/png', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(owner), orgId: orgA },
    );
    return fileId;
  }

  // The runtime the worker reads with, holding each reader after its duplicate lookup until `readers` lookups are done.
  function gatedRuntime(readers: number): Runtime {
    let looked = 0;
    const waiters: Array<() => void> = [];
    return new Proxy(workerRuntime, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop !== 'query') return typeof value === 'function' ? value.bind(target) : value;
        return async (name: string, input: unknown, options: unknown) => {
          const answer = await (value as (...args: unknown[]) => Promise<unknown>).call(target, name, input, options);
          if (name === 'finance.extraction.lookup') {
            looked += 1;
            if (looked >= readers) for (const release of waiters) release();
            else await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 10_000))]);
          }
          return answer;
        };
      },
    });
  }

  async function proposalsOf(fileIds: string[]) {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ source_file_id: string; id: string; duplicate_of: string | null; codes: string[]; run_codes: string[] }>(
        `SELECT p.source_file_id, p.id, p.duplicate_of,
                coalesce((SELECT array_agg(c ->> 'code') FROM jsonb_array_elements(p.payload -> 'checks') c), '{}') AS codes,
                coalesce((SELECT array_agg(c ->> 'code') FROM jsonb_array_elements(e.checks) c), '{}') AS run_codes
         FROM crove_kernel.proposal p JOIN crove_kernel.extraction e ON e.org_id = p.org_id AND e.id = p.extraction_id
         WHERE p.org_id = $1 AND p.source_file_id = ANY($2::uuid[]) ORDER BY p.created_at`,
        [orgA, fileIds],
      );
      return rows;
    } finally {
      await admin.end();
    }
  }

  beforeAll(async () => {
    const app = createExtractApp({ concurrency: 2 });
    extract = createExtractClient({ url: 'http://crove-extract.test', fetch: async (input, init) => app.fetch(new Request(input, init)) });
    const url = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    runtime = register(createDb(pool));
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 6 });
    workerRuntime = register(createDb(workerPool));
    owner = await upsertIdentity(createDb(pool), { issuer: 'test', subject: 'dupr-owner', email: 'dupr-owner@example.com', name: null });
    orgA = (await createOrg(runtime, asUser(owner), 'Org A')).orgId;
    const parsed = await extract.extract('einvoice_xml', FIXTURE);
    if (!parsed.ok) throw new Error('fixture did not parse');
    base = parsed.invoice;
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const reader = (invoice: ParsedInvoice) => {
    const read = async () => invoice;
    return { fromText: read, fromImage: read } as unknown as InvoiceExtractor;
  };

  it('flags exactly one of two copies of an invoice read at once, in its proposal and in its run', { timeout: 90_000 }, async () => {
    const invoice = { ...base, number: '7137' };
    const [a, b] = [await upload(), await upload()];
    const gated = gatedRuntime(2);
    await Promise.all([a, b].map((fileId) => extractAndPropose({ runtime: gated, store, extractor: reader(invoice), extract }, orgA, fileId)));
    const rows = await proposalsOf([a, b]);
    expect(rows).toHaveLength(2);
    const flagged = rows.filter((r) => r.duplicate_of !== null);
    expect(flagged).toHaveLength(1);
    // The later one to record is flagged, pointing at the other proposal, which carries no warning.
    const first = rows.find((r) => r.duplicate_of === null);
    expect(flagged[0]?.duplicate_of).toBe(first?.id);
    expect(flagged[0]?.codes).toContain('duplicate.found');
    expect(flagged[0]?.run_codes).toContain('duplicate.found');
    expect(first?.codes).not.toContain('duplicate.found');
    expect(first?.run_codes).not.toContain('duplicate.found');
  });

  it('flags only the later copies when three are read at once, and never an invoice that is not a copy', { timeout: 90_000 }, async () => {
    const same = { ...base, number: '7138' };
    const other = { ...base, number: '7139' };
    const [a, b, c, d] = [await upload(), await upload(), await upload(), await upload()];
    const gated = gatedRuntime(4);
    await Promise.all(
      [
        [a, same],
        [b, same],
        [c, same],
        [d, other],
      ].map(([fileId, invoice]) => extractAndPropose({ runtime: gated, store, extractor: reader(invoice as ParsedInvoice), extract }, orgA, fileId as string)),
    );
    const rows = await proposalsOf([a, b, c, d]);
    const bySource = new Map(rows.map((r) => [r.source_file_id, r]));
    const copies = [a, b, c].map((f) => bySource.get(f)).filter((r) => r !== undefined);
    expect(copies).toHaveLength(3);
    // One first copy, unflagged; the two others flagged.
    expect(copies.filter((r) => r.duplicate_of === null)).toHaveLength(1);
    expect(copies.filter((r) => r.duplicate_of !== null && r.codes.includes('duplicate.found'))).toHaveLength(2);
    expect(bySource.get(d)?.duplicate_of).toBeNull();
    expect(bySource.get(d)?.codes).not.toContain('duplicate.found');
  });
});
