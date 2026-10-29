// The reset policy of the gapless numbering in the WORM fact stream (issue #1623, after #1594 and #1596) on a real
// PostgreSQL 17. An archive started before the switch holds a version 4 batch; the first version 5 batch takes in every
// number series made before it, each with the reset in force for its doc type, later ones their own window, and every
// batch verifies with its own version. A policy restated, or changed before its doc type's first number, changes no
// anchored row. The database owner (here a superuser) disables the triggers and switches a doc type's reset (monthly to
// yearly), deletes a policy row and adds one for a doc type in use: the verifier fails on each, on the version 5
// batches only. A series numbered monthly under a reset switched back to yearly before the archiver anchored it verifies
// as written, and fails as series_period_mismatch (#1811, #1820).
// Only the worker may run the series hashes and the series misfits.
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

const suite = ADMIN ? describe : describe.skip;

suite('WORM fact stream: the number series reset policy on PostgreSQL (#1623)', () => {
  const dbName = `crove_test_worm_policy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  // One transaction in the owner's context, committed.
  async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await c.end();
    }
  }

  const setPolicy = (docType: string, reset: string) =>
    asOwner((c) => c.query(`SELECT crove_kernel.number_series_policy_set(NULL, $1, $2)`, [docType, reset]));

  // A number of the doc type, dated `date`, beside a journal voucher (NVK) with its entry, which archive_next_window
  // cuts windows by; returns the number's series.
  const allocate = (docType: string, date: string) =>
    asOwner(async (c) => {
      const { rows } = await c.query<{ allocation_id: string }>(
        `SELECT allocation_id FROM crove_kernel.allocate_number(NULL, $1, $2::date, 'test.record', $3::uuid)`,
        [docType, date, randomUUID()],
      );
      const voucher = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description) VALUES ($1, $2, 'worm policy') RETURNING id`,
        [orgId, date],
      );
      const lines = [
        { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
      ];
      await c.query(`SELECT crove_finance.post_journal_entry($1::date, 'worm policy', 'finance.journal_voucher', $2::uuid, $3::jsonb)`, [
        date,
        voucher.rows[0]!.id,
        JSON.stringify(lines),
      ]);
      const series = await c.query<{ series_id: string }>(`SELECT series_id FROM crove_kernel.number_allocation WHERE id = $1`, [rows[0]!.allocation_id]);
      return series.rows[0]!.series_id;
    });

  // Everything written so far moves back by `minutes`, past the archiver's lag.
  async function age(minutes: number): Promise<void> {
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      const recent = `> now() - interval '10 minutes'`;
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - make_interval(mins => $1) WHERE occurred_at ${recent}`, [minutes]);
      for (const table of ['crove_finance.journal_entry', 'crove_finance.journal_voucher']) {
        await c.query(`UPDATE ${table} SET created_at = created_at - make_interval(mins => $1) WHERE created_at ${recent}`, [minutes]);
      }
      await c.query(`UPDATE crove_kernel.number_allocation SET allocated_at = allocated_at - make_interval(mins => $1) WHERE allocated_at ${recent}`, [minutes]);
      await c.query(`UPDATE crove_kernel.number_series SET created_at = created_at - make_interval(mins => $1) WHERE created_at ${recent}`, [minutes]);
    });
  }

  const readBatches = async (keys: string[]) =>
    Promise.all(keys.map(async (k) => JSON.parse(new TextDecoder().decode((await store.get(k)) as Uint8Array)) as ArchiveBatch));

  // Series of the test doc types, by name (the journal vouchers beside them have series of their own).
  const series: Record<string, string> = {};

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
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'worm-policy', email: 'worm-policy@example.com', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Org numbering policy'));
    dir = mkdtempSync(join(tmpdir(), 'crove-worm-policy-'));
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

  it('lets only the worker run the series hashes and the series misfits', async () => {
    for (const fn of ['crove_kernel.archive_series_hashes(timestamptz,timestamptz)', 'crove_kernel.archive_series_misfits()']) {
      const allowed = await admin(async (c) => {
        const { rows } = await c.query<{ role: string }>(
          `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r
           WHERE has_function_privilege(r, $1, 'EXECUTE')`,
          [fn],
        );
        return rows.map((r) => r.role);
      });
      expect(allowed, fn).toEqual(['crove_worker']);
    }
    await expect(sql`SELECT * FROM crove_kernel.archive_series_hashes('epoch', now())`.execute(db)).rejects.toThrow(/permission denied/);
    await expect(sql`SELECT * FROM crove_kernel.archive_series_misfits()`.execute(db)).rejects.toThrow(/permission denied/);
  });

  it('anchors the series made before the switch in the first version 5 batch, each with its reset, and later ones in their own window', async () => {
    // Before the switch: a monthly doc type (changed twice before its first number) and a yearly one by default,
    // archived by a version 4 batch (what #1594 wrote).
    await setPolicy('test.monthly', 'yearly');
    await setPolicy('test.monthly', 'monthly');
    series.monthly = await allocate('test.monthly', '2026-10-01');
    series.yearly = await allocate('test.yearly', '2026-10-01');
    await age(120);
    const v4To = new Date(Date.now() - 90 * 60_000).toISOString();
    const hashes = async (fn: string) =>
      (await sql<{ ref: string; row_sha256: string }>`SELECT ref, row_sha256 FROM ${sql.raw(`crove_kernel.${fn}`)}(${EPOCH}::timestamptz, ${v4To}::timestamptz)`.execute(worker)).rows.map(
        (r): Row => [r.ref, r.row_sha256],
      );
    const v4Rows = [
      ...(await hashes('archive_row_hashes')),
      ...(await hashes('archive_number_hashes')),
      ...(await hashes('archive_entity_hashes')),
      ...(await hashes('archive_allocation_hashes')),
    ].sort(byRef);
    const v4Hash = batchSha256(v4Rows);
    const v4: ArchiveBatch = {
      format: 'crove-archive',
      version: 4,
      seq: 1,
      window: { from: EPOCH, to: v4To },
      numbersFrom: EPOCH,
      entitiesFrom: EPOCH,
      allocationsFrom: EPOCH,
      prevChainSha256: GENESIS_SHA256,
      rows: v4Rows,
      batchSha256: v4Hash,
      chainSha256: chainSha256(GENESIS_SHA256, 1, EPOCH, v4To, v4Hash),
    };
    await store.put(archiveKey(1), new TextEncoder().encode(JSON.stringify(v4)));
    await sql`SELECT crove_kernel.archive_record(1, ${EPOCH}::timestamptz, ${v4To}::timestamptz, ${v4Rows.length}::int, ${v4Hash}, ${v4.chainSha256}, ${archiveKey(1)})`.execute(worker);
    expect(v4Rows.some(([ref]) => ref.startsWith('number_series:'))).toBe(false);

    // After the switch: a doc type that never resets, and a second monthly series (another month).
    await setPolicy('test.never', 'never');
    series.never = await allocate('test.never', '2026-10-02');
    series.monthlyNovember = await allocate('test.monthly', '2026-11-02');
    await age(60);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);

    const keys = await store.list('chain/v1/');
    const batches = await readBatches(keys);
    const [first, second] = batches;
    expect(first?.version).toBe(4);
    // Version 5, or a later version that keeps the series rows.
    expect(second?.version).toBeGreaterThanOrEqual(5);
    expect(second).toMatchObject({ allocationsFrom: second?.window.from, seriesFrom: EPOCH });
    batches.slice(2).forEach((b) => {
      expect(b.version).toBeGreaterThanOrEqual(5);
      expect(b).toMatchObject({ seriesFrom: b.window.from });
    });
    const refs = batches.flatMap((b) => b.rows.map(([ref]) => ref));
    // Each series once, those made before the switch included.
    for (const id of Object.values(series)) expect(refs.filter((r) => r === `number_series:${orgId}:${id}`)).toHaveLength(1);
    const count = await admin(async (c) => Number((await c.query(`SELECT count(*) AS n FROM crove_kernel.number_series`)).rows[0].n));
    expect(refs.filter((r) => r.startsWith('number_series:'))).toHaveLength(count);

    // Restating the reset in force, or changing the reset of a doc type without numbers, changes no anchored row.
    await setPolicy('test.monthly', 'monthly');
    await setPolicy('test.unused', 'monthly');
    await setPolicy('test.unused', 'never');
    // A later series goes into its own window only.
    series.later = await allocate('test.later', '2026-10-03');
    await age(30);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);
    const after = await readBatches((await store.list('chain/v1/')).slice(keys.length));
    for (const b of after) {
      expect(b.version).toBeGreaterThanOrEqual(5);
      expect(b).toMatchObject({ seriesFrom: b.window.from });
    }
    expect(after.flatMap((b) => b.rows.map(([ref]) => ref))).toContain(`number_series:${orgId}:${series.later}`);

    expect(await verifyArchive(worker, store)).toMatchObject({ ok: true, problems: [] });
  });

  it("fails the verifier on the version 5 batches when the database owner switches a doc type's reset, deletes its policy or adds one", async () => {
    await admin(async (c) => {
      await c.query(`ALTER TABLE crove_kernel.number_series_policy DISABLE TRIGGER USER`);
      // Monthly to yearly: the doc type's next numbers would start again from 1 in a yearly series.
      await c.query(`UPDATE crove_kernel.number_series_policy SET reset = 'yearly' WHERE org_id = $1 AND doc_type = 'test.monthly'`, [orgId]);
      // Never, by deleting the row, back to the yearly default.
      await c.query(`DELETE FROM crove_kernel.number_series_policy WHERE org_id = $1 AND doc_type = 'test.never'`, [orgId]);
      // A monthly policy for a doc type numbered under the yearly default.
      await c.query(
        `INSERT INTO crove_kernel.number_series_policy (org_id, legal_entity_id, doc_type, reset)
         SELECT org_id, legal_entity_id, 'test.yearly', 'monthly' FROM crove_kernel.number_series WHERE org_id = $1 AND id = $2`,
        [orgId, series.yearly],
      );
      await c.query(`ALTER TABLE crove_kernel.number_series_policy ENABLE TRIGGER USER`);
    });
    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(false);
    const changed = result.problems.filter((p) => p.code === 'row_changed').map((p) => p.ref);
    expect(changed).toEqual(
      expect.arrayContaining([
        `number_series:${orgId}:${series.monthly}`,
        `number_series:${orgId}:${series.monthlyNovember}`,
        `number_series:${orgId}:${series.never}`,
        `number_series:${orgId}:${series.yearly}`,
      ]),
    );
    // Only the series of the three doc types; the series of the untouched one still verifies.
    expect(changed).not.toContain(`number_series:${orgId}:${series.later}`);
    expect(result.problems.every((p) => p.code === 'row_changed' && p.ref?.startsWith('number_series:'))).toBe(true);
    // The version 4 batch, which predates the series rows, still verifies as written.
    expect(result.problems.filter((p) => p.seq === 1)).toEqual([]);
  });

  it('fails the verifier on a series numbered monthly under a reset switched back to yearly before it was anchored (#1811, #1820)', async () => {
    // Monthly before the doc type's first number, as the owner may; the first number opens the series 2026-11.
    await setPolicy('test.planted', 'monthly');
    const planted = await allocate('test.planted', '2026-11-05');
    // The database owner switches the reset back to yearly with the triggers off, inside the archiver's lag.
    await admin(async (c) => {
      await c.query(`ALTER TABLE crove_kernel.number_series_policy DISABLE TRIGGER USER`);
      await c.query(`UPDATE crove_kernel.number_series_policy SET reset = 'yearly' WHERE org_id = $1 AND doc_type = 'test.planted'`, [orgId]);
      await c.query(`ALTER TABLE crove_kernel.number_series_policy ENABLE TRIGGER USER`);
    });
    // Past the lag, after the last batch's window.
    await age(15);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);
    const ref = `number_series:${orgId}:${planted}`;
    const batches = await readBatches(await store.list('chain/v1/'));
    const holder = batches.find((b) => b.rows.some(([r]) => r === ref));
    expect(holder?.version).toBeGreaterThanOrEqual(5);

    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(false);
    // Anchored as {period_key: '2026-11', reset: 'yearly'}, its row verifies as written: only its period key gives it away.
    expect(result.problems.filter((p) => p.ref === ref)).toEqual([{ code: 'series_period_mismatch', seq: holder?.seq, ref }]);
    // The series whose reset was switched after they were anchored are reported as changed rows, not again as misfits.
    expect(result.problems.filter((p) => p.code === 'series_period_mismatch')).toHaveLength(1);
  });
});
