// Prober privileges (plan §4.13, issues #39 and #151) on a real PostgreSQL 17. crove_prober may execute
// crove_kernel.health() and crove_kernel.prober_alert_gate() and nothing else: no table, no other function, no
// temporary objects, no role membership. Heartbeats are written only by the worker login; the alert state only
// through the gate. Part of the invariant suite: CI runs this file from the base branch on protected-path
// PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, setRolePasswords } from '@crove/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const PINNED = ['search_path=pg_catalog, pg_temp'];

const suite = ADMIN ? describe : describe.skip;

suite('prober privileges', () => {
  const dbName = `crove_test_prober_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw', crove_prober: 'test-prober-pw' });
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => {});
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps crove_prober a plain login with no memberships, no TEMPORARY and a pinned search_path', async () => {
    const admin = await connect(adminUrl);
    const { rows } = await admin.query(
      `SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolconfig,
              has_database_privilege(r.oid, current_database(), 'TEMPORARY') AS temp,
              has_database_privilege(r.oid, current_database(), 'CREATE') AS create_schema,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
              (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
       FROM pg_roles r WHERE r.rolname = 'crove_prober'`,
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

  it('lets only crove_prober execute health() and prober_alert_gate(), only crove_worker execute worker_beat() and only crove_app execute worker_build_lag() (EXECUTE matrix)', async () => {
    const admin = await connect(adminUrl);
    const functions = [
      'crove_kernel.health(integer)',
      'crove_kernel.prober_alert_gate(text,integer)',
      'crove_kernel.worker_beat(text)',
      'crove_kernel.worker_beat(text,text[])',
      // #1952: the beat with the worker's build, and the count of older live workers the API's /readyz reads.
      'crove_kernel.worker_beat(text,text[],text,timestamp with time zone)',
      'crove_kernel.worker_build_lag(timestamp with time zone)',
    ];
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader', 'crove_prober', 'crove_reporter'];
    const { rows } = await admin.query<{ fn: string; role: string }>(
      `SELECT f AS fn, r AS role FROM unnest($1::text[]) f CROSS JOIN unnest($2::text[]) r
       WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
      [functions, roles],
    );
    expect(rows).toEqual([
      { fn: 'crove_kernel.health(integer)', role: 'crove_prober' },
      { fn: 'crove_kernel.prober_alert_gate(text,integer)', role: 'crove_prober' },
      { fn: 'crove_kernel.worker_beat(text)', role: 'crove_worker' },
      { fn: 'crove_kernel.worker_beat(text,text[])', role: 'crove_worker' },
      { fn: 'crove_kernel.worker_beat(text,text[],text,timestamp with time zone)', role: 'crove_worker' },
      { fn: 'crove_kernel.worker_build_lag(timestamp with time zone)', role: 'crove_app' },
    ]);
    const defs = await admin.query(
      `SELECT p.oid::regprocedure::text AS fn, p.prosecdef, p.proconfig FROM pg_proc p
       WHERE p.oid IN ('crove_kernel.health(integer)'::regprocedure, 'crove_kernel.prober_alert_gate(text,integer)'::regprocedure,
                       'crove_kernel.worker_beat(text)'::regprocedure, 'crove_kernel.worker_beat(text,text[])'::regprocedure,
                       'crove_kernel.worker_beat(text,text[],text,timestamptz)'::regprocedure, 'crove_kernel.worker_build_lag(timestamptz)'::regprocedure) ORDER BY 1`,
    );
    expect(defs.rows).toEqual([
      { fn: 'crove_kernel.health(integer)', prosecdef: true, proconfig: PINNED },
      { fn: 'crove_kernel.prober_alert_gate(text,integer)', prosecdef: true, proconfig: PINNED },
      { fn: 'crove_kernel.worker_beat(text)', prosecdef: true, proconfig: PINNED },
      { fn: 'crove_kernel.worker_beat(text,text[])', prosecdef: true, proconfig: PINNED },
      { fn: 'crove_kernel.worker_beat(text,text[],text,timestamp with time zone)', prosecdef: true, proconfig: PINNED },
      { fn: 'crove_kernel.worker_build_lag(timestamp with time zone)', prosecdef: true, proconfig: PINNED },
    ]);
    // #1997: crove_kernel.archive_health(), the WORM archive's two ages (times only, no tenant data), for crove_prober
    // alone and a pinned definer.
    const archive = await admin.query<{ oid: number | null }>(`SELECT to_regprocedure('crove_kernel.archive_health()')::oid AS oid`);
    const archiveOid = archive.rows[0]?.oid ?? null;
    expect(archiveOid).not.toBeNull();
    if (archiveOid !== null) {
      const runners = await admin.query<{ role: string }>(`SELECT r AS role FROM unnest($1::text[]) r WHERE has_function_privilege(r, $2::oid, 'EXECUTE') ORDER BY 1`, [
        roles,
        archiveOid,
      ]);
      expect(runners.rows).toEqual([{ role: 'crove_prober' }]);
      const def = await admin.query(`SELECT p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid = $1::oid`, [archiveOid]);
      expect(def.rows).toEqual([{ prosecdef: true, proconfig: PINNED }]);
    }
    // crove_prober executes no other Crove function.
    const others = await admin.query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname LIKE 'crove\\_%' AND n.nspname <> 'crove_jobs'
         AND p.oid NOT IN ('crove_kernel.health(integer)'::regprocedure, 'crove_kernel.prober_alert_gate(text,integer)'::regprocedure,
                           COALESCE(to_regprocedure('crove_kernel.archive_health()')::oid, 0))
         AND has_function_privilege('crove_prober', p.oid, 'EXECUTE')`,
    );
    expect(others.rows).toEqual([]);
  });

  it('holds no privilege on any table and no USAGE beyond crove_kernel', async () => {
    const admin = await connect(adminUrl);
    const tables = await admin.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
         AND (has_table_privilege('crove_prober', c.oid, 'SELECT') OR has_table_privilege('crove_prober', c.oid, 'INSERT')
              OR has_table_privilege('crove_prober', c.oid, 'UPDATE') OR has_table_privilege('crove_prober', c.oid, 'DELETE')
              OR has_table_privilege('crove_prober', c.oid, 'TRUNCATE'))`,
    );
    expect(tables.rows).toEqual([]);
    const schemas = await admin.query<{ nspname: string; usage: boolean; create: boolean }>(
      `SELECT nspname, has_schema_privilege('crove_prober', oid, 'USAGE') AS usage, has_schema_privilege('crove_prober', oid, 'CREATE') AS create
       FROM pg_namespace WHERE nspname LIKE 'crove\\_%' AND (has_schema_privilege('crove_prober', oid, 'USAGE') OR has_schema_privilege('crove_prober', oid, 'CREATE'))
       ORDER BY 1`,
    );
    expect(schemas.rows).toEqual([{ nspname: 'crove_kernel', usage: true, create: false }]);
  });

  it('as the crove_prober login: reads health() and is refused everything else', async () => {
    const prober = await connect(loginUrl('crove_prober', 'test-prober-pw'));
    const { rows } = await prober.query('SELECT * FROM crove_kernel.health()');
    expect(rows).toHaveLength(1);
    const columns = [
      'checked_at',
      'outbox_pending',
      'outbox_oldest_age_seconds',
      'inbound_pending',
      'inbound_oldest_age_seconds',
      'jobs_schema_present',
      'jobs_queued',
      'job_oldest_queued_age_seconds',
      'dead_letter_count',
      'worker_heartbeat_age_seconds',
    ];
    // health()'s result stays as it is: every migration file must re-apply on the final schema (migrate.db.test.ts),
    // so its result columns never change; the WORM archive's ages come from archive_health() (#1997).
    expect(Object.keys(rows[0] as object)).toEqual(columns);
    // The WORM archive's two ages (#1997): times only.
    const archive = await prober.query('SELECT * FROM crove_kernel.archive_health()');
    expect(archive.fields.map((f) => f.name)).toEqual(['archive_verify_age_seconds', 'archive_lag_seconds']);
    const refused = [
      'SELECT 1 FROM crove_kernel.tenant LIMIT 1',
      'SELECT 1 FROM crove_kernel.outbox_event LIMIT 1',
      'SELECT 1 FROM crove_kernel.outbox_pending LIMIT 1',
      'SELECT 1 FROM crove_kernel.worker_heartbeat LIMIT 1',
      'SELECT 1 FROM crove_kernel.prober_alert_state LIMIT 1',
      "UPDATE crove_kernel.prober_alert_state SET problem = 'probe'",
      'DELETE FROM crove_kernel.prober_alert_state',
      "SELECT crove_kernel.worker_beat('prober')",
      "SELECT crove_kernel.worker_beat('prober', ARRAY['kernel'])",
      'SELECT * FROM crove_kernel.outbox_claim(1)',
      "SELECT crove_kernel.enter_system_context('00000000-0000-0000-0000-000000000000')",
      'CREATE TEMP TABLE t (x int)',
      'CREATE TABLE crove_kernel.planted (x int)',
    ];
    for (const statement of refused) {
      await expect(prober.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
    // The alert gate is the one thing it may change.
    const gate = await prober.query(`SELECT decision FROM crove_kernel.prober_alert_gate(NULL, 3600)`);
    expect(gate.rows).toEqual([{ decision: 'healthy' }]);
  });

  it('keeps the alert state a definer-only machinery table: RLS on, no grants, one row', async () => {
    const admin = await connect(adminUrl);
    const table = await admin.query(
      `SELECT c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped) AS org_id,
              (SELECT count(*)::int FROM pg_roles r WHERE r.rolname LIKE 'crove\\_%' AND NOT r.rolsuper
                 AND NOT pg_has_role(r.oid, c.relowner, 'MEMBER')
                 AND (has_table_privilege(r.oid, c.oid, 'SELECT') OR has_table_privilege(r.oid, c.oid, 'INSERT')
                      OR has_table_privilege(r.oid, c.oid, 'UPDATE') OR has_table_privilege(r.oid, c.oid, 'DELETE'))) AS grantees
       FROM pg_class c WHERE c.oid = 'crove_kernel.prober_alert_state'::regclass`,
    );
    expect(table.rows).toEqual([{ rls: true, org_id: 0, grantees: 0 }]);
    await expect(admin.query(`INSERT INTO crove_kernel.prober_alert_state (id) VALUES (2)`)).rejects.toMatchObject({ code: '23514' });
  });

  it('lets only the worker login write heartbeats, even when EXECUTE is granted by mistake', async () => {
    const worker = await connect(loginUrl('crove_worker', 'test-worker-pw'));
    await worker.query("SELECT crove_kernel.worker_beat('worker-1')");
    const admin = await connect(adminUrl);
    const beats = await admin.query(`SELECT instance FROM crove_kernel.worker_heartbeat`);
    expect(beats.rows).toEqual([{ instance: 'worker-1' }]);
    const table = await admin.query(
      `SELECT c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_roles r WHERE r.rolname LIKE 'crove\\_%' AND NOT r.rolsuper
                 AND NOT pg_has_role(r.oid, c.relowner, 'MEMBER')
                 AND (has_table_privilege(r.oid, c.oid, 'SELECT') OR has_table_privilege(r.oid, c.oid, 'INSERT')
                      OR has_table_privilege(r.oid, c.oid, 'UPDATE') OR has_table_privilege(r.oid, c.oid, 'DELETE'))) AS grantees
       FROM pg_class c WHERE c.oid = 'crove_kernel.worker_heartbeat'::regclass`,
    );
    expect(table.rows).toEqual([{ rls: true, grantees: 0 }]);
    // The session_user check holds on its own: the API login is refused even with EXECUTE (rolled back).
    await admin.query('BEGIN');
    try {
      await admin.query('GRANT EXECUTE ON FUNCTION crove_kernel.worker_beat(text) TO crove_app');
      await admin.query('GRANT EXECUTE ON FUNCTION crove_kernel.worker_beat(text, text[]) TO crove_app');
      // #1952: the beat with the worker's build.
      await admin.query('GRANT EXECUTE ON FUNCTION crove_kernel.worker_beat(text, text[], text, timestamptz) TO crove_app');
      await admin.query('SET SESSION AUTHORIZATION crove_app');
      await admin.query('SAVEPOINT beat');
      await expect(admin.query("SELECT crove_kernel.worker_beat('fake')")).rejects.toMatchObject({ code: '42501', message: 'WORKER_ONLY' });
      await admin.query('ROLLBACK TO SAVEPOINT beat');
      await expect(admin.query("SELECT crove_kernel.worker_beat('fake', ARRAY['kernel'])")).rejects.toMatchObject({ code: '42501', message: 'WORKER_ONLY' });
      await admin.query('ROLLBACK TO SAVEPOINT beat');
      await expect(admin.query("SELECT crove_kernel.worker_beat('fake', ARRAY['kernel'], 'abc', now())")).rejects.toMatchObject({ code: '42501', message: 'WORKER_ONLY' });
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});
