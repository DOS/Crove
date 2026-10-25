// The posting triggers' lookups stay on narrow indexes during a bulk load (issue #1525) on a real PostgreSQL 17. A batch
// of entries, each with its document, is written in one transaction on a freshly migrated database, where the
// statistics still describe journal_entry as empty, as when a large import or seed runs. The period guard's opening
// entry lookup must not scan the table per entry, and the document entry check at commit must find each entry by its
// source key, not through journal_entry_legal_entity_idx: either one turns the load quadratic. Checked with the
// transaction's own table and index counters, so the test does not depend on the machine's speed.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ENTRIES = 2_000;

const suite = ADMIN ? describe : describe.skip;

suite('finance posting triggers under a bulk load (#1525)', () => {
  const dbName = `crove_test_entry_plans_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let orgId = '';

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const pool = createPool({ connectionString: app.toString(), max: 2 });
    const db = createDb(pool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
    const userId = await upsertIdentity(db, { issuer: 'test', subject: 'entry-plans', email: 'entry-plans@example.com', name: null });
    ({ orgId } = await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, 'Org entry plans'));
    await pool.end();
  }, 120_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('neither scans journal_entry per entry nor checks entries through the legal entity index', async () => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO crove_kernel.party (org_id, name, tax_code) VALUES ($1, 'Công ty Mẫu', '0100000001')`, [orgId]);
      await c.query(
        `CREATE TEMP TABLE seeded ON COMMIT DROP AS
         SELECT g, crove_kernel.uuid_v7() AS doc_id, crove_kernel.uuid_v7() AS entry_id,
                (SELECT p.id FROM crove_kernel.party p WHERE p.org_id = $1) AS party_id,
                DATE '2024-01-01' + (g % 300) AS day, (100000 + g)::numeric AS total
         FROM pg_catalog.generate_series(1, $2::int) g`,
        [orgId, ENTRIES],
      );
      await c.query(
        `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total)
         SELECT $1, doc_id, party_id, '1C26TAA', pg_catalog.lpad(g::text, 8, '0'), day, total, 0, total FROM seeded`,
        [orgId],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id)
         SELECT $1, entry_id, day, 'Mua hàng ' || g, 'finance.purchase_document', doc_id FROM seeded`,
        [orgId],
      );
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit)
         SELECT $1::uuid, entry_id, 1, '6422', total, 0 FROM seeded UNION ALL SELECT $1::uuid, entry_id, 2, '331', 0, total FROM seeded`,
        [orgId],
      );
      // The deferred checks run now, inside the transaction, so its counters include them.
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const table = (
        await c.query<{ seq_scan: string; seq_tup_read: string }>(
          `SELECT seq_scan, seq_tup_read FROM pg_catalog.pg_stat_xact_user_tables WHERE relid = 'crove_finance.journal_entry'::regclass`,
        )
      ).rows[0];
      const entityIndex = (
        await c.query<{ idx_tup_read: string }>(
          `SELECT pg_catalog.pg_stat_get_xact_tuples_returned('crove_finance.journal_entry_legal_entity_idx'::regclass) AS idx_tup_read`,
        )
      ).rows[0];
      await c.query('COMMIT');
      // A lookup that scans the table or walks the entity's index once per entry reads about ENTRIES^2 / 2 rows (two
      // million here). Planned on each call, the opening lookup scans only while the table is a few pages, then reads
      // the partial index: some ten thousand rows in all, whatever the batch size.
      console.log(`#1525: ${table?.seq_tup_read} rows read by sequential scans, ${entityIndex?.idx_tup_read} through the entity index`);
      expect(Number(table?.seq_tup_read ?? 0), 'journal_entry rows read by sequential scans').toBeLessThan(ENTRIES * 25);
      expect(Number(entityIndex?.idx_tup_read ?? 0), 'journal_entry rows read through journal_entry_legal_entity_idx').toBeLessThan(ENTRIES);
    } finally {
      await c.end();
    }
  }, 300_000);
});
