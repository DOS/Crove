// The gapless numbering in the WORM fact stream (issues #1594 and #1596, after #1401) on a real PostgreSQL 17. An archive
// started before the switch holds a version 3 batch; the first version 4 batch takes in every number allocation, void
// and voucher number made before it, later ones their own window, and every batch verifies with its own version. The
// database owner (here a superuser) disables the triggers and rewrites a void's reason, deletes a void, renumbers an
// allocation, moves a series to another legal entity and moves a voucher to another number period: the verifier fails
// on each, on the version 4 batches only.
// Only the worker may run the allocation hashes.
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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const EPOCH = new Date(0).toISOString();

type Row = [string, string];
const byRef = (a: Row, b: Row) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

const suite = ADMIN ? describe : describe.skip;

suite('WORM fact stream: number allocations and voids on PostgreSQL (#1594, #1596)', () => {
  const dbName = `crove_test_worm_allocations_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  // Journal vouchers numbered through their trigger: [voucher id, allocation id].
  const vouchers: Array<[string, string]> = [];
  // Numbers of a series of their own and their voids: [allocation id, void id].
  const voids: Array<[string, string]> = [];

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
      await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
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

  // A journal voucher (NVK) numbered by its trigger, with its entry.
  async function journalVoucher(date: string): Promise<void> {
    const row = await asOwner(async (c) => {
      const { rows } = await c.query<{ id: string; allocation: string }>(
        `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description) VALUES ($1, $2, 'worm numbering')
         RETURNING id, number_allocation_id AS allocation`,
        [orgId, date],
      );
      const v = rows[0]!;
      const lines = [
        { line_no: 1, account_code: '6422', debit: '100000', credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: '100000' },
      ];
      await c.query(`SELECT crove_finance.post_journal_entry($1::date, 'worm numbering', 'finance.journal_voucher', $2::uuid, $3::jsonb)`, [
        date,
        v.id,
        JSON.stringify(lines),
      ]);
      return v;
    });
    vouchers.push([row.id, row.allocation]);
  }

  // A number of a series of its own, then its void.
  async function voidedNumber(): Promise<void> {
    const pair = await asOwner(async (c) => {
      const { rows } = await c.query<{ allocation_id: string }>(
        `SELECT allocation_id FROM crove_kernel.allocate_number(NULL, 'test.worm', '2026-10-01', 'test.record', $1::uuid)`,
        [randomUUID()],
      );
      const allocation = rows[0]!.allocation_id;
      const voided = await c.query<{ id: string }>(`SELECT crove_kernel.void_number($1, 'lập nhầm') AS id`, [allocation]);
      return [allocation, voided.rows[0]!.id] as [string, string];
    });
    voids.push(pair);
  }

  // Everything written so far moves back by `minutes`, past the archiver's lag.
  async function age(minutes: number): Promise<void> {
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      const recent = `> now() - interval '10 minutes'`;
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - make_interval(mins => $1) WHERE occurred_at ${recent}`, [minutes]);
      for (const table of ['crove_finance.journal_entry', 'crove_finance.cash_voucher', 'crove_finance.journal_voucher', 'crove_finance.purchase_document_void']) {
        await c.query(`UPDATE ${table} SET created_at = created_at - make_interval(mins => $1) WHERE created_at ${recent}`, [minutes]);
      }
      await c.query(`UPDATE crove_kernel.number_allocation SET allocated_at = allocated_at - make_interval(mins => $1) WHERE allocated_at ${recent}`, [minutes]);
      await c.query(`UPDATE crove_kernel.number_void SET voided_at = voided_at - make_interval(mins => $1) WHERE voided_at ${recent}`, [minutes]);
    });
  }

  const readBatches = async (keys: string[]) =>
    Promise.all(keys.map(async (k) => JSON.parse(new TextDecoder().decode((await store.get(k)) as Uint8Array)) as ArchiveBatch));

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
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'worm-allocations', email: 'worm-allocations@example.com', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Org numbering'));
    dir = mkdtempSync(join(tmpdir(), 'crove-worm-allocations-'));
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

  it('lets only the worker run the allocation hashes', async () => {
    const allowed = await admin(async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r
         WHERE has_function_privilege(r, 'crove_kernel.archive_allocation_hashes(timestamptz,timestamptz)', 'EXECUTE')`,
      );
      return rows.map((r) => r.role);
    });
    expect(allowed).toEqual(['crove_worker']);
    await expect(sql`SELECT * FROM crove_kernel.archive_allocation_hashes('epoch', now())`.execute(db)).rejects.toThrow(/permission denied/);
  });

  it('anchors the numbers made before the switch in the first version 4 batch, and later ones in their own window', async () => {
    // Before the switch: a voucher and a voided number, archived by a version 3 batch (what #1489 wrote).
    await journalVoucher('2026-10-01');
    await voidedNumber();
    await age(120);
    const v3To = new Date(Date.now() - 90 * 60_000).toISOString();
    const hashes = async (fn: string) =>
      (await sql<{ ref: string; row_sha256: string }>`SELECT ref, row_sha256 FROM ${sql.raw(`crove_kernel.${fn}`)}(${EPOCH}::timestamptz, ${v3To}::timestamptz)`.execute(worker)).rows.map(
        (r): Row => [r.ref, r.row_sha256],
      );
    const v3Rows = [...(await hashes('archive_row_hashes')), ...(await hashes('archive_number_hashes')), ...(await hashes('archive_entity_hashes'))].sort(byRef);
    const v3Hash = batchSha256(v3Rows);
    const v3: ArchiveBatch = {
      format: 'crove-archive',
      version: 3,
      seq: 1,
      window: { from: EPOCH, to: v3To },
      numbersFrom: EPOCH,
      entitiesFrom: EPOCH,
      prevChainSha256: GENESIS_SHA256,
      rows: v3Rows,
      batchSha256: v3Hash,
      chainSha256: chainSha256(GENESIS_SHA256, 1, EPOCH, v3To, v3Hash),
    };
    await store.put(archiveKey(1), new TextEncoder().encode(JSON.stringify(v3)));
    await sql`SELECT crove_kernel.archive_record(1, ${EPOCH}::timestamptz, ${v3To}::timestamptz, ${v3Rows.length}::int, ${v3Hash}, ${v3.chainSha256}, ${archiveKey(1)})`.execute(worker);
    expect(v3Rows.some(([ref]) => ref.startsWith('number:') || ref.startsWith('number_void:') || ref.startsWith('voucher_number:'))).toBe(false);

    // After the switch: another voucher and voided number.
    await journalVoucher('2026-10-02');
    await voidedNumber();
    await age(60);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);

    const keys = await store.list('chain/v1/');
    const batches = await readBatches(keys);
    const [first, second] = batches;
    expect(first?.version).toBe(3);
    expect(second).toMatchObject({ version: 4, numbersFrom: second?.window.from, entitiesFrom: second?.window.from, allocationsFrom: EPOCH });
    batches.slice(2).forEach((b) => expect(b).toMatchObject({ version: 4, allocationsFrom: b.window.from }));
    const refs = batches.flatMap((b) => b.rows.map(([ref]) => ref));
    // Each allocation, void and voucher number once, those made before the switch included.
    for (const [voucher, allocation] of vouchers) {
      expect(refs.filter((r) => r === `voucher_number:journal_voucher:${orgId}:${voucher}`)).toHaveLength(1);
      expect(refs.filter((r) => r === `number:${orgId}:${allocation}`)).toHaveLength(1);
    }
    for (const [allocation, voided] of voids) {
      expect(refs.filter((r) => r === `number:${orgId}:${allocation}`)).toHaveLength(1);
      expect(refs.filter((r) => r === `number_void:${orgId}:${voided}`)).toHaveLength(1);
    }
    // Ground truth: one number row per allocation, one void row per void.
    const counts = await admin(async (c) => ({
      allocations: Number((await c.query(`SELECT count(*) AS n FROM crove_kernel.number_allocation`)).rows[0].n),
      voids: Number((await c.query(`SELECT count(*) AS n FROM crove_kernel.number_void`)).rows[0].n),
    }));
    expect(refs.filter((r) => r.startsWith('number:'))).toHaveLength(counts.allocations);
    expect(refs.filter((r) => r.startsWith('number_void:'))).toHaveLength(counts.voids);

    // A later voucher goes into its own window only.
    await journalVoucher('2026-10-03');
    await age(30);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);
    const after = await readBatches((await store.list('chain/v1/')).slice(keys.length));
    for (const b of after) expect(b).toMatchObject({ version: 4, allocationsFrom: b.window.from });
    expect(after.flatMap((b) => b.rows.map(([ref]) => ref))).toContain(`voucher_number:journal_voucher:${orgId}:${vouchers.at(-1)![0]}`);

    expect(await verifyArchive(worker, store)).toMatchObject({ ok: true, problems: [] });
  });

  it('fails the verifier on the version 4 batches when the database owner rewrites a void, deletes one, renumbers an allocation, moves a series to another entity or moves a voucher to another period', async () => {
    const [[firstVoided, rewritten], [secondVoided, deleted]] = voids as [[string, string], [string, string]];
    const [[movedVoucher, renumbered]] = vouchers as [[string, string]];
    const tables = ['crove_kernel.number_void', 'crove_kernel.number_allocation', 'crove_kernel.number_series', 'crove_finance.journal_voucher'];
    await admin(async (c) => {
      const branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Cần Thơ', 'branch', $2) RETURNING id`, [
          orgId,
          userId,
        ])
      ).rows[0]?.id;
      for (const table of tables) {
        await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      }
      await c.query(`UPDATE crove_kernel.number_void SET reason = 'không có gì' WHERE org_id = $1 AND id = $2`, [orgId, rewritten]);
      await c.query(`DELETE FROM crove_kernel.number_void WHERE org_id = $1 AND id = $2`, [orgId, deleted]);
      await c.query(`UPDATE crove_kernel.number_allocation SET number = number + 100 WHERE org_id = $1 AND id = $2`, [orgId, renumbered]);
      await c.query(`UPDATE crove_finance.journal_voucher SET number_period = '2025' WHERE org_id = $1 AND id = $2`, [orgId, movedVoucher]);
      // The series of the voided numbers moves to the branch; the allocations keep their own entity.
      await c.query(
        `UPDATE crove_kernel.number_series SET legal_entity_id = $3
         WHERE org_id = $1 AND id = (SELECT series_id FROM crove_kernel.number_allocation WHERE org_id = $1 AND id = $2)`,
        [orgId, firstVoided, branch],
      );
      for (const table of tables) {
        await c.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
    });
    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => [p.code, p.ref])).toEqual(
      expect.arrayContaining([
        ['row_changed', `number_void:${orgId}:${rewritten}`],
        ['row_missing', `number_void:${orgId}:${deleted}`],
        ['row_changed', `number:${orgId}:${renumbered}`],
        ['row_changed', `voucher_number:journal_voucher:${orgId}:${movedVoucher}`],
        ['row_changed', `number:${orgId}:${firstVoided}`],
        ['row_changed', `number:${orgId}:${secondVoided}`],
      ]),
    );
    // The version 3 batch, which predates the number rows, still verifies as written.
    expect(result.problems.filter((p) => p.seq === 1)).toEqual([]);
  });
});
