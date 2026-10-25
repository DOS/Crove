// The books per legal entity (issue #1280, part 1) on a real PostgreSQL 17. The database is migrated up to the file
// before 20261102060000, given a ledger of a few thousand rows and a WORM batch over it, then migrated to the end: every
// finance row lands in its org's default entity, the archived batch still verifies, and the rewrite's cost is printed.
// After it: new rows take their parent's entity or the default one, a mismatch or a change is refused, a member limited
// to one entity reads and writes only that entity's books, rules are unique per entity, and the nightly comparison
// reports a delta whose entity is not its entry's.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { findPeriodBalanceDifferences } from '../src/period-balance.ts';
import { LocalArchiveStore, verifyArchive, writeArchive } from '../src/worm.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const THIS_VERSION = '20261102060000';
// Entries posted before the migration, two lines and two deltas each.
const LEGACY_ENTRIES = 1500;
const PER_ENTITY = [
  'crove_finance.journal_entry',
  'crove_finance.journal_line',
  'crove_finance.period_balance_delta',
  'crove_finance.cash_voucher',
  'crove_finance.journal_voucher',
  'crove_finance.purchase_document',
  'crove_finance.purchase_line',
  'crove_finance.purchase_tax_rate',
  'crove_finance.purchase_document_void',
  'crove_finance.input_vat_check',
  'crove_finance.bank_line',
  'crove_finance.fixed_asset',
  'crove_finance.depreciation_line',
  'crove_finance.portal_invoice_list',
  'crove_finance.portal_invoice_row',
  'crove_finance.categorization_rule',
];
const RLS_DENIED = /new row violates row-level security policy/;

const suite = ADMIN ? describe : describe.skip;

suite('finance books per legal entity (#1280)', () => {
  const dbName = `crove_test_finance_le_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let worker: Db;
  let before = '';
  let archiveDir = '';
  let store: LocalArchiveStore;
  let orgId = '';
  let owner = '';
  let member = '';
  let defaultEntity = '';
  let branch = '';
  let rewriteMs = 0;

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

  // Runs fn as crove_app in the context of userId, in one transaction that rolls back unless commit is set.
  async function asUser<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>, commit = false): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      const result = await fn(c);
      await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const post = (c: pg.PoolClient, amount: string, date = '2026-09-15') =>
    c.query<{ id: string }>(`SELECT crove_finance.post_journal_entry($1::date, 'le test', 'test.le', $2::uuid, $3::jsonb, NULL::uuid, 1) AS id`, [
      date,
      randomUUID(),
      JSON.stringify([
        { line_no: 1, account_code: '6422', debit: amount, credit: '0' },
        { line_no: 2, account_code: '331', debit: '0', credit: amount },
      ]),
    ]);

  // An entry of the branch, written by the database owner (the posting path takes no entity yet, #1280 part 2): the
  // header names the branch, its lines name none and take it from the header.
  const branchEntry = (amount: string) =>
    admin(async (a) => {
      await a.query('BEGIN');
      const { rows } = await a.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id)
         VALUES ($1, '2026-09-20', 'branch', 'test.branch', $2, $3) RETURNING id`,
        [orgId, randomUUID(), branch],
      );
      const entry = rows[0]?.id as string;
      await a.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '1111', $3, 0), ($1, $2, 2, '5111', 0, $3)`, [
        orgId,
        entry,
        amount,
      ]);
      await a.query('COMMIT');
      return entry;
    });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    // The database as it was before this migration.
    before = mkdtempSync(join(tmpdir(), 'crove-le-before-'));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n.slice(0, 14) < THIS_VERSION)) {
      copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
    await migrate({ adminUrl, dir: before });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 1 });
    worker = createDb(workerPool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@le-books.test', name: null });
    member = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'member@le-books.test', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Sổ theo pháp nhân'));
    await admin(async (a) => {
      defaultEntity = (await a.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await a.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      await a.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member]);
      // The member keeps the branch's books only (an entity-scoped assignment narrows enter_context's le_scope).
      await a.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        member,
        branch,
        owner,
      ]);
    });

    // The ledger before the migration, then a WORM batch over it.
    await asUser(
      owner,
      async (c) => {
        for (let i = 0; i < LEGACY_ENTRIES; i++) await post(c, String(1000 + i));
      },
      true,
    );
    await admin(async (a) => {
      await a.query('SET session_replication_role = replica');
      await a.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '2 hours' WHERE org_id = $1`, [orgId]);
      await a.query(`UPDATE crove_finance.journal_entry SET created_at = created_at - interval '2 hours' WHERE org_id = $1`, [orgId]);
    });
    archiveDir = mkdtempSync(join(tmpdir(), 'crove-le-archive-'));
    store = new LocalArchiveStore(archiveDir);
    expect(await writeArchive(worker, store, { lagSeconds: 600 })).toBeGreaterThan(0);

    const started = performance.now();
    const applied = await migrate({ adminUrl, dir: MIGRATIONS });
    rewriteMs = performance.now() - started;
    expect(applied.some((v) => v.startsWith(THIS_VERSION))).toBe(true);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (before) rmSync(before, { recursive: true, force: true });
    if (archiveDir) rmSync(archiveDir, { recursive: true, force: true });
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('puts every row posted before it in the default entity, without an UPDATE, and keeps the column NOT NULL', async () => {
    console.info(`#1280 backfill: ${LEGACY_ENTRIES} entries, ${LEGACY_ENTRIES * 2} lines and deltas rewritten in ${Math.round(rewriteMs)} ms (whole migrate run)`);
    await admin(async (a) => {
      const counts = await a.query<{ entries: string; lines: string; deltas: string }>(
        `SELECT (SELECT count(*) FROM crove_finance.journal_entry WHERE org_id = $1 AND legal_entity_id = $2) AS entries,
                (SELECT count(*) FROM crove_finance.journal_line WHERE org_id = $1 AND legal_entity_id = $2) AS lines,
                (SELECT count(*) FROM crove_finance.period_balance_delta WHERE org_id = $1 AND legal_entity_id = $2) AS deltas`,
        [orgId, defaultEntity],
      );
      expect(counts.rows[0]).toEqual({ entries: String(LEGACY_ENTRIES), lines: String(LEGACY_ENTRIES * 2), deltas: String(LEGACY_ENTRIES * 2) });
      for (const table of PER_ENTITY) {
        const [schema, name] = table.split('.');
        const { rows } = await a.query<{ notnull: boolean; restrictive: boolean; fk: boolean; always: boolean }>(
          `SELECT a.attnotnull AS notnull,
                  EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = $1::regclass AND p.polname = 'le_scope' AND NOT p.polpermissive) AS restrictive,
                  EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f' AND c.confrelid = 'crove_kernel.legal_entity'::regclass) AS fk,
                  EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND t.tgname = 'b_legal_entity' AND t.tgenabled = 'A') AS always
           FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = 'legal_entity_id'`,
          [table],
        );
        expect(rows[0], `${schema}.${name}`).toEqual({ notnull: true, restrictive: true, fk: true, always: true });
        const off = await a.query(`SELECT 1 FROM ${table} WHERE legal_entity_id IS DISTINCT FROM crove_finance.org_default_legal_entity(org_id) LIMIT 1`);
        expect(off.rowCount, `${table} rows outside the default entity`).toBe(0);
      }
    });
  });

  it('leaves the WORM batch written before it verifying', async () => {
    expect(await verifyArchive(worker, store)).toMatchObject({ ok: true, problems: [] });
  });

  it('gives a new row its parent entity or the default one, and refuses a mismatch or a change', async () => {
    const entry = await branchEntry('500000');
    await admin(async (a) => {
      const lines = await a.query<{ legal_entity_id: string }>('SELECT DISTINCT legal_entity_id FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2', [orgId, entry]);
      expect(lines.rows).toEqual([{ legal_entity_id: branch }]);
      // A line naming another entity than its entry's.
      await a.query('BEGIN');
      const other = (
        await a.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, '2026-09-21', 'x', 'test.mismatch', $2, $3) RETURNING id`,
          [orgId, randomUUID(), branch],
        )
      ).rows[0]?.id;
      await expect(
        a.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, legal_entity_id) VALUES ($1, $2, 1, '1111', 1, 0, $3)`, [
          orgId,
          other,
          defaultEntity,
        ]),
      ).rejects.toMatchObject({ code: '23514', message: 'LEGAL_ENTITY_MISMATCH' });
      await a.query('ROLLBACK');
    });
    // Posted by the owner without an entity: the default one, lines and deltas alike.
    const id = await asUser(owner, async (c) => (await post(c, '70000')).rows[0]?.id as string, true);
    await admin(async (a) => {
      const { rows } = await a.query<{ t: string; legal_entity_id: string }>(
        `SELECT 'entry' AS t, legal_entity_id FROM crove_finance.journal_entry WHERE org_id = $1 AND id = $2
         UNION SELECT 'line', legal_entity_id FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2
         UNION SELECT 'delta', legal_entity_id FROM crove_finance.period_balance_delta WHERE org_id = $1 AND entry_id = $2 ORDER BY 1`,
        [orgId, id],
      );
      expect(rows).toEqual([
        { t: 'delta', legal_entity_id: defaultEntity },
        { t: 'entry', legal_entity_id: defaultEntity },
        { t: 'line', legal_entity_id: defaultEntity },
      ]);
      // The entity never changes, for any writer.
      const rule = (
        await a.query<{ id: string }>(
          `INSERT INTO crove_finance.categorization_rule (org_id, match_kind, match_text, debit_account) VALUES ($1, 'keyword', 'van phong pham', '6422') RETURNING id`,
          [orgId],
        )
      ).rows[0]?.id;
      await expect(a.query('UPDATE crove_finance.categorization_rule SET legal_entity_id = $2 WHERE id = $1', [rule, branch])).rejects.toMatchObject({
        code: '23514',
        message: 'LEGAL_ENTITY_IMMUTABLE',
      });
    });
  });

  it('keeps rules unique per entity, not per org', async () => {
    await admin(async (a) => {
      const insert = (entity: string) =>
        a.query(`INSERT INTO crove_finance.categorization_rule (org_id, legal_entity_id, match_kind, match_text, debit_account) VALUES ($1, $2, 'keyword', 'cuoc dien thoai', '6422')`, [
          orgId,
          entity,
        ]);
      await insert(defaultEntity);
      await insert(branch);
      await expect(insert(branch)).rejects.toMatchObject({ code: '23505', constraint: 'categorization_rule_match_uq' });
    });
  });

  it('shows a member limited to the branch only the branch books, and refuses their writes elsewhere', async () => {
    const entry = await branchEntry('120000');
    const seen = await asUser(member, async (c) => {
      const entities = (await c.query<{ id: string }>('SELECT DISTINCT legal_entity_id AS id FROM crove_finance.journal_entry')).rows.map((r) => r.id);
      const lines = (await c.query<{ id: string }>('SELECT DISTINCT legal_entity_id AS id FROM crove_finance.journal_line')).rows.map((r) => r.id);
      const own = (await c.query('SELECT 1 FROM crove_finance.journal_entry WHERE id = $1', [entry])).rowCount;
      return { entities, lines, own };
    });
    expect(seen).toEqual({ entities: [branch], lines: [branch], own: 1 });
    // The owner sees both entities.
    const ownerSees = await asUser(owner, async (c) => (await c.query<{ id: string }>('SELECT DISTINCT legal_entity_id AS id FROM crove_finance.journal_entry ORDER BY 1')).rows.map((r) => r.id));
    expect(ownerSees).toEqual([defaultEntity, branch].sort());
    // Posting without an entity books in the default entity, which the member cannot see: refused, nothing written.
    await expect(asUser(member, (c) => post(c, '5000'))).rejects.toThrow(RLS_DENIED);
    // Naming the default entity on a top-level row is refused the same way.
    await expect(
      asUser(member, (c) =>
        c.query(`INSERT INTO crove_finance.categorization_rule (org_id, legal_entity_id, match_kind, match_text, debit_account) VALUES ($1, $2, 'keyword', 'phi ngan hang', '6422')`, [
          orgId,
          defaultEntity,
        ]),
      ),
    ).rejects.toThrow(RLS_DENIED);
  });

  it('reports a balance delta whose entity is not its entry’s', async () => {
    const entry = await branchEntry('99000');
    // A delta written around the trigger, by the database owner, naming the default entity for the branch entry.
    await admin(async (a) => {
      await a.query('ALTER TABLE crove_finance.period_balance_delta DISABLE TRIGGER b_legal_entity');
      try {
        await a.query(
          `INSERT INTO crove_finance.period_balance_delta (org_id, entry_id, account_code, period_month, debit, credit, line_count, legal_entity_id)
           VALUES ($1, $2, '1111', '2026-09-01', 99000, 0, 1, $3), ($1, $2, '5111', '2026-09-01', 0, 99000, 1, $4)`,
          [orgId, entry, defaultEntity, branch],
        );
      } finally {
        await a.query('ALTER TABLE crove_finance.period_balance_delta ENABLE ALWAYS TRIGGER b_legal_entity');
      }
    });
    const differences = (await findPeriodBalanceDifferences(worker)).filter((d) => d.entryId === entry);
    expect(differences).toEqual([expect.objectContaining({ accountCode: '1111', mismatch: ['legal_entity'] })]);
  });
});
