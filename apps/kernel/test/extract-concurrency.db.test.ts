// SPDX-License-Identifier: AGPL-3.0-only
// The extract queue runs documents in parallel up to the extract client's slots and never past them (#2119): files
// uploaded through the outbox and the worker, an AI reader that takes a while, and the most calls it ever sees at once.
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
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { startWorker } from '../src/worker.ts';
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

suite('parallel extraction on PostgreSQL (#2119)', () => {
  const dbName = `crove_test_excc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl: string;
  let workerUrl: string;
  let pool: pg.Pool;
  let runtime: Runtime;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  let owner = '';
  let orgA = '';
  let base: ParsedInvoice;
  // A number of its own for every document read, across both runs, so none is taken for a duplicate.
  let numbers = 9000;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const extractClient = (concurrency: number): ExtractClient => {
    const app = createExtractApp({ concurrency: 8 });
    return createExtractClient({ url: 'http://crove-extract.test', concurrency, fetch: async (input, init) => app.fetch(new Request(input, init)) });
  };

  // An AI reader that takes `ms` per document and remembers the most documents it had in hand at once. The first `slots`
  // reads wait (up to 5 s) until that many are in hand, so reaching the limit does not depend on when the relay queued the
  // jobs; a limit that was not enforced would still show as a larger maximum.
  function slowReader(ms: number, slots: number) {
    const state = { inFlight: 0, max: 0, calls: 0 };
    const read = async () => {
      state.calls += 1;
      const first = state.calls <= slots;
      state.inFlight += 1;
      state.max = Math.max(state.max, state.inFlight);
      const deadline = Date.now() + 5_000;
      while (first && state.inFlight < slots && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, ms));
      state.inFlight -= 1;
      numbers += 1;
      return { ...base, number: String(numbers) };
    };
    return { state, ai: { fromText: read, fromImage: read } as unknown as InvoiceExtractor };
  }

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

  const statusOf = async (fileId: string) =>
    (await runtime.query<Array<{ id: string; status: string }>>('kernel.files.recent', {}, { actor: asUser(owner), orgId: orgA })).find((f) => f.id === fileId)?.status;

  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 80_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the worker');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  beforeAll(async () => {
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
    workerUrl = loginUrl('crove_worker', 'test-worker-pw');
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    pool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 4 });
    runtime = register(createDb(pool));
    workerPool = createPool({ connectionString: workerUrl, max: 8 });
    workerDb = createDb(workerPool);
    workerRuntime = register(workerDb);
    owner = await upsertIdentity(createDb(pool), { issuer: 'test', subject: 'excc-owner', email: 'excc-owner@example.com', name: null });
    orgA = (await createOrg(runtime, asUser(owner), 'Org A')).orgId;
    const parsed = await extractClient(1).extract('einvoice_xml', FIXTURE);
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

  async function readAll(concurrency: number, files: number) {
    const reader = slowReader(400, concurrency);
    const ids: string[] = [];
    for (let i = 0; i < files; i++) ids.push(await upload());
    const stop = await startWorker({ connectionString: workerUrl, workerDb, runtime: workerRuntime, store, extractor: reader.ai, extract: extractClient(concurrency), inboundDomain: null });
    try {
      await until(async () => (await Promise.all(ids.map(statusOf))).every((s) => s === 'proposed'));
    } finally {
      await stop();
    }
    return reader.state;
  }

  it('reads documents at the same time, up to the extract client slots and never past them', { timeout: 150_000 }, async () => {
    const parallel = await readAll(3, 9);
    expect(parallel.calls).toBe(9);
    expect(parallel.max).toBe(3);
  });

  it('reads one at a time with one slot, as before', { timeout: 150_000 }, async () => {
    const serial = await readAll(1, 3);
    expect(serial.calls).toBe(3);
    expect(serial.max).toBe(1);
  });
});
