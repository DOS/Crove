// Per-currency amount scale and the fx_rate domain (issue #1282, ADR-0021 decision 1) on a real PostgreSQL 17: the
// currency reference table, read by every runtime role and written by none; exchange rates typed crove_finance.fx_rate;
// and crove_finance.post_journal_entry() refusing an amount with more decimals than the org's book currency uses
// (AMOUNT_SCALE, 22023), where numeric(20,4) would have kept or rounded it silently. Also the read-only query that
// lists rows posted before the rule which break it (the migration's header carries the same query).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { CURRENCY_MINOR_UNITS } from '@crove/mod-finance';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant'];

// The read-only check of #1282: journal lines with more decimals than their org's book currency uses, and purchase
// documents with fractional VND amounts. Same text as in 20261030000100_crove_finance_currency_scale.sql.
const BREAKING_ROWS = `
  SELECT 'journal_line' AS source, l.org_id, l.entry_id AS id, l.line_no, t.base_currency AS currency, l.debit, l.credit
  FROM crove_finance.journal_line l
  JOIN crove_kernel.tenant t ON t.org_id = l.org_id
  LEFT JOIN crove_kernel.currency c ON c.code = t.base_currency
  WHERE c.code IS NULL OR l.debit <> pg_catalog.round(l.debit, c.minor_units) OR l.credit <> pg_catalog.round(l.credit, c.minor_units)
  UNION ALL
  SELECT 'purchase_document', d.org_id, d.id, NULL, 'VND', d.subtotal, d.total
  FROM crove_finance.purchase_document d
  WHERE d.subtotal <> pg_catalog.round(d.subtotal, 0) OR d.vat_amount <> pg_catalog.round(d.vat_amount, 0)
     OR d.total <> pg_catalog.round(d.total, 0)`;

type Line = { line_no: number; account_code: string; debit: string; credit: string };
const pair = (amount: string): Line[] => [
  { line_no: 1, account_code: '6422', debit: amount, credit: '0' },
  { line_no: 2, account_code: '331', debit: '0', credit: amount },
];

const suite = ADMIN ? describe : describe.skip;

suite('currency amount scale (#1282)', () => {
  const dbName = `crove_test_currency_scale_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let userId = '';
  const orgs = { vnd: '', usd: '', unknown: '' };

  async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const withAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(adminUrl, fn);

  // Posts as the API login role in the org's context and commits; the error, if any, with nothing left behind.
  async function post(orgId: string, lines: Line[]): Promise<{ id: string } | { error: { code?: string; message: string; detail?: string } }> {
    return withClient(appUrl, async (app) => {
      await app.query('BEGIN');
      try {
        await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
        const { rows } = await app.query<{ id: string }>(
          `SELECT crove_finance.post_journal_entry('2026-10-01', 'scale', 'test', $1::uuid, $2::jsonb) AS id`,
          [randomUUID(), JSON.stringify(lines)],
        );
        await app.query('COMMIT');
        return { id: rows[0]?.id ?? '' };
      } catch (error) {
        await app.query('ROLLBACK').catch(() => {});
        return { error: error as { code?: string; message: string; detail?: string } };
      }
    });
  }

  const linesOf = (orgId: string) =>
    withAdmin(async (c) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.journal_line WHERE org_id = $1', [orgId])).rows[0]?.n);

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 1 });
    const db = createDb(pool);
    const runtime = new Runtime(db).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'currency-scale', email: 'scale@currency.test', name: null });
    const actor = { type: 'user' as const, userId, aal: 'aal1' as const };
    orgs.vnd = (await createOrg(runtime, actor, 'Scale VND')).orgId;
    orgs.usd = (await createOrg(runtime, actor, 'Scale USD')).orgId;
    orgs.unknown = (await createOrg(runtime, actor, 'Scale Unknown')).orgId;
    // No command sets a book currency yet; the database owner stands in for one.
    await withAdmin(async (c) => {
      await c.query(`UPDATE crove_kernel.tenant SET base_currency = 'USD' WHERE org_id = $1`, [orgs.usd]);
      await c.query(`UPDATE crove_kernel.tenant SET base_currency = 'XTS' WHERE org_id = $1`, [orgs.unknown]);
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('finds no row that breaks the rule on a freshly migrated database', async () => {
    expect((await withAdmin((c) => c.query(BREAKING_ROWS))).rows).toEqual([]);
  });

  it('holds the minor units the TypeScript money model uses, readable by every runtime role and written by none', async () => {
    const rows = await withAdmin(async (c) => (await c.query<{ code: string; minor_units: number }>('SELECT code, minor_units FROM crove_kernel.currency ORDER BY code')).rows);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.minor_units]))).toEqual(CURRENCY_MINOR_UNITS);

    const grants = await withAdmin(async (c) =>
      (
        await c.query<{ role: string; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }>(
          `SELECT r AS role,
                  pg_catalog.has_table_privilege(r, 'crove_kernel.currency', 'SELECT') AS sel,
                  pg_catalog.has_table_privilege(r, 'crove_kernel.currency', 'INSERT') AS ins,
                  pg_catalog.has_table_privilege(r, 'crove_kernel.currency', 'UPDATE') AS upd,
                  pg_catalog.has_table_privilege(r, 'crove_kernel.currency', 'DELETE') AS del,
                  pg_catalog.has_table_privilege(r, 'crove_kernel.currency', 'TRUNCATE') AS trunc
           FROM unnest($1::text[]) r ORDER BY r`,
          [ROLES],
        )
      ).rows,
    );
    expect(grants).toEqual([...ROLES].sort().map((role) => ({ role, sel: true, ins: false, upd: false, del: false, trunc: false })));

    // Immutable once published: not even the owner changes or removes a currency.
    await withAdmin(async (c) => {
      await expect(c.query(`UPDATE crove_kernel.currency SET minor_units = 2 WHERE code = 'VND'`)).rejects.toThrow();
      await expect(c.query(`DELETE FROM crove_kernel.currency WHERE code = 'VND'`)).rejects.toThrow();
      await expect(c.query('TRUNCATE crove_kernel.currency')).rejects.toThrow();
      await expect(c.query(`INSERT INTO crove_kernel.currency (code, minor_units) VALUES ('XAU', 5)`)).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`INSERT INTO crove_kernel.currency (code, minor_units) VALUES ('usd', 2)`)).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('types exchange rates as fx_rate: numeric(24,10), positive', async () => {
    await withAdmin(async (c) => {
      const { rows } = await c.query<{ type: string }>(
        `SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS type FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'crove_finance.purchase_document'::regclass AND a.attname = 'exchange_rate'`,
      );
      expect(rows[0]?.type).toBe('crove_finance.fx_rate');
      const domain = await c.query<{ base: string; checks: string[] }>(
        `SELECT pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base,
                ARRAY(SELECT pg_catalog.pg_get_constraintdef(k.oid) FROM pg_catalog.pg_constraint k WHERE k.contypid = t.oid) AS checks
         FROM pg_catalog.pg_type t WHERE t.oid = 'crove_finance.fx_rate'::regtype`,
      );
      expect(domain.rows[0]).toEqual({ base: 'numeric(24,10)', checks: ['CHECK ((VALUE > (0)::numeric))'] });
      expect((await c.query(`SELECT '25432.5'::crove_finance.fx_rate::text AS v`)).rows[0]).toEqual({ v: '25432.5000000000' });
      await expect(c.query(`SELECT 0::crove_finance.fx_rate`)).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`SELECT (-1)::crove_finance.fx_rate`)).rejects.toMatchObject({ code: '23514' });
      // A rate too small for 10 decimals rounds to 0 and is refused, not stored as 0.
      await expect(c.query(`SELECT 0.00000000001::crove_finance.fx_rate`)).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`SELECT 1e14::crove_finance.fx_rate`)).rejects.toMatchObject({ code: '22003' });
    });
  });

  it('refuses a VND amount with decimals instead of storing it, and accepts trailing zeros', async () => {
    const refused = await post(orgs.vnd, pair('100.5'));
    expect(refused).toMatchObject({ error: { code: '22023', message: 'AMOUNT_SCALE' } });
    if ('error' in refused) {
      expect(JSON.parse(refused.error.detail ?? '{}')).toEqual({ lineNo: 1, currency: 'VND', minorUnits: 0, amount: '100.5' });
    }
    // A fifth decimal that numeric(20,4) would round away is refused too, on either side.
    expect(await post(orgs.vnd, pair('1.00005'))).toMatchObject({ error: { code: '22023', message: 'AMOUNT_SCALE' } });
    const credit = await post(orgs.vnd, [
      { line_no: 1, account_code: '6422', debit: '100', credit: '0' },
      { line_no: 2, account_code: '331', debit: '0', credit: '99.9999' },
      { line_no: 3, account_code: '331', debit: '0', credit: '0.0001' },
    ]);
    expect(credit).toMatchObject({ error: { code: '22023', message: 'AMOUNT_SCALE' } });
    if ('error' in credit) expect(JSON.parse(credit.error.detail ?? '{}')).toMatchObject({ lineNo: 2, amount: '99.9999' });
    expect(await linesOf(orgs.vnd)).toBe(0);

    expect(await post(orgs.vnd, pair('1500000.0000'))).toMatchObject({ id: expect.any(String) });
    expect(await post(orgs.vnd, pair('250000'))).toMatchObject({ id: expect.any(String) });
    expect(await linesOf(orgs.vnd)).toBe(4);
  });

  it('allows the book currency its own minor units', async () => {
    expect(await post(orgs.usd, pair('100.50'))).toMatchObject({ id: expect.any(String) });
    const refused = await post(orgs.usd, pair('1.005'));
    expect(refused).toMatchObject({ error: { code: '22023', message: 'AMOUNT_SCALE' } });
    if ('error' in refused) expect(JSON.parse(refused.error.detail ?? '{}')).toMatchObject({ currency: 'USD', minorUnits: 2, amount: '1.005' });
    expect(await linesOf(orgs.usd)).toBe(2);
  });

  it('refuses to post for an org whose book currency is not in the table', async () => {
    const refused = await post(orgs.unknown, pair('100'));
    expect(refused).toMatchObject({ error: { code: '22023', message: 'UNKNOWN_CURRENCY' } });
    if ('error' in refused) expect(JSON.parse(refused.error.detail ?? '{}')).toEqual({ currency: 'XTS' });
    expect(await linesOf(orgs.unknown)).toBe(0);
  });

  it('lists rows written before the rule that break it, and nothing posted through the definer', async () => {
    expect((await withAdmin((c) => c.query(BREAKING_ROWS))).rows).toEqual([]);
    // A line kept as given before the rule, written here by the database owner, which bypasses the definer.
    const entryId = await withAdmin(async (c) => {
      await c.query('BEGIN');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id)
         VALUES ($1, '2026-10-02', 'before #1282', 'test', $2) RETURNING id`,
        [orgs.vnd, randomUUID()],
      );
      const id = rows[0]?.id ?? '';
      await c.query(
        `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit)
         VALUES ($1, $2, 1, '6422', 100.5, 0), ($1, $2, 2, '331', 0, 100.5)`,
        [orgs.vnd, id],
      );
      await c.query('COMMIT');
      return id;
    });
    const listed = (
      await withAdmin((c) => c.query<{ source: string; id: string; line_no: number; currency: string }>(`SELECT * FROM (${BREAKING_ROWS}) b ORDER BY b.line_no`))
    ).rows;
    expect(listed.map((r) => ({ source: r.source, id: r.id, line: r.line_no, currency: r.currency }))).toEqual([
      { source: 'journal_line', id: entryId, line: 1, currency: 'VND' },
      { source: 'journal_line', id: entryId, line: 2, currency: 'VND' },
    ]);
  });
});
