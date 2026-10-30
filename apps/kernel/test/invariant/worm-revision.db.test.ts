// SPDX-License-Identifier: AGPL-3.0-only
// A journal entry's source revision and payload hash in the WORM fact stream (issue #1337, after #1283) on a real
// PostgreSQL 17. An archive started before the switch holds a version 5 batch; the first version 6 batch takes in the
// revision and payload hash of every entry made before it, later ones their own window, and every batch verifies with
// its own version. The database owner (here a superuser) disables the triggers and changes an entry's revision and
// another's payload hash: the verifier fails on each, on the version 6 batches only. Only the worker may run the
// revision hashes.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import {
  GENESIS_SHA256,
  LocalArchiveStore,
  archiveKey,
  batchSha256,
  chainSha256,
  verifyArchive,
  writeArchive,
  type ArchiveBatch,
} from '../../src/worm.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const EPOCH = new Date(0).toISOString();

type Row = [string, string];
const byRef = (a: Row, b: Row) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const LINES = [
  { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
  { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
];
const MIRROR = LINES.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));

const suite = ADMIN ? describe : describe.skip;

suite('WORM fact stream: journal source revisions and payload hashes on PostgreSQL (#1337)', () => {
  const dbName = `crove_test_worm_revision_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Db;
  let dir = '';
  let store: LocalArchiveStore;
  let orgId = '';
  let userId = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const login = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  // Posts one entry in the owner's context through the posting path, committed, and returns its id.
  const post = (source: { type: string; id: string; revision: number }, lines = LINES, reverses: string | null = null) =>
    (async () => {
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
        const { rows } = await c.query<{ id: string }>(
          `SELECT crove_finance.post_journal_entry('2026-10-01'::date, 'worm revision', $1, $2::uuid, $3::jsonb, $4::uuid, $5::int) AS id`,
          [source.type, source.id, JSON.stringify(lines), reverses, source.revision],
        );
        await c.query('COMMIT');
        return rows[0]!.id;
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await c.end();
      }
    })();

  // Everything written so far moves back by `minutes`, past the archiver's lag.
  async function age(minutes: number): Promise<void> {
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      const recent = `> now() - interval '10 minutes'`;
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - make_interval(mins => $1) WHERE occurred_at ${recent}`, [minutes]);
      await c.query(`UPDATE crove_finance.journal_entry SET created_at = created_at - make_interval(mins => $1) WHERE created_at ${recent}`, [minutes]);
    });
  }

  const readBatches = async (keys: string[]) =>
    Promise.all(keys.map(async (k) => JSON.parse(new TextDecoder().decode((await store.get(k)) as Uint8Array)) as ArchiveBatch));

  // Entries by name: before the switch, revision 1 of a source, its reversal and revision 2; after it, another one.
  const entries: Record<string, string> = {};

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    worker = createDb(workerPool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'worm-revision', email: 'worm-revision@example.com', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Org source revisions'));
    dir = mkdtempSync(join(tmpdir(), 'crove-worm-revision-'));
    store = new LocalArchiveStore(dir);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets only the worker run the revision hashes', async () => {
    const allowed = await admin(async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r
         WHERE has_function_privilege(r, 'crove_kernel.archive_revision_hashes(timestamptz,timestamptz)', 'EXECUTE')`,
      );
      return rows.map((r) => r.role);
    });
    expect(allowed).toEqual(['crove_worker']);
    await expect(sql`SELECT * FROM crove_kernel.archive_revision_hashes('epoch', now())`.execute(db)).rejects.toThrow(/permission denied/);
  });

  it('anchors the revisions of entries made before the switch in the first version 6 batch, and later ones in their own window', async () => {
    // Before the switch, archived by a version 5 batch (what #1623 wrote): revision 1 of a source, its reversal and
    // revision 2 of it.
    const source = randomUUID();
    entries.first = await post({ type: 'test.revised', id: source, revision: 1 });
    entries.reversal = await post({ type: 'test.reversal', id: randomUUID(), revision: 1 }, MIRROR, entries.first);
    entries.second = await post({ type: 'test.revised', id: source, revision: 2 });
    await age(120);
    const v5To = new Date(Date.now() - 90 * 60_000).toISOString();
    const hashes = async (fn: string) =>
      (await sql<{ ref: string; row_sha256: string }>`SELECT ref, row_sha256 FROM ${sql.raw(`crove_kernel.${fn}`)}(${EPOCH}::timestamptz, ${v5To}::timestamptz)`.execute(worker)).rows.map(
        (r): Row => [r.ref, r.row_sha256],
      );
    const v5Rows = [
      ...(await hashes('archive_row_hashes')),
      ...(await hashes('archive_number_hashes')),
      ...(await hashes('archive_entity_hashes')),
      ...(await hashes('archive_allocation_hashes')),
      ...(await hashes('archive_series_hashes')),
    ].sort(byRef);
    const v5Hash = batchSha256(v5Rows);
    const v5: ArchiveBatch = {
      format: 'crove-archive',
      version: 5,
      seq: 1,
      window: { from: EPOCH, to: v5To },
      numbersFrom: EPOCH,
      entitiesFrom: EPOCH,
      allocationsFrom: EPOCH,
      seriesFrom: EPOCH,
      prevChainSha256: GENESIS_SHA256,
      rows: v5Rows,
      batchSha256: v5Hash,
      chainSha256: chainSha256(GENESIS_SHA256, 1, EPOCH, v5To, v5Hash),
    };
    await store.put(archiveKey(1), new TextEncoder().encode(JSON.stringify(v5)));
    await sql`SELECT crove_kernel.archive_record(1, ${EPOCH}::timestamptz, ${v5To}::timestamptz, ${v5Rows.length}::int, ${v5Hash}, ${v5.chainSha256}, ${archiveKey(1)})`.execute(worker);
    expect(v5Rows.some(([ref]) => ref.startsWith('revision:'))).toBe(false);

    // After the switch: another entry.
    entries.after = await post({ type: 'test.after', id: randomUUID(), revision: 1 });
    await age(60);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);

    const keys = await store.list('chain/v1/');
    const batches = await readBatches(keys);
    const [first, second] = batches;
    expect(first?.version).toBe(5);
    // Version 6, or a later version that keeps the revision rows.
    expect(second?.version).toBeGreaterThanOrEqual(6);
    expect(second).toMatchObject({ seriesFrom: second?.window.from, revisionsFrom: EPOCH });
    batches.slice(2).forEach((b) => {
      expect(b.version).toBeGreaterThanOrEqual(6);
      expect(b).toMatchObject({ revisionsFrom: b.window.from });
    });
    const refs = batches.flatMap((b) => b.rows.map(([ref]) => ref));
    // Each entry's revision once, those made before the switch included.
    for (const id of Object.values(entries)) expect(refs.filter((r) => r === `revision:journal:${orgId}:${id}`)).toHaveLength(1);
    const count = await admin(async (c) => Number((await c.query(`SELECT count(*) AS n FROM crove_finance.journal_entry`)).rows[0].n));
    expect(refs.filter((r) => r.startsWith('revision:journal:'))).toHaveLength(count);

    // A later entry goes into its own window only.
    entries.later = await post({ type: 'test.later', id: randomUUID(), revision: 1 });
    await age(30);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);
    const after = await readBatches((await store.list('chain/v1/')).slice(keys.length));
    for (const b of after) {
      expect(b.version).toBeGreaterThanOrEqual(6);
      expect(b).toMatchObject({ revisionsFrom: b.window.from });
    }
    expect(after.flatMap((b) => b.rows.map(([ref]) => ref))).toContain(`revision:journal:${orgId}:${entries.later}`);

    expect(await verifyArchive(worker, store)).toMatchObject({ ok: true, problems: [] });
  });

  it("fails the verifier on the version 6 batches when the database owner changes an entry's revision or payload hash", async () => {
    await admin(async (c) => {
      await c.query(`ALTER TABLE crove_finance.journal_entry DISABLE TRIGGER USER`);
      // Revision 2, anchored before the switch, made to read as revision 3.
      await c.query(`UPDATE crove_finance.journal_entry SET source_revision = 3 WHERE org_id = $1 AND id = $2`, [orgId, entries.second]);
      // Another request's payload hash on the entry made after the switch.
      await c.query(`UPDATE crove_finance.journal_entry SET payload_sha256 = sha256('another request') WHERE org_id = $1 AND id = $2`, [orgId, entries.after]);
      await c.query(`ALTER TABLE crove_finance.journal_entry ENABLE TRIGGER USER`);
    });
    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => [p.code, p.ref]).sort()).toEqual(
      [
        ['row_changed', `revision:journal:${orgId}:${entries.after}`],
        ['row_changed', `revision:journal:${orgId}:${entries.second}`],
      ].sort(),
    );
    // The version 5 batch, which predates the revision rows, still verifies as written.
    expect(result.problems.filter((p) => p.seq === 1)).toEqual([]);
  });
});
