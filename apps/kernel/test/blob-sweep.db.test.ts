// The inbound blob sweep (issue #212) on a real PostgreSQL 17 with the pg-boss schema and local disk: an old raw
// message is deleted only when no inbound_pending row and no live job of the inbound queue references it. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { BlobNotFoundError, LocalDiskStore, inboundKey, newInboundBlobId, sha256Hex } from '@crove/kernel-runtime';
import { INBOUND_BLOB_MAX_AGE_DAYS, sweepInboundBlobs } from '../src/retention.ts';
import { QUEUES, migrateJobs } from '../src/worker.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('inbound blob sweep on PostgreSQL (#212)', () => {
  const dbName = `crove_test_blob_sweep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
  let workerDb: Db;
  let root = '';
  let store: LocalDiskStore;
  const silent = { log: () => {}, error: () => {} };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // A raw message stored the way the API stores it, last modified `days` ago.
  async function storedMail(days: number): Promise<{ id: string; key: string; sha256: string }> {
    const id = newInboundBlobId();
    const bytes = new TextEncoder().encode(`From: a@example.com\r\nSubject: ${id}\r\n\r\nhello`);
    await store.put(inboundKey(id), bytes);
    const when = new Date(Date.now() - days * 86_400_000);
    await utimes(join(root, inboundKey(id)), when, when);
    return { id, key: inboundKey(id), sha256: sha256Hex(bytes) };
  }

  const exists = async (key: string) =>
    store.get(key).then(
      () => true,
      (error: unknown) => {
        if (error instanceof BlobNotFoundError) return false;
        throw error;
      },
    );

  const job = (blobId: string, state: string) =>
    admin((c) =>
      c.query(`INSERT INTO crove_jobs.job (name, data, state, singleton_key) VALUES ($1, $2, $3::crove_jobs.job_state, $4)`, [
        QUEUES.inbound,
        { blobId, sha256: 'x', sizeBytes: 1, recipient: null },
        state,
        blobId,
      ]),
    );

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`CREATE DATABASE ${dbName}`);
    await rootClient.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    await migrateJobs(adminUrl);
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appPool = createPool({ connectionString: loginUrl('crove_app', 'test-app-pw'), max: 2 });
    workerPool = createPool({ connectionString: loginUrl('crove_worker', 'test-worker-pw'), max: 2 });
    appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    root = await mkdtemp(join(tmpdir(), 'crove-blob-sweep-'));
    store = new LocalDiskStore(root);
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (root) await rm(root, { recursive: true, force: true });
    if (!ADMIN) return;
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootClient.end();
  });

  it('deletes only old raw mail that no pending row or live job references', async () => {
    const old = INBOUND_BLOB_MAX_AGE_DAYS + 5;
    // Stored by the API and not claimed yet.
    const pending = await storedMail(old);
    const enqueued = await sql<{ ok: boolean }>`
      SELECT crove_kernel.inbound_enqueue(${pending.id}, ${pending.sha256}, ${10}::bigint, ${'in@x.test'}) AS ok`.execute(appDb);
    expect(enqueued.rows[0]?.ok).toBe(true);
    // Claimed and queued, waiting or being retried or running.
    const queued = await storedMail(old);
    await job(queued.id, 'created');
    const retrying = await storedMail(old);
    await job(retrying.id, 'retry');
    const running = await storedMail(old);
    await job(running.id, 'active');
    // Leftovers: the last attempt failed, a finished job whose delete was lost, and mail nobody knows.
    const failed = await storedMail(old);
    await job(failed.id, 'failed');
    const completed = await storedMail(old);
    await job(completed.id, 'completed');
    const orphan = await storedMail(old);
    // Young leftovers stay, whatever references them.
    const young = await storedMail(INBOUND_BLOB_MAX_AGE_DAYS - 1);

    const result = await sweepInboundBlobs(store, workerDb, new Date(), silent, { pageSize: 3 });
    expect(result).toEqual({ deleted: 3, kept: 4, more: false });
    for (const kept of [pending, queued, retrying, running, young]) expect(await exists(kept.key)).toBe(true);
    for (const gone of [failed, completed, orphan]) expect(await exists(gone.key)).toBe(false);

    // Once its row is claimed and its job finished, the pending message goes on the next run.
    await sql`SELECT * FROM crove_kernel.inbound_claim(100)`.execute(workerDb);
    await expect(sweepInboundBlobs(store, workerDb, new Date(), silent)).resolves.toEqual({ deleted: 1, kept: 3, more: false });
    expect(await exists(pending.key)).toBe(false);
  });

  it('keeps the pending check to the worker', async () => {
    const { rows } = await admin((c) =>
      c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_tenant', 'crove_definer_tenant', 'crove_worker']) r
         WHERE has_function_privilege(r, 'crove_kernel.inbound_pending_blobs(text[])', 'EXECUTE')`,
      ),
    );
    expect(rows.map((r) => r.role)).toEqual(['crove_worker']);
    await expect(sql`SELECT crove_kernel.inbound_pending_blobs(ARRAY['x'])`.execute(appDb)).rejects.toThrow(/permission denied/);
    await expect(sql`SELECT crove_kernel.inbound_pending_blobs(array_fill('x'::text, ARRAY[10001]))`.execute(workerDb)).rejects.toThrow(/TOO_MANY_BLOB_IDS/);
  });
});
