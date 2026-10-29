// Period balances (issue #1284, plan §13 Phase 2a: "period_balance is writable only by the posting definer, and
// reconciled nightly") on a real PostgreSQL 17. crove_finance.post_journal_entry() appends one delta row per entry and
// account to crove_finance.period_balance_delta; no login role inserts, updates or deletes one, and the append-only
// triggers hold the database owner too. After a mix of postings, replays, refusals, reversals and re-postings, and
// after 50 postings to the same accounts in transactions all open at once (none waits on another: a delta locks no
// shared row, ADR-0021's lock cap), the deltas sum to the journal lines per org, account and month. The reconciler's
// comparison is a definer only the worker login may call, and it names every difference made outside the posting path.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const CLIENTS = 50;
const TABLE = 'crove_finance.period_balance_delta';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
const POST_7 = 'crove_finance.post_journal_entry(date,text,text,uuid,jsonb,uuid,integer)';
const DIFF = 'crove_finance.period_balance_differences(integer)';

type Line = { line_no: number; account_code: string; debit: string; credit: string };
const line = (line_no: number, account_code: string, debit: string, credit: string): Line => ({ line_no, account_code, debit, credit });
const mirror = (lines: Line[]): Line[] => lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));

const suite = ADMIN ? describe : describe.skip;

suite('period balances on PostgreSQL (#1284)', () => {
  const dbName = `crove_test_period_balance_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let userId = '';
  const orgs: string[] = [];

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

  // One posting as the API login role in the org's context, committed. Returns the entry id.
  const post = (orgId: string, date: string, sourceId: string, lines: Line[], opts: { reverses?: string; revision?: number } = {}) =>
    withClient(appUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
        const { rows } = await c.query<{ id: string }>(
          `SELECT crove_finance.post_journal_entry($1::date, 'period balance', 'test.balance', $2::uuid, $3::jsonb, $4::uuid, $5::int) AS id`,
          [date, sourceId, JSON.stringify(lines), opts.reverses ?? null, opts.revision ?? 1],
        );
        await c.query('COMMIT');
        return rows[0]?.id ?? '';
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });

  // Per org, account and month: the ledger's totals and the deltas' totals, as text, compared as a whole.
  const totals = (orgId: string) =>
    withAdmin(async (a) => {
      const ledger = await a.query<{ account: string; month: string; debit: string; credit: string; lines: string }>(
        `SELECT l.account_code AS account, to_char(e.entry_date, 'YYYY-MM') AS month, sum(l.debit)::numeric(30,4)::text AS debit,
                sum(l.credit)::numeric(30,4)::text AS credit, count(*)::text AS lines
         FROM crove_finance.journal_line l JOIN crove_finance.journal_entry e ON e.org_id = l.org_id AND e.id = l.entry_id
         WHERE l.org_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
        [orgId],
      );
      const deltas = await a.query<{ account: string; month: string; debit: string; credit: string; lines: string }>(
        `SELECT account_code AS account, to_char(period_month, 'YYYY-MM') AS month, sum(debit)::numeric(30,4)::text AS debit,
                sum(credit)::numeric(30,4)::text AS credit, sum(line_count)::text AS lines
         FROM ${TABLE} WHERE org_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
        [orgId],
      );
      return { ledger: ledger.rows, deltas: deltas.rows };
    });

  const differences = () =>
    withClient(workerUrl, async (w) =>
      (
        await w.query<{ org_id: string; account_code: string; period_month: string; entry_id: string; mismatch: string[] }>(
          `SELECT org_id, account_code, period_month::text AS period_month, entry_id, mismatch FROM crove_finance.period_balance_differences(1000)`,
        )
      ).rows,
    );

  const deltaCount = (orgId: string) =>
    withAdmin(async (a) => Number((await a.query<{ n: string }>(`SELECT count(*) AS n FROM ${TABLE} WHERE org_id = $1`, [orgId])).rows[0]?.n));

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    appUrl = app.toString();
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerUrl = worker.toString();
    pool = createPool({ connectionString: appUrl, max: 1 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    userId = await upsertIdentity(db, { issuer: 'test', subject: 'period-balance', email: 'balance@period.test', name: null });
    for (const name of ['Balance A', 'Balance B']) orgs.push((await createOrg(runtime, { type: 'user', userId, aal: 'aal1' }, name)).orgId);
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets no login role write the deltas, the definer only insert them, and nobody update or delete one', async () => {
    const [orgA] = orgs as [string];
    await post(orgA, '2026-09-10', randomUUID(), [line(1, '6422', '1000', '0'), line(2, '331', '0', '1000')]);
    const grants = await withAdmin(async (a) =>
      (
        await a.query<{ role: string; op: string }>(
          `SELECT r AS role, p AS op FROM unnest($1::text[]) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
           WHERE has_table_privilege(r, $2, p) ORDER BY 1, 2`,
          [ROLES, TABLE],
        )
      ).rows,
    );
    // Every login role reads through crove_tenant (row security by org); only the NOLOGIN definer owner inserts.
    expect(grants).toEqual([
      { role: 'crove_app', op: 'SELECT' },
      { role: 'crove_definer_tenant', op: 'INSERT' },
      { role: 'crove_definer_tenant', op: 'SELECT' },
      { role: 'crove_tenant', op: 'SELECT' },
      { role: 'crove_worker', op: 'SELECT' },
    ]);
    const shape = await withAdmin(async (a) =>
      (
        await a.query<{ owner: string; login: boolean; rls: boolean }>(
          `SELECT pg_get_userbyid(c.relowner) AS owner, r.rolcanlogin AS login, c.relrowsecurity AS rls
           FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = $1::regclass`,
          [TABLE],
        )
      ).rows[0],
    );
    expect(ROLES).not.toContain(shape?.owner);
    expect(shape?.rls).toBe(true);

    for (const [role, url] of [['crove_app', appUrl], ['crove_worker', workerUrl]] as const) {
      await withClient(url, async (c) => {
        const entry = (await c.query<{ id: string }>(`SELECT entry_id AS id FROM ${TABLE} LIMIT 1`)).rows[0]?.id ?? randomUUID();
        for (const statement of [
          `INSERT INTO ${TABLE} (org_id, entry_id, account_code, period_month, debit, credit, line_count) VALUES ('${orgA}', '${entry}', '999', '2026-09-01', 1, 0, 1)`,
          `UPDATE ${TABLE} SET debit = debit + 1`,
          `DELETE FROM ${TABLE}`,
          `TRUNCATE ${TABLE}`,
        ]) {
          await c.query('BEGIN');
          if (role === 'crove_app') await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgA]);
          await expect(c.query(statement), `${role}: ${statement.split(' ')[0]}`).rejects.toThrow(/permission denied/);
          await c.query('ROLLBACK');
        }
      });
    }

    // The definer owner's role may insert (that is how the posting appends) but not update or delete, and the
    // append-only triggers refuse the database owner as well.
    const before = await deltaCount(orgA);
    await withAdmin(async (a) => {
      for (const statement of [`UPDATE ${TABLE} SET debit = debit + 1 WHERE org_id = $1`, `DELETE FROM ${TABLE} WHERE org_id = $1`]) {
        await expect(a.query(statement, [orgA])).rejects.toThrow(/is append-only/);
      }
      await expect(a.query(`TRUNCATE ${TABLE}`)).rejects.toThrow(/is append-only/);
    });
    expect(await deltaCount(orgA)).toBe(before);
  });

  it('keeps the deltas equal to the journal lines through postings, replays, refusals, reversals and re-postings', async () => {
    const [orgA, orgB] = orgs as [string, string];
    const a1 = randomUUID();
    // Two lines on one account: one delta row with both, line_count 2.
    const a1Lines = [line(1, '6422', '700000', '0'), line(2, '6422', '300000', '0'), line(3, '1331', '100000', '0'), line(4, '331', '0', '1100000')];
    const e1 = await post(orgA, '2026-09-15', a1, a1Lines);
    const afterFirst = await deltaCount(orgA);
    // A replay returns the posted entry and appends nothing.
    expect(await post(orgA, '2026-09-15', a1, a1Lines)).toBe(e1);
    expect(await deltaCount(orgA)).toBe(afterFirst);
    // An idempotency conflict, a revision out of order and an unbalanced entry are refused and append nothing.
    await expect(post(orgA, '2026-09-15', a1, [line(1, '6422', '5', '0'), line(2, '331', '0', '5')])).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' });
    await expect(post(orgA, '2026-09-15', a1, a1Lines, { revision: 3 })).rejects.toMatchObject({ message: 'REVISION_OUT_OF_ORDER' });
    await expect(post(orgA, '2026-09-16', randomUUID(), [line(1, '6422', '10', '0'), line(2, '331', '0', '9')])).rejects.toThrow(/does not balance/);
    expect(await deltaCount(orgA)).toBe(afterFirst);
    // The reversal, a month later, appends its own swapped lines in its own month.
    const r1 = await post(orgA, '2026-10-02', randomUUID(), mirror(a1Lines), { reverses: e1 });
    // Revision 2 of the same source after the reversal, in October.
    const e2 = await post(orgA, '2026-10-05', a1, [line(1, '6422', '900000', '0'), line(2, '331', '0', '900000')], { revision: 2 });
    // Another org's postings stay its own.
    await post(orgB, '2026-09-20', randomUUID(), [line(1, '1111', '250000', '0'), line(2, '5111', '0', '250000')]);

    const deltas = await withAdmin(async (a) =>
      (
        await a.query<{ entry: string; account: string; month: string; debit: string; credit: string; lines: number }>(
          `SELECT entry_id AS entry, account_code AS account, period_month::text AS month, debit::numeric(30,4)::text AS debit,
                  credit::numeric(30,4)::text AS credit, line_count AS lines
           FROM ${TABLE} WHERE org_id = $1 AND entry_id = ANY($2::uuid[]) ORDER BY 1, 2`,
          [orgA, [e1, r1, e2]],
        )
      ).rows,
    );
    const byEntry = (id: string) => deltas.filter((d) => d.entry === id).map(({ entry: _e, ...rest }) => rest);
    expect(byEntry(e1)).toEqual([
      { account: '1331', month: '2026-09-01', debit: '100000.0000', credit: '0.0000', lines: 1 },
      { account: '331', month: '2026-09-01', debit: '0.0000', credit: '1100000.0000', lines: 1 },
      { account: '6422', month: '2026-09-01', debit: '1000000.0000', credit: '0.0000', lines: 2 },
    ]);
    expect(byEntry(r1)).toEqual([
      { account: '1331', month: '2026-10-01', debit: '0.0000', credit: '100000.0000', lines: 1 },
      { account: '331', month: '2026-10-01', debit: '1100000.0000', credit: '0.0000', lines: 1 },
      { account: '6422', month: '2026-10-01', debit: '0.0000', credit: '1000000.0000', lines: 2 },
    ]);
    expect(byEntry(e2)).toEqual([
      { account: '331', month: '2026-10-01', debit: '0.0000', credit: '900000.0000', lines: 1 },
      { account: '6422', month: '2026-10-01', debit: '900000.0000', credit: '0.0000', lines: 1 },
    ]);
    for (const org of orgs) {
      const { ledger, deltas: summed } = await totals(org);
      expect(summed).toEqual(ledger);
      expect(ledger.length).toBeGreaterThan(0);
    }
    expect(await differences()).toEqual([]);
  });

  it(`appends ${CLIENTS} concurrent postings to the same accounts without any waiting on another, and they add up`, async () => {
    const orgA = orgs[0] as string;
    const before = await totals(orgA);
    const clients: pg.Client[] = [];
    try {
      for (let i = 0; i < CLIENTS; i++) {
        const c = new pg.Client({ connectionString: appUrl });
        await c.connect();
        clients.push(c);
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgA]);
      }
      // Every posting returns while all CLIENTS transactions are still open: none holds a row another one needs (with a
      // balance row updated in place, the second posting would wait for the first to commit, and this would time out).
      const ids = await Promise.all(
        clients.map(async (c, i) => {
          await c.query(`SET LOCAL lock_timeout = '5s'`);
          const amount = String(1000 * (i + 1));
          const { rows } = await c.query<{ id: string }>(
            `SELECT crove_finance.post_journal_entry('2026-10-20'::date, 'concurrent', 'test.concurrent', $1::uuid, $2::jsonb, NULL::uuid, 1) AS id`,
            [randomUUID(), JSON.stringify([line(1, '6422', amount, '0'), line(2, '1331', '100', '0'), line(3, '331', '0', String(1000 * (i + 1) + 100))])],
          );
          return rows[0]?.id;
        }),
      );
      expect(new Set(ids).size).toBe(CLIENTS);
      await Promise.all(clients.map((c) => c.query('COMMIT')));
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }
    const after = await totals(orgA);
    expect(after.deltas).toEqual(after.ledger);
    const october = (t: typeof after.ledger, account: string) => t.find((r) => r.account === account && r.month === '2026-10');
    // 1000 + 2000 + ... + 50,000 more on 6422 in October, and 50 more lines.
    expect(Number(october(after.ledger, '6422')?.debit) - Number(october(before.ledger, '6422')?.debit)).toBe((1000 * CLIENTS * (CLIENTS + 1)) / 2);
    expect(Number(october(after.ledger, '6422')?.lines) - Number(october(before.ledger, '6422')?.lines)).toBe(CLIENTS);
    expect(await differences()).toEqual([]);
  });

  it('keeps the posting definer and the reconciler pinned, the reconciler for the worker login alone', async () => {
    const { grants, shape } = await withAdmin(async (a) => {
      const g = await a.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
         WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
        [[DIFF], ROLES],
      );
      const s = await a.query<{ fn: string; owner: string; definer: boolean; config: string[]; public: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
         FROM pg_proc p WHERE p.oid IN ($1::regprocedure, $2::regprocedure) ORDER BY 1`,
        [POST_7, DIFF],
      );
      return { grants: g.rows, shape: s.rows };
    });
    expect(grants).toEqual([{ fn: DIFF, role: 'crove_worker' }]);
    expect(shape).toEqual([
      { fn: DIFF, owner: expect.any(String), definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false },
      { fn: POST_7, owner: 'crove_definer_tenant', definer: true, config: ['search_path=pg_catalog, pg_temp'], public: false },
    ]);
    // The reconciler reads every org's lines, so it runs as the tables' owner, never a runtime role.
    expect(ROLES).not.toContain(shape[0]?.owner);
    await withClient(appUrl, async (c) => {
      await expect(c.query(`SELECT * FROM crove_finance.period_balance_differences(10)`)).rejects.toThrow(/permission denied/);
    });
    await withClient(workerUrl, async (w) => {
      await expect(w.query(`SELECT * FROM crove_finance.period_balance_differences(0)`)).rejects.toThrow(/LIMIT_INVALID/);
    });
  });

  // Last: it leaves differences behind.
  it('names every difference made outside the posting path, with references and no amounts', async () => {
    const [orgA, orgB] = orgs as [string, string];
    // A journal entry the database owner writes directly: lines without deltas.
    const direct = await withAdmin(async (a) => {
      await a.query('BEGIN');
      const { rows } = await a.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-10-21', 'direct', 'test.direct', $2) RETURNING id`,
        [orgB, randomUUID()],
      );
      await a.query(`INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '1111', 500, 0), ($1, $2, 2, '5111', 0, 500)`, [
        orgB,
        rows[0]?.id,
      ]);
      await a.query('COMMIT');
      return rows[0]?.id as string;
    });
    // An entry of org A: an extra delta row on another account, and its 6422 delta changed with the triggers off.
    const target = await withAdmin(async (a) => {
      const { rows } = await a.query<{ entry: string }>(`SELECT entry_id AS entry FROM ${TABLE} WHERE org_id = $1 AND account_code = '6422' AND period_month = '2026-09-01' LIMIT 1`, [orgA]);
      const entry = rows[0]?.entry as string;
      await a.query(`INSERT INTO ${TABLE} (org_id, entry_id, account_code, period_month, debit, credit, line_count) VALUES ($1, $2, '642', '2026-09-01', 1, 0, 1)`, [orgA, entry]);
      await a.query('BEGIN');
      await a.query(`SET LOCAL session_replication_role = replica`);
      await a.query(`UPDATE ${TABLE} SET debit = debit + 1 WHERE org_id = $1 AND entry_id = $2 AND account_code = '6422'`, [orgA, entry]);
      await a.query('COMMIT');
      return entry;
    });
    const found = await differences();
    expect(found).toEqual(
      [
        { org_id: orgA, account_code: '642', period_month: '2026-09-01', entry_id: target, mismatch: ['extra'] },
        { org_id: orgA, account_code: '6422', period_month: '2026-09-01', entry_id: target, mismatch: ['debit'] },
        { org_id: orgB, account_code: '1111', period_month: '2026-10-01', entry_id: direct, mismatch: ['missing'] },
        { org_id: orgB, account_code: '5111', period_month: '2026-10-01', entry_id: direct, mismatch: ['missing'] },
      ].sort((x, y) => (x.org_id === y.org_id ? 0 : x.org_id < y.org_id ? -1 : 1)),
    );
    // The answer has no column that could carry an amount.
    expect(Object.keys(found[0] ?? {}).sort()).toEqual(['account_code', 'entry_id', 'mismatch', 'org_id', 'period_month']);
  });
});
