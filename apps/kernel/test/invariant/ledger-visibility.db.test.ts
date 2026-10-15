// Ledger checks that do not depend on what the caller can see (issue #76, External-tenant gate T3) on a real
// PostgreSQL 17. Legal-entity policies (§4.6) will hide some journal lines from some callers; the balance and
// line-count checks must still count every line of the entry, only of that entry and its org, and no runtime
// role may call them with arguments of its choosing. A RESTRICTIVE policy added by the test stands in for the
// legal-entity policies until they exist. Also covers the xid8 stamp after a logical restore (§7.9).
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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
// Lines with this memo are invisible to every tenant role (crove_app, crove_worker, crove_definer_tenant).
const HIDDEN = 'outside-legal-entity-scope';
const CHECKS = ['crove_finance.assert_entry_balanced(uuid,uuid)', 'crove_finance.check_entry_balanced()', 'crove_finance.require_entry_balanced(uuid,uuid)'];
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];

type Line = { line_no: number; account_code: string; debit: string; credit: string; memo?: string };

const suite = ADMIN ? describe : describe.skip;

suite('ledger checks independent of caller visibility (#76)', () => {
  const dbName = `crove_test_ledger_vis_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  const users = { a: '', b: '' };
  let orgA = '';
  let orgB = '';
  const clients: pg.Client[] = [];

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // Lines of the entry as the admin (sees everything) and as crove_app in the entry's org (sees through RLS).
  async function lineCounts(entryId: string, orgId: string, userId: string) {
    const all = await withAdmin(async (a) => {
      const { rows } = await a.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.journal_line WHERE entry_id = $1', [entryId]);
      return rows[0]?.n;
    });
    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [userId, orgId]);
      const { rows } = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.journal_line WHERE entry_id = $1', [entryId]);
      return { all, visible: rows[0]?.n };
    } finally {
      await app.query('ROLLBACK');
    }
  }

  // Posts through the only write path, as the API login role in org A, and commits.
  async function post(lines: Line[]): Promise<string> {
    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.a, orgA]);
      const { rows } = await app.query<{ id: string }>(
        `SELECT crove_finance.post_journal_entry('2026-10-01', 'visibility', 'test', $1::uuid, $2::jsonb) AS id`,
        [randomUUID(), JSON.stringify(lines)],
      );
      await app.query('COMMIT');
      return rows[0]?.id ?? '';
    } catch (error) {
      await app.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  // Writes an entry and its lines directly as crove_definer_tenant (the role the posting definer runs as), so only
  // the deferred triggers check it, at a COMMIT that runs as that role in org A's context.
  async function writeAsDefiner(lines: Line[]): Promise<void> {
    await withAdmin(async (a) => {
      await a.query('BEGIN');
      try {
        await a.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.a, orgA]);
        await a.query('SET LOCAL ROLE crove_definer_tenant');
        const { rows } = await a.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id)
           VALUES ($1, '2026-10-01', 'direct', 'test', $2) RETURNING id`,
          [orgA, randomUUID()],
        );
        for (const l of lines) {
          await a.query(
            `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, memo)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orgA, rows[0]?.id, l.line_no, l.account_code, l.debit, l.credit, l.memo ?? null],
          );
        }
        await a.query('COMMIT');
      } catch (error) {
        await a.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
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
    users.a = await upsertIdentity(db, { issuer: 'test', subject: 'ledger-a', email: 'a@ledger.test', name: null });
    users.b = await upsertIdentity(db, { issuer: 'test', subject: 'ledger-b', email: 'b@ledger.test', name: null });
    orgA = (await createOrg(runtime, asUser(users.a), 'Ledger A')).orgId;
    orgB = (await createOrg(runtime, asUser(users.b), 'Ledger B')).orgId;
    // Stand-in for a legal-entity policy: tenant roles cannot see lines outside "their" scope. SELECT only, so
    // the posting definer can still write such lines (a caller allowed to post to an entity it cannot list).
    await withAdmin((a) =>
      a.query(`CREATE POLICY crove_test_le_scope ON crove_finance.journal_line AS RESTRICTIVE FOR SELECT TO crove_tenant
               USING (memo IS DISTINCT FROM '${HIDDEN}')`),
    );
  });

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('refuses an entry that balances only over the lines the caller can see', async () => {
    // Visible lines net to zero; the hidden one does not.
    const unbalanced: Line[] = [
      { line_no: 1, account_code: '6422', debit: '100', credit: '0' },
      { line_no: 2, account_code: '331', debit: '0', credit: '100' },
      { line_no: 3, account_code: '6422', debit: '50', credit: '0', memo: HIDDEN },
    ];
    await expect(post(unbalanced)).rejects.toThrow(/does not balance \(difference 50/);
    // The deferred check at commit, without the posting function's own early check.
    await expect(writeAsDefiner(unbalanced)).rejects.toThrow(/does not balance \(difference 50/);
  });

  it('accepts a balanced entry with lines the caller cannot see, counting every line', async () => {
    const id = await post([
      { line_no: 1, account_code: '6422', debit: '100', credit: '0' },
      { line_no: 2, account_code: '331', debit: '0', credit: '60' },
      { line_no: 3, account_code: '331', debit: '0', credit: '40', memo: HIDDEN },
    ]);
    // The policy really hides the line from the caller, so a check through RLS would have refused this entry.
    expect(await lineCounts(id, orgA, users.a)).toEqual({ all: 3, visible: 2 });

    // Two lines, one of them hidden: the line count sees both.
    const pair = await post([
      { line_no: 1, account_code: '6422', debit: '70', credit: '0' },
      { line_no: 2, account_code: '331', debit: '0', credit: '70', memo: HIDDEN },
    ]);
    expect(await lineCounts(pair, orgA, users.a)).toEqual({ all: 2, visible: 1 });
    await expect(
      writeAsDefiner([
        { line_no: 1, account_code: '6422', debit: '30', credit: '0', memo: HIDDEN },
        { line_no: 2, account_code: '331', debit: '0', credit: '30' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('still refuses entries with fewer than 2 lines and keeps each check to its own entry', async () => {
    await expect(writeAsDefiner([{ line_no: 1, account_code: '6422', debit: '10', credit: '0', memo: HIDDEN }])).rejects.toThrow(
      /needs at least 2 lines \(has 1\)/,
    );
    await expect(writeAsDefiner([])).rejects.toThrow(/needs at least 2 lines \(has 0\)/);
  });

  it('lets no runtime role call the checks with arguments of its choosing', async () => {
    const rows = await withAdmin(async (a) => {
      const { rows: grants } = await a.query<{ fn: string; role: string }>(
        `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
         WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
        [CHECKS, ROLES],
      );
      // Each check runs as a role that RLS does not filter: a superuser, a BYPASSRLS role, or the owner of
      // journal_line while row security is not forced on it.
      const { rows: shape } = await a.query<{ fn: string; definer: boolean; config: string[]; unfiltered: boolean; public: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, p.proconfig AS config,
                (r.rolsuper OR r.rolbypassrls OR (c.relowner = p.proowner AND NOT c.relforcerowsecurity)) AS unfiltered,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) AS public
         FROM pg_proc p
         JOIN pg_roles r ON r.oid = p.proowner
         CROSS JOIN pg_class c
         WHERE c.oid = 'crove_finance.journal_line'::regclass AND p.oid = ANY ($1::regprocedure[])
         ORDER BY 1`,
        [CHECKS],
      );
      return { grants, shape };
    });
    // Only the owner of the posting function may call the entry check, and only for the org in its context.
    expect(rows.grants).toEqual([{ fn: 'crove_finance.assert_entry_balanced(uuid,uuid)', role: 'crove_definer_tenant' }]);
    expect(rows.shape).toEqual(
      CHECKS.map((fn) => ({ fn, definer: true, config: ['search_path=pg_catalog, pg_temp'], unfiltered: true, public: false })),
    );

    const entryOfB = await withAdmin(async (a) => {
      await a.query('BEGIN');
      await a.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.b, orgB]);
      await a.query('SET LOCAL ROLE crove_definer_tenant');
      const { rows: r } = await a.query<{ id: string }>(
        `SELECT crove_finance.post_journal_entry('2026-10-01', 'b', 'test', $1::uuid,
           '[{"line_no":1,"account_code":"6422","debit":"5"},{"line_no":2,"account_code":"331","credit":"5"}]'::jsonb) AS id`,
        [randomUUID()],
      );
      await a.query('COMMIT');
      return r[0]?.id ?? '';
    });

    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.a, orgA]);
      for (const text of [
        'SELECT crove_finance.assert_entry_balanced($1::uuid, $2::uuid)',
        'SELECT crove_finance.require_entry_balanced($1::uuid, $2::uuid)',
      ]) {
        await app.query('SAVEPOINT probe');
        await expect(app.query(text, [orgB, entryOfB]), text).rejects.toThrow(/permission denied/);
        await app.query('ROLLBACK TO SAVEPOINT probe');
      }
    } finally {
      await app.query('ROLLBACK');
    }

    // Even as the definer role, the entry check refuses an org other than the one in the sealed context.
    await withAdmin(async (a) => {
      await a.query('BEGIN');
      try {
        await a.query('SELECT crove_kernel.enter_context($1::uuid, $2::uuid)', [users.a, orgA]);
        await a.query('SET LOCAL ROLE crove_definer_tenant');
        await expect(a.query('SELECT crove_finance.assert_entry_balanced($1::uuid, $2::uuid)', [orgB, entryOfB])).rejects.toMatchObject({
          code: '42501',
          message: 'ENTRY_ORG_NOT_IN_CONTEXT',
        });
      } finally {
        await a.query('ROLLBACK');
      }
      await a.query('BEGIN');
      try {
        await a.query('SET LOCAL ROLE crove_definer_tenant');
        await expect(a.query('SELECT crove_finance.assert_entry_balanced($1::uuid, $2::uuid)', [orgB, entryOfB])).rejects.toMatchObject({
          code: '42501',
          message: 'NO_CONTEXT',
        });
      } finally {
        await a.query('ROLLBACK');
      }
    });
  });

  it('refuses lines for an entry whose xid8 stamp matches the current transaction but came from another cluster', async () => {
    // A logical restore copies created_xact_id from the old cluster; the new cluster reaches that xid8 again later.
    // Simulated in one transaction: the entry is written the way pg_restore --disable-triggers writes it, with the
    // current xid8 and the old transaction start, then a line is added with the triggers back on.
    await withAdmin(async (a) => {
      await a.query('BEGIN');
      try {
        await a.query('SET LOCAL session_replication_role = replica');
        const { rows } = await a.query<{ id: string }>(
          `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, created_xact_id, created_xact_start)
           VALUES ($1, '2026-10-01', 'restored', 'test', $2, pg_current_xact_id(), now() - interval '1 day') RETURNING id`,
          [orgA, randomUUID()],
        );
        await a.query('SET LOCAL session_replication_role = origin');
        await expect(
          a.query(
            `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit)
             VALUES ($1, $2, 1, '6422', 9, 0)`,
            [orgA, rows[0]?.id],
          ),
        ).rejects.toThrow(/already posted/);
      } finally {
        await a.query('ROLLBACK');
      }
    });
  });
});
