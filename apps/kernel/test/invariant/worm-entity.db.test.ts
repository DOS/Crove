// The legal entity of finance rows in the WORM fact stream (issue #1489, after #1280) on a real PostgreSQL 17. An
// archive started before the switch holds a version 2 batch; the first version 3 batch takes in the legal entity of
// every entry, voucher and void made before it, later ones their own window, and every batch verifies with its own
// version. The database owner (here a superuser) disables the triggers and moves an entry, one of its lines and a
// voucher to another legal entity: the verifier fails on each, on the version 3 batch only. Only the worker may run the
// entity hashes.
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

suite('WORM fact stream: legal entities on PostgreSQL (#1489)', () => {
  const dbName = `crove_test_worm_entity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Db;
  let dir = '';
  let store: LocalArchiveStore;
  let orgId = '';
  let userId = '';
  let defaultEntity = '';
  const entries: string[] = [];
  const vouchers: string[] = [];

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

  // A journal entry in the org's default entity, through the posting path.
  async function post(amount: string): Promise<string> {
    const id = await db.transaction().execute(async (trx) => {
      await sql`SELECT crove_kernel.enter_user_context(${orgId}::uuid, ${contextToken(userId, orgId)}::text)`.execute(trx);
      const lines = [
        { line_no: 1, account_code: '6422', debit: amount, credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: amount },
      ];
      const { rows } = await sql<{ id: string }>`
        SELECT crove_finance.post_journal_entry('2026-10-01', 'worm entity test', 'test', ${randomUUID()}::uuid, ${JSON.stringify(lines)}::jsonb) AS id`.execute(trx);
      return rows[0]?.id as string;
    });
    entries.push(id);
    return id;
  }

  // A cash voucher in the default entity, as a row only: the archive hashes rows, the posting rules have their own
  // tests. Triggers are off for this (replica mode) as only a superuser can do; it is setup, not what is checked.
  async function voucher(number: number, amount: string): Promise<string> {
    const id = randomUUID();
    await admin(async (c) => {
      await c.query(`SET session_replication_role = replica`);
      await c.query(
        `INSERT INTO crove_finance.cash_voucher (org_id, id, voucher_type, number, voucher_date, cash_account, description, amount, legal_entity_id)
         VALUES ($1, $2, 'cash_receipt', $3, '2026-10-01', '1111', 'thu tiền', $4, $5)`,
        [orgId, id, number, amount, defaultEntity],
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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    worker = createDb(workerPool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'worm-entity', email: 'worm-entity@example.com', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Org entity'));
    defaultEntity = await admin(
      async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default`, [orgId])).rows[0]?.id as string,
    );
    dir = mkdtempSync(join(tmpdir(), 'crove-worm-entity-'));
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

  it('lets only the worker run the entity hashes', async () => {
    const allowed = await admin(async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT r AS role FROM unnest(ARRAY['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_prober']) r
         WHERE has_function_privilege(r, 'crove_kernel.archive_entity_hashes(timestamptz,timestamptz)', 'EXECUTE')`,
      );
      return rows.map((r) => r.role);
    });
    expect(allowed).toEqual(['crove_worker']);
    await expect(sql`SELECT * FROM crove_kernel.archive_entity_hashes('epoch', now())`.execute(db)).rejects.toThrow(/permission denied/);
  });

  it('anchors the entities of rows made before the switch in the first version 3 batch, and later ones in their own window', async () => {
    // Before the switch: an entry and a voucher, archived by a version 2 batch (what #977 wrote).
    await post('100000');
    await voucher(1, '100000');
    await age(120);
    const v2To = new Date(Date.now() - 90 * 60_000).toISOString();
    const hashes = async (fn: 'archive_row_hashes' | 'archive_number_hashes') =>
      (await sql<{ ref: string; row_sha256: string }>`SELECT ref, row_sha256 FROM ${sql.raw(`crove_kernel.${fn}`)}(${EPOCH}::timestamptz, ${v2To}::timestamptz)`.execute(worker)).rows.map(
        (r): Row => [r.ref, r.row_sha256],
      );
    const v2Rows = [...(await hashes('archive_row_hashes')), ...(await hashes('archive_number_hashes'))].sort(byRef);
    const v2Hash = batchSha256(v2Rows);
    const v2: ArchiveBatch = {
      format: 'crove-archive',
      version: 2,
      seq: 1,
      window: { from: EPOCH, to: v2To },
      numbersFrom: EPOCH,
      prevChainSha256: GENESIS_SHA256,
      rows: v2Rows,
      batchSha256: v2Hash,
      chainSha256: chainSha256(GENESIS_SHA256, 1, EPOCH, v2To, v2Hash),
    };
    await store.put(archiveKey(1), new TextEncoder().encode(JSON.stringify(v2)));
    await sql`SELECT crove_kernel.archive_record(1, ${EPOCH}::timestamptz, ${v2To}::timestamptz, ${v2Rows.length}::int, ${v2Hash}, ${v2.chainSha256}, ${archiveKey(1)})`.execute(worker);
    expect(v2Rows.some(([ref]) => ref.startsWith('entity:'))).toBe(false);

    // After the switch: another entry and voucher.
    await post('250000');
    await voucher(2, '250000');
    await age(60);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);

    const keys = await store.list('chain/v1/');
    const batches = await readBatches(keys);
    const [first, second] = batches;
    expect(first?.version).toBe(2);
    // Version 3, or a later version that keeps the legal entity rows (version 4 adds the number allocations, #1594).
    expect(second?.version).toBeGreaterThanOrEqual(3);
    expect(second).toMatchObject({ numbersFrom: second?.window.from, entitiesFrom: EPOCH });
    batches.slice(2).forEach((b) => {
      expect(b.version).toBeGreaterThanOrEqual(3);
      expect(b).toMatchObject({ numbersFrom: b.window.from, entitiesFrom: b.window.from });
    });
    const refs = batches.flatMap((b) => b.rows.map(([ref]) => ref));
    // Each entity row once, those of rows made before the switch included; numbers are not anchored twice.
    for (const id of entries) expect(refs.filter((r) => r === `entity:journal:${orgId}:${id}`)).toHaveLength(1);
    for (const id of vouchers) {
      expect(refs.filter((r) => r === `entity:cash_voucher:${orgId}:${id}`)).toHaveLength(1);
      expect(refs.filter((r) => r === `cash_voucher:${orgId}:${id}`)).toHaveLength(1);
    }

    // A later entry goes into its own window only.
    const late = await post('42');
    await age(30);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);
    const after = await readBatches((await store.list('chain/v1/')).slice(keys.length));
    for (const b of after) {
      expect(b.version).toBeGreaterThanOrEqual(3);
      expect(b).toMatchObject({ entitiesFrom: b.window.from });
    }
    expect(after.flatMap((b) => b.rows.map(([ref]) => ref))).toContain(`entity:journal:${orgId}:${late}`);

    const result = await verifyArchive(worker, store);
    expect(result).toMatchObject({ ok: true, problems: [] });
  });

  it('fails the verifier on the version 3 batch when the database owner moves an entry, a line or a voucher to another entity', async () => {
    const [movedEntry, , lineEntry] = entries;
    const [movedVoucher] = vouchers;
    await admin(async (c) => {
      const branch = (
        await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Cần Thơ', 'branch', $2) RETURNING id`, [
          orgId,
          userId,
        ])
      ).rows[0]?.id;
      for (const table of ['crove_finance.journal_entry', 'crove_finance.journal_line', 'crove_finance.cash_voucher']) {
        await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      }
      await c.query(`UPDATE crove_finance.journal_entry SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, movedEntry, branch]);
      await c.query(`UPDATE crove_finance.journal_line SET legal_entity_id = $3 WHERE org_id = $1 AND entry_id = $2`, [orgId, movedEntry, branch]);
      await c.query(`UPDATE crove_finance.journal_line SET legal_entity_id = $3 WHERE org_id = $1 AND entry_id = $2 AND line_no = 2`, [orgId, lineEntry, branch]);
      await c.query(`UPDATE crove_finance.cash_voucher SET legal_entity_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, movedVoucher, branch]);
      for (const table of ['crove_finance.journal_entry', 'crove_finance.journal_line', 'crove_finance.cash_voucher']) {
        await c.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
    });
    const result = await verifyArchive(worker, store);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => [p.code, p.ref])).toEqual(
      expect.arrayContaining([
        ['row_changed', `entity:journal:${orgId}:${movedEntry}`],
        ['row_changed', `entity:journal:${orgId}:${lineEntry}`],
        ['row_changed', `entity:cash_voucher:${orgId}:${movedVoucher}`],
      ]),
    );
    // The version 2 batch, which predates the entity rows, still verifies as written.
    expect(result.problems.filter((p) => p.seq === 1)).toEqual([]);
  });
});
