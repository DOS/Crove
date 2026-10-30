// SPDX-License-Identifier: AGPL-3.0-only
// The WORM verifier after a restore (issue #2020, after #2007) on a real PostgreSQL 17. A copy of the database made at
// a "backup point" plays the restored database; the original goes on posting past that point, and the worker archives
// it into the same store. Against the copy, before the restore check, the nightly verification fails on every lost
// row. The restore check (restore-report --reseed --acknowledge) writes the acknowledgement of the rows it names to the
// store and records the batches after the backup point; the verification then passes, excusing exactly those rows,
// and the archiver goes on from the store's newest batch. Any other tampering still fails it: a row the restore kept,
// deleted since, is a finding. Only the store holds acknowledgements, so no database role can write one; and a
// deletion dressed up as a restore (the database owner forgets the newest batches and deletes one row of the first of
// them, the later ones still there) is refused by the restore check, which acknowledges nothing.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own databases.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { RESTORE_REPORT_EXIT, numberReseedCommand, runRestoreReport } from '../../src/restore-report.ts';
import { LocalArchiveStore, RESTORE_ACK_PREFIX, archiveKey, verifyArchive, writeArchive, type RestoreAck } from '../../src/worm.ts';
import { contextToken } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

const suite = ADMIN ? describe : describe.skip;

suite('WORM verifier after a restore on PostgreSQL (#2020)', () => {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dbName = `crove_test_worm_restore_${stamp}`;
  const copyName = `crove_test_worm_restored_${stamp}`;
  // A database cloned before anything was archived, with an archive store of its own, for the forged restore.
  const forgedName = `crove_test_worm_forged_${stamp}`;
  let dir = '';
  let forgedDir = '';
  let store: LocalArchiveStore;
  let orgId = '';
  let userId = '';
  const pools: pg.Pool[] = [];

  const urlOf = (name: string, user?: [string, string]) => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${name}`;
    if (user) [url.username, url.password] = user;
    return url.toString();
  };
  const APP: [string, string] = ['crove_app', 'test-app-pw'];
  const WORKER: [string, string] = ['crove_worker', 'test-worker-pw'];
  function dbFor(name: string, user: [string, string]): Db {
    const pool = createPool({ connectionString: urlOf(name, user), max: 2 });
    pools.push(pool);
    return createDb(pool);
  }
  async function client<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  // A journal voucher (NVK) numbered by its trigger, with its entry, in one committed transaction as the owner.
  const journalVoucher = (name: string) =>
    client(urlOf(name, APP), async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description) VALUES ($1, '2026-10-01', 'worm restore') RETURNING id`,
        [orgId],
      );
      const lines = [
        { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
      ];
      await c.query(`SELECT crove_finance.post_journal_entry('2026-10-01'::date, 'worm restore', 'finance.journal_voucher', $1::uuid, $2::jsonb)`, [
        rows[0]!.id,
        JSON.stringify(lines),
      ]);
      await c.query('COMMIT');
    });
  // Everything written in the last 10 minutes of database `name` moves back by `minutes`, past the archiver's lag.
  const age = (name: string, minutes: number) =>
    client(urlOf(name), async (c) => {
      await c.query(`SET session_replication_role = replica`);
      const recent = `> now() - interval '10 minutes'`;
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - make_interval(mins => $1) WHERE occurred_at ${recent}`, [minutes]);
      for (const table of ['crove_finance.journal_entry', 'crove_finance.journal_voucher', 'crove_kernel.number_series']) {
        await c.query(`UPDATE ${table} SET created_at = created_at - make_interval(mins => $1) WHERE created_at ${recent}`, [minutes]);
      }
      await c.query(`UPDATE crove_kernel.number_allocation SET allocated_at = allocated_at - make_interval(mins => $1) WHERE allocated_at ${recent}`, [minutes]);
    });
  const archive = async (name: string) => {
    const worker = dbFor(name, WORKER);
    let written = 0;
    for (let n = await writeArchive(worker, store, { lagSeconds: 60 }); n > 0; n = await writeArchive(worker, store, { lagSeconds: 60 })) written += n;
    return written;
  };
  const batchesInStore = async () => (await store.list('chain/v1/')).length;

  let recordedAtBackup = 0;
  // When the copy was made: the backup point the restore check is given, as restore.sh gives the backup's snapshot time.
  let backupPoint = '';

  beforeAll(async () => {
    await client(ADMIN as string, (c) => c.query(`CREATE DATABASE ${dbName}`));
    await migrate({ adminUrl: urlOf(dbName), dir: MIGRATIONS });
    await setRolePasswords(urlOf(dbName), { crove_app: APP[1], crove_worker: WORKER[1] });
    const db = dbFor(dbName, APP);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'worm-restore', email: 'worm-restore@example.com', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Org worm restore'));
    dir = mkdtempSync(join(tmpdir(), 'crove-worm-restore-'));
    store = new LocalArchiveStore(dir);
    forgedDir = mkdtempSync(join(tmpdir(), 'crove-worm-forged-'));
    await Promise.all(pools.splice(0).map((p) => p.end()));
    await client(ADMIN as string, async (c) => {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
      await c.query(`CREATE DATABASE ${forgedName} TEMPLATE ${dbName}`);
    });

    await journalVoucher(dbName);
    await age(dbName, 120);
    await archive(dbName);
    recordedAtBackup = await batchesInStore();

    // The backup point: a copy of the database, which needs every other session to the original closed.
    await Promise.all(pools.splice(0).map((p) => p.end()));
    backupPoint = new Date().toISOString();
    await client(ADMIN as string, async (c) => {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
      await c.query(`CREATE DATABASE ${copyName} TEMPLATE ${dbName}`);
    });

    // After it, in the original only: a second voucher, archived into the same store.
    await journalVoucher(dbName);
    await age(dbName, 30);
    await archive(dbName);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (forgedDir) rmSync(forgedDir, { recursive: true, force: true });
    if (!ADMIN) return;
    await client(ADMIN, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${forgedName} WITH (FORCE)`);
      await c.query(`DROP DATABASE IF EXISTS ${copyName} WITH (FORCE)`);
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    });
  });

  it('fails the restored database on every lost row until the restore is acknowledged, then passes, excusing exactly those rows', async () => {
    expect(recordedAtBackup).toBeGreaterThan(0);
    const total = await batchesInStore();
    expect(total).toBeGreaterThan(recordedAtBackup);
    const worker = dbFor(copyName, WORKER);

    // Before the restore check: the lost rows are missing, and the batches after the backup point unrecorded.
    const before = await verifyArchive(worker, store);
    expect(before.ok).toBe(false);
    expect(before.problems.some((p) => p.code === 'row_missing' && p.seq > recordedAtBackup)).toBe(true);
    expect(before.problems.every((p) => p.seq > recordedAtBackup)).toBe(true);

    const runtime = new Runtime(worker, { manifests: TEST_MANIFESTS }).register({ commands: [numberReseedCommand()] });
    const lines: string[] = [];
    const code = await runRestoreReport({ db: worker, store, runtime, log: (l) => lines.push(l), error: (l) => lines.push(l), out: () => {} }, [
      '--reseed',
      '--acknowledge',
      '--backup-point',
      backupPoint,
    ]);
    expect(code).toBe(RESTORE_REPORT_EXIT.lost);
    const keys = await store.list(RESTORE_ACK_PREFIX);
    expect(keys).toHaveLength(1);
    const ack = JSON.parse(new TextDecoder().decode((await store.get(keys[0]!)) as Uint8Array)) as RestoreAck;
    expect(ack).toMatchObject({ recordedAtRestore: recordedAtBackup, batchesAtRestore: total });
    expect(ack.refs.length).toBeGreaterThan(0);
    expect(ack.refs.every(([seq]) => seq > recordedAtBackup && seq <= total)).toBe(true);

    const after = await verifyArchive(worker, store);
    expect(after).toMatchObject({ ok: true, problems: [], batches: total });
    expect(after.excused).toBeGreaterThan(0);
    expect(after.excused).toBeLessThanOrEqual(ack.refs.length);

    // The archiver goes on from the store's newest batch: a posting on the restored database is archived after it.
    await journalVoucher(copyName);
    await age(copyName, 5);
    expect(await archive(copyName)).toBeGreaterThan(0);
    expect(await store.get(archiveKey(total + 1))).not.toBeNull();
    expect(await verifyArchive(worker, store)).toMatchObject({ ok: true, problems: [] });
  });

  it("lets only the worker read the restore check's own audit events", async () => {
    const allowed = await client(urlOf(copyName), async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r
         WHERE has_function_privilege(r, 'crove_kernel.archive_reseed_audit(timestamptz)', 'EXECUTE')`,
      );
      return rows.map((r) => r.role);
    });
    expect(allowed).toEqual(['crove_worker']);
  });

  it('still fails on a row the restore kept and that was deleted since', async () => {
    const worker = dbFor(copyName, WORKER);
    // An audit event of a batch the restored database had recorded at the backup point.
    const id = await client(urlOf(copyName), async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT a.id FROM crove_kernel.audit_event a WHERE a.occurred_at < (SELECT window_to FROM crove_kernel.archive_batch WHERE seq = $1)
         ORDER BY a.occurred_at LIMIT 1`,
        [recordedAtBackup],
      );
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query('DELETE FROM crove_kernel.audit_event WHERE id = $1', [rows[0]!.id]);
      await c.query('COMMIT');
      return rows[0]!.id;
    });
    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ code: 'row_missing', ref: `audit:${id}` })]);
    expect(result.problems[0]!.seq).toBeLessThanOrEqual(recordedAtBackup);
  });

  it('refuses a deletion dressed up as a restore, and acknowledges nothing', async () => {
    const forgedStore = new LocalArchiveStore(forgedDir);
    // Batches 10 minutes apart: the org's creation, then four vouchers (the creation may share a voucher's window).
    await age(forgedName, 60);
    for (const minutes of [50, 40, 30, 20]) {
      await journalVoucher(forgedName);
      await age(forgedName, minutes);
    }
    const worker = dbFor(forgedName, WORKER);
    while ((await writeArchive(worker, forgedStore, { lagSeconds: 60 })) > 0);
    const batches = (await forgedStore.list('chain/v1/')).length;
    expect(batches).toBeGreaterThanOrEqual(4);
    expect(await verifyArchive(worker, forgedStore)).toMatchObject({ ok: true, problems: [] });

    // The database owner forgets the batch of the first voucher's journal entry and every later one, and deletes that
    // entry (the vouchers are written in SQL, so their batches hold no audit event); the later vouchers stay.
    const seq = await client(urlOf(forgedName), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      const { rows } = await c.query<{ id: string; seq: string }>(
        `SELECT e.id, b.seq::text AS seq FROM crove_finance.journal_entry e
         JOIN crove_kernel.archive_batch b ON e.created_at >= b.window_from AND e.created_at < b.window_to
         ORDER BY e.created_at LIMIT 1`,
      );
      expect(rows).toHaveLength(1);
      await c.query('DELETE FROM crove_finance.journal_entry WHERE id = $1', [rows[0]!.id]);
      await c.query('DELETE FROM crove_kernel.archive_batch WHERE seq >= $1', [rows[0]!.seq]);
      await c.query('COMMIT');
      return Number(rows[0]!.seq);
    });
    expect(seq).toBeLessThan(batches);
    const runtime = new Runtime(worker, { manifests: TEST_MANIFESTS }).register({ commands: [numberReseedCommand()] });
    const lines: string[] = [];
    // The operator gives the point of the last real backup, before the vouchers.
    const lastBackup = new Date(Date.now() - 55 * 60_000).toISOString();
    const code = await runRestoreReport({ db: worker, store: forgedStore, runtime, log: (l) => lines.push(l), error: (l) => lines.push(l), out: () => {} }, [
      '--reseed',
      '--acknowledge',
      '--backup-point',
      lastBackup,
    ]);
    expect(code).toBe(RESTORE_REPORT_EXIT.failed);
    expect(lines.some((l) => l.startsWith(`[restore-report] PROBLEM: restore_ack_mismatch in batch ${seq}`))).toBe(true);
    expect(await forgedStore.list(RESTORE_ACK_PREFIX)).toEqual([]);
  });
});
