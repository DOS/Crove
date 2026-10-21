// Usage report privileges (issue #311) on a real PostgreSQL 17. crove_reporter is a plain login that may execute
// crove_kernel.usage_weekly() and nothing else: no table, no other function, no temporary objects, no role membership.
// No tenant role, the API and worker logins and the prober included, may execute usage_weekly(), and the function
// refuses any session but the reporter's even when EXECUTE is granted by mistake. Part of the invariant suite: CI runs
// this file from the base branch on protected-path PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a superuser URL; the
// run creates and drops its own database. The counts themselves are in test/usage-report.db.test.ts.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const FN = 'crove_kernel.usage_weekly(integer,boolean,text)';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];

const suite = ADMIN ? describe : describe.skip;

suite('usage report privileges', () => {
  const dbName = `crove_test_usage_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const clients: pg.Client[] = [];

  const loginUrl = (user: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
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
    await setRolePasswords(adminUrl, {
      crove_app: 'test-app-pw',
      crove_worker: 'test-worker-pw',
      crove_prober: 'test-prober-pw',
      crove_reporter: 'test-reporter-pw',
    });
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => {});
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps crove_reporter a plain login with no memberships, no TEMPORARY and a pinned search_path', async () => {
    const admin = await connect(adminUrl);
    const { rows } = await admin.query(
      `SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolconfig,
              has_database_privilege(r.oid, current_database(), 'TEMPORARY') AS temp,
              has_database_privilege(r.oid, current_database(), 'CREATE') AS create_schema,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
              (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
       FROM pg_roles r WHERE r.rolname = 'crove_reporter'`,
    );
    expect(rows).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolconfig: ['search_path=pg_catalog, pg_temp'],
        temp: false,
        create_schema: false,
        memberships: 0,
        owned: 0,
      },
    ]);
  });

  it('lets only crove_reporter execute usage_weekly(), a pinned definer, and crove_reporter nothing else (EXECUTE matrix)', async () => {
    const admin = await connect(adminUrl);
    const { rows } = await admin.query<{ role: string }>(
      `SELECT r AS role FROM unnest($1::text[]) r WHERE has_function_privilege(r, $2, 'EXECUTE') ORDER BY 1`,
      [ROLES, FN],
    );
    expect(rows).toEqual([{ role: 'crove_reporter' }]);
    const def = await admin.query(`SELECT p.prosecdef, p.proconfig, p.provolatile FROM pg_proc p WHERE p.oid = $1::regprocedure`, [FN]);
    expect(def.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], provolatile: 's' }]);
    const others = await admin.query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname LIKE 'crove\\_%' AND n.nspname <> 'crove_jobs' AND p.oid <> $1::regprocedure
         AND has_function_privilege('crove_reporter', p.oid, 'EXECUTE')`,
      [FN],
    );
    expect(others.rows).toEqual([]);
  });

  it('holds no privilege on any table and no USAGE beyond crove_kernel', async () => {
    const admin = await connect(adminUrl);
    const tables = await admin.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
         AND (has_table_privilege('crove_reporter', c.oid, 'SELECT') OR has_table_privilege('crove_reporter', c.oid, 'INSERT')
              OR has_table_privilege('crove_reporter', c.oid, 'UPDATE') OR has_table_privilege('crove_reporter', c.oid, 'DELETE')
              OR has_table_privilege('crove_reporter', c.oid, 'TRUNCATE'))`,
    );
    expect(tables.rows).toEqual([]);
    const schemas = await admin.query(
      `SELECT nspname, has_schema_privilege('crove_reporter', oid, 'CREATE') AS create
       FROM pg_namespace WHERE nspname LIKE 'crove\\_%' AND (has_schema_privilege('crove_reporter', oid, 'USAGE') OR has_schema_privilege('crove_reporter', oid, 'CREATE'))
       ORDER BY 1`,
    );
    expect(schemas.rows).toEqual([{ nspname: 'crove_kernel', create: false }]);
  });

  it('as the crove_reporter login: reads usage_weekly() and is refused everything else', async () => {
    const reporter = await connect(loginUrl('crove_reporter', 'test-reporter-pw'));
    const { rows } = await reporter.query('SELECT * FROM crove_kernel.usage_weekly(1, true)');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] as object)).toEqual([
      'week_start',
      'iso_week',
      'org_id',
      'org_name',
      'active_orgs',
      'active_users',
      'documents_uploaded',
      'documents_emailed',
      'proposals_approved',
      'approved_without_edits',
      'proposals_rejected',
      'median_upload_to_approval_seconds',
      'journal_exports',
      'org_exports',
      'ai_calls',
    ]);
    const refused = [
      'SELECT 1 FROM crove_kernel.audit_event LIMIT 1',
      'SELECT 1 FROM crove_kernel.tenant LIMIT 1',
      'SELECT 1 FROM crove_kernel.file LIMIT 1',
      'SELECT 1 FROM crove_kernel.proposal LIMIT 1',
      'SELECT * FROM crove_kernel.health()',
      "SELECT crove_kernel.enter_system_context('00000000-0000-0000-0000-000000000000')",
      'CREATE TEMP TABLE t (x int)',
      'CREATE TABLE crove_kernel.planted (x int)',
    ];
    for (const statement of refused) {
      await expect(reporter.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('refuses the API, worker and prober logins, and any session but the reporter even with EXECUTE granted by mistake', async () => {
    for (const [user, password] of [
      ['crove_app', 'test-app-pw'],
      ['crove_worker', 'test-worker-pw'],
      ['crove_prober', 'test-prober-pw'],
    ]) {
      const client = await connect(loginUrl(user as string, password as string));
      await expect(client.query('SELECT * FROM crove_kernel.usage_weekly()'), user).rejects.toMatchObject({ code: '42501' });
    }
    const admin = await connect(adminUrl);
    await admin.query('BEGIN');
    try {
      await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO crove_app`);
      await admin.query('SET SESSION AUTHORIZATION crove_app');
      await expect(admin.query('SELECT * FROM crove_kernel.usage_weekly()')).rejects.toMatchObject({ code: '42501', message: 'REPORTER_ONLY' });
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
