// The accounting regime of each legal entity's books (issue #1403, phase A) on a real PostgreSQL 17: the TT99 chart is
// seeded and read-only, an entity without a books row keeps TT133 books, a journal line of an entity under TT99 must
// name a TT99 account (and no TT133-only account or sub-account), a regime starts on the first day of a fiscal year and
// never changes for a year that has entries (also against a posting in flight), and the rows follow le_scope.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';
import { contextToken } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const PRIVILEGE_DENIED = /permission denied for table/;

const suite = ADMIN ? describe : describe.skip;

suite('finance books regime per legal entity (#1403)', () => {
  const dbName = `crove_test_books_regime_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let kyselyPool: pg.Pool;
  let orgId = '';
  let owner = '';
  let member = '';
  let defaultEntity = '';
  let branch = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

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

  // One transaction as crove_app in userId's context; committed when commit is set, else rolled back.
  async function asApp<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>, commit = false): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
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

  // A balanced entry on two accounts, posted through the 8-argument posting path.
  const post = (c: pg.PoolClient, a: { entity: string; date: string; debit: string; credit: string }) =>
    c
      .query<{ id: string }>(`SELECT crove_finance.post_journal_entry($1::date, 'books regime', 'test.regime', $2::uuid, $3::jsonb, NULL, 1, $4::uuid) AS id`, [
        a.date,
        randomUUID(),
        JSON.stringify([
          { line_no: 1, account_code: a.debit, debit: '100000', credit: '0' },
          { line_no: 2, account_code: a.credit, debit: '0', credit: '100000' },
        ]),
        a.entity,
      ])
      .then((r) => r.rows[0]?.id as string);
  const postAsOwner = (a: { entity: string; date: string; debit: string; credit: string }) => asApp(owner, (c) => post(c, a), true);
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; message?: string });

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
    appPool = new pg.Pool({ connectionString: login('crove_app', 'test-app-pw'), max: 3 });
    kyselyPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 2 });
    const db = createDb(kyselyPool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'owner@books-regime.test', name: null });
    member = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: 'member@books-regime.test', name: null });
    ({ orgId } = await createOrg(runtime, asUser(owner), 'Hai chế độ kế toán'));
    await admin(async (a) => {
      defaultEntity = (await a.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (
        await a.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Công ty con TT99', 'company', $2) RETURNING id`, [orgId, owner])
      ).rows[0]?.id as string;
      await a.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member]);
      await a.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        member,
        branch,
        owner,
      ]);
      // A sub-account of the org's (TT133) chart.
      await a.query(`INSERT INTO crove_finance.org_account (org_id, code, name, parent_code) VALUES ($1, '331.A', 'Nhà cung cấp A', '331')`, [orgId]);
    });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await kyselyPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('seeds the TT99 chart, which every org reads and none writes, and whose codes never change', async () => {
    const shape = await admin(async (a) =>
      (
        await a.query<{ total: string; roots: string; orphans: string }>(
          `SELECT count(*) AS total, count(*) FILTER (WHERE parent_code IS NULL) AS roots,
                  count(*) FILTER (WHERE parent_code IS NOT NULL AND NOT starts_with(code, parent_code)) AS orphans
           FROM crove_finance.chart_account WHERE regime = 'tt99' AND version = '2026.1'`,
        )
      ).rows[0],
    );
    expect(shape).toEqual({ total: '184', roots: '71', orphans: '0' });
    // TT133 2026.1 stays crove_finance.account; no second copy of it.
    await expect(
      admin((a) => a.query(`INSERT INTO crove_finance.chart_account (regime, version, code, name) VALUES ('tt133', '2026.1', '999', 'x')`)),
    ).rejects.toMatchObject({ code: '23514' });
    // Names may be corrected; codes are never deleted or renumbered.
    await admin((a) => a.query(`UPDATE crove_finance.chart_account SET name = name WHERE regime = 'tt99' AND code = '1283'`));
    await expect(admin((a) => a.query(`UPDATE crove_finance.chart_account SET code = '1284' WHERE regime = 'tt99' AND code = '1283'`))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(admin((a) => a.query(`DELETE FROM crove_finance.chart_account WHERE regime = 'tt99' AND code = '1283'`))).rejects.toMatchObject({ code: '42501' });

    const read = await asApp(member, async (c) => ({
      charts: (await c.query<{ regime: string }>('SELECT regime FROM crove_finance.chart ORDER BY regime')).rows.map((r) => r.regime),
      accounts: (await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_finance.chart_account WHERE regime = 'tt99'`)).rows[0]?.n,
    }));
    expect(read).toEqual({ charts: ['tt133', 'tt99'], accounts: '184' });
    expect(
      await refusal(asApp(owner, (c) => c.query(`INSERT INTO crove_finance.chart_account (regime, version, code, name) VALUES ('tt99', '2026.1', '999', 'x')`))),
    ).toMatchObject({ code: '42501', message: expect.stringMatching(PRIVILEGE_DENIED) });
    expect(await refusal(asApp(owner, (c) => c.query(`UPDATE crove_finance.chart SET name = 'x'`)))).toMatchObject({
      code: '42501',
      message: expect.stringMatching(PRIVILEGE_DENIED),
    });
  });

  it('keeps TT133 books for an entity without a books row, as before', async () => {
    await postAsOwner({ entity: branch, date: '2026-03-10', debit: '1111', credit: '5111' });
    await postAsOwner({ entity: branch, date: '2026-03-11', debit: '6422', credit: '331.A' });
    // 1283 is a TT99 account only.
    expect(await refusal(postAsOwner({ entity: branch, date: '2026-03-12', debit: '1283', credit: '1111' }))).toMatchObject({ code: '23503' });
  });

  it('starts a regime on the first day of a fiscal year with no entries yet', async () => {
    const books = (entity: string, from: string) =>
      admin((a) =>
        a.query(`INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', $3)`, [
          orgId,
          entity,
          from,
        ]),
      );
    // The branch has entries in 2026 (the test above), so its 2026 books keep their regime.
    expect(await refusal(books(branch, '2026-01-01'))).toMatchObject({ code: '23514', message: 'BOOKS_REGIME_IN_USE' });
    // Not the start of a fiscal year (the org has no tax profile: years end in December).
    expect(await refusal(books(branch, '2027-02-01'))).toMatchObject({ code: '23514', message: 'BOOKS_NOT_FISCAL_YEAR_START' });
    expect(await refusal(books(branch, '2027-01-15'))).toMatchObject({ code: '23514' });
    await books(branch, '2027-01-01');
    // An unknown chart.
    expect(
      await refusal(
        admin((a) =>
          a.query(`INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2025.1', '2029-01-01')`, [
            orgId,
            branch,
          ]),
        ),
      ),
    ).toMatchObject({ code: '23503' });
    // The row with no entity named belongs to the default entity.
    await books(defaultEntity, '2030-01-01');
    await admin((a) => a.query(`DELETE FROM crove_finance.legal_entity_books WHERE org_id = $1 AND effective_from = '2030-01-01'`, [orgId]));
  });

  it('posts a TT99 entity only on TT99 accounts from its first TT99 year', async () => {
    // Under TT99 from 2027: TT99 accounts only.
    await postAsOwner({ entity: branch, date: '2027-02-01', debit: '1283', credit: '331' });
    for (const [debit, credit] of [
      ['1111', '331'], // TT133 only
      ['6422', '5111'], // TT133 only on one side
      ['6422', '331.A'], // the org's sub-account, rooted in TT133
    ] as const) {
      expect(await refusal(postAsOwner({ entity: branch, date: '2027-02-02', debit, credit })), `${debit}/${credit}`).toMatchObject({
        code: '23503',
        message: expect.stringContaining('tt99 2026.1 chart of accounts'),
      });
    }
    // Its 2026 books stay TT133, and the default entity is untouched.
    await postAsOwner({ entity: branch, date: '2026-12-31', debit: '1111', credit: '5111' });
    await postAsOwner({ entity: defaultEntity, date: '2027-02-01', debit: '1111', credit: '331.A' });
    expect(await refusal(postAsOwner({ entity: defaultEntity, date: '2027-02-01', debit: '1283', credit: '331' }))).toMatchObject({ code: '23503' });
  });

  it('never changes the regime of a year with entries', async () => {
    const edit = (sql: string) => refusal(admin((a) => a.query(sql, [orgId, branch])));
    expect(await edit(`UPDATE crove_finance.legal_entity_books SET effective_from = '2028-01-01' WHERE org_id = $1 AND legal_entity_id = $2`)).toMatchObject({
      message: 'BOOKS_REGIME_IN_USE',
    });
    expect(await edit(`UPDATE crove_finance.legal_entity_books SET regime = 'tt133' WHERE org_id = $1 AND legal_entity_id = $2`)).toMatchObject({
      message: 'BOOKS_REGIME_IN_USE',
    });
    expect(await edit(`DELETE FROM crove_finance.legal_entity_books WHERE org_id = $1 AND legal_entity_id = $2`)).toMatchObject({ message: 'BOOKS_REGIME_IN_USE' });
    // The entity never changes either.
    expect(
      await refusal(
        admin((a) => a.query(`UPDATE crove_finance.legal_entity_books SET legal_entity_id = $3 WHERE org_id = $1 AND legal_entity_id = $2`, [orgId, branch, defaultEntity])),
      ),
    ).toMatchObject({ message: 'LEGAL_ENTITY_IMMUTABLE' });
    // A row that repeats the chart in force changes nothing, over booked years too.
    await admin((a) =>
      a.query(`INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt133', '2026.1', '2026-01-01')`, [
        orgId,
        branch,
      ]),
    );
    await admin((a) => a.query(`DELETE FROM crove_finance.legal_entity_books WHERE org_id = $1 AND legal_entity_id = $2 AND effective_from = '2026-01-01'`, [orgId, branch]));
  });

  it('follows the fiscal year of the org', async () => {
    await admin((a) => a.query(`INSERT INTO crove_kernel.tax_profile (org_id, fiscal_year_end_month, updated_by) VALUES ($1, 3, $2)`, [orgId, owner]));
    const books = (from: string) =>
      refusal(
        admin((a) =>
          a.query(`INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt133', '2026.1', $3)`, [
            orgId,
            defaultEntity,
            from,
          ]),
        ),
      );
    expect(await books('2031-01-01')).toMatchObject({ message: 'BOOKS_NOT_FISCAL_YEAR_START' });
    expect(await books('2031-04-01')).toBeNull();
    await admin((a) => a.query(`DELETE FROM crove_kernel.tax_profile WHERE org_id = $1`, [orgId]));
  });

  it('waits for a posting in flight and then refuses the year it booked', async () => {
    const poster = await appPool.connect();
    try {
      await poster.query('BEGIN');
      await poster.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner, orgId)]);
      await post(poster, { entity: defaultEntity, date: '2032-05-05', debit: '1111', credit: '5111' });
      let settled = false;
      const books = refusal(
        admin((a) =>
          a.query(`INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, 'tt99', '2026.1', '2032-01-01')`, [
            orgId,
            defaultEntity,
          ]),
        ),
      ).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      await poster.query('COMMIT');
      expect(await books).toMatchObject({ message: 'BOOKS_REGIME_IN_USE' });
    } finally {
      poster.release();
    }
  });

  it('shows each actor the books rows of its own entities only, and lets no runtime role write them', async () => {
    const seen = (userId: string) =>
      asApp(userId, async (c) => (await c.query<{ e: string }>('SELECT legal_entity_id AS e FROM crove_finance.legal_entity_books ORDER BY effective_from')).rows.map((r) => r.e));
    expect(await seen(owner)).toEqual([branch, defaultEntity]);
    expect(await seen(member)).toEqual([branch]);
    for (const sql of [
      `INSERT INTO crove_finance.legal_entity_books (org_id, regime, chart_version, effective_from) VALUES ('${orgId}', 'tt99', '2026.1', '2040-01-01')`,
      `UPDATE crove_finance.legal_entity_books SET created_by = NULL`,
      `DELETE FROM crove_finance.legal_entity_books`,
    ]) {
      expect(await refusal(asApp(owner, (c) => c.query(sql))), sql).toMatchObject({ code: '42501', message: expect.stringMatching(PRIVILEGE_DENIED) });
    }
  });

  it('checks an update on every date whose chart it may change, and on no other', async () => {
    const books = (from: string, regime: string) =>
      admin((a) =>
        a.query(`INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) VALUES ($1, $2, $3, '2026.1', $4)`, [
          orgId,
          defaultEntity,
          regime,
          from,
        ]),
      );
    const update = (set: string) =>
      refusal(admin((a) => a.query(`UPDATE crove_finance.legal_entity_books SET ${set} WHERE org_id = $1 AND legal_entity_id = $2 AND effective_from = '2041-01-01'`, [orgId, defaultEntity])));
    await books('2041-01-01', 'tt99');
    await books('2042-01-01', 'tt133');
    await postAsOwner({ entity: defaultEntity, date: '2042-06-01', debit: '1111', credit: '5111' });
    // 2041 has no entry, and the 2042 row keeps the chart of 2042 on: the 2041 row may change.
    expect(await update(`regime = 'tt133'`)).toBeNull();
    expect(await update(`regime = 'tt99'`)).toBeNull();
    // Moved past the 2042 row, it would put the 2042 entry under TT99.
    expect(await update(`effective_from = '2043-01-01'`)).toMatchObject({ message: 'BOOKS_REGIME_IN_USE' });
  });
});
