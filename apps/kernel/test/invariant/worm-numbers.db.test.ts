// Voucher numbers and voids in the WORM fact stream (plan §4.10, §13 Phase 2a "voided numbers are in the hash chain",
// issue #977) on a real PostgreSQL 17. An archive started before the switch holds a version 1 batch; the first version
// 2 batch takes in every voucher and void made before it, later ones their own window, and every batch verifies with
// its own version. The database owner (here a superuser) renumbers a voucher, changes its amount and drops a void: the
// verifier fails on each. Only the worker may run the number hashes.
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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const EPOCH = new Date(0).toISOString();

const suite = ADMIN ? describe : describe.skip;

suite('WORM fact stream: voucher numbers and voids on PostgreSQL (#977)', () => {
  const dbName = `crove_test_worm_numbers_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Db;
  let dir = '';
  let store: LocalArchiveStore;
  let orgId = '';
  let userId = '';
  const vouchers: string[] = [];
  let voidedDocument = '';

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

  async function post(amount: string): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_context(${userId}::uuid, ${orgId}::uuid)`.execute(trx);
      const lines = [
        { line_no: 1, account_code: '6422', debit: amount, credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: amount },
      ];
      await sql`SELECT crove_finance.post_journal_entry('2026-10-01', 'worm numbers test', 'test', ${randomUUID()}::uuid, ${JSON.stringify(lines)}::jsonb)`.execute(trx);
    });
  }

  // A cash voucher with the next number, as a row only: the archive hashes rows, the posting rules have their own
  // tests. Triggers are off for this (replica mode) as only a superuser can do; it is setup, not what is checked.
  async function voucher(number: number, amount: string): Promise<string> {
    const id = randomUUID();
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(
        `INSERT INTO crove_finance.cash_voucher (org_id, id, voucher_type, number, voucher_date, cash_account, description, amount)
         VALUES ($1, $2, 'cash_receipt', $3, '2026-10-01', '1111', 'thu tiền', $4)`,
        [orgId, id, number, amount],
      );
    });
    vouchers.push(id);
    return id;
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
    });
  }

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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    worker = createDb(workerPool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'worm-numbers', email: 'worm-numbers@example.com', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Org numbers'));
    dir = mkdtempSync(join(tmpdir(), 'crove-worm-numbers-'));
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

  it('lets only the worker run the number hashes', async () => {
    const allowed = await admin(async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r
         WHERE has_function_privilege(r, 'crove_kernel.archive_number_hashes(timestamptz,timestamptz)', 'EXECUTE')`,
      );
      return rows.map((r) => r.role);
    });
    expect(allowed).toEqual(['crove_worker']);
    await expect(sql`SELECT * FROM crove_kernel.archive_number_hashes('epoch', now())`.execute(db)).rejects.toThrow(/permission denied/);
  });

  it('anchors the numbers made before the switch in the first version 2 batch, and later ones in their own window', async () => {
    // Before the switch: an entry and a voucher, archived by a version 1 batch (what #891 wrote).
    await post('100000');
    await voucher(1, '100000');
    await age(120);
    const v1To = new Date(Date.now() - 90 * 60_000).toISOString();
    const v1Rows = (
      await sql<{ ref: string; row_sha256: string }>`SELECT ref, row_sha256 FROM crove_kernel.archive_row_hashes(${EPOCH}::timestamptz, ${v1To}::timestamptz)`.execute(worker)
    ).rows
      .map((r): [string, string] => [r.ref, r.row_sha256])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const v1Hash = batchSha256(v1Rows);
    const v1: ArchiveBatch = {
      format: 'crove-archive',
      version: 1,
      seq: 1,
      window: { from: EPOCH, to: v1To },
      prevChainSha256: GENESIS_SHA256,
      rows: v1Rows,
      batchSha256: v1Hash,
      chainSha256: chainSha256(GENESIS_SHA256, 1, EPOCH, v1To, v1Hash),
    };
    await store.put(archiveKey(1), new TextEncoder().encode(JSON.stringify(v1)));
    await sql`SELECT crove_kernel.archive_record(1, ${EPOCH}::timestamptz, ${v1To}::timestamptz, ${v1Rows.length}::int, ${v1Hash}, ${v1.chainSha256}, ${archiveKey(1)})`.execute(worker);
    expect(v1Rows.some(([ref]) => ref.startsWith('cash_voucher:'))).toBe(false);

    // After the switch: another entry, a voucher, a journal voucher and a void.
    await post('250000');
    await voucher(2, '250000');
    voidedDocument = randomUUID();
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`INSERT INTO crove_finance.journal_voucher (org_id, number, voucher_date, description) VALUES ($1, 1, '2026-10-01', 'kết chuyển')`, [orgId]);
      await c.query(`INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'nhập trùng')`, [orgId, voidedDocument, randomUUID()]);
    });
    await age(60);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);

    const keys = await store.list('chain/v1/');
    const batches = await Promise.all(keys.map(async (k) => JSON.parse(new TextDecoder().decode((await store.get(k)) as Uint8Array)) as ArchiveBatch));
    const [first, second] = batches;
    // Version 2, or a later version that keeps the numbers (version 3 adds the legal entity rows, #1489).
    expect(first?.version).toBe(1);
    expect(second?.version).toBeGreaterThanOrEqual(2);
    expect(second).toMatchObject({ numbersFrom: EPOCH });
    batches.slice(2).forEach((b) => {
      expect(b.version).toBeGreaterThanOrEqual(2);
      expect(b).toMatchObject({ numbersFrom: b.window.from });
    });
    const refs = batches.flatMap((b) => b.rows.map(([ref]) => ref));
    // Each number and void once, the one made before the switch included.
    for (const id of vouchers) expect(refs.filter((r) => r === `cash_voucher:${orgId}:${id}`)).toHaveLength(1);
    expect(refs.filter((r) => r.startsWith('journal_voucher:'))).toHaveLength(1);
    expect(refs.filter((r) => r === `document_void:${orgId}:${voidedDocument}`)).toHaveLength(1);

    // A later voucher goes into its own window only.
    await post('42');
    const late = await voucher(3, '42');
    await age(30);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);
    const after = await Promise.all((await store.list('chain/v1/')).slice(keys.length).map(async (k) => JSON.parse(new TextDecoder().decode((await store.get(k)) as Uint8Array)) as ArchiveBatch));
    for (const b of after) {
      expect(b.version).toBeGreaterThanOrEqual(2);
      expect(b).toMatchObject({ numbersFrom: b.window.from });
    }
    expect(after.flatMap((b) => b.rows.map(([ref]) => ref))).toContain(`cash_voucher:${orgId}:${late}`);

    const result = await verifyArchive(worker, store);
    expect(result).toMatchObject({ ok: true, problems: [] });
  });

  it('fails the verifier when the database owner renumbers a voucher, changes its amount or drops a void', async () => {
    const [renumbered, changed] = vouchers;
    await admin(async (c) => {
      await c.query(`ALTER TABLE crove_finance.cash_voucher DISABLE TRIGGER USER`);
      await c.query(`UPDATE crove_finance.cash_voucher SET number = number + 100 WHERE org_id = $1 AND id = $2`, [orgId, renumbered]);
      await c.query(`UPDATE crove_finance.cash_voucher SET amount = amount + 1 WHERE org_id = $1 AND id = $2`, [orgId, changed]);
      await c.query(`ALTER TABLE crove_finance.cash_voucher ENABLE TRIGGER USER`);
      await c.query(`SET session_replication_role = replica`);
      await c.query(`DELETE FROM crove_finance.purchase_document_void WHERE org_id = $1 AND document_id = $2`, [orgId, voidedDocument]);
    });
    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => [p.code, p.ref])).toEqual(
      expect.arrayContaining([
        ['row_changed', `cash_voucher:${orgId}:${renumbered}`],
        ['row_changed', `cash_voucher:${orgId}:${changed}`],
        ['row_missing', `document_void:${orgId}:${voidedDocument}`],
      ]),
    );
  });
});
